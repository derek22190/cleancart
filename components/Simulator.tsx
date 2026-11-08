"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ALL_CATEGORIES,
  CATEGORY_LABELS,
  DEFAULT_WATCHLIST,
  scoreProductYuka,
  type Category,
  type FlaggedAdditive,
  type NutritionInput,
  type ScoreResult,
} from "@/lib/rubric";

const gradeProduct = (
  title: string,
  ingredients: string,
  watchlist: Record<Category, boolean>,
  nutrition?: NutritionInput,
  familyWatchlist: Category[] = [],
): ScoreResult =>
  scoreProductYuka(ingredients, watchlist, familyWatchlist, { ...nutrition, productTitle: title });
import { PRESETS } from "@/lib/presets";
import {
  CLEAN_ALTERNATIVES,
  DIRTY_FALLBACK_IMAGES,
  STORE_META,
  STORES,
  detectCategory,
  resolveCleanAlternative,
  resolveSwap,
  type Store,
  type SwapCategory,
  type SwapResult,
} from "@/lib/swaps";
import AuthModal, { type AuthenticatedUser } from "./AuthModal";
import Paywall, { type AppliedCreator } from "./Paywall";
import Scorecard, { type SwapRecord } from "./Scorecard";
import WatchlistMiniFunnel from "./WatchlistMiniFunnel";

/* ------------------------------------------------------------------ */
/* Types & helpers                                                     */
/* ------------------------------------------------------------------ */

type Origin = "preset" | "live" | "swap";

interface Product {
  key: string;
  title: string;
  brand: string;
  description?: string;
  size?: string;
  price?: number;
  image?: string;
  ingredients: string;
  nutrition?: NutritionInput;
  category?: SwapCategory;
  origin: Origin;
  replacedItem?: Product;
  lookup?: { source: string; origin?: string; ms: number };
}

interface ApiScan {
  ok: boolean;
  error?: string;
  product?: {
    title: string;
    brand?: string;
    category?: string;
    description?: string;
    barcode?: string;
    imageUrl?: string;
    ingredients: string;
    nutrition?: NutritionInput;
  };
  lookup?: { source: string; origin?: string; ms: number };
  result?: ScoreResult;
  swap?: SwapResult | null;
}

type Watch = Record<Category, boolean>;
type OverlayState = "pill" | "card" | "min";
type ViewMode = "product" | "search";

const FREE_SCAN_LIMIT = 5;

const presetToProduct = (p: (typeof PRESETS)[number]): Product => ({
  key: p.id,
  title: p.title,
  brand: p.brand,
  size: p.size,
  price: p.price,
  image: p.image,
  ingredients: p.ingredients,
  category: p.category,
  origin: "preset",
});

const cleanToProduct = (cat: SwapCategory, replacedItem?: Product): Product => {
  const alt = replacedItem
    ? resolveCleanAlternative(`${replacedItem.brand} ${replacedItem.title}`, cat)
    : CLEAN_ALTERNATIVES[cat];
  return {
    key: replacedItem ? `clean-${cat}-${replacedItem.key}` : `clean-${cat}`,
    title: alt.name,
    brand: alt.brand,
    size: alt.size,
    price: alt.price ?? 4.99,
    image: alt.image,
    ingredients: alt.ingredients,
    category: cat,
    origin: "swap",
    replacedItem,
  };
};

const STORE_THEME: Record<Store, { bg: string; fg: string; accent: string; accentFg: string; mark: string }> = {
  walmart: { bg: "#0071dc", fg: "#ffffff", accent: "#0071dc", accentFg: "#fff", mark: "🏬" },
  instacart: { bg: "#003d29", fg: "#ffffff", accent: "#0aad0a", accentFg: "#fff", mark: "🥕" },
  target: { bg: "#cc0000", fg: "#ffffff", accent: "#cc0000", accentFg: "#fff", mark: "🎯" },
  kroger: { bg: "#0f2d7f", fg: "#ffffff", accent: "#0f2d7f", accentFg: "#fff", mark: "🛒" },
  aldi: { bg: "#001e78", fg: "#ffffff", accent: "#e85d00", accentFg: "#fff", mark: "🏪" },
  doordash: { bg: "#eb1700", fg: "#ffffff", accent: "#eb1700", accentFg: "#fff", mark: "🚗" },
  ubereats: { bg: "#06c167", fg: "#0b1410", accent: "#06c167", accentFg: "#0b1410", mark: "🛍️" },
  amazon: { bg: "#131921", fg: "#ffffff", accent: "#568000", accentFg: "#fff", mark: "📦" },
  sams: { bg: "#0067a0", fg: "#ffffff", accent: "#0067a0", accentFg: "#fff", mark: "💎" },
  bjs: { bg: "#c8102e", fg: "#ffffff", accent: "#c8102e", accentFg: "#fff", mark: "🔴" },
  costco: { bg: "#005dab", fg: "#ffffff", accent: "#e31837", accentFg: "#fff", mark: "🏷️" },
  shipt: { bg: "#2b0c3d", fg: "#ffffff", accent: "#008248", accentFg: "#fff", mark: "⚡" },
};

/** Renders a generic store mark for the selected retailer (nominative text + generic emoji only; no third-party trademarked logos). */
function StoreBadge({ store }: { store: Store; inHeader?: boolean }) {
  return <span className="store-chip-mark">{STORE_THEME[store].mark}</span>;
}

const RISK_LABEL = { high: "High risk", moderate: "Moderate", low: "Low risk" } as const;

/** Smoothly tweens a number (e.g. Cart Avg climbing 48 -> 71 -> 95). */
function useAnimatedNumber(target: number, durationMs = 720): number {
  const [display, setDisplay] = useState(target);
  const currentRef = useRef(target);

  useEffect(() => {
    const start = currentRef.current;
    const diff = target - start;
    if (diff === 0) return;
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      const val = Math.round(start + diff * eased);
      currentRef.current = val;
      setDisplay(val);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return display;
}

/* ------------------------------------------------------------------ */
/* Small presentational pieces                                         */
/* ------------------------------------------------------------------ */

function Gauge({ score, rating, color, size = 112 }: { score: number; rating: string; color: string; size?: number }) {
  const r = 44;
  const c = 2 * Math.PI * r;
  return (
    <div className={`gauge tone-${color}`} style={{ width: size, height: size }} aria-label={`${score} out of 100, ${rating}`}>
      <svg viewBox="0 0 100 100" width={size} height={size}>
        <circle cx="50" cy="50" r={r} className="gauge-track" />
        <circle
          cx="50" cy="50" r={r}
          className="gauge-fill"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - score / 100)}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <div className="gauge-label">
        <strong>{score}<span>/100</span></strong>
        <em>{rating}</em>
      </div>
    </div>
  );
}

function ProductArt({ product, className = "" }: { product: Product; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (product.image && failed !== product.image) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={`product-art ${className}`} src={product.image} alt={`${product.brand} ${product.title}`} onError={() => setFailed(product.image ?? null)} />;
  }
  const initials = product.brand.replace(/[^A-Za-zÄ ]/g, "").split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("");
  return (
    <div className={`product-art product-art--tile ${product.origin === "swap" ? "is-clean" : ""} ${className}`} aria-label={product.title}>
      <span>{initials}</span>
      <small>{product.brand}</small>
    </div>
  );
}

function ScoreChip({ score, color }: { score: number; color: string }) {
  return <span className={`score-chip tone-${color}`}>{score}</span>;
}

const POSITIVE_CHECKS: Record<Category, { title: string; subtitle: string; badge: string }> = {
  dyes: {
    title: "No Artificial Dyes",
    subtitle: "Free of Red 40, Yellow 5 & synthetic colorings",
    badge: "0 dyes",
  },
  seedOils: {
    title: "Seed-Oil Free",
    subtitle: "No industrial soybean, canola, or corn oil",
    badge: "0 seed oils",
  },
  hfcs: {
    title: "No High-Fructose Corn Syrup",
    subtitle: "Free of refined corn syrup sweeteners",
    badge: "0g HFCS",
  },
  preservatives: {
    title: "No Synthetic Preservatives",
    subtitle: "Free of BHA, BHT, TBHQ & benzoates",
    badge: "Clean",
  },
  nitrates: {
    title: "Nitrite & Nitrate Free",
    subtitle: "No curing nitrates or sodium nitrite",
    badge: "0 nitrites",
  },
  sweeteners: {
    title: "No Artificial Sweeteners",
    subtitle: "Free of aspartame, sucralose & acesulfame K",
    badge: "0 artificial",
  },
  emulsifiers: {
    title: "No Synthetic Emulsifiers",
    subtitle: "Free of polysorbate 80 & carrageenan",
    badge: "Clean",
  },
  gums: {
    title: "No Industrial Gums",
    subtitle: "Free of synthetic thickening gums",
    badge: "Clean",
  },
  flavors: {
    title: "Real Food Flavoring",
    subtitle: "No synthetic artificial flavor chemicals",
    badge: "Real",
  },
};

function YukaLineIcon({ kind }: { kind: Category | "additives" }) {
  switch (kind) {
    case "additives":
      return (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 3 19.5 7.3 19.5 16.7 12 21 4.5 16.7 4.5 7.3" />
          <line x1="12" y1="6.3" x2="16.6" y2="9" />
          <line x1="16.6" y1="15" x2="12" y2="17.7" />
          <line x1="7.4" y1="15" x2="7.4" y2="9" />
          <line x1="19.5" y1="7.3" x2="22.5" y2="5.5" />
        </svg>
      );
    case "seedOils":
      return (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2.8C12 2.8 6 10 6 14.5a6 6 0 0 0 12 0C18 10 12 2.8 12 2.8Z" />
          <path d="M9.5 15.5a2.5 2.5 0 0 0 2.5 2.5" />
        </svg>
      );
    case "dyes":
    case "flavors":
      return (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 3h6M10 3v5.4L5.2 17a2.5 2.5 0 0 0 2.2 3.7h9.2a2.5 2.5 0 0 0 2.2-3.7L14 8.4V3" />
          <path d="M7.5 14h9" />
        </svg>
      );
    case "hfcs":
    case "sweeteners":
      return (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" />
          <path d="M4 7.5 12 12l8-4.5M12 12v9" />
        </svg>
      );
    case "preservatives":
    case "nitrates":
      return (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3 5 6v6c0 5 3.4 8.3 7 9.8 3.6-1.5 7-4.8 7-9.8V6l-7-3Z" />
          <path d="m9.5 12 1.8 1.8 3.5-3.6" />
        </svg>
      );
    case "emulsifiers":
    case "gums":
    default:
      return (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="9" cy="9" r="4" />
          <circle cx="15.5" cy="15.5" r="4" />
          <line x1="11.8" y1="11.8" x2="12.7" y2="12.7" />
        </svg>
      );
  }
}

/* ------------------------------------------------------------------ */
/* Main simulator                                                      */
/* ------------------------------------------------------------------ */

export default function Simulator() {
  const [store, setStore] = useState<Store>("walmart");
  const [watch, setWatch] = useState<Watch>(DEFAULT_WATCHLIST);
  const [active, setActive] = useState<Product>(presetToProduct(PRESETS[0]));
  const [previousDirtyItem, setPreviousDirtyItem] = useState<Product | null>(null);
  const [cart, setCart] = useState<Product[]>(() => PRESETS.map(presetToProduct));
  const [overlay, setOverlay] = useState<OverlayState>("pill");
  const [openFlag, setOpenFlag] = useState<string | null>(null);
  const [pillY, setPillY] = useState(56);
  const [pillDragOffset, setPillDragOffset] = useState<{ x: number; y: number } | null>(null);
  const [overHideZone, setOverHideZone] = useState(false);
  const [hiddenForTrip, setHiddenForTrip] = useState(false);

  // Dual-mode bubble state: "product" (single item score) vs "search" (idle/scrolling Cart Avg)
  const [viewMode, setViewMode] = useState<ViewMode>("product");
  const [cartClimbFlash, setCartClimbFlash] = useState(false);
  const [swapHistory, setSwapHistory] = useState<SwapRecord[]>([]);

  // Paywall & Influencer Engine state
  const [scanCount, setScanCount] = useState(1);
  const [swapsUsedThisWeek, setSwapsUsedThisWeek] = useState(0);
  const [courtesyRefillAvailable, setCourtesyRefillAvailable] = useState(true);
  const [personalReferralCode, setPersonalReferralCode] = useState("BROC-7F4A2");
  const [isPro, setIsPro] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [watchlistFunnelOpen, setWatchlistFunnelOpen] = useState(false);
  const [familyWatchlist, setFamilyWatchlist] = useState<Category[]>(["seedOils", "dyes", "hfcs"]);
  const [authUser, setAuthUser] = useState<AuthenticatedUser | null>(null);
  const [deviceIdState, setDeviceIdState] = useState("anon-web");
  const [appliedCreator, setAppliedCreator] = useState<AppliedCreator | null>(null);
  const [scorecardOpen, setScorecardOpen] = useState(false);

  const [toast, setToast] = useState<{ title: string; body: string; href?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function checkEntitlement() {
      try {
        let deviceId = window.localStorage.getItem("heybroc_device_id");
        if (!deviceId) {
          deviceId = `web-${Math.random().toString(36).substring(2, 10)}-${Date.now().toString(36)}`;
          window.localStorage.setItem("heybroc_device_id", deviceId);
        }
        if (!cancelled) setDeviceIdState(deviceId);

        try {
          const savedWl = JSON.parse(
            window.localStorage.getItem("heybroc_family_watchlist") || "null"
          ) as Category[] | null;
          if (Array.isArray(savedWl) && savedWl.length > 0 && !cancelled) {
            setFamilyWatchlist(savedWl);
          }
        } catch {
          /* ignore */
        }

        // Clear legacy unverified flag so forged localStorage cannot unlock Pro
        window.localStorage.removeItem("heybroc_pro");
        const params = new URLSearchParams(window.location.search);
        if (params.get("login") === "1") {
          setAuthOpen(true);
        } else if (params.get("onboarding") === "1") {
          setWatchlistFunnelOpen(true);
        } else if (
          !params.get("pro") &&
          !params.get("upgrade") &&
          !window.localStorage.getItem("heybroc_onboarding_done")
        ) {
          setWatchlistFunnelOpen(true);
        }

        // Restore authenticated user session if present
        const storedToken = (window.localStorage.getItem("heybroc_auth_token") || "").trim();
        let authenticatedPro = false;
        if (storedToken) {
          const authRes = await fetch(
            `/api/auth?deviceId=${encodeURIComponent(deviceId)}`,
            { cache: "no-store", headers: { Authorization: `Bearer ${storedToken}` } }
          ).catch(() => null);
          const authData = (authRes ? await authRes.json().catch(() => null) : null) as {
            ok?: boolean;
            authenticated?: boolean;
            user?: AuthenticatedUser;
          } | null;
          if (!cancelled && authData?.ok && authData.authenticated && authData.user) {
            setAuthUser(authData.user);
            if (authData.user.referralCode) {
              setPersonalReferralCode(authData.user.referralCode);
              window.localStorage.setItem("heybroc_my_referral_code", authData.user.referralCode);
            }
            if (authData.user.isProActive) {
              authenticatedPro = true;
              setIsPro(true);
            }
          } else if (!cancelled && authRes && authRes.status === 401) {
            window.localStorage.removeItem("heybroc_auth_token");
            window.localStorage.removeItem("heybroc_auth_user");
          }
        }

        const refParam = (params.get("ref") || "").trim().toUpperCase();
        if (refParam && /^BROC-[A-Z0-9]{4,10}$/.test(refParam)) {
          window.localStorage.setItem("heybroc_referred_by", refParam);
        }

        const storedRef = (window.localStorage.getItem("heybroc_referred_by") || "").trim().toUpperCase();
        const refRes = await fetch("/api/referral", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: refParam ? "claim" : "status",
            deviceId,
            referralCode: refParam || storedRef || undefined,
          }),
        }).catch(() => null);
        const refData = (refRes ? await refRes.json().catch(() => null) : null) as {
          ok?: boolean;
          message?: string;
          entitlement?: {
            referralCode?: string;
            isProActive?: boolean;
            weeklySwapsUsedCount?: number;
          };
        } | null;

        if (!cancelled && typeof refData?.entitlement?.weeklySwapsUsedCount === "number") {
          setSwapsUsedThisWeek(refData.entitlement.weeklySwapsUsedCount);
        }

        if (!cancelled && refData?.entitlement?.referralCode) {
          setPersonalReferralCode(refData.entitlement.referralCode);
          window.localStorage.setItem("heybroc_my_referral_code", refData.entitlement.referralCode);
        } else {
          const cachedServerCode = window.localStorage.getItem("heybroc_my_referral_code") || "";
          if (!cancelled && /^BROC-[A-Z0-9]{4,10}$/.test(cachedServerCode)) {
            setPersonalReferralCode(cachedServerCode);
          }
        }

        if (!cancelled && refParam && refData?.ok) {
          setToast({
            title: `🎁 Friend Invite Saved (${refParam})`,
            body: refData.message || "Invite saved! Start a trial to unlock +7 Free Pro Days for both of you.",
          });
        }

        const urlSessionId = (params.get("session_id") || "").trim();
        const storedSessionId = (window.localStorage.getItem("heybroc_session_id") || "").trim();
        const candidateSessionId = urlSessionId || storedSessionId;
        if (!candidateSessionId) {
          if (!cancelled) {
            setIsPro(authenticatedPro || Boolean(refData?.entitlement?.isProActive));
          }
          return;
        }
        const res = await fetch(
          `/api/entitlement?session_id=${encodeURIComponent(candidateSessionId)}&deviceId=${encodeURIComponent(deviceId)}`,
          { cache: "no-store" }
        );
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          active?: boolean;
        } | null;
        if (cancelled) return;
        if (res.ok && data?.ok && data.active === true) {
          setIsPro(true);
          window.localStorage.setItem("heybroc_session_id", candidateSessionId);
          if (urlSessionId) {
            setToast({
              title: "✓ HeyBroc Family Pro Unlocked",
              body: "Unlimited store overlays, 1-tap clean swaps & whole-cart health checks are now active.",
            });
          }
        } else {
          setIsPro(authenticatedPro || Boolean(refData?.entitlement?.isProActive));
          window.localStorage.removeItem("heybroc_session_id");
        }
      } catch {
        if (!cancelled) setIsPro(false);
      }
    }
    void checkEntitlement();
    return () => {
      cancelled = true;
    };
  }, []);

  const [query, setQuery] = useState("");
  const [liveState, setLiveState] = useState<"idle" | "loading" | "error">("idle");
  const [liveError, setLiveError] = useState("");
  const [apiJson, setApiJson] = useState<unknown>(null);
  const [iosText, setIosText] = useState("");
  const [inspectTab, setInspectTab] = useState<"json" | "ios">("json");

  const [panel, setPanel] = useState<"none" | "watchlist">("none");
  const [pillTheme, setPillTheme] = useState<"dark" | "green" | "score" | "white">("dark");
  const [pillSize, setPillSize] = useState<"standard" | "compact">("standard");
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditBusy, setAuditBusy] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);

  // Yuka-style drawer tabs & favorites/history state
  const [yukaTab, setYukaTab] = useState<"inspect" | "history" | "recs" | "top" | "search">("inspect");
  const [favOnly, setFavOnly] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [scanHistory, setScanHistory] = useState<{ product: Product; timeLabel: string }[]>(() => [
    { product: presetToProduct(PRESETS[0]), timeLabel: "Just now" },
    { product: cleanToProduct("Butter/Dairy"), timeLabel: "12 mins ago" },
    { product: presetToProduct(PRESETS[1]), timeLabel: "2 hrs ago" },
    { product: cleanToProduct("Yogurt"), timeLabel: "Yesterday" },
    { product: presetToProduct(PRESETS[3]), timeLabel: "3 days ago" },
  ]);

  const toggleFavorite = useCallback((key: string) => {
    setFavorites((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);

  const screenRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const score = useMemo(
    () => gradeProduct(`${active.brand} ${active.title}`, active.ingredients, watch, active.nutrition, familyWatchlist),
    [active, watch, familyWatchlist],
  );
  const swap = useMemo(
    () => resolveSwap({ score: score.score, productTitle: `${active.brand} ${active.title}`, ingredients: active.ingredients, category: active.category, store, watchlist: watch, familyWatchlist }),
    [score.score, active, store, watch, familyWatchlist],
  );
  const theme = STORE_THEME[store];

  /* ---------------- Cart scoring & animated Cart Avg ---------------- */
  const cartScored = useMemo(
    () =>
      cart.map((item) => {
        const s = gradeProduct(`${item.brand} ${item.title}`, item.ingredients, watch, item.nutrition, familyWatchlist);
        const sw = resolveSwap({
          score: s.score,
          productTitle: `${item.brand} ${item.title}`,
          ingredients: item.ingredients,
          category: item.category,
          store,
          watchlist: watch,
          familyWatchlist,
        });
        return { item, s, sw };
      }),
    [cart, watch, store, familyWatchlist],
  );
  const cartAvg = cartScored.length
    ? Math.round(cartScored.reduce((a, r) => a + r.s.score, 0) / cartScored.length)
    : 0;
  const animatedCartAvg = useAnimatedNumber(cartAvg, 750);
  const cartAvgTone = animatedCartAvg >= 75 ? "green" : animatedCartAvg >= 50 ? "yellow" : "red";
  const dirty = cartScored.filter((r) => r.sw);

  const fallbackDodged = useMemo(
    () =>
      Array.from(
        new Set(
          PRESETS.flatMap((p) => gradeProduct(`${p.brand} ${p.title}`, p.ingredients, watch, undefined, familyWatchlist).flagged.map((f) => f.name)),
        ),
      ),
    [watch, familyWatchlist],
  );

  const fallbackSwaps = useMemo<SwapRecord[]>(
    () =>
      PRESETS.map((p): SwapRecord | null => {
        const s = gradeProduct(`${p.brand} ${p.title}`, p.ingredients, watch, undefined, familyWatchlist);
        const sw = resolveSwap({
          score: s.score,
          productTitle: `${p.brand} ${p.title}`,
          ingredients: p.ingredients,
          category: p.category,
          store,
          watchlist: watch,
          familyWatchlist,
        });
        if (!sw) return null;
        return {
          fromTitle: `${p.brand} ${p.title}`,
          toTitle: sw.title,
          toScore: sw.score,
          store,
          dodged: s.flagged.map((f) => f.name),
        };
      }).filter((x): x is SwapRecord => Boolean(x)),
    [watch, store, familyWatchlist],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6500);
    return () => clearTimeout(t);
  }, [toast]);

  // Product scores & ingredient explanations are 100% free forever — viewing items never opens the paywall.
  const registerScan = useCallback(() => {
    setScanCount((prev) => prev + 1);
  }, []);

  const [storeExpanded, setStoreExpanded] = useState(false);
  const storeRailRef = useRef<HTMLDivElement>(null);

  const scrollStoreRail = useCallback((dir: -1 | 1) => {
    storeRailRef.current?.scrollBy({ left: dir * 210, behavior: "smooth" });
  }, []);

  const switchStore = useCallback((s: Store) => {
    setStore(s);
    setHiddenForTrip(false);
  }, []);

  const showProduct = useCallback(
    (p: Product, countAsScan = true, openCardImmediately = false) => {
      setActive(p);
      setPreviousDirtyItem(null);
      setViewMode("product");
      setYukaTab("inspect");
      setFavOnly(false);
      setOverlay(openCardImmediately ? "card" : "pill");
      setOpenFlag(null);
      setScanHistory((prev) => [
        { product: p, timeLabel: "Just now" },
        ...prev.filter((h) => h.product.key !== p.key),
      ]);
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      if (countAsScan) registerScan();
    },
    [registerScan],
  );

  /** Inspects the Clean Swap item when the user clicks its photo or title inside Health Insights. */
  const inspectCleanSwap = useCallback(
    (cat: SwapCategory, replaced?: Product) => {
      const target = replaced ?? (active.origin !== "swap" ? active : previousDirtyItem ?? undefined);
      const clean = cleanToProduct(cat, target);
      if (active.origin !== "swap") {
        setPreviousDirtyItem(active);
      }
      setActive(clean);
      setViewMode("product");
      setYukaTab("inspect");
      setOverlay("card");
      setOpenFlag(null);
      setScanHistory((prev) => [
        { product: clean, timeLabel: "Just now" },
        ...prev.filter((h) => h.product.key !== clean.key),
      ]);
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    },
    [active, previousDirtyItem],
  );

  const triggerClimbFlash = useCallback(() => {
    setCartClimbFlash(true);
    const t = setTimeout(() => setCartClimbFlash(false), 2600);
    return () => clearTimeout(t);
  }, []);

  /** Commits a product (or a pending clean swap) to the simulated cart when added by the user. */
  const commitItemToCart = useCallback(
    (itemToAdd: Product) => {
      const cleanScore = gradeProduct(
        `${itemToAdd.brand} ${itemToAdd.title}`,
        itemToAdd.ingredients,
        watch,
        itemToAdd.nutrition,
        familyWatchlist,
      );
      const replacedDirty =
        itemToAdd.origin === "swap"
          ? itemToAdd.replacedItem ??
            (previousDirtyItem && previousDirtyItem.category === itemToAdd.category
              ? previousDirtyItem
              : null)
          : null;

      if (replacedDirty) {
        const dirtyScore = gradeProduct(
          `${replacedDirty.brand} ${replacedDirty.title}`,
          replacedDirty.ingredients,
          watch,
          replacedDirty.nutrition,
          familyWatchlist,
        );
        setCart((c) => {
          if (c.some((i) => i.key === itemToAdd.key)) return c;
          const idx = c.findIndex((i) => i.key === replacedDirty.key);
          if (idx === -1) return [...c, itemToAdd];
          const next = [...c];
          next[idx] = itemToAdd;
          return next;
        });
        setSwapHistory((prev) => [
          {
            fromTitle: `${replacedDirty.brand} ${replacedDirty.title}`,
            toTitle: `${itemToAdd.brand} ${itemToAdd.title}`,
            toScore: cleanScore.score,
            store,
            dodged: dirtyScore.flagged.map((f) => f.name),
          },
          ...prev,
        ]);
        triggerClimbFlash();
        setToast({
          title: `✓ Swapped to ${itemToAdd.brand} ${itemToAdd.title} (${cleanScore.score}/100)`,
          body: `Added clean swap to your ${STORE_META[store].label} cart · Cart Avg updated!`,
        });
        return;
      }

      setCart((c) => (c.some((i) => i.key === itemToAdd.key) ? c : [...c, itemToAdd]));
      setToast({
        title: "Added to cart",
        body: `${itemToAdd.brand} ${itemToAdd.title} (${cleanScore.score}/100)`,
      });
    },
    [watch, familyWatchlist, previousDirtyItem, store, triggerClimbFlash],
  );

  /* ---------------- Swap (single item or from auditor) ---------------- */
  const swapCartItem = useCallback(
    (targetItem: Product) => {
      const weeklyAllowance = courtesyRefillAvailable ? FREE_SCAN_LIMIT : FREE_SCAN_LIMIT + 3;
      if (!isPro && swapsUsedThisWeek >= weeklyAllowance) {
        setPaywallOpen(true);
        return;
      }
      const itemScore = gradeProduct(
        `${targetItem.brand} ${targetItem.title}`,
        targetItem.ingredients,
        watch,
        targetItem.nutrition,
        familyWatchlist,
      );
      const targetSwap = resolveSwap({
        score: itemScore.score,
        productTitle: `${targetItem.brand} ${targetItem.title}`,
        ingredients: targetItem.ingredients,
        category: targetItem.category,
        store,
        watchlist: watch,
        familyWatchlist,
      });
      if (!targetSwap) return;
      setSwapsUsedThisWeek((n) => n + 1);
      if (typeof window !== "undefined") {
        const devId = window.localStorage.getItem("heybroc_device_id") || "anon-web";
        void fetch("/api/referral", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "record_swap",
            deviceId: devId,
            productKey: targetItem.key || `${targetItem.brand} ${targetItem.title}`,
          }),
        }).catch(() => {});
      }
      const clean = cleanToProduct(targetSwap.category, targetItem);
      setPreviousDirtyItem(targetItem);
      setActive(clean);
      setViewMode("product");
      setCartOpen(false);
      setAuditOpen(false);
      setOverlay("pill");
      setOpenFlag(null);
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      setToast({
        title: `Viewing Clean Swap: ${targetSwap.title} (${targetSwap.score}/100)`,
        body: `Tap "Add to cart" on the product page to swap this item in your ${STORE_META[store].label} cart.`,
        href: targetSwap.deepLink || targetSwap.webUrl,
      });
    },
    [watch, familyWatchlist, store, isPro, swapsUsedThisWeek, courtesyRefillAvailable],
  );

  const doSwap = useCallback(() => {
    if (active.origin === "swap") {
      commitItemToCart(active);
      return;
    }
    swapCartItem(previousDirtyItem ?? active);
  }, [active, commitItemToCart, swapCartItem, previousDirtyItem]);

  /** Finds the original dirty item that a clean swap replaced so the user can revert in 1 tap. */
  const getRevertTarget = useCallback(
    (item: Product): Product | null => {
      if (item.origin !== "swap") return null;
      if (item.replacedItem) return item.replacedItem;
      if (previousDirtyItem && previousDirtyItem.category === item.category) {
        return previousDirtyItem;
      }
      const preset = PRESETS.find((p) => p.category === item.category);
      return preset ? presetToProduct(preset) : previousDirtyItem;
    },
    [previousDirtyItem],
  );

  const revertSwap = useCallback(
    (cleanItem: Product = active) => {
      const orig = getRevertTarget(cleanItem);
      if (!orig) return;
      setCart((c) => {
        const idx = c.findIndex((i) => i.key === cleanItem.key);
        if (idx === -1) return c;
        const next = [...c];
        next[idx] = orig;
        return next;
      });
      setActive(orig);
      setPreviousDirtyItem(null);
      setToast({
        title: `↺ Reverted back to ${orig.brand} ${orig.title}`,
        body: `Restored original item in your ${STORE_META[store].label} cart.`,
      });
    },
    [active, getRevertTarget, store],
  );
  const activeRevertTarget = getRevertTarget(active);

  /* ---------------- Live search ---------------- */
  const runLive = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const q = query.trim();
      if (!q) return;
      setLiveState("loading");
      setLiveError("");
      try {
        const deviceId =
          (typeof window !== "undefined" && window.localStorage.getItem("heybroc_device_id")) || undefined;
        const referredByCode =
          (typeof window !== "undefined" && window.localStorage.getItem("heybroc_referred_by")) || undefined;
        const payload = { productTitle: q, store, watchlist: watch, familyWatchlist, deviceId, referredByCode };
        const res = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = (await res.json()) as ApiScan;
        setApiJson(data);
        if (!data.ok || !data.product) {
          setLiveState("error");
          setLiveError(data.error || "Lookup failed.");
          setIosText("");
          return;
        }
        const cat = detectCategory(`${q} ${data.product.title}`, data.product.ingredients);
        const liveScore =
          data.result?.score ??
          gradeProduct(data.product.title, data.product.ingredients, watch, data.product.nutrition, familyWatchlist).score;
        const fallbackImg = liveScore >= 75 ? CLEAN_ALTERNATIVES[cat]?.image : DIRTY_FALLBACK_IMAGES[cat];
        const p: Product = {
          key: `live-${data.product.barcode || q}`,
          title:
            data.product.title.replace(
              new RegExp(`^${(data.product.brand || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"),
              "",
            ) || data.product.title,
          brand: data.product.brand || "Open data",
          description: data.product.description,
          image: data.product.imageUrl || fallbackImg,
          ingredients: data.product.ingredients,
          nutrition: data.product.nutrition,
          category: cat,
          origin: "live",
          lookup: data.lookup,
        };
        showProduct(p, true);
        setLiveState("idle");
        fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, format: "ios_text" }),
        })
          .then((r) => r.text())
          .then(setIosText)
          .catch(() => setIosText(""));
      } catch {
        setLiveState("error");
        setLiveError("Network error — is the server reachable?");
      }
    },
    [query, store, watch, familyWatchlist, showProduct],
  );

  /* ---------------- Whole-Cart Audit ---------------- */
  const openAudit = useCallback(async () => {
    setAuditOpen(true);
    setCartOpen(false);
    setAuditBusy(true);
    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          store,
          watchlist: watch,
          familyWatchlist,
          items: cart.map((i) => ({ productTitle: `${i.brand} ${i.title}`, rawIngredients: i.ingredients })),
        }),
      });
      setApiJson(await res.json());
      setIosText("");
      setInspectTab("json");
    } catch {
      /* client-side scores are identical */
    } finally {
      setAuditBusy(false);
    }
  }, [cart, store, watch, familyWatchlist]);

  const swapAll = useCallback(() => {
    const n = dirty.length;
    if (n === 0) return;
    const weeklyAllowance = courtesyRefillAvailable ? FREE_SCAN_LIMIT : FREE_SCAN_LIMIT + 3;
    if (!isPro && swapsUsedThisWeek + n > weeklyAllowance) {
      setPaywallOpen(true);
      return;
    }
    setSwapsUsedThisWeek((prev) => prev + n);
    if (typeof window !== "undefined") {
      const devId = window.localStorage.getItem("heybroc_device_id") || "anon-web";
      for (const d of dirty) {
        void fetch("/api/referral", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "record_swap",
            deviceId: devId,
            productKey: d.item.key || `${d.item.brand} ${d.item.title}`,
          }),
        }).catch(() => {});
      }
    }
    const records: SwapRecord[] = dirty.map((d) => ({
      fromTitle: `${d.item.brand} ${d.item.title}`,
      toTitle: d.sw!.title,
      toScore: d.sw!.score,
      store,
      dodged: d.s.flagged.map((f) => f.name),
    }));
    setSwapHistory((prev) => [...records, ...prev]);
    const nextCart = cart.map((item) => {
      const hit = dirty.find((d) => d.item.key === item.key);
      return hit?.sw ? cleanToProduct(hit.sw.category, item) : item;
    });
    setCart(nextCart);
    const nextAvg = nextCart.length
      ? Math.round(
          nextCart.reduce(
            (sum, item) =>
              sum +
              gradeProduct(`${item.brand} ${item.title}`, item.ingredients, watch, item.nutrition, familyWatchlist).score,
            0,
          ) / nextCart.length,
        )
      : 0;
    const replaced = dirty.find((d) => d.item.key === active.key);
    if (replaced?.sw) setActive(cleanToProduct(replaced.sw.category, replaced.item));
    triggerClimbFlash();
    setToast({
      title: `✓ Swapped ${n} item${n === 1 ? "" : "s"} → Cart Avg ${nextAvg}/100!`,
      body: `Upgraded ${n} item${n === 1 ? "" : "s"} to clean alternatives at ${STORE_META[store].label}.`,
    });
  }, [dirty, cart, watch, familyWatchlist, active.key, store, triggerClimbFlash, isPro, swapsUsedThisWeek, courtesyRefillAvailable]);

  const resetCartPresets = useCallback(() => {
    setCart(PRESETS.map(presetToProduct));
    setSwapHistory([]);
    setPreviousDirtyItem(null);
    setActive(presetToProduct(PRESETS[0]));
  }, []);

  /* ---------------- 2D Pill drag + Drag-to-Hide drop zone ---------------- */
  const drag = useRef<{ startX: number; startY: number; startPill: number; moved: boolean } | null>(null);
  const cardOpenedAtRef = useRef<number>(0);

  const onPillDown = (e: React.PointerEvent) => {
    drag.current = { startX: e.clientX, startY: e.clientY, startPill: pillY, moved: false };
  };
  const onPillMove = (e: React.PointerEvent) => {
    if (!drag.current || !screenRef.current) return;
    const dx = e.clientX - drag.current.startX;
    const dy = e.clientY - drag.current.startY;
    // Ignore natural thumb wiggle (< 14px) on mobile touchscreens so taps always register
    if (!drag.current.moved && Math.hypot(dx, dy) < 14) return;
    if (!drag.current.moved) {
      drag.current.moved = true;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture is unsupported on synthetic touch
      }
    }

    const rect = screenRef.current.getBoundingClientRect();
    const pct = drag.current.startPill + (dy / rect.height) * 100;
    setPillY(Math.max(14, Math.min(88, pct)));
    setPillDragOffset({ x: Math.min(0, dx), y: 0 });

    const relY = (e.clientY - rect.top) / rect.height;
    const relX = (e.clientX - rect.left) / rect.width;
    setOverHideZone(relY > 0.80 && relX > 0.2 && relX < 0.8);
  };
  const lastDragMovedRef = useRef<boolean>(false);

  const triggerPillTap = (isCartBubble: boolean, expand: boolean) => {
    if (lastDragMovedRef.current) {
      lastDragMovedRef.current = false;
      return;
    }
    cardOpenedAtRef.current = Date.now();
    if (isCartBubble) {
      openAudit();
    } else if (expand) {
      setOverlay("card");
    } else {
      setOverlay("pill");
    }
  };
  const onPillUp = () => {
    const moved = Boolean(drag.current?.moved);
    const dropHide = overHideZone;
    drag.current = null;
    setPillDragOffset(null);
    setOverHideZone(false);
    lastDragMovedRef.current = moved || dropHide;

    if (dropHide) {
      setHiddenForTrip(true);
      setToast({
        title: "HeyBroc hidden for this trip",
        body: `Dismissed until the next time you open ${STORE_META[store].label}.`,
      });
    }
  };

  const toggleWatch = (c: Category) => setWatch((w) => ({ ...w, [c]: !w[c] }));
  const disabledCount = ALL_CATEGORIES.filter((c) => !watch[c]).length;

  const isCartBubbleMode = viewMode === "search" || cartClimbFlash;

  const aisleItems = useMemo<Product[]>(
    () => [
      ...PRESETS.map(presetToProduct),
      cleanToProduct("Yogurt"),
      cleanToProduct("Crackers"),
      cleanToProduct("Dressings"),
    ],
    [],
  );

  /* ---------------- Render ---------------- */
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/broc-mascot.jpg" alt="Broc mascot" className="brand-mascot" />
          <div>
            <h1>HeyBroc <span>Clean Grocery Scanner</span></h1>
            <p>Instant ingredient grader &amp; 1-tap clean grocery swaps</p>
          </div>
        </div>

        <div className="topbar-actions">
          <button
            id="open-watchlist-funnel"
            type="button"
            className="topbar-btn"
            onClick={() => setWatchlistFunnelOpen(true)}
            title="Personalize your family's 2x additive watchlist"
          >
            🛡️ Avoid ({familyWatchlist.length})
          </button>

          <button
            id="open-auth-modal"
            type="button"
            className="topbar-btn"
            onClick={() => setAuthOpen(true)}
            style={
              authUser
                ? {
                    background: "#ecfdf5",
                    borderColor: "#86efac",
                    color: "#065f46",
                    fontWeight: 800,
                  }
                : undefined
            }
          >
            {authUser ? `👤 ${authUser.displayName}` : "👤 Log in"}
          </button>

          <button
            id="open-paywall"
            type="button"
            className={`topbar-btn topbar-btn--pro ${isPro ? "is-pro" : ""}`}
            onClick={() => setPaywallOpen(true)}
          >
            {isPro ? "★ PRO Member" : "★ Family Pro"}
          </button>

          <a
            id="download-android-apk"
            href="/heybroc.apk"
            download="heybroc.apk"
            className="topbar-btn"
          >
            📲 Android App (.apk)
          </a>
        </div>
      </header>

      <main className="layout">
        {/* ============ CONTROL PANEL ============ */}
        <section className="controls" aria-label="Store and product controls">
          <div className="card">
            <div className="card-head">
              <h2>Choose Your Store</h2>
              <button
                type="button"
                className="store-view-toggle"
                onClick={() => setStoreExpanded((v) => !v)}
              >
                {storeExpanded ? "Slide view ▴" : `All ${STORES.length} stores ▾`}
              </button>
            </div>
            {storeExpanded ? (
              <div className="store-grid-all" role="tablist" aria-label="All supported grocery stores">
                {STORES.map((s) => (
                  <button
                    key={s}
                    id={`store-${s}`}
                    role="tab"
                    aria-selected={store === s}
                    className={`store-chip-btn ${store === s ? "is-on" : ""}`}
                    onClick={() => switchStore(s)}
                  >
                    <StoreBadge store={s} />
                    <span>{STORE_META[s].label}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="store-rail-wrap">
                <button
                  type="button"
                  className="store-rail-arrow"
                  onClick={() => scrollStoreRail(-1)}
                  aria-label="Scroll stores left"
                >
                  ‹
                </button>
                <div className="store-rail" ref={storeRailRef} role="tablist" aria-label="Supported grocery stores">
                  {STORES.map((s) => (
                    <button
                      key={s}
                      id={`store-${s}`}
                      role="tab"
                      aria-selected={store === s}
                      className={`store-chip-btn ${store === s ? "is-on" : ""}`}
                      onClick={() => switchStore(s)}
                    >
                      <StoreBadge store={s} />
                      <span>{STORE_META[s].label}</span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="store-rail-arrow"
                  onClick={() => scrollStoreRail(1)}
                  aria-label="Scroll stores right"
                >
                  ›
                </button>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Shopping View</h2>
            </div>
            <div className="segmented segmented--two">
              <button
                id="mode-product-btn"
                type="button"
                className={viewMode === "product" ? "is-on" : ""}
                onClick={() => setViewMode("product")}
              >
                📦 Product Page ({score.score}/100)
              </button>
              <button
                id="mode-search-btn"
                type="button"
                className={viewMode === "search" ? "is-on" : ""}
                onClick={() => setViewMode("search")}
              >
                🛒 Store Aisle ({animatedCartAvg}/100)
              </button>
            </div>
            <div className="bubble-trip-bar">
              {hiddenForTrip ? (
                <button
                  id="restore-bubble-btn"
                  type="button"
                  className="trip-pill trip-pill--restore"
                  onClick={() => setHiddenForTrip(false)}
                >
                  ↺ HeyBroc hidden for this trip · Tap to Restore
                </button>
              ) : (
                <button
                  id="snooze-bubble-btn"
                  type="button"
                  className="trip-pill"
                  onClick={() => {
                    setHiddenForTrip(true);
                    setToast({
                      title: "HeyBroc hidden for this trip",
                      body: `Dismissed until you next open ${STORE_META[store].label}.`,
                    });
                  }}
                >
                  ✕ Hide bubble for this trip
                </button>
              )}
              {cart.some((c) => c.origin === "swap") && (
                <button type="button" className="link-btn" onClick={resetCartPresets}>
                  Reset sample cart
                </button>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Search Any Grocery Item</h2></div>
            <form className="search" onSubmit={runLive}>
              <input
                id="live-search-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. Monster, Red Bull, Coke, C4 Pre-Workout, Milk, Water, Juice…"
                aria-label="Search any grocery product"
              />
              <button id="live-search-submit" type="submit" disabled={liveState === "loading" || !query.trim()}>
                {liveState === "loading" ? <span className="spinner" aria-label="Scanning" /> : "Scan"}
              </button>
            </form>
            {liveState === "error" && <p className="error">{liveError}</p>}
            {active.origin === "live" && active.lookup && (
              <p className="meta">
                Verified ingredient match in {active.lookup.ms} ms
              </p>
            )}
          </div>

          <div className="card">
            <div className="card-head"><h2>Popular Grocery Items</h2></div>
            <ul className="preset-list">
              {PRESETS.map((p) => {
                const s = gradeProduct(`${p.brand} ${p.title}`, p.ingredients, watch, undefined, familyWatchlist);
                const on = active.key === p.id && viewMode === "product";
                return (
                  <li key={p.id}>
                    <button id={`preset-${p.id}`} className={`preset ${on ? "is-on" : ""}`} onClick={() => showProduct(presetToProduct(p))}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.image} alt="" />
                      <span className="preset-text"><b>{p.title}</b><small>{p.brand}</small></span>
                      <ScoreChip score={s.score} color={s.color} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="tool-row">
            <button id="open-auditor" className="tool" onClick={openAudit}>
              <span className="tool-icon">🛒</span>
              <span><b>Whole-Cart Health Check</b><small>{dirty.length} dirty of {cart.length} • Avg {animatedCartAvg}/100</small></span>
            </button>
            <button id="open-watchlist" className={`tool ${panel === "watchlist" ? "is-on" : ""}`} onClick={() => setPanel((p) => (p === "watchlist" ? "none" : "watchlist"))}>
              <span className="tool-icon">⚙︎</span>
              <span><b>Settings &amp; Watchlist</b><small>{disabledCount ? `${disabledCount} categor${disabledCount === 1 ? "y" : "ies"} ignored` : "Bubble style & 9 categories"}</small></span>
            </button>
          </div>

          {panel === "watchlist" && (
            <div className="card watchlist">
              <div className="card-head">
                <h2>Floating Bubble Style</h2>
              </div>
              <div className="segmented segmented--two" style={{ marginBottom: 8 }}>
                {(
                  [
                    { id: "dark", label: "⬛ Obsidian Dark" },
                    { id: "green", label: "🥦 HeyBroc Green" },
                    { id: "score", label: "🎨 Score Color" },
                    { id: "white", label: "⬜ Crisp White" },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    id={`pill-theme-${t.id}`}
                    type="button"
                    className={pillTheme === t.id ? "is-on" : ""}
                    onClick={() => setPillTheme(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="segmented segmented--two" style={{ marginBottom: 14 }}>
                <button
                  id="pill-size-standard"
                  type="button"
                  className={pillSize === "standard" ? "is-on" : ""}
                  onClick={() => setPillSize("standard")}
                >
                  Standard Pill (35 / 100 · Poor)
                </button>
                <button
                  id="pill-size-compact"
                  type="button"
                  className={pillSize === "compact" ? "is-on" : ""}
                  onClick={() => setPillSize("compact")}
                >
                  Compact Badge (35/100)
                </button>
              </div>
              <div className="card-head"><h2>Chemical Watchlist</h2><button className="link-btn" onClick={() => setWatch(DEFAULT_WATCHLIST)}>Reset</button></div>
              <ul>
                {ALL_CATEGORIES.map((c) => (
                  <li key={c}>
                    <label className="switch-row" htmlFor={`watch-${c}`}>
                      <span>{CATEGORY_LABELS[c]}</span>
                      <input id={`watch-${c}`} type="checkbox" checked={watch[c]} onChange={() => toggleWatch(c)} />
                      <span className="switch" aria-hidden />
                    </label>
                  </li>
                ))}
              </ul>
              <p className="meta">Scored on our 3-pillar rubric: 60% Nutritional Quality, 30% Additive Safety &amp; 10% Organic Bonus.</p>
            </div>
          )}
        </section>

        {/* ============ PHONE ============ */}
        <section className="stage" aria-label="Store app preview with overlay">
          <div className="phone">
            <div
              className="screen"
              ref={screenRef}
              style={{ ["--store-bg" as string]: theme.bg, ["--store-fg" as string]: theme.fg, ["--store-accent" as string]: theme.accent, ["--store-accent-fg" as string]: theme.accentFg }}
            >
              <div className="statusbar"><span>9:41</span><span className="notch" /><span>5G ▮▮▮</span></div>

              <div className="store-header">
                <div className="store-row">
                  <span className="store-logo"><StoreBadge store={store} inHeader />{STORE_META[store].label}</span>
                  <button className="cart-btn" onClick={() => setCartOpen(true)} aria-label="Open cart">
                    <svg viewBox="0 0 24 24" width="20" height="20"><path d="M3 4h2l2.4 11.2a2 2 0 002 1.6h7.7a2 2 0 002-1.5L21 8H6.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><circle cx="10" cy="20" r="1.4" fill="currentColor" /><circle cx="17" cy="20" r="1.4" fill="currentColor" /></svg>
                    <span className="cart-count">{cart.length}</span>
                  </button>
                </div>
                <div className="store-search" aria-hidden>
                  <span>⌕ Search {STORE_META[store].label}</span>
                </div>
              </div>

              <div className="store-scroll" ref={scrollRef}>
                {viewMode === "search" ? (
                  <div className="aisle">
                    <div className="aisle-grid">
                      {aisleItems.map((item) => {
                        const inCart = cart.some((c) => c.key === item.key);
                        return (
                          <div key={item.key} className="aisle-card">
                            <button
                              type="button"
                              className="aisle-card-main"
                              onClick={() => showProduct(item, true, true)}
                            >
                              <div className="aisle-art">
                                <ProductArt product={item} />
                              </div>
                              <small className="aisle-brand">{item.brand}</small>
                              <b className="aisle-title">{item.title}</b>
                              <span className="aisle-price">${(item.price ?? 4.49).toFixed(2)}</span>
                            </button>
                            <button
                              type="button"
                              className={`aisle-add ${inCart ? "is-in" : ""}`}
                              onClick={() => {
                                if (inCart) {
                                  setToast({ title: "Already in cart", body: `${item.brand} ${item.title}` });
                                } else {
                                  commitItemToCart(item);
                                }
                              }}
                            >
                              {inCart ? "In Cart ✓" : "+ Add"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="pdp">
                    <div className="pdp-art"><ProductArt product={active} /></div>
                    <p className="pdp-brand">{active.brand}</p>
                    <h3 className="pdp-title">{active.title}{active.size ? `, ${active.size}` : ""}</h3>
                    <div className="pdp-rating">★★★★☆ <span>(2,184)</span></div>
                    <div className="pdp-price">{active.price ? `$${active.price.toFixed(2)}` : "See price in app"}</div>
                    <div className="pdp-cta-row">
                      <button
                        className="pdp-add"
                        onClick={() => {
                          if (cart.some((c) => c.key === active.key)) {
                            setToast({ title: "Already in cart", body: `${active.brand} ${active.title}` });
                          } else {
                            commitItemToCart(active);
                          }
                        }}
                      >
                        {cart.some((c) => c.key === active.key) ? "In cart ✓" : "Add to cart"}
                      </button>
                      {swap ? (
                        <button
                          id="pdp-quick-swap"
                          type="button"
                          className="pdp-swap-inline"
                          onClick={doSwap}
                        >
                          ⚡ 1-Tap Clean Swap ({swap.score}/100)
                        </button>
                      ) : activeRevertTarget ? (
                        <button
                          id="pdp-revert-swap"
                          type="button"
                          className="trip-pill"
                          onClick={() => revertSwap(active)}
                        >
                          ↺ Revert back to {activeRevertTarget.brand} {activeRevertTarget.title}
                        </button>
                      ) : null}
                    </div>
                    <div className="pdp-fulfil">
                      <div><b>Pickup</b><span>Today</span></div>
                      <div><b>Delivery</b><span>As soon as 1 hr</span></div>
                      <div><b>Shipping</b><span>Not available</span></div>
                    </div>
                    <div className="pdp-section"><h4>About this item</h4><p>{active.description || `Popular pick in ${active.category ?? "Grocery"}. Customers frequently buy this together with other pantry staples.`}</p></div>
                    <div className="pdp-section"><h4>Specifications</h4><p>Brand: {active.brand}<br />Category: {active.category ?? "Grocery"}</p></div>
                    <div className="pdp-section"><h4>Ingredients</h4><p className="pdp-ingredients">{active.ingredients}</p><small className="no-scroll-note">HeyBroc already read this — no scrolling needed.</small></div>
                  </div>
                )}
              </div>

              {/* ---------- OVERLAY: Dual-Mode Floating Pill ---------- */}
              {!hiddenForTrip && overlay !== "card" && (
                <div
                  id="floating-overlay-pill"
                  className={`pill pill--${pillTheme} tone-${isCartBubbleMode ? cartAvgTone : score.color} ${overlay === "min" || pillSize === "compact" ? "is-min" : ""} ${isCartBubbleMode ? "is-cart-avg" : ""} ${cartClimbFlash ? "is-climbing" : ""}`}
                  style={{
                    top: `${pillY}%`,
                    transform: pillDragOffset
                      ? `translate(${pillDragOffset.x}px, -50%)`
                      : "translateY(-50%)",
                  }}
                  onPointerDown={onPillDown}
                  onPointerMove={onPillMove}
                  onPointerUp={onPillUp}
                  onClick={(e) => {
                    e.stopPropagation();
                    triggerPillTap(isCartBubbleMode, overlay === "pill");
                  }}
                  role="button"
                  aria-label={
                    isCartBubbleMode
                      ? `Cart Average ${animatedCartAvg} of 100. Tap to open Whole-Cart Health Check.`
                      : `HeyBroc score ${score.score} of 100. Tap to inspect.`
                  }
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      if (isCartBubbleMode) openAudit();
                      else setOverlay("card");
                    }
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/broc-mascot.jpg" alt="" className="pill-mascot" />
                  <span className="pill-dot" />
                  {overlay === "min" || pillSize === "compact" ? (
                    <b>{isCartBubbleMode ? `🛒 ${animatedCartAvg}/100` : `${score.score}/100`}</b>
                  ) : isCartBubbleMode ? (
                    <>
                      <span>🛒 Cart Avg:</span>
                      <b>{animatedCartAvg}/100</b>
                      {cartClimbFlash && <span className="climb-arrow">↑</span>}
                      <button
                        className="pill-collapse"
                        aria-label="Minimize"
                        onPointerDown={(e) => e.stopPropagation()}
                        onPointerUp={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); setOverlay("min"); }}
                      >›</button>
                    </>
                  ) : (
                    <>
                      <b>{score.score}/100</b>
                      <span className="pill-sep">•</span>
                      <span>Tap to Inspect</span>
                      <button
                        className="pill-collapse"
                        aria-label="Minimize"
                        onPointerDown={(e) => e.stopPropagation()}
                        onPointerUp={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); setOverlay("min"); }}
                      >›</button>
                    </>
                  )}
                </div>
              )}

              {/* ---------- Bottom-Center Drag-to-Hide Drop Target ---------- */}
              {pillDragOffset && (
                <div
                  id="hide-drop-target"
                  className={`hide-drop-zone ${overHideZone ? "is-hot" : ""}`}
                >
                  ✕ Remove
                </div>
              )}

              {/* ---------- OVERLAY: Yuka-Style HeyBroc Drawer ---------- */}
              {overlay === "card" && (
                <div
                  className="backdrop"
                  onClick={() => {
                    if (Date.now() - cardOpenedAtRef.current < 500) return;
                    setOverlay("pill");
                  }}
                >
                  <div className="insights yuka-sheet" role="dialog" aria-label="Health Insights" onClick={(e) => e.stopPropagation()}>
                    {/* Top Header */}
                    <div className="insights-head yuka-topbar">
                      <div className="yuka-topbar-left">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src="/broc-mascot.jpg" alt="Broc" className="yuka-topbar-mascot" />
                        <div>
                          <span className="eyebrow">HeyBroc · Cart Avg {animatedCartAvg}/100</span>
                          <h3>
                            {yukaTab === "inspect"
                              ? "Product Analysis"
                              : yukaTab === "history"
                                ? favOnly
                                  ? "Favorites"
                                  : "History"
                                : yukaTab === "recs"
                                  ? "Recommendations"
                                  : yukaTab === "top"
                                    ? "Top Products"
                                    : "Search"}
                          </h3>
                        </div>
                      </div>
                      <div className="yuka-topbar-actions">
                        {yukaTab === "inspect" && (
                          <button
                            type="button"
                            className={`yuka-fav-btn ${favorites.includes(active.key) ? "is-fav" : ""}`}
                            onClick={() => toggleFavorite(active.key)}
                            aria-label="Toggle favorite"
                            title="Save to Favorites"
                          >
                            {favorites.includes(active.key) ? "★" : "☆"}
                          </button>
                        )}
                        {yukaTab === "history" && (
                          <button
                            type="button"
                            className={`yuka-fav-btn ${favOnly ? "is-fav" : ""}`}
                            onClick={() => setFavOnly((f) => !f)}
                            aria-label="Filter favorites"
                            title="Show Favorites"
                          >
                            ★
                          </button>
                        )}
                        <button
                          className="close"
                          onClick={() => {
                            if (Date.now() - cardOpenedAtRef.current < 500) return;
                            setOverlay("pill");
                          }}
                          aria-label="Close"
                        >×</button>
                      </div>
                    </div>

                    <div className="yuka-scroll-area">
                      {/* ==================== TAB 1: YUKA PRODUCT DETAIL (Negatives + Positives) ==================== */}
                      {yukaTab === "inspect" && (
                        <>
                          {/* Yuka Product Hero Header (Photo Left, Title/Brand/Dot/Score Right) */}
                          <div className="yuka-hero">
                            <ProductArt product={active} className="yuka-hero-img" />
                            <div className="yuka-hero-info">
                              <b className="yuka-hero-title">{active.title}</b>
                              <span className="yuka-hero-brand">{active.brand}</span>
                              {active.description && (
                                <p style={{ fontSize: 12, color: "#4b5563", margin: "4px 0 6px", lineHeight: 1.35 }}>
                                  {active.description}
                                </p>
                              )}
                              <div className="yuka-hero-score">
                                <span className={`yuka-dot tone-${score.color}`} />
                                <div>
                                  <strong>{score.score}/100</strong>
                                  <em>{score.score < 25 ? "Bad" : score.rating}</em>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* 1-Tap Clean Swap Banner right at top when dirty */}
                          {swap ? (
                            <div className="swap">
                              <button
                                id="inspect-clean-swap"
                                type="button"
                                className="swap-info swap-info--btn"
                                onClick={() => inspectCleanSwap(swap.category, active)}
                              >
                                <ProductArt product={cleanToProduct(swap.category, active)} className="swap-art" />
                                <div className="swap-info-copy">
                                  <span className="eyebrow eyebrow--green">1-Tap Clean Swap · {STORE_META[store].label}</span>
                                  <b>{swap.title}</b>
                                  <span className="swap-score">{swap.score}/100 Excellent · <em>Tap to inspect →</em></span>
                                </div>
                              </button>
                              <button id="swap-item" className="swap-btn" onClick={doSwap}>Swap Item</button>
                            </div>
                          ) : activeRevertTarget ? (
                            <div className="swap">
                              <div className="swap-preview-note">
                                <b>✓ Clean Swap Active ({score.score}/100)</b>
                                <p>Replaced: {activeRevertTarget.brand} {activeRevertTarget.title}</p>
                              </div>
                              {!cart.some((c) => c.key === active.key) && (
                                <button id="swap-item" className="swap-btn" onClick={doSwap}>
                                  Confirm Swap in Cart → {score.score}/100
                                </button>
                              )}
                              <button
                                type="button"
                                className="link-btn center"
                                onClick={() => revertSwap(active)}
                              >
                                ↺ Revert back to {activeRevertTarget.brand} {activeRevertTarget.title}
                              </button>
                            </div>
                          ) : null}

                          {/* 3-Pillar Score & Sugar / Refined Carb / Calorie Insight Card */}
                          {score.yukaBreakdown && (
                            <div
                              style={{
                                background: "#f8fafc",
                                border: "1px solid #e2e8f0",
                                borderRadius: 14,
                                padding: "12px 14px",
                                marginBottom: 12,
                              }}
                            >
                              <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.06em", color: "#64748b", textTransform: "uppercase" }}>
                                3-PILLAR SCORE BREAKDOWN
                              </div>
                              <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", marginTop: 4 }}>
                                🥗 Nutritional Quality: {score.yukaBreakdown.nutritionScore}/60 (Nutri-Score {score.yukaBreakdown.nutriScoreGrade})
                              </div>
                              <div style={{ fontSize: 12.5, color: "#475569", marginTop: 2 }}>
                                🧪 Additive Safety: {score.yukaBreakdown.additiveScore}/30 &nbsp;·&nbsp; 🌱 Organic Bonus: {score.yukaBreakdown.organicScore}/10
                              </div>
                              {score.yukaBreakdown.glucoseImpact && (
                                <div style={{ borderTop: "1px solid #e2e8f0", marginTop: 8, paddingTop: 8 }}>
                                  <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: "0.06em", color: "#64748b", textTransform: "uppercase" }}>
                                    SUGAR, REFINED CARB &amp; CALORIE INSIGHT
                                  </div>
                                  <div
                                    style={{
                                      fontSize: 12.5,
                                      fontWeight: 800,
                                      marginTop: 3,
                                      color:
                                        score.yukaBreakdown.glucoseImpact === "High Spike"
                                          ? "#dc2626"
                                          : score.yukaBreakdown.glucoseImpact === "Moderate Spike"
                                            ? "#ea580c"
                                            : "#16a34a",
                                    }}
                                  >
                                    🩸 Glucose Impact: {score.yukaBreakdown.glucoseImpact} &nbsp;·&nbsp; 🔥 {score.yukaBreakdown.calorieNote}
                                  </div>
                                  <p style={{ fontSize: 11.5, color: "#475569", margin: "2px 0 0", lineHeight: 1.45 }}>
                                    {score.yukaBreakdown.glucoseNote}
                                  </p>
                                </div>
                              )}
                            </div>
                          )}

                          {/* NEGATIVES Section */}
                          {score.flagged.length > 0 && (
                            <div className="yuka-section">
                              <h4 className="yuka-section-title">Negatives</h4>
                              <div className="yuka-list">
                                {/* Top Summary Row: Additives (with Benzene ring icon like Yuka) */}
                                <div className="yuka-row yuka-row--summary">
                                  <span className="yuka-row-icon"><YukaLineIcon kind="additives" /></span>
                                  <div className="yuka-row-text">
                                    <b>Additives &amp; Nutrition Flags</b>
                                    <small>Contains {score.flagged.length} item{score.flagged.length === 1 ? "" : "s"} to watch</small>
                                  </div>
                                  <div className="yuka-row-right">
                                    <span className="yuka-row-val">{score.flagged.length}</span>
                                    <span className="yuka-dot tone-red" />
                                  </div>
                                </div>

                                {/* Each Flagged Additive Row (Always expanded with plain-English explanation visible immediately) */}
                                {score.flagged.map((f: FlaggedAdditive) => {
                                  const dotTone = f.risk === "high" ? "red" : "yellow";
                                  return (
                                    <div key={f.id} className="yuka-row-wrap">
                                      <div className="yuka-row is-open">
                                        <span className="yuka-row-icon"><YukaLineIcon kind={f.category} /></span>
                                        <div className="yuka-row-text">
                                          <b>{f.name}</b>
                                          <small>{CATEGORY_LABELS[f.category]} · {RISK_LABEL[f.risk]}</small>
                                        </div>
                                        <div className="yuka-row-right">
                                          <span className="yuka-row-val">−{f.penalty} pts</span>
                                          <span className={`yuka-dot tone-${dotTone}`} />
                                        </div>
                                      </div>
                                      <div className={`explain risk-${f.risk}`}>
                                        <b>{f.name}</b> <span>{RISK_LABEL[f.risk]} · −{f.penalty} pts</span>
                                        <p>{f.explanation}</p>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {/* Yuka POSITIVES Section */}
                          <div className="yuka-section">
                            <h4 className="yuka-section-title">Positives</h4>
                            <div className="yuka-list">
                              {ALL_CATEGORIES.filter(
                                (cat) =>
                                  !score.flagged.some((f) => f.category === cat) &&
                                  !score.ignored.some((f) => f.category === cat),
                              ).map((cat) => {
                                const meta = POSITIVE_CHECKS[cat];
                                return (
                                  <div key={cat} className="yuka-row">
                                    <span className="yuka-row-icon"><YukaLineIcon kind={cat} /></span>
                                    <div className="yuka-row-text">
                                      <b>{meta.title}</b>
                                      <small>{meta.subtitle}</small>
                                    </div>
                                    <div className="yuka-row-right">
                                      <span className="yuka-row-val">{meta.badge}</span>
                                      <span className="yuka-dot tone-green" />
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>

                          {/* Full Ingredient List */}
                          <div className="insights-ingredients-box">
                            <span>Ingredients Inspected:</span>
                            <p>{active.ingredients}</p>
                            <small style={{ display: "block", marginTop: 6, fontSize: 10.5, color: "#64748b", lineHeight: 1.4 }}>
                              Informational opinion only — not medical or regulatory advice. All rated ingredients are permitted under U.S. FDA regulations; scores reflect HeyBroc&apos;s independent clean-label rubric.
                            </small>
                          </div>
                        </>
                      )}

                      {/* ==================== TAB 2: YUKA HISTORY & FAVORITES ==================== */}
                      {yukaTab === "history" && (
                        <div className="yuka-history">
                          {favOnly && favorites.length === 0 ? (
                            <div className="yuka-empty-fav">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src="/broc-mascot.jpg" alt="Broc" className="yuka-empty-mascot" />
                              <span className="yuka-empty-star">★</span>
                              <h4>NO FAVORITES</h4>
                              <p>Add a favorite by tapping the ☆ star in the top corner of any product.</p>
                            </div>
                          ) : (
                            <ul className="yuka-history-list">
                              {(favOnly
                                ? scanHistory.filter((h) => favorites.includes(h.product.key))
                                : scanHistory
                              ).map(({ product: hp, timeLabel }) => {
                                const hs = gradeProduct(`${hp.brand} ${hp.title}`, hp.ingredients, watch, hp.nutrition, familyWatchlist);
                                return (
                                  <li key={hp.key}>
                                    <button
                                      type="button"
                                      className="yuka-history-row"
                                      onClick={() => showProduct(hp, false, true)}
                                    >
                                      <ProductArt product={hp} className="yuka-history-img" />
                                      <div className="yuka-history-info">
                                        <b>{hp.title}</b>
                                        <span className="yuka-history-brand">{hp.brand}</span>
                                        <span className="yuka-history-rating">
                                          <i className={`yuka-dot tone-${hs.color}`} />
                                          {hs.score < 25 ? "Bad" : hs.rating} · {hs.score}/100
                                        </span>
                                        <small className="yuka-history-time">🕒 {timeLabel}</small>
                                      </div>
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      )}

                      {/* ==================== TAB 3: YUKA SIDE-BY-SIDE RECOMMENDATIONS (Recs) ==================== */}
                      {yukaTab === "recs" && (
                        <div className="yuka-recs">
                          <p className="yuka-recs-sub">
                            Tap any product to inspect its ingredients, or tap <b>Swap</b> to replace it in your {STORE_META[store].label} cart.
                          </p>
                          <div className="yuka-recs-grid">
                            {PRESETS.map((p) => {
                              const dirtyProd = presetToProduct(p);
                              const dirtyScore = gradeProduct(`${p.brand} ${p.title}`, p.ingredients, watch, undefined, familyWatchlist);
                              const cleanProd = cleanToProduct(p.category, dirtyProd);
                              const cleanScore = gradeProduct(
                                `${cleanProd.brand} ${cleanProd.title}`,
                                cleanProd.ingredients,
                                watch,
                                undefined,
                                familyWatchlist,
                              );
                              return (
                                <div key={p.id} className="yuka-rec-pair">
                                  {/* Left Dirty Card */}
                                  <button
                                    type="button"
                                    className="yuka-rec-card"
                                    onClick={() => showProduct(dirtyProd, false, true)}
                                  >
                                    <span className="yuka-rec-badge is-bad">✕</span>
                                    <ProductArt product={dirtyProd} className="yuka-rec-img" />
                                    <b className="yuka-rec-title">{dirtyProd.title}</b>
                                    <small className="yuka-rec-brand">{dirtyProd.brand}</small>
                                    <span className="yuka-rec-status">
                                      <i className={`yuka-dot tone-${dirtyScore.color}`} />
                                      {dirtyScore.score < 25 ? "Bad" : dirtyScore.rating} ({dirtyScore.score})
                                    </span>
                                  </button>

                                  {/* Center Overlapping Swap Circle */}
                                  <span className="yuka-rec-arrows" aria-hidden>⇄</span>

                                  {/* Right Clean Card */}
                                  <div className="yuka-rec-card is-clean-card">
                                    <button
                                      type="button"
                                      className="yuka-rec-card-inner"
                                      onClick={() => inspectCleanSwap(p.category, dirtyProd)}
                                    >
                                      <span className="yuka-rec-badge is-good">✓</span>
                                      <ProductArt product={cleanProd} className="yuka-rec-img" />
                                      <b className="yuka-rec-title">{cleanProd.title}</b>
                                      <small className="yuka-rec-brand">{cleanProd.brand}</small>
                                      <span className="yuka-rec-status">
                                        <i className={`yuka-dot tone-${cleanScore.color}`} />
                                        {cleanScore.rating} ({cleanScore.score})
                                      </span>
                                    </button>
                                    <button
                                      type="button"
                                      className="yuka-rec-swap-btn"
                                      onClick={() => swapCartItem(dirtyProd)}
                                    >
                                      ⚡ 1-Tap Swap
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* ==================== TAB 4: YUKA TOP PRODUCTS BY CATEGORY ==================== */}
                      {yukaTab === "top" && (
                        <div className="yuka-top">
                          <div className="yuka-invite-card">
                            <span className="yuka-invite-icon">👥</span>
                            <div>
                              <b>Share HeyBroc with a friend &amp; unlock all #1 Clean Picks</b>
                              <button
                                type="button"
                                className="yuka-invite-link"
                                onClick={() => {
                                  setOverlay("pill");
                                  setScorecardOpen(true);
                                }}
                              >
                                Share 9:16 Clean Haul Scorecard →
                              </button>
                            </div>
                          </div>
                          <ul className="yuka-cat-list">
                            {(
                              [
                                { cat: "Yogurt" as SwapCategory, label: "Yogurt & Dairy", icon: "🥣", bg: "#fef3c7", free: true },
                                { cat: "Crackers" as SwapCategory, label: "Crackers & Cheddars", icon: "🧀", bg: "#ffedd5", free: true },
                                { cat: "Dressings" as SwapCategory, label: "Ranch & Dressings", icon: "🥗", bg: "#dcfce7", free: true },
                                { cat: "Deli Meat" as SwapCategory, label: "Deli Turkey & Meats", icon: "🥪", bg: "#fee2e2", free: true },
                                { cat: "Butter/Dairy" as SwapCategory, label: "Grass-Fed Butter", icon: "🧈", bg: "#fef9c3", free: true },
                                { cat: "Cereal" as SwapCategory, label: "Kids Cereals", icon: "🥣", bg: "#e0e7ff", free: false },
                                { cat: "Chips" as SwapCategory, label: "Tortilla & Potato Chips", icon: "🌮", bg: "#fae8ff", free: false },
                                { cat: "Bread" as SwapCategory, label: "Sprouted Breads", icon: "🍞", bg: "#f3e8ff", free: false },
                                { cat: "Snacks" as SwapCategory, label: "Cookies & Fruit Snacks", icon: "🍪", bg: "#ffe4e6", free: false },
                              ]
                            ).map((row) => {
                              const locked = !row.free && !isPro;
                              return (
                                <li key={row.cat}>
                                  <button
                                    type="button"
                                    className={`yuka-cat-row ${locked ? "is-locked" : ""}`}
                                    onClick={() => {
                                      if (locked) {
                                        setPaywallOpen(true);
                                      } else {
                                        inspectCleanSwap(row.cat);
                                      }
                                    }}
                                  >
                                    <span className="yuka-cat-tile" style={{ background: locked ? "#f1f5f9" : row.bg }}>
                                      {row.icon}
                                    </span>
                                    <span className="yuka-cat-label">{row.label}</span>
                                    <span className="yuka-cat-right">{locked ? "🔒" : "›"}</span>
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}

                      {/* ==================== TAB 5: YUKA SEARCH / MEMBER ACCESS ==================== */}
                      {yukaTab === "search" && (
                        <div className="yuka-search-tab">
                          <form
                            className="search"
                            onSubmit={(e) => {
                              runLive(e);
                              setYukaTab("inspect");
                            }}
                          >
                            <input
                              value={query}
                              onChange={(e) => setQuery(e.target.value)}
                              placeholder="Search any grocery or beverage item…"
                              aria-label="Search any grocery or beverage product"
                            />
                            <button type="submit" disabled={liveState === "loading" || !query.trim()}>
                              {liveState === "loading" ? "…" : "Scan"}
                            </button>
                          </form>
                          <div className="yuka-member-card">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src="/broc-mascot.jpg" alt="Broc" className="yuka-member-mascot" />
                            <span className="yuka-member-eyebrow">MEMBER ACCESS</span>
                            <h4>Search for any product</h4>
                            <p>Packaged food and beverage products scored on our 3-pillar rubric (60% Nutritional Quality, 30% Additive Safety, 10% Organic Bonus) via Open Food Facts &amp; USDA FoodData Central.</p>
                            {!isPro && (
                              <button
                                type="button"
                                className="yuka-member-btn"
                                onClick={() => setPaywallOpen(true)}
                              >
                                Become a member
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* ==================== YUKA 5-TAB BOTTOM NAVIGATION BAR ==================== */}
                    <nav className="yuka-bottom-nav" aria-label="HeyBroc tabs">
                      <button
                        type="button"
                        className={`yuka-nav-item ${yukaTab === "inspect" ? "is-active" : ""}`}
                        onClick={() => setYukaTab("inspect")}
                      >
                        <span className="yuka-nav-pill">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src="/broc-mascot.jpg" alt="" className="yuka-nav-mascot" />
                        </span>
                        <small>Inspect</small>
                      </button>
                      <button
                        type="button"
                        className={`yuka-nav-item ${yukaTab === "history" ? "is-active" : ""}`}
                        onClick={() => {
                          setFavOnly(false);
                          setYukaTab("history");
                        }}
                      >
                        <span className="yuka-nav-pill">🕒</span>
                        <small>Scans</small>
                      </button>
                      <button
                        type="button"
                        className={`yuka-nav-item ${yukaTab === "top" ? "is-active" : ""}`}
                        onClick={() => setYukaTab("top")}
                      >
                        <span className="yuka-nav-pill">☰</span>
                        <small>Top Picks</small>
                      </button>
                      <button
                        type="button"
                        className={`yuka-nav-item ${yukaTab === "recs" ? "is-active" : ""}`}
                        onClick={() => setYukaTab("recs")}
                      >
                        <span className="yuka-nav-pill">⇄</span>
                        <small>Swaps</small>
                      </button>
                      <button
                        type="button"
                        className={`yuka-nav-item ${yukaTab === "search" ? "is-active" : ""}`}
                        onClick={() => setYukaTab("search")}
                      >
                        <span className="yuka-nav-pill">🔍</span>
                        <small>Search</small>
                      </button>
                    </nav>
                  </div>
                </div>
              )}

              {/* ---------- Whole-Cart Auditor & Cart Sheet ---------- */}
              {(cartOpen || auditOpen) && (
                <div
                  className="backdrop"
                  onClick={() => {
                    if (Date.now() - cardOpenedAtRef.current < 450) return;
                    setCartOpen(false);
                    setAuditOpen(false);
                  }}
                >
                  <div className="sheet" onClick={(e) => e.stopPropagation()}>
                    <div className="sheet-grip" />
                    <div className="insights-head">
                      <div className="yuka-topbar-left">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src="/broc-mascot.jpg" alt="Broc" className="yuka-topbar-mascot" />
                        <div>
                          <span className="eyebrow">{auditOpen ? "HeyBroc · Whole-Cart Health Check" : STORE_META[store].label}</span>
                          <h3>{auditOpen ? "Cart Health Check" : "Your cart"}</h3>
                        </div>
                      </div>
                      <button className="close" onClick={() => { setCartOpen(false); setAuditOpen(false); }} aria-label="Close">×</button>
                    </div>
                    {auditOpen && (
                      <div className="audit-summary">
                        <Gauge score={animatedCartAvg} rating="Cart avg" color={cartAvgTone} size={78} />
                        <p>
                          {auditBusy
                            ? "Checking your cart ingredients…"
                            : dirty.length
                              ? <><b>{dirty.length}</b> of {cart.length} items score under 75. Tap any item to inspect, or tap <b>Swap</b> to watch your Cart Avg climb!</>
                              : "Every item in your cart scores 75+. Clean Cart Approved! 🎉"}
                        </p>
                      </div>
                    )}
                    <ul className="cart-list">
                      {cartScored.map(({ item, s, sw }) => (
                        <li key={item.key} className="cart-row">
                          <button
                            className="cart-item"
                            onClick={() => {
                              setCartOpen(false);
                              setAuditOpen(false);
                              showProduct(item, true, true);
                            }}
                          >
                            <ProductArt product={item} className="cart-art" />
                            <span className="cart-text">
                              <b>{item.title}</b>
                              <small>{item.brand}{sw ? ` · Tap to inspect or swap → ${sw.brand}` : " · Tap to inspect"}</small>
                            </span>
                            <ScoreChip score={s.score} color={s.color} />
                          </button>
                          {sw ? (
                            <button
                              type="button"
                              className="cart-row-swap"
                              onClick={() => swapCartItem(item)}
                            >
                              Swap
                            </button>
                          ) : item.origin === "swap" ? (
                            <button
                              type="button"
                              className="trip-pill"
                              onClick={() => revertSwap(item)}
                            >
                              ↺ Revert
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    {auditOpen && dirty.length > 0 && (
                      <button id="swap-all" className="swap-btn swap-btn--wide" onClick={swapAll}>
                        Swap all {dirty.length} dirty items
                      </button>
                    )}
                    {auditOpen && (
                      <button
                        id="open-scorecard"
                        type="button"
                        className="scorecard-trigger-btn"
                        onClick={() => setScorecardOpen(true)}
                      >
                        📱 Generate 9:16 TikTok/IG Scorecard
                      </button>
                    )}
                    {cartOpen && <button className="link-btn center" onClick={openAudit}>Run Whole-Cart Health Check →</button>}
                  </div>
                </div>
              )}

              {toast && (
                <div className="toast" role="status">
                  <b>{toast.title}</b>
                  <p>{toast.body}</p>
                  {toast.href && <a href={toast.href} target="_blank" rel="noreferrer">View on {STORE_META[store].label} ↗</a>}
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      {/* ============ WHY HEYBROC COMPARISON SECTION ============ */}
      <section className="compare-section" aria-label="Why HeyBroc comparison">
        <div className="compare-card">
          <div className="compare-head">
            <span className="eyebrow eyebrow--green">THE MISSING LINK IN CLEAN GROCERIES</span>
            <h2>Why Parents Switch to HeyBroc</h2>
            <p>Combine the effortless floating bubble of coupon apps with transparent, deterministic food &amp; ingredient grading.</p>
          </div>

          <div className="compare-grid" role="table" aria-label="HeyBroc vs Coupon and Barcode Apps">
            {/* Header Row */}
            <div className="compare-row compare-row--head" role="row">
              <div className="compare-cell compare-cell--feature" role="columnheader">Feature</div>
              <div className="compare-cell" role="columnheader">Honey / Rakuten</div>
              <div className="compare-cell" role="columnheader">Barcode Apps</div>
              <div className="compare-cell compare-cell--broc" role="columnheader">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/broc-mascot.jpg" alt="" className="compare-mascot" />
                <span>HeyBroc</span>
              </div>
            </div>

            {/* Row 1 */}
            <div className="compare-row" role="row">
              <div className="compare-cell compare-cell--feature" role="cell">
                <b>Floats on Walmart, Instacart, Target, ALDI &amp; more</b>
              </div>
              <div className="compare-cell" role="cell">
                <span className="cmp-yes">✓</span>
                <small>Yes</small>
              </div>
              <div className="compare-cell" role="cell">
                <span className="cmp-no">✕</span>
                <small>No</small>
              </div>
              <div className="compare-cell compare-cell--broc" role="cell">
                <span className="cmp-yes cmp-yes--bright">✓</span>
                <small><b>Yes (12 stores)</b></small>
              </div>
            </div>

            {/* Row 2 */}
            <div className="compare-row" role="row">
              <div className="compare-cell compare-cell--feature" role="cell">
                <b>Grades ingredients (0–100) without a barcode camera</b>
              </div>
              <div className="compare-cell" role="cell">
                <span className="cmp-no">✕</span>
                <small>No</small>
              </div>
              <div className="compare-cell" role="cell">
                <span className="cmp-no">✕</span>
                <small>Barcode only</small>
              </div>
              <div className="compare-cell compare-cell--broc" role="cell">
                <span className="cmp-yes cmp-yes--bright">✓</span>
                <small><b>Reads screen automatically</b></small>
              </div>
            </div>

            {/* Row 3 */}
            <div className="compare-row" role="row">
              <div className="compare-cell compare-cell--feature" role="cell">
                <b>1-Tap Clean Food Swaps in your store app</b>
              </div>
              <div className="compare-cell" role="cell">
                <span className="cmp-no">✕</span>
                <small>Coupons only</small>
              </div>
              <div className="compare-cell" role="cell">
                <span className="cmp-no">✕</span>
                <small>No store links</small>
              </div>
              <div className="compare-cell compare-cell--broc" role="cell">
                <span className="cmp-yes cmp-yes--bright">✓</span>
                <small><b>Instant 1-Tap Swap</b></small>
              </div>
            </div>

            {/* Row 4 */}
            <div className="compare-row" role="row">
              <div className="compare-cell compare-cell--feature" role="cell">
                <b>Whole-Cart Health Check (Cart Avg 0–100)</b>
              </div>
              <div className="compare-cell" role="cell">
                <span className="cmp-no">✕</span>
                <small>No</small>
              </div>
              <div className="compare-cell" role="cell">
                <span className="cmp-no">✕</span>
                <small>No</small>
              </div>
              <div className="compare-cell compare-cell--broc" role="cell">
                <span className="cmp-yes cmp-yes--bright">✓</span>
                <small><b>Full Cart Check</b></small>
              </div>
            </div>
          </div>

          {/* Semantic SEO & GEO FAQ Section (Matches Schema.org FAQPage JSON-LD) */}
          <div style={{ marginTop: 28, borderTop: "1px solid #e2e8f0", paddingTop: 22 }}>
            <span className="eyebrow eyebrow--green">CLEAN INGREDIENT &amp; SCORING FAQ</span>
            <h3 style={{ fontSize: 20, fontWeight: 800, color: "#0f172a", margin: "6px 0 14px" }}>
              How HeyBroc Grades Groceries &amp; Finds Clean Swaps
            </h3>
            <div style={{ display: "grid", gap: 10 }}>
              <details style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 16px" }}>
                <summary style={{ fontWeight: 700, fontSize: 14, color: "#0f172a", cursor: "pointer" }}>
                  How does HeyBroc calculate its 0 to 100 food and ingredient score?
                </summary>
                <p style={{ marginTop: 8, fontSize: 13, lineHeight: 1.55, color: "#475569" }}>
                  HeyBroc grades products on a deterministic 0–100 scale across three pillars: <b>Nutritional Quality (60%)</b> based on sugar, sodium, saturated fat, calories, fiber, and protein; <b>Additive &amp; Chemical Safety (30%)</b> penalizing synthetic dyes, refined seed oils, chemical preservatives, nitrites, and emulsifiers; and a <b>Certified Organic Bonus (10%)</b>. Any high-risk additive automatically caps a product&apos;s maximum score at 49/100.
                </p>
              </details>
              <details style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 16px" }}>
                <summary style={{ fontWeight: 700, fontSize: 14, color: "#0f172a", cursor: "pointer" }}>
                  Which grocery stores work with the HeyBroc floating bubble?
                </summary>
                <p style={{ marginTop: 8, fontSize: 13, lineHeight: 1.55, color: "#475569" }}>
                  HeyBroc&apos;s Live Store Bubble works automatically across 12 major grocery stores and delivery apps: <b>Walmart, Instacart, Target, Kroger, ALDI, Costco, Sam&apos;s Club, BJ&apos;s Wholesale, Amazon Fresh, DoorDash, Uber Eats, and Shipt</b>—without needing to scan physical barcodes.
                </p>
              </details>
              <details style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 16px" }}>
                <summary style={{ fontWeight: 700, fontSize: 14, color: "#0f172a", cursor: "pointer" }}>
                  What ingredients and additives does HeyBroc flag?
                </summary>
                <p style={{ marginTop: 8, fontSize: 13, lineHeight: 1.55, color: "#475569" }}>
                  HeyBroc flags refined seed oils (soybean, canola, corn, cottonseed, sunflower, safflower), artificial food dyes (Red 40, Yellow 5, Yellow 6, Blue 1, Red 3, Titanium Dioxide), preservatives and nitrates (Sodium Nitrite, BHA, BHT, Potassium Bromate, TBHQ, Sodium Benzoate), sweeteners (High Fructose Corn Syrup, Sucralose, Aspartame, Ace-K), and synthetic emulsifiers or gums (Carrageenan, Polysorbate 80).
                </p>
              </details>
              <details style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 16px" }}>
                <summary style={{ fontWeight: 700, fontSize: 14, color: "#0f172a", cursor: "pointer" }}>
                  Does HeyBroc accept payments from brands to change product scores?
                </summary>
                <p style={{ marginTop: 8, fontSize: 13, lineHeight: 1.55, color: "#475569" }}>
                  No. HeyBroc is 100% independent. Brands cannot pay to alter a score or buy placement in Top Picks. Every product score and 1-for-1 Clean Swap is computed deterministically from its ingredient list and nutrition facts.
                </p>
              </details>
            </div>
            <div style={{ marginTop: 16, display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: "#64748b" }}>
              <a href="/tools" style={{ color: "#15803d", fontWeight: 700 }}>🧪 Free Ingredient &amp; Seed Oil Tools</a>
              <a href="/swaps" style={{ color: "#15803d", fontWeight: 700 }}>⇄ Clean Grocery Swaps Directory</a>
              <a href="/privacy" style={{ color: "#15803d", fontWeight: 600 }}>Privacy Policy &amp; Disclaimers</a>
              <a href="/llms.txt" style={{ color: "#15803d", fontWeight: 600 }}>AI &amp; LLM Index (llms.txt)</a>
              <a href="/sitemap.xml" style={{ color: "#15803d", fontWeight: 600 }}>Sitemap</a>
            </div>
            <div
              style={{
                marginTop: 16,
                padding: "12px 14px",
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: 12,
                fontSize: 11.5,
                lineHeight: 1.55,
                color: "#64748b",
              }}
            >
              <strong style={{ color: "#334155" }}>Independent Opinion, Label Verification, Pricing &amp; Non-Affiliation Notice:</strong>{" "}
              HeyBroc 0–100 scores and ratings represent HeyBroc&apos;s subjective clean-label opinion for informational grocery comparison only and do not constitute medical, nutritional, or regulatory safety advice. Most flagged additives, dyes, and oils are permitted for food use or recognized as GRAS by the U.S. FDA. Ingredient lists and sample prices shown in the simulator and catalog are representative estimates from public databases (Open Food Facts, USDA FoodData Central); manufacturers reformulate products frequently and retail prices vary by store and location—always verify the physical product package and live store checkout price before purchasing. When you tap a Clean Swap retail link, HeyBroc may earn an affiliate commission at no extra cost to you. HeyBroc is an independent software application and is not affiliated with, endorsed by, or sponsored by Walmart, Target, Instacart, Kroger, ALDI, Costco, Sam&apos;s Club, BJ&apos;s Wholesale Club, Amazon, Whole Foods Market, DoorDash, Uber Eats, Shipt, or any food or beverage manufacturer. All retailer and brand names are trademarks of their respective owners and are used strictly for nominative identification.
            </div>
          </div>
        </div>
      </section>

      {/* ============ PHASE 6 MODALS ============ */}
      <WatchlistMiniFunnel
        open={watchlistFunnelOpen}
        initialSelected={familyWatchlist}
        onClose={() => {
          if (typeof window !== "undefined") {
            window.localStorage.setItem("heybroc_onboarding_done", "1");
          }
          setWatchlistFunnelOpen(false);
        }}
        onApplyAndGuest={(selected) => {
          setFamilyWatchlist(selected);
          setWatch((prev) => {
            const next = { ...prev };
            for (const c of ALL_CATEGORIES) {
              next[c] = selected.includes(c) ? true : prev[c];
            }
            return next;
          });
          if (typeof window !== "undefined") {
            window.localStorage.setItem(
              "heybroc_family_watchlist",
              JSON.stringify(selected)
            );
            window.localStorage.setItem("heybroc_onboarding_done", "1");
          }
          setWatchlistFunnelOpen(false);
          setToast({
            title: `✓ Family Watchlist Applied (${selected.length} active)`,
            body: "2x strictness enabled — scan any product or tap Swap ↗ as a Guest anytime.",
          });
        }}
        onApplyAndSignIn={(selected) => {
          setFamilyWatchlist(selected);
          setWatch((prev) => {
            const next = { ...prev };
            for (const c of ALL_CATEGORIES) {
              next[c] = selected.includes(c) ? true : prev[c];
            }
            return next;
          });
          if (typeof window !== "undefined") {
            window.localStorage.setItem(
              "heybroc_family_watchlist",
              JSON.stringify(selected)
            );
            window.localStorage.setItem("heybroc_onboarding_done", "1");
          }
          setWatchlistFunnelOpen(false);
          setAuthOpen(true);
        }}
      />

      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        user={authUser}
        deviceId={deviceIdState}
        watchlist={watch}
        onAuthSuccess={(loggedInUser, token) => {
          setAuthUser(loggedInUser);
          if (typeof window !== "undefined") {
            window.localStorage.setItem("heybroc_auth_token", token);
            window.localStorage.setItem("heybroc_auth_user", JSON.stringify(loggedInUser));
            if (loggedInUser.referralCode) {
              window.localStorage.setItem("heybroc_my_referral_code", loggedInUser.referralCode);
            }
          }
          if (loggedInUser.referralCode) {
            setPersonalReferralCode(loggedInUser.referralCode);
          }
          if (loggedInUser.isProActive) {
            setIsPro(true);
          }
          setToast({
            title: `👋 Welcome back, ${loggedInUser.displayName}!`,
            body: `Signed in with ${loggedInUser.email}. Your Family Watchlist, Clean Swaps & Pro status are synced.`,
          });
        }}
        onLogout={() => {
          setAuthUser(null);
          if (typeof window !== "undefined") {
            window.localStorage.removeItem("heybroc_auth_token");
            window.localStorage.removeItem("heybroc_auth_user");
          }
          setToast({
            title: "Signed out",
            body: "Continuing in Guest mode — all scans, scores & Clean Swap store links remain active.",
          });
        }}
        onDeleteAccount={() => {
          setAuthUser(null);
          if (typeof window !== "undefined") {
            window.localStorage.removeItem("heybroc_auth_token");
            window.localStorage.removeItem("heybroc_auth_user");
          }
          setToast({
            title: "Account Deleted",
            body: "Your cloud account was permanently deleted. You can continue using HeyBroc as a Guest anytime.",
          });
        }}
      />

      <Paywall
        open={paywallOpen}
        onClose={() => setPaywallOpen(false)}
        scanCount={swapsUsedThisWeek}
        freeScanLimit={courtesyRefillAvailable ? FREE_SCAN_LIMIT : FREE_SCAN_LIMIT + 3}
        appliedCreator={appliedCreator}
        onCreatorApplied={(c) => {
          setAppliedCreator(c);
        }}
        onConversionComplete={({ plan, creator, trialDays }) => {
          setIsPro(true);
          setToast({
            title: creator
              ? `HeyBroc Family Pro Unlocked (${trialDays}-Day Free Trial)`
              : `HeyBroc Family Pro Unlocked (${plan})`,
            body: "Unlimited store overlays, 1-tap clean swaps & whole-cart health checks are now active.",
          });
        }}
        personalReferralCode={personalReferralCode}
        courtesyRefillAvailable={courtesyRefillAvailable}
        onUseCourtesyRefill={() => {
          setCourtesyRefillAvailable(false);
          setPaywallOpen(false);
          setToast({
            title: "✓ +3 Free Courtesy Swaps Added!",
            body: "Finish cleaning your cart right now — on us.",
          });
        }}
        onOpenLogin={() => {
          setPaywallOpen(false);
          setAuthOpen(true);
        }}
      />

      <Scorecard
        open={scorecardOpen}
        onClose={() => setScorecardOpen(false)}
        store={store}
        cartAvg={animatedCartAvg}
        swaps={swapHistory}
        fallbackDodged={fallbackDodged}
        fallbackSwaps={fallbackSwaps}
        defaultReferralCode={appliedCreator?.code || personalReferralCode}
        dirtyCount={dirty.length}
        onSwapAllAndMax={swapAll}
      />
    </div>
  );
}
