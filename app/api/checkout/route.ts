import { NextRequest, NextResponse } from "next/server";
import { recordSubscriptionConsent } from "@/lib/entitlements";
import { getCreator } from "@/lib/influencers";
import { PRICING, TERMS_VERSION, type PlanId } from "@/lib/pricing";
import { getOrCreateDevice, isValidReferralCode } from "@/lib/referrals";

const ALLOWED_ORIGINS = new Set([
  "https://heybroc.com",
  "https://www.heybroc.com",
  "https://cleancart.vercel.app",
  "https://cleancart-teal.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function resolveAllowedOrigin(raw?: string | null): string {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL || "").trim().replace(/\/+$/, "");
  if (configured && /^https?:\/\//i.test(configured)) {
    ALLOWED_ORIGINS.add(configured);
  }
  const clean = (raw || "").trim().replace(/\/+$/, "");
  if (clean && ALLOWED_ORIGINS.has(clean)) return clean;
  return configured && /^https?:\/\//i.test(configured) ? configured : "https://heybroc.com";
}

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "anon"
  );
}

/**
 * POST /api/checkout
 * Body: { plan: "annual" | "monthly", creatorCode?: string, deviceId?: string, deviceSecret?: string, email?: string, termsAccepted: boolean, termsVersion?: string, origin?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "Body must be a JSON object." }, { status: 400 });
    }
    const body = parsed as Record<string, unknown>;
    const hasExpressConsent =
      body.termsAccepted === true || body.consentAccepted === true;
    if (!hasExpressConsent) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Please check the box to agree to the Terms of Service and automatic renewal terms before continuing.",
        },
        { status: 400 }
      );
    }

    const suppliedTermsVersion =
      typeof body.termsVersion === "string" ? body.termsVersion.trim() : "";
    if (!suppliedTermsVersion || suppliedTermsVersion !== TERMS_VERSION) {
      return NextResponse.json(
        {
          ok: false,
          error: `Outdated or missing Terms of Service version. Expected ${TERMS_VERSION}; please refresh and review the current terms.`,
        },
        { status: 400 }
      );
    }

    const plan: PlanId = body.plan === "monthly" ? "monthly" : "annual";
    const rawCreatorCode = typeof body.creatorCode === "string" ? body.creatorCode.trim().toUpperCase() : "";
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim().slice(0, 128) : "";
    const deviceSecret =
      typeof body.deviceSecret === "string"
        ? body.deviceSecret.trim()
        : req.headers.get("x-device-secret")?.trim() || "";
    const termsVersion = TERMS_VERSION;
    const rawEmail =
      typeof body.email === "string"
        ? body.email
        : typeof body.customerEmail === "string"
          ? body.customerEmail
          : "";
    const customerEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(rawEmail.trim())
      ? rawEmail.trim().toLowerCase()
      : "";

    let deviceReferredBy = "";
    if (deviceId && deviceId !== "anon-web" && deviceSecret) {
      const devRes = await getOrCreateDevice(deviceId, deviceSecret).catch(() => null);
      if (devRes?.referredByCode) {
        deviceReferredBy = devRes.referredByCode;
      }
    }

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
    } else if (deviceReferredBy && /^BROC-[A-Z0-9]{4,10}$/.test(deviceReferredBy)) {
      verifiedCode = deviceReferredBy;
    }

    const candidateOrigin =
      (typeof body.origin === "string" ? body.origin : req.headers.get("origin")) || "";
    const origin = resolveAllowedOrigin(candidateOrigin);

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
      "Unlimited live store overlays across 15 grocery apps, 1-tap clean swaps & whole-cart health checks."
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

    if (typeof session.id === "string" && session.id.trim()) {
      await recordSubscriptionConsent({
        deviceId: deviceId || "anon-web",
        email: customerEmail,
        plan,
        termsVersion,
        timestamp: consentTimestamp,
        ip: clientIp,
        sessionId: session.id.trim(),
      });
    }

    void import("@/lib/analytics")
      .then(({ assignPaywallVariant, trackServerEvent }) =>
        trackServerEvent({
          event: "checkout_started",
          distinctId: deviceId || session.id || "anon-web",
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
