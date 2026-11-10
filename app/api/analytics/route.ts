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
import { checkRateLimitAsync } from "@/lib/scan";

const ALLOWED_EVENTS = new Set<AnalyticsEventName>([
  "product_scanned",
  "clean_swap_clicked",
  "paywall_viewed",
  "checkout_started",
  "onboarding_step",
  "auth_completed",
]);

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "anon"
  );
}

function parseCookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ? decodeURIComponent(match[1]).slice(0, 160) : undefined;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode");
  const deviceId = (searchParams.get("deviceId") || "").trim();

  if (mode === "paywall") {
    if (!(await checkRateLimitAsync(`analytics:get:${clientIp(req)}`, 60))) {
      return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
    }
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
  const ip = clientIp(req);
  if (!(await checkRateLimitAsync(`analytics:post:${ip}`, 40))) {
    return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429 });
  }
  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
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

  const rawDistinct =
    typeof body.deviceId === "string" && body.deviceId.trim()
      ? body.deviceId.trim()
      : typeof body.distinctId === "string" && body.distinctId.trim()
        ? body.distinctId.trim()
        : undefined;
  const distinctId = rawDistinct ? rawDistinct.slice(0, 80) : undefined;
  const store = typeof body.store === "string" ? body.store.slice(0, 24) : undefined;
  const variant = body.variant === "B" ? "B" : body.variant === "A" ? "A" : undefined;

  let properties: Record<string, string | number | boolean | null> | undefined;
  if (body.properties && typeof body.properties === "object" && !Array.isArray(body.properties)) {
    properties = {};
    for (const [k, v] of Object.entries(body.properties as Record<string, unknown>).slice(0, 12)) {
      const cleanKey = k.trim().slice(0, 40);
      // Never allow unauthenticated client calls to spoof paid revenue (`amountUsd`)
      if (!cleanKey || cleanKey === "amountUsd" || cleanKey.startsWith("$")) continue;
      if (typeof v === "string") {
        properties[cleanKey] = v.slice(0, 80);
      } else if (typeof v === "number" && Number.isFinite(v)) {
        properties[cleanKey] = v;
      } else if (typeof v === "boolean" || v === null) {
        properties[cleanKey] = v;
      }
    }
  }

  const cookieHeader = req.headers.get("cookie");
  const referer = req.headers.get("referer");

  await trackServerEvent({
    event,
    distinctId,
    platform,
    store,
    variant,
    clientIp: ip,
    userAgent: req.headers.get("user-agent")?.slice(0, 240),
    sourceUrl: referer && /^https?:\/\//i.test(referer) ? referer.slice(0, 240) : undefined,
    fbc: parseCookieValue(cookieHeader, "_fbc"),
    fbp: parseCookieValue(cookieHeader, "_fbp"),
    properties,
  });

  return NextResponse.json({ ok: true });
}
