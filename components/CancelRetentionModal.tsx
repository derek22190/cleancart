"use client";

import { useEffect, useState } from "react";
import {
  PRICING,
  annualSavingsPct,
  otoAnnualSavingsPct,
  type PlanId,
} from "@/lib/pricing";
import { TERMS_VERSION } from "@/lib/terms";

interface RetentionEligibilityDto {
  hasManagedStripeSub: boolean;
  isTrialing: boolean;
  hasPaidCharge: boolean;
  isCurrentlyPaused: boolean;
  pausedUntilMs?: number;
  canPause30d: boolean;
  canLoyaltyAnnual39: boolean;
  canStandardAnnual49: boolean;
  canSwitchToMonthly: boolean;
}

interface InspectResponseDto {
  ok?: boolean;
  hasManagedStripeSub?: boolean;
  plan?: PlanId;
  status?: string;
  sessionId?: string;
  expiresAtMs?: number | null;
  pausedUntilMs?: number | null;
  eligibility?: RetentionEligibilityDto;
}

export interface CancelRetentionModalProps {
  open: boolean;
  onClose: () => void;
  /** Invoked when the shopper chooses 1-click cancellation in Stripe Portal or when no managed Stripe sub is active locally. */
  onProceedToPortal: () => Promise<void> | void;
  portalBusy?: boolean;
  familyWatchlistLabels?: string[];
  dietaryWatchlistCount?: number;
  deviceId?: string;
  userEmail?: string;
}

const CATEGORY_FRIENDLY_LABELS: Record<string, string> = {
  seedOils: "Seed Oils",
  dyes: "Synthetic Dyes",
  hfcs: "High-Fructose Corn Syrup",
  preservatives: "Chemical Preservatives",
  nitrates: "Nitrites & Nitrates",
  sweeteners: "Artificial Sweeteners",
  emulsifiers: "Gut-Disrupting Emulsifiers",
};

export default function CancelRetentionModal({
  open,
  onClose,
  onProceedToPortal,
  portalBusy = false,
  familyWatchlistLabels,
  dietaryWatchlistCount,
  deviceId,
  userEmail,
}: CancelRetentionModalProps) {
  const [loadingInspect, setLoadingInspect] = useState(true);
  const [inspectData, setInspectData] = useState<InspectResponseDto | null>(null);
  const [actionBusy, setActionBusy] = useState<"" | "pause" | "switch" | "cancel">("");
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [successBanner, setSuccessBanner] = useState<{
    title: string;
    body: string;
  } | null>(null);
  const [localWatchLabels, setLocalWatchLabels] = useState<string[]>([]);
  const [localDietaryCount, setLocalDietaryCount] = useState<number>(0);

  useEffect(() => {
    if (!open) {
      setLoadingInspect(true);
      setInspectData(null);
      setActionBusy("");
      setAgreedToTerms(false);
      setErrorMsg("");
      setSuccessBanner(null);
      return;
    }

    if (typeof window === "undefined") return;

    try {
      const savedWl = JSON.parse(
        window.localStorage.getItem("heybroc_family_watchlist") || "[]"
      ) as unknown;
      if (Array.isArray(savedWl)) {
        setLocalWatchLabels(
          savedWl
            .filter((k): k is string => typeof k === "string")
            .map((k) => CATEGORY_FRIENDLY_LABELS[k] || k)
        );
      }
      const savedDiet = JSON.parse(
        window.localStorage.getItem("heybroc_dietary_watchlist") || "[]"
      ) as unknown;
      if (Array.isArray(savedDiet)) {
        setLocalDietaryCount(savedDiet.length);
      }
    } catch {
      /* ignore localStorage parse errors */
    }

    let cancelled = false;
    async function runInspect() {
      setLoadingInspect(true);
      setErrorMsg("");
      try {
        const sp = new URLSearchParams(window.location.search);
        const resolvedDevId =
          deviceId ||
          sp.get("deviceId") ||
          window.localStorage.getItem("heybroc_device_id") ||
          "";
        const devSecret =
          window.localStorage.getItem("heybroc_device_secret") || "";
        const sessionId =
          sp.get("session_id") ||
          window.localStorage.getItem("heybroc_session_id") ||
          "";
        const authToken = (
          window.localStorage.getItem("heybroc_auth_token") || ""
        ).trim();
        let resolvedEmail = userEmail || sp.get("email") || "";
        if (!resolvedEmail) {
          try {
            const cached = JSON.parse(
              window.localStorage.getItem("heybroc_auth_user") ||
                window.localStorage.getItem("heybroc_user") ||
                "null"
            ) as { email?: string } | null;
            if (cached?.email) resolvedEmail = cached.email;
          } catch {
            /* ignore */
          }
        }

        const res = await fetch("/api/billing/retention", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            ...(devSecret ? { "X-Device-Secret": devSecret } : {}),
          },
          body: JSON.stringify({
            action: "inspect",
            deviceId: resolvedDevId || undefined,
            deviceSecret: devSecret || undefined,
            sessionId: sessionId || undefined,
            email: resolvedEmail || undefined,
          }),
        });
        const data = (await res.json().catch(() => null)) as InspectResponseDto | null;
        if (cancelled) return;

        if (!res.ok || !data?.ok || !data.hasManagedStripeSub || !data.eligibility) {
          // Fall straight through to normal Stripe Portal / sign-in flow so non-Stripe users never hit a dead end
          onClose();
          await onProceedToPortal();
          return;
        }
        setInspectData(data);
        setLoadingInspect(false);
      } catch {
        if (cancelled) return;
        onClose();
        await onProceedToPortal();
      }
    }

    void runInspect();
    return () => {
      cancelled = true;
    };
  }, [open, deviceId, userEmail, onClose, onProceedToPortal]);

  if (!open) return null;

  const eligibility = inspectData?.eligibility;
  const effectiveWatchLabels =
    familyWatchlistLabels && familyWatchlistLabels.length > 0
      ? familyWatchlistLabels
      : localWatchLabels;
  const effectiveDietaryCount =
    typeof dietaryWatchlistCount === "number"
      ? dietaryWatchlistCount
      : localDietaryCount;

  const getClientCredentials = () => {
    const sp =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : null;
    const resolvedDevId =
      deviceId ||
      sp?.get("deviceId") ||
      (typeof window !== "undefined" &&
        window.localStorage.getItem("heybroc_device_id")) ||
      "";
    const devSecret =
      (typeof window !== "undefined" &&
        window.localStorage.getItem("heybroc_device_secret")) ||
      "";
    const sessionId =
      inspectData?.sessionId ||
      sp?.get("session_id") ||
      (typeof window !== "undefined" &&
        window.localStorage.getItem("heybroc_session_id")) ||
      "";
    const authToken =
      typeof window !== "undefined"
        ? (window.localStorage.getItem("heybroc_auth_token") || "").trim()
        : "";
    let resolvedEmail = userEmail || sp?.get("email") || "";
    if (!resolvedEmail && typeof window !== "undefined") {
      try {
        const cached = JSON.parse(
          window.localStorage.getItem("heybroc_auth_user") ||
            window.localStorage.getItem("heybroc_user") ||
            "null"
        ) as { email?: string } | null;
        if (cached?.email) resolvedEmail = cached.email;
      } catch {
        /* ignore */
      }
    }
    return { resolvedDevId, devSecret, sessionId, authToken, resolvedEmail };
  };

  const handlePause30Days = async () => {
    setActionBusy("pause");
    setErrorMsg("");
    try {
      const { resolvedDevId, devSecret, sessionId, authToken, resolvedEmail } =
        getClientCredentials();
      const res = await fetch("/api/billing/retention", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          ...(devSecret ? { "X-Device-Secret": devSecret } : {}),
        },
        body: JSON.stringify({
          action: "pause_30d",
          deviceId: resolvedDevId || undefined,
          deviceSecret: devSecret || undefined,
          sessionId: sessionId || undefined,
          email: resolvedEmail || undefined,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        pausedUntilMs?: number;
        error?: string;
      } | null;
      if (!res.ok || !data?.ok) {
        setErrorMsg(
          data?.error ||
            "Could not pause billing automatically. Use the 1-click Stripe Billing Portal button below."
        );
        return;
      }
      const resumeStr = data.pausedUntilMs
        ? new Date(data.pausedUntilMs).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "in 30 days";
      setSuccessBanner({
        title: `✓ Billing Paused Until ${resumeStr}`,
        body: "You won't be charged during your 30-day pause, and your custom Family Watchlist & Clean Swaps stay saved.",
      });
    } catch {
      setErrorMsg("Network error pausing billing. Please try again.");
    } finally {
      setActionBusy("");
    }
  };

  const handleSwitchPlan = async () => {
    if (!eligibility) return;
    if (!agreedToTerms) {
      setErrorMsg(
        "Please check the box to confirm the automatic renewal terms before switching plans."
      );
      return;
    }
    setActionBusy("switch");
    setErrorMsg("");
    try {
      const { resolvedDevId, devSecret, sessionId, authToken, resolvedEmail } =
        getClientCredentials();

      if (eligibility.canSwitchToMonthly) {
        const res = await fetch("/api/billing/retention", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            ...(devSecret ? { "X-Device-Secret": devSecret } : {}),
          },
          body: JSON.stringify({
            action: "switch_to_monthly",
            deviceId: resolvedDevId || undefined,
            deviceSecret: devSecret || undefined,
            sessionId: sessionId || undefined,
            email: resolvedEmail || undefined,
            agreedToTerms: true,
            termsVersion: TERMS_VERSION,
          }),
        });
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          renewsAtMs?: number | null;
          error?: string;
        } | null;
        if (!res.ok || !data?.ok) {
          setErrorMsg(
            data?.error ||
              "Could not switch plan automatically. Use the Stripe Billing Portal button below."
          );
          return;
        }
        const dateNote = data.renewsAtMs
          ? ` starting ${new Date(data.renewsAtMs).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}`
          : "";
        setSuccessBanner({
          title: `✓ Switched to Flexible $${PRICING.monthly.toFixed(2)}/mo Plan`,
          body: `No $${PRICING.annual.toFixed(2)} annual charge will occur. Your plan will renew monthly at $${PRICING.monthly.toFixed(2)}/mo${dateNote} until canceled.`,
        });
        return;
      }

      // Loyalty Annual ($39.99/yr for paid monthly members) OR Standard Annual ($49.99/yr)
      const isLoyalty39 = eligibility.canLoyaltyAnnual39;
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          ...(devSecret ? { "X-Device-Secret": devSecret } : {}),
        },
        body: JSON.stringify({
          plan: "annual",
          ...(isLoyalty39 ? { otoOffer: "oto_annual" } : {}),
          retentionSource: "cancel_flow",
          previousSessionId: sessionId || undefined,
          deviceId: resolvedDevId || undefined,
          deviceSecret: devSecret || undefined,
          email: resolvedEmail || undefined,
          termsAccepted: true,
          termsVersion: TERMS_VERSION,
          origin:
            typeof window !== "undefined"
              ? window.location.origin
              : "https://www.heybroc.com",
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        url?: string;
        error?: string;
      } | null;
      if (res.ok && data?.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      setErrorMsg(
        data?.error ||
          "Could not start plan switch checkout. You can also manage plans in the Stripe Billing Portal below."
      );
    } catch {
      setErrorMsg("Network error switching plans. Please try again.");
    } finally {
      setActionBusy("");
    }
  };

  const hasPlanSwitchOption = Boolean(
    eligibility &&
      (eligibility.canLoyaltyAnnual39 ||
        eligibility.canSwitchToMonthly ||
        eligibility.canStandardAnnual49)
  );

  const renewalPriceLabel = eligibility?.canLoyaltyAnnual39
    ? `$${PRICING.otoAnnualLockIn.toFixed(2)}/yr`
    : eligibility?.canSwitchToMonthly
      ? `$${PRICING.monthly.toFixed(2)}/mo`
      : `$${PRICING.annual.toFixed(2)}/yr`;

  return (
    <div
      className="paywall-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-retention-title"
      style={{ zIndex: 10050 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="paywall-modal"
        style={{
          maxWidth: 460,
          padding: "20px 20px 18px",
          borderRadius: 20,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            marginBottom: 10,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              borderRadius: 999,
              background: "#ecfdf5",
              color: "#0f7a4a",
              fontSize: 11.5,
              fontWeight: 800,
            }}
          >
            🥦 Manage HeyBroc Family Pro
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "#f1f5f9",
              border: "none",
              borderRadius: 999,
              width: 30,
              height: 30,
              fontSize: 15,
              fontWeight: 800,
              color: "#334155",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>

        {loadingInspect ? (
          <div style={{ padding: "24px 8px", textAlign: "center", color: "#475569", fontSize: 13.5 }}>
            Loading your membership options…
          </div>
        ) : (
          <>
            <h2
              id="cancel-retention-title"
              style={{
                margin: "0 0 6px",
                fontSize: 19,
                lineHeight: 1.25,
                fontWeight: 800,
                color: "#0f172a",
              }}
            >
              Before you cancel Family Pro…
            </h2>
            <p
              style={{
                margin: "0 0 12px",
                fontSize: 12.5,
                lineHeight: 1.45,
                color: "#475569",
              }}
            >
              0–100 food scores stay free forever, or you can adjust your billing below—or continue straight to 1-click cancellation.
            </p>

            {/* PERSONALIZED LOSS SUMMARY (APPLE RETENTION MESSAGING STYLE) */}
            <div
              id="retention-loss-summary"
              style={{
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: 14,
                padding: "11px 13px",
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 800,
                  color: "#92400e",
                  marginBottom: 6,
                  textTransform: "uppercase",
                  letterSpacing: 0.3,
                }}
              >
                What turns off when Pro ends
              </div>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: 18,
                  display: "grid",
                  gap: 5,
                  fontSize: 12.5,
                  lineHeight: 1.4,
                  color: "#78350f",
                }}
              >
                <li>
                  <b>Custom 2x Family Watchlist:</b>{" "}
                  {effectiveWatchLabels.length > 0
                    ? `${effectiveWatchLabels.slice(0, 3).join(", ")}${effectiveWatchLabels.length > 3 ? ` +${effectiveWatchLabels.length - 3} more` : ""} double-penalty guard`
                    : "Custom additive double-penalty rules"}
                  {effectiveDietaryCount > 0
                    ? ` & ${effectiveDietaryCount} active allergy/diet ${effectiveDietaryCount === 1 ? "alert" : "alerts"}`
                    : ""}
                </li>
                <li>
                  <b>Unlimited 1-Tap Clean Swaps:</b> Direct cleaner store links across Walmart, Target, Costco, Instacart &amp; 8 more apps revert to {PRICING.freeWeeklySwaps}/week
                </li>
                <li>
                  <b>Weekly Order &amp; Receipt Audits:</b> Whole-cart health grading &amp; instant cart swaps turn off
                </li>
              </ul>
            </div>

            {successBanner ? (
              <div
                role="status"
                style={{
                  background: "#ecfdf5",
                  border: "1.5px solid #0f7a4a",
                  borderRadius: 14,
                  padding: "12px 14px",
                  marginBottom: 12,
                }}
              >
                <div style={{ fontWeight: 800, fontSize: 13.5, color: "#065f46", marginBottom: 4 }}>
                  {successBanner.title}
                </div>
                <div style={{ fontSize: 12.5, color: "#047857", lineHeight: 1.4 }}>
                  {successBanner.body}
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    marginTop: 10,
                    width: "100%",
                    padding: "10px 14px",
                    borderRadius: 10,
                    border: "none",
                    background: "#0f7a4a",
                    color: "#fff",
                    fontWeight: 800,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  Done — Keep Shopping Clean →
                </button>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
                {eligibility?.canPause30d && (
                  <button
                    id="retention-pause-btn"
                    type="button"
                    disabled={actionBusy !== ""}
                    onClick={handlePause30Days}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "11px 13px",
                      borderRadius: 12,
                      border: "1.5px solid #0f7a4a",
                      background: "#f0fdf4",
                      cursor: actionBusy ? "wait" : "pointer",
                    }}
                  >
                    <div style={{ fontWeight: 800, fontSize: 13.5, color: "#065f46" }}>
                      {actionBusy === "pause"
                        ? "Pausing billing for 30 days…"
                        : "⏸ Pause Billing for 30 Days ($0 Charged)"}
                    </div>
                    <div style={{ fontSize: 12, color: "#166534", marginTop: 2 }}>
                      Skip your next monthly charge while keeping your Family Watchlist &amp; Clean Swaps saved.
                    </div>
                  </button>
                )}

                {hasPlanSwitchOption && (
                  <div
                    style={{
                      padding: "11px 13px",
                      borderRadius: 12,
                      border: "1.5px solid #cbd5e1",
                      background: "#f8fafc",
                    }}
                  >
                    <div style={{ fontWeight: 800, fontSize: 13.5, color: "#0f172a" }}>
                      {eligibility?.canLoyaltyAnnual39
                        ? `🔒 Loyalty Member Lock-In: $${PRICING.otoAnnualLockIn.toFixed(2)}/yr (Save ${otoAnnualSavingsPct}%)`
                        : eligibility?.canSwitchToMonthly
                          ? eligibility.isTrialing
                            ? `🔄 Prefer Smaller Payments? Switch to $${PRICING.monthly.toFixed(2)}/mo After Trial`
                            : `🔄 Switch Next Renewal to Flexible $${PRICING.monthly.toFixed(2)}/mo`
                          : `🔄 Switch to $${PRICING.annual.toFixed(2)}/yr Annual (Save ${annualSavingsPct}%)`}
                    </div>
                    <div style={{ fontSize: 12, color: "#475569", marginTop: 3, lineHeight: 1.4 }}>
                      {eligibility?.canLoyaltyAnnual39
                        ? "Because you're already a paid Monthly member, you can lock in a full year for $39.99 ($3.33/mo) and keep your remaining prepaid monthly days."
                        : eligibility?.canSwitchToMonthly
                          ? eligibility.isTrialing
                            ? `Keep your remaining free trial days and avoid the $${PRICING.annual.toFixed(2)} annual charge—pay month-to-month instead.`
                            : "Keep full access through the end of your current annual period, then renew month-to-month."
                          : "Save 58% compared to month-to-month billing."}
                    </div>

                    <label
                      htmlFor="retention-arl-consent"
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        marginTop: 8,
                        marginBottom: 8,
                        fontSize: 11.5,
                        lineHeight: 1.35,
                        color: "#334155",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        id="retention-arl-consent"
                        type="checkbox"
                        checked={agreedToTerms}
                        onChange={(e) => {
                          setAgreedToTerms(e.target.checked);
                          if (e.target.checked) setErrorMsg("");
                        }}
                        style={{ marginTop: 2, accentColor: "#0f7a4a", flexShrink: 0 }}
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
                        and automatic renewal at <b>{renewalPriceLabel}</b> until I cancel.
                      </span>
                    </label>

                    <button
                      id="retention-switch-plan-btn"
                      type="button"
                      disabled={actionBusy !== ""}
                      onClick={handleSwitchPlan}
                      style={{
                        width: "100%",
                        padding: "9px 12px",
                        borderRadius: 10,
                        border: "none",
                        background: "#0f7a4a",
                        color: "#fff",
                        fontWeight: 800,
                        fontSize: 12.5,
                        cursor: actionBusy ? "wait" : "pointer",
                        opacity: agreedToTerms ? 1 : 0.78,
                      }}
                    >
                      {actionBusy === "switch"
                        ? "Updating your plan…"
                        : eligibility?.canLoyaltyAnnual39
                          ? `Lock In $${PRICING.otoAnnualLockIn.toFixed(2)}/yr Loyalty Annual →`
                          : eligibility?.canSwitchToMonthly
                            ? `Switch to $${PRICING.monthly.toFixed(2)}/mo Monthly Plan →`
                            : `Switch to $${PRICING.annual.toFixed(2)}/yr Annual Plan →`}
                    </button>
                  </div>
                )}
              </div>
            )}

            {errorMsg && (
              <div
                role="alert"
                style={{
                  marginBottom: 10,
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
                {errorMsg}
              </div>
            )}

            {/* 1-CLICK CANCEL BUTTON — ALWAYS VISIBLE ON THE SAME SCREEN (CA AB 2863 / FTC CLICK-TO-CANCEL COMPLIANT) */}
            <div
              style={{
                borderTop: "1px solid #e2e8f0",
                paddingTop: 11,
                display: "grid",
                gap: 6,
              }}
            >
              <button
                id="retention-continue-cancel-btn"
                type="button"
                disabled={portalBusy || actionBusy === "cancel"}
                onClick={async () => {
                  setActionBusy("cancel");
                  try {
                    await onProceedToPortal();
                  } finally {
                    setActionBusy("");
                  }
                }}
                style={{
                  width: "100%",
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#334155",
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: portalBusy || actionBusy === "cancel" ? "wait" : "pointer",
                }}
              >
                {portalBusy || actionBusy === "cancel"
                  ? "Opening Stripe Billing Portal…"
                  : "Continue to Cancel Subscription in 1 Click →"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
