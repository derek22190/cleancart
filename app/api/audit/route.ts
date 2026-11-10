import { NextResponse } from "next/server";
import { checkRateLimit, runScan, type ScanRequest, type ScanResponse, type ScanError } from "@/lib/scan";
import type { Category, Watchlist } from "@/lib/rubric";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Device-Secret",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * Whole-Cart Auditor: POST { items: [{ productTitle?, rawIngredients?, barcode? }], store?, surface?, watchlist? }
 * Scores every cart item and returns the 1-tap swap list for anything under 75.
 */
export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!checkRateLimit(`audit:${ip}`, 10)) {
    return NextResponse.json({ ok: false, error: "Too many cart audit requests. Please wait a moment." }, { status: 429, headers: CORS });
  }
  let body: {
    items?: unknown;
    store?: string;
    surface?: "web" | "android" | "extension";
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
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ ok: false, error: "Provide a non-empty items array." }, { status: 400, headers: CORS });
  }
  if (body.items.length > 20) {
    return NextResponse.json(
      { ok: false, error: "Cart audit accepts at most 20 items per request." },
      { status: 400, headers: CORS },
    );
  }
  const reqOrigin = (request.headers.get("origin") || "").toLowerCase();
  const effectiveSurface =
    reqOrigin.startsWith("chrome-extension://") ||
    reqOrigin.startsWith("safari-web-extension://") ||
    reqOrigin.startsWith("moz-extension://")
      ? "extension"
      : body.surface;
  const effectiveSecret =
    request.headers.get("x-device-secret")?.trim() || body.deviceSecret;
  const items = body.items;
  const memo = new Map<string, Promise<ScanResponse | ScanError>>();

  // Process in bounded batches of 3 with per-request deduplication to avoid flooding Open Food Facts / USDA
  const results: Array<ScanResponse | ScanError> = [];
  for (let i = 0; i < items.length; i += 3) {
    const chunk = items.slice(i, i + 3);
    const batch = await Promise.all(
      chunk.map((item) => {
        if (typeof item === "string") {
          const dedupKey = `str:${item.trim().toLowerCase()}`;
          let pending = memo.get(dedupKey);
          if (!pending) {
            pending = runScan({
              productTitle: item,
              store: body.store,
              surface: effectiveSurface,
              deviceId: body.deviceId,
              deviceSecret: effectiveSecret,
              watchlist: body.watchlist,
              familyWatchlist: body.familyWatchlist,
              dietaryWatchlist: body.dietaryWatchlist,
              skipAnalytics: true,
            });
            memo.set(dedupKey, pending);
          }
          return pending;
        }
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return Promise.resolve<ScanError>({ ok: false, status: 400, error: "Each item must be an object or string." });
        }
        const rawObj = item as Record<string, unknown>;
        if (
          (rawObj.barcode !== undefined && typeof rawObj.barcode !== "string") ||
          (rawObj.productTitle !== undefined && typeof rawObj.productTitle !== "string") ||
          (rawObj.rawIngredients !== undefined && typeof rawObj.rawIngredients !== "string")
        ) {
          return Promise.resolve<ScanError>({
            ok: false,
            status: 400,
            error: "Item barcode, productTitle, and rawIngredients must be strings when provided.",
          });
        }
        const reqItem = item as ScanRequest;
        const barcodeStr = typeof reqItem.barcode === "string" ? reqItem.barcode.trim() : "";
        const titleStr = typeof reqItem.productTitle === "string" ? reqItem.productTitle.trim().toLowerCase() : "";
        const ingStr = typeof reqItem.rawIngredients === "string" ? reqItem.rawIngredients.trim().toLowerCase() : "";
        const effFw = reqItem.familyWatchlist ?? body.familyWatchlist;
        const effDw = reqItem.dietaryWatchlist ?? body.dietaryWatchlist;
        const fwSig = Array.isArray(effFw) ? [...effFw].sort().join(",") : "";
        const dwSig = Array.isArray(effDw) ? [...effDw].sort().join(",") : "";
        const dedupKey = `obj:${barcodeStr}|${titleStr}|${ingStr}|${fwSig}|${dwSig}`;
        let pending = memo.get(dedupKey);
        if (!pending) {
          pending = runScan({
            ...reqItem,
            store: body.store,
            surface: effectiveSurface ?? reqItem.surface,
            deviceId: reqItem.deviceId ?? body.deviceId,
            deviceSecret: reqItem.deviceSecret ?? effectiveSecret,
            watchlist: body.watchlist,
            familyWatchlist: effFw,
            dietaryWatchlist: effDw,
            skipAnalytics: true,
          });
          memo.set(dedupKey, pending);
        }
        return pending;
      }),
    );
    results.push(...batch);
  }
  const scored = results.filter((r): r is ScanResponse => r.ok);
  const failedCount = results.length - scored.length;
  const avg = scored.length ? Math.round(scored.reduce((s, r) => s + r.result.score, 0) / scored.length) : null;
  const swaps = scored.filter((r) => r.swap).length;

  return NextResponse.json(
    {
      ok: true,
      complete: failedCount === 0,
      cartScore: avg ?? 0,
      scoredItemAverage: avg,
      itemsRequested: items.length,
      itemsScanned: results.length,
      itemsScored: scored.length,
      itemsFailed: failedCount,
      swapsAvailable: swaps,
      results,
    },
    { headers: CORS },
  );
}
