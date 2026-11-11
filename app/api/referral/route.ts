import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { normalizeRealDeviceId } from "@/lib/entitlements";
import {
  applyOrActivateReferral,
  buildTransientFreeDevice,
  getExistingDevice,
  getOrCreateDevice,
  isValidReferralCode,
  saveDevice,
  serializeEntitlementWithPaidLookup,
  verifyDeviceSecret,
} from "@/lib/referrals";
import { PRICING } from "@/lib/pricing";
import { checkRateLimitAsync } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-Secret",
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
  if (!(await checkRateLimitAsync(`referral-get:${ip}`, 30))) {
    return NextResponse.json(
      { ok: false, error: "Too many requests." },
      { status: 429, headers: CORS }
    );
  }
  const { searchParams } = new URL(request.url);
  const validateCode = searchParams.get("validateCode")?.trim().toUpperCase();
  if (validateCode) {
    const valid = await isValidReferralCode(validateCode);
    return NextResponse.json(
      { ok: valid, valid, code: validateCode },
      { status: valid ? 200 : 404, headers: CORS }
    );
  }
  const rawDeviceId = (searchParams.get("deviceId") || "anon-web").trim();
  const normDeviceId = normalizeRealDeviceId(rawDeviceId);
  const deviceSecret = request.headers.get("x-device-secret") || undefined;
  const device = !normDeviceId
    ? buildTransientFreeDevice(rawDeviceId)
    : deviceSecret
      ? await getOrCreateDevice(normDeviceId, deviceSecret)
      : (await getExistingDevice(normDeviceId)) ??
        buildTransientFreeDevice(normDeviceId);
  return NextResponse.json(
    { ok: true, entitlement: await serializeEntitlementWithPaidLookup(device) },
    { headers: CORS }
  );
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  if (!(await checkRateLimitAsync(`referral-post:${ip}`, 20))) {
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
    const rawDeviceId = (body.deviceId || "anon-web").trim();
    const deviceId = normalizeRealDeviceId(rawDeviceId);
    const action = body.action || "status";
    const deviceSecret =
      request.headers.get("x-device-secret") || body.deviceSecret || undefined;
    const authHeader = request.headers.get("authorization") || "";
    const authToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";
    const authUser = authToken.startsWith("hb_")
      ? await getAuthenticatedUser(authToken).catch(() => null)
      : null;
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
      if (!deviceId || !deviceSecret) {
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

    const device = !deviceId
      ? buildTransientFreeDevice(rawDeviceId)
      : deviceSecret
        ? await getOrCreateDevice(deviceId, deviceSecret)
        : (await getExistingDevice(deviceId)) ?? buildTransientFreeDevice(deviceId);

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
        userId: authUser?.userId,
        linkedDevices: authUser?.linkedDevices,
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
            error: "Free swap limit reached. Upgrade to HeyBroc Pro for unlimited swaps.",
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
            distinctId: deviceId || ip,
            platform: !deviceId ? "web" : "android",
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
