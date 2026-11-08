import { NextResponse } from "next/server";
import {
  confirmPasswordReset,
  deleteUserAccount,
  getUserByEmail,
  loginWithOAuth,
  registerOrLoginEmail,
  requestPasswordReset,
  saveUser,
  toPublicProfile,
  verifySessionToken,
} from "@/lib/auth";
import { checkRateLimit } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "anon"
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(request: Request) {
  if (!checkRateLimit(`auth:get:${getClientIp(request)}`, 60)) {
    return NextResponse.json(
      { ok: false, error: "Too many auth checks. Please slow down." },
      { status: 429, headers: CORS }
    );
  }

  const { searchParams } = new URL(request.url);
  const authHeader = request.headers.get("authorization") || "";
  const tokenParam =
    searchParams.get("token") ||
    (authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "");
  const deviceId = searchParams.get("deviceId") || undefined;

  if (!tokenParam) {
    return NextResponse.json(
      { ok: false, authenticated: false },
      { headers: CORS }
    );
  }

  const decoded = verifySessionToken(tokenParam);
  if (!decoded) {
    return NextResponse.json(
      { ok: false, authenticated: false, error: "Invalid or expired session token." },
      { status: 401, headers: CORS }
    );
  }

  const stored = await getUserByEmail(decoded.email);
  if (!stored) {
    return NextResponse.json(
      { ok: false, authenticated: false, error: "Account not found." },
      { status: 401, headers: CORS }
    );
  }

  const profile = await toPublicProfile(stored, deviceId);
  return NextResponse.json(
    { ok: true, authenticated: true, user: profile },
    { headers: CORS }
  );
}

export async function POST(request: Request) {
  if (!checkRateLimit(`auth:post:${getClientIp(request)}`, 20)) {
    return NextResponse.json(
      { ok: false, error: "Too many authentication attempts. Try again in a minute." },
      { status: 429, headers: CORS }
    );
  }

  try {
    const body = (await request.json()) as {
      action?:
        | "login"
        | "register"
        | "oauth"
        | "forgot_password"
        | "reset_password"
        | "sync"
        | "delete_account";
      email?: string;
      password?: string;
      currentPassword?: string;
      newPassword?: string;
      resetCode?: string;
      idToken?: string;
      displayName?: string;
      provider?: "google" | "apple";
      deviceId?: string;
      token?: string;
      watchlist?: Record<string, boolean>;
    };

    const action = body.action || "login";

    if (action === "login" || action === "register") {
      const res = await registerOrLoginEmail({
        mode: action,
        email: body.email || "",
        password: body.password || "",
        displayName: body.displayName,
        deviceId: body.deviceId,
        watchlist: body.watchlist,
      });
      return NextResponse.json(res, {
        status: res.ok ? 200 : 400,
        headers: CORS,
      });
    }

    if (action === "oauth") {
      const provider = body.provider === "apple" ? "apple" : "google";
      const res = await loginWithOAuth({
        provider,
        email: body.email || "",
        idToken: body.idToken,
        password: body.password,
        displayName: body.displayName,
        deviceId: body.deviceId,
        watchlist: body.watchlist,
      });
      return NextResponse.json(res, {
        status: res.ok ? 200 : 400,
        headers: CORS,
      });
    }

    if (action === "forgot_password") {
      const res = await requestPasswordReset(body.email || "");
      return NextResponse.json(res, {
        status: res.ok ? 200 : 400,
        headers: CORS,
      });
    }

    if (action === "reset_password") {
      const res = await confirmPasswordReset({
        email: body.email || "",
        resetCode: body.resetCode,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword || body.password || "",
        deviceId: body.deviceId,
      });
      return NextResponse.json(res, {
        status: res.ok ? 200 : 400,
        headers: CORS,
      });
    }

    if (action === "sync") {
      const decoded = verifySessionToken(body.token || "");
      if (!decoded) {
        return NextResponse.json(
          { ok: false, error: "Not authenticated." },
          { status: 401, headers: CORS }
        );
      }
      const user = await getUserByEmail(decoded.email);
      if (user && body.watchlist) {
        user.watchlist = body.watchlist;
        await saveUser(user);
      }
      if (user) {
        const profile = await toPublicProfile(user, body.deviceId);
        return NextResponse.json({ ok: true, user: profile }, { headers: CORS });
      }
      return NextResponse.json({ ok: true }, { headers: CORS });
    }

    if (action === "delete_account") {
      const authHeader = request.headers.get("authorization") || "";
      const tokenCandidate =
        body.token || (authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "");
      const decoded = tokenCandidate ? verifySessionToken(tokenCandidate) : null;
      if (!decoded?.email) {
        return NextResponse.json(
          { ok: false, error: "Authentication required to delete account." },
          { status: 401, headers: CORS }
        );
      }
      await deleteUserAccount(decoded.email);
      return NextResponse.json(
        { ok: true, message: "Your account and saved cloud data have been permanently deleted." },
        { headers: CORS }
      );
    }

    return NextResponse.json(
      { ok: false, error: "Unsupported auth action." },
      { status: 400, headers: CORS }
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body." },
      { status: 400, headers: CORS }
    );
  }
}
