(function() {
  if (window !== window.top) return;
  var HB_BRIDGE_SECRET = '__HB_BRIDGE_SECRET__';
  if (window.__heybrocLiveObserverInstalled) {
    if (typeof window.__heybrocScheduleCheck === 'function') window.__heybrocScheduleCheck(true);
    return;
  }
  window.__heybrocLiveObserverInstalled = true;

  function postBridge(payload) {
    try {
      if (window.heybrocAndroidBridge && typeof window.heybrocAndroidBridge.postMessage === 'function') {
        payload._hbSec = HB_BRIDGE_SECRET;
        window.heybrocAndroidBridge.postMessage(JSON.stringify(payload));
      }
    } catch (e) {}
  }

  var NON_TITLE_RE = /^(search|your cart|shopping cart|cart|bag|basket|checkout|review order|order summary|items to add next|product information|similar items|customers also.*|sponsored.*|buy (?:it )?again|frequently bought together|saved for later|walmart|target|costco(?:\s+wholesale)?|sam'?s\s+club|aldi|kroger|instacart|whole\s+foods(?:\s+market)?|amazon(?:\s+fresh)?|bj'?s(?:\s+wholesale\s+club)?|doordash|dashmart|uber\s*eats|shipt|sign\s*in|log\s*in|continue\s+as\s+guest|departments|grocery|deals|weekly\s+ad|dairy\s*&\s*eggs|fresh\s+produce|fruits?\s*&\s*vegetables?|meat\s*&\s*seafood|bakery(?:\s*&\s*bread)?|deli|frozen(?:\s+foods?)?|pantry|snacks|beverages|household|personal\s+care|all\s+products|shop\s+all)$/i;
  var EXCLUDED_CONTAINER_SEL = '[data-testid*="carousel" i], [class*="carousel" i], [aria-label*="Sponsored" i], [data-testid*="sponsored" i], [data-testid*="similar" i], [data-testid*="related" i], [data-testid*="upsell" i], [data-testid*="recommend" i], #sc-saved-cart';
  var EXCLUDED_HEADING_RE = /\b(customers\s+also\s+(?:viewed|bought|shopped|considered)|similar\s+items?|sponsored(?:\s+products?|\s+items?)?|buy\s+(?:it\s+)?again|frequently\s+bought\s+together|items?\s+to\s+add\s+next|recommended(?:\s+for\s+you)?|you\s+may\s+also\s+like|related\s+(?:products?|items?)|more\s+to\s+consider|saved\s+for\s+later)\b/i;

  function clean(s) {
    return String(s || '')
      .replace(/\s+/g, ' ')
      .replace(/^(?:sponsored|best\s+seller|overall\s+pick|popular\s+pick|rollback)\s*[,•|:\-]?\s*/i, '')
      .replace(/\s*\(\d+(?:\.\d+)?\s*stars?.*$/i, '')
      .trim();
  }

  function isVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    var st = window.getComputedStyle(el);
    if (!st || st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  var APP_INSTALL_CTA_RE = /^(?:get\s+the\s+app|open\s+in\s+(?:the\s+)?(?:walmart\s+|target\s+|instacart\s+|sam'?s\s+club\s+|bj'?s\s+|kroger\s+|amazon\s+|aldi\s+|costco\s+)?app|open\s+app|use\s+(?:the\s+)?app|download\s+(?:the\s+)?app|continue\s+in\s+app|shop\s+in\s+(?:the\s+)?app)$/i;
  var APP_INSTALL_HREF_RE = /play\.google\.com|market\.android\.com|(?:apps|itunes)\.apple\.com|\.onelink\.me|\.app\.link|\bbnc\.lt\b|app\.adjust\.com|\.adj\.st|\.smart\.link|^intent:\/\/|^market:\/\//i;
  var SENSITIVE_BANNER_PATH_RE = /\/(?:cart|bag|basket|checkout|gp\/cart|store\/cart|shop\/cart|login|signin|sign-in|account|auth|register)(?:\/|$)/i;
  var BANNER_FORBIDDEN_TEXT_RE = /\$\s*\d|\b(?:cart|bag|basket|checkout|subtotal|total|pickup|delivery|shipping|address|zip\s*code|sign\s*in|log\s*in|account|password|verification|filter|sort|search\s+results)\b/i;
  var hbBannerLastHref = location.href;
  var hbBannerScanDeadline = Date.now() + 2600;

  function ensureAppBannerSuppressorStyles() {
    var metaApple = document.querySelector('meta[name="apple-itunes-app"]');
    if (metaApple && metaApple.parentNode) metaApple.parentNode.removeChild(metaApple);
    var metaPlay = document.querySelector('meta[name="google-play-app"]');
    if (metaPlay && metaPlay.parentNode) metaPlay.parentNode.removeChild(metaPlay);
    if (document.getElementById('hb-app-banner-suppressor')) return;
    var head = document.head || document.documentElement;
    if (!head) return;
    var st = document.createElement('style');
    st.id = 'hb-app-banner-suppressor';
    st.textContent = '#branch-banner-iframe, .branch-journeys-top, [id^="branch-banner"], [class*="branch-animation"], .smartbanner, [id*="smartbanner" i], smart-banner, [data-testid="smart-banner"], [data-testid="app-banner"], [data-testid="download-app-banner"], [data-automation-id="app-banner"], [data-automation-id="smart-banner"], [data-test="smartBanner"], [data-test="appBanner"], [data-hb-app-banner-hidden="1"] { display: none !important; visibility: hidden !important; height: 0 !important; min-height: 0 !important; pointer-events: none !important; overflow: hidden !important; }';
    head.appendChild(st);
  }

  function dismissRetailerAppBanners() {
    ensureAppBannerSuppressorStyles();
    if (location.href !== hbBannerLastHref) {
      hbBannerLastHref = location.href;
      hbBannerScanDeadline = Date.now() + 2600;
    }
    if (Date.now() > hbBannerScanDeadline) return;
    if (SENSITIVE_BANNER_PATH_RE.test(location.pathname || '')) return;

    var ctas = document.querySelectorAll('a, button, [role="button"]');
    var vw = Math.max(280, window.innerWidth || 390);
    var vh = Math.max(400, window.innerHeight || 844);
    for (var i = 0; i < ctas.length; i++) {
      var cta = ctas[i];
      if (!cta || (cta.closest && cta.closest('[data-hb-app-banner-hidden="1"], header, nav, footer, [role="contentinfo"], form, [role="dialog"], [aria-modal="true"]'))) continue;
      var ctaText = clean(cta.textContent || '');
      var href = String((cta.getAttribute && cta.getAttribute('href')) || '');
      var matchesCta = APP_INSTALL_CTA_RE.test(ctaText) || (cta.tagName === 'A' && APP_INSTALL_HREF_RE.test(href));
      if (!matchesCta) continue;

      var bannerEl = null;
      var cur = cta.parentElement;
      var depth = 0;
      while (cur && depth < 6) {
        var tag = (cur.tagName || '').toUpperCase();
        var cid = String(cur.id || '');
        var role = String((cur.getAttribute && cur.getAttribute('role')) || '').toLowerCase();
        var ariaModal = String((cur.getAttribute && cur.getAttribute('aria-modal')) || '').toLowerCase();
        if (cur === document.body || cur === document.documentElement || tag === 'MAIN' || tag === 'HEADER' || tag === 'NAV' || tag === 'FOOTER' || tag === 'FORM' || role === 'dialog' || role === 'contentinfo' || ariaModal === 'true' || cid === '__next' || cid === 'root' || cid === 'app') {
          break;
        }
        if (typeof cur.getBoundingClientRect === 'function') {
          var r = cur.getBoundingClientRect();
          var cs = window.getComputedStyle(cur);
          var pos = cs ? cs.position : '';
          var curText = clean(cur.textContent || '');
          var txtLen = curText.length;
          var hasProtectedNodes = Boolean(cur.querySelector && cur.querySelector('header, nav, footer, [role="contentinfo"], form, input, select, textarea, h1, [role="dialog"], [aria-modal="true"]'));
          var hasForbiddenCopy = BANNER_FORBIDDEN_TEXT_RE.test(curText);
          var anchoredEdge = (pos === 'fixed' || pos === 'sticky' || r.bottom >= vh - 96 || r.top <= 96);
          if (!hasProtectedNodes && !hasForbiddenCopy && txtLen <= 320 && r.height >= 36 && r.height <= 240 && r.width >= vw * 0.60 && anchoredEdge) {
            bannerEl = cur;
            break;
          }
        }
        cur = cur.parentElement;
        depth++;
      }

      if (bannerEl && bannerEl.getAttribute('data-hb-app-banner-hidden') !== '1') {
        bannerEl.setAttribute('data-hb-app-banner-hidden', '1');
        var btns = bannerEl.querySelectorAll('button, [role="button"]');
        for (var b = 0; b < btns.length; b++) {
          var btn = btns[b];
          if (btn === cta) continue;
          var bHref = String((btn.getAttribute && btn.getAttribute('href')) || '');
          if (bHref && APP_INSTALL_HREF_RE.test(bHref)) continue;
          var aria = clean(String((btn.getAttribute && (btn.getAttribute('aria-label') || btn.getAttribute('title'))) || ''));
          var bTxt = clean(btn.textContent || '');
          var safeAriaClose = /^(?:close|dismiss)(?:\s+(?:app\s+)?(?:banner|prompt|bar))?$/i.test(aria) && !/cart|drawer|modal|dialog|menu|address|search|filter|nav/i.test(aria);
          var safeTextClose = /^(?:[×✕✖]|not\s+now|no\s+thanks|continue\s+in\s+(?:mobile\s+)?browser)$/i.test(bTxt);
          if (safeAriaClose || safeTextClose) {
            try { btn.click(); } catch (e) {}
            break;
          }
        }
        bannerEl.style.setProperty('display', 'none', 'important');
        bannerEl.style.setProperty('visibility', 'hidden', 'important');
        bannerEl.style.setProperty('pointer-events', 'none', 'important');
      }
    }
  }

  function detectInstacartSlug() {
    var host = String(location.hostname || '').toLowerCase();
    if (host.indexOf('instacart.') === -1) return '';
    var m = String(location.pathname || '').match(/\/store\/([a-z0-9][a-z0-9_-]{0,60})(?:\/|$)/i);
    if (!m || !m[1]) return '';
    var slug = m[1].toLowerCase();
    if (/^\d+$/.test(slug)) return '';
    if (/^(?:items?|products?|checkout(?:_[a-z0-9_-]+)?|cart|account|help|search|recipes|categories|collections|referrals|gift-cards|orders|lists|bookmarks|login|signup|your-items|retailers|store|stores|hub|deals|promotions|favorites|saved|all|shop|convenience|grocery|brands|loyalty|family|instacart-plus|partner_recipes|partner-recipes|settings|savings|discover|directory|s)$/.test(slug)) {
      return '';
    }
    return slug;
  }

  function isCartUrl() {
    return /\/(?:cart|bag|basket|checkout|gp\/cart|store\/cart|shop\/cart)(?:\/|$)/i.test(location.pathname);
  }

  function looksLikeProductUrl(url) {
    if (isCartUrl()) return false;
    var host = (location.hostname || '').toLowerCase();
    var path = (location.pathname || '');
    var search = (location.search || '');
    if (host.indexOf('wholefoods') !== -1) {
      return /\/product\//i.test(path);
    }
    if (host.indexOf('aldi.') !== -1) {
      return /\/product\//i.test(path) || /\/detail\/ps\/p\//i.test(path) || (host.indexOf('shop.') === 0 && /\/products\//i.test(path));
    }
    if (host.indexOf('instacart') !== -1 || host.indexOf('shipt') !== -1 || host.indexOf('doordash') !== -1) {
      return /\/(?:products?|items?)\//i.test(path) || /[?&](?:item_id|product_id|productId)=/i.test(search) || /item-details|mod=quickView/i.test(url);
    }
    return /(\/ip\/|\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/p\/|\/product\/|\/products\/|\/detail\/ps\/p\/|\/sams\/shop\/product\/|\/items?\/|\.product\.\d+\.html|[?&](?:item_id|product_id|productId)=|item-details|mod=quickView)/i.test(url);
  }

  function isCartDrawer(el) {
    if (!el) return false;
    var meta = (el.id || '') + ' ' + (el.className || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-testid') || '');
    if (/\b(cart[-_ ]?(?:drawer|modal|panel|flyout|sidebar)|shopping[-_ ]?cart|mini[-_ ]?cart|bag[-_ ]?drawer)\b/i.test(meta)) return true;
    var h = el.querySelector('h1, h2, h3, [role="heading"]');
    var ht = clean(h ? h.textContent : '');
    if (/^(?:your\s+)?(?:shopping\s+)?(?:cart|bag|basket|order)(?:\s*\(\d+.*\))?$/i.test(ht)) return true;
    return false;
  }

  function isInsideExcluded(el, stopRoot) {
    if (!el || typeof el.closest !== 'function') return false;
    if (el.closest(EXCLUDED_CONTAINER_SEL)) return true;
    var cur = el.parentElement;
    while (cur && cur !== stopRoot && cur !== document.body) {
      if (/^(SECTION|ASIDE|DIV)$/i.test(cur.tagName)) {
        var hd = cur.querySelector(':scope > h2, :scope > h3, :scope > header h2, :scope > header h3');
        if (hd && EXCLUDED_HEADING_RE.test(clean(hd.textContent))) return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function findOpenProductModal() {
    var sel = '[role="dialog"], [aria-modal="true"], [data-testid*="item-details" i], [data-testid*="quick-view" i], [data-testid*="modal" i], [data-anchor-id*="ItemModal" i]';
    var rawNodes = Array.prototype.slice.call(document.querySelectorAll(sel));
    var topDivs = document.querySelectorAll('body > div, body > aside, body > section, #__next > div');
    for (var t = 0; t < topDivs.length; t++) {
      var td = topDivs[t];
      if (rawNodes.indexOf(td) !== -1) continue;
      var st = window.getComputedStyle(td);
      if (st && st.position === 'fixed' && (parseInt(st.zIndex, 10) || 0) >= 40) {
        rawNodes.push(td);
      }
    }
    var best = null;
    var bestRank = 0;
    for (var i = 0; i < rawNodes.length; i++) {
      var d = rawNodes[i];
      if (!isVisible(d) || isCartDrawer(d)) continue;
      var r = d.getBoundingClientRect();
      if (r.width < 260 || r.height < 220) continue;
      var meta = (d.id || '') + ' ' + (d.className || '') + ' ' + (d.getAttribute('aria-label') || '') + ' ' + (d.getAttribute('data-testid') || '');
      if (/\b(cookie|consent|onetrust|gdpr|privacy|navbar|site-header|top-nav|search-dropdown|autocomplete|address-modal|store-selector|login|signin)\b/i.test(meta)) continue;
      var hd = d.querySelector('h1, h2, h3, [role="heading"], [data-testid*="product-title" i], [data-testid*="item-title" i]');
      var ht = clean(hd ? hd.textContent : '');
      if (!ht || ht.length < 4 || NON_TITLE_RE.test(ht)) continue;
      var sample = (d.textContent || '').slice(0, 2500);
      if (!/\$\s*\d+|\b(add\s+to\s+(?:cart|bag|basket|order)|ingredients|nutrition\s+facts|oz|lb|fl\s*oz|count|pack)\b/i.test(sample)) continue;
      var z = parseInt(window.getComputedStyle(d).zIndex, 10) || 1;
      var rank = ((d.getAttribute('aria-modal') === 'true' || d.getAttribute('role') === 'dialog') ? 1000 : 200) + Math.min(500, z);
      if (rank >= bestRank) {
        bestRank = rank;
        best = d;
      }
    }
    return best;
  }

  function readHeroTitle(modalScope) {
    var root = modalScope || document;
    var sels = modalScope ? [
      '[data-testid*="item-details" i] h1', '[data-testid*="item-details" i] h2', '[data-testid*="item-details" i] h3',
      '[data-anchor-id*="ItemModal" i] h1', '[data-anchor-id*="ItemModal" i] h2', '[data-anchor-id*="ItemModal" i] h3',
      '[data-testid*="product-title" i]', '[data-testid*="product-name" i]', '[data-testid*="itemHeader" i]',
      'h1', 'h2', 'h3', '[role="heading"]'
    ] : [
      '[data-testid="product-page-title"]', 'h1[data-automation-id*="product-title" i]', '[data-automation-id="product-title"]',
      'h1.ProductDetails-header', '#productTitle', 'h1#title', '#title_feature_div #title', '#titleSection #title',
      '[data-hook="product-title"]', '#title', 'h1[itemprop="name"]', 'h1[data-testid*="title" i]',
      '[data-testid*="product-title" i] h1', '[data-testid*="item-details" i] h1', 'main h1', 'h1'
    ];
    for (var i = 0; i < sels.length; i++) {
      var els = root.querySelectorAll(sels[i]);
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (!isVisible(el)) continue;
        if (isInsideExcluded(el, modalScope || document.body)) continue;
        if (!modalScope && isCartDrawer(el.closest('[role="dialog"], aside, section'))) continue;
        var t = clean(el.textContent);
        if (t && t.length >= 4 && t.length <= 240 && !NON_TITLE_RE.test(t)) return t;
      }
    }
    return '';
  }

  function titlesShareTokens(a, b) {
    var tokA = clean(a).toLowerCase().split(/[^a-z0-9]+/).filter(function(w) { return w.length >= 3; });
    var tokB = clean(b).toLowerCase().split(/[^a-z0-9]+/).filter(function(w) { return w.length >= 3; });
    if (!tokA.length || !tokB.length) return false;
    var hits = 0;
    for (var i = 0; i < tokA.length; i++) {
      if (tokB.indexOf(tokA[i]) !== -1) hits++;
    }
    return hits >= Math.min(2, tokA.length);
  }

  function readIngredientsFromScope(modalScope) {
    var root = modalScope || document.querySelector('main') || document.body;
    if (!root) return '';
    var stopRe = /\b(Allergens?|Contains\s*:|Warnings?|Directions|Nutrition\s+Facts|Distributed\s+by|Legal\s+Disclaimer)\b/i;
    if (!modalScope) {
      var amzInfo = document.querySelector('#importantInformation_feature_div, #nic-po-expander-content');
      if (amzInfo) {
        var amzTxt = (amzInfo.textContent || '').replace(/\s+/g, ' ');
        var amzMatch = amzTxt.match(/\bIngredients\s*:?\s*([\s\S]{12,1400})/i);
        if (amzMatch && amzMatch[1]) {
          var candAmz = clean(amzMatch[1].split(stopRe)[0]);
          if (candAmz.length >= 12 && candAmz.indexOf(',') !== -1) return candAmz;
        }
      }
    }
    var labels = root.querySelectorAll('h2, h3, h4, dt, strong, b, span, div, p, button');
    for (var i = 0; i < labels.length; i++) {
      var el = labels[i];
      if (isInsideExcluded(el, modalScope || document.body)) continue;
      var own = el.children.length <= 2 ? clean(el.textContent) : '';
      if (!/^ingredients\s*:?$/i.test(own)) continue;
      var sib = el.nextElementSibling;
      for (var k = 0; k < 3 && sib; k++, sib = sib.nextElementSibling) {
        if (isInsideExcluded(sib, modalScope || document.body)) continue;
        var stxt = clean(String(sib.textContent || '').split(stopRe)[0]);
        if (stxt.length >= 12 && stxt.length < 2500 && !NON_TITLE_RE.test(stxt)) return stxt;
      }
      var ptxt = clean(String(el.parentElement ? el.parentElement.textContent : '').replace(/^ingredients\s*:?\s*/i, '').split(stopRe)[0]);
      if (ptxt.length >= 12 && ptxt.length < 2500 && !NON_TITLE_RE.test(ptxt)) return ptxt;
    }
    var rawText = (root.innerText || root.textContent || '');
    var m = rawText.match(/\bIngredients\s*[:\n]\s*([^\n]{12,1200})/i);
    if (m && m[1]) {
      return clean(m[1].split(stopRe)[0]);
    }
    return '';
  }

  function extractBestCardTitle(cardEl, sels) {
    var best = '';
    for (var s = 0; s < sels.length; s++) {
      var els = cardEl.querySelectorAll(sels[s]);
      for (var k = 0; k < els.length; k++) {
        var el = els[k];
        if (el.closest && el.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
        var raw = clean(el.getAttribute('aria-label') || el.textContent || '');
        if (raw && raw.length >= 5 && raw.length <= 240 && !NON_TITLE_RE.test(raw) && !CARD_CTA_NOISE_RE.test(raw) && !/^\$\d/.test(raw)) {
          best = raw;
          break;
        }
      }
      if (best) break;
    }
    if (best && /(?:\.\.\.|…)\s*$/.test(best)) {
      var fullSels = ['span.w_iUH7', '[class*="w_iUH7"]', 'a[link-identifier]', 'a[aria-label]'];
      var stem = best.replace(/(?:\.\.\.|…)\s*$/, '').trim().toLowerCase().slice(0, 24);
      for (var fs = 0; fs < fullSels.length; fs++) {
        var fullEls = cardEl.querySelectorAll(fullSels[fs]);
        for (var fk = 0; fk < fullEls.length; fk++) {
          var fel = fullEls[fk];
          if (fel.closest && fel.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
          var fullCand = clean(fel.getAttribute('aria-label') || fel.textContent || '');
          if (
            fullCand &&
            fullCand.length > best.length &&
            fullCand.length <= 240 &&
            !/(?:\.\.\.|…)\s*$/.test(fullCand) &&
            !NON_TITLE_RE.test(fullCand) &&
            !CARD_CTA_NOISE_RE.test(fullCand) &&
            !/^\$\d/.test(fullCand) &&
            (!stem || fullCand.toLowerCase().indexOf(stem) === 0 || titlesShareTokens(best, fullCand))
          ) {
            return fullCand;
          }
        }
      }
    }
    return best;
  }

  function findAlignedSearchCard() {
    if (isCartUrl()) return { title: '', storeImageUrl: '' };
    var cardSel = '[data-item-id], [data-testid*="list-view" i], [data-testid*="item-stack" i] > div, div[class*="mb0"][class*="ph1"], [data-testid*="product-card" i], [data-testid*="item-card" i], [data-testid*="product-tile" i], [data-test*="product-card" i], [data-qa*="product-card" i], [data-component-type="s-search-result"], article[class*="product" i], li[class*="product" i]';
    var rawCards = Array.prototype.slice.call(document.querySelectorAll(cardSel));
    if (!rawCards.length) {
      var links = document.querySelectorAll('a[link-identifier], a[href*="/sp/track"], a[href*="/ip/"], a[href*="/p/"], a[href*="/dp/"], a[href*="/gp/aw/d/"], a[href*="/products/"], a[href*="/product/"]');
      for (var k = 0; k < links.length && rawCards.length < 40; k++) {
        var anc = links[k].closest('article, li, [role="group"], div');
        if (anc && rawCards.indexOf(anc) === -1) rawCards.push(anc);
      }
    }
    var vh = Math.max(320, window.innerHeight || 680);
    var targetY = (typeof window.__heybrocBubbleCenterY === 'number' && window.__heybrocBubbleCenterY > 40)
      ? window.__heybrocBubbleCenterY
      : (vh * 0.38);
    var bestTitle = '';
    var bestCard = null;
    var bestDist = 999999;
    var titleSels = [
      'span.w_iUH7', '[class*="w_iUH7"]',
      '[data-automation-id*="product-title" i]', '[data-test="product-title"]', '[data-testid*="product-title" i]',
      '[data-testid*="item-title" i]', '[data-testid*="product-card-name" i]', '[data-qa*="product-name" i]',
      'h2 a span', 'h3 a span', 'h2', 'h3',
      'a[link-identifier]', 'a[href*="/sp/track"]', 'a[href*="/ip/"]', 'a[href*="/p/"]', 'a[href*="/dp/"]',
      'a[href*="/gp/aw/d/"]', 'a[href*="/products/"]', 'a[href*="/product/"]'
    ];

    for (var i = 0; i < rawCards.length; i++) {
      var card = rawCards[i];
      if (!isVisible(card)) continue;
      if (card.querySelectorAll('[data-item-id], [data-asin]:not([data-asin=""]), [data-testid*="product-card" i]').length > 1) continue;
      if (card.closest('#sc-saved-cart, [data-testid*="saved-for-later" i], [data-test*="savedForLater" i]')) continue;
      if (isCartDrawer(card.closest('[role="dialog"], aside, section'))) continue;
      var cr = card.getBoundingClientRect();
      if (cr.height < 64 || cr.height > vh * 0.92 || cr.width < 110) continue;
      if (cr.bottom < 95 || cr.top > vh - 45) continue;

      var candTitle = extractBestCardTitle(card, titleSels);
      if (!candTitle) continue;

      var dist = 0;
      if (targetY < cr.top) dist = cr.top - targetY;
      else if (targetY > cr.bottom) dist = targetY - cr.bottom;
      else dist = Math.abs(((cr.top + cr.bottom) * 0.5) - targetY) * 0.25;
      if (cr.top < 72) dist += 180;
      if (dist < bestDist) {
        bestDist = dist;
        bestTitle = candTitle;
        bestCard = card;
      }
    }
    if (bestDist > 260 || !bestTitle) return { title: '', storeImageUrl: '' };
    var cardImgUrl = '';
    if (bestCard) {
      var cImgs = bestCard.querySelectorAll('img');
      for (var ci = 0; ci < cImgs.length; ci++) {
        var u = sanitizeStoreImgSrc(cImgs[ci]);
        if (u) { cardImgUrl = u; break; }
      }
    }
    return { title: bestTitle, storeImageUrl: cardImgUrl };
  }

  var NON_FOOD_GRID_RE = /\b(?:paper\s+towels?|toilet\s+(?:paper|tissue)|bath\s+tissue|facial\s+tissues?|trash\s+bags?|garbage\s+bags?|aluminum\s+foil|parchment\s+paper|plastic\s+wrap|paper\s+plates?|laundry\s+(?:detergent|pods?|sanitizer)|fabric\s+softener|dryer\s+sheets?|dish\s+(?:soap|detergent)|dishwasher\s+(?:pods?|pac?ks?|detergent)|disinfecting\s+wipes?|bleach|all[- ]purpose\s+cleaner|glass\s+cleaner|toilet\s+bowl\s+cleaner|air\s+freshener|diapers?|pull[- ]ups?|baby\s+wipes?|cat\s+litter|dog\s+(?:food|treats?|pads?)|cat\s+(?:food|treats?)|pet\s+food|alkaline\s+batteries|aa\s+batteries|aaa\s+batteries|motor\s+oil|windshield\s+washer|light\s+bulbs?|toothpaste|toothbrush|mouthwash|shampoo|body\s+wash|deodorant|antiperspirant|razor\s+blades?|shaving\s+cream|sunscreen|tampons?|maxi\s+pads?|pantiliners?)\b/i;
  var HOUSEHOLD_BAG_CUP_BRAND_RE = /\b(?:ziploc|hefty|glad|reynolds|up\s*&\s*up|great\s+value|kirkland\s+signature|member'?s\s+mark|solimo|amazon\s+basics|boulder|if\s+you\s+care|stasher|dixie|solo|chinet|vanity\s+fair|sparkle|bounty|charmin|scott|cottonelle|kleenex|puff'?s|tide|gain|downy|cascade|dawn|lysol|clorox)\b/i;
  var FOOD_CONTEXT_GUARD_RE = /\b(?:chicken|beef|pork|turkey|salmon|shrimp|fish|steak|meatball|nugget|strip|fillet|tender|wing|patty|sausage|bacon|ham|burrito|taquito|pizza|ravioli|pierogi|dumpling|gyoza|wonton|potsticker|vegetable|broccoli|pea|corn|berry|berries|strawberry|blueberry|mango|peach|fruit|fries|tot|waffle|pancake|oat|granola|cereal|chip|pretzel|popcorn|cracker|cookie|brownie|candy|chocolate|peanut\s+butter|reese'?s|butterfinger|snickers|m&m|gummy|yogurt|cheese|ice\s+cream|coffee|tea|k-cup|pod|broth|soup|rice|pasta|noodle|bean|dough|bread|flour|yeast|baking|seasoning|spice|sauce)\b/i;

  function isNonFoodGridTitle(t) {
    var s = String(t || '');
    if (NON_FOOD_GRID_RE.test(s)) return true;
    if (/\bconditioner\b/i.test(s)) {
      if (!/\b(?:dough|bread|food|meat|beer|baking|flour)\b[\s\-]*conditioner\b/i.test(s)) return true;
    }
    if (/\b(?:storage|freezer|sandwich|quart|gallon|snack)\s+bags?\b/i.test(s)) {
      if (!/\b(?:in\s+a|resealable|zip(?:-|\s*)top)\b/i.test(s) && (HOUSEHOLD_BAG_CUP_BRAND_RE.test(s) || !FOOD_CONTEXT_GUARD_RE.test(s))) {
        return true;
      }
    }
    if (/\bpaper\s+cups?\b/i.test(s)) {
      if (HOUSEHOLD_BAG_CUP_BRAND_RE.test(s) || !FOOD_CONTEXT_GUARD_RE.test(s)) return true;
    }
    return false;
  }

  var CARD_SEL = '[data-item-id], [data-testid*="list-view" i], [data-testid*="item-stack" i] > div, div[class*="mb0"][class*="ph1"], [data-testid*="product-card" i], [data-testid*="item-card" i], [data-testid*="product-tile" i], [data-test*="product-card" i], [data-test*="@web/site-top-of-funnel/ProductCardWrapper"], [data-qa*="product-card" i], [data-automation-id="product-tile"], [data-component-type="s-search-result"], [data-asin]:not([data-asin=""]), article[class*="product" i], li[class*="product" i]';
  var MULTI_CARD_UNIT_SEL = '[data-item-id], [data-asin]:not([data-asin=""]), [data-testid*="product-card" i], [data-testid*="item-card" i], [data-test*="@web/site-top-of-funnel/ProductCardWrapper"]';
  var PRODUCT_LINK_SEL = 'a[link-identifier], a[href*="/sp/track"], a[href*="/ip/"], a[href*="/products/"], a[href*="/p/"], a[href*="/sams/shop/product/"], a[href*="/detail/ps/p/"], a[href*="/dp/"], a[href*="/gp/aw/d/"]';
  var PLACEHOLDER_IMG_RE = /(?:^|[\/_.-])(?:1x1|pixel|spacer|spinner|skeleton|shimmer|placeholder|transparent|blank|loading|lazyload|grey-pixel)(?:[\/_.-]|$)|^data:image\/gif|^data:image\/svg\+xml.*(?:feGaussianBlur|blur|shimmer|skeleton|spinner|spacer|1x1)/i;
  var NON_PRODUCT_IMG_RE = /(?:^|[\/_.-])(?:logo|sprite|icon|avatar|badge|stars?|rating|banner|promo|favicon)(?:[\/_.-]|$)/i;
  var CARD_CTA_NOISE_RE = /^(?:add(?:\s+to\s+(?:cart|bag|basket|order))?|options|choose\s+options|select\s+options|quick\s+add|view\s+details|sponsored|shop\s+now|\+|-|\d+\s*ct)$/i;

  function isPlaceholderCardImg(img, src) {
    var s = String(src || '').trim();
    if (!s) return true;
    if (PLACEHOLDER_IMG_RE.test(s)) return true;
    if (/^data:image\/(?:webp|png|jpeg|jpg)/i.test(s) && s.length < 420 && (!img || !img.naturalWidth || img.naturalWidth <= 64)) return true;
    if (img && img.complete && img.naturalWidth > 0 && img.naturalWidth <= 2 && img.naturalHeight > 0 && img.naturalHeight <= 2) {
      return true;
    }
    return false;
  }

  function sanitizeStoreImgSrc(img) {
    if (!img || (img.closest && img.closest('.hb-photo-badge, header, nav, footer'))) return '';
    var raw = String(img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '').trim();
    if (!raw || /^data:|^blob:/i.test(raw)) {
      var srcset = String(img.getAttribute('srcset') || '').trim();
      if (srcset) {
        var firstPart = srcset.split(',')[0].trim().split(/\s+/)[0];
        if (firstPart) raw = firstPart;
      }
    }
    if (!raw || /^data:|^blob:/i.test(raw)) return '';
    try {
      var abs = new URL(raw, location.href);
      if (abs.protocol !== 'https:') return '';
      var href = abs.href;
      if (href.length > 900 || isPlaceholderCardImg(img, href) || NON_PRODUCT_IMG_RE.test(abs.pathname)) return '';
      return href;
    } catch (e) {
      return '';
    }
  }

  function readHeroImageUrl(modalScope) {
    var root = modalScope || document.querySelector('main') || document.body;
    if (!root) return '';
    var heroSels = [
      '[data-testid*="hero-image" i] img',
      '[data-testid*="media-thumbnail" i] img',
      '[data-testid*="item-details" i] img',
      '[data-testid*="product-image" i] img',
      '#landingImage',
      '#main-image',
      'img[itemprop="image"]',
      'img'
    ];
    var bestSrc = '';
    var bestArea = 0;
    for (var s = 0; s < heroSels.length; s++) {
      var imgs = root.querySelectorAll(heroSels[s]);
      for (var i = 0; i < imgs.length; i++) {
        var img = imgs[i];
        if (!isVisible(img) || isInsideExcluded(img, modalScope || document.body)) continue;
        if (!modalScope && isCartDrawer(img.closest('[role="dialog"], aside, section'))) continue;
        var r = img.getBoundingClientRect();
        if (r.width < 64 || r.height < 64 || r.top > (window.innerHeight || 840) + 160) continue;
        var u = sanitizeStoreImgSrc(img);
        if (!u) continue;
        var area = r.width * r.height + (s < heroSels.length - 1 ? 25000 : 0);
        if (area > bestArea) {
          bestArea = area;
          bestSrc = u;
        }
      }
      if (bestSrc && s < heroSels.length - 1) return bestSrc;
    }
    if (bestSrc) return bestSrc;
    if (!modalScope && looksLikeProductUrl(location.href)) {
      var ogImg = document.querySelector('meta[property="og:image"]');
      if (ogImg && ogImg.content) {
        try {
          var ogUrl = new URL(ogImg.content, location.href);
          if (ogUrl.protocol === 'https:' && ogUrl.href.length <= 900 && !NON_PRODUCT_IMG_RE.test(ogUrl.pathname)) {
            return ogUrl.href;
          }
        } catch (e) {}
      }
    }
    return '';
  }

  function makePageToken() {
    return 'p' + Math.random().toString(36).slice(2, 8);
  }

  var hbPageToken = makePageToken();
  var hbLastBadgeUrl = location.href;
  var hbPrefRev = 1;
  var hbCardSeq = 1;
  var hbCardState = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var hbOwnerCardByImg = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var hbOwnerCardById = {};
  var hbTitleScoreCache = {};
  var hbTitleScoreKeys = [];
  var hbPendingQueue = [];
  var hbBatchTimer = null;
  var hbBatchWatchdog = null;
  var hbRetryTimer = null;
  var hbRetryAt = 0;
  var hbInFlightBatches = 0;
  var MAX_IN_FLIGHT_BATCHES = 2;
  var hbIntersectionObs = null;

  function makeTitleScoreKey(title) {
    return String(title || '').toLowerCase().trim() + '|' + detectInstacartSlug() + '|' + hbPrefRev;
  }

  function cacheTitleBadgeScore(title, val) {
    var k = makeTitleScoreKey(title);
    if (!Object.prototype.hasOwnProperty.call(hbTitleScoreCache, k)) {
      hbTitleScoreKeys.push(k);
      while (hbTitleScoreKeys.length > 260) {
        var ev = hbTitleScoreKeys.shift();
        if (ev) delete hbTitleScoreCache[ev];
      }
    }
    hbTitleScoreCache[k] = val;
  }

  function scheduleHbRetry(delayMs) {
    var d = Math.max(120, Math.round(Number(delayMs) || 0));
    var targetAt = Date.now() + d;
    if (hbRetryTimer && hbRetryAt > Date.now() && hbRetryAt <= targetAt + 40) {
      return;
    }
    if (hbRetryTimer) {
      clearTimeout(hbRetryTimer);
      hbRetryTimer = null;
    }
    hbRetryAt = targetAt;
    hbRetryTimer = setTimeout(function() {
      hbRetryTimer = null;
      hbRetryAt = 0;
      scanPhotoBadges();
    }, d);
  }

  function ensureHbBadgeStyles() {
    if (document.getElementById('hb-photo-badge-styles')) return;
    var st = document.createElement('style');
    st.id = 'hb-photo-badge-styles';
    st.textContent = '.hb-photo-badge-slot{display:flex!important;justify-content:center!important;align-items:center!important;width:100%!important;margin:7px 0 4px 0!important;padding:0!important;position:relative!important;z-index:20!important;pointer-events:auto!important;flex:0 0 auto!important;}.hb-photo-badge{position:relative!important;z-index:20!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;min-height:34px!important;gap:6px!important;padding:6px 15px!important;border-radius:999px!important;font:900 17px/1.1 Roboto,-apple-system,BlinkMacSystemFont,sans-serif!important;font-variant-numeric:tabular-nums!important;letter-spacing:-0.015em!important;color:#fff!important;border:2px solid rgba(255,255,255,0.96)!important;box-shadow:0 4px 12px rgba(15,23,42,0.28)!important;cursor:pointer!important;user-select:none!important;-webkit-user-select:none!important;pointer-events:auto!important;text-decoration:none!important;white-space:nowrap!important;}.hb-photo-badge--overlay{position:absolute!important;bottom:6px!important;left:50%!important;transform:translateX(-50%)!important;}.hb-photo-badge__ic{font-size:20px!important;line-height:1!important;display:inline-block!important;}.hb-photo-badge--green{background:rgba(22,163,74,0.97)!important;}.hb-photo-badge--yellow{background:rgba(217,119,6,0.97)!important;}.hb-photo-badge--red{background:rgba(220,38,38,0.97)!important;}.hb-photo-badge--advisory{box-shadow:0 0 0 2.5px #fbbf24,0 4px 12px rgba(15,23,42,0.3)!important;}.hb-photo-badge--loading{background:rgba(15,23,42,0.82)!important;opacity:0.92!important;}';
    (document.head || document.documentElement).appendChild(st);
  }

  function setHbBadgeContent(badge, iconText, labelText) {
    while (badge.firstChild) badge.removeChild(badge.firstChild);
    var ic = document.createElement('span');
    ic.className = 'hb-photo-badge__ic';
    ic.textContent = iconText;
    var tx = document.createElement('span');
    tx.textContent = labelText;
    badge.appendChild(ic);
    badge.appendChild(tx);
  }

  function findSafeCardAnchor(chosenImg, cardEl) {
    var imgR = chosenImg.getBoundingClientRect();
    var maxAnchorH = Math.min(420, Math.max(120, Math.round((imgR && imgR.height) || 200)) + 84);
    var cur = chosenImg.parentElement;
    if (cur && cur.tagName === 'PICTURE') cur = cur.parentElement;
    var candidate = null;
    var steps = 0;
    while (cur && cur !== document.body && steps < 5) {
      var cs = window.getComputedStyle(cur);
      var disp = cs ? cs.display : '';
      var cr = cur.getBoundingClientRect();
      if (disp && disp !== 'inline' && disp !== 'contents' && cr.width >= 44 && cr.height >= 44 && cr.height <= maxAnchorH) {
        candidate = cur;
        break;
      }
      if (cur === cardEl) break;
      cur = cur.parentElement;
      steps++;
    }
    if (!candidate && cardEl && cardEl !== document.body) {
      var cardR = cardEl.getBoundingClientRect();
      if (cardR.width >= 44 && cardR.height >= 44 && cardR.height <= maxAnchorH) {
        candidate = cardEl;
      }
    }
    if (!candidate || candidate === document.body) return null;
    var candCs = window.getComputedStyle(candidate);
    var prevPos = candidate.style.position;
    var prevIso = candidate.style.isolation;
    var prevZ = candidate.style.zIndex;
    if (candCs && candCs.position === 'static') {
      var beforeR = chosenImg.getBoundingClientRect();
      candidate.style.position = 'relative';
      candidate.style.isolation = 'isolate';
      if (window.getComputedStyle(candidate).zIndex === 'auto') {
        candidate.style.zIndex = '0';
      }
      var afterR = chosenImg.getBoundingClientRect();
      if (beforeR.width >= 40 && (afterR.width < 24 || afterR.height < 24)) {
        candidate.style.position = prevPos;
        candidate.style.isolation = prevIso;
        candidate.style.zIndex = prevZ;
        if (cardEl && cardEl !== candidate) {
          var fbR = cardEl.getBoundingClientRect();
          if (fbR.width >= 44 && fbR.height >= 44 && fbR.height <= maxAnchorH) {
            if (window.getComputedStyle(cardEl).position === 'static') {
              cardEl.style.position = 'relative';
            }
            cardEl.style.isolation = 'isolate';
            if (window.getComputedStyle(cardEl).zIndex === 'auto') {
              cardEl.style.zIndex = '0';
            }
            return cardEl;
          }
        }
        return null;
      }
      return candidate;
    }
    candidate.style.isolation = 'isolate';
    if (!candCs || candCs.zIndex === 'auto') {
      candidate.style.zIndex = '0';
    }
    return candidate;
  }

  function containerStacksVertically(el) {
    if (!el || el === document.body) return false;
    var cs = window.getComputedStyle(el);
    if (!cs) return false;
    var disp = cs.display || '';
    if (disp === 'inline' || disp === 'contents' || disp === 'none') return false;
    if (disp === 'flex' || disp === 'inline-flex') {
      var dir = String(cs.flexDirection || 'row').toLowerCase();
      return dir.indexOf('column') === 0;
    }
    if (disp === 'grid' || disp === 'inline-grid') {
      var cols = String(cs.gridTemplateColumns || '').trim();
      if (cols && cols !== 'none' && cols.split(/\s+/).length > 1) return false;
    }
    return true;
  }

  function nodeHasDetailsOrCta(el) {
    if (!el || !el.querySelector) return false;
    if (el.querySelector('h1, h2, h3, button, [data-test="product-title"], [data-automation-id*="product-title" i], [data-testid*="product-title" i], [data-testid*="item-title" i]')) {
      return true;
    }
    var txt = clean(el.textContent || '');
    return /\$\s*\d/.test(txt);
  }

  function mountBadgeUnderOrOnPhoto(chosenImg, cardEl, badge, fallbackAnchor) {
    if (chosenImg && cardEl && chosenImg.parentElement) {
      var beforeImgR = chosenImg.getBoundingClientRect();
      var photoUnit = chosenImg.parentElement;
      if (photoUnit && photoUnit.tagName === 'PICTURE' && photoUnit.parentElement) {
        photoUnit = photoUnit.parentElement;
      }
      var cur = photoUnit;
      var steps = 0;
      while (cur && cur !== cardEl && cur !== document.body && steps < 6) {
        var nextP = cur.parentElement;
        if (!nextP || nextP === document.body) break;
        if (nextP === cardEl) {
          photoUnit = cur;
          break;
        }
        if (nodeHasDetailsOrCta(nextP)) {
          photoUnit = cur;
          break;
        }
        var nr = nextP.getBoundingClientRect();
        if (nr.width >= 44 && nr.height <= Math.max(260, beforeImgR.height + 110)) {
          photoUnit = nextP;
          cur = nextP;
          steps++;
        } else {
          break;
        }
      }

      var slot = document.createElement('div');
      slot.className = 'hb-photo-badge-slot';
      slot.appendChild(badge);
      var inserted = false;
      var parentEl = photoUnit ? photoUnit.parentElement : null;
      if (parentEl && typeof parentEl.insertBefore === 'function' && containerStacksVertically(parentEl)) {
        parentEl.insertBefore(slot, photoUnit.nextSibling || null);
        inserted = true;
      } else if (
        photoUnit &&
        photoUnit.tagName !== 'IMG' &&
        photoUnit.tagName !== 'PICTURE' &&
        photoUnit.tagName !== 'A' &&
        containerStacksVertically(photoUnit)
      ) {
        photoUnit.appendChild(slot);
        inserted = true;
      }

      if (inserted) {
        var afterImgR = chosenImg.getBoundingClientRect();
        var badgeR = badge.getBoundingClientRect();
        var imgOk = beforeImgR.width < 36 || (afterImgR.width >= beforeImgR.width * 0.76 && afterImgR.height >= beforeImgR.height * 0.76);
        var sizeOk = badgeR.width >= 46 && badgeR.height >= 26;
        var posOk = badgeR.top >= afterImgR.bottom - 18 && badgeR.top <= afterImgR.bottom + 64;
        var clipped = false;
        var clipAnc = slot.parentElement;
        var clipSteps = 0;
        while (clipAnc && clipAnc !== document.body && clipSteps < 7) {
          var acs = window.getComputedStyle(clipAnc);
          if (acs && (acs.overflow === 'hidden' || acs.overflowY === 'hidden' || acs.overflow === 'clip' || acs.overflowY === 'clip')) {
            var ar = clipAnc.getBoundingClientRect();
            if (badgeR.bottom > ar.bottom + 3 || badgeR.top < ar.top - 3) {
              clipped = true;
              break;
            }
          }
          if (clipAnc === cardEl) break;
          clipAnc = clipAnc.parentElement;
          clipSteps++;
        }
        if (imgOk && sizeOk && posOk && !clipped) {
          return slot;
        }
        if (slot.parentNode && typeof slot.parentNode.removeChild === 'function') slot.parentNode.removeChild(slot);
      }
    }
    if (badge.classList && typeof badge.classList.add === 'function') {
      badge.classList.add('hb-photo-badge--overlay');
    } else if (String(badge.className || '').indexOf('hb-photo-badge--overlay') === -1) {
      badge.className = (badge.className ? badge.className + ' ' : '') + 'hb-photo-badge--overlay';
    }
    fallbackAnchor.appendChild(badge);
    return null;
  }

  function readCardInfo(cardEl) {
    if (!cardEl || cardEl.closest('header, nav, footer, [role="contentinfo"]')) return null;
    if (isCartDrawer(cardEl.closest('[role="dialog"], aside, section'))) return null;
    var sels = [
      'span.w_iUH7', '[class*="w_iUH7"]',
      '[data-automation-id*="product-title" i]', '[data-test="product-title"]', '[data-testid*="product-title" i]',
      '[data-testid*="item-title" i]', '[data-testid*="product-card-name" i]', '[data-qa*="product-name" i]',
      'h2 a span', 'h3 a span', 'h2', 'h3',
      'a[link-identifier]', 'a[href*="/sp/track"]', 'a[href*="/ip/"]', 'a[href*="/sams/shop/product/"]',
      'a[href*="/p/"]', 'a[href*="/dp/"]', 'a[href*="/gp/aw/d/"]', 'a[href*="/products/"]',
      'a[href*="/detail/ps/p/"]', 'a[href*="/product/"]'
    ];
    var title = extractBestCardTitle(cardEl, sels);
    var linkEl = cardEl.querySelector(PRODUCT_LINK_SEL) || cardEl.querySelector('a[href]');
    var hrefKey = linkEl ? String(linkEl.getAttribute('href') || '').split('#')[0].split('?')[0].slice(0, 140) : '';
    var imgs = cardEl.querySelectorAll('img');
    var chosenImg = null;
    for (var m = 0; m < imgs.length; m++) {
      var img = imgs[m];
      if (img.closest && img.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
      if (!title) {
        var altCand = clean(img.getAttribute('alt') || '');
        if (altCand && altCand.length >= 6 && altCand.length <= 240 && !NON_TITLE_RE.test(altCand) && !CARD_CTA_NOISE_RE.test(altCand) && !/^(?:product(?:\s+image)?|thumbnail|photo|image)$/i.test(altCand) && !/^\$\d/.test(altCand)) {
          title = altCand;
        }
      }
      var src = img.currentSrc || img.getAttribute('src') || img.getAttribute('srcset') || img.getAttribute('data-src') || '';
      if (isPlaceholderCardImg(img, src)) continue;
      var r = img.getBoundingClientRect();
      var pr = img.parentElement ? img.parentElement.getBoundingClientRect() : r;
      var ew = Math.max(r.width, pr.width);
      var eh = Math.max(r.height, pr.height);
      if (!chosenImg && ew >= 44 && eh >= 44 && ew <= 480 && eh <= 480) {
        chosenImg = img;
      }
    }
    if (!title) {
      var anyLinks = cardEl.querySelectorAll('a[href]');
      for (var al = 0; al < anyLinks.length; al++) {
        var aEl = anyLinks[al];
        if (aEl.closest && aEl.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
        var aCand = clean(aEl.getAttribute('aria-label') || aEl.textContent || '');
        if (aCand && aCand.length >= 6 && aCand.length <= 240 && !NON_TITLE_RE.test(aCand) && !CARD_CTA_NOISE_RE.test(aCand) && !/^\$\d/.test(aCand)) {
          title = aCand;
          break;
        }
      }
    }
    if (!title || !chosenImg || isNonFoodGridTitle(title)) return null;
    var anchor = findSafeCardAnchor(chosenImg, cardEl);
    if (!anchor) return null;
    var sig = title.toLowerCase() + '|' + hrefKey + '|' + detectInstacartSlug() + '|' + hbPrefRev;
    return { title: title, anchor: anchor, img: chosenImg, storeImageUrl: sanitizeStoreImgSrc(chosenImg), sig: sig };
  }

  function removeBadgeDom(badgeEl, slotEl) {
    var parentSlot = slotEl || (badgeEl && badgeEl.closest ? badgeEl.closest('.hb-photo-badge-slot') : null);
    if (badgeEl && badgeEl.parentNode) {
      badgeEl.parentNode.removeChild(badgeEl);
    }
    if (parentSlot && parentSlot.parentNode) {
      parentSlot.parentNode.removeChild(parentSlot);
    }
  }

  function removeCardBadgeState(cardEl, st) {
    if (!st) return;
    if (st.id && hbOwnerCardById[st.id] === cardEl) {
      delete hbOwnerCardById[st.id];
    }
    if (st.img && hbOwnerCardByImg && hbOwnerCardByImg.get(st.img) === cardEl) {
      hbOwnerCardByImg.delete(st.img);
    }
    removeBadgeDom(st.badgeEl, st.slotEl);
    st.badgeEl = null;
    st.slotEl = null;
  }

  var hbLastBatchSentAt = 0;
  function armBatchWatchdog() {
    if (hbBatchWatchdog) clearTimeout(hbBatchWatchdog);
    hbBatchWatchdog = setTimeout(function() {
      hbBatchWatchdog = null;
      if (hbInFlightBatches > 0 && (Date.now() - hbLastBatchSentAt >= 11000)) {
        hbInFlightBatches = 0;
        if (hbPendingQueue.length > 0 && !hbBatchTimer) {
          hbBatchTimer = setTimeout(flushHbBadgeBatch, 80);
        } else {
          scanPhotoBadges();
        }
      }
    }, 12000);
  }

  function flushHbBadgeBatch() {
    hbBatchTimer = null;
    if (!hbPendingQueue.length || isCartUrl()) {
      if (isCartUrl()) hbPendingQueue = [];
      return;
    }
    if (hbInFlightBatches >= MAX_IN_FLIGHT_BATCHES) {
      hbBatchTimer = setTimeout(flushHbBadgeBatch, 180);
      return;
    }
    var chunk = hbPendingQueue.splice(0, 8);
    if (hbPendingQueue.length > 0) {
      hbBatchTimer = setTimeout(flushHbBadgeBatch, 140);
    }
    var payloadItems = [];
    for (var i = 0; i < chunk.length; i++) {
      var entry = chunk[i];
      if (entry.badgeEl && entry.badgeEl.isConnected && entry.cardEl && entry.cardEl.isConnected) {
        var liveInfo = readCardInfo(entry.cardEl);
        if (liveInfo && liveInfo.sig === entry.sig) {
          payloadItems.push({ id: entry.id, productTitle: liveInfo.title, storeImageUrl: liveInfo.storeImageUrl || '' });
        } else {
          removeCardBadgeState(entry.cardEl, hbCardState ? hbCardState.get(entry.cardEl) : null);
          if (hbCardState) hbCardState.delete(entry.cardEl);
        }
      }
    }
    if (!payloadItems.length) {
      if (hbPendingQueue.length > 0 && !hbBatchTimer) {
        hbBatchTimer = setTimeout(flushHbBadgeBatch, 80);
      }
      return;
    }
    hbInFlightBatches++;
    hbLastBatchSentAt = Date.now();
    armBatchWatchdog();
    postBridge({
      kind: 'gridBatch',
      pageToken: hbPageToken,
      items: payloadItems,
      instacartSlug: detectInstacartSlug()
    });
  }

  function applyResolvedBadgeAppearance(badge, title, entry) {
    var sc = Math.max(0, Math.min(100, Math.round(Number(entry.score || 0))));
    var hasAlert = Boolean(entry.hasAlert);
    var severity = String(entry.alertSeverity || (hasAlert ? 'advisory' : 'none'));
    var scoreTone = sc >= 75 ? 'green' : (sc >= 50 ? 'yellow' : 'red');
    var tone = severity === 'allergen' ? 'red' : scoreTone;
    var extraCls = (hasAlert && severity !== 'allergen') ? ' hb-photo-badge--advisory' : '';
    var overlayCls = (badge.classList && badge.classList.contains('hb-photo-badge--overlay')) ? ' hb-photo-badge--overlay' : '';
    badge.className = 'hb-photo-badge hb-photo-badge--' + tone + extraCls + overlayCls;
    setHbBadgeContent(badge, hasAlert ? '⚠️' : '🥦', String(sc));
    badge.setAttribute('aria-label', 'HeyBroc score ' + sc + ' out of 100' + (title ? ' for ' + title : ''));
  }

  function processVisibleCard(cardEl) {
    if (!cardEl || !cardEl.isConnected || isCartUrl()) return false;
    var info = readCardInfo(cardEl);
    if (!info || !info.anchor) return false;
    if (hbOwnerCardByImg && info.img) {
      var existingOwner = hbOwnerCardByImg.get(info.img);
      if (existingOwner && existingOwner !== cardEl && existingOwner.isConnected) {
        return true;
      }
      hbOwnerCardByImg.set(info.img, cardEl);
    }
    var prev = hbCardState ? hbCardState.get(cardEl) : null;
    var now = Date.now();
    if (prev && prev.sig === info.sig) {
      if (prev.suppressedEstimate) return true;
      if (prev.retryAfter && now < prev.retryAfter) {
        scheduleHbRetry((prev.retryAfter - now) + 80);
        return false;
      }
      if (prev.badgeEl && prev.badgeEl.isConnected) return true;
    } else if (prev) {
      removeCardBadgeState(cardEl, prev);
    }
    var staleNodes = cardEl.querySelectorAll('.hb-photo-badge-slot, .hb-photo-badge');
    for (var sb = 0; sb < staleNodes.length; sb++) {
      if (staleNodes[sb].parentNode) staleNodes[sb].parentNode.removeChild(staleNodes[sb]);
    }
    var cachedHit = hbTitleScoreCache[makeTitleScoreKey(info.title)];
    if (cachedHit && cachedHit.suppressedEstimate) {
      if (hbCardState) {
        hbCardState.set(cardEl, {
          id: '',
          sig: info.sig,
          title: info.title,
          anchor: info.anchor,
          img: info.img,
          badgeEl: null,
          slotEl: null,
          resolved: true,
          suppressedEstimate: true,
          retryCount: 0,
          retryAfter: 0,
          openOnResolve: false
        });
      }
      return true;
    }
    ensureHbBadgeStyles();
    var cardId = hbPageToken + '_' + (hbCardSeq++);
    var b = document.createElement('span');
    b.setAttribute('role', 'button');
    b.setAttribute('tabindex', '0');
    b.setAttribute('data-hb-card-id', cardId);
    b.setAttribute('data-hb-sig', info.sig);
    if (cachedHit && cachedHit.ok) {
      applyResolvedBadgeAppearance(b, info.title, cachedHit);
      var cachedSlot = mountBadgeUnderOrOnPhoto(info.img, cardEl, b, info.anchor);
      if (hbCardState) {
        hbCardState.set(cardEl, {
          id: cardId,
          sig: info.sig,
          title: info.title,
          anchor: info.anchor,
          img: info.img,
          badgeEl: b,
          slotEl: cachedSlot,
          resolved: true,
          suppressedEstimate: false,
          retryCount: 0,
          retryAfter: 0,
          openOnResolve: false
        });
      }
      hbOwnerCardById[cardId] = cardEl;
      return true;
    }
    b.className = 'hb-photo-badge hb-photo-badge--loading';
    b.setAttribute('aria-label', 'Checking HeyBroc score for ' + info.title);
    setHbBadgeContent(b, '🥦', '…');
    var slotEl = mountBadgeUnderOrOnPhoto(info.img, cardEl, b, info.anchor);
    var nextState = {
      id: cardId,
      sig: info.sig,
      title: info.title,
      anchor: info.anchor,
      img: info.img,
      badgeEl: b,
      slotEl: slotEl,
      resolved: false,
      suppressedEstimate: false,
      retryCount: (prev && prev.sig === info.sig) ? (prev.retryCount || 0) : 0,
      retryAfter: 0,
      openOnResolve: false
    };
    if (hbCardState) hbCardState.set(cardEl, nextState);
    hbOwnerCardById[cardId] = cardEl;
    hbPendingQueue.push({ id: cardId, title: info.title, sig: info.sig, badgeEl: b, cardEl: cardEl });
    if (!hbBatchTimer) {
      hbBatchTimer = setTimeout(flushHbBadgeBatch, 110);
    }
    return true;
  }

  function clearHbBadges() {
    if (hbBatchTimer) { clearTimeout(hbBatchTimer); hbBatchTimer = null; }
    if (hbBatchWatchdog) { clearTimeout(hbBatchWatchdog); hbBatchWatchdog = null; }
    if (hbRetryTimer) { clearTimeout(hbRetryTimer); hbRetryTimer = null; }
    hbRetryAt = 0;
    hbPendingQueue = [];
    hbInFlightBatches = 0;
    hbPageToken = makePageToken();
    hbOwnerCardById = {};
    hbOwnerCardByImg = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
    if (hbIntersectionObs) { hbIntersectionObs.disconnect(); hbIntersectionObs = null; }
    hbCardState = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
    var oldSlots = document.querySelectorAll('.hb-photo-badge-slot, .hb-photo-badge');
    for (var i = 0; i < oldSlots.length; i++) {
      if (oldSlots[i].parentNode) oldSlots[i].parentNode.removeChild(oldSlots[i]);
    }
  }

  function nodeContains(anc, desc) {
    if (!anc || !desc) return false;
    if (typeof anc.contains === 'function') return anc.contains(desc);
    for (var c = desc; c; c = c.parentElement) {
      if (c === anc) return true;
    }
    return false;
  }

  function scanPhotoBadges() {
    if (location.href !== hbLastBadgeUrl) {
      hbLastBadgeUrl = location.href;
      clearHbBadges();
    }
    if (isCartUrl()) {
      clearHbBadges();
      return;
    }
    if (!hbIntersectionObs && typeof IntersectionObserver !== 'undefined') {
      hbIntersectionObs = new IntersectionObserver(function(entries) {
        for (var i = 0; i < entries.length; i++) {
          if (!entries[i].isIntersecting) continue;
          if (processVisibleCard(entries[i].target)) {
            hbIntersectionObs.unobserve(entries[i].target);
          }
        }
      }, { rootMargin: '220px 0px' });
    }
    var onPdp = Boolean(findOpenProductModal()) || looksLikeProductUrl(location.href);
    var maxCardW = onPdp ? 360 : Math.max(580, (window.innerWidth || 412) + 32);
    var vh = Math.max(400, window.innerHeight || 800);
    var seen = [];
    function addCand(el) {
      if (!el || seen.indexOf(el) !== -1 || el.closest('header, nav, footer, [role="contentinfo"]')) return;
      if (el.querySelectorAll && el.querySelectorAll(MULTI_CARD_UNIT_SEL).length > 1) return;
      for (var ex = 0; ex < seen.length; ex++) {
        if (nodeContains(seen[ex], el) || nodeContains(el, seen[ex])) return;
      }
      var r = el.getBoundingClientRect();
      if (r.width > 0 && (r.width < 84 || r.width > maxCardW || r.height < 84 || r.height > 760)) return;
      seen.push(el);
    }
    var direct = document.querySelectorAll(CARD_SEL);
    for (var d = 0; d < direct.length; d++) addCand(direct[d]);
    if (!onPdp) {
      var links = document.querySelectorAll(PRODUCT_LINK_SEL);
      for (var l = 0; l < links.length; l++) {
        var a = links[l];
        if (a.closest(CARD_SEL) || a.closest('header, nav, footer, [role="contentinfo"]')) continue;
        var cur = a;
        var tile = null;
        for (var depth = 0; depth < 5 && cur && cur !== document.body; depth++) {
          if (cur.querySelector('img')) {
            var cr = cur.getBoundingClientRect();
            if (cr.width >= 90 && cr.width <= maxCardW && cr.height >= 90 && cr.height <= 720) {
              tile = cur;
              if (/^(ARTICLE|LI)$/i.test(cur.tagName)) break;
            }
          }
          cur = cur.parentElement;
        }
        if (tile) addCand(tile);
      }
    }
    var now = Date.now();
    var minRemainingRetryMs = 0;
    for (var c = 0; c < seen.length; c++) {
      var card = seen[c];
      var st = hbCardState ? hbCardState.get(card) : null;
      if (st) {
        var curInfo = readCardInfo(card);
        if (!curInfo) {
          removeCardBadgeState(card, st);
          hbCardState.delete(card);
          continue;
        }
        if (curInfo.sig !== st.sig) {
          removeCardBadgeState(card, st);
          hbCardState.delete(card);
          st = null;
        } else if (st.suppressedEstimate) {
          continue;
        } else if (st.badgeEl && st.badgeEl.isConnected) {
          continue;
        } else if (st.retryAfter && now < st.retryAfter) {
          var remMs = st.retryAfter - now;
          if (!minRemainingRetryMs || remMs < minRemainingRetryMs) minRemainingRetryMs = remMs;
          continue;
        }
      }
      var cardRect = card.getBoundingClientRect();
      var inNearViewport = cardRect.height > 0 && cardRect.bottom >= -140 && cardRect.top <= vh + 180;
      if (inNearViewport && processVisibleCard(card)) {
        if (hbIntersectionObs) hbIntersectionObs.unobserve(card);
      } else if (hbIntersectionObs) {
        hbIntersectionObs.observe(card);
      } else {
        processVisibleCard(card);
      }
    }
    if (minRemainingRetryMs > 0) {
      scheduleHbRetry(minRemainingRetryMs + 80);
    }
  }

  window.__heybrocApplyCardBadges = function(badgeMap, respToken) {
    if (respToken && respToken !== hbPageToken) return;
    hbInFlightBatches = Math.max(0, hbInFlightBatches - 1);
    if (hbInFlightBatches === 0 && hbBatchWatchdog) {
      clearTimeout(hbBatchWatchdog);
      hbBatchWatchdog = null;
    }
    if (hbPendingQueue.length > 0 && !hbBatchTimer) {
      hbBatchTimer = setTimeout(flushHbBadgeBatch, 80);
    }
    if (!badgeMap || typeof badgeMap !== 'object') return;
    var earliestRetryMs = 0;
    for (var id in badgeMap) {
      if (!Object.prototype.hasOwnProperty.call(badgeMap, id)) continue;
      var ownerCard = hbOwnerCardById[id] || null;
      var st = (ownerCard && hbCardState) ? hbCardState.get(ownerCard) : null;
      var badge = (st && st.badgeEl) ? st.badgeEl : document.querySelector('.hb-photo-badge[data-hb-card-id="' + id.replace(/[^A-Za-z0-9_-]/g, '') + '"]');
      if (!badge) continue;

      if (ownerCard && ownerCard.isConnected) {
        var liveCheck = readCardInfo(ownerCard);
        if (!liveCheck || (st && liveCheck.sig !== st.sig)) {
          removeCardBadgeState(ownerCard, st);
          if (hbCardState) hbCardState.delete(ownerCard);
          scanPhotoBadges();
          continue;
        }
      }

      var entry = badgeMap[id];
      if (!entry || !entry.ok) {
        removeBadgeDom(badge, st ? st.slotEl : null);
        if (st) {
          st.badgeEl = null;
          st.slotEl = null;
          var shouldOpenFailed = Boolean(st.openOnResolve);
          st.openOnResolve = false;
          if (entry && entry.transient && (st.retryCount || 0) < 2) {
            st.retryCount = (st.retryCount || 0) + 1;
            var delay = st.retryCount === 1 ? 2200 : 5000;
            st.retryAfter = Date.now() + delay;
            if (!earliestRetryMs || delay < earliestRetryMs) earliestRetryMs = delay;
          } else {
            st.suppressedEstimate = true;
            if (st.title) cacheTitleBadgeScore(st.title, { suppressedEstimate: true });
          }
          if (shouldOpenFailed && st.title) {
            postBridge({
              kind: 'inspectCard',
              cardId: '',
              title: st.title,
              storeImageUrl: st.img ? sanitizeStoreImgSrc(st.img) : '',
              instacartSlug: detectInstacartSlug()
            });
          }
        }
        continue;
      }

      if (entry.isCategoryEstimate) {
        removeBadgeDom(badge, st ? st.slotEl : null);
        if (st) {
          st.badgeEl = null;
          st.slotEl = null;
          st.suppressedEstimate = true;
          if (st.title) cacheTitleBadgeScore(st.title, { suppressedEstimate: true });
          if (st.openOnResolve && st.title) {
            st.openOnResolve = false;
            postBridge({
              kind: 'inspectCard',
              cardId: '',
              title: st.title,
              storeImageUrl: st.img ? sanitizeStoreImgSrc(st.img) : '',
              instacartSlug: detectInstacartSlug()
            });
          }
        }
        continue;
      }

      var labelTitle = st ? st.title : '';
      applyResolvedBadgeAppearance(badge, labelTitle, entry);
      if (labelTitle) {
        cacheTitleBadgeScore(labelTitle, {
          ok: true,
          score: entry.score,
          hasAlert: entry.hasAlert,
          alertSeverity: entry.alertSeverity
        });
      }
      if (st) {
        st.resolved = true;
        if (st.openOnResolve) {
          st.openOnResolve = false;
          postBridge({
            kind: 'inspectCard',
            cardId: id,
            title: st.title,
            storeImageUrl: st.img ? sanitizeStoreImgSrc(st.img) : '',
            instacartSlug: detectInstacartSlug()
          });
        }
      }
    }
    if (earliestRetryMs > 0) {
      scheduleHbRetry(earliestRetryMs + 80);
    }
  };

  window.__heybrocGetVisibleCardIds = function() {
    var out = [];
    var vh = Math.max(400, window.innerHeight || 800);
    var vw = Math.max(280, window.innerWidth || 412);
    var badges = document.querySelectorAll('.hb-photo-badge:not(.hb-photo-badge--loading)');
    for (var i = 0; i < badges.length; i++) {
      var b = badges[i];
      if (!b || !b.isConnected) continue;
      var cid = b.getAttribute('data-hb-card-id') || '';
      if (!cid) continue;
      var owner = hbOwnerCardById[cid] || (b.closest ? b.closest(CARD_SEL) : null);
      var targetEl = (owner && owner.isConnected) ? owner : b;
      var r = targetEl.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.bottom > 24 && r.top < vh - 16 && r.right > 0 && r.left < vw) {
        if (out.indexOf(cid) === -1) out.push(cid);
      }
    }
    return JSON.stringify(out);
  };

  window.__heybrocRefreshPhotoBadges = function() {
    hbPrefRev++;
    hbTitleScoreCache = {};
    hbTitleScoreKeys = [];
    clearHbBadges();
    scanPhotoBadges();
  };

  function activateHbPhotoBadge(badge, e) {
    if (!badge) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    var cardId = badge.getAttribute('data-hb-card-id') || '';
    var badgeSig = badge.getAttribute('data-hb-sig') || '';
    var ownerCard = (cardId && hbOwnerCardById[cardId]) ? hbOwnerCardById[cardId] : (badge.closest ? badge.closest(CARD_SEL) : null);
    var st = (ownerCard && hbCardState) ? hbCardState.get(ownerCard) : null;
    var liveInfo = ownerCard ? readCardInfo(ownerCard) : null;
    if (ownerCard && liveInfo && badgeSig && liveInfo.sig !== badgeSig) {
      if (st) removeCardBadgeState(ownerCard, st);
      if (hbCardState) hbCardState.delete(ownerCard);
      processVisibleCard(ownerCard);
      postBridge({
        kind: 'inspectCard',
        cardId: '',
        title: liveInfo.title,
        storeImageUrl: liveInfo.storeImageUrl || '',
        instacartSlug: detectInstacartSlug()
      });
      return;
    }
    var liveTitle = (liveInfo && liveInfo.title) ? liveInfo.title : (st ? st.title : '');
    var liveStoreImg = (liveInfo && liveInfo.storeImageUrl) ? liveInfo.storeImageUrl : (st && st.img ? sanitizeStoreImgSrc(st.img) : '');
    if (st && !st.resolved && liveTitle) {
      st.openOnResolve = false;
      postBridge({
        kind: 'inspectCard',
        cardId: '',
        title: liveTitle,
        storeImageUrl: liveStoreImg,
        instacartSlug: detectInstacartSlug()
      });
      return;
    }
    postBridge({
      kind: 'inspectCard',
      cardId: cardId,
      title: liveTitle,
      storeImageUrl: liveStoreImg,
      instacartSlug: detectInstacartSlug()
    });
  }

  document.addEventListener('pointerdown', function(e) {
    if (e.target && e.target.closest && e.target.closest('.hb-photo-badge')) {
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }, true);

  document.addEventListener('click', function(e) {
    var badge = e.target && e.target.closest ? e.target.closest('.hb-photo-badge') : null;
    if (!badge) return;
    activateHbPhotoBadge(badge, e);
  }, true);

  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var badge = e.target && e.target.closest ? e.target.closest('.hb-photo-badge') : null;
    if (!badge) return;
    activateHbPhotoBadge(badge, e);
  }, true);

  function isHbBadgeNode(n) {
    if (!n) return false;
    var el = n.nodeType === 1 ? n : n.parentElement;
    if (!el) return false;
    return (
      el.id === 'hb-photo-badge-styles' ||
      el.id === 'hb-app-banner-suppressor' ||
      (el.getAttribute && el.getAttribute('data-hb-app-banner-hidden') === '1') ||
      (el.classList && (el.classList.contains('hb-photo-badge') || el.classList.contains('hb-photo-badge-slot'))) ||
      Boolean(el.closest && (el.closest('.hb-photo-badge') || el.closest('.hb-photo-badge-slot') || el.closest('[data-hb-app-banner-hidden="1"]')))
    );
  }

  function isHbBadgeMutation(m) {
    if (isHbBadgeNode(m.target)) return true;
    if (m.type === 'childList') {
      var added = m.addedNodes ? Array.prototype.slice.call(m.addedNodes) : [];
      var removed = m.removedNodes ? Array.prototype.slice.call(m.removedNodes) : [];
      if ((added.length > 0 || removed.length > 0) && added.every(isHbBadgeNode) && removed.every(isHbBadgeNode)) {
        return true;
      }
    }
    return false;
  }

  function extractProductData() {
    dismissRetailerAppBanners();
    scanPhotoBadges();
    var url = location.href;
    var instacartSlug = detectInstacartSlug();
    var modal = findOpenProductModal();
    var isPdp = Boolean(modal) || looksLikeProductUrl(url);

    if (!isPdp) {
      var aligned = findAlignedSearchCard();
      if (aligned.title) {
        postBridge({
          kind: 'card',
          title: aligned.title.slice(0, 260),
          storeImageUrl: aligned.storeImageUrl || '',
          ingredients: '',
          barcode: '',
          instacartSlug: instacartSlug,
          url: url
        });
      } else {
        postBridge({ kind: 'browse', url: url, instacartSlug: instacartSlug });
      }
      return;
    }

    var title = readHeroTitle(modal);
    var barcode = '';
    var nextDataIngredients = '';
    if (!modal && looksLikeProductUrl(url)) {
      var scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (var i = 0; i < scripts.length; i++) {
        try {
          var raw = JSON.parse(scripts[i].textContent || '{}');
          var queue = Array.isArray(raw) ? raw.slice() : [raw];
          while (queue.length) {
            var node = queue.shift();
            if (!node || typeof node !== 'object') continue;
            if (Array.isArray(node['@graph'])) queue = queue.concat(node['@graph']);
            var t = String(node['@type'] || '');
            if (/product/i.test(t) && node.name) {
              var ldName = clean(String(node.name));
              var ldCode = clean(String(node.gtin13 || node.gtin12 || node.gtin14 || node.gtin8 || node.gtin || node.upc || '')).replace(/\D/g, '');
              if (ldCode && !/^\d{8,14}$/.test(ldCode)) ldCode = '';
              if (ldCode.length === 14 && ldCode.indexOf('00') === 0) ldCode = ldCode.slice(2);
              else if (ldCode.length === 14 && ldCode.indexOf('0') === 0) ldCode = ldCode.slice(1);
              if (!title && ldName && !NON_TITLE_RE.test(ldName)) {
                title = ldName;
                barcode = ldCode;
              } else if (title && !barcode && ldCode && titlesShareTokens(title, ldName)) {
                barcode = ldCode;
              }
            }
          }
        } catch (e) {}
      }
      if (String(location.hostname || '').toLowerCase().indexOf('walmart.') !== -1) {
        try {
          var ndEl = document.getElementById('__NEXT_DATA__');
          if (ndEl && ndEl.textContent) {
            var nd = JSON.parse(ndEl.textContent);
            var wmData = nd && nd.props && nd.props.pageProps && nd.props.pageProps.initialData && nd.props.pageProps.initialData.data;
            var wmProd = wmData && wmData.product;
            var wmName = wmProd && wmProd.name ? clean(String(wmProd.name)) : '';
            var wmMatches = (!title && wmName && !NON_TITLE_RE.test(wmName)) || (title && wmName && titlesShareTokens(title, wmName));
            if (wmMatches) {
              if (!title && wmName) title = wmName;
              if (!barcode && wmProd) {
                var wmCode = clean(String(wmProd.upc || wmProd.gtin13 || '')).replace(/\D/g, '');
                if (/^\d{8,14}$/.test(wmCode)) {
                  if (wmCode.length === 14 && wmCode.indexOf('00') === 0) wmCode = wmCode.slice(2);
                  else if (wmCode.length === 14 && wmCode.indexOf('0') === 0) wmCode = wmCode.slice(1);
                  barcode = wmCode;
                }
              }
              var wmIngObj = wmData && wmData.idml && wmData.idml.ingredients && wmData.idml.ingredients.ingredients;
              var wmIngVal = wmIngObj && wmIngObj.value ? clean(String(wmIngObj.value)) : '';
              if (wmIngVal && wmIngVal.length >= 12 && !/^none$/i.test(wmIngVal)) {
                nextDataIngredients = wmIngVal;
              }
            }
          }
        } catch (e) {}
      }
      if (!title) {
        var og = document.querySelector('meta[property="og:title"]');
        if (og && og.content) {
          var ogClean = clean(og.content.replace(/\s*[-|:]\s*(Walmart|Target|Instacart|Amazon|Whole Foods Market|Costco|Sam's Club|Kroger|ALDI|BJ's|DoorDash|Uber Eats|Shipt).*$/i, ''));
          if (ogClean && !NON_TITLE_RE.test(ogClean)) title = ogClean;
        }
      }
    }

    var ingredients = title ? (readIngredientsFromScope(modal) || nextDataIngredients) : '';
    var heroImageUrl = title ? readHeroImageUrl(modal) : '';
    if (title && title.length >= 4 && !NON_TITLE_RE.test(title)) {
      postBridge({
        kind: 'product',
        title: title.slice(0, 260),
        storeImageUrl: heroImageUrl,
        ingredients: ingredients.slice(0, 2500),
        barcode: barcode,
        instacartSlug: instacartSlug,
        url: url
      });
    } else {
      postBridge({ kind: 'browse', url: url, instacartSlug: instacartSlug });
    }
  }

  var timer = null;
  var settleTimer = null;
  var scrollTimer = null;
  function scheduleCheck(withSettle) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(extractProductData, 240);
    if (withSettle) {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(extractProductData, 900);
    }
  }
  window.__heybrocScheduleCheck = scheduleCheck;

  document.addEventListener('scroll', function() {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(extractProductData, 200);
  }, { capture: true, passive: true });

  document.addEventListener('load', function(e) {
    var t = e && e.target;
    if (t && t.tagName === 'IMG') {
      scheduleCheck(false);
    }
  }, true);

  window.addEventListener('popstate', function() { scheduleCheck(true); });
  window.addEventListener('hashchange', function() { scheduleCheck(true); });
  var origPush = history.pushState;
  history.pushState = function() {
    var r = origPush.apply(this, arguments);
    scheduleCheck(true);
    return r;
  };
  var origReplace = history.replaceState;
  history.replaceState = function() {
    var r = origReplace.apply(this, arguments);
    scheduleCheck(true);
    return r;
  };

  var obs = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      if (!isHbBadgeMutation(mutations[i])) {
        scheduleCheck(false);
        return;
      }
    }
  });
  if (document.documentElement) {
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'data-src', 'href']
    });
  }

  if (typeof setInterval === 'function') {
    setInterval(function() {
      if (!document.hidden) {
        scanPhotoBadges();
      }
    }, 1800);
  }

  dismissRetailerAppBanners();
  scheduleCheck(true);
})();
