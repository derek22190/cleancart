const DEFAULT_API = "https://www.heybroc.com";
const RING_C = 2 * Math.PI * 40;

const input = document.getElementById("api");
const status = document.getElementById("status");
const storeBadge = document.getElementById("store-badge");
const cartCard = document.getElementById("cart-card");
const ringFill = document.getElementById("ring-fill");
const avgVal = document.getElementById("avg-val");
const avgRating = document.getElementById("avg-rating");
const cartHeadline = document.getElementById("cart-headline");
const cartSub = document.getElementById("cart-sub");
const projChip = document.getElementById("proj-chip");
const itemList = document.getElementById("item-list");
const loginLink = document.getElementById("login-link");
const upgradeLink = document.getElementById("upgrade-link");

const RESERVED_SLUGS = new Set([
  "s", "search", "cart", "checkout", "account", "hub", "referrals", "orders",
  "lists", "store", "stores", "items", "products", "product", "item", "help",
  "login", "signup", "categories", "collections", "shop", "convenience", "grocery",
]);

let currentBucketKey = null;
let currentStoreLabel = "Grocery";

function clampQty(q) {
  if (q === undefined || q === null || q === "") return 1;
  const n = Number(q);
  if (!Number.isFinite(n)) return 1;
  return Math.min(99, Math.max(1, Math.round(n)));
}

function isScoredFood(item) {
  if (!item || item.pending || item.isNonFood) return false;
  if (item.score === null || item.score === undefined) return false;
  return Number.isFinite(Number(item.score));
}

function calcQuantityWeightedAvg(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  let sum = 0;
  let qtyTotal = 0;
  for (const item of items) {
    if (!isScoredFood(item)) continue;
    const qty = clampQty(item.quantity);
    sum += Number(item.score) * qty;
    qtyTotal += qty;
  }
  return qtyTotal > 0 ? Math.round(sum / qtyTotal) : null;
}

function calcProjectedAfterSwaps(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  let sum = 0;
  let qtyTotal = 0;
  for (const item of items) {
    if (!isScoredFood(item)) continue;
    const qty = clampQty(item.quantity);
    const before = Number(item.score);
    const sw =
      !item.swapOutOfStock && item.swapScore !== null && item.swapScore !== undefined && Number.isFinite(Number(item.swapScore))
        ? Number(item.swapScore)
        : null;
    sum += (sw !== null && sw > before ? sw : before) * qty;
    qtyTotal += qty;
  }
  return qtyTotal > 0 ? Math.round(sum / qtyTotal) : null;
}

function toneForScore(score) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) return "gray";
  return score >= 75 ? "green" : score >= 50 ? "yellow" : "red";
}

function ratingForScore(score) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) return "Empty";
  return score >= 75 ? "Excellent" : score >= 50 ? "Mediocre" : "Poor";
}

function prettySlug(slug) {
  return String(slug || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\d{3,}\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function inferBucketFromTabUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const h = u.hostname.toLowerCase();
    const p = u.pathname;
    if (h.includes("instacart")) {
      const m = p.match(/\/store\/([^/?#]+)/i);
      const slug = m?.[1]?.toLowerCase() || "";
      if (slug && !RESERVED_SLUGS.has(slug)) {
        return { bucketKey: `instacart:${slug}`, label: `Instacart · ${prettySlug(slug)}` };
      }
      return { bucketKey: "instacart", label: "Instacart" };
    }
    if (h.includes("wholefoods")) return { bucketKey: "amazon:wholefoods", label: "Whole Foods" };
    if (h.includes("amazon")) {
      const full = `${p}${u.search}`.toLowerCase();
      if (full.includes("wholefoods") || full.includes("dob2xliezvb2rz")) {
        return { bucketKey: "amazon:wholefoods", label: "Whole Foods" };
      }
      if (full.includes("amazonfresh") || full.includes("/alm/") || full.includes("almbrandid=")) {
        return { bucketKey: "amazon:fresh", label: "Amazon Fresh" };
      }
      return { bucketKey: "amazon:core", label: "Amazon" };
    }
    if (h.includes("doordash")) {
      const m = p.match(/\/(?:convenience|grocery|retail)?\/?store\/([^/?#]+)/i);
      const slug = m?.[1]?.toLowerCase() || "";
      if (slug && !RESERVED_SLUGS.has(slug)) {
        return { bucketKey: `doordash:${slug}`, label: `DoorDash · ${prettySlug(slug)}` };
      }
      return { bucketKey: "doordash", label: "DoorDash" };
    }
    if (h.includes("ubereats")) {
      const m = p.match(/\/store\/([^/?#]+)/i);
      const slug = m?.[1]?.toLowerCase() || "";
      if (slug && !RESERVED_SLUGS.has(slug)) {
        return { bucketKey: `ubereats:${slug}`, label: `Uber Eats · ${prettySlug(slug)}` };
      }
      return { bucketKey: "ubereats", label: "Uber Eats" };
    }
    if (h.includes("shipt")) {
      const m = p.match(/\/(?:shop\/)?stores\/([^/?#]+)/i);
      const slug = m?.[1]?.toLowerCase() || "";
      if (slug && !RESERVED_SLUGS.has(slug)) {
        return { bucketKey: `shipt:${slug}`, label: `Shipt · ${prettySlug(slug)}` };
      }
      return { bucketKey: "shipt", label: "Shipt" };
    }
    if (h.includes("walmart")) return { bucketKey: "walmart", label: "Walmart" };
    if (h.includes("target")) return { bucketKey: "target", label: "Target" };
    if (h.includes("kroger")) return { bucketKey: "kroger", label: "Kroger" };
    if (h.includes("aldi")) return { bucketKey: "aldi", label: "ALDI" };
    if (h.includes("costco")) return { bucketKey: "costco", label: "Costco" };
    if (h.includes("samsclub")) return { bucketKey: "sams", label: "Sam's Club" };
    if (h.includes("bjs")) return { bucketKey: "bjs", label: "BJ's Wholesale" };
  } catch {
    /* ignore */
  }
  return null;
}

function renderPopupCart(label, items) {
  currentStoreLabel = label || "Grocery";
  storeBadge.textContent = currentStoreLabel;

  const cleanItems = Array.isArray(items) ? items : [];
  const avg = calcQuantityWeightedAvg(cleanItems);
  const projected = calcProjectedAfterSwaps(cleanItems);
  const totalUnits = cleanItems.reduce((acc, i) => acc + clampQty(i?.quantity), 0);
  const tone = toneForScore(avg);

  cartCard.className = `cart-card tone-${tone}`;
  const hasAvg = avg !== null && avg !== undefined;
  ringFill.setAttribute(
    "stroke-dashoffset",
    (hasAvg ? RING_C * (1 - avg / 100) : RING_C).toFixed(2)
  );
  avgVal.textContent = hasAvg ? String(avg) : "--";
  avgRating.textContent = hasAvg ? ratingForScore(avg) : "Empty";

  if (cleanItems.length === 0) {
    cartHeadline.textContent = `${currentStoreLabel} cart is empty`;
    cartSub.textContent = "Each store & marketplace retailer keeps its own isolated cart.";
    projChip.hidden = true;
    itemList.hidden = true;
    itemList.innerHTML = "";
    return;
  }

  cartHeadline.textContent = hasAvg ? `${currentStoreLabel} Avg: ${avg}/100` : `${currentStoreLabel} Cart`;
  cartSub.textContent = `${cleanItems.length} ${cleanItems.length === 1 ? "item" : "items"} · ${totalUnits} ${totalUnits === 1 ? "unit" : "units"}`;

  if (hasAvg && projected !== null && projected > avg) {
    projChip.hidden = false;
    projChip.textContent = `✨ ${projected}/100 (+${projected - avg}) with Clean Swaps`;
  } else {
    projChip.hidden = true;
  }

  itemList.hidden = false;
  itemList.innerHTML = "";
  cleanItems.forEach((item, idx) => {
    const li = document.createElement("li");
    const scored = isScoredFood(item);
    const rowTone = scored ? toneForScore(item.score) : "gray";
    li.className = `item-row tone-${rowTone}`;

    const titleSpan = document.createElement("span");
    titleSpan.className = "item-title";
    titleSpan.textContent = item.title || item.key || "Grocery item";
    li.appendChild(titleSpan);

    const qty = clampQty(item.quantity);
    if (qty > 1) {
      const qSpan = document.createElement("span");
      qSpan.className = "qty-pill";
      qSpan.textContent = `×${qty}`;
      li.appendChild(qSpan);
    }

    const sSpan = document.createElement("span");
    sSpan.className = "score-pill";
    sSpan.textContent = item.pending ? "…" : item.isNonFood ? "N/A" : scored ? String(item.score) : "--";
    li.appendChild(sSpan);

    const remBtn = document.createElement("button");
    remBtn.type = "button";
    remBtn.className = "remove-btn";
    remBtn.title = "Remove from cart";
    remBtn.textContent = "✕";
    remBtn.addEventListener("click", async () => {
      if (!currentBucketKey) return;
      const next = cleanItems.filter((_, i) => i !== idx);
      await chrome.storage.local.set({ [`heybroc_cart_v2_${currentBucketKey}`]: next });
      renderPopupCart(currentStoreLabel, next);
    });
    li.appendChild(remBtn);

    itemList.appendChild(li);
  });
}

async function initPopup() {
  const [{ apiBase }, localData] = await Promise.all([
    chrome.storage.sync.get("apiBase"),
    chrome.storage.local.get(["heybroc_device_id", "heybroc_creator_code", "heybroc_active_bucket_meta"]),
  ]);
  const resolvedBase = ((apiBase || DEFAULT_API).trim().replace(/\/+$/, "")) || DEFAULT_API;
  input.value = resolvedBase;

  const deviceId = localData.heybroc_device_id || "";
  const creatorCode = localData.heybroc_creator_code || "";

  const isIosSafari =
    typeof navigator !== "undefined" &&
    (/iPhone|iPad|iPod/i.test(navigator.userAgent || "") ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

  const makeAuthHref = (flag) => {
    if (isIosSafari) {
      return flag === "upgrade" ? "heybroc://upgrade" : "heybroc://login";
    }
    const p = new URLSearchParams();
    p.set(flag, "1");
    if (deviceId) p.set("deviceId", deviceId);
    if (creatorCode) p.set("code", creatorCode);
    return `${resolvedBase}/?${p.toString()}`;
  };
  if (loginLink) {
    loginLink.href = makeAuthHref("login");
    if (isIosSafari) loginLink.removeAttribute("target");
  }
  if (upgradeLink) {
    upgradeLink.href = makeAuthHref("upgrade");
    if (isIosSafari) upgradeLink.removeAttribute("target");
  }

  // Query active tab first so we show the exact open store / Instacart retailer cart
  let tabState = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      tabState = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { type: "CLEANCART_GET_TAB_STATE" }, (res) => {
          if (chrome.runtime.lastError || !res?.ok) resolve(null);
          else resolve(res);
        });
      });
    }
    if (!tabState && tab?.url) {
      const inferred = inferBucketFromTabUrl(tab.url);
      if (inferred) {
        const storedCart = await chrome.storage.local.get(`heybroc_cart_v2_${inferred.bucketKey}`);
        tabState = {
          bucketKey: inferred.bucketKey,
          label: inferred.label,
          cartItems: storedCart?.[`heybroc_cart_v2_${inferred.bucketKey}`] || [],
        };
      }
    }
  } catch {
    /* ignore */
  }

  if (!tabState && localData.heybroc_active_bucket_meta?.bucketKey) {
    const meta = localData.heybroc_active_bucket_meta;
    const storedCart = await chrome.storage.local.get(`heybroc_cart_v2_${meta.bucketKey}`);
    tabState = {
      bucketKey: meta.bucketKey,
      label: meta.label || "Grocery",
      cartItems: storedCart?.[`heybroc_cart_v2_${meta.bucketKey}`] || [],
    };
  }

  if (tabState) {
    currentBucketKey = tabState.bucketKey;
    renderPopupCart(tabState.label, tabState.cartItems);
  } else {
    renderPopupCart("No Store Open", []);
  }
}

function validateApiBase(raw) {
  const candidate = (raw || "").trim().replace(/\/+$/, "") || DEFAULT_API;
  try {
    const u = new URL(candidate);
    const isLocalHttp =
      u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
    if (u.protocol !== "https:" && !isLocalHttp) {
      return { ok: false, error: "API URL must use https:// (or http://localhost for local dev)." };
    }
    return { ok: true, url: `${u.origin}${u.pathname.replace(/\/+$/, "")}` };
  } catch {
    return { ok: false, error: "Enter a valid URL (e.g. https://www.heybroc.com)." };
  }
}

document.getElementById("save")?.addEventListener("click", async () => {
  const checked = validateApiBase(input.value);
  if (!checked.ok) {
    status.style.color = "#dc2626";
    status.textContent = checked.error;
    return;
  }
  const apiBase = checked.url;
  input.value = apiBase;
  await chrome.storage.sync.set({ apiBase });
  status.style.color = "";
  status.textContent = "Testing…";
  try {
    const res = await fetch(`${apiBase}/api/scan`);
    const data = await res.json();
    status.textContent = `✓ Connected — rubric v${data.rubricVersion}`;
    void initPopup();
  } catch {
    status.style.color = "#dc2626";
    status.textContent = "Saved, but the API didn't respond.";
  }
});

document.getElementById("manage-sub")?.addEventListener("click", async () => {
  const isIosSafari =
    typeof navigator !== "undefined" &&
    (/iPhone|iPad|iPod/i.test(navigator.userAgent || "") ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
  if (isIosSafari) {
    chrome.tabs.create({ url: "https://apps.apple.com/account/subscriptions" });
    status.textContent = "✓ Opened Apple Subscriptions";
    return;
  }
  const checked = validateApiBase(input.value);
  const apiBase = checked.ok ? checked.url : DEFAULT_API;
  const { heybroc_device_id: deviceId, heybroc_device_secret: deviceSecret } =
    await chrome.storage.local.get(["heybroc_device_id", "heybroc_device_secret"]);
  const loginFallback = deviceId
    ? `${apiBase}/?login=1&deviceId=${encodeURIComponent(deviceId)}`
    : `${apiBase}/?login=1`;
  status.style.color = "";
  status.textContent = "Opening billing portal…";
  try {
    const res = await fetch(`${apiBase}/api/billing/portal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(deviceSecret ? { "X-Device-Secret": deviceSecret } : {}),
      },
      body: JSON.stringify({
        deviceId: deviceId || undefined,
        deviceSecret: deviceSecret || undefined,
      }),
    });
    const data = await res.json();
    if (data?.ok && data?.url) {
      chrome.tabs.create({ url: data.url });
      status.textContent = "✓ Opened billing portal";
      return;
    }
    chrome.tabs.create({ url: loginFallback });
    status.textContent = "Log in on web to manage your subscription.";
  } catch {
    chrome.tabs.create({ url: loginFallback });
  }
});

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && currentBucketKey && changes[`heybroc_cart_v2_${currentBucketKey}`]) {
      renderPopupCart(currentStoreLabel, changes[`heybroc_cart_v2_${currentBucketKey}`].newValue || []);
    }
  });
}

void initPopup();
