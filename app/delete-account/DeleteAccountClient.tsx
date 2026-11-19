"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type SessionState =
  | { kind: "loading" }
  | { kind: "signed_out" }
  | { kind: "signed_in"; email: string; token: string }
  | { kind: "deleted"; email: string };

export default function DeleteAccountClient() {
  const [session, setSession] = useState<SessionState>({ kind: "loading" });
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [confirmWord, setConfirmWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function checkSession() {
      try {
        const token =
          typeof window !== "undefined"
            ? (window.localStorage.getItem("heybroc_auth_token") || "").trim()
            : "";
        if (!token) {
          if (active) setSession({ kind: "signed_out" });
          return;
        }
        const res = await fetch("/api/auth", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          user?: { email?: string };
        } | null;
        if (!active) return;
        if (res.ok && data?.ok && data.user?.email) {
          setSession({ kind: "signed_in", email: data.user.email, token });
        } else {
          setSession({ kind: "signed_out" });
        }
      } catch {
        if (active) setSession({ kind: "signed_out" });
      }
    }
    void checkSession();
    return () => {
      active = false;
    };
  }, []);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const email = emailInput.trim();
    if (!email || !passwordInput) {
      setError("Please enter both your email address and password.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", email, password: passwordInput }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        token?: string;
        user?: { email?: string };
        error?: string;
      } | null;
      if (!res.ok || !data?.ok || !data.token || !data.user?.email) {
        setError(data?.error || "Could not sign in with that email and password.");
        return;
      }
      try {
        window.localStorage.setItem("heybroc_auth_token", data.token);
        window.localStorage.setItem("heybroc_user_email", data.user.email);
      } catch {
        // Ignore storage write failures in private browsing
      }
      setPasswordInput("");
      setSession({ kind: "signed_in", email: data.user.email, token: data.token });
    } catch {
      setError("Network error while signing in. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteAccount(e: React.FormEvent) {
    e.preventDefault();
    if (session.kind !== "signed_in") return;
    setError("");
    if (!confirmChecked || confirmWord.trim().toUpperCase() !== "DELETE") {
      setError('Please check the confirmation box and type DELETE to permanently remove your account.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({
          action: "delete_account",
          token: session.token,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!res.ok || !data?.ok) {
        setError(data?.error || "Could not delete your account right now. Please try again.");
        return;
      }
      try {
        window.localStorage.removeItem("heybroc_auth_token");
        window.localStorage.removeItem("heybroc_user_email");
        window.localStorage.removeItem("heybroc_is_pro");
      } catch {
        // Ignore storage clear errors
      }
      setSession({ kind: "deleted", email: session.email });
    } catch {
      setError("Network error while deleting your account. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (session.kind === "loading") {
    return (
      <div
        style={{
          marginTop: 20,
          padding: 20,
          borderRadius: 16,
          border: "1px solid #e2e8f0",
          background: "#f8fafc",
          color: "#475569",
          fontSize: 14,
        }}
      >
        Checking your signed-in session…
      </div>
    );
  }

  if (session.kind === "deleted") {
    return (
      <div
        role="status"
        style={{
          marginTop: 20,
          padding: 22,
          borderRadius: 16,
          border: "1.5px solid #16a34a",
          background: "#f0fdf4",
          color: "#14532d",
        }}
      >
        <h2 style={{ fontSize: 19, margin: "0 0 8px" }}>Account Permanently Deleted</h2>
        <p style={{ margin: "0 0 12px", fontSize: 14.5 }}>
          Your HeyBroc account (<strong>{session.email}</strong>), active sessions, and synced Family Watchlist
          have been permanently deleted from our servers.
        </p>
        <p style={{ margin: "0 0 14px", fontSize: 13.5, color: "#166534" }}>
          If you have an active subscription through Apple App Store or Google Play, remember to cancel renewal in
          your Apple ID or Google Play subscription settings as well.
        </p>
        <Link
          href="/"
          style={{
            display: "inline-block",
            padding: "10px 16px",
            borderRadius: 10,
            background: "#0f7a4a",
            color: "#ffffff",
            fontWeight: 700,
            fontSize: 14,
            textDecoration: "none",
          }}
        >
          Return to HeyBroc
        </Link>
      </div>
    );
  }

  if (session.kind === "signed_in") {
    return (
      <form
        onSubmit={handleDeleteAccount}
        style={{
          marginTop: 20,
          padding: 22,
          borderRadius: 16,
          border: "1.5px solid #fecaca",
          background: "#fff5f5",
        }}
      >
        <p style={{ margin: "0 0 12px", fontSize: 14.5, color: "#1e293b" }}>
          Signed in as <strong>{session.email}</strong>
        </p>
        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            fontSize: 14,
            color: "#7f1d1d",
            marginBottom: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={confirmChecked}
            onChange={(e) => setConfirmChecked(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            I understand that deleting my HeyBroc account permanently removes my login credentials, sessions, and
            synced Family Watchlist and cannot be undone.
          </span>
        </label>
        <div style={{ marginBottom: 14 }}>
          <label
            htmlFor="delete-confirm-word"
            style={{ display: "block", fontSize: 13.5, fontWeight: 600, color: "#7f1d1d", marginBottom: 6 }}
          >
            Type <code>DELETE</code> to confirm
          </label>
          <input
            id="delete-confirm-word"
            type="text"
            value={confirmWord}
            onChange={(e) => setConfirmWord(e.target.value)}
            placeholder="DELETE"
            autoComplete="off"
            style={{
              width: "100%",
              maxWidth: 260,
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #fca5a5",
              fontSize: 14,
              background: "#ffffff",
            }}
          />
        </div>
        {error && (
          <p role="alert" style={{ margin: "0 0 12px", fontSize: 13.5, color: "#b91c1c", fontWeight: 600 }}>
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          style={{
            padding: "11px 18px",
            borderRadius: 10,
            border: "none",
            background: busy ? "#94a3b8" : "#dc2626",
            color: "#ffffff",
            fontWeight: 700,
            fontSize: 14.5,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Deleting Account…" : "Permanently Delete My Account"}
        </button>
      </form>
    );
  }

  return (
    <div
      style={{
        marginTop: 20,
        padding: 22,
        borderRadius: 16,
        border: "1px solid #cbd5e1",
        background: "#f8fafc",
      }}
    >
      <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>Sign In to Delete Your Account Online</h2>
      <p style={{ margin: "0 0 14px", fontSize: 14, color: "#475569" }}>
        Sign in with your HeyBroc email and password below to delete your account immediately. If you created your
        account using Google or Sign in with Apple, first sign in on{" "}
        <Link href="/?login=1" style={{ color: "#0f7a4a", fontWeight: 700 }}>
          heybroc.com
        </Link>{" "}
        and then return to this page.
      </p>
      <form onSubmit={handleSignIn} style={{ display: "grid", gap: 12, maxWidth: 400 }}>
        <div>
          <label htmlFor="del-email" style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            Email address
          </label>
          <input
            id="del-email"
            type="email"
            required
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            placeholder="you@example.com"
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #cbd5e1",
              fontSize: 14,
              background: "#ffffff",
            }}
          />
        </div>
        <div>
          <label htmlFor="del-password" style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            Password
          </label>
          <input
            id="del-password"
            type="password"
            required
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            placeholder="Your HeyBroc password"
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid #cbd5e1",
              fontSize: 14,
              background: "#ffffff",
            }}
          />
        </div>
        {error && (
          <p role="alert" style={{ margin: 0, fontSize: 13.5, color: "#b91c1c", fontWeight: 600 }}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <button
            type="submit"
            disabled={busy}
            style={{
              padding: "10px 18px",
              borderRadius: 10,
              border: "none",
              background: busy ? "#94a3b8" : "#0f7a4a",
              color: "#ffffff",
              fontWeight: 700,
              fontSize: 14,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Signing In…" : "Sign In to Continue"}
          </button>
          <Link
            href="/?login=1"
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #cbd5e1",
              background: "#ffffff",
              color: "#0f172a",
              fontWeight: 600,
              fontSize: 13.5,
              textDecoration: "none",
            }}
          >
            Sign in with Google or Apple →
          </Link>
        </div>
      </form>
    </div>
  );
}
