import { NextResponse } from "next/server";
import {
  confirmPasswordReset,
  deleteUserAccount,
  getAuthenticatedUser,
  loginWithOAuth,
  registerOrLoginEmail,
  requestPasswordReset,
  resendVerificationCode,
  saveUser,
  toPublicProfile,
  verifyEmailCode,
} from "@/lib/auth";
import { checkRateLimit } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-Secret",
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
    (authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "") ||
    searchParams.get("token") ||
    "";
  const deviceId = searchParams.get("deviceId") || undefined;

  if (!tokenParam) {
    return NextResponse.json(
      { ok: false, authenticated: false },
      { headers: CORS }
    );
  }

  const stored = await getAuthenticatedUser(tokenParam);
  if (!stored) {
    return NextResponse.json(
      { ok: false, authenticated: false, error: "Invalid or expired session token." },
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
        | "verify_email"
        | "resend_verification"
        | "sync"
        | "delete_account";
      email?: string;
      password?: string;
      currentPassword?: string;
      newPassword?: string;
      resetCode?: string;
      verificationCode?: string;
      idToken?: string;
      displayName?: string;
      provider?: "google" | "apple";
      deviceId?: string;
      deviceSecret?: string;
      token?: string;
      watchlist?: Record<string, boolean>;
    };

    const action = body.action || "login";
    const resolvedDeviceSecret =
      body.deviceSecret ||
      request.headers.get("x-device-secret") ||
      undefined;

    if (action === "login" || action === "register") {
      const res = await registerOrLoginEmail({
        mode: action,
        email: body.email || "",
        password: body.password || "",
        displayName: body.displayName,
        deviceId: body.deviceId,
        deviceSecret: resolvedDeviceSecret,
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
        deviceSecret: resolvedDeviceSecret,
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

    if (action === "verify_email") {
      const res = await verifyEmailCode({
        email: body.email || "",
        code: body.verificationCode || body.resetCode || "",
        deviceId: body.deviceId,
      });
      return NextResponse.json(res, {
        status: res.ok ? 200 : 400,
        headers: CORS,
      });
    }

    if (action === "resend_verification") {
      const res = await resendVerificationCode(body.email || "");
      return NextResponse.json(res, {
        status: res.ok ? 200 : 400,
        headers: CORS,
      });
    }

    if (action === "sync") {
      const authHeader = request.headers.get("authorization") || "";
      const tokenCandidate =
        body.token || (authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "");
      const user = await getAuthenticatedUser(tokenCandidate);
      if (!user) {
        return NextResponse.json(
          { ok: false, error: "Not authenticated." },
          { status: 401, headers: CORS }
        );
      }
      if (body.watchlist) {
        user.watchlist = body.watchlist;
        await saveUser(user);
      }
      const profile = await toPublicProfile(user, body.deviceId);
      return NextResponse.json({ ok: true, user: profile }, { headers: CORS });
    }

    if (action === "delete_account") {
      const authHeader = request.headers.get("authorization") || "";
      const tokenCandidate =
        body.token || (authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "");
      const stored = await getAuthenticatedUser(tokenCandidate);
      if (!stored) {
        return NextResponse.json(
          { ok: false, error: "Authentication required to delete account." },
          { status: 401, headers: CORS }
        );
      }
      const deleted = await deleteUserAccount(stored.email);
      if (!deleted) {
        return NextResponse.json(
          { ok: false, error: "Could not complete account deletion. Please retry." },
          { status: 500, headers: CORS }
        );
      }
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

