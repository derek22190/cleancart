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
  const isFriendInvite = /^BROC-[A-Z0-9]{4,10}$/.test(cleanCode);
  const [copied, setCopied] = useState(false);
  const [creatorName, setCreatorName] = useState<string | null>(null);
  const [creatorNotFound, setCreatorNotFound] = useState(false);

  useEffect(() => {
    try {
      if (isFriendInvite) {
        localStorage.setItem("heybroc_referred_by", cleanCode);
        return;
      }
      let cancelled = false;
      fetch(`/api/influencers?code=${encodeURIComponent(cleanCode)}`)
        .then((r) => r.json())
        .then((data) => {
          if (cancelled) return;
          if (data?.ok && data?.creator?.code) {
            setCreatorNotFound(false);
            setCreatorName(data.creator.name || data.creator.code);
            localStorage.setItem(
              "cleancart_creator_v1",
              JSON.stringify({
                code: data.creator.code,
                name: data.creator.name || data.creator.code,
              }),
            );
            void fetch("/api/influencers", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "track",
                code: data.creator.code,
                event: "click",
              }),
            }).catch(() => {});
          } else {
            setCreatorNotFound(true);
            localStorage.removeItem("cleancart_creator_v1");
          }
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    } catch {
      /* ignore storage errors */
    }
  }, [cleanCode, isFriendInvite]);

  const copyAndDownload = async () => {
    if (creatorNotFound) return;
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
          {isFriendInvite
            ? "🎁 FRIEND INVITE · +7 FREE PRO DAYS"
            : creatorNotFound
              ? "🥦 HEYBROC FAMILY PRO · 7-DAY FREE TRIAL"
              : "🎉 CREATOR PARTNER · 14-DAY FREE PRO TRIAL"}
        </span>
        <h1
          style={{
            fontSize: 26,
            lineHeight: 1.2,
            fontWeight: 800,
            margin: "0 0 10px",
          }}
        >
          {isFriendInvite
            ? "Your friend gifted you 7 Free Days of HeyBroc Pro!"
            : creatorNotFound
              ? "Try HeyBroc Family Pro Free for 7 Days"
              : `${creatorName ? `${creatorName} unlocked` : "You unlocked"} a 14-Day Free Trial of HeyBroc Pro!`}
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
          items for clean 1-for-1 alternatives in 1 tap.{" "}
          {isFriendInvite
            ? "Start a free trial with this code to unlock +7 Free Pro Days!"
            : creatorNotFound
              ? `Code "${cleanCode}" was not recognized, so you can continue with our standard 7-day free trial below.`
              : "Use this creator code at checkout to double your free trial from 7 days to 14 days!"}
        </p>

        {!creatorNotFound && (
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
              {isFriendInvite
                ? "YOUR INVITE CODE (AUTO-COPIED ON DOWNLOAD)"
                : "CREATOR PROMO CODE (14-DAY EXTENDED TRIAL)"}
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
              {copied ? "✓ Code Copied to Clipboard!" : "Copy Code"}
            </button>
          </div>
        )}

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
          href={
            isFriendInvite
              ? `/?ref=${encodeURIComponent(cleanCode)}`
              : creatorNotFound
                ? `/?upgrade=1`
                : `/?code=${encodeURIComponent(cleanCode)}&upgrade=1`
          }
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
          {isFriendInvite
            ? "Open Web App & Claim 7 Free Days →"
            : "Claim 14-Day Free Pro Trial on Web →"}
        </Link>

        {!isFriendInvite && (
          <Link
            href={`/?code=${encodeURIComponent(cleanCode)}`}
            onClick={copyAndDownload}
            style={{
              display: "inline-block",
              marginTop: 10,
              color: "#0f7a4a",
              fontWeight: 700,
              fontSize: 13,
              textDecoration: "underline",
            }}
          >
            Or try the free web ingredient scanner first →
          </Link>
        )}

        <p
          style={{
            fontSize: 12.5,
            color: "#68746e",
            marginTop: 18,
            lineHeight: 1.45,
          }}
        >
          {isFriendInvite ? (
            <>
              <b>How it works:</b> Install HeyBroc, enable the store screen reader, and view
              any item in Walmart or Target on your phone. Both you and your friend
              automatically unlock <b>+7 Free Days of HeyBroc Pro</b>!
            </>
          ) : (
            <>
              <b>How it works:</b> Code <b>{cleanCode}</b> is automatically applied on web
              checkout (or paste it inside the app) to unlock a <b>14-Day Free Pro Trial</b>{" "}
              with unlimited 1-tap Clean Swaps across all 12 stores.
            </>
          )}
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
