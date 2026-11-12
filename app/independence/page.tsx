import type { Metadata } from "next";
import {
  FooterMeadowScenery,
  HealthyFoodBackdrop,
  YukaSiteFooter,
} from "@/components/HealthyScenery";

export const metadata: Metadata = {
  title: "100% Independent Food & Grocery Scoring | HeyBroc",
  description:
    "HeyBroc is a 100% independent grocery grading project. Zero brand influence, zero in-app ads, strict family data privacy, and transparent shopper-aligned funding.",
  alternates: {
    canonical: "https://www.heybroc.com/independence",
  },
};

export default function IndependencePage() {
  return (
    <div className="app">
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
                  <p className="brand-tagline">100% independent food grader &amp; 1-tap clean swaps</p>
                </div>
              </a>

              <nav className="yuka-desktop-nav" aria-label="Primary navigation">
                <a href="/">Application</a>
                <a href="/independence" className="is-current">
                  Independence
                </a>
                <a href="/swaps">Clean Swaps</a>
                <a href="/tools">Free Grader</a>
              </nav>
            </div>

            <div className="topbar-account">
              <a href="/" className="yuka-green-pill-btn" style={{ padding: "9px 18px", fontSize: 13.5 }}>
                Open Scanner →
              </a>
            </div>
          </div>
        </header>
      </div>

      <main className="indep-page-main">
        <div className="yuka-indep-inner">
          <h1 className="indep-hero-title">Our core value is independence</h1>
          <p className="yuka-page-lead">
            HeyBroc is a 100% independent project. Every 0–100 food evaluation and cleaner grocery recommendation is calculated objectively from ingredient lists and nutrition facts — no brand or manufacturer can influence them in one way or another.
          </p>

          {/* Hero Circular Sky/Mint Emblem + Broc Mascot + 100% INDEPENDENT Ribbon */}
          <div className="yuka-indep-badge" aria-hidden="true">
            <div className="yuka-indep-circle">
              <span className="yuka-cloud yuka-cloud--left" />
              <span className="yuka-cloud yuka-cloud--right" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/broc-mascot.png" alt="" className="yuka-indep-mascot" />
            </div>
            <div className="yuka-indep-ribbon">100% INDEPENDENT</div>
          </div>

          {/* 3 Open, Borderless Pillars Modeled After yuka.io/en/independence/ */}
          <div className="yuka-pillars-grid">
            <div className="yuka-pillar">
              <div className="yuka-pillar-blob" aria-hidden="true">
                <svg viewBox="0 0 88 88" width="76" height="76" fill="none">
                  <path
                    d="M42 9C64 6 81 22 81 44C81 66 65 81 43 80C21 79 7 64 8 42C9 20 20 12 42 9Z"
                    fill="#EAF8EF"
                  />
                  <path d="M28 42L54 30V58L28 46V42Z" fill="#34B86A" />
                  <ellipse cx="55" cy="44" rx="4.5" ry="14" fill="#FDBA8C" stroke="#1F8A4C" strokeWidth="2" />
                  <rect x="23" y="40" width="6" height="8" rx="2" fill="#D1EDE0" />
                  <path d="M31 48L34 59C34.5 61 32 62 30.5 60L27 48" fill="#15803D" />
                </svg>
              </div>
              <h2 className="yuka-hand-title">
                No ads
                <svg className="yuka-hand-underline" viewBox="0 0 90 10" fill="none" aria-hidden="true">
                  <path d="M4 7C32 3 60 3 86 6" stroke="#84CC16" strokeWidth="3" strokeLinecap="round" />
                </svg>
              </h2>
              <p>
                HeyBroc refuses all in-app advertising. Brands and manufacturers cannot pay HeyBroc to promote their products or sponsor shelf placements while you shop.
              </p>
            </div>

            <div className="yuka-pillar">
              <div className="yuka-pillar-blob" aria-hidden="true">
                <svg viewBox="0 0 88 88" width="76" height="76" fill="none">
                  <path
                    d="M45 8C67 8 82 24 80 46C78 68 62 82 40 80C18 78 6 62 8 41C10 20 23 8 45 8Z"
                    fill="#EAF8EF"
                  />
                  <path
                    d="M33 46V27C33 25 36 25 36 27V41M39 41V23C39 21 42 21 42 23V41M45 41V25C45 23 48 23 48 25V42M51 43V30C51 28 54 28 54 30V49C54 57 48 62 41 62H39C32 62 28 57 28 50V43C28 40 31 40 32 43L33 46Z"
                    fill="#FCD5B4"
                    stroke="#E8A97E"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <rect x="33" y="61" width="18" height="6" rx="3" fill="#18A957" />
                </svg>
              </div>
              <h2 className="yuka-hand-title">
                No influence
                <svg className="yuka-hand-underline" viewBox="0 0 120 10" fill="none" aria-hidden="true">
                  <path d="M4 7C40 2 80 2 116 6" stroke="#22C55E" strokeWidth="3" strokeLinecap="round" />
                </svg>
              </h2>
              <p>
                No brand or industrial group can pay to raise a product&apos;s 0–100 score, hide a flagged additive, or influence which cleaner alternatives are recommended.
              </p>
            </div>

            <div className="yuka-pillar">
              <div className="yuka-pillar-blob" aria-hidden="true">
                <svg viewBox="0 0 88 88" width="76" height="76" fill="none">
                  <path
                    d="M46 8C68 10 82 27 79 48C76 69 59 82 38 79C17 76 6 59 9 38C12 17 24 6 46 8Z"
                    fill="#EAF8EF"
                  />
                  <rect x="28" y="39" width="32" height="25" rx="6" fill="#22A85A" />
                  <path
                    d="M35 39V32C35 26.5 39 23 44 23C49 23 53 26.5 53 32V39"
                    stroke="#188C49"
                    strokeWidth="4"
                    strokeLinecap="round"
                  />
                  <circle cx="44" cy="50" r="3" fill="#FDE68A" />
                  <path d="M44 53V57" stroke="#FDE68A" strokeWidth="2.5" strokeLinecap="round" />
                </svg>
              </div>
              <h2 className="yuka-hand-title">
                Data protection
                <svg className="yuka-hand-underline" viewBox="0 0 130 10" fill="none" aria-hidden="true">
                  <path d="M4 7C42 2 88 3 126 6" stroke="#F59E0B" strokeWidth="3" strokeLinecap="round" />
                </svg>
              </h2>
              <p>
                HeyBroc respects your family&apos;s privacy. We never sell or monetize your personal grocery scans or ingredient watchlists to manufacturers or data brokers.
              </p>
            </div>
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

          <div style={{ marginTop: 32, textAlign: "center" }}>
            <a href="/" className="yuka-green-pill-btn">
              Grade Your First Grocery Item Free →
            </a>
          </div>
        </section>
      </main>

      <YukaSiteFooter />
      <FooterMeadowScenery />
    </div>
  );
}
