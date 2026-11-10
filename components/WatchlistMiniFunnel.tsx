"use client";

import { useEffect, useState } from "react";
import { PRICING, annualPerMonth } from "@/lib/pricing";
import type { Category } from "@/lib/rubric";

export interface WatchlistMiniFunnelProps {
  open: boolean;
  initialSelected: Category[];
  onApplyAndGuest: (selected: Category[]) => void;
  onApplyAndSignIn: (selected: Category[]) => void;
  onApplyAndStartTrial?: (selected: Category[]) => void;
  onClose: () => void;
}

const WATCHLIST_PILLS: Array<{
  id: Category;
  icon: string;
  title: string;
  subtitle: string;
  badge: string;
  problemNote: string;
}> = [
  {
    id: "seedOils",
    icon: "🌻",
    title: "Industrial Seed Oils",
    subtitle: "Soybean, canola, corn, cottonseed & sunflower oil",
    badge: "Most Popular",
    problemNote: "Hidden in 70%+ of 'Natural' dressings, chips, crackers & oat milks",
  },
  {
    id: "dyes",
    icon: "🧪",
    title: "Red 40 & Artificial Dyes",
    subtitle: "Red 40, Yellow 5 & 6, Blue 1, Titanium Dioxide",
    badge: "Kids' Watchlist",
    problemNote: "Disguised inside yogurts, fruit snacks, cereals & sports drinks",
  },
  {
    id: "hfcs",
    icon: "🌽",
    title: "High-Fructose Corn Syrup",
    subtitle: "HFCS, corn syrup solids & hidden refined syrups",
    badge: "Added Syrups",
    problemNote: "Slipped into breads, ketchup, barbecue sauces & family staples",
  },
  {
    id: "nitrates",
    icon: "🥓",
    title: "Nitrites & Curing Nitrates",
    subtitle: "Sodium nitrite/nitrate in bacon, deli meat & hot dogs",
    badge: "Deli & Meat",
    problemNote: "Found in conventional lunch meats, sausage & cured deli turkey",
  },
  {
    id: "sweeteners",
    icon: "🥤",
    title: "Artificial Sweeteners",
    subtitle: "Sucralose, aspartame, acesulfame potassium & saccharin",
    badge: "Zero Artificial",
    problemNote: "Used in 'Zero Sugar' sodas, protein shakes & light yogurts",
  },
  {
    id: "preservatives",
    icon: "🛡️",
    title: "BHA, BHT & Harsh Preservatives",
    subtitle: "TBHQ, BHA/BHT, potassium bromate & propylparaben",
    badge: "Synthetic",
    problemNote: "Added to extend shelf life in cereals, tortillas & frozen meals",
  },
];

type FunnelStep = 1 | 2 | 3 | 4;

export default function WatchlistMiniFunnel({
  open,
  initialSelected,
  onApplyAndGuest,
  onApplyAndSignIn,
  onApplyAndStartTrial,
  onClose,
}: WatchlistMiniFunnelProps) {
  const [selected, setSelected] = useState<Category[]>(initialSelected);
  const [step, setStep] = useState<FunnelStep>(1);

  useEffect(() => {
    if (open) {
      setSelected(initialSelected.length > 0 ? initialSelected : ["seedOils", "dyes", "hfcs"]);
      setStep(1);
    }
  }, [open, initialSelected]);

  if (!open) return null;

  const toggle = (cat: Category) => {
    setSelected((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  };

  const activeGoalItems = WATCHLIST_PILLS.filter((p) => selected.includes(p.id));
  const displayGoalItems = activeGoalItems.length > 0 ? activeGoalItems : WATCHLIST_PILLS.slice(0, 3);

  return (
    <div
      className="modal-backdrop gococo-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="HeyBroc Clean-Eating Goals & Onboarding Funnel"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(15, 22, 18, 0.66)",
        backdropFilter: "blur(7px)",
        WebkitBackdropFilter: "blur(7px)",
      }}
    >
      <div
        className="modal-card gococo-sheet"
        style={{
          width: "100%",
          maxWidth: 480,
          maxHeight: "calc(100vh - 32px)",
          overflowY: "auto",
          background: "#ffffff",
          borderRadius: 26,
          padding: "22px 20px 20px",
          boxShadow: "0 24px 48px rgba(0, 0, 0, 0.30)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header: Back Button / Step Pill + Skip Button */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {step > 1 && (
              <button
                type="button"
                onClick={() => setStep((s) => (s > 1 ? ((s - 1) as FunnelStep) : 1))}
                style={{
                  background: "#f3f4f6",
                  border: "none",
                  borderRadius: 999,
                  padding: "5px 11px",
                  fontSize: 12,
                  fontWeight: 700,
                  color: "#374151",
                  cursor: "pointer",
                }}
              >
                ← Back
              </button>
            )}
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: "#e6f5ec",
                color: "#0b5e39",
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                padding: "5px 11px",
                borderRadius: 999,
              }}
            >
              🥦 Step {step} of 4 ·{" "}
              {step === 1
                ? "Your Goals"
                : step === 2
                  ? "The Problem"
                  : step === 3
                    ? "How Broc Works"
                    : "Your Plan"}
            </span>
          </div>

          <button
            type="button"
            onClick={() => onApplyAndGuest(selected)}
            aria-label="Skip and continue with Free Plan"
            style={{
              background: "#f3f4f6",
              border: "none",
              borderRadius: 999,
              padding: "5px 12px",
              fontSize: 12,
              fontWeight: 700,
              color: "#4b5563",
              cursor: "pointer",
            }}
          >
            Skip →
          </button>
        </div>

        {/* 4-Segment Progress Bar */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 6,
            marginBottom: 16,
          }}
        >
          {[1, 2, 3, 4].map((idx) => (
            <div
              key={idx}
              style={{
                height: 5,
                borderRadius: 999,
                background: idx <= step ? "#16a34a" : "#e5e7eb",
                transition: "background 0.2s ease",
              }}
            />
          ))}
        </div>

        {/* ==================== STEP 1: GOALS ==================== */}
        {step === 1 && (
          <>
            <h2
              style={{
                fontSize: 23,
                fontWeight: 800,
                color: "#111814",
                margin: "0 0 6px",
                lineHeight: 1.2,
              }}
            >
              What are your clean-eating goals?
            </h2>
            <p
              style={{
                fontSize: 13.5,
                color: "#4b5563",
                margin: "0 0 14px",
                lineHeight: 1.45,
              }}
            >
              Tap the ingredients you want out of your kitchen. HeyBroc applies{" "}
              <b>2x strictness</b> to your goals and finds{" "}
              <b>90–100/100 Clean Swaps</b> automatically.
            </p>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                maxHeight: "46vh",
                overflowY: "auto",
                paddingRight: 2,
              }}
            >
              {WATCHLIST_PILLS.map((item) => {
                const active = selected.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => toggle(item.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      width: "100%",
                      textAlign: "left",
                      padding: "11px 13px",
                      borderRadius: 16,
                      border: active ? "2px solid #16a34a" : "1.5px solid #e5e7eb",
                      background: active ? "#f0fdf4" : "#ffffff",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <span
                      style={{
                        width: 38,
                        height: 38,
                        borderRadius: 12,
                        background: active ? "#dcfce7" : "#f3f4f6",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 20,
                        flexShrink: 0,
                      }}
                    >
                      {item.icon}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 7,
                          flexWrap: "wrap",
                        }}
                      >
                        <span
                          style={{
                            fontSize: 14.5,
                            fontWeight: 800,
                            color: "#111814",
                          }}
                        >
                          {item.title}
                        </span>
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            padding: "2px 7px",
                            borderRadius: 999,
                            background: active ? "#16a34a" : "#e5e7eb",
                            color: active ? "#ffffff" : "#4b5563",
                          }}
                        >
                          {active ? "2x Penalty On" : item.badge}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "#6b7280",
                          marginTop: 2,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {item.subtitle}
                      </div>
                    </div>
                    <span
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 999,
                        background: active ? "#16a34a" : "#ffffff",
                        border: active ? "2px solid #16a34a" : "2px solid #d1d5db",
                        color: "#ffffff",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 13,
                        fontWeight: 800,
                        flexShrink: 0,
                      }}
                    >
                      {active ? "✓" : ""}
                    </span>
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                onClick={() => setStep(2)}
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  borderRadius: 999,
                  border: "none",
                  background: "#16a34a",
                  color: "#ffffff",
                  fontSize: 15,
                  fontWeight: 800,
                  cursor: "pointer",
                  boxShadow: "0 6px 18px rgba(22, 163, 74, 0.25)",
                }}
              >
                Continue ({selected.length} {selected.length === 1 ? "Goal" : "Goals"} Selected) →
              </button>
            </div>
          </>
        )}

        {/* ==================== STEP 2: THE PROBLEM ==================== */}
        {step === 2 && (
          <>
            <h2
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: "#111814",
                margin: "0 0 6px",
                lineHeight: 1.22,
              }}
            >
              Why &ldquo;Healthy-Looking&rdquo; Groceries Fail Your Goals
            </h2>
            <p
              style={{
                fontSize: 13.5,
                color: "#4b5563",
                margin: "0 0 14px",
                lineHeight: 1.45,
              }}
            >
              Big food brands print <b>&ldquo;Natural&rdquo;</b> or <b>&ldquo;Made with Real Fruit&rdquo;</b> on the front while hiding ultra-processed additives in tiny 6-point text on the back:
            </p>

            {/* Personalized Trigger Traps Based on Step 1 */}
            <div
              style={{
                background: "#fef2f2",
                border: "1.5px solid #fecaca",
                borderRadius: 16,
                padding: "12px 14px",
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 800,
                  color: "#991b1b",
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  marginBottom: 8,
                }}
              >
                ⚠️ Hidden in Everyday Aisle Staples:
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {displayGoalItems.slice(0, 3).map((g) => (
                  <div
                    key={g.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      fontSize: 12.5,
                      color: "#7f1d1d",
                    }}
                  >
                    <span>{g.icon}</span>
                    <div>
                      <b>{g.title}:</b> {g.problemNote}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Side-by-Side Before vs. After Example */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  background: "#fff5f5",
                  border: "1.5px solid #fca5a5",
                  borderRadius: 16,
                  padding: "12px",
                }}
              >
                <div
                  style={{
                    display: "inline-block",
                    background: "#dc2626",
                    color: "#ffffff",
                    fontSize: 10.5,
                    fontWeight: 800,
                    padding: "2px 8px",
                    borderRadius: 999,
                    marginBottom: 6,
                  }}
                >
                  ✕ 18/100 · Poor
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 800, color: "#111814" }}>
                  &ldquo;Natural&rdquo; Store Brand Pick
                </div>
                <div style={{ fontSize: 11.5, color: "#991b1b", marginTop: 4, lineHeight: 1.35 }}>
                  Hides Soybean Oil, High-Fructose Corn Syrup &amp; Red 40 in fine print.
                </div>
              </div>

              <div
                style={{
                  background: "#f0fdf4",
                  border: "1.5px solid #86efac",
                  borderRadius: 16,
                  padding: "12px",
                }}
              >
                <div
                  style={{
                    display: "inline-block",
                    background: "#16a34a",
                    color: "#ffffff",
                    fontSize: 10.5,
                    fontWeight: 800,
                    padding: "2px 8px",
                    borderRadius: 999,
                    marginBottom: 6,
                  }}
                >
                  ✓ 95/100 · Excellent
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 800, color: "#111814" }}>
                  1-Tap HeyBroc Clean Swap
                </div>
                <div style={{ fontSize: 11.5, color: "#166534", marginTop: 4, lineHeight: 1.35 }}>
                  100% Avocado/Olive Oil or Organic whole ingredients — 0 seed oils, 0 dyes.
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setStep(3)}
              style={{
                width: "100%",
                padding: "14px 16px",
                borderRadius: 999,
                border: "none",
                background: "#16a34a",
                color: "#ffffff",
                fontSize: 15,
                fontWeight: 800,
                cursor: "pointer",
                boxShadow: "0 6px 18px rgba(22, 163, 74, 0.25)",
              }}
            >
              See How HeyBroc Solves This →
            </button>
          </>
        )}

        {/* ==================== STEP 3: HOW HEYBROC SOLVES IT ==================== */}
        {step === 3 && (
          <>
            <h2
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: "#111814",
                margin: "0 0 6px",
                lineHeight: 1.22,
              }}
            >
              How HeyBroc Protects Your Cart in 1 Second
            </h2>
            <p
              style={{
                fontSize: 13.5,
                color: "#4b5563",
                margin: "0 0 14px",
                lineHeight: 1.45,
              }}
            >
              Stop squinting at 40-ingredient labels in the aisle. We do the homework across <b>1.5M+ foods</b> and <b>13 grocery stores</b>:
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  padding: "12px 14px",
                  borderRadius: 16,
                  background: "#f8fafc",
                  border: "1.5px solid #e2e8f0",
                }}
              >
                <span style={{ fontSize: 22 }}>📷</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#111814" }}>
                    1. Instant 0–100 Barcode &amp; Search Grading (100% Free)
                  </div>
                  <div style={{ fontSize: 12.5, color: "#4b5563", marginTop: 2, lineHeight: 1.4 }}>
                    Scan any barcode or search any product to see a transparent Yuka-grade 60/30/10 breakdown with <b>2x strictness</b> on your chosen goals.
                  </div>
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  padding: "12px 14px",
                  borderRadius: 16,
                  background: "#f0fdf4",
                  border: "1.5px solid #bbf7d0",
                }}
              >
                <span style={{ fontSize: 22 }}>⇄</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#14532d" }}>
                    2. 1-Tap Store-Specific Clean Swaps
                  </div>
                  <div style={{ fontSize: 12.5, color: "#166534", marginTop: 2, lineHeight: 1.4 }}>
                    Whenever a product fails your watchlist, tap once to open a verified <b>90–100/100 Clean Swap</b> sold at Walmart, Target, Costco, Sam&apos;s Club, ALDI, Kroger, Amazon Fresh or Instacart.
                  </div>
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  padding: "12px 14px",
                  borderRadius: 16,
                  background: "#f8fafc",
                  border: "1.5px solid #e2e8f0",
                }}
              >
                <span style={{ fontSize: 22 }}>🟢</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#111814" }}>
                    3. Live Store Bubble &amp; Whole-Cart Health Check
                  </div>
                  <div style={{ fontSize: 12.5, color: "#4b5563", marginTop: 2, lineHeight: 1.4 }}>
                    Floating score pill grades items automatically while you shop online or in-app, and audits your entire grocery cart before checkout.
                  </div>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setStep(4)}
              style={{
                width: "100%",
                padding: "14px 16px",
                borderRadius: 999,
                border: "none",
                background: "#16a34a",
                color: "#ffffff",
                fontSize: 15,
                fontWeight: 800,
                cursor: "pointer",
                boxShadow: "0 6px 18px rgba(22, 163, 74, 0.25)",
              }}
            >
              Build My Personalized Plan →
            </button>
          </>
        )}

        {/* ==================== STEP 4: PERSONALIZED PLAN (FREEMIUM + PRO TRIAL) ==================== */}
        {step === 4 && (
          <>
            <div
              style={{
                background: "#ecfdf5",
                border: "1.5px solid #6ee7b7",
                borderRadius: 14,
                padding: "10px 13px",
                marginBottom: 12,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span style={{ fontSize: 20 }}>✅</span>
              <div style={{ fontSize: 12.5, color: "#065f46", lineHeight: 1.35 }}>
                <b>Your Custom Watchlist Is Ready:</b> {selected.length}{" "}
                {selected.length === 1 ? "priority goal" : "priority goals"} active with{" "}
                <b>2x strictness</b> across all 13 grocery stores.
              </div>
            </div>

            <h2
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: "#111814",
                margin: "0 0 6px",
                lineHeight: 1.22,
              }}
            >
              Choose How You Want to Start
            </h2>
            <p
              style={{
                fontSize: 13,
                color: "#4b5563",
                margin: "0 0 12px",
                lineHeight: 1.45,
              }}
            >
              Barcode &amp; search grading is <b>always 100% free</b>. Unlock unlimited 1-tap Clean Swaps &amp; Whole-Cart Checks with a <b>{PRICING.trialDays}-Day Free Pro Trial ($0 today)</b>, or start on the Free Plan:
            </p>

            {/* Plan Comparison Card */}
            <div
              style={{
                background: "#f0fdf4",
                border: "2px solid #16a34a",
                borderRadius: 18,
                padding: "14px",
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 6,
                }}
              >
                <span style={{ fontSize: 14.5, fontWeight: 800, color: "#14532d" }}>
                  ⭐ HeyBroc Family Pro
                </span>
                <span
                  style={{
                    background: "#16a34a",
                    color: "#ffffff",
                    fontSize: 10.5,
                    fontWeight: 800,
                    padding: "3px 9px",
                    borderRadius: 999,
                  }}
                >
                  {PRICING.trialDays} DAYS FREE · $0 TODAY
                </span>
              </div>
              <ul
                style={{
                  margin: "0 0 8px",
                  paddingLeft: 18,
                  fontSize: 12.5,
                  color: "#166534",
                  lineHeight: 1.55,
                }}
              >
                <li><b>Unlimited 1-Tap Clean Swaps</b> across all 13 stores</li>
                <li><b>Whole-Cart Health Check</b> &amp; Swap-All Cart Cleaner</li>
                <li><b>Unlimited Live Store Bubble</b> &amp; Family Cloud Sync</li>
              </ul>
              <div style={{ fontSize: 11.5, color: "#15803d" }}>
                $0 due today · Then ${annualPerMonth.toFixed(2)}/mo billed annually (${PRICING.annual}/yr) or ${PRICING.monthly}/mo. Cancel anytime in 1 tap.
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  if (onApplyAndStartTrial) {
                    onApplyAndStartTrial(selected);
                  } else {
                    onApplyAndSignIn(selected);
                  }
                }}
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  borderRadius: 999,
                  border: "none",
                  background: "#16a34a",
                  color: "#ffffff",
                  fontSize: 15,
                  fontWeight: 800,
                  cursor: "pointer",
                  boxShadow: "0 6px 18px rgba(22, 163, 74, 0.28)",
                }}
              >
                Start {PRICING.trialDays}-Day Free Pro Trial ($0 Today) →
              </button>

              <button
                type="button"
                onClick={() => onApplyAndGuest(selected)}
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  borderRadius: 999,
                  border: "1.5px solid #d1d5db",
                  background: "#ffffff",
                  color: "#1f2937",
                  fontSize: 13.5,
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                Continue with Free Plan (Unlimited Scans + {PRICING.freeWeeklySwaps} Swaps/Wk) →
              </button>

              <button
                type="button"
                onClick={() => onApplyAndSignIn(selected)}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  borderRadius: 999,
                  border: "none",
                  background: "transparent",
                  color: "#0f7a4a",
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Save Watchlist ({selected.length}) &amp; Sign In / Sync Free Across Devices →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
