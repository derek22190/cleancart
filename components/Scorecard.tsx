"use client";

import { useEffect, useRef, useState } from "react";
import { STORE_META, type Store } from "@/lib/swaps";

export interface SwapRecord {
  fromTitle: string;
  toTitle: string;
  toScore?: number;
  store: Store;
  dodged: string[];
}

interface ScorecardProps {
  open: boolean;
  onClose: () => void;
  store: Store;
  cartAvg: number;
  swaps: SwapRecord[];
  fallbackDodged: string[];
  fallbackSwaps: SwapRecord[];
  defaultReferralCode: string;
  dirtyCount: number;
  onSwapAllAndMax: () => void;
}

export default function Scorecard({
  open,
  onClose,
  store,
  cartAvg,
  swaps,
  fallbackDodged,
  fallbackSwaps,
  defaultReferralCode,
  dirtyCount,
  onSwapAllAndMax,
}: ScorecardProps) {
  const [refCode, setRefCode] = useState(defaultReferralCode || "PARENTMAXX");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (defaultReferralCode) {
      setRefCode(defaultReferralCode);
    }
  }, [defaultReferralCode]);

  if (!open) return null;

  const hasSwaps = swaps.length > 0;
  const activeCode = (refCode || defaultReferralCode || "HEYBROC").toUpperCase();
  const dodgedList = Array.from(
    new Set(
      (hasSwaps ? swaps.flatMap((s) => s.dodged) : fallbackDodged).filter(Boolean),
    ),
  ).slice(0, 6);

  const displayedSwaps = (hasSwaps ? swaps : fallbackSwaps).slice(0, 3);
  const gradeLabel =
    cartAvg >= 75
      ? "Clean Cart Approved"
      : cartAvg >= 50
        ? "In Progress · Getting Cleaner"
        : "Before HeyBroc Swap";
  const gradeSubtitle =
    dirtyCount === 0
      ? "0 seed oils · 0 synthetic dyes · 0 HFCS"
      : `${dirtyCount} item${dirtyCount === 1 ? "" : "s"} ready for 1-tap clean swap`;

  const downloadPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = 1080;
    const H = 1920;
    canvas.width = W;
    canvas.height = H;

    // Background gradient
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0b2419");
    bg.addColorStop(0.55, "#103726");
    bg.addColorStop(1, "#091c14");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Subtle top glow
    const glow = ctx.createRadialGradient(W * 0.5, 260, 40, W * 0.5, 260, 560);
    glow.addColorStop(0, "rgba(34, 197, 94, 0.28)");
    glow.addColorStop(1, "rgba(34, 197, 94, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    const font = getComputedStyle(document.body).fontFamily || "sans-serif";

    // Store pill
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    roundRect(ctx, 84, 96, 460, 68, 34);
    ctx.fill();
    ctx.fillStyle = "#86efac";
    ctx.font = `800 28px ${font}`;
    ctx.fillText(`🛒 ${STORE_META[store].label.toUpperCase()} HAUL`, 118, 140);

    // Score circle / hero
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    roundRect(ctx, 84, 200, W - 168, 300, 40);
    ctx.fill();

    ctx.fillStyle = cartAvg >= 75 ? "#4ade80" : cartAvg >= 50 ? "#facc15" : "#f87171";
    ctx.font = `900 132px ${font}`;
    ctx.fillText(`${cartAvg}/100`, 130, 355);

    ctx.fillStyle = "#ffffff";
    ctx.font = `800 42px ${font}`;
    ctx.fillText(gradeLabel, 130, 435);

    // Section 1: Watchlist Additives Dodged Today (or Flagged in Cart)
    ctx.fillStyle = "#86efac";
    ctx.font = `800 28px ${font}`;
    ctx.fillText(
      hasSwaps
        ? `WATCHLIST ADDITIVES DODGED TODAY (${dodgedList.length})`
        : `FLAGGED ADDITIVES IN CART (${dodgedList.length})`,
      84,
      575,
    );

    let y = 610;
    dodgedList.slice(0, 6).forEach((name) => {
      ctx.fillStyle = "rgba(239, 68, 68, 0.18)";
      roundRect(ctx, 84, y, W - 168, 74, 22);
      ctx.fill();
      ctx.fillStyle = "#fecaca";
      ctx.font = `700 32px ${font}`;
      ctx.fillText(`🚫  ${name}`, 116, y + 48);
      y += 90;
    });

    // Section 2: Top Clean Swaps Made (or Available)
    y += 30;
    ctx.fillStyle = "#86efac";
    ctx.font = `800 28px ${font}`;
    ctx.fillText(hasSwaps ? "TOP 1-TAP CLEAN SWAPS MADE" : "AVAILABLE 1-TAP CLEAN SWAPS", 84, y);
    y += 28;

    displayedSwaps.slice(0, 3).forEach((sw) => {
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      roundRect(ctx, 84, y, W - 168, 130, 24);
      ctx.fill();

      ctx.fillStyle = "#fca5a5";
      ctx.font = `600 26px ${font}`;
      ctx.fillText(`✗ ${sw.fromTitle.slice(0, 42)}`, 116, y + 48);

      ctx.fillStyle = "#86efac";
      ctx.font = `800 30px ${font}`;
      ctx.fillText(`✓ ${sw.toTitle.slice(0, 40)} (${sw.toScore ?? 90}/100)`, 116, y + 98);
      y += 148;
    });

    // Bottom watermark bar
    ctx.fillStyle = "rgba(15, 122, 74, 0.35)";
    roundRect(ctx, 84, H - 210, W - 168, 130, 28);
    ctx.fill();

    const mascotEl = document.querySelector<HTMLImageElement>('img[src="/broc-mascot.jpg"]');
    let textX = 120;
    if (mascotEl && mascotEl.complete && mascotEl.naturalWidth > 0) {
      ctx.save();
      roundRect(ctx, 110, H - 191, 92, 92, 20);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.clip();
      ctx.drawImage(mascotEl, 110, H - 191, 92, 92);
      ctx.restore();
      textX = 224;
    }

    ctx.fillStyle = "#ffffff";
    ctx.font = `900 36px ${font}`;
    ctx.fillText("HeyBroc · heybroc.com", textX, H - 150);

    ctx.fillStyle = "#86efac";
    ctx.font = `700 28px ${font}`;
    ctx.fillText(
      activeCode.startsWith("BROC-")
        ? `+7 Free Pro Days Code: ${activeCode}`
        : `14-Day Free Trial Code: ${activeCode}`,
      textX,
      H - 105,
    );

    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = `500 18px ${font}`;
    ctx.fillText(
      "Independent clean-label opinion · Not affiliated with any store or brand · Always verify physical package label",
      84,
      H - 42,
    );

    const a = document.createElement("a");
    a.download = `heybroc-${store}-scorecard-${cartAvg}.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="9:16 Clean Haul Scorecard" onClick={onClose}>
      <div className="modal-card scorecard-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="yuka-topbar-left">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/broc-mascot.jpg" alt="Broc" className="yuka-topbar-mascot" />
            <div>
              <span className="eyebrow eyebrow--green">9:16 Viral TikTok / IG Story Generator</span>
              <h2>Clean Haul Scorecard</h2>
            </div>
          </div>
          <button className="close" onClick={onClose} aria-label="Close scorecard">×</button>
        </div>

        {dirtyCount > 0 && (
          <div className="scorecard-upsell">
            <span>
              Your cart still has <b>{dirtyCount}</b> unswapped item{dirtyCount === 1 ? "" : "s"} (current avg: {cartAvg}/100).
            </span>
            <button id="scorecard-swap-all" type="button" className="swap-btn" onClick={onSwapAllAndMax}>
              Swap All Clean Alternatives ✨
            </button>
          </div>
        )}

        <div className="scorecard-layout">
          {/* 9:16 VERTICAL SOCIAL CARD PREVIEW */}
          <div id="viral-scorecard-preview" className="story-card">
            <div className="story-top">
              <span className="story-store-badge">
                🛒 {STORE_META[store].label} Haul
              </span>
              <span className="story-tag">100% Ingredient Graded</span>
            </div>

            <div className={`story-grade tone-${cartAvg >= 75 ? "green" : cartAvg >= 50 ? "yellow" : "red"}`}>
              <div className="story-score">
                <strong>{cartAvg}</strong>
                <span>/100</span>
              </div>
              <div className="story-grade-meta">
                <b>{gradeLabel}</b>
                <small>{gradeSubtitle}</small>
              </div>
            </div>

            <div className="story-section">
              <h4>
                {hasSwaps ? "Watchlist Additives Dodged Today" : "Flagged Additives in Cart"} <span>{dodgedList.length}</span>
              </h4>
              <div className="story-dodged-pills">
                {dodgedList.map((name) => (
                  <span key={name} className="story-dodged-pill">
                    🚫 {name}
                  </span>
                ))}
              </div>
            </div>

            <div className="story-section">
              <h4>{hasSwaps ? "Top Clean Swaps Made" : "Available 1-Tap Clean Swaps"}</h4>
              <ul className="story-swaps">
                {displayedSwaps.map((sw, idx) => (
                  <li key={`${sw.fromTitle}-${idx}`}>
                    <span className="story-from">✗ {sw.fromTitle}</span>
                    <span className="story-to">✓ {sw.toTitle} <em>{sw.toScore ?? 90}/100</em></span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="story-watermark">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/broc-mascot.jpg" alt="Broc" className="story-watermark-mascot" />
                <div>
                  <strong>HeyBroc · heybroc.com</strong>
                  <span>Scan &amp; swap groceries for cleaner alternatives in 1 tap</span>
                </div>
              </div>
              <div className="story-code-badge">
                <small>FREE PRO INVITE CODE</small>
                <b>{activeCode}</b>
              </div>
            </div>
          </div>

          {/* CONTROLS & EXPORT */}
          <div className="scorecard-controls">
            <div className="card">
              <div className="card-head">
                <h2>Creator / Referral Watermark</h2>
              </div>
              <label className="creator-label" htmlFor="scorecard-ref-input">
                Custom referral code stamped on the bottom watermark:
              </label>
              <input
                id="scorecard-ref-input"
                className="scorecard-input"
                type="text"
                value={refCode}
                onChange={(e) => setRefCode(e.target.value.toUpperCase())}
                placeholder="e.g. PARENTMAXX, SARAHHAULS"
              />
              <p className="meta">
                Share your Clean Haul Scorecard on TikTok or Instagram Stories with your personal code <b>{activeCode}</b> to give friends +7 Free Pro Days (or a 14-day extended creator trial).
              </p>
              <button id="download-scorecard-png" type="button" className="swap-btn swap-btn--wide" onClick={downloadPng}>
                ⬇ Download 1080×1920 Story PNG
              </button>
            </div>
          </div>
        </div>

        <canvas ref={canvasRef} style={{ display: "none" }} />
      </div>
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
