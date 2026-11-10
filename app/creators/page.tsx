"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PRICING, commissionFor, usd } from "@/lib/pricing";

interface CreatorSummary {
  code: string;
  name: string;
  commissionPct: number;
  clicks: number;
  trials: number;
  paidAnnual: number;
  paidMonthly: number;
  commissionOwed: number;
}

const STORAGE_KEY = "heybroc_self_creator_code_v1";

export default function SelfServeCreatorsPage() {
  const [handle, setHandle] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creator, setCreator] = useState<CreatorSummary | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  const annualPayout = commissionFor("annual", creator?.commissionPct ?? PRICING.defaultCommissionPct);
  const monthlyPayout = commissionFor("monthly", creator?.commissionPct ?? PRICING.defaultCommissionPct);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        setCodeInput(saved);
        void fetch(`/api/influencers?code=${encodeURIComponent(saved)}`)
          .then((r) => r.json())
          .then((d) => {
            if (d?.ok && d.creator) setCreator(d.creator);
          })
          .catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }, []);

  const handleCreateOrLoad = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCode = codeInput.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 24);
    if (cleanCode.length < 3) {
      setError("Enter a code with at least 3 letters or numbers (e.g. SARAHHAULS).");
      return;
    }
    if (cleanCode.startsWith("BROC")) {
      setError("Codes starting with BROC are reserved for friend invite codes. Choose your own creator handle (e.g. SARAHHAULS).");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/influencers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "self_register",
          code: cleanCode,
          name: handle.trim() || cleanCode,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok || !data.creator) {
        setError(data?.error || "Could not create your code. Try another code.");
        return;
      }
      setCreator(data.creator);
      setCodeInput(data.creator.code);
      try {
        localStorage.setItem(STORAGE_KEY, data.creator.code);
      } catch {
        /* ignore */
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
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
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
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
            Earn <b>{usd(annualPayout)} ({PRICING.defaultCommissionPct}%)</b> on every annual Pro signup across{" "}
            <b>iPhone (App Store), Android (Google Play), and Web</b> — plus give your followers a{" "}
            <b>14-Day Free Pro Trial</b> (double the normal 7-day trial).
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
                2. Choose Your Custom Code (Or Enter Existing Code to Check Stats)
              </label>
              <input
                type="text"
                value={codeInput}
                onChange={(e) => {
                  setCodeInput(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""));
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
              {busy ? "Generating Your Link..." : "⚡ Create / View My Creator Code →"}
            </button>
          </form>
        </div>

        {/* Live Creator Link + Stats Card */}
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
                <div style={{ fontSize: 12, fontWeight: 800, color: "#0f7a4a", letterSpacing: "0.06em" }}>
                  ✅ ACTIVE CREATOR ACCOUNT
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

            {/* Live Stats Grid */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
                gap: 10,
              }}
            >
              <div style={{ background: "#f4f3ee", padding: "12px", borderRadius: 14, textAlign: "center" }}>
                <div style={{ fontSize: 11.5, color: "#68746e", fontWeight: 700 }}>LINK CLICKS</div>
                <div style={{ fontSize: 22, fontWeight: 900, marginTop: 2 }}>{creator.clicks}</div>
              </div>
              <div style={{ background: "#f4f3ee", padding: "12px", borderRadius: 14, textAlign: "center" }}>
                <div style={{ fontSize: 11.5, color: "#68746e", fontWeight: 700 }}>14-DAY TRIALS</div>
                <div style={{ fontSize: 22, fontWeight: 900, marginTop: 2 }}>{creator.trials}</div>
              </div>
              <div style={{ background: "#f4f3ee", padding: "12px", borderRadius: 14, textAlign: "center" }}>
                <div style={{ fontSize: 11.5, color: "#68746e", fontWeight: 700 }}>PAID SUBS</div>
                <div style={{ fontSize: 22, fontWeight: 900, marginTop: 2 }}>
                  {creator.paidAnnual + creator.paidMonthly}
                </div>
              </div>
              <div style={{ background: "#e6f5ec", padding: "12px", borderRadius: 14, textAlign: "center" }}>
                <div style={{ fontSize: 11.5, color: "#0f7a4a", fontWeight: 800 }}>EARNINGS OWED</div>
                <div style={{ fontSize: 22, fontWeight: 900, color: "#0f7a4a", marginTop: 2 }}>
                  {usd(creator.commissionOwed)}
                </div>
              </div>
            </div>
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
          <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6, fontSize: 14.5, color: "#374151" }}>
            <li style={{ marginBottom: 8 }}>
              <b>&ldquo;Yuka for Online Grocery&rdquo;</b> — Screen-record your Walmart or Instacart cart while the live
              HeyBroc bubble flags hidden seed oils / Red 40 and swaps them to a 90+/100 clean brand in 1 tap.
            </li>
            <li style={{ marginBottom: 8 }}>
              <b>&ldquo;Rating My Kid&apos;s Favorite Snacks&rdquo;</b> — Show a Popular vs. Clean Swap side-by-side in
              HeyBroc (e.g. Hidden Valley Ranch 12/100 → Primal Kitchen Avocado Ranch 90/100).
            </li>
            <li>
              <b>Call to Action:</b>{" "}
              <i>
                &ldquo;Use my link in bio or code <b>{creator?.code || "YOURCODE"}</b> inside HeyBroc to get 14 days of
                Pro free!&rdquo;
              </i>{" "}
              (Earns {usd(annualPayout)} on annual or {usd(monthlyPayout)}/mo on monthly across Apple, Google Play &amp;
              Web.)
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
