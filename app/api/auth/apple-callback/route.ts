/**
 * HeyBroc — Sign in with Apple Web OAuth Callback (`/api/auth/apple-callback`)
 * ---------------------------------------------------------------------------
 * Apple Web OAuth (`response_mode=form_post` or query/fragment fallback) posts
 * `id_token`, `state`, `error`, and first-time `user` JSON (`{ name: { firstName, lastName }, email }`)
 * to this endpoint. Renders a minimal HTML bridge that relays the verified payload back to
 * `window.opener` (`postMessage`) or `sessionStorage` + redirect (`/?login=1`) on mobile browsers.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AppleUserPayload {
  name?: {
    firstName?: string;
    lastName?: string;
  };
  email?: string;
}

function buildBridgeHtml(payload: {
  idToken: string;
  state: string;
  displayName: string;
  email: string;
  error: string;
}): NextResponse {
  const safeJson = JSON.stringify({
    type: "heybroc-apple-oauth",
    idToken: payload.idToken,
    state: payload.state,
    displayName: payload.displayName,
    email: payload.email,
    error: payload.error,
  }).replace(/</g, "\\u003c");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Completing Sign in with Apple — HeyBroc</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #0f172a;
    }
    .box {
      padding: 24px 28px;
      border-radius: 20px;
      background: #fff;
      border: 1px solid #e2e8f0;
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08);
      text-align: center;
      font-weight: 700;
      font-size: 15px;
    }
  </style>
</head>
<body>
  <div class="box">Completing Sign in with Apple…</div>
  <script>
    (function () {
      var data = ${safeJson};
      if (!data.idToken && window.location.hash) {
        var hp = new URLSearchParams(window.location.hash.replace(/^#/, ""));
        data.idToken = hp.get("id_token") || "";
        data.state = data.state || hp.get("state") || "";
        data.error = data.error || hp.get("error") || "";
      }
      if (window.opener && !window.opener.closed) {
        try {
          window.opener.postMessage(data, window.location.origin);
          window.close();
          return;
        } catch (e) {}
      }
      if (data.idToken) {
        try {
          sessionStorage.setItem("heybroc_pending_apple_id_token", data.idToken);
          if (data.state) sessionStorage.setItem("heybroc_pending_apple_state", data.state);
          if (data.displayName) sessionStorage.setItem("heybroc_pending_apple_name", data.displayName);
          if (data.email) sessionStorage.setItem("heybroc_pending_apple_email", data.email);
        } catch (e) {}
      }
      window.location.replace("/?login=1");
    })();
  </script>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const idToken = String(form.get("id_token") || "").trim();
    const state = String(form.get("state") || "").trim();
    const error = String(form.get("error") || "").trim();
    const rawUser = String(form.get("user") || "").trim();

    let displayName = "";
    let email = "";
    if (rawUser) {
      try {
        const parsed = JSON.parse(rawUser) as AppleUserPayload;
        const first = (parsed.name?.firstName || "").trim();
        const last = (parsed.name?.lastName || "").trim();
        displayName = [first, last].filter(Boolean).join(" ").trim();
        email = (parsed.email || "").trim();
      } catch {
        /* ignore malformed user JSON */
      }
    }

    return buildBridgeHtml({ idToken, state, displayName, email, error });
  } catch {
    return buildBridgeHtml({
      idToken: "",
      state: "",
      displayName: "",
      email: "",
      error: "invalid_apple_callback",
    });
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  return buildBridgeHtml({
    idToken: (searchParams.get("id_token") || "").trim(),
    state: (searchParams.get("state") || "").trim(),
    displayName: "",
    email: "",
    error: (searchParams.get("error") || "").trim(),
  });
}
