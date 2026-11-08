import { NextRequest, NextResponse } from "next/server";
import { recordSubscriptionConsent } from "@/lib/entitlements";
import { getCreator } from "@/lib/influencers";
import { PRICING, type PlanId } from "@/lib/pricing";
import { isValidReferralCode } from "@/lib/referrals";

const ALLOWED_ORIGINS = new Set([
  "https://heybroc.com",
  "https://www.heybroc.com",
  "https://cleancart-teal.vercel.app",
  "http://localhost:3000",
]);

const DEFAULT_TERMS_VERSION = "2026-11-08";

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "anon"
  );
}

/**
 * POST /api/checkout
 * Body: { plan: "annual" | "monthly", creatorCode?: string, deviceId?: string, email?: string, termsAccepted: boolean, termsVersion?: string, origin?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "Body must be a JSON object." }, { status: 400 });
    }
    const body = parsed as Record<string, unknown>;
    if (body.termsAccepted !== true) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Please check the box to agree to the Terms of Service and automatic renewal terms before continuing.",
        },
        { status: 400 }
      );
    }

    const plan: PlanId = body.plan === "monthly" ? "monthly" : "annual";
    const rawCreatorCode = typeof body.creatorCode === "string" ? body.creatorCode.trim().toUpperCase() : "";
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim().slice(0, 128) : "";
    const termsVersion =
      typeof body.termsVersion === "string" && body.termsVersion.trim()
        ? body.termsVersion.trim().slice(0, 40)
        : DEFAULT_TERMS_VERSION;
    const rawEmail =
      typeof body.email === "string"
        ? body.email
        : typeof body.customerEmail === "string"
          ? body.customerEmail
          : "";
    const customerEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(rawEmail.trim())
      ? rawEmail.trim().toLowerCase()
      : "";

    const consentTimestamp = new Date().toISOString();
    const clientIp = getClientIp(req);
    await recordSubscriptionConsent({
      deviceId: deviceId || "anon-web",
      email: customerEmail,
      plan,
      termsVersion,
      timestamp: consentTimestamp,
      ip: clientIp,
    });

    const isFriendCodeFormat = /^BROC-[A-Z0-9]{4,10}$/.test(rawCreatorCode);
    let verifiedCode = "";

    if (rawCreatorCode) {
      if (isFriendCodeFormat) {
        const exists = await isValidReferralCode(rawCreatorCode);
        if (!exists) {
          return NextResponse.json(
            { ok: false, error: "Invalid or expired friend referral code." },
            { status: 400 }
          );
        }
        verifiedCode = rawCreatorCode;
      } else {
        const validCreator = await getCreator(rawCreatorCode);
        if (!validCreator) {
          return NextResponse.json(
            { ok: false, error: "Invalid creator code." },
            { status: 400 }
          );
        }
        verifiedCode = validCreator.code;
      }
    }

    const candidateOrigin =
      (typeof body.origin === "string" ? body.origin : req.headers.get("origin"))?.replace(/\/+$/, "") || "";
    const origin = ALLOWED_ORIGINS.has(candidateOrigin) ? candidateOrigin : "https://heybroc.com";

    const trialDays = plan === "annual" ? (verifiedCode ? PRICING.creatorTrialDays : PRICING.trialDays) : 0;

    const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();
    if (!stripeKey) {
      if (process.env.ALLOW_PREVIEW_CHECKOUT === "true") {
        return NextResponse.json({
          ok: true,
          mode: "preview",
          plan,
          trialDays,
        });
      }
      return NextResponse.json(
        { ok: false, mode: "unconfigured", error: "Stripe checkout is not configured on this server." },
        { status: 503 }
      );
    }

    const unitAmountCents =
      plan === "annual" ? Math.round(PRICING.annual * 100) : Math.round(PRICING.monthly * 100);
    const interval = plan === "annual" ? "year" : "month";

    const params = new URLSearchParams();
    params.set("mode", "subscription");
    params.set(
      "success_url",
      `${origin}/?pro=1&session_id={CHECKOUT_SESSION_ID}&plan=${plan}${verifiedCode ? `&code=${encodeURIComponent(verifiedCode)}` : ""}${deviceId ? `&deviceId=${encodeURIComponent(deviceId)}` : ""}`
    );
    params.set("cancel_url", `${origin}/?checkout=cancelled${deviceId ? `&deviceId=${encodeURIComponent(deviceId)}` : ""}`);
    params.set("line_items[0][price_data][currency]", "usd");
    params.set("line_items[0][price_data][unit_amount]", String(unitAmountCents));
    params.set("line_items[0][price_data][recurring][interval]", interval);
    params.set(
      "line_items[0][price_data][product_data][name]",
      plan === "annual" ? "HeyBroc Family Pro (Annual)" : "HeyBroc Family Pro (Monthly)"
    );
    params.set(
      "line_items[0][price_data][product_data][description]",
      "Unlimited live store overlays across 12 grocery apps, 1-tap clean swaps & whole-cart health checks."
    );
    params.set("line_items[0][quantity]", "1");
    params.set("metadata[plan]", plan);
    params.set("metadata[terms_version]", termsVersion);
    params.set("metadata[terms_accepted_at]", consentTimestamp);
    params.set("subscription_data[metadata][plan]", plan);
    params.set("subscription_data[metadata][terms_version]", termsVersion);
    params.set("subscription_data[metadata][terms_accepted_at]", consentTimestamp);

    if (deviceId) {
      params.set("client_reference_id", deviceId);
      params.set("metadata[device_id]", deviceId);
      params.set("subscription_data[metadata][device_id]", deviceId);
    }
    if (customerEmail) {
      params.set("customer_email", customerEmail);
      params.set("metadata[customer_email]", customerEmail);
      params.set("subscription_data[metadata][customer_email]", customerEmail);
    }
    if (trialDays > 0) {
      params.set("subscription_data[trial_period_days]", String(trialDays));
    }
    if (verifiedCode) {
      params.set("metadata[creator_code]", verifiedCode);
      params.set("subscription_data[metadata][creator_code]", verifiedCode);
    }

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const session = await res.json();
    if (!res.ok || !session.url) {
      return NextResponse.json(
        { ok: false, error: session?.error?.message || "Failed to create Stripe Checkout session." },
        { status: 400 }
      );
    }

    void import("@/lib/analytics")
      .then(({ assignPaywallVariant, trackServerEvent }) =>
        trackServerEvent({
          event: "checkout_started",
          distinctId: deviceId || customerEmail || "anon-web",
          platform: "web",
          variant: assignPaywallVariant(deviceId, true),
          properties: {
            plan,
            creatorCode: verifiedCode || null,
          },
        }),
      )
      .catch(() => {});

    return NextResponse.json({
      ok: true,
      mode: "stripe",
      url: session.url,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Checkout error" },
      { status: 500 }
    );
  }
}
