"use client";

import { useEffect, useState } from "react";
import {
  PRICING,
  annualPerMonth,
  annualSavingsPct,
  commissionFor,
  monthlyPerYear,
  usd,
  type PlanId,
} from "@/lib/pricing";

export interface AppliedCreator {
  code: string;
  name: string;
  commissionPct: number;
}

interface PaywallProps {
  open: boolean;
  onClose: () => void;
  scanCount: number;
  freeScanLimit: number;
  appliedCreator: AppliedCreator | null;
  onCreatorApplied: (creator: AppliedCreator | null) => void;
  onConversionComplete: (info: {
    plan: PlanId;
    creator: AppliedCreator | null;
    trialDays: number;
    commissionOwed?: number;
  }) => void;
  onOpenInfluencerEngine: () => void;
}

const SAMPLE_CODES = ["CLEANMOM", "WALMARTHAUL", "SARAHHAULS", "PARENTMAXX"];

export default function Paywall({
  open,
  onClose,
  scanCount,
  freeScanLimit,
  appliedCreator,
  onCreatorApplied,
  onConversionComplete,
  onOpenInfluencerEngine,
}: PaywallProps) {
  const [selectedPlan, setSelectedPlan] = useState<PlanId>("annual");
  const [codeInput, setCodeInput] = useState(appliedCreator?.code ?? "");
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState("");
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [receipt, setReceipt] = useState<{
    plan: PlanId;
    trialDays: number;
    creator: AppliedCreator | null;
    commission: number;
    net: number;
  } | null>(null);

  useEffect(() => {
    if (appliedCreator?.code) setCodeInput(appliedCreator.code);
  }, [appliedCreator]);

  if (!open) return null;

  const trialDays = appliedCreator ? PRICING.creatorTrialDays : PRICING.trialDays;

  const applyCode = async (raw?: string) => {
    const target = (raw ?? codeInput).trim().toUpperCase();
    if (!target) {
      setCodeError("Enter a creator code first (e.g. CLEANMOM).");
      return;
    }
    setCodeBusy(true);
    setCodeError("");
    try {
      const res = await fetch("/api/influencers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "track", code: target, event: "click" }),
      });
      const data = await res.json();
      if (!data.ok || !data.creator) {
        setCodeError(data.error || "Could not apply code.");
        return;
      }
      const c: AppliedCreator = {
        code: data.creator.code,
        name: data.creator.name,
        commissionPct: data.creator.commissionPct,
      };
      setCodeInput(c.code);
      onCreatorApplied(c);
    } catch {
      setCodeError("Network error validating code.");
    } finally {
      setCodeBusy(false);
    }
  };

  const handleCheckout = async () => {
    setCheckoutBusy(true);
    try {
      const gross = selectedPlan === "annual" ? PRICING.annual : PRICING.monthly;
      let commission = 0;
      if (appliedCreator) {
        commission = commissionFor(selectedPlan, appliedCreator.commissionPct);
        const event = selectedPlan === "annual" ? "checkout_annual" : "paid_monthly";
        await fetch("/api/influencers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "track", code: appliedCreator.code, event }),
        });
      }
      const net = Math.round((gross - commission) * 100) / 100;
      setReceipt({
        plan: selectedPlan,
        trialDays: selectedPlan === "annual" ? trialDays : 0,
        creator: appliedCreator,
        commission,
        net,
      });
      onConversionComplete({
        plan: selectedPlan,
        creator: appliedCreator,
        trialDays: selectedPlan === "annual" ? trialDays : 0,
        commissionOwed: commission,
      });
    } finally {
      setCheckoutBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="HeyBroc Family Pro" onClick={onClose}>
      <div className="modal-card paywall-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <span className="eyebrow eyebrow--green">
              {scanCount >= freeScanLimit ? `Free Scan Limit Reached (${scanCount}/${freeScanLimit})` : "HeyBroc Family Pro · Upgrade"}
            </span>
            <h2>Unlimited Live Store Overlays, 1-Tap Clean Swaps &amp; Whole-Cart Health Checks.</h2>
          </div>
          <button className="close" onClick={onClose} aria-label="Close paywall">×</button>
        </div>

        <ul className="paywall-perks">
          <li><span>✓</span> Instant floating ingredient grade over Walmart, Instacart, Target, Kroger, ALDI, Sam&apos;s Club, BJ&apos;s &amp; more</li>
          <li><span>✓</span> 1-Tap verified 90–100 Clean Swaps &amp; Whole-Cart Health Check</li>
          <li><span>✓</span> Custom additive watchlists (seed oils, synthetic dyes, HFCS, nitrates)</li>
        </ul>

        {/* PRIMARY PRE-SELECTED ANNUAL ANCHOR CARD */}
        <div
          id="plan-annual"
          role="button"
          tabIndex={0}
          aria-pressed={selectedPlan === "annual"}
          className={`plan-card plan-card--annual ${selectedPlan === "annual" ? "is-selected" : ""}`}
          onClick={() => setSelectedPlan("annual")}
          onKeyDown={(e) => e.key === "Enter" && setSelectedPlan("annual")}
        >
          <div className="plan-badge">BEST VALUE — SAVE {annualSavingsPct}%</div>
          <div className="plan-main">
            <div className="plan-radio" aria-hidden>
              <span />
            </div>
            <div className="plan-copy">
              <div className="plan-title-row">
                <strong>Annual HeyBroc Family Pro</strong>
                <span className="plan-trial-pill">
                  {trialDays}-Day Free Trial
                </span>
              </div>
              <div className="plan-price-hero">
                <span className="plan-per-month">${annualPerMonth.toFixed(2)} / month</span>
                <span className="plan-billed">
                  <strong>${PRICING.annual.toFixed(2)} / year</strong> billed annually
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* SECONDARY MONTHLY DECOY CARD */}
        <div
          id="plan-monthly"
          role="button"
          tabIndex={0}
          aria-pressed={selectedPlan === "monthly"}
          className={`plan-card plan-card--decoy ${selectedPlan === "monthly" ? "is-selected" : ""}`}
          onClick={() => setSelectedPlan("monthly")}
          onKeyDown={(e) => e.key === "Enter" && setSelectedPlan("monthly")}
        >
          <div className="plan-main">
            <div className="plan-radio" aria-hidden>
              <span />
            </div>
            <div className="plan-copy">
              <div className="plan-title-row">
                <strong>Monthly Plan</strong>
                <span className="plan-no-trial">No free trial</span>
              </div>
              <div className="plan-price-sub">
                <strong>${PRICING.monthly.toFixed(2)} / month</strong> billed monthly (${monthlyPerYear.toFixed(2)}/yr equivalent)
              </div>
            </div>
          </div>
        </div>

        {/* CREATOR / INFLUENCER PROMO CODE BOX */}
        <div className="creator-box">
          <label htmlFor="creator-code-input" className="creator-label">
            Creator / Promo Code
          </label>
          <div className="creator-input-row">
            <input
              id="creator-code-input"
              type="text"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
              placeholder="Enter promo code"
            />
            <button
              id="apply-creator-code"
              type="button"
              className="creator-apply-btn"
              disabled={codeBusy}
              onClick={() => applyCode()}
            >
              {codeBusy ? "…" : "Apply"}
            </button>
          </div>
          {codeError && <p className="error">{codeError}</p>}
          {appliedCreator && (
            <div id="creator-applied-badge" className="creator-confirm">
              <span>✓ Code <b>{appliedCreator.code}</b> Applied: Extended 7-Day Free Trial Unlocked!</span>
            </div>
          )}
        </div>

        {/* PRIMARY CTA */}
        <button
          id="paywall-cta"
          type="button"
          className="paywall-cta-btn"
          disabled={checkoutBusy}
          onClick={handleCheckout}
        >
          {checkoutBusy
            ? "Activating HeyBroc Family Pro…"
            : selectedPlan === "annual"
              ? appliedCreator
                ? "Start 7-Day Free Trial ($0 Today)"
                : "Start 3-Day Free Trial ($0 Today)"
              : `Subscribe Monthly ($${PRICING.monthly.toFixed(2)} Today)`}
        </button>
        <p className="paywall-sub">
          {selectedPlan === "annual"
            ? `$0 due today, then $${PRICING.annual.toFixed(2)}/year ($${annualPerMonth.toFixed(2)}/mo). Cancel anytime in 1 tap.`
            : `Billed monthly at $${PRICING.monthly.toFixed(2)}/mo ($${monthlyPerYear.toFixed(2)}/yr). Switch to Annual to save ${annualSavingsPct}%.`}
        </p>

        {receipt && (
          <div className="paywall-receipt" role="status">
            <div>
              <strong>
                ✓ HeyBroc Family Pro Activated ({receipt.plan === "annual" ? "$49.99/yr Annual" : "$9.99/mo Monthly"})
              </strong>
              <p>
                Unlimited live store overlays, 1-tap clean swaps &amp; whole-cart health checks are now active on your account.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
