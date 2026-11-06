/**
 * CleanCart — Influencer / Creator affiliate store (server-only).
 * In-memory with best-effort JSON persistence (./.cache locally, /tmp on Vercel).
 * For production, swap this module for a real database (e.g. Vercel Postgres / Supabase).
 */
import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { PRICING, commissionFor, type PlanId } from "./pricing";

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

const DIR = process.env.CLEANCART_CACHE_DIR || (process.env.VERCEL ? "/tmp/cleancart-cache" : path.join(process.cwd(), ".cache"));
const FILE = path.join(DIR, "influencers.json");

const SEED: Array<Pick<Creator, "code" | "name">> = [
  { code: "CLEANMOM", name: "Clean Mom Club" },
  { code: "WALMARTHAUL", name: "Walmart Haul Daily" },
  { code: "SARAHHAULS", name: "Sarah Grocery Hauls" },
  { code: "PARENTMAXX", name: "ParentMaxxing Official" },
];

let store: Map<string, Creator> | null = null;

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
  if (store) return store;
  try {
    const json = JSON.parse(await fs.readFile(FILE, "utf8")) as Creator[];
    store = new Map(json.map((c) => [c.code, c]));
    for (const s of SEED) {
      if (!store.has(s.code)) store.set(s.code, blank(s.code, s.name));
    }
  } catch {
    store = new Map(SEED.map((s) => [s.code, blank(s.code, s.name)]));
  }
  return store;
}

async function save() {
  if (!store) return;
  try {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify([...store.values()], null, 2));
  } catch {
    /* read-only FS: keep in memory */
  }
}

export async function listCreators(): Promise<Creator[]> {
  return [...(await load()).values()].sort((a, b) => b.netRevenue - a.netRevenue || a.code.localeCompare(b.code));
}

export async function getCreator(code: string): Promise<Creator | null> {
  return (await load()).get(normalizeCode(code)) ?? null;
}

/** Finds an existing creator or auto-creates one at the default 35% split so any test code works. */
export async function getOrCreateCreator(code: string, name?: string, commissionPct?: number): Promise<Creator> {
  const norm = normalizeCode(code);
  if (norm.length < 2) throw new Error("Creator code must be at least 2 characters.");
  const s = await load();
  const existing = s.get(norm);
  if (existing) return existing;
  const pct = clampPct(commissionPct ?? PRICING.defaultCommissionPct);
  const created = blank(norm, name?.trim() || norm, pct);
  s.set(norm, created);
  await save();
  return created;
}

export async function createCreator(input: { code: string; name?: string; commissionPct?: number }): Promise<Creator> {
  const s = await load();
  const code = normalizeCode(input.code);
  if (code.length < 2) throw new Error("Creator code must be at least 2 letters/numbers.");
  if (s.has(code)) {
    const existing = s.get(code)!;
    if (input.commissionPct !== undefined) existing.commissionPct = clampPct(input.commissionPct);
    if (input.name?.trim()) existing.name = input.name.trim();
    await save();
    return existing;
  }
  const pct = clampPct(input.commissionPct ?? PRICING.defaultCommissionPct);
  const c = blank(code, input.name?.trim() || code, pct);
  s.set(code, c);
  await save();
  return c;
}

export async function updateCreator(code: string, patch: { commissionPct?: number; name?: string }): Promise<Creator> {
  const c = await getCreator(code);
  if (!c) throw new Error("Unknown creator code.");
  if (patch.commissionPct !== undefined) c.commissionPct = clampPct(patch.commissionPct);
  if (patch.name) c.name = patch.name.trim();
  await save();
  return c;
}

export async function deleteCreator(code: string) {
  (await load()).delete(normalizeCode(code));
  await save();
}

/** Records a funnel event and recomputes payout math. Commission is locked at the creator's current split. */
export async function trackEvent(code: string, event: CreatorEvent): Promise<Creator> {
  const c = await getOrCreateCreator(code);
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
  await save();
  return c;
}

export async function resetStats() {
  const s = await load();
  for (const c of s.values()) Object.assign(c, { ...blank(c.code, c.name, c.commissionPct), createdAt: c.createdAt });
  await save();
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
