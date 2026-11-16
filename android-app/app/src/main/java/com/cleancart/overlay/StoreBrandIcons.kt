package com.cleancart.overlay

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.cos
import kotlin.math.sin

/**
 * Crisp, zero-network, DPI-independent vector brand symbols for every supported grocery retailer,
 * rendered right next to each store's name inside Home launcher buttons and Live Shop store chips.
 */
object StoreBrandIcons {

    fun createDrawable(context: Context, storeKey: String, sizeDp: Int = 22): Drawable {
        val px = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            sizeDp.toFloat(),
            context.resources.displayMetrics
        ).toInt().coerceAtLeast(16)
        return StoreEmblemDrawable(LiveStoreBrowserActivity.normalizeStoreKey(storeKey), px)
    }

    fun createIconView(context: Context, storeKey: String, sizeDp: Int = 22): ImageView {
        val px = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            sizeDp.toFloat(),
            context.resources.displayMetrics
        ).toInt().coerceAtLeast(16)
        return ImageView(context).apply {
            setImageDrawable(StoreEmblemDrawable(LiveStoreBrowserActivity.normalizeStoreKey(storeKey), px))
            scaleType = ImageView.ScaleType.FIT_CENTER
            layoutParams = LinearLayout.LayoutParams(px, px)
            importantForAccessibility = ImageView.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
    }

    data class StoreChipHandle(
        val container: LinearLayout,
        val labelView: TextView
    )

    fun buildStoreChip(
        context: Context,
        storeKey: String,
        labelText: String,
        selected: Boolean,
        iconSizeDp: Int = 21,
        textSizeSp: Float = 13f,
        padHdp: Int = 12,
        padVdp: Int = 8,
        selectedBgColor: Int = 0xFF0F7A4A.toInt(),
        unselectedBgColor: Int = Color.WHITE,
        unselectedStrokeColor: Int = 0xFF86EFAC.toInt(),
        unselectedTextColor: Int = 0xFF14532D.toInt()
    ): StoreChipHandle {
        fun dp(v: Int): Int = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            v.toFloat(),
            context.resources.displayMetrics
        ).toInt()

        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(padHdp), dp(padVdp), dp(padHdp + 2), dp(padVdp))
            background = GradientDrawable().apply {
                setColor(if (selected) selectedBgColor else unselectedBgColor)
                setStroke(dp(1), if (selected) selectedBgColor else unselectedStrokeColor)
                cornerRadius = dp(999).toFloat()
            }
        }

        val icon = createIconView(context, storeKey, iconSizeDp).apply {
            (layoutParams as LinearLayout.LayoutParams).marginEnd = dp(7)
        }
        row.addView(icon)

        val tv = TextView(context).apply {
            text = labelText
            setTextSize(TypedValue.COMPLEX_UNIT_SP, textSizeSp)
            setTextColor(if (selected) Color.WHITE else unselectedTextColor)
            setTypeface(typeface, Typeface.BOLD)
            setSingleLine(true)
            ellipsize = TextUtils.TruncateAt.END
        }
        row.addView(tv, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        return StoreChipHandle(row, tv)
    }

    private class StoreEmblemDrawable(
        private val key: String,
        private val sizePx: Int
    ) : Drawable() {

        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            isSubpixelText = true
        }
        private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            textAlign = Paint.Align.CENTER
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
        }
        private val rect = RectF()
        private val path = Path()

        override fun getIntrinsicWidth(): Int = sizePx
        override fun getIntrinsicHeight(): Int = sizePx

        override fun draw(canvas: Canvas) {
            val b = bounds
            val w = (if (b.width() > 0) b.width() else sizePx).toFloat()
            val h = (if (b.height() > 0) b.height() else sizePx).toFloat()
            val cx = b.left + w * 0.5f
            val cy = b.top + h * 0.5f
            val r = minOf(w, h) * 0.48f

            when (key) {
                "walmart" -> {
                    // Walmart Blue circle + iconic 6-ray golden Spark
                    paint.style = Paint.Style.FILL
                    paint.color = 0xFF0071DC.toInt()
                    canvas.drawCircle(cx, cy, r, paint)

                    strokePaint.color = 0xFFFFC220.toInt()
                    strokePaint.strokeWidth = r * 0.22f
                    val inner = r * 0.30f
                    val outer = r * 0.72f
                    for (i in 0 until 6) {
                        val rad = Math.toRadians((i * 60 - 90).toDouble())
                        val c = cos(rad).toFloat()
                        val s = sin(rad).toFloat()
                        canvas.drawLine(
                            cx + c * inner,
                            cy + s * inner,
                            cx + c * outer,
                            cy + s * outer,
                            strokePaint
                        )
                    }
                }

                "target" -> {
                    // Crisp white disc + Target Red concentric bullseye
                    paint.style = Paint.Style.FILL
                    paint.color = Color.WHITE
                    canvas.drawCircle(cx, cy, r, paint)

                    paint.color = 0xFFCC0000.toInt()
                    canvas.drawCircle(cx, cy, r * 0.92f, paint)

                    paint.color = Color.WHITE
                    canvas.drawCircle(cx, cy, r * 0.60f, paint)

                    paint.color = 0xFFCC0000.toInt()
                    canvas.drawCircle(cx, cy, r * 0.30f, paint)
                }

                "instacart" -> {
                    // Deep Instacart green circle + bright orange angled carrot + green leaves
                    paint.style = Paint.Style.FILL
                    paint.color = 0xFF003D29.toInt()
                    canvas.drawCircle(cx, cy, r, paint)

                    canvas.save()
                    canvas.rotate(35f, cx, cy)
                    // Carrot body
                    paint.color = 0xFFFF7009.toInt()
                    path.reset()
                    path.moveTo(cx - r * 0.24f, cy - r * 0.20f)
                    path.quadTo(cx, cy - r * 0.30f, cx + r * 0.24f, cy - r * 0.20f)
                    path.lineTo(cx + r * 0.05f, cy + r * 0.58f)
                    path.quadTo(cx, cy + r * 0.66f, cx - r * 0.05f, cy + r * 0.58f)
                    path.close()
                    canvas.drawPath(path, paint)

                    // Leaf crown
                    strokePaint.color = 0xFF22C55E.toInt()
                    strokePaint.strokeWidth = r * 0.16f
                    canvas.drawLine(cx, cy - r * 0.24f, cx, cy - r * 0.56f, strokePaint)
                    canvas.drawLine(cx, cy - r * 0.24f, cx - r * 0.24f, cy - r * 0.48f, strokePaint)
                    canvas.drawLine(cx, cy - r * 0.24f, cx + r * 0.24f, cy - r * 0.48f, strokePaint)
                    canvas.restore()
                }

                "amazon" -> {
                    // Dark slate disc + crisp white "a" + Amazon Fresh lime/orange smile arc
                    paint.style = Paint.Style.FILL
                    paint.color = 0xFF131921.toInt()
                    canvas.drawCircle(cx, cy, r, paint)

                    textPaint.color = Color.WHITE
                    textPaint.textSize = r * 1.12f
                    canvas.drawText("a", cx, cy + r * 0.16f, textPaint)

                    strokePaint.color = 0xFF78BE20.toInt()
                    strokePaint.strokeWidth = r * 0.16f
                    rect.set(cx - r * 0.54f, cy + r * 0.02f, cx + r * 0.54f, cy + r * 0.58f)
                    canvas.drawArc(rect, 22f, 136f, false, strokePaint)
                }

                "wholefoods" -> {
                    // Whole Foods forest green circle + crisp white WF + top leaf accent
                    paint.style = Paint.Style.FILL
                    paint.color = 0xFF00674B.toInt()
                    canvas.drawCircle(cx, cy, r, paint)

                    textPaint.color = Color.WHITE
                    textPaint.textSize = r * 0.80f
                    canvas.drawText("WF", cx, cy + r * 0.30f, textPaint)

                    paint.color = 0xFF86EFAC.toInt()
                    canvas.drawCircle(cx + r * 0.06f, cy - r * 0.54f, r * 0.12f, paint)
                }

                "costco" -> {
                    // White disc with Costco Red ring + bold Red "C" + Blue speed stripes
                    paint.style = Paint.Style.FILL
                    paint.color = Color.WHITE
                    canvas.drawCircle(cx, cy, r, paint)

                    strokePaint.color = 0xFFE31837.toInt()
                    strokePaint.strokeWidth = r * 0.12f
                    canvas.drawCircle(cx, cy, r * 0.90f, strokePaint)

                    textPaint.color = 0xFFE31837.toInt()
                    textPaint.textSize = r * 1.12f
                    canvas.drawText("C", cx - r * 0.08f, cy + r * 0.38f, textPaint)

                    strokePaint.color = 0xFF005DAA.toInt()
                    strokePaint.strokeWidth = r * 0.10f
                    canvas.drawLine(cx + r * 0.12f, cy - r * 0.12f, cx + r * 0.52f, cy - r * 0.12f, strokePaint)
                    canvas.drawLine(cx + r * 0.18f, cy + r * 0.06f, cx + r * 0.56f, cy + r * 0.06f, strokePaint)
                }

                "sams" -> {
                    // Royal blue circle + iconic Sam's Club interlocking diamond
                    paint.style = Paint.Style.FILL
                    paint.color = 0xFF004B8D.toInt()
                    canvas.drawCircle(cx, cy, r, paint)

                    // Outer white diamond
                    paint.color = Color.WHITE
                    path.reset()
                    path.moveTo(cx, cy - r * 0.64f)
                    path.lineTo(cx + r * 0.64f, cy)
                    path.lineTo(cx, cy + r * 0.64f)
                    path.lineTo(cx - r * 0.64f, cy)
                    path.close()
                    canvas.drawPath(path, paint)

                    // Inner sky-cyan diamond
                    paint.color = 0xFF00A9E0.toInt()
                    path.reset()
                    path.moveTo(cx, cy - r * 0.36f)
                    path.lineTo(cx + r * 0.36f, cy)
                    path.lineTo(cx, cy + r * 0.36f)
                    path.lineTo(cx - r * 0.36f, cy)
                    path.close()
                    canvas.drawPath(path, paint)
                }

                "kroger" -> {
                    // Kroger royal blue circle + crisp white "K"
                    paint.style = Paint.Style.FILL
                    paint.color = 0xFF0E4C92.toInt()
                    canvas.drawCircle(cx, cy, r, paint)

                    textPaint.color = Color.WHITE
                    textPaint.textSize = r * 1.12f
                    canvas.drawText("K", cx, cy + r * 0.39f, textPaint)
                }

                "aldi" -> {
                    // ALDI navy badge + orange/gold ring + light-blue "A"
                    paint.style = Paint.Style.FILL
                    paint.color = 0xFF001E73.toInt()
                    canvas.drawCircle(cx, cy, r, paint)

                    strokePaint.color = 0xFFFF6B00.toInt()
                    strokePaint.strokeWidth = r * 0.16f
                    canvas.drawCircle(cx, cy, r * 0.86f, strokePaint)

                    textPaint.color = 0xFF38BDF8.toInt()
                    textPaint.textSize = r * 1.05f
                    canvas.drawText("A", cx, cy + r * 0.36f, textPaint)
                }

                "bjs" -> {
                    // BJ's Wholesale bold crimson circle + crisp white "BJ"
                    paint.style = Paint.Style.FILL
                    paint.color = 0xFFD31145.toInt()
                    canvas.drawCircle(cx, cy, r, paint)

                    textPaint.color = Color.WHITE
                    textPaint.textSize = r * 0.84f
                    canvas.drawText("BJ", cx, cy + r * 0.31f, textPaint)
                }

                "shipt" -> {
                    // Shipt emerald green circle + crisp white "S"
                    paint.style = Paint.Style.FILL
                    paint.color = 0xFF008248.toInt()
                    canvas.drawCircle(cx, cy, r, paint)

                    textPaint.color = Color.WHITE
                    textPaint.textSize = r * 1.08f
                    canvas.drawText("S", cx, cy + r * 0.38f, textPaint)
                }

                "doordash" -> {
                    // DoorDash red circle + crisp white "D" wing
                    paint.style = Paint.Style.FILL
                    paint.color = 0xFFFF3008.toInt()
                    canvas.drawCircle(cx, cy, r, paint)

                    textPaint.color = Color.WHITE
                    textPaint.textSize = r * 1.08f
                    canvas.drawText("D", cx, cy + r * 0.38f, textPaint)
                }

                "ubereats" -> {
                    // Uber Eats black circle + bright green "UE"
                    paint.style = Paint.Style.FILL
                    paint.color = 0xFF142328.toInt()
                    canvas.drawCircle(cx, cy, r, paint)

                    textPaint.color = 0xFF06C167.toInt()
                    textPaint.textSize = r * 0.80f
                    canvas.drawText("UE", cx, cy + r * 0.29f, textPaint)
                }

                else -> {
                    paint.style = Paint.Style.FILL
                    paint.color = 0xFF0F7A4A.toInt()
                    canvas.drawCircle(cx, cy, r, paint)

                    textPaint.color = Color.WHITE
                    textPaint.textSize = r * 1.0f
                    val initial = key.firstOrNull()?.uppercaseChar()?.toString() ?: "S"
                    canvas.drawText(initial, cx, cy + r * 0.36f, textPaint)
                }
            }
        }

        override fun setAlpha(alpha: Int) {
            paint.alpha = alpha
            strokePaint.alpha = alpha
            textPaint.alpha = alpha
        }

        override fun setColorFilter(colorFilter: ColorFilter?) {
            paint.colorFilter = colorFilter
            strokePaint.colorFilter = colorFilter
            textPaint.colorFilter = colorFilter
        }

        @Deprecated("Deprecated in Java")
        override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
    }
}
