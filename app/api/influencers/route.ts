import { NextResponse } from "next/server";
import { isAdminAuthorized } from "@/lib/admin-auth";
import {
  createCreator,
  deleteCreator,
  getCreator,
  listCreators,
  resetStats,
  totals,
  trackEvent,
  updateCreator,
  type CreatorEvent,
} from "@/lib/influencers";
import { PRICING, commissionFor } from "@/lib/pricing";
import { checkRateLimit } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

async function snapshot() {
  const creators = await listCreators();
  return {
    ok: true,
    pricing: { ...PRICING, annualCommissionAtDefault: commissionFor("annual", PRICING.defaultCommissionPct) },
    creators,
    totals: totals(creators),
  };
}

/**
 * GET /api/influencers            -> all creators + totals (requires admin auth)
 * GET /api/influencers?code=XYZ   -> validate a creator code on the paywall (never auto-creates)
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (code) {
    const c = await getCreator(code);
    if (!c) {
      return NextResponse.json({ ok: false, error: "Invalid creator code." }, { status: 404, headers: CORS });
    }
    return NextResponse.json(
      {
        ok: true,
        creator: {
          code: c.code,
          name: c.name,
          commissionPct: c.commissionPct,
          clicks: c.clicks,
          trials: c.trials,
          paidAnnual: c.paidAnnual,
          paidMonthly: c.paidMonthly,
          commissionOwed: c.commissionOwed,
        },
      },
      { status: 200, headers: CORS },
    );
  }
  if (!isAdminAuthorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401, headers: CORS });
  }
  return NextResponse.json(await snapshot(), { headers: CORS });
}

/**
 * POST actions:
 *  Public (unauthenticated):
 *   { action: "track", code, event: "click" } -> increments click on existing creator only, returns { ok, creator: { code, name } }
 *   { action: "self_register", code, name? }  -> creates a new creator at default 35% commission (never overwrites existing creators)
 *  Admin (requires Bearer HEYBROC_ADMIN_SECRET):
 *   { action: "create", code, name?, commissionPct? }
 *   { action: "update", code, commissionPct?, name? }
 *   { action: "delete", code }
 *   { action: "track",  code, event }
 *   { action: "reset" }
 */
export async function POST(request: Request) {
  let body: { action?: string; code?: string; name?: string; commissionPct?: number; event?: CreatorEvent };
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "Body must be a JSON object." }, { status: 400, headers: CORS });
    }
    body = parsed;
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be valid JSON." }, { status: 400, headers: CORS });
  }

  const isAdmin = isAdminAuthorized(request);
  const isPublicClickTrack = body.action === "track" && body.event === "click";
  const isSelfRegister = body.action === "self_register";

  if (!isAdmin && !isPublicClickTrack && !isSelfRegister) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401, headers: CORS });
  }

  try {
    if (!isAdmin && isSelfRegister) {
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        request.headers.get("x-real-ip") ||
        "anon";
      if (!checkRateLimit(`inf-selfreg:${ip}`, 10)) {
        return NextResponse.json({ ok: false, error: "Too many attempts. Please wait a minute." }, { status: 429, headers: CORS });
      }
      const rawCode = (body.code || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 24);
      if (rawCode.length < 3) {
        return NextResponse.json(
          { ok: false, error: "Choose a code with at least 3 letters or numbers (e.g. SARAHHAULS)." },
          { status: 400, headers: CORS },
        );
      }
      if (rawCode.startsWith("BROC")) {
        return NextResponse.json(
          {
            ok: false,
            error: "Codes starting with BROC are reserved for friend invite codes. Choose your own creator handle (e.g. SARAHHAULS).",
          },
          { status: 400, headers: CORS },
        );
      }
      const existing = await getCreator(rawCode);
      if (existing) {
        return NextResponse.json(
          { ok: true, alreadyExisted: true, creator: existing },
          { headers: CORS },
        );
      }
      const cleanName = (body.name || rawCode).trim().slice(0, 60) || rawCode;
      const created = await createCreator({
        code: rawCode,
        name: cleanName,
        commissionPct: PRICING.defaultCommissionPct,
      });
      return NextResponse.json(
        { ok: true, alreadyExisted: false, creator: created },
        { headers: CORS },
      );
    }

    if (!isAdmin && isPublicClickTrack) {
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        request.headers.get("x-real-ip") ||
        "anon";
      if (!checkRateLimit(`inf-click:${ip}`, 20)) {
        return NextResponse.json({ ok: false, error: "Too many requests." }, { status: 429, headers: CORS });
      }
      const c = await trackEvent(body.code || "", "click");
      return NextResponse.json(
        { ok: true, creator: { code: c.code, name: c.name } },
        { headers: CORS },
      );
    }

    let activeCreator = null;
    switch (body.action) {
      case "create":
        activeCreator = await createCreator({ code: body.code || "", name: body.name, commissionPct: body.commissionPct });
        break;
      case "update":
        activeCreator = await updateCreator(body.code || "", { commissionPct: body.commissionPct, name: body.name });
        break;
      case "delete":
        await deleteCreator(body.code || "");
        break;
      case "track":
        if (!body.event || !["click", "trial", "paid_annual", "paid_monthly", "checkout_annual"].includes(body.event)) {
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
    return NextResponse.json({ ...(await snapshot()), creator: activeCreator }, { headers: CORS });
  } catch (e) {
    const msg = (e as Error).message;
    const status = /invalid creator code|unknown creator code/i.test(msg) ? 404 : 400;
    return NextResponse.json({ ok: false, error: msg }, { status, headers: CORS });
  }
}
