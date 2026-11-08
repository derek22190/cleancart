# HeyBroc (CleanCart PureOverlay)

**Live Production App & API:** [https://heybroc.com](https://heybroc.com) (fallback: `https://cleancart-teal.vercel.app`)

Zero-friction grocery ingredient grader and 1-tap affiliate swap engine that floats over **Walmart**, **Instacart**, **Sam's Club**, and **BJ's Wholesale** (native Android apps + desktop web stores + iOS Share Sheet / Back Tap / Action Button).

---

## Core Product Rules

1. **Unified 3-Pillar Yuka + Additive Scoring** (`lib/rubric.ts` — `scoreProductYuka`): Every surface (Web Simulator, `/api/scan`, `/api/audit`, Android overlay, Chrome extension, and iOS Shortcut) uses `scoreProductYuka`, combining 60% Nutritional Quality (Nutri-Score A–E per 100g: calories, sugar, saturated fat, sodium, fiber, protein, fruits/veg/nuts), 30% Chemical Additives (`scoreIngredients`), and 10% Certified Organic Bonus, with hard caps for High-Risk additives (`<= 49/100`) and Tier 2 seed oils (`<= 59/100`).
2. **Deterministic Rubric (`lib/rubric.ts`)**: Starts at `100`, deducts `-35` (High Risk), `-20` (Moderate Risk), `-10` (Low Risk), clamps `0..100`, and supports user-customizable watchlist category toggles.
3. **Zero-Scraping / $0 Infrastructure (`lib/lookup.ts`)**: Reads product titles/ingredients client-side from the user's screen, resolves ingredients via Open Food Facts v2 + USDA FoodData Central with local caching (`<5ms` repeat lookups).
4. **Legitimate Affiliate Attribution (`lib/swaps.ts`)**: Impact.com affiliate links (`?irgwc=1&clickid=YOUR_IMPACT_ID`) fire **only** when the user explicitly taps **"Swap Item"**.

---

## Phase 6 Upgrades Included

1. **Dual-Mode Floating Bubble (`Product Score` ↔ `🛒 Cart Avg`)**:
   - **Mode A (Product View)**: Shows `{score}/100 • Tap to Inspect`.
   - **Mode B (Scrolling Search / Aisle View)**: Automatically switches to `🛒 Cart Avg: {avgScore}/100` (Red `<50`, Yellow `50–74`, Green `75+`).
   - **Live Gamification**: Every 1-tap swap animates `🛒 Cart Avg` climbing in real time (`48/100` → `71/100` → `100/100`).
   - **Tapping in Cart Avg mode**: Opens the **Whole-Cart MCP Auditor** drawer directly.
   - **Drag-to-Hide Dismiss Target**: Drag the bubble onto the bottom-center `✕ Hide for this trip` target (or tap the quick-snooze button) to hide until the next store trip.
2. **9:16 Viral "Clean Haul Scorecard" Generator** (`components/Scorecard.tsx`):
   - Inside the Whole-Cart Auditor modal, click **"Generate 9:16 TikTok/IG Scorecard"** to preview and download a `1080×1920` story card with store badge, final cart grade, **Watchlist Additives Dodged Today** (`🚫 Red 40`, `🚫 High Fructose Corn Syrup`, etc.), top clean swaps, and custom creator referral watermark.
3. **High-Converting Paywall Modal & Referral Engine** (`components/Paywall.tsx` + `lib/referrals.ts`):
   - Product scores (`0–100`), expanded additive explanations, and live `🛒 Cart Avg` are **100% free forever**.
   - Pre-selected **$49.99/year** anchor card (`$4.16/month` billed annually, **BEST VALUE — SAVE 58%**, **7-Day Free Trial**) vs. **$9.99/month** decoy card.
   - Creator / Influencer Promo Code box (`CLEANMOM`, `GROCERYHAUL`, `SARAHHAULS`, `PARENTMAXX`) that unlocks an **Extended 14-Day Free Trial**, plus unlimited **Give 7 Days, Get 7 Days** friend referral codes (`BROC-XXXXX`).
   - Accessible from the top simulator bar (`Paywall / Pro`) and triggered after the 5 weekly free 1-for-1 Clean Swaps (+ 3 courtesy mid-order refill swaps).
4. **Influencer Affiliate Tracker & 1,000-Creator Math Engine** (`app/api/influencers/route.ts` + `components/InfluencerEngine.tsx`):
   - Create custom creator codes with configurable commission splits (default **35% = $17.50 payout per $49.99 annual conversion**).
   - Tracks Clicks, Free Trials Started, Paid Annual Conversions, Creator Commission Owed, and Net Revenue live, plus an interactive **1,000-Influencer Outreach ARR Calculator**.

---

## Legal & Non-Affiliation Notice

HeyBroc is an independent consumer software application and is not affiliated with, endorsed by, or sponsored by Walmart, Target, Instacart, Kroger, ALDI, Costco, Sam's Club, BJ's Wholesale Club, Amazon, Whole Foods Market, DoorDash, Uber Eats, Shipt, or any food or beverage manufacturer. All product scores represent subjective clean-label opinions based on public ingredient databases (Open Food Facts, USDA FoodData Central); always verify physical package labels.

---

## Running Locally

```bash
npm install
npm run dev
npm run typecheck
npm run test:rubric
```

