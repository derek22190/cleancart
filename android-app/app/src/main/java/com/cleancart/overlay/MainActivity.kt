package com.cleancart.overlay

import android.app.Activity
import android.app.AlertDialog
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
            val overlayOk = Settings.canDrawOverlays(this@MainActivity)
            val a11yOk = isAccessibilityEnabled() && AccessibilityConsent.granted(this@MainActivity)

            if (pendingAutoChainToA11y && overlayOk && !isAccessibilityEnabled()) {
                pendingAutoChainToA11y = false
                setSetupSubStep("2B")
                scheduleSettingsToasts(
                    "✓ Step 1 done! Tap 'Installed apps' → tap greyed-out 'HeyBroc' once, then press Back!",
                    "👉 Tap 'Installed apps' → tap greyed-out 'HeyBroc' once, then press Back to HeyBroc!"
                )
                runCatching {
                    startActivity(
                        Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                }
            }

            if (overlayOk && a11yOk) {
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
        val titleText = when (activeTab) {
            0 -> if (historyFavoritesOnly) "★ Favorites" else "My Scans"
            1 -> "Top Picks"
            2 -> "Clean Swaps"
            else -> "Search"
        }

        topBarContainer.addView(label(titleText, 27f, 0xFF111814.toInt(), bold = true).apply {
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })

        // On My Scans tab, show the ★ (Favorites filter) icon
        if (activeTab == 0) {
            topBarContainer.addView(label(
                if (historyFavoritesOnly) "★" else "☆",
                23f,
                if (historyFavoritesOnly) 0xFFEAB308.toInt() else 0xFF374151.toInt(),
                bold = true
            ).apply {
                setPadding(dp(10), dp(4), dp(10), dp(4))
                setOnClickListener {
                    historyFavoritesOnly = !historyFavoritesOnly
                    renderScreen()
                }
            })
        }

        // Account / Log in pill button
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val savedName = prefs.getString("auth_name", null)?.takeIf { it.isNotBlank() }
        val savedEmail = prefs.getString("auth_email", null)?.takeIf { it.isNotBlank() }
        val isLoggedIn = !savedEmail.isNullOrBlank()
        val displayAccountLabel = if (isLoggedIn) {
            "👤 ${(savedName ?: savedEmail!!.substringBefore("@")).take(10)}"
        } else {
            "👤 Log in"
        }

        topBarContainer.addView(label(
            displayAccountLabel,
            12f,
            if (isLoggedIn) 0xFF065F46.toInt() else 0xFF1F2937.toInt(),
            bold = true
        ).apply {
            setPadding(dp(11), dp(5), dp(11), dp(5))
            background = GradientDrawable().apply {
                setColor(if (isLoggedIn) 0xFFECFDF5.toInt() else 0xFFEFF1F0.toInt())
                setStroke(dp(1), if (isLoggedIn) 0xFF86EFAC.toInt() else 0xFFE4E7E5.toInt())
                cornerRadius = dp(999).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { marginEnd = dp(6) }
            setOnClickListener {
                showGoCoCoLoginDialog()
            }
        })

        // Top-right ⋮ menu / Bubble status button
        val ready = Settings.canDrawOverlays(this) && isAccessibilityEnabled() && AccessibilityConsent.granted(this)
        topBarContainer.addView(label(
            if (ready) "● Live" else "⚡ Setup",
            12f,
            if (ready) 0xFF16A34A.toInt() else 0xFF92400E.toInt(),
            bold = true
        ).apply {
            setPadding(dp(11), dp(5), dp(11), dp(5))
            background = GradientDrawable().apply {
                setColor(if (ready) 0xFFE8F7EE.toInt() else 0xFFFEF3C7.toInt())
                cornerRadius = dp(999).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { marginEnd = dp(4) }
            setOnClickListener {
                activeTab = 1
                topSubTab = "Bubble"
                renderScreen()
            }
        })

        topBarContainer.addView(label("⋮", 22f, 0xFF374151.toInt(), bold = true).apply {
            setPadding(dp(10), dp(4), dp(6), dp(4))
            setOnClickListener {
                showTopRightMenuDialog()
            }
        })
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
            "2B" -> "Step 2B of 2: Unlock Restricted Settings"
            "2C" -> "Step 2C of 2: Flip HeyBroc Switch ON"
            else -> "Step 2A of 2: Tap Greyed-Out HeyBroc Once"
        }
        val stepBody = when (subStep) {
            "2B" -> "Tap below to open App Info → tap ⋮ (3 dots in top-right corner) → tap 'Allow restricted settings'."
            "2C" -> "Restricted settings unlocked! Tap below → Installed apps → HeyBroc → flip the switch ON."
            else -> "Android requires tapping the greyed-out 'HeyBroc' in Accessibility → Installed apps once before the ⋮ 3-dot unlock menu appears."
        }
        val btnText = when (subStep) {
            "2B" -> "⚡ Open App Info (Tap ⋮ Top-Right 3 Dots) →"
            "2C" -> "⚡ Open Accessibility & Turn ON HeyBroc →"
            else -> "⚡ Step 2A: Open Installed Apps →"
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = GradientDrawable().apply {
                setColor(0xFF064E3B.toInt())
                cornerRadius = dp(18).toFloat()
                setStroke(dp(1), 0xFF10B981.toInt())
            }
            addView(label("LIVE STORE BUBBLE SETUP · 1 OF 2 DONE", 10.5f, 0xFFA7F3D0.toInt(), bold = true).apply {
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

    private fun renderHistoryTab() {
        val overlayOk = Settings.canDrawOverlays(this)
        val a11yServiceEnabled = isAccessibilityEnabled()
        val a11yOk = a11yServiceEnabled && AccessibilityConsent.granted(this)

        // Show the sleek auto-advancing dark-green Step 2 card (2A -> 2B -> 2C) when Step 1 is done
        if (overlayOk && !a11yServiceEnabled && !isInstalledFromPlayStore()) {
            tabContentContainer.addView(buildDarkGreenStep2Card(getSetupSubStep()).apply {
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply {
                    setMargins(dp(16), dp(4), dp(16), dp(10))
                }
            })
        } else if (!overlayOk || !a11yOk) {
            val done = (if (overlayOk) 1 else 0) + (if (a11yOk) 1 else 0)
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
                    addView(label("Enable Live Store Bubble ($done/2 ON)", 13.5f, 0xFF14532D.toInt(), bold = true))
                    addView(label("Auto-scan foods inside Walmart, Target & Instacart", 12f, 0xFF166534.toInt()))
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

        val items = if (historyFavoritesOnly) {
            ScanHistoryStore.getFavorites(this)
        } else {
            val combined = ArrayList<JSONObject>()
            val seen = HashSet<String>()
            (ScanHistoryStore.getHistory(this) + ScanHistoryStore.EXPLORE_CATALOG).forEach { it ->
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
        val yb = res?.optJSONObject("yukaBreakdown")
        val flagLen = res?.optJSONArray("flagged")?.length() ?: 0
        val rawScore = res?.optInt("score") ?: item.optInt("score", 50)
        val score = if (yb != null && flagLen == 0) {
            (yb.optInt("nutritionScore", 42) + yb.optInt("additiveScore", 30) + yb.optInt("organicScore", 0)).coerceIn(0, 100)
        } else {
            rawScore
        }
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
        (ScanHistoryStore.getHistory(this) + ScanHistoryStore.EXPLORE_CATALOG).forEach { it ->
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
    private fun buildYukaSideBySideSwapRow(badItem: JSONObject, swapObj: JSONObject): View {
        val prod = badItem.optJSONObject("product")
        val res = badItem.optJSONObject("result")
        val badTitle = ScanHistoryStore.extractTitle(badItem)
        val badBrand = prod?.optString("brand").orEmpty().ifBlank { badItem.optString("brand") }
        val badImg = prod?.optString("imageUrl").orEmpty().ifBlank { badItem.optString("imageUrl") }
        val badScore = res?.optInt("score") ?: 20
        val badRating = res?.optString("rating").orEmpty().ifBlank { ratingForScore(badScore) }

        val swapTitle = swapObj.optString("title", "Clean Swap")
        val swapBrand = swapObj.optString("brand", "Clean Pick")
        val swapScore = swapObj.optInt("score", 92)
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

        // Right Card (✓ Clean Swap Product)
        val rightCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(12), dp(12), dp(12), dp(14))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(18).toFloat()
                setStroke(dp(1), 0xFFE5E7EB.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = dp(6)
            }
            setOnClickListener {
                // Build a full preview item for the Clean Swap
                val swapPreview = JSONObject().apply {
                    put("ok", true)
                    put("product", JSONObject().apply {
                        put("title", swapTitle)
                        put("brand", swapBrand)
                        put("imageUrl", swapImg)
                        put("ingredients", swapObj.optString("ingredients"))
                    })
                    put("result", JSONObject().apply {
                        put("score", swapScore)
                        put("rating", swapRating)
                        put("color", "green")
                        put("flagged", JSONArray())
                    })
                }
                showProductDetailDialog(swapPreview)
            }
        }

        val rightTopBox = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(104))
        }
        rightTopBox.addView(buildProductImageBox(swapImg, swapTitle, dp(76), dp(96)).apply {
            layoutParams = FrameLayout.LayoutParams(dp(76), dp(96), Gravity.CENTER)
        })
        // Green ✓ circle badge in top-left of image
        rightTopBox.addView(label("✓", 13f, Color.WHITE, bold = true).apply {
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
        // Top-right ⋮ on the swap card (opens in Walmart)
        rightTopBox.addView(label("⋮", 18f, 0xFF374151.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            layoutParams = FrameLayout.LayoutParams(dp(28), dp(28), Gravity.TOP or Gravity.END)
            setOnClickListener { openWalmartSearch(swapTitle) }
        })
        rightCard.addView(rightTopBox)

        rightCard.addView(label(swapTitle, 14.5f, 0xFF111814.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setPadding(0, dp(6), 0, 0)
        })
        rightCard.addView(label(swapBrand, 13f, 0xFF6B7280.toInt()).apply {
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

            val catItems = ScanHistoryStore.EXPLORE_CATALOG
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
            addView(label("All top picks are 100% unlocked — plus auto-scan inside Walmart & Target", 14.5f, 0xFF111814.toInt()))
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
        searchCard.addView(label("SEARCH 4M+ FOODS & USDA CATALOG", 11f, 0xFF2E9E5B.toInt(), bold = true).apply {
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
            subtitle = "Auto-grade products while shopping in Walmart, Target, Instacart & ALDI."
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

        // Row 2: Food preferences (Family Watchlist)
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

        // Privacy Policy link at bottom
        wrap.addView(label("Privacy Policy & Accessibility Data Disclosure ↗", 13f, 0xFF6B7280.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(12))
            setOnClickListener {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.heybroc.com/privacy")))
            }
        })

        tabContentContainer.addView(wrap)
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

    private fun appendBubbleSetupAndWatchlistCards(target: LinearLayout, includeWatchlist: Boolean = true) {
        val overlayOk = Settings.canDrawOverlays(this)
        val a11yServiceEnabled = isAccessibilityEnabled()
        val consentOk = AccessibilityConsent.granted(this)
        val a11yOk = a11yServiceEnabled && consentOk

        if (overlayOk && a11yOk) {
            hideFloatingSetupHelper()
            val statusBadge = label("✓ ACTIVE & READY", 12f, 0xFF16A34A.toInt(), bold = true)
            target.addView(stepCard(
                "Store Bubble Active",
                "HeyBroc Floats Over Your Grocery Apps",
                "Open Walmart, Target, BJ's, ALDI, Instacart, Kroger, Costco, or DoorDash — the score bubble pops up automatically when you view food items.",
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
            val doneCount = (if (overlayOk) 1 else 0) + (if (a11yOk) 1 else 0)
            val statusBadge = label("$doneCount of 2 enabled", 12f, 0xFF7A5B00.toInt(), bold = true)
            val subStep = getSetupSubStep()

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
                subStep == "2B" && !isInstalledFromPlayStore() -> "⚡ Step 2B: Open App Info (Tap ⋮ Top-Right 3 Dots) →"
                subStep == "2C" && !isInstalledFromPlayStore() -> "⚡ Step 2C: Open Accessibility & Turn ON HeyBroc →"
                else -> "⚡ Step 2A: Open Accessibility → Installed apps →"
            }

            val extras = mutableListOf<View>(
                checklist,
                primaryButton(mainActionLabel) { runGuidedSetupStep() }
            )

            if (overlayOk && !a11yServiceEnabled && !isInstalledFromPlayStore()) {
                extras.add(
                    label(
                        "Why don't the ⋮ (3 dots) show up in App Info right away?\n" +
                            "• Step 2A (Required first): Open Accessibility → Installed apps and tap the greyed-out \"HeyBroc\" once. Android hides the ⋮ 3-dot menu in App Info until you tap the greyed-out HeyBroc first!\n" +
                            "• Step 2B: Only AFTER tapping the greyed-out HeyBroc, open App Info below → tap ⋮ (top-right 3 dots) → \"Allow restricted settings\".\n" +
                            "• Step 2C: Go back to Accessibility → Installed apps → HeyBroc and flip it ON.",
                        12.5f, 0xFF7A5B00.toInt(),
                    ).apply {
                        setPadding(dp(12), dp(10), dp(12), dp(10))
                        background = GradientDrawable().apply { setColor(0xFFFDF6DC.toInt()); cornerRadius = dp(12).toFloat() }
                    }
                )
                extras.add(
                    primaryButton("Step 2B: Open App Info (Tap ⋮ Top-Right 3 Dots)", filled = false) {
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
                "Quick 1-Time Setup",
                if (!overlayOk) "Enable Store Bubble in 2 Switches" else "Almost Done — Turn ON HeyBroc",
                if (!overlayOk) {
                    "Tap below and HeyBroc will automatically take you from Switch 1 straight to Switch 2."
                } else {
                    "Follow Steps 2A → 2B → 2C below to unlock and turn on HeyBroc in Accessibility."
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
            "👤 Log in / Sign up (Email, Google, Apple)"
        }
        val options = arrayOf(
            authOption,
            "Manage Live Store Bubble",
            "Food Preferences (Family Watchlist)",
            "★ View Saved Favorites",
            "🗑️ Clear Scan History",
            "🔒 Privacy Policy & Data Disclosure"
        )
        AlertDialog.Builder(this)
            .setTitle("HeyBroc Menu")
            .setItems(options) { _, which ->
                when (which) {
                    0 -> showGoCoCoLoginDialog()
                    1 -> { activeTab = 1; topSubTab = "Bubble"; renderScreen() }
                    2 -> { activeTab = 3; expandedPrefSection = "prefs"; renderScreen() }
                    3 -> { activeTab = 0; historyFavoritesOnly = true; renderScreen() }
                    4 -> { ScanHistoryStore.clearHistory(this); renderScreen() }
                    5 -> startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.heybroc.com/privacy")))
                }
            }
            .show()
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
            setPadding(dp(22), dp(20), dp(22), dp(22))
            setBackgroundColor(Color.WHITE)
        }
        scroll.addView(card)

        // Top row: Circular < back button + Peeking Broc mascot in angled doorway
        val topRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, 0, 0, dp(8))
        }
        val backCircle = label("‹", 24f, 0xFF18181B.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(46), dp(46))
            background = GradientDrawable().apply {
                setColor(0xFFEFF1F0.toInt())
                setStroke(dp(1), 0xFFE4E7E5.toInt())
                cornerRadius = dp(999).toFloat()
            }
            setOnClickListener { authDialog?.dismiss() }
        }
        topRow.addView(backCircle)
        topRow.addView(View(this).apply {
            layoutParams = LinearLayout.LayoutParams(0, dp(1), 1f)
        })
        val mascotDoorBox = LinearLayout(this).apply {
            gravity = Gravity.CENTER
            setPadding(dp(8), dp(6), dp(8), dp(6))
            background = GradientDrawable().apply {
                setColor(0xFFDCFCE7.toInt())
                setStroke(dp(2), 0xFFF1F5F9.toInt())
                cornerRadius = dp(16).toFloat()
            }
            rotation = -12f
            addView(ImageView(this@MainActivity).apply {
                setImageResource(R.drawable.broc_mascot)
                layoutParams = LinearLayout.LayoutParams(dp(48), dp(48))
                scaleType = ImageView.ScaleType.FIT_CENTER
            })
        }
        topRow.addView(mascotDoorBox)
        card.addView(topRow)

        if (savedEmail != null) {
            // ================= LOGGED-IN ACCOUNT VIEW =================
            card.addView(label("Account", 28f, 0xFF18181B.toInt(), bold = true))
            card.addView(label(
                "Signed in and syncing your Watchlist, Favorites & Family Pro across devices.",
                14f,
                0xFF71717A.toInt()
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
            profileCard.addView(label(savedEmail, 13.5f, 0xFF475569.toInt()).apply { setPadding(0, dp(2), 0, dp(4)) })
            val providerBadge = when (savedProvider) {
                "google" -> "✓ Signed in with Google (Gmail)"
                "apple" -> "✓ Signed in with Apple"
                else -> "✓ Signed in with Email"
            }
            profileCard.addView(label(providerBadge, 12f, 0xFF0F7A4A.toInt(), bold = true))
            card.addView(profileCard)

            card.addView(label("Continue Shopping  →", 16f, Color.WHITE, bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(16), dp(15), dp(16), dp(15))
                background = GradientDrawable().apply {
                    setColor(0xFF0F7A4A.toInt())
                    cornerRadius = dp(22).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(16) }
                setOnClickListener { authDialog?.dismiss() }
            })

            card.addView(label("Log out of this device", 15f, 0xFF18181B.toInt(), bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(16), dp(14), dp(16), dp(14))
                background = GradientDrawable().apply {
                    setColor(0xFFEFF1F0.toInt())
                    cornerRadius = dp(22).toFloat()
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
                        "Signed out. Continuing in Guest mode (all scans & store swaps active).",
                        Toast.LENGTH_LONG
                    ).show()
                }
            })

            card.addView(label("Delete account & cloud data", 12.5f, 0xFFDC2626.toInt()).apply {
                gravity = Gravity.CENTER
                setPadding(dp(8), dp(14), dp(8), dp(4))
                setOnClickListener {
                    AlertDialog.Builder(this@MainActivity)
                        .setTitle("Delete HeyBroc Account?")
                        .setMessage("Permanently delete $savedEmail and cloud data? You can continue using HeyBroc as a Guest anytime.")
                        .setPositiveButton("Delete Account") { _, _ ->
                            val tok = prefs.getString("auth_token", "") ?: ""
                            io.execute {
                                runCatching {
                                    val conn = (URL("https://www.heybroc.com/api/auth").openConnection() as HttpURLConnection).apply {
                                        requestMethod = "POST"
                                        doOutput = true
                                        setRequestProperty("Content-Type", "application/json")
                                        connectTimeout = 6000
                                        readTimeout = 6000
                                    }
                                    val payload = JSONObject()
                                        .put("action", "delete_account")
                                        .put("email", savedEmail)
                                        .put("token", tok)
                                        .toString()
                                    conn.outputStream.use { it.write(payload.toByteArray()) }
                                    conn.responseCode
                                }
                            }
                            prefs.edit()
                                .remove("auth_email")
                                .remove("auth_name")
                                .remove("auth_provider")
                                .remove("auth_token")
                                .apply()
                            authDialog?.dismiss()
                            renderScreen()
                            Toast.makeText(this@MainActivity, "Account deleted.", Toast.LENGTH_SHORT).show()
                        }
                        .setNegativeButton("Cancel", null)
                        .show()
                }
            })

            authDialog = AlertDialog.Builder(this).setView(scroll).show()
            return
        }

        // ================= GOCOCO-STYLE LOGIN VIEW =================
        card.addView(label("Log in", 29f, 0xFF18181B.toInt(), bold = true))
        card.addView(label(
            "Welcome back to HeyBroc, we have missed you!",
            15f,
            0xFF71717A.toInt()
        ).apply { setPadding(0, dp(4), 0, dp(18)) })

        // Pill input 1: Email
        val emailInput = EditText(this).apply {
            hint = "Email"
            setHintTextColor(0xFF52525B.toInt())
            setTextColor(0xFF18181B.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
            setSingleLine(true)
            setPadding(dp(20), dp(17), dp(20), dp(17))
            background = GradientDrawable().apply {
                setColor(0xFFEFF1F0.toInt())
                setStroke(dp(1), 0xFFE4E7E5.toInt())
                cornerRadius = dp(22).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(10) }
        }
        card.addView(emailInput)

        // Pill input 2: Password + Eyelash toggle
        val passRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(20), dp(4), dp(12), dp(4))
            background = GradientDrawable().apply {
                setColor(0xFFEFF1F0.toInt())
                setStroke(dp(1), 0xFFE4E7E5.toInt())
                cornerRadius = dp(22).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(10) }
        }
        var passVisible = false
        val passInput = EditText(this).apply {
            hint = "Password"
            setHintTextColor(0xFF52525B.toInt())
            setTextColor(0xFF18181B.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            setSingleLine(true)
            background = null
            setPadding(0, dp(13), dp(8), dp(13))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        val eyeToggle = label("︶", 17f, 0xFF18181B.toInt(), bold = true).apply {
            setPadding(dp(10), dp(8), dp(10), dp(8))
            setOnClickListener {
                passVisible = !passVisible
                text = if (passVisible) "👁" else "︶"
                passInput.inputType = if (passVisible) {
                    android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                } else {
                    android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
                }
                passInput.setSelection(passInput.text?.length ?: 0)
            }
        }
        passRow.addView(passInput)
        passRow.addView(eyeToggle)
        card.addView(passRow)

        // Pill button: Forgot password?
        val forgotBtn = label("Forgot password?  🔑", 15f, 0xFF18181B.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = GradientDrawable().apply {
                setColor(0xFFEFF1F0.toInt())
                setStroke(dp(1), 0xFFE4E7E5.toInt())
                cornerRadius = dp(22).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(12) }
            setOnClickListener {
                Toast.makeText(
                    this@MainActivity,
                    "Enter your email and your new 6+ character password above, then tap Log in → to reset!",
                    Toast.LENGTH_LONG
                ).show()
            }
        }
        card.addView(forgotBtn)

        // "or continue with" divider
        card.addView(label("or continue with", 14.5f, 0xFF71717A.toInt()).apply {
            gravity = Gravity.CENTER
            setPadding(0, dp(2), 0, dp(10))
        })

        // Sky-blue pill: Continue with Google (Gmail)
        val googleBtn = label("G   Continue with Google (Gmail)", 15f, 0xFF0C4A6E.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(15), dp(16), dp(15))
            background = GradientDrawable().apply {
                setColor(0xFFC7E8FF.toInt())
                setStroke(dp(1), 0xFF93C5FD.toInt())
                cornerRadius = dp(22).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(10) }
            setOnClickListener {
                authDialog?.dismiss()
                showOAuthEmailPromptDialog("google")
            }
        }
        card.addView(googleBtn)

        // Dark pill: Continue with Apple
        val appleBtn = label("   Continue with Apple", 15f, Color.WHITE, bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(15), dp(16), dp(15))
            background = GradientDrawable().apply {
                setColor(0xFF18181B.toInt())
                cornerRadius = dp(22).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(18) }
            setOnClickListener {
                authDialog?.dismiss()
                showOAuthEmailPromptDialog("apple")
            }
        }
        card.addView(appleBtn)

        // Bottom Primary Pill: Log in [→]
        val submitBtn = label("Log in   →", 16.5f, Color.WHITE, bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(16), dp(16), dp(16))
            background = GradientDrawable().apply {
                setColor(0xFF0F7A4A.toInt())
                cornerRadius = dp(22).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(10) }
            setOnClickListener {
                val em = emailInput.text.toString().trim().lowercase()
                val pw = passInput.text.toString()
                if (!em.contains("@")) {
                    Toast.makeText(this@MainActivity, "Please enter a valid email address.", Toast.LENGTH_SHORT).show()
                    return@setOnClickListener
                }
                if (pw.length < 6) {
                    Toast.makeText(this@MainActivity, "Password must be at least 6 characters.", Toast.LENGTH_SHORT).show()
                    return@setOnClickListener
                }
                completeMobileAuth(em, em.substringBefore("@"), "email", pw)
                authDialog?.dismiss()
            }
        }
        card.addView(submitBtn)

        // Continue as Guest link
        card.addView(label("Continue as Guest →", 13.5f, 0xFF71717A.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(8), dp(6), dp(8), dp(4))
            setOnClickListener { authDialog?.dismiss() }
        })

        authDialog = AlertDialog.Builder(this).setView(scroll).show()
    }

    private fun showOAuthEmailPromptDialog(provider: String) {
        val isGoogle = provider == "google"
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(20), dp(22), dp(10))
        }
        box.addView(label(
            if (isGoogle) "Sign in with Google (Gmail)" else "Sign in with Apple",
            20f,
            0xFF18181B.toInt(),
            bold = true
        ))
        box.addView(label(
            if (isGoogle) {
                "Enter your Gmail address to link your HeyBroc account & sync Family Pro across devices."
            } else {
                "Enter your Apple ID email to link your HeyBroc account & sync Family Pro across devices."
            },
            13.5f,
            0xFF64748B.toInt()
        ).apply { setPadding(0, dp(4), 0, dp(12)) })

        val input = EditText(this).apply {
            hint = if (isGoogle) "yourname@gmail.com" else "yourname@icloud.com"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
            setSingleLine(true)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = GradientDrawable().apply {
                setColor(0xFFEFF1F0.toInt())
                cornerRadius = dp(16).toFloat()
            }
        }
        box.addView(input)

        AlertDialog.Builder(this)
            .setView(box)
            .setPositiveButton(if (isGoogle) "Continue with Gmail" else "Continue with Apple") { _, _ ->
                val em = input.text.toString().trim().lowercase()
                if (!em.contains("@")) {
                    Toast.makeText(this, "Please enter a valid email address.", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                completeMobileAuth(em, em.substringBefore("@"), provider, null)
            }
            .setNegativeButton("Back") { _, _ ->
                showGoCoCoLoginDialog()
            }
            .show()
    }

    private fun completeMobileAuth(email: String, fallbackName: String, provider: String, password: String?) {
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        prefs.edit()
            .putString("auth_email", email)
            .putString("auth_name", fallbackName)
            .putString("auth_provider", provider)
            .apply()
        renderScreen()
        Toast.makeText(this, "👋 Welcome back, $fallbackName! Account synced.", Toast.LENGTH_LONG).show()

        io.execute {
            runCatching {
                val conn = (URL("https://www.heybroc.com/api/auth").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    connectTimeout = 7000
                    readTimeout = 7000
                }
                val payload = JSONObject().apply {
                    put("action", if (provider == "email") "login" else "oauth")
                    put("provider", provider)
                    put("email", email)
                    put("displayName", fallbackName)
                    put("deviceId", ScanApi.deviceId(this@MainActivity))
                    if (!password.isNullOrBlank()) put("password", password)
                }.toString()
                conn.outputStream.use { it.write(payload.toByteArray()) }
                val raw = conn.inputStream.bufferedReader().use { it.readText() }
                val json = JSONObject(raw)
                if (json.optBoolean("ok")) {
                    val tok = json.optString("token", "")
                    val usr = json.optJSONObject("user")
                    val resolvedName = usr?.optString("displayName", fallbackName) ?: fallbackName
                    ScanApi.saveEntitlementSnapshot(this@MainActivity, usr)
                    prefs.edit()
                        .putString("auth_token", tok)
                        .putString("auth_name", resolvedName)
                        .apply()
                    mainHandler.post { renderScreen() }
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
        io.execute {
            val raw = runCatching { ScanApi.scan(appCtx, query, "", "walmart") }.getOrNull()
            val parsed = raw?.let { runCatching { JSONObject(it) }.getOrNull() }
            runOnUiThread {
                if (isDestroyed || isFinishing) return@runOnUiThread
                isSearching = false
                if (parsed?.optBoolean("ok") == true) {
                    ScanHistoryStore.recordScan(this, parsed, "search")
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
        val rawScore = res?.optInt("score") ?: item.optInt("score", 50)
        val score = if (yb != null && flagCount == 0) {
            (yb.optInt("nutritionScore", 42) + yb.optInt("additiveScore", 30) + yb.optInt("organicScore", 0)).coerceIn(0, 100)
        } else {
            rawScore
        }
        val rating = ratingForScore(score)
        val tone = yukaDotColor(score)
        val swap = item.optJSONObject("swap")

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

        // 3-Pillar Score Breakdown Box
        val nutScore = yb?.optInt("nutritionScore", 42) ?: 42
        val nutGrade = yb?.optString("nutriScoreGrade", "B") ?: "B"
        val addScore = yb?.optInt("additiveScore", if (flagCount == 0) 30 else 0) ?: 0
        val orgScore = yb?.optInt("organicScore", if (title.contains("organic", true)) 10 else 0) ?: 0

        val hasHighGlycemicIng = Regex("\\b(high fructose corn syrup|corn syrup|maltodextrin|dextrose|glucose syrup|cane sugar|sucrose)\\b", RegexOption.IGNORE_CASE).containsMatchIn(ingredients)
        val hasStarchBase = Regex("\\b(enriched.*flour|corn\\s*starch|tapioca\\s*starch|potato\\s*starch|cassava\\s*flour|rice\\s*flour)\\b", RegexOption.IGNORE_CASE).containsMatchIn(ingredients)
        val defaultGlucoseImpact = when {
            hasHighGlycemicIng || nutGrade == "E" -> "High Spike"
            hasStarchBase || nutGrade == "C" || nutGrade == "D" -> "Moderate Spike"
            else -> "Low Spike"
        }
        val glucoseImpact = yb?.optString("glucoseImpact")?.takeIf { it.isNotBlank() } ?: defaultGlucoseImpact
        val glucoseNote = yb?.optString("glucoseNote")?.takeIf { it.isNotBlank() } ?: when (glucoseImpact) {
            "High Spike" -> "High glucose spike risk — concentrated sugars or fast-absorbing syrups can rapidly elevate blood sugar (watch for Type 2 Diabetes & PCOS)."
            "Moderate Spike" -> "Moderate glucose impact — contains fast-digesting starches or sugars; pair with protein or fiber to steady blood sugar."
            else -> "Steady glycemic profile — low added sugar and minimal glucose spike risk (PCOS & blood-sugar friendly)."
        }
        val calorieNote = yb?.optString("calorieNote")?.takeIf { it.isNotBlank() } ?: when (nutGrade) {
            "A", "B" -> "Calorie-Smart"
            "C" -> "Moderate Calories"
            else -> "Calorie-Dense"
        }
        val glucoseBadgeColor = when (glucoseImpact) {
            "High Spike" -> 0xFFD93025.toInt()
            "Moderate Spike" -> 0xFFEA8600.toInt()
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
            addView(label("🧪 Additive Safety: $addScore/30   ·   🌱 Organic Bonus: $orgScore/10", 12.5f, 0xFF4B5563.toInt()).apply {
                setPadding(0, dp(2), 0, 0)
            })
            addView(View(context).apply {
                setBackgroundColor(0xFFE5E7EB.toInt())
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)).apply {
                    topMargin = dp(8)
                    bottomMargin = dp(8)
                }
            })
            addView(label("BLOOD SUGAR, PCOS & CALORIE INSIGHT", 10.5f, 0xFF6B7280.toInt(), bold = true).apply { letterSpacing = 0.06f })
            addView(label("🩸 Glucose Impact: $glucoseImpact  ·  🔥 $calorieNote", 12.5f, glucoseBadgeColor, bold = true).apply {
                setPadding(0, dp(3), 0, 0)
            })
            addView(label(glucoseNote, 11.5f, 0xFF4B5563.toInt()).apply {
                setPadding(0, dp(2), 0, 0)
            })
        })

        // Flagged Additives List
        if (flagCount == 0) {
            sheet.addView(label("✓ No Hazardous Additives — Clean Label", 13.5f, 0xFF16A34A.toInt(), bold = true).apply {
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
                    "high" -> "Hazardous"
                    "moderate" -> "Moderate risk"
                    else -> "Limited risk"
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

        // Clean Swap Card (with real product photo)
        if (swap != null) {
            val swapTitle = swap.optString("title", "Clean Swap")
            val swapScore = swap.optInt("score", 92)
            val swapImg = swap.optString("image").ifBlank { swap.optString("imageUrl") }
            val swapIng = swap.optString("ingredients").ifBlank { swap.optString("cleanIngredients") }

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
            swapCard.addView(label("✓ CLEAN SWAP · $swapScore/100 EXCELLENT", 11f, 0xFF166534.toInt(), bold = true).apply {
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
            val itemStoreKey = item.optString("storeKey").ifBlank { item.optString("store", "walmart") }
            val storeDisplayName = when (itemStoreKey.lowercase()) {
                "target" -> "Target"
                "instacart" -> "Instacart"
                "aldi" -> "ALDI"
                "bjs" -> "BJ's"
                "costco" -> "Costco"
                "kroger" -> "Kroger"
                "sams" -> "Sam's Club"
                "amazon" -> "Amazon Fresh"
                else -> "Store"
            }
            swapCard.addView(label("🛒 Find Clean Swap in $storeDisplayName ↗", 13.5f, Color.WHITE, bold = true).apply {
                gravity = Gravity.CENTER
                setPadding(dp(12), dp(11), dp(12), dp(11))
                background = GradientDrawable().apply {
                    setColor(0xFF2E9E5B.toInt())
                    cornerRadius = dp(999).toFloat()
                }
                setOnClickListener { openStoreSwap(swapTitle, itemStoreKey, swap) }
            })
            sheet.addView(swapCard)
        }

        sheetScroll.addView(sheet)
        AlertDialog.Builder(this)
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
            suggestionsBox.addView(label("🔍  Grade \"$query\" across 4M+ foods →", 13.5f, 0xFF2E9E5B.toInt(), bold = true).apply {
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

    private fun buildProductImageBox(imgUrl: String, title: String, wPx: Int, hPx: Int): FrameLayout {
        val box = FrameLayout(this)
        val fallback = label(
            when {
                title.contains("monster", true) || title.contains("red bull", true) || title.contains("energy", true) || title.contains("celsius", true) || title.contains("c4", true) || title.contains("pre-workout", true) || title.contains("alani", true) || title.contains("ghost", true) -> "⚡"
                title.contains("coca-cola", true) || title.contains("coke", true) || title.contains("pepsi", true) || title.contains("soda", true) || title.contains("mountain dew", true) || title.contains("olipop", true) || title.contains("poppi", true) -> "🥤"
                title.contains("water", true) || title.contains("seltzer", true) || title.contains("spindrift", true) || title.contains("lacroix", true) || title.contains("fiji", true) || title.contains("gatorade", true) || title.contains("prime", true) -> "💧"
                title.contains("juice", true) || title.contains("orange", true) || title.contains("lemonade", true) || title.contains("sunnyd", true) || title.contains("smoothie", true) -> "🧃"
                title.contains("coffee", true) || title.contains("frappuccino", true) || title.contains("tea", true) || title.contains("mate", true) || title.contains("kombucha", true) -> "☕"
                title.contains("ranch", true) || title.contains("salad", true) -> "🥗"
                title.contains("milk", true) || title.contains("butter", true) || title.contains("oat", true) || title.contains("protein", true) -> "🥛"
                title.contains("soup", true) || title.contains("chowder", true) -> "🍲"
                title.contains("cereal", true) || title.contains("granola", true) -> "🥣"
                title.contains("peanut", true) -> "🥜"
                title.contains("bread", true) -> "🍞"
                title.contains("chocolate", true) -> "🍫"
                else -> "🛒"
            },
            22f, 0xFF111814.toInt()
        ).apply {
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                setColor(0xFFF9FAFB.toInt())
                cornerRadius = dp(10).toFloat()
            }
            layoutParams = FrameLayout.LayoutParams(wPx, hPx)
        }
        box.addView(fallback)

        val iv = ImageView(this).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
            layoutParams = FrameLayout.LayoutParams(wPx, hPx)
        }
        box.addView(iv)

        val fallbackApiUrl = ScanHistoryStore.productImageUrl(title)
        val primaryUrl = if (imgUrl.startsWith("http") && !imgUrl.contains("/swaps/") && !imgUrl.contains("/products/")) imgUrl else fallbackApiUrl
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

    private fun openStoreSwap(query: String, storeKey: String = "walmart", swapObj: JSONObject? = null) {
        if (!ScanApi.canUseSwap(this)) {
            ScanApi.trackEvent(this, "paywall_viewed")
            val limit = ScanApi.weeklySwapsLimit(this)
            AlertDialog.Builder(this)
                .setTitle(ScanApi.paywallHeadline(this))
                .setMessage(
                    "You've used all $limit free single-item swaps this week.\n\n" +
                        "Product scores (0–100) and Cart Avg stay 100% free forever. Upgrade to HeyBroc Family Pro for unlimited 1-tap clean swaps across all 12 stores."
                )
                .setPositiveButton("Upgrade to Pro") { _, _ ->
                    ScanApi.trackEvent(this, "checkout_started")
                    runCatching {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ScanApi.upgradeUrl(this))))
                    }
                }
                .setNegativeButton("Not Now", null)
                .show()
            return
        }

        if (query.isNotBlank()) {
            ScanApi.consumeSwap(this, query)
        }

        val explicitDeepLink = swapObj?.optString("deepLink").orEmpty().ifBlank { swapObj?.optString("webUrl").orEmpty() }
        val explicitPkg = swapObj?.optString("androidPackage").orEmpty()
        if (explicitDeepLink.startsWith("http")) {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(explicitDeepLink))
            try {
                startActivity(Intent(intent).apply { if (explicitPkg.isNotBlank()) setPackage(explicitPkg) })
                return
            } catch (_: Exception) {
                if (runCatching { startActivity(intent) }.isSuccess) return
            }
        }

        val encoded = Uri.encode(query)
        val url = when (storeKey.lowercase()) {
            "target" -> "https://www.target.com/s?searchTerm=$encoded"
            "instacart" -> "https://www.instacart.com/store/s?k=$encoded"
            "aldi" -> "https://shop.aldi.us/store/aldi/s?k=$encoded"
            "bjs" -> "https://www.bjs.com/search/$encoded"
            "costco" -> "https://www.costco.com/CatalogSearch?keyword=$encoded"
            "kroger" -> "https://www.kroger.com/search?query=$encoded"
            "sams" -> "https://www.samsclub.com/s/$encoded"
            "amazon" -> "https://www.amazon.com/s?k=$encoded&i=amazonfresh"
            else -> "https://www.walmart.com/search?q=$encoded"
        }
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
                conn.inputStream.use { BitmapFactory.decodeStream(it) }
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
        val overlayOk = Settings.canDrawOverlays(this)
        val a11yServiceEnabled = isAccessibilityEnabled()

        if (!overlayOk) {
            pendingAutoChainToA11y = !a11yServiceEnabled
            startPermissionWatcher()
            Toast.makeText(this, "Turn ON \"HeyBroc\" here — we'll open Step 2 automatically!", Toast.LENGTH_LONG).show()
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        } else if (!a11yServiceEnabled) {
            val subStep = getSetupSubStep()
            startPermissionWatcher()
            if (subStep == "2B" && !isInstalledFromPlayStore()) {
                setSetupSubStep("2C")
                scheduleSettingsToasts(
                    "Look at top-right ↑ Tap ⋮ (3 dots) → Allow restricted settings!",
                    "After tapping 'Allow restricted settings', press Back to return to HeyBroc!"
                )
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            } else if (subStep == "2C" && !isInstalledFromPlayStore()) {
                scheduleSettingsToasts(
                    "Tap 'Installed apps' → 'HeyBroc' → flip switch ON!",
                    "Almost done! Tap 'HeyBroc' and turn the switch ON!"
                )
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            } else {
                setSetupSubStep("2B")
                scheduleSettingsToasts(
                    "1) Tap 'Installed apps'  2) Tap greyed-out 'HeyBroc' once, then press Back!",
                    "After tapping greyed-out 'HeyBroc' once, press Back to return to HeyBroc for Step 2B!"
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
                "HeyBroc uses the Android AccessibilityService API solely inside 12 supported grocery apps " +
                    "(Walmart, Instacart, Target, Kroger, ALDI, DoorDash, Uber Eats, Amazon Fresh, Sam's Club, BJ's, Costco, and Shipt) to:\n" +
                    "1) Detect when you view a grocery product page and read the visible product title and ingredient list, and\n" +
                    "2) Read visible cart item titles (up to 20 items on Cart screens) and \"in cart\" indicators so your Whole-Cart Health Check reflects your real cart.\n\n" +
                    "• What is transmitted: Extracted grocery product titles, ingredient text, active store identifier, your selected additive watchlist categories, any claimed referral code, and a random install-scoped device ID (retained for up to 1 year for Pro entitlement and weekly swap accounting) are sent over HTTPS to heybroc.com/api/scan.\n" +
                    "• What is NEVER read: HeyBroc never reads hardware identifiers, passwords, payment fields, messages, or any other apps on your device, and never sells or shares personal data."
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
                        if (checked) {
                            next.add(key)
                            if (key == "preservatives") next.add("nitrites")
                        } else {
                            next.remove(key)
                            if (key == "preservatives") next.remove("nitrites")
                        }
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
        clearScheduledToasts()
        if (pendingAutoChainToA11y && Settings.canDrawOverlays(this) && !isAccessibilityEnabled()) {
            pendingAutoChainToA11y = false
            setSetupSubStep("2B")
            renderScreen()
            scheduleSettingsToasts(
                "✓ Step 1 done! Tap 'Installed apps' → tap greyed-out 'HeyBroc' once, then press Back!",
                "👉 Tap 'Installed apps' → tap greyed-out 'HeyBroc' once, then press Back to HeyBroc!"
            )
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            return
        }
        renderScreen()
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
        pendingSuggestRunnable?.let { mainHandler.removeCallbacks(it) }
        io.shutdownNow()
        imgExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun launchTestPill() {
        if (!Settings.canDrawOverlays(this)) {
            Toast.makeText(this, "Tap Start Guided Setup first", Toast.LENGTH_LONG).show()
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
        score >= 50 -> 0xFF66BB6A.toInt() // Good Light Green
        score >= 25 -> 0xFFEA8600.toInt() // Poor Orange
        else -> 0xFFD93025.toInt()        // Bad Red
    }

    private fun ratingForScore(score: Int): String = when {
        score >= 75 -> "Excellent"
        score >= 50 -> "Good"
        score >= 25 -> "Poor"
        else -> "Bad"
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
