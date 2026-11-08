import "server-only";
import crypto from "node:crypto";
import { kvGet, kvSet } from "./storage";
import { getEmailEntitlement } from "./entitlements";
import { codeFromDeviceId, getOrCreateDevice, saveDevice } from "./referrals";

export type AuthProvider = "email" | "google" | "apple";

export interface UserAccount {
  userId: string;
  email: string;
  displayName: string;
  provider: AuthProvider;
  passwordSalt?: string;
  passwordHash?: string;
  referralCode: string;
  proUntil: number;
  isStripePro: boolean;
  watchlist?: Record<string, boolean>;
  linkedDevices: string[];
  resetCode?: string;
  resetExpiresAt?: number;
  deleted?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUserProfile {
  userId: string;
  email: string;
  displayName: string;
  provider: AuthProvider;
  referralCode: string;
  proUntil: number;
  isProActive: boolean;
  proDaysRemaining: number;
  watchlist?: Record<string, boolean>;
  createdAt: string;
}

const USER_EMAIL_PREFIX = "heybroc:user:email:";
const DAY_MS = 24 * 60 * 60 * 1000;
const KV_TTL_SECONDS = 60 * 60 * 24 * 365;

const memUsers = new Map<string, UserAccount>();

function getAuthSecret(): string {
  const secret = (
    process.env.AUTH_SECRET ||
    process.env.ADMIN_SECRET ||
    process.env.STRIPE_SECRET_KEY ||
    process.env.STRIPE_WEBHOOK_SECRET ||
    ""
  ).trim();
  if (!secret) {
    if (process.env.VERCEL) {
      throw new Error("AUTH_SECRET is required in production.");
    }
    return "local-dev-only-heybroc-auth-secret";
  }
  return secret;
}

export function normalizeEmail(raw: string): string {
  return (raw || "").trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizeEmail(email));
}

function hashPassword(password: string, salt: string): string {
  return crypto
    .pbkdf2Sync(password, salt, 12000, 32, "sha256")
    .toString("hex");
}

function safeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createSessionToken(user: UserAccount): string {
  const now = Date.now();
  const payload = Buffer.from(
    JSON.stringify({
      uid: user.userId,
      email: user.email,
      provider: user.provider,
      name: user.displayName,
      ref: user.referralCode,
      iat: now,
      exp: now + 30 * DAY_MS,
    }),
    "utf8"
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", getAuthSecret())
    .update(payload)
    .digest("base64url");
  return `hb_${payload}.${sig}`;
}

export function verifySessionToken(token: string): {
  uid: string;
  email: string;
  provider: AuthProvider;
  name: string;
  ref: string;
  iat?: number;
  exp?: number;
} | null {
  const clean = (token || "").trim();
  if (!clean.startsWith("hb_")) return null;
  const body = clean.slice(3);
  const dotIdx = body.indexOf(".");
  if (dotIdx <= 0) return null;
  const payload = body.slice(0, dotIdx);
  const sig = body.slice(dotIdx + 1);
  let expected: string;
  try {
    expected = crypto
      .createHmac("sha256", getAuthSecret())
      .update(payload)
      .digest("base64url");
  } catch {
    return null;
  }
  if (!safeEqualStrings(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed || typeof parsed.email !== "string") return null;
    if (typeof parsed.exp === "number" && parsed.exp <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function getUserByEmail(rawEmail: string): Promise<UserAccount | null> {
  const email = normalizeEmail(rawEmail);
  if (!email) return null;
  const cached = memUsers.get(email);
  if (cached) {
    return cached.deleted ? null : cached;
  }
  try {
    const stored = await kvGet<UserAccount>(`${USER_EMAIL_PREFIX}${email}`);
    if (stored && !stored.deleted && typeof stored.email === "string") {
      memUsers.set(email, stored);
      return stored;
    }
  } catch {
    /* ignore KV read errors */
  }
  return null;
}

export async function saveUser(user: UserAccount): Promise<void> {
  user.updatedAt = new Date().toISOString();
  memUsers.set(user.email, user);
  try {
    await kvSet(`${USER_EMAIL_PREFIX}${user.email}`, user, KV_TTL_SECONDS);
  } catch {
    /* keep in-memory fallback */
  }
}

export async function toPublicProfile(
  user: UserAccount,
  deviceId?: string
): Promise<PublicUserProfile> {
  const now = Date.now();
  let proUntil = user.proUntil || 0;
  let isStripePro = Boolean(user.isStripePro);

  // Check if Stripe has an active subscription under this email
  const stripeEnt = await getEmailEntitlement(user.email).catch(() => null);
  if (stripeEnt?.active) {
    isStripePro = true;
  }

  // Merge guest device entitlement if present so earned referral Pro days carry over
  if (deviceId) {
    const dev = await getOrCreateDevice(deviceId).catch(() => null);
    if (dev) {
      if (dev.proUntil > proUntil) {
        proUntil = dev.proUntil;
      }
      if (proUntil > dev.proUntil) {
        dev.proUntil = proUntil;
        await saveDevice(dev);
      }
    }
  }

  if (proUntil !== user.proUntil || isStripePro !== user.isStripePro) {
    user.proUntil = proUntil;
    user.isStripePro = isStripePro;
    await saveUser(user);
  }

  const isProActive = isStripePro || proUntil > now;
  const proDaysRemaining = isStripePro
    ? 365
    : Math.max(0, Math.ceil((proUntil - now) / DAY_MS));

  return {
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
    provider: user.provider,
    referralCode: user.referralCode,
    proUntil,
    isProActive,
    proDaysRemaining,
    watchlist: user.watchlist,
    createdAt: user.createdAt,
  };
}

export async function registerOrLoginEmail(params: {
  mode: "login" | "register";
  email: string;
  password: string;
  displayName?: string;
  deviceId?: string;
  watchlist?: Record<string, boolean>;
}): Promise<{
  ok: boolean;
  error?: string;
  token?: string;
  user?: PublicUserProfile;
  created?: boolean;
}> {
  const email = normalizeEmail(params.email);
  if (!isValidEmail(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  const password = params.password || "";
  if (password.length < 6) {
    return { ok: false, error: "Password must be at least 6 characters." };
  }

  const existing = await getUserByEmail(email);
  const dev = params.deviceId ? await getOrCreateDevice(params.deviceId) : null;

  if (params.mode === "login") {
    if (!existing) {
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = hashPassword(password, salt);
      const nameFromEmail = email.split("@")[0].replace(/[._-]+/g, " ");
      const newUser: UserAccount = {
        userId: `usr_${crypto.randomBytes(8).toString("hex")}`,
        email,
        displayName: (params.displayName || nameFromEmail || "HeyBroc Shopper").trim(),
        provider: "email",
        passwordSalt: salt,
        passwordHash: hash,
        referralCode: dev?.referralCode || codeFromDeviceId(email),
        proUntil: dev?.proUntil || 0,
        isStripePro: false,
        watchlist: params.watchlist,
        linkedDevices: params.deviceId ? [params.deviceId] : [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await saveUser(newUser);
      const profile = await toPublicProfile(newUser, params.deviceId);
      return {
        ok: true,
        token: createSessionToken(newUser),
        user: profile,
        created: true,
      };
    }

    if (!existing.passwordSalt || !existing.passwordHash) {
      return {
        ok: false,
        error: `This account is linked with ${existing.provider === "apple" ? "Apple" : "Google"}. Please sign in with ${existing.provider === "apple" ? "Apple" : "Google"}.`,
      };
    }

    const candidateHash = hashPassword(password, existing.passwordSalt);
    if (!safeEqualStrings(candidateHash, existing.passwordHash)) {
      return {
        ok: false,
        error: "Incorrect password. Tap 'Forgot password?' to reset it.",
      };
    }

    if (params.deviceId && !existing.linkedDevices.includes(params.deviceId)) {
      existing.linkedDevices.push(params.deviceId);
    }
    if (params.watchlist && !existing.watchlist) {
      existing.watchlist = params.watchlist;
    }
    await saveUser(existing);
    const profile = await toPublicProfile(existing, params.deviceId);
    return {
      ok: true,
      token: createSessionToken(existing),
      user: profile,
      created: false,
    };
  }

  // Register mode
  if (existing) {
    if (existing.passwordSalt && existing.passwordHash) {
      const candidateHash = hashPassword(password, existing.passwordSalt);
      if (safeEqualStrings(candidateHash, existing.passwordHash)) {
        const profile = await toPublicProfile(existing, params.deviceId);
        return {
          ok: true,
          token: createSessionToken(existing),
          user: profile,
          created: false,
        };
      }
    }
    return {
      ok: false,
      error: "An account with this email already exists. Try logging in instead.",
    };
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  const nameFromEmail = email.split("@")[0].replace(/[._-]+/g, " ");
  const newUser: UserAccount = {
    userId: `usr_${crypto.randomBytes(8).toString("hex")}`,
    email,
    displayName: (params.displayName || nameFromEmail || "HeyBroc Shopper").trim(),
    provider: "email",
    passwordSalt: salt,
    passwordHash: hash,
    referralCode: dev?.referralCode || codeFromDeviceId(email),
    proUntil: dev?.proUntil || 0,
    isStripePro: false,
    watchlist: params.watchlist,
    linkedDevices: params.deviceId ? [params.deviceId] : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveUser(newUser);
  const profile = await toPublicProfile(newUser, params.deviceId);
  return {
    ok: true,
    token: createSessionToken(newUser),
    user: profile,
    created: true,
  };
}

async function verifyGoogleIdToken(idToken: string, expectedEmail: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { email?: string; email_verified?: string };
    return (
      data.email_verified === "true" &&
      normalizeEmail(data.email || "") === normalizeEmail(expectedEmail)
    );
  } catch {
    return false;
  }
}

export async function loginWithOAuth(params: {
  provider: "google" | "apple";
  email: string;
  idToken?: string;
  password?: string;
  displayName?: string;
  deviceId?: string;
  watchlist?: Record<string, boolean>;
}): Promise<{
  ok: boolean;
  error?: string;
  token?: string;
  user?: PublicUserProfile;
}> {
  const email = normalizeEmail(params.email);
  if (!isValidEmail(email)) {
    return {
      ok: false,
      error: `Please enter a valid ${params.provider === "google" ? "Google / Gmail" : "Apple ID"} email address.`,
    };
  }

  const existing = await getUserByEmail(email);
  let verifiedOAuth = false;
  if (params.idToken && params.provider === "google") {
    verifiedOAuth = await verifyGoogleIdToken(params.idToken, email);
    if (!verifiedOAuth) {
      return { ok: false, error: "Invalid Google ID token." };
    }
  }

  if (existing && !verifiedOAuth) {
    // Prevent unauthenticated email-only takeover of an existing account
    if (existing.passwordSalt && existing.passwordHash) {
      if (!params.password) {
        return {
          ok: false,
          error: "This email already has a password-protected account. Please sign in with your password.",
        };
      }
      const candidateHash = hashPassword(params.password, existing.passwordSalt);
      if (!safeEqualStrings(candidateHash, existing.passwordHash)) {
        return { ok: false, error: "Incorrect password for this account." };
      }
    } else if (existing.provider !== params.provider) {
      return {
        ok: false,
        error: `This email is already registered with ${existing.provider}.`,
      };
    } else if (params.deviceId && existing.linkedDevices.length > 0 && !existing.linkedDevices.includes(params.deviceId)) {
      return {
        ok: false,
        error: "Please sign in with your password or verified OAuth token on this new device.",
      };
    }
  }

  const dev = params.deviceId ? await getOrCreateDevice(params.deviceId) : null;
  const fallbackName = email.split("@")[0].replace(/[._-]+/g, " ");

  const user: UserAccount = existing || {
    userId: `usr_${crypto.randomBytes(8).toString("hex")}`,
    email,
    displayName: (params.displayName || fallbackName || "HeyBroc Shopper").trim(),
    provider: params.provider,
    referralCode: dev?.referralCode || codeFromDeviceId(email),
    proUntil: dev?.proUntil || 0,
    isStripePro: false,
    watchlist: params.watchlist,
    linkedDevices: params.deviceId ? [params.deviceId] : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    if (params.displayName) user.displayName = params.displayName.trim();
    if (params.deviceId && !user.linkedDevices.includes(params.deviceId)) {
      user.linkedDevices.push(params.deviceId);
    }
    if (params.watchlist && !user.watchlist) {
      user.watchlist = params.watchlist;
    }
  }

  await saveUser(user);
  const profile = await toPublicProfile(user, params.deviceId);
  return {
    ok: true,
    token: createSessionToken(user),
    user: profile,
  };
}

export async function requestPasswordReset(rawEmail: string): Promise<{
  ok: boolean;
  error?: string;
  message?: string;
}> {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) {
    return { ok: false, error: "Enter your account email first so we can reset your password." };
  }
  const code = String(crypto.randomInt(100000, 1000000));
  const existing = await getUserByEmail(email);
  if (existing) {
    existing.resetCode = code;
    existing.resetExpiresAt = Date.now() + 15 * 60 * 1000;
    await saveUser(existing);
  }
  // Never leak resetCode in the HTTP response
  return {
    ok: true,
    message: `If an account exists for ${email}, a 6-digit reset code has been issued.`,
  };
}

export async function confirmPasswordReset(params: {
  email: string;
  resetCode?: string;
  currentPassword?: string;
  newPassword: string;
  deviceId?: string;
}): Promise<{
  ok: boolean;
  error?: string;
  token?: string;
  user?: PublicUserProfile;
}> {
  const email = normalizeEmail(params.email);
  if (!isValidEmail(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  if (!params.newPassword || params.newPassword.length < 6) {
    return { ok: false, error: "New password must be at least 6 characters." };
  }

  const existing = await getUserByEmail(email);
  if (!existing) {
    return { ok: false, error: "Invalid or expired reset code." };
  }

  let authorized = false;
  if (
    params.resetCode &&
    existing.resetCode &&
    existing.resetExpiresAt &&
    existing.resetExpiresAt > Date.now() &&
    safeEqualStrings(params.resetCode.trim(), existing.resetCode)
  ) {
    authorized = true;
  } else if (
    params.currentPassword &&
    existing.passwordSalt &&
    existing.passwordHash &&
    safeEqualStrings(hashPassword(params.currentPassword, existing.passwordSalt), existing.passwordHash)
  ) {
    authorized = true;
  }

  if (!authorized) {
    return {
      ok: false,
      error: "A valid 6-digit reset code (or current password) is required to change your password.",
    };
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(params.newPassword, salt);

  existing.passwordSalt = salt;
  existing.passwordHash = hash;
  existing.resetCode = undefined;
  existing.resetExpiresAt = undefined;
  await saveUser(existing);

  const profile = await toPublicProfile(existing, params.deviceId);
  return {
    ok: true,
    token: createSessionToken(existing),
    user: profile,
  };
}

export async function deleteUserAccount(rawEmail: string): Promise<boolean> {
  const email = normalizeEmail(rawEmail);
  if (!email) return false;
  memUsers.delete(email);
  try {
    await kvSet(
      `${USER_EMAIL_PREFIX}${email}`,
      { email, deleted: true, updatedAt: new Date().toISOString() },
      60 * 60 * 24
    );
  } catch {
    /* ignore KV errors */
  }
  return true;
}
