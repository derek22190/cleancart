/**
 * CleanCart pricing & creator-commission math (isomorphic — used by the paywall UI,
 * the influencer API, and the outreach projection calculator).
 */

import { TERMS_VERSION } from "./terms";

export { TERMS_VERSION };

export const PRICING = {
  annual: 49.99,
  monthly: 9.99,
  trialDays: 7,
  creatorTrialDays: 14,
  freeWeeklySwaps: 3,
  courtesyRefillSwaps: 0,
  firstTripPassDays: 7,
  referralBonusDays: 7,
  defaultCommissionPct: 35,
} as const;

export type PlanId = "annual" | "monthly";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** $49.99 / 12 shown as $4.16 (floored so we never over-promise). */
export const annualPerMonth = Math.floor((PRICING.annual / 12) * 100) / 100;
/** $9.99 × 12 = $119.88 */
export const monthlyPerYear = round2(PRICING.monthly * 12);
/** 1 − 49.99 / 119.88 ≈ 58% */
export const annualSavingsPct = Math.round((1 - PRICING.annual / monthlyPerYear) * 100);

export function planPrice(plan: PlanId): number {
  return plan === "annual" ? PRICING.annual : PRICING.monthly;
}

/** Creator payout for one conversion, e.g. 35% of $49.99 = $17.50. */
export function commissionFor(plan: PlanId, pct: number): number {
  return round2((planPrice(plan) * pct) / 100);
}

export function usd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

export interface OutreachInputs {
  creators: number;
  clicksPerCreator: number;
  trialRatePct: number; // clicks -> trials
  trialToPaidPct: number; // trials -> paid annual
  commissionPct: number;
}

/** Projection for an N-influencer outreach campaign (annual plan only, before app-store fees). */
export function projectOutreach(i: OutreachInputs) {
  const clicks = i.creators * i.clicksPerCreator;
  const trials = Math.round((clicks * i.trialRatePct) / 100);
  const paid = Math.round((trials * i.trialToPaidPct) / 100);
  const gross = round2(paid * PRICING.annual);
  const commission = round2(paid * commissionFor("annual", i.commissionPct));
  return { clicks, trials, paid, gross, commission, net: round2(gross - commission) };
}
