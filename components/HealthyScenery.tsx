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
 * Yuka-inspired open, borderless "A 100% independent project" showcase with circular
 * mint sky badge, ribbon banner, soft organic icon blobs & handwritten script titles.
 */
export function YukaIndependentShowcase({ showLearnMore = true }: { showLearnMore?: boolean }) {
  return (
    <section
      id="independent-section"
      className="yuka-indep-section"
      aria-label="100% Independent Scoring Project"
    >
      <div className="yuka-indep-inner">
        <h2 className="yuka-page-h2">A 100% independent project</h2>
        <p className="yuka-page-lead">
          HeyBroc&apos;s mission is to help families make cleaner choices in every grocery aisle — with zero influence from food manufacturers.
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

        {/* 3 Open, Borderless Pillars with Handwritten Script Titles & Hand-Drawn Underlines */}
        <div className="yuka-pillars-grid">
          <div className="yuka-pillar">
            <div className="yuka-pillar-blob" aria-hidden="true">
              <svg viewBox="0 0 88 88" width="76" height="76" fill="none">
                <path
                  d="M45 8C67 8 82 24 80 46C78 68 62 82 40 80C18 78 6 62 8 41C10 20 23 8 45 8Z"
                  fill="#EAF8EF"
                />
                {/* Raised palm / stop hand */}
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
            <h3 className="yuka-hand-title">
              No influence from brands
              <svg className="yuka-hand-underline" viewBox="0 0 140 10" fill="none" aria-hidden="true">
                <path d="M4 7C46 2 94 2 136 6" stroke="#22C55E" strokeWidth="3" strokeLinecap="round" />
              </svg>
            </h3>
            <p>
              No food manufacturer or grocery brand can influence the 0–100 scores or cleaner product recommendations offered.
            </p>
          </div>

          <div className="yuka-pillar">
            <div className="yuka-pillar-blob" aria-hidden="true">
              <svg viewBox="0 0 88 88" width="76" height="76" fill="none">
                <path
                  d="M42 9C64 6 81 22 81 44C81 66 65 81 43 80C21 79 7 64 8 42C9 20 20 12 42 9Z"
                  fill="#EAF8EF"
                />
                {/* Megaphone */}
                <path
                  d="M28 42L54 30V58L28 46V42Z"
                  fill="#34B86A"
                />
                <ellipse cx="55" cy="44" rx="4.5" ry="14" fill="#FDBA8C" stroke="#1F8A4C" strokeWidth="2" />
                <rect x="23" y="40" width="6" height="8" rx="2" fill="#D1EDE0" />
                <path d="M31 48L34 59C34.5 61 32 62 30.5 60L27 48" fill="#15803D" />
              </svg>
            </div>
            <h3 className="yuka-hand-title">
              No ads
              <svg className="yuka-hand-underline" viewBox="0 0 90 10" fill="none" aria-hidden="true">
                <path d="M4 7C32 3 60 3 86 6" stroke="#84CC16" strokeWidth="3" strokeLinecap="round" />
              </svg>
            </h3>
            <p>
              Brands cannot pay HeyBroc to run banner ads or sponsor product placements inside the app while you shop.
            </p>
          </div>

          <div className="yuka-pillar">
            <div className="yuka-pillar-blob" aria-hidden="true">
              <svg viewBox="0 0 88 88" width="76" height="76" fill="none">
                <path
                  d="M46 8C68 10 82 27 79 48C76 69 59 82 38 79C17 76 6 59 9 38C12 17 24 6 46 8Z"
                  fill="#EAF8EF"
                />
                {/* Honest green pouch */}
                <path
                  d="M36 27L44 33L52 27C50 23 38 23 36 27Z"
                  fill="#22A85A"
                />
                <path
                  d="M44 33C31 35 25 45 27 56C29 64 36 67 44 67C52 67 59 64 61 56C63 45 57 35 44 33Z"
                  fill="#188C49"
                />
                <path d="M37 33H51" stroke="#FDE68A" strokeWidth="2.8" strokeLinecap="round" />
              </svg>
            </div>
            <h3 className="yuka-hand-title">
              Responsible financing
              <svg className="yuka-hand-underline" viewBox="0 0 130 10" fill="none" aria-hidden="true">
                <path d="M4 7C42 2 88 3 126 6" stroke="#F59E0B" strokeWidth="3" strokeLinecap="round" />
              </svg>
            </h3>
            <p>
              Supported by optional Family Pro memberships and clearly marked retail store links that never affect any product score.
            </p>
          </div>
        </div>

        {showLearnMore && (
          <div className="yuka-indep-cta-row">
            <a href="/independence" className="yuka-green-pill-btn">
              Learn more
            </a>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Yuka-inspired wavy faint-green "Get recommendations for healthier products" section
 * with tilted floating Poor -> Excellent white product cards & soft ground shadows.
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
          Get recommendations
          <br />
          for healthier products
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
          and start eating{" "}
          <span className="yuka-impact-script">
            healthier
            <svg viewBox="0 0 180 12" fill="none" aria-hidden="true">
              <path d="M3 9C58 3 122 3 177 7" stroke="#18B259" strokeWidth="3.2" strokeLinecap="round" />
            </svg>
          </span>
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
          <h4>Project</h4>
          <a href="/independence">Independence</a>
          <a href="/swaps">Clean Swaps</a>
          <a href="/creators">Creators (35%)</a>
        </div>

        <div className="yuka-footer-col">
          <h4>Application</h4>
          <a href="/">12-Store Live Bubble</a>
          <a href="/tools">Free Label Grader</a>
          <a href="/tools#mobile-setup">Mobile Setup</a>
        </div>

        <div className="yuka-footer-col">
          <h4>Useful links</h4>
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
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
 * Full-width storybook countryside footer scenery (cozy cottage, winding path, leafy forest trees,
 * rolling green meadows, and our giant celebratory U-eye Broc mascot on the right hill).
 */
export function FooterMeadowScenery() {
  return (
    <div id="footer-meadow-scenery" className="footer-meadow-scenery">
      <svg
        className="footer-meadow-svg"
        viewBox="0 0 1440 270"
        preserveAspectRatio="xMidYMax slice"
        aria-hidden="true"
      >
        {/* Distant faint-green misty hills */}
        <path
          d="M160 270C230 175 340 128 455 152C545 170 605 110 725 108C855 106 925 168 1030 140C1135 112 1235 66 1340 126C1390 154 1422 206 1440 245V270H160Z"
          fill="#E8F7EE"
        />
        <path
          d="M0 245C110 205 245 168 380 192C515 216 640 156 790 166C940 176 1080 218 1240 186C1330 168 1395 176 1440 192V270H0V245Z"
          fill="#D6F0E0"
        />

        {/* Back Meadow Ridge */}
        <path
          d="M460 270C535 206 635 178 735 182C835 186 920 222 1015 246L1040 270H460Z"
          fill="#49B66D"
        />

        {/* Left Rolling Green Meadow */}
        <path
          d="M0 196C165 198 335 214 515 256L565 270H0V196Z"
          fill="#2E9A54"
        />

        {/* Right Rolling Green Meadow (where giant U-eye Broc stands) */}
        <path
          d="M845 270C985 220 1185 188 1440 184V270H845Z"
          fill="#35A45B"
        />

        {/* Center Foreground Hill */}
        <path
          d="M390 270C525 218 710 208 920 270H390Z"
          fill="#238847"
        />

        {/* Winding Country Path from foreground up to the little cottage */}
        <path
          d="M698 184C690 196 672 204 680 216C688 228 724 240 706 270H754C768 238 718 224 708 212C700 202 708 194 710 184H698Z"
          fill="#EFE7D5"
        />
        <path
          d="M422 236C442 246 452 258 446 270H492C496 254 472 242 444 232L422 236Z"
          fill="#EAE0CA"
          opacity="0.9"
        />
      </svg>

      {/* Crisp Fixed-Proportion Scenery Props (Forest Trees + Cozy Cottage + Giant U-Eye Broc) */}
      <div className="footer-meadow-props" aria-hidden="true">
        <svg
          className="footer-props-svg"
          viewBox="0 0 1440 270"
          preserveAspectRatio="xMidYMax slice"
          fill="none"
        >
          {/* Left Orchard / Forest Tree #1 */}
          <g transform="translate(298, 92)">
            <ellipse cx="26" cy="126" rx="18" ry="4" fill="#1D783E" opacity="0.45" />
            <path d="M26 72V125" stroke="#2D3A32" strokeWidth="4" strokeLinecap="round" />
            <path
              d="M26 10C9 10 2 34 4 62C6 84 15 96 26 96C37 96 46 84 48 62C50 34 43 10 26 10Z"
              fill="#68C777"
            />
            <path
              d="M26 24V90M26 44L14 34M26 58L38 48M26 72L15 62"
              stroke="#E9F9EE"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </g>

          {/* Left Orchard / Forest Tree #2 (Taller) */}
          <g transform="translate(366, 74)">
            <ellipse cx="32" cy="148" rx="22" ry="4.5" fill="#1D783E" opacity="0.45" />
            <path d="M32 86V147" stroke="#2D3A32" strokeWidth="4.5" strokeLinecap="round" />
            <path
              d="M32 8C11 8 2 38 5 72C8 98 18 112 32 112C46 112 56 98 59 72C62 38 53 8 32 8Z"
              fill="#55BA67"
            />
            <path
              d="M32 24V104M32 48L17 36M32 66L47 54M32 82L18 70"
              stroke="#E9F9EE"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </g>

          {/* Mid-Left Meadow Tree (Visible on Mobile & Desktop) */}
          <g transform="translate(506, 122) scale(0.84)">
            <ellipse cx="26" cy="126" rx="18" ry="4" fill="#1D783E" opacity="0.4" />
            <path d="M26 72V125" stroke="#2D3A32" strokeWidth="4" strokeLinecap="round" />
            <path
              d="M26 10C9 10 2 34 4 62C6 84 15 96 26 96C37 96 46 84 48 62C50 34 43 10 26 10Z"
              fill="#5EC16F"
            />
            <path
              d="M26 24V90M26 44L14 34M26 58L38 48M26 72L15 62"
              stroke="#E9F9EE"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </g>

          {/* Distant Woodland Sapling Left of Cottage */}
          <g transform="translate(602, 152) scale(0.55)">
            <path d="M24 62V96" stroke="#2D3A32" strokeWidth="4" strokeLinecap="round" />
            <path
              d="M24 8C10 8 4 30 6 52C8 70 15 80 24 80C33 80 40 70 42 52C44 30 38 8 24 8Z"
              fill="#68C777"
            />
            <path d="M24 22V74M24 44L14 35M24 56L34 47" stroke="#E9F9EE" strokeWidth="2.2" strokeLinecap="round" />
          </g>

          {/* Cozy Little Countryside House / Cottage on the Center Hill */}
          <g transform="translate(682, 146)">
            <rect x="34" y="4" width="6" height="14" rx="1" fill="#8C6D58" />
            <circle cx="38" cy="-2" r="2.5" fill="#DCEFE3" />
            <circle cx="42" cy="-8" r="3.5" fill="#E6F6EC" />
            <path d="M6 22L20 8L34 22V42H6V22Z" fill="#FBF7EE" />
            <path d="M34 22H56V42H34V22Z" fill="#EFE6D5" />
            <path d="M3 23L20 6L36 23H3Z" fill="#5A4638" />
            <path d="M20 6H43L59 23H35L20 6Z" fill="#46352A" />
            <rect x="16" y="29" width="7" height="13" rx="1.5" fill="#6E523F" />
            <rect x="10" y="21" width="5" height="5" rx="1" fill="#FDE68A" />
            <rect x="41" y="27" width="6" height="6" rx="1" fill="#FDE68A" />
            <rect x="49" y="27" width="5" height="6" rx="1" fill="#FDE68A" />
          </g>

          {/* Distant Woodland Saplings Right of Cottage */}
          <g transform="translate(766, 148) scale(0.58)">
            <path d="M24 62V96" stroke="#2D3A32" strokeWidth="4" strokeLinecap="round" />
            <path
              d="M24 8C10 8 4 30 6 52C8 70 15 80 24 80C33 80 40 70 42 52C44 30 38 8 24 8Z"
              fill="#68C777"
            />
            <path d="M24 22V74M24 44L14 35M24 56L34 47" stroke="#E9F9EE" strokeWidth="2.2" strokeLinecap="round" />
          </g>

          <g transform="translate(848, 174) scale(0.62)">
            <path d="M24 62V98" stroke="#2D3A32" strokeWidth="4" strokeLinecap="round" />
            <path
              d="M24 8C10 8 4 30 6 52C8 70 15 80 24 80C33 80 40 70 42 52C44 30 38 8 24 8Z"
              fill="#55BA67"
            />
            <path d="M24 22V74M24 44L14 35M24 56L34 47" stroke="#E9F9EE" strokeWidth="2.2" strokeLinecap="round" />
          </g>

          {/* Tiny Meadow Wildflowers */}
          <circle cx="240" cy="236" r="2.5" fill="#FEF9C3" />
          <circle cx="545" cy="248" r="2.5" fill="#FEF9C3" />
          <circle cx="965" cy="244" r="2.5" fill="#FEF9C3" />
          <circle cx="1290" cy="232" r="2.8" fill="#FEF9C3" />
        </svg>

        {/* Giant Celebratory U-Eye Broc Mascot standing on the right hill */}
        <div className="meadow-broc-wrap">
          <div className="meadow-broc-shadow" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            id="footer-meadow-broc"
            src="/broc-mascot-meadow.png"
            alt="Cheerful HeyBroc broccoli mascot on a sunny green hill"
            className="meadow-broc-mascot"
            loading="lazy"
          />
        </div>
      </div>
    </div>
  );
}
