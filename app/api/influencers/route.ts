import { NextResponse } from "next/server";
import {
  createCreator,
  deleteCreator,
  getOrCreateCreator,
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

function isAdminAuthorized(req: Request): boolean {
  const secret = process.env.HEYBROC_ADMIN_SECRET?.trim();
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
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

/** GET /api/influencers            -> all creators + totals
 *  GET /api/influencers?code=XYZ   -> validate/apply a creator code on the paywall */
export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code");
  if (code) {
    try {
      const c = await getOrCreateCreator(code);
      return NextResponse.json({ ok: true, creator: c }, { status: 200, headers: CORS });
    } catch (e) {
      return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400, headers: CORS });
    }
  }
  return NextResponse.json(await snapshot(), { headers: CORS });
}

/**
 * POST actions:
 *  { action: "create", code, name?, commissionPct? }
 *  { action: "update", code, commissionPct?, name? }
 *  { action: "delete", code }
 *  { action: "track",  code, event: "click" | "trial" | "paid_annual" | "paid_monthly" | "checkout_annual" }
 *  { action: "reset" }   -> zero all stats (keeps creators)
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
  try {
    const isProtectedTrack =
      body.action === "track" &&
      body.event &&
      ["paid_annual", "paid_monthly", "checkout_annual"].includes(body.event);
    if (((body.action && body.action !== "track") || isProtectedTrack) && !isAdminAuthorized(request)) {
      return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401, headers: CORS });
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
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400, headers: CORS });
  }
}
