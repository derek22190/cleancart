package com.cleancart.overlay

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.util.concurrent.Executors

/**
 * 2-step permission onboarding:
 *   1) "Appear on top" (SYSTEM_ALERT_WINDOW)
 *   2) "Enable Store Screen Reader" (AccessibilityService)
 *   3) Launch a test overlay pill immediately.
 */
class MainActivity : Activity() {

    private lateinit var overlayStatus: TextView
    private lateinit var a11yStatus: TextView
    private val io = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(36), dp(22), dp(36))
            setBackgroundColor(0xFFF4F3EE.toInt())
        }

        // Top-left header with custom Broc mascot avatar + HeyBroc title
        col.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(ImageView(this@MainActivity).apply {
                setImageResource(R.drawable.broc_mascot)
                scaleType = ImageView.ScaleType.FIT_CENTER
                layoutParams = LinearLayout.LayoutParams(dp(46), dp(46)).apply { marginEnd = dp(12) }
            })
            addView(label("HeyBroc", 28f, 0xFF15201B.toInt(), bold = true))
        })
        col.addView(label("Ingredient-only grades and 1-tap clean swaps floating over Walmart, Instacart, Target, Kroger, ALDI, DoorDash, Uber Eats, Amazon Fresh, Sam's Club, BJ's, Costco, and Shipt.", 15f, 0xFF4A5550.toInt()).apply {
            setPadding(0, dp(8), 0, dp(20))
        })

        // Step 1 — overlay permission
        overlayStatus = label("", 13f, 0xFF85908A.toInt())
        col.addView(stepCard(
            "Step 1", "Allow \"Appear on top\"",
            "Lets HeyBroc float its score bubble over your grocery app.",
            overlayStatus,
            primaryButton("Open \"Appear on top\" settings") {
                startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            },
        ))

        // Step 2 — accessibility service
        a11yStatus = label("", 13f, 0xFF85908A.toInt())
        val samsungTip = label(
            "Samsung Galaxy / Android 13+ tip: if the switch is greyed out (\"Restricted setting\"), go to " +
                "Settings → Apps → HeyBroc → ⋮ (3 dots) → Allow restricted settings, then come back and enable it.",
            12.5f, 0xFF7A5B00.toInt(),
        ).apply {
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = GradientDrawable().apply { setColor(0xFFFDF6DC.toInt()); cornerRadius = dp(12).toFloat() }
        }
        col.addView(stepCard(
            "Step 2", "Enable Store Screen Reader",
            "Go to: Accessibility → Installed apps → HeyBroc and turn it ON.\nReads only the product title & ingredients in all 12 store apps.",
            a11yStatus,
            primaryButton("Open Accessibility settings") {
                Toast.makeText(this, "Tap: Installed apps → HeyBroc → Turn ON", Toast.LENGTH_LONG).show()
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            },
            primaryButton("Unlock Restricted Setting (1-Tap App Info)", filled = false) {
                Toast.makeText(this, "Tap ⋮ (top-right 3 dots) → Allow restricted settings", Toast.LENGTH_LONG).show()
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            },
            samsungTip,
        ))

        // Step 3 — test overlay
        col.addView(stepCard(
            "Step 3", "Preview the overlay",
            "Shows a sample floating pill right here so you can test tapping it, or drag it down to \"✕ Hide\" at the bottom of your screen.",
            null,
            primaryButton("Launch Test Overlay Pill") { launchTestPill() },
            primaryButton("Hide Overlay Pill", filled = false) {
                startService(Intent(this, OverlayWindowService::class.java).setAction(OverlayWindowService.ACTION_HIDE))
            },
        ))

        setContentView(ScrollView(this).apply { addView(col); setBackgroundColor(0xFFF4F3EE.toInt()) })
    }

    override fun onResume() {
        super.onResume()
        val overlayOk = Settings.canDrawOverlays(this)
        overlayStatus.text = if (overlayOk) "✓ Allowed" else "Not allowed yet"
        overlayStatus.setTextColor(if (overlayOk) 0xFF16A34A.toInt() else 0xFF85908A.toInt())
        val a11yOk = isAccessibilityEnabled()
        a11yStatus.text = if (a11yOk) "✓ Enabled" else "Not enabled yet"
        a11yStatus.setTextColor(if (a11yOk) 0xFF16A34A.toInt() else 0xFF85908A.toInt())
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }

    private fun launchTestPill() {
        if (!Settings.canDrawOverlays(this)) {
            Toast.makeText(this, "Complete Step 1 first", Toast.LENGTH_LONG).show()
            return
        }
        // Try the live API with sample ingredients; fall back to the built-in sample offline.
        io.execute {
            val json = runCatching {
                ScanApi.scan(
                    this, "Berry Swirl Strawberry Lowfat Yogurt",
                    "Cultured Pasteurized Grade A Lowfat Milk, Sugar, Strawberries, High Fructose Corn Syrup, Modified Corn Starch, Kosher Gelatin, Red 40, Potassium Sorbate, Vitamin A Acetate, Vitamin D3.",
                    "walmart",
                )
            }.getOrNull()?.takeIf { it.contains("\"ok\":true") } ?: ScanApi.SAMPLE_JSON
            runOnUiThread {
                startService(Intent(this, OverlayWindowService::class.java)
                    .setAction(OverlayWindowService.ACTION_SHOW_TEST)
                    .putExtra(OverlayWindowService.EXTRA_JSON, json))
            }
        }
    }

    private fun isAccessibilityEnabled(): Boolean {
        val enabled = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        val me = ComponentName(this, GroceryScreenReaderService::class.java)
        return enabled.split(':').any { ComponentName.unflattenFromString(it) == me }
    }

    /* ---------------- UI helpers ---------------- */

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun label(s: String, sp: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = s
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        setTextColor(color)
        setLineSpacing(0f, 1.15f)
        if (bold) typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }

    private fun primaryButton(text: String, filled: Boolean = true, onClick: () -> Unit) = Button(this).apply {
        this.text = text
        isAllCaps = false
        textSize = 15f
        setTextColor(if (filled) Color.WHITE else 0xFF0F7A4A.toInt())
        background = GradientDrawable().apply {
            cornerRadius = dp(999).toFloat()
            if (filled) setColor(0xFF0F7A4A.toInt()) else { setColor(Color.WHITE); setStroke(dp(1), 0xFF0F7A4A.toInt()) }
        }
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50)).apply { topMargin = dp(12) }
    }

    private fun stepCard(step: String, title: String, body: String, status: TextView?, vararg extra: android.view.View) =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(18))
            background = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = dp(20).toFloat() }
            elevation = dp(2).toFloat()
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(14) }

            addView(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                addView(label(step.uppercase(), 11f, 0xFF0F7A4A.toInt(), bold = true).apply {
                    letterSpacing = 0.08f
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                })
                status?.let { addView(it) }
            })
            addView(label(title, 18f, 0xFF15201B.toInt(), bold = true).apply { setPadding(0, dp(4), 0, 0) })
            addView(label(body, 13.5f, 0xFF4A5550.toInt()).apply { setPadding(0, dp(4), 0, 0) })
            extra.forEach { v ->
                if (v.layoutParams == null) {
                    v.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) }
                }
                addView(v)
            }
        }
}
