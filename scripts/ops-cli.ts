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
        const amt = (s.plan?.amount || 0) / 100;
        mrrUsd += s.plan?.interval === "year" ? amt / 12 : amt;
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
  const token = (process.env.META_ADS_ACCESS_TOKEN || process.env.META_CAPI_TOKEN || "").trim();
  const rawAccountId = (process.env.META_AD_ACCOUNT_ID || "").trim();
  if (!token || !rawAccountId) return null;
  const accountId = rawAccountId.startsWith("act_") ? rawAccountId : `act_${rawAccountId}`;
  try {
    const url =
      `https://graph.facebook.com/v21.0/${encodeURIComponent(accountId)}/campaigns` +
      `?fields=id,name,status,effective_status,daily_budget,insights.date_preset(last_7d){spend,impressions,clicks,cpc,ctr,actions}` +
      `&limit=25&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { error: `HTTP ${res.status}: ${txt.slice(0, 160)}` };
    }
    const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
    return { campaigns: data.data || [] };
  } catch (err) {
    return { error: String(err) };
  }
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
    if (!id || !dailyCents) {
      console.error("✖ Usage: npm run ops meta-budget -- --id=<ADSET_ID> --daily-cents=5000");
      process.exit(1);
    }
    await updateMetaObject(id, { daily_budget: String(Math.round(Number(dailyCents))) });
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
  console.log(`   - Products Scanned:     ${snap.totals.product_scanned}`);
  console.log(`   - Clean Swaps Clicked:  ${snap.totals.clean_swap_clicked}`);
  console.log(`   - Paywalls Viewed:      ${snap.totals.paywall_viewed}`);
  console.log(
    `   - Checkouts Started:    ${snap.totals.checkout_started} (${pct(snap.totals.checkout_started, snap.totals.paywall_viewed)} of paywall views)`
  );
  console.log(
    `   - Pro Subscriptions:    ${snap.totals.pro_subscribed} (${pct(snap.totals.pro_subscribed, snap.totals.paywall_viewed)} of paywall views)`
  );
  console.log(`   - By Platform:          ${JSON.stringify(snap.byPlatform)}`);
  console.log(`   - By Store:             ${JSON.stringify(snap.byStore)}\n`);

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

  console.log("4. EXTERNAL INTEGRATIONS STATUS:");
  console.log(`   - PostHog Bridge:       ${snap.posthogConnected ? "✓ CONNECTED" : "○ Not set (add POSTHOG_API_KEY)"}`);
  console.log(`   - RevenueCat Webhook:   ${snap.revenueCatConfigured ? "✓ CONNECTED" : "○ Not set (add REVENUECAT_WEBHOOK_SECRET)"}`);
  console.log(`   - Meta CAPI Bridge:     ${snap.metaCapiConnected ? "✓ CONNECTED" : "○ Not set (add META_PIXEL_ID + META_CAPI_TOKEN)"}`);
  if (stripe) {
    console.log(`   - Stripe Live Data:     ${JSON.stringify(stripe)}`);
  } else {
    console.log("   - Stripe Live Data:     ○ Not set in local env (add STRIPE_SECRET_KEY)");
  }
  if (meta) {
    console.log(`   - Meta Ads Campaigns:   ${JSON.stringify(meta)}`);
  } else {
    console.log("   - Meta Ads Campaigns:   ○ Not set in local env (add META_ADS_ACCESS_TOKEN + META_AD_ACCOUNT_ID)");
  }
}

main().catch((err) => {
  console.error("✖ [ops] Error:", err);
  process.exit(1);
});
