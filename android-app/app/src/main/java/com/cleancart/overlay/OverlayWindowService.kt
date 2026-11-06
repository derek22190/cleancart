package com.cleancart.overlay

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Service
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
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
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
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
        const val ACTION_IDLE_CART_AVG = "com.cleancart.overlay.IDLE_CART_AVG"
        const val ACTION_HIDE = "com.cleancart.overlay.HIDE"
        const val EXTRA_JSON = "json"
        const val EXTRA_TITLE = "title"

        private const val INK = 0xFF15201B.toInt()
        private const val INK_2 = 0xFF4A5550.toInt()
        private const val INK_3 = 0xFF85908A.toInt()
        private const val BRAND = 0xFF0F7A4A.toInt()
    }

    private data class TripCartItem(
        val key: String,
        var title: String,
        var score: Int,
        var swapObj: JSONObject? = null,
    )

    private lateinit var wm: WindowManager
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
    private var hiddenForTrip = false
    private val tripCart = mutableListOf(
        TripCartItem("seed-yogurt", "Strawberry Lowfat Yogurt", 35),
        TripCartItem("seed-crackers", "Baked Cheddar Crackers", 40),
        TripCartItem("seed-butter", "Grass-Fed Salted Butter", 100),
    )
    private var displayedCartAvg = 58

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        pillY = dp(220)
        displayedCartAvg = calcCartAvg()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!Settings.canDrawOverlays(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        when (intent?.action) {
            ACTION_LOADING -> {
                if (!hiddenForTrip) {
                    isCartAvgMode = false
                    showPill(loadingText = "Scanning…")
                }
            }
            ACTION_SHOW_RESULT -> {
                if (!hiddenForTrip) {
                    isCartAvgMode = false
                    data = runCatching { JSONObject(intent.getStringExtra(EXTRA_JSON) ?: "{}") }.getOrNull()
                    recordScannedItem(data)
                    openFlag = null
                    removeCard()
                    showPill()
                }
            }
            ACTION_IDLE_CART_AVG -> {
                if (!hiddenForTrip) {
                    isCartAvgMode = true
                    removeCard()
                    showPill()
                }
            }
            ACTION_SHOW_TEST -> {
                hiddenForTrip = false
                isCartAvgMode = false
                data = JSONObject(intent.getStringExtra(EXTRA_JSON) ?: ScanApi.SAMPLE_JSON)
                recordScannedItem(data)
                openFlag = null
                removeCard()
                showPill()
            }
            ACTION_HIDE -> {
                // Reset hiddenForTrip when the user exits the store app so next trip shows the bubble again
                hiddenForTrip = false
                removeCard()
                removeHideTarget()
                removePill()
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
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

    private fun recordScannedItem(d: JSONObject?) {
        val result = d?.optJSONObject("result") ?: return
        val prod = d.optJSONObject("product") ?: return
        val title = prod.optString("title").takeIf { it.isNotBlank() } ?: return
        val score = result.optInt("score", 50)
        val swap = d.optJSONObject("swap")
        val existing = tripCart.firstOrNull { it.key == title }
        if (existing != null) {
            existing.score = score
            existing.swapObj = swap
        } else {
            tripCart.add(0, TripCartItem(title, title, score, swap))
            if (tripCart.size > 10) tripCart.removeLast()
        }
        displayedCartAvg = calcCartAvg()
    }

    private fun animateCartAvgClimb(from: Int, to: Int) {
        isCartAvgMode = true
        showPill()
        ValueAnimator.ofInt(from, to).apply {
            duration = 750L
            addUpdateListener { anim ->
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
            val tv = text("✕ Hide for this trip", 13f, Color.WHITE, bold = true).apply {
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
        if (hiddenForTrip) return
        val result = data?.optJSONObject("result")
        val ok = data?.optBoolean("ok") == true && result != null
        val avg = displayedCartAvg
        val tone = when {
            loadingText != null -> Color.GRAY
            isCartAvgMode -> toneColor(colorNameForScore(avg))
            !ok -> Color.GRAY
            else -> toneColor(result!!.optString("color"))
        }
        val label = when {
            loadingText != null -> loadingText
            isCartAvgMode -> "🛒 Cart Avg: $avg/100"
            ok -> "${result!!.optInt("score")}/100  •  Tap to Inspect"
            else -> data?.optString("error")?.take(48) ?: "HeyBroc"
        }

        val dotView = View(this).apply {
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(tone) }
            layoutParams = LinearLayout.LayoutParams(dp(9), dp(9)).apply { marginEnd = dp(8) }
        }
        val labelView = text(label, 14f, Color.WHITE, bold = true)

        val view = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(11), dp(14), dp(11))
            background = GradientDrawable().apply {
                setColor(0xEE141A17.toInt())
                cornerRadii = floatArrayOf(999f, 999f, 0f, 0f, 0f, 0f, 999f, 999f)
            }
            elevation = dp(8).toFloat()
            addView(dotView)
            addView(labelView)
        }

        removePill()
        val params = overlayParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT).apply {
            gravity = Gravity.TOP or Gravity.END
            x = 0
            y = pillY
        }

        val screenH = resources.displayMetrics.heightPixels
        val screenW = resources.displayMetrics.widthPixels
        var downRawX = 0f
        var downRawY = 0f
        var startY = 0
        var moved = false
        var overHide = false

        view.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = e.rawX
                    downRawY = e.rawY
                    startY = params.y
                    moved = false
                    overHide = false
                    showHideTarget(false)
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (downRawX - e.rawX).toInt()
                    val dy = (e.rawY - downRawY).toInt()
                    if (abs(dx) > dp(4) || abs(dy) > dp(4)) moved = true
                    params.x = dx.coerceAtLeast(0)
                    params.y = (startY + dy).coerceAtLeast(0)
                    pillY = params.y
                    overHide = e.rawY > screenH * 0.80f && e.rawX > screenW * 0.2f && e.rawX < screenW * 0.8f
                    showHideTarget(overHide)
                    runCatching { wm.updateViewLayout(v, params) }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    removeHideTarget()
                    if (overHide) {
                        hiddenForTrip = true
                        removePill()
                    } else {
                        params.x = 0
                        runCatching { wm.updateViewLayout(v, params) }
                        if (!moved) {
                            if (isCartAvgMode) showAuditorDrawer()
                            else if (ok) showCard()
                        }
                    }
                    true
                }
                else -> false
            }
        }

        wm.addView(view, params)
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

        val backdrop = FrameLayout(this).apply {
            setBackgroundColor(0x660C100E)
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
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                addView(text("HEYBROC · WHOLE-CART AUDITOR", 11f, BRAND, bold = true))
                addView(text("Cart Average: $avg/100", 20f, INK, bold = true))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            addView(text("×", 22f, INK_2).apply {
                gravity = Gravity.CENTER
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xFFF4F3EE.toInt()) }
                layoutParams = LinearLayout.LayoutParams(dp(34), dp(34))
                setOnClickListener { removeCard(); showPill() }
            })
        })

        sheet.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(12), 0, dp(8))
            addView(GaugeView(context, avg, "Cart Avg", tone), LinearLayout.LayoutParams(dp(84), dp(84)).apply { marginEnd = dp(14) })
            addView(text("Tap Swap on any dirty item below to jump to a 90–100 Clean Alternative and boost your Cart Avg.", 13f, INK_2), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        })

        for (item in tripCart) {
            sheet.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(10), dp(10), dp(10), dp(10))
                background = GradientDrawable().apply { setColor(0xFFF4F3EE.toInt()); cornerRadius = dp(12).toFloat() }
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) }
                addView(text(item.title, 13f, INK, bold = true).apply {
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                })
                addView(text("${item.score}/100", 12.5f, toneColor(colorNameForScore(item.score)), bold = true).apply {
                    setPadding(dp(8), dp(4), dp(8), dp(4))
                })
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
                    for (d in dirtyItems) d.score = 100
                    val nextAvg = calcCartAvg()
                    removeCard()
                    animateCartAvgClimb(prevAvg, nextAvg)
                }
            })
        }

        val scroll = ScrollView(this).apply { addView(sheet); isFillViewport = false }
        backdrop.addView(scroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply {
            setMargins(dp(10), dp(10), dp(10), dp(24))
        })
        wm.addView(backdrop, overlayParams(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT))
        card = backdrop
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

        val backdrop = FrameLayout(this).apply {
            setBackgroundColor(0x660C100E)
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
        sheet.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                addView(text("HEYBROC · CART AVG ${calcCartAvg()}/100", 11f, INK_3, bold = true).apply { letterSpacing = 0.08f })
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
        d.optJSONObject("product")?.optString("title")?.let {
            sheet.addView(text(it, 13f, INK_2).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.END; setPadding(0, dp(4), 0, 0) })
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

        val params = overlayParams(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
        wm.addView(backdrop, params)
        card = backdrop
    }

    private fun removeCard() {
        card?.let { runCatching { wm.removeView(it) } }
        card = null
    }

    /** Fires the affiliate deep link inside the store's native app (falls back to browser) and animates Cart Avg climbing. */
    private fun openSwap(swap: JSONObject) {
        val prevAvg = calcCartAvg()
        val prodTitle = data?.optJSONObject("product")?.optString("title").orEmpty()
        val target = tripCart.firstOrNull { it.key == prodTitle } ?: tripCart.firstOrNull { it.score < 75 }
        if (target != null) {
            target.title = swap.optString("title", target.title)
            target.score = swap.optInt("score", 100)
        }
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
