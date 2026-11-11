import type { Metadata } from "next";
import Link from "next/link";
import { hasValidCatalogProvenance } from "@/lib/drinks-catalog";
import { SEO_PRODUCTS, evaluateSeoProduct } from "@/lib/seo-catalog";
import SwapsDirectoryClient, { type SwapDirectoryRow } from "./SwapsDirectoryClient";

export const metadata: Metadata = {
  title: "Clean Grocery Swaps Directory (Seed-Oil Free & Dye-Free Alternatives)",
  description:
    "Browse 1-for-1 healthier grocery swaps and 0–100 ingredient reports for popular snacks, dressings, cereals, yogurts, deli meats, and condiments on Walmart, Target, Kroger, Shipt, DoorDash, Instacart & ALDI.",
  alternates: {
    canonical: "https://www.heybroc.com/swaps",
  },
};

export default function SwapsDirectoryPage() {
  const rows: SwapDirectoryRow[] = SEO_PRODUCTS.filter((p) =>
    hasValidCatalogProvenance(p.sourceUrl, p.verifiedAt)
  ).map((p) => {
    const { entry, result, swap } = evaluateSeoProduct(p);
    return {
      slug: entry.slug,
      title: entry.title,
      brand: entry.brand,
      category: entry.category,
      score: result.score,
      flaggedNames: result.flagged.map((f) => f.name),
      swapTitle: swap?.title ?? null,
      swapScore: swap?.score ?? null,
    };
  });

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
            src="/broc-mascot.jpg"
            alt="HeyBroc"
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              border: "2px solid #16a34a",
              flexShrink: 0,
            }}
          />
          <b style={{ fontSize: 18, fontWeight: 900, letterSpacing: "-0.02em" }}>
            HeyBroc
          </b>
        </Link>

        <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
          <Link
            href="/tools"
            style={{
              padding: "7px 12px",
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
            🧪 Grader
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

      {/* Compact Heading Above the Fold */}
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
          Clean Grocery Swaps Directory
        </h1>
        <p style={{ fontSize: 13.5, color: "#475569", lineHeight: 1.4, margin: 0 }}>
          1-for-1 cleaner alternatives across Walmart, Target, Kroger, Instacart &amp; 12 stores.
        </p>
      </div>

      <SwapsDirectoryClient rows={rows} />

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
            Independent Editorial Opinion &amp; Non-Affiliation Disclaimer
          </summary>
          <p style={{ margin: "6px 0 0", lineHeight: 1.5 }}>
            Scores and summaries in this directory reflect HeyBroc&apos;s subjective clean-label
            rubric based on representative public ingredient data (Open Food Facts, USDA FoodData
            Central). Manufacturers reformulate products frequently and ingredients may vary by
            region or batch—always verify the physical package label before purchasing. Most flagged
            additives are FDA-permitted or GRAS. Outbound retail links may include affiliate
            attribution tags that earn HeyBroc a commission at no extra cost to you. As an Amazon
            Associate, HeyBroc earns from qualifying purchases. HeyBroc is independent and is not
            affiliated with, endorsed by, or sponsored by Walmart, Target, Instacart, ALDI, Kroger,
            Costco, Sam&apos;s Club, BJ&apos;s, Amazon, Whole Foods Market, DoorDash, Uber Eats,
            Shipt, or any food or beverage manufacturer.
          </p>
        </details>
      </footer>
    </div>
  );
}
