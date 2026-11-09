"use client";

import { useState } from "react";
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
  const [mode, setMode] = useState<"login" | "register" | "forgot">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [infoMessage, setInfoMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!open) return null;

  const canSubmitEmail =
    email.trim().includes("@") &&
    (mode === "forgot" ? password.length >= 8 && resetCode.trim().length >= 6 : password.length >= 8);

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
      const action =
        mode === "forgot"
          ? "reset_password"
          : mode === "register"
            ? "register"
            : "login";

      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          email: email.trim(),
          password,
          newPassword: password,
          resetCode: mode === "forgot" ? resetCode.trim() : undefined,
          displayName: displayName.trim() || undefined,
          deviceId,
          watchlist,
        }),
      });
      const data = await res.json().catch(() => ({}));
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
      aria-label={user ? "Your HeyBroc Account" : "Log in to HeyBroc"}
      onClick={onClose}
    >
      <div
        className="gococo-auth-card"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top bar with GoCoCo-style circular back button + peeking Broc doorway illustration */}
        <div className="gococo-top-row">
          <button
            type="button"
            className="gococo-back-btn"
            onClick={() => {
              if (mode !== "login" && !user) {
                setMode("login");
                setError("");
                setInfoMessage("");
              } else {
                onClose();
              }
            }}
            aria-label="Back"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M15 6L9 12L15 18"
                stroke="#18181b"
                strokeWidth="2.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {/* Cute peeking Broc in angled doorway (inspired by GoCoCo's peeking mascot) */}
          <div className="gococo-door-mascot" aria-hidden="true">
            <div className="gococo-door-frame">
              <div className="gococo-door-panel" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/broc-mascot.jpg"
                alt=""
                className="gococo-peeking-broc"
              />
            </div>
          </div>
        </div>

        {user ? (
          /* ================= LOGGED IN ACCOUNT & SYNC SHEET ================= */
          <div className="gococo-account-view">
            <h2 className="gococo-title">Account</h2>
            <p className="gococo-subtitle">
              Signed in and syncing your Watchlist, Favorites &amp; Family Pro across devices.
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
                    ? `★ Family Pro Active (${user.proDaysRemaining}d)`
                    : "Free Tier (Scores Always Free)"}
                </strong>
              </div>
              <div className="gococo-stat-row">
                <span>Personal Invite Code</span>
                <strong>{user.referralCode}</strong>
              </div>
              <div className="gococo-stat-row">
                <span>Store Affiliate &amp; Clean Swaps</span>
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
                  marginBottom: 12,
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

            {infoMessage && <p className="gococo-info-banner">{infoMessage}</p>}
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
              style={{ marginTop: 10 }}
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
              style={{ marginTop: 10 }}
              onClick={() => {
                onLogout();
                onClose();
              }}
            >
              <span>Log out of this device</span>
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
          /* ================= CLEAN LOGIN / SIGN-UP VIEW ================= */
          <form onSubmit={handleEmailSubmit} className="gococo-form">
            <h2 className="gococo-title">
              {mode === "register"
                ? "Create account"
                : mode === "forgot"
                  ? "Reset password"
                  : "Welcome to HeyBroc"}
            </h2>
            <p className="gococo-subtitle">
              {mode === "register"
                ? "Save your scans, Family Watchlist & Clean Swaps across all your devices."
                : mode === "forgot"
                  ? "Enter your email, 6-digit reset code, and a new password (8+ chars) below."
                  : "Sign in with your email and password to sync your Family Watchlist & Clean Swaps."}
            </p>

            {mode === "register" && (
              <div className="gococo-pill-ring">
                <div className="gococo-pill-inner">
                  <input
                    id="auth-name-input"
                    type="text"
                    autoComplete="name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="First name (optional)"
                    aria-label="First name"
                    className="gococo-input"
                  />
                </div>
              </div>
            )}

            {/* Email Pill Input */}
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

            {/* Password Pill Input with Show/Hide Toggle */}
            <div className="gococo-pill-ring">
              <div className="gococo-pill-inner gococo-pill-inner--password">
                <input
                  id="auth-password-input"
                  type={showPassword ? "text" : "password"}
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
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

            {/* Subtle right-aligned Forgot password link (no giant extra button) */}
            {mode === "login" && (
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: -2, marginBottom: 4 }}>
                <button
                  type="button"
                  onClick={handleForgotPasswordClick}
                  style={{
                    background: "none",
                    border: "none",
                    padding: "2px 6px",
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#6b7280",
                    cursor: "pointer",
                  }}
                >
                  Forgot password?
                </button>
              </div>
            )}

            {error && <p className="gococo-error">{error}</p>}
            {infoMessage && <p className="gococo-info">{infoMessage}</p>}

            {/* Primary Submit Pill ("Log in [→]") directly under Email & Password */}
            <div className="gococo-pill-ring gococo-submit-wrap">
              <button
                id="auth-submit-btn"
                type="submit"
                disabled={busy}
                className={`gococo-submit-pill ${canSubmitEmail ? "is-ready" : ""}`}
              >
                <span>
                  {busy
                    ? "Signing in…"
                    : mode === "register"
                      ? "Create account"
                      : mode === "forgot"
                        ? "Save new password"
                        : "Log in with Email"}
                </span>
                <span className="gococo-submit-icon" aria-hidden="true">
                  →
                </span>
              </button>
            </div>

            {/* Mode Switch + Shipt-style Outlined Continue as Guest Pill + Terms/Privacy Footer */}
            <div className="gococo-footer-links">
              <button
                type="button"
                className="gococo-switch-mode"
                onClick={() => {
                  setError("");
                  setInfoMessage("");
                  setMode(mode === "register" ? "login" : "register");
                }}
              >
                {mode === "register"
                  ? "Already have an account? Log in"
                  : "New to HeyBroc? Create a free account"}
              </button>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  margin: "4px 0",
                  color: "#9ca3af",
                  fontSize: 12,
                }}
                aria-hidden="true"
              >
                <span style={{ flex: 1, height: 1, background: "#e5e7eb" }} />
                <span>or</span>
                <span style={{ flex: 1, height: 1, background: "#e5e7eb" }} />
              </div>

              <button
                id="auth-continue-guest"
                type="button"
                onClick={onClose}
                style={{
                  width: "100%",
                  padding: "12px 18px",
                  borderRadius: 999,
                  background: "#ffffff",
                  border: "1.5px solid #18181b",
                  color: "#18181b",
                  fontWeight: 800,
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                Continue as guest
              </button>

              <div
                style={{
                  marginTop: 8,
                  display: "flex",
                  justifyContent: "center",
                  gap: 12,
                  fontSize: 11.5,
                  color: "#6b7280",
                }}
              >
                <a href="/terms" style={{ color: "#4b5563", textDecoration: "underline" }}>
                  Terms of Service
                </a>
                <span>|</span>
                <a href="/privacy" style={{ color: "#4b5563", textDecoration: "underline" }}>
                  Privacy &amp; Health Data Notice
                </a>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
