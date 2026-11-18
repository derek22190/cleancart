import type { Metadata } from "next";
import {
  FooterKitchenScenery,
  HealthyFoodBackdrop,
  YukaSiteFooter,
} from "@/components/HealthyScenery";

export const metadata: Metadata = {
  title: "100% Family Owned & Unbiased Grocery Scoring",
  description:
    "HeyBroc is 100% family-owned and fiercely independent. Zero Big Food ties, zero in-app ads, strict family data privacy, and transparent shopper-aligned funding.",
  alternates: {
    canonical: "https://www.heybroc.com/independence",
  },
};

const INDEPENDENCE_FAQS = [
  {
    q: "How does HeyBroc calculate its 0 to 100 food and ingredient score?",
    a: "HeyBroc grades products on a deterministic 0–100 scale across three pillars: Nutritional Quality (60% weight, based on Nutri-Score A–E covering sugar, sodium, saturated fat, calories, fiber, and protein), Additive & Chemical Safety (30% weight, penalizing synthetic dyes, refined seed oils, chemical preservatives, nitrites, artificial sweeteners, and emulsifiers), and a Certified Organic Bonus (10% weight, awarded strictly to products with explicit USDA Certified Organic certification). Any high-risk additive automatically caps a product's maximum score at 49/100.",
  },
  {
    q: "Which grocery stores work with HeyBroc Live Shop?",
    a: "HeyBroc shows on-photo 0–100 score badges and 1-Tap Clean Swaps across 12 grocery store backends (13 Live Shop tiles): Walmart, Instacart, Target, Amazon Fresh, Whole Foods Market, Costco, Sam's Club, Kroger (plus regional banners like Ralphs, Fred Meyer, King Soopers, Fry's, Harris Teeter, Smith's, QFC, Mariano's, and Pick 'n Save), ALDI, BJ's Wholesale, Shipt, DoorDash Grocery, and Uber Eats Grocery — on iPhone Live Shop & Safari Extension, Android Live Shop, Chrome Extension, and Web.",
  },
  {
    q: "What ingredients and additives does HeyBroc flag?",
    a: "HeyBroc flags refined seed oils (soybean, canola, corn, cottonseed, sunflower, safflower), artificial food dyes (Red 40, Yellow 5, Yellow 6, Blue 1, Red 3, Titanium Dioxide), preservatives and nitrates (Sodium Nitrite, BHA, BHT, Potassium Bromate, TBHQ, Sodium Benzoate), sweeteners (High Fructose Corn Syrup, Sucralose, Aspartame, Ace-K), emulsifiers (Carrageenan, Polysorbate 80), and custom household allergens (milk, gluten/wheat, peanuts, tree nuts, soy, egg, fish, shellfish, and sesame).",
  },
  {
    q: "Does HeyBroc accept payments from food brands to change product scores?",
    a: "No. HeyBroc is 100% independent and family-owned. Brands cannot pay to alter a score or buy placement in Clean Swaps. HeyBroc is funded strictly by optional Family Pro memberships and clearly disclosed retail links marked 'paid link' when a cleaner alternative is already chosen on merit.",
  },
];

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "@id": "https://www.heybroc.com/independence#faq",
  mainEntity: INDEPENDENCE_FAQS.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: {
      "@type": "Answer",
      text: item.a,
    },
  })),
};

export default function IndependencePage() {
  return (
    <div className="app">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <HealthyFoodBackdrop />

      <div className="topbar-shell">
        <header className="topbar">
          <div className="topbar-main">
            <div style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
              <a href="/" className="brand">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/broc-mascot.png" alt="Broc mascot" className="brand-mascot" />
                <div className="brand-copy">
                  <div className="brand-title-row">
                    <h1>HeyBroc</h1>
                  </div>
                  <p className="brand-tagline">100% family-owned online grocery grader &amp; 1-tap clean swaps</p>
                </div>
              </a>

              <nav className="yuka-desktop-nav" aria-label="Primary navigation">
                <a href="/">Application</a>
                <a href="/independence" className="is-current">
                  Family Owned
                </a>
                <a href="/swaps">Clean Swaps</a>
                <a href="/tools">Free Grader</a>
              </nav>
            </div>

            <div className="topbar-account">
              <a href="/" className="yuka-green-pill-btn" style={{ padding: "9px 18px", fontSize: 13.5 }}>
                Shop Online Free →
              </a>
            </div>
          </div>
        </header>
      </div>

      <main className="indep-page-main">
        <div className="yuka-indep-inner">
          <h1 className="indep-hero-title">100% family-owned. Built for parents, never Big Food.</h1>
          <p className="yuka-page-lead">
            HeyBroc is 100% family-owned and fiercely independent. Every 0–100 food evaluation and online Clean Swap is calculated objectively from ingredient lists and nutrition facts — no food brand or conglomerate can influence them in any way.
          </p>

          {/* Superhero Cape Broc Medallion + 100% FAMILY OWNED Ribbon */}
          <div className="broc-family-crest" aria-hidden="true">
            <div className="broc-family-halo">
              <span className="broc-family-ring" />
              <svg className="broc-family-sparkles" viewBox="0 0 180 180" fill="none">
                <path d="M30 46L33 54L41 57L33 60L30 68L27 60L19 57L27 54L30 46Z" fill="#18B957" opacity="0.55" />
                <path d="M150 38L152.2 44L158 46.2L152.2 48.4L150 54.4L147.8 48.4L142 46.2L147.8 44L150 38Z" fill="#F59E0B" opacity="0.7" />
                <circle cx="148" cy="118" r="3.5" fill="#18B957" opacity="0.38" />
                <circle cx="28" cy="114" r="3" fill="#10B981" opacity="0.35" />
              </svg>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/broc-mascot-cape.png" alt="" className="broc-family-mascot" />
            </div>
            <div className="broc-family-ribbon">100% FAMILY OWNED</div>
          </div>

          {/* 3 Clean Sans-Serif Soft-Mint Pledge Cards */}
          <div className="broc-pledge-grid">
            <article className="broc-pledge-card">
              <div className="broc-pledge-top">
                <div className="broc-pledge-icon" aria-hidden="true">
                  <svg viewBox="0 0 44 44" width="32" height="32" fill="none">
                    <rect x="7" y="5" width="24" height="32" rx="5" fill="#EAF8EF" stroke="#159952" strokeWidth="2.2" />
                    <line x1="12" y1="12" x2="24" y2="12" stroke="#159952" strokeWidth="2.2" strokeLinecap="round" />
                    <line x1="12" y1="18" x2="26" y2="18" stroke="#6BC492" strokeWidth="2" strokeLinecap="round" />
                    <line x1="12" y1="23" x2="22" y2="23" stroke="#6BC492" strokeWidth="2" strokeLinecap="round" />
                    <circle cx="30" cy="30" r="9" fill="#18B259" stroke="#FFFFFF" strokeWidth="2" />
                    <path d="M26.5 30.2L29 32.7L34 27.5" stroke="#FFFFFF" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <span className="broc-pledge-tag">01 · UNBIASED MATH</span>
              </div>
              <h2 className="broc-pledge-title">Scores Can&apos;t Be Bought</h2>
              <p className="broc-pledge-body">
                No food manufacturer or industrial group can pay a dime to raise a 0–100 score, hide a flagged additive, or alter how our deterministic formula grades an ingredient list.
              </p>
            </article>

            <article className="broc-pledge-card">
              <div className="broc-pledge-top">
                <div className="broc-pledge-icon" aria-hidden="true">
                  <svg viewBox="0 0 44 44" width="32" height="32" fill="none">
                    <rect x="6" y="9" width="26" height="22" rx="5" fill="#EAF8EF" stroke="#159952" strokeWidth="2.2" />
                    <path d="M12 14V26M16 14V26M20 14V26M25 14V26" stroke="#159952" strokeWidth="2.1" strokeLinecap="round" />
                    <path
                      d="M31 20L38 23V29.5C38 34 34.8 37.4 31 39C27.2 37.4 24 34 24 29.5V23L31 20Z"
                      fill="#18B259"
                      stroke="#FFFFFF"
                      strokeWidth="2"
                      strokeLinejoin="round"
                    />
                    <path d="M28.2 29.5L30.2 31.5L34 27.5" stroke="#FFFFFF" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <span className="broc-pledge-tag">02 · MERIT-ONLY PICKS</span>
              </div>
              <h2 className="broc-pledge-title">Zero Sponsored Placements</h2>
              <p className="broc-pledge-body">
                HeyBroc refuses paid banner ads and bought shelf space. Every Clean Swap earns its recommendation strictly by outscoring conventional alternatives on nutrition and clean ingredients.
              </p>
            </article>

            <article className="broc-pledge-card">
              <div className="broc-pledge-top">
                <div className="broc-pledge-icon" aria-hidden="true">
                  <svg viewBox="0 0 44 44" width="32" height="32" fill="none">
                    <path d="M15 18L19 9M29 18L25 9" stroke="#159952" strokeWidth="2.3" strokeLinecap="round" />
                    <path d="M7 18H37L34 34C33.6 36 32 37 30 37H14C12 37 10.4 36 10 34L7 18Z" fill="#EAF8EF" stroke="#159952" strokeWidth="2.2" strokeLinejoin="round" />
                    <path
                      d="M22 30.8C22 30.8 16.5 27.2 16.5 23.8C16.5 22 17.9 20.8 19.5 20.8C20.6 20.8 21.5 21.4 22 22.2C22.5 21.4 23.4 20.8 24.5 20.8C26.1 20.8 27.5 22 27.5 23.8C27.5 27.2 22 30.8 22 30.8Z"
                      fill="#18B259"
                    />
                  </svg>
                </div>
                <span className="broc-pledge-tag">03 · ALIGNED WITH FAMILIES</span>
              </div>
              <h2 className="broc-pledge-title">Shopper-Funded Only</h2>
              <p className="broc-pledge-body">
                Backed strictly by optional Family Pro memberships and disclosed retail links — and we never sell or monetize your family&apos;s grocery scans, carts, or watchlists to data brokers.
              </p>
            </article>
          </div>
        </div>

        {/* Transparent Financing Breakdown */}
        <section className="indep-funding-section" aria-label="Transparent financing">
          <h2 className="yuka-page-h2">Transparent financing</h2>
          <p className="yuka-page-lead">
            Because we refuse payments and sponsorships from food manufacturers, HeyBroc relies strictly on transparent, shopper-aligned support:
          </p>

          <div className="indep-funding-grid">
            <div className="indep-funding-card">
              <span className="indep-funding-tag">1 · MEMBER SUPPORT</span>
              <h3>Family Pro Memberships</h3>
              <p>
                Anyone can test groceries and check 0–100 scores free. Optional Family Pro memberships fund ongoing catalog verification, unlimited store links, and whole-cart audits.
              </p>
            </div>

            <div className="indep-funding-card">
              <span className="indep-funding-tag">2 · CLEARLY LABELED</span>
              <h3>Disclosed Retail Store Links</h3>
              <p>
                When a cleaner pick is already selected by our rubric and you open it at a retailer via a link marked &ldquo;paid link&rdquo;, HeyBroc may earn a small retail commission at zero extra cost to you.
              </p>
            </div>

            <div className="indep-funding-card">
              <span className="indep-funding-tag">3 · DETERMINISTIC CODE</span>
              <h3>Open 3-Pillar Scoring</h3>
              <p>
                Every score is computed deterministically: 60% Nutritional Quality, 30% Clean-Label Additives, and 10% Certified USDA Organic — with a hard 49/100 cap on high-risk additives.
              </p>
            </div>
          </div>

          <section aria-label="Frequently asked questions" style={{ marginTop: 40, textAlign: "left" }}>
            <h2 className="yuka-page-h2">Scoring &amp; Independence FAQ</h2>
            <div style={{ display: "grid", gap: 14, marginTop: 18 }}>
              {INDEPENDENCE_FAQS.map((item) => (
                <article
                  key={item.q}
                  style={{
                    background: "#ffffff",
                    border: "1px solid #e2e8f0",
                    borderRadius: 16,
                    padding: "16px 18px",
                  }}
                >
                  <h3 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 800, color: "#0f172a" }}>
                    {item.q}
                  </h3>
                  <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "#334155" }}>
                    {item.a}
                  </p>
                </article>
              ))}
            </div>
          </section>

          <div style={{ marginTop: 32, textAlign: "center" }}>
            <a href="/" className="yuka-green-pill-btn">
              Grade Your First Grocery Item Free →
            </a>
          </div>
        </section>
      </main>

      <YukaSiteFooter />
      <FooterKitchenScenery />
    </div>
  );
}
