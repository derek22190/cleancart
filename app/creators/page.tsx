"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PRICING, commissionFor, usd } from "@/lib/pricing";

type CreatorPayoutMethod =
  | "stripe_connect"
  | "paypal"
  | "venmo"
  | "zelle"
  | "manual";

interface CreatorSummary {
  code: string;
  name: string;
  active?: boolean;
  commissionPct: number;
  clicks?: number;
  trials?: number;
  paidAnnual?: number;
  paidMonthly?: number;
  commissionEarned?: number;
  commissionPaid?: number;
  commissionOwed?: number;
  payoutEmail?: string;
  payoutMethod?: CreatorPayoutMethod;
  payoutHandle?: string;
  stripeConnectAccountId?: string;
  lastPayoutAt?: string;
}

interface CreatorPayoutRecord {
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

const STORAGE_KEY = "heybroc_self_creator_code_v1";
const TOKEN_STORAGE_KEY = "heybroc_self_creator_token_v1";

export default function SelfServeCreatorsPage() {
  const [handle, setHandle] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [payoutEmail, setPayoutEmail] = useState("");
  const [payoutMethod, setPayoutMethod] =
    useState<CreatorPayoutMethod>("stripe_connect");
  const [payoutHandle, setPayoutHandle] = useState("");
  const [creatorToken, setCreatorToken] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [payouts, setPayouts] = useState<CreatorPayoutRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  const [error, setError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [creator, setCreator] = useState<CreatorSummary | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  const annualPayout = commissionFor(
    "annual",
    creator?.commissionPct ?? PRICING.defaultCommissionPct
  );
  const monthlyPayout = commissionFor(
    "monthly",
    creator?.commissionPct ?? PRICING.defaultCommissionPct
  );

  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const urlCode = sp.get("code")?.trim().toUpperCase() || "";
      const connectStatus = sp.get("connect");
      if (connectStatus === "complete") {
        setStatusMessage(
          "Stripe Express bank payout account connected! Direct transfers are ready."
        );
      } else if (connectStatus === "refresh") {
        setStatusMessage(
          "Complete Stripe Express onboarding below to finish linking your bank account."
        );
      }

      const savedCode = urlCode || localStorage.getItem(STORAGE_KEY) || "";
      const savedToken = localStorage.getItem(TOKEN_STORAGE_KEY) || "";
      if (savedToken) setCreatorToken(savedToken);
      if (savedCode) {
        setCodeInput(savedCode);
        void fetch(`/api/influencers?code=${encodeURIComponent(savedCode)}`, {
          headers: savedToken ? { "X-Creator-Token": savedToken } : undefined,
        })
          .then((r) => r.json())
          .then((d) => {
            if (d?.ok && d.creator) {
              setCreator(d.creator);
              setAuthenticated(Boolean(d.authenticated));
              setPayouts(Array.isArray(d.payouts) ? d.payouts : []);
              setHandle((prev) => prev || d.creator.name || d.creator.code);
              if (d.creator.payoutEmail) setPayoutEmail(d.creator.payoutEmail);
              if (d.creator.payoutMethod) setPayoutMethod(d.creator.payoutMethod);
              if (d.creator.payoutHandle) setPayoutHandle(d.creator.payoutHandle);
            }
          })
          .catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }, []);

  const handleCreateOrLoad = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCode = codeInput
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "")
      .slice(0, 24);
    if (cleanCode.length < 3) {
      setError(
        "Enter a code with at least 3 letters or numbers (e.g. SARAHHAULS)."
      );
      return;
    }
    if (cleanCode.startsWith("BROC")) {
      setError(
        "Codes starting with BROC are reserved for friend invite codes. Choose your own creator handle (e.g. SARAHHAULS)."
      );
      return;
    }
    setBusy(true);
    setError("");
    setStatusMessage("");
    try {
      const res = await fetch("/api/influencers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(creatorToken ? { "X-Creator-Token": creatorToken } : {}),
        },
        body: JSON.stringify({
          action: "self_register",
          code: cleanCode,
          name: handle.trim() || cleanCode,
          payoutEmail: payoutEmail.trim() || undefined,
          payoutMethod,
          payoutHandle: payoutHandle.trim() || undefined,
          creatorToken: creatorToken || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok || !data.creator) {
        setError(
          data?.error || "Could not create or unlock your code. Try another code."
        );
        return;
      }
      setCreator(data.creator);
      setAuthenticated(true);
      setPayouts(Array.isArray(data.payouts) ? data.payouts : []);
      setCodeInput(data.creator.code);
      if (data.creator.payoutEmail) setPayoutEmail(data.creator.payoutEmail);
      if (data.creator.payoutMethod) setPayoutMethod(data.creator.payoutMethod);
      if (data.creator.payoutHandle) setPayoutHandle(data.creator.payoutHandle);
      if (typeof data.creatorToken === "string" && data.creatorToken) {
        setCreatorToken(data.creatorToken);
        try {
          localStorage.setItem(TOKEN_STORAGE_KEY, data.creatorToken);
        } catch {
          /* ignore */
        }
      }
      try {
        localStorage.setItem(STORAGE_KEY, data.creator.code);
      } catch {
        /* ignore */
      }
      setStatusMessage(
        data.alreadyExisted
          ? "Creator dashboard unlocked and payout preferences updated."
          : "Creator code created! Copy your referral link below."
      );
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleSavePayoutSettings = async () => {
    if (!creator || !creatorToken) return;
    setPayoutBusy(true);
    setError("");
    setStatusMessage("");
    try {
      const res = await fetch("/api/influencers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Creator-Token": creatorToken,
        },
        body: JSON.stringify({
          action: "update_payout_settings",
          code: creator.code,
          creatorToken,
          name: handle.trim() || creator.name,
          payoutEmail: payoutEmail.trim() || undefined,
          payoutMethod,
          payoutHandle: payoutHandle.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok || !data.creator) {
        setError(data?.error || "Could not save payout settings.");
        return;
      }
      setCreator(data.creator);
      if (Array.isArray(data.payouts)) setPayouts(data.payouts);
      setStatusMessage("Payout settings saved!");
    } catch {
      setError("Network error saving payout settings.");
    } finally {
      setPayoutBusy(false);
    }
  };

  const handleConnectStripe = async () => {
    if (!creator || !creatorToken) return;
    setConnectBusy(true);
    setError("");
    setStatusMessage("");
    try {
      const res = await fetch("/api/influencers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Creator-Token": creatorToken,
        },
        body: JSON.stringify({
          action: "connect_stripe",
          code: creator.code,
          creatorToken,
          payoutEmail: payoutEmail.trim() || creator.payoutEmail || undefined,
          origin:
            typeof window !== "undefined"
              ? window.location.origin
              : "https://heybroc.com",
        }),
      });
      const data = await res.json();
      if (res.ok && data?.ok && data?.url) {
        window.location.href = data.url;
        return;
      }
      setError(
        data?.error ||
          "Stripe Connect Express onboarding is unavailable right now. Save your PayPal, Venmo, or Zelle handle below for direct payouts."
      );
    } catch {
      setError("Network error starting Stripe Connect onboarding.");
    } finally {
      setConnectBusy(false);
    }
  };

  const shareUrl = creator
    ? `https://heybroc.com/r/${encodeURIComponent(creator.code)}`
    : "https://heybroc.com/r/YOURCODE";

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f4f3ee",
        color: "#15201b",
        padding: "32px 16px 64px",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ maxWidth: 660, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/broc-mascot.jpg"
            alt="HeyBroc mascot"
            style={{
              width: 76,
              height: 76,
              objectFit: "contain",
              margin: "0 auto 10px",
              display: "block",
            }}
          />
          <span
            style={{
              display: "inline-block",
              background: "#e6f5ec",
              color: "#0f7a4a",
              fontWeight: 800,
              fontSize: 12,
              letterSpacing: "0.08em",
              padding: "6px 14px",
              borderRadius: 999,
              marginBottom: 10,
            }}
          >
            🥦 HEYBROC CREATOR &amp; AFFILIATE PORTAL
          </span>
          <h1
            style={{
              fontSize: 30,
              lineHeight: 1.15,
              fontWeight: 900,
              margin: "0 0 10px",
            }}
          >
            Claim Your Instant Creator Code in 10 Seconds
          </h1>
          <p
            style={{
              fontSize: 15.5,
              lineHeight: 1.5,
              color: "#4a5550",
              margin: 0,
            }}
          >
            Earn{" "}
            <b>
              {usd(annualPayout)} ({PRICING.defaultCommissionPct}%)
            </b>{" "}
            on every annual Pro signup across{" "}
            <b>iPhone (App Store), Android (Google Play), and Web</b> — plus give
            your followers a <b>14-Day Free Pro Trial</b> (double the normal
            7-day trial).
          </p>
        </div>

        {/* Self-Serve Generator Card */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: 24,
            padding: "24px",
            boxShadow: "0 16px 40px rgba(15, 28, 22, 0.08)",
            border: "1px solid rgba(15, 122, 74, 0.14)",
            marginBottom: 20,
          }}
        >
          <form onSubmit={handleCreateOrLoad}>
            <div style={{ marginBottom: 14 }}>
              <label
                style={{
                  display: "block",
                  fontSize: 12.5,
                  fontWeight: 800,
                  color: "#374151",
                  marginBottom: 6,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                1. Your Creator Name or @Handle
              </label>
              <input
                type="text"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="e.g. @sarahhauls or Sarah Grocery Hauls"
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  borderRadius: 12,
                  border: "1.5px solid #d1d5db",
                  fontSize: 15,
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label
                style={{
                  display: "block",
                  fontSize: 12.5,
                  fontWeight: 800,
                  color: "#374151",
                  marginBottom: 6,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                2. Choose Your Custom Code (Or Enter Existing Code)
              </label>
              <input
                type="text"
                value={codeInput}
                onChange={(e) => {
                  setCodeInput(
                    e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "")
                  );
                  setError("");
                }}
                placeholder="e.g. SARAHHAULS"
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  borderRadius: 12,
                  border: "1.5px solid #0f7a4a",
                  fontSize: 16,
                  fontWeight: 800,
                  letterSpacing: "0.06em",
                  color: "#0f7a4a",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label
                style={{
                  display: "block",
                  fontSize: 12.5,
                  fontWeight: 800,
                  color: "#374151",
                  marginBottom: 6,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                3. Payout Email (Protects Your Dashboard &amp; Receives Commission Alerts)
              </label>
              <input
                type="email"
                value={payoutEmail}
                onChange={(e) => setPayoutEmail(e.target.value)}
                placeholder="you@example.com"
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  borderRadius: 12,
                  border: "1.5px solid #d1d5db",
                  fontSize: 15,
                  boxSizing: "border-box",
                }}
              />
            </div>

            {error && (
              <div
                style={{
                  background: "#fef2f2",
                  color: "#991b1b",
                  padding: "10px 14px",
                  borderRadius: 10,
                  fontSize: 13.5,
                  fontWeight: 600,
                  marginBottom: 14,
                }}
              >
                {error}
              </div>
            )}

            {statusMessage && (
              <div
                style={{
                  background: "#ecfdf5",
                  color: "#065f46",
                  padding: "10px 14px",
                  borderRadius: 10,
                  fontSize: 13.5,
                  fontWeight: 600,
                  marginBottom: 14,
                }}
              >
                {statusMessage}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              style={{
                width: "100%",
                background: "#0f7a4a",
                color: "#ffffff",
                border: "none",
                borderRadius: 999,
                padding: "14px 20px",
                fontSize: 16,
                fontWeight: 800,
                cursor: busy ? "wait" : "pointer",
                boxShadow: "0 8px 20px rgba(15, 122, 74, 0.25)",
              }}
            >
              {busy
                ? "Generating Your Link..."
                : "⚡ Create / Unlock My Creator Dashboard →"}
            </button>
          </form>
        </div>

        {/* Live Creator Link + Stats + Payout Settings Card */}
        {creator && (
          <div
            style={{
              background: "#ffffff",
              borderRadius: 24,
              padding: "24px",
              boxShadow: "0 16px 40px rgba(15, 28, 22, 0.08)",
              border: "2px solid #0f7a4a",
              marginBottom: 20,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 8,
                marginBottom: 14,
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 800,
                    color: creator.active === false ? "#b91c1c" : "#0f7a4a",
                    letterSpacing: "0.06em",
                  }}
                >
                  {creator.active === false
                    ? "⏸ PAUSED CREATOR CODE"
                    : "✅ ACTIVE CREATOR ACCOUNT"}
                </div>
                <div style={{ fontSize: 20, fontWeight: 900 }}>{creator.name}</div>
              </div>
              <span
                style={{
                  background: "#e6f5ec",
                  color: "#0f7a4a",
                  fontWeight: 800,
                  fontSize: 13,
                  padding: "6px 12px",
                  borderRadius: 999,
                }}
              >
                {creator.commissionPct}% Commission ({usd(annualPayout)}/yr sub)
              </span>
            </div>

            <div
              style={{
                background: "#f8faf9",
                border: "1.5px dashed #0f7a4a",
                borderRadius: 16,
                padding: "14px 16px",
                marginBottom: 16,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: "#68746e" }}>
                YOUR BIO &amp; STORY LINK (TRACKS CLICKS + AUTO-APPLIES YOUR CODE)
              </div>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 800,
                  color: "#0f7a4a",
                  wordBreak: "break-all",
                  margin: "6px 0 10px",
                }}
              >
                {shareUrl}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(shareUrl);
                    setCopiedLink(true);
                    setTimeout(() => setCopiedLink(false), 2000);
                  }}
                  style={{
                    background: copiedLink ? "#16a34a" : "#0f7a4a",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: 999,
                    padding: "8px 16px",
                    fontSize: 13,
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  {copiedLink ? "✓ Link Copied!" : "Copy Share Link"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(creator.code);
                    setCopiedCode(true);
                    setTimeout(() => setCopiedCode(false), 2000);
                  }}
                  style={{
                    background: copiedCode ? "#16a34a" : "#e6f5ec",
                    color: copiedCode ? "#ffffff" : "#0f7a4a",
                    border: "none",
                    borderRadius: 999,
                    padding: "8px 16px",
                    fontSize: 13,
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  {copiedCode ? "✓ Code Copied!" : `Copy Code: ${creator.code}`}
                </button>
              </div>
            </div>

            {authenticated ? (
              <>
                {/* Live Stats Grid */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(112px, 1fr))",
                    gap: 10,
                    marginBottom: 18,
                  }}
                >
                  <div
                    style={{
                      background: "#f4f3ee",
                      padding: "12px",
                      borderRadius: 14,
                      textAlign: "center",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        color: "#68746e",
                        fontWeight: 700,
                      }}
                    >
                      LINK CLICKS
                    </div>
                    <div style={{ fontSize: 21, fontWeight: 900, marginTop: 2 }}>
                      {creator.clicks ?? 0}
                    </div>
                  </div>
                  <div
                    style={{
                      background: "#f4f3ee",
                      padding: "12px",
                      borderRadius: 14,
                      textAlign: "center",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        color: "#68746e",
                        fontWeight: 700,
                      }}
                    >
                      14-DAY TRIALS
                    </div>
                    <div style={{ fontSize: 21, fontWeight: 900, marginTop: 2 }}>
                      {creator.trials ?? 0}
                    </div>
                  </div>
                  <div
                    style={{
                      background: "#f4f3ee",
                      padding: "12px",
                      borderRadius: 14,
                      textAlign: "center",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        color: "#68746e",
                        fontWeight: 700,
                      }}
                    >
                      PAID SUBS
                    </div>
                    <div style={{ fontSize: 21, fontWeight: 900, marginTop: 2 }}>
                      {(creator.paidAnnual ?? 0) + (creator.paidMonthly ?? 0)}
                    </div>
                  </div>
                  <div
                    style={{
                      background: "#f4f3ee",
                      padding: "12px",
                      borderRadius: 14,
                      textAlign: "center",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        color: "#68746e",
                        fontWeight: 700,
                      }}
                    >
                      TOTAL EARNED
                    </div>
                    <div style={{ fontSize: 20, fontWeight: 900, marginTop: 2 }}>
                      {usd(creator.commissionEarned ?? creator.commissionOwed ?? 0)}
                    </div>
                  </div>
                  <div
                    style={{
                      background: "#f4f3ee",
                      padding: "12px",
                      borderRadius: 14,
                      textAlign: "center",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        color: "#68746e",
                        fontWeight: 700,
                      }}
                    >
                      PAID OUT
                    </div>
                    <div style={{ fontSize: 20, fontWeight: 900, marginTop: 2 }}>
                      {usd(creator.commissionPaid ?? 0)}
                    </div>
                  </div>
                  <div
                    style={{
                      background: "#e6f5ec",
                      padding: "12px",
                      borderRadius: 14,
                      textAlign: "center",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        color: "#0f7a4a",
                        fontWeight: 800,
                      }}
                    >
                      BALANCE OWED
                    </div>
                    <div
                      style={{
                        fontSize: 20,
                        fontWeight: 900,
                        color: "#0f7a4a",
                        marginTop: 2,
                      }}
                    >
                      {usd(creator.commissionOwed ?? 0)}
                    </div>
                  </div>
                </div>

                {/* Payout Method & Stripe Connect Express Section */}
                <div
                  style={{
                    background: "#f8faf9",
                    border: "1px solid #d1fae5",
                    borderRadius: 18,
                    padding: "16px",
                    marginBottom: payouts.length > 0 ? 18 : 0,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 10,
                      marginBottom: 12,
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontSize: 13.5,
                          fontWeight: 900,
                          color: "#0b4f30",
                        }}
                      >
                        💸 Creator Payout Method &amp; Stripe Express
                      </div>
                      <div style={{ fontSize: 12, color: "#4a5550" }}>
                        Connect your bank via Stripe Express for automated USD
                        transfers, or save PayPal / Venmo / Zelle.
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={connectBusy}
                      onClick={handleConnectStripe}
                      style={{
                        background: creator.stripeConnectAccountId
                          ? "#ecfdf5"
                          : "#635bff",
                        color: creator.stripeConnectAccountId
                          ? "#065f46"
                          : "#ffffff",
                        border: creator.stripeConnectAccountId
                          ? "1.5px solid #10b981"
                          : "none",
                        borderRadius: 999,
                        padding: "9px 15px",
                        fontSize: 12.5,
                        fontWeight: 800,
                        cursor: connectBusy ? "wait" : "pointer",
                      }}
                    >
                      {connectBusy
                        ? "Opening Stripe…"
                        : creator.stripeConnectAccountId
                          ? `✓ Stripe Connected (${creator.stripeConnectAccountId.slice(0, 12)}…)`
                          : "⚡ Connect Bank via Stripe Express"}
                    </button>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                      gap: 10,
                    }}
                  >
                    <div>
                      <label
                        style={{
                          display: "block",
                          fontSize: 11.5,
                          fontWeight: 700,
                          color: "#374151",
                          marginBottom: 4,
                        }}
                      >
                        Preferred Payout Method
                      </label>
                      <select
                        value={payoutMethod}
                        onChange={(e) =>
                          setPayoutMethod(e.target.value as CreatorPayoutMethod)
                        }
                        style={{
                          width: "100%",
                          padding: "9px 11px",
                          borderRadius: 10,
                          border: "1px solid #cbd5e1",
                          fontSize: 13.5,
                          background: "#ffffff",
                        }}
                      >
                        <option value="stripe_connect">
                          Stripe Express (Direct Bank)
                        </option>
                        <option value="paypal">PayPal</option>
                        <option value="venmo">Venmo</option>
                        <option value="zelle">Zelle</option>
                      </select>
                    </div>

                    <div>
                      <label
                        style={{
                          display: "block",
                          fontSize: 11.5,
                          fontWeight: 700,
                          color: "#374151",
                          marginBottom: 4,
                        }}
                      >
                        PayPal / Venmo / Zelle Handle
                      </label>
                      <input
                        type="text"
                        value={payoutHandle}
                        onChange={(e) => setPayoutHandle(e.target.value)}
                        placeholder="@venmo or PayPal email"
                        style={{
                          width: "100%",
                          padding: "9px 11px",
                          borderRadius: 10,
                          border: "1px solid #cbd5e1",
                          fontSize: 13.5,
                          boxSizing: "border-box",
                        }}
                      />
                    </div>
                  </div>

                  <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      disabled={payoutBusy}
                      onClick={handleSavePayoutSettings}
                      style={{
                        background: "#0f7a4a",
                        color: "#ffffff",
                        border: "none",
                        borderRadius: 999,
                        padding: "8px 16px",
                        fontSize: 12.5,
                        fontWeight: 800,
                        cursor: payoutBusy ? "wait" : "pointer",
                      }}
                    >
                      {payoutBusy ? "Saving…" : "Save Payout Settings"}
                    </button>
                  </div>
                </div>

                {/* Payout History Table */}
                {payouts.length > 0 && (
                  <div>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 900,
                        color: "#15201b",
                        marginBottom: 8,
                      }}
                    >
                      Recent Payout Receipts
                    </div>
                    <div style={{ overflowX: "auto" }}>
                      <table
                        style={{
                          width: "100%",
                          borderCollapse: "collapse",
                          fontSize: 12.5,
                        }}
                      >
                        <thead>
                          <tr
                            style={{
                              textAlign: "left",
                              borderBottom: "1px solid #e5e7eb",
                              color: "#6b7280",
                            }}
                          >
                            <th style={{ padding: "6px 8px" }}>Date</th>
                            <th style={{ padding: "6px 8px" }}>Amount</th>
                            <th style={{ padding: "6px 8px" }}>Method</th>
                            <th style={{ padding: "6px 8px" }}>Reference</th>
                          </tr>
                        </thead>
                        <tbody>
                          {payouts.map((p) => (
                            <tr
                              key={p.id}
                              style={{ borderBottom: "1px solid #f3f4f6" }}
                            >
                              <td style={{ padding: "7px 8px" }}>
                                {new Date(p.createdAt).toLocaleDateString()}
                              </td>
                              <td
                                style={{
                                  padding: "7px 8px",
                                  fontWeight: 800,
                                  color: "#0f7a4a",
                                }}
                              >
                                {usd(p.amount)}
                              </td>
                              <td style={{ padding: "7px 8px" }}>
                                {p.method.replace("_", " ").toUpperCase()}
                              </td>
                              <td style={{ padding: "7px 8px", color: "#4b5563" }}>
                                {p.stripeTransferId || p.destination || p.note || "Paid"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div
                style={{
                  background: "#fefce8",
                  border: "1px solid #fde047",
                  borderRadius: 14,
                  padding: "12px 14px",
                  fontSize: 13,
                  color: "#854d0e",
                }}
              >
                🔒 Private revenue &amp; payout stats are protected. Enter your
                registered payout email above and click{" "}
                <b>Create / Unlock My Creator Dashboard</b> to view live
                conversions and configure bank payouts.
              </div>
            )}
          </div>
        )}

        {/* How It Works Across Apple, Google Play & Web */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: 24,
            padding: "24px",
            boxShadow: "0 16px 40px rgba(15, 28, 22, 0.06)",
            border: "1px solid rgba(15, 122, 74, 0.12)",
          }}
        >
          <h2 style={{ fontSize: 19, fontWeight: 900, margin: "0 0 12px" }}>
            🎬 3 Viral 15-Second Video Hooks That Convert
          </h2>
          <ol
            style={{
              margin: 0,
              paddingLeft: 20,
              lineHeight: 1.6,
              fontSize: 14.5,
              color: "#374151",
            }}
          >
            <li style={{ marginBottom: 8 }}>
              <b>&ldquo;Yuka for Online Grocery&rdquo;</b> — Screen-record your
              Walmart or Instacart cart while the live HeyBroc bubble flags
              hidden seed oils / Red 40 and swaps them to a 90+/100 clean brand
              in 1 tap.
            </li>
            <li style={{ marginBottom: 8 }}>
              <b>&ldquo;Rating My Kid&apos;s Favorite Snacks&rdquo;</b> — Show a
              Popular vs. Clean Swap side-by-side in HeyBroc (e.g. Hidden Valley
              Ranch 12/100 → Primal Kitchen Avocado Ranch 90/100).
            </li>
            <li>
              <b>Call to Action:</b>{" "}
              <i>
                &ldquo;Use my link in bio or code{" "}
                <b>{creator?.code || "YOURCODE"}</b> inside HeyBroc to get 14
                days of Pro free!&rdquo;
              </i>{" "}
              (Earns {usd(annualPayout)} on annual or {usd(monthlyPayout)}/mo on
              monthly across Apple, Google Play &amp; Web.)
            </li>
          </ol>

          <div style={{ marginTop: 18, textAlign: "center" }}>
            <Link
              href="/"
              style={{
                color: "#0f7a4a",
                fontWeight: 800,
                fontSize: 14,
                textDecoration: "none",
              }}
            >
              ← Back to HeyBroc App
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
