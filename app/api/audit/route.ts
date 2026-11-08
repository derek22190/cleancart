import { NextResponse } from "next/server";
import { checkRateLimit, runScan, type ScanRequest, type ScanResponse, type ScanError } from "@/lib/scan";
import type { Category, Watchlist } from "@/lib/rubric";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * Whole-Cart Auditor: POST { items: [{ productTitle?, rawIngredients?, barcode? }], store?, watchlist? }
 * Scores every cart item and returns the 1-tap swap list for anything under 75.
 */
export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!checkRateLimit(`audit:${ip}`, 10)) {
    return NextResponse.json({ ok: false, error: "Too many cart audit requests. Please wait a moment." }, { status: 429, headers: CORS });
  }
  let body: { items?: unknown; store?: string; watchlist?: Watchlist; familyWatchlist?: Category[] };
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
  const items = body.items.slice(0, 20);
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
              watchlist: body.watchlist,
              familyWatchlist: body.familyWatchlist,
            });
            memo.set(dedupKey, pending);
          }
          return pending;
        }
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return Promise.resolve<ScanError>({ ok: false, status: 400, error: "Each item must be an object or string." });
        }
        const reqItem = item as ScanRequest;
        const dedupKey = `obj:${(reqItem.barcode || "").trim()}|${(reqItem.productTitle || "").trim().toLowerCase()}|${(reqItem.rawIngredients || "").trim().slice(0, 64)}`;
        let pending = memo.get(dedupKey);
        if (!pending) {
          pending = runScan({
            ...reqItem,
            store: body.store,
            watchlist: body.watchlist,
            familyWatchlist: reqItem.familyWatchlist ?? body.familyWatchlist,
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
