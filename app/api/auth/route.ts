import { NextResponse } from "next/server";
import {
  confirmPasswordReset,
  deleteUserAccount,
  getAuthenticatedUser,
  linkDeviceToUser,
  loginWithOAuth,
  normalizeEmail,
  registerOrLoginEmail,
  requestPasswordReset,
  resendVerificationCode,
  saveUser,
  toPublicProfile,
  verifyEmailCode,
} from "@/lib/auth";
import { normalizeRealDeviceId } from "@/lib/entitlements";
import { checkRateLimitAsync } from "@/lib/scan";
import { kvSetNx } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-Secret",
};

const EMAIL_OTP_COOLDOWN_SECONDS = 30;

function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "anon"
  );
}

async function checkEmailOtpSendCooldown(
  action: string,
  rawEmail?: string
): Promise<boolean> {
  const email = normalizeEmail(rawEmail || "");
  if (!email) return true;
  if (!(await checkRateLimitAsync(`auth:otp-send:${email}`, 4))) {
    return false;
  }
  if (action === "forgot_password" || action === "resend_verification") {
    const acquired = await kvSetNx(
      `heybroc:ratelimit:otp-cooldown:${action}:${email}`,
      "1",
      EMAIL_OTP_COOLDOWN_SECONDS
    );
    if (!acquired) return false;
  }
  return true;
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(request: Request) {
  if (!(await checkRateLimitAsync(`auth:get:${getClientIp(request)}`, 60))) {
    return NextResponse.json(
      { ok: false, error: "Too many auth checks. Please slow down." },
      { status: 429, headers: CORS }
    );
  }

  const { searchParams } = new URL(request.url);
  if (searchParams.get("config") === "1") {
    const rawClientId =
      process.env.GOOGLE_CLIENT_ID ||
      process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ||
      process.env.GOOGLE_OAUTH_CLIENT_IDS?.split(",")[0] ||
      "";
    return NextResponse.json(
      { ok: true, googleClientId: rawClientId.trim() },
      { headers: CORS }
    );
  }
  const authHeader = request.headers.get("authorization") || "";
  const tokenParam =
    (authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "") ||
    searchParams.get("token") ||
    "";
  const deviceId = normalizeRealDeviceId(searchParams.get("deviceId")) || undefined;

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
  if (!(await checkRateLimitAsync(`auth:post:${getClientIp(request)}`, 20))) {
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
    const cleanEmail = normalizeEmail(body.email || "");
    const normalizedDeviceId = normalizeRealDeviceId(body.deviceId) || undefined;
    const resolvedDeviceSecret =
      body.deviceSecret ||
      request.headers.get("x-device-secret") ||
      undefined;

    if (
      action === "forgot_password" ||
      action === "resend_verification" ||
      action === "register"
    ) {
      if (!(await checkEmailOtpSendCooldown(action, cleanEmail))) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Please wait 30 seconds before requesting another verification or reset code for this email.",
          },
          { status: 429, headers: CORS }
        );
      }
    } else if (
      cleanEmail &&
      (action === "login" ||
        action === "verify_email" ||
        action === "reset_password")
    ) {
      if (
        !(await checkRateLimitAsync(`auth:attempt:${action}:${cleanEmail}`, 10))
      ) {
        return NextResponse.json(
          {
            ok: false,
            error: "Too many attempts for this email. Please wait a minute and try again.",
          },
          { status: 429, headers: CORS }
        );
      }
    }

    if (action === "login" || action === "register") {
      const res = await registerOrLoginEmail({
        mode: action,
        email: body.email || "",
        password: body.password || "",
        displayName: body.displayName,
        deviceId: normalizedDeviceId,
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
        deviceId: normalizedDeviceId,
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
        deviceId: normalizedDeviceId,
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
        deviceId: normalizedDeviceId,
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
      let userDirty = false;
      let syncedDeviceId = normalizedDeviceId;
      if (normalizedDeviceId && resolvedDeviceSecret) {
        const linkRes = await linkDeviceToUser(
          user,
          normalizedDeviceId,
          resolvedDeviceSecret
        );
        if (linkRes.changed) userDirty = true;
        syncedDeviceId = linkRes.linked ? linkRes.deviceId : undefined;
      }
      if (body.watchlist) {
        user.watchlist = body.watchlist;
        userDirty = true;
      }
      const profile = await toPublicProfile(user, syncedDeviceId, {
        skipUserSave: userDirty,
      });
      if (userDirty) {
        await saveUser(user);
      }
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

