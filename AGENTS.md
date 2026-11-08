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
