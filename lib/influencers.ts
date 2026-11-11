/**
 * CleanCart — Influencer / Creator affiliate & payout store (server-only).
 *
 * Each creator is stored under its own Redis Hash key (`heybroc:creator:item:<CODE>`)
 * with an index set (`heybroc:creators:codes`), using `HINCRBY` and `HINCRBYFLOAT`
 * for atomic counter updates so concurrent public clicks, Stripe/RevenueCat payments,
 * refunds/disputes, and creator payouts never overwrite each other.
 *
 * Read errors from KV propagate instead of catching and reseeding over existing data.
 */
import "server-only";
import crypto from "node:crypto";
import { PRICING, commissionFor, type PlanId } from "./pricing";
import {
  kvAtomicHashUpdateOnce,
  kvDel,
  kvEvalLua,
  kvGet,
  kvHGetAll,
  kvHIncrBy,
  kvHIncrByFloat,
  kvHSet,
  kvSAdd,
  kvSMembers,
  kvSRem,
  kvSet,
} from "./storage";

export type CreatorPayoutMethod =
  | "stripe_connect"
  | "paypal"
  | "venmo"
  | "zelle"
  | "ach"
  | "manual";

export interface Creator {
  code: string;
  name: string;
  active: boolean;
  commissionPct: number;
  clicks: number;
  trials: number;
  paidAnnual: number;
  paidMonthly: number;
  grossRevenue: number;
  /** Lifetime net commissions earned (after refunds/disputes). */
  commissionEarned: number;
  /** Lifetime commissions already paid out to the creator. */
  commissionPaid: number;
  /** Current unpaid commission balance owed to the creator. */
  commissionOwed: number;
  /** Net revenue retained by HeyBroc after creator commissions. */
  netRevenue: number;
  payoutEmail?: string;
  payoutEmailVerified?: boolean;
  payoutMethod?: CreatorPayoutMethod;
  payoutHandle?: string;
  stripeConnectAccountId?: string;
  tokenNonce?: string;
  lastPayoutAt?: string;
  createdAt: string;
}

export type CreatorRecord = Creator;

export interface CreatorPayoutRecord {
  id: string;
  code: string;
  amount: number;
  currency: "usd";
  method: CreatorPayoutMethod;
  status: "paid" | "pending" | "failed";
  destination?: string;
  stripeTransferId?: string;
  note?: string;
  createdAt: string;
}

export type CreatorEvent =
  | "click"
  | "trial"
  | "paid_annual"
  | "paid_monthly"
  | "checkout_annual";

const LEGACY_CREATORS_KV_KEY = "heybroc:creators:v1";
const CREATOR_CODES_SET_KEY = "heybroc:creators:codes";
const CREATOR_HASH_PREFIX = "heybroc:creator:item:";
const CREATOR_PAYOUTS_PREFIX = "heybroc:creator:payouts:";
const RECENT_PAYOUTS_KEY = "heybroc:creator:payouts:__recent__";
const CREATORS_SEEDED_KEY = "heybroc:creators:seeded:v2";
const PAYOUT_TTL_SECONDS = 5 * 365 * 86400; // Retain payout tax/audit records for 5 years
const CREATOR_TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30-day bounded creator token lifetime

const SEED: Array<Pick<Creator, "code" | "name">> = [
  { code: "CLEANMOM", name: "Clean Mom Club" },
  { code: "GROCERYHAUL", name: "Grocery Haul Daily" },
  { code: "SARAHHAULS", name: "Sarah Grocery Hauls" },
  { code: "PARENTMAXX", name: "ParentMaxxing Official" },
];

const VALID_PAYOUT_METHODS = new Set<CreatorPayoutMethod>([
  "stripe_connect",
  "paypal",
  "venmo",
  "zelle",
  "ach",
  "manual",
]);

const round2 = (n: number) => Math.round(n * 100) / 100;

function getCreatorSigningSecret(): string {
  const secret = (
    process.env.AUTH_SECRET ||
    process.env.HEYBROC_ADMIN_SECRET ||
    ""
  ).trim();
  if (!secret) {
    if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
      throw new Error("AUTH_SECRET or HEYBROC_ADMIN_SECRET is required.");
    }
    return "local-dev-only-heybroc-creator-secret";
  }
  return secret;
}

export function generateCreatorTokenNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function createCreatorAccessToken(
  rawCode: string,
  opts?: {
    payoutEmail?: string | null;
    tokenNonce?: string | null;
    expiresInSec?: number;
  } | null
): string {
  const code = normalizeCode(rawCode);
  const normEmail = normalizeEmailOpt(opts?.payoutEmail ?? undefined) || "";
  const normNonce = (opts?.tokenNonce || "").trim();
  const ttlSec =
    typeof opts?.expiresInSec === "number" && Number.isFinite(opts.expiresInSec)
      ? Math.max(1, Math.floor(opts.expiresInSec))
      : CREATOR_TOKEN_TTL_SEC;
  const expSec = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = crypto
    .createHmac("sha256", getCreatorSigningSecret())
    .update(`creator:v2:${code}:${expSec}:${normEmail}:${normNonce}`, "utf8")
    .digest("base64url");
  return `hbc_${code}.${expSec}.${sig}`;
}

export function verifyCreatorAccessToken(
  rawCode: string,
  candidateToken?: string | null,
  creator?: Pick<CreatorRecord, "payoutEmail" | "tokenNonce"> | null
): boolean {
  const code = normalizeCode(rawCode);
  const clean = (candidateToken || "").trim();
  const prefix = `hbc_${code}.`;
  if (!code || !clean || !clean.startsWith(prefix)) return false;
  const rest = clean.slice(prefix.length);
  const dotIdx = rest.indexOf(".");
  if (dotIdx <= 0) return false;
  const expStr = rest.slice(0, dotIdx);
  const sig = rest.slice(dotIdx + 1);
  if (!/^\d{9,12}$/.test(expStr) || !sig) return false;
  const expSec = Number(expStr);
  if (!Number.isFinite(expSec) || expSec <= Math.floor(Date.now() / 1000)) {
    return false;
  }
  const normEmail = normalizeEmailOpt(creator?.payoutEmail ?? undefined) || "";
  const normNonce = (creator?.tokenNonce || "").trim();
  let expectedSig: string;
  try {
    expectedSig = crypto
      .createHmac("sha256", getCreatorSigningSecret())
      .update(`creator:v2:${code}:${expSec}:${normEmail}:${normNonce}`, "utf8")
      .digest("base64url");
  } catch {
    return false;
  }
  const bufA = Buffer.from(sig, "utf8");
  const bufB = Buffer.from(expectedSig, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function normalizeCode(code: string): string {
  return (code || "").toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 24);
}

function creatorKey(code: string): string {
  return `${CREATOR_HASH_PREFIX}${normalizeCode(code)}`;
}

function creatorPayoutsKey(code: string): string {
  return `${CREATOR_PAYOUTS_PREFIX}${normalizeCode(code)}`;
}

function normalizePayoutMethod(raw?: string): CreatorPayoutMethod | undefined {
  if (!raw) return undefined;
  const clean = raw.trim().toLowerCase() as CreatorPayoutMethod;
  return VALID_PAYOUT_METHODS.has(clean) ? clean : undefined;
}

function normalizeEmailOpt(raw?: string): string | undefined {
  if (!raw) return undefined;
  const clean = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean) ? clean : undefined;
}

function blank(
  code: string,
  name: string,
  commissionPct: number = PRICING.defaultCommissionPct
): Creator {
  return {
    code,
    name,
    active: true,
    commissionPct,
    clicks: 0,
    trials: 0,
    paidAnnual: 0,
    paidMonthly: 0,
    grossRevenue: 0,
    commissionEarned: 0,
    commissionPaid: 0,
    commissionOwed: 0,
    netRevenue: 0,
    createdAt: new Date().toISOString(),
  };
}

function hashToCreator(
  code: string,
  fields: Record<string, string> | null
): Creator | null {
  if (!fields || !fields.code) return null;
  const grossRevenue = Math.max(0, round2(Number(fields.grossRevenue ?? 0)));
  const commissionPaid = Math.max(0, round2(Number(fields.commissionPaid ?? 0)));
  const commissionOwed = Math.max(0, round2(Number(fields.commissionOwed ?? 0)));
  const rawEarned =
    fields.commissionEarned !== undefined
      ? Number(fields.commissionEarned)
      : commissionOwed + commissionPaid;
  const commissionEarned = Math.max(
    commissionPaid,
    Math.max(0, round2(rawEarned))
  );
  const active =
    fields.active === undefined
      ? true
      : fields.active !== "0" && fields.active !== "false";
  const payoutEmailVerified =
    fields.payoutEmailVerified === undefined || fields.payoutEmailVerified === ""
      ? undefined
      : fields.payoutEmailVerified === "1" ||
        fields.payoutEmailVerified === "true";

  return {
    code: fields.code || code,
    name: fields.name || code,
    active,
    commissionPct: clampPct(
      fields.commissionPct !== undefined
        ? Number(fields.commissionPct)
        : PRICING.defaultCommissionPct
    ),
    clicks: Math.max(0, Math.trunc(Number(fields.clicks ?? 0))),
    trials: Math.max(0, Math.trunc(Number(fields.trials ?? 0))),
    paidAnnual: Math.max(0, Math.trunc(Number(fields.paidAnnual ?? 0))),
    paidMonthly: Math.max(0, Math.trunc(Number(fields.paidMonthly ?? 0))),
    grossRevenue,
    commissionEarned,
    commissionPaid,
    commissionOwed,
    netRevenue: round2(grossRevenue - commissionEarned),
    payoutEmail: fields.payoutEmail || undefined,
    payoutEmailVerified,
    payoutMethod: normalizePayoutMethod(fields.payoutMethod),
    payoutHandle: fields.payoutHandle || undefined,
    stripeConnectAccountId: fields.stripeConnectAccountId || undefined,
    tokenNonce: fields.tokenNonce || undefined,
    lastPayoutAt: fields.lastPayoutAt || undefined,
    createdAt: fields.createdAt || new Date().toISOString(),
  };
}

async function saveCreatorHash(c: Creator): Promise<void> {
  const hashFields: Record<string, string | number> = {
    code: c.code,
    name: c.name,
    active: c.active ? "1" : "0",
    commissionPct: c.commissionPct,
    clicks: c.clicks,
    trials: c.trials,
    paidAnnual: c.paidAnnual,
    paidMonthly: c.paidMonthly,
    grossRevenue: round2(c.grossRevenue),
    commissionEarned: round2(c.commissionEarned),
    commissionPaid: round2(c.commissionPaid),
    commissionOwed: round2(c.commissionOwed),
    createdAt: c.createdAt,
  };
  if (c.payoutEmail !== undefined) hashFields.payoutEmail = c.payoutEmail;
  if (c.payoutEmailVerified !== undefined) {
    hashFields.payoutEmailVerified = c.payoutEmailVerified ? "1" : "0";
  }
  if (c.payoutMethod !== undefined) hashFields.payoutMethod = c.payoutMethod;
  if (c.payoutHandle !== undefined) hashFields.payoutHandle = c.payoutHandle;
  if (c.stripeConnectAccountId !== undefined) {
    hashFields.stripeConnectAccountId = c.stripeConnectAccountId;
  }
  if (c.tokenNonce !== undefined) hashFields.tokenNonce = c.tokenNonce;
  if (c.lastPayoutAt !== undefined) hashFields.lastPayoutAt = c.lastPayoutAt;

  await kvHSet(creatorKey(c.code), hashFields);
  await kvSAdd(CREATOR_CODES_SET_KEY, c.code);
}

/**
 * One-time initialization / migration from legacy array if `heybroc:creators:seeded:v2` is not set.
 * IMPORTANT: Any KV error throws instead of catching and overwriting existing data.
 */
async function ensureInitialized(): Promise<void> {
  const alreadySeeded = await kvGet<string>(CREATORS_SEEDED_KEY);
  if (alreadySeeded === "1") return;

  const legacy = await kvGet<Creator[]>(LEGACY_CREATORS_KV_KEY);
  if (Array.isArray(legacy) && legacy.length > 0) {
    for (const item of legacy) {
      const code = normalizeCode(item.code);
      if (!code) continue;
      const existing = await kvHGetAll(creatorKey(code));
      if (!existing) {
        await saveCreatorHash({
          ...blank(code, item.name || code, item.commissionPct),
          ...item,
          code,
        });
      }
    }
  } else {
    for (const s of SEED) {
      const existing = await kvHGetAll(creatorKey(s.code));
      if (!existing) {
        await saveCreatorHash(blank(s.code, s.name));
      }
    }
  }

  await kvSet(CREATORS_SEEDED_KEY, "1");
}

export async function getCreator(code: string): Promise<Creator | null> {
  await ensureInitialized();
  const norm = normalizeCode(code);
  if (!norm) return null;
  const fields = await kvHGetAll(creatorKey(norm));
  return hashToCreator(norm, fields);
}

export async function listCreators(): Promise<Creator[]> {
  await ensureInitialized();
  const codes = await kvSMembers(CREATOR_CODES_SET_KEY);
  const results = await Promise.all(
    codes.map(async (code) => {
      const norm = normalizeCode(code);
      if (!norm) return null;
      const fields = await kvHGetAll(creatorKey(norm));
      return hashToCreator(norm, fields);
    })
  );
  return results
    .filter((c): c is Creator => c !== null)
    .sort((a, b) => b.netRevenue - a.netRevenue || a.code.localeCompare(b.code));
}

export async function createCreator(input: {
  code: string;
  name?: string;
  commissionPct?: number;
  payoutEmail?: string;
  payoutEmailVerified?: boolean;
  payoutMethod?: CreatorPayoutMethod;
  payoutHandle?: string;
  stripeConnectAccountId?: string;
  tokenNonce?: string;
  active?: boolean;
}): Promise<Creator> {
  await ensureInitialized();
  const code = normalizeCode(input.code);
  if (code.length < 2) {
    throw new Error("Creator code must be at least 2 letters/numbers.");
  }
  if (code.startsWith("BROC")) {
    throw new Error("Codes starting with BROC are reserved for friend invite codes.");
  }

  const existing = await getCreator(code);
  if (existing) {
    return updateCreator(code, {
      commissionPct: input.commissionPct,
      name: input.name,
      payoutEmail: input.payoutEmail,
      payoutEmailVerified: input.payoutEmailVerified,
      payoutMethod: input.payoutMethod,
      payoutHandle: input.payoutHandle,
      stripeConnectAccountId: input.stripeConnectAccountId,
      active: input.active,
    });
  }

  const pct = clampPct(input.commissionPct ?? PRICING.defaultCommissionPct);
  const cleanEmail = normalizeEmailOpt(input.payoutEmail);
  const created: Creator = {
    ...blank(code, input.name?.trim() || code, pct),
    active: input.active ?? true,
    payoutEmail: cleanEmail,
    payoutEmailVerified:
      input.payoutEmailVerified !== undefined
        ? Boolean(input.payoutEmailVerified)
        : cleanEmail
          ? true
          : undefined,
    payoutMethod: normalizePayoutMethod(input.payoutMethod),
    payoutHandle: input.payoutHandle?.trim().slice(0, 120) || undefined,
    stripeConnectAccountId: input.stripeConnectAccountId?.trim() || undefined,
    tokenNonce: input.tokenNonce?.trim() || generateCreatorTokenNonce(),
  };
  await saveCreatorHash(created);
  return created;
}

export async function updateCreator(
  code: string,
  patch: {
    commissionPct?: number;
    name?: string;
    active?: boolean;
    payoutEmail?: string;
    payoutEmailVerified?: boolean;
    payoutMethod?: CreatorPayoutMethod;
    payoutHandle?: string;
    stripeConnectAccountId?: string;
    rotateTokenNonce?: boolean;
  }
): Promise<Creator> {
  await ensureInitialized();
  const norm = normalizeCode(code);
  const existing = await getCreator(norm);
  if (!existing) throw new Error("Unknown creator code.");

  const patchFields: Record<string, string | number> = {};
  let shouldRotateNonce = Boolean(patch.rotateTokenNonce);

  if (patch.commissionPct !== undefined) {
    existing.commissionPct = clampPct(patch.commissionPct);
    patchFields.commissionPct = existing.commissionPct;
  }
  if (patch.name?.trim()) {
    existing.name = patch.name.trim().slice(0, 80);
    patchFields.name = existing.name;
  }
  if (patch.active !== undefined) {
    existing.active = Boolean(patch.active);
    patchFields.active = existing.active ? "1" : "0";
  }
  if (patch.payoutEmail !== undefined) {
    const prevEmail = (existing.payoutEmail || "").trim().toLowerCase();
    const cleanEmail = normalizeEmailOpt(patch.payoutEmail) || "";
    if (cleanEmail !== prevEmail) {
      shouldRotateNonce = true;
    }
    existing.payoutEmail = cleanEmail || undefined;
    patchFields.payoutEmail = cleanEmail;
  }
  if (patch.payoutEmailVerified !== undefined) {
    const nextVerified = Boolean(patch.payoutEmailVerified);
    if (nextVerified !== existing.payoutEmailVerified) {
      shouldRotateNonce = true;
    }
    existing.payoutEmailVerified = nextVerified;
    patchFields.payoutEmailVerified = nextVerified ? "1" : "0";
  }
  if (patch.payoutMethod !== undefined) {
    const cleanMethod = normalizePayoutMethod(patch.payoutMethod);
    existing.payoutMethod = cleanMethod;
    patchFields.payoutMethod = cleanMethod || "";
  }
  if (patch.payoutHandle !== undefined) {
    const cleanHandle = patch.payoutHandle.trim().slice(0, 120);
    existing.payoutHandle = cleanHandle || undefined;
    patchFields.payoutHandle = cleanHandle;
  }
  if (patch.stripeConnectAccountId !== undefined) {
    const cleanAcct = patch.stripeConnectAccountId.trim().slice(0, 80);
    existing.stripeConnectAccountId = cleanAcct || undefined;
    patchFields.stripeConnectAccountId = cleanAcct;
  }
  if (shouldRotateNonce || !existing.tokenNonce) {
    const nextNonce = generateCreatorTokenNonce();
    existing.tokenNonce = nextNonce;
    patchFields.tokenNonce = nextNonce;
  }

  if (Object.keys(patchFields).length > 0) {
    await kvHSet(creatorKey(norm), patchFields);
  }
  await kvSAdd(CREATOR_CODES_SET_KEY, norm);
  return (await getCreator(norm)) ?? existing;
}

export async function deleteCreator(code: string): Promise<void> {
  await ensureInitialized();
  const norm = normalizeCode(code);
  if (!norm) return;
  const existing = await getCreator(norm);
  if (existing && (existing.grossRevenue > 0 || existing.commissionPaid > 0 || existing.commissionOwed > 0)) {
    // Preserve financial audit ledger by deactivating instead of wiping historical revenue/payouts
    await updateCreator(norm, { active: false });
    return;
  }
  await kvSRem(CREATOR_CODES_SET_KEY, norm);
  await kvDel(creatorKey(norm));
}

/**
 * Records a funnel event using atomic Redis Hash increments (`HINCRBY` / `HINCRBYFLOAT`).
 */
export async function trackEvent(
  code: string,
  event: CreatorEvent
): Promise<Creator> {
  await ensureInitialized();
  const norm = normalizeCode(code);
  const c = await getCreator(norm);
  if (!c || !c.active) throw new Error("Invalid creator code.");

  const key = creatorKey(norm);

  const creditPlan = async (plan: PlanId) => {
    const price = plan === "annual" ? PRICING.annual : PRICING.monthly;
    const comm = commissionFor(plan, c.commissionPct);
    await kvHIncrByFloat(key, "grossRevenue", price);
    await kvHIncrByFloat(key, "commissionEarned", comm);
    await kvHIncrByFloat(key, "commissionOwed", comm);
  };

  if (event === "click") {
    await kvHIncrBy(key, "clicks", 1);
  } else if (event === "trial") {
    await kvHIncrBy(key, "trials", 1);
  } else if (event === "paid_annual") {
    await kvHIncrBy(key, "paidAnnual", 1);
    await creditPlan("annual");
  } else if (event === "checkout_annual") {
    await kvHIncrBy(key, "trials", 1);
    await kvHIncrBy(key, "paidAnnual", 1);
    await creditPlan("annual");
  } else if (event === "paid_monthly") {
    await kvHIncrBy(key, "paidMonthly", 1);
    await creditPlan("monthly");
  }

  const updated = await getCreator(norm);
  if (!updated) throw new Error("Failed to reload creator after event.");
  return updated;
}

interface CreatorConversionMeta {
  code: string;
  blockedSelfDeal: boolean;
  commissionCents: number;
  grossUsd: number;
  buyerEmail?: string;
}

export interface CreatorRefundOptions {
  buyerEmail?: string;
  originalConversionKey?: string;
  otoOffer?: string;
  originalPreTaxUsd?: number;
  refundRatio?: number;
}

const ALLOWED_CONNECT_ORIGINS = new Set([
  "https://heybroc.com",
  "https://www.heybroc.com",
  "https://cleancart.vercel.app",
  "https://cleancart-teal.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

export function resolveSafeConnectOrigin(raw?: string | null): string {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (configured && /^https?:\/\//i.test(configured)) {
    ALLOWED_CONNECT_ORIGINS.add(configured);
  }
  const clean = (raw || "").trim().replace(/\/+$/, "");
  if (clean && ALLOWED_CONNECT_ORIGINS.has(clean)) return clean;
  return configured && /^https?:\/\//i.test(configured)
    ? configured
    : "https://heybroc.com";
}

/**
 * Idempotently records a creator conversion from a verified Stripe/RevenueCat webhook event.
 * Uses `kvAtomicHashUpdateOnce` so concurrent webhook deliveries cannot double-credit the ledger.
 */
export async function recordStripeCreatorConversionOnce(
  idempotencyKey: string,
  code: string,
  event: CreatorEvent,
  amountPaidUsd?: number,
  buyerEmail?: string
): Promise<Creator | null> {
  const norm = normalizeCode(code);
  if (!norm) return null;
  const creator = await getCreator(norm);
  if (!creator || !creator.active) return null;

  const cleanBuyerEmail = buyerEmail?.trim().toLowerCase() || undefined;
  const metaKey = `heybroc:creator:conv_meta:${idempotencyKey}`;

  // Anti-self-dealing guard: creators cannot earn affiliate commission on their own personal email purchase
  if (
    cleanBuyerEmail &&
    creator.payoutEmail &&
    cleanBuyerEmail === creator.payoutEmail.trim().toLowerCase()
  ) {
    await kvSet<CreatorConversionMeta>(
      metaKey,
      {
        code: norm,
        blockedSelfDeal: true,
        commissionCents: 0,
        grossUsd: 0,
        buyerEmail: cleanBuyerEmail,
      },
      400 * 24 * 60 * 60
    ).catch(() => {});
    return creator;
  }

  const markerKey = `heybroc:creator:conv:${idempotencyKey}`;
  const key = creatorKey(norm);
  const deltas: Array<{ field: string; delta: number; isFloat?: boolean }> = [];
  let recordedGross = 0;
  let recordedComm = 0;

  const resolveGrossAndComm = (plan: PlanId) => {
    const gross =
      typeof amountPaidUsd === "number" &&
      Number.isFinite(amountPaidUsd) &&
      amountPaidUsd > 0
        ? round2(amountPaidUsd)
        : plan === "annual"
          ? PRICING.annual
          : PRICING.monthly;
    const comm =
      typeof amountPaidUsd === "number" &&
      Number.isFinite(amountPaidUsd) &&
      amountPaidUsd > 0
        ? round2((gross * creator.commissionPct) / 100)
        : commissionFor(plan, creator.commissionPct);
    return { gross, comm };
  };

  if (event === "click") {
    deltas.push({ field: "clicks", delta: 1 });
  } else if (event === "trial") {
    deltas.push({ field: "trials", delta: 1 });
  } else if (event === "paid_annual") {
    const { gross, comm } = resolveGrossAndComm("annual");
    recordedGross = gross;
    recordedComm = comm;
    deltas.push(
      { field: "paidAnnual", delta: 1 },
      { field: "grossRevenue", delta: gross, isFloat: true },
      { field: "commissionEarned", delta: comm, isFloat: true },
      { field: "commissionOwed", delta: comm, isFloat: true }
    );
  } else if (event === "checkout_annual") {
    const { gross, comm } = resolveGrossAndComm("annual");
    recordedGross = gross;
    recordedComm = comm;
    deltas.push(
      { field: "trials", delta: 1 },
      { field: "paidAnnual", delta: 1 },
      { field: "grossRevenue", delta: gross, isFloat: true },
      { field: "commissionEarned", delta: comm, isFloat: true },
      { field: "commissionOwed", delta: comm, isFloat: true }
    );
  } else if (event === "paid_monthly") {
    const { gross, comm } = resolveGrossAndComm("monthly");
    recordedGross = gross;
    recordedComm = comm;
    deltas.push(
      { field: "paidMonthly", delta: 1 },
      { field: "grossRevenue", delta: gross, isFloat: true },
      { field: "commissionEarned", delta: comm, isFloat: true },
      { field: "commissionOwed", delta: comm, isFloat: true }
    );
  }

  const applied = await kvAtomicHashUpdateOnce(
    markerKey,
    key,
    deltas,
    60 * 60 * 24 * 365
  );
  if (applied && (recordedGross > 0 || recordedComm > 0)) {
    await kvSet<CreatorConversionMeta>(
      metaKey,
      {
        code: norm,
        blockedSelfDeal: false,
        commissionCents: Math.round(recordedComm * 100),
        grossUsd: recordedGross,
        buyerEmail: cleanBuyerEmail,
      },
      400 * 24 * 60 * 60
    ).catch(() => {});
  }
  return getCreator(norm);
}

export const recordCreatorConversion = recordStripeCreatorConversionOnce;

/**
 * Idempotently claws back creator revenue & commission when a charge is refunded or disputed.
 * Never subtracts phantom commission when the original conversion was blocked for self-dealing
 * (`commissionCents === 0`), and enforces pre-tax plan/OTO price caps on proportional clawbacks.
 */
export async function recordStripeCreatorRefundOnce(
  idempotencyKey: string,
  code: string,
  plan: PlanId,
  refundAmountUsd?: number,
  isFullRefundOverride?: boolean,
  options?: CreatorRefundOptions
): Promise<Creator | null> {
  const norm = normalizeCode(code);
  if (!norm) return null;
  const creator = await getCreator(norm);
  if (!creator) return null;

  const cleanBuyerEmail = options?.buyerEmail?.trim().toLowerCase() || "";
  if (
    cleanBuyerEmail &&
    creator.payoutEmail &&
    cleanBuyerEmail === creator.payoutEmail.trim().toLowerCase()
  ) {
    return creator;
  }

  let convMeta: CreatorConversionMeta | null = null;
  if (options?.originalConversionKey) {
    convMeta = await kvGet<CreatorConversionMeta>(
      `heybroc:creator:conv_meta:${options.originalConversionKey}`
    ).catch(() => null);
    if (convMeta && (convMeta.blockedSelfDeal || convMeta.commissionCents <= 0)) {
      return creator;
    }
  }

  const markerKey = `heybroc:creator:refund:${idempotencyKey}`;
  const planPriceCap =
    options?.otoOffer === "oto_gift_year"
      ? PRICING.otoExtraYearPass
      : options?.otoOffer === "oto_annual"
        ? PRICING.otoAnnualLockIn
        : plan === "annual"
          ? PRICING.annual
          : PRICING.monthly;
  const effectiveCap =
    convMeta && typeof convMeta.grossUsd === "number" && convMeta.grossUsd > 0
      ? Math.min(planPriceCap, convMeta.grossUsd)
      : options?.originalPreTaxUsd && options.originalPreTaxUsd > 0
        ? Math.min(planPriceCap, round2(options.originalPreTaxUsd))
        : planPriceCap;

  const hasValidRatio =
    typeof options?.refundRatio === "number" &&
    Number.isFinite(options.refundRatio) &&
    options.refundRatio > 0 &&
    options.refundRatio <= 1;

  const requestedGross =
    hasValidRatio &&
    (refundAmountUsd === undefined || round2(refundAmountUsd) > effectiveCap)
      ? round2(effectiveCap * options!.refundRatio!)
      : refundAmountUsd !== undefined && refundAmountUsd > 0
        ? Math.min(effectiveCap, round2(refundAmountUsd))
        : effectiveCap;

  const grossDelta = Math.min(creator.grossRevenue, requestedGross);
  const rawCommDelta = round2(grossDelta * (creator.commissionPct / 100));
  const maxConvCommUsd =
    convMeta && convMeta.commissionCents > 0
      ? round2(convMeta.commissionCents / 100)
      : rawCommDelta;
  const cappedCommDelta = Math.min(rawCommDelta, maxConvCommUsd);
  const earnedDelta = Math.min(
    Math.max(0, creator.commissionEarned - creator.commissionPaid),
    cappedCommDelta
  );
  const owedDelta = Math.min(creator.commissionOwed, cappedCommDelta);

  const isFullRefund =
    isFullRefundOverride ??
    (grossDelta >= effectiveCap * 0.99 ||
      requestedGross >= PRICING.otoExtraYearPass * 0.99);
  const planField = plan === "annual" ? "paidAnnual" : "paidMonthly";
  const currentPlanCount =
    plan === "annual" ? creator.paidAnnual : creator.paidMonthly;

  const deltas: Array<{ field: string; delta: number; isFloat?: boolean }> = [];
  if (isFullRefund && currentPlanCount > 0 && grossDelta > 0) {
    deltas.push({ field: planField, delta: -1 });
  }
  if (grossDelta > 0) {
    deltas.push({ field: "grossRevenue", delta: -grossDelta, isFloat: true });
  }
  if (earnedDelta > 0) {
    deltas.push({
      field: "commissionEarned",
      delta: -earnedDelta,
      isFloat: true,
    });
  }
  if (owedDelta > 0) {
    deltas.push({ field: "commissionOwed", delta: -owedDelta, isFloat: true });
  }

  const key = creatorKey(norm);
  await kvAtomicHashUpdateOnce(markerKey, key, deltas, 60 * 60 * 24 * 365);
  return getCreator(norm);
}

export const clawbackCreatorCommission = recordStripeCreatorRefundOnce;

/**
 * Lists payout history for a specific creator code (or recent payouts across all creators).
 */
export async function listCreatorPayouts(
  code?: string
): Promise<CreatorPayoutRecord[]> {
  await ensureInitialized();
  if (code) {
    const norm = normalizeCode(code);
    if (!norm) return [];
    const list = await kvGet<CreatorPayoutRecord[]>(creatorPayoutsKey(norm));
    return Array.isArray(list) ? list : [];
  }
  const recent = await kvGet<CreatorPayoutRecord[]>(RECENT_PAYOUTS_KEY);
  return Array.isArray(recent) ? recent : [];
}

/**
 * Executes an affiliate payout (optionally creating a live Stripe Connect `/v1/transfers` transfer)
 * by atomically reserving `commissionOwed` via `kvEvalLua` BEFORE calling Stripe `/v1/transfers`,
 * and atomically rolling back the reservation if the Stripe transfer fails.
 */
export async function executeCreatorPayout(params: {
  code: string;
  amount?: number;
  method?: CreatorPayoutMethod;
  executeStripeTransfer?: boolean;
  destination?: string;
  note?: string;
  idempotencyKey?: string;
}): Promise<{ creator: Creator; payout: CreatorPayoutRecord }> {
  await ensureInitialized();
  const norm = normalizeCode(params.code);
  const creator = await getCreator(norm);
  if (!creator) {
    throw new Error("Unknown creator code.");
  }

  if (params.amount !== undefined) {
    const requested = round2(Number(params.amount));
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new Error("Payout amount must be greater than $0.00.");
    }
  }

  const method: CreatorPayoutMethod =
    normalizePayoutMethod(params.method) ||
    creator.payoutMethod ||
    (creator.stripeConnectAccountId ? "stripe_connect" : "manual");

  const willExecuteStripeTransfer = Boolean(
    (params.executeStripeTransfer || method === "stripe_connect") &&
      params.executeStripeTransfer !== false &&
      method === "stripe_connect"
  );

  const stripeKey = (process.env.STRIPE_SECRET_KEY || "").trim();
  const connectAcct = (
    params.destination?.trim() ||
    creator.stripeConnectAccountId ||
    ""
  ).trim();

  if (willExecuteStripeTransfer) {
    if (!connectAcct || !connectAcct.startsWith("acct_")) {
      throw new Error(
        `Creator ${norm} does not have a connected Stripe Express account (acct_...) yet. Ask them to connect on /creators or record a PayPal/Venmo/manual payout.`
      );
    }
    if (!stripeKey) {
      throw new Error(
        "STRIPE_SECRET_KEY is not configured on this server to execute a live Stripe Connect transfer."
      );
    }
  }

  const payoutId =
    params.idempotencyKey?.trim() ||
    `po_${norm}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const markerKey = `heybroc:creator:payout_once:${payoutId}`;
  const key = creatorKey(norm);
  const requestedArg =
    params.amount !== undefined ? String(round2(Number(params.amount))) : "";

  const reserveLua = [
    'if redis.call("EXISTS", KEYS[1]) == 1 then',
    '  return {"DUPLICATE", redis.call("GET", KEYS[1]) or "1"}',
    "end",
    'local owedRaw = redis.call("HGET", KEYS[2], "commissionOwed")',
    'local owed = tonumber(owedRaw or "0") or 0',
    "owed = math.floor(owed * 100 + 0.5) / 100",
    "if owed <= 0 then",
    '  return {"NO_BALANCE", "0"}',
    "end",
    "local reqStr = ARGV[1]",
    "local amt = owed",
    'if reqStr ~= "" then',
    "  amt = tonumber(reqStr) or 0",
    "  amt = math.floor(amt * 100 + 0.5) / 100",
    "  if amt <= 0 then",
    '    return {"INVALID_AMOUNT", "0"}',
    "  end",
    "  if amt > owed + 0.005 then",
    '    return {"EXCEEDS_BALANCE", tostring(owed)}',
    "  end",
    "  if amt > owed then",
    "    amt = owed",
    "  end",
    "end",
    'redis.call("SET", KEYS[1], "reserved", "EX", tonumber(ARGV[2]))',
    'redis.call("HINCRBYFLOAT", KEYS[2], "commissionOwed", -amt)',
    'redis.call("HINCRBYFLOAT", KEYS[2], "commissionPaid", amt)',
    'return {"OK", tostring(amt)}',
  ].join("\n");

  const reserveResult = await kvEvalLua<[string, string]>(
    reserveLua,
    [markerKey, key],
    [requestedArg, Math.floor(PAYOUT_TTL_SECONDS)],
    async () => {
      const existingMarker = await kvGet<string>(markerKey);
      if (existingMarker !== null) {
        return ["DUPLICATE", existingMarker];
      }
      const latest = await getCreator(norm);
      const owed = round2(latest?.commissionOwed ?? 0);
      if (owed <= 0) {
        return ["NO_BALANCE", "0"];
      }
      let amt = owed;
      if (requestedArg !== "") {
        amt = round2(Number(requestedArg));
        if (!Number.isFinite(amt) || amt <= 0) {
          return ["INVALID_AMOUNT", "0"];
        }
        if (amt > round2(owed + 0.005)) {
          return ["EXCEEDS_BALANCE", String(owed)];
        }
        if (amt > owed) {
          amt = owed;
        }
      }
      await kvSet(markerKey, "reserved", PAYOUT_TTL_SECONDS);
      await kvHIncrByFloat(key, "commissionOwed", -amt);
      await kvHIncrByFloat(key, "commissionPaid", amt);
      return ["OK", String(amt)];
    }
  );

  const [reserveStatus, reserveVal] = reserveResult ?? ["NO_BALANCE", "0"];

  if (reserveStatus === "DUPLICATE") {
    const existingPayouts = await listCreatorPayouts(norm);
    const matchedPayout = existingPayouts.find((p) => p.id === payoutId);
    const reloaded = await getCreator(norm);
    if (matchedPayout && reloaded) {
      return { creator: reloaded, payout: matchedPayout };
    }
    throw new Error(`Payout ${payoutId} is already in progress or completed.`);
  }
  if (reserveStatus === "NO_BALANCE") {
    throw new Error(`No unpaid commission balance owed for ${norm}.`);
  }
  if (reserveStatus === "INVALID_AMOUNT") {
    throw new Error("Payout amount must be greater than $0.00.");
  }
  if (reserveStatus === "EXCEEDS_BALANCE") {
    const currentOwed = Number(reserveVal) || 0;
    const attempted = round2(Number(params.amount ?? 0));
    throw new Error(
      `Payout amount ($${attempted.toFixed(2)}) exceeds unpaid balance owed ($${currentOwed.toFixed(2)}).`
    );
  }

  const effectiveAmount = round2(Number(reserveVal));
  const destination =
    params.destination?.trim() ||
    (method === "stripe_connect"
      ? creator.stripeConnectAccountId
      : creator.payoutHandle || creator.payoutEmail);

  const rollbackReservation = async () => {
    const rollbackLua = [
      'if redis.call("GET", KEYS[1]) == "reserved" then',
      '  redis.call("DEL", KEYS[1])',
      '  local amt = tonumber(ARGV[1]) or 0',
      '  redis.call("HINCRBYFLOAT", KEYS[2], "commissionOwed", amt)',
      '  redis.call("HINCRBYFLOAT", KEYS[2], "commissionPaid", -amt)',
      "  return 1",
      "end",
      "return 0",
    ].join("\n");

    await kvEvalLua<number>(
      rollbackLua,
      [markerKey, key],
      [String(effectiveAmount)],
      async () => {
        const cur = await kvGet<string>(markerKey);
        if (cur === "reserved") {
          await kvDel(markerKey);
          await kvHIncrByFloat(key, "commissionOwed", effectiveAmount);
          await kvHIncrByFloat(key, "commissionPaid", -effectiveAmount);
          return 1;
        }
        return 0;
      }
    );
  };

  let stripeTransferId: string | undefined;
  if (willExecuteStripeTransfer) {
    try {
      const transferParams = new URLSearchParams();
      transferParams.set("amount", String(Math.round(effectiveAmount * 100)));
      transferParams.set("currency", "usd");
      transferParams.set("destination", connectAcct);
      transferParams.set(
        "description",
        `HeyBroc Creator Affiliate Commission Payout (${norm})`
      );
      transferParams.set("metadata[creator_code]", norm);
      transferParams.set("metadata[payout_id]", payoutId);

      const res = await fetch("https://api.stripe.com/v1/transfers", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": `heybroc_payout_${payoutId}`,
        },
        body: transferParams.toString(),
      });
      const transferData = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: { message?: string };
      };
      if (!res.ok || !transferData.id) {
        throw new Error(
          transferData.error?.message ||
            `Stripe Connect transfer failed with HTTP ${res.status}.`
        );
      }
      stripeTransferId = transferData.id;
    } catch (err) {
      await rollbackReservation();
      throw err;
    }
  }

  // Finalize reservation marker so subsequent retries return the completed payout record
  const finalizeLua = [
    'redis.call("SET", KEYS[1], "paid", "EX", tonumber(ARGV[1]))',
    "return 1",
  ].join("\n");
  await kvEvalLua<number>(
    finalizeLua,
    [markerKey],
    [Math.floor(PAYOUT_TTL_SECONDS)],
    async () => {
      await kvSet(markerKey, "paid", PAYOUT_TTL_SECONDS);
      return 1;
    }
  );

  const nowIso = new Date().toISOString();
  const payoutRecord: CreatorPayoutRecord = {
    id: payoutId,
    code: norm,
    amount: effectiveAmount,
    currency: "usd",
    method,
    status: "paid",
    destination: destination || undefined,
    stripeTransferId,
    note: params.note?.trim().slice(0, 200) || undefined,
    createdAt: nowIso,
  };

  await kvHSet(key, { lastPayoutAt: nowIso });
  await prependPayoutRecordAtomic(creatorPayoutsKey(norm), payoutRecord, 100);
  await prependPayoutRecordAtomic(RECENT_PAYOUTS_KEY, payoutRecord, 200);

  const updated = await getCreator(norm);
  if (!updated) {
    throw new Error("Failed to reload creator after payout.");
  }
  return { creator: updated, payout: payoutRecord };
}

async function prependPayoutRecordAtomic(
  listKey: string,
  record: CreatorPayoutRecord,
  maxItems: number
): Promise<void> {
  const prependLua = [
    'local raw = redis.call("GET", KEYS[1])',
    "local list = {}",
    'if raw and type(raw) == "string" and raw ~= "" then',
    "  local ok, parsed = pcall(cjson.decode, raw)",
    '  if ok and type(parsed) == "table" then',
    "    list = parsed",
    "  end",
    "end",
    "local newItem = cjson.decode(ARGV[1])",
    "local maxLen = tonumber(ARGV[2]) or 100",
    "local ttl = tonumber(ARGV[3]) or 157680000",
    "local out = { newItem }",
    "for i = 1, #list do",
    "  if #out >= maxLen then break end",
    "  local item = list[i]",
    '  if type(item) ~= "table" or item["id"] ~= newItem["id"] then',
    "    table.insert(out, item)",
    "  end",
    "end",
    'redis.call("SET", KEYS[1], cjson.encode(out), "EX", ttl)',
    "return #out",
  ].join("\n");

  let ranFallback = false;
  const runLocalPrepend = async (): Promise<number> => {
    ranFallback = true;
    const existing = await kvGet<CreatorPayoutRecord[]>(listKey);
    const base = Array.isArray(existing)
      ? existing.filter((p) => p?.id !== record.id)
      : [];
    const next = [record, ...base].slice(0, maxItems);
    await kvSet(listKey, next, PAYOUT_TTL_SECONDS);
    return next.length;
  };

  const luaResult = await kvEvalLua<number>(
    prependLua,
    [listKey],
    [JSON.stringify(record), maxItems, Math.floor(PAYOUT_TTL_SECONDS)],
    runLocalPrepend
  );
  if (luaResult === null && !ranFallback) {
    await runLocalPrepend();
  }
}

export const executeCreatorStripePayout = executeCreatorPayout;

/**
 * Creates a Stripe Connect Express account (if not yet created) and returns an onboarding Account Link URL
 * so affiliates can connect their bank account / debit card for automated Stripe payouts.
 */
export async function createStripeConnectOnboardingLink(params: {
  code: string;
  email?: string;
  origin: string;
}): Promise<{ ok: true; url: string; stripeConnectAccountId: string }> {
  await ensureInitialized();
  const norm = normalizeCode(params.code);
  const creator = await getCreator(norm);
  if (!creator) {
    throw new Error("Unknown creator code.");
  }

  const stripeKey = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!stripeKey) {
    throw new Error(
      "Live Stripe Connect onboarding requires STRIPE_SECRET_KEY in production. You can save your PayPal, Venmo, or Zelle payout details right now."
    );
  }

  let accountId = creator.stripeConnectAccountId?.trim() || "";
  const cleanEmail = normalizeEmailOpt(params.email) || creator.payoutEmail;

  if (!accountId) {
    const acctParams = new URLSearchParams();
    acctParams.set("type", "express");
    acctParams.set("capabilities[transfers][requested]", "true");
    acctParams.set("metadata[creator_code]", norm);
    acctParams.set("business_type", "individual");
    if (cleanEmail) {
      acctParams.set("email", cleanEmail);
    }

    const acctRes = await fetch("https://api.stripe.com/v1/accounts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: acctParams.toString(),
    });
    const acctData = (await acctRes.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };
    if (!acctRes.ok || !acctData.id) {
      throw new Error(
        acctData.error?.message ||
          "Could not create Stripe Connect Express account."
      );
    }
    accountId = acctData.id;
    await updateCreator(norm, {
      stripeConnectAccountId: accountId,
      payoutMethod: "stripe_connect",
      ...(cleanEmail ? { payoutEmail: cleanEmail } : {}),
    });
  }

  const safeOrigin = resolveSafeConnectOrigin(params.origin);
  const linkParams = new URLSearchParams();
  linkParams.set("account", accountId);
  linkParams.set("type", "account_onboarding");
  linkParams.set(
    "refresh_url",
    `${safeOrigin}/creators?connect=refresh&code=${encodeURIComponent(norm)}`
  );
  linkParams.set(
    "return_url",
    `${safeOrigin}/creators?connect=complete&code=${encodeURIComponent(norm)}`
  );

  const linkRes = await fetch("https://api.stripe.com/v1/account_links", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: linkParams.toString(),
  });
  const linkData = (await linkRes.json().catch(() => ({}))) as {
    url?: string;
    error?: { message?: string };
  };
  if (!linkRes.ok || !linkData.url) {
    throw new Error(
      linkData.error?.message || "Could not generate Stripe Connect onboarding link."
    );
  }

  return {
    ok: true,
    url: linkData.url,
    stripeConnectAccountId: accountId,
  };
}

export async function resetStats(): Promise<void> {
  await ensureInitialized();
  const creators = await listCreators();
  for (const c of creators) {
    // Only reset zero-paid / non-paid test counters so real paid creator payouts are never erased accidentally
    if (c.commissionPaid > 0) continue;
    await saveCreatorHash({
      ...blank(c.code, c.name, c.commissionPct),
      payoutEmail: c.payoutEmail,
      payoutEmailVerified: c.payoutEmailVerified,
      payoutMethod: c.payoutMethod,
      payoutHandle: c.payoutHandle,
      stripeConnectAccountId: c.stripeConnectAccountId,
      tokenNonce: c.tokenNonce,
      createdAt: c.createdAt,
    });
  }
}

export function totals(list: Creator[]) {
  const t = list.reduce(
    (a, c) => ({
      clicks: a.clicks + c.clicks,
      trials: a.trials + c.trials,
      paidAnnual: a.paidAnnual + c.paidAnnual,
      paidMonthly: a.paidMonthly + c.paidMonthly,
      grossRevenue: a.grossRevenue + c.grossRevenue,
      commissionEarned: a.commissionEarned + c.commissionEarned,
      commissionPaid: a.commissionPaid + c.commissionPaid,
      commissionOwed: a.commissionOwed + c.commissionOwed,
      netRevenue: a.netRevenue + c.netRevenue,
    }),
    {
      clicks: 0,
      trials: 0,
      paidAnnual: 0,
      paidMonthly: 0,
      grossRevenue: 0,
      commissionEarned: 0,
      commissionPaid: 0,
      commissionOwed: 0,
      netRevenue: 0,
    }
  );
  return {
    ...t,
    grossRevenue: round2(t.grossRevenue),
    commissionEarned: round2(t.commissionEarned),
    commissionPaid: round2(t.commissionPaid),
    commissionOwed: round2(t.commissionOwed),
    netRevenue: round2(t.netRevenue),
  };
}

function clampPct(n: number) {
  return Math.max(0, Math.min(90, Math.round(Number(n) * 10) / 10 || 0));
}
