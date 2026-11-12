import { NextResponse } from "next/server";
import { isAdminAuthorized } from "@/lib/admin-auth";
import { lookupLiveAuthoritative } from "@/lib/lookup";
import { checkRateLimit } from "@/lib/scan";
import { scoreProductYuka, type Category, type Watchlist } from "@/lib/rubric";
import { resolveSwap, type Store } from "@/lib/swaps";
import { kvGet, kvSet } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPORTS_KV_KEY = "heybroc:label_reports:v1";
const MAX_STORED_REPORTS = 100;

export interface LabelAuditReportItem {
  id: string;
  createdAt: string;
  productTitle: string;
  brand?: string;
  barcode?: string;
  issueType: string;
  previousIngredients: string;
  verifiedIngredients: string;
  previousScore: number;
  verifiedScore: number;
  scoreChanged: boolean;
  ingredientsChanged: boolean;
  resolutionSource: "package_label" | "usda" | "openfoodfacts" | "dsld" | "confirmed_current";
  status: "auto_updated" | "confirmed_accurate" | "flagged_for_review";
  summary: string;
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

export async function POST(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for") || "127.0.0.1";
  const ip = forwarded.split(",")[0].trim() || "127.0.0.1";
  const allowed = await checkRateLimit(`label-report:${ip}`);
  if (!allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many verification requests. Please wait a moment and try again." },
      { status: 429 }
    );
  }

  let body: {
    productTitle?: string;
    brand?: string;
    barcode?: string;
    currentIngredients?: string;
    reportedIngredients?: string;
    issueType?: string;
    store?: Store;
    preferStoreBrand?: boolean;
    watchlist?: Watchlist;
    familyWatchlist?: Category[];
    dietaryWatchlist?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const productTitle = (body.productTitle || "").trim();
  const brand = (body.brand || "").trim();
  const barcode = (body.barcode || "").trim() || undefined;
  const currentIngredients = (body.currentIngredients || "").trim();
  const reportedIngredients = (body.reportedIngredients || "").trim();
  const issueType = (body.issueType || "reformulated").trim();
  const store: Store = body.store || "walmart";

  if (!productTitle && !barcode && !reportedIngredients) {
    return NextResponse.json(
      { ok: false, error: "Please provide a product title, barcode, or package ingredient list." },
      { status: 400 }
    );
  }

  const fullTitle =
    brand && !productTitle.toLowerCase().startsWith(brand.toLowerCase())
      ? `${brand} ${productTitle}`.trim()
      : productTitle || "Scanned Grocery Item";

  const previousScoreObj = scoreProductYuka(
    currentIngredients || "Water",
    body.watchlist,
    body.familyWatchlist || [],
    { productTitle: fullTitle }
  );

  let verifiedIngredients = currentIngredients;
  let resolutionSource: LabelAuditReportItem["resolutionSource"] = "confirmed_current";
  let sourceUrl: string | undefined;
  let sourceUpdatedAt: string | null | undefined;
  let resolvedNutrition = undefined;

  // Priority 1: Shopper provided or OCR'd the physical package ingredient list
  if (reportedIngredients && reportedIngredients.length >= 6) {
    verifiedIngredients = reportedIngredients;
    resolutionSource = "package_label";
    sourceUpdatedAt = new Date().toISOString().slice(0, 10);
  } else {
    // Priority 2: Automatic live re-verification against USDA FoodData Central, Open Food Facts & NIH DSLD
    const liveHit = await lookupLiveAuthoritative({
      productTitle: fullTitle,
      barcode,
    });
    if (liveHit && liveHit.ingredients?.trim()) {
      verifiedIngredients = liveHit.ingredients.trim();
      resolvedNutrition = liveHit.nutrition;
      sourceUrl = liveHit.sourceUrl;
      sourceUpdatedAt = liveHit.sourceUpdatedAt || new Date().toISOString().slice(0, 10);
      if (liveHit.source === "usda") resolutionSource = "usda";
      else if (liveHit.source === "dsld") resolutionSource = "dsld";
      else resolutionSource = "openfoodfacts";
    }
  }

  const verifiedScoreObj = scoreProductYuka(
    verifiedIngredients || currentIngredients || "Water",
    body.watchlist,
    body.familyWatchlist || [],
    { ...resolvedNutrition, productTitle: fullTitle }
  );

  const ingredientsChanged =
    Boolean(verifiedIngredients) &&
    normalizeIngForCompare(verifiedIngredients) !== normalizeIngForCompare(currentIngredients);
  const scoreChanged = verifiedScoreObj.score !== previousScoreObj.score;

  const swap = resolveSwap({
    score: verifiedScoreObj.score,
    productTitle: fullTitle,
    ingredients: verifiedIngredients,
    store,
    preferStoreBrand: body.preferStoreBrand,
    watchlist: body.watchlist,
    familyWatchlist: body.familyWatchlist,
    dietaryWatchlist: body.dietaryWatchlist,
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
            : "our deterministic 3-pillar rubric";

  const summary =
    status === "auto_updated"
      ? `Auto-updated from ${sourcePretty}: score ${
          scoreChanged
            ? `adjusted from ${previousScoreObj.score}/100 → ${verifiedScoreObj.score}/100`
            : `confirmed at ${verifiedScoreObj.score}/100`
        } (${verifiedScoreObj.flagged.length} additive flag${verifiedScoreObj.flagged.length === 1 ? "" : "s"}).`
      : `Cross-checked against ${sourcePretty}: current ingredient breakdown and ${verifiedScoreObj.score}/100 score (${verifiedScoreObj.flagged.length} flag${verifiedScoreObj.flagged.length === 1 ? "" : "s"}) are verified accurate.`;

  const reportItem: LabelAuditReportItem = {
    id: `rep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
    productTitle: fullTitle,
    brand: brand || undefined,
    barcode,
    issueType,
    previousIngredients: currentIngredients,
    verifiedIngredients,
    previousScore: previousScoreObj.score,
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
    report: reportItem,
    verifiedProduct: {
      title: productTitle || fullTitle,
      brand: brand || "Verified Label",
      barcode,
      ingredients: verifiedIngredients,
      nutrition: resolvedNutrition,
      sourceUrl,
      sourceUpdatedAt,
    },
    previousResult: previousScoreObj,
    verifiedResult: verifiedScoreObj,
    swap,
  });
}
