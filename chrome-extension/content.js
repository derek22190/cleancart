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
    : HOST.includes("amazon") ? "amazon"
    : HOST.includes("samsclub") ? "sams"
    : HOST.includes("bjs") ? "bjs"
    : HOST.includes("costco") ? "costco"
    : HOST.includes("shipt") ? "shipt" : "walmart";

  const HIDE_SESSION_KEY = `cleancart_hide_trip_${STORE}`;
  const CART_STORAGE_KEY = `cleancart_trip_cart_${STORE}`;
  const DEBOUNCE_MS = 1200;

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
    displayedAvg: 0,
    dragging: false,
    overHide: false,
  };

  /* ---------------- Trip cart persistence ---------------- */
  async function loadTripCart() {
    try {
      const stored = await chrome.storage.local.get(CART_STORAGE_KEY);
      const list = stored?.[CART_STORAGE_KEY];
      if (Array.isArray(list) && list.length) {
        state.cartItems = list;
      } else {
        state.cartItems = [
          { key: "seed-1", title: "Strawberry Lowfat Yogurt", score: 35, swapTitle: "Stonyfield Organic Plain Yogurt", swapScore: 100, swapUrl: `https://${HOST}/search?q=Stonyfield+Organic+Yogurt&irgwc=1&clickid=YOUR_IMPACT_ID` },
          { key: "seed-2", title: "Baked Cheddar Crackers", score: 40, swapTitle: "Mary's Gone Crackers", swapScore: 100, swapUrl: `https://${HOST}/search?q=Marys+Gone+Crackers&irgwc=1&clickid=YOUR_IMPACT_ID` },
          { key: "seed-3", title: "Grass-Fed Salted Butter", score: 100, swapTitle: null, swapScore: 100, swapUrl: null },
        ];
      }
      state.displayedAvg = calcCartAvg();
    } catch {
      state.displayedAvg = 58;
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
  function readTitle() {
    const h1 = document.querySelector('h1[itemprop="name"], h1[data-testid*="title" i], main h1, h1');
    return (h1?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function readIngredients() {
    const candidates = document.querySelectorAll("h2, h3, h4, dt, strong, b, span, div, p, button");
    for (const el of candidates) {
      const own = (el.childNodes.length <= 2 ? el.textContent : "").trim();
      if (!/^ingredients\s*:?$/i.test(own)) continue;
      let sib = el.nextElementSibling;
      for (let i = 0; i < 3 && sib; i++, sib = sib.nextElementSibling) {
        const t = sib.textContent.replace(/\s+/g, " ").trim();
        if (t.length > 12) return t;
      }
      const parentText = el.parentElement?.textContent.replace(/\s+/g, " ").trim() || "";
      const stripped = parentText.replace(/^ingredients\s*:?\s*/i, "");
      if (stripped.length > 12 && stripped.length < 3000) return stripped;
    }
    const inline = [...document.querySelectorAll("p, div, span")].find((n) =>
      n.children.length === 0 && /^ingredients\s*:/i.test(n.textContent.trim()));
    return inline ? inline.textContent.replace(/^ingredients\s*:\s*/i, "").trim() : "";
  }

  function isProductPage() {
    const p = location.pathname;
    if (STORE === "walmart") return /\/ip\//.test(p);
    if (STORE === "instacart") return /\/products?\//.test(p) || !!document.querySelector('[data-testid*="item-details" i]');
    if (STORE === "target") return /\/p\//.test(p);
    if (STORE === "kroger") return /\/p\//.test(p);
    if (STORE === "aldi") return /\/products?\//.test(p);
    if (STORE === "doordash") return /\/products?\//.test(p) || /item-details/i.test(location.search);
    if (STORE === "ubereats") return /\/product\//.test(p) || /mod=quickView/i.test(location.search);
    if (STORE === "amazon") return /\/(dp|gp\/product)\//.test(p);
    if (STORE === "sams") return /\/(p|product|ip)\//.test(p);
    if (STORE === "bjs") return /\/product\//.test(p);
    if (STORE === "costco") return /\/p\/|\.product\./i.test(p);
    if (STORE === "shipt") return /\/products?\//.test(p);
    return !!readTitle();
  }

  /* ---------------- Shadow DOM host ---------------- */
  const host = document.createElement("div");
  host.id = "cleancart-overlay-host";
  const shadow = host.attachShadow({ mode: "open" });
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("overlay.css");
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
      ? `<div class="cc-hide-drop ${state.overHide ? "is-hot" : ""}">✕ Hide for this trip</div>`
      : "";

    // Whole-Cart Auditor Drawer (opened by tapping the bubble in Cart Avg mode)
    if (state.auditorOpen) {
      const rows = state.cartItems
        .map(
          (item, idx) => `<li class="cc-audit-row">
            <div><b>${esc(item.title)}</b>${item.swapTitle && item.score < 75 ? `<small>Clean Swap: ${esc(item.swapTitle)} (100/100)</small>` : ""}</div>
            <span class="cc-chip cc-tone-${toneForScore(item.score)}">${item.score}</span>
            ${item.score < 75 && item.swapTitle ? `<button class="cc-mini-swap" data-swap-idx="${idx}">Swap</button>` : ""}
          </li>`,
        )
        .join("");
      const dirtyCount = state.cartItems.filter((i) => i.score < 75).length;

      root.innerHTML = `<div class="cc-backdrop" data-act="collapse">
        <div class="cc-card ${avgTone}" role="dialog" aria-label="Whole-Cart Auditor">
          <div class="cc-head">
            <div><span class="cc-eyebrow">CleanCart · Whole-Cart MCP Auditor</span><h3>Cart Average: ${avg}/100</h3></div>
            <button class="cc-close" data-act="collapse">×</button>
          </div>
          <ul class="cc-audit-list">${rows}</ul>
          ${dirtyCount > 0 ? `<button class="cc-swap-btn cc-wide" data-act="swap-all">Swap All ${dirtyCount} Dirty Items → 100/100</button>` : `<p class="cc-clean" style="margin-top:12px">✓ Every item in your cart scores 75+!</p>`}
        </div>
      </div>`;
      return;
    }

    // Mode B: Idle / Search Scroll View -> Cart Avg Floating Bubble
    if (state.mode === "cart_avg") {
      root.innerHTML = `<div class="cc-pill ${avgTone}" style="top:${state.y}%" role="button" tabindex="0" data-act="open-auditor">
          <span class="cc-dot"></span><span>🛒 Cart Avg:</span><b>${avg}/100</b>
        </div>${hideDropHtml}`;
      bindPillDrag(root.querySelector(".cc-pill"), "auditor");
      return;
    }

    // Mode A: Product View
    const d = state.data;
    if (!d) { root.innerHTML = ""; return; }
    if (!d.ok) {
      root.innerHTML = `<div class="cc-pill cc-tone-gray" style="top:${state.y}%"><span class="cc-dot"></span><span>${esc(d.error)}</span></div>`;
      return;
    }
    const r = d.result;
    const tone = `cc-tone-${r.color}`;
    if (!state.expanded) {
      root.innerHTML = `<div class="cc-pill ${tone}" style="top:${state.y}%" role="button" tabindex="0" data-act="expand">
          <span class="cc-dot"></span><b>${r.score}/100</b><span class="cc-sep">•</span><span>Tap to Inspect</span>
        </div>${hideDropHtml}`;
      bindPillDrag(root.querySelector(".cc-pill"), "product");
      return;
    }
    const C = 2 * Math.PI * 44;
    const flags = r.flagged.length
      ? r.flagged.map((f) => `<button class="cc-flag cc-risk-${f.risk} ${state.openFlag === f.id ? "is-open" : ""}" data-flag="${f.id}">${esc(f.name)} ⚠️</button>`).join("")
      : `<p class="cc-clean">✓ No watchlist additives found.</p>`;
    const open = r.flagged.find((f) => f.id === state.openFlag);
    const explain = open ? `<div class="cc-explain cc-risk-${open.risk}"><b>${esc(open.name)}</b> <span>−${open.penalty} pts</span><p>${esc(open.explanation)}</p></div>` : "";
    const swap = d.swap
      ? `<div class="cc-swap"><div><span class="cc-eyebrow cc-green">Clean Swap · Cart Avg ${avg}/100</span><b>${esc(d.swap.title)}</b><span class="cc-swap-score">${d.swap.score}/100 Excellent</span></div>
           <button class="cc-swap-btn" data-act="swap">Swap Item</button></div>`
      : `<div class="cc-swap cc-swap-ok">Great pick — no swap needed.</div>`;

    root.innerHTML = `<div class="cc-backdrop" data-act="collapse">
      <div class="cc-card ${tone}" role="dialog" aria-label="Health Insights">
        <div class="cc-head"><div><span class="cc-eyebrow">CleanCart</span><h3>Health Insights</h3></div><button class="cc-close" data-act="collapse">×</button></div>
        <p class="cc-product">${esc(d.product.title)}</p>
        <div class="cc-body">
          <div class="cc-gauge"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" class="cc-track"/><circle cx="50" cy="50" r="44" class="cc-fill" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - r.score / 100)}" transform="rotate(-90 50 50)"/></svg>
            <div class="cc-gauge-label"><strong>${r.score}<span>/100</span></strong><em>${r.rating}</em></div></div>
          <div class="cc-flags">${flags}</div>
        </div>
        ${explain}
        ${swap}
      </div></div>`;
  }

  root.addEventListener("click", (e) => {
    const swapIdxBtn = e.target.closest("[data-swap-idx]");
    if (swapIdxBtn) {
      const idx = Number(swapIdxBtn.dataset.swapIdx);
      const item = state.cartItems[idx];
      if (item) {
        if (item.swapUrl) window.open(item.swapUrl, "_blank", "noopener");
        item.title = item.swapTitle || item.title;
        item.score = item.swapScore || 100;
        item.swapTitle = null;
        saveTripCart();
        animateCartAvgTo(calcCartAvg());
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
      // Affiliate link is ONLY opened on this explicit user tap.
      window.open(state.data.swap.webUrl, "_blank", "noopener");
      const currentKey = state.data.product?.title || "current";
      const existing = state.cartItems.find((i) => i.key === currentKey);
      if (existing) {
        existing.title = state.data.swap.title;
        existing.score = state.data.swap.score;
        existing.swapTitle = null;
      } else {
        state.cartItems.push({ key: currentKey, title: state.data.swap.title, score: state.data.swap.score, swapTitle: null, swapScore: 100, swapUrl: null });
      }
      saveTripCart();
      state.expanded = false;
      state.mode = "cart_avg";
      animateCartAvgTo(calcCartAvg());
    }
    if (act === "swap-all") {
      state.cartItems.forEach((item) => {
        if (item.score < 75 && item.swapTitle) {
          item.title = item.swapTitle;
          item.score = item.swapScore || 100;
          item.swapTitle = null;
        }
      });
      saveTripCart();
      animateCartAvgTo(calcCartAvg());
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

  /* ---------------- Scan loop ---------------- */
  function scan() {
    if (sessionStorage.getItem(HIDE_SESSION_KEY) === "1") return;
    if (!host.isConnected) document.documentElement.appendChild(host);

    if (!isProductPage()) {
      state.mode = "cart_avg";
      state.expanded = false;
      render();
      return;
    }

    const productTitle = readTitle();
    if (!productTitle) {
      state.mode = "cart_avg";
      render();
      return;
    }
    const rawIngredients = readIngredients();
    const key = `${location.pathname}|${productTitle}|${rawIngredients.length}`;
    if (key === lastKey) return;
    lastKey = key;
    chrome.runtime.sendMessage(
      { type: "CLEANCART_SCAN", payload: { productTitle, rawIngredients: rawIngredients || undefined, store: STORE } },
      (resp) => {
        state = {
          ...state,
          mode: "product",
          data: resp || { ok: false, error: "No response from CleanCart" },
          expanded: false,
          openFlag: null,
        };
        if (resp?.ok && resp.result) {
          const itemKey = resp.product?.title || productTitle;
          if (!state.cartItems.some((i) => i.key === itemKey)) {
            state.cartItems.unshift({
              key: itemKey,
              title: itemKey,
              score: resp.result.score,
              swapTitle: resp.swap?.title || null,
              swapScore: resp.swap?.score || 100,
              swapUrl: resp.swap?.webUrl || null,
            });
            state.cartItems = state.cartItems.slice(0, 12);
            saveTripCart();
            state.displayedAvg = calcCartAvg();
          }
        }
        render();
      },
    );
  }

  loadTripCart().then(() => {
    const schedule = () => { clearTimeout(timer); timer = setTimeout(scan, DEBOUNCE_MS); };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", schedule);
    schedule();
  });
})();
