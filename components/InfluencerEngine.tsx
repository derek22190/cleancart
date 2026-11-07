"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PRICING,
  commissionFor,
  projectOutreach,
  usd,
  type OutreachInputs,
} from "@/lib/pricing";

export interface CreatorRow {
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

export interface CreatorTotals {
  clicks: number;
  trials: number;
  paidAnnual: number;
  paidMonthly: number;
  grossRevenue: number;
  commissionOwed: number;
  netRevenue: number;
}

interface InfluencerEngineProps {
  open: boolean;
  onClose: () => void;
  refreshKey: number;
  onSelectCodeForPaywall: (code: string) => void;
}

export default function InfluencerEngine({
  open,
  onClose,
  refreshKey,
  onSelectCodeForPaywall,
}: InfluencerEngineProps) {
  const [creators, setCreators] = useState<CreatorRow[]>([]);
  const [totals, setTotals] = useState<CreatorTotals>({
    clicks: 0,
    trials: 0,
    paidAnnual: 0,
    paidMonthly: 0,
    grossRevenue: 0,
    commissionOwed: 0,
    netRevenue: 0,
  });
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newPct, setNewPct] = useState<number>(PRICING.defaultCommissionPct);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 1,000-Influencer Outreach Math Calculator state
  const [outreach, setOutreach] = useState<OutreachInputs>({
    creators: 1000,
    clicksPerCreator: 250,
    trialRatePct: 12,
    trialToPaidPct: 45,
    commissionPct: PRICING.defaultCommissionPct,
  });

  const loadSnapshot = useCallback(async () => {
    try {
      const res = await fetch("/api/influencers");
      const data = await res.json();
      if (data.ok) {
        setCreators(data.creators || []);
        if (data.totals) setTotals(data.totals);
      }
    } catch {
      /* ignore transient fetch errors */
    }
  }, []);

  useEffect(() => {
    if (open) loadSnapshot();
  }, [open, refreshKey, loadSnapshot]);

  if (!open) return null;

  const applySnapshot = (data: { ok?: boolean; creators?: CreatorRow[]; totals?: CreatorTotals; error?: string }) => {
    if (!data.ok) {
      setError(data.error || "Operation failed.");
      return;
    }
    setError("");
    if (data.creators) setCreators(data.creators);
    if (data.totals) setTotals(data.totals);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCode.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/influencers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          code: newCode.trim().toUpperCase(),
          name: newName.trim() || undefined,
          commissionPct: newPct,
        }),
      });
      const data = await res.json();
      applySnapshot(data);
      if (data.ok) {
        setNewCode("");
        setNewName("");
      }
    } finally {
      setBusy(false);
    }
  };

  const quickEvent = async (code: string, event: "click" | "trial" | "paid_annual" | "checkout_annual") => {
    const res = await fetch("/api/influencers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "track", code, event }),
    });
    applySnapshot(await res.json());
  };

  const updateSplit = async (code: string, commissionPct: number) => {
    const res = await fetch("/api/influencers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", code, commissionPct }),
    });
    applySnapshot(await res.json());
  };

  const resetAll = async () => {
    const res = await fetch("/api/influencers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    });
    applySnapshot(await res.json());
  };

  const proj = projectOutreach(outreach);
  const perAnnualPayout = commissionFor("annual", newPct);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Influencer Affiliate Engine" onClick={onClose}>
      <div className="modal-card influencer-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="yuka-topbar-left">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/broc-mascot.jpg" alt="Broc" className="yuka-topbar-mascot" />
            <div>
              <span className="eyebrow eyebrow--green">Influencer Affiliate Tracker &amp; 1,000-Creator Math</span>
              <h2>Influencer Engine</h2>
            </div>
          </div>
          <button className="close" onClick={onClose} aria-label="Close Influencer Engine">×</button>
        </div>

        {/* LIVE KPI STRIP */}
        <div className="kpi-grid">
          <div className="kpi-box">
            <span>Clicks</span>
            <strong>{totals.clicks}</strong>
          </div>
          <div className="kpi-box">
            <span>Free Trials Started</span>
            <strong>{totals.trials}</strong>
          </div>
          <div className="kpi-box">
            <span>Paid Annual ($49.99)</span>
            <strong>{totals.paidAnnual}</strong>
          </div>
          <div className="kpi-box kpi-box--warn">
            <span>Creator Commission Owed</span>
            <strong>{usd(totals.commissionOwed)}</strong>
          </div>
          <div className="kpi-box kpi-box--brand">
            <span>My Net Revenue</span>
            <strong>{usd(totals.netRevenue)}</strong>
          </div>
        </div>

        {/* CREATE TEST CREATOR CODE */}
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
          <button id="create-creator-submit" type="submit" className="swap-btn" disabled={busy || !newCode.trim()}>
            + Add Code
          </button>
        </form>
        {error && <p className="error">{error}</p>}

        {/* LIVE CREATOR TABLE */}
        <div className="table-wrap">
          <table className="creator-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Split</th>
                <th>Clicks</th>
                <th>Trials</th>
                <th>Paid ($49.99)</th>
                <th>Creator Owed</th>
                <th>My Net Rev</th>
                <th>Simulate / Test</th>
              </tr>
            </thead>
            <tbody>
              {creators.map((c) => {
                const payoutPerSub = commissionFor("annual", c.commissionPct);
                return (
                  <tr key={c.code}>
                    <td>
                      <b className="code-pill">{c.code}</b>
                      <small className="creator-sub">{c.name}</small>
                    </td>
                    <td>
                      <div className="split-cell">
                        <input
                          type="number"
                          min={0}
                          max={80}
                          value={c.commissionPct}
                          aria-label={`${c.code} commission percent`}
                          onChange={(e) => updateSplit(c.code, Number(e.target.value) || 0)}
                        />
                        <span>%</span>
                      </div>
                      <small className="creator-sub">{usd(payoutPerSub)} / yr sub</small>
                    </td>
                    <td>{c.clicks}</td>
                    <td>{c.trials}</td>
                    <td>{c.paidAnnual}</td>
                    <td className="num-warn">{usd(c.commissionOwed)}</td>
                    <td className="num-brand">{usd(c.netRevenue)}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="mini-action mini-action--green"
                          title="Simulate full Paywall checkout with this code"
                          onClick={() => quickEvent(c.code, "checkout_annual")}
                        >
                          +$49.99 Checkout
                        </button>
                        <button
                          type="button"
                          className="mini-action"
                          onClick={() => onSelectCodeForPaywall(c.code)}
                        >
                          Test in Paywall ↗
                        </button>
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
            Default split: <b>35% = {usd(commissionFor("annual", 35))}</b> creator payout +{" "}
            <b>{usd(PRICING.annual - commissionFor("annual", 35))}</b> net to you per $49.99 annual conversion.
          </span>
          <button type="button" className="link-btn" onClick={resetAll}>
            Reset test counters
          </button>
        </div>

        {/* 1,000-INFLUENCER OUTREACH PROJECTION CALCULATOR */}
        <div className="outreach-calc">
          <div className="card-head">
            <h2>1,000-Influencer Outreach Math Simulator</h2>
            <span className="hint">Adjust assumptions to model annual recurring revenue</span>
          </div>
          <div className="outreach-inputs">
            <label>
              <span>Active Creators</span>
              <input
                type="number"
                min={1}
                max={10000}
                value={outreach.creators}
                onChange={(e) => setOutreach({ ...outreach, creators: Number(e.target.value) || 0 })}
              />
            </label>
            <label>
              <span>Clicks / Creator</span>
              <input
                type="number"
                min={10}
                max={50000}
                value={outreach.clicksPerCreator}
                onChange={(e) => setOutreach({ ...outreach, clicksPerCreator: Number(e.target.value) || 0 })}
              />
            </label>
            <label>
              <span>Click → 7-Day Trial %</span>
              <input
                type="number"
                min={1}
                max={100}
                value={outreach.trialRatePct}
                onChange={(e) => setOutreach({ ...outreach, trialRatePct: Number(e.target.value) || 0 })}
              />
            </label>
            <label>
              <span>Trial → Paid Annual %</span>
              <input
                type="number"
                min={1}
                max={100}
                value={outreach.trialToPaidPct}
                onChange={(e) => setOutreach({ ...outreach, trialToPaidPct: Number(e.target.value) || 0 })}
              />
            </label>
            <label>
              <span>Creator Split %</span>
              <input
                type="number"
                min={0}
                max={80}
                value={outreach.commissionPct}
                onChange={(e) => setOutreach({ ...outreach, commissionPct: Number(e.target.value) || 0 })}
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
    </div>
  );
}
