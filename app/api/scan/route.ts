import { NextResponse } from "next/server";
import { getAuthenticatedUser, toPublicProfile } from "@/lib/auth";
import {
  checkRateLimitAsync,
  inferClientPlatform,
  runBatchScan,
  runScan,
  toIosText,
  type BatchScanItemInput,
  type ScanRequest,
} from "@/lib/scan";
import { ADDITIVE_RULES, CATEGORY_LABELS, RUBRIC_VERSION } from "@/lib/rubric";
import { isAffiliateAllowedOnClient } from "@/lib/swaps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CORS so the Chrome extension, Android app and iOS Shortcuts can call this endpoint.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Device-Secret, X-Client-Platform, X-HeyBroc-Platform, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

const MAX_SCAN_BODY_BYTES = 24_000;
const BATCH_AUTH_TIMEOUT_MS = 900;

function extractClientIp(request: Request): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      return process.env.VERCEL ? parts[parts.length - 1] : parts[0];
    }
  }
  return "local";
}

async function readBoundedRequestText(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; status: 413 }> {
  const declaredLen = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    return { ok: false, status: 413 };
  }
  if (!request.body) {
    return { ok: true, text: "" };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          void reader.cancel().catch(() => {});
          return { ok: false, status: 413 };
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  if (chunks.length === 0) return { ok: true, text: "" };
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
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
    const ip = extractClientIp(request);
    if (!(await checkRateLimitAsync(`scan:${ip}`, 90))) {
      return NextResponse.json(
        { ok: false, error: "Too many scan requests. Please wait a moment." },
        { status: 429, headers: { ...CORS, "Retry-After": "15" } },
      );
    }
    const format = (searchParams.get("format") || "ios_text").trim();
    const store = (searchParams.get("store") || "walmart").trim() as ScanRequest["store"];
    const preferStoreBrand =
      searchParams.get("preferStoreBrand") === "1" || searchParams.get("preferStoreBrand") === "true";
    const resolvedFormat = format === "json" ? "json" : "ios_text";
    const deviceIdParam = (searchParams.get("deviceId") || "").trim() || undefined;
    const clientPlatform = inferClientPlatform({
      clientPlatform:
        searchParams.get("clientPlatform") ||
        request.headers.get("x-client-platform") ||
        request.headers.get("x-heybroc-platform") ||
        undefined,
      surface: searchParams.get("surface") || undefined,
      format: resolvedFormat,
      deviceId: deviceIdParam,
      origin: request.headers.get("origin") || undefined,
      userAgent: request.headers.get("user-agent") || undefined,
    });
    const scan = await runScan({
      productTitle: q || undefined,
      barcode: barcode || undefined,
      store,
      preferStoreBrand,
      deviceId: deviceIdParam,
      clientPlatform,
      surface: !isAffiliateAllowedOnClient("web", clientPlatform) ? "extension" : undefined,
      format: resolvedFormat,
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
      usage: "POST { productTitle?, rawIngredients?, barcode?, items?, store?, surface?, clientPlatform?, watchlist?, dietaryWatchlist?, format?: 'json' | 'ios_text' } or GET /api/scan?q=<title>&format=ios_text",
      categories: CATEGORY_LABELS,
      rules: ADDITIVE_RULES.map(({ id, name, risk, category }) => ({ id, name, risk, category })),
    },
    { headers: CORS },
  );
}

export async function POST(request: Request) {
  const ip = extractClientIp(request);
  let body: ScanRequest & { items?: BatchScanItemInput[] };
  const boundedRead = await readBoundedRequestText(request, MAX_SCAN_BODY_BYTES);
  if (!boundedRead.ok) {
    return NextResponse.json({ ok: false, error: "Request payload too large." }, { status: 413, headers: CORS });
  }
  try {
    const text = boundedRead.text;
    if (text.length > MAX_SCAN_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: "Request payload too large." }, { status: 413, headers: CORS });
    }
    const parsed = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "Body must be a JSON object." }, { status: 400, headers: CORS });
    }
    body = parsed as ScanRequest & { items?: BatchScanItemInput[] };
    body.verifiedAccountPro = false;
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be valid JSON." }, { status: 400, headers: CORS });
  }

  const isBatchRequest = Array.isArray(body.items);
  const batchItemCount = isBatchRequest ? Math.min(8, Math.max(1, body.items!.length)) : 0;
  const rateCost = batchItemCount > 0 ? batchItemCount : 1;
  if (!(await checkRateLimitAsync(`scan:${ip}`, 120, 60_000, rateCost))) {
    return NextResponse.json(
      { ok: false, error: "Too many scan requests. Please wait a moment." },
      { status: 429, headers: { ...CORS, "Retry-After": "15" } },
    );
  }

  const headerSecret = request.headers.get("x-device-secret")?.trim();
  if (headerSecret && !body.deviceSecret) {
    body.deviceSecret = headerSecret;
  }
  const bearerToken =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ||
    (typeof body.authToken === "string" ? body.authToken.trim() : "");
  if (bearerToken) {
    const resolveBearerPro = async (): Promise<boolean> => {
      try {
        const authedUser = await getAuthenticatedUser(bearerToken);
        if (!authedUser) return false;
        const profile = await toPublicProfile(authedUser);
        return Boolean(profile.isProActive);
      } catch {
        return false;
      }
    };
    if (isBatchRequest) {
      let authTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        body.verifiedAccountPro = await Promise.race([
          resolveBearerPro(),
          new Promise<boolean>((resolve) => {
            authTimer = setTimeout(() => resolve(false), BATCH_AUTH_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (authTimer !== undefined) clearTimeout(authTimer);
      }
    } else {
      body.verifiedAccountPro = await resolveBearerPro();
    }
  }
  const clientPlatform = inferClientPlatform({
    clientPlatform:
      body.clientPlatform ||
      request.headers.get("x-client-platform") ||
      request.headers.get("x-heybroc-platform") ||
      undefined,
    surface: body.surface,
    format: body.format,
    deviceId: body.deviceId,
    origin: request.headers.get("origin") || undefined,
    userAgent: request.headers.get("user-agent") || undefined,
  });
  body.clientPlatform = clientPlatform;
  if (!isAffiliateAllowedOnClient(body.surface ?? "web", clientPlatform)) {
    body.surface = "extension";
  }

  if (Array.isArray(body.items)) {
    const batchRes = await runBatchScan(body, body.items);
    return NextResponse.json(batchRes, { headers: CORS });
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
