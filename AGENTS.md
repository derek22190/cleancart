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

### Automated Cross-Audit & Verification Gate (`npm run audit:ai`)
- Before committing and pushing to `main`, agents **MUST** run `npm run audit:ai` (or `npm run typecheck && npm run test:rubric && npm run build`).
- `npm run audit:ai` (`scripts/ai-audit.mjs`) automatically audits the active `git diff` / `HEAD` commit against all rules in `AGENTS.md`, runs the deterministic compliance & security checks, executes the full verification suite, and (when `codex` CLI, `claude` CLI, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` is available) runs a headless cross-model AI code audit without manual copy-pasting.
- If `npm run audit:ai` surfaces any actionable bug, regression, or rule violation, fix it and re-run `npm run audit:ai` until zero issues remain before pushing to `origin/main`.
