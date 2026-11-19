import Link from "next/link";

const SUPPORTED_STORES = [
  "Walmart",
  "Target",
  "Instacart",
  "Amazon Fresh",
  "Whole Foods Market",
  "Costco",
  "Sam's Club",
  "Kroger (+ regional banners)",
  "ALDI",
  "BJ's Wholesale",
  "Shipt",
  "DoorDash Grocery",
  "Uber Eats Grocery",
];

export default function AnswerBlock() {
  return (
    <section
      aria-label="How HeyBroc scores online groceries"
      style={{
        maxWidth: 960,
        margin: "24px auto 40px",
        padding: "0 16px",
        fontFamily: "var(--font-sans), system-ui, sans-serif",
        color: "#0f172a",
      }}
    >
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: 20,
          padding: "22px 24px",
          boxShadow: "0 8px 24px rgba(15, 23, 42, 0.04)",
        }}
      >
        <p
          style={{
            margin: "0 0 6px",
            fontSize: 11.5,
            fontWeight: 800,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "#059669",
          }}
        >
          100% Independent · Deterministic 0–100 Grocery Ingredient Grader
        </p>
        <h2
          style={{
            margin: "0 0 10px",
            fontSize: 21,
            fontWeight: 900,
            lineHeight: 1.25,
            letterSpacing: "-0.02em",
          }}
        >
          Instant 0–100 food ingredient scores &amp; 1-Tap Clean Swaps while you shop online
        </h2>
        <p style={{ margin: "0 0 16px", fontSize: 14, lineHeight: 1.6, color: "#334155" }}>
          HeyBroc grades grocery foods and beverages deterministically across three transparent pillars:{" "}
          <strong>Nutritional Quality (60 points)</strong> based on Nutri-Score A–E,{" "}
          <strong>Additive &amp; Chemical Safety (30 points)</strong> flagging synthetic food dyes (Red 40, Yellow 5 &amp; 6, Blue 1),
          refined seed oils (soybean, canola, corn, cottonseed, sunflower, safflower), chemical preservatives, nitrites, artificial sweeteners,
          and emulsifiers (with any high-risk additive capping the total score at 49/100), and{" "}
          <strong>USDA Certified Organic Bonus (10 points)</strong> awarded strictly to products carrying verified product-level organic
          certification.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <div
            style={{
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: 14,
              padding: "13px 14px",
            }}
          >
            <h3 style={{ margin: "0 0 5px", fontSize: 14, fontWeight: 800 }}>
              12 Grocery Store Backends (13 Live Shop Tiles)
            </h3>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: "#475569" }}>
              Works on iPhone Live Shop &amp; Safari Extension, Android Live Shop, Desktop Chrome Extension, and Web across:{" "}
              {SUPPORTED_STORES.join(", ")}.
            </p>
          </div>

          <div
            style={{
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: 14,
              padding: "13px 14px",
            }}
          >
            <h3 style={{ margin: "0 0 5px", fontSize: 14, fontWeight: 800 }}>
              Custom Family Watchlist &amp; Allergen Alerts
            </h3>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: "#475569" }}>
              Apply 2x strictness penalties on categories your family avoids and surface instant label warnings for milk, gluten/wheat,
              peanuts, tree nuts, soy, egg, fish, shellfish, sesame, and optional pesticide-watch crops.
            </p>
          </div>

          <div
            style={{
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: 14,
              padding: "13px 14px",
            }}
          >
            <h3 style={{ margin: "0 0 5px", fontSize: 14, fontWeight: 800 }}>
              100% Independent &amp; Disclosed Links
            </h3>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: "#475569" }}>
              HeyBroc never accepts payments from food brands to change a score or buy Clean Swap placement. When a retail swap button earns
              a commission, it is clearly marked &ldquo;paid link.&rdquo;
            </p>
          </div>
        </div>

        <nav
          aria-label="HeyBroc guides and directories"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "8px 16px",
            fontSize: 13,
            fontWeight: 700,
            paddingTop: 12,
            borderTop: "1px solid #f1f5f9",
          }}
        >
          <Link href="/compare" style={{ color: "#059669", textDecoration: "none" }}>
            HeyBroc vs. Yuka &amp; Food Scanners →
          </Link>
          <Link href="/swaps" style={{ color: "#059669", textDecoration: "none" }}>
            Clean Grocery Swaps Directory →
          </Link>
          <Link href="/tools" style={{ color: "#059669", textDecoration: "none" }}>
            Free Ingredient Label Grader →
          </Link>
          <Link href="/independence" style={{ color: "#059669", textDecoration: "none" }}>
            How We Score &amp; Independence FAQ →
          </Link>
          <Link href="/creators" style={{ color: "#475569", textDecoration: "none" }}>
            Creator Partner Program
          </Link>
          <Link href="/privacy" style={{ color: "#475569", textDecoration: "none" }}>
            Privacy Policy
          </Link>
          <Link href="/terms" style={{ color: "#475569", textDecoration: "none" }}>
            Terms of Service
          </Link>
        </nav>

        <p style={{ margin: "10px 0 0", fontSize: 11.5, lineHeight: 1.45, color: "#64748b" }}>
          Informational clean-label ingredient scores only, not medical or regulatory advice. Formulations vary by batch and region — always
          check the physical product label before purchasing.
        </p>
      </div>
    </section>
  );
}
