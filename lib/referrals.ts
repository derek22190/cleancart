/**
 * Device Entitlements, Starter Free Swap Allowance, and Anti-Abuse Referral Engine.
 *
 * Security & Anti-Abuse Rules:
 * - Product scores (0–100), expanded additive explanations, and live Cart Avg are 100% FREE forever.
 * - Free users get 3 single-item Clean Swaps included on the free plan.
 * - New deviceIds start on the free tier (`proUntil = 0`) so clearing app data or rotating deviceIds
 *   never mints free Pro days.
 * - Referral codes (`BROC-XXXXXXXX`, 8 base-32 chars = 32^8 > 1 trillion combinations) are generated
 *   with CSPRNG (`crypto.randomBytes`) and claimed atomically via `kvSetNx` so codes never collide
 *   or overwrite another user's mapping.
 * - Referral rewards are capped at `MAX_REFERRALS_PER_DEVICE` (10 referrals / 70 banked days max),
 *   cannot be self-claimed, and cannot be triggered via unauthenticated `/api/referral` calls.
 * - Unactivated device records expire after 7 days in KV (upgraded to 365 days once active) to prevent
 *   Upstash storage exhaustion from synthetic deviceId floods.
 */
import "server-only";
import crypto from "node:crypto";
import { getDevicePaidEntitlement, normalizeRealDeviceId } from "./entitlements";
import { PRICING } from "./pricing";
import { kvDel, kvGet, kvSet, kvSetNx } from "./storage";

export interface DeviceEntitlement {
  deviceId: string;
  deviceSecretHash?: string;
  referralCode: string;
  referredByCode?: string;
  referralActivated: boolean;
  firstSeenAt: number;
  proUntil: number;
  referralsCompleted: number;
  weeklySwapsUsed: string[];
  weekResetAt: number;
  courtesyRefillUsedThisWeek: boolean;
}

export interface UserDeviceIndexRecord {
  userId: string;
  email: string;
  linkedDevices: string[];
  referralCode?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MAX_MEM_DEVICES = 2000;
const ACTIVE_KV_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year for active devices
const EPHEMERAL_KV_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days for unactivated devices

export const USER_BY_ID_PREFIX = "heybroc:user:by-id:";
export const USER_BY_DEVICE_PREFIX = "heybroc:user:by-device:";
const REFERRAL_REWARD_LOCK_PREFIX = "heybroc:referral:reward-lock:";

export const MAX_REFERRALS_PER_DEVICE = 10;
export const MAX_BANKED_PRO_DAYS = 70;

const REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

const devices = new Map<string, DeviceEntitlement>();
const codeToDevice = new Map<string, string>();

export function hashDeviceSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret.trim(), "utf8").digest("hex");
}

export function verifyDeviceSecret(
  entry: DeviceEntitlement,
  candidateSecret?: string | null
): boolean {
  if (!entry.deviceSecretHash) return false;
  if (!candidateSecret) return false;
  const expected = Buffer.from(entry.deviceSecretHash, "hex");
  const actual = Buffer.from(hashDeviceSecret(candidateSecret), "hex");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function setMemCache(entry: DeviceEntitlement) {
  if (!normalizeRealDeviceId(entry.deviceId)) return;
  if (devices.size >= MAX_MEM_DEVICES && !devices.has(entry.deviceId)) {
    const oldestKey = devices.keys().next().value;
    if (oldestKey) devices.delete(oldestKey);
  }
  devices.set(entry.deviceId, entry);
  if (
    entry.referralCode &&
    codeToDevice.size >= MAX_MEM_DEVICES &&
    !codeToDevice.has(entry.referralCode)
  ) {
    const oldestCode = codeToDevice.keys().next().value;
    if (oldestCode) codeToDevice.delete(oldestCode);
  }
  if (entry.referralCode) {
    codeToDevice.set(entry.referralCode, entry.deviceId);
  }
}

function isDeviceActiveForLongRetention(entry: DeviceEntitlement): boolean {
  return (
    entry.deviceId.startsWith("user:") ||
    Boolean(entry.referredByCode) ||
    entry.proUntil > Date.now() ||
    entry.referralActivated ||
    entry.referralsCompleted > 0 ||
    entry.weeklySwapsUsed.length > 0
  );
}

export function buildTransientFreeDevice(rawDeviceId?: string): DeviceEntitlement {
  const now = Date.now();
  const displayId = (rawDeviceId || "anon-web").trim().slice(0, 128) || "anon-web";
  return {
    deviceId: displayId,
    referralCode: codeFromDeviceId(displayId),
    referralActivated: false,
    firstSeenAt: now,
    proUntil: 0,
    referralsCompleted: 0,
    weeklySwapsUsed: [],
    weekResetAt: now + WEEK_MS,
    courtesyRefillUsedThisWeek: false,
  };
}

export async function saveDevice(entry: DeviceEntitlement): Promise<void> {
  const normDeviceId = normalizeRealDeviceId(entry.deviceId);
  if (!normDeviceId) {
    return;
  }
  entry.deviceId = normDeviceId;
  setMemCache(entry);
  const ttl = isDeviceActiveForLongRetention(entry)
    ? ACTIVE_KV_TTL_SECONDS
    : EPHEMERAL_KV_TTL_SECONDS;
  await kvSet(`heybroc:device:${normDeviceId}`, entry, ttl);
  // Only set referral code mapping if not already owned by another device (never overwrite!)
  if (entry.referralCode) {
    await kvSetNx(
      `heybroc:refcode:${entry.referralCode}`,
      normDeviceId,
      ACTIVE_KV_TTL_SECONDS
    );
  }
}

/** Generates a cryptographically random 8-character referral code (`BROC-XXXXXXXX`). */
export function generateRandomReferralCode(): string {
  const bytes = crypto.randomBytes(8);
  let suffix = "";
  for (let i = 0; i < 8; i++) {
    suffix += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  }
  return `BROC-${suffix}`;
}

/** Deterministic 8-char code helper retained for backwards compatibility. */
export function codeFromDeviceId(deviceId: string): string {
  const digest = crypto.createHash("sha256").update(deviceId, "utf8").digest();
  let suffix = "";
  for (let i = 0; i < 8; i++) {
    suffix += REF_ALPHABET[digest[i] % REF_ALPHABET.length];
  }
  return `BROC-${suffix}`;
}

async function allocateUniqueReferralCode(deviceId: string): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate =
      attempt === 0 ? generateRandomReferralCode() : generateRandomReferralCode();
    const claimed = await kvSetNx(
      `heybroc:refcode:${candidate}`,
      deviceId,
      ACTIVE_KV_TTL_SECONDS
    );
    if (claimed) {
      return candidate;
    }
    const existingOwner = await kvGet<string>(`heybroc:refcode:${candidate}`);
    if (existingOwner === deviceId) {
      return candidate;
    }
  }
  const fallback = `${generateRandomReferralCode()}${REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)]}`;
  await kvSetNx(`heybroc:refcode:${fallback}`, deviceId, ACTIVE_KV_TTL_SECONDS);
  return fallback;
}

export async function getDeviceIdByReferralCode(
  rawCode: string
): Promise<string | null> {
  const code = (rawCode || "").trim().toUpperCase();
  if (!/^BROC-[A-Z0-9]{4,10}$/.test(code)) return null;
  const stored = await kvGet<string>(`heybroc:refcode:${code}`);
  if (stored) {
    const normStored = normalizeRealDeviceId(stored);
    if (!normStored) return null;
    codeToDevice.set(code, normStored);
    return normStored;
  }
  const mem = codeToDevice.get(code) ?? null;
  return mem ? normalizeRealDeviceId(mem) || null : null;
}

export async function isValidReferralCode(rawCode: string): Promise<boolean> {
  const owner = await getDeviceIdByReferralCode(rawCode);
  return Boolean(owner);
}

export async function getExistingDevice(
  rawDeviceId?: string
): Promise<DeviceEntitlement | null> {
  const deviceId = normalizeRealDeviceId(rawDeviceId);
  if (!deviceId) return null;
  const persisted = await kvGet<DeviceEntitlement>(
    `heybroc:device:${deviceId}`
  );
  let entry: DeviceEntitlement | null = null;
  if (persisted && typeof persisted.deviceId === "string") {
    entry = persisted;
    setMemCache(entry);
  } else {
    entry = devices.get(deviceId) ?? null;
  }
  return entry;
}

export async function getOrCreateDevice(
  rawDeviceId?: string,
  deviceSecret?: string
): Promise<DeviceEntitlement> {
  const deviceId = normalizeRealDeviceId(rawDeviceId);
  if (!deviceId) {
    return buildTransientFreeDevice(rawDeviceId);
  }
  const now = Date.now();
  const existing = await getExistingDevice(deviceId);
  if (existing) {
    return existing;
  }

  // Never allow a caller-supplied secret to claim a deviceId that already has a paid subscription record
  const existingPaid = await getDevicePaidEntitlement(deviceId);
  const canBindSecret =
    !existingPaid && Boolean(deviceSecret && deviceSecret.trim().length >= 8);

  const referralCode = await allocateUniqueReferralCode(deviceId);
  const entry: DeviceEntitlement = {
    deviceId,
    deviceSecretHash: canBindSecret
      ? hashDeviceSecret(deviceSecret!)
      : undefined,
    referralCode,
    referralActivated: false,
    firstSeenAt: now,
    // New devices start on the free swap tier (no automatic 7-day Pro minting on deviceId creation)
    proUntil: 0,
    referralsCompleted: 0,
    weeklySwapsUsed: [],
    weekResetAt: now + WEEK_MS,
    courtesyRefillUsedThisWeek: false,
  };
  await saveDevice(entry);
  return entry;
}

/**
 * Ensures an account-level `BROC-XXXXXXXX` referral code has a registered KV mapping
 * and backing `DeviceEntitlement` record so friends can claim and activate it even
 * when the account was created via email/OAuth before binding a mobile device.
 */
export async function ensureReferralCodeRegistered(
  rawReferralCode: string,
  preferredDeviceId: string
): Promise<DeviceEntitlement | null> {
  const code = (rawReferralCode || "").trim().toUpperCase();
  if (!/^BROC-[A-Z0-9]{4,10}$/.test(code)) return null;

  const existingOwnerId = await getDeviceIdByReferralCode(code);
  const now = Date.now();
  if (existingOwnerId) {
    const existingOwner = await getExistingDevice(existingOwnerId);
    if (existingOwner) return existingOwner;
    const restoredOwner: DeviceEntitlement = {
      deviceId: existingOwnerId,
      referralCode: code,
      referralActivated: false,
      firstSeenAt: now,
      proUntil: 0,
      referralsCompleted: 0,
      weeklySwapsUsed: [],
      weekResetAt: now + WEEK_MS,
      courtesyRefillUsedThisWeek: false,
    };
    await saveDevice(restoredOwner);
    return restoredOwner;
  }

  const deviceId = normalizeRealDeviceId(preferredDeviceId);
  if (!deviceId) return null;

  let entry = await getExistingDevice(deviceId);
  if (!entry) {
    entry = {
      deviceId,
      referralCode: code,
      referralActivated: false,
      firstSeenAt: now,
      proUntil: 0,
      referralsCompleted: 0,
      weeklySwapsUsed: [],
      weekResetAt: now + WEEK_MS,
      courtesyRefillUsedThisWeek: false,
    };
    await saveDevice(entry);
  } else {
    await kvSetNx(`heybroc:refcode:${code}`, entry.deviceId, ACTIVE_KV_TTL_SECONDS);
    codeToDevice.set(code, entry.deviceId);
  }
  return entry;
}

/**
 * Checks whether `inviterDeviceId` / `referralCode` belongs to the same user account
 * or shares any linked device with the claimant.
 */
export async function isSelfReferralForAccount(params: {
  inviterDeviceId: string;
  referralCode?: string;
  claimantDeviceId?: string;
  claimantUserId?: string;
  claimantLinkedDevices?: string[];
}): Promise<boolean> {
  const inviterId = normalizeRealDeviceId(params.inviterDeviceId);
  if (!inviterId) return false;
  const claimantDev = normalizeRealDeviceId(params.claimantDeviceId);
  if (claimantDev && inviterId === claimantDev) return true;

  const cleanCode = (params.referralCode || "").trim().toUpperCase();

  let claimantUserId = (params.claimantUserId || "").trim();
  if (!claimantUserId && claimantDev?.startsWith("user:")) {
    claimantUserId = claimantDev.slice(5);
  }
  if (!claimantUserId && claimantDev) {
    claimantUserId =
      (await kvGet<string>(`${USER_BY_DEVICE_PREFIX}${claimantDev}`).catch(
        () => null
      )) || "";
  }

  const claimantDeviceSet = new Set<string>();
  if (claimantDev) claimantDeviceSet.add(claimantDev);
  for (const rawLinked of params.claimantLinkedDevices || []) {
    const norm = normalizeRealDeviceId(rawLinked);
    if (norm) claimantDeviceSet.add(norm);
  }

  if (claimantUserId) {
    claimantDeviceSet.add(`user:${claimantUserId}`);
    if (inviterId === `user:${claimantUserId}`) return true;
    const claimantIndex = await kvGet<UserDeviceIndexRecord>(
      `${USER_BY_ID_PREFIX}${claimantUserId}`
    ).catch(() => null);
    if (
      cleanCode &&
      claimantIndex?.referralCode &&
      claimantIndex.referralCode.trim().toUpperCase() === cleanCode
    ) {
      return true;
    }
    for (const rawLinked of claimantIndex?.linkedDevices || []) {
      const norm = normalizeRealDeviceId(rawLinked);
      if (norm) claimantDeviceSet.add(norm);
    }
  }

  if (claimantDeviceSet.has(inviterId)) {
    return true;
  }

  let inviterUserId = inviterId.startsWith("user:") ? inviterId.slice(5) : "";
  if (!inviterUserId) {
    inviterUserId =
      (await kvGet<string>(`${USER_BY_DEVICE_PREFIX}${inviterId}`).catch(
        () => null
      )) || "";
  }

  if (inviterUserId) {
    if (claimantUserId && inviterUserId === claimantUserId) {
      return true;
    }
    if (claimantDeviceSet.has(`user:${inviterUserId}`)) {
      return true;
    }
    const inviterIndex = await kvGet<UserDeviceIndexRecord>(
      `${USER_BY_ID_PREFIX}${inviterUserId}`
    ).catch(() => null);
    for (const rawLinked of inviterIndex?.linkedDevices || []) {
      const norm = normalizeRealDeviceId(rawLinked);
      if (norm && claimantDeviceSet.has(norm)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Links a referred device to an existing inviter's referral code (`claim`), or activates
 * a previously claimed referral when triggered by an internal verified event.
 */
export async function applyOrActivateReferral(params: {
  deviceId: string;
  referralCode?: string;
  activateNow?: boolean;
  deviceSecret?: string;
  userId?: string;
  linkedDevices?: string[];
}): Promise<{
  ok: boolean;
  device: DeviceEntitlement;
  rewardedNow: boolean;
  message: string;
}> {
  const normDeviceId = normalizeRealDeviceId(params.deviceId);
  if (!normDeviceId) {
    return {
      ok: false,
      device: buildTransientFreeDevice(params.deviceId),
      rewardedNow: false,
      message: "Invalid device identifier for referral.",
    };
  }

  const now = Date.now();
  const device = await getOrCreateDevice(normDeviceId, params.deviceSecret);
  if (
    !params.activateNow &&
    device.deviceSecretHash &&
    !verifyDeviceSecret(device, params.deviceSecret)
  ) {
    return {
      ok: false,
      device,
      rewardedNow: false,
      message: "Invalid device credentials for referral claim.",
    };
  }
  const inputCode = (params.referralCode || device.referredByCode || "")
    .trim()
    .toUpperCase();

  if (!inputCode) {
    return {
      ok: false,
      device,
      rewardedNow: false,
      message: "No referral code provided.",
    };
  }
  if (inputCode === device.referralCode) {
    return {
      ok: false,
      device,
      rewardedNow: false,
      message: "You cannot use your own referral code.",
    };
  }
  if (device.referralActivated) {
    return {
      ok: false,
      device,
      rewardedNow: false,
      message: "Referral bonus already activated on this device.",
    };
  }

  const inviterDeviceId = await getDeviceIdByReferralCode(inputCode);
  if (!inviterDeviceId || inviterDeviceId === device.deviceId) {
    return {
      ok: false,
      device,
      rewardedNow: false,
      message: "Invalid or unrecognized referral code.",
    };
  }

  const isAccountSelfRef = await isSelfReferralForAccount({
    inviterDeviceId,
    referralCode: inputCode,
    claimantDeviceId: device.deviceId,
    claimantUserId: params.userId,
    claimantLinkedDevices: params.linkedDevices,
  });
  if (isAccountSelfRef) {
    return {
      ok: false,
      device,
      rewardedNow: false,
      message: "You cannot use your own referral code.",
    };
  }

  device.referredByCode = inputCode;

  if (!params.activateNow) {
    await saveDevice(device);
    return {
      ok: true,
      device,
      rewardedNow: false,
      message: `Code ${inputCode} saved! Scan an item in the Android app or start a trial to unlock +${PRICING.referralBonusDays} Free Pro Days for both you and your friend.`,
    };
  }

  const inviter = await getExistingDevice(inviterDeviceId);
  if (!inviter) {
    return {
      ok: false,
      device,
      rewardedNow: false,
      message: "Inviter account not found.",
    };
  }

  if (inviter.referralsCompleted >= MAX_REFERRALS_PER_DEVICE) {
    return {
      ok: false,
      device,
      rewardedNow: false,
      message: "This referral code has reached the maximum number of redemptions.",
    };
  }

  // Atomic idempotency lock so concurrent `checkout.session.completed` + `invoice.paid` webhooks
  // never grant +60 days instead of +30 days
  const deviceLockAcquired = await kvSetNx(
    `${REFERRAL_REWARD_LOCK_PREFIX}${device.deviceId}`,
    "1",
    ACTIVE_KV_TTL_SECONDS
  );
  if (!deviceLockAcquired) {
    return {
      ok: false,
      device,
      rewardedNow: false,
      message: "Referral bonus already activated on this device.",
    };
  }

  const resolvedClaimantUid =
    (params.userId || "").trim() ||
    (device.deviceId.startsWith("user:")
      ? device.deviceId.slice(5)
      : (await kvGet<string>(`${USER_BY_DEVICE_PREFIX}${device.deviceId}`).catch(
          () => null
        )) || "");
  if (resolvedClaimantUid && `user:${resolvedClaimantUid}` !== device.deviceId) {
    const userLockAcquired = await kvSetNx(
      `${REFERRAL_REWARD_LOCK_PREFIX}user:${resolvedClaimantUid}`,
      "1",
      ACTIVE_KV_TTL_SECONDS
    );
    if (!userLockAcquired) {
      return {
        ok: false,
        device,
        rewardedNow: false,
        message: "Referral bonus already activated on this account.",
      };
    }
  }

  const bonusMs = PRICING.referralBonusDays * DAY_MS;
  const maxProUntil = now + MAX_BANKED_PRO_DAYS * DAY_MS;

  device.referralActivated = true;
  device.proUntil = Math.min(maxProUntil, Math.max(now, device.proUntil) + bonusMs);
  await saveDevice(device);

  inviter.proUntil = Math.min(
    maxProUntil,
    Math.max(now, inviter.proUntil) + bonusMs
  );
  inviter.referralsCompleted += 1;
  await saveDevice(inviter);

  return {
    ok: true,
    device,
    rewardedNow: true,
    message: `🎉 +${PRICING.referralBonusDays} Free Days of HeyBroc Pro unlocked for you and your friend!`,
  };
}

export async function purgeUserVirtualDevice(
  userId: string,
  referralCode?: string
): Promise<void> {
  const cleanUserId = (userId || "").trim();
  if (!cleanUserId) return;
  const virtualId = `user:${cleanUserId}`;
  const memEntry = devices.get(virtualId);
  devices.delete(virtualId);
  if (memEntry?.referralCode && codeToDevice.get(memEntry.referralCode) === virtualId) {
    codeToDevice.delete(memEntry.referralCode);
  }
  const cleanRefCode = (referralCode || "").trim().toUpperCase();
  if (cleanRefCode && codeToDevice.get(cleanRefCode) === virtualId) {
    codeToDevice.delete(cleanRefCode);
  }
  await Promise.all([
    kvDel(`heybroc:device:${virtualId}`).catch(() => {}),
    kvDel(`device:${virtualId}`).catch(() => {}),
    ...(cleanRefCode
      ? [
          kvGet<string>(`heybroc:refcode:${cleanRefCode}`)
            .then((owner) =>
              owner === virtualId
                ? kvDel(`heybroc:refcode:${cleanRefCode}`).catch(() => {})
                : undefined
            )
            .catch(() => {}),
        ]
      : []),
  ]);
}

export async function serializeEntitlementWithPaidLookup(d: DeviceEntitlement) {
  const { assignPaywallVariant, getPaywallConfig } = await import("./analytics");
  const pwConfig = await getPaywallConfig();
  const variant = assignPaywallVariant(d.deviceId, pwConfig.abTestEnabled);
  const paywallHeadline =
    variant === "B" && pwConfig.abTestEnabled ? pwConfig.variantBHeadline : pwConfig.headline;
  const base = serializeEntitlement(d, pwConfig.freeWeeklySwapsLimit, paywallHeadline, variant);
  const normDeviceId = normalizeRealDeviceId(d.deviceId);
  if (!normDeviceId) return base;
  const paid = await getDevicePaidEntitlement(normDeviceId);
  if (paid && paid.active) {
    const now = Date.now();
    const defaultHorizonDays =
      paid.status === "trialing"
        ? PRICING.trialDays
        : paid.plan === "annual"
          ? 365
          : 30;
    const explicitPaidExpiryMs = Math.max(
      typeof paid.expiresAtMs === "number" && Number.isFinite(paid.expiresAtMs)
        ? paid.expiresAtMs
        : 0,
      typeof paid.paidPassExpiresAtMs === "number" &&
        Number.isFinite(paid.paidPassExpiresAtMs)
        ? paid.paidPassExpiresAtMs
        : 0
    );
    const paidUntil =
      explicitPaidExpiryMs > now
        ? explicitPaidExpiryMs
        : now + defaultHorizonDays * DAY_MS;
    const effectiveProUntil = Math.max(base.proUntil, paidUntil);
    const effectiveDays = Math.max(
      base.proDaysRemaining,
      Math.max(1, Math.ceil((effectiveProUntil - now) / DAY_MS))
    );
    return {
      ...base,
      isProActive: true,
      proDaysRemaining: effectiveDays,
      proUntil: effectiveProUntil,
    };
  }
  return base;
}

export function serializeEntitlement(
  d: DeviceEntitlement,
  remoteFreeWeeklySwaps: number = PRICING.freeWeeklySwaps,
  paywallHeadline?: string,
  paywallVariant: "A" | "B" = "A",
) {
  const now = Date.now();
  const proDaysRemaining = Math.max(0, Math.ceil((d.proUntil - now) / DAY_MS));
  const isProActive = d.proUntil > now;
  const maxWeeklySwaps =
    remoteFreeWeeklySwaps +
    (d.courtesyRefillUsedThisWeek ? PRICING.courtesyRefillSwaps : 0);
  const swapsRemaining = Math.max(0, maxWeeklySwaps - d.weeklySwapsUsed.length);
  return {
    deviceId: d.deviceId,
    referralCode: d.referralCode,
    referredByCode: d.referredByCode || null,
    referralActivated: d.referralActivated,
    isProActive,
    proDaysRemaining,
    proUntil: d.proUntil,
    referralsCompleted: d.referralsCompleted,
    weeklySwapsUsedCount: d.weeklySwapsUsed.length,
    weeklySwapsLimit: maxWeeklySwaps,
    swapsRemaining,
    courtesyRefillAvailable: PRICING.courtesyRefillSwaps > 0 && !d.courtesyRefillUsedThisWeek,
    weekResetAt: d.weekResetAt,
    paywallHeadline: paywallHeadline || null,
    paywallVariant,
  };
}

export type EntitlementSummary = ReturnType<typeof serializeEntitlement>;
