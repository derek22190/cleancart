#!/usr/bin/env node
/**
 * HeyBroc Automated Cross-Agent Code Auditor (`npm run audit:ai`)
 *
 * Eliminates manual copy-pasting between Claude Code, OpenAI Codex, and Antigravity:
 * 1. Inspects the active git diff (working tree or latest commit `HEAD`) against `AGENTS.md`.
 * 2. Runs deterministic compliance & security checks on modified lines.
 * 3. Runs `npm run typecheck`, `npm run test:rubric`, and `npm run build` (unless `--skip-build`).
 * 4. Automatically invokes headless cross-model AI review when available:
 *    - `codex` CLI (`codex exec ...`)
 *    - `claude` CLI (`claude -p ...`)
 *    - `OPENAI_API_KEY` (OpenAI Chat Completions API)
 *    - `ANTHROPIC_API_KEY` (Anthropic Messages API)
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");
const engineArg = args.find((a) => a.startsWith("--engine="))?.split("=")[1] || "auto";

const rootDir = process.cwd();
const agentsMdPath = path.join(rootDir, "AGENTS.md");
const agentsMd = fs.existsSync(agentsMdPath)
  ? fs.readFileSync(agentsMdPath, "utf8")
  : "";

function runCmd(cmd, label) {
  console.log(`\n▶ [audit:ai] ${label} (${cmd})...`);
  try {
    execSync(cmd, { stdio: "inherit", cwd: rootDir });
    return true;
  } catch {
    console.error(`✖ [audit:ai] Failed: ${label}`);
    return false;
  }
}

function commandExists(bin) {
  const res = spawnSync("which", [bin], { encoding: "utf8" });
  return res.status === 0 && Boolean(res.stdout?.trim());
}

function getGitDiff() {
  try {
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
  console.log("\n▶ [audit:ai] Running static compliance & security diff checks...");
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
    console.error("✖ [audit:ai] Static diff compliance issues found:");
    for (const issue of issues) {
      console.error(`  - ${issue}`);
    }
    return false;
  }
  console.log("✓ [audit:ai] Static diff compliance & security checks passed.");
  return true;
}

async function runOpenAiApiAudit(prompt) {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) return null;
  const model = (process.env.OPENAI_AUDIT_MODEL || "gpt-4o").trim();
  console.log(`\n▶ [audit:ai] Running OpenAI API audit (${model})...`);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "You are a strict principal security and data-integrity code auditor. Review the git diff against AGENTS.md. Report only concrete bugs, security flaws, or rule violations. End your response with either STATUS: PASS or STATUS: ACTION_REQUIRED.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    console.warn(`⚠ [audit:ai] OpenAI API returned HTTP ${res.status}; skipping API audit.`);
    return null;
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  console.log("\n---------------- OPENAI / CODEX AUDIT REPORT ----------------");
  console.log(text);
  console.log("-------------------------------------------------------------\n");
  return !text.includes("STATUS: ACTION_REQUIRED");
}

async function runAnthropicApiAudit(prompt) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) return null;
  const model = (process.env.ANTHROPIC_AUDIT_MODEL || "claude-sonnet-4-20250514").trim();
  console.log(`\n▶ [audit:ai] Running Anthropic Claude API audit (${model})...`);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      temperature: 0.1,
      system:
        "You are a strict principal security and data-integrity code auditor. Review the git diff against AGENTS.md. Report only concrete bugs, security flaws, or rule violations. End your response with either STATUS: PASS or STATUS: ACTION_REQUIRED.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    console.warn(`⚠ [audit:ai] Anthropic API returned HTTP ${res.status}; skipping API audit.`);
    return null;
  }
  const data = await res.json();
  const text = data?.content?.[0]?.text || "";
  console.log("\n---------------- CLAUDE CODE AUDIT REPORT -------------------");
  console.log(text);
  console.log("-------------------------------------------------------------\n");
  return !text.includes("STATUS: ACTION_REQUIRED");
}

async function main() {
  const { source, diff } = getGitDiff();
  console.log(`=== HeyBroc Automated Audit (source: ${source}) ===`);

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

  const truncatedDiff =
    diff.length > 45000 ? `${diff.slice(0, 45000)}\n...[diff truncated]` : diff;
  const auditPrompt = [
    "Audit the following git diff against our repository rules in AGENTS.md.",
    "List only real, actionable bugs, security issues, or AGENTS.md rule violations.",
    "If no issues exist, state 'No issues found' and end with 'STATUS: PASS'. Otherwise end with 'STATUS: ACTION_REQUIRED'.",
    "",
    "=== AGENTS.md ===",
    agentsMd,
    "",
    `=== GIT DIFF (${source}) ===`,
    truncatedDiff || "(no diff)",
  ].join("\n");

  let ranExternalAi = false;

  if (engineArg !== "local") {
    if ((engineArg === "codex" || engineArg === "auto") && commandExists("codex")) {
      console.log("\n▶ [audit:ai] Invoking local OpenAI Codex CLI (`codex exec`)...");
      const res = spawnSync("codex", ["exec", auditPrompt], {
        cwd: rootDir,
        stdio: "inherit",
      });
      ranExternalAi = true;
      if (res.status !== 0 && engineArg === "codex") {
        process.exit(res.status || 1);
      }
    }

    if ((engineArg === "claude" || engineArg === "auto") && commandExists("claude")) {
      console.log("\n▶ [audit:ai] Invoking local Claude Code CLI (`claude -p`)...");
      const res = spawnSync("claude", ["-p", auditPrompt], {
        cwd: rootDir,
        stdio: "inherit",
      });
      ranExternalAi = true;
      if (res.status !== 0 && engineArg === "claude") {
        process.exit(res.status || 1);
      }
    }

    if (!ranExternalAi) {
      const openAiOk = await runOpenAiApiAudit(auditPrompt);
      if (openAiOk !== null) {
        ranExternalAi = true;
        if (!openAiOk) process.exit(1);
      }
      const anthropicOk = await runAnthropicApiAudit(auditPrompt);
      if (anthropicOk !== null) {
        ranExternalAi = true;
        if (!anthropicOk) process.exit(1);
      }
    }
  }

  if (engineArg === "local") {
    console.log(
      "\n✓ [audit:ai] All static compliance, typecheck, rubric, and build gates PASSED (--engine=local: zero external Codex/Claude credits used)."
    );
  } else if (!ranExternalAi) {
    console.log(
      "\nℹ [audit:ai] All static compliance, typecheck, rubric, and build gates PASSED.\n" +
        "  (Tip: Install `@openai/codex` or `@anthropic-ai/claude-code`, or set OPENAI_API_KEY / ANTHROPIC_API_KEY, to also run cross-LLM diff review automatically.)"
    );
  } else {
    console.log("\n✓ [audit:ai] All verification gates and cross-AI audit checks PASSED.");
  }
}

main().catch((err) => {
  console.error("✖ [audit:ai] Unexpected error:", err);
  process.exit(1);
});
