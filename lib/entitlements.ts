import "server-only";
import { kvDel, kvGet, kvSet } from "./storage";
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
  checkoutSessionId?: string;
  subscriptionId?: string;
  customerId?: string;
  customerEmail?: string;
  deviceId?: string;
  userId?: string;
  plan: PlanId;
  creatorCode?: string;
  status: EntitlementStatus;
  active: boolean;
  expiresAtMs?: number;
  paidPassExpiresAtMs?: number;
  otoPassSessionIds?: string[];
  revokedOtoPassSessionIds?: string[];
  passRevokedAtMs?: number;
  lastChargeSucceeded?: boolean;
  pausedUntilMs?: number;
  lastRetentionPauseAtMs?: number;
  lastRetentionOfferAtMs?: number;
  lastStripeEventCreated?: number;
  updatedAt: string;
}

/** 180-day cooldown between cancel-screen pauses or loyalty plan upgrades to prevent repeat gaming. */
export const RETENTION_COOLDOWN_MS = 180 * 24 * 60 * 60 * 1000;

export interface ZeroLeakageRetentionEligibility {
  hasManagedStripeSub: boolean;
  isTrialing: boolean;
  hasPaidCharge: boolean;
  isCurrentlyPaused: boolean;
  pausedUntilMs?: number;
  canPause30d: boolean;
  /** Strictly true ONLY for paid Monthly subscribers (`status === "active"` && `lastChargeSucceeded === true`, $9.99 + $39.99 = $49.98 total). */
  canLoyaltyAnnual39: boolean;
  /** Standard $49.99/yr plan switch for trialing Monthly users ($0 discount leakage). */
  canStandardAnnual49: boolean;
  /** Flexible $9.99/mo plan switch for Annual subscribers or trialers. */
  canSwitchToMonthly: boolean;
}

export function evaluateZeroLeakageRetentionEligibility(
  record: EntitlementRecord | null | undefined,
  nowMs: number = Date.now()
): ZeroLeakageRetentionEligibility {
  if (!record || !record.active) {
    return {
      hasManagedStripeSub: false,
      isTrialing: false,
      hasPaidCharge: false,
      isCurrentlyPaused: false,
      canPause30d: false,
      canLoyaltyAnnual39: false,
      canStandardAnnual49: false,
      canSwitchToMonthly: false,
    };
  }
  const hasManagedStripeSub = Boolean(
    record.subscriptionId && record.subscriptionId.startsWith("sub_")
  );
  const isTrialing = record.status === "trialing";
  const hasPaidCharge =
    record.status === "active" && record.lastChargeSucceeded === true;
  const isCurrentlyPaused = Boolean(
    typeof record.pausedUntilMs === "number" && record.pausedUntilMs > nowMs
  );
  const pauseCooldownClear =
    !record.lastRetentionPauseAtMs ||
    nowMs - record.lastRetentionPauseAtMs >= RETENTION_COOLDOWN_MS;
  const offerCooldownClear =
    !record.lastRetentionOfferAtMs ||
    nowMs - record.lastRetentionOfferAtMs >= RETENTION_COOLDOWN_MS;

  return {
    hasManagedStripeSub,
    isTrialing,
    hasPaidCharge,
    isCurrentlyPaused,
    ...(isCurrentlyPaused ? { pausedUntilMs: record.pausedUntilMs } : {}),
    canPause30d:
      hasManagedStripeSub &&
      record.plan === "monthly" &&
      hasPaidCharge &&
      !isCurrentlyPaused &&
      pauseCooldownClear,
    canLoyaltyAnnual39:
      record.plan === "monthly" &&
      hasPaidCharge &&
      offerCooldownClear,
    canStandardAnnual49:
      record.plan === "monthly" && (!hasPaidCharge || isTrialing),
    canSwitchToMonthly: hasManagedStripeSub && record.plan === "annual",
  };
}

const SESSION_KEY_PREFIX = "heybroc:entitlement:session:";
const NEG_SESSION_KEY_PREFIX = "heybroc:entitlement:neg_session:";
const SUB_KEY_PREFIX = "heybroc:entitlement:sub:";
const DEVICE_KEY_PREFIX = "heybroc:entitlement:device:";
const EMAIL_KEY_PREFIX = "heybroc:entitlement:email:";
const CUSTOMER_KEY_PREFIX = "heybroc:entitlement:customer:";
const CONSENT_KEY_PREFIX = "heybroc:consent:";

const PLACEHOLDER_DEVICE_IDS = new Set([
  "anon-web",
  "anon",
  "anonymous",
  "unknown",
  "undefined",
  "null",
  "guest",
  "default",
  "none",
]);

/**
 * Normalizes a real client/user device identifier and rejects shared/placeholder buckets
 * (`"anon-web"`, `"anon"`, `"unknown"`, `"undefined"`, `"null"`, `"guest"`, `"default"`, `<6` chars).
 */
export function normalizeRealDeviceId(raw?: string | null): string {
  if (typeof raw !== "string") return "";
  const clean = raw.trim().slice(0, 128);
  if (clean.length < 6) return "";
  if (PLACEHOLDER_DEVICE_IDS.has(clean.toLowerCase())) return "";
  return clean;
}

/**
 * Returns true when `subId` represents a managed recurring subscription (`sub_...` on Stripe, `rc_...` on RevenueCat, or `apple_...` on StoreKit 2).
 */
export function isManagedSubscriptionId(subId?: string | null): boolean {
  if (typeof subId !== "string") return false;
  const clean = subId.trim();
  return clean.startsWith("sub_") || clean.startsWith("rc_") || clean.startsWith("apple_");
}

const MAX_NEGATIVE_SESSION_CACHE = 2000;
const negativeSessionMemCache = new Map<string, number>();

export async function isSessionNegativelyCached(sessionId: string): Promise<boolean> {
  const clean = (sessionId || "").trim();
  if (!clean) return false;
  const now = Date.now();
  const memExp = negativeSessionMemCache.get(clean);
  if (memExp !== undefined) {
    if (memExp > now) return true;
    negativeSessionMemCache.delete(clean);
  }
  const kvCached = await kvGet<number>(`${NEG_SESSION_KEY_PREFIX}${clean}`).catch(() => null);
  if (typeof kvCached === "number" && kvCached > now) {
    negativeSessionMemCache.set(clean, kvCached);
    return true;
  }
  return false;
}

export async function cacheNegativeSessionLookup(
  sessionId: string,
  ttlSeconds = 30
): Promise<void> {
  const clean = (sessionId || "").trim();
  if (!clean || ttlSeconds <= 0) return;
  const expiresAt = Date.now() + ttlSeconds * 1000;
  if (
    negativeSessionMemCache.size >= MAX_NEGATIVE_SESSION_CACHE &&
    !negativeSessionMemCache.has(clean)
  ) {
    const oldest = negativeSessionMemCache.keys().next().value;
    if (oldest !== undefined) negativeSessionMemCache.delete(oldest);
  }
  negativeSessionMemCache.set(clean, expiresAt);
  await kvSet(`${NEG_SESSION_KEY_PREFIX}${clean}`, expiresAt, ttlSeconds).catch(() => {});
}

export async function clearNegativeSessionCache(sessionId: string): Promise<void> {
  const clean = (sessionId || "").trim();
  if (!clean) return;
  negativeSessionMemCache.delete(clean);
  await kvDel(`${NEG_SESSION_KEY_PREFIX}${clean}`).catch(() => {});
}

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
  auditKey?: string;
}

export async function recordSubscriptionConsent(
  consent: SubscriptionConsentRecord
): Promise<void> {
  const cleanSessionId = (consent.sessionId || "").trim();
  const cleanEmail = (consent.email || "").trim().toLowerCase();
  const cleanCustomerId = (consent.customerId || "").trim();
  const cleanDeviceId = normalizeRealDeviceId(consent.deviceId);
  const idPart = (cleanSessionId || cleanCustomerId || cleanDeviceId || "session")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_");
  const auditKey = `${CONSENT_KEY_PREFIX}${idPart}:${Date.now()}`;
  const storedConsent: SubscriptionConsentRecord = {
    ...consent,
    auditKey,
  };
  await kvSet(auditKey, storedConsent, CONSENT_TTL_SECONDS);
  if (cleanDeviceId) {
    await kvSet(
      `${CONSENT_KEY_PREFIX}latest:${cleanDeviceId}`,
      storedConsent,
      CONSENT_TTL_SECONDS
    );
  }
  if (cleanSessionId) {
    await kvSet(`consent:${cleanSessionId}`, storedConsent, CONSENT_TTL_SECONDS);
    await kvSet(
      `${CONSENT_KEY_PREFIX}${cleanSessionId}`,
      storedConsent,
      CONSENT_TTL_SECONDS
    );
  }
  if (cleanEmail && cleanEmail !== "[redacted]") {
    await kvSet(`consent:email:${cleanEmail}`, storedConsent, CONSENT_TTL_SECONDS);
    await kvSet(
      `${CONSENT_KEY_PREFIX}email:${cleanEmail}`,
      storedConsent,
      CONSENT_TTL_SECONDS
    );
  }
  if (cleanCustomerId && cleanCustomerId.startsWith("cus_")) {
    await kvSet(
      `consent:customer:${cleanCustomerId}`,
      storedConsent,
      CONSENT_TTL_SECONDS
    );
    await kvSet(
      `${CONSENT_KEY_PREFIX}customer:${cleanCustomerId}`,
      storedConsent,
      CONSENT_TTL_SECONDS
    );
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
  const rawCust = (params.customerId || "").trim();
  const cleanCustomerId = rawCust.startsWith("cus_") ? rawCust : "";
  const cleanEmail = (params.email || "").trim().toLowerCase();
  const cleanDeviceId = normalizeRealDeviceId(params.deviceId);

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

function recordVersionTimestampMs(rec: EntitlementRecord): number {
  if (typeof rec.lastStripeEventCreated === "number" && rec.lastStripeEventCreated > 0) {
    return rec.lastStripeEventCreated * 1000;
  }
  const parsed = rec.updatedAt ? Date.parse(rec.updatedAt) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function isPassExplicitlyRevoked(rec: EntitlementRecord, now: number): boolean {
  if (typeof rec.passRevokedAtMs === "number" && rec.passRevokedAtMs > 0) {
    return true;
  }
  const isRevokedStatus =
    rec.status === "canceled" || rec.status === "past_due" || rec.status === "unpaid";
  return (
    isRevokedStatus &&
    typeof rec.paidPassExpiresAtMs === "number" &&
    rec.paidPassExpiresAtMs <= now
  );
}

function mergePassMetadata(
  primary: EntitlementRecord,
  secondary?: EntitlementRecord | null
): EntitlementRecord {
  if (!secondary) return primary;
  const now = Date.now();
  const revokedSet = new Set<string>([
    ...(primary.revokedOtoPassSessionIds || []),
    ...(secondary.revokedOtoPassSessionIds || []),
  ]);
  const mergedSessions = Array.from(
    new Set([...(secondary.otoPassSessionIds || []), ...(primary.otoPassSessionIds || [])])
  ).filter((s) => !revokedSet.has(s));

  const primaryRevoked = isPassExplicitlyRevoked(primary, now);
  const secondaryRevoked = isPassExplicitlyRevoked(secondary, now);
  const primaryTs = recordVersionTimestampMs(primary);
  const secondaryTs = recordVersionTimestampMs(secondary);

  let resolvedPassMs: number | undefined;
  if (primaryRevoked && !secondaryRevoked && primaryTs >= secondaryTs) {
    resolvedPassMs = primary.paidPassExpiresAtMs;
  } else if (secondaryRevoked && !primaryRevoked && secondaryTs >= primaryTs) {
    resolvedPassMs = secondary.paidPassExpiresAtMs;
  } else if (primaryRevoked && secondaryRevoked) {
    resolvedPassMs =
      primaryTs >= secondaryTs
        ? primary.paidPassExpiresAtMs
        : secondary.paidPassExpiresAtMs;
  } else {
    const maxPassMs = Math.max(
      typeof primary.paidPassExpiresAtMs === "number" ? primary.paidPassExpiresAtMs : 0,
      typeof secondary.paidPassExpiresAtMs === "number" ? secondary.paidPassExpiresAtMs : 0
    );
    resolvedPassMs = maxPassMs > 0 ? maxPassMs : undefined;
  }

  const maxRevokedAtMs = Math.max(
    primary.passRevokedAtMs || 0,
    secondary.passRevokedAtMs || 0
  );
  const revokedList = Array.from(revokedSet);

  const out: EntitlementRecord = {
    ...primary,
    checkoutSessionId: primary.checkoutSessionId || secondary.checkoutSessionId,
    userId: primary.userId || secondary.userId,
    paidPassExpiresAtMs: resolvedPassMs,
    otoPassSessionIds: mergedSessions.length > 0 ? mergedSessions : undefined,
    ...(revokedList.length > 0 ? { revokedOtoPassSessionIds: revokedList } : {}),
    ...(maxRevokedAtMs > 0 ? { passRevokedAtMs: maxRevokedAtMs } : {}),
    ...(primary.lastChargeSucceeded !== undefined ||
    secondary.lastChargeSucceeded !== undefined
      ? {
          lastChargeSucceeded:
            primary.lastChargeSucceeded ?? secondary.lastChargeSucceeded,
        }
      : {}),
    ...(Math.max(primary.pausedUntilMs || 0, secondary.pausedUntilMs || 0) > 0
      ? {
          pausedUntilMs: Math.max(
            primary.pausedUntilMs || 0,
            secondary.pausedUntilMs || 0
          ),
        }
      : {}),
    ...(Math.max(
      primary.lastRetentionPauseAtMs || 0,
      secondary.lastRetentionPauseAtMs || 0
    ) > 0
      ? {
          lastRetentionPauseAtMs: Math.max(
            primary.lastRetentionPauseAtMs || 0,
            secondary.lastRetentionPauseAtMs || 0
          ),
        }
      : {}),
    ...(Math.max(
      primary.lastRetentionOfferAtMs || 0,
      secondary.lastRetentionOfferAtMs || 0
    ) > 0
      ? {
          lastRetentionOfferAtMs: Math.max(
            primary.lastRetentionOfferAtMs || 0,
            secondary.lastRetentionOfferAtMs || 0
          ),
        }
      : {}),
  };
  if (out.paidPassExpiresAtMs === undefined) {
    delete out.paidPassExpiresAtMs;
  }
  if (out.otoPassSessionIds === undefined) {
    delete out.otoPassSessionIds;
  }
  return out;
}

function isTerminalEntitlementStatus(status?: string): boolean {
  return (
    status === "canceled" ||
    status === "unpaid" ||
    status === "incomplete_expired"
  );
}

function resolveNonRegressingExpiryMs(
  existing: EntitlementRecord | null | undefined,
  candidateStatus: EntitlementStatus,
  candidateExpiresAtMs: number | undefined,
  sameSubscription: boolean,
  nowMs: number
): number | undefined {
  if (candidateExpiresAtMs === undefined) {
    return existing?.expiresAtMs;
  }
  if (
    sameSubscription &&
    existing &&
    !isTerminalEntitlementStatus(existing.status) &&
    !isTerminalEntitlementStatus(candidateStatus) &&
    typeof existing.expiresAtMs === "number" &&
    Number.isFinite(existing.expiresAtMs) &&
    existing.expiresAtMs > nowMs &&
    typeof candidateExpiresAtMs === "number" &&
    Number.isFinite(candidateExpiresAtMs) &&
    candidateExpiresAtMs > nowMs
  ) {
    return Math.max(existing.expiresAtMs, candidateExpiresAtMs);
  }
  return candidateExpiresAtMs;
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
        const otherSub = isManagedSubscriptionId(existingLookup.subscriptionId)
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
  const now = Date.now();
  const cleanDeviceId = normalizeRealDeviceId(record.deviceId) || undefined;
  const inferredCheckoutSessionId =
    record.checkoutSessionId ||
    (record.sessionId.startsWith("cs_") ? record.sessionId : undefined);

  const existingBySub = record.subscriptionId
    ? await kvGet<EntitlementRecord>(`${SUB_KEY_PREFIX}${record.subscriptionId}`)
    : null;
  const existingBySession = await kvGet<EntitlementRecord>(
    `${SESSION_KEY_PREFIX}${record.sessionId}`
  );
  const existing = existingBySub ?? existingBySession;
  const sameSubscription = Boolean(
    existing?.subscriptionId &&
      record.subscriptionId &&
      existing.subscriptionId === record.subscriptionId
  );

  // Guard against out-of-order webhook events overwriting newer status/expiry state,
  // while still writing `session:${csId}`, backfilling metadata, and preserving any longer valid trial/period expiry!
  if (existing?.lastStripeEventCreated) {
    if (
      !record.lastStripeEventCreated ||
      record.lastStripeEventCreated < existing.lastStripeEventCreated
    ) {
      const mergedOutOfOrderExpiry = resolveNonRegressingExpiryMs(
        existing,
        record.status,
        record.expiresAtMs,
        sameSubscription,
        now
      );
      const expiryExtended =
        typeof mergedOutOfOrderExpiry === "number" &&
        mergedOutOfOrderExpiry > (existing.expiresAtMs || 0);
      if ((record.sessionId && !existingBySession) || expiryExtended) {
        const enrichedExisting = withCurrentExpiry({
          ...existing,
          checkoutSessionId:
            existing.checkoutSessionId || inferredCheckoutSessionId,
          customerId: existing.customerId || record.customerId,
          customerEmail: existing.customerEmail || record.customerEmail,
          deviceId: normalizeRealDeviceId(existing.deviceId) || cleanDeviceId,
          userId: existing.userId || record.userId,
          creatorCode: existing.creatorCode || record.creatorCode,
          expiresAtMs: mergedOutOfOrderExpiry,
          lastChargeSucceeded:
            existing.lastChargeSucceeded ?? record.lastChargeSucceeded,
          updatedAt: new Date().toISOString(),
        })!;
        if (record.sessionId) {
          const sessionCopy: EntitlementRecord = {
            ...enrichedExisting,
            sessionId: record.sessionId,
          };
          await kvSet(
            `${SESSION_KEY_PREFIX}${record.sessionId}`,
            sessionCopy,
            ENTITLEMENT_TTL_SECONDS
          );
          if (sessionCopy.active) {
            await clearNegativeSessionCache(record.sessionId);
          }
        }
        if (enrichedExisting.subscriptionId) {
          await kvSet(
            `${SUB_KEY_PREFIX}${enrichedExisting.subscriptionId}`,
            {
              ...enrichedExisting,
              sessionId: enrichedExisting.sessionId.startsWith("sub_") && record.sessionId
                ? record.sessionId
                : enrichedExisting.sessionId,
            },
            ENTITLEMENT_TTL_SECONDS
          );
        }
        if (enrichedExisting.customerId) {
          await writeSecondaryLookupKey(
            `${CUSTOMER_KEY_PREFIX}${enrichedExisting.customerId}`,
            enrichedExisting
          );
        }
        if (enrichedExisting.deviceId) {
          await writeSecondaryLookupKey(
            `${DEVICE_KEY_PREFIX}${enrichedExisting.deviceId}`,
            enrichedExisting
          );
        }
        if (enrichedExisting.customerEmail) {
          const cleanEmail = enrichedExisting.customerEmail.trim().toLowerCase();
          if (cleanEmail) {
            await writeSecondaryLookupKey(
              `${EMAIL_KEY_PREFIX}${cleanEmail}`,
              enrichedExisting
            );
          }
        }
      }
      return;
    }
  }

  const expiresAtMs = resolveNonRegressingExpiryMs(
    existing,
    record.status,
    record.expiresAtMs,
    sameSubscription,
    now
  );
  const paidPassExpiresAtMs =
    record.paidPassExpiresAtMs ?? existing?.paidPassExpiresAtMs;
  const otoPassSessionIds =
    record.otoPassSessionIds ?? existing?.otoPassSessionIds;
  const revokedOtoPassSessionIds =
    record.revokedOtoPassSessionIds ?? existing?.revokedOtoPassSessionIds;
  const passRevokedAtMs =
    record.passRevokedAtMs ?? existing?.passRevokedAtMs;
  const isExpired =
    typeof expiresAtMs === "number" &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs <= now;
  const effectiveStatus: EntitlementStatus = isExpired ? "canceled" : record.status;

  const baseNormalized: EntitlementRecord = {
    ...existing,
    ...record,
    checkoutSessionId:
      inferredCheckoutSessionId ||
      existing?.checkoutSessionId ||
      (existing?.sessionId?.startsWith("cs_") ? existing.sessionId : undefined),
    customerId: record.customerId || existing?.customerId,
    customerEmail: record.customerEmail || existing?.customerEmail,
    deviceId: cleanDeviceId || normalizeRealDeviceId(existing?.deviceId) || undefined,
    userId: record.userId || existing?.userId,
    expiresAtMs,
    paidPassExpiresAtMs,
    otoPassSessionIds,
    revokedOtoPassSessionIds,
    passRevokedAtMs,
    lastChargeSucceeded:
      record.lastChargeSucceeded ?? existing?.lastChargeSucceeded,
    pausedUntilMs: record.pausedUntilMs ?? existing?.pausedUntilMs,
    lastRetentionPauseAtMs:
      record.lastRetentionPauseAtMs ?? existing?.lastRetentionPauseAtMs,
    lastRetentionOfferAtMs:
      record.lastRetentionOfferAtMs ?? existing?.lastRetentionOfferAtMs,
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
  if (normalized.active && normalized.sessionId.startsWith("cs_")) {
    await clearNegativeSessionCache(normalized.sessionId);
  }
  if (
    normalized.checkoutSessionId &&
    normalized.checkoutSessionId !== normalized.sessionId
  ) {
    await kvSet(
      `${SESSION_KEY_PREFIX}${normalized.checkoutSessionId}`,
      { ...normalized, sessionId: normalized.checkoutSessionId },
      ENTITLEMENT_TTL_SECONDS
    );
  }
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
  if (isManagedSubscriptionId(rec.subscriptionId)) {
    const latestSub = await getSubscriptionEntitlement(rec.subscriptionId!);
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
  if (isManagedSubscriptionId(rec.subscriptionId)) {
    const latestSub = await getSubscriptionEntitlement(rec.subscriptionId!);
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
  const cleanDevice = normalizeRealDeviceId(deviceId);
  if (!cleanDevice) return null;
  const rec = await kvGet<EntitlementRecord>(`${DEVICE_KEY_PREFIX}${cleanDevice}`);
  if (!rec) return null;
  if (isManagedSubscriptionId(rec.subscriptionId)) {
    const latestSub = await getSubscriptionEntitlement(rec.subscriptionId!);
    if (latestSub) return withCurrentExpiry(mergePassMetadata(latestSub, rec));
  }
  return withCurrentExpiry(rec);
}

export async function updateSubscriptionEntitlement(
  subscriptionId: string,
  patch: {
    status: EntitlementStatus;
    plan?: PlanId;
    checkoutSessionId?: string;
    customerId?: string;
    customerEmail?: string;
    creatorCode?: string;
    deviceId?: string;
    userId?: string;
    expiresAtMs?: number;
    paidPassExpiresAtMs?: number;
    passRevokedAtMs?: number;
    lastChargeSucceeded?: boolean;
    pausedUntilMs?: number;
    lastRetentionPauseAtMs?: number;
    lastRetentionOfferAtMs?: number;
    lastStripeEventCreated?: number;
  }
): Promise<EntitlementRecord | null> {
  if (!subscriptionId) return null;
  const existing = await kvGet<EntitlementRecord>(
    `${SUB_KEY_PREFIX}${subscriptionId}`
  );

  const now = Date.now();
  const sameSubscription =
    !existing?.subscriptionId || existing.subscriptionId === subscriptionId;
  const isOlderStripeEvent = Boolean(
    existing?.lastStripeEventCreated &&
      patch.lastStripeEventCreated &&
      patch.lastStripeEventCreated < existing.lastStripeEventCreated
  );

  // Guard against older webhook events overwriting newer state, unless an out-of-order
  // active event for the same non-canceled subscription carries a longer valid period/trial expiry
  if (isOlderStripeEvent && existing) {
    const extendedExpiryMs = resolveNonRegressingExpiryMs(
      existing,
      patch.status,
      patch.expiresAtMs,
      sameSubscription,
      now
    );
    if (
      typeof extendedExpiryMs !== "number" ||
      extendedExpiryMs <= (existing.expiresAtMs || 0)
    ) {
      return withCurrentExpiry(existing);
    }
    patch = {
      ...patch,
      status: existing.status,
      expiresAtMs: extendedExpiryMs,
      lastStripeEventCreated: existing.lastStripeEventCreated,
    };
  }

  const expiresAtMs = resolveNonRegressingExpiryMs(
    existing,
    patch.status,
    patch.expiresAtMs,
    sameSubscription,
    now
  );
  const hasStackedOtoPass = Boolean(
    existing?.otoPassSessionIds && existing.otoPassSessionIds.length > 0
  );
  const isTerminalCancel = isTerminalEntitlementStatus(patch.status);

  let paidPassExpiresAtMs =
    patch.paidPassExpiresAtMs ?? existing?.paidPassExpiresAtMs;
  let passRevokedAtMs = patch.passRevokedAtMs ?? existing?.passRevokedAtMs;

  if (
    isTerminalCancel &&
    patch.paidPassExpiresAtMs === undefined &&
    !hasStackedOtoPass &&
    typeof paidPassExpiresAtMs === "number" &&
    paidPassExpiresAtMs > now
  ) {
    paidPassExpiresAtMs = now - 1000;
    passRevokedAtMs = now;
  }

  const isExpired =
    typeof expiresAtMs === "number" &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs <= now;
  const effectiveStatus: EntitlementStatus = isExpired ? "canceled" : patch.status;
  const cleanDeviceId =
    normalizeRealDeviceId(patch.deviceId) ||
    normalizeRealDeviceId(existing?.deviceId) ||
    undefined;
  const resolvedCheckoutSessionId =
    patch.checkoutSessionId ??
    existing?.checkoutSessionId ??
    (existing?.sessionId?.startsWith("cs_") ? existing.sessionId : undefined);
  const resolvedPausedUntilMs =
    patch.pausedUntilMs !== undefined
      ? patch.pausedUntilMs > 0
        ? patch.pausedUntilMs
        : undefined
      : existing?.pausedUntilMs;
  const resolvedLastPauseAtMs =
    patch.lastRetentionPauseAtMs ?? existing?.lastRetentionPauseAtMs;
  const resolvedLastOfferAtMs =
    patch.lastRetentionOfferAtMs ?? existing?.lastRetentionOfferAtMs;

  const baseUpdated: EntitlementRecord = {
    sessionId: existing?.sessionId || resolvedCheckoutSessionId || `sub_${subscriptionId}`,
    checkoutSessionId: resolvedCheckoutSessionId,
    subscriptionId,
    customerId: patch.customerId ?? existing?.customerId,
    customerEmail: patch.customerEmail ?? existing?.customerEmail,
    deviceId: cleanDeviceId,
    userId: patch.userId ?? existing?.userId,
    plan: patch.plan ?? existing?.plan ?? "annual",
    creatorCode: patch.creatorCode ?? existing?.creatorCode,
    status: effectiveStatus,
    active: !isExpired && isEntitlementStatusActive(effectiveStatus),
    expiresAtMs,
    paidPassExpiresAtMs,
    otoPassSessionIds: existing?.otoPassSessionIds,
    revokedOtoPassSessionIds: existing?.revokedOtoPassSessionIds,
    ...(passRevokedAtMs ? { passRevokedAtMs } : {}),
    ...(patch.lastChargeSucceeded !== undefined ||
    existing?.lastChargeSucceeded !== undefined
      ? {
          lastChargeSucceeded:
            patch.lastChargeSucceeded ?? existing?.lastChargeSucceeded,
        }
      : {}),
    ...(resolvedPausedUntilMs ? { pausedUntilMs: resolvedPausedUntilMs } : {}),
    ...(resolvedLastPauseAtMs
      ? { lastRetentionPauseAtMs: resolvedLastPauseAtMs }
      : {}),
    ...(resolvedLastOfferAtMs
      ? { lastRetentionOfferAtMs: resolvedLastOfferAtMs }
      : {}),
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
  if (
    updated.checkoutSessionId &&
    updated.checkoutSessionId !== existing?.sessionId
  ) {
    await kvSet(
      `${SESSION_KEY_PREFIX}${updated.checkoutSessionId}`,
      { ...updated, sessionId: updated.checkoutSessionId },
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
 * overwriting any active Stripe `sub_...` or RevenueCat `rc_...` subscription link.
 */
export async function applyOneTimeAnnualPass(params: {
  sessionId: string;
  customerId?: string;
  customerEmail?: string;
  deviceId?: string;
  userId?: string;
  creatorCode?: string;
  lastStripeEventCreated?: number;
}): Promise<EntitlementRecord> {
  const cleanSessionId = params.sessionId.trim();
  const rawCust = (params.customerId || "").trim();
  const cleanCustomerId = rawCust.startsWith("cus_") ? rawCust : "";
  const cleanEmail = (params.customerEmail || "").trim().toLowerCase();
  const cleanDeviceId = normalizeRealDeviceId(params.deviceId);

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
    const sessionCopy: EntitlementRecord = {
      ...existing,
      sessionId: cleanSessionId,
      checkoutSessionId: cleanSessionId,
    };
    await kvSet(
      `${SESSION_KEY_PREFIX}${cleanSessionId}`,
      sessionCopy,
      ENTITLEMENT_TTL_SECONDS
    );
    return withCurrentExpiry(sessionCopy)!;
  }

  const now = Date.now();
  const hasRealSub = isManagedSubscriptionId(existing?.subscriptionId);
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
  const revokedOtoPassSessionIds = (existing?.revokedOtoPassSessionIds || []).filter(
    (s) => s !== cleanSessionId
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
    checkoutSessionId: cleanSessionId,
    subscriptionId: preservedSubId,
    customerId: cleanCustomerId || existing?.customerId || undefined,
    customerEmail: cleanEmail || existing?.customerEmail || undefined,
    deviceId: cleanDeviceId || normalizeRealDeviceId(existing?.deviceId) || undefined,
    userId: params.userId || existing?.userId || undefined,
    plan: "annual",
    creatorCode: params.creatorCode || existing?.creatorCode,
    status: preservedStatus,
    active: true,
    expiresAtMs: existing?.expiresAtMs,
    paidPassExpiresAtMs,
    otoPassSessionIds,
    revokedOtoPassSessionIds:
      revokedOtoPassSessionIds.length > 0 ? revokedOtoPassSessionIds : undefined,
    passRevokedAtMs: undefined,
    lastStripeEventCreated:
      params.lastStripeEventCreated ?? existing?.lastStripeEventCreated,
    updatedAt: new Date().toISOString(),
  })!;

  // Store under BOTH the OTO checkout sessionId and the preserved subscription/device/customer/email keys
  const sessionRecord: EntitlementRecord = {
    ...merged,
    sessionId: cleanSessionId,
    checkoutSessionId: cleanSessionId,
  };
  await kvSet(
    `${SESSION_KEY_PREFIX}${cleanSessionId}`,
    sessionRecord,
    ENTITLEMENT_TTL_SECONDS
  );
  await clearNegativeSessionCache(cleanSessionId);
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
 * Explicitly revokes a specific Stripe Checkout `session:${checkoutSessionId}` record
 * (used on refunds, disputes, and failed async payments so stale session IDs cannot resurrect passes).
 */
export async function revokeCheckoutSessionEntitlement(
  rawSessionId?: string | null,
  lastStripeEventCreated?: number
): Promise<void> {
  const cleanSessionId = (rawSessionId || "").trim();
  if (!cleanSessionId) return;
  const existingSession = await kvGet<EntitlementRecord>(
    `${SESSION_KEY_PREFIX}${cleanSessionId}`
  );
  if (!existingSession) return;
  const now = Date.now();
  const hasRealSub = isManagedSubscriptionId(existingSession.subscriptionId);
  const subRec = hasRealSub
    ? await getSubscriptionEntitlement(existingSession.subscriptionId!)
    : null;
  if (subRec?.active) {
    await kvSet(
      `${SESSION_KEY_PREFIX}${cleanSessionId}`,
      { ...subRec, sessionId: cleanSessionId },
      ENTITLEMENT_TTL_SECONDS
    );
    return;
  }
  const revoked: EntitlementRecord = {
    ...existingSession,
    status: "canceled",
    active: false,
    paidPassExpiresAtMs: existingSession.paidPassExpiresAtMs ? now - 1000 : undefined,
    passRevokedAtMs: now,
    lastStripeEventCreated:
      lastStripeEventCreated ?? existingSession.lastStripeEventCreated,
    updatedAt: new Date().toISOString(),
  };
  await kvSet(
    `${SESSION_KEY_PREFIX}${cleanSessionId}`,
    revoked,
    ENTITLEMENT_TTL_SECONDS
  );
}

/**
 * Revokes a refunded/disputed one-time +366-day pass (`oto_gift_year`) while keeping
 * any active recurring `sub_...` / `rc_...` subscription intact.
 */
export async function revokeOneTimeAnnualPass(params: {
  sessionId?: string;
  customerId?: string;
  deviceId?: string;
  customerEmail?: string;
}): Promise<void> {
  const cleanSessionId = (params.sessionId || "").trim();
  const rawCust = (params.customerId || "").trim();
  const cleanCustomerId = rawCust.startsWith("cus_") ? rawCust : "";
  const cleanDeviceId = normalizeRealDeviceId(params.deviceId);
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

  const targetPassSessionId =
    cleanSessionId ||
    existing.otoPassSessionIds?.[existing.otoPassSessionIds.length - 1] ||
    existing.checkoutSessionId ||
    "";

  const now = Date.now();
  const nextSessions = (existing.otoPassSessionIds || []).filter(
    (s) => s !== targetPassSessionId
  );
  const nextRevokedSessions = Array.from(
    new Set([
      ...(existing.revokedOtoPassSessionIds || []),
      ...(targetPassSessionId ? [targetPassSessionId] : []),
    ])
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

  const hasRealSub = isManagedSubscriptionId(existing.subscriptionId);
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
    status: baseStatus,
    paidPassExpiresAtMs: nextPassMs,
    otoPassSessionIds: nextSessions.length > 0 ? nextSessions : undefined,
    revokedOtoPassSessionIds:
      nextRevokedSessions.length > 0 ? nextRevokedSessions : undefined,
    passRevokedAtMs: now,
    updatedAt: new Date().toISOString(),
  })!;
  if (updated.paidPassExpiresAtMs === undefined) {
    delete updated.paidPassExpiresAtMs;
  }

  const sessionIdsToUpdate = new Set<string>();
  if (cleanSessionId) sessionIdsToUpdate.add(cleanSessionId);
  if (targetPassSessionId) sessionIdsToUpdate.add(targetPassSessionId);
  if (existing.sessionId) sessionIdsToUpdate.add(existing.sessionId);
  if (existing.checkoutSessionId) sessionIdsToUpdate.add(existing.checkoutSessionId);

  for (const sid of sessionIdsToUpdate) {
    const isRevokedOtoSid = sid === targetPassSessionId && !hasRealSub && !nextPassMs;
    await kvSet(
      `${SESSION_KEY_PREFIX}${sid}`,
      isRevokedOtoSid
        ? {
            ...updated,
            sessionId: sid,
            status: "canceled",
            active: false,
          }
        : { ...updated, sessionId: sid },
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

/**
 * GDPR / CCPA account-deletion PII redaction: deletes email-indexed entitlement & consent keys
 * and scrubs `customerEmail`, `email`, and `ip` from all linked session, subscription, customer,
 * device, and auto-renewal consent records while preserving anonymized financial/legal proof.
 */
export async function redactEntitlementEmail(
  rawEmail: string,
  extraDeviceIds: string[] = [],
  userId?: string
): Promise<void> {
  const cleanEmail = (rawEmail || "").trim().toLowerCase();
  if (!cleanEmail) return;
  const cleanUserId = (userId || "").trim();

  const candidateKeys = new Set<string>();
  const sessionIds = new Set<string>();
  const customerIds = new Set<string>();
  const subscriptionIds = new Set<string>();
  const deviceIds = new Set<string>();
  const auditConsentKeys = new Set<string>();

  const [emailEntA, emailEntB, emailConsentA, emailConsentB] = await Promise.all([
    kvGet<EntitlementRecord>(`${EMAIL_KEY_PREFIX}${cleanEmail}`).catch(() => null),
    kvGet<EntitlementRecord>(`entitlement:email:${cleanEmail}`).catch(() => null),
    kvGet<SubscriptionConsentRecord>(`consent:email:${cleanEmail}`).catch(() => null),
    kvGet<SubscriptionConsentRecord>(`${CONSENT_KEY_PREFIX}email:${cleanEmail}`).catch(
      () => null
    ),
  ]);

  const collectSiblingKeys = (rec: EntitlementRecord | null) => {
    if (!rec) return;
    if (rec.sessionId) {
      sessionIds.add(rec.sessionId);
      candidateKeys.add(`${SESSION_KEY_PREFIX}${rec.sessionId}`);
    }
    if (rec.checkoutSessionId) {
      sessionIds.add(rec.checkoutSessionId);
      candidateKeys.add(`${SESSION_KEY_PREFIX}${rec.checkoutSessionId}`);
    }
    for (const s of rec.otoPassSessionIds || []) {
      if (s) {
        sessionIds.add(s);
        candidateKeys.add(`${SESSION_KEY_PREFIX}${s}`);
      }
    }
    for (const s of rec.revokedOtoPassSessionIds || []) {
      if (s) {
        sessionIds.add(s);
        candidateKeys.add(`${SESSION_KEY_PREFIX}${s}`);
      }
    }
    if (rec.subscriptionId) {
      subscriptionIds.add(rec.subscriptionId);
      candidateKeys.add(`${SUB_KEY_PREFIX}${rec.subscriptionId}`);
    }
    if (rec.customerId) {
      customerIds.add(rec.customerId);
      candidateKeys.add(`${CUSTOMER_KEY_PREFIX}${rec.customerId}`);
    }
    const normDev = normalizeRealDeviceId(rec.deviceId);
    if (normDev) {
      if (!normDev.startsWith("user:")) {
        deviceIds.add(normDev);
      }
      candidateKeys.add(`${DEVICE_KEY_PREFIX}${normDev}`);
    }
  };

  const collectFromConsent = (c: SubscriptionConsentRecord | null) => {
    if (!c || typeof c !== "object") return;
    if (c.sessionId?.trim()) {
      const sid = c.sessionId.trim();
      sessionIds.add(sid);
      candidateKeys.add(`${SESSION_KEY_PREFIX}${sid}`);
    }
    if (c.customerId?.trim()) {
      const cid = c.customerId.trim();
      customerIds.add(cid);
      candidateKeys.add(`${CUSTOMER_KEY_PREFIX}${cid}`);
    }
    if (c.subscriptionId?.trim()) {
      const subId = c.subscriptionId.trim();
      subscriptionIds.add(subId);
      candidateKeys.add(`${SUB_KEY_PREFIX}${subId}`);
    }
    const normDev = normalizeRealDeviceId(c.deviceId);
    if (normDev && !normDev.startsWith("user:")) {
      deviceIds.add(normDev);
      candidateKeys.add(`${DEVICE_KEY_PREFIX}${normDev}`);
    }
    if (c.auditKey?.trim()) {
      auditConsentKeys.add(c.auditKey.trim());
    }
  };

  collectSiblingKeys(emailEntA);
  collectSiblingKeys(emailEntB);
  collectFromConsent(emailConsentA);
  collectFromConsent(emailConsentB);

  const deviceProbeList = cleanUserId
    ? [...extraDeviceIds, `user:${cleanUserId}`]
    : extraDeviceIds;
  for (const rawDev of deviceProbeList) {
    const normDev = normalizeRealDeviceId(rawDev);
    if (!normDev) continue;
    if (!normDev.startsWith("user:")) {
      deviceIds.add(normDev);
    }
    const devKey = `${DEVICE_KEY_PREFIX}${normDev}`;
    candidateKeys.add(devKey);
  }

  // Expand sibling entitlement keys once more so any sessionId/customerId/deviceId on sub:/device: records is discovered
  for (const key of Array.from(candidateKeys)) {
    const rec = await kvGet<EntitlementRecord>(key).catch(() => null);
    if (
      rec &&
      (!rec.customerEmail ||
        rec.customerEmail.trim().toLowerCase() === cleanEmail ||
        (cleanUserId && rec.userId === cleanUserId))
    ) {
      collectSiblingKeys(rec);
    }
  }

  const consentKeysToScrub = new Set<string>(auditConsentKeys);
  for (const sid of sessionIds) {
    consentKeysToScrub.add(`consent:${sid}`);
    consentKeysToScrub.add(`${CONSENT_KEY_PREFIX}${sid}`);
  }
  for (const subId of subscriptionIds) {
    consentKeysToScrub.add(`consent:sub_${subId}`);
    consentKeysToScrub.add(`${CONSENT_KEY_PREFIX}sub_${subId}`);
  }
  for (const cid of customerIds) {
    consentKeysToScrub.add(`consent:customer:${cid}`);
    consentKeysToScrub.add(`${CONSENT_KEY_PREFIX}customer:${cid}`);
  }
  for (const did of deviceIds) {
    consentKeysToScrub.add(`${CONSENT_KEY_PREFIX}latest:${did}`);
    consentKeysToScrub.add(`consent:latest:${did}`);
  }

  const scrubConsentKey = async (cKey: string): Promise<string | undefined> => {
    const cRec = await kvGet<SubscriptionConsentRecord>(cKey).catch(() => null);
    if (!cRec || typeof cRec !== "object") return undefined;
    const recEmail = (cRec.email || "").trim().toLowerCase();
    if (recEmail && recEmail !== cleanEmail && recEmail !== "[redacted]") {
      return undefined;
    }
    const scrubbedConsent: SubscriptionConsentRecord = {
      ...cRec,
      email: "[redacted]",
      ip: "[redacted]",
    };
    await kvSet(cKey, scrubbedConsent, CONSENT_TTL_SECONDS).catch(() => {});
    return cRec.auditKey?.trim();
  };

  for (const cKey of Array.from(consentKeysToScrub)) {
    const discoveredAuditKey = await scrubConsentKey(cKey);
    if (discoveredAuditKey && !consentKeysToScrub.has(discoveredAuditKey)) {
      consentKeysToScrub.add(discoveredAuditKey);
      await scrubConsentKey(discoveredAuditKey);
    }
  }

  await Promise.all([
    kvDel(`${EMAIL_KEY_PREFIX}${cleanEmail}`).catch(() => {}),
    kvDel(`entitlement:email:${cleanEmail}`).catch(() => {}),
    kvDel(`consent:email:${cleanEmail}`).catch(() => {}),
    kvDel(`${CONSENT_KEY_PREFIX}email:${cleanEmail}`).catch(() => {}),
    ...(cleanUserId
      ? [
          kvDel(`${DEVICE_KEY_PREFIX}user:${cleanUserId}`).catch(() => {}),
          kvDel(`entitlement:device:user:${cleanUserId}`).catch(() => {}),
        ]
      : []),
  ]);

  for (const key of candidateKeys) {
    if (cleanUserId && key === `${DEVICE_KEY_PREFIX}user:${cleanUserId}`) {
      continue;
    }
    const rec = await kvGet<EntitlementRecord>(key).catch(() => null);
    if (
      rec &&
      (rec.customerEmail?.trim().toLowerCase() === cleanEmail ||
        (cleanUserId && rec.userId === cleanUserId))
    ) {
      const scrubbed: EntitlementRecord = {
        ...rec,
        customerEmail: undefined,
        userId: undefined,
        updatedAt: new Date().toISOString(),
      };
      delete scrubbed.customerEmail;
      delete scrubbed.userId;
      await kvSet(key, scrubbed, ENTITLEMENT_TTL_SECONDS).catch(() => {});
    }
  }
}

export async function hasPriorEntitlementHistory(params: {
  deviceId?: string;
  email?: string;
}): Promise<EntitlementRecord | null> {
  const cleanDevice = normalizeRealDeviceId(params.deviceId);
  const cleanEmail = (params.email || "").trim().toLowerCase();
  if (cleanDevice) {
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
  const cleanDeviceId = normalizeRealDeviceId(callerDeviceId);

  // 1. Check persistent store FIRST (populated by /api/stripe/webhook) so webhook-activated sessions unlock immediately
  const stored = await kvGet<EntitlementRecord>(
    `${SESSION_KEY_PREFIX}${sessionId}`
  );
  if (stored) {
    const rawEffective = isManagedSubscriptionId(stored.subscriptionId)
      ? mergePassMetadata(
          (await getSubscriptionEntitlement(stored.subscriptionId!)) ?? stored,
          stored
        )
      : stored;
    const effective = withCurrentExpiry(rawEffective);

    if (!effective || (!effective.subscriptionId && !effective.paidPassExpiresAtMs)) {
      return null;
    }

    const storedDeviceId = normalizeRealDeviceId(effective.deviceId);
    // Enforce device binding if both stored.deviceId and callerDeviceId exist
    if (storedDeviceId && cleanDeviceId && storedDeviceId !== cleanDeviceId) {
      return null;
    }

    // Bind deviceId on first verification if not bound yet
    if (!storedDeviceId && cleanDeviceId) {
      effective.deviceId = cleanDeviceId;
      await saveEntitlement(effective);
    }

    return effective;
  }

  // Short-lived negative cache prevents fake/unpaid `cs_...` polling from hammering Stripe API
  if (await isSessionNegativelyCached(sessionId)) {
    return null;
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
      if (res.status >= 400 && res.status < 500) {
        await cacheNegativeSessionLookup(sessionId, res.status === 404 ? 90 : 30);
      }
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
            items?: {
              data?: Array<{
                price?: { recurring?: { interval?: string } };
                plan?: { interval?: string };
              }>;
            };
          };
    };

    if (!session || session.id !== sessionId) {
      await cacheNegativeSessionLookup(sessionId, 60);
      return null;
    }

    const isComplete = session.status === "complete";
    const isPaidOrTrial =
      session.payment_status === "paid" ||
      session.payment_status === "no_payment_required";
    if (!isComplete || !isPaidOrTrial) {
      await cacheNegativeSessionLookup(sessionId, 15);
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
      await cacheNegativeSessionLookup(sessionId, 15);
      return null;
    }

    const subStatus = (subObj?.status ||
      (isOneTimeOtoPass
        ? "active"
        : session.payment_status === "no_payment_required"
          ? "trialing"
          : "active")) as EntitlementStatus;

    const rawMetaPlan = session.metadata?.plan || subObj?.metadata?.plan;
    const recurringInterval =
      subObj?.items?.data?.[0]?.price?.recurring?.interval ||
      subObj?.items?.data?.[0]?.plan?.interval;
    const plan: PlanId =
      rawMetaPlan === "monthly"
        ? "monthly"
        : rawMetaPlan === "annual"
          ? "annual"
          : recurringInterval === "month"
            ? "monthly"
            : "annual";
    const creatorCode =
      session.metadata?.creator_code ||
      subObj?.metadata?.creator_code ||
      undefined;
    const sessionDeviceId =
      normalizeRealDeviceId(
        session.metadata?.device_id ||
          subObj?.metadata?.device_id ||
          session.client_reference_id
      ) || undefined;

    if (
      sessionDeviceId &&
      cleanDeviceId &&
      sessionDeviceId !== cleanDeviceId
    ) {
      return null;
    }

    const rawCustomer =
      typeof session.customer === "string"
        ? session.customer.trim()
        : session.customer?.id?.trim();
    const customerId =
      typeof rawCustomer === "string" && rawCustomer.startsWith("cus_")
        ? rawCustomer
        : undefined;

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
      const metaTrialEndSec = Number(
        session.metadata?.trial_end_sec || subObj?.metadata?.trial_end_sec || 0
      );
      const computedExpiresAtMs =
        subStatus === "trialing" &&
        typeof subObj?.trial_end === "number" &&
        subObj.trial_end > 0
          ? subObj.trial_end * 1000
          : subStatus === "trialing" &&
              Number.isFinite(metaTrialEndSec) &&
              metaTrialEndSec * 1000 > Date.now()
            ? metaTrialEndSec * 1000
            : typeof subObj?.current_period_end === "number" &&
                subObj.current_period_end > 0
              ? subObj.current_period_end * 1000
              : undefined;
      record = {
        sessionId,
        checkoutSessionId: sessionId,
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
      targetDevice
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
 * only after verifying caller ownership via `authToken` (verified account session, evaluated first)
 * or `deviceId` + `deviceSecret` (HMAC-verified device credential).
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
  const rawDeviceId = normalizeRealDeviceId(params.deviceId);
  const rawDeviceSecret = (params.deviceSecret || "").trim();
  const rawAuthToken = (params.authToken || "").trim();

  let verifiedEmail = "";
  let verifiedDeviceId = "";
  const verifiedLinkedDevices: string[] = [];
  let hasVerifiedDeviceSecret = false;

  // 1. Evaluate authenticated user session FIRST so cross-device web portal links never fail on localStorage deviceSecret mismatch
  if (rawAuthToken) {
    const { getUserBySessionToken } = await import("./auth");
    const authUser = await getUserBySessionToken(rawAuthToken);
    if (authUser) {
      if (authUser.emailVerified === true && authUser.email) {
        verifiedEmail = authUser.email.trim().toLowerCase();
      }
      const linkedList = Array.from(
        new Set(
          (authUser.linkedDevices || [])
            .map((d) => normalizeRealDeviceId(d))
            .filter(Boolean)
        )
      );
      if (rawDeviceId && linkedList.includes(rawDeviceId)) {
        verifiedLinkedDevices.push(rawDeviceId);
      }
      for (const devId of linkedList) {
        if (!verifiedLinkedDevices.includes(devId)) {
          verifiedLinkedDevices.push(devId);
        }
      }
      if (verifiedLinkedDevices.length > 0) {
        verifiedDeviceId = verifiedLinkedDevices[0];
      }
    }
  }

  // 2. Fallback / supplement: verify explicit deviceId + deviceSecret when provided
  if (rawDeviceId && rawDeviceSecret && !verifiedLinkedDevices.includes(rawDeviceId)) {
    const { getExistingDevice, verifyDeviceSecret } = await import("./referrals");
    const existingDevice = await getExistingDevice(rawDeviceId);
    if (
      existingDevice?.deviceSecretHash &&
      verifyDeviceSecret(existingDevice, rawDeviceSecret)
    ) {
      verifiedDeviceId = rawDeviceId;
      verifiedLinkedDevices.unshift(rawDeviceId);
      hasVerifiedDeviceSecret = true;
    }
  }

  // Never resolve a customer portal session without a verified account session or verified device
  if (!verifiedDeviceId && !verifiedEmail) {
    return null;
  }

  let record: EntitlementRecord | null = null;
  if (verifiedEmail) {
    record = await getEmailEntitlement(verifiedEmail);
  }
  if (!record && cleanSessionId && verifiedDeviceId) {
    record = await verifyStripeCheckoutSession(cleanSessionId, verifiedDeviceId);
  }
  if (!record) {
    for (const candidateDevId of verifiedLinkedDevices) {
      const candidateEnt = await getDevicePaidEntitlement(candidateDevId);
      if (!candidateEnt) continue;
      // Prevent cross-account device hijacking if a device entitlement is bound to a different customerEmail
      if (
        candidateEnt.customerEmail &&
        verifiedEmail &&
        candidateEnt.customerEmail.trim().toLowerCase() !== verifiedEmail &&
        !(hasVerifiedDeviceSecret && candidateDevId === rawDeviceId)
      ) {
        continue;
      }
      record = candidateEnt;
      break;
    }
  }

  if (typeof record?.customerId === "string" && record.customerId.startsWith("cus_")) {
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
        const rawCid =
          typeof subData.customer === "string"
            ? subData.customer.trim()
            : subData.customer?.id?.trim();
        if (typeof rawCid === "string" && rawCid.startsWith("cus_")) {
          record.customerId = rawCid;
          await saveEntitlement(record);
          return { customerId: rawCid, record };
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
        const cid = cusData.data?.[0]?.id?.trim();
        if (typeof cid === "string" && cid.startsWith("cus_")) {
          return { customerId: cid, record: record ?? undefined };
        }
      }
    } catch {
      /* ignore */
    }
  }

  return null;
}

