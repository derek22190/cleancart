import type { Metadata } from "next";
import Link from "next/link";
import { hasValidCatalogProvenance } from "@/lib/drinks-catalog";
import { SEO_PRODUCTS, evaluateSeoProduct } from "@/lib/seo-catalog";

export const metadata: Metadata = {
  title: "Clean Grocery Swaps Directory (Seed-Oil Free & Dye-Free Alternatives)",
  description:
    "Browse 1-for-1 healthier grocery swaps and 0–100 ingredient reports for popular snacks, dressings, cereals, yogurts, deli meats, and condiments on Walmart, Target, Kroger, Shipt, DoorDash, Instacart & ALDI.",
  alternates: {
    canonical: "https://www.heybroc.com/swaps",
  },
};

export default function SwapsDirectoryPage() {
  const items = SEO_PRODUCTS.filter((p) => hasValidCatalogProvenance(p.sourceUrl, p.verifiedAt)).map((p) =>
    evaluateSeoProduct(p)
  );

  return (
    <div style={{ maxWidth: 1020, margin: "0 auto", padding: "28px 18px 64px", fontFamily: "var(--font-sans), system-ui, sans-serif", color: "#0f172a" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 28 }}>
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "#0f172a" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/broc-mascot.jpg" alt="HeyBroc" style={{ width: 42, height: 42, borderRadius: 12, border: "2px solid #16a34a" }} />
          <div>
            <b style={{ fontSize: 18, fontWeight: 900, display: "block" }}>HeyBroc - Online Food Scanner</b>
            <span style={{ fontSize: 12, color: "#15803d", fontWeight: 700 }}>1-for-1 Clean Grocery Swaps Directory</span>
          </div>
        </Link>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link
            href="/tools"
            style={{ padding: "9px 15px", borderRadius: 999, background: "#f8fafc", border: "1px solid #cbd5e1", color: "#0f172a", fontWeight: 800, fontSize: 13, textDecoration: "none" }}
          >
            🧪 Free Ingredient &amp; Seed Oil Tools
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

      <section style={{ background: "linear-gradient(135deg, #064e3b 0%, #059669 100%)", color: "#ffffff", borderRadius: 24, padding: "28px 26px", marginBottom: 28 }}>
        <span style={{ display: "inline-block", background: "rgba(255,255,255,0.16)", padding: "4px 12px", borderRadius: 999, fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
          1-for-1 Same-Category Alternatives
        </span>
        <h1 style={{ fontSize: 30, fontWeight: 900, lineHeight: 1.15, marginBottom: 10 }}>
          Clean Grocery Swaps &amp; Editorial Ingredient Reports (0–100)
        </h1>
        <p style={{ fontSize: 15, color: "#d1fae5", maxWidth: 740, lineHeight: 1.5 }}>
          Click any popular grocery product below to inspect its full <b>3-Pillar Score (0–100)</b>, <b>Sugar &amp; refined-carb note</b>, watchlist additives, and <b>1-Tap Clean Swap</b> across Walmart, Target, Kroger, Shipt, DoorDash, Instacart, ALDI &amp; all 12 stores.
        </p>
      </section>

      <div style={{ display: "grid", gap: 16 }}>
        {items.map(({ entry, result, swap }) => {
          const ratingLabel = result.score >= 75 ? "Excellent" : result.score >= 50 ? "Mediocre" : "Poor";
          const pillBg = result.score >= 75 ? "#dcfce7" : result.score >= 50 ? "#fef3c7" : "#fee2e2";
          const pillFg = result.score >= 75 ? "#166534" : result.score >= 50 ? "#92400e" : "#991b1b";
          return (
            <Link
              key={entry.slug}
              href={`/swaps/${entry.slug}`}
              style={{
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: 18,
                padding: "18px 20px",
                textDecoration: "none",
                color: "#0f172a",
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                gap: 18,
                alignItems: "center",
              }}
            >
              <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/product-image?title=${encodeURIComponent(entry.title)}`}
                  alt={entry.title}
                  loading="lazy"
                  style={{
                    width: 64,
                    height: 64,
                    objectFit: "contain",
                    borderRadius: 12,
                    background: "#f8fafc",
                    border: "1px solid #e2e8f0",
                    padding: 4,
                    flexShrink: 0,
                  }}
                />
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: "#64748b", textTransform: "uppercase" }}>
                    {entry.category} · {entry.searchVolumeTag}
                  </span>
                  <h2 style={{ fontSize: 18, fontWeight: 900, margin: "4px 0 6px" }}>{entry.title}</h2>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <span
                      style={{
                        padding: "4px 10px",
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 800,
                        background: pillBg,
                        color: pillFg,
                      }}
                    >
                      {result.score}/100 · {ratingLabel}
                    </span>
                    {result.yukaBreakdown?.glucoseImpact && (
                      <span style={{ fontSize: 12, fontWeight: 700, color: "#475569" }}>
                        🩸 Sugar &amp; Carb Note: {result.yukaBreakdown.glucoseImpact}
                      </span>
                    )}
                  </div>
                  {result.flagged.length > 0 && (
                    <p style={{ fontSize: 12, color: "#b91c1c", margin: "8px 0 0", fontWeight: 700 }}>
                      Flags: {result.flagged.map((f) => f.name).join(", ")}
                    </p>
                  )}
                </div>
              </div>

              {swap ? (
                <div style={{ background: "#ecfdf5", border: "1.5px solid #6ee7b7", borderRadius: 14, padding: "14px 16px", display: "flex", gap: 12, alignItems: "center" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/product-image?title=${encodeURIComponent(swap.title)}`}
                    alt={swap.title}
                    loading="lazy"
                    style={{
                      width: 56,
                      height: 56,
                      objectFit: "contain",
                      borderRadius: 10,
                      background: "#ffffff",
                      border: "1px solid #a7f3d0",
                      padding: 4,
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <span style={{ fontSize: 11, fontWeight: 900, color: "#059669", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      ⇄ Recommended 1-for-1 Clean Swap ({swap.score}/100)
                    </span>
                    <b style={{ display: "block", fontSize: 15.5, color: "#064e3b", marginTop: 4 }}>{swap.title}</b>
                    <span style={{ fontSize: 12, color: "#047857", fontWeight: 700 }}>
                      Zero Seed Oils · Zero Artificial Dyes · View Full Comparison →
                    </span>
                  </div>
                </div>
              ) : (
                <div style={{ background: "#f0fdf4", border: "1.5px solid #86efac", borderRadius: 14, padding: "14px 16px" }}>
                  <span style={{ fontSize: 11, fontWeight: 900, color: "#15803d", textTransform: "uppercase" }}>
                    ✓ Clean Category Benchmark
                  </span>
                  <b style={{ display: "block", fontSize: 15, color: "#14532d", marginTop: 4 }}>
                    Zero Watchlist Additives Flagged — View 3-Pillar Breakdown →
                  </b>
                </div>
              )}
            </Link>
          );
        })}
      </div>

      <footer
        style={{
          marginTop: 28,
          padding: "14px 16px",
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: 14,
          fontSize: 12,
          color: "#64748b",
          lineHeight: 1.55,
        }}
      >
        <strong style={{ color: "#334155" }}>Independent Editorial Opinion &amp; Non-Affiliation Disclaimer:</strong>{" "}
        Scores and summaries in this directory reflect HeyBroc&apos;s subjective clean-label rubric based on representative public ingredient data (Open Food Facts, USDA FoodData Central). Manufacturers reformulate products frequently and ingredients may vary by region or batch—always verify the physical package label before purchasing. Most flagged additives are FDA-permitted or GRAS. Outbound retail links may include affiliate attribution tags that earn HeyBroc a commission at no extra cost to you. As an Amazon Associate, HeyBroc earns from qualifying purchases. HeyBroc is independent and is not affiliated with, endorsed by, or sponsored by Walmart, Target, Instacart, ALDI, Kroger, Costco, Sam&apos;s Club, BJ&apos;s, Amazon, Whole Foods Market, DoorDash, Uber Eats, Shipt, or any food or beverage manufacturer.
      </footer>
    </div>
  );
}
