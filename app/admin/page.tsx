"use client";

import { useEffect, useState } from "react";
import InfluencerEngine from "@/components/InfluencerEngine";

const SESSION_SECRET_KEY = "heybroc_admin_secret";

export default function AdminPage() {
  const [secretInput, setSecretInput] = useState("");
  const [activeSecret, setActiveSecret] = useState("");
  const [authError, setAuthError] = useState("");
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem(SESSION_SECRET_KEY);
      if (saved) {
        setActiveSecret(saved);
      }
    } catch {
      /* ignore sessionStorage errors */
    }
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = secretInput.trim();
    if (!trimmed) {
      setAuthError("Enter HEYBROC_ADMIN_SECRET to continue.");
      return;
    }
    setVerifying(true);
    setAuthError("");
    try {
      const res = await fetch("/api/influencers", {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      if (!res.ok) {
        setAuthError("Invalid admin secret (or HEYBROC_ADMIN_SECRET is not configured on the server).");
        return;
      }
      try {
        window.sessionStorage.setItem(SESSION_SECRET_KEY, trimmed);
      } catch {
        /* ignore */
      }
      setActiveSecret(trimmed);
      setSecretInput("");
    } catch {
      setAuthError("Network error verifying admin secret.");
    } finally {
      setVerifying(false);
    }
  };

  const handleLogout = () => {
    try {
      window.sessionStorage.removeItem(SESSION_SECRET_KEY);
    } catch {
      /* ignore */
    }
    setActiveSecret("");
  };

  if (!activeSecret) {
    return (
      <main style={{ maxWidth: 460, margin: "80px auto", padding: "0 20px" }}>
        <div className="card" style={{ padding: 28 }}>
          <span className="eyebrow eyebrow--green">HeyBroc Admin</span>
          <h1 style={{ fontSize: 24, margin: "6px 0 8px" }}>Creator Partner Ledger</h1>
          <p className="meta" style={{ marginBottom: 16 }}>
            Enter your <code>HEYBROC_ADMIN_SECRET</code> to manage creator codes and commission splits.
          </p>
          <form onSubmit={handleLogin} style={{ display: "grid", gap: 12 }}>
            <input
              id="admin-secret-input"
              type="password"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              placeholder="HEYBROC_ADMIN_SECRET"
              autoComplete="current-password"
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #d4dbd6", fontSize: 15 }}
            />
            {authError && <p className="error">{authError}</p>}
            <button id="admin-login-btn" type="submit" className="swap-btn" disabled={verifying}>
              {verifying ? "Verifying…" : "Unlock Admin Ledger →"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main style={{ padding: "24px 16px" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <a href="/" className="link-btn">← Back to HeyBroc</a>
        <button type="button" className="link-btn" onClick={handleLogout}>
          Lock Admin Session
        </button>
      </div>
      <InfluencerEngine
        open={true}
        standalone={true}
        adminSecret={activeSecret}
        onUnauthorized={handleLogout}
      />
    </main>
  );
}
