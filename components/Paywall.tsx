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
    "Scores & Ingredient Breakdowns Are Always Free. Unlock Unlimited Cleaner Picks & Order Audits.",
  );
  const [remoteSubheadline, setRemoteSubheadline] = useState<string>("");
  const [remoteCtaLabel, setRemoteCtaLabel] = useState<string>("");

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
        if (typeof d?.paywall?.subheadline === "string" && d.paywall.subheadline.trim()) {
          setRemoteSubheadline(d.paywall.subheadline.trim());
        }
        if (typeof d?.paywall?.ctaLabel === "string" && d.paywall.ctaLabel.trim()) {
          setRemoteCtaLabel(d.paywall.ctaLabel.trim());
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

  const trialDays = PRICING.trialDays;
  const referralUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/r/${encodeURIComponent(personalReferralCode)}`
      : `https://heybroc.com/r/${encodeURIComponent(personalReferralCode)}`;

  const handleShareWithFriend = async () => {
    const shareText = `Check out HeyBroc — this little broccoli floats over Walmart, Target, Costco, Sam's, BJ's, Amazon Fresh, Instacart & more to grade ingredients (0–100) and link directly to verified cleaner picks. Use my invite link so we both get +7 Free Days of HeyBroc Pro: ${referralUrl}`;
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
        const authToken =
          typeof window !== "undefined"
            ? (window.localStorage.getItem("heybroc_auth_token") || "").trim()
            : "";
        const refRes = await fetch("/api/referral", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
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
      const clickKey = `hb_creator_click_${data.creator.code}`;
      const alreadyTracked =
        typeof window !== "undefined" && window.sessionStorage.getItem(clickKey) === "1";
      if (!alreadyTracked) {
        if (typeof window !== "undefined") {
          try {
            window.sessionStorage.setItem(clickKey, "1");
          } catch {
            /* ignore */
          }
        }
        void fetch("/api/influencers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "track", code: data.creator.code, event: "click" }),
        }).catch(() => {});
      }

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
        typeof window !== "undefined"
          ? (window.localStorage.getItem("heybroc_auth_token") || "").trim()
          : "";
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
        "Please check the box above to agree to the Terms and automatic renewal terms before continuing."
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
      const authToken =
        typeof window !== "undefined"
          ? (window.localStorage.getItem("heybroc_auth_token") || "").trim()
          : "";
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
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
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
      if (
        typeof window !== "undefined" &&
        typeof checkoutData?.deviceId === "string" &&
        checkoutData.deviceId &&
        (!devId || devId === "anon-web")
      ) {
        try {
          window.localStorage.setItem("heybroc_device_id", checkoutData.deviceId);
        } catch {
          /* ignore storage quota */
        }
      }
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
      <div
        className="modal-card paywall-modal"
        style={{ padding: "18px 20px", maxWidth: 520 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head" style={{ gap: 10 }}>
          <div className="yuka-topbar-left" style={{ alignItems: "flex-start" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/broc-mascot.png"
              alt="Broc"
              className="yuka-topbar-mascot"
              style={{ width: 38, height: 38, flexShrink: 0 }}
            />
            <div>
              <span className="eyebrow eyebrow--green" style={{ fontSize: 11 }}>
                {scanCount >= freeScanLimit
                  ? `Free Allowance Reached (${scanCount}/${freeScanLimit})`
                  : "HeyBroc Family Pro"}
              </span>
              <h2 style={{ fontSize: 18, lineHeight: 1.22, marginTop: 2 }}>{remoteHeadline}</h2>
              {remoteSubheadline && (
                <p style={{ margin: "3px 0 0", fontSize: 12.5, color: "#3d5949" }}>
                  {remoteSubheadline}
                </p>
              )}
            </div>
          </div>
          <button className="close" onClick={onClose} aria-label="Close paywall">×</button>
        </div>

        <ul className="paywall-perks" style={{ margin: "10px 0 12px", gap: 5 }}>
          <li style={{ fontSize: 12.5 }}>
            <span>✓</span> <b>Always Free:</b> 0–100 product scores &amp; ingredient breakdowns across all 12 stores
          </li>
          <li style={{ fontSize: 12.5 }}>
            <span>✓</span> <b>Pro Unlocked:</b> Unlimited verified cleaner store links, Order/Receipt Audits &amp; custom 2x Family Watchlists
          </li>
        </ul>

        {/* PRIMARY PRE-SELECTED ANNUAL ANCHOR CARD */}
        <div
          id="plan-annual"
          role="button"
          tabIndex={0}
          aria-pressed={selectedPlan === "annual"}
          className={`plan-card plan-card--annual ${selectedPlan === "annual" ? "is-selected" : ""}`}
          style={{ padding: "12px 14px", marginBottom: 8 }}
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
                <strong style={{ fontSize: 14.5 }}>Annual Family Pro</strong>
                <span className="plan-trial-pill">
                  {trialDays}-Day Free Trial
                </span>
              </div>
              <div className="plan-price-hero" style={{ marginTop: 3 }}>
                <span className="plan-per-month" style={{ fontSize: 21 }}>
                  ${annualPerMonth.toFixed(2)} / mo
                </span>
                <span className="plan-billed" style={{ fontSize: 12.5 }}>
                  <strong>${PRICING.annual.toFixed(2)} / yr</strong> after trial
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* SECONDARY MONTHLY CARD */}
        <div
          id="plan-monthly"
          role="button"
          tabIndex={0}
          aria-pressed={selectedPlan === "monthly"}
          className={`plan-card plan-card--decoy ${selectedPlan === "monthly" ? "is-selected" : ""}`}
          style={{ padding: "10px 14px", marginBottom: 10 }}
          onClick={() => setSelectedPlan("monthly")}
          onKeyDown={(e) => e.key === "Enter" && setSelectedPlan("monthly")}
        >
          <div className="plan-main">
            <div className="plan-radio" aria-hidden>
              <span />
            </div>
            <div className="plan-copy">
              <div className="plan-title-row">
                <strong style={{ fontSize: 14 }}>Monthly Plan</strong>
                <span className="plan-no-trial">No free trial</span>
              </div>
              <div className="plan-price-sub" style={{ marginTop: 2, fontSize: 12.5 }}>
                <strong>${PRICING.monthly.toFixed(2)} / month</strong> billed monthly (${monthlyPerYear.toFixed(2)}/yr equivalent)
              </div>
            </div>
          </div>
        </div>

        {/* EXPRESS AUTO-RENEWAL CONSENT CHECKBOX (CA ARL / FTC NEGATIVE OPTION) — ABOVE THE FOLD */}
        <label
          htmlFor="paywall-arl-consent"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 9,
            margin: "0 0 8px",
            padding: "8px 11px",
            borderRadius: 10,
            background: agreedToTerms ? "#ecfdf5" : "#f8faf9",
            border: agreedToTerms ? "1.5px solid #0f7a4a" : "1.5px solid #cbd5e1",
            fontSize: 12,
            lineHeight: 1.4,
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
            style={{ marginTop: 2, width: 16, height: 16, accentColor: "#0f7a4a", flexShrink: 0 }}
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

        {appliedCreator && (
          <div id="creator-applied-badge" className="creator-confirm" style={{ marginTop: 0, marginBottom: 8, padding: "7px 10px" }}>
            <span style={{ fontSize: 12 }}>
              ✓ Code <b>{appliedCreator.code}</b> Applied:{" "}
              {selectedPlan === "monthly"
                ? "Switch to Annual above to unlock your 7-Day Free Trial ($0 Today)."
                : appliedCreator.code.startsWith("BROC-")
                  ? "7-Day Free Trial + 7 Free Pro Days unlocked!"
                  : "VIP Creator Access · 7-Day Free Pro Trial ($0 Today) Ready!"}
            </span>
          </div>
        )}

        {codeError && (
          <div
            role="alert"
            style={{
              marginBottom: 8,
              padding: "8px 11px",
              borderRadius: 10,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#b91c1c",
              fontSize: 12,
              fontWeight: 700,
              lineHeight: 1.4,
            }}
          >
            {codeError}
          </div>
        )}

        {/* PRIMARY CTA — IMMEDIATELY VISIBLE WITHOUT SCROLLING */}
        <button
          id="paywall-cta"
          type="button"
          className="paywall-cta-btn"
          disabled={checkoutBusy || (!agreedToTerms && !receipt)}
          style={{
            marginTop: 0,
            padding: "13px 16px",
            ...(!agreedToTerms && !receipt ? { opacity: 0.65, cursor: "not-allowed" } : {}),
          }}
          onClick={handleCheckout}
        >
          {checkoutBusy
            ? "Activating HeyBroc Family Pro…"
            : receipt
              ? "✓ Family Pro Active! Start Scanning →"
              : selectedPlan === "annual"
                ? appliedCreator
                  ? `Start ${trialDays}-Day Free Trial ($0 Today)`
                  : remoteCtaLabel || `Start ${trialDays}-Day Free Trial ($0 Today)`
                : `Subscribe Monthly ($${PRICING.monthly.toFixed(2)} Today)`}
        </button>
        <p className="paywall-sub" style={{ marginTop: 6, fontSize: 11.5 }}>
          {selectedPlan === "annual"
            ? `$0 due today, then $${PRICING.annual.toFixed(2)}/year ($${annualPerMonth.toFixed(2)}/mo) after your ${trialDays}-day trial. Cancel anytime.`
            : `Billed monthly at $${PRICING.monthly.toFixed(2)}/mo. Switch to Annual to save ${annualSavingsPct}%. Cancel anytime.`}
        </p>

        {courtesyRefillAvailable && PRICING.courtesyRefillSwaps > 0 && onUseCourtesyRefill && (
          <div style={{ marginTop: 6, textAlign: "center" }}>
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
              In the middle of shopping? Use +{PRICING.courtesyRefillSwaps} Free Courtesy Picks right now →
            </button>
          </div>
        )}

        {/* COMPACT OPTIONAL PROMO / FRIEND INVITE DRAWER */}
        <details
          style={{
            marginTop: 10,
            background: "#f8faf9",
            border: "1px solid #d4dbd6",
            borderRadius: 12,
            padding: "8px 12px",
            fontSize: 12.5,
          }}
        >
          <summary style={{ fontWeight: 700, color: "#15201B", cursor: "pointer" }}>
            Have a promo code or want +7 Free Pro Days for inviting a friend?
          </summary>
          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            <div>
              <label htmlFor="creator-code-input" className="creator-label">
                Creator or Friend Invite Code
              </label>
              <div className="creator-input-row">
                <input
                  id="creator-code-input"
                  type="text"
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
                  placeholder="Enter code (e.g. CLEANMOM)"
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
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                paddingTop: 8,
                borderTop: "1px solid #e2e8f0",
              }}
            >
              <span style={{ fontSize: 12, color: "#3d5949" }}>
                🎁 Share your invite code for <b>+7 Free Pro Days</b> each:
              </span>
              <button
                type="button"
                onClick={handleShareWithFriend}
                style={{
                  background: "#0f7a4a",
                  color: "#fff",
                  border: "none",
                  borderRadius: 999,
                  padding: "6px 12px",
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                {shareCopied ? "✓ Invite Link Copied!" : `Invite Friend (${personalReferralCode}) →`}
              </button>
            </div>
          </div>
        </details>

        {/* COMPACT HOW IT WORKS + FAQ ACCORDION */}
        <details
          id="paywall-skeptic-faq"
          style={{
            marginTop: 8,
            background: "#f8faf9",
            border: "1px solid #d4dbd6",
            borderRadius: 12,
            padding: "8px 12px",
            fontSize: 12.5,
          }}
        >
          <summary
            style={{
              fontWeight: 700,
              color: "#15201B",
              cursor: "pointer",
            }}
          >
            How HeyBroc works &amp; common questions
          </summary>
          <div style={{ display: "grid", gap: 9, marginTop: 10, color: "#334155", lineHeight: 1.45 }}>
            <div
              id="paywall-how-it-works-strip"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                gap: 8,
                padding: "8px 10px",
                borderRadius: 10,
                background: "#ffffff",
                border: "1px solid #e2e8f0",
              }}
            >
              <div style={{ fontSize: 11.5 }}>
                <strong style={{ display: "block", color: "#0b4f30" }}>1. Shop Normally</strong>
                <span>Browse Walmart, Target, Costco, Instacart &amp; 8 more stores</span>
              </div>
              <div style={{ fontSize: 11.5 }}>
                <strong style={{ display: "block", color: "#0b4f30" }}>2. Instant 0–100 Score</strong>
                <span>Flags seed oils, synthetic dyes, HFCS &amp; nitrites</span>
              </div>
              <div style={{ fontSize: 11.5 }}>
                <strong style={{ display: "block", color: "#0b4f30" }}>3. Jump to Cleaner Pick ↗</strong>
                <span>Opens verified cleaner alternatives directly in your store</span>
              </div>
            </div>
            <div>
              <strong style={{ color: "#0f172a" }}>1. How do Cleaner Picks work?</strong>
              <div>
                HeyBroc scores what you&apos;re viewing (0–100) and gives you a direct link to open a higher-scoring alternative right inside your grocery store so you can add it if you choose.
              </div>
            </div>
            <div>
              <strong style={{ color: "#0f172a" }}>2. Do food brands pay to boost their scores?</strong>
              <div>
                Never. HeyBroc is 100% independent. Every 0–100 score and cleaner pick is computed deterministically from the ingredient list and nutrition facts.
              </div>
            </div>
            <div>
              <strong style={{ color: "#0f172a" }}>3. Does one membership cover my phone, computer &amp; family?</strong>
              <div>
                Yes. One Family Pro membership unlocks Web, Android Live Store Bubble, iOS Safari Extension, and Chrome Extension across your household devices when signed in.
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
                Unlimited live store overlays, verified cleaner store links &amp; order health audits are now active on your account.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
