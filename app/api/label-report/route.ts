import { NextResponse } from "next/server";
import { isAdminAuthorized } from "@/lib/admin-auth";
import { passesVariantGuard } from "@/lib/drinks-catalog";
import {
  isDietaryOrVariantMismatch,
  isEnglishIngredientText,
  lookupLiveAuthoritative,
  matchesRequestedBrand,
} from "@/lib/lookup";
import { checkRateLimitAsync } from "@/lib/rate-limit";
import { scoreProductYuka, type Category, type Watchlist } from "@/lib/rubric";
import { resolveSwap, STORES, type Store } from "@/lib/swaps";
import { kvGet, kvSet } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPORTS_KV_KEY = "heybroc:label_reports:v1";
const MAX_STORED_REPORTS = 100;

const ALLOWED_ISSUE_TYPES = new Set([
  "reformulated",
  "wrong_variant",
  "score_question",
  "wrong_product",
  "missing_additive",
  "false_positive",
  "nutrition_mismatch",
  "other",
]);

export interface LabelAuditReportItem {
  id: string;
  createdAt: string;
  productTitle: string;
  brand?: string;
  barcode?: string;
  store?: Store;
  issueType: string;
  previousIngredients: string;
  verifiedIngredients: string;
  previousScore: number;
  verifiedScore: number;
  scoreChanged: boolean;
  ingredientsChanged: boolean;
  resolutionSource:
    | "package_label"
    | "usda"
    | "openfoodfacts"
    | "dsld"
    | "confirmed_current"
    | "unverified";
  status: "auto_updated" | "confirmed_accurate" | "flagged_for_review";
  summary: string;
}

/** Validates standard GS1 Modulo-10 check digit for GTIN-8, UPC-A (12), EAN-13 (13), and GTIN-14 (14). */
export function isValidGtin(digits: string): boolean {
  if (!/^(?:\d{8}|\d{12,14})$/.test(digits)) return false;
  if (/^0+$/.test(digits)) return false;
  let sum = 0;
  const len = digits.length;
  for (let i = 0; i < len - 1; i++) {
    const d = digits.charCodeAt(i) - 48;
    const weight = (len - 1 - i) % 2 === 1 ? 3 : 1;
    sum += d * weight;
  }
  const expectedCheck = (10 - (sum % 10)) % 10;
  return expectedCheck === digits.charCodeAt(len - 1) - 48;
}

function normalizeIngForCompare(raw: string): string {
  return (raw || "")
    .toLowerCase()
    .replace(/\[representative.*?\]/gi, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function getRecentLabelReports(): Promise<LabelAuditReportItem[]> {
  try {
    const existing = await kvGet<LabelAuditReportItem[]>(REPORTS_KV_KEY);
    return Array.isArray(existing) ? existing : [];
  } catch {
    return [];
  }
}

async function appendLabelReport(entry: LabelAuditReportItem): Promise<void> {
  try {
    const existing = await getRecentLabelReports();
    const next = [entry, ...existing.filter((r) => r.id !== entry.id)].slice(0, MAX_STORED_REPORTS);
    await kvSet(REPORTS_KV_KEY, next, 90 * 24 * 60 * 60);
  } catch {
    /* non-blocking telemetry persistence */
  }
}

export async function GET(req: Request) {
  if (!isAdminAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const reports = await getRecentLabelReports();
  return NextResponse.json({ ok: true, reports });
}

function coerceString(value: unknown, maxLen: number): string {
  if (typeof value === "string") return value.trim().slice(0, maxLen);
  if (typeof value === "number" || typeof value === "boolean") return String(value).slice(0, maxLen);
  return "";
}

function sanitizeStringArray(value: unknown, maxItems: number, maxLen = 64): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const s = item.trim().slice(0, maxLen);
      if (s) out.push(s);
      if (out.length >= maxItems) break;
    }
  }
  return out;
}

export async function POST(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for") || "127.0.0.1";
  const ip = forwarded.split(",")[0].trim() || "127.0.0.1";
  const allowed = await checkRateLimitAsync(`label-report:${ip}`);
  if (!allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many verification requests. Please wait a moment and try again." },
      { status: 429 }
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  const body = rawBody as Record<string, unknown>;

  const productTitle = coerceString(body.productTitle, 300);
  const brand = coerceString(body.brand, 120);
  let effectiveRawBarcode = coerceString(body.barcode, 64);
  const currentIngredients = coerceString(body.currentIngredients, 6000);
  let reportedIngredients = coerceString(body.reportedIngredients, 6000);

  // If the shopper pasted a UPC/EAN barcode into the combined textarea, route it to barcode validation
  // rather than scoring raw digits as a clean ingredient list.
  if (reportedIngredients) {
    const compactReported = reportedIngredients.replace(/[\s-]+/g, "");
    if (/^\d+$/.test(compactReported)) {
      if (!effectiveRawBarcode) {
        effectiveRawBarcode = reportedIngredients.slice(0, 64);
        reportedIngredients = "";
      } else if (effectiveRawBarcode.replace(/[\s-]+/g, "") === compactReported) {
        reportedIngredients = "";
      } else {
        return NextResponse.json(
          {
            ok: false,
            error: "Reported package ingredients cannot consist solely of digits.",
          },
          { status: 400 }
        );
      }
    }
  }

  let barcode: string | undefined;
  if (effectiveRawBarcode) {
    const strippedBarcode = effectiveRawBarcode.replace(/[\s-]+/g, "");
    if (!isValidGtin(strippedBarcode)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Invalid UPC/GTIN barcode. Expected an 8-, 12-, 13-, or 14-digit barcode with a valid check digit.",
        },
        { status: 400 }
      );
    }
    barcode = strippedBarcode;
  }

  if (
    reportedIngredients &&
    (reportedIngredients.length < 6 ||
      !/[a-zA-Z]{3,}/.test(reportedIngredients) ||
      !isEnglishIngredientText(reportedIngredients))
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: "Please provide a valid English package ingredient list (at least 6 characters).",
      },
      { status: 400 }
    );
  }

  const issueTypeRaw = coerceString(body.issueType, 40).toLowerCase();
  const issueType = ALLOWED_ISSUE_TYPES.has(issueTypeRaw) ? issueTypeRaw : "reformulated";
  const storeRaw = coerceString(body.store, 32).toLowerCase();
  const store: Store = (STORES as readonly string[]).includes(storeRaw)
    ? (storeRaw as Store)
    : "walmart";
  const preferStoreBrand = Boolean(body.preferStoreBrand);
  const watchlist: Watchlist | undefined =
    body.watchlist && typeof body.watchlist === "object" && !Array.isArray(body.watchlist)
      ? (body.watchlist as Watchlist)
      : undefined;
  const familyWatchlist = sanitizeStringArray(body.familyWatchlist, 24) as Category[];
  const dietaryWatchlist = sanitizeStringArray(body.dietaryWatchlist, 24);

  if (!productTitle && !barcode && !reportedIngredients) {
    return NextResponse.json(
      { ok: false, error: "Please provide a product title, barcode, or package ingredient list." },
      { status: 400 }
    );
  }

  const hasExplicitProductTitle = Boolean(productTitle || brand);
  const fullTitle = (
    brand && !productTitle.toLowerCase().startsWith(brand.toLowerCase())
      ? `${brand} ${productTitle}`.trim()
      : productTitle || "Scanned Grocery Item"
  ).slice(0, 300);

  let verifiedIngredients = "";
  let resolutionSource: LabelAuditReportItem["resolutionSource"] = "unverified";
  let sourceUrl: string | undefined;
  let sourceUpdatedAt: string | null | undefined;
  let resolvedNutrition = undefined;
  let resolvedProductTitle = productTitle || fullTitle;
  let resolvedBrand = brand || undefined;

  const isBarcodeConflictWithTitle = (liveHit: NonNullable<Awaited<ReturnType<typeof lookupLiveAuthoritative>>>) =>
    Boolean(
      barcode &&
        hasExplicitProductTitle &&
        liveHit.ingredients?.trim() &&
        (!matchesRequestedBrand(fullTitle, liveHit.brand, liveHit.productTitle) ||
          !passesVariantGuard(fullTitle, liveHit.productTitle) ||
          isDietaryOrVariantMismatch(
            fullTitle,
            liveHit.productTitle,
            liveHit.ingredients,
            liveHit.nutrition
          ))
    );

  // Priority 1: Shopper provided or OCR'd the physical package ingredient list
  if (reportedIngredients && reportedIngredients.length >= 6) {
    if (barcode && hasExplicitProductTitle) {
      const barcodeHit = await lookupLiveAuthoritative({ productTitle: "", barcode });
      if (barcodeHit && isBarcodeConflictWithTitle(barcodeHit)) {
        return NextResponse.json(
          {
            ok: false,
            error: `Barcode ${barcode} resolved to "${barcodeHit.productTitle}", which conflicts with "${fullTitle}". Please verify the package barcode.`,
          },
          { status: 409 }
        );
      }
      if (barcodeHit) {
        resolvedNutrition = barcodeHit.nutrition;
        sourceUrl = barcodeHit.sourceUrl;
      }
    }
    verifiedIngredients = reportedIngredients;
    resolutionSource = "package_label";
    sourceUpdatedAt = new Date().toISOString().slice(0, 10);
  } else {
    // Priority 2: Automatic live re-verification against USDA FoodData Central, Open Food Facts & NIH DSLD
    const liveHit = await lookupLiveAuthoritative({
      productTitle: hasExplicitProductTitle ? fullTitle : "",
      barcode,
    });
    if (liveHit && liveHit.ingredients?.trim()) {
      if (isBarcodeConflictWithTitle(liveHit)) {
        return NextResponse.json(
          {
            ok: false,
            error: `Barcode ${barcode} resolved to "${liveHit.productTitle}", which conflicts with "${fullTitle}". Please verify the package barcode.`,
          },
          { status: 409 }
        );
      }
      verifiedIngredients = liveHit.ingredients.trim();
      resolvedNutrition = liveHit.nutrition;
      sourceUrl = liveHit.sourceUrl;
      sourceUpdatedAt = liveHit.sourceUpdatedAt || new Date().toISOString().slice(0, 10);
      resolvedProductTitle = liveHit.productTitle || resolvedProductTitle;
      resolvedBrand = liveHit.brand || resolvedBrand;
      if (liveHit.source === "usda") resolutionSource = "usda";
      else if (liveHit.source === "dsld") resolutionSource = "dsld";
      else resolutionSource = "openfoodfacts";
    }
  }

  const hasAuthoritativeEvidence = Boolean(verifiedIngredients.trim());

  if (!hasAuthoritativeEvidence) {
    const fallbackPrevScoreObj = currentIngredients.trim()
      ? scoreProductYuka(currentIngredients, watchlist, familyWatchlist, { productTitle: fullTitle })
      : null;
    const fallbackScore = fallbackPrevScoreObj?.score ?? 0;
    const summary =
      "Queued for label review: live USDA FoodData Central and Open Food Facts records did not return a verified ingredient panel for this item yet. Snap or paste the package ingredients to score immediately.";
    const reportItem: LabelAuditReportItem = {
      id: `rep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
      productTitle: fullTitle,
      brand: brand || undefined,
      barcode,
      store,
      issueType,
      previousIngredients: currentIngredients,
      verifiedIngredients: "",
      previousScore: fallbackScore,
      verifiedScore: fallbackScore,
      scoreChanged: false,
      ingredientsChanged: false,
      resolutionSource: "unverified",
      status: "flagged_for_review",
      summary,
    };
    await appendLabelReport(reportItem);
    return NextResponse.json({
      ok: true,
      resolutionSource: "unverified",
      report: reportItem,
      verifiedProduct: null,
      previousResult: fallbackPrevScoreObj,
      verifiedResult: null,
      swap: null,
    });
  }

  const ingredientsChanged =
    normalizeIngForCompare(verifiedIngredients) !== normalizeIngForCompare(currentIngredients);

  const previousScoreObj = currentIngredients.trim()
    ? scoreProductYuka(currentIngredients, watchlist, familyWatchlist, {
        ...(ingredientsChanged ? {} : resolvedNutrition),
        productTitle: resolvedProductTitle,
      })
    : null;

  const verifiedScoreObj = scoreProductYuka(
    verifiedIngredients,
    watchlist,
    familyWatchlist,
    { ...resolvedNutrition, productTitle: resolvedProductTitle }
  );

  const previousScoreVal = previousScoreObj ? previousScoreObj.score : verifiedScoreObj.score;
  const scoreChanged = previousScoreObj !== null && verifiedScoreObj.score !== previousScoreObj.score;

  const swap = resolveSwap({
    score: verifiedScoreObj.score,
    productTitle: resolvedProductTitle,
    ingredients: verifiedIngredients,
    nutrition: resolvedNutrition,
    store,
    preferStoreBrand,
    watchlist,
    familyWatchlist,
    dietaryWatchlist,
  });

  const status: LabelAuditReportItem["status"] =
    ingredientsChanged || scoreChanged
      ? "auto_updated"
      : issueType === "other"
        ? "flagged_for_review"
        : "confirmed_accurate";

  const sourcePretty =
    resolutionSource === "package_label"
      ? "your physical package label"
      : resolutionSource === "usda"
        ? "USDA FoodData Central"
        : resolutionSource === "openfoodfacts"
          ? "Open Food Facts"
          : resolutionSource === "dsld"
            ? "NIH Supplement Database"
            : "live nutrition data";

  const summary =
    status === "auto_updated"
      ? `Auto-updated from ${sourcePretty}: score ${
          scoreChanged
            ? `adjusted from ${previousScoreVal}/100 → ${verifiedScoreObj.score}/100`
            : `confirmed at ${verifiedScoreObj.score}/100`
        } (${verifiedScoreObj.flagged.length} additive flag${verifiedScoreObj.flagged.length === 1 ? "" : "s"}).`
      : `Cross-checked against ${sourcePretty}: current ingredient breakdown and ${verifiedScoreObj.score}/100 score (${verifiedScoreObj.flagged.length} flag${verifiedScoreObj.flagged.length === 1 ? "" : "s"}) are verified accurate.`;

  const reportItem: LabelAuditReportItem = {
    id: `rep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
    productTitle: resolvedProductTitle,
    brand: resolvedBrand,
    barcode,
    store,
    issueType,
    previousIngredients: currentIngredients,
    verifiedIngredients,
    previousScore: previousScoreVal,
    verifiedScore: verifiedScoreObj.score,
    scoreChanged,
    ingredientsChanged,
    resolutionSource,
    status,
    summary,
  };

  await appendLabelReport(reportItem);

  return NextResponse.json({
    ok: true,
    resolutionSource,
    report: reportItem,
    verifiedProduct: {
      title: resolvedProductTitle,
      brand: resolvedBrand || "Verified Label",
      barcode,
      ingredients: verifiedIngredients,
      nutrition: resolvedNutrition,
      sourceUrl,
      sourceUpdatedAt,
    },
    previousResult: previousScoreObj ?? verifiedScoreObj,
    verifiedResult: verifiedScoreObj,
    swap,
  });
}
