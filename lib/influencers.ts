/**
 * CleanCart — Influencer / Creator affiliate store (server-only).
 * Backed by Upstash Redis / Vercel KV via lib/storage.ts (with local .cache fallback in dev).
 */
import "server-only";
import { PRICING, commissionFor, type PlanId } from "./pricing";
import { kvGet, kvSet, kvSetNx } from "./storage";

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

export type CreatorEvent = "click" | "trial" | "paid_annual" | "paid_monthly" | "checkout_annual";

const CREATORS_KV_KEY = "heybroc:creators:v1";

const SEED: Array<Pick<Creator, "code" | "name">> = [
  { code: "CLEANMOM", name: "Clean Mom Club" },
  { code: "WALMARTHAUL", name: "Walmart Haul Daily" },
  { code: "SARAHHAULS", name: "Sarah Grocery Hauls" },
  { code: "PARENTMAXX", name: "ParentMaxxing Official" },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

export function normalizeCode(code: string): string {
  return (code || "").toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 24);
}

function blank(code: string, name: string, commissionPct: number = PRICING.defaultCommissionPct): Creator {
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

async function load(): Promise<Map<string, Creator>> {
  try {
    const json = await kvGet<Creator[]>(CREATORS_KV_KEY);
    if (Array.isArray(json) && json.length > 0) {
      const store = new Map(json.map((c) => [c.code, c]));
      for (const s of SEED) {
        if (!store.has(s.code)) store.set(s.code, blank(s.code, s.name));
      }
      return store;
    }
  } catch {
    /* fall through to seed */
  }
  const seeded = new Map(SEED.map((s) => [s.code, blank(s.code, s.name)]));
  await save(seeded);
  return seeded;
}

async function save(store: Map<string, Creator>) {
  await kvSet(CREATORS_KV_KEY, [...store.values()]);
}

export async function listCreators(): Promise<Creator[]> {
  return [...(await load()).values()].sort((a, b) => b.netRevenue - a.netRevenue || a.code.localeCompare(b.code));
}

export async function getCreator(code: string): Promise<Creator | null> {
  return (await load()).get(normalizeCode(code)) ?? null;
}

export async function createCreator(input: { code: string; name?: string; commissionPct?: number }): Promise<Creator> {
  const s = await load();
  const code = normalizeCode(input.code);
  if (code.length < 2) throw new Error("Creator code must be at least 2 letters/numbers.");
  if (s.has(code)) {
    const existing = s.get(code)!;
    if (input.commissionPct !== undefined) existing.commissionPct = clampPct(input.commissionPct);
    if (input.name?.trim()) existing.name = input.name.trim();
    await save(s);
    return existing;
  }
  const pct = clampPct(input.commissionPct ?? PRICING.defaultCommissionPct);
  const c = blank(code, input.name?.trim() || code, pct);
  s.set(code, c);
  await save(s);
  return c;
}

export async function updateCreator(code: string, patch: { commissionPct?: number; name?: string }): Promise<Creator> {
  const s = await load();
  const c = s.get(normalizeCode(code));
  if (!c) throw new Error("Unknown creator code.");
  if (patch.commissionPct !== undefined) c.commissionPct = clampPct(patch.commissionPct);
  if (patch.name) c.name = patch.name.trim();
  await save(s);
  return c;
}

export async function deleteCreator(code: string) {
  const s = await load();
  s.delete(normalizeCode(code));
  await save(s);
}

/** Records a funnel event and recomputes payout math. Commission is locked at the creator's current split. */
export async function trackEvent(code: string, event: CreatorEvent): Promise<Creator> {
  const s = await load();
  const c = s.get(normalizeCode(code));
  if (!c) throw new Error("Invalid creator code.");
  const paid = (plan: PlanId) => {
    const price = plan === "annual" ? PRICING.annual : PRICING.monthly;
    c.grossRevenue = round2(c.grossRevenue + price);
    c.commissionOwed = round2(c.commissionOwed + commissionFor(plan, c.commissionPct));
  };
  if (event === "click") c.clicks++;
  if (event === "trial") c.trials++;
  if (event === "paid_annual") {
    c.paidAnnual++;
    paid("annual");
  }
  if (event === "checkout_annual") {
    c.trials++;
    c.paidAnnual++;
    paid("annual");
  }
  if (event === "paid_monthly") {
    c.paidMonthly++;
    paid("monthly");
  }
  c.netRevenue = round2(c.grossRevenue - c.commissionOwed);
  await save(s);
  return c;
}

/**
 * Idempotently records a creator conversion from a verified Stripe webhook event.
 * Prevents duplicate webhook deliveries from inflating creator payouts.
 */
export async function recordStripeCreatorConversionOnce(
  idempotencyKey: string,
  code: string,
  event: CreatorEvent
): Promise<Creator | null> {
  const norm = normalizeCode(code);
  if (!norm) return null;
  const creator = await getCreator(norm);
  if (!creator) return null;
  const acquired = await kvSetNx(`heybroc:creator:conv:${idempotencyKey}`, "1");
  if (!acquired) return creator;
  return trackEvent(norm, event);
}

export async function resetStats() {
  const s = await load();
  for (const c of s.values()) Object.assign(c, { ...blank(c.code, c.name, c.commissionPct), createdAt: c.createdAt });
  await save(s);
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
    { clicks: 0, trials: 0, paidAnnual: 0, paidMonthly: 0, grossRevenue: 0, commissionOwed: 0, netRevenue: 0 },
  );
  return { ...t, grossRevenue: round2(t.grossRevenue), commissionOwed: round2(t.commissionOwed), netRevenue: round2(t.netRevenue) };
}

function clampPct(n: number) {
  return Math.max(0, Math.min(90, Math.round(Number(n) * 10) / 10 || 0));
}
