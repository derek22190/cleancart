"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ADDITIVE_RULES,
  CATEGORY_LABELS,
  RISK_LABEL,
  scoreProductYuka,
  type Category,
  type NutritionInput,
  type ScoreResult,
} from "@/lib/rubric";
import CleanArcScoreCard from "@/components/CleanArcScoreCard";

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

type ToolTab = "grader" | "additives" | "setup";

interface LookupScanProduct {
  title: string;
  brand?: string;
  imageUrl?: string;
  ingredients: string;
  nutrition?: NutritionInput;
}

interface LookupScanPayload {
  ok: boolean;
  error?: string;
  product?: LookupScanProduct;
}

export default function ToolsClient() {
  const [activeTab, setActiveTab] = useState<ToolTab>("grader");
  const [titleInput, setTitleInput] = useState("Lactaid Whole Milk");
  const [ingInput, setIngInput] = useState("");
  const [showCustomIngredients, setShowCustomIngredients] = useState(false);
  const [lookupProduct, setLookupProduct] = useState<LookupScanProduct | null>({
    title: "Lactaid Whole Milk (100% Lactose-Free), 64 fl oz",
    brand: "Lactaid",
    ingredients: "Whole Milk, Lactase Enzyme, Vitamin D3.",
    nutrition: {
      caloriesKcal100g: 62,
      sugarsG100g: 5.0,
      saturatedFatG100g: 2.0,
      sodiumMg100g: 52,
      fiberG100g: 0,
      proteinG100g: 3.4,
      fruitsVegNutsPct: 0,
      nutriScoreGrade: "b",
      isWholeFood: false,
    },
  });
  const [lookupStatus, setLookupStatus] = useState<"idle" | "loading" | "error">("idle");
  const [lookupError, setLookupError] = useState("");
  const lookupSeqRef = useRef(0);
  const lookupAbortRef = useRef<AbortController | null>(null);

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

  const runProductLookup = useCallback(async (rawQuery: string) => {
    const q = rawQuery.trim();
    lookupAbortRef.current?.abort();
    if (!q) {
      setLookupProduct(null);
      setLookupStatus("idle");
      setLookupError("");
      return;
    }

    const seq = ++lookupSeqRef.current;
    const controller = new AbortController();
    lookupAbortRef.current = controller;
    setLookupStatus("loading");
    setLookupError("");

    try {
      const isBarcode = /^\d{8,14}$/.test(q);
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productTitle: q,
          ...(isBarcode ? { barcode: q } : {}),
          skipAnalytics: true,
        }),
        signal: controller.signal,
      });
      const data = (await res.json()) as LookupScanPayload;
      if (seq !== lookupSeqRef.current || controller.signal.aborted) return;

      if (!data.ok || !data.product) {
        setLookupProduct(null);
        setLookupStatus("error");
        setLookupError(
          data.error ||
            `Could not find "${q}" in our grocery database — tap "+ Paste custom ingredients" below to grade a physical package label.`
        );
        return;
      }

      setLookupProduct(data.product);
      setLookupStatus("idle");
      setLookupError("");
    } catch (err) {
      if (
        seq !== lookupSeqRef.current ||
        controller.signal.aborted ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      setLookupProduct(null);
      setLookupStatus("error");
      setLookupError("Network error looking up product — try again or paste ingredients below.");
    }
  }, []);

  useEffect(() => {
    if (ingInput.trim()) {
      lookupAbortRef.current?.abort();
      setLookupStatus("idle");
      setLookupError("");
      return;
    }
    const q = titleInput.trim();
    if (!q) {
      setLookupProduct(null);
      setLookupStatus("idle");
      setLookupError("");
      return;
    }
    if (
      q.toLowerCase() === "lactaid whole milk" &&
      lookupProduct?.title.toLowerCase().includes("lactaid whole milk")
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      void runProductLookup(q);
    }, 320);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [titleInput, ingInput, runProductLookup]);

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

  const hasCustomIngredients = ingInput.trim().length > 0;
  const activeScore: ScoreResult | null = useMemo(() => {
    if (hasCustomIngredients) {
      return scoreProductYuka(ingInput, {}, familyWatchlist, {
        productTitle: titleInput.trim(),
      });
    }
    if (lookupProduct) {
      return scoreProductYuka(lookupProduct.ingredients, {}, familyWatchlist, {
        ...lookupProduct.nutrition,
        productTitle: `${titleInput.trim()} ${lookupProduct.title}`.trim(),
      });
    }
    return null;
  }, [hasCustomIngredients, ingInput, titleInput, lookupProduct, familyWatchlist]);

  const seedOilHits = activeScore ? activeScore.flagged.filter((f) => f.category === "seedOils") : [];
  const dyeHits = activeScore ? activeScore.flagged.filter((f) => f.category === "dyes") : [];

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
    !activeScore
      ? "#64748b"
      : activeScore.score >= 75
        ? "#16a34a"
        : activeScore.score >= 50
          ? "#d97706"
          : "#dc2626";

  const displayTitle = hasCustomIngredients
    ? titleInput.trim() || "Custom Ingredient Label"
    : lookupProduct?.title || titleInput.trim() || "Food Score";

  const displayImageUrl = hasCustomIngredients
    ? titleInput.trim()
      ? `/api/product-image?q=${encodeURIComponent(titleInput.trim())}&v=4`
      : ""
    : lookupProduct?.imageUrl ||
      (titleInput.trim() ? `/api/product-image?q=${encodeURIComponent(titleInput.trim())}&v=4` : "");

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
            src="/broc-mascot.png"
            alt="HeyBroc"
            style={{
              width: 36,
              height: 36,
              objectFit: "contain",
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
          Free Grocery Score Checker &amp; Tools
        </h1>
        <p style={{ fontSize: 13.5, color: "#475569", lineHeight: 1.4, margin: 0 }}>
          Search any food or barcode for an instant 0–100 score, browse additives, or set up your phone.
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
            { id: "grader" as const, label: "🔍 Score Checker" },
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

      {/* ==================== TAB 1: PRODUCT & LABEL GRADER ==================== */}
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
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!hasCustomIngredients && titleInput.trim()) {
                void runProductLookup(titleInput);
              }
            }}
            style={{ display: "grid", gap: 8, marginBottom: 10 }}
          >
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                placeholder="Search any grocery product or barcode (e.g., Lactaid Milk, Cheerios)…"
                aria-label="Product name or barcode"
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "10px 13px",
                  borderRadius: 11,
                  border: "1px solid #cbd5e1",
                  fontSize: 14,
                }}
              />
              {!hasCustomIngredients && (
                <button
                  type="submit"
                  disabled={!titleInput.trim() || lookupStatus === "loading"}
                  style={{
                    padding: "10px 16px",
                    borderRadius: 11,
                    border: "none",
                    background: "#16a34a",
                    color: "#ffffff",
                    fontWeight: 800,
                    fontSize: 13.5,
                    cursor: !titleInput.trim() ? "not-allowed" : "pointer",
                    opacity: !titleInput.trim() ? 0.55 : 1,
                    flexShrink: 0,
                  }}
                >
                  {lookupStatus === "loading" ? "Checking…" : "Score"}
                </button>
              )}
            </div>

            <div>
              <button
                type="button"
                onClick={() => {
                  setShowCustomIngredients((open) => {
                    const next = !open;
                    if (!next && ingInput.trim()) {
                      setIngInput("");
                    }
                    return next;
                  });
                }}
                style={{
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  color: "#047857",
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                {showCustomIngredients || hasCustomIngredients
                  ? "− Hide custom ingredient box (use product lookup)"
                  : "+ Optional: Paste custom ingredients from a package"}
              </button>
            </div>

            {(showCustomIngredients || hasCustomIngredients) && (
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
            )}
          </form>

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
          {activeScore ? (
            <div
              style={{
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: 14,
                padding: "14px",
                opacity: lookupStatus === "loading" && !hasCustomIngredients ? 0.68 : 1,
                transition: "opacity 0.15s ease",
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
                  {displayImageUrl && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={displayImageUrl}
                      alt={displayTitle}
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
                      {displayTitle}
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
                        {activeScore.score}/100
                      </strong>
                      <span style={{ fontSize: 14, fontWeight: 800, color: badgeTone }}>
                        {activeScore.score >= 75
                          ? "Excellent"
                          : activeScore.score >= 50
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

              {activeScore.yukaBreakdown && (
                <CleanArcScoreCard
                  id="tools-clean-arc-card"
                  compact
                  headline={displayTitle}
                  leftStatValue={activeScore.flagged.length}
                  leftStatLabel={activeScore.flagged.length === 1 ? "Flagged" : "Flags"}
                  rightStatValue={seedOilHits.length + dyeHits.length}
                  rightStatLabel="Oils & Dyes"
                  score={activeScore.score}
                  scoreSublabel="Clean Score"
                  miniRings={[
                    {
                      label: "Nutrition",
                      valueText: `${activeScore.yukaBreakdown.nutritionScore}/60`,
                      fillPct: Math.round((activeScore.yukaBreakdown.nutritionScore / 60) * 100),
                      color:
                        activeScore.yukaBreakdown.nutritionScore >= 45
                          ? "#10b981"
                          : activeScore.yukaBreakdown.nutritionScore >= 28
                            ? "#f59e0b"
                            : "#ef4444",
                    },
                    {
                      label: "Additives",
                      valueText: `${activeScore.yukaBreakdown.additiveScore}/30`,
                      fillPct: Math.round((activeScore.yukaBreakdown.additiveScore / 30) * 100),
                      color: activeScore.yukaBreakdown.additiveScore >= 24 ? "#10b981" : "#ef4444",
                    },
                    {
                      label: "Oils & Dyes",
                      valueText: `${seedOilHits.length + dyeHits.length}`,
                      fillPct: seedOilHits.length + dyeHits.length === 0 ? 100 : 20,
                      color: seedOilHits.length + dyeHits.length === 0 ? "#10b981" : "#ea580c",
                    },
                  ]}
                />
              )}

              {!hasCustomIngredients && lookupProduct?.ingredients && (
                <p
                  style={{
                    fontSize: 12,
                    color: "#475569",
                    margin: "0 0 10px",
                    lineHeight: 1.45,
                  }}
                >
                  <strong style={{ color: "#0f172a" }}>Ingredients:</strong> {lookupProduct.ingredients}
                </p>
              )}

              {activeScore.flagged.length === 0 ? (
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
                  {activeScore.flagged.map((f) => (
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
          ) : (
            <div
              style={{
                background: "#f8fafc",
                border: "1px dashed #cbd5e1",
                borderRadius: 14,
                padding: "18px 14px",
                textAlign: "center",
                fontSize: 13,
                fontWeight: 700,
                color: lookupStatus === "error" ? "#b91c1c" : "#475569",
              }}
            >
              {lookupStatus === "loading"
                ? "Looking up verified label & nutrition…"
                : lookupError ||
                  "Type any grocery product name or barcode above (or paste custom ingredients) to see its 0–100 Clean Score."}
            </div>
          )}

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
