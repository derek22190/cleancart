import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  getDevicePaidEntitlement,
  getEmailEntitlement,
  isValidStripeSessionIdFormat,
  recordSubscriptionConsent,
  verifyStripeCheckoutSession,
  type EntitlementRecord,
} from "@/lib/entitlements";
import { getCreator } from "@/lib/influencers";
import { PRICING, TERMS_VERSION, type OtoOfferId, type PlanId } from "@/lib/pricing";
import {
  getExistingDevice,
  getOrCreateDevice,
  isValidReferralCode,
  verifyDeviceSecret,
} from "@/lib/referrals";
import { checkRateLimitAsync } from "@/lib/scan";

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
 * Body: { plan: "annual" | "monthly", otoOffer?: "oto_annual" | "oto_gift_year", previousSessionId?: string, adTestMode?: boolean, creatorCode?: string, deviceId?: string, deviceSecret?: string, email?: string, termsAccepted: boolean, termsVersion?: string, origin?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const clientIp = getClientIp(req);
    if (!(await checkRateLimitAsync(`checkout:${clientIp}`, 20))) {
      return NextResponse.json(
        { ok: false, error: "Too many checkout requests. Please wait a moment and try again." },
        { status: 429 }
      );
    }

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

    const rawOtoOffer = typeof body.otoOffer === "string" ? body.otoOffer.trim() : "";
    const otoOffer: OtoOfferId | null =
      rawOtoOffer === "oto_annual" || rawOtoOffer === "oto_gift_year"
        ? rawOtoOffer
        : null;
    const previousSessionId =
      typeof body.previousSessionId === "string" ? body.previousSessionId.trim() : "";
    const adTestMode = body.adTestMode === true;

    const plan: PlanId =
      otoOffer === "oto_annual" || otoOffer === "oto_gift_year"
        ? "annual"
        : body.plan === "monthly"
          ? "monthly"
          : "annual";
    const rawCreatorCode = typeof body.creatorCode === "string" ? body.creatorCode.trim().toUpperCase() : "";
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim().slice(0, 128) : "";
    const deviceSecret =
      typeof body.deviceSecret === "string"
        ? body.deviceSecret.trim()
        : req.headers.get("x-device-secret")?.trim() || "";
    const authToken =
      req.headers
        .get("authorization")
        ?.replace(/^Bearer\s+/i, "")
        .trim() || "";
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
    let ownReferralCode = "";
    let hasVerifiedDeviceSecret = false;
    if (deviceId && deviceId !== "anon-web" && deviceSecret) {
      const existingDev = await getExistingDevice(deviceId).catch(() => null);
      if (existingDev?.deviceSecretHash && verifyDeviceSecret(existingDev, deviceSecret)) {
        hasVerifiedDeviceSecret = true;
      }
      const devRes = await getOrCreateDevice(deviceId, deviceSecret).catch(() => null);
      if (devRes?.referralCode) {
        ownReferralCode = devRes.referralCode.trim().toUpperCase();
      }
      if (devRes?.referredByCode) {
        deviceReferredBy = devRes.referredByCode.trim().toUpperCase();
      }
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();
    const isPreviewAllowed = !stripeKey && process.env.ALLOW_PREVIEW_CHECKOUT === "true";

    // Gate discounted post-checkout OTO offers behind a verified prior checkout session or active Pro entitlement
    let priorEntitlement: EntitlementRecord | null = null;
    if (otoOffer !== null) {
      if (previousSessionId && isValidStripeSessionIdFormat(previousSessionId)) {
        priorEntitlement = await verifyStripeCheckoutSession(
          previousSessionId,
          deviceId || undefined
        );
      }
      if (!priorEntitlement && deviceId && deviceId !== "anon-web" && hasVerifiedDeviceSecret) {
        priorEntitlement = await getDevicePaidEntitlement(deviceId);
      }
      if (!priorEntitlement && authToken) {
        const authUser = await getAuthenticatedUser(authToken).catch(() => null);
        if (authUser?.emailVerified && authUser.email) {
          priorEntitlement = await getEmailEntitlement(authUser.email);
        }
      }
      if (!priorEntitlement?.active && !isPreviewAllowed) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "One-time post-checkout offers are only available immediately after activating a HeyBroc Family Pro membership.",
          },
          { status: 403 }
        );
      }
    }

    const existingCustomerId = priorEntitlement?.customerId || "";
    const previousSubscriptionId =
      priorEntitlement?.subscriptionId && priorEntitlement.subscriptionId.startsWith("sub_")
        ? priorEntitlement.subscriptionId
        : "";
    const effectiveEmail =
      customerEmail || priorEntitlement?.customerEmail?.trim().toLowerCase() || "";
    const isOneTimeOtoPass = otoOffer === "oto_gift_year";
    const recurringPriceUsd =
      otoOffer === "oto_annual"
        ? PRICING.otoAnnualLockIn
        : plan === "annual"
          ? PRICING.annual
          : PRICING.monthly;

    const consentTimestamp = new Date().toISOString();
    // Only record auto-renewal consent on recurring subscriptions (never overwrite Step 1's ARL consent on a one-time pass)
    if (!isOneTimeOtoPass) {
      await recordSubscriptionConsent({
        deviceId: deviceId || "anon-web",
        email: effectiveEmail,
        plan,
        termsVersion,
        timestamp: consentTimestamp,
        ip: clientIp,
        otoOffer: otoOffer || undefined,
        recurringPriceUsd,
      });
    }

    const candidateCreatorCode =
      rawCreatorCode || (priorEntitlement?.creatorCode || "").trim().toUpperCase();
    const isFriendCodeFormat = /^BROC-[A-Z0-9]{4,10}$/.test(candidateCreatorCode);
    let verifiedCode = "";

    if (candidateCreatorCode) {
      if (isFriendCodeFormat) {
        if (ownReferralCode && candidateCreatorCode === ownReferralCode) {
          if (rawCreatorCode) {
            return NextResponse.json(
              { ok: false, error: "You cannot use your own referral code." },
              { status: 400 }
            );
          }
        } else {
          const exists = await isValidReferralCode(candidateCreatorCode);
          if (!exists && rawCreatorCode) {
            return NextResponse.json(
              { ok: false, error: "Invalid or expired friend referral code." },
              { status: 400 }
            );
          }
          if (exists) verifiedCode = candidateCreatorCode;
        }
      } else {
        const validCreator = await getCreator(candidateCreatorCode);
        if (!validCreator && rawCreatorCode) {
          return NextResponse.json(
            { ok: false, error: "Invalid creator code." },
            { status: 400 }
          );
        }
        if (validCreator) verifiedCode = validCreator.code;
      }
    } else if (
      deviceReferredBy &&
      /^BROC-[A-Z0-9]{4,10}$/.test(deviceReferredBy) &&
      deviceReferredBy !== ownReferralCode &&
      (await isValidReferralCode(deviceReferredBy))
    ) {
      verifiedCode = deviceReferredBy;
    }

    const candidateOrigin =
      (typeof body.origin === "string" ? body.origin : req.headers.get("origin")) || "";
    const origin = resolveAllowedOrigin(candidateOrigin);

    const trialDays =
      otoOffer !== null
        ? 0
        : plan === "annual"
          ? verifiedCode
            ? PRICING.creatorTrialDays
            : PRICING.trialDays
          : 0;

    if (!stripeKey) {
      if (process.env.ALLOW_PREVIEW_CHECKOUT === "true") {
        return NextResponse.json({
          ok: true,
          mode: "preview",
          plan,
          otoOffer,
          trialDays,
        });
      }
      return NextResponse.json(
        { ok: false, mode: "unconfigured", error: "Stripe checkout is not configured on this server." },
        { status: 503 }
      );
    }

    const unitAmountCents =
      otoOffer === "oto_annual"
        ? Math.round(PRICING.otoAnnualLockIn * 100)
        : otoOffer === "oto_gift_year"
          ? Math.round(PRICING.otoExtraYearPass * 100)
          : plan === "annual"
            ? Math.round(PRICING.annual * 100)
            : Math.round(PRICING.monthly * 100);
    const interval = plan === "annual" ? "year" : "month";
    const cancelPath = adTestMode ? "/test" : "/";

    const params = new URLSearchParams();
    params.set("mode", isOneTimeOtoPass ? "payment" : "subscription");
    params.set(
      "success_url",
      `${origin}/?pro=1&session_id={CHECKOUT_SESSION_ID}&plan=${plan}${otoOffer ? `&oto=${encodeURIComponent(otoOffer)}` : ""}${verifiedCode ? `&code=${encodeURIComponent(verifiedCode)}` : ""}${deviceId ? `&deviceId=${encodeURIComponent(deviceId)}` : ""}`
    );
    params.set(
      "cancel_url",
      `${origin}${cancelPath}?checkout=cancelled${deviceId ? `&deviceId=${encodeURIComponent(deviceId)}` : ""}`
    );
    params.set("line_items[0][price_data][currency]", "usd");
    params.set("line_items[0][price_data][unit_amount]", String(unitAmountCents));
    if (!isOneTimeOtoPass) {
      params.set("line_items[0][price_data][recurring][interval]", interval);
    }
    params.set(
      "line_items[0][price_data][product_data][name]",
      otoOffer === "oto_annual"
        ? "HeyBroc Family Pro — One-Time VIP Annual Lock-In ($39.99/yr)"
        : otoOffer === "oto_gift_year"
          ? "HeyBroc Family Pro — +1 Extra Full Year Pass (One-Time, Never Auto-Renews)"
          : plan === "annual"
            ? "HeyBroc Family Pro (Annual)"
            : "HeyBroc Family Pro (Monthly)"
    );
    params.set(
      "line_items[0][price_data][product_data][description]",
      "Unlimited live store overlays across 12 grocery stores & delivery apps, 1-tap clean swaps & whole-cart health checks."
    );
    params.set("line_items[0][quantity]", "1");
    params.set("metadata[plan]", plan);
    params.set("metadata[terms_version]", termsVersion);
    params.set("metadata[terms_accepted_at]", consentTimestamp);
    if (otoOffer) {
      params.set("metadata[oto_offer]", otoOffer);
    }
    if (previousSessionId) {
      params.set("metadata[previous_session_id]", previousSessionId);
    }
    if (!isOneTimeOtoPass) {
      params.set("subscription_data[metadata][plan]", plan);
      params.set("subscription_data[metadata][terms_version]", termsVersion);
      params.set("subscription_data[metadata][terms_accepted_at]", consentTimestamp);
      if (otoOffer) {
        params.set("subscription_data[metadata][oto_offer]", otoOffer);
      }
      if (otoOffer === "oto_annual" && previousSubscriptionId) {
        params.set("metadata[previous_subscription_id]", previousSubscriptionId);
        params.set(
          "subscription_data[metadata][previous_subscription_id]",
          previousSubscriptionId
        );
      }
    } else {
      params.set("payment_intent_data[metadata][oto_offer]", "oto_gift_year");
      params.set("payment_intent_data[metadata][plan]", "annual");
      if (previousSessionId) {
        params.set("payment_intent_data[metadata][previous_session_id]", previousSessionId);
      }
    }

    if (deviceId) {
      params.set("client_reference_id", deviceId);
      params.set("metadata[device_id]", deviceId);
      if (!isOneTimeOtoPass) {
        params.set("subscription_data[metadata][device_id]", deviceId);
      } else {
        params.set("payment_intent_data[metadata][device_id]", deviceId);
      }
    }

    // Reuse existing Stripe Customer on post-checkout OTO so billing history & Billing Portal stay unified
    if (existingCustomerId) {
      params.set("customer", existingCustomerId);
    } else {
      if (effectiveEmail) {
        params.set("customer_email", effectiveEmail);
      }
      if (isOneTimeOtoPass) {
        params.set("customer_creation", "always");
      }
    }
    if (effectiveEmail) {
      params.set("metadata[customer_email]", effectiveEmail);
      if (!isOneTimeOtoPass) {
        params.set("subscription_data[metadata][customer_email]", effectiveEmail);
      } else {
        params.set("payment_intent_data[metadata][customer_email]", effectiveEmail);
      }
    }
    if (!isOneTimeOtoPass && trialDays > 0) {
      params.set("subscription_data[trial_period_days]", String(trialDays));
    }
    if (verifiedCode) {
      params.set("metadata[creator_code]", verifiedCode);
      if (!isOneTimeOtoPass) {
        params.set("subscription_data[metadata][creator_code]", verifiedCode);
      } else {
        params.set("payment_intent_data[metadata][creator_code]", verifiedCode);
      }
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

    if (!isOneTimeOtoPass && typeof session.id === "string" && session.id.trim()) {
      await recordSubscriptionConsent({
        deviceId: deviceId || "anon-web",
        email: effectiveEmail,
        plan,
        termsVersion,
        timestamp: consentTimestamp,
        ip: clientIp,
        sessionId: session.id.trim(),
        customerId: existingCustomerId || undefined,
        otoOffer: otoOffer || undefined,
        recurringPriceUsd,
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
            otoOffer: otoOffer || null,
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
