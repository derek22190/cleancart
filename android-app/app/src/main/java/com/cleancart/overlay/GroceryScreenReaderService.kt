package com.cleancart.overlay

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.ArrayDeque
import java.util.concurrent.Executors
import kotlin.math.abs

/**
 * Reads ONLY the product title (and visible ingredient text, if on screen) from the 12
 * supported grocery apps, debounced by 180ms, then posts to /api/scan and hands the result
 * to [OverlayWindowService]. Automatically detects when the user navigates back to a
 * search / aisle scroll view and switches the corner bubble to Mode B (`🛒 Cart Avg`).
 */
class GroceryScreenReaderService : AccessibilityService() {

    companion object {
        @Volatile
        private var activeInstance: GroceryScreenReaderService? = null

        fun activeWindowManager(): WindowManager? {
            val svc = activeInstance ?: return null
            return runCatching { svc.getSystemService(WINDOW_SERVICE) as? WindowManager }.getOrNull()
        }

        fun requestInAppSearch(
            targetPkg: String,
            query: String,
            onFallbackNeeded: (() -> Unit)? = null
        ): Boolean {
            val svc = activeInstance ?: return false
            return svc.startInAppSearch(targetPkg, query, onFallbackNeeded)
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
        private const val DEBOUNCE_MS = 180L
        private const val MAX_DEBOUNCE_WAIT_MS = 480L
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
            """shop all food|rollbacks\s*&\s*more|your favorites,\s*for less|the holiday shop|use walmart\+?\s*gas savings|hosting,\s*decor\s*&\s*more|search results for|featured categories|shop categories|shop by category|shop by department|weekly ad|^your carts$|^personal cart$|^continue shopping$|^restaurants$""",
            RegexOption.IGNORE_CASE,
        )
        private val CART_CHECKOUT_SIGNALS = Regex(
            """(\b(continue to checkout|proceed to checkout|go to checkout|checkout all items|review order|place order|estimated total|order summary|item subtotal|subtotal|your cart|shopping cart|skip the order min|available for all items|available for \d+ of \d+ items|same-day delivery fees|pickup fee)\b|^[^a-z0-9]*checkout(\s+all\s+items|\s*\(\d+\))?$|^cart\s*\(\d+(\s+items?)?\)$|^(personal|family)\s+.*\bcart$)""",
            RegexOption.IGNORE_CASE,
        )
        private val CART_ITEM_CONTROLS = Regex(
            """^(remove|save for later|select all|replace with best match|edit instructions)$""",
            RegexOption.IGNORE_CASE,
        )
        private val CART_END_BOUNDARY = Regex(
            """^(saved for later.*|save for later\s*\(\d+.*|recommended for you.*|customers also.*|similar items.*|frequently bought.*|people also bought.*|don't forget.*|items to add next.*|complete your cart.*|based on items in your cart.*|\d+\s+items?\s+(are|is)\s+no\s+longer\s+available.*|these items have been removed from your cart.*)$""",
            RegexOption.IGNORE_CASE,
        )
        private val EMPTY_CART_SIGNALS = Regex(
            """(\byour\s+(?:[a-z]+\s+){0,2}(?:cart|bag|basket)\s+(?:is\s+)?(?:currently\s+)?empty\b|\btime\s+to\s+start\s+shopping\b|\blet'?s\s+get\s+shopping\b|\badd\s+items\s+to\s+(?:get\s+started|start\s+a\s+basket)\b|\bnothing\s+in\s+your\s+(?:cart|bag|basket)\b|\b(?:cart|subtotal)\s*\(\s*0(?:\s+items?)?\s*\)|\b0\s+items?\s+in\s+(?:your\s+)?(?:cart|bag|basket)\b)""",
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
            """^(about this item|product details|product information|ingredients|nutrition facts|nutrition information|specifications|at a glance|product description|description|highlights|features|label info|shipping\s*&\s*returns|dietary\s*&\s*lifestyle|disclaimer|warnings|directions|item instructions|from the manufacturer|see customer images and reviews|freshness guarantee|choose a store to see what'?s available|return or replace anytime|100% satisfaction guarantee|visit the store|view order|buy it again|hear the highlights.*|price history.*|share product.*|copy associates link.*|ways to buy.*|subscribe\s*&\s*save.*|purchased \d+\+?\s*times?.*|last purchased.*|amazon'?s choice.*|\d+[km]?\+?\s*bought in past (month|week).*)$|^visit the [a-z0-9'&.\-\s]{2,40} store$|^(flavor|flavor\s+name|size|style|color|colour|scent|count|pack|pack\s+size)\s*:\s*.+$""",
            RegexOption.IGNORE_CASE,
        )
        private val PDP_BODY_BOUNDARY = Regex(
            """^(description|product description|highlights|about this item|product details|product information|specifications|label info|nutrition facts|nutrition information|ingredients\s*[v▼▾⌄+]?\s*:?|from the manufacturer|directions|warnings|disclaimer|legal disclaimer|customer reviews|reviews|ratings\s*&\s*reviews|questions\s*&\s*answers|q\s*&\s*a|showing \d+[-–—]\d+ of [\d,]+ reviews|how do you want your items?\??|your usuals,\s*on your schedule|one-time purchase|shop confidently|4 stars and above|based on customer ratings.*)$""",
            RegexOption.IGNORE_CASE,
        )
        private val CAROUSEL_BOUNDARY = Regex(
            """^(items to add next|similar items?( to consider)?|customers also (bought|viewed|considered)|customers who (viewed|bought) this item also (viewed|bought)|what other items do customers buy after viewing this item\??|products related to this item|sponsored products related to this item|brands in this category( on amazon)?|4 stars and above|frequently bought together|often bought with|you might also like|you may also like|sponsored products?|sponsored items?|related items|more from this brand|more to consider|compare with similar( items?)?|recommended for you|items that pair well together|complete your cart|based on items in your cart)$""",
            RegexOption.IGNORE_CASE,
        )
        private val BRAND_OR_UNIT_ONLY = Regex(
            """^(unbranded|cheerios|panera( bread)?|blount( clam shack)?|campbell'?s|progresso|amy'?s|pacific foods|rao'?s|barilla|martin'?s|gorton'?s|arih|inglehoffer|kikkoman|beaver( brand)?|wicked cutz|koops'?|terrapin ridge( farms)?|s&b|wasabi-o|great value|freshness guaranteed|marketside|sam'?s choice|bettergoods|kirkland( signature)?|wellsley farms|berkley jensen|member'?s mark|good\s*&\s*gather|favorite day|market pantry|simple truth|private selection|simply nature|millville|clancy'?s|365( by whole foods market)?|amazon grocery|happy belly|wickedly prime|chobani|yoplait|dannon|stonyfield|horizon|fairlife|hood|lactaid|coffee-mate|kraft|sargento|tillamook|philadelphia|velveeta|heinz|hellmann'?s|hidden valley|primal kitchen|kellogg'?s?|general mills|post|quaker|nature'?s own|sara lee|wonder|dave'?s killer( bread)?|canyon bakehouse|thomas'?|applegate|boar'?s head|oscar mayer|hillshire( farm)?|hormel|jimmy dean|tyson|perdue|foster farms|kerrygold|land o'?lakes|country crock|blue bonnet|dairypure|dairy pure|birds eye|green giant|mccormick|pompeian|de cecco|ball park|oreo|doritos|cheetos|lay'?s|ruffles|pringles|fritos|tostitos|cheez-it|goldfish|ritz|triscuit|wheat thins|keebler|maple syrup|pancake syrup|specialty syrup|\d+(\.\d+)?\s*(fl\s*oz|oz|lb|lbs|ct|count|pack|gal|gallon|qt|pt|ml|g|kg|ea|dozen)|half gallon|dairy\s*&\s*eggs|bread\s*&\s*bakery|meat\s*&\s*seafood|fresh produce|snacks\s*&\s*candy|beverages|frozen foods?|pantry)$""",
            RegexOption.IGNORE_CASE,
        )
        private val SINGLE_WORD_PRODUCE = Regex(
            """^(banana|bananas|apple|apples|strawberry|strawberries|blueberry|blueberries|raspberry|raspberries|blackberry|blackberries|avocado|avocados|broccoli|spinach|kale|lettuce|romaine|arugula|carrot|carrots|tomato|tomatoes|potato|potatoes|yam|yams|onion|onions|garlic|ginger|parsley|cilantro|basil|celery|cucumber|cucumbers|zucchini|asparagus|mushrooms|orange|oranges|lemon|lemons|lime|limes|grape|grapes|peach|peaches|watermelon|cantaloupe|pineapple|mango|mangoes|pear|pears|plum|plums|kiwi|cabbage|cauliflower)$""",
            RegexOption.IGNORE_CASE,
        )
        private val PROSE_OR_BULLET_NOISE = Regex(
            """\b(is easily|are easily|was bought|we bought|we carry|for your everyday|for your buck|great bang|lock in flavor|contains \d+ (bag|box|pack|can|bottle|jar)s? of|if out of stock|replace with best match|edit instructions|this item is not available in your area|\d+\s+items?\s+(?:are|is)\s+no\s+longer\s+available|these items have been removed from your cart|complete your cart|based on items in your cart|yes,\s*i want \$0 delivery fee|start saving with instacart\+|service fees apply|add \$?\d+(\.\d{2})? of eligible items|buy \$\d+,\s*get \$\d+ off|shopping in \d+|usual items in stock|in stock at|out of stock at|buy in warehouse|join prime to save|prime member price|amazon fresh is not available|choose a store to see|verified purchase|helpful|report abuse|showing \d+[-–—]\d+ of [\d,]+|tasty os|made with care|(excellent|good|high|rich|great)\s+source\s+of|made in america|european quality|fresh-grated horseradish for|for prime rib|hear the highlights|copy associates link|ways to buy|price history|share product|amazon'?s choice|bought in past (month|week)|purchased \d+\+?\s*times?|thanksgiving\s+meal|feast\s+for\s+\d+|classic\s+sides|meals?\s+made\s+easy|get\s+it\s+fast|household\s+essentials|grocery\s+list\s+staples|weekly\s+essentials|under\s+\$?\d+\s+per\s+person|shop\s+the\s+list|free\s+turkey|turkey\s+earned|clip\s+coupon|congratulations|pickup\s+benefit|benefit\s+has\s+been\s+applied|same-day\s+select|more\s+deliveries\s+for\s+less|unlimited\s+delivery|eligible\s+order|pay\s+once\s+for\s+a\s+year|groceries\s+delivered|lower\s+your\s+delivery\s+fees|select\s+package|topcare|pain\s*&\s*fever|oral\s+suspension|acetaminophen|ibuprofen|boost\s+by\s+kroger|sign\s+in\s+to\s+clip|optup\s+score|located\s+in\s+aisle|choose\s+backup|backup\s+item|special\s+requests?|add\s+a\s+special\s+request|dashpass|dashmart|substitution\s+preferences|doubledash|nearby\s+stores\s+are\s+a\s+tap\s+away|shop\s+neighborhood\s+favorites|national\s+retailers|shoppers\s+who\s+know\s+their\s+stuff|looking\s+for\s+something\s+special|continue\s+as\s+guest)\b|&\s*more\.?$|!$""",
            RegexOption.IGNORE_CASE,
        )
        private val STORE_ONBOARDING_OR_AUTH_GATE = Regex(
            """\b(nearby stores are a tap away|shop neighborhood favorites|national retailers|shoppers who know their stuff|looking for something special|continue as guest|sign in to your account|create an account|welcome to shipt|welcome to kroger|welcome to doordash|welcome to instacart|welcome to walmart|welcome to target|welcome to aldi|welcome to costco|welcome to sam'?s club|welcome to bj'?s|health data privacy|your privacy choices)\b""",
            RegexOption.IGNORE_CASE,
        )
        private val AUTH_BUTTON_SIGNAL = Regex(
            """^(log\s*in|sign\s*in|sign\s*up|create\s+account|get\s+started|continue\s+as\s+guest)$""",
            RegexOption.IGNORE_CASE,
        )
        private val CHAT_OR_MESSAGE_NOISE = Regex(
            """\b(please\b|can you\b|could you\b|would you\b|thank you\b|thanks\b|shopper\b|driver\b|dasher\b|courier\b|instead of\b|if they don'?t have|let me know|text me\b|call me\b|message me\b|front door|back door|gate code|buzzer|ring the bell|leave at\b|leave by\b|hand it to me|i want\b|i need\b|i prefer\b|don'?t get\b|do not get\b|make sure\b|grab me\b|get me\b|pick up some\b|sent a message|type a message|chat with|message your)\b|[?!]""",
            RegexOption.IGNORE_CASE,
        )
        private val PROTECTED_CONTAINER_RESOURCE_ID = Regex(
            """(search_src_text|search_bar_text|search_box|search_edit|search_input|password|passcode|pin_entry|card_number|credit_card|debit_card|cvv|cvc|expiry|billing|payment|wallet|ssn|tax_id|chat|message|messenger|conversation|inbox|support|help_center|compose|comment|review_text|review_body|delivery_instructions|driver_note|shopper_note|instructions_input|address_input|phone_number|email_input)""",
            RegexOption.IGNORE_CASE,
        )
        private val PROTECTED_VIEW_ID_PATTERN = PROTECTED_CONTAINER_RESOURCE_ID
        private val SENSITIVE_PII_PATTERN = Regex(
            """(\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b|\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b|\b\d{3}-\d{2}-\d{4}\b|\b(?:\d[ -]*?){13,19}\b|\b(?:visa|mastercard|amex|american express|discover)\s+(?:ending\s+in|card)\s+\d{4}\b|\b(?:cvv|cvc|security\s+code|routing\s+number|account\s+number|passcode|one-time\s+code|verification\s+code)\b)""",
            RegexOption.IGNORE_CASE,
        )
        private fun isProtectedViewId(viewId: String): Boolean =
            viewId.isNotEmpty() && PROTECTED_CONTAINER_RESOURCE_ID.containsMatchIn(viewId)

        private fun isProtectedNode(node: AccessibilityNodeInfo?): Boolean {
            if (node == null) return false
            if (node.isPassword || node.isEditable) return true
            val viewId = node.viewIdResourceName?.lowercase().orEmpty()
            if (isProtectedViewId(viewId)) return true
            val cls = node.className?.toString()?.lowercase().orEmpty()
            if (cls.contains("edittext") || cls.contains("autocompletetextview")) return true
            return false
        }

        private fun isSensitiveCandidate(raw: String): Boolean {
            val t = raw.trim()
            if (t.isEmpty()) return false
            return CHAT_OR_MESSAGE_NOISE.containsMatchIn(t) ||
                STORE_ONBOARDING_OR_AUTH_GATE.containsMatchIn(t) ||
                AUTH_BUTTON_SIGNAL.matches(t) ||
                SENSITIVE_PII_PATTERN.containsMatchIn(t)
        }
        private val NOISE = Regex(
            """^\$|^\d+(\.\d+)?\s*(ct|count|pack|oz|fl oz|lb|lbs|g|kg|ml|l|ea|gal|gallon|qt|pt|reviews?|ratings?)(\s*/\s*(ea|oz|fl oz|lb|ct))?$|^([-(]?\d+(\.\d+)?[)]?\s*(reviews?|ratings?))$|^\+?\s*add$|^([-(]?\d+(\.\d+)?[)]?|\d[\d,]*|\d+\s*/\s*\d+)$|^shop\s+[a-z0-9'&.\-\s]+$|^visit the store$|^visit the [a-z0-9'&.\-\s]+ store$|^item\s*:?\s*#?\d+$|^(flavor|flavor\s+name|size|style|color|colour|scent|count|pack|pack\s+size|variant|option|type|model|pattern|weight|material)\s*:\s*.+$|^(cart\s*,?\s*\(\d+(\s+items?)?\)|in\s+\d+[km]?\+?\s*people'?s?\s*c(arts?|a.*)|\d+[km]?\+?\s*bought.*|options(\s+from.*)?|(get\s+\$?\d+(\.\d{2})?\s+)?walmart\s+cash.*|manufacturer\s+offer.*|subscribe\s+to\s+save.*|one-time\s+purchase.*|recommended\s+for\s+you.*|items\s+that\s+pair\s+well\s+together.*|complete\s+your\s+cart.*|based\s+on\s+items\s+in\s+your\s+cart.*|trending\s+in\s+.*|\d+\s+stars?\s+and\s+above.*|based\s+on\s+customer\s+ratings.*|roll|rolls|mega\s+rolls?|double\s+rolls?|triple\s+rolls?)$|^((increase|decrease)\s+quantity.*|reserve a time.*|choose a time.*|hide details.*|show details.*|view details.*|view order|buy it again|hear the highlights.*|price history.*|share product.*|copy associates link.*|ways to buy.*|amazon'?s choice.*|don't forget.*|add to (cart|order|basket|bag|favorites|list)|remove from favorites|remove|save for later.*|saved for later.*|add item|buy now|choose options|select options|select (size|flavor|weight|count).*|sign in|log in|sign up|continue as guest|get started|search.*|opens?\s+barcode\s+scanner.*|pickup.*|curbside pickup.*|delivery.*|same-day delivery.*|shipping.*|in-club.*|coupons?|double coupons!|clipped|clip coupon.*|sign in to clip.*|boost by kroger.*|choose backup.*|backup item.*|special requests?.*|add a special request.*|dashpass.*|substitution preferences.*|doubledash.*|express.*|temporarily unavailable|not available.*|this item is not available.*|\d+\s+items?\s+(are|is)\s+no\s+longer\s+available.*|these items have been removed.*|available|available deals.*|available for \d+ of \d+ items.*|ready in \d+.*|ready by .*|check nearby clubs|out of stock.*|in stock.*|many in stock|likely in stock|low in stock|only \d+ left.*|ebt eligible|snap ebt.*|tomorrow.*|today.*|\d{1,2}(:\d{2})?\s*(am|pm)?\s*[-–—]\s*\d{1,2}(:\d{2})?\s*(am|pm).*|free with w\+.*|free with walmart\+.*|free with your membership.*|free delivery as soon as.*|always free.*|return or replace.*|change|change\s+(delivery\s+|pickup\s+|shipping\s+)?address.*|choose another address.*|deliver to.*|see all|view all|sponsored|ad|advertisement|overall pick|best seller|popular pick|rollback|free shipping.*|free \d+-day returns.*|free holiday returns.*|free returns at pickup.*|100% satisfaction guarantee.*|freshness guarantee(?!d\b).*|reduced carbon impact.*|see customer images.*|from the manufacturer.*|item instructions.*|edit instructions.*|add note for shopper.*|arrives between .*|arrives by .*|sold by .*|fulfilled by .*|sold and shipped by .*|shipped by .*|report an issue with seller.*|shop confidently|your usuals,\s*on your schedule.*|save time and stay stocked.*|how it works|pro seller|gift eligible.*|pickup and delivery options.*|fees may apply.*|service fees apply.*|spend \$?\d+.*|free same-day delivery.*|created with sketch.*|select all|product information|items to add next|shop now|learn more|terms apply|subscribe.*|share|similar items.*|frequently bought.*|often bought with.*|customers also.*|you might also.*|nutrition facts|serving size.*|calories.*|about this item|product details|specifications|at a glance|description|highlights|features|label info|how do you want your items?.*|max\s+\d+\s+per\s+order.*|final\s+cost\s+by\s+weight.*|avg\s+price.*|instant\s+savings.*|ends\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d+.*|really\s+philly\s+good.*|.*\bsam'?s\s+club|your carts|personal cart|continue shopping|restaurants|grocery|household|fashion|beauty|pharmacy|electronics|auto|home|shop|my items|sparky|services|account|back|close|filter|sort by|reorder|buy again|continue to checkout|proceed to checkout|go to checkout|checkout|checkout all items|estimated total|item subtotal|subtotal|order summary)$|©\s*\d{4}\b|\b(bought since yesterday|try a subscription|bought \d+\+?\s*times?|purchased \d+\+?\s*times?|stay stocked|stay stocked and subscribe|last purchased|usual items in stock|replace with best match|edit instructions|add note for shopper|item may be available in your local warehouse|price may vary|max \d+ per order|final cost by weight|buy in warehouse|join prime|statement credit|amazon fresh is not available|choose a store to see|straight talk|google pixel|pixel \d+a?|iphone \d+|samsung galaxy|tracfone|boost mobile|cricket wireless|total wireless|wireless plan|prepaid phone|onepay|welcome bonus|credit card|report an issue with seller|your usuals,\s*on your schedule|save time and stay stocked|gas savings|walmart\+|walmart cash|manufacturer offer|scan barcodes?|barcode scanner|opens barcode scanner|qr code|preferred address|change delivery address|change address|is this right|aisle\s+[a-z0-9]+|located\s+in\s+aisle\s+[a-z0-9]+|thanksgiving\s+meal|feast\s+for\s+\d+|classic\s+sides|meals?\s+made\s+easy|get\s+it\s+fast|household\s+essentials|grocery\s+list\s+staples|weekly\s+essentials|under\s+\$?\d+\s+per\s+person|shop\s+the\s+list|free\s+turkey|turkey\s+earned|pickup\s+benefit|same-day\s+select|more\s+deliveries\s+for\s+less|unlimited\s+delivery|\d+\s*[-–—]\s*\d+\s*min|\d+\s*(hr|hour|min)s?\s+or\s+less|\d{1,2}(:\d{2})?\s*(am|pm)?\s*[-–—]\s*\d{1,2}(:\d{2})?\s*(am|pm)|free with w\+|free with walmart\+)\b|&\s*more\.?$|^\d+\s+[a-z]{2,}(?:\s+[a-z]{2,}){0,2}\s+(street|rd|road|drive|ave|avenue|blvd|boulevard|lane|court|place|circle|pkwy|parkway|hwy|highway|terrace|trail)\b|,\s*was$|[!?]$""",
            RegexOption.IGNORE_CASE,
        )
        private val FOOD_HINTS = Regex(
            """\b(milk|lactaid|fairlife|oatly|malk|califia|silk|soymilk|almondmilk|oatmilk|eggnog|egg nog|yogurt|kefir|cheese|velveeta|macaroni|mac|cheddar|mozzarella|parmesan|provolone|swiss|gouda|feta|ricotta|queso|butter|kerrygold|cream|creamer|sour cream|cottage cheese|eggs?|egg white|bread|bagel|bagels|buns|dinner rolls?|cinnamon rolls?|sweet rolls?|crescent rolls?|hawaiian rolls?|sausage rolls?|pizza rolls?|egg rolls?|bread rolls?|kaiser rolls?|sub rolls?|hoagie rolls?|sandwich rolls?|potato rolls?|tortilla|tortillas|muffin|muffins|donut|donuts|doughnut|doughnuts|bismark|bismarks|pastry|pastries|toaster| glazed|powdered|my cookie dealer|danish|croissant|croissants|fritter|eclair|strudel|turnover|cupcake|cupcakes|pie|cobbler|chips|crisps|crispy|fried|crackers|crunchmaster|mary'?s gone|wafers|pretzels|popcorn|puffs|cereal|granola|oats|oatmeal|pancake|pancakes|waffle|waffles|french toast|breakfast|syrup|honey|jam|jelly|preserves|marmalade|peanut butter|almond butter|sunflower butter|nutella|ranch|dressing|sauce|gravy|alfredo|pesto|marinara|salsa|ketchup|mustard|mayo|mayonnaise|aioli|relish|tartar|horseradish|wasabi|inglehoffer|kikkoman|beaver|wicked cutz|koops|tamari|sriracha|hoisin|teriyaki|ponzu|kimchi|miso|gochujang|harissa|chimichurri|remoulade|chutney|hummus|guacamole|tzatziki|dip|olive oil|avocado oil|canola oil|vegetable oil|coconut oil|sesame oil|pompeian|bertolli|vinegar|turkey|butterball|jennie-?o|chicken|rotisserie|poultry|beef|angus|usda choice|usda prime|steak|ribeye|sirloin|new york strip|strip steak|roast|chuck|tenderloin|brisket|pork|bacon|crumbled bacon|bac'?n|mccormick|sausage|kielbasa|bratwurst|chorizo|meatballs|meatloaf|patties|patty|fillets?|cutlets?|chicken strips?|beef strips?|ham|smithfield|boneless|hickory|smoked|cured|uncured|prosciutto|pancetta|deli|salami|pepperoni|bologna|pastrami|corned beef|hot dogs?|franks?|frankfurters?|wieners?|ball park|nathan'?s|hebrew national|jerky|salmon|tuna|shrimp|scallops|crab|lobster|cod|tilapia|halibut|mahimahi|trout|sardines|anchovies|fish|seafood|juice|tropicana|simply|minute maid|mott'?s|welch'?s|ocean spray|v8|naked|bolthouse|suja|sunnyd|sunny delight|capri sun|kool-aid|hi-c|hawaiian punch|pouches|lemonade|limeade|smoothie|cider|nectar|soda|cola|soda pop|ice pop|pop[- ]?tarts?|root beer|ginger ale|cream soda|sparkling|sports drink|electrolyte|electrolytes|gatorade|powerade|bodyarmor|liquid i\.?v\.?|pedialyte|electrolit|biolyte|nuun|lmnt|nooma|propel|vitaminwater|tea|matcha|chai|yerba mate|guayaki|coffee|cold brew|frappuccino|latte|mocha|nitro|espresso|starbucks|stok|la colombe|chameleon|dunkin|arizona|pure leaf|gold peak|snapple|lipton|brisk|sweet leaf|ito en|honest tea|gt'?s|health-ade|kevita|water|seltzer|club soda|tonic|fiji|evian|essentia|smartwater|life wtr|dasani|aquafina|pure life|ozarka|poland spring|deer park|zephyrhills|ice mountain|arrowhead|crystal geyser|voss|proud source|mountain valley|san pellegrino|pellegrino|perrier|topo chico|gerolsteiner|waterloo|bubly|polar|aha|zuberfizz|nixie|sparkling ice|clear american|kombucha|energy drink|pre-?workout|monster|red bull|redbull|celsius|alani|ghost|c4|cellucor|bang energy|reign|rockstar|prime hydration|prime energy|5-hour|zoa|xyience|nos|full throttle|venom|accelerator|uptime|bum energy|ryse|gorilla mode|bucked up|total war|lit energy|optimum nutrition|amino energy|gold standard|six star|prosupps|hyde|jym|transparent labs|legion|ora organic|core power|premier protein|muscle milk|orgain|owyn|fairlife nutrition|ensure|boost original|boost high protein|boost nutritional|carnations|nesquik|truemoo|yoohoo|cookie|cookies|brownie|brownies|cake|carvel|cake roll|swiss roll|pumpkin|candy|peppermint|mint|mints|chocolate|truffles?|gummies|gummy|licorice|taffy|caramel|toffee|fudge|marshmallow|marshmallows|fruit|snacks|apple|apples|honeycrisp|gala|fuji|granny smith|pink lady|mcintosh|banana|bananas|strawberry|strawberries|blueberry|blueberries|raspberry|raspberries|blackberry|blackberries|cranberry|cranberries|cherry|cherries|garcia|cherry garcia|half-baked|half baked|chunky monkey|phish food|americone|tonight dough|ben\s*&\s*jerry'?s?|talenti|haagen|breyers|blue bell|halo top|yasso|klondike|drumstick|outshine|sundae|berry|berries|avocado|avocados|spinach|broccoli|florets?|kale|salad|lettuce|romaine|arugula|tomato|tomatoes|potato|potatoes|sweet potato|sweet potatoes|russet|yukon gold|yam|yams|mashed|idahoan|ore-ida|tater|tots|hash\s*browns?|onion|onions|french'?s|garlic|carrot|carrots|cucumber|cucumbers|pepper|peppers|mushroom|mushrooms|parsley|cilantro|basil|rosemary|thyme|dill|sage|chives|oregano|ginger|celery|cabbage|cauliflower|zucchini|squash|asparagus|artichokes?|beet|beets|radish|turnip|eggplant|okra|corn|peas|edamame|green beans|brussels|vegetables?|veggies?|frozen|steamfresh|birds eye|green giant|medley|orange|oranges|mandarin|clementine|tangerine|grapefruit|grape|grapes|peach|peaches|nectarine|apricot|mango|mangoes|lemon|lemons|lime|limes|melon|watermelon|cantaloupe|honeydew|pineapple|papaya|pomegranate|fig|figs|date|dates|pear|pears|plum|plums|kiwi|coconut|beans|black beans|pinto beans|kidney beans|garbanzo|lentils|chickpeas|rice|quinoa|couscous|barley|farro|pasta|spaghetti|fettuccine|linguine|rigatoni|rotini|macaroni|penne|lasagna|ravioli|tortellini|gnocchi|de cecco|barilla|rao'?s|shells|noodles|ramen|chow mein|udon|soba|soup|chowder|stew|chili|broth|(?:chicken|beef|vegetable|bone|seafood|turkey|fish)\s+stock|bouillon|pizza|flatbread|calzone|burrito|chimichanga|quesadilla|enchilada|taco|taquito|tamale|empanada|dumpling|potsticker|gyoza|spring roll|wonton|hot pocket|hot pockets|morningstar|just bare|nuggets|tenders|fries|wings|poppers|mozzarella sticks|ice cream|gelato|sorbet|sherbet|popsicle|fudge bar|doritos|cheetos|takis|lay'?s|ruffles|pringles|fritos|tostitos|sun chips|sunchips|cape cod|kettle brand|utza?|herr'?s|wise|siete|lesser evil|popcorners|pirate'?s booty|smartfood|skinny pop|skinnypop|boomchickapop|cheez-it|goldfish|ritz|club crackers|town house|saltines|graham crackers|teddy grahams|animal crackers|knoppers|storck|merci|kinder|ferrero|rocher|tony'?s|chocolonely|haribo|lindt|lindor|ghirardelli|hershey'?s|reese'?s|m&m'?s|snickers|twix|milky way|kit kat|kitkat|butterfinger|skittles|starburst|sour patch|swedish fish|nerds|trolli|airheads|jolly rancher|life savers|werther'?s|wheat thins|triscuit|oreo|chips ahoy|nutter butter|belvita|newton|fig newtons|keebler|little debbie|freihofer'?s|hostess|entemann'?s|entenmann'?s|sara lee|cheerios|lucky charms|froot loops|cinnamon toast|frosted flakes|honey bunches|raisin bran|special k|rice krispies|cheX|kashi|cascadian farm|magic spoon|catalinacrunch|catalina crunch|nature'?s path|bob'?s red mill|quaker|kodiak|krusteaz|bisquick|birch benders|pearl milling|aunt jemima|mrs\.?\s*butterworth'?s|log cabin|kellogg'?s?|eggo|vans|van'?s|coca-cola|coke|pepsi|dr pepper|mountain dew|mtn dew|sprite|7up|starry|fanta|sunkist|crush|squirt|fresca|canada dry|schweppes|seagram'?s|vernors|a&w|mug|barq'?s|ibc|stewart'?s|jarritos|mexican coke|virgil'?s|zvia|zevia|culture pop|cove|liquid death|olipop|poppi|la croix|lacroix|spindrift|harmless harvest|vita coco|c2o|goya|specially selected|friendly farms|sundae shoppe|belmont|clancy'?s|millville|burman'?s|chef'?s cupboard|l'?oven fresh|park street deli|priano|mama cozzi|dakota'?s pride|happy farms|simply nature|livegfree|elevation|barissimo|benton'?s|choceur|moser roth|southern grove|sweet harvest|savoritz|tuscan garden|stonemill|bake shop|kirkwood|parkview|appleton farms|fremont fish|never any|earth grown|great value|marketside|freshness guaranteed|bettergoods|sam'?s choice|good\s*&\s*gather|favorite day|market pantry|kirkland|wellsley farms|berkley jensen|member'?s mark|simple truth|private selection|big\s+k|dashmart|wegmans|365|boar'?s head|oscar mayer|hillshire|hormel|jimmy dean|tyson|perdue|applegate|prego|ragu|classico|hunt'?s|heinz|hellmann'?s|best foods|sweet baby ray'?s|stubb'?s|a\.?1\.?|tabasco|cholula|frank'?s|redhot|hidden valley|primal kitchen|kraft|sargento|tillamook|philadelphia|chobani|fage|oikos|siggi'?s|yoplait|dannon|stonyfield|smucker'?s|bonne maman|jif|skippy|justin'?s|rxbar|clif|kind|larabar|nature valley|annie'?s|goodles|banza|protein|collagen|creatine|flour|sugar|salt|spice|seasoning|cocoa|baking|yeast|pickle|pickles|olive|olives|tofu|tempeh|seitan|almond|almonds|cashew|cashews|walnut|walnuts|pecan|pecans|pistachio|pistachios|peanut|peanuts|macadamia|hazelnut|trail mix|sunflower seeds|pumpkin seeds|chia|flax|hemp)\b""",
            RegexOption.IGNORE_CASE,
        )
        private val NON_FOOD_PRODUCT = Regex(
            """\b(paper\s+towels?|toilet\s+paper|bath\s+tissue|facial\s+tissue|kleenex|bounty|charmin|angel\s+soft|cottonelle|quilted\s+northern|brawny|sparkle|scott\s+\d+|disposable\s+(?:forks?|spoons?|knives|cutlery|utensils?|plates?|cups?|bowls?|tableware)|plastic\s+(?:forks?|spoons?|knives|cutlery|utensils?|plates?|cups?|bowls?|straws?|wrap)|paper\s+(?:plates?|bowls?|cups?|napkins?)|napkins?|trash\s+bags?|garbage\s+bags?|storage\s+bags?|freezer\s+bags?|sandwich\s+bags?|ziploc|aluminum\s+foil|parchment\s+paper|wax\s+paper|wipes?|disinfect\w*|detergent|laundry|fabric\s+softener|dryer\s+sheets?|bleach|clorox|lysol|cleaner|dish\s+soap|dish\s+detergent|dishwasher|cascade|dawn\s+(?:ultra|platinum|powerwash)|palmolive|tide|gain|persil|downy|purex|shampoo|conditioner|body\s+wash|shower\s+gel|face\s+wash|lotion|moisturizer|sunscreen|spf|deodorant|antiperspirant|toothpaste|mouthwash|toothbrushes?|floss|hand\s+soap|bar\s+soap|cleanser|serum|diapers?|pull-ups|huggies|pampers|luvs|cat\s+litter|kitty\s+litter|dog\s+food|cat\s+food|pet\s+food|puppy\s+food|kitten\s+food|dog\s+chow|purina|pedigree|friskies|blue\s+buffalo|fancy\s+feast|meow\s+mix|iams|candles?|air\s+freshener|febreze|glade|light\s+bulbs?|batteries|motor\s+oil)\b""",
            RegexOption.IGNORE_CASE,
        )
        private val PRICE_PATTERN = Regex("""(\$\s*\d+(\.\d{2}|\s+\d{2})?|\b\d+\s*dollars?(\s*(and\s*)?\d+\s*cents?)?\b)""", RegexOption.IGNORE_CASE)
        private val ADD_TILE_BUTTON = Regex("""^(\+?\s*add(\s+.+)?|quick add.*|add item.*|choose options.*|\+|increase quantity.*)$""", RegexOption.IGNORE_CASE)
        private val CLUB_ITEM_NUMBER = Regex("""^(item|model|sku)\s*:?\s*#?[a-z0-9\-]+(\s*[|•,/]\s*(item|model|sku)\s*:?\s*#?[a-z0-9\-]+)*$""", RegexOption.IGNORE_CASE)
        private val NON_INGREDIENT_TEXT = Regex(
            """\b(see (product )?packaging|refer to packaging|packaging for current|varies by location|select a store|nutrition facts|serving size|amount per serving|daily value|items to add next|product information|customers also|similar items|you might also|related items|sold by|fulfilled by)\b""",
            RegexOption.IGNORE_CASE,
        )
        private val WHITESPACE = Regex("""\s+""")
        private val LINE_SPLIT = Regex("""[\r\n]+""")
        private val SPONSORED_BADGE = Regex("""^(sponsored(\s+(ad|item|product|brand|result))?|ad|advertisement)(\s*[ⓘℹ(•\-].*)?$""", RegexOption.IGNORE_CASE)
        private val SPONSORED_ANYWHERE = Regex("""\bsponsored\b""", RegexOption.IGNORE_CASE)
        private val PDP_OUT_OF_STOCK_SIGNAL = Regex(
            """\b(out\s+of\s+stock|temporarily\s+out\s+of\s+stock|currently\s+unavailable|item\s+unavailable|sold\s+out|not\s+available\s+at\s+this\s+store)\b""",
            RegexOption.IGNORE_CASE,
        )
        private val MARKETPLACE_RETAILER_PATTERNS: List<Pair<Regex, String>> = listOf(
            Regex("""\bwhole\s*foods(?:\s+market)?\b""", RegexOption.IGNORE_CASE) to "wholefoods",
            Regex("""\bamazon\s+fresh\b""", RegexOption.IGNORE_CASE) to "amazon_fresh",
            Regex("""\bcostco(?:\s+wholesale)?\b""", RegexOption.IGNORE_CASE) to "costco",
            Regex("""\baldi\b""", RegexOption.IGNORE_CASE) to "aldi",
            Regex("""\bpublix\b""", RegexOption.IGNORE_CASE) to "publix",
            Regex("""\bsprouts(?:\s+farmers\s+market)?\b""", RegexOption.IGNORE_CASE) to "sprouts",
            Regex("""\bkroger\b""", RegexOption.IGNORE_CASE) to "kroger",
            Regex("""\bsafeway\b""", RegexOption.IGNORE_CASE) to "safeway",
            Regex("""\bwegmans\b""", RegexOption.IGNORE_CASE) to "wegmans",
            Regex("""\balbertsons\b""", RegexOption.IGNORE_CASE) to "albertsons",
            Regex("""\bh-?e-?b\b""", RegexOption.IGNORE_CASE) to "heb",
            Regex("""\btarget\b""", RegexOption.IGNORE_CASE) to "target",
            Regex("""\bwalmart\b""", RegexOption.IGNORE_CASE) to "walmart",
            Regex("""\bsam'?s\s+club\b""", RegexOption.IGNORE_CASE) to "sams",
            Regex("""\bbj'?s(?:\s+wholesale)?\b""", RegexOption.IGNORE_CASE) to "bjs",
            Regex("""\bmeijer\b""", RegexOption.IGNORE_CASE) to "meijer",
            Regex("""\bfood\s+lion\b""", RegexOption.IGNORE_CASE) to "food-lion",
            Regex("""\bstop\s*&\s*shop\b""", RegexOption.IGNORE_CASE) to "stop-and-shop",
            Regex("""\bshoprite\b""", RegexOption.IGNORE_CASE) to "shoprite",
            Regex("""\bharris\s+teeter\b""", RegexOption.IGNORE_CASE) to "harris-teeter",
            Regex("""\bfred\s+meyer\b""", RegexOption.IGNORE_CASE) to "fred-meyer",
            Regex("""\bgiant(?:\s+food|\s+eagle)?\b""", RegexOption.IGNORE_CASE) to "giant",
            Regex("""\bralphs\b""", RegexOption.IGNORE_CASE) to "ralphs",
            Regex("""\bvons\b""", RegexOption.IGNORE_CASE) to "vons",
            Regex("""\bjewel-?osco\b""", RegexOption.IGNORE_CASE) to "jewel-osco",
            Regex("""\bhy-?vee\b""", RegexOption.IGNORE_CASE) to "hy-vee",
            Regex("""\bwinco\b""", RegexOption.IGNORE_CASE) to "winco",
            Regex("""\bthe\s+fresh\s+market\b""", RegexOption.IGNORE_CASE) to "the-fresh-market",
            Regex("""\bnatural\s+grocers\b""", RegexOption.IGNORE_CASE) to "natural-grocers",
            Regex("""\bcvs(?:\s+pharmacy)?\b""", RegexOption.IGNORE_CASE) to "cvs",
            Regex("""\bwalgreens\b""", RegexOption.IGNORE_CASE) to "walgreens",
            Regex("""\btotal\s+wine\b""", RegexOption.IGNORE_CASE) to "total-wine",
            Regex("""\bdashmart\b""", RegexOption.IGNORE_CASE) to "dashmart",
        )
    }

    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val rejectedTitles = java.util.Collections.synchronizedSet(LinkedHashSet<String>())
    private var currentPackage = ""
    private var currentStoreBucket = ""
    private var lastKey = ""
    private var overlayVisible = false
    private var pendingSinceMs = 0L
    private var wasOnCartScreen = false
    private var lastCartTitleNodes: List<Pair<TextNode, String>> = emptyList()
    private var pendingAddToCartClick = false
    private var nullPkgCount = 0
    private var lastClickedProductTitle: String? = null
    private var lastClickedProductPkg = ""
    private var lastClickedProductAtMs = 0L
    private var lastConfirmedPdpTitle: String? = null
    private var lastConfirmedPdpPkg = ""
    private var lastConfirmedPdpAtMs = 0L
    private var inFlightScanKey = ""
    private var inFlightAtMs = 0L
    private var lastRowGradedTitle: String? = null
    private var lastRowLeadTitle: String? = null
    private var lastRowLeadLeftX: Int = -1
    private var lastHorizontalScrollDir: Int = 0
    private var lastHorizontalScrollAtMs: Long = 0L

    private val scanRunnable = Runnable {
        pendingSinceMs = 0L
        readAndScan()
    }
    private val followUpScanRunnable = Runnable {
        if (lastKey.isEmpty() || lastKey.endsWith("|IDLE_CART_AVG") || lastKey.endsWith("|CART_EMPTY") || lastKey.endsWith("|PDP_SCROLL_HINT") || lastKey.endsWith("|ONBOARDING_AUTH_GATE")) {
            readAndScan()
        }
    }
    private val scrollSettleScanRunnable = Runnable {
        readAndScan()
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
                } else if (pkg in STORE_PACKAGES && (lastKey.isEmpty() || lastKey.endsWith("|IDLE_CART_AVG") || lastKey.endsWith("|CART_EMPTY") || lastKey.endsWith("|PDP_SCROLL_HINT") || lastKey.endsWith("|ONBOARDING_AUTH_GATE"))) {
                    // Automatically re-check if a Product Detail Page finished loading asynchronously without firing an AccessibilityEvent
                    readAndScan()
                }
            }
            if (overlayVisible) handler.postDelayed(this, FOREGROUND_CHECK_MS)
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        activeInstance = this
        // Always reset any dismissed state when the accessibility service connects or is toggled off/on in Settings.
        sendToOverlay(OverlayWindowService.ACTION_RESET_HIDDEN)
        lastKey = ""
        rejectedTitles.clear()
        if (!AccessibilityConsent.granted(this)) {
            sendToOverlay(OverlayWindowService.ACTION_HIDE)
            overlayVisible = false
        } else {
            handler.postDelayed(scanRunnable, 150L)
        }
    }

    private fun addCandidateStrings(target: MutableList<String>, raw: CharSequence?) {
        val str = raw?.toString()?.trim().orEmpty()
        if (str.isEmpty()) return
        if (str.contains('\n') || str.contains('\r')) {
            for (line in str.split(LINE_SPLIT)) {
                val trimmed = line.trim()
                if (trimmed.isNotEmpty()) target.add(trimmed)
            }
        }
        target.add(str)
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
            currentStoreBucket = defaultBucketForPackage(pkg)
            lastKey = ""
            wasOnCartScreen = false
            lastClickedProductTitle = null
            lastConfirmedPdpTitle = null
            lastRowGradedTitle = null
            lastRowLeadTitle = null
            lastRowLeadLeftX = -1
            rejectedTitles.clear()
        }

        if (event.eventType == AccessibilityEvent.TYPE_VIEW_SCROLLED) {
            if (event.scrollDeltaX != 0) {
                lastHorizontalScrollDir = if (event.scrollDeltaX > 0) 1 else -1
                lastHorizontalScrollAtMs = System.currentTimeMillis()
            }
            handler.removeCallbacks(scrollSettleScanRunnable)
            handler.postDelayed(scrollSettleScanRunnable, 300L)
        }

        if (event.eventType == AccessibilityEvent.TYPE_VIEW_CLICKED) {
            if (event.isPassword) return
            val src = runCatching { event.source }.getOrNull()
            if (src == null || !src.isVisibleToUser || isProtectedNode(src)) {
                recycleNode(src)
                return
            }
            // Pre-check ancestors up to 4 levels so clicks inside search, chat, payment, or compose containers are ignored before reading event payloads
            var checkAncestor = runCatching { src.parent }.getOrNull()
            var checkDepth = 0
            var insideProtectedAncestor = false
            while (checkAncestor != null && checkDepth < 4) {
                val cur = checkAncestor
                if (isProtectedNode(cur)) {
                    insideProtectedAncestor = true
                    recycleNode(cur)
                    break
                }
                val next = runCatching { cur.parent }.getOrNull()
                recycleNode(cur)
                checkAncestor = next
                checkDepth++
            }
            if (!insideProtectedAncestor && checkAncestor != null) {
                recycleNode(checkAncestor)
            }
            if (insideProtectedAncestor) {
                recycleNode(src)
                return
            }

            val candidateClickStrings = ArrayList<String>()
            event.text?.forEach {
                if (!isSensitiveCandidate(it.toString())) addCandidateStrings(candidateClickStrings, it)
            }
            event.contentDescription?.let {
                if (!isSensitiveCandidate(it.toString())) addCandidateStrings(candidateClickStrings, it)
            }
            val clickedText = buildString {
                event.text?.forEach {
                    if (!isSensitiveCandidate(it.toString())) append(it).append(' ')
                }
                event.contentDescription?.let {
                    if (!isSensitiveCandidate(it.toString())) append(it).append(' ')
                }
                if (!isProtectedNode(src) && src.isVisibleToUser) {
                    src.text?.let {
                        append(it).append(' ')
                        addCandidateStrings(candidateClickStrings, it)
                    }
                    src.contentDescription?.let {
                        append(it).append(' ')
                        addCandidateStrings(candidateClickStrings, it)
                    }
                    for (i in 0 until minOf(src.childCount, 10)) {
                        val ch = runCatching { src.getChild(i) }.getOrNull() ?: continue
                        if (!isProtectedNode(ch) && ch.isVisibleToUser) {
                            addCandidateStrings(candidateClickStrings, ch.text)
                            addCandidateStrings(candidateClickStrings, ch.contentDescription)
                            ch.text?.let { append(it).append(' ') }
                            ch.contentDescription?.let { append(it).append(' ') }
                        }
                        recycleNode(ch)
                    }
                    // Walk up to 5 ancestor levels (and grandchildren) so tapping a product photo, '+' button, or 'Remove'
                    // inside a nested CardView/Compose row captures that card's title without climbing into sibling rows!
                    var ancestor = runCatching { src.parent }.getOrNull()
                    var depth = 0
                    while (ancestor != null && depth < 5) {
                        val curAncestor = ancestor
                        val beforeCount = candidateClickStrings.size
                        if (!isProtectedNode(curAncestor) && curAncestor.isVisibleToUser) {
                            addCandidateStrings(candidateClickStrings, curAncestor.text)
                            addCandidateStrings(candidateClickStrings, curAncestor.contentDescription)
                            for (i in 0 until minOf(curAncestor.childCount, 12)) {
                                val pch = runCatching { curAncestor.getChild(i) }.getOrNull() ?: continue
                                if (!isProtectedNode(pch) && pch.isVisibleToUser) {
                                    addCandidateStrings(candidateClickStrings, pch.text)
                                    addCandidateStrings(candidateClickStrings, pch.contentDescription)
                                    for (j in 0 until minOf(pch.childCount, 8)) {
                                        val gch = runCatching { pch.getChild(j) }.getOrNull() ?: continue
                                        if (!gch.isPassword && !gch.isEditable && gch.isVisibleToUser) {
                                            addCandidateStrings(candidateClickStrings, gch.text)
                                            addCandidateStrings(candidateClickStrings, gch.contentDescription)
                                        }
                                        recycleNode(gch)
                                    }
                                }
                                recycleNode(pch)
                            }
                        }
                        val foundCardTitleAtThisLevel = candidateClickStrings.subList(beforeCount, candidateClickStrings.size).any { raw ->
                            val c = cleanTitleCandidate(raw)
                            isCandidateProductTitle(c) && FOOD_HINTS.containsMatchIn(c)
                        }
                        val nextParent = runCatching { curAncestor.parent }.getOrNull()
                        recycleNode(curAncestor)
                        ancestor = nextParent
                        depth++
                        if (foundCardTitleAtThisLevel) break
                    }
                    if (ancestor != null) recycleNode(ancestor)
                }
            }.trim()
            val clickRect = Rect()
            src.getBoundsInScreen(clickRect)
            val srcViewId = src.viewIdResourceName?.lowercase().orEmpty()
            recycleNode(src)

            var clickedProduct: String? = null
            var validClickedCandidates: List<String> = emptyList()
            if (Regex("""(?i)^(back|navigate up|close|dismiss|cancel|search|clear|cart|view cart)\b""").containsMatchIn(clickedText) ||
                srcViewId.contains("back") || srcViewId.contains("close") || srcViewId.contains("toolbar_navigation")
            ) {
                lastConfirmedPdpTitle = null
                lastClickedProductTitle = null
                lastRowGradedTitle = null
                lastRowLeadTitle = null
                lastRowLeadLeftX = -1
                rejectedTitles.clear()
            } else {
                // Capture the product title from the tapped product card in case the PDP opens with a tall
                // photo + "Bought 5+ times" banner that pushes the PDP title TextView below the fold!
                validClickedCandidates = candidateClickStrings
                    .map { cleanTitleCandidate(it) }
                    .filter { isCandidateProductTitle(it) && FOOD_HINTS.containsMatchIn(it) }
                clickedProduct = validClickedCandidates
                    .filter { it.split(' ').size >= 3 }
                    .maxByOrNull { it.length }
                    ?: validClickedCandidates.maxByOrNull { it.length }
                if (clickedProduct != null) {
                    lastClickedProductTitle = clickedProduct
                    lastClickedProductPkg = pkg
                    lastClickedProductAtMs = System.currentTimeMillis()
                    rejectedTitles.clear()
                    val store = ScanApi.storeForPackage(pkg)
                    ScanApi.prewarmScan(applicationContext, clickedProduct, null, store)
                    validClickedCandidates.distinct().take(2).forEach { cand ->
                        if (cand != clickedProduct) {
                            ScanApi.prewarmScan(applicationContext, cand, null, store)
                        }
                    }
                }
            }

            val isRemoveOrCartEditClick =
                Regex("""(?i)\b(remove|delete|save for later|decrease quantity|remove item|undo)\b""").containsMatchIn(clickedText) ||
                    srcViewId.contains("remove") ||
                    srcViewId.contains("delete") ||
                    srcViewId.contains("stepper_minus") ||
                    srcViewId.contains("minus_button") ||
                    srcViewId.contains("decrement")
            if (isRemoveOrCartEditClick) {
                val isStepperMinusAtQtyOne =
                    (Regex("""(?i)\b(decrease\s+quantity|remove\s+item)\b""").containsMatchIn(clickedText) ||
                        srcViewId.contains("stepper_minus") ||
                        srcViewId.contains("minus_button") ||
                        srcViewId.contains("decrement")) &&
                        Regex("""(?i)(?:\b(?:qty|quantity)\s*:?\s*1\b|\b1\s*(?:ct|in\s+(?:cart|bag|basket|order)|item)\b|^\s*[-–—]?\s*1\s*$)""").containsMatchIn(clickedText)
                val isHardRemoveClick =
                    !clickedText.contains("undo", ignoreCase = true) && (
                        Regex("""(?i)\b(remove|delete|save for later)\b""").containsMatchIn(clickedText) ||
                            srcViewId.contains("remove") ||
                            srcViewId.contains("delete") ||
                            isStepperMinusAtQtyOne
                        )
                if (isHardRemoveClick) {
                    val density = resources.displayMetrics.density.coerceAtLeast(1f)
                    val maxCardDistPx = (340f * density).toInt()
                    val spatialMatch = if (clickRect.top > 0 && lastCartTitleNodes.isNotEmpty()) {
                        lastCartTitleNodes
                            .filter { (tn, _) ->
                                tn.top in (clickRect.top - maxCardDistPx)..(clickRect.bottom + (36f * density).toInt())
                            }
                            .minByOrNull { (tn, _) -> kotlin.math.abs(clickRect.top - tn.bottom) }
                            ?.second
                    } else null
                    val removedItemTitle = clickedProduct ?: validClickedCandidates.firstOrNull() ?: spatialMatch
                    if (!removedItemTitle.isNullOrBlank() && AccessibilityConsent.granted(this)) {
                        val remArr = org.json.JSONArray().put(removedItemTitle)
                        sendToOverlay(OverlayWindowService.ACTION_SYNC_CART) {
                            putExtra(OverlayWindowService.EXTRA_CART_ARRAY, "[]")
                            putExtra(OverlayWindowService.EXTRA_REMOVED_TITLES, remArr.toString())
                            putExtra(OverlayWindowService.EXTRA_REPLACE_CART, false)
                            putExtra(OverlayWindowService.EXTRA_KEEP_MODE, true)
                        }
                    }
                }
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
                    Regex("""(?i)\b(add\s+to\s+cart|add\s+item|increase\s+quantity|\d+\s*ct)\b""").containsMatchIn(clickedText) ||
                    srcViewId.contains("add_to_cart") ||
                    srcViewId.contains("addtocart") ||
                    srcViewId.contains("stepper_plus") ||
                    srcViewId.contains("plus_button") ||
                    srcViewId.contains("add_button") ||
                    srcViewId.contains("increment")
            if (isAddClick) {
                pendingAddToCartClick = true
                val addedTitle = clickedProduct ?: lastRowGradedTitle
                if (addedTitle != null) {
                    val store = ScanApi.storeForPackage(pkg)
                    val appContext = applicationContext
                    io.execute {
                        val json = runCatching { ScanApi.scan(appContext, addedTitle, null, store) }.getOrNull()
                        if (json != null) {
                            val arr = org.json.JSONArray().put(json)
                            handler.post {
                                if (AccessibilityConsent.granted(this@GroceryScreenReaderService)) {
                                    sendToOverlay(OverlayWindowService.ACTION_SYNC_CART) {
                                        putExtra(OverlayWindowService.EXTRA_CART_ARRAY, arr.toString())
                                        putExtra(OverlayWindowService.EXTRA_REPLACE_CART, false)
                                        putExtra(OverlayWindowService.EXTRA_KEEP_MODE, true)
                                    }
                                }
                            }
                        }
                    }
                }
                lastKey = "" // Force re-evaluation so the clicked product is recorded in cart automatically
                pendingSinceMs = System.currentTimeMillis()
                handler.removeCallbacks(scanRunnable)
                handler.postDelayed(scanRunnable, 240L)
                return
            }
        }

        val now = System.currentTimeMillis()
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            rejectedTitles.clear()
            pendingSinceMs = now
            handler.removeCallbacks(scanRunnable)
            handler.removeCallbacks(followUpScanRunnable)
            handler.postDelayed(scanRunnable, 110L)
            handler.postDelayed(followUpScanRunnable, 550L)
            return
        }
        // When waiting on "Scroll down to grade item" (or before any item has been graded), scan rapidly during scroll!
        val waitingForPdpTitle = lastKey.isEmpty() || lastKey.endsWith("|PDP_SCROLL_HINT")
        val debounceMs = if (waitingForPdpTitle) 110L else DEBOUNCE_MS
        val maxWaitMs = if (waitingForPdpTitle) 280L else MAX_DEBOUNCE_WAIT_MS
        if (pendingSinceMs == 0L) pendingSinceMs = now
        if (now - pendingSinceMs >= maxWaitMs) {
            handler.removeCallbacks(scanRunnable)
            scanRunnable.run()
            // Still schedule a trailing scan after debounceMs so when a horizontal/vertical scroll settles,
            // we always scan the final resting state!
            pendingSinceMs = System.currentTimeMillis()
            handler.postDelayed(scanRunnable, debounceMs)
            return
        }
        handler.removeCallbacks(scanRunnable)
        handler.postDelayed(scanRunnable, debounceMs)
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        if (activeInstance === this) {
            activeInstance = null
        }
        sendToOverlay(OverlayWindowService.ACTION_HIDE)
        handler.removeCallbacksAndMessages(null)
        io.shutdownNow()
        super.onDestroy()
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
            updateStoreBucketFromNodes(pkg, nodes)
            val bucketSig = currentStoreBucket.ifEmpty { defaultBucketForPackage(pkg) }
            // Slice off "Items to add next / Similar items / Customers also bought / Recommended for you" bottom carousels BEFORE
            // extracting ingredients so a collapsed "Ingredients v" pill in ALDI never reads "Velveeta Original" from the carousel below!
            val carouselIdx = nodes.indexOfFirst { CAROUSEL_BOUNDARY.containsMatchIn(it.text.trim()) }
            val primaryNodes = if (carouselIdx >= 0) nodes.subList(0, carouselIdx) else nodes
            val allCarouselIdx = allNodes.indexOfFirst { CAROUSEL_BOUNDARY.containsMatchIn(it.text.trim()) }
            val primaryAllNodes = if (allCarouselIdx >= 0) allNodes.subList(0, allCarouselIdx) else allNodes

            val ingredients = findIngredients(primaryNodes) ?: findIngredients(primaryAllNodes)

            val tileAddCount = primaryNodes.count { ADD_TILE_BUTTON.matches(it.text.trim()) }
            val totalTileAddCount = nodes.count { ADD_TILE_BUTTON.matches(it.text.trim()) }
            val hasOptionsButtons = nodes.any { it.text.trim().equals("options", ignoreCase = true) }

            val hasHomeOrAisleBanners = primaryNodes.take(35).any { HOME_OR_AISLE_BANNERS.containsMatchIn(it.text.trim()) }
            val hasSinglePdpCta = primaryNodes.any { SINGLE_PDP_CTA.containsMatchIn(it.text) } ||
                nodes.any { SINGLE_PDP_CTA.containsMatchIn(it.text) } ||
                allNodes.any { SINGLE_PDP_CTA.containsMatchIn(it.text) }
            val hasSinglePdpDetails = ingredients != null ||
                nodes.any { SINGLE_PDP_DETAILS.containsMatchIn(it.text.trim()) } ||
                allNodes.any { SINGLE_PDP_DETAILS.containsMatchIn(it.text.trim()) }
            val hasExplicitPdpViewId = nodes.any { n -> TITLE_ID_HINTS.any { n.viewId.contains(it) } } ||
                allNodes.any { n -> TITLE_ID_HINTS.any { n.viewId.contains(it) } }
            val hasClubItemNumber = nodes.any { CLUB_ITEM_NUMBER.matches(it.text.trim()) }

            val isMultiCartSwitcher = nodes.any { it.text.trim().equals("Your carts", ignoreCase = true) }
            val cartBoundaryIdx = nodes.indexOfFirst { CART_END_BOUNDARY.matches(it.text.trim()) }
            val activeCartSectionNodes = if (cartBoundaryIdx >= 0) nodes.subList(0, cartBoundaryIdx) else nodes
            val hasEmptyCartScreenSignal = !isMultiCartSwitcher && (
                activeCartSectionNodes.any { EMPTY_CART_SIGNALS.containsMatchIn(it.text.trim()) } ||
                    nodes.any { EMPTY_CART_SIGNALS.containsMatchIn(it.text.trim()) }
                )
            val hasZeroCartBadgeInHeader = nodes.take(15).any {
                Regex("""(?i)^cart\s*,?\s*(?:\(\s*0(?:\s+items?)?\s*\)|0\s+items?\b)(?:\s*,\s*\$0\.00)?$""").matches(it.text.trim())
            }
            if (hasZeroCartBadgeInHeader) {
                lastCartTitleNodes = emptyList()
                sendToOverlay(OverlayWindowService.ACTION_SYNC_CART) {
                    putExtra(OverlayWindowService.EXTRA_CART_ARRAY, "[]")
                    putExtra(OverlayWindowService.EXTRA_REPLACE_CART, true)
                    putExtra(OverlayWindowService.EXTRA_KEEP_MODE, true)
                }
            }
            val hasCartCheckoutSignal = nodes.any { CART_CHECKOUT_SIGNALS.containsMatchIn(it.text.trim()) }
            // Check CART_ITEM_CONTROLS ONLY inside activeCartSectionNodes (above "Saved for later" / "Buy it again")
            // so "Remove" buttons on saved-for-later items never block clearing an emptied cart!
            val hasCartItemControls = activeCartSectionNodes.any { CART_ITEM_CONTROLS.matches(it.text.trim()) }
            val hasDefinitiveCartScreenSignal = !isMultiCartSwitcher && (hasEmptyCartScreenSignal || (hasCartCheckoutSignal && (hasCartItemControls || nodes.any {
                val t = it.text.trim()
                t.contains("continue to checkout", ignoreCase = true) ||
                    t.contains("proceed to checkout", ignoreCase = true) ||
                    t.contains("go to checkout", ignoreCase = true) ||
                    t.contains("checkout all items", ignoreCase = true) ||
                    t.contains("estimated total", ignoreCase = true) ||
                    t.contains("item subtotal", ignoreCase = true) ||
                    t.contains("subtotal", ignoreCase = true) ||
                    t.matches(Regex("""(?i)^[^a-z0-9]*checkout(\s*\(\d+\))?$""")) ||
                    t.matches(Regex("""(?i)^cart\s*\(\d+(\s+items?)?\)$""")) ||
                    t.matches(Regex("""(?i)^(personal|family)\s+.*\bcart$""")) ||
                    t.contains("replace with best match", ignoreCase = true) ||
                    t.contains("edit instructions", ignoreCase = true) ||
                    t.contains("choose substitution", ignoreCase = true) ||
                    t.contains("skip the order min", ignoreCase = true) ||
                    t.contains("same-day delivery fees", ignoreCase = true) ||
                    t.contains("pickup fee", ignoreCase = true) ||
                    t.contains("available for all items", ignoreCase = true) ||
                    t.matches(Regex("""(?i)^available for \d+ of \d+ items.*"""))
            })))

            val rawConfirmedSinglePdp =
                !hasDefinitiveCartScreenSignal && (
                    hasExplicitPdpViewId ||
                        hasSinglePdpDetails ||
                        (hasClubItemNumber && tileAddCount < 3) ||
                        (hasSinglePdpCta && tileAddCount <= 1)
                    )

            // If the user scrolled down a PDP so far that a bottom carousel ("Recommended for you", "Similar items",
            // "Customers also bought", "Products related to this item") is now near the top/middle of the viewport and
            // no visible product title remains above the carousel header, grade the visible carousel cards in carousel/feed mode!
            val carouselHasCards = carouselIdx >= 0 && carouselIdx + 1 < nodes.size &&
                nodes.subList(carouselIdx + 1, nodes.size).any {
                    val t = it.text.trim()
                    ADD_TILE_BUTTON.matches(t) ||
                        t.equals("options", ignoreCase = true) ||
                        SINGLE_PDP_CTA.containsMatchIn(t) ||
                        PRICE_PATTERN.containsMatchIn(t)
                }
            val visiblePrimaryCandidates = if (carouselIdx >= 0) {
                findCandidateTitles(primaryNodes, emptyList(), isConfirmedSinglePdp = false, pkg = pkg)
            } else {
                emptyList()
            }
            val isViewingFullScreenCarousel =
                carouselHasCards && carouselIdx <= 18 && visiblePrimaryCandidates.isEmpty()

            val isConfirmedSinglePdp = rawConfirmedSinglePdp && !isViewingFullScreenCarousel

            if (!isConfirmedSinglePdp && (hasHomeOrAisleBanners || totalTileAddCount >= 2)) {
                lastConfirmedPdpTitle = null
            }

            // 1. Check if the user is viewing their actual Cart or Checkout screen
            val isCartScreen = !isConfirmedSinglePdp && hasDefinitiveCartScreenSignal

            if (isCartScreen) {
                val isFirstCartFrame = !wasOnCartScreen
                wasOnCartScreen = true
                lastConfirmedPdpTitle = null
                if (hasEmptyCartScreenSignal) {
                    lastCartTitleNodes = emptyList()
                    val emptyCartKey = "$pkg|$bucketSig|CART_EMPTY"
                    if (lastKey != emptyCartKey) {
                        lastKey = emptyCartKey
                        sendToOverlay(OverlayWindowService.ACTION_SYNC_CART) {
                            putExtra(OverlayWindowService.EXTRA_CART_ARRAY, "[]")
                            putExtra(OverlayWindowService.EXTRA_REPLACE_CART, true)
                        }
                        markVisible()
                    }
                    return
                }
                val prevCartSnapshot = lastCartTitleNodes.map { it.second }
                val explicitRemovedTitles = extractRemovedCartTitles(activeCartSectionNodes)
                val visibleCartTitles = extractCartScreenTitles(nodes, explicitRemovedTitles, recordNodes = true)
                val allCartTitles = extractCartScreenTitles(allNodes, explicitRemovedTitles, recordNodes = false)
                val cartTitles = ArrayList<String>(visibleCartTitles)
                for (cand in allCartTitles) {
                    val existingIdx = cartTitles.indexOfFirst { isSameCartRowTitle(it, cand) }
                    if (existingIdx >= 0) {
                        if (cand.length > cartTitles[existingIdx].length) {
                            cartTitles[existingIdx] = cand
                        }
                    } else if (cartTitles.size < 35) {
                        cartTitles.add(cand)
                    }
                }
                val removedSet = LinkedHashSet<String>(explicitRemovedTitles)
                if (!isFirstCartFrame && prevCartSnapshot.isNotEmpty() && cartTitles.size < prevCartSnapshot.size) {
                    val cartTopHeaderVisible = nodes.take(16).any {
                        Regex("""(?i)\b(your\s+cart|shopping\s+cart|cart\s*\(\d+|item\s+subtotal|subtotal)\b""").containsMatchIn(it.text.trim())
                    }
                    val firstPrevStillPresent = cartTitles.any { isSameCartRowTitle(it, prevCartSnapshot.first()) }
                    if (cartTitles.isEmpty() || cartTopHeaderVisible || firstPrevStillPresent) {
                        for (prevTitle in prevCartSnapshot) {
                            if (cartTitles.none { isSameCartRowTitle(it, prevTitle) }) {
                                removedSet.add(prevTitle)
                            }
                        }
                    }
                }
                val removedTitles = removedSet.toList()
                val cartQuantities = extractCartQuantities(nodes, cartTitles)
                val qtySig = cartTitles.joinToString(",") { t -> "${cartQuantities[t] ?: 1}" }
                if (cartTitles.isNotEmpty() || removedTitles.isNotEmpty()) {
                    val wlSig = ScanApi.currentWatchlistSignature(this)
                    val cartKey = "$pkg|$bucketSig|CART|$wlSig|first=$isFirstCartFrame|${cartTitles.joinToString("|")}|QTY:$qtySig|REM:${removedTitles.joinToString("|")}"
                    if (lastKey != cartKey) {
                        lastKey = cartKey
                        markVisible()
                        val store = ScanApi.storeForPackage(pkg)
                        val appContext = applicationContext
                        val removedJson = org.json.JSONArray(removedTitles).toString()
                        val quantitiesJson = org.json.JSONObject().apply {
                            for ((k, v) in cartQuantities) {
                                put(k, v)
                            }
                        }.toString()
                        val shouldReplace = isFirstCartFrame && cartTitles.isNotEmpty()
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
                                        putExtra(OverlayWindowService.EXTRA_CART_QUANTITIES, quantitiesJson)
                                        putExtra(OverlayWindowService.EXTRA_REPLACE_CART, shouldReplace)
                                    }
                                }
                            }
                        }
                    }
                } else {
                    val emptyCartKey = "$pkg|$bucketSig|CART_EMPTY"
                    if (lastKey != emptyCartKey) {
                        lastKey = emptyCartKey
                        if (!hasCartItemControls) {
                            sendToOverlay(OverlayWindowService.ACTION_SYNC_CART) {
                                putExtra(OverlayWindowService.EXTRA_CART_ARRAY, "[]")
                                putExtra(OverlayWindowService.EXTRA_REPLACE_CART, true)
                            }
                        } else {
                            sendToOverlay(OverlayWindowService.ACTION_IDLE_CART_AVG)
                        }
                        markVisible()
                    }
                }
                return
            }
            val hasCartHeaderTitle = nodes.take(16).any {
                val t = it.text.trim()
                t.equals("Cart", ignoreCase = true) ||
                    t.matches(Regex("""(?i)^(?:your\s+|shopping\s+|personal\s+|family\s+)?cart(?:\s*\(\d+(?:\s+items?)?\))?$"""))
            }
            if (isConfirmedSinglePdp || hasHomeOrAisleBanners || totalTileAddCount >= 2 || (!hasCartHeaderTitle && !hasCartCheckoutSignal)) {
                wasOnCartScreen = false
            }

            // Sync any visible aisle/carousel cards that already show an "in cart" or leading "1 ct" badge into Cart Check in the background!
            val aisleInCartRe = Regex("""(?i)^(?:\d+\s+in\s+(?:cart|bag|basket|order)\s*[-–—:,]?\s*|\d+\s*ct\s+)(.+)$""")
            val aisleAddedTitles = nodes.mapNotNull { n ->
                aisleInCartRe.find(n.text.trim())?.groupValues?.getOrNull(1)?.let { cleanTitleCandidate(it) }
            }.filter { isCandidateProductTitle(it) && FOOD_HINTS.containsMatchIn(it) }.distinct()
            if (aisleAddedTitles.isNotEmpty()) {
                val store = ScanApi.storeForPackage(pkg)
                val appContext = applicationContext
                io.execute {
                    val arr = org.json.JSONArray()
                    for (itemTitle in aisleAddedTitles) {
                        val json = runCatching { ScanApi.scan(appContext, itemTitle, null, store) }.getOrNull()
                        if (json != null) arr.put(json)
                    }
                    if (arr.length() > 0) {
                        handler.post {
                            if (overlayVisible && AccessibilityConsent.granted(this@GroceryScreenReaderService)) {
                                sendToOverlay(OverlayWindowService.ACTION_SYNC_CART) {
                                    putExtra(OverlayWindowService.EXTRA_CART_ARRAY, arr.toString())
                                    putExtra(OverlayWindowService.EXTRA_REPLACE_CART, false)
                                    putExtra(OverlayWindowService.EXTRA_KEEP_MODE, true)
                                }
                            }
                        }
                    }
                }
            }

            // 2. Grade the product on Product Detail Pages AND vertical/horizontal product card feeds
            val hasCarouselPricesOrStock = nodes.any { PRICE_PATTERN.containsMatchIn(it.text) } ||
                nodes.any { Regex("""(?i)\b(many|likely|low)\s+in\s+stock\b""").containsMatchIn(it.text) }
            val isProductView = hasProductContext(
                isConfirmedSinglePdp = isConfirmedSinglePdp,
                isViewingFullScreenCarousel = isViewingFullScreenCarousel,
                hasHomeOrAisleBanners = hasHomeOrAisleBanners,
                hasSinglePdpCta = hasSinglePdpCta,
                hasOptionsButtons = hasOptionsButtons,
                totalTileAddCount = totalTileAddCount,
                hasCarouselPricesOrStock = hasCarouselPricesOrStock,
            )

            val candidates = if (isViewingFullScreenCarousel && carouselIdx + 1 < nodes.size) {
                val carouselSlice = nodes.subList(carouselIdx + 1, nodes.size)
                findCandidateTitles(carouselSlice, carouselSlice, isConfirmedSinglePdp = false, pkg = pkg)
            } else if (isProductView) {
                val primary = findCandidateTitles(primaryNodes, primaryAllNodes, isConfirmedSinglePdp, pkg)
                if (primary.isNotEmpty()) {
                    primary
                } else if (primaryNodes.size < nodes.size || primaryAllNodes.size < allNodes.size) {
                    findCandidateTitles(nodes, allNodes, isConfirmedSinglePdp, pkg)
                } else {
                    emptyList()
                }
            } else {
                emptyList()
            }
            val title = candidates.firstOrNull()

            if (!isProductView || title == null) {
                // If we are on a confirmed Single Product Detail Page (e.g. sticky "$2.78 Add to cart" bar is visible),
                // NEVER fall back to "🛒 Cart: Open Cart to Grade"!
                if (isConfirmedSinglePdp) {
                    val now = System.currentTimeMillis()
                    if (inFlightScanKey.isNotEmpty() && now - inFlightAtMs < 8500L) {
                        // A scan is already in flight on this PDP; don't clobber lastKey while an async ad banner settles.
                        return
                    }
                    if (lastKey.startsWith("$pkg|") &&
                        !lastKey.endsWith("|IDLE_CART_AVG") &&
                        !lastKey.endsWith("|CART_EMPTY") &&
                        !lastKey.endsWith("|PDP_SCROLL_HINT") &&
                        !lastKey.endsWith("|ONBOARDING_AUTH_GATE") &&
                        !lastKey.contains("|CART|") &&
                        !lastKey.contains("|AISLE_CART|")
                    ) {
                        // Keep the already-graded PDP pill visible even if the user scrolled past the title.
                        return
                    }
                    val scrollHintKey = "$pkg|$bucketSig|PDP_SCROLL_HINT"
                    if (lastKey != scrollHintKey) {
                        lastKey = scrollHintKey
                        sendToOverlay(OverlayWindowService.ACTION_PDP_SCROLL_HINT)
                        markVisible()
                    }
                    return
                }

                // Keep the HeyBroc floating pill visible across all store onboarding/welcome funnel slides
                // and pre-shopping Login / Sign up / Continue as guest screens (e.g. Shipt, Kroger, DoorDash)
                // so the pill never disappears mid-funnel on pages 2–4, while suppressing automatic product popup grading.
                if (shouldSuppressAutomaticPopup(allNodes, totalTileAddCount, hasCarouselPricesOrStock)) {
                    val gateKey = "$pkg|$bucketSig|ONBOARDING_AUTH_GATE"
                    if (lastKey != gateKey || !overlayVisible) {
                        lastKey = gateKey
                        sendToOverlay(OverlayWindowService.ACTION_IDLE_CART_AVG)
                        markVisible()
                    }
                    return
                }

                val idleKey = "$pkg|$bucketSig|IDLE_CART_AVG"
                if (lastKey != idleKey || !overlayVisible) {
                    lastKey = idleKey
                    sendToOverlay(OverlayWindowService.ACTION_IDLE_CART_AVG)
                    markVisible()
                }
                return
            }

            val inCartOnPdp = pendingAddToCartClick || (isConfirmedSinglePdp && nodes.any { IN_CART_PDP_BADGE.containsMatchIn(it.text) })
            pendingAddToCartClick = false
            val isOutOfStockOnPdp = isConfirmedSinglePdp &&
                primaryNodes.any { PDP_OUT_OF_STOCK_SIGNAL.containsMatchIn(it.text) } &&
                !primaryNodes.any {
                    Regex("""\b(add\s+to\s+(?:cart|bag|basket|order)|buy\s+now|\d+\s+in\s+cart|added\s+to\s+cart)\b""", RegexOption.IGNORE_CASE)
                        .containsMatchIn(it.text)
                }

            val wlSig = ScanApi.currentWatchlistSignature(this)
            val key = "$pkg|$bucketSig|$title|${ingredients?.hashCode() ?: 0}|$inCartOnPdp|$isOutOfStockOnPdp|$wlSig"
            if (key == lastKey) return
            lastKey = key

            val store = ScanApi.storeForPackage(pkg)
            val appContext = applicationContext
            candidates.drop(1).take(2).forEach { cand ->
                if (cand.lowercase() !in rejectedTitles) {
                    ScanApi.prewarmScan(appContext, cand, null, store)
                }
            }

            // 0ms Fast-Path: if tap pre-scan or aisle pre-warm already cached this exact item, skip "Scanning…" completely!
            val instantCached = ScanApi.peekCachedScan(appContext, title, ingredients, store)
            if (instantCached != null && instantCached.contains("\"ok\":true")) {
                inFlightScanKey = ""
                if (isConfirmedSinglePdp) {
                    lastConfirmedPdpTitle = title
                    lastConfirmedPdpPkg = pkg
                    lastConfirmedPdpAtMs = System.currentTimeMillis()
                } else {
                    lastRowGradedTitle = title
                }
                markVisible()
                sendToOverlay(OverlayWindowService.ACTION_SHOW_RESULT) {
                    putExtra(OverlayWindowService.EXTRA_JSON, instantCached)
                    putExtra(OverlayWindowService.EXTRA_IN_CART, inCartOnPdp)
                    putExtra(OverlayWindowService.EXTRA_IS_SINGLE_PDP, isConfirmedSinglePdp)
                    putExtra(OverlayWindowService.EXTRA_PAGE_OUT_OF_STOCK, isOutOfStockOnPdp)
                }
                return
            }

            inFlightScanKey = key
            inFlightAtMs = System.currentTimeMillis()

            sendToOverlay(OverlayWindowService.ACTION_LOADING) { putExtra(OverlayWindowService.EXTRA_TITLE, title) }
            markVisible()
            io.execute {
                var winningTitle = title
                var winningJson: String? = null
                var lastErrorJson = """{"ok":false,"error":"Could not identify product"}"""
                for (candidate in candidates) {
                    if (candidate.lowercase() in rejectedTitles) continue
                    val res = try {
                        ScanApi.scan(appContext, candidate, ingredients, store)
                    } catch (e: Exception) {
                        """{"ok":false,"error":"HeyBroc connection error (${e.javaClass.simpleName})"}"""
                    }
                    lastErrorJson = res
                    val isOk = runCatching { org.json.JSONObject(res).optBoolean("ok") }.getOrDefault(false)
                    if (isOk) {
                        winningTitle = candidate
                        winningJson = res
                        break
                    } else if (res.contains("ignored", ignoreCase = true)) {
                        synchronized(rejectedTitles) {
                            if (rejectedTitles.size >= 80) {
                                val first = rejectedTitles.iterator().next()
                                rejectedTitles.remove(first)
                            }
                            rejectedTitles.add(candidate.lowercase())
                        }
                    }
                }
                val finalJson = winningJson ?: lastErrorJson
                val succeeded = winningJson != null
                handler.post {
                    if (inFlightScanKey == key) {
                        inFlightScanKey = ""
                    }
                    if (!overlayVisible || !AccessibilityConsent.granted(this@GroceryScreenReaderService) || currentPackage != pkg || wasOnCartScreen) {
                        return@post
                    }
                    if (succeeded) {
                        if (isConfirmedSinglePdp) {
                            lastConfirmedPdpTitle = winningTitle
                            lastConfirmedPdpPkg = pkg
                            lastConfirmedPdpAtMs = System.currentTimeMillis()
                        } else {
                            lastRowGradedTitle = winningTitle
                        }
                        val finalKey = "$pkg|$bucketSig|$winningTitle|${ingredients?.hashCode() ?: 0}|$inCartOnPdp|$isOutOfStockOnPdp|$wlSig"
                        lastKey = finalKey
                        sendToOverlay(OverlayWindowService.ACTION_SHOW_RESULT) {
                            putExtra(OverlayWindowService.EXTRA_JSON, finalJson)
                            putExtra(OverlayWindowService.EXTRA_IN_CART, inCartOnPdp)
                            putExtra(OverlayWindowService.EXTRA_IS_SINGLE_PDP, isConfirmedSinglePdp)
                            putExtra(OverlayWindowService.EXTRA_PAGE_OUT_OF_STOCK, isOutOfStockOnPdp)
                        }
                    } else if (lastKey == key) {
                        // Reset lastKey to the scroll hint / idle key so the very next scroll event re-scans immediately!
                        if (isConfirmedSinglePdp) {
                            lastKey = "$pkg|$bucketSig|PDP_SCROLL_HINT"
                            sendToOverlay(OverlayWindowService.ACTION_SHOW_RESULT) {
                                putExtra(OverlayWindowService.EXTRA_JSON, finalJson)
                                putExtra(OverlayWindowService.EXTRA_IN_CART, inCartOnPdp)
                                putExtra(OverlayWindowService.EXTRA_IS_SINGLE_PDP, true)
                                putExtra(OverlayWindowService.EXTRA_PAGE_OUT_OF_STOCK, isOutOfStockOnPdp)
                            }
                        } else {
                            lastKey = "$pkg|$bucketSig|IDLE_CART_AVG"
                            sendToOverlay(OverlayWindowService.ACTION_IDLE_CART_AVG)
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
        val left: Int = 0,
        val top: Int = 0,
        val right: Int = 0,
        val bottom: Int = 0,
        val isEdgeClipped: Boolean = false,
    )

    private fun emitSplitAndCombinedNodes(
        out: MutableList<TextNode>,
        raw: CharSequence?,
        viewId: String,
        heading: Boolean,
        visible: Boolean,
        alreadyEmitted: MutableSet<String>,
        left: Int,
        top: Int,
        right: Int,
        bottom: Int,
        isEdgeClipped: Boolean,
    ) {
        val rawStr = raw?.toString().orEmpty()
        if (rawStr.isBlank()) return
        if (rawStr.contains('\n') || rawStr.contains('\r')) {
            for (line in rawStr.split(LINE_SPLIT)) {
                val cleanLine = line.replace(WHITESPACE, " ").trim()
                if (cleanLine.isNotEmpty() && alreadyEmitted.add(cleanLine)) {
                    out.add(TextNode(cleanLine, viewId, heading, visible, out.size, left, top, right, bottom, isEdgeClipped))
                }
            }
        }
        val combined = rawStr.replace(WHITESPACE, " ").trim()
        if (combined.isNotEmpty() && alreadyEmitted.add(combined)) {
            out.add(TextNode(combined, viewId, heading, visible, out.size, left, top, right, bottom, isEdgeClipped))
        }
    }

    private fun collectTextNodes(root: AccessibilityNodeInfo): List<TextNode> {
        val out = ArrayList<TextNode>()
        val dm = resources.displayMetrics
        val density = dm.density.coerceAtLeast(1f)
        val screenW = dm.widthPixels.coerceAtLeast(720)
        val screenH = dm.heightPixels.coerceAtLeast(1280)
        val edgeMarginPx = (10f * density).toInt()
        val minCardTextWidthPx = (54f * density).toInt()
        val belowFoldThresholdY = (screenH * 0.52f).toInt()
        val rect = Rect()

        // Use Pre-order DFS (stack) so nodes are visited in true top-to-bottom document layout order!
        // (BFS visited shallow bottom-of-page section headers before deeply nested PDP title TextViews.)
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.addFirst(root)
        var seen = 0
        while (stack.isNotEmpty() && seen < MAX_NODES) {
            val node = stack.pollFirst() ?: break
            seen++
            try {
                if (isProtectedNode(node)) continue
                val viewId = node.viewIdResourceName?.lowercase().orEmpty()
                val heading = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && node.isHeading
                val visible = node.isVisibleToUser
                node.getBoundsInScreen(rect)
                val nodeW = rect.width()
                val isEdgeClipped =
                    visible && (
                        rect.left < edgeMarginPx ||
                            rect.right > screenW - edgeMarginPx ||
                            (nodeW in 1 until minCardTextWidthPx)
                        )
                val emittedForNode = HashSet<String>(6)
                emitSplitAndCombinedNodes(out, node.text, viewId, heading, visible, emittedForNode, rect.left, rect.top, rect.right, rect.bottom, isEdgeClipped)
                emitSplitAndCombinedNodes(out, node.contentDescription, viewId, heading, visible, emittedForNode, rect.left, rect.top, rect.right, rect.bottom, isEdgeClipped)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    emitSplitAndCombinedNodes(out, node.paneTitle, viewId, true, visible, emittedForNode, rect.left, rect.top, rect.right, rect.bottom, isEdgeClipped)
                    emitSplitAndCombinedNodes(out, node.tooltipText, viewId, heading, visible, emittedForNode, rect.left, rect.top, rect.right, rect.bottom, isEdgeClipped)
                }
                for (i in node.childCount - 1 downTo 0) {
                    node.getChild(i)?.let(stack::addFirst)
                }
            } finally {
                if (node !== root) recycleNode(node)
            }
        }
        while (stack.isNotEmpty()) {
            val leftover = stack.pollFirst() ?: break
            if (leftover !== root) recycleNode(leftover)
        }
        return out
    }

    /**
     * Strips top Sponsored banner ad text (e.g., "Straight Talk" / "Google Pixel 10a for $199" / "Sponsored" / "Google Pixel 10a",
     * or "Cheerios" / "Tasty Os made with care" / "Sponsored", or "Dairy Pure" / "Sponsored" right below the search bar on Walmart PDPs)
     * so banner ads are never mistaken for the product being viewed.
     */
    private fun stripSponsoredAdNodes(nodes: List<TextNode>): List<TextNode> {
        val dm = resources.displayMetrics
        val density = dm.density.coerceAtLeast(1f)
        val screenH = dm.heightPixels.coerceAtLeast(1280)
        val bannerBandPx = (78f * density).toInt()
        val topBannerMaxY = (screenH * 0.40f).toInt()
        val dropIndices = HashSet<Int>()

        for (i in nodes.indices) {
            val badgeNode = nodes[i]
            val txt = badgeNode.text.trim()
            val isSponsoredBadge = SPONSORED_BADGE.matches(txt) ||
                (txt.length <= 22 && SPONSORED_ANYWHERE.containsMatchIn(txt) && !FOOD_HINTS.containsMatchIn(txt))
            if (isSponsoredBadge && i <= 40) {
                dropIndices.add(i)
                // If "Sponsored" is after a bottom carousel header ("Items to add next", "Sponsored products") or PDP details
                // ("Product information", "Details", "Ingredients"), it is a bottom section, NOT a top banner ad!
                // NOTE: Never check PRICE_PATTERN here because Walmart's top-right Cart icon displays "$0.00" at nodes[1..4]!
                val isAfterPdpOrCarousel = (0 until i).any { prevIdx ->
                    val p = nodes[prevIdx].text.trim()
                    CAROUSEL_BOUNDARY.containsMatchIn(p) ||
                        SINGLE_PDP_DETAILS.matches(p) ||
                        SINGLE_PDP_CTA.containsMatchIn(p)
                }
                if (isAfterPdpOrCarousel) continue

                // IMPORTANT: On 2-column search/aisle grids (e.g. Walmart "Results for Weekly Essentials"),
                // the top-left product card often has a small "Sponsored" badge right above its price ("$4.68" / "Final cost by weight")
                // and product title ("Smithfield, Boneless Cooked Hickory Smoked Ham Steak...").
                // Never strip neighbor nodes when "Sponsored" belongs to a real product card with a price, "+ Add" / "Options" button, or food title!
                val isProductTileSponsored = (maxOf(1, i - 3)..minOf(nodes.lastIndex, i + 5)).any { nearIdx ->
                    if (nearIdx == i) false
                    else {
                        val nt = nodes[nearIdx].text.trim()
                        ADD_TILE_BUTTON.matches(nt) ||
                            nt.equals("options", ignoreCase = true) ||
                            PRICE_PATTERN.containsMatchIn(nt) ||
                            Regex("""(?i)\b(final\s+cost\s+by\s+weight|avg\s+price|best\s+seller|overall\s+pick|popular\s+pick|rollback|out\s+of\s+stock|many\s+in\s+stock|likely\s+in\s+stock|low\s+in\s+stock)\b""").containsMatchIn(nt) ||
                            (nt.split(' ').size >= 3 && FOOD_HINTS.containsMatchIn(nt) && !NON_FOOD_PRODUCT.containsMatchIn(nt))
                    }
                }
                if (isProductTileSponsored) continue

                // If the Sponsored badge is in the top 40% of the screen, drop any sibling banner nodes in the same horizontal strip
                if (badgeNode.top in 1..topBannerMaxY) {
                    val bannerTop = (badgeNode.top - bannerBandPx).coerceAtLeast(1)
                    val bannerBottom = badgeNode.bottom + (45f * density).toInt()
                    for (j in 0..minOf(nodes.lastIndex, i + 8)) {
                        val cand = nodes[j]
                        val ct = cand.text.trim()
                        if (cand.top in bannerTop..bannerBottom &&
                            cand.bottom <= bannerBottom + (28f * density).toInt() &&
                            !ct.startsWith("Search", ignoreCase = true) &&
                            !CAROUSEL_BOUNDARY.containsMatchIn(ct) &&
                            !SINGLE_PDP_DETAILS.matches(ct) &&
                            !SINGLE_PDP_CTA.containsMatchIn(ct) &&
                            TITLE_ID_HINTS.none { cand.viewId.contains(it) }
                        ) {
                            dropIndices.add(j)
                        }
                    }
                }

                for (back in 1..6) {
                    val prevIdx = i - back
                    if (prevIdx < 0) break
                    val prevNode = nodes[prevIdx]
                    val prev = prevNode.text.trim()
                    if (prev.startsWith("Search", ignoreCase = true) ||
                        CAROUSEL_BOUNDARY.containsMatchIn(prev) ||
                        SINGLE_PDP_DETAILS.matches(prev) ||
                        SINGLE_PDP_CTA.containsMatchIn(prev) ||
                        PRICE_PATTERN.containsMatchIn(prev) ||
                        TITLE_ID_HINTS.any { prevNode.viewId.contains(it) }
                    ) break
                    dropIndices.add(prevIdx)
                }
                for (fwd in 1..4) {
                    val nextIdx = i + fwd
                    if (nextIdx >= nodes.size) break
                    val nextNode = nodes[nextIdx]
                    val next = nextNode.text.trim()
                    if (CAROUSEL_BOUNDARY.containsMatchIn(next) ||
                        SINGLE_PDP_DETAILS.matches(next) ||
                        SINGLE_PDP_CTA.containsMatchIn(next) ||
                        PRICE_PATTERN.containsMatchIn(next) ||
                        TITLE_ID_HINTS.any { nextNode.viewId.contains(it) } ||
                        (badgeNode.bottom > 0 && nextNode.top > badgeNode.bottom + (42f * density).toInt())
                    ) break
                    dropIndices.add(nextIdx)
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
        // Reject Description / Highlights bullet points ("• Hass avocado is...", "• Stir fry mix with...")
        if (s.startsWith("•") || s.startsWith("·")) {
            return ""
        }
        // Never strip "Removed: <Product>" snackbar messages or "Notify me when back in stock" / "For <Product>" cart button labels into valid titles
        if (s.matches(Regex("""(?i)^(removed|moved to saved for later|saved for later)\s*:.*""")) ||
            s.matches(Regex("""(?i)^(notify\s+me\b|back\s+in\s+stock\b|out\s+of\s+stock\b|for\s+[a-z0-9]).*""")) ||
            Regex("""(?i)\bnotify\s+me\s+when\s+back\s+in\s+stock\b""").containsMatchIn(s)
        ) {
            return ""
        }
        // Strip leading checkmarks (e.g. "✓ Bought 5+ times, stay stocked and subscribe")
        s = s.replace(Regex("""^[✓✔☑]\s*"""), "")
        // Strip Shipt/store carousel prefixes like "Promotion 1 Of 3. Get Monster Energy" -> "Monster Energy"
        s = s.replace(Regex("""(?i)^(?:promotion|promo|slide|deal|offer|banner)\s+\d+\s*(?:of|/)\s*\d+\s*[.:,\-–—|]*\s*(?:get\s+|shop\s+|save\s+on\s+|try\s+)?"""), "")
        // If a compound product card contentDescription includes a price/weight/food signal alongside "Sponsored" (e.g. Walmart 2-col grid card
        // "Sponsored, Final cost by weight, $4.68 each (est.), Smithfield, Boneless Cooked Hickory Smoked Ham Steak, 97% Fat-Free"),
        // strip "Sponsored" so the product card's title is preserved! (Banner ads without product-card signals keep "Sponsored" and are rejected.)
        val hasProductCardSignal = PRICE_PATTERN.containsMatchIn(s) ||
            Regex("""(?i)\b(final\s+cost\s+by\s+weight|avg\s+price|best\s+seller|overall\s+pick|popular\s+pick|rollback|out\s+of\s+stock|many\s+in\s+stock|likely\s+in\s+stock|low\s+in\s+stock|\d+(?:\.\d+)?\s*(?:oz|lb|lbs|fl\s*oz|ct|count|pk|pack))\b""").containsMatchIn(s) ||
            (FOOD_HINTS.containsMatchIn(s) && s.split(' ').size >= 5)
        if (hasProductCardSignal) {
            s = s.replace(Regex("""(?i)\bsponsored(?:\s+(?:ad|item|product|brand|result))?\b\s*[,•|\-.]?"""), " ")
        }
        // Unwrap action/image contentDescriptions on PDP buttons & hero images (e.g. "Add Great Value Whole Vitamin D Milk to cart", "Product image 1 of 6, Great Value Whole Vitamin D Milk")
        s = s.replace(Regex("""(?i)^(?:add|save|remove|delete)\s+(.{5,}?)\s+(?:to|from)\s+(?:cart|bag|basket|order|favorites|list|my\s+items|registry).*$"""), "$1")
        s = s.replace(Regex("""(?i)^(?:add\s+to\s+(?:cart|bag|basket|order|favorites|list)|save\s+to\s+(?:list|favorites|my\s+items)|saved\s+to\s+(?:list|favorites|my\s+items)|favorited|share)\s*[,:•|\-–—]\s*(?=[a-zA-Z]{2,})"""), "")
        s = s.replace(Regex("""(?i)^(?:product\s+)?(?:image|photo)\s*(?:\d+\s*(?:of|/)\s*\d+)?\s*[,:•|\-–—]\s*(?=[a-zA-Z]{2,})"""), "")
        // Strip leading/embedded favorite/badge/quantity prefixes from compound container contentDescriptions
        s = s.replace(Regex("""(?i)^.*?\b(remove from favorites|add to favorites|remove from my items|add to my items)\s*[,•|\-]?\s*"""), "")
        s = s.replace(Regex("""(?i)^(remove|delete)\s+(?=[a-z0-9].*\s+[a-z0-9])"""), "")
        s = s.replace(Regex("""(?i)^\d+\s+in\s+(cart|bag|basket|order)\s*[-–—:,]?\s*"""), "")
        s = s.replace(Regex("""(?i)^\d+\s*(?:ct|count|pk|pack|ea)\s+(?=[a-zA-Z]{2,})"""), "")
        s = s.replace(Regex("""(?i)^(quantity|qty)\s*:?\s*\d+\s*[,:•|\-]?\s*"""), "")
        // Strip embedded cart/marketplace metadata ("Sold by ...", "Fulfilled by Walmart", "Gift eligible", "Multipack Quantity: 1", "Count Per Pack: 6")
        s = s.replace(Regex("""(?i)\bsold\s+and\s+shipped\s+by\s+[a-z0-9'&.\-\s]{1,35}\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\b(?:sold|fulfilled|shipped)\s+by\s+[a-z0-9'&.\-\s]{1,30}\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\b(?:multipack\s+quantity|count\s+per\s+pack|size|flavor|variant|pack\s+size)\s*:\s*[^,•|\r\n]{1,25}\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\bgift\s+eligible(?:\s+learn\s+more)?\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\bshop\s+similar(?:\s+items?)?\s*[,•|\-.]?"""), " ")
        // Strip embedded reorder/popularity/badge tokens whether separated by commas, bullets, periods, or spaces
        s = s.replace(Regex("""(?i)[✓✔☑]?\s*\bbought\s+\d+\+?\s*times?(?:\s*,?\s*stay\s+stocked(?:\s+and\s+subscribe)?)?\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\blast\s+purchased(?:\s+on)?\s+[a-z]+\s+\d{1,2}(?:\s*,\s*\d{4})?\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\b\d+[km]?\+?\s*bought\s+since\s+yesterday(?:\s*,?\s*try\s+a\s+subscription)?\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\btry\s+a\s+subscription\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\b(best\s+seller|overall\s+pick|popular\s+pick|rollback|save\s+for\s+later|subscribe\s+to\s+save|instant\s+savings|shop\s+similar|final\s+cost\s+by\s+weight|avg\s+price|average\s+price|many\s+in\s+stock|likely\s+in\s+stock|low\s+in\s+stock|with\s+loyalty\s+card)(?:\s*[ⓘℹ])?\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\babout\s+\d+(?:\.\d+)?\s*(?:lb|lbs|oz)\b\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\beach\s*\(est\.?\)\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\breg\.?\s*\$\s*\d+(?:\.\d{2})?\b\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\b\d+\s+sizes?\b\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*(?:,\s*)?was\s+(?:price\s*)?(?:averag[a-z]*|avg)\b\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*\bprice\s+(?:average|avg|averag[a-z]*)\b\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\bprice\s+may\s+vary(?:\s+in\s+club\s+and\s+online)?(?:\s*[ⓘℹ])?\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\bmax\s+\d+\s+per\s+order\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\bends\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:\s*,\s*\d{4})?(?:\s*[ⓘℹ])?\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\b(get\s+\$?\d+(?:\.\d{2})?\s+)?walmart\s+cash\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\bmanufacturer\s+offer\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\bfree\s+\d+-day\s+returns(?:\s*[ⓘℹ>])?\s*[,•|\-.]?"""), " ")
        // Strip ratings, review counts, ". Based on ..." rating accessibility suffixes, image carousel counters, EBT badges, item numbers, and prices
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*\b(item|model|sku)\s*:?\s*#?\d+\b"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*\bsnap\s+ebt(\s+eligible)?\b"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*(?:[★☆⭐]+\s*)?(?:rating\s*,?\s*|rated\s+)?\d+(?:\.\d+)?\s*out\s+of\s*5(?:\s*stars?)?(?:\s*[,•|\-.]?\s*\bbased\s+on\b.*|\s*[,•|\-]?\s*\d[\d,]*\s*(?:reviews?|ratings?))?"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*(?:[★☆⭐]+\s*)?\(\d+(?:\.\d+)?\)\s*(?:\|\s*)?\d[\d,]*(?:\s*(?:reviews?|ratings?))?"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*\b\d[\d,]*\s*(?:reviews?|ratings?)\b"""), " ")
        s = s.replace(Regex("""(?i)\s*[.,•|\-]?\s*\bbased\s+on(?:\s+[\d,]+\s+ratings?|\s+customer\s+ratings?|\s+star\s+ratings?)?\b.*$"""), "")
        s = s.replace(Regex("""(?i)\s*[,•|\-]\s*ratings?\s*$"""), "")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*(?:product\s+)?(?:image|photo)\s+\d+\s+(?:of|/)\s+\d+"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*(?:current\s+price\s*|price\s*|now\s*|was\s*)?\$\s*\d+(?:\.\d{2}|\s+\d{2})?(?:\s+off\b|\s*/\s*(?:ea|oz|fl\s*oz|lb|ct|pt|qt|gal))?"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*(?:current\s+price\s*|price\s*|now\s*|was\s*)?\b\d+\s*dollars?(?:\s*(?:and\s*)?\d+\s*cents?)?(?:\s*(?:/|per)\s*(?:ea|each|oz|fl\s*oz|lb|ct|count|pt|qt|gal))?\b"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*\bprice\s+when\s+purchased\s+online(?:\s*[ⓘℹ])?"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*\d+(?:\.\d+)?\s*(?:¢|cents?)\s*(?:/|per)\s*(?:oz|fl\s*oz|lb|ea|each|ct|count|pt|qt|gal|\d+\s*ct)\b"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*(?:,\s*)?was\s+(?:price\s*)?(?:averag[a-z]*|avg)?\s*$"""), "")
        s = s.replace(Regex("""(?i)\s*[,•|\-]\s*(now|was|current\s+price|price|add)\s*$"""), "")
        s = s.replace(Regex("""(?i)^\+?\s*add\s*[,•|\-]?\s*"""), "")
        // Strip truncated trailing weight/count/protein fragments from narrow Instacart/Walmart cards (e.g. ", Serves 7-11, 21g of P...", "(6.35 ...", "(6 C...", ", 12 As...", ", 9...")
        s = s.replace(Regex("""(?i)\s*,\s*serves\s+\d+(?:\s*[-–—]\s*\d+)?(?:\s*,\s*\d+\s*g\s+of\s+p[a-z]*(?:\.\.\.+|…)?)?\s*$"""), "")
        s = s.replace(Regex("""(?i)\s*,\s*\d+\s*g\s+of\s+p[a-z]*(?:\.\.\.+|…)?\s*$"""), "")
        s = s.replace(Regex("""\s*\(\d+(?:\.\d+)?\s*(?:[a-zA-Z]{0,6}\s*)?(?:\.\.\.+|…)?\s*$"""), "")
        s = s.replace(Regex("""\s*,\s*\d+\s*(?:[a-zA-Z]{1,4}\s*)?(?:\.\.\.+|…)\s*$"""), "")
        s = s.replace(Regex("""(?i)\btruffl(?:\.\.\.+|…)?$"""), "Truffles")
        s = s.replace(Regex("""(?i)\bchocolat(?:\.\.\.+|…)?$"""), "Chocolate")
        s = s.replace(Regex("""(?i)\bappl(?:\.\.\.+|…)?$"""), "Apples")
        s = s.replace(Regex("""(?i)\bbisma(?:rk['’]?|r|)?(?:\.\.\.+|…)?$"""), "Bismark")
        s = s.replace(Regex("""(?i)^smithfield,\s*boneless\s+cooked\s+hickory\s+smoked(?:\.\.\.+|…)?$"""), "Smithfield, Boneless Cooked Hickory Smoked Ham Steak")
        s = s.replace(Regex("""(?i)\bwing\s+sa(?:\.\.\.+|…)?$"""), "Wing Sauce")
        s = s.replace(Regex("""(?i)\band\s+re(?:\.\.\.+|…)?$"""), "and Reese's")
        s = s.replace(Regex("""\s*(?:\.\.\.+|…)\s*$"""), "")
        s = s.replace(WHITESPACE, " ").trim(' ', ',', '•', '|', '-', '.', 'ⓘ', 'ℹ')
        // Deduplicate repeated leading 1–3 word brand prefix when a merged PDP header includes both the brand link ("Great Value") and the full title ("Great Value Whole Vitamin D Milk, Gallon")
        s = s.replace(Regex("""(?i)^([a-z0-9'&]+(?:\s+[a-z0-9'&]+){0,2})\s*[,•|\-]?\s+\1\b"""), "$1")
        return s.trim(' ', ',', '•', '|', '-', '.', 'ⓘ', 'ℹ')
    }

    private fun extractRemovedCartTitles(nodes: List<TextNode>): List<String> {
        val removedRe = Regex("""(?i)^(?:removed(?:\s+from\s+cart)?|moved\s+to\s+saved\s+for\s+later)\s*:\s*(.+)$""")
        val unavailableItemLineRe = Regex("""(?i)^this\s+item\s+is\s+not\s+available\s+in\s+your\s+area\b""")
        val unavailableModalHeaderRe = Regex("""(?i)^(?:\d+\s+items?\s+are\s+no\s+longer\s+available|these\s+items\s+have\s+been\s+removed\s+from\s+your\s+cart)\b""")
        val out = LinkedHashSet<String>()
        var inUnavailableModal = false
        for (i in nodes.indices) {
            val txt = nodes[i].text.trim()
            val m = removedRe.find(txt)
            if (m != null) {
                val rawName = m.groupValues.getOrNull(1)?.trim().orEmpty()
                val cleaned = cleanTitleCandidate(rawName)
                if (cleaned.length >= 4) out.add(cleaned)
                continue
            }
            if (unavailableModalHeaderRe.containsMatchIn(txt)) {
                inUnavailableModal = true
                continue
            }
            if (inUnavailableModal) {
                if (txt.equals("continue", ignoreCase = true) || txt.equals("got it", ignoreCase = true)) {
                    inUnavailableModal = false
                    continue
                }
                val cleaned = cleanTitleCandidate(txt)
                if (cleaned.length >= 5 && isCandidateProductTitle(cleaned)) {
                    out.add(cleaned)
                }
                continue
            }
            if (unavailableItemLineRe.containsMatchIn(txt)) {
                for (fwd in 1..4) {
                    val nextNode = nodes.getOrNull(i + fwd) ?: break
                    val cleaned = cleanTitleCandidate(nextNode.text)
                    if (cleaned.length >= 5 && isCandidateProductTitle(cleaned)) {
                        out.add(cleaned)
                        break
                    }
                }
            }
        }
        return out.toList()
    }

    private fun looksLikeFoodTitle(t: String): Boolean =
        !NON_FOOD_PRODUCT.containsMatchIn(t) && (FOOD_HINTS.containsMatchIn(t) || SINGLE_WORD_PRODUCE.matches(t.trim()))

    private fun hasProductContext(
        isConfirmedSinglePdp: Boolean,
        isViewingFullScreenCarousel: Boolean,
        hasHomeOrAisleBanners: Boolean,
        hasSinglePdpCta: Boolean,
        hasOptionsButtons: Boolean,
        totalTileAddCount: Int,
        hasCarouselPricesOrStock: Boolean,
    ): Boolean =
        isConfirmedSinglePdp ||
            isViewingFullScreenCarousel ||
            (!hasHomeOrAisleBanners && (hasSinglePdpCta || hasOptionsButtons || totalTileAddCount >= 1 || hasCarouselPricesOrStock))

    private fun hasFocusedOrEditableNode(root: AccessibilityNodeInfo?): Boolean {
        if (root == null) return false
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (focused != null) {
            val isEditableFocused = isProtectedNode(focused)
            recycleNode(focused)
            if (isEditableFocused) return true
        }
        return false
    }

    private fun shouldSuppressAutomaticPopup(
        allNodes: List<TextNode>,
        totalTileAddCount: Int,
        hasCarouselPricesOrStock: Boolean,
    ): Boolean {
        val hasOnboardingGateSignal = allNodes.any { STORE_ONBOARDING_OR_AUTH_GATE.containsMatchIn(it.text) } ||
            allNodes.count { AUTH_BUTTON_SIGNAL.matches(it.text.trim()) } >= 2
        return hasOnboardingGateSignal && totalTileAddCount == 0 && !hasCarouselPricesOrStock
    }

    private fun isCandidateProductTitle(t: String): Boolean =
        t.length in 5..180 &&
            !(t.contains(". ") && t.split(' ').size > 10) &&
            t.lowercase() !in rejectedTitles &&
            !isSensitiveCandidate(t) &&
            !SPONSORED_ANYWHERE.containsMatchIn(t) &&
            !PROSE_OR_BULLET_NOISE.containsMatchIn(t) &&
            !CHAT_OR_MESSAGE_NOISE.containsMatchIn(t) &&
            !NOISE.containsMatchIn(t) &&
            !HOME_OR_AISLE_BANNERS.containsMatchIn(t) &&
            !CART_CHECKOUT_SIGNALS.containsMatchIn(t) &&
            !SINGLE_PDP_DETAILS.matches(t.trim()) &&
            !PDP_BODY_BOUNDARY.matches(t.trim()) &&
            !CAROUSEL_BOUNDARY.matches(t.trim()) &&
            !BRAND_OR_UNIT_ONLY.matches(t.trim()) &&
            !PRICE_PATTERN.containsMatchIn(t)

    private fun findCandidateTitles(
        nodes: List<TextNode>,
        allNodes: List<TextNode> = nodes,
        isConfirmedSinglePdp: Boolean = false,
        pkg: String = "",
    ): List<String> {
        val out = ArrayList<String>(4)
        fun addCandidate(c: String?) {
            val clean = c?.trim().orEmpty()
            if (clean.isEmpty() || out.size >= 4) return
            if (out.none { it.equals(clean, ignoreCase = true) }) {
                out.add(clean)
            }
        }

        // Slice off PDP body sections (Description, Highlights, About this item, From the manufacturer, Reviews)
        // so scrolling down a PDP never mistakes marketing bullets or customer reviews for the product title!
        val bodyBoundaryIdx = nodes.indexOfFirst { PDP_BODY_BOUNDARY.matches(it.text.trim()) }
        val preBodyNodes = if (bodyBoundaryIdx >= 0) nodes.subList(0, bodyBoundaryIdx) else nodes
        val allBodyBoundaryIdx = allNodes.indexOfFirst { PDP_BODY_BOUNDARY.matches(it.text.trim()) }
        val rawPreBodyAllNodes = if (allBodyBoundaryIdx >= 0) allNodes.subList(0, allBodyBoundaryIdx) else allNodes

        // On Amazon single PDPs, a top banner ad (e.g. "Wicked Cutz ... EXCELLENT SOURCE OF Protein") and a
        // "Purchased 5 times / Last purchased..." reorder box often sit above the brand header ("INGLEHOFFER / Visit the Store").
        // When "Visit the Store" or "Visit the <Brand> Store" is visible near the top of a confirmed PDP, start scanning
        // immediately after it so top ad banners are never mistaken for the product title.
        val visitStoreRe = Regex("""^visit the ([a-z0-9'&.\-\s]{1,40}\s+)?store$""", RegexOption.IGNORE_CASE)
        val visitStoreIdx = if (isConfirmedSinglePdp) {
            preBodyNodes.take(30).indexOfFirst { visitStoreRe.matches(it.text.trim()) }
        } else -1
        val allVisitStoreIdx = if (isConfirmedSinglePdp) {
            rawPreBodyAllNodes.take(35).indexOfFirst { visitStoreRe.matches(it.text.trim()) }
        } else -1
        val preBodyAllNodes = if (allVisitStoreIdx >= 0 && allVisitStoreIdx + 1 < rawPreBodyAllNodes.size) {
            rawPreBodyAllNodes.subList(allVisitStoreIdx + 1, rawPreBodyAllNodes.size)
        } else {
            rawPreBodyAllNodes
        }

        // If a previous product card on a search/aisle feed is 90% scrolled off the top of the screen, its trailing
        // "Options" or "Add to cart" button appears in the first few nodes with no product title above it. Skip past
        // that orphaned button on feed views (never on confirmed single PDPs where a sticky bar may appear early in tree order).
        val orphanedTopCtaIdx = if (!isConfirmedSinglePdp) {
            preBodyNodes.take(8).indexOfFirst {
                val t = it.text.trim()
                t.equals("options", ignoreCase = true) || t.equals("add to cart", ignoreCase = true)
            }
        } else -1
        val hasTitleBeforeOrphanCta = if (orphanedTopCtaIdx > 0) {
            preBodyNodes.subList(0, orphanedTopCtaIdx).any { n ->
                val c = cleanTitleCandidate(n.text)
                isCandidateProductTitle(c) && c.split(' ').size >= 2 && c.length >= 10
            }
        } else false
        val postOrphanNodes = if (visitStoreIdx >= 0 && visitStoreIdx + 1 < preBodyNodes.size) {
            preBodyNodes.subList(visitStoreIdx + 1, preBodyNodes.size)
        } else if (orphanedTopCtaIdx >= 0 && !hasTitleBeforeOrphanCta && orphanedTopCtaIdx + 1 < preBodyNodes.size) {
            preBodyNodes.subList(orphanedTopCtaIdx + 1, preBodyNodes.size)
        } else {
            preBodyNodes
        }

        // On home/aisle/carousel feeds (`!isConfirmedSinglePdp`), if a section header link ("View all", "See all",
        // "Shop the list", "Shop all") appears in the first 20 nodes with no product card (`+ Add`, `Options`, or price)
        // before it, any text above that link is a promotional section title/subtitle (e.g. "Thanksgiving feast for 4" /
        // "A full Thanksgiving meal, Turkey, classic sides & more."), NOT a product card!
        val sectionHeaderLinkIdx = if (!isConfirmedSinglePdp) {
            postOrphanNodes.take(20).indexOfFirst {
                val t = it.text.trim()
                t.equals("view all", ignoreCase = true) ||
                    t.equals("see all", ignoreCase = true) ||
                    t.equals("shop the list", ignoreCase = true) ||
                    t.equals("shop all", ignoreCase = true)
            }
        } else -1
        val hasCardBeforeHeaderLink = if (sectionHeaderLinkIdx > 0) {
            postOrphanNodes.subList(0, sectionHeaderLinkIdx).any {
                val t = it.text.trim()
                ADD_TILE_BUTTON.matches(t) ||
                    t.equals("options", ignoreCase = true) ||
                    PRICE_PATTERN.containsMatchIn(t)
            }
        } else false
        val searchNodes = if (sectionHeaderLinkIdx >= 0 && !hasCardBeforeHeaderLink) {
            if (sectionHeaderLinkIdx + 1 < postOrphanNodes.size) {
                postOrphanNodes.subList(sectionHeaderLinkIdx + 1, postOrphanNodes.size)
            } else {
                emptyList()
            }
        } else {
            postOrphanNodes
        }

        val maxSearchNodes = if (isConfirmedSinglePdp) searchNodes.size else minOf(searchNodes.size, 110)
        if (isConfirmedSinglePdp) {
            // Prioritize nodes in the upper/central focal viewport above any secondary lower-viewport content
            val pdpScreenH = resources.displayMetrics.heightPixels.coerceAtLeast(1200)
            val pdpFocalMaxTop = (pdpScreenH * 0.68f).toInt()
            val focalNodes = searchNodes.filter { it.top in 1..pdpFocalMaxTop }
            val lowerNodes = searchNodes.filterNot { it.top in 1..pdpFocalMaxTop }
            val orderedPdpNodes = focalNodes + lowerNodes

            // 1. Explicit product title viewId on the visible single PDP
            for (n in orderedPdpNodes) {
                val c = cleanTitleCandidate(n.text)
                if (isCandidateProductTitle(c) && !NON_FOOD_PRODUCT.containsMatchIn(c) && TITLE_ID_HINTS.any { n.viewId.contains(it) }) {
                    addCandidate(c)
                }
            }

            // 2. Accessibility heading on the visible single PDP that matches food hints
            for (n in orderedPdpNodes) {
                val c = cleanTitleCandidate(n.text)
                if (n.isHeading && isCandidateProductTitle(c) && looksLikeFoodTitle(c)) {
                    addCandidate(c)
                }
            }

            // 3. Visible multi-word nodes containing recognizable food keywords
            for (n in orderedPdpNodes.take(maxSearchNodes)) {
                val c = cleanTitleCandidate(n.text)
                if (isCandidateProductTitle(c) && c.split(' ').size >= 2 && looksLikeFoodTitle(c)) {
                    addCandidate(c)
                }
            }

            // 4. Single-word produce title on single PDP
            for (n in orderedPdpNodes.take(maxSearchNodes)) {
                val c = cleanTitleCandidate(n.text)
                if (isCandidateProductTitle(c) && SINGLE_WORD_PRODUCE.matches(c.trim())) {
                    addCandidate(c)
                }
            }
        } else {
            val dm = resources.displayMetrics
            val density = dm.density.coerceAtLeast(1f)
            val screenW = dm.widthPixels.coerceAtLeast(720)
            val screenH = dm.heightPixels.coerceAtLeast(1200)
            val focalMaxTop = (screenH * 0.68f).toInt()
            val edgeClipPx = (10f * density).toInt()
            // Cluster cards into visual horizontal rows dynamically by vertical proximity (`rowGapPx = 115dp`)
            // instead of fixed integer division (`top / 140dp`). On 2-column grids (like Walmart "Weekly Essentials"),
            // the left card often has "Sponsored" + "Final cost by weight" above its title while the right card does not,
            // shifting the left title ~40-65dp lower than the right title even though both cards are side-by-side in the same row!
            val rowGapPx = (115f * density).toInt().coerceAtLeast(1)
            data class RawTileCandidate(val node: TextNode, val cleaned: String, val width: Int)
            val dedupedRaw = ArrayList<RawTileCandidate>()
            for (n in searchNodes.take(maxSearchNodes)) {
                val c = cleanTitleCandidate(n.text)
                if (
                    isCandidateProductTitle(c) &&
                    ((c.split(' ').size >= 2 && (FOOD_HINTS.containsMatchIn(c) || NON_FOOD_PRODUCT.containsMatchIn(c))) ||
                        SINGLE_WORD_PRODUCE.matches(c.trim()))
                ) {
                    val w = (n.right - n.left).coerceAtLeast(0)
                    val existingIdx = dedupedRaw.indexOfFirst { it.cleaned.equals(c, ignoreCase = true) }
                    if (existingIdx < 0) {
                        dedupedRaw.add(RawTileCandidate(n, c, w))
                    } else if (w > dedupedRaw[existingIdx].width && !n.isEdgeClipped) {
                        dedupedRaw[existingIdx] = RawTileCandidate(n, c, w)
                    }
                }
            }
            data class CarouselCandidate(val node: TextNode, val cleaned: String, val width: Int, val rowBand: Int)
            val rawCandidates = ArrayList<CarouselCandidate>(dedupedRaw.size)
            if (dedupedRaw.isNotEmpty()) {
                val sortedByTop = dedupedRaw.sortedBy { it.node.top }
                var currentBand = 0
                var currentBandStartTop = sortedByTop.first().node.top
                val bandMembers = ArrayList<RawTileCandidate>()
                for (rc in sortedByTop) {
                    val sameColumnAsExisting = bandMembers.any {
                        kotlin.math.abs(rc.node.left - it.node.left) < (80f * density).toInt() &&
                            kotlin.math.abs(rc.node.top - it.node.top) > (48f * density).toInt()
                    }
                    if (rc.node.top - currentBandStartTop > rowGapPx || sameColumnAsExisting) {
                        currentBand++
                        currentBandStartTop = rc.node.top
                        bandMembers.clear()
                    }
                    bandMembers.add(rc)
                    rawCandidates.add(CarouselCandidate(rc.node, rc.cleaned, rc.width, currentBand))
                }
            }
            if (rawCandidates.isNotEmpty()) {
                val maxWidthByBand = HashMap<Int, Int>()
                for (rc in rawCandidates) {
                    val cur = maxWidthByBand[rc.rowBand] ?: 0
                    if (rc.width > cur) maxWidthByBand[rc.rowBand] = rc.width
                }
                fun isPartiallyClippedInRow(rc: CarouselCandidate): Boolean {
                    if (rc.node.isEdgeClipped) return true
                    if (rc.node.left < edgeClipPx) return true
                    // If a card's right edge doesn't reach 34% of the screen width, it's a departing left-edge card.
                    if (rc.node.right in 1 until (screenW * 0.34f).toInt()) return true
                    // If a card's left edge starts past 56% of the screen width, it's a 3rd-column / right-edge card off to the side.
                    if (rc.node.left > (screenW * 0.56f).toInt()) return true
                    if (rc.node.right > screenW - edgeClipPx) return true
                    val maxW = maxWidthByBand[rc.rowBand] ?: 0
                    // When a card in a horizontal carousel slides partially off the left or right edge,
                    // Android clamps getBoundsInScreen(rect) to the viewport so its visible width shrinks
                    // compared to the full card next to it. Allow normal 2-column text width differences (>= 65% of maxW).
                    return maxW >= (64f * density).toInt() && rc.width < (maxW * 0.65f).toInt() && rc.width < (screenW * 0.32f).toInt()
                }
                // Always select the leftmost unclipped card (`unclipped[0]`) in the top focal visible row so the
                // scanner stays aligned with the primary card on screen (e.g. Smithfield Ham Steak on the left of a
                // 2-column grid, or Butterball Turkey in the left/center slot) and never jumps to bottom carousels!
                val unclipped = rawCandidates
                    .filterNot { isPartiallyClippedInRow(it) }
                    .sortedWith(
                        compareBy<CarouselCandidate> { if (it.node.top in 1..focalMaxTop) 0 else 1 }
                            .thenBy { it.rowBand }
                            .thenBy { it.node.left }
                            .thenBy { it.node.index }
                    )
                if (unclipped.isNotEmpty()) {
                    val topBand = unclipped.first().rowBand
                    val topRowCards = unclipped.filter { it.rowBand == topBand }
                    val primaryCard = topRowCards.firstOrNull()
                    if (primaryCard != null) {
                        lastRowLeadTitle = primaryCard.cleaned
                        lastRowLeadLeftX = primaryCard.node.left
                    }
                    // When the primary card in the active carousel is a non-food household item (e.g. Paper Towels
                    // or Disposable Plastic Forks & Spoons in "Shop everyday essentials"), return emptyList() so
                    // readAndScan() immediately displays 🛒 Cart Avg instead of scanning a peripheral card off to the side.
                    if (primaryCard != null && !NON_FOOD_PRODUCT.containsMatchIn(primaryCard.cleaned)) {
                        for (sc in topRowCards) {
                            if (!NON_FOOD_PRODUCT.containsMatchIn(sc.cleaned)) {
                                addCandidate(sc.cleaned)
                            }
                        }
                    }
                }
            }
        }

        // 5. Below-the-fold PDP nodes (`preBodyAllNodes` includes below-the-fold `isVisible == false` nodes inside the PDP ScrollView
        // that were pushed just below the sticky "$2.78 Add to cart" bar by a tall 1:1 product photo and "Bought 5+ times" banner!).
        // ONLY run when `isConfirmedSinglePdp && out.isEmpty()` so hidden nodes never compete with a visible product title!
        if (isConfirmedSinglePdp && out.isEmpty() && preBodyAllNodes.isNotEmpty()) {
            for (n in preBodyAllNodes) {
                val c = cleanTitleCandidate(n.text)
                if (isCandidateProductTitle(c) && !NON_FOOD_PRODUCT.containsMatchIn(c) && TITLE_ID_HINTS.any { n.viewId.contains(it) }) {
                    addCandidate(c)
                }
            }
            for (n in preBodyAllNodes) {
                val c = cleanTitleCandidate(n.text)
                if (n.isHeading && isCandidateProductTitle(c) && looksLikeFoodTitle(c)) {
                    addCandidate(c)
                }
            }
            for (n in preBodyAllNodes) {
                val c = cleanTitleCandidate(n.text)
                if (isCandidateProductTitle(c) && c.split(' ').size >= 2 && looksLikeFoodTitle(c)) {
                    addCandidate(c)
                }
            }
            for (n in preBodyAllNodes) {
                val c = cleanTitleCandidate(n.text)
                if (isCandidateProductTitle(c) && SINGLE_WORD_PRODUCE.matches(c.trim())) {
                    addCandidate(c)
                }
            }
        }

        // 6. Accessibility heading on a confirmed single-product page
        if (isConfirmedSinglePdp && out.isEmpty()) {
            for (n in searchNodes) {
                val c = cleanTitleCandidate(n.text)
                if (n.isHeading && isCandidateProductTitle(c) && c.split(' ').size >= 2) {
                    addCandidate(c)
                }
            }
            for (n in preBodyAllNodes) {
                val c = cleanTitleCandidate(n.text)
                if (n.isHeading && isCandidateProductTitle(c) && c.split(' ').size >= 2) {
                    addCandidate(c)
                }
            }

            // 7. Fallback to the confirmed PDP title captured before scrolling into Description/Reviews, or the product card tapped to open this PDP
            val now = System.currentTimeMillis()
            if (lastConfirmedPdpTitle != null && lastConfirmedPdpPkg == pkg && now - lastConfirmedPdpAtMs <= 120_000L) {
                addCandidate(lastConfirmedPdpTitle)
            }
            if (lastClickedProductTitle != null && lastClickedProductPkg == pkg && now - lastClickedProductAtMs <= 35_000L) {
                addCandidate(lastClickedProductTitle)
            }
        }

        return out
    }

    /**
     * Extracts the actual product titles listed in the user's Cart screen (e.g. Walmart, BJ's, ALDI, Instacart Cart)
     * so `🛒 Cart Avg` and the Whole-Cart Health Check drawer match the real items in their cart.
     * Strictly requires recognizable grocery/household/personal-care keywords (`FOOD_HINTS`) or an explicit
     * product title viewId so Cart UI chrome (delivery addresses, barcode scanner button, Express/Today time slots)
     * is never mistaken for a cart item.
     */
    private fun normalizeCartDedupKey(raw: String): String =
        raw.lowercase()
            .replace(Regex("""\b93?%\s*lean\s*/?\s*7?%\s*fat\b"""), "93 7 lean fat")
            .replace(Regex("""\b80?%\s*lean\s*/?\s*20?%\s*fat\b"""), "80 20 lean fat")
            .replace(Regex("""\b85?%\s*lean\s*/?\s*15?%\s*fat\b"""), "85 15 lean fat")
            .replace(Regex("""\b73?%\s*lean\s*/?\s*27?%\s*fat\b"""), "73 27 lean fat")
            .replace(Regex("""[,•|\-–—.…*]+"""), " ")
            .replace(WHITESPACE, " ")
            .trim()

    private fun isSameCartRowTitle(a: String, b: String): Boolean {
        val na = normalizeCartDedupKey(a)
        val nb = normalizeCartDedupKey(b)
        if (na == nb) return true
        val shorter = if (na.length <= nb.length) na else nb
        val longer = if (na.length <= nb.length) nb else na
        return shorter.length >= 26 && longer.startsWith(shorter)
    }

    private fun extractCartScreenTitles(
        nodes: List<TextNode>,
        removedTitles: List<String> = emptyList(),
        recordNodes: Boolean = false
    ): List<String> {
        val endIdx = nodes.indexOfFirst { CART_END_BOUNDARY.matches(it.text.trim()) }
        val cartNodes = if (endIdx >= 0) nodes.subList(0, endIdx) else nodes
        val seen = ArrayList<String>()
        val nodePairs = if (recordNodes) ArrayList<Pair<TextNode, String>>() else null
        for (n in cartNodes) {
            val c = cleanTitleCandidate(n.text)
            if (!isCandidateProductTitle(c)) continue
            if (removedTitles.any { rem -> isSameCartRowTitle(c, rem) || c.contains(rem, ignoreCase = true) || rem.contains(c, ignoreCase = true) }) {
                continue
            }
            val words = c.split(' ').filter { it.isNotBlank() }
            val hasExplicitTitleViewId = TITLE_ID_HINTS.any { n.viewId.contains(it) }
            if (looksLikeFoodTitle(c) && (words.size >= 1 || hasExplicitTitleViewId)) {
                val existingIdx = seen.indexOfFirst { isSameCartRowTitle(it, c) }
                if (existingIdx >= 0) {
                    if (c.length > seen[existingIdx].length) {
                        seen[existingIdx] = c
                    }
                } else {
                    seen.add(c)
                }
                nodePairs?.add(n to c)
            }
            if (seen.size >= 35) break
        }
        if (recordNodes && nodePairs != null) {
            lastCartTitleNodes = nodePairs
        }
        return seen
    }

    private fun extractCartQuantities(nodes: List<TextNode>, cartTitles: List<String>): Map<String, Int> {
        if (cartTitles.isEmpty()) return emptyMap()
        val endIdx = nodes.indexOfFirst { CART_END_BOUNDARY.matches(it.text.trim()) }
        val cartNodes = if (endIdx >= 0) nodes.subList(0, endIdx) else nodes
        val density = resources.displayMetrics.density.coerceAtLeast(1f)
        val maxRowDistPx = (145f * density).toInt()
        val explicitQtyRe = Regex("""(?i)(?:\b(?:qty|quantity)\s*:?\s*(\d{1,2})\b|^(\d{1,2})\s*(?:ct|in\s+(?:cart|bag|basket|order)|items?)\b)""")
        val bareQtyRe = Regex("""^(\d{1,2})$""")
        val out = HashMap<String, Int>()
        for (title in cartTitles) {
            val anchorIdx = cartNodes.indexOfFirst { n ->
                val c = cleanTitleCandidate(n.text)
                isCandidateProductTitle(c) && isSameCartRowTitle(c, title)
            }
            if (anchorIdx < 0) {
                out[title] = 1
                continue
            }
            val anchor = cartNodes[anchorIdx]
            var qty = 1
            // Check raw node text prefix first (e.g. "2 in cart, Organic Whole Milk" or "Qty: 3 ...")
            explicitQtyRe.find(anchor.text.trim())?.let { m ->
                val parsed = (m.groupValues.getOrNull(1)?.takeIf { it.isNotEmpty() } ?: m.groupValues.getOrNull(2))
                    ?.toIntOrNull()
                if (parsed != null && parsed in 1..99) qty = parsed
            }
            if (qty == 1) {
                val start = (anchorIdx - 4).coerceAtLeast(0)
                val end = (anchorIdx + 8).coerceAtMost(cartNodes.size - 1)
                for (i in start..end) {
                    if (i == anchorIdx) continue
                    val near = cartNodes[i]
                    if (anchor.top > 0 && near.top > 0 && kotlin.math.abs(near.top - anchor.top) > maxRowDistPx) continue
                    val rawTxt = near.text.trim()
                    val expMatch = explicitQtyRe.find(rawTxt)
                    if (expMatch != null) {
                        val parsed = (expMatch.groupValues.getOrNull(1)?.takeIf { it.isNotEmpty() } ?: expMatch.groupValues.getOrNull(2))
                            ?.toIntOrNull()
                        if (parsed != null && parsed in 1..99) {
                            qty = parsed
                            break
                        }
                    }
                    val bareMatch = bareQtyRe.matchEntire(rawTxt)
                    if (bareMatch != null) {
                        val hasStepperNeighbor = listOfNotNull(cartNodes.getOrNull(i - 1), cartNodes.getOrNull(i + 1)).any { nb ->
                            val nt = nb.text.trim()
                            val nid = nb.viewId.lowercase()
                            nt == "+" || nt == "-" || nt == "−" ||
                                Regex("""(?i)\b(increase|decrease|remove|delete|add)\b""").containsMatchIn(nt) ||
                                nid.contains("stepper") || nid.contains("quantity") || nid.contains("qty") || nid.contains("plus") || nid.contains("minus")
                        }
                        if (hasStepperNeighbor || near.viewId.lowercase().let { it.contains("qty") || it.contains("quantity") || it.contains("stepper") }) {
                            val parsed = bareMatch.groupValues[1].toIntOrNull()
                            if (parsed != null && parsed in 1..99) {
                                qty = parsed
                                break
                            }
                        }
                    }
                }
            }
            out[title] = qty.coerceIn(1, 99)
        }
        return out
    }

    private fun defaultBucketForPackage(pkg: String): String = when (pkg) {
        "com.wholefoods.wholefoodsmarket" -> "wholefoods"
        else -> ScanApi.storeForPackage(pkg)
    }

    private fun updateStoreBucketFromNodes(pkg: String, nodes: List<TextNode>) {
        if (pkg == "com.wholefoods.wholefoodsmarket") {
            currentStoreBucket = "wholefoods"
            return
        }
        val screenH = resources.displayMetrics.heightPixels.coerceAtLeast(1200)
        val headerMaxTop = (screenH * 0.30f).toInt()
        val headerNodes = nodes.take(32).filter { (it.top in 0..headerMaxTop) && it.text.length in 2..68 }

        if (pkg == "com.amazon.mShop.android.shopping") {
            for (hn in headerNodes) {
                val t = hn.text.trim()
                if (Regex("""\bwhole\s*foods(?:\s+market)?\b""", RegexOption.IGNORE_CASE).containsMatchIn(t)) {
                    currentStoreBucket = "wholefoods"
                    return
                }
                if (Regex("""\b(amazon\s+fresh|fresh\s+cart|search\s+amazon\s+fresh)\b""", RegexOption.IGNORE_CASE).containsMatchIn(t)) {
                    currentStoreBucket = "amazon_fresh"
                    return
                }
                if (Regex("""^search\s+amazon(?:\.com)?$""", RegexOption.IGNORE_CASE).matches(t)) {
                    currentStoreBucket = "amazon"
                    return
                }
            }
            if (currentStoreBucket.isEmpty() || !currentStoreBucket.startsWith("amazon") && currentStoreBucket != "wholefoods") {
                currentStoreBucket = "amazon"
            }
            return
        }

        val marketplaceBase = when (pkg) {
            "com.instacart.client" -> "instacart"
            "com.dd.doordash" -> "doordash"
            "com.ubercab.eats" -> "ubereats"
            "com.shipt.groceries" -> "shipt"
            else -> null
        }
        if (marketplaceBase == null) {
            currentStoreBucket = ScanApi.storeForPackage(pkg)
            return
        }
        if (nodes.any { it.text.trim().equals("Your carts", ignoreCase = true) }) {
            return
        }
        val explicitStoreContextRe = Regex(
            """(?i)^(?:search|shop|shopping(?:\s+at|\s+in)?|welcome\s+to)\s+(.+)$|^(.+?)\s+(?:cart|delivery|pickup)$|^(?:personal|family)\s+(.+?)\s+cart$"""
        )
        for (hn in headerNodes) {
            val t = hn.text.trim()
            val ctxMatch = explicitStoreContextRe.find(t)
            val candidateText = if (ctxMatch != null) {
                ctxMatch.groupValues.drop(1).firstOrNull { it.isNotBlank() }?.trim().orEmpty()
            } else if (t.length <= 36 && !PRICE_PATTERN.containsMatchIn(t) && !FOOD_HINTS.containsMatchIn(t)) {
                t
            } else {
                ""
            }
            if (candidateText.isEmpty()) continue
            for ((pattern, slug) in MARKETPLACE_RETAILER_PATTERNS) {
                if (slug != marketplaceBase && pattern.containsMatchIn(candidateText)) {
                    currentStoreBucket = "$marketplaceBase:$slug"
                    return
                }
            }
        }
        if (currentStoreBucket.isEmpty() || !currentStoreBucket.startsWith(marketplaceBase)) {
            currentStoreBucket = marketplaceBase
        }
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
            if (CHAT_OR_MESSAGE_NOISE.containsMatchIn(cleaned)) return null
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
            if (currentStoreBucket.isNotEmpty()) {
                putExtra(OverlayWindowService.EXTRA_STORE_BUCKET, currentStoreBucket)
            }
            extras()
        }
        try {
            startService(intent)
        } catch (_: IllegalStateException) {
            // Background-start restriction (shouldn't happen while bound as an accessibility service).
        }
    }

    /**
     * Drives the active grocery store app's native search bar automatically when the shopper taps
     * "Find in [Store] ↗" across ALL 13 supported grocery apps:
     * 1) Sanitizes the query (stripping parenthetical dietary notes like "(Nut-Free)" and duplicate words).
     * 2) Handles multi-step search navigation (e.g. Walmart PDP/Cart -> Search Hub landing screen ->
     *    tapping the "Search Walmart" pill to mount the live EditText -> setting the query ->
     *    triggering ACTION_IME_ENTER and tapping the top autocomplete/search suggestion row).
     * 3) If triggered from a screen with no visible search bar (such as the full Cart screen), invokes
     *    [onFallbackNeeded] to navigate the app to its search screen and then continues driving the
     *    search input automatically so the shopper never lands on a blank search hub.
     */
    private fun sanitizeInAppSearchQuery(raw: String): String {
        val stripped = raw
            .replace(Regex("""\([^)]*\)"""), " ")
            .replace(Regex("""\b(nut-free|peanut-free|tree-nut-free|sesame-free|allergen-friendly|school-safe)\b""", RegexOption.IGNORE_CASE), " ")
            .replace(Regex("""\borganics\s+organic\b""", RegexOption.IGNORE_CASE), "Organic")
            .replace(Regex("""\braw\s+(?=sharp\s+cheddar\b)""", RegexOption.IGNORE_CASE), " ")
            .replace(Regex("""\b(made\s+with|cooked\s+in)\s+(100%\s+)?(avocado|extra\s+virgin\s+olive|olive|coconut)\s+oil\b""", RegexOption.IGNORE_CASE), " ")
            .replace(Regex("""[^\w\s'&.-]"""), " ")
            .replace(Regex("""\s+"""), " ")
            .trim()
        val deduped = mutableListOf<String>()
        for (word in stripped.split(" ")) {
            if (word.isBlank()) continue
            if (deduped.any { it.equals(word, ignoreCase = true) && (word.equals("organic", ignoreCase = true) || deduped.last().equals(word, ignoreCase = true)) }) {
                continue
            }
            deduped.add(word)
        }
        return deduped.take(8).joinToString(" ").ifBlank { raw.trim() }
    }

    private fun findStoreWindowRoot(preferredPkg: String): AccessibilityNodeInfo? {
        val active = rootInActiveWindow
        val activePkg = active?.packageName?.toString().orEmpty()
        if (active != null && activePkg.isNotEmpty() && activePkg != packageName) {
            if (preferredPkg.isBlank() || activePkg == preferredPkg || activePkg in STORE_PACKAGES) {
                return active
            }
        }
        runCatching {
            val allWindows = windows
            var fallbackSupportedRoot: AccessibilityNodeInfo? = null
            for (win in allWindows) {
                val r = win.root ?: continue
                val pkg = r.packageName?.toString().orEmpty()
                if (pkg.isEmpty() || pkg == packageName) continue
                if (preferredPkg.isNotBlank() && pkg == preferredPkg) {
                    return r
                }
                if (fallbackSupportedRoot == null && pkg in STORE_PACKAGES) {
                    fallbackSupportedRoot = r
                }
            }
            if (fallbackSupportedRoot != null) {
                return fallbackSupportedRoot
            }
        }
        return active?.takeIf { it.packageName?.toString() != packageName }
    }

    private fun startInAppSearch(
        targetPkg: String,
        query: String,
        onFallbackNeeded: (() -> Unit)? = null
    ): Boolean {
        val cleanQuery = sanitizeInAppSearchQuery(query)
        if (cleanQuery.isEmpty()) return false

        // Wait 180ms for OverlayWindowService.removeCard() to detach focus so the grocery store window is active
        handler.postDelayed({
            performInAppSearchStep(
                targetPkg = targetPkg,
                query = cleanQuery,
                attempt = 0,
                triggerClicks = 0,
                focusedEditCount = 0,
                submittedCount = 0,
                launchedFallback = false,
                onFallbackNeeded = onFallbackNeeded
            )
        }, 180L)
        return true
    }

    private fun editNodeHasQuery(editNode: AccessibilityNodeInfo, query: String): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && editNode.isShowingHintText) {
            return false
        }
        val currentText = editNode.text?.toString()?.trim().orEmpty()
        if (currentText.isEmpty()) return false
        val hintText = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            editNode.hintText?.toString()?.trim().orEmpty()
        } else {
            ""
        }
        if (hintText.isNotEmpty() && currentText.equals(hintText, ignoreCase = true)) {
            return false
        }
        if (Regex("""^(?i)(search(\s+\w+){0,3}|what are you looking for.*|what can we help you find.*|ask rufus.*|find products.*)$""").matches(currentText)) {
            return false
        }
        val firstWord = query.lowercase().replace(Regex("[^a-z0-9\\s]"), "").trim().substringBefore(" ")
        return currentText.equals(query, ignoreCase = true) ||
            (firstWord.length >= 2 && currentText.lowercase().contains(firstWord))
    }

    private fun fireImeEnter(node: AccessibilityNodeInfo) {
        val imeActionId = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id
        } else {
            0x01020054 // android.R.id.accessibilityActionImeEnter
        }
        node.performAction(imeActionId)
    }

    private fun performInAppSearchStep(
        targetPkg: String,
        query: String,
        attempt: Int,
        triggerClicks: Int,
        focusedEditCount: Int,
        submittedCount: Int,
        launchedFallback: Boolean,
        onFallbackNeeded: (() -> Unit)? = null
    ) {
        if (attempt > 14) {
            if (submittedCount == 0 && !launchedFallback) {
                onFallbackNeeded?.invoke()
            }
            return
        }
        val root = findStoreWindowRoot(targetPkg) ?: run {
            if (attempt >= 3 && !launchedFallback && onFallbackNeeded != null) {
                onFallbackNeeded.invoke()
                handler.postDelayed({
                    performInAppSearchStep(
                        targetPkg = targetPkg,
                        query = query,
                        attempt = attempt + 1,
                        triggerClicks = 0,
                        focusedEditCount = 0,
                        submittedCount = 0,
                        launchedFallback = true,
                        onFallbackNeeded = null
                    )
                }, 550L)
                return
            }
            handler.postDelayed({
                performInAppSearchStep(
                    targetPkg = targetPkg,
                    query = query,
                    attempt = attempt + 1,
                    triggerClicks = triggerClicks,
                    focusedEditCount = focusedEditCount,
                    submittedCount = submittedCount,
                    launchedFallback = launchedFallback,
                    onFallbackNeeded = onFallbackNeeded
                )
            }, 260L)
            return
        }

        // 1. Check for an editable search EditText on screen
        val editNode = findEditableSearchNode(root)
        if (editNode != null) {
            val hasQueryText = editNodeHasQuery(editNode, query)
            if (!hasQueryText) {
                // On Walmart PDP & Search Hub, clicking an unfocused EditText/search bar transitions to a new search input fragment ~250ms later.
                // Focus/click it first and wait 320ms so ACTION_SET_TEXT hits the live, focused EditText instead of the outgoing bar.
                if (!editNode.isFocused && focusedEditCount < 2) {
                    clickNodeOrParent(editNode)
                    editNode.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
                    handler.postDelayed({
                        performInAppSearchStep(
                            targetPkg = targetPkg,
                            query = query,
                            attempt = attempt + 1,
                            triggerClicks = triggerClicks,
                            focusedEditCount = focusedEditCount + 1,
                            submittedCount = submittedCount,
                            launchedFallback = launchedFallback,
                            onFallbackNeeded = onFallbackNeeded
                        )
                    }, 320L)
                    return
                }
                val args = android.os.Bundle().apply {
                    putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, query)
                }
                var setOk = editNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
                if (!setOk) {
                    editNode.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
                    setOk = editNode.performAction(AccessibilityNodeInfo.ACTION_PASTE)
                }
                if (setOk) {
                    fireImeEnter(editNode)
                    handler.postDelayed({
                        runCatching {
                            val latestRoot = findStoreWindowRoot(targetPkg)
                            val latestEdit = latestRoot?.let { findEditableSearchNode(it) }
                            if (latestEdit != null) {
                                fireImeEnter(latestEdit)
                            }
                        }
                    }, 180L)
                    // Schedule a follow-up step to verify the text stuck and tap the top autocomplete/submit row if needed.
                    handler.postDelayed({
                        performInAppSearchStep(
                            targetPkg = targetPkg,
                            query = query,
                            attempt = attempt + 1,
                            triggerClicks = triggerClicks,
                            focusedEditCount = focusedEditCount,
                            submittedCount = submittedCount + 1,
                            launchedFallback = launchedFallback,
                            onFallbackNeeded = onFallbackNeeded
                        )
                    }, 420L)
                    return
                }
            } else {
                // Query is already in the EditText! Fire IME_ENTER again and tap the top autocomplete suggestion / submit row.
                fireImeEnter(editNode)
                val editRect = Rect()
                editNode.getBoundsInScreen(editRect)
                val submitOrSuggestion = findSearchSubmitOrSuggestionNode(root, query, editRect.bottom)
                if (submitOrSuggestion != null && clickNodeOrParent(submitOrSuggestion)) {
                    return
                }
                // Over slow 4G LTE connections (e.g. Walmart Search Input page), autocomplete rows can take ~600-1000ms to render.
                // Keep retrying every 340ms while the search EditText is still open so we tap the top suggestion as soon as it appears!
                if (attempt < 14) {
                    handler.postDelayed({
                        performInAppSearchStep(
                            targetPkg = targetPkg,
                            query = query,
                            attempt = attempt + 1,
                            triggerClicks = triggerClicks,
                            focusedEditCount = focusedEditCount,
                            submittedCount = submittedCount + 1,
                            launchedFallback = launchedFallback,
                            onFallbackNeeded = onFallbackNeeded
                        )
                    }, 340L)
                }
                return
            }
        }

        // 2. If we already typed & submitted the query and suggestions are visible, tap the top suggestion row if present
        if (submittedCount > 0) {
            val submitOrSuggestion = findSearchSubmitOrSuggestionNode(root, query, 0)
            if (submitOrSuggestion != null) {
                clickNodeOrParent(submitOrSuggestion)
                return
            }
        }

        // 3. No live EditText yet: find and click the store's search bar pill or bottom/top "Search" icon/tab.
        if (triggerClicks < 5) {
            val triggerNode = findSearchTriggerNode(root)
            if (triggerNode != null && clickNodeOrParent(triggerNode)) {
                handler.postDelayed({
                    performInAppSearchStep(
                        targetPkg = targetPkg,
                        query = query,
                        attempt = attempt + 1,
                        triggerClicks = triggerClicks + 1,
                        focusedEditCount = 0,
                        submittedCount = submittedCount,
                        launchedFallback = launchedFallback,
                        onFallbackNeeded = onFallbackNeeded
                    )
                }, 380L)
                return
            }
        }

        // 4. If we are on a screen with NO search bar at all (such as Walmart's Cart screen), invoke onFallbackNeeded
        //    to jump into the app's search screen, and KEEP running performInAppSearchStep so we type the query once it loads!
        if (!launchedFallback && triggerClicks == 0 && submittedCount == 0 && onFallbackNeeded != null) {
            onFallbackNeeded.invoke()
            handler.postDelayed({
                performInAppSearchStep(
                    targetPkg = targetPkg,
                    query = query,
                    attempt = attempt + 1,
                    triggerClicks = 0,
                    focusedEditCount = 0,
                    submittedCount = 0,
                    launchedFallback = true,
                    onFallbackNeeded = null
                )
            }, 550L)
            return
        }

        // 5. Retry while the search screen or fragment is still animating open
        if (attempt < 13) {
            handler.postDelayed({
                performInAppSearchStep(
                    targetPkg = targetPkg,
                    query = query,
                    attempt = attempt + 1,
                    triggerClicks = triggerClicks,
                    focusedEditCount = focusedEditCount,
                    submittedCount = submittedCount,
                    launchedFallback = launchedFallback,
                    onFallbackNeeded = onFallbackNeeded
                )
            }, 340L)
        }
    }

    private fun findEditableSearchNode(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val focused = runCatching { root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }.getOrNull()
        if (focused != null && focused.isVisibleToUser && !focused.isPassword) {
            val fCls = focused.className?.toString().orEmpty()
            if (focused.isEditable || fCls.contains("EditText", ignoreCase = true) || fCls.contains("AutoComplete", ignoreCase = true)) {
                return focused
            }
        }
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var bestFocused: AccessibilityNodeInfo? = null
        var bestUnfocused: AccessibilityNodeInfo? = null
        while (queue.isNotEmpty()) {
            val n = queue.removeFirst()
            if (n.isVisibleToUser && !n.isPassword) {
                val cls = n.className?.toString().orEmpty()
                if (n.isEditable || cls.contains("EditText", ignoreCase = true) || cls.contains("AutoComplete", ignoreCase = true)) {
                    if (n.isFocused) {
                        bestFocused = n
                        break
                    } else if (bestUnfocused == null) {
                        bestUnfocused = n
                    }
                }
            }
            for (i in 0 until n.childCount) {
                n.getChild(i)?.let(queue::addLast)
            }
        }
        return bestFocused ?: bestUnfocused
    }

    private fun findSearchTriggerNode(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val searchBarPattern = Regex(
            """(?i)\b(what are you looking for|what can we help you find|ask rufus or search|search\s+everything|search\s+shipt|search\s+instacart|search\s+walmart|search\s+target|search\s+kroger|search\s+aldi|search\s+amazon|search\s+whole\s+foods|search\s+costco|search\s+sam'?s|search\s+bj'?s|search\s+doordash|search\s+uber\s+eats|search\s+products|search\s+items|search\s+stores|search\s+store|search\s+in\b|find\s+products|find\s+items|find\s+something)\b|^search\b"""
        )
        val searchViewIdPattern = Regex(
            """(?i)(rs_search_src_text|chrome_search_hint_view|search_bar|search_box|search_plate|search_src_text|search_button|search_view|toolbar_search|action_search|menu_search|search_entry|search_field|search_input|search_icon|btn_search|search_text)"""
        )
        val nonTextSearchControlPattern = Regex(
            """(?i)(barcode|scanner|scan\b|voice|mic|microphone|camera|lens|clear|close|back|navigate\s+up|filter|cancel)"""
        )
        val dm = resources.displayMetrics
        val screenH = dm.heightPixels.coerceAtLeast(1280)
        val screenW = dm.widthPixels.coerceAtLeast(720)
        var bestTopSearchBar: AccessibilityNodeInfo? = null
        var bestTopScore = -1
        var bestFallbackSearchTab: AccessibilityNodeInfo? = null

        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        val rect = Rect()
        while (queue.isNotEmpty()) {
            val n = queue.removeFirst()
            if (n.isVisibleToUser) {
                val txt = n.text?.toString()?.trim().orEmpty()
                val desc = n.contentDescription?.toString()?.trim().orEmpty()
                val hint = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    n.hintText?.toString()?.trim().orEmpty()
                } else {
                    ""
                }
                val vid = n.viewIdResourceName?.substringAfterLast('/')?.lowercase().orEmpty()
                n.getBoundsInScreen(rect)

                val combinedLabel = "$txt $desc $hint $vid"
                if (nonTextSearchControlPattern.containsMatchIn(combinedLabel) &&
                    !txt.startsWith("Search ", ignoreCase = true) &&
                    !hint.startsWith("Search ", ignoreCase = true)
                ) {
                    for (i in 0 until n.childCount) {
                        n.getChild(i)?.let(queue::addLast)
                    }
                    continue
                }

                val matchesTextPhrase = searchBarPattern.containsMatchIn(txt) ||
                    searchBarPattern.containsMatchIn(desc) ||
                    searchBarPattern.containsMatchIn(hint)
                val matchesViewId = vid.isNotEmpty() && searchViewIdPattern.containsMatchIn(vid)
                val matchesBar = matchesTextPhrase || matchesViewId

                if (matchesBar && rect.top in 0..(screenH * 0.45f).toInt()) {
                    var score = 0
                    if (matchesTextPhrase) score += 50
                    if (txt.startsWith("Search ", ignoreCase = true) || hint.startsWith("Search ", ignoreCase = true) || desc.startsWith("Search ", ignoreCase = true)) {
                        score += 40
                    }
                    if (rect.width() >= (screenW * 0.35f).toInt()) {
                        score += 30
                    }
                    if (matchesViewId) score += 20
                    if (n.isClickable) score += 10
                    if (score > bestTopScore) {
                        bestTopScore = score
                        bestTopSearchBar = n
                    }
                } else if (bestFallbackSearchTab == null && (matchesBar || txt.equals("Search", ignoreCase = true) || desc.equals("Search", ignoreCase = true))) {
                    bestFallbackSearchTab = n
                }
            }
            for (i in 0 until n.childCount) {
                n.getChild(i)?.let(queue::addLast)
            }
        }
        return bestTopSearchBar ?: bestFallbackSearchTab
    }

    private fun findSearchSubmitOrSuggestionNode(
        root: AccessibilityNodeInfo,
        query: String,
        editBottomY: Int = 0
    ): AccessibilityNodeInfo? {
        val cleanWords = query.lowercase().replace(Regex("[^a-z0-9\\s]"), "").trim().split(Regex("\\s+")).filter { it.length >= 3 }
        val firstWord = cleanWords.firstOrNull().orEmpty()
        val secondWord = cleanWords.getOrNull(1).orEmpty()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        val rect = Rect()
        val dm = resources.displayMetrics
        val density = dm.density.coerceAtLeast(1f)
        val topMinY = if (editBottomY > 0) (editBottomY - (4f * density).toInt()).coerceAtLeast(0) else (dm.heightPixels * 0.08f).toInt()
        val topMaxY = (dm.heightPixels * 0.62f).toInt()
        var bestMatch: AccessibilityNodeInfo? = null

        while (queue.isNotEmpty()) {
            val n = queue.removeFirst()
            if (n.isVisibleToUser && !n.isEditable && n.className?.toString()?.contains("EditText", ignoreCase = true) != true) {
                val txt = n.text?.toString()?.trim().orEmpty()
                val desc = n.contentDescription?.toString()?.trim().orEmpty()
                val labelText = txt.ifBlank { desc }
                n.getBoundsInScreen(rect)
                if (rect.top in topMinY..topMaxY) {
                    val lowTxt = labelText.lowercase().replace("í", "i")
                    // Avoid re-clicking the top search input bar itself
                    val belowSearchBar = if (editBottomY > 0) rect.top >= editBottomY - (4f * density).toInt() else rect.top > (dm.heightPixels * 0.13f).toInt()
                    if (!lowTxt.equals(query.lowercase()) || belowSearchBar) {
                        if (lowTxt.startsWith("search for") ||
                            (firstWord.isNotEmpty() && secondWord.isNotEmpty() && lowTxt.contains(firstWord) && lowTxt.contains(secondWord) && labelText.length <= 105) ||
                            (firstWord.isNotEmpty() && lowTxt.contains(firstWord) && labelText.length <= 95 && belowSearchBar) ||
                            desc.equals("Search", ignoreCase = true)
                        ) {
                            if (lowTxt.startsWith("search for") || (secondWord.isNotEmpty() && lowTxt.contains(secondWord) && belowSearchBar)) {
                                return n
                            }
                            if (bestMatch == null) {
                                bestMatch = n
                            }
                        }
                    }
                }
            }
            for (i in 0 until n.childCount) {
                n.getChild(i)?.let(queue::addLast)
            }
        }
        return bestMatch
    }

    private fun clickNodeOrParent(node: AccessibilityNodeInfo): Boolean {
        var curr: AccessibilityNodeInfo? = node
        var depth = 0
        while (curr != null && depth < 6) {
            if (curr.isClickable && curr.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                return true
            }
            curr = curr.parent
            depth++
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
    }
}
