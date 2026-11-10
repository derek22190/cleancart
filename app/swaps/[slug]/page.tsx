import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { hasValidCatalogProvenance } from "@/lib/drinks-catalog";
import { CATEGORY_LABELS, RISK_LABEL } from "@/lib/rubric";
import { SEO_PRODUCTS, evaluateSeoProduct } from "@/lib/seo-catalog";
import { resolveSwap, type RetailerId } from "@/lib/swaps";

export const revalidate = 86400;

const SEO_RETAILERS: Array<{ id: RetailerId; label: string }> = [
  { id: "walmart", label: "Walmart" },
  { id: "target", label: "Target" },
  { id: "kroger", label: "Kroger" },
  { id: "shipt", label: "Shipt" },
  { id: "doordash", label: "DoorDash" },
  { id: "instacart", label: "Instacart" },
  { id: "amazon", label: "Amazon Fresh" },
  { id: "costco", label: "Costco" },
];

export function generateStaticParams() {
  return SEO_PRODUCTS.filter((p) => hasValidCatalogProvenance(p.sourceUrl, p.verifiedAt)).map((p) => ({
    slug: p.slug,
  }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entry = SEO_PRODUCTS.find((p) => p.slug === slug && hasValidCatalogProvenance(p.sourceUrl, p.verifiedAt));
  if (!entry) return {};
  const { result, swap } = evaluateSeoProduct(entry);

  return {
    title: `${entry.title} Ingredients, ${result.score}/100 Score & Clean Swap`,
    description: `Editorial clean-label review of ${entry.title}: HeyBroc scores it ${result.score}/100 (${result.rating}) with ${result.flagged.length} watchlist ingredient flags${swap ? ` and recommends ${swap.title} (${swap.score}/100) as a 1-for-1 Clean Swap` : ""}. Includes Sugar & refined-carb note.`,
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
  const entry = SEO_PRODUCTS.find((p) => p.slug === slug && hasValidCatalogProvenance(p.sourceUrl, p.verifiedAt));
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
    description: `Independent clean-label opinion and 0–100 ingredient analysis for ${entry.title} (representative formulation — verify physical package label). Ingredients: ${entry.ingredients}`,
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
          {entry.category} · {entry.brand} · Independent Editorial Report
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
              background: result.score >= 75 ? "#dcfce7" : result.score >= 50 ? "#fef3c7" : "#fee2e2",
              color: result.score >= 75 ? "#166534" : result.score >= 50 ? "#92400e" : "#991b1b",
            }}
          >
            {result.score}/100 · {result.rating}
          </span>
          {yb?.glucoseImpact && (
            <span
              style={{
                padding: "7px 14px",
                borderRadius: 999,
                fontSize: 13,
                fontWeight: 800,
                background:
                  yb.glucoseImpact === "Low Sugar / Carb" || yb.glucoseImpact === "No Added Sugar in Ingredients"
                    ? "#dcfce7"
                    : yb.glucoseImpact === "Moderate Sugar / Carb"
                      ? "#fef3c7"
                      : "#fee2e2",
                color:
                  yb.glucoseImpact === "Low Sugar / Carb" || yb.glucoseImpact === "No Added Sugar in Ingredients"
                    ? "#166534"
                    : yb.glucoseImpact === "Moderate Sugar / Carb"
                      ? "#92400e"
                      : "#991b1b",
              }}
            >
              🩸 Sugar &amp; refined-carb note: {yb.glucoseImpact} · 🔥 {yb.calorieNote}
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
              {swap.title} — {swap.score}/100 ({swap.score >= 75 ? "Excellent" : swap.score >= 50 ? "Mediocre" : "Poor"})
            </h2>
            <p style={{ fontSize: 13.5, color: "#065f46", margin: "4px 0 10px" }}>
              <b>Representative Ingredients:</b> {swap.ingredients}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {SEO_RETAILERS.map((r) => {
                const storeSwap =
                  resolveSwap({
                    score: result.score,
                    productTitle: entry.title,
                    ingredients: entry.ingredients,
                    store: r.id,
                  }) ?? swap;
                return (
                  <a
                    key={r.id}
                    href={storeSwap.webUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: "inline-block",
                      padding: r.id === "walmart" ? "9px 16px" : "8px 13px",
                      borderRadius: 999,
                      background: r.id === "walmart" ? "#059669" : "#ffffff",
                      border: "1px solid #059669",
                      color: r.id === "walmart" ? "#ffffff" : "#065f46",
                      fontWeight: 800,
                      fontSize: 12.5,
                      textDecoration: "none",
                    }}
                  >
                    Shop on {r.label}
                    {storeSwap.brand !== swap.brand ? ` (${storeSwap.brand})` : ""} ↗
                    {storeSwap.isPaidLink ? " · paid link" : ""}
                  </a>
                );
              })}
            </div>
            <span style={{ display: "block", fontSize: 11, color: "#047857", marginTop: 6 }}>
              Affiliate disclosure: HeyBroc may earn a commission on qualifying retail purchases at no extra cost to you. As an Amazon Associate, HeyBroc earns from qualifying purchases. Not affiliated with Walmart, Target, Kroger, Shipt, DoorDash, or any brand shown.
            </span>
          </div>
        )}

        {/* 3-Pillar + Sugar & Refined-Carb Note */}
        {yb && (
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 16, padding: "16px 18px", marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#64748b", letterSpacing: "0.06em", textTransform: "uppercase" }}>
              3-PILLAR SCORE BREAKDOWN
            </div>
            <div style={{ fontSize: 14.5, fontWeight: 800, marginTop: 6 }}>
              🥗 Nutritional Quality: {yb.nutritionScore}/60 (Nutri-Score {yb.nutriScoreGrade}) &nbsp;·&nbsp; 🧪 Clean-Label Additives: {yb.additiveScore}/30 &nbsp;·&nbsp; 🌱 Organic Bonus: {yb.organicScore}/10
            </div>
            <div style={{ borderTop: "1px solid #e2e8f0", marginTop: 10, paddingTop: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#64748b", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                SUGAR &amp; REFINED-CARB NOTE
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
            ✓ Zero watchlist additives, refined seed oils, or synthetic food dyes detected.
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
        <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 14px", marginBottom: 20 }}>
          <b style={{ fontSize: 12, color: "#64748b", textTransform: "uppercase", display: "block", marginBottom: 4 }}>
            Representative Ingredient List (Verify Physical Package Label):
          </b>
          <p style={{ fontSize: 13, color: "#334155", margin: 0, lineHeight: 1.55 }}>{entry.ingredients}</p>
          <p style={{ fontSize: 11.5, color: "#64748b", margin: "8px 0 0", lineHeight: 1.45 }}>
            <strong>Editorial Opinion &amp; Label Verification Notice:</strong> Scores and explanations reflect HeyBroc&apos;s subjective clean-label rubric for informational comparison only and are not medical, nutritional, or regulatory safety determinations. Most flagged ingredients are permitted for food use or recognized as GRAS by the U.S. FDA. Manufacturers reformulate products periodically and ingredients may vary by region or batch—always check the physical product package. HeyBroc is independent and is not affiliated with, endorsed by, or sponsored by {entry.brand}, Walmart, Target, Kroger, Shipt, DoorDash, or any retailer or manufacturer.
          </p>
        </div>

        {/* Mid-Page Reader-Stop App Conversion CTA (Vaultaire SEO Playbook) */}
        <div
          style={{
            background: "linear-gradient(135deg, #064e3b 0%, #0f766e 100%)",
            color: "#ffffff",
            borderRadius: 18,
            padding: "20px 22px",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div style={{ flex: "1 1 320px" }}>
            <span style={{ fontSize: 11, fontWeight: 900, color: "#86efac", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              🥦 Auto-Grade Your Online Grocery App
            </span>
            <h3 style={{ fontSize: 19, fontWeight: 900, margin: "4px 0 6px" }}>
              Stop Googling ingredients one by one.
            </h3>
            <p style={{ fontSize: 13.5, color: "#d1fae5", margin: 0, lineHeight: 1.45 }}>
              HeyBroc floats over Walmart, Target, Kroger, Shipt, DoorDash, Sam&apos;s Club, Costco, BJ&apos;s, ALDI, Amazon Fresh &amp; Instacart to grade every item (0–100) and find 1-for-1 Clean Swaps in 1 tap.
            </p>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <a
              href="/heybroc.apk"
              style={{
                padding: "11px 18px",
                borderRadius: 999,
                background: "#22c55e",
                color: "#052e16",
                fontWeight: 900,
                fontSize: 13.5,
                textDecoration: "none",
              }}
            >
              📲 Download Android App (.APK)
            </a>
            <Link
              href="/"
              style={{
                padding: "11px 18px",
                borderRadius: 999,
                background: "rgba(255,255,255,0.14)",
                border: "1px solid rgba(255,255,255,0.28)",
                color: "#ffffff",
                fontWeight: 800,
                fontSize: 13.5,
                textDecoration: "none",
              }}
            >
              Open Web &amp; iOS Scanner →
            </Link>
          </div>
        </div>
      </article>

      {/* Internal SEO Link Mesh — Related Product Reports */}
      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 18, fontWeight: 900, marginBottom: 12 }}>
          More Grocery Ingredient Reports &amp; 1-for-1 Clean Swaps
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: 12,
          }}
        >
          {SEO_PRODUCTS.filter((p) => p.slug !== entry.slug && hasValidCatalogProvenance(p.sourceUrl, p.verifiedAt))
            .slice(0, 9)
            .map((rel) => {
              const evalRel = evaluateSeoProduct(rel);
              return (
                <Link
                  key={rel.slug}
                  href={`/swaps/${rel.slug}`}
                  style={{
                    display: "block",
                    background: "#ffffff",
                    border: "1px solid #e2e8f0",
                    borderRadius: 14,
                    padding: "14px 16px",
                    textDecoration: "none",
                    color: "#0f172a",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: "#16a34a", textTransform: "uppercase" }}>
                      {rel.category}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 900,
                        padding: "2px 9px",
                        borderRadius: 999,
                        background: evalRel.result.score >= 70 ? "#dcfce7" : "#fee2e2",
                        color: evalRel.result.score >= 70 ? "#166534" : "#991b1b",
                      }}
                    >
                      {evalRel.result.score}/100
                    </span>
                  </div>
                  <b style={{ display: "block", fontSize: 14.5, marginTop: 6, lineHeight: 1.3 }}>
                    {rel.title}
                  </b>
                  {evalRel.swap && (
                    <span style={{ display: "block", fontSize: 12, color: "#059669", fontWeight: 700, marginTop: 4 }}>
                      ⇄ Swap: {evalRel.swap.title} ({evalRel.swap.score}/100)
                    </span>
                  )}
                </Link>
              );
            })}
        </div>
      </section>
    </div>
  );
}
