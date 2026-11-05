// CleanCart content script — reads the product title + visible ingredients from the
// store page (client-side only, no server scraping), asks the CleanCart API for a
// deterministic score, and renders the floating pill + Health Insights card.
(() => {
  if (window.__cleancartLoaded) return;
  window.__cleancartLoaded = true;

  const HOST = location.hostname;
  const STORE = HOST.includes("walmart") ? "walmart"
    : HOST.includes("instacart") ? "instacart"
    : HOST.includes("samsclub") ? "sams"
    : HOST.includes("bjs") ? "bjs" : "walmart";

  const DEBOUNCE_MS = 1200;
  let lastKey = "";
  let timer = null;
  let state = { data: null, expanded: false, openFlag: null, y: 50 };

  /* ---------------- DOM reading ---------------- */
  function readTitle() {
    const h1 = document.querySelector('h1[itemprop="name"], h1[data-testid*="title" i], main h1, h1');
    return (h1?.textContent || "").replace(/\s+/g, " ").trim();
  }

  // Finds a visible "Ingredients" label and returns the text that follows it.
  function readIngredients() {
    const candidates = document.querySelectorAll("h2, h3, h4, dt, strong, b, span, div, p, button");
    for (const el of candidates) {
      const own = (el.childNodes.length <= 2 ? el.textContent : "").trim();
      if (!/^ingredients\s*:?$/i.test(own)) continue;
      // 1) Next sibling block
      let sib = el.nextElementSibling;
      for (let i = 0; i < 3 && sib; i++, sib = sib.nextElementSibling) {
        const t = sib.textContent.replace(/\s+/g, " ").trim();
        if (t.length > 12) return t;
      }
      // 2) Parent's text minus the label
      const parentText = el.parentElement?.textContent.replace(/\s+/g, " ").trim() || "";
      const stripped = parentText.replace(/^ingredients\s*:?\s*/i, "");
      if (stripped.length > 12 && stripped.length < 3000) return stripped;
    }
    // 3) Inline "Ingredients: ..." paragraphs
    const inline = [...document.querySelectorAll("p, div, span")].find((n) =>
      n.children.length === 0 && /^ingredients\s*:/i.test(n.textContent.trim()));
    return inline ? inline.textContent.replace(/^ingredients\s*:\s*/i, "").trim() : "";
  }

  function isProductPage() {
    if (STORE === "walmart") return /\/ip\//.test(location.pathname);
    if (STORE === "instacart") return /\/products?\//.test(location.pathname) || !!document.querySelector('[data-testid*="item-details" i]');
    return !!readTitle();
  }

  /* ---------------- Rendering (Shadow DOM, isolated from store CSS) ---------------- */
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
          <span class="cc-dot"></span><b>${r.score}/100</b><span class="cc-sep">•</span><span>Tap to Inspect</span></div>`;
      bindPillDrag(root.querySelector(".cc-pill"));
      return;
    }
    const C = 2 * Math.PI * 44;
    const flags = r.flagged.length
      ? r.flagged.map((f) => `<button class="cc-flag cc-risk-${f.risk} ${state.openFlag === f.id ? "is-open" : ""}" data-flag="${f.id}">${esc(f.name)} ⚠️</button>`).join("")
      : `<p class="cc-clean">✓ No watchlist additives found.</p>`;
    const open = r.flagged.find((f) => f.id === state.openFlag);
    const explain = open ? `<div class="cc-explain cc-risk-${open.risk}"><b>${esc(open.name)}</b> <span>−${open.penalty} pts</span><p>${esc(open.explanation)}</p></div>` : "";
    const swap = d.swap
      ? `<div class="cc-swap"><div><span class="cc-eyebrow cc-green">Clean Swap</span><b>${esc(d.swap.title)}</b><span class="cc-swap-score">${d.swap.score}/100 Excellent</span></div>
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
    const t = e.target.closest("[data-act],[data-flag]");
    if (!t) return;
    if (t.dataset.flag) { state.openFlag = state.openFlag === t.dataset.flag ? null : t.dataset.flag; render(); return; }
    const act = t.dataset.act;
    if (act === "collapse" && (t === e.target || t.classList.contains("cc-close"))) { state.expanded = false; render(); }
    if (act === "swap" && state.data?.swap) {
      // Affiliate link is ONLY opened on this explicit user tap.
      window.open(state.data.swap.webUrl, "_blank", "noopener");
    }
  });

  function bindPillDrag(pill) {
    let startY = 0, startPct = 0, moved = false;
    pill.addEventListener("pointerdown", (e) => {
      pill.setPointerCapture(e.pointerId); startY = e.clientY; startPct = state.y; moved = false;
    });
    pill.addEventListener("pointermove", (e) => {
      if (!pill.hasPointerCapture(e.pointerId)) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 4) moved = true;
      state.y = Math.max(8, Math.min(92, startPct + (dy / window.innerHeight) * 100));
      pill.style.top = `${state.y}%`;
    });
    pill.addEventListener("pointerup", () => { if (!moved) { state.expanded = true; render(); } });
    pill.addEventListener("keydown", (e) => { if (e.key === "Enter") { state.expanded = true; render(); } });
  }

  /* ---------------- Scan loop ---------------- */
  function scan() {
    if (!isProductPage()) { state.data = null; render(); return; }
    const productTitle = readTitle();
    if (!productTitle) return;
    const rawIngredients = readIngredients();
    const key = `${location.pathname}|${productTitle}|${rawIngredients.length}`;
    if (key === lastKey) return;
    lastKey = key;
    if (!host.isConnected) document.documentElement.appendChild(host);
    chrome.runtime.sendMessage(
      { type: "CLEANCART_SCAN", payload: { productTitle, rawIngredients: rawIngredients || undefined, store: STORE } },
      (resp) => {
        state = { ...state, data: resp || { ok: false, error: "No response from CleanCart" }, expanded: false, openFlag: null };
        render();
      },
    );
  }

  const schedule = () => { clearTimeout(timer); timer = setTimeout(scan, DEBOUNCE_MS); };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("popstate", schedule);
  schedule();
})();
