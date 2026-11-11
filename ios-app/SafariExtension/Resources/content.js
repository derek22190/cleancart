// HeyBroc PureOverlay content script — Multi-Food Scanner, Per-Store & Per-Retailer Carts,
// Authoritative Cart Scraping + Instant Deletion Sync, In-Stock Swap Verification,
// Quantity-Weighted Cart Average Math, and Persistent Zero-FOUC Floating Pill UI.
(() => {
  if (window.__cleancartLoaded) return;
  window.__cleancartLoaded = true;

  const DEFAULT_API = "https://www.heybroc.com";
  const HOST = location.hostname.toLowerCase();
  const BASE_STORE = HOST.includes("walmart") ? "walmart"
    : HOST.includes("instacart") ? "instacart"
    : HOST.includes("target") ? "target"
    : HOST.includes("kroger") ? "kroger"
    : HOST.includes("aldi") ? "aldi"
    : HOST.includes("doordash") ? "doordash"
    : HOST.includes("ubereats") ? "ubereats"
    : (HOST.includes("amazon") || HOST.includes("wholefoods")) ? "amazon"
    : HOST.includes("samsclub") ? "sams"
    : HOST.includes("bjs") ? "bjs"
    : HOST.includes("costco") ? "costco"
    : HOST.includes("shipt") ? "shipt" : "walmart";

  const DEBOUNCE_MS = 200;
  const MAX_CART_ITEMS = 100;
  const STOCK_CACHE_TTL_MS = 10 * 60 * 1000;
  const PENDING_SWAP_KEY = "heybroc_pending_swap_check";

  const RESERVED_SLUGS = new Set([
    "s", "search", "cart", "checkout", "account", "hub", "referrals", "orders",
    "lists", "store", "stores", "items", "products", "product", "item", "help",
    "login", "signup", "categories", "collections", "shop", "convenience", "grocery",
    "all", "deals", "promotions", "favorites", "saved",
  ]);

  let clientInfo = { apiBase: DEFAULT_API, deviceId: "", creatorCode: "" };
  try {
    chrome.runtime.sendMessage({ type: "CLEANCART_GET_CLIENT_INFO" }, (res) => {
      if (res?.ok) {
        clientInfo = {
          apiBase: res.apiBase || DEFAULT_API,
          deviceId: res.deviceId || "",
          creatorCode: res.creatorCode || "",
        };
        render();
      }
    });
  } catch {
    /* ignore */
  }

  function buildWebActionUrl(kind) {
    const base = (clientInfo.apiBase || DEFAULT_API).replace(/\/+$/, "");
    const params = new URLSearchParams();
    params.set(kind === "login" ? "login" : "upgrade", "1");
    if (clientInfo.deviceId) params.set("deviceId", clientInfo.deviceId);
    if (clientInfo.creatorCode) params.set("code", clientInfo.creatorCode);
    return `${base}/?${params.toString()}`;
  }

  function fallbackThumbUrl(title) {
    const base = (clientInfo.apiBase || DEFAULT_API).replace(/\/+$/, "");
    return `${base}/api/product-image?q=${encodeURIComponent(String(title || "grocery"))}&v=4`;
  }

  function isPlaceholderProductImage(url) {
    if (!url || typeof url !== "string") return true;
    const trimmed = url.trim();
    if (!trimmed) return true;
    return (
      trimmed.includes("product-photo-unavailable") ||
      trimmed.toLowerCase().includes("placeholder")
    );
  }

  function sanitizeDomImageUrl(rawUrl, imgEl = null) {
    if (!rawUrl || typeof rawUrl !== "string") return null;
    const trimmed = rawUrl.trim();
    if (!trimmed || /^data:/i.test(trimmed) || /^blob:/i.test(trimmed)) return null;
    let parsed;
    try {
      parsed = new URL(trimmed, location.href);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const href = parsed.href;
    if (isPlaceholderProductImage(href)) return null;
    if (/\.svg(?:$|[?#])/i.test(parsed.pathname)) return null;
    if (
      /(?:1x1|pixel|spacer|spinner|loading|skeleton|sprite|logo|icon|badge|avatar|transparent\.gif|grey-pixel|blank\.gif)/i.test(
        href
      )
    ) {
      return null;
    }
    if (imgEl && typeof imgEl.getBoundingClientRect === "function") {
      if (imgEl.complete && imgEl.naturalWidth > 0 && (imgEl.naturalWidth < 32 || imgEl.naturalHeight < 32)) {
        return null;
      }
      const attrW = Number(imgEl.getAttribute?.("width") || 0);
      const attrH = Number(imgEl.getAttribute?.("height") || 0);
      if ((attrW > 0 && attrW < 32) || (attrH > 0 && attrH < 32)) return null;
      const rect = imgEl.getBoundingClientRect();
      if ((rect.width > 0 && rect.width < 32) || (rect.height > 0 && rect.height < 32)) {
        return null;
      }
    }
    return href;
  }

  const NEUTRAL_THUMB_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>`;

  const apiImagePlaceholderCache = new Map();

  async function checkApiImageIsPlaceholder(url) {
    if (!url || typeof url !== "string" || !url.includes("/api/product-image")) return false;
    if (apiImagePlaceholderCache.has(url)) return apiImagePlaceholderCache.get(url);
    try {
      const res = await fetch(url, { method: "HEAD" });
      const imgSrcHeader = res.headers.get("x-image-source") || "";
      const cType = res.headers.get("content-type") || "";
      const isPh =
        imgSrcHeader.toLowerCase().includes("placeholder") ||
        res.url?.includes("product-photo-unavailable") ||
        cType.includes("image/svg+xml");
      apiImagePlaceholderCache.set(url, isPh);
      return isPh;
    } catch {
      return false;
    }
  }

  /* ---------------- Per-Store & Per-Marketplace-Retailer Bucket Resolution ---------------- */
  function cleanSlug(raw) {
    if (!raw || typeof raw !== "string") return "";
    const slug = raw
      .trim()
      .toLowerCase()
      .replace(/^\/+|\/+$/g, "")
      .split("/")[0]
      .replace(/[^a-z0-9_-]/g, "");
    if (!slug || slug.length < 2 || RESERVED_SLUGS.has(slug) || /^\d+$/.test(slug)) return "";
    return slug;
  }

  function prettyRetailerSlug(slug) {
    if (!slug) return "";
    return slug
      .replace(/[-_]+/g, " ")
      .replace(/\b\d{3,}\b/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function detectInstacartSlug() {
    const pathMatch = location.pathname.match(/\/store\/([^/?#]+)/i);
    let slug = cleanSlug(pathMatch?.[1] || "");
    if (!slug) {
      const sp = new URLSearchParams(location.search);
      slug = cleanSlug(sp.get("retailer_slug") || sp.get("store") || "");
    }
    if (!slug) {
      const headerLinks = document.querySelectorAll(
        'header a[href*="/store/"], nav a[href*="/store/"], [data-testid*="retailer" i] a[href*="/store/"], [data-testid*="store" i] a[href*="/store/"]'
      );
      for (const a of headerLinks) {
        const m = (a.getAttribute("href") || "").match(/\/store\/([^/?#]+)/i);
        const cand = cleanSlug(m?.[1] || "");
        if (cand) {
          slug = cand;
          break;
        }
      }
    }
    if (slug) {
      try { sessionStorage.setItem("heybroc_last_instacart_slug", slug); } catch { /* ignore */ }
      return slug;
    }
    try {
      return cleanSlug(sessionStorage.getItem("heybroc_last_instacart_slug") || "");
    } catch {
      return "";
    }
  }

  function detectMarketplaceSlug(storeName, patterns, sessionKey) {
    for (const re of patterns) {
      const m = location.pathname.match(re);
      const cand = cleanSlug(m?.[1] || "");
      if (cand && cand !== storeName) {
        try { sessionStorage.setItem(sessionKey, cand); } catch { /* ignore */ }
        return cand;
      }
    }
    try {
      return cleanSlug(sessionStorage.getItem(sessionKey) || "");
    } catch {
      return "";
    }
  }

  function detectAmazonBannerBucket() {
    if (HOST.includes("wholefoods")) {
      return { bucketKey: "amazon:wholefoods", label: "Whole Foods" };
    }
    const pathLower = location.pathname.toLowerCase();
    const urlFull = `${pathLower}${location.search.toLowerCase()}`;
    let almBrandId = "";
    try {
      almBrandId = (new URLSearchParams(location.search).get("almBrandId") || "").toLowerCase();
    } catch {
      /* ignore */
    }
    const domHint = (
      document.querySelector(
        "#nav-subnav, #almDetailPagePoi, #fresh-merchant-info, #alm-cards-link, [data-csa-c-painter*='alm' i], #sc-alm-buy-box, .sc-alm-banner, #sc-active-cart h1, #sc-active-cart h2, [data-name='Active Items'] h2"
      )?.textContent || ""
    ).toLowerCase();

    if (
      pathLower.includes("/wholefoods") ||
      almBrandId === "vufhifdob2xliezvb2rz" ||
      urlFull.includes("wholefoods") ||
      urlFull.includes("vufhifdob2xliezvb2rz") ||
      /\bwhole\s+foods(?:\s+market)?\b/.test(domHint)
    ) {
      try { sessionStorage.setItem("heybroc_last_amazon_banner", "amazon:wholefoods"); } catch { /* ignore */ }
      return { bucketKey: "amazon:wholefoods", label: "Whole Foods" };
    }
    if (
      /^\/(?:alm|fresh)(?:\/|$)/.test(pathLower) ||
      pathLower.includes("/alm/") ||
      pathLower.includes("/fresh/") ||
      urlFull.includes("amazonfresh") ||
      Boolean(almBrandId) ||
      /\bamazon\s+fresh\b/.test(domHint)
    ) {
      try { sessionStorage.setItem("heybroc_last_amazon_banner", "amazon:fresh"); } catch { /* ignore */ }
      return { bucketKey: "amazon:fresh", label: "Amazon Fresh" };
    }
    if (/\/cart\/localmarket/i.test(pathLower)) {
      try {
        const lastBanner = sessionStorage.getItem("heybroc_last_amazon_banner");
        if (lastBanner === "amazon:wholefoods" || lastBanner === "wholefoods") {
          return { bucketKey: "amazon:wholefoods", label: "Whole Foods" };
        }
        if (lastBanner === "amazon:fresh" || lastBanner === "amazon_fresh") {
          return { bucketKey: "amazon:fresh", label: "Amazon Fresh" };
        }
      } catch {
        /* ignore */
      }
    }
    return { bucketKey: "amazon:core", label: "Amazon" };
  }

  function resolveStoreBucket() {
    if (BASE_STORE === "instacart") {
      const slug = detectInstacartSlug();
      return {
        store: "instacart",
        bucketKey: slug ? `instacart:${slug}` : "instacart",
        label: slug ? `Instacart · ${prettyRetailerSlug(slug)}` : "Instacart",
        instacartRetailerSlug: slug || undefined,
      };
    }
    if (BASE_STORE === "doordash") {
      const slug = detectMarketplaceSlug(
        "doordash",
        [/\/(?:convenience|grocery|retail)?\/?store\/([^/?#]+)/i],
        "heybroc_last_doordash_slug"
      );
      return {
        store: "doordash",
        bucketKey: slug ? `doordash:${slug}` : "doordash",
        label: slug ? `DoorDash · ${prettyRetailerSlug(slug)}` : "DoorDash",
      };
    }
    if (BASE_STORE === "ubereats") {
      const slug = detectMarketplaceSlug(
        "ubereats",
        [/\/store\/([^/?#]+)/i],
        "heybroc_last_ubereats_slug"
      );
      return {
        store: "ubereats",
        bucketKey: slug ? `ubereats:${slug}` : "ubereats",
        label: slug ? `Uber Eats · ${prettyRetailerSlug(slug)}` : "Uber Eats",
      };
    }
    if (BASE_STORE === "shipt") {
      const slug = detectMarketplaceSlug(
        "shipt",
        [/\/(?:shop\/)?stores\/([^/?#]+)/i],
        "heybroc_last_shipt_slug"
      );
      return {
        store: "shipt",
        bucketKey: slug ? `shipt:${slug}` : "shipt",
        label: slug ? `Shipt · ${prettyRetailerSlug(slug)}` : "Shipt",
      };
    }
    if (BASE_STORE === "amazon") {
      const amz = detectAmazonBannerBucket();
      return { store: "amazon", bucketKey: amz.bucketKey, label: amz.label };
    }
    const DIRECT_LABELS = {
      walmart: "Walmart",
      target: "Target",
      kroger: "Kroger",
      aldi: "ALDI",
      costco: "Costco",
      sams: "Sam's Club",
      bjs: "BJ's Wholesale",
    };
    return {
      store: BASE_STORE,
      bucketKey: BASE_STORE,
      label: DIRECT_LABELS[BASE_STORE] || "Grocery",
    };
  }

  let activeBucket = resolveStoreBucket();
  const storageKeyForBucket = (bKey) => `heybroc_cart_v2_${bKey}`;
  const hideKeyForBucket = (bKey) => `cleancart_hide_trip_${bKey}`;

  /* ---------------- State & Quantity-Weighted Cart Math ---------------- */
  let lastKey = "";
  let timer = null;
  let state = {
    mode: "cart_avg", // "product" | "cart_avg"
    get pillMode() {
      return this.mode;
    },
    set pillMode(nextMode) {
      this.mode = nextMode;
    },
    drawerTab: "product", // "product" | "cart"
    data: null,
    lastDomProductImageUrl: null,
    activeSwap: null, // verified in-stock SwapResult or primary
    swapStockChecking: false,
    allSwapsOutOfStock: false,
    expanded: false,
    auditorOpen: false,
    openFlag: null,
    y: 50,
    cartItems: [], // [{ key, title, quantity, image, domImageUrl, score, pending, isNonFood, dietaryAlerts, swapTitle, swapScore, swapUrl, swapImage, swapIsPaidLink, swapInStock, swapOutOfStock, swapCandidates }]
    displayedAvg: null,
    dragging: false,
    overHide: false,
    pendingSwap: null,
    hoveredCardData: null,
  };

  function clampQty(q) {
    if (q === undefined || q === null || q === "") return 1;
    const n = Number(q);
    if (!Number.isFinite(n)) return 1;
    return Math.min(99, Math.max(1, Math.round(n)));
  }

  function isScoredCartItem(item) {
    if (!item || item.pending || item.isNonFood) return false;
    if (item.score === null || item.score === undefined) return false;
    return Number.isFinite(Number(item.score));
  }

  function calcCartAvg(items = state.cartItems) {
    if (!Array.isArray(items) || items.length === 0) return null;
    let weightedSum = 0;
    let totalQty = 0;
    for (const item of items) {
      if (!isScoredCartItem(item)) continue;
      const qty = clampQty(item.quantity);
      const sc = Number(item.score);
      weightedSum += sc * qty;
      totalQty += qty;
    }
    return totalQty > 0 ? Math.round(weightedSum / totalQty) : null;
  }

  function calcProjectedAvgAfterSwaps(items = state.cartItems) {
    if (!Array.isArray(items) || items.length === 0) return null;
    let weightedSum = 0;
    let totalQty = 0;
    for (const item of items) {
      if (!isScoredCartItem(item)) continue;
      const qty = clampQty(item.quantity);
      const before = Number(item.score);
      const swScore =
        !item.swapOutOfStock && item.swapScore !== null && item.swapScore !== undefined && Number.isFinite(Number(item.swapScore))
          ? Number(item.swapScore)
          : null;
      const after = swScore !== null && swScore > before ? swScore : before;
      weightedSum += after * qty;
      totalQty += qty;
    }
    return totalQty > 0 ? Math.round(weightedSum / totalQty) : null;
  }

  function totalCartUnits(items = state.cartItems) {
    return (items || []).reduce((acc, i) => acc + clampQty(i?.quantity), 0);
  }

  function toneForScore(score) {
    if (score === null || score === undefined || !Number.isFinite(Number(score))) return "gray";
    const s = Number(score);
    return s >= 75 ? "green" : s >= 50 ? "yellow" : "red";
  }

  function ratingLabelForScore(score) {
    if (score === null || score === undefined || !Number.isFinite(Number(score))) return "Unscored";
    const s = Number(score);
    return s >= 75 ? "Excellent" : s >= 50 ? "Mediocre" : "Poor";
  }

  function normalizeTitleForMatch(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/\b(\d+(?:\.\d+)?\s*(?:fl\s*oz|oz|lb|lbs|ct|count|pk|pack|g|kg|ml|l|gal|gallon|qt|pt))\b/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isSameCartTitle(a, b) {
    const na = normalizeTitleForMatch(a);
    const nb = normalizeTitleForMatch(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.length >= 10 && nb.length >= 10 && (na.includes(nb) || nb.includes(na))) return true;
    const wa = na.split(" ").filter((w) => w.length >= 3);
    const wb = nb.split(" ").filter((w) => w.length >= 3);
    if (wa.length >= 3 && wb.length >= 3) {
      const overlap = wa.filter((w) => wb.includes(w)).length;
      if (overlap >= Math.min(wa.length, wb.length) - 1 && overlap >= 3) return true;
    }
    return false;
  }

  const DISMISSED_CART_TTL_MS = 12000;
  const dismissedCartKeys = new Map(); // normalizedKey -> expiresAtMs

  function pruneDismissedCartKeys() {
    const now = Date.now();
    for (const [k, exp] of dismissedCartKeys.entries()) {
      if (!exp || exp <= now) dismissedCartKeys.delete(k);
    }
  }

  function markCartItemDismissed(titleOrKey) {
    const norm = normalizeTitleForMatch(titleOrKey);
    if (!norm) return;
    pruneDismissedCartKeys();
    dismissedCartKeys.set(norm, Date.now() + DISMISSED_CART_TTL_MS);
  }

  function clearCartItemDismissed(titleOrKey) {
    const norm = normalizeTitleForMatch(titleOrKey);
    if (!norm) return;
    pruneDismissedCartKeys();
    dismissedCartKeys.delete(norm);
    for (const k of [...dismissedCartKeys.keys()]) {
      if (isSameCartTitle(k, norm)) dismissedCartKeys.delete(k);
    }
  }

  function isCartKeyDismissed(normKey) {
    if (!normKey) return false;
    pruneDismissedCartKeys();
    if (dismissedCartKeys.has(normKey)) return true;
    for (const k of dismissedCartKeys.keys()) {
      if (isSameCartTitle(k, normKey)) return true;
    }
    return false;
  }

  function isCartItemDismissed(titleOrKey) {
    return isCartKeyDismissed(normalizeTitleForMatch(titleOrKey));
  }

  function sanitizeStoredCartItem(raw) {
    if (!raw || typeof raw !== "object") return null;
    const title = String(raw.title || raw.key || "").trim();
    if (!title || title.startsWith("seed-") || String(raw.key || "").startsWith("seed-")) return null;
    const hasValidScore = raw.score !== null && raw.score !== undefined && Number.isFinite(Number(raw.score));
    const verifiedImg =
      typeof raw.image === "string" && raw.image.startsWith("http") && !isPlaceholderProductImage(raw.image)
        ? raw.image
        : null;
    const domImg = sanitizeDomImageUrl(raw.domImageUrl) || null;
    return {
      key: String(raw.key || title).trim(),
      title,
      quantity: clampQty(raw.quantity),
      image: verifiedImg,
      domImageUrl: domImg,
      score: hasValidScore ? Math.max(0, Math.min(100, Math.round(Number(raw.score)))) : null,
      pending: Boolean(raw.pending && !hasValidScore),
      isNonFood: Boolean(raw.isNonFood),
      dietaryAlerts: Array.isArray(raw.dietaryAlerts) ? raw.dietaryAlerts : [],
      swapTitle: raw.swapTitle || null,
      swapScore: raw.swapScore !== null && raw.swapScore !== undefined && Number.isFinite(Number(raw.swapScore)) ? Number(raw.swapScore) : null,
      swapUrl: raw.swapUrl || null,
      swapImage: raw.swapImage || null,
      swapIsPaidLink: Boolean(raw.swapIsPaidLink),
      swapInStock: Boolean(raw.swapInStock),
      swapOutOfStock: Boolean(raw.swapOutOfStock),
      swapCandidates: Array.isArray(raw.swapCandidates) ? raw.swapCandidates : [],
    };
  }

  let savingCartSelf = false;

  async function loadBucketCart(forceReload = false) {
    const nextBucket = resolveStoreBucket();
    if (!forceReload && nextBucket.bucketKey === activeBucket.bucketKey && state._cartLoaded) {
      activeBucket = nextBucket;
      publishActiveBucketMeta();
      return;
    }
    activeBucket = nextBucket;
    const v2Key = storageKeyForBucket(activeBucket.bucketKey);
    const legacyKeys = [];
    if (activeBucket.bucketKey === "amazon:wholefoods") {
      legacyKeys.push("heybroc_cart_v2_wholefoods");
    } else if (activeBucket.bucketKey === "amazon:fresh") {
      legacyKeys.push("heybroc_cart_v2_amazon_fresh");
    } else if (activeBucket.bucketKey === "amazon:core") {
      legacyKeys.push("heybroc_cart_v2_amazon", "cleancart_trip_cart_amazon");
    } else if (!activeBucket.bucketKey.includes(":") && activeBucket.bucketKey === BASE_STORE) {
      legacyKeys.push(`cleancart_trip_cart_${BASE_STORE}`);
    }

    try {
      const keysToFetch = [v2Key, ...legacyKeys];
      const stored = await chrome.storage.local.get(keysToFetch);
      let rawList = stored?.[v2Key];
      if (!Array.isArray(rawList)) {
        for (const lk of legacyKeys) {
          if (Array.isArray(stored?.[lk])) {
            rawList = stored[lk];
            await chrome.storage.local.set({ [v2Key]: rawList });
            await chrome.storage.local.remove(lk);
            break;
          }
        }
      }
      state.cartItems = Array.isArray(rawList)
        ? rawList.map(sanitizeStoredCartItem).filter(Boolean).slice(0, MAX_CART_ITEMS)
        : [];
      state._cartLoaded = true;
      state.displayedAvg = calcCartAvg();
      publishActiveBucketMeta();
    } catch {
      state.cartItems = [];
      state._cartLoaded = true;
      state.displayedAvg = null;
    }
  }

  function publishActiveBucketMeta() {
    try {
      chrome.storage.local.set({
        heybroc_active_bucket_meta: {
          bucketKey: activeBucket.bucketKey,
          store: activeBucket.store,
          label: activeBucket.label,
          instacartRetailerSlug: activeBucket.instacartRetailerSlug || null,
          host: HOST,
          updatedAt: Date.now(),
        },
      });
    } catch {
      /* ignore */
    }
  }

  function saveBucketCart() {
    try {
      savingCartSelf = true;
      const v2Key = storageKeyForBucket(activeBucket.bucketKey);
      chrome.storage.local.set(
        {
          [v2Key]: state.cartItems.slice(0, MAX_CART_ITEMS),
          heybroc_active_bucket_meta: {
            bucketKey: activeBucket.bucketKey,
            store: activeBucket.store,
            label: activeBucket.label,
            instacartRetailerSlug: activeBucket.instacartRetailerSlug || null,
            host: HOST,
            updatedAt: Date.now(),
          },
        },
        () => {
          setTimeout(() => { savingCartSelf = false; }, 60);
        }
      );
    } catch {
      savingCartSelf = false;
    }
  }

  function animateCartAvgTo(target) {
    if (target === null || target === undefined) {
      state.displayedAvg = null;
      render();
      return;
    }
    const start = state.displayedAvg !== null && state.displayedAvg !== undefined ? state.displayedAvg : target;
    const diff = target - start;
    if (diff === 0) {
      state.displayedAvg = target;
      render();
      return;
    }
    const t0 = performance.now();
    const duration = 550;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      state.displayedAvg = Math.round(start + diff * eased);
      render();
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------------- In-Stock Swap Verification & OOS Auto-Fallback ---------------- */
  const stockCache = new Map(); // key: `${bucketKey}|${titleLower}` -> { inStock, verifiedUrl, ts, unverifiedSpa }

  const OOS_TEXT_RE =
    /\b(out\s+of\s+stock|currently\s+unavailable|temporarily\s+out\s+of\s+stock|sold\s+out|not\s+available\s+at\s+this\s+store|unavailable\s+for\s+(?:pickup|delivery|shipping)|item\s+is\s+no\s+longer\s+available|0\s+results?\s+for|no\s+results?\s+for|we\s+couldn'?t\s+find\s+any\s+results|no\s+products?\s+found)\b/i;

  const IN_STOCK_SIGNAL_RE =
    /\b(add\s+to\s+(?:cart|bag|basket|order)|in\s+stock|many\s+in\s+stock|available\s+for\s+(?:pickup|delivery|shipping)|deliver(?:y|ed)\s+today|same-day\s+delivery)\b/i;

  function analyzeFetchedStoreHtml(html, candidate, fetchedUrl) {
    const raw = String(html || "");
    if (!raw || raw.length < 200) return { inStock: true, unverifiedSpa: true, verifiedUrl: fetchedUrl };

    const isSearchUrl = /\/search|\b(?:q|k|query|searchTerm|keyword)=/i.test(fetchedUrl);

    if (!isSearchUrl) {
      // Direct PDP HTML check
      const ldMatches = raw.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
      for (const block of ldMatches) {
        if (/schema\.org\/(?:OutOfStock|SoldOut|Discontinued)/i.test(block)) {
          return { inStock: false, verifiedUrl: fetchedUrl };
        }
        if (/schema\.org\/(?:InStock|LimitedAvailability|OnlineOnly)/i.test(block)) {
          return { inStock: true, verifiedUrl: fetchedUrl };
        }
      }
      if (/"availabilityStatus"\s*:\s*"OUT_OF_STOCK"|"isOutOfStock"\s*:\s*true|"inStock"\s*:\s*false/i.test(raw)) {
        return { inStock: false, verifiedUrl: fetchedUrl };
      }
      if (/"availabilityStatus"\s*:\s*"IN_STOCK"|"isOutOfStock"\s*:\s*false|"inStock"\s*:\s*true/i.test(raw)) {
        return { inStock: true, verifiedUrl: fetchedUrl };
      }
      // Strip scripts/styles for visible text heuristic
      const visibleApprox = raw
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ");
      if (OOS_TEXT_RE.test(visibleApprox) && !IN_STOCK_SIGNAL_RE.test(visibleApprox)) {
        return { inStock: false, verifiedUrl: fetchedUrl };
      }
      if (IN_STOCK_SIGNAL_RE.test(visibleApprox)) {
        return { inStock: true, verifiedUrl: fetchedUrl };
      }
      return { inStock: true, unverifiedSpa: true, verifiedUrl: fetchedUrl };
    }

    // Search Results Page HTML check
    const stripped = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");

    if (/\b(0\s+results?\s+for|no\s+results?\s+for|we\s+couldn'?t\s+find\s+any\s+results|no\s+products?\s+found|sorry,\s+no\s+products?\s+matched)\b/i.test(stripped)) {
      return { inStock: false, verifiedUrl: fetchedUrl };
    }

    const brandTokens = String(candidate.brand || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && w !== "organic" && w !== "organics");
    const nameTokens = String(candidate.name || candidate.title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && w !== "organic");

    const lowerHtml = raw.toLowerCase();
    const hasBrandInHtml = brandTokens.length > 0 && brandTokens.every((t) => lowerHtml.includes(t));
    const matchedNameTokens = nameTokens.filter((t) => lowerHtml.includes(t));

    if (hasBrandInHtml && matchedNameTokens.length >= Math.min(2, nameTokens.length)) {
      // Check if every occurrence near the brand is explicitly marked OUT_OF_STOCK
      const firstBrandIdx = lowerHtml.indexOf(brandTokens[0]);
      const windowSlice = raw.slice(Math.max(0, firstBrandIdx - 400), Math.min(raw.length, firstBrandIdx + 1600));
      if (
        /"availabilityStatus"\s*:\s*"OUT_OF_STOCK"|\bout\s+of\s+stock\b|\bsold\s+out\b/i.test(windowSlice) &&
        !/\badd\s+to\s+(?:cart|bag|order)\b|"IN_STOCK"/i.test(windowSlice)
      ) {
        return { inStock: false, verifiedUrl: fetchedUrl };
      }
      return { inStock: true, verifiedUrl: fetchedUrl };
    }

    // Pure client-rendered SPA shell (e.g. Instacart / DoorDash / Shipt before JS hydration)
    const hasAnyProductCards =
      /\/ip\/|\/dp\/|\/products\/|data-item-id|data-automation-id=["']product-title["']|s-result-item/i.test(raw);
    if (hasAnyProductCards && brandTokens.length > 0 && !hasBrandInHtml) {
      return { inStock: false, verifiedUrl: fetchedUrl };
    }

    return { inStock: true, unverifiedSpa: true, verifiedUrl: fetchedUrl };
  }

  async function verifySingleCandidateStock(candidate, bKey) {
    if (!candidate?.webUrl) return { inStock: true, verifiedUrl: null, locked: true };
    const cacheKey = `${bKey}|${String(candidate.title || "").toLowerCase()}`;
    const hit = stockCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < STOCK_CACHE_TTL_MS) {
      return hit;
    }

    let checkUrl = candidate.webUrl;
    try {
      const parsed = new URL(candidate.webUrl, location.origin);
      // Only fetch same-origin URLs directly with store session cookies
      if (parsed.hostname.replace(/^www\./, "") !== HOST.replace(/^www\./, "")) {
        const result = { inStock: true, unverifiedSpa: true, verifiedUrl: candidate.webUrl, ts: Date.now() };
        stockCache.set(cacheKey, result);
        return result;
      }
      checkUrl = parsed.href;
    } catch {
      return { inStock: true, unverifiedSpa: true, verifiedUrl: candidate.webUrl };
    }

    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 4200);
    try {
      const res = await fetch(checkUrl, {
        method: "GET",
        credentials: "include",
        signal: ctrl.signal,
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      clearTimeout(tid);
      if (res.status === 404 || res.status === 410) {
        const out = { inStock: false, verifiedUrl: checkUrl, ts: Date.now() };
        stockCache.set(cacheKey, out);
        return out;
      }
      if (!res.ok) {
        const fallback = { inStock: true, unverifiedSpa: true, verifiedUrl: checkUrl, ts: Date.now() };
        stockCache.set(cacheKey, fallback);
        return fallback;
      }
      const html = await res.text();
      const analyzed = analyzeFetchedStoreHtml(html, candidate, checkUrl);
      const out = { ...analyzed, ts: Date.now() };
      stockCache.set(cacheKey, out);
      return out;
    } catch {
      clearTimeout(tid);
      return { inStock: true, unverifiedSpa: true, verifiedUrl: checkUrl, ts: Date.now() };
    }
  }

  async function resolveFirstInStockSwap(candidates, primarySwap, bKey) {
    const list = Array.isArray(candidates) && candidates.length > 0
      ? candidates
      : primarySwap
        ? [primarySwap]
        : [];
    if (list.length === 0) return { chosen: null, allOutOfStock: false };
    // Locked swap (free swaps exhausted -> webUrl stripped by backend): return primary locked swap immediately
    if (!list[0].webUrl) {
      return { chosen: list[0], allOutOfStock: false };
    }
    for (let i = 0; i < list.length; i++) {
      const cand = list[i];
      if (!cand?.webUrl) continue;
      const check = await verifySingleCandidateStock(cand, bKey);
      if (check.inStock) {
        return {
          chosen: {
            ...cand,
            webUrl: check.verifiedUrl || cand.webUrl,
            inStock: true,
            stockVerified: !check.unverifiedSpa,
          },
          remainingCandidates: list.slice(i),
          allOutOfStock: false,
        };
      }
    }
    return { chosen: null, allOutOfStock: true };
  }

  function savePendingSwapNavigation(fromKey, candidates, startIdx = 0) {
    const payload = {
      fromKey: fromKey || "",
      bucketKey: activeBucket.bucketKey,
      candidates: (candidates || []).map((c) => ({
        title: c.title,
        brand: c.brand,
        name: c.name,
        score: c.score,
        webUrl: c.webUrl,
        isPaidLink: Boolean(c.isPaidLink),
      })),
      currentIndex: startIdx,
      startedAt: Date.now(),
    };
    try { sessionStorage.setItem(PENDING_SWAP_KEY, JSON.stringify(payload)); } catch { /* ignore */ }
    try { chrome.storage.local.set({ [PENDING_SWAP_KEY]: payload }); } catch { /* ignore */ }
  }

  async function checkLiveDestinationSwapStock() {
    let pending = null;
    try {
      const rawSession = sessionStorage.getItem(PENDING_SWAP_KEY);
      if (rawSession) pending = JSON.parse(rawSession);
    } catch { /* ignore */ }
    if (!pending) {
      try {
        const stored = await chrome.storage.local.get(PENDING_SWAP_KEY);
        if (stored?.[PENDING_SWAP_KEY]) pending = stored[PENDING_SWAP_KEY];
      } catch { /* ignore */ }
    }
    if (!pending || !Array.isArray(pending.candidates) || Date.now() - (pending.startedAt || 0) > 65000) {
      return;
    }
    const currentCand = pending.candidates[pending.currentIndex || 0];
    if (!currentCand?.webUrl) return;

    // Verify this tab's URL actually corresponds to the swap destination
    try {
      const targetUrl = new URL(currentCand.webUrl, location.origin);
      if (targetUrl.hostname.replace(/^www\./, "") !== HOST.replace(/^www\./, "")) return;
      if (targetUrl.pathname !== location.pathname && !location.href.includes(targetUrl.pathname)) return;
    } catch {
      return;
    }

    // Inspect hydrated live DOM after store page settles
    setTimeout(() => {
      const mainScope = activeDialogScope() || document.querySelector("main") || document.body;
      if (!mainScope) return;
      const heroText = (mainScope.innerText || "").slice(0, 3500);
      const hasAddCta = IN_STOCK_SIGNAL_RE.test(heroText);
      const hasExplicitOos = OOS_TEXT_RE.test(heroText) && !hasAddCta;

      if (hasExplicitOos) {
        const badCacheKey = `${pending.bucketKey}|${String(currentCand.title || "").toLowerCase()}`;
        stockCache.set(badCacheKey, { inStock: false, verifiedUrl: location.href, ts: Date.now() });

        const nextIdx = (pending.currentIndex || 0) + 1;
        if (nextIdx < pending.candidates.length && pending.candidates[nextIdx]?.webUrl) {
          const updated = { ...pending, currentIndex: nextIdx, startedAt: Date.now() };
          try { sessionStorage.setItem(PENDING_SWAP_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
          try { chrome.storage.local.set({ [PENDING_SWAP_KEY]: updated }); } catch { /* ignore */ }
          location.replace(pending.candidates[nextIdx].webUrl);
          return;
        }
      }

      // Clear once verified or exhausted
      try { sessionStorage.removeItem(PENDING_SWAP_KEY); } catch { /* ignore */ }
      try { chrome.storage.local.remove(PENDING_SWAP_KEY); } catch { /* ignore */ }
      if (pending.fromKey && currentCand.title) {
        state.pendingSwap = { fromKey: pending.fromKey, toTitle: currentCand.title };
      }
    }, 1400);
  }

  /* ---------------- Multi-Food DOM Scoping & Carousel Exclusion ---------------- */
  const NON_TITLE_RE =
    /^(search|your cart|shopping cart|cart|bag|basket|checkout|review order|order summary|items to add next|product information|similar items|customers also.*|sponsored.*|buy (?:it )?again|frequently bought together|saved for later|walmart|target|costco(?:\s+wholesale)?|sam'?s\s+club|aldi|kroger|instacart|whole\s+foods(?:\s+market)?|amazon(?:\s+fresh)?|bj'?s(?:\s+wholesale\s+club)?|doordash|dashmart|uber\s*eats|shipt|boost\s+by\s+kroger|continue\s+as\s+guest|log\s*in|sign\s*in|sign\s*up|same-day\s+delivery|choose\s+a\s+store|departments|grocery|savings|deals|weekly\s+ad|subtotal.*|estimated\s+total.*|substitutions?.*)$/i;

  const NON_INGREDIENT_RE =
    /\b(items to add next|product information|similar items|customers also|you might also|related items|frequently bought together|compare with similar|sold by|fulfilled by|see packaging|refer to packaging|nutrition facts|serving size)\b/i;

  const REAL_ING_HINT_RE =
    /\b(water|milk|cream|sugar|salt|flour|wheat|corn|soy|oil|butter|egg|cheese|cocoa|chocolate|vanilla|syrup|starch|acid|lecithin|gum|flavor|natural|organic|vitamin|potassium|sodium|calcium|turkey|chicken|beef|pork|apple|berry|oat|rice|potato|tomato|onion|garlic|spice|vinegar|yeast|honey|almond|peanut|hazelnut|extract|culture|enzyme)\b/i;

  const EXCLUDED_SECTION_HEADING_RE =
    /\b(customers\s+also\s+(?:viewed|bought|shopped|considered)|similar\s+items?|sponsored(?:\s+products?|\s+items?)?|buy\s+(?:it\s+)?again|frequently\s+bought\s+together|items?\s+to\s+add\s+next|recommended(?:\s+for\s+you)?|you\s+may\s+also\s+like|related\s+(?:products?|items?)|compare\s+with\s+similar|more\s+to\s+consider|saved\s+for\s+later|add-ons?|people\s+also\s+buy)\b/i;

  const EXCLUDED_CONTAINER_SEL = [
    '[data-testid*="carousel" i]',
    '[class*="carousel" i]',
    '[aria-label*="Sponsored" i]',
    '[data-testid*="sponsored" i]',
    '[data-component-type="sp-sponsored-result"]',
    '[data-testid*="similar" i]',
    '[data-testid*="recommendations" i]',
    '[data-testid*="saved-for-later" i]',
    '#sims-consolidated-1_feature_div',
    '#sims-consolidated-2_feature_div',
    '#sp_detail',
    '#sp_detail2',
  ].join(", ");

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") < 0.05) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 4 && rect.height > 4;
  }

  function isInsideExcludedSection(el, rootBoundary = document.body) {
    if (!el || typeof el.closest !== "function") return false;
    const matchedAttr = el.closest(EXCLUDED_CONTAINER_SEL);
    if (matchedAttr && (!rootBoundary || rootBoundary.contains(matchedAttr))) return true;

    let cur = el.parentElement;
    let depth = 0;
    while (cur && cur !== rootBoundary && cur !== document.body && depth < 9) {
      const aria = cur.getAttribute("aria-label") || "";
      if (EXCLUDED_SECTION_HEADING_RE.test(aria)) return true;
      if (/^(SECTION|ASIDE)$/.test(cur.tagName) || cur.getAttribute("role") === "region") {
        const heading = cur.querySelector(":scope > h2, :scope > h3, :scope > header h2, :scope > header h3, :scope > div > h2, :scope > div > h3");
        const hText = (heading?.textContent || "").replace(/\s+/g, " ").trim();
        if (hText && EXCLUDED_SECTION_HEADING_RE.test(hText)) return true;
      }
      cur = cur.parentElement;
      depth++;
    }
    return false;
  }

  function isCartDrawerElement(el) {
    if (!el) return false;
    const idAndTest = `${el.id || ""} ${el.getAttribute("data-testid") || ""} ${el.getAttribute("aria-label") || ""} ${el.className || ""}`;
    if (/\b(cart[-_ ]?(?:drawer|modal|panel|flyout|sidebar)|shopping[-_ ]?cart|mini[-_ ]?cart|bag[-_ ]?drawer)\b/i.test(idAndTest)) {
      return true;
    }
    const heading = el.querySelector("h1, h2, h3, [role='heading']");
    const hText = (heading?.textContent || "").replace(/\s+/g, " ").trim();
    if (/^(?:your\s+)?(?:shopping\s+)?(?:cart|bag|basket|order)(?:\s*\(\d+.*\))?$/i.test(hText)) {
      return true;
    }
    if (/\bcart\b/i.test(hText) && /\b(subtotal|estimated\s+total|go\s+to\s+checkout|continue\s+to\s+checkout|proceed\s+to\s+checkout)\b/i.test(el.textContent || "")) {
      return true;
    }
    return false;
  }

  /**
   * Detects open product quick-view modals / drawers across all 12 stores, including
   * high-z-index `position: fixed` overlays without `role="dialog"`, while ignoring
   * cart drawers, headers, navbars, cookie banners, and tiny toasts.
   */
  function activeDialogScope() {
    const explicitCandidates = document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], [data-testid*="modal" i], [data-testid*="quick-view" i], [data-testid*="item-details" i], [data-anchor-id*="ItemModal" i]'
    );
    const candidates = [...explicitCandidates];

    // Also inspect high-z-index fixed containers for quick-view drawers lacking role="dialog"
    const fixedNodes = document.querySelectorAll("div, section, aside, article");
    for (let i = 0; i < fixedNodes.length && i < 260; i++) {
      const node = fixedNodes[i];
      if (node.id === "cleancart-overlay-host") continue;
      const st = window.getComputedStyle(node);
      if (st.position !== "fixed") continue;
      const z = parseInt(st.zIndex, 10);
      if (!Number.isFinite(z) || z < 40) continue;
      if (!candidates.includes(node)) candidates.push(node);
    }

    let bestModal = null;
    let bestScore = 0;

    for (const d of candidates) {
      if (!d || d.id === "cleancart-overlay-host" || host?.contains(d)) continue;
      if (!isElementVisible(d)) continue;
      const rect = d.getBoundingClientRect();
      // Ignore tiny headers, navbars, sticky bars, and toast notifications
      if (rect.width < 280 || rect.height < 240) continue;
      if (rect.bottom < 160 || rect.top > window.innerHeight - 120) continue;
      if (/^(HEADER|NAV|FOOTER)$/i.test(d.tagName)) continue;

      const meta = `${d.id || ""} ${d.className || ""} ${d.getAttribute("aria-label") || ""} ${d.getAttribute("data-testid") || ""}`;
      if (/\b(cookie|consent|onetrust|gdpr|privacy|navbar|site-header|top-nav|search-dropdown|autocomplete|address-modal|store-selector|login|signin)\b/i.test(meta)) {
        continue;
      }
      if (isCartDrawerElement(d)) continue;

      const heading = d.querySelector('h1, h2, [data-testid*="product-title" i], [data-testid*="item-title" i]');
      const hText = (heading?.textContent || "").replace(/\s+/g, " ").trim();
      if (!hText || hText.length < 4 || NON_TITLE_RE.test(hText)) continue;

      const bodySample = (d.textContent || "").slice(0, 2500);
      const hasProductSignals =
        /\$\s*\d+|\b(add\s+to\s+(?:cart|bag|basket|order)|ingredients|nutrition\s+facts|oz|lb|fl\s*oz|count|pack)\b/i.test(bodySample);
      if (!hasProductSignals) continue;

      const z = parseInt(window.getComputedStyle(d).zIndex, 10) || 1;
      const rank = (d.getAttribute("aria-modal") === "true" || d.getAttribute("role") === "dialog" ? 1000 : 200) + Math.min(500, z);
      if (rank >= bestScore) {
        bestScore = rank;
        bestModal = d;
      }
    }
    return bestModal;
  }

  function isValidIngredientText(raw) {
    const t = String(raw || "").replace(/\s+/g, " ").trim();
    if (t.length < 12 || t.length >= 3000) return false;
    if (NON_INGREDIENT_RE.test(t) || NON_TITLE_RE.test(t)) return false;
    if (!t.includes(",") && !REAL_ING_HINT_RE.test(t)) return false;
    return true;
  }

  function cleanProductTitleText(raw) {
    return String(raw || "")
      .replace(/\s+/g, " ")
      .replace(/^(?:sponsored|best\s+seller|overall\s+pick|popular\s+pick|rollback)\s*[,•|:\-]?\s*/i, "")
      .replace(/\s*\(\d+(?:\.\d+)?\s*stars?.*$/i, "")
      .trim();
  }

  function readTitle(explicitScope) {
    const modalScope = explicitScope !== undefined ? explicitScope : activeDialogScope();
    const searchRoot = modalScope || document;
    const selectors = modalScope
      ? [
          '[data-testid*="item-details" i] h1',
          '[data-testid*="item-details" i] h2',
          '[data-anchor-id*="ItemModal" i] h1',
          '[data-anchor-id*="ItemModal" i] h2',
          '[data-testid*="product-title" i]',
          '[data-testid*="product-name" i]',
          '[data-testid*="itemHeader" i]',
          '[data-testid*="title" i]',
          "h1",
          "h2",
        ]
      : [
          '[data-testid="product-page-title"]',
          'h1[data-automation-id*="product-title" i]',
          '[data-automation-id="product-title"]',
          "h1.ProductDetails-header",
          "#productTitle",
          "h1#title",
          "#title_feature_div h1",
          'h1[itemprop="name"]',
          'h1[data-testid*="title" i]',
          '[data-testid*="product-title" i] h1',
          '[data-testid*="item-details" i] h1',
          "main h1",
          "h1",
        ];

    for (const sel of selectors) {
      const els = searchRoot.querySelectorAll(sel);
      for (const el of els) {
        if (!isElementVisible(el)) continue;
        if (isInsideExcludedSection(el, modalScope || document.body)) continue;
        if (!modalScope && isCartDrawerElement(el.closest('[role="dialog"], aside, section'))) continue;
        const t = cleanProductTitleText(el.textContent);
        if (t && t.length >= 4 && t.length <= 240 && !NON_TITLE_RE.test(t)) {
          return t;
        }
      }
    }
    return "";
  }

  function readIngredients(explicitScope) {
    const modalScope = explicitScope !== undefined ? explicitScope : activeDialogScope();
    const searchRoot = modalScope || document.querySelector("main") || document;
    const candidates = searchRoot.querySelectorAll("h2, h3, h4, dt, strong, b, span, div, p, button");
    for (const el of candidates) {
      if (isInsideExcludedSection(el, modalScope || document.body)) continue;
      const own = (el.childNodes.length <= 2 ? el.textContent : "").trim();
      if (!/^ingredients\s*:?$/i.test(own)) continue;
      let sib = el.nextElementSibling;
      for (let i = 0; i < 3 && sib; i++, sib = sib.nextElementSibling) {
        if (isInsideExcludedSection(sib, modalScope || document.body)) continue;
        const t = sib.textContent.replace(/\s+/g, " ").trim();
        // If multiple Ingredients blocks exist, stop before any second Ingredients label
        const firstBlock = t.split(/\bingredients\s*:/i)[0].trim();
        if (isValidIngredientText(firstBlock)) return firstBlock;
      }
      const parentText = el.parentElement?.textContent.replace(/\s+/g, " ").trim() || "";
      const stripped = parentText.replace(/^ingredients\s*:?\s*/i, "").split(/\bingredients\s*:/i)[0].trim();
      if (isValidIngredientText(stripped)) return stripped;
    }
    const inline = [...searchRoot.querySelectorAll("p, div, span")].find(
      (n) =>
        n.children.length === 0 &&
        !isInsideExcludedSection(n, modalScope || document.body) &&
        /^ingredients\s*:/i.test((n.textContent || "").trim())
    );
    const inlineText = inline
      ? inline.textContent.replace(/^ingredients\s*:\s*/i, "").split(/\bingredients\s*:/i)[0].trim()
      : "";
    return isValidIngredientText(inlineText) ? inlineText : "";
  }

  function readProductImage(explicitScope) {
    const modalScope = explicitScope !== undefined ? explicitScope : activeDialogScope();
    const searchRoot = modalScope || document.querySelector("main") || document;
    const selectors = [
      "#landingImage",
      "#imgTagWrapperId img",
      '[data-testid*="hero-image" i] img',
      '[data-testid*="product-image" i] img',
      '[data-testid*="item-details-image" i] img',
      '[data-test*="product-image" i] img',
      'img[itemprop="image"]',
      "img",
    ];
    for (const minSize of [64, 32]) {
      for (const sel of selectors) {
        const imgs = searchRoot.querySelectorAll(sel);
        for (const img of imgs) {
          if (!isElementVisible(img)) continue;
          if (isInsideExcludedSection(img, modalScope || document.body)) continue;
          const rect = img.getBoundingClientRect();
          if (rect.width < minSize || rect.height < minSize) continue;
          const cleanUrl = sanitizeDomImageUrl(img.currentSrc || img.getAttribute("src") || "", img);
          if (cleanUrl) return cleanUrl;
        }
      }
    }
    return null;
  }

  function isAmazonGroceryPage(modalScope) {
    if (HOST.includes("wholefoods")) return true;
    if (activeBucket.bucketKey === "amazon:wholefoods" || activeBucket.bucketKey === "amazon:fresh") return true;
    const crumbText =
      document.querySelector(
        "#wayfinding-breadcrumbs_feature_div, #nav-subnav, #brandByline_feature_div, #bylineInfo, #almDetailPagePoi, #fresh-merchant-info, #alm-cards-link, a[href*='almBrandId']"
      )?.textContent || "";
    if (
      /\b(grocery|gourmet food|amazon fresh|whole foods|365 by whole foods|happy belly|amazon grocery|pantry|food\s*&\s*beverage|snacks|beverages)\b/i.test(
        crumbText
      )
    ) {
      return true;
    }
    const searchAlias =
      document.querySelector("#searchDropdownBox option[selected], #nav-search-label-id")?.textContent || "";
    if (/\b(grocery|amazon fresh|whole foods|prime pantry)\b/i.test(searchAlias)) {
      return true;
    }
    if (REAL_ING_HINT_RE.test(readTitle(modalScope))) return true;
    return Boolean(readIngredients(modalScope));
  }

  function isProductPage() {
    const modalScope = activeDialogScope();
    if (modalScope) return true;

    const p = location.pathname;
    const s = location.search;
    if (isCartPageUrl()) return false;

    if (BASE_STORE === "walmart") return /\/ip\//.test(p);
    if (BASE_STORE === "instacart") return /\/products?\//.test(p) || /item_id=|product_id=/i.test(s);
    if (BASE_STORE === "target") return /\/p\//.test(p);
    if (BASE_STORE === "kroger") return /\/p\//.test(p);
    if (BASE_STORE === "aldi") return /\/products?\//.test(p) || /\/detail\/ps\/p\//.test(p);
    if (BASE_STORE === "doordash") return /\/(products?|item)\//.test(p) || /item-details|product_id|item_id/i.test(s);
    if (BASE_STORE === "ubereats") return /\/product\//.test(p) || /mod=quickView/i.test(s);
    if (BASE_STORE === "amazon") {
      if (HOST.includes("wholefoods")) return /\/products?\//.test(p);
      return /\/(dp|gp\/product|gp\/aw\/d)\//.test(p) && isAmazonGroceryPage(null);
    }
    if (BASE_STORE === "sams") return /\/(p|product|ip|sams\/shop\/product)\//.test(p);
    if (BASE_STORE === "bjs") return /\/product\//.test(p);
    if (BASE_STORE === "costco") return /\/p\/|\.product\./i.test(p);
    if (BASE_STORE === "shipt") return /\/(shop\/)?products?\//.test(p) || /product_id=|item_id=/i.test(s);
    return false;
  }

  /* ---------------- Multi-Product Grid Card Hover / Focus Disambiguation ---------------- */
  const PRODUCT_CARD_SEL = [
    '[data-item-id]',
    '[data-testid*="product-card" i]',
    '[data-testid*="item-card" i]',
    '[data-testid*="product-tile" i]',
    '[data-test*="product-card" i]',
    '[data-qa*="product-card" i]',
    '[data-automation-id*="product" i]',
    '[data-component-type="s-search-result"]',
    'article[class*="product" i]',
    'li[class*="product" i]',
  ].join(", ");

  function readProductCardInfo(cardEl) {
    if (!cardEl || host?.contains(cardEl)) return null;
    if (isCartDrawerElement(cardEl.closest('[role="dialog"], aside, section'))) return null;

    const titleSelectors = [
      '[data-automation-id="product-title"]',
      '[data-test="product-title"]',
      '[data-testid*="product-title" i]',
      '[data-testid*="item-title" i]',
      '[data-testid*="product-card-name" i]',
      '[data-qa*="product-name" i]',
      "h2 a span",
      "h3 a span",
      "h2",
      "h3",
      'a[href*="/ip/"]',
      'a[href*="/p/"]',
      'a[href*="/dp/"]',
      'a[href*="/products/"]',
    ];
    let title = "";
    for (const sel of titleSelectors) {
      const el = cardEl.querySelector(sel);
      const raw = cleanProductTitleText(el?.getAttribute?.("aria-label") || el?.textContent || "");
      if (raw && raw.length >= 5 && raw.length <= 200 && !NON_TITLE_RE.test(raw) && !/^\$\d/.test(raw)) {
        title = raw;
        break;
      }
    }
    if (!title) return null;
    let domImageUrl = null;
    const imgs = cardEl.querySelectorAll("img");
    for (const img of imgs) {
      const cand = sanitizeDomImageUrl(img.currentSrc || img.getAttribute("src") || "", img);
      if (cand) {
        domImageUrl = cand;
        break;
      }
    }
    return { title, image: domImageUrl, domImageUrl };
  }

  /* ---------------- Live Store Cart Scraping & Instant Deletion Sync ---------------- */
  function isCartPageUrl() {
    const p = location.pathname.toLowerCase();
    return (
      /\/(?:cart|bag|basket)(?:\/|$)/.test(p) ||
      /\/gp\/cart\//.test(p) ||
      /\/checkout\/cart/.test(p) ||
      /\/store\/cart/.test(p) ||
      /\/shop\/cart/.test(p)
    );
  }

  function detectOpenCartRoot() {
    // 1. Check visible slide-out cart drawer / dialog first (works on EVERY page!)
    const dialogCandidates = document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], aside, [data-testid*="cart-drawer" i], [data-testid*="cart-modal" i], [id*="cart-drawer" i], [class*="CartDrawer" i]'
    );
    for (const el of dialogCandidates) {
      if (!el || el.id === "cleancart-overlay-host" || host?.contains(el)) continue;
      if (!isElementVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 260 || rect.height < 220) continue;
      if (isCartDrawerElement(el)) return el;
    }

    // 2. Check dedicated /cart page main container
    if (isCartPageUrl()) {
      return (
        document.querySelector(
          "#sc-active-cart, [data-testid*='cart-page' i], [data-test*='cart-container' i], [data-qa*='cart' i], main"
        ) || document.body
      );
    }
    return null;
  }

  const EMPTY_CART_RE =
    /\b(your\s+(?:shopping\s+)?(?:cart|bag|basket|order|amazon\s+cart|instacart\s+cart|walmart\s+cart|target\s+cart)\s+is\s+(?:currently\s+)?empty|0\s+items?\s+in\s+(?:your\s+)?(?:cart|bag|basket)|you\s+have\s+no\s+items\s+in\s+your\s+(?:cart|bag)|nothing\s+in\s+your\s+(?:cart|bag)|time\s+to\s+start\s+shopping|ready\s+to\s+fill\s+your\s+cart)\b/i;

  const CART_ROW_UI_NOISE_RE =
    /^(?:subtotal.*|estimated\s+total.*|order\s+total.*|taxes?.*|delivery(?:\s+fee)?.*|service\s+fee.*|bag\s+fee.*|driver\s+tip.*|tip.*|checkout.*|proceed\s+to\s+checkout.*|continue\s+to\s+checkout.*|go\s+to\s+checkout.*|substitutions?.*|choose\s+substitution.*|remove|delete|save\s+for\s+later|move\s+to\s+cart|clip\s+coupon|free\s+(?:shipping|delivery|pickup).*|snap\s+ebt.*|sold\s+by.*|fulfilled\s+by.*|arrives\s+.*|pickup\s+.*|shipping\s+.*|\$?\d+(?:\.\d{2})?(?:\s*\/\s*\w+)?|qty\s*:?\s*\d+|\d+\s*(?:ct|items?))$/i;

  const CART_ROW_SELECTORS = [
    '[data-test="cartItem"]',
    '[data-qa*="cart-item" i]',
    ".sc-list-item-content",
    'div[data-asin]:not([data-asin=""])',
    '[data-testid*="cart-item" i]',
    '[data-testid*="line-item" i]',
    '[data-automation-id*="cart-item" i]',
    '[data-item-id]',
    "li",
    "article",
  ];

  function isInsideCartExcludedArea(el, cartRoot) {
    if (!el || typeof el.closest !== "function") return false;
    if (el.closest('#sc-saved-cart, [data-testid*="saved" i], [data-test*="savedForLater" i], [data-testid*="buy-again" i], [data-testid*="recommend" i], [data-testid*="upsell" i], [data-testid*="addon" i]')) {
      return true;
    }
    return isInsideExcludedSection(el, cartRoot);
  }

  function extractRowQuantity(rowEl) {
    if (!rowEl) return 1;
    const numInput = rowEl.querySelector('input[type="number"], input[role="spinbutton"], input[name*="quantity" i], input[aria-label*="quantity" i]');
    if (numInput && numInput.value !== "") {
      const n = Number(numInput.value);
      if (Number.isFinite(n) && n >= 0) return n === 0 ? 0 : clampQty(n);
    }
    const sel = rowEl.querySelector('select[name*="quantity" i], select[aria-label*="quantity" i], select[data-testid*="qty" i], select[data-test*="qty" i], select[data-qa*="qty" i], select');
    if (sel && sel.value !== "") {
      const m = String(sel.value).match(/\d+/);
      if (m) {
        const parsed = Number(m[0]);
        return parsed === 0 ? 0 : clampQty(parsed);
      }
    }
    const ariaQty = rowEl.querySelector('[aria-label*="quantity" i], [data-testid*="quantity" i], [data-test*="quantity" i], .a-dropdown-prompt');
    if (ariaQty) {
      const txt = `${ariaQty.textContent || ""} ${ariaQty.getAttribute("aria-label") || ""}`;
      const m = txt.match(/(?:qty|quantity|in\s+cart)\s*:?\s*(\d{1,2})\b/i) || txt.trim().match(/^(\d{1,2})(?:\s*ct)?$/i);
      if (m) return clampQty(Number(m[1]));
    }
    // Stepper middle text between - and + buttons
    const btns = rowEl.querySelectorAll("button, [role='button']");
    for (const b of btns) {
      const t = (b.textContent || "").trim();
      if (t === "-" || t === "−" || /decrease|minus/i.test(b.getAttribute("aria-label") || "")) {
        const next = b.nextElementSibling;
        const nm = (next?.textContent || "").trim().match(/^(\d{1,2})(?:\s*ct)?$/i);
        if (nm) return clampQty(Number(nm[1]));
      }
    }
    return 1;
  }

  function extractRowTitleAndImage(rowEl) {
    if (!rowEl) return null;
    const titleSelectors = [
      '[data-test="cartItem-title"]',
      '[data-qa*="cart-item-title" i]',
      '[data-qa*="item-name" i]',
      '[data-qa*="product-name" i]',
      ".sc-product-title",
      '[data-automation-id*="product-title" i]',
      '[data-testid*="item-title" i]',
      '[data-testid*="product-title" i]',
      '[data-testid*="cart-item-title" i]',
      '[data-testid*="line-item-name" i]',
      'a[href*="/ip/"]',
      'a[href*="/p/"]',
      'a[href*="/dp/"]',
      'a[href*="/gp/product/"]',
      'a[href*="/products/"]',
      'a[href*="/product/"]',
      "h3",
      "h4",
      "a",
    ];
    let title = "";
    for (const sel of titleSelectors) {
      const nodes = rowEl.querySelectorAll(sel);
      for (const n of nodes) {
        const cand = cleanProductTitleText(n.textContent || n.getAttribute("aria-label") || "");
        if (
          cand.length >= 5 &&
          cand.length <= 220 &&
          /[a-zA-Z]{3,}/.test(cand) &&
          !NON_TITLE_RE.test(cand) &&
          !CART_ROW_UI_NOISE_RE.test(cand) &&
          !/^\$?\d+(?:\.\d{2})?$/.test(cand)
        ) {
          title = cand;
          break;
        }
      }
      if (title) break;
    }
    if (!title) return null;

    let domImageUrl = null;
    const imgs = rowEl.querySelectorAll("img");
    for (const img of imgs) {
      const cand = sanitizeDomImageUrl(img.currentSrc || img.getAttribute("src") || "", img);
      if (cand) {
        domImageUrl = cand;
        break;
      }
    }
    return { title, image: domImageUrl, domImageUrl };
  }

  function readExplicitCartCount(cartRoot) {
    const badgeSelectors = [
      "#nav-cart-count",
      '[data-testid*="cart-count" i]',
      '[data-automation-id*="cart-count" i]',
      '[data-test*="cart-count" i]',
      '[data-qa*="cart-count" i]',
      '[aria-label*="items in cart" i]',
      '[aria-label*="item in cart" i]',
      'a[href*="/cart"] span',
    ];
    for (const sel of badgeSelectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const aria = el.getAttribute("aria-label") || "";
      const ariaMatch = aria.match(/\b(\d{1,3})\s+items?\s+in\s+(?:your\s+)?(?:cart|bag|basket)\b/i);
      if (ariaMatch) return Number(ariaMatch[1]);
      const txt = (el.textContent || "").trim();
      if (/^\d{1,3}$/.test(txt)) return Number(txt);
    }
    if (cartRoot) {
      const headerEls = cartRoot.querySelectorAll("h1, h2, h3, [role='heading'], [data-testid*='subtotal' i], [data-test*='subtotal' i]");
      for (const h of headerEls) {
        if (isInsideCartExcludedArea(h, cartRoot)) continue;
        const t = (h.textContent || "").replace(/\s+/g, " ").trim();
        const m = t.match(/\b(\d{1,3})\s+items?\b/i) || t.match(/^(?:cart|bag|basket)\s*\((\d{1,3})\)$/i);
        if (m) return Number(m[1]);
      }
    }
    return null;
  }

  function isVirtualizedOrScrolledCart(cartRoot) {
    if (!cartRoot) return false;
    if (
      cartRoot.querySelector(
        '[data-virtualized], [data-testid*="virtual" i], [class*="ReactVirtualized" i], [class*="virtual" i][style*="height"]'
      )
    ) {
      return true;
    }
    const candidates = [cartRoot, ...cartRoot.querySelectorAll("div, ul, section")];
    for (let i = 0; i < candidates.length && i < 48; i++) {
      const el = candidates[i];
      if (!el || isInsideCartExcludedArea(el, cartRoot)) continue;
      if (el.scrollTop > 8) return true;
      if (el.clientHeight >= 140 && el.scrollHeight > el.clientHeight + 48) {
        const st = window.getComputedStyle(el);
        if (/(?:auto|scroll|overlay)/i.test(`${st.overflowY} ${st.overflow}`)) {
          return true;
        }
      }
    }
    return false;
  }

  function clickNativeCartRemoveButton(targetTitle) {
    if (!targetTitle) return false;
    const cartRoot = detectOpenCartRoot();
    if (!cartRoot) return false;

    const nativeRemoveSelectors = [
      '[data-test="cartItem-deleteBtn"]',
      'button[data-test*="delete" i]',
      'button[data-test*="remove" i]',
      '[data-automation-id*="remove" i]',
      '[data-qa*="remove" i]',
      'button[data-qa*="delete" i]',
      '[data-testid*="cart-item-remove" i]',
      '[data-testid*="remove" i]',
      '[data-testid*="delete" i]',
      'input[name^="submit.delete"]',
      'input[value*="Delete" i]',
      '[data-action="delete"] input',
      '[data-action="delete"] button',
      'button[aria-label*="Remove" i]',
      'button[aria-label*="Delete" i]',
    ];

    for (const sel of CART_ROW_SELECTORS) {
      const rows = cartRoot.querySelectorAll(sel);
      for (const row of rows) {
        if (!isElementVisible(row) || isInsideCartExcludedArea(row, cartRoot)) continue;
        const subProductLinks = row.querySelectorAll('a[href*="/ip/"], a[href*="/p/"], a[href*="/dp/"], a[href*="/products/"]');
        const distinctHrefs = new Set([...subProductLinks].map((a) => (a.getAttribute("href") || "").split("?")[0]).filter(Boolean));
        if (distinctHrefs.size > 1) continue;

        const info = extractRowTitleAndImage(row);
        if (!info || !isSameCartTitle(info.title, targetTitle)) continue;

        for (const btnSel of nativeRemoveSelectors) {
          const btn = row.querySelector(btnSel);
          if (btn && isElementVisible(btn)) {
            btn.click();
            return true;
          }
        }
        const allBtns = row.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]');
        for (const btn of allBtns) {
          if (!isElementVisible(btn)) continue;
          const lbl = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""} ${btn.value || ""}`;
          if (!/\bundo\b/i.test(lbl) && /\b(remove|delete|trash)\b/i.test(lbl)) {
            btn.click();
            return true;
          }
        }
        if (extractRowQuantity(row) === 1) {
          for (const btn of allBtns) {
            if (!isElementVisible(btn)) continue;
            const txt = (btn.textContent || "").trim();
            const lbl = `${txt} ${btn.getAttribute("aria-label") || ""}`;
            if (txt === "-" || txt === "−" || /\b(decrease|decrement|minus)\b/i.test(lbl)) {
              btn.click();
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  let cartSyncTimer = null;
  function scheduleCartSync(delayMs = 240) {
    clearTimeout(cartSyncTimer);
    cartSyncTimer = setTimeout(() => {
      cartSyncTimer = null;
      scrapeAndSyncLiveCart();
    }, delayMs);
  }

  function scrapeAndSyncLiveCart() {
    const cartRoot = detectOpenCartRoot();
    if (!cartRoot) return false;

    pruneDismissedCartKeys();

    // Gather text outside excluded carousels / saved-for-later to check empty signal
    const primaryTextChunks = [];
    const textEls = cartRoot.querySelectorAll("h1, h2, h3, p, span, div");
    for (let i = 0; i < textEls.length && i < 180; i++) {
      const el = textEls[i];
      if (el.children.length > 2) continue;
      if (isInsideCartExcludedArea(el, cartRoot)) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t) primaryTextChunks.push(t);
    }
    const primaryCartText = primaryTextChunks.join(" \n ");
    const explicitCount = readExplicitCartCount(cartRoot);

    if (EMPTY_CART_RE.test(primaryCartText) || (isCartPageUrl() && explicitCount === 0) || (explicitCount === 0 && primaryCartText.length > 0)) {
      if (state.cartItems.length > 0) {
        state.cartItems = [];
        state.displayedAvg = null;
        saveBucketCart();
        render();
      }
      return true;
    }

    const scrapedMap = new Map();
    const visitedEls = new Set();

    for (const sel of CART_ROW_SELECTORS) {
      const rows = cartRoot.querySelectorAll(sel);
      for (const row of rows) {
        if (visitedEls.has(row) || !isElementVisible(row)) continue;
        if (isInsideCartExcludedArea(row, cartRoot)) continue;
        // Skip giant wrapper containers that contain multiple items
        const subProductLinks = row.querySelectorAll('a[href*="/ip/"], a[href*="/p/"], a[href*="/dp/"], a[href*="/products/"]');
        const distinctHrefs = new Set([...subProductLinks].map((a) => (a.getAttribute("href") || "").split("?")[0]).filter(Boolean));
        if (distinctHrefs.size > 1) continue;

        // Require cart row context: quantity control, remove button, or price
        const rowText = (row.textContent || "").replace(/\s+/g, " ");
        const hasRowControl =
          /\$\s*\d+/.test(rowText) ||
          Boolean(
            row.querySelector(
              'input[type="number"], select, [data-test="cartItem-deleteBtn"], [data-qa*="remove" i], [data-automation-id*="remove" i], input[value*="Delete" i], button[aria-label*="remove" i], button[aria-label*="delete" i], button[aria-label*="quantity" i], [data-testid*="remove" i], [data-testid*="quantity" i]'
            )
          );
        if (!hasRowControl) continue;

        const info = extractRowTitleAndImage(row);
        if (!info) continue;
        const qty = extractRowQuantity(row);
        if (qty <= 0) continue;

        visitedEls.add(row);
        const norm = normalizeTitleForMatch(info.title);
        if (!norm || isCartKeyDismissed(norm)) continue;
        const prev = scrapedMap.get(norm);
        if (prev) {
          if (info.domImageUrl && !prev.domImageUrl) prev.domImageUrl = info.domImageUrl;
        } else if (scrapedMap.size < MAX_CART_ITEMS) {
          scrapedMap.set(norm, {
            title: info.title,
            quantity: qty,
            domImageUrl: info.domImageUrl || null,
          });
        }
      }
      if (scrapedMap.size >= 1 && sel !== "li" && sel !== "article") {
        // High-precision store selector matched real cart items; don't double-scrape generic <li>/<article>
        break;
      }
    }

    const scrapedList = [...scrapedMap.values()];
    if (scrapedList.length === 0) {
      // Filter any tombstoned items from state.cartItems even if remaining rows haven't hydrated
      const filteredExisting = state.cartItems.filter(
        (c) => !isCartItemDismissed(c.title) && !isCartItemDismissed(c.key)
      );
      if (filteredExisting.length !== state.cartItems.length) {
        state.cartItems = filteredExisting;
        state.displayedAvg = calcCartAvg();
        saveBucketCart();
        render();
      }
      return false;
    }

    let changed = false;
    const nextCart = [];
    const toAudit = [];

    for (const scraped of scrapedList) {
      const existing = state.cartItems.find((c) => isSameCartTitle(c.title, scraped.title) || isSameCartTitle(c.key, scraped.title));
      if (existing) {
        if (
          existing.quantity !== scraped.quantity ||
          (scraped.domImageUrl && existing.domImageUrl !== scraped.domImageUrl)
        ) {
          changed = true;
        }
        const updated = {
          ...existing,
          quantity: scraped.quantity,
          domImageUrl: scraped.domImageUrl || existing.domImageUrl || null,
        };
        nextCart.push(updated);
        if (updated.pending || (updated.score === null && !updated.isNonFood)) {
          toAudit.push(updated);
        }
      } else {
        changed = true;
        const newEntry = {
          key: scraped.title,
          title: scraped.title,
          quantity: scraped.quantity,
          image: null,
          domImageUrl: scraped.domImageUrl || null,
          score: null,
          pending: true,
          isNonFood: false,
          dietaryAlerts: [],
          swapTitle: null,
          swapScore: null,
          swapUrl: null,
          swapImage: null,
          swapIsPaidLink: false,
          swapInStock: false,
          swapOutOfStock: false,
          swapCandidates: [],
        };
        nextCart.push(newEntry);
        toAudit.push(newEntry);
      }
    }

    // Protect virtualized cart drawers (Instacart/Walmart/Target) where scrolling unmounts offscreen rows,
    // while still honoring explicit removals (dismissedCartKeys or header/subtotal count drop).
    if (isVirtualizedOrScrolledCart(cartRoot)) {
      let runningUnits = totalCartUnits(nextCart);
      const countCapAllowsPreserve = explicitCount === null || runningUnits < explicitCount;
      if (countCapAllowsPreserve) {
        for (const prevItem of state.cartItems) {
          if (nextCart.length >= MAX_CART_ITEMS) break;
          if (isCartItemDismissed(prevItem.title) || isCartItemDismissed(prevItem.key)) continue;
          const alreadyInNext = nextCart.some(
            (n) => isSameCartTitle(n.title, prevItem.title) || isSameCartTitle(n.key, prevItem.key)
          );
          if (alreadyInNext) continue;
          const itemUnits = clampQty(prevItem.quantity);
          if (explicitCount !== null && runningUnits + itemUnits > explicitCount) continue;
          nextCart.push(prevItem);
          runningUnits += itemUnits;
          if (prevItem.pending || (prevItem.score === null && !prevItem.isNonFood)) {
            toAudit.push(prevItem);
          }
        }
      }
    }

    if (nextCart.length !== state.cartItems.length) {
      changed = true;
    } else {
      for (let i = 0; i < nextCart.length; i++) {
        if (nextCart[i]?.key !== state.cartItems[i]?.key) {
          changed = true;
          break;
        }
      }
    }

    if (changed) {
      state.cartItems = nextCart.slice(0, MAX_CART_ITEMS);
      state.displayedAvg = calcCartAvg();
      saveBucketCart();
      render();
    }

    if (toAudit.length > 0) {
      void auditCartItemsBatch(toAudit.map((i) => i.title));
    }
    return true;
  }

  let cartAuditInFlight = false;
  let auditDirtyPending = false;
  let auditPendingForceAll = false;
  const auditPendingTitles = new Set();

  function findCartItemIndexBySnapshot(items, snap) {
    if (!Array.isArray(items) || !snap) return -1;
    return items.findIndex(
      (c) =>
        (snap.normKey &&
          (normalizeTitleForMatch(c.key) === snap.normKey ||
            normalizeTitleForMatch(c.title) === snap.normKey)) ||
        isSameCartTitle(c.title, snap.title) ||
        isSameCartTitle(c.key, snap.key)
    );
  }

  async function auditCartItemsBatch(titlesToAudit = [], forceAll = false) {
    if (forceAll) auditPendingForceAll = true;
    if (Array.isArray(titlesToAudit)) {
      for (const t of titlesToAudit) {
        if (t) auditPendingTitles.add(t);
      }
    }
    if (cartAuditInFlight) {
      auditDirtyPending = true;
      return;
    }

    const useForceAll = forceAll || auditPendingForceAll;
    const queuedTitles = [...auditPendingTitles];
    auditPendingForceAll = false;
    auditPendingTitles.clear();

    const capturedBucketObj = resolveStoreBucket();
    const capturedBucket = capturedBucketObj.bucketKey;

    const targetItems = useForceAll
      ? state.cartItems.filter((c) => !isCartItemDismissed(c.title) && !isCartItemDismissed(c.key))
      : state.cartItems.filter(
          (c) =>
            !isCartItemDismissed(c.title) &&
            !isCartItemDismissed(c.key) &&
            (queuedTitles.length > 0
              ? queuedTitles.some((t) => isSameCartTitle(c.title, t) || isSameCartTitle(c.key, t))
              : c.pending || (c.score === null && !c.isNonFood))
        );

    const requestSnapshots = targetItems.slice(0, MAX_CART_ITEMS).map((item) => ({
      key: item.key,
      title: item.title,
      normKey: normalizeTitleForMatch(item.key || item.title),
      quantity: clampQty(item.quantity),
    }));
    if (requestSnapshots.length === 0) return;

    cartAuditInFlight = true;
    const payload = {
      store: capturedBucketObj.store,
      instacartRetailerSlug: capturedBucketObj.instacartRetailerSlug,
      items: requestSnapshots.map((snap) => ({
        productTitle: snap.title,
        quantity: snap.quantity,
        instacartRetailerSlug: capturedBucketObj.instacartRetailerSlug,
      })),
    };

    try {
      const resp = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: "CLEANCART_AUDIT", payload }, (r) => {
            resolve(r || null);
          });
        } catch {
          resolve(null);
        }
      });

      if (
        !resp?.ok ||
        !Array.isArray(resp.results) ||
        resolveStoreBucket().bucketKey !== capturedBucket ||
        activeBucket.bucketKey !== capturedBucket
      ) {
        return;
      }

      let mutatedAny = false;
      for (let i = 0; i < requestSnapshots.length && i < resp.results.length; i++) {
        if (resolveStoreBucket().bucketKey !== capturedBucket || activeBucket.bucketKey !== capturedBucket) {
          return;
        }
        const snap = requestSnapshots[i];
        if (isCartKeyDismissed(snap.normKey) || isCartItemDismissed(snap.title)) continue;

        const scanRes = resp.results[i];
        if (!scanRes?.ok) {
          const failIdx = findCartItemIndexBySnapshot(state.cartItems, snap);
          if (failIdx === -1) continue;
          state.cartItems[failIdx] = {
            ...state.cartItems[failIdx],
            pending: false,
            isNonFood: true,
            score: null,
          };
          mutatedAny = true;
          continue;
        }

        const isNonFood =
          scanRes.product?.nutrition?.productKind === "non-food" ||
          scanRes.result?.yukaBreakdown?.nutriScoreGrade === "N/A";

        const candidates = Array.isArray(scanRes.swapCandidates) && scanRes.swapCandidates.length
          ? scanRes.swapCandidates
          : scanRes.swap
            ? [scanRes.swap]
            : [];

        let chosenSwap = scanRes.swap || null;
        let swapOutOfStock = false;
        if (candidates.length > 0 && !isNonFood && scanRes.result?.score < 75) {
          const stockRes = await resolveFirstInStockSwap(candidates, scanRes.swap, capturedBucket);
          if (resolveStoreBucket().bucketKey !== capturedBucket || activeBucket.bucketKey !== capturedBucket) {
            return;
          }
          if (isCartKeyDismissed(snap.normKey) || isCartItemDismissed(snap.title)) {
            continue;
          }
          chosenSwap = stockRes.chosen;
          swapOutOfStock = stockRes.allOutOfStock;
        }

        // Re-lookup live index AFTER awaits so an item deleted mid-audit is never resurrected or written onto a neighbor
        const liveIdx = findCartItemIndexBySnapshot(state.cartItems, snap);
        if (liveIdx === -1) continue;
        const cur = state.cartItems[liveIdx];
        if (!cur) continue;

        const serverVerifiedImg =
          scanRes.product?.imageUrl && !isPlaceholderProductImage(scanRes.product.imageUrl)
            ? scanRes.product.imageUrl
            : null;

        state.cartItems[liveIdx] = {
          ...cur,
          title: cur.title || scanRes.product?.title,
          image: cur.image || serverVerifiedImg || null,
          domImageUrl: cur.domImageUrl || null,
          score: isNonFood ? null : scanRes.result.score,
          pending: false,
          isNonFood,
          dietaryAlerts: Array.isArray(scanRes.dietaryAlerts) ? scanRes.dietaryAlerts : [],
          swapTitle: chosenSwap?.title || null,
          swapScore: chosenSwap?.score ?? null,
          swapUrl: chosenSwap?.webUrl || null,
          swapImage: chosenSwap?.image || null,
          swapIsPaidLink: Boolean(chosenSwap?.isPaidLink),
          swapInStock: Boolean(chosenSwap?.inStock),
          swapOutOfStock,
          swapCandidates: candidates,
        };
        mutatedAny = true;
      }

      if (mutatedAny && resolveStoreBucket().bucketKey === capturedBucket) {
        state.displayedAvg = calcCartAvg();
        saveBucketCart();
        render();
      }
    } catch {
      /* ignore transient runtime messaging errors */
    } finally {
      cartAuditInFlight = false;
      if (auditDirtyPending) {
        auditDirtyPending = false;
        void auditCartItemsBatch([...auditPendingTitles], auditPendingForceAll);
      }
    }
  }

  function matchesPendingSwapTitle(title) {
    if (!state.pendingSwap?.toTitle || !title) return false;
    return isSameCartTitle(title, state.pendingSwap.toTitle);
  }

  async function recordProductInCart(resp, fallbackTitle, addQty = 1, productImg = null) {
    if (!resp?.ok || !resp.result) return;
    const capturedBucket = resolveStoreBucket().bucketKey;
    const isNonFood =
      resp.product?.nutrition?.productKind === "non-food" ||
      resp.result?.yukaBreakdown?.nutriScoreGrade === "N/A";
    const prevAvg = calcCartAvg();
    const itemKey = (fallbackTitle || resp.product?.title || "").trim();
    if (!itemKey) return;

    clearCartItemDismissed(itemKey);
    if (resp.product?.title) clearCartItemDismissed(resp.product.title);

    let swappedInCart = false;
    if (matchesPendingSwapTitle(itemKey)) {
      const fromKey = state.pendingSwap?.fromKey;
      if (fromKey) {
        markCartItemDismissed(fromKey);
        state.cartItems = state.cartItems.filter((i) => !isSameCartTitle(i.key, fromKey) && !isSameCartTitle(i.title, fromKey));
      }
      state.pendingSwap = null;
      swappedInCart = true;
    }

    const candidates = Array.isArray(resp.swapCandidates) && resp.swapCandidates.length
      ? resp.swapCandidates
      : resp.swap
        ? [resp.swap]
        : [];
    let chosenSwap = state.activeSwap || null;
    let swapOutOfStock = Boolean(state.allSwapsOutOfStock);
    if (!chosenSwap && !swapOutOfStock && !isNonFood && candidates.length > 0 && resp.result?.score < 75) {
      const stockRes = await resolveFirstInStockSwap(candidates, resp.swap, capturedBucket);
      if (resolveStoreBucket().bucketKey !== capturedBucket || activeBucket.bucketKey !== capturedBucket) return;
      if (isCartItemDismissed(itemKey)) return;
      chosenSwap = stockRes.chosen;
      swapOutOfStock = stockRes.allOutOfStock;
    }

    const domImgClean = sanitizeDomImageUrl(productImg) || null;
    const serverImgClean =
      resp.product?.imageUrl && !isPlaceholderProductImage(resp.product.imageUrl)
        ? resp.product.imageUrl
        : null;

    const existingIdx = state.cartItems.findIndex(
      (i) => isSameCartTitle(i.key, itemKey) || isSameCartTitle(i.title, itemKey)
    );
    if (existingIdx !== -1) {
      const existing = state.cartItems[existingIdx];
      state.cartItems[existingIdx] = {
        ...existing,
        quantity: clampQty((existing.quantity || 1) + addQty),
        score: isNonFood ? null : resp.result.score,
        pending: false,
        isNonFood,
        image: existing.image || serverImgClean || null,
        domImageUrl: domImgClean || existing.domImageUrl || null,
        dietaryAlerts: Array.isArray(resp.dietaryAlerts) ? resp.dietaryAlerts : [],
        swapTitle: chosenSwap?.title || null,
        swapScore: chosenSwap?.score ?? null,
        swapUrl: chosenSwap?.webUrl || null,
        swapImage: chosenSwap?.image || null,
        swapIsPaidLink: Boolean(chosenSwap?.isPaidLink),
        swapInStock: Boolean(chosenSwap?.inStock),
        swapOutOfStock: Boolean(swapOutOfStock),
        swapCandidates: candidates,
      };
    } else {
      state.cartItems.unshift({
        key: itemKey,
        title: resp.product?.title || itemKey,
        quantity: clampQty(addQty),
        image: serverImgClean || null,
        domImageUrl: domImgClean,
        score: isNonFood ? null : resp.result.score,
        pending: false,
        isNonFood,
        dietaryAlerts: Array.isArray(resp.dietaryAlerts) ? resp.dietaryAlerts : [],
        swapTitle: chosenSwap?.title || null,
        swapScore: chosenSwap?.score ?? null,
        swapUrl: chosenSwap?.webUrl || null,
        swapImage: chosenSwap?.image || null,
        swapIsPaidLink: Boolean(chosenSwap?.isPaidLink),
        swapInStock: Boolean(chosenSwap?.inStock),
        swapOutOfStock: Boolean(swapOutOfStock),
        swapCandidates: candidates,
      });
      state.cartItems = state.cartItems.slice(0, MAX_CART_ITEMS);
    }

    saveBucketCart();
    const nextAvg = calcCartAvg();
    if (swappedInCart && prevAvg !== null && nextAvg !== null && nextAvg > prevAvg) {
      animateCartAvgTo(nextAvg);
    } else {
      state.displayedAvg = nextAvg;
      render();
    }
  }

  function removeCartItemByTitle(targetTitle) {
    if (!targetTitle) return;
    markCartItemDismissed(targetTitle);
    const before = state.cartItems.length;
    state.cartItems = state.cartItems.filter(
      (item) => !isSameCartTitle(item.title, targetTitle) && !isSameCartTitle(item.key, targetTitle)
    );
    if (state.cartItems.length !== before) {
      state.displayedAvg = calcCartAvg();
      saveBucketCart();
      render();
    }
  }

  function adjustCartItemQtyByTitle(targetTitle, delta) {
    if (!targetTitle) return false;
    const idx = state.cartItems.findIndex(
      (item) => isSameCartTitle(item.title, targetTitle) || isSameCartTitle(item.key, targetTitle)
    );
    if (idx === -1) return false;
    const nextQty = (state.cartItems[idx].quantity || 1) + delta;
    if (nextQty <= 0) {
      markCartItemDismissed(state.cartItems[idx].key);
      markCartItemDismissed(state.cartItems[idx].title);
      state.cartItems.splice(idx, 1);
    } else {
      state.cartItems[idx].quantity = clampQty(nextQty);
    }
    state.displayedAvg = calcCartAvg();
    saveBucketCart();
    render();
    return true;
  }

  function setCartItemQtyByTitle(targetTitle, exactQty) {
    if (!targetTitle) return false;
    const idx = state.cartItems.findIndex(
      (item) => isSameCartTitle(item.title, targetTitle) || isSameCartTitle(item.key, targetTitle)
    );
    if (idx === -1) return false;
    if (exactQty <= 0) {
      markCartItemDismissed(state.cartItems[idx].key);
      markCartItemDismissed(state.cartItems[idx].title);
      state.cartItems.splice(idx, 1);
    } else {
      clearCartItemDismissed(targetTitle);
      state.cartItems[idx].quantity = clampQty(exactQty);
    }
    state.displayedAvg = calcCartAvg();
    saveBucketCart();
    render();
    return true;
  }

  /* ---------------- Capture-Phase Store Click & Quantity Change Listeners ---------------- */
  document.addEventListener(
    "change",
    (e) => {
      if (host?.contains(e.target)) return;
      const ctrl = e.target?.closest?.(
        'select, input[type="number"], input[role="spinbutton"], input[name*="quantity" i], input[aria-label*="quantity" i]'
      );
      if (!ctrl) return;
      const rowContainer = ctrl.closest(
        '[data-test="cartItem"], [data-qa*="cart-item" i], .sc-list-item-content, div[data-asin], [data-testid*="cart-item" i], [data-testid*="line-item" i], [data-automation-id*="cart-item" i], [data-item-id], li, article'
      );
      const cartRoot = detectOpenCartRoot();
      if (!rowContainer && (!cartRoot || !cartRoot.contains(ctrl))) return;

      const rawVal = String(ctrl.value ?? "").trim();
      const numMatch = rawVal.match(/^\d+$/) || rawVal.match(/\b(\d{1,2})\b/);
      const parsedQty = numMatch ? Number(numMatch[1]) : NaN;
      const rowInfo = rowContainer ? extractRowTitleAndImage(rowContainer) : null;

      if (Number.isFinite(parsedQty) && rowInfo?.title) {
        if (parsedQty <= 0) {
          removeCartItemByTitle(rowInfo.title);
        } else {
          setCartItemQtyByTitle(rowInfo.title, parsedQty);
        }
      }
      scheduleCartSync(260);
    },
    true
  );

  document.addEventListener(
    "click",
    (e) => {
      if (host?.contains(e.target)) return;
      const btn = e.target?.closest?.('button, [role="button"], input[type="submit"], input[type="button"], a[role="button"]');
      if (!btn) return;

      const label = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""} ${btn.getAttribute("data-testid") || ""} ${btn.getAttribute("data-test") || ""} ${btn.getAttribute("data-qa") || ""} ${btn.getAttribute("data-automation-id") || ""} ${btn.value || ""}`
        .replace(/\s+/g, " ")
        .trim();

      const rowContainer = btn.closest(
        '[data-test="cartItem"], [data-qa*="cart-item" i], .sc-list-item-content, div[data-asin], [data-testid*="cart-item" i], [data-testid*="line-item" i], [data-automation-id*="cart-item" i], [data-item-id], [data-testid*="product-card" i], [data-testid*="item-card" i], li, article'
      );
      const rowInfo = rowContainer ? extractRowTitleAndImage(rowContainer) : null;
      const contextTitle = rowInfo?.title || readTitle();

      // 1. Explicit Remove / Delete / Trash / Save for Later in cart or card
      const isHardRemove =
        !/\bundo\b/i.test(label) &&
        (/\b(remove(?:\s+item|\s+from\s+cart)?|delete(?:\s+item)?|cartitem-deletebtn|save\s+for\s+later|trash)\b/i.test(label) ||
          Boolean(btn.querySelector('svg[data-testid*="trash" i], svg[data-testid*="delete" i], [class*="trash" i]')));
      if (isHardRemove && contextTitle) {
        removeCartItemByTitle(contextTitle);
        scheduleCartSync(650);
        return;
      }

      // 2. Stepper Decrease ("-" / "decrease quantity")
      const btnTextTrim = (btn.textContent || "").trim();
      const isDecrement =
        btnTextTrim === "-" ||
        btnTextTrim === "−" ||
        /\b(decrease|decrement|minus|subtract|reduce\s+quantity|remove\s+one)\b/i.test(label);
      if (isDecrement && contextTitle) {
        const currentDomQty = rowContainer ? extractRowQuantity(rowContainer) : null;
        if (currentDomQty === 1) {
          removeCartItemByTitle(contextTitle);
        } else {
          adjustCartItemQtyByTitle(contextTitle, -1);
        }
        scheduleCartSync(650);
        return;
      }

      // 3. Explicit "Add to Cart" OR "+" Increment button
      const isExplicitAdd = /\b(add\s+to\s+(?:cart|bag|basket|order)|add\s+item)\b/i.test(label);
      const isIncrement =
        btnTextTrim === "+" || /\b(increase|increment|plus|add\s+one)\b/i.test(label);

      if (isExplicitAdd || isIncrement) {
        if (contextTitle) clearCartItemDismissed(contextTitle);
        // If on active PDP / modal and current scanned item matches
        if (isProductPage() && state.data?.ok) {
          const modalOrDoc = activeDialogScope();
          const pdpTitle = readTitle(modalOrDoc);
          if (pdpTitle) clearCartItemDismissed(pdpTitle);
          if (!rowContainer || (modalOrDoc && modalOrDoc.contains(btn)) || isSameCartTitle(contextTitle, state.data.product?.title)) {
            void recordProductInCart(state.data, pdpTitle, 1, readProductImage(modalOrDoc));
            return;
          }
        }
        // Increment existing cart item or add from product grid card!
        if (contextTitle) {
          if (isIncrement && adjustCartItemQtyByTitle(contextTitle, 1)) {
            scheduleCartSync(500);
            return;
          }
          const addBucket = resolveStoreBucket();
          // Added directly from grid/search tile: scan & insert into active store cart!
          chrome.runtime.sendMessage(
            {
              type: "CLEANCART_SCAN",
              payload: {
                productTitle: contextTitle,
                store: addBucket.store,
                instacartRetailerSlug: addBucket.instacartRetailerSlug,
              },
            },
            (resp) => {
              if (resp?.ok && resolveStoreBucket().bucketKey === addBucket.bucketKey) {
                void recordProductInCart(resp, contextTitle, 1, rowInfo?.domImageUrl || rowInfo?.image || null);
              }
            }
          );
        }
      }
    },
    true
  );

  /* ---------------- Shadow DOM Host (Zero-FOUC Inline Critical CSS + Persistent Pill) ---------------- */
  const INLINE_CRITICAL_CSS = `
    :host { all: initial; }
    .cc-root { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-variant-numeric: tabular-nums; color: #0f172a; -webkit-font-smoothing: antialiased; }
    .cc-root *, .cc-root *::before, .cc-root *::after { box-sizing: border-box; }
    .cc-root button { font: inherit; border: 0; background: none; cursor: pointer; color: inherit; padding: 0; }
    .cc-root [hidden] { display: none !important; }
    .cc-tone-green { --tone: #16a34a; --tone-bright: #4ade80; --tone-tint: #e8f7ee; }
    .cc-tone-yellow { --tone: #ca8a04; --tone-bright: #facc15; --tone-tint: #fef7e0; }
    .cc-tone-red { --tone: #dc2626; --tone-bright: #f87171; --tone-tint: #fdecec; }
    .cc-tone-gray { --tone: #64748b; --tone-bright: #94a3b8; --tone-tint: #e2e8f0; }
    .cc-pill { position: fixed; right: 0; z-index: 2147483646; transform: translateY(-50%); display: flex; align-items: center; gap: 9px; max-width: 340px; padding: 8px 13px 8px 10px; border-radius: 999px 0 0 999px; background: rgba(15,23,20,.95); color: #f8fafc; font-size: 13px; line-height: 1.2; box-shadow: 0 12px 32px -8px rgba(0,0,0,.52); cursor: grab; user-select: none; touch-action: none; }
    .cc-pill-mascot { width: 26px; height: 26px; border-radius: 8px; object-fit: contain; background: #fff; padding: 1px; flex: none; }
    .cc-mini-ring { position: relative; width: 28px; height: 28px; flex: none; }
    .cc-mini-ring svg { width: 100%; height: 100%; display: block; }
    .cc-mini-ring-track { fill: none; stroke: rgba(255,255,255,.16); stroke-width: 3.4; }
    .cc-mini-ring-fill { fill: none; stroke: var(--tone-bright); stroke-width: 3.4; stroke-linecap: round; }
    .cc-mini-ring-val { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 10.5px; font-weight: 800; color: #fff; }
    .cc-backdrop { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: flex-end; justify-content: center; background: rgba(15,23,42,.42); }
    .cc-card { width: min(430px, calc(100vw - 20px)); max-height: min(78vh, 560px); overflow-y: auto; -webkit-overflow-scrolling: touch; margin: 10px; padding: 18px; border-radius: 24px; background: #fff; box-shadow: 0 24px 54px -12px rgba(15,23,42,.36); }
    .cc-hide-drop { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 2147483646; padding: 10px 18px; border-radius: 999px; font-size: 12.5px; font-weight: 800; background: rgba(15,23,20,.92); color: #fecaca; border: 1.5px dashed rgba(248,113,113,.75); pointer-events: none; }
    .cc-hide-drop.is-hot { background: #dc2626; color: #fff; border-style: solid; }
    .cc-thumb-empty { background: #F4F5F7 !important; border: 1px solid #E5E7EB !important; display: inline-flex !important; align-items: center; justify-content: center; color: #9CA3AF; padding: 0 !important; flex: none; }
    .cc-prod-thumb.cc-thumb-empty { width: 44px; height: 44px; border-radius: 10px; }
    .cc-row-thumb.cc-thumb-empty, .cc-cart-thumb.cc-thumb-empty { width: 36px; height: 36px; border-radius: 8px; }
    .cc-swap-thumb.cc-thumb-empty { width: 42px; height: 42px; border-radius: 10px; }
  `;

  const host = document.createElement("div");
  host.id = "cleancart-overlay-host";
  const shadow = host.attachShadow({ mode: "open" });

  const inlineStyle = document.createElement("style");
  inlineStyle.id = "heybroc-inline-css";
  inlineStyle.textContent = INLINE_CRITICAL_CSS;

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("overlay.css");

  const mascotUrl = chrome.runtime.getURL("broc-mascot.png");
  const root = document.createElement("div");
  root.className = "cc-root";

  // Persistent Pill + Hide Drop + Modal Slot (prevents re-triggering cc-in animation on updates!)
  const MINI_R = 11.5;
  const MINI_C = 2 * Math.PI * MINI_R;
  const pillEl = document.createElement("div");
  pillEl.className = "cc-pill cc-tone-gray cc-enter";
  pillEl.setAttribute("role", "button");
  pillEl.setAttribute("tabindex", "0");
  pillEl.hidden = true;
  pillEl.innerHTML = `
    <img class="cc-pill-mascot" src="${mascotUrl}" alt="" />
    <div class="cc-mini-ring">
      <svg viewBox="0 0 28 28">
        <circle cx="14" cy="14" r="${MINI_R}" class="cc-mini-ring-track"></circle>
        <circle cx="14" cy="14" r="${MINI_R}" class="cc-mini-ring-fill" stroke-dasharray="${MINI_C.toFixed(2)}" stroke-dashoffset="${MINI_C.toFixed(2)}" transform="rotate(-90 14 14)"></circle>
      </svg>
      <span class="cc-mini-ring-val">--</span>
    </div>
    <div class="cc-pill-copy">
      <div class="cc-pill-primary"></div>
      <div class="cc-pill-sub"></div>
    </div>
  `;
  pillEl.addEventListener("animationend", () => pillEl.classList.remove("cc-enter"), { once: true });

  const hideDropEl = document.createElement("div");
  hideDropEl.className = "cc-hide-drop";
  hideDropEl.textContent = "✕ Drag here to hide for this trip";
  hideDropEl.hidden = true;

  const modalSlot = document.createElement("div");
  modalSlot.className = "cc-modal-slot";

  root.append(pillEl, hideDropEl, modalSlot);
  shadow.append(inlineStyle, link, root);

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function buildThumbMarkup(className, verifiedUrl, domImageUrl, lazy = false) {
    const hasVerified = Boolean(verifiedUrl && !isPlaceholderProductImage(verifiedUrl));
    const cleanDom = sanitizeDomImageUrl(domImageUrl);
    if (hasVerified) {
      return `<img class="${className}" src="${esc(verifiedUrl)}"${
        cleanDom ? ` data-dom-fallback="${esc(cleanDom)}"` : ""
      } referrerpolicy="no-referrer" alt=""${lazy ? ' loading="lazy"' : ""} />`;
    }
    if (cleanDom) {
      return `<img class="${className}" src="${esc(cleanDom)}" referrerpolicy="no-referrer" alt=""${
        lazy ? ' loading="lazy"' : ""
      } />`;
    }
    return `<div class="${className} cc-thumb-empty" aria-hidden="true">${NEUTRAL_THUMB_SVG}</div>`;
  }

  function handleThumbFallback(imgEl) {
    if (!imgEl || !imgEl.isConnected) return;
    const domFallback = sanitizeDomImageUrl(imgEl.getAttribute("data-dom-fallback") || "");
    const curSrc = imgEl.getAttribute("src") || "";
    if (domFallback && imgEl.dataset.triedDomFallback !== "1" && curSrc !== domFallback) {
      imgEl.dataset.triedDomFallback = "1";
      imgEl.setAttribute("referrerpolicy", "no-referrer");
      imgEl.setAttribute("src", domFallback);
      return;
    }
    const neutralBox = document.createElement("div");
    neutralBox.className = `${imgEl.className || "cc-prod-thumb"} cc-thumb-empty`;
    neutralBox.setAttribute("aria-hidden", "true");
    neutralBox.innerHTML = NEUTRAL_THUMB_SVG;
    imgEl.replaceWith(neutralBox);
  }

  function attachModalThumbHandlers() {
    const thumbs = modalSlot.querySelectorAll("img.cc-prod-thumb, img.cc-cart-thumb, img.cc-swap-thumb");
    for (const img of thumbs) {
      img.onerror = () => handleThumbFallback(img);
      const src = img.getAttribute("src") || "";
      if (src.includes("/api/product-image")) {
        void checkApiImageIsPlaceholder(src).then((isPh) => {
          if (isPh && img.isConnected && (img.getAttribute("src") || "") === src) {
            handleThumbFallback(img);
          }
        });
      }
    }
  }

  root.addEventListener(
    "error",
    (e) => {
      const target = e.target;
      if (
        target?.tagName === "IMG" &&
        (target.classList.contains("cc-prod-thumb") ||
          target.classList.contains("cc-cart-thumb") ||
          target.classList.contains("cc-swap-thumb"))
      ) {
        handleThumbFallback(target);
      }
    },
    true
  );

  /* ---------------- Persistent Pill Drag + PointerCancel + Escape Handling ---------------- */
  (() => {
    let startY = 0;
    let startX = 0;
    let startPct = 50;
    let moved = false;
    let activePointerId = null;

    function finishDrag(cancelled) {
      const dropHide = !cancelled && state.overHide;
      state.dragging = false;
      state.overHide = false;
      pillEl.classList.remove("is-dragging");
      pillEl.style.transform = "translateY(-50%)";
      hideDropEl.hidden = true;
      hideDropEl.classList.remove("is-hot");
      activePointerId = null;

      if (dropHide) {
        try { sessionStorage.setItem(hideKeyForBucket(activeBucket.bucketKey), "1"); } catch { /* ignore */ }
        render();
        return;
      }
      if (!cancelled && !moved) {
        const act = pillEl.dataset.act;
        if (act === "open-auditor") {
          state.auditorOpen = true;
          state.expanded = false;
          state.drawerTab = "cart";
        } else {
          state.expanded = true;
          state.auditorOpen = false;
          state.drawerTab = "product";
        }
        render();
      }
    }

    pillEl.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      activePointerId = e.pointerId;
      try { pillEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      startY = e.clientY;
      startX = e.clientX;
      startPct = state.y;
      moved = false;
      state.dragging = true;
      state.overHide = false;
      pillEl.classList.add("is-dragging");
      hideDropEl.hidden = false;
      hideDropEl.classList.remove("is-hot");
    });

    pillEl.addEventListener("pointermove", (e) => {
      if (activePointerId !== e.pointerId) return;
      const dy = e.clientY - startY;
      const dx = e.clientX - startX;
      if (Math.hypot(dx, dy) > 5) moved = true;
      state.y = Math.max(8, Math.min(92, startPct + (dy / Math.max(300, window.innerHeight)) * 100));
      pillEl.style.top = `${state.y}%`;
      pillEl.style.transform = `translate(${Math.min(0, dx)}px, -50%)`;
      state.overHide =
        e.clientY > window.innerHeight * 0.8 &&
        e.clientX > window.innerWidth * 0.22 &&
        e.clientX < window.innerWidth * 0.78;
      hideDropEl.classList.toggle("is-hot", state.overHide);
    });

    pillEl.addEventListener("pointerup", (e) => {
      if (activePointerId !== e.pointerId) return;
      try { pillEl.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      finishDrag(false);
    });

    pillEl.addEventListener("pointercancel", (e) => {
      if (activePointerId !== e.pointerId) return;
      finishDrag(true);
    });
  })();

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (state.expanded || state.auditorOpen)) {
      state.expanded = false;
      state.auditorOpen = false;
      render();
    }
  });

  /* ---------------- UI Rendering ---------------- */
  function updatePillElement({ visible, tone, ringValue, ringPercent, act, primaryHtml, subHtml }) {
    if (!visible) {
      pillEl.hidden = true;
      return;
    }
    pillEl.hidden = false;
    if (!state.dragging) {
      pillEl.style.top = `${state.y}%`;
    }
    pillEl.dataset.act = act || "open-auditor";
    pillEl.classList.remove("cc-tone-green", "cc-tone-yellow", "cc-tone-red", "cc-tone-gray");
    pillEl.classList.add(`cc-tone-${tone}`);

    const ringFill = pillEl.querySelector(".cc-mini-ring-fill");
    const ringValEl = pillEl.querySelector(".cc-mini-ring-val");
    const primaryEl = pillEl.querySelector(".cc-pill-primary");
    const subEl = pillEl.querySelector(".cc-pill-sub");

    const pct = ringPercent === null || ringPercent === undefined ? 0 : Math.max(0, Math.min(100, Number(ringPercent)));
    if (ringFill) {
      ringFill.setAttribute("stroke-dashoffset", (MINI_C * (1 - pct / 100)).toFixed(2));
    }
    if (ringValEl) ringValEl.textContent = ringValue;
    if (primaryEl) primaryEl.innerHTML = primaryHtml;
    if (subEl) {
      subEl.innerHTML = subHtml || "";
      subEl.hidden = !subHtml;
    }
  }

  function renderCartTabBody(avg, avgTone) {
    const C = 2 * Math.PI * 42;
    const hasAvg = avg !== null && avg !== undefined;
    const projected = calcProjectedAvgAfterSwaps();
    const totalUnits = totalCartUnits();
    const itemWord = state.cartItems.length === 1 ? "1 item" : `${state.cartItems.length} items`;
    const unitPart = totalUnits !== state.cartItems.length ? ` · ${totalUnits} units` : "";

    const rowsHtml = state.cartItems.length
      ? state.cartItems
          .map((item, idx) => {
            const hasScore = isScoredCartItem(item);
            const rowTone = hasScore ? toneForScore(item.score) : "gray";
            const chipLabel = item.pending ? "…" : item.isNonFood ? "N/A" : hasScore ? String(item.score) : "--";
            const thumbHtml = buildThumbMarkup("cc-row-thumb cc-cart-thumb", item.image, item.domImageUrl, true);
            const qty = clampQty(item.quantity);
            const alertBadges = Array.isArray(item.dietaryAlerts) && item.dietaryAlerts.length
              ? ` · ⚠️ ${item.dietaryAlerts.map((a) => esc(a.shortBadge)).join(", ")}`
              : "";

            let subLine = "";
            if (item.pending) {
              subLine = `<small>Scoring ingredients…</small>`;
            } else if (item.isNonFood) {
              subLine = `<small>Household / non-food — excluded from Cart Avg</small>`;
            } else if (hasScore && item.score < 75 && item.swapTitle && !item.swapOutOfStock) {
              subLine = `<small class="cc-swap-line">✓ In Stock Swap: ${esc(item.swapTitle)}${item.swapScore !== null ? ` (${esc(item.swapScore)}/100)` : ""}${item.swapIsPaidLink ? " · paid link" : ""}${alertBadges}</small>`;
            } else if (hasScore && item.score < 75 && item.swapOutOfStock) {
              subLine = `<small>No clean swap currently in stock at ${esc(activeBucket.label)}${alertBadges}</small>`;
            } else if (hasScore) {
              subLine = `<small>${esc(ratingLabelForScore(item.score))} pick${alertBadges}</small>`;
            }

            const showSwapBtn = hasScore && item.score < 75 && item.swapTitle && !item.swapOutOfStock;

            return `<li class="cc-audit-row">
              ${thumbHtml}
              <div class="cc-row-main">
                <div class="cc-row-title-line">
                  <b>${esc(item.title)}</b>
                  ${qty > 1 ? `<span class="cc-qty-badge">×${qty}</span>` : ""}
                </div>
                ${subLine}
              </div>
              <span class="cc-chip cc-tone-${rowTone}">${esc(chipLabel)}</span>
              ${showSwapBtn ? `<button class="cc-mini-swap" data-swap-idx="${idx}">${item.swapUrl ? "Swap" : "🔒 Pro"}</button>` : ""}
              <button class="cc-row-remove" data-remove-idx="${idx}" title="Remove from ${esc(activeBucket.label)} cart" aria-label="Remove item">✕</button>
            </li>`;
          })
          .join("")
      : `<li class="cc-audit-row"><div class="cc-row-main"><b>Your ${esc(activeBucket.label)} cart is empty</b><small>Add groceries to your store cart or open your cart drawer to sync live.</small></div></li>`;

    const firstDirtyIdx = state.cartItems.findIndex(
      (i) => isScoredCartItem(i) && i.score < 75 && i.swapTitle && !i.swapOutOfStock
    );
    const firstDirty = firstDirtyIdx >= 0 ? state.cartItems[firstDirtyIdx] : null;

    return `
      <div class="cc-cart-hero ${avgTone}">
        <div class="cc-gauge">
          <svg viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="42" class="cc-track"></circle>
            <circle cx="50" cy="50" r="42" class="cc-fill" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${(hasAvg ? C * (1 - avg / 100) : C).toFixed(2)}" transform="rotate(-90 50 50)"></circle>
          </svg>
          <div class="cc-gauge-label">
            <strong>${hasAvg ? esc(avg) : "--"}${hasAvg ? "<span>/100</span>" : ""}</strong>
            <em>${hasAvg ? esc(ratingLabelForScore(avg)) : "Empty"}</em>
          </div>
        </div>
        <div class="cc-cart-stats">
          <h4>${hasAvg ? `Quantity-Weighted Avg: ${esc(avg)}/100` : "No Scored Food Items Yet"}</h4>
          <p>${state.cartItems.length ? `${esc(itemWord)}${esc(unitPart)} in ${esc(activeBucket.label)}` : `Each store keeps its own separate cart.`}</p>
          ${hasAvg && projected !== null && projected > avg ? `<span class="cc-projected-pill">✨ ${esc(projected)}/100 (+${esc(projected - avg)}) after Clean Swaps</span>` : ""}
        </div>
      </div>
      <div class="cc-audit-head">
        <span>${esc(activeBucket.label)} Items (${state.cartItems.length})</span>
        ${state.cartItems.length ? `<button class="cc-clear-btn" data-act="clear-cart">Clear cart</button>` : ""}
      </div>
      <ul class="cc-audit-list">${rowsHtml}</ul>
      ${
        firstDirty
          ? `<button class="cc-swap-btn cc-wide" data-swap-idx="${firstDirtyIdx}">${
              firstDirty.swapUrl
                ? `✓ In-Stock Swap: ${esc(firstDirty.swapTitle)} (${esc(firstDirty.swapScore)}/100)${firstDirty.swapIsPaidLink ? " · paid link" : ""}`
                : `⚡ Unlock Clean Swaps in ${esc(activeBucket.label)} ↗`
            }</button>`
          : hasAvg
            ? `<p class="cc-clean" style="margin-top:12px">✓ Every scored item in your ${esc(activeBucket.label)} cart is clean!</p>`
            : ""
      }
    `;
  }

  function renderProductTabBody(d) {
    if (!d?.ok || !d.result) {
      return `<p class="cc-product" style="margin-top:12px">${esc(d?.error || "Select a food product to inspect its ingredients.")}</p>`;
    }
    const r = d.result;
    const isNonFood =
      d.product?.nutrition?.productKind === "non-food" || r.yukaBreakdown?.nutriScoreGrade === "N/A";
    const safeScore = Math.max(0, Math.min(100, Math.round(Number(r.score ?? 0))));
    const C = 2 * Math.PI * 42;
    const prodThumbHtml = buildThumbMarkup(
      "cc-prod-thumb",
      d.product?.imageUrl,
      state.lastDomProductImageUrl,
      false
    );

    const srcKey = d.lookup?.origin || d.lookup?.source || "catalog";
    const srcName = srcKey === "screen" ? "Store page ingredients"
      : srcKey === "openfoodfacts" ? "Open Food Facts"
      : srcKey === "usda" ? "USDA FoodData Central"
      : "Verified US label catalog";
    const updatedVal = d.lookup?.sourceUpdatedAt;
    const updatedPart = updatedVal ? ` · ${esc(updatedVal)}` : "";
    const reportHref = `mailto:support@heybroc.com?subject=${encodeURIComponent(`Label mismatch: ${d.product?.title || ""}`)}`;

    const dietAlertsHtml = Array.isArray(d.dietaryAlerts) && d.dietaryAlerts.length
      ? `<div class="cc-flags">${d.dietaryAlerts.map((a) => `<span class="cc-diet-chip" title="${esc(a.reason)}">${esc(a.label)}</span>`).join("")}</div>`
      : "";

    const flagsHtml = isNonFood
      ? `<p class="cc-meta-line">Household / non-food item — not scored as food.</p>`
      : r.flagged.length
        ? `<div class="cc-flags">${r.flagged
            .map(
              (f) =>
                `<button type="button" class="cc-flag cc-risk-${esc(f.risk)} ${state.openFlag === f.name ? "is-open" : ""}" data-flag="${esc(f.name)}">${esc(f.name)} ⚠️</button>`
            )
            .join("")}</div>`
        : `<p class="cc-clean">✓ 0 Watchlist Additives Found</p>`;

    const explainList = !isNonFood && r.flagged.length
      ? `<div class="cc-explain-list">${r.flagged
          .filter((f) => !state.openFlag || state.openFlag === f.name)
          .map(
            (f) =>
              `<div class="cc-explain cc-risk-${esc(f.risk)}"><b>${esc(f.name)}</b> <span>−${esc(f.penalty)} pts</span><p>${esc(f.explanation)}</p></div>`
          )
          .join("")}</div>`
      : "";

    const ingHtml = d.product?.ingredients && !isNonFood
      ? `<details class="cc-ing-box"><summary>Ingredients (${d.product.ingredients.split(",").length} listed)</summary><p>${esc(d.product.ingredients)}</p></details>`
      : "";

    let swapHtml = "";
    const activeSwap = state.activeSwap;
    if (!isNonFood && safeScore < 75) {
      if (state.swapStockChecking && !activeSwap) {
        swapHtml = `<div class="cc-swap cc-swap-muted"><div class="cc-swap-info"><b>Checking in-stock Clean Swaps at ${esc(activeBucket.label)}…</b><span class="cc-meta-line">Verifying live store availability</span></div></div>`;
      } else if (state.allSwapsOutOfStock) {
        swapHtml = `<div class="cc-swap cc-swap-muted"><div class="cc-swap-info"><b>No clean swap currently in stock at ${esc(activeBucket.label)}</b><span class="cc-meta-line">Out-of-stock alternatives were hidden automatically.</span></div></div>`;
      } else if (activeSwap) {
        const swapLocked = !activeSwap.webUrl;
        const swapPaidSuffix = !swapLocked && activeSwap.isPaidLink ? " · paid link" : "";
        const swapRating = ratingLabelForScore(activeSwap.score);
        const swapThumb =
          activeSwap.image && !isPlaceholderProductImage(activeSwap.image)
            ? activeSwap.image
            : fallbackThumbUrl(activeSwap.title);
        swapHtml = `<div class="cc-swap">
          ${buildThumbMarkup("cc-swap-thumb", swapThumb, null, true)}
          <div class="cc-swap-info">
            <div class="cc-swap-badges">
              ${swapLocked ? `<span class="cc-eyebrow">🔒 Swap Locked</span>` : `<span class="cc-instock-badge">✓ In Stock</span>`}
              <span class="cc-eyebrow" style="color:#065f46">${esc(activeBucket.label)}${esc(swapPaidSuffix)}</span>
            </div>
            <b>${esc(activeSwap.title)}</b>
            <span class="cc-swap-score">${esc(activeSwap.score)}/100 ${esc(swapRating)}${swapLocked ? " · Free swaps used" : ""}</span>
          </div>
          <button class="cc-swap-btn" data-act="swap">${swapLocked ? "⚡ Unlock Pro ↗" : `Swap Item`}</button>
        </div>`;
      }
    } else if (!isNonFood) {
      swapHtml = `<div class="cc-swap"><span class="cc-swap-ok">✓ Clean pick — no swap needed!</span></div>`;
    }

    return `
      <div class="cc-prod-hero">
        ${prodThumbHtml}
        <div style="min-width:0">
          <p class="cc-product">${esc(d.product.title)}</p>
          <p class="cc-meta-line">${esc(srcName)}${updatedPart} · <a href="${reportHref}" target="_blank" rel="noopener">Report mismatch</a></p>
        </div>
      </div>
      <div class="cc-body">
        <div class="cc-gauge">
          <svg viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="42" class="cc-track"></circle>
            <circle cx="50" cy="50" r="42" class="cc-fill" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${(isNonFood ? C : C * (1 - safeScore / 100)).toFixed(2)}" transform="rotate(-90 50 50)"></circle>
          </svg>
          <div class="cc-gauge-label">
            <strong>${isNonFood ? "N/A" : `${esc(safeScore)}<span>/100</span>`}</strong>
            <em>${isNonFood ? "Non-Food" : esc(ratingLabelForScore(safeScore))}</em>
          </div>
        </div>
        <div class="cc-summary-col">
          ${dietAlertsHtml}
          ${flagsHtml}
        </div>
      </div>
      ${explainList}
      ${ingHtml}
      ${swapHtml}
      <p class="cc-footnote">Informational opinion only — verify physical product label. HeyBroc is independent and not affiliated with ${esc(activeBucket.label)}.</p>
    `;
  }

  function render() {
    if (sessionStorage.getItem(hideKeyForBucket(activeBucket.bucketKey)) === "1") {
      pillEl.hidden = true;
      modalSlot.innerHTML = "";
      return;
    }

    const realAvg = calcCartAvg();
    const avg = state.displayedAvg !== null && state.displayedAvg !== undefined && realAvg !== null
      ? state.displayedAvg
      : realAvg;
    const avgTone = toneForScore(avg);
    const avgToneClass = `cc-tone-${avgTone}`;
    const totalUnits = totalCartUnits();
    const hasModalOpen = state.expanded || state.auditorOpen;

    // 1. Update Persistent Pill (hidden while modal drawer is open)
    if (hasModalOpen) {
      pillEl.hidden = true;
    } else if (state.mode === "product" && state.data?.ok && state.data.result) {
      const r = state.data.result;
      const isNonFood =
        state.data.product?.nutrition?.productKind === "non-food" ||
        r.yukaBreakdown?.nutriScoreGrade === "N/A";
      const safeScore = Math.max(0, Math.min(100, Math.round(Number(r.score ?? 0))));
      const prodTone = isNonFood ? "gray" : toneForScore(safeScore);
      const alertChip = Array.isArray(state.data.dietaryAlerts) && state.data.dietaryAlerts.length
        ? `<span class="cc-pill-alert">⚠️ ${esc(state.data.dietaryAlerts[0].shortBadge)}</span>`
        : "";
      const cartChip = avg !== null ? `Cart: ${esc(avg)}/100 (${totalUnits})` : `${esc(activeBucket.label)} Cart: --`;
      updatePillElement({
        visible: true,
        tone: prodTone,
        ringValue: isNonFood ? "N/A" : String(safeScore),
        ringPercent: isNonFood ? null : safeScore,
        act: "expand",
        primaryHtml: isNonFood
          ? `<span>Non-Food Item</span>`
          : `<b>${esc(safeScore)}/100</b><span>${esc(ratingLabelForScore(safeScore))}</span>${alertChip}`,
        subHtml: `${esc(cartChip)} · Tap to inspect`,
      });
    } else {
      const hasAvg = avg !== null && avg !== undefined;
      updatePillElement({
        visible: true,
        tone: avgTone,
        ringValue: hasAvg ? String(avg) : "--",
        ringPercent: hasAvg ? avg : null,
        act: "open-auditor",
        primaryHtml: `<span>${esc(activeBucket.label)}</span><b>${hasAvg ? `${esc(avg)}/100` : "--"}</b>`,
        subHtml: state.cartItems.length
          ? `${totalUnits} ${totalUnits === 1 ? "item" : "items"} · Tap to view cart`
          : `Cart empty · Tap to open`,
      });
    }

    // 2. Update Modal Drawer Slot when expanded or auditorOpen
    if (!hasModalOpen) {
      if (modalSlot.innerHTML !== "") modalSlot.innerHTML = "";
      return;
    }

    const canShowProductTab = Boolean(state.data?.ok && state.data.result);
    const activeTab = state.auditorOpen || !canShowProductTab ? "cart" : state.drawerTab;
    const cardToneClass =
      activeTab === "product" && canShowProductTab
        ? `cc-tone-${toneForScore(state.data.result.score)}`
        : avgToneClass;

    const tabsHtml = canShowProductTab
      ? `<div class="cc-tabs">
          <button type="button" class="cc-tab ${activeTab === "product" ? "is-active" : ""}" data-tab="product">Product Score</button>
          <button type="button" class="cc-tab ${activeTab === "cart" ? "is-active" : ""}" data-tab="cart">${esc(activeBucket.label)} Cart (${totalUnits})</button>
        </div>`
      : "";

    modalSlot.innerHTML = `<div class="cc-backdrop" data-act="collapse">
      <div class="cc-card ${cardToneClass}" role="dialog" aria-modal="true" aria-label="HeyBroc Health Insights">
        <div class="cc-head">
          <div class="cc-head-left">
            <img class="cc-head-mascot" src="${mascotUrl}" alt="HeyBroc" />
            <div class="cc-head-titles">
              <div class="cc-eyebrow-row">
                <span class="cc-eyebrow">HeyBroc</span>
                <span class="cc-store-pill">🛒 ${esc(activeBucket.label)}</span>
              </div>
              <h3>${activeTab === "cart" ? "Store Cart Check" : "Ingredient Insights"}</h3>
            </div>
          </div>
          <button type="button" class="cc-close" data-act="collapse" aria-label="Close">×</button>
        </div>
        ${tabsHtml}
        ${activeTab === "cart" ? renderCartTabBody(avg, avgToneClass) : renderProductTabBody(state.data)}
      </div>
    </div>`;
    attachModalThumbHandlers();
  }

  /* ---------------- Drawer & Pill Event Delegation ---------------- */
  root.addEventListener("click", (e) => {
    const removeBtn = e.target.closest("[data-remove-idx]");
    if (removeBtn) {
      const idx = Number(removeBtn.dataset.removeIdx);
      if (Number.isFinite(idx) && idx >= 0 && idx < state.cartItems.length) {
        const removedItem = state.cartItems[idx];
        if (removedItem) {
          markCartItemDismissed(removedItem.key);
          markCartItemDismissed(removedItem.title);
        }
        state.cartItems.splice(idx, 1);
        state.displayedAvg = calcCartAvg();
        saveBucketCart();
        render();
        if (removedItem) {
          clickNativeCartRemoveButton(removedItem.title || removedItem.key);
          scheduleCartSync(750);
        }
      }
      return;
    }

    const tabBtn = e.target.closest("[data-tab]");
    if (tabBtn) {
      const nextTab = tabBtn.dataset.tab;
      state.drawerTab = nextTab;
      state.auditorOpen = nextTab === "cart";
      state.expanded = nextTab === "product";
      render();
      return;
    }

    const swapIdxBtn = e.target.closest("[data-swap-idx]");
    if (swapIdxBtn) {
      const idx = Number(swapIdxBtn.dataset.swapIdx);
      const item = state.cartItems[idx];
      if (item) {
        if (!item.swapUrl) {
          window.open(buildWebActionUrl("upgrade"), "_blank", "noopener");
          return;
        }
        state.pendingSwap = { fromKey: item.key, toTitle: item.swapTitle };
        const cands = Array.isArray(item.swapCandidates) && item.swapCandidates.length
          ? item.swapCandidates
          : [{ title: item.swapTitle, score: item.swapScore, webUrl: item.swapUrl, isPaidLink: item.swapIsPaidLink }];
        savePendingSwapNavigation(item.key, cands, 0);
        try { chrome.runtime.sendMessage({ type: "CLEANCART_RECORD_SWAP", productKey: item.key }); } catch { /* ignore */ }
        window.open(item.swapUrl, "_blank", "noopener");
      }
      return;
    }

    const t = e.target.closest("[data-act],[data-flag]");
    if (!t) return;
    if (t.dataset.flag) {
      state.openFlag = state.openFlag === t.dataset.flag ? null : t.dataset.flag;
      render();
      return;
    }
    const act = t.dataset.act;
    if (act === "collapse" && (t === e.target || t.classList.contains("cc-close"))) {
      state.expanded = false;
      state.auditorOpen = false;
      render();
      return;
    }
    if (act === "clear-cart") {
      for (const item of state.cartItems) {
        markCartItemDismissed(item.key);
        markCartItemDismissed(item.title);
      }
      state.cartItems = [];
      state.displayedAvg = null;
      saveBucketCart();
      render();
      return;
    }
    if (act === "swap" && state.activeSwap) {
      if (!state.activeSwap.webUrl) {
        window.open(buildWebActionUrl("upgrade"), "_blank", "noopener");
        return;
      }
      const currentKey = state.data?.product?.title || readTitle();
      state.pendingSwap = { fromKey: currentKey, toTitle: state.activeSwap.title };
      const cands = state.activeSwapCandidates || [state.activeSwap];
      savePendingSwapNavigation(currentKey, cands, 0);
      try { chrome.runtime.sendMessage({ type: "CLEANCART_RECORD_SWAP", productKey: currentKey }); } catch { /* ignore */ }
      window.open(state.activeSwap.webUrl, "_blank", "noopener");
      state.expanded = false;
      render();
    }
  });

  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const t = e.target.closest('[role="button"][data-act]');
    if (!t) return;
    e.preventDefault();
    const act = t.dataset.act;
    if (act === "open-auditor") {
      state.auditorOpen = true;
      state.expanded = false;
      state.drawerTab = "cart";
      render();
    } else if (act === "expand") {
      state.expanded = true;
      state.auditorOpen = false;
      state.drawerTab = "product";
      render();
    }
  });

  /* ---------------- Scan Pipeline, Grid Card Hover & Stock Check ---------------- */
  let scanSeq = 0;
  const scanCache = new Map();

  function normCacheKey(title, rawIng) {
    return `${activeBucket.bucketKey}|${String(title || "").toLowerCase().replace(/\s+/g, " ").trim()}|${String(rawIng || "").trim()}`;
  }

  async function applyScanResult(resp, domImage = null, seq = scanSeq) {
    if (seq !== scanSeq) return;
    if (!resp?.ok) {
      state.mode = "cart_avg";
      state.lastDomProductImageUrl = null;
      state.expanded = false;
      state.openFlag = null;
      render();
      return;
    }
    state.lastDomProductImageUrl = sanitizeDomImageUrl(domImage) || null;
    const candidates = Array.isArray(resp.swapCandidates) && resp.swapCandidates.length
      ? resp.swapCandidates
      : resp.swap
        ? [resp.swap]
        : [];

    const willVerifyStock = Boolean(candidates.length > 0 && resp.result?.score < 75 && candidates[0]?.webUrl);
    state.mode = "product";
    state.data = resp;
    state.openFlag = null;
    state.activeSwap = willVerifyStock ? null : (resp.swap || null);
    state.activeSwapCandidates = candidates;
    state.allSwapsOutOfStock = false;
    state.swapStockChecking = willVerifyStock;
    render();

    if (state.swapStockChecking) {
      const checkForTitle = resp.product?.title;
      const bKey = resolveStoreBucket().bucketKey;
      const stockRes = await resolveFirstInStockSwap(candidates, resp.swap, bKey);
      if (seq !== scanSeq || state.pillMode === "cart_avg") return;
      if (state.data?.product?.title === checkForTitle && resolveStoreBucket().bucketKey === bKey) {
        state.swapStockChecking = false;
        state.activeSwap = stockRes.chosen;
        state.activeSwapCandidates = stockRes.remainingCandidates || candidates;
        state.allSwapsOutOfStock = stockRes.allOutOfStock;
        render();
      }
    }
  }

  async function scan() {
    await loadBucketCart(false);
    if (sessionStorage.getItem(hideKeyForBucket(activeBucket.bucketKey)) === "1") return;
    if (!host.isConnected) document.documentElement.appendChild(host);

    // Always sync live store cart if /cart or slide-out cart drawer is currently visible
    scrapeAndSyncLiveCart();

    const modalScope = activeDialogScope();
    if (!isProductPage()) {
      // On multi-product grid/search/aisle pages: keep hovered/focused card score if active, else show Cart Avg!
      if (!state.hoveredCardData && !state.expanded) {
        ++scanSeq;
        lastKey = "";
        state.mode = "cart_avg";
        state.lastDomProductImageUrl = null;
      }
      render();
      return;
    }

    state.hoveredCardData = null;
    const productTitle = readTitle(modalScope);
    if (!productTitle) {
      ++scanSeq;
      lastKey = "";
      state.mode = "cart_avg";
      state.lastDomProductImageUrl = null;
      render();
      return;
    }
    const rawIngredients = readIngredients(modalScope);
    const domImage = readProductImage(modalScope);
    const key = `${activeBucket.bucketKey}|${location.pathname}|${modalScope ? "modal" : "pdp"}|${productTitle}|${rawIngredients}`;
    if (key === lastKey) return;
    lastKey = key;

    // Increment scanSeq BEFORE synchronous scanCache hits so any older in-flight network scan is immediately invalidated!
    const seq = ++scanSeq;
    const cKey = normCacheKey(productTitle, rawIngredients);
    const cached = scanCache.get(cKey) || (!rawIngredients ? scanCache.get(normCacheKey(productTitle, "")) : null);
    if (cached?.ok) {
      void applyScanResult(cached, domImage, seq);
      return;
    }

    const reqBucket = activeBucket;
    chrome.runtime.sendMessage(
      {
        type: "CLEANCART_SCAN",
        payload: {
          productTitle,
          rawIngredients: rawIngredients || undefined,
          store: reqBucket.store,
          instacartRetailerSlug: reqBucket.instacartRetailerSlug,
        },
      },
      (resp) => {
        if (resp?.ok) {
          scanCache.set(cKey, resp);
        }
        if (seq !== scanSeq || !isProductPage() || resolveStoreBucket().bucketKey !== reqBucket.bucketKey) return;
        void applyScanResult(resp, domImage, seq);
      }
    );
  }

  // Multi-product grid/aisle hover & keyboard-focus disambiguation:
  // Scans the exact product tile the shopper hovers or focuses without ever guessing a random banner!
  let hoverTimer = null;
  let lastHoveredCardEl = null;

  function triggerGridCardInspect(cardEl) {
    if (isProductPage() || isCartPageUrl()) return;
    const info = readProductCardInfo(cardEl);
    if (!info) return;
    // Increment scanSeq BEFORE synchronous scanCache hits so any older in-flight network scan is immediately invalidated!
    const seq = ++scanSeq;
    state.hoveredCardData = info;
    const domImg = info.domImageUrl || info.image || null;
    const cKey = normCacheKey(info.title, "");
    const cached = scanCache.get(cKey);
    if (cached?.ok) {
      void applyScanResult(cached, domImg, seq);
      return;
    }
    const reqBucket = activeBucket;
    chrome.runtime.sendMessage(
      {
        type: "CLEANCART_SCAN",
        payload: {
          productTitle: info.title,
          store: reqBucket.store,
          instacartRetailerSlug: reqBucket.instacartRetailerSlug,
        },
      },
      (resp) => {
        if (resp?.ok) scanCache.set(cKey, resp);
        if (
          seq !== scanSeq ||
          isProductPage() ||
          state.hoveredCardData?.title !== info.title ||
          resolveStoreBucket().bucketKey !== reqBucket.bucketKey
        ) {
          return;
        }
        void applyScanResult(resp, domImg, seq);
      }
    );
  }

  document.addEventListener(
    "pointerover",
    (e) => {
      if (isProductPage() || isCartPageUrl() || state.expanded || state.auditorOpen) return;
      if (host?.contains(e.target)) return;
      const card = e.target?.closest?.(PRODUCT_CARD_SEL);
      if (card === lastHoveredCardEl) return;
      lastHoveredCardEl = card;
      clearTimeout(hoverTimer);
      if (!card) {
        hoverTimer = setTimeout(() => {
          if (!isProductPage() && !state.expanded) {
            ++scanSeq;
            state.hoveredCardData = null;
            state.lastDomProductImageUrl = null;
            state.mode = "cart_avg";
            render();
          }
        }, 500);
        return;
      }
      hoverTimer = setTimeout(() => triggerGridCardInspect(card), 260);
    },
    { passive: true }
  );

  document.addEventListener(
    "focusin",
    (e) => {
      if (isProductPage() || isCartPageUrl() || host?.contains(e.target)) return;
      const card = e.target?.closest?.(PRODUCT_CARD_SEL);
      if (card) triggerGridCardInspect(card);
    },
    { passive: true }
  );

  // Instant pre-warm on pointerdown on any product link
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (host?.contains(e.target)) return;
      const a = e.target?.closest?.(
        'a[href*="/ip/"], a[href*="/products/"], a[href*="/p/"], a[href*="/dp/"], a[href*="/gp/product/"], [data-testid*="product" i] a'
      );
      if (!a) return;
      const rawText = cleanProductTitleText(a.getAttribute("aria-label") || a.textContent || "");
      if (rawText.length < 4 || rawText.length > 180 || NON_TITLE_RE.test(rawText)) return;
      const cKey = normCacheKey(rawText, "");
      if (scanCache.has(cKey)) return;
      chrome.runtime.sendMessage(
        {
          type: "CLEANCART_SCAN",
          payload: {
            productTitle: rawText,
            store: activeBucket.store,
            instacartRetailerSlug: activeBucket.instacartRetailerSlug,
          },
        },
        (resp) => {
          if (resp?.ok) scanCache.set(cKey, resp);
        }
      );
    },
    { passive: true, capture: true }
  );

  // Respond to popup.js live state queries for the active store tab
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "CLEANCART_GET_TAB_STATE") {
      activeBucket = resolveStoreBucket();
      sendResponse({
        ok: true,
        bucketKey: activeBucket.bucketKey,
        store: activeBucket.store,
        label: activeBucket.label,
        cartAvg: calcCartAvg(),
        projectedAvg: calcProjectedAvgAfterSwaps(),
        totalUnits: totalCartUnits(),
        cartItems: state.cartItems,
      });
      return true;
    }
    return false;
  });

  loadBucketCart(true).then(() => {
    void checkLiveDestinationSwapStock();

    const MAX_DEBOUNCE_WAIT_MS = 550;
    let firstQueuedAt = 0;
    const runScheduledScan = () => {
      firstQueuedAt = 0;
      timer = null;
      void scan();
    };
    const schedule = () => {
      const now = Date.now();
      if (!firstQueuedAt) firstQueuedAt = now;
      if (now - firstQueuedAt >= MAX_DEBOUNCE_WAIT_MS) {
        clearTimeout(timer);
        runScheduledScan();
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(runScheduledScan, DEBOUNCE_MS);
    };

    if (document.body) {
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    }
    window.addEventListener("popstate", schedule);
    window.addEventListener("hashchange", schedule);

    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        // Live cross-tab sync for the active store's isolated cart bucket
        const currentStorageKey = storageKeyForBucket(activeBucket.bucketKey);
        if (areaName === "local" && changes[currentStorageKey] && !savingCartSelf) {
          const nextRaw = changes[currentStorageKey].newValue;
          state.cartItems = Array.isArray(nextRaw)
            ? nextRaw.map(sanitizeStoredCartItem).filter(Boolean).slice(0, MAX_CART_ITEMS)
            : [];
          state.displayedAvg = calcCartAvg();
          render();
        }
        // Live re-scoring of both active product AND cached cart items when Watchlist toggles change
        if (changes.watchlist || changes.familyWatchlist || changes.dietaryWatchlist) {
          scanCache.clear();
          stockCache.clear();
          lastKey = "";
          if (state.cartItems.length > 0) {
            void auditCartItemsBatch([], true);
          }
          schedule();
        }
      });
    }

    schedule();
  });
})();
