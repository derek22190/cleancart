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
import { saveEntitlement, type EntitlementStatus } from "@/lib/entitlements";
import {
  recordStripeCreatorConversionOnce,
  recordStripeCreatorRefundOnce,
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

function inferPlanFromProductId(productId?: string): PlanId {
  const id = (productId || "").toLowerCase();
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

  if (ev.type === "TEST") {
    return NextResponse.json({ ok: true, received: "TEST" });
  }

  const attrs = ev.subscriber_attributes;
  const appUserId = (ev.app_user_id || ev.original_app_user_id || "").trim();
  const attrEmail = extractAttr(attrs, "$email", "email")?.toLowerCase();
  const customerEmail =
    attrEmail || (appUserId.includes("@") ? appUserId.toLowerCase() : undefined);

  const attrDeviceId = extractAttr(attrs, "$deviceId", "deviceId", "device_id");
  const deviceId =
    attrDeviceId || (!appUserId.includes("@") && !appUserId.startsWith("$RCAnonymousID") ? appUserId : undefined);

  const creatorCode = extractAttr(attrs, "$creatorCode", "creatorCode", "creator_code", "$campaign");
  const referralCode = extractAttr(attrs, "referredByCode", "referral_code");
  const plan = inferPlanFromProductId(ev.product_id);
  const subscriptionId = `rc_${ev.original_transaction_id || ev.transaction_id || appUserId || ev.id || "sub"}`;
  const sessionId = `rc_evt_${ev.id || Date.now()}`;
  const eventCreatedSec = ev.event_timestamp_ms
    ? Math.floor(ev.event_timestamp_ms / 1000)
    : Math.floor(Date.now() / 1000);

  const nowMs = Date.now();
  const stillWithinPaidPeriod =
    typeof ev.expiration_at_ms === "number" && ev.expiration_at_ms > nowMs;

  let status: EntitlementStatus = "active";
  switch (ev.type) {
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
      // When a user cancels auto-renew, keep Pro active until expiration_at_ms passes;
      // if it was an immediate refund (price < 0 or already expired), revoke immediately.
      status =
        stillWithinPaidPeriod && (ev.price_in_purchased_currency ?? 0) >= 0
          ? "active"
          : "canceled";
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

  await saveEntitlement({
    sessionId,
    subscriptionId,
    customerId: appUserId || undefined,
    customerEmail,
    deviceId,
    plan,
    creatorCode,
    status,
    active: status === "active" || status === "trialing",
    expiresAtMs:
      typeof ev.expiration_at_ms === "number" ? ev.expiration_at_ms : undefined,
    lastStripeEventCreated: eventCreatedSec,
    updatedAt: new Date().toISOString(),
  });

  // Credit creator / referral on initial purchase or renewal
  const eventId = ev.id || `${subscriptionId}_${eventCreatedSec}`;
  if (ev.type === "INITIAL_PURCHASE" || ev.type === "RENEWAL" || ev.type === "TRIAL_STARTED") {
    if (creatorCode) {
      const creatorEvent =
        status === "trialing"
          ? "trial"
          : plan === "annual"
            ? "paid_annual"
            : "paid_monthly";
      await recordStripeCreatorConversionOnce(`rc_${eventId}`, creatorCode, creatorEvent);
    }
    if (deviceId) {
      await applyOrActivateReferral({
        deviceId,
        referralCode,
        activateNow: true,
      });
    }
    const platform =
      ev.store === "PLAY_STORE" ? "android" : ev.store === "APP_STORE" ? "ios" : "web";
    await trackServerEvent({
      event: "pro_subscribed",
      distinctId: deviceId || customerEmail || appUserId,
      platform,
      properties: {
        plan,
        status,
        store: ev.store || "revenuecat",
        creatorCode: creatorCode || null,
      },
    });
  } else if (ev.type === "CANCELLATION" && (ev.price_in_purchased_currency ?? 0) < 0 && creatorCode) {
    await recordStripeCreatorRefundOnce(
      `rc_refund_${eventId}`,
      creatorCode,
      plan,
      Math.abs(ev.price_in_purchased_currency || 0),
    );
  }

  return NextResponse.json({
    ok: true,
    type: ev.type,
    status,
    plan,
  });
}
