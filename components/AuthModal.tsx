"use client";

import { useCallback, useEffect, useState } from "react";
import type { Category } from "@/lib/rubric";

export interface AuthenticatedUser {
  userId: string;
  email: string;
  displayName: string;
  provider: "email" | "google" | "apple";
  emailVerified?: boolean;
  referralCode: string;
  proUntil: number;
  isProActive: boolean;
  proDaysRemaining: number;
  entitlementStatus?: "active" | "trialing" | "free";
  watchlist?: Record<string, boolean>;
  createdAt?: string;
}

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  user: AuthenticatedUser | null;
  deviceId: string;
  watchlist: Record<Category, boolean>;
  onAuthSuccess: (user: AuthenticatedUser, token: string) => void;
  onLogout: () => void;
  onDeleteAccount: () => void;
}

function decodeJwtClaims(token: string): { email?: string; name?: string } {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const json = atob(padded);
    return JSON.parse(json) as { email?: string; name?: string };
  } catch {
    return {};
  }
}

export default function AuthModal({
  open,
  onClose,
  user,
  deviceId,
  watchlist,
  onAuthSuccess,
  onLogout,
  onDeleteAccount,
}: AuthModalProps) {
  const [mode, setMode] = useState<"login" | "forgot">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleClientId, setGoogleClientId] = useState<string>(
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || ""
  );
  const [error, setError] = useState("");
  const [infoMessage, setInfoMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Lock background page scroll while modal is open so touch-scrolling stays inside the dialog
  useEffect(() => {
    if (!open) return;
    const prevBodyOverflow = document.body.style.overflow;
    const prevHtmlOverscroll = document.documentElement.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overscrollBehavior = "none";

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevBodyOverflow;
      document.documentElement.style.overscrollBehavior = prevHtmlOverscroll;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  const exchangeGoogleIdToken = useCallback(
    async (idToken: string) => {
      setGoogleBusy(true);
      setBusy(true);
      setError("");
      setInfoMessage("");
      try {
        const claims = decodeJwtClaims(idToken);
        const devSecret =
          typeof window !== "undefined"
            ? window.localStorage.getItem("heybroc_device_secret") || ""
            : "";
        const res = await fetch("/api/auth", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(devSecret ? { "X-Device-Secret": devSecret } : {}),
          },
          body: JSON.stringify({
            action: "oauth",
            provider: "google",
            idToken,
            email: claims.email || "",
            displayName: claims.name || undefined,
            deviceId,
            deviceSecret: devSecret || undefined,
            watchlist,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok || !data.user || !data.token) {
          setError(data.error || "Could not verify Google account. Please try again.");
          return;
        }
        onAuthSuccess(data.user as AuthenticatedUser, data.token as string);
        onClose();
      } catch {
        setError("Network error completing Google Sign-In. Please try again.");
      } finally {
        setGoogleBusy(false);
        setBusy(false);
      }
    },
    [deviceId, watchlist, onAuthSuccess, onClose]
  );

  // Fetch server-configured GOOGLE_CLIENT_ID and consume any pending mobile redirect token
  useEffect(() => {
    if (!open && typeof window !== "undefined") {
      const pending = window.sessionStorage.getItem("heybroc_pending_google_id_token");
      if (!pending) return;
    }
    let cancelled = false;

    if (!googleClientId) {
      fetch("/api/auth?config=1")
        .then((r) => r.json())
        .then((d: { googleClientId?: string }) => {
          if (!cancelled && d?.googleClientId) {
            setGoogleClientId(d.googleClientId);
          }
        })
        .catch(() => {});
    }

    if (typeof window !== "undefined") {
      const pendingToken = window.sessionStorage.getItem("heybroc_pending_google_id_token");
      const pendingState = window.sessionStorage.getItem("heybroc_pending_google_state");
      const expectedState = window.sessionStorage.getItem("heybroc_oauth_state");
      if (pendingToken) {
        window.sessionStorage.removeItem("heybroc_pending_google_id_token");
        window.sessionStorage.removeItem("heybroc_pending_google_state");
        if (!expectedState || !pendingState || expectedState === pendingState) {
          void exchangeGoogleIdToken(pendingToken);
        }
      }
    }

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const payload = event.data as
        | { type?: string; idToken?: string; state?: string; error?: string }
        | undefined;
      if (!payload || payload.type !== "heybroc-google-oauth") return;
      const expectedState = window.sessionStorage.getItem("heybroc_oauth_state");
      if (expectedState && payload.state && expectedState !== payload.state) {
        setGoogleBusy(false);
        setError("Google sign-in state mismatch. Please try again.");
        return;
      }
      if (payload.error) {
        setGoogleBusy(false);
        if (payload.error !== "access_denied") {
          setError(`Google Sign-In: ${payload.error}`);
        }
        return;
      }
      if (payload.idToken) {
        void exchangeGoogleIdToken(payload.idToken);
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
    };
  }, [open, googleClientId, exchangeGoogleIdToken]);

  if (!open) return null;

  const canSubmitEmail =
    email.trim().includes("@") &&
    (mode === "forgot"
      ? password.length >= 8 && resetCode.trim().length >= 6
      : password.length >= 8);

  const handleGoogleSignInClick = async () => {
    setError("");
    setInfoMessage("");

    let resolvedClientId = googleClientId.trim();
    if (!resolvedClientId) {
      const cfg = await fetch("/api/auth?config=1")
        .then((r) => r.json())
        .catch(() => null);
      if (cfg?.googleClientId) {
        resolvedClientId = String(cfg.googleClientId).trim();
        setGoogleClientId(resolvedClientId);
      }
    }

    if (!resolvedClientId) {
      setError(
        "Google Account Picker is almost ready — add GOOGLE_CLIENT_ID in Vercel Settings (Authorized redirect URI: https://www.heybroc.com/auth/google-callback), or continue with your email below."
      );
      return;
    }

    const nonceBytes = new Uint8Array(16);
    window.crypto.getRandomValues(nonceBytes);
    const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const state = `hb_${nonce.slice(0, 20)}`;
    window.sessionStorage.setItem("heybroc_oauth_state", state);

    const redirectUri = `${window.location.origin}/auth/google-callback`;
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", resolvedClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "id_token");
    authUrl.searchParams.set("scope", "openid email profile");
    authUrl.searchParams.set("prompt", "select_account");
    authUrl.searchParams.set("nonce", nonce);
    authUrl.searchParams.set("state", state);

    const width = 500;
    const height = 620;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
    setGoogleBusy(true);
    const popup = window.open(
      authUrl.toString(),
      "heybroc_google_auth",
      `popup=yes,width=${width},height=${height},left=${left},top=${top}`
    );

    if (!popup) {
      // Mobile browser blocked popup -> navigate directly to Google's Choose an Account screen
      window.location.assign(authUrl.toString());
      return;
    }

    const pollClosed = window.setInterval(() => {
      if (popup.closed) {
        window.clearInterval(pollClosed);
        setGoogleBusy(false);
      }
    }, 600);
  };

  const handleVerifyEmail = async () => {
    if (!user || verifyCode.trim().length < 6) {
      setError("Please enter your 6-digit verification code.");
      return;
    }
    setBusy(true);
    setError("");
    setInfoMessage("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "verify_email",
          email: user.email,
          verificationCode: verifyCode.trim(),
          deviceId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.user) {
        setError(data.error || "Invalid or expired verification code.");
        return;
      }
      const storedToken =
        typeof window !== "undefined"
          ? window.localStorage.getItem("heybroc_auth_token") || ""
          : "";
      onAuthSuccess(data.user as AuthenticatedUser, storedToken);
      setVerifyCode("");
      setInfoMessage("Email verified!");
    } catch {
      setError("Network error verifying email. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleResendVerification = async () => {
    if (!user) return;
    setBusy(true);
    setError("");
    setInfoMessage("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "resend_verification",
          email: user.email,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setError(data.error || "Could not send verification email.");
        return;
      }
      setInfoMessage(data.message || "Sent a 6-digit verification code to your email.");
    } catch {
      setError("Network error sending verification code.");
    } finally {
      setBusy(false);
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setInfoMessage("");

    if (!email.trim() || !email.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (mode === "forgot" && resetCode.trim().length < 6) {
      setError("Please enter your 6-digit password reset code.");
      return;
    }

    setBusy(true);
    try {
      const action = mode === "forgot" ? "reset_password" : "login";
      const devSecret =
        typeof window !== "undefined"
          ? window.localStorage.getItem("heybroc_device_secret") || ""
          : "";

      const sendRequest = async (reqAction: string) => {
        const res = await fetch("/api/auth", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(devSecret ? { "X-Device-Secret": devSecret } : {}),
          },
          body: JSON.stringify({
            action: reqAction,
            email: email.trim(),
            password,
            newPassword: password,
            resetCode: mode === "forgot" ? resetCode.trim() : undefined,
            deviceId,
            deviceSecret: devSecret || undefined,
            watchlist,
          }),
        });
        const data = await res.json().catch(() => ({}));
        return { res, data };
      };

      let { res, data } = await sendRequest(action);
      if (
        (!res.ok || !data.ok) &&
        action === "login" &&
        typeof data.error === "string" &&
        data.error.toLowerCase().includes("no account found")
      ) {
        ({ res, data } = await sendRequest("register"));
      }

      if (!res.ok || !data.ok || !data.user || !data.token) {
        setError(data.error || "Could not sign in. Please check your details and try again.");
        return;
      }
      onAuthSuccess(data.user as AuthenticatedUser, data.token as string);
      onClose();
    } catch {
      setError("Network error connecting to HeyBroc. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleForgotPasswordClick = async () => {
    setError("");
    setInfoMessage("");
    if (mode !== "forgot") {
      setMode("forgot");
      setPassword("");
      if (email.trim().includes("@")) {
        const res = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "forgot_password", email: email.trim() }),
        }).catch(() => null);
        const data = res ? await res.json().catch(() => null) : null;
        if (data?.message) {
          setInfoMessage(data.message);
        }
      } else {
        setInfoMessage("Enter your email and choose a new password (8+ characters) below.");
      }
    }
  };

  const handleDeleteAccountConfirm = async () => {
    setBusy(true);
    setError("");
    try {
      const token =
        typeof window !== "undefined"
          ? window.localStorage.getItem("heybroc_auth_token") || ""
          : "";
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          action: "delete_account",
          token,
          email: user?.email,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        setError(result.error || "Deletion failed. Your account is still available; please retry.");
        return;
      }
      setConfirmDelete(false);
      onDeleteAccount();
      onClose();
    } catch {
      setError("Could not confirm account deletion. Please retry.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop gococo-auth-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={user ? "Your HeyBroc Account" : "Sign in to HeyBroc"}
      onClick={onClose}
    >
      <div
        className="gococo-auth-card"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Compact Header Row: Mascot + Title on Left, Clear Close Button on Right */}
        <div className="gococo-top-row">
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            {mode === "forgot" && !user ? (
              <button
                type="button"
                className="gococo-back-btn"
                onClick={() => {
                  setMode("login");
                  setError("");
                  setInfoMessage("");
                }}
                aria-label="Back to sign in"
              >
                ←
              </button>
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src="/broc-mascot.png"
                alt="HeyBroc"
                style={{ width: 40, height: 40, objectFit: "contain", flexShrink: 0 }}
              />
            )}
            <div>
              <h2 className="gococo-title">
                {user
                  ? "Account"
                  : mode === "forgot"
                    ? "Reset password"
                    : "Sign in to HeyBroc"}
              </h2>
            </div>
          </div>

          <button
            type="button"
            className="gococo-back-btn"
            onClick={onClose}
            aria-label="Close sign in dialog"
          >
            ✕
          </button>
        </div>

        {user ? (
          /* ================= LOGGED IN ACCOUNT & SYNC SHEET ================= */
          <div className="gococo-account-view">
            <p className="gococo-subtitle">
              Syncing your Watchlist, Favorites &amp; Family Pro across devices.
            </p>

            <div className="gococo-profile-box">
              <div className="gococo-profile-avatar">
                {(user.displayName || user.email || "B")[0].toUpperCase()}
              </div>
              <div className="gococo-profile-meta">
                <strong>{user.displayName}</strong>
                <span>{user.email}</span>
                <small className="gococo-provider-pill">
                  {user.provider === "google"
                    ? "✓ Signed in with Google"
                    : user.provider === "apple"
                      ? "✓ Signed in with Apple"
                      : user.emailVerified
                        ? "✓ Verified Email Account"
                        : "✓ Signed in with Email"}
                </small>
              </div>
            </div>

            <div className="gococo-sync-stats">
              <div className="gococo-stat-row">
                <span>Membership Status</span>
                <strong style={{ color: user.isProActive ? "#0f7a4a" : "#52525b" }}>
                  {user.isProActive
                    ? user.entitlementStatus === "trialing"
                      ? `★ Free Trial Active (${user.proDaysRemaining}d left)`
                      : `★ Family Pro Active (${user.proDaysRemaining}d)`
                    : "Free Tier (Scores Always Free)"}
                </strong>
              </div>
              <div className="gococo-stat-row">
                <span>Clean Swaps</span>
                <strong style={{ color: "#0f7a4a" }}>✓ Active on all 12 stores</strong>
              </div>
            </div>

            {!user.emailVerified && (
              <div
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: 12,
                  padding: 12,
                  marginBottom: 4,
                }}
              >
                <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "#334155" }}>
                  Enter the 6-digit verification code sent to <b>{user.email}</b> to link any email-based Pro subscription:
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value)}
                    placeholder="6-digit code"
                    style={{
                      flex: 1,
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: "1px solid #cbd5e1",
                      fontSize: 14,
                    }}
                  />
                  <button
                    type="button"
                    disabled={busy || verifyCode.trim().length < 6}
                    onClick={handleVerifyEmail}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      background: "#0f7a4a",
                      color: "#fff",
                      border: "none",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Verify
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleResendVerification}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: "#f1f5f9",
                      color: "#334155",
                      border: "1px solid #cbd5e1",
                      fontSize: 12.5,
                      cursor: "pointer",
                    }}
                  >
                    Resend
                  </button>
                </div>
              </div>
            )}

            {infoMessage && <p className="gococo-info">{infoMessage}</p>}
            {error && <p className="gococo-error">{error}</p>}

            <button
              type="button"
              className="gococo-submit-pill is-ready"
              onClick={onClose}
            >
              <span>Continue Shopping</span>
              <span className="gococo-submit-icon" aria-hidden="true">→</span>
            </button>

            <button
              id="account-manage-subscription"
              type="button"
              className="gococo-forgot-pill"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                setInfoMessage("");
                try {
                  const token =
                    typeof window !== "undefined"
                      ? window.localStorage.getItem("heybroc_auth_token") || ""
                      : "";
                  const devSecret =
                    typeof window !== "undefined"
                      ? window.localStorage.getItem("heybroc_device_secret") || ""
                      : "";
                  const sessionId =
                    typeof window !== "undefined"
                      ? window.localStorage.getItem("heybroc_session_id") || ""
                      : "";
                  const res = await fetch("/api/billing/portal", {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      ...(token ? { Authorization: `Bearer ${token}` } : {}),
                      ...(devSecret ? { "X-Device-Secret": devSecret } : {}),
                    },
                    body: JSON.stringify({
                      deviceId,
                      deviceSecret: devSecret || undefined,
                      sessionId: sessionId || undefined,
                      email: user.email,
                      returnUrl:
                        typeof window !== "undefined"
                          ? window.location.origin
                          : "https://heybroc.com",
                    }),
                  });
                  const data = await res.json().catch(() => ({}));
                  if (res.ok && data?.ok && data?.url) {
                    window.location.href = data.url;
                    return;
                  }
                  setError(
                    data?.error ||
                      "No active Stripe subscription found for this account."
                  );
                } catch {
                  setError("Could not open Billing Portal. Please try again.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <span>Manage / Cancel subscription</span>
            </button>

            <button
              type="button"
              className="gococo-forgot-pill"
              onClick={() => {
                onLogout();
                onClose();
              }}
            >
              <span>Log out</span>
            </button>

            {!confirmDelete ? (
              <button
                type="button"
                className="gococo-delete-link"
                onClick={() => setConfirmDelete(true)}
              >
                Delete account &amp; cloud data
              </button>
            ) : (
              <div className="gococo-delete-confirm">
                <p>
                  Permanently delete <b>{user.email}</b>? You can still use HeyBroc as a Guest anytime.
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="gococo-delete-btn-confirm"
                    disabled={busy}
                    onClick={handleDeleteAccountConfirm}
                  >
                    {busy ? "Deleting…" : "Yes, Delete Account"}
                  </button>
                  <button
                    type="button"
                    className="gococo-delete-btn-cancel"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* ================= STREAMLINED SIGN-IN / AUTO-CREATE VIEW ================= */
          <form onSubmit={handleEmailSubmit} className="gococo-form">
            <p className="gococo-subtitle">
              {mode === "forgot"
                ? "Enter your email, 6-digit reset code, and a new password (8+ chars)."
                : "Sync your Family Watchlist & Clean Swaps across devices. New emails create a free account automatically."}
            </p>

            {mode !== "forgot" && (
              <>
                <button
                  id="auth-google-btn"
                  type="button"
                  disabled={busy || googleBusy}
                  onClick={() => void handleGoogleSignInClick()}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 10,
                    padding: "12px 18px",
                    borderRadius: 999,
                    background: "#ffffff",
                    border: "1.5px solid #cbd5e1",
                    color: "#0f172a",
                    fontWeight: 800,
                    fontSize: 15,
                    cursor: busy || googleBusy ? "wait" : "pointer",
                    boxShadow: "0 1px 3px rgba(15, 23, 42, 0.06)",
                  }}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="#4285F4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    />
                  </svg>
                  <span>{googleBusy ? "Opening Google…" : "Continue with Google"}</span>
                </button>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    margin: "2px 0",
                    color: "#94a3b8",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                  aria-hidden="true"
                >
                  <span style={{ flex: 1, height: 1, background: "#e2e8f0" }} />
                  <span>or email</span>
                  <span style={{ flex: 1, height: 1, background: "#e2e8f0" }} />
                </div>
              </>
            )}

            {/* Email Input */}
            <div className="gococo-pill-ring">
              <div className="gococo-pill-inner">
                <input
                  id="auth-email-input"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email address"
                  aria-label="Email"
                  className="gococo-input"
                />
              </div>
            </div>

            {mode === "forgot" && (
              <div className="gococo-pill-ring">
                <div className="gococo-pill-inner">
                  <input
                    id="auth-reset-code-input"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={resetCode}
                    onChange={(e) => setResetCode(e.target.value)}
                    placeholder="6-digit reset code"
                    aria-label="6-digit reset code"
                    className="gococo-input"
                  />
                </div>
              </div>
            )}

            {/* Password Input with Show/Hide Toggle */}
            <div className="gococo-pill-ring">
              <div className="gococo-pill-inner gococo-pill-inner--password">
                <input
                  id="auth-password-input"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === "forgot" ? "New password (8+ chars)" : "Password (8+ chars)"}
                  aria-label="Password"
                  className="gococo-input"
                />
                <button
                  type="button"
                  className="gococo-eye-btn"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  style={{ fontSize: 13, fontWeight: 700, color: "#4b5563" }}
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            {mode === "login" && (
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: -4 }}>
                <button
                  type="button"
                  onClick={handleForgotPasswordClick}
                  style={{
                    background: "none",
                    border: "none",
                    padding: "2px 4px",
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "#64748b",
                    cursor: "pointer",
                  }}
                >
                  Forgot password?
                </button>
              </div>
            )}

            {error && <p className="gococo-error">{error}</p>}
            {infoMessage && <p className="gococo-info">{infoMessage}</p>}

            {/* Single Clean Submit Button */}
            <button
              id="auth-submit-btn"
              type="submit"
              disabled={busy}
              className={`gococo-submit-pill ${canSubmitEmail ? "is-ready" : ""}`}
            >
              <span>
                {busy
                  ? "Signing in…"
                  : mode === "forgot"
                    ? "Save new password"
                    : "Continue"}
              </span>
              <span className="gococo-submit-icon" aria-hidden="true">
                →
              </span>
            </button>

            <div className="gococo-footer-links">
              <button
                id="auth-continue-guest"
                type="button"
                onClick={onClose}
                className="gococo-guest-link"
              >
                Continue as guest
              </button>

              <div
                style={{
                  marginTop: 2,
                  display: "flex",
                  justifyContent: "center",
                  gap: 10,
                  fontSize: 11,
                  color: "#6b7280",
                }}
              >
                <a href="/terms" style={{ color: "#64748b", textDecoration: "underline" }}>
                  Terms
                </a>
                <span>·</span>
                <a href="/privacy" style={{ color: "#64748b", textDecoration: "underline" }}>
                  Privacy &amp; Health Data
                </a>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
