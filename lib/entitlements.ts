import "server-only";
import { kvGet, kvSet } from "./storage";
import type { PlanId } from "./pricing";

export type EntitlementStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

export interface EntitlementRecord {
  sessionId: string;
  subscriptionId?: string;
  customerId?: string;
  customerEmail?: string;
  deviceId?: string;
  plan: PlanId;
  creatorCode?: string;
  status: EntitlementStatus;
  active: boolean;
  expiresAtMs?: number;
  lastStripeEventCreated?: number;
  updatedAt: string;
}

const SESSION_KEY_PREFIX = "heybroc:entitlement:session:";
const SUB_KEY_PREFIX = "heybroc:entitlement:sub:";
const DEVICE_KEY_PREFIX = "heybroc:entitlement:device:";
const EMAIL_KEY_PREFIX = "heybroc:entitlement:email:";
const CUSTOMER_KEY_PREFIX = "heybroc:entitlement:customer:";
const CONSENT_KEY_PREFIX = "heybroc:consent:";

/** Retain entitlement & billing records for 400 days (covers annual billing cycle + grace period). */
export const ENTITLEMENT_TTL_SECONDS = 400 * 24 * 60 * 60;

/** Retain express auto-renewal consent logs for 5 years (Cal. Bus. & Prof. Code § 17602: >=3 years from consent or >=1 year after termination). */
export const CONSENT_TTL_SECONDS = 5 * 365 * 86400;

export interface SubscriptionConsentRecord {
  deviceId: string;
  email: string;
  plan: PlanId;
  termsVersion: string;
  timestamp: string;
  ip: string;
  sessionId?: string;
  customerId?: string;
  subscriptionId?: string;
}

export async function recordSubscriptionConsent(
  consent: SubscriptionConsentRecord
): Promise<void> {
  const cleanSessionId = (consent.sessionId || "").trim();
  const cleanEmail = (consent.email || "").trim().toLowerCase();
  const cleanCustomerId = (consent.customerId || "").trim();
  const idPart = (cleanSessionId || cleanEmail || consent.deviceId || "anon")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@._-]/g, "_");
  await kvSet(
    `${CONSENT_KEY_PREFIX}${idPart}:${Date.now()}`,
    consent,
    CONSENT_TTL_SECONDS
  );
  if (consent.deviceId) {
    await kvSet(
      `${CONSENT_KEY_PREFIX}latest:${consent.deviceId.trim()}`,
      consent,
      CONSENT_TTL_SECONDS
    );
  }
  if (cleanSessionId) {
    await kvSet(`consent:${cleanSessionId}`, consent, CONSENT_TTL_SECONDS);
    await kvSet(`${CONSENT_KEY_PREFIX}${cleanSessionId}`, consent, CONSENT_TTL_SECONDS);
  }
  if (cleanEmail) {
    await kvSet(`consent:email:${cleanEmail}`, consent, CONSENT_TTL_SECONDS);
    await kvSet(`${CONSENT_KEY_PREFIX}email:${cleanEmail}`, consent, CONSENT_TTL_SECONDS);
  }
  if (cleanCustomerId) {
    await kvSet(`consent:customer:${cleanCustomerId}`, consent, CONSENT_TTL_SECONDS);
    await kvSet(`${CONSENT_KEY_PREFIX}customer:${cleanCustomerId}`, consent, CONSENT_TTL_SECONDS);
  }
}

export async function refreshSubscriptionConsentOnRenewal(params: {
  sessionId?: string;
  customerId?: string;
  email?: string;
  deviceId?: string;
  subscriptionId?: string;
  plan?: PlanId;
}): Promise<void> {
  const cleanSessionId = (params.sessionId || "").trim();
  const cleanCustomerId = (params.customerId || "").trim();
  const cleanEmail = (params.email || "").trim().toLowerCase();
  const cleanDeviceId = (params.deviceId || "").trim();

  const existing =
    (cleanSessionId
      ? await kvGet<SubscriptionConsentRecord>(`consent:${cleanSessionId}`)
      : null) ??
    (cleanCustomerId
      ? await kvGet<SubscriptionConsentRecord>(`consent:customer:${cleanCustomerId}`)
      : null) ??
    (cleanEmail
      ? await kvGet<SubscriptionConsentRecord>(`consent:email:${cleanEmail}`)
      : null) ??
    (cleanDeviceId
      ? await kvGet<SubscriptionConsentRecord>(
          `${CONSENT_KEY_PREFIX}latest:${cleanDeviceId}`
        )
      : null);

  if (!existing) return;

  await recordSubscriptionConsent({
    ...existing,
    sessionId: cleanSessionId || existing.sessionId,
    customerId: cleanCustomerId || existing.customerId,
    subscriptionId: params.subscriptionId || existing.subscriptionId,
    email: cleanEmail || existing.email,
    deviceId: cleanDeviceId || existing.deviceId,
    plan: params.plan || existing.plan,
  });
}

export function isValidStripeSessionIdFormat(sessionId: string): boolean {
  return /^cs_(test_|live_)?[A-Za-z0-9_]{16,128}$/.test(sessionId.trim());
}

export function isEntitlementStatusActive(status: string): boolean {
  return status === "active" || status === "trialing";
}

function withCurrentExpiry(rec: EntitlementRecord | null): EntitlementRecord | null {
  if (!rec) return null;
  if (
    typeof rec.expiresAtMs === "number" &&
    Number.isFinite(rec.expiresAtMs) &&
    rec.expiresAtMs <= Date.now()
  ) {
    return {
      ...rec,
      status: "canceled",
      active: false,
    };
  }
  return {
    ...rec,
    active: isEntitlementStatusActive(rec.status),
  };
}

export async function saveEntitlement(record: EntitlementRecord): Promise<void> {
  const existingBySub = record.subscriptionId
    ? await kvGet<EntitlementRecord>(`${SUB_KEY_PREFIX}${record.subscriptionId}`)
    : null;
  const existingBySession = await kvGet<EntitlementRecord>(
    `${SESSION_KEY_PREFIX}${record.sessionId}`
  );
  const existing = existingBySub ?? existingBySession;

  // Guard against out-of-order webhook events or unversioned saves overwriting a newer webhook state
  if (existing?.lastStripeEventCreated) {
    if (
      !record.lastStripeEventCreated ||
      record.lastStripeEventCreated < existing.lastStripeEventCreated
    ) {
      return;
    }
  }

  const expiresAtMs = record.expiresAtMs ?? existing?.expiresAtMs;
  const isExpired =
    typeof expiresAtMs === "number" &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs <= Date.now();
  const effectiveStatus: EntitlementStatus = isExpired ? "canceled" : record.status;

  const normalized: EntitlementRecord = {
    ...existing,
    ...record,
    customerId: record.customerId || existing?.customerId,
    customerEmail: record.customerEmail || existing?.customerEmail,
    deviceId: record.deviceId || existing?.deviceId,
    expiresAtMs,
    lastStripeEventCreated:
      record.lastStripeEventCreated ?? existing?.lastStripeEventCreated,
    status: effectiveStatus,
    active: !isExpired && isEntitlementStatusActive(effectiveStatus),
    updatedAt: new Date().toISOString(),
  };

  await kvSet(
    `${SESSION_KEY_PREFIX}${normalized.sessionId}`,
    normalized,
    ENTITLEMENT_TTL_SECONDS
  );
  if (normalized.subscriptionId) {
    await kvSet(
      `${SUB_KEY_PREFIX}${normalized.subscriptionId}`,
      normalized,
      ENTITLEMENT_TTL_SECONDS
    );
  }
  if (normalized.customerId) {
    await kvSet(
      `${CUSTOMER_KEY_PREFIX}${normalized.customerId}`,
      normalized,
      ENTITLEMENT_TTL_SECONDS
    );
  }
  if (normalized.deviceId) {
    await kvSet(
      `${DEVICE_KEY_PREFIX}${normalized.deviceId}`,
      normalized,
      ENTITLEMENT_TTL_SECONDS
    );
  }
  if (normalized.customerEmail) {
    const cleanEmail = normalized.customerEmail.trim().toLowerCase();
    if (cleanEmail) {
      await kvSet(
        `${EMAIL_KEY_PREFIX}${cleanEmail}`,
        normalized,
        ENTITLEMENT_TTL_SECONDS
      );
    }
  }
}

export async function getCustomerEntitlement(
  customerId: string
): Promise<EntitlementRecord | null> {
  const cleanId = (customerId || "").trim();
  if (!cleanId) return null;
  const rec = await kvGet<EntitlementRecord>(`${CUSTOMER_KEY_PREFIX}${cleanId}`);
  if (!rec) return null;
  if (rec.subscriptionId) {
    const latestSub = await getSubscriptionEntitlement(rec.subscriptionId);
    if (latestSub) return latestSub;
  }
  return withCurrentExpiry(rec);
}

export async function getEmailEntitlement(
  email: string
): Promise<EntitlementRecord | null> {
  const cleanEmail = (email || "").trim().toLowerCase();
  if (!cleanEmail) return null;
  const rec = await kvGet<EntitlementRecord>(`${EMAIL_KEY_PREFIX}${cleanEmail}`);
  if (!rec) return null;
  if (rec.subscriptionId) {
    const latestSub = await getSubscriptionEntitlement(rec.subscriptionId);
    if (latestSub) return latestSub;
  }
  return withCurrentExpiry(rec);
}

export async function getSubscriptionEntitlement(
  subscriptionId: string
): Promise<EntitlementRecord | null> {
  if (!subscriptionId) return null;
  const rec = await kvGet<EntitlementRecord>(`${SUB_KEY_PREFIX}${subscriptionId}`);
  return withCurrentExpiry(rec);
}

export async function getDevicePaidEntitlement(
  deviceId: string
): Promise<EntitlementRecord | null> {
  if (!deviceId) return null;
  const rec = await kvGet<EntitlementRecord>(`${DEVICE_KEY_PREFIX}${deviceId}`);
  if (!rec) return null;
  if (rec.subscriptionId) {
    const latestSub = await getSubscriptionEntitlement(rec.subscriptionId);
    if (latestSub) return latestSub;
  }
  return withCurrentExpiry(rec);
}

export async function updateSubscriptionEntitlement(
  subscriptionId: string,
  patch: {
    status: EntitlementStatus;
    plan?: PlanId;
    customerId?: string;
    customerEmail?: string;
    creatorCode?: string;
    deviceId?: string;
    expiresAtMs?: number;
    lastStripeEventCreated?: number;
  }
): Promise<EntitlementRecord | null> {
  if (!subscriptionId) return null;
  const existing = await kvGet<EntitlementRecord>(
    `${SUB_KEY_PREFIX}${subscriptionId}`
  );

  // Guard against older webhook events overwriting newer state
  if (
    existing?.lastStripeEventCreated &&
    patch.lastStripeEventCreated &&
    patch.lastStripeEventCreated < existing.lastStripeEventCreated
  ) {
    return withCurrentExpiry(existing);
  }

  const expiresAtMs = patch.expiresAtMs ?? existing?.expiresAtMs;
  const isExpired =
    typeof expiresAtMs === "number" &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs <= Date.now();
  const effectiveStatus: EntitlementStatus = isExpired ? "canceled" : patch.status;

  const updated: EntitlementRecord = {
    sessionId: existing?.sessionId || `sub_${subscriptionId}`,
    subscriptionId,
    customerId: patch.customerId ?? existing?.customerId,
    customerEmail: patch.customerEmail ?? existing?.customerEmail,
    deviceId: patch.deviceId ?? existing?.deviceId,
    plan: patch.plan ?? existing?.plan ?? "annual",
    creatorCode: patch.creatorCode ?? existing?.creatorCode,
    status: effectiveStatus,
    active: !isExpired && isEntitlementStatusActive(effectiveStatus),
    expiresAtMs,
    lastStripeEventCreated:
      patch.lastStripeEventCreated ?? existing?.lastStripeEventCreated,
    updatedAt: new Date().toISOString(),
  };

  await kvSet(
    `${SUB_KEY_PREFIX}${subscriptionId}`,
    updated,
    ENTITLEMENT_TTL_SECONDS
  );
  if (existing?.sessionId) {
    await kvSet(
      `${SESSION_KEY_PREFIX}${existing.sessionId}`,
      updated,
      ENTITLEMENT_TTL_SECONDS
    );
  }
  if (updated.customerId) {
    await kvSet(
      `${CUSTOMER_KEY_PREFIX}${updated.customerId}`,
      updated,
      ENTITLEMENT_TTL_SECONDS
    );
  }
  if (updated.deviceId) {
    await kvSet(
      `${DEVICE_KEY_PREFIX}${updated.deviceId}`,
      updated,
      ENTITLEMENT_TTL_SECONDS
    );
  }
  if (updated.customerEmail) {
    const cleanEmail = updated.customerEmail.trim().toLowerCase();
    if (cleanEmail) {
      await kvSet(
        `${EMAIL_KEY_PREFIX}${cleanEmail}`,
        updated,
        ENTITLEMENT_TTL_SECONDS
      );
    }
  }
  return updated;
}

/**
 * Verifies a Stripe Checkout Session ID server-side against stored webhook entitlements
 * or directly against the Stripe Checkout Sessions API when STRIPE_SECRET_KEY is configured.
 * Binds `deviceId` on first claim so a leaked session_id URL cannot be replayed across devices.
 */
export async function verifyStripeCheckoutSession(
  rawSessionId: string,
  callerDeviceId?: string
): Promise<EntitlementRecord | null> {
  const sessionId = (rawSessionId || "").trim();
  if (!isValidStripeSessionIdFormat(sessionId)) {
    return null;
  }
  const cleanDeviceId = (callerDeviceId || "").trim();

  // 1. Check persistent store (populated by /api/stripe/webhook)
  const stored = await kvGet<EntitlementRecord>(
    `${SESSION_KEY_PREFIX}${sessionId}`
  );
  if (stored) {
    const effective = stored.subscriptionId
      ? (await getSubscriptionEntitlement(stored.subscriptionId)) ?? stored
      : stored;

    if (!effective.subscriptionId) {
      return null;
    }

    // Enforce device binding if both stored.deviceId and callerDeviceId exist
    if (
      effective.deviceId &&
      cleanDeviceId &&
      effective.deviceId !== cleanDeviceId
    ) {
      return null;
    }

    // Bind deviceId on first verification if not bound yet
    if (!effective.deviceId && cleanDeviceId) {
      effective.deviceId = cleanDeviceId;
      await saveEntitlement(effective);
    }

    return effective;
  }

  // 2. Fallback: verify directly with Stripe API if STRIPE_SECRET_KEY is configured
  const secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!secretKey) {
    return null;
  }

  try {
    const url = new URL(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`
    );
    url.searchParams.append("expand[]", "subscription");

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`,
      },
      cache: "no-store",
    });

    if (!res.ok) {
      return null;
    }

    const session = (await res.json()) as {
      id?: string;
      mode?: string;
      status?: string;
      payment_status?: string;
      client_reference_id?: string | null;
      customer?: string | { id?: string };
      customer_details?: { email?: string | null };
      metadata?: Record<string, string>;
      subscription?:
        | string
        | {
            id?: string;
            status?: string;
            metadata?: Record<string, string>;
          };
    };

    if (!session || session.id !== sessionId) return null;

    const isComplete = session.status === "complete";
    const isPaidOrTrial =
      session.payment_status === "paid" ||
      session.payment_status === "no_payment_required";
    if (!isComplete || !isPaidOrTrial) {
      return null;
    }

    const subObj =
      typeof session.subscription === "object" && session.subscription !== null
        ? session.subscription
        : null;
    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : subObj?.id;
    if (!subscriptionId) {
      return null;
    }

    const subStatus = (subObj?.status ||
      (session.payment_status === "no_payment_required"
        ? "trialing"
        : "active")) as EntitlementStatus;

    const rawPlan =
      session.metadata?.plan || subObj?.metadata?.plan || "annual";
    const plan: PlanId = rawPlan === "monthly" ? "monthly" : "annual";
    const creatorCode =
      session.metadata?.creator_code ||
      subObj?.metadata?.creator_code ||
      undefined;
    const sessionDeviceId =
      session.metadata?.device_id ||
      subObj?.metadata?.device_id ||
      session.client_reference_id ||
      undefined;

    if (
      sessionDeviceId &&
      cleanDeviceId &&
      sessionDeviceId !== cleanDeviceId
    ) {
      return null;
    }

    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id;

    const record: EntitlementRecord = {
      sessionId,
      subscriptionId,
      customerId,
      customerEmail: session.customer_details?.email || undefined,
      deviceId: sessionDeviceId || cleanDeviceId || undefined,
      plan,
      creatorCode,
      status: subStatus,
      active: isEntitlementStatusActive(subStatus),
      updatedAt: new Date().toISOString(),
    };

    await saveEntitlement(record);
    const targetDevice = sessionDeviceId || cleanDeviceId;
    if (
      record.active &&
      creatorCode &&
      /^BROC-[A-Z0-9]{4,10}$/.test(creatorCode) &&
      targetDevice &&
      targetDevice !== "anon-web"
    ) {
      try {
        const { applyOrActivateReferral } = await import("./referrals");
        await applyOrActivateReferral({
          deviceId: targetDevice,
          referralCode: creatorCode,
          activateNow: true,
        });
      } catch {
        /* ignore referral activation errors on fallback path */
      }
    }
    return record;
  } catch {
    return null;
  }
}

/**
 * Resolves a Stripe customer ID (`cus_...`) for the self-serve Stripe Billing Portal
 * only after verifying caller ownership via `authToken` (verified account session) or
 * `deviceId` + `deviceSecret` (HMAC-verified device credential).
 * Unauthenticated email-only or deviceId-only calls always return `null`.
 */
export async function resolveBillingPortalCustomer(params: {
  sessionId?: string;
  deviceId?: string;
  deviceSecret?: string;
  email?: string;
  authToken?: string;
}): Promise<{ customerId: string; record?: EntitlementRecord } | null> {
  const cleanSessionId = (params.sessionId || "").trim();
  const rawDeviceId = (params.deviceId || "").trim();
  const rawDeviceSecret = (params.deviceSecret || "").trim();
  const rawAuthToken = (params.authToken || "").trim();

  let verifiedEmail = "";
  let verifiedDeviceId = "";
  let hasVerifiedDeviceSecret = false;

  if (rawDeviceId && rawDeviceId !== "anon-web" && rawDeviceSecret) {
    const { getExistingDevice, verifyDeviceSecret } = await import("./referrals");
    const existingDevice = await getExistingDevice(rawDeviceId);
    if (
      existingDevice?.deviceSecretHash &&
      verifyDeviceSecret(existingDevice, rawDeviceSecret)
    ) {
      verifiedDeviceId = rawDeviceId;
      hasVerifiedDeviceSecret = true;
    }
  }

  if (rawAuthToken) {
    const { getAuthenticatedUser } = await import("./auth");
    const authUser = await getAuthenticatedUser(rawAuthToken);
    if (authUser && authUser.emailVerified === true) {
      if (authUser.email) {
        verifiedEmail = authUser.email.trim().toLowerCase();
      }
      if (!verifiedDeviceId) {
        const candidateLinked =
          rawDeviceId && authUser.linkedDevices?.includes(rawDeviceId)
            ? rawDeviceId
            : authUser.linkedDevices?.[0] || "";
        if (candidateLinked && candidateLinked !== "anon-web") {
          const { getExistingDevice } = await import("./referrals");
          const linkedDev = await getExistingDevice(candidateLinked);
          const linkedEnt = await getDevicePaidEntitlement(candidateLinked);
          const emailMatchesOrUnset =
            !linkedEnt?.customerEmail ||
            linkedEnt.customerEmail.trim().toLowerCase() === verifiedEmail;
          if (linkedDev?.deviceSecretHash && emailMatchesOrUnset) {
            verifiedDeviceId = candidateLinked;
          }
        }
      }
    }
  }

  // Never resolve a customer portal session without a verified device or verified account session
  if (!verifiedDeviceId && !verifiedEmail) {
    return null;
  }

  let record: EntitlementRecord | null = null;
  if (cleanSessionId && verifiedDeviceId) {
    record = await verifyStripeCheckoutSession(cleanSessionId, verifiedDeviceId);
  }
  if (!record && verifiedDeviceId) {
    record = await getDevicePaidEntitlement(verifiedDeviceId);
  }
  // Prevent cross-account device hijacking if a device entitlement is bound to a different customerEmail
  if (
    record &&
    record.customerEmail &&
    verifiedEmail &&
    record.customerEmail.trim().toLowerCase() !== verifiedEmail &&
    !hasVerifiedDeviceSecret
  ) {
    record = null;
  }
  if (!record && verifiedEmail) {
    record = await getEmailEntitlement(verifiedEmail);
  }

  if (record?.customerId) {
    return { customerId: record.customerId, record };
  }

  const secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!secretKey) {
    return null;
  }

  // If we have a subscriptionId on the record but customerId was not stored yet, fetch the subscription
  if (record?.subscriptionId) {
    try {
      const subRes = await fetch(
        `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(record.subscriptionId)}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${secretKey}` },
          cache: "no-store",
        }
      );
      if (subRes.ok) {
        const subData = (await subRes.json()) as {
          customer?: string | { id?: string };
        };
        const cid =
          typeof subData.customer === "string"
            ? subData.customer
            : subData.customer?.id;
        if (cid) {
          record.customerId = cid;
          await saveEntitlement(record);
          return { customerId: cid, record };
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Fallback: look up Stripe customer by verified email (or email stored on a verified device's entitlement)
  const lookupEmail = verifiedEmail || record?.customerEmail?.trim().toLowerCase();
  if (lookupEmail) {
    try {
      const cusUrl = new URL("https://api.stripe.com/v1/customers");
      cusUrl.searchParams.set("email", lookupEmail);
      cusUrl.searchParams.set("limit", "1");
      const cusRes = await fetch(cusUrl.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${secretKey}` },
        cache: "no-store",
      });
      if (cusRes.ok) {
        const cusData = (await cusRes.json()) as {
          data?: Array<{ id?: string }>;
        };
        const cid = cusData.data?.[0]?.id;
        if (cid) {
          return { customerId: cid, record: record ?? undefined };
        }
      }
    } catch {
      /* ignore */
    }
  }

  return null;
}
