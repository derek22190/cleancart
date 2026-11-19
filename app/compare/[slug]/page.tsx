import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { COMPETITOR_COMPARISONS, getComparisonBySlug } from "@/lib/comparisons";
import { PRESETS } from "@/lib/presets";
import { scoreProductYuka } from "@/lib/rubric";
import { resolveSwap } from "@/lib/swaps";

export function generateStaticParams() {
  return COMPETITOR_COMPARISONS.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const comp = getComparisonBySlug(slug);
  if (!comp) {
    return {
      title: "Comparison Not Found",
      robots: { index: false, follow: false },
    };
  }
  const canonical = `https://www.heybroc.com/compare/${comp.slug}`;
  return {
    title: comp.seoTitle,
    description: comp.seoDescription,
    alternates: { canonical },
    openGraph: {
      type: "article",
      url: canonical,
      siteName: "HeyBroc",
      title: comp.seoTitle,
      description: comp.seoDescription,
      images: ["/og-banner.png"],
    },
    twitter: {
      card: "summary_large_image",
      title: comp.seoTitle,
      description: comp.seoDescription,
      images: ["/og-banner.png"],
    },
  };
}

export default async function CompetitorComparisonPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const comp = getComparisonBySlug(slug);
  if (!comp) notFound();

  const demoPreset = PRESETS.find((p) => p.id === comp.demoPresetId) ?? PRESETS[0];
  const liveScore = scoreProductYuka(demoPreset.ingredients, {}, [], {
    ...demoPreset.nutrition,
    productTitle: `${demoPreset.brand} ${demoPreset.title}`,
  });
  const liveSwap = resolveSwap({
    score: liveScore.score,
    productTitle: `${demoPreset.brand} ${demoPreset.title}`,
    ingredients: demoPreset.ingredients,
    category: demoPreset.category,
    store: "walmart",
    watchlist: {},
  });

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: comp.faqs.map((f) => ({
      "@type": "Question",
      name: f.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: f.answer,
      },
    })),
  };

  const siblings = COMPETITOR_COMPARISONS.filter((c) => c.slug !== comp.slug);

  return (
    <div
      style={{
        maxWidth: 900,
        margin: "0 auto",
        padding: "16px 16px 56px",
        fontFamily: "var(--font-sans), system-ui, sans-serif",
        color: "#0f172a",
      }}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />

      {/* Top Bar */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 18,
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
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/broc-mascot.png"
            alt="HeyBroc"
            style={{ width: 36, height: 36, objectFit: "contain", flexShrink: 0 }}
          />
          <b style={{ fontSize: 18, fontWeight: 900, letterSpacing: "-0.02em" }}>HeyBroc</b>
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Link
            href="/compare"
            style={{
              padding: "7px 12px",
              borderRadius: 999,
              background: "#f8fafc",
              border: "1px solid #cbd5e1",
              color: "#0f172a",
              fontWeight: 800,
              fontSize: 12.5,
              textDecoration: "none",
            }}
          >
            All Comparisons
          </Link>
          <Link
            href={`/test?angle=${comp.recommendedAngle}`}
            style={{
              padding: "8px 14px",
              borderRadius: 999,
              background: "#0f7a4a",
              color: "#ffffff",
              fontWeight: 800,
              fontSize: 12.5,
              textDecoration: "none",
            }}
          >
            ⚡ Try Free Score Test
          </Link>
        </div>
      </header>

      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" style={{ fontSize: 12.5, color: "#64748b", marginBottom: 12 }}>
        <Link href="/" style={{ color: "#475569", textDecoration: "none" }}>
          Home
        </Link>{" "}
        /{" "}
        <Link href="/compare" style={{ color: "#475569", textDecoration: "none" }}>
          Compare
        </Link>{" "}
        / <strong style={{ color: "#0f172a" }}>HeyBroc vs. {comp.competitorName}</strong>
      </nav>

      {/* Hero */}
      <section
        style={{
          background: "linear-gradient(180deg, #f0fdf4 0%, #ffffff 100%)",
          border: "1.5px solid #bbf7d0",
          borderRadius: 24,
          padding: "24px 22px",
          marginBottom: 22,
        }}
      >
        <p
          style={{
            margin: "0 0 6px",
            fontSize: 11.5,
            fontWeight: 800,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "#0f7a4a",
          }}
        >
          {comp.heroEyebrow}
        </p>
        <h1
          style={{
            margin: "0 0 10px",
            fontSize: 27,
            fontWeight: 900,
            lineHeight: 1.2,
            letterSpacing: "-0.025em",
          }}
        >
          {comp.heroHeadline}
        </h1>
        <p style={{ margin: "0 0 16px", fontSize: 15, lineHeight: 1.6, color: "#334155" }}>
          {comp.heroSummary}
        </p>

        {/* Quick AEO Verdict */}
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #d1fae5",
            borderRadius: 16,
            padding: "14px 16px",
            marginBottom: 16,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 800, color: "#0f7a4a", marginBottom: 4 }}>
            QUICK VERDICT
          </div>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: "#1e293b" }}>
            {comp.quickVerdict}
          </p>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link
            href={`/test?angle=${comp.recommendedAngle}`}
            style={{
              padding: "11px 18px",
              borderRadius: 999,
              background: "#0f7a4a",
              color: "#ffffff",
              fontWeight: 800,
              fontSize: 14,
              textDecoration: "none",
            }}
          >
            Test Your First Food Free (No Sign-Up) →
          </Link>
          <Link
            href="/tools"
            style={{
              padding: "11px 16px",
              borderRadius: 999,
              background: "#ffffff",
              border: "1px solid #cbd5e1",
              color: "#0f172a",
              fontWeight: 700,
              fontSize: 13.5,
              textDecoration: "none",
            }}
          >
            Paste Any Ingredient Label Free
          </Link>
        </div>
      </section>

      {/* Side-by-Side Feature Table */}
      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 20, fontWeight: 900, margin: "0 0 12px" }}>
          Feature-by-Feature: HeyBroc vs. {comp.competitorName}
        </h2>
        <div
          style={{
            overflowX: "auto",
            borderRadius: 18,
            border: "1px solid #e2e8f0",
            background: "#ffffff",
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13.5,
              minWidth: 560,
            }}
          >
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", textAlign: "left" }}>
                <th style={{ padding: "12px 14px", fontWeight: 800, width: "26%" }}>Capability</th>
                <th style={{ padding: "12px 14px", fontWeight: 900, color: "#065f46", width: "37%" }}>
                  🥦 HeyBroc
                </th>
                <th style={{ padding: "12px 14px", fontWeight: 800, color: "#334155", width: "37%" }}>
                  {comp.competitorName}
                </th>
              </tr>
            </thead>
            <tbody>
              {comp.rows.map((row) => (
                <tr key={row.feature} style={{ borderBottom: "1px solid #f1f5f9", verticalAlign: "top" }}>
                  <td style={{ padding: "12px 14px", fontWeight: 800 }}>{row.feature}</td>
                  <td style={{ padding: "12px 14px", background: "#f8fffb", color: "#0f172a" }}>
                    {row.heybroc}
                  </td>
                  <td style={{ padding: "12px 14px", color: "#475569" }}>{row.competitor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Live Deterministic Scoring Example */}
      <section
        style={{
          background: "#0b2418",
          color: "#ffffff",
          borderRadius: 22,
          padding: "20px 22px",
          marginBottom: 24,
        }}
      >
        <div style={{ fontSize: 11.5, fontWeight: 800, color: "#6ee7b7", letterSpacing: "0.08em" }}>
          LIVE HEYBROC RUBRIC EXAMPLE (COMPUTED IN REAL TIME)
        </div>
        <h2 style={{ margin: "6px 0 8px", fontSize: 19, fontWeight: 900 }}>
          {demoPreset.brand} {demoPreset.title} → {liveScore.score}/100 ({liveScore.rating})
        </h2>
        <p style={{ margin: "0 0 12px", fontSize: 13.5, lineHeight: 1.55, color: "#cbd5e1" }}>
          Flagged ingredients:{" "}
          <strong style={{ color: "#fca5a5" }}>
            {liveScore.flagged.map((f) => f.name).join(", ") || "None"}
          </strong>
          .
          {liveSwap ? (
            <>
              {" "}
              Instant 1-Tap Clean Swap:{" "}
              <strong style={{ color: "#6ee7b7" }}>
                {liveSwap.brand} {liveSwap.title} ({liveSwap.score}/100)
              </strong>
              .
            </>
          ) : null}
        </p>
        <Link
          href={`/test?angle=${comp.recommendedAngle}`}
          style={{
            display: "inline-block",
            padding: "10px 16px",
            borderRadius: 999,
            background: "#22c55e",
            color: "#052e16",
            fontWeight: 900,
            fontSize: 13.5,
            textDecoration: "none",
          }}
        >
          Score Any Item in Your Own Pantry Free →
        </Link>
      </section>

      {/* Honest Two-Column Fit Guide */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(270px, 1fr))",
          gap: 14,
          marginBottom: 26,
        }}
      >
        <div
          style={{
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            borderRadius: 18,
            padding: "18px 18px",
          }}
        >
          <h2 style={{ margin: "0 0 10px", fontSize: 17, fontWeight: 900, color: "#065f46" }}>
            When HeyBroc Is the Stronger Fit
          </h2>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.6, color: "#1e293b" }}>
            {comp.whyChooseHeyBroc.map((item) => (
              <li key={item} style={{ marginBottom: 6 }}>
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div
          style={{
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: 18,
            padding: "18px 18px",
          }}
        >
          <h2 style={{ margin: "0 0 10px", fontSize: 17, fontWeight: 900, color: "#334155" }}>
            When {comp.competitorName} May Fit Better
          </h2>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.6, color: "#475569" }}>
            {comp.whenCompetitorFits.map((item) => (
              <li key={item} style={{ marginBottom: 6 }}>
                {item}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Visible FAQ Section (mirrored 1:1 into FAQPage JSON-LD above) */}
      <section style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 20, fontWeight: 900, margin: "0 0 12px" }}>
          Frequently Asked Questions: HeyBroc vs. {comp.competitorName}
        </h2>
        <div style={{ display: "grid", gap: 10 }}>
          {comp.faqs.map((faq) => (
            <div
              key={faq.question}
              style={{
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: 16,
                padding: "15px 17px",
              }}
            >
              <h3 style={{ margin: "0 0 6px", fontSize: 15, fontWeight: 800 }}>{faq.question}</h3>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: "#475569" }}>
                {faq.answer}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* More Comparisons */}
      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 900, margin: "0 0 10px" }}>
          More Food Scanner Comparisons
        </h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {siblings.map((s) => (
            <Link
              key={s.slug}
              href={`/compare/${s.slug}`}
              style={{
                padding: "8px 13px",
                borderRadius: 999,
                background: "#f8fafc",
                border: "1px solid #cbd5e1",
                color: "#0f172a",
                fontWeight: 700,
                fontSize: 12.5,
                textDecoration: "none",
              }}
            >
              HeyBroc vs. {s.competitorName} →
            </Link>
          ))}
        </div>
      </section>

      <footer
        style={{
          paddingTop: 16,
          borderTop: "1px solid #e2e8f0",
          fontSize: 12,
          color: "#64748b",
          lineHeight: 1.55,
        }}
      >
        {comp.competitorName} is a trademark of its respective owner. This comparison is provided for
        informational purposes based on publicly available features as of 2026. HeyBroc 0–100 grades are
        independent clean-label opinions—always verify physical package labels before purchasing.
      </footer>
    </div>
  );
}
