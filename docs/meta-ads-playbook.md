# HeyBroc Food Tracker — Meta Ads & Funnel Playbook (Ryan Mathews / MtnWispr Method)

This document is the permanent repository reference for **Ryan Mathews' Meta Ads + Analytics Playbook** (~$55K MRR / ~$650K ARR in ~110 days, scaling profitably past $2,200/day at ~2x ROAS) adapted directly for **HeyBroc (CleanCart)** food & grocery tracker ads.

---

## 1. The Creative Foundation (Applied to HeyBroc Food Tracker)

- **Long-Form "Academy" Video as Ad + Organic YouTube Engine**:
  - Record a **15–45 minute deep educational video** teaching shoppers how to decode grocery labels across Walmart, Target, Costco, Kroger, and Aldi (exposing industrial seed oils behind "vegetable oil" blends, synthetic petroleum dyes, "natural flavors," gums/emulsifiers, and fake "organic/healthy" front-of-box claims).
  - Post the full video organically to **YouTube** (free top-of-funnel + warm retargeting pool) and run the full video + 2–5 minute cut-downs as **Meta Ads**.
- **Polarizing Comment Split Signal (50/50 Rule)**:
  - The highest-performing ad creatives generate a ~50/50 comment split:
    - **50% Skeptical**: *"There's no way my kid's favorite 'organic' snack scores a 16/100"* or *"Everything has bad ingredients now, impossible to avoid."*
    - **50% Evangelist**: *"This app literally changed how our family grocery shops — swapped 6 pantry staples in 2 minutes."*
  - That split confirms the creative is hitting skeptical, high-intent grocery shoppers.

---

## 2. Meta Ads Mechanics & 75% Video Watcher Optimization

When standard cold conversion campaigns are still learning, shift top-of-funnel optimization to **deep video retention**:

- **Explicitly Optimize for 75% Video Watchers**:
  - Use a **Video Views / Engagement (ThruPlay / Video Retention)** objective and track **`video_p75_watched_actions`** (Video plays at 75%).
  - **Target Cost**: **~$1.50 per 75% deep viewer**.
  - **Target Early Return**: **~2.0x ROAS** ($2 back for every $1 spent while learning).
  - Anyone who watches 75% of an in-depth food ingredient & grocery swap breakdown is a prime high-intent prospect for Custom Audiences and 1%–3% Lookalikes.
- **The Accidental Discovery — Cold Direct Often Beats Complex Warm-Up Funnels**:
  - Ryan's best-performing "retargeting" campaign was actually an unsaved targeting setup sending **Broad / Advantage+ cold traffic straight to the landing page**.
  - **Rule for HeyBroc**: Never assume multi-step video warm-up beats direct cold traffic. Always pit **Cold Broad / Advantage+ → Free Food Score Test** directly against the warm-up/retargeting path and allocate budget to whichever wins on ROAS.

---

## 3. Purchase Intent Signals & Duolingo-Style Conversion Funnel

Every channel (YouTube, Meta Long-Form Teach, Meta Direct Cold) drives to a single frictionless conversion engine:

1. **Duolingo-Style Free Scored Test (`product_scanned` / `CompleteRegistration`)**:
   - CTA: **"Test / Scan Your First Grocery Item Free → Instant 0–100 Ingredient Score."**
   - Shopper tests a product or cart on `heybroc.com` (or inside the app/extension) and immediately receives a deterministic 0–100 score + flagged additives/seed oils.
2. **Instant Clean Swap + Upgrade Offer (`paywall_viewed` → `checkout_started` → `pro_subscribed`)**:
   - Right after delivering the free score, present the cleaner 1-tap aisle swap and the simple Family Pro offer (**$9.99/mo or $49.99/yr**).
   - **Target Conversion Benchmark**: **~40% conversion** from engaged free-test completers to trial/paid.
3. **Server-Side Meta CAPI Signals (`lib/analytics.ts`)**:
   - `product_scanned` → `CompleteRegistration` (*Free Product Score Test completed*)
   - `paywall_viewed` → `ViewContent`
   - `checkout_started` → `InitiateCheckout`
   - `pro_subscribed` → `StartTrial` / `Subscribe`

---

## 4. 3-Campaign Architecture to Run in Meta Ads Manager

| Campaign | Role | Objective & Targeting | Creative | Primary KPI & Target |
| :--- | :--- | :--- | :--- | :--- |
| **1. Teach / Retention** | Top-of-Funnel + Audience Builder | Video Views / ThruPlay (optimize for 75% completion); Broad | 15–45 min Grocery Aisle & Label Decoding Masterclass (+ 3-min cut-downs) | **Cost per 75% Viewer ≤ $1.50**; build 75% Watcher Custom Audience |
| **2. Direct / Sales (Cold)** | Primary Conversion Engine | Sales / Conversions; **Broad / Advantage+** | Polarizing Pantry Audit & Instant Score Demo → *"Scan Your First Food Item Free"* | **ROAS ≥ 2.0x**; **Free-Test → Paid ~40%** |
| **3. Retargeting Layer** | Warm Capture (Optional) | Sales / Conversions; 75% Video Watchers + Free Test Completers + 7/30/90d Visitors | 1-Tap Clean Swap proof + Family Pro Annual offer ($49.99/yr) | Must beat Campaign 2 Cold ROAS to keep budget |

---

## 5. Retrieving & Auditing Meta Ads via CLI (`npm run ops`)

Use `npm run ops` (`scripts/ops-cli.ts`) to retrieve live Meta Ads campaigns with full video retention columns (`3s`, `ThruPlay`, `p25`, `p50`, `p75`, `p95`, `p100`, `Cost per 75% Viewer`, and `ROAS`):

```bash
# Retrieve live Meta Ads campaigns + 75% retention diagnostics + Food Tracker Playbook
npm run ops meta-campaigns

# Full funnel, A/B paywall, Creator ledger, Stripe MRR, and Meta Ads status
npm run ops status

# Pause, enable, or scale daily ad-set budget (in cents, e.g., 50000 = $500/day)
npm run ops meta-pause -- --id=<CAMPAIGN_OR_ADSET_ID>
npm run ops meta-enable -- --id=<CAMPAIGN_OR_ADSET_ID>
npm run ops meta-budget -- --id=<ADSET_ID> --daily-cents=50000
```
