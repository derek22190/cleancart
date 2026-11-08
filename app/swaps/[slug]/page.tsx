import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CATEGORY_LABELS, RISK_LABEL } from "@/lib/rubric";
import { SEO_PRODUCTS, evaluateSeoProduct } from "@/lib/seo-catalog";

export function generateStaticParams() {
  return SEO_PRODUCTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entry = SEO_PRODUCTS.find((p) => p.slug === slug);
  if (!entry) return {};
  const { result, swap } = evaluateSeoProduct(entry);

  return {
    title: `${entry.title} Ingredients, ${result.score}/100 Score & Clean Swap`,
    description: `Is ${entry.title} healthy? HeyBroc scores it ${result.score}/100 (${result.score < 25 ? "Bad" : result.rating}) with ${result.flagged.length} ingredient flags${swap ? ` and recommends ${swap.title} (${swap.score}/100) as a 1-for-1 Clean Swap` : ""}. Includes Blood Sugar & PCOS impact.`,
    alternates: {
      canonical: `https://www.heybroc.com/swaps/${entry.slug}`,
    },
  };
}

export default async function SwapReportPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entry = SEO_PRODUCTS.find((p) => p.slug === slug);
  if (!entry) notFound();

  const { result, swap } = evaluateSeoProduct(entry);
  const yb = result.yukaBreakdown;

  const productJsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: entry.title,
    brand: {
      "@type": "Brand",
      name: entry.brand,
    },
    category: entry.category,
    description: `Ingredient safety analysis and 0–100 health score for ${entry.title}. Ingredients: ${entry.ingredients}`,
    review: {
      "@type": "Review",
      author: {
        "@type": "Organization",
        name: "HeyBroc - Online Food Scanner",
      },
      reviewRating: {
        "@type": "Rating",
        ratingValue: result.score,
        bestRating: 100,
        worstRating: 0,
      },
      reviewBody: `${entry.title} scores ${result.score}/100 (${result.score < 25 ? "Bad" : result.rating}) on HeyBroc's 3-Pillar Rubric (Nutrition ${yb?.nutritionScore}/60, Additives ${yb?.additiveScore}/30, Organic ${yb?.organicScore}/10). ${yb?.glucoseNote || ""}`,
    },
  };

  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: "28px 18px 64px", fontFamily: "var(--font-sans), system-ui, sans-serif", color: "#0f172a" }}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd) }}
      />

      {/* Header */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 24 }}>
        <Link href="/swaps" style={{ fontSize: 13.5, fontWeight: 800, color: "#15803d", textDecoration: "none" }}>
          ← All Clean Swaps &amp; Product Reports
        </Link>
        <div style={{ display: "flex", gap: 10 }}>
          <Link
            href="/tools"
            style={{ padding: "8px 14px", borderRadius: 999, background: "#f8fafc", border: "1px solid #cbd5e1", color: "#0f172a", fontWeight: 800, fontSize: 12.5, textDecoration: "none" }}
          >
            🧪 Paste Custom Label
          </Link>
          <Link
            href="/"
            style={{ padding: "8px 14px", borderRadius: 999, background: "#16a34a", color: "#ffffff", fontWeight: 800, fontSize: 12.5, textDecoration: "none" }}
          >
            Try Live Store Scanner →
          </Link>
        </div>
      </header>

      {/* Main Product Hero Card */}
      <article style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 22, padding: "24px", boxShadow: "0 10px 28px rgba(15,23,42,0.05)" }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, color: "#16a34a", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {entry.category} · {entry.brand} · Independent Ingredient Report
        </span>
        <h1 style={{ fontSize: 28, fontWeight: 900, margin: "6px 0 12px", lineHeight: 1.2 }}>
          {entry.title} — Ingredients, Score &amp; Clean Swap
        </h1>

        {/* Score Pill */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
          <span
            style={{
              padding: "8px 16px",
              borderRadius: 999,
              fontSize: 18,
              fontWeight: 900,
              background: result.score >= 70 ? "#dcfce7" : "#fee2e2",
              color: result.score >= 70 ? "#166534" : "#991b1b",
            }}
          >
            {result.score}/100 · {result.score < 25 ? "Bad" : result.rating}
          </span>
          {yb?.glucoseImpact && (
            <span
              style={{
                padding: "7px 14px",
                borderRadius: 999,
                fontSize: 13,
                fontWeight: 800,
                background:
                  yb.glucoseImpact === "Low Spike"
                    ? "#dcfce7"
                    : yb.glucoseImpact === "Moderate Spike"
                      ? "#fef3c7"
                      : "#fee2e2",
                color:
                  yb.glucoseImpact === "Low Spike"
                    ? "#166534"
                    : yb.glucoseImpact === "Moderate Spike"
                      ? "#92400e"
                      : "#991b1b",
              }}
            >
              🩸 Blood Sugar Impact: {yb.glucoseImpact} · 🔥 {yb.calorieNote}
            </span>
          )}
        </div>

        {/* 1-Tap Clean Swap Callout */}
        {swap && (
          <div style={{ background: "#ecfdf5", border: "2px solid #34d399", borderRadius: 16, padding: "16px 18px", marginBottom: 20 }}>
            <span style={{ fontSize: 11, fontWeight: 900, color: "#059669", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              ⇄ Recommended 1-for-1 Clean Swap ({swap.category})
            </span>
            <h2 style={{ fontSize: 20, fontWeight: 900, color: "#064e3b", margin: "4px 0" }}>
              {swap.title} — {swap.score}/100 (Excellent)
            </h2>
            <p style={{ fontSize: 13.5, color: "#065f46", margin: "4px 0 10px" }}>
              <b>Clean Ingredients:</b> {swap.ingredients}
            </p>
            <a
              href={swap.webUrl}
              target="_blank"
              rel="noreferrer"
              style={{ display: "inline-block", padding: "9px 16px", borderRadius: 999, background: "#059669", color: "#ffffff", fontWeight: 800, fontSize: 13, textDecoration: "none" }}
            >
              Shop Clean Swap on Walmart ↗
            </a>
          </div>
        )}

        {/* 3-Pillar + Blood Sugar & PCOS Breakdown */}
        {yb && (
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 16, padding: "16px 18px", marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#64748b", letterSpacing: "0.06em", textTransform: "uppercase" }}>
              3-PILLAR SCORE BREAKDOWN
            </div>
            <div style={{ fontSize: 14.5, fontWeight: 800, marginTop: 6 }}>
              🥗 Nutritional Quality: {yb.nutritionScore}/60 (Nutri-Score {yb.nutriScoreGrade}) &nbsp;·&nbsp; 🧪 Additive Safety: {yb.additiveScore}/30 &nbsp;·&nbsp; 🌱 Organic Bonus: {yb.organicScore}/10
            </div>
            <div style={{ borderTop: "1px solid #e2e8f0", marginTop: 10, paddingTop: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#64748b", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                BLOOD SUGAR, PCOS &amp; METABOLIC INSIGHT
              </div>
              <p style={{ fontSize: 13.5, color: "#334155", margin: "4px 0 0", lineHeight: 1.5 }}>
                {yb.glucoseNote}
              </p>
            </div>
          </div>
        )}

        {/* Flagged Additives */}
        <h2 style={{ fontSize: 17, fontWeight: 900, marginBottom: 10 }}>
          Flagged Additives &amp; Ingredients ({result.flagged.length})
        </h2>
        {result.flagged.length === 0 ? (
          <div style={{ background: "#dcfce7", color: "#166534", padding: "12px 14px", borderRadius: 12, fontWeight: 800, fontSize: 13.5, marginBottom: 18 }}>
            ✓ Zero hazardous chemical additives, refined seed oils, or synthetic food dyes detected.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10, marginBottom: 20 }}>
            {result.flagged.map((f) => (
              <div key={f.id} style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 12, padding: "12px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800, fontSize: 14 }}>
                  <span>{f.name} ({CATEGORY_LABELS[f.category]})</span>
                  <span style={{ color: "#dc2626" }}>{RISK_LABEL[f.risk]} · −{f.penalty} pts</span>
                </div>
                <p style={{ fontSize: 12.5, color: "#475569", margin: "4px 0 0", lineHeight: 1.5 }}>{f.explanation}</p>
              </div>
            ))}
          </div>
        )}

        {/* Full Ingredients Text */}
        <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 14px" }}>
          <b style={{ fontSize: 12, color: "#64748b", textTransform: "uppercase", display: "block", marginBottom: 4 }}>
            Full Published Ingredients List:
          </b>
          <p style={{ fontSize: 13, color: "#334155", margin: 0, lineHeight: 1.55 }}>{entry.ingredients}</p>
        </div>
      </article>
    </div>
  );
}
