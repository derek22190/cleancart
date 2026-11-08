/**
 * HeyBroc — First-Party Funnel Analytics + PostHog Bridge + Remote Paywall ("Superwall") Config
 * ---------------------------------------------------------------------------------------------
 * 1. Tracks core growth funnel events (`product_scanned`, `clean_swap_clicked`, `paywall_viewed`,
 *    `checkout_started`, `pro_subscribed`, `onboarding_step`, `auth_completed`) in our KV store
 *    so `/admin` displays real-time funnel conversion metrics and A/B test results at $0 cost.
 * 2. Automatically forwards events server-side to PostHog (`https://us.i.posthog.com/capture/`)
 *    whenever `POSTHOG_API_KEY` or `NEXT_PUBLIC_POSTHOG_KEY` is configured — requiring ZERO
 *    third-party tracking SDKs inside the Android APK (preserving 100% Google Play Accessibility compliance).
 * 3. Stores remote paywall copy, CTA labels, free weekly swap limits, and A/B headline experiments
 *    so paywalls can be tuned live from `/admin` without an app store update.
 */
import "server-only";
import { kvGet, kvSet } from "./storage";

export type AnalyticsEventName =
  | "product_scanned"
  | "clean_swap_clicked"
  | "paywall_viewed"
  | "checkout_started"
  | "pro_subscribed"
  | "onboarding_step"
  | "auth_completed";

export type PlatformType = "web" | "android" | "extension" | "ios";

export interface AnalyticsEventInput {
  event: AnalyticsEventName;
  distinctId?: string;
  platform?: PlatformType;
  store?: string;
  variant?: "A" | "B";
  properties?: Record<string, string | number | boolean | null | undefined>;
}

export interface RecentEventEntry {
  id: string;
  event: AnalyticsEventName;
  platform: PlatformType;
  store?: string;
  variant?: "A" | "B";
  summary: string;
  timestamp: string;
}

export interface PaywallExperimentConfig {
  headline: string;
  subheadline: string;
  ctaLabel: string;
  freeWeeklySwapsLimit: number;
  defaultPlan: "annual" | "monthly";
  abTestEnabled: boolean;
  variantBHeadline: string;
  updatedAt: string;
}

export interface AnalyticsSnapshot {
  totals: Record<AnalyticsEventName, number>;
  byPlatform: Record<PlatformType, number>;
  byStore: Record<string, number>;
  abTest: {
    variantAViews: number;
    variantACheckouts: number;
    variantASubscribed: number;
    variantBViews: number;
    variantBCheckouts: number;
    variantBSubscribed: number;
  };
  recentEvents: RecentEventEntry[];
  posthogConnected: boolean;
  revenueCatConfigured: boolean;
  updatedAt: string;
}

const ANALYTICS_KV_KEY = "heybroc:analytics:snapshot_v1";
const PAYWALL_CONFIG_KV_KEY = "heybroc:config:paywall_v1";

export const DEFAULT_PAYWALL_CONFIG: PaywallExperimentConfig = {
  headline: "Shop clean on every aisle — without doing the homework",
  subheadline:
    "Product health scores (0–100) are 100% free forever. Unlock unlimited 1-tap Clean Swaps and Whole-Cart Health Checks across all 12 stores.",
  ctaLabel: "Start Free Trial — $0 Today",
  freeWeeklySwapsLimit: 3,
  defaultPlan: "annual",
  abTestEnabled: true,
  variantBHeadline: "Protect your family from hidden seed oils & synthetic dyes in 1 tap",
  updatedAt: new Date().toISOString(),
};

function emptySnapshot(): AnalyticsSnapshot {
  return {
    totals: {
      product_scanned: 0,
      clean_swap_clicked: 0,
      paywall_viewed: 0,
      checkout_started: 0,
      pro_subscribed: 0,
      onboarding_step: 0,
      auth_completed: 0,
    },
    byPlatform: {
      web: 0,
      android: 0,
      extension: 0,
      ios: 0,
    },
    byStore: {},
    abTest: {
      variantAViews: 0,
      variantACheckouts: 0,
      variantASubscribed: 0,
      variantBViews: 0,
      variantBCheckouts: 0,
      variantBSubscribed: 0,
    },
    recentEvents: [],
    posthogConnected: Boolean(process.env.POSTHOG_API_KEY || process.env.NEXT_PUBLIC_POSTHOG_KEY),
    revenueCatConfigured: Boolean(process.env.REVENUECAT_WEBHOOK_SECRET),
    updatedAt: new Date().toISOString(),
  };
}

let memorySnapshot: AnalyticsSnapshot | null = null;
let memoryPaywallConfig: PaywallExperimentConfig | null = null;

export async function getPaywallConfig(): Promise<PaywallExperimentConfig> {
  const stored = await kvGet<PaywallExperimentConfig>(PAYWALL_CONFIG_KV_KEY);
  if (stored && typeof stored.headline === "string") {
    memoryPaywallConfig = {
      ...DEFAULT_PAYWALL_CONFIG,
      ...stored,
      freeWeeklySwapsLimit: Math.max(1, Math.min(50, Number(stored.freeWeeklySwapsLimit) || 5)),
    };
    return memoryPaywallConfig;
  }
  return memoryPaywallConfig || DEFAULT_PAYWALL_CONFIG;
}

export async function savePaywallConfig(
  patch: Partial<PaywallExperimentConfig>,
): Promise<PaywallExperimentConfig> {
  const current = await getPaywallConfig();
  const next: PaywallExperimentConfig = {
    headline: typeof patch.headline === "string" && patch.headline.trim() ? patch.headline.trim().slice(0, 160) : current.headline,
    subheadline:
      typeof patch.subheadline === "string" && patch.subheadline.trim()
        ? patch.subheadline.trim().slice(0, 280)
        : current.subheadline,
    ctaLabel: typeof patch.ctaLabel === "string" && patch.ctaLabel.trim() ? patch.ctaLabel.trim().slice(0, 80) : current.ctaLabel,
    freeWeeklySwapsLimit:
      typeof patch.freeWeeklySwapsLimit === "number" && Number.isFinite(patch.freeWeeklySwapsLimit)
        ? Math.max(1, Math.min(50, Math.round(patch.freeWeeklySwapsLimit)))
        : current.freeWeeklySwapsLimit,
    defaultPlan: patch.defaultPlan === "monthly" ? "monthly" : patch.defaultPlan === "annual" ? "annual" : current.defaultPlan,
    abTestEnabled: typeof patch.abTestEnabled === "boolean" ? patch.abTestEnabled : current.abTestEnabled,
    variantBHeadline:
      typeof patch.variantBHeadline === "string" && patch.variantBHeadline.trim()
        ? patch.variantBHeadline.trim().slice(0, 160)
        : current.variantBHeadline,
    updatedAt: new Date().toISOString(),
  };
  memoryPaywallConfig = next;
  await kvSet(PAYWALL_CONFIG_KV_KEY, next);
  return next;
}

/** Deterministic A/B variant assignment ("A" or "B") from a deviceId. */
export function assignPaywallVariant(deviceId?: string, abTestEnabled = true): "A" | "B" {
  if (!abTestEnabled || !deviceId) return "A";
  let sum = 0;
  for (let i = 0; i < deviceId.length; i++) {
    sum = (sum + deviceId.charCodeAt(i)) & 0xffff;
  }
  return sum % 2 === 0 ? "A" : "B";
}

export async function getAnalyticsSnapshot(): Promise<AnalyticsSnapshot> {
  const stored = await kvGet<AnalyticsSnapshot>(ANALYTICS_KV_KEY);
  const base = stored || memorySnapshot || emptySnapshot();
  return {
    ...emptySnapshot(),
    ...base,
    totals: { ...emptySnapshot().totals, ...(base.totals || {}) },
    byPlatform: { ...emptySnapshot().byPlatform, ...(base.byPlatform || {}) },
    byStore: { ...(base.byStore || {}) },
    abTest: { ...emptySnapshot().abTest, ...(base.abTest || {}) },
    recentEvents: Array.isArray(base.recentEvents) ? base.recentEvents.slice(0, 60) : [],
    posthogConnected: Boolean(process.env.POSTHOG_API_KEY || process.env.NEXT_PUBLIC_POSTHOG_KEY),
    revenueCatConfigured: Boolean(process.env.REVENUECAT_WEBHOOK_SECRET),
  };
}

export async function trackServerEvent(input: AnalyticsEventInput): Promise<void> {
  try {
    const snap = await getAnalyticsSnapshot();
    const platform: PlatformType =
      input.platform && ["web", "android", "extension", "ios"].includes(input.platform)
        ? input.platform
        : "web";

    snap.totals[input.event] = (snap.totals[input.event] || 0) + 1;
    snap.byPlatform[platform] = (snap.byPlatform[platform] || 0) + 1;

    if (input.store) {
      const st = input.store.toLowerCase().slice(0, 24);
      snap.byStore[st] = (snap.byStore[st] || 0) + 1;
    }

    const variant = input.variant || (input.properties?.variant === "B" ? "B" : "A");
    if (input.event === "paywall_viewed") {
      if (variant === "B") snap.abTest.variantBViews += 1;
      else snap.abTest.variantAViews += 1;
    } else if (input.event === "checkout_started") {
      if (variant === "B") snap.abTest.variantBCheckouts += 1;
      else snap.abTest.variantACheckouts += 1;
    } else if (input.event === "pro_subscribed") {
      if (variant === "B") snap.abTest.variantBSubscribed += 1;
      else snap.abTest.variantASubscribed += 1;
    }

    const propSummary = Object.entries(input.properties || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .slice(0, 4)
      .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`)
      .join(" · ");

    const entry: RecentEventEntry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      event: input.event,
      platform,
      store: input.store,
      variant,
      summary: propSummary || input.event,
      timestamp: new Date().toISOString(),
    };
    snap.recentEvents = [entry, ...(snap.recentEvents || [])].slice(0, 60);
    snap.updatedAt = entry.timestamp;

    memorySnapshot = snap;
    await kvSet(ANALYTICS_KV_KEY, snap);

    // Optional non-blocking server-side PostHog forwarding
    const phKey = (process.env.POSTHOG_API_KEY || process.env.NEXT_PUBLIC_POSTHOG_KEY || "").trim();
    const phHost = (process.env.POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/+$/, "");
    if (phKey) {
      void fetch(`${phHost}/capture/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: phKey,
          event: input.event,
          distinct_id: input.distinctId || `anon-${platform}`,
          properties: {
            $lib: "heybroc-server",
            platform,
            store: input.store,
            variant,
            ...(input.properties || {}),
          },
          timestamp: entry.timestamp,
        }),
        signal: AbortSignal.timeout(2500),
      }).catch(() => {});
    }
  } catch {
    // Analytics must never block or fail user requests
  }
}
