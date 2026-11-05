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
 * to [OverlayWindowService]. Package filtering is enforced both in XML config and here.
 */
class GroceryScreenReaderService : AccessibilityService() {

    companion object {
        val STORE_PACKAGES = setOf("com.walmart.android", "com.instacart.client", "com.samsclub.app", "com.bjs.mobile")
        private const val DEBOUNCE_MS = 1200L
        private const val FOREGROUND_CHECK_MS = 2000L
        private const val MAX_NODES = 1500
        private val TITLE_ID_HINTS = listOf("product_title", "producttitle", "product_name", "productname", "item_name", "itemname", "item_title", "pdp_title", "title")
        private val NOISE = Regex("""^\$|^\d|add to cart|sign in|search|reviews?$|ratings?$|pickup|delivery|shipping|see all""", RegexOption.IGNORE_CASE)
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
        val title = findTitle(nodes) ?: return
        val ingredients = findIngredients(nodes)
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
                """{"ok":false,"error":"CleanCart API unreachable (${e.javaClass.simpleName}). Check the API URL in the app."}"""
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
            val text = (node.text ?: node.contentDescription)?.toString()?.trim().orEmpty()
            if (text.isNotEmpty()) {
                val heading = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && node.isHeading
                val sibling = siblingText(node)
                out.add(TextNode(text, node.viewIdResourceName?.lowercase().orEmpty(), heading, out.size, sibling))
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
        fun ok(t: String) = t.length in 8..200 && !NOISE.containsMatchIn(t)
        nodes.firstOrNull { n -> ok(n.text) && TITLE_ID_HINTS.any { n.viewId.contains(it) } }?.let { return it.text }
        nodes.firstOrNull { it.isHeading && ok(it.text) }?.let { return it.text }
        // Fallback: the longest plausible product-name text near the top of the screen.
        return nodes.take(40).filter { ok(it.text) && it.text.length >= 15 && it.text.split(' ').size >= 3 }
            .maxByOrNull { it.text.length }?.text
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
