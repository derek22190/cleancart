import { NextResponse } from "next/server";
import { isAdminAuthorized } from "@/lib/admin-auth";
import {
  assignPaywallVariant,
  getAnalyticsSnapshot,
  getPaywallConfig,
  savePaywallConfig,
  trackServerEvent,
  type AnalyticsEventName,
  type PlatformType,
} from "@/lib/analytics";

const ALLOWED_EVENTS = new Set<AnalyticsEventName>([
  "product_scanned",
  "clean_swap_clicked",
  "paywall_viewed",
  "checkout_started",
  "pro_subscribed",
  "onboarding_step",
  "auth_completed",
]);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode");
  const deviceId = (searchParams.get("deviceId") || "").trim();

  if (mode === "paywall") {
    const paywall = await getPaywallConfig();
    const assignedVariant = assignPaywallVariant(deviceId, paywall.abTestEnabled);
    const activeHeadline =
      assignedVariant === "B" && paywall.abTestEnabled ? paywall.variantBHeadline : paywall.headline;
    return NextResponse.json({
      ok: true,
      paywall,
      assignedVariant,
      activeHeadline,
    });
  }

  if (!isAdminAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized. Provide valid Bearer HEYBROC_ADMIN_SECRET." },
      { status: 401 },
    );
  }

  const [snapshot, paywall] = await Promise.all([getAnalyticsSnapshot(), getPaywallConfig()]);
  return NextResponse.json({
    ok: true,
    snapshot,
    paywall,
  });
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "track";

  if (action === "update_paywall") {
    if (!isAdminAuthorized(req)) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized. Provide valid Bearer HEYBROC_ADMIN_SECRET." },
        { status: 401 },
      );
    }
    const updated = await savePaywallConfig({
      headline: typeof body.headline === "string" ? body.headline : undefined,
      subheadline: typeof body.subheadline === "string" ? body.subheadline : undefined,
      ctaLabel: typeof body.ctaLabel === "string" ? body.ctaLabel : undefined,
      freeWeeklySwapsLimit:
        typeof body.freeWeeklySwapsLimit === "number" ? body.freeWeeklySwapsLimit : undefined,
      defaultPlan:
        body.defaultPlan === "monthly" || body.defaultPlan === "annual" ? body.defaultPlan : undefined,
      abTestEnabled: typeof body.abTestEnabled === "boolean" ? body.abTestEnabled : undefined,
      variantBHeadline: typeof body.variantBHeadline === "string" ? body.variantBHeadline : undefined,
    });
    return NextResponse.json({ ok: true, paywall: updated });
  }

  const event = typeof body.event === "string" ? (body.event as AnalyticsEventName) : null;
  if (!event || !ALLOWED_EVENTS.has(event)) {
    return NextResponse.json({ ok: false, error: "Unsupported analytics event name." }, { status: 400 });
  }

  const platform: PlatformType =
    typeof body.platform === "string" && ["web", "android", "extension", "ios"].includes(body.platform)
      ? (body.platform as PlatformType)
      : "web";

  const distinctId = typeof body.deviceId === "string" ? body.deviceId.slice(0, 80) : undefined;
  const store = typeof body.store === "string" ? body.store.slice(0, 24) : undefined;
  const variant = body.variant === "B" ? "B" : body.variant === "A" ? "A" : undefined;
  const properties =
    body.properties && typeof body.properties === "object" && !Array.isArray(body.properties)
      ? (body.properties as Record<string, string | number | boolean | null | undefined>)
      : undefined;

  await trackServerEvent({
    event,
    distinctId,
    platform,
    store,
    variant,
    properties,
  });

  return NextResponse.json({ ok: true });
}
