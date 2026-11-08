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
                  ? "Enter your email and choose a new password below."
                  : "Sign in to save your scans, Family Watchlist & Clean Swaps across devices."}
            </p>

            {/* Primary 1-Tap Social Sign-In Buttons (Official Gmail 'M' + Apple Logos) */}
            {mode !== "forgot" && (
              <>
                <div className="gococo-social-stack">
                  <button
                    id="auth-google-btn"
                    type="button"
                    className="gococo-social-btn"
                    style={{
                      background: "#ffffff",
                      color: "#1f1f1f",
                      border: "1.5px solid #dadce0",
                      borderRadius: 999,
                      padding: "14px 20px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 12,
                      fontWeight: 700,
                      fontSize: 15.5,
                      width: "100%",
                      cursor: "pointer",
                    }}
                    onClick={() => handleStartOAuth("google")}
                  >
                    {/* Exact Official 5-Color Gmail 'M' Vector Symbol */}
                    <svg width="22" height="17" viewBox="0 0 88 66" aria-hidden="true">
                      <path fill="#4285F4" d="M6 66h14V32L0 17v43c0 3.315 2.685 6 6 6z" />
                      <path fill="#34A853" d="M68 66h14c3.315 0 6-2.685 6-6V17L68 32v34z" />
                      <path fill="#FBBC04" d="M68 6v26l20-15V9c0-7.41-8.465-11.65-14.4-7.2L68 6z" />
                      <path fill="#EA4335" d="M20 32V6l24 18L68 6v26L44 50 20 32z" />
                      <path fill="#C5221F" d="M0 9v8l20 15V6L14.4 1.8C8.465-2.65 0 1.59 0 9z" />
                    </svg>
                    <span>Continue with Gmail</span>
                  </button>

                  <button
                    id="auth-apple-btn"
                    type="button"
                    className="gococo-social-btn"
                    style={{
                      background: "#000000",
                      color: "#ffffff",
                      border: "1.5px solid #000000",
                      borderRadius: 999,
                      padding: "14px 20px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 12,
                      fontWeight: 700,
                      fontSize: 15.5,
                      width: "100%",
                      cursor: "pointer",
                    }}
                    onClick={() => handleStartOAuth("apple")}
                  >
                    {/* Exact Official Apple Vector Symbol */}
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="#ffffff" aria-hidden="true">
                      <path d="M16.6 12.7c0-2.2 1.8-3.3 1.9-3.4-1-1.5-2.6-1.7-3.2-1.8-1.4-.1-2.6.8-3.3.8-.7 0-1.8-.8-2.9-.8-1.5 0-2.9.9-3.7 2.2-1.6 2.7-.4 6.8 1.1 9 .7 1.1 1.6 2.3 2.8 2.2 1.1 0 1.6-.7 2.9-.7 1.3 0 1.7.7 2.9.7 1.2 0 2-1.1 2.7-2.2.9-1.3 1.2-2.5 1.2-2.6-.1 0-2.4-.9-2.4-3.4zm-2.2-6.7c.6-.8 1.1-1.8.9-2.9-.9 0-2 .6-2.6 1.4-.6.7-1.1 1.8-.9 2.8 1 .1 2-.5 2.6-1.3z" />
                    </svg>
                    <span>Continue with Apple</span>
                  </button>
                </div>

                <div className="gococo-divider">or continue with email</div>
              </>
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
                  placeholder={mode === "forgot" ? "New password (6+ chars)" : "Password"}
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
