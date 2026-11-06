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
        private const val DEBOUNCE_MS = 900L
        private const val FOREGROUND_CHECK_MS = 1500L
        private const val MAX_NODES = 1800
        private val TITLE_ID_HINTS = listOf("product_title", "producttitle", "product_name", "productname", "item_name", "itemname", "item_title", "pdp_title", "title")
        private val NOISE = Regex(
            """^\$|^\d+\s*(ct|count|pack|oz|lb|reviews?|ratings?)|add to cart|sign in|search|reviews?$|ratings?$|pickup|delivery|shipping|see all|sponsored|bought \d|stay stocked|last purchased|try a subscription|overall pick|best seller|popular pick|rollback|free shipping|arrives by|out of stock|in stock|shop now|learn more|terms apply|holiday denim|levi strauss|subscribe|add to list|share|similar items|frequently bought|customers also|you might also|nutrition facts|serving size|calories""",
            RegexOption.IGNORE_CASE,
        )
        private val FOOD_HINTS = Regex(
            """\b(milk|yogurt|cheese|butter|cream|eggs?|bread|bagel|tortilla|chips|crackers|pretzels|popcorn|cereal|granola|oats|oatmeal|ranch|dressing|sauce|ketchup|mustard|mayo|mayonnaise|turkey|chicken|beef|bacon|sausage|ham|deli|salami|pepperoni|juice|soda|water|tea|coffee|cookie|cookies|brownie|cake|fruit|apple|banana|strawberry|berry|organic|great value|kirkland|good & gather|simple truth|kroger|aldi|chobani|stonyfield|horizon|fairlife|kraft|heinz|doritos|cheez-it|goldfish|oreo|cheerios|nature's own|dave's killer|siete|hidden valley|primal kitchen|applegate|boar's head|oscar mayer|kerrygold|land o'lakes| whole |lowfat|nonfat|skim|vitamin d|gallon|fl oz|oz\b)""",
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
        val title = findTitle(nodes)
        val ingredients = findIngredients(nodes)

        // Automatic detection: if the user navigated back to a search/aisle view (multiple price cards
        // and no ingredients block, or no product title), switch bubble to Mode B (`🛒 Cart Avg`).
        val isSearchAisleView = title == null || (priceCount >= 5 && ingredients == null)
        if (isSearchAisleView) {
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
                ScanApi.scan(this, title!!, ingredients, store)
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
        fun ok(t: String) = t.length in 6..180 && !NOISE.containsMatchIn(t) && !PRICE_PATTERN.containsMatchIn(t)
        // 1. Explicit title viewId anywhere on the product page
        nodes.firstOrNull { n -> ok(n.text) && TITLE_ID_HINTS.any { n.viewId.contains(it) } }?.let { return it.text }
        // 2. Accessibility heading anywhere on the page that matches food/product hints
        nodes.firstOrNull { it.isHeading && ok(it.text) && FOOD_HINTS.containsMatchIn(it.text) }?.let { return it.text }
        nodes.firstOrNull { it.isHeading && ok(it.text) }?.let { return it.text }
        // 3. Any node on the page containing recognizable food/grocery keywords or brand/size
        nodes.firstOrNull { ok(it.text) && it.text.split(' ').size >= 2 && FOOD_HINTS.containsMatchIn(it.text) }?.let { return it.text }
        // 4. Fallback to first descriptive multi-word text node
        return nodes.take(80).filter { ok(it.text) && it.text.length in 12..120 && it.text.split(' ').size >= 3 }
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
