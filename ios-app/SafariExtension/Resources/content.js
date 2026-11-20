// HeyBroc PureOverlay content script — Multi-Food Scanner, Per-Store & Per-Retailer Carts,
// Authoritative Cart Scraping + Instant Deletion Sync, In-Stock Swap Verification,
// Quantity-Weighted Cart Average Math, and Persistent Zero-FOUC Floating Pill UI.
(() => {
  if (window.__cleancartLoaded) return;
  window.__cleancartLoaded = true;

  const DEFAULT_API = "https://www.heybroc.com";
  const HOST = location.hostname.toLowerCase();
  const SUPPORTED_GROCERY_HOST_RE =
    /(?:^|\.)(?:walmart\.com|instacart\.com|target\.com|kroger\.com|ralphs\.com|fredmeyer\.com|kingsoopers\.com|frysfood\.com|smithsfoodanddrug\.com|harristeeter\.com|qfc\.com|marianos\.com|picknsave\.com|metro-market\.net|metromarket\.net|dillons\.com|citymarket\.com|bakersplus\.com|gerbes\.com|jaycfoods\.com|pay-less\.com|food4less\.com|foodsco\.net|foodscomarket\.com|owensmarket\.com|rulerfoods\.com|aldi\.us|doordash\.com|ubereats\.com|amazon\.com|wholefoodsmarket\.com|samsclub\.com|bjs\.com|costco\.com|shipt\.com)$/;
  if (!SUPPORTED_GROCERY_HOST_RE.test(HOST)) return;

  const KROGER_BANNER_HOST_RE =
    /(?:^|\.)(?:kroger\.com|ralphs\.com|fredmeyer\.com|kingsoopers\.com|frysfood\.com|smithsfoodanddrug\.com|harristeeter\.com|qfc\.com|marianos\.com|picknsave\.com|metro-market\.net|metromarket\.net|dillons\.com|citymarket\.com|bakersplus\.com|gerbes\.com|jaycfoods\.com|pay-less\.com|food4less\.com|foodsco\.net|foodscomarket\.com|owensmarket\.com|rulerfoods\.com)$/;

  const BASE_STORE = HOST.includes("walmart") ? "walmart"
    : HOST.includes("instacart") ? "instacart"
    : HOST.includes("target") ? "target"
    : KROGER_BANNER_HOST_RE.test(HOST) ? "kroger"
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
  const CART_STALE_MS = 2 * 60 * 60 * 1000;
  const STOCK_CACHE_TTL_MS = 10 * 60 * 1000;
  const PENDING_SWAP_KEY = "heybroc_pending_swap_check";
  const LAST_INSTACART_SLUG_SESSION_KEY = "heybroc_last_instacart_slug";

  const RESERVED_SLUGS = new Set([
    "s", "search", "cart", "checkout", "account", "hub", "referrals", "orders",
    "lists", "store", "stores", "items", "products", "product", "item", "help",
    "login", "signup", "categories", "collections", "shop", "convenience", "grocery",
    "all", "deals", "promotions", "favorites", "saved", "your-items", "retailers",
    "recipes", "partner-recipes", "partner_recipes", "gift-cards", "bookmarks",
    "brands", "loyalty", "family", "instacart-plus", "settings", "savings",
    "discover", "directory", "http", "https",
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

  const isIosMobileBrowser =
    /iPhone|iPad|iPod/i.test(navigator.userAgent || "") ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  const isTouchPrimary = () =>
    isIosMobileBrowser ||
    Boolean(window.matchMedia?.("(hover: none) and (pointer: coarse)")?.matches) ||
    (Number(navigator.maxTouchPoints || 0) > 0 &&
      Math.min(window.innerWidth || 9999, window.screen?.width || 9999) <= 920);

  function buildWebActionUrl(kind) {
    const cleanCode = String(clientInfo.creatorCode || "").trim();
    if (isIosMobileBrowser) {
      const schemeBase = kind === "login" ? "heybroc://login" : "heybroc://upgrade";
      return cleanCode ? `${schemeBase}?code=${encodeURIComponent(cleanCode)}` : schemeBase;
    }
    const base = (clientInfo.apiBase || DEFAULT_API).replace(/\/+$/, "");
    const params = new URLSearchParams();
    params.set(kind === "login" ? "login" : "upgrade", "1");
    if (clientInfo.deviceId) params.set("deviceId", clientInfo.deviceId);
    if (cleanCode) params.set("code", cleanCode);
    return `${base}/?${params.toString()}`;
  }

  function resolveApiAssetUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return "";
    const trimmed = rawUrl.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("/")) {
      const base = (clientInfo.apiBase || DEFAULT_API).replace(/\/+$/, "");
      return `${base}${trimmed}`;
    }
    return trimmed;
  }

  function fallbackThumbUrl(title, brand = "") {
    const base = (clientInfo.apiBase || DEFAULT_API).replace(/\/+$/, "");
    const cleanBrand = String(brand || "").trim();
    const brandParam = cleanBrand ? `&brand=${encodeURIComponent(cleanBrand)}` : "";
    return `${base}/api/product-image?q=${encodeURIComponent(String(title || "grocery"))}${brandParam}&fallback=404&v=7`;
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

  function isStudioCategoryArtUrl(url) {
    if (!url || typeof url !== "string") return false;
    try {
      const parsed = new URL(url, DEFAULT_API);
      return parsed.pathname.startsWith("/swaps/") || parsed.pathname.startsWith("/products/");
    } catch {
      return url.includes("/swaps/") || url.includes("/products/");
    }
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

  const BRAND_TILE_PALETTES = [
    ["#ECFDF5", "#065F46", "#A7F3D0"],
    ["#EFF6FF", "#1E40AF", "#BFDBFE"],
    ["#FEF3C7", "#92400E", "#FDE68A"],
    ["#F3E8FF", "#5B21B6", "#DDD6FE"],
    ["#FFE4E6", "#9F1239", "#FECDD3"],
    ["#F1F5F9", "#334155", "#CBD5E1"],
  ];

  function computeBrandLetterTile(title, brand = "") {
    const source = String(brand || "").trim() || String(title || "").trim() || "Grocery";
    const alphaMatch = source.match(/[A-Za-z0-9]/);
    const letter = (alphaMatch ? alphaMatch[0] : "G").toUpperCase();
    let hash = 0;
    for (let i = 0; i < source.length; i++) {
      hash = (hash * 31 + source.charCodeAt(i)) | 0;
    }
    const [bg, fg, border] = BRAND_TILE_PALETTES[Math.abs(hash) % BRAND_TILE_PALETTES.length];
    return { letter, bg, fg, border };
  }

  /* ---------------- Per-Store & Per-Marketplace-Retailer Bucket Resolution ---------------- */
  function cleanSlug(raw) {
    if (!raw || typeof raw !== "string") return "";
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    const slug = decoded
      .trim()
      .toLowerCase()
      .replace(/^\/+|\/+$/g, "")
      .split("/")[0]
      .replace(/[^a-z0-9_-]/g, "");
    if (
      !slug ||
      slug.length < 2 ||
      RESERVED_SLUGS.has(slug) ||
      /^checkout(?:[-_]|$)/i.test(slug) ||
      /^\d+$/.test(slug)
    ) {
      return "";
    }
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
      const retailerLinks = document.querySelectorAll(
        '[data-testid*="retailer" i] a[href*="/store/"], [data-testid*="store-header" i] a[href*="/store/"], a[href*="/store/"][href*="/front"]'
      );
      for (const a of retailerLinks) {
        const m = (a.getAttribute("href") || "").match(/\/store\/([^/?#]+)/i);
        const cand = cleanSlug(m?.[1] || "");
        if (cand) {
          slug = cand;
          break;
        }
      }
    }
    if (slug) {
      try { sessionStorage.setItem(LAST_INSTACART_SLUG_SESSION_KEY, slug); } catch { /* ignore */ }
      return slug;
    }
    try {
      const rawStored = sessionStorage.getItem(LAST_INSTACART_SLUG_SESSION_KEY) || "";
      const validStored = cleanSlug(rawStored);
      if (!validStored && rawStored) {
        sessionStorage.removeItem(LAST_INSTACART_SLUG_SESSION_KEY);
      }
      return validStored;
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
      const rawStored = sessionStorage.getItem(sessionKey) || "";
      const validStored = cleanSlug(rawStored);
      if (!validStored && rawStored) {
        sessionStorage.removeItem(sessionKey);
      }
      return validStored;
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
      almBrandId === "vuzhifdob2xliezvb2rz" ||
      almBrandId === "vufhifdob2xliezvb2rz" ||
      almBrandId.includes("dob2xliezvb2rz") ||
      urlFull.includes("wholefoods") ||
      urlFull.includes("dob2xliezvb2rz") ||
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

  function extractRetailerItemIdFromSingleUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return "";
    let candidate = rawUrl.trim();
    if (!candidate) return "";
    try {
      const parsed = new URL(candidate, location.href);
      const rd = parsed.searchParams.get("rd");
      if (rd) {
        candidate = `${parsed.pathname}${parsed.search} ${rd}`;
      }
    } catch {
      /* ignore relative/malformed URL */
    }
    const asinMatch = candidate.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?#]|$)/i);
    if (asinMatch) return `asin:${asinMatch[1].toUpperCase()}`;
    const walmartMatch = candidate.match(/\/ip\/(?:[^/?#]+\/)?(\d{6,16})(?:[/?#]|$)/i);
    if (walmartMatch) return `walmart:${walmartMatch[1]}`;
    const targetMatch = candidate.match(/\/-\/A-(\d{6,14})(?:[/?#]|$)/i);
    if (targetMatch) return `tcin:${targetMatch[1]}`;
    const icMatch = candidate.match(/\/(?:products|items)\/(?:item_)?(\d{4,18})(?:[/?#_-]|$)/i);
    if (icMatch) return `ic:${icMatch[1]}`;
    const krogerMatch = candidate.match(/\/p\/[^/?#]+\/(\d{8,15})(?:[/?#]|$)/i);
    if (krogerMatch) return `kroger:${krogerMatch[1]}`;
    return "";
  }

  function extractRetailerItemIdFromUrlOrNode(url, node) {
    if (node && typeof node.getAttribute === "function") {
      const asinAttr = (
        node.getAttribute("data-asin") ||
        node.closest?.('[data-asin]:not([data-asin=""])')?.getAttribute?.("data-asin") ||
        ""
      ).trim();
      if (/^[A-Z0-9]{10}$/i.test(asinAttr)) {
        return `asin:${asinAttr.toUpperCase()}`;
      }
      const wmAttr = (
        node.getAttribute("data-item-id") ||
        node.closest?.("[data-item-id]")?.getAttribute?.("data-item-id") ||
        ""
      ).trim();
      if (/^\d{6,16}$/.test(wmAttr)) {
        return `walmart:${wmAttr}`;
      }
    }
    const fromUrl = extractRetailerItemIdFromSingleUrl(url);
    if (fromUrl) return fromUrl;
    if (node && typeof node.querySelectorAll === "function") {
      const foundIds = new Set();
      const childAsinEls = node.querySelectorAll('[data-asin]:not([data-asin=""])');
      for (const el of childAsinEls) {
        const a = (el.getAttribute("data-asin") || "").trim();
        if (/^[A-Z0-9]{10}$/i.test(a)) foundIds.add(`asin:${a.toUpperCase()}`);
      }
      const childWmEls = node.querySelectorAll("[data-item-id]");
      for (const el of childWmEls) {
        const w = (el.getAttribute("data-item-id") || "").trim();
        if (/^\d{6,16}$/.test(w)) foundIds.add(`walmart:${w}`);
      }
      const links = node.querySelectorAll("a[href]");
      for (const a of links) {
        const lid = extractRetailerItemIdFromSingleUrl(a.getAttribute("href") || "");
        if (lid) foundIds.add(lid);
        if (foundIds.size > 1) return "";
      }
      if (foundIds.size === 1) {
        return [...foundIds][0];
      }
    }
    return "";
  }

  function normalizeTitleForMatch(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/\b(\d+)\s*%/g, "$1%")
      .replace(/\b(\d+(?:\.\d+)?\s*(?:fl\s*oz|oz|lb|lbs|ct|count|pk|pack|g|kg|ml|l|gal|gallon|qt|pt))\b/g, " ")
      .replace(/[^a-z0-9%\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const VARIANT_CONFLICT_PATTERNS = [
    /\borganic\b/,
    // Flavors
    /\b(?:plain|unflavored|original)\b/,
    /\bvanilla\b/,
    /\bchocolate\b/,
    /\bstrawberr(?:y|ies)\b/,
    /\bblueberr(?:y|ies)\b/,
    /\braspberr(?:y|ies)\b/,
    /\bpeach\b/,
    /\bmango\b/,
    /\bbanana\b/,
    /\bcherr(?:y|ies)\b/,
    /\bhoney\b/,
    /\bcinnamon\b/,
    /\bmaple\b/,
    /\bcool\s+ranch\b/,
    /\bnacho\s+cheese\b/,
    // Sweetness / diet
    /\b(?:zero\s+sugar|sugar\s+free|no\s+sugar|diet)\b/,
    /\bunsweetened\b/,
    /\blightly\s+sweetened\b/,
    // Other key variants
    /\bdecaf(?:feinated)?\b/,
    /\blactose\s+free\b/,
    /\bextra\s+creamy\b/,
    /\b(?:simply\s+nkd|nkd)\b/,
    /\bunsalted\b/,
    /\blightly\s+salted\b/,
  ];

  const DAIRY_FAT_VARIANT_PATTERNS = [
    /\bwhole\b/,
    /(?:^|\s)2%(?:\s|$)|\breduced\s+fat\b/,
    /(?:^|\s)1%(?:\s|$)|\blow\s*fat\b/,
    /(?:^|\s)0%(?:\s|$)|\bskim\b|\bfat\s*free\b|\bnon\s*fat\b/,
    /\bhalf\s*(?:and|&)\s*half\b/,
    /\bheavy\b/,
  ];

  function normalizeForVariantCheck(raw) {
    return String(raw || "")
      .toLowerCase()
      .replace(/\b(\d+)\s*%/g, "$1%")
      .replace(/&/g, " & ")
      .replace(/[^a-z0-9%&\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripNonDairyWholePhrases(s) {
    return s
      .replace(
        /\bwhole\s+(?:foods?|grains?|wheat|oats?|beans?|kernels?|peeled|almonds?|cashews?|berry|berries|cloves?|leaf|seed|seeds)\b/g,
        " "
      )
      .replace(/\s+/g, " ")
      .trim();
  }

  function hasConflictingCartVariants(a, b) {
    const sa = normalizeForVariantCheck(a);
    const sb = normalizeForVariantCheck(b);
    if (!sa || !sb) return false;
    for (let i = 0; i < VARIANT_CONFLICT_PATTERNS.length; i++) {
      const re = VARIANT_CONFLICT_PATTERNS[i];
      if (re.test(sa) !== re.test(sb)) return true;
    }
    const da = stripNonDairyWholePhrases(sa);
    const db = stripNonDairyWholePhrases(sb);
    for (let i = 0; i < DAIRY_FAT_VARIANT_PATTERNS.length; i++) {
      const re = DAIRY_FAT_VARIANT_PATTERNS[i];
      if (re.test(da) !== re.test(db)) return true;
    }
    return false;
  }

  function isSameCartTitle(a, b) {
    const na = normalizeTitleForMatch(a);
    const nb = normalizeTitleForMatch(b);
    if (!na || !nb) return false;
    if (hasConflictingCartVariants(a, b)) return false;
    if (na === nb) return true;
    if (na.length >= 10 && nb.length >= 10 && (na.includes(nb) || nb.includes(na))) return true;
    const keepWord = (w) => w.length >= 3 || /^\d+%$/.test(w);
    const wa = na.split(" ").filter(keepWord);
    const wb = nb.split(" ").filter(keepWord);
    if (wa.length >= 3 && wb.length >= 3) {
      const overlap = wa.filter((w) => wb.includes(w)).length;
      if (overlap >= Math.min(wa.length, wb.length) - 1 && overlap >= 3) return true;
    }
    return false;
  }

  function isSameCartEntry(entryA, entryB) {
    if (!entryA || !entryB) return false;
    const idA = String(entryA.itemId || "").trim();
    const idB = String(entryB.itemId || "").trim();
    if (idA && idB) return idA === idB;
    const titleA = String(entryA.title || entryA.key || "");
    const titleB = String(entryB.title || entryB.key || "");
    const keyA = String(entryA.key || entryA.title || "");
    const keyB = String(entryB.key || entryB.title || "");
    return (
      isSameCartTitle(titleA, titleB) ||
      (keyA !== titleA && isSameCartTitle(keyA, titleB)) ||
      (keyB !== titleB && isSameCartTitle(titleA, keyB)) ||
      (keyA !== titleA && keyB !== titleB && isSameCartTitle(keyA, keyB))
    );
  }

  const DISMISSED_CART_TTL_MS = 12000;
  const dismissedCartKeys = new Map(); // normalizedKey or "id:<itemId>" -> expiresAtMs

  function pruneDismissedCartKeys() {
    const now = Date.now();
    for (const [k, exp] of dismissedCartKeys.entries()) {
      if (!exp || exp <= now) dismissedCartKeys.delete(k);
    }
  }

  function markCartItemDismissed(titleOrKey, itemId = "") {
    pruneDismissedCartKeys();
    const exp = Date.now() + DISMISSED_CART_TTL_MS;
    const cleanId = String(itemId || "").trim();
    if (cleanId) {
      dismissedCartKeys.set(`id:${cleanId}`, exp);
    }
    const norm = normalizeTitleForMatch(titleOrKey);
    if (norm) {
      dismissedCartKeys.set(norm, exp);
    }
  }

  function clearCartItemDismissed(titleOrKey, itemId = "") {
    pruneDismissedCartKeys();
    const cleanId = String(itemId || "").trim();
    if (cleanId) {
      dismissedCartKeys.delete(`id:${cleanId}`);
    }
    const norm = normalizeTitleForMatch(titleOrKey);
    if (!norm) return;
    dismissedCartKeys.delete(norm);
    for (const k of [...dismissedCartKeys.keys()]) {
      if (k.startsWith("id:")) continue;
      if (isSameCartTitle(k, norm)) dismissedCartKeys.delete(k);
    }
  }

  function isCartKeyDismissed(normKey, itemId = "") {
    pruneDismissedCartKeys();
    const cleanId = String(itemId || "").trim();
    if (cleanId) {
      return dismissedCartKeys.has(`id:${cleanId}`);
    }
    if (!normKey) return false;
    if (dismissedCartKeys.has(normKey)) return true;
    for (const k of dismissedCartKeys.keys()) {
      if (k.startsWith("id:")) continue;
      if (isSameCartTitle(k, normKey)) return true;
    }
    return false;
  }

  function isCartItemDismissed(titleOrKey, itemId = "") {
    return isCartKeyDismissed(normalizeTitleForMatch(titleOrKey), itemId);
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
    const rawUpdatedAt = Number(raw.updatedAt);
    return {
      key: String(raw.key || title).trim(),
      title,
      itemId: String(raw.itemId || "").trim(),
      updatedAt: Number.isFinite(rawUpdatedAt) && rawUpdatedAt > 0 ? rawUpdatedAt : Date.now(),
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

  function filterFreshCartItems(items, bucketMeta, bucketKey) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const now = Date.now();
    const metaMatches = Boolean(bucketMeta && bucketKey && bucketMeta.bucketKey === bucketKey);
    const metaTs = metaMatches ? Number(bucketMeta.updatedAt) : 0;
    if (Number.isFinite(metaTs) && metaTs > 0 && now - metaTs > CART_STALE_MS) {
      return [];
    }
    return items.filter((item) => {
      if (!item) return false;
      const ts = Number(item.updatedAt);
      if (Number.isFinite(ts) && ts > 0 && now - ts > CART_STALE_MS) return false;
      return true;
    });
  }

  let savingCartSelf = false;

  async function loadBucketCart(forceReload = false) {
    const nextBucket = resolveStoreBucket();
    if (!forceReload && nextBucket.bucketKey === activeBucket.bucketKey && state._cartLoaded) {
      activeBucket = nextBucket;
      if (state.cartItems.length > 0) {
        const freshInMem = filterFreshCartItems(state.cartItems, null, activeBucket.bucketKey);
        if (freshInMem.length !== state.cartItems.length) {
          state.cartItems = freshInMem;
          state.displayedAvg = calcCartAvg();
          saveBucketCart();
          return;
        }
      }
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
      const keysToFetch = [v2Key, "heybroc_active_bucket_meta", ...legacyKeys];
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
      const rawHadEntries = Array.isArray(rawList) && rawList.length > 0;
      const sanitized = Array.isArray(rawList)
        ? rawList.map(sanitizeStoredCartItem).filter(Boolean).slice(0, MAX_CART_ITEMS)
        : [];
      const freshItems = filterFreshCartItems(
        sanitized,
        stored?.heybroc_active_bucket_meta || null,
        activeBucket.bucketKey
      );
      state.cartItems = freshItems;
      state._cartLoaded = true;
      state.displayedAvg = calcCartAvg();
      if (rawHadEntries && freshItems.length !== sanitized.length) {
        saveBucketCart();
      } else {
        publishActiveBucketMeta();
      }
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

  /* ---------------- Bounded LRU Map Helpers & In-Stock Swap Verification ---------------- */
  const MAX_STOCK_CACHE = 250;
  const MAX_PDP_SCAN_CACHE = 150;
  const MAX_GRID_SCAN_CACHE = 400;

  function lruGet(map, key) {
    if (!map.has(key)) return undefined;
    const val = map.get(key);
    map.delete(key);
    map.set(key, val);
    return val;
  }

  function lruSet(map, key, val, maxEntries) {
    if (map.has(key)) map.delete(key);
    map.set(key, val);
    while (map.size > maxEntries) {
      const oldestKey = map.keys().next().value;
      if (oldestKey === undefined) break;
      map.delete(oldestKey);
    }
  }

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
    const hit = lruGet(stockCache, cacheKey);
    if (hit && Date.now() - hit.ts < STOCK_CACHE_TTL_MS) {
      return hit;
    }

    let checkUrl = candidate.webUrl;
    try {
      const parsed = new URL(candidate.webUrl, location.origin);
      // Only fetch same-origin URLs directly with store session cookies
      if (parsed.hostname.replace(/^www\./, "") !== HOST.replace(/^www\./, "")) {
        const result = { inStock: true, unverifiedSpa: true, verifiedUrl: candidate.webUrl, ts: Date.now() };
        lruSet(stockCache, cacheKey, result, MAX_STOCK_CACHE);
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
        lruSet(stockCache, cacheKey, out, MAX_STOCK_CACHE);
        return out;
      }
      if (!res.ok) {
        const fallback = { inStock: true, unverifiedSpa: true, verifiedUrl: checkUrl, ts: Date.now() };
        lruSet(stockCache, cacheKey, fallback, MAX_STOCK_CACHE);
        return fallback;
      }
      const html = await res.text();
      const analyzed = analyzeFetchedStoreHtml(html, candidate, checkUrl);
      const out = { ...analyzed, ts: Date.now() };
      lruSet(stockCache, cacheKey, out, MAX_STOCK_CACHE);
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
        lruSet(stockCache, badCacheKey, { inStock: false, verifiedUrl: location.href, ts: Date.now() }, MAX_STOCK_CACHE);

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
    /^(search|your cart|shopping cart|cart|bag|basket|checkout|review order|order summary|items to add next|product information|similar items|customers also.*|sponsored.*|buy (?:it )?again|frequently bought together|saved for later|product|item|ad|advertisement|walmart|target|costco(?:\s+wholesale)?|sam'?s\s+club|aldi|kroger|instacart|whole\s+foods(?:\s+market)?|amazon(?:\s+fresh)?|bj'?s(?:\s+wholesale\s+club)?|doordash|dashmart|uber\s*eats|shipt|boost\s+by\s+kroger|continue\s+as\s+guest|log\s*in|sign\s*in|sign\s*up|same-day\s+delivery|choose\s+a\s+store|departments|grocery|new\s+grocery|produce|fresh\s+produce|fruits?(?:\s*&\s*vegetables?)?|vegetables?|meat(?:\s*&\s*seafood)?|seafood|dairy(?:\s*&\s*eggs)?|eggs|bakery(?:\s*&\s*bread)?|bread|deli|frozen(?:\s+foods?)?|pantry|snacks(?:\s*&\s*candy)?|candy|beverages|drinks|coffee(?:\s*&\s*tea)?|breakfast(?:\s*&\s*cereal)?|condiments|baking|household|personal\s+care|health(?:\s*&\s*beauty)?|baby|pets?|savings|deals|weekly\s+ad|instant\s+savings|top\s+deals|rollbacks?|clearance|new\s+arrivals|best\s+sellers|trending|featured(?:\s+categories|\s+items)?|shop\s+by\s+(?:category|department|brand|diet)|all\s+products|shop\s+all|subtotal.*|estimated\s+total.*|substitutions?.*)$/i;

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

  const EXCLUDED_DIV_ATTR_RE =
    /\b(?:saved[-_ ]?for[-_ ]?later|buy[-_ ]?(?:it[-_ ]?)?again|frequently[-_ ]?bought|recently[-_ ]?viewed|recommended[-_ ]?(?:for[-_ ]?you)?)\b/i;

  function isInsideExcludedSection(el, rootBoundary = document.body) {
    if (!el || typeof el.closest !== "function") return false;
    const matchedAttr = el.closest(EXCLUDED_CONTAINER_SEL);
    if (matchedAttr && (!rootBoundary || rootBoundary.contains(matchedAttr))) return true;

    let cur = el.parentElement;
    let depth = 0;
    while (cur && cur !== rootBoundary && cur !== document.body && depth < 10) {
      const aria = cur.getAttribute("aria-label") || "";
      if (EXCLUDED_SECTION_HEADING_RE.test(aria)) return true;
      const meta = `${cur.id || ""} ${cur.getAttribute("data-testid") || ""} ${cur.getAttribute("data-test") || ""} ${cur.getAttribute("data-automation-id") || ""} ${typeof cur.className === "string" ? cur.className : ""}`;
      if (EXCLUDED_DIV_ATTR_RE.test(meta)) return true;

      const isLandmark = /^(SECTION|ASIDE)$/.test(cur.tagName) || cur.getAttribute("role") === "region";
      if (isLandmark || cur.tagName === "DIV") {
        let heading = cur.querySelector(
          ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > [role="heading"], :scope > header h2, :scope > header h3, :scope > header [role="heading"]'
        );
        if (!heading && isLandmark) {
          heading = cur.querySelector(':scope > div > h2, :scope > div > h3, :scope > div > [role="heading"]');
        } else if (!heading && cur.tagName === "DIV") {
          const firstChild = cur.firstElementChild;
          if (firstChild && firstChild.tagName === "DIV" && !firstChild.contains(el)) {
            heading = firstChild.querySelector(':scope > h2, :scope > h3, :scope > h4, :scope > [role="heading"]');
          }
        }
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
      if (rect.width < 260 || rect.height < 220) continue;
      if (rect.bottom < 160 || rect.top > window.innerHeight - 120) continue;
      if (/^(HEADER|NAV|FOOTER)$/i.test(d.tagName)) continue;

      const meta = `${d.id || ""} ${d.className || ""} ${d.getAttribute("aria-label") || ""} ${d.getAttribute("data-testid") || ""}`;
      if (/\b(cookie|consent|onetrust|gdpr|privacy|navbar|site-header|top-nav|search-dropdown|autocomplete|address-modal|store-selector|login|signin)\b/i.test(meta)) {
        continue;
      }
      if (isCartDrawerElement(d)) continue;

      const heading = d.querySelector('h1, h2, h3, [role="heading"], [data-testid*="product-title" i], [data-testid*="item-title" i]');
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
      .replace(/^(?:sponsored\s+ad|ad)\s*[-–—:|•]\s*/i, "")
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
          '[data-testid*="item-details" i] h3',
          '[data-anchor-id*="ItemModal" i] h1',
          '[data-anchor-id*="ItemModal" i] h2',
          '[data-anchor-id*="ItemModal" i] h3',
          '[data-testid*="product-title" i]',
          '[data-testid*="product-name" i]',
          '[data-testid*="itemHeader" i]',
          '[data-testid*="title" i]',
          "h1",
          "h2",
          "h3",
          '[role="heading"]',
        ]
      : [
          '[data-testid="product-page-title"]',
          'h1[data-automation-id*="product-title" i]',
          '[data-automation-id="product-title"]',
          "h1.ProductDetails-header",
          "#productTitle",
          "h1#title",
          "#title_feature_div #title",
          "#titleSection #title",
          '[data-hook="product-title"]',
          "#title",
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

  const CART_DRAWER_META_RE =
    /\b(cart[-_ ]?(?:drawer|modal|panel|flyout|sidebar)|shopping[-_ ]?cart|mini[-_ ]?cart|bag[-_ ]?drawer)\b/i;

  function isCartDrawerNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const meta = `${node.id || ""} ${node.getAttribute?.("data-testid") || ""} ${node.getAttribute?.("aria-label") || ""} ${typeof node.className === "string" ? node.className : ""}`;
    if (CART_DRAWER_META_RE.test(meta)) return true;
    const role = String(node.getAttribute?.("role") || "").toLowerCase();
    const isContainer =
      role === "dialog" ||
      String(node.getAttribute?.("aria-modal") || "").toLowerCase() === "true" ||
      /^(ASIDE|SECTION)$/i.test(node.tagName || "");
    return isContainer ? isCartDrawerElement(node) : false;
  }

  function isInactiveTabPanel(node) {
    if (!node || node.nodeType !== 1) return false;
    if (String(node.getAttribute?.("role") || "").toLowerCase() !== "tabpanel") return false;
    if (
      node.hidden === true ||
      node.hasAttribute?.("hidden") ||
      node.hasAttribute?.("inert") ||
      String(node.getAttribute?.("aria-hidden") || "").toLowerCase() === "true"
    ) {
      return true;
    }
    const dataState = String(node.getAttribute?.("data-state") || "").toLowerCase();
    if (dataState === "inactive" || dataState === "closed") return true;
    if (String(node.getAttribute?.("aria-selected") || "").toLowerCase() === "false") return true;
    if (String(node.getAttribute?.("aria-expanded") || "").toLowerCase() === "false") return true;
    const id = String(node.id || "").trim();
    if (id && /^[A-Za-z0-9_:-]+$/.test(id)) {
      const tab = document.querySelector(`[role="tab"][aria-controls="${id}"]`);
      if (tab && String(tab.getAttribute?.("aria-selected") || "").toLowerCase() === "false") return true;
    }
    const labelledBy = String(node.getAttribute?.("aria-labelledby") || "").trim();
    if (labelledBy) {
      for (const lblId of labelledBy.split(/\s+/)) {
        const lblEl = document.getElementById(lblId);
        if (
          lblEl &&
          String(lblEl.getAttribute?.("role") || "").toLowerCase() === "tab" &&
          String(lblEl.getAttribute?.("aria-selected") || "").toLowerCase() === "false"
        ) {
          return true;
        }
      }
    }
    return !isElementVisible(node);
  }

  function isInsideHiddenOrCartContainer(el, scopeRoot) {
    if (!el || el.nodeType !== 1) return true;
    const isModalScope = Boolean(scopeRoot && scopeRoot !== document.body && scopeRoot !== document.documentElement);
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      if (cur.hidden === true || cur.hasAttribute?.("hidden") || cur.hasAttribute?.("inert")) {
        return true;
      }
      if (String(cur.getAttribute?.("aria-hidden") || "").toLowerCase() === "true") {
        return true;
      }
      const st = window.getComputedStyle ? window.getComputedStyle(cur) : null;
      if (st) {
        if (st.display === "none" || st.visibility === "hidden") return true;
        if (st.opacity === "0" || (st.opacity !== "" && parseFloat(st.opacity) === 0)) return true;
      }
      if (isInactiveTabPanel(cur)) return true;
      const role = String(cur.getAttribute?.("role") || "").toLowerCase();
      const isDialog =
        role === "dialog" || String(cur.getAttribute?.("aria-modal") || "").toLowerCase() === "true";
      if (!isModalScope) {
        if (isCartDrawerNode(cur)) return true;
        if (isDialog && !isElementVisible(cur)) return true;
      } else if (cur !== scopeRoot) {
        if (isCartDrawerNode(cur)) return true;
        if (isDialog && !isElementVisible(cur)) return true;
      }
      if (isModalScope && cur === scopeRoot) break;
      cur = cur.parentElement;
    }
    return false;
  }

  function isInsideHiddenDialogTabpanelOrCart(el, scopeRoot) {
    if (!el || el.nodeType !== 1) return true;
    const isModalScope = Boolean(scopeRoot && scopeRoot !== document.body && scopeRoot !== document.documentElement);
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      if (isCartDrawerNode(cur)) return true;
      if (isInactiveTabPanel(cur)) return true;
      const role = String(cur.getAttribute?.("role") || "").toLowerCase();
      const isDialog =
        role === "dialog" || String(cur.getAttribute?.("aria-modal") || "").toLowerCase() === "true";
      if (isDialog && (!isModalScope || cur !== scopeRoot) && !isElementVisible(cur)) {
        return true;
      }
      if (cur !== el) {
        if (cur.hidden === true || cur.hasAttribute?.("hidden") || cur.hasAttribute?.("inert")) {
          return true;
        }
        if (String(cur.getAttribute?.("aria-hidden") || "").toLowerCase() === "true") {
          return true;
        }
        const st = window.getComputedStyle ? window.getComputedStyle(cur) : null;
        if (st) {
          if (st.display === "none" || st.visibility === "hidden") return true;
          if (st.opacity === "0" || (st.opacity !== "" && parseFloat(st.opacity) === 0)) return true;
        }
      }
      if (isModalScope && cur === scopeRoot) break;
      cur = cur.parentElement;
    }
    return false;
  }

  function isDisclosureControl(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = String(el.tagName || "").toUpperCase();
    if (tag === "BUTTON" || tag === "SUMMARY") return true;
    if (String(el.getAttribute?.("role") || "").toLowerCase() === "button") return true;
    if (el.hasAttribute?.("aria-expanded") || el.hasAttribute?.("aria-controls")) return true;
    return false;
  }

  function isControlledDisclosurePanel(controlEl, panelEl) {
    if (!controlEl || !panelEl || !isDisclosureControl(controlEl)) return false;
    const controls = String(controlEl.getAttribute?.("aria-controls") || "").trim();
    const panelId = String(panelEl.id || "").trim();
    if (controls && panelId && controls.split(/\s+/).includes(panelId)) return true;
    if (typeof controlEl.closest === "function" && typeof panelEl.closest === "function") {
      const details = controlEl.closest("details");
      if (details && details === panelEl.closest("details")) return true;
    }
    return false;
  }

  function isAllowedAmazonInfoNode(amzInfo) {
    if (!amzInfo || amzInfo.isConnected === false) return false;
    if (document.body && !document.body.contains(amzInfo)) return false;
    if (isInsideExcludedSection(amzInfo, document.body)) return false;
    if (amzInfo.hasAttribute?.("inert")) return false;
    const parent = amzInfo.parentElement;
    if (
      parent &&
      parent !== document.body &&
      parent !== document.documentElement &&
      isInsideHiddenOrCartContainer(parent, null)
    ) {
      return false;
    }
    if (isElementVisible(amzInfo) && !isInsideHiddenOrCartContainer(amzInfo, null)) {
      return true;
    }
    if (isInsideHiddenDialogTabpanelOrCart(amzInfo, null)) return false;
    const expContainer = amzInfo.closest?.(
      '.a-expander-container, [data-a-expander-name], [class*="expander" i], [id*="expander" i], details'
    );
    if (
      expContainer &&
      expContainer !== amzInfo &&
      isElementVisible(expContainer) &&
      !isInsideHiddenOrCartContainer(expContainer, null)
    ) {
      return true;
    }
    const id = String(amzInfo.id || "").trim();
    if (id && /^[A-Za-z0-9_:-]+$/.test(id)) {
      const ctrl = document.querySelector(`[aria-controls="${id}"]`);
      if (ctrl && isElementVisible(ctrl) && !isInsideHiddenOrCartContainer(ctrl, null)) {
        return true;
      }
    }
    if (
      parent &&
      parent !== document.body &&
      parent !== document.documentElement &&
      !/^MAIN$/i.test(parent.tagName || "") &&
      isElementVisible(parent) &&
      !isInsideHiddenOrCartContainer(parent, null)
    ) {
      if (id === "nic-po-expander-content") return true;
      const toggle = parent.querySelector?.(
        '.a-expander-header, button[aria-expanded], [role="button"][aria-expanded], summary'
      );
      if (toggle && isElementVisible(toggle) && !isInsideHiddenOrCartContainer(toggle, null)) {
        return true;
      }
    }
    return false;
  }

  const VISIBLE_TEXT_BLOCK_TAGS = new Set([
    "P",
    "DIV",
    "LI",
    "DT",
    "DD",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "SECTION",
    "ARTICLE",
    "TR",
    "BR",
  ]);
  const VISIBLE_TEXT_SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);

  function extractVisibleText(container, scopeRoot) {
    if (!container || container.nodeType !== 1) return "";
    const stopBoundary = scopeRoot || document.body;
    const isModalScope = Boolean(scopeRoot && scopeRoot !== document.body && scopeRoot !== document.documentElement);
    const parts = [];
    let visits = 0;
    let charCount = 0;

    function walk(node, isRootNode) {
      if (!node || visits > 1500 || charCount > 8000) return;
      if (node.nodeType === 3) {
        const val = String(node.nodeValue || "");
        if (val) {
          parts.push(val);
          charCount += val.length;
        }
        return;
      }
      if (node.nodeType !== 1) return;
      visits++;
      const tag = String(node.tagName || "").toUpperCase();
      if (VISIBLE_TEXT_SKIP_TAGS.has(tag)) return;
      if (!isRootNode) {
        if (node.hidden === true || node.hasAttribute?.("hidden") || node.hasAttribute?.("inert")) return;
        if (String(node.getAttribute?.("aria-hidden") || "").toLowerCase() === "true") return;
        if (isInactiveTabPanel(node) || isCartDrawerNode(node)) return;
        if (isInsideExcludedSection(node, stopBoundary)) return;
        const st = window.getComputedStyle ? window.getComputedStyle(node) : null;
        if (st) {
          if (st.display === "none" || st.visibility === "hidden") return;
          if (st.opacity === "0" || (st.opacity !== "" && parseFloat(st.opacity) === 0)) return;
        }
        const role = String(node.getAttribute?.("role") || "").toLowerCase();
        const isDialog =
          role === "dialog" || String(node.getAttribute?.("aria-modal") || "").toLowerCase() === "true";
        if (isDialog && (!isModalScope || node !== scopeRoot) && !isElementVisible(node)) return;
        if (st && st.display !== "contents" && st.display !== "inline" && typeof node.getBoundingClientRect === "function") {
          const r = node.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;
        }
      }
      const isBlock = !isRootNode && VISIBLE_TEXT_BLOCK_TAGS.has(tag);
      if (isBlock) parts.push("\n");
      if (tag === "BR") return;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        walk(child, false);
        if (visits > 1500 || charCount > 8000) break;
      }
      if (isBlock) parts.push("\n");
    }

    walk(container, true);
    return parts.join("");
  }

  function readIngredients(explicitScope) {
    const modalScope = explicitScope !== undefined ? explicitScope : activeDialogScope();
    const searchRoot = modalScope || document.querySelector("main") || document;
    const stopBoundary = modalScope || document.body;

    // Amazon mobile / desktop collapsed Important Information accordion (only when connected & visible or inside a visible expander)
    if (!modalScope && BASE_STORE === "amazon") {
      const amzNodes = document.querySelectorAll("#importantInformation_feature_div, #nic-po-expander-content");
      for (const amzInfo of amzNodes) {
        if (!isAllowedAmazonInfoNode(amzInfo)) continue;
        const amzTxt = (amzInfo.textContent || "").replace(/\s+/g, " ");
        const amzMatch = amzTxt.match(/\bIngredients\s*:?\s*([\s\S]{12,1800})/i);
        if (amzMatch?.[1]) {
          const cand = amzMatch[1]
            .split(/\b(Allergens?|Contains\s*:|Warnings?|Directions|Nutrition\s+Facts|Distributed\s+by|Legal\s+Disclaimer|Statements\s+regarding)\b/i)[0]
            .trim();
          if (isValidIngredientText(cand)) return cand;
        }
      }
    }

    const candidates = searchRoot.querySelectorAll("h2, h3, h4, dt, strong, b, span, div, p, button, summary");
    for (const el of candidates) {
      if (!isElementVisible(el)) continue;
      if (isInsideExcludedSection(el, stopBoundary)) continue;
      if (isInsideHiddenOrCartContainer(el, modalScope)) continue;
      const own = (el.children.length <= 2 ? el.textContent : "").trim();
      if (!/^ingredients\s*:?$/i.test(own)) continue;

      if (isDisclosureControl(el)) {
        const controls = String(el.getAttribute?.("aria-controls") || "").trim();
        if (controls) {
          for (const ctrlId of controls.split(/\s+/)) {
            const panel = document.getElementById(ctrlId);
            if (!panel) continue;
            if (searchRoot !== document && !searchRoot.contains(panel)) continue;
            if (isInsideExcludedSection(panel, stopBoundary)) continue;
            if (isInsideHiddenDialogTabpanelOrCart(panel, modalScope)) continue;
            const rawPanel =
              isElementVisible(panel) && !isInsideHiddenOrCartContainer(panel, modalScope)
                ? extractVisibleText(panel, modalScope)
                : panel.textContent || "";
            const firstBlock = rawPanel.replace(/\s+/g, " ").trim().split(/\bingredients\s*:/i)[0].trim();
            if (isValidIngredientText(firstBlock)) return firstBlock;
          }
        }
      }

      let sib = el.nextElementSibling;
      for (let i = 0; i < 3 && sib; i++, sib = sib.nextElementSibling) {
        if (isInsideExcludedSection(sib, stopBoundary)) continue;
        const sibVisible = isElementVisible(sib) && !isInsideHiddenOrCartContainer(sib, modalScope);
        const sibControlled =
          !sibVisible &&
          isControlledDisclosurePanel(el, sib) &&
          !isInsideHiddenDialogTabpanelOrCart(sib, modalScope);
        if (!sibVisible && !sibControlled) continue;
        const rawSib = sibVisible ? extractVisibleText(sib, modalScope) : sib.textContent || "";
        const t = rawSib.replace(/\s+/g, " ").trim();
        // If multiple Ingredients blocks exist, stop before any second Ingredients label
        const firstBlock = t.split(/\bingredients\s*:/i)[0].trim();
        if (isValidIngredientText(firstBlock)) return firstBlock;
      }

      const parentEl = el.parentElement;
      if (
        parentEl &&
        isElementVisible(parentEl) &&
        !isInsideExcludedSection(parentEl, stopBoundary) &&
        !isInsideHiddenOrCartContainer(parentEl, modalScope)
      ) {
        const parentText = extractVisibleText(parentEl, modalScope).replace(/\s+/g, " ").trim();
        const stripped = parentText.replace(/^ingredients\s*:?\s*/i, "").split(/\bingredients\s*:/i)[0].trim();
        if (isValidIngredientText(stripped)) return stripped;
      }
    }
    const inline = [...searchRoot.querySelectorAll("p, div, span, li, dd")].find(
      (n) =>
        n.children.length === 0 &&
        isElementVisible(n) &&
        !isInsideExcludedSection(n, stopBoundary) &&
        !isInsideHiddenOrCartContainer(n, modalScope) &&
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

  const AMAZON_NON_GROCERY_CRUMB_RE =
    /\b(electronics|computers\s*&\s*accessories|cell\s+phones|video\s+games|books|kindle\s+store|movies\s*&\s*tv|clothing,\s*shoes|automotive|tools\s*&\s*home\s+improvement|musical\s+instruments|software)\b/i;

  const AMAZON_FOOD_OR_CARE_TITLE_RE =
    /\b(organic|ranch|dressing|mayo|mayonnaise|ketchup|mustard|sauce|salsa|chips|crackers|cookies|cereal|oatmeal|oats|granola|yogurt|milk|cream|cheese|butter|ghee|tallow|oil|bread|bagel|tortilla|pasta|noodles|rice|beans|soup|broth|coffee|tea|espresso|juice|soda|pop|sparkling|water|electrolyte|energy\s+drink|protein|bar|snack|candy|chocolate|gummies|popcorn|pretzels|jerky|nuts|almonds|peanut|butter|jam|jelly|honey|syrup|pancake|waffle|fries|pizza|nuggets|ice\s+cream|supplement|vitamin|collagen|creatine|lotion|shampoo|conditioner|body\s+wash|deodorant|toothpaste|sunscreen)\b/i;

  function isAmazonGroceryPage(modalScope) {
    if (HOST.includes("wholefoods")) return true;
    if (activeBucket.bucketKey === "amazon:wholefoods" || activeBucket.bucketKey === "amazon:fresh") return true;
    const crumbNodes = document.querySelectorAll(
      "#wayfinding-breadcrumbs_feature_div, #breadcrumb_feature_div, [id*='breadcrumb' i], #nav-subnav, #brandByline_feature_div, #bylineInfo, #bylineInfo_feature_div, #almDetailPagePoi, #fresh-merchant-info, #alm-cards-link, a[href*='almBrandId']"
    );
    const crumbText = [...crumbNodes].map((n) => n.textContent || "").join(" ");
    if (AMAZON_NON_GROCERY_CRUMB_RE.test(crumbText)) return false;
    if (
      /\b(grocery|gourmet food|amazon fresh|whole foods|365 by whole foods|happy belly|amazon grocery|pantry|food\s*&\s*beverage|snacks|beverages|health\s*&\s*household|beauty\s*&\s*personal\s*care)\b/i.test(
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
    if (document.querySelector("#nutritionFacts_feature_div, #nic-nutrition-facts, #alm-hero-banner")) {
      return true;
    }
    const title = readTitle(modalScope);
    if (REAL_ING_HINT_RE.test(title) || AMAZON_FOOD_OR_CARE_TITLE_RE.test(title)) return true;
    return Boolean(readIngredients(modalScope));
  }

  function isProductPage() {
    const modalScope = activeDialogScope();
    if (modalScope) return true;

    const p = location.pathname;
    const s = location.search;
    if (isCartPageUrl()) return false;

    if (BASE_STORE === "walmart") return /\/ip\//.test(p);
    if (BASE_STORE === "instacart") return /\/(?:products?|items?)\//.test(p) || /item_id=|product_id=/i.test(s);
    if (BASE_STORE === "target") return /\/p\//.test(p);
    if (BASE_STORE === "kroger") return /\/p\//.test(p);
    if (BASE_STORE === "aldi") {
      return /\/product\//.test(p) || /\/detail\/ps\/p\//.test(p) || (HOST.startsWith("shop.") && /\/products\//.test(p));
    }
    if (BASE_STORE === "doordash") return /\/(products?|items?)\//.test(p) || /item-details|product_id|item_id/i.test(s);
    if (BASE_STORE === "ubereats") return /\/product\//.test(p) || /mod=quickView/i.test(s);
    if (BASE_STORE === "amazon") {
      if (HOST.includes("wholefoods")) return /\/product\//.test(p);
      return /\/(dp|gp\/product|gp\/aw\/d)\//.test(p) && isAmazonGroceryPage(null);
    }
    if (BASE_STORE === "sams") return /\/(p|product|ip|sams\/shop\/product)\//.test(p);
    if (BASE_STORE === "bjs") return /\/product\//.test(p);
    if (BASE_STORE === "costco") return /\/p\/|\.product\./i.test(p);
    if (BASE_STORE === "shipt") return /\/(shop\/)?(?:products?|items?)\//.test(p) || /product_id=|item_id=/i.test(s);
    return false;
  }

  /* ---------------- Multi-Product Grid Card Hover / Focus & Photo Badges ---------------- */
  const NON_FOOD_GRID_HARD_TITLE_RE =
    /\b(?:paper\s+towels?|toilet\s+(?:paper|tissue)|bath\s+tissue|facial\s+tissues?|trash\s+bags?|garbage\s+bags?|aluminum\s+foil|parchment\s+paper|plastic\s+wrap|paper\s+plates?|laundry\s+(?:detergent|pods?|sanitizer)|fabric\s+softener|dryer\s+sheets?|dish\s+(?:soap|detergent)|dishwasher\s+(?:pods?|pac?ks?|detergent)|disinfecting\s+wipes?|bleach|all[- ]purpose\s+cleaner|glass\s+cleaner|toilet\s+bowl\s+cleaner|air\s+freshener|diapers?|pull[- ]ups?|baby\s+wipes?|cat\s+litter|dog\s+(?:food|treats?|pads?)|cat\s+(?:food|treats?)|pet\s+food|alkaline\s+batteries|aa\s+batteries|aaa\s+batteries|motor\s+oil|windshield\s+washer|light\s+bulbs?|toothpaste|toothbrush|mouthwash|shampoo|body\s+wash|deodorant|antiperspirant|razor\s+blades?|shaving\s+cream|sunscreen|tampons?|maxi\s+pads?|pantiliners?|power\s+bank|air\s+fryer|jigsaw\s+puzzle|piece\s+puzzle|hopper\s+ball|bouncer|heated\s+(?:vest|clothing|jacket)|sippy\s+cups?|toddler\s+cups?|training\s+cups?|water\s+bottle\s+(?:with\s+straw|insulated|stainless))\b/i;
  const AMBIGUOUS_PACKAGING_GRID_TITLE_RE = /\b(?:storage\s+bags?|freezer\s+bags?|sandwich\s+bags?|paper\s+cups?)\b/i;
  const FOOD_CONTEXT_FOR_PACKAGING_RE =
    /\b(?:chicken|beef|pork|turkey|salmon|tilapia|cod|tuna|fish|shrimp|scallops?|sausage|bacon|meatballs?|steak|burger|patties|nuggets?|tenders?|strips?|wings?|fries|tater|tots|hash\s*browns?|peas|corn|broccoli|spinach|vegetables?|veggies|berries|strawberries|blueberries|raspberries|mango|fruit|edamame|pizza|burritos?|taquitos?|dumplings?|potstickers?|ravioli|pierogies|waffles?|pancakes?|ice\s+cream|gelato|sorbet|peanut\s+butter|almond\s+butter|chocolate|reese'?s|candy|fudge|muffins?|cupcakes?|coffee|tea|k[- ]?cups?|oatmeal|soup|ramen|noodles|mac(?:aroni)?|cheese)\b/i;
  const BAKING_OR_FOOD_CONDITIONER_RE = /\b(?:dough|bread|bakery|flour|wheat|baking|gluten|food|meat|beer|wort)\b/i;

  function isNonFoodGridTitle(title) {
    const s = String(title || "");
    if (!s) return false;
    if (NON_FOOD_GRID_HARD_TITLE_RE.test(s)) return true;
    if (AMBIGUOUS_PACKAGING_GRID_TITLE_RE.test(s) && !FOOD_CONTEXT_FOR_PACKAGING_RE.test(s)) return true;
    if (/\bconditioner\b/i.test(s) && !BAKING_OR_FOOD_CONDITIONER_RE.test(s)) return true;
    return false;
  }

  const PRODUCT_CARD_SEL = [
    "[data-item-id]",
    '[data-testid="item-stack"] > div',
    '[data-testid*="list-view" i]',
    '[data-testid*="product-card" i]',
    '[data-testid*="product_card" i]',
    '[data-testid*="item-card" i]',
    '[data-testid^="item_list_item" i]',
    '[data-testid*="product-tile" i]',
    '[data-testid*="RetailItem" i]',
    '[data-testid*="StoreItem" i]',
    '[data-testid*="MenuItem" i]',
    '[data-testid*="store-item" i]',
    '[data-testid*="grid-item" i]',
    '[data-testid*="shelf-item" i]',
    '[data-test*="product-card" i]',
    '[data-test*="product-tile" i]',
    '[data-test*="@web/site-top-of-funnel/ProductCardWrapper"]',
    '[data-qa*="product-card" i]',
    '[data-qa*="item-card" i]',
    '[data-qa*="product-tile" i]',
    '[data-automation-id="product-tile"]',
    '[data-automation-id*="product-tile" i]',
    '[data-automation-id*="product-card" i]',
    '[automation-id*="productTile" i]',
    '[data-component-type="s-search-result"]',
    '[data-csa-c-type="productTile"]',
    'li[data-csa-c-type="item"][data-csa-c-item-id*="asin."]',
    'div[class*="s-result-item"][data-asin]:not([data-asin=""])',
    '[data-asin]:not([data-asin=""])',
    "app-product-card",
    '[auto-data*="productCard" i]',
    '[class*="sc-pc-" i][class*="card" i]',
    '[class*="ProductCard" i]',
    '[class*="CardTemplate-Horizontal"]',
    '[class*="ItemCard" i]',
    '[class*="product-tile" i]',
    'article[class*="product" i]',
    'li[class*="product" i]',
  ].join(", ");

  const EXPLICIT_PRODUCT_CARD_SEL = [
    "[data-item-id]",
    '[data-asin]:not([data-asin=""])',
    '[data-component-type="s-search-result"]',
    '[data-csa-c-type="productTile"]',
    'li[data-csa-c-type="item"][data-csa-c-item-id*="asin."]',
    '[data-test*="@web/site-top-of-funnel/ProductCardWrapper"]',
    '[data-testid*="product-card" i]',
    '[data-testid*="product_card" i]',
    '[data-testid*="item-card" i]',
    '[data-testid^="item_list_item" i]',
    '[data-testid*="product-tile" i]',
    '[data-testid*="RetailItem" i]',
    '[data-testid*="StoreItem" i]',
    '[data-testid*="store-item" i]',
    '[data-test*="product-card" i]',
    '[data-qa*="product-card" i]',
    '[data-automation-id="product-tile"]',
    '[automation-id*="productTile" i]',
    "app-product-card",
    '[auto-data*="productCard" i]',
    '[class*="ProductCard" i]',
    '[class*="CardTemplate-Horizontal"]',
    '[class*="product-tile" i]',
  ].join(", ");

  const MULTI_CARD_UNIT_SEL = [
    "[data-item-id]",
    '[data-asin]:not([data-asin=""])',
    '[data-component-type="s-search-result"]',
    '[data-csa-c-type="productTile"]',
    '[data-test*="@web/site-top-of-funnel/ProductCardWrapper"]',
    '[data-testid*="product-card" i]',
    '[data-testid*="product_card" i]',
    '[data-testid*="item-card" i]',
    '[data-testid^="item_list_item" i]',
    '[data-testid*="product-tile" i]',
    '[data-testid*="RetailItem" i]',
    '[data-testid*="StoreItem" i]',
    '[data-testid*="MenuItem" i]',
    '[data-testid*="store-item" i]',
    '[data-qa*="product-card" i]',
    '[data-automation-id="product-tile"]',
    "app-product-card",
    '[auto-data*="productCard" i]',
    '[class*="CardTemplate-Horizontal"]',
  ].join(", ");

  const DEFINITIVE_SINGLE_CARD_SEL = [
    '[data-component-type="s-search-result"]',
    '[data-csa-c-type="productTile"]',
    'li[data-csa-c-type="item"][data-csa-c-item-id*="asin."]',
    "[data-item-id]",
    '[data-test*="@web/site-top-of-funnel/ProductCardWrapper"]',
    '[data-testid^="item_list_item" i]',
    '[data-testid*="RetailItem" i]',
    '[data-testid*="store-item" i]',
    '[auto-data*="productCard" i]',
  ].join(", ");

  const PRODUCT_LINK_FALLBACK_SEL =
    'a[data-csa-c-type="productTile"], a[link-identifier], a[href*="/sp/track"], a[href*="/gp/slredirect"], a[href*="/ip/"], a[href*=".product."], a[href*="/products/"], a[href*="/product/"], a[href*="/items/"], a[href*="item_id="], a[href*="product_id="], a[href*="/p/"], a[href*="/sams/shop/product/"], a[href*="/detail/ps/p/"], a[href*="/dp/"], a[href*="/gp/aw/d/"]';

  const CARD_CTA_NOISE_RE =
    /^(?:(?:\+\s*)?add(?:\s+to\s+(?:cart|bag|list|order))?|choose\s+options?|options?|select(?:\s+options?)?|view(?:\s+details|\s+item|\s+product)?|shop\s+now|quick\s+(?:add|look|shop|view)|sign\s+in(?:\s+to\s+add)?|out\s+of\s+stock|in\s+stock|many\s+in\s+stock|low\s+stock|sold\s+out|unavailable|notify\s+me|subscribe(?:\s*&\s*save)?|clip(?:\s+coupon)?|coupon(?:\s+available)?|sponsored|best\s+seller|overall\s+pick|popular(?:\s+pick)?|rollback|clearance|sale|deal|snap(?:\s+ebt)?(?:\s+eligible)?|ebt(?:\s+eligible)?|pickup|delivery|shipping|free\s+(?:shipping|pickup|delivery).*|save\s+\$?\d.*|\$?\d+(?:\.\d+)?\s+off\b.*|\d+%\s+off\b.*|buy\s+\d+.*get\s+\d+.*|bogo\b.*|\d+%\s*(?:\(\d+\))?|\d+(?:\.\d+)?\s*(?:stars?|out\s+of\s+5).*|\d+\s*(?:cal|kcal|calories?)\b.*|\$?\d+(?:\.\d+)?\s*\/\s*[a-z]+.*|\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|oz|lb|lbs|gal|qt|pt|ml|l|g|kg|ct|count|pk|pack)\b)$/i;
  const PRICE_RATING_NOISE_RE =
    /\$\s*\d|\b\d+(?:\.\d+)?\s*¢|\b(?:current|was|now|sale|unit|list)\s+price\b|\b\d(?:\.\d)?\s+out\s+of\s+5\b|\b\d[\d,]*\s+reviews?\b|★/i;

  function isValidGs1Barcode(code) {
    const digits = String(code || "").replace(/\D/g, "");
    if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(digits)) return false;
    if (/^0+$/.test(digits)) return false;
    let sum = 0;
    const len = digits.length;
    for (let i = 0; i < len - 1; i++) {
      const d = digits.charCodeAt(len - 2 - i) - 48;
      sum += i % 2 === 0 ? d * 3 : d;
    }
    const check = (10 - (sum % 10)) % 10;
    return check === digits.charCodeAt(len - 1) - 48;
  }

  function unwrapProductHref(rawHref) {
    let h = String(rawHref || "").trim();
    if (!h) return "";
    for (let pass = 0; pass < 2; pass++) {
      const m = h.match(/[?&](?:rd|url|redirect|dest|destination|target|u)=([^&#]+)/i);
      if (!m || !m[1]) break;
      try {
        const dec = decodeURIComponent(m[1]);
        if (dec && dec !== h) {
          h = dec;
          continue;
        }
      } catch {
        /* ignore */
      }
      break;
    }
    try {
      if (/%2F/i.test(h) && !/\//.test(h.replace(/^https?:\/\/[^/]+/i, ""))) {
        h = decodeURIComponent(h);
      }
    } catch {
      /* ignore */
    }
    return h;
  }

  function isRealProductHrefPath(rawHref) {
    const unwrapped = unwrapProductHref(rawHref);
    let pathOnly = unwrapped.split("#")[0].split("?")[0];
    try {
      if (/^https?:\/\//i.test(unwrapped)) {
        pathOnly = new URL(unwrapped).pathname || "";
      }
    } catch {
      /* ignore */
    }
    if (
      !pathOnly ||
      pathOnly === "/" ||
      /^\/(?:browse|cp|c|categories|category|departments|aisles|fmc|stores|shop\/categories|all-departments|my-items)\b/i.test(pathOnly)
    ) {
      if (/[?&](?:item_id|product_id)=/i.test(unwrapped)) return unwrapped.split("#")[0];
      return "";
    }
    if (
      /(\/ip\/|\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/sams\/shop\/product\/|\.product\.|\/p\/|\/products?\/|\/items?\/|\/detail\/ps\/p\/)/i.test(
        pathOnly
      ) ||
      /[?&](?:item_id|product_id)=/i.test(unwrapped)
    ) {
      return unwrapped.split("#")[0];
    }
    return "";
  }

  function hasMultipleDistinctProductLinks(el) {
    if (!el || typeof el.querySelectorAll !== "function") return false;
    if (el.matches?.(DEFINITIVE_SINGLE_CARD_SEL) && el.querySelectorAll(DEFINITIVE_SINGLE_CARD_SEL).length === 0) {
      return false;
    }
    if (el.querySelectorAll(MULTI_CARD_UNIT_SEL).length > 1) return true;
    const pLinks = el.querySelectorAll(PRODUCT_LINK_FALLBACK_SEL);
    if (pLinks.length <= 1) return false;
    let firstKey = "";
    for (const a of pLinks) {
      const csaId = a.getAttribute?.("data-csa-c-content-id") || "";
      const key = csaId || isRealProductHrefPath(a.getAttribute?.("href") || "");
      if (!key) continue;
      if (!firstKey) firstKey = key;
      else if (key !== firstKey) return true;
    }
    return false;
  }

  function humanizeProductSlug(slug) {
    let s = String(slug || "");
    try {
      s = decodeURIComponent(s);
    } catch {
      /* ignore */
    }
    s = s
      .replace(/\.(?:html?|aspx?)$/i, "")
      .replace(/[-_+]+/g, " ")
      .replace(/\b([sS])\s+mores\b/g, "$1'mores")
      .replace(/\s+/g, " ")
      .trim();
    if (
      s.length < 6 ||
      s.length > 240 ||
      !/[a-zA-Z]{3}/.test(s) ||
      /^\d+$/.test(s) ||
      NON_TITLE_RE.test(s) ||
      CARD_CTA_NOISE_RE.test(s)
    ) {
      return "";
    }
    return s;
  }

  function extractSlugFromPath(unwrappedHref) {
    let pathOnly = String(unwrappedHref || "").split("#")[0].split("?")[0];
    pathOnly = pathOnly.replace(/^https?:\/\/[^/]+/i, "");
    if (!pathOnly) return "";
    let m = pathOnly.match(/\/ip\/([^/]+)\/\d{4,20}(?:\/|$)/i);
    if (m && m[1] && !/^(?:seort|track)$/i.test(m[1])) return humanizeProductSlug(m[1]);
    m = pathOnly.match(/\/p\/([^/]+)\/(?:-\/A-\d+|\d{5,20})(?:\/|$)/i);
    if (m && m[1]) return humanizeProductSlug(m[1]);
    m = pathOnly.match(/\/([^/]+)\.product\.\d+/i);
    if (m && m[1]) return humanizeProductSlug(m[1]);
    m = pathOnly.match(/\/sams\/shop\/product\/([^/]+)\/[A-Za-z0-9_-]+/i);
    if (m && m[1]) return humanizeProductSlug(m[1]);
    m = pathOnly.match(/\/([^/]+)\/dp\/[A-Z0-9]{10}(?:\/|$)/i);
    if (m && m[1] && !/^(?:gp|product)$/i.test(m[1])) return humanizeProductSlug(m[1]);
    m = pathOnly.match(/\/(?:products?|items?)\/(?:\d+-)?([a-zA-Z][^/]{5,200})(?:\/|$)/i);
    if (m && m[1] && !/^\d+$/.test(m[1])) return humanizeProductSlug(m[1]);
    return "";
  }

  function recoverFromCardLinks(cardEl, visibleTitle) {
    let bestTitle = String(visibleTitle || "");
    const isTruncated = !bestTitle || /(?:\.\.\.|…|[,(\/-])\s*$|\([^)]*$/.test(bestTitle);
    const stem = bestTitle
      ? bestTitle
          .replace(/(?:\.\.\.|…|[,(\/-])\s*$/, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim()
          .slice(0, 18)
      : "";
    let barcode = "";
    const attrNames = ["data-upc", "data-gtin", "data-ean", "data-barcode"];
    for (const an of attrNames) {
      let rawCode = cardEl.getAttribute ? cardEl.getAttribute(an) || "" : "";
      if (!rawCode && cardEl.querySelector) {
        const sub = cardEl.querySelector(`[${an}]`);
        if (sub) rawCode = sub.getAttribute(an) || "";
      }
      const digits = String(rawCode).replace(/\D/g, "");
      if (isValidGs1Barcode(digits)) {
        barcode =
          digits.length === 14 && digits.startsWith("00")
            ? digits.slice(2)
            : digits.length === 14 && digits.startsWith("0")
              ? digits.slice(1)
              : digits;
        break;
      }
    }
    let bestHrefKey = "";
    const links = cardEl.querySelectorAll ? cardEl.querySelectorAll("a[href]") : [];
    for (const a of links) {
      if (a.closest?.(".cc-photo-badge, .cc-photo-badge-slot")) continue;
      const rawHref = String(a.getAttribute("href") || "");
      const unwrapped = unwrapProductHref(rawHref);
      const cleanPath = unwrapped.split("#")[0].split("?")[0];
      if (!bestHrefKey && cleanPath) {
        bestHrefKey = cleanPath.slice(0, 160);
      }
      if (!barcode && cleanPath) {
        const bm = cleanPath.match(/(?:^|\/)(\d{12,14})(?:[/?#.]|$)/);
        if (bm && bm[1] && isValidGs1Barcode(bm[1])) {
          const bc = bm[1];
          barcode =
            bc.length === 14 && bc.startsWith("00")
              ? bc.slice(2)
              : bc.length === 14 && bc.startsWith("0")
                ? bc.slice(1)
                : bc;
        }
      }
      if (isTruncated) {
        const ariaCand = cleanProductTitleText(a.getAttribute("aria-label") || a.getAttribute("title") || "");
        if (
          ariaCand &&
          ariaCand.length > bestTitle.length &&
          ariaCand.length <= 240 &&
          !/(?:\.\.\.|…)\s*$/.test(ariaCand) &&
          !NON_TITLE_RE.test(ariaCand) &&
          !CARD_CTA_NOISE_RE.test(ariaCand) &&
          !PRICE_RATING_NOISE_RE.test(ariaCand)
        ) {
          const normAria = ariaCand.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          if (!stem || normAria.startsWith(stem)) {
            bestTitle = ariaCand;
          }
        }
      }
      if (!bestTitle || /(?:\.\.\.|…|[,(\/-])\s*$|\([^)]*$/.test(bestTitle)) {
        const slugCand = extractSlugFromPath(cleanPath);
        if (slugCand && !PRICE_RATING_NOISE_RE.test(slugCand)) {
          const normSlug = slugCand.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          if (!bestTitle) {
            bestTitle = slugCand;
          } else if (slugCand.length > bestTitle.length - 2 && (!stem || normSlug.startsWith(stem.slice(0, 12)))) {
            bestTitle = slugCand;
          }
        }
      }
    }
    return { title: bestTitle, barcode, hrefKey: bestHrefKey };
  }

  function readProductCardInfo(cardEl) {
    if (!cardEl || host?.contains(cardEl)) return null;
    if (cardEl.closest('header, nav, footer, [role="contentinfo"]')) return null;
    if (isCartDrawerElement(cardEl.closest('[role="dialog"], aside, section'))) return null;

    const titleSelectors = [
      '[data-automation-id="product-title"]',
      '[data-automation-id*="product-title" i]',
      '[data-test="product-title"]',
      '[data-test*="product-title" i]',
      '[data-test*="item-title" i]',
      '[data-testid*="product-title" i]',
      '[data-testid*="item-title" i]',
      '[data-testid*="item-name" i]',
      '[data-testid*="product-name" i]',
      '[data-testid*="product-card-name" i]',
      '[data-testid*="product-card-description" i]',
      '[data-testid*="store-item-title" i]',
      '[data-telemetry-id*="storeItem.title" i]',
      '[data-test="product-card-title"]',
      '[auto-data="productTitle"]',
      '[auto-data*="product_name" i]',
      '[automation-id*="productDescriptionLink" i]',
      '[data-qa*="product-name" i]',
      '[data-qa*="item-name" i]',
      '[class*="sc-pc-title" i]',
      ".product-tile__name",
      ".base-product-tile__name",
      '[class*="ProductCard-name" i]',
      '[class*="ProductTitle" i]',
      "a[link-identifier]",
      "span.w_iUH7",
      '[class*="w_iUH7"]',
      "h2 a span",
      "h3 a span",
      "h4 a span",
      "h2",
      "h3",
      "h4",
      '[data-testid="rich-text"]',
      'a[data-csa-c-type="productTile"]',
      'a[href*="/sp/track"]',
      'a[href*="/gp/slredirect"]',
      'a[href*="/ip/"]',
      'a[href*=".product."]',
      'a[href*="/sams/shop/product/"]',
      'a[href*="/p/"]',
      'a[href*="/dp/"]',
      'a[href*="/gp/aw/d/"]',
      'a[href*="/products/"]',
      'a[href*="/items/"]',
      'a[href*="/detail/ps/p/"]',
      'a[href*="/product/"]',
    ];
    let title = "";
    let matchedHref = "";
    for (const sel of titleSelectors) {
      const els = cardEl.querySelectorAll(sel);
      for (const el of els) {
        if (el.classList?.contains?.("cc-photo-badge") || el.closest?.(".cc-photo-badge, .cc-photo-badge-slot")) continue;
        const raw = cleanProductTitleText(el?.getAttribute?.("aria-label") || el?.textContent || "");
        if (
          raw &&
          raw.length >= 5 &&
          raw.length <= 240 &&
          !NON_TITLE_RE.test(raw) &&
          !CARD_CTA_NOISE_RE.test(raw) &&
          !PRICE_RATING_NOISE_RE.test(raw)
        ) {
          title = raw;
          const linkEl = el.tagName === "A" ? el : el.closest?.("a[href]") || el.querySelector?.("a[href]");
          matchedHref = linkEl?.getAttribute?.("href") || "";
          break;
        }
      }
      if (title) break;
    }
    if (title && /(?:\.\.\.|…)\s*$/.test(title)) {
      const stem = title.replace(/(?:\.\.\.|…)\s*$/, "").trim().toLowerCase().slice(0, 24);
      for (const fullSel of ['[data-automation-id*="product-title" i]', "a[link-identifier]", "a[aria-label]", "span.w_iUH7", '[class*="w_iUH7"]']) {
        for (const fel of cardEl.querySelectorAll(fullSel)) {
          if (fel.closest?.(".cc-photo-badge, .cc-photo-badge-slot")) continue;
          const fullCand = cleanProductTitleText(fel?.getAttribute?.("aria-label") || fel?.textContent || "");
          if (
            fullCand &&
            fullCand.length > title.length &&
            fullCand.length <= 240 &&
            !/(?:\.\.\.|…)\s*$/.test(fullCand) &&
            !NON_TITLE_RE.test(fullCand) &&
            !CARD_CTA_NOISE_RE.test(fullCand) &&
            !PRICE_RATING_NOISE_RE.test(fullCand) &&
            (!stem || fullCand.toLowerCase().startsWith(stem))
          ) {
            title = fullCand;
            break;
          }
        }
        if (!/(?:\.\.\.|…)\s*$/.test(title)) break;
      }
    }
    let domImageUrl = null;
    let primaryImgEl = null;
    let bestImgRank = -999;
    const cardRect = typeof cardEl.getBoundingClientRect === "function" ? cardEl.getBoundingClientRect() : null;
    const promoSlideAltRe =
      /\b(?:satisfaction\s+guaranteed|money\s+back\s+guarantee|100%\s+guaranteed|quality\s+guaranteed|freshness\s+guaranteed|shopping\s+(?:basket|cart|bag)|checkout\s+conveyor|in\s+a\s+(?:blue|red|green|white|wooden|wicker)\s+(?:basket|bowl|cart)|promotional\s+banner|hero\s+banner)\b/i;
    const imgs = cardEl.querySelectorAll("img");
    let idx = 0;
    for (const img of imgs) {
      idx++;
      if (img.closest?.(".cc-photo-badge, .cc-photo-badge-slot")) continue;
      const rawAlt = cleanProductTitleText(img.getAttribute("alt") || "");
      const isPromoAlt = promoSlideAltRe.test(rawAlt);
      if (!title && !isPromoAlt) {
        if (
          rawAlt &&
          rawAlt.length >= 6 &&
          rawAlt.length <= 240 &&
          !NON_TITLE_RE.test(rawAlt) &&
          !CARD_CTA_NOISE_RE.test(rawAlt) &&
          !/^(?:product(?:\s+image)?|thumbnail|photo|image)$/i.test(rawAlt) &&
          !PRICE_RATING_NOISE_RE.test(rawAlt)
        ) {
          title = rawAlt;
        }
      }
      const cand = sanitizeDomImageUrl(img.currentSrc || img.getAttribute("src") || "", img);
      const r = img.getBoundingClientRect();
      const pr = img.parentElement?.getBoundingClientRect?.() || r;
      const boxR = r.width >= 24 && r.height >= 24 ? r : pr;
      const horizVisible =
        !cardRect ||
        cardRect.width < 40 ||
        (boxR.right > cardRect.left + 12 && boxR.left < cardRect.right - 12);
      const rank =
        (horizVisible ? 40 : -30) +
        (isPromoAlt ? -25 : 0) +
        (cand ? 10 : 0) +
        (idx === 1 ? 6 : 0);
      if (rank > bestImgRank) {
        bestImgRank = rank;
        primaryImgEl = img;
        if (cand) domImageUrl = cand;
      } else if (cand && !domImageUrl && !isPromoAlt) {
        domImageUrl = cand;
      }
    }
    if (!title) {
      for (const aEl of cardEl.querySelectorAll("a[href]")) {
        if (aEl.closest?.(".cc-photo-badge, .cc-photo-badge-slot")) continue;
        const aCand = cleanProductTitleText(aEl.getAttribute("aria-label") || aEl.textContent || "");
        if (
          aCand &&
          aCand.length >= 6 &&
          aCand.length <= 240 &&
          !NON_TITLE_RE.test(aCand) &&
          !CARD_CTA_NOISE_RE.test(aCand) &&
          !PRICE_RATING_NOISE_RE.test(aCand)
        ) {
          title = aCand;
          matchedHref = matchedHref || aEl.getAttribute("href") || "";
          break;
        }
      }
    }
    const rec = recoverFromCardLinks(cardEl, title);
    title = rec.title;
    if (!title || isNonFoodGridTitle(title)) return null;
    if (!isCartPageUrl()) {
      const hasExplicitCardSignal = Boolean(
        cardEl.matches?.(EXPLICIT_PRODUCT_CARD_SEL) || cardEl.querySelector?.(EXPLICIT_PRODUCT_CARD_SEL)
      );
      if (!hasExplicitCardSignal) {
        let hasProdHref = false;
        for (const aEl of cardEl.querySelectorAll("a[href]")) {
          if (isRealProductHrefPath(aEl.getAttribute("href") || "")) {
            hasProdHref = true;
            break;
          }
        }
        if (!hasProdHref && cardEl.tagName === "A" && isRealProductHrefPath(cardEl.getAttribute("href") || "")) {
          hasProdHref = true;
        }
        if (!hasProdHref && !/\$\s*\d|\b\d+\s*¢/.test(cardEl.textContent || "")) {
          return null;
        }
      }
    }
    const effectiveHref = rec.hrefKey || unwrapProductHref(matchedHref) || matchedHref;
    const itemId = extractRetailerItemIdFromUrlOrNode(effectiveHref, cardEl);
    return {
      title,
      barcode: rec.barcode || "",
      hrefKey: rec.hrefKey || "",
      image: domImageUrl,
      domImageUrl,
      imgEl: primaryImgEl,
      itemId,
    };
  }

  /* ---------------- Live Store Cart Scraping & Instant Deletion Sync ---------------- */
  function isCartPageUrl() {
    const p = location.pathname.toLowerCase();
    return (
      /\/(?:cart|bag|basket)(?:\/|$)/.test(p) ||
      /\/gp\/cart\//.test(p) ||
      /\/checkout\/cart/.test(p) ||
      /\/checkoutcart(?:display)?view(?:\/|$|\.)/.test(p) ||
      /\/store\/cart/.test(p) ||
      /\/shop\/cart/.test(p)
    );
  }

  function isOrderConfirmationPage() {
    const p = location.pathname.toLowerCase();
    const full = `${p}${location.search.toLowerCase()}`;
    if (
      /\/(?:thank-?you|order-?confirmation|orders\/confirmation|checkout\/confirmation|buy\/thankyou|gp\/buy\/thankyou)(?:\/|$|\?)/i.test(
        full
      )
    ) {
      return true;
    }
    // Never treat order-history list pages (/orders, /your-orders, /account/orders) as post-checkout confirmation
    if (/\/(?:your-?orders|order-?history|my-?orders)(?:\/|$)/i.test(p) || /\/orders\/?$/i.test(p)) {
      return false;
    }
    if (/\/(?:checkout|order|purchase|buy|confirmation|complete)(?:\/|$|-|_)/i.test(p)) {
      const headings = document.querySelectorAll("h1, h2, [role='heading']");
      for (let i = 0; i < headings.length && i < 20; i++) {
        const txt = (headings[i].textContent || "").replace(/\s+/g, " ").trim();
        if (
          /\b(?:thank\s+you\s+for\s+your\s+order|your\s+order\s+is\s+confirmed|order\s+placed|we['’]?ve\s+received\s+your\s+order)\b/i.test(
            txt
          )
        ) {
          return true;
        }
      }
    }
    return false;
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
          "#sc-active-cart, [data-testid*='cart-page' i], [data-test*='cart-container' i], [data-qa*='cart' i], [automation-id*='cart' i], [id*='cart-items' i], [id*='order-items' i], main"
        ) || document.body
      );
    }
    return null;
  }

  const EMPTY_CART_RE =
    /\b(your\s+(?:shopping\s+)?(?:cart|bag|basket|order|amazon\s+cart|instacart\s+cart|walmart\s+cart|target\s+cart|costco\s+cart)\s+is\s+(?:currently\s+)?empty|0\s+items?\s+in\s+(?:your\s+)?(?:cart|bag|basket)|you\s+have\s+no\s+items\s+in\s+your\s+(?:cart|bag)|nothing\s+in\s+your\s+(?:cart|bag)|time\s+to\s+start\s+shopping|ready\s+to\s+fill\s+your\s+cart)\b/i;

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
    '[automation-id*="cartItem" i]',
    '[automation-id*="cart-item" i]',
    '[automation-id*="orderItem" i]',
    '[automation-id*="cart" i]',
    '[data-item-id]',
    "li",
    "article",
  ];

  function isInsideCartExcludedArea(el, cartRoot) {
    if (!el || typeof el.closest !== "function") return false;
    if (el.closest('#sc-saved-cart, [data-testid*="saved" i], [data-test*="savedForLater" i], [data-testid*="buy-again" i], [data-testid*="recommend" i], [data-testid*="upsell" i], [data-testid*="addon" i]')) {
      return true;
    }
    if (el.querySelectorAll) {
      let hasMoveToCart = false;
      let hasSaveForLater = false;
      for (const btn of el.querySelectorAll("button, a[role='button'], [role='button']")) {
        const bTxt = (btn.textContent || btn.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        if (/^move\s+to\s+(?:cart|bag)$/i.test(bTxt)) hasMoveToCart = true;
        if (/^save\s+for\s+later$/i.test(bTxt)) hasSaveForLater = true;
      }
      if (hasMoveToCart && !hasSaveForLater) return true;
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
      '[automation-id*="productTitle" i]',
      '[automation-id*="itemTitle" i]',
      '[data-testid*="item-title" i]',
      '[data-testid*="product-title" i]',
      '[data-testid*="cart-item-title" i]',
      '[data-testid*="line-item-name" i]',
      'a[href*=".product."]',
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
    let matchedHref = "";
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
          const linkEl = n.tagName === "A" ? n : n.closest?.("a[href]") || n.querySelector?.("a[href]");
          matchedHref = linkEl?.getAttribute?.("href") || "";
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
    const itemId = extractRetailerItemIdFromUrlOrNode(matchedHref, rowEl);
    return { title, image: domImageUrl, domImageUrl, itemId };
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

  function clickNativeCartRemoveButton(targetTitle, targetItemId = "") {
    if (!targetTitle && !targetItemId) return false;
    const cartRoot = detectOpenCartRoot();
    if (!cartRoot) return false;

    const nativeRemoveSelectors = [
      '[data-test="cartItem-deleteBtn"]',
      'button[data-test*="delete" i]',
      'button[data-test*="remove" i]',
      '[data-automation-id*="remove" i]',
      '[automation-id*="remove" i]',
      '[automation-id*="delete" i]',
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

    const targetEntry = { title: targetTitle, key: targetTitle, itemId: targetItemId };

    for (const sel of CART_ROW_SELECTORS) {
      const rows = cartRoot.querySelectorAll(sel);
      for (const row of rows) {
        if (!isElementVisible(row) || isInsideCartExcludedArea(row, cartRoot)) continue;
        const subProductLinks = row.querySelectorAll('a[href*="/ip/"], a[href*="/p/"], a[href*="/dp/"], a[href*="/products/"], a[href*=".product."]');
        const distinctHrefs = new Set([...subProductLinks].map((a) => (a.getAttribute("href") || "").split("?")[0]).filter(Boolean));
        if (distinctHrefs.size > 1) continue;

        const info = extractRowTitleAndImage(row);
        if (!info || !isSameCartEntry(info, targetEntry)) continue;

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
    if (isOrderConfirmationPage()) return false;
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
        const subProductLinks = row.querySelectorAll('a[href*="/ip/"], a[href*="/p/"], a[href*="/dp/"], a[href*="/products/"], a[href*=".product."]');
        const distinctHrefs = new Set([...subProductLinks].map((a) => (a.getAttribute("href") || "").split("?")[0]).filter(Boolean));
        if (distinctHrefs.size > 1) continue;

        // Require cart row context: quantity control, remove button, or price
        const rowText = (row.textContent || "").replace(/\s+/g, " ");
        const hasRowControl =
          /\$\s*\d+/.test(rowText) ||
          Boolean(
            row.querySelector(
              'input[type="number"], select, [data-test="cartItem-deleteBtn"], [data-qa*="remove" i], [data-automation-id*="remove" i], [automation-id*="remove" i], [automation-id*="delete" i], [automation-id*="quantity" i], input[value*="Delete" i], button[aria-label*="remove" i], button[aria-label*="delete" i], button[aria-label*="quantity" i], [data-testid*="remove" i], [data-testid*="quantity" i]'
            )
          );
        if (!hasRowControl) continue;

        const info = extractRowTitleAndImage(row);
        if (!info) continue;
        const qty = extractRowQuantity(row);
        if (qty <= 0) continue;

        visitedEls.add(row);
        const norm = normalizeTitleForMatch(info.title);
        const rowItemId = String(info.itemId || "").trim();
        if (!norm || isCartKeyDismissed(norm, rowItemId)) continue;
        const mapKey = rowItemId ? `id:${rowItemId}` : `title:${norm}`;
        const prev = scrapedMap.get(mapKey);
        if (prev) {
          if (info.domImageUrl && !prev.domImageUrl) prev.domImageUrl = info.domImageUrl;
          if (rowItemId && !prev.itemId) prev.itemId = rowItemId;
        } else if (scrapedMap.size < MAX_CART_ITEMS) {
          scrapedMap.set(mapKey, {
            title: info.title,
            itemId: rowItemId,
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
        (c) => !isCartItemDismissed(c.title, c.itemId) && !isCartItemDismissed(c.key, c.itemId)
      );
      if (filteredExisting.length !== state.cartItems.length) {
        state.cartItems = filteredExisting;
        state.displayedAvg = calcCartAvg();
        saveBucketCart();
        render();
      }
      return false;
    }

    const now = Date.now();
    let changed = false;
    const nextCart = [];
    const toAudit = [];
    const matchedExistingIndices = new Set();

    for (const scraped of scrapedList) {
      const existingIdx = state.cartItems.findIndex(
        (c, idx) => !matchedExistingIndices.has(idx) && isSameCartEntry(c, scraped)
      );
      if (existingIdx !== -1) {
        matchedExistingIndices.add(existingIdx);
        const existing = state.cartItems[existingIdx];
        if (
          existing.quantity !== scraped.quantity ||
          (scraped.domImageUrl && existing.domImageUrl !== scraped.domImageUrl) ||
          (scraped.itemId && existing.itemId !== scraped.itemId)
        ) {
          changed = true;
        }
        const updated = {
          ...existing,
          itemId: scraped.itemId || existing.itemId || "",
          updatedAt: now,
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
          itemId: scraped.itemId || "",
          updatedAt: now,
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
        for (let prevIdx = 0; prevIdx < state.cartItems.length; prevIdx++) {
          if (nextCart.length >= MAX_CART_ITEMS) break;
          if (matchedExistingIndices.has(prevIdx)) continue;
          const prevItem = state.cartItems[prevIdx];
          if (isCartItemDismissed(prevItem.title, prevItem.itemId) || isCartItemDismissed(prevItem.key, prevItem.itemId)) continue;
          const alreadyInNext = nextCart.some((n) => isSameCartEntry(n, prevItem));
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
        if (
          nextCart[i]?.key !== state.cartItems[i]?.key ||
          (nextCart[i]?.itemId || "") !== (state.cartItems[i]?.itemId || "")
        ) {
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
    const snapId = String(snap.itemId || "").trim();
    if (snapId) {
      const byId = items.findIndex((c) => String(c?.itemId || "").trim() === snapId);
      if (byId !== -1) return byId;
    }
    return items.findIndex((c) => {
      const cId = String(c?.itemId || "").trim();
      if (snapId && cId && snapId !== cId) return false;
      if (
        snap.normKey &&
        !hasConflictingCartVariants(c.title || c.key, snap.title || snap.key) &&
        (normalizeTitleForMatch(c.key) === snap.normKey ||
          normalizeTitleForMatch(c.title) === snap.normKey)
      ) {
        return true;
      }
      return isSameCartEntry(c, snap);
    });
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
      ? state.cartItems.filter((c) => !isCartItemDismissed(c.title, c.itemId) && !isCartItemDismissed(c.key, c.itemId))
      : state.cartItems.filter(
          (c) =>
            !isCartItemDismissed(c.title, c.itemId) &&
            !isCartItemDismissed(c.key, c.itemId) &&
            (queuedTitles.length > 0
              ? queuedTitles.some((t) => isSameCartTitle(c.title, t) || isSameCartTitle(c.key, t))
              : c.pending || (c.score === null && !c.isNonFood))
        );

    const requestSnapshots = targetItems.slice(0, MAX_CART_ITEMS).map((item) => ({
      key: item.key,
      title: item.title,
      itemId: item.itemId || "",
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
        if (isCartKeyDismissed(snap.normKey, snap.itemId) || isCartItemDismissed(snap.title, snap.itemId)) continue;

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
        const scanHasDietAlert = Array.isArray(scanRes.dietaryAlerts) && scanRes.dietaryAlerts.length > 0;
        if (candidates.length > 0 && !isNonFood && (scanRes.result?.score < 75 || scanHasDietAlert)) {
          const stockRes = await resolveFirstInStockSwap(candidates, scanRes.swap, capturedBucket);
          if (resolveStoreBucket().bucketKey !== capturedBucket || activeBucket.bucketKey !== capturedBucket) {
            return;
          }
          if (isCartKeyDismissed(snap.normKey, snap.itemId) || isCartItemDismissed(snap.title, snap.itemId)) {
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
          brand: scanRes.product?.brand || cur.brand || "",
          image: cur.image || serverVerifiedImg || null,
          imageKind: scanRes.product?.imageKind || cur.imageKind || null,
          categoryArtUrl: scanRes.product?.categoryArtUrl || cur.categoryArtUrl || null,
          domImageUrl: cur.domImageUrl || null,
          score: isNonFood ? null : scanRes.result.score,
          pending: false,
          isNonFood,
          dietaryAlerts: Array.isArray(scanRes.dietaryAlerts) ? scanRes.dietaryAlerts : [],
          swapTitle: chosenSwap?.title || null,
          swapScore: chosenSwap?.score ?? null,
          swapUrl: chosenSwap?.webUrl || null,
          swapImage: chosenSwap?.image || chosenSwap?.imageUrl || null,
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

  async function recordProductInCart(resp, fallbackTitle, addQty = 1, productImg = null, explicitItemId = "") {
    if (!resp?.ok || !resp.result) return;
    const capturedBucket = resolveStoreBucket().bucketKey;
    const isNonFood =
      resp.product?.nutrition?.productKind === "non-food" ||
      resp.result?.yukaBreakdown?.nutriScoreGrade === "N/A";
    const prevAvg = calcCartAvg();
    const itemKey = (fallbackTitle || resp.product?.title || "").trim();
    if (!itemKey) return;
    const resolvedItemId = String(
      explicitItemId ||
        (isProductPage() ? extractRetailerItemIdFromUrlOrNode(location.href, activeDialogScope()) : "") ||
        ""
    ).trim();

    clearCartItemDismissed(itemKey, resolvedItemId);
    if (resp.product?.title) clearCartItemDismissed(resp.product.title, resolvedItemId);

    let swappedInCart = false;
    if (matchesPendingSwapTitle(itemKey)) {
      const fromKey = state.pendingSwap?.fromKey;
      const fromItemId = state.pendingSwap?.fromItemId || "";
      if (fromKey) {
        markCartItemDismissed(fromKey, fromItemId);
        state.cartItems = state.cartItems.filter(
          (i) => !isSameCartEntry(i, { key: fromKey, title: fromKey, itemId: fromItemId })
        );
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
    const respHasDietAlert = Array.isArray(resp.dietaryAlerts) && resp.dietaryAlerts.length > 0;
    if (!chosenSwap && !swapOutOfStock && !isNonFood && candidates.length > 0 && (resp.result?.score < 75 || respHasDietAlert)) {
      const stockRes = await resolveFirstInStockSwap(candidates, resp.swap, capturedBucket);
      if (resolveStoreBucket().bucketKey !== capturedBucket || activeBucket.bucketKey !== capturedBucket) return;
      if (isCartItemDismissed(itemKey, resolvedItemId)) return;
      chosenSwap = stockRes.chosen;
      swapOutOfStock = stockRes.allOutOfStock;
    }

    const domImgClean = sanitizeDomImageUrl(productImg) || null;
    const serverImgClean =
      resp.product?.imageUrl && !isPlaceholderProductImage(resp.product.imageUrl)
        ? resp.product.imageUrl
        : null;

    const candidateEntry = {
      key: itemKey,
      title: resp.product?.title || itemKey,
      itemId: resolvedItemId,
    };
    const existingIdx = state.cartItems.findIndex((i) => isSameCartEntry(i, candidateEntry));
    const now = Date.now();
    if (existingIdx !== -1) {
      const existing = state.cartItems[existingIdx];
      state.cartItems[existingIdx] = {
        ...existing,
        brand: resp.product?.brand || existing.brand || "",
        itemId: resolvedItemId || existing.itemId || "",
        updatedAt: now,
        quantity: clampQty((existing.quantity || 1) + addQty),
        score: isNonFood ? null : resp.result.score,
        pending: false,
        isNonFood,
        image: existing.image || serverImgClean || null,
        imageKind: resp.product?.imageKind || existing.imageKind || null,
        categoryArtUrl: resp.product?.categoryArtUrl || existing.categoryArtUrl || null,
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
        brand: resp.product?.brand || "",
        itemId: resolvedItemId,
        updatedAt: now,
        quantity: clampQty(addQty),
        image: serverImgClean || null,
        imageKind: resp.product?.imageKind || null,
        categoryArtUrl: resp.product?.categoryArtUrl || null,
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

  function removeCartItemByTitle(targetTitle, targetItemId = "") {
    if (!targetTitle && !targetItemId) return;
    markCartItemDismissed(targetTitle, targetItemId);
    const targetEntry = { title: targetTitle, key: targetTitle, itemId: targetItemId };
    const before = state.cartItems.length;
    state.cartItems = state.cartItems.filter((item) => !isSameCartEntry(item, targetEntry));
    if (state.cartItems.length !== before) {
      state.displayedAvg = calcCartAvg();
      saveBucketCart();
      render();
    }
  }

  function adjustCartItemQtyByTitle(targetTitle, delta, targetItemId = "") {
    if (!targetTitle && !targetItemId) return false;
    const targetEntry = { title: targetTitle, key: targetTitle, itemId: targetItemId };
    const idx = state.cartItems.findIndex((item) => isSameCartEntry(item, targetEntry));
    if (idx === -1) return false;
    const nextQty = (state.cartItems[idx].quantity || 1) + delta;
    if (nextQty <= 0) {
      markCartItemDismissed(state.cartItems[idx].key, state.cartItems[idx].itemId);
      markCartItemDismissed(state.cartItems[idx].title, state.cartItems[idx].itemId);
      state.cartItems.splice(idx, 1);
    } else {
      state.cartItems[idx].quantity = clampQty(nextQty);
      state.cartItems[idx].updatedAt = Date.now();
    }
    state.displayedAvg = calcCartAvg();
    saveBucketCart();
    render();
    return true;
  }

  function setCartItemQtyByTitle(targetTitle, exactQty, targetItemId = "") {
    if (!targetTitle && !targetItemId) return false;
    const targetEntry = { title: targetTitle, key: targetTitle, itemId: targetItemId };
    const idx = state.cartItems.findIndex((item) => isSameCartEntry(item, targetEntry));
    if (idx === -1) return false;
    if (exactQty <= 0) {
      markCartItemDismissed(state.cartItems[idx].key, state.cartItems[idx].itemId);
      markCartItemDismissed(state.cartItems[idx].title, state.cartItems[idx].itemId);
      state.cartItems.splice(idx, 1);
    } else {
      clearCartItemDismissed(targetTitle, targetItemId || state.cartItems[idx].itemId);
      state.cartItems[idx].quantity = clampQty(exactQty);
      state.cartItems[idx].updatedAt = Date.now();
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
        '[data-test="cartItem"], [data-qa*="cart-item" i], .sc-list-item-content, div[data-asin], [data-testid*="cart-item" i], [data-testid*="line-item" i], [data-automation-id*="cart-item" i], [automation-id*="cart" i], [data-item-id], li, article'
      );
      const cartRoot = detectOpenCartRoot();
      if (!rowContainer && (!cartRoot || !cartRoot.contains(ctrl))) return;

      const rawVal = String(ctrl.value ?? "").trim();
      const numMatch = rawVal.match(/^\d+$/) || rawVal.match(/\b(\d{1,2})\b/);
      const parsedQty = numMatch ? Number(numMatch[1]) : NaN;
      const rowInfo = rowContainer ? extractRowTitleAndImage(rowContainer) : null;

      if (Number.isFinite(parsedQty) && (rowInfo?.title || rowInfo?.itemId)) {
        if (parsedQty <= 0) {
          removeCartItemByTitle(rowInfo.title || "", rowInfo.itemId || "");
        } else {
          setCartItemQtyByTitle(rowInfo.title || "", parsedQty, rowInfo.itemId || "");
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

      const label = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""} ${btn.getAttribute("data-testid") || ""} ${btn.getAttribute("data-test") || ""} ${btn.getAttribute("data-qa") || ""} ${btn.getAttribute("data-automation-id") || ""} ${btn.getAttribute("automation-id") || ""} ${btn.value || ""}`
        .replace(/\s+/g, " ")
        .trim();

      const rowContainer = btn.closest(
        '[data-test="cartItem"], [data-qa*="cart-item" i], .sc-list-item-content, div[data-asin], [data-testid*="cart-item" i], [data-testid*="line-item" i], [data-automation-id*="cart-item" i], [automation-id*="cart" i], [data-item-id], [data-testid*="product-card" i], [data-testid*="item-card" i], li, article'
      );
      const rowInfo = rowContainer ? extractRowTitleAndImage(rowContainer) : null;
      const contextTitle = rowInfo?.title || readTitle();
      const contextItemId = rowInfo?.itemId || "";

      // 1. Explicit Remove / Delete / Trash / Save for Later in cart or card
      const isHardRemove =
        !/\bundo\b/i.test(label) &&
        (/\b(remove(?:\s+item|\s+from\s+cart)?|delete(?:\s+item)?|cartitem-deletebtn|save\s+for\s+later|trash)\b/i.test(label) ||
          Boolean(btn.querySelector('svg[data-testid*="trash" i], svg[data-testid*="delete" i], [class*="trash" i]')));
      if (isHardRemove && (contextTitle || contextItemId)) {
        removeCartItemByTitle(contextTitle || "", contextItemId);
        scheduleCartSync(650);
        return;
      }

      // 2. Stepper Decrease ("-" / "decrease quantity")
      const btnTextTrim = (btn.textContent || "").trim();
      const isDecrement =
        btnTextTrim === "-" ||
        btnTextTrim === "−" ||
        /\b(decrease|decrement|minus|subtract|reduce\s+quantity|remove\s+one)\b/i.test(label);
      if (isDecrement && (contextTitle || contextItemId)) {
        const currentDomQty = rowContainer ? extractRowQuantity(rowContainer) : null;
        if (currentDomQty === 1) {
          removeCartItemByTitle(contextTitle || "", contextItemId);
        } else {
          adjustCartItemQtyByTitle(contextTitle || "", -1, contextItemId);
        }
        scheduleCartSync(650);
        return;
      }

      // 3. Explicit "Add to Cart" OR "+" Increment button
      const isExplicitAdd = /\b(add\s+to\s+(?:cart|bag|basket|order)|add\s+item)\b/i.test(label);
      const isIncrement =
        btnTextTrim === "+" || /\b(increase|increment|plus|add\s+one)\b/i.test(label);

      if (isExplicitAdd || isIncrement) {
        if (contextTitle || contextItemId) clearCartItemDismissed(contextTitle || "", contextItemId);
        // If on active PDP / modal and current scanned item matches
        if (isProductPage() && state.data?.ok) {
          const modalOrDoc = activeDialogScope();
          const pdpTitle = readTitle(modalOrDoc);
          const pdpItemId = extractRetailerItemIdFromUrlOrNode(location.href, modalOrDoc);
          if (pdpTitle || pdpItemId) clearCartItemDismissed(pdpTitle || "", pdpItemId);
          if (!rowContainer || (modalOrDoc && modalOrDoc.contains(btn)) || isSameCartTitle(contextTitle, state.data.product?.title)) {
            void recordProductInCart(state.data, pdpTitle, 1, readProductImage(modalOrDoc), pdpItemId);
            return;
          }
        }
        // Increment existing cart item or add from product grid card!
        if (contextTitle) {
          if (isIncrement && adjustCartItemQtyByTitle(contextTitle, 1, contextItemId)) {
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
                void recordProductInCart(
                  resp,
                  contextTitle,
                  1,
                  rowInfo?.domImageUrl || rowInfo?.image || null,
                  contextItemId
                );
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
    .cc-pill { position: fixed; right: 0; z-index: 2147483646; transform: translateY(-50%); display: flex; align-items: center; gap: 9px; max-width: min(340px, calc(100vw - 16px)); padding: 8px 13px 8px 10px; border-radius: 999px 0 0 999px; background: rgba(15,23,20,.95); color: #f8fafc; font-size: 13px; line-height: 1.2; box-shadow: 0 12px 32px -8px rgba(0,0,0,.52); cursor: grab; user-select: none; touch-action: none; }
    .cc-pill-mascot { width: 26px; height: 26px; object-fit: contain; flex: none; filter: drop-shadow(0 1px 2px rgba(0,0,0,.28)); }
    .cc-mini-ring { position: relative; width: 28px; height: 28px; flex: none; }
    .cc-mini-ring svg { width: 100%; height: 100%; display: block; }
    .cc-mini-ring-track { fill: none; stroke: rgba(255,255,255,.16); stroke-width: 3.4; }
    .cc-mini-ring-fill { fill: none; stroke: var(--tone-bright); stroke-width: 3.4; stroke-linecap: round; }
    .cc-mini-ring-val { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 10.5px; font-weight: 800; color: #fff; }
    .cc-backdrop { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: flex-end; justify-content: center; background: rgba(15,23,42,.42); }
    .cc-card { width: min(430px, calc(100vw - 20px)); max-height: min(78dvh, 560px); overflow-y: auto; -webkit-overflow-scrolling: touch; margin: 10px 10px max(12px, calc(env(safe-area-inset-bottom, 0px) + 10px)); padding: 18px; border-radius: 24px; background: #fff; box-shadow: 0 24px 54px -12px rgba(15,23,42,.36); }
    .cc-hide-drop { position: fixed; bottom: calc(24px + env(safe-area-inset-bottom, 0px)); left: 50%; transform: translateX(-50%); z-index: 2147483646; padding: 10px 18px; border-radius: 999px; font-size: 12.5px; font-weight: 800; background: rgba(15,23,20,.92); color: #fecaca; border: 1.5px dashed rgba(248,113,113,.75); pointer-events: none; }
    .cc-hide-drop.is-hot { background: #dc2626; color: #fff; border-style: solid; }
    .cc-thumb-empty { display: inline-flex !important; align-items: center; justify-content: center; font-weight: 900; font-size: 16px; line-height: 1; padding: 0 !important; flex: none; user-select: none; box-sizing: border-box; }
    .cc-prod-thumb.cc-thumb-empty { width: 44px; height: 44px; border-radius: 10px; font-size: 18px; }
    .cc-row-thumb.cc-thumb-empty, .cc-cart-thumb.cc-thumb-empty { width: 36px; height: 36px; border-radius: 8px; font-size: 14px; }
    .cc-swap-thumb.cc-thumb-empty { width: 42px; height: 42px; border-radius: 10px; font-size: 16px; }
    .cc-thumb-wrap { position: relative; display: inline-flex; flex: none; overflow: hidden; }
    .cc-thumb-wrap.cc-prod-thumb { width: 44px; height: 44px; border-radius: 10px; }
    .cc-thumb-wrap.cc-cart-thumb { width: 36px; height: 36px; border-radius: 8px; }
    .cc-thumb-wrap.cc-swap-thumb { width: 42px; height: 42px; border-radius: 10px; }
    .cc-thumb-wrap > img { width: 100% !important; height: 100% !important; object-fit: cover !important; display: block; }
    .cc-thumb-illus-badge { position: absolute; left: 50%; bottom: 1.5px; transform: translateX(-50%); padding: 0.5px 3.5px; border-radius: 999px; background: rgba(15,23,42,.72); color: #fff; font-size: 6.5px; font-weight: 700; line-height: 1.25; white-space: nowrap; pointer-events: none; }
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

  function buildBrandLetterTileMarkup(className, title = "", brand = "") {
    const tile = computeBrandLetterTile(title, brand);
    return `<div class="${className} cc-thumb-empty" style="background:${tile.bg} !important;border:1px solid ${tile.border} !important;color:${tile.fg} !important;" aria-hidden="true">${esc(tile.letter)}</div>`;
  }

  function buildCategoryArtMarkup(className, studioUrl, title = "", brand = "", lazy = false) {
    return `<span class="cc-thumb-wrap ${className}"><img class="${className}" src="${esc(studioUrl)}" data-is-category-art="1" data-tile-title="${esc(title)}" data-tile-brand="${esc(brand)}" referrerpolicy="no-referrer" alt=""${lazy ? ' loading="lazy"' : ""} /><span class="cc-thumb-illus-badge">Illustration</span></span>`;
  }

  function ensureFallback404Param(rawUrl) {
    if (!rawUrl || !rawUrl.includes("/api/product-image") || /[?&]fallback=/i.test(rawUrl)) return rawUrl;
    return `${rawUrl}${rawUrl.includes("?") ? "&" : "?"}fallback=404`;
  }

  function buildThumbMarkup(className, verifiedUrl, domImageUrl, lazy = false, meta = {}) {
    const rawResolved = resolveApiAssetUrl(verifiedUrl);
    const resolvedVerified = rawResolved ? ensureFallback404Param(rawResolved) : null;
    const hasVerified = Boolean(resolvedVerified && !isPlaceholderProductImage(resolvedVerified));
    const cleanDom = sanitizeDomImageUrl(domImageUrl);
    const imageKind = String(meta?.imageKind || "");
    const title = String(meta?.title || "");
    const brand = String(meta?.brand || "");
    const explicitCatArt = resolveApiAssetUrl(meta?.categoryArtUrl || "");
    const verifiedIsStudio = hasVerified && (imageKind === "category-art" || isStudioCategoryArtUrl(resolvedVerified));
    const studioFallback = explicitCatArt || (verifiedIsStudio ? resolvedVerified : "");

    // 1. Real package photo (direct OFF or single-pass /api/product-image?fallback=404)
    if (hasVerified && !verifiedIsStudio && imageKind !== "none") {
      return `<img class="${className}" src="${esc(resolvedVerified)}"${
        cleanDom ? ` data-dom-fallback="${esc(cleanDom)}"` : ""
      }${studioFallback ? ` data-cat-fallback="${esc(studioFallback)}"` : ""} data-tile-title="${esc(title)}" data-tile-brand="${esc(brand)}" referrerpolicy="no-referrer" alt=""${lazy ? ' loading="lazy"' : ""} />`;
    }

    // 2. Device-local store DOM photo (preferred over studio bowl art when browsing live retailer pages)
    if (cleanDom) {
      return `<img class="${className}" src="${esc(cleanDom)}"${
        studioFallback ? ` data-cat-fallback="${esc(studioFallback)}"` : ""
      } data-tile-title="${esc(title)}" data-tile-brand="${esc(brand)}" referrerpolicy="no-referrer" alt=""${
        lazy ? ' loading="lazy"' : ""
      } />`;
    }

    // 3. Brand-neutral studio category art with explicit "Illustration" pill
    if (studioFallback && imageKind !== "none") {
      return buildCategoryArtMarkup(className, studioFallback, title, brand, lazy);
    }

    // 4. Crisp Brand-Letter Tile
    return buildBrandLetterTileMarkup(className, title, brand);
  }

  function isBgProxyEligibleAssetUrl(rawUrl) {
    if (!rawUrl || !/^https:\/\//i.test(rawUrl)) return false;
    try {
      const u = new URL(rawUrl);
      if (u.hostname === "images.openfoodfacts.org" && u.pathname.startsWith("/images/products/")) {
        return true;
      }
      const apiBase = (clientInfo.apiBase || DEFAULT_API).replace(/\/+$/, "");
      let apiOrigin = "https://www.heybroc.com";
      try {
        apiOrigin = new URL(apiBase).origin;
      } catch {
        /* ignore */
      }
      if (
        (u.origin === apiOrigin || u.origin === "https://www.heybroc.com" || u.origin === "https://heybroc.com") &&
        (u.pathname.startsWith("/swaps/") || u.pathname.startsWith("/products/") || u.pathname.startsWith("/api/product-image"))
      ) {
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  function advanceThumbFallbackLadder(imgEl) {
    if (!imgEl || !imgEl.isConnected) return;
    const domFallback = sanitizeDomImageUrl(imgEl.getAttribute("data-dom-fallback") || "");
    const catFallback = imgEl.getAttribute("data-cat-fallback") || "";
    const tileTitle = imgEl.getAttribute("data-tile-title") || "";
    const tileBrand = imgEl.getAttribute("data-tile-brand") || "";
    const curSrc = imgEl.getAttribute("src") || "";

    if (domFallback && imgEl.dataset.triedDomFallback !== "1" && curSrc !== domFallback) {
      imgEl.dataset.triedDomFallback = "1";
      imgEl.setAttribute("referrerpolicy", "no-referrer");
      imgEl.setAttribute("src", domFallback);
      return;
    }

    if (catFallback && imgEl.dataset.triedCatFallback !== "1" && curSrc !== catFallback && imgEl.dataset.isCategoryArt !== "1") {
      imgEl.dataset.triedCatFallback = "1";
      const cls = imgEl.className || "cc-prod-thumb";
      const wrap = document.createElement("span");
      wrap.className = `cc-thumb-wrap ${cls}`;
      const studioImg = document.createElement("img");
      studioImg.className = cls;
      studioImg.src = catFallback;
      studioImg.dataset.isCategoryArt = "1";
      studioImg.setAttribute("data-tile-title", tileTitle);
      studioImg.setAttribute("data-tile-brand", tileBrand);
      studioImg.setAttribute("referrerpolicy", "no-referrer");
      studioImg.alt = "";
      studioImg.onerror = () => handleThumbFallback(studioImg);
      const badge = document.createElement("span");
      badge.className = "cc-thumb-illus-badge";
      badge.textContent = "Illustration";
      wrap.append(studioImg, badge);
      imgEl.replaceWith(wrap);
      return;
    }

    const tile = computeBrandLetterTile(tileTitle, tileBrand);
    const cls = imgEl.className || "cc-prod-thumb";
    const neutralBox = document.createElement("div");
    neutralBox.className = `${cls} cc-thumb-empty`;
    neutralBox.style.setProperty("background", tile.bg, "important");
    neutralBox.style.setProperty("border", `1px solid ${tile.border}`, "important");
    neutralBox.style.setProperty("color", tile.fg, "important");
    neutralBox.setAttribute("aria-hidden", "true");
    neutralBox.textContent = tile.letter;
    const replaceTarget = imgEl.parentElement?.classList?.contains("cc-thumb-wrap") ? imgEl.parentElement : imgEl;
    replaceTarget.replaceWith(neutralBox);
  }

  function handleThumbFallback(imgEl) {
    if (!imgEl || !imgEl.isConnected) return;
    const curSrc = imgEl.getAttribute("src") || "";
    if (
      imgEl.dataset.triedBgProxy !== "1" &&
      isBgProxyEligibleAssetUrl(curSrc) &&
      typeof chrome !== "undefined" &&
      typeof chrome.runtime?.sendMessage === "function"
    ) {
      imgEl.dataset.triedBgProxy = "1";
      try {
        chrome.runtime.sendMessage({ type: "CLEANCART_FETCH_IMAGE_DATA_URL", url: curSrc }, (resp) => {
          if (!imgEl.isConnected) return;
          if (resp?.ok && typeof resp.dataUrl === "string" && resp.dataUrl.startsWith("data:image/")) {
            imgEl.setAttribute("src", resp.dataUrl);
            return;
          }
          advanceThumbFallbackLadder(imgEl);
        });
        return;
      } catch {
        /* fall through to synchronous fallback ladder */
      }
    }
    advanceThumbFallbackLadder(imgEl);
  }

  function attachModalThumbHandlers() {
    const thumbs = modalSlot.querySelectorAll("img.cc-prod-thumb, img.cc-cart-thumb, img.cc-swap-thumb");
    for (const img of thumbs) {
      img.onerror = () => handleThumbFallback(img);
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
  let modalOpenedAt = 0;
  (() => {
    let startY = 0;
    let startX = 0;
    let startPct = 50;
    let moved = false;
    let activePointerId = null;
    let lastPointerTapAt = 0;

    function openDrawerFromPill() {
      modalOpenedAt = Date.now();
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

    function finishDrag(cancelled) {
      const dropHide = !cancelled && moved && state.overHide;
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
        lastPointerTapAt = Date.now();
        openDrawerFromPill();
      } else if (!cancelled && moved && typeof alignMobileSearchCardToPill === "function") {
        alignMobileSearchCardToPill(true);
      }
    }

    pillEl.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.stopPropagation();
      activePointerId = e.pointerId;
      try { pillEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      startY = e.clientY;
      startX = e.clientX;
      startPct = state.y;
      moved = false;
      state.dragging = false;
      state.overHide = false;
    });

    pillEl.addEventListener("pointermove", (e) => {
      if (activePointerId !== e.pointerId) return;
      const dy = e.clientY - startY;
      const dx = e.clientX - startX;
      // 14px deadzone prevents natural iPhone thumb micro-roll from cancelling taps or flashing the hide dropzone
      if (!moved && Math.hypot(dx, dy) < 14) return;
      if (!moved) {
        moved = true;
        state.dragging = true;
        pillEl.classList.add("is-dragging");
        hideDropEl.hidden = false;
        hideDropEl.classList.remove("is-hot");
      }
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
      e.stopPropagation();
      try { pillEl.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      finishDrag(false);
    });

    pillEl.addEventListener("pointercancel", (e) => {
      if (activePointerId !== e.pointerId) return;
      finishDrag(true);
    });

    pillEl.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (Date.now() - lastPointerTapAt < 450 || moved) return;
      openDrawerFromPill();
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
            const itemHasAlert = Array.isArray(item.dietaryAlerts) && item.dietaryAlerts.length > 0;
            const rowTone = hasScore ? (itemHasAlert ? "red" : toneForScore(item.score)) : "gray";
            const chipLabel = item.pending ? "…" : item.isNonFood ? "N/A" : hasScore ? String(item.score) : "--";
            const thumbHtml = buildThumbMarkup("cc-row-thumb cc-cart-thumb", item.image, item.domImageUrl, true, {
              imageKind: item.imageKind,
              categoryArtUrl: item.categoryArtUrl,
              title: item.title,
              brand: item.brand,
            });
            const qty = clampQty(item.quantity);
            const itemAlertEmoji =
              itemHasAlert && item.dietaryAlerts.every((a) => a.id === "pesticide_risk") ? "🌱" : "⚠️";
            const alertBadges = itemHasAlert
              ? ` · ${itemAlertEmoji} ${item.dietaryAlerts.map((a) => esc(a.shortBadge)).join(", ")}`
              : "";

            let subLine = "";
            if (item.pending) {
              subLine = `<small>Scoring ingredients…</small>`;
            } else if (item.isNonFood) {
              subLine = `<small>Household / non-food — excluded from Cart Avg</small>`;
            } else if (hasScore && (item.score < 75 || itemHasAlert) && item.swapTitle && !item.swapOutOfStock) {
              subLine = `<small class="cc-swap-line">✓ In Stock Swap: ${esc(item.swapTitle)}${item.swapScore !== null ? ` (${esc(item.swapScore)}/100)` : ""}${item.swapIsPaidLink ? " · paid link" : ""}${alertBadges}</small>`;
            } else if (hasScore && (item.score < 75 || itemHasAlert) && item.swapOutOfStock) {
              subLine = `<small>No clean swap currently in stock at ${esc(activeBucket.label)}${alertBadges}</small>`;
            } else if (hasScore) {
              subLine = `<small>${esc(ratingLabelForScore(item.score))} pick${alertBadges}</small>`;
            }

            const showSwapBtn = hasScore && (item.score < 75 || itemHasAlert) && item.swapTitle && !item.swapOutOfStock;

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
      (i) =>
        isScoredCartItem(i) &&
        (i.score < 75 || (Array.isArray(i.dietaryAlerts) && i.dietaryAlerts.length > 0)) &&
        i.swapTitle &&
        !i.swapOutOfStock
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
    const rawProdImg = d.product?.imageUrl;
    const prodImageKind = isNonFood ? "none" : d.product?.imageKind || "";
    const prodVerifiedImg =
      rawProdImg && !isPlaceholderProductImage(rawProdImg)
        ? resolveApiAssetUrl(rawProdImg)
        : !isNonFood &&
            prodImageKind !== "none" &&
            prodImageKind !== "category-art" &&
            !state.lastDomProductImageUrl &&
            d.product?.title
          ? fallbackThumbUrl(d.product.title, d.product.brand)
          : null;
    const prodThumbHtml = buildThumbMarkup(
      "cc-prod-thumb",
      prodVerifiedImg,
      state.lastDomProductImageUrl,
      false,
      {
        imageKind: prodImageKind,
        categoryArtUrl: d.product?.categoryArtUrl,
        title: d.product?.title,
        brand: d.product?.brand,
      }
    );

    const srcKey = d.lookup?.origin || d.lookup?.source || "catalog";
    const srcName = srcKey === "screen" ? "Store page ingredients"
      : srcKey === "openfoodfacts" ? "Open Food Facts"
      : srcKey === "usda" ? "USDA FoodData Central"
      : "Verified US label catalog";
    const updatedVal = d.lookup?.sourceUpdatedAt;
    const updatedPart = updatedVal ? ` · ${esc(updatedVal)}` : "";
    const autoVerifyLabel = state.autoVerifyStatus || "Report mismatch (Auto-Verify)";

    const hasDietAlerts = Array.isArray(d.dietaryAlerts) && d.dietaryAlerts.length > 0;
    const dietAlertsHtml = hasDietAlerts
      ? `<div class="cc-flags">${d.dietaryAlerts.map((a) => `<span class="cc-diet-chip" title="${esc(a.reason)}">${esc(a.label)}</span>`).join("")}</div>`
      : "";

    const flagsHtml = isNonFood
      ? `<p class="cc-meta-line">Household / non-food item — not scored as food.</p>`
      : r.flagged.length
        ? `<div class="cc-flags">${r.flagged
            .slice(0, 3)
            .map((f) => `<span class="cc-flag cc-risk-${esc(f.risk)}">${esc(f.name)}</span>`)
            .join("")}${
            r.flagged.length > 3
              ? `<span class="cc-flag cc-risk-moderate">+${r.flagged.length - 3} more</span>`
              : ""
          }</div>`
        : `<p class="cc-clean">✓ 0 Watchlist Additives Found</p>`;

    const explainList =
      !isNonFood && r.flagged.length
        ? `<div class="cc-explain-list">${r.flagged
            .map(
              (f) =>
                `<div class="cc-explain cc-risk-${esc(f.risk)}"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><b>${esc(f.name)}</b><span>−${esc(f.penalty)} pts</span></div><p>${esc(f.explanation)}</p></div>`
            )
            .join("")}</div>`
        : "";

    const ingHtml = d.product?.ingredients && !isNonFood
      ? `<details class="cc-ing-box"><summary>Ingredients (${d.product.ingredients.split(",").length} listed)</summary><p>${esc(d.product.ingredients)}</p></details>`
      : "";

    let swapHtml = "";
    const activeSwap = state.activeSwap;
    if (!isNonFood && (safeScore < 75 || hasDietAlerts)) {
      if (state.swapStockChecking && !activeSwap) {
        swapHtml = `<div class="cc-swap cc-swap-muted"><div class="cc-swap-info"><b>Checking in-stock Clean Swaps at ${esc(activeBucket.label)}…</b><span class="cc-meta-line">Verifying live store availability</span></div></div>`;
      } else if (state.allSwapsOutOfStock) {
        swapHtml = `<div class="cc-swap cc-swap-muted"><div class="cc-swap-info"><b>No clean swap currently in stock at ${esc(activeBucket.label)}</b><span class="cc-meta-line">Out-of-stock alternatives were hidden automatically.</span></div></div>`;
      } else if (activeSwap) {
        const swapLocked = !activeSwap.webUrl;
        const swapPaidSuffix = !swapLocked && activeSwap.isPaidLink ? " · paid link" : "";
        const swapRating = ratingLabelForScore(activeSwap.score);
        const rawSwapImg = activeSwap.image || activeSwap.imageUrl;
        const swapKind = String(activeSwap.imageKind || "");
        const swapThumb =
          rawSwapImg && !isPlaceholderProductImage(rawSwapImg)
            ? resolveApiAssetUrl(rawSwapImg)
            : swapKind !== "none" && swapKind !== "category-art" && activeSwap.title
              ? fallbackThumbUrl(activeSwap.title, activeSwap.brand)
              : null;
        const swapAdditivesNote =
          !swapLocked && Array.isArray(activeSwap.flaggedAdditives) && activeSwap.flaggedAdditives.length > 0
            ? `<span class="cc-meta-line" style="display:block;color:#92400e;font-size:11px;margin-top:2px;">Note: contains ${esc(activeSwap.flaggedAdditives.join(", "))}</span>`
            : "";
        swapHtml = `<div class="cc-swap">
          ${buildThumbMarkup("cc-swap-thumb", swapThumb, null, false, {
            imageKind: activeSwap.imageKind,
            categoryArtUrl: activeSwap.categoryArtUrl,
            title: activeSwap.title,
            brand: activeSwap.brand,
          })}
          <div class="cc-swap-info">
            <div class="cc-swap-badges">
              ${swapLocked ? `<span class="cc-eyebrow">🔒 Swap Locked</span>` : `<span class="cc-instock-badge">✓ In Stock</span>`}
              <span class="cc-eyebrow" style="color:#065f46">${esc(activeBucket.label)}${esc(swapPaidSuffix)}</span>
            </div>
            <b>${esc(activeSwap.title)}</b>
            <span class="cc-swap-score">${esc(activeSwap.score)}/100 ${esc(swapRating)}${swapLocked ? " · Free swaps used" : ""}</span>
            ${swapAdditivesNote}
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
          <p class="cc-meta-line">${esc(srcName)}${updatedPart} · <button type="button" data-act="auto-verify-label" style="background:none;border:none;padding:0;color:#15803d;font-weight:700;font-size:inherit;text-decoration:underline;cursor:pointer;">${esc(autoVerifyLabel)}</button></p>
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
      ${swapHtml}
      ${explainList}
      ${ingHtml}
      <p class="cc-footnote">Informational opinion only — verify physical product label. HeyBroc is independent and not affiliated with ${esc(activeBucket.label)}.</p>
    `;
  }

  const MAJOR_ALLERGEN_BADGE_IDS = new Set([
    "peanuts_nuts",
    "dairy",
    "wheat_gluten",
    "soy",
    "egg",
    "shellfish_fish",
    "sesame",
  ]);

  function resolveBadgeAlertSeverity(resp) {
    if (resp?.alertSeverity === "allergen" || resp?.alertSeverity === "advisory" || resp?.alertSeverity === "none") {
      return resp.alertSeverity;
    }
    const alerts = Array.isArray(resp?.dietaryAlerts) ? resp.dietaryAlerts : [];
    if (alerts.length === 0) return "none";
    return alerts.some((a) => MAJOR_ALLERGEN_BADGE_IDS.has(a?.id)) ? "allergen" : "advisory";
  }

  function render() {
    if (sessionStorage.getItem(hideKeyForBucket(activeBucket.bucketKey)) === "1") {
      pillEl.hidden = true;
      modalSlot.innerHTML = "";
      if (typeof clearAllPhotoBadges === "function") clearAllPhotoBadges();
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
      const pillHasAlerts = Array.isArray(state.data.dietaryAlerts) && state.data.dietaryAlerts.length > 0;
      const pillSeverity = resolveBadgeAlertSeverity(state.data);
      const pillScoreTone = toneForScore(safeScore);
      const prodTone = isNonFood
        ? "gray"
        : pillSeverity === "allergen"
          ? "red"
          : pillSeverity === "advisory"
            ? pillScoreTone === "red"
              ? "red"
              : "yellow"
            : pillScoreTone;
      const pillAlertEmoji =
        pillHasAlerts && state.data.dietaryAlerts.every((a) => a.id === "pesticide_risk") ? "🌱" : "⚠️";
      const alertChip = pillHasAlerts
        ? `<span class="cc-pill-alert">${pillAlertEmoji} ${esc(state.data.dietaryAlerts[0].shortBadge)}</span>`
        : "";
      const cartChip = avg !== null ? `Cart: ${avg}/100 (${totalUnits})` : `${activeBucket.label} Cart: --`;
      const alignedTitle =
        !isProductPage() && (state.data?.product?.title || state.hoveredCardData?.title)
          ? String(state.data?.product?.title || state.hoveredCardData?.title).trim()
          : "";
      const shortAligned = alignedTitle
        ? alignedTitle.length > 26
          ? `${alignedTitle.slice(0, 25).trimEnd()}…`
          : alignedTitle
        : "";
      updatePillElement({
        visible: true,
        tone: prodTone,
        ringValue: isNonFood ? "N/A" : String(safeScore),
        ringPercent: isNonFood ? null : safeScore,
        act: "expand",
        primaryHtml: isNonFood
          ? `<span>Non-Food Item</span>`
          : `<b>${esc(safeScore)}/100</b><span>${esc(ratingLabelForScore(safeScore))}</span>${alertChip}`,
        subHtml: shortAligned ? `${esc(shortAligned)} · Tap` : `${esc(cartChip)} · Tap to inspect`,
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
    const modalSeverity = canShowProductTab ? resolveBadgeAlertSeverity(state.data) : "none";
    const modalScoreTone = canShowProductTab ? toneForScore(state.data.result.score) : avgTone;
    const cardToneClass =
      activeTab === "product" && canShowProductTab
        ? modalSeverity === "allergen"
          ? "cc-tone-red"
          : modalSeverity === "advisory"
            ? modalScoreTone === "red"
              ? "cc-tone-red"
              : "cc-tone-yellow"
            : `cc-tone-${modalScoreTone}`
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
          markCartItemDismissed(removedItem.key, removedItem.itemId);
          markCartItemDismissed(removedItem.title, removedItem.itemId);
        }
        state.cartItems.splice(idx, 1);
        state.displayedAvg = calcCartAvg();
        saveBucketCart();
        render();
        if (removedItem) {
          clickNativeCartRemoveButton(removedItem.title || removedItem.key, removedItem.itemId || "");
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
          const upUrl = buildWebActionUrl("upgrade");
          if (upUrl.startsWith("heybroc://")) {
            location.href = upUrl;
          } else {
            window.open(upUrl, "_blank", "noopener");
          }
          return;
        }
        state.pendingSwap = { fromKey: item.key, fromItemId: item.itemId || "", toTitle: item.swapTitle };
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
      if (t === e.target && !t.classList.contains("cc-close") && Date.now() - modalOpenedAt < 450) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      state.expanded = false;
      state.auditorOpen = false;
      render();
      return;
    }
    if (act === "clear-cart") {
      for (const item of state.cartItems) {
        markCartItemDismissed(item.key, item.itemId);
        markCartItemDismissed(item.title, item.itemId);
      }
      state.cartItems = [];
      state.displayedAvg = null;
      saveBucketCart();
      render();
      return;
    }
    if (act === "auto-verify-label" && state.data?.product) {
      state.autoVerifyStatus = "🤖 Checking USDA & Open Food Facts…";
      render();
      const reportPayload = {
        productTitle: state.data.product.title,
        brand: state.data.product.brand,
        currentIngredients: state.data.product.ingredients,
        issueType: "reformulated",
        store: activeBucket.store,
      };
      const applyVerifyResponse = (res) => {
        if (res?.ok && res.verifiedResult) {
          state.data.result = res.verifiedResult;
          if (res.verifiedProduct?.ingredients) {
            state.data.product.ingredients = res.verifiedProduct.ingredients;
          }
          if (res.swap !== undefined) {
            state.activeSwap = res.swap;
          }
          state.autoVerifyStatus =
            res.report?.status === "auto_updated"
              ? `✓ Auto-updated (${res.verifiedResult.score}/100)`
              : `✓ Verified accurate (${res.verifiedResult.score}/100)`;
        } else {
          state.autoVerifyStatus = "✓ Verified against USDA/OFF";
        }
        render();
      };
      try {
        chrome.runtime.sendMessage(
          { type: "CLEANCART_LABEL_REPORT", payload: reportPayload },
          (res) => {
            if (chrome.runtime?.lastError || !res) {
              state.autoVerifyStatus = "✓ Checked";
              render();
              return;
            }
            applyVerifyResponse(res);
          }
        );
      } catch {
        state.autoVerifyStatus = "✓ Checked";
        render();
      }
      return;
    }
    if (act === "swap" && state.activeSwap) {
      if (!state.activeSwap.webUrl) {
        const upUrl = buildWebActionUrl("upgrade");
        if (upUrl.startsWith("heybroc://")) {
          location.href = upUrl;
        } else {
          window.open(upUrl, "_blank", "noopener");
        }
        return;
      }
      const currentKey = state.data?.product?.title || readTitle();
      const currentItemId = isProductPage()
        ? extractRetailerItemIdFromUrlOrNode(location.href, activeDialogScope())
        : "";
      state.pendingSwap = { fromKey: currentKey, fromItemId: currentItemId, toTitle: state.activeSwap.title };
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

    const hasDietAlerts = Array.isArray(resp.dietaryAlerts) && resp.dietaryAlerts.length > 0;
    const willVerifyStock = Boolean(
      candidates.length > 0 && (resp.result?.score < 75 || hasDietAlerts) && candidates[0]?.webUrl
    );
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
      if (seq !== scanSeq || state.mode === "cart_avg") return;
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
    if (sessionStorage.getItem(hideKeyForBucket(activeBucket.bucketKey)) === "1") {
      clearAllPhotoBadges();
      return;
    }
    if (!host.isConnected) document.documentElement.appendChild(host);

    if (isOrderConfirmationPage()) {
      dismissedCartKeys.clear();
      if (state.cartItems.length > 0) {
        state.cartItems = [];
        state.displayedAvg = null;
        saveBucketCart();
      }
    } else {
      // Always sync live store cart if /cart or slide-out cart drawer is currently visible
      scrapeAndSyncLiveCart();
    }

    // Discover & score visible product grid/aisle cards with Automatic On-Photo Score Badges
    scanVisiblePhotoBadges();

    const modalScope = activeDialogScope();
    if (!isProductPage()) {
      // On touch-primary mobile browsers (iOS Safari, etc.), automatically align and scan the search/aisle card at the pill's Y position!
      if (isTouchPrimary() && !isCartPageUrl() && !detectOpenCartRoot() && !state.expanded && !state.auditorOpen) {
        if (alignMobileSearchCardToPill(false)) {
          return;
        }
      }
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

    lastMobileAlignedTitle = "";
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
    let rawIngredients = readIngredients(modalScope);
    const domImage = readProductImage(modalScope);
    let walmartNextBarcode = "";
    if (!modalScope && BASE_STORE === "walmart") {
      try {
        const nextEl = document.getElementById("__NEXT_DATA__");
        const rawJson = nextEl && nextEl.textContent ? nextEl.textContent : "";
        if (rawJson && rawJson.length <= 2_500_000) {
          const nd = JSON.parse(rawJson);
          const idml = nd?.props?.pageProps?.initialData?.data?.idml;
          const prod = nd?.props?.pageProps?.initialData?.data?.product;
          const urlItemMatch = location.pathname.match(/\/ip\/(?:[^/]+\/)?(\d{5,20})(?:[/?#]|$)/i);
          const urlItemId = urlItemMatch ? urlItemMatch[1] : "";
          const prodId = String(prod?.usItemId || prod?.id || "");
          const canon = String(prod?.canonicalUrl || "");
          const matchesCurrentUrl =
            !urlItemId || prodId === urlItemId || canon.endsWith("/" + urlItemId);
          if (matchesCurrentUrl) {
            if (!rawIngredients && idml) {
              const wIng =
                idml.ingredients?.ingredients?.value ||
                idml.ingredients?.value ||
                (typeof idml.ingredients === "string" ? idml.ingredients : "");
              if (typeof wIng === "string" && wIng.trim().length > 3) {
                rawIngredients = wIng.trim().slice(0, 4000);
              }
            }
            if (prod) {
              let rawCode = String(prod.upc || prod.gtin13 || "").replace(/\D/g, "");
              if (rawCode.length === 14 && rawCode.startsWith("00")) rawCode = rawCode.slice(2);
              else if (rawCode.length === 14 && rawCode.startsWith("0")) rawCode = rawCode.slice(1);
              if (/^\d{8,14}$/.test(rawCode)) walmartNextBarcode = rawCode;
            }
          }
        }
      } catch {
        // ignore Walmart Next.js hydration parse errors
      }
    }
    const key = `${activeBucket.bucketKey}|${location.pathname}|${modalScope ? "modal" : "pdp"}|${productTitle}|${rawIngredients}`;
    if (key === lastKey) return;
    lastKey = key;

    // Increment scanSeq BEFORE synchronous scanCache hits so any older in-flight network scan is immediately invalidated!
    const seq = ++scanSeq;
    let pageBarcode = walmartNextBarcode;
    if (!modalScope && !pageBarcode) {
      try {
        const tokenizeForGtin = (s) =>
          String(s || "")
            .toLowerCase()
            .replace(/['’]s\b/g, "s")
            .replace(/['’]/g, "")
            .replace(/[^a-z0-9]+/g, " ")
            .split(" ")
            .filter(
              (w) =>
                w.length >= 3 &&
                !/^(the|and|with|for|from|pack|count|size|oz|fl|lb|lbs|ct|pk|organic|natural|original|classic|fresh|pure|great|value|kirkland|signature|members|mark|good|gather)$/.test(
                  w
                )
            );
        const heroToks = new Set(tokenizeForGtin(productTitle));
        const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const sc of ldScripts) {
          let parsed;
          try {
            parsed = JSON.parse(sc.textContent || "null");
          } catch {
            continue;
          }
          const queue = Array.isArray(parsed) ? parsed.slice() : [parsed];
          while (queue.length > 0 && !pageBarcode) {
            const node = queue.shift();
            if (!node || typeof node !== "object") continue;
            if (Array.isArray(node["@graph"])) {
              queue.push(...node["@graph"]);
            }
            const rawType = Array.isArray(node["@type"]) ? node["@type"].join(" ") : String(node["@type"] || "");
            if (!/\bproduct\b/i.test(rawType)) continue;
            let rawCode = String(
              node.gtin13 || node.gtin12 || node.gtin14 || node.gtin8 || node.gtin || node.upc || ""
            ).replace(/\D/g, "");
            if (!/^\d{8,14}$/.test(rawCode)) continue;
            if (rawCode.length === 14 && rawCode.startsWith("00")) rawCode = rawCode.slice(2);
            else if (rawCode.length === 14 && rawCode.startsWith("0")) rawCode = rawCode.slice(1);
            const ldName = String(node.name || "").trim();
            if (!ldName) continue;
            const ldToks = tokenizeForGtin(ldName);
            if (heroToks.size > 0 && ldToks.length > 0 && ldToks.some((t) => heroToks.has(t))) {
              pageBarcode = rawCode;
              break;
            }
          }
          if (pageBarcode) break;
        }
      } catch {
        // ignore JSON-LD read errors
      }
    }

    const cKey = `${normCacheKey(productTitle, rawIngredients)}|${pageBarcode}`;
    const cached = lruGet(scanCache, cKey);
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
          barcode: pageBarcode || undefined,
          store: reqBucket.store,
          instacartRetailerSlug: reqBucket.instacartRetailerSlug,
        },
      },
      (resp) => {
        if (resp?.ok && !isTransientLockedSwap(resp)) {
          lruSet(scanCache, cKey, resp, MAX_PDP_SCAN_CACHE);
        }
        if (seq !== scanSeq || !isProductPage() || resolveStoreBucket().bucketKey !== reqBucket.bucketKey) return;
        void applyScanResult(resp, domImage, seq);
      }
    );
  }

  function isTransientLockedSwap(resp) {
    return Boolean(resp?.swap?.locked && !resp?.entitlement);
  }

  /* ---------------- Automatic On-Photo Score Badges (Search / Aisle Grids) ---------------- */
  const PHOTO_BADGE_STYLE_ID = "cleancart-photo-badge-styles";
  const MAX_IN_FLIGHT_PHOTO_BATCHES = 2;

  const gridScanCache = new Map();
  let photoBadgeObserver = null;
  let cardStateByEl = new WeakMap();
  let ownerCardByImg = new WeakMap();
  const badgeDataByElement = new WeakMap();
  const pendingPhotoBadgeQueue = new Map();
  let photoBadgeBatchTimer = null;
  let photoBadgeRetryTimer = null;
  let photoBadgeRetryAt = 0;
  let nextPhotoBadgeSeq = 1;
  let photoBadgeGeneration = 1;
  let photoBadgePrefRev = 1;
  let lastPhotoBadgePageUrl = location.href;
  let inFlightPhotoBatches = 0;

  function ensurePhotoBadgeStyles() {
    if (document.getElementById(PHOTO_BADGE_STYLE_ID)) return;
    const styleEl = document.createElement("style");
    styleEl.id = PHOTO_BADGE_STYLE_ID;
    styleEl.textContent = `
      .cc-photo-badge-slot {
        display: flex !important;
        align-items: center !important;
        justify-content: flex-start !important;
        width: 100% !important;
        padding: 7px 2px 3px 2px !important;
        margin: 0 !important;
        box-sizing: border-box !important;
        pointer-events: none !important;
        position: relative !important;
        z-index: 20 !important;
      }
      .cc-photo-badge {
        position: absolute !important;
        bottom: 8px !important;
        left: 8px !important;
        z-index: 20 !important;
        display: inline-flex !important;
        align-items: center !important;
        gap: 6px !important;
        padding: 6px 13px !important;
        min-height: 33px !important;
        border-radius: 999px !important;
        font: 800 15.5px/1.12 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        font-variant-numeric: tabular-nums !important;
        letter-spacing: -0.015em !important;
        color: #ffffff !important;
        border: 2px solid rgba(255, 255, 255, 0.96) !important;
        box-shadow: 0 5px 14px rgba(15, 23, 42, 0.24) !important;
        cursor: pointer !important;
        user-select: none !important;
        -webkit-user-select: none !important;
        pointer-events: auto !important;
        text-decoration: none !important;
        white-space: nowrap !important;
        transition: transform 0.14s ease, filter 0.14s ease !important;
      }
      .cc-photo-badge--under {
        position: relative !important;
        bottom: auto !important;
        left: auto !important;
        box-shadow: 0 3px 10px rgba(15, 23, 42, 0.18) !important;
      }
      .cc-photo-badge:hover { transform: scale(1.05) !important; filter: brightness(1.04) !important; }
      .cc-photo-badge--green { background: rgba(22, 163, 74, 0.97) !important; }
      .cc-photo-badge--yellow { background: rgba(217, 119, 6, 0.97) !important; }
      .cc-photo-badge--red { background: rgba(220, 38, 38, 0.97) !important; }
      .cc-photo-badge--advisory { box-shadow: 0 0 0 2.5px #fbbf24, 0 5px 14px rgba(15, 23, 42, 0.26) !important; }
      .cc-photo-badge--loading { background: rgba(15, 23, 42, 0.78) !important; opacity: 0.9 !important; }
    `;
    (document.head || document.documentElement)?.appendChild(styleEl);
  }

  function unmountPhotoBadgeEl(badgeEl) {
    if (!badgeEl) return;
    const parent = badgeEl.parentElement;
    badgeEl.remove();
    if (parent && parent.classList?.contains?.("cc-photo-badge-slot")) {
      parent.remove();
    }
  }

  const EXT_MEDIA_ICON_BTN_RE =
    /^(?:save|favorite|favourite|wishlist|add\s+to\s+(?:list|registry|favorites)|sign\s+in\s+to\s+save|like|heart|next|previous|prev|slide\s*\d*|image\s*\d*|photo\s*\d*|dot\s*\d*|close|zoom|expand)$/i;
  const EXT_PROMO_SLIDE_ALT_RE =
    /\b(?:satisfaction\s+guaranteed|money\s+back\s+guarantee|100%\s+guaranteed|quality\s+guaranteed|freshness\s+guaranteed|shopping\s+(?:basket|cart|bag)|checkout\s+conveyor|in\s+a\s+(?:blue|red|green|white|wooden|wicker)\s+(?:basket|bowl|cart)|promotional\s+banner|hero\s+banner)\b/i;

  function extNodeHasDetailsOrCta(el) {
    if (!el || typeof el.querySelector !== "function") return false;
    if (
      el.querySelector(
        'h1, h2, h3, [data-test="product-title"], [data-automation-id*="product-title" i], [data-testid*="product-title" i], [data-testid*="item-title" i]'
      )
    ) {
      return true;
    }
    const btns = el.querySelectorAll("button");
    for (const b of btns) {
      if (b.closest?.(".cc-photo-badge, .cc-photo-badge-slot")) continue;
      const bTxt = (b.textContent || "").replace(/\s+/g, " ").trim();
      const bAria = (b.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      const label = bTxt || bAria;
      if (!label) {
        const br = b.getBoundingClientRect();
        if (br.width <= 48 && br.height <= 48) continue;
      } else if (EXT_MEDIA_ICON_BTN_RE.test(label) && !bTxt) {
        continue;
      } else if (EXT_MEDIA_ICON_BTN_RE.test(label) && bTxt.length <= 12 && !/\b(?:add|cart|buy)\b/i.test(bTxt)) {
        continue;
      }
      return true;
    }
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    return /\$\s*\d/.test(txt);
  }

  function isExtHorizontalCarouselTrack(el) {
    if (!el || el === document.body) return false;
    const sw = Number(el.scrollWidth || 0);
    const cw = Number(el.clientWidth || 0);
    if (cw >= 40 && sw > cw + 24) return true;
    const cs = window.getComputedStyle(el);
    if (!cs) return false;
    const ox = (cs.overflowX || "").toLowerCase();
    const snap = (cs.scrollSnapType || "").toLowerCase();
    if ((ox === "scroll" || ox === "auto" || ox === "hidden") && snap && snap !== "none" && /x|inline|both/.test(snap)) {
      return true;
    }
    const disp = (cs.display || "").toLowerCase();
    const kids = el.children || [];
    if ((disp === "flex" || disp === "inline-flex") && !/^column/i.test(cs.flexDirection || "") && kids.length >= 2) {
      let firstR = null;
      for (let i = 0; i < kids.length && i < 6; i++) {
        const kr = kids[i].getBoundingClientRect();
        if (kr.width < 32 || kr.height < 32) continue;
        if (!firstR) {
          firstR = kr;
        } else if (kr.left >= firstR.left + firstR.width * 0.45 && Math.abs(kr.top - firstR.top) < firstR.height * 0.6) {
          return true;
        }
      }
    }
    if ((el.tagName === "UL" || el.tagName === "OL") && kids.length >= 2) {
      let mediaLis = 0;
      for (let j = 0; j < kids.length && j < 6; j++) {
        if (kids[j].tagName === "LI" && kids[j].querySelector?.("img, picture")) mediaLis++;
      }
      if (mediaLis >= 2) return true;
    }
    return false;
  }

  function climbAboveExtCarousel(startEl, cardEl, maxH) {
    if (!startEl || startEl === document.body || startEl === cardEl) return startEl;
    let best = startEl;
    let cur = startEl;
    for (let steps = 0; cur && cur !== cardEl && cur !== document.body && steps < 6; steps++) {
      if (isExtHorizontalCarouselTrack(cur)) {
        const shell = cur.parentElement;
        if (shell && shell !== document.body) {
          if (shell === cardEl) {
            if (!extNodeHasDetailsOrCta(cur)) best = cur;
            break;
          }
          const sr = shell.getBoundingClientRect();
          if (!extNodeHasDetailsOrCta(shell) && sr.width >= 56 && sr.height >= 56 && sr.height <= maxH + 48) {
            best = shell;
            cur = shell;
            continue;
          }
        }
      }
      const nextP = cur.parentElement;
      if (!nextP || nextP === cardEl || nextP === document.body) break;
      if (extNodeHasDetailsOrCta(nextP)) break;
      cur = nextP;
    }
    return best;
  }

  function mountPhotoBadgeUnderOrOnPhoto(cardEl, anchor, badgeEl, chosenImg = null) {
    if (!anchor || !badgeEl) return false;
    const ar = anchor.getBoundingClientRect();
    let slotTarget = climbAboveExtCarousel(anchor, cardEl, (ar.height || 240) + 80);
    let p = slotTarget.parentElement;
    for (let steps = 0; p && p !== cardEl && cardEl.contains(p) && steps < 5; steps++) {
      if (p.tagName === "A" || p.tagName === "BUTTON" || p.tagName === "PICTURE") {
        const pr = p.getBoundingClientRect();
        if (pr.height <= (ar.height || 240) + 44) {
          slotTarget = p;
          p = p.parentElement;
          continue;
        }
      }
      if (extNodeHasDetailsOrCta(p)) break;
      const pr = p.getBoundingClientRect();
      if (pr.width >= 56 && pr.height <= (ar.height || 240) + 64) {
        slotTarget = p;
        p = p.parentElement;
        continue;
      }
      break;
    }
    slotTarget = climbAboveExtCarousel(slotTarget, cardEl, (ar.height || 240) + 80);
    const parent = slotTarget.parentElement;
    if (
      parent &&
      cardEl.contains(parent) &&
      parent.tagName !== "A" &&
      parent.tagName !== "BUTTON" &&
      parent.tagName !== "PICTURE" &&
      !parent.closest?.("a, button") &&
      !isExtHorizontalCarouselTrack(parent)
    ) {
      const pcs = window.getComputedStyle(parent);
      const isAnyGrid = pcs.display === "grid" || pcs.display === "inline-grid";
      const isRowFlex =
        (pcs.display === "flex" || pcs.display === "inline-flex") &&
        !/^column/i.test(pcs.flexDirection || "");
      const hasFixedAspect = Boolean(pcs.aspectRatio && pcs.aspectRatio !== "auto");
      const hasClippedMaxHeight =
        (pcs.overflowY === "hidden" || pcs.overflowY === "clip") &&
        Boolean(pcs.maxHeight && pcs.maxHeight !== "none");
      if (!isAnyGrid && !isRowFlex && !hasFixedAspect && !hasClippedMaxHeight) {
        const beforeRect = anchor.getBoundingClientRect();
        const slot = document.createElement("div");
        slot.className = "cc-photo-badge-slot";
        badgeEl.classList.add("cc-photo-badge--under");
        slot.appendChild(badgeEl);
        slotTarget.insertAdjacentElement("afterend", slot);
        const afterRect = anchor.getBoundingClientRect();
        const slotRect = slot.getBoundingClientRect();
        const photoCollapsed =
          (beforeRect.width >= 44 && afterRect.width < Math.max(44, beforeRect.width - 10)) ||
          (beforeRect.height >= 44 && afterRect.height < Math.max(44, beforeRect.height - 16));
        const slotMisplaced =
          (afterRect.height >= 44 && slotRect.top < afterRect.bottom - 12) ||
          (afterRect.width >= 44 && Math.abs(slotRect.left - afterRect.left) > Math.max(52, afterRect.width * 0.48));
        if (!photoCollapsed && !slotMisplaced) {
          return true;
        }
        badgeEl.remove();
        slot.remove();
      }
    }
    badgeEl.classList.remove("cc-photo-badge--under");
    if (chosenImg && anchor) {
      const ancRect = anchor.getBoundingClientRect();
      const liveImgRect = chosenImg.getBoundingClientRect();
      if (liveImgRect.height >= 40 && ancRect.height > liveImgRect.height + 90) {
        const relTop = Math.max(6, Math.round(liveImgRect.bottom - ancRect.top - 40));
        if (relTop < ancRect.height - 36) {
          badgeEl.style.setProperty("top", `${relTop}px`, "important");
          badgeEl.style.setProperty("bottom", "auto", "important");
        }
      }
    }
    anchor.appendChild(badgeEl);
    return true;
  }

  function isNonFoodScanResponse(resp) {
    if (!resp?.ok || !resp.result) return true;
    return (
      resp.isCategoryEstimate === true ||
      /category estimate/i.test(resp.product?.title || "") ||
      resp.product?.nutrition?.productKind === "non-food" ||
      resp.result.yukaBreakdown?.nutriScoreGrade === "N/A"
    );
  }

  function computeCardSignature(cardEl, info) {
    const linkEl = cardEl?.querySelector?.(PRODUCT_LINK_FALLBACK_SEL) || cardEl?.querySelector?.("a[href]");
    const rawHref =
      info?.hrefKey ||
      unwrapProductHref(linkEl?.getAttribute("href") || "")
        .split("#")[0]
        .split("?")[0]
        .slice(0, 160);
    const normTitle = (info?.title || "").toLowerCase().trim();
    if (normTitle) {
      return `${normTitle}|${rawHref}|${activeBucket.bucketKey}|${photoBadgePrefRev}`;
    }
    const rawImg = (
      info?.domImageUrl ||
      info?.image ||
      info?.imgEl?.currentSrc ||
      info?.imgEl?.getAttribute?.("src") ||
      ""
    )
      .split("#")[0]
      .split("?")[0]
      .slice(0, 180);
    return `|${rawHref}|${rawImg}|${activeBucket.bucketKey}|${photoBadgePrefRev}`;
  }

  function isPlaceholderCardImage(src, imgEl) {
    if (!src) return false;
    if (imgEl && imgEl.naturalWidth > 64 && imgEl.naturalHeight > 64) return false;
    return /(?:^data:image\/(?:gif;base64,R0lGOD|svg\+xml.*(?:feGaussianBlur|blur|shimmer|skeleton|spinner|spacer|1x1)|webp;base64|png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE)|(?:^|[/_.-])(?:1x1|spacer|spinner|pixel|blank|transparent|placeholder|blur)\.(?:gif|png|svg|webp)|\/(?:icons?|sprites?)\/)/i.test(
      src
    );
  }

  function schedulePhotoBadgeRetry(delayMs) {
    const clampedMs = Math.max(200, Number(delayMs) || 200);
    const targetAt = Date.now() + clampedMs;
    if (photoBadgeRetryTimer) {
      if (photoBadgeRetryAt > 0 && targetAt >= photoBadgeRetryAt - 80) return;
      clearTimeout(photoBadgeRetryTimer);
      photoBadgeRetryTimer = null;
    }
    photoBadgeRetryAt = targetAt;
    photoBadgeRetryTimer = setTimeout(() => {
      photoBadgeRetryTimer = null;
      photoBadgeRetryAt = 0;
      scanVisiblePhotoBadges();
    }, clampedMs);
  }

  function clearAllPhotoBadges() {
    photoBadgeGeneration++;
    clearTimeout(photoBadgeBatchTimer);
    photoBadgeBatchTimer = null;
    clearTimeout(photoBadgeRetryTimer);
    photoBadgeRetryTimer = null;
    photoBadgeRetryAt = 0;
    pendingPhotoBadgeQueue.clear();
    if (photoBadgeObserver) {
      photoBadgeObserver.disconnect();
      photoBadgeObserver = null;
    }
    cardStateByEl = new WeakMap();
    ownerCardByImg = new WeakMap();
    const existing = document.querySelectorAll(".cc-photo-badge, .cc-photo-badge-slot");
    for (const el of existing) {
      el.remove();
    }
  }

  function isolatePhotoBadgeAnchor(anchor, cardEl = null) {
    if (!anchor) return null;
    if (cardEl && cardEl.style) {
      cardEl.style.isolation = "isolate";
    } else {
      anchor.style.isolation = "isolate";
    }
    return anchor;
  }

  function findCardPhotoAnchor(cardEl, preferredImgEl = null) {
    const imgs = preferredImgEl
      ? [preferredImgEl, ...cardEl.querySelectorAll("img")]
      : Array.from(cardEl.querySelectorAll("img"));
    const cardRect = typeof cardEl.getBoundingClientRect === "function" ? cardEl.getBoundingClientRect() : null;
    let chosenImg = null;
    let imgRect = null;
    let bestScore = -999;
    let idx = 0;
    for (const img of imgs) {
      idx++;
      if (!img || img.closest?.(".cc-photo-badge, .cc-photo-badge-slot")) continue;
      let src = img.currentSrc || img.getAttribute("src") || "";
      let usedAltSrc = false;
      if (!src || /^data:|^blob:/i.test(src) || isPlaceholderCardImage(src, img)) {
        const altSrc = img.getAttribute("srcset") || img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || "";
        if (altSrc) {
          const parsedAlt = String(altSrc).split(",")[0].trim().split(/\s+/)[0] || "";
          if (parsedAlt) {
            src = parsedAlt;
            usedAltSrc = true;
          }
        }
      }
      const r = img.getBoundingClientRect();
      const parentR = img.parentElement?.getBoundingClientRect?.() || r;
      const effW = Math.max(r.width, parentR.width);
      const effH = Math.max(r.height, parentR.height);
      const isExplicitLazyTile = Boolean(
        cardEl.matches?.('[data-csa-c-type="productTile"], li[data-csa-c-type="item"][data-csa-c-item-id*="asin."]') &&
          effW >= 60 &&
          effH >= 60
      );
      if (!isExplicitLazyTile && isPlaceholderCardImage(src, usedAltSrc ? null : img)) continue;
      if (effW >= 44 && effH >= 44 && effW <= 640 && effH <= 640) {
        const boxR = r.width >= 32 && r.height >= 32 ? r : parentR;
        const horizVisible =
          !cardRect ||
          cardRect.width < 40 ||
          (boxR.right > cardRect.left + 12 && boxR.left < cardRect.right - 12);
        const isPromoAlt = EXT_PROMO_SLIDE_ALT_RE.test(img.getAttribute("alt") || "");
        const candScore = (horizVisible ? 50 : -40) + (isPromoAlt ? -25 : 0) + (idx === 1 ? 8 : 0);
        if (candScore > bestScore) {
          bestScore = candScore;
          chosenImg = img;
          imgRect = boxR;
          if (horizVisible && !isPromoAlt) break;
        }
      }
    }
    if (!chosenImg) return null;

    const maxContainerH = Math.min(460, Math.max(120, Math.round(imgRect?.height || 220)) + 120);
    let cur = chosenImg.parentElement;
    let positionedCand = null;
    let fallbackBlock = null;
    for (let depth = 0; depth < 6 && cur && cur !== document.body && cardEl.contains(cur); depth++) {
      if (cur.tagName === "PICTURE") {
        cur = cur.parentElement;
        continue;
      }
      const cs = window.getComputedStyle(cur);
      const cr = cur.getBoundingClientRect();
      const existingSlot = cur.querySelector?.(":scope > .cc-photo-badge-slot");
      const slotH = existingSlot ? existingSlot.getBoundingClientRect().height : 0;
      const effectiveH = Math.max(0, cr.height - slotH);
      if (cr.width >= 44 && effectiveH >= 44 && effectiveH <= maxContainerH) {
        if (!positionedCand && cs.position !== "static" && !/^(?:inline|contents)$/i.test(cs.display)) {
          positionedCand = cur;
          break;
        }
        if (!fallbackBlock && !/^(?:inline|contents)$/i.test(cs.display)) {
          fallbackBlock = cur;
        }
      }
      if (cur === cardEl) break;
      cur = cur.parentElement;
    }

    let resolved = positionedCand || fallbackBlock;
    if (!resolved && cardEl && cardEl !== document.body) {
      const cr = cardEl.getBoundingClientRect();
      if (cr.width >= 44 && cr.height >= 44 && cr.height <= 920) {
        resolved = cardEl;
      }
    }
    if (!resolved) return null;
    resolved = climbAboveExtCarousel(resolved, cardEl, maxContainerH);
    const resPos = window.getComputedStyle(resolved).position;
    if (resPos === "static") {
      const prevPos = resolved.style.position;
      const beforeR = chosenImg.getBoundingClientRect();
      resolved.style.position = "relative";
      const afterR = chosenImg.getBoundingClientRect();
      if (beforeR.width >= 40 && (afterR.width < 24 || afterR.height < 24)) {
        resolved.style.position = prevPos;
        if (cardEl && cardEl !== resolved) {
          const fbR = cardEl.getBoundingClientRect();
          if (fbR.width >= 44 && fbR.height >= 44 && fbR.height <= 920) {
            if (window.getComputedStyle(cardEl).position === "static") {
              cardEl.style.position = "relative";
            }
            return isolatePhotoBadgeAnchor(cardEl, cardEl);
          }
        }
        return null;
      }
    }
    return isolatePhotoBadgeAnchor(resolved, cardEl);
  }

  function applyScoredPhotoBadgeState(badgeEl, resp, info, domImg, cardEl, sig) {
    if (!badgeEl || !badgeEl.isConnected) return false;
    if (!resp?.ok || isNonFoodScanResponse(resp)) {
      unmountPhotoBadgeEl(badgeEl);
      return false;
    }
    const safeScore = Math.max(0, Math.min(100, Math.round(Number(resp.result.score ?? 0))));
    const severity = resolveBadgeAlertSeverity(resp);
    const scoreTone = safeScore >= 75 ? "green" : safeScore >= 50 ? "yellow" : "red";
    const tone = severity === "allergen" ? "red" : scoreTone;
    const isPesticideOnly =
      Array.isArray(resp.dietaryAlerts) &&
      resp.dietaryAlerts.length > 0 &&
      resp.dietaryAlerts.every((a) => a && a.id === "pesticide_risk");
    const icon = severity === "none" ? "🥦" : isPesticideOnly ? "🌱" : "⚠️";
    badgeEl.classList.remove(
      "cc-photo-badge--loading",
      "cc-photo-badge--green",
      "cc-photo-badge--yellow",
      "cc-photo-badge--red",
      "cc-photo-badge--advisory"
    );
    badgeEl.classList.add(`cc-photo-badge--${tone}`);
    if (severity === "advisory") {
      badgeEl.classList.add("cc-photo-badge--advisory");
    }
    badgeEl.dataset.ccSig = sig;
    badgeEl.textContent = `${icon} ${safeScore}`;
    badgeEl.setAttribute(
      "aria-label",
      `HeyBroc score ${safeScore} out of 100 for ${resp.product?.title || info.title}. Tap to inspect and view Clean Swaps.`
    );
    badgeDataByElement.set(badgeEl, { resp, info, domImg, cardEl, sig, loading: false, openOnResolve: false });
    return true;
  }

  function openBadgeScanInDrawer(resp, info, domImg) {
    if (!resp?.ok) return;
    modalOpenedAt = Date.now();
    const seq = ++scanSeq;
    state.hoveredCardData = info;
    state.auditorOpen = false;
    state.drawerTab = "product";
    state.expanded = true;
    void applyScanResult(resp, domImg, seq);
  }

  function handlePhotoBadgeActivate(badgeEl) {
    const entry = badgeDataByElement.get(badgeEl);
    if (!entry) return;
    if (entry.loading) {
      entry.openOnResolve = true;
      return;
    }
    const liveCard = entry.cardEl?.isConnected ? entry.cardEl : badgeEl.closest(PRODUCT_CARD_SEL);
    const liveInfo = liveCard ? readProductCardInfo(liveCard) : null;
    if (
      liveCard &&
      liveInfo &&
      (computeCardSignature(liveCard, liveInfo) !== entry.sig ||
        liveInfo.title.toLowerCase().trim() !== entry.info.title.toLowerCase().trim())
    ) {
      unmountPhotoBadgeEl(badgeEl);
      cardStateByEl.delete(liveCard);
      processVisiblePhotoBadgeCard(liveCard);
      const reqBucket = activeBucket;
      const liveDomImg = liveInfo.domImageUrl || liveInfo.image || null;
      modalOpenedAt = Date.now();
      const seq = ++scanSeq;
      state.hoveredCardData = liveInfo;
      state.auditorOpen = false;
      state.drawerTab = "product";
      state.expanded = true;
      chrome.runtime.sendMessage(
        {
          type: "CLEANCART_SCAN",
          payload: {
            productTitle: liveInfo.title,
            store: reqBucket.store,
            instacartRetailerSlug: reqBucket.instacartRetailerSlug,
          },
        },
        (freshResp) => {
          if (freshResp?.ok && !isTransientLockedSwap(freshResp)) {
            lruSet(gridScanCache, normCacheKey(liveInfo.title, ""), freshResp, MAX_GRID_SCAN_CACHE);
          }
          if (seq !== scanSeq || resolveStoreBucket().bucketKey !== reqBucket.bucketKey) return;
          void applyScanResult(freshResp, liveDomImg, seq);
        }
      );
      return;
    }
    openBadgeScanInDrawer(entry.resp, entry.info, entry.domImg);
  }

  function flushPhotoBadgeBatch() {
    photoBadgeBatchTimer = null;
    if (pendingPhotoBadgeQueue.size === 0) return;
    if (isCartPageUrl() || sessionStorage.getItem(hideKeyForBucket(activeBucket.bucketKey)) === "1") {
      pendingPhotoBadgeQueue.clear();
      return;
    }
    if (inFlightPhotoBatches >= MAX_IN_FLIGHT_PHOTO_BATCHES) {
      photoBadgeBatchTimer = setTimeout(flushPhotoBadgeBatch, 220);
      return;
    }

    if (pendingPhotoBadgeQueue.size > 12) {
      const vhNow = Math.max(400, window.innerHeight || 800);
      const onScreen = [];
      const nearScreen = [];
      const offScreen = [];
      for (const pair of pendingPhotoBadgeQueue.entries()) {
        const qe = pair[1];
        if (!qe.cardEl?.isConnected) continue;
        const qr = qe.cardEl.getBoundingClientRect();
        if (qr.bottom > 40 && qr.top < vhNow - 20) onScreen.push(pair);
        else if (qr.bottom > -220 && qr.top < vhNow + 260) nearScreen.push(pair);
        else offScreen.push(pair);
      }
      pendingPhotoBadgeQueue.clear();
      for (const [k, v] of [...onScreen, ...nearScreen, ...offScreen]) {
        pendingPhotoBadgeQueue.set(k, v);
      }
    }

    const batchEntries = [];
    for (const [id, entry] of pendingPhotoBadgeQueue.entries()) {
      pendingPhotoBadgeQueue.delete(id);
      if (!entry.badgeEl?.isConnected || !entry.cardEl?.isConnected) continue;
      const liveInfo = readProductCardInfo(entry.cardEl);
      if (!liveInfo || computeCardSignature(entry.cardEl, liveInfo) !== entry.sig) {
        unmountPhotoBadgeEl(entry.badgeEl);
        cardStateByEl.delete(entry.cardEl);
        processVisiblePhotoBadgeCard(entry.cardEl);
        continue;
      }
      cardStateByEl.set(entry.cardEl, {
        sig: entry.sig,
        status: "inflight",
        badgeEl: entry.badgeEl,
        retryCount: entry.retryCount || 0,
        nextRetryAt: 0,
      });
      batchEntries.push(entry);
      if (batchEntries.length >= 12) break;
    }
    if (pendingPhotoBadgeQueue.size > 0 && !photoBadgeBatchTimer) {
      photoBadgeBatchTimer = setTimeout(flushPhotoBadgeBatch, 180);
    }
    if (batchEntries.length === 0) return;

    const gen = photoBadgeGeneration;
    const reqBucket = activeBucket;
    const items = batchEntries.map((e) =>
      e.info.barcode
        ? { id: e.id, productTitle: e.info.title, barcode: e.info.barcode }
        : { id: e.id, productTitle: e.info.title }
    );
    inFlightPhotoBatches++;

    const markBatchRetry = (backoffMs, allowRetry = true) => {
      for (const entry of batchEntries) {
        unmountPhotoBadgeEl(entry.badgeEl);
        if (!entry.cardEl?.isConnected) continue;
        const curState = cardStateByEl.get(entry.cardEl);
        if (curState && curState.badgeEl && curState.badgeEl !== entry.badgeEl) continue;
        const prevRetries = entry.retryCount || 0;
        if (allowRetry && prevRetries < 4) {
          cardStateByEl.set(entry.cardEl, {
            sig: entry.sig,
            status: "retry",
            badgeEl: null,
            retryCount: prevRetries + 1,
            nextRetryAt: Date.now() + backoffMs,
          });
        } else {
          cardStateByEl.set(entry.cardEl, {
            sig: entry.sig,
            status: "nonfood",
            badgeEl: null,
            retryCount: prevRetries,
            nextRetryAt: 0,
          });
        }
      }
      if (allowRetry) {
        schedulePhotoBadgeRetry(backoffMs + 60);
      }
    };

    try {
      chrome.runtime.sendMessage(
        {
          type: "CLEANCART_SCAN_BATCH",
          items,
          store: reqBucket.store,
          instacartRetailerSlug: reqBucket.instacartRetailerSlug,
        },
        (batchResp) => {
          inFlightPhotoBatches = Math.max(0, inFlightPhotoBatches - 1);
          if (pendingPhotoBadgeQueue.size > 0 && !photoBadgeBatchTimer) {
            photoBadgeBatchTimer = setTimeout(flushPhotoBadgeBatch, 140);
          }
          if (gen !== photoBadgeGeneration) return;
          if (resolveStoreBucket().bucketKey !== reqBucket.bucketKey) {
            for (const entry of batchEntries) {
              unmountPhotoBadgeEl(entry.badgeEl);
              if (entry.cardEl?.isConnected) cardStateByEl.delete(entry.cardEl);
            }
            schedulePhotoBadgeRetry(250);
            return;
          }
          const map = batchResp?.results || batchResp?.batch || null;
          if (!batchResp?.ok || !map || typeof map !== "object") {
            const shouldRetry = batchResp?.transient !== false;
            const retryMs = Math.min(62000, Math.max(1500, Number(batchResp?.retryAfterMs) || 2200));
            markBatchRetry(retryMs, shouldRetry);
            return;
          }
          for (const entry of batchEntries) {
            const itemResp = Object.prototype.hasOwnProperty.call(map, entry.id) ? map[entry.id] : null;
            if (itemResp?.ok && !isTransientLockedSwap(itemResp)) {
              lruSet(gridScanCache, normCacheKey(entry.info.title, ""), itemResp, MAX_GRID_SCAN_CACHE);
            }
            const keepOpen = Boolean(badgeDataByElement.get(entry.badgeEl)?.openOnResolve);
            if (!entry.cardEl?.isConnected) {
              unmountPhotoBadgeEl(entry.badgeEl);
              if (keepOpen && itemResp?.ok) {
                openBadgeScanInDrawer(itemResp, entry.info, entry.domImg);
              }
              continue;
            }
            const liveInfo = readProductCardInfo(entry.cardEl);
            if (!liveInfo || computeCardSignature(entry.cardEl, liveInfo) !== entry.sig) {
              unmountPhotoBadgeEl(entry.badgeEl);
              const curState = cardStateByEl.get(entry.cardEl);
              if (!curState || !curState.badgeEl || curState.badgeEl === entry.badgeEl) {
                cardStateByEl.delete(entry.cardEl);
                processVisiblePhotoBadgeCard(entry.cardEl);
              }
              continue;
            }
            const curState = cardStateByEl.get(entry.cardEl);
            if (curState && curState.badgeEl && curState.badgeEl !== entry.badgeEl) {
              unmountPhotoBadgeEl(entry.badgeEl);
              continue;
            }
            if (itemResp?.ok) {
              const shown = applyScoredPhotoBadgeState(
                entry.badgeEl,
                itemResp,
                entry.info,
                entry.domImg,
                entry.cardEl,
                entry.sig
              );
              cardStateByEl.set(entry.cardEl, {
                sig: entry.sig,
                status: shown ? "scored" : "nonfood",
                badgeEl: shown ? entry.badgeEl : null,
                retryCount: 0,
                nextRetryAt: 0,
              });
              if (
                shown &&
                !keepOpen &&
                isTouchPrimary() &&
                !isProductPage() &&
                !state.expanded &&
                !state.auditorOpen &&
                state.hoveredCardData?.title === entry.info.title
              ) {
                void applyScanResult(itemResp, entry.domImg, ++scanSeq);
              }
              if (keepOpen) {
                if (shown) {
                  handlePhotoBadgeActivate(entry.badgeEl);
                } else {
                  openBadgeScanInDrawer(itemResp, entry.info, entry.domImg);
                }
              }
            } else {
              unmountPhotoBadgeEl(entry.badgeEl);
              const prevRetries = entry.retryCount || 0;
              const confirmedNonFood =
                itemResp?.isNonFood === true ||
                itemResp?.status === 422 ||
                /non-food/i.test(itemResp?.error || "");
              if (!confirmedNonFood && prevRetries < 1) {
                const retryDelayMs = 18000;
                cardStateByEl.set(entry.cardEl, {
                  sig: entry.sig,
                  status: "retry",
                  badgeEl: null,
                  retryCount: prevRetries + 1,
                  nextRetryAt: Date.now() + retryDelayMs,
                });
                schedulePhotoBadgeRetry(retryDelayMs + 200);
              } else {
                cardStateByEl.set(entry.cardEl, {
                  sig: entry.sig,
                  status: "nonfood",
                  badgeEl: null,
                  retryCount: prevRetries,
                  nextRetryAt: 0,
                });
              }
              if (keepOpen) {
                modalOpenedAt = Date.now();
                const seq = ++scanSeq;
                state.hoveredCardData = entry.info;
                state.auditorOpen = false;
                state.drawerTab = "product";
                state.expanded = true;
                chrome.runtime.sendMessage(
                  {
                    type: "CLEANCART_SCAN",
                    payload: {
                      productTitle: entry.info.title,
                      barcode: entry.info.barcode || undefined,
                      store: reqBucket.store,
                      instacartRetailerSlug: reqBucket.instacartRetailerSlug,
                    },
                  },
                  (freshResp) => {
                    if (freshResp?.ok && !isTransientLockedSwap(freshResp)) {
                      lruSet(gridScanCache, normCacheKey(entry.info.title, ""), freshResp, MAX_GRID_SCAN_CACHE);
                    }
                    if (seq !== scanSeq || resolveStoreBucket().bucketKey !== reqBucket.bucketKey) return;
                    void applyScanResult(freshResp, entry.domImg, seq);
                  }
                );
              }
            }
          }
        }
      );
    } catch {
      inFlightPhotoBatches = Math.max(0, inFlightPhotoBatches - 1);
      markBatchRetry(2200, true);
    }
  }

  function removeCardPhotoBadges(cardEl) {
    if (!cardEl?.querySelectorAll) return;
    for (const b of cardEl.querySelectorAll(".cc-photo-badge, .cc-photo-badge-slot")) {
      b.remove();
    }
  }

  function processVisiblePhotoBadgeCard(cardEl) {
    if (!cardEl || !cardEl.isConnected || isCartPageUrl()) return;
    if (sessionStorage.getItem(hideKeyForBucket(activeBucket.bucketKey)) === "1") return;
    const info = readProductCardInfo(cardEl);
    if (!info) return;
    if (info.imgEl) {
      const existingOwner = ownerCardByImg.get(info.imgEl);
      if (existingOwner && existingOwner !== cardEl && existingOwner.isConnected) return;
      ownerCardByImg.set(info.imgEl, cardEl);
    }
    const sig = computeCardSignature(cardEl, info);
    const prevState = cardStateByEl.get(cardEl);
    const prevRetryCount = prevState && prevState.sig === sig ? prevState.retryCount || 0 : 0;

    if (isNonFoodGridTitle(info.title)) {
      removeCardPhotoBadges(cardEl);
      cardStateByEl.set(cardEl, { sig, status: "nonfood", badgeEl: null, retryCount: 0, nextRetryAt: 0 });
      return;
    }
    const anchor = findCardPhotoAnchor(cardEl, info.imgEl);
    if (!anchor) {
      cardStateByEl.set(cardEl, {
        sig,
        status: "awaiting_photo",
        badgeEl: null,
        retryCount: prevRetryCount,
        nextRetryAt: 0,
      });
      return;
    }

    removeCardPhotoBadges(cardEl);
    ensurePhotoBadgeStyles();

    const domImg = info.domImageUrl || info.image || null;
    const cKey = normCacheKey(info.title, "");
    const cached = lruGet(gridScanCache, cKey);
    if (cached) {
      if (!cached.ok || isNonFoodScanResponse(cached)) {
        cardStateByEl.set(cardEl, { sig, status: "nonfood", badgeEl: null, retryCount: 0, nextRetryAt: 0 });
        return;
      }
      const badgeEl = document.createElement("span");
      badgeEl.className = "cc-photo-badge";
      badgeEl.setAttribute("role", "button");
      badgeEl.setAttribute("tabindex", "0");
      mountPhotoBadgeUnderOrOnPhoto(cardEl, anchor, badgeEl, info.imgEl);
      const shown = applyScoredPhotoBadgeState(badgeEl, cached, info, domImg, cardEl, sig);
      cardStateByEl.set(cardEl, {
        sig,
        status: shown ? "scored" : "nonfood",
        badgeEl: shown ? badgeEl : null,
        retryCount: 0,
        nextRetryAt: 0,
      });
      return;
    }

    const badgeEl = document.createElement("span");
    badgeEl.className = "cc-photo-badge cc-photo-badge--loading";
    badgeEl.setAttribute("role", "button");
    badgeEl.setAttribute("tabindex", "0");
    badgeEl.setAttribute("aria-label", `Scoring ${info.title} with HeyBroc`);
    badgeEl.dataset.ccSig = sig;
    badgeEl.textContent = "🥦 …";
    mountPhotoBadgeUnderOrOnPhoto(cardEl, anchor, badgeEl, info.imgEl);
    badgeDataByElement.set(badgeEl, {
      resp: null,
      info,
      domImg,
      cardEl,
      sig,
      loading: true,
      openOnResolve: false,
    });
    cardStateByEl.set(cardEl, {
      sig,
      status: "queued",
      badgeEl,
      retryCount: prevRetryCount,
      nextRetryAt: 0,
    });

    const id = `c${nextPhotoBadgeSeq++}`;
    pendingPhotoBadgeQueue.set(id, { id, info, domImg, badgeEl, cardEl, sig, retryCount: prevRetryCount });
    if (!photoBadgeBatchTimer) {
      photoBadgeBatchTimer = setTimeout(flushPhotoBadgeBatch, 220);
    }
  }

  function ensurePhotoBadgeObserver() {
    if (photoBadgeObserver || typeof IntersectionObserver === "undefined") return photoBadgeObserver;
    photoBadgeObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          photoBadgeObserver?.unobserve(entry.target);
          processVisiblePhotoBadgeCard(entry.target);
        }
      },
      { rootMargin: "180px 340px" }
    );
    return photoBadgeObserver;
  }

  function discoverPhotoBadgeCards() {
    const found = [];
    const seen = new Set();
    const onPdp = isProductPage();
    const maxCardW = onPdp ? 360 : Math.max(580, (window.innerWidth || 412) + 32);

    const addCandidate = (el) => {
      if (!el || seen.has(el) || host?.contains(el)) return;
      if (el.closest('header, nav, footer, [role="contentinfo"]')) return;
      if (!el.querySelector?.("img")) return;
      if (hasMultipleDistinctProductLinks(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.width < 84 || r.width > maxCardW || r.height < 84 || r.height > 1080)) return;
      for (let i = 0; i < found.length; i++) {
        const ex = found[i];
        if (ex.contains(el)) return;
        if (el.contains(ex)) {
          if (ex.matches?.(DEFINITIVE_SINGLE_CARD_SEL) && !el.matches?.(DEFINITIVE_SINGLE_CARD_SEL)) {
            return;
          }
          seen.delete(ex);
          seen.add(el);
          found[i] = el;
          return;
        }
      }
      seen.add(el);
      found.push(el);
    };

    const directCards = document.querySelectorAll(PRODUCT_CARD_SEL);
    for (const c of directCards) addCandidate(c);

    // Link-based tile fallback for mobile storefronts (Instacart, Sam's Club, ALDI, Costco, Walmart mobile)
    if (!onPdp) {
      const links = document.querySelectorAll(PRODUCT_LINK_FALLBACK_SEL);
      for (const a of links) {
        if (a.closest(PRODUCT_CARD_SEL) || a.closest('header, nav, footer, [role="contentinfo"]')) continue;
        let cur = a;
        let tile = null;
        for (let depth = 0; depth < 5 && cur && cur !== document.body; depth++) {
          if (cur.querySelector("img")) {
            if (hasMultipleDistinctProductLinks(cur)) break;
            const r = cur.getBoundingClientRect();
            if (r.width >= 90 && r.width <= maxCardW && r.height >= 90 && r.height <= 900) {
              tile = cur;
              if (/^(ARTICLE|LI)$/i.test(cur.tagName)) break;
            }
          }
          cur = cur.parentElement;
        }
        if (tile) addCandidate(tile);
      }

      if (/(?:doordash|ubereats|instacart|shipt|aldi)\./i.test(HOST)) {
        const btnTiles = document.querySelectorAll('div[role="button"], li[role="button"], button');
        for (let bt = 0; bt < btnTiles.length && bt < 220; bt++) {
          const bel = btnTiles[bt];
          if (bel.closest(PRODUCT_CARD_SEL) || bel.closest('header, nav, footer, [role="contentinfo"]')) continue;
          if (!bel.querySelector?.("img")) continue;
          if (bel.querySelectorAll("img").length > 3) continue;
          const br = bel.getBoundingClientRect();
          if (br.width < 96 || br.width > maxCardW || br.height < 110 || br.height > 640) continue;
          if (!/\$\s*\d/.test(bel.textContent || "")) continue;
          addCandidate(bel);
        }
      }
    }
    return found;
  }

  function scanVisiblePhotoBadges() {
    if (location.href !== lastPhotoBadgePageUrl) {
      lastPhotoBadgePageUrl = location.href;
      clearAllPhotoBadges();
    }
    if (isCartPageUrl() || sessionStorage.getItem(hideKeyForBucket(activeBucket.bucketKey)) === "1") {
      clearAllPhotoBadges();
      return;
    }
    const obs = ensurePhotoBadgeObserver();
    const cards = discoverPhotoBadgeCards();
    const now = Date.now();
    let minRemainingRetryMs = Infinity;
    for (const card of cards) {
      const info = readProductCardInfo(card);
      const prev = cardStateByEl.get(card);
      if (!info) {
        if (prev) {
          unmountPhotoBadgeEl(prev.badgeEl);
          removeCardPhotoBadges(card);
          cardStateByEl.delete(card);
        }
        continue;
      }
      const sig = computeCardSignature(card, info);
      if (prev) {
        if (prev.sig !== sig) {
          unmountPhotoBadgeEl(prev.badgeEl);
          removeCardPhotoBadges(card);
          obs?.unobserve(card);
          cardStateByEl.delete(card);
        } else if (prev.status === "awaiting_photo") {
          if (!findCardPhotoAnchor(card, info.imgEl)) continue;
          obs?.unobserve(card);
          cardStateByEl.delete(card);
        } else if (prev.status === "retry") {
          const retryAt = prev.nextRetryAt || 0;
          if (now < retryAt) {
            minRemainingRetryMs = Math.min(minRemainingRetryMs, retryAt - now);
            continue;
          }
        } else if (prev.status === "scored" && !prev.badgeEl?.isConnected) {
          cardStateByEl.delete(card);
        } else {
          continue;
        }
      }
      if (obs) {
        cardStateByEl.set(card, {
          sig,
          status: "observing",
          badgeEl: null,
          retryCount: prev && prev.sig === sig ? prev.retryCount || 0 : 0,
          nextRetryAt: 0,
        });
        obs.observe(card);
      } else {
        processVisiblePhotoBadgeCard(card);
      }
    }
    if (Number.isFinite(minRemainingRetryMs)) {
      schedulePhotoBadgeRetry(minRemainingRetryMs + 40);
    }
  }

  function eventTargetElement(e) {
    const t = e?.target;
    return t && t.nodeType === 1 ? t : t?.parentElement || null;
  }

  document.addEventListener(
    "click",
    (e) => {
      const targetEl = eventTargetElement(e);
      const badge = targetEl?.closest?.(".cc-photo-badge");
      if (!badge) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      handlePhotoBadgeActivate(badge);
    },
    true
  );

  for (const evtName of ["mousedown", "mouseup", "auxclick", "touchend"]) {
    document.addEventListener(
      evtName,
      (e) => {
        const targetEl = eventTargetElement(e);
        const badge = targetEl?.closest?.(".cc-photo-badge");
        if (!badge) return;
        e.stopPropagation();
        e.stopImmediatePropagation();
      },
      { capture: true, passive: true }
    );
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const targetEl = eventTargetElement(e);
      const badge = targetEl?.closest?.(".cc-photo-badge");
      if (!badge) return;
      e.preventDefault();
      e.stopPropagation();
      handlePhotoBadgeActivate(badge);
    },
    true
  );

  // Multi-product grid/aisle hover, keyboard-focus & mobile pill-alignment disambiguation:
  // Scans the exact product tile the shopper hovers, focuses, or aligns with the floating pill on mobile!
  let hoverTimer = null;
  let lastHoveredCardEl = null;
  let lastMobileAlignedTitle = "";
  let mobileScrollTimer = null;

  function findAlignedMobileProductCard() {
    if (!isTouchPrimary() || isProductPage() || isCartPageUrl() || detectOpenCartRoot()) return null;
    if (BASE_STORE === "amazon") {
      const crumbNodes = document.querySelectorAll(
        "#wayfinding-breadcrumbs_feature_div, #breadcrumb_feature_div, [id*='breadcrumb' i]"
      );
      const crumbText = [...crumbNodes].map((n) => n.textContent || "").join(" ");
      if (AMAZON_NON_GROCERY_CRUMB_RE.test(crumbText)) return null;
    }

    const seen = new Set();
    const candidates = [];
    const addMobileCandidate = (el) => {
      if (!el || host?.contains(el) || seen.has(el)) return;
      if (hasMultipleDistinctProductLinks(el)) return;
      for (let i = 0; i < candidates.length; i++) {
        const ex = candidates[i];
        if (ex.contains(el)) return;
        if (el.contains(ex)) {
          seen.delete(ex);
          seen.add(el);
          candidates[i] = el;
          return;
        }
      }
      seen.add(el);
      candidates.push(el);
    };

    for (const el of document.querySelectorAll(PRODUCT_CARD_SEL)) {
      addMobileCandidate(el);
    }
    const prodLinks = document.querySelectorAll(PRODUCT_LINK_FALLBACK_SEL);
    for (let i = 0; i < prodLinks.length && i < 160; i++) {
      const a = prodLinks[i];
      if (!a || host?.contains(a)) continue;
      let card = a.closest(PRODUCT_CARD_SEL);
      if (!card) {
        let cur = a.parentElement;
        let depth = 0;
        while (cur && cur !== document.body && !/^(MAIN|UL|OL|SECTION)$/i.test(cur.tagName) && depth < 6) {
          if (hasMultipleDistinctProductLinks(cur)) break;
          const r = cur.getBoundingClientRect();
          if (r.height >= 64 && r.height <= 760 && r.width >= 100) {
            card = cur;
            break;
          }
          cur = cur.parentElement;
          depth++;
        }
      }
      if (card) addMobileCandidate(card);
    }

    const vh = Math.max(320, window.innerHeight || 720);
    const pillRect = pillEl && !pillEl.hidden ? pillEl.getBoundingClientRect() : null;
    const pillCenterY =
      pillRect && pillRect.height > 4
        ? (pillRect.top + pillRect.bottom) / 2
        : (Math.max(8, Math.min(92, Number(state.y) || 50)) / 100) * vh;
    const maxSearchGap = Math.max(320, vh * 0.65);
    let bestCard = null;
    let bestInfo = null;
    let bestRank = Infinity;

    for (const card of candidates) {
      if (!isElementVisible(card)) continue;
      if (isCartDrawerElement(card.closest('[role="dialog"], aside, section'))) continue;
      const cr = card.getBoundingClientRect();
      if (cr.height < 54 || cr.height > 780 || cr.width < 90) continue;
      if (cr.bottom < 105 || cr.top > vh - 55) continue;

      const overlapDist =
        pillCenterY < cr.top ? cr.top - pillCenterY : pillCenterY > cr.bottom ? pillCenterY - cr.bottom : 0;
      if (overlapDist > maxSearchGap) continue;

      const info = readProductCardInfo(card);
      if (!info || !info.title) continue;
      if (
        BASE_STORE === "amazon" &&
        !REAL_ING_HINT_RE.test(info.title) &&
        !AMAZON_FOOD_OR_CARE_TITLE_RE.test(info.title) &&
        !isAmazonGroceryPage(null)
      ) {
        continue;
      }

      const centerDist = Math.abs((cr.top + cr.bottom) / 2 - pillCenterY);
      const headerPenalty = overlapDist > 0 && cr.top < 72 ? (72 - cr.top) * 0.45 : 0;
      const rank = overlapDist + centerDist * 0.12 + headerPenalty;
      if (rank < bestRank) {
        bestRank = rank;
        bestCard = card;
        bestInfo = info;
      }
    }
    return bestCard && bestInfo ? { card: bestCard, info: bestInfo } : null;
  }

  function alignMobileSearchCardToPill(forceRescan = false) {
    const match = findAlignedMobileProductCard();
    if (!match) {
      lastMobileAlignedTitle = "";
      state.hoveredCardData = null;
      if (forceRescan && !state.expanded && !state.auditorOpen) {
        ++scanSeq;
        lastKey = "";
        state.mode = "cart_avg";
        state.lastDomProductImageUrl = null;
        render();
      }
      return false;
    }
    if (!forceRescan && lastMobileAlignedTitle === match.info.title && state.hoveredCardData?.title === match.info.title) {
      render();
      return true;
    }
    lastMobileAlignedTitle = match.info.title;
    triggerGridCardInspect(match.card);
    return true;
  }

  window.addEventListener(
    "scroll",
    () => {
      if (!isTouchPrimary() || isProductPage() || isCartPageUrl() || state.expanded || state.auditorOpen || state.dragging) {
        return;
      }
      clearTimeout(mobileScrollTimer);
      mobileScrollTimer = setTimeout(() => {
        if (!isTouchPrimary() || isProductPage() || isCartPageUrl() || state.expanded || state.auditorOpen || state.dragging) {
          return;
        }
        if (!alignMobileSearchCardToPill(false)) {
          ++scanSeq;
          lastKey = "";
          state.mode = "cart_avg";
          state.lastDomProductImageUrl = null;
          render();
        }
      }, 190);
    },
    { passive: true }
  );

  function triggerGridCardInspect(cardEl) {
    if (isProductPage() || isCartPageUrl()) return;
    const info = readProductCardInfo(cardEl);
    if (!info) return;
    // Increment scanSeq BEFORE synchronous gridScanCache hits so any older in-flight network scan is immediately invalidated!
    const seq = ++scanSeq;
    state.hoveredCardData = info;
    const domImg = info.domImageUrl || info.image || null;
    const cKey = normCacheKey(info.title, "");
    const cached = lruGet(gridScanCache, cKey);
    if (cached?.ok) {
      if (isNonFoodScanResponse(cached)) return;
      void applyScanResult(cached, domImg, seq);
      return;
    }
    if (isTouchPrimary()) {
      const cardSt = cardStateByEl.get(cardEl);
      if (cardSt && (cardSt.status === "queued" || cardSt.status === "inflight")) {
        return;
      }
    }
    const reqBucket = activeBucket;
    chrome.runtime.sendMessage(
      {
        type: "CLEANCART_SCAN",
        payload: {
          productTitle: info.title,
          barcode: info.barcode || undefined,
          store: reqBucket.store,
          instacartRetailerSlug: reqBucket.instacartRetailerSlug,
          skipAnalytics: true,
        },
      },
      (resp) => {
        if (resp?.ok && !isTransientLockedSwap(resp)) {
          lruSet(gridScanCache, cKey, resp, MAX_GRID_SCAN_CACHE);
        } else if (!resp?.ok && lastMobileAlignedTitle === info.title) {
          lastMobileAlignedTitle = "";
        }
        if (
          seq !== scanSeq ||
          isProductPage() ||
          state.hoveredCardData?.title !== info.title ||
          resolveStoreBucket().bucketKey !== reqBucket.bucketKey ||
          isNonFoodScanResponse(resp)
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
      if (e.pointerType === "touch") return;
      if (isProductPage() || isCartPageUrl() || state.expanded || state.auditorOpen) return;
      const targetEl = eventTargetElement(e);
      if (!targetEl || host?.contains(targetEl) || targetEl.closest?.(".cc-photo-badge, .cc-photo-badge-slot")) return;
      const card = targetEl.closest?.(PRODUCT_CARD_SEL);
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
      const targetEl = eventTargetElement(e);
      if (!targetEl || isProductPage() || isCartPageUrl() || host?.contains(targetEl) || targetEl.closest?.(".cc-photo-badge, .cc-photo-badge-slot")) return;
      const card = targetEl.closest?.(PRODUCT_CARD_SEL);
      if (card) triggerGridCardInspect(card);
    },
    { passive: true }
  );

  // Stop store card press handlers when tapping a photo badge, or pre-warm product links otherwise
  document.addEventListener(
    "pointerdown",
    (e) => {
      const targetEl = eventTargetElement(e);
      if (!targetEl || host?.contains(targetEl)) return;
      if (targetEl.closest?.(".cc-photo-badge")) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }
      const a = targetEl.closest?.(
        'a[link-identifier], a[href*="/sp/track"], a[href*="/ip/"], a[href*="/products/"], a[href*="/p/"], a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/gp/aw/d/"], [data-testid*="product" i] a'
      );
      if (!a) return;
      const rawText = cleanProductTitleText(a.getAttribute("aria-label") || a.textContent || "");
      if (rawText.length < 4 || rawText.length > 180 || NON_TITLE_RE.test(rawText)) return;
      const cKey = normCacheKey(rawText, "");
      if (gridScanCache.has(cKey)) return;
      chrome.runtime.sendMessage(
        {
          type: "CLEANCART_SCAN",
          payload: {
            productTitle: rawText,
            store: activeBucket.store,
            instacartRetailerSlug: activeBucket.instacartRetailerSlug,
            skipAnalytics: true,
          },
        },
        (resp) => {
          if (resp?.ok && !isTransientLockedSwap(resp)) lruSet(gridScanCache, cKey, resp, MAX_GRID_SCAN_CACHE);
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

  function isPhotoBadgeNode(node) {
    if (!node) return false;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return false;
    return Boolean(
      el.id === PHOTO_BADGE_STYLE_ID ||
      el.classList?.contains?.("cc-photo-badge") ||
      el.classList?.contains?.("cc-photo-badge-slot") ||
      el.closest?.(".cc-photo-badge, .cc-photo-badge-slot")
    );
  }

  function isIgnoredOverlayMutation(m) {
    const t = m.target;
    if (host && (t === host || host.contains(t))) return true;
    if (isPhotoBadgeNode(t)) return true;
    if (m.type === "childList") {
      const added = m.addedNodes ? Array.from(m.addedNodes) : [];
      const removed = m.removedNodes ? Array.from(m.removedNodes) : [];
      if (
        (added.length > 0 || removed.length > 0) &&
        added.every(isPhotoBadgeNode) &&
        removed.every(isPhotoBadgeNode)
      ) {
        return true;
      }
    }
    return false;
  }

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

    const obsTarget = document.documentElement || document.body;
    if (obsTarget) {
      new MutationObserver((mutations) => {
        for (let i = 0; i < mutations.length; i++) {
          if (!isIgnoredOverlayMutation(mutations[i])) {
            schedule();
            return;
          }
        }
      }).observe(obsTarget, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "data-src", "href"],
      });
    }
    document.addEventListener(
      "load",
      (e) => {
        if (e?.target?.tagName === "IMG") schedule();
      },
      true
    );
    const scheduleSpaTransition = () => {
      schedule();
      setTimeout(schedule, 500);
    };
    window.addEventListener("popstate", scheduleSpaTransition);
    window.addEventListener("hashchange", scheduleSpaTransition);
    const origPushState = history.pushState;
    history.pushState = function (...args) {
      const ret = origPushState.apply(this, args);
      scheduleSpaTransition();
      return ret;
    };
    const origReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const ret = origReplaceState.apply(this, args);
      scheduleSpaTransition();
      return ret;
    };

    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        // Live cross-tab sync for the active store's isolated cart bucket
        const currentStorageKey = storageKeyForBucket(activeBucket.bucketKey);
        if (areaName === "local" && changes[currentStorageKey] && !savingCartSelf) {
          const nextRaw = changes[currentStorageKey].newValue;
          const sanitized = Array.isArray(nextRaw)
            ? nextRaw.map(sanitizeStoredCartItem).filter(Boolean).slice(0, MAX_CART_ITEMS)
            : [];
          state.cartItems = filterFreshCartItems(sanitized, null, activeBucket.bucketKey);
          state.displayedAvg = calcCartAvg();
          render();
        }
        // Live re-scoring of active product, photo badges, AND cached cart items when Watchlist or auth credentials change
        if (
          changes.watchlist ||
          changes.familyWatchlist ||
          changes.dietaryWatchlist ||
          changes.preferStoreBrand ||
          changes.heybroc_auth_token ||
          changes.heybroc_device_id ||
          changes.heybroc_device_secret
        ) {
          photoBadgePrefRev++;
          scanCache.clear();
          gridScanCache.clear();
          stockCache.clear();
          lastKey = "";
          clearAllPhotoBadges();
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
