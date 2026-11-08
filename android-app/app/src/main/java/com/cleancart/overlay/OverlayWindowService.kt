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
        const val ACTION_SYNC_CART = "com.cleancart.overlay.SYNC_CART"
        const val ACTION_HIDE = "com.cleancart.overlay.HIDE"
        const val ACTION_RESET_HIDDEN = "com.cleancart.overlay.RESET_HIDDEN"
        const val ACTION_SHOW_SETUP_GUIDE = "com.cleancart.overlay.SHOW_SETUP_GUIDE"
        const val ACTION_HIDE_SETUP_GUIDE = "com.cleancart.overlay.HIDE_SETUP_GUIDE"
        const val EXTRA_SETUP_STEP = "setup_step"
        const val EXTRA_JSON = "json"
        const val EXTRA_TITLE = "title"
        const val EXTRA_IN_CART = "in_cart"
        const val EXTRA_CART_ARRAY = "cart_array"
        const val EXTRA_REPLACE_CART = "replace_cart"
        const val EXTRA_REMOVED_TITLES = "removed_titles"
        const val EXTRA_STORE_PKG = "store_pkg"

        private const val INK = 0xFF15201B.toInt()
        private const val INK_2 = 0xFF4A5550.toInt()
        private const val INK_3 = 0xFF85908A.toInt()
        private const val BRAND = 0xFF0F7A4A.toInt()
        private const val PREFS_NAME = "heybroc_overlay_prefs"
        private const val LEGACY_KEY_TRIP_CART = "trip_cart_json"
        private const val LEGACY_KEY_TRIP_CART_V2 = "trip_cart_v2_json"
        private const val KEY_TRIP_CART_PREFIX = "trip_cart_v3_"
        private const val KEY_PILL_Y = "pill_y"
        private val DEMO_SEED_TITLES = setOf(
            "berry swirl strawberry lowfat yogurt",
            "strawberry lowfat yogurt",
            "baked cheddar crackers",
            "grass-fed salted butter"
        )
        private val VARIANT_NOISE_TITLE = Regex(
            """^(?i)((flavor|size|style|color|colour|scent|count|pack|pack\s+size|variant|option|type|model|pattern|weight|material)\s*:\s*.+|cart\s*,?\s*\(\d+(\s+items?)?\)|in\s+\d+[km]?\+?\s*people'?s?\s*c.*|\d+[km]?\+?\s*bought.*|options(\s+from.*)?|(get\s+\$?\d+(\.\d{2})?\s+)?walmart\s+cash.*|manufacturer\s+offer.*|subscribe\s+to\s+save.*|.*barcode\s+scanner.*|.*preferred\s+address.*|change\s+(delivery\s+|pickup\s+|shipping\s+)?address.*|\d+\s+[a-z0-9.\s]+\b(st|street|rd|road|dr|drive|ave|avenue|blvd|boulevard|ln|lane|ct|court|pl|place|cir|circle|way|pkwy|parkway|hwy|highway|ter|terrace|trl|trail)\b.*|(express|today|tomorrow|asap)\s*,?\s*.*|.*\b(\d+\s*[-–—]\s*\d+\s*min|\d+\s*(hr|hour|min)s?\s+or\s+less|\d{1,2}(:\d{2})?\s*(am|pm)?\s*[-–—]\s*\d{1,2}(:\d{2})?\s*(am|pm))\b.*|.*\bfree\s+with\s+(walmart\+?|w\+).*|.*,\s*was|.*\?)$"""
        )
    }

    private data class TripCartItem(
        val key: String,
        var title: String,
        var score: Int,
        var swapObj: JSONObject? = null,
        val isSeed: Boolean = false,
        var fullJson: JSONObject? = null,
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
        if (prefs.contains(LEGACY_KEY_TRIP_CART) || prefs.contains(LEGACY_KEY_TRIP_CART_V2)) {
            prefs.edit().remove(LEGACY_KEY_TRIP_CART).remove(LEGACY_KEY_TRIP_CART_V2).apply()
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
        pill?.let { p -> pillParams?.let { lp -> lp.y = pillY; runCatching { wm.updateViewLayout(p, lp) } } }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!Settings.canDrawOverlays(this)) {
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
                if (card == null) {
                    isCartAvgMode = false
                    showPill(loadingText = "Scanning…")
                }
            }
            ACTION_SHOW_RESULT -> {
                isTestMode = false
                hiddenForCurrentScreen = false
                val incoming = runCatching { JSONObject(intent.getStringExtra(EXTRA_JSON) ?: "{}") }.getOrNull()
                if (incoming?.optBoolean("ok") == true) {
                    data = incoming
                    isCartAvgMode = false
                    runCatching { ScanHistoryStore.recordScan(this, incoming, currentStoreKey) }
                    if (intent.getBooleanExtra(EXTRA_IN_CART, false)) {
                        recordScannedItem(data)
                    }
                    openFlag = null
                } else {
                    // Never keep a stale previous product (e.g. Oreo Puffs) if a scan fails — clear data and fall back to Cart Avg mode
                    data = null
                    openFlag = null
                    isCartAvgMode = true
                }
                if (card == null) {
                    showPill()
                }
            }
            ACTION_SYNC_CART -> {
                isTestMode = false
                hiddenForCurrentScreen = false
                val prevSize = tripCart.size
                val prevAvg = displayedCartAvg
                val arrRaw = intent.getStringExtra(EXTRA_CART_ARRAY) ?: "[]"
                val remRaw = intent.getStringExtra(EXTRA_REMOVED_TITLES) ?: "[]"
                val replaceCart = intent.getBooleanExtra(EXTRA_REPLACE_CART, false)
                syncCartFromScreen(arrRaw, remRaw, replaceCart)
                isCartAvgMode = true
                if (card != null && isAuditorOpen) {
                    if (tripCart.size != prevSize || displayedCartAvg != prevAvg) {
                        showAuditorDrawer()
                    }
                } else if (card == null) {
                    showPill()
                }
            }
            ACTION_IDLE_CART_AVG -> {
                isTestMode = false
                if (!hiddenForCurrentScreen && card == null) {
                    isCartAvgMode = true
                    showPill()
                }
            }
            ACTION_SHOW_TEST -> {
                hiddenForCurrentScreen = false
                isCartAvgMode = false
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

    private fun normalizeCartKey(raw: String): String =
        raw.lowercase()
            .replace(Regex("^(conventional grocery|organic|natural)\\s+"), "")
            .replace(Regex("[,•|\\-–—.…]+"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()

    private fun isSameCartItem(a: String, b: String): Boolean {
        if (a.equals(b, ignoreCase = true)) return true
        val na = normalizeCartKey(a)
        val nb = normalizeCartKey(b)
        if (na == nb) return true
        if (na.length >= 16 && nb.length >= 16 && (na.startsWith(nb) || nb.startsWith(na))) return true
        return false
    }

    private fun matchesPendingSwap(rawTitle: String): Boolean {
        val pending = pendingSwapTitle ?: return false
        if (isSameCartItem(rawTitle, pending)) return true
        val words = normalizeCartKey(pending).split(" ").filter { it.length >= 3 }
        val lower = normalizeCartKey(rawTitle)
        return words.size >= 2 && words.take(2).all { lower.contains(it) }
    }

    private fun syncCartFromScreen(arrRaw: String, remRaw: String, @Suppress("UNUSED_PARAMETER") replaceCart: Boolean) {
        val arr = runCatching { JSONArray(arrRaw) }.getOrNull() ?: return
        val remArr = runCatching { JSONArray(remRaw) }.getOrNull()
        val prevAvg = calcCartAvg()
        var swapDetectedInCart = false
        // Never clear tripCart on virtualized RecyclerView cart screens — merge/accumulate visible rows
        // so scrolling up and down a Walmart/BJ's/ALDI cart retains off-screen items smoothly.
        tripCart.removeAll { it.isSeed || it.title.lowercase() in DEMO_SEED_TITLES || VARIANT_NOISE_TITLE.matches(it.title.trim()) }
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
            val rawTitle = prod.optString("title").replace(Regex("^(?i)conventional grocery\\s+"), "").trim()
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
                if (rawTitle.length > existing.title.length && !rawTitle.endsWith("...")) {
                    existing.title = rawTitle
                }
            } else {
                tripCart.add(TripCartItem(rawTitle, rawTitle, score, swap, isSeed = false, fullJson = d))
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
        val rawTitle = prod.optString("title").replace(Regex("^(?i)conventional grocery\\s+"), "").trim()
        if (rawTitle.isBlank() || rawTitle.lowercase() in DEMO_SEED_TITLES || VARIANT_NOISE_TITLE.matches(rawTitle)) return
        if (Regex("(?i)(gas savings|walmart\\+|notification|scan barcodes|qr code|account|sparky)").containsMatchIn(rawTitle)) return
        val prevAvg = calcCartAvg()
        var swapDetectedInCart = false
        val score = result.optInt("score", 50)
        val swap = d.optJSONObject("swap")
        tripCart.removeAll { it.isSeed || it.title.lowercase() in DEMO_SEED_TITLES || VARIANT_NOISE_TITLE.matches(it.title.trim()) }
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
        } else {
            tripCart.add(0, TripCartItem(rawTitle, rawTitle, score, swap, isSeed = false, fullJson = d))
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
        for (item in tripCart.filter { !it.isSeed && it.title.lowercase() !in DEMO_SEED_TITLES && !VARIANT_NOISE_TITLE.matches(it.title.trim()) }) {
            arr.put(JSONObject().apply {
                put("key", item.key)
                put("title", item.title)
                put("score", item.score)
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
                val title = o.optString("title")
                if (title.isBlank() || title.lowercase() in DEMO_SEED_TITLES || VARIANT_NOISE_TITLE.matches(title.trim())) continue
                tripCart.add(
                    TripCartItem(
                        key = o.optString("key"),
                        title = title,
                        score = o.optInt("score", 50),
                        swapObj = o.optJSONObject("swap"),
                        isSeed = false,
                        fullJson = o.optJSONObject("fullJson"),
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

    /* ---------------- Window params ---------------- */

    private fun overlayParams(w: Int, h: Int, focusable: Boolean = false) = WindowManager.LayoutParams(
        w, h,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        (if (focusable) 0 else WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE) or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    )

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
            runCatching { wm.addView(tv, p) }
            hideTarget = tv
        } else {
            (hideTarget?.background as? GradientDrawable)?.setColor(if (hot) 0xFFDC2626.toInt() else 0xDD141A17.toInt())
        }
    }

    private fun removeHideTarget() {
        hideTarget?.let { runCatching { wm.removeView(it) } }
        hideTarget = null
    }

    /* ---------------- Dual-Mode Pill ---------------- */

    @SuppressLint("ClickableViewAccessibility")
    private fun showPill(loadingText: String? = null) {
        if (hiddenForCurrentScreen || !Settings.canDrawOverlays(this)) return
        if (!isCartAvgMode) climbAnimator?.cancel()
        val result = data?.optJSONObject("result")
        val ok = data?.optBoolean("ok") == true && result != null
        val ybPill = result?.optJSONObject("yukaBreakdown")
        val pillFlagCount = result?.optJSONArray("flagged")?.length() ?: 0
        val effectiveScore = if (ok && ybPill != null && pillFlagCount == 0) {
            (ybPill.optInt("nutritionScore", 42) + ybPill.optInt("additiveScore", 30) + ybPill.optInt("organicScore", 0)).coerceIn(0, 100)
        } else {
            result?.optInt("score") ?: 50
        }
        val avg = displayedCartAvg
        val tone = when {
            loadingText != null -> Color.GRAY
            isCartAvgMode && tripCart.isEmpty() -> BRAND
            isCartAvgMode -> toneColor(colorNameForScore(avg))
            !ok -> Color.GRAY
            else -> toneColor(colorNameForScore(effectiveScore))
        }
        val label = when {
            loadingText != null -> loadingText
            isCartAvgMode && tripCart.isEmpty() -> "🛒 Cart: Open Cart to Grade"
            isCartAvgMode -> "🛒 Cart Avg: $avg/100"
            ok -> "$effectiveScore/100  •  Tap to Inspect"
            else -> data?.optString("error")?.take(48) ?: "HeyBroc"
        }

        // CRITICAL: If the pill window is already attached, update text and dot color IN-PLACE
        // instead of calling wm.removeView() + wm.addView(). Removing and re-adding a hardware overlay
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
                        runCatching { wm.updateViewLayout(v, params) }
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
                        runCatching { wm.updateViewLayout(v, params) }
                        if (!moved) {
                            val currentlyOk = data?.optBoolean("ok") == true && data?.optJSONObject("result") != null
                            if (isCartAvgMode) {
                                showAuditorDrawer()
                            } else if (currentlyOk) {
                                showCard()
                            } else {
                                // If scan hadn't finished or had an error, open sample/auditor drawer so tap always responds
                                showAuditorDrawer()
                            }
                        }
                    }
                    true
                }
                else -> false
            }
        }

        if (runCatching { wm.addView(view, params) }.isFailure) return
        pill = view
        pillDotView = dotView
        pillTextView = labelView
        pillParams = params
    }

    private fun removePill() {
        pill?.let { runCatching { wm.removeView(it) } }
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
                    addView(text("Swap", 12f, Color.WHITE, bold = true).apply {
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

        val dirtyItems = tripCart.filter { it.score < 75 }
        val firstDirtyWithSwap = dirtyItems.firstOrNull { it.swapObj != null }
        if (firstDirtyWithSwap?.swapObj != null) {
            val firstSwap = firstDirtyWithSwap.swapObj!!
            val swapTitle = firstSwap.optString("title", "Clean Alternative")
            val swapScore = firstSwap.optInt("score", 90)
            sheet.addView(text("Find Clean Swap: $swapTitle ($swapScore/100)", 14f, Color.WHITE, bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(16), dp(13), dp(16), dp(13))
                background = GradientDrawable().apply { setColor(BRAND); cornerRadius = dp(999).toFloat() }
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(14) }
                setOnClickListener {
                    openSwap(firstSwap, firstDirtyWithSwap)
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
                val msg = "Check out HeyBroc — this little broccoli floats over Walmart, Target & Instacart to grade ingredients (0–100) and swap dirty items in 1 tap. Use my invite link so we both get +7 Free Days of HeyBroc Pro: $url"
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
        if (runCatching { wm.addView(backdrop, overlayParams(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, focusable = true)) }.isSuccess) {
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
        val ybInit = result.optJSONObject("yukaBreakdown")
        val rawScore = result.optInt("score")
        val score = if (ybInit != null && (flagged?.length() ?: 0) == 0) {
            (ybInit.optInt("nutritionScore", 42) + ybInit.optInt("additiveScore", 30) + ybInit.optInt("organicScore", 0)).coerceIn(0, 100)
        } else {
            rawScore
        }
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
        val prodTitle = d.optJSONObject("product")?.optString("title").orEmpty()
        sheet.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(android.widget.ImageView(context).apply {
                setImageResource(R.drawable.broc_mascot)
                scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
                layoutParams = LinearLayout.LayoutParams(dp(30), dp(30)).apply { marginEnd = dp(8) }
            })
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                addView(text(cartAvgBadge, 10f, INK_3, bold = true).apply { letterSpacing = 0.07f })
                addView(text("Product Analysis", 17f, INK, bold = true))
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
            sheet.addView(text(prodTitle, 12f, INK_2).apply {
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                setPadding(0, dp(3), 0, 0)
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

        // Pinned Clean Swap box at the bottom of the card — ALWAYS visible without scrolling!
        val swapBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(11), dp(10), dp(11), dp(10))
            background = GradientDrawable().apply { setColor(0xFFE6F5EC.toInt()); cornerRadius = dp(16).toFloat(); setStroke(dp(1), 0x2E16A34A) }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) }
        }
        if (swap != null) {
            val swapTitle = swap.optString("title", "Clean Alternative")
            val swapScore = swap.optInt("score", 100)
            val swapIngredients = swap.optString("ingredients").ifBlank { cleanIngredientsPreviewFor(swapTitle) }

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
                addView(text("$swapScore/100 Excellent", 11f, 0xFF16A34A.toInt(), bold = true))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })

            // Action button — opens directly in the store app
            topRow.addView(text("Swap ↗", 12.5f, Color.WHITE, bold = true).apply {
                setPadding(dp(13), dp(9), dp(13), dp(9))
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
        } else {
            swapBox.addView(text("✓ Great pick — this item already scores $score/100.", 12.5f, 0xFF0B5E39.toInt(), bold = true))
        }
        sheet.addView(swapBox)

        val outerScroll = ScrollView(this).apply {
            addView(sheet)
            isFillViewport = false
            isVerticalScrollBarEnabled = false
        }
        backdrop.addView(outerScroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply {
            setMargins(dp(10), dp(10), dp(10), dp(20))
        })

        val params = overlayParams(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, focusable = true)
        if (runCatching { wm.addView(backdrop, params) }.isSuccess) {
            card = backdrop
        }
    }

    /**
     * Full Clean Swap Preview modal: lets the user inspect the swap product's photo, 100/100 score,
     * and complete ingredient list BEFORE jumping into the store app.
     */
    private fun showSwapPreviewModal(swap: JSONObject) {
        removeCard()
        removePill()
        val swapTitle = swap.optString("title", "Clean Alternative")
        val swapScore = swap.optInt("score", 100)
        val swapSize = swap.optString("size")
        val swapIngredients = swap.optString("ingredients").ifBlank { cleanIngredientsPreviewFor(swapTitle) }
        val storeName = storeDisplayName(currentStoreKey)

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
            addView(GaugeView(context, swapScore, "Excellent", 0xFF16A34A.toInt()), LinearLayout.LayoutParams(dp(92), dp(92)).apply { marginEnd = dp(14) })
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                addView(text("✓ 0 Watchlist Additives", 14f, 0xFF16A34A.toInt(), bold = true))
                addView(text("Verified clean 1-for-1 replacement with real whole-food ingredients.", 12.5f, INK_2).apply {
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
        sheet.addView(text("Find & Swap in $storeName ↗", 15f, Color.WHITE, bold = true).apply {
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
        if (runCatching { wm.addView(backdrop, params) }.isSuccess) {
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
                    connectTimeout = 4000
                    readTimeout = 5000
                    instanceFollowRedirects = true
                }
                try {
                    if (conn.responseCode in 200..299) {
                        conn.inputStream.use { stream ->
                            val decoded = BitmapFactory.decodeStream(stream) ?: return@use null
                            Bitmap.createScaledBitmap(decoded, sizePx, sizePx, true)
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

    private fun cleanIngredientsPreviewFor(title: String): String {
        val s = title.lowercase()
        return when {
            "eggnog" in s -> "Organic Grade A milk, organic cream, organic cane sugar, organic egg yolks, organic vanilla extract, organic nutmeg."
            "unsalted butter" in s -> "Organic pasteurized sweet cream, microbial culture."
            "butter" in s -> "Organic pasteurized sweet cream, salt."
            "yogurt" in s -> "Cultured pasteurized organic whole milk, pectin, vitamin D3."
            "turkey" in s -> "Organic turkey breast, water, sea salt, organic vinegar, organic cane sugar."
            "bacon" in s -> "Organic pork, water, sea salt, organic cane sugar, organic rosemary extract."
            "tortilla" in s && "chips" in s -> "Cassava flour, avocado oil, coconut flour, ground chia seed, sea salt."
            "chips" in s -> "Potatoes, avocado oil, sea salt."
            "cheddar" in s && "crackers" in s -> "Organic cassava flour, organic cheddar cheese, organic coconut oil, organic chia seeds, sea salt."
            "crackers" in s -> "Organic whole grain brown rice, organic quinoa, organic flax seeds, organic sesame seeds, sea salt."
            "ranch" in s -> "Avocado oil, water, organic eggs, organic distilled vinegar, sea salt, organic herbs & spices."
            "milk" in s -> "Organic Grade A milk, vitamin D3."
            else -> "100% clean whole-food ingredients — zero watchlist additives."
        }
    }

    private fun removeCard() {
        card?.let { runCatching { wm.removeView(it) } }
        card = null
        isAuditorOpen = false
    }

    private fun normalizeStoreUrl(raw: String): String {
        if (raw.contains("aldi.us/results?q=", ignoreCase = true)) {
            val q = raw.substringAfter("results?q=", "")
            return "https://shop.aldi.us/store/aldi/s?k=$q"
        }
        return raw
    }

    /**
     * Fires the affiliate deep link inside the store's native app (or performs in-app search / opens live store search).
     * Does NOT mutate tripCart or animate Cart Avg until the next screen scan detects the new item in cart.
     */
    private fun openSwap(swap: JSONObject, explicitItem: TripCartItem? = null) {
        val prodTitle = data?.optJSONObject("product")?.optString("title").orEmpty()
        val swapTitle = swap.optString("title").ifBlank { prodTitle }

        if (!ScanApi.canUseSwap(this)) {
            Toast.makeText(
                this,
                "All 5 free weekly swaps used — upgrade to HeyBroc Pro for unlimited 1-tap swaps!",
                Toast.LENGTH_LONG
            ).show()
            runCatching {
                startActivity(
                    Intent(Intent.ACTION_VIEW, Uri.parse(ScanApi.upgradeUrl(this)))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            }
            removeCard()
            showPill()
            return
        }

        ScanApi.consumeSwap(this, swapTitle)

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

        var launchedInNativeApp = false
        if (pkg.isNotBlank()) {
            val candidates = listOf(
                Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                Intent(Intent.ACTION_VIEW, Uri.parse(rawWebUrl)).setPackage(pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                Intent(Intent.ACTION_SEARCH).setPackage(pkg).putExtra(SearchManager.QUERY, searchQuery).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                Intent("com.google.android.gms.actions.SEARCH_ACTION").setPackage(pkg).putExtra(SearchManager.QUERY, searchQuery).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            for (candidate in candidates) {
                if (runCatching { startActivity(candidate) }.isSuccess) {
                    launchedInNativeApp = true
                    break
                }
            }
        }

        if (!launchedInNativeApp) {
            // If the user is currently inside a store app (like ALDI) that doesn't register an external ACTION_VIEW search filter,
            // search directly inside the active store app window via Accessibility so we don't kick them out to a browser.
            val searchedInOpenApp = GroceryScreenReaderService.performInAppSearch(searchQuery, pkg)
            if (searchedInOpenApp) {
                runCatching {
                    Toast.makeText(
                        this,
                        "🔎 Searching $storeName for \"$searchQuery\" (copied to clipboard)",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            } else if (rawWebUrl.isNotBlank()) {
                runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(rawWebUrl)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            }
        }
    }

    /* ---------------- Helpers ---------------- */

    private fun removeSetupGuide() {
        setupGuideView?.let { runCatching { wm.removeView(it) } }
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
        setupGuideView = banner
        runCatching { wm.addView(banner, lp) }
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
