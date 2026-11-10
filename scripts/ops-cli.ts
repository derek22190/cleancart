#!/usr/bin/env node
/**
 * HeyBroc — Unified Growth, Revenue, Paywall & Meta Ads Control CLI (`npm run ops`)
 * ---------------------------------------------------------------------------------
 * Built specifically so Antigravity can inspect live data and execute changes across:
 *   1. First-Party Funnel & PostHog Analytics (`getAnalyticsSnapshot`, PostHog Query API)
 *   2. Live Paywall ("Superwall") A/B Experiments (`getPaywallConfig`, `savePaywallConfig`)
 *   3. Creator Affiliate Engine (`listCreators`, `createCreator`)
 *   4. Stripe Subscriptions, Trials & Live MRR (`STRIPE_SECRET_KEY`)
 *   5. Meta Ads (Facebook / Instagram Marketing API: inspect campaigns, pause/enable, update budgets)
 *
 * Commands:
 *   npm run ops status
 *   npm run ops paywall -- --headline="New Headline" --variant-b="Variant B" --cta="Start Trial" --swaps=3
 *   npm run ops creator -- --code=SARAHHAULS --name="Sarah Grocery Hauls" --pct=35
 *   npm run ops meta-pause -- --id=<CAMPAIGN_OR_ADSET_ID>
 *   npm run ops meta-enable -- --id=<CAMPAIGN_OR_ADSET_ID>
 *   npm run ops meta-budget -- --id=<ADSET_ID> --daily-cents=5000
 */

import {
  getAnalyticsSnapshot,
  getPaywallConfig,
  savePaywallConfig,
} from "../lib/analytics";
import { createCreator, listCreators } from "../lib/influencers";

const args = process.argv.slice(2);
const subcommand = args.find((a) => !a.startsWith("--")) || "status";

function getFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

const pct = (num: number, den: number) =>
  den > 0 ? `${((num / den) * 100).toFixed(1)}%` : "0.0%";

async function fetchStripeSummary() {
  const key = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!key) return null;
  try {
    const res = await fetch("https://api.stripe.com/v1/subscriptions?limit=100&status=all", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = (await res.json()) as {
      data?: Array<{
        id: string;
        status: string;
        plan?: { amount?: number; interval?: string };
        items?: {
          data?: Array<{
            price?: { unit_amount?: number; recurring?: { interval?: string } };
          }>;
        };
      }>;
    };
    const subs = data.data || [];
    let activeCount = 0;
    let trialingCount = 0;
    let canceledCount = 0;
    let mrrUsd = 0;
    for (const s of subs) {
      if (s.status === "active") {
        activeCount++;
        const firstPrice = s.items?.data?.[0]?.price;
        const unitAmount = s.plan?.amount ?? firstPrice?.unit_amount ?? 0;
        const interval = s.plan?.interval ?? firstPrice?.recurring?.interval ?? "month";
        const amt = unitAmount / 100;
        mrrUsd += interval === "year" ? amt / 12 : amt;
      } else if (s.status === "trialing") {
        trialingCount++;
      } else if (s.status === "canceled") {
        canceledCount++;
      }
    }
    return {
      activeCount,
      trialingCount,
      canceledCount,
      estimatedMrrUsd: Number(mrrUsd.toFixed(2)),
    };
  } catch (err) {
    return { error: String(err) };
  }
}

async function fetchMetaCampaigns() {
  const token = (process.env.META_ADS_ACCESS_TOKEN || "").trim();
  const rawAccountId = (process.env.META_AD_ACCOUNT_ID || "").trim();
  if (!token || !rawAccountId) return null;
  const accountId = rawAccountId.startsWith("act_") ? rawAccountId : `act_${rawAccountId}`;

  const sumActionList = (list: unknown): number => {
    if (!Array.isArray(list)) return 0;
    return list.reduce((acc: number, item: unknown) => {
      const val = Number((item as { value?: string | number })?.value || 0);
      return acc + (Number.isFinite(val) ? val : 0);
    }, 0);
  };

  try {
    const insightFields = [
      "spend",
      "impressions",
      "clicks",
      "cpc",
      "ctr",
      "actions",
      "purchase_roas",
      "cost_per_thruplay",
      "video_play_actions",
      "video_thruplay_watched_actions",
      "video_p25_watched_actions",
      "video_p50_watched_actions",
      "video_p75_watched_actions",
      "video_p95_watched_actions",
      "video_p100_watched_actions",
    ].join(",");
    const url =
      `https://graph.facebook.com/v21.0/${encodeURIComponent(accountId)}/campaigns` +
      `?fields=id,name,objective,status,effective_status,daily_budget,insights.date_preset(last_7d){${insightFields}}` +
      `&limit=25&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { error: `HTTP ${res.status}: ${txt.slice(0, 160)}` };
    }
    const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const rawCampaigns = data.data || [];
    const parsedCampaigns = rawCampaigns.map((c) => {
      const insightsNode = (c.insights as { data?: Array<Record<string, unknown>> } | undefined)?.data?.[0] || {};
      const spendUsd = Number(insightsNode.spend || 0);
      const plays3s = sumActionList(insightsNode.video_play_actions);
      const thruPlays = sumActionList(insightsNode.video_thruplay_watched_actions);
      const p25 = sumActionList(insightsNode.video_p25_watched_actions);
      const p50 = sumActionList(insightsNode.video_p50_watched_actions);
      const p75 = sumActionList(insightsNode.video_p75_watched_actions);
      const p95 = sumActionList(insightsNode.video_p95_watched_actions);
      const p100 = sumActionList(insightsNode.video_p100_watched_actions);
      const roasList = insightsNode.purchase_roas as Array<{ value?: string | number }> | undefined;
      const roas = roasList?.[0]?.value ? Number(roasList[0].value) : null;
      const costPerP75ViewerUsd = p75 > 0 ? Number((spendUsd / p75).toFixed(2)) : null;
      const p75RetentionPct = plays3s > 0 ? Number(((p75 / plays3s) * 100).toFixed(1)) : null;

      return {
        id: c.id,
        name: c.name,
        objective: c.objective,
        status: c.status,
        effective_status: c.effective_status,
        daily_budget: c.daily_budget,
        spendUsd: Number(spendUsd.toFixed(2)),
        impressions: Number(insightsNode.impressions || 0),
        clicks: Number(insightsNode.clicks || 0),
        ctr: insightsNode.ctr ? `${Number(insightsNode.ctr).toFixed(2)}%` : "0.00%",
        videoRetention: {
          plays3s,
          thruPlays,
          p25,
          p50,
          p75,
          p95,
          p100,
          p75RetentionPct,
          costPerP75ViewerUsd,
          targetCostPerP75Usd: 1.5,
        },
        roas,
        targetRoas: 2.0,
      };
    });
    return { accountId, campaigns: parsedCampaigns };
  } catch (err) {
    return { error: String(err) };
  }
}

function printMetaPlaybookReport(
  meta: Awaited<ReturnType<typeof fetchMetaCampaigns>>,
  snap: Awaited<ReturnType<typeof getAnalyticsSnapshot>>
) {
  console.log("==============================================================");
  console.log("🎯 HEYBROC FOOD TRACKER — META ADS & 75% RETENTION PLAYBOOK");
  console.log("   (Ryan Mathews / MtnWispr Method: $1.50/p75 · 2x ROAS · 40% Test->Paid)");
  console.log("==============================================================\n");

  console.log("1. LIVE DUOLINGO-STYLE 'FREE FOOD SCORE TEST -> PAID' FUNNEL:");
  console.log(`   - Free Food Score Tests Completed (product_scanned): ${snap.totals.product_scanned}`);
  console.log(`   - Clean Swaps Clicked:                               ${snap.totals.clean_swap_clicked} (${pct(snap.totals.clean_swap_clicked, snap.totals.product_scanned)} of free testers)`);
  console.log(`   - Paywalls Viewed:                                   ${snap.totals.paywall_viewed}`);
  console.log(`   - Pro Subscriptions (StartTrial / Subscribe):        ${snap.totals.pro_subscribed}`);
  console.log(
    `   - Free-Test -> Paid Conversion Rate:                 ${pct(snap.totals.pro_subscribed, snap.totals.product_scanned)} (Playbook Target: ~40% of engaged test completers)\n`
  );

  console.log("2. LIVE META ADS CAMPAIGN RETRIEVAL (75% VIDEO WATCHERS & ROAS):");
  if (!meta) {
    console.log("   ⚠ META_ADS_ACCESS_TOKEN or META_AD_ACCOUNT_ID not set in current environment.");
    console.log("   ↳ Add META_ADS_ACCESS_TOKEN and META_AD_ACCOUNT_ID to retrieve live campaigns from Graph API v21.0.\n");
  } else if ("error" in meta) {
    console.log(`   ✖ Meta Graph API Error: ${meta.error}\n`);
  } else if (meta.campaigns.length === 0) {
    console.log(`   ○ Connected to ${meta.accountId} — 0 campaigns found. Ready to launch the 3-Campaign Food Tracker Architecture below.\n`);
  } else {
    console.log(`   ✓ Connected to Ad Account ${meta.accountId} (${meta.campaigns.length} campaigns):\n`);
    for (const c of meta.campaigns) {
      const vr = c.videoRetention;
      const p75Badge =
        vr.costPerP75ViewerUsd !== null
          ? vr.costPerP75ViewerUsd <= 1.5
            ? `✓ $${vr.costPerP75ViewerUsd} (beats $1.50 target)`
            : `$${vr.costPerP75ViewerUsd} (target ≤ $1.50)`
          : "n/a";
      const roasBadge =
        c.roas !== null ? `${c.roas.toFixed(2)}x (target ≥ 2.0x)` : "n/a";
      console.log(
        `   • [${c.effective_status || c.status}] ${c.name} (ID: ${c.id} | Obj: ${c.objective || "N/A"})`
      );
      console.log(
        `     Spend (7d): $${c.spendUsd.toFixed(2)} | Impr: ${c.impressions} | Clicks: ${c.clicks} (CTR ${c.ctr}) | ROAS: ${roasBadge}`
      );
      console.log(
        `     Video Retention: 3s=${vr.plays3s} -> p25=${vr.p25} -> p50=${vr.p50} -> p75=${vr.p75} (${vr.p75RetentionPct ?? 0}%) -> p95=${vr.p95} -> p100=${vr.p100} | ThruPlay=${vr.thruPlays}`
      );
      console.log(`     Cost per 75% Deep Viewer: ${p75Badge}\n`);
    }
  }

  console.log("3. HEYBROC FOOD TRACKER 3-CAMPAIGN BLUEPRINT (READY TO RUN):");
  console.log("   [Campaign 1] TEACH / 75% VIDEO RETENTION (Top-of-Funnel + Custom Audience Builder)");
  console.log("     • Objective:   Video Views / Engagement (optimize for ThruPlay & 75% Video Plays)");
  console.log("     • Creative:    15–45 min 'Grocery Aisle & Label Decoding Masterclass' (seed oils, synthetic dyes, fake health halos)");
  console.log("                    + post organically to YouTube for free top-of-funnel + run 2–5 min polarizing cut-downs");
  console.log("     • Target KPI:  ~$1.50 Cost per 75% Video Viewer (p75) -> build 75% Watcher Custom Audience & 1%-3% Lookalikes\n");

  console.log("   [Campaign 2] DIRECT / SALES — COLD ADVANTAGE+ (The 'Accidental Winner')");
  console.log("     • Objective:   Sales / Conversions (StartTrial / Subscribe / CompleteRegistration)");
  console.log("     • Targeting:   Broad / Advantage+ Cold Traffic straight to https://www.heybroc.com");
  console.log("     • Funnel CTA:  Duolingo-style 'Test / Scan Your First Food Item Free -> Instant 0-100 Score -> Clean Swap Offer'");
  console.log("     • Creative:    Polarizing 50/50 comment-split hooks ('No way this kids snack scores 14/100' vs 'Changed how we shop')");
  console.log("     • Target KPI:  ~2.0x+ ROAS early on | ~40% Free-Test -> Paid conversion ($9.99/mo or $49.99/yr)\n");

  console.log("   [Campaign 3] RETARGETING LAYER (Benchmark Strictly Against Cold Direct)");
  console.log("     • Audience:    75%+ Video Watchers + Free Food Score Test Completers (CompleteRegistration) + 7/30/90d Visitors");
  console.log("     • Rule:        Keep only if ROAS beats Campaign 2 (Cold Direct); never over-engineer if Cold Advantage+ wins.");
}

async function updateMetaObject(id: string, fields: Record<string, string>) {
  const token = (process.env.META_ADS_ACCESS_TOKEN || "").trim();
  if (!token) {
    console.error("✖ Missing META_ADS_ACCESS_TOKEN in environment.");
    process.exit(1);
  }
  const body = new URLSearchParams({ ...fields, access_token: token });
  const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(id)}`, {
    method: "POST",
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`✖ Meta Graph API error (${res.status}):`, JSON.stringify(json));
    process.exit(1);
  }
  console.log(`✓ Updated Meta object ${id}:`, JSON.stringify(json));
}

async function main() {
  if (subcommand === "paywall") {
    const patch: Record<string, unknown> = {};
    const headline = getFlag("headline");
    const subheadline = getFlag("subheadline");
    const ctaLabel = getFlag("cta");
    const variantBHeadline = getFlag("variant-b");
    const swaps = getFlag("swaps");
    const plan = getFlag("plan");
    const ab = getFlag("ab");

    if (headline) patch.headline = headline;
    if (subheadline) patch.subheadline = subheadline;
    if (ctaLabel) patch.ctaLabel = ctaLabel;
    if (variantBHeadline) patch.variantBHeadline = variantBHeadline;
    if (swaps !== undefined) patch.freeWeeklySwapsLimit = Number(swaps);
    if (plan === "annual" || plan === "monthly") patch.defaultPlan = plan;
    if (ab === "true" || ab === "false") patch.abTestEnabled = ab === "true";

    const updated = await savePaywallConfig(patch);
    console.log("✓ Updated Live Paywall Config:");
    console.log(JSON.stringify(updated, null, 2));
    return;
  }

  if (subcommand === "creator") {
    const code = getFlag("code");
    if (!code) {
      console.error("✖ Usage: npm run ops creator -- --code=SARAHHAULS --name=\"Sarah\" --pct=35");
      process.exit(1);
    }
    const name = getFlag("name");
    const pctVal = getFlag("pct");
    const creator = await createCreator({
      code,
      name,
      commissionPct: pctVal !== undefined ? Number(pctVal) : undefined,
    });
    console.log("✓ Saved Creator Affiliate Code:");
    console.log(JSON.stringify(creator, null, 2));
    return;
  }

  if (subcommand === "meta-pause" || subcommand === "meta-enable") {
    const id = getFlag("id");
    if (!id) {
      console.error(`✖ Usage: npm run ops ${subcommand} -- --id=<CAMPAIGN_OR_ADSET_ID>`);
      process.exit(1);
    }
    await updateMetaObject(id, {
      status: subcommand === "meta-pause" ? "PAUSED" : "ACTIVE",
    });
    return;
  }

  if (subcommand === "meta-budget") {
    const id = getFlag("id");
    const dailyCents = getFlag("daily-cents");
    const parsedCents = Number(dailyCents);
    if (!id || !dailyCents || !Number.isFinite(parsedCents) || parsedCents <= 0) {
      console.error("✖ Usage: npm run ops meta-budget -- --id=<ADSET_ID> --daily-cents=5000");
      process.exit(1);
    }
    await updateMetaObject(id, { daily_budget: String(Math.round(parsedCents)) });
    return;
  }

  if (subcommand === "meta-campaigns" || subcommand === "meta-playbook") {
    const [snap, meta] = await Promise.all([getAnalyticsSnapshot(), fetchMetaCampaigns()]);
    printMetaPlaybookReport(meta, snap);
    return;
  }

  if (subcommand === "store-check") {
    const crypto = await import("node:crypto");
    const suggestedRcSecret = `rc_whsec_${crypto.randomBytes(20).toString("hex")}`;
    const checks = [
      {
        name: "STRIPE_SECRET_KEY",
        ok: Boolean(process.env.STRIPE_SECRET_KEY?.trim()),
        where: "https://dashboard.stripe.com/apikeys",
      },
      {
        name: "STRIPE_WEBHOOK_SECRET",
        ok: Boolean(process.env.STRIPE_WEBHOOK_SECRET?.trim()),
        where: "https://dashboard.stripe.com/webhooks -> endpoint: https://www.heybroc.com/api/stripe/webhook",
      },
      {
        name: "REVENUECAT_WEBHOOK_SECRET",
        ok: Boolean(process.env.REVENUECAT_WEBHOOK_SECRET?.trim()),
        where: `https://app.revenuecat.com -> Integrations -> Webhooks -> https://www.heybroc.com/api/revenuecat/webhook (Use Bearer secret: ${suggestedRcSecret})`,
      },
      {
        name: "POSTHOG_API_KEY",
        ok: Boolean(process.env.POSTHOG_API_KEY?.trim()),
        where: "https://us.posthog.com/settings/project#variables (Project API Key starting with phc_)",
      },
      {
        name: "META_PIXEL_ID & META_CAPI_TOKEN",
        ok: Boolean(process.env.META_PIXEL_ID?.trim() && process.env.META_CAPI_TOKEN?.trim()),
        where: "https://business.facebook.com/events_manager2 -> Data Sources -> Settings -> Conversions API -> Generate access token",
      },
      {
        name: "META_ADS_ACCESS_TOKEN & META_AD_ACCOUNT_ID",
        ok: Boolean(process.env.META_ADS_ACCESS_TOKEN?.trim() && process.env.META_AD_ACCOUNT_ID?.trim()),
        where: "https://business.facebook.com/settings/system-users -> Generate Token with ads_read, ads_management",
      },
    ];
    console.log("==============================================================");
    console.log("🚀 HEYBROC STORE-PACKAGING PRODUCTION KEYS PRE-FLIGHT CHECK");
    console.log("==============================================================\n");
    for (const c of checks) {
      console.log(`${c.ok ? "✓ [READY]  " : "⚠ [MISSING]"} ${c.name}`);
      if (!c.ok) {
        console.log(`            ↳ Grab from: ${c.where}`);
      }
    }
    console.log("\nAdd any missing keys to Vercel -> Project Settings -> Environment Variables before store submission.");
    return;
  }

  // Default: `status`
  const [snap, paywall, creators, stripe, meta] = await Promise.all([
    getAnalyticsSnapshot(),
    getPaywallConfig(),
    listCreators(),
    fetchStripeSummary(),
    fetchMetaCampaigns(),
  ]);

  console.log("==============================================================");
  console.log("🥦 HEYBROC GROWTH, REVENUE, PAYWALL & ADS COMMAND CENTER");
  console.log("==============================================================\n");

  console.log("1. FIRST-PARTY FUNNEL & CONVERSION METRICS:");
  console.log(`   - Free Score Tests (product_scanned): ${snap.totals.product_scanned}`);
  console.log(`   - Clean Swaps Clicked:                ${snap.totals.clean_swap_clicked}`);
  console.log(`   - Paywalls Viewed:                    ${snap.totals.paywall_viewed}`);
  console.log(
    `   - Checkouts Started:                  ${snap.totals.checkout_started} (${pct(snap.totals.checkout_started, snap.totals.paywall_viewed)} of paywall views)`
  );
  console.log(
    `   - Pro Subscriptions:                  ${snap.totals.pro_subscribed} (${pct(snap.totals.pro_subscribed, snap.totals.paywall_viewed)} of paywall views | ${pct(snap.totals.pro_subscribed, snap.totals.product_scanned)} of free tests, target ~40%)`
  );
  console.log(`   - By Platform:                        ${JSON.stringify(snap.byPlatform)}`);
  console.log(`   - By Store:                           ${JSON.stringify(snap.byStore)}\n`);

  console.log("2. LIVE PAYWALL ('SUPERWALL') A/B EXPERIMENT:");
  console.log(`   - Active Headline (A):  "${paywall.headline}"`);
  console.log(`   - Variant B Headline:   "${paywall.variantBHeadline}" (A/B Enabled: ${paywall.abTestEnabled})`);
  console.log(`   - CTA Button:           "${paywall.ctaLabel}" | Default Plan: ${paywall.defaultPlan} | Free Swaps/Wk: ${paywall.freeWeeklySwapsLimit}`);
  console.log(
    `   - Variant A Conversion: ${snap.abTest.variantASubscribed}/${snap.abTest.variantAViews} (${pct(snap.abTest.variantASubscribed, snap.abTest.variantAViews)})`
  );
  console.log(
    `   - Variant B Conversion: ${snap.abTest.variantBSubscribed}/${snap.abTest.variantBViews} (${pct(snap.abTest.variantBSubscribed, snap.abTest.variantBViews)})\n`
  );

  console.log("3. CREATOR / AFFILIATE LEDGER:");
  for (const c of creators) {
    console.log(
      `   - ${c.code.padEnd(12)} | Split: ${c.commissionPct}% | Clicks: ${c.clicks} | Trials: ${c.trials} | Paid: ${c.paidAnnual} yr + ${c.paidMonthly} mo | Owed: $${c.commissionOwed.toFixed(2)} | Net: $${c.netRevenue.toFixed(2)}`
    );
  }
  console.log("");

  console.log("4. EXTERNAL INTEGRATIONS & META ADS STATUS:");
  console.log(`   - PostHog Bridge:       ${snap.posthogConnected ? "✓ CONNECTED" : "○ Not set (add POSTHOG_API_KEY)"}`);
  console.log(`   - RevenueCat Webhook:   ${snap.revenueCatConfigured ? "✓ CONNECTED" : "○ Not set (add REVENUECAT_WEBHOOK_SECRET)"}`);
  console.log(`   - Meta CAPI Bridge:     ${snap.metaCapiConnected ? "✓ CONNECTED" : "○ Not set (add META_PIXEL_ID + META_CAPI_TOKEN)"}`);
  if (stripe) {
    console.log(`   - Stripe Live Data:     ${JSON.stringify(stripe)}`);
  } else {
    console.log("   - Stripe Live Data:     ○ Not set in local env (add STRIPE_SECRET_KEY)");
  }
  if (meta) {
    console.log(`   - Meta Ads (75% Watch): ${JSON.stringify(meta)}`);
  } else {
    console.log("   - Meta Ads (75% Watch): ○ Not set in local env (run `npm run ops meta-campaigns` for Food Tracker Playbook)");
  }
}

main().catch((err) => {
  console.error("✖ [ops] Error:", err);
  process.exit(1);
});
