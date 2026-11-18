/**
 * HeyBroc — Google Play Billing Subscription Verification (`/api/google/verify`)
 * ------------------------------------------------------------------------------
 * Verifies Google Play Billing purchase tokens directly against Google Play
 * Developer API (`purchases.subscriptionsv2.get`) using a configured service account,
 * activates cross-platform Family Pro entitlements across Android, iOS & Web,
 * and attributes optional creator affiliate codes strictly for live production purchases.
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getAuthenticatedUser, saveUser } from "@/lib/auth";
import {
  getSubscriptionEntitlement,
  normalizeRealDeviceId,
  saveEntitlement,
  type EntitlementStatus,
} from "@/lib/entitlements";
import {
  getCreator,
  normalizeCode,
  recordStripeCreatorConversionOnce,
} from "@/lib/influencers";
import type { PlanId } from "@/lib/pricing";
import { applyOrActivateReferral } from "@/lib/referrals";
import { checkRateLimitAsync } from "@/lib/scan";
import { kvGet } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_GOOGLE_PRODUCTS = new Set([
  "heybroc_pro_annual",
  "heybroc_pro_monthly",
  "com.heybroc.pro.annual",
  "com.heybroc.pro.monthly",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "anon"
  );
}

function inferGooglePlanFromProductId(productId: string): PlanId {
  const lower = productId.toLowerCase();
  if (lower.includes("month")) return "monthly";
  return "annual";
}

function resolveGoogleGrossUsd(plan: PlanId): number {
  return plan === "monthly" ? 9.99 : 49.99;
}

interface GoogleServiceAccountCreds {
  clientEmail: string;
  privateKey: string;
}

function getGoogleServiceAccountCreds(): GoogleServiceAccountCreds | null {
  const rawJson = (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || "").trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as {
        client_email?: string;
        private_key?: string;
      };
      if (parsed.client_email && parsed.private_key) {
        return {
          clientEmail: parsed.client_email.trim(),
          privateKey: parsed.private_key.replace(/\\n/g, "\n"),
        };
      }
    } catch {
      return null;
    }
  }
  const email = (process.env.GOOGLE_PLAY_CLIENT_EMAIL || "").trim();
  const key = (process.env.GOOGLE_PLAY_PRIVATE_KEY || "").trim();
  if (email && key) {
    return {
      clientEmail: email,
      privateKey: key.replace(/\\n/g, "\n"),
    };
  }
  return null;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function fetchGoogleAccessToken(
  creds: GoogleServiceAccountCreds
): Promise<string | null> {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: creds.clientEmail,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSec,
      exp: nowSec + 3000,
    })
  );
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  const sig = base64Url(signer.sign(creds.privateKey));
  const assertion = `${signingInput}.${sig}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(8000),
  });
  if (!tokenRes.ok) return null;
  const data = (await tokenRes.json()) as { access_token?: string };
  return typeof data.access_token === "string" ? data.access_token : null;
}

interface VerifiedGoogleSub {
  active: boolean;
  isTrial: boolean;
  isTestPurchase: boolean;
  expiresAtMs: number;
  orderId: string;
  productId: string;
}

async function verifyWithGooglePlayApi(params: {
  packageName: string;
  purchaseToken: string;
  fallbackProductId: string;
  fallbackOrderId: string;
}): Promise<{ ok: boolean; status: number; error?: string; sub?: VerifiedGoogleSub }> {
  const creds = getGoogleServiceAccountCreds();
  if (!creds) {
    return {
      ok: false,
      status: 503,
      error: "Google Play verification is not configured on the server yet.",
    };
  }
  const accessToken = await fetchGoogleAccessToken(creds);
  if (!accessToken) {
    return {
      ok: false,
      status: 502,
      error: "Could not authenticate with Google Play Developer API.",
    };
  }

  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
    params.packageName
  )}/purchases/subscriptionsv2/tokens/${encodeURIComponent(params.purchaseToken)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    return {
      ok: false,
      status: res.status === 404 || res.status === 400 ? 401 : 502,
      error: "Google Play could not verify this subscription purchase token.",
    };
  }

  const data = (await res.json()) as {
    subscriptionState?: string;
    latestOrderId?: string;
    testPurchase?: Record<string, unknown>;
    lineItems?: Array<{
      productId?: string;
      expiryTime?: string;
      offerDetails?: { offerId?: string };
    }>;
  };

  const state = String(data.subscriptionState || "");
  const isActiveState =
    state === "SUBSCRIPTION_STATE_ACTIVE" ||
    state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD";
  const line = data.lineItems?.[0];
  const expiresAtMs = line?.expiryTime ? Date.parse(line.expiryTime) : 0;
  const orderId = String(
    data.latestOrderId || params.fallbackOrderId || ""
  ).trim();
  const productId = String(
    line?.productId || params.fallbackProductId || ""
  ).trim();
  const isTestPurchase = Boolean(data.testPurchase);
  const offerId = String(line?.offerDetails?.offerId || "").toLowerCase();
  const isTrial = offerId.includes("trial") || offerId.includes("free");

  return {
    ok: true,
    status: 200,
    sub: {
      active: isActiveState && Number.isFinite(expiresAtMs) && expiresAtMs > Date.now(),
      isTrial,
      isTestPurchase,
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0,
      orderId,
      productId,
    },
  };
}

export async function POST(request: Request) {
  if (!(await checkRateLimitAsync(`google-verify:${getClientIp(request)}`, 30))) {
    return NextResponse.json(
      { ok: false, error: "Too many verification requests. Please wait a moment." },
      { status: 429 }
    );
  }

  let body: {
    purchaseToken?: string;
    productId?: string;
    packageName?: string;
    orderId?: string;
    deviceId?: string;
    token?: string;
    creatorCode?: string;
  };
  try {
    const rawText = await request.text();
    if (rawText.length > 16_000) {
      return NextResponse.json({ ok: false, error: "Payload too large." }, { status: 413 });
    }
    const parsed: unknown = JSON.parse(rawText);
    if (!isPlainObject(parsed) || typeof parsed.purchaseToken !== "string") {
      return NextResponse.json(
        { ok: false, error: "Missing purchaseToken." },
        { status: 400 }
      );
    }
    body = {
      purchaseToken: parsed.purchaseToken.trim(),
      productId: typeof parsed.productId === "string" ? parsed.productId.trim() : "",
      packageName:
        typeof parsed.packageName === "string" ? parsed.packageName.trim() : "",
      orderId: typeof parsed.orderId === "string" ? parsed.orderId.trim() : "",
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : undefined,
      token: typeof parsed.token === "string" ? parsed.token : undefined,
      creatorCode:
        typeof parsed.creatorCode === "string" ? parsed.creatorCode : undefined,
    };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON payload." }, { status: 400 });
  }

  if (!body.purchaseToken || body.purchaseToken.length < 8) {
    return NextResponse.json({ ok: false, error: "Invalid purchaseToken." }, { status: 400 });
  }

  const expectedPkg = (
    process.env.GOOGLE_PLAY_PACKAGE_NAME || "com.cleancart.overlay"
  ).trim();
  const packageName = body.packageName || expectedPkg;
  if (packageName !== expectedPkg) {
    return NextResponse.json(
      { ok: false, error: "Google Play packageName mismatch." },
      { status: 403 }
    );
  }

  const claimProductId = (body.productId || "").toLowerCase();
  if (!claimProductId || !ALLOWED_GOOGLE_PRODUCTS.has(claimProductId)) {
    return NextResponse.json(
      { ok: false, error: "Unrecognized Google Play subscription productId." },
      { status: 403 }
    );
  }

  const verified = await verifyWithGooglePlayApi({
    packageName,
    purchaseToken: body.purchaseToken,
    fallbackProductId: claimProductId,
    fallbackOrderId: body.orderId || "",
  });

  if (!verified.ok || !verified.sub) {
    return NextResponse.json(
      { ok: false, error: verified.error || "Google Play verification failed." },
      { status: verified.status }
    );
  }

  const sub = verified.sub;
  const now = Date.now();
  if (!sub.active || sub.expiresAtMs <= now) {
    return NextResponse.json({
      ok: true,
      active: false,
      status: "canceled",
      expiresAtMs: sub.expiresAtMs,
    });
  }

  const stableOrderId =
    sub.orderId ||
    crypto.createHash("sha256").update(body.purchaseToken).digest("hex").slice(0, 24);
  const subscriptionId = `google_${stableOrderId}`;
  const sessionId = `google_tx_${stableOrderId}`;
  const plan = inferGooglePlanFromProductId(sub.productId || claimProductId);
  const status: EntitlementStatus = sub.isTrial ? "trialing" : "active";

  const authHeader = request.headers.get("authorization") || "";
  const sessionToken =
    (authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "") ||
    (body.token || "").trim();
  const authedUser = sessionToken
    ? await getAuthenticatedUser(sessionToken)
    : null;
  const cleanDeviceId = normalizeRealDeviceId(body.deviceId) || undefined;

  const existingEntitlement = await getSubscriptionEntitlement(
    subscriptionId
  ).catch(() => null);

  let validCreatorCode: string | undefined = existingEntitlement?.creatorCode;
  const rawCreatorInput = (body.creatorCode || "").trim().toUpperCase();
  if (rawCreatorInput) {
    if (rawCreatorInput.startsWith("BROC")) {
      if (cleanDeviceId && /^BROC-[A-Z0-9]{4,10}$/.test(rawCreatorInput)) {
        await applyOrActivateReferral({
          deviceId: cleanDeviceId,
          referralCode: rawCreatorInput,
          activateNow: true,
        }).catch(() => {});
      }
    } else if (!existingEntitlement && !validCreatorCode) {
      const normCode = normalizeCode(rawCreatorInput);
      if (normCode) {
        const creator = await getCreator(normCode).catch(() => null);
        if (creator && creator.active) {
          validCreatorCode = creator.code;
        }
      }
    }
  } else if (cleanDeviceId) {
    await applyOrActivateReferral({
      deviceId: cleanDeviceId,
      activateNow: true,
    }).catch(() => {});
  }

  const buyerEmail = authedUser?.email || existingEntitlement?.customerEmail;

  await saveEntitlement({
    sessionId,
    subscriptionId,
    customerEmail: buyerEmail,
    deviceId: cleanDeviceId,
    userId: authedUser?.userId,
    creatorCode: validCreatorCode,
    plan,
    status,
    active: true,
    expiresAtMs: sub.expiresAtMs,
    lastChargeSucceeded: !sub.isTrial,
    updatedAt: new Date(now).toISOString(),
  });

  if (!sub.isTestPurchase && validCreatorCode && !validCreatorCode.startsWith("BROC")) {
    const rcAlreadyCredited = Boolean(
      await kvGet(`heybroc:creator:conv_lock:rc_orig:${stableOrderId}`).catch(
        () => null
      )
    );
    if (!rcAlreadyCredited) {
      if (sub.isTrial) {
        await recordStripeCreatorConversionOnce(
          `google_trial:${stableOrderId}`,
          validCreatorCode,
          "trial",
          undefined,
          buyerEmail
        );
      } else {
        await recordStripeCreatorConversionOnce(
          `google_order:${stableOrderId}`,
          validCreatorCode,
          plan === "monthly" ? "paid_monthly" : "paid_annual",
          resolveGoogleGrossUsd(plan),
          buyerEmail,
          {
            creditedTransactionId: stableOrderId,
            subscriptionKey: `google_order:${stableOrderId}`,
          }
        );
      }
    }
  }

  if (authedUser) {
    const nextProUntil = Math.max(authedUser.proUntil || 0, sub.expiresAtMs);
    if (nextProUntil > (authedUser.proUntil || 0)) {
      authedUser.proUntil = nextProUntil;
      await saveUser(authedUser).catch(() => {});
    }
  }

  return NextResponse.json({
    ok: true,
    active: true,
    plan,
    status,
    expiresAtMs: sub.expiresAtMs,
    subscriptionId,
    environment: sub.isTestPurchase ? "Sandbox" : "Production",
    ...(validCreatorCode ? { creatorCode: validCreatorCode } : {}),
  });
}
