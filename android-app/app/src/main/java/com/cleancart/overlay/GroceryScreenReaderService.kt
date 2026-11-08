package com.cleancart.overlay

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.ArrayDeque
import java.util.concurrent.Executors

/**
 * Reads ONLY the product title (and visible ingredient text, if on screen) from the 12
 * supported grocery apps, debounced by 750ms, then posts to /api/scan and hands the result
 * to [OverlayWindowService]. Automatically detects when the user navigates back to a
 * search / aisle scroll view and switches the corner bubble to Mode B (`🛒 Cart Avg`).
 */
class GroceryScreenReaderService : AccessibilityService() {

    companion object {
        @Volatile
        private var instance: GroceryScreenReaderService? = null

        /**
         * Attempts to search for [query] directly inside the active grocery app window
         * (used when a store app like ALDI does not register an external ACTION_VIEW search intent).
         */
        fun performInAppSearch(query: String, targetPkg: String = ""): Boolean {
            val svc = instance ?: return false
            return svc.runInAppSearch(query, targetPkg)
        }

        val STORE_PACKAGES = setOf(
            "com.walmart.android",
            "com.instacart.client",
            "com.target.ui",
            "com.kroger.mobile",
            "de.apptiv.business.android.aldi_us",
            "com.dd.doordash",
            "com.ubercab.eats",
            "com.amazon.mShop.android.shopping",
            "com.wholefoods.wholefoodsmarket",
            "com.rfi.sams.android",
            "com.samsclub.app",
            "com.brandingbrand.reactnative.and.bjs",
            "com.bjs.mobile",
            "com.costco.app.android",
            "com.shipt.groceries"
        )
        private val IGNORED_TRANSIENT_PACKAGES = setOf(
            "com.android.systemui",
            "com.google.android.inputmethod.latin",
            "com.samsung.android.honeyboard",
            "com.touchtype.swiftkey",
            "com.android.permissioncontroller",
            "com.google.android.permissioncontroller"
        )
        private const val DEBOUNCE_MS = 500L
        private const val MAX_DEBOUNCE_WAIT_MS = 1300L
        private const val FOREGROUND_CHECK_MS = 1500L
        private const val MAX_NODES = 1000
        private val TITLE_ID_HINTS = listOf(
            "pdp_title",
            "pdp_product_title",
            "product_detail_title",
            "item_detail_title",
            "product_title",
            "producttitle",
            "product_header_title",
            "product_name",
            "item_name"
        )
        private val HOME_OR_AISLE_BANNERS = Regex(
            """shop all food|rollbacks\s*&\s*more|your favorites,\s*for less|the holiday shop|use walmart\+?\s*gas savings|hosting,\s*decor\s*&\s*more|search results for|\b\d+\s+results?\b|featured categories|shop categories|trending in\b|shop by category|shop by department|weekly ad|reorder\b|buy again""",
            RegexOption.IGNORE_CASE,
        )
        private val CART_CHECKOUT_SIGNALS = Regex(
            """(\b(continue to checkout|proceed to checkout|go to checkout|checkout all items|review order|place order|estimated total|order summary|subtotal|your cart|shopping cart|skip the order min fee|available for all items|available for \d+ of \d+ items)\b|^[^a-z0-9]*checkout(\s+all\s+items|\s*\(\d+\))?$)""",
            RegexOption.IGNORE_CASE,
        )
        private val CART_ITEM_CONTROLS = Regex(
            """^(remove|save for later|select all)$""",
            RegexOption.IGNORE_CASE,
        )
        private val CART_END_BOUNDARY = Regex(
            """^(saved for later.*|recommended for you.*|customers also.*|similar items.*|frequently bought.*|people also bought.*|don't forget.*|items to add next.*)$""",
            RegexOption.IGNORE_CASE,
        )
        private val SINGLE_PDP_CTA = Regex(
            """\b(add to cart|add to bag|add to basket|add to order|add to box|add item|buy now|add \d+ to (cart|order|bag|basket)|add \(\$\d+(\.\d{2})?\)|choose options|select options|\d+\s+in\s+cart|added to cart)\b""",
            RegexOption.IGNORE_CASE,
        )
        private val IN_CART_PDP_BADGE = Regex(
            """\b(\d+\s+in\s+cart|added to cart)\b""",
            RegexOption.IGNORE_CASE,
        )
        private val SINGLE_PDP_DETAILS = Regex(
            """^(about this item|product details|product information|ingredients|nutrition facts|nutrition information|specifications|at a glance|product description|dietary\s*&\s*lifestyle|disclaimer|warnings|directions)$""",
            RegexOption.IGNORE_CASE,
        )
        private val CAROUSEL_BOUNDARY = Regex(
            """^(items to add next|similar items|customers also (bought|viewed|considered)|frequently bought together|you might also like|you may also like|sponsored products?|sponsored items?|related items|more from this brand|more to consider|compare with similar)$""",
            RegexOption.IGNORE_CASE,
        )
        private val BRAND_OR_UNIT_ONLY = Regex(
            """^(great value|freshness guaranteed|marketside|sam'?s choice|bettergoods|kirkland( signature)?|wellsley farms|berkley jensen|member'?s mark|good\s*&\s*gather|favorite day|market pantry|simple truth|private selection|simply nature|millville|clancy'?s|365( by whole foods market)?|chobani|yoplait|dannon|stonyfield|horizon|fairlife|hood|lactaid|coffee-mate|kraft|sargento|tillamook|philadelphia|velveeta|heinz|hellmann'?s|hidden valley|primal kitchen|kellogg'?s?|general mills|post|quaker|nature'?s own|sara lee|wonder|dave'?s killer( bread)?|canyon bakehouse|thomas'?|applegate|boar'?s head|oscar mayer|hillshire( farm)?|hormel|jimmy dean|tyson|perdue|foster farms|kerrygold|land o'?lakes|country crock|blue bonnet|dairypure|dairy pure|\d+(\.\d+)?\s*(fl\s*oz|oz|lb|lbs|ct|count|pack|gal|gallon|qt|pt|ml|g|kg|ea)|half gallon|dairy\s*&\s*eggs|bread\s*&\s*bakery|meat\s*&\s*seafood|fresh produce|snacks\s*&\s*candy|beverages|frozen foods?|pantry)$""",
            RegexOption.IGNORE_CASE,
        )
        private val NOISE = Regex(
            """^\$|^\d+(\.\d+)?\s*(ct|count|pack|oz|fl oz|lb|lbs|g|kg|ml|l|ea|reviews?|ratings?)\b|^\+?\s*add$|^([-(]?\d+(\.\d+)?[)]?|\d[\d,]*|\d+\s*/\s*\d+)$|^shop\s+[a-z0-9'&.\-\s]+$|^item\s*:?\s*#?\d+$|^(flavor|size|style|color|colour|scent|count|pack|pack\s+size|variant|option|type|model|pattern|weight|material)\s*:\s*.+$|^(cart\s*,?\s*\(\d+(\s+items?)?\)|in\s+\d+[km]?\+?\s*people'?s?\s*c(arts?|a.*)|\d+[km]?\+?\s*bought.*|options(\s+from.*)?|(get\s+\$?\d+(\.\d{2})?\s+)?walmart\s+cash.*|manufacturer\s+offer.*|subscribe\s+to\s+save.*|roll|rolls|mega\s+rolls?|double\s+rolls?|triple\s+rolls?)$|^((increase|decrease)\s+quantity.*|reserve a time.*|choose a time.*|hide details.*|show details.*|view details.*|don't forget.*|add to (cart|order|basket|bag|favorites|list)|remove from favorites|remove|save for later.*|saved for later.*|add item|buy now|choose options|select options|sign in|search.*|opens?\s+barcode\s+scanner.*|pickup.*|delivery.*|same-day delivery.*|shipping.*|in-club.*|coupons?|clipped|clip coupon.*|express.*|temporarily unavailable|not available.*|available|available for \d+ of \d+ items.*|ready in \d+.*|check nearby clubs|out of stock.*|in stock|many in stock|low in stock|ebt eligible|snap ebt.*|tomorrow.*|today.*|\d{1,2}(:\d{2})?\s*(am|pm)?\s*[-–—]\s*\d{1,2}(:\d{2})?\s*(am|pm).*|free with w\+.*|free with walmart\+.*|change|change\s+(delivery\s+|pickup\s+|shipping\s+)?address.*|see all|view all|sponsored|ad|advertisement|overall pick|best seller|popular pick|rollback|free shipping.*|free \d+-day returns.*|free holiday returns.*|arrives between .*|arrives by .*|sold by .*|fulfilled by .*|sold and shipped by .*|shipped by .*|pro seller|gift eligible.*|pickup and delivery options.*|fees may apply.*|spend \$?\d+.*|free same-day delivery.*|created with sketch.*|select all|product information|items to add next|shop now|learn more|terms apply|subscribe.*|share|similar items|frequently bought.*|customers also.*|you might also.*|nutrition facts|serving size.*|calories.*|about this item|product details|specifications|at a glance|how do you want your items.*|grocery|household|fashion|beauty|pharmacy|electronics|auto|home|shop|my items|sparky|services|account|back|close|filter|sort by|continue to checkout|proceed to checkout|checkout|checkout all items|estimated total|subtotal|order summary)$|\b(bought since yesterday|try a subscription|bought \d+ times|stay stocked|last purchased|gas savings|walmart\+|walmart cash|manufacturer offer|scan barcodes?|barcode scanner|opens barcode scanner|qr code|preferred address|change delivery address|change address|is this right|aisle\s+[a-z0-9]+|\d+\s*[-–—]\s*\d+\s*min|\d+\s*(hr|hour|min)s?\s+or\s+less|\d{1,2}(:\d{2})?\s*(am|pm)?\s*[-–—]\s*\d{1,2}(:\d{2})?\s*(am|pm)|free with w\+|free with walmart\+|\d+\s+[a-z0-9.\s]+\b(st|street|rd|road|dr|drive|ave|avenue|blvd|boulevard|ln|lane|ct|court|pl|place|cir|circle|way|pkwy|parkway|hwy|highway|ter|terrace|trl|trail))\b|,\s*was$|\?$""",
            RegexOption.IGNORE_CASE,
        )
        private val FOOD_HINTS = Regex(
            """\b(milk|lactaid|eggnog|egg nog|yogurt|cheese|velveeta|macaroni|mac|cheddar|mozzarella|parmesan|provolone|swiss|gouda|feta|ricotta|queso|butter|kerrygold|cream|creamer|sour cream|cottage cheese|eggs?|egg white|bread|bagel|bagels|buns|rolls|tortilla|tortillas|muffin|muffins|donut|donuts|doughnut|doughnuts|bismark|bismarks|pastry|pastries|danish|croissant|croissants|fritter|eclair|strudel|turnover|cupcake|cupcakes|pie|cobbler|chips|crisps|crispy|fried|crackers|wafers|pretzels|popcorn|puffs|cereal|granola|oats|oatmeal|pancake|pancakes|waffle|waffles|syrup|honey|jam|jelly|peanut butter|almond butter|nutella|ranch|dressing|sauce|gravy|alfredo|pesto|marinara|salsa|ketchup|mustard|mayo|mayonnaise|hummus|guacamole|olive oil|avocado oil|canola oil|vegetable oil|vinegar|turkey|chicken|beef|steak|ribeye|sirloin|pork|bacon|sausage|kielbasa|bratwurst|meatballs|patties|fillets|cutlets|strip|strips|ham|deli|salami|pepperoni|hot dog|jerky|salmon|tuna|shrimp|cod|tilapia|fish|juice|capri sun|pouches|lemonade|limeade|soda|cola|sparkling|sports drink|gatorade|tea|coffee|espresso|water|seltzer|kombucha|cookie|cookies|brownie|brownies|cake|cake roll|swiss roll|pumpkin|candy|peppermint|mint|mints|chocolate|gummies|fruit|snacks|apple|apples|banana|bananas|strawberry|strawberries|blueberry|blueberries|raspberry|raspberries|blackberry|blackberries|cranberry|cranberries|cherry|cherries|garcia|half-baked|half baked|ben & jerry|berry|berries|avocado|avocados|spinach|broccoli|kale|salad|lettuce|tomato|tomatoes|potato|potatoes|mashed|onion|onions|french'?s|garlic|carrot|carrots|cucumber|cucumbers|pepper|peppers|mushroom|mushrooms|parsley|cilantro|basil|rosemary|thyme|dill|sage|chives|oregano|ginger|celery|cabbage|cauliflower|zucchini|squash|asparagus|corn|peas|orange|oranges|grape|grapes|peach|peaches|mango|mangoes|lemon|lemons|lime|limes|melon|watermelon|pineapple|pear|pears|plum|plums|beans|lentils|chickpeas|rice|pasta|spaghetti|penne|shells|noodles|ramen|soup|broth|stock|bouillon|pizza|burrito|hot pocket|hot pockets|morningstar|just bare|nuggets|tenders|fries|ice cream|gelato|sorbet|popsicle|doritos|cheetos|takis|lay'?s|ruffles|pringles|fritos|tostitos|siete|cheez-it|goldfish|ritz|knoppers|storck|merci|kinder|ferrero|haribo|lindt|ghirardelli|wheat thins|triscuit|oreo|chips ahoy|cheerios|lucky charms|froot loops|cinnamon toast|frosted flakes|coca-cola|pepsi|dr pepper|mountain dew|sprite|red bull|monster|celsius|liquid death|olipop|poppi|la croix|spindrift|diaper|diapers|wipes|disinfecting|tide|gain|persil|downy|purex|detergent|laundry|dawn|palmolive|cascade|dish|clorox|lysol|bleach|cleaner|scott|charmin|bounty|angel soft|cottonelle|quilted northern|brawny|sparkle|kleenex|toilet paper|paper towels?|bath tissue|shampoo|conditioner|body wash|shower gel|lotion|moisturizer|sunscreen|deodorant|antiperspirant|toothpaste|mouthwash|soap|cleanser|serum|dove|pantene|olay|old spice|suave|cerave|cetaphil|neutrogena|aveeno|native|colgate|crest|sensodyne|listerine|degree|secret|vaseline|aquaphor|coppertone|huggies|pampers|vitamin|protein|collagen|purina|pedigree|friskies|blue buffalo|dog food|cat food|flour|sugar|salt|spice|seasoning|cocoa|baking|yeast|pickle|pickles|olive|olives|tofu|almond|almonds|cashew|cashews|walnut|walnuts|pecan|pecans|pistachio|pistachios|peanut|peanuts)\b""",
            RegexOption.IGNORE_CASE,
        )
        private val PRICE_PATTERN = Regex("""(\$\s*\d+(\.\d{2})?|\b\d+\s*dollars?\s*and\s*\d+\s*cents?\b)""", RegexOption.IGNORE_CASE)
        private val ADD_TILE_BUTTON = Regex("""^(\+?\s*add|quick add|add item|choose options|\+|increase quantity.*)$""", RegexOption.IGNORE_CASE)
        private val CLUB_ITEM_NUMBER = Regex("""^(item|model|sku)\s*:?\s*#?[a-z0-9\-]+(\s*[|•,/]\s*(item|model|sku)\s*:?\s*#?[a-z0-9\-]+)*$""", RegexOption.IGNORE_CASE)
        private val NON_INGREDIENT_TEXT = Regex(
            """\b(see (product )?packaging|refer to packaging|packaging for current|varies by location|select a store|nutrition facts|serving size|amount per serving|daily value|items to add next|product information|customers also|similar items|you might also|related items|sold by|fulfilled by)\b""",
            RegexOption.IGNORE_CASE,
        )
        private val WHITESPACE = Regex("""\s+""")
        private val SPONSORED_BADGE = Regex("""^(sponsored|ad|advertisement)$""", RegexOption.IGNORE_CASE)
    }

    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var currentPackage = ""
    private var lastKey = ""
    private var overlayVisible = false
    private var pendingSinceMs = 0L
    private var wasOnCartScreen = false
    private var pendingAddToCartClick = false
    private var nullPkgCount = 0

    private val scanRunnable = Runnable {
        pendingSinceMs = 0L
        readAndScan()
    }
    private val followUpScanRunnable = Runnable {
        if (lastKey.isEmpty() || lastKey.endsWith("|IDLE_CART_AVG") || lastKey.endsWith("|CART_EMPTY")) {
            readAndScan()
        }
    }
    private val foregroundCheck = object : Runnable {
        override fun run() {
            if (!AccessibilityConsent.granted(this@GroceryScreenReaderService) || !isDeviceInteractiveAndUnlocked()) {
                sendToOverlay(OverlayWindowService.ACTION_HIDE)
                overlayVisible = false
                lastKey = ""
                nullPkgCount = 0
                return
            }
            val root = rootInActiveWindow
            val pkg = root?.packageName?.toString()
            recycleNode(root)
            // Because accessibility_service_config.xml restricts packageNames to STORE_PACKAGES,
            // rootInActiveWindow returns null whenever the user leaves a store app for the Home Screen,
            // App Switcher, or Settings. After 2 consecutive null checks (~3s), hide the overlay and reset hidden state.
            if (pkg == null) {
                nullPkgCount++
                if (overlayVisible && nullPkgCount >= 2) {
                    sendToOverlay(OverlayWindowService.ACTION_HIDE)
                    overlayVisible = false
                    lastKey = ""
                    wasOnCartScreen = false
                    nullPkgCount = 0
                }
            } else {
                nullPkgCount = 0
                val isTransient = pkg in IGNORED_TRANSIENT_PACKAGES || pkg.contains("inputmethod") || pkg.contains("keyboard")
                if (overlayVisible && !isTransient && pkg !in STORE_PACKAGES && pkg != packageName) {
                    sendToOverlay(OverlayWindowService.ACTION_HIDE)
                    overlayVisible = false
                    lastKey = ""
                    wasOnCartScreen = false
                } else if (pkg in STORE_PACKAGES && (lastKey.isEmpty() || lastKey.endsWith("|IDLE_CART_AVG") || lastKey.endsWith("|CART_EMPTY"))) {
                    // Automatically re-check if a Product Detail Page finished loading asynchronously without firing an AccessibilityEvent
                    readAndScan()
                }
            }
            if (overlayVisible) handler.postDelayed(this, FOREGROUND_CHECK_MS)
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        // Always reset any dismissed state when the accessibility service connects or is toggled off/on in Settings.
        sendToOverlay(OverlayWindowService.ACTION_RESET_HIDDEN)
        lastKey = ""
        if (!AccessibilityConsent.granted(this)) {
            sendToOverlay(OverlayWindowService.ACTION_HIDE)
            overlayVisible = false
        } else {
            handler.postDelayed(scanRunnable, 250L)
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (!AccessibilityConsent.granted(this) || !isDeviceInteractiveAndUnlocked()) {
            if (overlayVisible) {
                sendToOverlay(OverlayWindowService.ACTION_HIDE)
                overlayVisible = false
                lastKey = ""
            }
            return
        }
        val pkg = event?.packageName?.toString() ?: return
        if (pkg !in STORE_PACKAGES) return
        nullPkgCount = 0
        if (pkg != currentPackage) {
            currentPackage = pkg
            lastKey = ""
            wasOnCartScreen = false
        }

        if (event.eventType == AccessibilityEvent.TYPE_VIEW_CLICKED) {
            val src = runCatching { event.source }.getOrNull()
            val clickedText = buildString {
                event.text?.forEach { append(it).append(' ') }
                event.contentDescription?.let { append(it).append(' ') }
                if (src != null) {
                    src.text?.let { append(it).append(' ') }
                    src.contentDescription?.let { append(it).append(' ') }
                    for (i in 0 until minOf(src.childCount, 4)) {
                        val ch = runCatching { src.getChild(i) }.getOrNull() ?: continue
                        ch.text?.let { append(it).append(' ') }
                        ch.contentDescription?.let { append(it).append(' ') }
                        recycleNode(ch)
                    }
                }
            }.trim()
            val srcViewId = src?.viewIdResourceName?.lowercase().orEmpty()
            recycleNode(src)
            val isRemoveOrCartEditClick =
                Regex("""(?i)\b(remove|delete|save for later|decrease quantity|undo)\b""").containsMatchIn(clickedText) ||
                    srcViewId.contains("remove") ||
                    srcViewId.contains("delete") ||
                    srcViewId.contains("stepper_minus") ||
                    srcViewId.contains("minus_button")
            if (isRemoveOrCartEditClick) {
                lastKey = ""
                pendingSinceMs = System.currentTimeMillis()
                handler.removeCallbacks(scanRunnable)
                // Give the store app ~950ms of zero accessibility IPC traffic to complete its Remove animation/network call
                handler.postDelayed(scanRunnable, 950L)
                return
            }
            val isAddClick =
                SINGLE_PDP_CTA.containsMatchIn(clickedText) ||
                    ADD_TILE_BUTTON.matches(clickedText) ||
                    srcViewId.contains("add_to_cart") ||
                    srcViewId.contains("addtocart") ||
                    srcViewId.contains("stepper_plus") ||
                    srcViewId.contains("plus_button")
            if (isAddClick) {
                pendingAddToCartClick = true
                lastKey = "" // Force re-evaluation so the clicked product is recorded in cart automatically
                pendingSinceMs = System.currentTimeMillis()
                handler.removeCallbacks(scanRunnable)
                handler.postDelayed(scanRunnable, 350L)
                return
            }
        }

        val now = System.currentTimeMillis()
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            pendingSinceMs = now
            handler.removeCallbacks(scanRunnable)
            handler.removeCallbacks(followUpScanRunnable)
            handler.postDelayed(scanRunnable, 240L)
            handler.postDelayed(followUpScanRunnable, 900L)
            return
        }
        if (pendingSinceMs == 0L) pendingSinceMs = now
        if (now - pendingSinceMs >= MAX_DEBOUNCE_WAIT_MS) {
            handler.removeCallbacks(scanRunnable)
            scanRunnable.run()
            return
        }
        handler.removeCallbacks(scanRunnable)
        handler.postDelayed(scanRunnable, DEBOUNCE_MS)
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        if (instance === this) instance = null
        sendToOverlay(OverlayWindowService.ACTION_HIDE)
        handler.removeCallbacksAndMessages(null)
        io.shutdownNow()
        super.onDestroy()
    }

    private fun runInAppSearch(query: String, targetPkg: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val activePkg = root.packageName?.toString().orEmpty()
        recycleNode(root)
        if (activePkg !in STORE_PACKAGES) return false
        if (targetPkg.isNotBlank() && activePkg != targetPkg) return false

        fun attemptSearchStep(step: Int) {
            val winRoot = rootInActiveWindow ?: return
            try {
                val qNodes = ArrayDeque<AccessibilityNodeInfo>()
                qNodes.add(winRoot)
                var editableNode: AccessibilityNodeInfo? = null
                var searchTriggerNode: AccessibilityNodeInfo? = null
                var visited = 0

                while (qNodes.isNotEmpty() && visited < 350) {
                    val n = qNodes.removeFirst()
                    visited++
                    val cls = n.className?.toString().orEmpty()
                    val txt = n.text?.toString().orEmpty()
                    val desc = n.contentDescription?.toString().orEmpty()
                    val vid = n.viewIdResourceName?.lowercase().orEmpty()

                    if (editableNode == null && (n.isEditable || cls.contains("EditText", ignoreCase = true))) {
                        editableNode = n
                        break
                    }
                    val looksLikeSearch =
                        vid.contains("search") ||
                            Regex("""(?i)\b(search|find products|search products)\b""").containsMatchIn("$txt $desc")
                    if (searchTriggerNode == null && looksLikeSearch) {
                        searchTriggerNode = n
                    }
                    for (i in 0 until n.childCount) {
                        n.getChild(i)?.let { qNodes.add(it) }
                    }
                }

                if (editableNode != null) {
                    editableNode.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
                    editableNode.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    val args = Bundle().apply {
                        putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, query)
                    }
                    editableNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        editableNode.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
                    }
                    return
                }

                if (searchTriggerNode != null && step < 2) {
                    var clickable: AccessibilityNodeInfo? = searchTriggerNode
                    while (clickable != null && !clickable.isClickable) {
                        clickable = clickable.parent
                    }
                    (clickable ?: searchTriggerNode).performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    handler.postDelayed({ attemptSearchStep(step + 1) }, 450L)
                    return
                }

                if (step == 0) {
                    // Dismiss product modal sheet (e.g., top-left X in ALDI) so the main search bar is exposed
                    performGlobalAction(GLOBAL_ACTION_BACK)
                    handler.postDelayed({ attemptSearchStep(1) }, 500L)
                }
            } finally {
                recycleNode(winRoot)
            }
        }

        handler.post { attemptSearchStep(0) }
        return true
    }

    private fun isDeviceInteractiveAndUnlocked(): Boolean {
        val power = getSystemService(PowerManager::class.java)
        val keyguard = getSystemService(KeyguardManager::class.java)
        val interactive = power?.isInteractive ?: true
        val locked = keyguard?.isKeyguardLocked ?: false
        return interactive && !locked
    }

    private fun recycleNode(node: AccessibilityNodeInfo?) {
        if (node == null) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            @Suppress("DEPRECATION")
            runCatching { node.recycle() }
        }
    }

    /* ---------------- Screen reading ---------------- */

    private fun readAndScan() {
        if (!AccessibilityConsent.granted(this) || !isDeviceInteractiveAndUnlocked()) return
        val root = rootInActiveWindow ?: return
        try {
            val pkg = root.packageName?.toString() ?: return
            if (pkg !in STORE_PACKAGES) return

            val rawNodes = collectTextNodes(root)
            val allNodes = stripSponsoredAdNodes(rawNodes)
            val visibleOnly = allNodes.filter { it.isVisible }
            val nodes = if (visibleOnly.size >= 3) {
                visibleOnly.mapIndexed { idx, n -> n.copy(index = idx) }
            } else {
                allNodes
            }
            // Slice off "Items to add next / Similar items / Customers also bought" bottom carousels BEFORE
            // extracting ingredients so a collapsed "Ingredients v" pill in ALDI never reads "Velveeta Original" from the carousel below!
            val carouselIdx = nodes.indexOfFirst { it.index >= 4 && CAROUSEL_BOUNDARY.containsMatchIn(it.text.trim()) }
            val primaryNodes = if (carouselIdx >= 4) nodes.subList(0, carouselIdx) else nodes
            val allCarouselIdx = allNodes.indexOfFirst { it.index >= 4 && CAROUSEL_BOUNDARY.containsMatchIn(it.text.trim()) }
            val primaryAllNodes = if (allCarouselIdx >= 4) allNodes.subList(0, allCarouselIdx) else allNodes

            val ingredients = findIngredients(primaryNodes) ?: findIngredients(primaryAllNodes)

            val tileAddCount = primaryNodes.count { ADD_TILE_BUTTON.matches(it.text.trim()) }
            val hasOptionsButtons = primaryNodes.any { it.text.trim().equals("options", ignoreCase = true) }

            val hasHomeOrAisleBanners = primaryNodes.take(35).any { HOME_OR_AISLE_BANNERS.containsMatchIn(it.text.trim()) }
            val hasSinglePdpCta = primaryNodes.any { SINGLE_PDP_CTA.containsMatchIn(it.text) }
            val hasSinglePdpDetails = ingredients != null || nodes.any { SINGLE_PDP_DETAILS.containsMatchIn(it.text.trim()) }
            val hasExplicitPdpViewId = primaryNodes.any { n -> TITLE_ID_HINTS.any { n.viewId.contains(it) } }
            val hasClubItemNumber = primaryNodes.any { CLUB_ITEM_NUMBER.matches(it.text.trim()) }

            val isConfirmedSinglePdp =
                hasExplicitPdpViewId ||
                    hasSinglePdpDetails ||
                    (hasClubItemNumber && tileAddCount < 3) ||
                    (hasSinglePdpCta && tileAddCount <= 1)

            // 1. Check if the user is viewing their actual Cart or Checkout screen (only when NOT on a confirmed Single Product Detail Page)
            val hasCartCheckoutSignal = nodes.any { CART_CHECKOUT_SIGNALS.containsMatchIn(it.text.trim()) }
            val hasCartItemControls = nodes.any { CART_ITEM_CONTROLS.matches(it.text.trim()) }
            val isCartScreen = !isConfirmedSinglePdp && hasCartCheckoutSignal && (hasCartItemControls || nodes.any {
                val t = it.text.trim()
                t.contains("continue to checkout", ignoreCase = true) ||
                    t.contains("proceed to checkout", ignoreCase = true) ||
                    t.contains("checkout all items", ignoreCase = true) ||
                    t.contains("estimated total", ignoreCase = true) ||
                    t.contains("subtotal", ignoreCase = true) ||
                    t.matches(Regex("""(?i)^[^a-z0-9]*checkout(\s*\(\d+\))?$""")) ||
                    t.contains("choose substitution", ignoreCase = true) ||
                    t.contains("skip the order min fee", ignoreCase = true) ||
                    t.contains("available for all items", ignoreCase = true) ||
                    t.matches(Regex("""(?i)^available for \d+ of \d+ items.*"""))
            })

            if (isCartScreen) {
                wasOnCartScreen = true
                val cartTitles = extractCartScreenTitles(nodes)
                val removedTitles = extractRemovedCartTitles(nodes)
                if (cartTitles.isNotEmpty() || removedTitles.isNotEmpty()) {
                    val cartKey = "$pkg|CART|${cartTitles.joinToString("|")}|REM:${removedTitles.joinToString("|")}"
                    if (lastKey != cartKey) {
                        lastKey = cartKey
                        markVisible()
                        val store = ScanApi.storeForPackage(pkg)
                        val appContext = applicationContext
                        val removedJson = org.json.JSONArray(removedTitles).toString()
                        io.execute {
                            val arr = org.json.JSONArray()
                            for (itemTitle in cartTitles) {
                                val json = runCatching { ScanApi.scan(appContext, itemTitle, null, store) }.getOrNull()
                                if (json != null) {
                                    arr.put(json)
                                }
                            }
                            handler.post {
                                if (overlayVisible && AccessibilityConsent.granted(this@GroceryScreenReaderService)) {
                                    sendToOverlay(OverlayWindowService.ACTION_SYNC_CART) {
                                        putExtra(OverlayWindowService.EXTRA_CART_ARRAY, arr.toString())
                                        putExtra(OverlayWindowService.EXTRA_REMOVED_TITLES, removedJson)
                                        putExtra(OverlayWindowService.EXTRA_REPLACE_CART, false)
                                    }
                                }
                            }
                        }
                    }
                } else {
                    val emptyCartKey = "$pkg|CART_EMPTY"
                    if (lastKey != emptyCartKey) {
                        lastKey = emptyCartKey
                        sendToOverlay(OverlayWindowService.ACTION_IDLE_CART_AVG)
                        markVisible()
                    }
                }
                return
            }
            wasOnCartScreen = false

            // 2. Grade the product on Product Detail Pages AND vertical product card feeds
            val isProductView =
                isConfirmedSinglePdp ||
                    (!hasHomeOrAisleBanners && (hasSinglePdpCta || hasOptionsButtons))

            val title = if (isProductView) findTitle(primaryNodes, isConfirmedSinglePdp) else null

            if (!isProductView || title == null) {
                // If the user added items to cart directly on a Search Results aisle (which renders "1 in cart - <Product>"),
                // sync those added items into Cart Check immediately even before they open the Cart screen.
                val aisleInCartRe = Regex("""(?i)^\d+\s+in\s+(?:cart|bag|basket|order)\s*[-–—:,]\s*(.+)$""")
                val aisleAddedTitles = nodes.mapNotNull { n ->
                    aisleInCartRe.find(n.text.trim())?.groupValues?.getOrNull(1)?.let { cleanTitleCandidate(it) }
                }.filter { isCandidateProductTitle(it) }.distinct()

                if (aisleAddedTitles.isNotEmpty()) {
                    val aisleCartKey = "$pkg|AISLE_CART|${aisleAddedTitles.joinToString("|")}"
                    if (lastKey != aisleCartKey) {
                        lastKey = aisleCartKey
                        markVisible()
                        val store = ScanApi.storeForPackage(pkg)
                        val appContext = applicationContext
                        io.execute {
                            val arr = org.json.JSONArray()
                            for (itemTitle in aisleAddedTitles) {
                                val json = runCatching { ScanApi.scan(appContext, itemTitle, null, store) }.getOrNull()
                                if (json != null) arr.put(json)
                            }
                            handler.post {
                                if (overlayVisible && AccessibilityConsent.granted(this@GroceryScreenReaderService)) {
                                    sendToOverlay(OverlayWindowService.ACTION_SYNC_CART) {
                                        putExtra(OverlayWindowService.EXTRA_CART_ARRAY, arr.toString())
                                        putExtra(OverlayWindowService.EXTRA_REPLACE_CART, false)
                                    }
                                }
                            }
                        }
                    }
                    return
                }

                val idleKey = "$pkg|IDLE_CART_AVG"
                if (lastKey != idleKey) {
                    lastKey = idleKey
                    sendToOverlay(OverlayWindowService.ACTION_IDLE_CART_AVG)
                    markVisible()
                }
                return
            }

            val inCartOnPdp = pendingAddToCartClick || primaryNodes.any { IN_CART_PDP_BADGE.containsMatchIn(it.text) }
            pendingAddToCartClick = false

            val key = "$pkg|$title|${ingredients?.hashCode() ?: 0}|$inCartOnPdp"
            if (key == lastKey) return
            lastKey = key

            sendToOverlay(OverlayWindowService.ACTION_LOADING) { putExtra(OverlayWindowService.EXTRA_TITLE, title) }
            markVisible()
            val store = ScanApi.storeForPackage(pkg)
            val appContext = applicationContext
            io.execute {
                val json = try {
                    ScanApi.scan(appContext, title, ingredients, store)
                } catch (e: Exception) {
                    """{"ok":false,"error":"HeyBroc connection error (${e.javaClass.simpleName})"}"""
                }
                handler.post {
                    if (overlayVisible && lastKey == key && AccessibilityConsent.granted(this@GroceryScreenReaderService)) {
                        sendToOverlay(OverlayWindowService.ACTION_SHOW_RESULT) {
                            putExtra(OverlayWindowService.EXTRA_JSON, json)
                            putExtra(OverlayWindowService.EXTRA_IN_CART, inCartOnPdp)
                        }
                    }
                }
            }
        } finally {
            recycleNode(root)
        }
    }

    private data class TextNode(
        val text: String,
        val viewId: String,
        val isHeading: Boolean,
        val isVisible: Boolean,
        val index: Int,
    )

    private fun collectTextNodes(root: AccessibilityNodeInfo): List<TextNode> {
        val out = ArrayList<TextNode>()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var seen = 0
        while (queue.isNotEmpty() && seen < MAX_NODES) {
            val node = queue.pollFirst() ?: break
            seen++
            try {
                if (node.isPassword) continue
                val viewId = node.viewIdResourceName?.lowercase().orEmpty()
                val isSearchInput = node.isEditable ||
                    viewId.contains("search_src_text") ||
                    viewId.contains("search_bar_text") ||
                    viewId.endsWith("search_box") ||
                    viewId.endsWith("search_edit_text")
                if (!isSearchInput) {
                    val t1 = node.text?.toString()?.replace(WHITESPACE, " ")?.trim().orEmpty()
                    val t2 = node.contentDescription?.toString()?.replace(WHITESPACE, " ")?.trim().orEmpty()
                    val heading = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && node.isHeading
                    val visible = node.isVisibleToUser
                    if (t1.isNotEmpty()) {
                        out.add(TextNode(t1, viewId, heading, visible, out.size))
                    }
                    if (t2.isNotEmpty() && t2 != t1) {
                        out.add(TextNode(t2, viewId, heading, visible, out.size))
                    }
                }
                for (i in 0 until node.childCount) {
                    node.getChild(i)?.let(queue::add)
                }
            } finally {
                if (node !== root) recycleNode(node)
            }
        }
        while (queue.isNotEmpty()) {
            val leftover = queue.pollFirst() ?: break
            if (leftover !== root) recycleNode(leftover)
        }
        return out
    }

    /**
     * Strips top Sponsored banner ad text (e.g., "Cheerios" / "Tasty Os made with care" / "Sponsored"
     * or "Dairy Pure" / "Sponsored" right below the search bar on Walmart PDPs) so banner ads are
     * never mistaken for the product being viewed.
     */
    private fun stripSponsoredAdNodes(nodes: List<TextNode>): List<TextNode> {
        val dropIndices = HashSet<Int>()
        for (i in nodes.indices) {
            val txt = nodes[i].text.trim()
            if (SPONSORED_BADGE.matches(txt) && i <= 20) {
                dropIndices.add(i)
                for (back in 1..3) {
                    val prevIdx = i - back
                    if (prevIdx < 0) break
                    val prev = nodes[prevIdx].text.trim()
                    if (prev.startsWith("Search", ignoreCase = true) || PRICE_PATTERN.matches(prev)) break
                    if (!SINGLE_PDP_CTA.containsMatchIn(prev)) {
                        dropIndices.add(prevIdx)
                    }
                }
            }
        }
        if (dropIndices.isEmpty()) return nodes
        val filtered = ArrayList<TextNode>(nodes.size)
        for (i in nodes.indices) {
            if (i !in dropIndices) {
                val n = nodes[i]
                filtered.add(n.copy(index = filtered.size))
            }
        }
        return filtered
    }

    private fun cleanTitleCandidate(raw: String): String {
        var s = raw.replace(WHITESPACE, " ").trim()
        // Never strip "Removed: <Product>" snackbar messages into valid titles — they are handled by extractRemovedCartTitles
        if (s.matches(Regex("""(?i)^(removed|moved to saved for later|saved for later)\s*:.*"""))) {
            return ""
        }
        // Strip leading/embedded favorite/badge/quantity prefixes from compound container contentDescriptions
        s = s.replace(Regex("""(?i)^.*?\b(remove from favorites|add to favorites)\s*[,•|\-]?\s*"""), "")
        s = s.replace(Regex("""(?i)^(remove|delete)\s+(?=[a-z0-9].*\s+[a-z0-9])"""), "")
        s = s.replace(Regex("""(?i)^\d+\s+in\s+(cart|bag|basket|order)\s*[-–—:,]?\s*"""), "")
        s = s.replace(Regex("""(?i)^(quantity|qty)\s*:?\s*\d+\s*[,:•|\-]?\s*"""), "")
        s = s.replace(
            Regex("""(?i)^((bought\s+\d+\s+times|\d+[km]?\+?\s*bought[^,•|\-]*|best seller|overall pick|popular pick|rollback|sponsored|save for later|subscribe to save|(current\s+price\s*|price\s*|now\s*)?\$\s*\d+(\.\d{2})?(\s*/\s*(ea|oz|fl oz|lb|ct))?|\d+(\.\d+)?\s*¢\s*/\s*(oz|fl oz|lb|ea|ct|\d+\s*ct))\s*[,•|\-]\s*)+(?=[a-zA-Z]{2,})"""),
            ""
        )
        // Strip trailing club item numbers, ratings, review counts, image carousel counters, EBT badges, and prices
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*\b(item|model|sku)\s*:?\s*#?\d+.*$"""), "")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*\bsnap\s+ebt.*$"""), "")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*(rated\s+)?\d+(\.\d+)?\s*out of\s*5(\s*stars?)?.*$"""), "")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*\d[\d,]*\s*(reviews?|ratings?).*$"""), "")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*(product\s+)?image\s+\d+\s+of\s+\d+.*$"""), "")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*(current\s+price\s*|price\s*|now\s*)?\$\s*\d+(\.\d{2})?.*$"""), "")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*\d+(\.\d+)?\s*¢\s*/\s*(oz|fl oz|lb|ea|ct|\d+\s*ct).*$"""), "")
        s = s.replace(Regex("""(?i)\s*[,•|\-]\s*(now|was|current\s+price|price)\s*$"""), "")
        return s.trim(' ', ',', '•', '|', '-')
    }

    private fun extractRemovedCartTitles(nodes: List<TextNode>): List<String> {
        val removedRe = Regex("""(?i)^(?:removed(?:\s+from\s+cart)?|moved\s+to\s+saved\s+for\s+later)\s*:\s*(.+)$""")
        val out = LinkedHashSet<String>()
        for (n in nodes) {
            val m = removedRe.find(n.text.trim()) ?: continue
            val rawName = m.groupValues.getOrNull(1)?.trim().orEmpty()
            val cleaned = cleanTitleCandidate(rawName)
            if (cleaned.length >= 4) {
                out.add(cleaned)
            }
        }
        return out.toList()
    }

    private fun isCandidateProductTitle(t: String): Boolean =
        t.length in 5..180 &&
            !NOISE.containsMatchIn(t) &&
            !HOME_OR_AISLE_BANNERS.containsMatchIn(t) &&
            !CART_CHECKOUT_SIGNALS.containsMatchIn(t) &&
            !SINGLE_PDP_DETAILS.matches(t.trim()) &&
            !CAROUSEL_BOUNDARY.matches(t.trim()) &&
            !BRAND_OR_UNIT_ONLY.matches(t.trim()) &&
            !PRICE_PATTERN.containsMatchIn(t)

    private fun findTitle(nodes: List<TextNode>, isConfirmedSinglePdp: Boolean = false): String? {
        // If a previous product card is 90% scrolled off the top of the screen, its trailing "Options" or
        // "Add to cart" button appears in the first few nodes with no product title above it. Skip past
        // that orphaned button so we always scan the top-most complete product card on screen.
        val orphanedTopCtaIdx = nodes.take(8).indexOfFirst {
            val t = it.text.trim()
            t.equals("options", ignoreCase = true) || t.equals("add to cart", ignoreCase = true)
        }
        val hasTitleBeforeOrphanCta = if (orphanedTopCtaIdx > 0) {
            nodes.subList(0, orphanedTopCtaIdx).any { n ->
                val c = cleanTitleCandidate(n.text)
                isCandidateProductTitle(c) && c.split(' ').size >= 2 && c.length >= 10
            }
        } else false
        val searchNodes = if (orphanedTopCtaIdx >= 0 && !hasTitleBeforeOrphanCta && orphanedTopCtaIdx + 1 < nodes.size) {
            nodes.subList(orphanedTopCtaIdx + 1, nodes.size)
        } else {
            nodes
        }

        // 1. Explicit product title viewId on the product page
        searchNodes.firstOrNull { n ->
            val c = cleanTitleCandidate(n.text)
            isCandidateProductTitle(c) && TITLE_ID_HINTS.any { n.viewId.contains(it) }
        }?.let { return cleanTitleCandidate(it.text) }

        // 2. Accessibility heading on the page that matches food/product hints (including 1-word produce like "Raspberries")
        searchNodes.firstOrNull { n ->
            val c = cleanTitleCandidate(n.text)
            n.isHeading && isCandidateProductTitle(c) && FOOD_HINTS.containsMatchIn(c)
        }?.let { return cleanTitleCandidate(it.text) }

        // 3. Accessibility heading on a confirmed single-product page
        searchNodes.firstOrNull { n ->
            val c = cleanTitleCandidate(n.text)
            n.isHeading && isCandidateProductTitle(c) && c.split(' ').size >= 2
        }?.let { return cleanTitleCandidate(it.text) }

        // 4. First multi-word node in top-to-bottom order containing recognizable grocery/household keywords
        searchNodes.take(85).firstOrNull { n ->
            val c = cleanTitleCandidate(n.text)
            isCandidateProductTitle(c) && c.split(' ').size >= 2 && FOOD_HINTS.containsMatchIn(c)
        }?.let { return cleanTitleCandidate(it.text) }

        // 5. Single-word produce/food title (e.g. "Raspberries", "Strawberries", "Bananas", "Avocados", "Parsley" in ALDI)
        searchNodes.take(65).firstOrNull { n ->
            val c = cleanTitleCandidate(n.text)
            isCandidateProductTitle(c) && FOOD_HINTS.containsMatchIn(c)
        }?.let { return cleanTitleCandidate(it.text) }

        // 6. Fallback to the first descriptive product title in top-to-bottom order
        val minWords = if (isConfirmedSinglePdp) 2 else 3
        val minLen = if (isConfirmedSinglePdp) 7 else 12
        return searchNodes.take(85).map { cleanTitleCandidate(it.text) }
            .firstOrNull { isCandidateProductTitle(it) && it.length in minLen..140 && it.split(' ').size >= minWords }
    }

    /**
     * Extracts the actual product titles listed in the user's Cart screen (e.g. Walmart, BJ's, ALDI Cart)
     * so `🛒 Cart Avg` and the Whole-Cart Health Check drawer match the real items in their cart.
     * Strictly requires recognizable grocery/household/personal-care keywords (`FOOD_HINTS`) or an explicit
     * product title viewId so Cart UI chrome (delivery addresses, barcode scanner button, Express/Today time slots)
     * is never mistaken for a cart item.
     */
    private fun extractCartScreenTitles(nodes: List<TextNode>, removedTitles: List<String> = emptyList()): List<String> {
        val endIdx = nodes.indexOfFirst { CART_END_BOUNDARY.matches(it.text.trim()) }
        val cartNodes = if (endIdx >= 2) nodes.subList(0, endIdx) else nodes
        val seen = LinkedHashSet<String>()
        for (n in cartNodes) {
            val c = cleanTitleCandidate(n.text)
            if (!isCandidateProductTitle(c)) continue
            if (removedTitles.any { rem -> c.equals(rem, ignoreCase = true) || c.contains(rem, ignoreCase = true) || rem.contains(c, ignoreCase = true) }) {
                continue
            }
            val words = c.split(' ').filter { it.isNotBlank() }
            val hasExplicitTitleViewId = TITLE_ID_HINTS.any { n.viewId.contains(it) }
            if ((words.size >= 1 && FOOD_HINTS.containsMatchIn(c)) || (hasExplicitTitleViewId && words.size >= 2)) {
                val normKey = c.lowercase()
                if (seen.none { it.lowercase() == normKey }) {
                    seen.add(c)
                }
            }
            if (seen.size >= 20) break
        }
        return seen.toList()
    }

    private fun findIngredients(nodes: List<TextNode>): String? {
        val realIngredientHint = Regex(
            """\b(water|milk|cream|sugar|salt|flour|wheat|corn|soy|oil|butter|egg|cheese|cocoa|chocolate|vanilla|syrup|starch|acid|lecithin|gum|flavor|natural|organic|vitamin|potassium|sodium|calcium|turkey|chicken|beef|pork|apple|berry|raspberry|strawberry|blueberry|cranberry|oat|rice|potato|tomato|onion|garlic|spice|vinegar|yeast|honey|almond|peanut|hazelnut|extract|culture|enzyme|nitrite|nitrate|celery|dextrose|maltodextrin|carrageenan|sorbate|benzoate)\b""",
            RegexOption.IGNORE_CASE
        )
        fun validIngredientList(raw: String): String? {
            val cleaned = raw.trim()
            if (cleaned.length < 12) return null
            if (NOISE.containsMatchIn(cleaned)) return null
            if (NON_INGREDIENT_TEXT.containsMatchIn(cleaned)) return null
            if (SINGLE_PDP_DETAILS.matches(cleaned)) return null
            if (CAROUSEL_BOUNDARY.containsMatchIn(cleaned)) return null
            if (HOME_OR_AISLE_BANNERS.containsMatchIn(cleaned)) return null
            if (PRICE_PATTERN.containsMatchIn(cleaned)) return null
            if (BRAND_OR_UNIT_ONLY.matches(cleaned)) return null
            // Require comma-separated ingredients (or explicit single-ingredient label like "100% ...", "Contains ...", "Pasteurized ...")
            // so product titles in carousels ("Velveeta Original") are never mistaken for an ingredient list!
            val hasComma = cleaned.contains(",") || cleaned.contains(";")
            val isSingleIngredientLabel = Regex("""(?i)\b(100%|ingredients?\s*:|contains\b|cultured\b|pasteurized\b|filtered\s+water|carbonated\s+water)\b""").containsMatchIn(cleaned)
            if (!hasComma && !isSingleIngredientLabel) return null
            if (!realIngredientHint.containsMatchIn(cleaned)) return null
            return cleaned
        }
        for ((idx, n) in nodes.withIndex()) {
            val t = n.text.trim()
            if (t.matches(Regex("""(?i)^ingredients\s*[v▼▾⌄+]?\s*:?$"""))) {
                for (offset in 1..2) {
                    val nextNode = nodes.getOrNull(idx + offset) ?: break
                    val candidate = nextNode.text.trim()
                    // If the "Ingredients" accordion is collapsed and followed by "Items to add next" or another section header, STOP immediately!
                    if (
                        CAROUSEL_BOUNDARY.containsMatchIn(candidate) ||
                        SINGLE_PDP_DETAILS.matches(candidate) ||
                        SINGLE_PDP_CTA.containsMatchIn(candidate) ||
                        PRICE_PATTERN.containsMatchIn(candidate)
                    ) {
                        break
                    }
                    validIngredientList(candidate)?.let { return it }
                }
            }
            if (t.startsWith("Ingredients", ignoreCase = true) && t.length > 24) {
                val stripped = t.replaceFirst(Regex("""(?i)^ingredients\s*:?\s*"""), "")
                validIngredientList(stripped)?.let { return it }
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
        val intent = Intent(this, OverlayWindowService::class.java).setAction(action).apply {
            if (currentPackage.isNotEmpty()) {
                putExtra(OverlayWindowService.EXTRA_STORE_PKG, currentPackage)
            }
            extras()
        }
        try {
            startService(intent)
        } catch (_: IllegalStateException) {
            // Background-start restriction (shouldn't happen while bound as an accessibility service).
        }
    }
}
