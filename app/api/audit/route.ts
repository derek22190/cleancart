import { NextResponse } from "next/server";
import { checkRateLimitAsync, inferClientPlatform, runScan, type ScanRequest, type ScanResponse, type ScanError } from "@/lib/scan";
import type { Category, Watchlist } from "@/lib/rubric";
import { isAffiliateAllowedOnClient, type ClientPlatform } from "@/lib/swaps";
import { parseGroceryOrderText } from "@/lib/order-parser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Device-Secret, X-Client-Platform, X-HeyBroc-Platform",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

function clampQuantity(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(99, Math.max(1, Math.round(parsed)));
}

function isScoredFoodScan(r: ScanResponse | ScanError): r is ScanResponse {
  if (!r.ok) return false;
  const score = r.result?.score;
  if (score === null || score === undefined || !Number.isFinite(score)) return false;
  if (r.product?.nutrition?.productKind === "non-food") return false;
  if (r.result?.yukaBreakdown?.nutriScoreGrade === "N/A") return false;
  return true;
}

type AuditedItemResult = (ScanResponse | ScanError) & { quantity: number };

/**
 * Whole-Cart & Weekly-Order Auditor:
 * POST { items?: [...], rawOrderText?: string, preferStoreBrand?: boolean, store?, instacartRetailerSlug?, surface?, watchlist? }
 * Scores up to 100 cart/order items, excludes non-food / unscored items, and computes quantity-weighted
 * `averageBefore` and `averageAfter` using nullish coalescing `??` (never `||`), returning `null` when 0 scored items exist.
 */
export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!(await checkRateLimitAsync(`audit:${ip}`, 10))) {
    return NextResponse.json(
      { ok: false, error: "Too many cart audit requests. Please wait a moment." },
      { status: 429, headers: CORS },
    );
  }
  let body: {
    items?: unknown;
    rawOrderText?: unknown;
    preferStoreBrand?: boolean;
    preferDetectedStore?: boolean;
    store?: string;
    instacartRetailerSlug?: string;
    surface?: "web" | "android" | "extension";
    clientPlatform?: ClientPlatform;
    deviceId?: string;
    deviceSecret?: string;
    watchlist?: Watchlist;
    familyWatchlist?: Category[];
    dietaryWatchlist?: string[];
  };
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "Body must be a JSON object." }, { status: 400, headers: CORS });
    }
    body = parsed;
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be valid JSON." }, { status: 400, headers: CORS });
  }
  if (typeof body.rawOrderText === "string" && body.rawOrderText.length > 48_000) {
    return NextResponse.json({ ok: false, error: "Order text exceeds maximum length of 48,000 characters." }, { status: 413, headers: CORS });
  }

  let detectedStore: string | undefined;
  let resolvedItems: unknown[] | undefined = Array.isArray(body.items) ? body.items : undefined;
  if ((!resolvedItems || resolvedItems.length === 0) && typeof body.rawOrderText === "string" && body.rawOrderText.trim().length > 0) {
    const parsedOrder = parseGroceryOrderText(body.rawOrderText);
    detectedStore = parsedOrder.detectedStore;
    resolvedItems = parsedOrder.items;
    if (detectedStore && body.preferDetectedStore !== false) {
      body.store = detectedStore;
    }
    if (resolvedItems.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "Could not find any recognizable grocery items in that order or receipt text. Try listing one product per line.",
        },
        { status: 422, headers: CORS },
      );
    }
  }
  const effectiveStore = body.store || detectedStore || "walmart";
  body.store = effectiveStore;

  if (!Array.isArray(resolvedItems) || resolvedItems.length === 0) {
    return NextResponse.json({ ok: false, error: "Provide a non-empty items array or rawOrderText." }, { status: 400, headers: CORS });
  }
  const clientPlatform = inferClientPlatform({
    clientPlatform:
      body.clientPlatform ||
      request.headers.get("x-client-platform") ||
      request.headers.get("x-heybroc-platform") ||
      undefined,
    surface: body.surface,
    deviceId: body.deviceId,
    origin: request.headers.get("origin") || undefined,
    userAgent: request.headers.get("user-agent") || undefined,
  });
  const effectiveSurface = !isAffiliateAllowedOnClient(body.surface ?? "web", clientPlatform)
    ? "extension"
    : body.surface;
  const effectiveSecret =
    request.headers.get("x-device-secret")?.trim() || body.deviceSecret;
  const preferStoreBrand = body.preferStoreBrand === true;
  const items = resolvedItems.slice(0, 100);
  const memo = new Map<string, Promise<ScanResponse | ScanError>>();

  // Process in bounded batches of 4 with per-request deduplication to avoid flooding Open Food Facts / USDA
  const results: AuditedItemResult[] = [];
  for (let i = 0; i < items.length; i += 4) {
    const chunk = items.slice(i, i + 4);
    const batch = await Promise.all(
      chunk.map(async (item): Promise<AuditedItemResult> => {
        if (typeof item === "string") {
          const dedupKey = `str:${item.trim().toLowerCase()}|sb:${preferStoreBrand ? 1 : 0}`;
          let pending = memo.get(dedupKey);
          if (!pending) {
            pending = runScan({
              productTitle: item,
              store: body.store,
              instacartRetailerSlug: body.instacartRetailerSlug,
              surface: effectiveSurface,
              clientPlatform,
              deviceId: body.deviceId,
              deviceSecret: effectiveSecret,
              watchlist: body.watchlist,
              familyWatchlist: body.familyWatchlist,
              dietaryWatchlist: body.dietaryWatchlist,
              preferStoreBrand,
              skipAnalytics: true,
            });
            memo.set(dedupKey, pending);
          }
          const res = await pending;
          return { ...res, quantity: 1 };
        }
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return { ok: false, status: 400, error: "Each item must be an object or string.", quantity: 1 };
        }
        const rawObj = item as Record<string, unknown>;
        const quantity = clampQuantity(rawObj.quantity);
        const rawTitleField = rawObj.productTitle ?? rawObj.title;
        const rawIngredientsField = rawObj.rawIngredients ?? rawObj.ingredients;
        if (
          (rawObj.barcode !== undefined && typeof rawObj.barcode !== "string" && typeof rawObj.barcode !== "number") ||
          (rawTitleField !== undefined && typeof rawTitleField !== "string") ||
          (rawIngredientsField !== undefined && typeof rawIngredientsField !== "string")
        ) {
          return {
            ok: false,
            status: 400,
            error: "Item barcode, productTitle, and rawIngredients must be strings when provided.",
            quantity,
          };
        }
        const reqItem: ScanRequest & { quantity?: unknown } = {
          ...(item as ScanRequest & { quantity?: unknown }),
          productTitle: typeof rawTitleField === "string" ? rawTitleField : undefined,
          rawIngredients: typeof rawIngredientsField === "string" ? rawIngredientsField : undefined,
        };
        const barcodeStr =
          typeof reqItem.barcode === "string" || typeof reqItem.barcode === "number"
            ? String(reqItem.barcode).trim()
            : "";
        const titleStr = typeof reqItem.productTitle === "string" ? reqItem.productTitle.trim().toLowerCase() : "";
        const ingStr = typeof reqItem.rawIngredients === "string" ? reqItem.rawIngredients.trim().toLowerCase() : "";
        const effWatchlist = reqItem.watchlist ?? body.watchlist;
        const effFw = reqItem.familyWatchlist ?? body.familyWatchlist;
        const effDw = reqItem.dietaryWatchlist ?? body.dietaryWatchlist;
        const effPreferSb = reqItem.preferStoreBrand ?? preferStoreBrand;
        const wlSig = effWatchlist && typeof effWatchlist === "object" ? JSON.stringify(effWatchlist) : "";
        const fwSig = Array.isArray(effFw) ? [...effFw].sort().join(",") : "";
        const dwSig = Array.isArray(effDw) ? [...effDw].sort().join(",") : "";
        const retailerSlug = reqItem.instacartRetailerSlug ?? body.instacartRetailerSlug ?? "";
        const dedupKey = `obj:${barcodeStr}|${titleStr}|${ingStr}|${retailerSlug}|${wlSig}|${fwSig}|${dwSig}|sb:${effPreferSb ? 1 : 0}`;
        let pending = memo.get(dedupKey);
        if (!pending) {
          pending = runScan({
            ...reqItem,
            store: body.store,
            instacartRetailerSlug: reqItem.instacartRetailerSlug ?? body.instacartRetailerSlug,
            surface: effectiveSurface ?? reqItem.surface,
            clientPlatform: reqItem.clientPlatform ?? clientPlatform,
            deviceId: reqItem.deviceId ?? body.deviceId,
            deviceSecret: reqItem.deviceSecret ?? effectiveSecret,
            watchlist: effWatchlist,
            familyWatchlist: effFw,
            dietaryWatchlist: effDw,
            preferStoreBrand: effPreferSb,
            skipAnalytics: true,
          });
          memo.set(dedupKey, pending);
        }
        const res = await pending;
        return { ...res, quantity };
      }),
    );
    results.push(...batch);
  }

  let weightedBeforeSum = 0;
  let weightedAfterSum = 0;
  let totalScoredQuantity = 0;
  let scoredCount = 0;
  let swapsCount = 0;

  for (const r of results) {
    if (!isScoredFoodScan(r)) continue;
    const qty = r.quantity;
    const beforeScore = r.result.score;
    const swapScore = r.swap?.score ?? null;
    const afterScore = swapScore !== null && swapScore > beforeScore ? swapScore : beforeScore;
    weightedBeforeSum += beforeScore * qty;
    weightedAfterSum += afterScore * qty;
    totalScoredQuantity += qty;
    scoredCount += 1;
    if (r.swap) swapsCount += 1;
  }

  const failedCount = results.filter((r) => !r.ok).length;
  const averageBefore = totalScoredQuantity > 0 ? Math.round(weightedBeforeSum / totalScoredQuantity) : null;
  const averageAfter = totalScoredQuantity > 0 ? Math.round(weightedAfterSum / totalScoredQuantity) : null;

  return NextResponse.json(
    {
      ok: true,
      complete: failedCount === 0,
      effectiveStore,
      ...(detectedStore ? { detectedStore } : {}),
      cartScore: averageBefore,
      scoredItemAverage: averageBefore,
      averageBefore,
      averageAfter,
      totalScoredQuantity,
      itemsRequested: items.length,
      itemsScanned: results.length,
      itemsScored: scoredCount,
      itemsFailed: failedCount,
      swapsAvailable: swapsCount,
      results,
    },
    { headers: CORS },
  );
}
