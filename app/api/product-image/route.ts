import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import {
  buildCandidateBrandHaystack,
  containsWholeBrandPhrase,
  detectAllBrands,
  hasConflictingBrand,
  normalizeBrandPhrase,
} from "@/lib/brands";
import { hasProductIdentityMatch, passesVariantGuard } from "@/lib/drinks-catalog";
import { consumeSharedOffBudget, isUsMarketOffProduct, reportSharedOffRateLimited } from "@/lib/lookup";
import { lookupOffPhotoIndex, offBarcodeFolderPath } from "@/lib/off-photo-index";
import { checkRateLimitAsync } from "@/lib/scan";
import { isPersistentKvConfigured, kvGet, kvSet } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const imageUrlCache = new Map<string, string>();
const confirmedMissCache = new Map<string, number>();
const imageBytesCache = new Map<string, { bytes: ArrayBuffer; contentType: string; sourceUrl: string }>();
let imageBytesCacheTotalBytes = 0;
let trackedImgFetchRef: unknown = globalThis.fetch;

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES_CACHE_TOTAL = 48 * 1024 * 1024;
const OFF_IMAGE_SEARCH_DEADLINE_MS = 2500;
const CONFIRMED_MISS_TTL_SECONDS = 24 * 60 * 60;
const ALLOWED_IMAGE_HOST_SUFFIXES = [".openfoodfacts.org", ".openfoodfacts.net"];
const PLACEHOLDER_SVG_REL_PATH = "public/product-photo-unavailable.svg";

const FOREIGN_NON_NA_OFF_FRONT_IMAGE_RE =
  /\/front_(?:de|it|nl|pl|pt|ru|ja|zh|ar|ro|hu|cs|sv|da|fi|el|tr|he|ko|th|vi)\./i;
const ES_OR_FR_OFF_FRONT_IMAGE_RE = /\/front_(?:es|fr)\./i;
const OFF_PANEL_IMAGE_PATH_RE = /\/(?:ingredients|nutrition|packaging)(?:_|\.)/i;

function isAllowedImageUrl(rawUrl: string, allowNorthAmericaEsFr = true): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    if (FOREIGN_NON_NA_OFF_FRONT_IMAGE_RE.test(parsed.pathname)) return false;
    if (OFF_PANEL_IMAGE_PATH_RE.test(parsed.pathname)) return false;
    if (!allowNorthAmericaEsFr && ES_OR_FR_OFF_FRONT_IMAGE_RE.test(parsed.pathname)) return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === "openfoodfacts.org" ||
      host === "openfoodfacts.net" ||
      ALLOWED_IMAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
    );
  } catch {
    return false;
  }
}

interface CuratedPhotoEntry {
  pattern: RegExp;
  url: string;
  canonicalBrand: string;
  canonicalTitle: string;
  wholeProduceOnly?: boolean;
}

/**
 * Curated Open Food Facts front-of-pack product photos (CC BY-SA 3.0) and verified
 * Clean Swap product photos for exact Brand + Variant matches.
 * Never assign generic category illustrations or misleading organic/grass-fed labels to unmatched items.
 */
const VERIFIED_PRODUCT_IMAGES: CuratedPhotoEntry[] = [
  { pattern: /\bsimply\s+nature\b.*\borganic\b.*\bpeanut\s+butter\b/i, url: "local:" + "public/swaps/peanutbutter.png", canonicalBrand: "Simply Nature", canonicalTitle: "Organic Creamy Peanut Butter" },
  { pattern: /\bwellsley\s+farms\b.*\borganic\b.*\bpeanut\s+butter\b/i, url: "local:public/swaps/peanutbutter.png", canonicalBrand: "Wellsley Farms", canonicalTitle: "Organic Creamy Peanut Butter" },
  { pattern: /\bmember'?s\s+mark\b.*\borganic\b.*\bpeanut\s+butter\b/i, url: "local:public/swaps/peanutbutter.png", canonicalBrand: "Member's Mark", canonicalTitle: "Organic Creamy Peanut Butter" },
  { pattern: /\b365(?:\s+by\s+whole\s+foods(?:\s+market)?)?\b.*\borganic\b.*\bpeanut\s+butter\b/i, url: "local:public/swaps/peanutbutter.png", canonicalBrand: "365 by Whole Foods Market", canonicalTitle: "Organic Creamy Peanut Butter" },
  { pattern: /\bsimple\s+truth\b.*\borganic\b.*\bpeanut\s+butter\b/i, url: "local:public/swaps/peanutbutter.png", canonicalBrand: "Simple Truth Organic", canonicalTitle: "Organic Creamy Peanut Butter" },
  { pattern: /\bgreat\s+value\b.*\borganic\b.*\bpeanut\s+butter\b/i, url: "local:public/swaps/peanutbutter.png", canonicalBrand: "Great Value", canonicalTitle: "Organic Creamy Stir Peanut Butter" },
  { pattern: /\bthat'?s\s+it\b.*\b(?:fruit\s+bars?|apple\b.*\bstrawberr)/i, url: "https://images.openfoodfacts.org/images/products/638/859/700/4996/front_en.3.400.jpg", canonicalBrand: "That's It", canonicalTitle: "100% Real Fruit Bars Apple Strawberry" },
  { pattern: /\bsolely\b.*\borganic\b.*\bfruit\s+(?:bars?|strips?|jerky)\b/i, url: "local:" + "public/swaps/fruitbar.png", canonicalBrand: "Solely", canonicalTitle: "Organic Whole Fruit Bars" },
  { pattern: /\bsimply\s+nature\b.*\bfruit\s+(?:bars?|strips?)\b/i, url: "local:public/swaps/fruitbar.png", canonicalBrand: "Simply Nature", canonicalTitle: "Fruit Strips Bars" },
  { pattern: /\bhidden\s+valley\b(?!.*\b(?:packet|packets|mix|seasoning|shaker|dry|dip|plant|vegan|dairy[- ]?free|avocado|spicy|secret\s+sauce|bacon|pickle|fiesta|buffalo|chipotle|garlic|cilantro|jalapeno|southwest|honey\s+bbq|blasted|greek\s+yogurt|simply\s+ranch|light|fat[- ]?free|organic|aged\s+cheddar|buttermilk\s+recipe)\b).*\branch\b/i, url: "https://images.openfoodfacts.org/images/products/007/110/000/3116/front_en.7.400.jpg", canonicalBrand: "Hidden Valley", canonicalTitle: "The Original Ranch Salad Dressing" },
  { pattern: /\bprimal\s+kitchen\b(?!.*\b(?:packet|mix|seasoning|dip|spicy|buffalo|vegan|plant)\b).*\branch\b/i, url: "local:public/swaps/ranch.jpg", canonicalBrand: "Primal Kitchen", canonicalTitle: "Ranch Dressing with Avocado Oil" },
  { pattern: /\bprimal\s+kitchen\b(?!.*\b(?:chipotle|garlic|pest|buffalo|spicy|vegan|plant)\b).*\b(?:mayo|mayonnaise)\b/i, url: "https://images.openfoodfacts.org/images/products/066/369/002/4048/front_en.3.400.jpg", canonicalBrand: "Primal Kitchen", canonicalTitle: "Real Mayonnaise with Avocado Oil" },
  { pattern: /\bprimal\s+kitchen\b(?!.*\b(?:spicy|jalapeno|habanero)\b).*\bketchup\b/i, url: "https://images.openfoodfacts.org/images/products/827/574/200/7125/front_en.8.400.jpg", canonicalBrand: "Primal Kitchen", canonicalTitle: "Organic Unsweetened Ketchup" },
  { pattern: /\bmarketside\b(?!.*\b(?:romaine|dip|artichoke|organic)\b).*\bbaby\s+spinach\b/i, url: "https://images.openfoodfacts.org/images/products/068/113/132/8982/front_en.3.400.jpg", canonicalBrand: "Marketside", canonicalTitle: "Fresh Baby Spinach" },
  { pattern: /\bcinnamon\s+toast\s+crunch\b(?!.*\b(?:churros?|rolls?|bars?|treats?|spread|creamer|coffee|latte|milk|shake|bugles|pancakes?|waffles?|oatmeal|frosting|icing|cookies?|popcorn|bites?|loaded|soft\s+baked|minis?|sugar\s+cookie|french\s+toast|apple\s+pie|strawberry|tres\s+leches|dulce\s+de\s+leche|seasoning)\b)/i, url: "https://images.openfoodfacts.org/images/products/10167730/front_en.3.400.jpg", canonicalBrand: "General Mills Cinnamon Toast Crunch", canonicalTitle: "Cinnamon Toast Crunch Cereal" },
  { pattern: /\bkellogg'?s\b(?!.*\b(?:chocolate|strawberry|cinnamon|honey|marshmallows?|bars?|shake|milk)\b).*\bfrosted\s+flakes\b/i, url: "https://images.openfoodfacts.org/images/products/003/800/012/7502/front_en.3.400.jpg", canonicalBrand: "Kellogg's", canonicalTitle: "Frosted Flakes Cereal" },
  { pattern: /\bnature'?s\s+path\b.*\bheritage\s+flakes\b/i, url: "https://images.openfoodfacts.org/images/products/991/360/277/0206/front_en.4.400.jpg", canonicalBrand: "Nature's Path", canonicalTitle: "Organic Heritage Flakes Cereal" },
  { pattern: /\bcampbell'?s\b.*\bmanhattan\b.*\bclam\s+chowder\b/i, url: "https://images.openfoodfacts.org/images/products/005/100/000/5540/front_en.11.400.jpg", canonicalBrand: "Campbell's", canonicalTitle: "Condensed Manhattan Clam Chowder Soup" },
  { pattern: /\bcampbell'?s\b.*\bchunky\b.*\bnew\s+england\s+clam\s+chowder\b/i, url: "https://images.openfoodfacts.org/images/products/75395322/front_en.3.400.jpg", canonicalBrand: "Campbell's", canonicalTitle: "Chunky New England Clam Chowder Soup" },
  { pattern: /\bmarketside\b.*\bclam\s+chowder\b/i, url: "https://images.openfoodfacts.org/images/products/084/013/430/8029/front_en.3.400.jpg", canonicalBrand: "Marketside", canonicalTitle: "New England Clam Chowder Soup" },
  { pattern: /\bamy'?s\b(?!.*\b(?:vegetable|low\s+sodium|light\s+in\s+sodium)\b).*\blentil\b.*\bsoup\b/i, url: "https://images.openfoodfacts.org/images/products/004/223/400/5833/front_en.3.400.jpg", canonicalBrand: "Amy's", canonicalTitle: "Organic Lentil Soup" },
  { pattern: /\bdoritos\b.*\b(?:simply\s+nkd|nkd)\b.*\bnacho\s+cheese\b/i, url: "local:public/swaps/chips.jpg", canonicalBrand: "Doritos", canonicalTitle: "Simply NKD Nacho Cheese Tortilla Chips" },
  { pattern: /\bdoritos\b.*\b(?:simply\s+nkd|nkd)\b.*\bcool\s+ranch\b/i, url: "local:public/swaps/chips.jpg", canonicalBrand: "Doritos", canonicalTitle: "Simply NKD Cool Ranch Tortilla Chips" },
  { pattern: /\bdoritos\b(?!.*\b(?:simply|nkd|dinamita|3d|minis?|dip|flamin|spicy|taco|tapatio|organic|twisted|collisions|popcorn|jerky|nuts?|almonds?)\b).*\bnacho\s+cheese\b/i, url: "https://images.openfoodfacts.org/images/products/120/010/800/0721/front_en.3.400.jpg", canonicalBrand: "Doritos", canonicalTitle: "Nacho Cheese Flavored Tortilla Chips" },
  { pattern: /\bdoritos\b(?!.*\b(?:simply|nkd|dinamita|3d|minis?|dip|flamin|spicy|taco|tapatio|organic|twisted|collisions|popcorn|jerky|nuts?|almonds?)\b).*\bcool\s+ranch\b/i, url: "https://images.openfoodfacts.org/images/products/000/284/000/9151/front_en.7.400.jpg", canonicalBrand: "Doritos", canonicalTitle: "Cool Ranch Flavored Tortilla Chips" },
  { pattern: /\blay'?s\b.*\bwavy\b.*\boriginal\b/i, url: "https://images.openfoodfacts.org/images/products/002/840/031/0468/front_en.13.400.jpg", canonicalBrand: "Lay's", canonicalTitle: "Wavy Original Potato Chips" },
  { pattern: /\bsiete\b(?!.*\b(?:nacho|ranch|lime|fuego|jalapeno|churro|cinnamon)\b).*\btortilla\s+chips\b/i, url: "https://images.openfoodfacts.org/images/products/085/176/900/7003/front_en.13.400.jpg", canonicalBrand: "Siete", canonicalTitle: "Sea Salt Grain Free Tortilla Chips" },
  { pattern: /\bsiete\b(?!.*\bchips?\b).*\btortillas?\b/i, url: "local:public/swaps/tortillas.png", canonicalBrand: "Siete", canonicalTitle: "Almond Flour Grain Free Tortillas" },
  { pattern: /\bsanta\s+cruz\b(?!.*\bcrunchy\b).*\bpeanut\s+butter\b/i, url: "https://images.openfoodfacts.org/images/products/005/150/090/2882/front_en.28.400.jpg", canonicalBrand: "Santa Cruz Organic", canonicalTitle: "Organic Creamy Dark Roasted Peanut Butter" },
  { pattern: /\bgood\s*(?:&|and)?\s*gather\b(?!.*\b(?:crunchy|honey|chocolate)\b).*\bpeanut\s+butter\b/i, url: "https://images.openfoodfacts.org/images/products/008/523/934/0400/front_en.3.400.jpg", canonicalBrand: "Good & Gather", canonicalTitle: "Organic Stir Creamy Peanut Butter" },
  { pattern: /\bthree\s+wishes\b(?!.*\b(?:bars?|granola)\b).*\bcocoa\b/i, url: "https://images.openfoodfacts.org/images/products/086/000/215/2493/front_en.3.400.jpg", canonicalBrand: "Three Wishes", canonicalTitle: "Cocoa Grain Free Cereal" },
  { pattern: /\bthree\s+wishes\b(?!.*\b(?:cocoa|cinnamon|honey|fruity|marshmallow|strawberry|pumpkin|unsweetened|bars?|granola)\b).*\bfrosted\b/i, url: "https://images.openfoodfacts.org/images/products/085/001/681/3046/front_en.11.400.jpg", canonicalBrand: "Three Wishes", canonicalTitle: "Frosted Grain Free Cereal" },
  { pattern: /\borganic\s+valley\b.*\bamerican\b.*\bcheese\b/i, url: "https://images.openfoodfacts.org/images/products/009/396/600/4861/front_en.5.400.jpg", canonicalBrand: "Organic Valley", canonicalTitle: "Organic American Cheese Slices" },
  { pattern: /\borganic\s+valley\b.*\bsharp\s+cheddar\b/i, url: "https://images.openfoodfacts.org/images/products/009/396/600/5431/front_en.5.400.jpg", canonicalBrand: "Organic Valley", canonicalTitle: "Organic Raw Sharp Cheddar Cheese" },
  { pattern: /\borganic\s+valley\b(?!.*\b(?:ghee|unsalted)\b).*\bbutter\b/i, url: "local:public/swaps/butter.jpg", canonicalBrand: "Organic Valley", canonicalTitle: "Organic Pasture-Raised Salted Butter" },
  { pattern: /\bkerrygold\b(?!.*\b(?:unsalted|garlic|herb|cheddar|cheese)\b).*\bbutter\b/i, url: "local:public/swaps/butter.jpg", canonicalBrand: "Kerrygold", canonicalTitle: "Pure Irish Salted Butter" },
  { pattern: /\blactaid\b(?!.*\b(?:chocolate|2%|1%|skim|fat[- ]?free|low[- ]?fat|ice\s+cream|cottage|sour\s+cream|eggnog)\b).*\bwhole\b.*\bmilk\b/i, url: "https://images.openfoodfacts.org/images/products/004/410/012/2392/front_en.3.400.jpg", canonicalBrand: "Lactaid", canonicalTitle: "Whole Milk Lactose Free" },
  { pattern: /\bboulder\s+canyon\b(?!.*\b(?:jalapeno|malt\s+vinegar|hickory|bbq|barbecue|cheddar|sour\s+cream|red\s+pepper)\b).*\b(?:avocado|chips)\b/i, url: "local:public/swaps/chips.jpg", canonicalBrand: "Boulder Canyon", canonicalTitle: "Avocado Oil Kettle Potato Chips Classic Sea Salt" },
  { pattern: /\bdave'?s\s+killer\s+bread\b(?!.*\b(?:thin[- ]?sliced|bagels?|english\s+muffins?|rolls?|buns?|bars?)\b).*\b21\s+whole\s+grains\b/i, url: "https://images.openfoodfacts.org/images/products/002/376/400/5043/front_en.3.400.jpg", canonicalBrand: "Dave's Killer Bread", canonicalTitle: "Organic 21 Whole Grains and Seeds Bread" },
  { pattern: /\bwonder\b(?!.*\b(?:buns?|rolls?|wheat|keto)\b).*\b(?:classic\s+)?white\b.*\bbread\b/i, url: "https://images.openfoodfacts.org/images/products/007/225/001/1372/front_en.17.400.jpg", canonicalBrand: "Wonder", canonicalTitle: "Classic White Bread" },
  { pattern: /\byoplait\b(?!.*\b(?:light|zero|protein|go[- ]?gurt|whips|banana)\b).*\boriginal\b.*\bstrawberry\b/i, url: "https://images.openfoodfacts.org/images/products/007/047/000/4303/front_en.24.400.jpg", canonicalBrand: "Yoplait", canonicalTitle: "Original Low Fat Yogurt Strawberry" },
  { pattern: /\bstonyfield\b.*\bwhole\s+milk\b.*\bplain\b.*\byogurt\b/i, url: "https://images.openfoodfacts.org/images/products/005/215/900/0011/front_en.11.400.jpg", canonicalBrand: "Stonyfield Organic", canonicalTitle: "Organic Whole Milk Plain Yogurt" },
  { pattern: /\bcheez[- ]?it\b(?!.*\b(?:white\s+cheddar|extra\s+toasty|snap'?d|puff'?d|grooves|duoz|hot\s*&?\s*spicy|reduced\s+fat)\b).*\boriginal\b/i, url: "https://images.openfoodfacts.org/images/products/002/410/012/2615/front_en.44.400.jpg", canonicalBrand: "Cheez-It", canonicalTitle: "Original Baked Snack Crackers" },
  { pattern: /\bpepperidge\s+farm\b(?!.*\b(?:colors|flavor\s+blasted|pretzel|vanilla|graham|parmesan|pizza)\b).*\bgoldfish\b.*\bcheddar\b/i, url: "https://images.openfoodfacts.org/images/products/001/410/008/4761/front_en.16.400.jpg", canonicalBrand: "Pepperidge Farm", canonicalTitle: "Goldfish Cheddar Crackers" },
  { pattern: /\bmary'?s\s+gone\s+crackers\b(?!.*\b(?:herb|everything|jalapeno|black\s+pepper|super\s+seed|cheezee|kookie)\b).*\boriginal\b/i, url: "https://images.openfoodfacts.org/images/products/065/439/124/6006/front_en.3.400.jpg", canonicalBrand: "Mary's Gone Crackers", canonicalTitle: "Organic Original Seed Crackers" },
  { pattern: /\boscar\s+mayer\b.*\bdeli\s+fresh\b.*\b(?:honey\s+)?smoked\s+turkey\b/i, url: "https://images.openfoodfacts.org/images/products/004/470/003/1483/front_en.10.400.jpg", canonicalBrand: "Oscar Mayer", canonicalTitle: "Deli Fresh Smoked Turkey Breast" },
  { pattern: /\bwelch'?s\b(?!.*\b(?:zero\s+sugar|reduced\s+sugar|juicefuls|berries\s+'?n\s+cherries|island\s+fruits)\b).*\bmixed\s+fruit\s+snacks?\b/i, url: "https://images.openfoodfacts.org/images/products/003/485/601/5987/front_en.13.400.jpg", canonicalBrand: "Welch's", canonicalTitle: "Mixed Fruit Snacks" },
  { pattern: /\b(?:larabar|lärabar)\b.*\bcashew\s+cookie\b/i, url: "https://images.openfoodfacts.org/images/products/002/190/840/9528/front_en.11.400.jpg", canonicalBrand: "LÄRABAR", canonicalTitle: "Cashew Cookie Fruit & Nut Bar" },
  { pattern: /\bsimple\s+mills\b.*\bchocolate\s+chip\b.*\bcookies?\b/i, url: "https://images.openfoodfacts.org/images/products/84664945/front_en.10.400.jpg", canonicalBrand: "Simple Mills", canonicalTitle: "Crunchy Chocolate Chip Almond Flour Cookies" },
  { pattern: /\bmade\s*good\b.*\bchocolate\s+chip\b.*\bcookies?\b/i, url: "local:public/swaps/cookies.png", canonicalBrand: "MadeGood", canonicalTitle: "Organic Chocolate Chip Mini Cookies" },
  { pattern: /\boreo\b(?!.*\b(?:mint|golden|double\s+stuf|mega\s+stuf|peanut\s+butter|thins|lemon|birthday|gluten[- ]?free|zero\s+sugar|cakesters|ice\s+cream|cereal)\b).*\bchocolate\s+sandwich\s+cookies?\b/i, url: "https://images.openfoodfacts.org/images/products/004/400/004/7009/front_en.20.400.jpg", canonicalBrand: "Oreo", canonicalTitle: "Chocolate Sandwich Cookies" },
  { pattern: /\beggo\b(?!.*\b(?:blueberry|chocolate|buttermilk|thick\s*&?\s*fluffy|cinnamon|protein)\b).*\bhomestyle\b.*\bwaffles?\b/i, url: "https://images.openfoodfacts.org/images/products/003/800/040/2609/front_en.21.400.jpg", canonicalBrand: "Eggo", canonicalTitle: "Homestyle Waffles" },
  { pattern: /\bkraft\b(?!.*\b(?:deluxe|velveeta|thick\s*'n\s*creamy|three\s+cheese|white\s+cheddar|spirals|shapes|cups?|gluten[- ]?free|plant)\b).*\bmacaroni\s*(?:&|and)\s*cheese\b.*\boriginal\b/i, url: "https://images.openfoodfacts.org/images/products/002/100/003/3720/front_en.15.400.jpg", canonicalBrand: "Kraft", canonicalTitle: "Original Macaroni & Cheese Dinner" },
  { pattern: /\brao'?s\b(?!.*\b(?:soup|pizza|alfredo|pesto|frozen|lasagna|meatballs?)\b).*\bmarinara\b/i, url: "local:public/swaps/marinara.png", canonicalBrand: "Rao's Homemade", canonicalTitle: "Marinara Sauce" },
  { pattern: /\bannie'?s\b(?!.*\b(?:dijon|honey|horseradish)\b).*\byellow\s+mustard\b/i, url: "https://images.openfoodfacts.org/images/products/009/232/522/2243/front_en.5.400.jpg", canonicalBrand: "Annie's", canonicalTitle: "Organic Yellow Mustard" },
  { pattern: /\bcoombs\s+family\s+farms\b.*\bmaple\s+syrup\b/i, url: "https://images.openfoodfacts.org/images/products/071/028/232/9644/front_en.3.400.jpg", canonicalBrand: "Coombs Family Farms", canonicalTitle: "Organic Pure Maple Syrup" },
  { pattern: /\bbob'?s\s+red\s+mill\b(?!.*\b(?:quick|instant|steel\s+cut|protein)\b).*\brolled\s+oats\b/i, url: "https://images.openfoodfacts.org/images/products/003/997/803/3758/front_en.43.400.jpg", canonicalBrand: "Bob's Red Mill", canonicalTitle: "Old Fashioned Rolled Oats" },
  { pattern: /\balden'?s\s+organic\b.*\bvanilla\s+bean\b.*\bice\s+cream\b/i, url: "https://images.openfoodfacts.org/images/products/007/269/274/1851/front_en.3.400.jpg", canonicalBrand: "Alden's Organic", canonicalTitle: "Organic Vanilla Bean Ice Cream" },
  { pattern: /\bcoffee[- ]?mate\b(?!.*\b(?:zero\s+sugar|sugar[- ]?free|powder|natural\s+bliss|oat|almond)\b).*\bfrench\s+vanilla\b/i, url: "https://images.openfoodfacts.org/images/products/005/000/032/2756/front_en.31.400.jpg", canonicalBrand: "Coffee mate", canonicalTitle: "French Vanilla Liquid Coffee Creamer" },
  { pattern: /\bsmucker'?s\b.*\buncrustables?\b.*\b(?:grape|strawberry)\b/i, url: "https://images.openfoodfacts.org/images/products/005/150/005/0163/front_en.14.400.jpg", canonicalBrand: "Smucker's", canonicalTitle: "Uncrustables Peanut Butter & Grape Spread Sandwich" },
  { pattern: /\bcapri\s*sun\b(?!.*\b(?:roarin|100%\s+juice)\b).*\bstrawberry\s+kiwi\b/i, url: "https://images.openfoodfacts.org/images/products/008/768/400/0991/front_en.14.400.jpg", canonicalBrand: "Capri Sun", canonicalTitle: "Strawberry Kiwi Juice Drink" },
  { pattern: /\bhu\b.*\b(?:simple|salty)\b.*\bdark\s+chocolate\b/i, url: "https://images.openfoodfacts.org/images/products/123/000/009/7000/front_en.18.400.jpg", canonicalBrand: "Hu", canonicalTitle: "Simple Dark Chocolate Bar" },
  { pattern: /\bmonster\b.*\b(?:zero\s+ultra|ultra\s+white)\b/i, url: "https://images.openfoodfacts.org/images/products/007/084/789/2519/front_en.3.400.jpg", canonicalBrand: "Monster Energy", canonicalTitle: "Zero Ultra Energy Drink" },
  { pattern: /\bmonster\s+energy\b(?!.*\b(?:zero|ultra|lo[- ]?carb|rehab|java|juice|mango)\b).*\b(?:original|green)\b/i, url: "https://images.openfoodfacts.org/images/products/007/084/703/7712/front_en.8.400.jpg", canonicalBrand: "Monster Energy", canonicalTitle: "Original Green Energy Drink" },
  { pattern: /\bred\s*bull\b.*\bsugar\s*free\b/i, url: "https://images.openfoodfacts.org/images/products/900/249/025/7064/front_en.4.400.jpg", canonicalBrand: "Red Bull", canonicalTitle: "Sugarfree Energy Drink" },
  { pattern: /\bred\s*bull\b(?!.*\b(?:sugar\s*free|zero|edition|peach|watermelon|amber|juneberry|tropical|coconut|dragon|apricot|curuba)\b).*\benergy\s+drink\b/i, url: "https://images.openfoodfacts.org/images/products/900/249/020/5973/front_en.104.400.jpg", canonicalBrand: "Red Bull", canonicalTitle: "Energy Drink" },
  { pattern: /\bcelsius\b(?!.*\b(?:powder|packets?|sticks?|vibe|essentials)\b).*\borange\b/i, url: "https://images.openfoodfacts.org/images/products/088/939/200/0412/front_en.3.400.jpg", canonicalBrand: "Celsius", canonicalTitle: "Sparkling Orange Fitness Drink" },
  { pattern: /\bcelsius\b(?!.*\b(?:powder|packets?|sticks?|vibe|essentials)\b).*\bwild\s+berry\b/i, url: "https://images.openfoodfacts.org/images/products/088/939/201/0145/front_en.10.400.jpg", canonicalBrand: "Celsius", canonicalTitle: "Sparkling Wild Berry Fitness Drink" },
  { pattern: /\bc4\b(?!.*\b(?:powder|tub|canister|smart|ultimate)\b).*\bicy\s+blue\b/i, url: "https://images.openfoodfacts.org/images/products/084/259/510/5575/front_en.3.400.jpg", canonicalBrand: "C4", canonicalTitle: "Performance Energy Icy Blue Razz" },
  { pattern: /\b(?:guayaki|guayakí)\b.*\byerba\s+mate\b.*\benlighten\s+mint\b/i, url: "https://images.openfoodfacts.org/images/products/063/243/200/0046/front_en.6.400.jpg", canonicalBrand: "Guayaki", canonicalTitle: "Organic Yerba Mate Enlighten Mint" },
  { pattern: /\bora\s+organic\b.*\b(?:renewable|pre[- ]?workout)\b/i, url: "https://images.openfoodfacts.org/images/products/085/672/000/7115/front_en.3.400.jpg", canonicalBrand: "Ora Organic", canonicalTitle: "Organic Pre-Workout Renewable Energy Powder" },
  { pattern: /\bcore\s+power\b(?!.*\b(?:elite|42\s*g|vanilla|strawberry|banana)\b).*\bchocolate\b/i, url: "https://images.openfoodfacts.org/images/products/061/134/003/2066/front_en.3.400.jpg", canonicalBrand: "Core Power", canonicalTitle: "Fairlife Chocolate High Protein Milk Shake 26g" },
  { pattern: /\borgain\b(?!.*\b(?:powder|tub|kids|plant|vegan)\b).*\bclean\s+protein\s+shake\b/i, url: "https://images.openfoodfacts.org/images/products/085/177/000/8938/front_en.3.400.jpg", canonicalBrand: "Orgain", canonicalTitle: "Organic Grass Fed Clean Protein Shake" },
  { pattern: /\bdiet\s+coke\b(?!.*\b(?:caffeine[- ]?free|cherry|lime|ginger)\b)/i, url: "https://images.openfoodfacts.org/images/products/004/900/002/4692/front_en.11.400.jpg", canonicalBrand: "Diet Coke", canonicalTitle: "Diet Coke Soda" },
  { pattern: /\b(?:mountain|mtn)\s+dew\b(?!.*\b(?:zero|diet|baja|code\s+red|voltage|major\s+melon|spark|frost|livewire|pitch\s+black)\b)/i, url: "https://images.openfoodfacts.org/images/products/001/200/003/2448/front_en.12.400.jpg", canonicalBrand: "Mountain Dew", canonicalTitle: "Mountain Dew Citrus Soda" },
  { pattern: /\bolipop\b.*\bvintage\s+cola\b/i, url: "https://images.openfoodfacts.org/images/products/086/948/401/5005/front_en.3.400.jpg", canonicalBrand: "Olipop", canonicalTitle: "Vintage Cola Prebiotic Soda" },
  { pattern: /\bpoppi\b.*\bstrawberry\s+lemon\b/i, url: "https://images.openfoodfacts.org/images/products/081/006/371/0668/front_en.3.400.jpg", canonicalBrand: "Poppi", canonicalTitle: "Strawberry Lemon Prebiotic Soda" },
  { pattern: /\bfiji\b.*\bwater\b/i, url: "https://images.openfoodfacts.org/images/products/941/757/400/1424/front_en.3.400.jpg", canonicalBrand: "FIJI", canonicalTitle: "Natural Artesian Water" },
  { pattern: /\bspindrift\b.*\blemon\b(?!\s*(?:lime|iced\s+tea))/i, url: "https://images.openfoodfacts.org/images/products/085/657/900/2910/front_en.19.400.jpg", canonicalBrand: "Spindrift", canonicalTitle: "Lemon Sparkling Water" },
  { pattern: /\bgatorade\b(?!.*\b(?:g2|zero|fit|lyte|gatorlyte|water|protein|fast\s+twitch|powder|canister|tub|mix|packets?|sticks?|pods?|concentrate|chews?|gummies|bars?|gels?|shakes?)\b).*\bfruit\s+punch\b/i, url: "https://images.openfoodfacts.org/images/products/005/200/024/1211/front_en.12.400.jpg", canonicalBrand: "Gatorade", canonicalTitle: "Thirst Quencher Fruit Punch Sports Drink" },
  { pattern: /\bnooma\b.*\borganic\s+electrolyte\b/i, url: "https://images.openfoodfacts.org/images/products/085/137/300/5044/front_en.5.400.jpg", canonicalBrand: "NOOMA", canonicalTitle: "Organic Electrolyte Sports Drink" },
  { pattern: /\bprime\b(?!.*\b(?:energy|powder|sticks?|packets?)\b).*\bice\s+pop\b/i, url: "https://images.openfoodfacts.org/images/products/085/004/000/5226/front_en.3.400.jpg", canonicalBrand: "Prime", canonicalTitle: "Hydration Drink Ice Pop" },
  { pattern: /\bsimply\s+orange\b(?!.*\b(?:mango|pineapple|calcium|high\s+pulp|with\s+pulp|some\s+pulp|light)\b)/i, url: "https://images.openfoodfacts.org/images/products/002/500/010/0000/front_en.30.400.jpg", canonicalBrand: "Simply Orange", canonicalTitle: "Pulp Free 100% Pure Squeezed Orange Juice" },
  { pattern: /\buncle\s+matt'?s\b(?!.*\b(?:calcium|pulp\s+with)\b).*\borange\s+juice\b/i, url: "https://images.openfoodfacts.org/images/products/069/706/852/0139/front_en.12.400.jpg", canonicalBrand: "Uncle Matt's Organic", canonicalTitle: "Organic Pulp Free Orange Juice" },
  { pattern: /\bharmless\s+harvest\b(?!.*\b(?:yogurt|smoothie|sparkling|mango|watermelon)\b).*\bcoconut\s+water\b/i, url: "https://images.openfoodfacts.org/images/products/85902800/front_en.3.400.jpg", canonicalBrand: "Harmless Harvest", canonicalTitle: "Organic Coconut Water" },
  { pattern: /\bsunny\s*d\b.*\btangy\s+original\b/i, url: "https://images.openfoodfacts.org/images/products/005/020/012/1005/front_en.3.400.jpg", canonicalBrand: "SunnyD", canonicalTitle: "Tangy Original Citrus Punch" },
  { pattern: /\bstarbucks\b.*\bmocha\b.*\bfrappuccino\b/i, url: "https://images.openfoodfacts.org/images/products/001/200/000/4520/front_en.4.400.jpg", canonicalBrand: "Starbucks", canonicalTitle: "Bottled Mocha Frappuccino Coffee Drink" },
  { pattern: /\bstok\b.*\bunsweetened\b.*\bcold\s+brew\b/i, url: "https://images.openfoodfacts.org/images/products/003/663/207/2634/front_en.3.400.jpg", canonicalBrand: "SToK", canonicalTitle: "Unsweetened Black Cold Brew Coffee" },
  { pattern: /\bfairlife\b(?!.*\b(?:chocolate|strawberry|skim|fat\s*free|whole)\b).*\b2%\b.*\bmilk\b/i, url: "https://images.openfoodfacts.org/images/products/081/162/002/0169/front_en.83.400.jpg", canonicalBrand: "Fairlife", canonicalTitle: "2% Reduced Fat Ultra-Filtered Milk" },
  { pattern: /\bmalk\b(?!.*\b(?:vanilla|chocolate)\b).*\bunsweetened\b.*\boat\b/i, url: "https://images.openfoodfacts.org/images/products/076/574/644/4432/front_en.3.400.jpg", canonicalBrand: "MALK", canonicalTitle: "Organic Unsweetened Oat Milk" },
  { pattern: /\bmalk\b(?!.*\b(?:vanilla|chocolate)\b).*\bunsweetened\b.*\balmond\b/i, url: "https://images.openfoodfacts.org/images/products/085/003/046/4040/front_en.3.400.jpg", canonicalBrand: "MALK", canonicalTitle: "Organic Unsweetened Almond Milk" },
  { pattern: /\bcalifia\b(?!.*\b(?:barista|vanilla|creamer)\b).*\borganic\b.*\boat/i, url: "https://images.openfoodfacts.org/images/products/081/363/602/1932/front_en.30.400.jpg", canonicalBrand: "Califia Farms", canonicalTitle: "Organic Oatmilk Unsweetened" },
  { pattern: /\bcalifia\b(?!.*\b(?:barista|vanilla|creamer)\b).*\borganic\b.*\balmond/i, url: "https://images.openfoodfacts.org/images/products/085/290/900/3855/front_en.9.400.jpg", canonicalBrand: "Califia Farms", canonicalTitle: "Organic Almondmilk Unsweetened" },
  { pattern: /\boatly\b(?!.*\b(?:chocolate|barista|full\s+fat|super\s+basic|vanilla|low\s*fat|ice\s+cream|creamer)\b).*\b(?:original|oat\s*milk)\b/i, url: "https://images.openfoodfacts.org/images/products/001/906/466/4110/front_en.3.400.jpg", canonicalBrand: "Oatly", canonicalTitle: "Original Oatmilk" },
  { pattern: /\bnesquik\b(?!.*\b(?:powder|syrup|strawberry|zero|no\s+sugar)\b).*\bchocolate\b.*\bmilk\b/i, url: "https://images.openfoodfacts.org/images/products/002/800/077/1720/front_en.3.400.jpg", canonicalBrand: "Nesquik", canonicalTitle: "Chocolate Lowfat Milk" },
  { pattern: /\bhorizon\s+organic\b.*\bchocolate\b.*\bmilk\b/i, url: "https://images.openfoodfacts.org/images/products/003/663/207/8513/front_en.3.400.jpg", canonicalBrand: "Horizon Organic", canonicalTitle: "Organic Chocolate Lowfat Milk" },
  { pattern: /\bsimple\s+truth\b.*\bplain\b.*\bgreek\s+yogurt\b/i, url: "https://images.openfoodfacts.org/images/products/001/111/010/8333/front_en.3.400.jpg", canonicalBrand: "Simple Truth Organic", canonicalTitle: "Organic Plain Nonfat Greek Yogurt" },
  { pattern: /\bbig\s+k\b(?!.*\b(?:zero|diet|cherry|root\s+beer|dr\s+k|citrus)\b).*\bcola\b/i, url: "https://images.openfoodfacts.org/images/products/001/111/049/1053/front_en.3.400.jpg", canonicalBrand: "Big K", canonicalTitle: "Cola Soda" },
  { pattern: /\bprivate\s+selection\b(?!.*\b(?:roast\s+beef|deli|sliced|jerky|steaks?|hot\s*dogs?|franks?|meatballs?|chili|soup|seasoning)\b).*\bangus\b.*\b(?:patt(?:y|ies)|burgers?)\b/i, url: "https://images.openfoodfacts.org/images/products/001/111/022/0691/front_en.3.400.jpg", canonicalBrand: "Private Selection", canonicalTitle: "Angus Beef Patties" },
  { pattern: /\bfavorite\s+day\b.*\bnon[- ]?dairy\b.*\bvanilla\b/i, url: "https://images.openfoodfacts.org/images/products/008/523/914/1694/front_en.8.400.jpg", canonicalBrand: "Favorite Day", canonicalTitle: "Non-Dairy Vanilla Bean Frozen Dessert" },
  { pattern: /\bbutterball\b(?!.*\b(?:bacon|ground|burgers?|patt(?:y|ies)|sausages?|meatballs?|deli|sliced|lunch\s*meat|franks?|hot\s*dogs?|jerky|sticks?|strips?|tenderloins?|cutlets?|roast\s+breast|boneless\s+breast|smoked\s+sausage|kielbasa|chorizo)\b).*\b(?:whole|young|frozen\s+whole|all\s+natural\s+whole)\b.*\bturkey\b/i, url: "https://images.openfoodfacts.org/images/products/023/007/223/1082/front_en.3.400.jpg", canonicalBrand: "Butterball", canonicalTitle: "Whole Young Turkey" },
  { pattern: /\bapplegate\b(?!.*\borganics?\b).*\broast\s+beef\b/i, url: "https://images.openfoodfacts.org/images/products/002/531/715/6745/front_en.12.400.jpg", canonicalBrand: "Applegate", canonicalTitle: "Natural Medium Rare Roast Beef" },
  { pattern: /\bapplegate\b(?!.*\borganics?\b).*\b(?:hot\s*dogs?|franks?)\b/i, url: "https://images.openfoodfacts.org/images/products/002/531/753/2006/front.3.400.jpg", canonicalBrand: "Applegate", canonicalTitle: "Natural Uncured Beef Hot Dog" },
  { pattern: /\bapplegate\b(?!.*\b(?:turkey|organics?)\b).*\bbacon\b/i, url: "https://images.openfoodfacts.org/images/products/002/531/733/1005/front_en.3.400.jpg", canonicalBrand: "Applegate", canonicalTitle: "Natural Sunday Bacon" },
  { pattern: /\bapplegate\b(?!.*\borganics?\b).*\bblack\s+forest\s+ham\b/i, url: "https://images.openfoodfacts.org/images/products/002/531/700/5906/front_en.5.400.jpg", canonicalBrand: "Applegate", canonicalTitle: "Natural Uncured Black Forest Ham" },
  { pattern: /\bapplegate\b.*\borganic.*\bsalami\b/i, url: "https://images.openfoodfacts.org/images/products/002/531/765/6009/front_en.25.400.jpg", canonicalBrand: "Applegate Organics", canonicalTitle: "Organic Genoa Salami" },
  { pattern: /\bapplegate\b(?!.*\borganic\b).*\bsalami\b/i, url: "https://images.openfoodfacts.org/images/products/002/531/766/8569/front_en.4.400.jpg", canonicalBrand: "Applegate", canonicalTitle: "Natural Genoa Salami" },
  { pattern: /\bapplegate\b(?!.*\b(?:turkey|organics?)\b).*\bbreakfast\s+sausage\b/i, url: "https://images.openfoodfacts.org/images/products/002/531/700/5890/front_en.5.400.jpg", canonicalBrand: "Applegate", canonicalTitle: "Natural Classic Pork Breakfast Sausage" },
  { pattern: /\bapplegate\b.*\borganic.*\bnuggets?\b/i, url: "https://images.openfoodfacts.org/images/products/002/531/760/5519/front_en.6.400.jpg", canonicalBrand: "Applegate Organics", canonicalTitle: "Organic Chicken Nuggets" },
  { pattern: /\bapplegate\b(?!.*\borganic\b).*\bnuggets?\b/i, url: "https://images.openfoodfacts.org/images/products/002/531/705/5192/front_en.22.400.jpg", canonicalBrand: "Applegate", canonicalTitle: "Natural Chicken Nuggets" },
  { pattern: /\bannie'?s\b(?!.*\b(?:bunnies|bunny|crackers?|popcorn|puffs?|grahams?|gummies|fruit|bars?|cookies?|bites?|pretzels?|soups?|pizza|bagels?|rolls?|biscuits?|waffles?|pancakes?)\b).*\b(?:shells|mac|macaroni)\b.*\bcheddar\b/i, url: "https://images.openfoodfacts.org/images/products/26565859/front_en.3.400.jpg", canonicalBrand: "Annie's", canonicalTitle: "Shells & White Cheddar Macaroni & Cheese" },
  { pattern: /\blotus\s+foods\b.*\bramen\b/i, url: "https://images.openfoodfacts.org/images/products/070/895/362/8172/front_en.3.400.jpg", canonicalBrand: "Lotus Foods", canonicalTitle: "Organic Millet & Brown Rice Ramen" },
  { pattern: /\bmarketside\s+butcher\b.*\borganic\b.*\bground\s+beef\b/i, url: "https://images.openfoodfacts.org/images/products/068/113/137/7416/front_en.3.400.jpg", canonicalBrand: "Marketside Butcher", canonicalTitle: "Organic Grass-Fed Ground Beef" },
  { pattern: /\bverde(?:\s+farms)?\b.*\bground\s+beef\b/i, url: "https://images.openfoodfacts.org/images/products/082/581/911/0319/front_en.14.400.jpg", canonicalBrand: "Verde Farms", canonicalTitle: "Organic Grass-Fed Ground Beef" },
  { pattern: /\bsmithfield\b(?!.*\b(?:bacon|sausage|spiral|sliced\s+deli|lunch\s*meat|deli|tenderloin|loin|chops?|ribs?|diced|cubed|shank|butt)\b).*\bham\s+steak\b/i, url: "https://images.openfoodfacts.org/images/products/020/634/010/5485/front_en.3.400.jpg", canonicalBrand: "Smithfield", canonicalTitle: "Boneless Ham Steak" },
  { pattern: /\bvital\s+farms\b(?!.*\b(?:bites?|butter|ghee|liquid|hard[- ]?boiled|peeled)\b).*\beggs?\b/i, url: "https://images.openfoodfacts.org/images/products/086/174/500/0010/front_en.27.400.jpg", canonicalBrand: "Vital Farms", canonicalTitle: "Pasture-Raised Large Eggs" },
  { pattern: /\borganic\s+valley\b(?!.*\b(?:chocolate|2%|1%|skim|fat\s*free|lowfat|eggnog|creamer|half\s*&?\s*half)\b).*\b(?:grassmilk|whole\s+milk)\b/i, url: "https://images.openfoodfacts.org/images/products/64715087/front_en.3.400.jpg", canonicalBrand: "Organic Valley", canonicalTitle: "Organic Whole Milk" },
  { pattern: /\bgreat\s+value\b(?!.*\b(?:chocolate|2%|1%|skim|fat\s*free|lowfat|almond|oat|organic|evaporated|condensed|powdered)\b).*\bwhole\b.*\bmilk\b/i, url: "https://images.openfoodfacts.org/images/products/007/874/215/9034/front_en.25.400.jpg", canonicalBrand: "Great Value", canonicalTitle: "Whole Vitamin D Milk" },
  { pattern: /\bgreat\s+value\b(?!.*\b(?:organic|unsalted)\b).*\bsweet\s+cream\b.*\bbutter\b/i, url: "https://images.openfoodfacts.org/images/products/007/874/202/5933/front_en.16.400.jpg", canonicalBrand: "Great Value", canonicalTitle: "Salted Sweet Cream Butter" },
  { pattern: /\bgreat\s+value\b(?!.*\borganic\b).*\blarge\s+white\s+eggs?\b/i, url: "https://images.openfoodfacts.org/images/products/007/874/233/0624/front_en.3.400.jpg", canonicalBrand: "Great Value", canonicalTitle: "Large White Eggs" },
  { pattern: /\bgreat\s+value\b(?!.*\b(?:deluxe|white\s+cheddar|three\s+cheese|thick|cups?|artisan)\b).*\b(?:macaroni|mac\s*(?:&|and)\s*cheese)\b/i, url: "https://images.openfoodfacts.org/images/products/007/874/235/8857/front_en.4.400.jpg", canonicalBrand: "Great Value", canonicalTitle: "Original Macaroni & Cheese" },
  { pattern: /\bgreat\s+value\b(?!.*\b(?:organic|no\s+salt|petite|fire\s+roasted|green\s+chilies)\b).*\bdiced\s+tomatoes\b/i, url: "https://images.openfoodfacts.org/images/products/007/874/202/0976/front_en.4.400.jpg", canonicalBrand: "Great Value", canonicalTitle: "Diced Tomatoes in Tomato Juice" },
  { pattern: /\bgreat\s+value\b.*\bpurified\b.*\bwater\b/i, url: "https://images.openfoodfacts.org/images/products/84464033/front_en.3.400.jpg", canonicalBrand: "Great Value", canonicalTitle: "Purified Drinking Water" },
  { pattern: /^(?!.*\b(?:chips?|crisps?|fries|tots|mashed|salad|dog|cat|pet|treats?|jerky|chews?|gerber|baby|toddler|puree|pouch|pie|soup|casserole|flour|noodles?|gnocchi|crackers?|puffs?|bites?)\b).*\b(?:sweet\s+potato(?:es)?|yams?)\b/i, url: "https://images.openfoodfacts.org/images/products/017/620/200/0336/front_en.7.400.jpg", canonicalBrand: "", canonicalTitle: "Fresh Whole Sweet Potatoes", wholeProduceOnly: true },
  { pattern: /^(?!.*\b(?:chips?|crisps?|fries|tots|mashed|salad|soup|chowder|hash|au\s+gratin|scalloped|flakes|flour|starch|gnocchi|vodka|bread|rolls?)\b).*\b(?:russet\s+potato(?:es)?|idaho\s+potato(?:es)?|yukon\s+gold\s+potato(?:es)?|red\s+potato(?:es)?|yellow\s+potato(?:es)?|butter\s+potato(?:es)?|potatoes,?\s+butter|fresh\s+whole\s+potato(?:es)?)\b/i, url: "https://images.openfoodfacts.org/images/products/007/078/401/2964/front_en.3.400.jpg", canonicalBrand: "", canonicalTitle: "Fresh Russet Potatoes", wholeProduceOnly: true },
  { pattern: /^(?!.*\b(?:peppers?|cheerios|cereal|oatmeal|granola|yogh?urt|skyr|kefir|pudding|bread|muffins?|chips?|boat|sunscreen|baby|gerber|toddler|pouch|puree|dog|cat|pet|treats?|bars?|bites?|cookies?|wafers?|pancakes?|waffles?|milk|smoothie|shake|ice\s+cream|popsicles?|candy|gummies|nut|foster|split|dried|freeze[- ]?dried|plantain)\b).*\b(?:fresh\s+bananas?|bananas)\b/i, url: "https://images.openfoodfacts.org/images/products/200/000/015/1418/front_en.3.400.jpg", canonicalBrand: "", canonicalTitle: "Fresh Bananas", wholeProduceOnly: true },
  { pattern: /^(?!.*\b(?:juice|cider|sauce|applesauce|pie|chips?|strudel|fritter|danish|turnover|bars?|cereal|oatmeal|baby|gerber|pouch|puree|vinegar|sliced|caramel|candy|yogurt|sausage)\b).*\b(?:honeycrisp\s+apples?|gala\s+apples?|fuji\s+apples?|granny\s+smith\s+apples?|fresh\s+apples?)\b/i, url: "https://images.openfoodfacts.org/images/products/002/290/630/0183/front_en.3.400.jpg", canonicalBrand: "", canonicalTitle: "Fresh Gala Honeycrisp Apples", wholeProduceOnly: true },
  { pattern: /\bezekiel\b(?!.*\b(?:tortillas?|english\s+muffins?|cereal|waffles?|buns?)\b).*\bbread\b/i, url: "local:public/swaps/bread.jpg", canonicalBrand: "Ezekiel 4:9", canonicalTitle: "Organic Sprouted Whole Grain Bread" },
  { pattern: /\brao'?s\b(?!.*\b(?:soup|pizza|alfredo|pesto|frozen|lasagna|meatballs?)\b).*\b(?:marinara|tomato\s+basil|arrabbiata|vodka\s+sauce|pasta\s+sauce)\b/i, url: "local:public/swaps/marinara.png", canonicalBrand: "Rao's Homemade", canonicalTitle: "Marinara Pasta Sauce" },
  { pattern: /\bapplegate\b.*\borganics?\b.*\bturkey\s+breast\b/i, url: "local:public/swaps/turkey.jpg", canonicalBrand: "Applegate Organics", canonicalTitle: "Organics Oven Roasted Turkey Breast" },
  { pattern: /\btrue\s+story\b.*\borganics?\b.*\bturkey\s+breast\b/i, url: "local:public/swaps/turkey.jpg", canonicalBrand: "True Story", canonicalTitle: "Organic Oven Roasted Turkey Breast" },
  { pattern: /\bchosen\s+foods\b(?!.*\b(?:spray|oil|dressing|chipotle|garlic|vegan)\b).*\b(?:mayo|mayonnaise)\b/i, url: "local:public/swaps/mayo.png", canonicalBrand: "Chosen Foods", canonicalTitle: "Classic Mayo Made With 100% Pure Avocado Oil" },
  { pattern: /^(?!.*\b(?:cake|juice|soup|puree|pouch|baby|gerber|dog|pet|treats?|pickled|sticks?|chips?|shredded|slaw)\b).*\b(?:baby\s+cut\s+carrots?|whole\s+carrots?|fresh\s+carrots?)\b/i, url: "https://images.openfoodfacts.org/images/products/003/582/608/6372/front_en.3.400.jpg", canonicalBrand: "", canonicalTitle: "Fresh Whole Baby Carrots", wholeProduceOnly: true },
  { pattern: /^(?!.*\b(?:breast|salad|wings?|pulled|shredded|soup|broth|nuggets?|bites?|seasoning|dog|cat|pet|treats?)\b).*\brotisserie\s+chicken\b/i, url: "local:public/swaps/turkey.jpg", canonicalBrand: "", canonicalTitle: "Whole Rotisserie Chicken", wholeProduceOnly: true },
  { pattern: /\bmember'?s\s+mark\b.*\b(?:breaded|southern\s+style|homestyle)\b.*\bchicken\b.*\bbites?\b/i, url: "local:public/swaps/nuggets.png", canonicalBrand: "Member's Mark", canonicalTitle: "Southern Style Chicken Bites" },
  { pattern: /\bmember'?s\s+mark\b(?!.*\b(?:turkey|bits|crumbled|wrapped|dip|macaroni)\b).*\bbacon\b/i, url: "local:public/swaps/bacon.png", canonicalBrand: "Member's Mark", canonicalTitle: "Hardwood Smoked Sliced Bacon" },
  { pattern: /^(?!.*\b(?:roast\s+beef|deli|sliced|jerky|broth|soup|stew|seasoning|gravy|dog|cat|pet|treats?)\b).*\b(?:bottom\s+round|top\s+round|eye\s+of\s+round|chuck|rump|sirloin\s+tip)\s+roast\b/i, url: "local:public/swaps/beef.png", canonicalBrand: "", canonicalTitle: "Fresh Beef Chuck Roast", wholeProduceOnly: true },
  { pattern: /^(?!.*\b(?:no\s+sugar|simply|organic|jalapeno|habanero|pickle|mayochup|kranch|mustard|relish|bbq|vinegar|gravy|beans)\b).*\bheinz\b.*\btomato\s+ketchup\b/i, url: "https://images.openfoodfacts.org/images/products/001/300/000/6408/front_en.26.400.jpg", canonicalBrand: "Heinz", canonicalTitle: "Tomato Ketchup" },
  { pattern: /^(?!.*\b(?:light|olive|avocado|vegan|plant|garlic|spicy|chipotle|drizzle|organic)\b).*\b(?:hellmann'?s|best\s+foods)\b.*\breal\s+(?:mayo|mayonnaise)\b/i, url: "https://images.openfoodfacts.org/images/products/004/800/121/3487/front_en.105.400.jpg", canonicalBrand: "Hellmann's", canonicalTitle: "Real Mayonnaise" },
  { pattern: /^(?!.*\b(?:banana|honey\s+nut|multi[- ]?grain|apple|chocolate|frosted|berry|protein|oat\s+crunch|cinnamon|peach|strawberry|vanilla|maple|veggie|pumpkin|ancient|bars?|treats?|nut)\b).*\bcheerios\b/i, url: "https://images.openfoodfacts.org/images/products/001/600/027/5287/front_en.8.400.jpg", canonicalBrand: "General Mills Cheerios", canonicalTitle: "Original Cheerios Toasted Whole Grain Oat Cereal" },
  { pattern: /^(?!.*\b(?:crunchy|extra\s+crunchy|natural|no\s+added|reduced|honey|chocolate|whips)\b).*\bjif\b.*\bcreamy\b.*\bpeanut\s+butter\b/i, url: "https://images.openfoodfacts.org/images/products/005/150/025/5162/front_en.197.400.jpg", canonicalBrand: "Jif", canonicalTitle: "Creamy Peanut Butter" },
  { pattern: /^(?!.*\b(?:honey|dijon|spicy|horseradish|creamy|stone\s+ground|organic)\b).*\bfrench'?s\b.*\byellow\s+mustard\b/i, url: "https://images.openfoodfacts.org/images/products/004/150/000/0251/front_en.9.400.jpg", canonicalBrand: "French's", canonicalTitle: "Classic Yellow Mustard" },
  { pattern: /^(?!.*\b(?:zero|diet|cherry|vanilla|caffeine[- ]?free|spiced|orange|lime|lemon|mexican|cane\s+sugar|life|coffee)\b).*\bcoca[- ]?cola\b.*\b(?:classic|original)\b/i, url: "https://images.openfoodfacts.org/images/products/004/900/002/8904/front_en.16.400.jpg", canonicalBrand: "Coca-Cola", canonicalTitle: "Coca-Cola Classic Original Soda" },
  { pattern: /^(?!.*\b(?:flip|zero\s+sugar|whole\s+milk|low[- ]?fat|vanilla|strawberry|blueberry|peach|mango|cherry|coconut|banana|lemon|key\s+lime|drink|complete|creamer|oat)\b).*\bchobani\b.*(?:\b(?:non[- ]?fat|nonfat)\b.*\bplain\b|\bplain\b.*\b(?:non[- ]?fat|nonfat)\b).*\bgreek\s+yogurt\b/i, url: "https://images.openfoodfacts.org/images/products/081/829/001/0469/front_en.4.400.jpg", canonicalBrand: "Chobani", canonicalTitle: "Plain Non-Fat Greek Yogurt" },
  { pattern: /^(?!.*\b(?:creamy|bisque|sipping|well\s+yes|chunky|homestyle|healthy\s+request|low\s+sodium|no\s+salt|heart\s+healthy|25%\s+less|organic|basil|roasted|rice)\b).*\bcampbell'?s\b.*(?:\bcondensed\b.*\btomato\b.*\bsoup\b|\bcondensed\b.*\bsoup\b.*\btomato\b)/i, url: "https://images.openfoodfacts.org/images/products/900/528/100/0115/front_en.3.400.jpg", canonicalBrand: "Campbell's", canonicalTitle: "Condensed Tomato Soup" },
  { pattern: /^(?!.*\b(?:b-ready|biscuits?|go|mini\s+cups?|ice\s+cream)\b).*\bnutella\b.*\b(?:hazelnut|spread)\b/i, url: "https://images.openfoodfacts.org/images/products/000/980/089/5007/front_en.106.400.jpg", canonicalBrand: "Ferrero Nutella", canonicalTitle: "Nutella Hazelnut Spread with Cocoa" },
];

const STOP_TOKENS = new Set([
  "the", "and", "with", "for", "oz", "fl", "lb", "lbs", "ct", "count", "pack", "pk",
  "flavored", "flavor",
  "grade", "category", "estimate", "verify", "package", "label", "rating", "ratings",
  "sweeteners", "sweetener", "creamery", "fresh", "each", "average", "price", "priced", "per", "pound",
  "snack", "size", "family", "party", "share", "fun", "giant", "king", "bag", "box",
  "pouch", "jar", "bottle", "can", "carton", "candy", "bars", "bar", "gourmet", "gift",
  "energy", "drink", "drinks", "pre", "workout", "preworkout", "fitness", "live", "fit",
  "performance", "clean", "renewable", "original", "classic", "dressing",
  "ready", "soda", "pop", "soft", "shake", "squeezed", "pure", "natural", "naturally", "artesian",
  "thirst", "quencher", "sports", "hydration", "chilled", "ultra", "filtered",
  "lactose", "free", "whole", "grains", "seeds", "simple", "plain", "low", "fat",
  "lowfat", "tangy",
]);

const TWO_CHAR_BRAND_TOKENS = new Set(["c4", "hu", "v8", "gt", "7up", "aw"]);

function distinctiveTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\btruffl\b/g, "truffles")
    .replace(/\bchocolat\b/g, "chocolate")
    .replace(/\bappl\b/g, "apples")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(
      (t) =>
        (t.length >= 3 || TWO_CHAR_BRAND_TOKENS.has(t)) &&
        !STOP_TOKENS.has(t) &&
        !/^\d+$/.test(t),
    );
}

const BLOCKED_ROTATED_OFF_IMAGE_RE =
  /\/10603499\/|\/468\/112\/060\/0422\/|\/009\/396\/600\/6469\/|\/022\/517\/201\/1436\/|\/002\/531\/700\/1106\/|\/002\/190\/811\/0110\/|\/074\/747\/900\/1199\/|\/019\/396\/833\/8879\/|\/007\/874\/226\/7043\/|\/007\/874\/200\/4709\//;

function headersForLocalAsset(
  relPath: string,
  contentType: string,
  options?: { transientRetry?: boolean },
): Record<string, string> {
  const isPlaceholder = relPath === PLACEHOLDER_SVG_REL_PATH;
  const isCategoryArt = relPath.startsWith("public/swaps/");
  const isRetryable = Boolean(isPlaceholder && options?.transientRetry);
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": isRetryable
      ? "public, max-age=30, s-maxage=60, stale-while-revalidate=120"
      : "public, max-age=86400",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "X-Image-Source, X-Image-License, X-Image-Kind, X-Image-Retry",
    "X-Image-Source": isPlaceholder
      ? "HeyBroc Placeholder (No Verified Package Photo)"
      : isCategoryArt
        ? "HeyBroc Category Studio Illustration"
        : "HeyBroc Verified Product Photo",
    "X-Image-License": "Proprietary",
    "X-Image-Kind": isPlaceholder ? "none" : isCategoryArt ? "category-art" : "photo",
  };
  if (isRetryable) {
    headers["X-Image-Retry"] = "1";
    headers["Retry-After"] = "30";
  }
  return headers;
}

async function serveLocalAsset(
  relPath: string,
  request: Request,
  options?: { transientRetry?: boolean },
): Promise<NextResponse> {
  const contentType = relPath.endsWith(".svg")
    ? "image/svg+xml"
    : relPath.endsWith(".png")
      ? "image/png"
      : "image/jpeg";
  try {
    const buf = await fs.readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), relPath));
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: headersForLocalAsset(relPath, contentType, options),
    });
  } catch {
    if (relPath === PLACEHOLDER_SVG_REL_PATH) {
      return missingStatusResponse(Boolean(options?.transientRetry));
    }
    const publicPath = relPath.replace(/^public/, "");
    return NextResponse.redirect(new URL(publicPath, request.url), 302);
  }
}

const deadOffUrlSet = new Set<string>();

function ensureImageCachesFreshForFetch(): void {
  if (process.env.NODE_ENV !== "production" && trackedImgFetchRef !== globalThis.fetch) {
    imageBytesCache.clear();
    imageBytesCacheTotalBytes = 0;
    imageUrlCache.clear();
    confirmedMissCache.clear();
    deadOffUrlSet.clear();
    trackedImgFetchRef = globalThis.fetch;
  }
}

const PRODUCE_DISQUALIFIER_RE =
  /\b(?:peppers?|cheerios|cereals?|oatmeal|granola|yogh?urts?|skyr|kefir|puddings?|baby\s+food|infant|toddler|gerber|beech[- ]?nut|happy\s+baby|plum\s+organics|once\s+upon\s+a\s+farm|earth'?s\s+best|pouch(?:es)?|purees?|mashed|dogs?|cats?|pets?|pupp(?:y|ies)|kittens?|treats?|kibble|biscuits?|chews?|jerky|blue\s+buffalo|purina|pedigree|milk[- ]?bone|mezzetta|vlasic|mt\.?\s*olive|bars?|bites?|muffins?|breads?|loaves|rolls?|buns?|bagels?|pancakes?|waffles?|crepes?|cakes?|pies?|tarts?|pastries|cookies?|crackers?|wafers?|pretzels?|popcorn|puffs?|chips?|crisps?|fries|tots|hash\s*browns?|gnocchi|pasta|ravioli|noodles?|soups?|broths?|stews?|chowders?|salads?|slaws?|dips?|salsas?|sauces?|ketchup|mustard|mayo|dressings?|pickled|pickles?|marinated|jarred|canned|rings?|nut|nuts|protein|shakes?|smoothies?|juices?|nectars?|ciders?|sodas?|waters?|teas?|coffees?|creamers?|milks?|ice\s+cream|gelato|sorbet|popsicles?|cand(?:y|ies)|gumm(?:y|ies)|snacks?|strips?|leathers?|seasonings?|powders?|flours?|starches|extracts?|syrups?|jams?|jell(?:y|ies)|preserves|spreads?|butters?|cheeses?|bacon|sausages?|hot\s*dogs?|sunscreen|boat|foster|split)\b/i;

const GENERIC_PRODUCE_BRAND_RE =
  /^(?:|usda|fresh(?:\s+produce|\s+meat|\s+fruit|\s+vegetables?)?|produce|unbranded|generic|walmart|kroger|target|aldi|publix|wegmans|heb|h-e-b|safeway|albertsons|meijer|whole\s+foods(?:\s+market)?|costco|sam'?s\s+club|bj'?s|marketside|good\s*(?:&|and)\s*gather|simple\s+truth(?:\s+organic)?|365(?:\s+by\s+whole\s+foods(?:\s+market)?)?|o\s+organics|nature'?s\s+promise|simply\s+nature)$/i;

const CURATED_PRODUCT_FORM_GUARD_WORDS = [
  "packet", "packets", "seasoning", "mix", "powder", "canister", "tub", "sticks", "stick", "pods", "concentrate",
  "dog", "cat", "puppy", "kitten", "pet", "treats", "treat", "baby", "toddler", "puree",
  "churros", "churro", "popcorn", "bunnies", "bunny", "crackers", "cracker", "cookies", "cookie",
  "bites", "bite", "bars", "bar", "rolls", "roll", "gummies", "chews",
  "bacon", "ground", "burgers", "burger", "patties", "patty", "sausage", "meatballs", "meatball",
  "vegan", "plant",
];

function passesCuratedPhotoGuard(
  rawQuery: string,
  rawBrand: string,
  entry: { canonicalBrand: string; canonicalTitle: string; wholeProduceOnly?: boolean },
): boolean {
  const qTrim = rawQuery.trim();
  const bTrim = rawBrand.trim();
  if (!qTrim) return false;

  if (entry.wholeProduceOnly) {
    if (PRODUCE_DISQUALIFIER_RE.test(qTrim) || PRODUCE_DISQUALIFIER_RE.test(bTrim)) {
      return false;
    }
    if (bTrim && !GENERIC_PRODUCE_BRAND_RE.test(bTrim)) {
      return false;
    }
    const detected = detectAllBrands(`${qTrim} ${bTrim}`);
    if (detected.some((b) => !GENERIC_PRODUCE_BRAND_RE.test(b.trim()))) {
      return false;
    }
    return true;
  }

  const candidateText = `${entry.canonicalBrand} ${entry.canonicalTitle}`.trim();
  if (!passesVariantGuard(qTrim, candidateText)) {
    return false;
  }
  if (hasConflictingBrand(qTrim, candidateText)) {
    return false;
  }
  if (
    bTrim &&
    !/^(?:usda|fresh\s+produce|fresh\s+meat|whole\s+nuts|category\s+estimate|scanned\s+product)$/i.test(bTrim)
  ) {
    if (hasConflictingBrand(bTrim, candidateText)) {
      return false;
    }
    const candHaystack = buildCandidateBrandHaystack(candidateText);
    const normBrand = normalizeBrandPhrase(bTrim);
    const brandWords = normBrand.split(" ").filter((w) => w.length >= 2 && w !== "the" && w !== "and");
    if (brandWords.length > 0 && !brandWords.some((w) => containsWholeBrandPhrase(candHaystack, w))) {
      return false;
    }
  }

  const qLower = qTrim.toLowerCase();
  const candLower = candidateText.toLowerCase();
  for (const word of CURATED_PRODUCT_FORM_GUARD_WORDS) {
    const wordRe = new RegExp(`\\b${word}\\b`, "i");
    if (wordRe.test(qLower) && !wordRe.test(candLower)) {
      return false;
    }
  }

  return true;
}

/**
 * Known US retail bottle/box UPCs for iconic national brands so that if a hardcoded
 * Open Food Facts image revision (.7.400.jpg -> .29.400.jpg) ages out, /api/product-image
 * resolves the live front-of-pack photo from Open Food Facts v2 by barcode in one hop.
 */
const KNOWN_CURATED_FALLBACK_UPCS: Array<{
  pattern: RegExp;
  upcs: string[];
  canonicalBrand: string;
  canonicalTitle: string;
}> = [
  {
    pattern:
      /\bhidden\s+valley\b(?!.*\b(?:fiesta|bacon|avocado|buffalo|chipotle|pickle|garlic|seasoning|packets?|mix|shaker|dry|dip|light|fat[- ]?free|plant|vegan|dairy[- ]?free|spicy|secret\s+sauce|organic)\b).*\branch\b/i,
    upcs: ["0071100003116", "071100003116", "0071100883534", "071100883534", "0071100212068", "071100212068", "0071100004199"],
    canonicalBrand: "Hidden Valley",
    canonicalTitle: "The Original Ranch Salad Dressing",
  },
  {
    pattern: /^(?!.*\b(?:no\s+sugar|simply|organic|jalapeno|habanero|pickle)\b).*\bheinz\b.*\bketchup\b/i,
    upcs: ["0013000006408", "013000006408", "0013000006057"],
    canonicalBrand: "Heinz",
    canonicalTitle: "Tomato Ketchup",
  },
  {
    pattern: /^(?!.*\b(?:light|olive|avocado|vegan|plant|garlic|spicy)\b).*\bhellmann'?s\b.*\b(?:real\s+)?(?:mayo|mayonnaise)\b/i,
    upcs: ["0048001213487", "048001213487", "0048001213562"],
    canonicalBrand: "Hellmann's",
    canonicalTitle: "Real Mayonnaise",
  },
  {
    pattern: /^(?!.*\b(?:crunchy|natural|no\s+added|reduced)\b).*\bjif\b.*\b(?:creamy\s+)?peanut\s+butter\b/i,
    upcs: ["0051500255162", "051500255162"],
    canonicalBrand: "Jif",
    canonicalTitle: "Creamy Peanut Butter",
  },
  {
    pattern: /^(?!.*\b(?:honey|dijon|spicy|horseradish|creamy|stone\s+ground|organic)\b).*\bfrench'?s\b.*\byellow\s+mustard\b/i,
    upcs: ["0041500000251", "041500000251", "1962200600000"],
    canonicalBrand: "French's",
    canonicalTitle: "Classic Yellow Mustard",
  },
  {
    pattern: /\bkraft\b(?!.*\b(?:deluxe|velveeta|three\s+cheese|white\s+cheddar|spirals|shapes|cups?|gluten[- ]?free|plant)\b).*\bmacaroni\s*(?:&|and)\s*cheese\b.*\boriginal\b/i,
    upcs: ["0021000033720", "021000033720", "0021000658831"],
    canonicalBrand: "Kraft",
    canonicalTitle: "Original Macaroni & Cheese Dinner",
  },
  {
    pattern: /\boreo\b(?!.*\b(?:mint|golden|double\s+stuf|mega\s+stuf|peanut\s+butter|thins|lemon|gluten[- ]?free|zero\s+sugar)\b).*\b(?:chocolate\s+sandwich\s+)?cookies?\b/i,
    upcs: ["0044000047009", "044000047009", "0044000032029"],
    canonicalBrand: "Oreo",
    canonicalTitle: "Chocolate Sandwich Cookies",
  },
  {
    pattern: /\bcheez[- ]?it\b(?!.*\b(?:white\s+cheddar|extra\s+toasty|snap'?d|puff'?d|grooves|duoz|reduced\s+fat)\b).*\boriginal\b/i,
    upcs: ["0024100122615", "024100122615", "0024100440702"],
    canonicalBrand: "Cheez-It",
    canonicalTitle: "Original Baked Snack Crackers",
  },
  {
    pattern: /\bdoritos\b.*\b(?:simply\s+nkd|nkd)\b.*\bnacho\s+cheese\b/i,
    upcs: ["0028400794756", "028400794756"],
    canonicalBrand: "Doritos",
    canonicalTitle: "Simply NKD Nacho Cheese Tortilla Chips",
  },
  {
    pattern: /\bdoritos\b.*\b(?:simply\s+nkd|nkd)\b.*\bcool\s+ranch\b/i,
    upcs: ["0028400794732", "028400794732"],
    canonicalBrand: "Doritos",
    canonicalTitle: "Simply NKD Cool Ranch Tortilla Chips",
  },
  {
    pattern: /\bdoritos\b(?!.*\b(?:simply|nkd|dinamita|3d|minis?|dip|flamin|spicy|taco|tapatio|organic|twisted|collisions)\b).*\bnacho\s+cheese\b/i,
    upcs: ["0028400090896", "028400090896", "0028400516464"],
    canonicalBrand: "Doritos",
    canonicalTitle: "Nacho Cheese Flavored Tortilla Chips",
  },
  {
    pattern: /\bdoritos\b(?!.*\b(?:simply|nkd|dinamita|3d|minis?|dip|flamin|spicy|taco|tapatio|organic|twisted|collisions)\b).*\bcool\s+ranch\b/i,
    upcs: ["0028400091510", "028400091510", "0028400516310"],
    canonicalBrand: "Doritos",
    canonicalTitle: "Cool Ranch Flavored Tortilla Chips",
  },
  {
    pattern: /^(?!.*\b(?:banana|honey\s+nut|multi[- ]?grain|apple|chocolate|frosted|berry|protein|oat\s+crunch|cinnamon|peach|strawberry|vanilla|maple|bars?|treats?|nut)\b).*\bcheerios\b/i,
    upcs: ["0016000275287", "016000275287"],
    canonicalBrand: "General Mills Cheerios",
    canonicalTitle: "Original Cheerios Cereal",
  },
  {
    pattern: /^(?!.*\b(?:zero|diet|cherry|vanilla|caffeine[- ]?free|spiced|orange|lime|lemon|mexican|cane\s+sugar)\b).*\bcoca[- ]?cola\b/i,
    upcs: ["0049000028904", "049000028904"],
    canonicalBrand: "Coca-Cola",
    canonicalTitle: "Coca-Cola Classic Soda",
  },
  {
    pattern: /\bchobani\b(?!.*\b(?:flip|zero\s+sugar|whole\s+milk|low[- ]?fat|vanilla|strawberry|blueberry|peach|mango|cherry|coconut|banana|lemon|key\s+lime|drink|complete|creamer|oat)\b).*\bplain\b.*\bgreek\s+yogurt\b/i,
    upcs: ["0818290010469"],
    canonicalBrand: "Chobani",
    canonicalTitle: "Plain Non-Fat Greek Yogurt",
  },
  {
    pattern: /^(?!.*\b(?:creamy|bisque|sipping|well\s+yes|chunky|homestyle|healthy\s+request|low\s+sodium|no\s+salt|organic|basil|roasted|rice)\b).*\bcampbell'?s\b.*(?:\bcondensed\b.*\btomato\b.*\bsoup\b|\bcondensed\b.*\bsoup\b.*\btomato\b)/i,
    upcs: ["9005281000115"],
    canonicalBrand: "Campbell's",
    canonicalTitle: "Condensed Tomato Soup",
  },
  {
    pattern: /\bnutella\b(?!.*\b(?:b-ready|biscuits?|go|mini\s+cups?|ice\s+cream)\b)/i,
    upcs: ["0009800895007", "009800895007"],
    canonicalBrand: "Ferrero Nutella",
    canonicalTitle: "Nutella Hazelnut Spread with Cocoa",
  },
];

function extractOffCodeFromImageUrl(rawUrl: string): string | null {
  const m = rawUrl.match(/\/images\/products\/([0-9/]+)\/front/i);
  if (!m?.[1]) return null;
  const digits = m[1].replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}

function expandBarcodeCandidates(codes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of codes) {
    const clean = raw.replace(/\D/g, "");
    if (clean.length < 8 || clean.length > 14) continue;
    const variants = [clean];
    if (clean.length === 12) variants.push(`0${clean}`);
    if (clean.length === 13 && clean.startsWith("0")) variants.push(clean.slice(1));
    for (const v of variants) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  return out.slice(0, 8);
}

interface OffImageProductRecord {
  code?: string;
  product_name?: string;
  product_name_en?: string;
  brands?: string | string[];
  countries_tags?: string[];
  image_front_small_url?: string;
  image_front_url?: string;
  image_url?: string;
  selected_images?: {
    front?: {
      display?: Record<string, string | undefined>;
      small?: Record<string, string | undefined>;
    };
  };
  images?: Record<string, { imgid?: string | number; rev?: string | number } | undefined>;
}

function pickCandidateImageUrls(p: OffImageProductRecord): string[] {
  const tags = Array.isArray(p.countries_tags)
    ? p.countries_tags.map((t) => String(t).trim().toLowerCase())
    : [];
  const isNorthAmerica =
    isUsMarketOffProduct(p) || tags.includes("en:united-states") || tags.includes("en:canada");

  const panelImgIds = new Set<string>();
  if (p.images) {
    for (const [k, meta] of Object.entries(p.images)) {
      if (/^(?:ingredients|nutrition|packaging)(?:_|$)/i.test(k) && meta?.imgid !== undefined) {
        panelImgIds.add(String(meta.imgid));
      }
    }
  }
  const isPanelNumericUrl = (u?: string): boolean => {
    if (!u) return false;
    const m = u.match(/\/(\d+)(?:\.\d+)?\.(?:jpg|jpeg|png|webp)$/i);
    return Boolean(m && panelImgIds.has(m[1]));
  };

  const rawList: Array<string | undefined> = [
    p.selected_images?.front?.display?.en,
    p.selected_images?.front?.small?.en,
    p.image_front_small_url,
    p.image_front_url,
    p.image_url,
  ].filter((u) => !isPanelNumericUrl(u));

  if (isNorthAmerica) {
    rawList.push(
      p.selected_images?.front?.display?.es,
      p.selected_images?.front?.small?.es,
      p.selected_images?.front?.display?.fr,
      p.selected_images?.front?.small?.fr,
    );
  }

  // Fallback to first raw uploaded photo (`images["1"]`, `images["2"]`, ...) not assigned to nutrition/ingredients panels
  if (p.images && p.code) {
    const folder = offBarcodeFolderPath(p.code);
    if (folder) {
      const rawNumericKeys = Object.keys(p.images)
        .filter((k) => /^\d+$/.test(k) && !panelImgIds.has(k))
        .sort((a, b) => Number(a) - Number(b));
      for (const imgKey of rawNumericKeys.slice(0, 2)) {
        rawList.push(`https://images.openfoodfacts.org/images/products/${folder}/${imgKey}.400.jpg`);
      }
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of rawList) {
    if (!u || seen.has(u)) continue;
    if (deadOffUrlSet.has(u) || BLOCKED_ROTATED_OFF_IMAGE_RE.test(u) || !isAllowedImageUrl(u, isNorthAmerica)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

async function fetchAndVerifyImageBytes(
  candidateUrl: string,
  onTransientError?: () => void,
): Promise<{ bytes: ArrayBuffer; contentType: string; sourceUrl: string } | null> {
  if (!candidateUrl || deadOffUrlSet.has(candidateUrl) || !isAllowedImageUrl(candidateUrl, true)) {
    return null;
  }
  try {
    const imgRes = await fetch(candidateUrl, {
      headers: { "User-Agent": "HeyBroc/2.1 (https://www.heybroc.com)" },
      signal: AbortSignal.timeout(4200),
    });
    if (!imgRes.ok) {
      if (imgRes.status === 404 || imgRes.status === 410) {
        if (deadOffUrlSet.size >= 1000) deadOffUrlSet.clear();
        deadOffUrlSet.add(candidateUrl);
      } else if (imgRes.status === 429 || imgRes.status >= 500) {
        onTransientError?.();
      }
      return null;
    }
    const contentType = (imgRes.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    const contentLength = Number(imgRes.headers.get("content-length") || "0");
    if (
      !contentType.startsWith("image/") ||
      contentType.toLowerCase().includes("svg") ||
      (contentLength > 0 && contentLength > MAX_IMAGE_BYTES)
    ) {
      return null;
    }
    const bytes = await imgRes.arrayBuffer();
    if (bytes.byteLength <= 200 || bytes.byteLength > MAX_IMAGE_BYTES) {
      return null;
    }
    return { bytes, contentType, sourceUrl: candidateUrl };
  } catch {
    onTransientError?.();
    return null;
  }
}

const GENERIC_PACK_CATEGORY_WORDS = new Set([
  "dressing", "dressings", "condiment", "condiments", "topping", "dip",
  "baked", "snack", "snacks", "crackers", "cracker", "sandwich", "cookies", "cookie",
  "tortilla", "potato", "chips", "chip", "crisps", "cereal", "sweetened", "breakfast",
  "pasta", "macaroni", "sauce", "spread", "yogurt", "beverage", "beverages",
  "soda", "water", "milk", "juice", "cheese", "butter", "bread", "rolls", "buns",
  "grocery", "food", "foods", "creamy", "real",
]);

const CONFLICTING_PRODUCT_FORM_WORDS = [
  "seasoning", "packet", "packets", "mix", "powder", "shaker",
  "salad", "wings", "wing", "nuggets", "nugget", "tenders", "bites", "shredded", "pulled", "turkey",
  "dog", "cat", "puppy", "kitten", "shampoo", "conditioner", "lotion", "candle",
];

function brandTokensOf(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['’®™©]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => (t.length >= 2 || TWO_CHAR_BRAND_TOKENS.has(t)) && t !== "the" && t !== "and" && !/^\d+$/.test(t));
}

function matchesPackagePhotoCandidate(
  rawQuery: string,
  cleanQuery: string,
  conciseQuery: string,
  rawBrand: string,
  candidateBrands: string,
  candidateProductName: string,
): boolean {
  const candidateTitle = `${candidateBrands} ${candidateProductName}`.trim();
  if (!candidateTitle) return false;
  if (!passesVariantGuard(rawQuery, candidateTitle)) return false;

  // Never put an Organic package photo onto a non-organic query
  if (/\borganic\b/i.test(candidateTitle) && !/\borganic\b/i.test(rawQuery)) {
    return false;
  }

  const qLower = rawQuery.toLowerCase();
  const cLower = candidateTitle.toLowerCase();
  for (const formWord of CONFLICTING_PRODUCT_FORM_WORDS) {
    const re = new RegExp(`\\b${formWord}\\b`, "i");
    if (re.test(cLower) && !re.test(qLower)) {
      return false;
    }
  }

  if (
    hasProductIdentityMatch(conciseQuery, candidateTitle) ||
    hasProductIdentityMatch(cleanQuery, candidateTitle) ||
    hasProductIdentityMatch(rawQuery, candidateTitle)
  ) {
    return true;
  }

  const candAllTokens = new Set(brandTokensOf(candidateTitle));
  const candBrandToks = brandTokensOf(candidateBrands);
  const queryAllToks = brandTokensOf(cleanQuery || rawQuery);
  if (queryAllToks.length === 0) return false;

  const usableExplicitBrand =
    rawBrand &&
    !/^(usda|fresh\s+produce|fresh\s+meat|whole\s+nuts|category\s+estimate|scanned\s+product)/i.test(rawBrand)
      ? brandTokensOf(rawBrand)
      : [];

  const requiredBrandToks =
    usableExplicitBrand.length > 0 ? usableExplicitBrand.slice(0, 2) : queryAllToks.slice(0, 1);

  if (requiredBrandToks.length === 0 || !requiredBrandToks.every((bt) => candAllTokens.has(bt))) {
    return false;
  }

  if (candBrandToks.length > 0) {
    const qBrandUnion = new Set([...queryAllToks, ...usableExplicitBrand]);
    if (!qBrandUnion.has(candBrandToks[0])) {
      return false;
    }
  }

  const brandSet = new Set(requiredBrandToks);
  const nonBrandDistinctive = distinctiveTokens(cleanQuery || rawQuery).filter((t) => !brandSet.has(t));
  const coreProductToks = nonBrandDistinctive.filter((t) => !GENERIC_PACK_CATEGORY_WORDS.has(t));

  if (coreProductToks.length === 0) {
    if (usableExplicitBrand.length === 0 && candBrandToks.length === 0) return false;
    const anyCategoryOverlap = nonBrandDistinctive.some((t) => candAllTokens.has(t));
    return anyCategoryOverlap || (candBrandToks.length > 0 && requiredBrandToks.every((bt) => candBrandToks.includes(bt)));
  }

  const matchedCore = coreProductToks.filter((t) => candAllTokens.has(t)).length;
  const neededCore = coreProductToks.length >= 3 ? Math.ceil(coreProductToks.length * 0.6) : coreProductToks.length;
  return matchedCore >= neededCore;
}

async function fetchVerifiedImageByBarcodes(
  codes: string[],
  rawQuery: string,
  trustExactScannedCode = false,
  onOperationalFailure?: () => void,
): Promise<{ bytes: ArrayBuffer; contentType: string; sourceUrl: string } | null> {
  const expanded = expandBarcodeCandidates(codes);
  for (const code of expanded) {
    const v2Url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=code,product_name,product_name_en,brands,countries_tags,selected_images,images,image_front_url,image_front_small_url,image_url`;
    if (!(await consumeSharedOffBudget(v2Url))) {
      onOperationalFailure?.();
      break;
    }
    try {
      const res = await fetch(v2Url, {
        headers: { "User-Agent": "HeyBroc/2.1 (https://www.heybroc.com)" },
        signal: AbortSignal.timeout(3600),
      });
      if (!res.ok) {
        if (res.status === 429) {
          onOperationalFailure?.();
          await reportSharedOffRateLimited();
          break;
        }
        if (res.status >= 500) {
          onOperationalFailure?.();
        }
        continue;
      }
      const data = (await res.json()) as { status?: number; product?: OffImageProductRecord };
      if (data.status !== 1 || !data.product) continue;
      const p = data.product;
      if (rawQuery && !trustExactScannedCode) {
        const brandsStr = Array.isArray(p.brands) ? p.brands.join(" ") : p.brands || "";
        const candidateTitle = `${brandsStr} ${p.product_name_en || p.product_name || ""}`.trim();
        if (candidateTitle && /\borganic\b/i.test(candidateTitle) && !/\borganic\b/i.test(rawQuery)) {
          continue;
        }
      }
      const urls = pickCandidateImageUrls(p);
      for (const candidateUrl of urls) {
        const verified = await fetchAndVerifyImageBytes(candidateUrl, onOperationalFailure);
        if (verified) return verified;
      }
    } catch {
      onOperationalFailure?.();
    }
  }
  return null;
}

type ResolvedProductMedia =
  | { kind: "local"; relPath: string }
  | { kind: "remote"; bytes: ArrayBuffer; contentType: string; sourceUrl: string }
  | { kind: "confirmed-miss" }
  | { kind: "transient-miss" };

function shouldPersistImageKv(): boolean {
  return isPersistentKvConfigured() || process.env.HEYBROC_TEST_IMAGE_KV === "1";
}

async function resolveVerifiedProductMedia(
  rawQuery: string,
  rawCode: string,
  rawBrand: string,
): Promise<ResolvedProductMedia> {
  ensureImageCachesFreshForFetch();
  const cacheKey = `${rawQuery.toLowerCase()}|${rawCode}|${rawBrand.toLowerCase()}`;
  const cachedBytes = imageBytesCache.get(cacheKey);
  if (cachedBytes) {
    // Refresh LRU recency
    imageBytesCache.delete(cacheKey);
    imageBytesCache.set(cacheKey, cachedBytes);
    return { kind: "remote", ...cachedBytes };
  }

  let hadOperationalFailure = false;
  const markFailure = () => {
    hadOperationalFailure = true;
  };

  const storeInBytesCache = (entry: { bytes: ArrayBuffer; contentType: string; sourceUrl: string }) => {
    const entrySize = entry.bytes.byteLength;
    if (entrySize > MAX_IMAGE_BYTES_CACHE_TOTAL) return;
    const prev = imageBytesCache.get(cacheKey);
    if (prev) {
      imageBytesCacheTotalBytes = Math.max(0, imageBytesCacheTotalBytes - prev.bytes.byteLength);
      imageBytesCache.delete(cacheKey);
    }
    while (
      imageBytesCache.size >= 350 ||
      imageBytesCacheTotalBytes + entrySize > MAX_IMAGE_BYTES_CACHE_TOTAL
    ) {
      const oldestKey = imageBytesCache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestVal = imageBytesCache.get(oldestKey);
      if (oldestVal) {
        imageBytesCacheTotalBytes = Math.max(0, imageBytesCacheTotalBytes - oldestVal.bytes.byteLength);
      }
      imageBytesCache.delete(oldestKey);
    }
    imageBytesCache.set(cacheKey, entry);
    imageBytesCacheTotalBytes += entrySize;
  };

  // 1. Curated verified matches (instant local swap studio photos or self-healing Open Food Facts URLs)
  if (rawQuery) {
    for (const entry of VERIFIED_PRODUCT_IMAGES) {
      if (entry.pattern.test(rawQuery) && passesCuratedPhotoGuard(rawQuery, rawBrand, entry)) {
        const verifiedUrl = entry.url;
        if (verifiedUrl.startsWith("local:")) {
          return { kind: "local", relPath: verifiedUrl.slice("local:".length) };
        }
        if (!BLOCKED_ROTATED_OFF_IMAGE_RE.test(verifiedUrl)) {
          const directBytes = await fetchAndVerifyImageBytes(verifiedUrl, markFailure);
          if (directBytes) {
            storeInBytesCache(directBytes);
            return { kind: "remote", ...directBytes };
          }
        }
        // Self-heal if Open Food Facts incremented the image revision (.7.400.jpg -> .29.400.jpg)
        const recoveryCodes: string[] = [];
        const embeddedCode = extractOffCodeFromImageUrl(verifiedUrl);
        if (embeddedCode) recoveryCodes.push(embeddedCode);
        for (const upcEntry of KNOWN_CURATED_FALLBACK_UPCS) {
          if (upcEntry.pattern.test(rawQuery) && passesCuratedPhotoGuard(rawQuery, rawBrand, upcEntry)) {
            recoveryCodes.push(...upcEntry.upcs);
          }
        }
        if (recoveryCodes.length > 0) {
          const healed = await fetchVerifiedImageByBarcodes(recoveryCodes, rawQuery, false, markFailure);
          if (healed) {
            storeInBytesCache(healed);
            return { kind: "remote", ...healed };
          }
        }
        break;
      }
    }
  }

  const clean = rawQuery
    .replace(/\(category\s+estimate[^)]*\)/gi, " ")
    .replace(/\(representative\s+formulation[^)]*\)/gi, " ")
    .replace(/\([^)]*$/g, " ")
    .replace(/\b(natural\s+sweeteners|creamery\s+butter|conventional\s+grocery)\b/gi, " ")
    .replace(/\s*,\s*ratings?\b/gi, " ")
    .replace(/\b(\d+(\.\d+)?\s*(oz|fl\s*oz|lb|lbs|ct|count|pack|pk|g|kg|ml|l|cup|bag|box|can|jar|bottle|as|assorted)s?)\b/gi, " ")
    .replace(/\bpack\s+of\s+\d+\b/gi, " ")
    .replace(/\b(snack\s+size|family\s+size|party\s+size|share\s+size|fun\s+size|candy\s+bag|candy\s+bars?|gourmet\s+gift\s+box)\b/gi, " ")
    .replace(/\btruffl\.*/gi, "Truffles")
    .replace(/\bchocolat\.*/gi, "Chocolate")
    .replace(/\bappl\.*/gi, "Apples")
    .replace(/[.,•|\-–—…]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const urlCacheKey = `${clean.toLowerCase()}|${rawCode}|${rawBrand.toLowerCase()}`;
  const kvImgKey = `heybroc:img_url:v2:${urlCacheKey}`;
  const kvMissKey = `heybroc:img_miss:v2:${urlCacheKey}`;

  // 2. Check positive & 24-hour negative caches before touching index or live OFF quota
  const memMissExpires = confirmedMissCache.get(urlCacheKey);
  if (memMissExpires && Date.now() < memMissExpires) {
    return { kind: "confirmed-miss" };
  }
  if (memMissExpires) confirmedMissCache.delete(urlCacheKey);

  let cachedUrl = imageUrlCache.get(urlCacheKey);
  if (!cachedUrl && shouldPersistImageKv()) {
    try {
      const fromKv = await kvGet<string>(kvImgKey);
      if (typeof fromKv === "string" && fromKv && isAllowedImageUrl(fromKv, true)) {
        cachedUrl = fromKv;
        imageUrlCache.set(urlCacheKey, fromKv);
      } else {
        const missFromKv = await kvGet<{ miss?: boolean }>(kvMissKey);
        if (missFromKv?.miss) {
          confirmedMissCache.set(urlCacheKey, Date.now() + CONFIRMED_MISS_TTL_SECONDS * 1000);
          return { kind: "confirmed-miss" };
        }
      }
    } catch {
      // Best-effort KV read
    }
  }
  if (cachedUrl) {
    const verifiedCached = await fetchAndVerifyImageBytes(cachedUrl, markFailure);
    if (verifiedCached) {
      storeInBytesCache(verifiedCached);
      return { kind: "remote", ...verifiedCached };
    }
    imageUrlCache.delete(urlCacheKey);
  }

  // 3. Check prebuilt US/Canada Open Food Facts photo index (barcode first, then variant-guarded brand+title)
  const indexHit = await lookupOffPhotoIndex({
    barcode: rawCode,
    title: rawQuery || clean,
    brand: rawBrand,
  });
  if (indexHit?.imageUrl && !BLOCKED_ROTATED_OFF_IMAGE_RE.test(indexHit.imageUrl)) {
    const indexBytes = await fetchAndVerifyImageBytes(indexHit.imageUrl, markFailure);
    if (indexBytes) {
      imageUrlCache.set(urlCacheKey, indexHit.imageUrl);
      if (shouldPersistImageKv()) {
        kvSet(kvImgKey, indexHit.imageUrl, 7 * 24 * 60 * 60).catch(() => {});
      }
      storeInBytesCache(indexBytes);
      return { kind: "remote", ...indexBytes };
    }
  }

  // 4. Direct UPC / GTIN barcode lookup against Open Food Facts Product v2
  const barcodeQueue: string[] = [];
  if (rawCode.length >= 8 && rawCode.length <= 14) {
    barcodeQueue.push(rawCode);
  }
  if (rawQuery) {
    for (const upcEntry of KNOWN_CURATED_FALLBACK_UPCS) {
      if (upcEntry.pattern.test(rawQuery) && passesCuratedPhotoGuard(rawQuery, rawBrand, upcEntry)) {
        barcodeQueue.push(...upcEntry.upcs);
      }
    }
  }
  if (barcodeQueue.length > 0) {
    const byCode = await fetchVerifiedImageByBarcodes(barcodeQueue, rawQuery, rawCode.length >= 8, markFailure);
    if (byCode) {
      imageUrlCache.set(urlCacheKey, byCode.sourceUrl);
      if (shouldPersistImageKv()) {
        kvSet(kvImgKey, byCode.sourceUrl, 7 * 24 * 60 * 60).catch(() => {});
      }
      storeInBytesCache(byCode);
      return { kind: "remote", ...byCode };
    }
  }

  const recordConfirmedOrTransientMiss = (): ResolvedProductMedia => {
    if (hadOperationalFailure) {
      return { kind: "transient-miss" };
    }
    if (confirmedMissCache.size >= 1500) {
      const oldest = confirmedMissCache.keys().next().value;
      if (oldest !== undefined) confirmedMissCache.delete(oldest);
    }
    confirmedMissCache.set(urlCacheKey, Date.now() + CONFIRMED_MISS_TTL_SECONDS * 1000);
    if (shouldPersistImageKv()) {
      kvSet(kvMissKey, { miss: true, at: Date.now() }, CONFIRMED_MISS_TTL_SECONDS).catch(() => {});
    }
    return { kind: "confirmed-miss" };
  };

  if (!rawQuery) {
    return recordConfirmedOrTransientMiss();
  }

  const tokens = distinctiveTokens(clean);
  if (tokens.length < 1) {
    return recordConfirmedOrTransientMiss();
  }

  const conciseQuery = tokens.slice(0, 4).join(" ");
  const coreWithoutGenericCategory = tokens.filter((t, idx) => idx === 0 || !GENERIC_PACK_CATEGORY_WORDS.has(t)).slice(0, 4).join(" ");
  const queriesToTry: string[] = [];
  const pushQuery = (qStr: string) => {
    const trimmed = qStr.trim();
    if (trimmed && !queriesToTry.includes(trimmed)) queriesToTry.push(trimmed);
  };

  pushQuery(conciseQuery);
  if (coreWithoutGenericCategory && coreWithoutGenericCategory !== conciseQuery) {
    pushQuery(coreWithoutGenericCategory);
  }
  if (clean.toLowerCase() !== conciseQuery) {
    pushQuery(clean);
  }
  if (tokens.length >= 3) {
    pushQuery(`brands_tags:"${tokens[0]}-${tokens[1]}" ${tokens.slice(2, 5).join(" ")}`);
  }
  if (tokens.length >= 2) {
    pushQuery(`brands_tags:"${tokens[0]}" ${tokens.slice(1, 4).join(" ")}`);
  }

  const sortUsFirst = (list: OffImageProductRecord[]) =>
    list.slice().sort((a, b) => {
      const aUs = Array.isArray(a.countries_tags) && a.countries_tags.includes("en:united-states") ? 1 : 0;
      const bUs = Array.isArray(b.countries_tags) && b.countries_tags.includes("en:united-states") ? 1 : 0;
      return bUs - aUs;
    });

  const verifyMatchingHits = async (hits: OffImageProductRecord[]) => {
    const sorted = sortUsFirst(hits);
    for (const p of sorted) {
      const urls = pickCandidateImageUrls(p);
      if (urls.length === 0) continue;
      const brandsStr = Array.isArray(p.brands) ? p.brands.join(" ") : p.brands || "";
      const prodName = p.product_name_en || p.product_name || "";
      if (!matchesPackagePhotoCandidate(rawQuery, clean, conciseQuery, rawBrand, brandsStr, prodName)) {
        continue;
      }
      for (const candidateUrl of urls) {
        const verified = await fetchAndVerifyImageBytes(candidateUrl, markFailure);
        if (verified) {
          if (imageUrlCache.size >= 1000) {
            const oldest = imageUrlCache.keys().next().value;
            if (oldest !== undefined) imageUrlCache.delete(oldest);
          }
          imageUrlCache.set(urlCacheKey, candidateUrl);
          if (shouldPersistImageKv()) {
            kvSet(kvImgKey, candidateUrl, 7 * 24 * 60 * 60).catch(() => {});
          }
          storeInBytesCache(verified);
          return verified;
        }
      }
    }
    return null;
  };

  // 5. Last-resort live Open Food Facts Search-a-licious v3 + CGI fallback within a single 2.5s ceiling
  const searchDeadline = Date.now() + OFF_IMAGE_SEARCH_DEADLINE_MS;
  let searchV3Succeeded = false;
  for (const searchQ of queriesToTry.slice(0, 1)) {
    const remainingMs = searchDeadline - Date.now();
    if (remainingMs < 250) {
      markFailure();
      break;
    }
    const offUrl = `https://search.openfoodfacts.org/search?q=${encodeURIComponent(searchQ)}&page_size=14&fields=code,product_name,product_name_en,brands,countries_tags,image_front_small_url,image_front_url,selected_images,images`;
    if (!(await consumeSharedOffBudget(offUrl))) {
      markFailure();
      break;
    }
    try {
      const res = await fetch(offUrl, {
        headers: { "User-Agent": "HeyBroc/2.1 (https://www.heybroc.com)" },
        signal: AbortSignal.timeout(Math.min(1500, remainingMs)),
      });
      if (res.ok) {
        searchV3Succeeded = true;
        const data = (await res.json()) as { hits?: OffImageProductRecord[] };
        const matched = await verifyMatchingHits(data.hits || []);
        if (matched) {
          return { kind: "remote", ...matched };
        }
      } else if (res.status === 429) {
        markFailure();
        await reportSharedOffRateLimited();
        break;
      } else if (res.status >= 500) {
        markFailure();
      }
    } catch {
      markFailure();
    }
  }

  // Fallback to v2 CGI search ONLY if Search v3 failed operationally AND >= 400ms remains in the 2.5s budget
  const cgiTerms = coreWithoutGenericCategory || conciseQuery;
  const cgiRemainingMs = searchDeadline - Date.now();
  if (!searchV3Succeeded && cgiTerms && cgiRemainingMs >= 400) {
    const cgiUrl = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(cgiTerms)}&search_simple=1&action=process&json=1&page_size=14&fields=code,product_name,product_name_en,brands,countries_tags,image_front_small_url,image_front_url,selected_images,images`;
    if (await consumeSharedOffBudget(cgiUrl)) {
      try {
        const res = await fetch(cgiUrl, {
          headers: { "User-Agent": "HeyBroc/2.1 (https://www.heybroc.com)" },
          signal: AbortSignal.timeout(cgiRemainingMs),
        });
        if (res.ok) {
          const data = (await res.json()) as { products?: OffImageProductRecord[] };
          const matched = await verifyMatchingHits(data.products || []);
          if (matched) {
            return { kind: "remote", ...matched };
          }
        } else if (res.status === 429) {
          markFailure();
          await reportSharedOffRateLimited();
        } else if (res.status >= 500) {
          markFailure();
        }
      } catch {
        markFailure();
      }
    } else {
      markFailure();
    }
  }

  return recordConfirmedOrTransientMiss();
}

function offAttributionHeaders(contentType: string, sourceUrl: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=604800, immutable",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "X-Image-Source, X-Image-License, X-Image-Attribution, X-Image-Kind, X-Image-Retry",
    "X-Image-Source": `Open Food Facts (${sourceUrl})`,
    "X-Image-License": "CC BY-SA 3.0 (https://world.openfoodfacts.org/terms-of-use)",
    "X-Image-Attribution": "Open Food Facts contributors (CC BY-SA 3.0)",
    "X-Image-Kind": "photo",
  };
}

function missingStatusResponse(transientRetry: boolean, imageKind: "none" | "category-art" = "none"): NextResponse {
  const headers: Record<string, string> = {
    "Cache-Control": transientRetry ? "no-store, no-cache, must-revalidate" : "public, max-age=86400",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "X-Image-Source, X-Image-License, X-Image-Kind, X-Image-Retry",
    "X-Image-Source":
      imageKind === "category-art"
        ? "HeyBroc Category Studio Illustration"
        : "HeyBroc Placeholder (No Verified Package Photo)",
    "X-Image-License": "Proprietary",
    "X-Image-Kind": imageKind,
  };
  if (transientRetry) {
    headers["X-Image-Retry"] = "1";
    headers["Retry-After"] = "30";
    headers["CDN-Cache-Control"] = "public, s-maxage=30";
  }
  return new NextResponse(null, { status: transientRetry ? 503 : 404, headers });
}

export async function GET(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "anon";
  if (!(await checkRateLimitAsync(`img:${ip}`, 300))) {
    return new NextResponse("Too many requests", {
      status: 429,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "X-Image-Retry",
        "X-Image-Retry": "1",
      },
    });
  }
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || searchParams.get("title") || "").trim().slice(0, 160);
  const rawCode = (searchParams.get("code") || searchParams.get("barcode") || "").replace(/\D/g, "").slice(0, 14);
  const rawBrand = (searchParams.get("brand") || "").trim().slice(0, 80);
  const wants404OnMiss = searchParams.get("fallback") === "404";
  if (!q && rawCode.length < 8) {
    return new NextResponse("Missing query", { status: 400 });
  }

  const resolved = await resolveVerifiedProductMedia(q, rawCode, rawBrand);
  if (resolved.kind === "local") {
    if (wants404OnMiss && resolved.relPath.startsWith("public/swaps/")) {
      return missingStatusResponse(false, "category-art");
    }
    return serveLocalAsset(resolved.relPath, request);
  }
  if (resolved.kind === "remote") {
    return new NextResponse(resolved.bytes, {
      status: 200,
      headers: offAttributionHeaders(resolved.contentType, resolved.sourceUrl),
    });
  }

  const isTransient = resolved.kind === "transient-miss";
  if (wants404OnMiss) {
    return missingStatusResponse(isTransient);
  }
  return serveLocalAsset(PLACEHOLDER_SVG_REL_PATH, request, { transientRetry: isTransient });
}

export async function HEAD(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "anon";
  if (!(await checkRateLimitAsync(`img:${ip}`, 300))) {
    return new NextResponse(null, {
      status: 429,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "X-Image-Retry",
        "X-Image-Retry": "1",
      },
    });
  }
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || searchParams.get("title") || "").trim().slice(0, 160);
  const rawCode = (searchParams.get("code") || searchParams.get("barcode") || "").replace(/\D/g, "").slice(0, 14);
  const rawBrand = (searchParams.get("brand") || "").trim().slice(0, 80);
  const wants404OnMiss = searchParams.get("fallback") === "404";
  if (!q && rawCode.length < 8) {
    return new NextResponse(null, { status: 400 });
  }

  const resolved = await resolveVerifiedProductMedia(q, rawCode, rawBrand);
  if (resolved.kind === "local") {
    const relPath = resolved.relPath;
    if (wants404OnMiss && relPath.startsWith("public/swaps/")) {
      return missingStatusResponse(false, "category-art");
    }
    return new NextResponse(null, {
      status: 200,
      headers: headersForLocalAsset(relPath, relPath.endsWith(".png") ? "image/png" : "image/jpeg"),
    });
  }
  if (resolved.kind === "remote") {
    return new NextResponse(null, {
      status: 200,
      headers: offAttributionHeaders(resolved.contentType, resolved.sourceUrl),
    });
  }

  const isTransient = resolved.kind === "transient-miss";
  if (wants404OnMiss) {
    return missingStatusResponse(isTransient);
  }
  return new NextResponse(null, {
    status: 200,
    headers: headersForLocalAsset(PLACEHOLDER_SVG_REL_PATH, "image/svg+xml", { transientRetry: isTransient }),
  });
}
