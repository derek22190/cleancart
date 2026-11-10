"use client";

import { useEffect, useState } from "react";
import {
  PRICING,
  monthlyPerYear,
  otoAnnualSavingsPct,
  type OtoOfferId,
  type PlanId,
} from "@/lib/pricing";
import { TERMS_VERSION } from "@/lib/terms";

interface PostCheckoutOtoModalProps {
  open: boolean;
  onClose: () => void;
  initialPlan: PlanId;
  sessionId?: string;
  deviceId?: string;
}

export default function PostCheckoutOtoModal({
  open,
  onClose,
  initialPlan,
  sessionId,
  deviceId,
}: PostCheckoutOtoModalProps) {
  const otoOffer: OtoOfferId =
    initialPlan === "monthly" ? "oto_annual" : "oto_gift_year";
  const isRecurringUpgrade = otoOffer === "oto_annual";

  const [agreedToTerms, setAgreedToTerms] = useState(!isRecurringUpgrade);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setAgreedToTerms(!isRecurringUpgrade);
    setError("");
  }, [isRecurringUpgrade, open]);

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const devId =
      deviceId ||
      window.localStorage.getItem("heybroc_device_id") ||
      "anon-web";
    void fetch("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "track",
        event: "onboarding_step",
        deviceId: devId,
        platform: "web",
        properties: {
          step: "oto_viewed",
          otoOffer,
          initialPlan,
          sessionId: sessionId || null,
        },
      }),
    }).catch(() => {});
  }, [open, otoOffer, initialPlan, sessionId, deviceId]);

  if (!open) return null;

  const handleClaimOto = async () => {
    if (isRecurringUpgrade && !agreedToTerms) {
      setError(
        "Please check the box below to agree to the Terms and annual renewal terms before claiming this upgrade."
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const devId =
        deviceId ||
        (typeof window !== "undefined" &&
          window.localStorage.getItem("heybroc_device_id")) ||
        "";
      const devSecret =
        (typeof window !== "undefined" &&
          window.localStorage.getItem("heybroc_device_secret")) ||
        "";
      let userEmail = "";
      if (typeof window !== "undefined") {
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

      void fetch("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "track",
          event: "onboarding_step",
          deviceId: devId || "anon-web",
          platform: "web",
          properties: {
            step: "oto_accepted",
            otoOffer,
            initialPlan,
          },
        }),
      }).catch(() => {});

      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(devSecret ? { "X-Device-Secret": devSecret } : {}),
        },
        body: JSON.stringify({
          plan: "annual",
          otoOffer,
          deviceId: devId || undefined,
          deviceSecret: devSecret || undefined,
          email: userEmail || undefined,
          consentAccepted: true,
          termsAccepted: true,
          termsVersion: TERMS_VERSION,
          origin:
            typeof window !== "undefined"
              ? window.location.origin
              : "https://heybroc.com",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.ok && data?.mode === "stripe" && data?.url) {
        window.location.href = data.url;
        return;
      }
      setError(
        data?.error ||
          "Could not start One-Time Offer checkout. Your current Pro membership remains 100% active."
      );
    } catch {
      setError("Network error claiming offer. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="One-Time New Member Upgrade"
      onClick={onClose}
    >
      <div
        className="modal-card paywall-modal"
        style={{ maxWidth: 520 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            background: "#ecfdf5",
            border: "1.5px solid #6ee7b7",
            borderRadius: 12,
            padding: "10px 14px",
            marginBottom: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 800, color: "#065f46" }}>
            ✓ Step 1 Complete: HeyBroc Family Pro Is Active on Your Account!
          </span>
          <button
            className="close"
            onClick={onClose}
            aria-label="Close offer"
            style={{ margin: 0 }}
          >
            ×
          </button>
        </div>

        <span
          className="eyebrow eyebrow--green"
          style={{
            background: "#fef3c7",
            color: "#92400e",
            border: "1px solid #fde68a",
          }}
        >
          ⚡ ONE-TIME POST-CHECKOUT OFFER (SHOWN ONCE)
        </span>

        {isRecurringUpgrade ? (
          <>
            <h2 style={{ fontSize: 22, margin: "8px 0 6px", lineHeight: 1.25 }}>
              Wait — Lock In a Full Year of Family Pro for Just $
              {PRICING.otoAnnualLockIn.toFixed(2)}/yr (Save {otoAnnualSavingsPct}%)
            </h2>
            <p className="meta" style={{ fontSize: 13.5, marginBottom: 14 }}>
              Because you just joined on Monthly (${PRICING.monthly.toFixed(2)}
              /mo = ${monthlyPerYear.toFixed(2)}/yr), you can upgrade right now
              to our <b>Founder VIP Annual Rate of ${PRICING.otoAnnualLockIn.toFixed(2)}/yr</b>{" "}
              (${(PRICING.otoAnnualLockIn / 12).toFixed(2)}/mo equivalent — $10
              off our normal ${PRICING.annual.toFixed(2)}/yr plan).
            </p>
          </>
        ) : (
          <>
            <h2 style={{ fontSize: 22, margin: "8px 0 6px", lineHeight: 1.25 }}>
              Add 1 Extra Full Year (+ Spouse or Parent Gift Pass) for Just $
              {PRICING.otoExtraYearPass.toFixed(0)} Flat
            </h2>
            <p className="meta" style={{ fontSize: 13.5, marginBottom: 14 }}>
              One-time new-member bonus: Add an extra 12 months of HeyBroc
              Family Pro (or share it with a parent, spouse, or family member on
              up to 5 devices) for a{" "}
              <b>
                single one-time payment of ${PRICING.otoExtraYearPass.toFixed(2)}
              </b>{" "}
              (42% off ${PRICING.annual.toFixed(2)}/yr —{" "}
              <b>never auto-renews</b>).
            </p>
          </>
        )}

        <div
          style={{
            background: "#f8faf9",
            border: "1.5px solid #cbd5e1",
            borderRadius: 14,
            padding: "14px 16px",
            marginBottom: 14,
          }}
        >
          <ul
            className="paywall-perks"
            style={{ margin: 0, display: "grid", gap: 8 }}
          >
            <li>
              <span>✓</span>{" "}
              {isRecurringUpgrade ? (
                <>
                  <b>Save ${(monthlyPerYear - PRICING.otoAnnualLockIn).toFixed(2)}/year</b>{" "}
                  compared to 12 months of Monthly billing
                </>
              ) : (
                <>
                  <b>One-Time ${PRICING.otoExtraYearPass.toFixed(2)} Payment:</b>{" "}
                  Adds +366 days of unrestricted Family Pro (zero recurring charge)
                </>
              )}
            </li>
            <li>
              <span>✓</span>{" "}
              <b>Up to 5 Family Devices Included:</b> Share Clean Swaps &amp;
              Custom 2x Additive Watchlists across Android, iPhone &amp; Chrome
            </li>
            <li>
              <span>✓</span>{" "}
              <b>All 12 Grocery Stores Unlocked:</b> Walmart, Target, Costco,
              Sam&apos;s Club, Instacart, Kroger, ALDI, Amazon Fresh &amp; more
            </li>
          </ul>
        </div>

        {isRecurringUpgrade && (
          <label
            htmlFor="oto-arl-consent"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              margin: "10px 0",
              padding: "10px 12px",
              borderRadius: 10,
              background: agreedToTerms ? "#ecfdf5" : "#f8faf9",
              border: agreedToTerms
                ? "1.5px solid #0f7a4a"
                : "1.5px solid #cbd5e1",
              fontSize: 12.5,
              lineHeight: 1.45,
              color: "#15201B",
              cursor: "pointer",
            }}
          >
            <input
              id="oto-arl-consent"
              type="checkbox"
              checked={agreedToTerms}
              onChange={(e) => {
                setAgreedToTerms(e.target.checked);
                if (e.target.checked) setError("");
              }}
              style={{
                marginTop: 3,
                width: 16,
                height: 16,
                accentColor: "#0f7a4a",
                flexShrink: 0,
              }}
            />
            <span>
              I agree to the{" "}
              <a
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: "#0f7a4a",
                  fontWeight: 700,
                  textDecoration: "underline",
                }}
              >
                Terms
              </a>{" "}
              and that this VIP Annual plan renews at $
              {PRICING.otoAnnualLockIn.toFixed(2)}/yr until I cancel.
            </span>
          </label>
        )}

        {error && <p className="error">{error}</p>}

        <button
          id="oto-claim-btn"
          type="button"
          className="paywall-cta-btn"
          disabled={busy || (isRecurringUpgrade && !agreedToTerms)}
          onClick={handleClaimOto}
        >
          {busy
            ? "Applying One-Time Upgrade…"
            : isRecurringUpgrade
              ? `Yes! Lock In VIP Annual for $${PRICING.otoAnnualLockIn.toFixed(2)}/yr (Save ${otoAnnualSavingsPct}%) →`
              : `Yes! Add +1 Extra Year / Family Pass for $${PRICING.otoExtraYearPass.toFixed(0)} Flat →`}
        </button>

        <button
          id="oto-decline-btn"
          type="button"
          onClick={onClose}
          style={{
            marginTop: 10,
            width: "100%",
            background: "transparent",
            border: "none",
            color: "#475569",
            fontSize: 13,
            fontWeight: 700,
            textDecoration: "underline",
            cursor: "pointer",
            padding: "6px 0",
          }}
        >
          No thanks, take me straight to my Pro account →
        </button>
      </div>
    </div>
  );
}
