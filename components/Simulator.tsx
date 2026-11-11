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
  resolveSwapCandidates,
  type Store,
  type SwapCategory,
  type SwapResult,
} from "@/lib/swaps";
import type { PlanId } from "@/lib/pricing";
import { evaluateDietaryAlerts } from "@/lib/dietary";
import AuthModal, { type AuthenticatedUser } from "./AuthModal";
import LabelScannerModal from "./LabelScannerModal";
import Paywall, { type AppliedCreator } from "./Paywall";
import PostCheckoutOtoModal from "./PostCheckoutOtoModal";
import ProductExposeModal from "./ProductExposeModal";
import Scorecard, { type SwapRecord } from "./Scorecard";
import WatchlistMiniFunnel, {
  type DietaryOptionId,
  type FunnelStep,
  type OnboardingSelections,
} from "./WatchlistMiniFunnel";
import WeeklyOrderAuditModal, { type AuditedOrderItem } from "./WeeklyOrderAuditModal";

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
  image?: string;
  ingredients: string;
  nutrition?: NutritionInput;
  category?: SwapCategory;
  origin: Origin;
  replacedItem?: Product;
  quantity?: number;
  isNonFood?: boolean;
  lookup?: { source: string; origin?: string; sourceUpdatedAt?: string | null; ms: number };
}

interface ApiScan {
  ok: boolean;
  ignored?: boolean;
  reason?: string;
  error?: string;
  store?: Store;
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
  lookup?: { source: string; origin?: string; sourceUpdatedAt?: string | null; ms: number };
  result?: ScoreResult;
  swap?: SwapResult | null;
  storeBrandSwap?: SwapResult | null;
  swapCandidates?: SwapResult[];
}

interface DetectedBarcodeLike {
  rawValue?: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
}

const clampQty = (q?: number): number => {
  if (typeof q !== "number" || !Number.isFinite(q)) return 1;
  return Math.max(1, Math.min(99, Math.round(q)));
};

/**
 * Multi-barcode disambiguation: when >1 barcode appears in a camera frame or photo,
 * select the barcode whose bounding-box center is closest to the center reticle (frameW/2, frameH/2).
 */
function pickClosestBarcodeToCenter(
  barcodes: DetectedBarcodeLike[],
  frameWidth: number,
  frameHeight: number,
): string | null {
  const valid = barcodes.filter((b) => typeof b.rawValue === "string" && b.rawValue.trim().length > 0);
  if (valid.length === 0) return null;
  if (valid.length === 1 || frameWidth <= 0 || frameHeight <= 0) {
    return valid[0].rawValue!.trim();
  }
  const cx = frameWidth / 2;
  const cy = frameHeight / 2;
  let best = valid[0];
  let bestDistSq = Number.POSITIVE_INFINITY;
  for (const b of valid) {
    const box = b.boundingBox;
    if (!box) continue;
    const bx = box.x + box.width / 2;
    const by = box.y + box.height / 2;
    const distSq = (bx - cx) * (bx - cx) + (by - cy) * (by - cy);
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = b;
    }
  }
  return best.rawValue!.trim();
}

type Watch = Record<Category, boolean>;
const lookupSourceLabel = (lookup?: { source: string; origin?: string }) => {
  const source = lookup?.origin || lookup?.source || "catalog";
  const labels: Record<string, string> = {
    catalog: "Representative catalog formulation",
    openfoodfacts: "Open Food Facts record (ODbL / CC BY-SA 3.0)",
    usda: "USDA FoodData Central record",
    dsld: "NIH DSLD archived label record · Ingredient-only score",
    openbeautyfacts: "Open Beauty Facts non-food record",
    openproductsfacts: "Open Products Facts non-food record",
    openpetfoodfacts: "Open Pet Food Facts record",
    screen: "User-supplied ingredient text",
  };
  return labels[source] || source;
};
type OverlayState = "pill" | "card" | "min";
type ViewMode = "product" | "search";

const FREE_SCAN_LIMIT = 3;

const presetToProduct = (p: (typeof PRESETS)[number]): Product => ({
  key: p.id,
  title: p.title,
  brand: p.brand,
  size: p.size,
  image: p.image,
  ingredients: p.ingredients,
  category: p.category,
  origin: "preset",
  quantity: 1,
});

const cleanToProduct = (
  cat: SwapCategory,
  replacedItem?: Product,
  store: Store = "walmart",
  preferStoreBrand = false,
): Product => {
  const alt = replacedItem
    ? resolveCleanAlternative(`${replacedItem.brand} ${replacedItem.title}`, cat, store, preferStoreBrand)
    : resolveCleanAlternative(cat, cat, store, preferStoreBrand);
  const isOrganic = alt.nutrition?.isOrganic ?? alt.isOrganic === true;
  return {
    key: replacedItem
      ? `clean-${cat}-${replacedItem.key}-${store || "default"}${preferStoreBrand ? "-sb" : ""}`
      : `clean-${cat}-${store || "default"}${preferStoreBrand ? "-sb" : ""}`,
    title: alt.name,
    brand: alt.brand,
    size: alt.size,
    image: `/api/product-image?q=${encodeURIComponent(`${alt.brand} ${alt.name}`)}`,
    ingredients: alt.ingredients,
    nutrition: { ...alt.nutrition, isOrganic },
    category: cat,
    origin: "swap",
    replacedItem,
    quantity: replacedItem ? clampQty(replacedItem.quantity) : 1,
  };
};

const swapResultToProduct = (sw: SwapResult, replacedItem?: Product, store: Store = "walmart"): Product => {
  const cleanTitle = sw.title.replace(
    new RegExp(`^${sw.brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"),
    "",
  ) || sw.title;
  return {
    key: `swap-${sw.brand}-${cleanTitle}-${replacedItem?.key ?? "direct"}-${store}`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-"),
    title: cleanTitle,
    brand: sw.brand,
    size: sw.size,
    image: sw.image || `/api/product-image?q=${encodeURIComponent(`${sw.brand} ${cleanTitle}`)}`,
    ingredients: sw.ingredients,
    nutrition: sw.nutrition,
    category: sw.category,
    origin: "swap",
    replacedItem,
    quantity: replacedItem ? clampQty(replacedItem.quantity) : 1,
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

function Gauge({ score, rating, color, size = 112 }: { score: number | null; rating: string; color: string; size?: number }) {
  const r = 44;
  const c = 2 * Math.PI * r;
  const isEmpty = score === null || !Number.isFinite(score);
  const safeScore = isEmpty ? 0 : Math.max(0, Math.min(100, score));
  return (
    <div
      className={`gauge tone-${isEmpty ? "neutral" : color}`}
      style={{ width: size, height: size }}
      aria-label={isEmpty ? `Empty cart, ${rating}` : `${safeScore} out of 100, ${rating}`}
    >
      <svg viewBox="0 0 100 100" width={size} height={size}>
        <circle cx="50" cy="50" r={r} className="gauge-track" style={isEmpty ? { stroke: "#e2e8f0" } : undefined} />
        {!isEmpty && (
          <circle
            cx="50" cy="50" r={r}
            className="gauge-fill"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - safeScore / 100)}
            transform="rotate(-90 50 50)"
          />
        )}
      </svg>
      <div className="gauge-label">
        {isEmpty ? (
          <>
            <strong style={{ color: "#64748b" }}>--</strong>
            <em style={{ color: "#64748b" }}>{rating}</em>
          </>
        ) : (
          <>
            <strong>{safeScore}<span>/100</span></strong>
            <em>{rating}</em>
          </>
        )}
      </div>
    </div>
  );
}

function ProductArt({ product, className = "", showAttribution = false }: { product: Product; className?: string; showAttribution?: boolean }) {
  const apiFallbackSrc = `/api/product-image?q=${encodeURIComponent(`${product.brand} ${product.title}`.trim())}&v=5`;
  const primarySrc = product.image || apiFallbackSrc;
  const [failedSrcs, setFailedSrcs] = useState<Record<string, boolean>>({});
  const [imgLicense, setImgLicense] = useState<string | null>(null);
  const [imgSource, setImgSource] = useState<string | null>(null);

  const activeSrc = !failedSrcs[primarySrc]
    ? primarySrc
    : !failedSrcs[apiFallbackSrc]
      ? apiFallbackSrc
      : "/swaps/snacks.jpg";

  useEffect(() => {
    const src = activeSrc;
    if (!src) {
      setImgLicense(null);
      setImgSource(null);
      return;
    }
    if (src.includes("openfoodfacts.org") || src.includes("openfoodfacts.net")) {
      setImgLicense("CC BY-SA 3.0");
      setImgSource(src);
      return;
    }
    if (src.includes("/api/product-image")) {
      let cancelled = false;
      const probeUrl = src.replace(/^https?:\/\/(www\.)?heybroc\.com/i, "");
      fetch(probeUrl, { method: "HEAD" })
        .then((res) => {
          if (cancelled) return;
          const lic = res.headers.get("x-image-license");
          const srcHeader = res.headers.get("x-image-source");
          if (lic && lic.includes("CC BY-SA")) {
            setImgLicense(lic);
            const urlMatch = srcHeader?.match(/https:\/\/[^\s)]+/);
            setImgSource(urlMatch ? urlMatch[0] : srcHeader || "https://world.openfoodfacts.org");
          } else {
            setImgLicense(null);
            setImgSource(null);
          }
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }
    setImgLicense(null);
    setImgSource(null);
  }, [activeSrc]);

  const isCcBySa = Boolean(imgLicense && imgLicense.includes("CC BY-SA")) || product.lookup?.source === "openfoodfacts";
  const resolvedSourceUrl =
    imgSource && imgSource.startsWith("https://")
      ? imgSource
      : activeSrc.includes("openfoodfacts.org") || activeSrc.includes("openfoodfacts.net")
        ? activeSrc
        : "https://world.openfoodfacts.org";

  const imgEl = (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      className={`product-art ${className}`}
      src={activeSrc}
      alt={`${product.brand} ${product.title}`}
      title={isCcBySa ? `Image: Open Food Facts (${resolvedSourceUrl}) — CC BY-SA 3.0` : undefined}
      onError={() => setFailedSrcs((prev) => (prev[activeSrc] ? prev : { ...prev, [activeSrc]: true }))}
    />
  );

  if (showAttribution && isCcBySa) {
    return (
      <div className="product-art-attr-wrap" style={{ flex: "none", display: "flex", flexDirection: "column", alignItems: "center", maxWidth: 88 }}>
        {imgEl}
        <small className="product-art-license" style={{ display: "block", fontSize: 9, color: "#64748b", marginTop: 3, lineHeight: 1.2, textAlign: "center" }}>
          <a href={resolvedSourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>
            OFF
          </a>{" "}
          ·{" "}
          <a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>
            CC BY-SA
          </a>
        </small>
      </div>
    );
  }

  return imgEl;
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

export default function Simulator({
  initialAdTestMode = false,
}: {
  initialAdTestMode?: boolean;
} = {}) {
  const [store, setStore] = useState<Store>("walmart");
  const [watch, setWatch] = useState<Watch>(DEFAULT_WATCHLIST);
  const [active, setActive] = useState<Product>(presetToProduct(PRESETS[0]));
  const [previousDirtyItem, setPreviousDirtyItem] = useState<Product | null>(null);
  const [cartsByStore, setCartsByStore] = useState<Record<Store, Product[]>>(() => {
    const initial = {} as Record<Store, Product[]>;
    for (const s of STORES) {
      initial[s] = s === "walmart" ? PRESETS.map(presetToProduct) : [];
    }
    return initial;
  });
  const cart = useMemo(() => cartsByStore[store] ?? [], [cartsByStore, store]);
  const setCart = useCallback(
    (updater: Product[] | ((prev: Product[]) => Product[])) => {
      setCartsByStore((prev) => {
        const current = prev[store] ?? [];
        const next = typeof updater === "function" ? updater(current) : updater;
        return { ...prev, [store]: next };
      });
    },
    [store],
  );
  const [selectedSwapIdx, setSelectedSwapIdx] = useState(0);
  const [isIosApp, setIsIosApp] = useState(false);
  const [barcodeScannerOpen, setBarcodeScannerOpen] = useState(false);
  const [barcodeCameraActive, setBarcodeCameraActive] = useState(false);
  const [barcodeStatus, setBarcodeStatus] = useState("");
  const barcodeVideoRef = useRef<HTMLVideoElement | null>(null);
  const barcodeStreamRef = useRef<MediaStream | null>(null);
  const barcodeRafRef = useRef<number>(0);

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

  // Paywall, Low-Friction Ad Landing Mode & Post-Checkout OTO state
  const [adTestMode, setAdTestMode] = useState<boolean>(initialAdTestMode);
  const [freeTestCompleted, setFreeTestCompleted] = useState<boolean>(false);
  const [otoModalOpen, setOtoModalOpen] = useState<boolean>(false);
  const [otoInitialPlan, setOtoInitialPlan] = useState<PlanId>("annual");
  const [otoSessionId, setOtoSessionId] = useState<string>("");
  const [scanCount, setScanCount] = useState(1);
  const [swapsUsedThisWeek, setSwapsUsedThisWeek] = useState(0);
  const [weeklySwapLimit, setWeeklySwapLimit] = useState(FREE_SCAN_LIMIT);
  const [courtesyRefillAvailable, setCourtesyRefillAvailable] = useState(true);
  const [personalReferralCode, setPersonalReferralCode] = useState("BROC-7F4A2");
  const [isPro, setIsPro] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [watchlistFunnelOpen, setWatchlistFunnelOpen] = useState(false);
  const [watchlistFunnelStep, setWatchlistFunnelStep] = useState<FunnelStep>(1);
  const [manualFunnelOpen, setManualFunnelOpen] = useState(false);
  const [onboardingDoneState, setOnboardingDoneState] = useState(false);
  const [familyWatchlist, setFamilyWatchlist] = useState<Category[]>(["seedOils", "dyes", "hfcs"]);
  const [dietaryWatchlist, setDietaryWatchlist] = useState<DietaryOptionId[]>([]);
  const [preferredStores, setPreferredStores] = useState<Store[] | undefined>(undefined);
  const [preferStoreBrand, setPreferStoreBrand] = useState(false);
  const [labelScannerOpen, setLabelScannerOpen] = useState(false);
  const [weeklyAuditOpen, setWeeklyAuditOpen] = useState(false);
  const [exposeCardOpen, setExposeCardOpen] = useState(false);
  const [pendingSharedQuery, setPendingSharedQuery] = useState<{ q: string; storeOverride?: Store } | null>(null);
  const [authUser, setAuthUser] = useState<AuthenticatedUser | null>(null);
  const [deviceIdState, setDeviceIdState] = useState("anon-web");
  const [appliedCreator, setAppliedCreator] = useState<AppliedCreator | null>(null);
  const [scorecardOpen, setScorecardOpen] = useState(false);

  const togglePreferStoreBrand = useCallback((explicitNext?: boolean) => {
    setPreferStoreBrand((prev) => {
      const next = typeof explicitNext === "boolean" ? explicitNext : !prev;
      if (typeof window !== "undefined") {
        window.localStorage.setItem("heybroc_prefer_store_brand", next ? "1" : "0");
      }
      return next;
    });
    setSelectedSwapIdx(0);
  }, []);

  const [toast, setToast] = useState<{ title: string; body: string; href?: string; isPaidLink?: boolean } | null>(null);

  const pesticideWatchEnabled = useMemo(
    () => dietaryWatchlist.includes("pesticide_risk"),
    [dietaryWatchlist],
  );

  const togglePesticideWatch = useCallback((explicitNext?: boolean) => {
    setDietaryWatchlist((prev) => {
      const has = prev.includes("pesticide_risk");
      const shouldEnable = typeof explicitNext === "boolean" ? explicitNext : !has;
      const next: DietaryOptionId[] = shouldEnable
        ? has
          ? prev
          : [...prev, "pesticide_risk"]
        : prev.filter((id) => id !== "pesticide_risk");
      if (typeof window !== "undefined") {
        window.localStorage.setItem("heybroc_dietary_watchlist", JSON.stringify(next));
      }
      setToast({
        title: shouldEnable
          ? "🌱 Herbicides & Pesticides Watch: ON"
          : "🌱 Herbicides & Pesticides Watch: OFF",
        body: shouldEnable
          ? "Flagging conventional Dirty-Dozen produce & non-organic oats, wheat & legumes — and surfacing certified USDA Organic swaps."
          : "Conventional produce & grain pesticide alerts turned off.",
      });
      return next;
    });
    setSelectedSwapIdx(0);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const iosBridge = (
      window as unknown as {
        webkit?: { messageHandlers?: { controller?: { postMessage?: (msg: unknown) => void } } };
      }
    ).webkit?.messageHandlers?.controller;
    if (typeof iosBridge?.postMessage === "function") {
      try {
        iosBridge.postMessage({
          action: "sync-preferences",
          dietaryWatchlist,
          familyWatchlist,
          preferStoreBrand,
          store,
        });
      } catch {
        /* ignore bridge errors */
      }
    }
  }, [dietaryWatchlist, familyWatchlist, preferStoreBrand, store]);

  useEffect(() => {
    let cancelled = false;
    async function checkEntitlement() {
      try {
        const randomHex = (bytes: number) => {
          const arr = new Uint8Array(bytes);
          window.crypto.getRandomValues(arr);
          return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
        };
        let deviceId = window.localStorage.getItem("heybroc_device_id");
        if (!deviceId) {
          deviceId = `web-${randomHex(8)}-${Date.now().toString(36)}`;
          window.localStorage.setItem("heybroc_device_id", deviceId);
        }
        let deviceSecret = window.localStorage.getItem("heybroc_device_secret");
        if (!deviceSecret) {
          deviceSecret = `sec-${randomHex(16)}`;
          window.localStorage.setItem("heybroc_device_secret", deviceSecret);
        }
        if (!cancelled) setDeviceIdState(deviceId);

        let savedPreferSb = false;
        try {
          savedPreferSb = window.localStorage.getItem("heybroc_prefer_store_brand") === "1";
          if (savedPreferSb && !cancelled) {
            setPreferStoreBrand(true);
          }
          const savedWatch1x = JSON.parse(
            window.localStorage.getItem("heybroc_watchlist_1x") || "null"
          ) as Partial<Watch> | null;
          if (savedWatch1x && typeof savedWatch1x === "object" && !cancelled) {
            setWatch((prev) => ({ ...prev, ...savedWatch1x }));
          }
          const savedWl = JSON.parse(
            window.localStorage.getItem("heybroc_family_watchlist") || "null"
          ) as Category[] | null;
          if (Array.isArray(savedWl) && !cancelled) {
            setFamilyWatchlist(savedWl);
          }
          const savedDiet = JSON.parse(
            window.localStorage.getItem("heybroc_dietary_watchlist") || "null"
          ) as DietaryOptionId[] | null;
          if (Array.isArray(savedDiet) && !cancelled) {
            setDietaryWatchlist(savedDiet);
          }
          const rawSavedStores = window.localStorage.getItem("heybroc_preferred_stores");
          if (rawSavedStores !== null && !cancelled) {
            const parsedStores = JSON.parse(rawSavedStores) as unknown;
            if (Array.isArray(parsedStores)) {
              const validStores = parsedStores.filter(
                (s): s is Store => typeof s === "string" && (STORES as readonly string[]).includes(s)
              );
              setPreferredStores(Array.from(new Set(validStores)));
            }
          }
          const savedStore = (window.localStorage.getItem("heybroc_preferred_store") || "").trim();
          if (savedStore && (STORES as string[]).includes(savedStore) && !cancelled) {
            const nextStore = savedStore as Store;
            setStore(nextStore);
            setCart((prevCart) =>
              prevCart.map((item) =>
                item.origin === "swap" && item.category
                  ? cleanToProduct(item.category, item.replacedItem, nextStore, savedPreferSb)
                  : item
              )
            );
          }
        } catch {
          /* ignore */
        }

        // Clear legacy unverified flag so forged localStorage cannot unlock Pro
        window.localStorage.removeItem("heybroc_pro");
        const params = new URLSearchParams(window.location.search);
        const iosNative =
          params.get("platform") === "ios" ||
          /HeyBrocIOS/i.test(window.navigator.userAgent || "") ||
          Boolean(
            (window as unknown as { webkit?: { messageHandlers?: { controller?: unknown } } })
              .webkit?.messageHandlers?.controller,
          );
        if (!cancelled && iosNative) {
          setIsIosApp(true);
        }
        const urlStoreParam = (params.get("store") || "").trim();
        const validUrlStore =
          urlStoreParam && (STORES as string[]).includes(urlStoreParam) ? (urlStoreParam as Store) : undefined;
        if (validUrlStore && !cancelled) {
          setStore(validUrlStore);
        }
        const sharedParts = [
          params.get("share"),
          params.get("q"),
          params.get("productTitle"),
          params.get("url"),
          params.get("text"),
          params.get("title"),
        ]
          .map((v) => (v || "").trim())
          .filter(Boolean);
        const sharedIncoming = Array.from(new Set(sharedParts)).join(" ").trim();
        if (sharedIncoming && !cancelled) {
          setPendingSharedQuery({ q: sharedIncoming, storeOverride: validUrlStore });
        }

        const onboardingDone = window.localStorage.getItem("heybroc_onboarding_done") === "1";
        if (!cancelled) setOnboardingDoneState(onboardingDone);
        const isAdTestLanding =
          initialAdTestMode || params.get("ad") === "test" || params.get("test") === "1";
        if (isAdTestLanding) {
          setAdTestMode(true);
        }
        if (params.get("login") === "1") {
          setAuthOpen(true);
        } else if (params.get("upgrade") === "1") {
          setPaywallOpen(true);
        } else if (
          params.get("onboarding") === "1" ||
          (!onboardingDone &&
            !sharedIncoming &&
            !params.get("session_id") &&
            params.get("checkout") !== "cancelled" &&
            !isAdTestLanding)
        ) {
          setManualFunnelOpen(false);
          setWatchlistFunnelStep(1);
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

        const rawRefParam = (params.get("ref") || "").trim().toUpperCase();
        const rawCodeParam = (params.get("code") || "").trim().toUpperCase();
        const friendRefParam = /^BROC-[A-Z0-9]{4,10}$/.test(rawRefParam)
          ? rawRefParam
          : /^BROC-[A-Z0-9]{4,10}$/.test(rawCodeParam)
            ? rawCodeParam
            : "";

        // Resolve creator promo code from ?code=, non-BROC ?ref=, or localStorage
        const urlCreatorCandidate =
          rawCodeParam && !rawCodeParam.startsWith("BROC-")
            ? rawCodeParam
            : rawRefParam && !rawRefParam.startsWith("BROC-")
              ? rawRefParam
              : "";
        let storedCreatorCandidate = "";
        try {
          const parsedCreator = JSON.parse(
            window.localStorage.getItem("cleancart_creator_v1") || "null"
          ) as { code?: string; name?: string } | null;
          if (parsedCreator?.code && !parsedCreator.code.toUpperCase().startsWith("BROC-")) {
            storedCreatorCandidate = parsedCreator.code.trim().toUpperCase();
          }
        } catch {
          /* ignore */
        }
        const creatorCandidate = urlCreatorCandidate || storedCreatorCandidate;
        let hasVerifiedCreator = false;
        if (creatorCandidate) {
          const creatorRes = await fetch(
            `/api/influencers?code=${encodeURIComponent(creatorCandidate)}`
          ).catch(() => null);
          const creatorData = (
            creatorRes ? await creatorRes.json().catch(() => null) : null
          ) as { ok?: boolean; creator?: { code: string; name: string } } | null;
          if (!cancelled && creatorData?.ok && creatorData.creator?.code) {
            hasVerifiedCreator = true;
            const verifiedCreator = {
              code: creatorData.creator.code,
              name: creatorData.creator.name || creatorData.creator.code,
            };
            setAppliedCreator(verifiedCreator);
            window.localStorage.setItem(
              "cleancart_creator_v1",
              JSON.stringify(verifiedCreator)
            );
            if (urlCreatorCandidate) {
              const clickSessionKey = `heybroc_creator_click_${verifiedCreator.code}`;
              if (!window.sessionStorage.getItem(clickSessionKey)) {
                window.sessionStorage.setItem(clickSessionKey, "1");
                void fetch("/api/influencers", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    action: "track",
                    code: verifiedCreator.code,
                    event: "click",
                  }),
                }).catch(() => {});
              }
              setToast({
                title: `🎉 Creator Code ${verifiedCreator.code} Applied`,
                body: `${verifiedCreator.name} unlocked your VIP 7-Day Free Pro Trial ($0 Today)!`,
              });
            }
          } else if (!cancelled && creatorRes && creatorRes.status === 404) {
            if (!urlCreatorCandidate && storedCreatorCandidate) {
              window.localStorage.removeItem("cleancart_creator_v1");
            }
          }
        }

        const storedRef = (window.localStorage.getItem("heybroc_referred_by") || "").trim().toUpperCase();
        const validStoredFriendRef = /^BROC-[A-Z0-9]{4,10}$/.test(storedRef) ? storedRef : "";
        const candidateFriendRef = friendRefParam || validStoredFriendRef;
        const refRes = await fetch("/api/referral", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(deviceSecret ? { "X-Device-Secret": deviceSecret } : {}),
          },
          body: JSON.stringify({
            action: candidateFriendRef ? "claim" : "status",
            deviceId,
            deviceSecret,
            referralCode: candidateFriendRef || undefined,
          }),
        }).catch(() => null);
        const refData = (refRes ? await refRes.json().catch(() => null) : null) as {
          ok?: boolean;
          message?: string;
          entitlement?: {
            referralCode?: string;
            referredByCode?: string | null;
            isProActive?: boolean;
            weeklySwapsUsedCount?: number;
            freeWeeklySwaps?: number;
            weeklySwapsLimit?: number;
            courtesyRefillAvailable?: boolean;
          };
        } | null;

        if (!cancelled && typeof refData?.entitlement?.weeklySwapsUsedCount === "number") {
          setSwapsUsedThisWeek(refData.entitlement.weeklySwapsUsedCount);
        }
        if (
          !cancelled &&
          typeof (refData?.entitlement?.freeWeeklySwaps ?? refData?.entitlement?.weeklySwapsLimit) === "number"
        ) {
          setWeeklySwapLimit(
            (refData?.entitlement?.freeWeeklySwaps ?? refData?.entitlement?.weeklySwapsLimit) || FREE_SCAN_LIMIT
          );
        }
        if (!cancelled && typeof refData?.entitlement?.courtesyRefillAvailable === "boolean") {
          setCourtesyRefillAvailable(refData.entitlement.courtesyRefillAvailable);
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

        if (!cancelled && friendRefParam) {
          if (refData?.ok) {
            window.localStorage.setItem("heybroc_referred_by", friendRefParam);
            setAppliedCreator({
              code: friendRefParam,
              name: "Friend Referral (+7 Days Free Pro)",
            });
            setToast({
              title: `🎁 Friend Invite Saved (${friendRefParam})`,
              body: refData.message || "Invite saved! Start a trial to unlock +7 Free Pro Days for both of you.",
            });
          } else {
            window.localStorage.removeItem("heybroc_referred_by");
            setToast({
              title: "Referral Code Not Applied",
              body: refData?.message || "Invalid or expired friend referral code.",
            });
          }
        } else if (!cancelled && !friendRefParam && validStoredFriendRef && !creatorCandidate) {
          const serverReferredBy = refData?.entitlement?.referredByCode;
          if (serverReferredBy && serverReferredBy === validStoredFriendRef) {
            setAppliedCreator({
              code: validStoredFriendRef,
              name: "Friend Referral (+7 Days Free Pro)",
            });
          } else if (refData?.entitlement && !serverReferredBy) {
            window.localStorage.removeItem("heybroc_referred_by");
          } else {
            setAppliedCreator({
              code: validStoredFriendRef,
              name: "Friend Referral (+7 Days Free Pro)",
            });
          }
        }

        const urlSessionId = (params.get("session_id") || "").trim();
        const urlDeviceId = (params.get("deviceId") || "").trim();
        const storedSessionId = (window.localStorage.getItem("heybroc_session_id") || "").trim();
        const candidateSessionId = urlSessionId || storedSessionId;
        const targetDeviceId = urlDeviceId || deviceId;
        if (!candidateSessionId) {
          if (!cancelled) {
            setIsPro(authenticatedPro || Boolean(refData?.entitlement?.isProActive));
          }
          return;
        }
        const res = await fetch(
          `/api/entitlement?session_id=${encodeURIComponent(candidateSessionId)}&deviceId=${encodeURIComponent(targetDeviceId)}`,
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
            const isPhoneCheckout = Boolean(urlDeviceId && urlDeviceId !== deviceId);
            const urlOto = (params.get("oto") || "").trim();
            const urlPlan: PlanId =
              params.get("plan") === "monthly" ? "monthly" : "annual";
            setToast({
              title: urlOto
                ? "🎉 One-Time VIP Upgrade Activated!"
                : isPhoneCheckout
                  ? "✓ Pro is active on your phone"
                  : "✓ HeyBroc Family Pro Unlocked",
              body: urlOto
                ? "Your Founding Family / VIP Annual upgrade is now active across all your devices."
                : isPhoneCheckout
                  ? "Pro is active on your phone! Return to the HeyBroc app to enjoy unlimited store overlays and 1-tap swaps."
                  : "Unlimited store overlays, 1-tap clean swaps & whole-cart health checks are now active.",
            });
            if (!isPhoneCheckout && !urlOto) {
              const otoSeenKey = `heybroc_oto_seen_${urlSessionId}`;
              if (!window.localStorage.getItem(otoSeenKey)) {
                window.localStorage.setItem(otoSeenKey, "1");
                setOtoInitialPlan(urlPlan);
                setOtoSessionId(urlSessionId);
                setOtoModalOpen(true);
              }
            }
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
  const [streakDays, setStreakDays] = useState<number>(1);
  const [scanHistory, setScanHistory] = useState<{ product: Product; timeLabel: string }[]>(() => [
    { product: presetToProduct(PRESETS[0]), timeLabel: "Just now" },
    { product: cleanToProduct("Butter/Dairy"), timeLabel: "12 mins ago" },
    { product: presetToProduct(PRESETS[1]), timeLabel: "2 hrs ago" },
    { product: cleanToProduct("Yogurt"), timeLabel: "Yesterday" },
    { product: presetToProduct(PRESETS[3]), timeLabel: "3 days ago" },
  ]);

  useEffect(() => {
    try {
      const todayEpoch = Math.floor(Date.now() / 86_400_000);
      const raw = window.localStorage.getItem("heybroc_streak_dates_v1");
      const parsed: number[] = raw ? JSON.parse(raw) : [];
      const daySet = new Set<number>(Array.isArray(parsed) ? parsed : []);
      daySet.add(todayEpoch);
      window.localStorage.setItem("heybroc_streak_dates_v1", JSON.stringify(Array.from(daySet)));
      let count = 0;
      let cursor = todayEpoch;
      while (daySet.has(cursor)) {
        count += 1;
        cursor -= 1;
      }
      setStreakDays(Math.max(1, count));
    } catch {
      // ignore storage errors
    }
  }, [scanHistory.length, favorites.length]);

  const toggleFavorite = useCallback((key: string) => {
    setFavorites((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);

  const screenRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const score = useMemo(
    () => gradeProduct(`${active.brand} ${active.title}`, active.ingredients, watch, active.nutrition, familyWatchlist),
    [active, watch, familyWatchlist],
  );
  const activeDietaryAlerts = useMemo(
    () =>
      evaluateDietaryAlerts(
        dietaryWatchlist,
        `${active.brand} ${active.title}`,
        active.ingredients,
        active.nutrition,
      ),
    [dietaryWatchlist, active],
  );
  const swapCandidates = useMemo(
    () =>
      resolveSwapCandidates({
        score: score.score,
        productTitle: `${active.brand} ${active.title}`,
        ingredients: active.ingredients,
        nutrition: active.nutrition,
        category: active.category,
        store,
        watchlist: watch,
        familyWatchlist,
        dietaryWatchlist,
        preferStoreBrand,
      }),
    [score.score, active, store, watch, familyWatchlist, dietaryWatchlist, preferStoreBrand],
  );
  const swap = useMemo(() => {
    if (swapCandidates.length > 0) {
      return swapCandidates[selectedSwapIdx % swapCandidates.length] ?? swapCandidates[0];
    }
    return resolveSwap({
      score: score.score,
      productTitle: `${active.brand} ${active.title}`,
      ingredients: active.ingredients,
      nutrition: active.nutrition,
      category: active.category,
      store,
      watchlist: watch,
      familyWatchlist,
      dietaryWatchlist,
      preferStoreBrand,
    });
  }, [swapCandidates, selectedSwapIdx, score.score, active, store, watch, familyWatchlist, dietaryWatchlist, preferStoreBrand]);
  const storeBrandCandidateIdx = useMemo(
    () => swapCandidates.findIndex((c) => c.isStoreBrand),
    [swapCandidates],
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
          nutrition: item.nutrition,
          category: item.category,
          store,
          watchlist: watch,
          familyWatchlist,
          dietaryWatchlist,
          preferStoreBrand,
        });
        return { item, s, sw };
      }),
    [cart, watch, store, familyWatchlist, dietaryWatchlist, preferStoreBrand],
  );
  const totalCartUnits = useMemo(
    () => cart.reduce((sum, item) => sum + clampQty(item.quantity), 0),
    [cart],
  );
  const scoredFoodCartRows = useMemo(
    () => cartScored.filter((r) => !r.item.isNonFood && Number.isFinite(r.s.score)),
    [cartScored],
  );
  const cartAvg: number | null = useMemo(() => {
    const totalFoodQty = scoredFoodCartRows.reduce((sum, r) => sum + clampQty(r.item.quantity), 0);
    if (totalFoodQty === 0) return null;
    const weightedSum = scoredFoodCartRows.reduce(
      (sum, r) => sum + (r.s.score ?? 0) * clampQty(r.item.quantity),
      0,
    );
    return Math.round(weightedSum / totalFoodQty);
  }, [scoredFoodCartRows]);
  const animatedCartAvg = useAnimatedNumber(cartAvg ?? 0, 750);
  const cartAvgTone =
    cartAvg === null ? "neutral" : animatedCartAvg >= 75 ? "green" : animatedCartAvg >= 50 ? "yellow" : "red";
  const dirty = scoredFoodCartRows.filter((r) => r.sw);

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
          preferStoreBrand,
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
    [watch, store, familyWatchlist, preferStoreBrand],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6500);
    return () => clearTimeout(t);
  }, [toast]);

  // Product scores & ingredient explanations are 100% free forever — viewing items never opens the paywall.
  const registerScan = useCallback(
    (skipRemoteAnalytics = false) => {
      setScanCount((prev) => prev + 1);
      setFreeTestCompleted(true);
      if (!skipRemoteAnalytics && typeof window !== "undefined") {
        const devId = window.localStorage.getItem("heybroc_device_id") || "anon-web";
        void fetch("/api/analytics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "track",
            event: "product_scanned",
            deviceId: devId,
            platform: "web",
            store,
          }),
        }).catch(() => {});
      }
    },
    [store]
  );

  const [storeExpanded, setStoreExpanded] = useState(false);
  const storeRailRef = useRef<HTMLDivElement>(null);

  const scrollStoreRail = useCallback((dir: -1 | 1) => {
    storeRailRef.current?.scrollBy({ left: dir * 210, behavior: "smooth" });
  }, []);

  const switchStore = useCallback(
    (s: Store) => {
      setStore(s);
      setHiddenForTrip(false);
      setSelectedSwapIdx(0);
      setActive((prev) =>
        prev.origin === "swap" && prev.category
          ? cleanToProduct(prev.category, prev.replacedItem, s, preferStoreBrand)
          : prev,
      );
    },
    [preferStoreBrand],
  );

  const showProduct = useCallback(
    (p: Product, countAsScan = true, openCardImmediately = false) => {
      setActive(p);
      setSelectedSwapIdx(0);
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
      // Live scans are already recorded server-side by `/api/scan`; only fire client `/api/analytics` on local presets
      if (countAsScan) registerScan(p.origin === "live");
    },
    [registerScan],
  );

  /** Inspects the Clean Swap item when the user clicks its photo or title inside Health Insights. */
  const inspectCleanSwap = useCallback(
    (cat: SwapCategory, replaced?: Product, chosenSwap?: SwapResult | null) => {
      if (!isPro && swapsUsedThisWeek >= weeklySwapLimit) {
        setPaywallOpen(true);
        return;
      }
      const target = replaced ?? (active.origin !== "swap" ? active : previousDirtyItem ?? undefined);
      const clean = chosenSwap
        ? swapResultToProduct(chosenSwap, target, store)
        : cleanToProduct(cat, target, store, preferStoreBrand);
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
    [active, previousDirtyItem, isPro, swapsUsedThisWeek, weeklySwapLimit, store, preferStoreBrand],
  );

  const triggerClimbFlash = useCallback(() => {
    setCartClimbFlash(true);
    const t = setTimeout(() => setCartClimbFlash(false), 2600);
    return () => clearTimeout(t);
  }, []);

  /** Commits a product (or a pending clean swap) to the active store's isolated cart. */
  const commitItemToCart = useCallback(
    (itemToAdd: Product) => {
      const normalizedItem: Product = { ...itemToAdd, quantity: clampQty(itemToAdd.quantity) };
      const cleanScore = gradeProduct(
        `${normalizedItem.brand} ${normalizedItem.title}`,
        normalizedItem.ingredients,
        watch,
        normalizedItem.nutrition,
        familyWatchlist,
      );
      const replacedDirty =
        normalizedItem.origin === "swap"
          ? normalizedItem.replacedItem ??
            (previousDirtyItem && previousDirtyItem.category === normalizedItem.category
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
          if (c.some((i) => i.key === normalizedItem.key)) return c;
          const idx = c.findIndex((i) => i.key === replacedDirty.key);
          if (idx === -1) return [...c, normalizedItem];
          const next = [...c];
          next[idx] = { ...normalizedItem, quantity: clampQty(c[idx].quantity) };
          return next;
        });
        setSwapHistory((prev) => [
          {
            fromTitle: `${replacedDirty.brand} ${replacedDirty.title}`,
            toTitle: `${normalizedItem.brand} ${normalizedItem.title}`,
            toScore: cleanScore.score,
            store,
            dodged: dirtyScore.flagged.map((f) => f.name),
          },
          ...prev,
        ]);
        triggerClimbFlash();
        setToast({
          title: `✓ Swapped to ${normalizedItem.brand} ${normalizedItem.title} (${cleanScore.score}/100)`,
          body: `Added clean swap to your ${STORE_META[store].label} cart · Cart Avg updated!`,
        });
        return;
      }

      setCart((c) => (c.some((i) => i.key === normalizedItem.key) ? c : [...c, normalizedItem]));
      setToast({
        title: "Added to cart",
        body: `${normalizedItem.brand} ${normalizedItem.title} (${cleanScore.score}/100)`,
      });
    },
    [watch, familyWatchlist, previousDirtyItem, store, triggerClimbFlash, setCart],
  );

  const removeCartItem = useCallback(
    (itemKey: string) => {
      setCart((prev) => prev.filter((i) => i.key !== itemKey));
    },
    [setCart],
  );

  const updateCartItemQty = useCallback(
    (itemKey: string, delta: number) => {
      setCart((prev) => {
        const next: Product[] = [];
        for (const item of prev) {
          if (item.key !== itemKey) {
            next.push(item);
            continue;
          }
          const updatedQty = clampQty(item.quantity) + delta;
          if (updatedQty <= 0) {
            continue;
          }
          next.push({ ...item, quantity: clampQty(updatedQty) });
        }
        return next;
      });
    },
    [setCart],
  );

  const clearStoreCart = useCallback(() => {
    setCart([]);
    setToast({
      title: `Cleared ${STORE_META[store].label} cart`,
      body: "Cart Avg reset to -- until new items are added.",
    });
  }, [setCart, store]);

  /* ---------------- Swap (single item or from auditor) ---------------- */
  const swapCartItem = useCallback(
    (targetItem: Product, explicitSwap?: SwapResult | null) => {
      const weeklyAllowance = weeklySwapLimit;
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
      const targetSwap =
        explicitSwap ??
        resolveSwap({
          score: itemScore.score,
          productTitle: `${targetItem.brand} ${targetItem.title}`,
          ingredients: targetItem.ingredients,
          category: targetItem.category,
          store,
          watchlist: watch,
          familyWatchlist,
          preferStoreBrand,
        });
      if (!targetSwap) return;
      setSwapsUsedThisWeek((n) => n + 1);
      if (typeof window !== "undefined") {
        const devId = window.localStorage.getItem("heybroc_device_id") || "anon-web";
        const devSecret = window.localStorage.getItem("heybroc_device_secret") || "";
        void fetch("/api/referral", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(devSecret ? { "X-Device-Secret": devSecret } : {}),
          },
          body: JSON.stringify({
            action: "record_swap",
            deviceId: devId,
            deviceSecret: devSecret || undefined,
            productKey: targetItem.key || `${targetItem.brand} ${targetItem.title}`,
          }),
        }).catch(() => {});
      }
      const clean = explicitSwap
        ? swapResultToProduct(targetSwap, targetItem, store)
        : cleanToProduct(targetSwap.category, targetItem, store, preferStoreBrand);
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
        isPaidLink: targetSwap.isPaidLink,
      });
    },
    [watch, familyWatchlist, store, preferStoreBrand, isPro, swapsUsedThisWeek, weeklySwapLimit],
  );

  const doSwap = useCallback(() => {
    if (active.origin === "swap") {
      commitItemToCart(active);
      return;
    }
    swapCartItem(previousDirtyItem ?? active, swap);
  }, [active, commitItemToCart, swapCartItem, previousDirtyItem, swap]);

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
        next[idx] = { ...orig, quantity: clampQty(c[idx].quantity) };
        return next;
      });
      setActive(orig);
      setPreviousDirtyItem(null);
      setToast({
        title: `↺ Reverted back to ${orig.brand} ${orig.title}`,
        body: `Restored original item in your ${STORE_META[store].label} cart.`,
      });
    },
    [active, getRevertTarget, store, setCart],
  );
  const activeRevertTarget = getRevertTarget(active);

  /* ---------------- Live search, Share Receiver & Label OCR Scanner ---------------- */
  const executeLiveLookup = useCallback(
    async (opts: {
      productTitle: string;
      rawIngredients?: string;
      barcode?: string;
      storeOverride?: Store;
      openCard?: boolean;
    }) => {
      const q = opts.productTitle.trim();
      const rawIng = (opts.rawIngredients || "").trim();
      if (!q && !rawIng && !opts.barcode) return;
      if (opts.storeOverride) {
        setStore(opts.storeOverride);
      }
      setLiveState("loading");
      setLiveError("");
      try {
        const deviceId =
          (typeof window !== "undefined" && window.localStorage.getItem("heybroc_device_id")) || undefined;
        const deviceSecret =
          (typeof window !== "undefined" && window.localStorage.getItem("heybroc_device_secret")) || undefined;
        const referredByCode =
          (typeof window !== "undefined" && window.localStorage.getItem("heybroc_referred_by")) || undefined;
        const targetStore = opts.storeOverride ?? store;
        const payload = {
          productTitle: q || opts.barcode || "",
          ...(rawIng ? { rawIngredients: rawIng } : {}),
          barcode: opts.barcode,
          store: targetStore,
          preferStoreBrand,
          watchlist: watch,
          familyWatchlist,
          dietaryWatchlist,
          deviceId,
          deviceSecret,
          referredByCode,
        };
        const res = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = (await res.json()) as ApiScan;
        setApiJson(data);
        if (!data.ok || !data.product) {
          if (data.reason === "NON_FOOD_PRODUCT") {
            setLiveState("idle");
            setToast({
              title: "Household / Non-Food Item Ignored",
              body: "HeyBroc only scores edible groceries and excludes non-food items from your Cart Avg.",
            });
            return;
          }
          setLiveState("error");
          setLiveError(data.error || "Lookup failed.");
          setIosText("");
          return;
        }
        if (q.includes("http") && data.store && (STORES as readonly string[]).includes(data.store)) {
          setStore(data.store);
        }
        const cat = detectCategory(`${q} ${data.product.title}`, data.product.ingredients);
        const liveScore =
          data.result?.score ??
          gradeProduct(data.product.title, data.product.ingredients, watch, data.product.nutrition, familyWatchlist).score;
        const fallbackImg = liveScore >= 75 ? CLEAN_ALTERNATIVES[cat]?.image : DIRTY_FALLBACK_IMAGES[cat];
        const p: Product = {
          key: `live-${data.product.barcode || q || data.product.title}-${rawIng ? "ocr" : "db"}`,
          title:
            data.product.title.replace(
              new RegExp(`^${(data.product.brand || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"),
              "",
            ) || data.product.title,
          brand: data.product.brand || (rawIng ? "Scanned Label" : "Open data"),
          description: data.product.description,
          image: data.product.imageUrl || fallbackImg,
          ingredients: data.product.ingredients,
          nutrition: data.product.nutrition,
          category: cat,
          origin: "live",
          lookup: data.lookup,
          quantity: 1,
        };
        showProduct(p, true, Boolean(opts.openCard) || adTestMode);
        setFreeTestCompleted(true);
        setLiveState("idle");
        fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, format: "ios_text", skipAnalytics: true }),
        })
          .then((r) => r.text())
          .then(setIosText)
          .catch(() => setIosText(""));
      } catch {
        setLiveState("error");
        setLiveError("Network error — is the server reachable?");
      }
    },
    [store, preferStoreBrand, watch, familyWatchlist, dietaryWatchlist, showProduct, adTestMode],
  );

  useEffect(() => {
    if (!pendingSharedQuery) return;
    const { q, storeOverride } = pendingSharedQuery;
    setPendingSharedQuery(null);
    setQuery(q);
    const digitsOnly = /^\d{8,14}$/.test(q.trim()) ? q.trim() : undefined;
    void executeLiveLookup({
      productTitle: q,
      barcode: digitsOnly,
      storeOverride,
      openCard: true,
    });
  }, [pendingSharedQuery, executeLiveLookup]);

  const runLive = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const q = query.trim();
      if (!q) return;
      const digitsOnly = /^\d{8,14}$/.test(q) ? q : undefined;
      await executeLiveLookup({ productTitle: q, barcode: digitsOnly });
    },
    [query, executeLiveLookup],
  );

  const stopCameraScanner = useCallback(() => {
    if (barcodeRafRef.current) {
      cancelAnimationFrame(barcodeRafRef.current);
      barcodeRafRef.current = 0;
    }
    if (barcodeStreamRef.current) {
      for (const track of barcodeStreamRef.current.getTracks()) {
        track.stop();
      }
      barcodeStreamRef.current = null;
    }
    if (barcodeVideoRef.current) {
      barcodeVideoRef.current.srcObject = null;
    }
    setBarcodeCameraActive(false);
  }, []);

  useEffect(() => {
    return () => {
      stopCameraScanner();
    };
  }, [stopCameraScanner]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const win = window as unknown as {
      __heybrocNativeBarcode?: (code: string) => void;
    };
    win.__heybrocNativeBarcode = (rawCode: string) => {
      const cleaned = String(rawCode || "").trim();
      if (!cleaned) return;
      stopCameraScanner();
      setBarcodeScannerOpen(false);
      setWatchlistFunnelOpen(false);
      setQuery(cleaned);
      const digits = cleaned.replace(/\D/g, "");
      void executeLiveLookup({
        productTitle: cleaned,
        barcode: /^\d{8,14}$/.test(digits) ? digits : undefined,
        openCard: true,
      });
    };
    return () => {
      delete win.__heybrocNativeBarcode;
    };
  }, [executeLiveLookup, stopCameraScanner]);

  const startCameraScanner = useCallback(async () => {
    setBarcodeStatus("");
    if (typeof window !== "undefined") {
      const iosBridge = (
        window as unknown as {
          webkit?: { messageHandlers?: { controller?: { postMessage?: (msg: string) => void } } };
        }
      ).webkit?.messageHandlers?.controller;
      if (typeof iosBridge?.postMessage === "function") {
        setBarcodeScannerOpen(false);
        iosBridge.postMessage("open-barcode-scanner");
        return;
      }
    }
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setBarcodeStatus("Camera access is unavailable in this browser — upload a barcode photo or type the UPC.");
      return;
    }
    const BarcodeDetectorCtor = (
      window as unknown as {
        BarcodeDetector?: new (opts?: { formats?: string[] }) => {
          detect: (source: ImageBitmapSource) => Promise<DetectedBarcodeLike[]>;
        };
      }
    ).BarcodeDetector;
    if (!BarcodeDetectorCtor) {
      setBarcodeStatus("Live BarcodeDetector unsupported on this browser — upload a photo or enter the 12-digit UPC above.");
      return;
    }
    try {
      stopCameraScanner();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      barcodeStreamRef.current = stream;
      setBarcodeCameraActive(true);
      setBarcodeStatus("Align the target item's barcode inside the center reticle…");
      const detector = new BarcodeDetectorCtor({
        formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"],
      });
      if (barcodeVideoRef.current) {
        barcodeVideoRef.current.srcObject = stream;
        await barcodeVideoRef.current.play().catch(() => {});
      }
      let cancelled = false;
      const scanFrame = async () => {
        if (cancelled || !barcodeStreamRef.current) return;
        const video = barcodeVideoRef.current;
        if (video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
          try {
            const barcodes = await detector.detect(video);
            const centeredCode = pickClosestBarcodeToCenter(barcodes, video.videoWidth, video.videoHeight);
            if (centeredCode) {
              cancelled = true;
              stopCameraScanner();
              setBarcodeScannerOpen(false);
              setQuery(centeredCode);
              void executeLiveLookup({ productTitle: centeredCode, barcode: centeredCode, openCard: true });
              return;
            }
          } catch {
            // Continue scanning next frame
          }
        }
        barcodeRafRef.current = requestAnimationFrame(() => {
          void scanFrame();
        });
      };
      barcodeRafRef.current = requestAnimationFrame(() => {
        void scanFrame();
      });
    } catch {
      stopCameraScanner();
      setBarcodeStatus("Camera permission was declined — upload a barcode photo or enter the UPC digits.");
    }
  }, [executeLiveLookup, stopCameraScanner]);

  const onBarcodePhotoUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      const BarcodeDetectorCtor = (
        window as unknown as {
          BarcodeDetector?: new (opts?: { formats?: string[] }) => {
            detect: (source: ImageBitmapSource) => Promise<DetectedBarcodeLike[]>;
          };
        }
      ).BarcodeDetector;
      if (!BarcodeDetectorCtor || typeof createImageBitmap !== "function") {
        setBarcodeStatus("Photo barcode decoding requires Chrome/Edge/Android BarcodeDetector — enter the UPC digits in search.");
        return;
      }
      try {
        setBarcodeStatus("Reading barcode closest to center…");
        const bitmap = await createImageBitmap(file);
        const detector = new BarcodeDetectorCtor({
          formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"],
        });
        const barcodes = await detector.detect(bitmap);
        const centeredCode = pickClosestBarcodeToCenter(barcodes, bitmap.width, bitmap.height);
        bitmap.close?.();
        if (!centeredCode) {
          setBarcodeStatus("No clear barcode found in photo — center the UPC label and try again.");
          return;
        }
        stopCameraScanner();
        setBarcodeScannerOpen(false);
        setBarcodeStatus("");
        setQuery(centeredCode);
        await executeLiveLookup({ productTitle: centeredCode, barcode: centeredCode, openCard: true });
      } catch {
        setBarcodeStatus("Could not decode barcode from image — try entering the UPC digits.");
      }
    },
    [executeLiveLookup, stopCameraScanner],
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
          preferStoreBrand,
          watchlist: watch,
          familyWatchlist,
          dietaryWatchlist,
          items: cart.map((i) => ({
            productTitle: `${i.brand} ${i.title}`,
            rawIngredients: i.ingredients,
            quantity: clampQty(i.quantity),
          })),
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
  }, [cart, store, preferStoreBrand, watch, familyWatchlist, dietaryWatchlist]);

  const convertAuditedItemToProduct = useCallback(
    (auditedItem: AuditedOrderItem, idx: number): Product | null => {
      if (!auditedItem.product) return null;
      const prod = auditedItem.product;
      const cat = detectCategory(prod.title, prod.ingredients);
      const itemScore = auditedItem.result?.score ?? 50;
      const fallbackImg = itemScore >= 75 ? CLEAN_ALTERNATIVES[cat]?.image : DIRTY_FALLBACK_IMAGES[cat];
      return {
        key: `order-${idx}-${prod.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 36)}`,
        title:
          prod.title.replace(
            new RegExp(`^${(prod.brand || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"),
            "",
          ) || prod.title,
        brand: prod.brand || "Order Item",
        image: prod.imageUrl || fallbackImg,
        ingredients: prod.ingredients,
        nutrition: prod.nutrition,
        category: cat,
        origin: "live",
        quantity: clampQty(auditedItem.quantity),
      };
    },
    [],
  );

  const handleLoadAuditedOrderIntoCart = useCallback(
    (auditedItems: AuditedOrderItem[], targetStore: Store) => {
      const nextProducts = auditedItems
        .map((it, idx) => convertAuditedItemToProduct(it, idx))
        .filter((p): p is Product => Boolean(p));
      if (nextProducts.length === 0) return;
      setStore(targetStore);
      setCartsByStore((prev) => ({ ...prev, [targetStore]: nextProducts }));
      setActive(nextProducts[0]);
      setViewMode("search");
      setAuditOpen(true);
      setToast({
        title: `✓ Loaded ${nextProducts.length} Staples Into ${STORE_META[targetStore].label} Cart`,
        body: "Tap Swap on any flagged item or Swap All to upgrade your weekly haul!",
      });
    },
    [convertAuditedItemToProduct],
  );

  const handleInspectAuditedItem = useCallback(
    (auditedItem: AuditedOrderItem, targetStore: Store) => {
      const prod = convertAuditedItemToProduct(auditedItem, 0);
      if (!prod) return;
      setStore(targetStore);
      showProduct(prod, false, true);
    },
    [convertAuditedItemToProduct, showProduct],
  );

  const swapAll = useCallback(() => {
    const n = dirty.length;
    if (n === 0) return;
    const weeklyAllowance = weeklySwapLimit;
    if (!isPro && swapsUsedThisWeek + n > weeklyAllowance) {
      setPaywallOpen(true);
      return;
    }
    setSwapsUsedThisWeek((prev) => prev + n);
    if (typeof window !== "undefined") {
      const devId = window.localStorage.getItem("heybroc_device_id") || "anon-web";
      const devSecret = window.localStorage.getItem("heybroc_device_secret") || "";
      for (const d of dirty) {
        void fetch("/api/referral", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(devSecret ? { "X-Device-Secret": devSecret } : {}),
          },
          body: JSON.stringify({
            action: "record_swap",
            deviceId: devId,
            deviceSecret: devSecret || undefined,
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
      return hit?.sw ? swapResultToProduct(hit.sw, item, store) : item;
    });
    setCart(nextCart);
    const foodNext = nextCart.filter((item) => !item.isNonFood);
    const foodNextUnits = foodNext.reduce((sum, item) => sum + clampQty(item.quantity), 0);
    const nextAvg =
      foodNextUnits > 0
        ? Math.round(
            foodNext.reduce(
              (sum, item) =>
                sum +
                (gradeProduct(`${item.brand} ${item.title}`, item.ingredients, watch, item.nutrition, familyWatchlist).score ?? 0) *
                  clampQty(item.quantity),
              0,
            ) / foodNextUnits,
          )
        : 0;
    const replaced = dirty.find((d) => d.item.key === active.key);
    if (replaced?.sw) setActive(swapResultToProduct(replaced.sw, replaced.item, store));
    triggerClimbFlash();
    setToast({
      title: `✓ Swapped ${n} item${n === 1 ? "" : "s"} → Cart Avg ${nextAvg}/100!`,
      body: `Upgraded ${n} item${n === 1 ? "" : "s"} to clean alternatives at ${STORE_META[store].label}.`,
    });
  }, [dirty, cart, setCart, watch, familyWatchlist, active.key, store, triggerClimbFlash, isPro, swapsUsedThisWeek, weeklySwapLimit]);

  const resetCartPresets = useCallback(() => {
    setCart(PRESETS.map(presetToProduct));
    setSwapHistory([]);
    setPreviousDirtyItem(null);
    setActive(presetToProduct(PRESETS[0]));
  }, [setCart]);

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

  const toggleWatch = (c: Category) => {
    const nextVal = !watch[c];
    setWatch((w) => {
      const next = { ...w, [c]: nextVal };
      if (typeof window !== "undefined") {
        window.localStorage.setItem("heybroc_watchlist_1x", JSON.stringify(next));
      }
      return next;
    });
    if (!nextVal) {
      setFamilyWatchlist((prev) => {
        const nextFw = prev.filter((cat) => cat !== c);
        if (typeof window !== "undefined") {
          window.localStorage.setItem("heybroc_family_watchlist", JSON.stringify(nextFw));
        }
        return nextFw;
      });
    }
  };

  const persistOnboardingSelections = useCallback(
    (selected: Category[], extras?: OnboardingSelections) => {
      setFamilyWatchlist(selected);
      if (extras?.dietaryWatchlist) setDietaryWatchlist(extras.dietaryWatchlist);
      if (extras?.stores !== undefined) {
        setPreferredStores(extras.stores);
      }
      if (extras?.store) switchStore(extras.store);
      setWatch((prev) => {
        const next = { ...prev };
        for (const c of ALL_CATEGORIES) {
          next[c] = selected.includes(c) ? true : prev[c];
        }
        if (typeof window !== "undefined") {
          window.localStorage.setItem("heybroc_watchlist_1x", JSON.stringify(next));
        }
        return next;
      });
      setOnboardingDoneState(true);
      if (typeof window !== "undefined") {
        window.localStorage.setItem("heybroc_family_watchlist", JSON.stringify(selected));
        if (extras?.dietaryWatchlist) {
          window.localStorage.setItem(
            "heybroc_dietary_watchlist",
            JSON.stringify(extras.dietaryWatchlist)
          );
        }
        if (extras?.stores !== undefined) {
          window.localStorage.setItem(
            "heybroc_preferred_stores",
            JSON.stringify(extras.stores)
          );
        }
        if (extras?.store) {
          window.localStorage.setItem("heybroc_preferred_store", extras.store);
        }
        if (extras?.householdProfile) {
          window.localStorage.setItem("heybroc_household_profile", extras.householdProfile);
        }
        if (extras?.primaryGoal) {
          window.localStorage.setItem("heybroc_primary_goal", extras.primaryGoal);
        }
        window.localStorage.setItem("heybroc_onboarding_done", "1");
      }
    },
    [switchStore]
  );

  const orderedStores = useMemo<Store[]>(() => {
    if (!preferredStores || preferredStores.length === 0) return [...STORES];
    const pinned = preferredStores.filter((s) => (STORES as readonly string[]).includes(s));
    const rest = STORES.filter((s) => !pinned.includes(s));
    return [...pinned, ...rest];
  }, [preferredStores]);

  const disabledCount = ALL_CATEGORIES.filter((c) => !watch[c]).length;

  const isCartBubbleMode = viewMode === "search" || cartClimbFlash;

  const aisleItems = useMemo<Product[]>(
    () => [
      ...PRESETS.map(presetToProduct),
      cleanToProduct("Yogurt", undefined, store),
      cleanToProduct("Crackers", undefined, store),
      cleanToProduct("Dressings", undefined, store),
    ],
    [store],
  );

  /* ---------------- Render ---------------- */
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-main">
          <div className="brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/broc-mascot.jpg" alt="Broc mascot" className="brand-mascot" />
            <div className="brand-copy">
              <div className="brand-title-row">
                <h1>HeyBroc</h1>
                <span className="brand-badge">Clean Scanner</span>
              </div>
              <p>Instant food grader &amp; 1-tap clean swaps</p>
            </div>
          </div>

          <div className="topbar-account" aria-label="Account and membership">
            <button
              id="open-paywall"
              type="button"
              className={`topbar-btn topbar-btn--pro ${isPro ? "is-pro" : ""}`}
              onClick={() => setPaywallOpen(true)}
            >
              {isPro ? "★ PRO" : "★ Pro"}
            </button>

            <button
              id="open-auth-modal"
              type="button"
              className={`topbar-btn topbar-btn--signin ${authUser ? "is-authed" : ""}`}
              onClick={() => setAuthOpen(true)}
            >
              {authUser ? `👤 ${authUser.displayName}` : "Sign in →"}
            </button>
          </div>
        </div>

        <nav
          className="topbar-subnav"
          aria-label="Quick tools and setup"
          style={adTestMode ? { display: "none" } : undefined}
        >
          <button
            id="topbar-watchlist-funnel"
            type="button"
            className="topbar-pill"
            onClick={() => {
              setManualFunnelOpen(true);
              setWatchlistFunnelStep(1);
              setWatchlistFunnelOpen(true);
            }}
            title="Personalize your family's 2x additive & allergy watchlist"
          >
            <span className="topbar-pill-dot" aria-hidden />
            🛡️ Avoid ({familyWatchlist.length}
            {dietaryWatchlist.length > 0 ? ` + ${dietaryWatchlist.length} Guard` : ""})
          </button>

          <button
            id="topbar-pesticide-toggle"
            type="button"
            role="switch"
            aria-checked={pesticideWatchEnabled}
            className="topbar-pill"
            onClick={() => togglePesticideWatch()}
            title="Toggle Herbicides & Pesticides (Glyphosate) Watch (USDA Dirty-Dozen produce + conventional oats/wheat/legumes)"
            style={
              pesticideWatchEnabled
                ? {
                    background: "#ecfdf5",
                    borderColor: "#16a34a",
                    color: "#065f46",
                    fontWeight: 800,
                  }
                : undefined
            }
          >
            🌱 Pesticides (Glyphosate): {pesticideWatchEnabled ? "ON" : "OFF"}
          </button>

          <button
            id="topbar-weekly-audit"
            type="button"
            className="topbar-pill"
            onClick={() => setWeeklyAuditOpen(true)}
            title="Paste or upload your weekly grocery order or receipt to rank worst culprits"
          >
            🧾 Audit Order
          </button>

          <button
            id="topbar-label-scanner"
            type="button"
            className="topbar-pill"
            onClick={() => setLabelScannerOpen(true)}
            title="Upload a screenshot or snap an Ingredients label"
          >
            📸 Label / Screenshot
          </button>

          {isIosApp ? (
            <>
              <button
                id="open-ios-live-shop"
                type="button"
                className="topbar-pill"
                style={{
                  background: "#ecfdf5",
                  borderColor: "#86efac",
                  color: "#065f46",
                  fontWeight: 800,
                }}
                onClick={() => {
                  const iosBridge = (
                    window as unknown as {
                      webkit?: { messageHandlers?: { controller?: { postMessage?: (msg: string) => void } } };
                    }
                  ).webkit?.messageHandlers?.controller;
                  if (typeof iosBridge?.postMessage === "function") {
                    iosBridge.postMessage("open-live-shop");
                  }
                }}
              >
                🛒 Live Shop Bubble
              </button>
              <button
                id="open-ios-safari-setup"
                type="button"
                className="topbar-pill"
                onClick={() => {
                  const iosBridge = (
                    window as unknown as {
                      webkit?: { messageHandlers?: { controller?: { postMessage?: (msg: string) => void } } };
                    }
                  ).webkit?.messageHandlers?.controller;
                  if (typeof iosBridge?.postMessage === "function") {
                    iosBridge.postMessage("open-safari-setup");
                  } else {
                    window.location.href = "/tools";
                  }
                }}
              >
                ⚡ iPhone Setup
              </button>
            </>
          ) : (
            <a
              id="download-android-apk"
              href="/heybroc.apk"
              download="heybroc.apk"
              className="topbar-pill"
            >
              📲 Android APK
            </a>
          )}

          <a
            id="open-free-tools"
            href="/tools"
            className="topbar-pill"
          >
            🧰 Tools &amp; iOS
          </a>
        </nav>
      </header>

      <main className={`layout ${adTestMode ? "layout--ad-test" : ""} ${adTestMode && !freeTestCompleted ? "is-ad-test-step1" : ""}`.trim()}>
        {/* ============ CONTROL PANEL ============ */}
        <section className="controls" aria-label="Store and product controls">
          {adTestMode && (
            <div
              id="ad-free-test-hero"
              className="card"
              style={{
                border: "2px solid #0f7a4a",
                background: "linear-gradient(180deg, #f0fdf4 0%, #ffffff 100%)",
                padding: 18,
              }}
            >
              <span className="eyebrow eyebrow--green">
                ⚡ FREE 3-SECOND GROCERY SCORE TEST (NO SIGN-UP)
              </span>
              <h2 style={{ fontSize: 21, lineHeight: 1.25, margin: "6px 0 6px", color: "#0b2418" }}>
                What&apos;s Really Hiding in Your Family&apos;s Groceries? Test Your First Item Free.
              </h2>
              <p className="meta" style={{ fontSize: 13.5, marginBottom: 12, color: "#334155" }}>
                Tap a popular item below or search any food to reveal its{" "}
                <b>instant 0–100 score</b>, flagged seed oils &amp; synthetic dyes, and{" "}
                <b>1-tap Clean Swap</b>.
              </p>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(185px, 1fr))",
                  gap: 8,
                  marginBottom: 12,
                }}
              >
                {PRESETS.filter((p) => p.id !== "butter").map((p) => {
                  const s = gradeProduct(
                    `${p.brand} ${p.title}`,
                    p.ingredients,
                    watch,
                    undefined,
                    familyWatchlist
                  );
                  const isSelected = freeTestCompleted && active.key === p.id;
                  return (
                    <button
                      key={`ad-test-${p.id}`}
                      id={`ad-test-${p.id}`}
                      type="button"
                      onClick={() => {
                        setFreeTestCompleted(true);
                        showProduct(presetToProduct(p), true, true);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        padding: "10px 12px",
                        borderRadius: 12,
                        border: isSelected
                          ? "2px solid #0f7a4a"
                          : "1px solid #cbd5e1",
                        background: isSelected ? "#ecfdf5" : "#fff",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>
                        Test {p.title} →
                      </span>
                      <ScoreChip score={s.score} color={s.color} />
                    </button>
                  );
                })}
              </div>

              <form className="search" onSubmit={runLive}>
                <input
                  id="ad-test-search-input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Or type any food, drink, or store URL (e.g. Doritos, Chobani, Coke)…"
                  aria-label="Test any grocery product free"
                />
                <button
                  id="ad-test-search-submit"
                  type="submit"
                  disabled={liveState === "loading" || !query.trim()}
                >
                  {liveState === "loading" ? (
                    <span className="spinner" aria-label="Scanning" />
                  ) : (
                    "Score Free →"
                  )}
                </button>
              </form>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                <button
                  type="button"
                  className="trip-pill"
                  onClick={() => setLabelScannerOpen(true)}
                  style={{ fontSize: 12, fontWeight: 700 }}
                >
                  📸 Scan Screenshot / Ingredient Label
                </button>
                <button
                  type="button"
                  className="trip-pill"
                  onClick={() => setWeeklyAuditOpen(true)}
                  style={{ fontSize: 12, fontWeight: 700 }}
                >
                  🧾 Audit Weekly Pickup Order
                </button>
              </div>
              {liveState === "error" && (
                <div style={{ marginTop: 6 }}>
                  <p className="error" style={{ marginBottom: 4 }}>{liveError}</p>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => setLabelScannerOpen(true)}
                  >
                    📸 Brand not listed yet? Snap or paste its Ingredients label →
                  </button>
                </div>
              )}

              {freeTestCompleted && (
                <div
                  id="ad-test-step2-cta"
                  style={{
                    marginTop: 14,
                    padding: "14px 16px",
                    borderRadius: 14,
                    background: "#0b2418",
                    color: "#ffffff",
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 800, color: "#6ee7b7", marginBottom: 4 }}>
                    ✓ STEP 1 COMPLETE — {active.brand} {active.title} Scored {score.score}/100 ({score.rating})
                  </div>
                  <div style={{ fontSize: 13.5, lineHeight: 1.4, marginBottom: 10, color: "#e2e8f0" }}>
                    {score.flagged.length > 0 ? (
                      <>
                        Flagged <b>{score.flagged.map((f) => f.name).join(", ")}</b>.{" "}
                        {swap ? (
                          isPro || swapsUsedThisWeek < weeklySwapLimit ? (
                            <>
                              Clean Swap ready: <b>{swap.title} ({swap.score}/100)</b>
                              {swap.isStoreBrand ? " 💚 Store-Brand Value Pick." : "."}
                            </>
                          ) : (
                            <>
                              Clean Swap ready: <b>{swap.score}/100 Clean Replacement Available</b>.
                            </>
                          )
                        ) : null}
                      </>
                    ) : (
                      <>Zero high-risk additives flagged — verified clean pick!</>
                    )}
                  </div>
                  <button
                    id="ad-test-unlock-pro-btn"
                    type="button"
                    className="swap-btn"
                    onClick={() => setPaywallOpen(true)}
                    style={{ width: "100%", fontWeight: 800 }}
                  >
                    Step 2: Unlock Unlimited 1-Tap Clean Swaps Across All 12 Stores ($0 Today) →
                  </button>
                </div>
              )}

              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 11.5, color: "#475569" }}>
                  Works inside Walmart, Target, Costco, Instacart, Kroger, ALDI &amp; 6 more
                </span>
                <button
                  id="ad-test-expand-full-btn"
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setAdTestMode(false);
                    setFreeTestCompleted(true);
                  }}
                >
                  Switch to Full 12-Store Simulator View →
                </button>
              </div>
            </div>
          )}

          <div
            className="card"
            style={adTestMode ? { display: "none" } : undefined}
          >
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
                {orderedStores.map((s) => (
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
                  {orderedStores.map((s) => (
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
            <div style={{ marginTop: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <button
                id="toggle-prefer-store-brand"
                type="button"
                onClick={() => togglePreferStoreBrand()}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: "pointer",
                  border: preferStoreBrand ? "1.5px solid #0f7a4a" : "1px solid #cbd5e1",
                  background: preferStoreBrand ? "#dcfce7" : "#f8fafc",
                  color: preferStoreBrand ? "#14532d" : "#334155",
                }}
              >
                {preferStoreBrand ? "💚 Store-Brand Budget Swaps First: ON" : "💚 Store-Brand Budget Swaps First"}
              </button>
              <small style={{ fontSize: 11.5, color: "#64748b" }}>
                Prioritizes Great Value Organic, Good &amp; Gather, Kirkland, 365 &amp; Simply Nature
              </small>
            </div>
          </div>

          <div
            className="card"
            style={adTestMode ? { display: "none" } : undefined}
          >
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
                🛒 Store Aisle ({cartAvg === null ? "--" : `${animatedCartAvg}/100`})
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

          <div
            className="card"
            style={adTestMode ? { display: "none" } : undefined}
          >
            <div className="card-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <h2>Search Any Grocery Item</h2>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  id="open-label-scanner"
                  type="button"
                  className="trip-pill"
                  onClick={() => setLabelScannerOpen(true)}
                >
                  📸 Label / Screenshot
                </button>
                <button
                  id="toggle-barcode-scanner"
                  type="button"
                  className="trip-pill"
                  onClick={() => {
                    if (barcodeScannerOpen) {
                      stopCameraScanner();
                      setBarcodeScannerOpen(false);
                      setBarcodeStatus("");
                    } else {
                      setBarcodeScannerOpen(true);
                      void startCameraScanner();
                    }
                  }}
                >
                  {barcodeScannerOpen ? "✕ Close Scanner" : "📷 Barcode"}
                </button>
              </div>
            </div>
            <form className="search" onSubmit={runLive}>
              <input
                id="live-search-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search item, UPC barcode, or paste a Walmart / Target / Amazon link…"
                aria-label="Search any grocery product"
              />
              <button id="live-search-submit" type="submit" disabled={liveState === "loading" || !query.trim()}>
                {liveState === "loading" ? <span className="spinner" aria-label="Scanning" /> : "Scan"}
              </button>
            </form>
            {barcodeScannerOpen && (
              <div
                style={{
                  marginTop: 10,
                  padding: 10,
                  borderRadius: 12,
                  background: "#0f172a",
                  color: "#f8fafc",
                  border: "1px solid #1e293b",
                }}
              >
                <div
                  style={{
                    position: "relative",
                    width: "100%",
                    height: 168,
                    borderRadius: 10,
                    overflow: "hidden",
                    background: "#020617",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <video
                    ref={barcodeVideoRef}
                    playsInline
                    muted
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      opacity: barcodeCameraActive ? 1 : 0.35,
                    }}
                  />
                  {/* Centered Reticle Overlay — disambiguates multi-barcode shelf frames */}
                  <div
                    aria-hidden
                    style={{
                      position: "absolute",
                      left: "50%",
                      top: "50%",
                      width: "66%",
                      height: "54%",
                      transform: "translate(-50%, -50%)",
                      border: "2px solid rgba(34, 197, 94, 0.92)",
                      borderRadius: 10,
                      boxShadow: "0 0 0 999px rgba(2, 6, 23, 0.48)",
                      pointerEvents: "none",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <div
                      style={{
                        width: "88%",
                        height: 2,
                        background: "rgba(34, 197, 94, 0.85)",
                        boxShadow: "0 0 8px rgba(34, 197, 94, 0.9)",
                      }}
                    />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
                  <button
                    type="button"
                    className="trip-pill"
                    style={{ background: "#1e293b", color: "#f8fafc", borderColor: "#334155" }}
                    onClick={() => {
                      if (barcodeCameraActive) stopCameraScanner();
                      else void startCameraScanner();
                    }}
                  >
                    {barcodeCameraActive ? "⏸ Pause Camera" : "▶ Start Camera"}
                  </button>
                  <label
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      padding: "5px 10px",
                      borderRadius: 999,
                      background: "#16a34a",
                      color: "#ffffff",
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    📤 Upload Barcode Photo
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={onBarcodePhotoUpload}
                      style={{ display: "none" }}
                    />
                  </label>
                </div>
                <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "#cbd5e1", lineHeight: 1.4 }}>
                  {barcodeStatus || "Center target UPC inside the green reticle — surrounding shelf barcodes are ignored."}
                </p>
              </div>
            )}
            {liveState === "error" && (
              <div style={{ marginTop: 6 }}>
                <p className="error" style={{ marginBottom: 4 }}>{liveError}</p>
                <button
                  id="error-fallback-label-scanner"
                  type="button"
                  className="link-btn"
                  onClick={() => setLabelScannerOpen(true)}
                >
                  📸 Brand or flavor not listed yet? Snap or paste its Ingredients label →
                </button>
              </div>
            )}
            {active.origin === "live" && active.lookup && (
              <p className="meta">
                {lookupSourceLabel(active.lookup)}
                {active.lookup.sourceUpdatedAt ? ` · updated ${active.lookup.sourceUpdatedAt}` : ""}
                {" · Verify physical label · "}
                <a
                  href={`mailto:support@heybroc.com?subject=${encodeURIComponent(`Label report: ${active.brand} ${active.title}`)}`}
                  style={{ color: "#15803d", fontWeight: 700, textDecoration: "underline" }}
                >
                  Report a mistake
                </a>
              </p>
            )}
          </div>

          <div
            className="card"
            style={adTestMode ? { display: "none" } : undefined}
          >
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

          <div
            className="tool-row"
            style={adTestMode ? { display: "none" } : undefined}
          >
            <button id="open-auditor" className="tool" onClick={openAudit}>
              <span className="tool-icon">🛒</span>
              <span>
                <b>Whole-Cart Health Check</b>
                <small>
                  {cartAvg === null
                    ? `${STORE_META[store].label} cart empty • Avg --`
                    : `${dirty.length} dirty of ${cart.length} • Avg ${animatedCartAvg}/100`}
                </small>
              </span>
            </button>
            <button id="open-weekly-audit" type="button" className="tool" onClick={() => setWeeklyAuditOpen(true)}>
              <span className="tool-icon">🧾</span>
              <span>
                <b>Audit Weekly Order / Receipt</b>
                <small>Paste Walmart, Instacart, Target or Amazon order text or screenshot</small>
              </span>
            </button>
          </div>

          <button
            id="open-watchlist"
            type="button"
            className={`tool ${panel === "watchlist" ? "is-on" : ""}`}
            onClick={() => setPanel((p) => (p === "watchlist" ? "none" : "watchlist"))}
            style={{ width: "100%", textAlign: "left", ...(adTestMode ? { display: "none" } : {}) }}
          >
            <span className="tool-icon">⚙︎</span>
            <span>
              <b>Bubble Style &amp; 9-Category Settings</b>
              <small>{disabledCount ? `${disabledCount} categor${disabledCount === 1 ? "y" : "ies"} ignored` : "Customize floating pill theme & strictness"}</small>
            </span>
          </button>

          <button
            id="open-watchlist-funnel"
            type="button"
            className="tool"
            onClick={() => {
              setManualFunnelOpen(true);
              setWatchlistFunnelStep(1);
              setWatchlistFunnelOpen(true);
            }}
            style={{ width: "100%", textAlign: "left", ...(adTestMode && !freeTestCompleted ? { display: "none" } : {}) }}
          >
            <span className="tool-icon">🛡️</span>
            <span>
              <b>
                Family Ingredient &amp; Allergy Watchlist ({familyWatchlist.length} Active · 2x Penalty
                {dietaryWatchlist.length > 0 ? ` · ${dietaryWatchlist.length} Allergy/Diet` : ""})
              </b>
              <small>
                Choose ingredients &amp; family allergens to avoid (Seed Oils, Red 40, HFCS, Nitrites, Sugar, Dairy, Gluten, Peanuts &amp; more) — HeyBroc doubles penalties, surfaces instant Allergy/Sugar badges, and finds clean swaps. Tap to customize →
              </small>
            </span>
          </button>

          <button
            id="pesticide-watch-switch-card"
            type="button"
            role="switch"
            aria-checked={pesticideWatchEnabled}
            className="tool"
            onClick={() => togglePesticideWatch()}
            style={{
              width: "100%",
              textAlign: "left",
              display: adTestMode && !freeTestCompleted ? "none" : "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              background: pesticideWatchEnabled ? "#f0fdf4" : undefined,
              borderColor: pesticideWatchEnabled ? "#22c55e" : undefined,
            }}
          >
            <span style={{ display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0 }}>
              <span className="tool-icon" aria-hidden>
                🌱
              </span>
              <span style={{ minWidth: 0 }}>
                <b>
                  Herbicides &amp; Pesticides (Glyphosate) Watch{" "}
                  <span
                    style={{
                      display: "inline-block",
                      marginLeft: 6,
                      padding: "2px 7px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 800,
                      background: pesticideWatchEnabled ? "#16a34a" : "#e2e8f0",
                      color: pesticideWatchEnabled ? "#ffffff" : "#475569",
                    }}
                  >
                    {pesticideWatchEnabled ? "ON" : "OFF"}
                  </span>
                </b>
                <small style={{ display: "block", marginTop: 2 }}>
                  Flags non-organic USDA Dirty-Dozen produce (strawberries, spinach, kale, apples, grapes, berries) &amp; conventional oats, wheat &amp; legumes where herbicides/desiccants (such as glyphosate) are permitted — and auto-recommends certified USDA Organic swaps.
                </small>
              </span>
            </span>
            <span
              aria-hidden
              style={{
                flexShrink: 0,
                width: 46,
                height: 26,
                borderRadius: 999,
                background: pesticideWatchEnabled ? "#16a34a" : "#cbd5e1",
                position: "relative",
                transition: "background 0.18s ease",
                boxShadow: "inset 0 1px 2px rgba(15, 23, 42, 0.14)",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 3,
                  left: pesticideWatchEnabled ? 23 : 3,
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  background: "#ffffff",
                  boxShadow: "0 1px 3px rgba(15, 23, 42, 0.25)",
                  transition: "left 0.18s ease",
                }}
              />
            </span>
          </button>

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
              <div className="card-head">
                <h2>Chemical Watchlist</h2>
                <button
                  className="link-btn"
                  onClick={() => {
                    setWatch(DEFAULT_WATCHLIST);
                    if (typeof window !== "undefined") {
                      window.localStorage.setItem(
                        "heybroc_watchlist_1x",
                        JSON.stringify(DEFAULT_WATCHLIST)
                      );
                    }
                  }}
                >
                  Reset
                </button>
              </div>
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
              <div className="store-header">
                <div className="store-row">
                  <span className="store-logo"><StoreBadge store={store} inHeader />{STORE_META[store].label}</span>
                  <button className="cart-btn" onClick={() => setCartOpen(true)} aria-label="Open cart">
                    <svg viewBox="0 0 24 24" width="20" height="20"><path d="M3 4h2l2.4 11.2a2 2 0 002 1.6h7.7a2 2 0 002-1.5L21 8H6.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><circle cx="10" cy="20" r="1.4" fill="currentColor" /><circle cx="17" cy="20" r="1.4" fill="currentColor" /></svg>
                    <span className="cart-count">{totalCartUnits}</span>
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
                              <span className="aisle-price">See price in store</span>
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
                    <div className="pdp-price">See live price in {STORE_META[store].label}</div>
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
                          ⚡ 1-Tap Clean Swap ({swap.score}/100){swap.isPaidLink ? " · paid link" : ""}
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
                  className={`pill pill--${pillTheme} tone-${
                    isCartBubbleMode
                      ? cartAvgTone
                      : activeDietaryAlerts.length > 0
                        ? "red"
                        : score.color
                  } ${overlay === "min" || pillSize === "compact" ? "is-min" : ""} ${isCartBubbleMode ? "is-cart-avg" : ""} ${cartClimbFlash ? "is-climbing" : ""}`}
                  style={{
                    top: `${pillY}%`,
                    transform: pillDragOffset
                      ? `translate(${pillDragOffset.x}px, -50%)`
                      : "translateY(-50%)",
                  }}
                  onPointerDown={onPillDown}
                  onPointerMove={onPillMove}
                  onPointerUp={onPillUp}
                  onPointerCancel={onPillUp}
                  onClick={(e) => {
                    e.stopPropagation();
                    triggerPillTap(isCartBubbleMode, overlay === "pill");
                  }}
                  role="button"
                  aria-label={
                    isCartBubbleMode
                      ? cartAvg === null
                        ? `${STORE_META[store].label} cart is empty. Tap to open Whole-Cart Health Check.`
                        : `Cart Average ${animatedCartAvg} of 100. Tap to open Whole-Cart Health Check.`
                      : activeDietaryAlerts.length > 0
                        ? `Dietary alert: ${activeDietaryAlerts.map((a) => a.label).join(", ")}. HeyBroc score ${score.score} of 100. Tap to inspect.`
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
                  <span
                    className="pill-dot"
                    style={
                      isCartBubbleMode && cartAvg === null
                        ? { background: "#64748b", boxShadow: "none" }
                        : undefined
                    }
                  />
                  {overlay === "min" || pillSize === "compact" ? (
                    <b>
                      {isCartBubbleMode
                        ? cartAvg === null
                          ? "🛒 --"
                          : `🛒 ${animatedCartAvg}/100`
                        : activeDietaryAlerts.length > 0
                          ? `⚠️ ${activeDietaryAlerts[0].shortBadge} · ${score.score}/100`
                          : `${score.score}/100`}
                    </b>
                  ) : isCartBubbleMode ? (
                    <>
                      <span>🛒 Cart Avg:</span>
                      <b>{cartAvg === null ? "--" : `${animatedCartAvg}/100`}</b>
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
                      {activeDietaryAlerts.length > 0 && (
                        <span
                          id="pill-dietary-alert"
                          style={{
                            background: "#dc2626",
                            color: "#ffffff",
                            fontSize: 10.5,
                            fontWeight: 800,
                            padding: "2px 7px",
                            borderRadius: 999,
                            letterSpacing: "0.02em",
                            whiteSpace: "nowrap",
                          }}
                        >
                          ⚠️ {activeDietaryAlerts.slice(0, 2).map((a) => a.shortBadge).join(" + ")}
                        </span>
                      )}
                      <b>{score.score}/100</b>
                      <span className="pill-sep">•</span>
                      <span>{activeDietaryAlerts.length > 0 ? "Inspect" : "Tap to Inspect"}</span>
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
                          <span className="eyebrow">HeyBroc · Cart Avg {cartAvg === null ? "--" : `${animatedCartAvg}/100`}</span>
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
                          <>
                            <button
                              id="drawer-topbar-share-btn"
                              type="button"
                              className="yuka-fav-btn"
                              onClick={() => setExposeCardOpen(true)}
                              aria-label="Share Before and After Score Card"
                              title="Share Before/After Score Card"
                            >
                              📤
                            </button>
                            <button
                              type="button"
                              className={`yuka-fav-btn ${favorites.includes(active.key) ? "is-fav" : ""}`}
                              onClick={() => toggleFavorite(active.key)}
                              aria-label="Toggle favorite"
                              title="Save to Favorites"
                            >
                              {favorites.includes(active.key) ? "★" : "☆"}
                            </button>
                          </>
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
                            <ProductArt product={active} className="yuka-hero-img" showAttribution />
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

                          {/* Personal Allergy & Dietary Watch Alert Box */}
                          {activeDietaryAlerts.length > 0 && (
                            <div
                              id="inspect-dietary-alert-card"
                              style={{
                                background: "#fef2f2",
                                border: "1.5px solid #fca5a5",
                                borderRadius: 14,
                                padding: "11px 14px",
                                marginBottom: 12,
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: 8,
                                  marginBottom: 4,
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: 10.5,
                                    fontWeight: 800,
                                    letterSpacing: "0.06em",
                                    color: "#991b1b",
                                    textTransform: "uppercase",
                                  }}
                                >
                                  ⚠️ Personal Allergy &amp; Diet Alert ({activeDietaryAlerts.length})
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setManualFunnelOpen(true);
                                    setWatchlistFunnelStep(4);
                                    setWatchlistFunnelOpen(true);
                                  }}
                                  style={{
                                    background: "none",
                                    border: "none",
                                    padding: 0,
                                    fontSize: 11,
                                    fontWeight: 700,
                                    color: "#b91c1c",
                                    textDecoration: "underline",
                                    cursor: "pointer",
                                  }}
                                >
                                  Edit Guard
                                </button>
                              </div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                {activeDietaryAlerts.map((alert) => (
                                  <div
                                    key={alert.id}
                                    style={{ fontSize: 12.5, color: "#7f1d1d", lineHeight: 1.4 }}
                                  >
                                    <b>{alert.label}:</b> {alert.reason}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* 1-Tap Clean Swap Banner right at top when dirty */}
                          {swap ? (
                            !isPro && swapsUsedThisWeek >= weeklySwapLimit ? (
                              <div className="swap">
                                <button
                                  id="inspect-clean-swap"
                                  type="button"
                                  className="swap-info swap-info--btn"
                                  onClick={() => setPaywallOpen(true)}
                                >
                                  <div className="swap-info-copy">
                                    <span className="eyebrow eyebrow--green">
                                      🔒 Clean Swap Locked · {swap.score}/100 {swap.score >= 75 ? "Excellent" : swap.score >= 50 ? "Good" : "Mediocre"}
                                    </span>
                                    <b>{swap.score}/100 Clean Replacement Available</b>
                                    <span className="swap-score">All {weeklySwapLimit} free Clean Swaps used · <em>Unlock Unlimited with Pro →</em></span>
                                  </div>
                                </button>
                                <button id="swap-item" className="swap-btn" onClick={() => setPaywallOpen(true)}>
                                  ⚡ Unlock Pro
                                </button>
                              </div>
                            ) : (
                              <div className="swap">
                                <button
                                  id="inspect-clean-swap"
                                  type="button"
                                  className="swap-info swap-info--btn"
                                  onClick={() => inspectCleanSwap(swap.category, active, swap)}
                                >
                                  <ProductArt product={swapResultToProduct(swap, active, store)} className="swap-art" />
                                  <div className="swap-info-copy">
                                    <span className="eyebrow eyebrow--green">
                                      ✓ Verified Clean Swap · {STORE_META[store].label}{swap.isPaidLink ? " · paid link" : ""}
                                    </span>
                                    {swap.isStoreBrand && (
                                      <span
                                        id="swap-store-brand-badge"
                                        style={{
                                          display: "inline-block",
                                          alignSelf: "flex-start",
                                          background: "#15803d",
                                          color: "#ffffff",
                                          fontSize: 10.5,
                                          fontWeight: 800,
                                          padding: "2px 8px",
                                          borderRadius: 999,
                                          marginBottom: 2,
                                        }}
                                      >
                                        💚 Store-Brand Value Pick
                                      </span>
                                    )}
                                    <b>{swap.title}</b>
                                    <span className="swap-score">
                                      {swap.score}/100 {swap.score >= 75 ? "Excellent" : swap.score >= 50 ? "Good" : "Mediocre"} · <em>Tap to inspect →</em>
                                    </span>
                                  </div>
                                </button>
                                <button id="swap-item" className="swap-btn" onClick={doSwap}>
                                  Swap Item{swap.isPaidLink ? " · paid link" : ""}
                                </button>
                                {!swap.isStoreBrand && storeBrandCandidateIdx >= 0 && (
                                  <button
                                    id="switch-to-store-brand-swap"
                                    type="button"
                                    className="trip-pill"
                                    onClick={() => setSelectedSwapIdx(storeBrandCandidateIdx)}
                                    style={{
                                      width: "100%",
                                      justifyContent: "center",
                                      background: "#ecfdf5",
                                      borderColor: "#86efac",
                                      color: "#14532d",
                                      fontWeight: 800,
                                      fontSize: 12,
                                    }}
                                  >
                                    💚 Prefer store brand? Switch to {swapCandidates[storeBrandCandidateIdx].title} ({swapCandidates[storeBrandCandidateIdx].score}/100)
                                  </button>
                                )}
                                {swapCandidates.length > 1 && (
                                  <button
                                    type="button"
                                    className="link-btn center"
                                    onClick={() => setSelectedSwapIdx((i) => (i + 1) % swapCandidates.length)}
                                  >
                                    ⇄ Option {(selectedSwapIdx % swapCandidates.length) + 1} of {swapCandidates.length} · Tap for next clean alternative (if out of stock)
                                  </button>
                                )}
                              </div>
                            )
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

                          <button
                            id="open-expose-card"
                            type="button"
                            className="trip-pill"
                            onClick={() => setExposeCardOpen(true)}
                            style={{
                              width: "100%",
                              justifyContent: "center",
                              padding: "9px 14px",
                              marginBottom: 12,
                              fontWeight: 800,
                              fontSize: 12.5,
                              background: "#f0fdf4",
                              borderColor: "#86efac",
                              color: "#14532d",
                            }}
                          >
                            📤 Share Before/After Score Card (iMessage / IG / TikTok)
                          </button>

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
                                🧪 Clean-Label Additives: {score.yukaBreakdown.additiveScore}/30 &nbsp;·&nbsp; 🌱 Organic Bonus: {score.yukaBreakdown.organicScore}/10
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
                                        score.yukaBreakdown.glucoseImpact === "High Sugar / Carb"
                                          ? "#dc2626"
                                          : score.yukaBreakdown.glucoseImpact === "Moderate Sugar / Carb"
                                            ? "#ea580c"
                                            : "#16a34a",
                                    }}
                                  >
                                    🩸 Sugar &amp; Carb Note: {score.yukaBreakdown.glucoseImpact} &nbsp;·&nbsp; 🔥 {score.yukaBreakdown.calorieNote}
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
                            <small style={{ display: "block", marginTop: 6, fontSize: 10.5, color: "#475569", fontWeight: 700, lineHeight: 1.4 }}>
                              {lookupSourceLabel(active.lookup)}
                              {active.lookup?.sourceUpdatedAt ? ` · updated ${active.lookup.sourceUpdatedAt}` : ""}
                              {" · "}
                              <a
                                href={`mailto:support@heybroc.com?subject=${encodeURIComponent(`Label report: ${active.brand} ${active.title}`)}`}
                                style={{ color: "#15803d", textDecoration: "underline" }}
                              >
                                Report a mistake
                              </a>
                            </small>
                            <small style={{ display: "block", marginTop: 4, fontSize: 10.5, color: "#64748b", lineHeight: 1.4 }}>
                              Informational opinion only — not medical or regulatory advice. Most flagged ingredients are permitted or GRAS under U.S. FDA rules; scores reflect HeyBroc&apos;s independent clean-label rubric. Always verify the physical product label.
                            </small>
                          </div>
                        </>
                      )}

                      {/* ==================== TAB 2: YUKA HISTORY & FAVORITES ==================== */}
                      {yukaTab === "history" && (
                        <div className="yuka-history">
                          {!favOnly && (
                            <div
                              style={{
                                margin: "8px 12px 12px",
                                padding: "14px 16px",
                                borderRadius: "18px",
                                background: "#fafafa",
                                border: "1px solid #e5e7eb",
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: "10px",
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src="/broc-mascot.jpg"
                                  alt="HeyBroc"
                                  style={{ width: 34, height: 34, borderRadius: "50%", objectFit: "cover" }}
                                />
                                <div>
                                  <div style={{ fontSize: 15, fontWeight: 800, color: "#111814" }}>
                                    Clean Cart Streak: Day {streakDays}
                                  </div>
                                  <div style={{ fontSize: 11.5, color: "#6b7280" }}>
                                    Scan groceries or tap Clean Swaps daily to grow your streak
                                  </div>
                                </div>
                              </div>

                              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                {Array.from({ length: 5 }, (_, idx) => {
                                  const startNum = streakDays <= 5 ? 1 : streakDays - 4;
                                  const dayNum = startNum + idx;
                                  const completed = dayNum <= streakDays;
                                  return (
                                    <span
                                      key={dayNum}
                                      style={{
                                        width: 34,
                                        height: 34,
                                        borderRadius: "50%",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        fontSize: 13,
                                        fontWeight: 800,
                                        background: completed ? "#3E9B4F" : "#E8F5EC",
                                        color: completed ? "#ffffff" : "#166534",
                                        border: completed ? "none" : "1px solid #BBF7D0",
                                      }}
                                    >
                                      {dayNum}
                                    </span>
                                  );
                                })}
                              </div>

                              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "6px" }}>
                                {(["Seed-Oil Free", "No Red 40", "Allergy Guard"] as const).map((badge) => (
                                  <button
                                    key={badge}
                                    type="button"
                                    onClick={() => {
                                      setManualFunnelOpen(true);
                                      setWatchlistFunnelStep(badge === "Allergy Guard" ? 4 : 2);
                                      setWatchlistFunnelOpen(true);
                                    }}
                                    style={{
                                      padding: "4px 10px",
                                      borderRadius: 999,
                                      fontSize: 11,
                                      fontWeight: 700,
                                      background: "#ffffff",
                                      color: "#1f2937",
                                      border: "1px solid #d1d5db",
                                      cursor: "pointer",
                                    }}
                                  >
                                    {badge}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
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
                              const cleanProd = cleanToProduct(p.category, dirtyProd, store);
                              const cleanScore = gradeProduct(
                                `${cleanProd.brand} ${cleanProd.title}`,
                                cleanProd.ingredients,
                                watch,
                                cleanProd.nutrition,
                                familyWatchlist,
                              );
                              const recSwap = resolveSwap({
                                score: dirtyScore.score,
                                productTitle: `${p.brand} ${p.title}`,
                                ingredients: p.ingredients,
                                category: p.category,
                                store,
                                watchlist: watch,
                                familyWatchlist,
                              });
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
                                      ⚡ 1-Tap Swap{recSwap?.isPaidLink ? " · paid link" : ""}
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
                            <p>Packaged food and beverage products scored on our 3-pillar rubric (60% Nutritional Quality, 30% Clean-Label Additives, 10% Organic Bonus) via Open Food Facts &amp; USDA FoodData Central.</p>
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
                          <span className="eyebrow">
                            {auditOpen ? `HeyBroc · ${STORE_META[store].label} Cart Health Check` : STORE_META[store].label}
                          </span>
                          <h3>{auditOpen ? "Cart Health Check" : `Your ${STORE_META[store].label} cart`}</h3>
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {cart.length > 0 && (
                          <button
                            type="button"
                            className="trip-pill"
                            onClick={clearStoreCart}
                            title={`Clear ${STORE_META[store].label} cart`}
                          >
                            Clear
                          </button>
                        )}
                        <button className="close" onClick={() => { setCartOpen(false); setAuditOpen(false); }} aria-label="Close">×</button>
                      </div>
                    </div>
                    {auditOpen && (
                      <div className="audit-summary">
                        <Gauge
                          score={cartAvg === null ? null : animatedCartAvg}
                          rating={cartAvg === null ? "Empty" : "Cart avg"}
                          color={cartAvgTone}
                          size={78}
                        />
                        <p>
                          {auditBusy
                            ? "Checking your cart ingredients…"
                            : cartAvg === null
                              ? `Your ${STORE_META[store].label} cart is empty (Cart Avg: --). Add items to see your live quantity-weighted Cart Avg.`
                              : dirty.length
                                ? <><b>{dirty.length}</b> of {cart.length} items score under 75. Tap any item to inspect, or tap <b>Swap</b> to watch your Cart Avg climb!</>
                                : "Every item in your cart scores 75+. Clean Cart Approved! 🎉"}
                        </p>
                      </div>
                    )}
                    {cartScored.length === 0 ? (
                      <div
                        style={{
                          padding: "20px 16px",
                          margin: "8px 0 12px",
                          borderRadius: 12,
                          background: "#f8fafc",
                          border: "1px dashed #cbd5e1",
                          textAlign: "center",
                          color: "#475569",
                          fontSize: 13,
                        }}
                      >
                        <b style={{ display: "block", color: "#0f172a", marginBottom: 4 }}>
                          {STORE_META[store].label} cart is empty · Cart Avg: --
                        </b>
                        <span>Each store keeps its own separate cart. Add items from the store page or load sample groceries.</span>
                        <div style={{ marginTop: 10 }}>
                          <button type="button" className="trip-pill" onClick={resetCartPresets}>
                            + Load sample groceries
                          </button>
                        </div>
                      </div>
                    ) : (
                      <ul className="cart-list">
                        {cartScored.map(({ item, s, sw }) => {
                          const qty = clampQty(item.quantity);
                          return (
                            <li key={item.key} className="cart-row" style={{ gap: 6, flexWrap: "wrap" }}>
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
                                  <small>
                                    {item.brand}
                                    {qty > 1 ? ` · Qty ${qty}` : ""}
                                    {sw
                                      ? !isPro && swapsUsedThisWeek >= weeklySwapLimit
                                        ? ` · 🔒 ${sw.score}/100 Clean Swap available`
                                        : ` · Tap to inspect or swap → ${sw.brand}`
                                      : " · Tap to inspect"}
                                  </small>
                                </span>
                                <ScoreChip score={s.score} color={s.color} />
                              </button>
                              <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                                <div
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    border: "1px solid #e2e8f0",
                                    borderRadius: 999,
                                    background: "#f8fafc",
                                    overflow: "hidden",
                                  }}
                                >
                                  <button
                                    type="button"
                                    aria-label={qty <= 1 ? `Remove ${item.title}` : `Decrease ${item.title} quantity`}
                                    onClick={() => updateCartItemQty(item.key, -1)}
                                    style={{
                                      border: "none",
                                      background: "transparent",
                                      padding: "3px 7px",
                                      fontSize: 13,
                                      fontWeight: 700,
                                      cursor: "pointer",
                                      color: "#334155",
                                    }}
                                  >
                                    −
                                  </button>
                                  <span style={{ fontSize: 11.5, fontWeight: 700, minWidth: 16, textAlign: "center", color: "#0f172a" }}>
                                    {qty}
                                  </span>
                                  <button
                                    type="button"
                                    aria-label={`Increase ${item.title} quantity`}
                                    onClick={() => updateCartItemQty(item.key, 1)}
                                    style={{
                                      border: "none",
                                      background: "transparent",
                                      padding: "3px 7px",
                                      fontSize: 13,
                                      fontWeight: 700,
                                      cursor: "pointer",
                                      color: "#334155",
                                    }}
                                  >
                                    +
                                  </button>
                                </div>
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
                                <button
                                  type="button"
                                  aria-label={`Remove ${item.title} from cart`}
                                  title="Remove item"
                                  onClick={() => removeCartItem(item.key)}
                                  style={{
                                    border: "1px solid #e2e8f0",
                                    background: "#ffffff",
                                    color: "#64748b",
                                    borderRadius: 999,
                                    width: 24,
                                    height: 24,
                                    fontSize: 12,
                                    fontWeight: 700,
                                    cursor: "pointer",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                  }}
                                >
                                  ✕
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
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
                  {toast.href && (
                    <a href={toast.href} target="_blank" rel="noreferrer">
                      View on {STORE_META[store].label}{(toast.isPaidLink ?? swap?.isPaidLink) ? " · paid link" : ""} ↗
                    </a>
                  )}
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
              <div className="compare-cell" role="columnheader">Coupon Extensions</div>
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
                <b>Floats on Walmart, Target, Kroger, Shipt, DoorDash, Instacart, ALDI &amp; more</b>
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
        </div>
      </section>

      {/* Clean, Compact Top-Level Footer + Collapsible FAQ & Legal Notice */}
      <footer
        className="site-footer-wrap"
        style={{
          maxWidth: 1184,
          margin: "0 auto 40px",
          padding: "0 28px",
        }}
      >
        <div
          style={{
            padding: "16px 18px",
            background: "#ffffff",
            border: "1px solid rgba(21, 32, 27, 0.09)",
            borderRadius: 18,
            boxShadow: "0 1px 2px rgba(21, 32, 27, 0.04)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              fontSize: 12.5,
              color: "#475569",
            }}
          >
            <span style={{ fontWeight: 800, color: "#0f172a" }}>
              🥦 HeyBroc Clean Scanner
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <a href="/tools" style={{ color: "#0f7a4a", fontWeight: 700, textDecoration: "none" }}>Free Tools</a>
              <a href="/swaps" style={{ color: "#0f7a4a", fontWeight: 700, textDecoration: "none" }}>Clean Swaps</a>
              <a href="/creators" style={{ color: "#0f7a4a", fontWeight: 700, textDecoration: "none" }}>Creators (35%)</a>
              <a href="/terms" style={{ color: "#475569", fontWeight: 600, textDecoration: "none" }}>Terms</a>
              <a href="/privacy" style={{ color: "#475569", fontWeight: 600, textDecoration: "none" }}>Privacy</a>
              <button
                type="button"
                onClick={async () => {
                  const devId = window.localStorage.getItem("heybroc_device_id") || deviceIdState;
                  const devSecret = window.localStorage.getItem("heybroc_device_secret") || undefined;
                  const sId = window.localStorage.getItem("heybroc_session_id") || undefined;
                  const tok = window.localStorage.getItem("heybroc_auth_token") || undefined;
                  try {
                    const res = await fetch("/api/billing/portal", {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
                        ...(devSecret ? { "X-Device-Secret": devSecret } : {}),
                      },
                      body: JSON.stringify({
                        deviceId: devId,
                        deviceSecret: devSecret,
                        sessionId: sId,
                        email: authUser?.email,
                      }),
                    });
                    const data = (await res.json().catch(() => null)) as { ok?: boolean; url?: string; error?: string } | null;
                    if (res.ok && data?.ok && data.url) {
                      window.location.href = data.url;
                    } else {
                      setAuthOpen(true);
                    }
                  } catch {
                    setAuthOpen(true);
                  }
                }}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: "#475569",
                  fontWeight: 600,
                  fontSize: 12.5,
                  cursor: "pointer",
                }}
              >
                Manage / Cancel subscription
              </button>
            </div>
          </div>

          <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
            <details style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: "10px 14px" }}>
              <summary style={{ fontWeight: 700, fontSize: 12.5, color: "#334155", cursor: "pointer" }}>
                How HeyBroc Grades Groceries &amp; Scoring FAQ
              </summary>
              <div style={{ marginTop: 10, display: "grid", gap: 8, fontSize: 12.5, lineHeight: 1.5, color: "#475569" }}>
                <div>
                  <strong style={{ color: "#0f172a" }}>How does HeyBroc calculate its 0 to 100 food and ingredient score?</strong>
                  <p style={{ marginTop: 2 }}>
                    HeyBroc grades products on a deterministic 0–100 scale across three pillars: <b>Nutritional Quality (60%)</b> based on sugar, sodium, saturated fat, calories, fiber, and protein; <b>Clean-Label Additives (30%)</b> penalizing synthetic dyes, refined seed oils, chemical preservatives, nitrites, and emulsifiers; and a <b>Certified Organic Bonus (10%)</b>. Any high-risk additive automatically caps a product&apos;s maximum score at 49/100.
                  </p>
                </div>
                <div>
                  <strong style={{ color: "#0f172a" }}>Which grocery stores work with the HeyBroc floating bubble?</strong>
                  <p style={{ marginTop: 2 }}>
                    HeyBroc&apos;s Live Store Bubble works automatically across 12 major grocery stores and delivery apps: <b>Walmart, Instacart, Target, Kroger, ALDI, Costco, Sam&apos;s Club, BJ&apos;s Wholesale, Amazon Fresh, DoorDash, Uber Eats, and Shipt</b>—without needing to scan physical barcodes.
                  </p>
                </div>
                <div>
                  <strong style={{ color: "#0f172a" }}>What ingredients and additives does HeyBroc flag?</strong>
                  <p style={{ marginTop: 2 }}>
                    HeyBroc flags refined seed oils (soybean, canola, corn, cottonseed, sunflower, safflower), artificial food dyes (Red 40, Yellow 5, Yellow 6, Blue 1, Red 3, Titanium Dioxide), preservatives and nitrates (Sodium Nitrite, BHA, BHT, Potassium Bromate, TBHQ, Sodium Benzoate), sweeteners (High Fructose Corn Syrup, Sucralose, Aspartame, Ace-K), and synthetic emulsifiers or gums (Carrageenan, Polysorbate 80).
                  </p>
                </div>
                <div>
                  <strong style={{ color: "#0f172a" }}>Does HeyBroc accept payments from brands to change product scores?</strong>
                  <p style={{ marginTop: 2 }}>
                    No. HeyBroc is 100% independent. Brands cannot pay to alter a score or buy placement in Top Picks. Every product score and 1-for-1 Clean Swap is computed deterministically from its ingredient list and nutrition facts.
                  </p>
                </div>
              </div>
            </details>

            <details style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: "10px 14px" }}>
              <summary style={{ fontWeight: 700, fontSize: 12.5, color: "#64748b", cursor: "pointer" }}>
                Independent Opinion, Label Verification, Pricing &amp; Non-Affiliation Notice
              </summary>
              <div style={{ marginTop: 8, fontSize: 11.5, lineHeight: 1.55, color: "#64748b" }}>
                <p>
                  HeyBroc 0–100 scores and ratings represent HeyBroc&apos;s subjective clean-label opinion for informational grocery comparison only and do not constitute medical, nutritional, or regulatory safety advice. Most flagged additives, dyes, and oils are permitted for food use or recognized as GRAS by the U.S. FDA. Ingredient lists shown in the simulator and catalog are representative estimates from public databases (Open Food Facts, USDA FoodData Central); manufacturers reformulate products frequently and retail prices vary by store and location—always verify the physical product package and live store checkout price before purchasing. When you tap a Clean Swap retail link marked &ldquo;paid link&rdquo;, HeyBroc may earn an affiliate commission at no extra cost to you. HeyBroc is an independent software application and is not affiliated with, endorsed by, or sponsored by Walmart, Target, Instacart, Kroger, ALDI, Costco, Sam&apos;s Club, BJ&apos;s Wholesale Club, Amazon, Whole Foods Market, DoorDash, Uber Eats, Shipt, or any food or beverage manufacturer. All retailer and brand names are trademarks of their respective owners and are used strictly for nominative identification.
                </p>
                <div style={{ marginTop: 8, display: "flex", gap: 12, fontSize: 11.5 }}>
                  <a href="/llms.txt" style={{ color: "#0f7a4a", fontWeight: 600 }}>AI &amp; LLM Index (llms.txt)</a>
                  <a href="/sitemap.xml" style={{ color: "#0f7a4a", fontWeight: 600 }}>Sitemap</a>
                </div>
              </div>
            </details>
          </div>
        </div>
      </footer>

      {/* ============ PHASE 6 MODALS ============ */}
      <WatchlistMiniFunnel
        open={watchlistFunnelOpen}
        initialStep={watchlistFunnelStep}
        isReturningUser={onboardingDoneState || manualFunnelOpen}
        initialSelected={familyWatchlist}
        initialStore={store}
        initialStores={preferredStores}
        initialDietary={dietaryWatchlist}
        appliedCreator={appliedCreator}
        onClose={() => {
          setWatchlistFunnelOpen(false);
        }}
        onDismissFirstTime={(selected, extras) => {
          persistOnboardingSelections(selected, extras);
          setWatchlistFunnelOpen(false);
        }}
        onApplyAndGuest={(selected, extras?: OnboardingSelections) => {
          persistOnboardingSelections(selected, extras);
          setWatchlistFunnelOpen(false);
          setToast({
            title: `✓ Family Watchlist Applied (${selected.length} active${
              extras?.dietaryWatchlist?.length
                ? ` · ${extras.dietaryWatchlist.length} Allergy/Diet`
                : ""
            })`,
            body: "2x strictness enabled — scan any product or tap Swap ↗ as a Guest anytime.",
          });
        }}
        onApplyAndSignIn={(selected, extras?: OnboardingSelections) => {
          persistOnboardingSelections(selected, extras);
          setWatchlistFunnelOpen(false);
          setAuthOpen(true);
        }}
        onApplyAndStartTrial={(selected, extras?: OnboardingSelections) => {
          persistOnboardingSelections(selected, extras);
          setWatchlistFunnelOpen(false);
          setPaywallOpen(true);
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
        freeScanLimit={weeklySwapLimit}
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
          if (typeof window !== "undefined") {
            const devId = window.localStorage.getItem("heybroc_device_id") || deviceIdState;
            const devSecret = window.localStorage.getItem("heybroc_device_secret") || undefined;
            void fetch("/api/referral", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(devSecret ? { "X-Device-Secret": devSecret } : {}),
              },
              body: JSON.stringify({
                action: "courtesy_refill",
                deviceId: devId,
                deviceSecret: devSecret,
              }),
            }).catch(() => {});
          }
          setCourtesyRefillAvailable(false);
          setWeeklySwapLimit((prev) => Math.max(prev, FREE_SCAN_LIMIT + 3));
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

      <PostCheckoutOtoModal
        open={otoModalOpen}
        onClose={() => setOtoModalOpen(false)}
        initialPlan={otoInitialPlan}
        sessionId={otoSessionId}
        deviceId={deviceIdState}
        creatorCode={appliedCreator?.code}
      />

      <Scorecard
        open={scorecardOpen}
        onClose={() => setScorecardOpen(false)}
        store={store}
        cartAvg={cartAvg === null ? 0 : animatedCartAvg}
        swaps={swapHistory}
        fallbackDodged={fallbackDodged}
        fallbackSwaps={fallbackSwaps}
        defaultReferralCode={appliedCreator?.code || personalReferralCode}
        dirtyCount={dirty.length}
        onSwapAllAndMax={swapAll}
      />

      <LabelScannerModal
        open={labelScannerOpen}
        onClose={() => setLabelScannerOpen(false)}
        initialQuery={query}
        onScanLabel={async ({ productTitle, rawIngredients, barcode, detectedStore }) => {
          setQuery(productTitle);
          await executeLiveLookup({
            productTitle,
            rawIngredients,
            barcode,
            storeOverride: detectedStore,
            openCard: true,
          });
        }}
      />

      <WeeklyOrderAuditModal
        open={weeklyAuditOpen}
        onClose={() => setWeeklyAuditOpen(false)}
        store={store}
        onSelectStore={switchStore}
        preferStoreBrand={preferStoreBrand}
        onTogglePreferStoreBrand={togglePreferStoreBrand}
        watchlist={watch}
        familyWatchlist={familyWatchlist}
        dietaryWatchlist={dietaryWatchlist}
        isPro={isPro}
        freeSwapsRemaining={Math.max(0, weeklySwapLimit - swapsUsedThisWeek)}
        onConsumeSwap={(_swapTitle, replacedTitle) => {
          setSwapsUsedThisWeek((n) => n + 1);
          if (typeof window !== "undefined") {
            const devId = window.localStorage.getItem("heybroc_device_id") || "anon-web";
            const devSecret = window.localStorage.getItem("heybroc_device_secret") || "";
            void fetch("/api/referral", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(devSecret ? { "X-Device-Secret": devSecret } : {}),
              },
              body: JSON.stringify({
                action: "record_swap",
                deviceId: devId,
                deviceSecret: devSecret || undefined,
                productKey: replacedTitle,
              }),
            }).catch(() => {});
          }
        }}
        swapUnlocked={isPro || swapsUsedThisWeek < weeklySwapLimit}
        onUnlockPro={() => {
          setWeeklyAuditOpen(false);
          setPaywallOpen(true);
        }}
        onLoadIntoCart={handleLoadAuditedOrderIntoCart}
        onInspectAuditedItem={handleInspectAuditedItem}
      />

      <ProductExposeModal
        open={exposeCardOpen}
        onClose={() => setExposeCardOpen(false)}
        productTitle={active.title}
        productBrand={active.brand}
        score={score}
        dietaryAlerts={activeDietaryAlerts}
        swap={swap}
        swapUnlocked={isPro || swapsUsedThisWeek < weeklySwapLimit}
        store={store}
        referralCode={appliedCreator?.code || personalReferralCode}
      />
    </div>
  );
}
