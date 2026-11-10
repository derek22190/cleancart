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
  payoutMethod?: CreatorPayoutMethod;
  payoutHandle?: string;
  stripeConnectAccountId?: string;
  lastPayoutAt?: string;
  createdAt: string;
}

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

export function createCreatorAccessToken(rawCode: string): string {
  const code = normalizeCode(rawCode);
  const sig = crypto
    .createHmac("sha256", getCreatorSigningSecret())
    .update(`creator:v1:${code}`, "utf8")
    .digest("base64url");
  return `hbc_${code}.${sig}`;
}

export function verifyCreatorAccessToken(
  rawCode: string,
  candidateToken?: string | null
): boolean {
  const code = normalizeCode(rawCode);
  const clean = (candidateToken || "").trim();
  if (!code || !clean) return false;
  let expected: string;
  try {
    expected = createCreatorAccessToken(code);
  } catch {
    return false;
  }
  const bufA = Buffer.from(clean, "utf8");
  const bufB = Buffer.from(expected, "utf8");
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
    payoutMethod: normalizePayoutMethod(fields.payoutMethod),
    payoutHandle: fields.payoutHandle || undefined,
    stripeConnectAccountId: fields.stripeConnectAccountId || undefined,
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
  if (c.payoutMethod !== undefined) hashFields.payoutMethod = c.payoutMethod;
  if (c.payoutHandle !== undefined) hashFields.payoutHandle = c.payoutHandle;
  if (c.stripeConnectAccountId !== undefined) {
    hashFields.stripeConnectAccountId = c.stripeConnectAccountId;
  }
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
  payoutMethod?: CreatorPayoutMethod;
  payoutHandle?: string;
  stripeConnectAccountId?: string;
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
      payoutMethod: input.payoutMethod,
      payoutHandle: input.payoutHandle,
      stripeConnectAccountId: input.stripeConnectAccountId,
      active: input.active,
    });
  }

  const pct = clampPct(input.commissionPct ?? PRICING.defaultCommissionPct);
  const created: Creator = {
    ...blank(code, input.name?.trim() || code, pct),
    active: input.active ?? true,
    payoutEmail: normalizeEmailOpt(input.payoutEmail),
    payoutMethod: normalizePayoutMethod(input.payoutMethod),
    payoutHandle: input.payoutHandle?.trim().slice(0, 120) || undefined,
    stripeConnectAccountId: input.stripeConnectAccountId?.trim() || undefined,
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
    payoutMethod?: CreatorPayoutMethod;
    payoutHandle?: string;
    stripeConnectAccountId?: string;
  }
): Promise<Creator> {
  await ensureInitialized();
  const norm = normalizeCode(code);
  const existing = await getCreator(norm);
  if (!existing) throw new Error("Unknown creator code.");

  const patchFields: Record<string, string | number> = {};
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
    const cleanEmail = normalizeEmailOpt(patch.payoutEmail) || "";
    existing.payoutEmail = cleanEmail || undefined;
    patchFields.payoutEmail = cleanEmail;
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

  // Anti-self-dealing guard: creators cannot earn affiliate commission on their own personal email purchase
  if (
    buyerEmail &&
    creator.payoutEmail &&
    buyerEmail.trim().toLowerCase() === creator.payoutEmail.trim().toLowerCase()
  ) {
    return creator;
  }

  const markerKey = `heybroc:creator:conv:${idempotencyKey}`;
  const key = creatorKey(norm);
  const deltas: Array<{ field: string; delta: number; isFloat?: boolean }> = [];

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
    deltas.push(
      { field: "paidAnnual", delta: 1 },
      { field: "grossRevenue", delta: gross, isFloat: true },
      { field: "commissionEarned", delta: comm, isFloat: true },
      { field: "commissionOwed", delta: comm, isFloat: true }
    );
  } else if (event === "checkout_annual") {
    const { gross, comm } = resolveGrossAndComm("annual");
    deltas.push(
      { field: "trials", delta: 1 },
      { field: "paidAnnual", delta: 1 },
      { field: "grossRevenue", delta: gross, isFloat: true },
      { field: "commissionEarned", delta: comm, isFloat: true },
      { field: "commissionOwed", delta: comm, isFloat: true }
    );
  } else if (event === "paid_monthly") {
    const { gross, comm } = resolveGrossAndComm("monthly");
    deltas.push(
      { field: "paidMonthly", delta: 1 },
      { field: "grossRevenue", delta: gross, isFloat: true },
      { field: "commissionEarned", delta: comm, isFloat: true },
      { field: "commissionOwed", delta: comm, isFloat: true }
    );
  }

  await kvAtomicHashUpdateOnce(markerKey, key, deltas, 60 * 60 * 24 * 365);
  return getCreator(norm);
}

/**
 * Idempotently claws back creator revenue & commission when a charge is refunded or disputed.
 */
export async function recordStripeCreatorRefundOnce(
  idempotencyKey: string,
  code: string,
  plan: PlanId,
  refundAmountUsd?: number,
  isFullRefundOverride?: boolean
): Promise<Creator | null> {
  const norm = normalizeCode(code);
  if (!norm) return null;
  const creator = await getCreator(norm);
  if (!creator) return null;

  const markerKey = `heybroc:creator:refund:${idempotencyKey}`;
  const fullPrice = plan === "annual" ? PRICING.annual : PRICING.monthly;
  const requestedGross =
    refundAmountUsd !== undefined && refundAmountUsd > 0
      ? Math.min(fullPrice, round2(refundAmountUsd))
      : fullPrice;
  const grossDelta = Math.min(creator.grossRevenue, requestedGross);
  const rawCommDelta = round2(grossDelta * (creator.commissionPct / 100));
  const earnedDelta = Math.min(
    Math.max(0, creator.commissionEarned - creator.commissionPaid),
    rawCommDelta
  );
  const owedDelta = Math.min(creator.commissionOwed, rawCommDelta);

  const isFullRefund =
    isFullRefundOverride ??
    (grossDelta >= fullPrice * 0.99 ||
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
 * and atomically moves `amount` from `commissionOwed` to `commissionPaid`.
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
  if (creator.commissionOwed <= 0) {
    throw new Error(`No unpaid commission balance owed for ${norm}.`);
  }

  const amount =
    params.amount !== undefined
      ? round2(Number(params.amount))
      : creator.commissionOwed;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Payout amount must be greater than $0.00.");
  }
  if (amount > round2(creator.commissionOwed + 0.005)) {
    throw new Error(
      `Payout amount ($${amount.toFixed(2)}) exceeds unpaid balance owed ($${creator.commissionOwed.toFixed(2)}).`
    );
  }
  const effectiveAmount = Math.min(creator.commissionOwed, amount);

  const method: CreatorPayoutMethod =
    normalizePayoutMethod(params.method) ||
    creator.payoutMethod ||
    (creator.stripeConnectAccountId ? "stripe_connect" : "manual");

  const payoutId =
    params.idempotencyKey?.trim() ||
    `po_${norm}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const markerKey = `heybroc:creator:payout_once:${payoutId}`;

  let stripeTransferId: string | undefined;
  const destination =
    params.destination?.trim() ||
    (method === "stripe_connect"
      ? creator.stripeConnectAccountId
      : creator.payoutHandle || creator.payoutEmail);

  if (params.executeStripeTransfer || method === "stripe_connect") {
    if (params.executeStripeTransfer !== false && method === "stripe_connect") {
      const stripeKey = (process.env.STRIPE_SECRET_KEY || "").trim();
      const connectAcct = (
        params.destination?.trim() ||
        creator.stripeConnectAccountId ||
        ""
      ).trim();
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
    }
  }

  const key = creatorKey(norm);
  const applied = await kvAtomicHashUpdateOnce(
    markerKey,
    key,
    [
      { field: "commissionOwed", delta: -effectiveAmount, isFloat: true },
      { field: "commissionPaid", delta: effectiveAmount, isFloat: true },
    ],
    PAYOUT_TTL_SECONDS
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

  if (applied) {
    await kvHSet(key, { lastPayoutAt: nowIso });
    const existingList = await listCreatorPayouts(norm);
    const nextList = [payoutRecord, ...existingList].slice(0, 100);
    await kvSet(creatorPayoutsKey(norm), nextList, PAYOUT_TTL_SECONDS);

    const existingRecent = await listCreatorPayouts();
    const nextRecent = [payoutRecord, ...existingRecent].slice(0, 200);
    await kvSet(RECENT_PAYOUTS_KEY, nextRecent, PAYOUT_TTL_SECONDS);
  }

  const updated = await getCreator(norm);
  if (!updated) {
    throw new Error("Failed to reload creator after payout.");
  }
  return { creator: updated, payout: payoutRecord };
}

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

  const safeOrigin = params.origin.replace(/\/+$/, "") || "https://heybroc.com";
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
      payoutMethod: c.payoutMethod,
      payoutHandle: c.payoutHandle,
      stripeConnectAccountId: c.stripeConnectAccountId,
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
