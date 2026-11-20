package com.cleancart.overlay

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
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
import android.view.ViewOutlineProvider
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import android.graphics.Rect
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.PriorityBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * 4-Tab HeyBroc Android App:
 *   - Tab 0 (Scans / My Scans): Clean white product list with ★ Favorites filter & top-right ⋮ menu, real product photos, ● Excellent/Good/Poor/Bad dots, and relative time.
 *   - Tab 1 (Top Picks): "Top Picks" with Food | Store Bubble sub-tabs and pastel rounded-square category rows (Peanut Butter, Cereals & Granolas, Soups & Chowders, etc.).
 *   - Tab 2 (Swaps / Clean Swaps): Side-by-side 2-column comparison cards (⊗ Flagged Product ⇄ ✓ Clean Swap).
 *   - Tab 3 (Search): GPS-style instant autocomplete product search bar + expandable accordion cards for "Live Store Bubble" and "Food preferences (Family Watchlist)".
 *   - Floating green "[||| Scan]" FAB in the bottom-right corner above the 4-tab bar.
 */
class MainActivity : Activity() {

    private class PriorityImageTask(
        val priority: Int,
        val seq: Int,
        private val block: () -> Unit
    ) : Runnable, Comparable<PriorityImageTask> {
        override fun run() = block()
        override fun compareTo(other: PriorityImageTask): Int {
            val cmp = priority.compareTo(other.priority)
            return if (cmp != 0) cmp else seq.compareTo(other.seq)
        }
    }

    private data class DeferredThumbLoader(
        val view: View,
        val epoch: Int,
        val trigger: () -> Unit
    )

    private lateinit var rootFrame: FrameLayout
    private lateinit var topBarContainer: LinearLayout
    private lateinit var contentScroll: ScrollView
    private lateinit var tabContentContainer: LinearLayout
    private lateinit var bottomNavContainer: LinearLayout
    private lateinit var floatingScanBtn: LinearLayout

    private val io = Executors.newSingleThreadExecutor()
    private var activeAuthDialog: AlertDialog? = null
    private var activeFunnelDialog: AlertDialog? = null
    private val imgExecutor = ThreadPoolExecutor(
        6,
        6,
        30L,
        TimeUnit.SECONDS,
        PriorityBlockingQueue<Runnable>(32, Comparator<Runnable> { a, b ->
            val pa = (a as? PriorityImageTask)?.priority ?: Int.MAX_VALUE
            val pb = (b as? PriorityImageTask)?.priority ?: Int.MAX_VALUE
            val cmp = pa.compareTo(pb)
            if (cmp != 0) cmp
            else ((a as? PriorityImageTask)?.seq ?: 0).compareTo((b as? PriorityImageTask)?.seq ?: 0)
        })
    ).apply { allowCoreThreadTimeOut(true) }
    private val suggestExecutor = Executors.newSingleThreadExecutor()
    private val bmpCache = SafeBitmapLoader.createBitmapLruCache(8 * 1024)
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile
    private var imageRenderEpoch = 0
    private val imageTaskSeq = AtomicInteger(0)
    private val deferredThumbLoaders = ArrayList<DeferredThumbLoader>()
    private val scrollVisibleRect = Rect()
    private val thumbScreenLoc = IntArray(2)

    private var activeTab = 0 // 0 = Scans, 1 = Top Picks, 2 = Swaps, 3 = Search
    private var historyFavoritesOnly = false
    private var topSubTab = "Food" // "Food" or "Bubble"
    private var selectedTopCategory: String? = null
    private var lastSearchQuery = ""
    private var isSearching = false
    @Volatile
    private var liveSearchSeq = 0
    private var expandedPrefSection: String? = null
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
        SafeBitmapLoader.init(applicationContext)

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
            setOnScrollChangeListener { _, _, _, _, _ ->
                triggerVisibleDeferredThumbnails()
            }
            // post{} in renderScreen can run before rows are measured (height 0 → skipped), so also
            // re-check after every layout pass; returns immediately when no thumbnails are pending.
            viewTreeObserver.addOnGlobalLayoutListener {
                triggerVisibleDeferredThumbnails()
            }
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
        syncDynamicHomeScreenShortcuts()

        handleIncomingReferralIntent(intent)
        val handledPaywall = intent?.getBooleanExtra(PlayBillingCoordinator.EXTRA_OPEN_PLAY_PAYWALL, false) == true
        if (handledPaywall) {
            intent?.removeExtra(PlayBillingCoordinator.EXTRA_OPEN_PLAY_PAYWALL)
            mainHandler.post {
                if (!isDestroyed && !isFinishing) {
                    PlayBillingCoordinator.openUpgradeFlow(this) { renderScreen() }
                }
            }
        }
        val handledAuth = if (!handledPaywall) handleIncomingAuthRedirect(intent) else false
        val handledShortcut = if (!handledPaywall && !handledAuth) handleIncomingShortcutIntent(intent) else false
        val handledShare = if (!handledPaywall && !handledAuth && !handledShortcut) handleIncomingShareIntent(intent) else false

        // Launch the Onboarding Funnel on first open unless returning from OAuth, Share, Paywall, or Home-Screen Quick Action.
        // Returning Guests go straight to scanning & Live Shop with zero login-wall friction.
        if (savedInstanceState == null && !handledPaywall && !handledAuth && !handledShare && !handledShortcut) {
            val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
            val onboardingDone = prefs.getBoolean("onboarding_funnel_done_v1", false)
            if (!onboardingDone) {
                mainHandler.postDelayed({
                    if (!isDestroyed && !isFinishing) {
                        showOnboardingFunnelDialog()
                    }
                }, 180L)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        syncDynamicHomeScreenShortcuts()
        handleIncomingReferralIntent(intent)
        if (intent.getBooleanExtra(PlayBillingCoordinator.EXTRA_OPEN_PLAY_PAYWALL, false)) {
            intent.removeExtra(PlayBillingCoordinator.EXTRA_OPEN_PLAY_PAYWALL)
            PlayBillingCoordinator.openUpgradeFlow(this) { renderScreen() }
            return
        }
        if (handleIncomingAuthRedirect(intent)) return
        if (!handleIncomingShortcutIntent(intent)) {
            handleIncomingShareIntent(intent)
        }
    }

    private fun handleIncomingReferralIntent(incoming: Intent?) {
        if (incoming == null || incoming.getBooleanExtra("_heybroc_ref_handled", false)) return
        val data = incoming.data ?: return
        val scheme = data.scheme?.lowercase().orEmpty()
        val host = data.host?.lowercase().orEmpty()
        val isHeyBrocUri = scheme == "heybroc" ||
            host == "heybroc.com" ||
            host == "www.heybroc.com" ||
            host.endsWith(".heybroc.com") ||
            host == "cleancart-teal.vercel.app"
        if (!isHeyBrocUri) return

        val rawCode = data.getQueryParameter("code")?.trim()?.takeIf { it.isNotBlank() }
            ?: data.getQueryParameter("ref")?.trim()?.takeIf { it.isNotBlank() }
            ?: Regex("""(?i)^/r/([A-Za-z0-9_-]+)""").find(data.path.orEmpty())?.groupValues?.getOrNull(1)
            ?: if (scheme == "heybroc" && (host == "r" || host == "invite" || host == "referral")) {
                data.lastPathSegment?.trim()
            } else {
                null
            }
        if (rawCode.isNullOrBlank()) return

        incoming.putExtra("_heybroc_ref_handled", true)
        val clean = ScanApi.saveReferredByCode(this, rawCode)
        if (clean.isNotBlank()) {
            val appCtx = applicationContext
            io.execute {
                runCatching { ScanApi.claimReferral(appCtx, clean) }
            }
        }
    }

    private fun syncDynamicHomeScreenShortcuts() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return
        runCatching {
            val sm = getSystemService(ShortcutManager::class.java) ?: return
            val isPro = ScanApi.isProActive(this)

            val auditIntent = Intent(this, MainActivity::class.java).apply {
                action = Intent.ACTION_VIEW
                putExtra("heybroc_shortcut", "weekly_audit")
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val auditShortcut = ShortcutInfo.Builder(this, "heybroc_weekly_audit")
                .setShortLabel(if (isPro) "🛒 Audit Order" else "🎁 Free Cart Audit")
                .setLongLabel(if (isPro) "🛒 Audit Weekly Grocery Order" else "🎁 Free Weekly Receipt & Cart Audit")
                .setIcon(Icon.createWithResource(this, android.R.drawable.ic_menu_agenda))
                .setIntent(auditIntent)
                .setRank(0)
                .build()

            val scanIntent = Intent(this, MainActivity::class.java).apply {
                action = Intent.ACTION_VIEW
                putExtra("heybroc_shortcut", "quick_scan")
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val scanShortcut = ShortcutInfo.Builder(this, "heybroc_quick_scan")
                .setShortLabel("📸 Free Scan")
                .setLongLabel(if (isPro) "📸 Scan Barcode or Label" else "📸 Free Barcode & Label Scan")
                .setIcon(Icon.createWithResource(this, android.R.drawable.ic_menu_camera))
                .setIntent(scanIntent)
                .setRank(1)
                .build()

            val watchlistIntent = Intent(this, MainActivity::class.java).apply {
                action = Intent.ACTION_VIEW
                putExtra("heybroc_shortcut", "watchlist")
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val watchlistShortcut = ShortcutInfo.Builder(this, "heybroc_watchlist")
                .setShortLabel("🛡️ Avoid List")
                .setLongLabel("🛡️ My 2x Avoid & Allergy Watchlist")
                .setIcon(Icon.createWithResource(this, android.R.drawable.ic_secure))
                .setIntent(watchlistIntent)
                .setRank(2)
                .build()

            sm.dynamicShortcuts = listOf(auditShortcut, scanShortcut, watchlistShortcut)
        }
    }

    private fun handleIncomingShortcutIntent(incoming: Intent?): Boolean {
        val target = incoming?.getStringExtra("heybroc_shortcut")?.trim().orEmpty()
        if (target.isEmpty()) return false
        incoming?.removeExtra("heybroc_shortcut")
        mainHandler.postDelayed({
            if (isDestroyed || isFinishing) return@postDelayed
            when (target) {
                "weekly_audit" -> showWeeklyOrderAuditDialog()
                "quick_scan" -> showQuickScanModal()
                "watchlist" -> {
                    activeTab = 3
                    expandedPrefSection = "watchlist"
                    renderScreen()
                    showAllergyAndDietModal()
                }
            }
        }, 120L)
        return true
    }

    private fun detectStoreFromSharedText(raw: String): String? {
        val low = raw.lowercase()
        return when {
            low.contains("walmart.com") -> "walmart"
            low.contains("target.com") -> "target"
            low.contains("instacart.com") -> "instacart"
            low.contains("wholefoodsmarket.com") -> "wholefoods"
            low.contains("amazon.com") || low.contains("a.co/") -> "amazon"
            ScanHistoryStore.urlMatchesStore(low, "kroger") -> "kroger"
            low.contains("aldi.us") -> "aldi"
            low.contains("costco.com") -> "costco"
            low.contains("samsclub.com") -> "sams"
            low.contains("bjs.com") -> "bjs"
            low.contains("shipt.com") -> "shipt"
            low.contains("doordash.com") -> "doordash"
            low.contains("ubereats.com") -> "ubereats"
            else -> null
        }
    }

    private fun extractCleanQueryFromSharedText(raw: String, subject: String): Pair<String, String> {
        val combined = listOf(subject.trim(), raw.trim()).filter { it.isNotBlank() }.joinToString("\n").trim()
        if (combined.isBlank()) return "" to ""

        // Check if shared text contains an explicit Ingredients: block (e.g. Live Text / OCR copy)
        val ingMatch = Regex("""(?is)\b(?:ingredients?|contains\s+2%\s+or\s+less)\s*[:\-]\s*(.+)$""").find(combined)
        if (ingMatch != null) {
            val ingBody = ingMatch.groupValues[1]
                .substringBefore("\nDistributed by")
                .substringBefore("\nManufactured")
                .substringBefore("\nNutrition Facts")
                .replace(Regex("\\s+"), " ")
                .trim()
                .take(2200)
            val beforeIng = combined.substring(0, ingMatch.range.first)
                .lines()
                .map { it.trim() }
                .firstOrNull { it.length in 3..140 && !it.startsWith("http", ignoreCase = true) }
                .orEmpty()
                .ifBlank { "Scanned Package Label" }
            if (ingBody.length >= 8) {
                return beforeIng to ingBody
            }
        }

        // Strip URLs from text first to see if the store app shared a clean product title alongside the link
        val withoutUrls = combined
            .replace(Regex("""https?://\S+""", RegexOption.IGNORE_CASE), " ")
            .replace(
                Regex(
                    """(?i)^\s*(?:check\s+out(?:\s+this\s+item)?|i\s+found\s+this|look\s+at\s+this|buy|shop)\s+|(?:\s+[-|·]\s*|\s+(?:at|on|from)\s+)(?:walmart|target|instacart|amazon(?:\.com)?|kroger|aldi|costco|sam'?s\s+club|whole\s+foods|shipt|doordash).*$"""
                ),
                " "
            )
            .replace(Regex("\\s+"), " ")
            .trim()
        if (withoutUrls.length >= 3) {
            return withoutUrls.take(180) to ""
        }

        // Otherwise extract product slug or ?share= / ?q= parameter from the shared URL
        val urlMatch = Regex("""https?://\S+""", RegexOption.IGNORE_CASE).find(combined)?.value.orEmpty()
        if (urlMatch.isNotBlank()) {
            val uri = runCatching { Uri.parse(urlMatch) }.getOrNull()
            val queryParam = listOf("share", "q", "productTitle", "title", "k", "query")
                .firstNotNullOfOrNull { key -> uri?.getQueryParameter(key)?.trim()?.takeIf { it.length >= 2 } }
            if (queryParam != null) {
                return queryParam.take(180) to ""
            }
            val segments = uri?.pathSegments.orEmpty()
                .filter { seg ->
                    seg.length >= 4 &&
                        seg.lowercase() !in setOf("ip", "p", "dp", "gp", "product", "products", "store", "shop", "items") &&
                        !Regex("""^[A-Z0-9]{8,12}$""").matches(seg) &&
                        !Regex("""^(?:A-\d+|\d+)$""").matches(seg)
                }
            val bestSlug = segments.maxByOrNull { it.length }.orEmpty()
                .replace('-', ' ')
                .replace('_', ' ')
                .replace(Regex("\\s+"), " ")
                .trim()
            if (bestSlug.length >= 3) {
                return bestSlug.take(180) to ""
            }
        }
        return combined.take(180) to ""
    }

    private fun handleIncomingShareIntent(incoming: Intent?): Boolean {
        if (incoming == null) return false
        if (incoming.getBooleanExtra("_heybroc_share_handled", false)) return false
        val action = incoming.action ?: return false
        val rawShared: String
        val rawSubject: String
        when (action) {
            Intent.ACTION_SEND -> {
                rawShared = incoming.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
                rawSubject = incoming.getStringExtra(Intent.EXTRA_SUBJECT)?.trim().orEmpty()
            }
            Intent.ACTION_PROCESS_TEXT -> {
                rawShared = incoming.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()?.trim().orEmpty()
                rawSubject = ""
            }
            else -> return false
        }
        if (rawShared.isBlank() && rawSubject.isBlank()) return false
        incoming.putExtra("_heybroc_share_handled", true)

        val nonEmptyLines = rawShared.lines().map { it.trim() }.filter { it.length >= 3 }
        if (nonEmptyLines.size >= 4 && !rawShared.contains("ingredients:", ignoreCase = true) && !rawShared.startsWith("http", ignoreCase = true)) {
            mainHandler.postDelayed({
                if (!isDestroyed && !isFinishing) {
                    showWeeklyOrderAuditDialog(initialOrderText = rawShared)
                }
            }, 120L)
            return true
        }

        val detectedStore = detectStoreFromSharedText("$rawSubject $rawShared")
        val (cleanTitle, cleanIng) = extractCleanQueryFromSharedText(rawShared, rawSubject)
        if (cleanTitle.isBlank()) return false

        Toast.makeText(this, "🥦 Grading \"$cleanTitle\"…", Toast.LENGTH_SHORT).show()
        mainHandler.postDelayed({
            if (!isDestroyed && !isFinishing) {
                performLiveProductSearch(cleanTitle, rawIngredients = cleanIng, storeOverride = detectedStore)
            }
        }, 100L)
        return true
    }

    private fun renderScreen() {
        imageRenderEpoch++
        deferredThumbLoaders.clear()
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
        contentScroll.post { triggerVisibleDeferredThumbnails() }
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

        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val savedName = prefs.getString("auth_name", null)?.takeIf { it.isNotBlank() }
        val savedEmail = prefs.getString("auth_email", null)?.takeIf { it.isNotBlank() }
        val isLoggedIn = !savedEmail.isNullOrBlank()
        val displayAccountLabel = if (isLoggedIn) {
            "👤 ${(savedName ?: savedEmail!!.substringBefore("@")).take(10)}"
        } else {
            "👤 Log in"
        }

        val titleRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        titleRow.addView(label(titleText, 25f, 0xFF111814.toInt(), bold = true).apply {
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })

        if (activeTab == 0) {
            titleRow.addView(label(
                if (historyFavoritesOnly) "★" else "☆",
                21f,
                if (historyFavoritesOnly) 0xFFEAB308.toInt() else 0xFF374151.toInt(),
                bold = true
            ).apply {
                setPadding(dp(8), dp(2), dp(8), dp(2))
                setOnClickListener {
                    historyFavoritesOnly = !historyFavoritesOnly
                    renderScreen()
                }
            })
        }

        titleRow.addView(label(
            displayAccountLabel,
            12f,
            if (isLoggedIn) 0xFF065F46.toInt() else 0xFF1F2937.toInt(),
            bold = true
        ).apply {
            gravity = Gravity.CENTER
            includeFontPadding = false
            setSingleLine(true)
            ellipsize = TextUtils.TruncateAt.END
            setPadding(dp(11), 0, dp(11), 0)
            background = GradientDrawable().apply {
                setColor(if (isLoggedIn) 0xFFECFDF5.toInt() else 0xFFF3F4F6.toInt())
                setStroke(dp(1), if (isLoggedIn) 0xFF86EFAC.toInt() else 0xFFE5E7EB.toInt())
                cornerRadius = dp(999).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                dp(30)
            ).apply { marginEnd = dp(4) }
            setOnClickListener { showGoCoCoLoginDialog() }
        })

        titleRow.addView(label("⋮", 22f, 0xFF374151.toInt(), bold = true).apply {
            setPadding(dp(8), dp(2), dp(4), dp(2))
            setOnClickListener {
                showTopRightMenuDialog()
            }
        })
        topBarContainer.addView(titleRow)
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

    private fun buildLiveBubbleSetupCard(a11yServiceEnabled: Boolean, consentOk: Boolean): View {
        val btnText = if (a11yServiceEnabled && !consentOk) {
            "⚡ Confirm & Activate Bubble →"
        } else {
            "⚡ Turn ON in Accessibility →"
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = GradientDrawable().apply {
                setColor(0xFF064E3B.toInt())
                cornerRadius = dp(18).toFloat()
                setStroke(dp(1), 0xFF10B981.toInt())
            }
            addView(label("LIVE STORE BUBBLE · 1-SWITCH SETUP", 10.5f, 0xFFA7F3D0.toInt(), bold = true).apply {
                letterSpacing = 0.06f
            })
            addView(label("Enable Live Store Bubble", 15.5f, Color.WHITE, bold = true).apply {
                setPadding(0, dp(4), 0, dp(3))
            })
            addView(label(
                "Tap below → Installed apps → HeyBroc → flip ON to auto-grade foods in Walmart, Target, Kroger, Costco & 12+ apps.",
                12.5f,
                0xFFD1FAE5.toInt()
            ).apply {
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
            if (!a11yServiceEnabled && BuildConfig.ENABLE_ACCESSIBILITY_OVERLAY) {
                addView(label("Switch greyed out? Unlock in App Info (⋮ → Allow restricted settings) ↗", 11.5f, 0xFFA7F3D0.toInt(), bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(6), dp(10), dp(6), dp(2))
                    setOnClickListener {
                        scheduleSettingsToasts(
                            "Tap ⋮ (top-right 3 dots) → 'Allow restricted settings', then press Back!",
                            "Note: If ⋮ isn't visible yet, tap greyed-out HeyBroc in Accessibility once first."
                        )
                        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                    }
                })
            }
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
            elevation = dp(1).toFloat()
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(20).toFloat()
                setStroke(dp(1), 0xFFE5E7EB.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(dp(16), dp(4), dp(16), dp(10))
            }

            // Header Row: Mascot + "🔥 Clean Cart Streak: Day X"
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
                    addView(label("🔥 Clean Cart Streak: Day ${streak.streakDays}", 16f, 0xFF111827.toInt(), bold = true))
                    addView(label("${streak.cleanCount} clean items in your library · Scan or swap daily!", 11.5f, 0xFF6B7280.toInt()))
                })
            })

            // 5 Day Circles Row: Warm Amber/Gold for Completed Days, Clean Neutral Gray for Upcoming Days
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                setPadding(0, dp(12), 0, dp(10))
                streak.windowNumbers.forEachIndexed { i, (dayNum, completed) ->
                    addView(label(
                        dayNum.toString(),
                        13.5f,
                        if (completed) Color.WHITE else 0xFF9CA3AF.toInt(),
                        bold = true
                    ).apply {
                        gravity = Gravity.CENTER
                        if (completed) {
                            elevation = dp(2).toFloat()
                        }
                        background = if (completed) {
                            GradientDrawable(
                                GradientDrawable.Orientation.TOP_BOTTOM,
                                intArrayOf(0xFFF59E0B.toInt(), 0xFFEA580C.toInt())
                            ).apply {
                                shape = GradientDrawable.OVAL
                                setStroke(dp(1), 0xFFD97706.toInt())
                            }
                        } else {
                            GradientDrawable().apply {
                                shape = GradientDrawable.OVAL
                                setColor(0xFFF3F4F6.toInt())
                                setStroke(dp(1), 0xFFD1D5DB.toInt())
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
                    addView(label(pillText, 11f, 0xFF374151.toInt(), bold = true).apply {
                        setPadding(dp(10), dp(4), dp(10), dp(4))
                        background = GradientDrawable().apply {
                            setColor(0xFFF9FAFB.toInt())
                            cornerRadius = dp(999).toFloat()
                            setStroke(dp(1), 0xFFE5E7EB.toInt())
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

    private fun isPreferInAppShop(): Boolean {
        if (!BuildConfig.ENABLE_ACCESSIBILITY_OVERLAY) return true
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        return prefs.getBoolean("prefer_in_app_live_shop_v2", true)
    }

    private fun setPreferInAppShop(preferInApp: Boolean) {
        getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
            .edit()
            .putBoolean("prefer_in_app_live_shop_v2", preferInApp)
            .apply()
    }

    private fun resolveInstalledStorePackage(storeKey: String): String? =
        ScanHistoryStore.resolveInstalledStorePackage(this, storeKey)

    private fun launchStoreSmart(storeKey: String, searchQuery: String? = null, forceInApp: Boolean = false) {
        val normKey = LiveStoreBrowserActivity.normalizeStoreKey(storeKey)
        getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
            .edit()
            .putString("preferredStore", normKey)
            .apply()

        val a11yOk = BuildConfig.ENABLE_ACCESSIBILITY_OVERLAY && isAccessibilityEnabled() && AccessibilityConsent.granted(this)
        val nativePkg = resolveInstalledStorePackage(normKey)
        if (!forceInApp && a11yOk && !isPreferInAppShop() && nativePkg != null) {
            runCatching {
                startService(
                    Intent(this, OverlayWindowService::class.java)
                        .setAction(OverlayWindowService.ACTION_RESET_HIDDEN)
                )
            }
            val launchIntent = runCatching { packageManager.getLaunchIntentForPackage(nativePkg) }.getOrNull()
            if (launchIntent != null && runCatching {
                    startActivity(launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
                }.isSuccess
            ) {
                if (!searchQuery.isNullOrBlank()) {
                    GroceryScreenReaderService.requestInAppSearch(nativePkg, searchQuery)
                }
                return
            }
        }

        startActivity(
            LiveStoreBrowserActivity.createIntent(
                context = this,
                storeKey = normKey,
                searchQuery = searchQuery
            )
        )
    }

    private fun buildLiveShopStoreStripCard(a11yServiceEnabled: Boolean, consentOk: Boolean): View {
        val a11yOk = BuildConfig.ENABLE_ACCESSIBILITY_OVERLAY && a11yServiceEnabled && consentOk
        val preferInApp = isPreferInAppShop()
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val primaryPref = LiveStoreBrowserActivity.normalizeStoreKey(prefs.getString("preferredStore", "walmart"))
        val csvOrder = prefs.getString("preferredStoresCsv", null)
            ?.split(",")
            ?.map { LiveStoreBrowserActivity.normalizeStoreKey(it) }
            ?.filter { it.isNotBlank() }
            .orEmpty()

        val orderedStores = LiveStoreBrowserActivity.STORES.sortedWith(
            compareBy<LiveStoreBrowserActivity.LiveStoreConfig> { cfg ->
                when {
                    cfg.key == primaryPref -> -2
                    cfg.key in csvOrder -> csvOrder.indexOf(cfg.key)
                    else -> 100 + LiveStoreBrowserActivity.STORES.indexOf(cfg)
                }
            }
        )
        val selectedStore = orderedStores.firstOrNull() ?: LiveStoreBrowserActivity.STORES.first()

        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(13), dp(14), dp(13))
            elevation = dp(2).toFloat()
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(20).toFloat()
                setStroke(dp(1), 0xFFE2E8F0.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(dp(16), dp(4), dp(16), dp(10))
            }

            // Header Row: Title + Secondary Native Pill Toggle
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                addView(label("🥦 Shop Live with 0–100 Scores", 15f, 0xFF111827.toInt(), bold = true).apply {
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                })
                if (a11yOk) {
                    val modeChipLabel = if (preferInApp) "📲 Native App Pill" else "✓ Native App Pill"
                    addView(label(modeChipLabel, 11f, if (preferInApp) 0xFF334155.toInt() else Color.WHITE, bold = true).apply {
                        setPadding(dp(9), dp(4), dp(9), dp(4))
                        background = GradientDrawable().apply {
                            setColor(if (preferInApp) 0xFFF8FAFC.toInt() else 0xFF0F7A4A.toInt())
                            setStroke(dp(1), if (preferInApp) 0xFFCBD5E1.toInt() else 0xFF0F7A4A.toInt())
                            cornerRadius = dp(999).toFloat()
                        }
                        setOnClickListener {
                            val next = !isPreferInAppShop()
                            setPreferInAppShop(next)
                            Toast.makeText(
                                this@MainActivity,
                                if (next) "Store buttons now open inside HeyBroc In-App Shop" else "Store buttons now launch your native grocery app + floating Pill",
                                Toast.LENGTH_SHORT
                            ).show()
                            renderScreen()
                        }
                    })
                }
            })

            val useNativeForSelected = a11yOk && !preferInApp && resolveInstalledStorePackage(selectedStore.key) != null
            val subDesc = if (a11yOk && !preferInApp) {
                "Native App Pill active — store buttons launch your grocery app + floating Pill (tap chip above to switch back to In-App Shop)."
            } else {
                "Shop right inside HeyBroc with live 0–100 score badges on every food photo & 1-tap Clean Swaps."
            }
            addView(label(subDesc, 11.5f, 0xFF4B5563.toInt()).apply {
                setPadding(0, dp(3), 0, dp(10))
            })

            // Prominent Primary Full-Width Hero CTA Button with Active Store Brand Symbol
            val heroCtaLabel = if (useNativeForSelected) {
                "Open ${selectedStore.label} + Pill →"
            } else {
                "In-App Shop · ${selectedStore.label} →"
            }
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                minimumHeight = dp(50)
                setPadding(dp(16), dp(11), dp(16), dp(11))
                elevation = dp(3).toFloat()
                background = GradientDrawable().apply {
                    setColor(0xFF0F7A4A.toInt())
                    setStroke(dp(1), 0xFF065F46.toInt())
                    cornerRadius = dp(15).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply {
                    bottomMargin = dp(10)
                }
                addView(StoreBrandIcons.createIconView(context, selectedStore.key, 24).apply {
                    (layoutParams as LinearLayout.LayoutParams).marginEnd = dp(9)
                })
                addView(label(heroCtaLabel, 15f, Color.WHITE, bold = true).apply {
                    setSingleLine(true)
                    ellipsize = TextUtils.TruncateAt.END
                })
                setOnClickListener {
                    if (useNativeForSelected) {
                        launchStoreSmart(selectedStore.key, forceInApp = false)
                    } else {
                        setPreferInAppShop(true)
                        launchStoreSmart(selectedStore.key, forceInApp = true)
                    }
                }
            })

            // Horizontal Other-Stores Row — Excludes selectedStore so active store is never duplicated
            val otherStores = orderedStores.filter { it.key != selectedStore.key }
            val storeScroll = HorizontalScrollView(context).apply {
                isHorizontalScrollBarEnabled = false
                clipToPadding = false
            }
            val storeRow = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            otherStores.forEachIndexed { idx, store ->
                val chipHandle = StoreBrandIcons.buildStoreChip(
                    context = context,
                    storeKey = store.key,
                    labelText = store.label,
                    selected = false,
                    iconSizeDp = 21,
                    textSizeSp = 13f,
                    padHdp = 12,
                    padVdp = 8,
                    selectedBgColor = 0xFF15803D.toInt(),
                    unselectedBgColor = 0xFFF8FAFC.toInt(),
                    unselectedStrokeColor = 0xFFCBD5E1.toInt(),
                    unselectedTextColor = 0xFF1E293B.toInt()
                )
                chipHandle.container.layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply {
                    if (idx < otherStores.lastIndex) marginEnd = dp(8)
                }
                chipHandle.container.setOnClickListener {
                    launchStoreSmart(store.key)
                    renderScreen()
                }
                storeRow.addView(chipHandle.container)
            }
            storeScroll.addView(storeRow)
            addView(storeScroll)

            if (BuildConfig.ENABLE_ACCESSIBILITY_OVERLAY && !a11yOk) {
                addView(label(
                    "⚡ Prefer shopping inside the native Walmart / Target app? Enable Floating Pill →",
                    11.5f,
                    0xFF0F7A4A.toInt(),
                    bold = true
                ).apply {
                    setPadding(0, dp(9), 0, dp(2))
                    setOnClickListener { runGuidedSetupStep() }
                })
            }
        }
    }

    private fun renderHistoryTab() {
        val a11yServiceEnabled = isAccessibilityEnabled()
        val consentOk = AccessibilityConsent.granted(this)

        if (!historyFavoritesOnly) {
            tabContentContainer.addView(buildLiveShopStoreStripCard(a11yServiceEnabled, consentOk))
        }

        if (BuildConfig.ENABLE_ACCESSIBILITY_OVERLAY && consentOk && !a11yServiceEnabled) {
            tabContentContainer.addView(buildLiveBubbleSetupCard(a11yServiceEnabled, consentOk).apply {
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply {
                    setMargins(dp(16), dp(0), dp(16), dp(10))
                }
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
            tabContentContainer.addView(buildYukaHistoryRow(item, idx))
            if (idx < items.lastIndex) {
                tabContentContainer.addView(View(this).apply {
                    setBackgroundColor(0xFFEEEEEE.toInt())
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
                })
            }
        }
    }

    /** Product row: Left product image, Right Title + Brand + ● Rating + 🕒 time ago, + ★ Star. */
    private fun buildYukaHistoryRow(item: JSONObject, rowIndex: Int = 0): View {
        val prod = item.optJSONObject("product")
        val res = item.optJSONObject("result")
        val title = ScanHistoryStore.extractTitle(item)
        val brand = prod?.optString("brand").orEmpty().ifBlank { item.optString("brand") }
        val category = prod?.optString("category").orEmpty().ifBlank { item.optString("category") }
        val ingredients = prod?.optString("ingredients").orEmpty()
        val barcode = prod?.optString("barcode").orEmpty()
            .ifBlank { item.optJSONObject("lookup")?.optString("barcode").orEmpty() }
        val imgUrl = prod?.optString("imageUrl").orEmpty().ifBlank { item.optString("imageUrl") }
        val storeImgUrl = prod?.optString("storeImageUrl").orEmpty()
        val catArtUrl = prod?.optString("categoryArtUrl").orEmpty()
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
        val imgPriority = if (rowIndex < 10) rowIndex else 20 + rowIndex
        row.addView(buildProductImageBox(
            imgUrl = imgUrl,
            title = title,
            wPx = dp(68),
            hPx = dp(82),
            brand = brand,
            code = barcode,
            storeImageUrl = storeImgUrl,
            categoryArtUrl = catArtUrl,
            category = category,
            ingredients = ingredients,
            priority = imgPriority,
            deferUntilVisible = rowIndex >= 10,
            cancelOnTabEpoch = true
        ).apply {
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

        allItems.forEachIndexed { idx, badItem ->
            val swapObj = badItem.optJSONObject("swap") ?: return@forEachIndexed
            listWrap.addView(buildYukaSideBySideSwapRow(badItem, swapObj, idx))
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

    private fun storeNameForKey(key: String): String = when (key) {
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

    private fun buildYukaSideBySideSwapRow(badItem: JSONObject, swapObj: JSONObject, rowIndex: Int = 0): View {
        val prod = badItem.optJSONObject("product")
        val res = badItem.optJSONObject("result")
        val badTitle = ScanHistoryStore.extractTitle(badItem)
        val badBrand = prod?.optString("brand").orEmpty().ifBlank { badItem.optString("brand") }
        val badCategory = prod?.optString("category").orEmpty().ifBlank { badItem.optString("category") }
        val badIngredients = prod?.optString("ingredients").orEmpty()
        val badBarcode = prod?.optString("barcode").orEmpty()
        val badImg = prod?.optString("imageUrl").orEmpty().ifBlank { badItem.optString("imageUrl") }
        val badStoreImg = prod?.optString("storeImageUrl").orEmpty()
        val badCatArt = prod?.optString("categoryArtUrl").orEmpty()
        val badScore = res?.optInt("score") ?: 20
        val badRating = res?.optString("rating").orEmpty().ifBlank { ratingForScore(badScore) }
        val rawStoreKey = badItem.optString("storeKey", "")
        val itemStoreKey = if (rawStoreKey.isBlank() || rawStoreKey == "search") preferredStoreKey() else rawStoreKey
        ScanHistoryStore.upgradeSwapForStore(swapObj, badTitle, itemStoreKey)

        val swapTitle = swapObj.optString("title", "Clean Swap")
        val swapBrand = swapObj.optString("brand", "Clean Pick")
        val swapIngredients = swapObj.optString("ingredients", "")
        val swapBarcode = swapObj.optString("barcode", "")
        val swapScore = swapObj.optInt("score", 0)
        val swapImg = swapObj.optString("imageUrl", "")
        val swapCatArt = swapObj.optString("categoryArtUrl", "")
        val swapRating = ratingForScore(swapScore)
        val deferRow = rowIndex >= 8
        val basePriority = if (rowIndex < 8) rowIndex * 2 else 20 + rowIndex * 2

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
        leftTopBox.addView(buildProductImageBox(
            imgUrl = badImg,
            title = badTitle,
            wPx = dp(76),
            hPx = dp(96),
            brand = badBrand,
            code = badBarcode,
            storeImageUrl = badStoreImg,
            categoryArtUrl = badCatArt,
            category = badCategory,
            ingredients = badIngredients,
            priority = basePriority,
            deferUntilVisible = deferRow,
            cancelOnTabEpoch = true
        ).apply {
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

        val serverLocked = swapObj.optBoolean("locked", false)
        val swapUnlocked = !serverLocked && ScanApi.isSwapUnlocked(this, badTitle, swapTitle)
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
                    val isOrg = swapObj.optBoolean("isOrganic", false) ||
                        swapObj.optJSONObject("nutrition")?.optBoolean("isOrganic", false) == true
                    val orgScore = if (isOrg) 10 else 0
                    val addScore = 30
                    val nutScore = (swapScore - addScore - orgScore).coerceIn(0, 60)
                    val swapPreview = JSONObject().apply {
                        put("ok", true)
                        put("storeKey", itemStoreKey)
                        put("product", JSONObject().apply {
                            put("title", swapTitle)
                            put("brand", swapBrand)
                            put("barcode", swapBarcode)
                            put("imageUrl", swapImg)
                            put("categoryArtUrl", swapCatArt)
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
            rightTopBox.addView(buildProductImageBox(
                imgUrl = swapImg,
                title = swapTitle,
                wPx = dp(76),
                hPx = dp(96),
                brand = swapBrand,
                code = swapBarcode,
                storeImageUrl = "",
                categoryArtUrl = swapCatArt,
                category = badCategory,
                ingredients = swapIngredients,
                priority = basePriority + 1,
                deferUntilVisible = deferRow,
                cancelOnTabEpoch = true
            ).apply {
                layoutParams = FrameLayout.LayoutParams(dp(76), dp(96), Gravity.CENTER)
            })
        } else {
            rightTopBox.addView(buildNeutralPackagePlaceholder(dp(76), dp(96), "🔒").apply {
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
                tabContentContainer.addView(buildYukaHistoryRow(item, i))
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
            setPadding(dp(16), dp(6), dp(16), dp(24))
        }

        val searchCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(12), dp(12), dp(12))
            background = GradientDrawable().apply {
                setColor(0xFFF9FAFB.toInt())
                cornerRadius = dp(20).toFloat()
                setStroke(dp(1), 0xFFE5E7EB.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(12) }
        }

        val inputRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val searchInput = EditText(this).apply {
            hint = "Search any food, drink, or brand…"
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
                setStroke(dp(1), 0xFFD1D5DB.toInt())
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
                ++liveSearchSeq
                isSearching = false
                ScanHistoryStore.recordScan(this, fullItem, "search")
                renderScreen()
                showProductDetailDialog(fullItem)
            } else {
                performLiveProductSearch(pickedTitle)
            }
        }

        wrap.addView(searchCard)

        val quickToolsRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(14) }
        }
        fun buildQuickToolCard(
            emoji: String,
            cardTitle: String,
            cardSub: String,
            marginEndDp: Int,
            onClick: () -> Unit
        ): LinearLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = GradientDrawable().apply {
                setColor(0xFFF0FDF4.toInt())
                setStroke(dp(1), 0xFFBBF7D0.toInt())
                cornerRadius = dp(18).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                if (marginEndDp > 0) marginEnd = dp(marginEndDp)
            }
            addView(label("$emoji  $cardTitle", 14f, 0xFF14532D.toInt(), bold = true).apply {
                setSingleLine(true)
                ellipsize = TextUtils.TruncateAt.END
            })
            addView(label(cardSub, 12f, 0xFF166534.toInt()).apply {
                setSingleLine(true)
                ellipsize = TextUtils.TruncateAt.END
                setPadding(0, dp(2), 0, 0)
            })
            setOnClickListener { onClick() }
        }
        quickToolsRow.addView(buildQuickToolCard(
            emoji = "📸",
            cardTitle = "Scan Label",
            cardSub = "Check any ingredient list",
            marginEndDp = 8,
            onClick = { showLabelScannerDialog() }
        ))
        quickToolsRow.addView(buildQuickToolCard(
            emoji = "🧾",
            cardTitle = "Audit Receipt",
            cardSub = "Swaps for your order",
            marginEndDp = 0,
            onClick = { showWeeklyOrderAuditDialog() }
        ))
        wrap.addView(quickToolsRow)

        val bubbleActive = isAccessibilityEnabled() && AccessibilityConsent.granted(this)
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val activeDietaryCount = prefs.getStringSet("dietaryWatchlist", emptySet())?.size ?: 0
        if (expandedPrefSection == "watchlist" || expandedPrefSection == "allergies") {
            expandedPrefSection = "prefs"
        }

        val accordionCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(20).toFloat()
                setStroke(dp(1), 0xFFE5E7EB.toInt())
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(16) }
        }

        if (BuildConfig.ENABLE_ACCESSIBILITY_OVERLAY) {
            accordionCard.addView(buildYukaAccordionRow(
                key = "bubble",
                icon = "MASCOT",
                title = "Live Store Bubble",
                subtitle = if (bubbleActive) {
                    "Active · Auto-grades items in grocery apps"
                } else {
                    "Off · Tap to enable in Walmart, Instacart & more"
                }
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
        }

        val watchlistSub = if (activeDietaryCount > 0) {
            "$activeDietaryCount allergy alert${if (activeDietaryCount == 1) "" else "s"} active · Seed oils, dyes & additives"
        } else {
            "Allergens, sugar, seed oils, dyes & additives"
        }
        accordionCard.addView(buildYukaAccordionRow(
            key = "prefs",
            icon = "🛡️",
            title = "Watchlist & Allergy Alerts",
            subtitle = watchlistSub
        ) {
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(16), 0, dp(16), dp(16))
                addView(label("Allergy & Diet Warnings", 13f, 0xFF111814.toInt(), bold = true).apply {
                    setPadding(0, 0, 0, dp(6))
                })
                addView(dietaryWatchlistControls())
                addView(View(this@MainActivity).apply {
                    setBackgroundColor(0xFFE5E7EB.toInt())
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)).apply {
                        topMargin = dp(14)
                        bottomMargin = dp(12)
                    }
                })
                addView(label("Ingredient Penalties", 13f, 0xFF111814.toInt(), bold = true).apply {
                    setPadding(0, 0, 0, dp(6))
                })
                addView(watchlistControls())
            }
        })

        wrap.addView(accordionCard)

        wrap.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(0, dp(4), 0, dp(8))
            addView(label("Terms", 12f, 0xFF6B7280.toInt(), bold = true).apply {
                setOnClickListener {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.heybroc.com/terms")))
                }
            })
            addView(label("  ·  ", 12f, 0xFF9CA3AF.toInt()))
            addView(label("Privacy", 12f, 0xFF6B7280.toInt(), bold = true).apply {
                setOnClickListener {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.heybroc.com/privacy")))
                }
            })
            addView(label("  ·  ", 12f, 0xFF9CA3AF.toInt()))
            addView(label("Legal Notice", 12f, 0xFF6B7280.toInt(), bold = true).apply {
                setOnClickListener {
                    AlertDialog.Builder(this@MainActivity)
                        .setTitle("Independent Opinion Notice")
                        .setMessage(
                            "HeyBroc 0–100 scores represent subjective clean-label opinions for informational grocery comparison only and are not medical or regulatory advice. Formulations vary by region and lot; always verify physical package labels. Retail swap links marked 'paid link' may earn an affiliate commission. HeyBroc is not affiliated with, endorsed by, or sponsored by any grocery retailer or manufacturer."
                        )
                        .setPositiveButton("Got It", null)
                        .show()
                }
            })
        })

        tabContentContainer.addView(wrap)
    }

    private fun openManageSubscription() {
        PlayBillingCoordinator.openManageSubscription(this)
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
        if (!BuildConfig.ENABLE_ACCESSIBILITY_OVERLAY) {
            val statusBadge = label("✓ BUILT-IN LIVE SHOP READY", 12f, 0xFF16A34A.toInt(), bold = true)
            target.addView(stepCard(
                "In-App Live Shop",
                "0–100 Score Badges Across All 12 Grocery Stores",
                "Shop Walmart, Instacart, Target, Amazon Fresh, Whole Foods, Costco, Sam's Club, Kroger, ALDI, BJ's, Shipt, DoorDash & Uber Eats directly inside HeyBroc with no special system permissions required.",
                statusBadge,
                primaryButton("Open In-App Live Shop →") { launchStoreSmart("walmart", forceInApp = true) }
            ))
            return
        }
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

            val mainActionLabel = if (a11yServiceEnabled && !consentOk) {
                "⚡ Confirm & Activate HeyBroc →"
            } else {
                "⚡ Turn ON HeyBroc in Accessibility →"
            }

            val extras = mutableListOf<View>(
                primaryButton(mainActionLabel) { runGuidedSetupStep() }
            )

            if (!a11yServiceEnabled && BuildConfig.ENABLE_ACCESSIBILITY_OVERLAY) {
                extras.add(
                    label(
                        "Switch greyed out? Unlock in App Info (⋮ → Allow restricted settings) ↗",
                        12f,
                        0xFF0F7A4A.toInt(),
                        bold = true
                    ).apply {
                        gravity = Gravity.CENTER
                        setPadding(dp(8), dp(8), dp(8), dp(4))
                        setOnClickListener {
                            scheduleSettingsToasts(
                                "Tap ⋮ (top-right 3 dots) → 'Allow restricted settings', then press Back!",
                                "Note: If ⋮ isn't visible yet, tap greyed-out HeyBroc in Accessibility once first."
                            )
                            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                        }
                    }
                )
            }

            target.addView(stepCard(
                "Quick 1-Switch Setup",
                "Enable Store Bubble & Screen Reader",
                "Tap below to open Accessibility → Installed apps → flip HeyBroc ON.",
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
        box.addView(label("Instant Food & Barcode Scanner", 18f, 0xFF111814.toInt(), bold = true))
        box.addView(label("Type any food, brand, or 12-digit UPC barcode — tap a suggestion below or press Scan.", 13.5f, 0xFF4B5563.toInt()).apply {
            setPadding(0, dp(4), 0, dp(12))
        })
        val input = EditText(this).apply {
            hint = "e.g. Hidden Valley Ranch, Doritos, or UPC barcode…"
            textSize = 15f
            setSingleLine(true)
            imeOptions = EditorInfo.IME_ACTION_SEARCH
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = GradientDrawable().apply {
                setColor(0xFFF3F4F6.toInt())
                cornerRadius = dp(14).toFloat()
                setStroke(dp(1), 0xFF2E9E5B.toInt())
            }
            setOnEditorActionListener { _, actionId, event ->
                val isEnter = event != null && event.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
                if (actionId == EditorInfo.IME_ACTION_SEARCH || actionId == EditorInfo.IME_ACTION_DONE || isEnter) {
                    val q = text?.toString()?.trim().orEmpty()
                    if (q.isNotBlank()) {
                        modalDialog?.dismiss()
                        performLiveProductSearch(q)
                    }
                    true
                } else {
                    false
                }
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

        val quickRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(10) }
        }
        quickRow.addView(label("📸 Paste Label", 12.5f, 0xFF065F46.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(10), dp(8), dp(10), dp(8))
            background = GradientDrawable().apply {
                setColor(0xFFECFDF5.toInt())
                setStroke(dp(1), 0xFFA7F3D0.toInt())
                cornerRadius = dp(999).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginEnd = dp(6)
            }
            setOnClickListener {
                val draft = input.text.toString().trim()
                modalDialog?.dismiss()
                showLabelScannerDialog(initialTitle = draft)
            }
        })
        quickRow.addView(label("🧾 Audit Order", 12.5f, 0xFF065F46.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(10), dp(8), dp(10), dp(8))
            background = GradientDrawable().apply {
                setColor(0xFFECFDF5.toInt())
                setStroke(dp(1), 0xFFA7F3D0.toInt())
                cornerRadius = dp(999).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            setOnClickListener {
                modalDialog?.dismiss()
                showWeeklyOrderAuditDialog()
            }
        })
        box.addView(quickRow)

        modalDialog = AlertDialog.Builder(this)
            .setView(box)
            .setPositiveButton("Scan Product") { _, _ ->
                val q = input.text.toString().trim()
                if (q.isNotBlank()) performLiveProductSearch(q)
            }
            .setNeutralButton("Open ${storeNameForKey(preferredStoreKey())} ↗") { _, _ ->
                openStoreSwap("", preferredStoreKey(), null)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showTopRightMenuDialog() {
        var menuDialog: AlertDialog? = null
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val savedEmail = prefs.getString("auth_email", null)
        val bubbleActive = isAccessibilityEnabled() && AccessibilityConsent.granted(this)

        val scroll = ScrollView(this)
        val sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(18), dp(20), dp(16))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(24).toFloat()
            }
        }

        val headerRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(12) }
        }
        headerRow.addView(label("Settings & Account", 18.5f, 0xFF111814.toInt(), bold = true).apply {
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        headerRow.addView(label("✕", 15f, 0xFF6B7280.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            val sz = dp(32)
            layoutParams = LinearLayout.LayoutParams(sz, sz)
            background = GradientDrawable().apply {
                setColor(0xFFF3F4F6.toInt())
                cornerRadius = dp(999).toFloat()
            }
            setOnClickListener { menuDialog?.dismiss() }
        })
        sheet.addView(headerRow)

        fun addMenuRow(
            icon: String,
            rowTitle: String,
            rowSub: String,
            showDivider: Boolean = true,
            onClick: () -> Unit
        ) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(4), dp(11), dp(4), dp(11))
                setOnClickListener {
                    menuDialog?.dismiss()
                    onClick()
                }
            }
            row.addView(label(icon, 16f, 0xFF14532D.toInt()).apply {
                gravity = Gravity.CENTER
                val badgeSz = dp(38)
                layoutParams = LinearLayout.LayoutParams(badgeSz, badgeSz).apply {
                    marginEnd = dp(12)
                }
                background = GradientDrawable().apply {
                    setColor(0xFFF0FDF4.toInt())
                    cornerRadius = dp(12).toFloat()
                }
            })
            val textCol = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            textCol.addView(label(rowTitle, 14.5f, 0xFF111814.toInt(), bold = true).apply {
                setSingleLine(true)
                ellipsize = TextUtils.TruncateAt.END
            })
            textCol.addView(label(rowSub, 12f, 0xFF6B7280.toInt()).apply {
                setSingleLine(true)
                ellipsize = TextUtils.TruncateAt.END
                setPadding(0, dp(1), 0, 0)
            })
            row.addView(textCol)
            row.addView(label("›", 19f, 0xFF9CA3AF.toInt(), bold = true).apply {
                setPadding(dp(8), 0, dp(2), 0)
            })
            sheet.addView(row)
            if (showDivider) {
                sheet.addView(View(this).apply {
                    setBackgroundColor(0xFFF3F4F6.toInt())
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
                })
            }
        }

        addMenuRow(
            icon = "👤",
            rowTitle = "Account & Cloud Sync",
            rowSub = if (!savedEmail.isNullOrBlank()) savedEmail else "Log in or create free account",
            onClick = { showGoCoCoLoginDialog() }
        )
        addMenuRow(
            icon = "🛡️",
            rowTitle = "Watchlist & Allergy Alerts",
            rowSub = "Allergens, seed oils, dyes & additives",
            onClick = { showAllergyAndDietModal() }
        )
        if (BuildConfig.ENABLE_ACCESSIBILITY_OVERLAY) {
            addMenuRow(
                icon = "🥦",
                rowTitle = "Live Store Bubble",
                rowSub = if (bubbleActive) "Active in grocery apps" else "Tap to enable overlay",
                onClick = {
                    activeTab = 1
                    topSubTab = "Bubble"
                    renderScreen()
                }
            )
        } else {
            addMenuRow(
                icon = "🛒",
                rowTitle = "Live Shop Browser",
                rowSub = "Shop 12 grocery stores with 0–100 score badges",
                onClick = {
                    activeTab = 1
                    topSubTab = "Bubble"
                    renderScreen()
                }
            )
        }
        addMenuRow(
            icon = "🎯",
            rowTitle = "Clean-Eating Goals",
            rowSub = "Update household preferences",
            onClick = { showOnboardingFunnelDialog() }
        )
        addMenuRow(
            icon = "💳",
            rowTitle = "Manage Subscription",
            rowSub = "Billing, upgrade, or cancel anytime",
            onClick = { openManageSubscription() }
        )
        addMenuRow(
            icon = "🗑️",
            rowTitle = "Clear Scan History",
            rowSub = "Remove saved local scans",
            showDivider = false,
            onClick = {
                ScanHistoryStore.clearHistory(this)
                Toast.makeText(this, "Scan history cleared", Toast.LENGTH_SHORT).show()
                renderScreen()
            }
        )

        val legalRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(0, dp(12), 0, dp(2))
        }
        legalRow.addView(label("Terms of Service", 12f, 0xFF6B7280.toInt(), bold = true).apply {
            setPadding(dp(8), dp(4), dp(8), dp(4))
            setOnClickListener {
                menuDialog?.dismiss()
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.heybroc.com/terms")))
            }
        })
        legalRow.addView(label("·", 12f, 0xFF9CA3AF.toInt()))
        legalRow.addView(label("Privacy Policy", 12f, 0xFF6B7280.toInt(), bold = true).apply {
            setPadding(dp(8), dp(4), dp(8), dp(4))
            setOnClickListener {
                menuDialog?.dismiss()
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.heybroc.com/privacy")))
            }
        })
        sheet.addView(legalRow)

        scroll.addView(sheet)
        menuDialog = AlertDialog.Builder(this).setView(scroll).create().also { dlg ->
            dlg.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
            dlg.show()
        }
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

        val householdChoiceKeys = setOf("kids_family", "partner", "myself", "sensitivity")
        val savedHouseholdsCsv = prefs.getString("householdProfilesCsv", null)
        val selectedHouseholds = if (!savedHouseholdsCsv.isNullOrBlank()) {
            savedHouseholdsCsv.split(",")
                .map { it.trim() }
                .filter { it in householdChoiceKeys }
                .distinct()
                .toMutableList()
                .ifEmpty { mutableListOf("kids_family") }
        } else {
            val singleH = prefs.getString("householdProfile", "kids_family") ?: "kids_family"
            mutableListOf(if (singleH in householdChoiceKeys) singleH else "kids_family")
        }

        val fallbackStore = prefs.getString("preferredStore", "walmart")?.takeIf { it.isNotBlank() } ?: "walmart"
        val storeChoiceKeys = setOf(
            "walmart", "target", "costco", "sams", "aldi", "kroger",
            "instacart", "amazon", "bjs", "shipt", "doordash", "ubereats"
        )
        val normalizedFallbackStore = if (fallbackStore in storeChoiceKeys) fallbackStore else "walmart"
        val rawStoresCsv = prefs.getString("preferredStoresCsv", null)
        val selectedStores = if (rawStoresCsv != null) {
            rawStoresCsv.split(",")
                .map { it.trim() }
                .filter { it in storeChoiceKeys }
                .distinct()
                .toMutableList()
        } else {
            mutableListOf(normalizedFallbackStore)
        }

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

        val storeOptions = listOf(
            Triple("walmart", "🏬 Walmart", "Pickup, Delivery & In-Store"),
            Triple("target", "🎯 Target", "Drive Up & Same-Day"),
            Triple("costco", "🏷️ Costco", "Warehouse & Bulk Picks"),
            Triple("sams", "💎 Sam's Club", "Club Pickup & Scan & Go"),
            Triple("aldi", "🏪 ALDI", "Simply Nature & Aisle Picks"),
            Triple("kroger", "🛒 Kroger", "Simple Truth & Pickup"),
            Triple("instacart", "🥕 Instacart", "All Local Supermarkets"),
            Triple("amazon", "📦 Amazon / Whole Foods", "365 & Prime Delivery"),
            Triple("bjs", "🔴 BJ's Wholesale", "Wellsley Farms & Bulk"),
            Triple("shipt", "🛍️ Shipt", "Target, Meijer & Local"),
            Triple("doordash", "🚗 DoorDash", "Express Grocery Delivery"),
            Triple("ubereats", "🛵 Uber Eats", "Same-Hour Grocery & Aisle")
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
                problemNote = "Hidden in 70%+ of 'Natural' dressings, chips & crackers"
            ),
            GoalOption(
                id = "dyes",
                icon = "🧪",
                title = "Red 40 & Artificial Dyes",
                subtitle = "Red 40, Yellow 5 & 6, Blue 1, Titanium Dioxide",
                problemNote = "Disguised in kids' yogurts, fruit snacks & cereals"
            ),
            GoalOption(
                id = "hfcs",
                icon = "🌽",
                title = "High-Fructose Corn Syrup",
                subtitle = "HFCS, corn syrup solids & hidden refined syrups",
                problemNote = "Slipped into breads, ketchup & barbecue sauces"
            ),
            GoalOption(
                id = "nitrates",
                icon = "🥓",
                title = "Nitrites & Curing Nitrates",
                subtitle = "Sodium nitrite/nitrate in bacon, deli meat & hot dogs",
                problemNote = "Found in conventional lunch meats, bacon & hot dogs"
            ),
            GoalOption(
                id = "sweeteners",
                icon = "🥤",
                title = "Artificial Sweeteners",
                subtitle = "Sucralose, aspartame, acesulfame K & saccharin",
                problemNote = "Used in 'Zero Sugar' sodas, shakes & light yogurts"
            ),
            GoalOption(
                id = "preservatives",
                icon = "🛡️",
                title = "BHA, BHT & Harsh Preservatives",
                subtitle = "TBHQ, BHA/BHT, potassium bromate & propylparaben",
                problemNote = "Added to cereals, tortillas & frozen family meals"
            )
        )

        val dietaryOptions = listOf(
            Triple("sugar_diabetes", "🩸 Added Sugar & Syrup Watch", "Flags added cane sugar, corn syrups, >=10g sugar/100g & refined starches"),
            Triple("pesticide_risk", "🌱 Herbicides & Pesticides (Glyphosate) Watch", "Flags non-organic Dirty-Dozen produce & conventional oats/wheat/beans; links to USDA Organic"),
            Triple("dairy", "🥛 Dairy & Lactose Guard", "Flags milk, cream, butter, whey, casein, lactose, cheese & yogurt"),
            Triple("wheat_gluten", "🌾 Wheat & Gluten Guard", "Flags wheat, enriched flour, barley, malt, rye, spelt & semolina"),
            Triple("peanuts_nuts", "🥜 Peanut & Tree Nut Guard", "Flags peanuts, almonds, cashews, walnuts, pecans & pistachios"),
            Triple("soy", "🫘 Soy Guard", "Flags soy protein, soy lecithin, soybean oil, tofu & edamame"),
            Triple("egg", "🥚 Egg Guard", "Flags whole egg, egg whites/yolks, albumin & mayonnaise"),
            Triple("shellfish_fish", "🐟 Shellfish & Fish Guard", "Flags shrimp, crab, lobster, clams, anchovies, salmon, tuna & cod"),
            Triple("high_sodium", "🧂 High Sodium Watch", "Flags >=400mg sodium/100g, MSG, sodium phosphate & added brine")
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

        fun primaryStoreKey(): String = selectedStores.firstOrNull() ?: fallbackStore
        fun primaryHouseholdKey(): String = selectedHouseholds.firstOrNull() ?: "kids_family"

        fun formatStoresSummary(): String = when (selectedStores.size) {
            0 -> "all 12+ stores"
            1 -> storeNameForKey(selectedStores[0])
            2 -> "${storeNameForKey(selectedStores[0])} & ${storeNameForKey(selectedStores[1])}"
            3 -> "${storeNameForKey(selectedStores[0])}, ${storeNameForKey(selectedStores[1])} & ${storeNameForKey(selectedStores[2])}"
            else -> "${storeNameForKey(selectedStores[0])}, ${storeNameForKey(selectedStores[1])} + ${selectedStores.size - 2} more"
        }

        fun buildAnalyticsProps(extraAction: String? = null): JSONObject = JSONObject().apply {
            put("step", currentStep)
            put("isReturningUser", alreadyDone)
            put("householdProfile", primaryHouseholdKey())
            put("householdProfiles", JSONArray(selectedHouseholds))
            put("store", primaryStoreKey())
            put("stores", JSONArray(selectedStores))
            put("storesCount", selectedStores.size)
            put("watchlistCount", selectedGoals.size)
            put("dietaryCount", selectedDietary.size)
            if (extraAction != null) put("exitAction", extraAction)
        }

        fun saveWatchlistAndMarkDone() {
            val toSave = selectedGoals.toMutableSet()
            prefs.edit()
                .putStringSet("familyWatchlist", toSave)
                .putStringSet("dietaryWatchlist", selectedDietary.toMutableSet())
                .putString("householdProfile", primaryHouseholdKey())
                .putString("householdProfilesCsv", selectedHouseholds.joinToString(","))
                .putString("preferredStore", primaryStoreKey())
                .putString("preferredStoresCsv", selectedStores.joinToString(","))
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

        fun renderFunnelStep(step: Int) {
            currentStep = step
            val stepChanged = lastTrackedStep != step
            if (stepChanged) {
                lastTrackedStep = step
                ScanApi.trackEvent(this@MainActivity, "onboarding_step_viewed", buildAnalyticsProps())
            }
            card.removeAllViews()
            if (stepChanged) {
                scroll.post { scroll.scrollTo(0, 0) }
            }

            // Top Row: Back button + weighted Step badge + Returning-User Close button (no Skip leak for first-time users)
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
                1 -> "🥦 STEP 1 OF 7 · HOUSEHOLD"
                2 -> "🥦 STEP 2 OF 7 · YOUR GOALS"
                3 -> "🥦 STEP 3 OF 7 · YOUR STORES"
                4 -> "🥦 STEP 4 OF 7 · ALLERGY GUARD"
                5 -> "🥦 STEP 5 OF 7 · GLYPHOSATE MAP"
                6 -> "🥦 STEP 6 OF 7 · WHY IT MATTERS"
                else -> "🥦 STEP 7 OF 7 · YOUR PLAN"
            }
            val badgeWrap = FrameLayout(this).apply {
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    if (alreadyDone) marginEnd = dp(6)
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

            if (alreadyDone) {
                headerRow.addView(label("✕ Close", 12f, 0xFF4B5563.toInt(), bold = true).apply {
                    setSingleLine(true)
                    setPadding(dp(10), dp(5), dp(10), dp(5))
                    background = GradientDrawable().apply {
                        setColor(0xFFF3F4F6.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    contentDescription = "Close watchlist calibration without saving"
                    setOnClickListener {
                        ScanApi.trackEvent(this@MainActivity, "onboarding_dismissed", buildAnalyticsProps("close"))
                        funnelDialog?.dismiss()
                    }
                })
            }
            card.addView(headerRow)

            // 7-Segment Progress Bar (tappable for returning users)
            val progressRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                contentDescription = "Onboarding progress: step $step of 7"
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(14) }
            }
            for (i in 1..7) {
                progressRow.addView(View(this).apply {
                    background = GradientDrawable().apply {
                        setColor(if (i <= step) 0xFF16A34A.toInt() else 0xFFE5E7EB.toInt())
                        cornerRadius = dp(99).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(0, dp(if (alreadyDone) 6 else 5), 1f).apply {
                        if (i < 7) marginEnd = dp(4)
                    }
                    if (alreadyDone) {
                        contentDescription = "Jump to step $i"
                        setOnClickListener { renderFunnelStep(i) }
                    }
                })
            }
            card.addView(progressRow)

            val storeDisplayName = storeNameForKey(primaryStoreKey())
            val storesSummary = formatStoresSummary()
            val primaryHTitle = householdOptions.find { it.id == primaryHouseholdKey() }?.title ?: "My Kids & Family"
            val activeHouseholdTitle = if (selectedHouseholds.size > 1) {
                "$primaryHTitle + ${selectedHouseholds.size - 1} more"
            } else {
                primaryHTitle
            }

            // Step 1: Household Profile (Multi-Select)
            if (step == 1) {
                card.addView(label("Who are you protecting with HeyBroc?", 21f, 0xFF111814.toInt(), bold = true))
                card.addView(label(
                    "Select all that apply — we'll calibrate your 0–100 food grading in 60 seconds:",
                    13.5f,
                    0xFF4B5563.toInt()
                ).apply { setPadding(0, dp(4), 0, dp(12)) })

                householdOptions.forEach { h ->
                    val optActive = h.id in selectedHouseholds
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
                            if (h.id in selectedHouseholds) {
                                if (selectedHouseholds.size > 1) selectedHouseholds.remove(h.id)
                            } else {
                                selectedHouseholds.add(h.id)
                            }
                            selectedGoals.clear()
                            selectedHouseholds.forEach { hKey ->
                                householdOptions.find { it.id == hKey }?.recCats?.let { selectedGoals.addAll(it) }
                            }
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
                        layoutParams = LinearLayout.LayoutParams(dp(23), dp(23))
                        background = GradientDrawable().apply {
                            shape = GradientDrawable.RECTANGLE
                            cornerRadius = dp(7).toFloat()
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
                            val h = householdOptions.find { it.id == primaryHouseholdKey() } ?: householdOptions.first()
                            selectedGoals.addAll(h.recCats)
                        }
                        renderFunnelStep(2)
                    }
                })
                return
            }

            // Step 2: 2x Watchlist Goals (Multi-Select — single non-repeating goals step)
            if (step == 2) {
                card.addView(label("What are your clean-eating goals?", 21f, 0xFF111814.toInt(), bold = true))
                card.addView(label(
                    "Select as many as you want — HeyBroc applies 2x strictness to your choices and links directly to 90–100/100 cleaner picks:",
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
                            renderFunnelStep(2)
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
                        layoutParams = LinearLayout.LayoutParams(dp(23), dp(23))
                        background = GradientDrawable().apply {
                            shape = GradientDrawable.RECTANGLE
                            cornerRadius = dp(7).toFloat()
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
                    setOnClickListener { renderFunnelStep(3) }
                })
                return
            }

            // Step 3: Favorite Grocery Stores (Multi-Select — All 12 Supported Stores)
            if (step == 3) {
                card.addView(label("Where do you usually grocery shop?", 21f, 0xFF111814.toInt(), bold = true))
                card.addView(label(
                    "Select all the stores you shop at — we'll pin your favorites first:",
                    13.5f,
                    0xFF4B5563.toInt()
                ).apply { setPadding(0, dp(4), 0, dp(8)) })

                val unlockedBanner = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(11), dp(8), dp(11), dp(8))
                    background = GradientDrawable().apply {
                        setColor(0xFFECFDF5.toInt())
                        setStroke(dp(1), 0xFF86EFAC.toInt())
                        cornerRadius = dp(12).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { bottomMargin = dp(10) }
                }
                unlockedBanner.addView(label(
                    "✓ All 12+ grocery & delivery stores + 1.5M+ barcodes stay unlocked",
                    11.5f,
                    0xFF14532D.toInt(),
                    bold = true
                ).apply {
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                        marginEnd = dp(8)
                    }
                })
                val allStoresSelected = storeOptions.all { it.first in selectedStores }
                unlockedBanner.addView(label(
                    if (allStoresSelected) "Reset" else "Select all",
                    11f,
                    0xFF15803D.toInt(),
                    bold = true
                ).apply {
                    setSingleLine(true)
                    setPadding(dp(9), dp(4), dp(9), dp(4))
                    background = GradientDrawable().apply {
                        setColor(Color.WHITE)
                        setStroke(dp(1), 0xFF86EFAC.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    setOnClickListener {
                        selectedStores.clear()
                        if (allStoresSelected) {
                            selectedStores.add(normalizedFallbackStore)
                        } else {
                            selectedStores.addAll(storeOptions.map { it.first })
                        }
                        renderFunnelStep(3)
                    }
                })
                card.addView(unlockedBanner)

                storeOptions.forEach { (storeId, storeTitle, storeSub) ->
                    val optActive = storeId in selectedStores
                    val row = LinearLayout(this).apply {
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER_VERTICAL
                        setPadding(dp(12), dp(8), dp(12), dp(8))
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
                        ).apply { bottomMargin = dp(6) }
                        setOnClickListener {
                            if (optActive) {
                                selectedStores.remove(storeId)
                            } else {
                                selectedStores.add(storeId)
                            }
                            renderFunnelStep(3)
                        }
                    }
                    row.addView(LinearLayout(this).apply {
                        orientation = LinearLayout.VERTICAL
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                        addView(label(storeTitle, 13.5f, 0xFF111814.toInt(), bold = true))
                        addView(label(storeSub, 11f, 0xFF6B7280.toInt()))
                    })
                    row.addView(label(if (optActive) "✓" else "", 13f, Color.WHITE, bold = true).apply {
                        gravity = Gravity.CENTER
                        layoutParams = LinearLayout.LayoutParams(dp(22), dp(22))
                        background = GradientDrawable().apply {
                            shape = GradientDrawable.RECTANGLE
                            cornerRadius = dp(7).toFloat()
                            setColor(if (optActive) 0xFF16A34A.toInt() else Color.WHITE)
                            setStroke(dp(2), if (optActive) 0xFF16A34A.toInt() else 0xFFD1D5DB.toInt())
                        }
                    })
                    card.addView(row)
                }

                val storeCta = if (selectedStores.isEmpty()) {
                    "Continue (All 12+ Stores Unlocked) →"
                } else {
                    "Continue (${selectedStores.size} ${if (selectedStores.size == 1) "Store" else "Stores"} Selected) →"
                }
                card.addView(label(storeCta, 15f, Color.WHITE, bold = true).apply {
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

            // Step 4: Allergy & Dietary Guard (Multi-Select — clean list without map crowding bottom)
            if (step == 4) {
                card.addView(label("Any family allergies or dietary watches?", 21f, 0xFF111814.toInt(), bold = true))
                card.addView(label(
                    "Optional — select any watches below for instant 🛡️ Allergy, Sugar & Glyphosate alerts:",
                    13.5f,
                    0xFF4B5563.toInt()
                ).apply { setPadding(0, dp(4), 0, dp(10)) })

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
                            renderFunnelStep(4)
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
                        layoutParams = LinearLayout.LayoutParams(dp(23), dp(23))
                        background = GradientDrawable().apply {
                            shape = GradientDrawable.RECTANGLE
                            cornerRadius = dp(7).toFloat()
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
                    setOnClickListener { renderFunnelStep(5) }
                })
                return
            }

            // Step 5: Dedicated U.S. Glyphosate Usage vs. CDC Cancer Incidence Map Slide
            if (step == 5) {
                card.addView(label("Why Families Watch for Glyphosate", 21f, 0xFF111814.toInt(), bold = true))
                card.addView(label(
                    "Compare USGS agricultural herbicide maps alongside U.S. cancer incidence data — and optionally guard conventional risk crops:",
                    13f,
                    0xFF4B5563.toInt()
                ).apply { setPadding(0, dp(4), 0, dp(10)) })

                val mapCard = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(12), dp(11), dp(12), dp(11))
                    background = GradientDrawable().apply {
                        setColor(0xFFFFFBEB.toInt())
                        setStroke(dp(1), 0xFFFCA5A5.toInt())
                        cornerRadius = dp(16).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { bottomMargin = dp(12) }
                }
                mapCard.addView(label("🇺🇸 U.S. GLYPHOSATE MAP × CDC CANCER MAP", 10.5f, 0xFF991B1B.toInt(), bold = true))

                val mapThumbRadius = dp(9).toFloat()
                val mapsSideBySide = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { topMargin = dp(8); bottomMargin = dp(8) }
                }
                mapsSideBySide.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(8), dp(8), dp(8), dp(8))
                    background = GradientDrawable().apply {
                        setColor(Color.WHITE)
                        setStroke(dp(1), 0xFFFED7AA.toInt())
                        cornerRadius = dp(12).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                        marginEnd = dp(6)
                    }
                    addView(label("1. Glyphosate (USGS)", 11.5f, 0xFF9A3412.toInt(), bold = true).apply {
                        setPadding(0, 0, 0, dp(4))
                    })
                    addView(ImageView(this@MainActivity).apply {
                        setImageResource(R.drawable.onboarding_usgs_map)
                        scaleType = ImageView.ScaleType.FIT_CENTER
                        contentDescription = "United States map of agricultural glyphosate usage concentrated in Iowa and the Corn Belt"
                        background = GradientDrawable().apply {
                            setColor(0xFFFCFBF7.toInt())
                            cornerRadius = mapThumbRadius
                        }
                        clipToOutline = true
                        outlineProvider = object : ViewOutlineProvider() {
                            override fun getOutline(view: View, outline: Outline) {
                                outline.setRoundRect(0, 0, view.width, view.height, mapThumbRadius)
                            }
                        }
                        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(88)).apply {
                            bottomMargin = dp(5)
                        }
                    })
                    addView(label("#1 Spray Zone: Concentrated in Iowa & Corn Belt on conventional crops.", 10.5f, 0xFF7C2D12.toInt()))
                })
                mapsSideBySide.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(8), dp(8), dp(8), dp(8))
                    background = GradientDrawable().apply {
                        setColor(Color.WHITE)
                        setStroke(dp(1), 0xFFFECACA.toInt())
                        cornerRadius = dp(12).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                    addView(label("2. Cancer Rate (CDC)", 11.5f, 0xFF991B1B.toInt(), bold = true).apply {
                        setPadding(0, 0, 0, dp(4))
                    })
                    addView(ImageView(this@MainActivity).apply {
                        setImageResource(R.drawable.onboarding_cdc_map)
                        scaleType = ImageView.ScaleType.FIT_CENTER
                        contentDescription = "United States cancer incidence map showing Iowa hotspot per Iowa Cancer Registry"
                        background = GradientDrawable().apply {
                            setColor(0xFFFCFBF7.toInt())
                            cornerRadius = mapThumbRadius
                        }
                        clipToOutline = true
                        outlineProvider = object : ViewOutlineProvider() {
                            override fun getOutline(view: View, outline: Outline) {
                                outline.setRoundRect(0, 0, view.width, view.height, mapThumbRadius)
                            }
                        }
                        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(88)).apply {
                            bottomMargin = dp(5)
                        }
                    })
                    addView(label("Iowa has #2 highest & #1 rising cancer rate in the U.S. (Iowa Cancer Registry).", 10.5f, 0xFF7F1D1D.toInt()))
                })
                mapCard.addView(mapsSideBySide)

                mapCard.addView(label(
                    "Maps show where each is reported, not that one causes the other; EPA and IARC disagree on glyphosate's cancer risk. USDA Organic prohibits synthetic glyphosate.",
                    10.5f,
                    0xFF7F1D1D.toInt()
                ))

                val glyphOn = "pesticide_risk" in selectedDietary
                mapCard.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(12), dp(10), dp(12), dp(10))
                    background = GradientDrawable().apply {
                        setColor(Color.WHITE)
                        setStroke(dp(if (glyphOn) 2 else 1), if (glyphOn) 0xFF16A34A.toInt() else 0xFFCBD5E1.toInt())
                        cornerRadius = dp(12).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { topMargin = dp(10) }

                    addView(label(
                        if (glyphOn) "✓" else "",
                        13.5f,
                        Color.WHITE,
                        bold = true
                    ).apply {
                        gravity = Gravity.CENTER
                        background = GradientDrawable().apply {
                            setColor(if (glyphOn) 0xFF16A34A.toInt() else Color.WHITE)
                            setStroke(dp(2), if (glyphOn) 0xFF16A34A.toInt() else 0xFF94A3B8.toInt())
                            cornerRadius = dp(6).toFloat()
                        }
                        layoutParams = LinearLayout.LayoutParams(dp(22), dp(22)).apply {
                            marginEnd = dp(10)
                        }
                    })

                    addView(LinearLayout(this@MainActivity).apply {
                        orientation = LinearLayout.VERTICAL
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                        addView(label(
                            "Guard my family against glyphosate",
                            13f,
                            0xFF111814.toInt(),
                            bold = true
                        ))
                        addView(label(
                            "Flags non-organic oats, wheat & high-residue produce",
                            11f,
                            0xFF4B5563.toInt()
                        ))
                    })

                    setOnClickListener {
                        if (glyphOn) selectedDietary.remove("pesticide_risk") else selectedDietary.add("pesticide_risk")
                        renderFunnelStep(5)
                    }
                })
                card.addView(mapCard)

                card.addView(label("See How HeyBroc Solves This →", 15f, Color.WHITE, bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(16), dp(14), dp(16), dp(14))
                    background = GradientDrawable().apply {
                        setColor(0xFF16A34A.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    setOnClickListener { renderFunnelStep(6) }
                })
                return
            }

            // Step 6: Merged Why It Matters (Healthy Family Hero + Uncropped Studio Product Comparison Photos + Swap Bridge)
            if (step == 6) {
                val photoRadius = dp(16).toFloat()
                val photoFrame = FrameLayout(this).apply {
                    background = GradientDrawable().apply {
                        setColor(0xFFF0FDF4.toInt())
                        cornerRadius = photoRadius
                        setStroke(dp(1), 0xFFBBF7D0.toInt())
                    }
                    clipToOutline = true
                    outlineProvider = object : ViewOutlineProvider() {
                        override fun getOutline(view: View, outline: Outline) {
                            outline.setRoundRect(0, 0, view.width, view.height, photoRadius)
                        }
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        dp(132)
                    ).apply { bottomMargin = dp(10) }
                }
                photoFrame.addView(ImageView(this).apply {
                    setImageResource(R.drawable.onboarding_healthy_family)
                    scaleType = ImageView.ScaleType.CENTER_CROP
                    contentDescription = "Happy family with kids eating healthy whole foods together"
                    layoutParams = FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                })
                photoFrame.addView(View(this).apply {
                    background = GradientDrawable(
                        GradientDrawable.Orientation.TOP_BOTTOM,
                        intArrayOf(0x00111814, 0x9E111814.toInt())
                    )
                    layoutParams = FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                })
                photoFrame.addView(label("💚 Protecting $activeHouseholdTitle", 10.5f, Color.WHITE, bold = true).apply {
                    setPadding(dp(10), dp(4), dp(10), dp(4))
                    background = GradientDrawable().apply {
                        setColor(0xEB14532D.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    layoutParams = FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        Gravity.BOTTOM or Gravity.START
                    ).apply {
                        leftMargin = dp(10)
                        bottomMargin = dp(9)
                    }
                })
                photoFrame.addView(label("⚡ 1-Second Scan", 10f, 0xFF14532D.toInt(), bold = true).apply {
                    setPadding(dp(9), dp(4), dp(9), dp(4))
                    background = GradientDrawable().apply {
                        setColor(0xEBFFFFFF.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    layoutParams = FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        Gravity.BOTTOM or Gravity.END
                    ).apply {
                        rightMargin = dp(10)
                        bottomMargin = dp(9)
                    }
                })
                card.addView(photoFrame)

                card.addView(label("How HeyBroc Protects Your Cart in 1 Second", 19.5f, 0xFF111814.toInt(), bold = true))
                card.addView(label(
                    "Front labels say \"Homestyle\" — we grade the fine print (0–100) and link to a cleaner pick at $storeDisplayName:",
                    12.5f,
                    0xFF4B5563.toInt()
                ).apply { setPadding(0, dp(3), 0, dp(10)) })

                // Side-by-Side Uncropped Studio Product Comparison + Centered Swap Arrow Bridge
                val compareStage = FrameLayout(this).apply {
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { bottomMargin = dp(10) }
                }
                val compareRow = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    layoutParams = FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    )
                }
                val thumbRadius = dp(11).toFloat()

                // Left Card: Poor Pick
                compareRow.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(9), dp(9), dp(9), dp(10))
                    background = GradientDrawable().apply {
                        setColor(0xFFFFF8F8.toInt())
                        setStroke(dp(1), 0xFFFCA5A5.toInt())
                        cornerRadius = dp(15).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                        marginEnd = dp(10)
                    }
                    val poorThumbBox = FrameLayout(this@MainActivity).apply {
                        background = GradientDrawable().apply {
                            setColor(0xFFEAE5DF.toInt())
                            cornerRadius = thumbRadius
                        }
                        clipToOutline = true
                        outlineProvider = object : ViewOutlineProvider() {
                            override fun getOutline(view: View, outline: Outline) {
                                outline.setRoundRect(0, 0, view.width, view.height, thumbRadius)
                            }
                        }
                        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(118)).apply {
                            bottomMargin = dp(7)
                        }
                    }
                    poorThumbBox.addView(ImageView(this@MainActivity).apply {
                        setImageResource(R.drawable.onboarding_poor_pick)
                        scaleType = ImageView.ScaleType.FIT_CENTER
                        contentDescription = "Conventional ranch bottle with seed oils"
                        layoutParams = FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT
                        )
                    })
                    poorThumbBox.addView(label("✕ 18/100 · Poor", 10f, Color.WHITE, bold = true).apply {
                        setPadding(dp(7), dp(3), dp(7), dp(3))
                        background = GradientDrawable().apply {
                            setColor(0xFFDC2626.toInt())
                            cornerRadius = dp(999).toFloat()
                        }
                        layoutParams = FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                            Gravity.TOP or Gravity.START
                        ).apply {
                            leftMargin = dp(6)
                            topMargin = dp(6)
                        }
                    })
                    addView(poorThumbBox)
                    addView(label("\"Homestyle\" Ranch", 13f, 0xFF111814.toInt(), bold = true))
                    addView(label("Soybean oil, MSG & polysorbate 60", 11f, 0xFF991B1B.toInt()).apply { setPadding(0, dp(2), 0, 0) })
                })

                // Right Card: Clean Pick
                compareRow.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(9), dp(9), dp(9), dp(10))
                    background = GradientDrawable().apply {
                        setColor(0xFFF2FDF6.toInt())
                        setStroke(dp(1), 0xFF86EFAC.toInt())
                        cornerRadius = dp(15).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                    val cleanThumbBox = FrameLayout(this@MainActivity).apply {
                        background = GradientDrawable().apply {
                            setColor(0xFFEAE5DF.toInt())
                            cornerRadius = thumbRadius
                        }
                        clipToOutline = true
                        outlineProvider = object : ViewOutlineProvider() {
                            override fun getOutline(view: View, outline: Outline) {
                                outline.setRoundRect(0, 0, view.width, view.height, thumbRadius)
                            }
                        }
                        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(118)).apply {
                            bottomMargin = dp(7)
                        }
                    }
                    cleanThumbBox.addView(ImageView(this@MainActivity).apply {
                        setImageResource(R.drawable.onboarding_clean_pick)
                        scaleType = ImageView.ScaleType.FIT_CENTER
                        contentDescription = "Organic avocado oil ranch bottle"
                        layoutParams = FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT
                        )
                    })
                    cleanThumbBox.addView(label("✓ 95/100 · Clean", 10f, Color.WHITE, bold = true).apply {
                        setPadding(dp(7), dp(3), dp(7), dp(3))
                        background = GradientDrawable().apply {
                            setColor(0xFF16A34A.toInt())
                            cornerRadius = dp(999).toFloat()
                        }
                        layoutParams = FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                            Gravity.TOP or Gravity.START
                        ).apply {
                            leftMargin = dp(6)
                            topMargin = dp(6)
                        }
                    })
                    addView(cleanThumbBox)
                    addView(label("Avocado Oil Swap ↗", 13f, 0xFF111814.toInt(), bold = true))
                    addView(label("100% avocado oil · Opens in $storeDisplayName", 11f, 0xFF166534.toInt()).apply { setPadding(0, dp(2), 0, 0) })
                })

                compareStage.addView(compareRow)
                compareStage.addView(label("→", 14f, Color.WHITE, bold = true).apply {
                    gravity = Gravity.CENTER
                    elevation = dp(4).toFloat()
                    background = GradientDrawable().apply {
                        shape = GradientDrawable.OVAL
                        setColor(0xFF16A34A.toInt())
                        setStroke(dp(2), Color.WHITE)
                    }
                    layoutParams = FrameLayout.LayoutParams(dp(30), dp(30), Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply {
                        topMargin = dp(54)
                    }
                })
                card.addView(compareStage)

                card.addView(label("Build My Personalized Plan →", 15f, Color.WHITE, bold = true).apply {
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

            // Step 7: Personalized Plan (Start Free Pro Trial / Continue with Free Plan / Log In)
            val refCode = ScanApi.referredByCode(this@MainActivity)
            val isFriendRef = refCode?.startsWith("BROC-", ignoreCase = true) == true
            val effectiveTrialDays = 7
            val freeStarterSwaps = ScanApi.weeklySwapsLimit(this@MainActivity)

            val goalSuffix = if (selectedGoals.size == 1) "" else "s"
            val dietSuffix = if (selectedDietary.size > 0) {
                val ds = if (selectedDietary.size == 1) "" else "s"
                " · ${selectedDietary.size} alert$ds"
            } else {
                ""
            }
            card.addView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(12), dp(9), dp(12), dp(9))
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
                    "✅ Ready: $activeHouseholdTitle · $storesSummary · ${selectedGoals.size} goal$goalSuffix$dietSuffix",
                    12f,
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
                        "🎁 Friend Invite ($refCode) Applied: Start your 7-day trial to unlock +7 Free Pro Days for both of you!"
                    } else {
                        "🎉 Creator Code $refCode Applied: VIP 7-Day Free Pro Trial ($0 Today) Ready!"
                    }
                    addView(label(refMsg, 12f, 0xFF854D0E.toInt(), bold = true))
                })
            }

            card.addView(label("Choose How You Want to Start", 21f, 0xFF111814.toInt(), bold = true))
            val onboardingSubtitle = if (BuildConfig.IS_PLAY_BUILD) {
                "Explore Family Pro plans in Google Play, or start right away on the Free Plan:"
            } else {
                "Try Family Pro free for $effectiveTrialDays days ($0 today), or start right away on the Free Plan:"
            }
            card.addView(label(
                onboardingSubtitle,
                13f,
                0xFF4B5563.toInt()
            ).apply { setPadding(0, dp(4), 0, dp(10)) })

            val proStoresBullet = if (selectedStores.isNotEmpty()) {
                "1-tap healthier picks in $storesSummary & all 12+ stores"
            } else {
                "1-tap healthier picks across all 12+ grocery & delivery stores"
            }
            val proCard = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(12), dp(12), dp(12), dp(12))
                background = GradientDrawable().apply {
                    setColor(Color.WHITE)
                    setStroke(dp(2), 0xFF16A34A.toInt())
                    cornerRadius = dp(16).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(12) }
            }

            // Header Row: Title + Green Badge Pill
            proCard.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(9) }
                addView(label("⭐ HeyBroc Family Pro", 14f, 0xFF14532D.toInt(), bold = true).apply {
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                })
                val badgeText = if (BuildConfig.IS_PLAY_BUILD) {
                    "GOOGLE PLAY PLANS"
                } else {
                    "$effectiveTrialDays DAYS FREE · $0 TODAY"
                }
                addView(label(badgeText, 10f, Color.WHITE, bold = true).apply {
                    setPadding(dp(8), dp(4), dp(8), dp(4))
                    background = GradientDrawable().apply {
                        setColor(0xFF16A34A.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                })
            })

            // 3 Structured Icon-Bubble Feature Rows
            val proFeatures = listOf(
                Triple("🛒", "Unlimited Clean Swaps", proStoresBullet),
                Triple("🧾", "Order Audits & 2x Watchlists", "Receipt health grades + double additive penalties"),
                if (BuildConfig.ENABLE_ACCESSIBILITY_OVERLAY) {
                    Triple("🫧", "Live Store Bubble & Cloud Sync", "Auto-grades carts as you shop + syncs across devices")
                } else {
                    Triple("🛍️", "In-App Live Shop & Cloud Sync", "0–100 score badges as you shop + syncs across devices")
                }
            )
            proFeatures.forEachIndexed { idx, (iconEmoji, featTitle, featSub) ->
                proCard.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(8), dp(7), dp(8), dp(7))
                    background = GradientDrawable().apply {
                        setColor(0xFFF0FDF4.toInt())
                        setStroke(dp(1), 0xFFDCFCE7.toInt())
                        cornerRadius = dp(10).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply {
                        bottomMargin = dp(if (idx < proFeatures.lastIndex) 6 else 8)
                    }
                    addView(label(iconEmoji, 13.5f, 0xFF14532D.toInt()).apply {
                        gravity = Gravity.CENTER
                        background = GradientDrawable().apply {
                            setColor(0xFFDCFCE7.toInt())
                            cornerRadius = dp(8).toFloat()
                        }
                        layoutParams = LinearLayout.LayoutParams(dp(28), dp(28)).apply {
                            marginEnd = dp(9)
                        }
                    })
                    addView(LinearLayout(this@MainActivity).apply {
                        orientation = LinearLayout.VERTICAL
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                        addView(label(featTitle, 12.5f, 0xFF111814.toInt(), bold = true))
                        addView(label(featSub, 11f, 0xFF4B5563.toInt()))
                    })
                })
            }

            proCard.addView(View(this).apply {
                setBackgroundColor(0xFFE5E7EB.toInt())
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)).apply {
                    bottomMargin = dp(7)
                }
            })
            val planPricingSummary = if (BuildConfig.IS_PLAY_BUILD) {
                PlayBillingCoordinator.cachedLocalizedPricingSummary()
                    ?: "View localized plans & trial availability in Google Play. Cancel anytime in Google Play."
            } else {
                "$0 due today · Then $4.17/mo ($49.99/yr) or $9.99/mo. Cancel anytime in 1 tap."
            }
            proCard.addView(label(
                planPricingSummary,
                11f,
                0xFF15803D.toInt(),
                bold = true
            ))
            card.addView(proCard)

            // Primary CTA: Start Free Pro Trial
            val primaryCtaLabel = if (BuildConfig.IS_PLAY_BUILD) {
                "View Google Play Plans →"
            } else {
                "Start $effectiveTrialDays-Day Free Pro Trial ($0 Today) →"
            }
            card.addView(label(primaryCtaLabel, 15f, Color.WHITE, bold = true).apply {
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
                    PlayBillingCoordinator.openUpgradeFlow(this@MainActivity) { renderScreen() }
                }
            })

            // Secondary CTA: Continue with Free Plan (single-line so arrow never wraps to 2nd line)
            card.addView(label("Continue with Free Plan ($freeStarterSwaps Free Swaps Included) →", 12.5f, 0xFF1F2937.toInt(), bold = true).apply {
                gravity = Gravity.CENTER
                setSingleLine(true)
                ellipsize = TextUtils.TruncateAt.END
                setPadding(dp(12), dp(13), dp(12), dp(13))
                background = GradientDrawable().apply {
                    setColor(Color.WHITE)
                    setStroke(dp(2), 0xFFD1D5DB.toInt())
                    cornerRadius = dp(999).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(6) }
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

            // Quiet Returning-User Login Link (only when signed out, never competing with Free Plan)
            val signedInEmail = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
                .getString("auth_email", "")
            if (signedInEmail.isNullOrBlank()) {
                card.addView(label("Already have an account? Log in", 12f, 0xFF6B7280.toInt(), bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(8), dp(6), dp(8), dp(4))
                    setOnClickListener {
                        ScanApi.trackEvent(this@MainActivity, "onboarding_completed", buildAnalyticsProps("signin"))
                        saveWatchlistAndMarkDone()
                        funnelDialog?.dismiss()
                        showGoCoCoLoginDialog(
                            readyTitle = "Your Watchlist is ready",
                            readySubtitle = "Save it and you're all set."
                        )
                    }
                })
            }
        }

        renderFunnelStep(1)

        funnelDialog = AlertDialog.Builder(this).setView(scroll).create().also { dlg ->
            activeFunnelDialog = dlg
            dlg.setOnDismissListener { if (activeFunnelDialog === dlg) activeFunnelDialog = null }
            dlg.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
            dlg.setCanceledOnTouchOutside(alreadyDone)
            dlg.setOnKeyListener { _, keyCode, event ->
                if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
                    if (currentStep > 1) {
                        renderFunnelStep(currentStep - 1)
                        true
                    } else if (!alreadyDone) {
                        dlg.dismiss()
                        finish()
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
                    finish()
                }
            }
            dlg.show()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                dlg.onBackInvokedDispatcher.registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT
                ) {
                    if (currentStep > 1) {
                        renderFunnelStep(currentStep - 1)
                    } else if (!alreadyDone) {
                        dlg.dismiss()
                        finish()
                    } else {
                        dlg.cancel()
                    }
                }
            }
        }
    }

    private fun showGoCoCoLoginDialog(
        readyTitle: String? = null,
        readySubtitle: String? = null
    ) {
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val savedEmail = prefs.getString("auth_email", null)?.takeIf { it.isNotBlank() }
        val savedName = prefs.getString("auth_name", null)?.takeIf { it.isNotBlank() }
        val savedProvider = prefs.getString("auth_provider", "email") ?: "email"

        var authDialog: AlertDialog? = null

        val isBottomSheet = savedEmail == null
        val topCornerPx = dp(28).toFloat()
        val scroll = ScrollView(this)
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            if (isBottomSheet) {
                setPadding(dp(22), dp(14), dp(22), dp(24))
                background = GradientDrawable().apply {
                    setColor(Color.WHITE)
                    cornerRadii = floatArrayOf(
                        topCornerPx, topCornerPx,
                        topCornerPx, topCornerPx,
                        0f, 0f,
                        0f, 0f
                    )
                }
            } else {
                setPadding(dp(24), dp(22), dp(24), dp(22))
                background = GradientDrawable().apply {
                    setColor(Color.WHITE)
                    cornerRadius = topCornerPx
                }
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
            val isEmailVerified = savedProvider != "email" || prefs.getBoolean("auth_email_verified", true)
            val providerBadge = when (savedProvider) {
                "google" -> "Connected with Gmail"
                "apple" -> "✓ Connected with Apple"
                else -> if (isEmailVerified) "✓ Verified Email Account" else "Email Verification Pending"
            }
            providerRow.addView(label(providerBadge, 12.5f, if (isEmailVerified) 0xFF0F7A4A.toInt() else 0xFFB45309.toInt(), bold = true))
            profileCard.addView(providerRow)
            card.addView(profileCard)

            if (!isEmailVerified) {
                val verifyBox = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(14), dp(12), dp(14), dp(12))
                    background = GradientDrawable().apply {
                        setColor(0xFFF8FAFC.toInt())
                        setStroke(dp(1), 0xFFE2E8F0.toInt())
                        cornerRadius = dp(14).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { topMargin = dp(12) }
                }
                verifyBox.addView(label(
                    "Enter the 6-digit verification code sent to $savedEmail to sync any email-based Family Pro plan:",
                    12.5f,
                    0xFF334155.toInt()
                ).apply { setPadding(0, 0, 0, dp(8)) })

                val verifyRow = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                }
                val codeInput = EditText(this).apply {
                    hint = "6-digit code"
                    setHintTextColor(0xFF9CA3AF.toInt())
                    setTextColor(0xFF111814.toInt())
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
                    inputType = android.text.InputType.TYPE_CLASS_NUMBER
                    setSingleLine(true)
                    setPadding(dp(12), dp(10), dp(12), dp(10))
                    background = GradientDrawable().apply {
                        setColor(Color.WHITE)
                        setStroke(dp(1), 0xFFCBD5E1.toInt())
                        cornerRadius = dp(10).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                        marginEnd = dp(8)
                    }
                }
                verifyRow.addView(codeInput)
                verifyRow.addView(label("Verify", 13f, Color.WHITE, bold = true).apply {
                    setPadding(dp(14), dp(10), dp(14), dp(10))
                    background = GradientDrawable().apply {
                        setColor(0xFF0F7A4A.toInt())
                        cornerRadius = dp(10).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { marginEnd = dp(6) }
                    setOnClickListener { btn ->
                        val code = codeInput.text.toString().trim()
                        if (code.length < 6) {
                            Toast.makeText(this@MainActivity, "Enter your 6-digit verification code.", Toast.LENGTH_SHORT).show()
                            return@setOnClickListener
                        }
                        if (!btn.isEnabled) return@setOnClickListener
                        btn.isEnabled = false
                        btn.alpha = 0.6f
                        io.execute {
                            runCatching {
                                val conn = (URL(authApiEndpoint()).openConnection() as HttpURLConnection).apply {
                                    requestMethod = "POST"
                                    doOutput = true
                                    setRequestProperty("Content-Type", "application/json")
                                    connectTimeout = 7000
                                    readTimeout = 7000
                                }
                                try {
                                    val payload = JSONObject().apply {
                                        put("action", "verify_email")
                                        put("email", savedEmail)
                                        put("verificationCode", code)
                                        put("deviceId", ScanApi.deviceId(this@MainActivity))
                                    }.toString()
                                    conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                                    val okHttp = conn.responseCode in 200..299
                                    val stream = if (okHttp) conn.inputStream else conn.errorStream
                                    val raw = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                                    val json = if (raw.isNotBlank()) JSONObject(raw) else JSONObject()
                                    val ok = okHttp && json.optBoolean("ok")
                                    if (ok) {
                                        val usr = json.optJSONObject("user")
                                        ScanApi.saveEntitlementSnapshot(this@MainActivity, usr)
                                        prefs.edit().putBoolean("auth_email_verified", true).apply()
                                    }
                                    val msg = if (ok) "✓ Email verified!" else json.optString("error", "Invalid or expired verification code.")
                                    mainHandler.post {
                                        if (isDestroyed || isFinishing) return@post
                                        btn.isEnabled = true
                                        btn.alpha = 1f
                                        Toast.makeText(this@MainActivity, msg, Toast.LENGTH_LONG).show()
                                        if (ok) {
                                            authDialog?.dismiss()
                                            renderScreen()
                                        }
                                    }
                                } finally {
                                    conn.disconnect()
                                }
                            }.onFailure {
                                mainHandler.post {
                                    if (isDestroyed || isFinishing) return@post
                                    btn.isEnabled = true
                                    btn.alpha = 1f
                                    Toast.makeText(this@MainActivity, "Network error verifying email. Please try again.", Toast.LENGTH_LONG).show()
                                }
                            }
                        }
                    }
                })
                verifyRow.addView(label("Resend", 12.5f, 0xFF334155.toInt(), bold = true).apply {
                    setPadding(dp(10), dp(10), dp(10), dp(10))
                    background = GradientDrawable().apply {
                        setColor(0xFFF1F5F9.toInt())
                        setStroke(dp(1), 0xFFCBD5E1.toInt())
                        cornerRadius = dp(10).toFloat()
                    }
                    setOnClickListener { btn ->
                        if (!btn.isEnabled) return@setOnClickListener
                        btn.isEnabled = false
                        btn.alpha = 0.6f
                        io.execute {
                            runCatching {
                                val conn = (URL(authApiEndpoint()).openConnection() as HttpURLConnection).apply {
                                    requestMethod = "POST"
                                    doOutput = true
                                    setRequestProperty("Content-Type", "application/json")
                                    connectTimeout = 7000
                                    readTimeout = 7000
                                }
                                try {
                                    val payload = JSONObject().apply {
                                        put("action", "resend_verification")
                                        put("email", savedEmail)
                                    }.toString()
                                    conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                                    val okHttp = conn.responseCode in 200..299
                                    val stream = if (okHttp) conn.inputStream else conn.errorStream
                                    val raw = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                                    val json = if (raw.isNotBlank()) JSONObject(raw) else JSONObject()
                                    val msg = if (okHttp && json.optBoolean("ok")) {
                                        json.optString("message", "Sent a 6-digit verification code to $savedEmail.")
                                    } else {
                                        json.optString("error", "Could not send verification email right now.")
                                    }
                                    mainHandler.post {
                                        if (isDestroyed || isFinishing) return@post
                                        btn.isEnabled = true
                                        btn.alpha = 1f
                                        Toast.makeText(this@MainActivity, msg, Toast.LENGTH_LONG).show()
                                    }
                                } finally {
                                    conn.disconnect()
                                }
                            }.onFailure {
                                mainHandler.post {
                                    if (isDestroyed || isFinishing) return@post
                                    btn.isEnabled = true
                                    btn.alpha = 1f
                                    Toast.makeText(this@MainActivity, "Network error resending verification code.", Toast.LENGTH_LONG).show()
                                }
                            }
                        }
                    }
                })
                verifyBox.addView(verifyRow)
                card.addView(verifyBox)
            }

            card.addView(label(if (isEmailVerified) "Continue Shopping  →" else "Verify Later · Continue Shopping  →", 15.5f, Color.WHITE, bold = true).apply {
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
                        .remove("auth_email_verified")
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
                                            .remove("auth_email_verified")
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
                val hasReady = !readyTitle.isNullOrBlank()
                // Compact bottom-sheet grabber handle + top-right close button
                card.addView(FrameLayout(this).apply {
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { bottomMargin = dp(6) }
                    addView(View(this@MainActivity).apply {
                        background = GradientDrawable().apply {
                            setColor(0xFFD4D4D8.toInt())
                            cornerRadius = dp(999).toFloat()
                        }
                        layoutParams = FrameLayout.LayoutParams(dp(38), dp(4), Gravity.CENTER_HORIZONTAL or Gravity.TOP).apply {
                            topMargin = dp(4)
                        }
                    })
                    addView(label("✕", 14f, 0xFF6B7280.toInt(), bold = true).apply {
                        gravity = Gravity.CENTER
                        layoutParams = FrameLayout.LayoutParams(dp(32), dp(32), Gravity.END or Gravity.TOP)
                        background = GradientDrawable().apply {
                            setColor(0xFFF3F4F6.toInt())
                            cornerRadius = dp(999).toFloat()
                        }
                        setOnClickListener { authDialog?.dismiss() }
                    })
                })

                card.addView(label(
                    if (hasReady) "Just one last thing" else "Save your progress",
                    22f,
                    0xFF111814.toInt(),
                    bold = true
                ).apply {
                    gravity = Gravity.CENTER
                })
                card.addView(label(
                    if (hasReady) "Choose how to save your progress." else "Choose how to save your Watchlist & swaps.",
                    13.5f,
                    0xFF6B7280.toInt()
                ).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(8), dp(4), dp(8), dp(18))
                })

                // 1. Primary 1-tap Continue with Google pill
                card.addView(buildIconPillButton(
                    iconRes = R.drawable.ic_google_logo,
                    iconWidthDp = 20,
                    iconHeightDp = 20,
                    text = "Continue with Google",
                    bgColor = Color.WHITE,
                    borderColor = 0xFFCBD5E1.toInt(),
                    textColor = 0xFF0F172A.toInt(),
                    onClick = {
                        launchGoogleWebOAuthOrFallback(
                            onFallbackToEmail = {
                                selectedProvider = "email"
                                renderStep("email_login")
                            },
                            onSuccess = { authDialog?.dismiss() }
                        )
                    }
                ))

                card.addView(label("One tap. No password needed.", 12f, 0xFF64748B.toInt(), bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(0, 0, 0, dp(10))
                })

                // Progressive disclosure email trigger
                card.addView(label("Use email instead", 14f, 0xFF0F7A4A.toInt(), bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(12), dp(8), dp(12), dp(8))
                    setOnClickListener {
                        selectedProvider = "email"
                        renderStep("email_login")
                    }
                })

                card.addView(label("Continue as guest", 13.5f, 0xFF71717A.toInt(), bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(12), dp(4), dp(12), dp(10))
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
                    isRegister -> "Create Free Account"
                    isReset -> "Reset Password"
                    else -> "Sign In with Email"
                },
                23f,
                0xFF111814.toInt(),
                bold = true
            ))

            var activeEmailInput: EditText? = null
            if (!isReset) {
                val tabBar = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    setPadding(dp(4), dp(4), dp(4), dp(4))
                    background = GradientDrawable().apply {
                        setColor(0xFFF1F5F9.toInt())
                        setStroke(dp(1), 0xFFE2E8F0.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply {
                        topMargin = dp(10)
                        bottomMargin = dp(8)
                    }
                }
                fun addModeTab(text: String, active: Boolean, targetStep: String) {
                    tabBar.addView(label(text, 13f, if (active) 0xFF0F7A4A.toInt() else 0xFF475569.toInt(), bold = true).apply {
                        gravity = Gravity.CENTER
                        setPadding(dp(10), dp(9), dp(10), dp(9))
                        background = if (active) GradientDrawable().apply {
                            setColor(Color.WHITE)
                            cornerRadius = dp(999).toFloat()
                        } else null
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                        setOnClickListener {
                            if (!active) {
                                prefilledEmail = activeEmailInput?.text?.toString()?.trim()?.lowercase() ?: prefilledEmail
                                renderStep(targetStep)
                            }
                        }
                    })
                }
                addModeTab("Sign In", !isRegister, "email_login")
                addModeTab("Create Free Account", isRegister, "email_register")
                card.addView(tabBar)
            }

            card.addView(label(
                when {
                    isRegister -> "Create a free HeyBroc account to sync your Watchlist & Clean Swaps across devices."
                    isReset -> "Enter your email, tap Send Reset Code if needed, then enter the 6-digit code and a new password."
                    else -> "Enter your email and password (8+ characters) — saved passwords autofill automatically."
                },
                14f,
                0xFF6B7280.toInt()
            ).apply { setPadding(0, dp(4), 0, dp(16)) })

            val emailInput = EditText(this).apply {
                hint = "Email address"
                setHintTextColor(0xFF9CA3AF.toInt())
                setTextColor(0xFF111814.toInt())
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15.5f)
                inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_YES
                setAutofillHints(View.AUTOFILL_HINT_EMAIL_ADDRESS)
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
            activeEmailInput = emailInput
            card.addView(emailInput)

            fun sendPasswordResetCodeFor(targetEmail: String, triggerBtn: View? = null) {
                if (!targetEmail.contains("@") || !targetEmail.contains(".")) {
                    Toast.makeText(this@MainActivity, "Enter your account email first, then tap Send Reset Code.", Toast.LENGTH_SHORT).show()
                    return
                }
                if (triggerBtn != null && !triggerBtn.isEnabled) return
                triggerBtn?.isEnabled = false
                triggerBtn?.alpha = 0.6f
                io.execute {
                    runCatching {
                        val conn = (URL(authApiEndpoint()).openConnection() as HttpURLConnection).apply {
                            requestMethod = "POST"
                            doOutput = true
                            setRequestProperty("Content-Type", "application/json")
                            connectTimeout = 7000
                            readTimeout = 7000
                        }
                        try {
                            val payload = JSONObject().apply {
                                put("action", "forgot_password")
                                put("email", targetEmail)
                            }.toString()
                            conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                            val okHttp = conn.responseCode in 200..299
                            val stream = if (okHttp) conn.inputStream else conn.errorStream
                            val raw = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                            val json = if (raw.isNotBlank()) JSONObject(raw) else JSONObject()
                            val msg = if (okHttp && json.optBoolean("ok")) {
                                json.optString("message", "If an account exists for $targetEmail, a 6-digit reset code has been emailed.")
                            } else {
                                json.optString("error", "Could not send reset code right now. Please try again.")
                            }
                            mainHandler.post {
                                if (isDestroyed || isFinishing) return@post
                                triggerBtn?.isEnabled = true
                                triggerBtn?.alpha = 1f
                                Toast.makeText(this@MainActivity, msg, Toast.LENGTH_LONG).show()
                            }
                        } finally {
                            conn.disconnect()
                        }
                    }.onFailure {
                        mainHandler.post {
                            if (isDestroyed || isFinishing) return@post
                            triggerBtn?.isEnabled = true
                            triggerBtn?.alpha = 1f
                            Toast.makeText(this@MainActivity, "Network error requesting reset code.", Toast.LENGTH_LONG).show()
                        }
                    }
                }
            }

            if (isReset) {
                card.addView(label("Send / Resend 6-Digit Reset Code", 12.5f, 0xFF0F7A4A.toInt(), bold = true).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(14), dp(8), dp(14), dp(8))
                    background = GradientDrawable().apply {
                        setColor(0xFFECFDF5.toInt())
                        setStroke(dp(1), 0xFFBBF7D0.toInt())
                        cornerRadius = dp(999).toFloat()
                    }
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply {
                        gravity = Gravity.END
                        bottomMargin = dp(10)
                    }
                    setOnClickListener { btn ->
                        val em = emailInput.text.toString().trim().lowercase()
                        prefilledEmail = em
                        sendPasswordResetCodeFor(em, btn)
                    }
                })
            }

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
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_YES
                setAutofillHints(View.AUTOFILL_HINT_PASSWORD)
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
                            sendPasswordResetCodeFor(em)
                        }
                    }
                })
            }

            val submitLabel = when {
                isRegister -> "Create Free Account  →"
                isReset -> "Save New Password  →"
                else -> "Sign In  →"
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
                        provider = "email",
                        onSuccess = { authDialog?.dismiss() }
                    )
                }
            })
        }

        renderStep("welcome")

        val sheetHost = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.BOTTOM
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            if (!readyTitle.isNullOrBlank()) {
                addView(LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.VERTICAL
                    gravity = Gravity.CENTER
                    setPadding(dp(24), dp(12), dp(24), dp(22))
                    setOnClickListener { authDialog?.dismiss() }
                    addView(label("✓", 19f, 0xFFDCFCE7.toInt(), bold = true).apply {
                        gravity = Gravity.CENTER
                        layoutParams = LinearLayout.LayoutParams(dp(44), dp(44)).apply {
                            bottomMargin = dp(10)
                        }
                        background = GradientDrawable().apply {
                            shape = GradientDrawable.OVAL
                            setColor(0x4716A34A)
                            setStroke(dp(2), 0xEB86EFAC.toInt())
                        }
                    })
                    addView(label(readyTitle, 21f, Color.WHITE, bold = true).apply {
                        gravity = Gravity.CENTER
                    })
                    if (!readySubtitle.isNullOrBlank()) {
                        addView(label(readySubtitle, 13.5f, 0xE6F0FDF4.toInt(), bold = false).apply {
                            gravity = Gravity.CENTER
                            setPadding(dp(12), dp(5), dp(12), 0)
                        })
                    }
                })
            }
            addView(scroll, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ))
        }

        authDialog = AlertDialog.Builder(this).setView(sheetHost).create().also { dlg ->
            activeAuthDialog = dlg
            dlg.setOnDismissListener { if (activeAuthDialog === dlg) activeAuthDialog = null }
            dlg.window?.apply {
                setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
                setGravity(Gravity.BOTTOM)
                if (!readyTitle.isNullOrBlank()) {
                    setDimAmount(0.84f)
                }
                decorView.setPadding(0, 0, 0, 0)
            }
            dlg.show()
            dlg.window?.setLayout(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
    }

    private fun generateSecureHex(bytesCount: Int = 16): String {
        val bytes = ByteArray(bytesCount)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private fun decodeJwtPreview(idToken: String): Pair<String, String> {
        var claimEmail = ""
        var claimName = ""
        runCatching {
            val parts = idToken.split(".")
            if (parts.size >= 2) {
                val decoded = String(
                    android.util.Base64.decode(
                        parts[1],
                        android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING
                    ),
                    Charsets.UTF_8
                )
                val claims = JSONObject(decoded)
                claimEmail = claims.optString("email", "").trim().lowercase()
                claimName = claims.optString("name", "").trim()
            }
        }
        return Pair(claimEmail, claimName)
    }

    private data class OAuthServerConfig(
        val clientId: String,
        val oauthNonce: String
    )

    private fun authApiEndpoint(): String {
        val base = BuildConfig.API_BASE.trim().trimEnd('/').ifBlank { "https://www.heybroc.com" }
        return "$base/api/auth"
    }

    private fun fetchServerOAuthConfig(prefs: android.content.SharedPreferences): OAuthServerConfig {
        val cachedClientId = prefs.getString("cached_google_client_id", "").orEmpty().trim()
        var resolvedClientId = cachedClientId
        var resolvedNonce = ""
        runCatching {
            val conn = (URL("${authApiEndpoint()}?config=1&oauthNonce=1").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 3500
                readTimeout = 3500
                setRequestProperty("Accept", "application/json")
            }
            try {
                if (conn.responseCode in 200..299) {
                    val raw = conn.inputStream.bufferedReader().use { it.readText() }
                    val json = JSONObject(raw)
                    val fetchedId = json.optString("googleClientId", "").trim()
                    if (fetchedId.isNotBlank()) {
                        resolvedClientId = fetchedId
                        prefs.edit().putString("cached_google_client_id", fetchedId).apply()
                    }
                    resolvedNonce = json.optString("oauthNonce", "").trim()
                }
            } finally {
                conn.disconnect()
            }
        }
        return OAuthServerConfig(
            clientId = resolvedClientId,
            oauthNonce = resolvedNonce.ifBlank { generateSecureHex(16) }
        )
    }

    private fun openGoogleOAuthCustomTab(clientId: String, serverNonce: String = ""): Boolean {
        val cleanClientId = clientId.trim()
        if (cleanClientId.isBlank()) return false
        val nonce = serverNonce.trim().ifBlank { generateSecureHex(16) }
        val state = "android_${generateSecureHex(16)}"
        getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
            .edit()
            .putString("pending_google_oauth_state", state)
            .putString("pending_google_oauth_nonce", nonce)
            .putLong("pending_google_oauth_ts", System.currentTimeMillis())
            .apply()

        val authUri = Uri.parse("https://accounts.google.com/o/oauth2/v2/auth").buildUpon()
            .appendQueryParameter("client_id", cleanClientId)
            .appendQueryParameter("redirect_uri", "https://www.heybroc.com/auth/google-callback")
            .appendQueryParameter("response_type", "id_token")
            .appendQueryParameter("scope", "openid email profile")
            .appendQueryParameter("prompt", "select_account")
            .appendQueryParameter("nonce", nonce)
            .appendQueryParameter("state", state)
            .build()

        return runCatching {
            val ctIntent = Intent(Intent.ACTION_VIEW, authUri).apply {
                putExtras(Bundle().apply {
                    putBinder("android.support.customtabs.extra.SESSION", null)
                })
                putExtra("android.support.customtabs.extra.TOOLBAR_COLOR", 0xFF111814.toInt())
            }
            startActivity(ctIntent)
            true
        }.getOrDefault(false)
    }

    private fun launchGoogleCredentialManager(
        clientId: String,
        serverNonce: String,
        onLocalFallback: () -> Unit,
        onServerExchangeFallback: () -> Unit = onLocalFallback,
        onSuccess: (() -> Unit)?
    ) {
        val cleanClientId = clientId.trim()
        if (cleanClientId.isBlank()) {
            onLocalFallback()
            return
        }
        val nonce = serverNonce.trim().ifBlank { generateSecureHex(16) }
        val googleIdOption = runCatching {
            GetGoogleIdOption.Builder()
                .setFilterByAuthorizedAccounts(false)
                .setServerClientId(cleanClientId)
                .setNonce(nonce)
                .build()
        }.getOrNull()
        if (googleIdOption == null) {
            onLocalFallback()
            return
        }
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(googleIdOption)
            .build()
        val credentialManager = runCatching { CredentialManager.create(this) }.getOrNull()
        if (credentialManager == null) {
            onLocalFallback()
            return
        }
        val callbackExecutor = Executor { runnable -> mainHandler.post(runnable) }
        credentialManager.getCredentialAsync(
            this,
            request,
            CancellationSignal(),
            callbackExecutor,
            object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                override fun onResult(result: GetCredentialResponse) {
                    if (isDestroyed || isFinishing) return
                    val credential = result.credential
                    val idToken = if (
                        credential is CustomCredential &&
                        credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
                    ) {
                        runCatching { GoogleIdTokenCredential.createFrom(credential.data).idToken.trim() }
                            .getOrDefault("")
                    } else {
                        ""
                    }
                    if (idToken.isNotBlank()) {
                        confirmAndExchangeGoogleIdToken(
                            idToken = idToken,
                            nonce = nonce,
                            onSuccess = onSuccess,
                            onServerExchangeFailure = onServerExchangeFallback
                        )
                    } else {
                        onLocalFallback()
                    }
                }

                override fun onError(e: GetCredentialException) {
                    if (isDestroyed || isFinishing) return
                    if (e is GetCredentialCancellationException) {
                        return
                    }
                    onLocalFallback()
                }
            }
        )
    }

    private fun launchGoogleWebOAuthOrFallback(
        onFallbackToEmail: () -> Unit,
        onSuccess: (() -> Unit)? = null
    ) {
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        io.execute {
            val cfg = fetchServerOAuthConfig(prefs)
            mainHandler.post {
                if (isDestroyed || isFinishing) return@post
                if (cfg.clientId.isBlank()) {
                    onFallbackToEmail()
                    return@post
                }
                launchGoogleCredentialManager(
                    clientId = cfg.clientId,
                    serverNonce = cfg.oauthNonce,
                    onLocalFallback = {
                        // Nonce has not been sent to /api/auth yet, safe to reuse directly
                        if (!openGoogleOAuthCustomTab(cfg.clientId, cfg.oauthNonce)) {
                            onFallbackToEmail()
                        }
                    },
                    onServerExchangeFallback = {
                        // Previous nonce may have been consumed; mint a fresh server nonce before Custom Tab fallback
                        io.execute {
                            val freshCfg = fetchServerOAuthConfig(prefs)
                            mainHandler.post {
                                if (isDestroyed || isFinishing) return@post
                                if (!openGoogleOAuthCustomTab(cfg.clientId, freshCfg.oauthNonce)) {
                                    onFallbackToEmail()
                                }
                            }
                        }
                    },
                    onSuccess = onSuccess
                )
            }
        }
    }

    private fun handleIncomingAuthRedirect(incoming: Intent?): Boolean {
        val data = incoming?.data ?: return false
        if (!data.scheme.equals("heybroc", ignoreCase = true) || !data.host.equals("auth", ignoreCase = true)) {
            return false
        }
        incoming.data = null

        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val expectedState = prefs.getString("pending_google_oauth_state", "").orEmpty().trim()
        val expectedNonce = prefs.getString("pending_google_oauth_nonce", "").orEmpty().trim()
        val pendingTs = prefs.getLong("pending_google_oauth_ts", 0L)

        val idToken = data.getQueryParameter("id_token").orEmpty().trim()
        val returnedState = data.getQueryParameter("state").orEmpty().trim()
        val err = data.getQueryParameter("error").orEmpty().trim()

        val now = System.currentTimeMillis()
        val pendingExpired = pendingTs > 0L && (now - pendingTs) !in 0L..600_000L
        if (pendingExpired) {
            prefs.edit()
                .remove("pending_google_oauth_state")
                .remove("pending_google_oauth_nonce")
                .remove("pending_google_oauth_ts")
                .apply()
            Toast.makeText(this, "Google sign-in session expired. Please try again.", Toast.LENGTH_LONG).show()
            return true
        }

        val stateValid =
            expectedState.isNotBlank() &&
                returnedState.isNotBlank() &&
                expectedState == returnedState &&
                expectedNonce.isNotBlank() &&
                pendingTs > 0L &&
                (now - pendingTs) in 0L..600_000L

        if (!stateValid) {
            // Do not clear an active, unexpired pending_google_oauth_* session on a mismatched state parameter
            Toast.makeText(this, "Google sign-in session expired. Please try again.", Toast.LENGTH_LONG).show()
            return true
        }

        prefs.edit()
            .remove("pending_google_oauth_state")
            .remove("pending_google_oauth_nonce")
            .remove("pending_google_oauth_ts")
            .apply()

        if (err.isNotBlank() || idToken.isBlank()) {
            if (err != "access_denied" && err != "cancelled") {
                Toast.makeText(this, "Google sign-in could not be completed. Please try again.", Toast.LENGTH_LONG).show()
            }
            return true
        }

        confirmAndExchangeGoogleIdToken(
            idToken = idToken,
            nonce = expectedNonce,
            onSuccess = null
        )
        return true
    }

    private fun confirmAndExchangeGoogleIdToken(
        idToken: String,
        nonce: String,
        onSuccess: (() -> Unit)?,
        onServerExchangeFailure: (() -> Unit)? = null
    ) {
        val (claimEmail, claimName) = decodeJwtPreview(idToken)
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val existingToken = prefs.getString("auth_token", "").orEmpty().trim()
        val existingEmail = prefs.getString("auth_email", "").orEmpty().trim().lowercase()

        if ((existingToken.isNotBlank() || existingEmail.isNotBlank()) &&
            existingEmail.isNotBlank() &&
            (claimEmail.isBlank() || !existingEmail.equals(claimEmail, ignoreCase = true))
        ) {
            if (isDestroyed || isFinishing) return
            val promptMsg = if (claimEmail.isNotBlank()) {
                "You are currently signed in as $existingEmail. Switch this device to $claimEmail?"
            } else {
                "You are currently signed in as $existingEmail. Replace your signed-in account on this device?"
            }
            AlertDialog.Builder(this)
                .setTitle("Switch HeyBroc Account?")
                .setMessage(promptMsg)
                .setPositiveButton("Switch Account") { _, _ ->
                    exchangeGoogleIdTokenOnServer(idToken, nonce, claimEmail, claimName, onSuccess, onServerExchangeFailure)
                }
                .setNegativeButton("Cancel", null)
                .show()
            return
        }

        exchangeGoogleIdTokenOnServer(idToken, nonce, claimEmail, claimName, onSuccess, onServerExchangeFailure)
    }

    private fun exchangeGoogleIdTokenOnServer(
        idToken: String,
        nonce: String,
        claimEmail: String,
        claimName: String,
        onSuccess: (() -> Unit)?,
        onServerExchangeFailure: (() -> Unit)? = null
    ) {
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        Toast.makeText(this, "Completing Google sign-in…", Toast.LENGTH_SHORT).show()
        io.execute {
            runCatching {
                val conn = (URL(authApiEndpoint()).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    connectTimeout = 7000
                    readTimeout = 7000
                }
                val (okHttp, json) = try {
                    val payload = JSONObject().apply {
                        put("action", "oauth")
                        put("provider", "google")
                        put("idToken", idToken)
                        if (nonce.isNotBlank()) put("nonce", nonce)
                        if (claimEmail.isNotBlank()) put("email", claimEmail)
                        if (claimName.isNotBlank()) put("displayName", claimName)
                        put("deviceId", ScanApi.deviceId(this@MainActivity))
                        put("deviceSecret", ScanApi.deviceSecret(this@MainActivity))
                    }.toString()
                    conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                    val okStatus = conn.responseCode in 200..299
                    val stream = if (okStatus) conn.inputStream else conn.errorStream
                    val raw = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                    val parsed = if (raw.isNotBlank()) JSONObject(raw) else JSONObject()
                    Pair(okStatus && parsed.optBoolean("ok"), parsed)
                } finally {
                    conn.disconnect()
                }

                if (okHttp) {
                    val tok = json.optString("token", "")
                    val usr = json.optJSONObject("user")
                    val resolvedEmail = usr?.optString("email", claimEmail)?.ifBlank { claimEmail } ?: claimEmail
                    val fallbackName = claimName.ifBlank { resolvedEmail.substringBefore("@") }
                    val resolvedName = usr?.optString("displayName", fallbackName)?.ifBlank { fallbackName } ?: fallbackName
                    ScanApi.saveEntitlementSnapshot(this@MainActivity, usr)
                    prefs.edit()
                        .putString("auth_email", resolvedEmail)
                        .putString("auth_name", resolvedName)
                        .putString("auth_provider", "google")
                        .putString("auth_token", tok)
                        .putBoolean("auth_email_verified", true)
                        .putBoolean("onboarding_funnel_done_v1", true)
                        .apply()
                    ScanApi.trackEvent(
                        this@MainActivity,
                        "auth_completed",
                        properties = JSONObject().put("provider", "google")
                    )
                    mainHandler.post {
                        if (isDestroyed || isFinishing) return@post
                        onSuccess?.invoke()
                        activeAuthDialog?.dismiss()
                        activeFunnelDialog?.dismiss()
                        renderScreen()
                        Toast.makeText(this@MainActivity, "👋 Signed in with Google as $resolvedName!", Toast.LENGTH_LONG).show()
                    }
                } else {
                    mainHandler.post {
                        if (isDestroyed || isFinishing) return@post
                        if (onServerExchangeFailure != null) {
                            onServerExchangeFailure.invoke()
                        } else {
                            Toast.makeText(this@MainActivity, "Could not verify Google account. Please try again.", Toast.LENGTH_LONG).show()
                        }
                    }
                }
            }.onFailure {
                mainHandler.post {
                    if (isDestroyed || isFinishing) return@post
                    Toast.makeText(this@MainActivity, "Network error completing Google sign-in.", Toast.LENGTH_LONG).show()
                }
            }
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
                if (!ok && action == "register" && json.optString("error").contains("already", ignoreCase = true)) {
                    val loginResult = sendAuthRequest("login")
                    ok = loginResult.first
                    json = loginResult.second
                }

                if (ok) {
                    val tok = json.optString("token", "")
                    val usr = json.optJSONObject("user")
                    val resolvedName = usr?.optString("displayName", fallbackName) ?: fallbackName
                    val emailVerified = usr?.optBoolean("emailVerified", provider != "email") ?: (provider != "email")
                    val createdNow = json.optBoolean("created", false)
                    val verEmailSent = json.optBoolean("verificationEmailSent", true)
                    ScanApi.saveEntitlementSnapshot(this@MainActivity, usr)
                    prefs.edit()
                        .putString("auth_email", email)
                        .putString("auth_name", resolvedName)
                        .putString("auth_provider", provider)
                        .putString("auth_token", tok)
                        .putBoolean("auth_email_verified", emailVerified)
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
                        if (createdNow && provider == "email" && !emailVerified) {
                            val notice = if (verEmailSent) {
                                "Account created! Check $email for your 6-digit verification code."
                            } else {
                                "Account created! Verification email is currently unavailable — you can tap Resend later."
                            }
                            Toast.makeText(this@MainActivity, notice, Toast.LENGTH_LONG).show()
                            showGoCoCoLoginDialog()
                        } else {
                            Toast.makeText(this@MainActivity, "👋 Welcome, $resolvedName! Account synced.", Toast.LENGTH_LONG).show()
                        }
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

    private fun performLiveProductSearch(
        query: String,
        rawIngredients: String = "",
        storeOverride: String? = null
    ) {
        val seq = ++liveSearchSeq
        lastSearchQuery = query
        isSearching = true
        hideKeyboard()
        renderScreen()

        val appCtx = applicationContext
        val storeKey = storeOverride?.takeIf { it.isNotBlank() } ?: preferredStoreKey()
        io.execute {
            if (seq != liveSearchSeq) return@execute
            val raw = runCatching { ScanApi.scan(appCtx, query, rawIngredients, storeKey) }.getOrNull()
            if (seq != liveSearchSeq) return@execute
            val parsed = raw?.let { runCatching { JSONObject(it) }.getOrNull() }
            runOnUiThread {
                if (isDestroyed || isFinishing || seq != liveSearchSeq) return@runOnUiThread
                isSearching = false
                if (parsed?.optBoolean("ok") == true) {
                    ScanHistoryStore.recordScan(this, parsed, storeKey)
                    renderScreen()
                    showProductDetailDialog(parsed)
                } else {
                    renderScreen()
                    if (rawIngredients.isBlank()) {
                        AlertDialog.Builder(this)
                            .setTitle("Package Label Needed")
                            .setMessage("We couldn't find verified US ingredients for \"$query\" yet. Paste or type the Ingredients list from the package or a screenshot to grade it instantly!")
                            .setPositiveButton("📸 Paste Label") { _, _ ->
                                showLabelScannerDialog(initialTitle = query)
                            }
                            .setNegativeButton("Cancel", null)
                            .show()
                    } else {
                        Toast.makeText(
                            this,
                            "Couldn't reach live scanner for \"$query\" — please check your connection.",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                }
            }
        }
    }

    private fun readPrimaryClipboardText(): String {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return ""
        val clip = cm.primaryClip ?: return ""
        if (clip.itemCount <= 0) return ""
        return clip.getItemAt(0)?.coerceToText(this)?.toString()?.trim().orEmpty()
    }

    private fun showLabelScannerDialog(initialTitle: String = "") {
        var dialogRef: AlertDialog? = null
        val scroll = ScrollView(this)
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(14))
            setBackgroundColor(Color.WHITE)
        }

        box.addView(label("📸 Scan / Paste Ingredient Label", 19f, 0xFF111814.toInt(), bold = true))
        box.addView(label(
            "Zero-miss fallback: copy text from any package photo or screenshot (Google Lens / Live Text) or type ingredients below for an instant 0–100 grade & Clean Swap.",
            13f,
            0xFF4B5563.toInt()
        ).apply { setPadding(0, dp(4), 0, dp(12)) })

        box.addView(label("PRODUCT NAME", 11f, 0xFF374151.toInt(), bold = true).apply {
            letterSpacing = 0.05f
            setPadding(0, 0, 0, dp(4))
        })
        val titleInput = EditText(this).apply {
            hint = "e.g. Baked Cheddar Snack Crackers"
            setText(initialTitle)
            textSize = 14.5f
            setSingleLine(true)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = GradientDrawable().apply {
                setColor(0xFFF9FAFB.toInt())
                cornerRadius = dp(12).toFloat()
                setStroke(dp(1), 0xFFD1D5DB.toInt())
            }
        }
        box.addView(titleInput)

        box.addView(label("INGREDIENTS LIST (FROM PACKAGE OR SCREENSHOT)", 11f, 0xFF374151.toInt(), bold = true).apply {
            letterSpacing = 0.05f
            setPadding(0, dp(12), 0, dp(4))
        })
        val ingInput = EditText(this).apply {
            hint = "Paste or type ingredients… e.g. Enriched Flour, Soybean Oil, Sugar, High Fructose Corn Syrup, Red 40, TBHQ."
            textSize = 13.5f
            minLines = 4
            maxLines = 8
            gravity = Gravity.TOP or Gravity.START
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = GradientDrawable().apply {
                setColor(0xFFF9FAFB.toInt())
                cornerRadius = dp(12).toFloat()
                setStroke(dp(1), 0xFF2E9E5B.toInt())
            }
        }
        box.addView(ingInput)

        val helperRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(10) }
        }
        helperRow.addView(label("📋 Paste Clipboard", 12f, 0xFF065F46.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(10), dp(8), dp(10), dp(8))
            background = GradientDrawable().apply {
                setColor(0xFFECFDF5.toInt())
                setStroke(dp(1), 0xFFA7F3D0.toInt())
                cornerRadius = dp(999).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginEnd = dp(6)
            }
            setOnClickListener {
                val clip = readPrimaryClipboardText()
                if (clip.isBlank()) {
                    Toast.makeText(this@MainActivity, "Clipboard is empty.", Toast.LENGTH_SHORT).show()
                    return@setOnClickListener
                }
                val (parsedTitle, parsedIng) = extractCleanQueryFromSharedText(clip, "")
                if (parsedIng.isNotBlank()) {
                    if (titleInput.text.toString().isBlank() && parsedTitle.isNotBlank()) {
                        titleInput.setText(parsedTitle)
                    }
                    ingInput.setText(parsedIng)
                } else {
                    ingInput.setText(clip)
                }
                Toast.makeText(this@MainActivity, "✓ Pasted from clipboard", Toast.LENGTH_SHORT).show()
            }
        })
        helperRow.addView(label("🧪 Sample Label", 12f, 0xFF1F2937.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(10), dp(8), dp(10), dp(8))
            background = GradientDrawable().apply {
                setColor(0xFFF3F4F6.toInt())
                setStroke(dp(1), 0xFFD1D5DB.toInt())
                cornerRadius = dp(999).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            setOnClickListener {
                titleInput.setText("Cheddar Snack Crackers")
                ingInput.setText(
                    "Enriched Flour (Wheat Flour, Niacin, Reduced Iron), Vegetable Oil (Soybean and Palm Oil with TBHQ for Freshness), Cheese Made with Skim Milk, Salt, Paprika, Yeast, Soy Lecithin, Yellow 6, Red 40."
                )
            }
        })
        box.addView(helperRow)

        scroll.addView(box)
        dialogRef = AlertDialog.Builder(this)
            .setView(scroll)
            .setPositiveButton("🔬 Grade Label Now") { _, _ ->
                val pTitle = titleInput.text.toString().trim().ifBlank { "Scanned Package Label" }
                val pIng = ingInput.text.toString().trim()
                if (pIng.length < 4 && pTitle == "Scanned Package Label") {
                    Toast.makeText(this, "Please enter a product name or paste its ingredients.", Toast.LENGTH_SHORT).show()
                } else {
                    dialogRef?.dismiss()
                    performLiveProductSearch(pTitle, rawIngredients = pIng)
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showWeeklyOrderAuditDialog(initialOrderText: String = "") {
        var dialogRef: AlertDialog? = null
        var preferStoreBrand = ScanApi.isPreferStoreBrand(this)
        val scroll = ScrollView(this)
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(18), dp(20), dp(18))
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(24).toFloat()
            }
        }

        val headerRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(4) }
        }
        headerRow.addView(label("🧾 Receipt & Cart Audit", 18.5f, 0xFF111814.toInt(), bold = true).apply {
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        headerRow.addView(label("✕", 15f, 0xFF6B7280.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            val sz = dp(32)
            layoutParams = LinearLayout.LayoutParams(sz, sz)
            background = GradientDrawable().apply {
                setColor(0xFFF3F4F6.toInt())
                cornerRadius = dp(999).toFloat()
            }
            setOnClickListener { dialogRef?.dismiss() }
        })
        box.addView(headerRow)

        box.addView(label(
            "Paste a receipt or grocery list to score items & find Clean Swaps.",
            13f,
            0xFF6B7280.toInt()
        ).apply { setPadding(0, 0, 0, dp(12)) })

        val orderInput = EditText(this).apply {
            hint = "Paste receipt text or 1 item per line…\ne.g. Cheez-It Original Crackers, Hidden Valley Ranch"
            setText(initialOrderText)
            textSize = 13.5f
            setTextColor(0xFF111814.toInt())
            setHintTextColor(0xFF9CA3AF.toInt())
            minLines = 4
            maxLines = 8
            gravity = Gravity.TOP or Gravity.START
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = GradientDrawable().apply {
                setColor(0xFFF9FAFB.toInt())
                cornerRadius = dp(14).toFloat()
                setStroke(dp(1), 0xFFD1D5DB.toInt())
            }
        }
        box.addView(orderInput)

        val helperRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(10) }
        }
        helperRow.addView(label("📋 Paste Clipboard", 12.5f, 0xFF065F46.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            setSingleLine(true)
            ellipsize = TextUtils.TruncateAt.END
            setPadding(dp(10), 0, dp(10), 0)
            background = GradientDrawable().apply {
                setColor(0xFFECFDF5.toInt())
                setStroke(dp(1), 0xFFA7F3D0.toInt())
                cornerRadius = dp(999).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(0, dp(36), 1f).apply {
                marginEnd = dp(8)
            }
            setOnClickListener {
                val clip = readPrimaryClipboardText()
                if (clip.isBlank()) {
                    Toast.makeText(this@MainActivity, "Clipboard is empty.", Toast.LENGTH_SHORT).show()
                } else {
                    orderInput.setText(clip)
                    Toast.makeText(this@MainActivity, "✓ Pasted order text", Toast.LENGTH_SHORT).show()
                }
            }
        })
        helperRow.addView(label("✨ Try Sample", 12.5f, 0xFF374151.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            setSingleLine(true)
            ellipsize = TextUtils.TruncateAt.END
            setPadding(dp(10), 0, dp(10), 0)
            background = GradientDrawable().apply {
                setColor(0xFFF3F4F6.toInt())
                setStroke(dp(1), 0xFFE5E7EB.toInt())
                cornerRadius = dp(999).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(0, dp(36), 1f)
            setOnClickListener {
                orderInput.setText(
                    "Walmart Pickup Order\n" +
                        "Qty 2 Cheez-It Original Baked Snack Crackers, 12.4 oz\n" +
                        "Hidden Valley Original Ranch Salad Dressing, 16 fl oz\n" +
                        "Kellogg's Frosted Flakes Breakfast Cereal, 13.5 oz\n" +
                        "Qty 3 Welch's Mixed Fruit Flavored Snacks, 10 ct\n" +
                        "Oscar Mayer Uncured Wieners Hot Dogs, 16 oz\n" +
                        "Coffee mate French Vanilla Liquid Coffee Creamer, 32 fl oz\n" +
                        "Organic Bananas, Bunch"
                )
            }
        })
        box.addView(helperRow)

        val sbCheck = CheckBox(this).apply {
            text = "Prefer store-brand swaps"
            textSize = 13f
            setTextColor(0xFF374151.toInt())
            isChecked = preferStoreBrand
            setOnCheckedChangeListener { _, checked ->
                preferStoreBrand = checked
                ScanApi.setPreferStoreBrand(this@MainActivity, checked)
            }
        }
        box.addView(sbCheck.apply { setPadding(0, dp(8), 0, dp(4)) })

        val resultsContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(10) }
        }

        val runBtn = label("Find Clean Swaps →", 14.5f, Color.WHITE, bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(14), dp(13), dp(14), dp(13))
            background = GradientDrawable().apply {
                setColor(0xFF16A34A.toInt())
                cornerRadius = dp(999).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(4) }
        }
        box.addView(runBtn)
        box.addView(resultsContainer)

        runBtn.setOnClickListener {
            val rawText = orderInput.text.toString().trim()
            if (rawText.length < 4) {
                Toast.makeText(this, "Paste a receipt or tap Try Sample first.", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            hideKeyboard()
            runBtn.text = "⏳ Auditing Order Items…"
            runBtn.isEnabled = false
            resultsContainer.removeAllViews()

            val appCtx = applicationContext
            val detected = detectStoreFromSharedText(rawText)
            val fallbackStore = detected ?: preferredStoreKey()
            val useSb = preferStoreBrand
            io.execute {
                val auditJson = ScanApi.auditOrder(
                    appCtx,
                    rawOrderText = rawText,
                    storeOverride = fallbackStore,
                    preferStoreBrandOverride = useSb
                )
                runOnUiThread {
                    if (isDestroyed || isFinishing) return@runOnUiThread
                    runBtn.text = "Find Clean Swaps →"
                    runBtn.isEnabled = true
                    resultsContainer.removeAllViews()

                    if (!auditJson.optBoolean("ok", false)) {
                        val err = auditJson.optString("error", "Could not audit order right now.")
                        resultsContainer.addView(label("⚠️ $err", 13f, 0xFFB91C1C.toInt(), bold = true).apply {
                            setPadding(dp(8), dp(8), dp(8), dp(8))
                        })
                        return@runOnUiThread
                    }

                    val avgBefore = if (auditJson.isNull("averageBefore")) null else auditJson.optInt("averageBefore")
                    val avgAfter = if (auditJson.isNull("averageAfter")) null else auditJson.optInt("averageAfter")
                    val scoredCount = auditJson.optInt("itemsScored", 0)
                    val swapsCount = auditJson.optInt("swapsAvailable", 0)
                    val effStore = auditJson.optString("effectiveStore").ifBlank {
                        auditJson.optString("detectedStore").ifBlank { fallbackStore }
                    }
                    val effStoreLabel = storeNameForKey(effStore)

                    if (avgBefore != null && avgAfter != null) {
                        val delta = (avgAfter - avgBefore).coerceAtLeast(0)
                        resultsContainer.addView(LinearLayout(this).apply {
                            orientation = LinearLayout.VERTICAL
                            setPadding(dp(14), dp(12), dp(14), dp(12))
                            background = GradientDrawable().apply {
                                setColor(0xFFECFDF5.toInt())
                                setStroke(dp(1), 0xFF6EE7B7.toInt())
                                cornerRadius = dp(16).toFloat()
                            }
                            layoutParams = LinearLayout.LayoutParams(
                                ViewGroup.LayoutParams.MATCH_PARENT,
                                ViewGroup.LayoutParams.WRAP_CONTENT
                            ).apply { bottomMargin = dp(10) }
                            addView(label("WEEKLY CART HEALTH JUMP · ${effStoreLabel.uppercase()}", 10.5f, 0xFF065F46.toInt(), bold = true).apply {
                                letterSpacing = 0.05f
                            })
                            addView(label(
                                "Before: $avgBefore/100  →  After Swaps: $avgAfter/100 (+$delta pts)",
                                15.5f,
                                0xFF14532D.toInt(),
                                bold = true
                            ).apply { setPadding(0, dp(4), 0, dp(2)) })
                            addView(label(
                                "$scoredCount items graded · $swapsCount Clean Swaps ready",
                                12f,
                                0xFF166534.toInt()
                            ))
                        })
                    }

                    val resArr = auditJson.optJSONArray("results") ?: JSONArray()
                    val rows = ArrayList<JSONObject>()
                    for (i in 0 until resArr.length()) {
                        val r = resArr.optJSONObject(i) ?: continue
                        val resObj = r.optJSONObject("result")
                        val hasScore = resObj != null && resObj.has("score") && !resObj.isNull("score")
                        val isNonFood = r.optJSONObject("product")
                            ?.optJSONObject("nutrition")
                            ?.optString("productKind") == "non-food"
                        if (r.optBoolean("ok", false) && hasScore && !isNonFood) {
                            rows.add(r)
                        }
                    }
                    rows.sortBy { it.optJSONObject("result")?.optInt("score", 99) ?: 99 }

                    if (rows.isEmpty()) {
                        resultsContainer.addView(label(
                            "No food or beverage staples matched those lines. Try listing one grocery item per line (e.g. Doritos Nacho Cheese).",
                            13f,
                            0xFF4B5563.toInt()
                        ).apply { setPadding(dp(8), dp(8), dp(8), dp(8)) })
                    }

                    rows.forEach { r ->
                        ScanHistoryStore.recordScan(this, r, effStore)
                        val pTitle = ScanHistoryStore.extractTitle(r)
                        val sc = r.optJSONObject("result")?.optInt("score", 50) ?: 50
                        val qty = r.optInt("quantity", 1)
                        val sw = r.optJSONObject("swap")

                        val itemBox = LinearLayout(this).apply {
                            orientation = LinearLayout.VERTICAL
                            setPadding(dp(12), dp(10), dp(12), dp(10))
                            background = GradientDrawable().apply {
                                setColor(0xFFF9FAFB.toInt())
                                setStroke(dp(1), 0xFFE5E7EB.toInt())
                                cornerRadius = dp(14).toFloat()
                            }
                            layoutParams = LinearLayout.LayoutParams(
                                ViewGroup.LayoutParams.MATCH_PARENT,
                                ViewGroup.LayoutParams.WRAP_CONTENT
                            ).apply { bottomMargin = dp(8) }
                            setOnClickListener {
                                dialogRef?.dismiss()
                                showProductDetailDialog(r)
                            }
                        }
                        val qtyPrefix = if (qty > 1) "${qty}x " else ""
                        itemBox.addView(label(
                            "● $qtyPrefix$pTitle · $sc/100 (${ratingForScore(sc)})",
                            13.5f,
                            yukaDotColor(sc),
                            bold = true
                        ))
                        if (sw != null) {
                            val swTitle = sw.optString("title", "Clean Swap")
                            val swScore = sw.optInt("score", 90)
                            val swUnlocked = !sw.optBoolean("locked", false) && ScanApi.isSwapUnlocked(this, pTitle, swTitle)
                            val isSb = sw.optBoolean("isStoreBrand", false)
                            val sbTag = if (isSb) " · 💚 Store-Brand Pick" else ""
                            val swDisplay = if (swUnlocked) {
                                "⇄ Swap: $swTitle ($swScore/100)$sbTag"
                            } else {
                                "🔒 $swScore/100 Clean Swap Ready (Tap to inspect)"
                            }
                            itemBox.addView(label(swDisplay, 12f, 0xFF166534.toInt(), bold = true).apply {
                                setPadding(0, dp(4), 0, 0)
                            })
                        }
                        resultsContainer.addView(itemBox)
                    }
                    renderScreen()
                }
            }
        }

        scroll.addView(box)
        dialogRef = AlertDialog.Builder(this).setView(scroll).create().also { dlg ->
            dlg.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
            dlg.show()
        }
    }

    private fun shareProductScoreCard(item: JSONObject, storeDisplayName: String) {
        val res = item.optJSONObject("result")
        val title = ScanHistoryStore.extractTitle(item).ifBlank { "Grocery Product" }
        val score = res?.optInt("score") ?: item.optInt("score", 50)
        val rating = ratingForScore(score)
        val flagged = res?.optJSONArray("flagged") ?: JSONArray()
        val topFlags = ArrayList<String>()
        for (i in 0 until minOf(3, flagged.length())) {
            val nm = flagged.optJSONObject(i)?.optString("name").orEmpty().trim()
            if (nm.isNotBlank()) topFlags.add(nm)
        }

        val swap = item.optJSONObject("swap")
        val swapTitle = swap?.optString("title").orEmpty()
        val swapScore = swap?.optInt("score", 0) ?: 0
        val swapUnlocked = swap != null && !swap.optBoolean("locked", false) && ScanApi.isSwapUnlocked(this, title, swapTitle)
        val isStoreBrand = swap?.optBoolean("isStoreBrand", false) == true

        val refCode = ScanApi.myReferralCode(this)
        val encodedShare = java.net.URLEncoder.encode(title, "UTF-8")
        val encodedRef = java.net.URLEncoder.encode(refCode, "UTF-8")
        val shareUrl = "https://www.heybroc.com/?share=$encodedShare&ref=$encodedRef"

        val statusIcon = when {
            score >= 75 -> "🟢"
            score >= 50 -> "🟡"
            else -> "🔴"
        }
        val textSummary = buildString {
            append("🥦 HeyBroc Food Exposé:\n")
            append("$statusIcon $title — $score/100 ($rating)\n")
            if (topFlags.isNotEmpty()) {
                append("⚠️ Flagged: ${topFlags.joinToString(", ")}\n")
            } else {
                append("✓ 0 Watchlist Additives Flagged\n")
            }
            if (swap != null && swapScore > 0) {
                if (swapUnlocked && swapTitle.isNotBlank()) {
                    val sbNote = if (isStoreBrand) " [💚 Store-Brand Value Pick]" else ""
                    append("🟢 1-Tap Clean Swap ($storeDisplayName): $swapTitle — $swapScore/100$sbNote\n")
                } else {
                    append("🟢 1-Tap Clean Swap Available in $storeDisplayName: $swapScore/100\n")
                }
            }
            append("\nScan this item or check your groceries free: $shareUrl")
        }

        ScanApi.trackEvent(
            this,
            "expose_card_shared",
            JSONObject().put("productTitle", title).put("score", score)
        )
        runCatching {
            val sendIntent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_SUBJECT, "HeyBroc Score: $title ($score/100)")
                putExtra(Intent.EXTRA_TEXT, textSummary)
            }
            startActivity(Intent.createChooser(sendIntent, "Share HeyBroc Score Card"))
        }
    }

    private fun showProductDetailDialog(item: JSONObject) {
        ScanApi.applyLocalWatchlistToData(this, item)
        val prod = item.optJSONObject("product")
        val res = item.optJSONObject("result")
        val title = ScanHistoryStore.extractTitle(item)
        val brand = prod?.optString("brand").orEmpty().ifBlank { item.optString("brand") }
        val barcode = prod?.optString("barcode").orEmpty()
            .ifBlank { item.optJSONObject("lookup")?.optString("barcode").orEmpty() }
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
        val storeBrandSwap = item.optJSONObject("storeBrandSwap")
        val storeSwapLink = item.optJSONObject("storeSwapLink")

        val sheetScroll = ScrollView(this)
        val sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(18))
            setBackgroundColor(Color.WHITE)
        }

        // Top Product Header (Photo + Title + Brand + ★ Star)
        val detailStoreImg = prod?.optString("storeImageUrl").orEmpty()
        val detailCatArt = prod?.optString("categoryArtUrl").orEmpty()
        val topHeader = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        topHeader.addView(buildProductImageBox(imgUrl, title, dp(64), dp(76), brand, barcode, detailStoreImg, detailCatArt).apply {
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
        val pestDed = yb?.optInt("pesticideDeduction", 0) ?: 0

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
            if (pestDed > 0) {
                addView(label("🌱 Pesticide Watch Deduction: -$pestDed pts", 12.5f, 0xFFB45309.toInt(), bold = true).apply {
                    setPadding(0, dp(3), 0, 0)
                })
            }
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
            val serverLocked = swap.optBoolean("locked", false)
            val swapUnlocked = !serverLocked && ScanApi.isSwapUnlocked(this, title, swapTitle)
            val isStoreBrand = swap.optBoolean("isStoreBrand", false)
            val rem = ScanApi.swapsRemaining(this)
            val lim = ScanApi.weeklySwapsLimit(this)
            val isPaidLink = resolveTrackedPaidSwapUrl(swap, itemStoreKey) != null

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
                if (isStoreBrand) {
                    swapCard.addView(label("💚 Store-Brand Value Pick", 11.5f, 0xFF065F46.toInt(), bold = true).apply {
                        setPadding(dp(9), dp(3), dp(9), dp(3))
                        background = GradientDrawable().apply {
                            setColor(0xFFD1FAE5.toInt())
                            setStroke(dp(1), 0xFF6EE7B7.toInt())
                            cornerRadius = dp(999).toFloat()
                        }
                        layoutParams = LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT
                        ).apply { topMargin = dp(5) }
                    })
                }
                val swapHeaderRow = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(0, dp(6), 0, dp(8))
                }
                val swapBrandDetail = swap.optString("brand", "")
                val swapBarcodeDetail = swap.optString("barcode", "")
                val swapCatArtDetail = swap.optString("categoryArtUrl", "")
                swapHeaderRow.addView(buildProductImageBox(swapImg, swapTitle, dp(52), dp(62), swapBrandDetail, swapBarcodeDetail, "", swapCatArtDetail).apply {
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

                val sbAltTitle = storeBrandSwap?.optString("title").orEmpty()
                val sbAltBrand = storeBrandSwap?.optString("brand").orEmpty()
                val sbAltScore = storeBrandSwap?.optInt("score", 0) ?: 0
                val sbServerLocked = storeBrandSwap?.optBoolean("locked", false) == true
                val sbMatchesStore = !sbServerLocked && ScanHistoryStore.isStoreBrandForStore("$sbAltBrand $sbAltTitle", itemStoreKey)
                if (!isStoreBrand && storeBrandSwap != null && sbAltTitle.isNotBlank() && sbMatchesStore && !sbAltTitle.equals(swapTitle, ignoreCase = true)) {
                    val canRevealSb = ScanApi.isProActive(this) || rem > 0 || ScanApi.isSwapUnlocked(this, title, sbAltTitle)
                    val sbBtnLabel = if (canRevealSb) {
                        "💚 Switch to Store-Brand Pick: $sbAltTitle ($sbAltScore/100)"
                    } else {
                        "🔒 Unlock Store-Brand Value Pick ($sbAltScore/100)"
                    }
                    swapCard.addView(label(
                        sbBtnLabel,
                        12f,
                        0xFF065F46.toInt(),
                        bold = true
                    ).apply {
                        gravity = Gravity.CENTER
                        setPadding(dp(10), dp(8), dp(10), dp(8))
                        background = GradientDrawable().apply {
                            setColor(Color.WHITE)
                            setStroke(dp(1), 0xFF6EE7B7.toInt())
                            cornerRadius = dp(999).toFloat()
                        }
                        layoutParams = LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT
                        ).apply { topMargin = dp(8) }
                        setOnClickListener {
                            if (!ScanApi.unlockSwapForProduct(this@MainActivity, title, sbAltTitle)) {
                                dialogRef?.dismiss()
                                PlayBillingCoordinator.openUpgradeFlow(this@MainActivity) { renderScreen() }
                                return@setOnClickListener
                            }
                            val promoted = JSONObject(storeBrandSwap.toString()).put("isStoreBrand", true)
                            ScanHistoryStore.upgradeSwapForStore(promoted, title, itemStoreKey)
                            item.put("swap", promoted)
                            ScanHistoryStore.recordScan(this@MainActivity, item, itemStoreKey)
                            dialogRef?.dismiss()
                            renderScreen()
                            showProductDetailDialog(item)
                        }
                    })
                }
            } else if (!serverLocked && rem > 0 && swapTitle.isNotBlank()) {
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
                        dialogRef?.dismiss()
                        PlayBillingCoordinator.openUpgradeFlow(this@MainActivity) { renderScreen() }
                    }
                })
            }
            sheet.addView(swapCard)
        } else if (storeSwapLink != null) {
            ScanHistoryStore.upgradeSwapForStore(storeSwapLink, "", itemStoreKey)
            val isPaidLink = resolveTrackedPaidSwapUrl(storeSwapLink, itemStoreKey) != null
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

        // 1-Tap Share Before/After Product Exposé Score Card
        sheet.addView(label("📤 Share Before/After Score Card", 13f, 0xFF065F46.toInt(), bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(12), dp(11), dp(12), dp(11))
            background = GradientDrawable().apply {
                setColor(0xFFF0FDF4.toInt())
                setStroke(dp(1), 0xFF86EFAC.toInt())
                cornerRadius = dp(999).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(10) }
            setOnClickListener { shareProductScoreCard(item, storeDisplayName) }
        })

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
            append(" · Tap to auto-verify label")
        }
        sheet.addView(
            label(provenanceLine, 11f, 0xFF0F7A4A.toInt(), bold = true).apply {
                setPadding(dp(4), dp(10), dp(4), dp(2))
                setOnClickListener {
                    isEnabled = false
                    setTextColor(0xFF0F7A4A.toInt())
                    text = "🤖 Checking USDA & Open Food Facts…"
                    ScanApi.autoVerifyLabelOutcome(title, ingredients, itemStoreKey) { outcome ->
                        text = outcome.message
                        setTextColor(
                            when {
                                outcome.verified -> 0xFF15803D.toInt()
                                outcome.ok -> 0xFFB45309.toInt()
                                else -> 0xFFB91C1C.toInt()
                            }
                        )
                        isEnabled = !outcome.ok
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
                        put("barcode", prod?.optString("barcode").orEmpty().ifBlank { item.optString("barcode") })
                        put("score", res?.optInt("score") ?: item.optInt("score", 50))
                        put("imageUrl", prod?.optString("imageUrl").orEmpty().ifBlank { ScanHistoryStore.productImageUrl(t) })
                        put("categoryArtUrl", prod?.optString("categoryArtUrl").orEmpty().ifBlank { item.optString("categoryArtUrl") })
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
                val sugBarcode = sug.optString("barcode")
                val sugScore = sug.optInt("score", 50)
                val sugImg = sug.optString("imageUrl").ifBlank { ScanHistoryStore.productImageUrl(sugTitle, sugBrand, sugBarcode) }
                val sugCatArt = sug.optString("categoryArtUrl")
                    .ifBlank { fullItem?.optJSONObject("product")?.optString("categoryArtUrl").orEmpty() }

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
                row.addView(buildProductImageBox(sugImg, sugTitle, dp(38), dp(46), sugBrand, sugBarcode, categoryArtUrl = sugCatArt).apply {
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
                    suggestExecutor.execute {
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

    private fun buildNeutralPackagePlaceholder(
        wPx: Int,
        hPx: Int,
        initialText: String = "B"
    ): View {
        val palettes = arrayOf(
            intArrayOf(0xFFECFDF5.toInt(), 0xFFA7F3D0.toInt(), 0xFF065F46.toInt()),
            intArrayOf(0xFFEFF6FF.toInt(), 0xFFBFDBFE.toInt(), 0xFF1E40AF.toInt()),
            intArrayOf(0xFFFFFBEB.toInt(), 0xFFFDE68A.toInt(), 0xFF92400E.toInt()),
            intArrayOf(0xFFF5F3FF.toInt(), 0xFFDDD6FE.toInt(), 0xFF5B21B6.toInt()),
            intArrayOf(0xFFF0FDFA.toInt(), 0xFF99F6E4.toInt(), 0xFF115E59.toInt()),
            intArrayOf(0xFFF8FAFC.toInt(), 0xFFCBD5E1.toInt(), 0xFF334155.toInt())
        )
        val ch = initialText.trim().ifEmpty { "B" }
        val idx = (ch[0].code and 0x7FFFFFFF) % palettes.size
        val pal = palettes[idx]
        val fontSp = ((minOf(wPx, hPx) / resources.displayMetrics.density) * 0.36f).coerceIn(13f, 24f)
        return TextView(this).apply {
            text = ch
            gravity = Gravity.CENTER
            setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSp)
            setTextColor(pal[2])
            setTypeface(typeface, Typeface.BOLD)
            background = GradientDrawable().apply {
                setColor(pal[0])
                cornerRadius = dp(10).toFloat()
                setStroke(dp(1), pal[1])
            }
            layoutParams = FrameLayout.LayoutParams(wPx, hPx)
        }
    }

    private fun buildProductImageBox(
        imgUrl: String,
        title: String,
        wPx: Int,
        hPx: Int,
        brand: String = "",
        code: String = "",
        storeImageUrl: String = "",
        categoryArtUrl: String = "",
        category: String = "",
        ingredients: String = "",
        priority: Int = 0,
        deferUntilVisible: Boolean = false,
        cancelOnTabEpoch: Boolean = false
    ): FrameLayout {
        val box = FrameLayout(this)
        val initial = ScanHistoryStore.brandInitial(title, brand)
        val fallback = buildNeutralPackagePlaceholder(wPx, hPx, initial)
        box.addView(fallback)

        val iv = ImageView(this).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
            layoutParams = FrameLayout.LayoutParams(wPx, hPx)
        }
        box.addView(iv)

        val compactBadge = wPx < dp(46)
        val illustrationBadge = TextView(this).apply {
            text = if (compactBadge) "Art" else "Illustration"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, if (compactBadge) 6.5f else 7.5f)
            setTextColor(0xFF475569.toInt())
            setTypeface(typeface, Typeface.BOLD)
            setSingleLine(true)
            setPadding(dp(if (compactBadge) 2 else 4), dp(1), dp(if (compactBadge) 2 else 4), dp(1))
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
        box.addView(illustrationBadge)

        val primaryUrl = ScanHistoryStore.resolveBestImageUrl(title, imgUrl, brand, code)
        val fallbackApiUrl = if (primaryUrl.contains("/api/product-image")) {
            ""
        } else {
            ScanHistoryStore.productImageApiFallbackUrl(title, brand, code)
        }
        val safeStoreImg = SafeBitmapLoader.sanitizeExternalImageUrl(storeImageUrl, rejectHeyBroc = true)
        val normalizedCatArt = ScanHistoryStore.normalizeCategoryArtUrl(categoryArtUrl)
            .ifBlank { ScanHistoryStore.resolveCategoryStudioArt(title, category, ingredients) }
        val candidates = buildList {
            if (safeStoreImg.isNotEmpty()) add(safeStoreImg)
            if (primaryUrl.isNotEmpty()) add(primaryUrl)
            if (fallbackApiUrl.isNotEmpty()) add(fallbackApiUrl)
            if (normalizedCatArt.isNotEmpty()) add(normalizedCatArt)
        }.distinct()
        if (candidates.isNotEmpty()) {
            box.background = GradientDrawable().apply {
                setColor(0xFFF3F4F6.toInt())
                cornerRadius = dp(10).toFloat()
            }
            fallback.visibility = View.INVISIBLE
        }
        val maxTargetPx = (maxOf(wPx, hPx) * 2).coerceIn(96, 360)
        loadThumbnailCandidatesAsync(
            candidates = candidates,
            target = iv,
            fallback = fallback,
            illustrationBadge = illustrationBadge,
            maxTargetPx = maxTargetPx,
            hostBox = box,
            priority = priority,
            deferUntilVisible = deferUntilVisible,
            cancelOnTabEpoch = cancelOnTabEpoch
        )
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

    private fun isDirectNativeStoreProductLink(url: String, storeKey: String): Boolean {
        if (!ScanHistoryStore.urlMatchesStore(url, storeKey)) return false
        val host = runCatching { Uri.parse(url).host?.lowercase().orEmpty() }.getOrDefault("")
        if (host.isEmpty() || host.startsWith("goto.") || host.contains("impact") || host.contains("ojrq") || host.contains("pntra")) {
            return false
        }
        return Regex("""/(ip|p|dp|products?)/[^/?#]+""", RegexOption.IGNORE_CASE).containsMatchIn(url)
    }

    private fun resolveExternalBrowserPackage(): String? {
        val probe = Intent(Intent.ACTION_VIEW, Uri.parse("https://www.heybroc.com"))
        val resolved = runCatching { packageManager.resolveActivity(probe, 0)?.activityInfo?.packageName }.getOrNull().orEmpty()
        if (resolved.isNotBlank() && !resolved.equals("android", ignoreCase = true) && resolved !in GroceryScreenReaderService.STORE_PACKAGES) {
            return resolved
        }
        return listOf("com.android.chrome", "org.mozilla.firefox", "com.sec.android.app.sbrowser", "com.opera.browser", "com.brave.browser")
            .firstOrNull { candidatePkg -> runCatching { packageManager.getLaunchIntentForPackage(candidatePkg) }.getOrNull() != null }
    }

    private fun resolveTrackedPaidSwapUrl(swap: JSONObject?, storeKey: String): String? {
        if (swap == null || !swap.optBoolean("isPaidLink", false)) return null
        val raw = swap.optString("webUrl").trim().ifBlank { swap.optString("deepLink").trim() }
        if (raw.isBlank()) return null
        val normalized = normalizeSwapUrl(raw).let {
            if (it.startsWith("http://", ignoreCase = true)) "https://" + it.substring(7) else it
        }
        if (!normalized.startsWith("https://", ignoreCase = true)) return null
        if (!ScanHistoryStore.urlMatchesStore(normalized, storeKey)) return null
        if (!ScanHistoryStore.isTrackedAffiliateUrl(normalized)) return null
        return LiveStoreBrowserActivity.validatedRetailerUrl(normalized)
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
        val serverLocked = swapObj?.optBoolean("locked", false) == true
        val effectiveQuery = swapObj?.optString("searchQuery").orEmpty()
            .ifBlank { swapObj?.optString("title").orEmpty() }
            .ifBlank { query }
        val isSwapAction = swapObj != null || effectiveQuery.isNotBlank()
        if (isSwapAction && (serverLocked || (!ScanApi.isSwapUnlocked(this, prodTitle, effectiveQuery) && !ScanApi.canUseSwap(this)))) {
            ScanApi.trackEvent(this, "paywall_viewed")
            val limit = ScanApi.weeklySwapsLimit(this)
            AlertDialog.Builder(this)
                .setTitle(ScanApi.paywallHeadline(this))
                .setMessage(
                    "You've used all $limit free single-item Clean Swaps.\n\n" +
                        "Product scores (0–100) and Cart Avg stay 100% free forever. Invite friends for free Pro weeks or sign in to an existing Pro account."
                )
                .setNegativeButton("Close", null)
                .setPositiveButton("Upgrade to Pro") { _, _ ->
                    PlayBillingCoordinator.openUpgradeFlow(this) { renderScreen() }
                }
                .show()
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

        val preferInApp = isPreferInAppShop()
        val trackedPaidUrl = resolveTrackedPaidSwapUrl(swapObj, storeKey)
        if (trackedPaidUrl != null) {
            if (preferInApp) {
                startActivity(
                    LiveStoreBrowserActivity.createIntent(
                        context = this,
                        storeKey = storeKey,
                        initialUrl = trackedPaidUrl,
                        searchQuery = null
                    )
                )
                return
            }
            val paidIntent = Intent(Intent.ACTION_VIEW, Uri.parse(trackedPaidUrl))
            resolveExternalBrowserPackage()?.let { paidIntent.setPackage(it) }
            if (runCatching { startActivity(paidIntent) }.isSuccess ||
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(trackedPaidUrl))) }.isSuccess
            ) {
                return
            }
        }

        val rawDeepLink = swapObj?.optString("deepLink").orEmpty().ifBlank { swapObj?.optString("webUrl").orEmpty() }
        val normalizedLink = normalizeSwapUrl(rawDeepLink)
        val explicitDeepLink = if (ScanHistoryStore.urlMatchesStore(normalizedLink, storeKey)) normalizedLink else ""
        val explicitPkg = (ScanHistoryStore.resolveInstalledStorePackage(this, storeKey)
            ?: ScanHistoryStore.storePackageForKey(storeKey)).ifBlank {
            swapObj?.optString("androidPackage").orEmpty()
        }
        val isDirectProductLink = storeKey != "walmart" && isDirectNativeStoreProductLink(explicitDeepLink, storeKey)
        val supportsDirectUrlDeepLink = isDirectProductLink || (
            explicitPkg in setOf("com.target.ui", "com.amazon.mShop.android.shopping") &&
                !explicitDeepLink.contains("goto.") &&
                !explicitDeepLink.contains("impact")
            )
        if (!preferInApp && explicitDeepLink.startsWith("http") && supportsDirectUrlDeepLink && explicitPkg.isNotBlank()) {
            if (runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(explicitDeepLink)).setPackage(explicitPkg)) }.isSuccess) {
                return
            }
        }

        if (!preferInApp && explicitPkg.isNotBlank() && effectiveQuery.isNotBlank()) {
            val searchIntent = Intent(Intent.ACTION_SEARCH)
                .setPackage(explicitPkg)
                .putExtra(android.app.SearchManager.QUERY, effectiveQuery)
            if (runCatching { startActivity(searchIntent) }.isSuccess) return

            val gmsSearchIntent = Intent("com.google.android.gms.actions.SEARCH_ACTION")
                .setPackage(explicitPkg)
                .putExtra(android.app.SearchManager.QUERY, effectiveQuery)
            if (runCatching { startActivity(gmsSearchIntent) }.isSuccess) return

            // If Accessibility is active and the store app is installed (e.g. Walmart), launch the native app
            // and drive its search bar directly so Android App Links never opens a blank white WebView!
            if (GroceryScreenReaderService.activeWindowManager() != null) {
                val launchHome = runCatching { packageManager.getLaunchIntentForPackage(explicitPkg) }.getOrNull()
                if (launchHome != null && runCatching {
                        startActivity(launchHome.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
                    }.isSuccess
                ) {
                    GroceryScreenReaderService.requestInAppSearch(explicitPkg, effectiveQuery)
                    return
                }
            }
        }

        val targetWebUrl = explicitDeepLink.ifBlank { ScanHistoryStore.storeSearchUrl(storeKey, effectiveQuery) }
        if (LiveStoreBrowserActivity.validatedRetailerUrl(targetWebUrl) != null) {
            startActivity(
                LiveStoreBrowserActivity.createIntent(
                    context = this,
                    storeKey = storeKey,
                    initialUrl = explicitDeepLink.ifBlank { null },
                    searchQuery = if (explicitDeepLink.isBlank()) effectiveQuery else null
                )
            )
            return
        }
        val browserIntent = Intent(Intent.ACTION_VIEW, Uri.parse(targetWebUrl))
        resolveExternalBrowserPackage()?.let { browserIntent.setPackage(it) }
        if (runCatching { startActivity(browserIntent) }.isFailure) {
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(targetWebUrl))) }
        }
    }

    private fun openWalmartSearch(query: String) {
        openStoreSwap(query, "walmart", null)
    }

    private fun loadThumbnailCandidatesAsync(
        candidates: List<String>,
        target: ImageView,
        fallback: View,
        illustrationBadge: View? = null,
        maxTargetPx: Int = 240,
        hostBox: View? = null,
        priority: Int = 0,
        deferUntilVisible: Boolean = false,
        cancelOnTabEpoch: Boolean = false
    ) {
        if (candidates.isEmpty()) return
        for (url in candidates) {
            val cached = bmpCache.get(url) ?: SafeBitmapLoader.getCachedMemoryBitmap(url, maxTargetPx)
            if (cached != null) {
                bmpCache.put(url, cached)
                target.setImageBitmap(cached)
                fallback.visibility = View.GONE
                hostBox?.background = null
                illustrationBadge?.visibility =
                    if (ScanHistoryStore.isCategoryArtUrl(url)) View.VISIBLE else View.GONE
                return
            }
        }
        val capturedEpoch = imageRenderEpoch
        val enqueueFetch: () -> Unit = {
            val seq = imageTaskSeq.incrementAndGet()
            runCatching {
                imgExecutor.execute(PriorityImageTask(priority, seq, task@{
                    if (isDestroyed || isFinishing || (cancelOnTabEpoch && capturedEpoch != imageRenderEpoch)) {
                        return@task
                    }
                    var bmp: Bitmap? = null
                    var resolvedKey = ""
                    for (url in candidates) {
                        if (isDestroyed || isFinishing || (cancelOnTabEpoch && capturedEpoch != imageRenderEpoch)) {
                            return@task
                        }
                        bmp = SafeBitmapLoader.fetchScaledBitmap(url, maxTargetPx)
                        if (bmp != null) {
                            resolvedKey = url
                            break
                        }
                    }
                    if (isDestroyed || isFinishing || (cancelOnTabEpoch && capturedEpoch != imageRenderEpoch)) {
                        return@task
                    }
                    if (bmp != null && resolvedKey.isNotEmpty()) {
                        bmpCache.put(resolvedKey, bmp)
                        val isIllustration = ScanHistoryStore.isCategoryArtUrl(resolvedKey)
                        mainHandler.post {
                            if (isDestroyed || isFinishing || (cancelOnTabEpoch && capturedEpoch != imageRenderEpoch)) {
                                return@post
                            }
                            target.setImageBitmap(bmp)
                            fallback.visibility = View.GONE
                            hostBox?.background = null
                            illustrationBadge?.visibility = if (isIllustration) View.VISIBLE else View.GONE
                        }
                    } else {
                        mainHandler.post {
                            if (isDestroyed || isFinishing || (cancelOnTabEpoch && capturedEpoch != imageRenderEpoch)) {
                                return@post
                            }
                            hostBox?.background = null
                            fallback.visibility = View.VISIBLE
                        }
                    }
                }))
            }
        }

        if (deferUntilVisible) {
            deferredThumbLoaders.add(DeferredThumbLoader(hostBox ?: target, capturedEpoch, enqueueFetch))
        } else {
            enqueueFetch()
        }
    }

    private fun triggerVisibleDeferredThumbnails() {
        if (deferredThumbLoaders.isEmpty() || !::contentScroll.isInitialized) return
        if (!contentScroll.getGlobalVisibleRect(scrollVisibleRect) || scrollVisibleRect.height() <= 0) return
        val lookaheadPx = dp(650)
        val minTop = scrollVisibleRect.top - lookaheadPx
        val maxBottom = scrollVisibleRect.bottom + lookaheadPx
        val iter = deferredThumbLoaders.iterator()
        while (iter.hasNext()) {
            val entry = iter.next()
            if (entry.epoch != imageRenderEpoch) {
                iter.remove()
                continue
            }
            if (!entry.view.isAttachedToWindow || entry.view.height <= 0) continue
            entry.view.getLocationInWindow(thumbScreenLoc)
            val viewTop = thumbScreenLoc[1]
            val viewBottom = viewTop + entry.view.height
            if (viewBottom >= minTop && viewTop <= maxBottom) {
                iter.remove()
                entry.trigger()
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
        if (!BuildConfig.ENABLE_ACCESSIBILITY_OVERLAY) {
            Toast.makeText(this, "Tap any store tile above to shop with live 0–100 badges inside HeyBroc!", Toast.LENGTH_LONG).show()
            return
        }
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
            startPermissionWatcher()
            scheduleSettingsToasts(
                "Tap 'Installed apps' → 'HeyBroc' → flip switch ON!",
                "Almost done! Tap 'HeyBroc' and turn the switch ON!"
            )
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
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
                "HeyBroc uses the Android AccessibilityService API solely inside 12 supported grocery retailers " +
                    "(15 Android app packages: Walmart, Instacart, Target, Kroger, ALDI, DoorDash, Uber Eats, Amazon Shopping / Amazon Fresh & Whole Foods Market, Sam's Club, BJ's, Costco, and Shipt) to:\n" +
                    "1) Inspect visible, non-editable screen text on device to detect grocery product pages and extract the visible product title, visible ingredient list, and visible barcode text (if displayed on screen),\n" +
                    "2) Extract visible cart item titles (up to 20 visible items on Cart screens) and \"in cart\" indicators so your Whole-Cart Health Check reflects your real cart, and\n" +
                    "3) Only when you explicitly tap \"Find in Store\" or \"Swap in Store\" on a Clean Swap, enter that replacement product into the active store's search bar for you.\n\n" +
                    "• What is transmitted: Matched visible grocery product title candidates, visible ingredient text, visible barcode text (if displayed on screen), active store identifier, your selected additive & allergy watchlist preferences, any claimed referral code, and a random install-scoped device ID (retained for up to 1 year for Pro entitlement and free swap accounting) are sent over HTTPS to heybroc.com/api/scan.\n" +
                    "• Scope & Safeguards: HeyBroc is restricted by Android package filter to the 12 supported grocery retailers (15 Android app packages) above, ignores invisible/off-screen nodes, password fields, payment fields, editable inputs, and chat/message containers on device before candidate extraction, never reads hardware identifiers, and never sells personal data."
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
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(10), dp(8), dp(10), dp(8))
                background = GradientDrawable().apply {
                    setColor(0xFFECFDF5.toInt())
                    setStroke(dp(1), 0xFFA7F3D0.toInt())
                    cornerRadius = dp(12).toFloat()
                }
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(10) }
                addView(CheckBox(this@MainActivity).apply {
                    text = "💚 Store-Brand Budget Swaps First"
                    textSize = 13.5f
                    setTextColor(0xFF065F46.toInt())
                    typeface = Typeface.DEFAULT_BOLD
                    isChecked = ScanApi.isPreferStoreBrand(this@MainActivity)
                    setOnCheckedChangeListener { _, checked ->
                        ScanApi.setPreferStoreBrand(this@MainActivity, checked)
                        renderScreen()
                    }
                })
                addView(label(
                    "Prioritize clean store brands (Great Value Organic, bettergoods, Good & Gather, Kirkland Signature, Simple Truth, Simply Nature & 365) over specialty brands when available.",
                    11.5f,
                    0xFF166534.toInt()
                ).apply {
                    setPadding(dp(32), 0, dp(4), dp(2))
                })
            })
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
                ScanApi.setPreferStoreBrand(this, false)
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

    override fun onResume() {
        super.onResume()
        clearScheduledToasts()
        if (BuildConfig.IS_PLAY_BUILD) {
            PlayBillingCoordinator.syncExistingPurchases(this) {
                if (!isDestroyed && !isFinishing) renderScreen()
            }
        }
        renderScreen()
        val prefs = getSharedPreferences("ingredient_preferences", Context.MODE_PRIVATE)
        val savedEmail = prefs.getString("auth_email", null)?.takeIf { it.isNotBlank() }
        val alreadyPromptedPostPro = prefs.getBoolean("post_pro_save_prompted_v1", false)
        if (
            savedEmail == null &&
            !alreadyPromptedPostPro &&
            ScanApi.isProActive(this) &&
            activeAuthDialog == null &&
            activeFunnelDialog == null
        ) {
            prefs.edit().putBoolean("post_pro_save_prompted_v1", true).apply()
            mainHandler.postDelayed({
                if (!isDestroyed && !isFinishing && activeAuthDialog == null && activeFunnelDialog == null) {
                    showGoCoCoLoginDialog(
                        readyTitle = "Your Family Pro is active",
                        readySubtitle = "Sync Pro & your Watchlist across devices."
                    )
                }
            }, 220L)
        }
    }

    override fun onStop() {
        super.onStop()
        if (BuildConfig.ENABLE_ACCESSIBILITY_OVERLAY && (Settings.canDrawOverlays(this) || isAccessibilityEnabled())) {
            runCatching {
                startService(Intent(this, OverlayWindowService::class.java).setAction(OverlayWindowService.ACTION_HIDE_IF_TEST))
            }
        }
    }

    override fun onDestroy() {
        imageRenderEpoch++
        deferredThumbLoaders.clear()
        runCatching { activeAuthDialog?.dismiss() }
        activeAuthDialog = null
        runCatching { activeFunnelDialog?.dismiss() }
        activeFunnelDialog = null
        mainHandler.removeCallbacks(permissionWatcher)
        pendingSuggestRunnable?.let { mainHandler.removeCallbacks(it) }
        io.shutdownNow()
        imgExecutor.shutdownNow()
        suggestExecutor.shutdownNow()
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
