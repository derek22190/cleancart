"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PRICING,
  commissionFor,
  projectOutreach,
  usd,
  type OutreachInputs,
} from "@/lib/pricing";

export type CreatorPayoutMethod =
  | "stripe_connect"
  | "paypal"
  | "venmo"
  | "zelle"
  | "manual";

export interface CreatorRow {
  code: string;
  name: string;
  active?: boolean;
  commissionPct: number;
  clicks: number;
  trials: number;
  paidAnnual: number;
  paidMonthly: number;
  grossRevenue: number;
  commissionEarned?: number;
  commissionPaid?: number;
  commissionOwed: number;
  netRevenue: number;
  payoutEmail?: string;
  payoutMethod?: CreatorPayoutMethod;
  payoutHandle?: string;
  stripeConnectAccountId?: string;
  lastPayoutAt?: string;
  createdAt: string;
}

export interface CreatorTotals {
  clicks: number;
  trials: number;
  paidAnnual: number;
  paidMonthly: number;
  grossRevenue: number;
  commissionEarned?: number;
  commissionPaid?: number;
  commissionOwed: number;
  netRevenue: number;
}

export interface CreatorPayoutItem {
  id: string;
  code: string;
  amount: number;
  method: CreatorPayoutMethod;
  status: "paid" | "recorded";
  destination?: string;
  stripeTransferId?: string;
  note?: string;
  createdAt: string;
}

interface InfluencerEngineProps {
  open: boolean;
  onClose?: () => void;
  refreshKey?: number;
  onSelectCodeForPaywall?: (code: string) => void;
  adminSecret?: string;
  standalone?: boolean;
  onUnauthorized?: () => void;
}

export default function InfluencerEngine({
  open,
  onClose,
  refreshKey = 0,
  onSelectCodeForPaywall,
  adminSecret = "",
  standalone = false,
  onUnauthorized,
}: InfluencerEngineProps) {
  const [creators, setCreators] = useState<CreatorRow[]>([]);
  const [recentPayouts, setRecentPayouts] = useState<CreatorPayoutItem[]>([]);
  const [totals, setTotals] = useState<CreatorTotals>({
    clicks: 0,
    trials: 0,
    paidAnnual: 0,
    paidMonthly: 0,
    grossRevenue: 0,
    commissionEarned: 0,
    commissionPaid: 0,
    commissionOwed: 0,
    netRevenue: 0,
  });
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newPct, setNewPct] = useState<number>(PRICING.defaultCommissionPct);
  const [busy, setBusy] = useState(false);
  const [payoutBusyCode, setPayoutBusyCode] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // 1,000-Influencer Outreach Math Calculator state
  const [outreach, setOutreach] = useState<OutreachInputs>({
    creators: 1000,
    clicksPerCreator: 250,
    trialRatePct: 12,
    trialToPaidPct: 45,
    commissionPct: PRICING.defaultCommissionPct,
  });

  const authHeaders = useCallback(
    (json = false): HeadersInit => {
      const headers: Record<string, string> = {};
      if (json) headers["Content-Type"] = "application/json";
      if (adminSecret) headers["Authorization"] = `Bearer ${adminSecret}`;
      return headers;
    },
    [adminSecret]
  );

  const loadSnapshot = useCallback(async () => {
    try {
      const res = await fetch("/api/influencers", {
        headers: authHeaders(false),
      });
      if (res.status === 401) {
        setError("Unauthorized: invalid or unset HEYBROC_ADMIN_SECRET.");
        onUnauthorized?.();
        return;
      }
      const data = await res.json();
      if (data.ok) {
        setError("");
        setCreators(data.creators || []);
        if (data.totals) setTotals(data.totals);
        if (Array.isArray(data.recentPayouts)) setRecentPayouts(data.recentPayouts);
      } else {
        setError(data.error || "Failed to load creator snapshot.");
      }
    } catch {
      /* ignore transient fetch errors */
    }
  }, [authHeaders, onUnauthorized]);

  useEffect(() => {
    if (open) loadSnapshot();
  }, [open, refreshKey, loadSnapshot]);

  if (!open) return null;

  const applySnapshot = (
    status: number,
    data: {
      ok?: boolean;
      creators?: CreatorRow[];
      totals?: CreatorTotals;
      recentPayouts?: CreatorPayoutItem[];
      error?: string;
    }
  ) => {
    if (status === 401) {
      setError("Unauthorized: invalid or unset HEYBROC_ADMIN_SECRET.");
      onUnauthorized?.();
      return;
    }
    if (!data.ok) {
      setError(data.error || "Operation failed.");
      return;
    }
    setError("");
    if (data.creators) setCreators(data.creators);
    if (data.totals) setTotals(data.totals);
    if (Array.isArray(data.recentPayouts)) setRecentPayouts(data.recentPayouts);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCode.trim()) return;
    setBusy(true);
    setNotice("");
    try {
      const res = await fetch("/api/influencers", {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({
          action: "create",
          code: newCode.trim().toUpperCase(),
          name: newName.trim() || undefined,
          commissionPct: newPct,
        }),
      });
      const data = await res.json();
      applySnapshot(res.status, data);
      if (data.ok) {
        setNewCode("");
        setNewName("");
      }
    } finally {
      setBusy(false);
    }
  };

  const quickEvent = async (
    code: string,
    event: "click" | "trial" | "paid_annual" | "checkout_annual"
  ) => {
    setNotice("");
    const res = await fetch("/api/influencers", {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ action: "track", code, event }),
    });
    applySnapshot(res.status, await res.json());
  };

  const updateSplit = async (code: string, commissionPct: number) => {
    const res = await fetch("/api/influencers", {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ action: "update", code, commissionPct }),
    });
    applySnapshot(res.status, await res.json());
  };

  const toggleActive = async (code: string, nextActive: boolean) => {
    const res = await fetch("/api/influencers", {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ action: "update", code, active: nextActive }),
    });
    applySnapshot(res.status, await res.json());
  };

  const handlePayCreator = async (c: CreatorRow) => {
    if (c.commissionOwed <= 0) return;
    const hasConnect = Boolean(c.stripeConnectAccountId);
    const method: CreatorPayoutMethod = hasConnect
      ? "stripe_connect"
      : c.payoutMethod && c.payoutMethod !== "stripe_connect"
        ? c.payoutMethod
        : "manual";
    const destinationLabel = hasConnect
      ? `Stripe Connect (${c.stripeConnectAccountId})`
      : c.payoutHandle || c.payoutEmail || "manual payout";
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        hasConnect
          ? `Execute live Stripe Connect transfer of ${usd(c.commissionOwed)} to ${c.code} (${destinationLabel})?`
          : `Record ${method.toUpperCase()} payout of ${usd(c.commissionOwed)} to ${c.code} (${destinationLabel})?`
      )
    ) {
      return;
    }

    setPayoutBusyCode(c.code);
    setNotice("");
    try {
      const res = await fetch("/api/influencers", {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({
          action: "payout",
          code: c.code,
          amount: c.commissionOwed,
          payoutMethod: method,
          executeStripeTransfer: hasConnect,
          destination: c.payoutHandle || c.payoutEmail || undefined,
          note: hasConnect ? "Admin Stripe Connect payout" : `Admin ${method} payout`,
        }),
      });
      const data = await res.json();
      applySnapshot(res.status, data);
      if (res.ok && data.ok && data.payout) {
        setNotice(
          `Paid ${usd(data.payout.amount)} to ${c.code} (${data.payout.stripeTransferId || data.payout.method}).`
        );
      }
    } finally {
      setPayoutBusyCode(null);
    }
  };

  const resetAll = async () => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Reset click, trial, and test counters across all creators? (Completed payout history is preserved.)"
      )
    ) {
      return;
    }
    const res = await fetch("/api/influencers", {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ action: "reset" }),
    });
    applySnapshot(res.status, await res.json());
  };

  const proj = projectOutreach(outreach);
  const perAnnualPayout = commissionFor("annual", newPct);

  const cardContent = (
    <div
      className="modal-card influencer-modal"
      style={standalone ? { maxWidth: 1020, width: "100%", margin: "0 auto" } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="modal-head">
        <div className="yuka-topbar-left">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/broc-mascot.png" alt="Broc" className="yuka-topbar-mascot" />
          <div>
            <span className="eyebrow eyebrow--green">
              Influencer Affiliate Ledger, Stripe Payouts &amp; 1,000-Creator Math
            </span>
            <h2>Influencer Engine</h2>
          </div>
        </div>
        {onClose && (
          <button
            className="close"
            onClick={onClose}
            aria-label="Close Influencer Engine"
          >
            ×
          </button>
        )}
      </div>

      {/* LIVE KPI STRIP */}
      <div className="kpi-grid">
        <div className="kpi-box">
          <span>Clicks</span>
          <strong>{totals.clicks}</strong>
        </div>
        <div className="kpi-box">
          <span>7-Day Trials</span>
          <strong>{totals.trials}</strong>
        </div>
        <div className="kpi-box">
          <span>Paid Subscriptions</span>
          <strong>{totals.paidAnnual + totals.paidMonthly}</strong>
        </div>
        <div className="kpi-box kpi-box--warn">
          <span>Commission Owed</span>
          <strong>{usd(totals.commissionOwed)}</strong>
        </div>
        <div className="kpi-box">
          <span>Paid Out to Creators</span>
          <strong>{usd(totals.commissionPaid ?? 0)}</strong>
        </div>
        <div className="kpi-box kpi-box--brand">
          <span>My Net Revenue</span>
          <strong>{usd(totals.netRevenue)}</strong>
        </div>
      </div>

      {/* CREATE CREATOR CODE */}
      <form className="creator-create-form" onSubmit={handleCreate}>
        <div className="form-field">
          <label htmlFor="new-creator-code">Creator Code</label>
          <input
            id="new-creator-code"
            type="text"
            placeholder="e.g. SARAHHAULS, PARENTMAXX"
            value={newCode}
            onChange={(e) => setNewCode(e.target.value.toUpperCase())}
          />
        </div>
        <div className="form-field">
          <label htmlFor="new-creator-name">Creator Handle / Name</label>
          <input
            id="new-creator-name"
            type="text"
            placeholder="Optional display name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
        </div>
        <div className="form-field form-field--short">
          <label htmlFor="new-creator-pct">
            Split % ({usd(perAnnualPayout)}/yr)
          </label>
          <input
            id="new-creator-pct"
            type="number"
            min={5}
            max={80}
            step={1}
            value={newPct}
            onChange={(e) => setNewPct(Number(e.target.value) || 0)}
          />
        </div>
        <button
          id="create-creator-submit"
          type="submit"
          className="swap-btn"
          disabled={busy || !newCode.trim()}
        >
          + Add Code
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {notice && (
        <p style={{ color: "#0f7a4a", fontWeight: 700, fontSize: 13, margin: "6px 0" }}>
          ✓ {notice}
        </p>
      )}

      {/* LIVE CREATOR TABLE */}
      <div className="table-wrap">
        <table className="creator-table">
          <thead>
            <tr>
              <th>Code &amp; Payout</th>
              <th>Split</th>
              <th>Clicks</th>
              <th>Trials</th>
              <th>Paid Subs</th>
              <th>Paid Out</th>
              <th>Owed</th>
              <th>My Net Rev</th>
              <th>Actions / Payout</th>
            </tr>
          </thead>
          <tbody>
            {creators.map((c) => {
              const payoutPerSub = commissionFor("annual", c.commissionPct);
              const isActive = c.active !== false;
              return (
                <tr key={c.code} style={!isActive ? { opacity: 0.6 } : undefined}>
                  <td>
                    <b className="code-pill">{c.code}</b>
                    <small className="creator-sub">{c.name}</small>
                    {(c.stripeConnectAccountId || c.payoutHandle || c.payoutEmail) && (
                      <small
                        className="creator-sub"
                        style={{ display: "block", color: "#0f7a4a" }}
                      >
                        {c.stripeConnectAccountId
                          ? `⚡ Stripe: ${c.stripeConnectAccountId.slice(0, 12)}…`
                          : `${(c.payoutMethod || "payout").toUpperCase()}: ${c.payoutHandle || c.payoutEmail}`}
                      </small>
                    )}
                  </td>
                  <td>
                    <div className="split-cell">
                      <input
                        type="number"
                        min={0}
                        max={80}
                        value={c.commissionPct}
                        aria-label={`${c.code} commission percent`}
                        onChange={(e) =>
                          updateSplit(c.code, Number(e.target.value) || 0)
                        }
                      />
                      <span>%</span>
                    </div>
                    <small className="creator-sub">{usd(payoutPerSub)} / yr sub</small>
                  </td>
                  <td>{c.clicks}</td>
                  <td>{c.trials}</td>
                  <td>
                    {c.paidAnnual}
                    {c.paidMonthly ? (
                      <small className="creator-sub">+{c.paidMonthly} mo</small>
                    ) : null}
                  </td>
                  <td>{usd(c.commissionPaid ?? 0)}</td>
                  <td className="num-warn">{usd(c.commissionOwed)}</td>
                  <td className="num-brand">{usd(c.netRevenue)}</td>
                  <td>
                    <div className="row-actions" style={{ flexWrap: "wrap" }}>
                      {c.commissionOwed > 0 && (
                        <button
                          type="button"
                          className="mini-action mini-action--green"
                          disabled={payoutBusyCode === c.code}
                          title={
                            c.stripeConnectAccountId
                              ? "Execute live Stripe Connect payout"
                              : "Record creator payout"
                          }
                          onClick={() => handlePayCreator(c)}
                        >
                          {payoutBusyCode === c.code
                            ? "Paying…"
                            : c.stripeConnectAccountId
                              ? `⚡ Pay ${usd(c.commissionOwed)}`
                              : `Pay ${usd(c.commissionOwed)}`}
                        </button>
                      )}
                      <button
                        type="button"
                        className="mini-action"
                        title="Simulate full Paywall checkout with this code"
                        onClick={() => quickEvent(c.code, "checkout_annual")}
                      >
                        +$49.99 Test
                      </button>
                      <button
                        type="button"
                        className="mini-action"
                        onClick={() => toggleActive(c.code, !isActive)}
                      >
                        {isActive ? "Pause" : "Enable"}
                      </button>
                      {onSelectCodeForPaywall && (
                        <button
                          type="button"
                          className="mini-action"
                          onClick={() => onSelectCodeForPaywall(c.code)}
                        >
                          Paywall ↗
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="table-foot">
        <span>
          Default split: <b>35% = {usd(commissionFor("annual", 35))}</b> creator
          payout + <b>{usd(PRICING.annual - commissionFor("annual", 35))}</b> net
          to you per $49.99 annual conversion.
        </span>
        <button type="button" className="link-btn" onClick={resetAll}>
          Reset test counters
        </button>
      </div>

      {recentPayouts.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <strong style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
            Recent Creator Payout Ledger
          </strong>
          <table className="creator-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Creator</th>
                <th>Amount</th>
                <th>Method</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {recentPayouts.slice(0, 10).map((p) => (
                <tr key={p.id}>
                  <td>{new Date(p.createdAt).toLocaleDateString()}</td>
                  <td>
                    <b className="code-pill">{p.code}</b>
                  </td>
                  <td className="num-brand">{usd(p.amount)}</td>
                  <td>{p.method.replace("_", " ").toUpperCase()}</td>
                  <td>{p.stripeTransferId || p.destination || p.note || "Paid"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 1,000-INFLUENCER OUTREACH PROJECTION CALCULATOR */}
      <div className="outreach-calc">
        <div className="card-head">
          <h2>1,000-Influencer Outreach Math Simulator</h2>
          <span className="hint">
            Adjust assumptions to model annual recurring revenue
          </span>
        </div>
        <div className="outreach-inputs">
          <label>
            <span>Active Creators</span>
            <input
              type="number"
              min={1}
              max={10000}
              value={outreach.creators}
              onChange={(e) =>
                setOutreach({
                  ...outreach,
                  creators: Number(e.target.value) || 0,
                })
              }
            />
          </label>
          <label>
            <span>Clicks / Creator</span>
            <input
              type="number"
              min={10}
              max={50000}
              value={outreach.clicksPerCreator}
              onChange={(e) =>
                setOutreach({
                  ...outreach,
                  clicksPerCreator: Number(e.target.value) || 0,
                })
              }
            />
          </label>
          <label>
            <span>Click → 7-Day Trial %</span>
            <input
              type="number"
              min={1}
              max={100}
              value={outreach.trialRatePct}
              onChange={(e) =>
                setOutreach({
                  ...outreach,
                  trialRatePct: Number(e.target.value) || 0,
                })
              }
            />
          </label>
          <label>
            <span>Trial → Paid Annual %</span>
            <input
              type="number"
              min={1}
              max={100}
              value={outreach.trialToPaidPct}
              onChange={(e) =>
                setOutreach({
                  ...outreach,
                  trialToPaidPct: Number(e.target.value) || 0,
                })
              }
            />
          </label>
          <label>
            <span>Creator Split %</span>
            <input
              type="number"
              min={0}
              max={80}
              value={outreach.commissionPct}
              onChange={(e) =>
                setOutreach({
                  ...outreach,
                  commissionPct: Number(e.target.value) || 0,
                })
              }
            />
          </label>
        </div>
        <div className="outreach-results">
          <div>
            <span>Total Clicks</span>
            <b>{proj.clicks.toLocaleString()}</b>
          </div>
          <div>
            <span>7-Day Trials</span>
            <b>{proj.trials.toLocaleString()}</b>
          </div>
          <div>
            <span>Paid Annual Subs</span>
            <b>{proj.paid.toLocaleString()}</b>
          </div>
          <div>
            <span>Gross ARR</span>
            <b>{usd(proj.gross)}</b>
          </div>
          <div>
            <span>Creator Payouts ({outreach.commissionPct}%)</span>
            <b className="num-warn">{usd(proj.commission)}</b>
          </div>
          <div>
            <span>Your Net ARR</span>
            <b className="num-brand">{usd(proj.net)}</b>
          </div>
        </div>
      </div>
    </div>
  );

  if (standalone) {
    return cardContent;
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Influencer Affiliate Engine"
      onClick={onClose}
    >
      {cardContent}
    </div>
  );
}
