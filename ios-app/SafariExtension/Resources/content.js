// CleanCart content script — Dual-Mode Floating Bubble:
// Mode A (Product View): single item badge (e.g. "35/100 • Tap to Inspect").
// Mode B (Idle / Search Scroll View): "🛒 Cart Avg: {avgScore}/100" color-coded (Red <50, Yellow 50-74, Green 75+).
// Includes animated Cart Avg climb on Swap Item tap, Whole-Cart Auditor drawer, and "✕ Hide for this trip" drop target.
(() => {
  if (window.__cleancartLoaded) return;
  window.__cleancartLoaded = true;

  const HOST = location.hostname;
  const STORE = HOST.includes("walmart") ? "walmart"
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

  const HIDE_SESSION_KEY = `cleancart_hide_trip_${STORE}`;
  const CART_STORAGE_KEY = `cleancart_trip_cart_${STORE}`;
  const DEBOUNCE_MS = 220;

  let lastKey = "";
  let timer = null;
  let state = {
    mode: "product", // "product" | "cart_avg"
    data: null,
    expanded: false,
    auditorOpen: false,
    openFlag: null,
    y: 50,
    cartItems: [], // [{ key, title, score, swapTitle, swapScore, swapUrl }]
    displayedAvg: 100,
    dragging: false,
    overHide: false,
    pendingSwap: null, // { fromKey, toTitle }
  };

  /* ---------------- Trip cart persistence ---------------- */
  async function loadTripCart() {
    try {
      const stored = await chrome.storage.local.get(CART_STORAGE_KEY);
      const list = stored?.[CART_STORAGE_KEY];
      if (Array.isArray(list)) {
        state.cartItems = list.filter((i) => i && !String(i.key || "").startsWith("seed-"));
      } else {
        state.cartItems = [];
      }
      state.displayedAvg = calcCartAvg();
    } catch {
      state.cartItems = [];
      state.displayedAvg = 100;
    }
  }

  function saveTripCart() {
    try {
      chrome.storage.local.set({ [CART_STORAGE_KEY]: state.cartItems });
    } catch {
      /* ignore */
    }
  }

  function calcCartAvg() {
    if (!state.cartItems.length) return 100;
    const sum = state.cartItems.reduce((a, i) => a + (Number(i.score) || 0), 0);
    return Math.round(sum / state.cartItems.length);
  }

  function toneForScore(score) {
    return score >= 75 ? "green" : score >= 50 ? "yellow" : "red";
  }

  function animateCartAvgTo(target) {
    const start = state.displayedAvg || target;
    const diff = target - start;
    if (diff === 0) {
      state.displayedAvg = target;
      render();
      return;
    }
    const t0 = performance.now();
    const duration = 700;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      state.displayedAvg = Math.round(start + diff * eased);
      render();
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------------- DOM reading ---------------- */
  const NON_TITLE_RE = /^(search|your cart|shopping cart|cart|checkout|items to add next|product information|similar items|customers also.*|walmart|target|costco(?:\s+wholesale)?|sam'?s\s+club|aldi|kroger|instacart|whole\s+foods(?:\s+market)?|amazon(?:\s+fresh)?|bj'?s(?:\s+wholesale\s+club)?|doordash|dashmart|uber\s*eats|shipt|boost\s+by\s+kroger|continue\s+as\s+guest|log\s*in|sign\s*in|sign\s*up|same-day\s+delivery|choose\s+a\s+store|departments|grocery|savings|deals|weekly\s+ad)$/i;
  const NON_INGREDIENT_RE = /\b(items to add next|product information|similar items|customers also|you might also|related items|sold by|fulfilled by|see packaging|refer to packaging|nutrition facts|serving size)\b/i;
  const REAL_ING_HINT_RE = /\b(water|milk|cream|sugar|salt|flour|wheat|corn|soy|oil|butter|egg|cheese|cocoa|chocolate|vanilla|syrup|starch|acid|lecithin|gum|flavor|natural|organic|vitamin|potassium|sodium|calcium|turkey|chicken|beef|pork|apple|berry|oat|rice|potato|tomato|onion|garlic|spice|vinegar|yeast|honey|almond|peanut|hazelnut|extract|culture|enzyme)\b/i;

  function isValidIngredientText(raw) {
    const t = String(raw || "").replace(/\s+/g, " ").trim();
    if (t.length < 12 || t.length >= 3000) return false;
    if (NON_INGREDIENT_RE.test(t) || NON_TITLE_RE.test(t)) return false;
    if (!t.includes(",") && !REAL_ING_HINT_RE.test(t)) return false;
    return true;
  }

  function activeDialogScope() {
    const dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-testid*="modal" i], [data-testid*="quick-view" i]');
    for (const d of dialogs) {
      if (d.offsetParent !== null && (d.textContent || "").trim().length > 20) return d;
    }
    return document;
  }

  function readTitle() {
    const scope = activeDialogScope();
    const selectors = [
      '[data-testid*="item-details" i] h1',
      '[data-testid*="item-details" i] h2',
      '[data-testid="product-page-title"]',
      'h1.ProductDetails-header',
      '[data-testid*="product-title" i]',
      '[data-testid*="product-name" i]',
      '[data-anchor-id*="ItemModal" i] h1',
      '[data-anchor-id*="ItemModal" i] h2',
      '[data-testid*="itemHeader" i]',
      '[data-testid*="retail-item" i] h1',
      '[role="dialog"] h1',
      '[aria-modal="true"] h1',
      '[role="dialog"] [data-testid*="title" i]',
      'h1[itemprop="name"]',
      'h1[data-testid*="title" i]',
      '[data-automation-id*="product-title" i]',
      "#productTitle",
      "h1#title",
      "#title_feature_div h1",
      "#title",
      "main h1",
      "h1",
      'h2[data-testid*="title" i]',
    ];
    for (const sel of selectors) {
      const el = scope.querySelector(sel) || document.querySelector(sel);
      const t = (el?.textContent || "").replace(/\s+/g, " ").trim();
      if (t && !NON_TITLE_RE.test(t)) return t;
    }
    return "";
  }

  function readIngredients() {
    const scope = activeDialogScope();
    const candidates = scope.querySelectorAll("h2, h3, h4, dt, strong, b, span, div, p, button");
    for (const el of candidates) {
      const own = (el.childNodes.length <= 2 ? el.textContent : "").trim();
      if (!/^ingredients\s*:?$/i.test(own)) continue;
      let sib = el.nextElementSibling;
      for (let i = 0; i < 3 && sib; i++, sib = sib.nextElementSibling) {
        const t = sib.textContent.replace(/\s+/g, " ").trim();
        if (isValidIngredientText(t)) return t;
      }
      const parentText = el.parentElement?.textContent.replace(/\s+/g, " ").trim() || "";
      const stripped = parentText.replace(/^ingredients\s*:?\s*/i, "");
      if (isValidIngredientText(stripped)) return stripped;
    }
    const inline = [...scope.querySelectorAll("p, div, span")].find((n) =>
      n.children.length === 0 && /^ingredients\s*:/i.test(n.textContent.trim()));
    const inlineText = inline ? inline.textContent.replace(/^ingredients\s*:\s*/i, "").trim() : "";
    return isValidIngredientText(inlineText) ? inlineText : "";
  }

  function isAmazonGroceryPage() {
    if (HOST.includes("wholefoods")) return true;
    const crumbText = (
      document.querySelector(
        "#wayfinding-breadcrumbs_feature_div, #nav-subnav, #brandByline_feature_div, #bylineInfo, #almDetailPagePoi, #fresh-merchant-info, #alm-cards-link, a[href*='almBrandId']"
      )?.textContent || ""
    );
    if (/\b(grocery|gourmet food|amazon fresh|whole foods|365 by whole foods|happy belly|amazon grocery|pantry|food\s*&\s*beverage|snacks|beverages)\b/i.test(crumbText)) {
      return true;
    }
    const searchAlias = document.querySelector("#searchDropdownBox option[selected], #nav-search-label-id")?.textContent || "";
    if (/\b(grocery|amazon fresh|whole foods|prime pantry)\b/i.test(searchAlias)) {
      return true;
    }
    if (REAL_ING_HINT_RE.test(readTitle())) {
      return true;
    }
    return Boolean(readIngredients());
  }

  function isProductPage() {
    const p = location.pathname;
    const s = location.search;
    const hasModalTitle = !!document.querySelector('[data-testid*="item-details" i] h1, [data-anchor-id*="ItemModal" i] h1, [data-anchor-id*="ItemModal" i] h2, [role="dialog"] h1, [aria-modal="true"] h1');
    if (STORE === "walmart") return /\/ip\//.test(p);
    if (STORE === "instacart") return /\/products?\//.test(p) || /item_id=|product_id=/i.test(s) || hasModalTitle;
    if (STORE === "target") return /\/p\//.test(p);
    if (STORE === "kroger") return /\/p\//.test(p) || hasModalTitle;
    if (STORE === "aldi") return /\/products?\//.test(p) || /\/detail\/ps\/p\//.test(p);
    if (STORE === "doordash") return /\/(products?|item)\//.test(p) || /item-details|product_id|item_id/i.test(s) || hasModalTitle;
    if (STORE === "ubereats") return /\/product\//.test(p) || /mod=quickView|item/i.test(s) || hasModalTitle;
    if (STORE === "amazon") {
      if (HOST.includes("wholefoods")) return /\/products?\//.test(p);
      return /\/(dp|gp\/product|gp\/aw\/d)\//.test(p) && isAmazonGroceryPage();
    }
    if (STORE === "sams") return /\/(p|product|ip|sams\/shop\/product)\//.test(p);
    if (STORE === "bjs") return /\/product\//.test(p);
    if (STORE === "costco") return /\/p\/|\.product\./i.test(p);
    if (STORE === "shipt") return /\/(shop\/)?products?\//.test(p) || /product_id=|item_id=/i.test(s) || hasModalTitle;
    return !!readTitle();
  }

  /* ---------------- Shadow DOM host ---------------- */
  const host = document.createElement("div");
  host.id = "cleancart-overlay-host";
  const shadow = host.attachShadow({ mode: "open" });
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("overlay.css");
  const mascotUrl = chrome.runtime.getURL("broc-mascot.png");
  const root = document.createElement("div");
  root.className = "cc-root";
  shadow.append(link, root);

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function render() {
    if (sessionStorage.getItem(HIDE_SESSION_KEY) === "1") {
      root.innerHTML = "";
      return;
    }

    const avg = state.displayedAvg || calcCartAvg();
    const avgTone = `cc-tone-${toneForScore(avg)}`;
    const hideDropHtml = state.dragging
      ? `<div class="cc-hide-drop ${state.overHide ? "is-hot" : ""}">✕ Remove</div>`
      : "";

    // Whole-Cart Auditor Drawer (opened by tapping the bubble in Cart Avg mode)
    if (state.auditorOpen) {
      const rows = state.cartItems.length
        ? state.cartItems
            .map(
              (item, idx) => `<li class="cc-audit-row">
                <div><b>${esc(item.title)}</b>${item.swapTitle && item.score < 75 ? `<small>Clean Swap: ${esc(item.swapTitle)}${item.swapScore ? ` (${esc(item.swapScore)}/100)` : ""}${item.swapIsPaidLink ? " · paid link" : ""}</small>` : ""}</div>
                <span class="cc-chip cc-tone-${toneForScore(item.score)}">${esc(item.score)}</span>
                ${item.score < 75 && item.swapTitle ? `<button class="cc-mini-swap" data-swap-idx="${idx}">Swap${item.swapIsPaidLink ? " · paid" : ""}</button>` : ""}
              </li>`,
            )
            .join("")
        : `<li class="cc-audit-row"><div><b>Your cart is empty</b><small>Add items to your store cart to audit your real Cart Avg.</small></div></li>`;
      const firstDirty = state.cartItems.find((i) => i.score < 75 && i.swapUrl);

      root.innerHTML = `<div class="cc-backdrop" data-act="collapse">
        <div class="cc-card ${avgTone}" role="dialog" aria-label="Whole-Cart Auditor">
          <div class="cc-head">
            <div class="cc-head-left"><img class="cc-head-mascot" src="${mascotUrl}" alt="Broc" /><div><span class="cc-eyebrow">HeyBroc · Whole-Cart Health Check</span><h3>${state.cartItems.length ? `Cart Average: ${avg}/100` : "Cart Check: Empty"}</h3></div></div>
            <button class="cc-close" data-act="collapse">×</button>
          </div>
          <ul class="cc-audit-list">${rows}</ul>
          ${firstDirty ? `<button class="cc-swap-btn cc-wide" data-act="swap-all">Find Clean Swap: ${esc(firstDirty.swapTitle)}${firstDirty.swapScore ? ` (${esc(firstDirty.swapScore)}/100)` : ""}${firstDirty.swapIsPaidLink ? " · paid link" : ""}</button>` : state.cartItems.length ? `<p class="cc-clean" style="margin-top:12px">✓ Every item in your cart scores 75+!</p>` : ""}
        </div>
      </div>`;
      return;
    }

    // Mode B: Idle / Search Scroll View -> Cart Avg Floating Bubble
    if (state.mode === "cart_avg") {
      const pillLabel = state.cartItems.length ? `${avg}/100` : "Empty";
      root.innerHTML = `<div class="cc-pill ${avgTone}" style="top:${state.y}%" role="button" tabindex="0" data-act="open-auditor">
          <img class="cc-pill-mascot" src="${mascotUrl}" alt="" /><span class="cc-dot"></span><span>🛒 Cart Avg:</span><b>${pillLabel}</b>
        </div>${hideDropHtml}`;
      bindPillDrag(root.querySelector(".cc-pill"), "auditor");
      return;
    }

    // Mode A: Product View
    const d = state.data;
    if (!d) { root.innerHTML = ""; return; }
    if (!d.ok) {
      root.innerHTML = `<div class="cc-pill cc-tone-gray" style="top:${state.y}%"><img class="cc-pill-mascot" src="${mascotUrl}" alt="" /><span class="cc-dot"></span><span>${esc(d.error)}</span></div>`;
      return;
    }
    const r = d.result;
    const safeScore = Math.max(0, Math.min(100, Number(r.score) || 0));
    const tone = `cc-tone-${esc(r.color)}`;
    if (!state.expanded) {
      root.innerHTML = `<div class="cc-pill ${tone}" style="top:${state.y}%" role="button" tabindex="0" data-act="expand">
          <img class="cc-pill-mascot" src="${mascotUrl}" alt="" /><span class="cc-dot"></span><b>${esc(safeScore)}/100</b><span class="cc-sep">•</span><span>Tap to Inspect</span>
        </div>${hideDropHtml}`;
      bindPillDrag(root.querySelector(".cc-pill"), "product");
      return;
    }
    const C = 2 * Math.PI * 44;
    const flags = r.flagged.length
      ? r.flagged.map((f) => `<span class="cc-flag cc-risk-${esc(f.risk)} is-open" data-flag="${esc(f.name)}">${esc(f.name)} ⚠️</span>`).join("")
      : `<p class="cc-clean">✓ No watchlist additives found.</p>`;
    const explain = r.flagged
      .map(
        (f) =>
          `<div class="cc-explain cc-risk-${esc(f.risk)}" style="margin-bottom:6px"><b>${esc(f.name)}</b> <span>−${esc(f.penalty)} pts</span><p>${esc(f.explanation)}</p></div>`,
      )
      .join("");
    const swapPaidSuffix = d.swap?.isPaidLink ? " · paid link" : "";
    const swapRatingLabel = d.swap ? (Number(d.swap.score) >= 75 ? "Excellent" : Number(d.swap.score) >= 50 ? "Good" : "Mediocre") : "";
    const swapLocked = Boolean(d.swap && !d.swap.webUrl);
    const swap = d.swap
      ? `<div class="cc-swap"><div><span class="cc-eyebrow cc-green">${swapLocked ? "🔒 Clean Swap Locked" : `Clean Swap · ${state.cartItems.length ? `Cart Avg ${avg}/100` : "Ingredient Pick"}`}${swapLocked ? "" : swapPaidSuffix}</span><b>${esc(d.swap.title)}</b><span class="cc-swap-score">${esc(d.swap.score)}/100 ${swapRatingLabel}${swapLocked ? " · All free weekly swaps used" : ""}</span></div>
           <button class="cc-swap-btn" data-act="swap">${swapLocked ? "⚡ Unlock Pro ↗" : `Swap Item${swapPaidSuffix}`}</button></div>`
      : `<div class="cc-swap cc-swap-ok">Great pick — no swap needed.</div>`;
    const srcKey = d.lookup?.origin || d.lookup?.source || d.product?.origin || d.product?.source || "catalog";
    const srcName = srcKey === "screen" ? "Store page ingredients"
      : srcKey === "openfoodfacts" ? "Open Food Facts (crowdsourced)"
      : srcKey === "usda" ? "USDA FoodData Central"
      : "Representative formulation — verify physical label";
    const updatedVal = d.lookup?.sourceUpdatedAt || d.product?.sourceUpdatedAt;
    const updatedPart = updatedVal ? ` · updated ${esc(updatedVal)}` : "";
    const reportHref = `mailto:support@heybroc.com?subject=${encodeURIComponent(`Label mismatch: ${d.product?.title || ""}`)}`;

    root.innerHTML = `<div class="cc-backdrop" data-act="collapse">
      <div class="cc-card ${tone}" role="dialog" aria-label="Health Insights">
        <div class="cc-head"><div class="cc-head-left"><img class="cc-head-mascot" src="${mascotUrl}" alt="Broc" /><div><span class="cc-eyebrow">HeyBroc</span><h3>Health Insights</h3></div></div><button class="cc-close" data-act="collapse">×</button></div>
        <p class="cc-product">${esc(d.product.title)}</p>
        <p style="margin:-4px 0 8px;font-size:10px;color:#64748b">${esc(srcName)}${updatedPart} · <a href="${reportHref}" target="_blank" rel="noopener" style="color:#0f7a4a;text-decoration:underline">Report a mistake</a></p>
        <div class="cc-body">
          <div class="cc-gauge"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" class="cc-track"/><circle cx="50" cy="50" r="44" class="cc-fill" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - safeScore / 100)}" transform="rotate(-90 50 50)"/></svg>
            <div class="cc-gauge-label"><strong>${esc(safeScore)}<span>/100</span></strong><em>${esc(r.rating)}</em></div></div>
          <div class="cc-flags">${flags}</div>
        </div>
        ${explain}
        ${swap}
        <p style="margin:8px 0 0;font-size:10px;line-height:1.4;color:#64748b">Informational opinion only — most flagged ingredients are FDA-permitted or GRAS; verify physical label. HeyBroc is not affiliated with any store or brand.</p>
      </div></div>`;
  }

  function isCurrentProductInCart() {
    const badges = document.querySelectorAll('button, [role="button"], [aria-label*="in cart" i], [aria-label*="in bag" i], [data-testid*="quantity" i]');
    for (const el of badges) {
      const txt = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.trim();
      if (/\b(\d+\s+in\s+(cart|bag|basket|order)|added\s+to\s+(cart|bag|basket))\b/i.test(txt)) {
        return true;
      }
    }
    return false;
  }

  function matchesPendingSwapTitle(title) {
    if (!state.pendingSwap?.toTitle || !title) return false;
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const a = norm(title);
    const b = norm(state.pendingSwap.toTitle);
    if (a === b || a.includes(b) || b.includes(a)) return true;
    const words = b.split(" ").filter((w) => w.length >= 3);
    return words.length >= 2 && words.slice(0, 2).every((w) => a.includes(w));
  }

  function recordProductInCart(resp, fallbackTitle) {
    if (!resp?.ok || !resp.result) return;
    const prevAvg = calcCartAvg();
    const itemKey = resp.product?.title || fallbackTitle;
    if (!itemKey) return;

    let swappedInCart = false;
    if (matchesPendingSwapTitle(itemKey)) {
      const fromKey = state.pendingSwap?.fromKey;
      if (fromKey) {
        state.cartItems = state.cartItems.filter((i) => i.key !== fromKey);
      }
      state.pendingSwap = null;
      swappedInCart = true;
    }

    const existing = state.cartItems.find((i) => i.key === itemKey);
    if (existing) {
      existing.score = resp.result.score;
      existing.swapTitle = resp.swap?.title || null;
      existing.swapScore = resp.swap?.score || null;
      existing.swapUrl = resp.swap?.webUrl || null;
      existing.swapIsPaidLink = Boolean(resp.swap?.isPaidLink);
    } else {
      state.cartItems.unshift({
        key: itemKey,
        title: itemKey,
        score: resp.result.score,
        swapTitle: resp.swap?.title || null,
        swapScore: resp.swap?.score || null,
        swapUrl: resp.swap?.webUrl || null,
        swapIsPaidLink: Boolean(resp.swap?.isPaidLink),
      });
      state.cartItems = state.cartItems.slice(0, 20);
    }
    saveTripCart();
    const nextAvg = calcCartAvg();
    if (swappedInCart && nextAvg > prevAvg) {
      animateCartAvgTo(nextAvg);
    } else {
      state.displayedAvg = nextAvg;
      render();
    }
  }

  // Detect explicit user clicks on store "Add to Cart" buttons on the active product page
  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target?.closest?.('button, [role="button"], input[type="submit"], input[type="button"]');
      if (!btn || !isProductPage() || !state.data?.ok) return;
      const label = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""} ${btn.value || ""}`.trim();
      if (/\b(add\s+to\s+(cart|bag|basket|order))\b/i.test(label)) {
        recordProductInCart(state.data, readTitle());
      }
    },
    true
  );

  root.addEventListener("click", (e) => {
    const swapIdxBtn = e.target.closest("[data-swap-idx]");
    if (swapIdxBtn) {
      const idx = Number(swapIdxBtn.dataset.swapIdx);
      const item = state.cartItems[idx];
      if (item) {
        if (!item.swapUrl) {
          window.open("https://www.heybroc.com/?upgrade=1", "_blank", "noopener");
          return;
        }
        state.pendingSwap = { fromKey: item.key, toTitle: item.swapTitle };
        try {
          chrome.runtime.sendMessage({ type: "CLEANCART_RECORD_SWAP", productKey: item.key });
        } catch {
          /* ignore */
        }
        window.open(item.swapUrl, "_blank", "noopener");
      }
      return;
    }

    const t = e.target.closest("[data-act],[data-flag]");
    if (!t) return;
    if (t.dataset.flag) { state.openFlag = state.openFlag === t.dataset.flag ? null : t.dataset.flag; render(); return; }
    const act = t.dataset.act;
    if (act === "collapse" && (t === e.target || t.classList.contains("cc-close"))) {
      state.expanded = false;
      state.auditorOpen = false;
      render();
    }
    if (act === "swap" && state.data?.swap) {
      if (!state.data.swap.webUrl) {
        window.open("https://www.heybroc.com/?upgrade=1", "_blank", "noopener");
        return;
      }
      // Affiliate link is ONLY opened on this explicit user tap.
      // Do NOT mutate cartItems until the next screen scan or Add-to-Cart detects the swap item in cart.
      const currentKey = state.data.product?.title || readTitle();
      state.pendingSwap = { fromKey: currentKey, toTitle: state.data.swap.title };
      try {
        chrome.runtime.sendMessage({ type: "CLEANCART_RECORD_SWAP", productKey: currentKey });
      } catch {
        /* ignore */
      }
      window.open(state.data.swap.webUrl, "_blank", "noopener");
      state.expanded = false;
      render();
    }
    if (act === "swap-all") {
      const firstDirty = state.cartItems.find((i) => i.score < 75 && i.swapUrl);
      if (firstDirty) {
        state.pendingSwap = { fromKey: firstDirty.key, toTitle: firstDirty.swapTitle };
        try {
          chrome.runtime.sendMessage({ type: "CLEANCART_RECORD_SWAP", productKey: firstDirty.key });
        } catch {
          /* ignore */
        }
        window.open(firstDirty.swapUrl, "_blank", "noopener");
      }
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
      render();
    } else if (act === "expand") {
      state.expanded = true;
      render();
    }
  });

  function bindPillDrag(pill, targetMode) {
    if (!pill) return;
    let startY = 0, startX = 0, startPct = 0, moved = false;
    pill.addEventListener("pointerdown", (e) => {
      pill.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startX = e.clientX;
      startPct = state.y;
      moved = false;
      state.dragging = true;
      state.overHide = false;
    });
    pill.addEventListener("pointermove", (e) => {
      if (!pill.hasPointerCapture(e.pointerId)) return;
      const dy = e.clientY - startY;
      const dx = e.clientX - startX;
      if (Math.hypot(dx, dy) > 5) moved = true;
      state.y = Math.max(8, Math.min(92, startPct + (dy / window.innerHeight) * 100));
      pill.style.top = `${state.y}%`;
      pill.style.transform = `translate(${Math.min(0, dx)}px, -50%)`;
      state.overHide = e.clientY > window.innerHeight * 0.82 && e.clientX > window.innerWidth * 0.25 && e.clientX < window.innerWidth * 0.75;
    });
    pill.addEventListener("pointerup", () => {
      const dropHide = state.overHide;
      state.dragging = false;
      state.overHide = false;
      if (dropHide) {
        sessionStorage.setItem(HIDE_SESSION_KEY, "1");
        render();
        return;
      }
      if (!moved) {
        if (targetMode === "auditor") state.auditorOpen = true;
        else state.expanded = true;
      }
      render();
    });
  }

  /* ---------------- Scan loop & instant pre-warm ---------------- */
  let scanSeq = 0;
  const scanCache = new Map();

  function normCacheKey(title, rawIng) {
    return `${STORE}|${String(title || "").toLowerCase().replace(/\s+/g, " ").trim()}|${String(rawIng || "").trim()}`;
  }

  function applyScanResult(resp, productTitle) {
    if (!resp?.ok) {
      state = {
        ...state,
        mode: "cart_avg",
        expanded: false,
        openFlag: null,
      };
      render();
      return;
    }
    state = {
      ...state,
      mode: "product",
      data: resp,
      expanded: false,
      openFlag: null,
    };
    if (resp.result && isCurrentProductInCart()) {
      recordProductInCart(resp, productTitle);
    }
    render();
  }

  function scan() {
    if (sessionStorage.getItem(HIDE_SESSION_KEY) === "1") return;
    if (!host.isConnected) document.documentElement.appendChild(host);

    if (!isProductPage()) {
      scanSeq++;
      lastKey = "";
      state.mode = "cart_avg";
      state.expanded = false;
      render();
      return;
    }

    const productTitle = readTitle();
    if (!productTitle) {
      scanSeq++;
      lastKey = "";
      state.mode = "cart_avg";
      render();
      return;
    }
    const rawIngredients = readIngredients();
    const inCart = isCurrentProductInCart();
    const key = `${location.pathname}|${productTitle}|${rawIngredients}|${inCart ? 1 : 0}`;
    if (key === lastKey) return;
    lastKey = key;

    const cKey = normCacheKey(productTitle, rawIngredients);
    const cached = scanCache.get(cKey) || (!rawIngredients ? scanCache.get(normCacheKey(productTitle, "")) : null);
    if (cached?.ok) {
      applyScanResult(cached, productTitle);
      return;
    }

    const reqSeq = ++scanSeq;
    chrome.runtime.sendMessage(
      { type: "CLEANCART_SCAN", payload: { productTitle, rawIngredients: rawIngredients || undefined, store: STORE } },
      (resp) => {
        if (resp?.ok) {
          scanCache.set(cKey, resp);
        }
        if (reqSeq !== scanSeq || !isProductPage()) return;
        applyScanResult(resp, productTitle);
      },
    );
  }

  // Pre-warm score the exact millisecond a shopper presses down on any product card link
  document.addEventListener(
    "pointerdown",
    (e) => {
      const link = e.target?.closest?.('a[href*="/ip/"], a[href*="/products/"], a[href*="/p/"], a[href*="/dp/"], a[href*="/gp/product/"], [data-testid*="product" i] a');
      if (!link) return;
      const rawText = (link.getAttribute("aria-label") || link.textContent || "").replace(/\s+/g, " ").trim();
      if (rawText.length < 4 || rawText.length > 180 || NON_TITLE_RE.test(rawText)) return;
      const cKey = normCacheKey(rawText, "");
      if (scanCache.has(cKey)) return;
      chrome.runtime.sendMessage(
        { type: "CLEANCART_SCAN", payload: { productTitle: rawText, store: STORE } },
        (resp) => {
          if (resp?.ok) scanCache.set(cKey, resp);
        },
      );
    },
    { passive: true, capture: true },
  );

  loadTripCart().then(() => {
    const MAX_DEBOUNCE_WAIT_MS = 600;
    let firstQueuedAt = 0;
    const runScheduledScan = () => {
      firstQueuedAt = 0;
      timer = null;
      scan();
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
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", schedule);
    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes) => {
        if (changes.watchlist || changes.familyWatchlist || changes.dietaryWatchlist) {
          scanCache.clear();
          lastKey = "";
          schedule();
        }
      });
    }
    schedule();
  });
})();
