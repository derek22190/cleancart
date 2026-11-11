"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ADDITIVE_RULES,
  CATEGORY_LABELS,
  RISK_LABEL,
  scoreProductYuka,
  type Category,
} from "@/lib/rubric";

const FAMILY_WATCH_CATS: Category[] = [
  "seedOils",
  "dyes",
  "hfcs",
  "nitrates",
  "sweeteners",
  "preservatives",
];

const ADDITIVE_FILTER_CATS: Array<{ id: "all" | Category; label: string }> = [
  { id: "all", label: "All" },
  { id: "seedOils", label: "Seed Oils" },
  { id: "dyes", label: "Dyes" },
  { id: "hfcs", label: "Added Sugar" },
  { id: "sweeteners", label: "Sweeteners" },
  { id: "preservatives", label: "Preservatives" },
  { id: "nitrates", label: "Nitrates" },
  { id: "emulsifiers", label: "Emulsifiers" },
];

const SAMPLE_LABELS = [
  {
    shortLabel: "🌮 Doritos",
    title: "Doritos Nacho Cheese Tortilla Chips",
    ingredients:
      "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin, Salt, Cheddar Cheese, Whey, Monosodium Glutamate, Artificial Color (Yellow 6, Yellow 5, Red 40), Dextrose, Natural and Artificial Flavor.",
  },
  {
    shortLabel: "🥗 Ranch",
    title: "Hidden Valley Original Ranch",
    ingredients:
      "Vegetable Oil (Soybean and/or Canola Oil), Water, Sugar, Salt, Buttermilk, Egg Yolk, Monosodium Glutamate, Phosphoric Acid, Xanthan Gum, Natural and Artificial Flavor, Disodium Inosinate, Disodium Guanylate, Sorbic Acid, Calcium Disodium EDTA.",
  },
  {
    shortLabel: "🍓 Yogurt",
    title: "Strawberry Lowfat Yogurt",
    ingredients:
      "Cultured Grade A Reduced Fat Milk, Sugar, High Fructose Corn Syrup, Modified Corn Starch, Natural Flavor, Potassium Sorbate, Red 40.",
  },
  {
    shortLabel: "🥑 Clean Chips",
    title: "Siete Grain-Free Sea Salt Tortilla Chips",
    ingredients: "Cassava Flour, Avocado Oil, Coconut Flour, Chia Seed, Sea Salt.",
  },
];

type ToolTab = "grader" | "additives" | "setup";

export default function ToolsClient() {
  const [activeTab, setActiveTab] = useState<ToolTab>("grader");
  const [titleInput, setTitleInput] = useState(SAMPLE_LABELS[0].title);
  const [ingInput, setIngInput] = useState(SAMPLE_LABELS[0].ingredients);
  const [additiveFilter, setAdditiveFilter] = useState("");
  const [additiveCategory, setAdditiveCategory] = useState<"all" | Category>("all");
  const [showAllAdditives, setShowAllAdditives] = useState(false);
  const [copiedShortcutUrl, setCopiedShortcutUrl] = useState(false);
  const [familyWatchlist, setFamilyWatchlist] = useState<Category[]>([
    "seedOils",
    "dyes",
    "hfcs",
  ]);

  useEffect(() => {
    try {
      const saved = JSON.parse(
        window.localStorage.getItem("heybroc_family_watchlist") || "null"
      ) as Category[] | null;
      if (Array.isArray(saved)) {
        setFamilyWatchlist(saved);
      }
      const hash = window.location.hash.toLowerCase();
      if (hash.includes("mobile-setup") || hash.includes("setup")) {
        setActiveTab("setup");
      } else if (hash.includes("additive")) {
        setActiveTab("additives");
      }
    } catch {
      /* ignore */
    }
  }, []);

  const toggleFamilyCat = (cat: Category) => {
    setFamilyWatchlist((prev) => {
      const next = prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat];
      try {
        window.localStorage.setItem("heybroc_family_watchlist", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const shortcutEndpointUrl = "https://heybroc.com/api/scan?format=ios_text&q=";

  const liveScore = useMemo(
    () => scoreProductYuka(ingInput, {}, familyWatchlist, { productTitle: titleInput }),
    [ingInput, titleInput, familyWatchlist]
  );

  const seedOilHits = liveScore.flagged.filter((f) => f.category === "seedOils");
  const dyeHits = liveScore.flagged.filter((f) => f.category === "dyes");

  const filteredRules = useMemo(() => {
    const q = additiveFilter.trim().toLowerCase();
    return ADDITIVE_RULES.filter((r) => {
      if (additiveCategory !== "all" && r.category !== additiveCategory) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.explanation.toLowerCase().includes(q) ||
        CATEGORY_LABELS[r.category].toLowerCase().includes(q)
      );
    });
  }, [additiveFilter, additiveCategory]);

  const visibleRules =
    showAllAdditives || additiveFilter.trim().length > 0
      ? filteredRules
      : filteredRules.slice(0, 8);

  const badgeTone =
    liveScore.score >= 75
      ? "#16a34a"
      : liveScore.score >= 50
        ? "#d97706"
        : "#dc2626";

  return (
    <div
      style={{
        maxWidth: 880,
        margin: "0 auto",
        padding: "14px 16px 40px",
        fontFamily: "var(--font-sans), system-ui, sans-serif",
        color: "#0f172a",
      }}
    >
      {/* Clean Single-Row Top Bar */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 16,
        }}
      >
        <Link
          href="/"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            textDecoration: "none",
            color: "#0f172a",
            minWidth: 0,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/broc-mascot.jpg"
            alt="HeyBroc"
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              border: "2px solid #16a34a",
              flexShrink: 0,
            }}
          />
          <b style={{ fontSize: 18, fontWeight: 900, letterSpacing: "-0.02em" }}>
            HeyBroc
          </b>
        </Link>

        <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
          <Link
            href="/swaps"
            style={{
              padding: "7px 12px",
              borderRadius: 999,
              background: "#ecfdf5",
              border: "1px solid #86efac",
              color: "#065f46",
              fontWeight: 800,
              fontSize: 12.5,
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            ⇄ Swaps
          </Link>
          <Link
            href="/"
            style={{
              padding: "7px 13px",
              borderRadius: 999,
              background: "#0f172a",
              color: "#ffffff",
              fontWeight: 800,
              fontSize: 12.5,
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            ← Scanner
          </Link>
        </div>
      </header>

      {/* Compact Page Heading */}
      <div style={{ marginBottom: 14 }}>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 900,
            lineHeight: 1.2,
            letterSpacing: "-0.02em",
            marginBottom: 4,
          }}
        >
          Free Ingredient Label Grader &amp; Tools
        </h1>
        <p style={{ fontSize: 13.5, color: "#475569", lineHeight: 1.4, margin: 0 }}>
          Paste any food label for an instant 0–100 score, search additives, or set up your phone.
        </p>
      </div>

      {/* 3-Tab Switcher — Eliminates Multi-Screen Scrolling */}
      <div
        role="tablist"
        aria-label="HeyBroc free tools"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 5,
          padding: 4,
          borderRadius: 14,
          background: "#e8eae5",
          marginBottom: 16,
        }}
      >
        {(
          [
            { id: "grader" as const, label: "🧪 Label Grader" },
            { id: "additives" as const, label: `📚 Additives (${ADDITIVE_RULES.length})` },
            { id: "setup" as const, label: "📲 Phone Setup" },
          ]
        ).map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`tools-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: "9px 6px",
                borderRadius: 10,
                border: "none",
                background: active ? "#ffffff" : "transparent",
                color: active ? "#0f172a" : "#475569",
                fontWeight: 800,
                fontSize: 12.5,
                cursor: "pointer",
                boxShadow: active ? "0 1px 3px rgba(15,23,42,0.08)" : "none",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ==================== TAB 1: LABEL GRADER ==================== */}
      {activeTab === "grader" && (
        <section
          id="ingredient-calculator"
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 18,
            padding: "16px",
            boxShadow: "0 6px 20px rgba(15,23,42,0.04)",
          }}
        >
          {/* Compact Sample Pills */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {SAMPLE_LABELS.map((s) => {
              const active = titleInput === s.title;
              return (
                <button
                  key={s.shortLabel}
                  type="button"
                  onClick={() => {
                    setTitleInput(s.title);
                    setIngInput(s.ingredients);
                  }}
                  style={{
                    padding: "6px 11px",
                    borderRadius: 999,
                    border: active ? "2px solid #16a34a" : "1px solid #cbd5e1",
                    background: active ? "#ecfdf5" : "#f8fafc",
                    color: "#0f172a",
                    fontSize: 12,
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  {s.shortLabel}
                </button>
              );
            })}
          </div>

          <div style={{ display: "grid", gap: 9, marginBottom: 12 }}>
            <input
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              placeholder="Product name (optional — e.g., Doritos, Kids Yogurt)…"
              aria-label="Product name"
              style={{
                width: "100%",
                padding: "9px 12px",
                borderRadius: 11,
                border: "1px solid #cbd5e1",
                fontSize: 13.5,
              }}
            />
            <textarea
              rows={3}
              value={ingInput}
              onChange={(e) => setIngInput(e.target.value)}
              placeholder="Paste ingredient list separated by commas…"
              aria-label="Ingredients list"
              style={{
                width: "100%",
                padding: "9px 12px",
                borderRadius: 11,
                border: "1px solid #cbd5e1",
                fontSize: 13.5,
                fontFamily: "inherit",
              }}
            />
          </div>

          {/* Compact 2x Watchlist Strip */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              flexWrap: "wrap",
              marginBottom: 12,
            }}
          >
            <span style={{ fontSize: 11.5, fontWeight: 800, color: "#475569", marginRight: 2 }}>
              🛡️ 2x Watchlist:
            </span>
            {FAMILY_WATCH_CATS.map((cat) => {
              const active = familyWatchlist.includes(cat);
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => toggleFamilyCat(cat)}
                  style={{
                    padding: "4px 9px",
                    borderRadius: 999,
                    border: active ? "1.5px solid #16a34a" : "1px solid #cbd5e1",
                    background: active ? "#dcfce7" : "#ffffff",
                    color: active ? "#14532d" : "#475569",
                    fontSize: 11,
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  {active ? "✓ " : ""}
                  {CATEGORY_LABELS[cat]}
                </button>
              );
            })}
          </div>

          {/* Instant Score Result Box */}
          <div
            style={{
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: 14,
              padding: "14px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 10,
                marginBottom: 10,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {titleInput.trim() && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={`/api/product-image?title=${encodeURIComponent(titleInput.trim())}`}
                    alt={titleInput.trim()}
                    style={{
                      width: 44,
                      height: 44,
                      objectFit: "contain",
                      borderRadius: 10,
                      background: "#ffffff",
                      border: "1px solid #e2e8f0",
                      padding: 3,
                      flexShrink: 0,
                    }}
                  />
                )}
                <div>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: "#64748b" }}>
                    {titleInput || "Custom Ingredient Label"}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
                    <span
                      style={{
                        width: 13,
                        height: 13,
                        borderRadius: "50%",
                        background: badgeTone,
                        display: "inline-block",
                      }}
                    />
                    <strong style={{ fontSize: 24, fontWeight: 900 }}>
                      {liveScore.score}/100
                    </strong>
                    <span style={{ fontSize: 14, fontWeight: 800, color: badgeTone }}>
                      {liveScore.score >= 75
                        ? "Excellent"
                        : liveScore.score >= 50
                          ? "Mediocre"
                          : "Poor"}
                    </span>
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    fontSize: 11.5,
                    fontWeight: 800,
                    background: seedOilHits.length === 0 ? "#dcfce7" : "#fee2e2",
                    color: seedOilHits.length === 0 ? "#166534" : "#991b1b",
                  }}
                >
                  {seedOilHits.length === 0
                    ? "✓ Seed-Oil Free"
                    : `✕ ${seedOilHits.length} Seed Oil(s)`}
                </span>
                <span
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    fontSize: 11.5,
                    fontWeight: 800,
                    background: dyeHits.length === 0 ? "#dcfce7" : "#fee2e2",
                    color: dyeHits.length === 0 ? "#166534" : "#991b1b",
                  }}
                >
                  {dyeHits.length === 0 ? "✓ Dye-Free" : `✕ ${dyeHits.length} Dye(s)`}
                </span>
              </div>
            </div>

            {liveScore.yukaBreakdown && (
              <div
                style={{
                  fontSize: 12,
                  color: "#475569",
                  background: "#ffffff",
                  border: "1px solid #e2e8f0",
                  borderRadius: 10,
                  padding: "8px 11px",
                  marginBottom: 10,
                  lineHeight: 1.45,
                }}
              >
                <b>3-Pillar Score:</b> Nutrition {liveScore.yukaBreakdown.nutritionScore}/60 ·
                Additives {liveScore.yukaBreakdown.additiveScore}/30 · Organic{" "}
                {liveScore.yukaBreakdown.organicScore}/10
                {liveScore.yukaBreakdown.glucoseImpact
                  ? ` · Sugar/Carb: ${liveScore.yukaBreakdown.glucoseImpact}`
                  : ""}
              </div>
            )}

            {liveScore.flagged.length === 0 ? (
              <div
                style={{
                  background: "#dcfce7",
                  color: "#166534",
                  padding: "9px 12px",
                  borderRadius: 10,
                  fontWeight: 800,
                  fontSize: 12.5,
                }}
              >
                ✓ Clean Label — zero watchlist additives, seed oils, or synthetic dyes.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {liveScore.flagged.map((f) => (
                  <div
                    key={f.id}
                    style={{
                      background: "#ffffff",
                      border: "1px solid #fecaca",
                      borderRadius: 10,
                      padding: "8px 11px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 8,
                        fontWeight: 800,
                        fontSize: 12.5,
                      }}
                    >
                      <span>{f.name}</span>
                      <span style={{ color: "#dc2626", flexShrink: 0 }}>
                        {RISK_LABEL[f.risk]} (−{f.penalty})
                      </span>
                    </div>
                    <p style={{ fontSize: 11.5, color: "#475569", margin: "2px 0 0" }}>
                      {f.explanation}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 1-Line Bridge to Swaps Directory */}
          <div
            style={{
              marginTop: 12,
              padding: "10px 14px",
              borderRadius: 12,
              background: "#ecfdf5",
              border: "1px solid #a7f3d0",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              flexWrap: "wrap",
              fontSize: 12.5,
            }}
          >
            <span style={{ fontWeight: 700, color: "#065f46" }}>
              ⇄ Want 1-for-1 clean grocery replacements?
            </span>
            <Link
              href="/swaps"
              style={{ fontWeight: 800, color: "#047857", textDecoration: "none" }}
            >
              Browse Clean Swaps →
            </Link>
          </div>
        </section>
      )}

      {/* ==================== TAB 2: ADDITIVE LOOKUP (COMPACT + CAPPED) ==================== */}
      {activeTab === "additives" && (
        <section
          id="additive-encyclopedia"
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 18,
            padding: "16px",
          }}
        >
          <input
            value={additiveFilter}
            onChange={(e) => setAdditiveFilter(e.target.value)}
            placeholder="Search additive (e.g., Red 40, Soybean Oil, BHT, Carrageenan)…"
            aria-label="Search additives"
            style={{
              width: "100%",
              padding: "10px 13px",
              borderRadius: 11,
              border: "1px solid #cbd5e1",
              fontSize: 13.5,
              marginBottom: 10,
            }}
          />

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {ADDITIVE_FILTER_CATS.map((cat) => {
              const active = additiveCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => {
                    setAdditiveCategory(cat.id);
                    setShowAllAdditives(false);
                  }}
                  style={{
                    padding: "5px 10px",
                    borderRadius: 999,
                    border: active ? "1.5px solid #16a34a" : "1px solid #cbd5e1",
                    background: active ? "#ecfdf5" : "#f8fafc",
                    color: active ? "#065f46" : "#475569",
                    fontSize: 11.5,
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  {cat.label}
                </button>
              );
            })}
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            {visibleRules.map((r) => (
              <div
                key={r.id}
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: 11,
                  padding: "10px 12px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 6,
                  }}
                >
                  <b style={{ fontSize: 13.5, color: "#0f172a" }}>{r.name}</b>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 800,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background:
                        r.risk === "high"
                          ? "#fee2e2"
                          : r.risk === "moderate"
                            ? "#ffedd5"
                            : "#fef9c3",
                      color:
                        r.risk === "high"
                          ? "#991b1b"
                          : r.risk === "moderate"
                            ? "#9a3412"
                            : "#854d0e",
                    }}
                  >
                    {CATEGORY_LABELS[r.category]} · {RISK_LABEL[r.risk]}
                  </span>
                </div>
                <p
                  style={{
                    fontSize: 12,
                    color: "#475569",
                    margin: "4px 0 0",
                    lineHeight: 1.45,
                  }}
                >
                  {r.explanation}
                </p>
              </div>
            ))}
          </div>

          {filteredRules.length > 8 && additiveFilter.trim().length === 0 && (
            <button
              type="button"
              onClick={() => setShowAllAdditives((v) => !v)}
              style={{
                marginTop: 12,
                width: "100%",
                padding: "10px 14px",
                borderRadius: 999,
                border: "1px solid #cbd5e1",
                background: "#f8fafc",
                color: "#0f172a",
                fontWeight: 800,
                fontSize: 12.5,
                cursor: "pointer",
              }}
            >
              {showAllAdditives
                ? "Show fewer additives ▴"
                : `Show all ${filteredRules.length} tracked additives ▾`}
            </button>
          )}
        </section>
      )}

      {/* ==================== TAB 3: PHONE SETUP (CONCISE) ==================== */}
      {activeTab === "setup" && (
        <section
          id="mobile-setup"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 12,
          }}
        >
          {/* Android Card */}
          <div
            style={{
              background: "#f0fdf4",
              border: "1px solid #86efac",
              borderRadius: 18,
              padding: "16px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 800,
                  color: "#15803d",
                  textTransform: "uppercase",
                }}
              >
                🤖 Android · 1-Switch Store Bubble
              </span>
              <h2
                style={{
                  fontSize: 17,
                  fontWeight: 900,
                  margin: "4px 0 6px",
                  color: "#064e3b",
                }}
              >
                Floating Score Pill in Walmart, Target &amp; 12 Apps
              </h2>
              <p style={{ fontSize: 12.5, color: "#166534", lineHeight: 1.45, margin: 0 }}>
                Enable once in Accessibility Settings to auto-grade items and your whole cart while you shop.
              </p>
            </div>
            <a
              href="/heybroc.apk"
              download="heybroc.apk"
              style={{
                display: "inline-block",
                textAlign: "center",
                padding: "10px 16px",
                borderRadius: 999,
                background: "#16a34a",
                color: "#ffffff",
                fontWeight: 800,
                fontSize: 13,
                textDecoration: "none",
              }}
            >
              📲 Download Android App (.apk)
            </a>
          </div>

          {/* iPhone Card */}
          <div
            style={{
              background: "#eff6ff",
              border: "1px solid #93c5fd",
              borderRadius: 18,
              padding: "16px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 800,
                  color: "#1d4ed8",
                  textTransform: "uppercase",
                }}
              >
                🍎 iPhone · Safari + 1-Tap Shortcut
              </span>
              <h2
                style={{
                  fontSize: 17,
                  fontWeight: 900,
                  margin: "4px 0 6px",
                  color: "#1e3a8a",
                }}
              >
                Scan Any iPhone Grocery App in 1 Tap
              </h2>
              <p style={{ fontSize: 12.5, color: "#1e40af", lineHeight: 1.45, margin: "0 0 8px" }}>
                Paste this URL into Apple Shortcuts&apos; <i>Get Contents of URL → Show Result</i>:
              </p>
              <code
                style={{
                  display: "block",
                  padding: "7px 9px",
                  borderRadius: 9,
                  background: "#dbeafe",
                  color: "#1e3a8a",
                  fontSize: 11,
                  fontWeight: 700,
                  wordBreak: "break-all",
                }}
              >
                {shortcutEndpointUrl}[Shortcut Input]
              </code>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => {
                  if (typeof navigator !== "undefined" && navigator.clipboard) {
                    navigator.clipboard.writeText(shortcutEndpointUrl);
                    setCopiedShortcutUrl(true);
                    setTimeout(() => setCopiedShortcutUrl(false), 2500);
                  }
                }}
                style={{
                  padding: "9px 14px",
                  borderRadius: 999,
                  border: "none",
                  background: "#2563eb",
                  color: "#ffffff",
                  fontWeight: 800,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {copiedShortcutUrl ? "✓ Copied!" : "📋 Copy URL"}
              </button>
              <a
                href="shortcuts://create-shortcut"
                style={{
                  padding: "9px 14px",
                  borderRadius: 999,
                  background: "#ffffff",
                  border: "1px solid #93c5fd",
                  color: "#1d4ed8",
                  fontWeight: 800,
                  fontSize: 12,
                  textDecoration: "none",
                }}
              >
                ⚡ Open Shortcuts
              </a>
            </div>
          </div>
        </section>
      )}

      {/* Compact Collapsible Disclaimer */}
      <footer style={{ marginTop: 18 }}>
        <details
          style={{
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: 12,
            padding: "9px 13px",
            fontSize: 11.5,
            color: "#64748b",
          }}
        >
          <summary style={{ fontWeight: 700, cursor: "pointer", color: "#475569" }}>
            Independent Opinion &amp; Non-Affiliation Disclaimer
          </summary>
          <p style={{ margin: "6px 0 0", lineHeight: 1.5 }}>
            HeyBroc scores, risk tiers, and additive summaries represent HeyBroc&apos;s subjective
            clean-label opinion for informational comparison only and are not medical, nutritional,
            or regulatory safety advice. Most flagged additives and oils are FDA-permitted or GRAS
            in the United States. Always verify the physical product package label before purchasing
            or consuming any food or beverage. HeyBroc is not affiliated with, endorsed by, or
            sponsored by any grocery retailer or food/beverage manufacturer.
          </p>
        </details>
      </footer>
    </div>
  );
}
