"use client";

import React, { useId } from "react";

export interface CleanMiniRingMetric {
  label: string;
  valueText: string;
  /** 0..100 fill ratio */
  fillPct: number;
  /** Stroke color */
  color: string;
  sublabel?: string;
}

export interface CleanArcScoreCardProps {
  id?: string;
  headline?: string;
  leftStatValue?: string | number;
  leftStatLabel?: string;
  rightStatValue?: string | number;
  rightStatLabel?: string;
  /** Main 0..100 score (or null when empty) */
  score: number | null;
  scoreSublabel?: string;
  /** Optional before -> after badge (e.g. for Weekly Order Audit) */
  beforeScore?: number | null;
  miniRings: [CleanMiniRingMetric, CleanMiniRingMetric, CleanMiniRingMetric];
  footerNote?: React.ReactNode;
  compact?: boolean;
}

/**
 * Curved Horseshoe Arc Gauge + 3 Mini Sub-Score Rings
 * Inspired by clean editorial health trackers:
 * - Warm off-white card surface (#faf8f5)
 * - Editorial serif headline at top + left/right stat callouts
 * - Smooth 240-degree horseshoe SVG arc with multi-stop gradient
 * - 3 circular mini rings below for Nutrition / Additives / Seed Oils & Dyes (or Clean Picks)
 */
export default function CleanArcScoreCard({
  id,
  headline,
  leftStatValue,
  leftStatLabel,
  rightStatValue,
  rightStatLabel,
  score,
  scoreSublabel = "Clean Score",
  beforeScore,
  miniRings,
  footerNote,
  compact = false,
}: CleanArcScoreCardProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const gradId = `cleanArcGrad-${uid}`;

  const isEmpty = score === null || !Number.isFinite(score);
  const safeScore = isEmpty ? 0 : Math.max(0, Math.min(100, Math.round(score)));

  // Horseshoe arc geometry inside a 220 x 148 viewBox
  // Center (110, 96), radius 74, spanning 240 degrees (from 150 deg to 390 deg)
  const r = 74;
  const fullCircle = 2 * Math.PI * r;
  const arcFraction = 240 / 360; // 240° horseshoe
  const arcLength = fullCircle * arcFraction;
  const filledLength = arcLength * (safeScore / 100);

  // Gradient stops tailored to score tier while preserving the warm editorial look
  const stops =
    safeScore >= 75
      ? [
          { offset: "0%", color: "#f59e0b" },
          { offset: "45%", color: "#10b981" },
          { offset: "100%", color: "#059669" },
        ]
      : safeScore >= 50
        ? [
            { offset: "0%", color: "#f97316" },
            { offset: "55%", color: "#f59e0b" },
            { offset: "100%", color: "#8b5cf6" },
          ]
        : [
            { offset: "0%", color: "#ef4444" },
            { offset: "55%", color: "#f97316" },
            { offset: "100%", color: "#a855f7" },
          ];

  const resolvedHeadline =
    headline ??
    (isEmpty
      ? "Ready to scan"
      : safeScore >= 75
        ? "Great clean pick"
        : safeScore >= 50
          ? "Room for a cleaner swap"
          : "Time for a clean swap");

  return (
    <div
      id={id}
      style={{
        background: "linear-gradient(180deg, #faf8f5 0%, #f4f1ea 100%)",
        border: "1px solid rgba(21, 32, 27, 0.09)",
        borderRadius: compact ? 18 : 22,
        padding: compact ? "14px 14px 12px" : "16px 16px 14px",
        boxShadow: "0 6px 20px rgba(21, 32, 27, 0.05)",
        color: "#15201b",
        marginBottom: 12,
      }}
    >
      {/* Top Editorial Serif Headline */}
      <div
        style={{
          textAlign: "center",
          fontFamily: "var(--font-display), Georgia, serif",
          fontSize: compact ? 18 : 20,
          fontWeight: 600,
          letterSpacing: "-0.02em",
          color: "#15201b",
          marginBottom: compact ? 2 : 4,
        }}
      >
        {resolvedHeadline}
      </div>

      {/* Main Arc Gauge Row with Left & Right Stat Callouts */}
      <div
        style={{
          position: "relative",
          display: "grid",
          gridTemplateColumns: "58px 1fr 58px",
          alignItems: "center",
          gap: 4,
        }}
      >
        {/* Left Stat Callout */}
        <div style={{ textAlign: "center", alignSelf: "start", paddingTop: 10 }}>
          {leftStatValue !== undefined && (
            <>
              <div
                style={{
                  fontSize: compact ? 15 : 17,
                  fontWeight: 800,
                  letterSpacing: "-0.02em",
                  color: "#15201b",
                  lineHeight: 1.1,
                }}
              >
                {leftStatValue}
              </div>
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: "#78716c",
                  marginTop: 2,
                }}
              >
                {leftStatLabel}
              </div>
            </>
          )}
        </div>

        {/* Center Curved Horseshoe Arc */}
        <div
          style={{
            position: "relative",
            width: "100%",
            maxWidth: compact ? 184 : 204,
            margin: "0 auto",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          <svg
            viewBox="0 0 220 142"
            style={{
              width: "100%",
              height: "auto",
              overflow: "visible",
              display: "block",
            }}
            aria-label={isEmpty ? "Empty score gauge" : `Clean Score ${safeScore} out of 100`}
          >
            <defs>
              <linearGradient id={gradId} x1="0%" y1="50%" x2="100%" y2="50%">
                {stops.map((s) => (
                  <stop key={s.offset} offset={s.offset} stopColor={s.color} />
                ))}
              </linearGradient>
            </defs>

            {/* Background Track Arc */}
            <circle
              cx="110"
              cy="94"
              r={r}
              fill="none"
              stroke="#e7e3da"
              strokeWidth="12"
              strokeLinecap="round"
              strokeDasharray={`${arcLength} ${fullCircle}`}
              transform="rotate(150 110 94)"
            />

            {/* Foreground Gradient Progress Arc */}
            {!isEmpty && safeScore > 0 && (
              <circle
                cx="110"
                cy="94"
                r={r}
                fill="none"
                stroke={`url(#${gradId})`}
                strokeWidth="12"
                strokeLinecap="round"
                strokeDasharray={`${filledLength} ${fullCircle}`}
                transform="rotate(150 110 94)"
                style={{
                  transition: "stroke-dasharray 0.55s cubic-bezier(0.22, 1, 0.36, 1)",
                }}
              />
            )}
          </svg>

          {/* Center Score Readout Positioned Inside the Horseshoe */}
          <div
            style={{
              position: "absolute",
              top: compact ? "38%" : "39%",
              left: "50%",
              transform: "translate(-50%, -20%)",
              textAlign: "center",
              pointerEvents: "none",
              width: "100%",
            }}
          >
            {typeof beforeScore === "number" &&
            !isEmpty &&
            beforeScore !== safeScore ? (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "baseline",
                  gap: 5,
                  justifyContent: "center",
                }}
              >
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 800,
                    color: "#dc2626",
                    textDecoration: "line-through",
                    opacity: 0.8,
                  }}
                >
                  {beforeScore}
                </span>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#78716c" }}>→</span>
                <span
                  style={{
                    fontSize: compact ? 32 : 36,
                    fontWeight: 900,
                    letterSpacing: "-0.04em",
                    lineHeight: 1,
                    color: "#15201b",
                  }}
                >
                  {safeScore}
                </span>
              </div>
            ) : (
              <div
                style={{
                  fontSize: compact ? 34 : 38,
                  fontWeight: 900,
                  letterSpacing: "-0.04em",
                  lineHeight: 1,
                  color: isEmpty ? "#78716c" : "#15201b",
                }}
              >
                {isEmpty ? "--" : safeScore}
              </div>
            )}
            <div
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                color: "#78716c",
                marginTop: 3,
              }}
            >
              {scoreSublabel}
            </div>
          </div>
        </div>

        {/* Right Stat Callout */}
        <div style={{ textAlign: "center", alignSelf: "start", paddingTop: 10 }}>
          {rightStatValue !== undefined && (
            <>
              <div
                style={{
                  fontSize: compact ? 15 : 17,
                  fontWeight: 800,
                  letterSpacing: "-0.02em",
                  color: "#15201b",
                  lineHeight: 1.1,
                }}
              >
                {rightStatValue}
              </div>
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: "#78716c",
                  marginTop: 2,
                }}
              >
                {rightStatLabel}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 3 Mini Sub-Score Rings Row (Just like Protein / Carbs / Fat in Reference) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 8,
          marginTop: 2,
          paddingTop: 4,
        }}
      >
        {miniRings.map((ring) => {
          const mr = 22;
          const mc = 2 * Math.PI * mr;
          const pct = Math.max(0, Math.min(100, ring.fillPct));
          const dashOffset = mc * (1 - pct / 100);
          return (
            <div
              key={ring.label}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                textAlign: "center",
              }}
            >
              <div style={{ position: "relative", width: 54, height: 54 }}>
                <svg viewBox="0 0 54 54" width="54" height="54">
                  <circle
                    cx="27"
                    cy="27"
                    r={mr}
                    fill="none"
                    stroke="#e7e3da"
                    strokeWidth="4.5"
                  />
                  {pct > 0 && (
                    <circle
                      cx="27"
                      cy="27"
                      r={mr}
                      fill="none"
                      stroke={ring.color}
                      strokeWidth="4.5"
                      strokeLinecap="round"
                      strokeDasharray={mc}
                      strokeDashoffset={dashOffset}
                      transform="rotate(-90 27 27)"
                      style={{
                        transition: "stroke-dashoffset 0.5s ease",
                      }}
                    />
                  )}
                </svg>
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11.5,
                    fontWeight: 800,
                    color: "#15201b",
                    letterSpacing: "-0.02em",
                  }}
                >
                  {ring.valueText}
                </div>
              </div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#57534e",
                  marginTop: 4,
                  lineHeight: 1.2,
                }}
              >
                {ring.label}
              </div>
              {ring.sublabel && (
                <div
                  style={{
                    fontSize: 9.5,
                    fontWeight: 600,
                    color: "#78716c",
                    marginTop: 1,
                  }}
                >
                  {ring.sublabel}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {footerNote && (
        <div
          style={{
            borderTop: "1px solid rgba(21, 32, 27, 0.08)",
            marginTop: 10,
            paddingTop: 8,
          }}
        >
          {footerNote}
        </div>
      )}
    </div>
  );
}
