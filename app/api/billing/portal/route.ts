import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { resolveBillingPortalCustomer } from "@/lib/entitlements";
import { getExistingDevice, verifyDeviceSecret } from "@/lib/referrals";
import { checkRateLimit } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-Secret",
};

const ALLOWED_RETURN_ORIGINS = new Set([
  "https://heybroc.com",
  "https://www.heybroc.com",
  "https://cleancart.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function resolveSafeReturnUrl(raw?: string): string {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL || "").trim().replace(/\/$/, "");
  if (configured && /^https?:\/\//i.test(configured)) {
    ALLOWED_RETURN_ORIGINS.add(configured);
  }
  if (raw) {
    try {
      const parsed = new URL(raw);
      if (ALLOWED_RETURN_ORIGINS.has(parsed.origin)) {
        return parsed.toString();
      }
    } catch {
      /* ignore */
    }
  }
  return configured && /^https?:\/\//i.test(configured)
    ? configured
    : "https://www.heybroc.com";
}

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

async function createPortalUrl(params: {
  sessionId?: string;
  deviceId?: string;
  deviceSecret?: string;
  email?: string;
  authToken?: string;
  returnUrl?: string;
}): Promise<{ ok: boolean; url?: string; error?: string; status: number }> {
  const secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!secretKey) {
    return {
      ok: false,
      error:
        "Stripe Billing Portal is not configured in this environment. You can also cancel anytime by emailing billing@heybroc.com.",
      status: 503,
    };
  }

  let resolvedEmail = "";
  let resolvedDeviceId = "";

  const candidateDeviceId = (params.deviceId || "").trim();
  if (candidateDeviceId && candidateDeviceId !== "anon-web") {
    const existingDevice = await getExistingDevice(candidateDeviceId);
    if (
      existingDevice?.deviceSecretHash &&
      params.deviceSecret &&
      verifyDeviceSecret(existingDevice, params.deviceSecret)
    ) {
      resolvedDeviceId = candidateDeviceId;
    } else if (existingDevice?.deviceSecretHash && params.deviceSecret) {
      return {
        ok: false,
        error: "Invalid device credentials for billing portal access.",
        status: 403,
      };
    }
  }

  if (params.authToken) {
    const authUser = await getAuthenticatedUser(params.authToken);
    if (authUser && authUser.emailVerified === true) {
      if (authUser.email) {
        resolvedEmail = authUser.email.trim().toLowerCase();
      }
      if (!resolvedDeviceId) {
        const reqDev =
          candidateDeviceId && authUser.linkedDevices?.includes(candidateDeviceId)
            ? candidateDeviceId
            : authUser.linkedDevices?.[0] || "";
        if (reqDev && reqDev !== "anon-web") {
          const existingDevice = await getExistingDevice(reqDev);
          if (existingDevice?.deviceSecretHash) {
            resolvedDeviceId = reqDev;
          }
        }
      }
    }
  }

  if (!resolvedEmail && !resolvedDeviceId) {
    const portalLoginUrl = (process.env.STRIPE_PORTAL_LOGIN_URL || "").trim();
    if (portalLoginUrl && /^https:\/\/billing\.stripe\.com\//i.test(portalLoginUrl)) {
      const rawEmail = (params.email || "").trim().toLowerCase();
      const url = rawEmail
        ? `${portalLoginUrl}${portalLoginUrl.includes("?") ? "&" : "?"}prefilled_email=${encodeURIComponent(rawEmail)}`
        : portalLoginUrl;
      return { ok: true, url, status: 200 };
    }
    return {
      ok: false,
      error:
        "Please sign in to your HeyBroc account to verify ownership and manage or cancel your subscription, or email billing@heybroc.com.",
      status: 401,
    };
  }

  const resolved = await resolveBillingPortalCustomer({
    sessionId: params.sessionId,
    deviceId: resolvedDeviceId || undefined,
    deviceSecret: params.deviceSecret,
    email: resolvedEmail || undefined,
    authToken: params.authToken,
  });

  if (!resolved?.customerId) {
    return {
      ok: false,
      error:
        "No active Stripe subscription was found for this device or email. If you subscribed under a different email or via Google Play / Apple App Store, log in with that email or manage your subscription in your store account.",
      status: 404,
    };
  }

  const returnUrl = resolveSafeReturnUrl(params.returnUrl);
  const form = new URLSearchParams();
  form.set("customer", resolved.customerId);
  form.set("return_url", returnUrl);

  const stripeRes = await fetch(
    "https://api.stripe.com/v1/billing_portal/sessions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    }
  );

  const data = (await stripeRes.json().catch(() => ({}))) as {
    url?: string;
    error?: { message?: string };
  };

  if (!stripeRes.ok || !data.url) {
    return {
      ok: false,
      error:
        data.error?.message ||
        "Unable to open Stripe Billing Portal. Please contact billing@heybroc.com to manage or cancel your subscription.",
      status: 502,
    };
  }

  return { ok: true, url: data.url, status: 200 };
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  if (!checkRateLimit(`billing-portal:${ip}`, 15)) {
    return NextResponse.json(
      { ok: false, error: "Too many requests. Please try again in a minute." },
      { status: 429, headers: CORS }
    );
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: string;
      session_id?: string;
      deviceId?: string;
      deviceSecret?: string;
      email?: string;
      returnUrl?: string;
    };
    const authHeader = request.headers.get("authorization") || "";
    const authToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : undefined;
    const deviceSecret =
      request.headers.get("x-device-secret") || body.deviceSecret || undefined;

    const result = await createPortalUrl({
      sessionId: body.sessionId || body.session_id,
      deviceId: body.deviceId,
      deviceSecret,
      email: body.email,
      authToken,
      returnUrl: body.returnUrl,
    });

    return NextResponse.json(
      {
        ok: result.ok,
        url: result.url,
        error: result.error,
      },
      { status: result.status, headers: CORS }
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request payload." },
      { status: 400, headers: CORS }
    );
  }
}

export async function GET(request: Request) {
  const ip = getClientIp(request);
  if (!checkRateLimit(`billing-portal-get:${ip}`, 15)) {
    return NextResponse.redirect("https://www.heybroc.com/terms#cancel", 302);
  }

  const { searchParams } = new URL(request.url);
  const result = await createPortalUrl({
    sessionId: searchParams.get("session_id") || searchParams.get("sessionId") || undefined,
    deviceId: searchParams.get("deviceId") || undefined,
    deviceSecret: searchParams.get("deviceSecret") || request.headers.get("x-device-secret") || undefined,
    email: searchParams.get("email") || undefined,
    returnUrl: searchParams.get("returnUrl") || undefined,
  });

  if (result.ok && result.url) {
    return NextResponse.redirect(result.url, 302);
  }
  const fallback = resolveSafeReturnUrl(searchParams.get("returnUrl") || undefined);
  return NextResponse.redirect(`${fallback.replace(/\/$/, "")}/terms`, 302);
}
