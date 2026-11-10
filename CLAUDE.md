@AGENTS.md

# Claude Code & Cross-Agent Instructions (`CLAUDE.md`)

This repository uses [`AGENTS.md`](./AGENTS.md) as the single source of truth for all coding agents (**Claude Code**, **OpenAI Codex CLI**, and **Antigravity**).

## Mandatory Workflow for Every Task

1. **Read & Follow `AGENTS.md`**:
   - Never use `"/"` to combine multiple brands or product lines in `lib/drinks-catalog.ts`, `lib/lookup.ts`, or `lib/swaps.ts`.
   - Every catalog and swap entry must include `{ sourceUrl, verifiedAt }` with an ISO date within the last 90 days.
   - Preserve the variant guard (`passesVariantGuard`) and never infer USDA Organic bonus without explicit `isOrganic === true`.
   - Never hardcode retail dollar prices or emit physiological blood-glucose predictions.

2. **Zero Copy-Paste Cross-Audit (`npm run audit:ai`)**:
   - After implementing changes, run:
     ```bash
     npm run audit:ai
     ```
   - This single command runs static compliance/security checks on your `git diff`, runs `npm run typecheck`, `npm run test:rubric`, and `npm run build`, and automatically invokes headless **Codex CLI** (`codex exec`) or **Claude Code** (`claude -p`) / API review if installed in the environment.
   - To explicitly cross-audit your work with Codex CLI from inside Claude Code:
     ```bash
     npm run audit:codex
     ```
   - To explicitly cross-audit your work with Claude Code from inside Codex:
     ```bash
     npm run audit:claude
     ```

3. **Mandatory Push to `main`**:
   - Once all checks pass with zero findings, commit and push directly to `origin/main`.
