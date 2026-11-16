package com.cleancart.overlay

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowInsets
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.Executors
import kotlin.math.abs

/**
 * Zero-permission In-App Live Store Browser for Android (1:1 parity with iOS `LiveStoreBrowserViewController`).
 * Lets shoppers open Walmart, Instacart, Target, Amazon Fresh, Whole Foods, Costco, Sam's Club, Kroger,
 * ALDI, BJ's, Shipt, DoorDash, and Uber Eats directly inside HeyBroc with:
 *  - 120fps on-photo `0–100` score badges (`.hb-photo-badge`),
 *  - Automatic `"Get the app"` / `"Open in app"` banner & deep-link redirect suppression,
 *  - Draggable floating Broccoli Pill,
 *  - Native slide-up 3-pillar Inspect & 1-Tap Clean Swap sheet.
 */
class LiveStoreBrowserActivity : Activity() {

    data class LiveStoreConfig(
        val key: String,
        val apiStoreKey: String,
        val storeBucket: String,
        val label: String,
        val homeUrl: String
    )

    companion object {
        const val EXTRA_STORE_KEY = "store_key"
        const val EXTRA_INITIAL_URL = "initial_url"
        const val EXTRA_SEARCH_QUERY = "search_query"

        val STORES: List<LiveStoreConfig> = listOf(
            LiveStoreConfig("walmart", "walmart", "walmart", "Walmart", "https://www.walmart.com/browse/food/976759"),
            LiveStoreConfig("instacart", "instacart", "instacart", "Instacart", "https://www.instacart.com"),
            LiveStoreConfig("target", "target", "target", "Target", "https://www.target.com/c/grocery/-/N-5xt1a"),
            LiveStoreConfig("amazon", "amazon", "amazon", "Amazon Fresh", "https://www.amazon.com/alm/storefront?almBrandId=QW1hem9uIEZyZXNo"),
            LiveStoreConfig("wholefoods", "amazon", "wholefoods", "Whole Foods", "https://www.amazon.com/alm/storefront?almBrandId=VUZHIFdob2xlIEZvb2Rz"),
            LiveStoreConfig("costco", "costco", "costco", "Costco", "https://www.costco.com/grocery-household.html"),
            LiveStoreConfig("sams", "sams", "sams", "Sam's Club", "https://www.samsclub.com/b/grocery/1444"),
            LiveStoreConfig("kroger", "kroger", "kroger", "Kroger", "https://www.kroger.com"),
            LiveStoreConfig("aldi", "aldi", "aldi", "ALDI", "https://shop.aldi.us"),
            LiveStoreConfig("bjs", "bjs", "bjs", "BJ's", "https://www.bjs.com"),
            LiveStoreConfig("shipt", "shipt", "shipt", "Shipt", "https://www.shipt.com"),
            LiveStoreConfig("doordash", "doordash", "doordash", "DoorDash", "https://www.doordash.com/grocery"),
            LiveStoreConfig("ubereats", "ubereats", "ubereats", "Uber Eats", "https://www.ubereats.com/category/grocery")
        )

        private val KROGER_BANNER_HOST_SUFFIXES = listOf(
            "kroger.com",
            "ralphs.com",
            "fredmeyer.com",
            "frysfood.com",
            "kingsoopers.com",
            "smithsfoodanddrug.com",
            "qfc.com",
            "harristeeter.com",
            "marianos.com",
            "picknsave.com",
            "dillons.com",
            "bakersplus.com",
            "citymarket.com",
            "gerbes.com",
            "jaycfoods.com",
            "pay-less.com",
            "food4less.com",
            "foodscomarket.com"
        )

        private val ALLOWED_RETAILER_HOST_SUFFIXES = listOf(
            "walmart.com",
            "instacart.com",
            "target.com",
            "amazon.com",
            "wholefoodsmarket.com",
            "costco.com",
            "samsclub.com",
            "aldi.us",
            "bjs.com",
            "shipt.com",
            "doordash.com",
            "ubereats.com"
        ) + KROGER_BANNER_HOST_SUFFIXES

        private val ALLOWED_SSO_HOST_SUFFIXES = listOf(
            "uber.com",
            "accounts.google.com",
            "appleid.apple.com",
            "login.target.com",
            "identity.walmart.com"
        )

        private val VALID_BATCH_ID_RE = Regex(
            "^(?!^(?:__proto__|constructor|prototype)$)[A-Za-z0-9_-]{1,40}$",
            RegexOption.IGNORE_CASE
        )

        fun normalizeStoreKey(raw: String?): String {
            return when (raw?.trim()?.lowercase().orEmpty()) {
                "samsclub", "sams_club", "sam's club" -> "sams"
                "whole_foods", "wholefoodsmarket", "amazon:wholefoods" -> "wholefoods"
                "amazon_fresh", "amazon:fresh", "amazon:core" -> "amazon"
                "uber_eats", "uber-eats" -> "ubereats"
                "bjs_wholesale", "bj's" -> "bjs"
                "" -> "walmart"
                else -> raw!!.trim().lowercase()
            }
        }

        fun isAllowedRetailerHost(rawHost: String?): Boolean {
            val host = rawHost?.trim()?.lowercase().orEmpty()
            if (host.isEmpty()) return false
            return ALLOWED_RETAILER_HOST_SUFFIXES.any { suffix ->
                host == suffix || host.endsWith(".$suffix")
            }
        }

        fun isAllowedNavigationHost(rawHost: String?): Boolean {
            if (isAllowedRetailerHost(rawHost)) return true
            val host = rawHost?.trim()?.lowercase().orEmpty()
            if (host.isEmpty()) return false
            return ALLOWED_SSO_HOST_SUFFIXES.any { suffix ->
                host == suffix || host.endsWith(".$suffix")
            }
        }

        fun isBlockedAppRedirectHost(rawHost: String?): Boolean {
            val host = rawHost?.trim()?.lowercase().orEmpty()
            if (host.isEmpty()) return false
            return host == "play.google.com" ||
                host == "market.android.com" ||
                host == "itunes.apple.com" ||
                host == "apps.apple.com" ||
                host == "bnc.lt" ||
                host == "app.adjust.com" ||
                host == "smart.link" ||
                host.endsWith(".app.link") ||
                host.endsWith(".onelink.me") ||
                host.endsWith(".adj.st") ||
                host.endsWith(".branch.io") ||
                host.endsWith(".smart.link")
        }

        fun validatedRetailerUrl(rawUrl: String?): String? {
            val trimmed = rawUrl?.trim().orEmpty()
            if (trimmed.isEmpty()) return null
            val uri = runCatching { Uri.parse(trimmed) }.getOrNull() ?: return null
            val scheme = uri.scheme?.lowercase().orEmpty()
            if (scheme != "https") return null
            val host = uri.host?.lowercase().orEmpty()
            if (!isAllowedRetailerHost(host) || isBlockedAppRedirectHost(host)) return null
            return trimmed
        }

        fun createIntent(
            context: Context,
            storeKey: String,
            initialUrl: String? = null,
            searchQuery: String? = null
        ): Intent {
            return Intent(context, LiveStoreBrowserActivity::class.java).apply {
                putExtra(EXTRA_STORE_KEY, normalizeStoreKey(storeKey))
                if (!initialUrl.isNullOrBlank()) putExtra(EXTRA_INITIAL_URL, initialUrl)
                if (!searchQuery.isNullOrBlank()) putExtra(EXTRA_SEARCH_QUERY, searchQuery)
            }
        }

        private fun buildDetectorJs(bridgeSecret: String): String =
            DETECTOR_JS_TEMPLATE.replace("__HB_BRIDGE_SECRET__", bridgeSecret)

        private const val EARLY_BANNER_CSS_JS = """
            (function() {
              if (window !== window.top) return;
              var metaApple = document.querySelector('meta[name="apple-itunes-app"]');
              if (metaApple && metaApple.parentNode) metaApple.parentNode.removeChild(metaApple);
              var metaPlay = document.querySelector('meta[name="google-play-app"]');
              if (metaPlay && metaPlay.parentNode) metaPlay.parentNode.removeChild(metaPlay);
              var head = document.head || document.documentElement;
              if (!head || document.getElementById('hb-app-banner-suppressor')) return;
              var st = document.createElement('style');
              st.id = 'hb-app-banner-suppressor';
              st.textContent = '#branch-banner-iframe, .branch-journeys-top, [id^="branch-banner"], [class*="branch-animation"], .smartbanner, [id*="smartbanner" i], smart-banner, [data-testid="smart-banner"], [data-testid="app-banner"], [data-testid="download-app-banner"], [data-automation-id="app-banner"], [data-automation-id="smart-banner"], [data-test="smartBanner"], [data-test="appBanner"], [data-hb-app-banner-hidden="1"] { display: none !important; visibility: hidden !important; height: 0 !important; min-height: 0 !important; pointer-events: none !important; overflow: hidden !important; }';
              head.appendChild(st);
            })();
        """

        private const val DETECTOR_JS_TEMPLATE = """
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
                  if (!cta || (cta.closest && cta.closest('[data-hb-app-banner-hidden="1"], header, nav, form, [role="dialog"], [aria-modal="true"]'))) continue;
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
                    if (cur === document.body || cur === document.documentElement || tag === 'MAIN' || tag === 'HEADER' || tag === 'NAV' || tag === 'FORM' || role === 'dialog' || ariaModal === 'true' || cid === '__next' || cid === 'root' || cid === 'app') {
                      break;
                    }
                    if (typeof cur.getBoundingClientRect === 'function') {
                      var r = cur.getBoundingClientRect();
                      var cs = window.getComputedStyle(cur);
                      var pos = cs ? cs.position : '';
                      var curText = clean(cur.textContent || '');
                      var txtLen = curText.length;
                      var hasProtectedNodes = Boolean(cur.querySelector && cur.querySelector('header, nav, form, input, select, textarea, h1, [role="dialog"], [aria-modal="true"]'));
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
                var m = String(location.pathname || '').match(/\/store\/([a-z0-9][a-z0-9_-]{1,60})(?:\/|$)/i);
                if (!m || !m[1]) return '';
                var slug = m[1].toLowerCase();
                if (/^(?:items?|products?|checkout|cart|account|help|search|recipes|categories|collections|referrals|gift-cards|orders|lists|bookmarks|login|signup)$/.test(slug)) {
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

              function findAlignedSearchCardTitle() {
                if (isCartUrl()) return '';
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
                var bestDist = 999999;
                var titleSels = [
                  '[data-automation-id*="product-title" i]', '[data-test="product-title"]', '[data-testid*="product-title" i]',
                  '[data-testid*="item-title" i]', '[data-testid*="product-card-name" i]', '[data-qa*="product-name" i]',
                  'span.w_iUH7', '[class*="w_iUH7"]',
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

                  var candTitle = '';
                  for (var s = 0; s < titleSels.length; s++) {
                    var tels = card.querySelectorAll(titleSels[s]);
                    for (var tk = 0; tk < tels.length; tk++) {
                      var tel = tels[tk];
                      if (tel.closest && tel.closest('.hb-photo-badge')) continue;
                      var rawT = clean(tel.getAttribute('aria-label') || tel.textContent || '');
                      if (rawT && rawT.length >= 5 && rawT.length <= 210 && !NON_TITLE_RE.test(rawT) && !CARD_CTA_NOISE_RE.test(rawT) && !/^\$\d/.test(rawT)) {
                        candTitle = rawT;
                        break;
                      }
                    }
                    if (candTitle) break;
                  }
                  if (!candTitle) continue;

                  var dist = 0;
                  if (targetY < cr.top) dist = cr.top - targetY;
                  else if (targetY > cr.bottom) dist = targetY - cr.bottom;
                  else dist = Math.abs(((cr.top + cr.bottom) * 0.5) - targetY) * 0.25;
                  if (cr.top < 72) dist += 180;
                  if (dist < bestDist) {
                    bestDist = dist;
                    bestTitle = candTitle;
                  }
                }
                return bestDist <= 260 ? bestTitle : '';
              }

              var NON_FOOD_GRID_RE = /\b(?:paper\s+towels?|toilet\s+(?:paper|tissue)|bath\s+tissue|facial\s+tissues?|trash\s+bags?|garbage\s+bags?|storage\s+bags?|freezer\s+bags?|sandwich\s+bags?|aluminum\s+foil|parchment\s+paper|plastic\s+wrap|paper\s+plates?|paper\s+cups?|laundry\s+(?:detergent|pods?|sanitizer)|fabric\s+softener|dryer\s+sheets?|dish\s+(?:soap|detergent)|dishwasher\s+(?:pods?|pac?ks?|detergent)|disinfecting\s+wipes?|bleach|all[- ]purpose\s+cleaner|glass\s+cleaner|toilet\s+bowl\s+cleaner|air\s+freshener|diapers?|pull[- ]ups?|baby\s+wipes?|cat\s+litter|dog\s+(?:food|treats?|pads?)|cat\s+(?:food|treats?)|pet\s+food|alkaline\s+batteries|aa\s+batteries|aaa\s+batteries|motor\s+oil|windshield\s+washer|light\s+bulbs?|toothpaste|toothbrush|mouthwash|shampoo|conditioner|body\s+wash|deodorant|antiperspirant|razor\s+blades?|shaving\s+cream|sunscreen|tampons?|maxi\s+pads?|pantiliners?)\b/i;

              function isNonFoodGridTitle(t) {
                if (/\b(?:dough|bread|food|meat|beer)\s+conditioner\b/i.test(t)) return false;
                return NON_FOOD_GRID_RE.test(t);
              }

              var CARD_SEL = '[data-item-id], [data-testid*="list-view" i], [data-testid*="item-stack" i] > div, div[class*="mb0"][class*="ph1"], [data-testid*="product-card" i], [data-testid*="item-card" i], [data-testid*="product-tile" i], [data-test*="product-card" i], [data-test*="@web/site-top-of-funnel/ProductCardWrapper"], [data-qa*="product-card" i], [data-automation-id="product-tile"], [data-component-type="s-search-result"], [data-asin]:not([data-asin=""]), article[class*="product" i], li[class*="product" i]';
              var MULTI_CARD_UNIT_SEL = '[data-item-id], [data-asin]:not([data-asin=""]), [data-testid*="product-card" i], [data-testid*="item-card" i], [data-test*="@web/site-top-of-funnel/ProductCardWrapper"]';
              var PRODUCT_LINK_SEL = 'a[link-identifier], a[href*="/sp/track"], a[href*="/ip/"], a[href*="/products/"], a[href*="/p/"], a[href*="/sams/shop/product/"], a[href*="/detail/ps/p/"], a[href*="/dp/"], a[href*="/gp/aw/d/"]';
              var PLACEHOLDER_IMG_RE = /(?:^|[\/_.-])(?:1x1|pixel|spacer|spinner|transparent|blank)(?:[\/_.-]|$)|^data:image\/gif/i;
              var CARD_CTA_NOISE_RE = /^(?:add(?:\s+to\s+(?:cart|bag|basket|order))?|options|choose\s+options|select\s+options|quick\s+add|view\s+details|sponsored|shop\s+now|\+|-|\d+\s*ct)$/i;

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
              var hbPendingQueue = [];
              var hbBatchTimer = null;
              var hbBatchWatchdog = null;
              var hbRetryTimer = null;
              var hbInFlightBatches = 0;
              var MAX_IN_FLIGHT_BATCHES = 2;
              var hbIntersectionObs = null;

              function ensureHbBadgeStyles() {
                if (document.getElementById('hb-photo-badge-styles')) return;
                var st = document.createElement('style');
                st.id = 'hb-photo-badge-styles';
                st.textContent = '.hb-photo-badge{position:absolute!important;bottom:8px!important;left:8px!important;z-index:20!important;display:inline-flex!important;align-items:center!important;gap:3px!important;padding:3px 8px!important;border-radius:999px!important;font:800 12px/1.15 Roboto,-apple-system,sans-serif!important;font-variant-numeric:tabular-nums!important;letter-spacing:-0.01em!important;color:#fff!important;border:1.5px solid rgba(255,255,255,0.94)!important;box-shadow:0 4px 12px rgba(15,23,42,0.32)!important;cursor:pointer!important;user-select:none!important;-webkit-user-select:none!important;pointer-events:auto!important;text-decoration:none!important;white-space:nowrap!important;}.hb-photo-badge--green{background:rgba(22,163,74,0.96)!important;}.hb-photo-badge--yellow{background:rgba(217,119,6,0.96)!important;}.hb-photo-badge--red{background:rgba(220,38,38,0.96)!important;}.hb-photo-badge--advisory{box-shadow:0 0 0 2px #fbbf24,0 4px 12px rgba(15,23,42,0.32)!important;}.hb-photo-badge--loading{background:rgba(15,23,42,0.76)!important;opacity:0.9!important;}';
                (document.head || document.documentElement).appendChild(st);
              }

              function findSafeCardAnchor(chosenImg, cardEl) {
                var cur = chosenImg.parentElement;
                if (cur && cur.tagName === 'PICTURE') cur = cur.parentElement;
                var candidate = null;
                var steps = 0;
                while (cur && cur !== document.body && steps < 5) {
                  var cs = window.getComputedStyle(cur);
                  var disp = cs ? cs.display : '';
                  var cr = cur.getBoundingClientRect();
                  if (disp && disp !== 'inline' && disp !== 'contents' && cr.width >= 44 && cr.height >= 44 && cr.height <= 480) {
                    candidate = cur;
                    break;
                  }
                  if (cur === cardEl) break;
                  cur = cur.parentElement;
                  steps++;
                }
                if (!candidate) candidate = cardEl;
                if (!candidate || candidate === document.body) return null;
                var candCs = window.getComputedStyle(candidate);
                if (candCs && candCs.position === 'static') {
                  var beforeR = chosenImg.getBoundingClientRect();
                  candidate.style.position = 'relative';
                  var afterR = chosenImg.getBoundingClientRect();
                  if (beforeR.width >= 40 && (afterR.width < 24 || afterR.height < 24)) {
                    candidate.style.position = '';
                    if (cardEl && cardEl !== candidate) {
                      if (window.getComputedStyle(cardEl).position === 'static') {
                        cardEl.style.position = 'relative';
                      }
                      return cardEl;
                    }
                    return null;
                  }
                }
                return candidate;
              }

              function readCardInfo(cardEl) {
                if (!cardEl || cardEl.closest('header, nav, footer')) return null;
                if (isCartDrawer(cardEl.closest('[role="dialog"], aside, section'))) return null;
                var sels = [
                  '[data-automation-id*="product-title" i]', '[data-test="product-title"]', '[data-testid*="product-title" i]',
                  '[data-testid*="item-title" i]', '[data-testid*="product-card-name" i]', '[data-qa*="product-name" i]',
                  'span.w_iUH7', '[class*="w_iUH7"]',
                  'h2 a span', 'h3 a span', 'h2', 'h3',
                  'a[link-identifier]', 'a[href*="/sp/track"]', 'a[href*="/ip/"]', 'a[href*="/sams/shop/product/"]',
                  'a[href*="/p/"]', 'a[href*="/dp/"]', 'a[href*="/gp/aw/d/"]', 'a[href*="/products/"]',
                  'a[href*="/detail/ps/p/"]', 'a[href*="/product/"]'
                ];
                var title = '';
                for (var s = 0; s < sels.length; s++) {
                  var els = cardEl.querySelectorAll(sels[s]);
                  for (var k = 0; k < els.length; k++) {
                    var el = els[k];
                    if (el.closest && el.closest('.hb-photo-badge')) continue;
                    var raw = clean(el.getAttribute('aria-label') || el.textContent || '');
                    if (raw && raw.length >= 5 && raw.length <= 210 && !NON_TITLE_RE.test(raw) && !CARD_CTA_NOISE_RE.test(raw) && !/^\$\d/.test(raw)) {
                      title = raw;
                      break;
                    }
                  }
                  if (title) break;
                }
                var linkEl = cardEl.querySelector(PRODUCT_LINK_SEL) || cardEl.querySelector('a[href]');
                var hrefKey = linkEl ? String(linkEl.getAttribute('href') || '').split('#')[0].slice(0, 140) : '';
                var imgs = cardEl.querySelectorAll('img');
                var chosenImg = null;
                var imgKey = '';
                for (var m = 0; m < imgs.length; m++) {
                  var img = imgs[m];
                  if (img.closest && img.closest('.hb-photo-badge')) continue;
                  if (!title) {
                    var altCand = clean(img.getAttribute('alt') || '');
                    if (altCand && altCand.length >= 6 && altCand.length <= 210 && !NON_TITLE_RE.test(altCand) && !CARD_CTA_NOISE_RE.test(altCand) && !/^(?:product(?:\s+image)?|thumbnail|photo|image)$/i.test(altCand) && !/^\$\d/.test(altCand)) {
                      title = altCand;
                    }
                  }
                  var src = img.currentSrc || img.getAttribute('src') || img.getAttribute('srcset') || img.getAttribute('data-src') || '';
                  if (src && PLACEHOLDER_IMG_RE.test(src)) continue;
                  var r = img.getBoundingClientRect();
                  var pr = img.parentElement ? img.parentElement.getBoundingClientRect() : r;
                  var ew = Math.max(r.width, pr.width);
                  var eh = Math.max(r.height, pr.height);
                  if (!chosenImg && ew >= 44 && eh >= 44 && ew <= 480 && eh <= 480) {
                    chosenImg = img;
                    imgKey = String(src).split('?')[0].slice(-90);
                  }
                }
                if (!title) {
                  var anyLinks = cardEl.querySelectorAll('a[href]');
                  for (var al = 0; al < anyLinks.length; al++) {
                    var aEl = anyLinks[al];
                    if (aEl.closest && aEl.closest('.hb-photo-badge')) continue;
                    var aCand = clean(aEl.getAttribute('aria-label') || aEl.textContent || '');
                    if (aCand && aCand.length >= 6 && aCand.length <= 210 && !NON_TITLE_RE.test(aCand) && !CARD_CTA_NOISE_RE.test(aCand) && !/^\$\d/.test(aCand)) {
                      title = aCand;
                      break;
                    }
                  }
                }
                if (!title || !chosenImg || isNonFoodGridTitle(title)) return null;
                var anchor = findSafeCardAnchor(chosenImg, cardEl);
                if (!anchor) return null;
                var sig = title.toLowerCase() + '|' + hrefKey + '|' + imgKey + '|' + detectInstacartSlug() + '|' + hbPrefRev;
                return { title: title, anchor: anchor, img: chosenImg, sig: sig };
              }

              function removeCardBadgeState(cardEl, st) {
                if (!st) return;
                if (st.id && hbOwnerCardById[st.id] === cardEl) {
                  delete hbOwnerCardById[st.id];
                }
                if (st.img && hbOwnerCardByImg && hbOwnerCardByImg.get(st.img) === cardEl) {
                  hbOwnerCardByImg.delete(st.img);
                }
                if (st.badgeEl && st.badgeEl.parentNode) {
                  st.badgeEl.parentNode.removeChild(st.badgeEl);
                }
                st.badgeEl = null;
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
                      payloadItems.push({ id: entry.id, productTitle: liveInfo.title });
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
                  if (prev.retryAfter && now < prev.retryAfter) return false;
                  if (prev.badgeEl && prev.badgeEl.isConnected) return true;
                } else if (prev) {
                  removeCardBadgeState(cardEl, prev);
                }
                var staleBadges = info.anchor.querySelectorAll(':scope > .hb-photo-badge');
                for (var sb = 0; sb < staleBadges.length; sb++) {
                  if (staleBadges[sb].parentNode) staleBadges[sb].parentNode.removeChild(staleBadges[sb]);
                }
                ensureHbBadgeStyles();
                var cardId = hbPageToken + '_' + (hbCardSeq++);
                var b = document.createElement('span');
                b.className = 'hb-photo-badge hb-photo-badge--loading';
                b.setAttribute('role', 'button');
                b.setAttribute('tabindex', '0');
                b.setAttribute('aria-label', 'Checking HeyBroc score for ' + info.title);
                b.setAttribute('data-hb-card-id', cardId);
                b.setAttribute('data-hb-sig', info.sig);
                b.textContent = '🥦 …';
                info.anchor.appendChild(b);
                var nextState = {
                  id: cardId,
                  sig: info.sig,
                  title: info.title,
                  anchor: info.anchor,
                  img: info.img,
                  badgeEl: b,
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
                hbPendingQueue = [];
                hbInFlightBatches = 0;
                hbPageToken = makePageToken();
                hbOwnerCardById = {};
                hbOwnerCardByImg = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
                if (hbIntersectionObs) { hbIntersectionObs.disconnect(); hbIntersectionObs = null; }
                hbCardState = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
                var old = document.querySelectorAll('.hb-photo-badge');
                for (var i = 0; i < old.length; i++) {
                  if (old[i].parentNode) old[i].parentNode.removeChild(old[i]);
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
                  if (!el || seen.indexOf(el) !== -1 || el.closest('header, nav, footer')) return;
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
                    if (a.closest(CARD_SEL) || a.closest('header, nav, footer')) continue;
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
                    if (badge.parentNode) badge.parentNode.removeChild(badge);
                    if (st) {
                      st.badgeEl = null;
                      if (entry && entry.transient && (st.retryCount || 0) < 2) {
                        st.retryCount = (st.retryCount || 0) + 1;
                        var delay = st.retryCount === 1 ? 2200 : 5000;
                        st.retryAfter = Date.now() + delay;
                        if (!earliestRetryMs || delay < earliestRetryMs) earliestRetryMs = delay;
                      } else {
                        st.suppressedEstimate = true;
                      }
                    }
                    continue;
                  }

                  if (entry.isCategoryEstimate) {
                    if (badge.parentNode) badge.parentNode.removeChild(badge);
                    if (st) {
                      st.badgeEl = null;
                      st.suppressedEstimate = true;
                    }
                    continue;
                  }

                  var sc = Math.max(0, Math.min(100, Math.round(Number(entry.score || 0))));
                  var hasAlert = Boolean(entry.hasAlert);
                  var severity = String(entry.alertSeverity || (hasAlert ? 'advisory' : 'none'));
                  var scoreTone = sc >= 75 ? 'green' : (sc >= 50 ? 'yellow' : 'red');
                  var tone = severity === 'allergen' ? 'red' : scoreTone;
                  var extraCls = (hasAlert && severity !== 'allergen') ? ' hb-photo-badge--advisory' : '';
                  badge.className = 'hb-photo-badge hb-photo-badge--' + tone + extraCls;
                  badge.textContent = (hasAlert ? '⚠️ ' : '🥦 ') + sc;
                  var labelTitle = st ? st.title : '';
                  badge.setAttribute('aria-label', 'HeyBroc score ' + sc + ' out of 100' + (labelTitle ? ' for ' + labelTitle : ''));
                  if (st) {
                    st.resolved = true;
                    if (st.openOnResolve) {
                      st.openOnResolve = false;
                      postBridge({
                        kind: 'inspectCard',
                        cardId: id,
                        title: st.title,
                        instacartSlug: detectInstacartSlug()
                      });
                    }
                  }
                }
                if (earliestRetryMs > 0 && !hbRetryTimer) {
                  hbRetryTimer = setTimeout(function() {
                    hbRetryTimer = null;
                    scanPhotoBadges();
                  }, earliestRetryMs + 80);
                }
              };

              window.__heybrocRefreshPhotoBadges = function() {
                hbPrefRev++;
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
                    instacartSlug: detectInstacartSlug()
                  });
                  return;
                }
                var liveTitle = (liveInfo && liveInfo.title) ? liveInfo.title : (st ? st.title : '');
                if (st && !st.resolved && liveTitle) {
                  st.openOnResolve = false;
                  postBridge({
                    kind: 'inspectCard',
                    cardId: '',
                    title: liveTitle,
                    instacartSlug: detectInstacartSlug()
                  });
                  return;
                }
                postBridge({
                  kind: 'inspectCard',
                  cardId: cardId,
                  title: liveTitle,
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
                return el.id === 'hb-photo-badge-styles' || el.id === 'hb-app-banner-suppressor' || (el.getAttribute && el.getAttribute('data-hb-app-banner-hidden') === '1') || (el.classList && el.classList.contains('hb-photo-badge')) || Boolean(el.closest && (el.closest('.hb-photo-badge') || el.closest('[data-hb-app-banner-hidden="1"]')));
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
                  var alignedTitle = findAlignedSearchCardTitle();
                  if (alignedTitle) {
                    postBridge({
                      kind: 'card',
                      title: alignedTitle.slice(0, 260),
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
                  if (!title) {
                    var og = document.querySelector('meta[property="og:title"]');
                    if (og && og.content) {
                      var ogClean = clean(og.content.replace(/\s*[-|:]\s*(Walmart|Target|Instacart|Amazon|Whole Foods Market|Costco|Sam's Club|Kroger|ALDI|BJ's|DoorDash|Uber Eats|Shipt).*$/i, ''));
                      if (ogClean && !NON_TITLE_RE.test(ogClean)) title = ogClean;
                    }
                  }
                }

                var ingredients = title ? readIngredientsFromScope(modal) : '';
                if (title && title.length >= 4 && !NON_TITLE_RE.test(title)) {
                  postBridge({
                    kind: 'product',
                    title: title.slice(0, 260),
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
        """
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val ioExecutor = Executors.newFixedThreadPool(2)
    private lateinit var activeStore: LiveStoreConfig

    private lateinit var headerBarView: LinearLayout
    private lateinit var webContainer: FrameLayout
    private var storeWebView: WebView? = null
    private lateinit var progressBar: ProgressBar
    private lateinit var pesticideButton: TextView
    private val storeChipViews = LinkedHashMap<String, StoreBrandIcons.StoreChipHandle>()

    private lateinit var floatingBubble: LinearLayout
    private lateinit var bubbleBadgeLabel: TextView
    private lateinit var bubbleSubLabel: TextView
    private var isDockedLeft = false
    private var bubbleTopPx = 0
    private var lastSyncedBubbleY = -1
    private var topSystemInsetPx = 0
    private var bottomSystemInsetPx = 0
    private var userDraggedBubble = false

    private var currentBridgeSecret: String = ""
    private var lastInjectedProgressUrl = ""
    private var lastVisitedHistoryUrl = ""

    private var lastDetectedTitle = ""
    private var lastDetectedIngredients = ""
    private var lastDetectedBarcode = ""
    private var lastDetectedInstacartSlug = ""
    private var lastDetectedIsCard = false
    private var lastScannedKey = ""
    private var latestScanJson: JSONObject? = null
    private val cardJsonById = object : LinkedHashMap<String, JSONObject>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, JSONObject>?): Boolean = size > 160
    }
    private var scanGeneration = 0
    private var badgeBatchGeneration = 0
    private var inspectDialog: Dialog? = null
    private var isCleaningUp = false
    private var backCallbackRegistered = false
    private var backCallbackObj: Any? = null

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    private fun label(
        txt: String,
        sizeSp: Float,
        color: Int,
        bold: Boolean = false
    ): TextView = TextView(this).apply {
        text = txt
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
    }

    private fun isInstalledFromPlayStore(): Boolean {
        val installer = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                packageManager.getInstallSourceInfo(packageName).installingPackageName
            } else {
                @Suppress("DEPRECATION")
                packageManager.getInstallerPackageName(packageName)
            }
        } catch (_: Exception) {
            null
        }
        return installer == "com.android.vending"
    }

    private fun isPesticideWatchEnabled(): Boolean {
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        return "pesticide_risk" in prefs.getStringSet("dietaryWatchlist", emptySet()).orEmpty()
    }

    private fun togglePesticideWatch() {
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val cur = prefs.getStringSet("dietaryWatchlist", emptySet()).orEmpty().toMutableSet()
        if ("pesticide_risk" in cur) cur.remove("pesticide_risk") else cur.add("pesticide_risk")
        prefs.edit().putStringSet("dietaryWatchlist", cur).apply()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.WHITE
        window.navigationBarColor = Color.WHITE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            @Suppress("DEPRECATION")
            var flags = window.decorView.systemUiVisibility or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                @Suppress("DEPRECATION")
                flags = flags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            }
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = flags
        }

        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val requestedKey = normalizeStoreKey(
            intent?.getStringExtra(EXTRA_STORE_KEY) ?: prefs.getString("preferredStore", "walmart")
        )
        activeStore = STORES.firstOrNull { it.key == requestedKey } ?: STORES.first()

        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.WHITE)
        }

        val mainColumn = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFFF8FAFC.toInt())
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        headerBarView = buildHeaderBar()
        mainColumn.addView(headerBarView)

        webContainer = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }
        mainColumn.addView(webContainer)
        root.addView(mainColumn)

        setupFloatingBubble(root)

        // Respect Android 15/16 edge-to-edge status bar, camera cutout, and bottom navigation bar insets
        root.setOnApplyWindowInsetsListener { _, insets ->
            val topInset: Int
            val bottomInset: Int
            val leftInset: Int
            val rightInset: Int
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val bars = insets.getInsets(
                    WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()
                )
                topInset = bars.top
                bottomInset = bars.bottom
                leftInset = bars.left
                rightInset = bars.right
            } else {
                @Suppress("DEPRECATION")
                topInset = insets.systemWindowInsetTop
                @Suppress("DEPRECATION")
                bottomInset = insets.systemWindowInsetBottom
                @Suppress("DEPRECATION")
                leftInset = insets.systemWindowInsetLeft
                @Suppress("DEPRECATION")
                rightInset = insets.systemWindowInsetRight
            }
            topSystemInsetPx = topInset
            bottomSystemInsetPx = bottomInset
            headerBarView.setPadding(leftInset, topInset, rightInset, 0)
            mainColumn.setPadding(0, 0, 0, bottomInset)
            if (!userDraggedBubble) {
                val targetTop = dp(185) + topInset
                bubbleTopPx = targetTop
                (floatingBubble.layoutParams as? FrameLayout.LayoutParams)?.let { lp ->
                    if (lp.topMargin != targetTop) {
                        lp.topMargin = targetTop
                        floatingBubble.layoutParams = lp
                    }
                }
            }
            insets
        }

        setContentView(root)
        root.post { root.requestApplyInsets() }

        updateStoreChipStyles()
        updatePesticideButtonStyle()
        setBubbleIdleState()

        val wv = attachFreshWebView()
        val initialSearchQuery = intent?.getStringExtra(EXTRA_SEARCH_QUERY)?.trim().orEmpty()
        val startUrl = when {
            initialSearchQuery.isNotEmpty() ->
                validatedRetailerUrl(ScanHistoryStore.storeSearchUrl(activeStore.key, initialSearchQuery)) ?: activeStore.homeUrl
            else ->
                validatedRetailerUrl(intent?.getStringExtra(EXTRA_INITIAL_URL)) ?: activeStore.homeUrl
        }
        wv.loadUrl(startUrl)
        syncBackCallback()
    }

    private fun buildHeaderBar(): LinearLayout {
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            elevation = dp(3).toFloat()
        }

        val topRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(8), dp(10), dp(6))
        }

        val closeBtn = label("← HeyBroc", 12.5f, 0xFF0F172A.toInt(), bold = true).apply {
            setPadding(dp(10), dp(7), dp(10), dp(7))
            background = GradientDrawable().apply {
                setColor(0xFFF1F5F9.toInt())
                cornerRadius = dp(10).toFloat()
            }
            setOnClickListener { finish() }
        }
        topRow.addView(closeBtn, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { marginEnd = dp(6) })

        val backPageBtn = label("‹", 19f, 0xFF0F172A.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                setColor(0xFFF1F5F9.toInt())
                cornerRadius = dp(10).toFloat()
            }
            setOnClickListener {
                if (storeWebView?.canGoBack() == true) {
                    storeWebView?.goBack()
                }
            }
        }
        topRow.addView(backPageBtn, LinearLayout.LayoutParams(dp(32), dp(32)).apply { marginEnd = dp(8) })

        val titleView = label("🥦 Live Shop", 14.5f, 0xFF0C6540.toInt(), bold = true).apply {
            setSingleLine(true)
            ellipsize = TextUtils.TruncateAt.END
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        topRow.addView(titleView)

        pesticideButton = label("🌱 Pest: OFF", 11.5f, 0xFF475569.toInt(), bold = true).apply {
            setPadding(dp(9), dp(7), dp(9), dp(7))
            setOnClickListener {
                togglePesticideWatch()
                updatePesticideButtonStyle()
                lastScannedKey = ""
                badgeBatchGeneration++
                cardJsonById.clear()
                storeWebView?.evaluateJavascript(
                    "window.__heybrocRefreshPhotoBadges && window.__heybrocRefreshPhotoBadges();",
                    null
                )
                if (lastDetectedTitle.isNotBlank() || lastDetectedBarcode.isNotBlank()) {
                    runLiveScan(
                        lastDetectedTitle,
                        lastDetectedIngredients,
                        lastDetectedBarcode,
                        instacartSlug = lastDetectedInstacartSlug,
                        isCardScan = lastDetectedIsCard,
                        force = true
                    )
                } else {
                    latestScanJson?.let { prev ->
                        ScanApi.applyLocalWatchlistToData(this@LiveStoreBrowserActivity, prev)
                        applyJsonToBubble(prev)
                    }
                }
            }
        }
        topRow.addView(pesticideButton, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { marginEnd = dp(6) })

        val reloadBtn = label("↻", 16f, 0xFF0F172A.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                setColor(0xFFF1F5F9.toInt())
                cornerRadius = dp(10).toFloat()
            }
            setOnClickListener { storeWebView?.reload() }
        }
        topRow.addView(reloadBtn, LinearLayout.LayoutParams(dp(32), dp(32)))

        header.addView(topRow)

        val chipScroll = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            setPadding(dp(10), dp(2), dp(10), dp(7))
            clipToPadding = false
        }
        val chipRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        STORES.forEachIndexed { idx, store ->
            val handle = StoreBrandIcons.buildStoreChip(
                context = this,
                storeKey = store.key,
                labelText = store.label,
                selected = store.key == activeStore.key,
                iconSizeDp = 19,
                textSizeSp = 12.5f,
                padHdp = 10,
                padVdp = 5,
                selectedBgColor = 0xFF0F7A4A.toInt(),
                unselectedBgColor = 0xFFF8FAFC.toInt(),
                unselectedStrokeColor = 0xFFD9E2EC.toInt(),
                unselectedTextColor = 0xFF334155.toInt()
            )
            handle.container.setOnClickListener { switchActiveStore(store) }
            storeChipViews[store.key] = handle
            chipRow.addView(handle.container, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                if (idx < STORES.lastIndex) marginEnd = dp(6)
            })
        }
        chipScroll.addView(chipRow)
        header.addView(chipScroll)

        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = 0
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2))
        }
        header.addView(progressBar)

        return header
    }

    private fun switchActiveStore(chosen: LiveStoreConfig) {
        activeStore = chosen
        getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
            .edit()
            .putString("preferredStore", chosen.key)
            .apply()
        updateStoreChipStyles()
        lastDetectedInstacartSlug = ""
        lastScannedKey = ""
        latestScanJson = null
        badgeBatchGeneration++
        cardJsonById.clear()
        setBubbleIdleState()
        storeWebView?.loadUrl(chosen.homeUrl)
    }

    private fun updateStoreChipStyles() {
        for ((key, handle) in storeChipViews) {
            val selected = key == activeStore.key
            handle.labelView.setTextColor(if (selected) Color.WHITE else 0xFF334155.toInt())
            handle.container.background = GradientDrawable().apply {
                setColor(if (selected) 0xFF0F7A4A.toInt() else 0xFFF8FAFC.toInt())
                setStroke(dp(1), if (selected) 0xFF0F7A4A.toInt() else 0xFFD9E2EC.toInt())
                cornerRadius = dp(999).toFloat()
            }
        }
    }

    private fun updatePesticideButtonStyle() {
        val on = isPesticideWatchEnabled()
        pesticideButton.text = if (on) "🌱 Pest: ON" else "🌱 Pest: OFF"
        pesticideButton.setTextColor(if (on) 0xFF0C6540.toInt() else 0xFF475569.toInt())
        pesticideButton.background = GradientDrawable().apply {
            setColor(if (on) 0xFFECFDF5.toInt() else 0xFFF1F5F9.toInt())
            setStroke(dp(1), if (on) 0xFF22C55E.toInt() else 0xFFD9E2EC.toInt())
            cornerRadius = dp(10).toFloat()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun attachFreshWebView(): WebView {
        storeWebView?.let { old ->
            runCatching {
                old.stopLoading()
                old.removeJavascriptInterface("heybrocAndroidBridge")
                webContainer.removeView(old)
                old.destroy()
            }
        }

        val secBytes = ByteArray(16)
        SecureRandom().nextBytes(secBytes)
        currentBridgeSecret = secBytes.joinToString("") { "%02x".format(it) }
        val detectorJs = buildDetectorJs(currentBridgeSecret)
        lastInjectedProgressUrl = ""
        lastVisitedHistoryUrl = ""

        val wv = WebView(this)
        wv.layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )

        val settings = wv.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.loadsImagesAutomatically = true
        settings.mediaPlaybackRequiresUserGesture = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.safeBrowsingEnabled = true
        }
        settings.setSupportMultipleWindows(true)
        // Strip "; wv" token so modern mobile retailer storefronts don't serve degraded WebView-blocked interstitials
        val rawUa = settings.userAgentString.orEmpty()
        if (rawUa.contains("; wv")) {
            settings.userAgentString = rawUa.replace("; wv", "")
        }

        runCatching {
            val cm = CookieManager.getInstance()
            cm.setAcceptCookie(true)
            cm.setAcceptThirdPartyCookies(wv, true)
        }

        wv.addJavascriptInterface(AndroidStoreBridge(), "heybrocAndroidBridge")

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val uri = request?.url ?: return false
                val scheme = uri.scheme?.lowercase().orEmpty()
                val isMainFrame = request.isForMainFrame
                if (scheme != "https" && scheme != "http" && scheme != "about" && scheme != "blob" && scheme != "data") {
                    // Block custom app schemes (walmart://, intent://, market://) so shopping stays inside HeyBroc
                    return true
                }
                val host = uri.host?.lowercase().orEmpty()
                if (isBlockedAppRedirectHost(host)) {
                    return true
                }
                if (isMainFrame) {
                    if (scheme == "http") {
                        val upgraded = uri.buildUpon().scheme("https").build().toString()
                        val safeUpgraded = validatedRetailerUrl(upgraded)
                        if (safeUpgraded != null) {
                            view?.loadUrl(safeUpgraded)
                        }
                        return true
                    }
                    if (scheme == "https" && !isAllowedNavigationHost(host)) {
                        return true
                    }
                }
                return false
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                if (isCleaningUp) return
                scanGeneration++
                badgeBatchGeneration++
                cardJsonById.clear()
                lastInjectedProgressUrl = ""
                lastVisitedHistoryUrl = url.orEmpty()
                syncBackCallback()
                val host = runCatching { Uri.parse(url.orEmpty()).host }.getOrNull()
                if (isAllowedRetailerHost(host)) {
                    view?.evaluateJavascript(EARLY_BANNER_CSS_JS, null)
                }
            }

            override fun onPageCommitVisible(view: WebView?, url: String?) {
                super.onPageCommitVisible(view, url)
                if (isCleaningUp) return
                val host = runCatching { Uri.parse(url.orEmpty()).host }.getOrNull()
                if (isAllowedRetailerHost(host)) {
                    view?.evaluateJavascript(EARLY_BANNER_CSS_JS, null)
                    view?.evaluateJavascript(detectorJs, null)
                    syncBubbleYToWebView(triggerRescan = true)
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                if (isCleaningUp) return
                syncBackCallback()
                runCatching { CookieManager.getInstance().flush() }
                val host = runCatching { Uri.parse(url.orEmpty()).host }.getOrNull()
                if (isAllowedRetailerHost(host)) {
                    view?.evaluateJavascript(EARLY_BANNER_CSS_JS, null)
                    view?.evaluateJavascript(detectorJs, null)
                    syncBubbleYToWebView(triggerRescan = true)
                }
            }

            override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
                super.doUpdateVisitedHistory(view, url, isReload)
                if (!isCleaningUp) {
                    val curUrl = url.orEmpty()
                    if (curUrl.isNotEmpty() && curUrl != lastVisitedHistoryUrl) {
                        lastVisitedHistoryUrl = curUrl
                        lastInjectedProgressUrl = ""
                        badgeBatchGeneration++
                        cardJsonById.clear()
                    }
                    syncBackCallback()
                    val host = runCatching { Uri.parse(curUrl).host }.getOrNull()
                    if (isAllowedRetailerHost(host)) {
                        view?.evaluateJavascript(EARLY_BANNER_CSS_JS, null)
                        view?.evaluateJavascript(detectorJs, null)
                    }
                }
            }

            override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                if (isCleaningUp || isFinishing || isDestroyed) return true
                val fallbackUrl = validatedRetailerUrl(view?.url) ?: activeStore.homeUrl
                mainHandler.post {
                    if (!isCleaningUp && !isFinishing && !isDestroyed) {
                        val fresh = attachFreshWebView()
                        fresh.loadUrl(fallbackUrl)
                    }
                }
                return true
            }
        }

        wv.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (isCleaningUp) return
                progressBar.progress = newProgress.coerceIn(0, 100)
                progressBar.alpha = if (newProgress >= 99) 0f else 1f
                if (newProgress in 40..98) {
                    val curUrl = view?.url.orEmpty()
                    val host = runCatching { Uri.parse(curUrl).host }.getOrNull()
                    if (isAllowedRetailerHost(host)) {
                        view?.evaluateJavascript(EARLY_BANNER_CSS_JS, null)
                        if (newProgress >= 55 && curUrl.isNotEmpty() && curUrl != lastInjectedProgressUrl) {
                            lastInjectedProgressUrl = curUrl
                            view?.evaluateJavascript(detectorJs, null)
                        }
                    }
                }
            }

            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: android.os.Message?
            ): Boolean {
                if (!isUserGesture || view == null || resultMsg == null) return false
                val hit = view.hitTestResult
                val extra = hit.extra
                val safeUrl = validatedRetailerUrl(extra)
                if (safeUrl != null) {
                    view.loadUrl(safeUrl)
                    return false
                }
                val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
                val tempWv = WebView(this@LiveStoreBrowserActivity)
                tempWv.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView?, req: WebResourceRequest?): Boolean {
                        val target = validatedRetailerUrl(req?.url?.toString())
                        if (target != null && !isCleaningUp) {
                            view.loadUrl(target)
                        }
                        runCatching { v?.destroy() }
                        return true
                    }
                }
                transport.webView = tempWv
                resultMsg.sendToTarget()
                return true
            }
        }

        webContainer.addView(wv)
        storeWebView = wv
        return wv
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun setupFloatingBubble(root: FrameLayout) {
        bubbleTopPx = dp(185) + topSystemInsetPx
        floatingBubble = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(9), dp(14), dp(9))
            elevation = dp(10).toFloat()
            background = pillBackground(0xF20F172A.toInt())
        }

        floatingBubble.addView(ImageView(this).apply {
            setImageResource(R.drawable.broc_mascot)
            scaleType = ImageView.ScaleType.FIT_CENTER
            layoutParams = LinearLayout.LayoutParams(dp(26), dp(26)).apply { marginEnd = dp(8) }
        })

        val textStack = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        bubbleBadgeLabel = label("HeyBroc Ready", 13.5f, Color.WHITE, bold = true).apply {
            setSingleLine(true)
            ellipsize = TextUtils.TruncateAt.END
            maxWidth = dp(190)
        }
        bubbleSubLabel = label("Open any food or tap to inspect", 10.5f, 0xE0FFFFFF.toInt(), bold = true).apply {
            setSingleLine(true)
            ellipsize = TextUtils.TruncateAt.END
            maxWidth = dp(190)
        }
        textStack.addView(bubbleBadgeLabel)
        textStack.addView(bubbleSubLabel)
        floatingBubble.addView(textStack)

        val lp = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.TOP or Gravity.END
        ).apply {
            topMargin = bubbleTopPx
            marginEnd = dp(12)
            marginStart = dp(12)
        }
        root.addView(floatingBubble, lp)

        var downRawX = 0f
        var downRawY = 0f
        var startTop = 0
        var moved = false
        val slop = dp(12)

        floatingBubble.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = e.rawX
                    downRawY = e.rawY
                    startTop = (v.layoutParams as FrameLayout.LayoutParams).topMargin
                    moved = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downRawX
                    val dy = e.rawY - downRawY
                    if (!moved && (abs(dx) > slop || abs(dy) > slop)) {
                        moved = true
                        userDraggedBubble = true
                    }
                    if (moved) {
                        val parentH = root.height.coerceAtLeast(dp(360))
                        val minTop = dp(96) + topSystemInsetPx
                        val maxTop = (parentH - v.height - dp(24) - bottomSystemInsetPx).coerceAtLeast(minTop + dp(20))
                        val curLp = v.layoutParams as FrameLayout.LayoutParams
                        curLp.topMargin = (startTop + dy.toInt()).coerceIn(minTop, maxTop)
                        bubbleTopPx = curLp.topMargin
                        v.translationX = dx * 0.35f
                        v.layoutParams = curLp
                    }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    v.animate().translationX(0f).setDuration(140L).start()
                    if (moved) {
                        val parentW = root.width.coerceAtLeast(dp(320))
                        val snapLeft = e.rawX < parentW * 0.5f
                        isDockedLeft = snapLeft
                        val curLp = v.layoutParams as FrameLayout.LayoutParams
                        curLp.gravity = Gravity.TOP or (if (snapLeft) Gravity.START else Gravity.END)
                        v.layoutParams = curLp
                        syncBubbleYToWebView(triggerRescan = true)
                    } else if (e.actionMasked == MotionEvent.ACTION_UP) {
                        onFloatingBubbleTapped()
                    }
                    true
                }
                else -> false
            }
        }
    }

    private fun pillBackground(colorInt: Int, strokeColorInt: Int = 0x44FFFFFF): GradientDrawable = GradientDrawable().apply {
        setColor(colorInt)
        cornerRadius = dp(999).toFloat()
        setStroke(dp(if (strokeColorInt != 0x44FFFFFF) 2 else 1), strokeColorInt)
    }

    private fun setBubbleIdleState() {
        floatingBubble.background = pillBackground(0xF20F172A.toInt())
        bubbleBadgeLabel.text = "HeyBroc Ready"
        bubbleSubLabel.text = "Scroll or open any food item"
    }

    private fun setBubbleScanningState() {
        floatingBubble.background = pillBackground(0xF20F7A4A.toInt())
        bubbleBadgeLabel.text = "Scanning Label…"
        bubbleSubLabel.text = "Checking 0–100 score"
    }

    private fun applyJsonToBubble(scanJson: JSONObject) {
        latestScanJson = scanJson
        val prod = scanJson.optJSONObject("product")
        val res = scanJson.optJSONObject("result") ?: return
        val score = res.optInt("score", 0).coerceIn(0, 100)
        val rating = res.optString("rating").ifBlank {
            when {
                score >= 75 -> "Excellent"
                score >= 50 -> "Good"
                score >= 25 -> "Mediocre"
                else -> "Bad"
            }
        }
        val title = prod?.optString("title").orEmpty().trim()
        val shortTitle = if (title.length <= 20) title else "${title.take(19).trimEnd()}…"
        val alerts = ScanApi.evaluateDietaryAlerts(this, prod, res, scanJson)
        val severity = ScanApi.classifyAlertSeverity(alerts)
        val hasSwap = scanJson.optJSONObject("swap") != null && score < 75
        val scoreBg = when {
            score >= 75 -> 0xF516A34A.toInt()
            score >= 50 -> 0xF5D97706.toInt()
            else -> 0xF5DC2626.toInt()
        }

        if (alerts.isNotEmpty()) {
            val bubbleBg = if (severity == "allergen") 0xF5DC2626.toInt() else scoreBg
            val bubbleStroke = if (severity == "allergen") 0x44FFFFFF else 0xFFFBBF24.toInt()
            floatingBubble.background = pillBackground(bubbleBg, bubbleStroke)
            bubbleBadgeLabel.text = "⚠️ ${alerts.first().shortBadge} • $score/100"
            bubbleSubLabel.text = if (lastDetectedIsCard && shortTitle.isNotEmpty()) {
                "$shortTitle • Tap"
            } else if (hasSwap) {
                "Tap for Clean Swap"
            } else {
                "Tap to inspect alert"
            }
            return
        }

        floatingBubble.background = pillBackground(scoreBg)
        bubbleBadgeLabel.text = "$score/100 • $rating"
        bubbleSubLabel.text = when {
            lastDetectedIsCard && shortTitle.isNotEmpty() -> "$shortTitle • Tap"
            hasSwap -> "Tap for 1-Tap Clean Swap"
            else -> "Tap to inspect ingredients"
        }
    }

    private fun syncBubbleYToWebView(triggerRescan: Boolean) {
        val wv = storeWebView ?: return
        if (isCleaningUp || wv.height <= 40) return
        val wvLoc = IntArray(2)
        val bubLoc = IntArray(2)
        wv.getLocationOnScreen(wvLoc)
        floatingBubble.getLocationOnScreen(bubLoc)
        val density = resources.displayMetrics.density.coerceAtLeast(1f)
        val centerCssY = (((bubLoc[1] + floatingBubble.height * 0.5f) - wvLoc[1]) / density).toInt().coerceAtLeast(50)
        if (!triggerRescan && abs(centerCssY - lastSyncedBubbleY) < 6) return
        lastSyncedBubbleY = centerCssY
        val rescanCall = if (triggerRescan) {
            "if (typeof window.__heybrocScheduleCheck === 'function') { window.__heybrocScheduleCheck(false); }"
        } else ""
        wv.evaluateJavascript("window.__heybrocBubbleCenterY = $centerCssY; $rescanCall", null)
    }

    private fun onFloatingBubbleTapped() {
        val current = latestScanJson
        if (current != null && current.optBoolean("ok", false)) {
            presentInspectSheet(current)
            return
        }
        if (cardJsonById.isNotEmpty()) {
            presentVisibleGridDrawer()
            return
        }
        Toast.makeText(
            this,
            "Scroll to food cards (tap any 🥦 score badge!) or tap into a product on ${activeStore.label}.",
            Toast.LENGTH_SHORT
        ).show()
    }

    private fun runLiveScan(
        title: String,
        ingredients: String,
        barcode: String,
        instacartSlug: String = "",
        isCardScan: Boolean = false,
        force: Boolean = false
    ) {
        val wlSig = ScanApi.currentWatchlistSignature(this)
        val dedupeKey = "${activeStore.apiStoreKey}|${activeStore.storeBucket}|$instacartSlug|${title.lowercase()}|$barcode|${ingredients.hashCode()}|$wlSig"
        if (!force && dedupeKey == lastScannedKey) return
        lastScannedKey = dedupeKey
        val gen = ++scanGeneration
        if (!isCardScan || latestScanJson == null) {
            setBubbleScanningState()
        }
        val appCtx = applicationContext
        val apiStore = activeStore.apiStoreKey
        val bucket = activeStore.storeBucket

        ioExecutor.execute {
            val raw = runCatching {
                ScanApi.scan(
                    ctx = appCtx,
                    productTitle = title,
                    rawIngredients = ingredients.ifBlank { null },
                    store = apiStore,
                    storeBucket = bucket,
                    instacartRetailerSlug = instacartSlug,
                    barcode = barcode.ifBlank { null }
                )
            }.getOrNull()
            val parsed = runCatching {
                if (raw != null && raw.startsWith("{")) JSONObject(raw) else null
            }.getOrNull()
            mainHandler.post {
                if (isCleaningUp || isFinishing || isDestroyed || gen != scanGeneration) return@post
                if (parsed != null && parsed.optBoolean("ok", false) && parsed.optJSONObject("result") != null) {
                    if (isCardScan && parsed.optBoolean("isCategoryEstimate", false)) {
                        if (latestScanJson == null) setBubbleIdleState()
                        return@post
                    }
                    ScanApi.applyLocalWatchlistToData(this, parsed)
                    if (!isCardScan) {
                        runCatching { ScanHistoryStore.recordScan(this, parsed, apiStore) }
                    }
                    applyJsonToBubble(parsed)
                } else if (latestScanJson == null) {
                    setBubbleIdleState()
                }
            }
        }
    }

    private inner class AndroidStoreBridge {
        @JavascriptInterface
        fun postMessage(rawJson: String?) {
            if (rawJson.isNullOrBlank() || rawJson.length > 64_000) return
            val obj = runCatching { JSONObject(rawJson) }.getOrNull() ?: return
            val providedSec = obj.optString("_hbSec")
            val kind = obj.optString("kind")
            if (kind.isEmpty() || providedSec.isEmpty()) return

            mainHandler.post {
                if (isCleaningUp || isFinishing || isDestroyed) return@post
                val expectedSec = currentBridgeSecret
                if (
                    expectedSec.isEmpty() ||
                    !MessageDigest.isEqual(
                        providedSec.toByteArray(Charsets.UTF_8),
                        expectedSec.toByteArray(Charsets.UTF_8)
                    )
                ) {
                    return@post
                }
                val activeUrl = storeWebView?.url.orEmpty()
                val activeUri = runCatching { Uri.parse(activeUrl) }.getOrNull()
                if (activeUri?.scheme?.lowercase() != "https" || !isAllowedRetailerHost(activeUri.host)) {
                    return@post
                }
                val isInstacartHost = activeUri.host?.lowercase()?.let {
                    it == "instacart.com" || it.endsWith(".instacart.com")
                } == true

                when (kind) {
                    "product", "card" -> {
                        val title = obj.optString("title").trim()
                        if (title.isEmpty()) return@post
                        val ingredients = obj.optString("ingredients").trim()
                        val barcode = obj.optString("barcode").trim()
                        val rawSlug = obj.optString("instacartSlug").trim()
                        val effectiveSlug = when {
                            rawSlug.isNotEmpty() -> rawSlug
                            isInstacartHost -> lastDetectedInstacartSlug
                            else -> ""
                        }
                        val isCard = (kind == "card")
                        lastDetectedIsCard = isCard
                        lastDetectedTitle = title
                        lastDetectedIngredients = ingredients
                        lastDetectedBarcode = barcode
                        lastDetectedInstacartSlug = effectiveSlug
                        runLiveScan(
                            title,
                            ingredients,
                            barcode,
                            instacartSlug = effectiveSlug,
                            isCardScan = isCard
                        )
                    }
                    "browse" -> {
                        scanGeneration++
                        lastDetectedIsCard = false
                        lastDetectedTitle = ""
                        lastDetectedIngredients = ""
                        lastDetectedBarcode = ""
                        val browseSlug = obj.optString("instacartSlug").trim()
                        if (browseSlug.isNotEmpty()) {
                            lastDetectedInstacartSlug = browseSlug
                        } else if (!isInstacartHost) {
                            lastDetectedInstacartSlug = ""
                        }
                        lastScannedKey = ""
                        latestScanJson = null
                        setBubbleIdleState()
                    }
                    "gridBatch" -> {
                        val pageToken = obj.optString("pageToken").trim()
                        val quotedToken = JSONObject.quote(pageToken)
                        val arr = obj.optJSONArray("items")
                        if (arr == null) {
                            storeWebView?.evaluateJavascript(
                                "window.__heybrocApplyCardBadges && window.__heybrocApplyCardBadges({}, $quotedToken);",
                                null
                            )
                            return@post
                        }
                        val rawSlug = obj.optString("instacartSlug").trim()
                        val instacartSlug = when {
                            rawSlug.isNotEmpty() -> {
                                lastDetectedInstacartSlug = rawSlug
                                rawSlug
                            }
                            isInstacartHost -> lastDetectedInstacartSlug
                            else -> ""
                        }
                        val batchReq = ArrayList<ScanApi.BatchScanRequestItem>()
                        for (i in 0 until minOf(arr.length(), 8)) {
                            val it = arr.optJSONObject(i) ?: continue
                            val id = it.optString("id").trim()
                            val pTitle = it.optString("productTitle").trim()
                            if (VALID_BATCH_ID_RE.matches(id) && pTitle.isNotEmpty()) {
                                batchReq.add(ScanApi.BatchScanRequestItem(id, pTitle))
                            }
                        }
                        if (batchReq.isEmpty()) {
                            storeWebView?.evaluateJavascript(
                                "window.__heybrocApplyCardBadges && window.__heybrocApplyCardBadges({}, $quotedToken);",
                                null
                            )
                            return@post
                        }
                        val gen = badgeBatchGeneration
                        val apiStore = activeStore.apiStoreKey
                        val bucket = activeStore.storeBucket
                        val appCtx = applicationContext
                        ioExecutor.execute {
                            val outcome = ScanApi.scanBatchOutcome(
                                ctx = appCtx,
                                items = batchReq,
                                store = apiStore,
                                storeBucket = bucket,
                                instacartRetailerSlug = instacartSlug
                            )
                            mainHandler.post {
                                if (isCleaningUp || isFinishing || isDestroyed) return@post
                                if (gen != badgeBatchGeneration) {
                                    storeWebView?.evaluateJavascript(
                                        "window.__heybrocApplyCardBadges && window.__heybrocApplyCardBadges({}, $quotedToken);",
                                        null
                                    )
                                    return@post
                                }
                                val jsMap = JSONObject()
                                for (reqItem in batchReq) {
                                    val hit = outcome.results[reqItem.id]
                                    if (hit != null) {
                                        if (!hit.isCategoryEstimate) {
                                            cardJsonById[reqItem.id] = hit.fullJson
                                        }
                                        jsMap.put(reqItem.id, JSONObject().apply {
                                            put("ok", true)
                                            put("score", hit.score)
                                            put("hasAlert", hit.dietaryAlerts.isNotEmpty())
                                            put("alertSeverity", hit.alertSeverity)
                                            put("isCategoryEstimate", hit.isCategoryEstimate)
                                        })
                                    } else {
                                        jsMap.put(reqItem.id, JSONObject().apply {
                                            put("ok", false)
                                            if (outcome.transientFailure) put("transient", true)
                                        })
                                    }
                                }
                                storeWebView?.evaluateJavascript(
                                    "window.__heybrocApplyCardBadges && window.__heybrocApplyCardBadges($jsMap, $quotedToken);",
                                    null
                                )
                            }
                        }
                    }
                    "inspectCard" -> {
                        val cardId = obj.optString("cardId").trim()
                        val title = obj.optString("title").trim()
                        val rawSlug = obj.optString("instacartSlug").trim()
                        val instacartSlug = when {
                            rawSlug.isNotEmpty() -> rawSlug
                            isInstacartHost -> lastDetectedInstacartSlug
                            else -> ""
                        }
                        val cached = if (VALID_BATCH_ID_RE.matches(cardId)) cardJsonById[cardId] else null
                        if (cached != null) {
                            ScanApi.applyLocalWatchlistToData(this@LiveStoreBrowserActivity, cached)
                            applyJsonToBubble(cached)
                            presentInspectSheet(cached)
                        } else if (title.isNotEmpty()) {
                            setBubbleScanningState()
                            val apiStore = activeStore.apiStoreKey
                            val bucket = activeStore.storeBucket
                            val appCtx = applicationContext
                            ioExecutor.execute {
                                val raw = runCatching {
                                    ScanApi.scan(
                                        ctx = appCtx,
                                        productTitle = title,
                                        rawIngredients = null,
                                        store = apiStore,
                                        storeBucket = bucket,
                                        instacartRetailerSlug = instacartSlug
                                    )
                                }.getOrNull()
                                val parsed = runCatching {
                                    if (raw != null && raw.startsWith("{")) JSONObject(raw) else null
                                }.getOrNull()
                                mainHandler.post {
                                    if (isCleaningUp || isFinishing || isDestroyed) return@post
                                    if (parsed != null && parsed.optBoolean("ok", false) && parsed.optJSONObject("result") != null) {
                                        ScanApi.applyLocalWatchlistToData(this@LiveStoreBrowserActivity, parsed)
                                        if (VALID_BATCH_ID_RE.matches(cardId) && !parsed.optBoolean("isCategoryEstimate", false)) {
                                            cardJsonById[cardId] = parsed
                                        }
                                        applyJsonToBubble(parsed)
                                        presentInspectSheet(parsed)
                                    } else {
                                        setBubbleIdleState()
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private fun presentVisibleGridDrawer() {
        inspectDialog?.dismiss()
        val sorted = cardJsonById.values
            .filter { !it.optBoolean("isCategoryEstimate", false) && it.optJSONObject("result") != null }
            .distinctBy { it.optJSONObject("product")?.optString("title").orEmpty().lowercase().trim() }
            .sortedByDescending { it.optJSONObject("result")?.optInt("score", 0) ?: 0 }
        if (sorted.isEmpty()) return

        val dlg = Dialog(this)
        dlg.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(22))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadii = floatArrayOf(dp(24).toFloat(), dp(24).toFloat(), dp(24).toFloat(), dp(24).toFloat(), 0f, 0f, 0f, 0f)
            }
        }
        sheet.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(label("📍 Visible on ${activeStore.label} (${sorted.size})", 16.5f, 0xFF0F172A.toInt(), bold = true).apply {
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            addView(label("✕", 18f, 0xFF64748B.toInt(), bold = true).apply {
                setPadding(dp(8), dp(4), dp(4), dp(4))
                setOnClickListener { dlg.dismiss() }
            })
        })
        sheet.addView(label("Ranked Cleanest → Worst · Tap any item to inspect or swap", 12f, 0xFF64748B.toInt()).apply {
            setPadding(0, dp(2), 0, dp(10))
        })

        val scroll = ScrollView(this)
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        for (item in sorted.take(16)) {
            val prod = item.optJSONObject("product")
            val res = item.optJSONObject("result") ?: continue
            val sc = res.optInt("score", 0).coerceIn(0, 100)
            val title = prod?.optString("title").orEmpty().ifBlank { "Food Item" }
            val dotColor = when {
                sc >= 75 -> 0xFF16A34A.toInt()
                sc >= 50 -> 0xFFD97706.toInt()
                else -> 0xFFDC2626.toInt()
            }
            list.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(12), dp(10), dp(12), dp(10))
                background = GradientDrawable().apply {
                    setColor(0xFFF8FAFC.toInt())
                    setStroke(dp(1), 0xFFE2E8F0.toInt())
                    cornerRadius = dp(14).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(8) }
                addView(label("$sc", 13.5f, Color.WHITE, bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(9), dp(4), dp(9), dp(4))
                    background = GradientDrawable().apply {
                        setColor(dotColor)
                        cornerRadius = dp(999).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { marginEnd = dp(10) }
                })
                addView(label(title, 13.5f, 0xFF0F172A.toInt(), bold = true).apply {
                    maxLines = 2
                    ellipsize = TextUtils.TruncateAt.END
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                })
                addView(label("Inspect ›", 12f, 0xFF0F7A4A.toInt(), bold = true).apply {
                    setPadding(dp(8), dp(4), dp(2), dp(4))
                })
                setOnClickListener {
                    dlg.dismiss()
                    presentInspectSheet(item)
                }
            })
        }
        scroll.addView(list)
        sheet.addView(scroll, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            (resources.displayMetrics.heightPixels * 0.55f).toInt()
        ))

        dlg.setContentView(sheet)
        dlg.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            setGravity(Gravity.BOTTOM)
        }
        inspectDialog = dlg
        dlg.show()
    }

    private fun presentInspectSheet(scanJson: JSONObject) {
        inspectDialog?.dismiss()
        ScanApi.applyLocalWatchlistToData(this, scanJson)
        val prod = scanJson.optJSONObject("product")
        val res = scanJson.optJSONObject("result") ?: return
        val title = ScanHistoryStore.cleanDisplayTitle(prod?.optString("title").orEmpty().ifBlank { "Food Item" })
        val brand = prod?.optString("brand").orEmpty()
        val isCategoryEstimate = scanJson.optBoolean("isCategoryEstimate", false)
        val score = res.optInt("score", 0).coerceIn(0, 100)
        val rating = res.optString("rating").ifBlank {
            when {
                score >= 75 -> "Excellent"
                score >= 50 -> "Good"
                score >= 25 -> "Mediocre"
                else -> "Bad"
            }
        }
        val scoreColor = when {
            score >= 75 -> 0xFF16A34A.toInt()
            score >= 50 -> 0xFFD97706.toInt()
            else -> 0xFFDC2626.toInt()
        }
        val breakdown = res.optJSONObject("yukaBreakdown")
        val nutScore = breakdown?.optInt("nutritionScore", -1) ?: -1
        val addScore = breakdown?.optInt("additiveScore", -1) ?: -1
        val orgScore = breakdown?.optInt("organicScore", -1) ?: -1
        val alerts = ScanApi.evaluateDietaryAlerts(this, prod, res, scanJson)
        val flagged = res.optJSONArray("flagged") ?: JSONArray()
        val swapObj = scanJson.optJSONObject("swap")?.let { JSONObject(it.toString()) }
        if (swapObj != null) {
            ScanHistoryStore.upgradeSwapForStore(swapObj, title, activeStore.apiStoreKey)
        }

        val dlg = Dialog(this)
        dlg.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val outer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(22))
            background = GradientDrawable().apply {
                setColor(0xFFF8FAFC.toInt())
                cornerRadii = floatArrayOf(dp(24).toFloat(), dp(24).toFloat(), dp(24).toFloat(), dp(24).toFloat(), 0f, 0f, 0f, 0f)
            }
        }

        val scroll = ScrollView(this)
        val stack = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        // Header Row: Score Pill + Title/Brand + Close
        val headerRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        headerRow.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(12), dp(8), dp(12), dp(8))
            background = GradientDrawable().apply {
                setColor(scoreColor)
                cornerRadius = dp(16).toFloat()
            }
            addView(label("$score", 22f, Color.WHITE, bold = true))
            addView(label("/100", 10f, 0xE6FFFFFF.toInt(), bold = true))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { marginEnd = dp(12) }
        })
        headerRow.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            addView(label(title, 15.5f, 0xFF0F172A.toInt(), bold = true).apply {
                maxLines = 3
                ellipsize = TextUtils.TruncateAt.END
            })
            val sub = when {
                isCategoryEstimate -> "🥦 Category Estimate · $rating"
                brand.isNotBlank() -> "$brand · $rating"
                else -> rating
            }
            addView(label(sub, 12.5f, scoreColor, bold = true).apply {
                setPadding(0, dp(2), 0, 0)
            })
        })
        headerRow.addView(label("✕", 18f, 0xFF64748B.toInt(), bold = true).apply {
            setPadding(dp(10), dp(4), dp(4), dp(4))
            setOnClickListener { dlg.dismiss() }
        })
        stack.addView(headerRow)

        // Household Allergen (red) vs Dietary Advisory (amber) Alerts
        for (alert in alerts) {
            val isAdvisory = alert.id in ScanApi.ADVISORY_ALERT_IDS
            val bgCol = if (isAdvisory) 0xFFFFFBEB.toInt() else 0xFFFEF2F2.toInt()
            val borderCol = if (isAdvisory) 0xFFF59E0B.toInt() else 0xFFFCA5A5.toInt()
            val headCol = if (isAdvisory) 0xFF92400E.toInt() else 0xFF991B1B.toInt()
            val bodyCol = if (isAdvisory) 0xFF78350F.toInt() else 0xFF7F1D1D.toInt()
            stack.addView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(12), dp(10), dp(12), dp(10))
                background = GradientDrawable().apply {
                    setColor(bgCol)
                    setStroke(dp(1), borderCol)
                    cornerRadius = dp(14).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(10) }
                addView(label("⚠️ ${alert.label}", 13f, headCol, bold = true))
                if (alert.reason.isNotBlank()) {
                    addView(label(alert.reason, 12f, bodyCol).apply {
                        setPadding(0, dp(2), 0, 0)
                    })
                }
            })
        }

        // 3-Pillar Breakdown Row
        if (nutScore >= 0 && addScore >= 0 && orgScore >= 0) {
            val pillarRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(12) }
            }
            listOf(
                Triple("Nutrition", "$nutScore/60", 0),
                Triple("Additives", "$addScore/30", 6),
                Triple("Organic", "$orgScore/10", 6)
            ).forEach { (pName, pVal, startM) ->
                pillarRow.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.CENTER
                    setPadding(dp(8), dp(9), dp(8), dp(9))
                    background = GradientDrawable().apply {
                        setColor(Color.WHITE)
                        setStroke(dp(1), 0xFFE2E8F0.toInt())
                        cornerRadius = dp(12).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                        if (startM > 0) marginStart = dp(startM)
                    }
                    addView(label(pVal, 14f, 0xFF0F172A.toInt(), bold = true))
                    addView(label(pName, 11f, 0xFF64748B.toInt(), bold = true))
                })
            }
            stack.addView(pillarRow)
        }

        // Clean Swap Card (strictly respecting server lock & weekly free swap quota)
        val swapScore = swapObj?.optInt("score", 0) ?: 0
        val rawSwapTitle = swapObj?.optString("title").orEmpty().trim()
        val serverLocked = swapObj?.optBoolean("locked", false) == true
        val hasCleanSwap = swapObj != null && score < 75 && (swapScore <= 0 || swapScore > score) && (rawSwapTitle.isNotBlank() || serverLocked)
        if (hasCleanSwap && swapObj != null) {
            val swapUnlocked = !serverLocked && ScanApi.isSwapUnlocked(this, title, rawSwapTitle)
            val canUnlockNow = swapUnlocked || (!serverLocked && ScanApi.canUseSwap(this) && rawSwapTitle.isNotBlank())
            val rem = ScanApi.swapsRemaining(this)
            val lim = ScanApi.weeklySwapsLimit(this)

            val swapCard = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(12), dp(14), dp(12))
                background = GradientDrawable().apply {
                    setColor(0xFFECFDF5.toInt())
                    setStroke(dp(1), 0xFF86EFAC.toInt())
                    cornerRadius = dp(16).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(12) }
            }
            val swapBadgeSuffix = if (swapScore > 0) " ($swapScore/100)" else ""
            swapCard.addView(label("1-TAP CLEAN SWAP FOR ${activeStore.label.uppercase()}", 10.5f, 0xFF065F46.toInt(), bold = true))
            swapCard.addView(label(
                if (swapUnlocked) rawSwapTitle + swapBadgeSuffix else "🔒 Clean Swap Available$swapBadgeSuffix",
                15f,
                0xFF064E3B.toInt(),
                bold = true
            ).apply { setPadding(0, dp(3), 0, dp(2)) })

            val reason = swapObj.optString("why").ifBlank { swapObj.optString("reason") }
            if (swapUnlocked && reason.isNotBlank()) {
                swapCard.addView(label(reason, 12f, 0xFF047857.toInt()).apply {
                    setPadding(0, 0, 0, dp(8))
                })
            }

            val ctaText = when {
                swapUnlocked -> "Shop Clean Swap on ${activeStore.label} →"
                canUnlockNow -> "🔓 Unlock & Shop Clean Swap ($rem/$lim Free)"
                else -> "🔒 Unlock Unlimited Clean Swaps — Pro"
            }
            swapCard.addView(label(ctaText, 13.5f, Color.WHITE, bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(14), dp(11), dp(14), dp(11))
                background = GradientDrawable().apply {
                    setColor(0xFF0F7A4A.toInt())
                    cornerRadius = dp(999).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(6) }
                setOnClickListener {
                    if (swapUnlocked || (canUnlockNow && ScanApi.unlockSwapForProduct(this@LiveStoreBrowserActivity, title, rawSwapTitle))) {
                        val query = swapObj.optString("searchQuery").ifBlank { rawSwapTitle }
                        ScanHistoryStore.saveSwapToFavorites(this@LiveStoreBrowserActivity, swapObj, title, activeStore.apiStoreKey)
                        val rawLink = swapObj.optString("deepLink").ifBlank { swapObj.optString("webUrl") }
                        val targetUrl = validatedRetailerUrl(rawLink)?.takeIf {
                            ScanHistoryStore.urlMatchesStore(it, activeStore.key)
                        } ?: validatedRetailerUrl(ScanHistoryStore.storeSearchUrl(activeStore.key, query))
                        dlg.dismiss()
                        if (targetUrl != null) {
                            storeWebView?.loadUrl(targetUrl)
                        }
                    } else {
                        dlg.dismiss()
                        showPaywallPrompt()
                    }
                }
            })
            stack.addView(swapCard)
        }

        // Flagged Additives / Ingredients
        if (flagged.length() > 0) {
            stack.addView(label("Flagged on Label (${flagged.length()})", 13f, 0xFF0F172A.toInt(), bold = true).apply {
                setPadding(0, dp(12), 0, dp(6))
            })
            for (i in 0 until minOf(flagged.length(), 8)) {
                val f = flagged.optJSONObject(i) ?: continue
                val fName = f.optString("name").ifBlank { f.optString("matchedText", "Additive") }
                val fRisk = f.optString("risk").ifBlank { f.optString("riskLevel").ifBlank { "Concern" } }
                val fWhy = f.optString("explanation").ifBlank { f.optString("whyItMatters") }
                stack.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(11), dp(8), dp(11), dp(8))
                    background = GradientDrawable().apply {
                        setColor(Color.WHITE)
                        setStroke(dp(1), 0xFFE2E8F0.toInt())
                        cornerRadius = dp(12).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { bottomMargin = dp(6) }
                    addView(label("• $fName ($fRisk)", 12.5f, 0xFF991B1B.toInt(), bold = true))
                    if (fWhy.isNotBlank()) {
                        addView(label(fWhy, 11.5f, 0xFF475569.toInt()).apply {
                            setPadding(0, dp(2), 0, 0)
                        })
                    }
                })
            }
        } else {
            stack.addView(label("✓ Zero flagged high-risk additives detected on this label.", 12.5f, 0xFF15803D.toInt(), bold = true).apply {
                setPadding(0, dp(12), 0, dp(4))
            })
        }

        scroll.addView(stack)
        val maxSheetH = (resources.displayMetrics.heightPixels * 0.72f).toInt()
        outer.addView(scroll, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        dlg.setContentView(outer)
        dlg.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            attributes = attributes?.apply { height = WindowManager.LayoutParams.WRAP_CONTENT }
            setGravity(Gravity.BOTTOM)
        }
        outer.post {
            if (outer.height > maxSheetH) {
                dlg.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, maxSheetH)
            }
        }
        inspectDialog = dlg
        dlg.show()
    }

    private fun showPaywallPrompt() {
        ScanApi.trackEvent(this, "paywall_viewed")
        val limit = ScanApi.weeklySwapsLimit(this)
        val builder = AlertDialog.Builder(this)
            .setTitle(ScanApi.paywallHeadline(this))
            .setMessage(
                "You've used all $limit free single-item Clean Swaps.\n\n" +
                    "Product scores (0–100) stay 100% free forever. Invite friends for free Pro weeks or sign in to an existing Pro account."
            )
            .setNegativeButton("Close", null)
        if (!isInstalledFromPlayStore()) {
            builder.setPositiveButton("Upgrade to Pro") { _, _ ->
                ScanApi.trackEvent(this, "checkout_started")
                runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ScanApi.upgradeUrl(this))))
                }
            }
        }
        builder.show()
    }

    private fun syncBackCallback() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val canBack = storeWebView?.canGoBack() == true
            if (canBack && !backCallbackRegistered) {
                val cb = OnBackInvokedCallback {
                    if (storeWebView?.canGoBack() == true) {
                        storeWebView?.goBack()
                    } else {
                        finish()
                    }
                }
                onBackInvokedDispatcher.registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    cb
                )
                backCallbackObj = cb
                backCallbackRegistered = true
            } else if (!canBack && backCallbackRegistered) {
                (backCallbackObj as? OnBackInvokedCallback)?.let { cb ->
                    runCatching { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(cb) }
                }
                backCallbackObj = null
                backCallbackRegistered = false
            }
        }
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (storeWebView?.canGoBack() == true) {
            storeWebView?.goBack()
            return
        }
        super.onBackPressed()
    }

    override fun onPause() {
        runCatching { CookieManager.getInstance().flush() }
        storeWebView?.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        storeWebView?.onResume()
        updatePesticideButtonStyle()
    }

    override fun onDestroy() {
        isCleaningUp = true
        inspectDialog?.dismiss()
        inspectDialog = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && backCallbackRegistered) {
            (backCallbackObj as? OnBackInvokedCallback)?.let { cb ->
                runCatching { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(cb) }
            }
            backCallbackObj = null
            backCallbackRegistered = false
        }
        mainHandler.removeCallbacksAndMessages(null)
        ioExecutor.shutdownNow()
        storeWebView?.let { wv ->
            runCatching {
                wv.stopLoading()
                wv.removeJavascriptInterface("heybrocAndroidBridge")
                webContainer.removeView(wv)
                wv.destroy()
            }
        }
        storeWebView = null
        super.onDestroy()
    }
}
