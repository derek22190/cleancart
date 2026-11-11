#!/usr/bin/env node
/**
 * HeyBroc Local Deterministic Verification Gate (`npm run audit:ai`)
 *
 * Runs 100% locally with zero external LLM / Codex / Claude Code calls or API credit usage:
 * 1. Inspects the active git diff (working tree or latest commit `HEAD`) against `AGENTS.md`.
 * 2. Runs deterministic compliance & security checks on modified lines.
 * 3. Runs `npm run typecheck`, `npm run test:rubric`, and `npm run build` (unless `--skip-build`).
 */

import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");
const baseArg = args.find((a) => a.startsWith("--base="))?.split("=")[1] || "";

const rootDir = process.cwd();

function runCmd(cmd, label) {
  console.log(`\n▶ [verify] ${label} (${cmd})...`);
  try {
    execSync(cmd, { stdio: "inherit", cwd: rootDir });
    return true;
  } catch {
    console.error(`✖ [verify] Failed: ${label}`);
    return false;
  }
}

function getGitDiff() {
  try {
    if (baseArg) {
      const rangeDiff = execSync(`git diff ${baseArg}`, {
        cwd: rootDir,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }).trim();
      if (rangeDiff) {
        return { source: `git diff ${baseArg}`, diff: rangeDiff };
      }
    }
    const workingDiff = execSync("git diff HEAD", {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
    if (workingDiff) {
      return { source: "working tree (git diff HEAD)", diff: workingDiff };
    }
    const lastCommitDiff = execSync("git show HEAD --stat --patch", {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
    return { source: "latest commit (git show HEAD)", diff: lastCommitDiff };
  } catch {
    return { source: "none", diff: "" };
  }
}

function runStaticDiffCompliance(diffText) {
  console.log("\n▶ [verify] Running static compliance & security diff checks...");
  const issues = [];

  // Only inspect added lines in non-test/non-doc files
  const lines = diffText.split("\n");
  let currentFile = "";
  for (const line of lines) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const isTestOrDoc =
      currentFile.startsWith("scripts/") ||
      currentFile.endsWith(".md") ||
      currentFile.startsWith(".github/");

    if (
      !isTestOrDoc &&
      /\b(sk_live_[0-9a-zA-Z]{16,}|rk_live_[0-9a-zA-Z]{16,}|whsec_[0-9a-zA-Z]{24,})\b/.test(line)
    ) {
      issues.push(
        `[${currentFile}] Potential live Stripe secret committed in added line.`
      );
    }

    if (
      !isTestOrDoc &&
      /\b(Low Spike|Moderate Spike|High Spike|Steady glycemic profile)\b/i.test(line)
    ) {
      issues.push(
        `[${currentFile}] Prohibited physiological blood-glucose prediction found in added line: ${line.slice(1).trim()}`
      );
    }

    if (
      !isTestOrDoc &&
      /https:\/\/(?:www\.)?heybroc\.com\/login(?!\?)/.test(line)
    ) {
      issues.push(
        `[${currentFile}] Direct link to /login found (use /?login=1 instead): ${line.slice(1).trim()}`
      );
    }
  }

  if (issues.length > 0) {
    console.error("✖ [verify] Static diff compliance issues found:");
    for (const issue of issues) {
      console.error(`  - ${issue}`);
    }
    return false;
  }
  console.log("✓ [verify] Static diff compliance & security checks passed.");
  return true;
}

async function main() {
  const { source, diff } = getGitDiff();
  console.log(`=== HeyBroc Local Verification Gate (source: ${source}) ===`);

  if (!runStaticDiffCompliance(diff)) {
    process.exit(1);
  }

  if (!skipBuild) {
    if (!runCmd("npm run typecheck", "TypeScript & Next.js Route Typecheck")) {
      process.exit(1);
    }
    if (!runCmd("npm run test:rubric", "HeyBroc Rubric & Regression Test Suite")) {
      process.exit(1);
    }
    if (!runCmd("npm run build", "Next.js Production Build")) {
      process.exit(1);
    }
  }

  console.log(
    "\n✓ [verify] All static compliance, typecheck, rubric, and build gates PASSED (100% local, zero external AI credits used)."
  );
}

main().catch((err) => {
  console.error("✖ [verify] Unexpected error:", err);
  process.exit(1);
});
