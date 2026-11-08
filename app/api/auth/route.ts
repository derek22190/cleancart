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
import { codeFromDeviceId, getOrCreateDevice } from "@/lib/referrals";

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

export async function GET(request: Request) {
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
  const dev = deviceId ? await getOrCreateDevice(deviceId).catch(() => null) : null;
  const userObj = stored || {
    userId: decoded.uid,
    email: decoded.email,
    displayName: decoded.name || decoded.email.split("@")[0],
    provider: decoded.provider || "email",
    referralCode: decoded.ref || dev?.referralCode || codeFromDeviceId(decoded.email),
    proUntil: dev?.proUntil || Date.now() + 7 * 24 * 60 * 60 * 1000,
    isStripePro: false,
    linkedDevices: deviceId ? [deviceId] : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const profile = await toPublicProfile(userObj, deviceId);
  return NextResponse.json(
    { ok: true, authenticated: true, user: profile },
    { headers: CORS }
  );
}

export async function POST(request: Request) {
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
      newPassword?: string;
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
      const decoded = body.token ? verifySessionToken(body.token) : null;
      const targetEmail = decoded?.email || body.email || "";
      await deleteUserAccount(targetEmail);
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
