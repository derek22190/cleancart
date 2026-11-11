"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";

export interface SwapDirectoryRow {
  slug: string;
  title: string;
  brand: string;
  category: string;
  score: number;
  flaggedNames: string[];
  swapTitle: string | null;
  swapScore: number | null;
}

export default function SwapsDirectoryClient({
  rows,
}: {
  rows: SwapDirectoryRow[];
}) {
  const [search, setSearch] = useState("");
  const [selectedCat, setSelectedCat] = useState("All");
  const [showAll, setShowAll] = useState(false);

  const categories = useMemo(() => {
    const unique = Array.from(new Set(rows.map((r) => r.category)));
    return ["All", ...unique];
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (selectedCat !== "All" && r.category !== selectedCat) return false;
      if (!q) return true;
      return (
        r.title.toLowerCase().includes(q) ||
        r.brand.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q) ||
        (r.swapTitle && r.swapTitle.toLowerCase().includes(q)) ||
        r.flaggedNames.some((f) => f.toLowerCase().includes(q))
      );
    });
  }, [rows, search, selectedCat]);

  const visible =
    showAll || search.trim().length > 0 || selectedCat !== "All"
      ? filtered
      : filtered.slice(0, 8);

  return (
    <div>
      {/* Search + Category Pills Right Above the Fold */}
      <div style={{ marginBottom: 12 }}>
        <input
          id="swaps-search-input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search food or swap (e.g., Doritos, Ranch, Yogurt, Cereal)…"
          aria-label="Search clean grocery swaps"
          style={{
            width: "100%",
            padding: "10px 13px",
            borderRadius: 12,
            border: "1px solid #cbd5e1",
            background: "#ffffff",
            fontSize: 13.5,
            marginBottom: 8,
          }}
        />
        <div
          style={{
            display: "flex",
            gap: 6,
            overflowX: "auto",
            paddingBottom: 2,
            scrollbarWidth: "none",
          }}
        >
          {categories.map((cat) => {
            const active = selectedCat === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => {
                  setSelectedCat(cat);
                  setShowAll(false);
                }}
                style={{
                  padding: "5px 11px",
                  borderRadius: 999,
                  border: active ? "1.5px solid #16a34a" : "1px solid #cbd5e1",
                  background: active ? "#ecfdf5" : "#ffffff",
                  color: active ? "#065f46" : "#475569",
                  fontSize: 11.5,
                  fontWeight: 800,
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                {cat}
              </button>
            );
          })}
        </div>
      </div>

      {/* Compact Swap Cards */}
      <div style={{ display: "grid", gap: 10 }}>
        {visible.map((item) => {
          const pillBg =
            item.score >= 75 ? "#dcfce7" : item.score >= 50 ? "#fef3c7" : "#fee2e2";
          const pillFg =
            item.score >= 75 ? "#166534" : item.score >= 50 ? "#92400e" : "#991b1b";

          return (
            <Link
              key={item.slug}
              href={`/swaps/${item.slug}`}
              style={{
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: 16,
                padding: "12px 14px",
                textDecoration: "none",
                color: "#0f172a",
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(235px, 1fr))",
                gap: 10,
                alignItems: "center",
              }}
            >
              {/* Left: Popular Grocery Item */}
              <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/product-image?title=${encodeURIComponent(item.title)}`}
                  alt={item.title}
                  loading="lazy"
                  style={{
                    width: 48,
                    height: 48,
                    objectFit: "contain",
                    borderRadius: 10,
                    background: "#f8fafc",
                    border: "1px solid #e2e8f0",
                    padding: 3,
                    flexShrink: 0,
                  }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      marginBottom: 2,
                    }}
                  >
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 800,
                        background: pillBg,
                        color: pillFg,
                        flexShrink: 0,
                      }}
                    >
                      {item.score}/100
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: "#64748b",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {item.category}
                    </span>
                  </div>
                  <h2
                    style={{
                      fontSize: 14.5,
                      fontWeight: 800,
                      margin: 0,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {item.title}
                  </h2>
                  {item.flaggedNames.length > 0 && (
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "#b91c1c",
                        fontWeight: 700,
                        marginTop: 1,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      Flags: {item.flaggedNames.slice(0, 3).join(", ")}
                      {item.flaggedNames.length > 3
                        ? ` +${item.flaggedNames.length - 3}`
                        : ""}
                    </div>
                  )}
                </div>
              </div>

              {/* Right: Compact 1-for-1 Swap */}
              {item.swapTitle ? (
                <div
                  style={{
                    background: "#ecfdf5",
                    border: "1px solid #86efac",
                    borderRadius: 12,
                    padding: "8px 11px",
                    display: "flex",
                    gap: 9,
                    alignItems: "center",
                    minWidth: 0,
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/product-image?title=${encodeURIComponent(item.swapTitle)}`}
                    alt={item.swapTitle}
                    loading="lazy"
                    style={{
                      width: 38,
                      height: 38,
                      objectFit: "contain",
                      borderRadius: 8,
                      background: "#ffffff",
                      border: "1px solid #a7f3d0",
                      padding: 2,
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 900,
                        color: "#059669",
                        textTransform: "uppercase",
                      }}
                    >
                      ⇄ Clean Swap ({item.swapScore}/100)
                    </span>
                    <b
                      style={{
                        display: "block",
                        fontSize: 13.5,
                        color: "#064e3b",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {item.swapTitle}
                    </b>
                  </div>
                  <span style={{ color: "#059669", fontWeight: 900, fontSize: 15 }}>›</span>
                </div>
              ) : (
                <div
                  style={{
                    background: "#f0fdf4",
                    border: "1px solid #86efac",
                    borderRadius: 12,
                    padding: "9px 12px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: 12.5,
                    fontWeight: 800,
                    color: "#14532d",
                  }}
                >
                  <span>✓ Clean Category Benchmark</span>
                  <span>›</span>
                </div>
              )}
            </Link>
          );
        })}
      </div>

      {filtered.length > 8 && search.trim().length === 0 && selectedCat === "All" && (
        <button
          id="swaps-show-all-btn"
          type="button"
          onClick={() => setShowAll((v) => !v)}
          style={{
            marginTop: 12,
            width: "100%",
            padding: "11px 16px",
            borderRadius: 999,
            border: "1px solid #cbd5e1",
            background: "#ffffff",
            color: "#0f172a",
            fontWeight: 800,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          {showAll
            ? "Show fewer swaps ▴"
            : `Show all ${filtered.length} grocery swaps ▾`}
        </button>
      )}
    </div>
  );
}
