import { NextResponse } from "next/server";
import { isAdminAuthorized } from "@/lib/admin-auth";
import {
  createCreator,
  createCreatorAccessToken,
  createStripeConnectOnboardingLink,
  deleteCreator,
  executeCreatorPayout,
  getCreator,
  listCreatorPayouts,
  listCreators,
  resetStats,
  totals,
  trackEvent,
  updateCreator,
  verifyCreatorAccessToken,
  type CreatorEvent,
  type CreatorPayoutMethod,
} from "@/lib/influencers";
import { PRICING, commissionFor } from "@/lib/pricing";
import { checkRateLimit } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Creator-Token",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

async function snapshot() {
  const [creators, recentPayouts] = await Promise.all([
    listCreators(),
    listCreatorPayouts(),
  ]);
  return {
    ok: true,
    pricing: {
      ...PRICING,
      annualCommissionAtDefault: commissionFor(
        "annual",
        PRICING.defaultCommissionPct
      ),
    },
    creators,
    totals: totals(creators),
    recentPayouts,
  };
}

/**
 * GET /api/influencers            -> all creators + totals + payouts (requires admin auth)
 * GET /api/influencers?code=XYZ   -> validate a creator code on the paywall (public safe summary),
 *                                    or full creator stats + payouts when X-Creator-Token / admin auth is supplied.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const isAdmin = isAdminAuthorized(request);

  if (code) {
    const c = await getCreator(code);
    const creatorToken =
      request.headers.get("x-creator-token")?.trim() ||
      url.searchParams.get("token")?.trim() ||
      "";
    const isOwner = Boolean(c && verifyCreatorAccessToken(c.code, creatorToken));

    if (!c || (!c.active && !isAdmin && !isOwner)) {
      return NextResponse.json(
        { ok: false, error: "Invalid creator code." },
        { status: 404, headers: CORS }
      );
    }

    if (isAdmin || isOwner) {
      const payouts = await listCreatorPayouts(c.code);
      return NextResponse.json(
        {
          ok: true,
          authenticated: true,
          creator: c,
          payouts,
        },
        { status: 200, headers: CORS }
      );
    }

    // Public paywall / referral-link validation: never expose private creator revenue or conversion counts
    return NextResponse.json(
      {
        ok: true,
        authenticated: false,
        creator: {
          code: c.code,
          name: c.name,
          active: c.active,
          commissionPct: c.commissionPct,
        },
      },
      { status: 200, headers: CORS }
    );
  }

  if (!isAdmin) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized." },
      { status: 401, headers: CORS }
    );
  }
  return NextResponse.json(await snapshot(), { headers: CORS });
}

interface InfluencerPostBody {
  action?: string;
  code?: string;
  name?: string;
  commissionPct?: number;
  active?: boolean;
  event?: CreatorEvent;
  payoutEmail?: string;
  payoutMethod?: CreatorPayoutMethod;
  payoutHandle?: string;
  stripeConnectAccountId?: string;
  creatorToken?: string;
  amount?: number;
  executeStripeTransfer?: boolean;
  destination?: string;
  note?: string;
  idempotencyKey?: string;
  origin?: string;
}

/**
 * POST actions:
 *  Public / Creator Self-Serve:
 *   { action: "track", code, event: "click" } -> increments click on existing active creator only
 *   { action: "self_register", code, name?, payoutEmail?, payoutMethod?, payoutHandle? }
 *   { action: "update_payout_settings", code, creatorToken, payoutEmail?, payoutMethod?, payoutHandle?, name? }
 *   { action: "connect_stripe", code, creatorToken, payoutEmail?, origin? }
 *  Admin (requires Bearer HEYBROC_ADMIN_SECRET):
 *   { action: "create", code, name?, commissionPct?, payoutEmail?, payoutMethod?, payoutHandle? }
 *   { action: "update", code, commissionPct?, name?, active?, payoutEmail?, payoutMethod?, payoutHandle?, stripeConnectAccountId? }
 *   { action: "payout", code, amount?, payoutMethod?, executeStripeTransfer?, destination?, note? }
 *   { action: "delete", code }
 *   { action: "track",  code, event }
 *   { action: "reset" }
 */
export async function POST(request: Request) {
  let body: InfluencerPostBody;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json(
        { ok: false, error: "Body must be a JSON object." },
        { status: 400, headers: CORS }
      );
    }
    body = parsed as InfluencerPostBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Body must be valid JSON." },
      { status: 400, headers: CORS }
    );
  }

  const isAdmin = isAdminAuthorized(request);
  const suppliedCreatorToken =
    body.creatorToken?.trim() ||
    request.headers.get("x-creator-token")?.trim() ||
    "";
  const isOwnerForCode = Boolean(
    body.code && verifyCreatorAccessToken(body.code, suppliedCreatorToken)
  );
  const isPublicClickTrack = body.action === "track" && body.event === "click";
  const isSelfRegister = body.action === "self_register";
  const isCreatorSelfAction =
    (body.action === "update_payout_settings" ||
      body.action === "connect_stripe") &&
    isOwnerForCode;

  if (!isAdmin && !isPublicClickTrack && !isSelfRegister && !isCreatorSelfAction) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized." },
      { status: 401, headers: CORS }
    );
  }

  try {
    if (!isAdmin && isSelfRegister) {
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        request.headers.get("x-real-ip") ||
        "anon";
      if (!checkRateLimit(`inf-selfreg:${ip}`, 10)) {
        return NextResponse.json(
          { ok: false, error: "Too many attempts. Please wait a minute." },
          { status: 429, headers: CORS }
        );
      }
      const rawCode = (body.code || "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, "")
        .slice(0, 24);
      if (rawCode.length < 3) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Choose a code with at least 3 letters or numbers (e.g. SARAHHAULS).",
          },
          { status: 400, headers: CORS }
        );
      }
      if (rawCode.startsWith("BROC")) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Codes starting with BROC are reserved for friend invite codes. Choose your own creator handle (e.g. SARAHHAULS).",
          },
          { status: 400, headers: CORS }
        );
      }

      const existing = await getCreator(rawCode);
      if (existing) {
        const emailMatches = Boolean(
          existing.payoutEmail &&
            body.payoutEmail &&
            existing.payoutEmail.toLowerCase() ===
              body.payoutEmail.trim().toLowerCase()
        );
        if (verifyCreatorAccessToken(existing.code, suppliedCreatorToken) || emailMatches) {
          const updated = await updateCreator(existing.code, {
            name: body.name?.trim() || undefined,
            payoutEmail: body.payoutEmail,
            payoutMethod: body.payoutMethod,
            payoutHandle: body.payoutHandle,
          });
          const payouts = await listCreatorPayouts(existing.code);
          return NextResponse.json(
            {
              ok: true,
              alreadyExisted: true,
              creator: updated,
              payouts,
              creatorToken: createCreatorAccessToken(existing.code),
            },
            { headers: CORS }
          );
        }

        return NextResponse.json(
          {
            ok: false,
            alreadyExisted: true,
            error: existing.payoutEmail
              ? `Code ${rawCode} is already registered. Enter your registered payout email to unlock your creator dashboard, or choose a new code.`
              : `Code ${rawCode} is already claimed by another creator. Please choose your own unique code (e.g. ${rawCode}26).`,
          },
          { status: 409, headers: CORS }
        );
      }

      const cleanName = (body.name || rawCode).trim().slice(0, 60) || rawCode;
      const created = await createCreator({
        code: rawCode,
        name: cleanName,
        commissionPct: PRICING.defaultCommissionPct,
        payoutEmail: body.payoutEmail,
        payoutMethod: body.payoutMethod,
        payoutHandle: body.payoutHandle,
      });
      return NextResponse.json(
        {
          ok: true,
          alreadyExisted: false,
          creator: created,
          payouts: [],
          creatorToken: createCreatorAccessToken(created.code),
        },
        { headers: CORS }
      );
    }

    if (body.action === "update_payout_settings" && (isAdmin || isOwnerForCode)) {
      const updated = await updateCreator(body.code || "", {
        name: body.name,
        payoutEmail: body.payoutEmail,
        payoutMethod: body.payoutMethod,
        payoutHandle: body.payoutHandle,
        ...(isAdmin
          ? {
              stripeConnectAccountId: body.stripeConnectAccountId,
              active: body.active,
              commissionPct: body.commissionPct,
            }
          : {}),
      });
      const payouts = await listCreatorPayouts(updated.code);
      return NextResponse.json(
        { ok: true, creator: updated, payouts },
        { headers: CORS }
      );
    }

    if (body.action === "connect_stripe" && (isAdmin || isOwnerForCode)) {
      const origin =
        body.origin?.trim() ||
        request.headers.get("origin")?.trim() ||
        process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
        "https://heybroc.com";
      const onboarding = await createStripeConnectOnboardingLink({
        code: body.code || "",
        email: body.payoutEmail,
        origin,
      });
      return NextResponse.json(onboarding, { headers: CORS });
    }

    if (!isAdmin && isPublicClickTrack) {
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        request.headers.get("x-real-ip") ||
        "anon";
      if (!checkRateLimit(`inf-click:${ip}`, 20)) {
        return NextResponse.json(
          { ok: false, error: "Too many requests." },
          { status: 429, headers: CORS }
        );
      }
      const c = await trackEvent(body.code || "", "click");
      return NextResponse.json(
        { ok: true, creator: { code: c.code, name: c.name } },
        { headers: CORS }
      );
    }

    let activeCreator = null;
    let latestPayout = null;
    switch (body.action) {
      case "create":
        activeCreator = await createCreator({
          code: body.code || "",
          name: body.name,
          commissionPct: body.commissionPct,
          payoutEmail: body.payoutEmail,
          payoutMethod: body.payoutMethod,
          payoutHandle: body.payoutHandle,
          stripeConnectAccountId: body.stripeConnectAccountId,
          active: body.active,
        });
        break;
      case "update":
        activeCreator = await updateCreator(body.code || "", {
          commissionPct: body.commissionPct,
          name: body.name,
          active: body.active,
          payoutEmail: body.payoutEmail,
          payoutMethod: body.payoutMethod,
          payoutHandle: body.payoutHandle,
          stripeConnectAccountId: body.stripeConnectAccountId,
        });
        break;
      case "payout": {
        const res = await executeCreatorPayout({
          code: body.code || "",
          amount: body.amount,
          method: body.payoutMethod,
          executeStripeTransfer: body.executeStripeTransfer,
          destination: body.destination,
          note: body.note,
          idempotencyKey: body.idempotencyKey,
        });
        activeCreator = res.creator;
        latestPayout = res.payout;
        break;
      }
      case "delete":
        await deleteCreator(body.code || "");
        break;
      case "track":
        if (
          !body.event ||
          ![
            "click",
            "trial",
            "paid_annual",
            "paid_monthly",
            "checkout_annual",
          ].includes(body.event)
        ) {
          throw new Error("Invalid event.");
        }
        activeCreator = await trackEvent(body.code || "", body.event);
        break;
      case "reset":
        await resetStats();
        break;
      default:
        throw new Error("Unknown action.");
    }
    return NextResponse.json(
      {
        ...(await snapshot()),
        creator: activeCreator,
        ...(latestPayout ? { payout: latestPayout } : {}),
      },
      { headers: CORS }
    );
  } catch (e) {
    const msg = (e as Error).message;
    const status = /invalid creator code|unknown creator code/i.test(msg)
      ? 404
      : 400;
    return NextResponse.json({ ok: false, error: msg }, { status, headers: CORS });
  }
}
