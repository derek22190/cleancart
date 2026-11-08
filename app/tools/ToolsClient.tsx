"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import {
  ADDITIVE_RULES,
  CATEGORY_LABELS,
  RISK_LABEL,
  scoreProductYuka,
} from "@/lib/rubric";
import { SEO_PRODUCTS, evaluateSeoProduct } from "@/lib/seo-catalog";

const SAMPLE_LABELS = [
  {
    label: "Doritos Nacho Cheese (Seed Oils + Dyes)",
    title: "Doritos Nacho Cheese Tortilla Chips",
    ingredients:
      "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin, Salt, Cheddar Cheese, Whey, Monosodium Glutamate, Artificial Color (Yellow 6, Yellow 5, Red 40), Dextrose, Natural and Artificial Flavor.",
  },
  {
    label: "Hidden Valley Ranch (Soybean Oil + MSG)",
    title: "Hidden Valley Original Ranch",
    ingredients:
      "Vegetable Oil (Soybean and/or Canola Oil), Water, Sugar, Salt, Buttermilk, Egg Yolk, Monosodium Glutamate, Phosphoric Acid, Xanthan Gum, Natural and Artificial Flavor, Disodium Inosinate, Disodium Guanylate, Sorbic Acid, Calcium Disodium EDTA.",
  },
  {
    label: "Sweetened Yogurt (HFCS + Red 40 — High Glucose Spike)",
    title: "Strawberry Lowfat Yogurt",
    ingredients:
      "Cultured Grade A Reduced Fat Milk, Sugar, High Fructose Corn Syrup, Modified Corn Starch, Natural Flavor, Potassium Sorbate, Red 40.",
  },
  {
    label: "Siete Avocado Oil Tortilla Chips (Clean Label)",
    title: "Siete Grain-Free Sea Salt Tortilla Chips",
    ingredients: "Cassava Flour, Avocado Oil, Coconut Flour, Chia Seed, Sea Salt.",
  },
];

export default function ToolsClient() {
  const [titleInput, setTitleInput] = useState(SAMPLE_LABELS[0].title);
  const [ingInput, setIngInput] = useState(SAMPLE_LABELS[0].ingredients);
  const [additiveFilter, setAdditiveFilter] = useState("");

  const liveScore = useMemo(
    () => scoreProductYuka(ingInput, {}, [], { productTitle: titleInput }),
    [ingInput, titleInput],
  );

  const seedOilHits = liveScore.flagged.filter((f) => f.category === "seedOils");
  const dyeHits = liveScore.flagged.filter((f) => f.category === "dyes");

  const filteredRules = useMemo(() => {
    const q = additiveFilter.trim().toLowerCase();
    if (!q) return ADDITIVE_RULES;
    return ADDITIVE_RULES.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.explanation.toLowerCase().includes(q) ||
        CATEGORY_LABELS[r.category].toLowerCase().includes(q),
    );
  }, [additiveFilter]);

  const evaluatedCatalog = useMemo(
    () => SEO_PRODUCTS.map((p) => evaluateSeoProduct(p)),
    [],
  );

  const badgeTone =
    liveScore.score >= 75
      ? "#16a34a"
      : liveScore.score >= 50
        ? "#65a30d"
        : liveScore.score >= 25
          ? "#ea580c"
          : "#dc2626";

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: "28px 18px 64px", fontFamily: "var(--font-sans), system-ui, sans-serif", color: "#0f172a" }}>
      {/* Top Bar */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 28 }}>
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "#0f172a" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/broc-mascot.jpg" alt="HeyBroc" style={{ width: 42, height: 42, borderRadius: 12, border: "2px solid #16a34a" }} />
          <div>
            <b style={{ fontSize: 18, fontWeight: 900, display: "block" }}>HeyBroc - Online Food Scanner</b>
            <span style={{ fontSize: 12, color: "#15803d", fontWeight: 700 }}>Free Clean Ingredient, Seed Oil &amp; Blood Sugar Tools</span>
          </div>
        </Link>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link
            href="/swaps"
            style={{ padding: "9px 15px", borderRadius: 999, background: "#ecfdf5", border: "1px solid #86efac", color: "#065f46", fontWeight: 800, fontSize: 13, textDecoration: "none" }}
          >
            ⇄ Browse Clean Swaps Directory
          </Link>
          <a
            href="/heybroc.apk"
            download="heybroc.apk"
            style={{ padding: "9px 16px", borderRadius: 999, background: "#16a34a", color: "#ffffff", fontWeight: 800, fontSize: 13, textDecoration: "none" }}
          >
            📱 Download Free Android App
          </a>
        </div>
      </header>

      {/* Hero */}
      <section style={{ background: "linear-gradient(135deg, #064e3b 0%, #047857 100%)", color: "#ffffff", borderRadius: 24, padding: "28px 26px", marginBottom: 28 }}>
        <span style={{ display: "inline-block", background: "rgba(255,255,255,0.16)", padding: "4px 12px", borderRadius: 999, fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
          100% Free Online Tools · Zero Paywall
        </span>
        <h1 style={{ fontSize: 30, fontWeight: 900, lineHeight: 1.15, marginBottom: 10 }}>
          Free Ingredient Label Grader, Seed Oil Detector &amp; Sugar / Refined-Carb Checker
        </h1>
        <p style={{ fontSize: 15, color: "#d1fae5", maxWidth: 760, lineHeight: 1.5 }}>
          Paste any food or beverage ingredient label below for an instant <b>0–100 health score</b>, <b>3-Pillar Breakdown</b>, <b>Seed Oil &amp; Red 40 check</b>, and <b>Sugar &amp; refined-carb note</b>.
        </p>
      </section>

      {/* TOOL 1: Instant Ingredient Label & Paste Calculator */}
      <section id="ingredient-calculator" style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 20, padding: "22px", marginBottom: 28, boxShadow: "0 8px 24px rgba(15,23,42,0.04)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          <div>
            <span style={{ fontSize: 11, fontWeight: 800, color: "#16a34a", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Tool #1 · Instant 1-Second Custom Label Grader
            </span>
            <h2 style={{ fontSize: 21, fontWeight: 900, marginTop: 2 }}>
              Paste Any Ingredient List (0–100 Score + Blood Sugar &amp; Seed Oil Check)
            </h2>
          </div>
        </div>

        {/* Sample Preset Pills */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          {SAMPLE_LABELS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => {
                setTitleInput(s.title);
                setIngInput(s.ingredients);
              }}
              style={{
                padding: "7px 12px",
                borderRadius: 999,
                border: titleInput === s.title ? "2px solid #16a34a" : "1px solid #cbd5e1",
                background: titleInput === s.title ? "#ecfdf5" : "#f8fafc",
                color: "#0f172a",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Try: {s.label}
            </button>
          ))}
        </div>

        <div style={{ display: "grid", gap: 12, marginBottom: 18 }}>
          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 800, color: "#475569", marginBottom: 4 }}>
              Product Name (Optional — helps detect beverages, chips, dressings, or organic status)
            </label>
            <input
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              placeholder="e.g., Doritos Nacho Cheese, Organic Almond Milk, Kids Fruit Snacks…"
              style={{ width: "100%", padding: "11px 14px", borderRadius: 12, border: "1px solid #cbd5e1", fontSize: 14 }}
            />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 800, color: "#475569", marginBottom: 4 }}>
              Ingredients List (Paste from any grocery website or nutrition label)
            </label>
            <textarea
              rows={4}
              value={ingInput}
              onChange={(e) => setIngInput(e.target.value)}
              placeholder="Paste ingredients separated by commas…"
              style={{ width: "100%", padding: "11px 14px", borderRadius: 12, border: "1px solid #cbd5e1", fontSize: 14, fontFamily: "inherit" }}
            />
          </div>
        </div>

        {/* Live Result Card */}
        <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 16, padding: "18px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 14, marginBottom: 14 }}>
            <div>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#64748b" }}>{titleInput || "Custom Ingredient Analysis"}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
                <span style={{ width: 16, height: 16, borderRadius: "50%", background: badgeTone, display: "inline-block" }} />
                <strong style={{ fontSize: 28, fontWeight: 900 }}>{liveScore.score}/100</strong>
                <span style={{ fontSize: 15, fontWeight: 800, color: badgeTone }}>
                  {liveScore.score < 25 ? "Bad" : liveScore.rating}
                </span>
              </div>
            </div>

            {/* Quick Status Badges for Seed Oils, Dyes & Glucose */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <span
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 800,
                  background: seedOilHits.length === 0 ? "#dcfce7" : "#fee2e2",
                  color: seedOilHits.length === 0 ? "#166534" : "#991b1b",
                }}
              >
                {seedOilHits.length === 0 ? "✓ Seed-Oil Free" : `✕ ${seedOilHits.length} Seed Oil(s) Detected`}
              </span>
              <span
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 800,
                  background: dyeHits.length === 0 ? "#dcfce7" : "#fee2e2",
                  color: dyeHits.length === 0 ? "#166534" : "#991b1b",
                }}
              >
                {dyeHits.length === 0 ? "✓ Zero Artificial Dyes" : `✕ ${dyeHits.length} Artificial Dye(s)`}
              </span>
              {liveScore.yukaBreakdown?.glucoseImpact && (
                <span
                  style={{
                    padding: "6px 12px",
                    borderRadius: 999,
                    fontSize: 12,
                    fontWeight: 800,
                    background:
                      liveScore.yukaBreakdown.glucoseImpact === "Low Spike"
                        ? "#dcfce7"
                        : liveScore.yukaBreakdown.glucoseImpact === "Moderate Spike"
                          ? "#fef3c7"
                          : "#fee2e2",
                    color:
                      liveScore.yukaBreakdown.glucoseImpact === "Low Spike"
                        ? "#166534"
                        : liveScore.yukaBreakdown.glucoseImpact === "Moderate Spike"
                          ? "#92400e"
                          : "#991b1b",
                  }}
                >
                  🩸 Glucose: {liveScore.yukaBreakdown.glucoseImpact}
                </span>
              )}
            </div>
          </div>

          {/* 3-Pillar + Sugar & Refined-Carb Note */}
          {liveScore.yukaBreakdown && (
            <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 14px", marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#64748b", letterSpacing: "0.05em" }}>
                3-PILLAR SCORE BREAKDOWN &amp; SUGAR / REFINED-CARB NOTE
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 4 }}>
                🥗 Nutritional Quality: {liveScore.yukaBreakdown.nutritionScore}/60 (Nutri-Score {liveScore.yukaBreakdown.nutriScoreGrade}) &nbsp;·&nbsp; 🧪 Additive Safety: {liveScore.yukaBreakdown.additiveScore}/30 &nbsp;·&nbsp; 🌱 Organic Bonus: {liveScore.yukaBreakdown.organicScore}/10
              </div>
              <p style={{ fontSize: 12.5, color: "#475569", marginTop: 6, marginBottom: 0 }}>
                <b>🩸 Sugar &amp; refined-carb note:</b> {liveScore.yukaBreakdown.glucoseNote} ({liveScore.yukaBreakdown.calorieNote})
              </p>
            </div>
          )}

          {/* Flagged Additives List */}
          {liveScore.flagged.length === 0 ? (
            <div style={{ background: "#dcfce7", color: "#166534", padding: "10px 14px", borderRadius: 10, fontWeight: 800, fontSize: 13 }}>
              ✓ Clean Label! Zero flagged chemical additives, seed oils, or synthetic dyes.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              <b style={{ fontSize: 12, color: "#b91c1c", textTransform: "uppercase" }}>
                Flagged Ingredients &amp; Nutrition Warnings ({liveScore.flagged.length}):
              </b>
              {liveScore.flagged.map((f) => (
                <div key={f.id} style={{ background: "#ffffff", border: "1px solid #fecaca", borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800, fontSize: 13.5 }}>
                    <span>{f.name} ({CATEGORY_LABELS[f.category]})</span>
                    <span style={{ color: "#dc2626" }}>{RISK_LABEL[f.risk]} · −{f.penalty} pts</span>
                  </div>
                  <p style={{ fontSize: 12, color: "#475569", margin: "4px 0 0" }}>{f.explanation}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* TOOL 2: Popular Grocery Product Reports & Clean Swaps */}
      <section id="clean-swaps" style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
          <div>
            <span style={{ fontSize: 11, fontWeight: 800, color: "#16a34a", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Tool #2 · Most-Searched Grocery Products &amp; 1-Tap Clean Swaps
            </span>
            <h2 style={{ fontSize: 22, fontWeight: 900, marginTop: 2 }}>
              Popular Product Ingredient Reports (0–100)
            </h2>
          </div>
          <Link href="/swaps" style={{ fontSize: 13, fontWeight: 800, color: "#16a34a", textDecoration: "none" }}>
            View All Product Reports →
          </Link>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(295px, 1fr))", gap: 14 }}>
          {evaluatedCatalog.map(({ entry, result, swap }) => (
            <Link
              key={entry.slug}
              href={`/swaps/${entry.slug}`}
              style={{
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: 16,
                padding: "16px",
                textDecoration: "none",
                color: "#0f172a",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <div>
                <span style={{ fontSize: 11, fontWeight: 800, color: "#64748b", textTransform: "uppercase" }}>
                  {entry.category} · {entry.brand}
                </span>
                <h3 style={{ fontSize: 16, fontWeight: 800, margin: "4px 0 6px" }}>{entry.title}</h3>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      padding: "3px 9px",
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 800,
                      background: result.score >= 70 ? "#dcfce7" : "#fee2e2",
                      color: result.score >= 70 ? "#166534" : "#991b1b",
                    }}
                  >
                    Score: {result.score}/100 ({result.score < 25 ? "Bad" : result.rating})
                  </span>
                  <span style={{ fontSize: 12, color: "#64748b" }}>
                    {result.flagged.length} flag{result.flagged.length === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
              {swap ? (
                <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, padding: "8px 10px", fontSize: 12 }}>
                  <b style={{ color: "#065f46", display: "block" }}>⇄ Clean Swap ({swap.score}/100):</b>
                  <span style={{ color: "#047857", fontWeight: 700 }}>{swap.title}</span>
                </div>
              ) : (
                <div style={{ background: "#f0fdf4", borderRadius: 10, padding: "8px 10px", fontSize: 12, color: "#166534", fontWeight: 700 }}>
                  ✓ Clean Category Pick — Inspect Full Report →
                </div>
              )}
            </Link>
          ))}
        </div>
      </section>

      {/* TOOL 3: Complete A-Z Food Additive Encyclopedia */}
      <section id="additive-encyclopedia" style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 20, padding: "22px" }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: "#16a34a", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Tool #3 · Scientific Ingredient Database ({ADDITIVE_RULES.length} Tracked Food Additives)
        </span>
        <h2 style={{ fontSize: 22, fontWeight: 900, marginTop: 2, marginBottom: 8 }}>
          A–Z Food Additive Safety Encyclopedia
        </h2>
        <p style={{ fontSize: 13.5, color: "#475569", marginBottom: 14 }}>
          Search every chemical preservative, synthetic food dye, refined seed oil, artificial sweetener, and emulsifier flagged by HeyBroc—complete with EFSA, FDA, WHO/IARC, and NIH citations.
        </p>

        <input
          value={additiveFilter}
          onChange={(e) => setAdditiveFilter(e.target.value)}
          placeholder="Filter additives (e.g., Red 40, Soybean Oil, Carrageenan, Titanium Dioxide, BHT, Nitrite)…"
          style={{ width: "100%", padding: "11px 14px", borderRadius: 12, border: "1px solid #cbd5e1", fontSize: 14, marginBottom: 14 }}
        />

        <div style={{ display: "grid", gap: 10 }}>
          {filteredRules.map((r) => (
            <div
              key={r.id}
              style={{
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: 12,
                padding: "12px 14px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <b style={{ fontSize: 14.5, color: "#0f172a" }}>{r.name}</b>
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 800,
                    padding: "3px 9px",
                    borderRadius: 999,
                    background: r.risk === "high" ? "#fee2e2" : r.risk === "moderate" ? "#ffedd5" : "#fef9c3",
                    color: r.risk === "high" ? "#991b1b" : r.risk === "moderate" ? "#9a3412" : "#854d0e",
                  }}
                >
                  {CATEGORY_LABELS[r.category]} · {RISK_LABEL[r.risk]}
                </span>
              </div>
              <p style={{ fontSize: 12.5, color: "#475569", margin: "6px 0 0", lineHeight: 1.5 }}>{r.explanation}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
