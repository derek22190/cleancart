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
  }) => void;
  personalReferralCode?: string;
  courtesyRefillAvailable?: boolean;
  onUseCourtesyRefill?: () => void;
  onOpenLogin?: () => void;
}

export default function Paywall({
  open,
  onClose,
  scanCount,
  freeScanLimit,
  appliedCreator,
  onCreatorApplied,
  onConversionComplete,
  personalReferralCode = "BROC-7F4A2",
  courtesyRefillAvailable = true,
  onUseCourtesyRefill,
  onOpenLogin,
}: PaywallProps) {
  const [selectedPlan, setSelectedPlan] = useState<PlanId>("annual");
  const [codeInput, setCodeInput] = useState(appliedCreator?.code ?? "");
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState("");
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [receipt, setReceipt] = useState<{
    plan: PlanId;
    trialDays: number;
    creator: AppliedCreator | null;
  } | null>(null);
  const [remoteHeadline, setRemoteHeadline] = useState<string>(
    "Scores & Ingredient Breakdowns Are Always Free. Unlock Unlimited 1-Tap Clean Swaps & Swap All.",
  );

  useEffect(() => {
    if (appliedCreator?.code) setCodeInput(appliedCreator.code);
  }, [appliedCreator]);

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const devId = window.localStorage.getItem("heybroc_device_id") || "anon-web";
    fetch(`/api/analytics?mode=paywall&deviceId=${encodeURIComponent(devId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok && typeof d.activeHeadline === "string" && d.activeHeadline.trim()) {
          setRemoteHeadline(d.activeHeadline.trim());
        }
        if (d?.paywall?.defaultPlan === "monthly" || d?.paywall?.defaultPlan === "annual") {
          setSelectedPlan(d.paywall.defaultPlan);
        }
        void fetch("/api/analytics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "track",
            event: "paywall_viewed",
            deviceId: devId,
            platform: "web",
            variant: d?.assignedVariant === "B" ? "B" : "A",
          }),
        }).catch(() => {});
      })
      .catch(() => {});
  }, [open]);

  if (!open) return null;

  const trialDays = appliedCreator ? PRICING.creatorTrialDays : PRICING.trialDays;
  const referralUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/r/${encodeURIComponent(personalReferralCode)}`
      : `https://heybroc.com/r/${encodeURIComponent(personalReferralCode)}`;

  const handleShareWithFriend = async () => {
    const shareText = `Check out HeyBroc — this little broccoli floats over Walmart, Target, Costco, Sam's, BJ's, Amazon Fresh, Instacart & more to grade ingredients (0–100) and swap flagged items in 1 tap. Use my invite link so we both get +7 Free Days of HeyBroc Pro: ${referralUrl}`;
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({
          title: "7 Free Days of HeyBroc Pro",
          text: shareText,
          url: referralUrl,
        });
        setShareCopied(true);
        return;
      }
      await navigator.clipboard.writeText(shareText);
      setShareCopied(true);
    } catch {
      setShareCopied(true);
    }
  };

  const applyCode = async (raw?: string) => {
    const target = (raw ?? codeInput).trim().toUpperCase();
    if (!target) {
      setCodeError("Enter a creator or friend code first (e.g. CLEANMOM).");
      return;
    }
    setCodeBusy(true);
    setCodeError("");
    try {
      if (target.startsWith("BROC-")) {
        if (!/^BROC-[A-Z0-9]{4,10}$/.test(target)) {
          setCodeError("Invalid friend invite code format (expected BROC-XXXXXXXX).");
          return;
        }
        const devId =
          (typeof window !== "undefined" && window.localStorage.getItem("heybroc_device_id")) ||
          "anon-web";
        const refRes = await fetch("/api/referral", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "claim", deviceId: devId, referralCode: target }),
        }).catch(() => null);
        const refData = refRes ? await refRes.json().catch(() => null) : null;
        if (refData && refData.ok === false) {
          setCodeError(refData.error || "Could not apply friend code.");
          return;
        }
        if (typeof window !== "undefined") {
          window.localStorage.setItem("heybroc_referred_by", target);
        }
        const c: AppliedCreator = {
          code: target,
          name: "Friend Referral (+7 Days Free Pro)",
        };
        setCodeInput(c.code);
        onCreatorApplied(c);
        return;
      }
      const res = await fetch(`/api/influencers?code=${encodeURIComponent(target)}`);
      const data = await res.json();
      if (!res.ok || !data.ok || !data.creator) {
        onCreatorApplied(null);
        setCodeError(data.error || "Invalid promo code.");
        return;
      }
      void fetch("/api/influencers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "track", code: data.creator.code, event: "click" }),
      }).catch(() => {});

      const c: AppliedCreator = {
        code: data.creator.code,
        name: data.creator.name,
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
    if (receipt) {
      onClose();
      return;
    }
    setCheckoutBusy(true);
    setCodeError("");
    try {
      const sp =
        typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
      const devId =
        sp?.get("deviceId") ||
        (typeof window !== "undefined" && window.localStorage.getItem("heybroc_device_id")) ||
        "";
      let userEmail = sp?.get("email") || "";
      if (!userEmail && typeof window !== "undefined") {
        try {
          const cachedUser = JSON.parse(
            window.localStorage.getItem("heybroc_auth_user") ||
              window.localStorage.getItem("heybroc_user") ||
              "null"
          ) as { email?: string } | null;
          if (cachedUser?.email) userEmail = cachedUser.email;
        } catch {
          /* ignore */
        }
      }
      const checkoutRes = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: selectedPlan,
          creatorCode: appliedCreator?.code,
          deviceId: devId || undefined,
          email: userEmail || undefined,
          origin: typeof window !== "undefined" ? window.location.origin : "https://heybroc.com",
        }),
      });
      const checkoutData = await checkoutRes.json().catch(() => ({}));
      if (checkoutData?.ok && checkoutData?.mode === "stripe" && checkoutData?.url) {
        window.location.href = checkoutData.url;
        return;
      }

      if (!checkoutRes.ok || !checkoutData?.ok) {
        setCodeError(checkoutData?.error || "Checkout is currently unavailable. Please try again.");
        return;
      }

      if (checkoutData?.mode === "preview") {
        setCodeError("Live Stripe checkout is not configured in this environment. Set STRIPE_SECRET_KEY to enable subscriptions.");
        return;
      }
    } catch {
      setCodeError("Network error starting checkout. Please try again.");
    } finally {
      setCheckoutBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="HeyBroc Family Pro" onClick={onClose}>
      <div className="modal-card paywall-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="yuka-topbar-left">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/broc-mascot.jpg" alt="Broc" className="yuka-topbar-mascot" />
            <div>
              <span className="eyebrow eyebrow--green">
                {scanCount >= freeScanLimit
                  ? `Weekly Free Swap Allowance Reached (${scanCount}/${freeScanLimit})`
                  : "HeyBroc Family Pro · Unlimited Cart Swaps"}
              </span>
              <h2>{remoteHeadline}</h2>
            </div>
          </div>
          <button className="close" onClick={onClose} aria-label="Close paywall">×</button>
        </div>

        <ul className="paywall-perks">
          <li><span>✓</span> <b>Always Free:</b> Product scores (0–100), expanded additive explanations &amp; live Cart Avg across all 12 stores</li>
          <li><span>✓</span> <b>Pro Unlocked:</b> Unlimited 1-for-1 Clean Swaps &amp; 1-Tap Whole-Cart &ldquo;Swap All&rdquo; Makeovers</li>
          <li><span>✓</span> <b>Pro Unlocked:</b> Custom Family Watchlists (2x penalties for seed oils, dyes, HFCS &amp; nitrites)</li>
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

        {/* UNLIMITED GIVE 7 DAYS, GET 7 DAYS FRIEND REFERRAL LOOP */}
        <div
          className="creator-box"
          style={{
            background: "linear-gradient(135deg, #ecfdf5 0%, #f0fdf4 100%)",
            border: "1.5px solid #86efac",
            marginBottom: 12,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div>
              <strong style={{ display: "block", fontSize: 13.5, color: "#0b4f30" }}>
                🎁 Invite Friends → Get +7 Free Pro Days Per Friend (Up to 70 Days!)
              </strong>
              <span style={{ fontSize: 12, color: "#3d5949" }}>
                Every friend who installs HeyBroc and starts a trial unlocks <b>+7 Free Days of Pro</b> for both of you (up to 10 friends).
              </span>
            </div>
            <button
              type="button"
              onClick={handleShareWithFriend}
              style={{
                background: "#0f7a4a",
                color: "#fff",
                border: "none",
                borderRadius: 999,
                padding: "9px 14px",
                fontSize: 12.5,
                fontWeight: 800,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {shareCopied ? "✓ Invite Link Copied!" : `Text a Friend (${personalReferralCode}) →`}
            </button>
          </div>
          {courtesyRefillAvailable && onUseCourtesyRefill && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed #bbf7d0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "#3d5949" }}>In the middle of checkout right now?</span>
              <button
                type="button"
                onClick={onUseCourtesyRefill}
                style={{
                  background: "transparent",
                  color: "#0f7a4a",
                  border: "none",
                  fontSize: 12,
                  fontWeight: 800,
                  textDecoration: "underline",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                +3 Free Courtesy Swaps right now →
              </button>
            </div>
          )}
        </div>

        {/* CREATOR / INFLUENCER PROMO CODE BOX */}
        <div className="creator-box">
          <label htmlFor="creator-code-input" className="creator-label">
            Have a Creator or Friend Code? (Unlocks 14-Day Free Trial)
          </label>
          <div className="creator-input-row">
            <input
              id="creator-code-input"
              type="text"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
              placeholder="Enter promo or friend code (e.g. CLEANMOM)"
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
              <span>✓ Code <b>{appliedCreator.code}</b> Applied: Extended {PRICING.creatorTrialDays}-Day Free Trial Unlocked!</span>
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
            : receipt
              ? "✓ Family Pro Active! Start Scanning →"
              : selectedPlan === "annual"
                ? `Start ${trialDays}-Day Free Trial ($0 Today)`
                : `Subscribe Monthly ($${PRICING.monthly.toFixed(2)} Today)`}
        </button>
        <p className="paywall-sub">
          {selectedPlan === "annual"
            ? `$0 due today, then $${PRICING.annual.toFixed(2)}/year ($${annualPerMonth.toFixed(2)}/mo). Cancel anytime in 1 tap.`
            : `Billed monthly at $${PRICING.monthly.toFixed(2)}/mo ($${monthlyPerYear.toFixed(2)}/yr). Switch to Annual to save ${annualSavingsPct}%.`}
        </p>

        {onOpenLogin && (
          <div style={{ textAlign: "center", marginTop: 6 }}>
            <button
              type="button"
              onClick={onOpenLogin}
              style={{
                background: "transparent",
                border: "none",
                color: "#0f7a4a",
                fontSize: 12.5,
                fontWeight: 700,
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              Already have an account or want to sync Pro across devices? Log in →
            </button>
          </div>
        )}

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
