/**
 * Brand-Neutral Studio Category Art & Brand-Letter Tile Fallbacks
 * ----------------------------------------------------------------
 * Isomorphic module (safe in both Server and Client components).
 *
 * Visual Hierarchy:
 *   1. "photo" / "store-photo" — Real product package photo (Open Food Facts or device-local store DOM).
 *   2. "category-art"          — Brand-neutral studio photograph in `public/swaps/*` with an explicit
 *                                "Illustration" badge so shoppers never confuse studio food art with a
 *                                specific brand's package.
 *   3. "none"                  — Crisp Brand-Letter Tile for non-food items or unclassifiable queries.
 */

export type ImageKind = "photo" | "store-photo" | "category-art" | "none";

const NON_FOOD_OR_APPLIANCE_RE =
  /\b(?:\d{2,4}\s*w\b|watts?\b|quesadilla\s+maker|waffle\s+maker|coffee\s+maker|espresso\s+machine|air\s+fryer|slow\s+cooker|pressure\s+cooker|rice\s+cooker|toaster(?:\s+oven)?(?!\s+pastr(?:y|ies))|blender|food\s+processor|stand\s+mixer|hand\s+mixer|microwave|electric\s+kettle|griddle|skillet|frying\s+pan|saucepan|cookware|bakeware|spatula|tongs|cutting\s+board|storage\s+containers?|food\s+wrap|aluminum\s+foil|parchment\s+paper|zip\s*top\s+bags?|freezer\s+bags?|trash\s+bags?|garbage\s+bags?|paper\s+towels?|toilet\s+paper|bath\s+tissue|facial\s+tissue|napkins|paper\s+plates|plastic\s+cups|laundry\s+detergent|fabric\s+softener|dryer\s+sheets?|dish\s+soap|dishwasher\s+pods?|bleach|disinfectant|surface\s+cleaner|glass\s+cleaner|sponges?|shampoo|conditioner|body\s+wash|face\s+wash|cleanser|moisturizer|lotion|sunscreen|spf\s*\d+|deodorant|antiperspirant|toothpaste|mouthwash|dental\s+floss|toothbrush|razors?|shaving\s+cream|diapers?|baby\s+wipes|tampons?|sanitary\s+pads?|cat\s+litter|dog\s+toy|pet\s+bed|collar|leash|alkaline\s+batter(?:y|ies)|aa\s+batteries|aaa\s+batteries|usb[- ]?c|charging\s+cable|light\s+bulbs?|candles?|air\s+freshener)\b/i;

const FOOD_INGREDIENT_SIGNAL_RE =
  /\b(?:water|sugar|salt|flour|milk|cream|oil|butter|corn|wheat|rice|oats?|soy|cocoa|chocolate|cheese|egg|chicken|beef|pork|turkey|tomato|citric\s+acid|natural\s+flavors?|vinegar|spices?|yeast|honey|syrup|juice|tea|coffee|beans?|peanuts?|almonds?|cashews?)\b/i;

/**
 * Ordered high-specificity Open Food Facts `categories_tags` rules -> `/swaps/<studio-file>`.
 */
const OFF_TAG_TO_STUDIO_ART: ReadonlyArray<readonly [RegExp, string]> = [
  [/baby-foods|infant-formulas|baby-purees/i, "/swaps/baby-food.png"],
  [/energy-drinks/i, "/swaps/energy-drink.png"],
  [/protein-shakes|meal-replacements/i, "/swaps/protein-shake.png"],
  [/coffee-creamers/i, "/swaps/creamer.png"],
  [/coffees|cold-brews|iced-coffees/i, "/swaps/coffee.png"],
  [/teas|iced-teas|herbal-teas|kombuchas|yerba-mate/i, "/swaps/tea.png"],
  [/waters|spring-waters|mineral-waters|flavored-waters|sparkling-waters/i, "/swaps/water.png"],
  [/sodas|colas|carbonated-soft-drinks/i, "/swaps/soda.png"],
  [/juices|fruit-juices|nectars|smoothies/i, "/swaps/juice.png"],
  [/sports-drinks|electrolyte/i, "/swaps/drink.png"],
  [/peanut-butters|nut-butters|almond-butters|seed-butters/i, "/swaps/peanutbutter.png"],
  [/jams|jellies|marmalades|fruit-spreads/i, "/swaps/jam.png"],
  [/honeys|maple-syrups|syrups/i, "/swaps/syrup.png"],
  [/ketchups/i, "/swaps/ketchup.png"],
  [/mustards/i, "/swaps/mustard.png"],
  [/mayonnaises/i, "/swaps/mayo.png"],
  [/barbecue-sauces/i, "/swaps/bbq.png"],
  [/ranch-dressings|salad-dressings/i, "/swaps/ranch.jpg"],
  [/salsas|pico-de-gallo/i, "/swaps/salsa.png"],
  [/pasta-sauces|marinara|tomato-sauces/i, "/swaps/marinara.png"],
  [/hot-sauces|relishes|condiments|sauces/i, "/swaps/condiments.png"],
  [/olive-oils|avocado-oils|vegetable-oils|cooking-oils|vinegars/i, "/swaps/oil-vinegar.png"],
  [/spices|seasonings|herbs-and-spices|culinary-herbs/i, "/swaps/spices.png"],
  [/popcorn/i, "/swaps/popcorn.png"],
  [/tortilla-chips|potato-chips|crisps|chips-and-fries/i, "/swaps/chips.jpg"],
  [/crackers|puff-pastries/i, "/swaps/crackers.jpg"],
  [/cookies|biscuits/i, "/swaps/cookies.png"],
  [/chocolates|dark-chocolates|milk-chocolates|cocoa/i, "/swaps/chocolate.png"],
  [/candies|gummies|confectioneries|sweets/i, "/swaps/candy.png"],
  [/cereal-bars|fruit-bars|energy-bars|snack-bars/i, "/swaps/fruitbar.png"],
  [/nuts|almonds|cashews|walnuts|pecans|pistachios|seeds|trail-mix/i, "/swaps/nuts-seeds.png"],
  [/oatmeals|rolled-oats|porridges/i, "/swaps/oats.png"],
  [/breakfast-cereals|granola|mueslis/i, "/swaps/cereal.jpg"],
  [/waffles|pancakes/i, "/swaps/waffles.png"],
  [/bagels/i, "/swaps/bagels.png"],
  [/tortillas|wraps|flatbreads/i, "/swaps/tortillas.png"],
  [/hamburger-buns|hot-dog-buns|rolls/i, "/swaps/buns.png"],
  [/croissants|muffins|pastries|cakes|donuts|bakery/i, "/swaps/bakery.png"],
  [/breads/i, "/swaps/bread.jpg"],
  [/yogurts|greek-yogurts|skyr|kefir/i, "/swaps/yogurt.jpg"],
  [/ice-creams|frozen-desserts|sorbets|gelato/i, "/swaps/icecream.png"],
  [/butters|margarines|ghee/i, "/swaps/butter.jpg"],
  [/cheeses|mozzarella|cheddar|parmesan/i, "/swaps/cheese.png"],
  [/milks|plant-milks|oat-milks|almond-milks|soy-milks/i, "/swaps/milk.png"],
  [/eggs/i, "/swaps/eggs.png"],
  [/bacons/i, "/swaps/bacon.png"],
  [/hot-dogs|frankfurters/i, "/swaps/hotdog.png"],
  [/sausages|chorizo|bratwurst/i, "/swaps/sausage.png"],
  [/chicken-nuggets|breaded-chicken/i, "/swaps/nuggets.png"],
  [/turkeys|deli-meats|cold-cuts|hams|salamis/i, "/swaps/turkey.jpg"],
  [/beef|steaks|ground-beef|burgers/i, "/swaps/beef.png"],
  [/fishes|salmons|tunas|seafood|shrimps/i, "/swaps/fish.png"],
  [/pizzas/i, "/swaps/pizza.png"],
  [/macaroni-and-cheese/i, "/swaps/mac.png"],
  [/frozen-meals|frozen-dinners|prepared-meals|entrees/i, "/swaps/frozen-meal.png"],
  [/broths|stocks|bone-broths/i, "/swaps/broth.png"],
  [/soups|chowders|chilis/i, "/swaps/soup.png"],
  [/pastas|noodles|spaghetti|ramen/i, "/swaps/pasta.png"],
  [/legumes|beans|lentils|chickpeas|quinoa|rices|grains/i, "/swaps/beans-grains.png"],
  [/fruits|vegetables|salads|spinach|produce/i, "/swaps/produce.png"],
  [/snacks/i, "/swaps/snacks.jpg"],
];

/**
 * Ordered high-precision product title/category keyword rules -> `/swaps/<studio-file>`.
 * Note: Specific compounds (e.g., "peanut butter", "mac & cheese", "chicken nuggets", "coffee creamer")
 * MUST precede generic base nouns ("butter", "cheese", "chicken", "coffee").
 */
const TITLE_TO_STUDIO_ART: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:baby\s+food|gerber|1st\s+foods|2nd\s+foods|infant\s+formula|toddler\s+puree|baby\s+puree)\b/i, "/swaps/baby-food.png"],
  [/\b(?:peanut\s+butter|almond\s+butter|cashew\s+butter|sunflower\s+(?:seed\s+)?butter|sunbutter|nut\s+butter)\b/i, "/swaps/peanutbutter.png"],
  [/\b(?:coffee\s+creamer|liquid\s+creamer|dairy\s+creamer|oat\s+creamer|almond\s+creamer|superfood\s+creamer|non[- ]?dairy.*creamer|coffee[- ]?mate|international\s+delight|nutpods|half\s*(?:&|and)\s*half|\bcreamer\b)\b/i, "/swaps/creamer.png"],
  [/\b(?:protein\s+shake|protein\s+powder|whey\s+protein|plant\s+protein|core\s+power|premier\s+protein|muscle\s+milk|orgain.*shake|fairlife.*nutrition\s+plan|meal\s+replacement\s+shake)\b/i, "/swaps/protein-shake.png"],
  [/\b(?:energy\s+drink|energy\s+shot|5[- ]?hour\s+energy|five\s+hour\s+energy|pre[- ]?workout|monster\s+energy|red\s*bull|celsius|c4\s+(?:energy|performance)|ghost\s+energy|alani\s+nu|reign\b|rockstar\s+energy|bang\s+energy|zumbal)\b/i, "/swaps/energy-drink.png"],
  [/\b(?:cold\s+brew|frappuccino|espresso|roast\s+coffee|ground\s+coffee|instant\s+coffee|iced\s+coffee|\bcoffee\b)\b/i, "/swaps/coffee.png"],
  [/\b(?:iced\s+tea|green\s+tea|black\s+tea|herbal\s+tea|chamomile|earl\s+grey|matcha|chai\s+latte|yerba\s+mate|kombucha|\btea\b)\b/i, "/swaps/tea.png"],
  [/\b(?:sparkling\s+water|spring\s+water|mineral\s+water|purified\s+(?:drinking\s+)?water|artesian\s+water|alkaline\s+water|seltzer|spindrift|lacroix|topo\s+chico|liquid\s+death|coconut\s+water|\bwater\b)\b/i, "/swaps/water.png"],
  [/\b(?:orange\s+juice|apple\s+juice|cranberry\s+juice|grape\s+juice|lemonade|limeade|fruit\s+punch|tropical\s+punch|citrus\s+punch|hawaiian\s+punch|kool[- ]?aid|drink\s+pouches?|capri\s*sun|sunny\s*d|juice\s+drink|smoothie|\bjuice\b)\b/i, "/swaps/juice.png"],
  [/\b(?:sports\s+drink|electrolyte|hydration\s+drink|thirst\s+quencher|gatorade|powerade|bodyarmor|liquid\s*i\.?v\.?|pedialyte|prime\s+hydration|nooma)\b/i, "/swaps/drink.png"],
  [/\b(?:soda|cola|coca[- ]?cola|pepsi|diet\s+coke|mountain\s+dew|mtn\s+dew|dr\s+pepper|sprite|7\s*up|root\s+beer|ginger\s+ale|fanta|sunkist|olipop|poppi|prebiotic\s+soda)\b/i, "/swaps/soda.png"],
  [/\b(?:mac(?:aroni)?\s*(?:&|and)\s*cheese|shells?\s*(?:&|and)\s*(?:white\s+)?cheddar|velveeta\s+shells|easy\s+mac)\b/i, "/swaps/mac.png"],
  [/\b(?:pizza|flatbread\s+pizza|pizza\s+rolls?|digiorno|red\s+baron|totino'?s)\b/i, "/swaps/pizza.png"],
  [/\b(?:frozen\s+(?:meal|dinner|entree|bowl|stuffed\s+sandwich)|stuffed\s+sandwich.*entree|\bentrees?\b|burrito\s+bowl|power\s+bowl|lean\s+cuisine|healthy\s+choice|stouffer'?s|marie\s+callender'?s|banquet|hungry[- ]?man|lasagna|pot\s+pie|taquitos?|chimichangas?|hot\s+pockets?)\b/i, "/swaps/frozen-meal.png"],
  [/\b(?:chicken\s+nuggets?|chicken\s+tenders?|chicken\s+strips?|chicken\s+bites?|chicken\s+patties|popcorn\s+chicken|dino\s+buddies)\b/i, "/swaps/nuggets.png"],
  [/\b(?:hot\s*dogs?|franks?|frankfurters?|wieners?)\b/i, "/swaps/hotdog.png"],
  [/\b(?:bacon|turkey\s+bacon)\b/i, "/swaps/bacon.png"],
  [/\b(?:sausages?|bratwurst|kielbasa|chorizo|breakfast\s+links?)\b/i, "/swaps/sausage.png"],
  [/\b(?:ground\s+beef|beef\s+patt(?:y|ies)|burger\s+patt(?:y|ies)|plant[- ]?based\s+patt(?:y|ies)|veggie\s+burgers?|angus\s+beef|ribeye|sirloin|chuck\s+roast|roast\s+beef|beef\s+jerky|\bsteak\b|\bbeef\b)\b/i, "/swaps/beef.png"],
  [/\b(?:salmon|tuna|tilapia|cod|halibut|mahimahi|shrimp|fish\s+sticks?|fish\s+fillets?|sardines|crab)\b/i, "/swaps/fish.png"],
  [/\b(?:turkey|ham\b|salami|pepperoni|bologna|prosciutto|deli\s+meat|lunch\s*meat|rotisserie(?:\s+whole)?\s+chicken|whole\s+chicken|chicken\s+breast)\b/i, "/swaps/turkey.jpg"],
  [/\b(?:bone\s+broth|chicken\s+broth|beef\s+broth|vegetable\s+broth|chicken\s+stock|beef\s+stock|\bbroth\b|\bgravy\b)\b/i, "/swaps/broth.png"],
  [/\b(?:soup|clam\s+chowder|corn\s+chowder|tomato\s+bisque|ramen\s+noodle\s+soup|\bchili\b)\b/i, "/swaps/soup.png"],
  [/\b(?:marinara|pasta\s+sauce|tomato\s+basil\s+sauce|vodka\s+sauce|alfredo\s+sauce|spaghetti\s+sauce|pizza\s+sauce)\b/i, "/swaps/marinara.png"],
  [/\b(?:salsa|pico\s+de\s+gallo|guacamole|queso\s+dip|hummus)\b/i, "/swaps/salsa.png"],
  [/\b(?:ranch\s+dressing|caesar\s+dressing|italian\s+dressing|vinaigrette|salad\s+dressing|\branch\b)\b/i, "/swaps/ranch.jpg"],
  [/\b(?:mayonnaise|\bmayo\b|vegise|aioli)\b/i, "/swaps/mayo.png"],
  [/\b(?:ketchup|catsup)\b/i, "/swaps/ketchup.png"],
  [/\b(?:mustard|dijon)\b/i, "/swaps/mustard.png"],
  [/\b(?:bbq\s+sauce|barbecue\s+sauce|steak\s+sauce|teriyaki\s+sauce|soy\s+sauce|tamari|worcestershire)\b/i, "/swaps/bbq.png"],
  [/\b(?:hot\s+sauce|sriracha|tabasco|cholula|frank'?s\s+redhot|buffalo\s+sauce|relish|pickles?|olives?\b|wasabi|sauerkraut|kimchi|horseradish|tartar\s+sauce|cocktail\s+sauce)\b/i, "/swaps/condiments.png"],
  [/\b(?:olive\s+oil|avocado\s+oil|coconut\s+oil|canola\s+oil|vegetable\s+oil|sesame\s+oil|cooking\s+spray|apple\s+cider\s+vinegar|balsamic\s+vinegar|white\s+vinegar)\b/i, "/swaps/oil-vinegar.png"],
  [/\b(?:seasoning|spice|cinnamon|paprika|turmeric|cumin|oregano|garlic\s+powder|onion\s+powder|black\s+pepper|sea\s+salt|pink\s+salt|taco\s+seasoning|vanilla\s+extract)\b/i, "/swaps/spices.png"],
  [/\b(?:jam\b|jelly\b|(?:fruit|strawberry|raspberry|blueberry|berry|apricot|grape|fig)\s+spread|preserves|marmalade|uncrustables?)\b/i, "/swaps/jam.png"],
  [/\b(?:maple\s+syrup|pancake\s+syrup|agave\s+nectar|\bhoney\b)\b/i, "/swaps/syrup.png"],
  [/\b(?:popcorn|kettle\s+corn|skinny\s*pop|smartfood|boomchickapop)\b/i, "/swaps/popcorn.png"],
  [/\b(?:tortilla\s+chips?|potato\s+chips?|kettle\s+chips?|corn\s+chips?|veggie\s+straws?|pita\s+chips?|plantain\s+chips?|french\s+fries|crinkle\s+fries|golden\s+crinkles|tater\s+tots|hash\s+browns|doritos|fritos|cheetos|pringles|lay'?s|ruffles|tostitos|takis|siete.*chips?|\bchips\b)\b/i, "/swaps/chips.jpg"],
  [/\b(?:crackers?|rice\s+cakes?|goldfish|cheez[- ]?it|ritz|triscuit|wheat\s+thins|saltines|graham\s+crackers?|pretzels?)\b/i, "/swaps/crackers.jpg"],
  [/\b(?:cookies?|oreos?|chips\s+ahoy|shortbread|biscotti|wafers?)\b/i, "/swaps/cookies.png"],
  [/\b(?:chocolate|cocoa|brownie|fudge|nutella|hazelnut\s+spread|reese'?s|hershey'?s|m&m'?s|snickers|twix|kit\s*kat|truffles?)\b/i, "/swaps/chocolate.png"],
  [/\b(?:gummies|gummy|fruit\s+snacks?|candy|candies|skittles|starburst|sour\s+patch|swedish\s+fish|jelly\s+beans?|licorice|lollipops?|mints?|chewing\s+gum|marshmallows?)\b/i, "/swaps/candy.png"],
  [/\b(?:fruit\s+bars?|granola\s+bars?|protein\s+bars?|snack\s+bars?|energy\s+bars?|nut\s+bars?|larabar|lärabar|rxbar|clif\s+bar|kind\s+bar|nature\s+valley|that'?s\s+it)\b/i, "/swaps/fruitbar.png"],
  [/\b(?:almonds?|cashews?|walnuts?|pecans?|pistachios?|macadamia|mixed\s+nuts|peanuts?|pumpkin\s+seeds?|sunflower\s+seeds?|chia\s+seeds?|flax\s*seeds?|hemp\s+hearts?|trail\s+mix)\b/i, "/swaps/nuts-seeds.png"],
  [/\b(?:sprouted\s+oat\s+o'?s|oat\s+o'?s|heritage\s+flakes|bran\s+flakes|corn\s+flakes|oat\s+flakes|cereal|cheerios|frosted\s+flakes|cinnamon\s+toast\s+crunch|froot\s+loops|lucky\s+charms|granola|muesli|three\s+wishes)\b/i, "/swaps/cereal.jpg"],
  [/\b(?:rolled\s+oats|steel\s+cut\s+oats|instant\s+oatmeal|\boatmeal\b|\boats\b)\b/i, "/swaps/oats.png"],
  [/\b(?:waffles?|pancakes?|eggo|french\s+toast|pancake\s+mix)\b/i, "/swaps/waffles.png"],
  [/\b(?:bagels?)\b/i, "/swaps/bagels.png"],
  [/\b(?:tortillas?|wraps?|taco\s+shells?)\b/i, "/swaps/tortillas.png"],
  [/\b(?:hamburger\s+buns?|hot\s+dog\s+buns?|brioche\s+buns?|dinner\s+rolls?|sandwich\s+rolls?|potato\s+rolls?|hoagie\s+rolls?|sub\s+rolls?|slider\s+buns?|\bbuns\b)\b/i, "/swaps/buns.png"],
  [/\b(?:croissants?|muffins?|cupcakes?|cakes?\b|snack\s+cakes?|donuts?|doughnuts?|bismarks?|danish|cinnamon\s+rolls?|pastr(?:y|ies)|pie\s+crust|pop[- ]?tarts?|toaster\s+pastr(?:y|ies))\b/i, "/swaps/bakery.png"],
  [/\b(?:bread|sourdough|english\s+muffins?|baguette|ciabatta|ezekiel)\b/i, "/swaps/bread.jpg"],
  [/\b(?:yogurt|yoghurt|greek\s+yogurt|sour\s+cream|skyr|kefir|chobani|yoplait|fage|siggi'?s|stonyfield)\b/i, "/swaps/yogurt.jpg"],
  [/\b(?:ice\s+cream|gelato|sorbet|sherbet|frozen\s+dessert|popsicles?|ice\s+bars?)\b/i, "/swaps/icecream.png"],
  [/\b(?:butter|buttery\s+spread|margarine|ghee|kerrygold|country\s+crock|earth\s+balance)\b/i, "/swaps/butter.jpg"],
  [/\b(?:cheese|mozzarella|cheddar|parmesan|provolone|gouda|swiss\s+cheese|brie|feta|ricotta|cottage\s+cheese|cream\s+cheese|string\s+cheese|kraft\s+singles)\b/i, "/swaps/cheese.png"],
  [/\b(?:milk|oatmilk|oat\s+milk|oat\s+beverage|almondmilk|almond\s+milk|almond\s+beverage|soymilk|soy\s+milk|soy\s+beverage|coconutmilk|coconut\s+milk|coconut\s+beverage|eggnog|heavy\s+(?:whipping\s+)?cream|whipping\s+cream|lactaid|fairlife)\b/i, "/swaps/milk.png"],
  [/\b(?:eggs?|pasture[- ]?raised\s+eggs?|egg\s+whites?|liquid\s+egg)\b/i, "/swaps/eggs.png"],
  [/\b(?:pasta|spaghetti|penne|rotini|fusilli|fettuccine|linguine|macaroni|rigatoni|orzo|gnocchi|ramen|noodles?)\b/i, "/swaps/pasta.png"],
  [/\b(?:black\s+beans?|pinto\s+beans?|kidney\s+beans?|garbanzo|chickpeas?|lentils?|refried\s+beans?|baked\s+beans?|quinoa|brown\s+rice|jasmine\s+rice|basmati\s+rice|white\s+rice|couscous|farro|barley|flour|cornmeal)\b/i, "/swaps/beans-grains.png"],
  [/\b(?:applesauce|fruit\s+crisps?|apples?|peaches?|pears?|plums?|pineapples?|mangos?|mangoes|bananas?|strawberries|blueberries|raspberries|blackberries|grapes?|oranges?|lemons?|limes?|avocados?|tomatoes?|diced\s+tomatoes|corn\b|vegetables?|salad\s+kit|\bsalad\b|spinach|lettuce|romaine|kale|chard|arugula|broccoli|cauliflower|carrots?|potatoes?|sweet\s+potatoes?|onions?|garlic|peppers?|cucumbers?|celery|mushrooms?|berries|produce)\b/i, "/swaps/produce.png"],
];

const EXPLICIT_CATEGORY_FALLBACK: Readonly<Record<string, string>> = {
  "Chips": "/swaps/chips.jpg",
  "Chips & Snacks": "/swaps/chips.jpg",
  "Frozen Potatoes": "/swaps/chips.jpg",
  "Crackers": "/swaps/crackers.jpg",
  "Cereal": "/swaps/cereal.jpg",
  "Bread": "/swaps/bread.jpg",
  "Yogurt": "/swaps/yogurt.jpg",
  "Yogurt & Dairy": "/swaps/yogurt.jpg",
  "Dressings": "/swaps/ranch.jpg",
  "Dressings & Sauces": "/swaps/ranch.jpg",
  "Condiments": "/swaps/condiments.png",
  "Deli Meat": "/swaps/turkey.jpg",
  "Butter/Dairy": "/swaps/butter.jpg",
  "Drinks": "/swaps/drink.png",
  "Beverages": "/swaps/drink.png",
  "Candy": "/swaps/candy.png",
  "Cookies": "/swaps/cookies.png",
  "Frozen": "/swaps/frozen-meal.png",
};

/**
 * Resolves a brand-neutral studio food/beverage illustration path (e.g. `/swaps/cheese.png`),
 * or `null` if the item is non-food/appliance or lacks a recognizable food category.
 */
export function resolveCategoryStudioArt(params: {
  title?: string | null;
  ingredients?: string | null;
  offCategoriesTags?: readonly string[] | null;
  explicitCategory?: string | null;
}): string | null {
  const title = (params.title || "").trim();
  const ingredients = (params.ingredients || "").trim();

  // Reject appliances, cookware, paper goods, personal care, and household items unless real food ingredients are present
  if (NON_FOOD_OR_APPLIANCE_RE.test(title) && !FOOD_INGREDIENT_SIGNAL_RE.test(ingredients)) {
    return null;
  }

  if (params.offCategoriesTags && params.offCategoriesTags.length > 0) {
    const joinedTags = params.offCategoriesTags.join(" ");
    for (const [re, studioPath] of OFF_TAG_TO_STUDIO_ART) {
      if (re.test(joinedTags)) return studioPath;
    }
  }

  if (title) {
    for (const [re, studioPath] of TITLE_TO_STUDIO_ART) {
      if (re.test(title)) return studioPath;
    }
  }

  if (params.explicitCategory) {
    const mapped = EXPLICIT_CATEGORY_FALLBACK[params.explicitCategory.trim()];
    if (mapped) return mapped;
  }

  return null;
}

export interface BrandLetterTileSpec {
  letter: string;
  bgHex: string;
  fgHex: string;
  borderHex: string;
}

const TILE_PALETTES: ReadonlyArray<readonly [string, string, string]> = [
  ["#ECFDF5", "#065F46", "#A7F3D0"], // Soft Emerald
  ["#EFF6FF", "#1E40AF", "#BFDBFE"], // Crisp Sky
  ["#FEF3C7", "#92400E", "#FDE68A"], // Warm Amber
  ["#F3E8FF", "#5B21B6", "#DDD6FE"], // Soft Indigo
  ["#FFE4E6", "#9F1239", "#FECDD3"], // Berry Rose
  ["#F1F5F9", "#334155", "#CBD5E1"], // Clean Slate
];

/**
 * Computes a deterministic, high-contrast brand-letter tile specification
 * (matching Android OverlayWindowService's clean rounded initial tile).
 */
export function brandLetterTileSpec(title?: string | null, brand?: string | null): BrandLetterTileSpec {
  const source = (brand || "").trim() || (title || "").trim() || "Grocery";
  const alphaMatch = source.match(/[A-Za-z0-9]/);
  const letter = (alphaMatch ? alphaMatch[0] : "G").toUpperCase();
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % TILE_PALETTES.length;
  const [bgHex, fgHex, borderHex] = TILE_PALETTES[idx];
  return { letter, bgHex, fgHex, borderHex };
}
