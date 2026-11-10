import "server-only";
import crypto from "node:crypto";
import { kvDel, kvGet, kvSet } from "./storage";
import {
  getDevicePaidEntitlement,
  getEmailEntitlement,
  saveEntitlement,
} from "./entitlements";
import {
  codeFromDeviceId,
  ensureReferralCodeRegistered,
  getExistingDevice,
  getOrCreateDevice,
  verifyDeviceSecret,
} from "./referrals";
import { sendPasswordResetEmail, sendVerificationEmail } from "./email";

export type AuthProvider = "email" | "google" | "apple";

export interface UserAccount {
  userId: string;
  email: string;
  displayName: string;
  provider: AuthProvider;
  passwordSalt?: string;
  passwordHash?: string;
  passwordIterations?: number;
  emailVerified?: boolean;
  tokenVersion?: number;
  referralCode: string;
  proUntil: number;
  isStripePro: boolean;
  watchlist?: Record<string, boolean>;
  linkedDevices: string[];
  verificationCode?: string;
  verificationExpiresAt?: number;
  verificationAttempts?: number;
  resetCode?: string;
  resetExpiresAt?: number;
  resetAttempts?: number;
  deleted?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUserProfile {
  userId: string;
  email: string;
  displayName: string;
  provider: AuthProvider;
  emailVerified: boolean;
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
const PBKDF2_ITERATIONS = 600_000;
const LEGACY_PBKDF2_ITERATIONS = 12_000;
const MIN_PASSWORD_LENGTH = 8;

function getAuthSecret(): string {
  const secret = (process.env.AUTH_SECRET || "").trim();
  if (!secret) {
    if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
      throw new Error("AUTH_SECRET environment variable is required.");
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

function hashPassword(
  password: string,
  salt: string,
  iterations: number = PBKDF2_ITERATIONS
): string {
  return crypto
    .pbkdf2Sync(password, salt, iterations, 32, "sha256")
    .toString("hex");
}

function safeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function verifyPasswordAndUpgrade(
  user: UserAccount,
  password: string
): Promise<boolean> {
  if (!user.passwordSalt || !user.passwordHash) return false;
  const storedIterations = user.passwordIterations || LEGACY_PBKDF2_ITERATIONS;
  const candidate = hashPassword(password, user.passwordSalt, storedIterations);
  if (safeEqualStrings(candidate, user.passwordHash)) {
    if (storedIterations < PBKDF2_ITERATIONS) {
      const newSalt = crypto.randomBytes(16).toString("hex");
      user.passwordSalt = newSalt;
      user.passwordHash = hashPassword(password, newSalt, PBKDF2_ITERATIONS);
      user.passwordIterations = PBKDF2_ITERATIONS;
      await saveUser(user);
    }
    return true;
  }
  if (!user.passwordIterations) {
    const modernCandidate = hashPassword(
      password,
      user.passwordSalt,
      PBKDF2_ITERATIONS
    );
    if (safeEqualStrings(modernCandidate, user.passwordHash)) {
      user.passwordIterations = PBKDF2_ITERATIONS;
      await saveUser(user);
      return true;
    }
  }
  return false;
}

export function createSessionToken(user: UserAccount): string {
  const now = Date.now();
  const tv = user.tokenVersion ?? 0;
  const payload = Buffer.from(
    JSON.stringify({
      uid: user.userId,
      email: user.email,
      provider: user.provider,
      name: user.displayName,
      ref: user.referralCode,
      tv,
      sv: tv,
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
  tv: number;
  sv: number;
  iat: number;
  exp: number;
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
    const tv = parsed?.tv ?? parsed?.sv;
    if (
      !parsed ||
      typeof parsed.email !== "string" ||
      typeof parsed.uid !== "string" ||
      !Number.isFinite(parsed.exp) ||
      !Number.isFinite(parsed.iat) ||
      !Number.isInteger(tv)
    ) {
      return null;
    }
    if (parsed.exp <= Date.now()) return null;
    return {
      ...parsed,
      tv,
      sv: tv,
    };
  } catch {
    return null;
  }
}

export async function getUserByEmail(rawEmail: string): Promise<UserAccount | null> {
  const email = normalizeEmail(rawEmail);
  if (!email) return null;
  const stored = await kvGet<UserAccount>(`${USER_EMAIL_PREFIX}${email}`);
  if (stored && !stored.deleted && typeof stored.email === "string") {
    return stored;
  }
  return null;
}

export async function saveUser(user: UserAccount): Promise<void> {
  user.updatedAt = new Date().toISOString();
  await kvSet(`${USER_EMAIL_PREFIX}${user.email}`, user, KV_TTL_SECONDS);
  if (user.referralCode && !user.deleted) {
    const preferredDeviceId =
      user.linkedDevices[0] || `user:${user.userId}`;
    await ensureReferralCodeRegistered(
      user.referralCode,
      preferredDeviceId
    ).catch(() => null);
  }
}

export async function getAuthenticatedUser(
  token: string
): Promise<UserAccount | null> {
  const session = verifySessionToken(token);
  if (!session) return null;
  const user = await getUserByEmail(session.email);
  if (!user) return null;
  if (user.userId !== session.uid) return null;
  if ((user.tokenVersion ?? 0) !== session.tv) return null;
  return user;
}

export async function toPublicProfile(
  user: UserAccount,
  deviceId?: string
): Promise<PublicUserProfile> {
  const now = Date.now();
  const backingRefDevice = await getExistingDevice(
    user.linkedDevices[0] || `user:${user.userId}`
  ).catch(() => null);
  const proUntil = Math.max(user.proUntil || 0, backingRefDevice?.proUntil || 0);
  let isStripePro = false;
  const isVerified = Boolean(user.emailVerified);

  // Only read or rebind Stripe email entitlements when the account's email is verified (H02)
  const stripeEmailEnt = isVerified
    ? await getEmailEntitlement(user.email).catch(() => null)
    : null;
  const stripeDeviceEnt =
    deviceId && isVerified && user.linkedDevices.includes(deviceId)
      ? await getDevicePaidEntitlement(deviceId).catch(() => null)
      : null;
  const activeStripeEnt =
    (stripeEmailEnt?.active ? stripeEmailEnt : null) ??
    (stripeDeviceEnt?.active ? stripeDeviceEnt : null);

  if (activeStripeEnt) {
    const ownedByDifferentEmail =
      Boolean(activeStripeEnt.customerEmail) &&
      activeStripeEnt.customerEmail!.toLowerCase() !== user.email;
    if (!ownedByDifferentEmail) {
      isStripePro = true;
      if (
        isVerified &&
        (!activeStripeEnt.customerEmail ||
          activeStripeEnt.customerEmail.toLowerCase() === user.email) &&
        (activeStripeEnt.customerEmail?.toLowerCase() !== user.email ||
          (deviceId && activeStripeEnt.deviceId !== deviceId))
      ) {
        await saveEntitlement({
          ...activeStripeEnt,
          customerEmail: user.email,
          deviceId: deviceId || activeStripeEnt.deviceId,
        }).catch(() => {});
      }
    }
  }

  // Never mint future proUntil from a subscription read (H03)
  if (isStripePro !== user.isStripePro) {
    user.isStripePro = isStripePro;
    await saveUser(user).catch(() => {});
  }

  const isProActive = isStripePro || proUntil > now;
  const proDaysRemaining = isStripePro
    ? activeStripeEnt?.plan === "monthly"
      ? 31
      : 365
    : Math.max(0, Math.ceil((proUntil - now) / DAY_MS));

  return {
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
    provider: user.provider,
    emailVerified: isVerified,
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
  deviceSecret?: string;
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
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  const existing = await getUserByEmail(email);
  const cleanDeviceId = (params.deviceId || "").trim();
  const cleanDeviceSecret = (params.deviceSecret || "").trim();
  const dev =
    cleanDeviceId && cleanDeviceId !== "anon-web"
      ? cleanDeviceSecret
        ? await getOrCreateDevice(cleanDeviceId, cleanDeviceSecret)
        : await getExistingDevice(cleanDeviceId)
      : null;
  const isDeviceSecretVerified = Boolean(
    dev && cleanDeviceSecret && verifyDeviceSecret(dev, cleanDeviceSecret)
  );
  const verifiedDeviceId = isDeviceSecretVerified ? cleanDeviceId : undefined;

  if (params.mode === "login") {
    if (!existing) {
      return {
        ok: false,
        error: "Invalid email or password.",
      };
    }

    if (!existing.passwordSalt || !existing.passwordHash) {
      return {
        ok: false,
        error: `This account is linked with ${existing.provider === "apple" ? "Apple" : "Google"}. Please sign in with ${existing.provider === "apple" ? "Apple" : "Google"}.`,
      };
    }

    const passwordValid = await verifyPasswordAndUpgrade(existing, password);
    if (!passwordValid) {
      return {
        ok: false,
        error: "Incorrect password. Tap 'Forgot password?' to reset it.",
      };
    }

    if (
      verifiedDeviceId &&
      !existing.linkedDevices.includes(verifiedDeviceId)
    ) {
      existing.linkedDevices.push(verifiedDeviceId);
    }
    if (params.watchlist && !existing.watchlist) {
      existing.watchlist = params.watchlist;
    }
    await saveUser(existing);
    const profile = await toPublicProfile(existing, verifiedDeviceId);
    return {
      ok: true,
      token: createSessionToken(existing),
      user: profile,
      created: false,
    };
  }

  // Register mode: never log into an existing account
  if (existing) {
    return {
      ok: false,
      error: "An account with this email already exists. Try logging in instead.",
    };
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt, PBKDF2_ITERATIONS);
  const verificationCode = String(crypto.randomInt(100000, 1000000));
  const nameFromEmail = email.split("@")[0].replace(/[._-]+/g, " ");
  const newUser: UserAccount = {
    userId: `usr_${crypto.randomBytes(8).toString("hex")}`,
    email,
    displayName: (params.displayName || nameFromEmail || "HeyBroc Shopper").trim(),
    provider: "email",
    passwordSalt: salt,
    passwordHash: hash,
    passwordIterations: PBKDF2_ITERATIONS,
    emailVerified: false,
    tokenVersion: 0,
    referralCode:
      (isDeviceSecretVerified ? dev?.referralCode : undefined) ||
      codeFromDeviceId(email),
    proUntil: 0,
    isStripePro: false,
    watchlist: params.watchlist,
    linkedDevices: verifiedDeviceId ? [verifiedDeviceId] : [],
    verificationCode,
    verificationExpiresAt: Date.now() + 15 * 60 * 1000,
    verificationAttempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveUser(newUser);
  await sendVerificationEmail(email, verificationCode).catch(() => {});
  const profile = await toPublicProfile(newUser, verifiedDeviceId);
  return {
    ok: true,
    token: createSessionToken(newUser),
    user: profile,
    created: true,
  };
}

interface JwkKey {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  [key: string]: unknown;
}

async function verifyOidcJwtWithJwks(params: {
  idToken: string;
  jwksUrl: string;
  allowedIssuers: string[];
  allowedAudiences: string[];
  expectedEmail: string;
}): Promise<{ ok: boolean; email: string }> {
  try {
    if (params.allowedAudiences.length === 0) {
      return { ok: false, email: "" };
    }
    const parts = (params.idToken || "").trim().split(".");
    if (parts.length !== 3) return { ok: false, email: "" };
    const [headerB64, payloadB64, sigB64] = parts;

    const header = JSON.parse(
      Buffer.from(headerB64, "base64url").toString("utf8")
    ) as { kid?: string; alg?: string };
    if (header.alg !== "RS256" || !header.kid) {
      return { ok: false, email: "" };
    }

    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as {
      iss?: string;
      aud?: string | string[];
      exp?: number;
      email?: string;
      email_verified?: boolean | string;
    };

    if (!payload.iss || !params.allowedIssuers.includes(payload.iss)) {
      return { ok: false, email: "" };
    }
    const audList = Array.isArray(payload.aud)
      ? payload.aud
      : payload.aud
        ? [payload.aud]
        : [];
    const audMatches = audList.some((a) => params.allowedAudiences.includes(a));
    if (!audMatches) {
      return { ok: false, email: "" };
    }
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
      return { ok: false, email: "" };
    }
    const emailVerified =
      payload.email_verified === true || payload.email_verified === "true";
    if (!emailVerified || !payload.email) {
      return { ok: false, email: "" };
    }
    const tokenEmail = normalizeEmail(payload.email);
    if (
      params.expectedEmail &&
      normalizeEmail(params.expectedEmail) !== tokenEmail
    ) {
      return { ok: false, email: "" };
    }

    const res = await fetch(params.jwksUrl, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { ok: false, email: "" };
    const jwks = (await res.json()) as { keys?: JwkKey[] };
    const jwk = jwks.keys?.find((k) => k.kid === header.kid && k.kty === "RSA");
    if (!jwk) return { ok: false, email: "" };

    const publicKey = crypto.createPublicKey({
      key: jwk as unknown as crypto.JsonWebKey,
      format: "jwk",
    });
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
    const signature = Buffer.from(sigB64, "base64url");
    const verified = crypto.verify(
      "RSA-SHA256",
      signingInput,
      publicKey,
      signature
    );
    if (!verified) return { ok: false, email: "" };

    return { ok: true, email: tokenEmail };
  } catch {
    return { ok: false, email: "" };
  }
}

async function verifyGoogleIdToken(
  idToken: string,
  expectedEmail: string
): Promise<{ ok: boolean; email: string }> {
  const allowedAudiences = (
    process.env.GOOGLE_CLIENT_ID ||
    process.env.GOOGLE_OAUTH_CLIENT_IDS ||
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ||
    ""
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return verifyOidcJwtWithJwks({
    idToken,
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    allowedIssuers: ["https://accounts.google.com", "accounts.google.com"],
    allowedAudiences,
    expectedEmail,
  });
}

async function verifyAppleIdToken(
  idToken: string,
  expectedEmail: string
): Promise<{ ok: boolean; email: string }> {
  const allowedAudiences = (
    process.env.APPLE_SERVICE_ID ||
    process.env.APPLE_CLIENT_ID ||
    process.env.APPLE_BUNDLE_ID ||
    ""
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return verifyOidcJwtWithJwks({
    idToken,
    jwksUrl: "https://appleid.apple.com/auth/keys",
    allowedIssuers: ["https://appleid.apple.com"],
    allowedAudiences,
    expectedEmail,
  });
}

export async function loginWithOAuth(params: {
  provider: "google" | "apple";
  email: string;
  idToken?: string;
  password?: string;
  displayName?: string;
  deviceId?: string;
  deviceSecret?: string;
  watchlist?: Record<string, boolean>;
}): Promise<{
  ok: boolean;
  error?: string;
  token?: string;
  user?: PublicUserProfile;
}> {
  if (!params.idToken || !params.idToken.trim()) {
    return {
      ok: false,
      error: "A verified OAuth identity token is required.",
    };
  }

  const verification =
    params.provider === "google"
      ? await verifyGoogleIdToken(params.idToken, params.email)
      : await verifyAppleIdToken(params.idToken, params.email);

  if (!verification.ok || !verification.email) {
    return {
      ok: false,
      error:
        params.provider === "google"
          ? "Invalid or unverified Google ID token."
          : "Invalid or unverified Apple identity token.",
    };
  }

  const email = verification.email;
  const existing = await getUserByEmail(email);
  const cleanDeviceId = (params.deviceId || "").trim();
  const cleanDeviceSecret = (params.deviceSecret || "").trim();
  const dev =
    cleanDeviceId && cleanDeviceId !== "anon-web"
      ? cleanDeviceSecret
        ? await getOrCreateDevice(cleanDeviceId, cleanDeviceSecret)
        : await getExistingDevice(cleanDeviceId)
      : null;
  const isDeviceSecretVerified = Boolean(
    dev && cleanDeviceSecret && verifyDeviceSecret(dev, cleanDeviceSecret)
  );
  const verifiedDeviceId = isDeviceSecretVerified ? cleanDeviceId : undefined;
  const fallbackName = email.split("@")[0].replace(/[._-]+/g, " ");

  const user: UserAccount = existing || {
    userId: `usr_${crypto.randomBytes(8).toString("hex")}`,
    email,
    displayName: (params.displayName || fallbackName || "HeyBroc Shopper").trim(),
    provider: params.provider,
    emailVerified: true,
    tokenVersion: 0,
    referralCode:
      (isDeviceSecretVerified ? dev?.referralCode : undefined) ||
      codeFromDeviceId(email),
    proUntil: 0,
    isStripePro: false,
    watchlist: params.watchlist,
    linkedDevices: verifiedDeviceId ? [verifiedDeviceId] : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  user.emailVerified = true;
  if (existing) {
    if (params.displayName) user.displayName = params.displayName.trim();
    if (verifiedDeviceId && !user.linkedDevices.includes(verifiedDeviceId)) {
      user.linkedDevices.push(verifiedDeviceId);
    }
    if (params.watchlist && !user.watchlist) {
      user.watchlist = params.watchlist;
    }
  }

  await saveUser(user);
  const profile = await toPublicProfile(user, verifiedDeviceId);
  return {
    ok: true,
    token: createSessionToken(user),
    user: profile,
  };
}

export async function resendVerificationCode(rawEmail: string): Promise<{
  ok: boolean;
  error?: string;
  message?: string;
}> {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  const existing = await getUserByEmail(email);
  if (!existing) {
    return { ok: false, error: "Account not found." };
  }
  if (existing.emailVerified) {
    return { ok: true, message: "Your email is already verified." };
  }
  const code = String(crypto.randomInt(100000, 1000000));
  existing.verificationCode = code;
  existing.verificationExpiresAt = Date.now() + 15 * 60 * 1000;
  existing.verificationAttempts = 0;
  await saveUser(existing);
  const sent = await sendVerificationEmail(email, code);
  if (!sent.ok) {
    return {
      ok: false,
      error: sent.error || "Could not send verification email right now.",
    };
  }
  return {
    ok: true,
    message: `Sent a 6-digit verification code to ${email}.`,
  };
}

export async function verifyEmailCode(params: {
  email: string;
  code: string;
  deviceId?: string;
}): Promise<{
  ok: boolean;
  error?: string;
  user?: PublicUserProfile;
}> {
  const email = normalizeEmail(params.email);
  const code = (params.code || "").trim();
  if (!isValidEmail(email) || code.length < 6) {
    return { ok: false, error: "Enter your 6-digit verification code." };
  }
  const existing = await getUserByEmail(email);
  if (!existing) {
    return { ok: false, error: "Invalid or expired verification code." };
  }
  if (existing.emailVerified) {
    return {
      ok: true,
      user: await toPublicProfile(existing, params.deviceId),
    };
  }

  const isExpired =
    !existing.verificationExpiresAt || existing.verificationExpiresAt <= Date.now();
  const matches =
    Boolean(existing.verificationCode) &&
    !isExpired &&
    safeEqualStrings(code, existing.verificationCode!);

  if (!matches) {
    existing.verificationAttempts = (existing.verificationAttempts ?? 0) + 1;
    if (existing.verificationAttempts >= 5) {
      existing.verificationCode = undefined;
      existing.verificationExpiresAt = undefined;
    }
    await saveUser(existing);
    return {
      ok: false,
      error:
        existing.verificationAttempts >= 5
          ? "Too many failed attempts. Please request a new verification code."
          : "Invalid or expired verification code.",
    };
  }

  existing.emailVerified = true;
  existing.verificationCode = undefined;
  existing.verificationExpiresAt = undefined;
  existing.verificationAttempts = 0;
  await saveUser(existing);

  return {
    ok: true,
    user: await toPublicProfile(existing, params.deviceId),
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
    existing.resetAttempts = 0;
    await saveUser(existing);
    await sendPasswordResetEmail(email, code).catch(() => {});
  }
  // Never leak resetCode in the HTTP response
  return {
    ok: true,
    message: `If an account exists for ${email}, a 6-digit reset code has been sent to that email.`,
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
  if (!params.newPassword || params.newPassword.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  const existing = await getUserByEmail(email);
  if (!existing) {
    return { ok: false, error: "Invalid or expired reset code." };
  }

  let authorized = false;
  if (params.resetCode) {
    const isExpired =
      !existing.resetExpiresAt || existing.resetExpiresAt <= Date.now();
    if (
      existing.resetCode &&
      !isExpired &&
      safeEqualStrings(params.resetCode.trim(), existing.resetCode)
    ) {
      authorized = true;
      existing.emailVerified = true;
    } else {
      existing.resetAttempts = (existing.resetAttempts ?? 0) + 1;
      if (existing.resetAttempts >= 5) {
        existing.resetCode = undefined;
        existing.resetExpiresAt = undefined;
      }
      await saveUser(existing);
      return {
        ok: false,
        error:
          existing.resetAttempts >= 5
            ? "Too many failed attempts. Please request a new password reset code."
            : "Invalid or expired 6-digit reset code.",
      };
    }
  } else if (
    params.currentPassword &&
    (await verifyPasswordAndUpgrade(existing, params.currentPassword))
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
  const hash = hashPassword(params.newPassword, salt, PBKDF2_ITERATIONS);

  existing.passwordSalt = salt;
  existing.passwordHash = hash;
  existing.passwordIterations = PBKDF2_ITERATIONS;
  existing.tokenVersion = (existing.tokenVersion ?? 0) + 1;
  existing.resetCode = undefined;
  existing.resetExpiresAt = undefined;
  existing.resetAttempts = 0;
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
  try {
    const existing = await kvGet<UserAccount>(`${USER_EMAIL_PREFIX}${email}`);
    if (!existing || existing.deleted) return false;
    const nextTokenVersion = (existing.tokenVersion ?? 0) + 1;

    // Remove email index from entitlements and pseudonymize customerEmail on any linked subscription
    const emailEnt = await getEmailEntitlement(email).catch(() => null);
    if (emailEnt) {
      await kvDel(`heybroc:entitlement:email:${email}`).catch(() => {});
      if (emailEnt.customerEmail?.toLowerCase() === email) {
        await saveEntitlement({
          ...emailEnt,
          customerEmail: undefined,
        }).catch(() => {});
      }
    }

    await kvSet(
      `${USER_EMAIL_PREFIX}${email}`,
      {
        userId: existing.userId,
        email,
        deleted: true,
        tokenVersion: nextTokenVersion,
        updatedAt: new Date().toISOString(),
      },
      KV_TTL_SECONDS
    );
    return true;
  } catch {
    return false;
  }
}

