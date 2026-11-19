# HeyBroc — App Store & Google Play A/B Screenshot & Onboarding Playbook

This playbook captures the high-converting consumer app principles from top food scanners and fitness apps (no immediate sign-up gate, multi-question personalized onboarding, guaranteed subscription paywall reach targeting ~85–90%, and native A/B store screenshot testing).

---

## 1. "Copy the Structure, Never Their Assets" (Store Legal Safety)

When modeling HeyBroc's App Store and Google Play screenshots after top-converting food scanners (Yuka, Trash Panda, Bobby Approved, Seed Oil Scout, Fig):
- **DO adopt proven conversion structure:**
  - Giant, readable **0–100 score contrast** visible directly from App Store / Play Store search thumbnails (first 3 screenshots do ~80% of the work).
  - High-contrast **Red (`0–49 Poor`) → Green (`75–100 Excellent`)** visual storytelling with unmistakable 1-tap Clean Swap outcome.
  - Ultra-short, bold **3–5 word headlines** at the top 25% of every slide.
  - Zoomed, bottom-bleeding UI cards so additive badges (`Red 40`, `Soybean Oil`, `TBHQ`) are readable at thumbnail scale.
- **NEVER copy competitor assets or trademarks:**
  - Never use another app's name, icon, copyrighted mascot, or proprietary screenshots inside App Store or Play Store graphics (Apple Review Guideline 4.1 / Google Play Impersonation Policy).
  - Never show unverified retail dollar prices, medical claims, blood-glucose predictions, or fake award laurels.
  - Always use HeyBroc's exact 3-tier rubric (`75–100 Excellent`, `50–74 Mediocre`, `0–49 Poor`) and accurate store counts (`12 US grocery store backends / 13 Live Shop tiles`).

---

## 2. 3-Variant A/B Screenshot Test Matrix

Preview all 3 decks side by side in [`store-assets/aso-screenshots/ab-variants.html`](./aso-screenshots/ab-variants.html).

| Variant | Strategy / Inspiration | Slide 1 (Search Hook) | Slide 2 (Core Reveal) | Slide 3 (Payoff / Differentiation) |
| :--- | :--- | :--- | :--- | :--- |
| **Control (Variant A)** — *Current `store-assets/` Deepstash Deck* | High-saturation color-blocked category disruption | `~~Barcode Apps~~ for online grocery` + Broc mascot & additive radar | `Replace mystery labels with 0–100 scores` (`6/100` → `100/100`) | `Spot Seed Oils, Red 40 & hidden toxins` |
| **Challenger B ("Top Food Scanner Shock-Score")** | Classic top food-scanner layout (clean white/emerald minimalist + giant score ring) | **`What's Hiding in Your Cart?`** — Huge `6/100 Poor` score card (`Soybean Oil · MSG · EDTA`) + instant `80/100 Excellent` Clean Swap below | **`Flag Seed Oils & Red 40 in 1 Tap`** — Zoomed additive breakdown (`Red 40`, `Blue 1`, `TBHQ`, `HFCS`) with 2x Family Watchlist badge | **`Scan Online Carts & Barcodes`** — Works on Walmart, Target, Costco, Instacart, Kroger, ALDI & Amazon Fresh + camera barcode scanner |
| **Challenger C ("Online Grocery Cart Badges")** | Differentiation-first for online delivery & pickup shoppers | **`Live 0–100 Badges While You Shop`** — Realistic online grocery grid showing floating red/green score pills directly on product tiles | **`Swap Flagged Cart Items in 1 Tap`** — Side-by-side `0/100` → `90/100` clean swap inside your active store + Store-Brand Priority | **`Audit Your Whole Weekly Order`** — Cart health score climb (`42/100` → `89/100`) + Big-9 allergen alerts |

---

## 3. How to Run These A/B Tests (Zero Code Changes Required)

### Apple App Store Connect — Product Page Optimization (PPO)
1. Publish your primary release first with **Control (Variant A)** (or **Challenger B** if you want the classic food-scanner visual first).
2. In **App Store Connect → Features → Product Page Optimization → Create Test**:
   - Name: `ASO Screenshots v1 — Shock Score vs Online Cart vs Deepstash`
   - Treatments: `2` (Test **Challenger B** and **Challenger C** against Control)
   - Traffic proportion: `34% Control / 33% Challenger B / 33% Challenger C`
   - Upload exact **`1290 × 2796 px`** (6.7" iPhone) portrait JPEGs/PNGs for each treatment.
3. Run until Apple reports **≥90% confidence** (typically 14–28 days or ~1,000+ impressions per variant), then click **Apply Treatment to Original Product Page** on the winner.

### Google Play Console — Store Listing Experiments
1. In **Google Play Console → Grow users → Store listing experiments → Create experiment**:
   - Experiment type: **Default graphics**
   - Attributes to test: **Screenshots only** (isolate one variable at a time!)
   - Variants: **Challenger B** (`50%` split first; then run winner vs. **Challenger C**)
   - Upload exact **`1080 × 1920 px`** (9:16) portrait JPEGs/PNGs.
2. Wait for **90% confidence** and apply the winner — then start the next experiment testing **App Icon** or **Short Description**.

---

## 4. Onboarding & Paywall Reach Checklist (Fitness-App / Superwall Benchmark)

Target metrics (modeled on top-performing consumer apps like Kori's ~88% Paywall Reach Rate & ~12.5% Initial Conversion Rate, and Jake Silverstein's 3 onboarding rules):

| Rule | HeyBroc Current Status | Action / Verification |
| :--- | :--- | :--- |
| **1. Don't ask for sign-up immediately** | **PASS (Web, iOS, Android)** — Guest-first on entry; account creation is deferred until post-onboarding or post-Pro save. | Keep sign-up strictly optional on first launch across all 3 platforms. |
| **2. Longer, personalized onboarding questionnaire** | **PASS** — Web has 7-step `WatchlistMiniFunnel` (Household → 12 Stores → 2x Additives → Allergies/Diet → Shock Example → Live Preview → Personalized Plan); Android `MainActivity.kt` has multi-step onboarding. | Before App Store launch, confirm first-launch iOS experience opens the personalized 7-step onboarding funnel (not a bare search screen) so every new install answers the personalization questions. |
| **3. Every new user sees the subscription screen (~80–90% Paywall Rate)** | **WIRED + MEASURED** — `WatchlistMiniFunnel` Step 7 primary CTA opens Paywall / StoreKit; `/test` Step 2 surfaces direct Pro Trial + 60-Sec Plan CTA; `/admin` now tracks **Paywall Reach Rate**, **Initial Conversion Rate**, and **Per-Angle Conversion (`red40`, `seedoils`, `allergies`, `online`, `budget`)**. | Monitor **Paywall Reach Rate** in `/admin` after launch. If `< 75%`, trigger the 7-step onboarding funnel automatically on first visit for new non-Pro mobile installs (with a clear `"Continue with Free Plan"` dismiss button). |
| **4. Split hooks & landing pages by specific motivation** | **LIVE** — `/test?angle=red40 \| seedoils \| allergies \| online \| budget` and `/r/[code]?angle=...` pre-configure matching watchlists, shock items, and paywall headlines; `/creators` provides audience-specific UGC operator script kits. | Brief UGC creators to stop chasing empty views and optimize **Paid Conv %** & **Revenue per Click (EPC)** tracked in `/admin` and `/creators`. |
