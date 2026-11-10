package com.cleancart.overlay

import android.accounts.AccountManager
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.Editable
import android.text.TextUtils
import android.text.TextWatcher
import android.util.LruCache
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
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

/**
 * 4-Tab HeyBroc Android App:
 *   - Tab 0 (Scans / My Scans): Clean white product list with ★ Favorites filter & top-right ⋮ menu, real product photos, ● Excellent/Good/Poor/Bad dots, and relative time.
 *   - Tab 1 (Top Picks): "Top Picks" with Food | Store Bubble sub-tabs and pastel rounded-square category rows (Peanut Butter, Cereals & Granolas, Soups & Chowders, etc.).
 *   - Tab 2 (Swaps / Clean Swaps): Side-by-side 2-column comparison cards (⊗ Flagged Product ⇄ ✓ Clean Swap).
 *   - Tab 3 (Search): GPS-style instant autocomplete product search bar + expandable accordion cards for "Live Store Bubble" and "Food preferences (Family Watchlist)".
 *   - Floating green "[||| Scan]" FAB in the bottom-right corner above the 4-tab bar.
 */
class MainActivity : Activity() {

    private lateinit var rootFrame: FrameLayout
    private lateinit var topBarContainer: LinearLayout
    private lateinit var contentScroll: ScrollView
    private lateinit var tabContentContainer: LinearLayout
    private lateinit var bottomNavContainer: LinearLayout
    private lateinit var floatingScanBtn: LinearLayout

    private val io = Executors.newSingleThreadExecutor()
    private val REQ_PICK_GOOGLE_ACCOUNT = 9041
    private var pendingGoogleAccountPicked: ((String) -> Unit)? = null
    private val imgExecutor = Executors.newFixedThreadPool(4)
    private val bmpCache = LruCache<String, Bitmap>(64)
    private val mainHandler = Handler(Looper.getMainLooper())

    private var activeTab = 0 // 0 = Scans, 1 = Top Picks, 2 = Swaps, 3 = Search
    private var historyFavoritesOnly = false
    private var topSubTab = "Food" // "Food" or "Bubble"
    private var selectedTopCategory: String? = null
    private var lastSearchQuery = ""
    private var isSearching = false
    private var expandedPrefSection: String? = "bubble"
    private var pendingSuggestRunnable: Runnable? = null

    private var pendingAutoChainToA11y = false
    private var watcherAttempts = 0
    private val toastRunnables = mutableListOf<Runnable>()

    private fun getSetupSubStep(): String {
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        return prefs.getString("setup_sub_step", "2A") ?: "2A"
    }

    private fun setSetupSubStep(step: String) {
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        prefs.edit().putString("setup_sub_step", step).apply()
    }

    private fun clearScheduledToasts() {
        toastRunnables.forEach { mainHandler.removeCallbacks(it) }
        toastRunnables.clear()
    }

    private fun scheduleSettingsToasts(vararg messages: String) {
        clearScheduledToasts()
        messages.forEachIndexed { idx, msg ->
            val r = Runnable {
                if (!isDestroyed && !isFinishing && !isAccessibilityEnabled()) {
                    Toast.makeText(applicationContext, msg, Toast.LENGTH_LONG).show()
                }
            }
            toastRunnables.add(r)
            mainHandler.postDelayed(r, idx * 3600L)
        }
    }

    private val permissionWatcher = object : Runnable {
        override fun run() {
            if (isDestroyed || isFinishing) return
            val a11yOk = isAccessibilityEnabled() && AccessibilityConsent.granted(this@MainActivity)

            if (a11yOk) {
                pendingAutoChainToA11y = false
                clearScheduledToasts()
                hideFloatingSetupHelper()
                renderScreen()
                return
            }

            if (watcherAttempts++ < 180) {
                mainHandler.postDelayed(this, 500)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        rootFrame = FrameLayout(this).apply {
            setBackgroundColor(Color.WHITE)
        }

        val mainVertical = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        // Top Header Bar
        topBarContainer = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(20), dp(42), dp(16), dp(12))
            setBackgroundColor(Color.WHITE)
        }
        mainVertical.addView(topBarContainer)

        // Scrollable Middle Content Area
        tabContentContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, dp(92))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        contentScroll = ScrollView(this).apply {
            setBackgroundColor(Color.WHITE)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
            addView(tabContentContainer)
        }
        mainVertical.addView(contentScroll)

        // Subtle 1dp top border above bottom navigation bar
        mainVertical.addView(View(this).apply {
            setBackgroundColor(0xFFEEEEEE.toInt())
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
        })

        // Pinned 4-Tab Bottom Bar (Scans, Top Picks, Swaps, Search)
        bottomNavContainer = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.WHITE)
            setPadding(dp(8), dp(8), dp(8), dp(24))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        mainVertical.addView(bottomNavContainer)
        rootFrame.addView(mainVertical)

        // Floating Green "[||| Scan]" Button in bottom-right corner
        floatingScanBtn = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(18), dp(13), dp(20), dp(13))
            background = GradientDrawable().apply {
                setColor(0xFF4CAF6A.toInt())
                cornerRadius = dp(18).toFloat()
            }
            elevation = dp(8).toFloat()
            addView(label("[|||]", 14f, Color.WHITE, bold = true).apply {
                setPadding(0, 0, dp(10), 0)
            })
            addView(label("Scan", 15.5f, Color.WHITE, bold = true))
            setOnClickListener {
                showQuickScanModal()
            }
        }
        val fabParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.END
            marginEnd = dp(18)
            bottomMargin = dp(90)
        }
        rootFrame.addView(floatingScanBtn, fabParams)

        setContentView(rootFrame)

        // Dynamic system bar insets for Android 11+ edge-to-edge
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            rootFrame.setOnApplyWindowInsetsListener { _, insets ->
                val sysBars = insets.getInsets(android.view.WindowInsets.Type.systemBars())
                topBarContainer.setPadding(dp(20), maxOf(dp(16), sysBars.top + dp(10)), dp(16), dp(12))
                val bottomPad = maxOf(dp(12), sysBars.bottom + dp(6))
                bottomNavContainer.setPadding(dp(8), dp(8), dp(8), bottomPad)
                fabParams.bottomMargin = bottomPad + dp(68)
                floatingScanBtn.layoutParams = fabParams
                insets
            }
        }

        renderScreen()

        // Launch the 4-Step Goals -> Problem -> Solution -> Personalized Plan Onboarding Funnel on first open
        if (savedInstanceState == null) {
            val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
            val onboardingDone = prefs.getBoolean("onboarding_funnel_done_v1", false)
            val savedEmail = prefs.getString("auth_email", null)?.takeIf { it.isNotBlank() }
            if (!onboardingDone) {
                mainHandler.postDelayed({
                    if (!isDestroyed && !isFinishing) {
                        showOnboardingFunnelDialog()
                    }
                }, 180L)
            } else if (savedEmail == null) {
                mainHandler.postDelayed({
                    if (!isDestroyed && !isFinishing) {
                        showGoCoCoLoginDialog()
                    }
                }, 180L)
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_PICK_GOOGLE_ACCOUNT) {
            val cb = pendingGoogleAccountPicked
            pendingGoogleAccountPicked = null
            val pickedEmail = if (resultCode == Activity.RESULT_OK && data != null) {
                data.getStringExtra(android.accounts.AccountManager.KEY_ACCOUNT_NAME).orEmpty().trim()
            } else {
                ""
            }
            cb?.invoke(pickedEmail)
        }
    }

    private fun renderScreen() {
        renderTopBar()
        renderBottomNav()
        tabContentContainer.removeAllViews()

        floatingScanBtn.visibility = if (activeTab == 3) View.GONE else View.VISIBLE

        when (activeTab) {
            0 -> renderHistoryTab()
            1 -> renderTopProductsTab()
            2 -> renderRecsTab()
            3 -> renderSearchAndPrefsTab()
        }
    }

    private fun renderTopBar() {
        topBarContainer.removeAllViews()
        topBarContainer.orientation = LinearLayout.VERTICAL
        topBarContainer.gravity = Gravity.START

        val titleText = when (activeTab) {
            0 -> if (historyFavoritesOnly) "★ Favorites" else "My Scans"
            1 -> "Top Picks"
            2 -> "Clean Swaps"
            else -> "Search"
        }

        // Row 1: Page Title on the left + Favorites star (☆) and Menu (⋮) on the right
        val titleRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        titleRow.addView(label(titleText, 26f, 0xFF111814.toInt(), bold = true).apply {
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })

        if (activeTab == 0) {
            titleRow.addView(label(
                if (historyFavoritesOnly) "★" else "☆",
                22f,
                if (historyFavoritesOnly) 0xFFEAB308.toInt() else 0xFF374151.toInt(),
                bold = true
            ).apply {
                setPadding(dp(10), dp(2), dp(10), dp(2))
                setOnClickListener {
                    historyFavoritesOnly = !historyFavoritesOnly
                    renderScreen()
                }
            })
        }

        titleRow.addView(label("⋮", 22f, 0xFF374151.toInt(), bold = true).apply {
            setPadding(dp(10), dp(2), dp(4), dp(2))
            setOnClickListener {
                showTopRightMenuDialog()
            }
        })
        topBarContainer.addView(titleRow)

        // Row 2: Uniform 30dp-height action pills aligned on a single horizontal baseline across all tabs
        // Left: 🛡️ Allergies & Diabetes ▾   |   Right: 👤 Log in · ⚡ Setup / ● Live
        val pillsRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) }
        }

        fun buildHeaderPill(
            text: String,
            textColor: Int,
            bgColor: Int,
            strokeColor: Int,
            marginEndDp: Int = 0,
            onClick: () -> Unit
        ): TextView = label(text, 11.5f, textColor, bold = true).apply {
            gravity = Gravity.CENTER
            includeFontPadding = false
            setSingleLine(true)
            ellipsize = TextUtils.TruncateAt.END
            setPadding(dp(11), 0, dp(11), 0)
            background = GradientDrawable().apply {
                setColor(bgColor)
                setStroke(dp(1), strokeColor)
                cornerRadius = dp(999).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                dp(30)
            ).apply {
                if (marginEndDp > 0) marginEnd = dp(marginEndDp)
            }
            setOnClickListener { onClick() }
        }

        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val activeDietaryCount = prefs.getStringSet("dietaryWatchlist", emptySet())?.size ?: 0
        val hasDietaryAlerts = activeDietaryCount > 0
        val allergyHeaderLabel = if (hasDietaryAlerts) {
            "🛡️ Allergies ($activeDietaryCount) ▾"
        } else {
            "🛡️ Allergies & Diabetes ▾"
        }

        pillsRow.addView(buildHeaderPill(
            text = allergyHeaderLabel,
            textColor = if (hasDietaryAlerts) 0xFF991B1B.toInt() else 0xFF065F46.toInt(),
            bgColor = if (hasDietaryAlerts) 0xFFFEF2F2.toInt() else 0xFFECFDF5.toInt(),
            strokeColor = if (hasDietaryAlerts) 0xFFFCA5A5.toInt() else 0xFF86EFAC.toInt(),
            marginEndDp = 6,
            onClick = { showAllergyAndDietModal() }
        ))

        // Flexible spacer so left pill sits cleanly under the page title and right pills align with top-right icons
        pillsRow.addView(View(this).apply {
            layoutParams = LinearLayout.LayoutParams(0, dp(1), 1f)
        })

        // Account / Log in pill button
        val savedName = prefs.getString("auth_name", null)?.takeIf { it.isNotBlank() }
        val savedEmail = prefs.getString("auth_email", null)?.takeIf { it.isNotBlank() }
        val isLoggedIn = !savedEmail.isNullOrBlank()
        val displayAccountLabel = if (isLoggedIn) {
            "👤 ${(savedName ?: savedEmail!!.substringBefore("@")).take(8)}"
        } else {
            "👤 Log in"
        }

        pillsRow.addView(buildHeaderPill(
            text = displayAccountLabel,
            textColor = if (isLoggedIn) 0xFF065F46.toInt() else 0xFF1F2937.toInt(),
            bgColor = if (isLoggedIn) 0xFFECFDF5.toInt() else 0xFFEFF1F0.toInt(),
            strokeColor = if (isLoggedIn) 0xFF86EFAC.toInt() else 0xFFE4E7E5.toInt(),
            marginEndDp = 0,
            onClick = { showGoCoCoLoginDialog() }
        ))

        topBarContainer.addView(pillsRow)
    }

    private fun renderBottomNav() {
        bottomNavContainer.removeAllViews()
        val tabs = listOf(
            Triple(0, "MASCOT", "Scans"),
            Triple(1, "☰", "Top Picks"),
            Triple(2, "⇄", "Swaps"),
            Triple(3, "🔍", "Search")
        )
        tabs.forEach { (idx, icon, title) ->
            val selected = activeTab == idx
            val col = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                setOnClickListener {
                    if (activeTab != idx) {
                        activeTab = idx
                        selectedTopCategory = null
                        renderScreen()
                        contentScroll.post { contentScroll.scrollTo(0, 0) }
                    }
                }
            }

            // Soft green pill around the selected icon
            val iconPill = FrameLayout(this).apply {
                setPadding(dp(18), dp(4), dp(18), dp(4))
                if (selected) {
                    background = GradientDrawable().apply {
                        setColor(0xFFE8F5EC.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            }
            if (icon == "MASCOT") {
                iconPill.addView(ImageView(this).apply {
                    setImageResource(R.drawable.broc_mascot)
                    scaleType = ImageView.ScaleType.FIT_CENTER
                    layoutParams = FrameLayout.LayoutParams(dp(23), dp(23), Gravity.CENTER)
                })
            } else {
                iconPill.addView(label(icon, 17f, if (selected) 0xFF2E9E5B.toInt() else 0xFF374151.toInt(), bold = true).apply {
                    gravity = Gravity.CENTER
                })
            }
            col.addView(iconPill)

            col.addView(label(title, 12f, if (selected) 0xFF111814.toInt() else 0xFF4B5563.toInt(), bold = selected).apply {
                gravity = Gravity.CENTER
                setPadding(0, dp(3), 0, 0)
            })
            bottomNavContainer.addView(col)
        }
    }

    /* ---------------- TAB 0: MY SCANS ---------------- */

    private fun buildDarkGreenStep2Card(subStep: String): View {
        val stepTitle = when (subStep) {
            "2B" -> "Step 2 of 3: Unlock Restricted Settings"
            "2C" -> "Step 3 of 3: Flip HeyBroc Switch ON"
            else -> "Step 1 of 3: Tap Greyed-Out HeyBroc Once"
        }
        val stepBody = when (subStep) {
            "2B" -> "Tap below to open App Info → tap ⋮ (3 dots in top-right corner) → tap 'Allow restricted settings'."
            "2C" -> "Restricted settings unlocked! Tap below → Installed apps → HeyBroc → flip the switch ON."
            else -> "Android requires tapping the greyed-out 'HeyBroc' in Accessibility → Installed apps once before the ⋮ 3-dot unlock menu appears."
        }
        val btnText = when (subStep) {
            "2B" -> "⚡ Open App Info (Tap ⋮ Top-Right 3 Dots) →"
            "2C" -> "⚡ Open Accessibility & Turn ON HeyBroc →"
            else -> "⚡ Step 1: Open Installed Apps →"
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = GradientDrawable().apply {
                setColor(0xFF064E3B.toInt())
                cornerRadius = dp(18).toFloat()
                setStroke(dp(1), 0xFF10B981.toInt())
            }
            addView(label("LIVE STORE BUBBLE SETUP · 1-SWITCH ACCESSIBILITY", 10.5f, 0xFFA7F3D0.toInt(), bold = true).apply {
                letterSpacing = 0.06f
            })
            addView(label(stepTitle, 15.5f, Color.WHITE, bold = true).apply {
                setPadding(0, dp(4), 0, dp(3))
            })
            addView(label(stepBody, 12.5f, 0xFFD1FAE5.toInt()).apply {
                setPadding(0, 0, 0, dp(10))
            })
            addView(label(btnText, 13.5f, 0xFF064E3B.toInt(), bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(14), dp(11), dp(14), dp(11))
                background = GradientDrawable().apply {
                    setColor(0xFF6EE7B7.toInt())
                    cornerRadius = dp(999).toFloat()
                }
                setOnClickListener { runGuidedSetupStep() }
            })
        }
    }

    private fun buildCleanCartStreakCard(): View {
        val streak = ScanHistoryStore.getStreakStatus(this)
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val activeAllergies = prefs.getStringSet("dietaryWatchlist", emptySet())?.size ?: 0

        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = GradientDrawable().apply {
                setColor(0xFFFAFAFA.toInt())
                cornerRadius = dp(20).toFloat()
                setStroke(dp(1), 0xFFE5E7EB.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(dp(16), dp(4), dp(16), dp(10))
            }

            // Header Row: Mascot + "Clean Cart Streak: Day X"
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                addView(ImageView(context).apply {
                    setImageResource(R.drawable.broc_mascot)
                    scaleType = ImageView.ScaleType.FIT_CENTER
                    layoutParams = LinearLayout.LayoutParams(dp(34), dp(34)).apply {
                        marginEnd = dp(10)
                    }
                })
                addView(LinearLayout(context).apply {
                    orientation = LinearLayout.VERTICAL
                    addView(label("Clean Cart Streak: Day ${streak.streakDays}", 16f, 0xFF111814.toInt(), bold = true))
                    addView(label("${streak.cleanCount} clean items in your library · Scan or swap daily!", 11.5f, 0xFF6B7280.toInt()))
                })
            })

            // 5 Green Day Circles Row (matching Slide 5)
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                setPadding(0, dp(12), 0, dp(10))
                streak.windowNumbers.forEachIndexed { i, (dayNum, completed) ->
                    addView(label(
                        dayNum.toString(),
                        13.5f,
                        if (completed) Color.WHITE else 0xFF166534.toInt(),
                        bold = true
                    ).apply {
                        gravity = Gravity.CENTER
                        background = GradientDrawable().apply {
                            shape = GradientDrawable.OVAL
                            setColor(if (completed) 0xFF3E9B4F.toInt() else 0xFFE8F5EC.toInt())
                            if (!completed) {
                                setStroke(dp(1), 0xFFBBF7D0.toInt())
                            }
                        }
                        layoutParams = LinearLayout.LayoutParams(dp(36), dp(36)).apply {
                            if (i < streak.windowNumbers.lastIndex) marginEnd = dp(10)
                        }
                    })
                }
            })

            // 3 Protection Badges Row: Seed-Oil Free · No Red 40 · Allergy Guard
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                val pills = listOf(
                    "Seed-Oil Free" to false,
                    "No Red 40" to false,
                    (if (activeAllergies > 0) "Allergy Guard ($activeAllergies)" else "Allergy Guard") to true
                )
                pills.forEachIndexed { idx, (pillText, opensAllergyModal) ->
                    addView(label(pillText, 11f, 0xFF1F2937.toInt(), bold = true).apply {
                        setPadding(dp(10), dp(4), dp(10), dp(4))
                        background = GradientDrawable().apply {
                            setColor(Color.WHITE)
                            cornerRadius = dp(999).toFloat()
                            setStroke(dp(1), 0xFFD1D5DB.toInt())
                        }
                        layoutParams = LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT
                        ).apply {
                            if (idx < pills.lastIndex) marginEnd = dp(6)
                        }
                        setOnClickListener {
                            if (opensAllergyModal) {
                                showAllergyAndDietModal()
                            } else {
                                activeTab = 3
                                expandedPrefSection = "prefs"
                                renderScreen()
                            }
                        }
                    })
                }
            })
        }
    }

    private fun renderHistoryTab() {
        val a11yServiceEnabled = isAccessibilityEnabled()
        val consentOk = AccessibilityConsent.granted(this)
        val a11yOk = a11yServiceEnabled && consentOk

        // Show the sleek auto-advancing dark-green setup card when consent is granted on a sideloaded APK
        if (consentOk && !a11yServiceEnabled && !isInstalledFromPlayStore()) {
            tabContentContainer.addView(buildDarkGreenStep2Card(getSetupSubStep()).apply {
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply {
                    setMargins(dp(16), dp(4), dp(16), dp(10))
                }
            })
        } else if (!a11yOk) {
            tabContentContainer.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(16), dp(12), dp(16), dp(12))
                background = GradientDrawable().apply {
                    setColor(0xFFF0FDF4.toInt())
                    cornerRadius = dp(16).toFloat()
                    setStroke(dp(1), 0xFFBBF7D0.toInt())
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply {
                    setMargins(dp(16), dp(4), dp(16), dp(8))
                }
                addView(LinearLayout(context).apply {
                    orientation = LinearLayout.VERTICAL
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                    addView(label("Enable Live Store Bubble (1-Switch Setup)", 13.5f, 0xFF14532D.toInt(), bold = true))
                    addView(label("Auto-scan foods in Walmart, Target, Kroger, Shipt, DoorDash, Costco, Sam's, BJ's, Amazon Fresh, Instacart, ALDI & more", 12f, 0xFF166534.toInt()))
                })
                addView(label("Turn ON →", 12.5f, Color.WHITE, bold = true).apply {
                    setPadding(dp(14), dp(8), dp(14), dp(8))
                    background = GradientDrawable().apply {
                        setColor(0xFF2E9E5B.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    setOnClickListener {
                        runGuidedSetupStep()
                    }
                })
            })
        }

        // Clean Cart Streak Card (matching Slide 5 of the ASO store deck)
        if (!historyFavoritesOnly) {
            tabContentContainer.addView(buildCleanCartStreakCard())
        }

        val items = if (historyFavoritesOnly) {
            ScanHistoryStore.getFavorites(this)
        } else {
            val combined = ArrayList<JSONObject>()
            val seen = HashSet<String>()
            (ScanHistoryStore.getHistory(this) + ScanHistoryStore.getExploreCatalog(this)).forEach { it ->
                val k = ScanHistoryStore.extractTitle(it).lowercase().trim()
                if (k.isNotBlank() && seen.add(k)) combined.add(it)
            }
            combined
        }

        if (items.isEmpty()) {
            tabContentContainer.addView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(dp(32), dp(48), dp(32), dp(48))
                addView(label("★", 40f, 0xFFD1D5DB.toInt()))
                addView(label("No Saved Favorites Yet", 17f, 0xFF111814.toInt(), bold = true).apply {
                    setPadding(0, dp(8), 0, dp(4))
                })
                addView(label("Tap the ☆ star on any item in My Scans or Top Picks to save it here.", 13.5f, 0xFF6B7280.toInt()).apply {
                    gravity = Gravity.CENTER
                })
            })
            return
        }

        items.forEachIndexed { idx, item ->
            tabContentContainer.addView(buildYukaHistoryRow(item))
            if (idx < items.lastIndex) {
                tabContentContainer.addView(View(this).apply {
                    setBackgroundColor(0xFFEEEEEE.toInt())
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
                })
            }
        }
    }

    /** Product row: Left product image, Right Title + Brand + ● Rating + 🕒 time ago, + ★ Star. */
    private fun buildYukaHistoryRow(item: JSONObject): View {
        val prod = item.optJSONObject("product")
        val res = item.optJSONObject("result")
        val title = ScanHistoryStore.extractTitle(item)
        val brand = prod?.optString("brand").orEmpty().ifBlank { item.optString("brand") }
        val imgUrl = prod?.optString("imageUrl").orEmpty().ifBlank { item.optString("imageUrl") }
        val score = res?.optInt("score") ?: item.optInt("score", 50)
        val rating = ratingForScore(score)
        val dotColor = yukaDotColor(score)
        val scannedAt = item.optLong("scannedAtMs", 0L)
        val storeKey = item.optString("storeKey", "")

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(18), dp(14), dp(14), dp(14))
            setBackgroundColor(Color.WHITE)
            setOnClickListener { showProductDetailDialog(item) }
        }

        // Left Product Bottle/Box Image (68dp x 82dp on clean white)
        row.addView(buildProductImageBox(imgUrl, title, dp(68), dp(82)).apply {
            layoutParams = LinearLayout.LayoutParams(dp(68), dp(82)).apply { marginEnd = dp(16) }
        })

        // Middle Column: Title, Brand, ● Rating (Score/100), 🕒 Time ago
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        col.addView(label(title, 16.5f, 0xFF111814.toInt(), bold = true).apply {
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        })
        if (brand.isNotBlank()) {
            col.addView(label(brand, 14f, 0xFF6B7280.toInt()).apply {
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                setPadding(0, dp(2), 0, 0)
            })
        }

        // Colored Dot + Rating ("Excellent", "Good", "Poor", "Bad") + Score
        val ratingRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(6), 0, 0)
        }
        ratingRow.addView(View(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(dotColor)
            }
            layoutParams = LinearLayout.LayoutParams(dp(12), dp(12)).apply { marginEnd = dp(8) }
        })
        ratingRow.addView(label("$rating ($score/100)", 14f, 0xFF374151.toInt()))
        col.addView(ratingRow)

        // Relative time row ("🕒 Just now · Walmart")
        val timeText = formatRelativeTime(scannedAt, storeKey)
        col.addView(label("🕒  $timeText", 13f, 0xFF6B7280.toInt()).apply {
            setPadding(0, dp(4), 0, 0)
        })
        row.addView(col)

        // Right ★ Star Favorite Toggle
        val isFav = ScanHistoryStore.isFavorite(this, title)
        row.addView(label(
            if (isFav) "★" else "☆",
            22f,
            if (isFav) 0xFFEAB308.toInt() else 0xFFD1D5DB.toInt(),
            bold = true
        ).apply {
            setPadding(dp(10), dp(10), dp(6), dp(10))
            setOnClickListener {
                val nowFav = ScanHistoryStore.toggleFavorite(this@MainActivity, item)
                Toast.makeText(
                    this@MainActivity,
                    if (nowFav) "Added to ★ Favorites" else "Removed from ★ Favorites",
                    Toast.LENGTH_SHORT
                ).show()
                renderScreen()
            }
        })

        return row
    }

    /* ---------------- TAB 1: ⇄ RECS (Matches Screenshot_20261107_173727_Yuka.jpg) ---------------- */

    private fun renderRecsTab() {
        val allItems = ArrayList<JSONObject>()
        val seen = HashSet<String>()
        (ScanHistoryStore.getHistory(this) + ScanHistoryStore.getExploreCatalog(this)).forEach { it ->
            val k = ScanHistoryStore.extractTitle(it).lowercase().trim()
            if (k.isNotBlank() && seen.add(k) && it.optJSONObject("swap") != null) {
                allItems.add(it)
            }
        }

        val listWrap = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(8), dp(14), dp(16))
        }

        allItems.forEach { badItem ->
            val swapObj = badItem.optJSONObject("swap") ?: return@forEach
            listWrap.addView(buildYukaSideBySideSwapRow(badItem, swapObj))
        }

        tabContentContainer.addView(listWrap)
    }

    /**
     * Exact Yuka Recommendations 2-column row:
     *   [ Left Card: ⊗ Bad Item ]  <-- ( ⇄ ) -->  [ Right Card: ✓ Clean Swap ]
     */
    private fun preferredStoreKey(): String {
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        return prefs.getString("preferredStore", "walmart")?.takeIf { it.isNotBlank() } ?: "walmart"
    }

    private fun buildYukaSideBySideSwapRow(badItem: JSONObject, swapObj: JSONObject): View {
        val prod = badItem.optJSONObject("product")
        val res = badItem.optJSONObject("result")
        val badTitle = ScanHistoryStore.extractTitle(badItem)
        val badBrand = prod?.optString("brand").orEmpty().ifBlank { badItem.optString("brand") }
        val badImg = prod?.optString("imageUrl").orEmpty().ifBlank { badItem.optString("imageUrl") }
        val badScore = res?.optInt("score") ?: 20
        val badRating = res?.optString("rating").orEmpty().ifBlank { ratingForScore(badScore) }
        val rawStoreKey = badItem.optString("storeKey", "")
        val itemStoreKey = if (rawStoreKey.isBlank() || rawStoreKey == "search") preferredStoreKey() else rawStoreKey
        ScanHistoryStore.upgradeSwapForStore(swapObj, badTitle, itemStoreKey)

        val swapTitle = swapObj.optString("title", "Clean Swap")
        val swapBrand = swapObj.optString("brand", "Clean Pick")
        val swapScore = swapObj.optInt("score", 0)
        val swapImg = swapObj.optString("imageUrl", "")
        val swapRating = ratingForScore(swapScore)

        val outerFrame = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(14) }
        }

        val twoColRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }

        // Left Card (⊗ Bad / Poor Product)
        val leftCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(12), dp(12), dp(12), dp(14))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(18).toFloat()
                setStroke(dp(1), 0xFFE5E7EB.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginEnd = dp(6)
            }
            setOnClickListener { showProductDetailDialog(badItem) }
        }

        val leftTopBox = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(104))
        }
        leftTopBox.addView(buildProductImageBox(badImg, badTitle, dp(76), dp(96)).apply {
            layoutParams = FrameLayout.LayoutParams(dp(76), dp(96), Gravity.CENTER)
        })
        // Red ✕ circle badge in top-left of image
        leftTopBox.addView(label("✕", 12f, Color.WHITE, bold = true).apply {
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0xFFD93025.toInt())
            }
            layoutParams = FrameLayout.LayoutParams(dp(24), dp(24), Gravity.TOP or Gravity.START).apply {
                marginStart = dp(12)
                topMargin = dp(2)
            }
        })
        leftCard.addView(leftTopBox)

        leftCard.addView(label(badTitle, 14.5f, 0xFF111814.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setPadding(0, dp(6), 0, 0)
        })
        leftCard.addView(label(badBrand.ifBlank { "Conventional" }, 13f, 0xFF6B7280.toInt()).apply {
            gravity = Gravity.CENTER
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setPadding(0, dp(2), 0, 0)
        })
        leftCard.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(0, dp(6), 0, 0)
            addView(View(context).apply {
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(yukaDotColor(badScore))
                }
                layoutParams = LinearLayout.LayoutParams(dp(9), dp(9)).apply { marginEnd = dp(6) }
            })
            addView(label(badRating, 13f, 0xFF374151.toInt()))
        })

        val swapUnlocked = ScanApi.isSwapUnlocked(this, badTitle, swapTitle)
        val rem = ScanApi.swapsRemaining(this)
        val lim = ScanApi.weeklySwapsLimit(this)

        // Right Card (✓ Clean Swap Product — gated until unlocked or Pro)
        val rightCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(12), dp(12), dp(12), dp(14))
            background = GradientDrawable().apply {
                setColor(if (swapUnlocked) Color.WHITE else 0xFFF4FBF7.toInt())
                cornerRadius = dp(18).toFloat()
                setStroke(dp(1), if (swapUnlocked) 0xFFE5E7EB.toInt() else 0xFF86EFAC.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = dp(6)
            }
            setOnClickListener {
                if (swapUnlocked) {
                    val isOrg = swapTitle.contains("organic", ignoreCase = true) ||
                        swapObj.optString("ingredients").contains("organic", ignoreCase = true)
                    val orgScore = if (isOrg) 10 else 0
                    val addScore = 30
                    val nutScore = (swapScore - addScore - orgScore).coerceIn(0, 60)
                    val swapPreview = JSONObject().apply {
                        put("ok", true)
                        put("storeKey", itemStoreKey)
                        put("product", JSONObject().apply {
                            put("title", swapTitle)
                            put("brand", swapBrand)
                            put("imageUrl", swapImg)
                            put("ingredients", swapObj.optString("ingredients"))
                        })
                        put("result", JSONObject().apply {
                            put("score", swapScore)
                            put("rating", swapRating)
                            put("color", if (swapScore >= 75) "green" else if (swapScore >= 50) "yellow" else "red")
                            put("flagged", JSONArray())
                            put("yukaBreakdown", JSONObject().apply {
                                put("nutritionScore", nutScore)
                                put("nutriScoreGrade", if (nutScore >= 48) "A" else "B")
                                put("additiveScore", addScore)
                                put("organicScore", orgScore)
                                put("highRiskCapped", false)
                            })
                        })
                        put("storeSwapLink", JSONObject(swapObj.toString()))
                    }
                    showProductDetailDialog(swapPreview)
                } else {
                    showProductDetailDialog(badItem)
                }
            }
        }

        val rightTopBox = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(104))
        }
        if (swapUnlocked) {
            rightTopBox.addView(buildProductImageBox(swapImg, swapTitle, dp(76), dp(96)).apply {
                layoutParams = FrameLayout.LayoutParams(dp(76), dp(96), Gravity.CENTER)
            })
        } else {
            rightTopBox.addView(buildNeutralPackagePlaceholder(dp(76), dp(96)).apply {
                layoutParams = FrameLayout.LayoutParams(dp(76), dp(96), Gravity.CENTER)
            })
        }
        // Green ✓ or 🔒 circle badge in top-left of image
        rightTopBox.addView(label(if (swapUnlocked) "✓" else "🔒", 12f, Color.WHITE, bold = true).apply {
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0xFF4CAF6A.toInt())
            }
            layoutParams = FrameLayout.LayoutParams(dp(24), dp(24), Gravity.TOP or Gravity.START).apply {
                marginStart = dp(12)
                topMargin = dp(2)
            }
        })
        if (swapUnlocked) {
            // Top-right ⋮ on the swap card (opens in active store)
            rightTopBox.addView(label("⋮", 18f, 0xFF374151.toInt(), bold = true).apply {
                gravity = Gravity.CENTER
                layoutParams = FrameLayout.LayoutParams(dp(28), dp(28), Gravity.TOP or Gravity.END)
                setOnClickListener { openStoreSwap(swapTitle, itemStoreKey, swapObj, badTitle) }
            })
        }
        rightCard.addView(rightTopBox)

        rightCard.addView(label(
            if (swapUnlocked) swapTitle else "🔒 $swapScore/100 Clean Swap",
            14.5f,
            0xFF111814.toInt(),
            bold = true
        ).apply {
            gravity = Gravity.CENTER
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setPadding(0, dp(6), 0, 0)
        })
        rightCard.addView(label(
            when {
                swapUnlocked -> swapBrand
                rem > 0 -> "Tap to Reveal ($rem/$lim Free)"
                else -> "Unlock Unlimited — Pro"
            },
            12.5f,
            if (swapUnlocked) 0xFF6B7280.toInt() else 0xFF166534.toInt(),
            bold = !swapUnlocked
        ).apply {
            gravity = Gravity.CENTER
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setPadding(0, dp(2), 0, 0)
        })
        rightCard.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(0, dp(6), 0, 0)
            addView(View(context).apply {
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(yukaDotColor(swapScore))
                }
                layoutParams = LinearLayout.LayoutParams(dp(9), dp(9)).apply { marginEnd = dp(6) }
            })
            addView(label(swapRating, 13f, 0xFF374151.toInt()))
        })

        twoColRow.addView(leftCard)
        twoColRow.addView(rightCard)
        outerFrame.addView(twoColRow)

        // Center Floating "⇄" Circle Overlapping Left and Right Cards (just like Yuka's Recs screen!)
        val centerSwapBadge = label("⇄", 16f, 0xFF374151.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.WHITE)
                setStroke(dp(1), 0xFFE5E7EB.toInt())
            }
            elevation = dp(4).toFloat()
            layoutParams = FrameLayout.LayoutParams(dp(36), dp(36), Gravity.CENTER)
        }
        outerFrame.addView(centerSwapBadge)

        return outerFrame
    }

    /* ---------------- TAB 2: ☰ TOP PRODUCTS (Matches Screenshot_20261107_173728_Yuka.jpg) ---------------- */

    private fun renderTopProductsTab() {
        // Sub-Tab Row: "Food" | "Store Bubble"
        val subTabRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.WHITE)
        }
        listOf("Food" to "Food", "Bubble" to "Store Bubble").forEach { (key, title) ->
            val selected = topSubTab == key
            val tabCol = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                setOnClickListener {
                    topSubTab = key
                    selectedTopCategory = null
                    renderScreen()
                }
            }
            tabCol.addView(label(title, 15f, if (selected) 0xFF2E9E5B.toInt() else 0xFF4B5563.toInt(), bold = selected).apply {
                gravity = Gravity.CENTER
                setPadding(0, dp(8), 0, dp(10))
            })
            tabCol.addView(View(this).apply {
                setBackgroundColor(if (selected) 0xFF2E9E5B.toInt() else 0xFFEEEEEE.toInt())
                layoutParams = LinearLayout.LayoutParams(
                    if (selected) dp(64) else ViewGroup.LayoutParams.MATCH_PARENT,
                    if (selected) dp(3) else dp(1)
                )
            })
            subTabRow.addView(tabCol)
        }
        tabContentContainer.addView(subTabRow)

        if (topSubTab == "Bubble") {
            val wrap = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(16), dp(14), dp(16), dp(24))
            }
            appendBubbleSetupAndWatchlistCards(wrap)
            tabContentContainer.addView(wrap)
            return
        }

        // If user tapped a specific category in Top Products, show that category's ranked products
        val activeCat = selectedTopCategory
        if (activeCat != null) {
            tabContentContainer.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(18), dp(14), dp(18), dp(8))
                addView(label("← All Categories", 14f, 0xFF2E9E5B.toInt(), bold = true).apply {
                    setPadding(0, dp(4), dp(14), dp(4))
                    setOnClickListener {
                        selectedTopCategory = null
                        renderScreen()
                    }
                })
                addView(label("·  $activeCat", 15f, 0xFF111814.toInt(), bold = true))
            })

            val catItems = ScanHistoryStore.getExploreCatalog(this)
                .filter {
                    val c = it.optString("category")
                    c.equals(activeCat, ignoreCase = true)
                }
                .sortedByDescending { it.optJSONObject("result")?.optInt("score") ?: 0 }

            catItems.forEachIndexed { i, item ->
                tabContentContainer.addView(buildYukaHistoryRow(item))
                if (i < catItems.lastIndex) {
                    tabContentContainer.addView(View(this).apply {
                        setBackgroundColor(0xFFEEEEEE.toInt())
                        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
                    })
                }
            }
            return
        }

        // Top Card showcasing the Live Store Bubble with our custom Broc mascot
        val heroBanner = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(16))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(18).toFloat()
                setStroke(dp(1), 0xFFE5E7EB.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(dp(16), dp(16), dp(16), dp(10))
            }
            setOnClickListener {
                topSubTab = "Bubble"
                renderScreen()
            }
        }
        val mascotCircle = FrameLayout(this).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0xFFE8F5EC.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(dp(50), dp(50)).apply { marginEnd = dp(16) }
            addView(ImageView(context).apply {
                setImageResource(R.drawable.broc_mascot)
                scaleType = ImageView.ScaleType.FIT_CENTER
                layoutParams = FrameLayout.LayoutParams(dp(34), dp(34), Gravity.CENTER)
            })
        }
        heroBanner.addView(mascotCircle)
        heroBanner.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            addView(label("All top picks are 100% unlocked — plus auto-scan inside Walmart, Target, Kroger, Shipt, DoorDash & all 12 stores", 14.5f, 0xFF111814.toInt()))
            addView(label("Manage Live Store Bubble →", 14f, 0xFF2E9E5B.toInt(), bold = true).apply {
                setPadding(0, dp(6), 0, 0)
            })
        })
        tabContentContainer.addView(heroBanner)

        // Category Rows with pastel rounded-square icons and › chevrons
        data class TopCat(val title: String, val icon: String, val bgColor: Int)
        val categories = listOf(
            TopCat("Energy Drinks & Pre-Workouts", "⚡", 0xFFFEF3C7.toInt()),
            TopCat("Sodas & Prebiotic Drinks", "🥤", 0xFFFDECEC.toInt()),
            TopCat("Waters, Seltzers & Hydration", "💧", 0xFFEFF6FF.toInt()),
            TopCat("Juices, Smoothies & Tea", "🧃", 0xFFFEF0E6.toInt()),
            TopCat("Milk & Dairy", "🥛", 0xFFE8F5EC.toInt()),
            TopCat("Peanut Butter", "🥜", 0xFFFEF9E7.toInt()),
            TopCat("Cereals & Granolas", "🥣", 0xFFFEF0E6.toInt()),
            TopCat("Soups & Chowders", "🍲", 0xFFFDECEC.toInt()),
            TopCat("Salads & Dressings", "🥗", 0xFFE8F5EC.toInt()),
            TopCat("Chips & Snacks", "🍪", 0xFFFEF3C7.toInt()),
            TopCat("Bread & Bakery", "🍞", 0xFFF5F3FF.toInt()),
            TopCat("Dark Chocolate & Treats", "🍫", 0xFFF3F4F6.toInt())
        )

        categories.forEach { cat ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(18), dp(12), dp(20), dp(12))
                setOnClickListener {
                    selectedTopCategory = cat.title
                    renderScreen()
                }
            }
            row.addView(label(cat.icon, 20f, 0xFF111814.toInt()).apply {
                gravity = Gravity.CENTER
                background = GradientDrawable().apply {
                    setColor(cat.bgColor)
                    cornerRadius = dp(12).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(dp(46), dp(46)).apply { marginEnd = dp(16) }
            })
            row.addView(label(cat.title, 16.5f, 0xFF111814.toInt()).apply {
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            row.addView(label("›", 24f, 0xFF9CA3AF.toInt()))
            tabContentContainer.addView(row)
        }
    }

    /* ---------------- TAB 3: 🔍 SEARCH & PREFERENCES ---------------- */

    private fun renderSearchAndPrefsTab() {
        val wrap = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(8), dp(16), dp(28))
        }

        val searchCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
            background = GradientDrawable().apply {
                setColor(0xFFF9FAFB.toInt())
                cornerRadius = dp(20).toFloat()
                setStroke(dp(1), 0xFFE5E7EB.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(16) }
        }
        searchCard.addView(label("SEARCH GROCERY & USDA CATALOG", 11f, 0xFF2E9E5B.toInt(), bold = true).apply {
            letterSpacing = 0.08f
        })
        searchCard.addView(label("Search for any product", 20f, 0xFF111814.toInt(), bold = true).apply {
            setPadding(0, dp(4), 0, dp(2))
        })
        searchCard.addView(label("Start typing any food or brand — tap a live suggestion below to inspect it.", 13.5f, 0xFF4B5563.toInt()).apply {
            setPadding(0, 0, 0, dp(12))
        })

        val inputRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val searchInput = EditText(this).apply {
            hint = "e.g. Monster, Red Bull, Coke, C4, Milk, Water, Juice…"
            setText(lastSearchQuery)
            setSelection(lastSearchQuery.length)
            textSize = 14.5f
            setTextColor(0xFF111814.toInt())
            setHintTextColor(0xFF9CA3AF.toInt())
            setSingleLine(true)
            imeOptions = EditorInfo.IME_ACTION_SEARCH
            setPadding(dp(14), dp(11), dp(14), dp(11))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(999).toFloat()
                setStroke(dp(2), 0xFF2E9E5B.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginEnd = dp(8)
            }
            setOnEditorActionListener { v, actionId, event ->
                if (actionId == EditorInfo.IME_ACTION_SEARCH ||
                    (event != null && event.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN)
                ) {
                    val q = v.text.toString().trim()
                    if (q.isNotBlank()) performLiveProductSearch(q)
                    true
                } else false
            }
        }
        inputRow.addView(searchInput)
        inputRow.addView(label(if (isSearching) "…" else "🔍", 16f, Color.WHITE, bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(11), dp(16), dp(11))
            background = GradientDrawable().apply {
                setColor(0xFF2E9E5B.toInt())
                cornerRadius = dp(999).toFloat()
            }
            setOnClickListener {
                val q = searchInput.text.toString().trim()
                if (q.isNotBlank()) performLiveProductSearch(q)
            }
        })
        searchCard.addView(inputRow)

        // GPS-Style Live Autocomplete Dropdown Container right below the search input
        val suggestionsBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(16).toFloat()
                setStroke(dp(1), 0xFFD1D5DB.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(10) }
        }
        searchCard.addView(suggestionsBox)
        attachLiveAutocomplete(searchInput, suggestionsBox) { pickedTitle, fullItem ->
            lastSearchQuery = pickedTitle
            if (fullItem != null) {
                ScanHistoryStore.recordScan(this, fullItem, "search")
                renderScreen()
                showProductDetailDialog(fullItem)
            } else {
                performLiveProductSearch(pickedTitle)
            }
        }

        wrap.addView(searchCard)

        // Feature & Preferences Accordion Card (Live Store Bubble + Food preferences)
        val accordionCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(20).toFloat()
                setStroke(dp(1), 0xFFD1D5DB.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(16) }
        }

        // Row 1: Live Store Bubble Setup (with custom Broc mascot icon)
        accordionCard.addView(buildYukaAccordionRow(
            key = "bubble",
            icon = "MASCOT",
            title = "Live Store Bubble",
            subtitle = "Auto-grade foods in Walmart, Target, Kroger, Shipt, DoorDash, Costco, Sam's Club, BJ's, Amazon Fresh, Instacart, ALDI & more."
        ) {
            val inner = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(16), 0, dp(16), dp(16))
            }
            appendBubbleSetupAndWatchlistCards(inner, includeWatchlist = false)
            inner
        })

        accordionCard.addView(View(this).apply {
            setBackgroundColor(0xFFE5E7EB.toInt())
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
        })

        // Row 2: Allergies & Diabetes Alerts (Opt-in pill overlay warnings)
        accordionCard.addView(buildYukaAccordionRow(
            key = "allergies",
            icon = "🛡️",
            title = "Allergies & Diabetes Alerts",
            subtitle = "Check Dairy, Wheat/Gluten, Sugar/Diabetes, Soy, Peanuts/Nuts, Egg, Shellfish, or High Sodium to get instant warnings right on the floating pill overlay."
        ) {
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(16), 0, dp(16), dp(16))
                addView(dietaryWatchlistControls())
            }
        })

        accordionCard.addView(View(this).apply {
            setBackgroundColor(0xFFE5E7EB.toInt())
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
        })

        // Row 3: Food preferences (Family Watchlist)
        accordionCard.addView(buildYukaAccordionRow(
            key = "prefs",
            icon = "🎚️",
            title = "Food preferences",
            subtitle = "Detect & double-penalize seed oils, Red 40, HFCS, MSG, and synthetic preservatives."
        ) {
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(16), 0, dp(16), dp(16))
                addView(watchlistControls())
            }
        })

        wrap.addView(accordionCard)

        // Privacy Policy, Terms of Service, and Manage / Cancel Subscription links at bottom
        wrap.addView(label("Manage / Cancel Subscription ↗", 13f, 0xFF0F7A4A.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(6))
            setOnClickListener { openManageSubscription() }
        })

        wrap.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(0, dp(4), 0, dp(12))
            addView(label("Terms of Service ↗", 13f, 0xFF6B7280.toInt(), bold = true).apply {
                setOnClickListener {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.heybroc.com/terms")))
                }
            })
            addView(label("   ·   ", 13f, 0xFF6B7280.toInt()))
            addView(label("Privacy Policy & Data Disclosure ↗", 13f, 0xFF6B7280.toInt(), bold = true).apply {
                setOnClickListener {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.heybroc.com/privacy")))
                }
            })
        })

        wrap.addView(
            label(
                "Independent Opinion & Non-Affiliation Notice: HeyBroc 0–100 scores represent subjective clean-label opinions for informational grocery comparison only and are not medical or regulatory advice. Formulations vary by region and lot; always verify physical package labels. Retail swap links marked 'paid link' may earn an affiliate commission. HeyBroc is not affiliated with, endorsed by, or sponsored by Walmart, Target, Instacart, Costco, Sam's Club, BJ's, ALDI, Kroger, Amazon, Whole Foods, DoorDash, Uber Eats, Shipt, or any food/beverage manufacturer.",
                11f,
                0xFF6B7280.toInt()
            ).apply {
                setPadding(dp(18), dp(14), dp(18), dp(10))
            }
        )

        tabContentContainer.addView(wrap)
    }

    private fun openManageSubscription() {
        Toast.makeText(this, "Opening subscription management…", Toast.LENGTH_SHORT).show()
        io.execute {
            val portalUrl = ScanApi.billingPortalUrl(this@MainActivity)
            mainHandler.post {
                if (isDestroyed || isFinishing) return@post
                val targetUrl = portalUrl ?: "https://www.heybroc.com/?login=1"
                runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(targetUrl)))
                }
            }
        }
    }

    private fun buildYukaAccordionRow(
        key: String,
        icon: String,
        title: String,
        subtitle: String,
        expandedBuilder: () -> View
    ): View {
        val isOpen = expandedPrefSection == key
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(18))
            setOnClickListener {
                expandedPrefSection = if (isOpen) null else key
                renderScreen()
            }
        }
        if (icon == "MASCOT") {
            header.addView(FrameLayout(this).apply {
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(0xFFE8F5EC.toInt())
                }
                layoutParams = LinearLayout.LayoutParams(dp(46), dp(46)).apply { marginEnd = dp(16) }
                addView(ImageView(context).apply {
                    setImageResource(R.drawable.broc_mascot)
                    scaleType = ImageView.ScaleType.FIT_CENTER
                    layoutParams = FrameLayout.LayoutParams(dp(30), dp(30), Gravity.CENTER)
                })
            })
        } else {
            header.addView(label(icon, 18f, 0xFF2E9E5B.toInt()).apply {
                gravity = Gravity.CENTER
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(0xFFE8F5EC.toInt())
                }
                layoutParams = LinearLayout.LayoutParams(dp(46), dp(46)).apply { marginEnd = dp(16) }
            })
        }
        header.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginEnd = dp(8)
            }
            addView(label(title, 16.5f, 0xFF111814.toInt(), bold = true))
            addView(label(subtitle, 13.5f, 0xFF4B5563.toInt()).apply {
                setPadding(0, dp(3), 0, 0)
            })
        })
        header.addView(label(if (isOpen) "▴" else "▾", 18f, 0xFF374151.toInt(), bold = true))
        container.addView(header)

        if (isOpen) {
            container.addView(expandedBuilder())
        }
        return container
    }

    private fun appendBubbleSetupAndWatchlistCards(target: LinearLayout, includeWatchlist: Boolean = false) {
        val a11yServiceEnabled = isAccessibilityEnabled()
        val consentOk = AccessibilityConsent.granted(this)
        val a11yOk = a11yServiceEnabled && consentOk

        if (a11yOk) {
            hideFloatingSetupHelper()
            val statusBadge = label("✓ ACTIVE & READY", 12f, 0xFF16A34A.toInt(), bold = true)
            target.addView(stepCard(
                "Store Bubble Active",
                "HeyBroc Floats Over Your Grocery Apps",
                "Open Walmart, Target, Kroger, Shipt, DoorDash, Costco, Sam's Club, BJ's, Amazon Fresh, Whole Foods, Instacart, ALDI & more — the score bubble pops up automatically when you view food items.",
                statusBadge,
                primaryButton("Preview Score Bubble Here") { launchTestPill() },
                primaryButton("Hide Preview Bubble", filled = false) {
                    startService(Intent(this, OverlayWindowService::class.java).setAction(OverlayWindowService.ACTION_HIDE))
                },
                primaryButton("Pause / Turn Off Store Bubble", filled = false) {
                    AccessibilityConsent.revoke(this)
                    runCatching {
                        startService(Intent(this, OverlayWindowService::class.java).setAction(OverlayWindowService.ACTION_HIDE))
                    }
                    renderScreen()
                    Toast.makeText(this, "HeyBroc bubble paused.", Toast.LENGTH_LONG).show()
                },
            ))
        } else {
            val statusBadge = label("0 of 1 enabled", 12f, 0xFF7A5B00.toInt(), bold = true)
            val subStep = getSetupSubStep()

            val checklist = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(12), dp(14), dp(12))
                background = GradientDrawable().apply {
                    setColor(0xFFF4F3EE.toInt())
                    cornerRadius = dp(14).toFloat()
                }
                addView(label(
                    when {
                        a11yOk -> "✓  1. Store Screen Reader & Floating Bubble (Enabled)"
                        a11yServiceEnabled && !consentOk -> "○  1. Confirm in-app disclosure (1 tap)"
                        else -> "○  1. Turn ON HeyBroc in Accessibility → Installed apps"
                    },
                    13.5f,
                    if (a11yOk) 0xFF16A34A.toInt() else 0xFF15201B.toInt(),
                    bold = !a11yOk
                ))
            }

            val mainActionLabel = when {
                a11yServiceEnabled && !consentOk -> "⚡ Confirm & Activate HeyBroc"
                isInstalledFromPlayStore() -> "⚡ Turn ON HeyBroc in Accessibility →"
                subStep == "2B" -> "⚡ Step 2: Open App Info (Tap ⋮ Top-Right 3 Dots) →"
                subStep == "2C" -> "⚡ Step 3: Open Accessibility & Turn ON HeyBroc →"
                else -> "⚡ Step 1: Open Accessibility → Installed apps →"
            }

            val extras = mutableListOf<View>(
                checklist,
                primaryButton(mainActionLabel) { runGuidedSetupStep() }
            )

            if (!a11yServiceEnabled && !isInstalledFromPlayStore()) {
                extras.add(
                    label(
                        "Why don't the ⋮ (3 dots) show up in App Info right away?\n" +
                            "• Step 1 (Required first): Open Accessibility → Installed apps and tap the greyed-out \"HeyBroc\" once. Android hides the ⋮ 3-dot menu in App Info until you tap the greyed-out HeyBroc first!\n" +
                            "• Step 2: Only AFTER tapping the greyed-out HeyBroc, open App Info below → tap ⋮ (top-right 3 dots) → \"Allow restricted settings\".\n" +
                            "• Step 3: Go back to Accessibility → Installed apps → HeyBroc and flip it ON.",
                        12.5f, 0xFF7A5B00.toInt(),
                    ).apply {
                        setPadding(dp(12), dp(10), dp(12), dp(10))
                        background = GradientDrawable().apply { setColor(0xFFFDF6DC.toInt()); cornerRadius = dp(12).toFloat() }
                    }
                )
                extras.add(
                    primaryButton("Step 2: Open App Info (Tap ⋮ Top-Right 3 Dots)", filled = false) {
                        setSetupSubStep("2C")
                        scheduleSettingsToasts(
                            "Look at top-right ↑ Tap ⋮ (3 dots) → Allow restricted settings!",
                            "After tapping 'Allow restricted settings', press Back to return to HeyBroc!"
                        )
                        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                    }
                )
            }

            target.addView(stepCard(
                "Quick 1-Switch Setup",
                "Enable Store Bubble & Screen Reader",
                if (isInstalledFromPlayStore()) {
                    "Tap below to open Accessibility → Installed apps → turn HeyBroc ON."
                } else {
                    "Follow Steps 1 → 2 → 3 below to unlock and turn on HeyBroc in Accessibility."
                },
                statusBadge,
                *extras.toTypedArray(),
            ))
        }

        if (includeWatchlist) {
            target.addView(stepCard(
                "Food Preferences", "Family Watchlist (2x Penalty)",
                "Double the deduction for additive categories your household avoids most.",
                null,
                watchlistControls(),
            ))
        }
    }

    /* ---------------- Quick Scan Modal & Product Detail Sheet ---------------- */

    private fun showQuickScanModal() {
        var modalDialog: AlertDialog? = null
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(12))
        }
        box.addView(label("Instant Food & Brand Scanner", 18f, 0xFF111814.toInt(), bold = true))
        box.addView(label("Start typing any food or brand — tap a suggestion below or press Scan.", 13.5f, 0xFF4B5563.toInt()).apply {
            setPadding(0, dp(4), 0, dp(12))
        })
        val input = EditText(this).apply {
            hint = "e.g. Monster, Red Bull, Coke, C4, Milk, Water, Juice…"
            textSize = 15f
            setSingleLine(true)
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = GradientDrawable().apply {
                setColor(0xFFF3F4F6.toInt())
                cornerRadius = dp(14).toFloat()
                setStroke(dp(1), 0xFF2E9E5B.toInt())
            }
        }
        box.addView(input)

        val modalSuggestions = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(14).toFloat()
                setStroke(dp(1), 0xFFD1D5DB.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) }
        }
        box.addView(modalSuggestions)

        attachLiveAutocomplete(input, modalSuggestions) { pickedTitle, fullItem ->
            modalDialog?.dismiss()
            if (fullItem != null) {
                ScanHistoryStore.recordScan(this, fullItem, "search")
                renderScreen()
                showProductDetailDialog(fullItem)
            } else {
                performLiveProductSearch(pickedTitle)
            }
        }

        modalDialog = AlertDialog.Builder(this)
            .setView(box)
            .setPositiveButton("Scan Product") { _, _ ->
                val q = input.text.toString().trim()
                if (q.isNotBlank()) performLiveProductSearch(q)
            }
            .setNeutralButton("Open Walmart App ↗") { _, _ ->
                openWalmartSearch("")
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showTopRightMenuDialog() {
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val savedEmail = prefs.getString("auth_email", null)
        val authOption = if (!savedEmail.isNullOrBlank()) {
            "👤 Account & Cloud Sync ($savedEmail)"
        } else {
            "👤 Log in / Sign up (Email)"
        }
        val options = arrayOf(
            authOption,
            "🎯 Clean-Eating Goals & Onboarding",
            "💳 Manage / Cancel Subscription",
            "🛡️ Allergies & Diabetes Alerts",
            "Manage Live Store Bubble",
            "Food Preferences (Family Watchlist)",
            "★ View Saved Favorites",
            "🗑️ Clear Scan History",
            "📄 Terms of Service",
            "🔒 Privacy Policy & Data Disclosure"
        )
        AlertDialog.Builder(this)
            .setTitle("HeyBroc Menu")
            .setItems(options) { _, which ->
                when (which) {
                    0 -> showGoCoCoLoginDialog()
                    1 -> showOnboardingFunnelDialog()
                    2 -> openManageSubscription()
                    3 -> showAllergyAndDietModal()
                    4 -> { activeTab = 1; topSubTab = "Bubble"; renderScreen() }
                    5 -> { activeTab = 3; expandedPrefSection = "prefs"; renderScreen() }
                    6 -> { activeTab = 0; historyFavoritesOnly = true; renderScreen() }
                    7 -> { ScanHistoryStore.clearHistory(this); renderScreen() }
                    8 -> startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.heybroc.com/terms")))
                    9 -> startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.heybroc.com/privacy")))
                }
            }
            .show()
    }

    private fun showOnboardingFunnelDialog() {
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val alreadyDone = prefs.getBoolean("onboarding_funnel_done_v1", false)
        val seedOilsCurrentlyOn = ScanApi.isSeedOilsEnabled(this)
        val initialSet = prefs.getStringSet("familyWatchlist", null)
        val selectedGoals = (initialSet?.map { if (it == "nitrites") "nitrates" else it }?.toMutableSet()
            ?: mutableSetOf("seedOils", "dyes", "hfcs")).apply {
            if (!seedOilsCurrentlyOn) remove("seedOils")
        }
        val selectedDietary = prefs.getStringSet("dietaryWatchlist", null)?.toMutableSet() ?: mutableSetOf()
        var selectedHousehold = prefs.getString("householdProfile", "kids_family") ?: "kids_family"
        var selectedPrimaryGoal = prefs.getString("primaryGoal", "seed_oil_free") ?: "seed_oil_free"
        var selectedStore = prefs.getString("preferredStore", "walmart") ?: "walmart"
        var activeSampleIdx = 0

        data class HouseholdOpt(
            val id: String,
            val icon: String,
            val title: String,
            val subtitle: String,
            val recCats: List<String>
        )

        val householdOptions = listOf(
            HouseholdOpt("kids_family", "👨‍👩‍👧‍👦", "My Kids & Family", "Keep Red 40, seed oils & hidden syrups out of family meals", listOf("seedOils", "dyes", "hfcs", "nitrates")),
            HouseholdOpt("partner", "💑", "Me & My Partner", "Upgrade our shared grocery cart to clean whole-food staples", listOf("seedOils", "hfcs", "preservatives")),
            HouseholdOpt("myself", "🏃", "Just Myself", "Hit my personal clean-eating, fitness & ingredient goals", listOf("seedOils", "hfcs", "sweeteners")),
            HouseholdOpt("sensitivity", "🛡️", "Managing Food Sensitivities", "Strict ingredient, additive & allergen screening on every label", listOf("seedOils", "dyes", "hfcs", "preservatives", "sweeteners"))
        )

        data class PrimaryGoalOpt(
            val id: String,
            val icon: String,
            val title: String,
            val subtitle: String,
            val boostCats: List<String>
        )

        val primaryGoalOptions = listOf(
            PrimaryGoalOpt("seed_oil_free", "🌻", "Eliminate Industrial Seed Oils", "Swap soybean, canola & corn oil for 100% avocado, olive & grass-fed butter", listOf("seedOils")),
            PrimaryGoalOpt("kids_dye_free", "🧪", "Protect Against Red 40 & Dyes", "Spot petroleum-derived synthetic dyes disguised in snacks, cereals & drinks", listOf("dyes")),
            PrimaryGoalOpt("whole_foods", "🥑", "Cut Ultra-Processed Additives & HFCS", "Ditch high-fructose corn syrup, curing nitrates & harsh BHA/BHT preservatives", listOf("hfcs", "nitrates", "preservatives")),
            PrimaryGoalOpt("clean_swaps", "⇄", "Save Time with 1-Tap Clean Swaps", "Stop reading 40-ingredient labels — get instant 90–100/100 store replacements", listOf("seedOils", "dyes", "hfcs"))
        )

        val storeOptions = listOf(
            Triple("walmart", "🏬 Walmart", "Pickup, Delivery & In-Store"),
            Triple("target", "🎯 Target", "Drive Up & Same-Day"),
            Triple("costco", "🏷️ Costco", "Warehouse & Bulk Picks"),
            Triple("sams", "💎 Sam's Club", "Club Pickup & Scan & Go"),
            Triple("aldi", "🏪 ALDI", "Simply Nature & Aisle Swaps"),
            Triple("kroger", "🛒 Kroger", "Simple Truth & Pickup"),
            Triple("instacart", "🥕 Instacart", "All Local Supermarkets"),
            Triple("amazon", "📦 Amazon / Whole Foods", "365 & Prime Delivery")
        )

        data class GoalOption(
            val id: String,
            val icon: String,
            val title: String,
            val subtitle: String,
            val problemNote: String
        )

        val goalOptions = listOf(
            GoalOption(
                id = "seedOils",
                icon = "🌻",
                title = "Industrial Seed Oils",
                subtitle = "Soybean, canola, corn, cottonseed & sunflower oil",
                problemNote = "Hidden in 70%+ of 'Natural' dressings, chips, crackers & oat milks"
            ),
            GoalOption(
                id = "dyes",
                icon = "🧪",
                title = "Red 40 & Artificial Dyes",
                subtitle = "Red 40, Yellow 5 & 6, Blue 1, Titanium Dioxide",
                problemNote = "Disguised inside yogurts, fruit snacks, cereals & sports drinks"
            ),
            GoalOption(
                id = "hfcs",
                icon = "🌽",
                title = "High-Fructose Corn Syrup",
                subtitle = "HFCS, corn syrup solids & hidden refined syrups",
                problemNote = "Slipped into breads, ketchup, barbecue sauces & family staples"
            ),
            GoalOption(
                id = "nitrates",
                icon = "🥓",
                title = "Nitrites & Curing Nitrates",
                subtitle = "Sodium nitrite/nitrate in bacon, deli meat & hot dogs",
                problemNote = "Found in conventional lunch meats, sausage & cured deli turkey"
            ),
            GoalOption(
                id = "sweeteners",
                icon = "🥤",
                title = "Artificial Sweeteners",
                subtitle = "Sucralose, aspartame, acesulfame K & saccharin",
                problemNote = "Used in 'Zero Sugar' sodas, protein shakes & light yogurts"
            ),
            GoalOption(
                id = "preservatives",
                icon = "🛡️",
                title = "BHA, BHT & Harsh Preservatives",
                subtitle = "TBHQ, BHA/BHT, potassium bromate & propylparaben",
                problemNote = "Added to extend shelf life in cereals, tortillas & frozen meals"
            )
        )

        val dietaryOptions = listOf(
            Triple("sugar_diabetes", "🩸 Added Sugar & Syrup Watch", "Flags added cane sugar, corn syrups, >=10g sugar/100g & refined starches"),
            Triple("dairy", "🥛 Dairy & Lactose Guard", "Flags milk, cream, butter, whey, casein, lactose, cheese & yogurt"),
            Triple("wheat_gluten", "🌾 Wheat & Gluten Guard", "Flags wheat, enriched flour, barley, malt, rye, spelt & semolina"),
            Triple("peanuts_nuts", "🥜 Peanut & Tree Nut Guard", "Flags peanuts, almonds, cashews, walnuts, pecans & pistachios"),
            Triple("soy", "🫘 Soy Guard", "Flags soy protein, soy lecithin, soybean oil, tofu & edamame"),
            Triple("egg", "🥚 Egg Guard", "Flags whole egg, egg whites/yolks, albumin & mayonnaise"),
            Triple("shellfish_fish", "🐟 Shellfish & Fish Guard", "Flags shrimp, crab, lobster, clams, anchovies, salmon, tuna & cod"),
            Triple("high_sodium", "🧂 High Sodium Watch", "Flags >=400mg sodium/100g, MSG, sodium phosphate & added brine")
        )

        data class MiniTestSample(
            val label: String,
            val dirtyTitle: String,
            val dirtyScore: Int,
            val dirtyFlags: String,
            val cleanTitle: String,
            val cleanScore: Int,
            val cleanPerks: String
        )

        val miniTestSamples = listOf(
            MiniTestSample(
                label = "🍓 Yogurt",
                dirtyTitle = "Berry Swirl Lowfat Yogurt",
                dirtyScore = 22,
                dirtyFlags = "Flagged (2x): Red 40, High-Fructose Corn Syrup & Potassium Sorbate",
                cleanTitle = "Organic Whole Milk Berry Yogurt",
                cleanScore = 94,
                cleanPerks = "Organic milk & real strawberries — 0 synthetic dyes, 0 corn syrup"
            ),
            MiniTestSample(
                label = "🥗 Ranch",
                dirtyTitle = "\"Homestyle\" Creamy Ranch Dressing",
                dirtyScore = 18,
                dirtyFlags = "Flagged (2x): Soybean Oil (#1 ingredient), MSG, EDTA & Polysorbate 60",
                cleanTitle = "100% Avocado Oil Ranch Dressing",
                cleanScore = 92,
                cleanPerks = "Made with 100% pure avocado oil & organic herbs — 0 seed oils, 0 EDTA"
            ),
            MiniTestSample(
                label = "🧀 Crackers",
                dirtyTitle = "Baked Cheddar Snack Crackers",
                dirtyScore = 24,
                dirtyFlags = "Flagged (2x): Soybean & Canola Oil, TBHQ Preservative & Yellow 6",
                cleanTitle = "Organic Grass-Fed Cheddar Crackers",
                cleanScore = 95,
                cleanPerks = "Organic wheat & grass-fed cheddar — 0 seed oils, 0 TBHQ, 0 artificial dyes"
            )
        )

        var funnelDialog: AlertDialog? = null
        var currentStep = 1
        var lastTrackedStep = 0

        val scroll = ScrollView(this)
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(18), dp(20), dp(18))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(26).toFloat()
            }
        }
        scroll.addView(card)

        fun buildAnalyticsProps(extraAction: String? = null): JSONObject = JSONObject().apply {
            put("step", currentStep)
            put("isReturningUser", alreadyDone)
            put("householdProfile", selectedHousehold)
            put("primaryGoal", selectedPrimaryGoal)
            put("store", selectedStore)
            put("watchlistCount", selectedGoals.size)
            put("dietaryCount", selectedDietary.size)
            if (extraAction != null) put("exitAction", extraAction)
        }

        fun saveWatchlistAndMarkDone() {
            val toSave = selectedGoals.toMutableSet()
            prefs.edit()
                .putStringSet("familyWatchlist", toSave)
                .putStringSet("dietaryWatchlist", selectedDietary.toMutableSet())
                .putString("householdProfile", selectedHousehold)
                .putString("primaryGoal", selectedPrimaryGoal)
                .putString("preferredStore", selectedStore)
                .putBoolean("onboarding_funnel_done_v1", true)
                .apply()
            if ("seedOils" in toSave) {
                ScanApi.setSeedOilsEnabled(this@MainActivity, true)
            }
            runCatching {
                startService(
                    Intent(this@MainActivity, OverlayWindowService::class.java).apply {
                        action = OverlayWindowService.ACTION_REFRESH_PILL
                    }
                )
            }
            renderScreen()
        }

        fun storeDisplayNameForKey(key: String): String = when (key) {
            "target" -> "Target"
            "costco" -> "Costco"
            "sams" -> "Sam's Club"
            "bjs" -> "BJ's Wholesale"
            "aldi" -> "ALDI"
            "kroger" -> "Kroger"
            "instacart" -> "Instacart"
            "amazon" -> "Amazon / Whole Foods"
            "wholefoods" -> "Whole Foods Market"
            "doordash" -> "DoorDash"
            "ubereats" -> "Uber Eats"
            "shipt" -> "Shipt"
            else -> "Walmart"
        }

        fun renderFunnelStep(step: Int) {
            currentStep = step
            if (lastTrackedStep != step) {
                lastTrackedStep = step
                ScanApi.trackEvent(this@MainActivity, "onboarding_step_viewed", buildAnalyticsProps())
            }
            card.removeAllViews()
            scroll.post { scroll.scrollTo(0, 0) }

            // Top Row: Back button + weighted Step badge + Close / Skip button (320dp–360dp safe)
            val headerRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, 0, 0, dp(10))
            }
            if (step > 1) {
                headerRow.addView(label("← Back", 12f, 0xFF374151.toInt(), bold = true).apply {
                    setSingleLine(true)
                    setPadding(dp(9), dp(5), dp(9), dp(5))
                    background = GradientDrawable().apply {
                        setColor(0xFFF3F4F6.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { marginEnd = dp(6) }
                    contentDescription = "Back to step ${step - 1}"
                    setOnClickListener { renderFunnelStep(step - 1) }
                })
            }

            val stepLabelText = when (step) {
                1 -> "🥦 STEP 1 OF 8 · HOUSEHOLD"
                2 -> "🥦 STEP 2 OF 8 · #1 PRIORITY"
                3 -> "🥦 STEP 3 OF 8 · YOUR STORE"
                4 -> "🥦 STEP 4 OF 8 · YOUR GOALS"
                5 -> "🥦 STEP 5 OF 8 · ALLERGY GUARD"
                6 -> "🥦 STEP 6 OF 8 · THE PROBLEM"
                7 -> "🥦 STEP 7 OF 8 · HOW BROC WORKS"
                else -> "🥦 STEP 8 OF 8 · YOUR PLAN"
            }
            val badgeWrap = FrameLayout(this).apply {
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    marginEnd = dp(6)
                }
            }
            badgeWrap.addView(label(stepLabelText, 10.5f, 0xFF0B5E39.toInt(), bold = true).apply {
                setSingleLine(true)
                ellipsize = TextUtils.TruncateAt.END
                setPadding(dp(10), dp(5), dp(10), dp(5))
                background = GradientDrawable().apply {
                    setColor(0xFFE6F5EC.toInt())
                    cornerRadius = dp(999).toFloat()
                }
                layoutParams = FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.START or Gravity.CENTER_VERTICAL
                )
            })
            headerRow.addView(badgeWrap)

            val dismissLabel = if (alreadyDone) "✕ Close" else "Skip →"
            headerRow.addView(label(dismissLabel, 12f, 0xFF4B5563.toInt(), bold = true).apply {
                setSingleLine(true)
                setPadding(dp(10), dp(5), dp(10), dp(5))
                background = GradientDrawable().apply {
                    setColor(0xFFF3F4F6.toInt())
                    cornerRadius = dp(999).toFloat()
                }
                contentDescription = if (alreadyDone) "Close watchlist calibration without saving" else "Skip onboarding and continue with Free Plan"
                setOnClickListener {
                    if (alreadyDone) {
                        ScanApi.trackEvent(this@MainActivity, "onboarding_dismissed", buildAnalyticsProps("close"))
                        funnelDialog?.dismiss()
                    } else {
                        ScanApi.trackEvent(this@MainActivity, "onboarding_completed", buildAnalyticsProps("skip"))
                        saveWatchlistAndMarkDone()
                        funnelDialog?.dismiss()
                    }
                }
            })
            card.addView(headerRow)

            // 8-Segment Progress Bar (tappable for returning users)
            val progressRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                contentDescription = "Onboarding progress: step $step of 8"
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(14) }
            }
            for (i in 1..8) {
                progressRow.addView(View(this).apply {
                    background = GradientDrawable().apply {
                        setColor(if (i <= step) 0xFF16A34A.toInt() else 0xFFE5E7EB.toInt())
                        cornerRadius = dp(99).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(0, dp(if (alreadyDone) 6 else 5), 1f).apply {
                        if (i < 8) marginEnd = dp(4)
                    }
                    if (alreadyDone) {
                        contentDescription = "Jump to step $i"
                        setOnClickListener { renderFunnelStep(i) }
                    }
                })
            }
            card.addView(progressRow)

            val storeDisplayName = storeDisplayNameForKey(selectedStore)
            val activeHouseholdTitle = householdOptions.find { it.id == selectedHousehold }?.title ?: "My Kids & Family"

            // Step 1: Household Profile
            if (step == 1) {
                card.addView(label("Who are you protecting with HeyBroc?", 21f, 0xFF111814.toInt(), bold = true))
                card.addView(label(
                    "We'll calibrate your 0–100 food grading strictness and 1-tap Clean Swaps for your household in 60 seconds:",
                    13.5f,
                    0xFF4B5563.toInt()
                ).apply { setPadding(0, dp(4), 0, dp(12)) })

                householdOptions.forEach { h ->
                    val optActive = selectedHousehold == h.id
                    val row = LinearLayout(this).apply {
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER_VERTICAL
                        setPadding(dp(12), dp(10), dp(12), dp(10))
                        isSelected = optActive
                        contentDescription = "${h.title}. ${h.subtitle}. ${if (optActive) "Selected" else "Not selected"}"
                        background = GradientDrawable().apply {
                            setColor(if (optActive) 0xFFF0FDF4.toInt() else Color.WHITE)
                            setStroke(dp(if (optActive) 2 else 1), if (optActive) 0xFF16A34A.toInt() else 0xFFE5E7EB.toInt())
                            cornerRadius = dp(14).toFloat()
                        }
                        layoutParams = LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT
                        ).apply { bottomMargin = dp(8) }
                        setOnClickListener {
                            selectedHousehold = h.id
                            selectedGoals.clear()
                            selectedGoals.addAll(h.recCats)
                            renderFunnelStep(1)
                        }
                    }
                    row.addView(label(h.icon, 20f, 0xFF111814.toInt()).apply { setPadding(0, 0, dp(10), 0) })
                    row.addView(LinearLayout(this).apply {
                        orientation = LinearLayout.VERTICAL
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                        addView(label(h.title, 14.5f, 0xFF111814.toInt(), bold = true))
                        addView(label(h.subtitle, 12f, 0xFF6B7280.toInt()))
                    })
                    row.addView(label(if (optActive) "✓" else "", 13f, Color.WHITE, bold = true).apply {
                        gravity = Gravity.CENTER
                        layoutParams = LinearLayout.LayoutParams(dp(24), dp(24))
                        background = GradientDrawable().apply {
                            shape = GradientDrawable.OVAL
                            setColor(if (optActive) 0xFF16A34A.toInt() else Color.WHITE)
                            setStroke(dp(2), if (optActive) 0xFF16A34A.toInt() else 0xFFD1D5DB.toInt())
                        }
                    })
                    card.addView(row)
                }

                card.addView(label("Continue →", 15f, Color.WHITE, bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(16), dp(14), dp(16), dp(14))
                    background = GradientDrawable().apply {
                        setColor(0xFF16A34A.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { topMargin = dp(8) }
                    setOnClickListener {
                        if (!alreadyDone && selectedGoals.isEmpty()) {
                            val h = householdOptions.find { it.id == selectedHousehold } ?: householdOptions.first()
                            selectedGoals.addAll(h.recCats)
                        }
                        renderFunnelStep(2)
                    }
                })
                return
            }

            // Step 2: #1 Clean-Eating Priority
            if (step == 2) {
                card.addView(label("What is your #1 clean-eating priority?", 21f, 0xFF111814.toInt(), bold = true))
                card.addView(label(
                    "Pick what matters most right now — we'll prioritize Clean Swaps that match this first:",
                    13.5f,
                    0xFF4B5563.toInt()
                ).apply { setPadding(0, dp(4), 0, dp(12)) })

                primaryGoalOptions.forEach { pg ->
                    val optActive = selectedPrimaryGoal == pg.id
                    val row = LinearLayout(this).apply {
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER_VERTICAL
                        setPadding(dp(12), dp(10), dp(12), dp(10))
                        isSelected = optActive
                        contentDescription = "${pg.title}. ${pg.subtitle}. ${if (optActive) "Selected" else "Not selected"}"
                        background = GradientDrawable().apply {
                            setColor(if (optActive) 0xFFF0FDF4.toInt() else Color.WHITE)
                            setStroke(dp(if (optActive) 2 else 1), if (optActive) 0xFF16A34A.toInt() else 0xFFE5E7EB.toInt())
                            cornerRadius = dp(14).toFloat()
                        }
                        layoutParams = LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT
                        ).apply { bottomMargin = dp(8) }
                        setOnClickListener {
                            selectedPrimaryGoal = pg.id
                            selectedGoals.addAll(pg.boostCats)
                            renderFunnelStep(2)
                        }
                    }
                    row.addView(label(pg.icon, 20f, 0xFF111814.toInt()).apply { setPadding(0, 0, dp(10), 0) })
                    row.addView(LinearLayout(this).apply {
                        orientation = LinearLayout.VERTICAL
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                        addView(label(pg.title, 14.5f, 0xFF111814.toInt(), bold = true))
                        addView(label(pg.subtitle, 12f, 0xFF6B7280.toInt()))
                    })
                    row.addView(label(if (optActive) "✓" else "", 13f, Color.WHITE, bold = true).apply {
                        gravity = Gravity.CENTER
                        layoutParams = LinearLayout.LayoutParams(dp(24), dp(24))
                        background = GradientDrawable().apply {
                            shape = GradientDrawable.OVAL
                            setColor(if (optActive) 0xFF16A34A.toInt() else Color.WHITE)
                            setStroke(dp(2), if (optActive) 0xFF16A34A.toInt() else 0xFFD1D5DB.toInt())
                        }
                    })
                    card.addView(row)
                }

                card.addView(label("Continue →", 15f, Color.WHITE, bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(16), dp(14), dp(16), dp(14))
                    background = GradientDrawable().apply {
                        setColor(0xFF16A34A.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { topMargin = dp(8) }
                    setOnClickListener {
                        if (!alreadyDone && selectedGoals.isEmpty()) {
                            val pg = primaryGoalOptions.find { it.id == selectedPrimaryGoal } ?: primaryGoalOptions.first()
                            selectedGoals.addAll(pg.boostCats)
                        }
                        renderFunnelStep(3)
                    }
                })
                return
            }

            // Step 3: Favorite Grocery Store
            if (step == 3) {
                card.addView(label("Where do you usually grocery shop?", 21f, 0xFF111814.toInt(), bold = true))
                card.addView(label(
                    "HeyBroc supports all 12+ grocery & delivery stores. Pick your main store so 1-tap Clean Swaps open directly in your store:",
                    13.5f,
                    0xFF4B5563.toInt()
                ).apply { setPadding(0, dp(4), 0, dp(12)) })

                storeOptions.forEach { (storeId, storeTitle, storeSub) ->
                    val optActive = selectedStore == storeId
                    val row = LinearLayout(this).apply {
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER_VERTICAL
                        setPadding(dp(12), dp(9), dp(12), dp(9))
                        isSelected = optActive
                        contentDescription = "$storeTitle. $storeSub. ${if (optActive) "Selected" else "Not selected"}"
                        background = GradientDrawable().apply {
                            setColor(if (optActive) 0xFFF0FDF4.toInt() else Color.WHITE)
                            setStroke(dp(if (optActive) 2 else 1), if (optActive) 0xFF16A34A.toInt() else 0xFFE5E7EB.toInt())
                            cornerRadius = dp(14).toFloat()
                        }
                        layoutParams = LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT
                        ).apply { bottomMargin = dp(7) }
                        setOnClickListener {
                            selectedStore = storeId
                            renderFunnelStep(3)
                        }
                    }
                    row.addView(LinearLayout(this).apply {
                        orientation = LinearLayout.VERTICAL
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                        addView(label(storeTitle, 14f, 0xFF111814.toInt(), bold = true))
                        addView(label(storeSub, 11.5f, 0xFF6B7280.toInt()))
                    })
                    row.addView(label(if (optActive) "✓" else "", 13f, Color.WHITE, bold = true).apply {
                        gravity = Gravity.CENTER
                        layoutParams = LinearLayout.LayoutParams(dp(24), dp(24))
                        background = GradientDrawable().apply {
                            shape = GradientDrawable.OVAL
                            setColor(if (optActive) 0xFF16A34A.toInt() else Color.WHITE)
                            setStroke(dp(2), if (optActive) 0xFF16A34A.toInt() else 0xFFD1D5DB.toInt())
                        }
                    })
                    card.addView(row)
                }

                card.addView(label("Continue with $storeDisplayName →", 15f, Color.WHITE, bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(16), dp(14), dp(16), dp(14))
                    background = GradientDrawable().apply {
                        setColor(0xFF16A34A.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { topMargin = dp(8) }
                    setOnClickListener { renderFunnelStep(4) }
                })
                return
            }

            // Step 4: 2x Watchlist Goals
            if (step == 4) {
                card.addView(label("What are your clean-eating goals?", 21f, 0xFF111814.toInt(), bold = true))
                card.addView(label(
                    "Tap the ingredients you want out of your kitchen. HeyBroc applies 2x strictness to your goals and finds 90–100/100 Clean Swaps at $storeDisplayName automatically.",
                    13.5f,
                    0xFF4B5563.toInt()
                ).apply { setPadding(0, dp(4), 0, dp(12)) })

                goalOptions.forEach { g ->
                    val optActive = g.id in selectedGoals
                    val row = LinearLayout(this).apply {
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER_VERTICAL
                        setPadding(dp(12), dp(10), dp(12), dp(10))
                        isSelected = optActive
                        contentDescription = "${g.title}. ${g.subtitle}. ${if (optActive) "2x penalty enabled" else "Off"}"
                        background = GradientDrawable().apply {
                            setColor(if (optActive) 0xFFF0FDF4.toInt() else Color.WHITE)
                            setStroke(dp(if (optActive) 2 else 1), if (optActive) 0xFF16A34A.toInt() else 0xFFE5E7EB.toInt())
                            cornerRadius = dp(14).toFloat()
                        }
                        layoutParams = LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT
                        ).apply { bottomMargin = dp(8) }
                        setOnClickListener {
                            if (g.id in selectedGoals) selectedGoals.remove(g.id) else selectedGoals.add(g.id)
                            renderFunnelStep(4)
                        }
                    }
                    row.addView(label(g.icon, 20f, 0xFF111814.toInt()).apply {
                        setPadding(0, 0, dp(10), 0)
                    })
                    row.addView(LinearLayout(this).apply {
                        orientation = LinearLayout.VERTICAL
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                        addView(label(g.title, 14.5f, 0xFF111814.toInt(), bold = true))
                        addView(label(g.subtitle, 12f, 0xFF6B7280.toInt()))
                    })
                    row.addView(label(if (optActive) "✓" else "", 13f, Color.WHITE, bold = true).apply {
                        gravity = Gravity.CENTER
                        layoutParams = LinearLayout.LayoutParams(dp(24), dp(24))
                        background = GradientDrawable().apply {
                            shape = GradientDrawable.OVAL
                            setColor(if (optActive) 0xFF16A34A.toInt() else Color.WHITE)
                            setStroke(dp(2), if (optActive) 0xFF16A34A.toInt() else 0xFFD1D5DB.toInt())
                        }
                    })
                    card.addView(row)
                }

                card.addView(label(
                    "Continue (${selectedGoals.size} ${if (selectedGoals.size == 1) "Goal" else "Goals"} Selected) →",
                    15f,
                    Color.WHITE,
                    bold = true
                ).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(16), dp(14), dp(16), dp(14))
                    background = GradientDrawable().apply {
                        setColor(0xFF16A34A.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { topMargin = dp(8) }
                    setOnClickListener { renderFunnelStep(5) }
                })
                return
            }

            // Step 5: Allergy & Dietary Guard
            if (step == 5) {
                card.addView(label("Any family allergies or dietary watches?", 21f, 0xFF111814.toInt(), bold = true))
                card.addView(label(
                    "Optional — check any boxes below and HeyBroc will display instant 🛡️ Allergy & Sugar badges on your floating store pill:",
                    13.5f,
                    0xFF4B5563.toInt()
                ).apply { setPadding(0, dp(4), 0, dp(12)) })

                dietaryOptions.forEach { (dietId, dietTitle, dietSub) ->
                    val optActive = dietId in selectedDietary
                    val row = LinearLayout(this).apply {
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER_VERTICAL
                        setPadding(dp(12), dp(9), dp(12), dp(9))
                        isSelected = optActive
                        contentDescription = "$dietTitle. $dietSub. ${if (optActive) "Alert enabled" else "Off"}"
                        background = GradientDrawable().apply {
                            setColor(if (optActive) 0xFFF0FDF4.toInt() else Color.WHITE)
                            setStroke(dp(if (optActive) 2 else 1), if (optActive) 0xFF16A34A.toInt() else 0xFFE5E7EB.toInt())
                            cornerRadius = dp(14).toFloat()
                        }
                        layoutParams = LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT
                        ).apply { bottomMargin = dp(7) }
                        setOnClickListener {
                            if (dietId in selectedDietary) selectedDietary.remove(dietId) else selectedDietary.add(dietId)
                            renderFunnelStep(5)
                        }
                    }
                    row.addView(LinearLayout(this).apply {
                        orientation = LinearLayout.VERTICAL
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                        addView(label(dietTitle, 14f, 0xFF111814.toInt(), bold = true))
                        addView(label(dietSub, 11.5f, 0xFF6B7280.toInt()))
                    })
                    row.addView(label(if (optActive) "✓" else "", 13f, Color.WHITE, bold = true).apply {
                        gravity = Gravity.CENTER
                        layoutParams = LinearLayout.LayoutParams(dp(24), dp(24))
                        background = GradientDrawable().apply {
                            shape = GradientDrawable.OVAL
                            setColor(if (optActive) 0xFF16A34A.toInt() else Color.WHITE)
                            setStroke(dp(2), if (optActive) 0xFF16A34A.toInt() else 0xFFD1D5DB.toInt())
                        }
                    })
                    card.addView(row)
                }

                val dietCta = if (selectedDietary.isNotEmpty()) {
                    "Save ${selectedDietary.size} ${if (selectedDietary.size == 1) "Alert" else "Alerts"} & Continue →"
                } else {
                    "No Allergies — Continue →"
                }
                card.addView(label(dietCta, 15f, Color.WHITE, bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(16), dp(14), dp(16), dp(14))
                    background = GradientDrawable().apply {
                        setColor(0xFF16A34A.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { topMargin = dp(8) }
                    setOnClickListener { renderFunnelStep(6) }
                })
                return
            }

            // Step 6: The Problem
            if (step == 6) {
                card.addView(label("Why \"Healthy-Looking\" Groceries Fail Your Goals", 20.5f, 0xFF111814.toInt(), bold = true))
                card.addView(label(
                    "Big food brands print \"Natural\" or \"Made with Real Fruit\" on the front at $storeDisplayName while hiding ultra-processed additives in tiny 6-point text on the back:",
                    13.5f,
                    0xFF4B5563.toInt()
                ).apply { setPadding(0, dp(4), 0, dp(12)) })

                val activeList = goalOptions.filter { it.id in selectedGoals }.ifEmpty { goalOptions.take(3) }
                val trapBox = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(14), dp(12), dp(14), dp(12))
                    background = GradientDrawable().apply {
                        setColor(0xFFFEF2F2.toInt())
                        setStroke(dp(1), 0xFFFECACA.toInt())
                        cornerRadius = dp(16).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { bottomMargin = dp(12) }
                }
                trapBox.addView(label("⚠️ HIDDEN IN EVERYDAY $storeDisplayName STAPLES ($activeHouseholdTitle):", 11f, 0xFF991B1B.toInt(), bold = true).apply {
                    setPadding(0, 0, 0, dp(6))
                })
                activeList.take(3).forEach { g ->
                    trapBox.addView(label("${g.icon} ${g.title}: ${g.problemNote}", 12.5f, 0xFF7F1D1D.toInt()).apply {
                        setPadding(0, dp(2), 0, dp(4))
                    })
                }
                card.addView(trapBox)

                // Before vs After Card
                val compareBox = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(14), dp(12), dp(14), dp(12))
                    background = GradientDrawable().apply {
                        setColor(0xFFF0FDF4.toInt())
                        setStroke(dp(1), 0xFF86EFAC.toInt())
                        cornerRadius = dp(16).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { bottomMargin = dp(14) }
                }
                compareBox.addView(label("✕ Typical \"Natural\" Store Pick: 18/100 (Poor)", 13f, 0xFF991B1B.toInt(), bold = true))
                compareBox.addView(label("Hides Soybean Oil, High-Fructose Corn Syrup & Red 40.", 12f, 0xFF7F1D1D.toInt()).apply {
                    setPadding(0, dp(2), 0, dp(8))
                })
                compareBox.addView(label("✓ 1-Tap $storeDisplayName Clean Swap: 95/100 (Excellent)", 13f, 0xFF14532D.toInt(), bold = true))
                compareBox.addView(label("100% Avocado/Olive Oil or Organic whole ingredients — 0 seed oils, 0 dyes.", 12f, 0xFF166534.toInt()))
                card.addView(compareBox)

                card.addView(label("See How HeyBroc Solves This →", 15f, Color.WHITE, bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(16), dp(14), dp(16), dp(14))
                    background = GradientDrawable().apply {
                        setColor(0xFF16A34A.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    setOnClickListener { renderFunnelStep(7) }
                })
                return
            }

            // Step 7: Interactive Mini-Test & How Broc Works
            if (step == 7) {
                card.addView(label("How HeyBroc Protects Your Cart in 1 Second", 20.5f, 0xFF111814.toInt(), bold = true))
                card.addView(label(
                    "Tap an everyday staple below to see how your 2x Watchlist grades it and swaps it at $storeDisplayName across 1.5M+ foods:",
                    13f,
                    0xFF4B5563.toInt()
                ).apply { setPadding(0, dp(4), 0, dp(10)) })

                val tabsRow = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { bottomMargin = dp(8) }
                }
                miniTestSamples.forEachIndexed { idx, sample ->
                    val active = activeSampleIdx == idx
                    tabsRow.addView(label(sample.label, 11.5f, if (active) 0xFF14532D.toInt() else 0xFF374151.toInt(), bold = true).apply {
                        gravity = Gravity.CENTER
                        setSingleLine(true)
                        ellipsize = TextUtils.TruncateAt.END
                        isSelected = active
                        contentDescription = "Test sample ${sample.label}"
                        setPadding(dp(6), dp(8), dp(6), dp(8))
                        background = GradientDrawable().apply {
                            setColor(if (active) 0xFFF0FDF4.toInt() else Color.WHITE)
                            setStroke(dp(if (active) 2 else 1), if (active) 0xFF16A34A.toInt() else 0xFFE5E7EB.toInt())
                            cornerRadius = dp(12).toFloat()
                        }
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                            if (idx < miniTestSamples.lastIndex) marginEnd = dp(6)
                        }
                        setOnClickListener {
                            activeSampleIdx = idx
                            renderFunnelStep(7)
                        }
                    })
                }
                card.addView(tabsRow)

                val sample = miniTestSamples[activeSampleIdx]
                val previewBox = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(12), dp(10), dp(12), dp(10))
                    background = GradientDrawable().apply {
                        setColor(0xFFF8FAFC.toInt())
                        setStroke(dp(1), 0xFFCBD5E1.toInt())
                        cornerRadius = dp(14).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { bottomMargin = dp(10) }
                }
                previewBox.addView(label("✕ ${sample.dirtyTitle} · ${sample.dirtyScore}/100 (Poor)", 12.5f, 0xFF991B1B.toInt(), bold = true))
                previewBox.addView(label(sample.dirtyFlags, 11.5f, 0xFF7F1D1D.toInt()).apply { setPadding(0, dp(2), 0, dp(6)) })
                previewBox.addView(label("⇄ ${sample.cleanTitle} ($storeDisplayName) · ${sample.cleanScore}/100", 12.5f, 0xFF14532D.toInt(), bold = true))
                previewBox.addView(label(sample.cleanPerks, 11.5f, 0xFF166534.toInt()).apply { setPadding(0, dp(2), 0, 0) })
                card.addView(previewBox)

                val pillars = listOf(
                    Triple("📷", "1. Instant 0–100 Barcode & Search Grading (Always Free)", "Scan any barcode in the aisle or search 1.5M+ foods for a transparent Yuka-grade breakdown with 2x strictness on your goals."),
                    Triple("🟢", "2. Live Store Bubble & Whole-Cart Check", "Floating score pill grades items automatically while you browse $storeDisplayName and checks your whole cart before checkout.")
                )
                pillars.forEach { (icon, title, desc) ->
                    card.addView(LinearLayout(this).apply {
                        orientation = LinearLayout.VERTICAL
                        setPadding(dp(14), dp(10), dp(14), dp(10))
                        background = GradientDrawable().apply {
                            setColor(0xFFF8FAFC.toInt())
                            setStroke(dp(1), 0xFFE2E8F0.toInt())
                            cornerRadius = dp(14).toFloat()
                        }
                        layoutParams = LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT
                        ).apply { bottomMargin = dp(8) }
                        addView(label("$icon  $title", 13f, 0xFF111814.toInt(), bold = true))
                        addView(label(desc, 11.5f, 0xFF4B5563.toInt()).apply { setPadding(0, dp(2), 0, 0) })
                    })
                }

                card.addView(label("Build My Personalized Plan →", 15f, Color.WHITE, bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(16), dp(14), dp(16), dp(14))
                    background = GradientDrawable().apply {
                        setColor(0xFF16A34A.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { topMargin = dp(4) }
                    setOnClickListener { renderFunnelStep(8) }
                })
                return
            }

            // Step 8: Personalized Plan (Start Free Pro Trial / Continue with Free Plan / Sign In)
            val refCode = ScanApi.referredByCode(this@MainActivity)
            val isFriendRef = refCode?.startsWith("BROC-", ignoreCase = true) == true
            val effectiveTrialDays = if (!refCode.isNullOrBlank() && !isFriendRef) 14 else 7
            val weeklyFreeSwaps = ScanApi.weeklySwapsLimit(this@MainActivity)

            val goalSuffix = if (selectedGoals.size == 1) "" else "s"
            val dietSuffix = if (selectedDietary.isNotEmpty()) {
                val ds = if (selectedDietary.size == 1) "" else "s"
                " · ${selectedDietary.size} Allergy/Diet alert$ds"
            } else {
                ""
            }
            card.addView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(12), dp(10), dp(12), dp(10))
                background = GradientDrawable().apply {
                    setColor(0xFFECFDF5.toInt())
                    setStroke(dp(1), 0xFF6EE7B7.toInt())
                    cornerRadius = dp(14).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(10) }
                addView(label(
                    "✅ Your Custom Profile Is Calibrated: $activeHouseholdTitle · $storeDisplayName · ${selectedGoals.size} 2x Watchlist goal$goalSuffix$dietSuffix.",
                    12.5f,
                    0xFF065F46.toInt(),
                    bold = true
                ))
            })

            if (!refCode.isNullOrBlank()) {
                card.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(12), dp(9), dp(12), dp(9))
                    background = GradientDrawable().apply {
                        setColor(0xFFFEFCE8.toInt())
                        setStroke(dp(1), 0xFFFDE047.toInt())
                        cornerRadius = dp(14).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { bottomMargin = dp(10) }
                    val refMsg = if (isFriendRef) {
                        "🎁 Friend Invite ($refCode) Applied: Start your trial to unlock +7 Free Pro Days for both of you!"
                    } else {
                        "🎉 Creator Code $refCode Applied: Unlocked your 14-Day Extended Free Pro Trial!"
                    }
                    addView(label(refMsg, 12f, 0xFF854D0E.toInt(), bold = true))
                })
            }

            card.addView(label("Choose How You Want to Start", 21f, 0xFF111814.toInt(), bold = true))
            card.addView(label(
                "Barcode & search grading is always 100% free. Unlock unlimited 1-tap $storeDisplayName Clean Swaps & Whole-Cart Checks with a $effectiveTrialDays-Day Free Pro Trial ($0 today), or start on the Free Plan:",
                13f,
                0xFF4B5563.toInt()
            ).apply { setPadding(0, dp(4), 0, dp(12)) })

            val proCard = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(12), dp(14), dp(12))
                background = GradientDrawable().apply {
                    setColor(0xFFF0FDF4.toInt())
                    setStroke(dp(2), 0xFF16A34A.toInt())
                    cornerRadius = dp(16).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(12) }
            }
            proCard.addView(label("⭐ HeyBroc Family Pro · $effectiveTrialDays DAYS FREE ($0 TODAY)", 13.5f, 0xFF14532D.toInt(), bold = true))
            proCard.addView(label(
                "• Unlimited 1-Tap Clean Swaps at $storeDisplayName & all 12+ stores\n• Whole-Cart Health Check & Swap-All Cart Cleaner\n• Unlimited Live Store Bubble & Family Cloud Sync",
                12.5f,
                0xFF166534.toInt()
            ).apply { setPadding(0, dp(6), 0, dp(6)) })
            proCard.addView(label(
                "$0 due today · Then $4.17/mo billed annually ($49.99/yr) or $9.99/mo. Cancel anytime in 1 tap before day $effectiveTrialDays.",
                11.5f,
                0xFF15803D.toInt()
            ))
            card.addView(proCard)

            // Primary CTA: Start Free Pro Trial
            card.addView(label("Start $effectiveTrialDays-Day Free Pro Trial ($0 Today) →", 15f, Color.WHITE, bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(16), dp(14), dp(16), dp(14))
                background = GradientDrawable().apply {
                    setColor(0xFF16A34A.toInt())
                    cornerRadius = dp(999).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(8) }
                setOnClickListener {
                    ScanApi.trackEvent(this@MainActivity, "onboarding_completed", buildAnalyticsProps("trial"))
                    saveWatchlistAndMarkDone()
                    funnelDialog?.dismiss()
                    ScanApi.trackEvent(this@MainActivity, "paywall_viewed")
                    ScanApi.trackEvent(this@MainActivity, "checkout_started")
                    runCatching {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ScanApi.upgradeUrl(this@MainActivity))))
                    }
                }
            })

            // Secondary CTA: Continue with Free Plan (Continue as guest)
            card.addView(label("Continue with Free Plan (Unlimited Scans + $weeklyFreeSwaps Swaps/Wk) →", 13.5f, 0xFF1F2937.toInt(), bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(14), dp(13), dp(14), dp(13))
                background = GradientDrawable().apply {
                    setColor(Color.WHITE)
                    setStroke(dp(2), 0xFFD1D5DB.toInt())
                    cornerRadius = dp(999).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(8) }
                setOnClickListener {
                    ScanApi.trackEvent(this@MainActivity, "onboarding_completed", buildAnalyticsProps("guest"))
                    saveWatchlistAndMarkDone()
                    funnelDialog?.dismiss()
                    Toast.makeText(
                        this@MainActivity,
                        "✓ Watchlist saved (${selectedGoals.size} goals active)! Scan any food free.",
                        Toast.LENGTH_SHORT
                    ).show()
                }
            })

            // Tertiary Link: Sign In & Sync Free Across Devices
            card.addView(label("Save Watchlist (${selectedGoals.size}) & Sign In / Sync Free Across Devices →", 12.5f, 0xFF0F7A4A.toInt(), bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(8), dp(8), dp(8), dp(4))
                setOnClickListener {
                    ScanApi.trackEvent(this@MainActivity, "onboarding_completed", buildAnalyticsProps("signin"))
                    saveWatchlistAndMarkDone()
                    funnelDialog?.dismiss()
                    showGoCoCoLoginDialog()
                }
            })
        }

        renderFunnelStep(1)

        funnelDialog = AlertDialog.Builder(this).setView(scroll).create().also { dlg ->
            dlg.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
            dlg.setOnKeyListener { _, keyCode, event ->
                if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
                    if (currentStep > 1) {
                        renderFunnelStep(currentStep - 1)
                        true
                    } else {
                        false
                    }
                } else {
                    false
                }
            }
            dlg.setOnCancelListener {
                ScanApi.trackEvent(this@MainActivity, "onboarding_dismissed", buildAnalyticsProps("cancel"))
                if (!alreadyDone) {
                    saveWatchlistAndMarkDone()
                }
            }
            dlg.show()
        }
    }

    private fun showGoCoCoLoginDialog() {
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val savedEmail = prefs.getString("auth_email", null)?.takeIf { it.isNotBlank() }
        val savedName = prefs.getString("auth_name", null)?.takeIf { it.isNotBlank() }
        val savedProvider = prefs.getString("auth_provider", "email") ?: "email"

        var authDialog: AlertDialog? = null

        val scroll = ScrollView(this)
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(22), dp(24), dp(22))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(28).toFloat()
            }
        }
        scroll.addView(card)

        // Top row: Broc mascot badge on left + subtle ✕ close button on right
        fun buildTopHeader(onBackOrClose: () -> Unit, showBackArrow: Boolean = false): LinearLayout {
            return LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, 0, 0, dp(12))

                if (showBackArrow) {
                    addView(label("← Back", 14f, 0xFF4B5563.toInt(), bold = true).apply {
                        setPadding(dp(12), dp(8), dp(12), dp(8))
                        background = GradientDrawable().apply {
                            setColor(0xFFF3F4F6.toInt())
                            cornerRadius = dp(999).toFloat()
                        }
                        setOnClickListener { onBackOrClose() }
                    })
                } else {
                    addView(LinearLayout(this@MainActivity).apply {
                        gravity = Gravity.CENTER
                        setPadding(dp(8), dp(8), dp(8), dp(8))
                        background = GradientDrawable().apply {
                            setColor(0xFFECFDF5.toInt())
                            setStroke(dp(1), 0xFFA7F3D0.toInt())
                            cornerRadius = dp(16).toFloat()
                        }
                        addView(ImageView(this@MainActivity).apply {
                            setImageResource(R.drawable.broc_mascot)
                            layoutParams = LinearLayout.LayoutParams(dp(38), dp(38))
                            scaleType = ImageView.ScaleType.FIT_CENTER
                        })
                    })
                }

                addView(View(this@MainActivity).apply {
                    layoutParams = LinearLayout.LayoutParams(0, dp(1), 1f)
                })

                addView(label("✕", 16f, 0xFF6B7280.toInt(), bold = true).apply {
                    gravity = Gravity.CENTER
                    layoutParams = LinearLayout.LayoutParams(dp(36), dp(36))
                    background = GradientDrawable().apply {
                        setColor(0xFFF3F4F6.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    setOnClickListener { authDialog?.dismiss() }
                })
            }
        }

        if (savedEmail != null) {
            // ================= LOGGED-IN ACCOUNT VIEW =================
            card.addView(buildTopHeader({ authDialog?.dismiss() }))
            card.addView(label("Your Account", 26f, 0xFF111814.toInt(), bold = true))
            card.addView(label(
                "Signed in and syncing your Watchlist, Favorites & Family Pro across devices.",
                14f,
                0xFF6B7280.toInt()
            ).apply { setPadding(0, dp(4), 0, dp(16)) })

            val profileCard = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(16), dp(14), dp(16), dp(14))
                background = GradientDrawable().apply {
                    setColor(0xFFF0FDF4.toInt())
                    setStroke(dp(1), 0xFFBBF7D0.toInt())
                    cornerRadius = dp(18).toFloat()
                }
            }
            profileCard.addView(label(savedName ?: savedEmail.substringBefore("@"), 16.5f, 0xFF0F172A.toInt(), bold = true))
            profileCard.addView(label(savedEmail, 13.5f, 0xFF475569.toInt()).apply { setPadding(0, dp(2), 0, dp(6)) })

            val providerRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val providerIconRes = when (savedProvider) {
                "google" -> R.drawable.ic_gmail_logo
                "apple" -> R.drawable.ic_apple_logo
                else -> R.drawable.ic_email_logo
            }
            if (savedProvider == "google") {
                providerRow.addView(ImageView(this).apply {
                    setImageResource(providerIconRes)
                    layoutParams = LinearLayout.LayoutParams(dp(18), dp(14)).apply { marginEnd = dp(8) }
                    scaleType = ImageView.ScaleType.FIT_CENTER
                })
            }
            val providerBadge = when (savedProvider) {
                "google" -> "Connected with Gmail"
                "apple" -> "✓ Connected with Apple"
                else -> "✓ Connected with Email"
            }
            providerRow.addView(label(providerBadge, 12.5f, 0xFF0F7A4A.toInt(), bold = true))
            profileCard.addView(providerRow)
            card.addView(profileCard)

            card.addView(label("Continue Shopping  →", 15.5f, Color.WHITE, bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(16), dp(15), dp(16), dp(15))
                background = GradientDrawable().apply {
                    setColor(0xFF16A34A.toInt())
                    cornerRadius = dp(999).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(18) }
                setOnClickListener { authDialog?.dismiss() }
            })

            card.addView(label("Manage / Cancel subscription ↗", 14.5f, 0xFF0F7A4A.toInt(), bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(16), dp(13), dp(16), dp(13))
                background = GradientDrawable().apply {
                    setColor(0xFFECFDF5.toInt())
                    setStroke(dp(1), 0xFFBBF7D0.toInt())
                    cornerRadius = dp(999).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(10) }
                setOnClickListener {
                    authDialog?.dismiss()
                    openManageSubscription()
                }
            })

            card.addView(label("Sign out", 14.5f, 0xFF374151.toInt(), bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(16), dp(13), dp(16), dp(13))
                background = GradientDrawable().apply {
                    setColor(0xFFF3F4F6.toInt())
                    cornerRadius = dp(999).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(10) }
                setOnClickListener {
                    prefs.edit()
                        .remove("auth_email")
                        .remove("auth_name")
                        .remove("auth_provider")
                        .remove("auth_token")
                        .apply()
                    authDialog?.dismiss()
                    renderScreen()
                    Toast.makeText(
                        this@MainActivity,
                        "Signed out. Continuing in Guest mode.",
                        Toast.LENGTH_SHORT
                    ).show()
                }
            })

            card.addView(label("Delete account & cloud data", 12.5f, 0xFFDC2626.toInt()).apply {
                gravity = Gravity.CENTER
                setPadding(dp(8), dp(14), dp(8), dp(2))
                setOnClickListener {
                    AlertDialog.Builder(this@MainActivity)
                        .setTitle("Delete HeyBroc Account?")
                        .setMessage("Permanently delete $savedEmail and cloud data? You can continue using HeyBroc as a Guest anytime.")
                        .setPositiveButton("Delete Account") { _, _ ->
                            val tok = prefs.getString("auth_token", "") ?: ""
                            io.execute {
                                val deleted = runCatching {
                                    val conn = (URL("https://www.heybroc.com/api/auth").openConnection() as HttpURLConnection).apply {
                                        requestMethod = "POST"
                                        doOutput = true
                                        setRequestProperty("Content-Type", "application/json")
                                        if (tok.isNotBlank()) setRequestProperty("Authorization", "Bearer $tok")
                                        connectTimeout = 6000
                                        readTimeout = 6000
                                    }
                                    try {
                                        val payload = JSONObject()
                                            .put("action", "delete_account")
                                            .put("email", savedEmail)
                                            .put("token", tok)
                                            .toString()
                                        conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                                        val ok = conn.responseCode in 200..299
                                        val stream = if (ok) conn.inputStream else conn.errorStream
                                        val result = stream?.bufferedReader()?.use { JSONObject(it.readText()) }
                                        ok && result?.optBoolean("ok") == true
                                    } finally {
                                        conn.disconnect()
                                    }
                                }.getOrDefault(false)
                                mainHandler.post {
                                    if (isDestroyed || isFinishing) return@post
                                    if (deleted) {
                                        prefs.edit()
                                            .remove("auth_email")
                                            .remove("auth_name")
                                            .remove("auth_provider")
                                            .remove("auth_token")
                                            .apply()
                                        ScanHistoryStore.clearHistory(this@MainActivity)
                                        authDialog?.dismiss()
                                        renderScreen()
                                    }
                                    Toast.makeText(
                                        this@MainActivity,
                                        if (deleted) "Account deleted." else "Deletion was not confirmed. Please retry.",
                                        Toast.LENGTH_LONG
                                    ).show()
                                }
                            }
                        }
                        .setNegativeButton("Cancel", null)
                        .show()
                }
            })

            authDialog = AlertDialog.Builder(this).setView(scroll).create().also { dlg ->
                dlg.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
                dlg.show()
            }
            return
        }

        // ================= CLEAN PROGRESSIVE SIGN-IN SHEET =================
        fun buildIconPillButton(
            iconRes: Int,
            iconWidthDp: Int,
            iconHeightDp: Int,
            text: String,
            bgColor: Int,
            borderColor: Int?,
            textColor: Int,
            onClick: () -> Unit
        ): LinearLayout {
            return LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                setPadding(dp(20), dp(15), dp(20), dp(15))
                background = GradientDrawable().apply {
                    setColor(bgColor)
                    if (borderColor != null) setStroke(dp(1), borderColor)
                    cornerRadius = dp(999).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(12) }

                addView(ImageView(this@MainActivity).apply {
                    setImageResource(iconRes)
                    layoutParams = LinearLayout.LayoutParams(dp(iconWidthDp), dp(iconHeightDp)).apply {
                        marginEnd = dp(12)
                    }
                    scaleType = ImageView.ScaleType.FIT_CENTER
                })
                addView(label(text, 15.5f, textColor, bold = true))
                setOnClickListener { onClick() }
            }
        }

        var prefilledEmail = ""
        var selectedProvider = "email"

        fun renderStep(step: String) {
            card.removeAllViews()

            if (step == "welcome") {
                card.addView(buildTopHeader({ authDialog?.dismiss() }, showBackArrow = false))
                card.addView(label("Welcome to HeyBroc", 26f, 0xFF111814.toInt(), bold = true))
                card.addView(label(
                    "Sign in or create your free account to save your scans, Family Watchlist & Clean Swaps across all your devices.",
                    14.5f,
                    0xFF6B7280.toInt()
                ).apply { setPadding(0, dp(6), 0, dp(22)) })

                // 1. Continue with Google Button (4-color Google 'G' logo + system Google account picker)
                card.addView(buildIconPillButton(
                    iconRes = R.drawable.ic_google_logo,
                    iconWidthDp = 20,
                    iconHeightDp = 20,
                    text = "Continue with Google",
                    bgColor = Color.WHITE,
                    borderColor = 0xFFD1D5DB.toInt(),
                    textColor = 0xFF1F2937.toInt(),
                    onClick = {
                        selectedProvider = "google"
                        pendingGoogleAccountPicked = { pickedEmail ->
                            prefilledEmail = pickedEmail
                            selectedProvider = "google"
                            renderStep("email_login")
                        }
                        val launched = runCatching {
                            @Suppress("DEPRECATION")
                            val intent = AccountManager.newChooseAccountIntent(
                                null,
                                null,
                                arrayOf("com.google"),
                                null,
                                null,
                                null,
                                null
                            )
                            startActivityForResult(intent, REQ_PICK_GOOGLE_ACCOUNT)
                            true
                        }.getOrDefault(false)
                        if (!launched) {
                            renderStep("email_login")
                        }
                    }
                ))

                // 2. Unified Continue with Email Button (handles both returning & new accounts)
                card.addView(buildIconPillButton(
                    iconRes = R.drawable.ic_email_logo,
                    iconWidthDp = 19,
                    iconHeightDp = 19,
                    text = "Continue with Email",
                    bgColor = 0xFF16A34A.toInt(),
                    borderColor = null,
                    textColor = Color.WHITE,
                    onClick = {
                        selectedProvider = "email"
                        renderStep("email_login")
                    }
                ))

                // Shipt-style "— or —" divider + full-width outlined "Continue as guest" pill button
                card.addView(label("— or —", 12.5f, 0xFF9CA3AF.toInt()).apply {
                    gravity = Gravity.CENTER
                    setPadding(0, dp(2), 0, dp(10))
                })
                card.addView(label("Continue as guest", 15f, 0xFF1F2937.toInt(), bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(16), dp(14), dp(16), dp(14))
                    background = GradientDrawable().apply {
                        setColor(Color.WHITE)
                        setStroke(dp(2), 0xFFD1D5DB.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { bottomMargin = dp(12) }
                    setOnClickListener { authDialog?.dismiss() }
                })
                card.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER
                    setPadding(dp(8), dp(2), dp(8), dp(2))
                    addView(label("Terms of Service", 11.5f, 0xFF6B7280.toInt()).apply {
                        setOnClickListener {
                            runCatching {
                                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.heybroc.com/terms")))
                            }
                        }
                    })
                    addView(label("   |   ", 11.5f, 0xFF6B7280.toInt()))
                    addView(label("Privacy & Health Data Notice", 11.5f, 0xFF6B7280.toInt()).apply {
                        setOnClickListener {
                            runCatching {
                                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.heybroc.com/privacy")))
                            }
                        }
                    })
                })
                return
            }

            val isRegister = step == "email_register"
            val isReset = step == "email_reset"
            card.addView(buildTopHeader({ renderStep(if (isReset) "email_login" else "welcome") }, showBackArrow = true))
            card.addView(label(
                when {
                    isRegister -> "Create Account"
                    isReset -> "Reset Password"
                    selectedProvider == "google" -> "Continue with Google"
                    else -> "Continue with Email"
                },
                23f,
                0xFF111814.toInt(),
                bold = true
            ))
            card.addView(label(
                when {
                    isRegister -> "Create a free HeyBroc account to sync your Watchlist & Clean Swaps across devices."
                    isReset -> "Enter your email, 6-digit reset code, and a new password (8+ characters)."
                    selectedProvider == "google" -> "Confirm your Google email and enter a password (8+ characters) to sign in or create your account."
                    else -> "Enter your email and password (8+ characters) — we'll sign you in or create your account automatically."
                },
                14f,
                0xFF6B7280.toInt()
            ).apply { setPadding(0, dp(4), 0, dp(16)) })

            val emailInput = EditText(this).apply {
                hint = if (selectedProvider == "google") "Google email (you@gmail.com)" else "Email address"
                setHintTextColor(0xFF9CA3AF.toInt())
                setTextColor(0xFF111814.toInt())
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15.5f)
                inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
                setSingleLine(true)
                if (prefilledEmail.isNotBlank()) {
                    setText(prefilledEmail)
                }
                setPadding(dp(18), dp(15), dp(18), dp(15))
                background = GradientDrawable().apply {
                    setColor(0xFFF9FAFB.toInt())
                    setStroke(dp(1), 0xFFD1D5DB.toInt())
                    cornerRadius = dp(16).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(10) }
            }
            card.addView(emailInput)

            val resetCodeInput = EditText(this).apply {
                hint = "6-digit reset code"
                setHintTextColor(0xFF9CA3AF.toInt())
                setTextColor(0xFF111814.toInt())
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15.5f)
                inputType = android.text.InputType.TYPE_CLASS_NUMBER
                setSingleLine(true)
                setPadding(dp(18), dp(15), dp(18), dp(15))
                background = GradientDrawable().apply {
                    setColor(0xFFF9FAFB.toInt())
                    setStroke(dp(1), 0xFFD1D5DB.toInt())
                    cornerRadius = dp(16).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(10) }
                visibility = if (isReset) View.VISIBLE else View.GONE
            }
            card.addView(resetCodeInput)

            val passRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(18), dp(2), dp(12), dp(2))
                background = GradientDrawable().apply {
                    setColor(0xFFF9FAFB.toInt())
                    setStroke(dp(1), 0xFFD1D5DB.toInt())
                    cornerRadius = dp(16).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(6) }
            }
            var passVisible = false
            val passInput = EditText(this).apply {
                hint = if (isReset) "New password (8+ characters)" else "Password (8+ characters)"
                setHintTextColor(0xFF9CA3AF.toInt())
                setTextColor(0xFF111814.toInt())
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15.5f)
                inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
                setSingleLine(true)
                background = null
                setPadding(0, dp(13), dp(8), dp(13))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            val showHideToggle = label("Show", 13f, 0xFF4B5563.toInt(), bold = true).apply {
                setPadding(dp(8), dp(8), dp(8), dp(8))
                setOnClickListener {
                    passVisible = !passVisible
                    text = if (passVisible) "Hide" else "Show"
                    passInput.inputType = if (passVisible) {
                        android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                    } else {
                        android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
                    }
                    passInput.setSelection(passInput.text?.length ?: 0)
                }
            }
            passRow.addView(passInput)
            passRow.addView(showHideToggle)
            card.addView(passRow)

            // Subtle right-aligned "Forgot password?" link
            if (!isRegister && !isReset) {
                card.addView(label("Forgot password?", 12.5f, 0xFF6B7280.toInt(), bold = true).apply {
                    gravity = Gravity.END
                    setPadding(dp(4), dp(2), dp(4), dp(14))
                    setOnClickListener {
                        val em = emailInput.text.toString().trim().lowercase()
                        prefilledEmail = em
                        renderStep("email_reset")
                        if (em.contains("@") && em.contains(".")) {
                            io.execute {
                                runCatching {
                                    val conn = (URL("https://www.heybroc.com/api/auth").openConnection() as HttpURLConnection).apply {
                                        requestMethod = "POST"
                                        doOutput = true
                                        setRequestProperty("Content-Type", "application/json")
                                        connectTimeout = 7000
                                        readTimeout = 7000
                                    }
                                    try {
                                        val payload = JSONObject().apply {
                                            put("action", "forgot_password")
                                            put("email", em)
                                        }.toString()
                                        conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                                        val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
                                        val raw = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                                        val json = if (raw.isNotBlank()) JSONObject(raw) else JSONObject()
                                        val msg = json.optString("message", "If an account exists for $em, a 6-digit reset code has been emailed.")
                                        mainHandler.post {
                                            Toast.makeText(this@MainActivity, msg, Toast.LENGTH_LONG).show()
                                        }
                                    } finally {
                                        conn.disconnect()
                                    }
                                }
                            }
                        }
                    }
                })
            }

            val submitLabel = when {
                isRegister -> "Create Account  →"
                isReset -> "Save New Password  →"
                else -> "Continue  →"
            }
            card.addView(label(submitLabel, 16f, Color.WHITE, bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(16), dp(15), dp(16), dp(15))
                background = GradientDrawable().apply {
                    setColor(0xFF16A34A.toInt())
                    cornerRadius = dp(999).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
                setOnClickListener {
                    val em = emailInput.text.toString().trim().lowercase()
                    val pw = passInput.text.toString()
                    val rc = resetCodeInput.text.toString().trim()
                    if (!em.contains("@") || !em.contains(".")) {
                        Toast.makeText(this@MainActivity, "Please enter a valid email address.", Toast.LENGTH_SHORT).show()
                        return@setOnClickListener
                    }
                    if (isReset && rc.length < 6) {
                        Toast.makeText(this@MainActivity, "Please enter your 6-digit reset code.", Toast.LENGTH_SHORT).show()
                        return@setOnClickListener
                    }
                    if (pw.length < 8) {
                        Toast.makeText(this@MainActivity, "Password must be at least 8 characters.", Toast.LENGTH_SHORT).show()
                        return@setOnClickListener
                    }
                    completeMobileAuth(
                        email = em,
                        fallbackName = em.substringBefore("@"),
                        action = when {
                            isRegister -> "register"
                            isReset -> "reset_password"
                            else -> "login"
                        },
                        password = pw,
                        resetCode = if (isReset) rc else null,
                        provider = selectedProvider,
                        onSuccess = { authDialog?.dismiss() }
                    )
                }
            })
        }

        renderStep("welcome")

        authDialog = AlertDialog.Builder(this).setView(scroll).create().also { dlg ->
            dlg.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
            dlg.show()
        }
    }

    private fun completeMobileAuth(
        email: String,
        fallbackName: String,
        action: String,
        password: String?,
        resetCode: String? = null,
        provider: String = "email",
        onSuccess: (() -> Unit)? = null
    ) {
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        io.execute {
            runCatching {
                fun sendAuthRequest(reqAction: String): Pair<Boolean, JSONObject> {
                    val conn = (URL("https://www.heybroc.com/api/auth").openConnection() as HttpURLConnection).apply {
                        requestMethod = "POST"
                        doOutput = true
                        setRequestProperty("Content-Type", "application/json")
                        connectTimeout = 7000
                        readTimeout = 7000
                    }
                    try {
                        val payload = JSONObject().apply {
                            put("action", reqAction)
                            put("provider", provider)
                            put("email", email)
                            put("displayName", fallbackName)
                            put("deviceId", ScanApi.deviceId(this@MainActivity))
                            put("deviceSecret", ScanApi.deviceSecret(this@MainActivity))
                            if (!password.isNullOrBlank()) {
                                put("password", password)
                                put("newPassword", password)
                            }
                            if (!resetCode.isNullOrBlank()) {
                                put("resetCode", resetCode)
                            }
                        }.toString()
                        conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                        val okHttp = conn.responseCode in 200..299
                        val stream = if (okHttp) conn.inputStream else conn.errorStream
                        val raw = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                        val json = if (raw.isNotBlank()) JSONObject(raw) else JSONObject()
                        return Pair(okHttp && json.optBoolean("ok"), json)
                    } finally {
                        conn.disconnect()
                    }
                }

                var (ok, json) = sendAuthRequest(action)
                // If user tapped "Continue with Google" or "Continue with Email" and doesn't have an account yet,
                // automatically create their account with the password they entered.
                if (!ok && action == "login" && json.optString("error").contains("No account found", ignoreCase = true)) {
                    val regResult = sendAuthRequest("register")
                    ok = regResult.first
                    json = regResult.second
                }

                if (ok) {
                    val tok = json.optString("token", "")
                    val usr = json.optJSONObject("user")
                    val resolvedName = usr?.optString("displayName", fallbackName) ?: fallbackName
                    ScanApi.saveEntitlementSnapshot(this@MainActivity, usr)
                    prefs.edit()
                        .putString("auth_email", email)
                        .putString("auth_name", resolvedName)
                        .putString("auth_provider", provider)
                        .putString("auth_token", tok)
                        .apply()
                    ScanApi.trackEvent(
                        this@MainActivity,
                        "auth_completed",
                        properties = JSONObject().put("provider", provider)
                    )
                    mainHandler.post {
                        if (isDestroyed || isFinishing) return@post
                        onSuccess?.invoke()
                        renderScreen()
                        Toast.makeText(this@MainActivity, "👋 Welcome, $resolvedName! Account synced.", Toast.LENGTH_LONG).show()
                    }
                } else {
                    val errMsg = json.optString("error", "Could not sign in. Please check your credentials.")
                    mainHandler.post {
                        if (isDestroyed || isFinishing) return@post
                        Toast.makeText(this@MainActivity, errMsg, Toast.LENGTH_LONG).show()
                    }
                }
            }.onFailure {
                mainHandler.post {
                    if (isDestroyed || isFinishing) return@post
                    Toast.makeText(this@MainActivity, "Network error connecting to HeyBroc. Please try again.", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun performLiveProductSearch(query: String) {
        if (isSearching) return
        lastSearchQuery = query
        isSearching = true
        hideKeyboard()
        renderScreen()

        val appCtx = applicationContext
        val storeKey = preferredStoreKey()
        io.execute {
            val raw = runCatching { ScanApi.scan(appCtx, query, "", storeKey) }.getOrNull()
            val parsed = raw?.let { runCatching { JSONObject(it) }.getOrNull() }
            runOnUiThread {
                if (isDestroyed || isFinishing) return@runOnUiThread
                isSearching = false
                if (parsed?.optBoolean("ok") == true) {
                    ScanHistoryStore.recordScan(this, parsed, storeKey)
                    renderScreen()
                    showProductDetailDialog(parsed)
                } else {
                    renderScreen()
                    Toast.makeText(
                        this,
                        "Couldn't reach live scanner for \"$query\" — try another item or check connection.",
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
        }
    }

    private fun showProductDetailDialog(item: JSONObject) {
        ScanApi.applyLocalWatchlistToData(this, item)
        val prod = item.optJSONObject("product")
        val res = item.optJSONObject("result")
        val title = ScanHistoryStore.extractTitle(item)
        val brand = prod?.optString("brand").orEmpty().ifBlank { item.optString("brand") }
        val imgUrl = prod?.optString("imageUrl").orEmpty().ifBlank { item.optString("imageUrl") }
        val description = prod?.optString("description").orEmpty().ifBlank { item.optString("description") }
        val ingredients = prod?.optString("ingredients").orEmpty().ifBlank { item.optString("ingredients") }
        val flagged = res?.optJSONArray("flagged") ?: JSONArray()
        val flagCount = flagged.length()
        val yb = res?.optJSONObject("yukaBreakdown")
        val score = res?.optInt("score") ?: item.optInt("score", 50)
        val rating = ratingForScore(score)
        val tone = yukaDotColor(score)
        val swap = item.optJSONObject("swap")
        val storeSwapLink = item.optJSONObject("storeSwapLink")

        val sheetScroll = ScrollView(this)
        val sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(18))
            setBackgroundColor(Color.WHITE)
        }

        // Top Product Header (Photo + Title + Brand + ★ Star)
        val topHeader = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        topHeader.addView(buildProductImageBox(imgUrl, title, dp(64), dp(76)).apply {
            layoutParams = LinearLayout.LayoutParams(dp(64), dp(76)).apply { marginEnd = dp(14) }
        })
        topHeader.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            addView(label(title, 17f, 0xFF111814.toInt(), bold = true))
            if (brand.isNotBlank()) {
                addView(label(brand, 14f, 0xFF6B7280.toInt()).apply { setPadding(0, dp(2), 0, 0) })
            }
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(6), 0, 0)
                addView(View(context).apply {
                    background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(tone) }
                    layoutParams = LinearLayout.LayoutParams(dp(12), dp(12)).apply { marginEnd = dp(8) }
                })
                addView(label("$score/100 · $rating", 15f, 0xFF111814.toInt(), bold = true))
            })
        })
        val favBtn = label(
            if (ScanHistoryStore.isFavorite(this, title)) "★" else "☆",
            26f,
            if (ScanHistoryStore.isFavorite(this, title)) 0xFFEAB308.toInt() else 0xFF9CA3AF.toInt(),
            bold = true
        ).apply {
            setPadding(dp(10), dp(6), dp(6), dp(6))
            setOnClickListener {
                val nowFav = ScanHistoryStore.toggleFavorite(this@MainActivity, item)
                this.text = if (nowFav) "★" else "☆"
                this.setTextColor(if (nowFav) 0xFFEAB308.toInt() else 0xFF9CA3AF.toInt())
                renderScreen()
            }
        }
        topHeader.addView(favBtn)
        sheet.addView(topHeader)

        if (description.isNotBlank()) {
            sheet.addView(label(description, 12.5f, 0xFF374151.toInt()).apply {
                setPadding(0, dp(8), 0, 0)
            })
        }

        // Personal Allergy & Diabetes Watch Alert Banner (only shown when user checked corresponding box)
        val dietaryAlerts = ScanApi.evaluateDietaryAlerts(this, prod, res, item)
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
                ).apply { topMargin = dp(10) }

                addView(label("⚠️ PERSONAL ALLERGY & DIET ALERT", 10.5f, 0xFF991B1B.toInt(), bold = true).apply {
                    letterSpacing = 0.05f
                })
                dietaryAlerts.forEach { alert ->
                    addView(label("${alert.label}: ${alert.reason}", 12.5f, 0xFF7F1D1D.toInt(), bold = true).apply {
                        setPadding(0, dp(4), 0, 0)
                    })
                }
            })
        }

        // 3-Pillar Score Breakdown Box
        val nutScore = yb?.optInt("nutritionScore", 42) ?: 42
        val nutGrade = yb?.optString("nutriScoreGrade", "B") ?: "B"
        val addScore = yb?.optInt("additiveScore", if (flagCount == 0) 30 else 0) ?: 0
        val orgScore = yb?.optInt("organicScore", 0) ?: 0

        val hasHighGlycemicIng = Regex("\\b(high fructose corn syrup|corn syrup|maltodextrin|dextrose|glucose syrup|cane sugar|sucrose)\\b", RegexOption.IGNORE_CASE).containsMatchIn(ingredients)
        val hasStarchBase = Regex("\\b(enriched.*flour|corn\\s*starch|tapioca\\s*starch|potato\\s*starch|cassava\\s*flour|rice\\s*flour)\\b", RegexOption.IGNORE_CASE).containsMatchIn(ingredients)
        val defaultGlucoseImpact = when {
            hasHighGlycemicIng || nutGrade == "E" -> "High Sugar / Refined Carbs"
            hasStarchBase || nutGrade == "C" || nutGrade == "D" -> "Moderate Sugar"
            else -> "Low / No Added Sugar"
        }
        val rawGlucoseImpact = yb?.optString("glucoseImpact")?.takeIf { it.isNotBlank() }.orEmpty()
        val glucoseImpact = if (rawGlucoseImpact.isBlank() || rawGlucoseImpact.contains("Spike", ignoreCase = true) || rawGlucoseImpact.contains("glycemic", ignoreCase = true)) {
            defaultGlucoseImpact
        } else {
            rawGlucoseImpact
        }
        val rawGlucoseNote = yb?.optString("glucoseNote")?.takeIf { it.isNotBlank() }.orEmpty()
        val glucoseNote = if (rawGlucoseNote.isBlank() || rawGlucoseNote.contains("Spike", ignoreCase = true) || rawGlucoseNote.contains("glycemic", ignoreCase = true)) {
            when (glucoseImpact) {
                "High Sugar / Refined Carbs" -> "Contains concentrated sugars, syrups, or refined starches."
                "Moderate Sugar" -> "Contains added sugars or refined starches."
                else -> "Low added sugar and minimal refined starch."
            }
        } else {
            rawGlucoseNote
        }
        val rawCalorieNote = yb?.optString("calorieNote")?.takeIf { it.isNotBlank() }.orEmpty()
        val calorieNote = if (rawCalorieNote.isBlank() || rawCalorieNote.contains("Calorie-Smart", ignoreCase = true)) {
            "Calories Not Provided"
        } else {
            rawCalorieNote
        }
        val glucoseBadgeColor = when (glucoseImpact) {
            "High Sugar / Refined Carbs" -> 0xFFD93025.toInt()
            "Moderate Sugar" -> 0xFFEA8600.toInt()
            else -> 0xFF16A34A.toInt()
        }

        sheet.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = GradientDrawable().apply {
                setColor(0xFFF9FAFB.toInt())
                cornerRadius = dp(16).toFloat()
                setStroke(dp(1), 0xFFE5E7EB.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(14) }
            addView(label("3-PILLAR SCORE BREAKDOWN", 10.5f, 0xFF6B7280.toInt(), bold = true).apply { letterSpacing = 0.06f })
            addView(label("🥗 Nutritional Quality: $nutScore/60 (Nutri-Score $nutGrade)", 13f, 0xFF111814.toInt(), bold = true).apply {
                setPadding(0, dp(4), 0, 0)
            })
            addView(label("🧪 Clean-Label Additives: $addScore/30   ·   🌱 Organic Bonus: $orgScore/10", 12.5f, 0xFF4B5563.toInt()).apply {
                setPadding(0, dp(2), 0, 0)
            })
            addView(View(context).apply {
                setBackgroundColor(0xFFE5E7EB.toInt())
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)).apply {
                    topMargin = dp(8)
                    bottomMargin = dp(8)
                }
            })
            addView(label("SUGAR, REFINED CARB & CALORIE INSIGHT", 10.5f, 0xFF6B7280.toInt(), bold = true).apply { letterSpacing = 0.06f })
            addView(label("🩸 Sugar / Starch Indicator: $glucoseImpact  ·  🔥 $calorieNote", 12.5f, glucoseBadgeColor, bold = true).apply {
                setPadding(0, dp(3), 0, 0)
            })
            addView(label(glucoseNote, 11.5f, 0xFF4B5563.toInt()).apply {
                setPadding(0, dp(2), 0, 0)
            })
        })

        // Flagged Additives List
        if (flagCount == 0) {
            sheet.addView(label("✓ No Watchlist Additives — Clean Label", 13.5f, 0xFF16A34A.toInt(), bold = true).apply {
                setPadding(dp(14), dp(11), dp(14), dp(11))
                background = GradientDrawable().apply {
                    setColor(0xFFE8F5EC.toInt())
                    cornerRadius = dp(14).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(12) }
            })
        } else {
            sheet.addView(label("ADDITIVES ($flagCount FLAGGED)", 11f, 0xFFB91C1C.toInt(), bold = true).apply {
                letterSpacing = 0.06f
                setPadding(0, dp(14), 0, dp(6))
            })
            for (i in 0 until flagCount) {
                val f = flagged.optJSONObject(i) ?: continue
                val risk = f.optString("risk", "moderate")
                val dotCol = when (risk) {
                    "high" -> 0xFFD93025.toInt()
                    "moderate" -> 0xFFEA8600.toInt()
                    else -> 0xFFFACC15.toInt()
                }
                val riskLabel = when (risk) {
                    "high" -> "High concern"
                    "moderate" -> "Moderate concern"
                    else -> "Low concern"
                }
                sheet.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(12), dp(10), dp(12), dp(10))
                    background = GradientDrawable().apply {
                        setColor(0xFFF9FAFB.toInt())
                        cornerRadius = dp(12).toFloat()
                        setStroke(dp(1), 0xFFE5E7EB.toInt())
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { bottomMargin = dp(6) }

                    addView(LinearLayout(context).apply {
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER_VERTICAL
                        addView(View(context).apply {
                            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(dotCol) }
                            layoutParams = LinearLayout.LayoutParams(dp(10), dp(10)).apply { marginEnd = dp(8) }
                        })
                        addView(label(f.optString("name"), 13.5f, 0xFF111814.toInt(), bold = true).apply {
                            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                        })
                        addView(label(riskLabel, 12f, dotCol, bold = true))
                    })
                    val exp = f.optString("explanation")
                    if (exp.isNotBlank()) {
                        addView(label(exp, 12f, 0xFF4B5563.toInt()).apply { setPadding(dp(18), dp(3), 0, 0) })
                    }
                })
            }
        }

        // Full Ingredients Text
        if (ingredients.isNotBlank()) {
            sheet.addView(label("INGREDIENTS", 11f, 0xFF6B7280.toInt(), bold = true).apply {
                letterSpacing = 0.06f
                setPadding(0, dp(10), 0, dp(4))
            })
            sheet.addView(label(ingredients, 12.5f, 0xFF4B5563.toInt()).apply {
                setPadding(dp(12), dp(10), dp(12), dp(10))
                background = GradientDrawable().apply {
                    setColor(0xFFF9FAFB.toInt())
                    cornerRadius = dp(12).toFloat()
                }
            })
        }

        val rawItemStore = item.optString("storeKey").ifBlank { item.optString("store", "") }
        val itemStoreKey = if (rawItemStore.isBlank() || rawItemStore == "search") preferredStoreKey() else rawItemStore
        val storeDisplayName = when (itemStoreKey.lowercase()) {
            "walmart" -> "Walmart"
            "target" -> "Target"
            "instacart" -> "Instacart"
            "aldi" -> "ALDI"
            "bjs" -> "BJ's"
            "costco" -> "Costco"
            "kroger" -> "Kroger"
            "sams" -> "Sam's Club"
            "amazon" -> "Amazon Fresh"
            "wholefoods" -> "Whole Foods"
            "doordash" -> "DoorDash"
            "ubereats" -> "Uber Eats"
            "shipt" -> "Shipt"
            else -> "Store"
        }

        // Clean Swap Card (gated behind 3 free weekly reveals / Pro so users cannot read the swap brand without unlocking)
        var dialogRef: AlertDialog? = null
        if (swap != null) {
            ScanHistoryStore.upgradeSwapForStore(swap, title, itemStoreKey)
            val swapTitle = swap.optString("title", "Clean Swap")
            val swapScore = swap.optInt("score", 0)
            val swapRating = ratingForScore(swapScore)
            val swapImg = swap.optString("image").ifBlank { swap.optString("imageUrl") }
            val swapIng = swap.optString("ingredients").ifBlank { swap.optString("cleanIngredients") }
            val swapUnlocked = ScanApi.isSwapUnlocked(this, title, swapTitle)
            val rem = ScanApi.swapsRemaining(this)
            val lim = ScanApi.weeklySwapsLimit(this)
            val isPaidLink = swap.optBoolean("isPaidLink", false)

            val swapCard = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(12), dp(14), dp(12))
                background = GradientDrawable().apply {
                    setColor(0xFFE8F5EC.toInt())
                    cornerRadius = dp(16).toFloat()
                    setStroke(dp(1), 0xFF2E9E5B.toInt())
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(14) }
            }

            if (swapUnlocked) {
                swapCard.addView(label("✓ CLEAN SWAP · $swapScore/100 ${swapRating.uppercase()}", 11f, 0xFF166534.toInt(), bold = true).apply {
                    letterSpacing = 0.06f
                })
                val swapHeaderRow = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(0, dp(6), 0, dp(8))
                }
                swapHeaderRow.addView(buildProductImageBox(swapImg, swapTitle, dp(52), dp(62)).apply {
                    layoutParams = LinearLayout.LayoutParams(dp(52), dp(62)).apply { marginEnd = dp(12) }
                })
                swapHeaderRow.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                    addView(label(swapTitle, 15f, 0xFF111814.toInt(), bold = true))
                    if (swapIng.isNotBlank()) {
                        addView(label("Ingredients: $swapIng", 12f, 0xFF166534.toInt()).apply {
                            setPadding(0, dp(3), 0, 0)
                        })
                    }
                })
                swapCard.addView(swapHeaderRow)
                val swapCtaText = if (isPaidLink) {
                    "🛒 Find Clean Swap in $storeDisplayName ↗ · paid link"
                } else {
                    "🛒 Find Clean Swap in $storeDisplayName ↗"
                }
                swapCard.addView(label(swapCtaText, 13.5f, Color.WHITE, bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(12), dp(11), dp(12), dp(11))
                    background = GradientDrawable().apply {
                        setColor(0xFF2E9E5B.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    setOnClickListener { openStoreSwap(swapTitle, itemStoreKey, swap, title) }
                })
            } else if (rem > 0) {
                swapCard.addView(label("🔒 CLEAN SWAP FOUND · $swapScore/100 ${swapRating.uppercase()}", 11f, 0xFF166534.toInt(), bold = true).apply {
                    letterSpacing = 0.06f
                })
                swapCard.addView(label("1-for-1 Clean Alternative (0 Flagged Additives)", 14f, 0xFF111814.toInt(), bold = true).apply {
                    setPadding(0, dp(6), 0, dp(2))
                })
                swapCard.addView(label("You have $rem of $lim free Clean Swaps remaining.", 12f, 0xFF166534.toInt()).apply {
                    setPadding(0, 0, 0, dp(10))
                })
                swapCard.addView(label("🔓 Reveal Clean Swap ($rem/$lim Free)", 13.5f, Color.WHITE, bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(12), dp(11), dp(12), dp(11))
                    background = GradientDrawable().apply {
                        setColor(0xFF2E9E5B.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    setOnClickListener {
                        if (ScanApi.unlockSwapForProduct(this@MainActivity, title, swapTitle)) {
                            dialogRef?.dismiss()
                            renderScreen()
                            showProductDetailDialog(item)
                        }
                    }
                })
            } else {
                swapCard.addView(label("🔒 CLEAN SWAP LOCKED · $swapScore/100 ${swapRating.uppercase()}", 11f, 0xFF92400E.toInt(), bold = true).apply {
                    letterSpacing = 0.06f
                })
                swapCard.addView(label("$swapScore/100 Clean Replacement Available", 14f, 0xFF111814.toInt(), bold = true).apply {
                    setPadding(0, dp(6), 0, dp(2))
                })
                swapCard.addView(label("All $lim free Clean Swaps used. Upgrade to HeyBroc Pro for unlimited 1-tap swaps, or invite a friend for +7 free Pro days!", 12f, 0xFF374151.toInt()).apply {
                    setPadding(0, 0, 0, dp(10))
                })
                swapCard.addView(label("⚡ Unlock Unlimited Swaps — Pro ↗", 13.5f, Color.WHITE, bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(12), dp(11), dp(12), dp(11))
                    background = GradientDrawable().apply {
                        setColor(0xFF2E9E5B.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    setOnClickListener {
                        ScanApi.trackEvent(this@MainActivity, "checkout_started")
                        runCatching {
                            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ScanApi.upgradeUrl(this@MainActivity))))
                        }
                    }
                })
            }
            sheet.addView(swapCard)
        } else if (storeSwapLink != null) {
            ScanHistoryStore.upgradeSwapForStore(storeSwapLink, "", itemStoreKey)
            val isPaidLink = storeSwapLink.optBoolean("isPaidLink", false)
            val directCta = if (isPaidLink) {
                "🛒 Find in $storeDisplayName ↗ · paid link"
            } else {
                "🛒 Find in $storeDisplayName ↗"
            }
            sheet.addView(label(directCta, 13.5f, Color.WHITE, bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(12), dp(12), dp(12), dp(12))
                background = GradientDrawable().apply {
                    setColor(0xFF2E9E5B.toInt())
                    cornerRadius = dp(999).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(14) }
                setOnClickListener { openStoreSwap(title, itemStoreKey, storeSwapLink, title) }
            })
        }

        val lookupObj = item.optJSONObject("lookup")
        val rawSource = lookupObj?.optString("origin")?.ifBlank { lookupObj.optString("source") }.orEmpty()
            .ifBlank { item.optString("source").ifBlank { prod?.optString("source").orEmpty() } }
        val sourceUpdated = lookupObj?.optString("sourceUpdatedAt").orEmpty()
            .ifBlank { item.optString("sourceUpdatedAt").ifBlank { prod?.optString("sourceUpdatedAt").orEmpty() } }
        val sourceLabel = when (rawSource) {
            "usda" -> "USDA FoodData Central"
            "openfoodfacts" -> "Open Food Facts"
            "catalog" -> "Representative formulation — verify physical label"
            "screen" -> "On-screen package text"
            else -> "Ingredient lookup"
        }
        val provenanceLine = buildString {
            append("Source: $sourceLabel")
            if (sourceUpdated.isNotBlank() && sourceUpdated != "null") append(" (updated $sourceUpdated)")
            append(" · Tap to report a mistake")
        }
        sheet.addView(
            label(provenanceLine, 11f, 0xFF0F7A4A.toInt(), bold = true).apply {
                setPadding(dp(4), dp(10), dp(4), dp(2))
                setOnClickListener {
                    runCatching {
                        val subject = java.net.URLEncoder.encode("Ingredient label correction: $title", "UTF-8")
                        startActivity(
                            Intent(
                                Intent.ACTION_VIEW,
                                Uri.parse("mailto:support@heybroc.com?subject=$subject")
                            )
                        )
                    }
                }
            }
        )
        sheet.addView(
            label("Photos: Open Food Facts (CC BY-SA 3.0) ↗", 10.5f, 0xFF0F7A4A.toInt(), bold = true).apply {
                setPadding(dp(4), dp(2), dp(4), dp(2))
                setOnClickListener {
                    runCatching {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://world.openfoodfacts.org/terms-of-use")))
                    }
                }
            }
        )

        sheet.addView(
            label(
                "Informational opinion only — not medical or regulatory advice. Scores reflect HeyBroc's independent clean-label rubric. Formulations vary by region and lot; always verify the physical package label.",
                10.5f,
                0xFF6B7280.toInt()
            ).apply {
                setPadding(dp(4), dp(6), dp(4), dp(2))
            }
        )

        sheetScroll.addView(sheet)
        dialogRef = AlertDialog.Builder(this)
            .setView(sheetScroll)
            .setPositiveButton("Close", null)
            .show()
    }

    /**
     * Attaches GPS-style live autocomplete to an EditText:
     *   1. Immediately (0ms) renders local prefix/keyword matches from History + Favorites + Catalog.
     *   2. Queries GET /api/suggest?q=<prefix> after a 120ms debounce and merges server matches.
     */
    private fun attachLiveAutocomplete(
        input: EditText,
        suggestionsBox: LinearLayout,
        onPicked: (String, JSONObject?) -> Unit
    ) {
        fun renderSuggestionRows(query: String, localItems: List<JSONObject>, remoteItems: List<JSONObject>) {
            suggestionsBox.removeAllViews()
            if (query.isBlank()) {
                suggestionsBox.visibility = View.GONE
                return
            }
            val merged = ArrayList<Pair<JSONObject, JSONObject?>>() // (displaySummary, fullScanJsonOrNull)
            val seen = HashSet<String>()

            for (item in localItems) {
                val t = ScanHistoryStore.extractTitle(item)
                val key = ScanHistoryStore.canonicalKey(t)
                if (key.isNotBlank() && seen.add(key)) {
                    val prod = item.optJSONObject("product")
                    val res = item.optJSONObject("result")
                    val summary = JSONObject().apply {
                        put("title", t)
                        put("brand", prod?.optString("brand").orEmpty().ifBlank { item.optString("brand") })
                        put("score", res?.optInt("score") ?: item.optInt("score", 50))
                        put("imageUrl", prod?.optString("imageUrl").orEmpty().ifBlank { ScanHistoryStore.productImageUrl(t) })
                    }
                    merged.add(summary to item)
                }
            }
            for (rem in remoteItems) {
                val t = rem.optString("title").trim()
                val key = ScanHistoryStore.canonicalKey(t)
                if (key.isNotBlank() && seen.add(key)) {
                    merged.add(rem to null)
                }
            }

            suggestionsBox.visibility = View.VISIBLE
            merged.take(6).forEachIndexed { index, (sug, fullItem) ->
                val sugTitle = sug.optString("title")
                val sugBrand = sug.optString("brand")
                val sugScore = sug.optInt("score", 50)
                val sugImg = sug.optString("imageUrl").ifBlank { ScanHistoryStore.productImageUrl(sugTitle) }

                val row = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(12), dp(9), dp(12), dp(9))
                    setOnClickListener {
                        suggestionsBox.visibility = View.GONE
                        hideKeyboard()
                        onPicked(sugTitle, fullItem)
                    }
                }
                row.addView(buildProductImageBox(sugImg, sugTitle, dp(38), dp(46)).apply {
                    layoutParams = LinearLayout.LayoutParams(dp(38), dp(46)).apply { marginEnd = dp(12) }
                })
                row.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                    addView(label(sugTitle, 14f, 0xFF111814.toInt(), bold = true).apply {
                        maxLines = 1
                        ellipsize = TextUtils.TruncateAt.END
                    })
                    if (sugBrand.isNotBlank()) {
                        addView(label(sugBrand, 12f, 0xFF6B7280.toInt()).apply {
                            maxLines = 1
                            ellipsize = TextUtils.TruncateAt.END
                        })
                    }
                })
                row.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(8), 0, 0, 0)
                    addView(View(context).apply {
                        background = GradientDrawable().apply {
                            shape = GradientDrawable.OVAL
                            setColor(yukaDotColor(sugScore))
                        }
                        layoutParams = LinearLayout.LayoutParams(dp(9), dp(9)).apply { marginEnd = dp(5) }
                    })
                    addView(label("$sugScore/100", 12.5f, 0xFF374151.toInt(), bold = true))
                })
                suggestionsBox.addView(row)
                if (index < merged.take(6).lastIndex) {
                    suggestionsBox.addView(View(this).apply {
                        setBackgroundColor(0xFFF3F4F6.toInt())
                        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
                    })
                }
            }

            // Bottom "Search all foods for '<query>'" action row
            if (merged.isNotEmpty()) {
                suggestionsBox.addView(View(this).apply {
                    setBackgroundColor(0xFFE5E7EB.toInt())
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
                })
            }
            suggestionsBox.addView(label("🔍  Grade \"$query\" across all foods →", 13.5f, 0xFF2E9E5B.toInt(), bold = true).apply {
                setPadding(dp(14), dp(11), dp(14), dp(11))
                setOnClickListener {
                    suggestionsBox.visibility = View.GONE
                    hideKeyboard()
                    onPicked(query, null)
                }
            })
        }

        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                val q = s?.toString()?.trim().orEmpty()
                pendingSuggestRunnable?.let { mainHandler.removeCallbacks(it) }
                if (q.isEmpty()) {
                    suggestionsBox.removeAllViews()
                    suggestionsBox.visibility = View.GONE
                    return
                }
                val localHits = ScanHistoryStore.localSuggestions(this@MainActivity, q, 6)
                renderSuggestionRows(q, localHits, emptyList())

                val runnable = Runnable {
                    imgExecutor.execute {
                        val remoteHits = runCatching { ScanApi.suggest(q) }.getOrDefault(emptyList())
                        if (remoteHits.isNotEmpty()) {
                            mainHandler.post {
                                if (!isDestroyed && !isFinishing && input.text?.toString()?.trim() == q) {
                                    renderSuggestionRows(q, localHits, remoteHits)
                                }
                            }
                        }
                    }
                }
                pendingSuggestRunnable = runnable
                mainHandler.postDelayed(runnable, 120L)
            }
        })
    }

    private fun buildNeutralPackagePlaceholder(wPx: Int, hPx: Int): View {
        return object : View(this) {
            private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.STROKE
                strokeWidth = TypedValue.applyDimension(
                    TypedValue.COMPLEX_UNIT_DIP,
                    1.6f,
                    resources.displayMetrics
                ).coerceAtLeast(2f)
                color = 0xFF94A3B8.toInt()
                strokeCap = Paint.Cap.ROUND
                strokeJoin = Paint.Join.ROUND
            }
            private val fillAccent = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.FILL
                color = 0xFFE2E8F0.toInt()
            }
            private val boxRect = RectF()
            private val badgeRect = RectF()

            override fun onDraw(canvas: Canvas) {
                super.onDraw(canvas)
                val cx = width / 2f
                val cy = height / 2f
                val iconW = (width * 0.42f).coerceIn(dp(18).toFloat(), dp(32).toFloat())
                val iconH = (height * 0.48f).coerceIn(dp(22).toFloat(), dp(38).toFloat())
                val left = cx - iconW / 2f
                val top = cy - iconH / 2f
                val right = cx + iconW / 2f
                val bottom = cy + iconH / 2f
                val r = dp(4).toFloat()

                boxRect.set(left, top + iconH * 0.14f, right, bottom)
                canvas.drawRoundRect(boxRect, r, r, strokePaint)

                badgeRect.set(left + iconW * 0.14f, top, right - iconW * 0.14f, top + iconH * 0.16f)
                canvas.drawRoundRect(badgeRect, r * 0.6f, r * 0.6f, fillAccent)
                canvas.drawRoundRect(badgeRect, r * 0.6f, r * 0.6f, strokePaint)

                val lineLeft = left + iconW * 0.22f
                val lineRight = right - iconW * 0.22f
                val lineMidY = top + iconH * 0.50f
                val lineLowY = top + iconH * 0.70f
                canvas.drawLine(lineLeft, lineMidY, lineRight, lineMidY, strokePaint)
                canvas.drawLine(lineLeft, lineLowY, lineLeft + (lineRight - lineLeft) * 0.68f, lineLowY, strokePaint)
            }
        }.apply {
            background = GradientDrawable().apply {
                setColor(0xFFF8FAFC.toInt())
                cornerRadius = dp(10).toFloat()
                setStroke(dp(1), 0xFFE2E8F0.toInt())
            }
            layoutParams = FrameLayout.LayoutParams(wPx, hPx)
        }
    }

    private fun buildProductImageBox(imgUrl: String, title: String, wPx: Int, hPx: Int): FrameLayout {
        val box = FrameLayout(this)
        val fallback = buildNeutralPackagePlaceholder(wPx, hPx)
        box.addView(fallback)

        val iv = ImageView(this).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
            layoutParams = FrameLayout.LayoutParams(wPx, hPx)
        }
        box.addView(iv)

        val fallbackApiUrl = ScanHistoryStore.productImageApiFallbackUrl(title)
        val primaryUrl = ScanHistoryStore.resolveBestImageUrl(title, imgUrl)
        loadThumbnailAsync(primaryUrl, fallbackApiUrl, iv, fallback)
        return box
    }

    private fun formatRelativeTime(scannedAtMs: Long, storeKey: String): String {
        val storeSuffix = when (storeKey.lowercase()) {
            "walmart" -> " · Walmart"
            "target" -> " · Target"
            "instacart" -> " · Instacart"
            "aldi" -> " · ALDI"
            "bjs" -> " · BJ's"
            "costco" -> " · Costco"
            "kroger" -> " · Kroger"
            "sams" -> " · Sam's Club"
            "amazon" -> " · Amazon Fresh"
            "wholefoods" -> " · Whole Foods"
            "doordash" -> " · DoorDash"
            "ubereats" -> " · Uber Eats"
            "shipt" -> " · Shipt"
            "search" -> " · Searched"
            else -> ""
        }
        if (scannedAtMs <= 0L) return "Recent$storeSuffix"
        val diffMin = ((System.currentTimeMillis() - scannedAtMs) / 60000L).coerceAtLeast(0L)
        val base = when {
            diffMin < 1L -> "Just now"
            diffMin < 60L -> "$diffMin min ago"
            diffMin < 1440L -> "${diffMin / 60L} hr ago"
            else -> "${diffMin / 1440L} days ago"
        }
        return "$base$storeSuffix"
    }

    private fun normalizeSwapUrl(raw: String): String {
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

    private fun openStoreSwap(
        query: String,
        storeKey: String = "walmart",
        swapObj: JSONObject? = null,
        prodTitle: String = ""
    ) {
        if (swapObj != null) {
            ScanHistoryStore.upgradeSwapForStore(swapObj, prodTitle, storeKey)
        }
        val effectiveQuery = swapObj?.optString("searchQuery").orEmpty()
            .ifBlank { swapObj?.optString("title").orEmpty() }
            .ifBlank { query }
        if (!ScanApi.isSwapUnlocked(this, prodTitle, effectiveQuery) && !ScanApi.canUseSwap(this)) {
            ScanApi.trackEvent(this, "paywall_viewed")
            val limit = ScanApi.weeklySwapsLimit(this)
            val builder = AlertDialog.Builder(this)
                .setTitle(ScanApi.paywallHeadline(this))
                .setMessage(
                    "You've used all $limit free single-item swaps this week.\n\n" +
                        "Product scores (0–100) and Cart Avg stay 100% free forever. Invite friends for free Pro weeks or sign in to an existing Pro account."
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
            return
        }

        if (effectiveQuery.isNotBlank()) {
            ScanApi.consumeSwap(this, effectiveQuery, prodTitle)
            if (swapObj != null) {
                ScanHistoryStore.saveSwapToFavorites(this, swapObj, prodTitle, storeKey)
            }
            runCatching {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                cm?.setPrimaryClip(ClipData.newPlainText("HeyBroc Clean Swap", effectiveQuery))
            }
        }

        val rawDeepLink = swapObj?.optString("deepLink").orEmpty().ifBlank { swapObj?.optString("webUrl").orEmpty() }
        val normalizedLink = normalizeSwapUrl(rawDeepLink)
        val explicitDeepLink = if (ScanHistoryStore.urlMatchesStore(normalizedLink, storeKey)) normalizedLink else ""
        val explicitPkg = ScanHistoryStore.storePackageForKey(storeKey).ifBlank {
            swapObj?.optString("androidPackage").orEmpty()
        }
        val isDirectProductLink = Regex("""/(ip|p|dp|products?)/[^/?#]+""", RegexOption.IGNORE_CASE).containsMatchIn(explicitDeepLink)
        val supportsDirectUrlDeepLink = isDirectProductLink || explicitPkg in setOf(
            "com.target.ui",
            "com.amazon.mShop.android.shopping"
        )
        if (explicitDeepLink.startsWith("http")) {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(explicitDeepLink))
            if (supportsDirectUrlDeepLink && explicitPkg.isNotBlank()) {
                if (runCatching { startActivity(Intent(intent).setPackage(explicitPkg)) }.isSuccess) return
            }
            if (explicitPkg.isNotBlank() && effectiveQuery.isNotBlank()) {
                val searchIntent = Intent(Intent.ACTION_SEARCH)
                    .setPackage(explicitPkg)
                    .putExtra(android.app.SearchManager.QUERY, effectiveQuery)
                if (runCatching { startActivity(searchIntent) }.isSuccess) return
            }
            if (runCatching { startActivity(intent) }.isSuccess) return
        }

        val url = ScanHistoryStore.storeSearchUrl(storeKey, effectiveQuery)
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
    }

    private fun openWalmartSearch(query: String) {
        openStoreSwap(query, "walmart", null)
    }

    private fun fetchBitmapFromUrl(urlStr: String): Bitmap? = runCatching {
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true
            connectTimeout = 4500
            readTimeout = 4500
            setRequestProperty("User-Agent", "HeyBroc-Android/2.0")
        }
        try {
            if (conn.responseCode in 200..299) {
                val imgSource = conn.getHeaderField("X-Image-Source").orEmpty()
                if (imgSource.contains("Category Illustration", ignoreCase = true)) {
                    null
                } else {
                    conn.inputStream.use { BitmapFactory.decodeStream(it) }
                }
            } else null
        } finally {
            conn.disconnect()
        }
    }.getOrNull()

    private fun loadThumbnailAsync(primaryUrl: String, fallbackApiUrl: String, target: ImageView, fallback: View) {
        bmpCache.get(primaryUrl)?.let { cached ->
            target.setImageBitmap(cached)
            fallback.visibility = View.GONE
            return
        }
        bmpCache.get(fallbackApiUrl)?.let { cached ->
            target.setImageBitmap(cached)
            fallback.visibility = View.GONE
            return
        }
        imgExecutor.execute {
            var bmp = fetchBitmapFromUrl(primaryUrl)
            var resolvedKey = primaryUrl
            if (bmp == null && primaryUrl != fallbackApiUrl) {
                bmp = fetchBitmapFromUrl(fallbackApiUrl)
                resolvedKey = fallbackApiUrl
            }
            if (bmp != null) {
                bmpCache.put(resolvedKey, bmp)
                mainHandler.post {
                    if (!isDestroyed && !isFinishing) {
                        target.setImageBitmap(bmp)
                        fallback.visibility = View.GONE
                    }
                }
            }
        }
    }

    /* ---------------- Guided Setup Helpers ---------------- */

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

    private fun runGuidedSetupStep() {
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
        val a11yServiceEnabled = isAccessibilityEnabled()

        if (!a11yServiceEnabled) {
            val subStep = getSetupSubStep()
            startPermissionWatcher()
            if (isInstalledFromPlayStore()) {
                scheduleSettingsToasts(
                    "Tap 'Installed apps' → 'HeyBroc' → flip switch ON!",
                    "Almost done! Tap 'HeyBroc' and turn the switch ON!"
                )
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            } else if (subStep == "2B") {
                setSetupSubStep("2C")
                scheduleSettingsToasts(
                    "Look at top-right ↑ Tap ⋮ (3 dots) → Allow restricted settings!",
                    "After tapping 'Allow restricted settings', press Back to return to HeyBroc!"
                )
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            } else if (subStep == "2C") {
                scheduleSettingsToasts(
                    "Tap 'Installed apps' → 'HeyBroc' → flip switch ON!",
                    "Almost done! Tap 'HeyBroc' and turn the switch ON!"
                )
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            } else {
                setSetupSubStep("2B")
                scheduleSettingsToasts(
                    "1) Tap 'Installed apps'  2) Tap greyed-out 'HeyBroc' once, then press Back!",
                    "After tapping greyed-out 'HeyBroc' once, press Back to return to HeyBroc for Step 2!"
                )
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
        } else {
            clearScheduledToasts()
            hideFloatingSetupHelper()
            renderScreen()
        }
    }

    private fun startPermissionWatcher() {
        watcherAttempts = 0
        mainHandler.removeCallbacks(permissionWatcher)
        mainHandler.postDelayed(permissionWatcher, 500)
    }

    private fun showProminentAccessibilityDisclosure(onAccepted: () -> Unit) {
        AlertDialog.Builder(this)
            .setTitle("Accessibility Service Disclosure")
            .setMessage(
                "HeyBroc uses the Android AccessibilityService API solely inside 13 supported grocery apps " +
                    "(Walmart, Instacart, Target, Kroger, ALDI, DoorDash, Uber Eats, Amazon Shopping / Amazon Fresh, Whole Foods Market, Sam's Club, BJ's, Costco, and Shipt) to:\n" +
                    "1) Inspect visible, non-editable screen text on device to detect grocery product pages and extract the visible product title and ingredient list,\n" +
                    "2) Extract visible cart item titles (up to 20 items on Cart screens) and \"in cart\" indicators so your Whole-Cart Health Check reflects your real cart, and\n" +
                    "3) When you tap \"Find in Store\" or \"Swap in Store\" on a Clean Swap, enter that replacement product into the active store's search bar for you.\n\n" +
                    "• What is transmitted: Matched grocery product title candidates, extracted ingredient text, active store identifier, your selected additive & allergy watchlist preferences, any claimed referral code, and a random install-scoped device ID (retained for up to 1 year for Pro entitlement and weekly swap accounting) are sent over HTTPS to heybroc.com/api/scan.\n" +
                    "• Scope & Safeguards: HeyBroc is restricted by Android package filter to the 13 supported grocery apps above, ignores password fields, payment fields, and chat/message containers on device before candidate extraction, never reads hardware identifiers, and never sells personal data."
            )
            .setCancelable(false)
            .setPositiveButton("I Agree & Continue") { _, _ ->
                AccessibilityConsent.grant(this)
                renderScreen()
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
            "nitrates" to "Nitrites & Curing Nitrates (2x)",
            "preservatives" to "Synthetic Preservatives (2x)",
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
                        if (checked) {
                            next.add(key)
                            next.remove("nitrites")
                        } else {
                            next.remove(key)
                            next.remove("nitrites")
                        }
                        prefs.edit().putStringSet("familyWatchlist", next).apply()
                        runCatching {
                            startService(
                                Intent(this@MainActivity, OverlayWindowService::class.java).apply {
                                    action = OverlayWindowService.ACTION_REFRESH_PILL
                                }
                            )
                        }
                        renderScreen()
                    }
                })
            }
        }
    }

    private fun dietaryWatchlistControls(onChanged: (() -> Unit)? = null): LinearLayout {
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val selected = prefs.getStringSet("dietaryWatchlist", emptySet())?.toMutableSet() ?: mutableSetOf()
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL

            // 1) Seed Oil Grading Toggle (ON by default — uncheck for pure European Yuka scoring)
            addView(
                label(
                    "🌻 SEED OIL SCORING (US VS. EUROPEAN YUKA)",
                    11f,
                    0xFF166534.toInt(),
                    bold = true
                ).apply {
                    letterSpacing = 0.06f
                    setPadding(0, 0, 0, dp(6))
                }
            )
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(8), dp(6), dp(8), dp(8))
                background = GradientDrawable().apply {
                    setColor(0xFFF0FDF4.toInt())
                    setStroke(dp(1), 0xFFBBF7D0.toInt())
                    cornerRadius = dp(10).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(12) }

                addView(CheckBox(this@MainActivity).apply {
                    text = "🌻 Penalize Seed Oils in 0–100 Grade"
                    textSize = 13.5f
                    setTextColor(0xFF14532D.toInt())
                    typeface = Typeface.DEFAULT_BOLD
                    isChecked = ScanApi.isSeedOilsEnabled(this@MainActivity)
                    setOnCheckedChangeListener { _, checked ->
                        ScanApi.setSeedOilsEnabled(this@MainActivity, checked)
                        if (!checked) {
                            val currentFw = prefs.getStringSet("familyWatchlist", emptySet()).orEmpty().toMutableSet()
                            if (currentFw.remove("seedOils")) {
                                prefs.edit().putStringSet("familyWatchlist", currentFw).apply()
                            }
                        }
                        runCatching {
                            startService(
                                Intent(this@MainActivity, OverlayWindowService::class.java).apply {
                                    action = OverlayWindowService.ACTION_REFRESH_PILL
                                }
                            )
                        }
                        renderScreen()
                        onChanged?.invoke()
                    }
                })
                addView(
                    label(
                        "Default ON: Dings Soybean, Canola, Corn & Sunflower oil so HeyBroc recommends Avocado/Olive oil swaps. Uncheck to ignore seed oils and see pure European Yuka grades.",
                        11.5f,
                        0xFF166534.toInt()
                    ).apply {
                        setPadding(dp(32), 0, dp(4), dp(2))
                    }
                )
            })

            // 2) Personal Allergy & Diabetes Watchlist
            addView(
                label(
                    "🛡️ PERSONAL ALLERGY & DIABETES ALERTS",
                    11f,
                    0xFF374151.toInt(),
                    bold = true
                ).apply {
                    letterSpacing = 0.06f
                    setPadding(0, 0, 0, dp(4))
                }
            )
            addView(
                label(
                    "Only checked boxes trigger warnings on your floating HeyBroc pill overlay and product cards. Unchecked boxes never appear.",
                    12f,
                    0xFF4B5563.toInt()
                ).apply {
                    setPadding(0, 0, 0, dp(8))
                }
            )
            ScanApi.DIETARY_OPTIONS.forEach { opt ->
                addView(LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(8), dp(6), dp(8), dp(6))
                    background = GradientDrawable().apply {
                        setColor(0xFFF9FAFB.toInt())
                        setStroke(dp(1), 0xFFE5E7EB.toInt())
                        cornerRadius = dp(10).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { bottomMargin = dp(6) }

                    addView(CheckBox(this@MainActivity).apply {
                        text = "${opt.icon} ${opt.label}"
                        textSize = 13.5f
                        setTextColor(0xFF111827.toInt())
                        typeface = Typeface.DEFAULT_BOLD
                        isChecked = opt.key in selected
                        setOnCheckedChangeListener { _, checked ->
                            val next = (prefs.getStringSet("dietaryWatchlist", emptySet()) ?: emptySet()).toMutableSet()
                            if (checked) {
                                next.add(opt.key)
                            } else {
                                next.remove(opt.key)
                            }
                            prefs.edit().putStringSet("dietaryWatchlist", next).apply()
                            runCatching {
                                startService(
                                    Intent(this@MainActivity, OverlayWindowService::class.java).apply {
                                        action = OverlayWindowService.ACTION_REFRESH_PILL
                                    }
                                )
                            }
                            renderScreen()
                            onChanged?.invoke()
                        }
                    })
                    addView(label(opt.subtitle, 11.5f, 0xFF6B7280.toInt()).apply {
                        setPadding(dp(32), 0, dp(4), dp(2))
                    })
                })
            }

            // 3) 2x Family Strictness Mode
            addView(
                label(
                    "⚡ 2X STRICTNESS MODE (DOUBLE PENALTY)",
                    11f,
                    0xFF374151.toInt(),
                    bold = true
                ).apply {
                    letterSpacing = 0.06f
                    setPadding(0, dp(10), 0, dp(4))
                }
            )
            addView(watchlistControls())
        }
    }

    private fun showAllergyAndDietModal() {
        val scroll = ScrollView(this).apply {
            setPadding(dp(18), dp(12), dp(18), dp(8))
            addView(dietaryWatchlistControls())
        }
        AlertDialog.Builder(this)
            .setTitle("🛡️ Allergies, Seed Oils & Strictness")
            .setView(scroll)
            .setPositiveButton("Save & Apply") { _, _ ->
                renderScreen()
            }
            .setNeutralButton("Reset Defaults") { _, _ ->
                val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
                prefs.edit()
                    .putStringSet("dietaryWatchlist", emptySet())
                    .putStringSet("familyWatchlist", emptySet())
                    .apply()
                ScanApi.setSeedOilsEnabled(this, true)
                runCatching {
                    startService(
                        Intent(this, OverlayWindowService::class.java).apply {
                            action = OverlayWindowService.ACTION_REFRESH_PILL
                        }
                    )
                }
                renderScreen()
            }
            .show()
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
        clearScheduledToasts()
        renderScreen()
    }

    override fun onStop() {
        super.onStop()
        if (Settings.canDrawOverlays(this) || isAccessibilityEnabled()) {
            runCatching {
                startService(Intent(this, OverlayWindowService::class.java).setAction(OverlayWindowService.ACTION_HIDE_IF_TEST))
            }
        }
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(permissionWatcher)
        pendingSuggestRunnable?.let { mainHandler.removeCallbacks(it) }
        io.shutdownNow()
        imgExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun launchTestPill() {
        if (!Settings.canDrawOverlays(this) && !isAccessibilityEnabled()) {
            Toast.makeText(this, "Turn on HeyBroc in Accessibility first", Toast.LENGTH_LONG).show()
            return
        }
        val appContext = applicationContext
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

    private fun hideKeyboard() {
        runCatching {
            val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
            currentFocus?.windowToken?.let { imm?.hideSoftInputFromWindow(it, 0) }
        }
    }

    /* ---------------- UI Helpers ---------------- */

    private fun yukaDotColor(score: Int): Int = when {
        score >= 75 -> 0xFF2E9E5B.toInt() // Excellent Green
        score >= 50 -> 0xFFD97706.toInt() // Mediocre Amber
        else -> 0xFFD93025.toInt()        // Poor Red
    }

    private fun ratingForScore(score: Int): String = when {
        score >= 75 -> "Excellent"
        score >= 50 -> "Mediocre"
        else -> "Poor"
    }

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
        textSize = 14.5f
        minHeight = dp(50)
        setPadding(dp(18), dp(12), dp(18), dp(12))
        setTextColor(if (filled) Color.WHITE else 0xFF2E9E5B.toInt())
        background = GradientDrawable().apply {
            cornerRadius = dp(999).toFloat()
            if (filled) setColor(0xFF2E9E5B.toInt()) else { setColor(Color.WHITE); setStroke(dp(1), 0xFF2E9E5B.toInt()) }
        }
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) }
    }

    private fun stepCard(step: String, title: String, body: String, status: TextView?, vararg extra: View) =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(18))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(20).toFloat()
                setStroke(dp(1), 0xFFE5E7EB.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(14) }

            addView(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                addView(label(step.uppercase(), 11f, 0xFF2E9E5B.toInt(), bold = true).apply {
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
