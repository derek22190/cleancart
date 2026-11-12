"use client";

import { useEffect, useState } from "react";

export default function GoogleOAuthCallbackPage() {
  const [status, setStatus] = useState("Completing Google Sign-In…");

  useEffect(() => {
    try {
      const hash = window.location.hash.startsWith("#")
        ? window.location.hash.slice(1)
        : window.location.hash;
      const hashParams = new URLSearchParams(hash);
      const searchParams = new URLSearchParams(window.location.search);

      const idToken =
        hashParams.get("id_token") || searchParams.get("id_token") || "";
      const state = hashParams.get("state") || searchParams.get("state") || "";
      const err =
        hashParams.get("error_description") ||
        hashParams.get("error") ||
        searchParams.get("error_description") ||
        searchParams.get("error") ||
        "";

      if (window.opener && window.opener !== window) {
        window.opener.postMessage(
          {
            type: "heybroc-google-oauth",
            idToken,
            state,
            error: err,
          },
          window.location.origin
        );
        setStatus(err ? "Sign-in cancelled. Closing window…" : "Signed in! Closing window…");
        setTimeout(() => {
          window.close();
        }, 120);
        return;
      }

      if (idToken) {
        window.sessionStorage.setItem("heybroc_pending_google_id_token", idToken);
        if (state) {
          window.sessionStorage.setItem("heybroc_pending_google_state", state);
        }
        window.location.replace("/?login=1");
        return;
      }

      setStatus(err || "No Google token returned. Redirecting back to HeyBroc…");
      setTimeout(() => {
        window.location.replace("/?login=1");
      }, 1500);
    } catch {
      window.location.replace("/?login=1");
    }
  }, []);

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "#f4f3ee",
        color: "#15201b",
        fontFamily: "system-ui, -apple-system, sans-serif",
        textAlign: "center",
      }}
    >
      <div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/broc-mascot.png"
          alt="HeyBroc"
          style={{ width: 56, height: 56, objectFit: "contain", marginBottom: 12 }}
        />
        <p style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{status}</p>
      </div>
    </main>
  );
}
