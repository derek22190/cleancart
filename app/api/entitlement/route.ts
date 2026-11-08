import { NextResponse } from "next/server";
import {
  getDevicePaidEntitlement,
  verifyStripeCheckoutSession,
} from "@/lib/entitlements";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sessionId = (searchParams.get("session_id") || "").trim();
  const deviceId = (searchParams.get("deviceId") || "").trim();

  if (!sessionId && !deviceId) {
    return NextResponse.json(
      { ok: false, active: false, error: "Missing session_id or deviceId parameter." },
      { status: 400 }
    );
  }

  const record = sessionId
    ? await verifyStripeCheckoutSession(sessionId, deviceId || undefined)
    : await getDevicePaidEntitlement(deviceId);

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
