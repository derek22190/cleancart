"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";

export default function ReferralLandingPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = use(params);
  const cleanCode = decodeURIComponent(code || "BROC-FRIEND")
    .trim()
    .toUpperCase();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem("heybroc_referred_by", cleanCode);
      if (!cleanCode.startsWith("BROC-")) {
        localStorage.setItem(
          "cleancart_creator_v1",
          JSON.stringify({ code: cleanCode, name: cleanCode }),
        );
        void fetch("/api/influencers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "track", code: cleanCode, event: "click" }),
        }).catch(() => {});
      }
    } catch {
      /* ignore storage errors */
    }
  }, [cleanCode]);

  const copyAndDownload = async () => {
    try {
      await navigator.clipboard.writeText(cleanCode);
      setCopied(true);
    } catch {
      setCopied(true);
    }
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f4f3ee",
        color: "#15201b",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: 460,
          width: "100%",
          background: "#ffffff",
          borderRadius: 28,
          padding: "32px 24px",
          boxShadow: "0 20px 50px rgba(15, 28, 22, 0.10)",
          border: "1px solid rgba(15, 122, 74, 0.14)",
          textAlign: "center",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/broc-mascot.jpg"
          alt="HeyBroc mascot"
          style={{
            width: 88,
            height: 88,
            objectFit: "contain",
            margin: "0 auto 12px",
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
            marginBottom: 12,
          }}
        >
          🎁 FRIEND INVITE · +7 FREE PRO DAYS
        </span>
        <h1
          style={{
            fontSize: 26,
            lineHeight: 1.2,
            fontWeight: 800,
            margin: "0 0 10px",
          }}
        >
          Your friend gifted you 7 Free Days of HeyBroc Pro!
        </h1>
        <p
          style={{
            fontSize: 15,
            lineHeight: 1.5,
            color: "#4a5550",
            margin: "0 0 20px",
          }}
        >
          HeyBroc floats over <b>Walmart, Target, Costco, Sam&apos;s Club, BJ&apos;s, Amazon Fresh, Instacart, ALDI &amp; more</b> on
          your phone to grade food &amp; beverage ingredients (0–100) and swap flagged
          items for clean 1-for-1 alternatives in 1 tap. Start a free trial with this code to unlock +7 Free Pro Days!
        </p>

        <div
          style={{
            background: "#f8faf9",
            border: "1.5px dashed #0f7a4a",
            borderRadius: 16,
            padding: "14px 16px",
            marginBottom: 20,
          }}
        >
          <div style={{ fontSize: 12, color: "#68746e", fontWeight: 700 }}>
            YOUR INVITE CODE (AUTO-COPIED ON DOWNLOAD)
          </div>
          <div
            style={{
              fontSize: 24,
              fontWeight: 900,
              color: "#0f7a4a",
              letterSpacing: "0.06em",
              marginTop: 4,
            }}
          >
            {cleanCode}
          </div>
          <button
            type="button"
            onClick={copyAndDownload}
            style={{
              marginTop: 8,
              background: copied ? "#16a34a" : "#e6f5ec",
              color: copied ? "#ffffff" : "#0f7a4a",
              border: "none",
              borderRadius: 999,
              padding: "6px 16px",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {copied ? "✓ Code Copied to Clipboard!" : "Copy Invite Code"}
          </button>
        </div>

        <a
          href="/heybroc.apk"
          download
          onClick={copyAndDownload}
          style={{
            display: "block",
            background: "#0f7a4a",
            color: "#ffffff",
            textDecoration: "none",
            fontWeight: 800,
            fontSize: 16,
            padding: "15px 20px",
            borderRadius: 999,
            marginBottom: 12,
            boxShadow: "0 8px 20px rgba(15, 122, 74, 0.25)",
          }}
        >
          🤖 Download HeyBroc for Android (.APK)
        </a>

        <Link
          href={`/?ref=${encodeURIComponent(cleanCode)}`}
          onClick={copyAndDownload}
          style={{
            display: "block",
            background: "#f4f3ee",
            color: "#15201b",
            textDecoration: "none",
            fontWeight: 700,
            fontSize: 14,
            padding: "13px 20px",
            borderRadius: 999,
          }}
        >
          Open Web App &amp; Claim 7 Free Days →
        </Link>

        <p
          style={{
            fontSize: 12.5,
            color: "#68746e",
            marginTop: 18,
            lineHeight: 1.45,
          }}
        >
          <b>How it works:</b> Install HeyBroc, enable the store screen reader, and view
          any item in Walmart or Target on your phone. Both you and your friend
          automatically unlock <b>+7 Free Days of HeyBroc Pro</b>!
        </p>
        <p
          style={{
            fontSize: 11,
            color: "#828e88",
            marginTop: 12,
            lineHeight: 1.4,
          }}
        >
          Independent consumer tool. Not affiliated with, endorsed by, or sponsored by Walmart, Target, Costco, Sam&apos;s Club, BJ&apos;s, Amazon, Instacart, ALDI, or any manufacturer.
        </p>
      </div>
    </main>
  );
}
