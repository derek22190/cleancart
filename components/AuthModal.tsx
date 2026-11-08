"use client";

import { useState } from "react";
import type { Category } from "@/lib/rubric";

export interface AuthenticatedUser {
  userId: string;
  email: string;
  displayName: string;
  provider: "email" | "google" | "apple";
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
  const [mode, setMode] = useState<"login" | "register" | "forgot" | "oauth_prompt">("login");
  const [oauthProvider, setOauthProvider] = useState<"google" | "apple">("google");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [infoMessage, setInfoMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!open) return null;

  const canSubmitEmail =
    email.trim().includes("@") &&
    (mode === "forgot" ? password.length >= 6 && resetCode.trim().length >= 6 : password.length >= 6);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setInfoMessage("");

    if (!email.trim() || !email.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
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

  const handleStartOAuth = (provider: "google" | "apple") => {
    setError("");
    setInfoMessage("");
    setOauthProvider(provider);
    if (!email.trim()) {
      setEmail(provider === "google" ? "" : "");
    }
    setMode("oauth_prompt");
  };

  const handleCompleteOAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const targetEmail = email.trim();
    if (!targetEmail || !targetEmail.includes("@")) {
      setError(
        oauthProvider === "google"
          ? "Enter your Google / Gmail address to continue."
          : "Enter your Apple ID email to continue."
      );
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "oauth",
          provider: oauthProvider,
          email: targetEmail,
          displayName: displayName.trim() || undefined,
          deviceId,
          watchlist,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.user || !data.token) {
        setError(data.error || "Could not complete sign-in.");
        return;
      }
      onAuthSuccess(data.user as AuthenticatedUser, data.token as string);
      onClose();
    } catch {
      setError("Network error completing sign-in.");
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
        setInfoMessage("Enter your email and choose a new password (6+ characters) below.");
      }
    }
  };

  const handleDeleteAccountConfirm = async () => {
    setBusy(true);
    try {
      const token =
        typeof window !== "undefined"
          ? window.localStorage.getItem("heybroc_auth_token") || ""
          : "";
      await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete_account",
          token,
          email: user?.email,
        }),
      }).catch(() => null);
      setConfirmDelete(false);
      onDeleteAccount();
      onClose();
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

            <button
              type="button"
              className="gococo-submit-pill is-ready"
              onClick={onClose}
            >
              <span>Continue Shopping</span>
              <span className="gococo-submit-icon" aria-hidden="true">→</span>
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
        ) : mode === "oauth_prompt" ? (
          /* ================= 1-TAP GOOGLE / APPLE ACCOUNT SHEET ================= */
          <form onSubmit={handleCompleteOAuth} className="gococo-form">
            <h2 className="gococo-title">
              {oauthProvider === "google" ? "Sign in with Google" : "Sign in with Apple"}
            </h2>
            <p className="gococo-subtitle">
              {oauthProvider === "google"
                ? "Enter your Google / Gmail address to link your HeyBroc account & sync Family Pro."
                : "Enter your Apple ID email (or Hide My Email address) to link your HeyBroc account."}
            </p>

            <div className="gococo-pill-ring">
              <div className="gococo-pill-inner">
                <input
                  id="auth-oauth-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={
                    oauthProvider === "google"
                      ? "yourname@gmail.com"
                      : "yourname@icloud.com"
                  }
                  className="gococo-input"
                />
              </div>
            </div>

            <div className="gococo-pill-ring">
              <div className="gococo-pill-inner">
                <input
                  id="auth-oauth-name"
                  type="text"
                  autoComplete="name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="First name (optional)"
                  className="gococo-input"
                />
              </div>
            </div>

            {error && <p className="gococo-error">{error}</p>}

            <button
              type="submit"
              disabled={busy}
              className={`gococo-submit-pill ${email.includes("@") ? "is-ready" : ""}`}
            >
              <span>
                {busy
                  ? "Connecting…"
                  : oauthProvider === "google"
                    ? "Continue with Gmail"
                    : "Continue with Apple ID"}
              </span>
              <span className="gococo-submit-icon" aria-hidden="true">→</span>
            </button>

            <button
              type="button"
              className="gococo-guest-link"
              onClick={() => setMode("login")}
            >
              ← Back to all login options
            </button>
          </form>
        ) : (
          /* ================= MAIN GOCOCO-STYLE LOGIN / SIGN-UP VIEW ================= */
          <form onSubmit={handleEmailSubmit} className="gococo-form">
            <h2 className="gococo-title">
              {mode === "register"
                ? "Sign up"
                : mode === "forgot"
                  ? "Reset password"
                  : "Log in"}
            </h2>
            <p className="gococo-subtitle">
              {mode === "register"
                ? "Create your free HeyBroc account to sync your Watchlist & Pro across devices!"
                : mode === "forgot"
                  ? "Enter your email and choose a new password below."
                  : "Welcome back to HeyBroc, we have missed you!"}
            </p>

            {/* Email Pill Input */}
            <div className="gococo-pill-ring">
              <div className="gococo-pill-inner">
                <input
                  id="auth-email-input"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email"
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

            {/* Password Pill Input with Closed/Open Eyelash Toggle */}
            <div className="gococo-pill-ring">
              <div className="gococo-pill-inner gococo-pill-inner--password">
                <input
                  id="auth-password-input"
                  type={showPassword ? "text" : "password"}
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === "forgot" ? "New password (6+ chars)" : "Password"}
                  aria-label="Password"
                  className="gococo-input"
                />
                <button
                  type="button"
                  className="gococo-eye-btn"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    /* Open eye icon */
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M2.5 12C4.5 7.5 8 5 12 5C16 5 19.5 7.5 21.5 12C19.5 16.5 16 19 12 19C8 19 4.5 16.5 2.5 12Z"
                        stroke="#1f2937"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                      <circle cx="12" cy="12" r="3" fill="#1f2937" />
                    </svg>
                  ) : (
                    /* GoCoCo-style closed eye with eyelashes icon */
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M4 10.5C6.2 13.8 9 15 12 15C15 15 17.8 13.8 20 10.5"
                        stroke="#1f2937"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                      />
                      <path d="M6.5 13L4.8 15.6" stroke="#1f2937" strokeWidth="2" strokeLinecap="round" />
                      <path d="M10 14.6L9.2 17.5" stroke="#1f2937" strokeWidth="2" strokeLinecap="round" />
                      <path d="M14 14.6L14.8 17.5" stroke="#1f2937" strokeWidth="2" strokeLinecap="round" />
                      <path d="M17.5 13L19.2 15.6" stroke="#1f2937" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* Forgot Password Pill Button with Person+Key Icon */}
            {mode === "login" && (
              <div className="gococo-pill-ring">
                <button
                  type="button"
                  className="gococo-forgot-pill"
                  onClick={handleForgotPasswordClick}
                >
                  <span>Forgot password?</span>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle cx="10" cy="7" r="3.2" fill="#18181b" />
                    <path
                      d="M4.5 17.5C4.5 14.5 7 12.8 10 12.8C11.3 12.8 12.5 13.1 13.4 13.7"
                      stroke="#18181b"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                    />
                    <circle cx="16.5" cy="16.5" r="2.3" stroke="#18181b" strokeWidth="2" />
                    <path d="M18.8 16.5H22M20.8 16.5V18.5" stroke="#18181b" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            )}

            {error && <p className="gococo-error">{error}</p>}
            {infoMessage && <p className="gococo-info">{infoMessage}</p>}

            {/* "or continue with" social buttons (Google Gmail + Apple ID) */}
            <div className="gococo-divider">or continue with</div>

            <div className="gococo-social-stack">
              {/* Light-blue pill matching GoCoCo screenshot for Google / Gmail */}
              <div className="gococo-pill-ring gococo-pill-ring--blue">
                <button
                  id="auth-google-btn"
                  type="button"
                  className="gococo-social-btn gococo-social-btn--google"
                  onClick={() => handleStartOAuth("google")}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="#4285F4"
                      d="M21.8 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.5c-.2 1.2-1 2.3-2.1 3v2.5h3.4c2-1.8 3-4.5 3-7.4z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 22c2.7 0 5-.9 6.7-2.4l-3.4-2.5c-.9.6-2.1 1-3.3 1-2.6 0-4.8-1.7-5.6-4.1H2.9v2.6C4.6 19.9 8 22 12 22z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H2.9C2.3 8.8 2 10.4 2 12s.3 3.2.9 4.6L6.4 14z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 6.1c1.5 0 2.8.5 3.8 1.5l2.9-2.9C17 3.1 14.7 2 12 2 8 2 4.6 4.1 2.9 7.4L6.4 10c.8-2.4 3-3.9 5.6-3.9z"
                    />
                  </svg>
                  <span>Continue with Google (Gmail)</span>
                </button>
              </div>

              {/* Apple Sign-In pill (Mandatory for iOS App Store Guideline 4.8) */}
              <div className="gococo-pill-ring gococo-pill-ring--apple">
                <button
                  id="auth-apple-btn"
                  type="button"
                  className="gococo-social-btn gococo-social-btn--apple"
                  onClick={() => handleStartOAuth("apple")}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M16.6 12.7c0-2.2 1.8-3.3 1.9-3.4-1-1.5-2.6-1.7-3.2-1.8-1.4-.1-2.6.8-3.3.8-.7 0-1.8-.8-2.9-.8-1.5 0-2.9.9-3.7 2.2-1.6 2.7-.4 6.8 1.1 9 .7 1.1 1.6 2.3 2.8 2.2 1.1 0 1.6-.7 2.9-.7 1.3 0 1.7.7 2.9.7 1.2 0 2-1.1 2.7-2.2.9-1.3 1.2-2.5 1.2-2.6-.1 0-2.4-.9-2.4-3.4zm-2.2-6.7c.6-.8 1.1-1.8.9-2.9-.9 0-2 .6-2.6 1.4-.6.7-1.1 1.8-.9 2.8 1 .1 2-.5 2.6-1.3z" />
                  </svg>
                  <span>Continue with Apple</span>
                </button>
              </div>
            </div>

            {/* Bottom Primary Submit Pill ("Log in [→]") */}
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
                        : "Log in"}
                </span>
                <span className="gococo-submit-icon" aria-hidden="true">
                  →
                </span>
              </button>
            </div>

            {/* Mode Switch + Continue as Guest */}
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

              <button
                id="auth-continue-guest"
                type="button"
                className="gococo-guest-link"
                onClick={onClose}
              >
                Continue as Guest →
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
