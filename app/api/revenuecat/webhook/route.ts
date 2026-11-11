/**
 * HeyBroc — RevenueCat Webhook Receiver (`/api/revenuecat/webhook`)
 * -----------------------------------------------------------------
 * Syncs Apple App Store (StoreKit 2) and Google Play Billing subscriptions
 * directly into our unified cross-platform Entitlement & Creator Ledger (`lib/entitlements.ts`),
 * so purchasing HeyBroc Pro on iOS or Google Play immediately unlocks Pro across
 * Android, iOS, Chrome Extension, and Web (`heybroc.com`).
 *
 * Configuration in RevenueCat Dashboard -> Integrations -> Webhooks:
 *   - Webhook URL: https://www.heybroc.com/api/revenuecat/webhook
 *   - Authorization header: Bearer <REVENUECAT_WEBHOOK_SECRET>
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { trackServerEvent } from "@/lib/analytics";
import {
  getDevicePaidEntitlement,
  getEmailEntitlement,
  getSubscriptionEntitlement,
  normalizeRealDeviceId,
  saveEntitlement,
  type EntitlementStatus,
} from "@/lib/entitlements";
import {
  clawbackCreatorCommission,
  recordStripeCreatorConversionOnce,
} from "@/lib/influencers";
import type { PlanId } from "@/lib/pricing";
import { applyOrActivateReferral } from "@/lib/referrals";

interface RevenueCatSubscriberAttribute {
  value?: string;
  updated_at_ms?: number;
}

interface RevenueCatEvent {
  id?: string;
  type?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  aliases?: string[];
  product_id?: string;
  period_type?: "TRIAL" | "INTRO" | "NORMAL" | "PROMOTIONAL" | string;
  purchased_at_ms?: number;
  expiration_at_ms?: number | null;
  event_timestamp_ms?: number;
  store?: "APP_STORE" | "PLAY_STORE" | "STRIPE" | "PROMOTIONAL" | string;
  transaction_id?: string;
  original_transaction_id?: string;
  cancellation_reason?: string;
  cancel_reason?: string;
  price?: number;
  currency?: string;
  tax_percentage?: number;
  price_in_purchased_currency?: number;
  subscriber_attributes?: Record<string, RevenueCatSubscriberAttribute | undefined>;
}

interface RevenueCatWebhookBody {
  api_version?: string;
  event?: RevenueCatEvent;
}

function verifyBearerSecret(authHeader: string | null, secret: string): boolean {
  if (!authHeader || !secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(authHeader.trim(), "utf8");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function inferPlanFromProductId(productId?: string, fallback: PlanId = "annual"): PlanId {
  const id = (productId || "").trim().toLowerCase();
  if (!id) return fallback;
  if (/(?:^|[_\-.])(month|monthly|mo|m)(?:$|[_\-.])/i.test(id)) {
    return "monthly";
  }
  return "annual";
}

function extractAttr(
  attrs: Record<string, RevenueCatSubscriberAttribute | undefined> | undefined,
  ...keys: string[]
): string | undefined {
  if (!attrs) return undefined;
  for (const k of keys) {
    const val = attrs[k]?.value?.trim();
    if (val) return val;
  }
  return undefined;
}

export async function POST(req: Request) {
  const secret = (process.env.REVENUECAT_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "REVENUECAT_WEBHOOK_SECRET is not configured on the server." },
      { status: 500 },
    );
  }

  if (!verifyBearerSecret(req.headers.get("authorization"), secret)) {
    return NextResponse.json(
      { ok: false, error: "Invalid RevenueCat webhook authorization header." },
      { status: 401 },
    );
  }

  let payload: RevenueCatWebhookBody;
  try {
    payload = (await req.json()) as RevenueCatWebhookBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Malformed JSON body." }, { status: 400 });
  }

  const ev = payload.event;
  if (!ev || !ev.type) {
    return NextResponse.json({ ok: false, error: "Missing RevenueCat event object." }, { status: 400 });
  }

  const eventType = ev.type.trim().toUpperCase();
  if (eventType === "TEST") {
    return NextResponse.json({ ok: true, received: "TEST" });
  }

  const attrs = ev.subscriber_attributes;
  const appUserId = (ev.app_user_id || ev.original_app_user_id || "").trim();

  const attrEmail = extractAttr(attrs, "$email", "email")?.toLowerCase();
  const prelimEmail =
    attrEmail || (appUserId.includes("@") ? appUserId.toLowerCase() : undefined);

  const attrDeviceId = extractAttr(attrs, "$deviceId", "deviceId", "device_id");
  const candidateDeviceId =
    attrDeviceId ||
    (!appUserId.includes("@") && !appUserId.startsWith("$RCAnonymousID")
      ? appUserId
      : undefined);
  const prelimDeviceId = normalizeRealDeviceId(candidateDeviceId) || undefined;

  const explicitOrigSubId = ev.original_transaction_id
    ? `rc_${ev.original_transaction_id}`
    : undefined;
  const prelimTxSubId =
    explicitOrigSubId || (ev.transaction_id ? `rc_${ev.transaction_id}` : undefined);

  // Look up existing stored entitlement BEFORE finalizing subscriptionId so REFUND / CANCELLATION / EXPIRATION
  // events omitting original_transaction_id resolve and revoke the exact `sub:rc_<orig>` record
  const existing =
    (explicitOrigSubId
      ? await getSubscriptionEntitlement(explicitOrigSubId)
      : null) ??
    (prelimTxSubId && prelimTxSubId !== explicitOrigSubId
      ? await getSubscriptionEntitlement(prelimTxSubId)
      : null) ??
    (prelimDeviceId ? await getDevicePaidEntitlement(prelimDeviceId) : null) ??
    (prelimEmail ? await getEmailEntitlement(prelimEmail) : null);

  const subscriptionId = explicitOrigSubId
    ? explicitOrigSubId
    : existing?.subscriptionId?.startsWith("rc_")
      ? existing.subscriptionId
      : `rc_${ev.transaction_id || appUserId || ev.id || "sub"}`;
  const sessionId = existing?.sessionId || `rc_sess_${subscriptionId}`;

  const customerEmail = prelimEmail || existing?.customerEmail;
  const deviceId =
    prelimDeviceId || normalizeRealDeviceId(existing?.deviceId) || undefined;
  const attrUserId = extractAttr(attrs, "$userId", "userId", "user_id");
  const userId =
    attrUserId ||
    (appUserId.startsWith("usr_") ? appUserId : undefined) ||
    existing?.userId;

  const rawCreatorCode = extractAttr(
    attrs,
    "$creatorCode",
    "creatorCode",
    "creator_code",
    "$campaign"
  );
  const isFriendCreatorAttr = Boolean(
    rawCreatorCode && /^BROC-[A-Z0-9]{4,10}$/i.test(rawCreatorCode)
  );
  const creatorCode =
    (isFriendCreatorAttr ? undefined : rawCreatorCode) || existing?.creatorCode;
  const referralCode =
    extractAttr(attrs, "referredByCode", "referral_code") ||
    (isFriendCreatorAttr ? rawCreatorCode?.toUpperCase() : undefined);
  const plan = inferPlanFromProductId(ev.product_id, existing?.plan || "annual");

  const eventCreatedSec = ev.event_timestamp_ms
    ? Math.floor(ev.event_timestamp_ms / 1000)
    : Math.floor(Date.now() / 1000);

  const nowMs = Date.now();
  const stillWithinPaidPeriod =
    typeof ev.expiration_at_ms === "number" && ev.expiration_at_ms > nowMs;

  const cancellationReason = (
    ev.cancellation_reason ||
    ev.cancel_reason ||
    ""
  )
    .trim()
    .toUpperCase();
  const hasNegativePrice =
    (typeof ev.price === "number" && Number.isFinite(ev.price) && ev.price < 0) ||
    (typeof ev.price_in_purchased_currency === "number" &&
      Number.isFinite(ev.price_in_purchased_currency) &&
      ev.price_in_purchased_currency < 0);
  const isImmediateRefundEvent =
    eventType === "REFUND" ||
    eventType === "REFUNDED" ||
    (eventType === "CANCELLATION" &&
      (cancellationReason === "CUSTOMER_SUPPORT" || hasNegativePrice));

  let status: EntitlementStatus = "active";
  switch (eventType) {
    case "INITIAL_PURCHASE":
    case "RENEWAL":
    case "UNCANCELLATION":
    case "PRODUCT_CHANGE":
    case "NON_RENEWING_PURCHASE":
      status = ev.period_type === "TRIAL" ? "trialing" : "active";
      break;
    case "TRIAL_STARTED":
      status = "trialing";
      break;
    case "CANCELLATION":
      // Immediate refund (`CUSTOMER_SUPPORT` or `price < 0`) revokes immediately;
      // voluntary auto-renew cancellation keeps Pro active until `expiration_at_ms` passes.
      status =
        !isImmediateRefundEvent && stillWithinPaidPeriod ? "active" : "canceled";
      break;
    case "REFUND":
    case "REFUNDED":
      status = "canceled";
      break;
    case "BILLING_ISSUE":
      status = stillWithinPaidPeriod ? "active" : "past_due";
      break;
    case "SUBSCRIPTION_PAUSED":
      status = "paused";
      break;
    case "EXPIRATION":
    case "TRIAL_CANCELLED":
      status = "canceled";
      break;
    default:
      return NextResponse.json({ ok: true, ignored: ev.type });
  }

  const expiresAtMs = isImmediateRefundEvent
    ? nowMs - 1000
    : status === "canceled"
      ? typeof ev.expiration_at_ms === "number"
        ? Math.min(ev.expiration_at_ms, nowMs)
        : nowMs - 1000
      : typeof ev.expiration_at_ms === "number"
        ? ev.expiration_at_ms
        : existing?.expiresAtMs;

  const customerId = appUserId.startsWith("cus_")
    ? appUserId
    : existing?.customerId?.startsWith("cus_")
      ? existing.customerId
      : undefined;

  const eventId = ev.id || `${subscriptionId}_${eventCreatedSec}`;
  const rawUsdPrice =
    typeof ev.price === "number" && Number.isFinite(ev.price)
      ? ev.price
      : typeof ev.price_in_purchased_currency === "number" &&
          Number.isFinite(ev.price_in_purchased_currency) &&
          (!ev.currency || ev.currency.toUpperCase() === "USD")
        ? ev.price_in_purchased_currency
        : 0;
  const taxPct =
    typeof ev.tax_percentage === "number" && Number.isFinite(ev.tax_percentage)
      ? Math.max(0, Math.min(0.5, ev.tax_percentage))
      : 0;
  const preTaxUsdPrice =
    rawUsdPrice !== 0
      ? Math.round(rawUsdPrice * (1 - taxPct) * 100) / 100
      : 0;

  const isPositivePaidEvent =
    !isImmediateRefundEvent &&
    ev.period_type !== "TRIAL" &&
    (eventType === "INITIAL_PURCHASE" ||
      eventType === "RENEWAL" ||
      eventType === "NON_RENEWING_PURCHASE" ||
      eventType === "PRODUCT_CHANGE") &&
    preTaxUsdPrice > 0;

  await saveEntitlement({
    sessionId,
    subscriptionId,
    customerId,
    customerEmail,
    deviceId,
    userId,
    plan,
    creatorCode,
    status,
    active: !isImmediateRefundEvent && (status === "active" || status === "trialing"),
    expiresAtMs,
    lastChargeSucceeded: isPositivePaidEvent
      ? true
      : existing?.lastChargeSucceeded ?? false,
    ...(isImmediateRefundEvent
      ? {
          paidPassExpiresAtMs: nowMs - 1000,
          passRevokedAtMs: nowMs,
        }
      : {}),
    lastStripeEventCreated: eventCreatedSec,
    updatedAt: new Date().toISOString(),
  });

  // Credit creator / referral on initial purchase or renewal; claw back proportionally ONLY on real paid refunds
  if (
    eventType === "INITIAL_PURCHASE" ||
    eventType === "RENEWAL" ||
    eventType === "TRIAL_STARTED"
  ) {
    if (creatorCode) {
      const amountPaidUsd = preTaxUsdPrice > 0 ? preTaxUsdPrice : 0;
      const isTrialEvent = status === "trialing" || amountPaidUsd <= 0;
      if (!isTrialEvent || eventType !== "RENEWAL") {
        const creatorEvent = isTrialEvent
          ? "trial"
          : plan === "annual"
            ? "paid_annual"
            : "paid_monthly";
        await recordStripeCreatorConversionOnce(
          `rc_${eventId}`,
          creatorCode,
          creatorEvent,
          amountPaidUsd > 0 ? amountPaidUsd : undefined,
          customerEmail
        );
      }
    }
    if (deviceId) {
      await applyOrActivateReferral({
        deviceId,
        referralCode,
        activateNow: true,
        userId,
      });
    }
    const platform =
      ev.store === "PLAY_STORE" ? "android" : ev.store === "APP_STORE" ? "ios" : "web";
    const rcAmountUsd = rawUsdPrice > 0 ? rawUsdPrice : 0;
    await trackServerEvent({
      event: "pro_subscribed",
      distinctId: deviceId || subscriptionId,
      platform,
      properties: {
        plan,
        status,
        store: ev.store || "revenuecat",
        creatorCode: creatorCode || null,
        amountUsd: rcAmountUsd,
      },
    });
  } else if (
    isImmediateRefundEvent &&
    creatorCode &&
    !/^BROC-[A-Z0-9]{4,10}$/i.test(creatorCode)
  ) {
    const explicitPrice =
      typeof ev.price === "number" && Number.isFinite(ev.price)
        ? ev.price
        : undefined;
    const shouldSkipClawback =
      ev.period_type === "TRIAL" ||
      explicitPrice === 0 ||
      ev.price_in_purchased_currency === 0 ||
      (explicitPrice === undefined && !existing?.lastChargeSucceeded);

    if (!shouldSkipClawback) {
      const preTaxRefundUsd =
        explicitPrice !== undefined && explicitPrice !== 0
          ? Math.round(Math.abs(explicitPrice) * (1 - taxPct) * 100) / 100
          : preTaxUsdPrice !== 0
            ? Math.abs(preTaxUsdPrice)
            : undefined;
      await clawbackCreatorCommission(
        `rc_refund_${ev.transaction_id || eventId}`,
        creatorCode,
        plan,
        preTaxRefundUsd,
        preTaxRefundUsd === undefined ? true : undefined,
        {
          buyerEmail: customerEmail,
        }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    type: ev.type,
    status,
    plan,
  });
}
