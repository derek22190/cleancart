import { NextResponse } from "next/server";
import {
  applyOrActivateReferral,
  getOrCreateDevice,
  saveDevice,
  serializeEntitlementWithPaidLookup,
  verifyDeviceSecret,
} from "@/lib/referrals";
import { PRICING } from "@/lib/pricing";
import { checkRateLimit } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Device-Secret",
};

function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "anon"
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(request: Request) {
  const ip = getClientIp(request);
  if (!checkRateLimit(`referral-get:${ip}`, 30)) {
    return NextResponse.json(
      { ok: false, error: "Too many requests." },
      { status: 429, headers: CORS }
    );
  }
  const { searchParams } = new URL(request.url);
  const deviceId = searchParams.get("deviceId") || "anon-web";
  const deviceSecret = request.headers.get("x-device-secret") || undefined;
  const device = await getOrCreateDevice(deviceId, deviceSecret);
  return NextResponse.json(
    { ok: true, entitlement: await serializeEntitlementWithPaidLookup(device) },
    { headers: CORS }
  );
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  if (!checkRateLimit(`referral-post:${ip}`, 20)) {
    return NextResponse.json(
      { ok: false, error: "Too many requests." },
      { status: 429, headers: CORS }
    );
  }

  try {
    const body = (await request.json()) as {
      action?: "status" | "claim" | "activate" | "record_swap" | "courtesy_refill";
      deviceId?: string;
      deviceSecret?: string;
      referralCode?: string;
      referredByCode?: string;
      productKey?: string;
    };
    const deviceId = (body.deviceId || "anon-web").trim();
    const action = body.action || "status";
    const deviceSecret =
      request.headers.get("x-device-secret") || body.deviceSecret || undefined;
    const resolvedReferralCode = (
      body.referralCode ||
      body.referredByCode ||
      ""
    ).trim();

    // Direct unauthenticated referral activation via /api/referral is forbidden
    if (action === "activate") {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Direct referral activation is not permitted. Complete a verified store scan or checkout trial.",
        },
        { status: 403, headers: CORS }
      );
    }

    if (action === "claim") {
      const res = await applyOrActivateReferral({
        deviceId,
        referralCode: resolvedReferralCode,
        activateNow: false,
        deviceSecret,
      });
      return NextResponse.json(
        {
          ok: true,
          rewardedNow: false,
          message: res.message,
          entitlement: await serializeEntitlementWithPaidLookup(res.device),
        },
        { headers: CORS }
      );
    }

    const device = await getOrCreateDevice(deviceId, deviceSecret);
    if (!verifyDeviceSecret(device, deviceSecret)) {
      return NextResponse.json(
        { ok: false, error: "Invalid device credentials." },
        { status: 403, headers: CORS }
      );
    }

    if (action === "courtesy_refill") {
      device.courtesyRefillUsedThisWeek = true;
      await saveDevice(device);
      return NextResponse.json(
        {
          ok: true,
          message: `Unlocked +${PRICING.courtesyRefillSwaps} courtesy swaps to finish your grocery order!`,
          entitlement: await serializeEntitlementWithPaidLookup(device),
        },
        { headers: CORS }
      );
    }

    if (action === "record_swap" && body.productKey) {
      const normKey = body.productKey.trim().toLowerCase().slice(0, 120);
      if (normKey && !device.weeklySwapsUsed.includes(normKey)) {
        device.weeklySwapsUsed.push(normKey);
        await saveDevice(device);
      }
      void import("@/lib/analytics")
        .then(({ trackServerEvent }) =>
          trackServerEvent({
            event: "clean_swap_clicked",
            distinctId: deviceId,
            platform: deviceId === "anon-web" ? "web" : "android",
            properties: { product: normKey },
          }),
        )
        .catch(() => {});
    }

    return NextResponse.json(
      { ok: true, entitlement: await serializeEntitlementWithPaidLookup(device) },
      { headers: CORS }
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400, headers: CORS }
    );
  }
}
