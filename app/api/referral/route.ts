import { NextResponse } from "next/server";
import {
  applyOrActivateReferral,
  codeFromDeviceId,
  getExistingDevice,
  getOrCreateDevice,
  saveDevice,
  serializeEntitlementWithPaidLookup,
  verifyDeviceSecret,
  type DeviceEntitlement,
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

function buildTransientDevice(deviceId: string): DeviceEntitlement {
  const now = Date.now();
  return {
    deviceId,
    referralCode: codeFromDeviceId(deviceId),
    referralActivated: false,
    firstSeenAt: now,
    proUntil: 0,
    referralsCompleted: 0,
    weeklySwapsUsed: [],
    weekResetAt: now + 7 * 24 * 60 * 60 * 1000,
    courtesyRefillUsedThisWeek: false,
  };
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
  const deviceId = (searchParams.get("deviceId") || "anon-web").trim();
  const deviceSecret = request.headers.get("x-device-secret") || undefined;
  const device =
    deviceSecret || deviceId === "anon-web"
      ? await getOrCreateDevice(deviceId, deviceSecret)
      : (await getExistingDevice(deviceId)) ?? buildTransientDevice(deviceId);
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

    const requiresAuth =
      action === "claim" ||
      action === "courtesy_refill" ||
      action === "record_swap";

    if (requiresAuth) {
      if (!deviceId || deviceId === "anon-web" || !deviceSecret) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "A bound deviceId and deviceSecret are required for referral claims, swap tracking, and courtesy refills.",
          },
          { status: 400, headers: CORS }
        );
      }
    }

    const device =
      deviceSecret || deviceId === "anon-web"
        ? await getOrCreateDevice(deviceId, deviceSecret)
        : (await getExistingDevice(deviceId)) ?? buildTransientDevice(deviceId);

    if (requiresAuth) {
      if (!device.deviceSecretHash) {
        return NextResponse.json(
          { ok: false, error: "Unbound device credentials." },
          { status: 400, headers: CORS }
        );
      }
      if (!verifyDeviceSecret(device, deviceSecret)) {
        return NextResponse.json(
          { ok: false, error: "Invalid device credentials." },
          { status: 403, headers: CORS }
        );
      }
    } else if (
      device.deviceSecretHash &&
      deviceSecret &&
      !verifyDeviceSecret(device, deviceSecret)
    ) {
      return NextResponse.json(
        { ok: false, error: "Invalid device credentials." },
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
      if (!res.ok) {
        return NextResponse.json(
          {
            ok: false,
            rewardedNow: false,
            error: res.message,
            message: res.message,
            entitlement: await serializeEntitlementWithPaidLookup(res.device),
          },
          { status: 400, headers: CORS }
        );
      }
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
      const currentEnt = await serializeEntitlementWithPaidLookup(device);
      if (
        !currentEnt.isProActive &&
        currentEnt.swapsRemaining <= 0 &&
        (!normKey || !device.weeklySwapsUsed.includes(normKey))
      ) {
        return NextResponse.json(
          {
            ok: false,
            error: "Weekly free swap limit reached. Upgrade to HeyBroc Pro for unlimited swaps.",
            entitlement: currentEnt,
          },
          { status: 402, headers: CORS }
        );
      }
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
