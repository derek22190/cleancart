"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ALL_CATEGORIES,
  CATEGORY_LABELS,
  DEFAULT_WATCHLIST,
  scoreIngredients,
  type Category,
  type FlaggedAdditive,
  type ScoreResult,
} from "@/lib/rubric";
import { PRESETS } from "@/lib/presets";
import {
  CLEAN_ALTERNATIVES,
  STORE_META,
  STORES,
  detectCategory,
  resolveSwap,
  type Store,
  type SwapCategory,
  type SwapResult,
} from "@/lib/swaps";
import Paywall, { type AppliedCreator } from "./Paywall";
import InfluencerEngine from "./InfluencerEngine";
import Scorecard, { type SwapRecord } from "./Scorecard";

/* ------------------------------------------------------------------ */
/* Types & helpers                                                     */
/* ------------------------------------------------------------------ */

type Origin = "preset" | "live" | "swap";

interface Product {
  key: string;
  title: string;
  brand: string;
  size?: string;
  price?: number;
  image?: string;
  ingredients: string;
  category?: SwapCategory;
  origin: Origin;
  lookup?: { source: string; origin?: string; ms: number };
}

interface ApiScan {
  ok: boolean;
  error?: string;
  product?: { title: string; brand?: string; barcode?: string; imageUrl?: string; ingredients: string };
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

const cleanToProduct = (cat: SwapCategory): Product => {
  const alt = CLEAN_ALTERNATIVES[cat];
  return {
    key: `clean-${cat}`,
    title: alt.name,
    brand: alt.brand,
    price: 4.99,
    ingredients: alt.ingredients,
    category: cat,
    origin: "swap",
  };
};

const STORE_THEME: Record<Store, { bg: string; fg: string; accent: string; accentFg: string; mark: string }> = {
  walmart: { bg: "#0071dc", fg: "#ffffff", accent: "#0071dc", accentFg: "#fff", mark: "✳" },
  instacart: { bg: "#003d29", fg: "#ffffff", accent: "#0aad0a", accentFg: "#fff", mark: "🥕" },
  sams: { bg: "#0067a0", fg: "#ffffff", accent: "#0067a0", accentFg: "#fff", mark: "◆" },
  bjs: { bg: "#c8102e", fg: "#ffffff", accent: "#c8102e", accentFg: "#fff", mark: "★" },
};

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

/* ------------------------------------------------------------------ */
/* Main simulator                                                      */
/* ------------------------------------------------------------------ */

export default function Simulator() {
  const [store, setStore] = useState<Store>("walmart");
  const [watch, setWatch] = useState<Watch>(DEFAULT_WATCHLIST);
  const [active, setActive] = useState<Product>(presetToProduct(PRESETS[0]));
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
  const [isPro, setIsPro] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [paywallAutoShown, setPaywallAutoShown] = useState(false);
  const [appliedCreator, setAppliedCreator] = useState<AppliedCreator | null>(null);
  const [influencerOpen, setInfluencerOpen] = useState(false);
  const [influencerRefresh, setInfluencerRefresh] = useState(0);
  const [scorecardOpen, setScorecardOpen] = useState(false);

  const [toast, setToast] = useState<{ title: string; body: string; href?: string } | null>(null);

  const [query, setQuery] = useState("");
  const [liveState, setLiveState] = useState<"idle" | "loading" | "error">("idle");
  const [liveError, setLiveError] = useState("");
  const [apiJson, setApiJson] = useState<unknown>(null);
  const [iosText, setIosText] = useState("");
  const [inspectTab, setInspectTab] = useState<"json" | "ios">("json");

  const [panel, setPanel] = useState<"none" | "watchlist">("none");
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditBusy, setAuditBusy] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);

  const screenRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const score = useMemo(() => scoreIngredients(active.ingredients, watch), [active, watch]);
  const swap = useMemo(
    () => resolveSwap({ score: score.score, productTitle: `${active.brand} ${active.title}`, ingredients: active.ingredients, category: active.category, store }),
    [score.score, active, store],
  );
  const theme = STORE_THEME[store];

  /* ---------------- Cart scoring & animated Cart Avg ---------------- */
  const cartScored = useMemo(
    () =>
      cart.map((item) => {
        const s = scoreIngredients(item.ingredients, watch);
        const sw = resolveSwap({
          score: s.score,
          productTitle: `${item.brand} ${item.title}`,
          ingredients: item.ingredients,
          category: item.category,
          store,
        });
        return { item, s, sw };
      }),
    [cart, watch, store],
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
          PRESETS.flatMap((p) => scoreIngredients(p.ingredients, watch).flagged.map((f) => f.name)),
        ),
      ),
    [watch],
  );

  const fallbackSwaps = useMemo<SwapRecord[]>(
    () =>
      PRESETS.map((p) => {
        const s = scoreIngredients(p.ingredients, watch);
        const sw = resolveSwap({
          score: s.score,
          productTitle: `${p.brand} ${p.title}`,
          ingredients: p.ingredients,
          category: p.category,
          store,
        });
        if (!sw) return null;
        return {
          fromTitle: `${p.brand} ${p.title}`,
          toTitle: sw.title,
          store,
          dodged: s.flagged.map((f) => f.name),
        };
      }).filter((x): x is SwapRecord => Boolean(x)),
    [watch, store],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6500);
    return () => clearTimeout(t);
  }, [toast]);

  const registerScan = useCallback(() => {
    setScanCount((prev) => {
      const next = prev + 1;
      if (next >= FREE_SCAN_LIMIT && !isPro && !paywallAutoShown) {
        setPaywallAutoShown(true);
        setPaywallOpen(true);
      }
      return next;
    });
  }, [isPro, paywallAutoShown]);

  const switchStore = useCallback((s: Store) => {
    setStore(s);
    // Re-opening a store app automatically restores a hidden-for-trip bubble.
    setHiddenForTrip(false);
  }, []);

  const showProduct = useCallback(
    (p: Product, countAsScan = true) => {
      setActive(p);
      setViewMode("product");
      setOverlay("pill");
      setOpenFlag(null);
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      if (countAsScan) registerScan();
    },
    [registerScan],
  );

  const triggerClimbFlash = useCallback(() => {
    setCartClimbFlash(true);
    const t = setTimeout(() => setCartClimbFlash(false), 2600);
    return () => clearTimeout(t);
  }, []);

  /* ---------------- Swap (single item or from auditor) ---------------- */
  const swapCartItem = useCallback(
    (targetItem: Product) => {
      const itemScore = scoreIngredients(targetItem.ingredients, watch);
      const targetSwap = resolveSwap({
        score: itemScore.score,
        productTitle: `${targetItem.brand} ${targetItem.title}`,
        ingredients: targetItem.ingredients,
        category: targetItem.category,
        store,
      });
      if (!targetSwap) return;
      const clean = cleanToProduct(targetSwap.category);
      setCart((c) => {
        const idx = c.findIndex((i) => i.key === targetItem.key);
        if (idx === -1) return [...c, clean];
        const next = [...c];
        next[idx] = clean;
        return next;
      });
      setSwapHistory((prev) => [
        {
          fromTitle: `${targetItem.brand} ${targetItem.title}`,
          toTitle: targetSwap.title,
          store,
          dodged: itemScore.flagged.map((f) => f.name),
        },
        ...prev,
      ]);
      if (active.key === targetItem.key) {
        setActive(clean);
      }
      setOverlay("pill");
      setOpenFlag(null);
      triggerClimbFlash();
      setToast({
        title: `Swapped to ${targetSwap.title} · Cart Avg climbing ↑`,
        body: `Affiliate click fired on your tap → ${targetSwap.deepLink}`,
        href: targetSwap.webUrl,
      });
    },
    [watch, store, active.key, triggerClimbFlash],
  );

  const doSwap = useCallback(() => {
    swapCartItem(active);
  }, [swapCartItem, active]);

  /* ---------------- Live search ---------------- */
  const runLive = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const q = query.trim();
      if (!q) return;
      setLiveState("loading");
      setLiveError("");
      try {
        const payload = { productTitle: q, store, watchlist: watch };
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
        const p: Product = {
          key: `live-${data.product.barcode || q}`,
          title:
            data.product.title.replace(
              new RegExp(`^${(data.product.brand || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"),
              "",
            ) || data.product.title,
          brand: data.product.brand || "Open data",
          image: data.product.imageUrl,
          ingredients: data.product.ingredients,
          category: detectCategory(`${q} ${data.product.title}`, data.product.ingredients),
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
    [query, store, watch, showProduct],
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
  }, [cart, store, watch]);

  const swapAll = useCallback(() => {
    const n = dirty.length;
    if (n === 0) return;
    const records: SwapRecord[] = dirty.map((d) => ({
      fromTitle: `${d.item.brand} ${d.item.title}`,
      toTitle: d.sw!.title,
      store,
      dodged: d.s.flagged.map((f) => f.name),
    }));
    setSwapHistory((prev) => [...records, ...prev]);
    setCart((c) =>
      c.map((item) => {
        const hit = dirty.find((d) => d.item.key === item.key);
        return hit?.sw ? cleanToProduct(hit.sw.category) : item;
      }),
    );
    const replaced = dirty.find((d) => d.item.key === active.key);
    if (replaced?.sw) setActive(cleanToProduct(replaced.sw.category));
    triggerClimbFlash();
    setToast({
      title: `Swapped ${n} item${n === 1 ? "" : "s"} in 1 tap → Cart Avg 100/100!`,
      body: `${n} affiliate deep link${n === 1 ? "" : "s"} attributed to your tap at ${STORE_META[store].label}.`,
    });
  }, [dirty, active.key, store, triggerClimbFlash]);

  const resetCartPresets = useCallback(() => {
    setCart(PRESETS.map(presetToProduct));
    setSwapHistory([]);
    setActive(presetToProduct(PRESETS[0]));
  }, []);

  /* ---------------- 2D Pill drag + Drag-to-Hide drop zone ---------------- */
  const drag = useRef<{ startX: number; startY: number; startPill: number; moved: boolean } | null>(null);
  const onPillDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, startPill: pillY, moved: false };
    setPillDragOffset({ x: 0, y: 0 });
  };
  const onPillMove = (e: React.PointerEvent) => {
    if (!drag.current || !screenRef.current) return;
    const dx = e.clientX - drag.current.startX;
    const dy = e.clientY - drag.current.startY;
    if (Math.hypot(dx, dy) > 5) drag.current.moved = true;
    const rect = screenRef.current.getBoundingClientRect();
    const pct = drag.current.startPill + (dy / rect.height) * 100;
    setPillY(Math.max(14, Math.min(88, pct)));
    setPillDragOffset({ x: Math.min(0, dx), y: 0 });

    // Check if pointer is inside bottom-center "✕ Hide for this trip" drop target
    const relY = (e.clientY - rect.top) / rect.height;
    const relX = (e.clientX - rect.left) / rect.width;
    setOverHideZone(relY > 0.80 && relX > 0.2 && relX < 0.8);
  };
  const onPillUp = (isCartBubble: boolean, expand: boolean) => {
    const moved = drag.current?.moved;
    const dropHide = overHideZone;
    drag.current = null;
    setPillDragOffset(null);
    setOverHideZone(false);

    if (dropHide) {
      setHiddenForTrip(true);
      setToast({
        title: "CleanCart hidden for this trip",
        body: `Dismissed until the next time you open ${STORE_META[store].label}.`,
      });
      return;
    }
    if (!moved) {
      if (isCartBubble) {
        openAudit();
      } else if (expand) {
        setOverlay("card");
      } else {
        setOverlay("pill");
      }
    }
  };

  const toggleWatch = (c: Category) => setWatch((w) => ({ ...w, [c]: !w[c] }));
  const disabledCount = ALL_CATEGORIES.filter((c) => !watch[c]).length;

  // Is the floating pill currently in Cart Avg mode?
  const isCartBubbleMode = viewMode === "search" || cartClimbFlash;

  // Search aisle items (all 5 presets + 3 clean alternatives)
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
          <span className="brand-mark" aria-hidden>
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <div>
            <h1>CleanCart <span>PureOverlay</span></h1>
            <p>Ingredient-only grader &amp; 1-tap clean swaps — live simulator</p>
          </div>
        </div>

        <div className="topbar-actions">
          <button
            id="toggle-search-mode"
            type="button"
            className={`topbar-btn ${viewMode === "search" ? "is-active" : ""}`}
            onClick={() => setViewMode((m) => (m === "product" ? "search" : "product"))}
          >
            {viewMode === "search" ? `🛒 Scrolling Search (${animatedCartAvg}/100)` : "🔍 Scrolling Search Results"}
          </button>

          <button
            id="open-paywall"
            type="button"
            className={`topbar-btn topbar-btn--pro ${isPro ? "is-pro" : ""}`}
            onClick={() => setPaywallOpen(true)}
          >
            {isPro ? "★ PRO Unlocked" : `💎 Paywall / Pro (${Math.min(scanCount, FREE_SCAN_LIMIT)}/${FREE_SCAN_LIMIT})`}
          </button>

          <button
            id="open-influencers"
            type="button"
            className="topbar-btn"
            onClick={() => setInfluencerOpen(true)}
          >
            📈 Influencer Engine
          </button>

          <a className="topbar-link" href="/api/scan" target="_blank" rel="noreferrer">View rubric API ↗</a>
        </div>
      </header>

      <main className="layout">
        {/* ============ CONTROL PANEL ============ */}
        <section className="controls" aria-label="Simulator controls">
          <div className="card">
            <div className="card-head"><h2>Store</h2><span className="hint">Themes the app underneath</span></div>
            <div className="segmented" role="tablist">
              {STORES.map((s) => (
                <button key={s} id={`store-${s}`} role="tab" aria-selected={store === s} className={store === s ? "is-on" : ""} onClick={() => switchStore(s)}>
                  {STORE_META[s].label}
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Dual-Mode Floating Bubble</h2>
              <span className="hint">Cart Avg: {animatedCartAvg}/100</span>
            </div>
            <div className="segmented segmented--two">
              <button
                id="mode-product-btn"
                type="button"
                className={viewMode === "product" ? "is-on" : ""}
                onClick={() => setViewMode("product")}
              >
                📦 Product View ({score.score}/100)
              </button>
              <button
                id="mode-search-btn"
                type="button"
                className={viewMode === "search" ? "is-on" : ""}
                onClick={() => setViewMode("search")}
              >
                🛒 Scrolling Search ({animatedCartAvg}/100)
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
                  ↺ Overlay hidden for this trip · Tap to Restore
                </button>
              ) : (
                <button
                  id="snooze-bubble-btn"
                  type="button"
                  className="trip-pill"
                  onClick={() => {
                    setHiddenForTrip(true);
                    setToast({
                      title: "CleanCart hidden for this trip",
                      body: `Dismissed until you next open ${STORE_META[store].label}.`,
                    });
                  }}
                >
                  ✕ Hide for this trip (or drag bubble to bottom)
                </button>
              )}
              {cart.some((c) => c.origin === "swap") && (
                <button type="button" className="link-btn" onClick={resetCartPresets}>
                  Reset cart to 48/100
                </button>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Live real-product search</h2><span className="hint">Open Food Facts → USDA</span></div>
            <form className="search" onSubmit={runLive}>
              <input
                id="live-search-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. Cheez-It original, Doritos nacho, Chobani…"
                aria-label="Search any grocery product"
              />
              <button id="live-search-submit" type="submit" disabled={liveState === "loading" || !query.trim()}>
                {liveState === "loading" ? <span className="spinner" aria-label="Scanning" /> : "Scan"}
              </button>
            </form>
            {liveState === "error" && <p className="error">{liveError}</p>}
            {active.origin === "live" && active.lookup && (
              <p className="meta">
                Found via <b>{active.lookup.source === "cache" ? `local cache (${active.lookup.origin})` : active.lookup.source}</b> in {active.lookup.ms} ms
                {active.lookup.source !== "cache" && " — scan again for a cached <5 ms hit"}
              </p>
            )}
          </div>

          <div className="card">
            <div className="card-head"><h2>Preset products</h2><span className="hint">Scored live by rubric.ts</span></div>
            <ul className="preset-list">
              {PRESETS.map((p) => {
                const s = scoreIngredients(p.ingredients, watch);
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
              <span><b>Whole-Cart MCP Auditor</b><small>{dirty.length} dirty of {cart.length} • Avg {animatedCartAvg}/100</small></span>
            </button>
            <button id="open-watchlist" className={`tool ${panel === "watchlist" ? "is-on" : ""}`} onClick={() => setPanel((p) => (p === "watchlist" ? "none" : "watchlist"))}>
              <span className="tool-icon">⚙︎</span>
              <span><b>My Ingredient Watchlist</b><small>{disabledCount ? `${disabledCount} categor${disabledCount === 1 ? "y" : "ies"} ignored` : "All categories active"}</small></span>
            </button>
          </div>

          {panel === "watchlist" && (
            <div className="card watchlist">
              <div className="card-head"><h2>Watchlist</h2><button className="link-btn" onClick={() => setWatch(DEFAULT_WATCHLIST)}>Reset</button></div>
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
              <p className="meta">Calories, carbs, natural fat and sodium are never scored.</p>
            </div>
          )}

          <div className="card inspector">
            <div className="card-head">
              <h2>API inspector</h2>
              <div className="mini-tabs">
                <button className={inspectTab === "json" ? "is-on" : ""} onClick={() => setInspectTab("json")}>JSON</button>
                <button className={inspectTab === "ios" ? "is-on" : ""} onClick={() => setInspectTab("ios")}>ios_text</button>
              </div>
            </div>
            <pre>
              {inspectTab === "json"
                ? apiJson ? JSON.stringify(apiJson, null, 2) : "// Run a live search or the cart auditor to see the real\n// POST /api/scan · /api/audit response here."
                : iosText || "// Run a live search to see the iOS Shortcut text payload."}
            </pre>
          </div>
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
                  <span className="store-logo"><i>{theme.mark}</i>{STORE_META[store].label}</span>
                  <button className="cart-btn" onClick={() => setCartOpen(true)} aria-label="Open cart">
                    <svg viewBox="0 0 24 24" width="20" height="20"><path d="M3 4h2l2.4 11.2a2 2 0 002 1.6h7.7a2 2 0 002-1.5L21 8H6.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><circle cx="10" cy="20" r="1.4" fill="currentColor" /><circle cx="17" cy="20" r="1.4" fill="currentColor" /></svg>
                    <span className="cart-count">{cart.length}</span>
                  </button>
                </div>
                <button
                  type="button"
                  className="store-search"
                  onClick={() => setViewMode((m) => (m === "product" ? "search" : "product"))}
                >
                  <span>⌕ {viewMode === "search" ? `Scrolling "${STORE_META[store].label} Popular Grocery"` : `Search ${STORE_META[store].label}`}</span>
                  <em className="store-search-Action">{viewMode === "search" ? "Product view →" : "Browse aisle →"}</em>
                </button>
              </div>

              <div className="store-scroll" ref={scrollRef}>
                {viewMode === "search" ? (
                  <div className="aisle">
                    <div className="aisle-banner">
                      <b>Scrolling Search Results · Idle Mode</b>
                      <p>Bubble automatically switches to your live Cart Average ({animatedCartAvg}/100). Tap any product to inspect, or tap the bubble to audit &amp; swap all dirty items.</p>
                    </div>
                    <div className="aisle-grid">
                      {aisleItems.map((item) => {
                        const itemScore = scoreIngredients(item.ingredients, watch);
                        const inCart = cart.some((c) => c.key === item.key);
                        return (
                          <div key={item.key} className="aisle-card">
                            <button
                              type="button"
                              className="aisle-card-main"
                              onClick={() => showProduct(item)}
                            >
                              <div className="aisle-art">
                                <ProductArt product={item} />
                                <span className={`aisle-score tone-${itemScore.color}`}>{itemScore.score}/100</span>
                              </div>
                              <small className="aisle-brand">{item.brand}</small>
                              <b className="aisle-title">{item.title}</b>
                              <span className="aisle-price">${(item.price ?? 4.49).toFixed(2)}</span>
                            </button>
                            <button
                              type="button"
                              className={`aisle-add ${inCart ? "is-in" : ""}`}
                              onClick={() => {
                                if (!inCart) setCart((c) => [...c, item]);
                                setToast({ title: inCart ? "Already in cart" : "Added to cart", body: `${item.brand} ${item.title}` });
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
                          if (!cart.some((c) => c.key === active.key)) setCart((c) => [...c, active]);
                          setToast({ title: "Added to cart", body: `${active.brand} ${active.title}` });
                        }}
                      >
                        {cart.some((c) => c.key === active.key) ? "In cart ✓" : "Add to cart"}
                      </button>
                      {swap && (
                        <button
                          id="pdp-quick-swap"
                          type="button"
                          className="pdp-swap-inline"
                          onClick={doSwap}
                        >
                          ⚡ 1-Tap Clean Swap ({swap.score}/100)
                        </button>
                      )}
                    </div>
                    <div className="pdp-fulfil">
                      <div><b>Pickup</b><span>Today</span></div>
                      <div><b>Delivery</b><span>As soon as 1 hr</span></div>
                      <div><b>Shipping</b><span>Not available</span></div>
                    </div>
                    <div className="pdp-section"><h4>About this item</h4><p>Popular pick in {active.category ?? "Grocery"}. Customers frequently buy this together with other pantry staples.</p></div>
                    <div className="pdp-section"><h4>Specifications</h4><p>Brand: {active.brand}<br />Category: {active.category ?? "Grocery"}</p></div>
                    <div className="pdp-section"><h4>Ingredients</h4><p className="pdp-ingredients">{active.ingredients}</p><small className="no-scroll-note">CleanCart already read this — no scrolling needed.</small></div>
                  </div>
                )}
              </div>

              {/* ---------- OVERLAY: Dual-Mode Floating Pill ---------- */}
              {!hiddenForTrip && overlay !== "card" && (
                <div
                  id="floating-overlay-pill"
                  className={`pill tone-${isCartBubbleMode ? cartAvgTone : score.color} ${overlay === "min" ? "is-min" : ""} ${isCartBubbleMode ? "is-cart-avg" : ""} ${cartClimbFlash ? "is-climbing" : ""}`}
                  style={{
                    top: `${pillY}%`,
                    transform: pillDragOffset
                      ? `translate(${pillDragOffset.x}px, -50%)`
                      : "translateY(-50%)",
                  }}
                  onPointerDown={onPillDown}
                  onPointerMove={onPillMove}
                  onPointerUp={() => onPillUp(isCartBubbleMode, overlay === "pill")}
                  role="button"
                  aria-label={
                    isCartBubbleMode
                      ? `Cart Average ${animatedCartAvg} of 100. Tap to open Whole-Cart Auditor.`
                      : `CleanCart score ${score.score} of 100. Tap to inspect.`
                  }
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      if (isCartBubbleMode) openAudit();
                      else setOverlay("card");
                    }
                  }}
                >
                  <span className="pill-dot" />
                  {overlay === "min" ? (
                    <b>{isCartBubbleMode ? `🛒 ${animatedCartAvg}` : score.score}</b>
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
                  ✕ Hide for this trip
                </div>
              )}

              {/* ---------- OVERLAY: Health Insights card ---------- */}
              {overlay === "card" && (
                <div className="backdrop" onClick={() => setOverlay("pill")}>
                  <div className="insights" role="dialog" aria-label="Health Insights" onClick={(e) => e.stopPropagation()}>
                    <div className="insights-head">
                      <div>
                        <span className="eyebrow">CleanCart · Cart Avg {animatedCartAvg}/100</span>
                        <h3>Health Insights</h3>
                      </div>
                      <button className="close" onClick={() => setOverlay("pill")} aria-label="Close">×</button>
                    </div>
                    <p className="insights-product">{active.brand} · {active.title}</p>

                    <div className="insights-body">
                      <Gauge score={score.score} rating={score.rating} color={score.color} />
                      <div className="flags">
                        {score.flagged.length === 0 ? (
                          <p className="clean-note">✓ No watchlist additives found. Ingredients look clean.</p>
                        ) : (
                          score.flagged.map((f: FlaggedAdditive) => (
                            <button
                              key={f.id}
                              className={`flag risk-${f.risk} ${openFlag === f.id ? "is-open" : ""}`}
                              onClick={() => setOpenFlag((o) => (o === f.id ? null : f.id))}
                              aria-expanded={openFlag === f.id}
                            >
                              {f.name}{"\u00a0"}⚠️
                            </button>
                          ))
                        )}
                      </div>
                    </div>

                    {openFlag && (() => {
                      const f = score.flagged.find((x) => x.id === openFlag);
                      return f ? (
                        <div className={`explain risk-${f.risk}`}>
                          <b>{f.name}</b> <span>{RISK_LABEL[f.risk]} · −{f.penalty} pts · {CATEGORY_LABELS[f.category]}</span>
                          <p>{f.explanation}</p>
                        </div>
                      ) : null;
                    })()}

                    {score.ignored.length > 0 && (
                      <p className="ignored">Ignored by your watchlist: {score.ignored.map((i) => i.name).join(", ")}</p>
                    )}

                    {swap ? (
                      <div className="swap">
                        <div className="swap-info">
                          <ProductArt product={cleanToProduct(swap.category)} className="swap-art" />
                          <div>
                            <span className="eyebrow eyebrow--green">Clean Swap · {STORE_META[store].label}</span>
                            <b>{swap.title}</b>
                            <span className="swap-score">{swap.score}/100 Excellent</span>
                          </div>
                        </div>
                        <button id="swap-item" className="swap-btn" onClick={doSwap}>Swap Item</button>
                      </div>
                    ) : (
                      <div className="swap swap--ok"><b>Great pick.</b> This item already scores {score.score}/100 — no swap needed.</div>
                    )}
                  </div>
                </div>
              )}

              {/* ---------- Whole-Cart Auditor & Cart Sheet ---------- */}
              {(cartOpen || auditOpen) && (
                <div className="backdrop" onClick={() => { setCartOpen(false); setAuditOpen(false); }}>
                  <div className="sheet" onClick={(e) => e.stopPropagation()}>
                    <div className="sheet-grip" />
                    <div className="insights-head">
                      <div>
                        <span className="eyebrow">{auditOpen ? "CleanCart · Whole-Cart MCP Auditor" : STORE_META[store].label}</span>
                        <h3>{auditOpen ? "Cart audit" : "Your cart"}</h3>
                      </div>
                      <button className="close" onClick={() => { setCartOpen(false); setAuditOpen(false); }} aria-label="Close">×</button>
                    </div>
                    {auditOpen && (
                      <div className="audit-summary">
                        <Gauge score={animatedCartAvg} rating="Cart avg" color={cartAvgTone} size={78} />
                        <p>
                          {auditBusy
                            ? "Auditing via /api/audit…"
                            : dirty.length
                              ? <><b>{dirty.length}</b> of {cart.length} items score under 75. Tap <b>Swap</b> on each item to watch your Cart Avg climb live!</>
                              : "Every item in your cart scores 75+. Clean Cart Approved! 🎉"}
                        </p>
                      </div>
                    )}
                    <ul className="cart-list">
                      {cartScored.map(({ item, s, sw }) => (
                        <li key={item.key} className="cart-row">
                          <button className="cart-item" onClick={() => { setCartOpen(false); setAuditOpen(false); showProduct(item); }}>
                            <ProductArt product={item} className="cart-art" />
                            <span className="cart-text"><b>{item.title}</b><small>{item.brand}{sw ? ` → ${sw.brand}` : ""}</small></span>
                            <ScoreChip score={s.score} color={s.color} />
                          </button>
                          {sw && (
                            <button
                              type="button"
                              className="cart-row-swap"
                              onClick={() => swapCartItem(item)}
                            >
                              Swap
                            </button>
                          )}
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
                    {cartOpen && <button className="link-btn center" onClick={openAudit}>Run Whole-Cart Audit →</button>}
                  </div>
                </div>
              )}

              {toast && (
                <div className="toast" role="status">
                  <b>{toast.title}</b>
                  <p>{toast.body}</p>
                  {toast.href && <a href={toast.href} target="_blank" rel="noreferrer">Open real store ↗</a>}
                </div>
              )}
            </div>
          </div>
          <p className="stage-caption">
            Drag the pill to move or drop on <b>✕ Hide for this trip</b> · Toggle <b>Scrolling Search Results</b> for live <b>🛒 Cart Avg</b>
          </p>
        </section>
      </main>

      {/* ============ PHASE 6 MODALS ============ */}
      <Paywall
        open={paywallOpen}
        onClose={() => setPaywallOpen(false)}
        scanCount={scanCount}
        freeScanLimit={FREE_SCAN_LIMIT}
        appliedCreator={appliedCreator}
        onCreatorApplied={(c) => {
          setAppliedCreator(c);
          setInfluencerRefresh((n) => n + 1);
        }}
        onConversionComplete={({ plan, creator, trialDays, commissionOwed }) => {
          setIsPro(true);
          setInfluencerRefresh((n) => n + 1);
          setToast({
            title: creator
              ? `Pro Unlocked via ${creator.code} (${trialDays}-Day Trial)`
              : `CleanCart Pro Unlocked (${plan})`,
            body: creator
              ? `Creator ${creator.code} credited +$${(commissionOwed ?? 17.5).toFixed(2)} commission in Influencer Engine.`
              : "Unlimited store overlays, 1-tap clean swaps & cart audits active.",
          });
        }}
        onOpenInfluencerEngine={() => {
          setPaywallOpen(false);
          setInfluencerOpen(true);
        }}
      />

      <InfluencerEngine
        open={influencerOpen}
        onClose={() => setInfluencerOpen(false)}
        refreshKey={influencerRefresh}
        onSelectCodeForPaywall={(code) => {
          setAppliedCreator({ code, name: code, commissionPct: 35 });
          setInfluencerOpen(false);
          setPaywallOpen(true);
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
        defaultReferralCode={appliedCreator?.code || "PARENTMAXX"}
        dirtyCount={dirty.length}
        onSwapAllAndMax={swapAll}
      />
    </div>
  );
}
