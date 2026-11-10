/**
 * CleanCart — Influencer / Creator affiliate store (server-only).
 *
 * Each creator is stored under its own Redis Hash key (`heybroc:creator:<CODE>`)
 * with an index set (`heybroc:creators:codes`), using `HINCRBY` and `HINCRBYFLOAT`
 * for atomic counter updates so concurrent public clicks and Stripe payments never
 * overwrite each other.
 *
 * Read errors from KV propagate instead of catching and reseeding over existing data.
 */
import "server-only";
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

export interface Creator {
  code: string;
  name: string;
  commissionPct: number;
  clicks: number;
  trials: number;
  paidAnnual: number;
  paidMonthly: number;
  grossRevenue: number;
  commissionOwed: number;
  netRevenue: number;
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
const CREATORS_SEEDED_KEY = "heybroc:creators:seeded:v2";

const SEED: Array<Pick<Creator, "code" | "name">> = [
  { code: "CLEANMOM", name: "Clean Mom Club" },
  { code: "GROCERYHAUL", name: "Grocery Haul Daily" },
  { code: "SARAHHAULS", name: "Sarah Grocery Hauls" },
  { code: "PARENTMAXX", name: "ParentMaxxing Official" },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

export function normalizeCode(code: string): string {
  return (code || "").toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 24);
}

function creatorKey(code: string): string {
  return `${CREATOR_HASH_PREFIX}${normalizeCode(code)}`;
}

function blank(
  code: string,
  name: string,
  commissionPct: number = PRICING.defaultCommissionPct
): Creator {
  return {
    code,
    name,
    commissionPct,
    clicks: 0,
    trials: 0,
    paidAnnual: 0,
    paidMonthly: 0,
    grossRevenue: 0,
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
  const commissionOwed = Math.max(0, round2(Number(fields.commissionOwed ?? 0)));
  return {
    code: fields.code || code,
    name: fields.name || code,
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
    commissionOwed,
    netRevenue: round2(grossRevenue - commissionOwed),
    createdAt: fields.createdAt || new Date().toISOString(),
  };
}

async function saveCreatorHash(c: Creator): Promise<void> {
  await kvHSet(creatorKey(c.code), {
    code: c.code,
    name: c.name,
    commissionPct: c.commissionPct,
    clicks: c.clicks,
    trials: c.trials,
    paidAnnual: c.paidAnnual,
    paidMonthly: c.paidMonthly,
    grossRevenue: round2(c.grossRevenue),
    commissionOwed: round2(c.commissionOwed),
    createdAt: c.createdAt,
  });
  await kvSAdd(CREATOR_CODES_SET_KEY, c.code);
}

/**
 * One-time initialization / migration from legacy array if `heybroc:creators:seeded:v2` is not set.
 * IMPORTANT: Any KV error throws instead of catching and overwriting existing data.
 */
async function ensureInitialized(): Promise<void> {
  const alreadySeeded = await kvGet<string>(CREATORS_SEEDED_KEY);
  if (alreadySeeded === "1") return;

  // Migrate any legacy v1 creators without overwriting existing per-creator hashes
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
}): Promise<Creator> {
  await ensureInitialized();
  const code = normalizeCode(input.code);
  if (code.length < 2) {
    throw new Error("Creator code must be at least 2 letters/numbers.");
  }

  const existing = await getCreator(code);
  if (existing) {
    const patchFields: Record<string, string | number> = {};
    if (input.commissionPct !== undefined) {
      existing.commissionPct = clampPct(input.commissionPct);
      patchFields.commissionPct = existing.commissionPct;
    }
    if (input.name?.trim()) {
      existing.name = input.name.trim();
      patchFields.name = existing.name;
    }
    if (Object.keys(patchFields).length > 0) {
      await kvHSet(creatorKey(code), patchFields);
    }
    await kvSAdd(CREATOR_CODES_SET_KEY, code);
    return existing;
  }

  const pct = clampPct(input.commissionPct ?? PRICING.defaultCommissionPct);
  const created = blank(code, input.name?.trim() || code, pct);
  await saveCreatorHash(created);
  return created;
}

export async function updateCreator(
  code: string,
  patch: { commissionPct?: number; name?: string }
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
    existing.name = patch.name.trim();
    patchFields.name = existing.name;
  }
  if (Object.keys(patchFields).length > 0) {
    await kvHSet(creatorKey(norm), patchFields);
  }
  return existing;
}

export async function deleteCreator(code: string): Promise<void> {
  await ensureInitialized();
  const norm = normalizeCode(code);
  if (!norm) return;
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
  if (!c) throw new Error("Invalid creator code.");

  const key = creatorKey(norm);

  const creditPlan = async (plan: PlanId) => {
    const price = plan === "annual" ? PRICING.annual : PRICING.monthly;
    const comm = commissionFor(plan, c.commissionPct);
    await kvHIncrByFloat(key, "grossRevenue", price);
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
 * Uses `kvAtomicHashUpdateOnce` so concurrent webhook deliveries (e.g. `checkout.session.completed`,
 * `customer.subscription.updated`, `invoice.paid`) cannot double-credit the creator ledger.
 */
export async function recordStripeCreatorConversionOnce(
  idempotencyKey: string,
  code: string,
  event: CreatorEvent,
  amountPaidUsd?: number
): Promise<Creator | null> {
  const norm = normalizeCode(code);
  if (!norm) return null;
  const creator = await getCreator(norm);
  if (!creator) return null;

  const markerKey = `heybroc:creator:conv:${idempotencyKey}`;
  const key = creatorKey(norm);
  const deltas: Array<{ field: string; delta: number; isFloat?: boolean }> = [];

  const resolveGrossAndComm = (plan: PlanId) => {
    const gross =
      typeof amountPaidUsd === "number" && Number.isFinite(amountPaidUsd) && amountPaidUsd > 0
        ? round2(amountPaidUsd)
        : plan === "annual"
          ? PRICING.annual
          : PRICING.monthly;
    const comm =
      typeof amountPaidUsd === "number" && Number.isFinite(amountPaidUsd) && amountPaidUsd > 0
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
      {
        field: "commissionOwed",
        delta: comm,
        isFloat: true,
      }
    );
  } else if (event === "checkout_annual") {
    const { gross, comm } = resolveGrossAndComm("annual");
    deltas.push(
      { field: "trials", delta: 1 },
      { field: "paidAnnual", delta: 1 },
      { field: "grossRevenue", delta: gross, isFloat: true },
      {
        field: "commissionOwed",
        delta: comm,
        isFloat: true,
      }
    );
  } else if (event === "paid_monthly") {
    const { gross, comm } = resolveGrossAndComm("monthly");
    deltas.push(
      { field: "paidMonthly", delta: 1 },
      { field: "grossRevenue", delta: gross, isFloat: true },
      {
        field: "commissionOwed",
        delta: comm,
        isFloat: true,
      }
    );
  }

  await kvAtomicHashUpdateOnce(markerKey, key, deltas, 60 * 60 * 24 * 365);
  return getCreator(norm);
}

/**
 * Idempotently claws back creator revenue & commission when a charge is refunded.
 */
export async function recordStripeCreatorRefundOnce(
  idempotencyKey: string,
  code: string,
  plan: PlanId,
  refundAmountUsd?: number
): Promise<Creator | null> {
  const norm = normalizeCode(code);
  if (!norm) return null;
  const creator = await getCreator(norm);
  if (!creator) return null;

  const markerKey = `heybroc:creator:refund:${idempotencyKey}`;
  const fullPrice = plan === "annual" ? PRICING.annual : PRICING.monthly;
  const grossDelta =
    refundAmountUsd !== undefined && refundAmountUsd > 0
      ? Math.min(fullPrice, round2(refundAmountUsd))
      : fullPrice;
  const commDelta = round2(grossDelta * (creator.commissionPct / 100));

  const isFullRefund = grossDelta >= fullPrice * 0.99;
  const planField = plan === "annual" ? "paidAnnual" : "paidMonthly";
  const key = creatorKey(norm);
  await kvAtomicHashUpdateOnce(
    markerKey,
    key,
    [
      ...(isFullRefund ? [{ field: planField, delta: -1 }] : []),
      { field: "grossRevenue", delta: -grossDelta, isFloat: true },
      { field: "commissionOwed", delta: -commDelta, isFloat: true },
    ],
    60 * 60 * 24 * 365
  );

  return getCreator(norm);
}

export async function resetStats(): Promise<void> {
  await ensureInitialized();
  const creators = await listCreators();
  for (const c of creators) {
    await saveCreatorHash({
      ...blank(c.code, c.name, c.commissionPct),
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
      commissionOwed: a.commissionOwed + c.commissionOwed,
      netRevenue: a.netRevenue + c.netRevenue,
    }),
    {
      clicks: 0,
      trials: 0,
      paidAnnual: 0,
      paidMonthly: 0,
      grossRevenue: 0,
      commissionOwed: 0,
      netRevenue: 0,
    }
  );
  return {
    ...t,
    grossRevenue: round2(t.grossRevenue),
    commissionOwed: round2(t.commissionOwed),
    netRevenue: round2(t.netRevenue),
  };
}

function clampPct(n: number) {
  return Math.max(0, Math.min(90, Math.round(Number(n) * 10) / 10 || 0));
}
