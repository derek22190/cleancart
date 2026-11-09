package com.cleancart.overlay

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.SearchManager
import android.app.Service
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import android.util.LruCache
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import kotlin.math.abs

/**
 * Renders the CleanCart Dual-Mode Floating Bubble:
 * - Mode A (Product View): `{score}/100 • Tap to Inspect`
 * - Mode B (Idle / Search Scroll View): `🛒 Cart Avg: {avgScore}/100` (Red <50, Yellow 50-74, Green 75+)
 * Includes ValueAnimator climb on Swap Item tap, Whole-Cart Auditor drawer, and a bottom-center
 * `✕ Hide for this trip` drop target while dragging.
 */
class OverlayWindowService : Service() {

    companion object {
        const val ACTION_SHOW_RESULT = "com.cleancart.overlay.SHOW_RESULT"
        const val ACTION_LOADING = "com.cleancart.overlay.LOADING"
        const val ACTION_SHOW_TEST = "com.cleancart.overlay.SHOW_TEST"
        const val ACTION_HIDE_IF_TEST = "com.cleancart.overlay.HIDE_IF_TEST"
        const val ACTION_IDLE_CART_AVG = "com.cleancart.overlay.IDLE_CART_AVG"
        const val ACTION_PDP_SCROLL_HINT = "com.cleancart.overlay.PDP_SCROLL_HINT"
        const val ACTION_SYNC_CART = "com.cleancart.overlay.SYNC_CART"
        const val ACTION_HIDE = "com.cleancart.overlay.HIDE"
        const val ACTION_RESET_HIDDEN = "com.cleancart.overlay.RESET_HIDDEN"
        const val ACTION_SHOW_SETUP_GUIDE = "com.cleancart.overlay.SHOW_SETUP_GUIDE"
        const val ACTION_HIDE_SETUP_GUIDE = "com.cleancart.overlay.HIDE_SETUP_GUIDE"
        const val ACTION_REFRESH_PILL = "com.cleancart.overlay.REFRESH_PILL"
        const val EXTRA_SETUP_STEP = "setup_step"
        const val EXTRA_JSON = "json"
        const val EXTRA_TITLE = "title"
        const val EXTRA_IN_CART = "in_cart"
        const val EXTRA_IS_SINGLE_PDP = "is_single_pdp"
        const val EXTRA_CART_ARRAY = "cart_array"
        const val EXTRA_REPLACE_CART = "replace_cart"
        const val EXTRA_REMOVED_TITLES = "removed_titles"
        const val EXTRA_STORE_PKG = "store_pkg"
        const val EXTRA_KEEP_MODE = "keep_mode"

        private const val INK = 0xFF15201B.toInt()
        private const val INK_2 = 0xFF4A5550.toInt()
        private const val INK_3 = 0xFF85908A.toInt()
        private const val BRAND = 0xFF0F7A4A.toInt()
        private const val PREFS_NAME = "heybroc_overlay_prefs"
        private const val LEGACY_KEY_TRIP_CART = "trip_cart_json"
        private const val LEGACY_KEY_TRIP_CART_V2 = "trip_cart_v2_json"
        private const val LEGACY_KEY_TRIP_CART_V3_PREFIX = "trip_cart_v3_"
        private const val KEY_TRIP_CART_PREFIX = "trip_cart_v4_"
        private const val KEY_PILL_Y = "pill_y"
        private val DEMO_SEED_TITLES = setOf(
            "berry swirl strawberry lowfat yogurt",
            "strawberry lowfat yogurt",
            "baked cheddar crackers",
            "grass-fed salted butter"
        )
        private val VARIANT_NOISE_TITLE = Regex(
            """^(?i)((flavor|size|style|color|colour|scent|count|pack|pack\s+size|variant|option|type|model|pattern|weight|material)\s*:\s*.+|cart\s*,?\s*\(\d+(\s+items?)?\)|in\s+\d+[km]?\+?\s*people'?s?\s*c.*|\d+[km]?\+?\s*bought.*|.*bought\s+\d+\+?\s*times?.*|.*stay\s+stocked.*|.*last\s+purchased.*|.*straight\s+talk.*|.*google\s+pixel.*|options(\s+from.*)?|(get\s+\$?\d+(\.\d{2})?\s+)?walmart\s+cash.*|manufacturer\s+offer.*|subscribe\s+to\s+save.*|.*barcode\s+scanner.*|.*preferred\s+address.*|change\s+(delivery\s+|pickup\s+|shipping\s+)?address.*|\d+\s+[a-z0-9.\s]+\b(st|street|rd|road|dr|drive|ave|avenue|blvd|boulevard|ln|lane|ct|court|pl|place|cir|circle|way|pkwy|parkway|hwy|highway|ter|terrace|trl|trail)\b.*|(express|today|tomorrow|asap)\s*,?\s*.*|.*\b(\d+\s*[-–—]\s*\d+\s*min|\d+\s*(hr|hour|min)s?\s+or\s+less|\d{1,2}(:\d{2})?\s*(am|pm)?\s*[-–—]\s*\d{1,2}(:\d{2})?\s*(am|pm))\b.*|.*\bfree\s+with\s+(walmart\+?|w\+).*|.*\b(thanksgiving\s+meal|feast\s+for\s+\d+|classic\s+sides|meals?\s+made\s+easy|get\s+it\s+fast|household\s+essentials|grocery\s+list\s+staples|weekly\s+essentials|under\s+\$?\d+\s+per\s+person|shop\s+the\s+list|free\s+turkey|turkey\s+earned|pickup\s+benefit|same-day\s+select|more\s+deliveries\s+for\s+less|unlimited\s+delivery|topcare|pain\s*&\s*fever|oral\s+suspension|acetaminophen|ibuprofen|no\s+longer\s+available|not\s+available\s+in\s+your\s+area|based\s+on\s+items\s+in\s+your\s+cart|complete\s+your\s+cart)\b.*|.*&\s*more\.?$|.*,\s*was|.*[!?])$"""
        )
    }

    private data class TripCartItem(
        val key: String,
        var title: String,
        var score: Int,
        var swapObj: JSONObject? = null,
        val isSeed: Boolean = false,
        var fullJson: JSONObject? = null,
        var fromCartScreen: Boolean = false,
        var lastSeenAtMs: Long = System.currentTimeMillis(),
    )

    private lateinit var wm: WindowManager
    private var climbAnimator: ValueAnimator? = null
    private var pill: View? = null
    private var pillTextView: TextView? = null
    private var pillDotView: View? = null
    private var hideTarget: View? = null
    private var card: View? = null
    private var setupGuideView: View? = null
    private var pillParams: WindowManager.LayoutParams? = null
    private var pillY = 0
    private var data: JSONObject? = null
    private var openFlag: String? = null

    private var isCartAvgMode = false
    private var isPdpScrollHint = false
    private var isAuditorOpen = false
    private var isTestMode = false
    private var hiddenForCurrentScreen = false
    private var currentStoreKey = "walmart"
    private val tripCart = mutableListOf<TripCartItem>()
    private var displayedCartAvg = 100
    private var pendingSwapFromKey: String? = null
    private var pendingSwapTitle: String? = null
    private val mainUiHandler = Handler(Looper.getMainLooper())
    private val imageExecutor = Executors.newFixedThreadPool(2)
    private val swapBitmapCache = LruCache<String, Bitmap>(24)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val staleKeys = prefs.all.keys.filter {
            it == LEGACY_KEY_TRIP_CART || it == LEGACY_KEY_TRIP_CART_V2 || it.startsWith(LEGACY_KEY_TRIP_CART_V3_PREFIX)
        }
        if (staleKeys.isNotEmpty()) {
            val editor = prefs.edit()
            staleKeys.forEach { editor.remove(it) }
            editor.apply()
        }
        pillY = prefs.getInt(KEY_PILL_Y, dp(220))
        loadPersistedCart(currentStoreKey)
        displayedCartAvg = calcCartAvg()
    }

    private fun storeDisplayName(key: String): String = when (key) {
        "walmart" -> "Walmart"
        "bjs" -> "BJ's"
        "aldi" -> "ALDI"
        "target" -> "Target"
        "kroger" -> "Kroger"
        "instacart" -> "Instacart"
        "costco" -> "Costco"
        "sams" -> "Sam's Club"
        "amazon" -> "Amazon"
        "wholefoods" -> "Whole Foods"
        "doordash" -> "DoorDash"
        "ubereats" -> "Uber Eats"
        "shipt" -> "Shipt"
        else -> "Store"
    }

    private fun switchStoreIfNeeded(intent: Intent?) {
        val pkg = intent?.getStringExtra(EXTRA_STORE_PKG).orEmpty()
        if (pkg.isBlank()) return
        val nextStore = ScanApi.storeForPackage(pkg)
        if (nextStore != currentStoreKey) {
            persistCart()
            currentStoreKey = nextStore
            data = null
            openFlag = null
            hiddenForCurrentScreen = false
            removeCard()
            loadPersistedCart(currentStoreKey)
            displayedCartAvg = calcCartAvg()
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        val maxH = (resources.displayMetrics.heightPixels - dp(80)).coerceAtLeast(dp(48))
        pillY = pillY.coerceIn(dp(24), maxH)
        pill?.let { p -> pillParams?.let { lp -> lp.y = pillY; updateOverlayView(p, lp) } }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!canDisplayOverlay()) {
            stopSelf()
            return START_NOT_STICKY
        }
        switchStoreIfNeeded(intent)
        when (intent?.action) {
            ACTION_RESET_HIDDEN -> {
                hiddenForCurrentScreen = false
                removeSetupGuide()
            }
            ACTION_SHOW_SETUP_GUIDE -> {
                val step = intent.getStringExtra(EXTRA_SETUP_STEP) ?: "2A"
                showSetupGuide(step)
            }
            ACTION_HIDE_SETUP_GUIDE -> {
                removeSetupGuide()
            }
            ACTION_LOADING -> {
                isTestMode = false
                // Navigating to a product page always brings the pill back and clears any stale previous product
                hiddenForCurrentScreen = false
                data = null
                openFlag = null
                isPdpScrollHint = false
                if (card == null) {
                    isCartAvgMode = false
                    showPill(loadingText = "Scanning…")
                }
            }
            ACTION_SHOW_RESULT -> {
                isTestMode = false
                val incoming = runCatching { JSONObject(intent.getStringExtra(EXTRA_JSON) ?: "{}") }.getOrNull()
                if (incoming?.optBoolean("ok") == true) {
                    data = incoming
                    isCartAvgMode = false
                    isPdpScrollHint = false
                    runCatching { ScanHistoryStore.recordScan(this, incoming, currentStoreKey) }
                    if (intent.getBooleanExtra(EXTRA_IN_CART, false)) {
                        recordScannedItem(data)
                    }
                    openFlag = null
                    if (!hiddenForCurrentScreen && card == null) {
                        showPill()
                    }
                } else if (intent.getBooleanExtra(EXTRA_IS_SINGLE_PDP, false)) {
                    // On a confirmed Single Product Detail Page, never switch to Cart Avg mode if a scan fails — prompt to scroll down slightly
                    data = null
                    openFlag = null
                    isCartAvgMode = false
                    isPdpScrollHint = true
                    if (!hiddenForCurrentScreen && card == null) {
                        showPill(loadingText = "Scroll down to grade item")
                    }
                } else {
                    // Never keep a stale previous product (e.g. Oreo Puffs) if a scan fails — clear data and fall back to Cart Avg mode
                    data = null
                    openFlag = null
                    isPdpScrollHint = false
                    isCartAvgMode = true
                    if (!hiddenForCurrentScreen && card == null) {
                        showPill()
                    }
                }
            }
            ACTION_PDP_SCROLL_HINT -> {
                isTestMode = false
                if (!hiddenForCurrentScreen && card == null) {
                    data = null
                    openFlag = null
                    isCartAvgMode = false
                    isPdpScrollHint = true
                    showPill(loadingText = "Scroll down to grade item")
                }
            }
            ACTION_SYNC_CART -> {
                isTestMode = false
                val keepMode = intent.getBooleanExtra(EXTRA_KEEP_MODE, false)
                if (!keepMode) {
                    isPdpScrollHint = false
                }
                val prevSize = tripCart.size
                val prevAvg = displayedCartAvg
                val arrRaw = intent.getStringExtra(EXTRA_CART_ARRAY) ?: "[]"
                val remRaw = intent.getStringExtra(EXTRA_REMOVED_TITLES) ?: "[]"
                val replaceCart = intent.getBooleanExtra(EXTRA_REPLACE_CART, false)
                syncCartFromScreen(arrRaw, remRaw, replaceCart, keepMode)
                if (!keepMode) {
                    isCartAvgMode = true
                }
                if (card != null && isAuditorOpen) {
                    if (tripCart.size != prevSize || displayedCartAvg != prevAvg) {
                        showAuditorDrawer()
                    }
                } else if (!hiddenForCurrentScreen && card == null && (!keepMode || isCartAvgMode)) {
                    showPill()
                }
            }
            ACTION_IDLE_CART_AVG -> {
                isTestMode = false
                isPdpScrollHint = false
                if (!hiddenForCurrentScreen && card == null) {
                    isCartAvgMode = true
                    showPill()
                }
            }
            ACTION_SHOW_TEST -> {
                hiddenForCurrentScreen = false
                isCartAvgMode = false
                isPdpScrollHint = false
                isTestMode = true
                data = JSONObject(intent.getStringExtra(EXTRA_JSON) ?: ScanApi.SAMPLE_JSON)
                openFlag = null
                removeCard()
                showPill()
            }
            ACTION_HIDE_IF_TEST -> {
                if (isTestMode) {
                    isTestMode = false
                    removeCard()
                    removeHideTarget()
                    removePill()
                }
            }
            ACTION_HIDE -> {
                isTestMode = false
                hiddenForCurrentScreen = false
                removeCard()
                removeHideTarget()
                removePill()
            }
            ACTION_REFRESH_PILL -> {
                ScanApi.applyLocalWatchlistToData(this, data)
                var cartChanged = false
                for (item in tripCart) {
                    val fj = item.fullJson ?: continue
                    ScanApi.applyLocalWatchlistToData(this, fj)
                    val newItemScore = fj.optJSONObject("result")?.optInt("score", item.score) ?: item.score
                    if (newItemScore != item.score) {
                        item.score = newItemScore
                        cartChanged = true
                    }
                }
                if (cartChanged) {
                    displayedCartAvg = calcCartAvg()
                    persistCart()
                }
                if (!hiddenForCurrentScreen && card == null && pill != null) {
                    showPill()
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        climbAnimator?.cancel()
        runCatching { imageExecutor.shutdownNow() }
        removeSetupGuide()
        removeCard()
        removeHideTarget()
        removePill()
        super.onDestroy()
    }

    private fun calcCartAvg(): Int {
        if (tripCart.isEmpty()) return 100
        return tripCart.sumOf { it.score } / tripCart.size
    }

    private fun colorNameForScore(score: Int): String = when {
        score >= 75 -> "green"
        score >= 50 -> "yellow"
        else -> "red"
    }

    private fun cleanCartTitle(raw: String): String =
        raw.replace(Regex("^(?i)conventional grocery\\s+"), "")
            .replace(Regex("^(?i)\\d+\\s*(?:ct|count|pk|pack|ea)\\s+(?=[a-zA-Z]{2,})"), "")
            .replace(Regex("(?i)\\s*\\(category\\s+estimate[^)]*\\)"), "")
            .replace(Regex("(?i)\\s*[,•|\\-]?\\s*(average|avg)\\s+price\\b.*$"), "")
            .replace(Regex("(?i)\\s*[,•|\\-]\\s*ratings?\\s*$"), "")
            .replace(Regex("\\s*\\(\\d+(?:\\.\\d+)?\\s*(?:[a-zA-Z]{0,6}\\s*)?(?:\\.\\.\\.+|…)?\\s*$"), "")
            .replace(Regex("\\s*,\\s*\\d+\\s*(?:[a-zA-Z]{1,4}\\s*)?(?:\\.\\.\\.+|…)\\s*$"), "")
            .replace(Regex("(?i)\\btruffl(?:\\.\\.\\.+|…)?$"), "Truffles")
            .replace(Regex("(?i)\\bchocolat(?:\\.\\.\\.+|…)?$"), "Chocolate")
            .replace(Regex("(?i)\\bappl(?:\\.\\.\\.+|…)?$"), "Apples")
            .replace(Regex("(?i)\\bwing\\s+sa(?:\\.\\.\\.+|…)?$"), "Wing Sauce")
            .replace(Regex("(?i)\\band\\s+re(?:\\.\\.\\.+|…)?$"), "and Reese's")
            .replace(Regex("(?i)\\b93?%\\s*lean\\s*/?\\s*7?%\\s*fat\\b"), "93% Lean/7% Fat")
            .replace(Regex("(?i)\\b80?%\\s*lean\\s*/?\\s*20?%\\s*fat\\b"), "80% Lean/20% Fat")
            .replace(Regex("(?i)\\b85?%\\s*lean\\s*/?\\s*15?%\\s*fat\\b"), "85% Lean/15% Fat")
            .replace(Regex("(?i)\\b73?%\\s*lean\\s*/?\\s*27?%\\s*fat\\b"), "73% Lean/27% Fat")
            .replace(Regex("\\s+"), " ")
            .trim()

    private fun normalizeCartKey(raw: String): String =
        cleanCartTitle(raw).lowercase()
            .replace(Regex("^(conventional grocery|organic|natural)\\s+"), "")
            .replace(Regex("\\b93%\\s*lean/7%\\s*fat\\b"), "93 7 lean fat")
            .replace(Regex("\\b80%\\s*lean/20%\\s*fat\\b"), "80 20 lean fat")
            .replace(Regex("\\b85%\\s*lean/15%\\s*fat\\b"), "85 15 lean fat")
            .replace(Regex("\\b73%\\s*lean/27%\\s*fat\\b"), "73 27 lean fat")
            .replace(Regex("[,•|\\-–—.…*]+"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()

    private fun isSameCartItem(a: String, b: String): Boolean {
        if (a.equals(b, ignoreCase = true)) return true
        val na = normalizeCartKey(a)
        val nb = normalizeCartKey(b)
        if (na == nb) return true
        val shorter = if (na.length <= nb.length) na else nb
        val longer = if (na.length <= nb.length) nb else na
        if (shorter.length >= 15 && longer.startsWith(shorter)) return true
        return false
    }

    private fun matchesPendingSwap(rawTitle: String): Boolean {
        val pending = pendingSwapTitle ?: return false
        if (isSameCartItem(rawTitle, pending)) return true
        val words = normalizeCartKey(pending).split(" ").filter { it.length >= 3 }
        val lower = normalizeCartKey(rawTitle)
        return words.size >= 2 && words.take(2).all { lower.contains(it) }
    }

    private fun syncCartFromScreen(arrRaw: String, remRaw: String, @Suppress("UNUSED_PARAMETER") replaceCart: Boolean, keepMode: Boolean = false) {
        val arr = runCatching { JSONArray(arrRaw) }.getOrNull() ?: return
        val remArr = runCatching { JSONArray(remRaw) }.getOrNull()
        val prevAvg = calcCartAvg()
        val now = System.currentTimeMillis()
        var swapDetectedInCart = false
        // When syncing from the real Cart screen (`!keepMode`), drop non-cart-screen items (e.g. PDP browsing leftovers)
        // and items from previous shopping sessions (>30 min old), while retaining items scrolled during the active Cart session.
        tripCart.removeAll {
            it.isSeed ||
                it.title.lowercase() in DEMO_SEED_TITLES ||
                VARIANT_NOISE_TITLE.matches(it.title.trim()) ||
                (!keepMode && arr.length() > 0 && (!it.fromCartScreen || now - it.lastSeenAtMs > 30 * 60 * 1000L))
        }
        if (remArr != null) {
            for (i in 0 until remArr.length()) {
                val remTitle = remArr.optString(i).trim()
                if (remTitle.length >= 4) {
                    tripCart.removeAll {
                        isSameCartItem(it.key, remTitle) ||
                            isSameCartItem(it.title, remTitle) ||
                            normalizeCartKey(it.title).contains(normalizeCartKey(remTitle)) ||
                            normalizeCartKey(remTitle).contains(normalizeCartKey(it.title))
                    }
                }
            }
        }
        for (i in 0 until arr.length()) {
            val d = runCatching { JSONObject(arr.optString(i, "{}")) }.getOrNull() ?: continue
            if (d.optBoolean("ok") != true) continue
            val result = d.optJSONObject("result") ?: continue
            val prod = d.optJSONObject("product") ?: continue
            val rawTitle = cleanCartTitle(prod.optString("title"))
            if (rawTitle.isBlank() || rawTitle.lowercase() in DEMO_SEED_TITLES || VARIANT_NOISE_TITLE.matches(rawTitle)) continue
            val score = result.optInt("score", 50)
            val swap = d.optJSONObject("swap")
            if (matchesPendingSwap(rawTitle)) {
                val fromKey = pendingSwapFromKey
                if (!fromKey.isNullOrBlank()) {
                    tripCart.removeAll { isSameCartItem(it.key, fromKey) || isSameCartItem(it.title, fromKey) }
                }
                pendingSwapFromKey = null
                pendingSwapTitle = null
                swapDetectedInCart = true
            }
            val existing = tripCart.firstOrNull { isSameCartItem(it.key, rawTitle) || isSameCartItem(it.title, rawTitle) }
            if (existing != null) {
                existing.score = score
                existing.swapObj = swap
                existing.fullJson = d
                if (!keepMode) {
                    existing.fromCartScreen = true
                }
                existing.lastSeenAtMs = now
                if (rawTitle.length > existing.title.length && !rawTitle.endsWith("...")) {
                    existing.title = rawTitle
                }
            } else {
                tripCart.add(TripCartItem(rawTitle, rawTitle, score, swap, isSeed = false, fullJson = d, fromCartScreen = !keepMode, lastSeenAtMs = now))
                while (tripCart.size > 40) {
                    tripCart.removeAt(tripCart.size - 1)
                }
            }
        }
        val nextAvg = calcCartAvg()
        displayedCartAvg = nextAvg
        persistCart()
        if (swapDetectedInCart && nextAvg > prevAvg) {
            animateCartAvgClimb(prevAvg, nextAvg)
        }
    }

    private fun recordScannedItem(d: JSONObject?) {
        if (d?.optBoolean("ok") != true) return
        val result = d.optJSONObject("result") ?: return
        val prod = d.optJSONObject("product") ?: return
        val rawTitle = cleanCartTitle(prod.optString("title"))
        if (rawTitle.isBlank() || rawTitle.lowercase() in DEMO_SEED_TITLES || VARIANT_NOISE_TITLE.matches(rawTitle)) return
        if (ScanHistoryStore.isPoisonedProduceEntry(rawTitle, d)) return
        if (Regex("(?i)(gas savings|walmart\\+|notification|scan barcodes|qr code|account|sparky)").containsMatchIn(rawTitle)) return
        val prevAvg = calcCartAvg()
        val now = System.currentTimeMillis()
        var swapDetectedInCart = false
        val score = result.optInt("score", 50)
        val swap = d.optJSONObject("swap")
        tripCart.removeAll { it.isSeed || it.title.lowercase() in DEMO_SEED_TITLES || VARIANT_NOISE_TITLE.matches(it.title.trim()) || ScanHistoryStore.isPoisonedProduceEntry(it.title, it.fullJson) }
        if (matchesPendingSwap(rawTitle)) {
            val fromKey = pendingSwapFromKey
            if (!fromKey.isNullOrBlank()) {
                tripCart.removeAll { isSameCartItem(it.key, fromKey) || isSameCartItem(it.title, fromKey) }
            }
            pendingSwapFromKey = null
            pendingSwapTitle = null
            swapDetectedInCart = true
        }
        val existing = tripCart.firstOrNull { isSameCartItem(it.key, rawTitle) || isSameCartItem(it.title, rawTitle) }
        if (existing != null) {
            existing.score = score
            existing.swapObj = swap
            existing.fullJson = d
            existing.lastSeenAtMs = now
        } else {
            tripCart.add(0, TripCartItem(rawTitle, rawTitle, score, swap, isSeed = false, fullJson = d, fromCartScreen = false, lastSeenAtMs = now))
            while (tripCart.size > 40) {
                tripCart.removeAt(tripCart.size - 1)
            }
        }
        val nextAvg = calcCartAvg()
        displayedCartAvg = nextAvg
        persistCart()
        if (swapDetectedInCart && nextAvg > prevAvg) {
            animateCartAvgClimb(prevAvg, nextAvg)
        }
    }

    private fun persistCart() {
        val arr = JSONArray()
        for (item in tripCart.filter { !it.isSeed && it.title.lowercase() !in DEMO_SEED_TITLES && !VARIANT_NOISE_TITLE.matches(it.title.trim()) && !ScanHistoryStore.isPoisonedProduceEntry(it.title, it.fullJson) }) {
            arr.put(JSONObject().apply {
                put("key", item.key)
                put("title", item.title)
                put("score", item.score)
                put("fromCartScreen", item.fromCartScreen)
                put("lastSeenAtMs", item.lastSeenAtMs)
                item.swapObj?.let { put("swap", it) }
                item.fullJson?.let { put("fullJson", it) }
            })
        }
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putString("$KEY_TRIP_CART_PREFIX$currentStoreKey", arr.toString())
            .putInt(KEY_PILL_Y, pillY)
            .apply()
    }

    private fun loadPersistedCart(storeKey: String) {
        tripCart.clear()
        val raw = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString("$KEY_TRIP_CART_PREFIX$storeKey", null) ?: return
        runCatching {
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                val title = cleanCartTitle(o.optString("title"))
                if (title.isBlank() || title.lowercase() in DEMO_SEED_TITLES || VARIANT_NOISE_TITLE.matches(title.trim())) continue
                if (ScanHistoryStore.isPoisonedProduceEntry(title, o.optJSONObject("fullJson") ?: o)) continue
                val existing = tripCart.firstOrNull { isSameCartItem(it.key, title) || isSameCartItem(it.title, title) }
                if (existing != null) {
                    if (title.length > existing.title.length && !title.endsWith("...")) {
                        existing.title = title
                    }
                    continue
                }
                val score = o.optInt("score", 50)
                tripCart.add(
                    TripCartItem(
                        key = cleanCartTitle(o.optString("key")).ifBlank { title },
                        title = title,
                        score = score,
                        swapObj = o.optJSONObject("swap"),
                        isSeed = false,
                        fullJson = o.optJSONObject("fullJson"),
                        fromCartScreen = o.optBoolean("fromCartScreen", false),
                        lastSeenAtMs = o.optLong("lastSeenAtMs", 0L),
                    )
                )
            }
        }
    }

    private fun animateCartAvgClimb(from: Int, to: Int) {
        climbAnimator?.cancel()
        isCartAvgMode = true
        showPill()
        climbAnimator = ValueAnimator.ofInt(from, to).apply {
            duration = 750L
            addUpdateListener { anim ->
                if (!isCartAvgMode) return@addUpdateListener
                val v = anim.animatedValue as Int
                displayedCartAvg = v
                pillTextView?.text = "🛒 Cart Avg: $v/100"
                (pillDotView?.background as? GradientDrawable)?.setColor(toneColor(colorNameForScore(v)))
            }
            start()
        }
    }

    /* ---------------- Window params & 1-Switch Accessibility Overlay ---------------- */

    private val viewOwners = java.util.IdentityHashMap<View, WindowManager>()

    private fun canDisplayOverlay(): Boolean =
        GroceryScreenReaderService.activeWindowManager() != null || Settings.canDrawOverlays(this)

    private fun overlayParams(w: Int, h: Int, focusable: Boolean = false): WindowManager.LayoutParams {
        val windowType = if (GroceryScreenReaderService.activeWindowManager() != null) {
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
        } else {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        }
        return WindowManager.LayoutParams(
            w, h,
            windowType,
            (if (focusable) 0 else WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE) or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        )
    }

    private fun addOverlayView(view: View, params: WindowManager.LayoutParams): Boolean {
        val a11yWm = GroceryScreenReaderService.activeWindowManager()
        if (a11yWm != null) {
            params.type = WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
            if (runCatching { a11yWm.addView(view, params) }.isSuccess) {
                viewOwners[view] = a11yWm
                return true
            }
        }
        if (Settings.canDrawOverlays(this)) {
            params.type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            if (runCatching { wm.addView(view, params) }.isSuccess) {
                viewOwners[view] = wm
                return true
            }
        }
        return false
    }

    private fun updateOverlayView(view: View, params: WindowManager.LayoutParams) {
        val owner = viewOwners[view] ?: GroceryScreenReaderService.activeWindowManager() ?: wm
        runCatching { owner.updateViewLayout(view, params) }
    }

    private fun removeOverlayView(view: View?) {
        if (view == null) return
        val owner = viewOwners.remove(view)
        if (owner != null) {
            runCatching { owner.removeView(view) }
        } else {
            runCatching { GroceryScreenReaderService.activeWindowManager()?.removeView(view) }
            runCatching { wm.removeView(view) }
        }
    }

    /* ---------------- Bottom-Center Drag-to-Hide Target ---------------- */

    private fun showHideTarget(hot: Boolean = false) {
        if (hideTarget == null) {
            val tv = text("✕ Remove", 13f, Color.WHITE, bold = true).apply {
                setPadding(dp(18), dp(10), dp(18), dp(10))
                background = GradientDrawable().apply {
                    setColor(if (hot) 0xFFDC2626.toInt() else 0xDD141A17.toInt())
                    cornerRadius = dp(999).toFloat()
                    setStroke(dp(1), 0xFFF87171.toInt())
                }
            }
            val p = overlayParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
                y = dp(32)
            }
            if (addOverlayView(tv, p)) {
                hideTarget = tv
            }
        } else {
            (hideTarget?.background as? GradientDrawable)?.setColor(if (hot) 0xFFDC2626.toInt() else 0xDD141A17.toInt())
        }
    }

    private fun removeHideTarget() {
        removeOverlayView(hideTarget)
        hideTarget = null
    }

    /* ---------------- Dual-Mode Pill ---------------- */

    @SuppressLint("ClickableViewAccessibility")
    private fun showPill(loadingText: String? = null) {
        if (hiddenForCurrentScreen || !canDisplayOverlay()) return
        if (!isCartAvgMode) climbAnimator?.cancel()
        if (loadingText == null && !isCartAvgMode && !isPdpScrollHint) {
            ScanApi.applyLocalWatchlistToData(this, data)
        }
        val result = data?.optJSONObject("result")
        val ok = data?.optBoolean("ok") == true && result != null
        val effectiveScore = result?.optInt("score") ?: 50
        val avg = displayedCartAvg
        val dietaryAlerts = if (ok && !isCartAvgMode && loadingText == null && !isPdpScrollHint) {
            ScanApi.evaluateDietaryAlerts(this, data?.optJSONObject("product"), result, data)
        } else {
            emptyList()
        }
        val tone = when {
            loadingText != null || isPdpScrollHint -> Color.GRAY
            isCartAvgMode && tripCart.isEmpty() -> BRAND
            isCartAvgMode -> toneColor(colorNameForScore(avg))
            !ok -> Color.GRAY
            dietaryAlerts.isNotEmpty() -> 0xFFEF4444.toInt()
            else -> toneColor(colorNameForScore(effectiveScore))
        }
        val label = when {
            loadingText != null -> loadingText
            isPdpScrollHint -> "Scroll down to grade item"
            isCartAvgMode && tripCart.isEmpty() -> "🛒 Cart: Open Cart to Grade"
            isCartAvgMode -> "🛒 Cart Avg: $avg/100"
            ok && dietaryAlerts.isNotEmpty() -> {
                val badgeSummary = dietaryAlerts.take(2).joinToString(" + ") { it.shortBadge }
                val extraCount = if (dietaryAlerts.size > 2) " +${dietaryAlerts.size - 2}" else ""
                "⚠️ $badgeSummary$extraCount  •  $effectiveScore/100"
            }
            ok -> "$effectiveScore/100  •  Tap to Inspect"
            else -> data?.optString("error")?.take(48) ?: "HeyBroc"
        }

        // CRITICAL: If the pill window is already attached, update text and dot color IN-PLACE
        // instead of calling removeOverlayView() + addOverlayView(). Removing and re-adding a hardware overlay
        // window causes Android's InputDispatcher to cancel active touch events (ACTION_CANCEL) and glitch the screen!
        if (pill != null && pillTextView != null && pillDotView != null) {
            if (pillTextView?.text?.toString() != label) {
                pillTextView?.text = label
            }
            (pillDotView?.background as? GradientDrawable)?.setColor(tone)
            return
        }

        val mascotView = android.widget.ImageView(this).apply {
            setImageResource(R.drawable.broc_mascot)
            scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
            layoutParams = LinearLayout.LayoutParams(dp(24), dp(24)).apply { marginEnd = dp(8) }
        }
        val dotView = View(this).apply {
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(tone) }
            layoutParams = LinearLayout.LayoutParams(dp(9), dp(9)).apply { marginEnd = dp(8) }
        }
        val labelView = text(label, 14f, Color.WHITE, bold = true)

        val view = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(9), dp(14), dp(9))
            background = GradientDrawable().apply {
                setColor(0xEE141A17.toInt())
                cornerRadii = floatArrayOf(999f, 999f, 0f, 0f, 0f, 0f, 999f, 999f)
            }
            elevation = dp(8).toFloat()
            addView(mascotView)
            addView(dotView)
            addView(labelView)
        }

        val params = overlayParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT).apply {
            gravity = Gravity.TOP or Gravity.END
            x = 0
            y = pillY
        }

        var downRawX = 0f
        var downRawY = 0f
        var startY = 0
        var moved = false
        var overHide = false
        val touchSlop = dp(16)

        view.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = e.rawX
                    downRawY = e.rawY
                    startY = params.y
                    moved = false
                    overHide = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (downRawX - e.rawX).toInt()
                    val dy = (e.rawY - downRawY).toInt()
                    if (!moved && (abs(dx) > touchSlop || abs(dy) > touchSlop)) {
                        moved = true
                    }
                    if (moved) {
                        val curH = resources.displayMetrics.heightPixels
                        val curW = resources.displayMetrics.widthPixels
                        params.x = dx.coerceAtLeast(0)
                        params.y = (startY + dy).coerceIn(dp(24), (curH - dp(80)).coerceAtLeast(dp(48)))
                        pillY = params.y
                        overHide = e.rawY > curH * 0.80f && e.rawX > curW * 0.2f && e.rawX < curW * 0.8f
                        showHideTarget(overHide)
                        updateOverlayView(v, params)
                    }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    removeHideTarget()
                    if (moved && overHide) {
                        hiddenForCurrentScreen = true
                        removePill()
                    } else {
                        params.x = 0
                        persistCart()
                        updateOverlayView(v, params)
                        if (!moved) {
                            val currentlyOk = data?.optBoolean("ok") == true && data?.optJSONObject("result") != null
                            if (isPdpScrollHint) {
                                Toast.makeText(
                                    this,
                                    "Scroll down slightly so the product title is visible on screen",
                                    Toast.LENGTH_SHORT
                                ).show()
                            } else if (isCartAvgMode) {
                                showAuditorDrawer()
                            } else if (currentlyOk) {
                                showCard()
                            } else {
                                showAuditorDrawer()
                            }
                        }
                    }
                    true
                }
                else -> false
            }
        }

        if (!addOverlayView(view, params)) return
        pill = view
        pillDotView = dotView
        pillTextView = labelView
        pillParams = params
    }

    private fun removePill() {
        removeOverlayView(pill)
        pill = null
        pillDotView = null
        pillTextView = null
    }

    /* ---------------- Whole-Cart Auditor Drawer (Mode B tap) ---------------- */

    private fun showAuditorDrawer() {
        removeCard()
        removePill()
        val avg = calcCartAvg()
        val tone = toneColor(colorNameForScore(avg))
        val storeName = storeDisplayName(currentStoreKey)

        val backdrop = object : FrameLayout(this) {
            override fun dispatchKeyEvent(event: KeyEvent): Boolean {
                if (event.keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
                    removeCard(); showPill(); return true
                }
                return super.dispatchKeyEvent(event)
            }
        }.apply {
            setBackgroundColor(0x660C100E)
            isFocusableInTouchMode = true
            requestFocus()
            setOnClickListener { removeCard(); showPill() }
        }
        val sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(18))
            background = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = dp(26).toFloat() }
            elevation = dp(16).toFloat()
            isClickable = true
        }
        sheet.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(android.widget.ImageView(context).apply {
                setImageResource(R.drawable.broc_mascot)
                scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
                layoutParams = LinearLayout.LayoutParams(dp(36), dp(36)).apply { marginEnd = dp(10) }
            })
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                val itemCountLabel = if (tripCart.size == 1) "1 ITEM" else "${tripCart.size} ITEMS"
                addView(text("HEYBROC · ${storeName.uppercase()} CART ($itemCountLabel)", 11f, BRAND, bold = true))
                val headerText = if (tripCart.isEmpty()) "$storeName Cart: Empty" else "Cart Average: $avg/100"
                addView(text(headerText, 20f, INK, bold = true))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            if (tripCart.isNotEmpty()) {
                addView(text("Clear", 12f, INK_2, bold = true).apply {
                    setPadding(dp(10), dp(6), dp(10), dp(6))
                    background = GradientDrawable().apply { setColor(0xFFF4F3EE.toInt()); cornerRadius = dp(999).toFloat() }
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(8) }
                    setOnClickListener {
                        tripCart.clear()
                        displayedCartAvg = 100
                        persistCart()
                        showAuditorDrawer()
                    }
                })
            }
            addView(text("×", 22f, INK_2).apply {
                gravity = Gravity.CENTER
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFFF4F3EE.toInt()) }
                layoutParams = LinearLayout.LayoutParams(dp(34), dp(34))
                setOnClickListener { removeCard(); showPill() }
            })
        })

        if (tripCart.isEmpty()) {
            sheet.addView(text(
                "Open your $storeName Cart screen (or tap 'Add to cart' on any product) so HeyBroc can read and grade the actual items in your $storeName cart.",
                13.5f,
                INK_2
            ).apply { setPadding(0, dp(12), 0, dp(8)) })
        } else {
            sheet.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(12), 0, dp(8))
                addView(GaugeView(context, avg, "Cart Avg", tone), LinearLayout.LayoutParams(dp(84), dp(84)).apply { marginEnd = dp(14) })
                addView(
                    text(
                        "Showing ${tripCart.size} graded items across Delivery, Pickup & Shipping in your $storeName cart. Scroll your cart to load off-screen items.",
                        12.5f,
                        INK_2
                    ),
                    LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                )
            })
        }

        for (item in tripCart.toList()) {
            sheet.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(10), dp(10), dp(10), dp(10))
                background = GradientDrawable().apply { setColor(0xFFF4F3EE.toInt()); cornerRadius = dp(12).toFloat() }
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) }
                isClickable = true
                setOnClickListener { openCartItemAnalysis(item) }
                addView(text(item.title, 13f, INK, bold = true).apply {
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                })
                addView(text("${item.score}/100", 12.5f, toneColor(colorNameForScore(item.score)), bold = true).apply {
                    setPadding(dp(8), dp(4), dp(8), dp(4))
                })
                if (item.score < 75 && item.swapObj != null) {
                    val itemPaid = item.swapObj?.optBoolean("isPaidLink", false) == true
                    addView(text(if (itemPaid) "Swap · paid link" else "Swap", 12f, Color.WHITE, bold = true).apply {
                        setPadding(dp(10), dp(5), dp(10), dp(5))
                        background = GradientDrawable().apply { setColor(BRAND); cornerRadius = dp(999).toFloat() }
                        setOnClickListener { openSwap(item.swapObj!!, item) }
                    })
                }
                addView(text("✕", 13f, INK_3, bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(8), dp(4), dp(4), dp(4))
                    setOnClickListener {
                        tripCart.removeAll { it.key == item.key }
                        displayedCartAvg = calcCartAvg()
                        persistCart()
                        showAuditorDrawer()
                    }
                })
            })
        }

        val dirtyWithSwaps = tripCart.filter { it.score < 75 && it.swapObj != null }
        if (dirtyWithSwaps.isNotEmpty()) {
            val projectedAvg = if (tripCart.isEmpty()) 100 else {
                tripCart.sumOf { item ->
                    if (item.score < 75 && item.swapObj != null) {
                        val s = item.swapObj!!.optInt("score", 0)
                        if (s > 0) s.coerceAtLeast(item.score) else item.score
                    } else {
                        item.score
                    }
                } / tripCart.size
            }
            val rem = ScanApi.swapsRemaining(this)
            val lim = ScanApi.weeklySwapsLimit(this)
            val count = dirtyWithSwaps.size
            val anyPaidLink = dirtyWithSwaps.any { it.swapObj?.optBoolean("isPaidLink", false) == true }
            val paidSuffix = if (anyPaidLink) " · paid link" else ""
            val ctaText = when {
                count == 1 -> {
                    val onlyItem = dirtyWithSwaps[0]
                    val swapObj = onlyItem.swapObj!!
                    val swapTitle = swapObj.optString("title", "Clean Alternative")
                    val swapScore = swapObj.optInt("score", 0)
                    val scoreTag = if (swapScore > 0) " ($swapScore/100)" else ""
                    val unlocked = ScanApi.isSwapUnlocked(this, onlyItem.title, swapTitle)
                    when {
                        unlocked -> "🔁 Swap Flagged Item → $swapTitle$scoreTag$paidSuffix"
                        rem > 0 -> "🔓 Reveal Clean Swap$scoreTag · $rem/$lim Free Left$paidSuffix"
                        else -> "🔒 Unlock Clean Swap$scoreTag — Go Pro"
                    }
                }
                ScanApi.isProActive(this) || rem > 0 ->
                    "🔁 Swap All $count Flagged Items (Cart Avg $avg → $projectedAvg/100)$paidSuffix"
                else ->
                    "🔒 Swap All $count Flagged Items (Avg $avg → $projectedAvg/100) — Go Pro"
            }
            sheet.addView(text(ctaText, 13.5f, Color.WHITE, bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(16), dp(13), dp(16), dp(13))
                background = GradientDrawable().apply { setColor(BRAND); cornerRadius = dp(999).toFloat() }
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(14) }
                setOnClickListener {
                    if (count == 1) {
                        val onlyItem = dirtyWithSwaps[0]
                        val firstSwap = onlyItem.swapObj!!
                        val swapTitle = firstSwap.optString("title", "Clean Alternative")
                        val swapUnlocked = ScanApi.isSwapUnlocked(this@OverlayWindowService, onlyItem.title, swapTitle)
                        if (!swapUnlocked && rem <= 0) {
                            val i = Intent(Intent.ACTION_VIEW, Uri.parse(ScanApi.upgradeUrl(this@OverlayWindowService))).apply {
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            removeCard()
                            showPill()
                            runCatching { startActivity(i) }
                        } else {
                            openSwap(firstSwap, onlyItem)
                        }
                    } else {
                        showSwapAllModal(dirtyWithSwaps, avg, projectedAvg)
                    }
                }
            })
        }

        val myRefCode = ScanApi.myReferralCode(this)
        sheet.addView(text("🎁 Invite a Friend ($myRefCode) → Both Get +7 Free Pro Days", 12.5f, BRAND, bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(14), dp(11), dp(14), dp(11))
            background = GradientDrawable().apply {
                setColor(0xFFE6F5EC.toInt())
                cornerRadius = dp(999).toFloat()
                setStroke(dp(1), 0x4416A34A)
            }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) }
            setOnClickListener {
                val url = "https://www.heybroc.com/r/$myRefCode"
                val msg = "Check out HeyBroc — this little broccoli floats over Walmart, Target, Costco, Sam's, BJ's, Amazon Fresh, Instacart & more to grade ingredients (0–100) and swap dirty items in 1 tap. Use my invite link so we both get +7 Free Days of HeyBroc Pro: $url"
                val sendIntent = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_SUBJECT, "7 Free Days of HeyBroc Pro")
                    putExtra(Intent.EXTRA_TEXT, msg)
                }
                val chooser = Intent.createChooser(sendIntent, "Share your HeyBroc invite link").apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                removeCard()
                showPill()
                runCatching { startActivity(chooser) }
            }
        })

        val scroll = ScrollView(this).apply { addView(sheet); isFillViewport = false }
        backdrop.addView(scroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply {
            setMargins(dp(10), dp(10), dp(10), dp(24))
        })
        if (addOverlayView(backdrop, overlayParams(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, focusable = true))) {
            card = backdrop
            isAuditorOpen = true
        }
    }

    /**
     * Whole-Cart "Swap All Flagged Items" modal: shows every <75 cart item paired with its 1-for-1 Clean Swap
     * so the shopper sees exactly which items are being replaced and can swap them all or start with the lowest score.
     */
    private fun showSwapAllModal(dirtyWithSwaps: List<TripCartItem>, currentAvg: Int, projectedAvg: Int) {
        removeCard()
        removePill()
        val storeName = storeDisplayName(currentStoreKey)
        val sortedDirty = dirtyWithSwaps.sortedBy { it.score }

        val backdrop = object : FrameLayout(this) {
            override fun dispatchKeyEvent(event: KeyEvent): Boolean {
                if (event.keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
                    showAuditorDrawer(); return true
                }
                return super.dispatchKeyEvent(event)
            }
        }.apply {
            setBackgroundColor(0x660C100E)
            isFocusableInTouchMode = true
            requestFocus()
            setOnClickListener { showAuditorDrawer() }
        }

        val sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(18))
            background = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = dp(26).toFloat() }
            elevation = dp(16).toFloat()
            isClickable = true
        }

        sheet.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                addView(text("HEYBROC · WHOLE-CART CLEAN UP", 11f, BRAND, bold = true).apply { letterSpacing = 0.06f })
                addView(text("Swap All ${sortedDirty.size} Flagged Items", 19f, INK, bold = true))
                addView(text("Boost your $storeName Cart Avg from $currentAvg/100 → $projectedAvg/100", 12.5f, 0xFF16A34A.toInt(), bold = true).apply {
                    setPadding(0, dp(2), 0, 0)
                })
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            addView(text("×", 22f, INK_2).apply {
                gravity = Gravity.CENTER
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFFF4F3EE.toInt()) }
                layoutParams = LinearLayout.LayoutParams(dp(34), dp(34))
                setOnClickListener { showAuditorDrawer() }
            })
        })

        for (item in sortedDirty) {
            val swapObj = item.swapObj ?: continue
            val swapTitle = swapObj.optString("title", "Clean Alternative")
            val swapScore = swapObj.optInt("score", 0)
            val swapScoreSuffix = if (swapScore > 0) " ($swapScore/100)" else ""
            val swapPaid = swapObj.optBoolean("isPaidLink", false)
            sheet.addView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(12), dp(10), dp(12), dp(10))
                background = GradientDrawable().apply {
                    setColor(0xFFF7F7F3.toInt())
                    cornerRadius = dp(14).toFloat()
                    setStroke(dp(1), 0x2215201B)
                }
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) }

                addView(text("Replace: ${item.title} (${item.score}/100)", 12f, 0xFFB91C1C.toInt(), bold = true).apply {
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                })
                addView(LinearLayout(context).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(0, dp(5), 0, 0)
                    addView(text("➔ $swapTitle$swapScoreSuffix", 13f, 0xFF0B5E39.toInt(), bold = true).apply {
                        maxLines = 2
                        ellipsize = TextUtils.TruncateAt.END
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                    })
                    addView(text(if (swapPaid) "Swap ↗ · paid link" else "Swap ↗", 12f, Color.WHITE, bold = true).apply {
                        setPadding(dp(12), dp(7), dp(12), dp(7))
                        background = GradientDrawable().apply { setColor(BRAND); cornerRadius = dp(999).toFloat() }
                        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8) }
                        setOnClickListener { openSwap(swapObj, item) }
                    })
                })
            })
        }

        val worstItem = sortedDirty.firstOrNull()
        if (worstItem?.swapObj != null) {
            val worstPaid = worstItem.swapObj?.optBoolean("isPaidLink", false) == true
            val worstSuffix = if (worstPaid) " · paid link" else ""
            sheet.addView(text("⚡ Start with Lowest Score (${worstItem.score}/100) in $storeName ↗$worstSuffix", 13.5f, Color.WHITE, bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(16), dp(13), dp(16), dp(13))
                background = GradientDrawable().apply { setColor(BRAND); cornerRadius = dp(999).toFloat() }
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(14) }
                setOnClickListener { openSwap(worstItem.swapObj!!, worstItem) }
            })
        }

        sheet.addView(text("← Back to Cart Check", 13f, INK_2, bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(14), dp(10), dp(14), dp(10))
            background = GradientDrawable().apply { setColor(0xFFF4F3EE.toInt()); cornerRadius = dp(999).toFloat() }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) }
            setOnClickListener { showAuditorDrawer() }
        })

        val scroll = ScrollView(this).apply { addView(sheet); isFillViewport = false }
        backdrop.addView(scroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply {
            setMargins(dp(10), dp(10), dp(10), dp(24))
        })
        if (addOverlayView(backdrop, overlayParams(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, focusable = true))) {
            card = backdrop
            isAuditorOpen = true
        }
    }

    private fun openCartItemAnalysis(item: TripCartItem) {
        val rating = when {
            item.score >= 75 -> "Excellent"
            item.score >= 50 -> "Good"
            item.score >= 25 -> "Poor"
            else -> "Bad"
        }
        val fallbackJson = JSONObject().apply {
            put("ok", true)
            put("product", JSONObject().apply { put("title", item.title) })
            put("result", JSONObject().apply {
                put("score", item.score)
                put("rating", rating)
                put("color", colorNameForScore(item.score))
                put("flagged", JSONArray())
            })
            item.swapObj?.let { put("swap", it) }
        }
        data = item.fullJson ?: fallbackJson
        openFlag = null
        showCard()
    }

    /* ---------------- Health Insights card (Mode A tap) ---------------- */

    private fun showCard() {
        val d = data ?: return
        val result = d.optJSONObject("result") ?: return
        val flagged = result.optJSONArray("flagged")
        val score = result.optInt("score")
        val ratingLabel = when {
            score >= 75 -> "Excellent"
            score >= 50 -> "Good"
            score >= 25 -> "Poor"
            else -> "Bad"
        }
        val tone = toneColor(colorNameForScore(score))
        val swap = d.optJSONObject("swap")
        removeCard()
        removePill()

        val backdrop = object : FrameLayout(this) {
            override fun dispatchKeyEvent(event: KeyEvent): Boolean {
                if (event.keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
                    removeCard(); showPill(); return true
                }
                return super.dispatchKeyEvent(event)
            }
        }.apply {
            setBackgroundColor(0x660C100E)
            isFocusableInTouchMode = true
            requestFocus()
            setOnClickListener { removeCard(); showPill() }
        }

        val sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(14))
            background = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = dp(24).toFloat() }
            elevation = dp(16).toFloat()
            isClickable = true
        }

        // Compact Header
        val cartAvgBadge = if (tripCart.isEmpty()) "HEYBROC · PRODUCT GRADE" else "HEYBROC · CART AVG ${calcCartAvg()}/100"
        val prodObj = d.optJSONObject("product")
        val prodTitle = prodObj?.optString("title").orEmpty()
        val prodBrand = prodObj?.optString("brand").orEmpty()
        val prodDesc = prodObj?.optString("description").orEmpty()
        val prodIngredients = prodObj?.optString("ingredients").orEmpty()
        sheet.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(text(cartAvgBadge, 11f, INK_3, bold = true).apply {
                letterSpacing = 0.07f
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            if (prodTitle.isNotBlank()) {
                val favInit = ScanHistoryStore.isFavorite(this@OverlayWindowService, prodTitle)
                addView(text(if (favInit) "♥" else "♡", 17f, if (favInit) 0xFFDC2626.toInt() else INK_2, bold = true).apply {
                    gravity = Gravity.CENTER
                    background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFFF4F3EE.toInt()) }
                    layoutParams = LinearLayout.LayoutParams(dp(30), dp(30)).apply { marginEnd = dp(6) }
                    setOnClickListener {
                        val nowFav = ScanHistoryStore.toggleFavorite(this@OverlayWindowService, d)
                        this.text = if (nowFav) "♥" else "♡"
                        this.setTextColor(if (nowFav) 0xFFDC2626.toInt() else INK_2)
                    }
                })
            }
            addView(text("×", 20f, INK_2).apply {
                gravity = Gravity.CENTER
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFFF4F3EE.toInt()) }
                layoutParams = LinearLayout.LayoutParams(dp(30), dp(30))
                setOnClickListener { removeCard(); showPill() }
            })
        })
        if (prodTitle.isNotBlank()) {
            val prodThumbJson = JSONObject().apply {
                put("title", prodTitle)
                put("imageUrl", prodObj?.optString("imageUrl").orEmpty())
                put("isProductHeader", true)
            }
            sheet.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(6), 0, dp(2))
                addView(buildSwapThumbnailView(prodThumbJson, dp(44)).apply {
                    layoutParams = LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginEnd = dp(10) }
                })
                addView(LinearLayout(context).apply {
                    orientation = LinearLayout.VERTICAL
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                    if (prodBrand.isNotBlank() && !prodTitle.startsWith(prodBrand, ignoreCase = true)) {
                        addView(text(prodBrand.uppercase(), 9.5f, BRAND, bold = true).apply {
                            letterSpacing = 0.05f
                        })
                    }
                    addView(text(prodTitle, 13f, INK, bold = true).apply {
                        maxLines = 2
                        ellipsize = TextUtils.TruncateAt.END
                    })
                    if (prodDesc.isNotBlank()) {
                        addView(text(prodDesc, 11f, INK_2).apply {
                            maxLines = 2
                            ellipsize = TextUtils.TruncateAt.END
                            setPadding(0, dp(1), 0, 0)
                        })
                    }
                })
            })
        }

        // Personal Allergy & Diabetes Watch Alert Banner (only shown when user checked corresponding box)
        val dietaryAlerts = ScanApi.evaluateDietaryAlerts(this, prodObj, result, d)
        if (dietaryAlerts.isNotEmpty()) {
            sheet.addView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(12), dp(10), dp(12), dp(10))
                background = GradientDrawable().apply {
                    setColor(0xFFFEF2F2.toInt())
                    setStroke(dp(1), 0xFFFCA5A5.toInt())
                    cornerRadius = dp(12).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(8) }

                addView(text("⚠️ PERSONAL ALLERGY & DIET ALERT", 10.5f, 0xFF991B1B.toInt(), bold = true).apply {
                    letterSpacing = 0.05f
                })
                dietaryAlerts.forEach { alert ->
                    addView(text("${alert.label}: ${alert.reason}", 12f, 0xFF7F1D1D.toInt(), bold = true).apply {
                        setPadding(0, dp(4), 0, 0)
                    })
                }
            })
        }

        // Flagged additive description list
        val flagCount = flagged?.length() ?: 0
        val explain = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        if (flagged != null && flagCount > 0) {
            for (i in 0 until flagCount) {
                val f = flagged.getJSONObject(i)
                val (bg, fg) = riskColors(f.optString("risk"))
                explain.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(10), dp(7), dp(10), dp(7))
                    background = GradientDrawable().apply { setColor(bg); cornerRadius = dp(11).toFloat() }
                    addView(text("${i + 1}. ${f.optString("name")}  ·  −${f.optInt("penalty")} pts", 12f, fg, bold = true))
                    val expText = f.optString("explanation")
                    if (expText.isNotBlank()) {
                        addView(text(expText, 11f, INK).apply {
                            maxLines = 2
                            ellipsize = TextUtils.TruncateAt.END
                            setPadding(0, dp(2), 0, 0)
                        })
                    }
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        topMargin = if (i == 0) dp(4) else dp(5)
                    }
                })
            }
        }

        // Expandable ScrollView: starts compact (3 items visible) when flagCount > 3 so Clean Swap is visible,
        // and expands to show ALL flagged items when the user taps the header button.
        var showAllFlags = flagCount <= 3
        val explainScroll = object : ScrollView(this) {
            override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
                val maxH = if (showAllFlags) dp(540) else dp(185)
                val cappedSpec = MeasureSpec.makeMeasureSpec(maxH, MeasureSpec.AT_MOST)
                super.onMeasure(widthMeasureSpec, cappedSpec)
            }
        }.apply {
            addView(explain)
            isVerticalScrollBarEnabled = true
            isScrollbarFadingEnabled = false
            visibility = if (flagCount > 0) View.VISIBLE else View.GONE
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(6)
            }
        }

        // Compact Gauge + Dropdown Toggle header
        var issuesState = if (flagCount > 3) 1 else 2 // 1 = compact (3 visible), 2 = all expanded, 0 = hidden
        fun toggleLabelForState(st: Int): String = when {
            flagCount == 0 -> "✓ No Watchlist Additives Found"
            flagCount <= 3 -> if (st == 0) "▶ $flagCount Flagged Issue${if (flagCount == 1) "" else "s"} · Tap to show"
                              else "▼ $flagCount Flagged Issue${if (flagCount == 1) "" else "s"} · Tap to hide"
            st == 1 -> "▼ Showing 3 of $flagCount Flagged Issues · Tap to see all $flagCount"
            st == 2 -> "▲ Showing all $flagCount Flagged Issues · Tap to hide"
            else -> "▶ $flagCount Flagged Issues · Tap to show all $flagCount"
        }

        val toggleBtn = text(
            toggleLabelForState(issuesState),
            12f,
            if (flagCount == 0) 0xFF16A34A.toInt() else 0xFFB91C1C.toInt(),
            bold = true
        ).apply {
            setPadding(dp(10), dp(7), dp(10), dp(7))
            background = GradientDrawable().apply {
                setColor(if (flagCount == 0) 0xFFE6F5EC.toInt() else 0xFFFDECEC.toInt())
                cornerRadius = dp(10).toFloat()
            }
            if (flagCount > 0) {
                setOnClickListener {
                    issuesState = when {
                        flagCount <= 3 -> if (issuesState == 0) 2 else 0
                        issuesState == 1 -> 2 // compact -> expand all 6
                        issuesState == 2 -> 0 // expanded -> hide
                        else -> 2             // hidden -> expand all 6
                    }
                    showAllFlags = (issuesState == 2)
                    explainScroll.visibility = if (issuesState == 0) View.GONE else View.VISIBLE
                    explainScroll.requestLayout()
                    text = toggleLabelForState(issuesState)
                }
            }
        }

        val rightSummaryCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            addView(toggleBtn)
            result.optJSONObject("yukaBreakdown")?.let { yb ->
                val nutScore = yb.optInt("nutritionScore", 0)
                val nutGrade = yb.optString("nutriScoreGrade", "C")
                val addScore = yb.optInt("additiveScore", 0)
                val orgScore = yb.optInt("organicScore", 0)
                val capped = yb.optBoolean("highRiskCapped", false)
                val summaryText = buildString {
                    append("Nutrition $nutScore/60 ($nutGrade) · Additives $addScore/30 · Organic $orgScore/10")
                    if (capped) append(" · ⚠️ Capped ≤49")
                }
                addView(text(summaryText, 10.5f, INK_2, bold = true).apply {
                    setPadding(dp(2), dp(5), dp(2), 0)
                })
            }
        }

        sheet.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(8), 0, 0)
            addView(GaugeView(context, score, ratingLabel, tone), LinearLayout.LayoutParams(dp(74), dp(74)).apply { marginEnd = dp(12) })
            addView(rightSummaryCol)
        })

        // Add the collapsible, height-bounded descriptions list right below the top row
        sheet.addView(explainScroll)

        // Scanned Product Ingredients box (tap to expand/collapse)
        if (prodIngredients.isNotBlank()) {
            var ingExpanded = false
            val ingHeaderTv = text("INGREDIENTS", 9.5f, INK_3, bold = true).apply {
                letterSpacing = 0.06f
            }
            val ingBodyTv = text(prodIngredients, 11f, INK_2).apply {
                maxLines = 2
                ellipsize = TextUtils.TruncateAt.END
                setPadding(0, dp(2), 0, 0)
            }
            sheet.addView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(10), dp(7), dp(10), dp(7))
                background = GradientDrawable().apply {
                    setColor(0xFFF7F7F3.toInt())
                    cornerRadius = dp(11).toFloat()
                    setStroke(dp(1), 0x1815201B)
                }
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    topMargin = dp(7)
                }
                addView(ingHeaderTv)
                addView(ingBodyTv)
                setOnClickListener {
                    ingExpanded = !ingExpanded
                    ingBodyTv.maxLines = if (ingExpanded) 12 else 2
                }
            })
        }

        // Pinned Clean Swap box at the bottom of the card — ALWAYS visible without scrolling!
        val swapBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(11), dp(10), dp(11), dp(10))
            background = GradientDrawable().apply { setColor(0xFFE6F5EC.toInt()); cornerRadius = dp(16).toFloat(); setStroke(dp(1), 0x2E16A34A) }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) }
        }
        if (swap != null) {
            val swapTitle = swap.optString("title", "Clean Alternative")
            val swapScore = swap.optInt("score", 0)
            val swapRating = when {
                swapScore >= 75 -> "Excellent"
                swapScore >= 50 -> "Good"
                swapScore >= 25 -> "Poor"
                else -> "Bad"
            }
            val swapScoreBadge = if (swapScore > 0) "$swapScore/100 $swapRating" else "Clean Alternative"
            val swapIngredients = swap.optString("ingredients").trim()
            val swapUnlocked = ScanApi.isSwapUnlocked(this, prodTitle, swapTitle)
            val rem = ScanApi.swapsRemaining(this)
            val lim = ScanApi.weeklySwapsLimit(this)
            val isPaidLink = swap.optBoolean("isPaidLink", false)
            val storeName = storeDisplayName(currentStoreKey)
            val isInCart = tripCart.any { isSameCartItem(it.key, prodTitle) || isSameCartItem(it.title, prodTitle) }
            val baseSwapCta = if (isInCart) "Swap in $storeName ↗" else "Find in $storeName ↗"
            val swapBtnLabel = if (isPaidLink) "$baseSwapCta · paid link" else baseSwapCta

            if (swapUnlocked) {
                val topRow = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                }

                // Product photo thumbnail (46dp x 46dp rounded) — tapping opens full Swap Preview
                val thumbView = buildSwapThumbnailView(swap, dp(46)).apply {
                    layoutParams = LinearLayout.LayoutParams(dp(46), dp(46)).apply { marginEnd = dp(9) }
                    setOnClickListener { showSwapPreviewModal(swap) }
                }
                topRow.addView(thumbView)

                // Title + score + "Tap to preview" — tapping opens full Swap Preview
                topRow.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    isClickable = true
                    setOnClickListener { showSwapPreviewModal(swap) }
                    addView(text("CLEAN SWAP · TAP TO PREVIEW", 9.5f, BRAND, bold = true).apply { letterSpacing = 0.05f })
                    addView(text(swapTitle, 12.5f, INK, bold = true).apply {
                        maxLines = 2
                        ellipsize = TextUtils.TruncateAt.END
                    })
                    addView(text(swapScoreBadge, 11f, 0xFF16A34A.toInt(), bold = true))
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                })

                // Action button — auto-searches directly inside the store app & saves to Favorites
                topRow.addView(text(swapBtnLabel, 11.5f, Color.WHITE, bold = true).apply {
                    setPadding(dp(12), dp(9), dp(12), dp(9))
                    background = GradientDrawable().apply { setColor(BRAND); cornerRadius = dp(999).toFloat() }
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(6) }
                    setOnClickListener { openSwap(swap) }
                })
                swapBox.addView(topRow)

                if (swapIngredients.isNotBlank()) {
                    swapBox.addView(text("✓ Clean Ingredients: $swapIngredients", 11f, 0xFF0B5E39.toInt()).apply {
                        maxLines = 1
                        ellipsize = TextUtils.TruncateAt.END
                        setPadding(0, dp(5), 0, 0)
                        setOnClickListener { showSwapPreviewModal(swap) }
                    })
                }
            } else if (rem > 0) {
                // Free user with remaining free swaps: hide brand/product name until they tap Reveal!
                swapBox.addView(text("🔒 CLEAN SWAP FOUND · ${swapScoreBadge.uppercase()}", 9.5f, BRAND, bold = true).apply {
                    letterSpacing = 0.05f
                })
                swapBox.addView(text("1-for-1 Clean Alternative (0 Flagged Additives)", 12.5f, INK, bold = true).apply {
                    setPadding(0, dp(3), 0, 0)
                })
                swapBox.addView(text("You have $rem of $lim free Clean Swaps remaining.", 11f, 0xFF0B5E39.toInt()).apply {
                    setPadding(0, dp(2), 0, dp(7))
                })
                swapBox.addView(text("🔓 Reveal Clean Swap ($rem/$lim Free)", 12.5f, Color.WHITE, bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(14), dp(10), dp(14), dp(10))
                    background = GradientDrawable().apply { setColor(BRAND); cornerRadius = dp(999).toFloat() }
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                    setOnClickListener {
                        if (ScanApi.unlockSwapForProduct(this@OverlayWindowService, prodTitle, swapTitle)) {
                            showCard()
                        }
                    }
                })
            } else {
                // Free user out of free swaps (0/5 left): keep brand/product name locked behind Pro / Referral!
                swapBox.addView(text("🔒 CLEAN SWAP LOCKED · ${swapScoreBadge.uppercase()}", 9.5f, 0xFF92400E.toInt(), bold = true).apply {
                    letterSpacing = 0.05f
                })
                swapBox.addView(text("${if (swapScore > 0) "$swapScore/100 " else ""}Clean Replacement Available", 12.5f, INK, bold = true).apply {
                    setPadding(0, dp(3), 0, 0)
                })
                swapBox.addView(text("All $lim free Clean Swaps used. Upgrade to HeyBroc Pro for unlimited 1-tap swaps, or invite a friend for +7 free Pro days!", 11f, INK_2).apply {
                    setPadding(0, dp(2), 0, dp(8))
                })
                swapBox.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    addView(text("⚡ Go Pro — Unlimited ↗", 12f, Color.WHITE, bold = true).apply {
                        gravity = Gravity.CENTER
                        setPadding(dp(10), dp(9), dp(10), dp(9))
                        background = GradientDrawable().apply { setColor(BRAND); cornerRadius = dp(999).toFloat() }
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = dp(6) }
                        setOnClickListener {
                            val i = Intent(Intent.ACTION_VIEW, Uri.parse(ScanApi.upgradeUrl(this@OverlayWindowService))).apply {
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            removeCard()
                            showPill()
                            runCatching { startActivity(i) }
                        }
                    })
                    addView(text("🎁 Invite (+7d Free)", 12f, BRAND, bold = true).apply {
                        gravity = Gravity.CENTER
                        setPadding(dp(10), dp(9), dp(10), dp(9))
                        background = GradientDrawable().apply {
                            setColor(Color.WHITE)
                            cornerRadius = dp(999).toFloat()
                            setStroke(dp(1), BRAND)
                        }
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                        setOnClickListener {
                            val myRefCode = ScanApi.myReferralCode(this@OverlayWindowService)
                            val url = "https://www.heybroc.com/r/$myRefCode"
                            val msg = "Check out HeyBroc — this little broccoli floats over Walmart, Target, Costco, Sam's, BJ's, Amazon Fresh, Instacart & more to grade ingredients (0–100) and swap dirty items in 1 tap. Use my invite link so we both get +7 Free Days of HeyBroc Pro: $url"
                            val sendIntent = Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                                type = "text/plain"
                                putExtra(Intent.EXTRA_SUBJECT, "7 Free Days of HeyBroc Pro")
                                putExtra(Intent.EXTRA_TEXT, msg)
                            }, "Share your HeyBroc invite link").apply {
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            removeCard()
                            showPill()
                            runCatching { startActivity(sendIntent) }
                        }
                    })
                })
            }
        } else {
            swapBox.addView(text("✓ Great pick — 0 Watchlist Additives ($score/100).", 12.5f, 0xFF0B5E39.toInt(), bold = true))
        }
        sheet.addView(swapBox)
        val lookupObj = d.optJSONObject("lookup")
        val rawSource = lookupObj?.optString("origin")?.ifBlank { lookupObj.optString("source") }.orEmpty()
            .ifBlank { d.optString("source").ifBlank { prodObj?.optString("source").orEmpty() } }
        val sourceUpdated = lookupObj?.optString("sourceUpdatedAt").orEmpty()
            .ifBlank { d.optString("sourceUpdatedAt").ifBlank { prodObj?.optString("sourceUpdatedAt").orEmpty() } }
        val sourceLabel = when (rawSource) {
            "usda" -> "USDA FoodData Central"
            "openfoodfacts" -> "Open Food Facts"
            "catalog" -> "Representative formulation — verify physical label"
            "screen" -> "On-screen package text"
            else -> "Ingredient lookup"
        }
        val prodImageRaw = prodObj?.optString("imageUrl").orEmpty()
        val swapImageRaw = swap?.optString("imageUrl").orEmpty().ifBlank { swap?.optString("image").orEmpty() }
        val usesOffPhotos = rawSource == "openfoodfacts" ||
            prodImageRaw.contains("openfoodfacts", ignoreCase = true) ||
            prodImageRaw.contains("/api/product-image", ignoreCase = true) ||
            swapImageRaw.contains("openfoodfacts", ignoreCase = true) ||
            swapImageRaw.contains("/api/product-image", ignoreCase = true) ||
            prodTitle.isNotBlank()
        val provenanceLine = buildString {
            append("Source: $sourceLabel")
            if (sourceUpdated.isNotBlank() && sourceUpdated != "null") append(" (updated $sourceUpdated)")
            append(" · Tap to report a mistake")
        }
        sheet.addView(
            text(provenanceLine, 9.5f, BRAND, bold = true).apply {
                setPadding(dp(2), dp(6), dp(2), 0)
                setOnClickListener {
                    runCatching {
                        val subject = java.net.URLEncoder.encode("Ingredient label correction: $prodTitle", "UTF-8")
                        val mailIntent = android.content.Intent(
                            android.content.Intent.ACTION_VIEW,
                            android.net.Uri.parse("mailto:support@heybroc.com?subject=$subject")
                        ).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                        startActivity(mailIntent)
                    }
                }
            }
        )
        if (usesOffPhotos) {
            sheet.addView(
                text("Photos: Open Food Facts (CC BY-SA 3.0) ↗", 9.5f, BRAND, bold = true).apply {
                    setPadding(dp(2), dp(3), dp(2), 0)
                    setOnClickListener {
                        runCatching {
                            val offIntent = android.content.Intent(
                                android.content.Intent.ACTION_VIEW,
                                android.net.Uri.parse("https://world.openfoodfacts.org/terms-of-use")
                            ).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                            startActivity(offIntent)
                        }
                    }
                }
            )
        }
        sheet.addView(
            text(
                "Informational opinion only — not medical advice. Scores reflect HeyBroc's independent clean-label rubric. Formulations vary by region and lot; always verify the physical package label.",
                9.5f,
                INK_3
            ).apply {
                setPadding(dp(2), dp(4), dp(2), 0)
            }
        )

        val outerScroll = ScrollView(this).apply {
            addView(sheet)
            isFillViewport = false
            isVerticalScrollBarEnabled = false
        }
        backdrop.addView(outerScroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply {
            setMargins(dp(10), dp(10), dp(10), dp(20))
        })

        val params = overlayParams(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, focusable = true)
        if (addOverlayView(backdrop, params)) {
            card = backdrop
        }
    }

    /**
     * Full Clean Swap Preview modal: lets the user inspect the swap product's photo, score,
     * and complete ingredient list BEFORE jumping into the store app.
     */
    private fun showSwapPreviewModal(swap: JSONObject) {
        removeCard()
        removePill()
        val swapTitle = swap.optString("title", "Clean Alternative")
        val swapScore = swap.optInt("score", 0)
        val swapRating = when {
            swapScore >= 75 -> "Excellent"
            swapScore >= 50 -> "Good"
            swapScore >= 25 -> "Poor"
            else -> "Bad"
        }
        val swapSize = swap.optString("size")
        val swapIngredients = swap.optString("ingredients").trim()
        val storeName = storeDisplayName(currentStoreKey)
        val prodTitleForModal = data?.optJSONObject("product")?.optString("title").orEmpty()
        val isInCart = tripCart.any { isSameCartItem(it.key, prodTitleForModal) || isSameCartItem(it.title, prodTitleForModal) }
        val isPaidLink = swap.optBoolean("isPaidLink", false)
        val baseModalCta = if (isInCart) "🔍 Swap in $storeName ↗" else "🔍 Find in $storeName ↗"
        val modalSwapCta = if (isPaidLink) "$baseModalCta · paid link" else baseModalCta

        val backdrop = object : FrameLayout(this) {
            override fun dispatchKeyEvent(event: KeyEvent): Boolean {
                if (event.keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
                    showCard(); return true
                }
                return super.dispatchKeyEvent(event)
            }
        }.apply {
            setBackgroundColor(0x660C100E)
            isFocusableInTouchMode = true
            requestFocus()
            setOnClickListener { showCard() }
        }

        val sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(18))
            background = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = dp(26).toFloat() }
            elevation = dp(16).toFloat()
            isClickable = true
        }

        // Header
        sheet.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(buildSwapThumbnailView(swap, dp(64)).apply {
                layoutParams = LinearLayout.LayoutParams(dp(64), dp(64)).apply { marginEnd = dp(12) }
            })
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                addView(text("CLEAN SWAP PREVIEW", 11f, BRAND, bold = true).apply { letterSpacing = 0.08f })
                addView(text(swapTitle, 18f, INK, bold = true))
                if (swapSize.isNotBlank()) {
                    addView(text(swapSize, 12.5f, INK_2).apply { setPadding(0, dp(2), 0, 0) })
                }
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            addView(text("×", 22f, INK_2).apply {
                gravity = Gravity.CENTER
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFFF4F3EE.toInt()) }
                layoutParams = LinearLayout.LayoutParams(dp(34), dp(34))
                setOnClickListener { showCard() }
            })
        })

        // Score Gauge + Zero Watchlist Additives badge
        sheet.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(14), 0, dp(10))
            addView(GaugeView(context, swapScore, swapRating, 0xFF16A34A.toInt()), LinearLayout.LayoutParams(dp(92), dp(92)).apply { marginEnd = dp(14) })
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                addView(text("✓ 0 Watchlist Additives", 14f, 0xFF16A34A.toInt(), bold = true))
                addView(text("Clean 1-for-1 replacement with whole-food ingredients.", 12.5f, INK_2).apply {
                    setPadding(0, dp(4), 0, 0)
                })
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
        })

        // Full Clean Ingredients Box
        if (swapIngredients.isNotBlank()) {
            sheet.addView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(12), dp(14), dp(12))
                background = GradientDrawable().apply { setColor(0xFFE6F5EC.toInt()); cornerRadius = dp(16).toFloat() }
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) }
                addView(text("CLEAN INGREDIENTS", 11f, BRAND, bold = true).apply { letterSpacing = 0.08f })
                addView(text(swapIngredients, 13.5f, INK).apply { setPadding(0, dp(4), 0, 0) })
            })
        }

        // Primary CTA: Open in Store App
        sheet.addView(text(modalSwapCta, 14f, Color.WHITE, bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(18), dp(14), dp(18), dp(14))
            background = GradientDrawable().apply { setColor(BRAND); cornerRadius = dp(999).toFloat() }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) }
            setOnClickListener { openSwap(swap) }
        })

        // Secondary CTA: Back to Current Product Analysis
        sheet.addView(text("← Back to Product Analysis", 13.5f, INK_2, bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(14), dp(11), dp(14), dp(11))
            background = GradientDrawable().apply { setColor(0xFFF4F3EE.toInt()); cornerRadius = dp(999).toFloat() }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) }
            setOnClickListener { showCard() }
        })

        val scroll = ScrollView(this).apply { addView(sheet); isFillViewport = false }
        backdrop.addView(scroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply {
            setMargins(dp(10), dp(10), dp(10), dp(24))
        })

        val params = overlayParams(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, focusable = true)
        if (addOverlayView(backdrop, params)) {
            card = backdrop
        }
    }

    private fun buildSwapThumbnailView(swap: JSONObject, sizePx: Int): FrameLayout {
        val swapTitle = swap.optString("title", "Clean Alternative")
        val rawImage = swap.optString("image", "").ifBlank { swap.optString("imageUrl", "") }
        val fullUrl = when {
            rawImage.startsWith("https://") && !rawImage.contains("/swaps/") && !rawImage.contains("/products/") -> rawImage
            else -> ScanHistoryStore.productImageUrl(swapTitle)
        }
        val radius = dp(14).toFloat()
        val box = FrameLayout(this).apply {
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = radius
                setStroke(dp(1), 0x3316A34A)
            }
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) {
                    outline.setRoundRect(0, 0, view.width, view.height, radius)
                }
            }
        }
        val iv = ImageView(this).apply {
            setImageResource(R.drawable.broc_mascot)
            scaleType = ImageView.ScaleType.FIT_CENTER
            setPadding(dp(6), dp(6), dp(6), dp(6))
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        box.addView(iv)

        swapBitmapCache.get(fullUrl)?.let { cached ->
            iv.setPadding(dp(2), dp(2), dp(2), dp(2))
            iv.setImageBitmap(cached)
            return box
        }

        imageExecutor.execute {
            val bmp = runCatching {
                val parsed = URL(fullUrl)
                if (!parsed.protocol.equals("https", ignoreCase = true)) return@runCatching null
                val conn = (parsed.openConnection() as HttpURLConnection).apply {
                    connectTimeout = 5000
                    readTimeout = 7500
                    instanceFollowRedirects = true
                }
                try {
                    if (conn.responseCode in 200..299) {
                        val imgSource = conn.getHeaderField("X-Image-Source").orEmpty()
                        if (swap.optBoolean("isProductHeader", false) && imgSource.contains("Illustration", ignoreCase = true)) {
                            null
                        } else {
                            conn.inputStream.use { stream ->
                                val decoded = BitmapFactory.decodeStream(stream) ?: return@use null
                                Bitmap.createScaledBitmap(decoded, sizePx, sizePx, true)
                            }
                        }
                    } else null
                } finally {
                    conn.disconnect()
                }
            }.getOrNull()
            if (bmp != null) {
                swapBitmapCache.put(fullUrl, bmp)
                mainUiHandler.post {
                    iv.setPadding(0, 0, 0, 0)
                    iv.setImageBitmap(bmp)
                }
            }
        }
        return box
    }

    private fun removeCard() {
        removeOverlayView(card)
        card = null
        isAuditorOpen = false
    }

    private fun normalizeStoreUrl(raw: String): String {
        if (raw.contains("aldi.us/results?q=", ignoreCase = true)) {
            val q = raw.substringAfter("results?q=", "")
            return "https://shop.aldi.us/store/aldi/s?k=$q"
        }
        if (raw.contains("shipt.com/up/search?query=", ignoreCase = true)) {
            val q = raw.substringAfter("search?query=", "")
            return "https://www.shipt.com/shop/search?query=$q"
        }
        return raw
    }

    /**
     * Fires the Clean Swap search inside the store's native app (via in-app accessibility search bar automation
     * or verified native deep link) and saves the Clean Swap to Favorites & Scan History.
     * Does NOT mutate tripCart or animate Cart Avg until the next screen scan detects the new item in cart.
     */
    private fun openSwap(swap: JSONObject, explicitItem: TripCartItem? = null) {
        val prodTitle = explicitItem?.title?.takeIf { it.isNotBlank() }
            ?: data?.optJSONObject("product")?.optString("title").orEmpty()
        val swapTitle = swap.optString("title").ifBlank { prodTitle }

        if (!ScanApi.isSwapUnlocked(this, prodTitle, swapTitle) && !ScanApi.canUseSwap(this)) {
            Toast.makeText(
                this,
                "All 3 free weekly Clean Swaps used — upgrade to HeyBroc Pro or invite a friend for +7 free Pro days!",
                Toast.LENGTH_LONG
            ).show()
            removeCard()
            showPill()
            return
        }

        ScanApi.consumeSwap(this, swapTitle, prodTitle)
        ScanHistoryStore.saveSwapToFavorites(this, swap, prodTitle, currentStoreKey)

        val target = explicitItem ?: tripCart.firstOrNull { isSameCartItem(it.key, prodTitle) || isSameCartItem(it.title, prodTitle) }
        pendingSwapFromKey = target?.key ?: prodTitle.takeIf { it.isNotBlank() }
        pendingSwapTitle = swap.optString("title").takeIf { it.isNotBlank() }

        val searchQuery = swap.optString("searchQuery").ifBlank { swap.optString("title", "Clean Swap") }
        runCatching {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            cm?.setPrimaryClip(ClipData.newPlainText("HeyBroc Clean Swap", searchQuery))
        }

        val rawWebUrl = normalizeStoreUrl(swap.optString("webUrl"))
        val link = normalizeStoreUrl(swap.optString("deepLink").ifBlank { rawWebUrl })
        val pkg = swap.optString("androidPackage")
        val storeName = storeDisplayName(currentStoreKey)

        removeCard()
        showPill()

        Toast.makeText(
            this,
            "🔍 Searching $storeName for $swapTitle… (Saved to ♥ Favorites)",
            Toast.LENGTH_LONG
        ).show()

        val launchFallbackIntent: () -> Unit = {
            val supportsDirectUrlDeepLink = pkg in setOf(
                "com.walmart.android",
                "com.target.ui",
                "com.amazon.mShop.android.shopping"
            )
            var launchedInNativeApp = false
            if (pkg.isNotBlank()) {
                val candidates = buildList {
                    if (supportsDirectUrlDeepLink) {
                        add(Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        add(Intent(Intent.ACTION_VIEW, Uri.parse(rawWebUrl)).setPackage(pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    }
                    add(Intent(Intent.ACTION_SEARCH).setPackage(pkg).putExtra(SearchManager.QUERY, searchQuery).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    add(Intent("com.google.android.gms.actions.SEARCH_ACTION").setPackage(pkg).putExtra(SearchManager.QUERY, searchQuery).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                for (candidate in candidates) {
                    if (runCatching { startActivity(candidate) }.isSuccess) {
                        launchedInNativeApp = true
                        break
                    }
                }
            }
            if (!launchedInNativeApp && rawWebUrl.isNotBlank()) {
                runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(rawWebUrl)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            }
        }

        // Drive the active grocery store app's native search bar across all 13 stores;
        // if no search bar/tab is reachable on the current screen, fall back to launchFallbackIntent.
        val inAppSearchStarted = GroceryScreenReaderService.requestInAppSearch(
            targetPkg = pkg,
            query = searchQuery,
            onFallbackNeeded = launchFallbackIntent
        )
        if (!inAppSearchStarted) {
            launchFallbackIntent()
        }
    }

    /* ---------------- Helpers ---------------- */

    private fun removeSetupGuide() {
        removeOverlayView(setupGuideView)
        setupGuideView = null
    }

    /**
     * Floating bottom helper card shown on top of Android Settings during Step 2 (2A -> 2B -> 2C)
     * so sideloaded APK users never open App Info before tapping the greyed-out HeyBroc in Installed apps,
     * and can jump between Installed apps and App Info (⋮ 3 dots) in a single tap.
     */
    private fun showSetupGuide(step: String) {
        removeSetupGuide()
        val bannerW = (resources.displayMetrics.widthPixels * 0.92f).toInt()
        val banner = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = GradientDrawable().apply {
                setColor(0xFF15201B.toInt())
                cornerRadius = dp(18).toFloat()
                setStroke(dp(2), 0xFF16A34A.toInt())
            }
            elevation = dp(14).toFloat()
        }

        val headerRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val stepTitle = when (step) {
            "2B" -> "⚡ HEYBROC SETUP · STEP 2B OF 3"
            "2C" -> "⚡ HEYBROC SETUP · FINAL STEP (2C)"
            else -> "⚡ HEYBROC SETUP · STEP 2A OF 3"
        }
        headerRow.addView(text(stepTitle, 11f, 0xFF4ADE80.toInt(), bold = true).apply {
            letterSpacing = 0.06f
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        headerRow.addView(text("✕", 14f, 0xFF9CA3AF.toInt(), bold = true).apply {
            setPadding(dp(8), dp(2), dp(4), dp(2))
            setOnClickListener { removeSetupGuide() }
        })
        banner.addView(headerRow)

        when (step) {
            "2A" -> {
                banner.addView(text(
                    "1) Tap \"Installed apps\" → tap the greyed-out \"HeyBroc\" once (then tap OK).",
                    13f, Color.WHITE, bold = true
                ).apply { setPadding(0, dp(4), 0, dp(2)) })
                banner.addView(text(
                    "Why? Android hides the ⋮ 3-dot button in App Info until you tap the greyed-out HeyBroc first!",
                    11.5f, 0xFFFDE047.toInt()
                ).apply { setPadding(0, 0, 0, dp(8)) })
                banner.addView(text("Done? Open App Info (for ⋮ 3 Dots) →", 13f, Color.WHITE, bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(12), dp(10), dp(12), dp(10))
                    background = GradientDrawable().apply {
                        setColor(0xFF16A34A.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    setOnClickListener {
                        runCatching {
                            startActivity(
                                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            )
                        }
                        showSetupGuide("2B")
                    }
                })
            }
            "2B" -> {
                banner.addView(text(
                    "2) Look at the top-right corner ↑ Tap ⋮ (3 dots) → \"Allow restricted settings\".",
                    13f, Color.WHITE, bold = true
                ).apply { setPadding(0, dp(4), 0, dp(2)) })
                banner.addView(text(
                    "Don't see ⋮ in the top-right? You must tap the greyed-out HeyBroc in Installed apps first!",
                    11.5f, 0xFFFDE047.toInt()
                ).apply { setPadding(0, 0, 0, dp(8)) })
                banner.addView(text("Unlocked? Back to Accessibility →", 13f, Color.WHITE, bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(12), dp(10), dp(12), dp(10))
                    background = GradientDrawable().apply {
                        setColor(0xFF16A34A.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    setOnClickListener {
                        runCatching {
                            startActivity(
                                Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            )
                        }
                        showSetupGuide("2C")
                    }
                })
                banner.addView(text("← No ⋮ 3 dots showing? Tap here to go click greyed-out HeyBroc first", 11.5f, 0xFF93C5FD.toInt(), bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(0, dp(8), 0, dp(2))
                    setOnClickListener {
                        runCatching {
                            startActivity(
                                Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            )
                        }
                        showSetupGuide("2A")
                    }
                })
            }
            "2C" -> {
                banner.addView(text(
                    "3) Tap \"Installed apps\" → \"HeyBroc\" → flip the switch ON!",
                    13.5f, Color.WHITE, bold = true
                ).apply { setPadding(0, dp(4), 0, dp(4)) })
                banner.addView(text(
                    "This helper disappears automatically as soon as HeyBroc is turned ON.",
                    11.5f, 0xFF86EFAC.toInt()
                ).apply { setPadding(0, 0, 0, dp(6)) })
                banner.addView(text("Still says Restricted? Tap to open App Info (⋮ 3 Dots) ↗", 11.5f, 0xFFFDE047.toInt(), bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(0, dp(4), 0, dp(2))
                    setOnClickListener {
                        runCatching {
                            startActivity(
                                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            )
                        }
                        showSetupGuide("2B")
                    }
                })
            }
        }

        val lp = WindowManager.LayoutParams(
            bannerW,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            y = dp(64)
        }
        if (addOverlayView(banner, lp)) {
            setupGuideView = banner
        }
    }

    private fun dp(v: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun text(s: String, sp: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = s
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        setTextColor(color)
        if (bold) typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }

    private fun toneColor(c: String) = when (c) {
        "green" -> 0xFF16A34A.toInt()
        "yellow" -> 0xFFCA8A04.toInt()
        else -> 0xFFDC2626.toInt()
    }

    private fun riskColors(risk: String): Pair<Int, Int> = when (risk) {
        "high" -> 0xFFFDECEC.toInt() to 0xFFB91C1C.toInt()
        "moderate" -> 0xFFFFF0E6.toInt() to 0xFFC2410C.toInt()
        else -> 0xFFFDF6DC.toInt() to 0xFFA16207.toInt()
    }

    /** Circular 0–100 gauge. */
    private class GaugeView(ctx: Context, private val score: Int, private val rating: String, private val tone: Int) : View(ctx) {
        private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = (tone and 0x00FFFFFF) or 0x22000000 }
        private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = tone; strokeCap = Paint.Cap.ROUND }
        private val big = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = INK; textAlign = Paint.Align.CENTER; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD) }
        private val small = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = tone; textAlign = Paint.Align.CENTER; typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD) }
        private val rect = RectF()

        override fun onDraw(canvas: Canvas) {
            val s = minOf(width, height).toFloat()
            val stroke = s * 0.09f
            track.strokeWidth = stroke
            fill.strokeWidth = stroke
            rect.set(stroke, stroke, s - stroke, s - stroke)
            canvas.drawArc(rect, 0f, 360f, false, track)
            canvas.drawArc(rect, -90f, 360f * score / 100f, false, fill)
            big.textSize = s * 0.26f
            small.textSize = s * 0.12f
            canvas.drawText("$score", s / 2, s / 2 + big.textSize * 0.25f, big)
            canvas.drawText(rating, s / 2, s / 2 + big.textSize * 0.25f + small.textSize * 1.4f, small)
        }
    }

    /** Minimal wrapping row layout for warning pills. */
    private class FlowLayout(ctx: Context, private val gap: Int) : ViewGroup(ctx) {
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val maxW = MeasureSpec.getSize(widthMeasureSpec)
            var x = 0
            var y = 0
            var rowH = 0
            for (i in 0 until childCount) {
                val c = getChildAt(i)
                c.measure(MeasureSpec.makeMeasureSpec(maxW, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
                if (x > 0 && x + c.measuredWidth > maxW) { x = 0; y += rowH + gap; rowH = 0 }
                x += c.measuredWidth + gap
                rowH = maxOf(rowH, c.measuredHeight)
            }
            setMeasuredDimension(maxW, y + rowH)
        }

        override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
            val maxW = r - l
            var x = 0
            var y = 0
            var rowH = 0
            for (i in 0 until childCount) {
                val c = getChildAt(i)
                if (x > 0 && x + c.measuredWidth > maxW) { x = 0; y += rowH + gap; rowH = 0 }
                c.layout(x, y, x + c.measuredWidth, y + c.measuredHeight)
                x += c.measuredWidth + gap
                rowH = maxOf(rowH, c.measuredHeight)
            }
        }
    }
}
