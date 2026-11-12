"use client";

import React from "react";

/**
 * Ambient faint-green healthy whole-food illustrations floating along the page margins
 * (replacing Yuka's pastel-blue blobs with soft botanical whole-food artwork).
 */
export function HealthyFoodBackdrop() {
  return (
    <div id="healthy-food-backdrop" className="healthy-food-backdrop" aria-hidden="true">
      {/* Upper-Left Margin: Fresh Avocado Half & Herb Leaf */}
      <svg
        className="bg-food-item bg-food-item--top-left"
        viewBox="0 0 180 180"
        fill="none"
      >
        <ellipse cx="90" cy="94" rx="76" ry="66" fill="#EAF8EF" opacity="0.85" />
        <path
          d="M92 26C69 26 52 58 52 96C52 128 70 148 92 148C114 148 132 128 132 96C132 58 115 26 92 26Z"
          fill="#C5ECD4"
          stroke="#65B884"
          strokeWidth="2.8"
        />
        <path
          d="M92 36C74 36 61 63 61 96C61 122 75 138 92 138C109 138 123 122 123 96C123 63 110 36 92 36Z"
          fill="#F1FBF5"
        />
        <circle cx="92" cy="103" r="20" fill="#95D4AD" stroke="#65B884" strokeWidth="2.4" />
        <path
          d="M84 95C87 91 93 90 97 92"
          stroke="#F1FBF5"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <path
          d="M138 44C152 40 162 50 158 64C144 68 134 58 138 44Z"
          fill="#D3F2DF"
          stroke="#65B884"
          strokeWidth="2.2"
        />
      </svg>

      {/* Mid-Left Margin: Garden Carrot with Feathery Tops & Ripe Strawberry */}
      <svg
        className="bg-food-item bg-food-item--mid-left"
        viewBox="0 0 260 220"
        fill="none"
      >
        <path
          d="M22 118C12 64 68 28 134 38C200 48 242 90 228 142C214 190 150 202 88 188C38 176 30 158 22 118Z"
          fill="#EAF8EF"
          opacity="0.9"
        />
        <path
          d="M82 66C70 46 56 44 52 54C60 64 72 68 82 66Z"
          fill="#C0EACF"
          stroke="#65B884"
          strokeWidth="2.4"
        />
        <path
          d="M86 64C82 40 92 30 100 38C100 50 94 60 86 64Z"
          fill="#C0EACF"
          stroke="#65B884"
          strokeWidth="2.4"
        />
        <path
          d="M90 68C102 50 116 52 116 62C106 70 98 70 90 68Z"
          fill="#C0EACF"
          stroke="#65B884"
          strokeWidth="2.4"
        />
        <path
          d="M76 72C84 64 100 68 104 78L132 164C134 170 127 175 122 170L72 88C68 81 70 76 76 72Z"
          fill="#DBF4E4"
          stroke="#65B884"
          strokeWidth="2.6"
        />
        <path
          d="M86 94L98 90M96 114L109 110M108 134L118 131"
          stroke="#65B884"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M176 106C160 106 152 120 156 136C160 152 171 162 176 162C181 162 192 152 196 136C200 120 192 106 176 106Z"
          fill="#DFF5E7"
          stroke="#65B884"
          strokeWidth="2.4"
        />
        <path
          d="M164 105C170 99 182 99 188 105C182 109 170 109 164 105Z"
          fill="#B3E4C5"
          stroke="#65B884"
          strokeWidth="2"
        />
        <circle cx="170" cy="124" r="1.8" fill="#65B884" />
        <circle cx="181" cy="126" r="1.8" fill="#65B884" />
        <circle cx="175" cy="138" r="1.8" fill="#65B884" />
        <circle cx="168" cy="146" r="1.8" fill="#65B884" />
        <circle cx="183" cy="144" r="1.8" fill="#65B884" />
      </svg>

      {/* Mid-Right Margin: Orchard Apple, Blueberries & Leaf */}
      <svg
        className="bg-food-item bg-food-item--mid-right"
        viewBox="0 0 240 220"
        fill="none"
      >
        <path
          d="M34 108C40 56 96 26 154 36C206 46 226 96 208 148C190 194 130 206 76 186C36 170 28 150 34 108Z"
          fill="#EAF8EF"
          opacity="0.9"
        />
        <path
          d="M118 74C102 66 80 76 78 102C76 130 94 156 112 156C118 156 122 153 126 153C130 153 134 156 140 156C158 156 176 130 174 102C172 76 150 66 134 74C129 76 123 76 118 74Z"
          fill="#DCF4E5"
          stroke="#65B884"
          strokeWidth="2.6"
        />
        <path d="M126 74C126 61 132 53 139 50" stroke="#65B884" strokeWidth="2.6" strokeLinecap="round" />
        <path
          d="M128 60C138 52 152 54 152 64C142 70 132 68 128 60Z"
          fill="#B9E7CA"
          stroke="#65B884"
          strokeWidth="2"
        />
        <circle cx="68" cy="152" r="13" fill="#CDEFD9" stroke="#65B884" strokeWidth="2.2" />
        <circle cx="88" cy="166" r="11" fill="#E1F6E8" stroke="#65B884" strokeWidth="2.2" />
      </svg>

      {/* Lower-Left Margin: Pear & Citrus Slice */}
      <svg
        className="bg-food-item bg-food-item--low-left"
        viewBox="0 0 210 200"
        fill="none"
      >
        <ellipse cx="104" cy="106" rx="84" ry="68" fill="#EAF8EF" opacity="0.88" />
        <path
          d="M88 52C78 52 73 64 70 78C66 94 54 106 54 124C54 144 69 156 88 156C107 156 122 144 122 124C122 106 110 94 106 78C103 64 98 52 88 52Z"
          fill="#DCF4E5"
          stroke="#65B884"
          strokeWidth="2.4"
        />
        <path d="M88 52C88 43 93 38 98 36" stroke="#65B884" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="148" cy="126" r="26" fill="#F2FBF5" stroke="#65B884" strokeWidth="2.4" />
        <circle cx="148" cy="126" r="20" fill="#CFEFD9" />
        <path
          d="M148 106V146M128 126H168M134 112L162 140M162 112L134 140"
          stroke="#F2FBF5"
          strokeWidth="2"
        />
      </svg>
    </div>
  );
}

/**
 * Faint-green organic backdrop & healthy produce illustrations framing the interactive phone
 * (mirroring Yuka's hero phone backdrop, upgraded to healthy whole foods in soft mint green).
 */
export function PhoneStageFoodHalo() {
  return (
    <div id="stage-food-halo" className="stage-food-halo" aria-hidden="true">
      <svg className="stage-food-svg" viewBox="0 0 640 760" fill="none">
        <path
          d="M62 422C24 298 112 162 248 130C384 98 556 132 602 272C648 412 582 604 440 668C298 732 100 546 62 422Z"
          fill="#EAF8EF"
        />
        <path
          d="M114 560C48 500 28 404 76 334C124 264 252 248 362 284C472 320 590 412 558 526C526 640 180 620 114 560Z"
          fill="#F1FBF4"
        />

        {/* Bottom-Left: Woven Produce Basket with Leafy Greens */}
        <g transform="translate(22, 474) rotate(-8)">
          <path
            d="M36 42C28 20 46 8 62 22C66 26 66 34 62 42"
            fill="#C0EACF"
            stroke="#59B07A"
            strokeWidth="2.4"
          />
          <path
            d="M62 40C64 16 86 12 94 28C96 34 92 40 86 44"
            fill="#D3F2DF"
            stroke="#59B07A"
            strokeWidth="2.4"
          />
          <path
            d="M30 46L52 14M98 46L76 14"
            stroke="#59B07A"
            strokeWidth="3.2"
            strokeLinecap="round"
          />
          <rect
            x="14"
            y="44"
            width="100"
            height="12"
            rx="6"
            fill="#D3F2DF"
            stroke="#59B07A"
            strokeWidth="2.4"
          />
          <path
            d="M22 56H106L94 102C92 108 87 112 80 112H48C41 112 36 108 34 102L22 56Z"
            fill="#E7F8ED"
            stroke="#59B07A"
            strokeWidth="2.4"
          />
          <path
            d="M38 56L44 112M56 56L58 112M72 56L70 112M90 56L84 112M27 74H101M31 92H97"
            stroke="#85CCA0"
            strokeWidth="1.8"
          />
        </g>

        {/* Top-Left: Broccoli Floret */}
        <g transform="translate(48, 174) rotate(-14)">
          <path
            d="M34 52L30 78C29 83 33 87 38 87H48C53 87 57 83 56 78L52 52"
            fill="#DCF4E5"
            stroke="#59B07A"
            strokeWidth="2.4"
          />
          <path
            d="M22 54C12 50 10 36 20 28C22 16 38 12 48 20C58 14 72 20 72 32C80 38 76 52 64 54C52 58 34 58 22 54Z"
            fill="#BEEACF"
            stroke="#59B07A"
            strokeWidth="2.4"
          />
        </g>

        {/* Top-Right: Olive Oil Bottle */}
        <g transform="translate(504, 106) rotate(12)">
          <rect x="34" y="8" width="16" height="10" rx="3" fill="#BEEACF" stroke="#59B07A" strokeWidth="2.2" />
          <path
            d="M36 18H48L52 38L66 52C70 56 72 62 72 68V114C72 121 66 126 59 126H25C18 126 12 121 12 114V68C12 62 14 56 18 52L32 38L36 18Z"
            fill="#E0F5E7"
            stroke="#59B07A"
            strokeWidth="2.4"
          />
          <rect x="21" y="70" width="42" height="34" rx="6" fill="#F4FCF7" stroke="#85CCA0" strokeWidth="1.8" />
          <path
            d="M36 88C40 80 48 80 50 86C46 94 38 94 36 88Z"
            fill="#B1E3C3"
            stroke="#59B07A"
            strokeWidth="1.8"
          />
        </g>

        {/* Mid-Right: Sliced Avocado */}
        <g transform="translate(526, 290) rotate(-10)">
          <path
            d="M44 16C28 16 16 40 16 68C16 92 29 106 44 106C59 106 72 92 72 68C72 40 60 16 44 16Z"
            fill="#CBEFD7"
            stroke="#59B07A"
            strokeWidth="2.4"
          />
          <path
            d="M44 24C32 24 23 44 23 68C23 87 33 98 44 98C55 98 65 87 65 68C65 44 56 24 44 24Z"
            fill="#F3FCF6"
          />
          <circle cx="44" cy="73" r="14" fill="#95D4AD" stroke="#59B07A" strokeWidth="2.2" />
        </g>

        {/* Lower-Right: Strawberry */}
        <g transform="translate(514, 482) rotate(14)">
          <path
            d="M42 24C26 24 18 38 22 54C26 70 37 80 42 80C47 80 58 70 62 54C66 38 58 24 42 24Z"
            fill="#DCF4E5"
            stroke="#59B07A"
            strokeWidth="2.4"
          />
          <path
            d="M30 23C36 17 48 17 54 23C48 27 36 27 30 23Z"
            fill="#B3E4C5"
            stroke="#59B07A"
            strokeWidth="2"
          />
          <circle cx="36" cy="42" r="1.8" fill="#59B07A" />
          <circle cx="48" cy="44" r="1.8" fill="#59B07A" />
          <circle cx="42" cy="56" r="1.8" fill="#59B07A" />
        </g>
      </svg>
    </div>
  );
}

/**
 * Clean HeyBroc Independence Showcase with circular Broc emblem, 100% INDEPENDENT ribbon,
 * and 3 numbered soft-mint pledge cards ("Scores Can't Be Bought", "Zero Sponsored Placements", "Shopper-Funded Only").
 */
export function YukaIndependentShowcase({ showLearnMore = true }: { showLearnMore?: boolean }) {
  return (
    <section
      id="independent-section"
      className="yuka-indep-section"
      aria-label="100% Independent Scoring Pledge"
    >
      <div className="yuka-indep-inner">
        <h2 className="yuka-page-h2">Built for shoppers, never Big Food</h2>
        <p className="yuka-page-lead">
          HeyBroc grades every item strictly from its ingredient list and nutrition facts — with zero food-industry money behind the curtain.
        </p>

        {/* Hero Circular Mint Emblem + Broc Mascot + 100% INDEPENDENT Ribbon */}
        <div className="yuka-indep-badge" aria-hidden="true">
          <div className="yuka-indep-circle">
            <span className="yuka-cloud yuka-cloud--left" />
            <span className="yuka-cloud yuka-cloud--right" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/broc-mascot.png" alt="" className="yuka-indep-mascot" />
          </div>
          <div className="yuka-indep-ribbon">100% INDEPENDENT</div>
        </div>

        {/* 3 Clean Sans-Serif Soft-Mint Pledge Cards */}
        <div className="broc-pledge-grid">
          {/* Card 01 */}
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
            <h3 className="broc-pledge-title">Scores Can&apos;t Be Bought</h3>
            <p className="broc-pledge-body">
              Every 0–100 grade is computed deterministically from back-of-box ingredients and nutrition facts. Food brands cannot pay a dime to raise a score or hide an additive.
            </p>
          </article>

          {/* Card 02 */}
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
            <h3 className="broc-pledge-title">Zero Sponsored Placements</h3>
            <p className="broc-pledge-body">
              You will never see paid banner ads or bought shelf space inside HeyBroc. Every Clean Swap earns its spot strictly by outscoring conventional alternatives.
            </p>
          </article>

          {/* Card 03 */}
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
            <h3 className="broc-pledge-title">Shopper-Funded Only</h3>
            <p className="broc-pledge-body">
              Supported by optional Family Pro memberships and clearly marked retail store links that never affect scores — and we never sell your family&apos;s scan or cart data.
            </p>
          </article>
        </div>

        {showLearnMore && (
          <div className="yuka-indep-cta-row">
            <a href="/independence" className="yuka-green-pill-btn">
              Read Our Independence Pledge →
            </a>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Wavy faint-green Clean Swaps showcase with tilted floating Poor -> Excellent white product cards & soft ground shadows.
 */
export function YukaSwapShowcase() {
  return (
    <section
      id="yuka-swap-showcase"
      className="yuka-swap-showcase"
      aria-label="Recommendations for cleaner groceries"
    >
      <div className="yuka-swap-wave-box">
        <h2 className="yuka-page-h2">
          Instant Clean Swaps
          <br />
          for flagged groceries
        </h2>
        <p className="yuka-page-lead">
          Whenever an everyday item flags for seed oils, synthetic dyes, or refined syrups, HeyBroc links directly to a cleaner alternative in your store.
        </p>

        <div className="yuka-swap-pairs">
          {/* Pair 1: Ranch Dressing */}
          <div className="yuka-swap-pair">
            <div className="yuka-tilt-col">
              <div className="yuka-tilt-card yuka-tilt-card--bad">
                <span className="yuka-corner-badge yuka-corner-badge--bad" aria-label="Flagged product">
                  ✕
                </span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/onboarding-poor-pick.jpg"
                  alt="Conventional Creamy Ranch Dressing"
                  className="yuka-tilt-img"
                  loading="lazy"
                />
                <strong className="yuka-tilt-name">Creamy Ranch</strong>
                <span className="yuka-tilt-rating">
                  <i className="yuka-tilt-dot yuka-tilt-dot--bad" aria-hidden="true" />
                  Poor · 18/100
                </span>
              </div>
              <div className="yuka-card-floor-shadow" aria-hidden="true" />
            </div>

            <div className="yuka-swap-arrow" aria-hidden="true">
              →
            </div>

            <div className="yuka-tilt-col">
              <div className="yuka-tilt-card yuka-tilt-card--good">
                <span className="yuka-corner-badge yuka-corner-badge--good" aria-label="Cleaner recommendation">
                  ✓
                </span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/onboarding-clean-pick.jpg"
                  alt="Organic Avocado Oil Ranch Dressing"
                  className="yuka-tilt-img"
                  loading="lazy"
                />
                <strong className="yuka-tilt-name">Avocado Oil Ranch</strong>
                <span className="yuka-tilt-rating">
                  <i className="yuka-tilt-dot yuka-tilt-dot--good" aria-hidden="true" />
                  Excellent · 94/100
                </span>
              </div>
              <div className="yuka-card-floor-shadow" aria-hidden="true" />
            </div>
          </div>

          {/* Pair 2: Fruit Snacks -> Whole-Fruit Bar */}
          <div className="yuka-swap-pair">
            <div className="yuka-tilt-col">
              <div className="yuka-tilt-card yuka-tilt-card--bad">
                <span className="yuka-corner-badge yuka-corner-badge--bad" aria-label="Flagged product">
                  ✕
                </span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/presets/snacks.jpg"
                  alt="Conventional Dyed Fruit Snacks"
                  className="yuka-tilt-img"
                  loading="lazy"
                />
                <strong className="yuka-tilt-name">Fruit Snacks</strong>
                <span className="yuka-tilt-rating">
                  <i className="yuka-tilt-dot yuka-tilt-dot--orange" aria-hidden="true" />
                  Poor · 14/100
                </span>
              </div>
              <div className="yuka-card-floor-shadow" aria-hidden="true" />
            </div>

            <div className="yuka-swap-arrow" aria-hidden="true">
              →
            </div>

            <div className="yuka-tilt-col">
              <div className="yuka-tilt-card yuka-tilt-card--good">
                <span className="yuka-corner-badge yuka-corner-badge--good" aria-label="Cleaner recommendation">
                  ✓
                </span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/swaps/fruitbar.png"
                  alt="Whole-Fruit & Nut Snack Bar"
                  className="yuka-tilt-img"
                  loading="lazy"
                />
                <strong className="yuka-tilt-name">Whole-Fruit Bar</strong>
                <span className="yuka-tilt-rating">
                  <i className="yuka-tilt-dot yuka-tilt-dot--good" aria-hidden="true" />
                  Excellent · 92/100
                </span>
              </div>
              <div className="yuka-card-floor-shadow" aria-hidden="true" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Full-width faint-green impact band with subtle healthy kitchen/produce silhouettes
 * and handwritten green "healthier" underline accent.
 */
export function YukaImpactBand() {
  return (
    <section className="yuka-impact-band" aria-label="Clean grocery impact">
      <div className="yuka-impact-inner">
        {/* Top-Left Faint Kitchen / Produce Silhouette */}
        <svg className="yuka-impact-art yuka-impact-art--tl" viewBox="0 0 90 90" fill="none" aria-hidden="true">
          <rect x="14" y="18" width="38" height="54" rx="8" fill="#CDEFD9" />
          <circle cx="33" cy="26" r="4" fill="#EAF8EF" />
          <path d="M64 18V72M64 18C71 22 72 38 64 44" stroke="#A9DFBD" strokeWidth="4" strokeLinecap="round" />
        </svg>

        {/* Top-Right Potted Herbs Silhouette */}
        <svg className="yuka-impact-art yuka-impact-art--tr" viewBox="0 0 100 84" fill="none" aria-hidden="true">
          <path d="M22 48H42L38 68H26L22 48Z" fill="#CDEFD9" />
          <path d="M54 40H80L75 68H59L54 40Z" fill="#BFE8CE" />
          <path d="M32 48C26 34 32 24 38 34C40 24 46 34 32 48Z" fill="#A9DFBD" />
          <path d="M67 40C58 22 66 12 72 26C76 14 84 26 67 40Z" fill="#A9DFBD" />
          <rect x="14" y="68" width="74" height="5" rx="2.5" fill="#F7FDF9" />
        </svg>

        {/* Bottom-Left Simmering Pot Silhouette */}
        <svg className="yuka-impact-art yuka-impact-art--bl" viewBox="0 0 100 80" fill="none" aria-hidden="true">
          <path d="M40 38H82V62C82 67 78 70 73 70H49C44 70 40 67 40 62V38Z" fill="#BFE8CE" />
          <rect x="16" y="40" width="26" height="5" rx="2.5" fill="#F7FDF9" />
          <path d="M52 28C50 22 54 18 52 12M62 28C60 22 64 18 62 12M72 28C70 22 74 18 72 12" stroke="#F7FDF9" strokeWidth="2.5" strokeLinecap="round" />
        </svg>

        {/* Bottom-Right Olive Oil & Apple Silhouette */}
        <svg className="yuka-impact-art yuka-impact-art--br" viewBox="0 0 100 86" fill="none" aria-hidden="true">
          <circle cx="28" cy="58" r="15" fill="#BFE8CE" />
          <path d="M28 42C30 37 35 36 37 39" stroke="#9ED8B3" strokeWidth="2.5" strokeLinecap="round" />
          <rect x="50" y="26" width="18" height="46" rx="6" fill="#CDEFD9" />
          <rect x="55" y="16" width="8" height="12" rx="3" fill="#BFE8CE" />
          <rect x="72" y="42" width="14" height="30" rx="5" fill="#BFE8CE" />
        </svg>

        <h2 className="yuka-impact-heading">
          With HeyBroc, families decode back-of-box labels in 1 second
          <br />
          and fill every grocery cart{" "}
          <span className="broc-impact-accent">cleaner.</span>
        </h2>

        <a href="/swaps" className="yuka-green-pill-btn">
          Browse Clean Swaps Directory
        </a>
      </div>
    </section>
  );
}

/**
 * Clean, airy 4-column Yuka-inspired footer sitting directly above the countryside meadow scenery.
 */
export function YukaSiteFooter({
  onManageSubscription,
}: {
  onManageSubscription?: () => void;
}) {
  return (
    <footer className="site-footer-wrap yuka-footer">
      <div className="yuka-footer-cols">
        <div className="yuka-footer-brand-col">
          <a href="/" className="yuka-footer-logo">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/broc-mascot.png" alt="HeyBroc mascot" />
            <span>HeyBroc</span>
          </a>
          <p className="yuka-footer-tagline">
            100% independent food &amp; grocery ingredient grader across 12 stores.
          </p>
          <div className="yuka-footer-badges">
            <a href="/tools#mobile-setup" className="yuka-store-badge">
              <span></span>
              <div>
                <small>Setup on</small>
                <strong>iPhone &amp; Safari</strong>
              </div>
            </a>
            <a href="/heybroc.apk" download="heybroc.apk" className="yuka-store-badge">
              <span>▶</span>
              <div>
                <small>Download for</small>
                <strong>Android (.apk)</strong>
              </div>
            </a>
          </div>
        </div>

        <div className="yuka-footer-col">
          <h4>Our Mission</h4>
          <a href="/independence">100% Independence</a>
          <a href="/swaps">Clean Swaps Directory</a>
          <a href="/creators">Creator Partners (35%)</a>
        </div>

        <div className="yuka-footer-col">
          <h4>Grocery Tools</h4>
          <a href="/">12-Store Live Bubble</a>
          <a href="/tools">Free Label Grader</a>
          <a href="/tools#mobile-setup">Mobile Setup Guide</a>
        </div>

        <div className="yuka-footer-col">
          <h4>Legal &amp; Billing</h4>
          <a href="/terms">Terms of Service</a>
          <a href="/privacy">Privacy Policy</a>
          {onManageSubscription ? (
            <button type="button" onClick={onManageSubscription} className="yuka-footer-text-btn">
              Manage / Cancel subscription
            </button>
          ) : (
            <a href="/?login=1">Account &amp; Billing</a>
          )}
        </div>
      </div>

      <div className="yuka-footer-disclosures">
        <details className="yuka-disclosure-box">
          <summary>How HeyBroc Grades Groceries &amp; Scoring FAQ</summary>
          <div className="yuka-disclosure-body">
            <div>
              <strong>How does HeyBroc calculate its 0 to 100 food and ingredient score?</strong>
              <p>
                HeyBroc grades products on a deterministic 0–100 scale across three pillars: <b>Nutritional Quality (60%)</b> based on sugar, sodium, saturated fat, calories, fiber, and protein; <b>Clean-Label Additives (30%)</b> penalizing synthetic dyes, refined seed oils, chemical preservatives, nitrites, and emulsifiers; and a <b>Certified Organic Bonus (10%)</b>. Any high-risk additive automatically caps a product&apos;s maximum score at 49/100.
              </p>
            </div>
            <div>
              <strong>Which grocery stores work with the HeyBroc floating bubble?</strong>
              <p>
                HeyBroc&apos;s Live Store Bubble works automatically across 12 major grocery stores and delivery apps: <b>Walmart, Instacart, Target, Kroger, ALDI, Costco, Sam&apos;s Club, BJ&apos;s Wholesale, Amazon Fresh, DoorDash, Uber Eats, and Shipt</b>—without needing to scan physical barcodes.
              </p>
            </div>
            <div>
              <strong>Does HeyBroc accept payments from brands to change product scores?</strong>
              <p>
                No. HeyBroc is 100% independent. Brands cannot pay to alter a score or buy placement in Top Picks. Every product score and 1-for-1 Clean Swap is computed deterministically from its ingredient list and nutrition facts.
              </p>
            </div>
          </div>
        </details>

        <details className="yuka-disclosure-box">
          <summary>Independent Opinion, Label Verification, Pricing &amp; Non-Affiliation Notice</summary>
          <div className="yuka-disclosure-body">
            <p>
              HeyBroc 0–100 scores and ratings represent HeyBroc&apos;s subjective clean-label opinion for informational grocery comparison only and do not constitute medical, nutritional, or regulatory safety advice. Most flagged additives, dyes, and oils are permitted for food use or recognized as GRAS by the U.S. FDA. Ingredient lists shown in the simulator and catalog are representative estimates from public databases (Open Food Facts, USDA FoodData Central); manufacturers reformulate products frequently and retail prices vary by store and location—always verify the physical product package and live store checkout price before purchasing. When you tap a Clean Swap retail link marked &ldquo;paid link&rdquo;, HeyBroc may earn an affiliate commission at no extra cost to you. HeyBroc is an independent software application and is not affiliated with, endorsed by, or sponsored by Walmart, Target, Instacart, Kroger, ALDI, Costco, Sam&apos;s Club, BJ&apos;s Wholesale Club, Amazon, Whole Foods Market, DoorDash, Uber Eats, Shipt, or any food or beverage manufacturer. All retailer and brand names are trademarks of their respective owners and are used strictly for nominative identification.
            </p>
          </div>
        </details>
      </div>
    </footer>
  );
}

/**
 * Original HeyBroc Kitchen Counter Grocery Unpacking Scene:
 * Soft mint subway-tile kitchen backsplash, warm butcher-block & sage cabinetry along the bottom,
 * a kraft paper grocery bag overflowing with fresh whole foods (leafy greens, carrots, baguette, apple),
 * glass extra-virgin olive oil & farm milk bottles, wooden cutting board with avocado & lemon,
 * and our giant celebratory U-eye Broc mascot cheering right on the kitchen counter!
 */
export function FooterKitchenScenery() {
  return (
    <div id="footer-kitchen-scenery" className="footer-kitchen-scenery">
      <svg
        className="footer-kitchen-svg"
        viewBox="0 0 1440 284"
        preserveAspectRatio="xMidYMax slice"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          {/* Subtle Mint Kitchen Subway Tile Backsplash Pattern */}
          <pattern id="kitchenSubwayTile" width="76" height="34" patternUnits="userSpaceOnUse">
            <rect x="2" y="2" width="72" height="13" rx="3" stroke="#DCEFE3" strokeWidth="1.2" fill="#F8FDFA" />
            <rect x="-36" y="19" width="72" height="13" rx="3" stroke="#DCEFE3" strokeWidth="1.2" fill="#F8FDFA" />
            <rect x="40" y="19" width="72" height="13" rx="3" stroke="#DCEFE3" strokeWidth="1.2" fill="#F8FDFA" />
          </pattern>
          <linearGradient id="backsplashFade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="1" />
            <stop offset="32%" stopColor="#FFFFFF" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#EAF7EF" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Soft Kitchen Backsplash Zone */}
        <rect x="0" y="34" width="1440" height="168" fill="url(#kitchenSubwayTile)" />
        <rect x="0" y="30" width="1440" height="172" fill="url(#backsplashFade)" />

        {/* Left Floating Wooden Kitchen Shelf with Mason Jars & Potted Basil */}
        <g transform="translate(150, 56)">
          {/* Shelf shadow & plank */}
          <rect x="4" y="54" width="196" height="7" rx="3.5" fill="#DCECE2" />
          <rect x="0" y="48" width="196" height="8" rx="4" fill="#D9A673" />
          <rect x="24" y="56" width="8" height="10" rx="2" fill="#B98552" />
          <rect x="164" y="56" width="8" height="10" rx="2" fill="#B98552" />
          {/* Rolled Oats Glass Jar */}
          <rect x="22" y="14" width="30" height="34" rx="6" fill="#FFFFFF" stroke="#B7DEC5" strokeWidth="2" />
          <rect x="24" y="24" width="26" height="22" rx="4" fill="#F2DEC1" />
          <rect x="25" y="9" width="24" height="6" rx="2.5" fill="#C68E59" />
          {/* Honey / Chia Seeds Jar */}
          <rect x="64" y="20" width="26" height="28" rx="6" fill="#FFFFFF" stroke="#B7DEC5" strokeWidth="2" />
          <rect x="66" y="30" width="22" height="16" rx="3.5" fill="#F7C95C" />
          <rect x="67" y="15" width="20" height="5.5" rx="2.5" fill="#C68E59" />
          {/* Terracotta Potted Kitchen Herbs */}
          <path d="M132 28H164L159 48H137L132 28Z" fill="#DF8A65" />
          <rect x="129" y="24" width="38" height="5" rx="2.5" fill="#CC7652" />
          <path d="M148 24C140 12 132 14 136 22C132 10 144 4 148 16C152 4 164 10 160 22C164 14 156 12 148 24Z" fill="#2FA85A" />
        </g>

        {/* Sunny Kitchen Window Hint (Center-Right Wall) */}
        <g transform="translate(868, 36)" opacity="0.72">
          <rect x="0" y="0" width="124" height="88" rx="12" fill="#EAF8F0" stroke="#CDE8D7" strokeWidth="3" />
          <line x1="62" y1="3" x2="62" y2="85" stroke="#CDE8D7" strokeWidth="2.5" />
          <line x1="3" y1="44" x2="121" y2="44" stroke="#CDE8D7" strokeWidth="2.5" />
          <circle cx="96" cy="22" r="9" fill="#FDE68A" opacity="0.85" />
          <rect x="-6" y="86" width="136" height="6" rx="3" fill="#DCEFE3" />
        </g>

        {/* ============ FULL-WIDTH KITCHEN COUNTERTOP & SAGE CABINETRY ============ */}
        {/* Countertop Top Surface */}
        <path d="M0 194H1440V212H0V194Z" fill="#FBF8F1" />
        {/* Warm Butcher-Block Countertop Front Edge */}
        <rect x="0" y="210" width="1440" height="13" fill="#DDA974" />
        <rect x="0" y="221" width="1440" height="3" fill="#C48E5A" />

        {/* Sage-Green Shaker Kitchen Cabinets Below Counter */}
        <rect x="0" y="224" width="1440" height="60" fill="#2A8F52" />
        {/* Subtle Shaker Cabinet Door Panels & Brass Knobs */}
        <g opacity="0.92">
          <rect x="76" y="233" width="220" height="44" rx="5" fill="#237E47" stroke="#3CA565" strokeWidth="1.5" />
          <rect x="316" y="233" width="220" height="44" rx="5" fill="#237E47" stroke="#3CA565" strokeWidth="1.5" />
          <rect x="556" y="233" width="328" height="20" rx="4" fill="#237E47" stroke="#3CA565" strokeWidth="1.5" />
          <rect x="556" y="258" width="328" height="20" rx="4" fill="#237E47" stroke="#3CA565" strokeWidth="1.5" />
          <rect x="904" y="233" width="220" height="44" rx="5" fill="#237E47" stroke="#3CA565" strokeWidth="1.5" />
          <rect x="1144" y="233" width="220" height="44" rx="5" fill="#237E47" stroke="#3CA565" strokeWidth="1.5" />
          {/* Warm Brass Drawer Pulls & Knobs */}
          <circle cx="280" cy="248" r="3.2" fill="#F4CF7B" />
          <circle cx="332" cy="248" r="3.2" fill="#F4CF7B" />
          <rect x="698" y="241.5" width="44" height="3.5" rx="1.75" fill="#F4CF7B" />
          <rect x="698" y="266.5" width="44" height="3.5" rx="1.75" fill="#F4CF7B" />
          <circle cx="1108" cy="248" r="3.2" fill="#F4CF7B" />
          <circle cx="1160" cy="248" r="3.2" fill="#F4CF7B" />
        </g>

        {/* ============ COUNTERTOP GROCERY UNPACKING PROPS ============ */}

        {/* 1. Glass Farm Milk Bottle + Extra-Virgin Olive Oil Bottle (Left-Center) */}
        <g transform="translate(362, 102)">
          <ellipse cx="48" cy="101" rx="48" ry="5" fill="#D5E7DC" opacity="0.7" />
          {/* Farm Milk Glass Bottle */}
          <path
            d="M16 20H32L35 36C39 42 41 49 41 58V94C41 98 38 101 34 101H14C10 101 7 98 7 94V58C7 49 9 42 13 36L16 20Z"
            fill="#FFFFFF"
            stroke="#AEDAC0"
            strokeWidth="2.2"
          />
          <path d="M10 49H38V93C38 96 36 98 33 98H15C12 98 10 96 10 93V49Z" fill="#F6FBF8" />
          <rect x="13" y="15" width="22" height="6" rx="3" fill="#2FA85A" />
          <rect x="13" y="62" width="22" height="16" rx="3" fill="#E3F6EA" />
          <circle cx="24" cy="70" r="4" fill="#2FA85A" />

          {/* Dark-Green Extra-Virgin Olive Oil Bottle */}
          <rect x="60" y="12" width="10" height="8" rx="2.5" fill="#C9925B" />
          <path
            d="M59 20H71L74 36C79 41 82 48 82 56V95C82 98.5 79.5 101 76 101H54C50.5 101 48 98.5 48 95V56C48 48 51 41 56 36L59 20Z"
            fill="#4D9E56"
          />
          {/* Curved glass highlight */}
          <path d="M54 46V88" stroke="#85CE8B" strokeWidth="2.5" strokeLinecap="round" opacity="0.65" />
          {/* Clean EVOO Label */}
          <rect x="53" y="56" width="24" height="24" rx="3.5" fill="#FBF8EE" />
          <circle cx="65" cy="66" r="4.5" fill="#9BC53D" />
          <path d="M65 61L68 58" stroke="#2D7D46" strokeWidth="1.6" strokeLinecap="round" />
          <rect x="57" y="74" width="16" height="2.2" rx="1.1" fill="#2D7D46" opacity="0.55" />
        </g>

        {/* 2. Centerpiece Kraft Paper Grocery Bag Overflowing with Clean Whole Foods */}
        <g transform="translate(526, 62)">
          {/* Counter shadow */}
          <ellipse cx="78" cy="142" rx="74" ry="6.5" fill="#CEE3D6" opacity="0.8" />

          {/* Produce Peeking Out of the Top of the Grocery Bag */}
          {/* Crusty Artisan Sourdough Baguette (Left) */}
          <g transform="translate(18, 6) rotate(-14)">
            <rect x="0" y="8" width="32" height="68" rx="15" fill="#E3A857" />
            <path d="M8 22L22 17M8 34L22 29M8 46L22 41" stroke="#FFF3D6" strokeWidth="2.6" strokeLinecap="round" />
          </g>

          {/* Lush Leafy Kale / Romaine Greens (Center) */}
          <path
            d="M56 58C46 34 52 10 68 8C78 6 86 18 84 36C90 16 104 8 114 16C124 24 118 46 104 60Z"
            fill="#289E53"
          />
          <path
            d="M68 54V18M68 34L60 26M68 42L76 34M98 54L108 24M103 38L112 33"
            stroke="#B9F0CA"
            strokeWidth="2.2"
            strokeLinecap="round"
          />

          {/* Fresh Garden Carrots with Feathery Tops (Right) */}
          <g transform="translate(102, 16) rotate(14)">
            <path d="M14 26C8 12 4 4 10 2C14 10 16 18 16 26" stroke="#2FA85A" strokeWidth="3" strokeLinecap="round" />
            <path d="M18 26C18 10 22 2 27 4C26 12 22 20 19 26" stroke="#228B47" strokeWidth="3" strokeLinecap="round" />
            <path d="M6 26H26L20 68C19 72 13 72 12 68L6 26Z" fill="#F97316" />
            <path d="M11 35H18M13 45H19" stroke="#FDBA74" strokeWidth="2" strokeLinecap="round" />
          </g>

          {/* Crisp Orchard Red Apple Peeking Over Rim */}
          <circle cx="58" cy="54" r="15" fill="#EF4444" />
          <path d="M58 39C59 34 63 32 66 34" stroke="#5A3E2B" strokeWidth="2.2" strokeLinecap="round" />
          <path d="M60 36C65 33 70 35 69 40C65 41 61 39 60 36Z" fill="#34B364" />

          {/* Twisted Paper Bag Handles */}
          <path d="M54 58V44C54 36 62 32 72 32C82 32 90 36 90 44V58" stroke="#C59663" strokeWidth="4" strokeLinecap="round" fill="none" />

          {/* Kraft Paper Grocery Bag Body */}
          <path d="M22 56H132L126 141H28L22 56Z" fill="#DFB382" />
          {/* Side Gusset Shadow */}
          <path d="M112 56H132L126 141H108L112 56Z" fill="#CCA06E" />
          {/* Zig-Zag Kraft Top Edge */}
          <path
            d="M22 56L29 51L36 56L43 51L50 56L57 51L64 56L71 51L78 56L85 51L92 56L99 51L106 56L113 51L120 56L127 51L132 56"
            stroke="#F2D1A8"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          {/* Clean "100% CLEAN" Leaf Emblem on the Paper Bag */}
          <circle cx="68" cy="99" r="20" fill="#F8E7CE" />
          <path
            d="M60 100L66 106L78 93"
            stroke="#189E52"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>

        {/* 3. Wooden Cutting Board + Sliced Avocado, Lemon & Cherry Tomatoes (Center-Right) */}
        <g transform="translate(716, 152)">
          <ellipse cx="78" cy="52" rx="76" ry="5" fill="#D5E7DC" opacity="0.75" />
          {/* Cutting Board */}
          <rect x="8" y="40" width="128" height="10" rx="5" fill="#CFA06E" />
          <rect x="130" y="42" width="18" height="6" rx="3" fill="#B88756" />
          {/* Halved Clean Avocado */}
          <g transform="translate(26, 8)">
            <path d="M18 2C8 2 2 14 2 23C2 30 9 34 18 34C27 34 34 30 34 23C34 14 28 2 18 2Z" fill="#2A7B46" />
            <path d="M18 5C10 5 5 15 5 22.5C5 28 10.5 31 18 31C25.5 31 31 28 31 22.5C31 15 26 5 18 5Z" fill="#CBE87B" />
            <circle cx="18" cy="21" r="6.5" fill="#8D5836" />
            <circle cx="16" cy="19" r="2" fill="#B67E59" />
          </g>
          {/* Sunny Lemon Wedge */}
          <g transform="translate(72, 18)">
            <path d="M2 18C2 8 10 2 20 2C30 2 38 8 38 18C38 21 35 23 32 23H8C5 23 2 21 2 18Z" fill="#FACC15" />
            <path d="M6 18C6 11 12 6 20 6C28 6 34 11 34 18H6Z" fill="#FEF08A" />
          </g>
          {/* Two Vine Cherry Tomatoes */}
          <circle cx="122" cy="31" r="9.5" fill="#EF4444" />
          <path d="M122 20L120 17M122 20L125 18" stroke="#228B47" strokeWidth="2" strokeLinecap="round" />
          <circle cx="140" cy="33" r="8" fill="#F87171" />
        </g>

        {/* 4. Ceramic Fruit Bowl on Far Right Behind Broc */}
        <g transform="translate(1235, 148)">
          <ellipse cx="42" cy="55" rx="36" ry="4.5" fill="#D5E7DC" />
          <circle cx="30" cy="24" r="12" fill="#FB923C" />
          <circle cx="48" cy="22" r="12" fill="#84CC16" />
          <circle cx="60" cy="28" r="10" fill="#FACC15" />
          <path d="M8 28H76C74 45 60 54 42 54C24 54 10 45 8 28Z" fill="#E6F6EC" stroke="#B6DEC5" strokeWidth="2" />
        </g>
      </svg>

      {/* Giant Celebratory U-Eye Broc Mascot Standing Proudly on the Kitchen Counter */}
      <div className="kitchen-broc-wrap">
        <div className="kitchen-broc-badge" aria-hidden="true">
          ✓ 100/100 Haul!
        </div>
        <div className="kitchen-broc-shadow" aria-hidden="true" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          id="footer-kitchen-broc"
          src="/broc-mascot-meadow.png"
          alt="Cheerful HeyBroc broccoli mascot celebrating a clean grocery haul on the kitchen counter"
          className="kitchen-broc-mascot"
          loading="lazy"
        />
      </div>
    </div>
  );
}

