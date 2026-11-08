package com.cleancart.overlay

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.ArrayDeque
import java.util.concurrent.Executors
import kotlin.math.abs

/**
 * Reads ONLY the product title (and visible ingredient text, if on screen) from the 12
 * supported grocery apps, debounced by 750ms, then posts to /api/scan and hands the result
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
        private const val DEBOUNCE_MS = 420L
        private const val MAX_DEBOUNCE_WAIT_MS = 1100L
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
            """shop all food|rollbacks\s*&\s*more|your favorites,\s*for less|the holiday shop|use walmart\+?\s*gas savings|hosting,\s*decor\s*&\s*more|search results for|featured categories|shop categories|shop by category|shop by department|weekly ad""",
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
            """^(about this item|product details|product information|ingredients|nutrition facts|nutrition information|specifications|at a glance|product description|description|highlights|features|label info|shipping\s*&\s*returns|dietary\s*&\s*lifestyle|disclaimer|warnings|directions|item instructions|from the manufacturer|see customer images and reviews|freshness guarantee|choose a store to see what'?s available|return or replace anytime|100% satisfaction guarantee)$|^visit the [a-z0-9'&.\-\s]{2,40} store$""",
            RegexOption.IGNORE_CASE,
        )
        private val PDP_BODY_BOUNDARY = Regex(
            """^(description|product description|highlights|about this item|product details|product information|specifications|label info|nutrition facts|nutrition information|ingredients\s*[v▼▾⌄+]?\s*:?|from the manufacturer|directions|warnings|disclaimer|legal disclaimer|customer reviews|reviews|ratings\s*&\s*reviews|questions\s*&\s*answers|q\s*&\s*a|showing \d+[-–—]\d+ of [\d,]+ reviews|how do you want your items?\??|your usuals,\s*on your schedule|one-time purchase|shop confidently|4 stars and above|based on customer ratings.*)$""",
            RegexOption.IGNORE_CASE,
        )
        private val CAROUSEL_BOUNDARY = Regex(
            """^(items to add next|similar items?( to consider)?|customers also (bought|viewed|considered)|frequently bought together|often bought with|you might also like|you may also like|sponsored products?|sponsored items?|related items|more from this brand|more to consider|compare with similar( items?)?|recommended for you|items that pair well together)$""",
            RegexOption.IGNORE_CASE,
        )
        private val BRAND_OR_UNIT_ONLY = Regex(
            """^(unbranded|cheerios|panera( bread)?|blount( clam shack)?|campbell'?s|progresso|amy'?s|pacific foods|rao'?s|barilla|martin'?s|gorton'?s|arih|great value|freshness guaranteed|marketside|sam'?s choice|bettergoods|kirkland( signature)?|wellsley farms|berkley jensen|member'?s mark|good\s*&\s*gather|favorite day|market pantry|simple truth|private selection|simply nature|millville|clancy'?s|365( by whole foods market)?|amazon grocery|happy belly|wickedly prime|chobani|yoplait|dannon|stonyfield|horizon|fairlife|hood|lactaid|coffee-mate|kraft|sargento|tillamook|philadelphia|velveeta|heinz|hellmann'?s|hidden valley|primal kitchen|kellogg'?s?|general mills|post|quaker|nature'?s own|sara lee|wonder|dave'?s killer( bread)?|canyon bakehouse|thomas'?|applegate|boar'?s head|oscar mayer|hillshire( farm)?|hormel|jimmy dean|tyson|perdue|foster farms|kerrygold|land o'?lakes|country crock|blue bonnet|dairypure|dairy pure|birds eye|green giant|mccormick|pompeian|de cecco|ball park|oreo|doritos|cheetos|lay'?s|ruffles|pringles|fritos|tostitos|cheez-it|goldfish|ritz|triscuit|wheat thins|keebler|\d+(\.\d+)?\s*(fl\s*oz|oz|lb|lbs|ct|count|pack|gal|gallon|qt|pt|ml|g|kg|ea|dozen)|half gallon|dairy\s*&\s*eggs|bread\s*&\s*bakery|meat\s*&\s*seafood|fresh produce|snacks\s*&\s*candy|beverages|frozen foods?|pantry)$""",
            RegexOption.IGNORE_CASE,
        )
        private val SINGLE_WORD_PRODUCE = Regex(
            """^(banana|bananas|apple|apples|strawberry|strawberries|blueberry|blueberries|raspberry|raspberries|blackberry|blackberries|avocado|avocados|broccoli|spinach|kale|lettuce|romaine|arugula|carrot|carrots|tomato|tomatoes|potato|potatoes|onion|onions|garlic|ginger|parsley|cilantro|basil|celery|cucumber|cucumbers|zucchini|asparagus|mushrooms|orange|oranges|lemon|lemons|lime|limes|grape|grapes|peach|peaches|watermelon|cantaloupe|pineapple|mango|mangoes|pear|pears|plum|plums|kiwi|cabbage|cauliflower)$""",
            RegexOption.IGNORE_CASE,
        )
        private val PROSE_OR_BULLET_NOISE = Regex(
            """\b(is easily|are easily|was bought|we bought|we carry|for your everyday|for your buck|great bang|lock in flavor|contains \d+ (bag|box|pack|can|bottle|jar)s? of|if out of stock|replace with best match|usual items in stock|in stock at|out of stock at|buy in warehouse|join prime to save|prime member price|amazon fresh is not available|choose a store to see|verified purchase|helpful|report abuse|showing \d+[-–—]\d+ of [\d,]+|tasty os|made with care)\b""",
            RegexOption.IGNORE_CASE,
        )
        private val NOISE = Regex(
            """^\$|^\d+(\.\d+)?\s*(ct|count|pack|oz|fl oz|lb|lbs|g|kg|ml|l|ea|gal|gallon|qt|pt|reviews?|ratings?)(\s*/\s*(ea|oz|fl oz|lb|ct))?$|^([-(]?\d+(\.\d+)?[)]?\s*(reviews?|ratings?))$|^\+?\s*add$|^([-(]?\d+(\.\d+)?[)]?|\d[\d,]*|\d+\s*/\s*\d+)$|^shop\s+[a-z0-9'&.\-\s]+$|^visit the [a-z0-9'&.\-\s]+ store$|^item\s*:?\s*#?\d+$|^(flavor|size|style|color|colour|scent|count|pack|pack\s+size|variant|option|type|model|pattern|weight|material)\s*:\s*.+$|^(cart\s*,?\s*\(\d+(\s+items?)?\)|in\s+\d+[km]?\+?\s*people'?s?\s*c(arts?|a.*)|\d+[km]?\+?\s*bought.*|options(\s+from.*)?|(get\s+\$?\d+(\.\d{2})?\s+)?walmart\s+cash.*|manufacturer\s+offer.*|subscribe\s+to\s+save.*|one-time\s+purchase.*|recommended\s+for\s+you.*|items\s+that\s+pair\s+well\s+together.*|trending\s+in\s+.*|\d+\s+stars?\s+and\s+above.*|based\s+on\s+customer\s+ratings.*|roll|rolls|mega\s+rolls?|double\s+rolls?|triple\s+rolls?)$|^((increase|decrease)\s+quantity.*|reserve a time.*|choose a time.*|hide details.*|show details.*|view details.*|don't forget.*|add to (cart|order|basket|bag|favorites|list)|remove from favorites|remove|save for later.*|saved for later.*|add item|buy now|choose options|select options|select (size|flavor|weight|count).*|sign in|search.*|opens?\s+barcode\s+scanner.*|pickup.*|curbside pickup.*|delivery.*|same-day delivery.*|shipping.*|in-club.*|coupons?|double coupons!|clipped|clip coupon.*|express.*|temporarily unavailable|not available.*|available|available deals.*|available for \d+ of \d+ items.*|ready in \d+.*|check nearby clubs|out of stock.*|in stock.*|many in stock|low in stock|only \d+ left.*|ebt eligible|snap ebt.*|tomorrow.*|today.*|\d{1,2}(:\d{2})?\s*(am|pm)?\s*[-–—]\s*\d{1,2}(:\d{2})?\s*(am|pm).*|free with w\+.*|free with walmart\+.*|free with your membership.*|free delivery as soon as.*|always free.*|return or replace.*|change|change\s+(delivery\s+|pickup\s+|shipping\s+)?address.*|choose another address.*|deliver to.*|see all|view all|sponsored|ad|advertisement|overall pick|best seller|popular pick|rollback|free shipping.*|free \d+-day returns.*|free holiday returns.*|free returns at pickup.*|100% satisfaction guarantee.*|freshness guarantee.*|reduced carbon impact.*|see customer images.*|from the manufacturer.*|item instructions.*|add note for shopper.*|arrives between .*|arrives by .*|sold by .*|fulfilled by .*|sold and shipped by .*|shipped by .*|report an issue with seller.*|shop confidently|your usuals,\s*on your schedule.*|save time and stay stocked.*|how it works|pro seller|gift eligible.*|pickup and delivery options.*|fees may apply.*|spend \$?\d+.*|free same-day delivery.*|created with sketch.*|select all|product information|items to add next|shop now|learn more|terms apply|subscribe.*|share|similar items.*|frequently bought.*|often bought with.*|customers also.*|you might also.*|nutrition facts|serving size.*|calories.*|about this item|product details|specifications|at a glance|description|highlights|features|label info|how do you want your items?.*|max\s+\d+\s+per\s+order.*|final\s+cost\s+by\s+weight.*|avg\s+price.*|instant\s+savings.*|ends\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d+.*|really\s+philly\s+good.*|.*\bsam'?s\s+club|grocery|household|fashion|beauty|pharmacy|electronics|auto|home|shop|my items|sparky|services|account|back|close|filter|sort by|reorder|buy again|continue to checkout|proceed to checkout|checkout|checkout all items|estimated total|subtotal|order summary)$|©\s*\d{4}\b|\b(bought since yesterday|try a subscription|bought \d+\+?\s*times?|stay stocked|stay stocked and subscribe|last purchased|usual items in stock|replace with best match|add note for shopper|item may be available in your local warehouse|price may vary|max \d+ per order|final cost by weight|buy in warehouse|join prime|statement credit|amazon fresh is not available|choose a store to see|straight talk|google pixel|pixel \d+a?|iphone \d+|samsung galaxy|tracfone|boost mobile|cricket wireless|total wireless|wireless plan|prepaid phone|onepay|welcome bonus|credit card|report an issue with seller|your usuals,\s*on your schedule|save time and stay stocked|gas savings|walmart\+|walmart cash|manufacturer offer|scan barcodes?|barcode scanner|opens barcode scanner|qr code|preferred address|change delivery address|change address|is this right|aisle\s+[a-z0-9]+|\d+\s*[-–—]\s*\d+\s*min|\d+\s*(hr|hour|min)s?\s+or\s+less|\d{1,2}(:\d{2})?\s*(am|pm)?\s*[-–—]\s*\d{1,2}(:\d{2})?\s*(am|pm)|free with w\+|free with walmart\+)\b|^\d+\s+[a-z]{2,}(?:\s+[a-z]{2,}){0,2}\s+(street|rd|road|drive|ave|avenue|blvd|boulevard|lane|court|place|circle|pkwy|parkway|hwy|highway|terrace|trail)\b|,\s*was$|\?$""",
            RegexOption.IGNORE_CASE,
        )
        private val FOOD_HINTS = Regex(
            """\b(milk|lactaid|fairlife|oatly|malk|califia|silk|soymilk|almondmilk|oatmilk|eggnog|egg nog|yogurt|kefir|cheese|velveeta|macaroni|mac|cheddar|mozzarella|parmesan|provolone|swiss|gouda|feta|ricotta|queso|butter|kerrygold|cream|creamer|sour cream|cottage cheese|eggs?|egg white|bread|bagel|bagels|buns|dinner rolls?|cinnamon rolls?|sweet rolls?|crescent rolls?|hawaiian rolls?|sausage rolls?|pizza rolls?|egg rolls?|bread rolls?|kaiser rolls?|sub rolls?|hoagie rolls?|sandwich rolls?|potato rolls?|tortilla|tortillas|muffin|muffins|donut|donuts|doughnut|doughnuts|bismark|bismarks|pastry|pastries|danish|croissant|croissants|fritter|eclair|strudel|turnover|cupcake|cupcakes|pie|cobbler|chips|crisps|crispy|fried|crackers|crunchmaster|mary'?s gone|wafers|pretzels|popcorn|puffs|cereal|granola|oats|oatmeal|pancake|pancakes|waffle|waffles|french toast|breakfast|syrup|honey|jam|jelly|preserves|marmalade|peanut butter|almond butter|sunflower butter|nutella|ranch|dressing|sauce|gravy|alfredo|pesto|marinara|salsa|ketchup|mustard|mayo|mayonnaise|aioli|relish|tartar|horseradish|hummus|guacamole|tzatziki|dip|olive oil|avocado oil|canola oil|vegetable oil|coconut oil|sesame oil|pompeian|bertolli|vinegar|turkey|chicken|rotisserie|poultry|beef|angus|usda choice|usda prime|steak|ribeye|sirloin|new york strip|strip steak|roast|chuck|tenderloin|brisket|pork|bacon|crumbled bacon|bac'?n|mccormick|sausage|kielbasa|bratwurst|chorizo|meatballs|meatloaf|patties|patty|fillets?|cutlets?|chicken strips?|beef strips?|ham|prosciutto|pancetta|deli|salami|pepperoni|bologna|pastrami|corned beef|hot dogs?|franks?|frankfurters?|wieners?|ball park|nathan'?s|hebrew national|jerky|salmon|tuna|shrimp|scallops|crab|lobster|cod|tilapia|halibut|mahimahi|trout|sardines|anchovies|fish|seafood|juice|tropicana|simply|minute maid|mott'?s|welch'?s|ocean spray|v8|naked|bolthouse|suja|sunnyd|sunny delight|capri sun|kool-aid|hi-c|hawaiian punch|pouches|lemonade|limeade|smoothie|cider|nectar|soda|cola|soda pop|ice pop|pop[- ]?tarts?|root beer|ginger ale|cream soda|sparkling|sports drink|electrolyte|electrolytes|gatorade|powerade|bodyarmor|liquid i\.?v\.?|pedialyte|electrolit|biolyte|nuun|lmnt|nooma|propel|vitaminwater|tea|matcha|chai|yerba mate|guayaki|coffee|cold brew|frappuccino|latte|mocha|nitro|espresso|starbucks|stok|la colombe|chameleon|dunkin|arizona|pure leaf|gold peak|snapple|lipton|brisk|sweet leaf|ito en|honest tea|gt'?s|health-ade|kevita|water|seltzer|club soda|tonic|fiji|evian|essentia|smartwater|life wtr|dasani|aquafina|pure life|ozarka|poland spring|deer park|zephyrhills|ice mountain|arrowhead|crystal geyser|voss|proud source|mountain valley|san pellegrino|pellegrino|perrier|topo chico|gerolsteiner|waterloo|bubly|polar|aha|zuberfizz|nixie|sparkling ice|clear american|kombucha|energy drink|pre-?workout|monster|red bull|redbull|celsius|alani|ghost|c4|cellucor|bang energy|reign|rockstar|prime hydration|prime energy|5-hour|zoa|xyience|nos|full throttle|venom|accelerator|uptime|bum energy|ryse|gorilla mode|bucked up|total war|lit energy|optimum nutrition|amino energy|gold standard|six star|prosupps|hyde|jym|transparent labs|legion|ora organic|core power|premier protein|muscle milk|orgain|owyn|fairlife nutrition|ensure|boost original|boost high protein|boost nutritional|carnations|nesquik|truemoo|yoohoo|cookie|cookies|brownie|brownies|cake|carvel|cake roll|swiss roll|pumpkin|candy|peppermint|mint|mints|chocolate|gummies|gummy|licorice|taffy|caramel|toffee|fudge|marshmallow|marshmallows|fruit|snacks|apple|apples|banana|bananas|strawberry|strawberries|blueberry|blueberries|raspberry|raspberries|blackberry|blackberries|cranberry|cranberries|cherry|cherries|garcia|cherry garcia|half-baked|half baked|chunky monkey|phish food|americone|tonight dough|ben\s*&\s*jerry'?s?|talenti|haagen|breyers|blue bell|halo top|yasso|klondike|drumstick|outshine|sundae|berry|berries|avocado|avocados|spinach|broccoli|florets?|kale|salad|lettuce|romaine|arugula|tomato|tomatoes|potato|potatoes|mashed|idahoan|ore-ida|tater|tots|hash\s*browns?|onion|onions|french'?s|garlic|carrot|carrots|cucumber|cucumbers|pepper|peppers|mushroom|mushrooms|parsley|cilantro|basil|rosemary|thyme|dill|sage|chives|oregano|ginger|celery|cabbage|cauliflower|zucchini|squash|asparagus|artichokes?|beet|beets|radish|turnip|eggplant|okra|corn|peas|edamame|green beans|brussels|vegetables?|veggies?|frozen|steamfresh|birds eye|green giant|medley|orange|oranges|mandarin|clementine|tangerine|grapefruit|grape|grapes|peach|peaches|nectarine|apricot|mango|mangoes|lemon|lemons|lime|limes|melon|watermelon|cantaloupe|honeydew|pineapple|papaya|pomegranate|fig|figs|date|dates|pear|pears|plum|plums|kiwi|coconut|beans|black beans|pinto beans|kidney beans|garbanzo|lentils|chickpeas|rice|quinoa|couscous|barley|farro|pasta|spaghetti|fettuccine|linguine|rigatoni|rotini|macaroni|penne|lasagna|ravioli|tortellini|gnocchi|de cecco|barilla|rao'?s|shells|noodles|ramen|chow mein|udon|soba|soup|chowder|stew|chili|broth|(?:chicken|beef|vegetable|bone|seafood|turkey|fish)\s+stock|bouillon|pizza|flatbread|calzone|burrito|chimichanga|quesadilla|enchilada|taco|taquito|tamale|empanada|dumpling|potsticker|gyoza|spring roll|wonton|hot pocket|hot pockets|morningstar|just bare|nuggets|tenders|fries|wings|poppers|mozzarella sticks|ice cream|gelato|sorbet|sherbet|popsicle|fudge bar|doritos|cheetos|takis|lay'?s|ruffles|pringles|fritos|tostitos|sun chips|sunchips|cape cod|kettle brand|utza?|herr'?s|wise|siete|lesser evil|popcorners|pirate'?s booty|smartfood|skinny pop|skinnypop|boomchickapop|cheez-it|goldfish|ritz|club crackers|town house|saltines|graham crackers|teddy grahams|animal crackers|knoppers|storck|merci|kinder|ferrero|haribo|lindt|ghirardelli|hershey'?s|reese'?s|m&m'?s|snickers|twix|milky way|kit kat|kitkat|butterfinger|skittles|starburst|sour patch|swedish fish|nerds|trolli|airheads|jolly rancher|life savers|werther'?s|wheat thins|triscuit|oreo|chips ahoy|nutter butter|belvita|newton|fig newtons|keebler|little debbie|hostess|entemann'?s|entenmann'?s|sara lee|cheerios|lucky charms|froot loops|cinnamon toast|frosted flakes|honey bunches|raisin bran|special k|rice krispies|cheX|kashi|cascadian farm|magic spoon|catalinacrunch|catalina crunch|nature'?s path|bob'?s red mill|quaker|kodiak|krusteaz|bisquick|birch benders|pearl milling|aunt jemima|mrs\.?\s*butterworth'?s|log cabin|kellogg'?s?|eggo|vans|van'?s|coca-cola|coke|pepsi|dr pepper|mountain dew|mtn dew|sprite|7up|starry|fanta|sunkist|crush|squirt|fresca|canada dry|schweppes|seagram'?s|vernors|a&w|mug|barq'?s|ibc|stewart'?s|jarritos|mexican coke|virgil'?s|zvia|zevia|culture pop|cove|liquid death|olipop|poppi|la croix|lacroix|spindrift|harmless harvest|vita coco|c2o|goya|specially selected|friendly farms|sundae shoppe|belmont|clancy'?s|millville|burman'?s|chef'?s cupboard|l'?oven fresh|park street deli|priano|mama cozzi|dakota'?s pride|happy farms|simply nature|livegfree|elevation|barissimo|benton'?s|choceur|moser roth|southern grove|sweet harvest|savoritz|tuscan garden|stonemill|bake shop|kirkwood|parkview|appleton farms|fremont fish|never any|earth grown|great value|marketside|freshness guaranteed|bettergoods|sam'?s choice|good\s*&\s*gather|favorite day|market pantry|kirkland|wellsley farms|berkley jensen|member'?s mark|simple truth|private selection|365|boar'?s head|oscar mayer|hillshire|hormel|jimmy dean|tyson|perdue|applegate|prego|ragu|classico|hunt'?s|heinz|hellmann'?s|best foods|sweet baby ray'?s|stubb'?s|a\.?1\.?|tabasco|cholula|frank'?s|hidden valley|primal kitchen|kraft|sargento|tillamook|philadelphia|chobani|fage|oikos|siggi'?s|yoplait|dannon|stonyfield|smucker'?s|bonne maman|jif|skippy|justin'?s|rxbar|clif|kind|larabar|nature valley|annie'?s|goodles|banza|diaper|diapers|wipes|disinfecting|tide|gain|persil|downy|purex|detergent|laundry|dawn|palmolive|cascade|dish soap|dish detergent|clorox|lysol|bleach|cleaner|scott|charmin|bounty|angel soft|cottonelle|quilted northern|brawny|sparkle|kleenex|toilet paper|paper towels?|bath tissue|shampoo|conditioner|body wash|shower gel|lotion|moisturizer|sunscreen|deodorant|antiperspirant|toothpaste|mouthwash|soap|cleanser|serum|dove|pantene|olay|old spice|suave|cerave|cetaphil|neutrogena|aveeno|native|colgate|crest|sensodyne|listerine|degree|secret|vaseline|aquaphor|coppertone|banana boat|huggies|pampers|vitamin|protein|collagen|creatine|purina|dog chow|pedigree|friskies|blue buffalo|dog food|cat food|flour|sugar|salt|spice|seasoning|cocoa|baking|yeast|pickle|pickles|olive|olives|tofu|tempeh|seitan|almond|almonds|cashew|cashews|walnut|walnuts|pecan|pecans|pistachio|pistachios|peanut|peanuts|macadamia|hazelnut|trail mix|sunflower seeds|pumpkin seeds|chia|flax|hemp)\b""",
            RegexOption.IGNORE_CASE,
        )
        private val PRICE_PATTERN = Regex("""(\$\s*\d+(\.\d{2}|\s+\d{2})?|\b\d+\s*dollars?(\s*(and\s*)?\d+\s*cents?)?\b)""", RegexOption.IGNORE_CASE)
        private val ADD_TILE_BUTTON = Regex("""^(\+?\s*add|quick add|add item|choose options|\+|increase quantity.*)$""", RegexOption.IGNORE_CASE)
        private val CLUB_ITEM_NUMBER = Regex("""^(item|model|sku)\s*:?\s*#?[a-z0-9\-]+(\s*[|•,/]\s*(item|model|sku)\s*:?\s*#?[a-z0-9\-]+)*$""", RegexOption.IGNORE_CASE)
        private val NON_INGREDIENT_TEXT = Regex(
            """\b(see (product )?packaging|refer to packaging|packaging for current|varies by location|select a store|nutrition facts|serving size|amount per serving|daily value|items to add next|product information|customers also|similar items|you might also|related items|sold by|fulfilled by)\b""",
            RegexOption.IGNORE_CASE,
        )
        private val WHITESPACE = Regex("""\s+""")
        private val LINE_SPLIT = Regex("""[\r\n]+""")
        private val SPONSORED_BADGE = Regex("""^(sponsored(\s+(ad|item|product|brand|result))?|ad|advertisement)(\s*[ⓘℹ(•\-].*)?$""", RegexOption.IGNORE_CASE)
        private val SPONSORED_ANYWHERE = Regex("""\bsponsored\b""", RegexOption.IGNORE_CASE)
    }

    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val rejectedTitles = java.util.Collections.synchronizedSet(LinkedHashSet<String>())
    private var currentPackage = ""
    private var lastKey = ""
    private var overlayVisible = false
    private var pendingSinceMs = 0L
    private var wasOnCartScreen = false
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
        if (lastKey.isEmpty() || lastKey.endsWith("|IDLE_CART_AVG") || lastKey.endsWith("|CART_EMPTY") || lastKey.endsWith("|PDP_SCROLL_HINT")) {
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
                } else if (pkg in STORE_PACKAGES && (lastKey.isEmpty() || lastKey.endsWith("|IDLE_CART_AVG") || lastKey.endsWith("|CART_EMPTY") || lastKey.endsWith("|PDP_SCROLL_HINT"))) {
                    // Automatically re-check if a Product Detail Page finished loading asynchronously without firing an AccessibilityEvent
                    readAndScan()
                }
            }
            if (overlayVisible) handler.postDelayed(this, FOREGROUND_CHECK_MS)
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        // Always reset any dismissed state when the accessibility service connects or is toggled off/on in Settings.
        sendToOverlay(OverlayWindowService.ACTION_RESET_HIDDEN)
        lastKey = ""
        rejectedTitles.clear()
        if (!AccessibilityConsent.granted(this)) {
            sendToOverlay(OverlayWindowService.ACTION_HIDE)
            overlayVisible = false
        } else {
            handler.postDelayed(scanRunnable, 250L)
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
            handler.postDelayed(scrollSettleScanRunnable, 850L)
        }

        if (event.eventType == AccessibilityEvent.TYPE_VIEW_CLICKED) {
            val src = runCatching { event.source }.getOrNull()
            val candidateClickStrings = ArrayList<String>()
            event.text?.forEach { addCandidateStrings(candidateClickStrings, it) }
            addCandidateStrings(candidateClickStrings, event.contentDescription)
            val clickedText = buildString {
                event.text?.forEach { append(it).append(' ') }
                event.contentDescription?.let { append(it).append(' ') }
                if (src != null) {
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
                        addCandidateStrings(candidateClickStrings, ch.text)
                        addCandidateStrings(candidateClickStrings, ch.contentDescription)
                        ch.text?.let { append(it).append(' ') }
                        ch.contentDescription?.let { append(it).append(' ') }
                        recycleNode(ch)
                    }
                    // Walk up to 4 ancestor levels so tapping a product photo inside a nested CardView/Compose node captures the product card's title
                    var ancestor = runCatching { src.parent }.getOrNull()
                    var depth = 0
                    while (ancestor != null && depth < 4) {
                        val curAncestor = ancestor
                        addCandidateStrings(candidateClickStrings, curAncestor.text)
                        addCandidateStrings(candidateClickStrings, curAncestor.contentDescription)
                        for (i in 0 until minOf(curAncestor.childCount, 10)) {
                            val pch = runCatching { curAncestor.getChild(i) }.getOrNull() ?: continue
                            addCandidateStrings(candidateClickStrings, pch.text)
                            addCandidateStrings(candidateClickStrings, pch.contentDescription)
                            recycleNode(pch)
                        }
                        val nextParent = runCatching { curAncestor.parent }.getOrNull()
                        recycleNode(curAncestor)
                        ancestor = nextParent
                        depth++
                    }
                    if (ancestor != null) recycleNode(ancestor)
                }
            }.trim()
            val srcViewId = src?.viewIdResourceName?.lowercase().orEmpty()
            recycleNode(src)

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
                val validClickedCandidates = candidateClickStrings
                    .map { cleanTitleCandidate(it) }
                    .filter { isCandidateProductTitle(it) && FOOD_HINTS.containsMatchIn(it) }
                val clickedProduct = validClickedCandidates
                    .filter { it.split(' ').size >= 3 }
                    .maxByOrNull { it.length }
                    ?: validClickedCandidates.maxByOrNull { it.length }
                if (clickedProduct != null) {
                    lastClickedProductTitle = clickedProduct
                    lastClickedProductPkg = pkg
                    lastClickedProductAtMs = System.currentTimeMillis()
                    rejectedTitles.clear()
                }
            }

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
            rejectedTitles.clear()
            pendingSinceMs = now
            handler.removeCallbacks(scanRunnable)
            handler.removeCallbacks(followUpScanRunnable)
            handler.postDelayed(scanRunnable, 240L)
            handler.postDelayed(followUpScanRunnable, 900L)
            return
        }
        // When waiting on "Scroll down to grade item" (or before any item has been graded), scan rapidly during scroll!
        val waitingForPdpTitle = lastKey.isEmpty() || lastKey.endsWith("|PDP_SCROLL_HINT")
        val debounceMs = if (waitingForPdpTitle) 180L else DEBOUNCE_MS
        val maxWaitMs = if (waitingForPdpTitle) 400L else MAX_DEBOUNCE_WAIT_MS
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

            val rawConfirmedSinglePdp =
                hasExplicitPdpViewId ||
                    hasSinglePdpDetails ||
                    (hasClubItemNumber && tileAddCount < 3) ||
                    (hasSinglePdpCta && tileAddCount <= 1)

            // If the user scrolled down a PDP so far that a bottom carousel ("Recommended for you", "Similar items",
            // "Customers also bought") is now near the top/middle of the viewport and no visible product title remains
            // above the carousel header, grade the visible carousel cards in carousel/feed mode!
            val carouselHasCards = carouselIdx >= 0 && carouselIdx + 1 < nodes.size &&
                nodes.subList(carouselIdx + 1, nodes.size).any {
                    ADD_TILE_BUTTON.matches(it.text.trim()) || it.text.trim().equals("options", ignoreCase = true)
                }
            val visiblePrimaryCandidates = if (carouselIdx >= 0) {
                findCandidateTitles(primaryNodes, emptyList(), isConfirmedSinglePdp = false, pkg = pkg)
            } else {
                emptyList()
            }
            val isViewingFullScreenCarousel =
                carouselHasCards && carouselIdx <= 14 && visiblePrimaryCandidates.isEmpty()

            val isConfirmedSinglePdp = rawConfirmedSinglePdp && !isViewingFullScreenCarousel

            if (!isConfirmedSinglePdp && (hasHomeOrAisleBanners || totalTileAddCount >= 2)) {
                lastConfirmedPdpTitle = null
            }

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
                lastConfirmedPdpTitle = null
                val removedTitles = extractRemovedCartTitles(nodes)
                val cartTitles = extractCartScreenTitles(nodes, removedTitles)
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

            // 2. Grade the product on Product Detail Pages AND vertical/horizontal product card feeds
            val isProductView =
                isConfirmedSinglePdp ||
                    isViewingFullScreenCarousel ||
                    (!hasHomeOrAisleBanners && (hasSinglePdpCta || hasOptionsButtons || totalTileAddCount >= 1))

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
                        !lastKey.contains("|CART|") &&
                        !lastKey.contains("|AISLE_CART|")
                    ) {
                        // Keep the already-graded PDP pill visible even if the user scrolled past the title.
                        return
                    }
                    val scrollHintKey = "$pkg|PDP_SCROLL_HINT"
                    if (lastKey != scrollHintKey) {
                        lastKey = scrollHintKey
                        sendToOverlay(OverlayWindowService.ACTION_PDP_SCROLL_HINT)
                        markVisible()
                    }
                    return
                }

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

            val inCartOnPdp = pendingAddToCartClick || nodes.any { IN_CART_PDP_BADGE.containsMatchIn(it.text) }
            pendingAddToCartClick = false

            val key = "$pkg|$title|${ingredients?.hashCode() ?: 0}|$inCartOnPdp"
            if (key == lastKey) return
            lastKey = key
            inFlightScanKey = key
            inFlightAtMs = System.currentTimeMillis()

            sendToOverlay(OverlayWindowService.ACTION_LOADING) { putExtra(OverlayWindowService.EXTRA_TITLE, title) }
            markVisible()
            val store = ScanApi.storeForPackage(pkg)
            val appContext = applicationContext
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
                    } else if (
                        res.contains("No ingredient list found", ignoreCase = true) ||
                        res.contains("ignored", ignoreCase = true)
                    ) {
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
                        val finalKey = "$pkg|$winningTitle|${ingredients?.hashCode() ?: 0}|$inCartOnPdp"
                        lastKey = finalKey
                        sendToOverlay(OverlayWindowService.ACTION_SHOW_RESULT) {
                            putExtra(OverlayWindowService.EXTRA_JSON, finalJson)
                            putExtra(OverlayWindowService.EXTRA_IN_CART, inCartOnPdp)
                            putExtra(OverlayWindowService.EXTRA_IS_SINGLE_PDP, isConfirmedSinglePdp)
                        }
                    } else if (lastKey == key) {
                        // Reset lastKey to the scroll hint / idle key so the very next scroll event re-scans immediately!
                        lastKey = if (isConfirmedSinglePdp) "$pkg|PDP_SCROLL_HINT" else "$pkg|IDLE_CART_AVG"
                        sendToOverlay(OverlayWindowService.ACTION_SHOW_RESULT) {
                            putExtra(OverlayWindowService.EXTRA_JSON, finalJson)
                            putExtra(OverlayWindowService.EXTRA_IN_CART, inCartOnPdp)
                            putExtra(OverlayWindowService.EXTRA_IS_SINGLE_PDP, isConfirmedSinglePdp)
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
        val edgeMarginPx = (8f * density).toInt()
        val minCardTextWidthPx = (82f * density).toInt()
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
                if (node.isPassword) continue
                val viewId = node.viewIdResourceName?.lowercase().orEmpty()
                val isSearchInput = node.isEditable ||
                    viewId.contains("search_src_text") ||
                    viewId.contains("search_bar_text") ||
                    viewId.endsWith("search_box") ||
                    viewId.endsWith("search_edit_text")
                if (!isSearchInput) {
                    val heading = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && node.isHeading
                    val visible = node.isVisibleToUser
                    node.getBoundsInScreen(rect)
                    val nodeW = rect.width()
                    // Keep invisible nodes ONLY if they are below the fold (`rect.top >= belowFoldThresholdY`, e.g. a PDP
                    // title pushed below the sticky bottom bar by a tall photo). Invisible nodes in the upper half of the
                    // screen are occluded background screens in React Native ScreenStack (like BJ's previous page)!
                    val allowNode = visible || rect.top >= belowFoldThresholdY
                    if (allowNode) {
                        val isEdgeClipped = visible && (
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
                    }
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
        // Never strip "Removed: <Product>" snackbar messages into valid titles — they are handled by extractRemovedCartTitles
        if (s.matches(Regex("""(?i)^(removed|moved to saved for later|saved for later)\s*:.*"""))) {
            return ""
        }
        // Strip leading checkmarks (e.g. "✓ Bought 5+ times, stay stocked and subscribe")
        s = s.replace(Regex("""^[✓✔☑]\s*"""), "")
        // Unwrap action/image contentDescriptions on PDP buttons & hero images (e.g. "Add Great Value Whole Vitamin D Milk to cart", "Product image 1 of 6, Great Value Whole Vitamin D Milk")
        s = s.replace(Regex("""(?i)^(?:add|save|remove|delete)\s+(.{5,}?)\s+(?:to|from)\s+(?:cart|bag|basket|order|favorites|list|my\s+items|registry).*$"""), "$1")
        s = s.replace(Regex("""(?i)^(?:add\s+to\s+(?:cart|bag|basket|order|favorites|list)|save\s+to\s+(?:list|favorites|my\s+items)|saved\s+to\s+(?:list|favorites|my\s+items)|favorited|share)\s*[,:•|\-–—]\s*(?=[a-zA-Z]{2,})"""), "")
        s = s.replace(Regex("""(?i)^(?:product\s+)?(?:image|photo)\s*(?:\d+\s*(?:of|/)\s*\d+)?\s*[,:•|\-–—]\s*(?=[a-zA-Z]{2,})"""), "")
        // Strip leading/embedded favorite/badge/quantity prefixes from compound container contentDescriptions
        s = s.replace(Regex("""(?i)^.*?\b(remove from favorites|add to favorites|remove from my items|add to my items)\s*[,•|\-]?\s*"""), "")
        s = s.replace(Regex("""(?i)^(remove|delete)\s+(?=[a-z0-9].*\s+[a-z0-9])"""), "")
        s = s.replace(Regex("""(?i)^\d+\s+in\s+(cart|bag|basket|order)\s*[-–—:,]?\s*"""), "")
        s = s.replace(Regex("""(?i)^(quantity|qty)\s*:?\s*\d+\s*[,:•|\-]?\s*"""), "")
        // Strip embedded reorder/popularity/badge tokens whether separated by commas, bullets, periods, or spaces
        // (Do NOT strip "sponsored" here so compound sponsored banner strings are rejected by isCandidateProductTitle)
        s = s.replace(Regex("""(?i)[✓✔☑]?\s*\bbought\s+\d+\+?\s*times?(?:\s*,?\s*stay\s+stocked(?:\s+and\s+subscribe)?)?\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\blast\s+purchased(?:\s+on)?\s+[a-z]+\s+\d{1,2}(?:\s*,\s*\d{4})?\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\b\d+[km]?\+?\s*bought\s+since\s+yesterday(?:\s*,?\s*try\s+a\s+subscription)?\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\btry\s+a\s+subscription\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\b(best\s+seller|overall\s+pick|popular\s+pick|rollback|save\s+for\s+later|subscribe\s+to\s+save|instant\s+savings|shop\s+similar|final\s+cost\s+by\s+weight|avg\s+price)(?:\s*[ⓘℹ])?\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\bprice\s+may\s+vary(?:\s+in\s+club\s+and\s+online)?(?:\s*[ⓘℹ])?\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\bmax\s+\d+\s+per\s+order\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\bends\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:\s*,\s*\d{4})?(?:\s*[ⓘℹ])?\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\b(get\s+\$?\d+(?:\.\d{2})?\s+)?walmart\s+cash\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\bmanufacturer\s+offer\s*[,•|\-.]?"""), " ")
        s = s.replace(Regex("""(?i)\bfree\s+\d+-day\s+returns(?:\s*[ⓘℹ>])?\s*[,•|\-.]?"""), " ")
        // Strip ratings, review counts, ". Based on ..." rating accessibility suffixes, image carousel counters, EBT badges, item numbers, and prices
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*\b(item|model|sku)\s*:?\s*#?\d+\b"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*\bsnap\s+ebt(\s+eligible)?\b"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*(?:[★☆⭐]+\s*)?(?:rated\s+)?\d+(?:\.\d+)?\s*out\s+of\s*5(?:\s*stars?)?(?:\s*[,•|\-.]?\s*\bbased\s+on\b.*|\s*[,•|\-]?\s*\d[\d,]*\s*(?:reviews?|ratings?))?"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*(?:[★☆⭐]+\s*)?\(\d+(?:\.\d+)?\)\s*(?:\|\s*)?\d[\d,]*(?:\s*(?:reviews?|ratings?))?"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*\b\d[\d,]*\s*(?:reviews?|ratings?)\b"""), " ")
        s = s.replace(Regex("""(?i)\s*[.,•|\-]?\s*\bbased\s+on(?:\s+[\d,]+\s+ratings?|\s+customer\s+ratings?|\s+star\s+ratings?)?\b.*$"""), "")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*(?:product\s+)?(?:image|photo)\s+\d+\s+(?:of|/)\s+\d+"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*(?:current\s+price\s*|price\s*|now\s*|was\s*)?\$\s*\d+(?:\.\d{2}|\s+\d{2})?(?:\s+off\b|\s*/\s*(?:ea|oz|fl\s*oz|lb|ct|pt|qt|gal))?"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*(?:current\s+price\s*|price\s*|now\s*|was\s*)?\b\d+\s*dollars?(?:\s*(?:and\s*)?\d+\s*cents?)?(?:\s*(?:/|per)\s*(?:ea|each|oz|fl\s*oz|lb|ct|count|pt|qt|gal))?\b"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*\bprice\s+when\s+purchased\s+online(?:\s*[ⓘℹ])?"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]?\s*\d+(?:\.\d+)?\s*(?:¢|cents?)\s*(?:/|per)\s*(?:oz|fl\s*oz|lb|ea|each|ct|count|pt|qt|gal|\d+\s*ct)\b"""), " ")
        s = s.replace(Regex("""(?i)\s*[,•|\-]\s*(now|was|current\s+price|price|add)\s*$"""), "")
        s = s.replace(Regex("""(?i)^\+?\s*add\s*[,•|\-]?\s*"""), "")
        // Strip truncated trailing weight fragments from narrow carousel cards (e.g. "Martin's Potato Sandwich Rolls, 9...")
        s = s.replace(Regex("""\s*,\s*\d+\s*(?:\.\.\.+|…)\s*$"""), "")
        s = s.replace(WHITESPACE, " ").trim(' ', ',', '•', '|', '-', '.', 'ⓘ', 'ℹ')
        // Deduplicate repeated leading 1–3 word brand prefix when a merged PDP header includes both the brand link ("Great Value") and the full title ("Great Value Whole Vitamin D Milk, Gallon")
        s = s.replace(Regex("""(?i)^([a-z0-9'&]+(?:\s+[a-z0-9'&]+){0,2})\s*[,•|\-]?\s+\1\b"""), "$1")
        return s.trim(' ', ',', '•', '|', '-', '.', 'ⓘ', 'ℹ')
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
            t.lowercase() !in rejectedTitles &&
            !SPONSORED_ANYWHERE.containsMatchIn(t) &&
            !PROSE_OR_BULLET_NOISE.containsMatchIn(t) &&
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
        val preBodyAllNodes = if (allBodyBoundaryIdx >= 0) allNodes.subList(0, allBodyBoundaryIdx) else allNodes

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
        val searchNodes = if (orphanedTopCtaIdx >= 0 && !hasTitleBeforeOrphanCta && orphanedTopCtaIdx + 1 < preBodyNodes.size) {
            preBodyNodes.subList(orphanedTopCtaIdx + 1, preBodyNodes.size)
        } else {
            preBodyNodes
        }

        // 1. Explicit product title viewId on the visible product page
        for (n in searchNodes) {
            val c = cleanTitleCandidate(n.text)
            if (isCandidateProductTitle(c) && TITLE_ID_HINTS.any { n.viewId.contains(it) }) {
                addCandidate(c)
            }
        }

        // 2. Accessibility heading on the visible page that matches food/product hints (including 1-word produce like "Raspberries")
        for (n in searchNodes) {
            val c = cleanTitleCandidate(n.text)
            if (n.isHeading && isCandidateProductTitle(c) && FOOD_HINTS.containsMatchIn(c)) {
                addCandidate(c)
            }
        }

        // 3. Visible multi-word nodes containing recognizable grocery/household keywords
        val maxSearchNodes = if (isConfirmedSinglePdp) searchNodes.size else minOf(searchNodes.size, 110)
        if (isConfirmedSinglePdp) {
            for (n in searchNodes.take(maxSearchNodes)) {
                val c = cleanTitleCandidate(n.text)
                if (isCandidateProductTitle(c) && c.split(' ').size >= 2 && FOOD_HINTS.containsMatchIn(c)) {
                    addCandidate(c)
                }
            }
        } else {
            val density = resources.displayMetrics.density.coerceAtLeast(1f)
            val rowBandPx = (140f * density).toInt().coerceAtLeast(1)
            data class CarouselCandidate(val node: TextNode, val cleaned: String, val width: Int, val rowBand: Int)
            val rawCandidates = ArrayList<CarouselCandidate>()
            for (n in searchNodes.take(maxSearchNodes)) {
                val c = cleanTitleCandidate(n.text)
                if (isCandidateProductTitle(c) && c.split(' ').size >= 2 && FOOD_HINTS.containsMatchIn(c)) {
                    if (rawCandidates.none { it.cleaned.equals(c, ignoreCase = true) }) {
                        val w = (n.right - n.left).coerceAtLeast(0)
                        val band = if (n.top > 0) n.top / rowBandPx else 0
                        rawCandidates.add(CarouselCandidate(n, c, w, band))
                    }
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
                    val maxW = maxWidthByBand[rc.rowBand] ?: 0
                    // When a card in a horizontal carousel slides partially off the left or right edge,
                    // Android clamps getBoundsInScreen(rect) to the viewport so its visible width shrinks
                    // compared to the full card next to it!
                    return maxW >= (110f * density).toInt() && rc.width < (maxW * 0.82f).toInt()
                }
                val sorted = rawCandidates.sortedWith(
                    compareBy<CarouselCandidate> { isPartiallyClippedInRow(it) }
                        .thenBy { it.rowBand }
                        .thenBy { it.node.left }
                        .thenBy { it.node.index }
                ).toMutableList()

                // If 2 unclipped cards sit side-by-side in the top visual row and the left card (`c0`) was ALREADY
                // graded while the user just scrolled right (or `c0` shifted left), promote `c1` (the right card)
                // so sliding across a 2-up carousel immediately grades the newly revealed item!
                if (sorted.size >= 2) {
                    val c0 = sorted[0]
                    val c1 = sorted[1]
                    val sameTopRow = c0.rowBand == c1.rowBand && !isPartiallyClippedInRow(c0) && !isPartiallyClippedInRow(c1)
                    if (sameTopRow && c1.node.left > c0.node.left + (48f * density).toInt()) {
                        val now = System.currentTimeMillis()
                        val scrolledRightRecently = lastHorizontalScrollDir > 0 && now - lastHorizontalScrollAtMs <= 2600L
                        val shiftedLeft = lastRowLeadTitle != null &&
                            lastRowLeadTitle.equals(c0.cleaned, ignoreCase = true) &&
                            lastRowLeadLeftX > 0 &&
                            c0.node.left < lastRowLeadLeftX - (16f * density).toInt()
                        if ((scrolledRightRecently || shiftedLeft) &&
                            lastRowGradedTitle != null &&
                            lastRowGradedTitle.equals(c0.cleaned, ignoreCase = true)
                        ) {
                            sorted[0] = c1
                            sorted[1] = c0
                        }
                        lastRowLeadTitle = c0.cleaned
                        lastRowLeadLeftX = c0.node.left
                    }
                }
                for (sc in sorted) {
                    addCandidate(sc.cleaned)
                }
            }
        }

        // 4. Single-word produce title (e.g. "Raspberries", "Strawberries", "Bananas", "Avocados", "Parsley" in ALDI)
        // Strictly restricted to SINGLE_WORD_PRODUCE so 1-word packaged brand logos ("Cheerios", "Velveeta") are never matched!
        for (n in searchNodes.take(maxSearchNodes)) {
            val c = cleanTitleCandidate(n.text)
            if (isCandidateProductTitle(c) && SINGLE_WORD_PRODUCE.matches(c.trim())) {
                addCandidate(c)
            }
        }

        // 5. Below-the-fold PDP nodes (`preBodyAllNodes` includes below-the-fold `isVisible == false` nodes inside the PDP ScrollView
        // that were pushed just below the sticky "$2.78 Add to cart" bar by a tall 1:1 product photo and "Bought 5+ times" banner!).
        // ONLY run when `isConfirmedSinglePdp && out.isEmpty()` so hidden nodes never compete with a visible product title!
        if (isConfirmedSinglePdp && out.isEmpty() && preBodyAllNodes.isNotEmpty()) {
            for (n in preBodyAllNodes) {
                val c = cleanTitleCandidate(n.text)
                if (isCandidateProductTitle(c) && TITLE_ID_HINTS.any { n.viewId.contains(it) }) {
                    addCandidate(c)
                }
            }
            for (n in preBodyAllNodes) {
                val c = cleanTitleCandidate(n.text)
                if (n.isHeading && isCandidateProductTitle(c) && FOOD_HINTS.containsMatchIn(c)) {
                    addCandidate(c)
                }
            }
            for (n in preBodyAllNodes) {
                val c = cleanTitleCandidate(n.text)
                if (isCandidateProductTitle(c) && c.split(' ').size >= 2 && FOOD_HINTS.containsMatchIn(c)) {
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
