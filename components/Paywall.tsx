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
import { TERMS_VERSION } from "@/lib/terms";

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
  const [portalBusy, setPortalBusy] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
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
    if (!open) {
      setAgreedToTerms(false);
      setCodeError("");
      return;
    }
    if (typeof window === "undefined") return;
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
        const devSecret =
          (typeof window !== "undefined" && window.localStorage.getItem("heybroc_device_secret")) ||
          "";
        const refRes = await fetch("/api/referral", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(devSecret ? { "X-Device-Secret": devSecret } : {}),
          },
          body: JSON.stringify({
            action: "claim",
            deviceId: devId,
            deviceSecret: devSecret || undefined,
            referralCode: target,
          }),
        }).catch(() => null);
        const refData = refRes ? await refRes.json().catch(() => null) : null;
        if (!refRes || !refRes.ok || !refData || refData.ok === false) {
          setCodeError(
            refData?.error || refData?.message || "Invalid or unrecognized friend referral code."
          );
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
      if (typeof window !== "undefined") {
        window.localStorage.setItem("cleancart_creator_v1", JSON.stringify(c));
      }
      setCodeInput(c.code);
      onCreatorApplied(c);
    } catch {
      setCodeError("Network error validating code.");
    } finally {
      setCodeBusy(false);
    }
  };

  const handleOpenBillingPortal = async () => {
    setPortalBusy(true);
    setCodeError("");
    try {
      const sp =
        typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
      const devId =
        sp?.get("deviceId") ||
        (typeof window !== "undefined" && window.localStorage.getItem("heybroc_device_id")) ||
        "";
      const devSecret =
        (typeof window !== "undefined" && window.localStorage.getItem("heybroc_device_secret")) ||
        "";
      const sessionId =
        sp?.get("session_id") ||
        (typeof window !== "undefined" && window.localStorage.getItem("heybroc_session_id")) ||
        "";
      const authToken =
        (typeof window !== "undefined" && window.localStorage.getItem("heybroc_auth_token")) ||
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
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          ...(devSecret ? { "X-Device-Secret": devSecret } : {}),
        },
        body: JSON.stringify({
          deviceId: devId || undefined,
          deviceSecret: devSecret || undefined,
          sessionId: sessionId || undefined,
          email: userEmail || undefined,
          returnUrl: typeof window !== "undefined" ? window.location.origin : "https://heybroc.com",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok && data?.url) {
        window.location.href = data.url;
        return;
      }
      setCodeError(
        data?.error ||
          "No active subscription found for this device. Log in with your checkout email or visit /terms for cancellation options."
      );
    } catch {
      setCodeError("Network error opening Billing Portal. Please try again.");
    } finally {
      setPortalBusy(false);
    }
  };

  const handleCheckout = async () => {
    if (receipt) {
      onClose();
      return;
    }
    if (!agreedToTerms) {
      setCodeError(
        "Please check the box below to agree to the Terms and automatic renewal terms before continuing."
      );
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
      const devSecret =
        (typeof window !== "undefined" && window.localStorage.getItem("heybroc_device_secret")) ||
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
      const storedFriendRef =
        typeof window !== "undefined"
          ? (window.localStorage.getItem("heybroc_referred_by") || "").trim().toUpperCase()
          : "";
      const effectiveCreatorCode =
        appliedCreator?.code ||
        (/^BROC-[A-Z0-9]{4,10}$/.test(storedFriendRef) ? storedFriendRef : undefined);
      const isAdTest =
        typeof window !== "undefined" &&
        (window.location.pathname === "/test" || sp?.get("ad") === "test");
      const checkoutRes = await fetch("/api/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(devSecret ? { "X-Device-Secret": devSecret } : {}),
        },
        body: JSON.stringify({
          plan: selectedPlan,
          adTestMode: isAdTest || undefined,
          creatorCode: effectiveCreatorCode,
          deviceId: devId || undefined,
          deviceSecret: devSecret || undefined,
          email: userEmail || undefined,
          consentAccepted: true,
          termsAccepted: true,
          termsVersion: TERMS_VERSION,
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

        {/* 3-STEP CRYSTAL-CLEAR VALUE PROP STRIP (RYAN MATHEWS TEST #3) */}
        <div
          id="paywall-how-it-works-strip"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(135px, 1fr))",
            gap: 8,
            marginBottom: 12,
            padding: "10px 12px",
            borderRadius: 12,
            background: "#f8faf9",
            border: "1px solid #d4dbd6",
          }}
        >
          <div style={{ fontSize: 12, lineHeight: 1.35 }}>
            <strong style={{ display: "block", color: "#0b4f30", fontSize: 12.5 }}>
              1. Shop Normally
            </strong>
            <span style={{ color: "#3d5949" }}>
              Open Walmart, Target, Costco, Instacart &amp; 8 more apps
            </span>
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.35 }}>
            <strong style={{ display: "block", color: "#0b4f30", fontSize: 12.5 }}>
              2. Instant 0–100 Score
            </strong>
            <span style={{ color: "#3d5949" }}>
              Floating badge flags seed oils, Red 40, HFCS &amp; nitrites
            </span>
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.35 }}>
            <strong style={{ display: "block", color: "#0b4f30", fontSize: 12.5 }}>
              3. 1-Tap Clean Swap
            </strong>
            <span style={{ color: "#3d5949" }}>
              Replace flagged items or your whole cart in 1 tap
            </span>
          </div>
        </div>

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
          {courtesyRefillAvailable && PRICING.courtesyRefillSwaps > 0 && onUseCourtesyRefill && (
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
                +{PRICING.courtesyRefillSwaps} Free Courtesy Swaps right now →
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
              <span>
                ✓ Code <b>{appliedCreator.code}</b> Applied:{" "}
                {appliedCreator.code.startsWith("BROC-")
                  ? `Extended ${PRICING.creatorTrialDays}-Day Free Trial + 7 Free Pro Days for you & your friend!`
                  : `Extended ${PRICING.creatorTrialDays}-Day Free Trial Unlocked!`}
              </span>
            </div>
          )}
        </div>

        {/* EXPRESS AUTO-RENEWAL CONSENT CHECKBOX (CA ARL / FTC NEGATIVE OPTION) */}
        <label
          htmlFor="paywall-arl-consent"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            margin: "12px 0 10px",
            padding: "10px 12px",
            borderRadius: 10,
            background: agreedToTerms ? "#ecfdf5" : "#f8faf9",
            border: agreedToTerms ? "1.5px solid #0f7a4a" : "1.5px solid #cbd5e1",
            fontSize: 12.5,
            lineHeight: 1.45,
            color: "#15201B",
            cursor: "pointer",
          }}
        >
          <input
            id="paywall-arl-consent"
            type="checkbox"
            checked={agreedToTerms}
            onChange={(e) => {
              setAgreedToTerms(e.target.checked);
              if (e.target.checked) setCodeError("");
            }}
            style={{ marginTop: 3, width: 16, height: 16, accentColor: "#0f7a4a", flexShrink: 0 }}
          />
          <span>
            I agree to the{" "}
            <a
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#0f7a4a", fontWeight: 700, textDecoration: "underline" }}
            >
              Terms
            </a>{" "}
            and that HeyBroc Pro renews automatically at{" "}
            {selectedPlan === "annual"
              ? `$${PRICING.annual.toFixed(2)}/yr after the ${trialDays}-day trial`
              : `$${PRICING.monthly.toFixed(2)}/mo`}{" "}
            until I cancel.
          </span>
        </label>

        {/* PRIMARY CTA */}
        <button
          id="paywall-cta"
          type="button"
          className="paywall-cta-btn"
          disabled={checkoutBusy || (!agreedToTerms && !receipt)}
          style={
            !agreedToTerms && !receipt
              ? { opacity: 0.6, cursor: "not-allowed" }
              : undefined
          }
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
            ? `$0 due today, then $${PRICING.annual.toFixed(2)}/year ($${annualPerMonth.toFixed(2)}/mo) after your ${trialDays}-day trial. Cancel anytime via Billing Settings.`
            : `Billed monthly at $${PRICING.monthly.toFixed(2)}/mo ($${monthlyPerYear.toFixed(2)}/yr). Switch to Annual to save ${annualSavingsPct}%. Cancel anytime via Billing Settings.`}
        </p>

        {/* SKEPTIC FAQ ACCORDION (RYAN MATHEWS TEST #3: ANSWER EVERY BUYER OBJECTION) */}
        <details
          id="paywall-skeptic-faq"
          style={{
            marginTop: 10,
            background: "#f8faf9",
            border: "1px solid #d4dbd6",
            borderRadius: 12,
            padding: "10px 14px",
            fontSize: 12.5,
          }}
        >
          <summary
            style={{
              fontWeight: 800,
              color: "#15201B",
              cursor: "pointer",
            }}
          >
            Questions before starting your free trial? (4 quick answers)
          </summary>
          <div style={{ display: "grid", gap: 9, marginTop: 10, color: "#334155", lineHeight: 1.45 }}>
            <div>
              <strong style={{ color: "#0f172a" }}>1. How is HeyBroc different from barcode apps like Yuka?</strong>
              <div>
                Barcode scanners only work standing in a physical aisle scanning one box at a time. HeyBroc floats directly inside your online grocery apps (Walmart, Target, Costco, Instacart, Kroger, ALDI &amp; 6 more) and swaps flagged items in 1 tap.
              </div>
            </div>
            <div>
              <strong style={{ color: "#0f172a" }}>2. Do food brands pay to boost their scores or swaps?</strong>
              <div>
                Never. HeyBroc is 100% independent and reader-supported. Every 0–100 score and Clean Swap is computed deterministically from the ingredient list and nutrition facts.
              </div>
            </div>
            <div>
              <strong style={{ color: "#0f172a" }}>3. Does one membership cover my phone, computer &amp; family?</strong>
              <div>
                Yes. One Family Pro membership unlocks Web, Android Live Store Bubble, iOS Safari Extension, and Chrome Extension across your phone, computer, and household devices when signed in to your HeyBroc account.
              </div>
            </div>
            <div>
              <strong style={{ color: "#0f172a" }}>4. How easy is it to cancel before my trial ends?</strong>
              <div>
                1-click self-serve cancellation anytime via &ldquo;Manage / Cancel subscription&rdquo; below—no phone calls or emails required.
              </div>
            </div>
          </div>
        </details>

        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
            marginTop: 8,
            fontSize: 12,
          }}
        >
          {onOpenLogin && (
            <button
              type="button"
              onClick={onOpenLogin}
              style={{
                background: "transparent",
                border: "none",
                color: "#0f7a4a",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                textDecoration: "underline",
                padding: 0,
              }}
            >
              Already have an account? Log in →
            </button>
          )}
          <button
            id="paywall-manage-subscription"
            type="button"
            disabled={portalBusy}
            onClick={handleOpenBillingPortal}
            style={{
              background: "transparent",
              border: "none",
              color: "#3d5949",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              textDecoration: "underline",
              padding: 0,
            }}
          >
            {portalBusy ? "Opening Billing Portal…" : "Manage / Cancel subscription"}
          </button>
          <a
            href="/terms"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#3d5949", textDecoration: "underline" }}
          >
            Terms of Service
          </a>
          <a
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#3d5949", textDecoration: "underline" }}
          >
            Privacy Policy
          </a>
        </div>

        {receipt && (
          <div className="paywall-receipt" role="status">
            <div>
              <strong>
                ✓ HeyBroc Family Pro Activated ({receipt.plan === "annual" ? `$${PRICING.annual.toFixed(2)}/yr Annual` : `$${PRICING.monthly.toFixed(2)}/mo Monthly`})
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
