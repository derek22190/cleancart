import crypto from "crypto";
import { NextResponse } from "next/server";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function isAdminAuthorized(req: Request): boolean {
  const secret = process.env.HEYBROC_ADMIN_SECRET?.trim();
  if (!secret) return false;
  const authHeader = req.headers.get("authorization") || "";
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(authHeader, "utf8");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

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
  const code = new URL(request.url).searchParams.get("code");
  if (code) {
    const c = await getCreator(code);
    if (!c) {
      return NextResponse.json({ ok: false, error: "Invalid creator code." }, { status: 404, headers: CORS });
    }
    return NextResponse.json(
      { ok: true, creator: { code: c.code, name: c.name } },
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

  if (!isAdmin && !isPublicClickTrack) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401, headers: CORS });
  }

  try {
    if (!isAdmin && isPublicClickTrack) {
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
