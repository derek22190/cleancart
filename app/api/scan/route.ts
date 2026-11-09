import { NextResponse } from "next/server";
import { checkRateLimit, runScan, toIosText, type ScanRequest } from "@/lib/scan";
import { ADDITIVE_RULES, CATEGORY_LABELS, RUBRIC_VERSION } from "@/lib/rubric";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CORS so the Chrome extension, Android app and iOS Shortcuts can call this endpoint.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Device-Secret",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * GET returns the rubric when called without query params, or executes a fast
 * 1-step scan when ?q= / ?productTitle= / ?barcode= is provided (used by the
 * 1-step iPhone Share Sheet / Back Tap / Action Button Shortcut).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || searchParams.get("productTitle") || "").trim();
  const barcode = (searchParams.get("barcode") || "").trim();
  if (q || barcode) {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    if (!checkRateLimit(`scan:${ip}`, 90)) {
      return NextResponse.json({ ok: false, error: "Too many scan requests. Please wait a moment." }, { status: 429, headers: CORS });
    }
    const format = (searchParams.get("format") || "ios_text").trim();
    const store = (searchParams.get("store") || "walmart").trim() as ScanRequest["store"];
    const scan = await runScan({
      productTitle: q || undefined,
      barcode: barcode || undefined,
      store,
      format: format === "json" ? "json" : "ios_text",
    });
    if (format !== "json") {
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

  return NextResponse.json(
    {
      service: "CleanCart scan API",
      rubricVersion: RUBRIC_VERSION,
      usage: "POST { productTitle?, rawIngredients?, barcode?, store?, surface?, watchlist?, format?: 'json' | 'ios_text' } or GET /api/scan?q=<title>&format=ios_text",
      categories: CATEGORY_LABELS,
      rules: ADDITIVE_RULES.map(({ id, name, risk, category }) => ({ id, name, risk, category })),
    },
    { headers: CORS },
  );
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!checkRateLimit(`scan:${ip}`, 90)) {
    return NextResponse.json({ ok: false, error: "Too many scan requests. Please wait a moment." }, { status: 429, headers: CORS });
  }
  let body: ScanRequest;
  try {
    const text = await request.text();
    if (text.length > 24_000) {
      return NextResponse.json({ ok: false, error: "Request payload too large." }, { status: 413, headers: CORS });
    }
    const parsed = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "Body must be a JSON object." }, { status: 400, headers: CORS });
    }
    body = parsed as ScanRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be valid JSON." }, { status: 400, headers: CORS });
  }

  const headerSecret = request.headers.get("x-device-secret")?.trim();
  if (headerSecret && !body.deviceSecret) {
    body.deviceSecret = headerSecret;
  }
  const reqOrigin = (request.headers.get("origin") || "").toLowerCase();
  if (
    reqOrigin.startsWith("chrome-extension://") ||
    reqOrigin.startsWith("safari-web-extension://") ||
    reqOrigin.startsWith("moz-extension://")
  ) {
    body.surface = "extension";
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
