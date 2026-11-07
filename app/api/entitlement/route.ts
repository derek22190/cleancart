import { NextResponse } from "next/server";
import { verifyStripeCheckoutSession } from "@/lib/entitlements";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sessionId = (searchParams.get("session_id") || "").trim();

  if (!sessionId) {
    return NextResponse.json(
      { ok: false, active: false, error: "Missing session_id parameter." },
      { status: 400 }
    );
  }

  const record = await verifyStripeCheckoutSession(sessionId);
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
