import { NextResponse } from "next/server";
import {
  cacheNegativeSessionLookup,
  getDevicePaidEntitlement,
  isSessionNegativelyCached,
  isValidStripeSessionIdFormat,
  normalizeRealDeviceId,
  verifyStripeCheckoutSession,
} from "@/lib/entitlements";
import { checkRateLimitAsync } from "@/lib/scan";

function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "anon"
  );
}

export async function GET(req: Request) {
  const ip = getClientIp(req);
  if (!(await checkRateLimitAsync(`entitlement:${ip}`, 60))) {
    return NextResponse.json(
      { ok: false, active: false, error: "Too many entitlement checks. Please wait a moment." },
      { status: 429 }
    );
  }

  const { searchParams } = new URL(req.url);
  const sessionId = (searchParams.get("session_id") || "").trim();
  const rawDeviceId = (searchParams.get("deviceId") || "").trim();
  const deviceId = normalizeRealDeviceId(rawDeviceId);

  if (!sessionId && !rawDeviceId) {
    return NextResponse.json(
      { ok: false, active: false, error: "Missing session_id or deviceId parameter." },
      { status: 400 }
    );
  }

  if (!sessionId && !deviceId) {
    return NextResponse.json({
      ok: true,
      active: false,
      status: null,
    });
  }

  if (sessionId && !isValidStripeSessionIdFormat(sessionId)) {
    return NextResponse.json({
      ok: true,
      active: false,
      status: null,
    });
  }

  const record = sessionId
    ? await verifyStripeCheckoutSession(sessionId, deviceId || undefined)
    : await getDevicePaidEntitlement(deviceId);

  if (sessionId && !record && !(await isSessionNegativelyCached(sessionId))) {
    await cacheNegativeSessionLookup(sessionId, 20);
  }

  if (!record || !record.active) {
    return NextResponse.json({
      ok: true,
      active: false,
      status: record?.status ?? null,
    });
  }

  return NextResponse.json({
    ok: true,
    active: true,
    plan: record.plan,
    status: record.status,
  });
}
