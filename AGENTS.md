<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Repository Workflow Rules

### Mandatory Push to Main
- In this repository, development is strictly trunk-based on `main`.
- Once all automated verification gates pass (`npm run typecheck`, `npm run build`, and `npm run test:rubric`), agents **MUST ALWAYS commit and push changes directly to `main`**.
- Never ask the user if they want to push or leave verified work unpushed. Always commit and push to `origin/main` automatically upon completing changes.

### Data-Integrity & Legal Compliance Rules
- **No Multi-Brand or Shared Catalog Entries**: Never use `"/"` to combine multiple brands or product lines in `lib/drinks-catalog.ts` or `lib/lookup.ts`. Each catalog entry must represent a single brand and specific product formulation.
- **Required Provenance & 90-Day Freshness**: Every catalog entry in `lib/drinks-catalog.ts` and `lib/lookup.ts` must include `{ sourceUrl, verifiedAt }` with an ISO date verified against the manufacturer's current US label within the last 90 days.
- **Variant Guard**: Never attach a base product's ingredient list when the shopper's query specifies a distinct variant token (`unflavored`, `extra creamy`, `simply nkd`, `zero sugar`, `pro elite`, `doubleshot`, `mountain water`, `soymilk`, `organic`, etc.) that is absent from the matched entry's title.
- **No Unverified Organic Bonus**: Never infer whole-product USDA Organic certification from `"organic"` appearing in `rawIngredients`; `organicScore` requires explicit product-level `nutrition.isOrganic === true`.
- **No Hardcoded Retail Prices or Medical Predictions**: Never hardcode retail dollar prices on product or swap cards, and never emit blood-glucose or physiological predictions (`"Low Spike"`, `"Moderate Spike"`, `"High Spike"`, `"Steady glycemic profile"`).

### Local Deterministic Verification Gate (`npm run audit:ai`) — No Automatic External AI Audits
- Before committing and pushing to `main`, agents **MUST** run `npm run audit:ai` (which runs local static diff compliance checks, `npm run typecheck`, `npm run test:rubric`, and `npm run build`).
- **NEVER** automatically invoke Codex (`codex exec`), Claude Code (`claude -p`), OpenAI/Anthropic audit APIs, or extra multi-agent AI audit passes on every change unless the user explicitly asks for an audit—keep verification 100% local and deterministic so zero extra AI credits are burned.
- If `npm run audit:ai` surfaces a TypeScript, rubric, build, or static compliance error, fix it and re-run `npm run audit:ai` before pushing to `origin/main`.

### Growth, Revenue, Paywall & Meta Ads Command Center (`npm run ops`)
- Use `npm run ops` (`scripts/ops-cli.ts`) to inspect and control live funnel metrics, PostHog status, Paywall A/B tests, Creator Affiliate codes, Stripe subscriptions/MRR, and Meta Ads campaigns:
  - `npm run ops status` — Full funnel, A/B test, creator ledger, Stripe, PostHog, and Meta Ads report.
  - `npm run ops store-check` — Store-packaging pre-flight checklist for production API keys and webhook secrets.
  - `npm run ops paywall -- --headline="..." --variant-b="..." --cta="..." --swaps=3` — Live-tune the paywall without an app update.
  - `npm run ops creator -- --code=CODE --name="Name" --pct=35` — Create or update creator affiliate codes.
  - `npm run ops meta-campaigns` — Retrieve live Meta Ads campaigns with 75% video retention (`p75`), Cost per 75% Viewer, ROAS, and the HeyBroc Food Tracker Playbook.
  - `npm run ops meta-pause -- --id=<ID>` / `npm run ops meta-enable -- --id=<ID>` / `npm run ops meta-budget -- --id=<ID> --daily-cents=5000` — Manage Meta Ads campaigns and budgets.

### Meta Ads & Funnel Playbook for HeyBroc Food Tracker (Ryan Mathews / MtnWispr Method)
- Full playbook reference: [`docs/meta-ads-playbook.md`](./docs/meta-ads-playbook.md) (and custom skill `meta-ads-playbook`).
- **Campaign Architecture**:
  1. **Campaign 1 — Teach / 75% Video Retention (Top-of-Funnel)**: Long-form educational video (15–45 min deep-dive decoding grocery labels, hidden seed oils, synthetic dyes, and deceptive health claims; also posted organically to YouTube). Optimize for Video Views / ThruPlay / **75% video completion (`video_p75_watched_actions`)** targeting **~$1.50 per 75% viewer** to build high-intent custom audiences and lookalikes.
  2. **Campaign 2 — Direct / Sales (Cold Broad / Advantage+)**: Send cold traffic straight to the landing page's **Duolingo-style Free Scored Test** (*"Scan/test your first food item free → instant 0–100 score → 1-tap Clean Swap & Family Pro upgrade"*). Always pit Cold Direct against Warm Retargeting on pure ROAS.
  3. **Campaign 3 — Retargeting Layer**: 75%+ video viewers + Free Food Score Test completers (`product_scanned` / `CompleteRegistration`) + 7/30/90-day site visitors.
- **Core Benchmarks & Creative Signals**:
  - **~$1.50** cost per 75% video viewer (`spend / p75`).
  - **~2.0x+ ROAS** early return while scaling ($500/day → $2,200+/day).
  - **~40% Free-Test → Paid conversion rate** from engaged free-test completers on simple pricing ($9.99/mo or $49.99/yr).
  - **50/50 Polarizing Comment Split**: Best creatives drive ~50% skeptical comments (*"No way this kids' snack scores 14/100"*) and ~50% life-changed comments (*"Changed how our family shops"*).

### Mandatory Store-Packaging Pre-Flight Reminder (All Future Chats)
- **CRITICAL USER REMINDER**: Whenever the user asks to package, bundle, sign, or prepare a release for any store (**Google Play Store** APK/AAB, **Apple App Store / iOS Safari Extension**, **Chrome Web Store**, or production launch), the agent **MUST ALWAYS** run `npm run ops store-check` and proactively remind the user to verify/connect any unconfigured production keys in Vercel before going live:
  1. **Stripe**: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (pointing to `https://www.heybroc.com/api/stripe/webhook`)
  2. **RevenueCat (Google Play / App Store IAP)**: `REVENUECAT_WEBHOOK_SECRET` (pointing to `https://www.heybroc.com/api/revenuecat/webhook`)
  3. **PostHog Analytics**: `POSTHOG_API_KEY` (and optional `POSTHOG_PERSONAL_API_KEY`)
  4. **Meta Conversions API (Pixel) & Meta Ads**: `META_PIXEL_ID`, `META_CAPI_TOKEN`, `META_ADS_ACCESS_TOKEN`, and `META_AD_ACCOUNT_ID`


