import { NextResponse } from "next/server";
import { runScan, type ScanRequest } from "@/lib/scan";
import type { Watchlist } from "@/lib/rubric";

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
  let body: { items?: ScanRequest[]; store?: string; watchlist?: Watchlist };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be valid JSON." }, { status: 400, headers: CORS });
  }
  const items = (body.items || []).slice(0, 50);
  if (!items.length) {
    return NextResponse.json({ ok: false, error: "Provide a non-empty items array." }, { status: 400, headers: CORS });
  }

  const results = await Promise.all(
    items.map((item) => runScan({ ...item, store: body.store, watchlist: body.watchlist })),
  );
  const scored = results.filter((r) => r.ok);
  const avg = scored.length ? Math.round(scored.reduce((s, r) => s + (r.ok ? r.result.score : 0), 0) / scored.length) : 0;
  const swaps = scored.filter((r) => r.ok && r.swap).length;

  return NextResponse.json(
    { ok: true, cartScore: avg, itemsScanned: results.length, swapsAvailable: swaps, results },
    { headers: CORS },
  );
}
