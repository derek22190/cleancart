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

  var NON_TITLE_RE = /^(search|your cart|shopping cart|cart|bag|basket|checkout|review order|order summary|items to add next|product information|similar items|customers also.*|sponsored.*|product|item|ad|advertisement|buy (?:it )?again|frequently bought together|saved for later|walmart|target|costco(?:\s+wholesale)?|sam'?s\s+club|aldi|kroger|instacart|whole\s+foods(?:\s+market)?|amazon(?:\s+fresh)?|bj'?s(?:\s+wholesale\s+club)?|doordash|dashmart|uber\s*eats|shipt|sign\s*in|log\s*in|continue\s+as\s+guest|departments|grocery|new\s+grocery|deals|top\s+deals|instant\s+savings|rollbacks?|clearance|weekly\s+ad|produce|fresh\s+produce|fruits?\s*&\s*vegetables?|meat|seafood|meat\s*&\s*seafood|dairy|dairy\s*&\s*eggs|bakery(?:\s*&\s*bread)?|deli|frozen(?:\s+foods?)?|pantry|snacks|beverages|breakfast|condiments|candy|baking(?:\s+supplies)?|canned\s+goods|household|personal\s+care|all\s+products|shop\s+all|shop\s+by\s+.*|featured(?:\s+categories|\s+items|\s+deals)?)$/i;
  var EXCLUDED_CONTAINER_SEL = '[data-testid*="carousel" i], [class*="carousel" i], [aria-label*="Sponsored" i], [data-testid*="sponsored" i], [data-testid*="similar" i], [data-testid*="related" i], [data-testid*="upsell" i], [data-testid*="recommend" i], #sc-saved-cart';
  var EXCLUDED_HEADING_RE = /\b(customers\s+also\s+(?:viewed|bought|shopped|considered)|similar\s+items?|sponsored(?:\s+products?|\s+items?)?|buy\s+(?:it\s+)?again|frequently\s+bought\s+together|items?\s+to\s+add\s+next|recommended(?:\s+for\s+you)?|you\s+may\s+also\s+like|related\s+(?:products?|items?)|more\s+to\s+consider|saved\s+for\s+later)\b/i;

  function clean(s) {
    return String(s || '')
      .replace(/\s+/g, ' ')
      .replace(/^(?:sponsored(?:\s+ad)?|ad(?=\s*[-–—:|•])|best\s+seller|overall\s+pick|popular\s+pick|rollback)\s*[,•|:\-–—]?\s*/i, '')
      .replace(/\s*\(\d+(?:\.\d+)?\s*stars?.*$/i, '')
      .trim();
  }

  function isVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    var st = window.getComputedStyle(el);
    if (!st || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0' || (st.opacity !== '' && parseFloat(st.opacity) === 0)) return false;
    var r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  var APP_INSTALL_CTA_RE = /^(?:get\s+(?:the\s+)?app|open\s+in\s+(?:the\s+)?(?:walmart\s+|target\s+|instacart\s+|sam'?s\s+club\s+|bj'?s\s+|kroger\s+|amazon\s+|aldi\s+|costco\s+|doordash\s+|uber\s*eats\s+|shipt\s+)?app|open\s+in\s+(?:doordash|uber\s*eats|instacart|walmart|target|shipt|kroger|costco|aldi)|open\s+app|use\s+(?:the\s+)?app|download\s+(?:the\s+)?app|install\s+(?:the\s+)?app|continue\s+in\s+(?:the\s+)?app|shop\s+in\s+(?:the\s+)?app|view\s+in\s+(?:the\s+)?app|switch\s+to\s+(?:the\s+)?app)$/i;
  var APP_GENERIC_OPEN_CTA_RE = /^(?:open|get|install|download|view|use\s+app)$/i;
  var APP_UPSELL_BANNER_RE = /\b(?:browse|shop|order|get\s+it|checkout)\s+(?:faster|easier)\s+in\s+(?:the\s+)?app\b|\b(?:better|more\s+to\s+love)\s+in\s+(?:the\s+)?app\b|\bopen\s+(?:in\s+)?(?:the\s+)?(?:doordash|uber\s*eats|walmart|target|instacart|costco|kroger|shipt|aldi|sam'?s(?:\s+club)?|bj'?s|amazon|whole\s+foods)?\s*app\b|\bopen\s+in\s+(?:doordash|uber\s*eats|instacart|walmart|target|shipt|kroger|costco|aldi)\b|\bget\s+the\s+(?:doordash|uber\s*eats|walmart|target|instacart|costco|kroger|shipt|aldi|sam'?s(?:\s+club)?|bj'?s|amazon|whole\s+foods)?\s*(?:free\s+)?app\b|\bdownload\s+the\s+(?:doordash|uber\s*eats|walmart|target|instacart|costco|kroger|shipt|aldi|sam'?s(?:\s+club)?|bj'?s|amazon|whole\s+foods)?\s*(?:free\s+)?app\b|\buse\s+the\s+(?:doordash|uber\s*eats|walmart|target|instacart|costco|kroger|shipt|aldi|sam'?s(?:\s+club)?|bj'?s|amazon|whole\s+foods)?\s*app\b|\b(?:continue|shop|order|switch\s+to|view)\s+in\s+(?:the\s+)?(?:doordash|uber\s*eats|walmart|target|instacart|costco|kroger|shipt|aldi|sam'?s(?:\s+club)?|bj'?s|amazon|whole\s+foods)?\s*app\b|\bexperience\s+(?:is\s+better\s+in\s+)?(?:the\s+)?(?:full\s+)?app\b|\b(?:app\s+store|google\s+play)\b.*\bapp\b/i;
  var APP_RATINGS_WITH_APP_RE = /\b\d+(?:\.\d+)?[mk]\+?\s+ratings?\b/i;
  var APP_INSTALL_HREF_RE = /play\.google\.com|market\.android\.com|(?:apps|itunes)\.apple\.com|\.onelink\.me|\bonelink\.me\b|\.app\.link|\bapp\.link\b|\bbnc\.lt\b|\bdrdsh\.me\b|\binst\.cr\b|\bt\.uber\.com\b|\bget\.uber\.com\b|app\.adjust\.com|\.adj\.st|\.branch\.io|\.smart\.link|\/(?:download|get-?the-?app|mobile-?app|cp\/walmart-app|c\/target-app)(?:\/|\?|$)|^(?:intent|market|doordash|ubereats|walmart|target|instacart|costco|kroger|shipt|samsclub|aldi|bjs|amzn|wholefoods):\/\//i;
  var APP_BANNER_IFRAME_RE = /branch|smart[-_]?banner|app[-_]?banner|onelink|app\.link|adj\.st|download[-_]?app|open[-_]?in[-_]?app/i;
  var SENSITIVE_BANNER_PATH_RE = /\/(?:cart|bag|basket|checkout|gp\/cart|store\/cart|shop\/cart|login|signin|sign-in|account|auth|register)(?:\/|$)/i;
  var BANNER_FORBIDDEN_TEXT_RE = /\$\s*\d|\b(?:cart|bag|basket|checkout|subtotal|total|pickup|delivery|shipping|address|zip\s*code|sign\s*in|log\s*in|login|account|password|verification|filter|sort|search\s+results)\b/i;
  var APP_BANNER_STRICT_FORBIDDEN_RE = /\b(?:view\s+cart|your\s+cart|shopping\s+cart|cart|bag|basket|checkout|subtotal|sign\s*in|log\s*in|login|create\s+account|account|password|verification|search\s+results|enter\s+(?:your\s+)?(?:delivery\s+)?address|change\s+address|your\s+addr|zip\s*code)\b/i;
  var hbBannerLastHref = location.href;
  var hbBannerLastScanAt = 0;

  function hideBannerNode(el) {
    if (!el || el.getAttribute('data-hb-app-banner-hidden') === '1') return;
    el.setAttribute('data-hb-app-banner-hidden', '1');
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('visibility', 'hidden', 'important');
    el.style.setProperty('height', '0', 'important');
    el.style.setProperty('min-height', '0', 'important');
    el.style.setProperty('margin', '0', 'important');
    el.style.setProperty('padding', '0', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
  }

  function hideBannerWithSpacer(el, vw) {
    if (!el || el.getAttribute('data-hb-app-banner-hidden') === '1') return;
    var rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    var siblings = [el.previousElementSibling, el.nextElementSibling];
    hideBannerNode(el);
    if (rect && rect.top <= 180) {
      for (var s = 0; s < siblings.length; s++) {
        var sib = siblings[s];
        if (!sib || sib.getAttribute('data-hb-app-banner-hidden') === '1') continue;
        if ((sib.tagName || '').toUpperCase() !== 'DIV') continue;
        if (clean(sib.textContent || '').length > 0) continue;
        if (sib.querySelector && sib.querySelector('img, svg, a, button, input, form, nav, header, iframe')) continue;
        var sr = typeof sib.getBoundingClientRect === 'function' ? sib.getBoundingClientRect() : null;
        if (sr && sr.height >= 34 && sr.height <= 180 && sr.width >= vw * 0.60 && sr.top <= 200) {
          hideBannerNode(sib);
        }
      }
    }
  }

  function clickSafeBannerDismissButton(container, excludeEl) {
    if (!container || !container.querySelectorAll) return false;
    var btns = container.querySelectorAll('button, a, [role="button"]');
    for (var b = 0; b < btns.length; b++) {
      var btn = btns[b];
      if (!btn || btn === excludeEl) continue;
      var bHref = String((btn.getAttribute && btn.getAttribute('href')) || '');
      if (bHref && APP_INSTALL_HREF_RE.test(bHref)) continue;
      var aria = clean(String((btn.getAttribute && (btn.getAttribute('aria-label') || btn.getAttribute('title'))) || ''));
      var bTxt = clean(btn.textContent || '');
      var safeAriaClose = /^(?:close|dismiss)(?:\s+(?:app\s+)?(?:banner|prompt|bar|modal|sheet|dialog))?$/i.test(aria) && !/cart|drawer|menu|address|search|filter|nav/i.test(aria);
      var safeTextClose = /^(?:[×✕✖x]|not\s+now|no\s+thanks|maybe\s+later|stay\s+on\s+web|continue\s+(?:on|in)\s+(?:mobile\s+)?(?:web|browser))$/i.test(bTxt);
      if (safeAriaClose || safeTextClose) {
        try { btn.click(); } catch (e) {}
        return true;
      }
    }
    return false;
  }

  function ensureAppBannerSuppressorStyles() {
    var metaApple = document.querySelector('meta[name="apple-itunes-app"]');
    if (metaApple && metaApple.parentNode) metaApple.parentNode.removeChild(metaApple);
    var metaPlay = document.querySelector('meta[name="google-play-app"]');
    if (metaPlay && metaPlay.parentNode) metaPlay.parentNode.removeChild(metaPlay);
    var head = document.head || document.documentElement;
    if (!head) return;
    if (!document.getElementById('hb-app-banner-suppressor')) {
      var st = document.createElement('style');
      st.id = 'hb-app-banner-suppressor';
      st.textContent = '#branch-banner-iframe, .branch-journeys-top, [id^="branch-banner"], [class*="branch-animation"], .smartbanner, [id*="smartbanner" i], smart-banner, [class*="SmartBanner" i], [class*="smart-banner" i], [class*="AppBanner" i], [class*="app-banner" i], [class*="DownloadAppBanner" i], [data-testid="smart-banner"], [data-testid="app-banner"], [data-testid="download-app-banner"], [data-testid*="SmartAppBanner" i], [data-testid*="app-download" i], [data-testid*="AppDownload" i], [data-testid*="app-upsell" i], [data-testid*="open-in-app" i], [data-testid*="open-app" i], [data-anchor-id*="AppBanner" i], [data-anchor-id*="SmartBanner" i], [data-anchor-id*="DownloadApp" i], [data-anchor-id*="OpenApp" i], [aria-label="Open App" i], [aria-label="Open in app" i], [aria-label="Get the app" i], [aria-label*="Browse faster in the app" i], [aria-label*="Download the app" i], [data-automation-id="app-banner"], [data-automation-id="smart-banner"], [data-test="smartBanner"], [data-test="appBanner"], [data-hb-app-banner-hidden="1"] { display: none !important; visibility: hidden !important; height: 0 !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; pointer-events: none !important; overflow: hidden !important; } body.branch-banner-is-active, html.branch-banner-is-active { margin-top: 0 !important; padding-top: 0 !important; }';
      head.appendChild(st);
    }
    if (/(?:^|\.)samsclub\.com$/i.test(location.hostname || '') && !document.getElementById('hb-sams-search-fix')) {
      var sf = document.createElement('style');
      sf.id = 'hb-sams-search-fix';
      sf.textContent =
        'header.sams-redesigned-main-header.hb-sams-searching > div, header.sams-redesigned-main-header.hb-sams-searching > a, header.sams-redesigned-main-header.hb-sams-searching > section, header.sams-redesigned-main-header.hb-sams-searching > nav, header.sams-redesigned-main-header:has(form[data-testid="search-form"]:focus-within) > div, header.sams-redesigned-main-header:has(form[data-testid="search-form"]:focus-within) > a, header.sams-redesigned-main-header:has(form[data-testid="search-form"]:focus-within) > section, header.sams-redesigned-main-header:has(form[data-testid="search-form"]:focus-within) > nav { display: none !important; }' +
        'header.sams-redesigned-main-header.hb-sams-searching form[data-testid="search-form"], header.sams-redesigned-main-header:has(form[data-testid="search-form"]:focus-within) form[data-testid="search-form"] { margin-left: 0 !important; margin-right: 0 !important; padding-left: 0 !important; padding-right: 0 !important; gap: 6px !important; }' +
        'form[data-testid="search-form"], form[role="search"] { display: flex !important; flex: 1 1 auto !important; min-width: 0 !important; width: 100% !important; max-width: 100% !important; justify-content: flex-start !important; }' +
        'form[data-testid="search-form"] > div, form[role="search"] > div { display: flex !important; flex: 1 1 auto !important; min-width: 0 !important; width: 100% !important; position: relative !important; border-radius: 9999px !important; }' +
        'input[data-automation-id="header-input-search"], input.search-bar-redesigned-v2, form[data-testid="search-form"] input[type="search"], form[role="search"] input[type="search"] { display: block !important; width: 100% !important; min-width: 0 !important; max-width: 100% !important; box-sizing: border-box !important; background-color: #ffffff !important; color: #0f172a !important; -webkit-text-fill-color: #0f172a !important; caret-color: #0f172a !important; opacity: 1 !important; font-size: 16px !important; line-height: 1.35 !important; padding-left: 14px !important; padding-right: 76px !important; border-radius: 9999px !important; text-indent: 0 !important; margin: 0 !important; }' +
        'input[data-automation-id="header-input-search"]::placeholder, input.search-bar-redesigned-v2::placeholder, form[data-testid="search-form"] input[type="search"]::placeholder { color: #64748b !important; -webkit-text-fill-color: #64748b !important; opacity: 1 !important; }' +
        'form[data-testid="search-form"] button[aria-label*="Clear" i], form[role="search"] button[aria-label*="Clear" i] { position: absolute !important; right: 38px !important; left: auto !important; top: 50% !important; transform: translateY(-50%) !important; z-index: 2 !important; color: #0f172a !important; }' +
        'form[data-testid="search-form"] button.search-icon-redesigned-v2, form[role="search"] button.search-icon-redesigned-v2 { position: absolute !important; right: 6px !important; left: auto !important; top: 50% !important; transform: translateY(-50%) !important; z-index: 2 !important; color: #0f172a !important; }' +
        'form[data-testid="search-form"] button[aria-label="Cancel"], form[role="search"] button[aria-label="Cancel"] { flex: 0 0 auto !important; white-space: nowrap !important; }';
      head.appendChild(sf);
    }
  }

  function findOutermostAppBannerContainer(startEl, requireExplicitUpsell, inHeaderOrNav, vw, vh) {
    var bannerEl = null;
    var cur = startEl;
    var depth = 0;
    while (cur && depth < 12) {
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
        var isExplicitUpsellStrip = APP_UPSELL_BANNER_RE.test(curText) || (/\bapp\b/i.test(curText) && APP_RATINGS_WITH_APP_RE.test(curText));
        if (hasProtectedNodes || txtLen > 340 || r.height > (inHeaderOrNav ? 185 : 240)) {
          if (bannerEl) break;
        } else if (!requireExplicitUpsell || isExplicitUpsellStrip) {
          var scrubbedCurText = isExplicitUpsellStrip ? curText.replace(APP_UPSELL_BANNER_RE, ' ') : curText;
          var hasForbiddenCopy = isExplicitUpsellStrip
            ? APP_BANNER_STRICT_FORBIDDEN_RE.test(scrubbedCurText)
            : BANNER_FORBIDDEN_TEXT_RE.test(curText);
          var anchoredEdge = (pos === 'fixed' || pos === 'sticky' || r.bottom >= vh - 120 || r.top <= 190);
          var maxH = inHeaderOrNav ? 185 : 240;
          if (!hasForbiddenCopy && r.height >= 34 && r.height <= maxH && r.width >= vw * 0.55 && anchoredEdge) {
            bannerEl = cur;
          } else if (bannerEl && hasForbiddenCopy) {
            break;
          }
        }
      }
      cur = cur.parentElement;
      depth++;
    }
    return bannerEl;
  }

  function dismissRetailerAppBanners() {
    ensureAppBannerSuppressorStyles();
    var now = Date.now();
    if (location.href !== hbBannerLastHref) {
      hbBannerLastHref = location.href;
      hbBannerLastScanAt = 0;
    }
    if (now - hbBannerLastScanAt < 450) return;
    hbBannerLastScanAt = now;
    if (SENSITIVE_BANNER_PATH_RE.test(location.pathname || '')) return;

    var vw = Math.max(280, window.innerWidth || 390);
    var vh = Math.max(400, window.innerHeight || 844);

    // Pass 1: CTA-anchored detection (handles <button>, <a>, whole-banner <a>, and header "Open App" pills)
    var ctas = document.querySelectorAll('a, button, [role="button"]');
    for (var i = 0; i < ctas.length; i++) {
      var cta = ctas[i];
      if (!cta || (cta.closest && cta.closest('[data-hb-app-banner-hidden="1"], footer, [role="contentinfo"], form, [role="dialog"], [aria-modal="true"]'))) continue;
      var ctaText = clean(cta.textContent || '');
      var href = String((cta.getAttribute && cta.getAttribute('href')) || '');
      var isWholeBannerCta = ctaText.length <= 340 && (APP_UPSELL_BANNER_RE.test(ctaText) || (/\bapp\b/i.test(ctaText) && APP_RATINGS_WITH_APP_RE.test(ctaText)));
      var isExplicitAppCta = APP_INSTALL_CTA_RE.test(ctaText) || isWholeBannerCta || (cta.tagName === 'A' && APP_INSTALL_HREF_RE.test(href));
      var isGenericOpenCta = !isExplicitAppCta && APP_GENERIC_OPEN_CTA_RE.test(ctaText);
      if (!isExplicitAppCta && !isGenericOpenCta) continue;

      var inHeaderOrNav = Boolean(cta.closest && cta.closest('header, nav'));
      var startNode = isWholeBannerCta ? cta : cta.parentElement;
      var bannerEl = findOutermostAppBannerContainer(startNode, isGenericOpenCta, inHeaderOrNav, vw, vh);

      if (bannerEl && bannerEl.getAttribute('data-hb-app-banner-hidden') !== '1') {
        clickSafeBannerDismissButton(bannerEl, cta);
        hideBannerWithSpacer(bannerEl, vw);
      } else if (inHeaderOrNav && isExplicitAppCta && ctaText.length <= 28) {
        // Hide standalone "Open App" / "Get the app" button inside header/nav without touching Login/Search/Cart
        hideBannerNode(cta);
      }
    }

    // Pass 2: Text-first fallback for clickable <div>/<span> app banners with no <button> or <a>
    var textNodes = document.querySelectorAll('div, p, span, h2, h3, h4, section');
    var checkedCount = 0;
    for (var t = 0; t < textNodes.length && checkedCount < 260; t++) {
      var tn = textNodes[t];
      if (!tn || tn.children.length > 4) continue;
      if (tn.closest && tn.closest('[data-hb-app-banner-hidden="1"], footer, [role="contentinfo"], form, [role="dialog"], [aria-modal="true"]')) continue;
      var tRect = typeof tn.getBoundingClientRect === 'function' ? tn.getBoundingClientRect() : null;
      if (!tRect || tRect.height < 8 || tRect.height > 180) continue;
      if (tRect.top > 200 && tRect.bottom < vh - 180) continue;
      checkedCount++;
      var tText = clean(tn.textContent || '');
      if (tText.length < 10 || tText.length > 260) continue;
      if (!APP_UPSELL_BANNER_RE.test(tText) && !(APP_RATINGS_WITH_APP_RE.test(tText) && /\bapp\b/i.test(tText))) continue;
      var inHdr = Boolean(tn.closest && tn.closest('header, nav'));
      var txtBanner = findOutermostAppBannerContainer(tn, true, inHdr, vw, vh);
      if (txtBanner && txtBanner.getAttribute('data-hb-app-banner-hidden') !== '1') {
        clickSafeBannerDismissButton(txtBanner, null);
        hideBannerWithSpacer(txtBanner, vw);
      }
    }

    // Pass 3: App-upsell bottom sheets & modal dialogs ("Continue in the app" / "Browse faster in the app")
    var dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
    for (var d = 0; d < dialogs.length; d++) {
      var dlg = dialogs[d];
      if (!dlg || dlg.getAttribute('data-hb-app-banner-hidden') === '1' || !isVisible(dlg)) continue;
      if (dlg.querySelector && dlg.querySelector('form, input, select, textarea')) continue;
      var dText = clean(dlg.textContent || '');
      if (dText.length < 14 || dText.length > 440) continue;
      if (!APP_UPSELL_BANNER_RE.test(dText)) continue;
      if (APP_BANNER_STRICT_FORBIDDEN_RE.test(dText.replace(APP_UPSELL_BANNER_RE, ' '))) continue;
      clickSafeBannerDismissButton(dlg, null);
      hideBannerNode(dlg);
      var dlgParent = dlg.parentElement;
      if (dlgParent && dlgParent !== document.body && dlgParent !== document.documentElement && !/^(?:MAIN|HEADER|NAV|FOOTER|FORM)$/i.test(dlgParent.tagName || '')) {
        var dpCs = window.getComputedStyle(dlgParent);
        var dpRect = typeof dlgParent.getBoundingClientRect === 'function' ? dlgParent.getBoundingClientRect() : null;
        var dpProtected = Boolean(dlgParent.querySelector && dlgParent.querySelector('header, nav, main, footer, form, input, select, textarea, h1'));
        if (!dpProtected && dpCs && dpCs.position === 'fixed' && dpRect && dpRect.width >= vw * 0.9 && dpRect.height >= vh * 0.9 && clean(dlgParent.textContent || '') === dText) {
          hideBannerNode(dlgParent);
        }
      }
      try {
        if (document.body && document.body.style && document.body.style.overflow === 'hidden') {
          document.body.style.overflow = '';
        }
      } catch (e) {}
    }

    // Pass 4: SmartBanner / Branch iframes anchored near top or bottom edge
    var iframes = document.querySelectorAll('iframe');
    for (var f = 0; f < iframes.length; f++) {
      var fr = iframes[f];
      if (!fr || fr.getAttribute('data-hb-app-banner-hidden') === '1') continue;
      var fMeta = String(fr.id || '') + ' ' + String(fr.className || '') + ' ' + String(fr.getAttribute('src') || '') + ' ' + String(fr.getAttribute('title') || '') + ' ' + String(fr.getAttribute('aria-label') || '');
      if (!APP_BANNER_IFRAME_RE.test(fMeta)) continue;
      var fRect = typeof fr.getBoundingClientRect === 'function' ? fr.getBoundingClientRect() : null;
      if (fRect && fRect.height >= 30 && fRect.height <= 220 && fRect.width >= vw * 0.55 && (fRect.top <= 180 || fRect.bottom >= vh - 160)) {
        hideBannerWithSpacer(fr, vw);
        try {
          if (document.body && document.body.classList) document.body.classList.remove('branch-banner-is-active');
          if (document.documentElement && document.documentElement.classList) document.documentElement.classList.remove('branch-banner-is-active');
        } catch (e) {}
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
    return /\/(?:cart|bag|basket|checkout|gp\/cart|store\/cart|shop\/cart)(?:\/|$)|\/checkoutcart(?:display)?view(?:\/|$|\.)/i.test(location.pathname);
  }

  function isCheckoutUrl() {
    return /\/(?:checkout|payment|placeorder|billing|signin|login)(?:\/|$)/i.test(location.pathname);
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
    var isOverlayDrawer = Boolean(
      (el.matches && el.matches('[role="dialog"], [aria-modal="true"], aside')) ||
      /\b(?:drawer|modal|panel|flyout|sidebar|dialog|sheet|popover)\b/i.test(meta) ||
      (window.getComputedStyle && window.getComputedStyle(el).position === 'fixed')
    );
    if (!isOverlayDrawer) return false;
    var h = el.querySelector('h1, h2, h3, [role="heading"]');
    var ht = clean(h ? h.textContent : '');
    if (ht && ht.length <= 80 && /\b(?:cart|bag|basket)(?:\s*\(\d+.*\))?$/i.test(ht)) return true;
    if (/^(?:your\s+)?(?:shopping\s+)?(?:cart|bag|basket|order)(?:\s*\(\d+.*\))?$/i.test(ht)) return true;
    var ctas = el.querySelectorAll('a, button, [role="button"]');
    for (var i = 0; i < ctas.length && i < 40; i++) {
      var bt = clean(ctas[i].textContent || '');
      if (/^(?:go\s+to\s+checkout|proceed\s+to\s+checkout|continue\s+to\s+checkout|checkout(?:\s+now)?|place\s+order)\b/i.test(bt)) return true;
    }
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

  var CART_DRAWER_META_RE = /\b(cart[-_ ]?(?:drawer|modal|panel|flyout|sidebar)|shopping[-_ ]?cart|mini[-_ ]?cart|bag[-_ ]?drawer)\b/i;

  function isCartDrawerNode(node) {
    if (!node || node.nodeType !== 1) return false;
    var cls = typeof node.className === 'string' ? node.className : '';
    var meta = (node.id || '') + ' ' + cls + ' ' + ((node.getAttribute && node.getAttribute('aria-label')) || '') + ' ' + ((node.getAttribute && node.getAttribute('data-testid')) || '');
    if (CART_DRAWER_META_RE.test(meta)) return true;
    var role = node.getAttribute ? String(node.getAttribute('role') || '').toLowerCase() : '';
    var isContainer =
      role === 'dialog' ||
      (node.getAttribute && String(node.getAttribute('aria-modal') || '').toLowerCase() === 'true') ||
      /^(ASIDE|SECTION)$/i.test(node.tagName || '');
    return isContainer ? isCartDrawer(node) : false;
  }

  function isInactiveTabPanel(node) {
    if (!node || node.nodeType !== 1 || !node.getAttribute) return false;
    if (String(node.getAttribute('role') || '').toLowerCase() !== 'tabpanel') return false;
    if (
      node.hidden === true ||
      (node.hasAttribute && (node.hasAttribute('hidden') || node.hasAttribute('inert'))) ||
      String(node.getAttribute('aria-hidden') || '').toLowerCase() === 'true'
    ) {
      return true;
    }
    var dataState = String(node.getAttribute('data-state') || '').toLowerCase();
    if (dataState === 'inactive' || dataState === 'closed') return true;
    if (String(node.getAttribute('aria-selected') || '').toLowerCase() === 'false') return true;
    if (String(node.getAttribute('aria-expanded') || '').toLowerCase() === 'false') return true;
    var id = String(node.id || '').trim();
    if (id && /^[A-Za-z0-9_:-]+$/.test(id)) {
      var tab = document.querySelector('[role="tab"][aria-controls="' + id + '"]');
      if (tab && tab.getAttribute && String(tab.getAttribute('aria-selected') || '').toLowerCase() === 'false') {
        return true;
      }
    }
    var labelledBy = String(node.getAttribute('aria-labelledby') || '').trim();
    if (labelledBy) {
      var lblIds = labelledBy.split(/\s+/);
      for (var i = 0; i < lblIds.length; i++) {
        var lblEl = document.getElementById(lblIds[i]);
        if (
          lblEl &&
          lblEl.getAttribute &&
          String(lblEl.getAttribute('role') || '').toLowerCase() === 'tab' &&
          String(lblEl.getAttribute('aria-selected') || '').toLowerCase() === 'false'
        ) {
          return true;
        }
      }
    }
    return !isVisible(node);
  }

  function isInsideHiddenOrCartContainer(el, scopeRoot) {
    if (!el || el.nodeType !== 1) return true;
    var isModalScope = Boolean(scopeRoot && scopeRoot !== document.body && scopeRoot !== document.documentElement);
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      if (cur.hidden === true || (cur.hasAttribute && (cur.hasAttribute('hidden') || cur.hasAttribute('inert')))) {
        return true;
      }
      if (cur.getAttribute && String(cur.getAttribute('aria-hidden') || '').toLowerCase() === 'true') {
        return true;
      }
      var st = window.getComputedStyle ? window.getComputedStyle(cur) : null;
      if (st) {
        if (st.display === 'none' || st.visibility === 'hidden') return true;
        if (st.opacity === '0' || (st.opacity !== '' && parseFloat(st.opacity) === 0)) return true;
      }
      if (isInactiveTabPanel(cur)) return true;
      var role = cur.getAttribute ? String(cur.getAttribute('role') || '').toLowerCase() : '';
      var isDialog = role === 'dialog' || (cur.getAttribute && String(cur.getAttribute('aria-modal') || '').toLowerCase() === 'true');
      if (!isModalScope) {
        if (isCartDrawerNode(cur)) return true;
        if (isDialog && !isVisible(cur)) return true;
      } else if (cur !== scopeRoot) {
        if (isCartDrawerNode(cur)) return true;
        if (isDialog && !isVisible(cur)) return true;
      }
      if (isModalScope && cur === scopeRoot) break;
      cur = cur.parentElement;
    }
    return false;
  }

  function isInsideHiddenDialogTabpanelOrCart(el, scopeRoot) {
    if (!el || el.nodeType !== 1) return true;
    var isModalScope = Boolean(scopeRoot && scopeRoot !== document.body && scopeRoot !== document.documentElement);
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      if (isCartDrawerNode(cur)) return true;
      if (isInactiveTabPanel(cur)) return true;
      var role = cur.getAttribute ? String(cur.getAttribute('role') || '').toLowerCase() : '';
      var isDialog = role === 'dialog' || (cur.getAttribute && String(cur.getAttribute('aria-modal') || '').toLowerCase() === 'true');
      if (isDialog && (!isModalScope || cur !== scopeRoot) && !isVisible(cur)) {
        return true;
      }
      if (cur !== el) {
        if (cur.hidden === true || (cur.hasAttribute && (cur.hasAttribute('hidden') || cur.hasAttribute('inert')))) {
          return true;
        }
        if (cur.getAttribute && String(cur.getAttribute('aria-hidden') || '').toLowerCase() === 'true') {
          return true;
        }
        var st = window.getComputedStyle ? window.getComputedStyle(cur) : null;
        if (st) {
          if (st.display === 'none' || st.visibility === 'hidden') return true;
          if (st.opacity === '0' || (st.opacity !== '' && parseFloat(st.opacity) === 0)) return true;
        }
      }
      if (isModalScope && cur === scopeRoot) break;
      cur = cur.parentElement;
    }
    return false;
  }

  function isDisclosureControl(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = String(el.tagName || '').toUpperCase();
    if (tag === 'BUTTON' || tag === 'SUMMARY') return true;
    if (el.getAttribute && String(el.getAttribute('role') || '').toLowerCase() === 'button') return true;
    if (el.hasAttribute && (el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls'))) return true;
    return false;
  }

  function isControlledDisclosurePanel(controlEl, panelEl) {
    if (!controlEl || !panelEl || !isDisclosureControl(controlEl)) return false;
    var controls = controlEl.getAttribute ? String(controlEl.getAttribute('aria-controls') || '').trim() : '';
    var panelId = String(panelEl.id || '').trim();
    if (controls && panelId) {
      var ids = controls.split(/\s+/);
      for (var i = 0; i < ids.length; i++) {
        if (ids[i] === panelId) return true;
      }
    }
    if (typeof controlEl.closest === 'function' && typeof panelEl.closest === 'function') {
      var details = controlEl.closest('details');
      if (details && details === panelEl.closest('details')) return true;
    }
    return false;
  }

  function isAllowedAmazonInfoNode(amzInfo) {
    if (!amzInfo || amzInfo.isConnected === false) return false;
    if (document.body && !document.body.contains(amzInfo)) return false;
    if (isInsideExcluded(amzInfo, document.body)) return false;
    if (amzInfo.hasAttribute && amzInfo.hasAttribute('inert')) return false;
    var parent = amzInfo.parentElement;
    if (
      parent &&
      parent !== document.body &&
      parent !== document.documentElement &&
      isInsideHiddenOrCartContainer(parent, null)
    ) {
      return false;
    }
    if (isVisible(amzInfo) && !isInsideHiddenOrCartContainer(amzInfo, null)) {
      return true;
    }
    if (isInsideHiddenDialogTabpanelOrCart(amzInfo, null)) return false;
    var expContainer = amzInfo.closest
      ? amzInfo.closest('.a-expander-container, [data-a-expander-name], [class*="expander" i], [id*="expander" i], details')
      : null;
    if (
      expContainer &&
      expContainer !== amzInfo &&
      isVisible(expContainer) &&
      !isInsideHiddenOrCartContainer(expContainer, null)
    ) {
      return true;
    }
    var id = String(amzInfo.id || '').trim();
    if (id && /^[A-Za-z0-9_:-]+$/.test(id)) {
      var ctrl = document.querySelector('[aria-controls="' + id + '"]');
      if (ctrl && isVisible(ctrl) && !isInsideHiddenOrCartContainer(ctrl, null)) {
        return true;
      }
    }
    if (
      parent &&
      parent !== document.body &&
      parent !== document.documentElement &&
      !/^MAIN$/i.test(parent.tagName || '') &&
      isVisible(parent) &&
      !isInsideHiddenOrCartContainer(parent, null)
    ) {
      if (id === 'nic-po-expander-content') return true;
      var toggle = parent.querySelector
        ? parent.querySelector('.a-expander-header, button[aria-expanded], [role="button"][aria-expanded], summary')
        : null;
      if (toggle && isVisible(toggle) && !isInsideHiddenOrCartContainer(toggle, null)) {
        return true;
      }
    }
    return false;
  }

  var VISIBLE_TEXT_BLOCK_TAGS = {
    P: 1, DIV: 1, LI: 1, DT: 1, DD: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, SECTION: 1, ARTICLE: 1, TR: 1, BR: 1
  };
  var VISIBLE_TEXT_SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1 };

  function extractVisibleText(container, scopeRoot) {
    if (!container || container.nodeType !== 1) return '';
    var stopBoundary = scopeRoot || document.body;
    var isModalScope = Boolean(scopeRoot && scopeRoot !== document.body && scopeRoot !== document.documentElement);
    var parts = [];
    var visits = 0;
    var charCount = 0;

    function walk(node, isRootNode) {
      if (!node || visits > 1500 || charCount > 8000) return;
      if (node.nodeType === 3) {
        var val = String(node.nodeValue || '');
        if (val) {
          parts.push(val);
          charCount += val.length;
        }
        return;
      }
      if (node.nodeType !== 1) return;
      visits++;
      var tag = String(node.tagName || '').toUpperCase();
      if (VISIBLE_TEXT_SKIP_TAGS[tag]) return;
      if (!isRootNode) {
        if (node.hidden === true || (node.hasAttribute && (node.hasAttribute('hidden') || node.hasAttribute('inert')))) return;
        if (node.getAttribute && String(node.getAttribute('aria-hidden') || '').toLowerCase() === 'true') return;
        if (isInactiveTabPanel(node) || isCartDrawerNode(node)) return;
        if (isInsideExcluded(node, stopBoundary)) return;
        var st = window.getComputedStyle ? window.getComputedStyle(node) : null;
        if (st) {
          if (st.display === 'none' || st.visibility === 'hidden') return;
          if (st.opacity === '0' || (st.opacity !== '' && parseFloat(st.opacity) === 0)) return;
        }
        var role = node.getAttribute ? String(node.getAttribute('role') || '').toLowerCase() : '';
        var isDialog = role === 'dialog' || (node.getAttribute && String(node.getAttribute('aria-modal') || '').toLowerCase() === 'true');
        if (isDialog && (!isModalScope || node !== scopeRoot) && !isVisible(node)) return;
        if (st && st.display !== 'contents' && st.display !== 'inline' && typeof node.getBoundingClientRect === 'function') {
          var r = node.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;
        }
      }
      var isBlock = !isRootNode && Boolean(VISIBLE_TEXT_BLOCK_TAGS[tag]);
      if (isBlock) parts.push('\n');
      if (tag === 'BR') return;
      for (var child = node.firstChild; child; child = child.nextSibling) {
        walk(child, false);
        if (visits > 1500 || charCount > 8000) break;
      }
      if (isBlock) parts.push('\n');
    }

    walk(container, true);
    return parts.join('');
  }

  var NON_PDP_ING_RE = /\b(items\s+to\s+add\s+next|product\s+information|similar\s+items|customers\s+also|you\s+might\s+also|related\s+items|frequently\s+bought\s+together|compare\s+with\s+similar|sold\s+by|fulfilled\s+by|see\s+packaging|refer\s+to\s+packaging|nutrition\s+facts|serving\s+size|legal\s+disclaimer|statements\s+regarding|visit\s+the\s+store|customer\s+reviews|add\s+to\s+cart)\b/i;
  var SINGLE_WHOLE_ING_RE = /\b(garlic|lemons?|limes?|apples?|bananas?|avocados?|onions?|scallions?|shallots?|leeks?|carrots?|tomato(?:es)?|potato(?:es)?|yams?|peppers?|spinach|broccoli|cauliflower|kale|arugula|lettuce|romaine|cabbage|cucumbers?|celery|mushrooms?|zucchini|squash|asparagus|beets?|ginger|parsley|cilantro|basil|berries|blueberr(?:y|ies)|raspberr(?:y|ies)|strawberr(?:y|ies)|blackberr(?:y|ies)|cranberr(?:y|ies)|cherr(?:y|ies)|grapes?|oranges?|mandarins?|clementines?|grapefruits?|peaches?|plums?|pears?|kiwis?|mangos?|mangoes|pineapples?|watermelons?|cantaloupes?|honeydews?|milk|cream|butter|eggs?|oats?|rice|quinoa|honey|water|beef|chicken|turkey|pork|lamb|salmon|cod|shrimp|tilapia|tuna|almonds?|walnuts?|peanuts?|cashews?|pecans?|pistachios?|beans?|lentils?|chickpeas?|peas|corn|salt|sugar|flour|olive\s+oil|avocado\s+oil|coconut\s+oil)\b/i;

  function isPlausiblePdpIngredientText(raw, requireCommaUnlessWhole) {
    var t = clean(raw || '');
    if (!t || t.length < 3 || t.length >= 2500) return false;
    if (NON_TITLE_RE.test(t) || NON_PDP_ING_RE.test(t)) return false;
    if (/\$\s*\d/.test(t) && t.indexOf(',') === -1) return false;
    if (t.length >= 12) {
      if (requireCommaUnlessWhole && t.indexOf(',') === -1 && t.indexOf(';') === -1) {
        return t.length <= 80 && SINGLE_WHOLE_ING_RE.test(t);
      }
      return true;
    }
    return /^[a-z][a-z\s'-]{1,48}\.?$/i.test(t) && SINGLE_WHOLE_ING_RE.test(t);
  }

  function readIngredientsFromScope(modalScope) {
    var root = modalScope || document.querySelector('main') || document.body;
    if (!root) return '';
    var stopBoundary = modalScope || document.body;
    var stopRe = /\b(Allergens?|Contains\s*:|Warnings?|Directions|Nutrition\s+Facts|Distributed\s+by|Legal\s+Disclaimer|Statements\s+regarding)\b/i;
    var host = String(location.hostname || '').toLowerCase();
    var isAmazonHost = /(?:^|\.)amazon\.[a-z.]+$/i.test(host) || host.indexOf('wholefoods') !== -1;
    if (!modalScope && isAmazonHost) {
      var amzNodes = document.querySelectorAll('#importantInformation_feature_div, #nic-po-expander-content');
      for (var a = 0; a < amzNodes.length; a++) {
        var amzInfo = amzNodes[a];
        if (!isAllowedAmazonInfoNode(amzInfo)) continue;
        var amzTxt = (amzInfo.textContent || '').replace(/\s+/g, ' ');
        var amzMatch = amzTxt.match(/\bIngredients\s*:?\s*([\s\S]{3,1400})/i);
        if (amzMatch && amzMatch[1]) {
          var candAmz = clean(amzMatch[1].split(stopRe)[0]);
          if (isPlausiblePdpIngredientText(candAmz, true)) return candAmz;
        }
      }
    }
    var labels = root.querySelectorAll('h2, h3, h4, dt, strong, b, span, div, p, button, summary');
    for (var i = 0; i < labels.length; i++) {
      var el = labels[i];
      if (!isVisible(el)) continue;
      if (isInsideExcluded(el, stopBoundary)) continue;
      if (isInsideHiddenOrCartContainer(el, modalScope)) continue;
      var own = el.children.length <= 2 ? clean(el.textContent) : '';
      if (!/^ingredients\s*:?$/i.test(own)) continue;

      if (isDisclosureControl(el)) {
        var controls = el.getAttribute ? String(el.getAttribute('aria-controls') || '').trim() : '';
        if (controls) {
          var ctrlIds = controls.split(/\s+/);
          for (var c = 0; c < ctrlIds.length; c++) {
            var panel = document.getElementById(ctrlIds[c]);
            if (!panel || !root.contains(panel)) continue;
            if (isInsideExcluded(panel, stopBoundary)) continue;
            if (isInsideHiddenDialogTabpanelOrCart(panel, modalScope)) continue;
            var rawPanel = (isVisible(panel) && !isInsideHiddenOrCartContainer(panel, modalScope))
              ? extractVisibleText(panel, modalScope)
              : String(panel.textContent || '');
            var ctxt = clean(rawPanel.split(stopRe)[0]);
            if (isPlausiblePdpIngredientText(ctxt, false)) return ctxt;
          }
        }
      }

      var sib = el.nextElementSibling;
      for (var k = 0; k < 3 && sib; k++, sib = sib.nextElementSibling) {
        if (isInsideExcluded(sib, stopBoundary)) continue;
        var sibVisible = isVisible(sib) && !isInsideHiddenOrCartContainer(sib, modalScope);
        var sibControlled = !sibVisible && isControlledDisclosurePanel(el, sib) && !isInsideHiddenDialogTabpanelOrCart(sib, modalScope);
        if (!sibVisible && !sibControlled) continue;
        var rawSib = sibVisible ? extractVisibleText(sib, modalScope) : String(sib.textContent || '');
        var stxt = clean(rawSib.split(stopRe)[0]);
        if (isPlausiblePdpIngredientText(stxt, false)) return stxt;
      }

      var parentEl = el.parentElement;
      if (
        parentEl &&
        isVisible(parentEl) &&
        !isInsideExcluded(parentEl, stopBoundary) &&
        !isInsideHiddenOrCartContainer(parentEl, modalScope)
      ) {
        var ptxt = clean(extractVisibleText(parentEl, modalScope).replace(/^ingredients\s*:?\s*/i, '').split(stopRe)[0]);
        if (isPlausiblePdpIngredientText(ptxt, false)) return ptxt;
      }
    }

    var inlineNodes = root.querySelectorAll('p, div, span, li, dd');
    for (var j = 0; j < inlineNodes.length; j++) {
      var n = inlineNodes[j];
      if (n.children.length !== 0) continue;
      if (!isVisible(n) || isInsideExcluded(n, stopBoundary) || isInsideHiddenOrCartContainer(n, modalScope)) continue;
      var ntxt = clean(n.textContent || '');
      if (/^ingredients\s*:/i.test(ntxt)) {
        var candInline = clean(ntxt.replace(/^ingredients\s*:\s*/i, '').split(stopRe)[0]);
        if (isPlausiblePdpIngredientText(candInline, false)) return candInline;
      }
    }

    var visibleRootText = extractVisibleText(root, modalScope);
    var m = visibleRootText.match(/\bIngredients\s*[:\n]\s*([^\n]{3,1200})/i);
    if (m && m[1]) {
      var candFallback = clean(m[1].split(stopRe)[0]);
      if (isPlausiblePdpIngredientText(candFallback, false)) return candFallback;
    }
    return '';
  }

  var CARD_CTA_NOISE_RE = /^(?:add(?:\s+to\s+(?:cart|bag|basket|order))?|options|choose\s+options|select\s+options|quick\s+add|view\s+details|sponsored(?:\s+(?:ad|product|item))?|product|item|ad|advertisement|shop\s+now|best\s+seller|overall\s+pick|popular(?:\s+pick)?|rollback|clearance|new|sale|deal|promo|coupon|clip\s+coupon|save\s+\$?\d.*|buy\s+\d+.*|get\s+\d+.*|\$?\d+(?:\.\d+)?\s*\/\s*[a-z]+.*|\d+(?:\.\d+)?%\s*(?:off|\(\d+\)).*|(?:many|low|out|back)\s+(?:in|of)\s+stock|in\s+stock|out\s+of\s+stock|snap(?:\s+ebt)?|ebt(?:\s+eligible)?|free\s+(?:pickup|delivery|shipping).*|(?:pickup|delivery|shipping)\s+(?:today|tomorrow|available).*|\+|-|\d+(?:\.\d+)?\s*(?:cal|kcal|oz|lb|lbs|g|kg|ml|l|fl\s*oz|ct|count|pk|pack|each|ea))$/i;
  var PRICE_RATING_NOISE_RE = /\$\s*\d|\b\d+(?:\.\d+)?\s*¢|\b(?:current|was|now|sale|unit|list)\s+price\b|\b\d(?:\.\d)?\s+out\s+of\s+5\b|\b\d[\d,]*\s+reviews?\b|★/i;

  function isValidGs1Barcode(code) {
    var c = String(code || '').replace(/\D/g, '');
    if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(c) || /^0+$/.test(c)) return false;
    var sum = 0;
    for (var i = 0; i < c.length - 1; i++) {
      var digit = c.charCodeAt(c.length - 2 - i) - 48;
      sum += (i % 2 === 0) ? digit * 3 : digit;
    }
    var check = (10 - (sum % 10)) % 10;
    return check === (c.charCodeAt(c.length - 1) - 48);
  }

  function unwrapProductHref(rawHref) {
    var h = String(rawHref || '').trim();
    if (!h || h.charAt(0) === '#' || /^javascript:/i.test(h)) return '';
    try {
      var u = new URL(h, location.href);
      var path = u.pathname || '';
      if (/\/sp\/track\b|\/gp\/slredirect\b|\/clicks?\b|\/redirect\b/i.test(path) || u.searchParams.has('rd') || u.searchParams.has('url')) {
        var inner = u.searchParams.get('rd') || u.searchParams.get('url') || u.searchParams.get('redirect') || '';
        if (inner) {
          if (/%[0-9a-f]{2}/i.test(inner)) {
            try { inner = decodeURIComponent(inner); } catch (e) {}
          }
          var iu = new URL(inner, location.href);
          return (iu.pathname || '') + (iu.search || '');
        }
      }
      return path + (u.search || '');
    } catch (e) {
      return h;
    }
  }

  function humanizeProductSlug(rawSlug) {
    var s = String(rawSlug || '');
    try { s = decodeURIComponent(s); } catch (e) {}
    s = s
      .replace(/\.(?:html?|htm)$/i, '')
      .replace(/-(?:b0[a-z0-9]{8}|\d{5,20})$/i, '')
      .replace(/^\d{4,18}-/, '')
      .replace(/[_+]+/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s || s.length < 6 || s.length > 240) return '';
    if (/^(?:seort|ip|dp|gp|product|products|items?|shop|store|browse|search|category|categories|aisle|deals|all)$/i.test(s)) return '';
    if (/^[0-9a-f]{8}(?:\s+[0-9a-f]{4}){3}\s+[0-9a-f]{12}$/i.test(s)) return '';
    var alphaWords = s.split(' ').filter(function(w) { return /[a-zA-Z]{2,}/.test(w); });
    if (alphaWords.length < 2) return '';
    s = s
      .replace(/\bs\s+mores\b/gi, "S'mores")
      .replace(/\bm\s+m\s*s\b/gi, "M&M's")
      .replace(/\b(reese|welch|kellogg|campbell|hershey|annie|clancy|member|bj|sam|nature|dave|amy|ben|snyder|lay)\s+s\b/gi, "$1's");
    return clean(s);
  }

  function extractSlugFromPath(pathOnly) {
    var p = String(pathOnly || '');
    if (!p) return '';
    var m =
      p.match(/\/ip\/([^/?#]+)\/\d{5,20}(?:[/?#]|$)/i) ||
      p.match(/\/sams\/shop\/product\/([^/?#]+)(?:\/|$)/i) ||
      p.match(/\/([^/?#]+)\.product\.\d+(?:\.html)?(?:[/?#]|$)/i) ||
      p.match(/\/p\/-\/([^/?#]+)(?:\/|$)/i) ||
      p.match(/\/p\/([^/?#]+)\/-\/A-\d+/i) ||
      (p.indexOf('/p/-') !== 0 && p.match(/\/p\/([^/?#]+)\/[A-Za-z0-9_-]{4,24}(?:[/?#]|$)/i)) ||
      (!/^\/(?:gp|product)\//i.test(p) && p.match(/\/([^/?#]{6,})\/dp\/[A-Z0-9]{10}(?:[/?#]|$)/i)) ||
      p.match(/\/(?:products?|items?)\/(?:item_)?(?:\d{3,18}-)?([A-Za-z][^/?#]{5,})(?:[/?#]|$)/i) ||
      p.match(/\/(?:detail\/ps\/p|product)\/([^/?#]{6,})(?:[/?#]|$)/i);
    return (m && m[1]) ? humanizeProductSlug(m[1]) : '';
  }

  var hbWmNextDataHref = '';
  var hbWmNextDataMap = null;
  function getWalmartNextDataMap() {
    if (!/(?:^|\.)walmart\.com$/i.test(String(location.hostname || ''))) return null;
    if (hbWmNextDataMap && hbWmNextDataHref === location.href) return hbWmNextDataMap;
    hbWmNextDataHref = location.href;
    hbWmNextDataMap = {};
    try {
      var scriptEl = document.getElementById('__NEXT_DATA__');
      if (!scriptEl || !scriptEl.textContent) return hbWmNextDataMap;
      var root = JSON.parse(scriptEl.textContent);
      var stack = [root];
      var visited = 0;
      while (stack.length > 0 && visited < 5000) {
        var cur = stack.pop();
        if (!cur || typeof cur !== 'object') continue;
        visited++;
        if (Array.isArray(cur)) {
          for (var ai = 0; ai < cur.length && stack.length < 4000; ai++) {
            if (cur[ai] && typeof cur[ai] === 'object') stack.push(cur[ai]);
          }
          continue;
        }
        var rawId = cur.usItemId || cur.itemId || (typeof cur.id === 'string' && /^\d{6,14}$/.test(cur.id) ? cur.id : '');
        var rawName = typeof cur.name === 'string' ? cur.name : (typeof cur.title === 'string' ? cur.title : '');
        var rawUpc = typeof cur.upc === 'string' ? cur.upc : (typeof cur.gtin === 'string' ? cur.gtin : (typeof cur.gtin13 === 'string' ? cur.gtin13 : ''));
        if (rawId && (rawUpc || rawName)) {
          var keyId = String(rawId).trim();
          var prevRec = hbWmNextDataMap[keyId] || {};
          var cleanUpc = String(rawUpc || '').replace(/\D/g, '');
          if (cleanUpc.length === 14 && cleanUpc.indexOf('00') === 0) cleanUpc = cleanUpc.slice(2);
          else if (cleanUpc.length === 14 && cleanUpc.indexOf('0') === 0) cleanUpc = cleanUpc.slice(1);
          hbWmNextDataMap[keyId] = {
            upc: (cleanUpc && isValidGs1Barcode(cleanUpc)) ? cleanUpc : (prevRec.upc || ''),
            name: (rawName && rawName.length > (prevRec.name || '').length) ? clean(rawName) : (prevRec.name || '')
          };
        }
        var keys = Object.keys(cur);
        for (var ki = 0; ki < keys.length && stack.length < 4000; ki++) {
          var v = cur[keys[ki]];
          if (v && typeof v === 'object') stack.push(v);
        }
      }
    } catch (_) {}
    return hbWmNextDataMap;
  }

  function recoverFromCardLinks(cardEl, visibleTitle) {
    var outTitle = visibleTitle || '';
    var hrefKey = '';
    var barcode = '';
    if (!cardEl || !cardEl.querySelectorAll) return { title: outTitle, hrefKey: hrefKey, barcode: barcode };
    var attrNames = ['data-upc', 'data-gtin', 'data-ean', 'data-barcode'];
    for (var ai = 0; ai < attrNames.length && !barcode; ai++) {
      var an = attrNames[ai];
      var rawAttr = (cardEl.getAttribute && cardEl.getAttribute(an)) || '';
      if (!rawAttr) {
        var subEl = cardEl.querySelector('[' + an + ']');
        if (subEl) rawAttr = subEl.getAttribute(an) || '';
      }
      var rawCode = String(rawAttr || '').replace(/\D/g, '');
      if (isValidGs1Barcode(rawCode)) {
        if (rawCode.length === 14 && rawCode.indexOf('00') === 0) rawCode = rawCode.slice(2);
        else if (rawCode.length === 14 && rawCode.indexOf('0') === 0) rawCode = rawCode.slice(1);
        barcode = rawCode;
      }
    }
    var needFullTitle = !outTitle || /(?:\.\.\.|…|[,(\/-])\s*$|\([^)]*$/.test(outTitle);
    var wmItemId = String((cardEl.getAttribute && cardEl.getAttribute('data-item-id')) || '').trim();
    var rawHrefs = [];
    var ownDpUrl = String((cardEl.getAttribute && cardEl.getAttribute('data-detailpageurl')) || '').trim();
    if (ownDpUrl) rawHrefs.push(ownDpUrl);
    var dpNodes = cardEl.querySelectorAll('[data-detailpageurl]');
    for (var di = 0; di < dpNodes.length; di++) {
      var dEl = dpNodes[di];
      if (dEl.closest && dEl.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
      var dpv = String(dEl.getAttribute('data-detailpageurl') || '').trim();
      if (dpv) rawHrefs.push(dpv);
    }
    var links = cardEl.querySelectorAll('a[href]');
    for (var li = 0; li < links.length; li++) {
      var a = links[li];
      if (a.closest && a.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
      var rh = String(a.getAttribute('href') || '').trim();
      if (rh) rawHrefs.push(rh);
    }
    var fallbackHrefKey = '';
    for (var i = 0; i < rawHrefs.length; i++) {
      var rawHref = rawHrefs[i];
      var unwrapped = unwrapProductHref(rawHref);
      var cleanPath = unwrapped.split('#')[0].split('?')[0];
      if (cleanPath && cleanPath !== '/' && !/^\/sp\/track\b/i.test(cleanPath)) {
        if (!hrefKey && isRealProductHrefPath(rawHref)) {
          hrefKey = cleanPath.slice(0, 140);
        } else if (!fallbackHrefKey) {
          fallbackHrefKey = cleanPath.slice(0, 140);
        }
      }
      if (!wmItemId && cleanPath) {
        var wmMatch = cleanPath.match(/\/ip\/(?:[^/?#]+\/)?(\d{6,14})(?:[/?#]|$)/i);
        if (wmMatch && wmMatch[1]) wmItemId = wmMatch[1];
      }
      if (!barcode && cleanPath) {
        var bm = cleanPath.match(/(?:^|\/)(\d{12,14})(?:[/?#.]|$)/);
        if (bm && bm[1] && isValidGs1Barcode(bm[1])) {
          var bc = bm[1];
          if (bc.length === 14 && bc.indexOf('00') === 0) bc = bc.slice(2);
          else if (bc.length === 14 && bc.indexOf('0') === 0) bc = bc.slice(1);
          barcode = bc;
        }
      }
      if (needFullTitle && cleanPath) {
        var slugCand = extractSlugFromPath(cleanPath);
        if (slugCand && !NON_TITLE_RE.test(slugCand) && !CARD_CTA_NOISE_RE.test(slugCand) && !PRICE_RATING_NOISE_RE.test(slugCand)) {
          if (!outTitle) {
            outTitle = slugCand;
            needFullTitle = false;
          } else {
            var trimmedStem = outTitle.replace(/(?:\.\.\.|…|[,(\/-])\s*$/, '').trim();
            if (slugCand.length > trimmedStem.length + 2 && titlesShareTokens(trimmedStem, slugCand)) {
              outTitle = slugCand;
              needFullTitle = false;
            }
          }
        }
      }
    }
    if (wmItemId) {
      var wmMap = getWalmartNextDataMap();
      var wmEntry = wmMap && wmMap[wmItemId];
      if (wmEntry) {
        if (!barcode && wmEntry.upc) barcode = wmEntry.upc;
        if (
          wmEntry.name &&
          wmEntry.name.length >= 5 &&
          !NON_TITLE_RE.test(wmEntry.name) &&
          !CARD_CTA_NOISE_RE.test(wmEntry.name) &&
          (needFullTitle || (outTitle && wmEntry.name.length > outTitle.length + 3 && titlesShareTokens(outTitle, wmEntry.name)))
        ) {
          outTitle = wmEntry.name;
          needFullTitle = false;
        }
      }
    }
    if (!hrefKey && fallbackHrefKey) {
      hrefKey = fallbackHrefKey;
    }
    if (!hrefKey && links.length > 0) {
      hrefKey = String(links[0].getAttribute('href') || '').split('#')[0].split('?')[0].slice(0, 140);
    }
    return { title: outTitle, hrefKey: hrefKey, barcode: barcode };
  }

  function extractBestCardTitle(cardEl, sels) {
    var best = '';
    for (var s = 0; s < sels.length; s++) {
      var els = cardEl.querySelectorAll(sels[s]);
      for (var k = 0; k < els.length; k++) {
        var el = els[k];
        if (el.closest && el.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
        var raw = clean(el.getAttribute('aria-label') || el.textContent || '');
        if (raw && raw.length >= 5 && raw.length <= 240 && !NON_TITLE_RE.test(raw) && !CARD_CTA_NOISE_RE.test(raw) && !PRICE_RATING_NOISE_RE.test(raw)) {
          best = raw;
          break;
        }
      }
      if (best) break;
    }
    if (best && /(?:\.\.\.|…)\s*$/.test(best)) {
      var fullSels = ['.p13nTitle .a-truncate-full', '.a-truncate-full', '[data-test="product-title"]', '[data-test="product-card-title"]', '[data-automation-id*="product-title" i]', 'a[link-identifier]', 'a[aria-label]', '[title]', 'span.w_iUH7', '[class*="w_iUH7"]'];
      var stem = best.replace(/(?:\.\.\.|…)\s*$/, '').trim().toLowerCase().slice(0, 24);
      for (var fs = 0; fs < fullSels.length; fs++) {
        var fullEls = cardEl.querySelectorAll(fullSels[fs]);
        for (var fk = 0; fk < fullEls.length; fk++) {
          var fel = fullEls[fk];
          if (fel.closest && fel.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
          var fullCand = clean(fel.getAttribute('aria-label') || fel.getAttribute('title') || fel.textContent || '');
          if (
            fullCand &&
            fullCand.length > best.length &&
            fullCand.length <= 240 &&
            !/(?:\.\.\.|…)\s*$/.test(fullCand) &&
            !NON_TITLE_RE.test(fullCand) &&
            !CARD_CTA_NOISE_RE.test(fullCand) &&
            !PRICE_RATING_NOISE_RE.test(fullCand) &&
            (!stem || fullCand.toLowerCase().indexOf(stem) === 0 || titlesShareTokens(best, fullCand))
          ) {
            return fullCand;
          }
        }
      }
    }
    return best;
  }

  var CARD_SEL = '[data-item-id], [data-testid*="list-view" i], [data-testid*="item-stack" i] > div, div[class*="mb0"][class*="ph1"], [data-testid*="product-card" i], [data-testid*="item-card" i], [data-testid^="item_list_item" i], [data-testid*="product-tile" i], [data-test*="product-card" i], [data-test*="@web/site-top-of-funnel/ProductCardWrapper"], [data-qa*="product-card" i], [data-qa*="product-tile" i], [data-automation-id="product-tile"], [automation-id*="productTile" i], [data-component-type="s-search-result"], [data-csa-c-type="productTile"], [data-csa-c-type="item"][data-csa-c-item-id*="asin."], [data-asin]:not([data-asin=""]), [data-anchor-id*="RetailItem" i], [data-anchor-id*="MenuItem" i], [data-testid*="RetailItem" i], [data-testid*="MenuItem" i], [data-testid*="store-item" i], li[data-testid*="store-item" i], .product-tile-set, .product-tile, .base-product-tile, .ProductCard, .CardTemplate-Horizontal, .sc-pc-medium-desktop-card, [class*="sc-pc-" i][class*="card" i], app-product-card, [auto-data*="productCard" i], [data-auto-data*="product" i], [data-cy*="product-card" i], article[class*="product" i], li[class*="product" i]';
  var EXPLICIT_PRODUCT_CARD_SEL = '[data-item-id], [data-asin]:not([data-asin=""]), [data-component-type="s-search-result"], [data-csa-c-type="productTile"], [data-csa-c-type="item"][data-csa-c-item-id*="asin."], [data-detailpageurl*="/dp/"], [data-testid*="product-card" i], [data-testid*="item-card" i], [data-testid^="item_list_item" i], [data-testid*="product-tile" i], [data-test*="product-card" i], [data-test*="@web/site-top-of-funnel/ProductCardWrapper"], [data-qa*="product-card" i], [data-automation-id="product-tile"], [automation-id*="productTile" i], [data-anchor-id*="RetailItem" i], [data-testid*="RetailItem" i], [data-testid*="store-item" i], .product-tile-set, .product-tile, .base-product-tile, .ProductCard, .CardTemplate-Horizontal, .sc-pc-medium-desktop-card, app-product-card, [auto-data*="productCard" i]';
  var MULTI_CARD_UNIT_SEL = '[data-item-id], [data-asin]:not([data-asin=""]), [data-component-type="s-search-result"], [data-csa-c-type="productTile"], [data-csa-c-type="item"][data-csa-c-item-id*="asin."], [data-testid*="product-card" i], [data-testid*="item-card" i], [data-testid^="item_list_item" i], [data-test*="@web/site-top-of-funnel/ProductCardWrapper"], [data-qa*="product-card" i], [data-anchor-id*="RetailItem" i], [data-testid*="RetailItem" i], [data-testid*="store-item" i], .product-tile-set, .ProductCard, .CardTemplate-Horizontal, app-product-card, [auto-data*="productCard" i]';
  var DEFINITIVE_SINGLE_CARD_SEL = '[data-component-type="s-search-result"], [data-csa-c-type="productTile"], [data-csa-c-type="item"][data-csa-c-item-id*="asin."], [data-item-id], [data-test*="@web/site-top-of-funnel/ProductCardWrapper"], [data-testid^="item_list_item" i], [data-testid*="RetailItem" i], [data-testid*="store-item" i], .sc-pc-medium-desktop-card, [auto-data*="productCard" i]';
  var PRODUCT_LINK_SEL = 'a[data-csa-c-type="productTile"], [data-detailpageurl*="/dp/"], a[link-identifier], a[href*="/sp/track"], a[href*="/gp/slredirect"], a[href*="/ip/"], a[href*="/products/"], a[href*="/product/"], a[href*="/items/"], a[href*=".product."], a[href*="/p/"], a[href*="/sams/shop/product/"], a[href*="/detail/ps/p/"], a[href*="/dp/"], a[href*="/gp/aw/d/"], a[href*="item_id="], a[href*="product_id="]';
  var PLACEHOLDER_IMG_RE = /(?:^|[\/_.-])(?:1x1|pixel|spacer|spinner|skeleton|shimmer|placeholder|transparent|blank|loading|lazyload|grey-pixel)(?:[\/_.-]|$)|^data:image\/gif|^data:image\/svg\+xml.*(?:feGaussianBlur|blur|shimmer|skeleton|spinner|spacer|1x1)/i;
  var NON_PRODUCT_IMG_RE = /(?:^|[\/_.-])(?:logo|sprite|icon|avatar|badge|stars?|rating|banner|promo|favicon)(?:[\/_.-]|$)/i;

  function isRealProductHrefPath(rawHref) {
    var unwrapped = unwrapProductHref(rawHref);
    var p = unwrapped.split('#')[0].split('?')[0];
    if (!p || p === '/' || /^\/(?:browse|cp|c|categories|category|departments|aisles|fmc|stores|shop\/categories|all-departments|my-items)\b/i.test(p)) {
      if (/[?&](?:item_id|product_id)=/i.test(unwrapped)) return unwrapped.split('#')[0];
      return '';
    }
    if (/(\/ip\/|\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/sams\/shop\/product\/|\.product\.|\/p\/|\/products?\/|\/items?\/|\/detail\/ps\/p\/)/i.test(p) || /[?&](?:item_id|product_id)=/i.test(unwrapped)) {
      return unwrapped.split('#')[0];
    }
    return '';
  }

  function hasMultipleDistinctProductLinks(el) {
    if (!el || !el.querySelectorAll) return false;
    if (el.matches && el.matches(DEFINITIVE_SINGLE_CARD_SEL) && el.querySelectorAll(DEFINITIVE_SINGLE_CARD_SEL).length === 0) {
      return false;
    }
    if (el.querySelectorAll(MULTI_CARD_UNIT_SEL).length > 1) return true;
    var pLinks = el.querySelectorAll(PRODUCT_LINK_SEL);
    if (pLinks.length <= 1) return false;
    var firstKey = '';
    for (var i = 0; i < pLinks.length; i++) {
      var a = pLinks[i];
      var csaId = (a.getAttribute && a.getAttribute('data-csa-c-content-id')) || '';
      var key = csaId || isRealProductHrefPath((a.getAttribute && (a.getAttribute('href') || a.getAttribute('data-detailpageurl'))) || '');
      if (!key) continue;
      if (!firstKey) firstKey = key;
      else if (key !== firstKey) return true;
    }
    return false;
  }

  var CARD_TITLE_SELS = [
    '.p13nTitle .a-truncate-full', '.p13nTitle',
    '[data-automation-id="product-title"]', '[data-automation-id*="product-title" i]', '[data-test="product-title"]', '[data-test="product-card-title"]',
    '[data-testid*="product-title" i]', '[data-testid*="item-title" i]', '[data-testid*="product-card-name" i]', '[data-testid*="item-name" i]',
    '[data-telemetry-id*="storeItem.title" i]', '[auto-data="productTitle"]',
    '[data-qa*="product-name" i]', '[data-qa="cart-page-item-description"]',
    '[automation-id*="productDescriptionLink" i]', '[auto-data*="product_name" i]',
    '[data-auto-data*="product_name" i]', '.product-tile__name', '.base-product-tile__name', '.sc-pc-title-medium',
    '[class*="sc-pc-title" i]', 'a[link-identifier]', 'span.w_iUH7', '[class*="w_iUH7"]', 'h2 a span', 'h3 a span', 'h2', 'h3', 'h4',
    '[data-testid="rich-text"]',
    'a[data-csa-c-type="productTile"]', 'a[href*="/sp/track"]', 'a[href*="/gp/slredirect"]',
    'a[href*="/ip/"]', 'a[href*="/sams/shop/product/"]', 'a[href*=".product."]', 'a[href*="/p/"]',
    'a[href*="/dp/"]', 'a[href*="/gp/aw/d/"]', 'a[href*="/products/"]', 'a[href*="/items/"]',
    'a[href*="/detail/ps/p/"]', 'a[href*="/product/"]'
  ];

  var hbPinnedCardId = '';
  var hbPinnedScrollY = 0;
  var hbPinnedScrollX = 0;
  var hbPinnedRectLeft = 0;
  var hbPinnedRectTop = 0;
  window.__heybrocClearPinnedCard = function() {
    hbPinnedCardId = '';
  };

  function findAlignedSearchCard() {
    if (isCheckoutUrl()) return { title: '', storeImageUrl: '', barcode: '', cardId: '', batchPending: false };
    var vh = Math.max(320, window.innerHeight || 680);
    var vw = Math.max(280, window.innerWidth || 412);
    if (hbPinnedCardId) {
      var pinnedOwner = hbOwnerCardById[hbPinnedCardId];
      if (pinnedOwner && pinnedOwner.isConnected && isVisible(pinnedOwner)) {
        var pr = pinnedOwner.getBoundingClientRect();
        if (pr.bottom > 60 && pr.top < vh - 24 && pr.right > 16 && pr.left < vw - 16) {
          var pSt = hbCardState ? hbCardState.get(pinnedOwner) : null;
          var pTitle = (pSt && pSt.title) ? pSt.title : recoverFromCardLinks(pinnedOwner, extractBestCardTitle(pinnedOwner, CARD_TITLE_SELS)).title;
          if (pTitle && !isNonFoodGridTitle(pTitle)) {
            var pImg = (pSt && pSt.img) ? sanitizeStoreImgSrc(pSt.img) : '';
            if (!pImg) {
              var pImgs = pinnedOwner.querySelectorAll('img');
              for (var pi = 0; pi < pImgs.length; pi++) {
                var pu = sanitizeStoreImgSrc(pImgs[pi]);
                if (pu) { pImg = pu; break; }
              }
            }
            return {
              title: pTitle,
              storeImageUrl: pImg,
              barcode: '',
              cardId: hbPinnedCardId,
              batchPending: Boolean(pSt && !pSt.resolved && !pSt.suppressedEstimate && pSt.badgeEl && pSt.badgeEl.isConnected)
            };
          }
        }
      }
      hbPinnedCardId = '';
    }
    var rawCards = Array.prototype.slice.call(document.querySelectorAll(CARD_SEL));
    if (!rawCards.length) {
      var links = document.querySelectorAll(PRODUCT_LINK_SEL);
      for (var k = 0; k < links.length && rawCards.length < 40; k++) {
        var anc = links[k].closest('article, li, [role="group"], div');
        if (anc && rawCards.indexOf(anc) === -1) rawCards.push(anc);
      }
    }
    var targetY = (typeof window.__heybrocBubbleCenterY === 'number' && window.__heybrocBubbleCenterY > 40)
      ? window.__heybrocBubbleCenterY
      : (vh * 0.38);
    var hasCustomX = typeof window.__heybrocBubbleCenterX === 'number' && window.__heybrocBubbleCenterX > 10;
    var targetX = hasCustomX ? window.__heybrocBubbleCenterX : (vw * 0.5);
    var bestTitle = '';
    var bestBarcode = '';
    var bestCard = null;
    var bestDist = 999999;

    for (var i = 0; i < rawCards.length; i++) {
      var card = rawCards[i];
      if (!isVisible(card)) continue;
      if (hasMultipleDistinctProductLinks(card)) continue;
      if (isCartDrawer(card.closest('[role="dialog"], aside, section'))) continue;
      var cr = card.getBoundingClientRect();
      if (cr.height < 64 || cr.height > vh * 0.94 || cr.width < 100) continue;
      if (cr.bottom < 95 || cr.top > vh - 45) continue;
      if (cr.right < 24 || cr.left > vw - 24) continue;

      var visTitle = extractBestCardTitle(card, CARD_TITLE_SELS);
      var rec = recoverFromCardLinks(card, visTitle);
      var candTitle = rec.title;
      if (!candTitle || isNonFoodGridTitle(candTitle)) continue;

      var distY = 0;
      if (targetY < cr.top) distY = cr.top - targetY;
      else if (targetY > cr.bottom) distY = targetY - cr.bottom;
      else distY = Math.abs(((cr.top + cr.bottom) * 0.5) - targetY) * 0.25;

      var distX = 0;
      if (targetX < cr.left) distX = cr.left - targetX;
      else if (targetX > cr.right) distX = targetX - cr.right;
      else distX = Math.abs(((cr.left + cr.right) * 0.5) - targetX) * 0.25;

      var visW = Math.max(0, Math.min(cr.right, vw) - Math.max(cr.left, 0));
      var clipPenalty = (cr.width > 0 && (visW / cr.width) < 0.65) ? 45 : 0;

      var dist = distY + (distX * (hasCustomX ? 0.95 : 0.28)) + clipPenalty;
      if (cr.top < 72) dist += 180;
      if (dist < bestDist) {
        bestDist = dist;
        bestTitle = candTitle;
        bestBarcode = rec.barcode || '';
        bestCard = card;
      }
    }
    if (bestDist > 280 || !bestTitle) return { title: '', storeImageUrl: '', barcode: '', cardId: '', batchPending: false };
    var cardImgUrl = '';
    var cardId = '';
    var batchPending = false;
    if (bestCard) {
      var cImgs = bestCard.querySelectorAll('img');
      for (var ci = 0; ci < cImgs.length; ci++) {
        var u = sanitizeStoreImgSrc(cImgs[ci]);
        if (u) { cardImgUrl = u; break; }
      }
      var st = hbCardState ? hbCardState.get(bestCard) : null;
      if (!st && bestCard.querySelector) {
        var innerB = bestCard.querySelector('.hb-photo-badge[data-hb-card-id]');
        if (innerB) {
          var bid = innerB.getAttribute('data-hb-card-id') || '';
          var owner = bid ? hbOwnerCardById[bid] : null;
          if (owner && hbCardState) st = hbCardState.get(owner);
        }
      }
      if (!st && bestCard.closest) {
        var ancCard = bestCard.closest(CARD_SEL);
        if (ancCard && hbCardState) st = hbCardState.get(ancCard);
      }
      if (st) {
        cardId = st.id || '';
        batchPending = Boolean(!st.resolved && !st.suppressedEstimate && st.badgeEl && st.badgeEl.isConnected);
      }
    }
    return { title: bestTitle, storeImageUrl: cardImgUrl, barcode: bestBarcode, cardId: cardId, batchPending: batchPending };
  }

  var NON_FOOD_GRID_RE = /\b(?:paper\s+towels?|toilet\s+(?:paper|tissue)|bath\s+tissue|facial\s+tissues?|trash\s+bags?|garbage\s+bags?|aluminum\s+foil|parchment\s+paper|plastic\s+wrap|paper\s+plates?|laundry\s+(?:detergent|pods?|sanitizer)|fabric\s+softener|dryer\s+sheets?|dish\s+(?:soap|detergent)|dishwasher\s+(?:pods?|pac?ks?|detergent)|disinfecting\s+wipes?|bleach|all[- ]purpose\s+cleaner|glass\s+cleaner|toilet\s+bowl\s+cleaner|air\s+freshener|diapers?|pull[- ]ups?|baby\s+wipes?|cat\s+litter|dog\s+(?:food|treats?|pads?)|cat\s+(?:food|treats?)|pet\s+food|alkaline\s+batteries|aa\s+batteries|aaa\s+batteries|motor\s+oil|windshield\s+washer|light\s+bulbs?|toothpaste|toothbrush|mouthwash|shampoo|body\s+wash|deodorant|antiperspirant|razor\s+blades?|shaving\s+cream|sunscreen|tampons?|maxi\s+pads?|pantiliners?|power\s+bank|air\s+fryer|jigsaw\s+puzzle|piece\s+puzzle|hopper\s+ball|bouncer|heated\s+(?:vest|clothing|jacket)|sippy\s+cups?|toddler\s+cups?|training\s+cups?|water\s+bottle\s+(?:with\s+straw|insulated|stainless))\b/i;
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

  var NON_PRODUCT_CARD_META_RE = /(?:^|[\s_./-])(?:brand[-_ ]?logo|logo|badge|icon|avatar|stars?|rating|ribbon|seal|emblem|favicon|sprite|ebt|snap|wic)(?:$|[\s_./-])/i;
  var NON_PRODUCT_CARD_ALT_RE = /\b(?:brand\s+logo|logo|badge|icon|avatar|star\s*rating|rating\s*stars?|ebt\s+eligible|snap\s+eligible|wic\s+approved)\b/i;

  function isNonProductCardImg(img, src, altCand, skipPlaceholderCheck) {
    if (!skipPlaceholderCheck && isPlaceholderCardImg(img, src)) return true;
    var s = String(src || '').trim();
    if (!/^data:/i.test(s)) {
      try {
        var parsedPath = new URL(s, location.href).pathname || '';
        if (/\.svg$/i.test(parsedPath) || NON_PRODUCT_IMG_RE.test(parsedPath)) return true;
      } catch (e) {
        if (/\.svg(?:$|[?#])/i.test(s) || NON_PRODUCT_IMG_RE.test(s)) return true;
      }
      if (NON_PRODUCT_IMG_RE.test(s)) return true;
    }
    if (altCand && NON_PRODUCT_CARD_ALT_RE.test(altCand)) return true;
    if (img) {
      var attrMeta = String(img.className || '') + ' ' +
        String((img.getAttribute && img.getAttribute('data-testid')) || '') + ' ' +
        String((img.getAttribute && img.getAttribute('data-test')) || '') + ' ' +
        String((img.getAttribute && img.getAttribute('data-automation-id')) || '') + ' ' +
        String(img.id || '');
      if (NON_PRODUCT_CARD_META_RE.test(attrMeta)) return true;
      if (!skipPlaceholderCheck && img.complete && img.naturalWidth > 0 && (img.naturalWidth < 32 || img.naturalHeight < 32)) return true;
      var aw = Number((img.getAttribute && img.getAttribute('width')) || 0);
      var ah = Number((img.getAttribute && img.getAttribute('height')) || 0);
      if ((aw > 0 && aw < 32) || (ah > 0 && ah < 32)) return true;
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
      var ogUrlMeta = document.querySelector('meta[property="og:url"]') || document.querySelector('link[rel="canonical"]');
      var ogMatchesLoc = true;
      if (ogUrlMeta) {
        var rawCanon = ogUrlMeta.getAttribute('content') || ogUrlMeta.getAttribute('href') || '';
        if (rawCanon) {
          try {
            var canonParsed = new URL(rawCanon, location.href);
            ogMatchesLoc = canonParsed.pathname === location.pathname;
          } catch (e) {}
        }
      }
      var ogImg = ogMatchesLoc ? document.querySelector('meta[property="og:image"]') : null;
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
  var hbCachedNextDataRaw = '';
  var hbCachedNextDataObj = null;

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
    st.textContent = '.hb-photo-badge-slot{display:flex!important;justify-content:center!important;align-items:center!important;width:100%!important;margin:10px 0 6px 0!important;padding:0!important;position:relative!important;z-index:2147483640!important;pointer-events:none!important;flex:0 0 auto!important;}.hb-photo-badge{position:relative!important;z-index:2147483640!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;min-height:34px!important;gap:6px!important;padding:6px 15px!important;border-radius:999px!important;font:900 17px/1.1 Roboto,-apple-system,BlinkMacSystemFont,sans-serif!important;font-variant-numeric:tabular-nums!important;letter-spacing:-0.015em!important;color:#fff!important;border:2px solid rgba(255,255,255,0.96)!important;box-shadow:0 4px 12px rgba(15,23,42,0.28)!important;cursor:pointer!important;user-select:none!important;-webkit-user-select:none!important;pointer-events:auto!important;text-decoration:none!important;white-space:nowrap!important;}.hb-photo-badge::before{content:""!important;position:absolute!important;inset:-6px!important;border-radius:999px!important;}.hb-photo-badge--overlay{position:absolute!important;bottom:6px!important;left:50%!important;transform:translateX(-50%)!important;}.hb-photo-badge__ic{font-size:20px!important;line-height:1!important;display:inline-block!important;}.hb-photo-badge--green{background:rgba(22,163,74,0.97)!important;}.hb-photo-badge--yellow{background:rgba(217,119,6,0.97)!important;}.hb-photo-badge--red{background:rgba(220,38,38,0.97)!important;}.hb-photo-badge--advisory{box-shadow:0 0 0 2.5px #fbbf24,0 4px 12px rgba(15,23,42,0.3)!important;}.hb-photo-badge--loading{background:rgba(15,23,42,0.82)!important;opacity:0.92!important;}.hb-photo-badge--check{background:rgba(51,65,85,0.92)!important;font-size:14px!important;font-weight:800!important;padding:5px 12px!important;letter-spacing:0!important;}';
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

  function measureWithoutBadgeSlot(el) {
    var r = el.getBoundingClientRect();
    var slotH = 0;
    if (el.querySelector) {
      var ownSlot = el.querySelector('.hb-photo-badge-slot');
      if (ownSlot && typeof ownSlot.getBoundingClientRect === 'function') {
        slotH = Math.max(0, ownSlot.getBoundingClientRect().height || 0);
      }
    }
    return { width: r.width, height: Math.max(0, r.height - slotH) };
  }

  var PROMO_SLIDE_ALT_RE = /\b(satisfaction\s+guaranteed|money\s+back\s+guarantee|quality\s+guaranteed|100%\s+guaranteed|shopping\s+(?:basket|cart|bag)|checkout\s+conveyor|in\s+a\s+(?:blue|red|green|white|wooden|wicker)\s+(?:basket|bowl|cart)|promotional\s+banner|hero\s+banner)\b/i;
  var MEDIA_ICON_BTN_RE = /\b(save|favorite|favourite|wishlist|heart|bookmark|slide|carousel|next|prev|previous|dot|page\s+\d|image\s+\d|photo\s+\d|zoom|play|pause|mute)\b/i;

  function nodeHasDetailsOrCta(el) {
    if (!el || !el.querySelector) return false;
    if (el.querySelector('h1, h2, h3, .p13nTitle, .a-truncate-full, [data-test="product-title"], [data-automation-id*="product-title" i], [data-testid*="product-title" i], [data-testid*="item-title" i]')) {
      return true;
    }
    var btns = el.querySelectorAll ? el.querySelectorAll('button') : [];
    for (var b = 0; b < btns.length; b++) {
      var btn = btns[b];
      if (btn.closest && btn.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
      var btnTxt = clean(btn.textContent || '');
      var btnMeta = clean(
        btnTxt + ' ' +
        (btn.getAttribute('aria-label') || '') + ' ' +
        (btn.getAttribute('data-test') || '') + ' ' +
        (btn.getAttribute('data-testid') || '')
      );
      if (!btnMeta) continue;
      if (MEDIA_ICON_BTN_RE.test(btnMeta) && (!btnTxt || /^\d+$/.test(btnTxt))) continue;
      return true;
    }
    var txt = clean(el.textContent || '');
    return /\$\s*\d/.test(txt);
  }

  function isHorizontalCarouselTrack(el) {
    if (!el || el === document.body) return false;
    var sw = Number(el.scrollWidth || 0);
    var cw = Number(el.clientWidth || 0);
    var cs = window.getComputedStyle(el);
    if (cs) {
      var ox = String(cs.overflowX || '').toLowerCase();
      if ((ox === 'auto' || ox === 'scroll') && sw > cw + 16) return true;
      if (String(cs.scrollSnapType || '').toLowerCase().indexOf('x') !== -1 && sw > cw + 12) return true;
      var disp = String(cs.display || '').toLowerCase();
      var dir = String(cs.flexDirection || 'row').toLowerCase();
      if ((disp === 'flex' || disp === 'inline-flex') && dir.indexOf('column') !== 0 && el.children && el.children.length >= 2 && sw > cw + 16) {
        return true;
      }
      if ((el.tagName === 'UL' || el.tagName === 'OL') && el.children && el.children.length >= 2 && (disp.indexOf('flex') !== -1 || disp.indexOf('grid') !== -1) && dir.indexOf('column') !== 0) {
        return true;
      }
    }
    var attrHint = String(el.className || '') + ' ' +
      String((el.getAttribute && el.getAttribute('data-test')) || '') + ' ' +
      String((el.getAttribute && el.getAttribute('data-testid')) || '') + ' ' +
      String((el.getAttribute && el.getAttribute('aria-roledescription')) || '');
    if (/(?:carousel[-_ ]?(?:track|list|slides|items|inner|strip)|slider[-_ ]?(?:track|list)|swiper[-_ ]?wrapper)/i.test(attrHint)) {
      return true;
    }
    return false;
  }

  function climbAboveHorizontalCarousel(startEl, cardEl, maxH) {
    if (!startEl || startEl === document.body) return startEl;
    var best = startEl;
    var anc = startEl;
    var steps = 0;
    while (anc && anc !== cardEl && anc !== document.body && steps < 8) {
      if (isHorizontalCarouselTrack(anc)) {
        var shell = anc.parentElement;
        if (shell && shell !== document.body && shell !== cardEl && !nodeHasDetailsOrCta(shell)) {
          var sr = measureWithoutBadgeSlot(shell);
          if (sr.width >= 44 && sr.height >= 44 && sr.height <= maxH) {
            best = shell;
          }
        }
      }
      anc = anc.parentElement;
      steps++;
    }
    return best;
  }

  function findSafeCardAnchor(chosenImg, cardEl) {
    var imgR = chosenImg.getBoundingClientRect();
    var pr0 = chosenImg.parentElement ? chosenImg.parentElement.getBoundingClientRect() : imgR;
    var refH = Math.max((imgR && imgR.height) || 0, (pr0 && pr0.height) || 0);
    var maxAnchorH = Math.min(460, Math.max(120, Math.round(refH || 200)) + 120);
    var cur = chosenImg.parentElement;
    if (cur && cur.tagName === 'PICTURE') cur = cur.parentElement;
    var candidate = null;
    var steps = 0;
    while (cur && cur !== document.body && steps < 6) {
      var cs = window.getComputedStyle(cur);
      var disp = cs ? cs.display : '';
      var cr = measureWithoutBadgeSlot(cur);
      if (disp && disp !== 'inline' && disp !== 'contents' && cr.width >= 44 && cr.height >= 44 && cr.height <= maxAnchorH) {
        candidate = cur;
        break;
      }
      if (cur === cardEl) break;
      cur = cur.parentElement;
      steps++;
    }
    if (candidate && cardEl) {
      candidate = climbAboveHorizontalCarousel(candidate, cardEl, maxAnchorH + 36) || candidate;
    }
    if (!candidate && cardEl && cardEl !== document.body) {
      var cardR = measureWithoutBadgeSlot(cardEl);
      if (cardR.width >= 44 && cardR.height >= 44 && cardR.height <= 920) {
        candidate = cardEl;
      }
    }
    if (!candidate || candidate === document.body) return null;
    var candCs = window.getComputedStyle(candidate);
    var prevPos = candidate.style.position;
    var prevIso = candidate.style.isolation;
    if (candCs && candCs.position === 'static') {
      var beforeR = chosenImg.getBoundingClientRect();
      candidate.style.position = 'relative';
      candidate.style.isolation = 'isolate';
      var afterR = chosenImg.getBoundingClientRect();
      if (beforeR.width >= 40 && (afterR.width < 24 || afterR.height < 24)) {
        candidate.style.position = prevPos;
        candidate.style.isolation = prevIso;
        if (cardEl && cardEl !== candidate) {
          var fbR = measureWithoutBadgeSlot(cardEl);
          if (fbR.width >= 44 && fbR.height >= 44 && fbR.height <= 920) {
            if (window.getComputedStyle(cardEl).position === 'static') {
              cardEl.style.position = 'relative';
            }
            cardEl.style.isolation = 'isolate';
            return cardEl;
          }
        }
        return null;
      }
      return candidate;
    }
    candidate.style.isolation = 'isolate';
    return candidate;
  }

  function containerStacksVertically(el) {
    if (!el || el === document.body) return false;
    var cs = window.getComputedStyle(el);
    if (!cs) return false;
    var disp = cs.display || '';
    if (disp === 'inline' || disp === 'contents' || disp === 'none' || disp === 'grid' || disp === 'inline-grid') return false;
    if (disp === 'flex' || disp === 'inline-flex') {
      var dir = String(cs.flexDirection || 'row').toLowerCase();
      return dir.indexOf('column') === 0;
    }
    return true;
  }

  function mountBadgeUnderOrOnPhoto(chosenImg, cardEl, badge, fallbackAnchor) {
    if (chosenImg && cardEl && chosenImg.parentElement) {
      var beforeImgR = chosenImg.getBoundingClientRect();
      var baseImgH = beforeImgR.height >= 36
        ? beforeImgR.height
        : (chosenImg.parentElement ? chosenImg.parentElement.getBoundingClientRect().height : 200);
      var maxMediaH = Math.max(290, baseImgH + 124);
      var photoUnit = chosenImg.parentElement;
      if (photoUnit && photoUnit.tagName === 'PICTURE' && photoUnit.parentElement) {
        photoUnit = photoUnit.parentElement;
      }
      var interactiveAnc = photoUnit && photoUnit.closest ? photoUnit.closest('a, button') : null;
      if (interactiveAnc && interactiveAnc !== cardEl && nodeContains(cardEl, interactiveAnc) && !nodeHasDetailsOrCta(interactiveAnc)) {
        photoUnit = interactiveAnc;
      }
      photoUnit = climbAboveHorizontalCarousel(photoUnit, cardEl, maxMediaH) || photoUnit;
      var cur = photoUnit;
      var steps = 0;
      while (cur && cur !== cardEl && cur !== document.body && steps < 8) {
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
        var curParentIsVerticalSlotHost =
          !isHorizontalCarouselTrack(nextP) &&
          !(nextP.closest && nextP.closest('a, button')) &&
          containerStacksVertically(nextP);
        var nextParentIsVertical =
          nextP.parentElement &&
          nextP.parentElement !== document.body &&
          !isHorizontalCarouselTrack(nextP.parentElement) &&
          !(nextP.parentElement.closest && nextP.parentElement.closest('a, button')) &&
          containerStacksVertically(nextP.parentElement);
        if (curParentIsVerticalSlotHost && !nextParentIsVertical) {
          // Stop before climbing out of a vertical left photo column into a 2-column horizontal row (e.g. Sam's Club / Walmart list cards)
          photoUnit = cur;
          break;
        }
        var nr = nextP.getBoundingClientRect();
        if (nr.width >= 44 && nr.height <= maxMediaH) {
          photoUnit = nextP;
          cur = nextP;
          steps++;
        } else {
          break;
        }
      }
      photoUnit = climbAboveHorizontalCarousel(photoUnit, cardEl, maxMediaH) || photoUnit;

      var slot = document.createElement('div');
      slot.className = 'hb-photo-badge-slot';
      slot.appendChild(badge);
      var inserted = false;
      var parentEl = photoUnit ? photoUnit.parentElement : null;
      if (
        parentEl &&
        typeof parentEl.insertBefore === 'function' &&
        !isHorizontalCarouselTrack(parentEl) &&
        !(parentEl.closest && parentEl.closest('a, button')) &&
        containerStacksVertically(parentEl)
      ) {
        parentEl.insertBefore(slot, photoUnit.nextSibling || null);
        inserted = true;
      } else if (
        photoUnit &&
        photoUnit.tagName !== 'IMG' &&
        photoUnit.tagName !== 'PICTURE' &&
        photoUnit.tagName !== 'A' &&
        photoUnit.tagName !== 'BUTTON' &&
        !isHorizontalCarouselTrack(photoUnit) &&
        !(photoUnit.closest && photoUnit.closest('a, button')) &&
        containerStacksVertically(photoUnit)
      ) {
        photoUnit.appendChild(slot);
        inserted = true;
      }

      if (inserted) {
        var afterImgR = chosenImg.getBoundingClientRect();
        var unitR = photoUnit ? photoUnit.getBoundingClientRect() : afterImgR;
        var refBottom = (afterImgR.height >= 36) ? Math.max(afterImgR.bottom, unitR.bottom - 36) : unitR.bottom;
        var badgeR = badge.getBoundingClientRect();
        var imgOk = beforeImgR.width < 36 || (
          afterImgR.width >= 44 &&
          afterImgR.height >= 44 &&
          afterImgR.width >= beforeImgR.width * 0.76 &&
          afterImgR.height >= beforeImgR.height * 0.76
        );
        var sizeOk = badgeR.width >= 46 && badgeR.height >= 26;
        var posOk = badgeR.top >= refBottom - 28 && badgeR.top <= Math.max(afterImgR.bottom, unitR.bottom) + 68;
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
    if (chosenImg && fallbackAnchor) {
      var ancRect = fallbackAnchor.getBoundingClientRect();
      var liveImgRect = chosenImg.getBoundingClientRect();
      if (liveImgRect.height >= 40) {
        var spaceBelowImg = ancRect.bottom - liveImgRect.bottom;
        if (spaceBelowImg >= 42) {
          var belowTop = Math.max(6, Math.round((liveImgRect.bottom - ancRect.top) + 8));
          badge.style.setProperty('top', belowTop + 'px', 'important');
          badge.style.setProperty('bottom', 'auto', 'important');
        } else if (ancRect.height > liveImgRect.height + 90) {
          var relTop = Math.max(6, Math.round((liveImgRect.bottom - ancRect.top) - 40));
          if (relTop < ancRect.height - 36) {
            badge.style.setProperty('top', relTop + 'px', 'important');
            badge.style.setProperty('bottom', 'auto', 'important');
          }
        }
      }
    }
    fallbackAnchor.appendChild(badge);
    return null;
  }

  function readCardInfo(cardEl) {
    if (!cardEl || cardEl.closest('header, nav, footer, [role="contentinfo"]')) return null;
    if (isCartDrawer(cardEl.closest('[role="dialog"], aside, section'))) return null;
    var title = extractBestCardTitle(cardEl, CARD_TITLE_SELS);
    var cardR = cardEl.getBoundingClientRect();
    var imgs = cardEl.querySelectorAll('img');
    var chosenImg = null;
    var chosenRank = -1;
    for (var m = 0; m < imgs.length; m++) {
      var img = imgs[m];
      if (img.closest && img.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
      var altCand = clean(img.getAttribute('alt') || '');
      var isPromoSlide = PROMO_SLIDE_ALT_RE.test(altCand);
      if (!title && altCand && !isPromoSlide) {
        if (altCand.length >= 6 && altCand.length <= 240 && !NON_TITLE_RE.test(altCand) && !CARD_CTA_NOISE_RE.test(altCand) && !/^(?:product(?:\s+image)?|thumbnail|photo|image)$/i.test(altCand) && !PRICE_RATING_NOISE_RE.test(altCand)) {
          title = altCand;
        }
      }
      var src = img.currentSrc || img.getAttribute('src') || '';
      var usedAltSrc = false;
      if (!src || /^data:|^blob:/i.test(src) || isPlaceholderCardImg(img, src)) {
        var altSrc = img.getAttribute('srcset') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
        if (altSrc) {
          var parsedAlt = String(altSrc).split(',')[0].trim().split(/\s+/)[0] || '';
          if (parsedAlt) {
            src = parsedAlt;
            usedAltSrc = true;
          }
        }
      }
      var r = img.getBoundingClientRect();
      var pr = img.parentElement ? img.parentElement.getBoundingClientRect() : r;
      var ew = Math.max(r.width, pr.width);
      var eh = Math.max(r.height, pr.height);
      var isExplicitLazyTile = Boolean(cardEl.matches && cardEl.matches('[data-csa-c-type="productTile"], [data-csa-c-type="item"][data-csa-c-item-id*="asin."]') && ew >= 60 && eh >= 60);
      if (isNonProductCardImg(img, src, altCand, isExplicitLazyTile || usedAltSrc)) continue;
      if (!isExplicitLazyTile && isPlaceholderCardImg(usedAltSrc ? null : img, src)) continue;
      if (ew < 44 || eh < 44 || ew > 640 || eh > 640) continue;
      if (r.width >= 20 && r.height >= 20 && (r.width / r.height > 4 || r.height / r.width > 4)) continue;
      var boxR = (r.width >= 24 && r.height >= 24) ? r : pr;
      var inCardHoriz =
        cardR.width < 44 ||
        boxR.width < 24 ||
        (boxR.right > cardR.left + 12 && boxR.left < cardR.right - 12);
      var areaBonus = (r.width >= 84 && r.height >= 84) ? 2 : 0;
      var rank = (inCardHoriz ? 4 : 0) + (isPromoSlide ? 0 : 2) + ((r.width >= 36 && r.height >= 36) ? 1 : 0) + areaBonus;
      if (rank > chosenRank) {
        chosenImg = img;
        chosenRank = rank;
      }
    }
    if (!title) {
      var anyLinks = cardEl.querySelectorAll('a[href]');
      for (var al = 0; al < anyLinks.length; al++) {
        var aEl = anyLinks[al];
        if (aEl.closest && aEl.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
        var aCand = clean(aEl.getAttribute('aria-label') || aEl.textContent || '');
        if (aCand && aCand.length >= 6 && aCand.length <= 240 && !NON_TITLE_RE.test(aCand) && !CARD_CTA_NOISE_RE.test(aCand) && !PRICE_RATING_NOISE_RE.test(aCand)) {
          title = aCand;
          break;
        }
      }
    }
    var rec = recoverFromCardLinks(cardEl, title);
    title = rec.title;
    var hrefKey = rec.hrefKey || String((cardEl.getAttribute && cardEl.getAttribute('data-item-id')) || '').slice(0, 60);
    if (!title || !chosenImg || isNonFoodGridTitle(title)) return null;
    var hasExplicitCardSignal = Boolean(
      (cardEl.matches && cardEl.matches(EXPLICIT_PRODUCT_CARD_SEL)) ||
      (cardEl.querySelector && cardEl.querySelector(EXPLICIT_PRODUCT_CARD_SEL))
    );
    if (!hasExplicitCardSignal) {
      var hasProdHref = Boolean(
        (cardEl.getAttribute && isRealProductHrefPath(cardEl.getAttribute('data-detailpageurl') || '')) ||
        (cardEl.querySelector && cardEl.querySelector('[data-detailpageurl*="/dp/"]'))
      );
      var cardLinks = cardEl.querySelectorAll ? cardEl.querySelectorAll('a[href]') : [];
      for (var cl = 0; cl < cardLinks.length && !hasProdHref; cl++) {
        if (isRealProductHrefPath(cardLinks[cl].getAttribute('href') || '')) {
          hasProdHref = true;
          break;
        }
      }
      if (!hasProdHref && cardEl.tagName === 'A' && isRealProductHrefPath(cardEl.getAttribute('href') || '')) {
        hasProdHref = true;
      }
      if (!hasProdHref && !/\$\s*\d|\b\d+\s*¢/.test(cardEl.textContent || '')) {
        return null;
      }
    }
    var anchor = findSafeCardAnchor(chosenImg, cardEl);
    if (!anchor) return null;
    var sig = title.toLowerCase() + '|' + hrefKey + '|' + detectInstacartSlug() + '|' + hbPrefRev;
    return { title: title, barcode: rec.barcode || '', anchor: anchor, img: chosenImg, storeImageUrl: sanitizeStoreImgSrc(chosenImg), sig: sig };
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
    if (!hbPendingQueue.length || isCheckoutUrl()) {
      if (isCheckoutUrl()) hbPendingQueue = [];
      return;
    }
    if (hbInFlightBatches >= MAX_IN_FLIGHT_BATCHES) {
      hbBatchTimer = setTimeout(flushHbBadgeBatch, 180);
      return;
    }
    if (hbPendingQueue.length > 6) {
      var vhNow = Math.max(400, window.innerHeight || 800);
      var vwNow = Math.max(280, window.innerWidth || 412);
      var onScreen = [];
      var nearScreen = [];
      var offScreen = [];
      for (var q = 0; q < hbPendingQueue.length; q++) {
        var qe = hbPendingQueue[q];
        if (!qe.cardEl || !qe.cardEl.isConnected) continue;
        var qr = qe.cardEl.getBoundingClientRect();
        if (qr.bottom > 40 && qr.top < vhNow - 20 && qr.right > 0 && qr.left < vwNow) onScreen.push(qe);
        else if (qr.bottom > -180 && qr.top < vhNow + 220 && qr.right > -120 && qr.left < vwNow + 140) nearScreen.push(qe);
        else offScreen.push(qe);
      }
      hbPendingQueue = onScreen.concat(nearScreen, offScreen);
    }
    var chunk = hbPendingQueue.splice(0, 12);
    if (hbPendingQueue.length > 0) {
      hbBatchTimer = setTimeout(flushHbBadgeBatch, 140);
    }
    var payloadItems = [];
    for (var i = 0; i < chunk.length; i++) {
      var entry = chunk[i];
      if (entry.badgeEl && entry.badgeEl.isConnected && entry.cardEl && entry.cardEl.isConnected) {
        var liveInfo = readCardInfo(entry.cardEl);
        if (liveInfo && liveInfo.sig === entry.sig) {
          var itemObj = { id: entry.id, productTitle: liveInfo.title, storeImageUrl: liveInfo.storeImageUrl || '' };
          if (liveInfo.barcode) itemObj.barcode = liveInfo.barcode;
          payloadItems.push(itemObj);
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
    var badgeIcon = hasAlert ? (entry.alertIcon || '⚠️') : '🥦';
    badge.className = 'hb-photo-badge hb-photo-badge--' + tone + extraCls + overlayCls;
    setHbBadgeContent(badge, badgeIcon, String(sc));
    badge.setAttribute('aria-label', 'HeyBroc score ' + sc + ' out of 100' + (title ? ' for ' + title : ''));
  }

  function applyCheckBadgeAppearance(badge, title) {
    var overlayCls = (badge.classList && badge.classList.contains('hb-photo-badge--overlay')) ? ' hb-photo-badge--overlay' : '';
    badge.className = 'hb-photo-badge hb-photo-badge--check' + overlayCls;
    setHbBadgeContent(badge, '🥦', 'Check');
    badge.setAttribute('aria-label', 'Open product page to read live ingredients for ' + (title || 'this item'));
  }

  function processVisibleCard(cardEl) {
    if (!cardEl || !cardEl.isConnected || isCheckoutUrl()) return false;
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
          isCheckBadge: false,
          retryCount: 0,
          retryAfter: 0,
          openOnResolve: false
        });
      }
      hbOwnerCardById[cardId] = cardEl;
      return true;
    }
    if (cachedHit && cachedHit.checkLabel) {
      applyCheckBadgeAppearance(b, info.title);
      var checkSlot = mountBadgeUnderOrOnPhoto(info.img, cardEl, b, info.anchor);
      if (hbCardState) {
        hbCardState.set(cardEl, {
          id: cardId,
          sig: info.sig,
          title: info.title,
          anchor: info.anchor,
          img: info.img,
          badgeEl: b,
          slotEl: checkSlot,
          resolved: true,
          suppressedEstimate: false,
          isCheckBadge: true,
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
      hbBatchTimer = setTimeout(flushHbBadgeBatch, 85);
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
    if (isCheckoutUrl()) {
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
      }, { rootMargin: '180px 120px' });
    }
    var onPdp = Boolean(findOpenProductModal()) || looksLikeProductUrl(location.href);
    var pdpAsinMatch = onPdp ? String(location.pathname || '').match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/)([A-Z0-9]{10})/i) : null;
    var pdpAsin = pdpAsinMatch ? pdpAsinMatch[1].toUpperCase() : '';
    function isPdpHeroCardCandidate(el) {
      if (!onPdp || !el) return false;
      var elId = String(el.id || '');
      if (/^(?:mediaBlockEntities|imageBlock(?:_feature_div)?|image-block|main-image-container|altImages|product-image-gallery-asin|dp-container|ppd|centerCol|leftCol|rightCol)$/i.test(elId)) {
        return true;
      }
      if (el.closest && el.closest('#mediaBlockEntities, #imageBlock, #imageBlock_feature_div, #image-block, #main-image-container, #altImages, [data-testid*="hero-image" i], [data-testid*="media-gallery" i]')) {
        return true;
      }
      if (el.querySelector && el.querySelector('#landingImage, #main-image, [data-fling-asin]')) {
        return true;
      }
      if (pdpAsin) {
        var cardAsin = String((el.getAttribute && el.getAttribute('data-asin')) || '').toUpperCase();
        var csaItemId = String((el.getAttribute && el.getAttribute('data-csa-c-item-id')) || '').toUpperCase();
        if (cardAsin === pdpAsin || csaItemId.indexOf(pdpAsin) !== -1) return true;
      }
      return false;
    }
    var maxCardW = onPdp ? 360 : Math.max(580, (window.innerWidth || 412) + 32);
    var vh = Math.max(400, window.innerHeight || 800);
    var seen = [];
    var seenRects = [];
    function addCand(el, preRect) {
      if (!el || seen.indexOf(el) !== -1 || el.closest('header, nav, footer, [role="contentinfo"]')) return;
      if (isPdpHeroCardCandidate(el)) return;
      if (!el.querySelector || !el.querySelector('img')) return;
      if (hasMultipleDistinctProductLinks(el)) return;
      for (var ex = 0; ex < seen.length; ex++) {
        if (nodeContains(seen[ex], el)) return;
        if (nodeContains(el, seen[ex])) {
          if (seen[ex].matches && seen[ex].matches(DEFINITIVE_SINGLE_CARD_SEL) && !(el.matches && el.matches(DEFINITIVE_SINGLE_CARD_SEL))) {
            return;
          }
          var repR = preRect || el.getBoundingClientRect();
          if (repR.width > 0 && (repR.width < 84 || repR.width > maxCardW || repR.height < 84 || repR.height > 1080)) return;
          seen[ex] = el;
          seenRects[ex] = repR;
          return;
        }
      }
      var r = preRect || el.getBoundingClientRect();
      if (r.width > 0 && (r.width < 84 || r.width > maxCardW || r.height < 84 || r.height > 1080)) return;
      seen.push(el);
      seenRects.push(r);
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
        var tileRect = null;
        for (var depth = 0; depth < 5 && cur && cur !== document.body; depth++) {
          if (cur.querySelector('img')) {
            if (hasMultipleDistinctProductLinks(cur)) break;
            var cr = cur.getBoundingClientRect();
            if (cr.width >= 90 && cr.width <= maxCardW && cr.height >= 90 && cr.height <= 900) {
              tile = cur;
              tileRect = cr;
              if (/^(ARTICLE|LI)$/i.test(cur.tagName)) break;
            }
          }
          cur = cur.parentElement;
        }
        if (tile) addCand(tile, tileRect);
      }
      if (/(?:doordash|ubereats|uber|instacart|shipt|aldi)\./i.test(String(location.hostname || ''))) {
        var btnTiles = document.querySelectorAll('div[role="button"], li[role="button"], button');
        for (var bt = 0; bt < btnTiles.length && bt < 220; bt++) {
          var bel = btnTiles[bt];
          if (bel.closest(CARD_SEL) || bel.closest('header, nav, footer, [role="contentinfo"]')) continue;
          if (!bel.querySelector || !bel.querySelector('img')) continue;
          if (bel.querySelectorAll('img').length > 3) continue;
          var br = bel.getBoundingClientRect();
          if (br.width < 96 || br.width > maxCardW || br.height < 110 || br.height > 640) continue;
          if (!/\$\s*\d/.test(bel.textContent || '')) continue;
          addCand(bel, br);
        }
      }
    }
    // Phase 1: Batch DOM reads before mutating badges to avoid per-card layout thrashing
    var now = Date.now();
    var minRemainingRetryMs = 0;
    var actions = [];
    for (var c = 0; c < seen.length; c++) {
      var card = seen[c];
      var cardRect = seenRects[c];
      var st = hbCardState ? hbCardState.get(card) : null;
      var resetBeforeProcess = false;
      if (st) {
        var curInfo = readCardInfo(card);
        if (!curInfo) {
          actions.push({ kind: 'clear', card: card, st: st });
          continue;
        }
        if (curInfo.sig !== st.sig) {
          resetBeforeProcess = true;
        } else if (st.suppressedEstimate) {
          continue;
        } else if (st.badgeEl && st.badgeEl.isConnected) {
          if (curInfo.img && st.img && curInfo.img !== st.img) {
            actions.push({ kind: 'reanchor', card: card, st: st, curInfo: curInfo });
          }
          continue;
        } else if (st.retryAfter && now < st.retryAfter) {
          var remMs = st.retryAfter - now;
          if (!minRemainingRetryMs || remMs < minRemainingRetryMs) minRemainingRetryMs = remMs;
          continue;
        }
      }
      var vwNow = Math.max(280, window.innerWidth || 412);
      var inNearViewport =
        cardRect.height > 0 &&
        cardRect.bottom >= -140 &&
        cardRect.top <= vh + 180 &&
        cardRect.right >= -120 &&
        cardRect.left <= vwNow + 140;
      actions.push({
        kind: inNearViewport ? 'process' : 'observe',
        card: card,
        resetSt: resetBeforeProcess ? st : null
      });
    }
    // Phase 2: Apply DOM writes in a single pass
    for (var w = 0; w < actions.length; w++) {
      var act = actions[w];
      if (act.kind === 'clear') {
        removeCardBadgeState(act.card, act.st);
        if (hbCardState) hbCardState.delete(act.card);
      } else if (act.kind === 'reanchor') {
        if (hbOwnerCardByImg && hbOwnerCardByImg.get(act.st.img) === act.card) {
          hbOwnerCardByImg.delete(act.st.img);
        }
        removeBadgeDom(act.st.badgeEl, act.st.slotEl);
        if (act.st.badgeEl.classList) act.st.badgeEl.classList.remove('hb-photo-badge--overlay');
        act.st.badgeEl.style.removeProperty('top');
        act.st.badgeEl.style.removeProperty('bottom');
        act.st.img = act.curInfo.img;
        act.st.slotEl = mountBadgeUnderOrOnPhoto(act.curInfo.img, act.card, act.st.badgeEl, act.curInfo.anchor);
        if (hbOwnerCardByImg) hbOwnerCardByImg.set(act.curInfo.img, act.card);
      } else {
        if (act.resetSt) {
          removeCardBadgeState(act.card, act.resetSt);
          if (hbCardState) hbCardState.delete(act.card);
        }
        if (act.kind === 'process' && processVisibleCard(act.card)) {
          if (hbIntersectionObs) hbIntersectionObs.unobserve(act.card);
        } else if (hbIntersectionObs) {
          hbIntersectionObs.observe(act.card);
        } else {
          processVisibleCard(act.card);
        }
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
        if (entry && entry.isNonFood) {
          removeBadgeDom(badge, st ? st.slotEl : null);
          if (st) {
            st.badgeEl = null;
            st.slotEl = null;
            st.openOnResolve = false;
            st.suppressedEstimate = true;
            if (st.title) cacheTitleBadgeScore(st.title, { suppressedEstimate: true });
          }
          continue;
        }
        if (entry && entry.transient && st && (st.retryCount || 0) < 4) {
          removeBadgeDom(badge, st.slotEl);
          st.badgeEl = null;
          st.slotEl = null;
          st.retryCount = (st.retryCount || 0) + 1;
          var serverRetryMs = Number(entry.retryAfterMs) || 0;
          var fallbackDelay = st.retryCount === 1 ? 2200 : (st.retryCount === 2 ? 4800 : 8500);
          var delay = serverRetryMs > 0 ? Math.min(62000, Math.max(2200, serverRetryMs)) : fallbackDelay;
          st.retryAfter = Date.now() + delay;
          if (!earliestRetryMs || delay < earliestRetryMs) earliestRetryMs = delay;
          continue;
        }
        var unindexedTitle = st ? st.title : '';
        applyCheckBadgeAppearance(badge, unindexedTitle);
        if (unindexedTitle) cacheTitleBadgeScore(unindexedTitle, { checkLabel: true });
        if (st) {
          var shouldOpenFailed = Boolean(st.openOnResolve);
          st.openOnResolve = false;
          st.resolved = true;
          st.isCheckBadge = true;
          st.suppressedEstimate = false;
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
        var estTitle = st ? st.title : '';
        applyCheckBadgeAppearance(badge, estTitle);
        if (estTitle) cacheTitleBadgeScore(estTitle, { checkLabel: true });
        if (st) {
          st.resolved = true;
          st.isCheckBadge = true;
          st.suppressedEstimate = false;
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
          alertSeverity: entry.alertSeverity,
          alertIcon: entry.alertIcon || ''
        });
      }
      if (st) {
        st.resolved = true;
        st.isCheckBadge = false;
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
    var badges = document.querySelectorAll('.hb-photo-badge:not(.hb-photo-badge--loading):not(.hb-photo-badge--check)');
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

  window.__heybrocCacheTitleScore = function(title, entry) {
    if (!title || !entry || !entry.ok) return;
    var key = makeTitleScoreKey(title);
    if (!key) return;
    cacheTitleBadgeScore(title, {
      ok: true,
      score: entry.score,
      hasAlert: Boolean(entry.hasAlert),
      alertSeverity: entry.alertSeverity || 'none',
      alertIcon: entry.alertIcon || ''
    });
    var mounted = document.querySelectorAll('.hb-photo-badge--check, .hb-photo-badge--loading');
    for (var mi = 0; mi < mounted.length; mi++) {
      var mb = mounted[mi];
      var mcid = mb.getAttribute('data-hb-card-id') || '';
      var mOwner = mcid ? hbOwnerCardById[mcid] : null;
      var mSt = (mOwner && hbCardState) ? hbCardState.get(mOwner) : null;
      if (mSt && mSt.title && makeTitleScoreKey(mSt.title) === key) {
        applyResolvedBadgeAppearance(mb, mSt.title, entry);
        mSt.resolved = true;
        mSt.isCheckBadge = false;
      }
    }
  };

  var hbAllowCheckNavUntil = 0;

  function openCardProductPage(ownerCard) {
    if (!ownerCard) return false;
    var NON_PROD_NAV_RE = /(?:\/ap\/signin|\/signin|\/login|\/lists\/|\/pastpurchases|\/wishlist|\/hz\/wishlist|#customerReviews)/i;
    var dpUrl = String((ownerCard.getAttribute && ownerCard.getAttribute('data-detailpageurl')) || '').trim();
    var dpTarget = dpUrl ? ownerCard : (ownerCard.querySelector ? ownerCard.querySelector('[data-detailpageurl*="/dp/"]') : null);
    if (!dpUrl && dpTarget && dpTarget.getAttribute) {
      dpUrl = String(dpTarget.getAttribute('data-detailpageurl') || '').trim();
    }
    if (dpUrl && !NON_PROD_NAV_RE.test(dpUrl) && isRealProductHrefPath(dpUrl)) {
      try {
        var resolvedDp = new URL(dpUrl, location.href).href;
        if (/^https:\/\//i.test(resolvedDp)) {
          postBridge({ kind: 'openCardUrl', url: resolvedDp });
          return true;
        }
      } catch (_) {}
      if (dpTarget) {
        try {
          hbAllowCheckNavUntil = Date.now() + 400;
          dpTarget.click();
          return true;
        } catch (_) {}
      }
    }
    var links = ownerCard.querySelectorAll ? ownerCard.querySelectorAll('a[href]') : [];
    var chosenLink = null;
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (a.closest && a.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
      var rawHref = String(a.getAttribute('href') || '').trim();
      if (!rawHref || rawHref === '#' || /^javascript:/i.test(rawHref) || NON_PROD_NAV_RE.test(rawHref)) continue;
      if (isRealProductHrefPath(unwrapProductHref(rawHref))) {
        chosenLink = a;
        break;
      }
    }
    if (chosenLink) {
      var fullUrl = chosenLink.href || '';
      try {
        hbAllowCheckNavUntil = Date.now() + 400;
        chosenLink.click();
        return true;
      } catch (_) {}
      if (fullUrl && /^https:\/\//i.test(fullUrl)) {
        postBridge({ kind: 'openCardUrl', url: fullUrl });
        return true;
      }
    }
    if (!looksLikeProductUrl(location.href) && ownerCard.getAttribute && (ownerCard.getAttribute('role') === 'button' || ownerCard.tagName === 'BUTTON')) {
      try {
        hbAllowCheckNavUntil = Date.now() + 400;
        ownerCard.click();
        return true;
      } catch (_) {}
    }
    return false;
  }

  function activateHbPhotoBadge(badge, e) {
    if (!badge) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    var cardId = badge.getAttribute('data-hb-card-id') || '';
    var badgeSig = badge.getAttribute('data-hb-sig') || '';
    var ownerCard = (cardId && hbOwnerCardById[cardId]) ? hbOwnerCardById[cardId] : (badge.closest ? badge.closest(CARD_SEL) : null);
    var st = (ownerCard && hbCardState) ? hbCardState.get(ownerCard) : null;
    if ((badge.classList && badge.classList.contains('hb-photo-badge--check')) || (st && st.isCheckBadge)) {
      if (openCardProductPage(ownerCard)) return;
    }
    if (cardId) {
      hbPinnedCardId = cardId;
      hbPinnedScrollY = window.scrollY || 0;
      hbPinnedScrollX = window.scrollX || 0;
      var pinRect = (ownerCard && ownerCard.getBoundingClientRect) ? ownerCard.getBoundingClientRect() : badge.getBoundingClientRect();
      hbPinnedRectLeft = pinRect ? pinRect.left : 0;
      hbPinnedRectTop = pinRect ? pinRect.top : 0;
    }
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

  function eventTargetEl(e) {
    var t = e && e.target;
    if (!t) return null;
    if (typeof t.closest === 'function') return t;
    return t.parentElement || null;
  }

  function badgeFromEvent(e) {
    if (Date.now() < hbAllowCheckNavUntil) return null;
    var el = eventTargetEl(e);
    var direct = (el && el.closest) ? el.closest('.hb-photo-badge') : null;
    if (direct) return direct;
    var pt = (e && e.changedTouches && e.changedTouches[0]) || (e && e.touches && e.touches[0]) || e;
    var cx = pt && typeof pt.clientX === 'number' ? pt.clientX : null;
    var cy = pt && typeof pt.clientY === 'number' ? pt.clientY : null;
    if (cx !== null && cy !== null && (cx !== 0 || cy !== 0)) {
      var allBadges = document.querySelectorAll('.hb-photo-badge');
      for (var bi = 0; bi < allBadges.length; bi++) {
        var br = allBadges[bi].getBoundingClientRect();
        if (br.width > 0 && br.height > 0 && cx >= br.left - 6 && cx <= br.right + 6 && cy >= br.top - 6 && cy <= br.bottom + 6) {
          return allBadges[bi];
        }
      }
    }
    return null;
  }

  function stopBadgePointerEvent(e) {
    if (badgeFromEvent(e)) {
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }

  document.addEventListener('touchstart', stopBadgePointerEvent, true);
  document.addEventListener('pointerdown', stopBadgePointerEvent, true);
  document.addEventListener('pointerup', stopBadgePointerEvent, true);
  document.addEventListener('mousedown', stopBadgePointerEvent, true);
  document.addEventListener('mouseup', stopBadgePointerEvent, true);
  document.addEventListener('touchend', stopBadgePointerEvent, true);
  document.addEventListener('auxclick', function(e) {
    if (badgeFromEvent(e)) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }, true);

  document.addEventListener('click', function(e) {
    var badge = badgeFromEvent(e);
    if (badge) {
      activateHbPhotoBadge(badge, e);
      return;
    }
    var t = e && e.target;
    if (t && t.nodeType === 3) t = t.parentElement;
    var cta = t && t.closest ? t.closest('a, button, [role="button"]') : null;
    if (cta) {
      var ctaHref = String((cta.getAttribute && cta.getAttribute('href')) || '');
      var ctaTxt = clean(cta.textContent || '');
      if ((cta.tagName === 'A' && APP_INSTALL_HREF_RE.test(ctaHref)) || (ctaTxt.length <= 28 && APP_INSTALL_CTA_RE.test(ctaTxt))) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        hideBannerNode(cta);
      }
    }
  }, true);

  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var badge = badgeFromEvent(e);
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
          cardId: aligned.cardId || '',
          batchPending: Boolean(aligned.batchPending),
          title: aligned.title.slice(0, 260),
          storeImageUrl: aligned.storeImageUrl || '',
          ingredients: '',
          barcode: aligned.barcode || '',
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
          var wmUrlM = String(location.pathname || '').match(/\/ip\/(?:[^/]+\/)?(\d{5,20})(?:\/|$)/i);
          var urlItemId = wmUrlM ? wmUrlM[1] : '';
          var ndEl = document.getElementById('__NEXT_DATA__');
          var ndRaw = (ndEl && ndEl.textContent) ? ndEl.textContent : '';
          if (ndRaw && ndRaw.length <= 2500000) {
            if (ndRaw !== hbCachedNextDataRaw) {
              hbCachedNextDataRaw = ndRaw;
              hbCachedNextDataObj = JSON.parse(ndRaw);
            }
            var nd = hbCachedNextDataObj;
            var wmData = nd && nd.props && nd.props.pageProps && nd.props.pageProps.initialData && nd.props.pageProps.initialData.data;
            var wmProd = wmData && wmData.product;
            var wmItemId = String((wmProd && (wmProd.usItemId || wmProd.itemId)) || '').trim();
            var wmCanon = String((wmProd && wmProd.canonicalUrl) || '').trim();
            var itemIdMatches = !urlItemId ||
              (wmItemId && wmItemId === urlItemId) ||
              (wmCanon && (wmCanon === '/ip/' + urlItemId || wmCanon.slice(-(urlItemId.length + 1)) === '/' + urlItemId));
            var wmName = itemIdMatches && wmProd && wmProd.name ? clean(String(wmProd.name)) : '';
            var wmMatches = itemIdMatches && ((!title && wmName && !NON_TITLE_RE.test(wmName)) || (title && wmName && titlesShareTokens(title, wmName)));
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
              if (wmIngVal && isPlausiblePdpIngredientText(wmIngVal, false) && !/^none$/i.test(wmIngVal)) {
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
    if (hbPinnedCardId) {
      var dy = Math.abs((window.scrollY || 0) - hbPinnedScrollY);
      var dx = Math.abs((window.scrollX || 0) - hbPinnedScrollX);
      var pinnedEl = hbOwnerCardById[hbPinnedCardId];
      var shifted = false;
      if (!pinnedEl || !pinnedEl.isConnected) {
        shifted = true;
      } else if (pinnedEl.getBoundingClientRect) {
        var prNow = pinnedEl.getBoundingClientRect();
        if (Math.abs(prNow.left - hbPinnedRectLeft) > 28 || Math.abs(prNow.top - hbPinnedRectTop) > 28) {
          shifted = true;
        }
      }
      if (dy > 28 || dx > 28 || shifted) hbPinnedCardId = '';
    }
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(extractProductData, 200);
  }, { capture: true, passive: true });

  document.addEventListener('load', function(e) {
    var t = e && e.target;
    if (t && t.tagName === 'IMG') {
      scheduleCheck(false);
    }
  }, true);

  window.addEventListener('popstate', function() {
    hbPinnedCardId = '';
    clearInputFocusIfUnfocused();
    scheduleCheck(true);
  });
  window.addEventListener('hashchange', function() { hbPinnedCardId = ''; scheduleCheck(true); });
  var origPush = history.pushState;
  history.pushState = function() {
    var r = origPush.apply(this, arguments);
    hbPinnedCardId = '';
    clearInputFocusIfUnfocused();
    scheduleCheck(true);
    return r;
  };
  var origReplace = history.replaceState;
  history.replaceState = function() {
    var r = origReplace.apply(this, arguments);
    hbPinnedCardId = '';
    clearInputFocusIfUnfocused();
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

  var hbInputBlurTimer = null;
  function isEditableTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      var t = String(el.type || 'text').toLowerCase();
      return t !== 'hidden' && t !== 'checkbox' && t !== 'radio' && t !== 'button' && t !== 'submit' && t !== 'reset';
    }
    return Boolean(el.isContentEditable);
  }
  function setSamsSearchingHeader(active) {
    if (!/(?:^|\.)samsclub\.com$/i.test(location.hostname || '')) return;
    var hdr = document.querySelector('header.sams-redesigned-main-header');
    if (hdr && hdr.classList) {
      hdr.classList.toggle('hb-sams-searching', Boolean(active));
    }
  }
  function clearInputFocusIfUnfocused() {
    if (hbInputBlurTimer) { clearTimeout(hbInputBlurTimer); hbInputBlurTimer = null; }
    if (!isEditableTarget(document.activeElement)) {
      setSamsSearchingHeader(false);
      postBridge({ kind: 'inputFocus', focused: false });
    }
  }
  document.addEventListener('focusin', function(e) {
    var t = e && e.target;
    if (!isEditableTarget(t)) return;
    if (hbInputBlurTimer) { clearTimeout(hbInputBlurTimer); hbInputBlurTimer = null; }
    if (t && t.closest && t.closest('form[data-testid="search-form"], form[role="search"]')) {
      setSamsSearchingHeader(true);
    }
    postBridge({ kind: 'inputFocus', focused: true });
  }, true);
  document.addEventListener('focusout', function(e) {
    if (!isEditableTarget(e && e.target)) return;
    if (hbInputBlurTimer) clearTimeout(hbInputBlurTimer);
    hbInputBlurTimer = setTimeout(function() {
      hbInputBlurTimer = null;
      if (!isEditableTarget(document.activeElement)) {
        setSamsSearchingHeader(false);
        postBridge({ kind: 'inputFocus', focused: false });
      }
    }, 140);
  }, true);
  document.addEventListener('submit', function() {
    if (hbInputBlurTimer) { clearTimeout(hbInputBlurTimer); hbInputBlurTimer = null; }
    setSamsSearchingHeader(false);
    postBridge({ kind: 'inputFocus', focused: false });
  }, true);

  // Photo badges are driven by IntersectionObserver, debounced scroll/mutation,
  // image load events, history hooks, and retry timers (no idle 1800ms polling).
  dismissRetailerAppBanners();
  scheduleCheck(true);
})();
