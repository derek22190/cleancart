/**
 * Device Entitlements, First-Trip 7-Day Pro Pass, Weekly Free Swap Allowance,
 * and Unlimited "Give 7 Days, Get 7 Days" Referral Engine.
 *
 * Rules:
 * - Product scores (0–100), expanded additive explanations, and live Cart Avg are 100% FREE forever.
 * - Every new device automatically gets a 7-day First-Trip Pro Pass starting on their first use.
 * - After Pro expires, free users get 5 single-item swaps per rolling 7-day week (+ a 3-swap courtesy refill mid-order).
 * - Inviting a friend via /r/:code grants +7 Pro days to BOTH the inviter and the friend once the friend
 *   activates HeyBroc and scans their first real store item (unlimited friends, deduplicated per device).
 */
import "server-only";
import { PRICING } from "./pricing";
import { kvGet, kvSet } from "./storage";

export interface DeviceEntitlement {
  deviceId: string;
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

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MAX_MEM_DEVICES = 2000;
const KV_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year

const devices = new Map<string, DeviceEntitlement>();
const codeToDevice = new Map<string, string>();

function setMemCache(entry: DeviceEntitlement) {
  if (devices.size >= MAX_MEM_DEVICES && !devices.has(entry.deviceId)) {
    const oldestKey = devices.keys().next().value;
    if (oldestKey) devices.delete(oldestKey);
  }
  devices.set(entry.deviceId, entry);
  if (codeToDevice.size >= MAX_MEM_DEVICES && !codeToDevice.has(entry.referralCode)) {
    const oldestCode = codeToDevice.keys().next().value;
    if (oldestCode) codeToDevice.delete(oldestCode);
  }
  codeToDevice.set(entry.referralCode, entry.deviceId);
}

export async function saveDevice(entry: DeviceEntitlement): Promise<void> {
  setMemCache(entry);
  try {
    await Promise.all([
      kvSet(`heybroc:device:${entry.deviceId}`, entry, KV_TTL_SECONDS),
      kvSet(`heybroc:refcode:${entry.referralCode}`, entry.deviceId, KV_TTL_SECONDS),
    ]);
  } catch {
    /* keep in-memory fallback if KV is transiently unreachable */
  }
}

/** Deterministic, human-friendly referral code from a deviceId (e.g. "BROC-7F4A2"). */
export function codeFromDeviceId(deviceId: string): string {
  const clean = deviceId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  let hash = 2166136261;
  for (let i = 0; i < clean.length; i++) {
    hash ^= clean.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let suffix = "";
  let v = hash >>> 0;
  for (let i = 0; i < 5; i++) {
    suffix += alphabet[v % alphabet.length];
    v = Math.floor(v / alphabet.length);
  }
  return `BROC-${suffix}`;
}

export async function getOrCreateDevice(rawDeviceId?: string): Promise<DeviceEntitlement> {
  const now = Date.now();
  const deviceId = (rawDeviceId || "anon-web").trim().slice(0, 128) || "anon-web";
  let entry = devices.get(deviceId);
  if (!entry) {
    try {
      const persisted = await kvGet<DeviceEntitlement>(`heybroc:device:${deviceId}`);
      if (persisted && typeof persisted.deviceId === "string") {
        entry = persisted;
        setMemCache(entry);
      }
    } catch {
      /* ignore KV read errors */
    }
  }
  if (!entry) {
    const referralCode = codeFromDeviceId(deviceId);
    entry = {
      deviceId,
      referralCode,
      referralActivated: false,
      firstSeenAt: now,
      proUntil: now + PRICING.firstTripPassDays * DAY_MS,
      referralsCompleted: 0,
      weeklySwapsUsed: [],
      weekResetAt: now + WEEK_MS,
      courtesyRefillUsedThisWeek: false,
    };
    await saveDevice(entry);
  } else if (now >= entry.weekResetAt) {
    entry.weeklySwapsUsed = [];
    entry.weekResetAt = now + WEEK_MS;
    entry.courtesyRefillUsedThisWeek = false;
    await saveDevice(entry);
  }
  return entry;
}

/**
 * Links a referred device to an inviter's code. If `activateNow` is true (e.g. when the friend
 * completes their first store scan in Walmart/Target/etc.), both devices immediately receive +7 days of Pro.
 */
export async function applyOrActivateReferral(params: {
  deviceId: string;
  referralCode?: string;
  activateNow?: boolean;
}): Promise<{
  device: DeviceEntitlement;
  rewardedNow: boolean;
  message: string;
}> {
  const now = Date.now();
  const device = await getOrCreateDevice(params.deviceId);
  const inputCode = (params.referralCode || device.referredByCode || "").trim().toUpperCase();

  if (!inputCode) {
    return { device, rewardedNow: false, message: "No referral code provided." };
  }
  if (inputCode === device.referralCode) {
    return { device, rewardedNow: false, message: "You cannot use your own referral code." };
  }
  if (device.referralActivated) {
    return { device, rewardedNow: false, message: "Referral bonus already activated on this device." };
  }

  device.referredByCode = inputCode;

  if (!params.activateNow) {
    await saveDevice(device);
    return {
      device,
      rewardedNow: false,
      message: `Code ${inputCode} saved! Open any grocery store app and scan your first item to unlock +${PRICING.referralBonusDays} Free Pro Days for both you and your friend.`,
    };
  }

  // Activate the +7 Pro days for the invited friend
  const bonusMs = PRICING.referralBonusDays * DAY_MS;
  device.referralActivated = true;
  device.proUntil = Math.max(now, device.proUntil) + bonusMs;
  await saveDevice(device);

  // Also credit the inviter device (+7 Pro days, no cap on how many friends they invite!)
  let inviterDeviceId = codeToDevice.get(inputCode);
  if (!inviterDeviceId) {
    try {
      inviterDeviceId = (await kvGet<string>(`heybroc:refcode:${inputCode}`)) || undefined;
    } catch {
      /* ignore KV lookup errors */
    }
  }
  if (inviterDeviceId && inviterDeviceId !== device.deviceId) {
    const inviter = await getOrCreateDevice(inviterDeviceId);
    inviter.proUntil = Math.max(now, inviter.proUntil) + bonusMs;
    inviter.referralsCompleted += 1;
    await saveDevice(inviter);
  }

  return {
    device,
    rewardedNow: true,
    message: `🎉 +${PRICING.referralBonusDays} Free Days of HeyBroc Pro unlocked for you and your friend!`,
  };
}

export function serializeEntitlement(d: DeviceEntitlement) {
  const now = Date.now();
  const proDaysRemaining = Math.max(0, Math.ceil((d.proUntil - now) / DAY_MS));
  const isProActive = d.proUntil > now;
  const maxWeeklySwaps =
    PRICING.freeWeeklySwaps + (d.courtesyRefillUsedThisWeek ? PRICING.courtesyRefillSwaps : 0);
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
    courtesyRefillAvailable: !d.courtesyRefillUsedThisWeek,
    weekResetAt: d.weekResetAt,
  };
}

export type EntitlementSummary = ReturnType<typeof serializeEntitlement>;
