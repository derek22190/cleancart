import { NextRequest, NextResponse } from "next/server";
import { PRICING, type PlanId } from "@/lib/pricing";

const ALLOWED_ORIGINS = new Set([
  "https://heybroc.com",
  "https://www.heybroc.com",
  "https://cleancart-teal.vercel.app",
  "http://localhost:3000",
]);

/**
 * POST /api/checkout
 * Body: { plan: "annual" | "monthly", creatorCode?: string, origin?: string }
 *
 * - If STRIPE_SECRET_KEY is configured in environment variables (Vercel), creates a live
 *   Stripe Checkout Session with Apple Pay / Google Pay / Card and automatic 3-day (or 7-day creator)
 *   free trial, returning { ok: true, mode: "stripe", url: session.url }.
 * - If STRIPE_SECRET_KEY is not configured yet, returns { ok: true, mode: "preview" } so the UI
 *   unlocks Family Pro immediately in preview mode.
 */
export async function POST(req: NextRequest) {
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "Body must be a JSON object." }, { status: 400 });
    }
    const body = parsed as Record<string, unknown>;
    const plan: PlanId = body.plan === "monthly" ? "monthly" : "annual";
    const creatorCode = typeof body.creatorCode === "string" ? body.creatorCode.trim().toUpperCase() : "";
    const candidateOrigin = (typeof body.origin === "string" ? body.origin : req.headers.get("origin"))?.replace(/\/+$/, "") || "";
    const origin = ALLOWED_ORIGINS.has(candidateOrigin) ? candidateOrigin : "https://heybroc.com";

    const stripeKey = process.env.STRIPE_SECRET_KEY?.trim();
    if (!stripeKey) {
      if (process.env.ALLOW_PREVIEW_CHECKOUT === "true") {
        return NextResponse.json({
          ok: true,
          mode: "preview",
          plan,
          trialDays: plan === "annual" ? (creatorCode ? PRICING.creatorTrialDays : PRICING.trialDays) : 0,
        });
      }
      return NextResponse.json(
        { ok: false, mode: "unconfigured", error: "Stripe checkout is not configured on this server." },
        { status: 503 },
      );
    }

    const trialDays = plan === "annual" ? (creatorCode ? PRICING.creatorTrialDays : PRICING.trialDays) : 0;
    const unitAmountCents = plan === "annual" ? Math.round(PRICING.annual * 100) : Math.round(PRICING.monthly * 100);
    const interval = plan === "annual" ? "year" : "month";

    const params = new URLSearchParams();
    params.set("mode", "subscription");
    params.set("success_url", `${origin}/?pro=1&session_id={CHECKOUT_SESSION_ID}&plan=${plan}${creatorCode ? `&code=${encodeURIComponent(creatorCode)}` : ""}`);
    params.set("cancel_url", `${origin}/?checkout=cancelled`);
    params.set("line_items[0][price_data][currency]", "usd");
    params.set("line_items[0][price_data][unit_amount]", String(unitAmountCents));
    params.set("line_items[0][price_data][recurring][interval]", interval);
    params.set(
      "line_items[0][price_data][product_data][name]",
      plan === "annual" ? "HeyBroc Family Pro (Annual)" : "HeyBroc Family Pro (Monthly)",
    );
    params.set(
      "line_items[0][price_data][product_data][description]",
      "Unlimited live store overlays across 12 grocery apps, 1-tap clean swaps & whole-cart health checks.",
    );
    params.set("line_items[0][quantity]", "1");

    if (trialDays > 0) {
      params.set("subscription_data[trial_period_days]", String(trialDays));
    }
    if (creatorCode) {
      params.set("metadata[creator_code]", creatorCode);
      params.set("subscription_data[metadata][creator_code]", creatorCode);
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
        { status: 400 },
      );
    }

    return NextResponse.json({
      ok: true,
      mode: "stripe",
      url: session.url,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Checkout error" },
      { status: 500 },
    );
  }
}
