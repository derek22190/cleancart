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
  kvSetNx,
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
  /** Current unpaid commission balance owed to the creator (may be negative after post-payout clawbacks). */
  commissionOwed: number;
  /** Net revenue retained by HeyBroc after creator commissions. */
  netRevenue: number;
  payoutEmail?: string;
  payoutEmailVerified?: boolean;
  payoutApproved?: boolean;
  ownerUserId?: string;
  ownerDeviceId?: string;
  registeredIp?: string;
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
  status: "paid" | "pending" | "pending_reconciliation" | "failed";
  destination?: string;
  stripeTransferId?: string;
  note?: string;
  createdAt: string;
}

export interface PendingCreatorPayout {
  payoutId: string;
  code: string;
  effectiveAmount: number;
  method: CreatorPayoutMethod;
  destination?: string;
  connectAcct?: string;
  idempotencyHeaderKey: string;
  status: "pending_reconciliation";
  note?: string;
  createdAt: string;
  lastError?: string;
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
const PENDING_PAYOUT_PREFIX = "heybroc:creator:pending_payout:";
const SUB_FIRST_PAID_PREFIX = "heybroc:creator:sub_first_paid:";
const CONV_ONCE_PREFIX = "heybroc:creator:conv:";
const REFUND_TX_PREFIX = "heybroc:creator:refund_tx:";
const RECENT_PAYOUTS_KEY = "heybroc:creator:payouts:__recent__";
const CREATORS_SEEDED_KEY = "heybroc:creators:seeded:v2";
const PAYOUT_TTL_SECONDS = 5 * 365 * 86400; // Retain payout tax/audit records for 5 years
const CONV_META_TTL_SECONDS = 400 * 24 * 60 * 60; // 400-day conversion & first-cycle ledger retention
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

const round2 = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};

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
  const rawOwed = Number(fields.commissionOwed ?? 0);
  const commissionOwed = Number.isFinite(rawOwed) ? round2(rawOwed) : 0;
  const rawEarned =
    fields.commissionEarned !== undefined
      ? Number(fields.commissionEarned)
      : commissionOwed + commissionPaid;
  const commissionEarned = Math.max(
    0,
    Number.isFinite(rawEarned) ? round2(rawEarned) : 0
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
  const payoutApproved =
    fields.payoutApproved === undefined || fields.payoutApproved === ""
      ? undefined
      : fields.payoutApproved === "1" || fields.payoutApproved === "true";

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
    payoutApproved,
    ownerUserId: fields.ownerUserId || undefined,
    ownerDeviceId: fields.ownerDeviceId || undefined,
    registeredIp: fields.registeredIp || undefined,
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
  if (c.payoutApproved !== undefined) {
    hashFields.payoutApproved = c.payoutApproved ? "1" : "0";
  }
  if (c.ownerUserId !== undefined) hashFields.ownerUserId = c.ownerUserId;
  if (c.ownerDeviceId !== undefined) hashFields.ownerDeviceId = c.ownerDeviceId;
  if (c.registeredIp !== undefined) hashFields.registeredIp = c.registeredIp;
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
  payoutApproved?: boolean;
  ownerUserId?: string;
  ownerDeviceId?: string;
  registeredIp?: string;
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
      payoutApproved: input.payoutApproved,
      ownerUserId: input.ownerUserId,
      ownerDeviceId: input.ownerDeviceId,
      registeredIp: input.registeredIp,
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
    payoutApproved:
      input.payoutApproved !== undefined ? Boolean(input.payoutApproved) : true,
    ownerUserId: input.ownerUserId?.trim().slice(0, 120) || undefined,
    ownerDeviceId: input.ownerDeviceId?.trim().slice(0, 120) || undefined,
    registeredIp:
      input.registeredIp && input.registeredIp.trim() !== "unknown"
        ? input.registeredIp.trim().slice(0, 80)
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
    payoutApproved?: boolean;
    ownerUserId?: string;
    ownerDeviceId?: string;
    registeredIp?: string;
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
  if (patch.payoutApproved !== undefined) {
    const nextApproved = Boolean(patch.payoutApproved);
    existing.payoutApproved = nextApproved;
    patchFields.payoutApproved = nextApproved ? "1" : "0";
  }
  if (patch.ownerUserId !== undefined) {
    const cleanUid = patch.ownerUserId.trim().slice(0, 120);
    existing.ownerUserId = cleanUid || undefined;
    patchFields.ownerUserId = cleanUid;
  }
  if (patch.ownerDeviceId !== undefined) {
    const cleanDev = patch.ownerDeviceId.trim().slice(0, 120);
    existing.ownerDeviceId = cleanDev || undefined;
    patchFields.ownerDeviceId = cleanDev;
  }
  if (patch.registeredIp !== undefined) {
    const cleanIp =
      patch.registeredIp.trim() !== "unknown"
        ? patch.registeredIp.trim().slice(0, 80)
        : "";
    existing.registeredIp = cleanIp || undefined;
    patchFields.registeredIp = cleanIp;
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
  if (
    existing &&
    (existing.grossRevenue > 0 ||
      existing.commissionPaid > 0 ||
      existing.commissionOwed !== 0)
  ) {
    // Preserve financial audit ledger (including post-payout negative clawback balances) by deactivating
    await updateCreator(norm, { active: false });
    return;
  }
  await kvSRem(CREATOR_CODES_SET_KEY, norm);
  await kvDel(creatorKey(norm));
}

export interface CreatorConversionMeta {
  code: string;
  blockedSelfDeal: boolean;
  commissionCents: number;
  grossUsd: number;
  plan?: PlanId;
  clawedBackCents?: number;
  clawedBackGrossUsd?: number;
  paidSubDecremented?: boolean;
  buyerEmail?: string;
  creditedInvoiceId?: string;
  creditedTransactionId?: string;
  creditedEventId?: string;
}

export interface CreatorConversionOptions {
  creditedInvoiceId?: string;
  creditedTransactionId?: string;
  creditedEventId?: string;
  /** Subscription-level key (`stripe_sub:sub_...`, `ios_orig:...`, `google_orig:...`, `rc_orig:...`, `apple_orig:...`) enforcing first-paid-billing-cycle-only commissions. */
  subscriptionKey?: string;
  /** Additional subscription-level lock keys checked and claimed atomically alongside `subscriptionKey` on paid events. */
  additionalSubscriptionKeys?: string[];
  /** Additional conversion idempotency keys (`CONV_ONCE_PREFIX`) checked and claimed atomically alongside `idempotencyKey` (including on trial events). */
  additionalIdempotencyKeys?: string[];
  buyerUserId?: string;
  buyerDeviceId?: string;
  checkoutIp?: string;
}

export interface CreatorRefundOptions {
  buyerEmail?: string;
  originalConversionKey?: string;
  fallbackConversionKeys?: string[];
  refundedInvoiceId?: string;
  refundedTransactionId?: string;
  otoOffer?: string;
  originalPreTaxUsd?: number;
  refundRatio?: number;
}

export async function claimFirstSubscriptionCreatorCredit(
  subscriptionKey: string
): Promise<boolean> {
  const clean = (subscriptionKey || "").trim();
  if (!clean) return false;
  return kvSetNx(`${SUB_FIRST_PAID_PREFIX}${clean}`, "1", CONV_META_TTL_SECONDS);
}

export async function hasSubscriptionFirstPaidCredit(
  subscriptionKey: string
): Promise<boolean> {
  const clean = (subscriptionKey || "").trim();
  if (!clean) return false;
  const val = await kvGet<string | number>(
    `${SUB_FIRST_PAID_PREFIX}${clean}`
  ).catch(() => null);
  return val !== null && val !== undefined;
}

async function resolveCreatorConversionMetaInternal(
  candidates: Array<string | undefined | null>
): Promise<{ meta: CreatorConversionMeta; metaKey: string } | null> {
  const seen = new Set<string>();
  for (const raw of candidates) {
    const clean = (raw || "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);

    const directKey = `heybroc:creator:conv_meta:${clean}`;
    const direct = await kvGet<CreatorConversionMeta>(directKey).catch(
      () => null
    );
    if (direct && typeof direct === "object") {
      return { meta: direct, metaKey: directKey };
    }

    const aliasTarget = await kvGet<string>(
      `heybroc:creator:conv_alias:${clean}`
    ).catch(() => null);
    if (typeof aliasTarget === "string" && aliasTarget.trim()) {
      const targetKey = `heybroc:creator:conv_meta:${aliasTarget.trim()}`;
      const viaAlias = await kvGet<CreatorConversionMeta>(targetKey).catch(
        () => null
      );
      if (viaAlias && typeof viaAlias === "object") {
        return { meta: viaAlias, metaKey: targetKey };
      }
    }
  }
  return null;
}

export async function getCreatorConversionMeta(
  conversionKey: string
): Promise<CreatorConversionMeta | null> {
  const res = await resolveCreatorConversionMetaInternal([conversionKey]);
  return res ? res.meta : null;
}

export async function getPendingCreatorPayout(
  code: string
): Promise<PendingCreatorPayout | null> {
  await ensureInitialized();
  const norm = normalizeCode(code);
  if (!norm) return null;
  const pending = await kvGet<PendingCreatorPayout>(
    `${PENDING_PAYOUT_PREFIX}${norm}`
  ).catch(() => null);
  return pending && pending.status === "pending_reconciliation" ? pending : null;
}

/**
 * Records a non-financial engagement funnel event (`"click"` or `"trial"`) using atomic Redis Hash increments.
 * Paid conversions cannot be simulated via `trackEvent`; financial credits require verified billing webhooks.
 */
export async function trackEvent(
  code: string,
  event: CreatorEvent
): Promise<Creator> {
  if (event !== "click" && event !== "trial") {
    throw new Error(
      "Paid conversions cannot be simulated via trackEvent; financial credits require verified billing webhooks."
    );
  }
  await ensureInitialized();
  const norm = normalizeCode(code);
  const c = await getCreator(norm);
  if (!c || !c.active) throw new Error("Invalid creator code.");

  const key = creatorKey(norm);

  if (event === "click") {
    await kvHIncrBy(key, "clicks", 1);
  } else {
    await kvHIncrBy(key, "trials", 1);
  }

  const updated = await getCreator(norm);
  if (!updated) throw new Error("Failed to reload creator after event.");
  return updated;
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
 * Idempotently records a creator conversion from a verified Stripe, RevenueCat, or Apple App Store event.
 * Enforces first-paid-billing-cycle-only commission when `options.subscriptionKey` is supplied, and never
 * consumes first-cycle credit on `$0` free-trial events.
 */
export async function recordStripeCreatorConversionOnce(
  idempotencyKey: string,
  code: string,
  event: CreatorEvent,
  amountPaidUsd?: number,
  buyerEmail?: string,
  options?: CreatorConversionOptions
): Promise<Creator | null> {
  const norm = normalizeCode(code);
  if (!norm) return null;
  const creator = await getCreator(norm);
  if (!creator || !creator.active) return null;

  const isPaidEvent =
    event === "paid_annual" ||
    event === "checkout_annual" ||
    event === "paid_monthly";

  // Require payout approval before accruing paid affiliate commissions on self-registered codes
  if (isPaidEvent && creator.payoutApproved === false) {
    return creator;
  }

  // Never credit a paid conversion or consume first-paid-cycle subscription lock when $0 was collected
  if (
    isPaidEvent &&
    amountPaidUsd !== undefined &&
    (!Number.isFinite(amountPaidUsd) || amountPaidUsd <= 0)
  ) {
    return creator;
  }

  const cleanBuyerEmail = buyerEmail?.trim().toLowerCase() || undefined;
  const cleanBuyerUserId = options?.buyerUserId?.trim() || undefined;
  const cleanBuyerDeviceId = options?.buyerDeviceId?.trim() || undefined;
  const cleanCheckoutIp =
    options?.checkoutIp && options.checkoutIp.trim() !== "unknown"
      ? options.checkoutIp.trim()
      : undefined;
  const metaKey = `heybroc:creator:conv_meta:${idempotencyKey}`;
  const creditedInvoiceId = options?.creditedInvoiceId?.trim() || undefined;
  const creditedTransactionId =
    options?.creditedTransactionId?.trim() || undefined;
  const creditedEventId = options?.creditedEventId?.trim() || undefined;

  const isSelfDealByEmail = Boolean(
    cleanBuyerEmail &&
      creator.payoutEmail &&
      cleanBuyerEmail === creator.payoutEmail.trim().toLowerCase()
  );
  const isSelfDealByUserId = Boolean(
    cleanBuyerUserId &&
      creator.ownerUserId &&
      cleanBuyerUserId === creator.ownerUserId.trim()
  );
  const isSelfDealByDeviceId = Boolean(
    cleanBuyerDeviceId &&
      creator.ownerDeviceId &&
      cleanBuyerDeviceId === creator.ownerDeviceId.trim()
  );
  const isSelfDealByIp = Boolean(
    cleanCheckoutIp &&
      creator.registeredIp &&
      creator.registeredIp.trim() !== "unknown" &&
      cleanCheckoutIp === creator.registeredIp.trim()
  );

  // Anti-self-dealing guard: block affiliate commission when buyer matches creator email, userId, deviceId, or registration IP
  if (
    isSelfDealByEmail ||
    isSelfDealByUserId ||
    isSelfDealByDeviceId ||
    isSelfDealByIp
  ) {
    await kvSet<CreatorConversionMeta>(
      metaKey,
      {
        code: norm,
        blockedSelfDeal: true,
        commissionCents: 0,
        grossUsd: 0,
        clawedBackCents: 0,
        buyerEmail: cleanBuyerEmail,
        ...(creditedInvoiceId ? { creditedInvoiceId } : {}),
        ...(creditedTransactionId ? { creditedTransactionId } : {}),
        ...(creditedEventId ? { creditedEventId } : {}),
      },
      CONV_META_TTL_SECONDS
    ).catch(() => {});
    if (creditedInvoiceId) {
      await kvSet(
        `heybroc:creator:conv_alias:invoice:${creditedInvoiceId}`,
        idempotencyKey,
        CONV_META_TTL_SECONDS
      ).catch(() => {});
    }
    if (creditedTransactionId) {
      await kvSet(
        `heybroc:creator:conv_alias:tx:${creditedTransactionId}`,
        idempotencyKey,
        CONV_META_TTL_SECONDS
      ).catch(() => {});
    }
    return creator;
  }

  const markerKey = `${CONV_ONCE_PREFIX}${idempotencyKey}`;
  const key = creatorKey(norm);
  const deltas: Array<{ field: string; delta: number; isFloat?: boolean }> = [];
  let recordedGross = 0;
  let recordedComm = 0;
  let resolvedPlan: PlanId | undefined;

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
    resolvedPlan = "annual";
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
    resolvedPlan = "annual";
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
    resolvedPlan = "monthly";
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

  const extraLockSet = new Set<string>();
  const subKeyAliases: string[] = [];
  if (isPaidEvent) {
    const primarySub = options?.subscriptionKey?.trim();
    if (primarySub) {
      extraLockSet.add(`${SUB_FIRST_PAID_PREFIX}${primarySub}`);
      subKeyAliases.push(primarySub);
    }
    for (const rawSub of options?.additionalSubscriptionKeys ?? []) {
      const cleanSub = rawSub?.trim();
      if (cleanSub) {
        extraLockSet.add(`${SUB_FIRST_PAID_PREFIX}${cleanSub}`);
        subKeyAliases.push(cleanSub);
      }
    }
  }
  for (const rawIdem of options?.additionalIdempotencyKeys ?? []) {
    const cleanIdem = rawIdem?.trim();
    if (cleanIdem) {
      const fullKey = `${CONV_ONCE_PREFIX}${cleanIdem}`;
      if (fullKey !== markerKey) {
        extraLockSet.add(fullKey);
      }
    }
  }
  extraLockSet.delete(markerKey);
  const extraLockKeys = Array.from(extraLockSet);

  let applied = false;
  if (extraLockKeys.length === 0) {
    applied = await kvAtomicHashUpdateOnce(
      markerKey,
      key,
      deltas,
      CONV_META_TTL_SECONDS
    );
  } else {
    const convLua = [
      'if redis.call("EXISTS", KEYS[1]) == 1 then return 0 end',
      "for i = 3, #KEYS do",
      '  if redis.call("EXISTS", KEYS[i]) == 1 then return 0 end',
      "end",
      'redis.call("SET", KEYS[1], \'"1"\', "EX", tonumber(ARGV[1]))',
      "for i = 3, #KEYS do",
      '  redis.call("SET", KEYS[i], \'"1"\', "EX", tonumber(ARGV[1]))',
      "end",
      "for i = 2, #ARGV, 3 do",
      "  local f = ARGV[i]",
      "  local d = ARGV[i + 1]",
      "  local k = ARGV[i + 2]",
      '  if k == "float" then',
      '    redis.call("HINCRBYFLOAT", KEYS[2], f, d)',
      "  else",
      '    redis.call("HINCRBY", KEYS[2], f, tonumber(d))',
      "  end",
      "end",
      "return 1",
    ].join("\n");

    const luaArgs: (string | number)[] = [Math.floor(CONV_META_TTL_SECONDS)];
    for (const item of deltas) {
      luaArgs.push(
        item.field,
        item.isFloat
          ? String(round2(item.delta))
          : String(Math.trunc(item.delta)),
        item.isFloat ? "float" : "int"
      );
    }

    const evalRes = await kvEvalLua<number>(
      convLua,
      [markerKey, key, ...extraLockKeys],
      luaArgs,
      async () => {
        const existingMarker = await kvGet<string | number>(markerKey);
        if (existingMarker !== null) return 0;
        for (const lockKey of extraLockKeys) {
          const existingLock = await kvGet<string | number>(lockKey);
          if (existingLock !== null) return 0;
        }
        for (const item of deltas) {
          if (item.isFloat) {
            await kvHIncrByFloat(key, item.field, item.delta);
          } else {
            await kvHIncrBy(key, item.field, item.delta);
          }
        }
        await kvSet(markerKey, "1", CONV_META_TTL_SECONDS);
        for (const lockKey of extraLockKeys) {
          await kvSet(lockKey, "1", CONV_META_TTL_SECONDS);
        }
        return 1;
      }
    );
    applied = Number(evalRes) === 1;
  }

  if (applied && (recordedGross > 0 || recordedComm > 0)) {
    await kvSet<CreatorConversionMeta>(
      metaKey,
      {
        code: norm,
        blockedSelfDeal: false,
        commissionCents: Math.round(recordedComm * 100),
        grossUsd: recordedGross,
        plan: resolvedPlan,
        clawedBackCents: 0,
        clawedBackGrossUsd: 0,
        paidSubDecremented: false,
        buyerEmail: cleanBuyerEmail,
        ...(creditedInvoiceId ? { creditedInvoiceId } : {}),
        ...(creditedTransactionId ? { creditedTransactionId } : {}),
        ...(creditedEventId ? { creditedEventId } : {}),
      },
      CONV_META_TTL_SECONDS
    ).catch(() => {});
    if (creditedInvoiceId) {
      await kvSet(
        `heybroc:creator:conv_alias:invoice:${creditedInvoiceId}`,
        idempotencyKey,
        CONV_META_TTL_SECONDS
      ).catch(() => {});
    }
    if (creditedTransactionId) {
      await kvSet(
        `heybroc:creator:conv_alias:tx:${creditedTransactionId}`,
        idempotencyKey,
        CONV_META_TTL_SECONDS
      ).catch(() => {});
    }
    const seenSubAliases = new Set<string>();
    for (const subAlias of subKeyAliases) {
      if (!subAlias || subAlias === idempotencyKey || seenSubAliases.has(subAlias)) {
        continue;
      }
      seenSubAliases.add(subAlias);
      await kvSet(
        `heybroc:creator:conv_alias:${subAlias}`,
        idempotencyKey,
        CONV_META_TTL_SECONDS
      ).catch(() => {});
    }
  }
  return getCreator(norm);
}

export const recordCreatorConversion = recordStripeCreatorConversionOnce;

/**
 * Idempotently claws back creator revenue & proportional commission when a credited first-cycle charge
 * is refunded or disputed. Executes idempotency checks (including canonical transaction refund lock),
 * live creator & `convMeta` reads, remaining-cap & ratio math, hash decrements, and `convMeta` JSON
 * updates atomically inside a single `kvEvalLua` script (with a mutex-serialized local fallback).
 */
export async function recordStripeCreatorRefundOnce(
  idempotencyKey: string,
  code: string,
  plan: PlanId,
  refundAmountUsd?: number,
  isFullRefundOrOptions?: boolean | CreatorRefundOptions,
  maybeOptions?: CreatorRefundOptions
): Promise<Creator | null> {
  const isFullRefundOverride =
    typeof isFullRefundOrOptions === "boolean"
      ? isFullRefundOrOptions
      : undefined;
  const options =
    typeof isFullRefundOrOptions === "object" && isFullRefundOrOptions !== null
      ? isFullRefundOrOptions
      : maybeOptions;
  const norm = normalizeCode(code);
  if (!norm) return null;
  await ensureInitialized();

  const hasValidRatio =
    typeof options?.refundRatio === "number" &&
    Number.isFinite(options.refundRatio) &&
    options.refundRatio >= 0;

  if (hasValidRatio && options!.refundRatio! <= 0) {
    return getCreator(norm);
  }

  const normalizedExplicitRatio = hasValidRatio
    ? Math.max(0, Math.min(1, options!.refundRatio!))
    : undefined;

  const cleanBuyerEmail = options?.buyerEmail?.trim().toLowerCase() || "";
  const refundedInvoiceId = options?.refundedInvoiceId?.trim() || "";
  const refundedTransactionId = options?.refundedTransactionId?.trim() || "";

  const metaCandidates: Array<string | undefined> = [
    options?.originalConversionKey,
    ...(options?.fallbackConversionKeys ?? []),
    refundedInvoiceId ? `invoice:${refundedInvoiceId}` : undefined,
    refundedTransactionId ? `tx:${refundedTransactionId}` : undefined,
  ];
  const resolvedMeta = await resolveCreatorConversionMetaInternal(metaCandidates);
  const fallbackDirectMetaKey = options?.originalConversionKey?.trim()
    ? `heybroc:creator:conv_meta:${options.originalConversionKey.trim()}`
    : "";
  const convMetaKey = resolvedMeta?.metaKey ?? fallbackDirectMetaKey;

  const markerKey = `heybroc:creator:refund:${idempotencyKey}`;
  const key = creatorKey(norm);
  const txRefundMarkerKey = refundedTransactionId
    ? `${REFUND_TX_PREFIX}${refundedTransactionId}`
    : "";

  const luaKeys: string[] = [markerKey, key];
  let convMetaKeyIdx = 0;
  if (convMetaKey) {
    luaKeys.push(convMetaKey);
    convMetaKeyIdx = luaKeys.length;
  }
  let txMarkerKeyIdx = 0;
  if (txRefundMarkerKey && txRefundMarkerKey !== markerKey) {
    luaKeys.push(txRefundMarkerKey);
    txMarkerKeyIdx = luaKeys.length;
  }

  const originalPreTaxArg =
    options?.originalPreTaxUsd &&
    Number.isFinite(options.originalPreTaxUsd) &&
    options.originalPreTaxUsd > 0
      ? String(round2(options.originalPreTaxUsd))
      : "";
  const refundAmountArg =
    refundAmountUsd !== undefined &&
    Number.isFinite(refundAmountUsd) &&
    refundAmountUsd > 0
      ? String(round2(refundAmountUsd))
      : "";
  const explicitRatioArg =
    normalizedExplicitRatio !== undefined ? String(normalizedExplicitRatio) : "";
  const isFullOverrideArg =
    isFullRefundOverride === true
      ? "1"
      : isFullRefundOverride === false
        ? "0"
        : "";

  const atomicRefundLua = [
    "local function round2(n)",
    "  local r = math.floor(n * 100 + 0.5) / 100",
    "  if r == 0 then return 0 end",
    "  return r",
    "end",
    "local function clampPct(n)",
    "  local v = math.floor(n * 10 + 0.5) / 10",
    "  if v < 0 then return 0 end",
    "  if v > 90 then return 90 end",
    "  return v",
    "end",
    "local ttl = tonumber(ARGV[1]) or 34560000",
    "local convMetaIdx = tonumber(ARGV[2]) or 0",
    "local txMarkerIdx = tonumber(ARGV[3]) or 0",
    'local cleanBuyerEmail = ARGV[4] or ""',
    'local refundedInvoiceId = ARGV[5] or ""',
    'local refundedTransactionId = ARGV[6] or ""',
    'local fallbackPlan = ARGV[7] or "annual"',
    'local otoOffer = ARGV[8] or ""',
    "local pricingAnnual = tonumber(ARGV[9]) or 49.99",
    "local pricingMonthly = tonumber(ARGV[10]) or 9.99",
    "local pricingOtoAnnual = tonumber(ARGV[11]) or 29.99",
    "local pricingOtoGift = tonumber(ARGV[12]) or 29.99",
    "local defaultCommPct = tonumber(ARGV[13]) or 35",
    'local originalPreTaxStr = ARGV[14] or ""',
    'local refundAmountStr = ARGV[15] or ""',
    'local explicitRatioStr = ARGV[16] or ""',
    'local isFullOverrideStr = ARGV[17] or ""',
    'local creatorCode = redis.call("HGET", KEYS[2], "code")',
    'if not creatorCode or creatorCode == "" then return "NO_CREATOR" end',
    'if cleanBuyerEmail ~= "" then',
    '  local payoutEmail = redis.call("HGET", KEYS[2], "payoutEmail")',
    '  if payoutEmail and string.lower(string.gsub(payoutEmail, "^%s*(.-)%s*$", "%1")) == cleanBuyerEmail then',
    '    return "SKIPPED"',
    "  end",
    "end",
    'if redis.call("EXISTS", KEYS[1]) == 1 then return "DUPLICATE" end',
    'if txMarkerIdx > 0 and redis.call("EXISTS", KEYS[txMarkerIdx]) == 1 then return "DUPLICATE" end',
    "local convMeta = nil",
    "if convMetaIdx > 0 then",
    '  local rawMeta = redis.call("GET", KEYS[convMetaIdx])',
    '  if rawMeta and type(rawMeta) == "string" and rawMeta ~= "" then',
    "    local okMeta, parsedMeta = pcall(cjson.decode, rawMeta)",
    '    if okMeta and type(parsedMeta) == "table" then convMeta = parsedMeta end',
    "  end",
    "end",
    "if convMeta ~= nil then",
    '  if convMeta["blockedSelfDeal"] == true or (tonumber(convMeta["commissionCents"]) or 0) <= 0 then',
    '    return "SKIPPED"',
    "  end",
    '  local creditedInv = convMeta["creditedInvoiceId"]',
    '  if type(creditedInv) == "string" and creditedInv ~= "" and refundedInvoiceId ~= "" and creditedInv ~= refundedInvoiceId then',
    '    return "SKIPPED"',
    "  end",
    '  local creditedTx = convMeta["creditedTransactionId"]',
    '  if type(creditedTx) == "string" and creditedTx ~= "" and refundedTransactionId ~= "" and creditedTx ~= refundedTransactionId then',
    '    return "SKIPPED"',
    "  end",
    "end",
    'local creatorGross = math.max(0, round2(tonumber(redis.call("HGET", KEYS[2], "grossRevenue") or "0") or 0))',
    'local creatorPaid = math.max(0, round2(tonumber(redis.call("HGET", KEYS[2], "commissionPaid") or "0") or 0))',
    'local creatorOwed = round2(tonumber(redis.call("HGET", KEYS[2], "commissionOwed") or "0") or 0)',
    'local creatorEarnedRaw = redis.call("HGET", KEYS[2], "commissionEarned")',
    "local creatorEarned",
    "if creatorEarnedRaw ~= false and creatorEarnedRaw ~= nil then",
    "  creatorEarned = math.max(0, round2(tonumber(creatorEarnedRaw) or 0))",
    "else",
    "  creatorEarned = math.max(0, round2(creatorOwed + creatorPaid))",
    "end",
    'local creatorPctRaw = redis.call("HGET", KEYS[2], "commissionPct")',
    "local creatorPct = defaultCommPct",
    "if creatorPctRaw ~= false and creatorPctRaw ~= nil then",
    "  creatorPct = clampPct(tonumber(creatorPctRaw) or 0)",
    "end",
    'local paidAnnual = math.max(0, math.floor(tonumber(redis.call("HGET", KEYS[2], "paidAnnual") or "0") or 0))',
    'local paidMonthly = math.max(0, math.floor(tonumber(redis.call("HGET", KEYS[2], "paidMonthly") or "0") or 0))',
    "local effectivePlan = fallbackPlan",
    'if convMeta ~= nil and (convMeta["plan"] == "annual" or convMeta["plan"] == "monthly") then',
    '  effectivePlan = convMeta["plan"]',
    "end",
    "local planPriceCap",
    'if otoOffer == "oto_gift_year" then',
    "  planPriceCap = pricingOtoGift",
    'elseif otoOffer == "oto_annual" then',
    "  planPriceCap = pricingOtoAnnual",
    'elseif effectivePlan == "annual" then',
    "  planPriceCap = pricingAnnual",
    "else",
    "  planPriceCap = pricingMonthly",
    "end",
    'local convMetaGross = convMeta ~= nil and (tonumber(convMeta["grossUsd"]) or 0) or 0',
    "local effectiveCap = planPriceCap",
    "if convMeta ~= nil and convMetaGross > 0 then",
    "  effectiveCap = math.min(planPriceCap, convMetaGross)",
    'elseif originalPreTaxStr ~= "" then',
    "  local origPreTax = round2(tonumber(originalPreTaxStr) or 0)",
    "  if origPreTax > 0 then effectiveCap = math.min(planPriceCap, origPreTax) end",
    "end",
    'local hasExplicitRatio = explicitRatioStr ~= ""',
    "local explicitRatio = hasExplicitRatio and tonumber(explicitRatioStr) or nil",
    'local hasRefundAmt = refundAmountStr ~= ""',
    "local refundAmtVal = hasRefundAmt and tonumber(refundAmountStr) or nil",
    "local requestedGross",
    "if hasExplicitRatio and (not hasRefundAmt or round2(refundAmtVal) > effectiveCap) then",
    "  requestedGross = round2(effectiveCap * explicitRatio)",
    "elseif hasRefundAmt and refundAmtVal > 0 then",
    "  requestedGross = math.min(effectiveCap, round2(refundAmtVal))",
    "else",
    "  requestedGross = effectiveCap",
    "end",
    "local rawRatio",
    "if hasExplicitRatio then",
    "  rawRatio = explicitRatio",
    "elseif convMeta ~= nil and convMetaGross > 0 then",
    "  rawRatio = requestedGross / convMetaGross",
    "elseif effectiveCap > 0 then",
    "  rawRatio = requestedGross / effectiveCap",
    "else",
    "  rawRatio = 1",
    "end",
    "local ratio = math.max(0, math.min(1, rawRatio))",
    "local grossDelta = 0",
    "local cappedCommDelta = 0",
    "local nextClawedBackCents = 0",
    "local nextClawedBackGrossUsd = 0",
    'local convCommCents = convMeta ~= nil and math.floor((tonumber(convMeta["commissionCents"]) or 0) + 0.5) or 0',
    "if convMeta ~= nil and convCommCents > 0 then",
    '  local prevClawedCents = math.floor((tonumber(convMeta["clawedBackCents"]) or 0) + 0.5)',
    "  local remainingCommCents = math.max(0, convCommCents - prevClawedCents)",
    "  local targetClawbackCents = math.floor(convCommCents * ratio + 0.5)",
    "  local actualClawbackCents = math.min(remainingCommCents, targetClawbackCents)",
    "  cappedCommDelta = round2(actualClawbackCents / 100)",
    "  nextClawedBackCents = prevClawedCents + actualClawbackCents",
    '  local prevClawedGross = round2(tonumber(convMeta["clawedBackGrossUsd"]) or 0)',
    "  local remainingConvGross = math.max(0, round2(convMetaGross - prevClawedGross))",
    "  local targetGross = round2(convMetaGross * ratio)",
    "  grossDelta = math.min(creatorGross, math.min(remainingConvGross, targetGross))",
    "  nextClawedBackGrossUsd = round2(prevClawedGross + grossDelta)",
    "else",
    "  grossDelta = math.min(creatorGross, requestedGross)",
    "  cappedCommDelta = round2(grossDelta * (creatorPct / 100))",
    "end",
    "local earnedDelta = math.min(math.max(0, creatorEarned), cappedCommDelta)",
    "local owedDelta = cappedCommDelta",
    "local cumulativeRefundComplete",
    "if convMeta ~= nil then",
    "  cumulativeRefundComplete = (nextClawedBackCents >= convCommCents) or (nextClawedBackGrossUsd >= convMetaGross * 0.99)",
    "else",
    "  cumulativeRefundComplete = (grossDelta >= effectiveCap * 0.99) or (requestedGross >= pricingOtoGift * 0.99)",
    "end",
    "local isFullRefund",
    'if isFullOverrideStr == "1" then',
    "  isFullRefund = true",
    'elseif isFullOverrideStr == "0" then',
    "  isFullRefund = false",
    "else",
    "  isFullRefund = cumulativeRefundComplete",
    "end",
    'local planField = effectivePlan == "annual" and "paidAnnual" or "paidMonthly"',
    'local currentPlanCount = effectivePlan == "annual" and paidAnnual or paidMonthly',
    'local prevPaidSubDec = convMeta ~= nil and convMeta["paidSubDecremented"] == true',
    "local shouldDecrementPaidSub = isFullRefund and (currentPlanCount > 0) and (not prevPaidSubDec) and (grossDelta > 0 or cappedCommDelta > 0)",
    'if (not shouldDecrementPaidSub) and grossDelta <= 0 and earnedDelta <= 0 and owedDelta <= 0 then return "NOOP" end',
    'redis.call("SET", KEYS[1], \'"1"\', "EX", ttl)',
    "if txMarkerIdx > 0 then",
    '  redis.call("SET", KEYS[txMarkerIdx], \'"1"\', "EX", ttl)',
    "end",
    "if shouldDecrementPaidSub then",
    '  redis.call("HINCRBY", KEYS[2], planField, -1)',
    "end",
    "if grossDelta > 0 then",
    '  redis.call("HINCRBYFLOAT", KEYS[2], "grossRevenue", string.format("%.2f", -grossDelta))',
    "end",
    "if earnedDelta > 0 then",
    '  redis.call("HINCRBYFLOAT", KEYS[2], "commissionEarned", string.format("%.2f", -earnedDelta))',
    "end",
    "if owedDelta > 0 then",
    '  redis.call("HINCRBYFLOAT", KEYS[2], "commissionOwed", string.format("%.2f", -owedDelta))',
    "end",
    "if convMeta ~= nil and convMetaIdx > 0 then",
    '  convMeta["clawedBackCents"] = nextClawedBackCents',
    '  convMeta["clawedBackGrossUsd"] = nextClawedBackGrossUsd',
    '  convMeta["paidSubDecremented"] = (prevPaidSubDec or shouldDecrementPaidSub) and true or false',
    '  redis.call("SET", KEYS[convMetaIdx], cjson.encode(convMeta), "EX", ttl)',
    "end",
    'return "APPLIED"',
  ].join("\n");

  const luaArgs: (string | number)[] = [
    Math.floor(CONV_META_TTL_SECONDS),
    convMetaKeyIdx,
    txMarkerKeyIdx,
    cleanBuyerEmail,
    refundedInvoiceId,
    refundedTransactionId,
    plan,
    options?.otoOffer || "",
    PRICING.annual,
    PRICING.monthly,
    PRICING.otoAnnualLockIn,
    PRICING.otoExtraYearPass,
    PRICING.defaultCommissionPct,
    originalPreTaxArg,
    refundAmountArg,
    explicitRatioArg,
    isFullOverrideArg,
  ];

  const evalStatus = await kvEvalLua<string>(
    atomicRefundLua,
    luaKeys,
    luaArgs,
    async () => {
      const liveCreator = await getCreator(norm);
      if (!liveCreator) return "NO_CREATOR";

      if (
        cleanBuyerEmail &&
        liveCreator.payoutEmail &&
        cleanBuyerEmail === liveCreator.payoutEmail.trim().toLowerCase()
      ) {
        return "SKIPPED";
      }

      const existingMarker = await kvGet<string | number>(markerKey);
      if (existingMarker !== null) return "DUPLICATE";
      if (txRefundMarkerKey && txRefundMarkerKey !== markerKey) {
        const existingTxMarker = await kvGet<string | number>(txRefundMarkerKey);
        if (existingTxMarker !== null) return "DUPLICATE";
      }

      const liveConvMeta = convMetaKey
        ? await kvGet<CreatorConversionMeta>(convMetaKey)
        : null;
      const convMeta =
        liveConvMeta && typeof liveConvMeta === "object" ? liveConvMeta : null;

      if (convMeta) {
        if (convMeta.blockedSelfDeal || convMeta.commissionCents <= 0) {
          return "SKIPPED";
        }
        if (
          convMeta.creditedInvoiceId &&
          refundedInvoiceId &&
          convMeta.creditedInvoiceId !== refundedInvoiceId
        ) {
          return "SKIPPED";
        }
        if (
          convMeta.creditedTransactionId &&
          refundedTransactionId &&
          convMeta.creditedTransactionId !== refundedTransactionId
        ) {
          return "SKIPPED";
        }
      }

      const effectivePlan: PlanId = convMeta?.plan ?? plan;
      const planPriceCap =
        options?.otoOffer === "oto_gift_year"
          ? PRICING.otoExtraYearPass
          : options?.otoOffer === "oto_annual"
            ? PRICING.otoAnnualLockIn
            : effectivePlan === "annual"
              ? PRICING.annual
              : PRICING.monthly;
      const effectiveCap =
        convMeta && typeof convMeta.grossUsd === "number" && convMeta.grossUsd > 0
          ? Math.min(planPriceCap, convMeta.grossUsd)
          : options?.originalPreTaxUsd && options.originalPreTaxUsd > 0
            ? Math.min(planPriceCap, round2(options.originalPreTaxUsd))
            : planPriceCap;

      const requestedGross =
        normalizedExplicitRatio !== undefined &&
        (refundAmountUsd === undefined || round2(refundAmountUsd) > effectiveCap)
          ? round2(effectiveCap * normalizedExplicitRatio)
          : refundAmountUsd !== undefined && refundAmountUsd > 0
            ? Math.min(effectiveCap, round2(refundAmountUsd))
            : effectiveCap;

      const ratio = Math.max(
        0,
        Math.min(
          1,
          normalizedExplicitRatio ??
            (convMeta && convMeta.grossUsd > 0
              ? requestedGross / convMeta.grossUsd
              : effectiveCap > 0
                ? requestedGross / effectiveCap
                : 1)
        )
      );

      let grossDelta: number;
      let cappedCommDelta: number;
      let nextClawedBackCents = convMeta?.clawedBackCents ?? 0;
      let nextClawedBackGrossUsd = convMeta?.clawedBackGrossUsd ?? 0;

      if (convMeta && convMeta.commissionCents > 0) {
        const prevClawedCents = Math.round(convMeta.clawedBackCents ?? 0);
        const remainingCommCents = Math.max(
          0,
          convMeta.commissionCents - prevClawedCents
        );
        const targetClawbackCents = Math.round(convMeta.commissionCents * ratio);
        const actualClawbackCents = Math.min(
          remainingCommCents,
          targetClawbackCents
        );
        cappedCommDelta = round2(actualClawbackCents / 100);
        nextClawedBackCents = prevClawedCents + actualClawbackCents;

        const prevClawedGross = round2(convMeta.clawedBackGrossUsd ?? 0);
        const remainingConvGross = Math.max(
          0,
          round2(convMeta.grossUsd - prevClawedGross)
        );
        const targetGross = round2(convMeta.grossUsd * ratio);
        grossDelta = Math.min(
          liveCreator.grossRevenue,
          Math.min(remainingConvGross, targetGross)
        );
        nextClawedBackGrossUsd = round2(prevClawedGross + grossDelta);
      } else {
        grossDelta = Math.min(liveCreator.grossRevenue, requestedGross);
        cappedCommDelta = round2(grossDelta * (liveCreator.commissionPct / 100));
      }

      const earnedDelta = Math.min(
        Math.max(0, liveCreator.commissionEarned),
        cappedCommDelta
      );
      const owedDelta = cappedCommDelta;

      const cumulativeRefundComplete = convMeta
        ? nextClawedBackCents >= convMeta.commissionCents ||
          nextClawedBackGrossUsd >= convMeta.grossUsd * 0.99
        : grossDelta >= effectiveCap * 0.99 ||
          requestedGross >= PRICING.otoExtraYearPass * 0.99;

      const isFullRefund = isFullRefundOverride ?? cumulativeRefundComplete;
      const planField = effectivePlan === "annual" ? "paidAnnual" : "paidMonthly";
      const currentPlanCount =
        effectivePlan === "annual"
          ? liveCreator.paidAnnual
          : liveCreator.paidMonthly;
      const shouldDecrementPaidSub =
        isFullRefund &&
        currentPlanCount > 0 &&
        !convMeta?.paidSubDecremented &&
        (grossDelta > 0 || cappedCommDelta > 0);

      if (
        !shouldDecrementPaidSub &&
        grossDelta <= 0 &&
        earnedDelta <= 0 &&
        owedDelta <= 0
      ) {
        return "NOOP";
      }

      await kvSet(markerKey, "1", CONV_META_TTL_SECONDS);
      if (txRefundMarkerKey && txRefundMarkerKey !== markerKey) {
        await kvSet(txRefundMarkerKey, "1", CONV_META_TTL_SECONDS);
      }
      if (shouldDecrementPaidSub) {
        await kvHIncrBy(key, planField, -1);
      }
      if (grossDelta > 0) {
        await kvHIncrByFloat(key, "grossRevenue", -grossDelta);
      }
      if (earnedDelta > 0) {
        await kvHIncrByFloat(key, "commissionEarned", -earnedDelta);
      }
      if (owedDelta > 0) {
        await kvHIncrByFloat(key, "commissionOwed", -owedDelta);
      }
      if (convMeta && convMetaKey) {
        await kvSet<CreatorConversionMeta>(
          convMetaKey,
          {
            ...convMeta,
            clawedBackCents: nextClawedBackCents,
            clawedBackGrossUsd: nextClawedBackGrossUsd,
            paidSubDecremented:
              Boolean(convMeta.paidSubDecremented) || shouldDecrementPaidSub,
          },
          CONV_META_TTL_SECONDS
        );
      }
      return "APPLIED";
    }
  );

  if (evalStatus === "NO_CREATOR") {
    return null;
  }
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
 * persisting a `pending_reconciliation` lock so ambiguous network/5xx/429 failures can be safely retried
 * with the identical Stripe `Idempotency-Key`, and rolling back ONLY on definitive 4xx rejections.
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
  if (creator.payoutApproved === false) {
    throw new Error("Creator code is pending admin approval before payouts can be issued.");
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
  const storedConnectAcct = (creator.stripeConnectAccountId || "").trim();
  const rawDest = (params.destination || "").trim();

  if (willExecuteStripeTransfer) {
    if (!storedConnectAcct || !storedConnectAcct.startsWith("acct_")) {
      throw new Error(
        `Creator ${norm} does not have a connected Stripe Express account (acct_...) yet. Ask them to connect on /creators or record a PayPal/Venmo/ACH/manual payout.`
      );
    }
    if (rawDest.startsWith("acct_") && rawDest !== storedConnectAcct) {
      throw new Error(
        `Destination Stripe account (${rawDest}) does not match creator ${norm}'s linked Stripe Connect account (${storedConnectAcct}).`
      );
    }
    if (!stripeKey) {
      throw new Error(
        "STRIPE_SECRET_KEY is not configured on this server to execute a live Stripe Connect transfer."
      );
    }
  }

  const key = creatorKey(norm);
  const pendingPayoutKey = `${PENDING_PAYOUT_PREFIX}${norm}`;
  const existingPending = await kvGet<PendingCreatorPayout>(
    pendingPayoutKey
  ).catch(() => null);

  let payoutId: string;
  let markerKey: string;
  let effectiveAmount: number;
  let connectAcct = willExecuteStripeTransfer ? storedConnectAcct : "";
  let destination: string | undefined;
  let idempotencyHeaderKey: string;

  if (existingPending && existingPending.status === "pending_reconciliation") {
    if (!willExecuteStripeTransfer) {
      throw new Error(
        `Creator ${norm} has a pending Stripe Connect payout ($${existingPending.effectiveAmount.toFixed(2)}, ID ${existingPending.payoutId}) awaiting reconciliation. Retry the Stripe Connect payout first so Stripe's Idempotency-Key reconciles whether the transfer already succeeded.`
      );
    }
    payoutId = existingPending.payoutId;
    markerKey = `heybroc:creator:payout_once:${payoutId}`;

    // Check if a concurrent retry already finalized this pending payout
    const existingPayouts = await listCreatorPayouts(norm);
    const matchedPayout = existingPayouts.find((p) => p.id === payoutId);
    const reloaded = await getCreator(norm);
    if (matchedPayout && reloaded) {
      await kvDel(pendingPayoutKey).catch(() => {});
      return { creator: reloaded, payout: matchedPayout };
    }

    effectiveAmount = round2(existingPending.effectiveAmount);
    connectAcct = existingPending.connectAcct || storedConnectAcct;
    destination = existingPending.destination || connectAcct;
    idempotencyHeaderKey =
      existingPending.idempotencyHeaderKey || `heybroc_payout_${payoutId}`;
  } else {
    const requestedAmount =
      params.amount !== undefined
        ? round2(Number(params.amount))
        : round2(Math.max(0, creator.commissionOwed));

    payoutId =
      params.idempotencyKey?.trim() ||
      `po_${norm}_paid${Math.round(creator.commissionPaid * 100)}_owed${Math.round(creator.commissionOwed * 100)}_amt${Math.round(requestedAmount * 100)}`;
    markerKey = `heybroc:creator:payout_once:${payoutId}`;
    idempotencyHeaderKey = `heybroc_payout_${payoutId}`;

    const requestedArg =
      params.amount !== undefined ? String(round2(Number(params.amount))) : "";

    const reserveLua = [
      'if redis.call("EXISTS", KEYS[1]) == 1 then',
      '  return {"DUPLICATE", redis.call("GET", KEYS[1]) or \'"1"\'}',
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
      'redis.call("SET", KEYS[1], \'"reserved"\', "EX", tonumber(ARGV[2]))',
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
      throw new Error(
        `Payout ${payoutId} is already in progress or completed.`
      );
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

    effectiveAmount = round2(Number(reserveVal));
    destination =
      method === "stripe_connect"
        ? connectAcct || undefined
        : rawDest || creator.payoutHandle || creator.payoutEmail || undefined;

    if (willExecuteStripeTransfer) {
      const pendingRecord: PendingCreatorPayout = {
        payoutId,
        code: norm,
        effectiveAmount,
        method,
        destination,
        connectAcct,
        idempotencyHeaderKey,
        status: "pending_reconciliation",
        note: params.note?.trim().slice(0, 200) || undefined,
        createdAt: new Date().toISOString(),
      };
      await kvSet<PendingCreatorPayout>(
        pendingPayoutKey,
        pendingRecord,
        PAYOUT_TTL_SECONDS
      );
      const markPendingLua = [
        'redis.call("SET", KEYS[1], \'"pending_reconciliation"\', "EX", tonumber(ARGV[1]))',
        "return 1",
      ].join("\n");
      await kvEvalLua<number>(
        markPendingLua,
        [markerKey],
        [Math.floor(PAYOUT_TTL_SECONDS)],
        async () => {
          await kvSet(markerKey, "pending_reconciliation", PAYOUT_TTL_SECONDS);
          return 1;
        }
      );
    }
  }

  const rollbackReservation = async () => {
    const rollbackLua = [
      'local cur = redis.call("GET", KEYS[1])',
      'if cur == "reserved" or cur == \'"reserved"\' or cur == "pending_reconciliation" or cur == \'"pending_reconciliation"\' then',
      '  redis.call("DEL", KEYS[1])',
      "  local amt = tonumber(ARGV[1]) or 0",
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
        if (cur === "reserved" || cur === "pending_reconciliation") {
          await kvDel(markerKey);
          await kvHIncrByFloat(key, "commissionOwed", effectiveAmount);
          await kvHIncrByFloat(key, "commissionPaid", -effectiveAmount);
          return 1;
        }
        return 0;
      }
    );
    await kvDel(pendingPayoutKey).catch(() => {});
  };

  let stripeTransferId: string | undefined;
  if (willExecuteStripeTransfer) {
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

    let res: Response;
    try {
      res = await fetch("https://api.stripe.com/v1/transfers", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": idempotencyHeaderKey,
        },
        body: transferParams.toString(),
      });
    } catch (networkErr) {
      const errMsg =
        networkErr instanceof Error
          ? networkErr.message
          : "network or timeout failure";
      await kvSet<PendingCreatorPayout>(
        pendingPayoutKey,
        {
          payoutId,
          code: norm,
          effectiveAmount,
          method,
          destination,
          connectAcct,
          idempotencyHeaderKey,
          status: "pending_reconciliation",
          note: params.note?.trim().slice(0, 200) || undefined,
          createdAt: existingPending?.createdAt || new Date().toISOString(),
          lastError: errMsg,
        },
        PAYOUT_TTL_SECONDS
      ).catch(() => {});
      throw new Error(
        `Stripe Connect transfer outcome is ambiguous (${errMsg}). Balance reservation ($${effectiveAmount.toFixed(2)}) remains safely locked in pending_reconciliation (${payoutId}); click Pay / retry to reconcile via Stripe Idempotency-Key without risking a duplicate payout.`
      );
    }

    const rawBody = await res.text().catch(() => null);
    let transferData: {
      id?: string;
      error?: { message?: string; type?: string };
    } | null = null;
    if (typeof rawBody === "string" && rawBody.trim().length > 0) {
      try {
        transferData = JSON.parse(rawBody) as {
          id?: string;
          error?: { message?: string; type?: string };
        };
      } catch {
        transferData = null;
      }
    }

    const isDefinitiveClientRejection =
      res.status >= 400 &&
      res.status < 500 &&
      res.status !== 429 &&
      res.status !== 409;

    if (isDefinitiveClientRejection) {
      await rollbackReservation();
      throw new Error(
        transferData?.error?.message ||
          `Stripe Connect transfer rejected with HTTP ${res.status}.`
      );
    }

    if (!res.ok) {
      const errMsg =
        transferData?.error?.message ||
        `Stripe Connect returned HTTP ${res.status}`;
      await kvSet<PendingCreatorPayout>(
        pendingPayoutKey,
        {
          payoutId,
          code: norm,
          effectiveAmount,
          method,
          destination,
          connectAcct,
          idempotencyHeaderKey,
          status: "pending_reconciliation",
          note: params.note?.trim().slice(0, 200) || undefined,
          createdAt: existingPending?.createdAt || new Date().toISOString(),
          lastError: errMsg,
        },
        PAYOUT_TTL_SECONDS
      ).catch(() => {});
      throw new Error(
        `${errMsg}. Balance reservation ($${effectiveAmount.toFixed(2)}) remains safely locked in pending_reconciliation (${payoutId}); retry safely to reconcile via Stripe Idempotency-Key.`
      );
    }

    if (
      !transferData ||
      typeof transferData.id !== "string" ||
      !transferData.id.trim()
    ) {
      await kvSet<PendingCreatorPayout>(
        pendingPayoutKey,
        {
          payoutId,
          code: norm,
          effectiveAmount,
          method,
          destination,
          connectAcct,
          idempotencyHeaderKey,
          status: "pending_reconciliation",
          note: params.note?.trim().slice(0, 200) || undefined,
          createdAt: existingPending?.createdAt || new Date().toISOString(),
          lastError: `Unparseable or incomplete HTTP ${res.status} response`,
        },
        PAYOUT_TTL_SECONDS
      ).catch(() => {});
      throw new Error(
        `Stripe Connect returned HTTP ${res.status} with an incomplete or unparseable JSON payload. Balance reservation ($${effectiveAmount.toFixed(2)}) remains safely locked in pending_reconciliation (${payoutId}); retry safely to reconcile via Stripe Idempotency-Key.`
      );
    }

    stripeTransferId = transferData.id.trim();
  }

  // Finalize reservation marker and clear pending_payout lock so subsequent retries return the completed payout record
  const finalizeLua = [
    'redis.call("SET", KEYS[1], \'"paid"\', "EX", tonumber(ARGV[1]))',
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
  await kvDel(pendingPayoutKey).catch(() => {});

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
  const resetLua = [
    'if redis.call("EXISTS", KEYS[1]) == 0 then return 0 end',
    'if redis.call("EXISTS", KEYS[2]) == 1 then return 0 end',
    'local fields = {"commissionPaid", "commissionOwed", "commissionEarned", "grossRevenue", "paidAnnual", "paidMonthly"}',
    'for _, f in ipairs(fields) do',
    '  local v = tonumber(redis.call("HGET", KEYS[1], f) or "0") or 0',
    '  if math.abs(v) > 0.0001 then return 0 end',
    'end',
    'redis.call("HSET", KEYS[1], "clicks", "0", "trials", "0")',
    'return 1',
  ].join("\n");

  for (const c of creators) {
    // Only reset non-financial engagement counters (clicks, trials) on creators with zero financial activity
    // so paid/unpaid/negative balances, sales counts, and operational fields (active, payoutApproved, payout details)
    // are never erased or overwritten.
    if (
      c.commissionPaid !== 0 ||
      c.commissionOwed !== 0 ||
      c.commissionEarned !== 0 ||
      c.grossRevenue !== 0 ||
      c.paidAnnual !== 0 ||
      c.paidMonthly !== 0
    ) {
      continue;
    }
    const norm = normalizeCode(c.code);
    if (!norm) continue;
    const key = creatorKey(norm);
    const pendingKey = `${PENDING_PAYOUT_PREFIX}${norm}`;
    await kvEvalLua<number>(
      resetLua,
      [key, pendingKey],
      [],
      async () => {
        const live = await getCreator(norm);
        if (!live) return 0;
        const pending = await kvGet<PendingCreatorPayout>(pendingKey);
        if (pending) return 0;
        if (
          live.commissionPaid !== 0 ||
          live.commissionOwed !== 0 ||
          live.commissionEarned !== 0 ||
          live.grossRevenue !== 0 ||
          live.paidAnnual !== 0 ||
          live.paidMonthly !== 0
        ) {
          return 0;
        }
        await kvHSet(key, { clicks: 0, trials: 0 });
        return 1;
      }
    );
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
