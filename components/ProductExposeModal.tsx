"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DietaryAlert } from "@/lib/dietary";
import type { ScoreResult } from "@/lib/rubric";
import { STORE_META, type Store, type SwapResult } from "@/lib/swaps";

interface ProductExposeModalProps {
  open: boolean;
  onClose: () => void;
  productTitle: string;
  productBrand: string;
  score: ScoreResult;
  dietaryAlerts?: DietaryAlert[];
  swap: SwapResult | null;
  swapUnlocked?: boolean;
  store: Store;
  referralCode: string;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function truncateText(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 1).trim()}…`;
}

export default function ProductExposeModal({
  open,
  onClose,
  productTitle,
  productBrand,
  score,
  dietaryAlerts = [],
  swap,
  swapUnlocked = true,
  store,
  referralCode,
}: ProductExposeModalProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [statusNote, setStatusNote] = useState("");

  useEffect(() => {
    if (!open) return;
    setStatusNote("");
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  const fullProductName = productTitle.toLowerCase().startsWith(productBrand.toLowerCase())
    ? productTitle
    : `${productBrand} ${productTitle}`.trim();
  const normalizedCode = (referralCode || "").trim().toUpperCase();
  const activeCreatorCode =
    normalizedCode && !normalizedCode.startsWith("BROC-") && normalizedCode !== "HEYBROC"
      ? normalizedCode
      : "";

  const buildShareUrl = useCallback(() => {
    const base = typeof window !== "undefined" ? window.location.origin : "https://www.heybroc.com";
    const params = new URLSearchParams();
    params.set("share", fullProductName);
    params.set("store", store);
    if (activeCreatorCode) params.set("ref", activeCreatorCode);
    return `${base}/?${params.toString()}`;
  }, [fullProductName, store, activeCreatorCode]);

  const buildShareCaption = useCallback(() => {
    const dot = score.color === "green" ? "🟢" : score.color === "yellow" ? "🟡" : "🔴";
    const dietaryLine =
      dietaryAlerts.length > 0
        ? `\n🚨 Dietary Alert: ${dietaryAlerts.map((a) => a.shortBadge).join(" · ")}`
        : "";
    const flaggedLine =
      score.flagged.length > 0
        ? `⚠️ Flagged: ${score.flagged.slice(0, 4).map((f) => f.name).join(", ")}`
        : "✅ Zero watchlist additives flagged";
    const swapLine = swap
      ? swapUnlocked
        ? `🔁 1-Tap Clean Swap at ${STORE_META[store].label}: ${swap.title} (${swap.score}/100)${swap.isStoreBrand ? " 💚 Store-Brand Value Pick" : ""}`
        : `🔁 ${swap.score}/100 Clean Replacement found at ${STORE_META[store].label} on HeyBroc`
      : `🥦 Verified Clean Pick on HeyBroc`;
    return `${dot} ${fullProductName} scored ${score.score}/100 on HeyBroc!${dietaryLine}\n${flaggedLine}\n${swapLine}\nTest any grocery free: ${buildShareUrl()}`;
  }, [score, dietaryAlerts, fullProductName, swap, swapUnlocked, store, buildShareUrl]);

  const renderExposeCanvas = useCallback((): HTMLCanvasElement | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const W = 1080;
    const H = 1350;
    canvas.width = W;
    canvas.height = H;

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#091e14");
    bg.addColorStop(0.5, "#0f3322");
    bg.addColorStop(1, "#071710");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const font = getComputedStyle(document.body).fontFamily || "sans-serif";

    // Top Header Pill (dynamically sized to store name)
    const headerLabel = `🥦 HEYBROC INGREDIENT EXPOSÉ · ${STORE_META[store].label.toUpperCase()}`;
    ctx.font = `800 25px ${font}`;
    const measuredHeaderWidth = ctx.measureText(headerLabel).width;
    const headerPillWidth = Math.min(W - 128, Math.max(520, Math.ceil(measuredHeaderWidth + 64)));
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    roundRectPath(ctx, 64, 54, headerPillWidth, 62, 31);
    ctx.fill();
    ctx.fillStyle = "#86efac";
    ctx.fillText(headerLabel, 92, 94);

    // Card 1: Scanned Product
    const isDirty = score.score < 75;
    ctx.fillStyle = isDirty ? "rgba(127, 29, 29, 0.36)" : "rgba(20, 83, 45, 0.42)";
    roundRectPath(ctx, 64, 146, W - 128, 470, 36);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = isDirty ? "rgba(248, 113, 113, 0.55)" : "rgba(74, 222, 128, 0.55)";
    ctx.stroke();

    ctx.fillStyle = isDirty ? "#fca5a5" : "#86efac";
    ctx.font = `800 24px ${font}`;
    ctx.fillText(isDirty ? "⚠️ SCANNED GROCERY ITEM" : "✅ VERIFIED CLEAN GROCERY ITEM", 102, 198);

    ctx.fillStyle = "#ffffff";
    ctx.font = `900 40px ${font}`;
    ctx.fillText(truncateText(fullProductName, 38), 102, 256);

    // Big Score Badge (with measured X offset so 100/100 never collides with rating)
    const scoreTone = score.color === "green" ? "#4ade80" : score.color === "yellow" ? "#facc15" : "#f87171";
    const scoreText = `${score.score}/100`;
    ctx.fillStyle = scoreTone;
    ctx.font = `900 96px ${font}`;
    ctx.fillText(scoreText, 102, 364);
    const scoreWidth = ctx.measureText(scoreText).width;
    const ratingX = Math.min(680, Math.max(430, Math.ceil(102 + scoreWidth + 26)));

    ctx.fillStyle = "#e2e8f0";
    ctx.font = `800 32px ${font}`;
    ctx.fillText(score.score < 25 ? "Bad · High-Risk Additives" : score.rating, ratingX, 348);

    // Dietary Alerts + Flagged Additives Pills
    let flagY = 412;
    if (dietaryAlerts.length > 0) {
      ctx.fillStyle = "rgba(220, 38, 38, 0.34)";
      roundRectPath(ctx, 102, flagY, W - 204, 54, 16);
      ctx.fill();
      ctx.fillStyle = "#fecaca";
      ctx.font = `800 24px ${font}`;
      ctx.fillText(
        `🚨 ${truncateText(dietaryAlerts.map((a) => a.shortBadge).join(" · "), 52)}`,
        126,
        flagY + 36,
      );
      flagY += 64;
    }

    const maxFlags = dietaryAlerts.length > 0 ? 2 : 3;
    const flags = score.flagged.slice(0, maxFlags);
    if (flags.length > 0) {
      flags.forEach((f) => {
        ctx.fillStyle = "rgba(239, 68, 68, 0.24)";
        roundRectPath(ctx, 102, flagY, W - 204, 54, 16);
        ctx.fill();
        ctx.fillStyle = "#fecaca";
        ctx.font = `700 25px ${font}`;
        ctx.fillText(`🚫 ${f.name} (−${f.penalty} pts)`, 126, flagY + 36);
        flagY += 64;
      });
    } else if (dietaryAlerts.length === 0) {
      ctx.fillStyle = "rgba(34, 197, 94, 0.22)";
      roundRectPath(ctx, 102, flagY, W - 204, 68, 18);
      ctx.fill();
      ctx.fillStyle = "#dcfce7";
      ctx.font = `700 27px ${font}`;
      ctx.fillText("✓ Zero synthetic dyes, refined seed oils, or HFCS flagged", 126, flagY + 43);
    }

    // Arrow Divider
    ctx.fillStyle = "#4ade80";
    ctx.font = `900 34px ${font}`;
    ctx.fillText(swap ? "⬇  1-TAP CLEAN SWAP  ⬇" : "✓  CLEAN CART APPROVED  ✓", 330, 668);

    // Card 2: Clean Swap (or Clean Breakdown)
    ctx.fillStyle = "rgba(20, 83, 45, 0.52)";
    roundRectPath(ctx, 64, 700, W - 128, 390, 36);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(74, 222, 128, 0.65)";
    ctx.stroke();

    if (swap) {
      ctx.fillStyle = "#86efac";
      ctx.font = `800 24px ${font}`;
      ctx.fillText(
        swapUnlocked && swap.isStoreBrand
          ? `💚 STORE-BRAND VALUE PICK AT ${STORE_META[store].label.toUpperCase()}`
          : `✓ CLEAN ALTERNATIVE AT ${STORE_META[store].label.toUpperCase()}`,
        102,
        754,
      );

      ctx.fillStyle = "#ffffff";
      ctx.font = `900 40px ${font}`;
      ctx.fillText(
        swapUnlocked ? truncateText(swap.title, 38) : "Verified Clean Replacement on HeyBroc",
        102,
        814,
      );

      ctx.fillStyle = "#4ade80";
      ctx.font = `900 92px ${font}`;
      ctx.fillText(`${swap.score}/100`, 102, 922);

      const jump = swap.score - score.score;
      if (jump > 0) {
        ctx.fillStyle = "#16a34a";
        roundRectPath(ctx, 470, 858, 250, 62, 31);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = `900 30px ${font}`;
        ctx.fillText(`+${jump} PT UPGRADE`, 494, 899);
      }

      ctx.fillStyle = "#dcfce7";
      ctx.font = `700 26px ${font}`;
      ctx.fillText(
        swapUnlocked
          ? truncateText(`Clean Ingredients: ${swap.ingredients}`, 62)
          : "Zero watchlist additives · Scan free at heybroc.com",
        102,
        1002,
      );
      ctx.fillStyle = "#bbf7d0";
      ctx.font = `600 23px ${font}`;
      ctx.fillText(`See live price & availability in ${STORE_META[store].label}`, 102, 1048);
    } else {
      ctx.fillStyle = "#86efac";
      ctx.font = `800 26px ${font}`;
      ctx.fillText("🥦 NO SWAP NEEDED — ALREADY TOP-RATED CLEAN PICK", 102, 770);
      ctx.fillStyle = "#ffffff";
      ctx.font = `700 30px ${font}`;
      ctx.fillText(truncateText(`Verified Clean Pick: ${fullProductName}`, 46), 102, 840);
      ctx.fillStyle = "#dcfce7";
      ctx.font = `600 25px ${font}`;
      ctx.fillText("60% Nutritional Quality · 30% Additive Safety · 10% Organic Bonus", 102, 910);
    }

    // Bottom Brand Bar
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    roundRectPath(ctx, 64, 1130, W - 128, 136, 28);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.font = `900 34px ${font}`;
    ctx.fillText("Scan any grocery free at heybroc.com", 102, 1184);

    ctx.fillStyle = "#86efac";
    ctx.font = `800 26px ${font}`;
    ctx.fillText(
      activeCreatorCode
        ? `🎁 Free Trial Code: ${activeCreatorCode}`
        : "100% Independent Clean-Label Food Grader",
      102,
      1232,
    );

    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = `500 18px ${font}`;
    ctx.fillText(
      "Independent clean-label opinion · Not affiliated with any store or brand · Always verify physical package label",
      64,
      1312,
    );

    return canvas;
  }, [store, score, dietaryAlerts, fullProductName, swap, swapUnlocked, activeCreatorCode]);

  const downloadFallbackPng = () => {
    const canvas = renderExposeCanvas();
    if (!canvas) return;
    const a = document.createElement("a");
    const slug = fullProductName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32);
    a.download = `heybroc-expose-${slug || "score"}-${score.score}.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
  };

  const handleNativeShare = async () => {
    const canvas = renderExposeCanvas();
    const caption = buildShareCaption();
    const shareUrl = buildShareUrl();

    if (canvas && typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        if (blob) {
          const file = new File([blob], "heybroc-score-card.png", { type: "image/png" });
          const navWithCanShare = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
          if (!navWithCanShare.canShare || navWithCanShare.canShare({ files: [file] })) {
            await navigator.share({
              title: `${fullProductName} — ${score.score}/100 on HeyBroc`,
              text: caption,
              files: [file],
            });
            setStatusNote("✓ Shared Before/After Score Card!");
            return;
          }
        }
        await navigator.share({
          title: `${fullProductName} — ${score.score}/100 on HeyBroc`,
          text: caption,
          url: shareUrl,
        });
        setStatusNote("✓ Shared link!");
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
      }
    }

    downloadFallbackPng();
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(caption).catch(() => {});
      setStatusNote("✓ Saved Score Card image & copied share link!");
    } else {
      setStatusNote("✓ Saved Score Card image!");
    }
  };

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Share Before and After Product Score Card"
      onClick={onClose}
    >
      <div
        className="modal-card"
        style={{ maxWidth: 480, width: "94vw", maxHeight: "calc(100dvh - 28px)", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="yuka-topbar-left">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/broc-mascot.png" alt="Broc" className="yuka-topbar-mascot" />
            <div>
              <span className="eyebrow eyebrow--green">Before &amp; After Score Card</span>
              <h2>Share Clean Swap</h2>
            </div>
          </div>
          <button className="close" type="button" onClick={onClose} aria-label="Close share card modal">
            ×
          </button>
        </div>

        {/* Live Visual Preview of the 4:5 Card */}
        <div
          id="product-expose-card-preview"
          style={{
            background: "linear-gradient(180deg, #091e14 0%, #0f3322 60%, #071710 100%)",
            color: "#ffffff",
            borderRadius: 20,
            padding: 16,
            marginTop: 8,
            boxShadow: "0 12px 28px rgba(7, 23, 16, 0.25)",
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 800, color: "#86efac", letterSpacing: "0.05em", marginBottom: 10 }}>
            🥦 HEYBROC · {STORE_META[store].label.toUpperCase()}
          </div>

          {/* Scanned Product Box */}
          <div
            style={{
              background: score.score < 75 ? "rgba(127, 29, 29, 0.42)" : "rgba(20, 83, 45, 0.48)",
              border: score.score < 75 ? "1.5px solid rgba(248, 113, 113, 0.55)" : "1.5px solid rgba(74, 222, 128, 0.55)",
              borderRadius: 16,
              padding: "12px 14px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: score.score < 75 ? "#fca5a5" : "#86efac" }}>
                {score.score < 75 ? "⚠️ SCANNED ITEM" : "✅ CLEAN ITEM"}
              </span>
              <span
                style={{
                  fontSize: 20,
                  fontWeight: 900,
                  color: score.color === "green" ? "#4ade80" : score.color === "yellow" ? "#facc15" : "#f87171",
                }}
              >
                {score.score}/100
              </span>
            </div>
            <div style={{ fontSize: 15, fontWeight: 800, marginTop: 3 }}>{fullProductName}</div>

            {dietaryAlerts.length > 0 && (
              <div style={{ fontSize: 11.5, color: "#fecaca", fontWeight: 700, marginTop: 4 }}>
                🚨 {dietaryAlerts.map((a) => a.shortBadge).join(" · ")}
              </div>
            )}

            {score.flagged.length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
                {score.flagged.slice(0, 4).map((f) => (
                  <span
                    key={f.id}
                    style={{
                      background: "rgba(239, 68, 68, 0.28)",
                      color: "#fecaca",
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "3px 8px",
                      borderRadius: 999,
                    }}
                  >
                    🚫 {f.name}
                  </span>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "#dcfce7", marginTop: 6 }}>
                ✓ Zero synthetic dyes, refined seed oils, or HFCS flagged
              </div>
            )}
          </div>

          {swap && (
            <>
              <div style={{ textAlign: "center", fontSize: 12, fontWeight: 900, color: "#4ade80", margin: "8px 0" }}>
                ⬇ 1-TAP CLEAN SWAP ⬇
              </div>
              <div
                style={{
                  background: "rgba(20, 83, 45, 0.58)",
                  border: "1.5px solid rgba(74, 222, 128, 0.65)",
                  borderRadius: 16,
                  padding: "12px 14px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: "#86efac" }}>
                    {swapUnlocked && swap.isStoreBrand
                      ? "💚 STORE-BRAND VALUE PICK"
                      : `✓ CLEAN PICK · ${STORE_META[store].label.toUpperCase()}`}
                  </span>
                  <span style={{ fontSize: 20, fontWeight: 900, color: "#4ade80" }}>{swap.score}/100</span>
                </div>
                <div style={{ fontSize: 15, fontWeight: 800, marginTop: 3 }}>
                  {swapUnlocked ? swap.title : `🔒 ${swap.score}/100 Clean Replacement Available`}
                </div>
                <div style={{ fontSize: 11.5, color: "#bbf7d0", marginTop: 4 }}>
                  See live price in {STORE_META[store].label} · Zero watchlist additives
                </div>
              </div>
            </>
          )}

          <div
            style={{
              marginTop: 10,
              padding: "8px 12px",
              borderRadius: 12,
              background: "rgba(255,255,255,0.10)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: 11.5,
            }}
          >
            <span style={{ fontWeight: 800 }}>heybroc.com</span>
            <span style={{ color: "#86efac", fontWeight: 700 }}>
              {activeCreatorCode ? `Code: ${activeCreatorCode}` : "100% Independent Score"}
            </span>
          </div>
        </div>

        <canvas ref={canvasRef} style={{ display: "none" }} />

        {statusNote && (
          <div
            id="expose-card-status"
            style={{
              marginTop: 10,
              padding: "8px 12px",
              borderRadius: 10,
              background: "#ecfdf5",
              color: "#14532d",
              fontSize: 12.5,
              fontWeight: 700,
              textAlign: "center",
            }}
          >
            {statusNote}
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          <button
            id="expose-share-primary-btn"
            type="button"
            className="swap-btn"
            onClick={() => void handleNativeShare()}
            style={{ width: "100%", padding: "12px 16px", fontWeight: 800 }}
          >
            📲 Share Score Card
          </button>
        </div>
      </div>
    </div>
  );
}
