import { NextResponse } from "next/server";
import { isAdminAuthorized } from "@/lib/admin-auth";
import { getAuthenticatedUser, type UserAccount } from "@/lib/auth";
import {
  createCreator,
  createCreatorAccessToken,
  createStripeConnectOnboardingLink,
  deleteCreator,
  executeCreatorPayout,
  generateCreatorTokenNonce,
  getCreator,
  listCreatorPayouts,
  listCreators,
  resetStats,
  totals,
  trackEvent,
  updateCreator,
  verifyCreatorAccessToken,
  type Creator,
  type CreatorEvent,
  type CreatorPayoutMethod,
} from "@/lib/influencers";
import { PRICING, commissionFor } from "@/lib/pricing";
import { checkRateLimitAsync } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Creator-Token",
};

const ALLOWED_ORIGINS = new Set([
  "https://heybroc.com",
  "https://www.heybroc.com",
  "https://cleancart.vercel.app",
  "https://cleancart-teal.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function resolveAllowedOrigin(raw?: string | null): string {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (configured && /^https?:\/\//i.test(configured)) {
    ALLOWED_ORIGINS.add(configured);
  }
  const clean = (raw || "").trim().replace(/\/+$/, "");
  if (clean && ALLOWED_ORIGINS.has(clean)) return clean;
  return configured && /^https?:\/\//i.test(configured)
    ? configured
    : "https://heybroc.com";
}

function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "anon"
  );
}

function normalizeValidEmail(raw?: string | null): string {
  if (!raw) return "";
  const clean = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean) ? clean : "";
}

async function resolveSessionUser(request: Request): Promise<UserAccount | null> {
  const authHeader = request.headers.get("authorization") || "";
  if (!/^Bearer\s+/i.test(authHeader)) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith("hb_")) return null;
  return getAuthenticatedUser(token).catch(() => null);
}

async function resolveAuthenticatedCreatorEmail(
  request: Request,
  preloadedUser?: UserAccount | null
): Promise<string | null> {
  const user =
    preloadedUser !== undefined ? preloadedUser : await resolveSessionUser(request);
  if (!user || user.emailVerified !== true) return null;
  const norm = normalizeValidEmail(user.email);
  return norm || null;
}

function isSessionVerifiedCreatorOwner(
  sessionUser: UserAccount | null,
  creator?: Pick<Creator, "payoutEmail"> | string | null
): boolean {
  if (!sessionUser || sessionUser.emailVerified !== true) return false;
  const rawEmail =
    typeof creator === "string" ? creator : creator?.payoutEmail || "";
  const targetEmail = normalizeValidEmail(rawEmail);
  if (!targetEmail) return false;
  return normalizeValidEmail(sessionUser.email) === targetEmail;
}

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
 *                                    or full creator stats + payouts when X-Creator-Token, verified Bearer session, or admin auth is supplied.
 */
export async function GET(request: Request) {
  const ip = getClientIp(request);
  if (!(await checkRateLimitAsync(`inf-get:${ip}`, 60))) {
    return NextResponse.json(
      { ok: false, error: "Too many requests." },
      { status: 429, headers: CORS }
    );
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const isAdmin = isAdminAuthorized(request);

  if (code) {
    let c = await getCreator(code);
    const creatorToken =
      request.headers.get("x-creator-token")?.trim() ||
      url.searchParams.get("token")?.trim() ||
      "";
    const sessionUser = !isAdmin ? await resolveSessionUser(request) : null;
    const isVerifiedSession = Boolean(
      c && isSessionVerifiedCreatorOwner(sessionUser, c)
    );
    if (c && isVerifiedSession && c.payoutEmailVerified !== true) {
      c = await updateCreator(c.code, {
        payoutEmailVerified: true,
        rotateTokenNonce: true,
      });
    }
    const isValidToken = Boolean(
      c &&
        verifyCreatorAccessToken(c.code, creatorToken, c) &&
        (c.payoutEmailVerified === true ||
          (c.payoutEmailVerified !== false && Boolean(c.payoutEmail)) ||
          (c.grossRevenue === 0 &&
            c.commissionEarned === 0 &&
            c.commissionPaid === 0))
    );
    const isOwner = isVerifiedSession || isValidToken;

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
          ...(isVerifiedSession
            ? { creatorToken: createCreatorAccessToken(c.code, c) }
            : {}),
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

  const ip = getClientIp(request);
  const isAdmin = isAdminAuthorized(request);
  const sessionUser = !isAdmin ? await resolveSessionUser(request) : null;
  const authedCreatorEmail = !isAdmin
    ? await resolveAuthenticatedCreatorEmail(request, sessionUser)
    : null;
  const suppliedCreatorToken =
    body.creatorToken?.trim() ||
    request.headers.get("x-creator-token")?.trim() ||
    "";

  const targetCreatorForSelfAction =
    !isAdmin &&
    body.code &&
    (body.action === "update_payout_settings" || body.action === "connect_stripe")
      ? await getCreator(body.code)
      : null;

  const isVerifiedSessionOwnerForCode = isSessionVerifiedCreatorOwner(
    sessionUser,
    targetCreatorForSelfAction
  );
  const isVerifiedTokenOwnerForCode = Boolean(
    targetCreatorForSelfAction &&
      targetCreatorForSelfAction.payoutEmail &&
      targetCreatorForSelfAction.payoutEmailVerified !== false &&
      verifyCreatorAccessToken(
        targetCreatorForSelfAction.code,
        suppliedCreatorToken,
        targetCreatorForSelfAction
      )
  );
  const isOwnerForCode =
    isVerifiedSessionOwnerForCode || isVerifiedTokenOwnerForCode;

  const isPublicClickTrack = body.action === "track" && body.event === "click";
  const isSelfRegister = body.action === "self_register";
  const isCreatorSelfAction =
    (body.action === "update_payout_settings" ||
      body.action === "connect_stripe") &&
    isOwnerForCode;

  if (!isAdmin && !isPublicClickTrack && !isSelfRegister && !isCreatorSelfAction) {
    if (
      (body.action === "update_payout_settings" ||
        body.action === "connect_stripe") &&
      targetCreatorForSelfAction &&
      targetCreatorForSelfAction.payoutEmailVerified === false
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Please sign in and verify your payout email address before updating payout settings or connecting Stripe.",
        },
        { status: 401, headers: CORS }
      );
    }
    return NextResponse.json(
      { ok: false, error: "Unauthorized." },
      { status: 401, headers: CORS }
    );
  }

  try {
    if (isSelfRegister) {
      if (!isAdmin && !(await checkRateLimitAsync(`inf-selfreg:${ip}`, 10))) {
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

      const normalizedPayoutEmail = normalizeValidEmail(body.payoutEmail);
      const existing = await getCreator(rawCode);
      if (existing) {
        const isExistingSessionOwner = isSessionVerifiedCreatorOwner(
          sessionUser,
          existing
        );
        const isExistingVerifiedTokenOwner = Boolean(
          existing.payoutEmail &&
            existing.payoutEmailVerified !== false &&
            verifyCreatorAccessToken(existing.code, suppliedCreatorToken, existing)
        );
        const canUpdateExisting =
          isAdmin || isExistingSessionOwner || isExistingVerifiedTokenOwner;

        if (canUpdateExisting) {
          const nextEmail =
            body.payoutEmail !== undefined
              ? normalizedPayoutEmail
              : existing.payoutEmail || "";
          const nextVerified = isAdmin
            ? Boolean(nextEmail)
            : nextEmail
              ? Boolean(authedCreatorEmail && authedCreatorEmail === nextEmail) ||
                (body.payoutEmail === undefined &&
                  existing.payoutEmailVerified === true)
              : false;
          const updated = await updateCreator(existing.code, {
            name: body.name?.trim() || undefined,
            payoutEmail: body.payoutEmail,
            payoutEmailVerified: nextVerified,
            payoutMethod: body.payoutMethod,
            payoutHandle: body.payoutHandle,
            ...(isExistingSessionOwner && existing.payoutEmailVerified !== true
              ? { rotateTokenNonce: true }
              : {}),
          });
          const payouts = await listCreatorPayouts(existing.code);
          return NextResponse.json(
            {
              ok: true,
              alreadyExisted: true,
              creator: updated,
              payouts,
              creatorToken: createCreatorAccessToken(updated.code, updated),
            },
            { headers: CORS }
          );
        }

        return NextResponse.json(
          {
            ok: false,
            alreadyExisted: true,
            error:
              "That creator code is already claimed. Sign in with your verified payout email to update payout settings.",
          },
          { status: 409, headers: CORS }
        );
      }

      const cleanName = (body.name || rawCode).trim().slice(0, 60) || rawCode;
      const payoutEmailVerified = isAdmin
        ? Boolean(normalizedPayoutEmail)
        : Boolean(
            authedCreatorEmail &&
              normalizedPayoutEmail &&
              authedCreatorEmail === normalizedPayoutEmail
          );
      const created = await createCreator({
        code: rawCode,
        name: cleanName,
        commissionPct: PRICING.defaultCommissionPct,
        payoutEmail: body.payoutEmail,
        payoutEmailVerified,
        payoutMethod: body.payoutMethod,
        payoutHandle: body.payoutHandle,
        tokenNonce: generateCreatorTokenNonce(),
      });
      return NextResponse.json(
        {
          ok: true,
          alreadyExisted: false,
          creator: created,
          payouts: [],
          creatorToken: createCreatorAccessToken(created.code, created),
        },
        { headers: CORS }
      );
    }

    if (body.action === "update_payout_settings" && (isAdmin || isOwnerForCode)) {
      if (!isAdmin && !(await checkRateLimitAsync(`inf-payout-cfg:${ip}`, 20))) {
        return NextResponse.json(
          { ok: false, error: "Too many requests. Please wait a minute." },
          { status: 429, headers: CORS }
        );
      }
      const existingTarget =
        targetCreatorForSelfAction ?? (await getCreator(body.code || ""));
      const requestedEmail =
        body.payoutEmail !== undefined
          ? normalizeValidEmail(body.payoutEmail)
          : existingTarget?.payoutEmail || "";
      const nextPayoutEmailVerified = isAdmin
        ? requestedEmail
          ? true
          : false
        : requestedEmail
          ? Boolean(
              authedCreatorEmail && authedCreatorEmail === requestedEmail
            ) ||
            (body.payoutEmail === undefined &&
              existingTarget?.payoutEmailVerified === true)
          : false;
      const shouldRotateOnClaim = Boolean(
        isVerifiedSessionOwnerForCode &&
          existingTarget?.payoutEmailVerified !== true
      );

      const updated = await updateCreator(body.code || "", {
        name: body.name,
        payoutEmail: body.payoutEmail,
        payoutEmailVerified: nextPayoutEmailVerified,
        payoutMethod: body.payoutMethod,
        payoutHandle: body.payoutHandle,
        ...(shouldRotateOnClaim ? { rotateTokenNonce: true } : {}),
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
        {
          ok: true,
          creator: updated,
          payouts,
          creatorToken: createCreatorAccessToken(updated.code, updated),
        },
        { headers: CORS }
      );
    }

    if (body.action === "connect_stripe" && (isAdmin || isOwnerForCode)) {
      if (!isAdmin && !(await checkRateLimitAsync(`inf-connect:${ip}`, 10))) {
        return NextResponse.json(
          { ok: false, error: "Too many onboarding attempts. Please wait a minute." },
          { status: 429, headers: CORS }
        );
      }
      if (
        !isAdmin &&
        isVerifiedSessionOwnerForCode &&
        targetCreatorForSelfAction &&
        targetCreatorForSelfAction.payoutEmailVerified !== true
      ) {
        await updateCreator(targetCreatorForSelfAction.code, {
          payoutEmailVerified: true,
          rotateTokenNonce: true,
        });
      }
      const candidateOrigin =
        body.origin?.trim() || request.headers.get("origin")?.trim() || "";
      const origin = resolveAllowedOrigin(candidateOrigin);
      const connectEmail = isAdmin
        ? body.payoutEmail
        : targetCreatorForSelfAction?.payoutEmail;
      const onboarding = await createStripeConnectOnboardingLink({
        code: body.code || "",
        email: connectEmail,
        origin,
      });
      return NextResponse.json(onboarding, { headers: CORS });
    }

    if (!isAdmin && isPublicClickTrack) {
      if (!(await checkRateLimitAsync(`inf-click:${ip}`, 20))) {
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
