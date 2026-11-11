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
  { id: "amazon", label: "Amazon Fresh" },
  { id: "kroger", label: "Kroger" },
  { id: "sams", label: "Sam's Club" },
  { id: "costco", label: "Costco" },
  { id: "aldi", label: "ALDI" },
  { id: "bjs", label: "BJ's" },
  { id: "instacart", label: "Instacart" },
  { id: "shipt", label: "Shipt" },
  { id: "doordash", label: "DoorDash" },
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
  const canonicalRating = result.score >= 75 ? "Excellent" : result.score >= 50 ? "Mediocre" : "Poor";

  return {
    title: `${entry.title} Ingredients, ${result.score}/100 Score & Clean Swap`,
    description: `Editorial clean-label review of ${entry.title}: HeyBroc scores it ${result.score}/100 (${canonicalRating}) with ${result.flagged.length} watchlist ingredient flags${swap ? ` and recommends ${swap.title} (${swap.score}/100) as a 1-for-1 Clean Swap` : ""}. Includes Sugar & refined-carb note.`,
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
  const canonicalRating = result.score >= 75 ? "Excellent" : result.score >= 50 ? "Mediocre" : "Poor";
  const yb = result.yukaBreakdown;
  const productImgSrc = `/api/product-image?title=${encodeURIComponent(entry.title)}`;

  const productJsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: entry.title,
    image: `https://www.heybroc.com${productImgSrc}`,
    brand: {
      "@type": "Brand",
      name: entry.brand,
    },
    category: entry.category,
    description: `Independent clean-label opinion and 0–100 ingredient analysis for ${entry.title} (representative formulation — verify physical package label). Ingredients: ${entry.ingredients}`,
  };

  const primaryRetailers = SEO_RETAILERS.slice(0, 3);
  const extraRetailers = SEO_RETAILERS.slice(3);

  return (
    <div
      style={{
        maxWidth: 840,
        margin: "0 auto",
        padding: "14px 16px 40px",
        fontFamily: "var(--font-sans), system-ui, sans-serif",
        color: "#0f172a",
      }}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd) }}
      />

      {/* Clean Single-Row Header */}
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
          href="/swaps"
          style={{
            fontSize: 13,
            fontWeight: 800,
            color: "#15803d",
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          ← All Swaps
        </Link>
        <div style={{ display: "flex", gap: 7, flexShrink: 0 }}>
          <Link
            href="/tools"
            style={{
              padding: "7px 12px",
              borderRadius: 999,
              background: "#f8fafc",
              border: "1px solid #cbd5e1",
              color: "#0f172a",
              fontWeight: 800,
              fontSize: 12,
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            🧪 Grader
          </Link>
          <Link
            href="/"
            style={{
              padding: "7px 13px",
              borderRadius: 999,
              background: "#16a34a",
              color: "#ffffff",
              fontWeight: 800,
              fontSize: 12,
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            Live Scanner →
          </Link>
        </div>
      </header>

      {/* Main Product Report Card */}
      <article
        style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: 20,
          padding: "18px",
          boxShadow: "0 8px 24px rgba(15,23,42,0.04)",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 14,
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: 14,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={productImgSrc}
            alt={entry.title}
            style={{
              width: 76,
              height: 76,
              objectFit: "contain",
              borderRadius: 14,
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              padding: 5,
              flexShrink: 0,
            }}
          />
          <div style={{ flex: "1 1 220px", minWidth: 0 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 800,
                color: "#16a34a",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              {entry.category} · {entry.brand}
            </span>
            <h1
              style={{
                fontSize: 22,
                fontWeight: 900,
                margin: "3px 0 8px",
                lineHeight: 1.2,
              }}
            >
              {entry.title}
            </h1>

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span
                style={{
                  padding: "5px 12px",
                  borderRadius: 999,
                  fontSize: 15,
                  fontWeight: 900,
                  background:
                    result.score >= 75 ? "#dcfce7" : result.score >= 50 ? "#fef3c7" : "#fee2e2",
                  color:
                    result.score >= 75 ? "#166534" : result.score >= 50 ? "#92400e" : "#991b1b",
                }}
              >
                {result.score}/100 · {canonicalRating}
              </span>
              {yb && (
                <span style={{ fontSize: 12, fontWeight: 700, color: "#475569" }}>
                  Nutrition {yb.nutritionScore}/60 · Additives {yb.additiveScore}/30 · Organic{" "}
                  {yb.organicScore}/10
                </span>
              )}
            </div>
          </div>
        </div>

        {/* 1-Tap Clean Swap Callout */}
        {swap && (
          <div
            style={{
              background: "#ecfdf5",
              border: "1.5px solid #34d399",
              borderRadius: 16,
              padding: "14px",
              marginBottom: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 12,
                alignItems: "center",
                flexWrap: "wrap",
                marginBottom: 10,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/product-image?title=${encodeURIComponent(swap.title)}`}
                alt={swap.title}
                loading="lazy"
                style={{
                  width: 58,
                  height: 58,
                  objectFit: "contain",
                  borderRadius: 11,
                  background: "#ffffff",
                  border: "1px solid #a7f3d0",
                  padding: 3,
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 900,
                    color: "#059669",
                    textTransform: "uppercase",
                  }}
                >
                  ⇄ Recommended 1-for-1 Clean Swap ({swap.score}/100)
                </span>
                <h2 style={{ fontSize: 17, fontWeight: 900, color: "#064e3b", margin: "2px 0" }}>
                  {swap.title}
                </h2>
                <p style={{ fontSize: 12, color: "#065f46", margin: 0, lineHeight: 1.4 }}>
                  {swap.ingredients}
                </p>
              </div>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "center" }}>
              {primaryRetailers.map((r) => {
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
                      padding: "7px 13px",
                      borderRadius: 999,
                      background: r.id === "walmart" ? "#059669" : "#ffffff",
                      border: "1px solid #059669",
                      color: r.id === "walmart" ? "#ffffff" : "#065f46",
                      fontWeight: 800,
                      fontSize: 12,
                      textDecoration: "none",
                    }}
                  >
                    Shop {r.label} ↗{storeSwap.isPaidLink ? " · paid link" : ""}
                  </a>
                );
              })}

              <details style={{ display: "inline-block" }}>
                <summary
                  style={{
                    listStyle: "none",
                    padding: "7px 12px",
                    borderRadius: 999,
                    background: "#ffffff",
                    border: "1px solid #86efac",
                    color: "#065f46",
                    fontWeight: 800,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  +{extraRetailers.length} more stores ▾
                </summary>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  {extraRetailers.map((r) => {
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
                          padding: "6px 11px",
                          borderRadius: 999,
                          background: "#ffffff",
                          border: "1px solid #86efac",
                          color: "#065f46",
                          fontWeight: 800,
                          fontSize: 11.5,
                          textDecoration: "none",
                        }}
                      >
                        {r.label} ↗{storeSwap.isPaidLink ? " · paid link" : ""}
                      </a>
                    );
                  })}
                </div>
              </details>
            </div>
            <span style={{ display: "block", fontSize: 10.5, color: "#047857", marginTop: 6 }}>
              Paid retail links may earn HeyBroc a commission at no extra cost. As an Amazon Associate, HeyBroc earns from qualifying purchases.
            </span>
          </div>
        )}

        {/* Flagged Additives */}
        <h2 style={{ fontSize: 15.5, fontWeight: 900, marginBottom: 8 }}>
          Flagged Ingredients ({result.flagged.length})
        </h2>
        {result.flagged.length === 0 ? (
          <div
            style={{
              background: "#dcfce7",
              color: "#166534",
              padding: "10px 12px",
              borderRadius: 11,
              fontWeight: 800,
              fontSize: 13,
              marginBottom: 14,
            }}
          >
            ✓ Zero watchlist additives, refined seed oils, or synthetic food dyes detected.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8, marginBottom: 14 }}>
            {result.flagged.map((f) => (
              <div
                key={f.id}
                style={{
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  borderRadius: 11,
                  padding: "9px 12px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    fontWeight: 800,
                    fontSize: 13,
                  }}
                >
                  <span>
                    {f.name} ({CATEGORY_LABELS[f.category]})
                  </span>
                  <span style={{ color: "#dc2626", flexShrink: 0 }}>
                    {RISK_LABEL[f.risk]} · −{f.penalty}
                  </span>
                </div>
                <p style={{ fontSize: 12, color: "#475569", margin: "3px 0 0", lineHeight: 1.45 }}>
                  {f.explanation}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Collapsible Raw Ingredients & Editorial Notice */}
        <details
          style={{
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: 12,
            padding: "9px 12px",
          }}
        >
          <summary style={{ fontSize: 12, fontWeight: 800, color: "#475569", cursor: "pointer" }}>
            Full Ingredient Label &amp; Editorial Verification Notice
          </summary>
          <p style={{ fontSize: 12.5, color: "#334155", margin: "8px 0 6px", lineHeight: 1.5 }}>
            {entry.ingredients}
          </p>
          {yb?.glucoseNote && (
            <p style={{ fontSize: 12, color: "#475569", margin: "0 0 6px" }}>
              <b>Sugar &amp; refined-carb note:</b> {yb.glucoseNote}
            </p>
          )}
          <p style={{ fontSize: 11, color: "#64748b", margin: 0, lineHeight: 1.45 }}>
            Scores and explanations reflect HeyBroc&apos;s subjective clean-label rubric for
            informational comparison only and are not medical, nutritional, or regulatory safety
            determinations. Most flagged ingredients are FDA-permitted or GRAS. Always verify the
            physical product package. HeyBroc is independent and not affiliated with {entry.brand} or
            any retailer.
          </p>
        </details>
      </article>

      {/* Compact Related Swaps (4 items instead of 9) */}
      <section style={{ marginTop: 18 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <h2 style={{ fontSize: 15.5, fontWeight: 900, margin: 0 }}>More Clean Swaps</h2>
          <Link
            href="/swaps"
            style={{ fontSize: 12.5, fontWeight: 800, color: "#16a34a", textDecoration: "none" }}
          >
            View all →
          </Link>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 8,
          }}
        >
          {SEO_PRODUCTS.filter(
            (p) => p.slug !== entry.slug && hasValidCatalogProvenance(p.sourceUrl, p.verifiedAt)
          )
            .slice(0, 4)
            .map((rel) => {
              const evalRel = evaluateSeoProduct(rel);
              return (
                <Link
                  key={rel.slug}
                  href={`/swaps/${rel.slug}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    background: "#ffffff",
                    border: "1px solid #e2e8f0",
                    borderRadius: 12,
                    padding: "10px 12px",
                    textDecoration: "none",
                    color: "#0f172a",
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/product-image?title=${encodeURIComponent(rel.title)}`}
                    alt={rel.title}
                    loading="lazy"
                    style={{
                      width: 38,
                      height: 38,
                      objectFit: "contain",
                      borderRadius: 8,
                      background: "#f8fafc",
                      border: "1px solid #e2e8f0",
                      padding: 2,
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <b
                      style={{
                        display: "block",
                        fontSize: 13,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {rel.title}
                    </b>
                    <span style={{ fontSize: 11.5, color: "#059669", fontWeight: 700 }}>
                      {evalRel.result.score}/100
                      {evalRel.swap ? ` → ${evalRel.swap.score}/100 Swap` : ""}
                    </span>
                  </div>
                </Link>
              );
            })}
        </div>
      </section>
    </div>
  );
}
