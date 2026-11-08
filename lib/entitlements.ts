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
  lastStripeEventCreated?: number;
  updatedAt: string;
}

const SESSION_KEY_PREFIX = "heybroc:entitlement:session:";
const SUB_KEY_PREFIX = "heybroc:entitlement:sub:";
const DEVICE_KEY_PREFIX = "heybroc:entitlement:device:";
const EMAIL_KEY_PREFIX = "heybroc:entitlement:email:";

/** Retain entitlement & billing records for 400 days (covers annual billing cycle + grace period). */
export const ENTITLEMENT_TTL_SECONDS = 400 * 24 * 60 * 60;

export function isValidStripeSessionIdFormat(sessionId: string): boolean {
  return /^cs_(test_|live_)?[A-Za-z0-9_]{16,128}$/.test(sessionId.trim());
}

export function isEntitlementStatusActive(status: string): boolean {
  return status === "active" || status === "trialing";
}

export async function saveEntitlement(record: EntitlementRecord): Promise<void> {
  const existingBySub = record.subscriptionId
    ? await getSubscriptionEntitlement(record.subscriptionId)
    : null;
  const existingBySession = await kvGet<EntitlementRecord>(
    `${SESSION_KEY_PREFIX}${record.sessionId}`
  );
  const existing = existingBySub ?? existingBySession;

  // Guard against out-of-order Stripe webhook events overwriting a newer subscription status
  if (
    existing?.lastStripeEventCreated &&
    record.lastStripeEventCreated &&
    record.lastStripeEventCreated < existing.lastStripeEventCreated
  ) {
    return;
  }

  const normalized: EntitlementRecord = {
    ...existing,
    ...record,
    deviceId: record.deviceId || existing?.deviceId,
    lastStripeEventCreated:
      record.lastStripeEventCreated ?? existing?.lastStripeEventCreated,
    active: isEntitlementStatusActive(record.status),
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
      await kvSet(`${EMAIL_KEY_PREFIX}${cleanEmail}`, normalized);
    }
  }
}

export async function getEmailEntitlement(
  email: string
): Promise<EntitlementRecord | null> {
  const cleanEmail = (email || "").trim().toLowerCase();
  if (!cleanEmail) return null;
  return kvGet<EntitlementRecord>(`${EMAIL_KEY_PREFIX}${cleanEmail}`);
}

export async function getSubscriptionEntitlement(
  subscriptionId: string
): Promise<EntitlementRecord | null> {
  if (!subscriptionId) return null;
  return kvGet<EntitlementRecord>(`${SUB_KEY_PREFIX}${subscriptionId}`);
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
  return rec;
}

export async function updateSubscriptionEntitlement(
  subscriptionId: string,
  patch: {
    status: EntitlementStatus;
    plan?: PlanId;
    customerId?: string;
    creatorCode?: string;
    deviceId?: string;
    lastStripeEventCreated?: number;
  }
): Promise<EntitlementRecord | null> {
  if (!subscriptionId) return null;
  const existing = await getSubscriptionEntitlement(subscriptionId);

  // Guard against older webhook events overwriting newer state
  if (
    existing?.lastStripeEventCreated &&
    patch.lastStripeEventCreated &&
    patch.lastStripeEventCreated < existing.lastStripeEventCreated
  ) {
    return existing;
  }

  const updated: EntitlementRecord = {
    sessionId: existing?.sessionId || `sub_${subscriptionId}`,
    subscriptionId,
    customerId: patch.customerId ?? existing?.customerId,
    customerEmail: existing?.customerEmail,
    deviceId: patch.deviceId ?? existing?.deviceId,
    plan: patch.plan ?? existing?.plan ?? "annual",
    creatorCode: patch.creatorCode ?? existing?.creatorCode,
    status: patch.status,
    active: isEntitlementStatusActive(patch.status),
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
  if (updated.deviceId) {
    await kvSet(
      `${DEVICE_KEY_PREFIX}${updated.deviceId}`,
      updated,
      ENTITLEMENT_TTL_SECONDS
    );
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
    return record;
  } catch {
    return null;
  }
}
