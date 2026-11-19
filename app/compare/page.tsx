import type { Metadata } from "next";
import Link from "next/link";
import { COMPETITOR_COMPARISONS } from "@/lib/comparisons";

export const metadata: Metadata = {
  title: "HeyBroc vs. Yuka, Bobby Approved, Trash Panda, Fig & More (2026 Comparison)",
  description:
    "Side-by-side comparisons of HeyBroc against Yuka, Bobby Approved, Trash Panda, Fig, Seed Oil Scout, and Olive. See which grocery ingredient scanner works best for online shopping across Walmart, Target, Costco, Instacart & 8 more stores.",
  alternates: {
    canonical: "https://www.heybroc.com/compare",
  },
  openGraph: {
    type: "website",
    url: "https://www.heybroc.com/compare",
    siteName: "HeyBroc",
    title: "HeyBroc vs. Yuka, Bobby Approved, Trash Panda, Fig & More (2026 Comparison)",
    description:
      "Side-by-side comparisons of HeyBroc against Yuka, Bobby Approved, Trash Panda, Fig, Seed Oil Scout, and Olive. See which grocery ingredient scanner works best for online shopping across 12 US retailers.",
    images: ["/og-banner.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "HeyBroc vs. Yuka, Bobby Approved, Trash Panda, Fig & More (2026 Comparison)",
    description:
      "Side-by-side comparisons of HeyBroc against top grocery scanner apps for online shopping across Walmart, Target, Costco, Instacart & more.",
    images: ["/og-banner.png"],
  },
};

export default function CompareHubPage() {
  const itemListLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "HeyBroc Food Scanner Comparisons",
    url: "https://www.heybroc.com/compare",
    itemListElement: COMPETITOR_COMPARISONS.map((c, idx) => ({
      "@type": "ListItem",
      position: idx + 1,
      name: `HeyBroc vs. ${c.competitorName}`,
      url: `https://www.heybroc.com/compare/${c.slug}`,
    })),
  };

  return (
    <div
      style={{
        maxWidth: 940,
        margin: "0 auto",
        padding: "16px 16px 56px",
        fontFamily: "var(--font-sans), system-ui, sans-serif",
        color: "#0f172a",
      }}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListLd) }}
      />

      {/* Top Navigation */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 22,
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
            href="/test?angle=online"
            style={{
              padding: "8px 14px",
              borderRadius: 999,
              background: "#0f7a4a",
              color: "#ffffff",
              fontWeight: 800,
              fontSize: 12.5,
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            ⚡ Free 3-Sec Score Test
          </Link>
          <Link
            href="/swaps"
            style={{
              padding: "8px 13px",
              borderRadius: 999,
              background: "#f8fafc",
              border: "1px solid #cbd5e1",
              color: "#0f172a",
              fontWeight: 800,
              fontSize: 12.5,
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            Clean Swaps
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section
        style={{
          background: "linear-gradient(180deg, #f0fdf4 0%, #ffffff 100%)",
          border: "1.5px solid #bbf7d0",
          borderRadius: 24,
          padding: "24px 22px",
          marginBottom: 24,
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
          2026 INDEPENDENT FOOD SCANNER GUIDE
        </p>
        <h1
          style={{
            margin: "0 0 10px",
            fontSize: 28,
            fontWeight: 900,
            lineHeight: 1.2,
            letterSpacing: "-0.025em",
          }}
        >
          Compare HeyBroc vs. Top Grocery &amp; Ingredient Scanner Apps
        </h1>
        <p style={{ margin: "0 0 16px", fontSize: 15, lineHeight: 1.6, color: "#334155" }}>
          Barcode-only food scanners work great in physical aisles—but fail when you order Walmart Pickup,
          Instacart, Target Drive Up, Costco, Kroger, ALDI, or Amazon Fresh online. Explore honest,
          side-by-side comparisons showing where HeyBroc excels and where other apps may fit better.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link
            href="/test?angle=online"
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
            Test Your First Grocery Item Free →
          </Link>
          <Link
            href="/independence"
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
            Read Our 0–100 Scoring Formula
          </Link>
        </div>
      </section>

      {/* Master Quick Comparison Table */}
      <section style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 20, fontWeight: 900, margin: "0 0 12px" }}>
          At-a-Glance Comparison Matrix
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
              minWidth: 640,
            }}
          >
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", textAlign: "left" }}>
                <th style={{ padding: "12px 14px", fontWeight: 800 }}>App</th>
                <th style={{ padding: "12px 14px", fontWeight: 800 }}>Live Online Cart Overlays</th>
                <th style={{ padding: "12px 14px", fontWeight: 800 }}>Scoring Style</th>
                <th style={{ padding: "12px 14px", fontWeight: 800 }}>Best For</th>
                <th style={{ padding: "12px 14px", fontWeight: 800 }}>Full Guide</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ background: "#f0fdf4", borderBottom: "1px solid #bbf7d0" }}>
                <td style={{ padding: "12px 14px", fontWeight: 900, color: "#065f46" }}>
                  🥦 HeyBroc (You Are Here)
                </td>
                <td style={{ padding: "12px 14px", fontWeight: 700, color: "#0f7a4a" }}>
                  Yes — All 12 US Online Retailers
                </td>
                <td style={{ padding: "12px 14px" }}>
                  Deterministic 0–100 (75–100 Excellent, 50–74 Mediocre, 0–49 Poor) + 2x Watchlist
                </td>
                <td style={{ padding: "12px 14px" }}>
                  Online &amp; in-store shoppers wanting 1-tap Clean Swaps + seed-oil &amp; dye flags
                </td>
                <td style={{ padding: "12px 14px" }}>
                  <Link href="/test?angle=online" style={{ color: "#0f7a4a", fontWeight: 800 }}>
                    Try Free →
                  </Link>
                </td>
              </tr>
              {COMPETITOR_COMPARISONS.map((c) => (
                <tr key={c.slug} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "12px 14px", fontWeight: 800 }}>{c.competitorName}</td>
                  <td style={{ padding: "12px 14px", color: "#475569" }}>
                    {c.competitorName === "Fig" ? "Select retailers (diet filter)" : "In-app / barcode focused"}
                  </td>
                  <td style={{ padding: "12px 14px", color: "#475569" }}>{c.shortTagline}</td>
                  <td style={{ padding: "12px 14px", color: "#475569" }}>{c.whenCompetitorFits[0]}</td>
                  <td style={{ padding: "12px 14px", whiteSpace: "nowrap" }}>
                    <Link
                      href={`/compare/${c.slug}`}
                      style={{ color: "#0f7a4a", fontWeight: 800, textDecoration: "none" }}
                    >
                      Compare →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Individual Comparison Cards */}
      <section>
        <h2 style={{ fontSize: 20, fontWeight: 900, margin: "0 0 12px" }}>
          Deep-Dive Comparisons
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(270px, 1fr))",
            gap: 14,
          }}
        >
          {COMPETITOR_COMPARISONS.map((c) => (
            <Link
              key={c.slug}
              href={`/compare/${c.slug}`}
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: 10,
                padding: "18px 18px",
                borderRadius: 18,
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                textDecoration: "none",
                color: "#0f172a",
                boxShadow: "0 6px 18px rgba(15, 23, 42, 0.04)",
              }}
            >
              <div>
                <span
                  style={{
                    display: "inline-block",
                    fontSize: 11,
                    fontWeight: 800,
                    color: "#0f7a4a",
                    background: "#ecfdf5",
                    padding: "3px 9px",
                    borderRadius: 999,
                    marginBottom: 8,
                  }}
                >
                  HeyBroc vs. {c.competitorName}
                </span>
                <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 900, lineHeight: 1.25 }}>
                  {c.heroHeadline}
                </h3>
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: "#475569" }}>
                  {c.shortTagline}
                </p>
              </div>
              <span style={{ fontSize: 13, fontWeight: 800, color: "#0f7a4a" }}>
                Read full comparison →
              </span>
            </Link>
          ))}
        </div>
      </section>

      <footer
        style={{
          marginTop: 32,
          paddingTop: 18,
          borderTop: "1px solid #e2e8f0",
          fontSize: 12.5,
          color: "#64748b",
          lineHeight: 1.55,
        }}
      >
        All third-party app names and trademarks belong to their respective owners and are used strictly
        for nominative comparison. HeyBroc is independent and unaffiliated with any compared app or
        grocery retailer. HeyBroc 0–100 grades represent deterministic clean-label editorial opinions and
        are not medical or regulatory determinations.
      </footer>
    </div>
  );
}
