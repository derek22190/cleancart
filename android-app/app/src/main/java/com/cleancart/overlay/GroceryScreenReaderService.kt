package com.cleancart.overlay

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.ArrayDeque
import java.util.concurrent.Executors

/**
 * Reads ONLY the product title (and visible ingredient text, if on screen) from the four
 * supported grocery apps, debounced by 1.2s, then posts to /api/scan and hands the result
 * to [OverlayWindowService]. Automatically detects when the user navigates back to a
 * search / aisle scroll view and switches the corner bubble to Mode B (`🛒 Cart Avg`).
 */
class GroceryScreenReaderService : AccessibilityService() {

    companion object {
        val STORE_PACKAGES = setOf(
            "com.walmart.android",
            "com.instacart.client",
            "com.target.ui",
            "com.kroger.mobile",
            "de.apptiv.business.android.aldi_us",
            "com.dd.doordash",
            "com.ubercab.eats",
            "com.amazon.mShop.android.shopping",
            "com.samsclub.app",
            "com.bjs.mobile",
            "com.costco.app.android",
            "com.shipt.groceries"
        )
        private const val DEBOUNCE_MS = 750L
        private const val FOREGROUND_CHECK_MS = 1500L
        private const val MAX_NODES = 1800
        private val TITLE_ID_HINTS = listOf(
            "pdp_title",
            "product_title",
            "producttitle",
            "product_name",
            "productname",
            "item_name",
            "itemname",
            "item_title"
        )
        private val HOME_OR_AISLE_BANNERS = Regex(
            """shop all food|rollbacks\s*&\s*more|your favorites,\s*for less|the holiday shop|use walmart\+?\s*gas savings|hosting,\s*decor\s*&\s*more|search results for|department|featured categories""",
            RegexOption.IGNORE_CASE,
        )
        private val SINGLE_PDP_CTA = Regex(
            """\b(add to cart|add to order|buy now|add \d+ to cart|choose options)\b""",
            RegexOption.IGNORE_CASE,
        )
        private val SINGLE_PDP_DETAILS = Regex(
            """^(about this item|product details|ingredients|nutrition facts|specifications|at a glance|product description|details)$""",
            RegexOption.IGNORE_CASE,
        )
        private val NOISE = Regex(
            """^\$|^\d+\s*(ct|count|pack|oz|lb|reviews?|ratings?)|^\+?\s*add$|add to cart|add to order|buy now|choose options|sign in|search|reviews?$|ratings?$|stars?\b|pickup|delivery|shipping|see all|view all|sponsored|bought \d|stay stocked|last purchased|try a subscription|overall pick|best seller|popular pick|rollback|free shipping|arrives|preparing|out of stock|in stock|aisle\s+[a-z0-9]|shop now|learn more|terms apply|holiday denim|levi strauss|subscribe|add to list|share|similar items|frequently bought|customers also|you might also|nutrition facts|serving size|calories|about this item|product details|specifications|at a glance|gas savings|walmart\+|scan barcodes|qr code|notification|account|sparky|my items|services|poplar hill|how do you want your items|grocery|household|fashion|beauty|pharmacy|electronics|auto|home\b|back\b|close\b|filter|sort by""",
            RegexOption.IGNORE_CASE,
        )
        private val FOOD_HINTS = Regex(
            """\b(milk|eggnog|egg nog|yogurt|cheese|butter|cream|creamer|sour cream|cottage cheese|eggs?|bread|bagel|buns|rolls|tortilla|muffin|chips|crackers|pretzels|popcorn|puffs|cereal|granola|oats|oatmeal|pancake|waffle|syrup|honey|jam|jelly|peanut butter|almond butter|nutella|ranch|dressing|sauce|marinara|salsa|ketchup|mustard|mayo|mayonnaise|oil|olive oil|avocado oil|vinegar|turkey|chicken|beef|steak|pork|bacon|sausage|ham|deli|salami|pepperoni|hot dog|salmon|tuna|shrimp|fish|juice|lemonade|soda|cola|pop|water|sparkling|energy|sports drink|gatorade|tea|coffee|espresso|cookie|cookies|brownie|cake|candy|chocolate|gummies|fruit|snacks|apple|banana|strawberry|blueberry|raspberry|berry|avocado|spinach|broccoli|kale|salad|lettuce|tomato|potato|onion|garlic|carrot|orange|grape|lemon|lime|beans|rice|pasta|noodles|soup|broth|pizza|burrito|nuggets|fries|waffles|ice cream|popsicle|organic|grass-fed|pasture|great value|marketside|sam's choice|bettergoods|kirkland|good & gather|favorite day|market pantry|simple truth|private selection|kroger|aldi|simply nature|millville|clancy's|chobani|yoplait|danon|stonyfield|horizon|fairlife|hood|lactaid|coffee-mate|kraft|sargento|tillamook|philadelphia|velveeta|heinz|hellmann|hidden valley|primal kitchen|doritos|cheetos|takis|lay's|ruffles|pringles|fritos|tostitos|siete|cheez-it|goldfish|ritz|wheat thins|triscuit|oreo|chips ahoy|cheerios|lucky charms|froot loops|cinnamon toast|frosted flakes|kellogg|general mills|post|quaker|nature's own|sara lee|wonder|dave's killer|canyon bakehouse|thomas'|applegate|boar's head|oscar mayer|hillshire|hormel|jimmy dean|tyson|perdue|foster farms|impossible|beyond|kerrygold|land o'lakes|country crock|blue bonnet|coca-cola|pepsi|dr pepper|mountain dew|sprite|red bull|monster|celsius|liquid death|olipop|poppi|la croix|whole|lowfat|nonfat|skim|vitamin d|gallon|half gallon|quart|pint|fl oz|oz|lb\b)""",
            RegexOption.IGNORE_CASE,
        )
        private val PRICE_PATTERN = Regex("""\$\d+\.\d{2}""")
    }

    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var currentPackage = ""
    private var lastKey = ""
    private var overlayVisible = false

    private val scanRunnable = Runnable { readAndScan() }
    private val foregroundCheck = object : Runnable {
        override fun run() {
            val pkg = rootInActiveWindow?.packageName?.toString()
            if (overlayVisible && (pkg == null || (pkg !in STORE_PACKAGES && pkg != packageName))) {
                sendToOverlay(OverlayWindowService.ACTION_HIDE)
                overlayVisible = false
                lastKey = ""
            }
            if (overlayVisible) handler.postDelayed(this, FOREGROUND_CHECK_MS)
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val pkg = event?.packageName?.toString() ?: return
        if (pkg !in STORE_PACKAGES) return
        currentPackage = pkg
        handler.removeCallbacks(scanRunnable)
        handler.postDelayed(scanRunnable, DEBOUNCE_MS)
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        io.shutdownNow()
        super.onDestroy()
    }

    /* ---------------- Screen reading ---------------- */

    private fun readAndScan() {
        val root = rootInActiveWindow ?: return
        val pkg = root.packageName?.toString() ?: return
        if (pkg !in STORE_PACKAGES) return

        val nodes = collectTextNodes(root)
        val priceCount = nodes.count { PRICE_PATTERN.containsMatchIn(it.text) }
        val plusAddCount = nodes.count {
            it.text.equals("+ Add", ignoreCase = true) || it.text.equals("Add", ignoreCase = true)
        }
        val ingredients = findIngredients(nodes)

        val hasHomeOrAisleBanners = nodes.any { HOME_OR_AISLE_BANNERS.containsMatchIn(it.text) }
        val hasSinglePdpCta = nodes.any { SINGLE_PDP_CTA.containsMatchIn(it.text) }
        val hasSinglePdpDetails = ingredients != null || nodes.any { SINGLE_PDP_DETAILS.containsMatchIn(it.text.trim()) }
        val hasExplicitPdpViewId = nodes.any { n -> TITLE_ID_HINTS.any { n.viewId.contains(it) } }

        // Only grade a single product when the user has opened an actual Product Detail Page (PDP).
        // When browsing the Home Screen, Category tabs, or Search Aisle grids, stay in Mode B (`🛒 Cart Avg`).
        val isSingleProductPage =
            (hasSinglePdpCta || hasSinglePdpDetails || hasExplicitPdpViewId) &&
                !hasHomeOrAisleBanners &&
                plusAddCount < 3 &&
                !(priceCount >= 5 && ingredients == null)

        val title = if (isSingleProductPage) findTitle(nodes) else null

        if (!isSingleProductPage || title == null) {
            val idleKey = "$pkg|IDLE_CART_AVG"
            if (lastKey != idleKey) {
                lastKey = idleKey
                sendToOverlay(OverlayWindowService.ACTION_IDLE_CART_AVG)
                markVisible()
            }
            return
        }

        val key = "$pkg|$title|${ingredients?.length ?: 0}"
        if (key == lastKey) return
        lastKey = key

        sendToOverlay(OverlayWindowService.ACTION_LOADING) { putExtra(OverlayWindowService.EXTRA_TITLE, title) }
        markVisible()
        val store = ScanApi.storeForPackage(pkg)
        io.execute {
            val json = try {
                ScanApi.scan(this, title, ingredients, store)
            } catch (e: Exception) {
                """{"ok":false,"error":"HeyBroc connection error (${e.javaClass.simpleName})"}"""
            }
            handler.post {
                sendToOverlay(OverlayWindowService.ACTION_SHOW_RESULT) { putExtra(OverlayWindowService.EXTRA_JSON, json) }
            }
        }
    }

    private data class TextNode(val text: String, val viewId: String, val isHeading: Boolean, val index: Int, val next: String?)

    private fun collectTextNodes(root: AccessibilityNodeInfo): List<TextNode> {
        val out = ArrayList<TextNode>()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var seen = 0
        while (queue.isNotEmpty() && seen < MAX_NODES) {
            val node = queue.removeFirst()
            seen++
            val t1 = node.text?.toString()?.trim().orEmpty()
            val t2 = node.contentDescription?.toString()?.trim().orEmpty()
            val viewId = node.viewIdResourceName?.lowercase().orEmpty()
            val heading = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && node.isHeading
            val sibling = siblingText(node)
            if (t1.isNotEmpty()) {
                out.add(TextNode(t1, viewId, heading, out.size, sibling))
            }
            if (t2.isNotEmpty() && t2 != t1) {
                out.add(TextNode(t2, viewId, heading, out.size, sibling))
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return out
    }

    private fun siblingText(node: AccessibilityNodeInfo): String? {
        val parent = node.parent ?: return null
        for (i in 0 until parent.childCount - 1) {
            if (parent.getChild(i) == node) {
                return parent.getChild(i + 1)?.text?.toString()?.trim()
            }
        }
        return null
    }

    private fun findTitle(nodes: List<TextNode>): String? {
        fun ok(t: String) =
            t.length in 6..180 &&
                !NOISE.containsMatchIn(t) &&
                !HOME_OR_AISLE_BANNERS.containsMatchIn(t) &&
                !PRICE_PATTERN.containsMatchIn(t)
        // 1. Explicit product title viewId on the product page
        nodes.firstOrNull { n -> ok(n.text) && TITLE_ID_HINTS.any { n.viewId.contains(it) } }?.let { return it.text }
        // 2. Accessibility heading on the page that matches food/product hints
        nodes.firstOrNull { it.isHeading && ok(it.text) && FOOD_HINTS.containsMatchIn(it.text) }?.let { return it.text }
        // 3. Any node on the page containing recognizable food/grocery keywords or brand/size
        nodes.firstOrNull { ok(it.text) && it.text.split(' ').size >= 2 && FOOD_HINTS.containsMatchIn(it.text) }?.let { return it.text }
        // 4. Accessibility heading on a confirmed single-product page
        nodes.firstOrNull { it.isHeading && ok(it.text) && it.text.split(' ').size >= 2 }?.let { return it.text }
        // 5. Fallback on a confirmed single-product page to the first descriptive product title
        return nodes.take(60).filter { ok(it.text) && it.text.length in 12..120 && it.text.split(' ').size >= 3 }
            .firstOrNull()?.text
    }

    private fun findIngredients(nodes: List<TextNode>): String? {
        for (n in nodes) {
            val t = n.text
            if (t.matches(Regex("""(?i)^ingredients\s*:?$"""))) {
                n.next?.takeIf { it.length > 12 }?.let { return it }
                nodes.getOrNull(n.index + 1)?.text?.takeIf { it.length > 12 }?.let { return it }
            }
            if (t.startsWith("Ingredients", ignoreCase = true) && t.length > 24) {
                return t.replaceFirst(Regex("""(?i)^ingredients\s*:?\s*"""), "")
            }
        }
        return null
    }

    /* ---------------- Overlay bridge ---------------- */

    private fun markVisible() {
        overlayVisible = true
        handler.removeCallbacks(foregroundCheck)
        handler.postDelayed(foregroundCheck, FOREGROUND_CHECK_MS)
    }

    private fun sendToOverlay(action: String, extras: Intent.() -> Unit = {}) {
        val intent = Intent(this, OverlayWindowService::class.java).setAction(action).apply(extras)
        try {
            startService(intent)
        } catch (_: IllegalStateException) {
            // Background-start restriction (shouldn't happen while bound as an accessibility service).
        }
    }
}
