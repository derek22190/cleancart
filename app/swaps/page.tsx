import type { Metadata } from "next";
import Link from "next/link";
import { SEO_PRODUCTS, evaluateSeoProduct } from "@/lib/seo-catalog";

export const metadata: Metadata = {
  title: "Clean Grocery Swaps Directory (Seed-Oil Free & Dye-Free Alternatives)",
  description:
    "Browse 1-for-1 healthier grocery swaps and 0–100 ingredient reports for popular snacks, dressings, cereals, yogurts, deli meats, and condiments on Walmart, Target, Instacart & ALDI.",
  alternates: {
    canonical: "https://www.heybroc.com/swaps",
  },
};

export default function SwapsDirectoryPage() {
  const items = SEO_PRODUCTS.map((p) => evaluateSeoProduct(p));

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
          Clean Grocery Swaps &amp; Ingredient Safety Reports (0–100)
        </h1>
        <p style={{ fontSize: 15, color: "#d1fae5", maxWidth: 740, lineHeight: 1.5 }}>
          Click any popular grocery product below to inspect its full <b>3-Pillar Score (0–100)</b>, <b>Sugar &amp; refined-carb note</b>, flagged chemical additives, and verified <b>1-Tap Clean Swap</b>.
        </p>
      </section>

      <div style={{ display: "grid", gap: 16 }}>
        {items.map(({ entry, result, swap }) => (
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
            <div>
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
                    background: result.score >= 70 ? "#dcfce7" : "#fee2e2",
                    color: result.score >= 70 ? "#166534" : "#991b1b",
                  }}
                >
                  {result.score}/100 · {result.score < 25 ? "Bad" : result.rating}
                </span>
                {result.yukaBreakdown?.glucoseImpact && (
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#475569" }}>
                    🩸 Glucose: {result.yukaBreakdown.glucoseImpact}
                  </span>
                )}
              </div>
              {result.flagged.length > 0 && (
                <p style={{ fontSize: 12, color: "#b91c1c", margin: "8px 0 0", fontWeight: 700 }}>
                  Flags: {result.flagged.map((f) => f.name).join(", ")}
                </p>
              )}
            </div>

            {swap ? (
              <div style={{ background: "#ecfdf5", border: "1.5px solid #6ee7b7", borderRadius: 14, padding: "14px 16px" }}>
                <span style={{ fontSize: 11, fontWeight: 900, color: "#059669", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  ⇄ Recommended 1-for-1 Clean Swap ({swap.score}/100)
                </span>
                <b style={{ display: "block", fontSize: 15.5, color: "#064e3b", marginTop: 4 }}>{swap.title}</b>
                <span style={{ fontSize: 12, color: "#047857", fontWeight: 700 }}>
                  Zero Seed Oils · Zero Artificial Dyes · View Full Comparison →
                </span>
              </div>
            ) : (
              <div style={{ background: "#f0fdf4", border: "1.5px solid #86efac", borderRadius: 14, padding: "14px 16px" }}>
                <span style={{ fontSize: 11, fontWeight: 900, color: "#15803d", textTransform: "uppercase" }}>
                  ✓ Clean Category Benchmark
                </span>
                <b style={{ display: "block", fontSize: 15, color: "#14532d", marginTop: 4 }}>
                  Zero Hazardous Additives Flagged — View 3-Pillar Breakdown →
                </b>
              </div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
