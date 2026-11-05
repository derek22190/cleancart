import { NextResponse } from "next/server";
import { runScan, toIosText, type ScanRequest } from "@/lib/scan";
import { ADDITIVE_RULES, CATEGORY_LABELS, RUBRIC_VERSION } from "@/lib/rubric";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CORS so the Chrome extension, Android app and iOS Shortcuts can call this endpoint.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/** GET returns the rubric so clients can inspect the exact deterministic rules. */
export function GET() {
  return NextResponse.json(
    {
      service: "CleanCart scan API",
      rubricVersion: RUBRIC_VERSION,
      usage: "POST { productTitle?, rawIngredients?, barcode?, store?, watchlist?, format?: 'json' | 'ios_text' }",
      categories: CATEGORY_LABELS,
      rules: ADDITIVE_RULES.map(({ id, name, risk, category }) => ({ id, name, risk, category })),
    },
    { headers: CORS },
  );
}

export async function POST(request: Request) {
  let body: ScanRequest;
  try {
    const text = await request.text();
    body = text ? (JSON.parse(text) as ScanRequest) : {};
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be valid JSON." }, { status: 400, headers: CORS });
  }

  const scan = await runScan(body);

  if (body.format === "ios_text") {
    const text = scan.ok ? toIosText(scan) : `⚠️ CleanCart: ${scan.error}`;
    return new NextResponse(text, {
      status: scan.ok ? 200 : scan.status,
      headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (!scan.ok) {
    return NextResponse.json({ ok: false, error: scan.error }, { status: scan.status, headers: CORS });
  }
  return NextResponse.json(scan, { headers: CORS });
}
