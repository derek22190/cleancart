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
  paidPassExpiresAtMs?: number;
  otoPassSessionIds?: string[];
  lastStripeEventCreated?: number;
  updatedAt: string;
}

const SESSION_KEY_PREFIX = "heybroc:entitlement:session:";
const SUB_KEY_PREFIX = "heybroc:entitlement:sub:";
const DEVICE_KEY_PREFIX = "heybroc:entitlement:device:";
const EMAIL_KEY_PREFIX = "heybroc:entitlement:email:";
const CUSTOMER_KEY_PREFIX = "heybroc:entitlement:customer:";
const CONSENT_KEY_PREFIX = "heybroc:consent:";

/** Retain entitlement & billing records for 800 days (covers multi-year stacked passes + annual renewal grace period). */
export const ENTITLEMENT_TTL_SECONDS = 800 * 24 * 60 * 60;

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
  otoOffer?: string;
  recurringPriceUsd?: number;
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

function mergePassMetadata(
  primary: EntitlementRecord,
  secondary?: EntitlementRecord | null
): EntitlementRecord {
  if (!secondary) return primary;
  const maxPassMs = Math.max(
    typeof primary.paidPassExpiresAtMs === "number" ? primary.paidPassExpiresAtMs : 0,
    typeof secondary.paidPassExpiresAtMs === "number" ? secondary.paidPassExpiresAtMs : 0
  );
  const mergedSessions = Array.from(
    new Set([...(secondary.otoPassSessionIds || []), ...(primary.otoPassSessionIds || [])])
  );
  return {
    ...primary,
    ...(maxPassMs > 0 ? { paidPassExpiresAtMs: maxPassMs } : {}),
    ...(mergedSessions.length > 0 ? { otoPassSessionIds: mergedSessions } : {}),
  };
}

function withCurrentExpiry(rec: EntitlementRecord | null): EntitlementRecord | null {
  if (!rec) return null;
  const now = Date.now();
  const hasActivePaidPass =
    typeof rec.paidPassExpiresAtMs === "number" &&
    Number.isFinite(rec.paidPassExpiresAtMs) &&
    rec.paidPassExpiresAtMs > now;
  const isSubExpired =
    typeof rec.expiresAtMs === "number" &&
    Number.isFinite(rec.expiresAtMs) &&
    rec.expiresAtMs <= now;
  const hasStandalonePassSubId = Boolean(
    rec.subscriptionId && rec.subscriptionId.startsWith("oto_pass_")
  );
  const subActive =
    !hasStandalonePassSubId &&
    !isSubExpired &&
    isEntitlementStatusActive(rec.status);

  if (subActive || hasActivePaidPass) {
    return {
      ...rec,
      status: subActive ? rec.status : "active",
      active: true,
    };
  }
  return {
    ...rec,
    status: isSubExpired || hasStandalonePassSubId ? "canceled" : rec.status,
    active: false,
  };
}

async function writeSecondaryLookupKey(
  key: string,
  candidate: EntitlementRecord
): Promise<void> {
  const existingLookup = await kvGet<EntitlementRecord>(key);
  if (existingLookup) {
    if (!candidate.active) {
      // Never allow a canceled older subscription to overwrite a different active subscription on the same customer/device/email
      if (
        existingLookup.subscriptionId &&
        existingLookup.subscriptionId !== candidate.subscriptionId
      ) {
        const otherSub = existingLookup.subscriptionId.startsWith("sub_")
          ? await getSubscriptionEntitlement(existingLookup.subscriptionId)
          : withCurrentExpiry(existingLookup);
        if (otherSub?.active) {
          return;
        }
      }
    }
    const merged = withCurrentExpiry(mergePassMetadata(candidate, existingLookup));
    if (merged) {
      await kvSet(key, merged, ENTITLEMENT_TTL_SECONDS);
    }
    return;
  }
  await kvSet(key, candidate, ENTITLEMENT_TTL_SECONDS);
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
  const paidPassExpiresAtMs =
    record.paidPassExpiresAtMs ?? existing?.paidPassExpiresAtMs;
  const otoPassSessionIds =
    record.otoPassSessionIds ?? existing?.otoPassSessionIds;
  const isExpired =
    typeof expiresAtMs === "number" &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs <= Date.now();
  const effectiveStatus: EntitlementStatus = isExpired ? "canceled" : record.status;

  const baseNormalized: EntitlementRecord = {
    ...existing,
    ...record,
    customerId: record.customerId || existing?.customerId,
    customerEmail: record.customerEmail || existing?.customerEmail,
    deviceId: record.deviceId || existing?.deviceId,
    expiresAtMs,
    paidPassExpiresAtMs,
    otoPassSessionIds,
    lastStripeEventCreated:
      record.lastStripeEventCreated ?? existing?.lastStripeEventCreated,
    status: effectiveStatus,
    active: !isExpired && isEntitlementStatusActive(effectiveStatus),
    updatedAt: new Date().toISOString(),
  };
  const normalized = withCurrentExpiry(baseNormalized)!;

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
    await writeSecondaryLookupKey(
      `${CUSTOMER_KEY_PREFIX}${normalized.customerId}`,
      normalized
    );
  }
  if (normalized.deviceId) {
    await writeSecondaryLookupKey(
      `${DEVICE_KEY_PREFIX}${normalized.deviceId}`,
      normalized
    );
  }
  if (normalized.customerEmail) {
    const cleanEmail = normalized.customerEmail.trim().toLowerCase();
    if (cleanEmail) {
      await writeSecondaryLookupKey(
        `${EMAIL_KEY_PREFIX}${cleanEmail}`,
        normalized
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
  if (rec.subscriptionId && rec.subscriptionId.startsWith("sub_")) {
    const latestSub = await getSubscriptionEntitlement(rec.subscriptionId);
    if (latestSub) return withCurrentExpiry(mergePassMetadata(latestSub, rec));
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
  if (rec.subscriptionId && rec.subscriptionId.startsWith("sub_")) {
    const latestSub = await getSubscriptionEntitlement(rec.subscriptionId);
    if (latestSub) return withCurrentExpiry(mergePassMetadata(latestSub, rec));
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
  if (rec.subscriptionId && rec.subscriptionId.startsWith("sub_")) {
    const latestSub = await getSubscriptionEntitlement(rec.subscriptionId);
    if (latestSub) return withCurrentExpiry(mergePassMetadata(latestSub, rec));
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
    paidPassExpiresAtMs?: number;
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
  const paidPassExpiresAtMs =
    patch.paidPassExpiresAtMs ?? existing?.paidPassExpiresAtMs;
  const isExpired =
    typeof expiresAtMs === "number" &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs <= Date.now();
  const effectiveStatus: EntitlementStatus = isExpired ? "canceled" : patch.status;

  const baseUpdated: EntitlementRecord = {
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
    paidPassExpiresAtMs,
    otoPassSessionIds: existing?.otoPassSessionIds,
    lastStripeEventCreated:
      patch.lastStripeEventCreated ?? existing?.lastStripeEventCreated,
    updatedAt: new Date().toISOString(),
  };
  const updated = withCurrentExpiry(baseUpdated)!;

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
    await writeSecondaryLookupKey(
      `${CUSTOMER_KEY_PREFIX}${updated.customerId}`,
      updated
    );
  }
  if (updated.deviceId) {
    await writeSecondaryLookupKey(
      `${DEVICE_KEY_PREFIX}${updated.deviceId}`,
      updated
    );
  }
  if (updated.customerEmail) {
    const cleanEmail = updated.customerEmail.trim().toLowerCase();
    if (cleanEmail) {
      await writeSecondaryLookupKey(
        `${EMAIL_KEY_PREFIX}${cleanEmail}`,
        updated
      );
    }
  }
  return updated;
}

/**
 * Idempotently applies a one-time +366-day Family Pro pass (`oto_gift_year`) without
 * overwriting any active Stripe `sub_...` subscription or customer portal link.
 */
export async function applyOneTimeAnnualPass(params: {
  sessionId: string;
  customerId?: string;
  customerEmail?: string;
  deviceId?: string;
  creatorCode?: string;
  lastStripeEventCreated?: number;
}): Promise<EntitlementRecord> {
  const cleanSessionId = params.sessionId.trim();
  const cleanCustomerId = (params.customerId || "").trim();
  const cleanEmail = (params.customerEmail || "").trim().toLowerCase();
  const cleanDeviceId = (params.deviceId || "").trim();

  const existingBySession = await kvGet<EntitlementRecord>(
    `${SESSION_KEY_PREFIX}${cleanSessionId}`
  );
  if (existingBySession?.otoPassSessionIds?.includes(cleanSessionId)) {
    return withCurrentExpiry(existingBySession)!;
  }

  const existing =
    (cleanCustomerId ? await getCustomerEntitlement(cleanCustomerId) : null) ??
    (cleanDeviceId ? await getDevicePaidEntitlement(cleanDeviceId) : null) ??
    (cleanEmail ? await getEmailEntitlement(cleanEmail) : null);

  if (existing?.otoPassSessionIds?.includes(cleanSessionId)) {
    await kvSet(
      `${SESSION_KEY_PREFIX}${cleanSessionId}`,
      existing,
      ENTITLEMENT_TTL_SECONDS
    );
    return withCurrentExpiry(existing)!;
  }

  const now = Date.now();
  const hasRealSub = Boolean(
    existing?.subscriptionId && existing.subscriptionId.startsWith("sub_")
  );
  let baseMs = now;
  if (existing?.paidPassExpiresAtMs && existing.paidPassExpiresAtMs > now) {
    baseMs = existing.paidPassExpiresAtMs;
  } else if (existing?.expiresAtMs && existing.expiresAtMs > now) {
    baseMs = existing.expiresAtMs;
  } else if (hasRealSub && existing?.status === "active") {
    baseMs = now + 365 * 86_400_000;
  } else if (hasRealSub && existing?.status === "trialing") {
    baseMs = now + 7 * 86_400_000;
  }
  const paidPassExpiresAtMs = baseMs + 366 * 86_400_000;
  const otoPassSessionIds = Array.from(
    new Set([...(existing?.otoPassSessionIds || []), cleanSessionId])
  );

  const preservedSubId = hasRealSub
    ? existing!.subscriptionId
    : `oto_pass_${cleanSessionId}`;
  const preservedStatus: EntitlementStatus =
    hasRealSub && isEntitlementStatusActive(existing!.status)
      ? existing!.status
      : "active";

  const merged: EntitlementRecord = withCurrentExpiry({
    sessionId: existing?.sessionId || cleanSessionId,
    subscriptionId: preservedSubId,
    customerId: cleanCustomerId || existing?.customerId || undefined,
    customerEmail: cleanEmail || existing?.customerEmail || undefined,
    deviceId: cleanDeviceId || existing?.deviceId || undefined,
    plan: "annual",
    creatorCode: params.creatorCode || existing?.creatorCode,
    status: preservedStatus,
    active: true,
    expiresAtMs: existing?.expiresAtMs,
    paidPassExpiresAtMs,
    otoPassSessionIds,
    lastStripeEventCreated:
      params.lastStripeEventCreated ?? existing?.lastStripeEventCreated,
    updatedAt: new Date().toISOString(),
  })!;

  // Store under BOTH the OTO checkout sessionId and the preserved subscription/device/customer/email keys
  const sessionRecord: EntitlementRecord = {
    ...merged,
    sessionId: cleanSessionId,
  };
  await kvSet(
    `${SESSION_KEY_PREFIX}${cleanSessionId}`,
    sessionRecord,
    ENTITLEMENT_TTL_SECONDS
  );
  if (existing?.sessionId && existing.sessionId !== cleanSessionId) {
    await kvSet(
      `${SESSION_KEY_PREFIX}${existing.sessionId}`,
      merged,
      ENTITLEMENT_TTL_SECONDS
    );
  }
  if (merged.subscriptionId) {
    await kvSet(
      `${SUB_KEY_PREFIX}${merged.subscriptionId}`,
      merged,
      ENTITLEMENT_TTL_SECONDS
    );
  }
  if (merged.customerId) {
    await kvSet(
      `${CUSTOMER_KEY_PREFIX}${merged.customerId}`,
      merged,
      ENTITLEMENT_TTL_SECONDS
    );
  }
  if (merged.deviceId) {
    await kvSet(
      `${DEVICE_KEY_PREFIX}${merged.deviceId}`,
      merged,
      ENTITLEMENT_TTL_SECONDS
    );
  }
  if (merged.customerEmail) {
    const normEmail = merged.customerEmail.trim().toLowerCase();
    if (normEmail) {
      await kvSet(
        `${EMAIL_KEY_PREFIX}${normEmail}`,
        merged,
        ENTITLEMENT_TTL_SECONDS
      );
    }
  }
  return sessionRecord;
}

/**
 * Revokes a refunded/disputed one-time +366-day pass (`oto_gift_year`) while keeping
 * any active recurring `sub_...` subscription intact.
 */
export async function revokeOneTimeAnnualPass(params: {
  sessionId?: string;
  customerId?: string;
  deviceId?: string;
  customerEmail?: string;
}): Promise<void> {
  const cleanSessionId = (params.sessionId || "").trim();
  const cleanCustomerId = (params.customerId || "").trim();
  const cleanDeviceId = (params.deviceId || "").trim();
  const cleanEmail = (params.customerEmail || "").trim().toLowerCase();

  const existing =
    (cleanSessionId
      ? await kvGet<EntitlementRecord>(`${SESSION_KEY_PREFIX}${cleanSessionId}`)
      : null) ??
    (cleanCustomerId
      ? await kvGet<EntitlementRecord>(`${CUSTOMER_KEY_PREFIX}${cleanCustomerId}`)
      : null) ??
    (cleanDeviceId
      ? await kvGet<EntitlementRecord>(`${DEVICE_KEY_PREFIX}${cleanDeviceId}`)
      : null) ??
    (cleanEmail
      ? await kvGet<EntitlementRecord>(`${EMAIL_KEY_PREFIX}${cleanEmail}`)
      : null);

  if (!existing) return;

  const now = Date.now();
  const nextSessions = (existing.otoPassSessionIds || []).filter(
    (s) => s !== cleanSessionId
  );
  const currentPassMs = existing.paidPassExpiresAtMs ?? 0;
  const reducedPassMs =
    currentPassMs > 0 ? currentPassMs - 366 * 86_400_000 : 0;
  const subExpiryFloor =
    typeof existing.expiresAtMs === "number" && existing.expiresAtMs > now
      ? existing.expiresAtMs
      : now;
  const nextPassMs =
    nextSessions.length > 0 && reducedPassMs > subExpiryFloor
      ? reducedPassMs
      : !existing.otoPassSessionIds && reducedPassMs > subExpiryFloor
        ? reducedPassMs
        : undefined;

  const hasRealSub = Boolean(
    existing.subscriptionId && existing.subscriptionId.startsWith("sub_")
  );
  const subRecord = hasRealSub
    ? await kvGet<EntitlementRecord>(`${SUB_KEY_PREFIX}${existing.subscriptionId!}`)
    : null;
  const baseStatus: EntitlementStatus = hasRealSub
    ? subRecord?.status ?? existing.status
    : nextPassMs
      ? "active"
      : "canceled";

  const updated = withCurrentExpiry({
    ...existing,
    ...(subRecord ? { status: baseStatus } : { status: baseStatus }),
    paidPassExpiresAtMs: nextPassMs,
    otoPassSessionIds: nextSessions.length > 0 ? nextSessions : undefined,
    updatedAt: new Date().toISOString(),
  })!;

  if (cleanSessionId) {
    await kvSet(
      `${SESSION_KEY_PREFIX}${cleanSessionId}`,
      hasRealSub
        ? updated
        : { ...updated, status: nextPassMs ? "active" : "canceled", active: Boolean(nextPassMs) },
      ENTITLEMENT_TTL_SECONDS
    );
  }
  if (existing.subscriptionId) {
    await kvSet(
      `${SUB_KEY_PREFIX}${existing.subscriptionId}`,
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
    const normEmail = updated.customerEmail.trim().toLowerCase();
    if (normEmail) {
      await kvSet(
        `${EMAIL_KEY_PREFIX}${normEmail}`,
        updated,
        ENTITLEMENT_TTL_SECONDS
      );
    }
  }
}

export async function hasPriorEntitlementHistory(params: {
  deviceId?: string;
  email?: string;
}): Promise<EntitlementRecord | null> {
  const cleanDevice = (params.deviceId || "").trim();
  const cleanEmail = (params.email || "").trim().toLowerCase();
  if (cleanDevice && cleanDevice !== "anon-web") {
    const rawDev = await kvGet<EntitlementRecord>(
      `${DEVICE_KEY_PREFIX}${cleanDevice}`
    );
    if (rawDev && (rawDev.status === "active" || rawDev.status === "trialing" || rawDev.status === "canceled" || rawDev.status === "past_due")) {
      return rawDev;
    }
  }
  if (cleanEmail) {
    const rawEmail = await kvGet<EntitlementRecord>(
      `${EMAIL_KEY_PREFIX}${cleanEmail}`
    );
    if (rawEmail && (rawEmail.status === "active" || rawEmail.status === "trialing" || rawEmail.status === "canceled" || rawEmail.status === "past_due")) {
      return rawEmail;
    }
  }
  return null;
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
    const rawEffective =
      stored.subscriptionId && stored.subscriptionId.startsWith("sub_")
        ? mergePassMetadata(
            (await getSubscriptionEntitlement(stored.subscriptionId)) ?? stored,
            stored
          )
        : stored;
    const effective = withCurrentExpiry(rawEffective);

    if (!effective || (!effective.subscriptionId && !effective.paidPassExpiresAtMs)) {
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
            trial_end?: number | null;
            current_period_end?: number | null;
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
    const isOneTimeOtoPass =
      session.mode === "payment" &&
      session.metadata?.oto_offer === "oto_gift_year";
    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : subObj?.id || (isOneTimeOtoPass ? `oto_pass_${sessionId}` : undefined);
    if (!subscriptionId) {
      return null;
    }

    const subStatus = (subObj?.status ||
      (isOneTimeOtoPass
        ? "active"
        : session.payment_status === "no_payment_required"
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

    let record: EntitlementRecord;
    if (isOneTimeOtoPass) {
      record = await applyOneTimeAnnualPass({
        sessionId,
        customerId,
        customerEmail: session.customer_details?.email || undefined,
        deviceId: sessionDeviceId || cleanDeviceId || undefined,
        creatorCode,
      });
    } else {
      const computedExpiresAtMs =
        subStatus === "trialing" && typeof subObj?.trial_end === "number"
          ? subObj.trial_end * 1000
          : typeof subObj?.current_period_end === "number"
            ? subObj.current_period_end * 1000
            : undefined;
      record = {
        sessionId,
        subscriptionId,
        customerId,
        customerEmail: session.customer_details?.email || undefined,
        deviceId: sessionDeviceId || cleanDeviceId || undefined,
        plan,
        creatorCode,
        status: subStatus,
        active: isEntitlementStatusActive(subStatus),
        ...(computedExpiresAtMs ? { expiresAtMs: computedExpiresAtMs } : {}),
        updatedAt: new Date().toISOString(),
      };
      await saveEntitlement(record);
    }

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

  // If we have a real Stripe subscriptionId (`sub_...`) on the record but customerId was not stored yet, fetch the subscription
  if (record?.subscriptionId && record.subscriptionId.startsWith("sub_")) {
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
