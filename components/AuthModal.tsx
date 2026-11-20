"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Category } from "@/lib/rubric";
import CancelRetentionModal from "./CancelRetentionModal";

export interface AuthenticatedUser {
  userId: string;
  email: string;
  displayName: string;
  provider: "email" | "google" | "apple";
  emailVerified?: boolean;
  referralCode: string;
  proUntil: number;
  isProActive: boolean;
  isLifetimePro?: boolean;
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
  initialTab?: "signup" | "signin";
  bannerMessage?: string;
  readyHeading?: string;
  readySubheading?: string;
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
  initialTab = "signin",
  bannerMessage = "",
  readyHeading = "",
  readySubheading = "",
}: AuthModalProps) {
  const [mode, setMode] = useState<"login" | "forgot">("login");
  const [authTab, setAuthTab] = useState<"signup" | "signin">(initialTab);
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [appleBusy, setAppleBusy] = useState(false);
  const [googleClientId, setGoogleClientId] = useState<string>(
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || ""
  );
  const [appleClientId, setAppleClientId] = useState<string>(
    process.env.NEXT_PUBLIC_APPLE_CLIENT_ID || ""
  );
  const [error, setError] = useState("");
  const [infoMessage, setInfoMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [cancelRetentionOpen, setCancelRetentionOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setMode("login");
      setAuthTab(initialTab);
      setShowEmailForm(false);
      setError("");
      setInfoMessage("");
    }
  }, [open, initialTab]);

  const openBillingPortalDirect = useCallback(async () => {
    if (!user) return;
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
  }, [deviceId, user]);

  // Lock background page scroll while modal is open so touch-scrolling stays inside the dialog
  useEffect(() => {
    if (!open) {
      setCancelRetentionOpen(false);
      return;
    }
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

  const exchangeOAuthIdToken = useCallback(
    async (
      provider: "google" | "apple",
      idToken: string,
      overrideEmail?: string,
      overrideName?: string,
      expectedNonce?: string,
      authorizationCode?: string
    ) => {
      if (provider === "google") setGoogleBusy(true);
      if (provider === "apple") setAppleBusy(true);
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
            provider,
            idToken,
            ...(authorizationCode ? { authorizationCode } : {}),
            ...(expectedNonce ? { nonce: expectedNonce } : {}),
            email: (overrideEmail || claims.email || "").trim(),
            displayName: (overrideName || claims.name || "").trim() || undefined,
            deviceId,
            deviceSecret: devSecret || undefined,
            watchlist,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok || !data.user || !data.token) {
          setError(
            data.error ||
              (provider === "apple"
                ? "Could not verify Apple account. Please try again."
                : "Could not verify Google account. Please try again.")
          );
          return;
        }
        onAuthSuccess(data.user as AuthenticatedUser, data.token as string);
        onClose();
      } catch {
        setError(
          provider === "apple"
            ? "Network error completing Sign in with Apple. Please try again."
            : "Network error completing Google Sign-In. Please try again."
        );
      } finally {
        setGoogleBusy(false);
        setAppleBusy(false);
        setBusy(false);
      }
    },
    [deviceId, watchlist, onAuthSuccess, onClose]
  );

  const serverOAuthNonceRef = useRef<string>("");
  const pendingNativeAppleNonceRef = useRef<string>("");

  const replenishServerOAuthNonce = useCallback(() => {
    fetch("/api/auth?oauthNonce=1")
      .then((r) => r.json())
      .then((d: { oauthNonce?: string }) => {
        if (d?.oauthNonce && String(d.oauthNonce).trim().startsWith("srvn_")) {
          serverOAuthNonceRef.current = String(d.oauthNonce).trim();
        }
      })
      .catch(() => {});
  }, []);

  const ensureFreshOAuthNonce = useCallback(async (): Promise<string> => {
    if (serverOAuthNonceRef.current && serverOAuthNonceRef.current.startsWith("srvn_")) {
      const issued = serverOAuthNonceRef.current;
      serverOAuthNonceRef.current = "";
      replenishServerOAuthNonce();
      return issued;
    }
    try {
      const cfg = await fetch("/api/auth?oauthNonce=1").then((r) => r.json());
      if (cfg?.oauthNonce && String(cfg.oauthNonce).trim().startsWith("srvn_")) {
        const issued = String(cfg.oauthNonce).trim();
        replenishServerOAuthNonce();
        return issued;
      }
    } catch {
      // Handled by caller if empty
    }
    return "";
  }, [replenishServerOAuthNonce]);

  const launchWebAppleOAuth = useCallback(
    async (knownClientId?: string) => {
      let resolvedAppleId = (knownClientId ?? appleClientId).trim();
      if (!resolvedAppleId) {
        const cfg = await fetch("/api/auth?config=1")
          .then((r) => r.json())
          .catch(() => null);
        if (cfg?.appleClientId) {
          resolvedAppleId = String(cfg.appleClientId).trim();
          setAppleClientId(resolvedAppleId);
        }
        if (cfg?.oauthNonce) {
          serverOAuthNonceRef.current = String(cfg.oauthNonce).trim();
        }
      }

      if (!resolvedAppleId) {
        setAppleBusy(false);
        const isIosWv =
          typeof window !== "undefined" &&
          Boolean(
            (window as unknown as { webkit?: { messageHandlers?: unknown } }).webkit
              ?.messageHandlers || /HeyBrocIOS/i.test(navigator.userAgent || "")
          );
        setShowEmailForm(true);
        setInfoMessage(
          isIosWv
            ? "Sign in with Apple is temporarily unavailable. Continue with your email below to sign in or create your account."
            : "Sign in with Apple on Web is temporarily unavailable — continue with your email below."
        );
        return;
      }

      const nonce = await ensureFreshOAuthNonce();
      if (!nonce) {
        setAppleBusy(false);
        setError("Could not initialize secure Sign in with Apple session. Please check your connection and try again.");
        return;
      }
      const stateBytes = new Uint8Array(12);
      window.crypto.getRandomValues(stateBytes);
      const state = `hba_${Array.from(stateBytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
      window.sessionStorage.setItem("heybroc_apple_oauth_state", state);
      window.sessionStorage.setItem("heybroc_apple_oauth_nonce", nonce);

      const redirectUri = `${window.location.origin}/api/auth/apple-callback`;
      const authUrl = new URL("https://appleid.apple.com/auth/authorize");
      authUrl.searchParams.set("client_id", resolvedAppleId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code id_token");
      authUrl.searchParams.set("response_mode", "form_post");
      authUrl.searchParams.set("scope", "name email");
      authUrl.searchParams.set("nonce", nonce);
      authUrl.searchParams.set("state", state);

      const width = 500;
      const height = 620;
      const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
      const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
      setAppleBusy(true);
      const popup = window.open(
        authUrl.toString(),
        "heybroc_apple_auth",
        `popup=yes,width=${width},height=${height},left=${left},top=${top}`
      );
      if (!popup) {
        window.location.assign(authUrl.toString());
        return;
      }
      const pollClosed = window.setInterval(() => {
        if (popup.closed) {
          window.clearInterval(pollClosed);
          setAppleBusy(false);
        }
      }, 600);
    },
    [appleClientId, ensureFreshOAuthNonce]
  );

  // Fetch server-configured GOOGLE_CLIENT_ID / APPLE_SERVICE_ID and consume any pending mobile redirect token
  useEffect(() => {
    if (!open && typeof window !== "undefined") {
      const pendingG = window.sessionStorage.getItem("heybroc_pending_google_id_token");
      const pendingA = window.sessionStorage.getItem("heybroc_pending_apple_id_token");
      if (!pendingG && !pendingA) return;
    }
    let cancelled = false;

    if (!googleClientId || !appleClientId || !serverOAuthNonceRef.current) {
      fetch("/api/auth?config=1")
        .then((r) => r.json())
        .then((d: { googleClientId?: string; appleClientId?: string; oauthNonce?: string }) => {
          if (cancelled) return;
          if (d?.googleClientId) setGoogleClientId(d.googleClientId);
          if (d?.appleClientId) setAppleClientId(d.appleClientId);
          if (d?.oauthNonce) serverOAuthNonceRef.current = String(d.oauthNonce).trim();
        })
        .catch(() => {});
    }

    if (typeof window !== "undefined") {
      const pendingToken = window.sessionStorage.getItem("heybroc_pending_google_id_token");
      const pendingState = window.sessionStorage.getItem("heybroc_pending_google_state");
      const expectedState = window.sessionStorage.getItem("heybroc_oauth_state");
      const expectedNonce = window.sessionStorage.getItem("heybroc_oauth_nonce") || undefined;
      if (pendingToken) {
        window.sessionStorage.removeItem("heybroc_pending_google_id_token");
        window.sessionStorage.removeItem("heybroc_pending_google_state");
        window.sessionStorage.removeItem("heybroc_oauth_state");
        window.sessionStorage.removeItem("heybroc_oauth_nonce");
        if (expectedState && pendingState && expectedState === pendingState && expectedNonce) {
          void exchangeOAuthIdToken("google", pendingToken, undefined, undefined, expectedNonce);
        } else {
          setError("Google sign-in session expired or state mismatch. Please try again.");
        }
      }

      const pendingAppleToken = window.sessionStorage.getItem("heybroc_pending_apple_id_token");
      const pendingAppleAuthCode = window.sessionStorage.getItem("heybroc_pending_apple_auth_code") || undefined;
      const pendingAppleState = window.sessionStorage.getItem("heybroc_pending_apple_state");
      const pendingAppleName = window.sessionStorage.getItem("heybroc_pending_apple_name") || "";
      const pendingAppleEmail = window.sessionStorage.getItem("heybroc_pending_apple_email") || "";
      const expectedAppleState = window.sessionStorage.getItem("heybroc_apple_oauth_state");
      const expectedAppleNonce = window.sessionStorage.getItem("heybroc_apple_oauth_nonce") || undefined;
      if (pendingAppleToken) {
        window.sessionStorage.removeItem("heybroc_pending_apple_id_token");
        window.sessionStorage.removeItem("heybroc_pending_apple_auth_code");
        window.sessionStorage.removeItem("heybroc_pending_apple_state");
        window.sessionStorage.removeItem("heybroc_pending_apple_name");
        window.sessionStorage.removeItem("heybroc_pending_apple_email");
        window.sessionStorage.removeItem("heybroc_apple_oauth_state");
        window.sessionStorage.removeItem("heybroc_apple_oauth_nonce");
        if (expectedAppleState && pendingAppleState && expectedAppleState === pendingAppleState && expectedAppleNonce) {
          void exchangeOAuthIdToken(
            "apple",
            pendingAppleToken,
            pendingAppleEmail,
            pendingAppleName,
            expectedAppleNonce,
            pendingAppleAuthCode
          );
        } else {
          setError("Apple sign-in session expired or state mismatch. Please try again.");
        }
      }

      // Register native iOS ASAuthorizationAppleIDProvider callback bridge
      (
        window as unknown as {
          __heybrocNativeAppleAuth?: (res: {
            idToken?: string;
            authorizationCode?: string;
            nonce?: string;
            email?: string;
            displayName?: string;
            canceled?: boolean;
            fallbackWebOAuth?: boolean;
            error?: string;
          }) => void;
        }
      ).__heybrocNativeAppleAuth = (res) => {
        if (cancelled) return;
        const issuedNativeNonce = res?.nonce || pendingNativeAppleNonceRef.current || undefined;
        pendingNativeAppleNonceRef.current = "";
        if (res?.canceled) {
          setAppleBusy(false);
          return;
        }
        if (res?.fallbackWebOAuth) {
          void launchWebAppleOAuth();
          return;
        }
        if (res?.error) {
          setAppleBusy(false);
          setError(res.error);
          return;
        }
        if (res?.idToken) {
          void exchangeOAuthIdToken(
            "apple",
            res.idToken,
            res.email,
            res.displayName,
            issuedNativeNonce,
            res.authorizationCode
          );
        } else {
          setAppleBusy(false);
        }
      };
    }

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const payload = event.data as
        | {
            type?: string;
            idToken?: string;
            authorizationCode?: string;
            state?: string;
            displayName?: string;
            email?: string;
            error?: string;
          }
        | undefined;
      if (!payload) return;

      if (payload.type === "heybroc-google-oauth") {
        const expectedState = window.sessionStorage.getItem("heybroc_oauth_state");
        const expectedNonce = window.sessionStorage.getItem("heybroc_oauth_nonce") || undefined;
        window.sessionStorage.removeItem("heybroc_oauth_state");
        window.sessionStorage.removeItem("heybroc_oauth_nonce");
        if (!expectedState || !payload.state || expectedState !== payload.state || !expectedNonce) {
          setGoogleBusy(false);
          setError("Google sign-in state mismatch. Please try again.");
          return;
        }
        if (payload.error) {
          setGoogleBusy(false);
          if (payload.error !== "access_denied" && payload.error !== "cancelled") {
            setError("Google sign-in was cancelled or couldn't complete.");
          }
          return;
        }
        if (payload.idToken) {
          void exchangeOAuthIdToken("google", payload.idToken, undefined, undefined, expectedNonce);
        }
      } else if (payload.type === "heybroc-apple-oauth") {
        const expectedState = window.sessionStorage.getItem("heybroc_apple_oauth_state");
        const expectedAppleNonce = window.sessionStorage.getItem("heybroc_apple_oauth_nonce") || undefined;
        window.sessionStorage.removeItem("heybroc_apple_oauth_state");
        window.sessionStorage.removeItem("heybroc_apple_oauth_nonce");
        if (!expectedState || !payload.state || expectedState !== payload.state || !expectedAppleNonce) {
          setAppleBusy(false);
          setError("Apple sign-in state mismatch. Please try again.");
          return;
        }
        if (payload.error) {
          setAppleBusy(false);
          if (payload.error !== "user_cancelled_authorize" && payload.error !== "access_denied") {
            setError("Sign in with Apple was cancelled or couldn't complete.");
          }
          return;
        }
        if (payload.idToken) {
          void exchangeOAuthIdToken(
            "apple",
            payload.idToken,
            payload.email,
            payload.displayName,
            expectedAppleNonce,
            payload.authorizationCode
          );
        }
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
    };
  }, [open, googleClientId, appleClientId, exchangeOAuthIdToken, launchWebAppleOAuth]);

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
      if (cfg?.oauthNonce) {
        serverOAuthNonceRef.current = String(cfg.oauthNonce).trim();
      }
    }

    if (!resolvedClientId) {
      setShowEmailForm(true);
      setInfoMessage(
        "Google Sign-In is temporarily unavailable — sign in or create your account with email below."
      );
      return;
    }

    const nonce = await ensureFreshOAuthNonce();
    if (!nonce) {
      setError("Could not initialize secure Google Sign-In session. Please check your connection and try again.");
      return;
    }
    const win = window as unknown as {
      __HEYBROC_NATIVE_GOOGLE_AUTH__?: boolean;
      webkit?: {
        messageHandlers?: {
          controller?: { postMessage?: (msg: unknown) => void };
          heybrocNative?: { postMessage?: (msg: unknown) => void };
        };
      };
    };
    const controllerBridge =
      win.webkit?.messageHandlers?.controller ?? win.webkit?.messageHandlers?.heybrocNative;
    const useNativeIosGoogle = Boolean(
      win.__HEYBROC_NATIVE_GOOGLE_AUTH__ && typeof controllerBridge?.postMessage === "function"
    );

    const randomBytes = new Uint8Array(16);
    window.crypto.getRandomValues(randomBytes);
    const hex = Array.from(randomBytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const state = useNativeIosGoogle ? `ios_${hex}` : `hb_${hex}`;
    window.sessionStorage.setItem("heybroc_oauth_state", state);
    window.sessionStorage.setItem("heybroc_oauth_nonce", nonce);

    const redirectUri = `${window.location.origin}/auth/google-callback`;
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", resolvedClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "id_token");
    authUrl.searchParams.set("scope", "openid email profile");
    authUrl.searchParams.set("prompt", "select_account");
    authUrl.searchParams.set("nonce", nonce);
    authUrl.searchParams.set("state", state);

    if (useNativeIosGoogle && controllerBridge?.postMessage) {
      setGoogleBusy(true);
      try {
        controllerBridge.postMessage({
          action: "googleSignIn",
          authUrl: authUrl.toString(),
          state,
        });
        return;
      } catch {
        setGoogleBusy(false);
        setError("Could not launch Google Sign-In. Please try again or continue with email.");
        return;
      }
    }

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

  const handleAppleSignInClick = async () => {
    setError("");
    setInfoMessage("");

    if (typeof window !== "undefined") {
      const win = window as unknown as {
        __HEYBROC_NATIVE_APPLE_AUTH__?: boolean;
        webkit?: {
          messageHandlers?: {
            controller?: { postMessage?: (msg: unknown) => void };
            heybrocNative?: { postMessage?: (msg: unknown) => void };
          };
        };
      };
      const controllerBridge = win.webkit?.messageHandlers?.controller;
      const nativeBridge = win.webkit?.messageHandlers?.heybrocNative;
      if (win.__HEYBROC_NATIVE_APPLE_AUTH__ && typeof controllerBridge?.postMessage === "function") {
        setAppleBusy(true);
        const nonce = await ensureFreshOAuthNonce();
        pendingNativeAppleNonceRef.current = nonce;
        try {
          controllerBridge.postMessage({ action: "apple-sign-in", ...(nonce ? { nonce } : {}) });
          return;
        } catch {
          pendingNativeAppleNonceRef.current = "";
          setAppleBusy(false);
        }
      } else if (win.__HEYBROC_NATIVE_APPLE_AUTH__ && typeof nativeBridge?.postMessage === "function") {
        setAppleBusy(true);
        const nonce = await ensureFreshOAuthNonce();
        pendingNativeAppleNonceRef.current = nonce;
        try {
          nativeBridge.postMessage({ action: "apple-sign-in", ...(nonce ? { nonce } : {}) });
          return;
        } catch {
          pendingNativeAppleNonceRef.current = "";
          setAppleBusy(false);
        }
      }
    }

    await launchWebAppleOAuth();
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
      const primaryAction =
        mode === "forgot"
          ? "reset_password"
          : authTab === "signup"
            ? "register"
            : "login";
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

      let { res, data } = await sendRequest(primaryAction);
      if (
        (!res.ok || !data.ok) &&
        primaryAction === "login" &&
        typeof data.error === "string" &&
        data.error.toLowerCase().includes("no account found")
      ) {
        ({ res, data } = await sendRequest("register"));
      } else if (
        (!res.ok || !data.ok) &&
        primaryAction === "register" &&
        typeof data.error === "string" &&
        data.error.toLowerCase().includes("already")
      ) {
        ({ res, data } = await sendRequest("login"));
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

  const isEmailExpanded = showEmailForm || mode === "forgot";
  const hasReadyScrim = Boolean(!user && !isEmailExpanded && readyHeading.trim());
  const isIosWebView =
    typeof window !== "undefined" &&
    (/HeyBrocIOS/i.test(window.navigator?.userAgent || "") ||
      Boolean(
        (
          window as unknown as {
            webkit?: { messageHandlers?: { controller?: unknown } };
          }
        ).webkit?.messageHandlers?.controller,
      ));

  const loggedOutTitle =
    mode === "forgot"
      ? "Reset password"
      : !isEmailExpanded
        ? hasReadyScrim
          ? "Just one last thing"
          : authTab === "signup"
            ? "Save your progress"
            : "Sign in to HeyBroc"
        : authTab === "signup"
          ? "Create Free Account"
          : "Sign in with email";

  return (
    <div
      className={`modal-backdrop gococo-auth-backdrop${!user ? " gococo-auth-backdrop--sheet" : ""}${hasReadyScrim ? " gococo-auth-backdrop--has-ready" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={user ? "Your HeyBroc Account" : loggedOutTitle}
      onClick={onClose}
    >
      {hasReadyScrim && (
        <div className="gococo-ready-scrim" aria-live="polite">
          <div className="gococo-ready-scrim__icon" aria-hidden="true">
            ✓
          </div>
          <div className="gococo-ready-scrim__title">{readyHeading}</div>
          {readySubheading && (
            <p className="gococo-ready-scrim__sub">{readySubheading}</p>
          )}
        </div>
      )}

      <div
        className={`gococo-auth-card${!user ? " gococo-auth-card--sheet" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        {!user && <div className="gococo-sheet-handle" aria-hidden="true" />}

        {user || isEmailExpanded ? (
          /* Compact Header Row for Logged-In Account or Expanded Email View */
          <div className="gococo-top-row">
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              {!user ? (
                <button
                  type="button"
                  className="gococo-back-btn"
                  onClick={() => {
                    if (mode === "forgot") {
                      setMode("login");
                    } else {
                      setShowEmailForm(false);
                    }
                    setError("");
                    setInfoMessage("");
                  }}
                  aria-label={mode === "forgot" ? "Back to email sign in" : "Back to 1-tap sign in"}
                >
                  ←
                </button>
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src="/broc-mascot.png"
                  alt="HeyBroc"
                  style={{ width: 38, height: 38, objectFit: "contain", flexShrink: 0 }}
                />
              )}
              <div>
                <h2 className="gococo-title">
                  {user ? "Account" : loggedOutTitle}
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
        ) : (
          <button
            type="button"
            className="gococo-sheet-close-corner"
            onClick={onClose}
            aria-label="Close sign in dialog"
          >
            ✕
          </button>
        )}

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
                    ? user.isLifetimePro || user.proDaysRemaining >= 10000
                      ? "★ Lifetime Family Pro Active"
                      : user.entitlementStatus === "trialing"
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

            {!(user.isLifetimePro || user.proDaysRemaining >= 10000) && (
              <button
                id="account-manage-subscription"
                type="button"
                className="gococo-forgot-pill"
                disabled={busy}
                onClick={() => setCancelRetentionOpen(true)}
              >
                <span>Manage / Cancel subscription</span>
              </button>
            )}

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
        ) : !isEmailExpanded ? (
          /* ================= COMPACT 1-TAP BOTTOM SHEET (APPLE + GOOGLE FIRST) ================= */
          <div className="gococo-form" style={{ gap: 11, paddingTop: 4 }}>
            <div style={{ textAlign: "center", padding: "0 22px 4px" }}>
              <h2 className="gococo-title" style={{ fontSize: 21, marginBottom: 5 }}>
                {loggedOutTitle}
              </h2>
              <p className="gococo-subtitle" style={{ margin: 0, fontSize: 13.5 }}>
                {bannerMessage ||
                  (hasReadyScrim
                    ? "Choose how to save your progress."
                    : authTab === "signup"
                      ? "Choose how to save your Watchlist & swaps."
                      : "Sign back in to restore your Watchlist & Pro access.")}
              </p>
            </div>

            <button
              id="auth-apple-btn"
              type="button"
              disabled={busy || googleBusy || appleBusy}
              onClick={() => void handleAppleSignInClick()}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                padding: "13px 18px",
                borderRadius: 999,
                background: "#000000",
                border: "1.5px solid #000000",
                color: "#ffffff",
                fontWeight: 800,
                fontSize: 15.5,
                cursor: busy || googleBusy || appleBusy ? "wait" : "pointer",
                boxShadow: "0 3px 10px rgba(0, 0, 0, 0.16)",
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="#ffffff" aria-hidden="true">
                <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
              </svg>
              <span>{appleBusy ? "Opening Apple ID…" : "Continue with Apple"}</span>
            </button>

            {!isIosWebView && (
              <button
                id="auth-google-btn"
                type="button"
                disabled={busy || googleBusy || appleBusy}
                onClick={() => void handleGoogleSignInClick()}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                  padding: "13px 18px",
                  borderRadius: 999,
                  background: "#ffffff",
                  border: "1.5px solid #cbd5e1",
                  color: "#0f172a",
                  fontWeight: 800,
                  fontSize: 15.5,
                  cursor: busy || googleBusy || appleBusy ? "wait" : "pointer",
                  boxShadow: "0 1px 4px rgba(15, 23, 42, 0.06)",
                }}
              >
                <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true">
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
            )}

            <p className="gococo-auth-microcopy">One tap. No password needed.</p>

            {error && <p className="gococo-error">{error}</p>}
            {infoMessage && <p className="gococo-info">{infoMessage}</p>}

            <button
              id="auth-use-email-btn"
              type="button"
              className="gococo-email-toggle-btn"
              onClick={() => {
                setShowEmailForm(true);
                setError("");
                setInfoMessage("");
              }}
            >
              Use email instead
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
          </div>
        ) : (
          /* ================= EXPANDED EMAIL / PASSWORD VIEW ================= */
          <form onSubmit={handleEmailSubmit} className="gococo-form">
            {mode !== "forgot" && (
              <div
                role="tablist"
                aria-label="Choose Create Account or Sign In"
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 4,
                  padding: 4,
                  borderRadius: 999,
                  background: "#f1f5f9",
                  border: "1px solid #e2e8f0",
                }}
              >
                <button
                  id="auth-tab-signup"
                  type="button"
                  role="tab"
                  aria-selected={authTab === "signup"}
                  onClick={() => {
                    setAuthTab("signup");
                    setError("");
                  }}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 999,
                    border: "none",
                    background: authTab === "signup" ? "#ffffff" : "transparent",
                    color: authTab === "signup" ? "#0f7a4a" : "#475569",
                    fontWeight: 800,
                    fontSize: 13,
                    cursor: "pointer",
                    boxShadow:
                      authTab === "signup" ? "0 1px 4px rgba(15, 23, 42, 0.08)" : "none",
                  }}
                >
                  Create Free Account
                </button>
                <button
                  id="auth-tab-signin"
                  type="button"
                  role="tab"
                  aria-selected={authTab === "signin"}
                  onClick={() => {
                    setAuthTab("signin");
                    setError("");
                  }}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 999,
                    border: "none",
                    background: authTab === "signin" ? "#ffffff" : "transparent",
                    color: authTab === "signin" ? "#0f172a" : "#475569",
                    fontWeight: 800,
                    fontSize: 13,
                    cursor: "pointer",
                    boxShadow:
                      authTab === "signin" ? "0 1px 4px rgba(15, 23, 42, 0.08)" : "none",
                  }}
                >
                  Sign In
                </button>
              </div>
            )}

            <p className="gococo-subtitle" style={{ margin: "0 0 2px" }}>
              {mode === "forgot"
                ? "Enter your email, 6-digit reset code, and a new password (8+ chars)."
                : authTab === "signup"
                  ? "Save your Watchlist & Clean Swaps across iPhone and Web (free — no credit card required)."
                  : "Sign back in to restore your saved Family Watchlist, Favorites & Pro membership."}
            </p>

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
                  autoComplete={authTab === "signup" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={
                    mode === "forgot"
                      ? "New password (8+ chars)"
                      : authTab === "signup"
                        ? "Create password (8+ chars)"
                        : "Password (8+ chars)"
                  }
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

            {mode === "login" && authTab === "signin" && (
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
                  ? authTab === "signup"
                    ? "Creating account…"
                    : "Signing in…"
                  : mode === "forgot"
                    ? "Save new password"
                    : authTab === "signup"
                      ? "Create Free Account"
                      : "Sign In"}
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
      <CancelRetentionModal
        open={cancelRetentionOpen}
        onClose={() => setCancelRetentionOpen(false)}
        onProceedToPortal={openBillingPortalDirect}
        portalBusy={busy}
        deviceId={deviceId}
        userEmail={user?.email}
      />
    </div>
  );
}
