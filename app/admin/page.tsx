"use client";

import { useCallback, useEffect, useState } from "react";
import InfluencerEngine from "@/components/InfluencerEngine";

const SESSION_SECRET_KEY = "heybroc_admin_secret";

interface PaywallConfigState {
  headline: string;
  subheadline: string;
  ctaLabel: string;
  freeWeeklySwapsLimit: number;
  defaultPlan: "annual" | "monthly";
  abTestEnabled: boolean;
  variantBHeadline: string;
  updatedAt: string;
}

interface AnalyticsSnapshotState {
  totals: {
    product_scanned: number;
    clean_swap_clicked: number;
    paywall_viewed: number;
    checkout_started: number;
    pro_subscribed: number;
    onboarding_step: number;
    auth_completed: number;
  };
  byPlatform: {
    web: number;
    android: number;
    extension: number;
    ios: number;
  };
  byStore: Record<string, number>;
  abTest: {
    variantAViews: number;
    variantACheckouts: number;
    variantASubscribed: number;
    variantBViews: number;
    variantBCheckouts: number;
    variantBSubscribed: number;
  };
  recentEvents: Array<{
    id: string;
    event: string;
    platform: string;
    store?: string;
    variant?: "A" | "B";
    summary: string;
    timestamp: string;
  }>;
  posthogConnected: boolean;
  revenueCatConfigured: boolean;
  updatedAt: string;
}

function pct(num: number, den: number): string {
  if (!den || den <= 0) return "0.0%";
  return `${((num / den) * 100).toFixed(1)}%`;
}

export default function AdminPage() {
  const [secretInput, setSecretInput] = useState("");
  const [activeSecret, setActiveSecret] = useState("");
  const [authError, setAuthError] = useState("");
  const [verifying, setVerifying] = useState(false);

  const [snapshot, setSnapshot] = useState<AnalyticsSnapshotState | null>(null);
  const [paywallForm, setPaywallForm] = useState<PaywallConfigState | null>(null);
  const [savingPaywall, setSavingPaywall] = useState(false);
  const [paywallSavedMsg, setPaywallSavedMsg] = useState("");
  const [labelReports, setLabelReports] = useState<
    Array<{
      id: string;
      createdAt: string;
      productTitle: string;
      previousScore: number;
      verifiedScore: number;
      status: string;
      resolutionSource: string;
      summary: string;
    }>
  >([]);

  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem(SESSION_SECRET_KEY);
      if (saved) {
        setActiveSecret(saved);
      }
    } catch {
      /* ignore sessionStorage errors */
    }
  }, []);

  const loadAnalytics = useCallback(async (secret: string) => {
    try {
      const [res, repRes] = await Promise.all([
        fetch("/api/analytics", {
          headers: { Authorization: `Bearer ${secret}` },
        }),
        fetch("/api/label-report", {
          headers: { Authorization: `Bearer ${secret}` },
        }),
      ]);
      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          if (data.snapshot) setSnapshot(data.snapshot as AnalyticsSnapshotState);
          if (data.paywall) setPaywallForm(data.paywall as PaywallConfigState);
        }
      }
      if (repRes.ok) {
        const repData = await repRes.json();
        if (repData?.ok && Array.isArray(repData.reports)) {
          setLabelReports(repData.reports);
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (activeSecret) {
      void loadAnalytics(activeSecret);
    }
  }, [activeSecret, loadAnalytics]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = secretInput.trim();
    if (!trimmed) {
      setAuthError("Enter HEYBROC_ADMIN_SECRET to continue.");
      return;
    }
    setVerifying(true);
    setAuthError("");
    try {
      const res = await fetch("/api/influencers", {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      if (!res.ok) {
        setAuthError("Invalid admin secret (or HEYBROC_ADMIN_SECRET is not configured on the server).");
        return;
      }
      try {
        window.sessionStorage.setItem(SESSION_SECRET_KEY, trimmed);
      } catch {
        /* ignore */
      }
      setActiveSecret(trimmed);
      setSecretInput("");
    } catch {
      setAuthError("Network error verifying admin secret.");
    } finally {
      setVerifying(false);
    }
  };

  const handleSavePaywall = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!paywallForm || !activeSecret) return;
    setSavingPaywall(true);
    setPaywallSavedMsg("");
    try {
      const res = await fetch("/api/analytics", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${activeSecret}`,
        },
        body: JSON.stringify({
          action: "update_paywall",
          ...paywallForm,
        }),
      });
      const data = await res.json();
      if (data.ok && data.paywall) {
        setPaywallForm(data.paywall as PaywallConfigState);
        setPaywallSavedMsg("Live across Web, Android, iOS & Chrome Extension!");
        setTimeout(() => setPaywallSavedMsg(""), 4000);
      }
    } catch {
      setPaywallSavedMsg("Failed to save paywall config.");
    } finally {
      setSavingPaywall(false);
    }
  };

  const handleLogout = () => {
    try {
      window.sessionStorage.removeItem(SESSION_SECRET_KEY);
    } catch {
      /* ignore */
    }
    setActiveSecret("");
  };

  if (!activeSecret) {
    return (
      <main style={{ maxWidth: 460, margin: "80px auto", padding: "0 20px" }}>
        <div className="card" style={{ padding: 28 }}>
          <span className="eyebrow eyebrow--green">HeyBroc Admin</span>
          <h1 style={{ fontSize: 24, margin: "6px 0 8px" }}>Growth, Paywalls & Creator Ledger</h1>
          <p className="meta" style={{ marginBottom: 16 }}>
            Enter your <code>HEYBROC_ADMIN_SECRET</code> to manage growth analytics, remote paywalls, and creator payouts.
          </p>
          <form onSubmit={handleLogin} style={{ display: "grid", gap: 12 }}>
            <input
              id="admin-secret-input"
              type="password"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              placeholder="HEYBROC_ADMIN_SECRET"
              autoComplete="current-password"
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #d4dbd6", fontSize: 15 }}
            />
            {authError && <p className="error">{authError}</p>}
            <button id="admin-login-btn" type="submit" className="swap-btn" disabled={verifying}>
              {verifying ? "Verifying…" : "Unlock Admin Command Center →"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main style={{ padding: "24px 16px" }}>
      <div
        style={{
          maxWidth: 1080,
          margin: "0 auto 16px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <a href="/" className="link-btn">
          ← Back to HeyBroc
        </a>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              padding: "4px 10px",
              borderRadius: 999,
              background: snapshot?.posthogConnected ? "#dcfce7" : "#f1f5f9",
              color: snapshot?.posthogConnected ? "#166534" : "#475569",
            }}
          >
            {snapshot?.posthogConnected
              ? "● PostHog Server Bridge Active"
              : "○ PostHog Ready (set POSTHOG_API_KEY to forward)"}
          </span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              padding: "4px 10px",
              borderRadius: 999,
              background: snapshot?.revenueCatConfigured ? "#dcfce7" : "#f1f5f9",
              color: snapshot?.revenueCatConfigured ? "#166534" : "#475569",
            }}
          >
            {snapshot?.revenueCatConfigured
              ? "● RevenueCat Webhook Active"
              : "○ RevenueCat Webhook Ready (/api/revenuecat/webhook)"}
          </span>
          <button
            type="button"
            className="link-btn"
            onClick={() => void loadAnalytics(activeSecret)}
          >
            ↻ Refresh Metrics
          </button>
          <button type="button" className="link-btn" onClick={handleLogout}>
            Lock Admin Session
          </button>
        </div>
      </div>

      {/* GROWTH FUNNEL & REMOTE PAYWALL COMMAND CENTER */}
      <section style={{ maxWidth: 1080, margin: "0 auto 28px", display: "grid", gap: 20 }}>
        {snapshot && (
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
              <div>
                <span className="eyebrow eyebrow--green">First-Party + PostHog Bridge (Zero APK Trackers)</span>
                <h2 style={{ fontSize: 21, margin: "4px 0 0" }}>Full-Funnel Conversion & Platform Telemetry</h2>
              </div>
              <span className="meta">
                Web: <strong>{snapshot.byPlatform.web}</strong> · Android: <strong>{snapshot.byPlatform.android}</strong> · Chrome: <strong>{snapshot.byPlatform.extension}</strong> · iOS: <strong>{snapshot.byPlatform.ios}</strong>
              </span>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))",
                gap: 12,
                marginBottom: 20,
              }}
            >
              <div style={{ padding: 14, borderRadius: 12, background: "#f8faf9", border: "1px solid #e2e8e4" }}>
                <div className="meta" style={{ fontSize: 12 }}>1. Products Scanned</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: "#122017", margin: "4px 0" }}>
                  {snapshot.totals.product_scanned.toLocaleString()}
                </div>
                <div className="meta" style={{ fontSize: 11 }}>Top of funnel (100% free)</div>
              </div>

              <div style={{ padding: 14, borderRadius: 12, background: "#f8faf9", border: "1px solid #e2e8e4" }}>
                <div className="meta" style={{ fontSize: 12 }}>2. Clean Swaps Clicked</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: "#15803d", margin: "4px 0" }}>
                  {snapshot.totals.clean_swap_clicked.toLocaleString()}
                </div>
                <div className="meta" style={{ fontSize: 11 }}>
                  {pct(snapshot.totals.clean_swap_clicked, snapshot.totals.product_scanned)} of scans
                </div>
              </div>

              <div style={{ padding: 14, borderRadius: 12, background: "#f8faf9", border: "1px solid #e2e8e4" }}>
                <div className="meta" style={{ fontSize: 12 }}>3. Paywall Viewed</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: "#122017", margin: "4px 0" }}>
                  {snapshot.totals.paywall_viewed.toLocaleString()}
                </div>
                <div className="meta" style={{ fontSize: 11 }}>
                  {pct(snapshot.totals.paywall_viewed, snapshot.totals.clean_swap_clicked || snapshot.totals.product_scanned)} reach paywall
                </div>
              </div>

              <div style={{ padding: 14, borderRadius: 12, background: "#f8faf9", border: "1px solid #e2e8e4" }}>
                <div className="meta" style={{ fontSize: 12 }}>4. Checkout Started</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: "#0369a1", margin: "4px 0" }}>
                  {snapshot.totals.checkout_started.toLocaleString()}
                </div>
                <div className="meta" style={{ fontSize: 11 }}>
                  {pct(snapshot.totals.checkout_started, snapshot.totals.paywall_viewed)} of paywall views
                </div>
              </div>

              <div style={{ padding: 14, borderRadius: 12, background: "#ecfdf5", border: "1px solid #a7f3d0" }}>
                <div className="meta" style={{ fontSize: 12, color: "#065f46", fontWeight: 700 }}>5. Pro Subscribed</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: "#047857", margin: "4px 0" }}>
                  {snapshot.totals.pro_subscribed.toLocaleString()}
                </div>
                <div className="meta" style={{ fontSize: 11, color: "#065f46" }}>
                  {pct(snapshot.totals.pro_subscribed, snapshot.totals.checkout_started)} checkout completion
                </div>
              </div>
            </div>

            {/* A/B Paywall Variant Comparison */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
              <div style={{ padding: 14, borderRadius: 12, border: "1px solid #e2e8e4", background: "#fff" }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
                  Variant A (Control Headline)
                </div>
                <div className="meta" style={{ fontSize: 13 }}>
                  Views: <strong>{snapshot.abTest.variantAViews}</strong> · Checkouts: <strong>{snapshot.abTest.variantACheckouts}</strong> (
                  {pct(snapshot.abTest.variantACheckouts, snapshot.abTest.variantAViews)}) · Subscribed: <strong>{snapshot.abTest.variantASubscribed}</strong>
                </div>
              </div>
              <div style={{ padding: 14, borderRadius: 12, border: "1px solid #e2e8e4", background: "#fff" }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
                  Variant B (Challenger Headline)
                </div>
                <div className="meta" style={{ fontSize: 13 }}>
                  Views: <strong>{snapshot.abTest.variantBViews}</strong> · Checkouts: <strong>{snapshot.abTest.variantBCheckouts}</strong> (
                  {pct(snapshot.abTest.variantBCheckouts, snapshot.abTest.variantBViews)}) · Subscribed: <strong>{snapshot.abTest.variantBSubscribed}</strong>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* REMOTE PAYWALL & A/B EXPERIMENT EDITOR ("SUPERWALL" ENGINE) */}
        {paywallForm && (
          <div className="card" style={{ padding: 24 }}>
            <span className="eyebrow eyebrow--green">Remote Paywall Engine (Superwall Alternative)</span>
            <h2 style={{ fontSize: 21, margin: "4px 0 6px" }}>Live Paywall Copy, Free Swap Quota & A/B Experiments</h2>
            <p className="meta" style={{ marginBottom: 16 }}>
              Changes saved here immediately update the paywall across the Web App, Android App, iOS Safari Extension, and Chrome Extension with zero app store review wait.
            </p>

            <form onSubmit={handleSavePaywall} style={{ display: "grid", gap: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
                <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
                  Variant A Headline (Control)
                  <input
                    type="text"
                    value={paywallForm.headline}
                    onChange={(e) => setPaywallForm({ ...paywallForm, headline: e.target.value })}
                    style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #d4dbd6", fontSize: 14 }}
                  />
                </label>

                <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
                  Variant B Headline (50/50 A/B Challenger)
                  <input
                    type="text"
                    value={paywallForm.variantBHeadline}
                    onChange={(e) => setPaywallForm({ ...paywallForm, variantBHeadline: e.target.value })}
                    style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #d4dbd6", fontSize: 14 }}
                  />
                </label>
              </div>

              <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
                Paywall Subheadline
                <input
                  type="text"
                  value={paywallForm.subheadline}
                  onChange={(e) => setPaywallForm({ ...paywallForm, subheadline: e.target.value })}
                  style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #d4dbd6", fontSize: 14 }}
                />
              </label>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14, alignItems: "end" }}>
                <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
                  CTA Button Label
                  <input
                    type="text"
                    value={paywallForm.ctaLabel}
                    onChange={(e) => setPaywallForm({ ...paywallForm, ctaLabel: e.target.value })}
                    style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #d4dbd6", fontSize: 14 }}
                  />
                </label>

                <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
                  Free Starter Swaps Quota
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={paywallForm.freeWeeklySwapsLimit}
                    onChange={(e) =>
                      setPaywallForm({
                        ...paywallForm,
                        freeWeeklySwapsLimit: Math.max(1, Math.min(50, Number(e.target.value) || 5)),
                      })
                    }
                    style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #d4dbd6", fontSize: 14 }}
                  />
                </label>

                <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
                  Default Selected Plan
                  <select
                    value={paywallForm.defaultPlan}
                    onChange={(e) =>
                      setPaywallForm({
                        ...paywallForm,
                        defaultPlan: e.target.value === "monthly" ? "monthly" : "annual",
                      })
                    }
                    style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #d4dbd6", fontSize: 14, background: "#fff" }}
                  >
                    <option value="annual">Annual ($49.99/yr — Best Value)</option>
                    <option value="monthly">Monthly ($9.99/mo)</option>
                  </select>
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700, paddingBottom: 10 }}>
                  <input
                    type="checkbox"
                    checked={paywallForm.abTestEnabled}
                    onChange={(e) => setPaywallForm({ ...paywallForm, abTestEnabled: e.target.checked })}
                  />
                  Run 50/50 A/B Headline Split
                </label>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <button type="submit" className="swap-btn" disabled={savingPaywall} style={{ width: "auto", padding: "10px 20px" }}>
                  {savingPaywall ? "Publishing Live…" : "Publish Remote Paywall Config →"}
                </button>
                {paywallSavedMsg && (
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#15803d" }}>{paywallSavedMsg}</span>
                )}
              </div>
            </form>
          </div>
        )}

        {/* AUTOMATIC AI LABEL VERIFIER LOG */}
        <div className="card" style={{ padding: 24 }}>
          <span className="eyebrow eyebrow--green">🤖 Automatic Label &amp; Score Verifier</span>
          <h2 style={{ fontSize: 21, margin: "4px 0 6px" }}>Auto-Resolved Shopper Label Reports ({labelReports.length})</h2>
          <p className="meta" style={{ marginBottom: 14 }}>
            When shoppers tap &ldquo;Report a mistake (Auto-Verify)&rdquo;, HeyBroc automatically re-verifies the product against USDA FoodData Central, Open Food Facts, and package label OCR—resolving reports in real time with zero manual email triage.
          </p>
          {labelReports.length === 0 ? (
            <div style={{ padding: 14, borderRadius: 12, background: "#f8fafc", border: "1px dashed #cbd5e1", fontSize: 13, color: "#475569" }}>
              No shopper label reports logged yet. All reports are verified automatically in-app.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {labelReports.slice(0, 12).map((rep) => (
                <div
                  key={rep.id}
                  style={{
                    padding: "12px 14px",
                    borderRadius: 12,
                    border: "1px solid #e2e8f0",
                    background: "#ffffff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: "#0f172a" }}>
                      {rep.productTitle}{" "}
                      <span style={{ fontSize: 12, fontWeight: 700, color: "#0f7a4a" }}>
                        ({rep.previousScore}/100 → {rep.verifiedScore}/100)
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>{rep.summary}</div>
                  </div>
                  <span
                    style={{
                      padding: "4px 10px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 800,
                      background: rep.status === "auto_updated" ? "#dcfce7" : "#f1f5f9",
                      color: rep.status === "auto_updated" ? "#166534" : "#334155",
                    }}
                  >
                    {rep.status === "auto_updated" ? "✓ Auto-Updated" : "✓ Verified Accurate"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <InfluencerEngine
        open={true}
        standalone={true}
        adminSecret={activeSecret}
        onUnauthorized={handleLogout}
      />
    </main>
  );
}

