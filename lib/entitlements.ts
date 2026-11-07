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
  plan: PlanId;
  creatorCode?: string;
  status: EntitlementStatus;
  active: boolean;
  updatedAt: string;
}

const SESSION_KEY_PREFIX = "heybroc:entitlement:session:";
const SUB_KEY_PREFIX = "heybroc:entitlement:sub:";

export function isValidStripeSessionIdFormat(sessionId: string): boolean {
  return /^cs_(test_|live_)?[A-Za-z0-9_]{16,128}$/.test(sessionId.trim());
}

export function isEntitlementStatusActive(status: string): boolean {
  return status === "active" || status === "trialing";
}

export async function saveEntitlement(record: EntitlementRecord): Promise<void> {
  const normalized: EntitlementRecord = {
    ...record,
    active: isEntitlementStatusActive(record.status),
    updatedAt: new Date().toISOString(),
  };
  await kvSet(`${SESSION_KEY_PREFIX}${normalized.sessionId}`, normalized);
  if (normalized.subscriptionId) {
    await kvSet(`${SUB_KEY_PREFIX}${normalized.subscriptionId}`, normalized);
  }
}

export async function getSubscriptionEntitlement(
  subscriptionId: string
): Promise<EntitlementRecord | null> {
  if (!subscriptionId) return null;
  return kvGet<EntitlementRecord>(`${SUB_KEY_PREFIX}${subscriptionId}`);
}

export async function updateSubscriptionEntitlement(
  subscriptionId: string,
  patch: {
    status: EntitlementStatus;
    plan?: PlanId;
    customerId?: string;
    creatorCode?: string;
  }
): Promise<EntitlementRecord | null> {
  if (!subscriptionId) return null;
  const existing = await getSubscriptionEntitlement(subscriptionId);
  const updated: EntitlementRecord = {
    sessionId: existing?.sessionId || `sub_${subscriptionId}`,
    subscriptionId,
    customerId: patch.customerId ?? existing?.customerId,
    customerEmail: existing?.customerEmail,
    plan: patch.plan ?? existing?.plan ?? "annual",
    creatorCode: patch.creatorCode ?? existing?.creatorCode,
    status: patch.status,
    active: isEntitlementStatusActive(patch.status),
    updatedAt: new Date().toISOString(),
  };
  await kvSet(`${SUB_KEY_PREFIX}${subscriptionId}`, updated);
  if (existing?.sessionId) {
    await kvSet(`${SESSION_KEY_PREFIX}${existing.sessionId}`, updated);
  }
  return updated;
}

/**
 * Verifies a Stripe Checkout Session ID server-side against stored webhook entitlements
 * or directly against the Stripe Checkout Sessions API when STRIPE_SECRET_KEY is configured.
 * Forged session IDs (e.g. cs_live_x) never pass validation.
 */
export async function verifyStripeCheckoutSession(
  rawSessionId: string
): Promise<EntitlementRecord | null> {
  const sessionId = (rawSessionId || "").trim();
  if (!isValidStripeSessionIdFormat(sessionId)) {
    return null;
  }

  // 1. Check persistent store (populated by /api/stripe/webhook)
  const stored = await kvGet<EntitlementRecord>(
    `${SESSION_KEY_PREFIX}${sessionId}`
  );
  if (stored) {
    if (stored.subscriptionId) {
      const subRecord = await getSubscriptionEntitlement(stored.subscriptionId);
      if (subRecord) return subRecord;
    }
    return stored;
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
      status?: string;
      payment_status?: string;
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
    const subStatus = (subObj?.status || "active") as EntitlementStatus;

    const rawPlan =
      session.metadata?.plan || subObj?.metadata?.plan || "annual";
    const plan: PlanId = rawPlan === "monthly" ? "monthly" : "annual";
    const creatorCode =
      session.metadata?.creator_code ||
      subObj?.metadata?.creator_code ||
      undefined;
    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id;

    const record: EntitlementRecord = {
      sessionId,
      subscriptionId,
      customerId,
      customerEmail: session.customer_details?.email || undefined,
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
