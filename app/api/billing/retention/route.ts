import { NextResponse } from "next/server";
import {
  evaluateZeroLeakageRetentionEligibility,
  normalizeRealDeviceId,
  recordSubscriptionConsent,
  resolveBillingPortalCustomer,
  updateSubscriptionEntitlement,
} from "@/lib/entitlements";
import { PRICING, TERMS_VERSION } from "@/lib/pricing";
import { checkRateLimitAsync } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-Secret",
};

function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "anon"
  );
}

function captureRetentionPostHog(
  distinctId: string,
  properties: Record<string, string | number | boolean | null>
): void {
  const phKey = (
    process.env.POSTHOG_API_KEY ||
    process.env.NEXT_PUBLIC_POSTHOG_KEY ||
    ""
  ).trim();
  if (!phKey) return;
  const phHost = (process.env.POSTHOG_HOST || "https://us.i.posthog.com").replace(
    /\/+$/,
    ""
  );
  void fetch(`${phHost}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: phKey,
      event: "retention_flow_action",
      distinct_id: distinctId || "anon-web",
      properties: {
        ...properties,
        $lib: "heybroc-server",
      },
      timestamp: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(2500),
  }).catch(() => {});
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * POST /api/billing/retention
 * Body: {
 *   action: "inspect" | "pause_30d" | "switch_to_monthly",
 *   sessionId?: string,
 *   deviceId?: string,
 *   deviceSecret?: string,
 *   email?: string,
 *   agreedToTerms?: boolean,
 *   termsAccepted?: boolean,
 *   termsVersion?: string
 * }
 */
export async function POST(request: Request) {
  const ip = getClientIp(request);
  if (!(await checkRateLimitAsync(`billing-retention:${ip}`, 25))) {
    return NextResponse.json(
      { ok: false, error: "Too many requests. Please try again in a minute." },
      { status: 429, headers: CORS }
    );
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      sessionId?: string;
      session_id?: string;
      deviceId?: string;
      deviceSecret?: string;
      email?: string;
      agreedToTerms?: boolean;
      termsAccepted?: boolean;
      consentAccepted?: boolean;
      termsVersion?: string;
    };

    const action = (body.action || "inspect").trim();
    if (
      action !== "inspect" &&
      action !== "pause_30d" &&
      action !== "switch_to_monthly"
    ) {
      return NextResponse.json(
        { ok: false, error: "Unsupported retention action." },
        { status: 400, headers: CORS }
      );
    }

    const authHeader = request.headers.get("authorization") || "";
    const authToken = /^Bearer\s+/i.test(authHeader)
      ? authHeader.replace(/^Bearer\s+/i, "").trim()
      : undefined;
    const deviceSecret =
      request.headers.get("x-device-secret")?.trim() ||
      body.deviceSecret?.trim() ||
      undefined;
    const candidateDeviceId = normalizeRealDeviceId(body.deviceId);

    const resolved = await resolveBillingPortalCustomer({
      sessionId: body.sessionId || body.session_id,
      deviceId: candidateDeviceId || undefined,
      deviceSecret,
      email: body.email,
      authToken,
    });

    const record = resolved?.record;
    const subId = record?.subscriptionId?.trim() || "";
    const hasManagedStripeSub = Boolean(
      record?.active && subId.startsWith("sub_")
    );

    if (action === "inspect") {
      if (!record || !hasManagedStripeSub) {
        return NextResponse.json(
          {
            ok: true,
            hasManagedStripeSub: false,
          },
          { status: 200, headers: CORS }
        );
      }

      const eligibility = evaluateZeroLeakageRetentionEligibility(record);
      captureRetentionPostHog(
        record.deviceId || candidateDeviceId || record.customerId || "anon-web",
        {
          retentionAction: "inspect",
          plan: record.plan,
          status: record.status,
          canPause30d: eligibility.canPause30d,
          canLoyaltyAnnual39: eligibility.canLoyaltyAnnual39,
          canSwitchToMonthly: eligibility.canSwitchToMonthly,
        }
      );

      return NextResponse.json(
        {
          ok: true,
          hasManagedStripeSub: true,
          plan: record.plan,
          status: record.status,
          sessionId: record.checkoutSessionId || record.sessionId,
          expiresAtMs: record.expiresAtMs ?? null,
          pausedUntilMs: record.pausedUntilMs ?? null,
          eligibility,
        },
        { status: 200, headers: CORS }
      );
    }

    // Mutating actions (`pause_30d` / `switch_to_monthly`) require an active Stripe subscription + STRIPE_SECRET_KEY
    if (!record || !hasManagedStripeSub) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "No active Stripe subscription was found for this account or device.",
        },
        { status: 404, headers: CORS }
      );
    }

    const secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
    if (!secretKey) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Stripe billing management is temporarily unavailable in this environment.",
        },
        { status: 503, headers: CORS }
      );
    }

    const eligibility = evaluateZeroLeakageRetentionEligibility(record);

    if (action === "pause_30d") {
      if (!eligibility.canPause30d) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "30-day billing pause is only available once every 6 months on active paid Monthly memberships.",
          },
          { status: 403, headers: CORS }
        );
      }

      const nowMs = Date.now();
      const resumesAtSec = Math.floor((nowMs + 30 * 86_400_000) / 1000);
      const resumesAtMs = resumesAtSec * 1000;

      const form = new URLSearchParams();
      form.set("pause_collection[behavior]", "void");
      form.set("pause_collection[resumes_at]", String(resumesAtSec));

      const stripeRes = await fetch(
        `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subId)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secretKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
        }
      );

      const stripeData = (await stripeRes.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      if (!stripeRes.ok) {
        return NextResponse.json(
          {
            ok: false,
            error:
              stripeData.error?.message ||
              "Unable to pause subscription right now. You can also manage or cancel directly in the Stripe Billing Portal.",
          },
          { status: 502, headers: CORS }
        );
      }

      await updateSubscriptionEntitlement(subId, {
        status: record.status,
        pausedUntilMs: resumesAtMs,
        lastRetentionPauseAtMs: nowMs,
        expiresAtMs: Math.max(record.expiresAtMs || 0, resumesAtMs),
      });

      captureRetentionPostHog(
        record.deviceId || candidateDeviceId || record.customerId || "anon-web",
        {
          retentionAction: "pause_30d",
          plan: record.plan,
          pausedUntilMs: resumesAtMs,
        }
      );

      return NextResponse.json(
        {
          ok: true,
          action: "pause_30d",
          pausedUntilMs: resumesAtMs,
        },
        { status: 200, headers: CORS }
      );
    }

    // action === "switch_to_monthly"
    const hasExpressConsent =
      body.agreedToTerms === true ||
      body.termsAccepted === true ||
      body.consentAccepted === true;
    if (!hasExpressConsent) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Please check the box to confirm the $9.99/month automatic renewal terms before switching plans.",
        },
        { status: 400, headers: CORS }
      );
    }

    const suppliedTermsVersion =
      typeof body.termsVersion === "string" ? body.termsVersion.trim() : "";
    if (!suppliedTermsVersion || suppliedTermsVersion !== TERMS_VERSION) {
      return NextResponse.json(
        {
          ok: false,
          error: `Outdated or missing Terms of Service version. Expected ${TERMS_VERSION}.`,
        },
        { status: 400, headers: CORS }
      );
    }

    if (!eligibility.canSwitchToMonthly) {
      return NextResponse.json(
        {
          ok: false,
          error: "Your membership is already on a Monthly billing plan.",
        },
        { status: 400, headers: CORS }
      );
    }

    const getSubRes = await fetch(
      `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${secretKey}` },
        cache: "no-store",
      }
    );
    if (!getSubRes.ok) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Unable to load subscription details from Stripe. Please use the Stripe Billing Portal link below.",
        },
        { status: 502, headers: CORS }
      );
    }

    const currentSub = (await getSubRes.json()) as {
      trial_end?: number | null;
      current_period_end?: number | null;
      items?: {
        data?: Array<{
          id?: string;
          current_period_end?: number | null;
          price?: { product?: string | { id?: string } };
          plan?: { product?: string | { id?: string } };
        }>;
      };
    };

    const firstItem = currentSub.items?.data?.[0];
    const itemId = firstItem?.id?.trim() || "";
    const rawProd =
      firstItem?.price?.product ?? firstItem?.plan?.product ?? "";
    const productId =
      typeof rawProd === "string"
        ? rawProd.trim()
        : typeof rawProd?.id === "string"
          ? rawProd.id.trim()
          : "";

    if (!itemId || !productId) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Subscription line item could not be updated automatically. Please use the Stripe Billing Portal link below.",
        },
        { status: 502, headers: CORS }
      );
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const trialEndSec =
      typeof currentSub.trial_end === "number" && currentSub.trial_end > 0
        ? currentSub.trial_end
        : 0;
    const periodEndSec = Math.max(
      typeof currentSub.current_period_end === "number"
        ? currentSub.current_period_end
        : 0,
      typeof firstItem?.current_period_end === "number"
        ? firstItem.current_period_end
        : 0,
      record.expiresAtMs ? Math.floor(record.expiresAtMs / 1000) : 0
    );
    const preserveUntilSec = Math.max(trialEndSec, periodEndSec);

    const updateForm = new URLSearchParams();
    updateForm.set("items[0][id]", itemId);
    updateForm.set("items[0][price_data][currency]", "usd");
    updateForm.set("items[0][price_data][product]", productId);
    updateForm.set(
      "items[0][price_data][unit_amount]",
      String(Math.round(PRICING.monthly * 100))
    );
    updateForm.set("items[0][price_data][recurring][interval]", "month");
    updateForm.set("proration_behavior", "none");
    updateForm.set("metadata[plan]", "monthly");
    updateForm.set("metadata[retention_source]", "cancel_flow");
    // Prevent Stripe from resetting billing_cycle_anchor to `now` when switching interval (`year` -> `month`),
    // preserving the customer's remaining free trial OR already-paid annual period ($0 charged today).
    if (preserveUntilSec > nowSec + 60) {
      updateForm.set("trial_end", String(preserveUntilSec));
      updateForm.set("metadata[trial_end_sec]", String(preserveUntilSec));
    }

    const updateRes = await fetch(
      `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subId)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: updateForm.toString(),
      }
    );

    const updateData = (await updateRes.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    if (!updateRes.ok) {
      return NextResponse.json(
        {
          ok: false,
          error:
            updateData.error?.message ||
            "Unable to switch plan automatically. Please use the Stripe Billing Portal link below.",
        },
        { status: 502, headers: CORS }
      );
    }

    await updateSubscriptionEntitlement(subId, {
      status: record.status,
      plan: "monthly",
      ...(preserveUntilSec > nowSec
        ? { expiresAtMs: preserveUntilSec * 1000 }
        : {}),
    });

    await recordSubscriptionConsent({
      deviceId: record.deviceId || candidateDeviceId || `sub_${subId}`,
      email: record.customerEmail || body.email?.trim().toLowerCase() || "[unknown]",
      plan: "monthly",
      termsVersion: TERMS_VERSION,
      timestamp: new Date().toISOString(),
      ip,
      sessionId: record.checkoutSessionId || record.sessionId,
      customerId: resolved?.customerId || record.customerId,
      subscriptionId: subId,
      recurringPriceUsd: PRICING.monthly,
    });

    captureRetentionPostHog(
      record.deviceId || candidateDeviceId || record.customerId || "anon-web",
      {
        retentionAction: "switch_to_monthly",
        previousPlan: record.plan,
        newPlan: "monthly",
      }
    );

    return NextResponse.json(
      {
        ok: true,
        action: "switch_to_monthly",
        plan: "monthly",
        renewsAtMs: preserveUntilSec > nowSec ? preserveUntilSec * 1000 : null,
      },
      { status: 200, headers: CORS }
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request payload." },
      { status: 400, headers: CORS }
    );
  }
}
