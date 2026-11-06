"use client";

import { useRef, useState } from "react";
import { STORE_META, type Store } from "@/lib/swaps";

export interface SwapRecord {
  fromTitle: string;
  toTitle: string;
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

  if (!open) return null;

  const activeCode = (refCode || defaultReferralCode || "CLEANCART").toUpperCase();
  const dodgedList = Array.from(
    new Set(
      (swaps.length > 0 ? swaps.flatMap((s) => s.dodged) : fallbackDodged).filter(Boolean),
    ),
  ).slice(0, 8);

  const displayedSwaps = (swaps.length > 0 ? swaps : fallbackSwaps).slice(0, 4);
  const gradeLabel =
    cartAvg >= 75
      ? "Clean Cart Approved"
      : cartAvg >= 50
        ? "In Progress · Getting Cleaner"
        : "Before CleanCart Swap";

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

    // Section 1: Toxic Additives Dodged Today
    ctx.fillStyle = "#86efac";
    ctx.font = `800 28px ${font}`;
    ctx.fillText(`TOXIC ADDITIVES DODGED TODAY (${dodgedList.length})`, 84, 575);

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

    // Section 2: Top Clean Swaps Made
    y += 30;
    ctx.fillStyle = "#86efac";
    ctx.font = `800 28px ${font}`;
    ctx.fillText("TOP 1-TAP CLEAN SWAPS", 84, y);
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
      ctx.fillText(`✓ ${sw.toTitle.slice(0, 40)} (100/100)`, 116, y + 98);
      y += 148;
    });

    // Bottom watermark bar
    ctx.fillStyle = "rgba(15, 122, 74, 0.35)";
    roundRect(ctx, 84, H - 210, W - 168, 130, 28);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.font = `900 36px ${font}`;
    ctx.fillText("HeyBroc · heybroc.com", 120, H - 150);

    ctx.fillStyle = "#86efac";
    ctx.font = `700 28px ${font}`;
    ctx.fillText(`7-Day Free Trial Code: ${activeCode}`, 120, H - 105);

    const a = document.createElement("a");
    a.download = `cleancart-${store}-scorecard-${cartAvg}.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="9:16 Clean Haul Scorecard" onClick={onClose}>
      <div className="modal-card scorecard-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <span className="eyebrow eyebrow--green">9:16 Viral TikTok / IG Story Generator</span>
            <h2>Clean Haul Scorecard</h2>
          </div>
          <button className="close" onClick={onClose} aria-label="Close scorecard">×</button>
        </div>

        {dirtyCount > 0 && (
          <div className="scorecard-upsell">
            <span>
              Your cart still has <b>{dirtyCount}</b> unswapped item{dirtyCount === 1 ? "" : "s"} (current avg: {cartAvg}/100).
            </span>
            <button id="scorecard-swap-all" type="button" className="swap-btn" onClick={onSwapAllAndMax}>
              Swap All &amp; Boost to 100/100 ✨
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
                <small>0 seed oils · 0 synthetic dyes · 0 HFCS</small>
              </div>
            </div>

            <div className="story-section">
              <h4>
                Toxic Additives Dodged Today <span>{dodgedList.length}</span>
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
              <h4>Top Clean Swaps Made</h4>
              <ul className="story-swaps">
                {displayedSwaps.map((sw, idx) => (
                  <li key={`${sw.fromTitle}-${idx}`}>
                    <span className="story-from">✗ {sw.fromTitle}</span>
                    <span className="story-to">✓ {sw.toTitle} <em>100/100</em></span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="story-watermark">
              <div>
                <strong>HeyBroc · heybroc.com</strong>
                <span>Scan &amp; swap dirty groceries in 1 tap</span>
              </div>
              <div className="story-code-badge">
                <small>7-DAY FREE TRIAL CODE</small>
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
                Every TikTok / IG Story viewer who enters <b>{activeCode}</b> on the CleanCart paywall unlocks a 7-day free trial and attributes a 35% creator commission ($17.50).
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
