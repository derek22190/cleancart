package com.cleancart.overlay

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.util.concurrent.Executors

/**
 * Guided 1-button permission onboarding:
 *   - Combines disclosure + "Appear on top" + "Accessibility" into a single guided flow.
 *   - Automatically advances from "Appear on top" straight to Accessibility as soon as toggled.
 *   - Collapses setup clutter into a clean "Active & Ready" card once enabled.
 */
class MainActivity : Activity() {

    private lateinit var heroCardContainer: LinearLayout
    private val io = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var pendingAutoChainToA11y = false
    private var watcherAttempts = 0
    private var hasTappedGreyedOutA11yOnce = false

    private val permissionWatcher = object : Runnable {
        override fun run() {
            if (isDestroyed || isFinishing) return
            val overlayOk = Settings.canDrawOverlays(this@MainActivity)
            val a11yOk = isAccessibilityEnabled() && AccessibilityConsent.granted(this@MainActivity)

            if (pendingAutoChainToA11y && overlayOk && !isAccessibilityEnabled()) {
                pendingAutoChainToA11y = false
                hasTappedGreyedOutA11yOnce = true
                if (!isInstalledFromPlayStore()) {
                    showFloatingSetupHelper("2A")
                }
                Toast.makeText(
                    this@MainActivity,
                    "✓ Step 1 done! Tap Installed apps → greyed-out HeyBroc once, then tap the green button at the bottom!",
                    Toast.LENGTH_LONG
                ).show()
                runCatching {
                    startActivity(
                        Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                }
            }

            if (overlayOk && a11yOk) {
                pendingAutoChainToA11y = false
                hideFloatingSetupHelper()
                refreshHeroCard()
                return
            }

            if (watcherAttempts++ < 180) {
                mainHandler.postDelayed(this, 500)
            }
        }
    }

    private fun showFloatingSetupHelper(step: String) {
        if (!Settings.canDrawOverlays(this)) return
        runCatching {
            startService(
                Intent(this, OverlayWindowService::class.java)
                    .setAction(OverlayWindowService.ACTION_SHOW_SETUP_GUIDE)
                    .putExtra(OverlayWindowService.EXTRA_SETUP_STEP, step)
            )
        }
    }

    private fun hideFloatingSetupHelper() {
        if (!Settings.canDrawOverlays(this)) return
        runCatching {
            startService(
                Intent(this, OverlayWindowService::class.java)
                    .setAction(OverlayWindowService.ACTION_HIDE_SETUP_GUIDE)
            )
        }
    }

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

        // Dynamic Guided Setup / Active Ready card
        heroCardContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        col.addView(heroCardContainer)

        // Family Watchlist (2x penalty multiplier)
        col.addView(stepCard(
            "Family Watchlist", "2x Penalty Multiplier",
            "Double the deduction for additive categories your household avoids most.",
            null,
            watchlistControls(),
        ))

        // Unlimited Friend Referral Card (+7 Free Pro Days Per Friend)
        val myRefCode = ScanApi.myReferralCode(this)
        val claimedRefStatus = label(
            ScanApi.referredByCode(this)?.let { "✓ Claimed friend code: $it (+7 Pro Days)" } ?: "Your code: $myRefCode",
            12.5f,
            0xFF0F7A4A.toInt(),
            bold = true,
        )
        col.addView(stepCard(
            "🎁 Free Pro Forever", "Invite Friends → Get +7 Pro Days Each (No Limit!)",
            "Product scores (0–100), expanded ingredient breakdowns & Cart Avg are 100% free forever. Want unlimited 1-tap swaps & Swap All without paying? Every friend who installs HeyBroc and scans 1 item gives BOTH of you +7 Free Days of Pro.",
            claimedRefStatus,
            primaryButton("Text / Share My Invite Link ($myRefCode)") {
                shareInviteLink(myRefCode)
            },
            primaryButton("Enter or Paste Friend's Invite Code (+7 Days Pro)", filled = false) {
                promptFriendCode(claimedRefStatus)
            },
        ))

        // Mandatory Play Store Privacy Policy link
        col.addView(label("Privacy Policy & Accessibility Data Disclosure ↗", 13f, 0xFF0F7A4A.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(0, dp(12), 0, dp(8))
            setOnClickListener {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.heybroc.com/privacy")))
            }
        })

        refreshHeroCard()
        setContentView(ScrollView(this).apply { addView(col); setBackgroundColor(0xFFF4F3EE.toInt()) })
    }

    private fun shareInviteLink(myCode: String) {
        val url = "https://www.heybroc.com/r/$myCode"
        val msg = "Check out HeyBroc — this little broccoli floats over Walmart, Target & Instacart to grade ingredients (0–100) and swap dirty items in 1 tap. Use my invite link so we both get +7 Free Days of HeyBroc Pro: $url"
        val sendIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "7 Free Days of HeyBroc Pro")
            putExtra(Intent.EXTRA_TEXT, msg)
        }
        startActivity(Intent.createChooser(sendIntent, "Share your HeyBroc invite link"))
    }

    private fun promptFriendCode(statusView: TextView) {
        val clip = (getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)
            ?.primaryClip?.getItemAt(0)?.coerceToText(this)?.toString().orEmpty()
        val prefill = if (clip.contains("BROC-", ignoreCase = true) || clip.contains("/r/", ignoreCase = true)) {
            clip.trim()
        } else {
            ScanApi.referredByCode(this).orEmpty()
        }
        val input = EditText(this).apply {
            hint = "e.g. BROC-7F4A2"
            setText(prefill)
            setPadding(dp(16), dp(14), dp(16), dp(14))
        }
        AlertDialog.Builder(this)
            .setTitle("Redeem Friend's Invite Code")
            .setMessage("Enter your friend's BROC-XXXXX invite code. As soon as you scan your first grocery item in Walmart, Target, or Instacart, you BOTH get +7 Free Days of HeyBroc Pro!")
            .setView(input)
            .setPositiveButton("Apply +7 Free Pro Days") { _, _ ->
                val raw = input.text?.toString()?.trim().orEmpty()
                if (raw.isBlank()) return@setPositiveButton
                val appContext = applicationContext
                val saved = ScanApi.saveReferredByCode(appContext, raw)
                statusView.text = "✓ Claimed friend code: $saved (+7 Pro Days)"
                Toast.makeText(this, "🎁 +7 Free Days of Pro claimed ($saved)! Scan any store item to activate for both of you.", Toast.LENGTH_LONG).show()
                io.execute {
                    runCatching { ScanApi.claimReferral(appContext, saved) }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun refreshHeroCard() {
        heroCardContainer.removeAllViews()
        val overlayOk = Settings.canDrawOverlays(this)
        val a11yServiceEnabled = isAccessibilityEnabled()
        val consentOk = AccessibilityConsent.granted(this)
        val a11yOk = a11yServiceEnabled && consentOk

        if (overlayOk && a11yOk) {
            hideFloatingSetupHelper()
            val statusBadge = label("✓ ACTIVE & READY", 12.5f, 0xFF16A34A.toInt(), bold = true)
            heroCardContainer.addView(stepCard(
                "All Set",
                "HeyBroc is Running Automatically",
                "You don't need to open HeyBroc before shopping! Just open Walmart, Target, BJ's, ALDI, Instacart, or any supported store app — the score bubble pops up automatically when you view food items.",
                statusBadge,
                primaryButton("Preview Score Bubble Here") { launchTestPill() },
                primaryButton("Hide Preview Bubble", filled = false) {
                    startService(Intent(this, OverlayWindowService::class.java).setAction(OverlayWindowService.ACTION_HIDE))
                },
                primaryButton("Pause / Turn Off HeyBroc", filled = false) {
                    AccessibilityConsent.revoke(this)
                    runCatching {
                        startService(Intent(this, OverlayWindowService::class.java).setAction(OverlayWindowService.ACTION_HIDE))
                    }
                    refreshHeroCard()
                    Toast.makeText(this, "HeyBroc paused. You can also turn off the switch in Accessibility Settings.", Toast.LENGTH_LONG).show()
                },
            ))
            return
        }

        val doneCount = (if (overlayOk) 1 else 0) + (if (a11yOk) 1 else 0)
        val statusBadge = label("$doneCount of 2 enabled", 12.5f, 0xFF7A5B00.toInt(), bold = true)

        val checklist = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = GradientDrawable().apply {
                setColor(0xFFF4F3EE.toInt())
                cornerRadius = dp(14).toFloat()
            }
            addView(label(
                if (overlayOk) "✓  1. Floating Score Bubble (Allowed)"
                else "○  1. Allow \"Appear on top\" (Floating Bubble)",
                13.5f,
                if (overlayOk) 0xFF16A34A.toInt() else 0xFF15201B.toInt(),
                bold = !overlayOk
            ))
            addView(label(
                when {
                    a11yOk -> "✓  2. Store Screen Reader (Enabled)"
                    a11yServiceEnabled && !consentOk -> "○  2. Confirm in-app disclosure (1 tap)"
                    else -> "○  2. Turn ON HeyBroc in Accessibility → Installed apps"
                },
                13.5f,
                if (a11yOk) 0xFF16A34A.toInt() else 0xFF15201B.toInt(),
                bold = overlayOk && !a11yOk
            ).apply { setPadding(0, dp(6), 0, 0) })
        }

        val mainActionLabel = when {
            !overlayOk -> "⚡ Start Guided Setup (Allow Everything) →"
            a11yServiceEnabled && !consentOk -> "⚡ Confirm & Activate HeyBroc"
            else -> "⚡ Step 2A: Open Accessibility → Installed apps →"
        }

        val extras = mutableListOf<android.view.View>(
            checklist,
            primaryButton(mainActionLabel) { runGuidedSetupStep() }
        )

        // Only show the sideloaded "Restricted setting" helper when Step 1 is already done and user is on Step 2
        if (overlayOk && !a11yServiceEnabled && !isInstalledFromPlayStore()) {
            extras.add(
                label(
                    "Why don't the ⋮ (3 dots) show up in App Info right away?\n" +
                        "• Step 2A (Required first): Open Accessibility → Installed apps and tap the greyed-out \"HeyBroc\" once. Android completely hides the ⋮ 3-dot menu in App Info until you tap the greyed-out HeyBroc first!\n" +
                        "• Step 2B: Only AFTER tapping the greyed-out HeyBroc, open App Info below → tap ⋮ (top-right 3 dots) → \"Allow restricted settings\".\n" +
                        "• Step 2C: Go back to Accessibility → Installed apps → HeyBroc and flip it ON.\n" +
                        "(Tip: A floating green button at the bottom of your screen will jump you between 2A → 2B → 2C automatically!)",
                    12.5f, 0xFF7A5B00.toInt(),
                ).apply {
                    setPadding(dp(12), dp(10), dp(12), dp(10))
                    background = GradientDrawable().apply { setColor(0xFFFDF6DC.toInt()); cornerRadius = dp(12).toFloat() }
                }
            )
            extras.add(
                primaryButton("Step 2B: Open App Info (Tap ⋮ Top-Right 3 Dots)", filled = false) {
                    if (!hasTappedGreyedOutA11yOnce) {
                        AlertDialog.Builder(this)
                            .setTitle("Did you tap the greyed-out HeyBroc first?")
                            .setMessage(
                                "Samsung/Android hides the ⋮ (3 dots) button in the top-right corner of App Info until you go to:\n\n" +
                                    "Accessibility → Installed apps → tap the greyed-out \"HeyBroc\" once.\n\n" +
                                    "If you haven't tapped the greyed-out HeyBroc yet, the ⋮ 3 dots won't appear on the next screen!"
                            )
                            .setPositiveButton("Do Step 2A First (Installed apps)") { _, _ ->
                                hasTappedGreyedOutA11yOnce = true
                                showFloatingSetupHelper("2A")
                                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                            }
                            .setNegativeButton("I already tapped it → Open App Info") { _, _ ->
                                hasTappedGreyedOutA11yOnce = true
                                showFloatingSetupHelper("2B")
                                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                            }
                            .show()
                    } else {
                        showFloatingSetupHelper("2B")
                        Toast.makeText(this, "Look at top-right ↑ Tap ⋮ (3 dots) → Allow restricted settings", Toast.LENGTH_LONG).show()
                        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                    }
                }
            )
        }

        heroCardContainer.addView(stepCard(
            "Quick 1-Time Setup",
            if (!overlayOk) "Enable HeyBroc in 2 Quick Switches" else "Almost Done — Turn ON HeyBroc",
            if (!overlayOk) {
                "Android requires your permission for floating bubbles and screen reading. Tap below and HeyBroc will automatically take you from Switch 1 straight to Switch 2."
            } else {
                "Tap Step 2A below — a floating HeyBroc helper button will stay at the bottom of your screen to jump you through 2A → 2B → 2C in seconds."
            },
            statusBadge,
            *extras.toTypedArray(),
        ))
    }

    private fun runGuidedSetupStep() {
        val overlayOk = Settings.canDrawOverlays(this)
        val a11yServiceEnabled = isAccessibilityEnabled()
        val consentOk = AccessibilityConsent.granted(this)

        if (!consentOk) {
            showProminentAccessibilityDisclosure {
                proceedAfterConsent()
            }
        } else {
            proceedAfterConsent()
        }
    }

    private fun proceedAfterConsent() {
        val overlayOk = Settings.canDrawOverlays(this)
        val a11yServiceEnabled = isAccessibilityEnabled()

        if (!overlayOk) {
            pendingAutoChainToA11y = !a11yServiceEnabled
            startPermissionWatcher()
            Toast.makeText(this, "Turn ON \"HeyBroc\" here — we'll open Step 2 automatically!", Toast.LENGTH_LONG).show()
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        } else if (!a11yServiceEnabled) {
            hasTappedGreyedOutA11yOnce = true
            startPermissionWatcher()
            if (!isInstalledFromPlayStore()) {
                showFloatingSetupHelper("2A")
            }
            Toast.makeText(this, "1) Tap Installed apps  2) Tap greyed-out HeyBroc once!", Toast.LENGTH_LONG).show()
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        } else {
            hideFloatingSetupHelper()
            refreshHeroCard()
        }
    }

    private fun startPermissionWatcher() {
        watcherAttempts = 0
        mainHandler.removeCallbacks(permissionWatcher)
        mainHandler.postDelayed(permissionWatcher, 500)
    }

    /** Google Play Accessibility API Policy: Mandatory Prominent Disclosure before redirecting to Settings. */
    private fun showProminentAccessibilityDisclosure(onAccepted: () -> Unit) {
        AlertDialog.Builder(this)
            .setTitle("Accessibility Service Disclosure")
            .setMessage(
                "HeyBroc uses the Android AccessibilityService API solely inside 12 supported grocery apps " +
                    "(Walmart, Instacart, Target, Kroger, ALDI, DoorDash, Uber Eats, Amazon Fresh, Sam's Club, BJ's, Costco, and Shipt) to:\n" +
                    "1) Detect when you view a grocery product page and read the visible product title and ingredient list, and\n" +
                    "2) Read visible cart item titles (up to 20 items on Cart screens) and \"in cart\" indicators so your Whole-Cart Health Check reflects your real cart.\n\n" +
                    "• What is transmitted: Only extracted grocery product titles, ingredient text, and active store identifier are sent over HTTPS to heybroc.com/api/scan to compute your 0–100 ingredient score.\n" +
                    "• What is NEVER read: HeyBroc never reads passwords, payment fields, messages, or any other apps on your device, and never sells or shares personal data."
            )
            .setCancelable(false)
            .setPositiveButton("I Agree & Continue") { _, _ ->
                AccessibilityConsent.grant(this)
                refreshHeroCard()
                onAccepted()
            }
            .setNegativeButton("No Thanks", null)
            .show()
    }

    private fun watchlistControls(): LinearLayout {
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val selected = prefs.getStringSet("familyWatchlist", emptySet())?.toMutableSet() ?: mutableSetOf()
        val categories = listOf(
            "dyes" to "Artificial Dyes (2x)",
            "seedOils" to "Seed Oils (2x)",
            "hfcs" to "High-Fructose Corn Syrup (2x)",
            "preservatives" to "Synthetic Preservatives & Nitrites (2x)",
            "sweeteners" to "Artificial Sweeteners (2x)",
            "emulsifiers" to "Synthetic Emulsifiers (2x)",
            "gums" to "Thickening Gums (2x)",
            "flavors" to "Artificial Flavors & MSG (2x)",
        )
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            categories.forEach { (key, title) ->
                addView(CheckBox(this@MainActivity).apply {
                    text = title
                    textSize = 13.5f
                    setTextColor(0xFF15201B.toInt())
                    isChecked = key in selected
                    setOnCheckedChangeListener { _, checked ->
                        val next = (prefs.getStringSet("familyWatchlist", emptySet()) ?: emptySet()).toMutableSet()
                        if (checked) next.add(key) else next.remove(key)
                        prefs.edit().putStringSet("familyWatchlist", next).apply()
                    }
                })
            }
        }
    }

    private fun isInstalledFromPlayStore(): Boolean {
        val installer = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            runCatching { packageManager.getInstallSourceInfo(packageName).installingPackageName }.getOrNull()
        } else {
            @Suppress("DEPRECATION")
            runCatching { packageManager.getInstallerPackageName(packageName) }.getOrNull()
        }
        return installer == "com.android.vending"
    }

    override fun onResume() {
        super.onResume()
        if (pendingAutoChainToA11y && Settings.canDrawOverlays(this) && !isAccessibilityEnabled()) {
            pendingAutoChainToA11y = false
            hasTappedGreyedOutA11yOnce = true
            refreshHeroCard()
            if (!isInstalledFromPlayStore()) {
                showFloatingSetupHelper("2A")
            }
            Toast.makeText(
                this,
                "✓ Step 1 done! Tap Installed apps → greyed-out HeyBroc once, then tap the green button at the bottom!",
                Toast.LENGTH_LONG
            ).show()
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            return
        }
        refreshHeroCard()
    }

    override fun onStop() {
        super.onStop()
        if (Settings.canDrawOverlays(this)) {
            runCatching {
                startService(Intent(this, OverlayWindowService::class.java).setAction(OverlayWindowService.ACTION_HIDE_IF_TEST))
            }
        }
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(permissionWatcher)
        io.shutdownNow()
        super.onDestroy()
    }

    private fun launchTestPill() {
        if (!Settings.canDrawOverlays(this)) {
            Toast.makeText(this, "Tap Start Guided Setup first", Toast.LENGTH_LONG).show()
            return
        }
        val appContext = applicationContext
        // Try the live API with sample ingredients; fall back to the built-in sample offline.
        io.execute {
            val json = runCatching {
                ScanApi.scan(
                    appContext, "Berry Swirl Strawberry Lowfat Yogurt",
                    "Cultured Pasteurized Grade A Lowfat Milk, Sugar, Strawberries, High Fructose Corn Syrup, Modified Corn Starch, Kosher Gelatin, Red 40, Potassium Sorbate, Vitamin A Acetate, Vitamin D3.",
                    "walmart",
                )
            }.getOrNull()?.takeIf { it.contains("\"ok\":true") } ?: ScanApi.SAMPLE_JSON
            runOnUiThread {
                if (isDestroyed || isFinishing) return@runOnUiThread
                runCatching {
                    startService(Intent(this, OverlayWindowService::class.java)
                        .setAction(OverlayWindowService.ACTION_SHOW_TEST)
                        .putExtra(OverlayWindowService.EXTRA_JSON, json))
                }
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

