package com.cleancart.overlay

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.LruCache
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
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
import java.net.HttpURLConnection
import java.net.URL
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

        private const val PREFS_LIVE_STORE_STATE = "live_store_state"
        private const val STATE_ACTIVE_STORE_KEY = "state_active_store_key"
        private const val STATE_WEBVIEW_BUNDLE = "state_webview_bundle"

        private val ALLOWED_SSO_HOST_SUFFIXES = listOf(
            "uber.com",
            "accounts.google.com",
            "accounts.youtube.com",
            "gstatic.com",
            "googleusercontent.com",
            "appleid.apple.com",
            "login.target.com",
            "identity.walmart.com",
            "paypal.com",
            "stripe.com",
            "affirm.com",
            "klarna.com",
            "auth0.com",
            "okta.com",
            "b2clogin.com",
            "login.microsoftonline.com",
            "microsoftonline.com",
            "live.com"
        )

        private val EXTERNAL_OAUTH_HOST_SUFFIXES = setOf(
            "accounts.google.com",
            "accounts.youtube.com",
            "appleid.apple.com"
        )

        private val VALID_BATCH_ID_RE = Regex(
            "^(?!^(?:__proto__|constructor|prototype)$)[A-Za-z0-9_-]{1,40}$",
            RegexOption.IGNORE_CASE
        )

        fun isExternalOAuthHost(rawHost: String?): Boolean {
            val host = rawHost?.trim()?.lowercase().orEmpty()
            if (host.isEmpty()) return false
            return EXTERNAL_OAUTH_HOST_SUFFIXES.any { suffix ->
                host == suffix || host.endsWith(".$suffix")
            }
        }

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

        fun isSsoAuthHost(rawHost: String?): Boolean {
            val host = rawHost?.trim()?.lowercase().orEmpty()
            if (host.isEmpty()) return false
            return ALLOWED_SSO_HOST_SUFFIXES.any { suffix ->
                host == suffix || host.endsWith(".$suffix")
            }
        }

        fun isAuthLikePath(rawPath: String?): Boolean {
            val p = rawPath?.lowercase().orEmpty()
            return p.contains("/login") ||
                p.contains("/signin") ||
                p.contains("/sign-in") ||
                p.contains("/auth") ||
                p.contains("/oauth") ||
                p.contains("/sso") ||
                p.contains("/gsi/")
        }

        fun isPersistableBrowseUrl(rawUrl: String?): Boolean {
            val safe = validatedRetailerUrl(rawUrl) ?: return false
            val uri = runCatching { Uri.parse(safe) }.getOrNull() ?: return false
            val host = uri.host?.lowercase().orEmpty()
            if (isSsoAuthHost(host)) return false
            val p = uri.path?.lowercase().orEmpty()
            if (isAuthLikePath(p) || p.contains("/cart") || p.contains("/checkout")) return false
            return true
        }

        fun isAllowedNavigationHost(rawHost: String?): Boolean {
            if (isAllowedRetailerHost(rawHost)) return true
            return isSsoAuthHost(rawHost)
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
            if (isBlockedAppRedirectHost(host)) return null
            val isAffiliateRedirect =
                host == "goto.walmart.com" ||
                    host == "goto.target.com" ||
                    uri.path?.lowercase()?.startsWith("/c/") == true
            if (isAffiliateRedirect) {
                val rawInner = (uri.getQueryParameter("u") ?: uri.getQueryParameter("url"))?.trim().orEmpty()
                if (rawInner.isNotEmpty()) {
                    val decodedInner = if (
                        rawInner.startsWith("https%3A", ignoreCase = true) ||
                        rawInner.startsWith("http%3A", ignoreCase = true)
                    ) {
                        runCatching { java.net.URLDecoder.decode(rawInner, "UTF-8").trim() }.getOrDefault(rawInner)
                    } else {
                        rawInner
                    }
                    val innerUri = runCatching { Uri.parse(decodedInner) }.getOrNull()
                    val innerHost = innerUri?.host?.lowercase().orEmpty()
                    if (
                        innerUri?.scheme?.lowercase() == "https" &&
                        isAllowedRetailerHost(innerHost) &&
                        !isBlockedAppRedirectHost(innerHost)
                    ) {
                        // Return the outer affiliate wrapper intact so paid-link tracking is preserved.
                        return trimmed
                    }
                    return null
                }
                if (host == "goto.walmart.com" || host == "goto.target.com") {
                    return trimmed
                }
                return null
            }
            if (isAllowedRetailerHost(host)) return trimmed
            return null
        }

        fun validatedNavigationUrl(rawUrl: String?): String? {
            validatedRetailerUrl(rawUrl)?.let { return it }
            val trimmed = rawUrl?.trim().orEmpty()
            if (trimmed.isEmpty()) return null
            val uri = runCatching { Uri.parse(trimmed) }.getOrNull() ?: return null
            if (uri.scheme?.lowercase() != "https") return null
            val host = uri.host?.lowercase().orEmpty()
            if (!isAllowedNavigationHost(host) || isBlockedAppRedirectHost(host)) return null
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

        @Volatile
        private var cachedDetectorJsTemplate: String? = null

        private fun getDetectorJsTemplate(context: Context): String {
            cachedDetectorJsTemplate?.let { return it }
            val loaded = context.applicationContext.assets
                .open("live_store_detector.js")
                .bufferedReader(Charsets.UTF_8)
                .use { it.readText() }
            cachedDetectorJsTemplate = loaded
            return loaded
        }

        private fun buildDetectorJs(context: Context, bridgeSecret: String): String =
            getDetectorJsTemplate(context).replace("__HB_BRIDGE_SECRET__", bridgeSecret)

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

    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val ioExecutor = Executors.newFixedThreadPool(2)
    private val imageExecutor = Executors.newFixedThreadPool(2)
    private val sheetBitmapCache = SafeBitmapLoader.createBitmapLruCache(6 * 1024)
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
    private var lastDetectedStoreImageUrl = ""
    private var lastDetectedInstacartSlug = ""
    private var lastDetectedIsCard = false
    private var lastDetectedCardId = ""
    private var lastScannedKey = ""
    private var latestScanJson: JSONObject? = null
    private val cardJsonById = object : LinkedHashMap<String, JSONObject>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, JSONObject>?): Boolean = size > 160
    }
    private var scanGeneration = 0
    private var badgeBatchGeneration = 0
    private var inspectDialog: Dialog? = null
    private var authPopupDialog: Dialog? = null
    private var authPopupWebView: WebView? = null
    @Volatile
    private var isCleaningUp = false
    private var backCallbackRegistered = false
    private var backCallbackObj: Any? = null

    private fun saveLastStoreUrl(storeKey: String, rawUrl: String?) {
        if (!isPersistableBrowseUrl(rawUrl)) return
        val safe = validatedRetailerUrl(rawUrl) ?: return
        getSharedPreferences(PREFS_LIVE_STORE_STATE, Context.MODE_PRIVATE)
            .edit()
            .putString("last_url_$storeKey", safe)
            .apply()
    }

    private fun loadLastStoreUrl(storeKey: String): String? {
        val raw = getSharedPreferences(PREFS_LIVE_STORE_STATE, Context.MODE_PRIVATE)
            .getString("last_url_$storeKey", null)
        return if (isPersistableBrowseUrl(raw)) validatedRetailerUrl(raw) else null
    }

    private fun clearLastStoreUrl(storeKey: String) {
        getSharedPreferences(PREFS_LIVE_STORE_STATE, Context.MODE_PRIVATE)
            .edit()
            .remove("last_url_$storeKey")
            .apply()
    }

    private fun dismissAuthPopupDialog() {
        val dlg = authPopupDialog
        val pwv = authPopupWebView
        authPopupDialog = null
        authPopupWebView = null
        runCatching { dlg?.dismiss() }
        if (pwv != null) {
            runCatching {
                pwv.stopLoading()
                pwv.webChromeClient = null
                pwv.webViewClient = WebViewClient()
                (pwv.parent as? ViewGroup)?.removeView(pwv)
                pwv.destroy()
            }
        }
        runCatching { CookieManager.getInstance().flush() }
    }

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

    private fun sanitizeDeviceStoreImageUrl(rawUrl: String?): String {
        val safe = SafeBitmapLoader.sanitizeExternalImageUrl(rawUrl, rejectHeyBroc = true)
        if (safe.isEmpty()) return ""
        val host = runCatching { Uri.parse(safe).host?.lowercase().orEmpty() }.getOrDefault("")
        if (host.isEmpty() || isBlockedAppRedirectHost(host)) return ""
        return safe
    }

    private fun attachDeviceStoreImage(scanJson: JSONObject?, storeImgUrl: String) {
        val safeStoreImg = sanitizeDeviceStoreImageUrl(storeImgUrl)
        if (safeStoreImg.isEmpty() || scanJson == null) return
        val prod = scanJson.optJSONObject("product") ?: JSONObject().also { scanJson.put("product", it) }
        prod.put("storeImageUrl", safeStoreImg)
    }

    private fun buildSheetThumbnailBox(
        title: String,
        brand: String = "",
        barcode: String = "",
        rawImageUrl: String = "",
        storeImageUrl: String = "",
        categoryArtUrl: String = "",
        widthDp: Int = 54,
        heightDp: Int = 62
    ): FrameLayout {
        val safeStoreImg = sanitizeDeviceStoreImageUrl(storeImageUrl)
        val normalizedCatArt = ScanHistoryStore.normalizeCategoryArtUrl(categoryArtUrl)
        val bestUrl = ScanHistoryStore.resolveBestImageUrl(title, rawImageUrl, brand, barcode)
        val apiFallback = ScanHistoryStore.productImageApiFallbackUrl(title, brand, barcode)
        val candidates = buildList {
            if (safeStoreImg.isNotEmpty()) add(safeStoreImg)
            if (bestUrl.isNotEmpty()) add(bestUrl)
            if (apiFallback.isNotEmpty()) add(apiFallback)
            if (normalizedCatArt.isNotEmpty()) add(normalizedCatArt)
        }.distinct()

        val radius = dp(12).toFloat()
        val box = FrameLayout(this).apply {
            background = GradientDrawable().apply {
                setColor(0xFFF1F5F9.toInt())
                cornerRadius = radius
                setStroke(dp(1), 0xFFE2E8F0.toInt())
            }
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) {
                    outline.setRoundRect(0, 0, view.width, view.height, radius)
                }
            }
        }
        val initialTv = label(ScanHistoryStore.brandInitial(title, brand), 15f, 0xFF334155.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        val iv = ImageView(this).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
            setPadding(dp(3), dp(3), dp(3), dp(3))
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        val compactBadge = widthDp < 48
        val illustrationBadge = label(if (compactBadge) "Art" else "Illustration", if (compactBadge) 6.5f else 7f, 0xFF475569.toInt(), bold = true).apply {
            setSingleLine(true)
            setPadding(dp(if (compactBadge) 2 else 3), dp(1), dp(if (compactBadge) 2 else 3), dp(1))
            background = GradientDrawable().apply {
                setColor(0xEBFFFFFF.toInt())
                cornerRadius = dp(999).toFloat()
                setStroke(dp(1), 0xFFCBD5E1.toInt())
            }
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            ).apply { bottomMargin = dp(2) }
        }
        box.addView(initialTv)
        box.addView(iv)
        box.addView(illustrationBadge)

        for (cand in candidates) {
            sheetBitmapCache.get(cand)?.let { cached ->
                initialTv.visibility = View.GONE
                iv.setImageBitmap(cached)
                illustrationBadge.visibility =
                    if (ScanHistoryStore.isCategoryArtUrl(cand)) View.VISIBLE else View.GONE
                return box
            }
        }

        val targetPx = dp(maxOf(widthDp, heightDp) * 2).coerceIn(96, 320)
        imageExecutor.execute {
            var resolvedBmp: Bitmap? = null
            var resolvedUrl = ""
            for (cand in candidates) {
                if (isCleaningUp) return@execute
                val bmp = SafeBitmapLoader.fetchScaledBitmap(cand, targetPx)
                if (bmp != null) {
                    resolvedBmp = bmp
                    resolvedUrl = cand
                    break
                }
            }
            if (resolvedBmp != null && resolvedUrl.isNotEmpty()) {
                sheetBitmapCache.put(resolvedUrl, resolvedBmp)
                val isIll = ScanHistoryStore.isCategoryArtUrl(resolvedUrl)
                mainHandler.post {
                    if (isCleaningUp || isFinishing || isDestroyed) return@post
                    initialTv.visibility = View.GONE
                    iv.setImageBitmap(resolvedBmp)
                    illustrationBadge.visibility = if (isIll) View.VISIBLE else View.GONE
                }
            }
        }
        return box
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
        val restoredStoreKey = savedInstanceState?.getString(STATE_ACTIVE_STORE_KEY)
        val requestedKey = normalizeStoreKey(
            restoredStoreKey
                ?: intent?.getStringExtra(EXTRA_STORE_KEY)
                ?: prefs.getString("preferredStore", "walmart")
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
        val savedWvBundle = savedInstanceState?.getBundle(STATE_WEBVIEW_BUNDLE)
        val restoredHistory = savedWvBundle != null && wv.restoreState(savedWvBundle) != null
        if (!restoredHistory) {
            val initialSearchQuery = intent?.getStringExtra(EXTRA_SEARCH_QUERY)?.trim().orEmpty()
            val explicitInitialUrl = validatedRetailerUrl(intent?.getStringExtra(EXTRA_INITIAL_URL))
            val startUrl = when {
                initialSearchQuery.isNotEmpty() ->
                    validatedRetailerUrl(ScanHistoryStore.storeSearchUrl(activeStore.key, initialSearchQuery)) ?: activeStore.homeUrl
                explicitInitialUrl != null ->
                    explicitInitialUrl
                else ->
                    loadLastStoreUrl(activeStore.key) ?: activeStore.homeUrl
            }
            wv.loadUrl(startUrl)
        }
        syncBackCallback()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::activeStore.isInitialized) {
            outState.putString(STATE_ACTIVE_STORE_KEY, activeStore.key)
            saveLastStoreUrl(activeStore.key, storeWebView?.url)
        }
        storeWebView?.let { wv ->
            val wvBundle = Bundle()
            if (wv.saveState(wvBundle) != null) {
                outState.putBundle(STATE_WEBVIEW_BUNDLE, wvBundle)
            }
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent == null) return
        setIntent(intent)
        val newStoreRaw = intent.getStringExtra(EXTRA_STORE_KEY)
        val newQuery = intent.getStringExtra(EXTRA_SEARCH_QUERY)?.trim().orEmpty()
        val newExplicitUrl = validatedRetailerUrl(intent.getStringExtra(EXTRA_INITIAL_URL))
        if (!newStoreRaw.isNullOrBlank()) {
            val norm = normalizeStoreKey(newStoreRaw)
            val targetStore = STORES.firstOrNull { it.key == norm }
            if (targetStore != null && targetStore.key != activeStore.key) {
                activeStore = targetStore
                updateStoreChipStyles()
                if (newQuery.isEmpty() && newExplicitUrl == null) {
                    storeWebView?.loadUrl(loadLastStoreUrl(activeStore.key) ?: activeStore.homeUrl)
                    return
                }
            }
        }
        when {
            newQuery.isNotEmpty() -> {
                val qUrl = validatedRetailerUrl(ScanHistoryStore.storeSearchUrl(activeStore.key, newQuery)) ?: activeStore.homeUrl
                storeWebView?.loadUrl(qUrl)
            }
            newExplicitUrl != null -> {
                storeWebView?.loadUrl(newExplicitUrl)
            }
        }
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
                        storeImageUrl = lastDetectedStoreImageUrl,
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
        val wasAlreadyActive = chosen.key == activeStore.key
        dismissAuthPopupDialog()
        if (!wasAlreadyActive) {
            saveLastStoreUrl(activeStore.key, storeWebView?.url)
        }
        activeStore = chosen
        getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
            .edit()
            .putString("preferredStore", chosen.key)
            .apply()
        updateStoreChipStyles()
        lastDetectedStoreImageUrl = ""
        lastDetectedInstacartSlug = ""
        lastScannedKey = ""
        latestScanJson = null
        badgeBatchGeneration++
        cardJsonById.clear()
        setBubbleIdleState()
        if (wasAlreadyActive) {
            clearLastStoreUrl(chosen.key)
            storeWebView?.loadUrl(chosen.homeUrl)
        } else {
            storeWebView?.loadUrl(loadLastStoreUrl(chosen.key) ?: chosen.homeUrl)
        }
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
    private fun openInAppAuthPopupDialog(
        parentWebView: WebView,
        transport: WebView.WebViewTransport,
        resultMsg: android.os.Message
    ): Boolean {
        if (isCleaningUp || isFinishing || isDestroyed) return false
        dismissAuthPopupDialog()

        val popupWv = WebView(this)
        popupWv.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            1f
        )
        popupWv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            loadsImagesAutomatically = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                safeBrowsingEnabled = true
            }
            setSupportMultipleWindows(true)
        }
        runCatching {
            val cm = CookieManager.getInstance()
            cm.setAcceptCookie(true)
            cm.setAcceptThirdPartyCookies(popupWv, true)
        }

        val hostSubLabel = label("Connecting securely…", 11f, 0xFF64748B.toInt(), bold = false).apply {
            setSingleLine(true)
            ellipsize = TextUtils.TruncateAt.END
        }

        val popupProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = 15
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2))
        }

        val cardRoot = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(18).toFloat()
            }
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) {
                    outline.setRoundRect(0, 0, view.width, view.height, dp(18).toFloat())
                }
            }
        }

        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(0xFFF8FAFC.toInt())
            setPadding(dp(14), dp(10), dp(12), dp(10))
        }
        val titleStack = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        titleStack.addView(label("🔒 Secure Store Sign-In", 13.5f, 0xFF0F172A.toInt(), bold = true))
        titleStack.addView(hostSubLabel)
        topBar.addView(titleStack)

        val closePopupBtn = label("✕ Close", 12.5f, 0xFF334155.toInt(), bold = true).apply {
            setPadding(dp(10), dp(6), dp(10), dp(6))
            background = GradientDrawable().apply {
                setColor(0xFFE2E8F0.toInt())
                cornerRadius = dp(9).toFloat()
            }
            setOnClickListener {
                dismissAuthPopupDialog()
                syncBubbleYToWebView(triggerRescan = true)
            }
        }
        topBar.addView(closePopupBtn)

        cardRoot.addView(topBar)
        cardRoot.addView(popupProgress)
        cardRoot.addView(popupWv)

        val dlg = Dialog(this)
        dlg.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dlg.setContentView(cardRoot)
        dlg.setCanceledOnTouchOutside(false)
        dlg.setOnDismissListener {
            if (authPopupDialog === dlg) {
                dismissAuthPopupDialog()
                syncBubbleYToWebView(triggerRescan = true)
            }
        }

        authPopupDialog = dlg
        authPopupWebView = popupWv

        var visitedAuthFlow = false
        var dialogShown = false

        fun ensureDialogVisible() {
            if (dialogShown || isCleaningUp || isFinishing || isDestroyed) return
            if (authPopupDialog !== dlg) return
            dialogShown = true
            runCatching {
                dlg.show()
                val dm = resources.displayMetrics
                dlg.window?.apply {
                    setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
                    setLayout(
                        (dm.widthPixels * 0.95f).toInt(),
                        (dm.heightPixels * 0.88f).toInt()
                    )
                    setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
                }
            }
        }

        popupWv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView?, req: WebResourceRequest?): Boolean {
                val uri = req?.url ?: return false
                val scheme = uri.scheme?.lowercase().orEmpty()
                if (scheme == "about" || scheme == "blob" || scheme == "data") return false
                if (scheme != "https") {
                    return true
                }
                val host = uri.host?.lowercase().orEmpty()
                if (isBlockedAppRedirectHost(host)) return true
                if (isExternalOAuthHost(host)) {
                    dismissAuthPopupDialog()
                    showExternalOAuthPrompt(uri.toString(), host)
                    return true
                }
                if (!isAllowedNavigationHost(host) && validatedRetailerUrl(uri.toString()) == null) {
                    return true
                }
                val isAuthUrl = isSsoAuthHost(host) || isAuthLikePath(uri.path)
                if (isAuthUrl) {
                    visitedAuthFlow = true
                    hostSubLabel.text = host
                    ensureDialogVisible()
                    return false
                }
                // If this popup never entered an auth flow, it's just a target="_blank" product/browse link
                if (!visitedAuthFlow && req.isForMainFrame) {
                    val safeNav = validatedNavigationUrl(uri.toString())
                    dismissAuthPopupDialog()
                    if (safeNav != null && !isCleaningUp) {
                        parentWebView.loadUrl(safeNav)
                    }
                    return true
                }
                hostSubLabel.text = host
                ensureDialogVisible()
                return false
            }

            override fun onPageStarted(v: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(v, url, favicon)
                val candidate = url.orEmpty()
                if (candidate.isEmpty() || candidate.equals("about:blank", ignoreCase = true)) return
                val uri = runCatching { Uri.parse(candidate) }.getOrNull() ?: return
                val host = uri.host?.lowercase().orEmpty()
                if (isBlockedAppRedirectHost(host)) {
                    dismissAuthPopupDialog()
                    return
                }
                if (isExternalOAuthHost(host)) {
                    dismissAuthPopupDialog()
                    showExternalOAuthPrompt(candidate, host)
                    return
                }
                val isAuthUrl = isSsoAuthHost(host) || isAuthLikePath(uri.path)
                if (isAuthUrl) {
                    visitedAuthFlow = true
                    hostSubLabel.text = host
                    ensureDialogVisible()
                    return
                }
                if (!visitedAuthFlow) {
                    val safeNav = validatedNavigationUrl(candidate)
                    dismissAuthPopupDialog()
                    if (safeNav != null && !isCleaningUp) {
                        parentWebView.loadUrl(safeNav)
                    }
                    return
                }
                hostSubLabel.text = host
                ensureDialogVisible()
            }

            override fun onPageFinished(v: WebView?, url: String?) {
                super.onPageFinished(v, url)
                runCatching { CookieManager.getInstance().flush() }
                val host = runCatching { Uri.parse(url.orEmpty()).host }.getOrNull().orEmpty()
                if (host.isNotEmpty()) hostSubLabel.text = host
            }
        }

        popupWv.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                popupProgress.progress = newProgress.coerceIn(0, 100)
                popupProgress.alpha = if (newProgress >= 99) 0f else 1f
            }

            override fun onCloseWindow(window: WebView?) {
                runCatching { CookieManager.getInstance().flush() }
                dismissAuthPopupDialog()
                syncBubbleYToWebView(triggerRescan = true)
            }
        }

        // If a popup sits on about:blank while JS writes content or fetches OAuth state, surface it cleanly
        mainHandler.postDelayed({
            if (authPopupDialog === dlg && visitedAuthFlow) {
                ensureDialogVisible()
            }
        }, 200L)

        transport.webView = popupWv
        resultMsg.sendToTarget()
        return true
    }

    private fun showExternalOAuthPrompt(url: String, host: String) {
        if (isCleaningUp || isFinishing || isDestroyed) return
        val provider = if (host.contains("apple")) "Apple" else "Google"
        mainHandler.post {
            if (isCleaningUp || isFinishing || isDestroyed) return@post
            runCatching {
                AlertDialog.Builder(this)
                    .setTitle("Sign in with $provider in Browser")
                    .setMessage(
                        "$provider requires your system browser for sign-in security. " +
                            "You can sign in using your store email & password right here in Live Shop, " +
                            "or open $provider Sign-In in your browser."
                    )
                    .setPositiveButton("Open in Browser") { _, _ ->
                        runCatching {
                            startActivity(
                                Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                }
                            )
                        }.onFailure {
                            Toast.makeText(this, "Could not open browser.", Toast.LENGTH_SHORT).show()
                        }
                    }
                    .setNegativeButton("Use Store Email Instead", null)
                    .show()
            }
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
        val detectorJs = buildDetectorJs(this, currentBridgeSecret)
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
                    if (scheme == "https") {
                        if (isExternalOAuthHost(host)) {
                            showExternalOAuthPrompt(uri.toString(), host)
                            return true
                        }
                        if (!isAllowedNavigationHost(host) && validatedRetailerUrl(uri.toString()) == null) {
                            return true
                        }
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
                lastDetectedCardId = ""
                lastDetectedStoreImageUrl = ""
                lastScannedKey = ""
                latestScanJson = null
                setBubbleIdleState()
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
                saveLastStoreUrl(activeStore.key, url)
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
                    saveLastStoreUrl(activeStore.key, curUrl)
                    if (curUrl.isNotEmpty() && curUrl != lastVisitedHistoryUrl) {
                        val prevBase = lastVisitedHistoryUrl.substringBefore('#')
                        val nextBase = curUrl.substringBefore('#')
                        lastVisitedHistoryUrl = curUrl
                        lastInjectedProgressUrl = ""
                        badgeBatchGeneration++
                        cardJsonById.clear()
                        lastDetectedCardId = ""
                        if (nextBase != prevBase) {
                            scanGeneration++
                            lastDetectedStoreImageUrl = ""
                            lastScannedKey = ""
                            latestScanJson = null
                            setBubbleIdleState()
                        }
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
                val fallbackUrl = validatedRetailerUrl(view?.url) ?: loadLastStoreUrl(activeStore.key) ?: activeStore.homeUrl
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
                if (view == null) return false
                val transport = resultMsg?.obj as? WebView.WebViewTransport
                if (transport != null && resultMsg != null) {
                    return openInAppAuthPopupDialog(view, transport, resultMsg)
                }
                if (!isUserGesture) return false
                val hit = view.hitTestResult
                if (
                    hit.type == WebView.HitTestResult.SRC_ANCHOR_TYPE ||
                    hit.type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE
                ) {
                    val navTarget = validatedNavigationUrl(hit.extra)
                    if (navTarget != null && !isCleaningUp) {
                        view.loadUrl(navTarget)
                        return true
                    }
                }
                return false
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

    private fun setBubbleFailureState(sub: String = "Tap to retry scan") {
        floatingBubble.background = pillBackground(0xF2475569.toInt())
        bubbleBadgeLabel.text = "Scan Unavailable"
        bubbleSubLabel.text = sub
    }

    private fun showNoVisibleCardsToast() {
        Toast.makeText(
            this,
            "Scroll to food cards (tap any 🥦 score badge!) or tap into a product on ${activeStore.label}.",
            Toast.LENGTH_SHORT
        ).show()
    }

    private fun onFloatingBubbleTapped() {
        val current = latestScanJson
        if (current != null && current.optBoolean("ok", false)) {
            presentInspectSheet(current)
            return
        }
        if (lastDetectedTitle.isNotEmpty() && (!lastDetectedIsCard || cardJsonById.isEmpty())) {
            runLiveScan(
                title = lastDetectedTitle,
                ingredients = lastDetectedIngredients,
                barcode = lastDetectedBarcode,
                storeImageUrl = lastDetectedStoreImageUrl,
                instacartSlug = lastDetectedInstacartSlug,
                isCardScan = lastDetectedIsCard,
                force = true
            )
            return
        }
        val wv = storeWebView
        if (wv != null && cardJsonById.isNotEmpty()) {
            wv.evaluateJavascript("(window.__heybrocGetVisibleCardIds && window.__heybrocGetVisibleCardIds()) || '[]'") { rawEval ->
                if (isCleaningUp || isFinishing || isDestroyed) return@evaluateJavascript
                val visibleIds = LinkedHashSet<String>()
                runCatching {
                    val tok = if (!rawEval.isNullOrBlank() && rawEval != "null") {
                        org.json.JSONTokener(rawEval).nextValue()
                    } else null
                    val arr = when (tok) {
                        is JSONArray -> tok
                        is String -> JSONArray(tok)
                        else -> null
                    }
                    if (arr != null) {
                        for (i in 0 until arr.length()) {
                            val id = arr.optString(i).trim()
                            if (VALID_BATCH_ID_RE.matches(id)) visibleIds.add(id)
                        }
                    }
                }
                val visibleItems = visibleIds.mapNotNull { cardJsonById[it] }
                if (visibleItems.isNotEmpty()) {
                    presentVisibleGridDrawer(visibleItems)
                } else {
                    showNoVisibleCardsToast()
                }
            }
            return
        }
        showNoVisibleCardsToast()
    }

    private fun runLiveScan(
        title: String,
        ingredients: String,
        barcode: String,
        storeImageUrl: String = "",
        instacartSlug: String = "",
        isCardScan: Boolean = false,
        force: Boolean = false
    ) {
        val wlSig = ScanApi.currentWatchlistSignature(this)
        val safeStoreImg = sanitizeDeviceStoreImageUrl(storeImageUrl)
        val dedupeKey = "${activeStore.apiStoreKey}|${activeStore.storeBucket}|$instacartSlug|${title.lowercase()}|$barcode|${ingredients.hashCode()}|$wlSig"
        if (!force && dedupeKey == lastScannedKey) {
            if (safeStoreImg.isNotEmpty()) {
                attachDeviceStoreImage(latestScanJson, safeStoreImg)
            }
            return
        }
        lastScannedKey = dedupeKey
        val gen = ++scanGeneration
        if (!isCardScan) {
            latestScanJson = null
            setBubbleScanningState()
        } else if (latestScanJson == null) {
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
                    barcode = barcode.ifBlank { null },
                    skipAnalytics = isCardScan
                )
            }.getOrNull()
            val parsed = runCatching {
                if (raw != null && raw.startsWith("{")) JSONObject(raw) else null
            }.getOrNull()
            mainHandler.post {
                if (isCleaningUp || isFinishing || isDestroyed || gen != scanGeneration) return@post
                if (parsed != null && parsed.optBoolean("ok", false) && parsed.optJSONObject("result") != null) {
                    if (isCardScan && parsed.optBoolean("isCategoryEstimate", false)) {
                        latestScanJson = null
                        setBubbleIdleState()
                        return@post
                    }
                    ScanApi.applyLocalWatchlistToData(this, parsed)
                    if (!isCardScan) {
                        runCatching { ScanHistoryStore.recordScan(this, parsed, apiStore) }
                    }
                    val finalStoreImg = safeStoreImg.ifEmpty {
                        if (lastDetectedTitle.equals(title, ignoreCase = true)) {
                            sanitizeDeviceStoreImageUrl(lastDetectedStoreImageUrl)
                        } else ""
                    }
                    attachDeviceStoreImage(parsed, finalStoreImg)
                    applyJsonToBubble(parsed)
                } else {
                    if (lastScannedKey == dedupeKey) {
                        lastScannedKey = ""
                    }
                    if (!isCardScan) {
                        latestScanJson = null
                        setBubbleFailureState()
                    } else if (latestScanJson == null) {
                        setBubbleIdleState()
                    }
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
                        val storeImg = sanitizeDeviceStoreImageUrl(obj.optString("storeImageUrl"))
                        val rawSlug = obj.optString("instacartSlug").trim()
                        val effectiveSlug = when {
                            rawSlug.isNotEmpty() -> rawSlug
                            isInstacartHost -> lastDetectedInstacartSlug
                            else -> ""
                        }
                        val isCard = (kind == "card")
                        val cardId = if (isCard) obj.optString("cardId").trim() else ""
                        val batchPending = isCard && obj.optBoolean("batchPending", false)
                        val identityChanged = !title.equals(lastDetectedTitle, ignoreCase = true) || barcode != lastDetectedBarcode
                        if (identityChanged) {
                            latestScanJson = null
                            lastScannedKey = ""
                        }
                        lastDetectedIsCard = isCard
                        lastDetectedCardId = cardId
                        lastDetectedTitle = title
                        lastDetectedIngredients = ingredients
                        lastDetectedBarcode = barcode
                        lastDetectedStoreImageUrl = storeImg
                        lastDetectedInstacartSlug = effectiveSlug
                        if (isCard && VALID_BATCH_ID_RE.matches(cardId)) {
                            val cached = cardJsonById[cardId]
                            if (cached != null) {
                                attachDeviceStoreImage(cached, storeImg)
                                ScanApi.applyLocalWatchlistToData(this@LiveStoreBrowserActivity, cached)
                                applyJsonToBubble(cached)
                                return@post
                            }
                        }
                        if (isCard && batchPending) {
                            if (latestScanJson == null) {
                                setBubbleIdleState()
                            }
                            return@post
                        }
                        runLiveScan(
                            title,
                            ingredients,
                            barcode,
                            storeImageUrl = storeImg,
                            instacartSlug = effectiveSlug,
                            isCardScan = isCard
                        )
                    }
                    "browse" -> {
                        scanGeneration++
                        lastDetectedIsCard = false
                        lastDetectedCardId = ""
                        lastDetectedTitle = ""
                        lastDetectedIngredients = ""
                        lastDetectedBarcode = ""
                        lastDetectedStoreImageUrl = ""
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
                        val localStoreImgs = HashMap<String, String>()
                        for (i in 0 until minOf(arr.length(), 8)) {
                            val it = arr.optJSONObject(i) ?: continue
                            val id = it.optString("id").trim()
                            val pTitle = it.optString("productTitle").trim()
                            val bCode = it.optString("barcode").trim().ifEmpty { null }
                            val sImg = sanitizeDeviceStoreImageUrl(it.optString("storeImageUrl"))
                            if (VALID_BATCH_ID_RE.matches(id) && (pTitle.isNotEmpty() || bCode != null)) {
                                batchReq.add(ScanApi.BatchScanRequestItem(id, pTitle, bCode))
                                if (sImg.isNotEmpty()) localStoreImgs[id] = sImg
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
                                        localStoreImgs[reqItem.id]?.let { sImg ->
                                            attachDeviceStoreImage(hit.fullJson, sImg)
                                        }
                                        if (!hit.isCategoryEstimate && !hit.isTransientLockedSwap) {
                                            cardJsonById[reqItem.id] = hit.fullJson
                                        }
                                        if (
                                            !hit.isCategoryEstimate &&
                                            lastDetectedIsCard &&
                                            latestScanJson == null &&
                                            (reqItem.id == lastDetectedCardId || reqItem.productTitle.equals(lastDetectedTitle, ignoreCase = true))
                                        ) {
                                            ScanApi.applyLocalWatchlistToData(this@LiveStoreBrowserActivity, hit.fullJson)
                                            applyJsonToBubble(hit.fullJson)
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
                                            outcome.retryAfterSec?.let { put("retryAfterMs", it * 1000L) }
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
                        val cardStoreImg = sanitizeDeviceStoreImageUrl(obj.optString("storeImageUrl"))
                        val rawSlug = obj.optString("instacartSlug").trim()
                        val instacartSlug = when {
                            rawSlug.isNotEmpty() -> rawSlug
                            isInstacartHost -> lastDetectedInstacartSlug
                            else -> ""
                        }
                        if (title.isNotEmpty()) {
                            lastDetectedIsCard = true
                            lastDetectedCardId = cardId
                            lastDetectedTitle = title
                            lastDetectedIngredients = ""
                            lastDetectedBarcode = ""
                            lastDetectedStoreImageUrl = cardStoreImg
                            lastScannedKey = ""
                            if (instacartSlug.isNotEmpty()) {
                                lastDetectedInstacartSlug = instacartSlug
                            }
                        }
                        val cached = if (VALID_BATCH_ID_RE.matches(cardId)) cardJsonById[cardId] else null
                        if (cached != null) {
                            attachDeviceStoreImage(cached, cardStoreImg)
                            ScanApi.applyLocalWatchlistToData(this@LiveStoreBrowserActivity, cached)
                            applyJsonToBubble(cached)
                            presentInspectSheet(cached)
                        } else if (title.isNotEmpty()) {
                            val gen = ++scanGeneration
                            latestScanJson = null
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
                                    if (isCleaningUp || isFinishing || isDestroyed || gen != scanGeneration) return@post
                                    if (parsed != null && parsed.optBoolean("ok", false) && parsed.optJSONObject("result") != null) {
                                        attachDeviceStoreImage(parsed, cardStoreImg)
                                        ScanApi.applyLocalWatchlistToData(this@LiveStoreBrowserActivity, parsed)
                                        val isTransientLocked = parsed.optJSONObject("swap")?.optBoolean("locked", false) == true &&
                                            parsed.optJSONObject("entitlement") == null
                                        if (
                                            VALID_BATCH_ID_RE.matches(cardId) &&
                                            !parsed.optBoolean("isCategoryEstimate", false) &&
                                            !isTransientLocked
                                        ) {
                                            cardJsonById[cardId] = parsed
                                        }
                                        applyJsonToBubble(parsed)
                                        presentInspectSheet(parsed)
                                    } else {
                                        latestScanJson = null
                                        setBubbleFailureState("Tap badge to retry")
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private fun presentVisibleGridDrawer(visibleItems: List<JSONObject>) {
        inspectDialog?.dismiss()
        val sorted = visibleItems
            .filter { !it.optBoolean("isCategoryEstimate", false) && it.optJSONObject("result") != null }
            .distinctBy { it.optJSONObject("product")?.optString("title").orEmpty().lowercase().trim() }
            .sortedByDescending { it.optJSONObject("result")?.optInt("score", 0) ?: 0 }
        if (sorted.isEmpty()) {
            showNoVisibleCardsToast()
            return
        }

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
            val title = ScanHistoryStore.cleanDisplayTitle(prod?.optString("title").orEmpty().ifBlank { "Food Item" })
            val brand = prod?.optString("brand").orEmpty()
            val barcode = prod?.optString("barcode").orEmpty()
            val rawImg = prod?.optString("imageUrl").orEmpty()
            val storeImg = prod?.optString("storeImageUrl").orEmpty()
            val catArt = prod?.optString("categoryArtUrl").orEmpty()
            val dotColor = when {
                sc >= 75 -> 0xFF16A34A.toInt()
                sc >= 50 -> 0xFFD97706.toInt()
                else -> 0xFFDC2626.toInt()
            }
            list.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(10), dp(9), dp(12), dp(9))
                background = GradientDrawable().apply {
                    setColor(0xFFF8FAFC.toInt())
                    setStroke(dp(1), 0xFFE2E8F0.toInt())
                    cornerRadius = dp(14).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(8) }
                addView(
                    buildSheetThumbnailBox(
                        title = title,
                        brand = brand,
                        barcode = barcode,
                        rawImageUrl = rawImg,
                        storeImageUrl = storeImg,
                        categoryArtUrl = catArt,
                        widthDp = 42,
                        heightDp = 48
                    ),
                    LinearLayout.LayoutParams(dp(42), dp(48)).apply { marginEnd = dp(10) }
                )
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
        val prodBarcode = prod?.optString("barcode").orEmpty()
        val prodImageUrl = prod?.optString("imageUrl").orEmpty()
        val prodStoreImageUrl = prod?.optString("storeImageUrl").orEmpty()
        val prodCategoryArtUrl = prod?.optString("categoryArtUrl").orEmpty()
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

        // Header Row: Product Thumbnail + Score Pill + Title/Brand + Close
        val headerRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        headerRow.addView(
            buildSheetThumbnailBox(
                title = title,
                brand = brand,
                barcode = prodBarcode,
                rawImageUrl = prodImageUrl,
                storeImageUrl = prodStoreImageUrl,
                categoryArtUrl = prodCategoryArtUrl,
                widthDp = 54,
                heightDp = 62
            ),
            LinearLayout.LayoutParams(dp(54), dp(62)).apply { marginEnd = dp(10) }
        )
        headerRow.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(11), dp(8), dp(11), dp(8))
            background = GradientDrawable().apply {
                setColor(scoreColor)
                cornerRadius = dp(16).toFloat()
            }
            addView(label("$score", 21f, Color.WHITE, bold = true))
            addView(label("/100", 10f, 0xE6FFFFFF.toInt(), bold = true))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { marginEnd = dp(10) }
        })
        headerRow.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            addView(label(title, 15f, 0xFF0F172A.toInt(), bold = true).apply {
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
            val rawLink = swapObj.optString("deepLink").ifBlank { swapObj.optString("webUrl") }
            val directSwapUrl = validatedRetailerUrl(rawLink)?.takeIf {
                ScanHistoryStore.urlMatchesStore(it, activeStore.key)
            }
            val isPaidLink = swapObj.optBoolean("isPaidLink", false) && directSwapUrl != null
            val paidDisclosure = if (isPaidLink) " · paid link" else ""
            val swapFlagNames = buildList {
                val arr = swapObj.optJSONArray("flaggedAdditives")
                if (arr != null) {
                    for (i in 0 until arr.length()) {
                        val n = arr.optString(i).trim()
                        if (n.isNotEmpty()) add(n)
                    }
                }
            }

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

            val swapTopRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(5), 0, dp(4))
            }
            if (swapUnlocked && rawSwapTitle.isNotBlank()) {
                val swapBrand = swapObj.optString("brand")
                val swapBarcode = swapObj.optString("barcode")
                val swapRawImg = swapObj.optString("imageUrl").ifBlank { swapObj.optString("image") }
                val swapCatArt = swapObj.optString("categoryArtUrl")
                swapTopRow.addView(
                    buildSheetThumbnailBox(
                        title = rawSwapTitle,
                        brand = swapBrand,
                        barcode = swapBarcode,
                        rawImageUrl = swapRawImg,
                        storeImageUrl = "",
                        categoryArtUrl = swapCatArt,
                        widthDp = 46,
                        heightDp = 52
                    ),
                    LinearLayout.LayoutParams(dp(46), dp(52)).apply { marginEnd = dp(10) }
                )
            }
            val swapTextCol = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            swapTextCol.addView(label(
                if (swapUnlocked) rawSwapTitle + swapBadgeSuffix else "🔒 Clean Swap Available$swapBadgeSuffix",
                15f,
                0xFF064E3B.toInt(),
                bold = true
            ))
            val reason = swapObj.optString("why").ifBlank { swapObj.optString("reason") }
            if (swapUnlocked && reason.isNotBlank()) {
                swapTextCol.addView(label(reason, 12f, 0xFF047857.toInt()).apply {
                    setPadding(0, dp(2), 0, 0)
                })
            }
            swapTopRow.addView(swapTextCol)
            swapCard.addView(swapTopRow)

            if (swapUnlocked && swapFlagNames.isNotEmpty()) {
                swapCard.addView(label("Note: contains ${swapFlagNames.joinToString(", ")}", 11.5f, 0xFF92400E.toInt(), bold = true).apply {
                    setPadding(0, 0, 0, dp(6))
                })
            }

            val ctaText = when {
                swapUnlocked -> "Shop Clean Swap on ${activeStore.label} →$paidDisclosure"
                canUnlockNow -> "🔓 Unlock & Shop Clean Swap ($rem/$lim Free)$paidDisclosure"
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
                        val targetUrl = directSwapUrl
                            ?: validatedRetailerUrl(ScanHistoryStore.storeSearchUrl(activeStore.key, query))
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
        AlertDialog.Builder(this)
            .setTitle(ScanApi.paywallHeadline(this))
            .setMessage(
                "You've used all $limit free single-item Clean Swaps.\n\n" +
                    "Product scores (0–100) stay 100% free forever. Invite friends for free Pro weeks or sign in to an existing Pro account."
            )
            .setNegativeButton("Close", null)
            .setPositiveButton("Upgrade to Pro") { _, _ ->
                PlayBillingCoordinator.openUpgradeFlow(this)
            }
            .show()
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
        if (::activeStore.isInitialized) {
            saveLastStoreUrl(activeStore.key, storeWebView?.url)
        }
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
        dismissAuthPopupDialog()
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
        imageExecutor.shutdownNow()
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
