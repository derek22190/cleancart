import { NextResponse } from "next/server";
import {
  applyOrActivateReferral,
  getOrCreateDevice,
  serializeEntitlement,
} from "@/lib/referrals";
import { PRICING } from "@/lib/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const deviceId = searchParams.get("deviceId") || "anon-web";
  const device = getOrCreateDevice(deviceId);
  return NextResponse.json(
    { ok: true, entitlement: serializeEntitlement(device) },
    { headers: CORS },
  );
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      action?: "status" | "claim" | "activate" | "record_swap" | "courtesy_refill";
      deviceId?: string;
      referralCode?: string;
      productKey?: string;
    };
    const deviceId = (body.deviceId || "anon-web").trim();
    const action = body.action || "status";

    if (action === "claim" || action === "activate") {
      const res = applyOrActivateReferral({
        deviceId,
        referralCode: body.referralCode,
        activateNow: action === "activate",
      });
      return NextResponse.json(
        {
          ok: true,
          rewardedNow: res.rewardedNow,
          message: res.message,
          entitlement: serializeEntitlement(res.device),
        },
        { headers: CORS },
      );
    }

    const device = getOrCreateDevice(deviceId);

    if (action === "courtesy_refill") {
      device.courtesyRefillUsedThisWeek = true;
      return NextResponse.json(
        {
          ok: true,
          message: `Unlocked +${PRICING.courtesyRefillSwaps} courtesy swaps to finish your grocery order!`,
          entitlement: serializeEntitlement(device),
        },
        { headers: CORS },
      );
    }

    if (action === "record_swap" && body.productKey) {
      const normKey = body.productKey.trim().toLowerCase();
      if (normKey && !device.weeklySwapsUsed.includes(normKey)) {
        device.weeklySwapsUsed.push(normKey);
      }
    }

    return NextResponse.json(
      { ok: true, entitlement: serializeEntitlement(device) },
      { headers: CORS },
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400, headers: CORS },
    );
  }
}
