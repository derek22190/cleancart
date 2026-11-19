/**
 * HeyBroc — Google Play Real-Time Developer Notifications Webhook (`POST /api/google/webhook`)
 * -------------------------------------------------------------------------------------------
 * Receives Google Cloud Pub/Sub push notifications for Google Play Billing subscription
 * lifecycle changes, verifies purchase tokens directly against the Google Play Developer API
 * (`purchases.subscriptionsv2.get`), synchronizes cross-platform Family Pro entitlements and
 * linked user `proUntil` timestamps, credits first-cycle creator conversions, and claws back
 * creator commissions on `SUBSCRIPTION_REVOKED` (12) or voided purchases.
 *
 * Configuration in Google Cloud Pub/Sub Push Subscription:
 *   - Endpoint URL: https://www.heybroc.com/api/google/webhook?token=<GOOGLE_PLAY_RTDN_TOKEN>
 *     (or pass `Authorization: Bearer <GOOGLE_PLAY_RTDN_TOKEN>`)
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getUserByEmail, saveUser } from "@/lib/auth";
import {
  getSubscriptionEntitlement,
  saveEntitlement,
  updateSubscriptionEntitlement,
  type EntitlementStatus,
} from "@/lib/entitlements";
import {
  clawbackCreatorCommission,
  getCreator,
  getCreatorConversionMeta,
  hasSubscriptionFirstPaidCredit,
  normalizeCode,
  recordStripeCreatorConversionOnce,
} from "@/lib/influencers";
import type { PlanId } from "@/lib/pricing";
import { checkRateLimitAsync } from "@/lib/rate-limit";
import { kvGet, kvSet } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WEBHOOK_BODY_CHARS = 64_000;
const DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60;

// Google Play RTDN SubscriptionNotification.notificationType values
const SUB_RECOVERED = 1;
const SUB_RENEWED = 2;
const SUB_CANCELED = 3;
const SUB_PURCHASED = 4;
const SUB_ON_HOLD = 5;
const SUB_IN_GRACE_PERIOD = 6;
const SUB_RESTARTED = 7;
const SUB_DEFERRED = 9;
const SUB_PAUSED = 10;
const SUB_REVOKED = 12;
const SUB_EXPIRED = 13;

const ACTIVE_NOTIFICATION_TYPES = new Set<number>([
  SUB_RECOVERED,
  SUB_RENEWED,
  SUB_PURCHASED,
  SUB_IN_GRACE_PERIOD,
  SUB_RESTARTED,
]);

const NON_ACTIVE_NOTIFICATION_TYPES = new Set<number>([
  SUB_CANCELED,
  SUB_ON_HOLD,
  SUB_PAUSED,
  SUB_EXPIRED,
]);

interface GoogleServiceAccountCreds {
  clientEmail: string;
  privateKey: string;
}

interface VerifiedGoogleSub {
  active: boolean;
  isTrial: boolean;
  isTestPurchase: boolean;
  expiresAtMs: number;
  orderId: string;
  productId: string;
  linkedPurchaseToken: string;
  subscriptionState: string;
}

interface GoogleRtdnPayload {
  version?: string;
  packageName?: string;
  eventTimeMillis?: string | number;
  testNotification?: { version?: string };
  subscriptionNotification?: {
    version?: string;
    notificationType?: number;
    purchaseToken?: string;
    subscriptionId?: string;
  };
  voidedPurchaseNotification?: {
    purchaseToken?: string;
    orderId?: string;
    productType?: number;
    refundType?: number;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1"
  );
}

function constantTimeEquals(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyRtdnRequestToken(request: Request, expectedToken: string): boolean {
  const authHeader = (request.headers.get("authorization") || "").trim();
  if (authHeader.startsWith("Bearer ")) {
    const bearer = authHeader.slice(7).trim();
    if (bearer && constantTimeEquals(expectedToken, bearer)) {
      return true;
    }
  }
  try {
    const url = new URL(request.url);
    const queryToken = (url.searchParams.get("token") || "").trim();
    if (queryToken && constantTimeEquals(expectedToken, queryToken)) {
      return true;
    }
  } catch {
    // ignore malformed URL
  }
  return false;
}

function inferGooglePlanFromProductId(
  productId?: string,
  fallback: PlanId = "annual"
): PlanId {
  const lower = (productId || "").trim().toLowerCase();
  if (!lower) return fallback;
  if (lower.includes("month")) return "monthly";
  return "annual";
}

function resolveGoogleGrossUsd(plan: PlanId): number {
  return plan === "monthly" ? 9.99 : 49.99;
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

function decodePubSubData(rawData: string): string {
  const normalized = rawData.trim().replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
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

async function verifyWithGooglePlayApi(params: {
  packageName: string;
  purchaseToken: string;
  fallbackProductId: string;
  fallbackOrderId: string;
}): Promise<{
  ok: boolean;
  status: number;
  unknownToken?: boolean;
  error?: string;
  sub?: VerifiedGoogleSub;
}> {
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
    if (res.status === 404 || res.status === 410) {
      return {
        ok: false,
        status: 404,
        unknownToken: true,
        error: "Google Play subscription token was not found.",
      };
    }
    return {
      ok: false,
      status: 502,
      error: "Google Play Developer API could not verify this subscription token.",
    };
  }

  const data = (await res.json()) as {
    subscriptionState?: string;
    latestOrderId?: string;
    linkedPurchaseToken?: string;
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
  const linkedPurchaseToken = String(data.linkedPurchaseToken || "").trim();
  const isTestPurchase = Boolean(data.testPurchase);
  const offerId = String(line?.offerDetails?.offerId || "").toLowerCase();
  const isTrial = offerId.includes("trial") || offerId.includes("free");

  return {
    ok: true,
    status: 200,
    sub: {
      active:
        isActiveState && Number.isFinite(expiresAtMs) && expiresAtMs > Date.now(),
      isTrial,
      isTestPurchase,
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0,
      orderId,
      productId,
      linkedPurchaseToken,
      subscriptionState: state,
    },
  };
}

function hashToken24(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 24);
}

export async function POST(request: Request) {
  if (!(await checkRateLimitAsync(`google-webhook:${getClientIp(request)}`, 120))) {
    return NextResponse.json(
      { ok: false, error: "Too many Google Play webhook requests." },
      { status: 429 }
    );
  }

  const expectedToken = (process.env.GOOGLE_PLAY_RTDN_TOKEN || "").trim();
  if (!expectedToken) {
    return NextResponse.json(
      { ok: false, error: "GOOGLE_PLAY_RTDN_TOKEN is not configured on the server." },
      { status: 503 }
    );
  }

  if (!verifyRtdnRequestToken(request, expectedToken)) {
    return NextResponse.json(
      { ok: false, error: "Invalid Google Play RTDN webhook authorization." },
      { status: 401 }
    );
  }

  let parsedEnvelope: unknown;
  try {
    const rawText = await request.text();
    if (rawText.length > MAX_WEBHOOK_BODY_CHARS) {
      return NextResponse.json(
        { ok: false, error: "Webhook payload too large." },
        { status: 413 }
      );
    }
    parsedEnvelope = JSON.parse(rawText);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON payload." },
      { status: 400 }
    );
  }

  if (
    !isPlainObject(parsedEnvelope) ||
    !isPlainObject(parsedEnvelope.message) ||
    typeof parsedEnvelope.message.data !== "string" ||
    !parsedEnvelope.message.data.trim()
  ) {
    return NextResponse.json(
      { ok: false, error: "Missing Cloud Pub/Sub message.data." },
      { status: 400 }
    );
  }

  const messageId =
    typeof parsedEnvelope.message.messageId === "string"
      ? parsedEnvelope.message.messageId.trim()
      : "";

  let rtdn: GoogleRtdnPayload;
  try {
    const decoded = decodePubSubData(parsedEnvelope.message.data);
    const parsedData: unknown = JSON.parse(decoded);
    if (!isPlainObject(parsedData)) {
      return NextResponse.json(
        { ok: false, error: "Decoded RTDN payload must be a JSON object." },
        { status: 400 }
      );
    }
    rtdn = parsedData as GoogleRtdnPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Malformed base64/JSON in Pub/Sub message.data." },
      { status: 400 }
    );
  }

  const expectedPkg = (
    process.env.GOOGLE_PLAY_PACKAGE_NAME || "com.cleancart.overlay"
  ).trim();
  const packageName = String(rtdn.packageName || "").trim();
  if (!packageName || packageName !== expectedPkg) {
    return NextResponse.json(
      { ok: false, error: "Google Play packageName mismatch." },
      { status: 403 }
    );
  }

  if (rtdn.testNotification && !rtdn.subscriptionNotification && !rtdn.voidedPurchaseNotification) {
    return NextResponse.json({
      ok: true,
      received: true,
      testNotification: true,
    });
  }

  if (messageId) {
    const seen = await kvGet<string>(
      `heybroc:webhook:google_rtdn:${messageId}`
    ).catch(() => null);
    if (seen) {
      return NextResponse.json({
        ok: true,
        received: true,
        deduped: true,
      });
    }
  }

  const subNotif = rtdn.subscriptionNotification;
  const voidNotif = rtdn.voidedPurchaseNotification;
  const isVoidedNotif = Boolean(!subNotif && voidNotif);
  const notificationType = isVoidedNotif
    ? SUB_REVOKED
    : typeof subNotif?.notificationType === "number"
      ? subNotif.notificationType
      : -1;
  const purchaseToken = String(
    subNotif?.purchaseToken || voidNotif?.purchaseToken || ""
  ).trim();
  const fallbackProductId = String(subNotif?.subscriptionId || "").trim();
  const fallbackOrderId = String(voidNotif?.orderId || "").trim();

  if (!purchaseToken || notificationType < 0) {
    if (messageId) {
      await kvSet(
        `heybroc:webhook:google_rtdn:${messageId}`,
        "1",
        DEDUPE_TTL_SECONDS
      ).catch(() => {});
    }
    return NextResponse.json({
      ok: true,
      received: true,
      ignored: true,
    });
  }

  const verified = await verifyWithGooglePlayApi({
    packageName,
    purchaseToken,
    fallbackProductId,
    fallbackOrderId,
  });

  if (!verified.ok || !verified.sub) {
    if (verified.unknownToken) {
      if (messageId) {
        await kvSet(
          `heybroc:webhook:google_rtdn:${messageId}`,
          "1",
          DEDUPE_TTL_SECONDS
        ).catch(() => {});
      }
      return NextResponse.json({
        ok: true,
        received: true,
        ignored: true,
        reason: "unknown_token",
      });
    }
    return NextResponse.json(
      { ok: false, error: verified.error || "Google Play verification failed." },
      { status: verified.status }
    );
  }

  const sub = verified.sub;
  const now = Date.now();
  const rawOrderId = sub.orderId || fallbackOrderId;
  const baseOrderId = rawOrderId ? rawOrderId.replace(/\.\.\d+$/, "") : "";
  const tokenHash = hashToken24(purchaseToken);
  const stableOrderId = baseOrderId || rawOrderId || tokenHash;

  const candidateSubIds = Array.from(
    new Set(
      [
        `google_${stableOrderId}`,
        rawOrderId && rawOrderId !== stableOrderId ? `google_${rawOrderId}` : "",
        `google:${stableOrderId}`,
        `google_${tokenHash}`,
        sub.linkedPurchaseToken
          ? `google_${hashToken24(sub.linkedPurchaseToken)}`
          : "",
        `rc_${stableOrderId}`,
      ].filter(Boolean)
    )
  );

  let existing = null;
  for (const subKey of candidateSubIds) {
    const found = await getSubscriptionEntitlement(subKey).catch(() => null);
    if (found) {
      existing = found;
      break;
    }
  }

  // Matches `app/api/google/verify/route.ts` key format (`google_${stableOrderId}`)
  const targetSubId = existing?.subscriptionId || `google_${stableOrderId}`;
  const plan = inferGooglePlanFromProductId(
    sub.productId || fallbackProductId,
    existing?.plan || "annual"
  );

  const convMeta =
    (await getCreatorConversionMeta(`google_order:${stableOrderId}`)) ??
    (await getCreatorConversionMeta(`rc_orig:${stableOrderId}`)) ??
    (await getCreatorConversionMeta(`google_orig:${stableOrderId}`));

  const candidateCreatorCode = normalizeCode(
    existing?.creatorCode || convMeta?.code || ""
  );
  let validCreatorCode: string | undefined;
  if (candidateCreatorCode && !candidateCreatorCode.startsWith("BROC")) {
    if (convMeta?.code) {
      validCreatorCode = candidateCreatorCode;
    } else {
      const creator = await getCreator(candidateCreatorCode).catch(() => null);
      if (creator && creator.active) {
        validCreatorCode = creator.code;
      } else if (existing?.creatorCode) {
        validCreatorCode = candidateCreatorCode;
      }
    }
  }

  let appliedStatus: EntitlementStatus = existing?.status || "canceled";

  if (ACTIVE_NOTIFICATION_TYPES.has(notificationType)) {
    const isActiveNow =
      (sub.active || notificationType === SUB_IN_GRACE_PERIOD) &&
      sub.expiresAtMs > now;
    appliedStatus = isActiveNow
      ? sub.isTrial
        ? "trialing"
        : "active"
      : "canceled";

    await saveEntitlement({
      sessionId: existing?.sessionId || `google_tx_${stableOrderId}`,
      subscriptionId: targetSubId,
      customerEmail: existing?.customerEmail,
      deviceId: existing?.deviceId,
      userId: existing?.userId,
      creatorCode: validCreatorCode,
      plan,
      status: appliedStatus,
      active: isActiveNow,
      expiresAtMs: sub.expiresAtMs || existing?.expiresAtMs,
      lastChargeSucceeded:
        !sub.isTrial && isActiveNow
          ? true
          : existing?.lastChargeSucceeded ?? false,
      updatedAt: new Date(now).toISOString(),
    });

    if (isActiveNow && existing?.customerEmail && sub.expiresAtMs > now) {
      const linkedUser = await getUserByEmail(existing.customerEmail).catch(
        () => null
      );
      if (linkedUser) {
        const nextProUntil = Math.max(linkedUser.proUntil || 0, sub.expiresAtMs);
        if (nextProUntil > (linkedUser.proUntil || 0)) {
          linkedUser.proUntil = nextProUntil;
          await saveUser(linkedUser).catch(() => {});
        }
      }
    }

    if (
      isActiveNow &&
      !sub.isTestPurchase &&
      !sub.isTrial &&
      validCreatorCode &&
      !validCreatorCode.startsWith("BROC")
    ) {
      const alreadyCreditedAcrossPipelines =
        (await hasSubscriptionFirstPaidCredit(`google_order:${stableOrderId}`)) ||
        (await hasSubscriptionFirstPaidCredit(`rc_orig:${stableOrderId}`)) ||
        (await hasSubscriptionFirstPaidCredit(`google_orig:${stableOrderId}`));
      if (!alreadyCreditedAcrossPipelines) {
        await recordStripeCreatorConversionOnce(
          `google_order:${stableOrderId}`,
          validCreatorCode,
          plan === "monthly" ? "paid_monthly" : "paid_annual",
          resolveGoogleGrossUsd(plan),
          existing?.customerEmail,
          {
            creditedTransactionId: rawOrderId || stableOrderId,
            creditedEventId: messageId || undefined,
            subscriptionKey: `google_orig:${stableOrderId}`,
            additionalSubscriptionKeys: [
              `google_order:${stableOrderId}`,
              `rc_orig:${stableOrderId}`,
            ],
            buyerUserId: existing?.userId,
            buyerDeviceId: existing?.deviceId,
          }
        );
      }
    }
  } else if (NON_ACTIVE_NOTIFICATION_TYPES.has(notificationType)) {
    appliedStatus = "canceled";
    const isImmediatelyInactive =
      notificationType === SUB_ON_HOLD ||
      notificationType === SUB_PAUSED ||
      notificationType === SUB_EXPIRED ||
      !sub.expiresAtMs ||
      sub.expiresAtMs <= now;
    const effectiveExpiresAtMs = isImmediatelyInactive
      ? Math.min(sub.expiresAtMs || now, now)
      : sub.expiresAtMs;

    await updateSubscriptionEntitlement(targetSubId, {
      status: "canceled",
      plan,
      creatorCode: validCreatorCode,
      expiresAtMs: effectiveExpiresAtMs,
    });

    if (isImmediatelyInactive && existing?.customerEmail) {
      const linkedUser = await getUserByEmail(existing.customerEmail).catch(
        () => null
      );
      if (linkedUser && (linkedUser.proUntil || 0) > effectiveExpiresAtMs) {
        linkedUser.proUntil = effectiveExpiresAtMs;
        await saveUser(linkedUser).catch(() => {});
      }
    }
  } else if (notificationType === SUB_REVOKED) {
    appliedStatus = "canceled";
    await updateSubscriptionEntitlement(targetSubId, {
      status: "canceled",
      plan,
      creatorCode: validCreatorCode,
      expiresAtMs: now,
      paidPassExpiresAtMs: now - 1000,
      passRevokedAtMs: now,
    });

    if (existing?.customerEmail) {
      const linkedUser = await getUserByEmail(existing.customerEmail).catch(
        () => null
      );
      if (linkedUser && (linkedUser.proUntil || 0) > now) {
        linkedUser.proUntil = now;
        await saveUser(linkedUser).catch(() => {});
      }
    }

    const shouldClawback =
      Boolean(validCreatorCode) &&
      !validCreatorCode!.startsWith("BROC") &&
      !sub.isTestPurchase &&
      !sub.isTrial &&
      (Boolean(convMeta) || existing?.lastChargeSucceeded !== false);

    if (shouldClawback && validCreatorCode) {
      const effectivePlan = convMeta?.plan || plan;
      const refundGrossUsd =
        convMeta?.grossUsd ?? resolveGoogleGrossUsd(effectivePlan);
      await clawbackCreatorCommission(
        `google_refund:${stableOrderId}`,
        validCreatorCode,
        effectivePlan,
        refundGrossUsd,
        true,
        {
          buyerEmail: existing?.customerEmail || convMeta?.buyerEmail,
          originalConversionKey: `google_order:${stableOrderId}`,
          fallbackConversionKeys: [
            `rc_orig:${stableOrderId}`,
            `google_orig:${stableOrderId}`,
          ],
          refundedTransactionId: rawOrderId || stableOrderId,
          originalPreTaxUsd: convMeta?.grossUsd,
          refundRatio: 1,
        }
      );
    }
  } else if (notificationType === SUB_DEFERRED && sub.expiresAtMs > now) {
    appliedStatus = existing?.status || "active";
    await updateSubscriptionEntitlement(targetSubId, {
      status: appliedStatus,
      plan,
      creatorCode: validCreatorCode,
      expiresAtMs: sub.expiresAtMs,
    });
    if (existing?.customerEmail) {
      const linkedUser = await getUserByEmail(existing.customerEmail).catch(
        () => null
      );
      if (linkedUser && sub.expiresAtMs > (linkedUser.proUntil || 0)) {
        linkedUser.proUntil = sub.expiresAtMs;
        await saveUser(linkedUser).catch(() => {});
      }
    }
  }

  if (messageId) {
    await kvSet(
      `heybroc:webhook:google_rtdn:${messageId}`,
      "1",
      DEDUPE_TTL_SECONDS
    ).catch(() => {});
  }

  return NextResponse.json({
    ok: true,
    received: true,
    notificationType,
    subscriptionId: targetSubId,
    status: appliedStatus,
    plan,
  });
}
