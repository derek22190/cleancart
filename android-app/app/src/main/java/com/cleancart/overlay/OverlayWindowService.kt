package com.cleancart.overlay

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Service
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.IBinder
import android.provider.Settings
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
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
        const val EXTRA_JSON = "json"
        const val EXTRA_TITLE = "title"
        const val EXTRA_IN_CART = "in_cart"
        const val EXTRA_CART_ARRAY = "cart_array"
        const val EXTRA_REPLACE_CART = "replace_cart"
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
            """^(?i)((flavor|size|style|color|colour|scent|count|pack|pack\s+size|variant|option|type|model|pattern|weight|material)\s*:\s*.+|cart\s*,?\s*\(\d+(\s+items?)?\)|in\s+\d+[km]?\+?\s*people'?s?\s*c.*|\d+[km]?\+?\s*bought.*|options(\s+from.*)?|(get\s+\$?\d+(\.\d{2})?\s+)?walmart\s+cash.*|manufacturer\s+offer.*|subscribe\s+to\s+save.*)$"""
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
            }
            ACTION_LOADING -> {
                isTestMode = false
                // Navigating to a product page always brings the pill back
                hiddenForCurrentScreen = false
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
                    if (intent.getBooleanExtra(EXTRA_IN_CART, false)) {
                        recordScannedItem(data)
                    }
                    openFlag = null
                } else if (data?.optBoolean("ok") != true) {
                    // Never show ugly "No ingredient list found for..." errors on the pill — fall back to Cart Avg mode
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
                val replaceCart = intent.getBooleanExtra(EXTRA_REPLACE_CART, false)
                syncCartFromScreen(arrRaw, replaceCart)
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

    private fun syncCartFromScreen(arrRaw: String, @Suppress("UNUSED_PARAMETER") replaceCart: Boolean) {
        val arr = runCatching { JSONArray(arrRaw) }.getOrNull() ?: return
        // Never clear tripCart on virtualized RecyclerView cart screens — merge/accumulate visible rows
        // so scrolling up and down a Walmart/BJ's/ALDI cart retains off-screen items smoothly.
        tripCart.removeAll { it.isSeed || it.title.lowercase() in DEMO_SEED_TITLES || VARIANT_NOISE_TITLE.matches(it.title.trim()) }
        for (i in 0 until arr.length()) {
            val d = runCatching { JSONObject(arr.optString(i, "{}")) }.getOrNull() ?: continue
            if (d.optBoolean("ok") != true) continue
            val result = d.optJSONObject("result") ?: continue
            val prod = d.optJSONObject("product") ?: continue
            val rawTitle = prod.optString("title").replace(Regex("^(?i)conventional grocery\\s+"), "").trim()
            if (rawTitle.isBlank() || rawTitle.lowercase() in DEMO_SEED_TITLES || VARIANT_NOISE_TITLE.matches(rawTitle)) continue
            val score = result.optInt("score", 50)
            val swap = d.optJSONObject("swap")
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
        displayedCartAvg = calcCartAvg()
        persistCart()
    }

    private fun recordScannedItem(d: JSONObject?) {
        if (d?.optBoolean("ok") != true) return
        val result = d.optJSONObject("result") ?: return
        val prod = d.optJSONObject("product") ?: return
        val rawTitle = prod.optString("title").replace(Regex("^(?i)conventional grocery\\s+"), "").trim()
        if (rawTitle.isBlank() || rawTitle.lowercase() in DEMO_SEED_TITLES || VARIANT_NOISE_TITLE.matches(rawTitle)) return
        if (Regex("(?i)(gas savings|walmart\\+|notification|scan barcodes|qr code|account|sparky)").containsMatchIn(rawTitle)) return
        val score = result.optInt("score", 50)
        val swap = d.optJSONObject("swap")
        tripCart.removeAll { it.isSeed || it.title.lowercase() in DEMO_SEED_TITLES || VARIANT_NOISE_TITLE.matches(it.title.trim()) }
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
        displayedCartAvg = calcCartAvg()
        persistCart()
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
        val avg = displayedCartAvg
        val tone = when {
            loadingText != null -> Color.GRAY
            isCartAvgMode && tripCart.isEmpty() -> BRAND
            isCartAvgMode -> toneColor(colorNameForScore(avg))
            !ok -> Color.GRAY
            else -> toneColor(result!!.optString("color"))
        }
        val label = when {
            loadingText != null -> loadingText
            isCartAvgMode && tripCart.isEmpty() -> "🛒 Cart: Open Cart to Grade"
            isCartAvgMode -> "🛒 Cart Avg: $avg/100"
            ok -> "${result!!.optInt("score")}/100  •  Tap to Inspect"
            else -> data?.optString("error")?.take(48) ?: "HeyBroc"
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

        removePill()
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
                            if (isCartAvgMode) {
                                showAuditorDrawer()
                            } else if (ok) {
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

        for (item in tripCart) {
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
            })
        }

        val dirtyItems = tripCart.filter { it.score < 75 }
        if (dirtyItems.isNotEmpty()) {
            sheet.addView(text("Swap All ${dirtyItems.size} Dirty Items → 100/100", 14f, Color.WHITE, bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(16), dp(13), dp(16), dp(13))
                background = GradientDrawable().apply { setColor(BRAND); cornerRadius = dp(999).toFloat() }
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(14) }
                setOnClickListener {
                    val prevAvg = calcCartAvg()
                    val firstSwap = dirtyItems.firstNotNullOfOrNull { it.swapObj }
                    for (d in dirtyItems) {
                        d.title = d.swapObj?.optString("title")?.takeIf { it.isNotBlank() } ?: d.title
                        d.score = d.swapObj?.optInt("score", 100) ?: 100
                    }
                    persistCart()
                    val nextAvg = calcCartAvg()
                    removeCard()
                    if (firstSwap != null) {
                        openSwap(firstSwap)
                    } else {
                        animateCartAvgClimb(prevAvg, nextAvg)
                    }
                }
            })
        }

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
        val score = result.optInt("score")
        val tone = toneColor(result.optString("color"))
        val flagged = result.optJSONArray("flagged")
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
            setPadding(dp(18), dp(18), dp(18), dp(18))
            background = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = dp(26).toFloat() }
            elevation = dp(16).toFloat()
            isClickable = true
        }

        // Header
        val cartAvgBadge = if (tripCart.isEmpty()) "HEYBROC · PRODUCT GRADE" else "HEYBROC · CART AVG ${calcCartAvg()}/100"
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
                addView(text(cartAvgBadge, 11f, INK_3, bold = true).apply { letterSpacing = 0.08f })
                addView(text("Product Analysis", 20f, INK, bold = true))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            addView(text("×", 22f, INK_2).apply {
                gravity = Gravity.CENTER
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFFF4F3EE.toInt()) }
                layoutParams = LinearLayout.LayoutParams(dp(34), dp(34))
                setOnClickListener { removeCard(); showPill() }
            })
        })
        val prodTitle = d.optJSONObject("product")?.optString("title").orEmpty()
        if (prodTitle.isNotBlank()) {
            sheet.addView(text(prodTitle, 13f, INK_2).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.END; setPadding(0, dp(4), 0, 0) })
        }

        // Gauge + flags
        val explain = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val flags = FlowLayout(this, dp(6))
        if (flagged == null || flagged.length() == 0) {
            flags.addView(text("✓ No watchlist additives found.", 13.5f, 0xFF16A34A.toInt(), bold = true))
        } else {
            for (i in 0 until flagged.length()) {
                val f = flagged.getJSONObject(i)
                val (bg, fg) = riskColors(f.optString("risk"))
                flags.addView(text("${f.optString("name")} ⚠️", 12.5f, fg, bold = true).apply {
                    setPadding(dp(10), dp(6), dp(10), dp(6))
                    background = GradientDrawable().apply { setColor(bg); cornerRadius = dp(999).toFloat() }
                    setOnClickListener {
                        openFlag = if (openFlag == f.optString("id")) null else f.optString("id")
                        explain.removeAllViews()
                        if (openFlag != null) {
                            explain.addView(LinearLayout(context).apply {
                                orientation = LinearLayout.VERTICAL
                                setPadding(dp(12), dp(12), dp(12), dp(12))
                                background = GradientDrawable().apply { setColor(bg); cornerRadius = dp(14).toFloat() }
                                addView(text("${f.optString("name")}  ·  −${f.optInt("penalty")} pts", 13f, INK, bold = true))
                                addView(text(f.optString("explanation"), 13f, INK).apply { setPadding(0, dp(4), 0, 0) })
                                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) }
                            })
                        }
                    }
                })
            }
        }
        sheet.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(14), 0, 0)
            addView(GaugeView(context, score, result.optString("rating"), tone), LinearLayout.LayoutParams(dp(108), dp(108)).apply { marginEnd = dp(16) })
            addView(flags, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        })
        sheet.addView(explain)

        // Yuka 3-Pillar Breakdown (60% Nutrition • 30% Additives • 10% Organic)
        result.optJSONObject("yukaBreakdown")?.let { yb ->
            val nutScore = yb.optInt("nutritionScore", 0)
            val nutGrade = yb.optString("nutriScoreGrade", "C")
            val addScore = yb.optInt("additiveScore", 0)
            val orgScore = yb.optInt("organicScore", 0)
            val capped = yb.optBoolean("highRiskCapped", false)
            val summaryText = buildString {
                append("Yuka Score Breakdown:  Nutrition $nutScore/60 (Nutri-Score $nutGrade)  ·  Additives $addScore/30  ·  Organic $orgScore/10")
                if (capped) append("  ·  ⚠️ Capped ≤49 (High-Risk Additive)")
            }
            sheet.addView(text(summaryText, 11.5f, INK_2, bold = true).apply {
                setPadding(dp(12), dp(8), dp(12), dp(8))
                background = GradientDrawable().apply { setColor(0xFFF4F3EE.toInt()); cornerRadius = dp(12).toFloat() }
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(10) }
            })
        }

        // Clean swap box
        val swapBox = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(12), dp(12), dp(12))
            background = GradientDrawable().apply { setColor(0xFFE6F5EC.toInt()); cornerRadius = dp(18).toFloat(); setStroke(dp(1), 0x2E16A34A) }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) }
        }
        if (swap != null) {
            swapBox.addView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                addView(text("CLEAN SWAP", 11f, BRAND, bold = true).apply { letterSpacing = 0.08f })
                addView(text(swap.optString("title"), 13.5f, INK, bold = true))
                addView(text("${swap.optInt("score")}/100 Excellent", 12f, 0xFF16A34A.toInt(), bold = true))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            swapBox.addView(text("Swap Item", 14f, Color.WHITE, bold = true).apply {
                setPadding(dp(16), dp(11), dp(16), dp(11))
                background = GradientDrawable().apply { setColor(BRAND); cornerRadius = dp(999).toFloat() }
                setOnClickListener { openSwap(swap) }
            })
        } else {
            swapBox.addView(text("Great pick — this item already scores $score/100.", 13.5f, 0xFF0B5E39.toInt()))
        }
        sheet.addView(swapBox)

        val scroll = ScrollView(this).apply { addView(sheet); isFillViewport = false }
        backdrop.addView(scroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply {
            setMargins(dp(10), dp(10), dp(10), dp(24))
        })

        val params = overlayParams(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, focusable = true)
        if (runCatching { wm.addView(backdrop, params) }.isSuccess) {
            card = backdrop
        }
    }

    private fun removeCard() {
        card?.let { runCatching { wm.removeView(it) } }
        card = null
    }

    /** Fires the affiliate deep link inside the store's native app (falls back to browser) and animates Cart Avg climbing. */
    private fun openSwap(swap: JSONObject, explicitItem: TripCartItem? = null) {
        val prevAvg = calcCartAvg()
        val prodTitle = data?.optJSONObject("product")?.optString("title").orEmpty()
        val target = explicitItem ?: tripCart.firstOrNull { isSameCartItem(it.key, prodTitle) || isSameCartItem(it.title, prodTitle) }
        if (target != null) {
            target.title = swap.optString("title", target.title)
            target.score = swap.optInt("score", 100)
        }
        persistCart()
        val nextAvg = calcCartAvg()

        val link = swap.optString("deepLink").ifBlank { swap.optString("webUrl") }
        val pkg = swap.optString("androidPackage")
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            startActivity(Intent(intent).apply { if (pkg.isNotBlank()) setPackage(pkg) })
        } catch (_: ActivityNotFoundException) {
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(swap.optString("webUrl"))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
        removeCard()
        animateCartAvgClimb(prevAvg, nextAvg)
    }

    /* ---------------- Helpers ---------------- */

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
