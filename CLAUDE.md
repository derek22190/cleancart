@AGENTS.md

# Agent Instructions (`CLAUDE.md`)

This repository uses [`AGENTS.md`](./AGENTS.md) as the single source of truth for all coding agents.

## Mandatory Workflow for Every Task

1. **Read & Follow `AGENTS.md`**:
   - Never use `"/"` to combine multiple brands or product lines in `lib/drinks-catalog.ts`, `lib/lookup.ts`, or `lib/swaps.ts`.
   - Every catalog and swap entry must include `{ sourceUrl, verifiedAt }` with an ISO date within the last 90 days.
   - Preserve the variant guard (`passesVariantGuard`) and never infer USDA Organic bonus without explicit `isOrganic === true`.
   - Never hardcode retail dollar prices or emit physiological blood-glucose predictions.

2. **Local Deterministic Verification Only (No External Codex / Claude Audits)**:
   - After implementing changes, run the local verification gate:
     ```bash
     npm run audit:ai
     ```
     (which runs deterministic static diff compliance checks, `npm run typecheck`, `npm run test:rubric`, and `npm run build` locally).
   - **Never** automatically spawn external `codex` or `claude` CLI sub-processes or call OpenAI/Anthropic APIs to cross-audit diffs, as doing so burns extra credits.

3. **Mandatory Push to `main`**:
   - Once all deterministic checks pass, commit and push directly to `origin/main`.
