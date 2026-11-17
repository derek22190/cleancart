/**
 * HeyBroc — Apple App Store Server Notifications V2 Webhook (`POST /api/apple/webhook`)
 * -------------------------------------------------------------------------------------
 * Verifies Apple's signed App Store Server Notifications V2 (`signedPayload` + nested
 * `signedTransactionInfo` / `signedRenewalInfo`) against Apple Root CA G3/G1 X.509 chains
 * and synchronizes cross-platform Family Pro entitlements + first-paid-billing-cycle
 * creator affiliate commissions and proportional refund/revoke clawbacks.
 *
 * Lifecycle handling:
 *   - `TEST`: Verifies Apple JWS signature + bundleId and acknowledges 200.
 *   - `SUBSCRIBED` / `DID_RENEW` / `OFFER_REDEEMED` / `DID_CHANGE_RENEWAL_PRODUCT` (`UPGRADE`):
 *       Updates `apple_<originalTransactionId>` entitlement and credits creator commission
 *       ONCE on the first paid billing cycle (`apple_orig:<originalTransactionId>`), never on
 *       `$0` `FREE_TRIAL` starts and never on recurring renewals #2+.
 *   - `REFUND` / `REVOKE`:
 *       Revokes active entitlement and proportionally claws back creator commission ONLY when
 *       the refunded `transactionId` matches the credited first-cycle transaction.
 *   - `EXPIRED` / `GRACE_PERIOD_EXPIRED` / `DID_FAIL_TO_RENEW`:
 *       Transitions entitlement cleanly between grace period, `past_due`, and `canceled`.
 */
import { NextResponse } from "next/server";
import {
  inferApplePlanFromProductId,
  isAppleTrialTransaction,
  resolveAppleGrossUsd,
  verifyAppleSignedJws,
  type AppleNotificationV2Payload,
  type AppleRenewalInfoClaims,
  type AppleTransactionClaims,
} from "@/lib/apple-jws";
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
  normalizeCode,
  recordStripeCreatorConversionOnce,
} from "@/lib/influencers";
import { checkRateLimitAsync } from "@/lib/rate-limit";
import { kvGet, kvSet } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WEBHOOK_BODY_CHARS = 64_000;
const MAX_NOTIFICATION_AGE_MS = 7 * 24 * 60 * 60 * 1000; // Allow Apple retry window up to 7 days
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

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

export async function POST(request: Request) {
  if (!(await checkRateLimitAsync(`apple-webhook:${getClientIp(request)}`, 120))) {
    return NextResponse.json(
      { ok: false, error: "Too many Apple webhook requests." },
      { status: 429 }
    );
  }

  let parsedBody: unknown;
  try {
    const rawText = await request.text();
    if (rawText.length > MAX_WEBHOOK_BODY_CHARS) {
      return NextResponse.json(
        { ok: false, error: "Webhook payload too large." },
        { status: 413 }
      );
    }
    parsedBody = JSON.parse(rawText);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON payload." },
      { status: 400 }
    );
  }

  if (
    !isPlainObject(parsedBody) ||
    typeof parsedBody.signedPayload !== "string" ||
    !parsedBody.signedPayload.trim()
  ) {
    return NextResponse.json(
      { ok: false, error: "Missing signedPayload JWS." },
      { status: 400 }
    );
  }

  const outerVerified = verifyAppleSignedJws<AppleNotificationV2Payload>(
    parsedBody.signedPayload.trim(),
    { allowNonProdTestPin: true, allowStoreKitTestPin: true }
  );
  if (!outerVerified.ok || !outerVerified.claims) {
    return NextResponse.json(
      {
        ok: false,
        error: outerVerified.error || "Invalid Apple notification JWS signature.",
      },
      { status: 401 }
    );
  }

  const notification = outerVerified.claims;
  const notificationType = String(notification.notificationType || "")
    .trim()
    .toUpperCase();
  const subtype = String(notification.subtype || "")
    .trim()
    .toUpperCase();
  const notificationUUID = String(notification.notificationUUID || "").trim();

  if (!notificationType) {
    return NextResponse.json(
      { ok: false, error: "Missing notificationType in Apple V2 payload." },
      { status: 400 }
    );
  }

  const now = Date.now();
  if (typeof notification.signedDate === "number") {
    if (!Number.isFinite(notification.signedDate)) {
      return NextResponse.json(
        { ok: false, error: "Invalid signedDate claim." },
        { status: 401 }
      );
    }
    const signedMs =
      notification.signedDate > 1e9 && notification.signedDate < 1e11
        ? notification.signedDate * 1000
        : notification.signedDate;
    if (
      signedMs < now - MAX_NOTIFICATION_AGE_MS ||
      signedMs > now + MAX_FUTURE_SKEW_MS
    ) {
      return NextResponse.json(
        { ok: false, error: "Stale or future-dated Apple notification signedDate." },
        { status: 401 }
      );
    }
  }

  const expectedBundleId = (
    process.env.APPLE_BUNDLE_ID || "com.heybroc.app"
  ).trim();
  const data = notification.data;
  if (data?.bundleId && data.bundleId.trim() !== expectedBundleId) {
    return NextResponse.json(
      { ok: false, error: "App Store notification bundleId mismatch." },
      { status: 403 }
    );
  }

  const notifEnv = String(data?.environment || "").trim();
  if (
    process.env.NODE_ENV === "production" &&
    process.env.APPLE_ALLOW_SANDBOX_IN_PRODUCTION !== "true" &&
    (notifEnv === "Sandbox" || notifEnv === "Xcode")
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: "Sandbox App Store notifications are rejected in production.",
      },
      { status: 403 }
    );
  }

  if (notificationType === "TEST") {
    return NextResponse.json({
      ok: true,
      received: true,
      notificationType: "TEST",
    });
  }

  if (!data?.bundleId || data.bundleId.trim() !== expectedBundleId) {
    return NextResponse.json(
      { ok: false, error: "Missing or mismatched bundleId." },
      { status: 403 }
    );
  }

  if (notificationUUID) {
    const seen = await kvGet<string>(
      `heybroc:webhook:apple_v2:${notificationUUID}`
    ).catch(() => null);
    if (seen) {
      return NextResponse.json({
        ok: true,
        received: true,
        deduped: true,
        notificationType,
      });
    }
  }

  let txClaims: AppleTransactionClaims | undefined;
  if (typeof data.signedTransactionInfo === "string" && data.signedTransactionInfo.trim()) {
    const txVerified = verifyAppleSignedJws<AppleTransactionClaims>(
      data.signedTransactionInfo.trim(),
      { allowNonProdTestPin: true, allowStoreKitTestPin: true }
    );
    if (!txVerified.ok || !txVerified.claims) {
      return NextResponse.json(
        {
          ok: false,
          error:
            txVerified.error ||
            "Invalid signedTransactionInfo JWS inside Apple notification.",
        },
        { status: 401 }
      );
    }
    txClaims = txVerified.claims;
    if (txClaims.bundleId && txClaims.bundleId.trim() !== expectedBundleId) {
      return NextResponse.json(
        { ok: false, error: "Transaction bundleId mismatch." },
        { status: 403 }
      );
    }
    const txEnv = String(txClaims.environment || "").trim();
    if (
      process.env.NODE_ENV === "production" &&
      process.env.APPLE_ALLOW_SANDBOX_IN_PRODUCTION !== "true" &&
      (txEnv === "Sandbox" || txEnv === "Xcode")
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "Sandbox StoreKit transactions are rejected in production.",
        },
        { status: 403 }
      );
    }
  }

  let renewalClaims: AppleRenewalInfoClaims | undefined;
  if (typeof data.signedRenewalInfo === "string" && data.signedRenewalInfo.trim()) {
    const renVerified = verifyAppleSignedJws<AppleRenewalInfoClaims>(
      data.signedRenewalInfo.trim(),
      { allowNonProdTestPin: true, allowStoreKitTestPin: true }
    );
    if (!renVerified.ok || !renVerified.claims) {
      return NextResponse.json(
        {
          ok: false,
          error:
            renVerified.error ||
            "Invalid signedRenewalInfo JWS inside Apple notification.",
        },
        { status: 401 }
      );
    }
    renewalClaims = renVerified.claims;
  }

  const origTxId = String(
    txClaims?.originalTransactionId ||
      txClaims?.transactionId ||
      renewalClaims?.originalTransactionId ||
      ""
  ).trim();

  if (!origTxId) {
    if (notificationUUID) {
      await kvSet(
        `heybroc:webhook:apple_v2:${notificationUUID}`,
        "1",
        30 * 24 * 60 * 60
      );
    }
    return NextResponse.json({
      ok: true,
      received: true,
      ignored: true,
      notificationType,
    });
  }

  const txId = String(txClaims?.transactionId || origTxId).trim();
  const appleSubId = `apple_${origTxId}`;
  const existingApple = await getSubscriptionEntitlement(appleSubId).catch(
    () => null
  );
  const existingRc = !existingApple
    ? await getSubscriptionEntitlement(`rc_${origTxId}`).catch(() => null)
    : null;
  const existing = existingApple ?? existingRc;
  const targetSubId = existingApple ? appleSubId : existing?.subscriptionId || appleSubId;

  const plan = inferApplePlanFromProductId(
    txClaims?.productId || renewalClaims?.autoRenewProductId || renewalClaims?.productId,
    existing?.plan || "annual"
  );
  const isFreeTrial = txClaims ? isAppleTrialTransaction(txClaims) : false;
  const expiresAtMs =
    typeof txClaims?.expiresDate === "number" && Number.isFinite(txClaims.expiresDate)
      ? txClaims.expiresDate
      : existing?.expiresAtMs;

  const convMeta = await getCreatorConversionMeta(`apple_orig:${origTxId}`);
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

  const isBillingChargeNotification =
    notificationType === "SUBSCRIBED" ||
    notificationType === "DID_RENEW" ||
    notificationType === "OFFER_REDEEMED" ||
    (notificationType === "DID_CHANGE_RENEWAL_PRODUCT" && subtype === "UPGRADE");

  if (isBillingChargeNotification && txClaims) {
    const grossUsd = resolveAppleGrossUsd(txClaims, plan, isFreeTrial);
    const nextStatus: EntitlementStatus = isFreeTrial ? "trialing" : "active";
    const isActiveNow =
      typeof expiresAtMs === "number" ? expiresAtMs > now : true;

    await saveEntitlement({
      sessionId: existing?.sessionId || `apple_tx_${txId}`,
      subscriptionId: targetSubId,
      customerEmail: existing?.customerEmail,
      deviceId: existing?.deviceId,
      userId: existing?.userId,
      creatorCode: validCreatorCode,
      plan,
      status: isActiveNow ? nextStatus : "canceled",
      active: isActiveNow,
      expiresAtMs,
      lastChargeSucceeded:
        !isFreeTrial && grossUsd > 0
          ? true
          : existing?.lastChargeSucceeded ?? false,
      updatedAt: new Date(now).toISOString(),
    });

    if (validCreatorCode) {
      if (isFreeTrial) {
        await recordStripeCreatorConversionOnce(
          `apple_trial:${origTxId}`,
          validCreatorCode,
          "trial",
          undefined,
          existing?.customerEmail
        );
      } else if (grossUsd > 0) {
        await recordStripeCreatorConversionOnce(
          `apple_orig:${origTxId}`,
          validCreatorCode,
          plan === "monthly" ? "paid_monthly" : "paid_annual",
          grossUsd,
          existing?.customerEmail,
          {
            creditedTransactionId: txId,
            creditedEventId: notificationUUID || undefined,
            subscriptionKey: `apple_orig:${origTxId}`,
          }
        );
      }
    }
  } else if (notificationType === "REFUND" || notificationType === "REVOKE") {
    const revokedAtMs =
      typeof txClaims?.revocationDate === "number" && txClaims.revocationDate > 0
        ? txClaims.revocationDate
        : now;

    await updateSubscriptionEntitlement(targetSubId, {
      status: "canceled",
      plan,
      creatorCode: validCreatorCode,
      expiresAtMs: Math.min(expiresAtMs ?? now, revokedAtMs),
    });

    if (validCreatorCode && !isFreeTrial) {
      const effectivePlan = convMeta?.plan || plan;
      const refundGross = txClaims
        ? resolveAppleGrossUsd(txClaims, effectivePlan, false)
        : convMeta?.grossUsd || 0;
      const refundRatio =
        convMeta && convMeta.grossUsd > 0 && refundGross > 0
          ? Math.max(0, Math.min(1, refundGross / convMeta.grossUsd))
          : 1;

      await clawbackCreatorCommission(
        `apple_refund:${txId}`,
        validCreatorCode,
        effectivePlan,
        refundGross > 0 ? refundGross : undefined,
        refundRatio >= 0.99,
        {
          buyerEmail: existing?.customerEmail || convMeta?.buyerEmail,
          originalConversionKey: `apple_orig:${origTxId}`,
          fallbackConversionKeys: [`rc_orig:${origTxId}`],
          refundedTransactionId: txId,
          originalPreTaxUsd: convMeta?.grossUsd,
          refundRatio,
        }
      );
    }
  } else if (
    notificationType === "EXPIRED" ||
    notificationType === "GRACE_PERIOD_EXPIRED"
  ) {
    await updateSubscriptionEntitlement(targetSubId, {
      status: "canceled",
      plan,
      creatorCode: validCreatorCode,
      expiresAtMs,
    });
  } else if (notificationType === "DID_FAIL_TO_RENEW") {
    const graceExpiresMs =
      typeof renewalClaims?.gracePeriodExpiresDate === "number" &&
      renewalClaims.gracePeriodExpiresDate > now
        ? renewalClaims.gracePeriodExpiresDate
        : undefined;
    const inGrace = subtype === "GRACE_PERIOD" || Boolean(graceExpiresMs);
    await updateSubscriptionEntitlement(targetSubId, {
      status: inGrace ? "active" : "past_due",
      plan,
      creatorCode: validCreatorCode,
      expiresAtMs: graceExpiresMs ?? expiresAtMs,
    });
  }

  if (notificationUUID) {
    await kvSet(
      `heybroc:webhook:apple_v2:${notificationUUID}`,
      "1",
      30 * 24 * 60 * 60
    );
  }

  return NextResponse.json({
    ok: true,
    received: true,
    notificationType,
    ...(subtype ? { subtype } : {}),
    subscriptionId: targetSubId,
  });
}
