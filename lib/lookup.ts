/**
 * CleanCart / HeyBroc — Universal Product Lookup + Local Cache (server-only)
 * --------------------------------------------------------------------------
 * Resolution order:
 *   1. rawIngredients read from the user's screen  -> score immediately (no network)
 *   2. Local cache (in-memory Map + JSON file)      -> <5ms, $0
 *   3. Validated OFF / USDA / NIH DSLD candidates raced within one 1800ms budget
 *      Barcode lookups also check Open Beauty / Products / Pet Food Facts.
 *   4. Fresh, variant-guarded catalog / whole-food resolvers, otherwise no match
 * We never scrape Walmart / Instacart / Target / Kroger / ALDI from the server.
 */
import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { extractOffNutrition as readOffNutrition, extractUsdaNutrition as readUsdaNutrition, classifyWholeFood, type UsdaFood } from "./nutrition";
import { lookupDsld, SUPPLEMENT_FORM } from "./dsld";
import { isPersistentKvConfigured, kvGet, kvIncrWithPExpire, kvSet } from "./storage";
import { promises as fs } from "fs";
import path from "path";
import {
  SHARED_BRAND_PATTERNS,
  collapseSingleLetterCompounds,
  normalizeBrandPhrase,
  containsWholeBrandPhrase,
  buildCandidateBrandHaystack,
  detectFirstBrand,
  detectAllBrands,
} from "./brands";
import {
  hasConflictingBrand,
  hasValidCatalogProvenance,
  isCatalogEntryFresh,
  matchDrinkCatalog,
  passesVariantGuard,
} from "./drinks-catalog";
import { lookupCuratedPhoto } from "./curated-product-photos";
import { offBarcodeFolderPath } from "./off-photo-index";
import {
  ENGLISH_INGREDIENT_ANCHORS,
  isEnglishIngredientText,
  NON_ENGLISH_INGREDIENTS,
  inferNutritionFromText,
  type NutritionInput,
} from "./rubric";

export { collapseSingleLetterCompounds, ENGLISH_INGREDIENT_ANCHORS, isEnglishIngredientText, NON_ENGLISH_INGREDIENTS };
export const isInstantCatalogEntryFresh = isCatalogEntryFresh;

export type LookupSource = "screen" | "cache" | "openfoodfacts" | "usda" | "catalog" | "dsld" | "openbeautyfacts" | "openproductsfacts" | "openpetfoodfacts";

export interface LookupInput {
  productTitle?: string;
  barcode?: string;
  rawIngredients?: string;
  isBatch?: boolean;
}

export interface LookupResult {
  sourceUrl?: string;
  productTitle: string;
  brand?: string;
  category?: string;
  description?: string;
  barcode?: string;
  ingredients: string;
  imageUrl?: string;
  offCategoriesTags?: string[];
  nutrition?: NutritionInput;
  source: LookupSource;
  /** Where the cached entry originally came from (when source === "cache"). */
  origin?: LookupSource;
  /** ISO date (YYYY-MM-DD) when the upstream record or catalog entry was last updated/verified. */
  sourceUpdatedAt?: string | null;
  ms: number;
}

type CacheEntry = Omit<LookupResult, "ms" | "origin" | "source"> & { source: LookupSource; cachedAt: string; schemaVersion?: number };

const USER_AGENT = "HeyBroc-CleanCart/1.1 (ingredient grader; https://heybroc.com)";
const CACHE_DIR =
  process.env.CLEANCART_CACHE_DIR ||
  (process.env.VERCEL ? "/tmp/cleancart-cache" : path.join(process.cwd(), ".cache"));
const CACHE_FILE = path.join(CACHE_DIR, "lookup-cache.json");
const TIMEOUT_MS = 1800;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;
const offBarcodeCache = new Map<string, { product: OffProduct | null; cachedAt: number }>();

let memory: Map<string, CacheEntry> | null = null;
let loading: Promise<Map<string, CacheEntry>> | null = null;

function isFreshCacheEntry(entry?: CacheEntry): entry is CacheEntry {
  if (!entry || entry.schemaVersion !== 3 || entry.source === "catalog" || !entry.ingredients?.trim()) return false;
  if (!isEnglishIngredientText(entry.ingredients)) return false;
  const ts = Date.parse(entry.cachedAt || "");
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts <= CACHE_TTL_MS;
}

async function loadCache(): Promise<Map<string, CacheEntry>> {
  if (memory) return memory;
  if (process.env.NODE_ENV === "test") return memory = new Map();
  if (!loading) {
    loading = (async () => {
      try {
        const json = JSON.parse(await fs.readFile(CACHE_FILE, "utf8")) as Record<string, CacheEntry>;
        const valid = Object.entries(json).filter(([, entry]) => isFreshCacheEntry(entry));
        memory = new Map(valid.slice(-MAX_CACHE_ENTRIES));
      } catch {
        memory = new Map();
      }
      return memory;
    })();
  }
  return loading;
}

async function persistCache(cache: Map<string, CacheEntry>) {
  if (process.env.NODE_ENV === "test") return;
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(cache), null, 2));
  } catch {
    // Read-only filesystems (e.g. serverless) fall back to in-memory cache only.
  }
}

function setCacheEntry(cache: Map<string, CacheEntry>, key: string, entry: CacheEntry) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

const CANONICAL_BRAND_PATTERNS: RegExp[] = SHARED_BRAND_PATTERNS;

/**
 * Normalizes punctuation/apostrophe/hyphen brand shorthands ("totinos" -> "Totino's",
 * "pop tarts" -> "Pop-Tarts", "cola coca" -> "Coca-Cola") and canonicalizes reversed
 * `<Food> <Brand>` queries ("Flour tortillas mission" -> "Mission Flour tortillas")
 * so word-order permutations resolve to the exact same cache key, provider query, and score.
 */
export function canonicalizeGroceryQuery(raw: string): string {
  let q = raw
    .replace(/[’‘]/g, "'")
    .replace(/^(?:\d+\s+)?in\s+(?:cart|bag|basket|order)\s*[-–—:,]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!q) return "";

  q = q
    .replace(/\brotiss\.?\s+chicken\b/gi, "Rotisserie Chicken")
    .replace(/\bcola\s+coca\b/gi, "Coca-Cola")
    .replace(/\bcoca\s+cola\b/gi, "Coca-Cola")
    .replace(/\bpop[\s-]+tarts?\b/gi, "Pop-Tarts")
    .replace(/\bcheez[\s-]+its?\b/gi, "Cheez-It")
    .replace(/\bh[aä]agen[\s-]+dazs\b/gi, "Haagen-Dazs")
    .replace(/\bore[\s-]+ida\b/gi, "Ore-Ida")
    .replace(/\bwish[\s-]+bone\b/gi, "Wish-Bone")
    .replace(/\bjennie[\s-]+o\b/gi, "Jennie-O")
    .replace(/\bhealth[\s-]+ade\b/gi, "Health-Ade")
    .replace(/\btotinos\b/gi, "Totino's")
    .replace(/\bsmuckers\b/gi, "Smucker's")
    .replace(/\bcampbells\b/gi, "Campbell's")
    .replace(/\bhellmanns\b/gi, "Hellmann's")
    .replace(/\bfrenchs\b/gi, "French's")
    .replace(/\bhunts\b/gi, "Hunt's")
    .replace(/\bwelchs\b/gi, "Welch's")
    .replace(/\bmotts\b/gi, "Mott's")
    .replace(/\braos\b/gi, "Rao's")
    .replace(/\breeses\b/gi, "Reese's")
    .replace(/\bhersheys\b/gi, "Hershey's")
    .replace(/\bkelloggs\b/gi, "Kellogg's")
    .replace(/\bstouffers\b/gi, "Stouffer's")
    .replace(/\bannies\b/gi, "Annie's")
    .replace(/\bamys\b/gi, "Amy's")
    .replace(/\bdaves\s+killer\b/gi, "Dave's Killer")
    .replace(/\bmartins\b/gi, "Martin's")
    .replace(/\bfranks\s+red\s*hot\b/gi, "Frank's RedHot")
    .replace(/\blays(?!\s+(?:flat|eggs?)\b)\b/gi, "Lay's");

  const words = q.split(/\s+/);
  if (
    words.length < 2 ||
    words.length > 7 ||
    /[,|:]/.test(q) ||
    /^(?:diet|mexican|white\s+monster|sugar[\s-]*free|zero\s+sugar)\b/i.test(q)
  ) {
    return q;
  }

  const withoutLeadingOrganic = q.replace(/^organic\s+/i, "");
  const alreadyStartsWithBrand = CANONICAL_BRAND_PATTERNS.some((re) => {
    const anchored = new RegExp(`^(?:${re.source})`, "i");
    return anchored.test(q) || anchored.test(withoutLeadingOrganic);
  });
  if (alreadyStartsWithBrand) return q;

  for (const brandRe of CANONICAL_BRAND_PATTERNS) {
    const m = brandRe.exec(q);
    if (m && m.index > 0) {
      const brandText = m[0].trim();
      const rest = `${q.slice(0, m.index)} ${q.slice(m.index + m[0].length)}`.replace(/\s+/g, " ").trim();
      if (rest) {
        return `${brandText} ${rest}`;
      }
    }
  }
  return q;
}

/** Joins `brand` and `title` while deduplicating overlapping sub-brand tokens (e.g. "Kellogg's Eggo" + "Eggo Homestyle Waffles"). */
export function mergeBrandAndTitle(brand: string | undefined, title: string): string {
  const b = (brand || "").trim();
  const t = title.trim();
  if (!b) return t;
  if (!t) return b;
  const norm = (w: string) => w.toLowerCase().replace(/['’]s\b/g, "s").replace(/[^a-z0-9]+/g, "");
  if (norm(t).startsWith(norm(b)) || t.toLowerCase().includes(b.toLowerCase())) return t;
  const bWords = b.split(/\s+/);
  const tWords = t.split(/\s+/);
  const maxOverlap = Math.min(bWords.length, tWords.length);
  for (let k = maxOverlap; k >= 1; k--) {
    const suffixMatchesPrefix = bWords
      .slice(bWords.length - k)
      .every((bw, idx) => norm(bw) === norm(tWords[idx]));
    if (suffixMatchesPrefix) {
      return [...bWords, ...tWords.slice(k)].join(" ");
    }
  }
  return `${b} ${t}`;
}

export function normalizeBarcode(raw?: string): string {
  const digits = (raw || "").replace(/\D/g, "");
  if (!/^\d{8,14}$/.test(digits)) return "";
  if (digits.length === 14 && digits.startsWith("00")) return digits.slice(2);
  if (digits.length === 14 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

export function cacheKey(input: LookupInput): string | null {
  const normCode = normalizeBarcode(input.barcode);
  const canonical = canonicalizeGroceryQuery(input.productTitle || "");
  const t = collapseSingleLetterCompounds(canonical)
    .toLowerCase()
    .replace(/['’]s\b/g, "s")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (normCode && t) return `upc:${normCode}|title:${t}`;
  if (normCode) return `upc:${normCode}`;
  return t ? `title:${t}` : null;
}

/* ------------------------------------------------------------------ */
/* Relevance helpers                                                   */
/* ------------------------------------------------------------------ */

const STOP = new Set(["the", "and", "with", "for", "oz", "fl", "lb", "lbs", "gal", "gallon", "half", "quart", "pint", "pack", "count", "ct", "of", "size", "family", "pkg", "tray"]);
/** Descriptors that appear on thousands of products and must not carry a match on their own. */
const GENERIC = new Set(["original", "classic", "natural", "flavored", "flavor", "plain", "whole", "lowfat", "nonfat", "reduced", "fat", "low", "made", "sea", "salt", "style", "brand", "real", "homemade", "homestyle", "fresh", "pure", "grade", "usda"]);

const GENERIC_LEADING_MODIFIERS = new Set([
  ...GENERIC,
  "organic", "free", "lean",
  "large", "medium", "small", "baby", "mini", "jumbo", "extra", "super",
  "red", "green", "yellow", "white", "black", "brown", "golden", "dark", "light",
  "sweet", "hot", "mild", "spicy", "sour", "salted", "unsalted", "roasted", "sharp",
  "creamy", "crunchy", "chunky", "smooth", "whipped", "crispy", "thick", "thin",
  "sparkling", "distilled", "purified", "mineral", "carbonated", "still", "iced", "brewed",
  "sliced", "diced", "chopped", "shredded", "crushed", "peeled", "minced", "ground",
  "frozen", "canned", "raw", "cooked", "baked", "fried", "grilled", "smoked", "cured", "rotisserie",
  "rolled", "evaporated", "condensed", "instant", "dry", "dried",
  "boneless", "skinless", "seedless", "pitted", "hulled",
  "cage", "pasture", "grass",
  "unflavored", "unsweetened", "sweetened", "skim", "gluten", "dairy", "sugar", "zero", "diet",
  "pack", "bag", "box", "can", "jar", "bottle", "tub", "carton", "pouch",
  "vegan", "vegetarian", "keto", "paleo", "kosher", "halal", "plant", "based", "lite", "less", "non",
  "gmo", "lactose", "decaf", "high", "protein",
]);

const SHORT_BRAND_TOKENS = new Set(["hu", "v8", "gv", "bj", "kc", "365", "rx"]);

/** Keeps short brand tokens, letter+digit codes ("a1", "v8"), and drops numbers/stopwords. */
function keepToken(t: string): boolean {
  if (!t) return false;
  if (SHORT_BRAND_TOKENS.has(t)) return true;
  if (STOP.has(t) || /^\d+$/.test(t)) return false;
  return t.length >= 3 || /^[a-z]\d$/.test(t);
}
let usdaUnavailableUntil = 0;
let dsldUnavailableUntil = 0;
const providerSignal = new AsyncLocalStorage<AbortSignal>();

export function tokens(s: string): string[] {
  return collapseSingleLetterCompounds(s)
    .toLowerCase()
    .replace(/['’]s\b/g, "s")
    .replace(/['’]/g, "")
    .replace(/\bcr[eè]me\b/g, "cream")
    .replace(/\bhot\s+dogs?\b/g, "hotdog")
    .replace(/\bpop[\s-]+tarts?\b/g, "poptart")
    .replace(/\bcheez[\s-]+its?\b/g, "cheezit")
    .replace(/\bcoca[\s-]+cola\b/g, "cocacola")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(keepToken);
}

const SYNONYM_GROUPS: string[][] = [
  ["mayo", "mayonnaise"],
  ["mac", "macaroni"],
  ["veggie", "veggies", "vegetable", "vegetables"],
  ["ketchup", "catsup"],
  ["yogurt", "yoghurt"],
  ["donut", "donuts", "doughnut", "doughnuts"],
  ["lite", "light"],
  ["salsa", "picante"],
  ["cocacola", "coke"],
  ["hotdog", "hotdogs", "wiener", "wieners", "frank", "franks", "frankfurter", "frankfurters"],
];

function tokenEquivalent(a: string, b: string): boolean {
  if (a === b || a === `${b}s` || a === `${b}es` || b === `${a}s` || b === `${a}es`) return true;
  if (a.endsWith("y") && a.length >= 4 && b === `${a.slice(0, -1)}ies`) return true;
  if (b.endsWith("y") && b.length >= 4 && a === `${b.slice(0, -1)}ies`) return true;
  for (const group of SYNONYM_GROUPS) {
    if (group.includes(a) && group.includes(b)) return true;
  }
  return false;
}

const FLAVOR_TOKENS = new Set([
  "strawberry", "strawberries", "vanilla", "chocolate", "blueberry", "blueberries",
  "raspberry", "raspberries", "peach", "mango", "banana", "cherry", "cherries", "apple", "cinnamon", "honey",
  "caramel", "frosted", "peanut", "almond", "almondmilk", "soy", "soymilk", "oatmilk",
  "cashew", "hazelnut", "coconut", "lemon", "lime",
  "orange", "grape", "watermelon", "mint", "coffee", "mocha", "maple", "brown",
  "bbq", "barbecue", "sour", "cheddar", "nacho", "ranch", "spicy", "flamin",
  "hot", "buffalo", "jalapeno", "garlic", "onion", "teriyaki", "flip",
  "alfredo", "pesto", "vodka", "bolognese",
  "chipotle", "habanero", "sriracha", "tartar",
]);

const INCOMPATIBLE_DISH_OR_SAUCE_BASES: Array<{ token: string; allowedIfQueryHas?: string[] }> = [
  { token: "pesto" },
  { token: "alfredo" },
  { token: "vodka" },
  { token: "carbonara" },
  { token: "clam" },
  { token: "bolognese" },
  { token: "enchilada" },
  { token: "verde", allowedIfQueryHas: ["verde", "green", "tomatillo"] },
  { token: "tartar" },
  { token: "teriyaki" },
  { token: "hoisin" },
  { token: "bbq", allowedIfQueryHas: ["bbq", "barbecue"] },
  { token: "barbecue", allowedIfQueryHas: ["bbq", "barbecue"] },
  { token: "guacamole" },
  { token: "hummus" },
  { token: "ranch" },
  { token: "caesar" },
  { token: "mustard" },
  { token: "mayonnaise", allowedIfQueryHas: ["mayo", "mayonnaise"] },
  { token: "mayo", allowedIfQueryHas: ["mayo", "mayonnaise"] },
  { token: "ketchup", allowedIfQueryHas: ["ketchup", "catsup"] },
  { token: "relish" },
];

const INHERENTLY_ORGANIC_BRAND_RE =
  /\b(annie'?s|amy'?s|stonyfield|organic\s+valley|simple\s+truth\s+organic|dave'?s\s+killer|lotus\s+foods|health[- ]?ade|kettle\s*&\s*fire|muir\s+glen|newman'?s\s+own|honest\s+kids|harmless\s+harvest|gt'?s|applegate\s+organics)\b/i;

const PLAIN_TOKENS = new Set(["plain", "unsweetened", "unflavored"]);

function classifyTitleForm(raw: string): { hasBeverageForm: boolean; hasSolidForm: boolean } {
  const s = raw
    .toLowerCase()
    .replace(/\bcoca[\s-]+cola\b/g, "cocacola")
    .replace(/\bdr\.?\s*pepper\b/g, "drpepper")
    .replace(/\bcoffee[\s-]*mate\b/g, "coffeemate")
    .replace(/\bbaking\s+soda\b/g, " ")
    .replace(/\bsoda\s+crackers?\b/g, "crackers")
    .replace(/\bmilk\s+chocolate\b/g, "chocolate")
    .replace(/\bbuttermilk\b/g, " ")
    .replace(/\b(?:condensed|evaporated|powdered|dry)\s+milk\b/g, " ")
    .replace(/\bcoffee\s+cake\b/g, "cake")
    .replace(/\btea\s+(?:cake|biscuits?|cookies?)\b/g, "cookies")
    .replace(/\broot\s+beer\s+(?:barrels?|cand(?:y|ies)|float\s+bars?|popsicles?)\b/g, "candy")
    .replace(/\bapple\s+cider\s+(?:vinegar|donuts?|doughnuts?|gummies)\b/g, (m) => m.replace(/^apple\s+cider\s+/, ""))
    .replace(
      /\b(?:in|with|made\s+with|sweetened\s+with)\s+(?:100%\s+)?(?:real\s+)?(?:fruit\s+|white\s+grape\s+|apple\s+|pear\s+|pineapple\s+|lemon\s+)?juices?(?:\s+from\s+concentrate)?\b/g,
      " ",
    )
    .replace(/\b(?:lemon|lime)\s+juice\b/g, " ")
    .replace(/\bcookies?\s*(?:&|and|'n'?)\s*cre(?:am|me)\b/g, " ")
    .replace(/\bcookie\s+dough\b/g, " ")
    .replace(/\b(?:cake|brownie)\s+batter\b/g, " ")
    .replace(/\b(?:peanut|almond|cashew|sunflower|cocoa|shea|apple|cookie)\s+butter\b/g, " ")
    .replace(/\bbutter\s+(?:pecan|toffee|scotch)\b/g, " ");

  const hasBeverageForm =
    /\b(soda|cola|soft\s+drinks?|energy\s+drinks?|sports\s+drinks?|drinks?|beverages?|juices?|lemonade|limeade|orangeade|smoothies?|(?:protein|nutrition|meal|milk)\s+shakes?|milkshakes?|milks?|oatmilk|almondmilk|soymilk|coconutmilk|cashewmilk|seltzers?|sparkling\s+water|mineral\s+water|spring\s+water|purified\s+water|electrolyte\s+water|coconut\s+water|tonic\s+water|club\s+soda|root\s+beer|ginger\s+ale|ginger\s+beer|kombucha|iced\s+tea|sweet\s+tea|green\s+tea|black\s+tea|herbal\s+tea|chamomile\s+tea|cold\s+brew|espresso|latte|frappuccino|cappuccino|macchiato|cider)\b/.test(
      s,
    );
  const hasSolidForm =
    /\b(cookies?|crackers?|chips?|crisps?|pretzels?|popcorn|bars?|brownies?|cakes?|cheesecakes?|cupcakes?|muffins?|donuts?|doughnuts?|pastr(?:y|ies)|pies?|tarts?|poptarts?|waffles?|pancakes?|bread|bagels?|rolls?|buns?|tortillas?|wraps?|tostadas?|pasta|noodles?|ramen|cereal|granola|oatmeal|gummies|marshmallows?|cand(?:y|ies)|ice\s+cream|gelato|sorbet|yogurt|cheese|butter|margarine|jerky|bacon|sausage|franks?|wieners?|hot\s+dogs?|nuggets?|tenders?|strips?|patties|burgers?|pizza|burritos?|sandwiches?|uncrustables?|soup|stew|chili|sauce|salsa|ketchup|mayo|mayonnaise|mustard|dressing|hummus|dip|jam|jelly|preserves|frosting)\b/.test(
      s,
    );
  return { hasBeverageForm, hasSolidForm };
}

/**
 * 0–1 relevance of a candidate product name to the user's query. Only distinctive tokens
 * count; short queries (≤2 distinctive tokens) must match all of them.
 * Enforces leading brand token consistency, trailing product noun match, and flavor consistency.
 */
export function relevance(query: string, candidate: string, categoryTags?: string[]): number {
  const cleanQuery = query.replace(/\bhot\s+(?:cocoa|chocolate|pockets?|fudge|cereal)\b/gi, (m) => m.replace(/^hot\s+/i, ""));
  const cleanCandidate = candidate.replace(/\bhot\s+(?:cocoa|chocolate|pockets?|fudge|cereal)\b/gi, (m) => m.replace(/^hot\s+/i, ""));
  const all = tokens(cleanQuery);
  const q = all.filter((t) => !GENERIC.has(t));
  const pool = q.length ? q : all;
  if (!pool.length) return 0;
  const c = tokens(cleanCandidate);
  const catTokens = (categoryTags || [])
    .filter((tag) => tag.startsWith("en:"))
    .flatMap((tag) => tokens(tag.slice(3)));
  const cWithCats = catTokens.length ? [...c, ...catTokens] : c;
  const hasIn = (list: string[], t: string) => list.some((x) => tokenEquivalent(x, t));

  // Bidirectional beverage-vs-solid form taxonomy guard (e.g. "Coca-Cola Oreo Soda" vs "OREO Coca-Cola Sandwich Cookies")
  const qForm = classifyTitleForm(query);
  const cForm = classifyTitleForm(candidate);
  if (qForm.hasBeverageForm && !qForm.hasSolidForm && cForm.hasSolidForm) return 0;
  if (qForm.hasSolidForm && !qForm.hasBeverageForm && cForm.hasBeverageForm) return 0;

  // Prevent cross-category novel spin-offs (e.g. "Oatmeal Creme Pies" matching "Oatmeal Creme Pies Cereal" or "Nutty Bars Ice Cream")
  const FORM_FACTOR_TOKENS = ["cereal", "ice", "seasoning", "syrup", "creamer", "frosting", "powder", "supplement", "kcup", "pods", "milkshake", "slurpee"];
  // Hard-reject only when the query names its OWN product form (pies, bars, cookies…); otherwise a brand's
  // own product ("Old Bay" seasoning, "Tajin", "Frosted Flakes" cereal) only takes a soft penalty.
  const queryFormText = cleanQuery.toLowerCase().replace(/\bcoffee[\s-]*mate\b/g, " ");
  const queryNamesOwnForm =
    /\b(pies?|bars?|cookies?|chips?|crackers?|cakes?|cupcakes?|candy|candies|brownies?|donuts?|doughnuts?|muffins?|pastr(?:y|ies)|bread|soda|drinks?|juice|milk|yogurt|cheese|sauce|soup|pretzels?|popcorn|gum|cones?|sandwich(?:es)?|ice\s+cream|waffles?|pancakes?|tarts?|poptarts?)\b/.test(
      queryFormText,
    );
  let formFactorPenalty = 0;
  for (const ff of FORM_FACTOR_TOKENS) {
    if (hasIn(c, ff) && !hasIn(all, ff)) {
      if (queryNamesOwnForm) return 0;
      formFactorPenalty = 0.3;
    }
  }

  const candLower = candidate.toLowerCase();
  const queryLower = query.toLowerCase();

  // Variety packs / samplers never stand in for a single product unless the shopper asked for one.
  // Homogeneous multipacks ("Multi-Pack", "Multipack") of a single flavor remain eligible.
  const VARIETY_RE = /\b(variety|assorted|assortment|sampler|mix(?:ed)?\s+pack)\b/;
  if (VARIETY_RE.test(candLower) && !VARIETY_RE.test(queryLower)) {
    return 0;
  }

  // Protein species & meat-identity exclusivity (blocks "Hickory Smoked Bacon" -> "Hickory Smoked Turkey Breast", etc.)
  if (/\bturkey\b/.test(candLower) && !/\bturkey\b/.test(queryLower)) return 0;
  if (/\bturkey\b/.test(queryLower) && /\b(chicken|beef|pork|ham|salmon|tuna)\b/.test(candLower) && !/\bturkey\b/.test(candLower)) return 0;
  if (/\bbacon\b/.test(candLower) && !/\bbacon\b/.test(queryLower) && /\b(chicken|turkey|beef|pork|ham|sausage|steak|roast)\b/.test(queryLower)) return 0;
  if (
    /\bbacon\b/.test(queryLower) &&
    !/\b(turkey|canadian|wrapped|scallops?|tenderloin|dip|mac|macaroni|cheese|bits|seasoning|dressing|ranch|soup|burger|beans)\b/.test(queryLower) &&
    /\b(turkey|canadian|wrapped|scallops?|tenderloin|dip|mac|macaroni|cheese|seasoning|dressing|ranch|soup|burger|beans)\b/.test(candLower)
  ) {
    return 0;
  }

  // Poultry / meat cut, dish-form, and breaded-vs-grilled exclusivity
  // (blocks "Lightly Breaded Chicken Breast Bites" -> "Fire Grilled Chicken Breasts", "Rotisserie Chicken" -> "Shredded Breast" / "Wings" / "Salad")
  const BITE_NUGGET_FORM_RE = /\b(bites?|nuggets?|tenders?|strips?|poppers?|chunks?|fritters?|patties)\b/;
  if (BITE_NUGGET_FORM_RE.test(queryLower) && /\b(chicken|turkey|fish|shrimp|cauliflower)\b/.test(queryLower) && !BITE_NUGGET_FORM_RE.test(candLower)) {
    return 0;
  }
  if (BITE_NUGGET_FORM_RE.test(candLower) && !BITE_NUGGET_FORM_RE.test(queryLower) && /\b(chicken|turkey|beef|pork|rotisserie|fish|salmon)\b/.test(queryLower)) {
    return 0;
  }
  if (/\bwings?\b/.test(candLower) && !/\bwings?\b/.test(queryLower)) return 0;
  if (
    /\bsalad\b/.test(candLower) &&
    !/\b(salad|dressing|ranch|caesar|vinaigrette|italian|thousand\s+island|coleslaw|greens|romaine|spinach|arugula|spring\s+mix)\b/.test(queryLower)
  ) {
    return 0;
  }
  if (
    /\brotisserie\b/.test(queryLower) &&
    /\bchicken\b/.test(queryLower) &&
    !/\b(breast|breasts|shredded|pulled|strips?|bites?|salad|wings?|soup|broth|seasoning)\b/.test(queryLower) &&
    /\b(breast|breasts|shredded|pulled|salad|wings?|soup|broth|seasoning)\b/.test(candLower)
  ) {
    return 0;
  }
  if (
    /\b(bottom\s+round|top\s+round|eye\s+of\s+round|chuck|rump|sirloin\s+tip|pork\s+loin|pork\s+shoulder)\s+roast\b/.test(queryLower) &&
    /\b(roast\s+beef|deli|sliced|jerky|sandwich)\b/.test(candLower)
  ) {
    return 0;
  }
  if (/\b(breaded|battered|tempura)\b/.test(queryLower)) {
    if (/\b(fire\s+grilled|grilled|rotisserie|unbreaded|naked)\b/.test(candLower)) return 0;
    if (!/\b(breaded|battered|tempura|crispy|fried|southern|homestyle|nuggets?|tenders?|strips?|bites?|poppers?|patties|fillets?|cutlets?|sticks?|fish|popcorn)\b/.test(candLower)) {
      return 0;
    }
  } else if (/\b(fire\s+grilled|grilled|rotisserie|unbreaded)\b/.test(queryLower) && !/\bcrispy\b/.test(queryLower)) {
    if (/\b(breaded|battered|tempura)\b/.test(candLower)) return 0;
  }

  // Reject baking-flour spin-offs ("Quaker Oat Flour" for "Quaker oats") unless query asked for flour or candidate is tortillas/bread/pasta/crackers
  if (
    /\bflour\b/.test(candLower) &&
    !/\bflour\b/.test(queryLower) &&
    !/\b(tortillas?|wraps?|bread|pasta|noodles?|crackers?|pretzels?|cookies?|waffles?|muffins?|pizza)\b/.test(candLower)
  ) {
    return 0;
  }

  // Reject prepared sandwiches / Uncrustables ("Peanut butter & strawberry jam sandwich soft bread") when query asks for jam/butter/spread
  if (
    /\b(sandwich(?:es)?|uncrustables?)\b/.test(candLower) &&
    !/\b(sandwich|uncrustable|cookies?|oreo|crackers?|ice\s+cream|bread|rolls?|buns?)\b/.test(queryLower)
  ) {
    return 0;
  }

  // Hard-reject incompatible sauce/condiment/dish bases in title OR category tags when unrequested (e.g. "Prego Basil Pesto" or en:pestos)
  for (const { token, allowedIfQueryHas } of INCOMPATIBLE_DISH_OR_SAUCE_BASES) {
    if (hasIn(cWithCats, token)) {
      const allowed = allowedIfQueryHas || [token];
      if (!allowed.some((a) => hasIn(all, a))) {
        return 0;
      }
    }
  }

  // Leading Brand / Anchor Token Guard: if the query starts with a distinctive brand/anchor token
  // (e.g. "Rao's", "Freihofer's", "Little Debbie", "Wegmans", "Wellsley"), the candidate title MUST match it!
  if (all.length >= 2 && !GENERIC_LEADING_MODIFIERS.has(all[0])) {
    if (!hasIn(c, all[0])) {
      return 0;
    }
  }

  // Core Food Head-Noun Guard: when the trailing product noun is a primary meat/dairy/egg/water/bakery staple,
  // matching an adjective like "smoked" or "hickory" alone is never sufficient — the food identity noun itself must match!
  const CORE_HEAD_FOOD_NOUNS = new Set([
    "bacon", "ham", "sausage", "sausages", "hotdog", "hotdogs", "jerky",
    "turkey", "chicken", "beef", "pork", "salmon", "tuna", "shrimp", "cod", "tilapia",
    "eggs", "egg", "milk", "butter", "yogurt", "yoghurt", "water",
    "bread", "bagels", "bagel", "tortillas", "tortilla", "waffles", "waffle", "pancakes", "pancake",
    "soup", "broth", "stock", "ketchup", "mustard", "mayo", "mayonnaise", "salsa",
  ]);
  const trailingFoodNoun = pool[pool.length - 1];
  if (trailingFoodNoun && CORE_HEAD_FOOD_NOUNS.has(trailingFoodNoun)) {
    const headMatched =
      hasIn(cWithCats, trailingFoodNoun) ||
      (trailingFoodNoun === "waffles" || trailingFoodNoun === "waffle" ? hasIn(cWithCats, "eggo") : false) ||
      (trailingFoodNoun === "water" ? ["spring", "mineral", "seltzer", "sparkling", "purified", "artesian"].some((w) => hasIn(cWithCats, w)) : false);
    if (!headMatched) {
      return 0;
    }
  }

  // If the query has >= 3 tokens (e.g. "Little Debbie Nutty Bars" or "Prego traditional pasta sauce"),
  // the candidate (or its explicit OFF aisle category tag) MUST match at least one of the last 2 product noun tokens,
  // unless the retailer appended a generic aisle noun ("Kellogg's Rice Krispies Original Breakfast Cereal")
  // while the candidate title matches 100% of its tokens (>= 3 tokens, including >= 2 non-brand product tokens).
  if (pool.length >= 3) {
    const tail = pool.slice(-2);
    if (!tail.some((t) => hasIn(cWithCats, t))) {
      const AISLE_TAIL_SUFFIX = new Set([
        "breakfast", "cereal", "cereals", "snack", "snacks", "toaster", "pastry", "pastries",
        "tortilla", "potato", "chips", "chip", "sandwich", "cookies", "cookie", "crackers", "cracker",
        "granola", "bars", "bar", "energy", "sports", "soft", "drink", "drinks", "beverage", "beverages",
      ]);
      const tailIsGenericAisle = tail.every((t) => AISLE_TAIL_SUFFIX.has(t));
      const brandTokSet = new Set(tokens(detectQueryBrand(cleanQuery)));
      const nonBrandCandMatches = c.filter((ct) => !GENERIC.has(ct) && !brandTokSet.has(ct) && hasIn(all, ct));
      const distinctCandMatches = c.filter((ct) => !GENERIC.has(ct) && hasIn(all, ct));
      const CONFLICTING_CAND_FORMS = [
        "dips", "dip", "salsa", "salsas", "sauces", "sauce",
        "powders", "powder", "seasonings", "seasoning", "ice-creams",
      ];
      const hasConflictingCandForm = CONFLICTING_CAND_FORMS.some(
        (ft) => hasIn(cWithCats, ft) && !hasIn(all, ft),
      );
      const fullSubBrandMatch =
        tailIsGenericAisle &&
        !hasConflictingCandForm &&
        distinctCandMatches.length >= 3 &&
        c.every((ct) => GENERIC.has(ct) || hasIn(all, ct)) &&
        nonBrandCandMatches.length >= 1;
      if (!fullSubBrandMatch) {
        return 0;
      }
    }
  }

  // If the query explicitly asks for "plain"/"unsweetened", reject candidates with added flavor tokens
  const queryWantsPlain = all.some((t) => PLAIN_TOKENS.has(t));
  const queryFlavors = all.filter((t) => FLAVOR_TOKENS.has(t));
  const candidateFlavors = c.filter((t) => FLAVOR_TOKENS.has(t));
  const unrequestedFlavors = candidateFlavors.filter((f) => !hasIn(all, f));

  if (queryWantsPlain && unrequestedFlavors.length > 0) {
    return 0;
  }
  // Never match a hot/spicy variant when the query did not request it
  const SPICY_TOKENS = new Set(["hot", "spicy", "flamin", "jalapeno", "habanero", "chipotle", "sriracha", "buffalo", "poblano", "poblanos"]);
  // "Hot sauce" names a product form, not a heat-level variant ("Cholula Original Hot Sauce").
  const cSpicy = tokens(cleanCandidate.replace(/\bhot\s+sauces?\b/gi, "sauce"));
  if (cSpicy.some((t) => SPICY_TOKENS.has(t)) && !all.some((t) => SPICY_TOKENS.has(t))) {
    return 0;
  }
  // If the query specifies a flavor (e.g. "strawberry", "honey"), candidate title must include it
  if (queryFlavors.length > 0 && !queryFlavors.every((f) => hasIn(c, f))) {
    return 0;
  }
  // Penalize candidates that add any unrequested flavor tokens ("Honey Nut Cheerios" for "Cheerios")
  // Exempt "frosted" on Pop-Tarts where Frosted is the standard flagship pastry
  const effectiveUnrequestedFlavors = unrequestedFlavors.filter(
    (f) => !(f === "frosted" && hasIn(c, "poptart")),
  );
  const extraFlavorPenalty =
    effectiveUnrequestedFlavors.length > 0 ? Math.min(0.45, effectiveUnrequestedFlavors.length * 0.22) : 0;

  // Penalize unrequested dietary/line spin-offs so classic flagship products always beat niche variants
  let spinoffPenalty = 0;
  if (/\borganic\b/.test(candLower) && !/\borganic\b/.test(queryLower) && !INHERENTLY_ORGANIC_BRAND_RE.test(candidate)) {
    spinoffPenalty += 0.24;
  }
  const SPINOFF_PATTERNS: Array<[RegExp, RegExp, number]> = [
    [/\b(whole\s+grain|whole\s+wheat|multigrain|nutri[- ]?grain)\b/, /\b(whole\s+grain|whole\s+wheat|multigrain|nutri[- ]?grain|oats?|oatmeal|cheerios|wheat\s+thins|triscuit)\b/, 0.24],
    [/\b(gluten[\s-]*free|grain[\s-]*free|cauliflower)\b/, /\b(gluten|grain|cauliflower)\b/, 0.28],
    [/\b(sugar[\s-]*free|no\s+(?:added\s+)?sugar|sugar\s+added|less\s+sugar|reduced\s+sugar|zero\s+sugar|keto)\b/, /\b(sugar|zero|diet|keto|unsweetened)\b/, 0.28],
    [/\b(reduced[\s-]*fat|low[\s-]*fat|fat[\s-]*free|less\s+fat|1\/3\s+less|neufchatel)\b/, /\b(reduced|low|fat|less|neufchatel|light|lite)\b/, 0.26],
    [/\b(plant\s+protein|protein\+?|chickpea|red\s+lentil)\b/, /\b(protein|chickpea|lentil|plant)\b/, 0.25],
    [/\b(whipped|unfrosted|flavor\s+blasted|colors|mega\s+stuf|double\s+stuf|thins|bites|poppers|crisps|scramble|snack\s+mix|trail\s+mix)\b/, /\b(whipped|unfrosted|blasted|colors|mega|double|thins|bites|poppers|crisps|scramble|mix)\b/, 0.24],
    [/\b(cheeseburger|sausage|bacon|three\s+meat|meat\s+lovers?|supreme)\b/, /\b(cheeseburger|sausage|bacon|meat|supreme)\b/, 0.22],
    [/\b(to\s+go|\d+\s*(?:count|ct)\b|foodservice|single\s+serve|portion)\b/, /\b(to\s+go|count|ct|cups?|pouches)\b/, 0.22],
  ];
  for (const [cRe, qRe, pen] of SPINOFF_PATTERNS) {
    if (cRe.test(candLower) && !qRe.test(queryLower)) {
      spinoffPenalty += pen;
    }
  }

  const directMatched = pool.filter((t) => hasIn(c, t)).length;
  const totalMatched = pool.filter((t) => hasIn(cWithCats, t)).length;
  const usedCatFallback = totalMatched > directMatched;
  const ratio = totalMatched / pool.length;
  if (pool.length <= 2 && ratio < 1 && ratio < 0.5) return 0;
  if (ratio < 0.55) return 0;
  const base = (pool.length <= 2 && ratio === 1 ? 1 : ratio) - (usedCatFallback ? 0.03 : 0);

  // Bigram word-order bonus (so "Nabisco Original Wheat Thins" beats "Harris Teeter Original Thin Wheats")
  let bigramBonus = 0;
  for (let i = 0; i + 1 < pool.length; i++) {
    const idxA = c.findIndex((x) => hasIn([x], pool[i]));
    if (idxA >= 0 && idxA + 1 < c.length && hasIn([c[idxA + 1]], pool[i + 1])) {
      bigramBonus = 0.06;
      break;
    }
  }

  const extraTokensPenalty = Math.max(0, c.length - all.length) * 0.015;
  return Math.max(0, base + bigramBonus - extraFlavorPenalty - spinoffPenalty - extraTokensPenalty - formFactorPenalty);
}

const NEGATIVE_LOOKUP_TTL_MS = 15 * 60_000;
const MAX_NEGATIVE_LOOKUP_ENTRIES = 1000;
export const OFF_SEARCH_MAX_PER_MIN = 9;
export const OFF_SEARCH_INTERACTIVE_RESERVE = 3;
export const OFF_SEARCH_BATCH_MAX_PER_MIN = Math.max(1, OFF_SEARCH_MAX_PER_MIN - OFF_SEARCH_INTERACTIVE_RESERVE);
export const OFF_PRODUCT_MAX_PER_MIN = 14;
const negativeLookupCache = new Map<string, number>();
const providerRateWindows = new Map<string, { count: number; resetAt: number }>();
export interface LookupAttemptContext {
  hadOperationalFailure: boolean;
  isBatch?: boolean;
  deadlineMs?: number;
  onDeadlineExceeded?: () => void;
}
const lookupAttemptContext = new AsyncLocalStorage<LookupAttemptContext>();

export function runWithLookupContext<T>(
  ctx: { isBatch?: boolean; deadlineMs?: number; onDeadlineExceeded?: () => void },
  fn: () => Promise<T>,
): Promise<T> {
  const parent = lookupAttemptContext.getStore();
  const mergedDeadline =
    typeof ctx.deadlineMs === "number" && typeof parent?.deadlineMs === "number"
      ? Math.min(ctx.deadlineMs, parent.deadlineMs)
      : (ctx.deadlineMs ?? parent?.deadlineMs);
  return lookupAttemptContext.run(
    {
      hadOperationalFailure: false,
      isBatch: ctx.isBatch ?? parent?.isBatch,
      deadlineMs: mergedDeadline,
      onDeadlineExceeded: ctx.onDeadlineExceeded ?? parent?.onDeadlineExceeded,
    },
    fn,
  );
}

function effectiveLookupStepTimeoutMs(): number {
  const deadlineMs = lookupAttemptContext.getStore()?.deadlineMs;
  if (typeof deadlineMs !== "number") return TIMEOUT_MS;
  return Math.max(1, Math.min(TIMEOUT_MS, deadlineMs - Date.now()));
}

let trackedLookupFetchRef: unknown = globalThis.fetch;
let offRateTestEpoch = 0;
let offUnavailableUntil = 0;
let offConsecutive429s = 0;

export function resetLookupRuntimeForTests(): void {
  negativeLookupCache.clear();
  providerRateWindows.clear();
  offBarcodeCache.clear();
  usdaUnavailableUntil = 0;
  dsldUnavailableUntil = 0;
  offUnavailableUntil = 0;
  offConsecutive429s = 0;
  offRateTestEpoch += 1;
  trackedLookupFetchRef = globalThis.fetch;
}

function ensureLookupRuntimeFreshForFetch(): void {
  if (process.env.NODE_ENV !== "production" && trackedLookupFetchRef !== globalThis.fetch) {
    resetLookupRuntimeForTests();
  }
}

function markLookupOperationalFailure(): void {
  const ctx = lookupAttemptContext.getStore();
  if (ctx) ctx.hadOperationalFailure = true;
}

function consumeLocalWindowBudget(bucket: string, maxPerMin: number): boolean {
  const now = Date.now();
  const win = providerRateWindows.get(bucket);
  if (!win || now >= win.resetAt) {
    providerRateWindows.set(bucket, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (win.count >= maxPerMin) return false;
  win.count += 1;
  return true;
}

export async function reportSharedOffRateLimited(): Promise<void> {
  offUnavailableUntil = Date.now() + 60_000;
  if (isPersistentKvConfigured()) {
    try {
      const cbKey =
        process.env.NODE_ENV === "production"
          ? "heybroc:cb:off"
          : `heybroc:cb:off:${offRateTestEpoch}`;
      await kvSet(cbKey, String(offUnavailableUntil), 60_000);
    } catch {
      // Best-effort KV circuit breaker write
    }
  }
}

/**
 * Shared Open Food Facts / Open*Facts budget enforced across serverless instances via KV
 * strictly at or below OFF's published IP limits (<= 10 searches/min, <= 15 product reads/min).
 * Batch grid scans are capped at OFF_SEARCH_BATCH_MAX_PER_MIN so >= OFF_SEARCH_INTERACTIVE_RESERVE
 * slots/min remain reserved for interactive single scans.
 */
export async function consumeSharedOffBudget(
  urlOrKind: string,
  options?: { isBatch?: boolean },
): Promise<boolean> {
  ensureLookupRuntimeFreshForFetch();
  let bucket: "off_search" | "off_product" | "off_sister_search" | "off_sister_product" | "" = "";
  if (urlOrKind === "off_search") {
    bucket = "off_search";
  } else if (urlOrKind === "off_product") {
    bucket = "off_product";
  } else if (
    /openfoodfacts\.org/i.test(urlOrKind) &&
    !/images\.openfoodfacts\.(?:org|net)/i.test(urlOrKind)
  ) {
    if (
      urlOrKind.includes("search.openfoodfacts.org") ||
      urlOrKind.includes("/cgi/search.pl") ||
      urlOrKind.includes("/api/v2/search")
    ) {
      bucket = "off_search";
    } else {
      bucket = "off_product";
    }
  } else if (/open(?:beauty|products|petfood)facts\.org/i.test(urlOrKind)) {
    bucket =
      urlOrKind.includes("/cgi/search.pl") || urlOrKind.includes("/api/v2/search")
        ? "off_sister_search"
        : "off_sister_product";
  }
  if (!bucket) return true;
  if (Date.now() < offUnavailableUntil) return false;
  const isBatch = options?.isBatch ?? Boolean(lookupAttemptContext.getStore()?.isBatch);
  const isSearchBucket = bucket === "off_search" || bucket === "off_sister_search";
  const maxPerMin = isSearchBucket
    ? isBatch
      ? OFF_SEARCH_BATCH_MAX_PER_MIN
      : OFF_SEARCH_MAX_PER_MIN
    : OFF_PRODUCT_MAX_PER_MIN;
  if (isPersistentKvConfigured()) {
    try {
      const cbKey =
        process.env.NODE_ENV === "production"
          ? "heybroc:cb:off"
          : `heybroc:cb:off:${offRateTestEpoch}`;
      const cbVal = await kvGet(cbKey);
      if (cbVal && Number(cbVal) > Date.now()) {
        offUnavailableUntil = Number(cbVal);
        return false;
      }
      const kvKey =
        process.env.NODE_ENV === "production"
          ? `heybroc:ratelimit:off_global:${bucket}`
          : `heybroc:ratelimit:off_global:${bucket}:${offRateTestEpoch}`;
      if (isBatch && isSearchBucket) {
        // Peek before incrementing so batch scans never burn the interactive reserve slots
        const existing = Number((await kvGet<string | number>(kvKey)) ?? 0);
        if (Number.isFinite(existing) && existing >= maxPerMin) {
          return false;
        }
      }
      const count = await kvIncrWithPExpire(kvKey, 60_000, 1);
      return count <= maxPerMin;
    } catch {
      // Fall back to bounded in-memory window if KV experiences transient error
    }
  }
  return consumeLocalWindowBudget(bucket, maxPerMin);
}

async function consumeOutboundProviderBudget(url: string): Promise<boolean> {
  if (/open(?:food|beauty|products|petfood)facts\.org/i.test(url)) {
    return consumeSharedOffBudget(url);
  }
  if (url.includes("api.nal.usda.gov") || url.includes("fdc.nal.usda.gov")) {
    return consumeLocalWindowBudget("usda", 120);
  }
  return true;
}

async function getJson<T>(url: string): Promise<T | null> {
  ensureLookupRuntimeFreshForFetch();
  const isUsda = url.includes("api.nal.usda.gov") || url.includes("fdc.nal.usda.gov");
  const isDsld = url.includes("api.ods.od.nih.gov");
  const isOff =
    /open(?:food|beauty|products|petfood)facts\.org/i.test(url) &&
    !/images\.openfoodfacts\.(?:org|net)/i.test(url);
  if (
    (isUsda && Date.now() < usdaUnavailableUntil) ||
    (isDsld && Date.now() < dsldUnavailableUntil) ||
    (isOff && Date.now() < offUnavailableUntil)
  ) {
    markLookupOperationalFailure();
    return null;
  }
  if (!(await consumeOutboundProviderBudget(url))) {
    markLookupOperationalFailure();
    return null;
  }
  try {
    const stepTimeoutMs = effectiveLookupStepTimeoutMs();
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: providerSignal.getStore()
        ? AbortSignal.any([providerSignal.getStore()!, AbortSignal.timeout(stepTimeoutMs)])
        : AbortSignal.timeout(stepTimeoutMs),
      cache: "no-store",
    });
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) {
        markLookupOperationalFailure();
      }
      if (isOff && res.status === 429) {
        offConsecutive429s += 1;
        if (offConsecutive429s >= 3) {
          await reportSharedOffRateLimited();
        }
      }
      if (isDsld && (res.status === 429 || res.status >= 500)) dsldUnavailableUntil = Date.now() + 60_000;
      if (isUsda && (res.status === 429 || res.status >= 502)) {
        usdaUnavailableUntil = Date.now() + 60 * 1000;
      }
      return null;
    }
    if (isOff) {
      offConsecutive429s = 0;
    }
    const type = res.headers.get("content-type") || "";
    if (!type.includes("json")) {
      markLookupOperationalFailure();
      return null;
    }
    return (await res.json()) as T;
  } catch {
    markLookupOperationalFailure();
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Open Food Facts (US + Global 4M+ Database)                          */
/* ------------------------------------------------------------------ */

interface OffProduct {
  code?: string;
  product_name?: string;
  product_name_en?: string;
  brands?: string | string[];
  ingredients_text?: string;
  ingredients_text_en?: string;
  lang?: string;
  image_front_url?: string;
  image_url?: string;
  image_front_small_url?: string;
  selected_images?: {
    front?: {
      display?: Record<string, string | undefined>;
      small?: Record<string, string | undefined>;
    };
  };
  images?: Record<string, { imgid?: string | number; rev?: string | number } | undefined>;
  nutriscore_grade?: string;
  labels_tags?: string[];
  last_modified_t?: number;
  nutriments?: Record<string, number | string | undefined>;
  categories_tags?: string[];
  countries_tags?: string[];
}

function normalizeOffBrand(brands?: string | string[]): string {
  if (!brands) return "";
  if (Array.isArray(brands)) return brands.filter(Boolean).join(", ");
  return brands;
}

const OFF_FIELDS =
  "product_name,product_name_en,brands,ingredients_text,ingredients_text_en,lang,code,countries_tags,image_front_url,image_url,image_front_small_url,selected_images,images,nutriscore_grade,labels_tags,categories_tags,last_modified_t,nutriments";

/**
 * Ensures Open Food Facts records match US market formulations:
 * - Explicitly tagged `en:united-states` -> accepted.
 * - Explicitly tagged with foreign countries only (e.g. UK, EU, Canada, Australia) -> rejected so US USDA Branded labels win.
 * - Untagged legacy records -> accepted only for North American UPC-A/UPC-E/0-prefixed GTINs; foreign [2-9] EAN-13s are rejected.
 */
export function isUsMarketOffProduct(p?: { code?: string; countries_tags?: string[] } | null): boolean {
  if (!p) return false;
  const tags = Array.isArray(p.countries_tags)
    ? p.countries_tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
    : [];
  if (
    tags.includes("en:united-states") ||
    tags.includes("united-states") ||
    tags.includes("en:us") ||
    tags.includes("en:usa")
  ) {
    return true;
  }
  if (tags.length > 0) {
    return false;
  }
  const codeStr = String(p.code || "").replace(/\D/g, "");
  if (!codeStr) return false;
  if (/^[2-9]\d{12}$/.test(codeStr) || /^[1-9]\d{7}$/.test(codeStr)) {
    return false;
  }
  return /^(?:00?\d{11,12}|\d{11,12}|0\d{7})$/.test(codeStr);
}

const SCREEN_UI_NON_INGREDIENTS =
  /\b(items to add next|frequently bought together|customers also (bought|viewed|considered)|you may also like|you might also like|similar items|related products|sponsored|add to cart|buy now|many in stock|out of stock|product information|product details|nutrition facts|shipping|delivery|pickup|reviews|ratings|select a store|return policy|disclaimer|warnings?|tap to expand|show more|see more|velveeta\s+original|frito[- ]?lay|doritos|cheetos|bold\s+snack)\b/i;

/**
 * Verifies that rawIngredients captured from a store screen is a genuine ingredient list
 * and not an adjacent UI heading (such as ALDI's "Items to add next" below a collapsed "Ingredients v" pill).
 */
export function isPlausibleScreenIngredients(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 3 || s.length > 10_000) return false;
  if (SCREEN_UI_NON_INGREDIENTS.test(s)) return false;
  if (/\$\s*\d+|\b\d+(?:\.\d+)?\s*(?:oz|fl\s*oz|lb|lbs|ct|pk|pack)\b/i.test(s) && !s.includes(",")) return false;
  const hasComma = s.includes(",") || s.includes(";");
  const isSingleWholeDeclaration =
    /\b(100%|ingredients?\s*:|contains\b|cultured\b|pasteurized\b|organic\b|filtered\s+water|carbonated\s+water|purified\s+water|spring\s+water|rice|oats|rolled\s+oats|quinoa|honey|maple\s+syrup|almonds?|cashews?|walnuts?|peanuts?|pecans?|milk|cream|butter|eggs?|chicken|beef|pork|turkey|salmon|potatoes?|beans|lentils|chickpeas|olive\s+oil|avocado\s+oil|coconut\s+oil|sea\s+salt|salt)\b/i.test(
      s
    );
  if (!hasComma && !isSingleWholeDeclaration) return false;
  if (!isEnglishIngredientText(s)) return false;
  return ENGLISH_INGREDIENT_ANCHORS.test(s) || isSingleWholeDeclaration;
}

const OCR_NUTRITION_GARBAGE =
  /\b(?:\d+\s*%\s*(?:fibre|fiber|vitamin|calcium|iron|daily\s+value)|\d+\s*%\s+\d+\s*%\b|(?<!\bin)gredients?\b|swingredients\b|itamin\s+[a-d]|alcium\s+\d)|(?:\b[a-z]{1,3}\s+\d+\s*%$)/i;

const EXPLICIT_FOREIGN_INGREDIENTS_HEADER_RE =
  /[.;/|]\s*(?:ingredientes\s*[:.-]?|ingr\u00e9dients?\s*[:.-]?|zutaten\s*[:.-]?)/i;

const FOREIGN_ORIGIN_OR_DECLARATION_AFTER_PERIOD_RE =
  /\.\s+(?:contiene\s*:|puede\s+contener\b|elaborado\s+(?:en|por)\b|hecho\s+en\b|distribuido\s+por\b|conservar\s+en\b)/i;

const FOREIGN_OCR_GARBAGE_TOKEN_RE =
  /\b(?:entero|grano\s+entero|dtros|otros\s+alimentos|alimentos|az[u\u00fa]cares|grasas|calor[i\u00ed]as|colesterol|yodeterol|queden|pueden|porci[o\u00f3]n|sodio)\b/gi;

const ENGLISH_ALLERGEN_OR_DECLARATION_IN_TAIL_RE =
  /\b(?:ingredients?|contains|allergen|milk|cream|whey|casein|caseinate|butter|buttermilk|cheese|yogurt|lactose|ghee|eggs?|yolks?|whites?|albumin|lysozyme|mayonnaise|peanuts?|tree\s+nuts?|almonds?|walnuts?|pecans?|cashews?|hazelnuts?|filberts?|pistachios?|macadamia|brazil\s+nuts?|pine\s+nuts?|chestnuts?|praline|marzipan|nougat|sesame|tahini|wheat|gluten|barley|rye|oats?|spelt|farro|kamut|semolina|durum|triticale|malt|soy|soya|soybeans?|lecithin|tofu|tempeh|miso|edamame|tamari|fish|shellfish|shrimp|prawns?|crab|lobster|crawfish|crayfish|clams?|mussels?|oysters?|scallops?|calamari|squid|octopus|anchov(?:y|ies)|sardines?|salmon|tuna|cod|tilapia|halibut|haddock|trout|mahi|pollock|catfish|krill)\b/i;

function stripCoveredBilingualCognates(prefix: string, tail: string): string {
  let cleaned = tail;
  if (/\b(?:wheat|flour|gluten|barley|rye|oats?|spelt|durum|semolina|malt|triticale)\b/i.test(prefix)) {
    cleaned = cleaned.replace(/\b(?:gluten|farro|kamut|semolina|durum|triticale|malt)\b/gi, " ");
  }
  if (/\b(?:sesame|tahini)\b/i.test(prefix)) {
    cleaned = cleaned.replace(/\bsesame\b/gi, " ");
  }
  if (/\b(?:soy|soya|soybeans?|tofu|tempeh|miso|edamame|tamari)\b/i.test(prefix)) {
    cleaned = cleaned.replace(/\b(?:soy|soya|tofu|tempeh|miso|edamame|tamari)\b/gi, " ");
  }
  if (/\b(?:milk|cream|whey|casein|caseinate|butter|buttermilk|cheese|yogurt|lactose|ghee)\b/i.test(prefix)) {
    cleaned = cleaned.replace(/\b(?:lactose|casein|caseinate)\b/gi, " ");
  }
  return cleaned;
}

function findSafeForeignSpilloverCutoff(s: string): number {
  const foreignHeaderMatch = s.match(EXPLICIT_FOREIGN_INGREDIENTS_HEADER_RE);
  if (foreignHeaderMatch && typeof foreignHeaderMatch.index === "number" && foreignHeaderMatch.index >= 8) {
    const prefix = s.slice(0, foreignHeaderMatch.index).trim();
    const tail = s.slice(foreignHeaderMatch.index + 1);
    if (isEnglishIngredientText(prefix) && !/\b(?:ingredients?|contains|allergen)\b/i.test(tail)) {
      const tailWithoutCoveredCognates = stripCoveredBilingualCognates(prefix, tail);
      if (!ENGLISH_ALLERGEN_OR_DECLARATION_IN_TAIL_RE.test(tailWithoutCoveredCognates)) {
        return foreignHeaderMatch.index;
      }
    }
  }
  const declMatch = s.match(FOREIGN_ORIGIN_OR_DECLARATION_AFTER_PERIOD_RE);
  if (declMatch && typeof declMatch.index === "number" && declMatch.index >= 8) {
    const tail = s.slice(declMatch.index + 1);
    if (!ENGLISH_ALLERGEN_OR_DECLARATION_IN_TAIL_RE.test(tail)) {
      return declMatch.index;
    }
  }
  const periodRe = /\.\s+/g;
  let m: RegExpExecArray | null;
  while ((m = periodRe.exec(s)) !== null) {
    if (m.index < 8) continue;
    const tail = s.slice(m.index + 1);
    if (ENGLISH_ALLERGEN_OR_DECLARATION_IN_TAIL_RE.test(tail)) continue;
    const foreignHits = tail.match(FOREIGN_OCR_GARBAGE_TOKEN_RE);
    if (foreignHits && foreignHits.length >= 2) {
      return m.index;
    }
  }
  return -1;
}

const INGREDIENT_PRESERVED_ACRONYMS = new Set([
  "BHA", "BHT", "TBHQ", "MSG", "EDTA", "DATEM", "PGPR", "FD&C", "USDA", "FDA", "GMO", "UHT", "DNA",
  "D2", "D3", "B1", "B2", "B3", "B5", "B6", "B12", "K1", "K2", "II", "III",
]);

const LETTER_DESIGNATOR_PRECEDING_WORDS = new Set([
  "grade", "vitamin", "class", "type", "size", "group", "part", "level", "tier", "section", "formula",
]);

export function sanitizeIngredientDisplay(raw: string): string {
  let s = (raw || "").replace(/_/g, "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const cutoffIdx = findSafeForeignSpilloverCutoff(s);
  if (cutoffIdx >= 8) {
    s = (s[cutoffIdx] === "." ? s.slice(0, cutoffIdx + 1) : s.slice(0, cutoffIdx)).trim();
  }
  const letters = s.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 6) {
    const upperCount = letters.replace(/[^A-Z]/g, "").length;
    if (upperCount / letters.length > 0.78) {
      let isListStart = true;
      let prevWordLower = "";
      s = s.replace(/[A-Za-z0-9&'’-]+|[.,;:()[\]]/g, (tok) => {
        if (/^[.,;:([\]]$/.test(tok)) {
          if (tok === "." || tok === ":" || tok === ";") isListStart = true;
          prevWordLower = "";
          return tok;
        }
        if (tok === ")") {
          prevWordLower = "";
          return tok;
        }
        const upper = tok.toUpperCase();
        if (INGREDIENT_PRESERVED_ACRONYMS.has(upper)) {
          isListStart = false;
          prevWordLower = tok.toLowerCase();
          return upper;
        }
        const lower = tok.toLowerCase();
        if (lower === "a" && LETTER_DESIGNATOR_PRECEDING_WORDS.has(prevWordLower)) {
          isListStart = false;
          prevWordLower = lower;
          return "A";
        }
        if (lower === "aa" && prevWordLower === "grade") {
          isListStart = false;
          prevWordLower = lower;
          return "AA";
        }
        if (!isListStart && (LOWERCASE_TITLE_MINOR_WORDS.has(lower) || LOWERCASE_UNIT_TOKENS.has(lower))) {
          prevWordLower = lower;
          return lower;
        }
        isListStart = false;
        prevWordLower = lower;
        return lower.replace(/(^|[-'’])[a-z]/g, (m) => m.toUpperCase());
      });
    }
  }
  s = s.replace(/\b(Grade|Vitamin|Class)\s+a\b/g, "$1 A").replace(/\b(Grade)\s+aa\b/gi, "$1 AA");
  return s;
}

function englishIngredients(p: OffProduct): string {
  const clean = (s: string) => sanitizeIngredientDisplay(s);
  const en = clean(p.ingredients_text_en || "");
  if (en && !OCR_NUTRITION_GARBAGE.test(en) && isEnglishIngredientText(en)) return en;
  const raw = clean(p.ingredients_text || "");
  if (raw && (!p.lang || p.lang === "en") && !OCR_NUTRITION_GARBAGE.test(raw) && isEnglishIngredientText(raw)) return raw;
  return "";
}

const FOREIGN_NON_US_FRONT_RE =
  /\/front_(?:de|it|nl|pl|pt|ru|ja|zh|ar|ro|hu|cs|sv|da|fi|el|tr|he|ko|th|vi)\./i;
const ES_OR_FR_FRONT_RE = /\/front_(?:es|fr)\./i;

const OFF_PANEL_IMAGE_PATH_RE = /\/(?:ingredients|nutrition|packaging)(?:_|\.)/i;

export function bestOffImage(p?: OffProduct): string | undefined {
  if (!p) return undefined;
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
  const isPanelDirectUrl = (u: string): boolean => {
    if (OFF_PANEL_IMAGE_PATH_RE.test(u)) return true;
    const rawNumMatch = u.match(/\/(\d+)(?:\.\d+)?\.(?:jpg|jpeg|png|webp)$/i);
    if (rawNumMatch && panelImgIds.has(rawNumMatch[1])) return true;
    return false;
  };

  const enFront =
    p.selected_images?.front?.display?.en || p.selected_images?.front?.small?.en;
  if (
    enFront &&
    enFront.startsWith("https://") &&
    !FOREIGN_NON_US_FRONT_RE.test(enFront) &&
    !ES_OR_FR_FRONT_RE.test(enFront) &&
    !isPanelDirectUrl(enFront)
  ) {
    return enFront;
  }

  const directCandidates = [p.image_front_url, p.image_url, p.image_front_small_url].filter(
    (u): u is string => Boolean(u && u.startsWith("https://")),
  );
  for (const u of directCandidates) {
    if (FOREIGN_NON_US_FRONT_RE.test(u)) continue;
    if (ES_OR_FR_FRONT_RE.test(u) && !isNorthAmerica) continue;
    if (isPanelDirectUrl(u)) continue;
    return u;
  }

  if (isNorthAmerica) {
    const naSecondaryFront =
      p.selected_images?.front?.display?.es ||
      p.selected_images?.front?.small?.es ||
      p.selected_images?.front?.display?.fr ||
      p.selected_images?.front?.small?.fr;
    if (naSecondaryFront && naSecondaryFront.startsWith("https://") && !isPanelDirectUrl(naSecondaryFront)) {
      return naSecondaryFront;
    }
  }

  // Fallback to first raw uploaded photo (`images["1"]`, `images["2"]`, ...) not assigned to nutrition/ingredients panels
  if (p.images && p.code) {
    const folder = offBarcodeFolderPath(p.code);
    if (folder) {
      const rawNumericKeys = Object.keys(p.images)
        .filter((k) => /^\d+$/.test(k) && !panelImgIds.has(k))
        .sort((a, b) => Number(a) - Number(b));
      if (rawNumericKeys.length > 0) {
        return `https://images.openfoodfacts.org/images/products/${folder}/${rawNumericKeys[0]}.400.jpg`;
      }
    }
  }

  return undefined;
}

function detectQueryBrand(query: string): string {
  const first = detectFirstBrand(query);
  if (first) return first;
  return query.match(NAMED_BRAND_GUARD)?.[0]?.trim() || "";
}

/** Every brand the query names (co-brand queries like "Breyers Oreo ice cream" name two). */
function detectQueryBrands(query: string): string[] {
  const out = [...detectAllBrands(query)];
  const named = query.match(NAMED_BRAND_GUARD)?.[0]?.trim();
  if (named) out.push(named);
  return Array.from(new Set(out));
}

const PARENT_MANUFACTURER_UMBRELLA =
  /\b(kelloggs?|kellanova|nabisco|mondelez|pepperidge\s+farm|general\s+mills|post\s+consumer|post\s+foods|\bpost\b|frito[\s-]*lay|pepsico|kraft\s+heinz|\bkraft\b|conagra|campbells?|smuckers?|ferrero|mars\s+wrigley|\bmars\b|nestle|danone|bimbo|coca[\s-]*cola|keurig\s+dr\s+pepper|unilever|whole\s+foods|walmart|kroger|target|aldi|costco|safeway|albertsons)\b/i;

/**
 * Prevents co-branded snack/flavor hijacks (e.g. "Herr's Potato Chips, Heinz Ketchup" matching "Heinz ketchup")
 * and substring brand collisions ("A1C Foods" matching "A1") by verifying whole-token brand ownership.
 * Co-brand records are accepted when the owner is ANY brand the query names and ALL queried brands appear.
 */
export function matchesRequestedBrand(query: string, candidateBrand: string | undefined, candidateTitle: string): boolean {
  const detected = detectQueryBrand(query);
  if (!detected) return true;
  const combinedCandidate = `${candidateBrand || ""} ${candidateTitle}`;
  if (hasConflictingBrand(query, combinedCandidate)) return false;

  const brands = [detected, ...detectQueryBrands(query)].map(normalizeBrandPhrase).filter(Boolean);
  const combinedHaystack = buildCandidateBrandHaystack(combinedCandidate);
  for (const nb of brands) {
    const alts =
      nb === "coke" || nb === "coca cola" || nb === "cocacola"
        ? ["coke", "coca cola", "cocacola"]
        : nb === "rxbar" || nb === "rx bar" || nb === "rxbars"
          ? ["rx", "rxbar", "rx bar"]
          : [nb];
    if (!alts.some((alt) => containsWholeBrandPhrase(combinedHaystack, alt))) {
      return false;
    }
  }

  const dAlts = Array.from(
    new Set(
      brands.flatMap((d) =>
        d === "coke" || d === "coca cola" || d === "cocacola"
          ? ["coke", "coca cola", "cocacola"]
          : d === "rxbar" || d === "rx bar" || d === "rxbars"
            ? ["rx", "rxbar", "rx bar"]
            : [d],
      ),
    ),
  );
  const bRaw = (candidateBrand || "").trim();
  const bHaystack = bRaw ? buildCandidateBrandHaystack(bRaw) : "";
  const primaryClauseRaw = candidateTitle.split(/[,|]/)[0] || candidateTitle;
  const primaryHaystack = buildCandidateBrandHaystack(primaryClauseRaw);
  const matchesAny = (haystack: string) => dAlts.some((alt) => containsWholeBrandPhrase(haystack, alt));

  // If candidateTitle starts with a known brand not requested by the query (e.g. untagged "Herr's Heinz Ketchup Chips"), reject
  for (const re of CANONICAL_BRAND_PATTERNS) {
    const anchored = new RegExp(`^\\s*(?:${re.source})`, re.flags.replace("g", ""));
    const m = anchored.exec(candidateTitle);
    if (m && m[0].trim()) {
      const leadHaystack = buildCandidateBrandHaystack(m[0]);
      if (!matchesAny(leadHaystack) && !PARENT_MANUFACTURER_UMBRELLA.test(m[0])) {
        return false;
      }
    }
  }

  if (bHaystack) {
    if (matchesAny(bHaystack)) return true;
    if (PARENT_MANUFACTURER_UMBRELLA.test(bRaw) && matchesAny(primaryHaystack)) return true;
    return false;
  }
  return matchesAny(primaryHaystack);
}

function pickBestOff(query: string, products: OffProduct[] = []): OffProduct | null {
  let best: OffProduct | null = null;
  let bestScore = 0;
  const qToks = tokens(query);
  const firstTok = qToks[0] || "";
  const detectedBrand = detectQueryBrand(query).toLowerCase();
  for (const p of products) {
    if (!isUsMarketOffProduct(p)) continue;
    const ing = englishIngredients(p);
    if (!ing) continue;
    const rawProdName = (p.product_name_en || p.product_name || "").trim();
    if (!rawProdName) continue;
    const brandStr = normalizeOffBrand(p.brands);
    const name = mergeBrandAndTitle(brandStr.split(",")[0]?.trim(), rawProdName);
    if (!matchesRequestedBrand(query, brandStr, name)) continue;
    if (!passesVariantGuard(query, name)) continue;
    const nutrition = extractOffNutrition(p);
    if (isDietaryOrVariantMismatch(query, name, ing, nutrition)) continue;
    const r = relevance(query, name, p.categories_tags);
    if (r < 0.45) continue;
    const brandAnchor = detectedBrand || firstTok;
    const brandMatchBonus =
      brandAnchor.length >= 3 && brandStr.toLowerCase().includes(brandAnchor) ? 0.08 : 0;
    const imgBonus = bestOffImage(p) ? 0.03 : 0;
    if (r + brandMatchBonus + imgBonus > bestScore) {
      best = p;
      bestScore = r + brandMatchBonus + imgBonus;
    }
  }
  return best;
}

const HIGH_SODIUM_CONCENTRATE_FOOD =
  /\b(salt|bouillon|broth|stock|seasoning|spice|rub|soy\s+sauce|tamari|fish\s+sauce|worcestershire|teriyaki|hoisin|oyster\s+sauce|miso|baking\s+soda|bicarbonate|baking\s+powder|cure|brine|capers|anchov\w*|olives?|pickle\w*|kimchi|sauerkraut|jerky|paste|gravy\s+mix|soup\s+mix|dip\s+mix|taco\s+mix|ramen)\b/i;

/**
 * Guards against crowd-entered unit typos in Open Food Facts (e.g. typing 12.5g or 420mg into `sodium_100g`,
 * yielding 12,500mg or 420,000mg per 100g on bread/tortillas/snacks). Preserves raw schema units on concentrates.
 */
export function sanitizeOffFoodNutrition(
  title: string,
  nut: NutritionInput,
  nutriments?: Record<string, number | string | undefined>,
): NutritionInput {
  if (!title.trim() || HIGH_SODIUM_CONCENTRATE_FOOD.test(title)) return nut;
  const sodMg = nut.sodiumMg100g;
  if (sodMg === undefined || sodMg <= 4500) return nut;
  const rawSalt = nutriments?.salt_100g;
  const saltNum = typeof rawSalt === "number" ? rawSalt : typeof rawSalt === "string" && rawSalt.trim() ? Number(rawSalt) : NaN;
  if (Number.isFinite(saltNum) && saltNum >= 0 && saltNum * 400 <= 4500) {
    return { ...nut, sodiumMg100g: Math.round(saltNum * 400) };
  }
  return { ...nut, sodiumMg100g: undefined };
}

export function extractOffNutrition(p: OffProduct): NutritionInput {
  return inferNutritionFromText(p.product_name_en || p.product_name || "", englishIngredients(p), readOffNutrition(p));
}

export function extractUsdaNutrition(f: UsdaFood): NutritionInput {
  return readUsdaNutrition(f);
}

export async function lookupDSLD(query: string): Promise<Omit<LookupResult, "ms"> | null> {
  const input: LookupInput = /^\d{8,14}$/.test(query.trim()) ? { barcode: query.trim() } : { productTitle: query };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try { return await providerSignal.run(controller.signal, () => lookupDsld(input, getJson)); }
  finally { clearTimeout(timer); controller.abort(); }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

const NON_FOOD_OFF_CATEGORY_TAG_RE =
  /(?:^|:)(?:pet-food|pet-foods|cat-food|cat-foods|dog-food|dog-foods|animal-feed|pets|non-food|cleaning|household|hygiene|beauty|cosmetics|body-care|skin-care|hair-care|oral-care|perfumes|deodorants|medical|pharmacy|medications|otc)\b/i;

const LOWERCASE_TITLE_MINOR_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

const LOWERCASE_UNIT_TOKENS = new Set([
  "oz",
  "fl",
  "ml",
  "l",
  "g",
  "kg",
  "mg",
  "mcg",
  "lb",
  "lbs",
  "ct",
  "pk",
]);

const TITLE_PRESERVED_ACRONYMS = new Set([
  "USDA", "FDA", "GMO", "MSG", "BBQ", "PB", "RX", "DNA", "UHT", "IPA", "NSF", "PDO", "DOP", "IGP", "USA", "UK", "EU",
  "II", "III", "IV", "VI", "XL", "XXL", "AM", "PM", "TV", "RXBAR", "OWYN", "ALDI", "HEB",
  "A1", "A2", "V8", "C4", "7UP", "K2", "B1", "B2", "B3", "B5", "B6", "B12", "D2", "D3",
  "NKD", "PRO", "MAX", "GHOST", "KIND", "CELSIUS", "OLIPOP", "POPPI",
]);

const CANONICAL_MIXED_CASE_TOKENS: Record<string, string> = {
  mccormick: "McCormick",
  "mcdonald's": "McDonald's",
  mcdonalds: "McDonald's",
  mccafe: "McCafé",
  mccain: "McCain",
  "mccann's": "McCann's",
  lacroix: "LaCroix",
  sunbutter: "SunButter",
  "cheez-it": "Cheez-It",
  "cheez-its": "Cheez-Its",
  kitkat: "KitKat",
  digiorno: "DiGiorno",
  "non-gmo": "Non-GMO",
  "h-e-b": "H-E-B",
  pbfit: "PBfit",
  oauth: "OAuth",
  ph: "pH",
};

function normalizeSingleTitleSubtoken(
  sub: string,
  isFirstWord: boolean,
  isLastWord: boolean,
  prevWasNumeric: boolean,
  prevWordLower = "",
): string {
  const lower = sub.toLowerCase().replace(/’/g, "'");
  if (!lower || !/[a-z]/i.test(sub)) return sub;
  const canonical = CANONICAL_MIXED_CASE_TOKENS[lower];
  if (canonical) return canonical;
  const upper = sub.toUpperCase();
  if (TITLE_PRESERVED_ACRONYMS.has(upper)) return upper;
  if (lower === "a" && LETTER_DESIGNATOR_PRECEDING_WORDS.has(prevWordLower)) return "A";
  if (lower === "aa" && prevWordLower === "grade") return "AA";
  if (/^[A-Z]{2,}s$/.test(sub)) return sub;
  if (LOWERCASE_UNIT_TOKENS.has(lower) && (prevWasNumeric || (!isFirstWord && lower !== "l"))) {
    return lower;
  }
  if (!isFirstWord && !isLastWord && LOWERCASE_TITLE_MINOR_WORDS.has(lower)) {
    return lower;
  }
  // Fix Shift-hold leading-cap typos ("OLd" -> "Old", "REduced" -> "Reduced", "REDuced" -> "Reduced"),
  // shouting ALL-CAPS words ("QUAKER" -> "Quaker"), and all-lowercase words ("oatmeal" -> "Oatmeal")
  // while preserving genuine mixed-case brand/compound words ("RedHot", "DeLallo", "SmartFood", "CoQ10").
  if (
    /^[A-Z]{2,}[a-z]+(?:['’][a-z]+)?$/.test(sub) ||
    /^[A-Z]{2,}(?:['’][A-Z]+)?$/.test(sub) ||
    /^[a-z]+(?:['’][a-z]+)?$/.test(sub)
  ) {
    return lower.replace(/^[a-z]|(?<=^[a-z]['’])[a-z]/g, (ch) => ch.toUpperCase());
  }
  return sub;
}

export function normalizeOffDisplayTitle(raw: string): string {
  let collapsed = (raw || "").replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  // Normalize attached or capitalized measurement units ("86.4Oz" -> "86.4 oz", "16.9Fl Oz" -> "16.9 fl oz", "3Lbs" -> "3 lbs")
  collapsed = collapsed.replace(
    /\b(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|oz|ml|mg|mcg|g|kg|lbs?|ct|pk)\b/gi,
    (_m, num: string, unit: string) =>
      `${num} ${unit.toLowerCase().replace(/\.\s*/g, " ").replace(/\s+/g, " ").trim()}`,
  );
  // Strip redundant trailing ", <Suffix>" when every word of <Suffix> already appears in the main title
  // (e.g. "Quaker Oats Old Fashioned 100% Whole Grain Oats, Old Fashioned")
  const deduped = collapsed.replace(/^(.+?),\s*([^,()]{2,42})$/, (full, prefix: string, suffix: string) => {
    const prefixWords = new Set(prefix.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    const suffixWords = suffix.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return suffixWords.length > 0 && suffixWords.length <= 5 && suffixWords.every((w) => prefixWords.has(w))
      ? prefix.trim()
      : full;
  });

  const parts = deduped.split(/(\s+)/);
  const wordParts = parts.filter((p) => !/^\s+$/.test(p) && p.length > 0);
  const totalWords = wordParts.length;
  let wordIdx = 0;
  let prevWasNumeric = false;
  let prevWordLower = "";

  return parts
    .map((part) => {
      if (/^\s+$/.test(part) || !part) return part;
      const idx = wordIdx++;
      const m = part.match(/^([^A-Za-z0-9]*)([A-Za-z0-9'’-]+)([^A-Za-z0-9]*)$/);
      if (!m) {
        prevWasNumeric = /\d/.test(part);
        prevWordLower = "";
        return part;
      }
      const [, lead, core, trail] = m;
      const effectivePrevWord = lead ? "" : prevWordLower;
      const lowerCore = core.toLowerCase().replace(/’/g, "'");
      if (CANONICAL_MIXED_CASE_TOKENS[lowerCore]) {
        prevWasNumeric = false;
        prevWordLower = trail ? "" : lowerCore;
        return `${lead}${CANONICAL_MIXED_CASE_TOKENS[lowerCore]}${trail}`;
      }
      const normalizedCore = core.includes("-")
        ? core
            .split("-")
            .map((seg, segIdx, segs) =>
              normalizeSingleTitleSubtoken(
                seg,
                idx === 0 && segIdx === 0,
                idx === totalWords - 1 && segIdx === segs.length - 1,
                prevWasNumeric,
                segIdx === 0 ? effectivePrevWord : (segs[segIdx - 1] || "").toLowerCase(),
              ),
            )
            .join("-")
        : normalizeSingleTitleSubtoken(core, idx === 0, idx === totalWords - 1, prevWasNumeric, effectivePrevWord);
      prevWasNumeric = /^\d+(?:\.\d+)?$/.test(core);
      prevWordLower = trail ? "" : lowerCore;
      return `${lead}${normalizedCore}${trail}`;
    })
    .join("");
}

export function offToResult(p: OffProduct, fallbackTitle: string): Omit<LookupResult, "ms"> {
  const sourceUpdatedAt =
    typeof p.last_modified_t === "number" && p.last_modified_t > 0
      ? new Date(p.last_modified_t * 1000).toISOString().slice(0, 10)
      : null;
  const rawBrand = normalizeOffBrand(p.brands).split(",")[0]?.trim();
  const brandStr = rawBrand ? normalizeOffDisplayTitle(decodeHtmlEntities(rawBrand)) : undefined;
  const rawName = normalizeOffDisplayTitle(
    decodeHtmlEntities((p.product_name_en || p.product_name || fallbackTitle).trim()),
  );
  const fullTitle = normalizeOffDisplayTitle(mergeBrandAndTitle(brandStr, rawName));
  const baseNut = sanitizeOffFoodNutrition(fullTitle, extractOffNutrition(p), p.nutriments);
  const inferredKind: NutritionInput["productKind"] = p.categories_tags?.some((t) => NON_FOOD_OFF_CATEGORY_TAG_RE.test(t))
    ? "non-food"
    : p.categories_tags?.some((t) => /^en:(dietary-supplements|food-supplements)$/.test(t)) ||
        SUPPLEMENT_FORM.test(`${fullTitle} ${fallbackTitle}`)
      ? "supplement"
      : "food";
  const directOffImage =
    bestOffImage(p) ||
    lookupCuratedPhoto({ brand: brandStr, title: fullTitle, barcode: p.code })?.imageUrl;
  const result: Omit<LookupResult, "ms"> = {
    productTitle: fullTitle,
    brand: brandStr,
    barcode: p.code,
    ingredients: englishIngredients(p),
    imageUrl: directOffImage,
    offCategoriesTags: p.categories_tags,
    nutrition: inferNutritionFromText(fullTitle, englishIngredients(p), {
      ...baseNut,
      productKind: inferredKind,
    }),
    source: "openfoodfacts",
    sourceUpdatedAt,
  };
  return withSingleIngredientWholeFood(result);
}

/**
 * When the entire panel is one unprocessed ingredient (Kirkland "Beef.", "Carrots.") and the
 * whole-food classifier accepts it together with the title, flag it as a whole food so branded and
 * generic records of the same food score identically.
 */
export function singleIngredientWholeFoodFlags(
  title: string,
  ingredients: string,
): { isWholeFood: true; fruitsVegNutsPct?: number } | null {
  const ing = (ingredients || "").trim().replace(/[.\s]+$/, "");
  if (
    !ing ||
    /[,;()[\]&+/]/.test(ing) ||
    /\b(?:and|with|plus|or|in|contains)\b/i.test(ing) ||
    ing.split(/\s+/).length > 4
  ) {
    return null;
  }
  const ingCls = classifyWholeFood(ing);
  const combinedCls = classifyWholeFood(`${title} ${ing}`);
  if (ingCls.isWholeFood !== true || combinedCls.isWholeFood !== true) return null;
  return { isWholeFood: true, fruitsVegNutsPct: ingCls.fruitsVegNutsPct ?? combinedCls.fruitsVegNutsPct };
}

function withSingleIngredientWholeFood<T extends Omit<LookupResult, "ms">>(result: T): T {
  if (!result.nutrition || result.nutrition.isWholeFood === true) return result;
  const flags = singleIngredientWholeFoodFlags(result.productTitle || "", result.ingredients || "");
  if (!flags) return result;
  return {
    ...result,
    nutrition: {
      ...result.nutrition,
      isWholeFood: true,
      ...(flags.fruitsVegNutsPct !== undefined && result.nutrition.fruitsVegNutsPct === undefined
        ? { fruitsVegNutsPct: flags.fruitsVegNutsPct }
        : {}),
    },
  };
}

const NON_FOOD_VERTICAL_QUERY =
  /\b(shampoo|(?<!dough\s+)conditioner|body\s*wash|shower\s*gel|soap|hand\s*wash|lotion|moisturizer|(?:face|hand|eye|night|day|shaving|diaper|foot|skin|body)\s*cream|cleanser|face\s*wash|(?<!milk\s+|whey\s+)serum|(?:face|facial|skin)\s*toner|sunscreen|spf|deodorant|antiperspirant|toothpaste|mouthwash|lip\s*balm|mascara|(?:makeup|liquid)\s+foundation|concealer|lipstick|makeup|cosmetic|perfume|cologne|body\s*spray|hair\s*spray|hair\s*gel|hair\s*mousse|pomade|shaving|aftershave|diapers?|wipes?|detergent|laundry|cleaner|disinfect\w*|bleach|dish\s*soap|dishwashing|dog\s*food|cat\s*food|pet\s*food|puppy|kitten|kibble|purina|pedigree|friskies|blue\s*buffalo|fancy\s*feast|cesar|iams|rachael\s*ray\s*nutrish|cerave|cetaphil|neutrogena|aveeno|olay|dove\s+(?:soap|wash|shampoo|conditioner|deodorant|lotion|beauty|men)|pantene|tresemme|herbal\s*essences|head\s*&\s*shoulders|garnier|l'?oreal|maybelline|nyx|revlon|covergirl|e\.?l\.?f\.?|old\s*spice|(?:degree|secret|axe|native)\s+(?:deodorant|antiperspirant|body\s*wash|spray)|schmidt'?s|tom'?s\s*of\s*maine|colgate|crest|sensodyne|listerine|thera\s*breath|vaseline|aquaphor|eucerin|nivea|jergens|lubriderm|gold\s*bond|coppertone|banana\s*boat|sun\s*bum|la\s*roche|vichy|the\s+ordinary|dr\s*bronner|method\s+(?:soap|cleaner|wash|detergent)|mrs\.?\s*meyer'?s|seventh\s*generation|ecos)\b/i;

const OFF_KV_TTL_SECONDS = 7 * 24 * 60 * 60;

async function fetchOffProductByCode(
  code: string,
  host = "https://world.openfoodfacts.org",
): Promise<OffProduct | null> {
  const cacheKey = `${host}|${code}`;
  const cached = offBarcodeCache.get(cacheKey);
  if (cached) {
    const ttl = cached.product ? CACHE_TTL_MS : 10 * 60 * 1000;
    if (Date.now() - cached.cachedAt < ttl) return cached.product;
    offBarcodeCache.delete(cacheKey);
  }

  const kvKey = `heybroc:off_upc:v1:${cacheKey}`;
  if (isPersistentKvConfigured()) {
    try {
      const kvHit = await kvGet<OffProduct>(kvKey);
      if (kvHit?.code) {
        offBarcodeCache.set(cacheKey, { product: kvHit, cachedAt: Date.now() });
        return kvHit;
      }
    } catch {
      // Ignore transient KV read error and query OFF directly
    }
  }

  let data = await getJson<{ status?: number; product?: OffProduct }>(
    `${host}/api/v2/product/${code}?fields=${OFF_FIELDS}`,
  );
  if (!data && host === "https://world.openfoodfacts.org") {
    data = await getJson<{ status?: number; product?: OffProduct }>(
      `${host}/api/v0/product/${code}.json?fields=${OFF_FIELDS}`,
    );
  }
  if (data?.product) {
    if (offBarcodeCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = offBarcodeCache.keys().next().value;
      if (oldest) offBarcodeCache.delete(oldest);
    }
    offBarcodeCache.set(cacheKey, { product: data.product, cachedAt: Date.now() });
    if (isPersistentKvConfigured()) {
      void kvSet(kvKey, data.product, OFF_KV_TTL_SECONDS).catch(() => {});
    }
    return data.product;
  }
  if (data) {
    if (offBarcodeCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = offBarcodeCache.keys().next().value;
      if (oldest) offBarcodeCache.delete(oldest);
    }
    offBarcodeCache.set(cacheKey, { product: null, cachedAt: Date.now() });
  }
  return null;
}

async function offByBarcode(barcode: string): Promise<Omit<LookupResult, "ms"> | null> {
  const code = normalizeBarcode(barcode);
  if (!code) return null;
  const codes = Array.from(
    new Set([
      code,
      ...(code.length === 13 && code.startsWith("0") ? [code.slice(1)] : []),
      ...(code.length === 12 ? [`0${code}`] : []),
    ]),
  );
  const foodHost = "https://world.openfoodfacts.org";
  for (const c of codes) {
    const p = await fetchOffProductByCode(c, foodHost);
    if (p?.code && p.code.replace(/^0+/, "") === code.replace(/^0+/, "") && isUsMarketOffProduct(p) && englishIngredients(p)) {
      return offToResult(p, c);
    }
  }
  const sisterHosts = ["https://world.openbeautyfacts.org", "https://world.openproductsfacts.org", "https://world.openpetfoodfacts.org"];
  return firstAvailable(codes.flatMap(c => sisterHosts.map(async host => {
    const p = await fetchOffProductByCode(c, host);
    if (!p?.code || p.code.replace(/^0+/, "") !== code.replace(/^0+/, "")) return null;
    if (!isUsMarketOffProduct(p)) return null;
    return (p.ingredients_text_en || p.ingredients_text || "").trim() ? verticalResult(p, c, host) : null;
  })));
}

async function openFactsVerticalSearch(title: string): Promise<Omit<LookupResult, "ms"> | null> {
  if (!NON_FOOD_VERTICAL_QUERY.test(title)) return null;
  const q = encodeURIComponent(title);
  const isPet = /\b(dog\s*food|cat\s*food|pet\s*food|puppy|kitten|kibble|purina|pedigree|friskies|blue\s*buffalo|fancy\s*feast|cesar|iams)\b/i;
  const hosts = isPet.test(title)
    ? ["https://world.openpetfoodfacts.org", "https://world.openproductsfacts.org"]
    : ["https://world.openbeautyfacts.org", "https://world.openproductsfacts.org"];
  const responses = await Promise.all(
    hosts.map((host) =>
      getJson<{ products?: OffProduct[] }>(
        `${host}/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page_size=20&tagtype_0=countries&tag_contains_0=contains&tag_0=united-states&fields=${OFF_FIELDS}`,
      ),
    ),
  );
  for (const [i, res] of responses.entries()) {
    const best = pickBestOff(title, res?.products);
    if (best) return verticalResult(best, title, hosts[i]);
  }
  return null;
}

function verticalResult(p: OffProduct, title: string, host: string): Omit<LookupResult, "ms"> {
  const result = offToResult(p, title);
  return {
    ...result,
    ingredients: (p.ingredients_text_en || p.ingredients_text || "").trim(),
    source: host.includes("openbeautyfacts") ? "openbeautyfacts" : host.includes("openpetfoodfacts") ? "openpetfoodfacts" : "openproductsfacts",
    nutrition: { productKind: "non-food", isOrganic: false },
    sourceUrl: p.code ? `${host}/product/${p.code}` : undefined,
  };
}

type ProviderResult = Omit<LookupResult, "ms">;
async function firstAvailable(candidates: Promise<ProviderResult | null>[]): Promise<ProviderResult | null> {
  return Promise.any(candidates.map(async candidate => {
    const result = await candidate;
    if (!result) throw new Error("No validated provider match");
    return result;
  })).catch(() => null);
}

function scoreProviderCandidate(query: string, cand: ProviderResult): number {
  const isSuppQuery = SUPPLEMENT_FORM.test(query);
  if (cand.source === "dsld") return isSuppQuery ? 10 : 0.15;
  if (cand.nutrition?.productKind === "non-food") return NON_FOOD_VERTICAL_QUERY.test(query) ? 5 : 0.2;
  const wholeQuery = genericWholeFoodQuery(query);
  const r = wholeQuery && cand.nutrition?.isWholeFood
    ? Math.max(relevance(wholeQuery, cand.productTitle), 0.92)
    : relevance(query, cand.productTitle);
  const nut = cand.nutrition;
  const hasCoreMacros =
    nut?.caloriesKcal100g !== undefined &&
    nut?.sugarsG100g !== undefined &&
    nut?.sodiumMg100g !== undefined
      ? 0.08
      : 0;
  const hasRealPhoto =
    cand.source === "openfoodfacts" && cand.imageUrl?.includes("openfoodfacts.org") ? 0.04 : 0;
  const isBulkOrSingleServe =
    /\b(\d+\s*(?:count|ct)\b|to\s+go|foodservice|bulk|single\s+serve|portion)\b/i.test(cand.productTitle) &&
    !/\b(\d+\s*(?:count|ct)\b|to\s+go|cups?|pouches)\b/i.test(query)
      ? 0.25
      : 0;
  return r + hasCoreMacros + hasRealPhoto - isBulkOrSingleServe;
}

function doesBarcodeResultMatchTitle(queryTitle: string, found: ProviderResult): boolean {
  const qRaw = (queryTitle || "").trim();
  if (!qRaw || /^\d{8,14}$/.test(qRaw)) return true;
  if (!matchesRequestedBrand(qRaw, found.brand || "", found.productTitle)) return false;
  if (!passesVariantGuard(qRaw, found.productTitle)) return false;
  if (isDietaryOrVariantMismatch(qRaw, found.productTitle, found.ingredients, found.nutrition)) return false;
  const brandToks = new Set(tokens(`${detectQueryBrand(qRaw)} ${found.brand || ""}`));
  const qAll = tokens(qRaw).filter((t) => !GENERIC.has(t) && !GENERIC_LEADING_MODIFIERS.has(t));
  const fAll = tokens(`${found.brand || ""} ${found.productTitle}`).filter(
    (t) => !GENERIC.has(t) && !GENERIC_LEADING_MODIFIERS.has(t),
  );
  const qFood = qAll.filter((t) => !brandToks.has(t));
  const fFood = fAll.filter((t) => !brandToks.has(t));
  if (qFood.length > 0 && fFood.length > 0) {
    return qFood.some((qt) => fFood.some((ft) => tokenEquivalent(qt, ft)));
  }
  if (qAll.length > 0 && fAll.length > 0) {
    return qAll.some((qt) => fAll.some((ft) => tokenEquivalent(qt, ft)));
  }
  return true;
}

/** One shared wall-clock budget covers multi-stage provider searches with deterministic quality selection. */
async function lookupProviders(input: LookupInput): Promise<ProviderResult | null> {
  const ctx = lookupAttemptContext.getStore();
  let effectiveTimeoutMs = TIMEOUT_MS;
  let clampedByBatchDeadline = false;
  if (typeof ctx?.deadlineMs === "number") {
    const remainingMs = ctx.deadlineMs - Date.now();
    if (remainingMs < 250) {
      markLookupOperationalFailure();
      ctx.onDeadlineExceeded?.();
      return null;
    }
    if (remainingMs < TIMEOUT_MS) {
      effectiveTimeoutMs = remainingMs;
      clampedByBatchDeadline = true;
    }
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      markLookupOperationalFailure();
      if (clampedByBatchDeadline || (typeof ctx?.deadlineMs === "number" && Date.now() >= ctx.deadlineMs - 50)) {
        ctx?.onDeadlineExceeded?.();
      }
      controller.abort();
      resolve(null);
    }, effectiveTimeoutMs);
  });
  const work = providerSignal.run(controller.signal, async () => {
    const normCode = normalizeBarcode(input.barcode);
    const rawTitle = (input.productTitle || "").trim();
    if (normCode) {
      const barcodeProviders = [
        offByBarcode(normCode),
        usdaSearch(normCode),
        lookupDsld({ ...input, barcode: normCode }, getJson),
      ].map((p) =>
        p.then(
          (r) => (r && (!rawTitle || doesBarcodeResultMatchTitle(rawTitle, r)) ? r : null),
          () => null,
        ),
      );
      const byCode = await firstAvailable(barcodeProviders);
      if (byCode) {
        return byCode;
      }
      if (!rawTitle) return null;
    }
    if (!rawTitle) return null;
    const cleaned = cleanSearchQuery(rawTitle) || rawTitle;
    const passesRawTitleGuard = (r: ProviderResult): boolean =>
      !rawTitle ||
      (passesVariantGuard(rawTitle, r.productTitle) &&
        !isDietaryOrVariantMismatch(rawTitle, r.productTitle, r.ingredients, r.nutrition));
    const pOff = offSearch(cleaned);
    const pUsda = usdaSearch(cleaned);
    const pDsld = lookupDsld({ ...input, barcode: undefined, productTitle: cleaned }, getJson);
    const all = [pOff, pUsda, pDsld];
    const first = await firstAvailable(all);
    if (!first) return null;
    if (first.source === "dsld" && SUPPLEMENT_FORM.test(cleaned) && passesRawTitleGuard(first)) return first;
    // Give peer provider a brief grace window so OFF vs USDA never depends on a 5ms network race
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(all),
      new Promise<void>(resolve => { graceTimer = setTimeout(resolve, 320); }),
    ]);
    clearTimeout(graceTimer);
    const resolved: ProviderResult[] = [];
    for (const p of all) {
      const val = await Promise.race([p.catch(() => null), Promise.resolve(undefined)]);
      if (val && passesRawTitleGuard(val)) resolved.push(val);
    }
    if (!resolved.length) return passesRawTitleGuard(first) ? first : null;
    resolved.sort((a, b) => scoreProviderCandidate(cleaned, b) - scoreProviderCandidate(cleaned, a));
    return resolved[0];
  });
  try { return await Promise.race([work, deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}

interface OffSearchHit extends OffProduct {
  states_tags?: string[];
}

const BRAND_SEARCH_AISLE_NOUNS = new Set([
  "pasta", "sauce", "sauces", "salsa", "picante", "cereal", "cereals",
  "crackers", "cracker", "cookies", "cookie", "chips", "chip", "crisps",
  "waffles", "waffle", "muffins", "muffin", "tortillas", "tortilla",
  "soup", "soups", "pizza", "pizzas", "spread", "jam", "jelly", "preserves",
  "ketchup", "catsup", "ranch", "dressing", "mayo", "mayonnaise",
  "yogurt", "yoghurt", "cheese", "milk", "drink", "drinks", "soda", "pop",
  "water", "bars", "bar", "snacks", "snack", "pastry", "pastries", "toaster",
  "bread", "oats", "oatmeal", "hot", "dog", "dogs", "hotdog", "hotdogs",
  "wiener", "wieners", "frank", "franks", "frankfurters",
]);

async function offSearch(title: string): Promise<Omit<LookupResult, "ms"> | null> {
  const kvSearchKey = `heybroc:off_search:v1:${title.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120)}`;
  if (isPersistentKvConfigured()) {
    try {
      const kvHit = await kvGet<Omit<LookupResult, "ms">>(kvSearchKey);
      if (kvHit?.ingredients && isEnglishIngredientText(kvHit.ingredients)) {
        return kvHit;
      }
    } catch {
      // Ignore transient KV read error
    }
  }
  const cacheSearchResult = (res: Omit<LookupResult, "ms"> | null): Omit<LookupResult, "ms"> | null => {
    if (res && isPersistentKvConfigured()) {
      void kvSet(kvSearchKey, res, OFF_KV_TTL_SECONDS).catch(() => {});
    }
    return res;
  };

  const vertical = await openFactsVerticalSearch(title);
  if (vertical) return cacheSearchResult(vertical);

  const toks = tokens(title);
  const firstTok = toks[0] || "";
  const detectedBrandRaw = detectQueryBrand(title);
  const brandSlug = detectedBrandRaw
    ? detectedBrandRaw.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    : firstTok;
  const possessiveSlug =
    detectedBrandRaw && /['’]s\b/i.test(detectedBrandRaw)
      ? detectedBrandRaw.toLowerCase().replace(/['’]s\b/g, " s").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
      : "";
  const brandTagClause =
    possessiveSlug && possessiveSlug !== brandSlug
      ? `(brands_tags:"${possessiveSlug}" OR brands_tags:"${brandSlug}")`
      : `brands_tags:${brandSlug}`;
  const remainingWords = (detectedBrandRaw
    ? title.replace(new RegExp(detectedBrandRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ")
    : title
  )
    .toLowerCase()
    .replace(/['’]s\b/g, "s")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(keepToken);

  const brandModifiers = remainingWords.filter((w) => !BRAND_SEARCH_AISLE_NOUNS.has(w));
  const hotDogBrandClause = /\b(hot\s*dogs?|wieners?|franks?|frankfurters?)\b/i.test(title)
    ? `categories_tags:"en:sausages"`
    : "";

  const allSearchWords = collapseSingleLetterCompounds(title)
    .toLowerCase()
    .replace(/['’]s\b/g, "s")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(
      (w) =>
        (w.length >= 2 || SHORT_BRAND_TOKENS.has(w)) &&
        !STOP.has(w) &&
        !/^\d+$/.test(w) &&
        !/^(?:naturally|fully|cooked|lightly|priced|per|pound|pounds|food|foods|kids|kid|shelf|stable|pantry|staple|staples|seasonal|snap|ebt|eligible|lunchbox)$/.test(w),
    );
  const compactSearchWords =
    allSearchWords.length > 5
      ? allSearchWords.filter((w) => !/^(?:original|classic|traditional|homestyle|breakfast|lunch|delicious|toasted|frozen|refrigerated)$/.test(w))
      : allSearchWords;
  const effectiveSearchWords = compactSearchWords.length >= 2 ? compactSearchWords : allSearchWords;
  const searchWords =
    effectiveSearchWords.length <= 6
      ? effectiveSearchWords
      : Array.from(new Set([...effectiveSearchWords.slice(0, 4), ...effectiveSearchWords.slice(-2)]));

  const usCompletedFilter = `countries_tags:"en:united-states" states_tags:"en:ingredients-completed"`;
  const andQuery = searchWords.length
    ? `${searchWords.join(" AND ")} AND countries_tags:"en:united-states" AND states_tags:"en:ingredients-completed"`
    : `${title} ${usCompletedFilter}`;
  const compactBrandMods =
    brandModifiers.length > 4
      ? brandModifiers.filter((w) => !/^(?:original|classic|traditional|homestyle|breakfast|lunch|delicious|toasted|frozen|refrigerated|food|foods|kids|kid|shelf|stable|pantry|staple|staples)$/.test(w))
      : brandModifiers;
  const effectiveBrandMods = compactBrandMods.length >= 1 ? compactBrandMods : brandModifiers;
  const trimmedBrandMods =
    effectiveBrandMods.length <= 5
      ? effectiveBrandMods
      : Array.from(new Set([...effectiveBrandMods.slice(0, 3), ...effectiveBrandMods.slice(-2)]));
  const brandModAndClause = [...trimmedBrandMods, hotDogBrandClause].filter(Boolean).join(" AND ");
  const brandQuery =
    brandSlug
      ? `${brandTagClause}${brandModAndClause ? ` AND ${brandModAndClause}` : ""} AND countries_tags:"en:united-states" AND states_tags:"en:ingredients-completed"`
      : `${title} ${usCompletedFilter}`;
  const brandAnchor = detectedBrandRaw ? detectedBrandRaw.toLowerCase() : firstTok;

  const searchFields = `${OFF_FIELDS},states_tags`;

  const validateFetchedProduct = (p: OffProduct | null, h?: OffSearchHit): Omit<LookupResult, "ms"> | null => {
    if (!p || !isUsMarketOffProduct(p)) return null;
    const ing = englishIngredients(p);
    if (!ing) return null;
    const rawProdName = (p.product_name_en || p.product_name || "").trim();
    if (!rawProdName) return null;
    const brandStr = normalizeOffBrand(p.brands);
    const name = mergeBrandAndTitle(brandStr.split(",")[0]?.trim(), rawProdName);
    if (!matchesRequestedBrand(title, brandStr, name)) return null;
    if (!passesVariantGuard(title, name)) return null;
    if (relevance(title, name, p.categories_tags) < 0.5) return null;
    if (isDietaryOrVariantMismatch(title, name, ing, extractOffNutrition(p))) return null;
    if (!bestOffImage(p) && h) {
      const hitImg = bestOffImage(h);
      if (hitImg) p.image_front_url = hitImg;
    }
    return offToResult(p, title);
  };

  const evaluateHits = async (rawHits: OffSearchHit[] | undefined): Promise<Omit<LookupResult, "ms"> | null> => {
    if (!rawHits?.length || providerSignal.getStore()?.aborted) return null;
    const deduped: OffSearchHit[] = [];
    const seenCodes = new Set<string>();
    for (const h of rawHits) {
      const code = (h.code || "").trim();
      if (!code || seenCodes.has(code)) continue;
      seenCodes.add(code);
      deduped.push(h);
    }
    const ranked = deduped
      .filter(
        (h) =>
          h.code &&
          isUsMarketOffProduct(h) &&
          (!Array.isArray(h.states_tags) || h.states_tags.includes("en:ingredients-completed")),
      )
      .map((h) => {
        const rawProdName = (h.product_name_en || h.product_name || "").trim();
        if (!rawProdName) return { h, score: 0 };
        const brandStr = normalizeOffBrand(h.brands);
        const name = mergeBrandAndTitle(brandStr.split(",")[0]?.trim(), rawProdName);
        if (!matchesRequestedBrand(title, brandStr, name)) return { h, score: 0 };
        if (!passesVariantGuard(title, name)) return { h, score: 0 };
        const r = relevance(title, name, h.categories_tags);
        if (r < 0.5) return { h, score: 0 };
        const brandBonus =
          brandAnchor.length >= 3 &&
          (brandStr.toLowerCase().includes(brandAnchor) || name.toLowerCase().startsWith(brandAnchor))
            ? 0.08
            : 0;
        const hasImg = Boolean(h.image_front_url || h.image_url || h.image_front_small_url);
        const codeStr = (h.code || "").trim();
        const isUsCountry =
          Array.isArray(h.countries_tags) && h.countries_tags.includes("en:united-states");
        const isNorthAmericanUpc = /^(?:00?\d{11}|\d{11,12}|0\d{7})$/.test(codeStr);
        const usMarketBonus =
          isUsCountry && isNorthAmericanUpc
            ? 0.25
            : isNorthAmericanUpc
              ? 0.14
              : isUsCountry
                ? 0.10
                : 0;
        return { h, score: r + brandBonus + usMarketBonus + (hasImg ? 0.03 : 0) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (!ranked.length) return null;

    // Validate inline hits first (zero product-read requests when Search-a-licious returns inline ingredients)
    const missingInline: Array<{ idx: number; code: string; h: OffSearchHit }> = [];
    const results: Array<Omit<LookupResult, "ms"> | null> = new Array(ranked.length).fill(null);
    for (let i = 0; i < ranked.length; i++) {
      const { h } = ranked[i];
      if (englishIngredients(h)) {
        results[i] = validateFetchedProduct(h, h);
      } else if (h.code) {
        missingInline.push({ idx: i, code: h.code, h });
      }
    }
    if (results[0]) return results[0];

    if (missingInline.length > 0 && !providerSignal.getStore()?.aborted) {
      const fetched = await Promise.all(
        missingInline.map((m) => fetchOffProductByCode(m.code, "https://world.openfoodfacts.org")),
      );
      for (let j = 0; j < missingInline.length; j++) {
        results[missingInline[j].idx] = validateFetchedProduct(fetched[j], missingInline[j].h);
      }
    }
    for (const r of results) {
      if (r) return r;
    }
    return null;
  };

  // 1. Primary US Search-a-licious AND query (single search request in the common case)
  const v3And = await getJson<{ hits?: OffSearchHit[] }>(
    `https://search.openfoodfacts.org/search?q=${encodeURIComponent(andQuery)}&page_size=20&fields=${searchFields}`,
  );
  const fromAnd = await evaluateHits(v3And?.hits);
  if (fromAnd) return cacheSearchResult(fromAnd);

  // 2. Secondary brand-tag query only if primary AND query returned zero raw hits for a known brand
  if (
    v3And !== null &&
    (v3And.hits?.length ?? 0) === 0 &&
    Boolean(detectedBrandRaw) &&
    brandQuery !== andQuery &&
    !providerSignal.getStore()?.aborted
  ) {
    const v3Brand = await getJson<{ hits?: OffSearchHit[] }>(
      `https://search.openfoodfacts.org/search?q=${encodeURIComponent(brandQuery)}&page_size=20&fields=${searchFields}`,
    );
    const fromBrand = await evaluateHits(v3Brand?.hits);
    if (fromBrand) return cacheSearchResult(fromBrand);
  }

  // 3. Single-hop fallback to Open Food Facts US CGI search only when Search-a-licious was unreachable or omitted hits
  if (Array.isArray(v3And?.hits) || providerSignal.getStore()?.aborted) return null;
  const cgiTerms = encodeURIComponent(title.replace(/-/g, " "));
  const cgiRes = await getJson<{ products?: OffProduct[] }>(
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${cgiTerms}&search_simple=1&action=process&json=1&page_size=12&tagtype_0=countries&tag_contains_0=contains&tag_0=united-states&fields=${OFF_FIELDS}`,
  );
  const cgiBest = pickBestOff(title, cgiRes?.products);
  return cacheSearchResult(cgiBest ? offToResult(cgiBest, title) : null);
}

/* ------------------------------------------------------------------ */
/* USDA FoodData Central (Branded + Foundation + SR Legacy + Survey)   */
/* ------------------------------------------------------------------ */

const STORE_HOUSE_WHOLE_FOOD_BRAND_RE =
  /\b(member'?s\s+mark|kirkland(?:\s+signature)?|marketside(?:\s+butcher)?|freshness\s+guaranteed|great\s+value|sam'?s\s+choice|good\s*(?:&|and)\s*gather|favorite\s+day|market\s+pantry|simple\s+truth(?:\s+organic)?|private\s+selection|heritage\s+farm|wellsley\s+farms|berkley\s+jensen|simply\s+nature|specially\s+selected|friendly\s+farms|kirkwood|amazon\s+fresh|amazon\s+grocery|happy\s+belly|aplenty|nature'?s\s+promise|signature\s+select|o\s+organics|open\s+nature|lucerne|365(?:\s+by\s+whole\s+foods(?:\s+market)?)?|whole\s+foods(?:\s+market)?|trader\s+joe'?s?|sprouts(?:\s+farmers\s+market)?|publix|greenwise|wegmans|h[- ]?e[- ]?b)\b/gi;

export function genericWholeFoodQuery(query: string): string | null {
  if (classifyWholeFood(query).isWholeFood !== true) return null;
  const text = query.toLowerCase();
  if (/\bfrozen\b/.test(text) && /\bwings?\b/.test(text) && /\bchicken\b/.test(text)) return null;
  const food = text.match(/\b(apples?|almonds?|walnuts?|cashews?|chia\s+seeds?|flax\s*seeds?|pumpkin\s+seeds?|salmon|trout|cod|tuna|chicken|turkey|beef|pork|eggs?|oats?|oatmeal|quinoa|broccoli|spinach|carrots?|sweet\s+potato(?:es)?|potato(?:es)?|yams?|tomato(?:es)?|avocados?|bananas?|lentils?|chickpeas?|olive\s+oil|greek\s+yogurt)\b/)?.[0];
  if (!food) return null;
  const meatCut = /^(?:beef|pork|chicken|turkey)$/.test(food)
    ? text.match(/\b(wings?|breasts?|thighs?|drumsticks?|ground|ribs?|brisket|sirloin|ribeye|tenderloins?|round|chuck|belly|chops?|loins?)\b/)?.[0]
    : undefined;
  const species = text.match(/\b(atlantic|pacific|sockeye|pink|chinook)\b/)?.[0];
  const preparation = /\b(greek\s+yogurt)\b/.test(food) ? "plain" : /olive\s+oil|oats?|oatmeal|quinoa/.test(food) ? "" : /\b(cooked|roasted|boiled|baked)\b/.exec(text)?.[0] || "raw";
  return [food === "oatmeal" ? "oats" : food, meatCut, species, preparation].filter(Boolean).join(" ");
}

export function matchesGenericWholeFood(query: string, candidate: string): boolean {
  const canonical = genericWholeFoodQuery(query);
  if (!canonical || classifyWholeFood(candidate).isWholeFood !== true) return false;
  if (/\broasts?\b/i.test(query) && /\bsteaks?\b/i.test(candidate) && !/\broasts?\b/i.test(candidate)) return false;
  if (/\bsteaks?\b/i.test(query) && /\broasts?\b/i.test(candidate) && !/\bsteaks?\b/i.test(candidate)) return false;
  const MEAT_CUT_FAMILIES: RegExp[] = [
    /\bwings?\b/i,
    /\bbreasts?\b/i,
    /\bthighs?\b/i,
    /\bdrumsticks?\b/i,
    /\bground\b/i,
    /\bribs?\b/i,
    /\bbrisket\b/i,
    /\bsirloin\b/i,
    /\bribeye\b/i,
    /\btenderloins?\b/i,
    /\bbelly\b/i,
    /\bchops?\b/i,
    /\bloins?\b/i,
  ];
  for (const cutRe of MEAT_CUT_FAMILIES) {
    const qHas = cutRe.test(query);
    const cHas = cutRe.test(candidate);
    if (qHas && !cHas) return false;
    if (cHas && !qHas && cutRe.source === "\\bground\\b") return false;
  }
  const stem = (w: string) => w.length > 3 ? w.replace(/s$/, "") : w;
  const candidateWords = new Set(candidate.toLowerCase().split(/[^a-z]+/).filter(Boolean).map(stem));
  const identity = canonical.replace(/\b(raw|cooked|roasted|boiled|baked|plain)\b/g, "").trim().split(/\s+/);
  if (!identity.every(word => candidateWords.has(stem(word)))) return false;

  const queryCleaned = query
    .replace(STORE_HOUSE_WHOLE_FOOD_BRAND_RE, " ")
    .toLowerCase()
    .replace(/\b(?:priced|price)\s+per\s+(?:pound|lb)\b/gi, " ")
    .replace(/\b\d+(?:\.\d+)?(?:\s*[-–—x×/]\s*\d+(?:\.\d+)?)?\s*(?:%|fl\.?\s*oz|oz|ounces?|lbs?|pounds?|g|grams?|kg|ct|count|pk|packs?|pcs?|pieces?|dozens?)\b/gi, " ")
    .replace(/\b\d+(?:\.\d+)?\b/g, " ");
  const queryWords = queryCleaned.split(/[^a-z]+/).filter((w) => w.length >= 2);
  const allowedWholeAliases = new Set(["oatmeal", "oats", "cooked", "roasted", "boiled", "baked", "plain", "greek", "yogurt", "extra", "virgin", "olive", "oil"]);
  for (const w of queryWords) {
    if (
      !candidateWords.has(stem(w)) &&
      !allowedWholeAliases.has(w) &&
      !WHOLE_FOOD_PRODUCE_DESCRIPTORS.has(w) &&
      !WHOLE_FOOD_MEAT_DESCRIPTORS.has(w) &&
      !WHOLE_FOOD_NUTS_DESCRIPTORS.has(w)
    ) {
      return false;
    }
  }

  const prep = canonical.match(/\b(raw|cooked|roasted|boiled|baked)\b/)?.[0];
  const cooked = /\b(cooked|roasted|boiled|baked|grilled|broiled|poached|steamed)\b/i;
  if (prep === "raw" && cooked.test(candidate)) return false;
  if (prep && prep !== "raw" && (!cooked.test(candidate) || /\braw\b/i.test(candidate))) return false;
  if (prep && /^(roasted|boiled|baked)$/.test(prep) && !new RegExp("\\b" + prep + "\\b", "i").test(candidate)) return false;
  return true;
}

const USDA_LUCENE_SKIP_WORDS = new Set([
  "the", "and", "with", "for", "from", "in", "of", "by", "on", "to",
  "snack", "snacks", "pack", "size", "family", "party", "share", "value", "giant", "mega",
  "bag", "box", "can", "jar", "bottle", "tub", "carton", "pouch", "tray", "cup", "bowl",
  "count", "ct", "oz", "fl", "lb", "lbs", "gal", "gallon", "half", "quart", "pint", "pkg",
  "assorted", "variety", "homemade", "fresh", "pure",
  "naturally", "fully", "cooked", "lightly", "priced", "per", "pound", "pounds", "avg", "average", "price",
  "food", "foods", "kids", "kid", "shelf", "stable", "pantry", "staple", "staples", "seasonal", "snap", "ebt", "eligible", "lunchbox",
]);

function buildUsdaLuceneQuery(query: string): string {
  const allWords = query
    .replace(/['’]s\b/gi, "")
    .replace(/['’]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !USDA_LUCENE_SKIP_WORDS.has(w.toLowerCase()) && !/^\d+$/.test(w));
  const compactWords =
    allWords.length > 4
      ? allWords.filter(
          (w) =>
            !/^(?:original|classic|traditional|homestyle|breakfast|lunch|delicious|toasted|frozen|refrigerated|bone|boneless|skinless|skin|wild|caught|farm|raised|handmade|hand|made|individually|quick|uncooked|raw|portions|portion|fillets|fillet)$/i.test(
              w,
            ),
        )
      : allWords;
  const effectiveWords = compactWords.length >= 2 ? compactWords : allWords;
  const words =
    effectiveWords.length <= 6
      ? effectiveWords
      : Array.from(new Set([...effectiveWords.slice(0, 4), ...effectiveWords.slice(-2)]));
  if (words.length < 2) return "";
  return words.map((w) => `+${w}`).join(" ");
}

let usdaPortalUnavailableUntil = 0;

async function postUsdaPortalSearch(
  searchInput: string,
  includeDataTypes: Record<string, boolean>,
  pageSize: number,
): Promise<{ foods?: UsdaFood[] } | null> {
  if (Date.now() < usdaPortalUnavailableUntil) return null;
  try {
    const res = await fetch("https://fdc.nal.usda.gov/portal-data/external/search", {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        includeDataTypes,
        referenceFoodsCheckBox: false,
        generalSearchInput: searchInput,
        requireAllWords: false,
        pageNumber: 1,
        pageSize,
      }),
      signal: providerSignal.getStore()
        ? AbortSignal.any([providerSignal.getStore()!, AbortSignal.timeout(effectiveLookupStepTimeoutMs())])
        : AbortSignal.timeout(effectiveLookupStepTimeoutMs()),
      cache: "no-store",
    });
    if (!res.ok) {
      if (res.status === 429 || res.status >= 502) {
        usdaPortalUnavailableUntil = Date.now() + 60_000;
      }
      return null;
    }
    const type = res.headers.get("content-type") || "";
    if (!type.includes("json")) return null;
    return (await res.json()) as { foods?: UsdaFood[] };
  } catch {
    return null;
  }
}

async function usdaSearch(query: string): Promise<Omit<LookupResult, "ms"> | null> {
  const key = encodeURIComponent((process.env.USDA_API_KEY || "").trim() || "DEMO_KEY");
  const numericBarcode = query.replace(/\D/g, "");
  const isBarcodeQuery = numericBarcode.length >= 8 && numericBarcode === query.trim().replace(/[-\s]/g, "");

  let best = null as UsdaFood | null;
  let bestScore = 0;

  const evaluateFoods = (foods: UsdaFood[] | undefined) => {
    for (const f of foods || []) {
      const isTrueWholeFood =
        ["Foundation", "SR Legacy"].includes(f.dataType || "") &&
        classifyWholeFood(f.description || "").isWholeFood === true;
      const ing =
        f.ingredients?.trim() ||
        (isTrueWholeFood ? `Whole Food: ${f.description}` : "");
      if (!ing || !isEnglishIngredientText(ing)) continue;
      const candidateName = mergeBrandAndTitle(f.brandName || f.brandOwner, f.description || "");
      if (!isBarcodeQuery && !isTrueWholeFood && !matchesRequestedBrand(query, f.brandName || f.brandOwner, candidateName)) continue;
      // Generic USDA nutrient records cannot substantiate organic certification.
      // A branded record must still match the requested certified product line.
      const variantQuery = isTrueWholeFood ? query.replace(/\borganic\s+/gi, "") : query;
      if (!isBarcodeQuery && !passesVariantGuard(variantQuery, candidateName)) continue;
      const nut = extractUsdaNutrition(f);
      if (isTrueWholeFood && !isBarcodeQuery && !matchesGenericWholeFood(query, candidateName)) continue;
      if (!isBarcodeQuery && isDietaryOrVariantMismatch(query, candidateName, ing, nut)) continue;
      let r = 0;
      if (isBarcodeQuery) {
        const fCode = (f.gtinUpc || "").replace(/\D/g, "");
        if (fCode && (fCode === numericBarcode || fCode.padStart(13, "0") === numericBarcode.padStart(13, "0"))) {
          r = 1;
        }
      } else {
        r = relevance(isTrueWholeFood ? genericWholeFoodQuery(query) || query : query, candidateName);
      }
      if (r > bestScore) {
        best = { ...f, ingredients: ing };
        bestScore = r;
      }
    }
  };

  const luceneQuery = !isBarcodeQuery ? buildUsdaLuceneQuery(query) : "";
  const wholeQuery = genericWholeFoodQuery(query);
  const searchInput = luceneQuery || query;

  if (Date.now() >= usdaUnavailableUntil) {
    const requests = [
      getJson<{ foods?: UsdaFood[] }>(
        `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(searchInput)}&dataType=Branded&pageSize=18&api_key=${key}`,
      ),
    ];
    if (wholeQuery) {
      requests.push(
        getJson<{ foods?: UsdaFood[] }>(
          `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(wholeQuery)}&dataType=${encodeURIComponent("Foundation,SR Legacy")}&pageSize=20&api_key=${key}`,
        ),
      );
    }
    const responses = await Promise.all(requests);
    for (const response of responses) evaluateFoods(response?.foods);
    if (responses.every((r) => r === null) && !providerSignal.getStore()?.aborted) {
      const portalFallback = await Promise.all([
        postUsdaPortalSearch(searchInput, { Branded: true }, 18),
        ...(wholeQuery ? [postUsdaPortalSearch(wholeQuery, { Foundation: true, "SR Legacy": true }, 20)] : []),
      ]);
      for (const response of portalFallback) evaluateFoods(response?.foods);
    }
  } else {
    // DEMO_KEY on api.nal.usda.gov enforces a strict 10-req/4h IP cap; use USDA's public FoodData Central search directly
    const portalRequests = [
      postUsdaPortalSearch(searchInput, { Branded: true }, 18),
      ...(wholeQuery ? [postUsdaPortalSearch(wholeQuery, { Foundation: true, "SR Legacy": true }, 20)] : []),
    ];
    const responses = await Promise.all(portalRequests);
    for (const response of responses) evaluateFoods(response?.foods);
  }

  // Secondary relaxed query when strict +word Lucene missed due to an extra retailer adjective (still strictly gated by brand + variant + relevance >= 0.55)
  if (
    (!best || bestScore < 0.55) &&
    !isBarcodeQuery &&
    luceneQuery &&
    luceneQuery.split(/\s+/).length >= 4 &&
    !providerSignal.getStore()?.aborted
  ) {
    const relaxedInput = luceneQuery.replace(/\+/g, "");
    if (Date.now() >= usdaUnavailableUntil) {
      const relRes = await getJson<{ foods?: UsdaFood[] }>(
        `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(relaxedInput)}&dataType=Branded&pageSize=18&api_key=${key}`,
      );
      if (relRes) {
        evaluateFoods(relRes.foods);
      } else if (!providerSignal.getStore()?.aborted) {
        const portalRel = await postUsdaPortalSearch(relaxedInput, { Branded: true }, 18);
        evaluateFoods(portalRel?.foods);
      }
    } else {
      const portalRel = await postUsdaPortalSearch(relaxedInput, { Branded: true }, 18);
      evaluateFoods(portalRel?.foods);
    }
  }

  if (!best || bestScore < 0.55) return null;
  const rawDesc = (best.description || "")
    .replace(/^(.+?),\s*([^,]+)$/, (full: string, prefix: string, suffix: string) => {
      const prefixWords = new Set(prefix.toLowerCase().split(/\W+/).filter(Boolean));
      const suffixWords = suffix.toLowerCase().split(/\W+/).filter(Boolean);
      return suffixWords.length > 0 && suffixWords.every((w) => prefixWords.has(w)) ? prefix : full;
    })
    .trim();
  const rawBrandLabel = (best.brandName || best.brandOwner || "").trim();
  const brandLabel = rawBrandLabel ? normalizeOffDisplayTitle(rawBrandLabel) : "USDA FoodData Central";
  const isFoundationWholeFoodOrganic =
    ["Foundation", "SR Legacy"].includes(best.dataType || "") &&
    classifyWholeFood(best.description || "").isWholeFood === true &&
    classifyWholeFood(query).isWholeFood === true &&
    /\borganic\b/i.test(query) &&
    !/\b(?:non[-\s]*organic|made\s+with\s+organic|less\s+than\s+\d+%\s+organic)\b/i.test(query);
  const baseDescTitle = normalizeOffDisplayTitle(rawDesc) || normalizeOffDisplayTitle(query);
  const descTitle =
    isFoundationWholeFoodOrganic && !/\borganic\b/i.test(baseDescTitle)
      ? `Organic ${baseDescTitle}`
      : baseDescTitle;
  const fullTitle = normalizeOffDisplayTitle(
    brandLabel !== "USDA FoodData Central"
      ? mergeBrandAndTitle(brandLabel, descTitle)
      : descTitle,
  );
  const usdaBrandParam =
    brandLabel && brandLabel !== "USDA FoodData Central" ? `&brand=${encodeURIComponent(brandLabel)}` : "";
  const usdaCodeParam = best.gtinUpc ? `&code=${encodeURIComponent(best.gtinUpc)}` : "";
  const imageUrl = `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(fullTitle)}${usdaBrandParam}${usdaCodeParam}&v=6`;
  const cleanUsdaIng = sanitizeIngredientDisplay(best.ingredients!.trim());
  const extractedUsdaNut = inferNutritionFromText(rawDesc, cleanUsdaIng, extractUsdaNutrition(best));
  return withSingleIngredientWholeFood({
    productTitle: fullTitle,
    brand: brandLabel,
    barcode: best.gtinUpc,
    ingredients: cleanUsdaIng,
    imageUrl,
    nutrition: isFoundationWholeFoodOrganic ? { ...extractedUsdaNut, isOrganic: true } : extractedUsdaNut,
    sourceUrl: best.fdcId ? `https://fdc.nal.usda.gov/food-details/${best.fdcId}/nutrients` : undefined,
    source: "usda",
    sourceUpdatedAt: best.publishedDate ? best.publishedDate.slice(0, 10) : null,
  });
}

/* ------------------------------------------------------------------ */
/* Built-In Instant Grocery Encyclopedia + Universal Category Fallback */
/* Fresh reference formulations; unmatched products can return null. */
/* ------------------------------------------------------------------ */

export interface CatalogEntry {
  match: RegExp;
  brand: string;
  title: string;
  barcode?: string;
  keywords?: string[];
  ingredients: string;
  imageUrl?: string;
  nutrition?: NutritionInput;
  sourceUrl: string;
  verifiedAt: string;
}

export const INSTANT_GROCERY_CATALOG: CatalogEntry[] = [
  {
    match: /^(?!.*\b(?:unfrosted|bites?|cereal|protein|pretzel|chilled|banana|blueberry|cherry|wild\s+berry|s'?mores|brown\s+sugar|cinnamon|cookies|chocolate|fudge|raspberry|apple|lemon|peach|snickerdoodle|confetti|hot\s+fudge|sundae)\b).*\bpop[- ]?tarts?\b.*\bfrosted\b.*\bstrawberr(?:y|ies)\b/i,
    brand: "Pop-Tarts",
    title: "Pop-Tarts Frosted Strawberry Toaster Pastries",
    barcode: "0038000222511",
    keywords: ["kelloggs", "kellogg's", "pop tarts", "poptarts", "toaster", "pastries", "pastry", "frosted", "strawberry", "breakfast", "snack"],
    ingredients:
      "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1 [Thiamin Mononitrate], Vitamin B2 [Riboflavin], Folic Acid), Corn Syrup, High Fructose Corn Syrup, Dextrose, Soybean and Palm Oil (with TBHQ for Freshness), Sugar, Bleached Wheat Flour, Contains 2% or Less of Wheat Starch, Salt, Dried Strawberries, Dried Pears, Dried Apples, Leavening (Baking Soda, Sodium Acid Pyrophosphate, Monocalcium Phosphate), Citric Acid, Gelatin, Modified Wheat Starch, Yellow Corn Flour, Caramel Color, Xanthan Gum, Cornstarch, Turmeric Extract Color, Soy Lecithin, Red 40, Yellow 6, Blue 1, Color Added.",
    nutrition: { caloriesKcal100g: 375, sugarsG100g: 31.3, saturatedFatG100g: 3.1, sodiumMg100g: 333, fiberG100g: 1.0, proteinG100g: 4.2, fruitsVegNutsPct: 2, nutriScoreGrade: "e", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.poptarts.com/en_US/products/all-flavors/pop-tarts-frosted-strawberry.html",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:frosted|bites?|cereal|protein|blueberry|brown\s+sugar|cinnamon)\b).*\bpop[- ]?tarts?\b.*\bunfrosted\b.*\bstrawberr(?:y|ies)\b/i,
    brand: "Pop-Tarts",
    title: "Pop-Tarts Unfrosted Strawberry Toaster Pastries",
    barcode: "0038000317101",
    keywords: ["kelloggs", "kellogg's", "pop tarts", "poptarts", "toaster", "pastries", "pastry", "unfrosted", "strawberry", "breakfast", "snack"],
    ingredients:
      "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1 [Thiamin Mononitrate], Vitamin B2 [Riboflavin], Folic Acid), Corn Syrup, High Fructose Corn Syrup, Soybean and Palm Oil (with TBHQ for Freshness), Dextrose, Bleached Wheat Flour, Sugar, Contains 2% or Less of Wheat Starch, Salt, Dried Strawberries, Dried Pears, Dried Apples, Leavening (Baking Soda, Sodium Acid Pyrophosphate, Monocalcium Phosphate), Citric Acid, Modified Wheat Starch, Yellow Corn Flour, Caramel Color, Xanthan Gum, Soy Lecithin, Red 40, Yellow 6, Blue 1.",
    nutrition: { caloriesKcal100g: 375, sugarsG100g: 25.0, saturatedFatG100g: 3.6, sodiumMg100g: 365, fiberG100g: 1.5, proteinG100g: 5.2, fruitsVegNutsPct: 2, nutriScoreGrade: "d", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.poptarts.com/en_US/products/all-flavors/pop-tarts-unfrosted-strawberry.html",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:unfrosted|bites?|cereal|protein|pretzel|roll|apple|strawberry|s'?mores|chocolate)\b).*\bpop[- ]?tarts?\b.*\bbrown\s+sugar\s+cinnamon\b/i,
    brand: "Pop-Tarts",
    title: "Pop-Tarts Frosted Brown Sugar Cinnamon Toaster Pastries",
    barcode: "0038000222535",
    keywords: ["kelloggs", "kellogg's", "pop tarts", "poptarts", "toaster", "pastries", "pastry", "frosted", "brown", "sugar", "cinnamon", "breakfast", "snack"],
    ingredients:
      "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1 [Thiamin Mononitrate], Vitamin B2 [Riboflavin], Folic Acid), Sugar, Soybean and Palm Oil (with TBHQ for Freshness), Brown Sugar (Sugar, Molasses), Dextrose, High Fructose Corn Syrup, Corn Syrup, Bleached Wheat Flour, Contains 2% or Less of Molasses, Salt, Cinnamon, Wheat Starch, Leavening (Baking Soda, Sodium Acid Pyrophosphate, Monocalcium Phosphate), Gelatin, Soy Lecithin.",
    nutrition: { caloriesKcal100g: 400, sugarsG100g: 31.0, saturatedFatG100g: 4.5, sodiumMg100g: 340, fiberG100g: 1.5, proteinG100g: 5.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.poptarts.com/en_US/products/all-flavors/pop-tarts-frosted-brown-sugar-cinnamon.html",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:bites?|cereal|protein)\b).*\bpop[- ]?tarts?\b.*\bs'?mores\b/i,
    brand: "Pop-Tarts",
    title: "Pop-Tarts Frosted S'mores Toaster Pastries",
    barcode: "0038000222634",
    keywords: ["kelloggs", "kellogg's", "pop tarts", "poptarts", "toaster", "pastries", "pastry", "frosted", "smores", "s'mores", "marshmallow", "chocolate", "graham", "breakfast", "snack"],
    ingredients:
      "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1 [Thiamin Mononitrate], Vitamin B2 [Riboflavin], Folic Acid), Sugar, High Fructose Corn Syrup, Dextrose, Soybean and Palm Oil (with TBHQ for Freshness), Corn Syrup, Whole Wheat Flour, Bleached Wheat Flour, Whey, Contains 2% or Less of Molasses, Cocoa Processed with Alkali, Cornstarch, Leavening (Baking Soda, Sodium Aluminum Phosphate), Milk Chocolate (Sugar, Milk, Chocolate, Cocoa Butter), Salt, Modified Corn Starch, Natural and Artificial Flavor, Soy Lecithin, Gelatin, Egg Whites, Color Added, Xanthan Gum.",
    nutrition: { caloriesKcal100g: 385, sugarsG100g: 35.4, saturatedFatG100g: 3.6, sodiumMg100g: 354, fiberG100g: 1.5, proteinG100g: 5.2, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.poptarts.com/en_US/products/all-flavors/pop-tarts-frosted-s-mores.html",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:unfrosted|bites?|cereal|protein)\b).*\bpop[- ]?tarts?\b.*\bfrosted\b.*\bcherr(?:y|ies)\b/i,
    brand: "Pop-Tarts",
    title: "Pop-Tarts Frosted Cherry Toaster Pastries",
    barcode: "0038000222573",
    keywords: ["kelloggs", "kellogg's", "pop tarts", "poptarts", "toaster", "pastries", "pastry", "frosted", "cherry", "breakfast", "snack"],
    ingredients:
      "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1 [Thiamin Mononitrate], Vitamin B2 [Riboflavin], Folic Acid), Corn Syrup, High Fructose Corn Syrup, Dextrose, Soybean and Palm Oil (with TBHQ for Freshness), Sugar, Bleached Wheat Flour, Contains 2% or Less of Wheat Starch, Salt, Dried Cherries, Dried Apples, Leavening (Baking Soda, Sodium Acid Pyrophosphate, Monocalcium Phosphate), Citric Acid, Modified Wheat Starch, Gelatin, Caramel Color, Yellow Corn Flour, Xanthan Gum, Red 40, Red 40 Lake, Soy Lecithin, Natural Flavor, Carnauba Wax, Confectioner's Glaze, Yellow 6.",
    nutrition: { caloriesKcal100g: 375, sugarsG100g: 31.3, saturatedFatG100g: 3.1, sodiumMg100g: 333, fiberG100g: 1.0, proteinG100g: 4.2, fruitsVegNutsPct: 2, nutriScoreGrade: "e", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.poptarts.com/en_US/products/all-flavors/pop-tarts-frosted-cherry.html",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:unfrosted|bites?|cereal|protein|lemon)\b).*\bpop[- ]?tarts?\b.*\bfrosted\b.*\bblueberr(?:y|ies)\b/i,
    brand: "Pop-Tarts",
    title: "Pop-Tarts Frosted Blueberry Toaster Pastries",
    barcode: "0038000222559",
    keywords: ["kelloggs", "kellogg's", "pop tarts", "poptarts", "toaster", "pastries", "pastry", "frosted", "blueberry", "breakfast", "snack"],
    ingredients:
      "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1 [Thiamin Mononitrate], Vitamin B2 [Riboflavin], Folic Acid), Corn Syrup, High Fructose Corn Syrup, Dextrose, Sugar, Soybean and Palm Oil (with TBHQ for Freshness), Bleached Wheat Flour, Contains 2% or Less of Wheat Starch, Salt, Dried Blueberries, Dried Grapes, Dried Apples, Leavening (Baking Soda, Sodium Acid Pyrophosphate, Monocalcium Phosphate), Citric Acid, Modified Wheat Starch, Gelatin, Yellow Corn Flour, Natural and Artificial Flavor, Xanthan Gum, Soy Lecithin, Caramel Color, Red 40, Blue 2, Blue 1, Color Added.",
    nutrition: { caloriesKcal100g: 375, sugarsG100g: 32.3, saturatedFatG100g: 3.1, sodiumMg100g: 344, fiberG100g: 1.5, proteinG100g: 4.2, fruitsVegNutsPct: 2, nutriScoreGrade: "e", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.poptarts.com/en_US/products/all-flavors/pop-tarts-frosted-blueberry.html",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:unfrosted|bites?|cereal|protein)\b).*\bpop[- ]?tarts?\b.*\bwild\s+berry\b/i,
    brand: "Pop-Tarts",
    title: "Pop-Tarts Frosted Wild Berry Toaster Pastries",
    barcode: "0038000222719",
    keywords: ["kelloggs", "kellogg's", "pop tarts", "poptarts", "toaster", "pastries", "pastry", "frosted", "wild", "berry", "breakfast", "snack"],
    ingredients:
      "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1 [Thiamin Mononitrate], Vitamin B2 [Riboflavin], Folic Acid), Corn Syrup, High Fructose Corn Syrup, Dextrose, Soybean and Palm Oil (with TBHQ for Freshness), Sugar, Bleached Wheat Flour, Contains 2% or Less of Wheat Starch, Salt, Dried Pears, Dried Apples, Dried Strawberries, Citric Acid, Leavening (Baking Soda, Sodium Acid Pyrophosphate, Monocalcium Phosphate), Gelatin, Modified Wheat Starch, Natural Mixed Berry Flavor, Xanthan Gum, Caramel Color, Soy Lecithin, Red 40 Lake, Blue 1 Lake, Red 40, Yellow 6, Blue 2 Lake, Carnauba Wax, Blue 1.",
    nutrition: { caloriesKcal100g: 385, sugarsG100g: 33.3, saturatedFatG100g: 3.1, sodiumMg100g: 333, fiberG100g: 1.0, proteinG100g: 4.2, fruitsVegNutsPct: 2, nutriScoreGrade: "e", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.poptarts.com/en_US/products/all-flavors/pop-tarts-frosted-wild-berry.html",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:bites?|cereal|protein)\b).*\bpop[- ]?tarts?\b.*\bcookies\s*(?:&|and|\x27n)?\s*cr[eè]me\b|\bpop[- ]?tarts?\b.*\bcookies\s*(?:&|and|\x27n)?\s*cream\b/i,
    brand: "Pop-Tarts",
    title: "Pop-Tarts Frosted Cookies & Crème Toaster Pastries",
    barcode: "0038000222672",
    keywords: ["kelloggs", "kellogg's", "pop tarts", "poptarts", "toaster", "pastries", "pastry", "frosted", "cookies", "creme", "cream", "chocolate", "breakfast", "snack"],
    ingredients:
      "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1 [Thiamin Mononitrate], Vitamin B2 [Riboflavin], Folic Acid), Sugar, Dextrose, High Fructose Corn Syrup, Soybean and Palm Oil (with TBHQ for Freshness), Corn Syrup, Whey, Bleached Wheat Flour, Cocoa Processed with Alkali, Contains 2% or Less of Cornstarch, Leavening (Baking Soda, Sodium Aluminum Phosphate), Salt, Modified Corn Starch, Natural and Artificial Flavor, Soy Lecithin, Gelatin, Egg Whites, Color Added, Xanthan Gum.",
    nutrition: { caloriesKcal100g: 385, sugarsG100g: 33.3, saturatedFatG100g: 3.6, sodiumMg100g: 396, fiberG100g: 1.5, proteinG100g: 5.2, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.poptarts.com/en_US/products/all-flavors/pop-tarts-frosted-cookies-and-creme.html",
    verifiedAt: "2026-11-18",
  },
  {
    match: /\blittle\s+debbie\b.*\bchocolate\b.*\bchristmas\s+tree\s+(?:snack\s+)?cakes?\b/i,
    brand: "Little Debbie",
    title: "Little Debbie Chocolate Christmas Tree Cakes",
    keywords: ["little", "debbie", "chocolate", "christmas", "tree", "cakes", "snack", "holiday"],
    ingredients:
      "Sugar, Corn Syrup, Water, Enriched Bleached Flour (Wheat Flour, Barley Malt, Niacin, Reduced Iron, Thiamin Mononitrate, Riboflavin, Folic Acid), Palm and Palm Kernel Oil, Palm and Soybean Oils with TBHQ and Citric Acid to Protect Flavor, Soybean Oil, Cocoa, Dextrose, Toppers (Sugar, Confectioner's Glaze, Yellow 5 Lake, Blue 1 Lake, Carnauba Wax), Contains 2% or Less of: Soy Flour, Cocoa Processed with Alkali, Egg Whites, Whey, Corn Starch, Baking Soda, Salt, Mono- and Diglycerides, Soy Lecithin, Sorbitan Monostearate, Sodium Aluminum Phosphate, Sorbic Acid, Red 40 Lake, Titanium Dioxide, Polysorbate 60, Natural and Artificial Flavors, Polysorbate 80, Propylene Glycol Monostearate, Sodium Stearoyl Lactylate, Citric Acid.",
    nutrition: { caloriesKcal100g: 435, sugarsG100g: 41.2, saturatedFatG100g: 11.8, sodiumMg100g: 212, fiberG100g: 1.2, proteinG100g: 2.4, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.littledebbie.com/chocolate-christmas-tree-cakes",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:ice\s+cream|creamer|cereal)\b).*\blittle\s+debbie\b.*\b(?:nutty\s+buddy|nutty\s+bars?)\b/i,
    brand: "Little Debbie",
    title: "Little Debbie Nutty Buddy Wafer Bars",
    keywords: ["little", "debbie", "nutty", "buddy", "bars", "wafer", "peanut", "butter", "chocolate", "fudge", "snack"],
    ingredients:
      "Dextrose, Peanut Butter, Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamin Mononitrate, Riboflavin, Folic Acid), Sugar, Palm and Soybean Oils with TBHQ and Citric Acid to Protect Flavor, Palm and Palm Kernel Oil, Cocoa, Contains 2% or Less of: Soy Flour, Soybean Oil, Salt, Soy Lecithin, Baking Soda, Natural and Artificial Flavors, Whey, Egg Whites.",
    nutrition: { caloriesKcal100g: 544, sugarsG100g: 36.8, saturatedFatG100g: 14.0, sodiumMg100g: 228, fiberG100g: 3.5, proteinG100g: 7.0, fruitsVegNutsPct: 18, nutriScoreGrade: "e", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.littledebbie.com/nutty-buddy",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:breast|shredded|pulled|salad|wings?|bites?|nuggets?|chunks?|soup|broth)\b).*\bkirkland(?:\s+signature)?\b.*\brotisserie\s+chicken\b/i,
    brand: "Kirkland Signature",
    title: "Kirkland Signature Seasoned Rotisserie Chicken",
    keywords: ["kirkland", "signature", "costco", "rotisserie", "chicken", "seasoned", "whole", "cooked"],
    ingredients:
      "Whole Chicken, Water, Salt, Sodium Phosphate, Hydrolyzed Casein, Modified Corn Starch, Sugar, Dextrose, Chicken Broth, Isolated Soy Protein Lecithin, Monoglycerides, Diglycerides.",
    nutrition: { caloriesKcal100g: 167, sugarsG100g: 0, saturatedFatG100g: 3.0, sodiumMg100g: 548, fiberG100g: 0, proteinG100g: 22.6, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://sameday.costco.com/store/costco/products/21128593-kirkland-signature-rotisserie-chicken-3-lb",
    verifiedAt: "2026-11-18",
  },
  {
    match: /\bkirkland(?:\s+signature)?\b.*\blightly\s+breaded\s+chicken\s+breast\s+(?:chunks?|bites?|fillets?)\b/i,
    brand: "Kirkland Signature",
    title: "Kirkland Signature Lightly Breaded Chicken Breast Chunks",
    keywords: ["kirkland", "signature", "costco", "lightly", "breaded", "chicken", "breast", "chunks", "bites", "boneless", "skinless", "frozen", "cooked"],
    ingredients:
      "Boneless Skinless Chicken Breast with Rib Meat, Water, Wheat Flour, Modified Corn Starch, Yellow Corn Flour, Contains 2% or Less of Salt, Sugar, Rice Starch, Spices, Dextrose, Garlic Powder, Onion Powder, Leavening (Cream of Tartar, Sodium Bicarbonate), Yeast Extract, Natural Flavor, Yeast, Paprika Extract. Breading Set in Vegetable Oil (Soybean and/or Canola Oil).",
    nutrition: { caloriesKcal100g: 179, sugarsG100g: 2.4, saturatedFatG100g: 1.2, sodiumMg100g: 643, fiberG100g: 0, proteinG100g: 19.0, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.costco.com/kirkland-signature-lightly-breaded-chicken-breast-chunks%2C-boneless-skinless%2C-4-lbs.product.4000181596.html",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:2%|1%|skim|fat[\s-]*free|reduced[\s-]*fat|low[\s-]*fat|chocolate|strawberry|vanilla|almond|oat|soy|coconut|lactose[\s-]*free)\b).*\bgood\s*(?:&|and)\s*gather\b.*\borganic\b.*\bwhole\s+milk\b/i,
    brand: "Good & Gather",
    title: "Good & Gather Organic Whole Milk",
    keywords: ["good", "gather", "target", "organic", "whole", "milk", "vitamin", "grade", "dairy", "gallon", "half"],
    ingredients: "Organic Grade A Milk, Vitamin D3.",
    nutrition: { caloriesKcal100g: 63, sugarsG100g: 5.0, saturatedFatG100g: 2.1, sodiumMg100g: 52, fiberG100g: 0, proteinG100g: 3.3, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isOrganic: true, isWholeFood: false },
    sourceUrl: "https://www.target.com/p/organic-whole-milk-0-5gal-good-38-gather-8482/-/A-54444621",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:wavy|rippled|kettle|bbq|barbecue|sour\s+cream|onion|cheddar|salt\s*(?:&|and)\s*vinegar|jalapeno|jalapeño|lightly\s+salted|no\s+salt|baked|tortilla|corn)\b).*\bgreat\s+value\b.*\bclassic\s+potato\s+chips\b/i,
    brand: "Great Value",
    title: "Great Value Classic Potato Chips",
    keywords: ["great", "value", "walmart", "classic", "regular", "potato", "chips", "salty", "snack"],
    ingredients: "Potatoes, Vegetable Oil (Canola, Corn, Soybean, and/or Sunflower Oil), Salt.",
    nutrition: { caloriesKcal100g: 571, sugarsG100g: 0, saturatedFatG100g: 5.4, sodiumMg100g: 607, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.walmart.com/ip/Great-Value-Classic-Potato-Chips-Party-Size-13-oz/197580949",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:wavy|rippled|kettle|bbq|barbecue|sour\s+cream|onion|cheddar|salt\s*(?:&|and)\s*vinegar|jalapeno|jalapeño|lightly\s+salted|no\s+salt|baked|tortilla|corn)\b).*\bclancy'?s\b.*\b(?:classic|original)\s+potato\s+chips\b/i,
    brand: "Clancy's",
    title: "Clancy's Classic Potato Chips",
    keywords: ["clancys", "clancy's", "aldi", "classic", "original", "potato", "chips", "snack"],
    ingredients: "Potatoes, Vegetable Oil (Corn, Cottonseed, Canola, and/or Sunflower Oil), Salt.",
    nutrition: { caloriesKcal100g: 571, sugarsG100g: 0, saturatedFatG100g: 5.4, sodiumMg100g: 607, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.aldi.us/products/snacks/chips-crackers-popcorn/detail/ps/p/clancys-original-potato-chips/",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:sour\s+cream|onion|cheddar|bbq|barbecue|pizza|ranch|salt\s*(?:&|and)\s*vinegar|jalapeno|jalapeño|scorchin|spicy|hot|lightly\s+salted|reduced\s+fat|wavy)\b).*\bpringles\b.*\boriginal\b.*\b(?:potato\s+)?(?:crisps?|chips?)\b/i,
    brand: "Pringles",
    title: "Pringles Original Potato Crisps",
    barcode: "0038000138416",
    keywords: ["pringles", "kelloggs", "kellanova", "original", "potato", "crisps", "chips", "stackable", "snack"],
    ingredients: "Dried Potatoes, Vegetable Oil (Corn, Cottonseed, High Oleic Soybean, and/or Sunflower Oil), Degerminated Yellow Corn Flour, Cornstarch, Rice Flour, Maltodextrin, Mono- and Diglycerides, Salt, Wheat Starch.",
    nutrition: { caloriesKcal100g: 536, sugarsG100g: 0, saturatedFatG100g: 8.9, sodiumMg100g: 536, fiberG100g: 3.6, proteinG100g: 3.6, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.pringles.com/us/en/products/favorites/pringles-original-product.html",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:gluten[\s-]*free|protein\+?|chickpea|red\s+lentil|whole\s+grain|ready\s+pasta|sauce|pesto|marinara)\b).*\bbarilla\b.*\bspaghetti\b/i,
    brand: "Barilla",
    title: "Barilla Spaghetti Pasta",
    barcode: "0076808280081",
    keywords: ["barilla", "classic", "blue", "box", "spaghetti", "pasta", "semolina", "noodles"],
    ingredients: "Semolina (Wheat), Durum Wheat Flour, Vitamin B3 (Niacin), Iron (Ferrous Sulfate), Vitamin B1 (Thiamine Mononitrate), Vitamin B2 (Riboflavin), Folic Acid.",
    nutrition: { caloriesKcal100g: 357, sugarsG100g: 3.6, saturatedFatG100g: 0, sodiumMg100g: 0, fiberG100g: 5.4, proteinG100g: 12.5, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.barilla.com/en-us/products/pasta/classic-blue-box/spaghetti",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:beef|cheese|cheddar|jalapeno|jalapeño|bacon|smokies|bologna|turkey\s+breast|deli\s+fresh|lunchables)\b).*\boscar\s+mayer\b.*\b(?:uncured\s+)?wieners?\b/i,
    brand: "Oscar Mayer",
    title: "Oscar Mayer Classic Uncured Wieners",
    barcode: "0044700000632",
    keywords: ["oscar", "mayer", "classic", "uncured", "wieners", "hot", "dogs", "hotdogs", "franks", "turkey", "chicken", "pork"],
    ingredients:
      "Mechanically Separated Turkey, Mechanically Separated Chicken, Pork, Water, Cultured Dextrose, Contains Less than 2% of Dextrose, Salt, Corn Syrup, Distilled White Vinegar, Cultured Celery Juice, Cherry Powder, Sodium Phosphate, Flavor.",
    nutrition: { caloriesKcal100g: 267, sugarsG100g: 2.2, saturatedFatG100g: 6.7, sodiumMg100g: 933, fiberG100g: 0, proteinG100g: 11.1, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.kraftheinz.com/oscar-mayer/products/00044700000632-classic-uncured-wieners-hot-dogs",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:shredded|diced|southern\s+style|o'brien|obrien|tater|crowns?|fries|french\s+fried|sweet\s+potato|cheddar|bacon|organic)\b).*\bgreat\s+value\b.*\bhash\s*brown\b.*\bpatt(?:y|ies)\b/i,
    brand: "Great Value",
    title: "Great Value Seasoned Potato Hash Brown Patties",
    barcode: "0078742226859",
    keywords: ["great", "value", "seasoned", "potato", "hash", "brown", "hashbrown", "patties", "frozen", "breakfast"],
    ingredients:
      "Potatoes, Vegetable Oil (Contains One or More of the Following Oils: Canola, Soybean, Cottonseed, Sunflower, Corn), Dehydrated Potato, Salt, Enriched Wheat Flour (Flour, Niacin, Iron, Thiamin Mononitrate, Riboflavin, Folic Acid), Potassium Chloride, Natural Flavoring, Dextrose, Disodium Dihydrogen Pyrophosphate (to Maintain Natural Color).",
    nutrition: { caloriesKcal100g: 219, sugarsG100g: 0, saturatedFatG100g: 2.3, sodiumMg100g: 484, fiberG100g: 3.1, proteinG100g: 3.1, fruitsVegNutsPct: 65, nutriScoreGrade: "c", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.walmart.com/ip/Great-Value-Seasoned-Potato-Hash-Brown-Patties-22-5-oz-10-Count-Frozen/10534292",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:beef|turkey|cheese|cheddar|jalapeno|jalapeño|bun\s+size|prime|patties|buns?)\b).*\bball\s+park\b.*\b(?:classic\s+)?(?:hot\s+dogs?|franks?)\b/i,
    brand: "Ball Park",
    title: "Ball Park Classic Hot Dogs",
    barcode: "0054500193528",
    keywords: ["ball", "park", "classic", "franks", "hot", "dogs", "hotdogs", "wieners", "turkey", "pork"],
    ingredients:
      "Mechanically Separated Turkey, Pork, Water, Corn Syrup, Contains 2% or Less of: Salt, Beef, Potassium Lactate, Natural Flavor, Sodium Phosphate, Sodium Diacetate, Ascorbic Acid (Vitamin C), Sodium Nitrite, Extractives of Paprika.",
    nutrition: { caloriesKcal100g: 283, sugarsG100g: 5.7, saturatedFatG100g: 8.5, sodiumMg100g: 906, fiberG100g: 0, proteinG100g: 11.3, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.ballparkbrand.com/hot-dogs/classic-franks",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:spicy|buffalo|honey|dino|fun|air\s+fried|gluten[\s-]*free|lightly\s+breaded|panko|unbreaded|grilled)\b).*\btyson\b.*\bchicken\s+nuggets\b/i,
    brand: "Tyson",
    title: "Tyson Fully Cooked Chicken Nuggets",
    barcode: "0023700014191",
    keywords: ["tyson", "chicken", "nuggets", "frozen", "breaded", "white", "meat", "natural", "ingredients"],
    ingredients:
      "Chicken Breast with Rib Meat, Wheat Flour, Water, Chicken Rib Meat, Contains 2% or Less of Salt, Corn Starch, Dextrose, Natural Flavors, Extractives of Paprika and Annatto, Spice, Yeast Extract, Torula Yeast, Leavening (Cream of Tartar, Sodium Bicarbonate). Breading Set in Vegetable Oil.",
    nutrition: { caloriesKcal100g: 289, sugarsG100g: 1.1, saturatedFatG100g: 4.4, sodiumMg100g: 522, fiberG100g: 1.1, proteinG100g: 14.4, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.tyson.com/products/breaded-chicken-nuggets/",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:hot|spicy|maple|sage|turkey|italian|links?|patties|biscuit|croissant|muffin|griddle|bowl)\b).*\bjimmy\s+dean\b.*\bpork\b.*\bsausage\s+roll\b/i,
    brand: "Jimmy Dean",
    title: "Jimmy Dean Premium Pork Regular Breakfast Sausage Roll",
    barcode: "0077900115739",
    keywords: ["jimmy", "dean", "premium", "pork", "regular", "breakfast", "sausage", "roll", "refrigerated", "fresh"],
    ingredients: "Pork, Water, Contains 2% or Less of: Salt, Spices, Sugar, Monosodium Glutamate.",
    nutrition: { caloriesKcal100g: 375, sugarsG100g: 1.8, saturatedFatG100g: 11.6, sodiumMg100g: 696, fiberG100g: 0, proteinG100g: 14.3, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.jimmydean.com/products/fresh-sausage/roll-sausage/premium-pork-regular-sausage/",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:turkey|bacon|croissant|muffin|griddle|delights)\b).*\bjimmy\s+dean\b.*\bsausage,?\s*egg\s*(?:&|and)\s*cheese\b.*\bbiscuit/i,
    brand: "Jimmy Dean",
    title: "Jimmy Dean Sausage, Egg & Cheese Biscuit Sandwiches",
    barcode: "0077900471224",
    keywords: ["jimmy", "dean", "sausage", "egg", "cheese", "biscuit", "sandwiches", "sandwich", "frozen", "breakfast"],
    ingredients:
      "Biscuit: Enriched Bleached Flour (Wheat Flour, Malted Barley Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Palm Oil, Cultured Buttermilk, Sugar, Contains 2% or Less of: Leavening (Sodium Acid Pyrophosphate, Baking Soda, Aluminum Sulfate, Monocalcium Phosphate), Salt, Modified Wheat Starch, Soy Lecithin. Cooked Pork Sausage Patty: Pork, Water, Contains 2% or Less of: Salt, Spices, Sugar, Caramel Color, Natural Flavor, BHA, BHT, Citric Acid. Egg Patty: Whole Eggs, Water, Soybean Oil, Modified Corn Starch, Whey Solids, Nonfat Dry Milk, Salt, Xanthan Gum, Citric Acid. Pasteurized Process American Cheese: Milk, Water, Cream, Sodium Citrate, Salt, Cheese Culture, Tetrasodium Pyrophosphate, Sorbic Acid, Enzymes, Soy Lecithin, Apo-Carotenal and Beta Carotene (Color).",
    nutrition: { caloriesKcal100g: 308, sugarsG100g: 3.0, saturatedFatG100g: 8.3, sodiumMg100g: 624, fiberG100g: 1.5, proteinG100g: 9.8, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.jimmydean.com/products/sandwiches/biscuits/sausage-egg-and-cheese-biscuit/",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:thick\s*(?:&|and)\s*fluffy|blueberry|strawberry|chocolate|protein|gluten[\s-]*free|pancakes?)\b).*\b(?:eggo|kellogg'?s\s+eggo)\b.*\bbuttermilk\b.*\bwaffles?\b/i,
    brand: "Kellogg's Eggo",
    title: "Eggo Buttermilk Waffles",
    barcode: "0038000401206",
    keywords: ["kelloggs", "kellogg's", "eggo", "buttermilk", "frozen", "waffles", "breakfast"],
    ingredients:
      "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1 [Thiamin Mononitrate], Vitamin B2 [Riboflavin], Folic Acid), Water, Vegetable Oil (Soybean, Palm, Canola, and/or Cottonseed), Sugar, Leavening (Baking Soda, Sodium Aluminum Phosphate, Monocalcium Phosphate), Contains 2% or Less of Salt, Dextrose, Buttermilk, Whey, Eggs, Soy Lecithin, Beta-Carotene for Color, Calcium Carbonate, Iron, Vitamin A Palmitate, Vitamin B6, Vitamin B12.",
    nutrition: { caloriesKcal100g: 271, sugarsG100g: 5.7, saturatedFatG100g: 2.1, sodiumMg100g: 529, fiberG100g: 1.4, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.eggo.com/en_US/products/waffles/kellogg-s-eggo-buttermilk-waffles-product.html",
    verifiedAt: "2026-11-18",
  },
  {
    match: /\bchobani\b.*\bflip\b.*\balmond\s+coco\s+loco\b/i,
    brand: "Chobani",
    title: "Chobani Flip Almond Coco Loco Low-Fat Greek Yogurt",
    barcode: "0818290012999",
    keywords: ["chobani", "flip", "almond", "coco", "loco", "coconut", "dark", "chocolate", "low", "fat", "low-fat", "greek", "yogurt"],
    ingredients:
      "Lowfat Yogurt (Cultured Pasteurized Nonfat Milk, Cream), Evaporated Cane Sugar, Honey Roasted Salted Almonds (Almonds, Sugar, Honey, Sea Salt), Dark Chocolate (Sugar, Unsweetened Chocolate, Cocoa Butter, Soy Lecithin, Natural Vanilla Extract), Water, Natural Flavors, Fruit Pectin, Guar Gum, Locust Bean Gum, Lemon Juice Concentrate.",
    nutrition: { caloriesKcal100g: 148, sugarsG100g: 14.1, saturatedFatG100g: 2.3, sodiumMg100g: 63, fiberG100g: 1.6, proteinG100g: 7.0, fruitsVegNutsPct: 12, nutriScoreGrade: "c", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.chobani.com/products/yogurt/flip/almond-coco-loco",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:breast|shredded|pulled|salad|wings?|bites?|nuggets?|soup|broth)\b).*\bmember'?s\s+mark\b.*\brotisserie\s+chicken\b/i,
    brand: "Member's Mark",
    title: "Member's Mark Seasoned Rotisserie Chicken",
    keywords: ["members mark", "rotisserie chicken", "seasoned", "whole", "cooked"],
    ingredients: "Whole Chicken, Water, Salt, Sodium Phosphate, Sugar, Hydrolyzed Corn Protein, Maltodextrin, Yeast Extract, Chicken Broth, Spices, Onion Powder, Garlic Powder, Natural Flavors.",
    imageUrl: "https://images.openfoodfacts.org/images/products/071/928/314/5598/front_en.10.400.jpg",
    nutrition: { caloriesKcal100g: 167, sugarsG100g: 0.6, saturatedFatG100g: 2.8, sodiumMg100g: 524, fiberG100g: 0, proteinG100g: 22.6, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.samsclub.com/ip/members-mark-seasoned-rotisserie-chicken/13820153808",
    verifiedAt: "2026-11-15",
  },
  {
    match: /\bmember'?s\s+mark\b.*\b(?:lightly\s+breaded|breaded)\s+chicken\s+breast\s+bites\b/i,
    brand: "Member's Mark",
    title: "Member's Mark Fully Cooked Lightly Breaded Chicken Breast Bites",
    keywords: ["members mark", "fully cooked", "lightly breaded", "chicken breast bites", "frozen", "boneless"],
    ingredients: "White Meat Chicken, Water, Wheat Flour, Contains 2% or Less of: Modified Food Starch, Salt, Sugar, Spices, Garlic Powder, Onion Powder, Yeast Extract, Leavening (Cream of Tartar, Sodium Bicarbonate), Yeast, Natural Flavor. Breading Set in Vegetable Oil.",
    nutrition: { caloriesKcal100g: 226, sugarsG100g: 1.2, saturatedFatG100g: 1.8, sodiumMg100g: 571, fiberG100g: 0, proteinG100g: 20.2, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.samsclub.com/ip/members-mark-lightly-breaded-chicken-breast-bites-frozen-3-lbs/13626401534",
    verifiedAt: "2026-11-15",
  },
  {
    match: /^(?!.*\b(?:organic|buffalo|barbecue|bbq|teriyaki|memphis|rotisserie|oven[- ]?roasted|breaded|crispy|lemon\s+pepper|garlic\s+parmesan|priced\s+per\s+pound)\b).*\bmember'?s\s+mark\b(?=.*\b(?:frozen|10\s*lbs?|bone[- ]?in)\b).*\bchicken\s+wings?\b/i,
    brand: "Member's Mark",
    title: "Member's Mark Bone-In Chicken Wings, Frozen",
    keywords: ["members mark", "bone-in", "chicken wings", "frozen", "drumettes", "flats"],
    ingredients: "Chicken Wings Drumettes and Flats, Contains Up to 10% of Chicken Broth, Salt, Natural Flavors.",
    nutrition: { caloriesKcal100g: 161, sugarsG100g: 0, saturatedFatG100g: 3.57, sodiumMg100g: 152, fiberG100g: 0, proteinG100g: 14.3, fruitsVegNutsPct: 0, isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.samsclub.com/ip/members-mark-bone-in-chicken-wings-frozen-10-lbs/13581923232",
    verifiedAt: "2026-11-19",
  },
  {
    match: /^(?!.*\b(?:lightly\s+breaded|honey|bbq|barbecue|buffalo|southern|spicy|grilled|rotisserie)\b).*\bmember'?s\s+mark\b.*\bhomestyle\s+chicken\s+bites?\b/i,
    brand: "Member's Mark",
    title: "Member's Mark Breaded and Boneless Homestyle Chicken Bites",
    keywords: ["members mark", "breaded", "boneless", "homestyle", "chicken bites", "frozen"],
    ingredients: "Chicken Breast Meat with Rib Meat, Water, Modified Corn Starch, Salt, Sodium Phosphate, Garlic Powder, Onion Powder. Breaded with: Bleached Wheat Flour, Wheat Flour, Modified Food Starch, Spices, Dextrose, Leavening (Sodium Acid Pyrophosphate, Sodium Bicarbonate), Garlic Powder, Onion Powder, Yeast, Extractives of Paprika. Battered with: Water, Bleached Wheat Flour, Dextrose, Yellow Corn Flour, Wheat Flour, Salt, Spices, Leavening (Sodium Acid Pyrophosphate, Sodium Bicarbonate), Extractives of Paprika. Predusted with: Wheat Flour, Salt, Bleached Wheat Flour. Breading Is Set in Soybean Oil.",
    nutrition: { caloriesKcal100g: 190, sugarsG100g: 1.19, saturatedFatG100g: 0.6, sodiumMg100g: 488, fiberG100g: 1.2, proteinG100g: 15.5, fruitsVegNutsPct: 0, isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.samsclub.com/ip/members-mark-homestyle-boneless-chicken-bites/13581823960",
    verifiedAt: "2026-11-19",
  },
  {
    match: /^(?!.*\b(?:breaded|homestyle|honey|bbq|barbecue|buffalo|lemon|herb|kinder|rotisserie|spicy|teriyaki)\b).*\bmember'?s\s+mark\b.*\bgrilled\s+chicken\s+(?:breast\s+)?bites?\b/i,
    brand: "Member's Mark",
    title: "Member's Mark Grilled Chicken Bites",
    keywords: ["members mark", "grilled", "chicken bites", "frozen", "boneless"],
    ingredients: "Chicken Breast Meat with Rib Meat, Water, Seasoning (Flavor [Salt, Autolyzed Yeast, Yeast, Chicken Fat, Chicken Broth, Natural Flavor], Brown Sugar, Flavoring, Spices, Smoked Paprika, Citric Acid, Mushroom Powder, Dried Lemon Peel Powder, Dehydrated Red Bell Pepper, Natural Flavor), Contains 2% or Less of Modified Food Starch, Sodium Bicarbonate and/or Potassium Bicarbonate, Natural Flavor, Sodium Phosphates, Soybean Oil.",
    nutrition: { sugarsG100g: 1.2, fiberG100g: 0, proteinG100g: 18.8, sodiumMg100g: 741, fruitsVegNutsPct: 0, isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.samsclub.com/ip/members-mark-grilled-chicken-bites-frozen-3-lbs/13885002883",
    verifiedAt: "2026-11-19",
  },
  {
    match: /^(?!.*\b(?:turkey|canadian|uncured|bits|crumbled|wrapped|dip|macaroni|thick)\b).*\bmember'?s\s+mark\b.*\bhickory\s+smoked\b.*\bbacon\b/i,
    brand: "Member's Mark",
    title: "Member's Mark Naturally Hickory Smoked Bacon",
    keywords: ["members mark", "naturally", "hickory smoked", "classic cut", "bacon", "pork"],
    ingredients: "Pork Cured With: Water, Salt, Sugar, Sodium Phosphates, Sodium Erythorbate, Sodium Nitrite.",
    nutrition: { caloriesKcal100g: 500, sugarsG100g: 0, saturatedFatG100g: 13.9, sodiumMg100g: 1722, fiberG100g: 0, proteinG100g: 33.3, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/2592451/nutrients",
    verifiedAt: "2026-11-15",
  },
  {
    match: /\b(simple\s+truth\s+organic.*(?:greek\s+yogurt|plain\s+greek\s+yogurt)|(?:greek\s+yogurt|plain\s+greek\s+yogurt).*simple\s+truth\s+organic)\b/i,
    brand: "Simple Truth Organic",
    title: "Simple Truth Organic Whole Milk Plain Greek Yogurt",
    ingredients: "Cultured Pasteurized Organic Whole Milk. Live and Active Cultures: S. Thermophilus, L. Bulgaricus, L. Acidophilus, Bifidus, L. Casei.",
    nutrition: { caloriesKcal100g: 94, sugarsG100g: 3.5, saturatedFatG100g: 3.0, sodiumMg100g: 35, fiberG100g: 0, proteinG100g: 8.8, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isOrganic: true, isWholeFood: true },
    sourceUrl: "https://www.kroger.com/p/simple-truth-organic-plain-whole-milk-greek-yogurt/0001111089910",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(simple\s+truth\s+organic.*applesauce|applesauce.*simple\s+truth\s+organic)\b/i,
    brand: "Simple Truth Organic",
    title: "Simple Truth Organic Unsweetened Applesauce",
    ingredients: "Organic Apples, Water, Ascorbic Acid (Vitamin C) to Maintain Color.",
    nutrition: { caloriesKcal100g: 44, sugarsG100g: 9.7, saturatedFatG100g: 0, sodiumMg100g: 0, fiberG100g: 1.8, proteinG100g: 0, fruitsVegNutsPct: 100, nutriScoreGrade: "a", isOrganic: true, isWholeFood: false },
    sourceUrl: "https://www.kroger.com/p/simple-truth-organic-unsweetened-applesauce-cups/0001111085432",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(private\s+selection.*(?:angus\s+beef|beef\s+patties|burger\s+patties)|(?:angus\s+beef\s+patties).*private\s+selection)\b/i,
    brand: "Private Selection",
    title: "Private Selection Angus Beef Patties",
    ingredients: "100% USDA Choice Angus Beef.",
    nutrition: { caloriesKcal100g: 254, sugarsG100g: 0, saturatedFatG100g: 7.7, sodiumMg100g: 66, fiberG100g: 0, proteinG100g: 17.2, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isOrganic: false, isWholeFood: true },
    sourceUrl: "https://www.kroger.com/p/private-selection-80-lean-20-fat-angus-beef-chuck-patties/0001111097111",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(good\s*(?:&|and)\s*gather.*organic.*peanut\s+butter|organic.*peanut\s+butter.*good\s*(?:&|and)\s*gather)\b/i,
    brand: "Good & Gather",
    title: "Good & Gather Organic Creamy Peanut Butter",
    ingredients: "Organic Dry Roasted Peanuts, Sea Salt.",
    nutrition: { caloriesKcal100g: 593, sugarsG100g: 6.2, saturatedFatG100g: 7.8, sodiumMg100g: 250, fiberG100g: 6.2, proteinG100g: 25.0, fruitsVegNutsPct: 99, nutriScoreGrade: "a", isOrganic: true, isWholeFood: false },
    sourceUrl: "https://www.target.com/p/organic-unsweetened-creamy-peanut-butter-16oz-good-38-gather-8482/-/A-54516890",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(favorite\s+day.*cookies\s*(?:&|and|\x27n)?\s*cr[eè]me\s+ice\s+cream|favorite\s+day.*cookies\s*(?:&|and|\x27n)?\s*cream\s+ice\s+cream|cookies\s*(?:&|and|\x27n)?\s*cream\s+ice\s+cream.*favorite\s+day)\b/i,
    brand: "Favorite Day",
    title: "Favorite Day Cookies & Cream Ice Cream",
    ingredients: "Milk, Cream, Skim Milk, Sugar, Corn Syrup, Chocolate Sandwich Cookie Pieces (Unbleached Enriched Flour [Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid], Sugar, Palm and/or Canola Oil, Cocoa Processed with Alkali, Invert Sugar, Leavening [Baking Soda, Calcium Phosphate], Soy Lecithin, Salt, Chocolate, Natural Flavor), Whey, Contains 1% or Less of Vanilla Extract, Mono and Diglycerides, Guar Gum, Calcium Sulfate, Carob Bean Gum, Carrageenan.",
    nutrition: { caloriesKcal100g: 224, sugarsG100g: 21.3, saturatedFatG100g: 7.3, sodiumMg100g: 95, fiberG100g: 0.5, proteinG100g: 3.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.target.com/p/cookies-38-cream-ice-cream-48oz-favorite-day-8482/-/A-81502226",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?=.*\bfavorite\s+day\b)(?=.*\bvanilla\b)(?=.*\bice\s+cream\b)(?!.*\b(cookies|chocolate|strawberry|mint|pecan|caramel)\b).*$/i,
    brand: "Favorite Day",
    title: "Favorite Day Classic Vanilla Ice Cream",
    ingredients: "Milk, Cream, Skim Milk, Sugar, Corn Syrup, Egg Yolks, Natural Flavor, Mono and Diglycerides, Guar Gum, Locust Bean Gum, Carrageenan, Annatto Extract (Color).",
    nutrition: { caloriesKcal100g: 207, sugarsG100g: 20.7, saturatedFatG100g: 7.0, sodiumMg100g: 65, fiberG100g: 0, proteinG100g: 3.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.target.com/p/vanilla-bean-ice-cream-48oz-favorite-day-8482/-/A-81502235",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\bfreshness\s+guaranteed\b).*\b(bismark|bismarks|donut|donuts|doughnut|doughnuts|fritter|danish|cinnamon roll|honey bun|eclair|strudel|turnover|glazed donut|jelly donut|raspberry filled)\b/i,
    brand: "Representative Bakery Formulation",
    title: "Bakery Donuts and Filled Pastries (Representative Formulation)",
    ingredients: "Enriched Wheat Flour Bleached (Flour, Malted Barley Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Fruit Filling (High Fructose Corn Syrup, Water, Raspberries, Modified Food Starch, Sugar, Citric Acid, Salt, Potassium Sorbate, Sodium Benzoate, Red 40, Blue 1, Artificial Flavor), Palm and/or Soybean Oil, Sugar, Dextrose, Contains 2% or Less of: Yeast, Soy Flour, Whey, Salt, Mono- and Diglycerides, Sodium Acid Pyrophosphate, Baking Soda, Sodium Stearoyl Lactylate, Soy Lecithin, Calcium Propionate, DATEM, Artificial Flavor, Yellow 5, Yellow 6, Titanium Dioxide (Color).",
    nutrition: { caloriesKcal100g: 405, sugarsG100g: 25, saturatedFatG100g: 9.0, sodiumMg100g: 340, fiberG100g: 1.2, proteinG100g: 4.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e" },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/1750340/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?=.*\bdoritos\b)(?=.*\b(?:simply\s+nkd|nkd)\b)(?=.*\bcool\s+ranch\b).*$/i,
    brand: "Doritos",
    title: "Doritos Simply NKD Cool Ranch Tortilla Chips",
    barcode: "028400794732",
    ingredients: "Corn, Vegetable Oil (Corn, Canola, Soybean, and/or Sunflower Oil), and Less than 2% of Corn Maltodextrin, Buttermilk, Salt, Tomato Powder, Potassium Salt, Cheddar Cheese (Milk, Cheese Cultures, Salt, Enzymes), Onion Powder, Whey, Garlic Powder, Sugar, Skim Milk, Natural Flavors, Citric Acid, Lactic Acid, and Spices.",
    nutrition: { caloriesKcal100g: 536, sugarsG100g: 1.8, saturatedFatG100g: 3.6, sodiumMg100g: 500, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://smartlabel.pepsico.info/028400794732-0001-en-US/index.html",
    verifiedAt: "2026-11-17",
  },
  {
    match: /^(?=.*\bdoritos\b)(?=.*\b(?:simply\s+nkd|nkd)\b)(?!.*\bcool\s+ranch\b).*$/i,
    brand: "Doritos",
    title: "Doritos Simply NKD Nacho Cheese Tortilla Chips",
    barcode: "028400794756",
    ingredients: "Corn, Vegetable Oil (Corn, Canola, Soybean, and/or Sunflower Oil), Corn Maltodextrin, and Less than 2% of Salt, Cheddar Cheese (Milk, Cheese Cultures, Salt, Enzymes), Whey, Tomato Powder, Potassium Salt, Onion Powder, Buttermilk, Romano Cheese (Milk, Cheese Cultures, Salt, Enzymes), Whey Protein Concentrate, Natural Flavors, Spices, Citric Acid, Lactic Acid, Garlic Powder, Sugar, Red and Green Bell Peppers, and Yeast Extract.",
    nutrition: { caloriesKcal100g: 536, sugarsG100g: 1.8, saturatedFatG100g: 3.6, sodiumMg100g: 536, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://smartlabel.pepsico.info/028400794756-0001-en-US/index.html",
    verifiedAt: "2026-11-17",
  },
  {
    match: /\b(simply\s+doritos\s+organic|doritos\s+simply\s+organic|doritos.*organic\s+white\s+cheddar)\b/i,
    brand: "Simply",
    title: "Simply Doritos Organic White Cheddar Tortilla Chips",
    barcode: "028400509503",
    ingredients: "Organic White Corn, Expeller-Pressed Sunflower Oil, Organic Whey, Organic Cheddar Cheese (Organic Milk, Cheese Cultures, Salt, Enzymes), Organic Maltodextrin (Made from Corn), Sea Salt, Organic Butter (Organic Cream, Salt), Organic Nonfat Milk, Natural Flavors, Organic Sour Cream (Organic Cultured Cream, Organic Nonfat Milk), Lactic Acid, Citric Acid.",
    nutrition: { caloriesKcal100g: 500, sugarsG100g: 3.6, saturatedFatG100g: 3.6, sodiumMg100g: 640, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isOrganic: true, isWholeFood: false },
    sourceUrl: "https://smartlabel.pepsico.info/028400509503-0001-en-US/index.html",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(?:simply\s+nkd|nkd)\b).*(?:\b(cool ranch)\b.*\b(doritos)\b|\b(doritos)\b.*\b(cool ranch)\b).*$/i,
    brand: "Doritos",
    title: "Cool Ranch Flavored Tortilla Chips",
    ingredients: "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin (Made from Corn), Salt, Tomato Powder, Corn Starch, Lactose, Whey, Skim Milk, Corn Syrup Solids, Onion Powder, Sugar, Garlic Powder, Monosodium Glutamate, Cheddar Cheese (Milk, Cheese Cultures, Salt, Enzymes), Dextrose, Malic Acid, Buttermilk, Natural and Artificial Flavors, Sodium Acetate, Artificial Color (Red 40, Blue 1, Yellow 5), Spice, Citric Acid, Disodium Inosinate, and Disodium Guanylate.",
    nutrition: { caloriesKcal100g: 536, sugarsG100g: 1.8, saturatedFatG100g: 3.6, sodiumMg100g: 679, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.doritos.com/products/doritos-cool-ranch-flavored-tortilla-chips",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?=.*\bdoritos\b)(?!.*\b(simply\s+nkd|nkd|cool\s+ranch|flamin|blaze|tapatio|salsa\s+verde|dinamita|organic|spicy\s+sweet\s+chili)\b).*$/i,
    brand: "Doritos",
    title: "Nacho Cheese Flavored Tortilla Chips",
    ingredients: "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin (Made from Corn), Salt, Cheddar Cheese, Whey, Monosodium Glutamate, Buttermilk, Romano Cheese, Onion Powder, Corn Flour, Natural and Artificial Flavor, Dextrose, Tomato Powder, Lactose, Spices, Artificial Color (Yellow 6, Yellow 5, Red 40), Lactic Acid, Citric Acid, Sugar, Garlic Powder, Skim Milk, Red and Green Bell Pepper Powder, Disodium Inosinate, and Disodium Guanylate.",
    nutrition: { caloriesKcal100g: 536, sugarsG100g: 1.8, saturatedFatG100g: 3.6, sodiumMg100g: 750, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.doritos.com/products/doritos-nacho-cheese-flavored-tortilla-chips",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(cheez[- ]?it)\b/i,
    brand: "Cheez-It",
    title: "Original Baked Snack Crackers",
    ingredients: "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1, Vitamin B2, Folic Acid), Vegetable Oil (High Oleic Soybean, Soybean, Palm, and/or Canola Oil with TBHQ for Freshness), Cheese Made with Skim Milk (Skim Milk, Whey Protein, Salt, Cheese Cultures, Enzymes, Annatto Extract Color), Contains 2% or Less of Salt, Paprika, Yeast, Paprika Extract Color, Soy Lecithin.",
    nutrition: { caloriesKcal100g: 500, sugarsG100g: 0, saturatedFatG100g: 5.0, sodiumMg100g: 767, fiberG100g: 1.7, proteinG100g: 10.0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.cheezit.com/en_US/products/crackers/cheez-it-original-product.html",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bmartin'?s\b.*\b(potato|rolls?|buns?|bread)\b/i,
    brand: "Martin's",
    title: "Martin's Famous Pastry Shoppe Potato Sandwich Rolls",
    ingredients: "Unbleached Enriched Wheat Flour (Flour, Ferrous Sulfate, Niacin, Thiamin, Riboflavin, Folic Acid), Nonfat Milk, Reconstituted Potatoes (from Potato Flour), Yeast, Sugar, Wheat Gluten, Sunflower Oil, Contains 2 Percent or Less of Each of the Following: Salt, Butter, Dough Conditioners (Sodium Stearoyl Lactylate, Monoglycerides and Diglycerides, Ascorbic Acid), Monocalcium Phosphate, Cultured Wheat Flour, Calcium Propionate (a Preservative), Guar Gum, Datem, Enzymes, Sesame Seeds, Turmeric Color, Annatto Color.",
    nutrition: { caloriesKcal100g: 281, sugarsG100g: 6.2, saturatedFatG100g: 0.8, sodiumMg100g: 390, fiberG100g: 3.1, proteinG100g: 10.9, fruitsVegNutsPct: 12, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://potatorolls.com/products/sandwich-potato-rolls/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(great\s+value|wonder|sara\s+lee|nature'?s\s+own|l'?oven\s+fresh)\b.*\b(white\s+sandwich\s+bread|white\s+bread|enriched\s+bread|sandwich\s+bread)\b/i,
    brand: "Representative Category Formulation",
    title: "White Enriched Sandwich Bread (Representative Formulation)",
    ingredients: "Unbleached Enriched Wheat Flour (Wheat Flour, Malted Barley Flour, Niacin, Reduced Iron, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, High Fructose Corn Syrup, Yeast, Contains 2% or Less of: Soybean Oil, Salt, Wheat Gluten, Calcium Sulfate, Sodium Stearoyl Lactylate, Monoglycerides, Calcium Propionate (to Preserve Freshness), DATEM, Ascorbic Acid, Enzymes.",
    nutrition: { caloriesKcal100g: 259, sugarsG100g: 5.8, saturatedFatG100g: 0.7, sodiumMg100g: 480, fiberG100g: 1.9, proteinG100g: 7.8, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/174924/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(oreo\s+puffs?|oreo\s+o'?s)\b/i,
    brand: "Post",
    title: "Oreo O's Cereal",
    ingredients: "Corn Flour, Sugar, Whole Grain Oat Flour, Cocoa (Processed with Alkali), Canola and/or Soybean Oil, Corn Syrup, Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Salt, Degerminated Corn Meal, Natural and Artificial Flavor, Cornstarch, Palm Oil, Soy Lecithin, Chocolate, BHT Added to Preserve Freshness.",
    nutrition: { caloriesKcal100g: 395, sugarsG100g: 36, saturatedFatG100g: 1.5, sodiumMg100g: 420, fiberG100g: 2.5, proteinG100g: 4.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.postconsumerbrands.com/brands/oreo-os/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(cocoa\s+puffs?|reese'?s\s+puffs?|cookie\s+crisp|cocoa\s+pebbles|fruity\s+pebbles|cap'?n\s+crunch|apple\s+jacks|frosted\s+flakes|krave|pops\s+cereal|honey\s+smacks|golden\s+grahams|trix)\b/i,
    brand: "Representative Category Formulation",
    title: "Sweetened Breakfast Cereal (Representative Formulation)",
    ingredients: "Whole Grain Corn or Corn Flour, Sugar, Corn Syrup, Canola and/or Soybean Oil, Salt, Trisodium Phosphate, Natural and Artificial Flavor, Vitamin E (Mixed Tocopherols) Added to Preserve Freshness.",
    nutrition: { caloriesKcal100g: 395, sugarsG100g: 36, saturatedFatG100g: 1.5, sodiumMg100g: 420, fiberG100g: 2.5, proteinG100g: 4.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/173884/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(oreo|oreos)\b(?!\s+(puffs?|o'?s|cereal))/i,
    brand: "OREO",
    title: "Chocolate Sandwich Cookies",
    keywords: ["nabisco"],
    ingredients: "Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Sugar, Palm and/or Canola Oil, Cocoa (Processed with Alkali), High Fructose Corn Syrup, Leavening (Baking Soda and/or Calcium Phosphate), Salt, Soy Lecithin, Chocolate, Artificial Flavor.",
    nutrition: { caloriesKcal100g: 471, sugarsG100g: 41.2, saturatedFatG100g: 5.9, sodiumMg100g: 397, fiberG100g: 1.8, proteinG100g: 2.9, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.oreo.com/products/oreo-cookies",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(cheetos)\b/i,
    brand: "Cheetos",
    title: "Crunchy Cheese Flavored Snacks",
    ingredients: "Enriched Corn Meal (Corn Meal, Ferrous Sulfate, Niacin, Thiamin Mononitrate, Riboflavin, Folic Acid), Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Cheese Seasoning (Whey, Cheddar Cheese, Canola Oil, Maltodextrin, Natural and Artificial Flavors, Salt, Whey Protein Concentrate, Monosodium Glutamate, Lactic Acid, Citric Acid, Artificial Color [Yellow 6]), and Salt.",
    nutrition: { caloriesKcal100g: 571, sugarsG100g: 3.6, saturatedFatG100g: 5.4, sodiumMg100g: 893, fiberG100g: 1.8, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.cheetos.com/products/cheetos-crunchy-cheese-flavored-snacks",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(takis)\b/i,
    brand: "Takis",
    title: "Fuego Hot Chili Pepper & Lime Tortilla Chips",
    ingredients: "Corn Masa Flour, Vegetable Oil (Palm and/or Soybean and/or Canola Oil), Seasoning (Maltodextrin, Citric Acid, Sugar, Potassium Chloride, Salt, Monosodium Glutamate, Hydrolyzed Soy Protein, Natural and Artificial Flavors, Hydrolyzed Yeast, Soybean Oil, Onion Powder, Red 40 Lake, Yellow 6 Lake, Sodium Bicarbonate, Chili Pepper, Disodium Inosinate, Disodium Guanylate, TBHQ).",
    nutrition: { caloriesKcal100g: 536, sugarsG100g: 3.6, saturatedFatG100g: 8.9, sodiumMg100g: 1393, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.barcel-usa.com/takis-fuego",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(froot loops|fruit loops)\b/i,
    brand: "Kellogg's",
    title: "Froot Loops Sweetened Multigrain Cereal",
    ingredients: "Corn Flour Blend (Whole Grain Yellow Corn Flour, Degerminated Yellow Corn Flour), Sugar, Wheat Flour, Whole Grain Oat Flour, Modified Food Starch, Contains 2% or Less of Vegetable Oil (Hydrogenated Coconut, Soybean and/or Cottonseed), Oat Fiber, Maltodextrin, Salt, Soluble Corn Fiber, Natural Flavor, Red 40, Yellow 5, Blue 1, Yellow 6. Vitamins and Minerals: Vitamin C (Ascorbic Acid), Reduced Iron, Niacinamide, Vitamin B6 (Pyridoxine Hydrochloride), Vitamin B2 (Riboflavin), Vitamin B1 (Thiamin Hydrochloride), Folic Acid, Vitamin D3, Vitamin B12. BHT Added to Packaging for Freshness.",
    nutrition: { caloriesKcal100g: 385, sugarsG100g: 30.8, saturatedFatG100g: 1.3, sodiumMg100g: 538, fiberG100g: 5.1, proteinG100g: 5.1, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.wkkellogg.com/products/froot-loops-cereal",
    verifiedAt: "2026-11-18",
  },
  {
    match: /\b(lucky charms)\b/i,
    brand: "General Mills",
    title: "Lucky Charms Cereal with Marshmallows",
    ingredients: "Whole Grain Oats, Sugar, Whole Grain Corn, Corn Starch, Corn Syrup, Dextrose, Contains 2% or Less of: Salt, Modified Corn Starch, Gelatin, Trisodium Phosphate, Fruit and Vegetable Juice for Color, Spirulina Extract for Color, Turmeric Extract for Color, Annatto Extract for Color, Natural Flavor, Vitamin E (mixed tocopherols) Added to Preserve Freshness.",
    nutrition: { caloriesKcal100g: 389, sugarsG100g: 33.3, saturatedFatG100g: 0, sodiumMg100g: 639, fiberG100g: 5.6, proteinG100g: 8.3, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.luckycharms.com/products/original-lucky-charms",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(cinnamon toast crunch)\b/i,
    brand: "General Mills",
    title: "Cinnamon Toast Crunch Cereal",
    ingredients: "Whole Grain Wheat, Sugar, Rice Flour, Canola and/or Sunflower Oil, Fructose, Maltodextrin, Dextrose, Salt, Cinnamon, Trisodium Phosphate, Soy Lecithin, Caramel Color. BHT Added to Preserve Freshness.",
    nutrition: { caloriesKcal100g: 415, sugarsG100g: 29.3, saturatedFatG100g: 1.2, sodiumMg100g: 561, fiberG100g: 4.9, proteinG100g: 4.9, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.cinnamontoastcrunch.com/products/cinnamon-toast-crunch",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(cinnamon\s+chex)\b/i,
    brand: "General Mills",
    title: "General Mills Cinnamon Chex Gluten Free Cereal",
    ingredients: "Whole Grain Rice, Rice, Sugar, Canola and/or Sunflower Oil, Salt, Cinnamon, Molasses, Rosemary Extract. Vitamin E (mixed tocopherols) Added to Preserve Freshness.",
    nutrition: { caloriesKcal100g: 400, sugarsG100g: 20.0, saturatedFatG100g: 0, sodiumMg100g: 600, fiberG100g: 5.0, proteinG100g: 5.0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.chex.com/products/cinnamon-chex",
    verifiedAt: "2026-11-15",
  },
  {
    match: /\bezekiel\s*4:?9\b.*\bcinnamon\s+raisin\b|\bfood\s+for\s+life\b.*\bcinnamon\s+raisin\b.*\bcereal\b/i,
    brand: "Food For Life",
    title: "Food For Life Ezekiel 4:9 Cinnamon Raisin Sprouted Whole Grain Cereal",
    ingredients: "Organic Sprouted Wheat, Organic Raisins, Organic Sprouted Barley, Organic Sprouted Millet, Organic Malted Barley, Organic Sprouted Lentils, Organic Sprouted Soybeans, Organic Sprouted Spelt, Filtered Water, Sea Salt, Organic Cinnamon, Organic Rosemary Extract.",
    nutrition: { caloriesKcal100g: 333, sugarsG100g: 14.0, saturatedFatG100g: 0, sodiumMg100g: 228, fiberG100g: 8.8, proteinG100g: 12.3, fruitsVegNutsPct: 0, isOrganic: true, isWholeFood: false },
    sourceUrl: "https://www.foodforlife.com/product/cereals/ezekiel-49-cinnamon-raisin-sprouted-whole-grain-cereal",
    verifiedAt: "2026-11-15",
  },
  {
    match: /\bnature'?s\s+path\b.*\bsunrise\b.*\bcinnamon\b|\bsunrise\s+crunchy\s+cinnamon\b/i,
    brand: "Nature's Path",
    title: "Nature's Path Organic Sunrise Crunchy Cinnamon Gluten Free Cereal",
    ingredients: "Organic brown rice flour, organic whole grain corn meal, organic cane sugar, corn meal, organic yellow corn flour, organic inulin, organic quinoa, organic flax seeds, sea salt, organic buckwheat flour, organic amaranth, organic cinnamon, organic molasses, tocopherols (vitamin E).",
    nutrition: { caloriesKcal100g: 375, sugarsG100g: 20.0, saturatedFatG100g: 0, sodiumMg100g: 375, fiberG100g: 10, proteinG100g: 7.5, fruitsVegNutsPct: 0, isOrganic: true, isWholeFood: false },
    sourceUrl: "https://naturespath.com/products/crunchy-sunrise-cinnamon-cold-cereal-np-us",
    verifiedAt: "2026-11-15",
  },
  {
    match: /^(?!.*\b(organic|instant|quick|1[- ]?minute|steel\s+cut|maple|brown\s+sugar|apple|cinnamon|raisin|peaches|strawberries|berries|cream|protein|fiber|grits|flour|granola|bars?|chewy|cookies?|squares|life)\b).*\bquaker\b.*\b(old\s+fashioned|rolled\s+oats)\b.*\b(oats?|oatmeal)\b/i,
    brand: "Quaker",
    title: "Quaker Oats Old Fashioned 100% Whole Grain Oats",
    keywords: ["oatmeal", "rolled oats", "canister"],
    ingredients: "Whole Grain Rolled Oats.",
    nutrition: { caloriesKcal100g: 375, sugarsG100g: 2.5, saturatedFatG100g: 1.3, sodiumMg100g: 0, fiberG100g: 10.0, proteinG100g: 12.5, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: true, isOrganic: false },
    sourceUrl: "https://www.quakerfoods.com/products/hot-cereals/old-fashioned-oats",
    verifiedAt: "2026-11-15",
  },
  {
    match: /^(?!.*\b(organic|instant|old\s+fashioned|steel\s+cut|maple|brown\s+sugar|apple|cinnamon|raisin|peaches|strawberries|berries|cream|protein|fiber|grits|flour|granola|bars?|chewy|cookies?|squares|life)\b).*\bquaker\b.*\b(quick|1[- ]?minute)\b.*\b(oats?|oatmeal)\b/i,
    brand: "Quaker",
    title: "Quaker Quick 1-Minute 100% Whole Grain Oats",
    keywords: ["oatmeal", "quick oats", "1 minute", "rolled oats"],
    ingredients: "Whole Grain Rolled Oats.",
    nutrition: { caloriesKcal100g: 375, sugarsG100g: 2.5, saturatedFatG100g: 1.3, sodiumMg100g: 0, fiberG100g: 10.0, proteinG100g: 12.5, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: true, isOrganic: false },
    sourceUrl: "https://www.quakerfoods.com/products/hot-cereals/quick-oats",
    verifiedAt: "2026-11-15",
  },
  {
    match: /^(?!.*\b(organic|lower\s+sugar|less\s+sugar|zero\s+sugar|protein|high\s+fiber|gluten\s+free|cup|bars?|chewy|granola|cereal\s+squares)\b)(?=.*\bquaker\b)(?=.*\binstant\s+oatmeal\b)(?=.*\bmaple\b)(?=.*\bbrown\s+sugar\b).*/i,
    brand: "Quaker",
    title: "Quaker Instant Oatmeal Maple & Brown Sugar",
    keywords: ["packets", "flavor", "flavored", "oats"],
    ingredients: "Whole Grain Oats, Sugar, Salt, Natural Flavor.",
    nutrition: { caloriesKcal100g: 372, sugarsG100g: 27.9, saturatedFatG100g: 1.2, sodiumMg100g: 605, fiberG100g: 7.0, proteinG100g: 9.3, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false, isOrganic: false },
    sourceUrl: "https://www.quakerfoods.com/products/instant-oatmeal/maple-and-brown-sugar",
    verifiedAt: "2026-11-15",
  },
  {
    match: /^(?!.*\b(organic|lower\s+sugar|less\s+sugar|zero\s+sugar|protein|high\s+fiber|gluten\s+free|maple|brown\s+sugar|apple|cinnamon|raisin|peaches|strawberries|berries|cream|cup|bars?|chewy|granola)\b)(?=.*\bquaker\b)(?=.*\binstant\s+oatmeal\b)(?=.*\b(original|regular)\b).*/i,
    brand: "Quaker",
    title: "Quaker Instant Oatmeal Original",
    keywords: ["packets", "regular", "oats"],
    ingredients: "Whole Grain Oats, Salt.",
    nutrition: { caloriesKcal100g: 357, sugarsG100g: 0, saturatedFatG100g: 1.8, sodiumMg100g: 268, fiberG100g: 10.7, proteinG100g: 14.3, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: false, isOrganic: false },
    sourceUrl: "https://www.quakerfoods.com/products/instant-oatmeal/regular",
    verifiedAt: "2026-11-15",
  },
  {
    match: /^(?!.*\b(quick|instant|steel\s+cut|extra\s+thick|protein|gluten\s+free|maple|brown\s+sugar|apple|cinnamon|cup|flour|granola|bars?|muesli|bran)\b).*\bbob'?s\s+red\s+mill\b.*\borganic\b.*\b(old\s+fashioned|rolled\s+oats)\b/i,
    brand: "Bob's Red Mill",
    title: "Bob's Red Mill Organic Old Fashioned Rolled Oats",
    keywords: ["whole grain", "oatmeal", "oats", "non", "gmo"],
    ingredients: "Organic Whole Grain Oats.",
    nutrition: { caloriesKcal100g: 396, sugarsG100g: 0, saturatedFatG100g: 1.0, sodiumMg100g: 0, fiberG100g: 10.4, proteinG100g: 12.5, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: true, isOrganic: true },
    sourceUrl: "https://www.bobsredmill.com/product/organic-old-fashioned-rolled-oats",
    verifiedAt: "2026-11-15",
  },
  {
    match: /\bhoney\s+nut\s+cheerios\b|\bcheerios\b.*\bhoney\s+nut\b/i,
    brand: "General Mills",
    title: "Honey Nut Cheerios Oats Cereal",
    ingredients: "Whole Grain Oats, Sugar, Corn Starch, Honey, Brown Sugar Syrup, Salt, Tripotassium Phosphate, Canola and/or Sunflower Oil, Natural Almond Flavor. Vitamin E (mixed tocopherols) Added to Preserve Freshness.",
    nutrition: { caloriesKcal100g: 378, sugarsG100g: 32.4, saturatedFatG100g: 0, sodiumMg100g: 568, fiberG100g: 8.1, proteinG100g: 8.1, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.cheerios.com/products/honey-nut-cheerios",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?=.*\bcheerios\b)(?!.*\b(honey|frosted|chocolate|strawberry|berry|apple|cinnamon|multigrain|oat\s*crunch)\b).*$/i,
    brand: "General Mills",
    title: "Original Cheerios Toasted Whole Grain Oat Cereal",
    ingredients: "Whole Grain Oats, Corn Starch, Sugar, Salt, Tripotassium Phosphate. Vitamin E (mixed tocopherols) Added to Preserve Freshness.",
    nutrition: { caloriesKcal100g: 359, sugarsG100g: 5.1, saturatedFatG100g: 1.3, sodiumMg100g: 487, fiberG100g: 10.3, proteinG100g: 12.8, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.cheerios.com/products/original-cheerios",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?=.*\bchobani\b)(?=.*\bplain\b)(?!.*\b(flip|strawberry|vanilla|blueberry|peach|mango|berry|creamer|oat)\b).*$/i,
    brand: "Chobani",
    title: "Non-Fat Greek Yogurt Plain",
    ingredients: "Cultured Nonfat Milk. Live and Active Cultures: S. Thermophilus, L. Bulgaricus, L. Acidophilus, Bifidus, L. Casei, and L. Rhamnosus.",
    nutrition: { caloriesKcal100g: 53, sugarsG100g: 3.5, saturatedFatG100g: 0, sodiumMg100g: 38, fiberG100g: 0, proteinG100g: 9.4, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://www.chobani.com/products/greek/plain/non-fat-plain",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(go[- ]?gurt)\b/i,
    brand: "Yoplait Go-GURT",
    title: "Go-GURT Portable Lowfat Yogurt Tubes",
    ingredients: "Cultured Grade A Low Fat Milk, Sugar, Modified Corn Starch, Kosher Gelatin, Tricalcium Phosphate, Natural Flavor, Colored with Vegetable Juice and Beta Carotene, Citric Acid, Vitamin A Acetate, Vitamin D3.",
    nutrition: { caloriesKcal100g: 78, sugarsG100g: 9.4, saturatedFatG100g: 0.8, sodiumMg100g: 47, fiberG100g: 0, proteinG100g: 3.1, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.yoplait.com/products/go-gurt",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\bplain\b).*\b(yoplait)\b/i,
    brand: "Yoplait",
    title: "Original Strawberry Lowfat Yogurt",
    ingredients: "Cultured Pasteurized Grade A Lowfat Milk, Sugar, Strawberries, Modified Corn Starch, Nonfat Milk, Kosher Gelatin, Citric Acid, Tricalcium Phosphate, Natural Flavor, Pectin, Colored with Carmine, Vitamin A Acetate, Vitamin D3.",
    nutrition: { caloriesKcal100g: 82, sugarsG100g: 10.6, saturatedFatG100g: 0.6, sodiumMg100g: 47, fiberG100g: 0, proteinG100g: 2.9, fruitsVegNutsPct: 5, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.yoplait.com/products/original-strawberry",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(hidden valley)\b/i,
    brand: "Hidden Valley",
    title: "Original Ranch Salad Dressing & Topping",
    keywords: ["gluten free"],
    ingredients: "Vegetable Oil (Soybean and/or Canola), Water, Egg Yolk, Sugar, Salt, Cultured Nonfat Buttermilk, Natural Flavors, Less than 1% of: Spices, Dried Garlic, Dried Onion, Vinegar, Phosphoric Acid, Xanthan Gum, Modified Food Starch, Monosodium Glutamate, Artificial Flavors, Disodium Phosphate, Sorbic Acid and Calcium Disodium EDTA Added to Preserve Freshness, Disodium Inosinate and Disodium Guanylate.",
    nutrition: { caloriesKcal100g: 433, sugarsG100g: 3.3, saturatedFatG100g: 6.7, sodiumMg100g: 867, fiberG100g: 0, proteinG100g: 1.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.hiddenvalley.com/products/ranch-condiments/classic-ranch/original-ranch/",
    verifiedAt: "2026-11-18",
  },
  {
    match: /(?<!primal kitchen |avocado oil |organic )\branch dressing\b/i,
    brand: "Representative Category Formulation",
    title: "Creamy Ranch Salad Dressing (Category Estimate)",
    ingredients: "Vegetable Oil (Soybean and/or Canola), Water, Egg Yolk, Sugar, Salt, Cultured Nonfat Buttermilk, Natural Flavors, Less than 1% of: Spices, Dried Garlic, Dried Onion, Vinegar, Phosphoric Acid, Xanthan Gum, Modified Food Starch, Monosodium Glutamate, Artificial Flavors, Disodium Phosphate, Sorbic Acid and Calcium Disodium EDTA Added to Preserve Freshness, Disodium Inosinate and Disodium Guanylate.",
    nutrition: { caloriesKcal100g: 433, sugarsG100g: 3.3, saturatedFatG100g: 6.7, sodiumMg100g: 867, fiberG100g: 0, proteinG100g: 1.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/173590/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(triscuit)\b/i,
    brand: "Triscuit",
    title: "Original Whole Grain Wheat Crackers",
    keywords: ["nabisco"],
    ingredients: "Whole Grain Wheat, Canola Oil, Sea Salt.",
    nutrition: { caloriesKcal100g: 428, sugarsG100g: 0, saturatedFatG100g: 0.9, sodiumMg100g: 570, fiberG100g: 10.7, proteinG100g: 10.7, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.snackworks.com/products/triscuit-original-whole-grain-wheat-crackers/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(ritz)\b/i,
    brand: "Ritz",
    title: "Original Baked Crackers",
    keywords: ["nabisco"],
    ingredients: "Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Soybean and/or Canola Oil, Palm Oil, Sugar, Salt, Leavening (Calcium Phosphate, Baking Soda), High Fructose Corn Syrup, Soy Lecithin, Natural Flavor.",
    nutrition: { caloriesKcal100g: 500, sugarsG100g: 12.5, saturatedFatG100g: 6.3, sodiumMg100g: 813, fiberG100g: 1.5, proteinG100g: 6.3, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.snackworks.com/products/ritz-original-crackers/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(natural|no\s+added\s+sugar|crunchy|extra\s+crunchy|reduced\s+fat|honey|chocolate|whips)\b).*\bjif\b.*\bpeanut\s+butter\b/i,
    brand: "Jif",
    title: "Creamy Peanut Butter",
    ingredients: "Made From Roasted Peanuts And Sugar, Contains 2% Or Less Of: Molasses, Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Mono And Diglycerides, Salt.",
    nutrition: { caloriesKcal100g: 576, sugarsG100g: 9.1, saturatedFatG100g: 10.6, sodiumMg100g: 409, fiberG100g: 6.1, proteinG100g: 21.2, fruitsVegNutsPct: 90, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.jif.com/peanut-butter/creamy/creamy-peanut-butter",
    verifiedAt: "2026-11-10",
  },
  {
    match: /^(?!.*\b(less\s+sugar|protein|s'?mores|peanut\s+butter|oatmeal\s+raisin|dipps|big\s+chewy)\b).*\bquaker\b.*\bchewy\b.*\bchocolate\s+chip\b.*\bgranola\s+bars?\b/i,
    brand: "Quaker",
    title: "Chewy Chocolate Chip Granola Bars",
    ingredients: "Granola (Whole Grain Oats, Brown Sugar, Brown Rice Crisp [Whole Grain Brown Rice Flour, Sugar, Salt], Whole Grain Wheat, Soybean Oil, Coconut, Whole Wheat Flour, Baking Soda, Soy Lecithin, Nonfat Dry Milk), Semisweet Chocolate Chips (Sugar, Chocolate Liquor, Cocoa Butter, Soy Lecithin, Vanilla Extract), Corn Syrup, Brown Rice Crisp (Whole Grain Brown Rice Flour, Sugar, Salt), Invert Sugar, Sugar, Corn Syrup Solids, Glycerin, Soybean Oil, Contains 2% or Less of: Calcium Carbonate, Sorbitol, Salt, Soy Lecithin, Molasses, Tocopherols (to Preserve Freshness), Natural Flavor.",
    nutrition: { caloriesKcal100g: 417, sugarsG100g: 29.2, saturatedFatG100g: 6.3, sodiumMg100g: 292, fiberG100g: 4.2, proteinG100g: 4.2, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.quakerfoods.com/products/quaker-chewy-granola-bars/chocolate-chip",
    verifiedAt: "2026-11-10",
  },
  {
    match: /^(?!.*\b(baked|lightly\s+salted|kettle|wavy|sour\s+cream|bbq|barbecue|salt\s*(?:&|and)\s*vinegar|cheddar|limon|flamin|honey|dill|stacks|stax)\b).*\blay'?s\b.*\bclassic\b.*\bpotato\s+chips\b/i,
    brand: "Lay's",
    title: "Classic Potato Chips",
    ingredients: "Potatoes, Vegetable Oil (Canola, Corn, Soybean, and/or Sunflower Oil), and Salt.",
    nutrition: { caloriesKcal100g: 571, sugarsG100g: 3.6, saturatedFatG100g: 5.4, sodiumMg100g: 607, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 80, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.lays.com/products/lays-classic-potato-chips",
    verifiedAt: "2026-11-10",
  },
  {
    match: /(?<!mary'?s gone |organic |seed )\b(club crackers|town house|wheat thins|saltines|butter crackers|holiday crackers)\b/i,
    brand: "Representative Cracker Formulation",
    title: "Baked Snack Crackers (Representative Formulation)",
    ingredients: "Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Soybean and/or Canola Oil, Sugar, Salt, Leavening (Calcium Phosphate, Baking Soda), Soy Lecithin.",
    nutrition: { caloriesKcal100g: 500, sugarsG100g: 12.5, saturatedFatG100g: 6.3, sodiumMg100g: 813, fiberG100g: 1.5, proteinG100g: 6.3, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/175007/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(knoppers|storck)\b|\b(hazelnut wafers?)\b/i,
    brand: "Storck",
    title: "Knoppers Milk Chocolate & Hazelnut Wafers",
    ingredients: "Sugar, Vegetable Fats (Palm, Shea), Whole Milk Powder, Cocoa Butter, Wheat Flour, Hazelnuts, Cocoa Mass, Skim Milk Powder, Lactose, Butterfat, Low-Fat Cocoa, Soy Lecithin, Whey Product, Salt, Natural Flavors, Sodium Bicarbonate.",
    nutrition: { caloriesKcal100g: 535, sugarsG100g: 44, saturatedFatG100g: 16.5, sodiumMg100g: 160, fiberG100g: 2.0, proteinG100g: 6.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e" },
    sourceUrl: "https://www.knoppers.com/en/products/knoppers",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(tony'?s\s+chocolonely)\b/i,
    brand: "Tony's Chocolonely",
    title: "Milk Chocolate Caramel Sea Salt Bar",
    ingredients: "Sugar, Dry Whole Milk, Cocoa Butter, Chocolate Liquor, Caramel Pieces (Sugar, Corn Syrup, Cream, Butter), Sea Salt, Soy Lecithin.",
    nutrition: { caloriesKcal100g: 533, sugarsG100g: 50.0, saturatedFatG100g: 18.0, sodiumMg100g: 215, fiberG100g: 3.3, proteinG100g: 6.7, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://us.tonyschocolonely.com/products/milk-caramel-sea-salt-32",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(lindt|lindor)\b/i,
    brand: "Lindt",
    title: "Lindt Lindor Milk Chocolate Candy Truffles",
    ingredients: "Milk Chocolate (Sugar, Cocoa Butter, Milk, Chocolate, Soya Lecithin (Emulsifier), Barley Malt Powder, Vanillin (Artificial Flavoring)), Vegetable Oil (Coconut, Palm Kernel), Sugar, Chocolate, Cocoa Butter, Milk, Soya Lecithin (Emulsifier), Barley Malt Powder, Artificial Flavors.",
    nutrition: { caloriesKcal100g: 611, sugarsG100g: 44.4, saturatedFatG100g: 33.3, sodiumMg100g: 83, fiberG100g: 2.8, proteinG100g: 5.6, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.lindtusa.com/lindor-milk-chocolate-truffles-bag-431922",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(ferrero\s+(?:rocher|collection))\b/i,
    brand: "Ferrero",
    title: "Ferrero Rocher Fine Hazelnut Milk Chocolates",
    ingredients: "Milk Chocolate (Sugar, Cocoa Butter, Cocoa Mass, Skim Milk Powder, Butteroil, Lecithin as Emulsifier (Soy), Vanillin: An Artificial Flavor), Hazelnuts, Sugar, Palm Oil, Wheat Flour, Whey (Milk), Lowfat Cocoa Powder, Lecithin as Emulsifier (Soy), Sodium Bicarbonate as Leavening Agent, Salt, Vanillin: An Artificial Flavor.",
    nutrition: { caloriesKcal100g: 595, sugarsG100g: 40.5, saturatedFatG100g: 14.3, sodiumMg100g: 60, fiberG100g: 4.8, proteinG100g: 7.1, fruitsVegNutsPct: 28, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.ferrerorocher.com/us/en/our-products/ferrero-rocher",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(reese'?s)\b(?!\s+puffs)/i,
    brand: "Reese's",
    title: "Reese's Milk Chocolate Peanut Butter Cups",
    ingredients: "Milk Chocolate (Sugar, Cocoa Butter, Chocolate, Skim Milk, Milk Fat, Lactose, Lecithin (Soy), PGPR), Peanuts, Sugar, Dextrose, Salt, TBHQ and Citric Acid, to Maintain Freshness.",
    nutrition: { caloriesKcal100g: 500, sugarsG100g: 52.4, saturatedFatG100g: 10.7, sodiumMg100g: 357, fiberG100g: 4.8, proteinG100g: 11.9, fruitsVegNutsPct: 25, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.hersheyland.com/products/reeses-milk-chocolate-peanut-butter-cups-1-5-oz.html",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(hershey'?s?)\b/i,
    brand: "Hershey's",
    title: "Hershey's Milk Chocolate Candy Bar",
    ingredients: "Milk Chocolate (Sugar, Milk, Chocolate, Cocoa Butter, Milk Fat, Lecithin (Soy), PGPR, Natural Flavor).",
    nutrition: { caloriesKcal100g: 535, sugarsG100g: 51, saturatedFatG100g: 18.0, sodiumMg100g: 75, fiberG100g: 3.0, proteinG100g: 7.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.hersheyland.com/products/hersheys-milk-chocolate-candy-bars-1-55-oz.html",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(frank'?s\s+redhot)\b.*\b(wings?|buffalo)\b/i,
    brand: "Frank's RedHot",
    title: "Frank's RedHot Wings Buffalo Sauce",
    ingredients: "Distilled Vinegar, Aged Cayenne Red Peppers, Salt, Water, Canola Oil, Paprika, Xanthan Gum, Natural Butter Type Flavor and Garlic Powder.",
    nutrition: { caloriesKcal100g: 33, sugarsG100g: 0, saturatedFatG100g: 0, sodiumMg100g: 3060, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 35, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.mccormick.com/franks-redhot/products/sauces/franks-redhot-buffalo-wings-sauce",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(frank'?s\s+redhot)\b/i,
    brand: "Frank's RedHot",
    title: "Frank's RedHot Original Cayenne Pepper Hot Sauce",
    ingredients: "Aged Cayenne Red Peppers, Distilled Vinegar, Water, Salt and Garlic Powder.",
    nutrition: { caloriesKcal100g: 0, sugarsG100g: 0, saturatedFatG100g: 0, sodiumMg100g: 3800, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 50, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.mccormick.com/franks-redhot/products/sauces/franks-redhot-original-cayenne-pepper-sauce",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(kinder|ghirardelli|snickers|twix|kit\s*kat|m&m'?s|butterfinger|milky way|3 musketeers)\b|\b(chocolate variety|milk and creamy chocolate|chocolate candy|chocolate bar|chocolate truffles)\b/i,
    brand: "Representative Confectionery Formulation",
    title: "Milk Chocolate Confectionery (Representative Formulation)",
    ingredients: "Sugar, Chocolate, Cocoa Butter, Milk, Skim Milk, Milkfat, Soy Lecithin, PGPR (Emulsifier), Natural Flavor.",
    nutrition: { caloriesKcal100g: 535, sugarsG100g: 51, saturatedFatG100g: 18.0, sodiumMg100g: 75, fiberG100g: 3.0, proteinG100g: 7.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e" },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/167587/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(velveeta)\b/i,
    brand: "Velveeta",
    title: "Original Pasteurized Recipe Cheese Product",
    ingredients: "Milk, Water, Whey, Milk Protein Concentrate, Milkfat, Whey Protein Concentrate, Sodium Phosphate, Contains Less than 2% of Salt, Calcium Phosphate, Lactic Acid, Sorbic Acid as a Preservative, Sodium Citrate, Sodium Alginate, Enzymes, Apocarotenal and Annatto (Color), Cheese Culture.",
    nutrition: { caloriesKcal100g: 285, sugarsG100g: 7.0, saturatedFatG100g: 11.0, sodiumMg100g: 1460, fiberG100g: 0, proteinG100g: 14.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e" },
    sourceUrl: "https://www.myfoodandfamily.com/brands/velveeta/product/00021000611614",
    verifiedAt: "2026-11-08",
  },
  {
    match: /(?<!organic )\b(processed cheese|cheese loaf|queso dip|pasteurized process cheese)\b/i,
    brand: "Representative Process Cheese Formulation",
    title: "Pasteurized Process Cheese and Queso Dip (Representative Formulation)",
    ingredients: "Milk, Water, Whey, Milkfat, Sodium Phosphate, Salt, Calcium Phosphate, Lactic Acid, Sorbic Acid (Preservative), Sodium Citrate, Enzymes, Annatto (Color), Cheese Culture.",
    nutrition: { caloriesKcal100g: 285, sugarsG100g: 7.0, saturatedFatG100g: 11.0, sodiumMg100g: 1460, fiberG100g: 0, proteinG100g: 14.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e" },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/170851/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(uncured)\b.*\b(turkey bacon)\b|\b(applegate)\b.*\b(turkey bacon)\b/i,
    brand: "Applegate Naturals",
    title: "Hickory Smoked Uncured Turkey Bacon",
    ingredients: "Turkey, Water, Contains Less than 2% of Sea Salt, Cane Sugar, Celery Powder, Rosemary Extract.",
    nutrition: { caloriesKcal100g: 215, sugarsG100g: 1.5, saturatedFatG100g: 2.8, sodiumMg100g: 760, fiberG100g: 0, proteinG100g: 17.0, fruitsVegNutsPct: 0, isWholeFood: false , nutriScoreGrade: "d"},
    sourceUrl: "https://applegate.com/products/natural-uncured-turkey-bacon",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(uncured)\b.*\b(bacon|sunday bacon|black forest|hickory smoked)\b|\b(applegate|coleman|dietz\s*&\s*watson|nueske'?s|paleo|pederson'?s)\b.*\b(bacon)\b/i,
    brand: "Natural Uncured",
    title: "Hickory Smoked Uncured Pork Bacon",
    ingredients: "Pork, Water, Sea Salt, Less than 2% of Cane Sugar, Celery Powder.",
    nutrition: { caloriesKcal100g: 410, sugarsG100g: 1.5, saturatedFatG100g: 13.5, sodiumMg100g: 920, fiberG100g: 0, proteinG100g: 24.0, fruitsVegNutsPct: 0, isWholeFood: false , nutriScoreGrade: "d"},
    sourceUrl: "https://applegate.com/products/natural-sunday-bacon",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(uncured|bits|crumbled|crumbles|real\s+bacon|jerky|wicked\s+cutz|ranch|hot pocket|macaroni)\b).*\b(wellsley farms sliced bacon|hormel.*bacon|smithfield.*bacon|oscar mayer.*bacon|wright.*bacon|farmland.*bacon|kirkland.*bacon|great value.*bacon|member'?s mark.*bacon|thick cut.*bacon|microwave ready bacon|fully cooked bacon|hickory smoked.*bacon|sliced bacon|pork bacon|low sodium bacon|bacon)\b/i,
    brand: "Cured Pork Bacon",
    title: "Hickory Smoked Cured Sliced Bacon",
    ingredients: "Pork, Water, Salt, Sugar, Sodium Phosphate, Sodium Erythorbate, Sodium Nitrite.",
    nutrition: { caloriesKcal100g: 440, sugarsG100g: 1.5, saturatedFatG100g: 14.5, sodiumMg100g: 1080, fiberG100g: 0, proteinG100g: 26.0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/168322/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(beyond meat|beyond burger|beyond sausage|beyond beef)\b/i,
    brand: "Beyond Meat",
    title: "Plant-Based Burger Patties",
    ingredients: "Water, Pea Protein, Expeller-Pressed Canola Oil, Refined Coconut Oil, Rice Protein, Natural Flavors, Methylcellulose, Potato Starch, Apple Extract, Pomegranate Extract, Salt, Potassium Chloride, Vinegar, Lemon Juice Concentrate, Sunflower Lecithin, Beet Juice Extract (for Color).",
    nutrition: { caloriesKcal100g: 204, sugarsG100g: 0, saturatedFatG100g: 4.4, sodiumMg100g: 345, fiberG100g: 1.8, proteinG100g: 17.7, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.beyondmeat.com/en-US/products/the-beyond-burger",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(impossible burger|impossible sausage|impossible beef|impossible foods)\b/i,
    brand: "Impossible Foods",
    title: "Plant-Based Burger Patties",
    ingredients: "Water, Soy Protein Concentrate, Sunflower Oil, Coconut Oil, 2% or Less of: Methylcellulose, Yeast Extract, Salt, Natural Flavors, Cultured Dextrose, Modified Food Starch, Soy Leghemoglobin, Mixed Tocopherols (Antioxidant), Soy Protein Isolate, Vitamins and Minerals.",
    nutrition: { caloriesKcal100g: 204, sugarsG100g: 0.9, saturatedFatG100g: 5.3, sodiumMg100g: 327, fiberG100g: 4.4, proteinG100g: 16.8, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://impossiblefoods.com/products/beef/impossible-burger-patties",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(morningstar farms|boca|gardein)\b/i,
    brand: "Representative Plant-Based Meat Formulation",
    title: "Plant-Based Patties and Tenders (Representative Formulation)",
    ingredients: "Water, Soy Protein Concentrate, Wheat Gluten, Vegetable Oil (Corn, Canola and/or Sunflower Oil), Soy Protein Isolate, Methylcellulose, Salt, Yeast Extract, Natural Flavors, Spices, Xanthan Gum, Onion Powder, Garlic Powder.",
    nutrition: { caloriesKcal100g: 209, sugarsG100g: 1.5, saturatedFatG100g: 0.7, sodiumMg100g: 582, fiberG100g: 4.5, proteinG100g: 19.4, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/175114/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(hot pocket|hot pockets|lean pocket|lean pockets)\b/i,
    brand: "Representative Category Formulation",
    title: "Frozen Stuffed Sandwich and Entree (Representative Formulation)",
    ingredients: "Enriched Flour (Wheat Flour, Malted Barley Flour, Niacin, Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Cooked White Meat Chicken, Reduced Fat Cheddar Cheese, Soybean Oil, Bacon (Cured with Water, Salt, Sugar, Smoke Flavoring, Sodium Phosphate, Sodium Erythorbate, Sodium Nitrite), 2% or Less of Modified Food Starch, Sugar, Salt, Buttermilk, Potassium Chloride, Autolyzed Yeast Extract, Disodium Phosphate, Xanthan Gum, Monosodium Glutamate, Natural Flavors.",
    nutrition: { caloriesKcal100g: 244, sugarsG100g: 3.1, saturatedFatG100g: 3.9, sodiumMg100g: 465, fiberG100g: 1.6, proteinG100g: 7.9, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/167707/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(jimmy\s+dean|breakfast\s+croissant|sausage,?\s*egg\s*(&|and)\s*cheese)\b/i,
    brand: "Jimmy Dean",
    title: "Pork Breakfast Sausage (Representative Formulation)",
    ingredients: "Pork, Water, Contains 2% or Less of: Salt, Sugar, Spices, Dextrose, Monosodium Glutamate, Natural Flavorings, Citric Acid.",
    nutrition: { caloriesKcal100g: 375, sugarsG100g: 1.8, saturatedFatG100g: 10.7, sodiumMg100g: 732, fiberG100g: 0, proteinG100g: 16.1, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.jimmydean.com/products/fresh-sausage/roll-sausage/premium-pork-regular-sausage/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(hillshire farm|kielbasa|polska kielbasa|smoked sausage|eckrich|johnsonville)\b/i,
    brand: "Representative Smoked Sausage Formulation",
    title: "Smoked Sausage and Kielbasa (Representative Formulation)",
    ingredients: "Pork, Turkey, Beef, Water, Corn Syrup, Modified Food Starch, Contains 2% or Less of Salt, Dextrose, Sodium Citrate, Sodium Phosphate, Monosodium Glutamate, Sodium Diacetate, Sodium Erythorbate, Flavorings, Sodium Nitrite.",
    nutrition: { caloriesKcal100g: 304, sugarsG100g: 3.6, saturatedFatG100g: 8.9, sodiumMg100g: 857, fiberG100g: 0, proteinG100g: 12.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/174580/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\bsmoked\b).*\b(oscar\s+mayer)\b.*\b(deli\s+fresh|turkey|oven\s+roasted)\b/i,
    brand: "Oscar Mayer",
    title: "Oscar Mayer Deli Fresh Oven Roasted Turkey Breast",
    ingredients: "Turkey Breast, Water, Modified Cornstarch, Contains Less than 2% of Vinegar, Salt, Cultured Dextrose, Sugar, Sodium Phosphates, Carrageenan, Caramel Color.",
    nutrition: { caloriesKcal100g: 89, sugarsG100g: 1.8, saturatedFatG100g: 0.4, sodiumMg100g: 890, fiberG100g: 0, proteinG100g: 16.0, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.oscarmayer.com/products/00044700030806-deli-fresh-oven-roasted-turkey-breast-sliced-lunch-meat",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(?:oven\s+roasted|honey|cracked\s+black\s+pepper|mesquite|rotisserie|cajun|herb|ham|chicken|beef)\b).*\boscar\s+mayer\b.*\bdeli\s+fresh\b.*\bsmoked\s+turkey\s+breast\b/i,
    brand: "Oscar Mayer",
    title: "Oscar Mayer Deli Fresh Smoked Turkey Breast",
    barcode: "0044700030813",
    keywords: ["oscar", "mayer", "deli", "fresh", "smoked", "turkey", "breast", "sliced", "lunch", "meat"],
    ingredients: "Turkey Breast, Water, Cultured Dextrose, Modified Cornstarch, Contains Less than 2% of Salt, Vinegar, Cultured Celery Juice, Sodium Phosphates, Cherry Powder, Smoke Flavor, Carrageenan.",
    nutrition: { caloriesKcal100g: 89, sugarsG100g: 0, saturatedFatG100g: 0, sodiumMg100g: 893, fiberG100g: 0, proteinG100g: 17.9, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.kraftheinz.com/oscar-mayer/products/00044700030813-deli-fresh-smoked-turkey-breast-sliced-lunch-meat",
    verifiedAt: "2026-11-18",
  },
  {
    match: /\b(tyson)\b.*\b(grilled\s*(&|and)?\s*ready|grilled.*chicken|roasted.*chicken|unbreaded.*chicken)\b/i,
    brand: "Tyson",
    title: "Tyson Grilled & Ready Fully Cooked Chicken Breast Strips",
    ingredients: "Chicken Breast with Rib Meat, Water, Seasoning (Salt, Sugar, Yeast Extract, Maltodextrin, Spices, Chicken Broth, Garlic Powder, Onion Powder, Natural Flavors), Potato Starch, Vinegar.",
    nutrition: { caloriesKcal100g: 135, sugarsG100g: 0.8, saturatedFatG100g: 0.8, sodiumMg100g: 480, fiberG100g: 0, proteinG100g: 23.0, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.tyson.com/products/grilled-chicken-breast-strips/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(grilled|roasted|rotisserie|unbreaded|naked)\b.*\b(chicken\s+(breast\s+)?(strips?|bites?|cuts?|diced|chunks?))\b|\b(chicken\s+(breast\s+)?(strips?|bites?|cuts?))\b.*\b(grilled|roasted|rotisserie|unbreaded)\b/i,
    brand: "Grilled Poultry",
    title: "Fully Cooked Grilled Chicken Breast Strips",
    ingredients: "Boneless, Skinless Chicken Breast with Rib Meat, Water, Contains 2% or Less of Salt, Vinegar, Natural Flavor, Garlic Powder, Onion Powder, Spices.",
    nutrition: { caloriesKcal100g: 135, sugarsG100g: 0.5, saturatedFatG100g: 0.8, sodiumMg100g: 410, fiberG100g: 0, proteinG100g: 23.0, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171477/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(grilled|unbreaded|naked|just\s+bare)\b).*\b(crispy chicken|breaded chicken|chicken patties|chicken patty|chicken nuggets|chicken tenders|chicken strips|popcorn chicken|chicken fries|perdue.*breaded|tyson.*chicken|wellsley farms.*crispy chicken|wellsley farms.*chicken patties)\b/i,
    brand: "Breaded Poultry",
    title: "Breaded Crispy Chicken Breast Patties",
    ingredients: "Boneless Skinless Chicken Breast with Rib Meat, Water, Wheat Flour, Bleached Wheat Flour, Modified Food Starch, Vegetable Oil (Soybean and/or Canola Oil), Salt, Dextrose, Sodium Phosphates, Leavening (Sodium Acid Pyrophosphate, Sodium Bicarbonate), Yeast Extract, Onion Powder, Garlic Powder, Spice, Natural Flavor.",
    nutrition: { caloriesKcal100g: 265, sugarsG100g: 2.5, saturatedFatG100g: 4.8, sodiumMg100g: 620, fiberG100g: 1.5, proteinG100g: 13.0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171502/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(heinz.*gravy|turkey gravy|chicken gravy|beef gravy|mushroom gravy|country gravy|sausage gravy|homestyle.*gravy|franco[- ]?american.*gravy|mccormick.*gravy|campbell'?s.*gravy|pioneer.*gravy|\bgravy\b)\b/i,
    brand: "Representative Gravy Formulation",
    title: "Homestyle Savory Gravy (Representative Formulation)",
    ingredients: "Turkey Broth, Water, Modified Corn Starch, Enriched Wheat Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Chicken Fat, Contains Less than 2% of Salt, Turkey Meat, Monosodium Glutamate, Autolyzed Yeast Extract, Caramel Color, Onion Powder, Disodium Inosinate, Disodium Guanylate, Natural Flavor.",
    nutrition: { caloriesKcal100g: 42, sugarsG100g: 1.7, saturatedFatG100g: 0.8, sodiumMg100g: 483, fiberG100g: 0, proteinG100g: 1.7, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171574/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(kettle\s*&\s*fire|organic.*broth|organic.*stock|bone broth)\b/i,
    brand: "Kettle & Fire",
    title: "Organic Slow-Simmered Bone Broth",
    ingredients: "Organic Bone Broth (Water, Organic Chicken Bones, Organic Onions, Organic Carrots, Organic Celery), Organic Apple Cider Vinegar, Sea Salt, Organic Rosemary, Organic Sage, Organic Thyme, Organic Black Pepper.",
    nutrition: { caloriesKcal100g: 19, sugarsG100g: 0, saturatedFatG100g: 0, sodiumMg100g: 150, fiberG100g: 0, proteinG100g: 4.2, fruitsVegNutsPct: 10, nutriScoreGrade: "a", isOrganic: true, isWholeFood: false },
    sourceUrl: "https://www.kettleandfire.com/products/chicken-bone-broth",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(gatorade)\b/i,
    brand: "Gatorade",
    title: "Thirst Quencher Fruit Punch Sports Drink",
    ingredients: "Water, Sugar, Dextrose, Citric Acid, Salt, Sodium Citrate, Monopotassium Phosphate, Modified Food Starch, Natural Flavor, Glycerol Ester of Rosin, Red 40, Caramel Color.",
    nutrition: { caloriesKcal100g: 24, sugarsG100g: 6.0, saturatedFatG100g: 0, sodiumMg100g: 45, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.gatorade.com/sports-drinks/gatorade-thirst-quencher/fruit-punch",
    verifiedAt: "2026-11-18",
  },
  {
    match: /\b(capri\s*sun)\b/i,
    brand: "Capri Sun",
    title: "Fruit Punch Juice Drink Blend",
    ingredients: "Water, Sugar, Apple, Grape and Cherry Juice Concentrates, Citric Acid, Natural Flavor.",
    nutrition: { caloriesKcal100g: 30, sugarsG100g: 7.2, saturatedFatG100g: 0, sodiumMg100g: 8, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 10, nutriScoreGrade: "e" },
    sourceUrl: "https://www.myfoodandfamily.com/brands/capri-sun/product/00087684001035",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(health[- ]?ade)\b/i,
    brand: "Health-Ade",
    title: "Organic Raw Kombucha",
    ingredients: "Purified Water, Kombucha Culture (Yeast and Bacteria Cultures), Organic Black Tea, Organic Green Tea, Organic Cane Sugar, Organic Cold Pressed Juice.",
    nutrition: { caloriesKcal100g: 15, sugarsG100g: 3.2, saturatedFatG100g: 0, sodiumMg100g: 5, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 20, nutriScoreGrade: "a", isOrganic: true },
    sourceUrl: "https://health-ade.com/collections/kombucha/products/kombucha-pink-lady-apple",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(pretzel|graham|vanilla|s'?mores|cinnamon|parmesan|pizza|sour\s+cream|old\s+bay|spicy|frank'?s|colors|flavor\s+blasted|whole\s+grain|organic|crisps)\b).*\bgoldfish\b/i,
    brand: "Pepperidge Farm",
    title: "Goldfish Cheddar Baked Snack Crackers",
    ingredients: "Made With Smiles And Enriched Wheat Flour (Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Cheddar Cheese (Cultured Milk, Salt, Enzymes, Annatto), Vegetable Oils (Canola, Sunflower And/Or Soybean), Salt, Contains 2% Or Less Of: Yeast, Sugar, Autolyzed Yeast Extract, Paprika, Spices, Celery, Onion Powder, Monocalcium Phosphate, Baking Soda.",
    nutrition: { caloriesKcal100g: 467, sugarsG100g: 1.7, saturatedFatG100g: 3.3, sodiumMg100g: 833, fiberG100g: 3.3, proteinG100g: 10.0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.pepperidgefarm.com/product/goldfish-cheddar-crackers/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(nutella)\b/i,
    brand: "Ferrero",
    title: "Nutella Hazelnut Spread with Cocoa",
    ingredients: "Sugar, Palm Oil, Hazelnuts, Skim Milk, Cocoa, Soy Lecithin as Emulsifier, Vanillin: An Artificial Flavor.",
    nutrition: { caloriesKcal100g: 541, sugarsG100g: 56.8, saturatedFatG100g: 10.8, sodiumMg100g: 41, fiberG100g: 2.7, proteinG100g: 5.4, fruitsVegNutsPct: 13, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.nutella.com/us/en/products/nutella",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(goodles)\b/i,
    brand: "Goodles",
    title: "Cheddy Mac Creamy Cheddar Macaroni & Cheese",
    ingredients: "Goodles Noodles (Wheat Flour, Chickpea Protein, Wheat Protein, Oat Fiber, Nutrient Extract Blend), Cheddar Cheese (Cultured Milk, Salt, Enzymes), Whey, Butter (Cream, Natural Flavor), Salt, Disodium Phosphate, Lactic Acid, Annatto Extract (For Color).",
    nutrition: { caloriesKcal100g: 366, sugarsG100g: 5.6, saturatedFatG100g: 2.1, sodiumMg100g: 831, fiberG100g: 8.5, proteinG100g: 19.7, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.goodles.com/products/cheddy-mac/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(annie'?s|organic)\b.*\b(macaroni\s*(and|&)\s*cheese|mac\s*(and|&)\s*cheese|shells\s*(and|&)\s*(?:real\s+aged\s+)?cheddar)\b/i,
    brand: "Annie's Homegrown",
    title: "Organic Grass-Fed Shells & Real Aged Cheddar",
    ingredients: "Organic Wheat Pasta (Organic Wheat Flour), Organic Grass-Fed Cheddar Cheese (Cultured Pasteurized Organic Milk, Salt, Non-Animal Enzymes), Organic Whey, Organic Nonfat Milk, Organic Butter (Organic Cream, Salt), Salt, Cultured Whole Milk, Sodium Phosphate, Organic Annatto Extract (For Color).",
    nutrition: { caloriesKcal100g: 386, sugarsG100g: 7.1, saturatedFatG100g: 3.6, sodiumMg100g: 757, fiberG100g: 2.9, proteinG100g: 14.3, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isOrganic: true, isWholeFood: false },
    sourceUrl: "https://www.annies.com/product/organic-grass-fed-shells-real-aged-cheddar-mac-cheese",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\b(macaroni\s*(and|&)\s*cheese|mac\s*(and|&)\s*cheese|kraft\s+mac)\b/i,
    brand: "Kraft",
    title: "Original Macaroni & Cheese Dinner",
    ingredients: "Enriched Macaroni Product (Wheat Flour, Durum Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Cheese Sauce Mix (Whey, Milkfat, Salt, Milk Protein Concentrate, Sodium Triphosphate, Contains Less than 2% of Tapioca Flour, Citric Acid, Lactic Acid, Sodium Phosphate, Calcium Phosphate, with Paprika, Turmeric, and Annatto Added for Color, Enzymes, Cheese Culture).",
    nutrition: { caloriesKcal100g: 357, sugarsG100g: 8.6, saturatedFatG100g: 2.1, sodiumMg100g: 800, fiberG100g: 2.9, proteinG100g: 12.9, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.myfoodandfamily.com/brands/kraft-mac-and-cheese/product/00021000658831",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(organic\s+valley)\b.*\b(eggnog|egg\s+nog)\b|\b(eggnog|egg\s+nog)\b.*\b(organic\s+valley)\b/i,
    brand: "Organic Valley",
    title: "Organic Eggnog",
    ingredients: "Organic Grade A Milk, Organic Grade A Cream, Organic Cane Sugar, Organic Egg Yolks, Organic Vanilla Extract, Organic Nutmeg.",
    nutrition: { caloriesKcal100g: 142, sugarsG100g: 14.2, saturatedFatG100g: 4.2, sodiumMg100g: 63, fiberG100g: 0, proteinG100g: 4.2, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isOrganic: true, isWholeFood: false },
    sourceUrl: "https://www.organicvalley.coop/products/eggnog/eggnog/eggnog-quart/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(eggnog|egg nog)\b/i,
    brand: "Representative Dairy Eggnog Formulation",
    title: "Golden Vanilla Eggnog (Representative Formulation)",
    ingredients: "Milk, Cream, Sugar, Nonfat Milk, Egg Yolks, High Fructose Corn Syrup, Whey, Natural and Artificial Flavor, Nutmeg, Carrageenan, Guar Gum, Mono and Diglycerides, Annatto and Turmeric (Color).",
    nutrition: { caloriesKcal100g: 150, sugarsG100g: 16.7, saturatedFatG100g: 4.2, sodiumMg100g: 75, fiberG100g: 0, proteinG100g: 3.3, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171276/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(werther'?s(?:\s+original)?)\b/i,
    brand: "Werther's Original",
    title: "Caramel Hard Candies",
    ingredients: "Sugar, Glucose Syrup (From Wheat or Corn), Cream (Milk), Condensed Whey (Milk), Butter (Milk), Cane Sugar Syrup, Salt, Soy Lecithin (Emulsifier), Artificial Flavor.",
    nutrition: { caloriesKcal100g: 420, sugarsG100g: 74, saturatedFatG100g: 5.5, sodiumMg100g: 260, fiberG100g: 0, proteinG100g: 0.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.werthers-original.us/en/products/hard-candies/caramel-hard-candies",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(red bird|peppermint\s+(candy|puffs?|mints?|bark|stick|canes?)|candy\s+(puffs?|canes?)|starlight\s+mints?|butter\s+mints?|dinner\s+mints?|hard\s+cand(y|ies))\b/i,
    brand: "Red Bird",
    title: "Peppermint Candy Puffs",
    ingredients: "Pure Cane Sugar, Invert Sugar, Corn Syrup, Natural Oil of Peppermint, Red 40 (Artificial Color).",
    nutrition: { caloriesKcal100g: 392, sugarsG100g: 93, saturatedFatG100g: 0, sodiumMg100g: 15, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://piedmontcandy.com/products/all-natural-peppermint-puffs",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(unsweetened|no sugar|freeze[- ]?dried)\b).*\b(auspitee|craisins|sweetened dried|dried cranberr\w*|dried blueberr\w*|dried cherr\w*|dried strawberr\w*|dehydrated\s+(blueberr\w*|cranberr\w*|cherr\w*|strawberr\w*|fruit|berr\w*))\b/i,
    brand: "Sweetened Dried Fruit",
    title: "Sweetened Dried Berries",
    ingredients: "Berries (Blueberries and Cranberries), Cane Sugar, Refined Sunflower Oil (Used as a Processing Aid).",
    nutrition: { caloriesKcal100g: 325, sugarsG100g: 65, saturatedFatG100g: 0.2, sodiumMg100g: 5, fiberG100g: 5.3, proteinG100g: 0.4, fruitsVegNutsPct: 60, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171723/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(freeze[- ]?dried)\b.*\b(blueberr\w*|strawberr\w*|raspberr\w*|bananas?|apples?|mangos?|peaches|fruit|crisps?)\b|\b(blueberry|strawberry|raspberry|berry|fruit)\s+powder\b/i,
    brand: "Freeze-Dried",
    title: "Freeze-Dried Fruit Crisps",
    ingredients: "Freeze-Dried Fruit (Concentrated Natural Fruit Sugars).",
    nutrition: { caloriesKcal100g: 345, sugarsG100g: 54, saturatedFatG100g: 0.2, sodiumMg100g: 8, fiberG100g: 7.5, proteinG100g: 2.5, fruitsVegNutsPct: 85, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/173946/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(canola|olive|soybean|vegetable|oil|spread|margarine|peanut|almond|cashew|sunflower|cookie|cocoa|apple|buttermilk|butterfinger|popcorn|croissant|biscuit|crackers|bread|rolls|buns|sauce|chicken)\b).*\b(kerrygold)\b/i,
    brand: "Kerrygold",
    title: "Pure Irish Salted Butter",
    ingredients: "Pasteurized Cream, Salt.",
    nutrition: { caloriesKcal100g: 717, sugarsG100g: 0.1, saturatedFatG100g: 51.0, sodiumMg100g: 640, fiberG100g: 0, proteinG100g: 0.9, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.kerrygoldusa.com/products/salted-butter/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(soy|soymilk|almond|almondmilk|oat|oatmilk|coconut|cashew|chocolate|strawberry|vanilla|condensed|evaporated|buttermilk|milkshake|creamer|wafer|wafers|candy|bar|fairlife|core\s+power|horizon|organic|lactaid|simple\s+truth|good\s*(?:&|and)\s*gather|favorite\s+day|private\s+selection|protein|shake|elite)\b).*\b(whole.*milk|milk.*whole|2%(?!\d).*milk|milk.*2%(?!\d)|1%(?!\d).*milk|milk.*1%(?!\d)|skim.*milk|nonfat.*milk|reduced[- ]?fat.*milk|fat[- ]?free.*milk|vitamin d.*milk|great value.*milk|wellsley farms.*milk|kirkland.*milk|member'?s mark.*milk|grade a.*milk)\b/i,
    brand: "Grade A Dairy",
    title: "Grade A Pasteurized Milk",
    ingredients: "Grade A Milk, Vitamin D3.",
    nutrition: { caloriesKcal100g: 61, sugarsG100g: 4.8, saturatedFatG100g: 2.0, sodiumMg100g: 43, fiberG100g: 0, proteinG100g: 3.2, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171265/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(coffee[- ]?mate)\b/i,
    brand: "Coffee mate",
    title: "French Vanilla Liquid Coffee Creamer",
    ingredients: "Water, Sugar, Vegetable Oil (High Oleic Soybean and/or High Oleic Canola), and Less than 2% of Micellar Casein (a Milk Derivative), Mono- and Diglycerides, Dipotassium Phosphate, Natural and Artificial Flavor, Cellulose Gel, Cellulose Gum, Carrageenan.",
    nutrition: { caloriesKcal100g: 233, sugarsG100g: 33.3, saturatedFatG100g: 0, sodiumMg100g: 33, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.goodnes.com/coffeemate/products/french-vanilla-liquid-coffee-creamer-32-oz-bottle/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(international\s+delight|creamer)\b/i,
    brand: "International Delight",
    title: "Flavored Liquid Coffee Creamer (Representative Formulation)",
    ingredients: "Water, Sugar, Palm and/or Soybean Oil, Contains 2% or Less of: Sodium Caseinate (a Milk Derivative), Dipotassium Phosphate, Carrageenan, Mono and Diglycerides, Cellulose Gel, Cellulose Gum, Natural and Artificial Flavors.",
    nutrition: { caloriesKcal100g: 233, sugarsG100g: 33.3, saturatedFatG100g: 3.3, sodiumMg100g: 0, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.internationaldelight.com/products/coffee-creamers/flavor-faves/french-vanilla/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(blount|clam\s+shack)\b.*\b(clam\s+chowder|chowder)\b|\b(clam\s+chowder|new\s+england.*chowder)\b.*\bgluten[\s-]*free\b/i,
    brand: "Blount Clam Shack",
    title: "New England Clam Chowder (Gluten Free)",
    ingredients: "Clam Broth (Water, Clam Juice Concentrate), Potatoes, Clams (Clams, Clam Juice, Salt), Light Cream (Milk, Cream), Onions, Butter (Cream, Salt), Corn Starch, Salt, Spice, Garlic Powder.",
    nutrition: { caloriesKcal100g: 110, sugarsG100g: 1.5, saturatedFatG100g: 3.5, sodiumMg100g: 330, fiberG100g: 0.8, proteinG100g: 4.8, fruitsVegNutsPct: 25, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.blountfinefoods.com/products/new-england-clam-chowder",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(panera(\s+bread)?.*broccoli\s+cheddar|broccoli\s+cheddar\s+soup)\b/i,
    brand: "Panera Bread",
    title: "Broccoli Cheddar Soup (Representative Formulation)",
    ingredients: "Water, Milk, Broccoli, Pasteurized Process Cheddar Cheese (Cheddar Cheese [Pasteurized Milk, Cheese Culture, Salt, Enzymes], Water, Sodium Phosphate, Milkfat, Salt, Apocarotenal [Color]), Heavy Cream, Carrots, Seasoning (Modified Corn Starch, Wheat Flour, Salt, Chicken Base [Chicken Meat Including Chicken Juices, Salt, Chicken Fat, Sugar, Maltodextrin, Hydrolyzed Corn Protein, Dried Whey, Natural Flavor, Turmeric], Spices, Paprika), Onions, Butter (Cream, Salt), Soybean Oil, Dijon Mustard (Water, Vinegar, Mustard Seed, Salt, White Wine, Fruit Pectin, Tartaric Acid, Citric Acid, Sugar, Spice), Nisin Preparation, Annatto Extract (Color).",
    nutrition: { caloriesKcal100g: 135, sugarsG100g: 2.0, saturatedFatG100g: 5.5, sodiumMg100g: 430, fiberG100g: 1.0, proteinG100g: 4.5, fruitsVegNutsPct: 20, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.panerabreadathome.com/products/soups/broccoli-cheddar-soup",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(clam\s+chowder|new\s+england.*chowder|corn\s+chowder|potato\s+chowder|seafood\s+chowder|lobster\s+bisque|tomato\s+bisque|loaded\s+baked\s+potato\s+soup)\b/i,
    brand: "Representative Deli Soup Formulation",
    title: "New England Style Clam Chowder (Representative Formulation)",
    ingredients: "Light Cream (Milk, Cream), Potatoes, Fish Stock (Water, Cod Bones, Haddock Bones, Onions, Celery, Black Pepper, Thyme, Mustard Seed, Bay Leaves), Sea Clams (Sea Clams, Water), Chopped Cockle (Clam Meat), Onions, Wheat Flour, Soybean Oil, Butter (Cream, Salt), Clam Broth (Dehydrated Clam Broth, Maltodextrin), Sea Salt, Celery, Salt Pork (Pork, Sea Salt), Black Pepper, Worcestershire Sauce (Distilled White Vinegar, Molasses, Sugar, Water, Salt, Onions, Anchovies, Garlic, Cloves, Tamarind Extract, Natural Flavorings, Chili Pepper Extract), Garlic.",
    nutrition: { caloriesKcal100g: 115, sugarsG100g: 1.5, saturatedFatG100g: 3.5, sodiumMg100g: 350, fiberG100g: 0.9, proteinG100g: 5.2, fruitsVegNutsPct: 25, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171599/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bmaruchan\b/i,
    brand: "Maruchan",
    title: "Maruchan Ramen Noodle Soup Chicken Flavor",
    ingredients: "Enriched Wheat Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Vegetable Oil (Contains One or More of the Following: Canola, Cottonseed, Palm) Preserved by TBHQ, Salt, Monosodium Glutamate, Maltodextrin, Hydrolyzed Corn, Wheat and Soy Protein, Dehydrated Vegetables (Onion, Garlic, Chive), Sugar, Spices, Potassium Carbonate, Sodium (Mono, Hexameta, and/or Tripoly) Phosphate, Sodium Carbonate, Soy Sauce (Water, Wheat, Soybeans, Salt), Disodium Inosinate, Disodium Guanylate, Chicken Broth, Caramel Color, Yellow 5, Yellow 6, Silicon Dioxide (Anti-Caking Agent), Natural and Artificial Flavor, Citric Acid, Lactose.",
    nutrition: { caloriesKcal100g: 442, sugarsG100g: 2.3, saturatedFatG100g: 8.2, sodiumMg100g: 1830, fiberG100g: 2.3, proteinG100g: 9.3, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.maruchan.com/products/ramen/chicken-flavor/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(buldak|samyang)\b/i,
    brand: "Samyang",
    title: "Samyang Buldak Hot Chicken Flavor Ramen",
    ingredients: "Noodle: Wheat Flour, Modified Tapioca Starch, Refined Palm Oil, Wheat Gluten, Salt, Emulsifier (Soy Lecithin), Acidity Regulator (Potassium Carbonate, Sodium Carbonate, Sodium Phosphate Dibasic, Citric Acid), Thickener (Guar Gum), Green Tea Flavor Oil, Riboflavin. Soup: Water, Artificial Chicken Flavor Powder (Yeast Extract, Dextrin, Artificial Flavor, Sugar, Monosodium Glutamate), Soy Sauce, Sugar, Chili Pepper Powder, Soybean Oil, Onion, Red Pepper Powder, Red Pepper Seed Oil, Yeast Powder, Garlic, Modified Potato Starch, Decolorized Chili Extract, Paprika Extract, Black Pepper Powder, Curry Powder. Flake: Roasted Sesame, Roasted Laver.",
    nutrition: { caloriesKcal100g: 393, sugarsG100g: 5.0, saturatedFatG100g: 5.7, sodiumMg100g: 914, fiberG100g: 2.9, proteinG100g: 8.6, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://samyangamerica.com/buldak-original/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(lotus\s+foods|organic|mike'?s\s+mighty\s+good|buldak|samyang)\b).*\b(top\s+ramen|nissin|cup\s+noodles?|shin\s+ramyun|indomie|nongshim|sapporo\s+ichiban|instant\s+ramen|ramen\s+noodle\s+soup|ramen\s+noodles?)\b/i,
    brand: "Representative Ramen Formulation",
    title: "Instant Ramen Noodle Soup (Representative Formulation)",
    ingredients: "Enriched Wheat Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Vegetable Oil (Contains One or More of the Following: Canola, Cottonseed, Palm) Preserved by TBHQ, Salt, Monosodium Glutamate, Maltodextrin, Hydrolyzed Corn, Wheat and Soy Protein, Dehydrated Vegetables (Onion, Garlic, Chive), Sugar, Spices, Potassium Carbonate, Sodium (Mono, Hexameta, and/or Tripoly) Phosphate, Sodium Carbonate, Soy Sauce (Water, Wheat, Soybeans, Salt), Disodium Inosinate, Disodium Guanylate, Chicken Broth, Caramel Color, Yellow 5, Yellow 6, Silicon Dioxide (Anti-Caking Agent), Natural and Artificial Flavor, Citric Acid, Lactose.",
    nutrition: { caloriesKcal100g: 442, sugarsG100g: 2.3, saturatedFatG100g: 8.2, sodiumMg100g: 1830, fiberG100g: 2.3, proteinG100g: 9.3, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/168928/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bcampbell'?s\b.*\bchicken\s+noodle\b/i,
    brand: "Campbell's",
    title: "Campbell's Condensed Chicken Noodle Soup",
    keywords: ["condensed", "soup"],
    ingredients: "Chicken Stock, Enriched Egg Noodles (Wheat Flour, Eggs, Egg Whites, Niacin, Ferrous Sulfate, Thiamine Mononitrate, Riboflavin, Folic Acid), Chicken Meat, Contains Less than 2% of: Salt, Vegetable Oil, Potato Starch, Chicken Fat, Monosodium Glutamate, Water, Beta Carotene for Color, Yeast Extract, Dehydrated Chicken Broth, Flavoring, Dehydrated Chicken, Soy Protein Isolate, Sodium Phosphate, Onion Extract, Dehydrated Garlic.",
    nutrition: { caloriesKcal100g: 50, sugarsG100g: 0.8, saturatedFatG100g: 0.4, sodiumMg100g: 742, fiberG100g: 0.8, proteinG100g: 2.5, fruitsVegNutsPct: 5, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.campbells.com/products/condensed/chicken-noodle-soup/",
    verifiedAt: "2026-11-12",
  },
  {
    match: /^(?!.*\b(amy'?s|pacific\s+foods|organic|kettle\s*&\s*fire|ramen|maruchan|nissin)\b).*\b(progresso|chunky\s+soup|chicken\s+noodle\s+soup|tomato\s+soup|cream\s+of\s+(mushroom|chicken|celery)|beef\s+stew|vegetable\s+beef\s+soup|minestrone\s+soup|italian\s+wedding\s+soup)\b/i,
    brand: "Representative Soup Formulation",
    title: "Homestyle Canned Soup (Representative Formulation)",
    ingredients: "Chicken Stock, Enriched Egg Noodles (Wheat Flour, Egg Whites, Eggs, Niacin, Ferrous Sulfate, Thiamine Mononitrate, Riboflavin, Folic Acid), Cooked Chicken Meat, Carrots, Celery, Contains Less than 2% of: Modified Food Starch, Salt, Chicken Fat, Monosodium Glutamate, Yeast Extract, Soy Protein Isolate, Sodium Phosphate, Potassium Chloride, Natural Flavor, Beta Carotene for Color, Disodium Inosinate, Disodium Guanylate.",
    nutrition: { caloriesKcal100g: 55, sugarsG100g: 1.0, saturatedFatG100g: 0.6, sodiumMg100g: 390, fiberG100g: 0.6, proteinG100g: 2.5, fruitsVegNutsPct: 10, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171590/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(salad\s+kit|chopped\s+kit|caesar\s+salad\s+kit|ranch\s+salad\s+kit|southwest\s+salad\s+kit|asian\s+salad\s+kit|sweet\s+kale\s+kit)\b/i,
    brand: "Representative Salad Kit Formulation",
    title: "Salad Kit with Dressing Packet (Representative Formulation)",
    ingredients: "Romaine Lettuce, Dressing (Soybean and/or Canola Oil, Water, Parmesan Cheese, Egg Yolk, Distilled Vinegar, Salt, Sugar, Garlic, Lemon Juice Concentrate, Natural Flavor, Xanthan Gum), Croutons (Enriched Wheat Flour, Sunflower Oil, Salt, Yeast, Garlic Powder), Parmesan Cheese.",
    nutrition: { caloriesKcal100g: 140, sugarsG100g: 3.0, saturatedFatG100g: 2.5, sodiumMg100g: 310, fiberG100g: 2.0, proteinG100g: 3.5, fruitsVegNutsPct: 65, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/173590/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(kit|caesar|ranch|dressing|macaroni|potato\s+salad|chicken\s+salad|tuna\s+salad|egg\s+salad|pasta\s+salad|ham\s+salad|seafood\s+salad)\b).*\b(romaine\s+salad|salad\s+blend|classic\s+romaine|classic\s+iceberg|spring\s+mix|baby\s+spinach|spinach\s+blend|half\s*(&|and)\s*half\s+salad|shredded\s+lettuce|iceberg\s+lettuce|romaine\s+hearts|leaf\s+lettuce|butter\s+lettuce|arugula|kale\s+greens|coleslaw\s+mix|tri[- ]?color\s+slaw|garden\s+salad|field\s+greens|mixed\s+greens|salad\s+greens|sweet\s+butter\s+salad)\b/i,
    brand: "Fresh Produce",
    title: "100% Fresh Washed Salad Greens",
    keywords: ["romaine", "iceberg", "spring", "mix", "baby", "spinach", "blend", "shredded", "lettuce", "hearts", "leaf", "butter", "arugula", "kale", "coleslaw", "slaw", "garden", "field", "mixed", "tri", "color", "sweet"],
    ingredients: "100% Fresh Whole Produce: Romaine Lettuce, Carrots, Red Cabbage.",
    nutrition: { caloriesKcal100g: 18, sugarsG100g: 1.5, saturatedFatG100g: 0, sodiumMg100g: 18, fiberG100g: 2.2, proteinG100g: 1.3, fruitsVegNutsPct: 100, nutriScoreGrade: "a", isWholeFood: true },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/169247/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(chips?|crisps?|crispy|fries|fried|tots|waffles?|pie|casserole|canned|syrup|candied|mashed|puffs?|crackers?|pur[eé]e|baby\s+food)\b).*\b(fresh\s+whole\s+sweet\s+potato(?:es)?|whole\s+sweet\s+potato(?:es)?|fresh\s+sweet\s+potato(?:es)?|yams?\s*\(sweet\s+potatoes?\)|sweet\s+potato(?:es)?\b)/i,
    brand: "Fresh Produce",
    title: "Fresh Whole Sweet Potato",
    keywords: ["yams", "yam"],
    ingredients: "100% Fresh Whole Sweet Potato (Single-Ingredient Whole Produce).",
    nutrition: { caloriesKcal100g: 86, sugarsG100g: 4.2, saturatedFatG100g: 0, sodiumMg100g: 55, fiberG100g: 3.0, proteinG100g: 1.6, fruitsVegNutsPct: 100, nutriScoreGrade: "a", isWholeFood: true, isOrganic: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/168482/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(sweet|chips?|crisps?|crispy|fries|fried|tots|hash\s*browns?|instant|mashed|flakes?|au\s+gratin|scalloped|salad|soup|chowder|bread|rolls?|buns?|gnocchi|starch|flour|vodka|canned|roasted|seasoned)\b).*\b(fresh\s+whole\s+(?:russet|idaho|yukon\s+gold|gold|yellow|red|white|baking)?\s*potato(?:es)?|(?:russet|idaho|yukon\s+gold|yellow|red|white|baking)\s+potato(?:es)?|potatoes?,?\s+butter|butter\s+potatoes?)\b/i,
    brand: "Fresh Produce",
    title: "Fresh Whole Potatoes",
    keywords: ["russet", "idaho", "yukon", "gold", "yellow", "red", "white", "baking", "butter"],
    ingredients: "100% Fresh Whole Potatoes (Single-Ingredient Whole Produce).",
    nutrition: { caloriesKcal100g: 77, sugarsG100g: 0.8, saturatedFatG100g: 0, sodiumMg100g: 6, fiberG100g: 2.2, proteinG100g: 2.0, fruitsVegNutsPct: 100, nutriScoreGrade: "a", isWholeFood: true, isOrganic: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/170026/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(instant\s+mashed\s+potato\w*|potato\s+flakes?|mashed\s+potato\w*\s+mix|idahoan|betty\s+crocker.*potato\w*|great\s+value.*instant\s+mashed|au\s+gratin\s+potato\w*|scalloped\s+potato\w*)\b/i,
    brand: "Representative Instant Potato Formulation",
    title: "Instant Mashed Potatoes (Representative Formulation)",
    ingredients: "Potatoes, Mono- and Diglycerides, Sodium Acid Pyrophosphate (Preservative), Sodium Bisulfite (Preservative), Citric Acid (Preservative).",
    nutrition: { caloriesKcal100g: 355, sugarsG100g: 2.5, saturatedFatG100g: 1.2, sodiumMg100g: 490, fiberG100g: 5.5, proteinG100g: 7.5, fruitsVegNutsPct: 60, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://idahoan.com/products/idahoan-original-mashed-potatoes/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(ore[- ]?ida|golden\s+crinkles|crispy\s+crowns)\b/i,
    brand: "Ore-Ida",
    title: "Golden Crinkles French Fried Potatoes",
    keywords: ["fries", "crispy", "crowns"],
    ingredients: "Potatoes, Vegetable Oil (Canola, Soybean, and/or Sunflower Oil), Salt, Disodium Dihydrogen Pyrophosphate (to Retain Natural Color), Dextrose.",
    nutrition: { caloriesKcal100g: 155, sugarsG100g: 0.8, saturatedFatG100g: 1.2, sodiumMg100g: 340, fiberG100g: 2.4, proteinG100g: 2.4, fruitsVegNutsPct: 75, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.myfoodandfamily.com/brands/ore-ida/product/00013120000836",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(french\s+fries|crinkle\s+cut\s+fries|waffle\s+fries|steak\s+fries|shoestring\s+fries|curly\s+fries|seasoned\s+fries|tater\s+tots?|hash\s*browns?)\b/i,
    brand: "Representative Frozen Potato Formulation",
    title: "Frozen French Fried Potatoes and Tater Tots (Representative Formulation)",
    ingredients: "Potatoes, Vegetable Oil (Canola, Soybean, and/or Sunflower Oil), Salt, Disodium Dihydrogen Pyrophosphate (to Retain Natural Color), Dextrose.",
    nutrition: { caloriesKcal100g: 155, sugarsG100g: 0.8, saturatedFatG100g: 1.2, sodiumMg100g: 340, fiberG100g: 2.4, proteinG100g: 2.4, fruitsVegNutsPct: 75, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/170437/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(crispy\s+fried\s+onions?|french'?s.*onions?|french\s+fried\s+onions?|fried\s+onions?|onion\s+rings?)\b/i,
    brand: "French's",
    title: "Original Crispy Fried Onions",
    ingredients: "Onions, Palm Oil, Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Soy Flour, Salt, Dextrose.",
    nutrition: { caloriesKcal100g: 571, sugarsG100g: 5.0, saturatedFatG100g: 15.5, sodiumMg100g: 800, fiberG100g: 2.8, proteinG100g: 5.2, fruitsVegNutsPct: 20, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.mccormick.com/frenchs/products/crispy-fried-veggies/original-crispy-fried-onions",
    verifiedAt: "2026-11-08",
  },
  {
    match: /(?<!\bvitamin\s+)(?<!\bgrade\s+)\ba(?:\.\s*|-?)1\.?(?!\s*%|\w).*\b(?:steak\s+)?sauce\b/i,
    brand: "A.1.",
    title: "Original Steak Sauce",
    ingredients: "Tomato Puree (Water, Tomato Paste), Vinegar, Corn Syrup, Salt, Raisin Paste, Crushed Orange Puree, Spice, Dried Garlic, Caramel Color, Dried Onions, Potassium Sorbate (To Preserve Freshness), Xanthan Gum, Celery Seed.",
    nutrition: { caloriesKcal100g: 88, sugarsG100g: 17.6, saturatedFatG100g: 0, sodiumMg100g: 1470, fiberG100g: 0.5, proteinG100g: 1.0, fruitsVegNutsPct: 30, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.myfoodandfamily.com/brands/a1/product/00054400000016",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(steak[- ]?umm\w*)\b/i,
    brand: "Steak-umm",
    title: "100% Beef Sliced Steaks",
    ingredients: "100% Beef.",
    nutrition: { caloriesKcal100g: 280, sugarsG100g: 0, saturatedFatG100g: 9.5, sodiumMg100g: 65, fiberG100g: 0, proteinG100g: 17.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.steakumm.com/products/100-beef/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(philly\s+steak|shaved\s+beef\s+steak)\b/i,
    brand: "Representative Sliced Beef Formulation",
    title: "Seasoned Shaved Beef Steak (Representative Formulation)",
    ingredients: "Beef, Water, Salt, Sodium Phosphate.",
    nutrition: { caloriesKcal100g: 280, sugarsG100g: 0, saturatedFatG100g: 9.5, sodiumMg100g: 310, fiberG100g: 0, proteinG100g: 17.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/174036/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bdel\s+monte\b.*\bpeaches\b.*\bheavy\s+syrup\b/i,
    brand: "Del Monte",
    title: "Sliced Peaches in Heavy Syrup",
    keywords: ["yellow", "cling", "canned"],
    ingredients: "Peaches, Water, High Fructose Corn Syrup, Corn Syrup, Sugar.",
    nutrition: { caloriesKcal100g: 74, sugarsG100g: 17.5, saturatedFatG100g: 0, sodiumMg100g: 6, fiberG100g: 1.2, proteinG100g: 0.4, fruitsVegNutsPct: 55, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.delmonte.com/products/fruits/peaches/sliced-yellow-cling-peaches-heavy-syrup",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(beef|turkey|jumbo|bun\s+length|cheese|cheddar|jalapeno|jalapeño|polish|smoked\s+sausage|bologna|bacon|corn\s+dogs?)\b).*\bbar[- ]?s\b.*\b(?:classic\s+)?(?:franks?|hot\s+dogs?|wieners?)\b/i,
    brand: "Bar-S",
    title: "Bar-S Classic Franks",
    keywords: ["bars", "bar", "classic", "franks", "hot", "dogs", "hotdog", "wieners", "chicken", "pork"],
    ingredients:
      "Mechanically Separated Chicken, Water, Pork, Dextrose, Modified Corn Starch, Salt, Contains 2% or Less of: Beef, Corn Syrup, Flavorings, Sodium Phosphates, Potassium Lactate, Potassium Acetate, Sodium Diacetate, Sodium Erythorbate, Oleoresin of Paprika, Sodium Nitrite, Smoke Flavoring.",
    nutrition: { caloriesKcal100g: 262, sugarsG100g: 4.8, saturatedFatG100g: 7.1, sodiumMg100g: 1024, fiberG100g: 0, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.walmart.com/ip/Bar-S-Classic-Franks-12-oz/10290749",
    verifiedAt: "2026-11-17",
  },
  {
    match: /^(?!.*\b(chocolate|brownie|ice\s+cream|coffee\s+creamer)\b).*\blittle\s+debbie\b.*\b(?:vanilla\s+)?christmas\s+tree\s+(?:snack\s+)?cakes?\b/i,
    brand: "Little Debbie",
    title: "Little Debbie Vanilla Christmas Tree Cakes",
    keywords: ["little", "debbie", "christmas", "tree", "cakes", "snack", "vanilla", "holiday"],
    ingredients:
      "Sugar, Corn Syrup, Enriched Bleached Flour (Wheat Flour, Niacin, Reduced Iron, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Palm and Palm Kernel Oil, Palm and Soybean Oils with TBHQ and Citric Acid to Protect Flavor, Dextrose, Soybean Oil, Corn Starch, Green Sugar Crystals (Sugar, Confectioner's Glaze, Yellow 5 Lake, Blue 1 Lake, Carnauba Wax), Dried Egg Whites, Whey, Baking Soda, Sodium Aluminum Phosphate, Salt, Soy Lecithin, Mono- and Diglycerides, Sorbitan Monostearate, Titanium Dioxide, Sorbic Acid, Red 40 Lake, Polysorbate 60, Natural and Artificial Flavors, Polysorbate 80, Annatto Extract, Turmeric Extract, Soy Flour.",
    nutrition: { caloriesKcal100g: 435, sugarsG100g: 42.4, saturatedFatG100g: 10.6, sodiumMg100g: 176, fiberG100g: 0, proteinG100g: 1.2, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.littledebbie.com/christmas-tree-cakes",
    verifiedAt: "2026-11-17",
  },
  {
    match: /^(?!.*\bchocolate\b).*\blittle\s+debbie\b.*\bchristmas\b.*\bold\s+fashioned\s+(?:snack\s+cake\s+)?(?:donuts?|doughnuts?)\b/i,
    brand: "Little Debbie",
    title: "Little Debbie Christmas Old Fashioned Donuts",
    keywords: ["little", "debbie", "christmas", "old", "fashioned", "donuts", "doughnuts", "glazed", "snack", "cake", "holiday"],
    ingredients:
      "Palm Oil, Sugar, Enriched Bleached Flour (Wheat Flour, Barley Malt, Niacin, Reduced Iron, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Modified Wheat Starch, Toppers (Sugar, Corn Starch, Palm and Palm Kernel Oil, Natural and Artificial Flavors, Dextrin, Soy Lecithin, Yellow 5 Lake, Confectioner's Glaze, Blue 1 Lake, Salt, Carnauba Wax, Red 40 Lake, Yellow 6 Lake), Soybean Oil, Glycerin, Dextrose, Nonfat Dry Milk, Sodium Acid Pyrophosphate, Baking Soda, Dried Egg Yolks, Corn Starch, Salt, Calcium Carbonate, Calcium Sulfate, Potassium Sorbate, Spices, Agar, Mono- and Diglycerides, Propylene Glycol Monostearate, Guar Gum, Locust Bean Gum, Artificial Flavor, Xanthan Gum, Disodium Phosphate, Sunflower Oil, Soy Lecithin, Soy Flour, Enzymes, Whey, Dried Egg Whites.",
    nutrition: { caloriesKcal100g: 520, sugarsG100g: 34.2, saturatedFatG100g: 15.1, sodiumMg100g: 315, fiberG100g: 0.7, proteinG100g: 2.7, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.target.com/p/little-debbie-big-pack-christmas-old-fashioned-donuts/-/A-1013641628",
    verifiedAt: "2026-11-17",
  },
  {
    match: /^(?!.*\b(chocolate|christmas|powdered|cinnamon|apple)\b).*\blittle\s+debbie\b.*\bold\s+fashioned\s+(?:snack\s+cake\s+)?(?:donuts?|doughnuts?)\b/i,
    brand: "Little Debbie",
    title: "Little Debbie Old Fashioned Donuts",
    keywords: ["little", "debbie", "old", "fashioned", "donuts", "doughnuts", "glazed", "snack", "cake"],
    ingredients:
      "Palm Oil, Sugar, Enriched Bleached Flour (Wheat Flour, Barley Malt, Niacin, Reduced Iron, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Modified Wheat Starch, Soybean Oil, Dextrose, Nonfat Dry Milk, Sodium Acid Pyrophosphate, Baking Soda, Dried Egg Yolks, Corn Starch, Salt, Calcium Carbonate, Calcium Sulfate, Potassium Sorbate, Spices, Agar, Mono- and Diglycerides, Propylene Glycol Monostearate, Guar Gum, Locust Bean Gum, Artificial Flavor, Xanthan Gum, Disodium Phosphate, Sunflower Oil, Soy Lecithin, Soy Flour, Enzymes, Whey, Dried Egg Whites.",
    nutrition: { caloriesKcal100g: 493, sugarsG100g: 34.2, saturatedFatG100g: 15.1, sodiumMg100g: 329, fiberG100g: 1.4, proteinG100g: 2.7, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.kingsoopers.com/p/snack-cakes-little-debbie-big-pack-old-fashioned-donuts/0002430004336",
    verifiedAt: "2026-11-17",
  },
  {
    match: /\bjackson'?s\b.*\bsweet\s+potato\b.*\b(jalapeno|jalapeño)\b|\bjackson'?s\b.*\b(jalapeno|jalapeño)\b.*\bsweet\s+potato\b/i,
    brand: "Jackson's",
    title: "Jackson's Spicy Jalapeno Sweet Potato Chips in Avocado Oil",
    keywords: ["jacksons", "sweet", "potato", "spicy", "jalapeno", "kettle", "chips", "avocado", "oil", "gluten", "free", "vegan"],
    ingredients:
      "Sweet Potatoes, Avocado Oil, Spicy Jalapeno Seasoning (Maltodextrin, Salt, Onion Powder, Jalapeno Pepper Powder, Spices, Dextrose, Dehydrated Parsley, Garlic Powder, Yeast Extract, Extractives of Paprika, Sea Salt, Natural Flavor).",
    nutrition: { caloriesKcal100g: 536, sugarsG100g: 10.7, saturatedFatG100g: 3.6, sodiumMg100g: 786, fiberG100g: 7.1, proteinG100g: 3.6, fruitsVegNutsPct: 65, isWholeFood: false },
    sourceUrl: "https://snackjacksons.com/products/spicy-jalapeno-sweet-potato-chips-in-avocado-oil-5oz-8-bags",
    verifiedAt: "2026-11-17",
  },
  {
    match: /^(?!.*\b(jalapeno|jalapeño|spicy|bbq|barbecue|ranch|cheddar|garlic|cinnamon|habanero)\b).*\bjackson'?s\b.*\bsweet\s+potato\s+(?:kettle\s+)?chips\b/i,
    brand: "Jackson's",
    title: "Jackson's Sea Salt Sweet Potato Chips in Avocado Oil",
    keywords: ["jacksons", "sweet", "potato", "sea", "salt", "kettle", "chips", "avocado", "oil", "gluten", "free", "vegan"],
    ingredients: "Sweet Potatoes, Avocado Oil, Sea Salt.",
    nutrition: { caloriesKcal100g: 536, sugarsG100g: 14.3, saturatedFatG100g: 3.6, sodiumMg100g: 393, fiberG100g: 7.1, proteinG100g: 3.6, fruitsVegNutsPct: 70, isWholeFood: false },
    sourceUrl: "https://snackjacksons.com/products/sea-salt-sweet-potato-chips-in-avocado-oil-5oz-8-bags",
    verifiedAt: "2026-11-17",
  },
  {
    match: /\bdrizzilicious\b.*\bbirthday\s+cake\b/i,
    brand: "Drizzilicious",
    title: "Drizzilicious Birthday Cake Gluten Free Mini Rice Cake Bites",
    keywords: ["drizzilicious", "birthday", "cake", "mini", "rice", "cakes", "bites", "crisps", "gluten", "free", "vegan", "reimagined"],
    ingredients:
      "White Rice Flour, Cane Sugar, Corn Flour, Tapioca Starch, Corn Starch, Palm Kernel Oil, Avocado Oil, Natural Flavors, Whole Quinoa, Chia, Flax, Salt, Acacia Gum, Fruit Juice (Color), Annatto and Turmeric Extracts (Color), Carnauba Wax.",
    nutrition: { caloriesKcal100g: 429, sugarsG100g: 23.8, saturatedFatG100g: 7.1, sodiumMg100g: 310, fiberG100g: 2.4, proteinG100g: 4.8, fruitsVegNutsPct: 0, isWholeFood: false },
    sourceUrl: "https://drizzilicious.com/products/birthday-cake",
    verifiedAt: "2026-11-17",
  },
  {
    match: /^(?!.*\b(no\s+sugar\s+added|sugar[\s-]*free|keto|mini|chocolate|banana|pistachio|lemon|corn|gluten[\s-]*free)\b).*\bmarketside\b.*\bblueberry\b.*\bmuffins?\b/i,
    brand: "Marketside",
    title: "Marketside Baked Blueberry Streusel Muffins",
    keywords: ["marketside", "fresh", "baked", "blueberry", "streusel", "muffins", "bakery"],
    ingredients:
      "Enriched Wheat Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Sugar, Blueberries, Soybean Oil, Eggs, Water, Cultured Buttermilk (Nonfat Milk, Bacterial Culture), Egg Whites, Margarine (Soybean Oil, Palm Oil, Modified Palm Oil, Water, Canola Oil, Salt, Whey, Monoglycerides, Soy Lecithin, Citric Acid, Natural Flavor, Annatto Extract, Turmeric Color, Vitamin A Palmitate, Vitamin D3), Baking Soda, Sodium Aluminum Phosphate, Monocalcium Phosphate, Cultured Wheat Flour, Salt, Dextrose, Whey, Mono- and Diglycerides, Artificial Flavor, Sodium Stearoyl Lactylate, Cellulose Gum, Xanthan Gum, Citric Acid, Soy Lecithin.",
    nutrition: { caloriesKcal100g: 354, sugarsG100g: 23.2, saturatedFatG100g: 3.0, sodiumMg100g: 343, fiberG100g: 1.0, proteinG100g: 5.1, fruitsVegNutsPct: 2, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.walmart.com/ip/Marketside-Baked-Blueberry-Streusel-Muffins-Soft-Moist-14-oz-4-pack/19758064",
    verifiedAt: "2026-11-17",
  },
  {
    match: /\b(cake\s+roll|pumpkin\s+cake|swiss\s+roll|snack\s+cakes?|little\s+debbie|hostess|twinkies?|ding\s+dongs?|ho\s*hos?|zebra\s+cakes?|entenmann'?s|freshness\s+guaranteed.*(cake|pie|cupcake|brownie|cookie|muffin|roll)|bake\s+shop.*(cake|pie|cupcake|brownie|cookie|muffin))\b/i,
    brand: "Representative Bakery Formulation",
    title: "Bakery Cake Roll with Creme Filling (Representative Formulation)",
    ingredients: "Sugar, Enriched Wheat Flour Bleached (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Eggs, Water, Pumpkin or Fruit Puree, High Fructose Corn Syrup, Soybean Oil, Palm Oil, Corn Syrup, Contains 2% or Less of: Modified Corn Starch, Mono- and Diglycerides, Polysorbate 60, Sodium Propionate (Preservative), Potassium Sorbate (Preservative), Sodium Acid Pyrophosphate, Soy Lecithin, Natural and Artificial Flavor, Spices, Yellow 5, Yellow 6, Red 40.",
    nutrition: { caloriesKcal100g: 375, sugarsG100g: 36, saturatedFatG100g: 7.5, sodiumMg100g: 330, fiberG100g: 1.0, proteinG100g: 3.8, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/175021/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(cherry\s+garcia)\b/i,
    brand: "Ben & Jerry's",
    title: "Cherry Garcia Ice Cream",
    ingredients: "Cream, Skim Milk, Liquid Sugar (Sugar, Water), Water, Cherries, Sugar, Egg Yolks, Coconut Oil, Cocoa (Processed with Alkali), Fruit and Vegetable Concentrates (Color), Cocoa Powder, Guar Gum, Natural Flavors, Lemon Juice Concentrate, Carrageenan, Milk Fat, Soy Lecithin.",
    nutrition: { caloriesKcal100g: 256, sugarsG100g: 24.0, saturatedFatG100g: 10.0, sodiumMg100g: 60, fiberG100g: 0.9, proteinG100g: 4.1, fruitsVegNutsPct: 12, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.benjerry.com/flavors/cherry-garcia-ice-cream",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(haagen[- ]?dazs|häagen[- ]?dazs)\b/i,
    brand: "Häagen-Dazs",
    title: "Vanilla Dairy Ice Cream",
    ingredients: "Cream, Skim Milk, Cane Sugar, Egg Yolks, Vanilla Extract.",
    nutrition: { caloriesKcal100g: 250, sugarsG100g: 21.0, saturatedFatG100g: 11.0, sodiumMg100g: 55, fiberG100g: 0, proteinG100g: 4.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.icecream.com/us/en/brands/haagen-dazs/products/vanilla-ice-cream",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(half[- ]?baked|tonight\s+dough|chunky\s+monkey|phish\s+food|americone\s+dream|ben\s*&\s*jerry'?s?)\b/i,
    brand: "Ben & Jerry's",
    title: "Half Baked Ice Cream",
    ingredients: "Cream, Skim Milk, Liquid Sugar (Sugar, Water), Water, Sugar, Wheat Flour, Brown Sugar, Egg Yolks, Butter, Soybean Oil, Coconut Oil, Cocoa (Processed with Alkali), Eggs, Guar Gum, Salt, Vanilla Extract, Carrageenan, Soy Lecithin, Natural Flavor.",
    nutrition: { caloriesKcal100g: 270, sugarsG100g: 25, saturatedFatG100g: 10.5, sodiumMg100g: 85, fiberG100g: 0.9, proteinG100g: 4.2, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.benjerry.com/flavors/half-baked-ice-cream",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(alec'?s|cosmic\s+bliss|organic\s+tahitian)\b).*\b(breyers|blue\s+bell|talenti|edy'?s|dreyer'?s|klondike|drumstick|sundae\s+shoppe|belmont.*ice\s+cream|great\s+value.*ice\s+cream|ice\s+cream|gelato)\b/i,
    brand: "Representative Dairy Ice Cream Formulation",
    title: "Dairy Ice Cream (Representative Formulation)",
    ingredients: "Cream, Skim Milk, Sugar, Corn Syrup, Egg Yolks, Guar Gum, Locust Bean Gum, Carrageenan, Natural Flavor, Annatto (Color).",
    nutrition: { caloriesKcal100g: 235, sugarsG100g: 22, saturatedFatG100g: 9.5, sodiumMg100g: 65, fiberG100g: 0, proteinG100g: 3.8, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/167575/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(just\s+bare)\b.*\b(chicken|strips?|nuggets?|bites?|fillets?|tenders?|breast)\b|\blightly\s+breaded\s+chicken\s+breast\s+strips\b/i,
    brand: "Just Bare",
    title: "Lightly Breaded Chicken Breast Strips",
    ingredients: "Boneless Skinless Chicken Breast with Rib Meat, Water, Wheat Flour, Contains 2% or Less of: Yellow Corn Flour, Sea Salt, Rice Starch, Spices, Dried Garlic, Dried Onion, Paprika, Yeast, Cream of Tartar, Sodium Bicarbonate.",
    nutrition: { caloriesKcal100g: 175, sugarsG100g: 1.0, saturatedFatG100g: 1.5, sodiumMg100g: 380, fiberG100g: 1.0, proteinG100g: 18.5, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.justbarefoods.com/product/lightly-breaded-chicken-breast-strips/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(bacon|ground|burger|burgers|patty|patties|sausage|meatball|meatballs|deli|sliced|franks?|hot\s+dogs?|jerky|smoked|tenderloin|cutlets?)\b).*\b(butterball)\b.*\b(turkey|whole\s+turkey|young\s+turkey|breast)\b/i,
    brand: "Butterball",
    title: "All Natural Whole Turkey (With Salt Solution)",
    keywords: ["frozen", "young"],
    ingredients: "Turkey, Contains up to 8% of a Solution of Water, Salt, Spices, and Natural Flavor for Tenderness and Juiciness.",
    nutrition: { caloriesKcal100g: 160, sugarsG100g: 0, saturatedFatG100g: 3.5, sodiumMg100g: 310, fiberG100g: 0, proteinG100g: 19.0, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.butterball.com/products/whole-turkeys/all-natural-frozen-whole-turkey",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(golden\s+sweet.*corn|whole\s+kernel\s+corn|sweet\s+corn.*can|del\s+monte.*corn|green\s+giant.*corn|great\s+value.*corn|happy\s+harvest.*corn)\b/i,
    brand: "Canned Vegetables",
    title: "Golden Sweet Whole Kernel Corn",
    ingredients: "Corn, Water, Sugar, Salt.",
    nutrition: { caloriesKcal100g: 71, sugarsG100g: 5.3, saturatedFatG100g: 0.2, sodiumMg100g: 230, fiberG100g: 1.8, proteinG100g: 2.4, fruitsVegNutsPct: 85, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://www.delmonte.com/products/vegetables/corn/golden-sweet-whole-kernel-corn",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(drink|cocktail|sunny\s*d|tang)\b).*\b(100%\s+(pure\s+)?(organic\s+)?(orange|apple|grape|cranberry|grapefruit)\s+juice|orange\s+juice|simply\s+orange|tropicana|uncle\s+matt'?s|nature'?s\s+nectar.*orange)\b/i,
    brand: "100% Fruit Juice",
    title: "100% Pasteurized Orange Juice",
    ingredients: "100% Pasteurized Orange Juice (Concentrated Natural Liquid Fruit Sugars — 0g Fiber).",
    nutrition: { caloriesKcal100g: 45, sugarsG100g: 9.2, saturatedFatG100g: 0, sodiumMg100g: 2, fiberG100g: 0.2, proteinG100g: 0.7, fruitsVegNutsPct: 100, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/169098/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bsiete\b.*\b(tortilla\s+chips?|chips?)\b/i,
    brand: "Siete",
    title: "Grain-Free Sea Salt Tortilla Chips",
    ingredients: "Cassava Flour, Avocado Oil, Coconut Flour, Chia Seed, Sea Salt.",
    nutrition: { caloriesKcal100g: 464, sugarsG100g: 0, saturatedFatG100g: 3.5, sodiumMg100g: 265, fiberG100g: 6.5, proteinG100g: 3.6, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://sietefoods.com/products/sea-salt-grain-free-tortilla-chips",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bsiete\b.*\b(tortillas?|wraps?)\b|\b(tortillas?|wraps?)\b.*\bsiete\b/i,
    brand: "Siete",
    title: "Almond Flour Tortillas",
    ingredients: "Almond Flour, Tapioca Flour, Water, Xanthan Gum, Sea Salt.",
    nutrition: { caloriesKcal100g: 290, sugarsG100g: 2.0, saturatedFatG100g: 1.5, sodiumMg100g: 330, fiberG100g: 5.0, proteinG100g: 9.0, fruitsVegNutsPct: 45, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://sietefoods.com/products/almond-flour-tortillas",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(chips?|strips?|tostadas?|shells?|corn|maiz|whole\s+wheat|spinach|herb|sun[- ]?dried|tomato|jalapeno|cheddar|habanero|chipotle|organic)\b)(?=.*\bmission\b)(?=.*\bcarb\s+balance\b)(?=.*\btortillas?\b).*/i,
    brand: "Mission",
    title: "Mission Carb Balance Soft Taco Flour Tortillas",
    ingredients: "Water, Modified Wheat Starch, Wheat Flour, Vital Wheat Gluten, Wheat Gluten Isolate, Vegetable Shortening (Interesterified and Hydrogenated Soybean Oils), Salt, Calcium Propionate (to Maintain Freshness), Distilled Monoglycerides, Sodium Acid Pyrophosphate, Baking Soda, Sorbic Acid (to Maintain Freshness), Fumaric Acid, Cellulose Gum, Steviol Glycosides.",
    nutrition: { caloriesKcal100g: 163, sugarsG100g: 0, saturatedFatG100g: 3.5, sodiumMg100g: 767, fiberG100g: 34.9, proteinG100g: 14.0, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false, isOrganic: false },
    sourceUrl: "https://www.missionfoods.com/products/carb-balance-soft-taco-flour-tortillas/",
    verifiedAt: "2026-11-12",
  },
  {
    match: /^(?!.*\b(chips?|strips?|tostadas?|shells?|corn|maiz|carb\s+balance|zero\s+net|keto|low[- ]?carb|whole\s+wheat|gluten[- ]?free|almond|cassava|spinach|herb|sun[- ]?dried|tomato|jalapeno|cheddar|habanero|chipotle|sweet\s+hawaiian|organic|protein)\b)(?=.*\bmission\b)(?=.*\bflour\b)(?=.*\btortillas?\b).*/i,
    brand: "Mission",
    title: "Mission Soft Taco Flour Tortillas",
    ingredients: "Enriched Bleached Flour (Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Vegetable Shortening (Interesterified and Hydrogenated Soybean Oils), Contains 2% or Less of: Salt, Sugar, Baking Soda, Sodium Acid Pyrophosphate, Distilled Monoglycerides, Enzymes, Fumaric Acid, and Calcium Propionate and Sorbic Acid (to Maintain Freshness).",
    nutrition: { caloriesKcal100g: 286, sugarsG100g: 4.1, saturatedFatG100g: 3.1, sodiumMg100g: 857, fiberG100g: 2.0, proteinG100g: 8.2, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false, isOrganic: false },
    sourceUrl: "https://www.missionfoods.com/products/soft-taco-flour-tortillas/",
    verifiedAt: "2026-11-12",
  },
  {
    match: /^(?!.*\b(chips?|strips?|tostadas?|shells?|flour|yellow|blue|red|carb\s+balance|zero\s+net|keto|low[- ]?carb|organic|extra\s+thin)\b)(?=.*\bmission\b)(?=.*\bcorn\b)(?=.*\btortillas?\b).*/i,
    brand: "Mission",
    title: "Mission White Corn Tortillas",
    ingredients: "Corn Masa Flour, Water, Contains 2% or Less of: Cellulose Gum, Guar Gum, Amylase, and Propionic Acid, Benzoic Acid and Phosphoric Acid (to Maintain Freshness).",
    nutrition: { caloriesKcal100g: 200, sugarsG100g: 4.0, saturatedFatG100g: 0, sodiumMg100g: 40, fiberG100g: 4.0, proteinG100g: 4.0, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: false, isOrganic: false },
    sourceUrl: "https://www.missionfoods.com/products/white-corn-tortillas/",
    verifiedAt: "2026-11-12",
  },
  {
    match: /\b(simple\s+mills.*crackers)\b/i,
    brand: "Simple Mills",
    title: "Almond Flour Fine Ground Sea Salt Crackers",
    ingredients: "Nut and Seed Flour Blend (Almonds, Sunflower Seeds, Flax Seeds), Tapioca Starch, Cassava Flour, Organic Sunflower Oil, Sea Salt, Organic Onion, Organic Garlic, Rosemary Extract (For Freshness).",
    nutrition: { caloriesKcal100g: 500, sugarsG100g: 0, saturatedFatG100g: 3.3, sodiumMg100g: 600, fiberG100g: 6.7, proteinG100g: 10.0, fruitsVegNutsPct: 50, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.simplemills.com/Shop/Product/Almond-Flour-Crackers-Fine-Ground-Sea-Salt.aspx",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(mary'?s\s+gone.*crackers|mary'?s\s+gone)\b/i,
    brand: "Mary's Gone Crackers",
    title: "Organic Original Seed Crackers",
    ingredients: "Organic brown rice, organic quinoa, organic flax seeds, organic sesame seeds, organic tamari (water, organic soybeans, salt, organic vinegar), sea salt.",
    nutrition: { caloriesKcal100g: 150 / 0.3, sugarsG100g: 0, saturatedFatG100g: 0.5 / 0.3, sodiumMg100g: 180 / 0.3, fiberG100g: 3 / 0.3, proteinG100g: 4 / 0.3, isWholeFood: false, isOrganic: true , nutriScoreGrade: "c"},
    sourceUrl: "https://www.marysgonecrackers.com/products/marys-gone-crackers-original-crackers",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\b(crunchmaster|\d+-seed.*crackers|seed\s+crackers|multi[- ]?grain\s+crackers)\b/i,
    brand: "Crunchmaster",
    title: "6-Seed Multi-Grain Baked Crackers",
    ingredients: "Brown Rice Flour, Whole Grain Yellow Corn, Potato Starch, Safflower Oil, Oat Fiber, Cane Sugar, Sesame Seeds, Flax Seeds, Millet, Quinoa Seeds, Amaranth Seeds, Chia Seeds, Sea Salt, Tamari Soy Sauce Powder (Tamari Soy Sauce [Soybeans, Salt], Maltodextrin, Salt).",
    nutrition: { caloriesKcal100g: 465, sugarsG100g: 3.5, saturatedFatG100g: 1.8, sodiumMg100g: 450, fiberG100g: 7.0, proteinG100g: 7.0, fruitsVegNutsPct: 25, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://crunchmaster.com/product/multi-seed-original/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(crackers|saltines|graham\s+crackers|oyster\s+crackers|animal\s+crackers|snack\s+crackers|water\s+crackers|woven\s+wheats?)\b/i,
    brand: "Baked Crackers",
    title: "Enriched Baked Snack Crackers",
    ingredients: "Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Soybean and/or Canola Oil, Palm Oil, Sugar, Salt, Leavening (Calcium Phosphate, Baking Soda), Soy Lecithin, Natural Flavor.",
    nutrition: { caloriesKcal100g: 480, sugarsG100g: 6.5, saturatedFatG100g: 7.0, sodiumMg100g: 720, fiberG100g: 2.0, proteinG100g: 7.0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/175007/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(birds\s+eye|steamfresh|frozen\s+vegetables?)\b.*\b(sauced|cheesy|cheese\s+sauce|alfredo|garlic\s+butter|butter\s+sauce|teriyaki|glaze|seasoned\s+asian)\b/i,
    brand: "Birds Eye",
    title: "Sauced Frozen Vegetables",
    ingredients: "Vegetables (Broccoli, Carrots, Corn), Water, Cheddar Cheese (Cultured Milk, Salt, Enzymes, Annatto), Modified Corn Starch, Skim Milk, Whey, Butter (Cream, Salt), Soybean Oil, Salt, Sodium Phosphate, Xanthan Gum, Natural Flavor, Annatto and Paprika Extract (Color).",
    nutrition: { caloriesKcal100g: 85, sugarsG100g: 3.0, saturatedFatG100g: 2.5, sodiumMg100g: 340, fiberG100g: 2.0, proteinG100g: 3.5, fruitsVegNutsPct: 70, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.birdseye.com/sauced-seasoned/sauced/steamfresh-cheddar-broccoli",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(birds\s+eye|steamfresh|asian\s+medley|stir[- ]?fry\s+vegetables?|california\s+blend|normandy\s+blend|mixed\s+vegetables?|frozen\s+vegetables?|peas\s+and\s+carrots|broccoli\s+florets)\b/i,
    brand: "Birds Eye Steamfresh",
    title: "Steamfresh Frozen Vegetables",
    ingredients: "100% Flash-Frozen Whole Vegetables: Broccoli, Carrots, Baby Cob Corn, Sugar Snap Peas.",
    nutrition: { caloriesKcal100g: 42, sugarsG100g: 3.5, saturatedFatG100g: 0.1, sodiumMg100g: 20, fiberG100g: 2.8, proteinG100g: 2.0, fruitsVegNutsPct: 100, nutriScoreGrade: "a", isWholeFood: true },
    sourceUrl: "https://www.birdseye.com/plain-vegetables/steamfresh-selects/mixed-vegetables",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(nathan'?s(?:\s+famous)?)\b.*\b(beef\s+franks?|franks?|hot\s+dogs?|frankfurters?)\b|\b(nathan'?s\s+famous)\b/i,
    brand: "Nathan's Famous",
    title: "Skinless Beef Franks",
    ingredients: "Beef, Water, Contains 2% or Less of Salt, Sorbitol, Sodium Lactate, Natural Flavorings, Sodium Phosphate, Hydrolyzed Corn Protein, Paprika, Sodium Diacetate, Sodium Erythorbate, Sodium Nitrite.",
    nutrition: { caloriesKcal100g: 295, sugarsG100g: 0, saturatedFatG100g: 10.5, sodiumMg100g: 860, fiberG100g: 0, proteinG100g: 12.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://nathansfranks.sfdbrands.com/en-us/products/hot-dogs/skinless-beef-franks-12-oz/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(hebrew\s+national)\b.*\b(beef\s+franks?|franks?|hot\s+dogs?|frankfurters?)\b|\b(hebrew\s+national)\b/i,
    brand: "Hebrew National",
    title: "All-Beef Kosher Franks",
    ingredients: "Beef, Water, Contains 2% or Less of: Salt, Spice, Potassium Lactate, Sodium Lactate, Garlic Powder, Paprika, Hydrolyzed Soy Protein, Sodium Diacetate, Sodium Erythorbate, Flavorings, Sodium Nitrite.",
    nutrition: { caloriesKcal100g: 305, sugarsG100g: 0, saturatedFatG100g: 11.5, sodiumMg100g: 910, fiberG100g: 0, proteinG100g: 12.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.hebrewnational.com/kosher-hot-dogs/beef-franks",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(ball\s+park|oscar\s+mayer.*(wieners?|franks?|hot\s+dogs?)|kirkland.*(franks?|hot\s+dogs?)|member'?s\s+mark.*(franks?|hot\s+dogs?)|beef\s+franks?|meat\s+franks?|turkey\s+franks?|hot\s+dogs?|frankfurters?)\b/i,
    brand: "Representative Beef Franks Formulation",
    title: "Beef Franks and Hot Dogs (Representative Formulation)",
    ingredients: "Beef, Water, Corn Syrup, Contains 2% or Less of: Salt, Potassium Lactate, Hydrolyzed Beef Stock, Sodium Phosphate, Flavorings, Sodium Diacetate, Sodium Erythorbate, Sodium Nitrite, Extractives of Paprika.",
    nutrition: { caloriesKcal100g: 315, sugarsG100g: 3.8, saturatedFatG100g: 11.5, sodiumMg100g: 980, fiberG100g: 0, proteinG100g: 11.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/174576/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(mccormick.*bac'?n|bac'?n\s+(bits|pieces)|bacon\s+bits|imitation\s+bacon)\b/i,
    brand: "McCormick",
    title: "Bac'n Pieces Bacon Flavored Bits",
    ingredients: "Textured Soy Flour, Canola Oil, Salt, Caramel Color, Maltodextrin, Natural and Artificial Flavor, Lactic Acid, Yeast Extract, Disodium Inosinate and Disodium Guanylate (Flavor Enhancers), Red 40.",
    nutrition: { caloriesKcal100g: 428, sugarsG100g: 0, saturatedFatG100g: 2.0, sodiumMg100g: 2280, fiberG100g: 14.0, proteinG100g: 42.0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.mccormick.com/spices-and-flavors/other/bacn-pieces-bacon-flavored-bits",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(rotisserie\s+(?:whole\s+)?chicken|seasoned\s+rotisserie\s+(?:whole\s+)?chicken|member'?s\s+mark.*rotisserie|kirkland.*rotisserie)\b/i,
    brand: "Rotisserie Deli",
    title: "Seasoned Rotisserie Whole Chicken",
    ingredients: "Whole Chicken, Water, Salt, Sodium Phosphate, Sugar, Spices, Garlic Powder, Onion Powder, Natural Flavor.",
    nutrition: { caloriesKcal100g: 165, sugarsG100g: 0.5, saturatedFatG100g: 3.2, sodiumMg100g: 390, fiberG100g: 0, proteinG100g: 21.0, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171481/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(gnocchi|potato\s+gnocchi|de\s+cecco.*gnocchi)\b/i,
    brand: "De Cecco",
    title: "Potato Gnocchi Pasta",
    ingredients: "Potato Puree (Water, Dehydrated Potato Flakes), Wheat Flour, Potato Starch, Rice Flour, Salt, Acidity Regulator (Lactic Acid), Preservative (Potassium Sorbate).",
    nutrition: { caloriesKcal100g: 160, sugarsG100g: 1.0, saturatedFatG100g: 0.2, sodiumMg100g: 410, fiberG100g: 2.2, proteinG100g: 4.5, fruitsVegNutsPct: 65, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://www.dececco.com/us_us/product/gnocchi/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(hellmann'?s|best\s+foods)\b.*\b(olive\s+oil)\b.*\b(mayo|mayonnaise|dressing)\b|\b(hellmann'?s|best\s+foods)\b.*\b(mayo|mayonnaise)\b.*\b(olive\s+oil)\b/i,
    brand: "Hellmann's",
    title: "Mayonnaise Dressing with Olive Oil",
    barcode: "0048001354531",
    keywords: ["best foods"],
    ingredients: "Water, Olive Oil, Canola Oil, Soybean Oil, Modified Potato Starch, Eggs, Sugar, Salt, Vinegar, Lemon Juice, Sorbic Acid and Calcium Disodium EDTA (Used to Protect Quality), Natural Flavor, Vitamin E.",
    nutrition: { caloriesKcal100g: 400, sugarsG100g: 0, saturatedFatG100g: 5.0, sodiumMg100g: 600, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 15, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.hellmanns.com/us/en/p/mayonnaise-dressing-with-olive-oil.html/00048001354531",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(kraft)\b.*\b(olive\s+oil)\b.*\b(mayo|mayonnaise)\b|\b(kraft)\b.*\b(mayo|mayonnaise)\b.*\b(olive\s+oil)\b/i,
    brand: "Kraft",
    title: "Mayo with Olive Oil Reduced Fat Mayonnaise",
    barcode: "0021000642236",
    ingredients: "Water, Olive Oil, Soybean Oil, Vinegar, Modified Food Starch, Sugar, Maltodextrin, Eggs, Contains Less than 2% of Salt, Natural Flavor, Mustard Flour, Potassium Sorbate and Calcium Disodium EDTA (to Protect Flavor), Dried Onions, Dried Garlic, Beta Carotene (Color).",
    nutrition: { caloriesKcal100g: 333, sugarsG100g: 6.7, saturatedFatG100g: 3.3, sodiumMg100g: 633, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 15, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.kraftheinz.com/kraft-mayo/products/00021000642236-mayo-with-olive-oil-reduced-fat-mayonnaise",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(primal\s+kitchen)\b.*\b(mayo|mayonnaise)\b/i,
    brand: "Primal Kitchen",
    title: "Real Mayonnaise Made with Avocado Oil",
    ingredients: "Avocado Oil, Organic Eggs, Organic Egg Yolks, Organic Vinegar, Sea Salt, Organic Rosemary Extract.",
    nutrition: { caloriesKcal100g: 714, sugarsG100g: 0, saturatedFatG100g: 7.1, sodiumMg100g: 393, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 82, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.primalkitchen.com/products/avocado-oil-mayo",
    verifiedAt: "2026-11-10",
  },
  {
    match: /\b(primal\s+kitchen)\b.*\b(ranch|dressing|vinaigrette)\b/i,
    brand: "Primal Kitchen",
    title: "Ranch Dressing & Marinade Made with Avocado Oil",
    ingredients: "Avocado Oil, Water, Organic Apple Cider Vinegar, Organic Distilled Vinegar, Organic Egg Yolks, Sea Salt, Organic Lemon Juice Concentrate, Organic Onion Powder, Organic Garlic Powder, Organic Dill, Organic Parsley, Organic Chives, Organic Black Pepper, Organic Rosemary Extract.",
    nutrition: { caloriesKcal100g: 433, sugarsG100g: 0, saturatedFatG100g: 5.0, sodiumMg100g: 667, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 75, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.primalkitchen.com/products/ranch-dressing",
    verifiedAt: "2026-11-10",
  },
  {
    match: /\b(chosen\s+foods)\b.*\b(mayo|mayonnaise)\b/i,
    brand: "Chosen Foods",
    title: "Classic Avocado Oil Mayonnaise",
    ingredients: "Avocado Oil, Filtered Water, Whole Eggs, Egg Yolks, Organic Distilled White Vinegar, Organic Mustard (Distilled Vinegar, Water, Organic Mustard Seed, Salt, Organic Spices), Salt, Organic Rosemary Extract.",
    nutrition: { caloriesKcal100g: 714, sugarsG100g: 0, saturatedFatG100g: 7.1, sodiumMg100g: 393, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 82, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://chosenfoods.com/products/classic-avocado-oil-mayo",
    verifiedAt: "2026-11-10",
  },
  {
    match: /\b(boulder\s+canyon)\b.*\b(avocado\s+oil)\b.*\b(chips?|crisps?)\b/i,
    brand: "Boulder Canyon",
    title: "Avocado Oil Classic Sea Salt Kettle Cooked Potato Chips",
    ingredients: "Potatoes, Avocado Oil, Sea Salt.",
    nutrition: { caloriesKcal100g: 535, sugarsG100g: 0, saturatedFatG100g: 5.3, sodiumMg100g: 392, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 80, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.utzsnacks.com/products/boulder-canyon-kettle-cooked-potato-chips-avocado-oil-classic-sea-salt",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(mayo|mayonnaise|dressing|ranch|vinaigrette|aioli|chips?|crisps?|crackers?|popcorn|pretzels?|tortillas?|bread|pasta|sauce|marinara|pesto|hummus|tuna|sardines?|salmon|olives\b|olive\s+(?:tapenade|garden|salad|brine)|spread|butter|margarine|cookies?|cereal|granola|bars?)\b).*\b(chosen\s+foods.*avocado\s+oil|100%\s*(?:pure\s+)?avocado\s+oil|avocado\s+oil)\b/i,
    brand: "Chosen Foods",
    title: "100% Pure Avocado Oil",
    ingredients: "100% Pure Avocado Oil (Expeller-Pressed Single-Ingredient Fruit Oil).",
    nutrition: { caloriesKcal100g: 884, sugarsG100g: 0, saturatedFatG100g: 14.0, sodiumMg100g: 0, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 100, nutriScoreGrade: "a", isWholeFood: true },
    sourceUrl: "https://chosenfoods.com/products/100-pure-avocado-oil",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(mayo|mayonnaise|dressing|ranch|vinaigrette|aioli|chips?|crisps?|crackers?|popcorn|pretzels?|tortillas?|bread|pasta|sauce|marinara|pesto|hummus|tuna|sardines?|salmon|olives\b|olive\s+(?:tapenade|garden|salad|brine)|spread|butter|margarine|cookies?|cereal|granola|bars?)\b).*\bpompeian\b.*\bolive\s+oil\b/i,
    brand: "Pompeian",
    title: "100% Extra Virgin Olive Oil",
    ingredients: "100% Extra Virgin Olive Oil (Cold-Pressed Single-Ingredient Fruit Oil).",
    nutrition: { caloriesKcal100g: 884, sugarsG100g: 0, saturatedFatG100g: 14.0, sodiumMg100g: 0, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 100, nutriScoreGrade: "a", isWholeFood: true },
    sourceUrl: "https://www.pompeian.com/product/smooth-extra-virgin-olive-oil/",
    verifiedAt: "2026-11-10",
  },
  {
    match: /^(?!.*\b(mayo|mayonnaise|dressing|ranch|vinaigrette|aioli|chips?|crisps?|crackers?|popcorn|pretzels?|tortillas?|bread|pasta|sauce|marinara|pesto|hummus|tuna|sardines?|salmon|olives\b|olive\s+(?:tapenade|garden|salad|brine)|spread|butter|margarine|cookies?|cereal|granola|bars?|blend|canola|soybean|vegetable\s+oil|sunflower)\b).*\b(extra\s+virgin\s+olive\s+oil|100%\s*(?:pure\s+)?olive\s+oil|california\s+olive\s+ranch|bertolli.*extra\s+virgin\s+olive\s+oil|olive\s+oil)\b/i,
    brand: "Extra Virgin Olive Oil",
    title: "100% Extra Virgin Olive Oil",
    ingredients: "100% Extra Virgin Olive Oil (Cold-Pressed Single-Ingredient Fruit Oil).",
    nutrition: { caloriesKcal100g: 884, sugarsG100g: 0, saturatedFatG100g: 14.0, sodiumMg100g: 0, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 100, nutriScoreGrade: "b", isWholeFood: true },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/748608/nutrients",
    verifiedAt: "2026-11-10",
  },
  {
    match: /^(?!.*\b(blueberry|strawberry|chocolate|cinnamon|apple|banana|buttermilk|thick\s*(?:&|and)\s*fluffy|whole\s+wheat|nutri[- ]?grain|protein|gluten[\s-]*free|pancakes?|french\s+toast)\b).*\b(eggo|kellogg'?s\s+eggo)\b/i,
    brand: "Kellogg's Eggo",
    title: "Eggo Homestyle Waffles",
    keywords: ["kelloggs", "kellogg's", "eggo", "homestyle", "frozen", "waffles", "breakfast"],
    ingredients: "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1 [Thiamin Mononitrate], Vitamin B2 [Riboflavin], Folic Acid), Water, Vegetable Oil (Soybean, Palm, Canola, and/or Cottonseed), Sugar, Leavening (Baking Soda, Sodium Aluminum Phosphate, Monocalcium Phosphate), Contains 2% or Less of Salt, Dextrose, Spice, Whey, Eggs, Soy Lecithin, Beta-Carotene for Color, Calcium Carbonate, Iron, Vitamin A Palmitate, Vitamin B6, Vitamin B12.",
    nutrition: { caloriesKcal100g: 271, sugarsG100g: 5.7, saturatedFatG100g: 2.1, sodiumMg100g: 514, fiberG100g: 1.4, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.eggo.com/en_US/products/waffles/kellogg-s-eggo-homestyle-waffles-product.html",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(strawberry|strawberries|blueberry|blueberries|pineapple|peach|brown\s+sugar|cinnamon|chive|onion|garlic|herb|jalapeno|spicy|salmon|garden\s+vegetable|veggie|whipped|reduced\s+fat|less\s+fat|1\/3|neufchatel|fat\s+free|lactose\s+free|plant[\s-]*based|cheesecake)\b).*\bphiladelphia\b.*\bcream\s+cheese\b/i,
    brand: "Philadelphia",
    title: "Original Cream Cheese",
    barcode: "0021000612239",
    ingredients: "Pasteurized Milk and Cream, Salt, Carob Bean Gum, Cheese Culture.",
    nutrition: { caloriesKcal100g: 345, sugarsG100g: 3.6, saturatedFatG100g: 21.4, sodiumMg100g: 393, fiberG100g: 0, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.kraftheinz.com/philadelphia/products/00021000612239-original-cream-cheese-brick",
    verifiedAt: "2026-11-12",
  },
  {
    match: /\b(homestyle\s+waffles?|buttermilk\s+waffles?|blueberry\s+waffles?|thick\s*&\s*fluffy\s+waffles?)\b/i,
    brand: "Representative Frozen Waffle Formulation",
    title: "Frozen Waffles (Representative Formulation)",
    ingredients: "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Vegetable Oil (Soybean and/or Canola), Sugar, Leavening (Baking Soda, Sodium Aluminum Phosphate, Monocalcium Phosphate), Salt, Whey, Eggs, Soy Lecithin.",
    nutrition: { caloriesKcal100g: 271, sugarsG100g: 5.7, saturatedFatG100g: 2.1, sodiumMg100g: 514, fiberG100g: 1.4, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/175040/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(crumbled\s+bacon|real\s+bacon\s+(?:bits|pieces|crumbles)|member'?s\s+mark.*bacon|kirkland.*crumbled\s+bacon|hormel.*real\s+bacon)\b/i,
    brand: "Representative Cured Bacon Formulation",
    title: "100% Real Crumbled Bacon (Representative Formulation)",
    ingredients: "Bacon (Cured with Water, Salt, Sugar, Smoke Flavoring, Sodium Phosphate, Sodium Erythorbate, Sodium Nitrite).",
    nutrition: { caloriesKcal100g: 428, sugarsG100g: 0, saturatedFatG100g: 12.5, sodiumMg100g: 1570, fiberG100g: 0, proteinG100g: 42.8, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.hormel.com/brands/hormel-real-bacon-toppings/product/real-crumbled-bacon/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(member'?s\s+mark.*(?:usda\s+choice|angus\s+beef)|usda\s+choice\s+angus\s+beef)\b/i,
    brand: "Member's Mark",
    title: "Member's Mark USDA Choice Angus Beef Roast",
    ingredients: "100% USDA Choice Angus Beef.",
    nutrition: { caloriesKcal100g: 185, sugarsG100g: 0, saturatedFatG100g: 3.5, sodiumMg100g: 65, fiberG100g: 0, proteinG100g: 22.5, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: true },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/174032/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(purina.*dog\s+chow|dog\s+chow\s+complete)\b/i,
    brand: "Purina",
    title: "Purina Dog Chow Complete Adult Dry Dog Food",
    ingredients: "Whole Grain Corn, Meat and Bone Meal, Corn Gluten Meal, Beef Fat Preserved with Mixed-Tocopherols, Soybean Meal, Poultry By-Product Meal, Egg and Chicken Flavor, Whole Grain Wheat, Animal Digest, Salt, Calcium Carbonate, Potassium Chloride, Mono and Dicalcium Phosphate, Choline Chloride, Minerals, Vitamins, Yellow 6, Yellow 5, Red 40, Blue 2, BHA (Preservative).",
    nutrition: { caloriesKcal100g: 355, sugarsG100g: 2.0, saturatedFatG100g: 4.5, sodiumMg100g: 380, fiberG100g: 3.0, proteinG100g: 21.0, fruitsVegNutsPct: 0, isWholeFood: false },
    sourceUrl: "https://www.purina.com/dogs/dog-food/dry/dog-chow-complete-adult",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(rxbar|rx\s+bar)\b/i,
    brand: "RXBAR",
    title: "Chocolate Sea Salt Whole Food Protein Bar",
    ingredients: "Dates, Egg Whites, Cashews, Almonds, Chocolate, Cocoa, Natural Flavors, Sea Salt.",
    nutrition: { caloriesKcal100g: 404, sugarsG100g: 28.8, saturatedFatG100g: 3.8, sodiumMg100g: 500, fiberG100g: 9.6, proteinG100g: 23.1, fruitsVegNutsPct: 75, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://www.rxbar.com/en_US/shop/protein-bars/chocolate-sea-salt-box-of-12.html",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\b(larabar|lärabar)\b/i,
    brand: "LÄRABAR",
    title: "Fruit & Nut Whole Food Bar",
    ingredients: "Dates, Peanuts, Unsweetened Chocolate, Sea Salt.",
    nutrition: { caloriesKcal100g: 444, sugarsG100g: 35.5, saturatedFatG100g: 6.5, sodiumMg100g: 140, fiberG100g: 8.9, proteinG100g: 11.1, fruitsVegNutsPct: 90, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.larabar.com/our-products/larabar/peanut-butter-chocolate-chip",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(bonne\s+maman)\b/i,
    brand: "Bonne Maman",
    title: "Fruit Preserves",
    ingredients: "Strawberries, Sugar, Cane Sugar, Concentrated Lemon Juice, Fruit Pectin.",
    nutrition: { caloriesKcal100g: 250, sugarsG100g: 60.0, saturatedFatG100g: 0, sodiumMg100g: 0, fiberG100g: 1.0, proteinG100g: 0.4, fruitsVegNutsPct: 50, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://bonnemaman.us/products/strawberry-preserves-13-oz",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(wholly\s+guacamole|guacamole)\b/i,
    brand: "Wholly Guacamole",
    title: "Classic Hass Avocado Guacamole",
    ingredients: "Hass Avocados, Distilled Vinegar, Jalapeño Pepper, Sea Salt, Dehydrated Onion, Granulated Garlic.",
    nutrition: { caloriesKcal100g: 175, sugarsG100g: 1.0, saturatedFatG100g: 2.5, sodiumMg100g: 370, fiberG100g: 6.5, proteinG100g: 2.0, fruitsVegNutsPct: 95, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://www.eatwholly.com/products/wholly-guacamole/classic-guacamole/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(claussen|grillo'?s\s+pickles)\b/i,
    brand: "Claussen",
    title: "Refrigerated Kosher Dill Pickles",
    ingredients: "Fresh Cucumbers, Water, Salt, Distilled Vinegar, Fresh Garlic, Fresh Dill, Spices, Mustard Seed.",
    nutrition: { caloriesKcal100g: 18, sugarsG100g: 1.0, saturatedFatG100g: 0, sodiumMg100g: 750, fiberG100g: 1.2, proteinG100g: 0.5, fruitsVegNutsPct: 90, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.myfoodandfamily.com/brands/claussen/product/00044700019559",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(kalamata\s+olives?|castelvetrano\s+olives?|green\s+olives?|black\s+olives?|\bolives\b)\b/i,
    brand: "Mediterranean Olives",
    title: "Pitted Olives in Brine",
    ingredients: "Olives, Water, Sea Salt, Red Wine Vinegar, Extra Virgin Olive Oil.",
    nutrition: { caloriesKcal100g: 145, sugarsG100g: 0, saturatedFatG100g: 2.0, sodiumMg100g: 1150, fiberG100g: 3.2, proteinG100g: 1.0, fruitsVegNutsPct: 95, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/169094/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(ezekiel(?:\s+4:?9)?|food\s+for\s+life.*sprouted|sprouted\s+whole\s+grain\s+bread)\b/i,
    brand: "Food for Life Ezekiel 4:9",
    title: "Organic Ezekiel 4:9 Sprouted Whole Grain Bread",
    ingredients: "Organic Sprouted Wheat, Filtered Water, Organic Sprouted Barley, Organic Sprouted Millet, Organic Malted Barley, Organic Sprouted Lentils, Organic Sprouted Soybeans, Organic Sprouted Spelt, Fresh Yeast, Organic Wheat Gluten, Sea Salt.",
    nutrition: { caloriesKcal100g: 235, sugarsG100g: 0, saturatedFatG100g: 0, sodiumMg100g: 220, fiberG100g: 8.8, proteinG100g: 14.7, fruitsVegNutsPct: 15, nutriScoreGrade: "a", isWholeFood: false, isOrganic: true },
    sourceUrl: "https://www.foodforlife.com/product/breads/ezekiel-49-sprouted-whole-grain-bread",
    verifiedAt: "2026-11-10",
  },
  {
    match: /\b(dave'?s\s+killer|sprouted\s+grain)\b.*\b(bread|bagels?|buns?|english\s+muffins?)\b/i,
    brand: "Dave's Killer Bread",
    title: "Organic 21 Whole Grains and Seeds Bread",
    ingredients: "Organic Whole Wheat (Organic Whole Wheat Flour, Organic Cracked Whole Wheat), Water, Organic Cane Sugar, Organic 21 Whole Grains and Seeds Mix (Organic Whole Flax Seeds, Organic Sunflower Seeds, Organic Ground Whole Flax Seeds, Organic Unhulled Brown Sesame Seeds, Organic Triticale, Organic Pumpkin Seeds, Organic Rolled Barley, Organic Rolled Oats, Organic Rye, Organic Unhulled Black Sesame Seeds, Organic Blue Cornmeal, Organic Millet, Organic Rolled Spelt, Organic Brown Rice Flour, Organic Amaranth Flour, Organic Yellow Cornmeal, Organic Kamut Khorasan Wheat, Organic Sorghum Flour, Organic Buckwheat Flour, Organic Quinoa, Organic Poppy Seeds), Organic Wheat Gluten, Organic Oat Fiber, Organic Molasses, Sea Salt, Organic Cultured Wheat Flour, Yeast, Organic Vinegar, Organic Acerola Cherry Powder, Enzymes.",
    nutrition: { caloriesKcal100g: 244, sugarsG100g: 11.1, saturatedFatG100g: 0, sodiumMg100g: 378, fiberG100g: 11.1, proteinG100g: 11.1, fruitsVegNutsPct: 15, nutriScoreGrade: "a", isWholeFood: false, isOrganic: true },
    sourceUrl: "https://www.daveskillerbread.com/21-whole-grains-and-seeds",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\b(kind\s+(?:nut\s+)?bars?|kind\s+dark\s+chocolate\s+nuts)\b/i,
    brand: "KIND",
    title: "KIND Dark Chocolate Nuts & Sea Salt Bar",
    ingredients: "Almonds, Chicory Root Fiber, Honey, Palm Kernel Oil, Sugar, Glucose Syrup, Rice Flour, Unsweetened Chocolate, Alkalized Cocoa, Soy Lecithin, Sea Salt, Natural Flavor, Cocoa Butter.",
    nutrition: { caloriesKcal100g: 450, sugarsG100g: 12.5, saturatedFatG100g: 7.5, sodiumMg100g: 310, fiberG100g: 17.5, proteinG100g: 15.0, fruitsVegNutsPct: 60, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.kindsnacks.com/products/dark-chocolate-nuts-sea-salt",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\binglehoffer\b.*\b(wasabi|horseradish)\b|\b(hot\s+creamy\s+wasabi\s+horseradish)\b/i,
    brand: "Inglehoffer",
    title: "Inglehoffer Hot Creamy Wasabi Horseradish Sauce",
    ingredients: "Soybean Oil, Water, Horseradish, High Fructose Corn Syrup, White Distilled Vinegar, Egg Yolks, Corn Syrup, Modified Food Starch, Contains Less than 2% of Wasabi Powder, Salt, Mustard Seed, Citric Acid, Mustard Bran, Spices, Xanthan Gum, Sodium Benzoate and Calcium Disodium EDTA (to Preserve Freshness), Artificial Flavor, Yellow 5, Blue 1.",
    nutrition: { caloriesKcal100g: 340, sugarsG100g: 12.0, saturatedFatG100g: 5.0, sodiumMg100g: 780, fiberG100g: 2.0, proteinG100g: 1.0, fruitsVegNutsPct: 20, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://beavertonfoods.com/product/inglehoffer-wasabi-horseradish-9-5-oz/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bbeaver(\s+brand)?\b.*\b(wasabi|horseradish)\b|\b(extra\s+hot\s+wasabi\s+horseradish)\b/i,
    brand: "Beaver Brand",
    title: "Beaver Brand Extra Hot Wasabi Horseradish Sauce",
    ingredients: "Grated Horseradish and Wasabi Roots, Water, White Distilled Vinegar, Soybean Oil, Mustard Seed, Sugar, High Fructose Corn Syrup, Eggs, Salt, Modified Food Starch, Xanthan Gum, Citric Acid, Sodium Benzoate, Calcium Disodium EDTA, Artificial Flavor, Yellow 5, Blue 1.",
    imageUrl: "https://images.openfoodfacts.org/images/products/007/182/800/3009/front_en.14.400.jpg",
    nutrition: { caloriesKcal100g: 200, sugarsG100g: 10.0, saturatedFatG100g: 2.5, sodiumMg100g: 920, fiberG100g: 3.0, proteinG100g: 1.5, fruitsVegNutsPct: 35, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://world.openfoodfacts.org/product/0071828003009",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bkikkoman\b.*\bwasabi\b/i,
    brand: "Kikkoman",
    title: "Kikkoman Wasabi Sauce",
    ingredients: "Water, Soybean Oil, Root Blend (Horseradish and Wasabi), Distilled Vinegar, High Fructose Corn Syrup, Corn Starch, Sugar, Salt, Egg Yolks, Mustard Flour, Lemon Juice Concentrate, Artificial Flavoring, Xanthan Gum, Calcium Disodium EDTA (to Protect Flavor and Color), Natural Wasabi Flavor, Yellow 5, Blue 1.",
    imageUrl: "https://images.openfoodfacts.org/images/products/004/139/000/7002/front_en.11.400.jpg",
    nutrition: { caloriesKcal100g: 220, sugarsG100g: 14.0, saturatedFatG100g: 2.0, sodiumMg100g: 1600, fiberG100g: 2.0, proteinG100g: 1.5, fruitsVegNutsPct: 20, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://world.openfoodfacts.org/product/0041390007002",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(wasabi[- ]?o|real\s+wasabi\s+paste|authentic\s+japanese.*wasabi|wasabi\s+paste)\b/i,
    brand: "Wasabi-O",
    title: "Wasabi-O Real Prepared Wasabi Paste",
    ingredients: "Water, Wasabi Japonica, Horseradish, Rice Bran Oil, Salt, Sorbitol, Citric Acid, Xanthan Gum, Turmeric, Spirulina Extract.",
    nutrition: { caloriesKcal100g: 240, sugarsG100g: 8.0, saturatedFatG100g: 1.5, sodiumMg100g: 1850, fiberG100g: 4.0, proteinG100g: 2.0, fruitsVegNutsPct: 45, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.wasabi-o.com/products/wasabi-paste",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bwicked\s+cutz\b.*\b(bacon|jerky)\b/i,
    brand: "Wicked Cutz",
    title: "Wicked Cutz Thick Cut Bacon Jerky",
    ingredients: "Pork, Water, Brown Sugar, Sugar, Salt, Maple Syrup, Vinegar, Celery Powder, Sea Salt, Natural Smoke Flavor.",
    nutrition: { caloriesKcal100g: 390, sugarsG100g: 14.0, saturatedFatG100g: 8.5, sodiumMg100g: 1250, fiberG100g: 0, proteinG100g: 35.0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://wickedcutz.com/products/maple-bacon-jerky",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bfreshness\s+guaranteed\b.*\bglazed\s+donuts?\b|\bglazed\s+donuts?,?\s*12\s*oz\b/i,
    brand: "Freshness Guaranteed",
    title: "Freshness Guaranteed Glazed Donuts",
    ingredients: "Enriched Wheat Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Sugar, Palm Oil, Soybean Oil, Dextrose, Yeast, Soy Flour, Salt, Mono- and Diglycerides, Sodium Stearoyl Lactylate, Calcium Propionate (to Preserve Freshness), Artificial Flavor, Yellow 5, Yellow 6.",
    nutrition: { caloriesKcal100g: 410, sugarsG100g: 24.5, saturatedFatG100g: 9.8, sodiumMg100g: 340, fiberG100g: 1.5, proteinG100g: 4.8, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.walmart.com/ip/Freshness-Guaranteed-Glazed-Donuts-12-oz-6-Count/425027592",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\bfreshness\s+guaranteed\b.*\bregular\s+raspberry\s+bism[a-z']*/i,
    brand: "Freshness Guaranteed",
    title: "Freshness Guaranteed Regular Raspberry Bismark",
    ingredients: "Enriched Wheat Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Raspberry Filling (High Fructose Corn Syrup, Water, Raspberries, Sugar, Modified Food Starch, Citric Acid, Sodium Benzoate, Potassium Sorbate, Red 40, Blue 1, Artificial Flavor), Palm Oil, Soybean Oil, Sugar, Dextrose, Yeast, Mono- and Diglycerides, Salt.",
    nutrition: { caloriesKcal100g: 350, sugarsG100g: 26.0, saturatedFatG100g: 7.5, sodiumMg100g: 310, fiberG100g: 1.5, proteinG100g: 4.5, fruitsVegNutsPct: 5, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.walmart.com/ip/Freshness-Guaranteed-Regular-Raspberry-Bismark-Donuts-4-Count-11-oz/133163700",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\bfreshness\s+guaranteed\b.*\braspberry\s+filled\s+bism[a-z']*/i,
    brand: "Freshness Guaranteed",
    title: "Freshness Guaranteed Raspberry Filled Bismark",
    ingredients: "Enriched Wheat Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Raspberry Filling (High Fructose Corn Syrup, Water, Raspberries, Sugar, Modified Food Starch, Citric Acid, Sodium Benzoate, Potassium Sorbate, Red 40, Blue 1, Artificial Flavor), Palm Oil, Soybean Oil, Sugar, Dextrose, Yeast, Mono- and Diglycerides, Salt.",
    nutrition: { caloriesKcal100g: 350, sugarsG100g: 26.0, saturatedFatG100g: 7.5, sodiumMg100g: 310, fiberG100g: 1.5, proteinG100g: 4.5, fruitsVegNutsPct: 5, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.walmart.com/ip/Freshness-Guaranteed-Raspberry-Filled-Bismark-Donuts-12-Count-33-oz/884122662",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\bsmithfield\b.*\b(?:boneless\s+cooked\s+hickory\s+smoked|hickory\s+smoked\s+ham)\b/i,
    brand: "Smithfield",
    title: "Smithfield Boneless Cooked Hickory Smoked Ham Steak",
    ingredients: "Cured with Water, Dextrose, Salt, Contains 2% or Less of Potassium Lactate, Sodium Phosphates, Sodium Diacetate, Sodium Erythorbate, Sodium Nitrite.",
    imageUrl: "https://images.openfoodfacts.org/images/products/020/634/010/5485/front_en.3.400.jpg",
    nutrition: { caloriesKcal100g: 120, sugarsG100g: 3.5, saturatedFatG100g: 1.2, sodiumMg100g: 1050, fiberG100g: 0, proteinG100g: 18.0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.walmart.com/ip/Smithfield-Boneless-Cooked-Hickory-Smoked-Ham-Steak/10535115",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\bmy\s+cookie\s+dealer\b|\bprotein\s+toaster\s+pastr(?:y|ies)\b/i,
    brand: "My Cookie Dealer",
    title: "My Cookie Dealer Protein Toaster Pastry Powdered",
    ingredients: "Enriched Wheat Flour, Whey Protein Isolate, Milk Protein Isolate, Palm Oil, Sugar, Strawberry Filling (Sugar, Strawberries, Water, Pectin, Citric Acid, Potassium Sorbate, Red 40), Soluble Corn Fiber, Allulose, Glycerin, Egg Whites, Natural and Artificial Flavors, Soy Lecithin, Sucralose, Sodium Benzoate.",
    nutrition: { caloriesKcal100g: 325, sugarsG100g: 11.0, saturatedFatG100g: 7.0, sodiumMg100g: 360, fiberG100g: 5.5, proteinG100g: 18.0, fruitsVegNutsPct: 5, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.walmart.com/ip/My-Cookie-Dealer-Protein-Toaster-Pastry-Powdered-Strawberry-3-88-oz/5470560138",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\bmarketside\s+butcher\b.*\bground\s+beef\b|\bground\s+beef\b.*\bmarketside\s+butcher\b/i,
    brand: "Marketside Butcher",
    title: "Marketside Butcher Organic Grass-Fed 93% Lean 7% Fat Ground Beef",
    ingredients: "100% Organic Grass-Fed Beef.",
    nutrition: { caloriesKcal100g: 152, sugarsG100g: 0, saturatedFatG100g: 2.9, sodiumMg100g: 66, fiberG100g: 0, proteinG100g: 20.8, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: true, isOrganic: true },
    sourceUrl: "https://www.walmart.com/ip/Marketside-Butcher-Organic-Grass-Fed-93-Lean-7-Fat-Ground-Beef-1-lb-Tray-Fresh-All-Natural/44391005",
    verifiedAt: "2026-11-10",
  },
  {
    match: /\borganic\b.*\bgrass[- ]?fed\b.*\bground\s+beef\b|\bground\s+beef\b.*\borganic\b.*\bgrass[- ]?fed\b|\borganic\s+ground\s+beef\b/i,
    brand: "USDA Organic Grass-Fed Beef",
    title: "Organic Grass-Fed Ground Beef",
    ingredients: "100% Organic Grass-Fed Beef.",
    nutrition: { caloriesKcal100g: 152, sugarsG100g: 0, saturatedFatG100g: 2.9, sodiumMg100g: 66, fiberG100g: 0, proteinG100g: 20.8, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: true, isOrganic: true },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/168652/nutrients",
    verifiedAt: "2026-11-10",
  },
  {
    match: /\bstonyfield\b.*\b(whole\s+milk\s+plain|plain.*yogurt)\b/i,
    brand: "Stonyfield Organic",
    title: "Stonyfield Organic Whole Milk Plain Yogurt",
    ingredients: "Cultured Pasteurized Organic Whole Milk, Pectin, Vitamin D3. Live and Active Cultures: S. thermophilus, L. bulgaricus, L. acidophilus, Bifidus, L. paracasei, and L. rhamnosus.",
    nutrition: { caloriesKcal100g: 65, sugarsG100g: 4.1, saturatedFatG100g: 2.1, sodiumMg100g: 47, fiberG100g: 0, proteinG100g: 3.5, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: false, isOrganic: true },
    sourceUrl: "https://www.stonyfield.com/products/whole-milk-plain-32oz/",
    verifiedAt: "2026-11-10",
  },
  {
    match: /\borganic\s+valley\b.*\b(sharp\s+cheddar|cheddar\s+cheese|raw\s+sharp\s+cheddar)\b/i,
    brand: "Organic Valley",
    title: "Organic Valley Organic Raw Sharp Cheddar Cheese",
    ingredients: "Organic Unpasteurized Cultured Milk, Salt, Vegetarian Enzymes.",
    nutrition: { caloriesKcal100g: 393, sugarsG100g: 0, saturatedFatG100g: 21.4, sodiumMg100g: 643, fiberG100g: 0, proteinG100g: 25.0, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false, isOrganic: true },
    sourceUrl: "https://www.organicvalley.coop/products/cheese/cheddar/raw-sharp-cheddar-cheese-8-oz/",
    verifiedAt: "2026-11-10",
  },
  {
    match: /\bapplegate\b.*\b(oven\s+roasted\s+turkey|turkey\s+breast)\b/i,
    brand: "Applegate Organics",
    title: "Applegate Organics Oven Roasted Turkey Breast",
    ingredients: "Organic Turkey Breast, Water. Contains Less Than 2% Of The Following: Salt, Organic Potato Starch, Organic Rosemary Extract.",
    nutrition: { caloriesKcal100g: 89, sugarsG100g: 0, saturatedFatG100g: 0, sodiumMg100g: 607, fiberG100g: 0, proteinG100g: 19.6, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: false, isOrganic: true },
    sourceUrl: "https://applegate.com/products/applegate-organics-oven-roasted-turkey-breast",
    verifiedAt: "2026-11-10",
  },
  {
    match: /\blotus\s+foods\b.*\b(millet\s*(?:&|and)\s*brown\s+rice|ramen)\b/i,
    brand: "Lotus Foods",
    title: "Lotus Foods Organic Millet & Brown Rice Ramen",
    ingredients: "Organic Brown Rice Flour, Organic Millet Flour.",
    nutrition: { caloriesKcal100g: 371, sugarsG100g: 0, saturatedFatG100g: 0.7, sodiumMg100g: 0, fiberG100g: 4.3, proteinG100g: 8.6, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: false, isOrganic: true },
    sourceUrl: "https://www.lotusfoods.com/products/organic-millet-brown-rice-ramen-4-pack",
    verifiedAt: "2026-11-10",
  },
  {
    match: /\brao'?s\b.*\b(marinara|pasta\s+sauce)\b/i,
    brand: "Rao's Homemade",
    title: "Rao's Homemade Marinara Sauce",
    keywords: ["pasta"],
    ingredients: "Italian Whole Peeled Tomatoes, Olive Oil, Onions, Salt, Garlic, Basil, Black Pepper, Oregano.",
    nutrition: { caloriesKcal100g: 80, sugarsG100g: 3.2, saturatedFatG100g: 0.8, sodiumMg100g: 336, fiberG100g: 1.6, proteinG100g: 1.6, fruitsVegNutsPct: 90, nutriScoreGrade: "a", isWholeFood: false, isOrganic: false },
    sourceUrl: "https://www.raos.com/products/marinara-sauce",
    verifiedAt: "2026-11-10",
  },
  {
    match: /\b(hellmann'?s|best\s+foods)\s+real\s+mayonnaise\b/i,
    brand: "Hellmann's",
    title: "Hellmann's Real Mayonnaise",
    ingredients: "Soybean Oil, Water, Whole Eggs and Egg Yolks, Distilled Vinegar, Salt, Sugar, Lemon Juice Concentrate, Calcium Disodium EDTA (Used to Protect Quality), Natural Flavors.",
    imageUrl: "https://images.openfoodfacts.org/images/products/004/800/121/3487/front_en.103.400.jpg",
    nutrition: { caloriesKcal100g: 692, sugarsG100g: 0, saturatedFatG100g: 11.5, sodiumMg100g: 692, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.hellmanns.com/us/en/p/real-mayonnaise.html/00048001213487",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\bkraft\b.*\b(?:real\s+)?(?:mayo|mayonnaise)\b/i,
    brand: "Kraft",
    title: "Kraft Real Mayo Creamy Smooth Mayonnaise",
    ingredients: "Soybean Oil, Water, Eggs, Vinegar, Contains Less Than 2% of Egg Yolks, Lemon Juice Concentrate, Salt, Sugar, Dried Onions, Dried Garlic, Paprika, Natural Flavor, Calcium Disodium EDTA (to Protect Flavor).",
    nutrition: { caloriesKcal100g: 692, sugarsG100g: 0, saturatedFatG100g: 11.5, sodiumMg100g: 538, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.kraftheinz.com/kraft-mayo/products/00021000642052-real-mayo-creamy-smooth-mayonnaise",
    verifiedAt: "2026-11-10",
  },
  {
    match: /^(?!.*\b(?:cheddar|white\s+cheddar|butter|kettle|sweet|lime|jalapeno|spicy)\b).*\bskinny\s*pop\b.*\bpopcorn\b/i,
    brand: "SkinnyPop",
    title: "SkinnyPop Original Popped Popcorn",
    ingredients: "Popcorn, Sunflower Oil, Salt.",
    nutrition: { caloriesKcal100g: 536, sugarsG100g: 0, saturatedFatG100g: 3.6, sodiumMg100g: 268, fiberG100g: 10.7, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.skinnypop.com/our-popcorn/popped-popcorn/original/",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:black\s+bean|vegetable|spinach|chicken|verde)\b).*\bamy'?s\b.*\bcheese\s+enchiladas?\b/i,
    brand: "Amy's",
    title: "Amy's Cheese Enchilada Frozen Meal",
    ingredients: "Filtered Water, Corn Tortillas (Corn Masa, Water), Cheddar Cheese (Pasteurized Milk, Culture, Salt, Enzymes, Annatto), Monterey Jack Cheese (Pasteurized Milk, Culture, Salt, Enzymes), Tomato Puree, Olives, Onions, Sweet Rice Flour, Expeller Pressed High Oleic Safflower and Sunflower Oil, Spices, Sea Salt, Garlic.",
    nutrition: { caloriesKcal100g: 176, sugarsG100g: 2.0, saturatedFatG100g: 3.9, sodiumMg100g: 306, fiberG100g: 2.4, proteinG100g: 6.7, fruitsVegNutsPct: 25, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.amys.com/our-foods/cheese-enchilada",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:treats?|cocoa|frosted|strawberry|rainbow|chocolate|bar)\b).*\bkellogg'?s?\b.*\brice\s+krispies\b/i,
    brand: "Kellogg's",
    title: "Kellogg's Rice Krispies Toasted Rice Cereal",
    keywords: ["breakfast cereal"],
    ingredients: "Rice, Sugar, Contains 2% or Less of Salt, Malt Flavor. Vitamins and Minerals: Iron, Niacinamide, Vitamin B6 (Pyridoxine Hydrochloride), Vitamin B2 (Riboflavin), Vitamin B1 (Thiamin Hydrochloride), Folic Acid, Vitamin D3, Vitamin B12.",
    nutrition: { caloriesKcal100g: 375, sugarsG100g: 10.0, saturatedFatG100g: 0, sodiumMg100g: 475, fiberG100g: 0, proteinG100g: 7.5, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.ricekrispies.com/en_US/products/kellogg-s-rice-krispies-cereal-product.html",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:bbq|barbecue|sour\s+cream|cheddar|salt\s+and\s+vinegar|vinegar|jalapeno|unsalted|sweet\s+potato|tortilla)\b).*\b365\b.*\borganic\b.*\bpotato\s+chips\b.*\bsea\s+salt\b/i,
    brand: "365 by Whole Foods Market",
    title: "365 by Whole Foods Market Organic Classic Sea Salt Potato Chips",
    ingredients: "Organic Potatoes, Organic Safflower and or Organic Sunflower Oil, Sea Salt.",
    nutrition: { caloriesKcal100g: 536, sugarsG100g: 0, saturatedFatG100g: 3.6, sodiumMg100g: 429, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false, isOrganic: true },
    sourceUrl: "https://www.wholefoodsmarket.com/products/brands/365-by-whole-foods-market",
    verifiedAt: "2026-11-18",
  },
  {
    match: /^(?!.*\b(?:healthy\s+request|low\s+sodium|unsalted|98%\s+fat\s+free|golden|garlic|roasted|chicken)\b).*\bcampbell'?s\b.*\bcondensed\b.*\bcream\s+of\s+mushroom\s+soup\b/i,
    brand: "Campbell's",
    title: "Campbell's Condensed Cream of Mushroom Soup",
    ingredients: "Water, Mushrooms, Vegetable Oil (Corn, Canola, and or Soybean), Modified Food Starch, Wheat Flour, Contains Less Than 2% of: Salt, Cream, Whey, Soy Protein Concentrate, Monosodium Glutamate, Yeast Extract, Dehydrated Garlic, Natural Flavoring.",
    nutrition: { caloriesKcal100g: 83, sugarsG100g: 0.8, saturatedFatG100g: 0.8, sodiumMg100g: 725, fiberG100g: 0.4, proteinG100g: 1.7, fruitsVegNutsPct: 12, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.campbells.com/products/condensed/cream-of-mushroom-soup/",
    verifiedAt: "2026-11-18",
  },
];

const UI_NOISE_QUERY =
  /\b(bought \d+\+?\s*times?|purchased \d+\+?\s*times?|stay stocked|last purchased|price may vary|max \d+ per order|final cost by weight|instant savings|really philly good|straight talk|google pixel|pixel \d+a?|tracfone|boost mobile|cricket wireless|total wireless|gas savings|walmart\+|walmart cash|manufacturer offer|subscribe to save|new notification|scan barcodes?|barcode scanner|opens barcode scanner|qr code|pickup or delivery|pickup and delivery|your favorites, for less|rollbacks & more|the holiday shop|shop all food|thanksgiving\s+meal|feast\s+for\s+\d+|classic\s+sides|meals?\s+made\s+easy|get\s+it\s+fast|household\s+essentials|grocery\s+list\s+staples|weekly\s+essentials|under\s+\$?\d+\s+per\s+person|shop\s+the\s+list|sparky|my items|product information|items to add next|frequently bought together|customers also viewed|similar items|sold by|fulfilled by|sold and shipped by|arrives between|arrives by|free \d+-day returns|free holiday returns|gift eligible|available for \d+ of \d+ items|fees may apply|snap ebt eligible|pro seller|preferred address|change delivery address|change address|usual items in stock|out of stock|replace with best match|add note for shopper|item instructions|visit the store|freshness guarantee|see customer images|from the manufacturer|excellent source of|good source of|hear the highlights|copy associates link|ways to buy|price history|\d+\s*[-–—]\s*\d+\s*min|\d+\s*(?:hr|hour|min)s?\s+or\s+less|\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)|free with w\+)\b|&\s*more\.?$|^(?:(?:flavor|flavor\s+name|size|style|color|colour|scent|count|pack|pack\s+size|variant|option|type|model|pattern|weight|material)\s*:\s*.+|cart\s*,?\s*\(\d+(?:\s+items?)?\)|in\s+\d+[kKmM]?\+?\s*people'?s?\s*c(?:arts?|a.*)|\d+[kKmM]?\+?\s*bought\b.*|options(?:\s+from\s+.*)?|.*\bsam'?s\s+club|\d+\s+[a-z]{2,}(?:\s+[a-z]{2,}){0,2}\s+(?:street|rd|road|drive|ave|avenue|blvd|boulevard|lane|court|place|circle|pkwy|parkway|hwy|highway)\b.*|.*,\s*was|.*\?)$/i;

const NON_FOOD_GUARD =
  /\b(sunscreen|banana\s+boat|coppertone|neutrogena|lotion|spf|lip\s+balm|shampoo|conditioner|body\s+wash|face\s+wash|soap|detergent|cleaner|bleach|wipes?|candle|deodorant|toothpaste|mouthwash|diapers?|litter|pet\s+food|dog\s+food|cat\s+food|toilet\s+paper|paper\s+towels?|bath\s+tissue|facial\s+tissue|disposable\s+(?:forks?|spoons?|knives|cutlery|utensils?|plates?|cups?|bowls?)|plastic\s+(?:forks?|spoons?|knives|cutlery|utensils?|plates?|cups?|bowls?|straws?)|paper\s+(?:plates?|bowls?|cups?|napkins?)|trash\s+bags?|garbage\s+bags?|aluminum\s+foil|plastic\s+wrap|parchment\s+paper|wax\s+paper|storage\s+bags?|freezer\s+bags?|sandwich\s+bags?|topcare|pain\s*&\s*fever|oral\s+suspension|acetaminophen|ibuprofen|tylenol|advil|motrin|benadryl|mucinex|nyquil|dayquil|robitussin|pepto|tums|laxative|antacid|cough\s+syrup|nasal\s+spray|eye\s+drops|toaster\s+ovens?|convection\s+ovens?|countertop\s+ovens?|microwave\s+ovens?|air\s+fryer\s+(?:toaster\s+)?ovens?|\d+(?:\.\d+)?\s*(?:qt|quart)\s+(?:digital\s+|stainless\s+)?air\s+fryers?|coffee\s+makers?|espresso\s+machines?|(?:countertop|immersion|personal|high-speed)\s+blenders?|food\s+processors?|stand\s+mixers?|hand\s+mixers?|electric\s+kettles?|waffle\s+makers?|rice\s+cookers?|pressure\s+cookers?|cookware(?:\s+sets?)?|bakeware(?:\s+sets?)?|frying\s+pans?|saucepans?|(?:cast\s+iron|nonstick|non-stick|stainless\s+steel|enameled)\s+(?:skillets?|pans?|dutch\s+ovens?)|baking\s+sheets?|mixing\s+bowls?|cutting\s+boards?|knife\s+(?:sets?|blocks?)|can\s+openers?|mainstays|better\s+homes\s*(?:&|and)\s*gardens|ninja\s+(?:crispi|foodi|creami|blast)|hair\s+cutting|hair\s+clippers?|beard\s+trimmers?|spotlights?|floodlights?|solar\s+lights?|extension\s+cords?|surge\s+protectors?)\b/i;

const PROCESSED_FOOD_GUARD =
  /\b(chips?|(?<!cosmic\s+|honey\s*)crisps?|crispy|fried|battered|breaded|rings?|instant|mashed|flakes?|au\s+gratin|scalloped|casserole|flavou?red|dressing|ranch|caesar|mayo|mayonnaise|aioli|vinaigrette|marinade|kit|soup|chowder|cream\s+of|alfredo|tikka|masala|tempura|cheesy|refried|praline|cinnamon|maple|chili\s+lime|stir[- ]?fry|pudding|cider|burgers?|seasoning|powder|sauce|a\.?1\.?|steak[- ]?umm\w*|ketchup|salsa|pie|pies|cake|roll|muffin|donuts?|doughnuts?|bismarks?|bismark|pastries|pastry|danish|fritters?|eclairs?|strudels?|turnovers?|toaster|candy|candied|gummies|juice|drink|soda|yogurt|cereal|puffs?|bars?|cookies?|wafers?|dried|dehydrated|craisins|fries|tots|ore[- ]?ida|idahoan|hash\s*browns?|macaroni|pasta\s+salad|potato\s+salad|chicken\s+salad|tuna\s+salad|egg\s+salad|ice\s+cream|gelato|sorbet|popsicle|jam|jelly|spread|apple\s+butter|pumpkin\s+butter|cookie\s+butter|fruit\s+butter|garlic\s+butter|herb\s+butter|lemon\s+butter|syrup|canned|fruit\s+cup|del\s+monte|dole|pickled|marinated|seasoned|grilled|roasted|smoked|cured|corned|pastrami|jerky|bacon|sausage|hot\s*dog|franks?|frankfurters?|salami|pepperoni|bologna|deli|lunch|ham|nuggets?|tenders?|(?<!new\s+york\s+|ny\s+|kansas\s+city\s+)strips?(?!\s+steak)|patties|patty|popcorn|teriyaki|bbq|barbecue|buffalo|honey|glazed|sandwich|biscuit|croissant|burritos?|tacos?|quesadillas?|tamales?|enchiladas?|wraps?|pizza|ramen|helper|eggnog|egg\s+nog|egg\s+roll|noodles?|gnocchi|spaghetti(?!\s+squash\b)|pasta|stews?(?!\s+(?:meat|beef)\b)|chocolate|covered|dipped|coated|crusted|stuffed|caramel|creamed|loaded|baby\s+food|pur[eé]es?)\b/i;

const NAMED_BRAND_GUARD =
  /\b(gerber|beech[- ]?nut|earth'?s\s+best|happy\s+baby|plum\s+organics|once\s+upon\s+a\s+farm|silk|pedialyte|oscar\s+mayer|tyson|applegate|boar'?s\s+head|hormel|perdue|foster\s+farms|barilla|rao'?s|wonder|pepperidge|arnold|orowheat|chobani|fage|tillamook|sargento|philadelphia|haagen[- ]?dazs|häagen[- ]?dazs|ben\s*&\s*jerry'?s?|ore[- ]?ida|mccain|alexia|hunt'?s|muir\s+glen|bush'?s|goya|tostitos|pace|herdez|sabra|land\s+o'?\s*lakes|kerrygold|country\s+crock|blue\s+bonnet|hellmann'?s|best\s+foods|duke'?s|french'?s|grey\s+poupon|kikkoman|tabasco|cholula|frank'?s|pillsbury|betty\s+crocker|duncan\s+hines|kodiak|krusteaz|bisquick|aunt\s+jemima|pearl\s+milling|log\s+cabin|mrs\.?\s*butterworth|skippy|jif|peter\s+pan|welch'?s|bonne\s+maman|nissin|nongshim|buldak|samyang|progresso|campbell'?s|totino'?s|red\s+baron|tombstone|banquet|healthy\s+choice|lean\s+cuisine|marie\s+callender'?s?|breyers|talenti|jennie[- ]?o|hillshire|jimmy\s+dean|smithfield|wright|farmland|nathan'?s|hebrew\s+national|ball\s+park|stouffer'?s|amy'?s|halo\s+top|yasso|clif\s+bar|quest|nature\s+valley|quaker|belvita|thomas'?|canyon\s+bakehouse|udi'?s|sara\s+lee|nature'?s\s+own|king'?s\s+hawaiian|mission|eggo|pop[- ]?tarts?|cheez[- ]?its?|goldfish|oreo|nutella|smucker'?s|heinz|hidden\s+valley|sweet\s+baby\s+ray'?s|stubb'?s|miracle\s+whip|wish[- ]?bone|ken'?s|briannas|marzetti|prego|ragu|classico|bertolli|newman'?s\s+own|mateo'?s|tapatio|valentina|oikos|siggi'?s|dannon|activia|stonyfield|kraft|babybel|laughing\s+cow|chips\s+ahoy|nutter\s+butter|keebler|fig\s+newtons?|haribo|sour\s+patch|skittles|starburst|swedish\s+fish|mott'?s|outshine|digiorno|vlasic|mt\.?\s*olive|lay'?s|ruffles|pringles|doritos|cheetos|fritos|utza?|herr'?s|cape\s+cod|smartfood|skinny\s*pop|froot\s+loops|frosted\s+flakes|lucky\s+charms|cheerios|gatorade|powerade|coca[- ]?cola|pepsi|sprite|fanta|dr\.?\s*pepper)\b/i;

export const CATEGORY_FALLBACK_CATALOG: Array<{
  match: RegExp;
  brand: string;
  ingredients: string;
  nutrition: NutritionInput & { isWholeFood?: boolean };
  sourceUrl: string;
  verifiedAt: string;
}> = [
  {
    match: /\b(potato\s+chips?|kettle\s+chips?|wavy\s+chips?|ridged\s+chips?|tortilla\s+chips?|corn\s+chips?|pita\s+chips?|veggie\s+straws?|veggie\s+chips?|cheese\s+curls?|cheese\s+puffs?|pretzels?|popcorn)\b/i,
    brand: "Salty Snacks",
    ingredients: "Potatoes or Whole Corn, Vegetable Oil (Canola, Corn, Soybean, or Sunflower Oil), Salt, Dextrose, Maltodextrin, Yeast Extract, Natural Flavors.",
    nutrition: { caloriesKcal100g: 515, sugarsG100g: 2.0, saturatedFatG100g: 4.5, sodiumMg100g: 520, fiberG100g: 4.0, proteinG100g: 6.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/174999/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(uncured|no\s+nitrates?)\b.*\b(hot\s*dogs?|franks?|frankfurters?|wieners?|sausage|kielbasa|bratwurst|salami|pepperoni|ham|turkey|roast\s+beef|deli)\b/i,
    brand: "Uncured Meats",
    ingredients: "Beef, Pork, or Poultry, Water, Contains Less than 2% of Sea Salt, Cane Sugar, Cultured Celery Powder, Spices, Garlic Powder, Onion Powder.",
    nutrition: { caloriesKcal100g: 235, sugarsG100g: 1.0, saturatedFatG100g: 7.5, sodiumMg100g: 740, fiberG100g: 0, proteinG100g: 14.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/174572/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(redhot|wing\s+sauce|buffalo\s+sauce|hot\s+sauce)\b).*\b(hot\s*dogs?|franks?|frankfurters?|wieners?|bologna|salami|pepperoni|pastrami|deli\s+(ham|turkey|chicken|roast\s+beef)|sliced\s+(ham|turkey|chicken)|lunch\s*meat|beef\s+jerky|turkey\s+jerky|bacon\s+jerky|jerky)\b/i,
    brand: "Deli & Cured Meats",
    ingredients: "Beef, Pork, or Poultry, Water, Corn Syrup, Contains 2% or Less of Salt, Dextrose, Sodium Phosphates, Sodium Propionate, Sodium Diacetate, Sodium Benzoate, Flavorings, Sodium Erythorbate, Sodium Nitrite.",
    nutrition: { caloriesKcal100g: 265, sugarsG100g: 2.5, saturatedFatG100g: 8.5, sodiumMg100g: 980, fiberG100g: 0, proteinG100g: 13.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/174575/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(wasabi|horseradish|inglehoffer|beaver\s+brand)\b/i,
    brand: "Horseradish & Wasabi Condiments",
    ingredients: "Grated Horseradish and Wasabi Roots, Water, Distilled Vinegar, Soybean Oil, High Fructose Corn Syrup, Salt, Mustard Seed, Xanthan Gum, Citric Acid, Sodium Benzoate, Calcium Disodium EDTA, Artificial Flavor, Yellow 5, Blue 1.",
    nutrition: { caloriesKcal100g: 220, sugarsG100g: 11.0, saturatedFatG100g: 2.5, sodiumMg100g: 950, fiberG100g: 2.5, proteinG100g: 1.5, fruitsVegNutsPct: 30, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171324/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(ketchup|catsup|bbq\s+sauce|barbecue\s+sauce|teriyaki\s+sauce|teriyaki|cocktail\s+sauce|sweet\s*(&|and)\s*sour\s+sauce|sweet\s+chili|hoisin\s+sauce|hoisin|eel\s+sauce|tonkatsu|duck\s+sauce|plum\s+sauce)\b/i,
    brand: "Condiments & Sauces",
    ingredients: "Tomato Concentrate from Red Ripe Tomatoes, Distilled Vinegar, High Fructose Corn Syrup, Corn Syrup, Salt, Spice, Onion Powder, Natural Flavoring.",
    nutrition: { caloriesKcal100g: 112, sugarsG100g: 22.8, saturatedFatG100g: 0.1, sodiumMg100g: 905, fiberG100g: 0.5, proteinG100g: 1.1, fruitsVegNutsPct: 45, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/169984/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(mayo|mayonnaise|salad\s+dressing|caesar\s+dressing|italian\s+dressing|thousand\s+island|blue\s+cheese\s+dressing|vinaigrette|tartar\s+sauce|aioli|yum\s+yum\s+sauce|fry\s+sauce|burger\s+sauce|remoulade|dipping\s+sauce|french\s+onion\s+dip|spinach\s+dip)\b/i,
    brand: "Dressings & Spreads",
    ingredients: "Soybean Oil, Water, Whole Eggs and Egg Yolks, Distilled Vinegar, Salt, Sugar, Lemon Juice Concentrate, Calcium Disodium EDTA (Used to Protect Quality), Natural Flavors, Xanthan Gum.",
    nutrition: { caloriesKcal100g: 640, sugarsG100g: 1.8, saturatedFatG100g: 10.0, sodiumMg100g: 620, fiberG100g: 0, proteinG100g: 1.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171005/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(pasta\s+sauce|marinara|spaghetti\s+sauce|tomato\s+sauce|pizza\s+sauce|vodka\s+sauce|meat\s+sauce|enchilada\s+sauce|taco\s+sauce|salsa|picante|pico\s+de\s+gallo)\b/i,
    brand: "Tomato Sauce & Salsa",
    ingredients: "Tomato Puree (Water, Tomato Paste), Diced Tomatoes in Tomato Juice, Onions, Olive Oil, Salt, Garlic, Basil, Oregano, Black Pepper, Citric Acid.",
    nutrition: { caloriesKcal100g: 55, sugarsG100g: 4.5, saturatedFatG100g: 0.4, sodiumMg100g: 360, fiberG100g: 1.8, proteinG100g: 1.5, fruitsVegNutsPct: 85, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/170462/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(mustard|dijon|yellow\s+mustard|hot\s+sauce|buffalo\s+sauce|wing\s+sauce|sriracha|chili\s+sauce|gochujang|harissa|chimichurri|ponzu|fish\s+sauce|oyster\s+sauce|soy\s+sauce|tamari|worcestershire|relish|chutney|marinade|glaze|simmer\s+sauce|stir[- ]?fry\s+sauce|curry\s+sauce|sauce)\b/i,
    brand: "Condiments",
    ingredients: "Distilled Vinegar, Water, Mustard Seed or Aged Cayenne Red Peppers, Salt, Turmeric, Paprika, Spice, Garlic Powder, Xanthan Gum.",
    nutrition: { caloriesKcal100g: 60, sugarsG100g: 1.0, saturatedFatG100g: 0.2, sodiumMg100g: 1120, fiberG100g: 3.0, proteinG100g: 3.8, fruitsVegNutsPct: 20, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/172234/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(pancake\s+syrup|breakfast\s+syrup|table\s+syrup)\b/i,
    brand: "Breakfast Syrup",
    ingredients: "Corn Syrup, High Fructose Corn Syrup, Water, Cellulose Gum, Caramel Color, Salt, Natural and Artificial Flavor, Sodium Benzoate and Sorbic Acid (Preservatives), Sodium Hexametaphosphate.",
    nutrition: { caloriesKcal100g: 270, sugarsG100g: 53.0, saturatedFatG100g: 0, sodiumMg100g: 165, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/168826/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(pure\s+maple\s+syrup|organic\s+maple\s+syrup|maple\s+syrup|raw\s+honey|unfiltered\s+honey|pure\s+honey|clover\s+honey|\bhoney\b)\b/i,
    brand: "Natural Sweeteners",
    ingredients: "100% Pure Maple Syrup or Raw Honey (Concentrated Natural Sugars).",
    nutrition: { caloriesKcal100g: 290, sugarsG100g: 68.0, saturatedFatG100g: 0, sodiumMg100g: 10, fiberG100g: 0, proteinG100g: 0.2, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/169640/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(jam|jelly|preserves|marmalade|fruit\s+spread|grape\s+jelly|strawberry\s+jam)\b/i,
    brand: "Jams & Preserves",
    ingredients: "Fruit, High Fructose Corn Syrup or Cane Sugar, Corn Syrup, Fruit Pectin, Citric Acid.",
    nutrition: { caloriesKcal100g: 250, sugarsG100g: 48.0, saturatedFatG100g: 0, sodiumMg100g: 25, fiberG100g: 1.0, proteinG100g: 0.3, fruitsVegNutsPct: 45, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/169643/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(natural|organic|unsweetened|no\s+sugar|almond|cashew|sunflower)\b).*\b(peanut\s+butter)\b/i,
    brand: "Peanut Butter",
    ingredients: "Roasted Peanuts, Sugar, Hydrogenated Vegetable Oil (Rapeseed, Cottonseed, and Soybean Oils) to Prevent Separation, Molasses, Mono- and Diglycerides, Salt.",
    nutrition: { caloriesKcal100g: 588, sugarsG100g: 9.2, saturatedFatG100g: 10.3, sodiumMg100g: 425, fiberG100g: 6.0, proteinG100g: 24.0, fruitsVegNutsPct: 90, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/172470/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(margarine|buttery\s+spread|vegetable\s+oil\s+spread)\b/i,
    brand: "Buttery Spread",
    ingredients: "Vegetable Oil Blend (Soybean Oil, Palm Oil, Palm Kernel Oil, Canola Oil), Water, Salt, Whey, Mono- and Diglycerides, Soy Lecithin, Potassium Sorbate and Calcium Disodium EDTA (to Preserve Freshness), Natural and Artificial Flavor, Vitamin A Palmitate, Beta Carotene (Color).",
    nutrition: { caloriesKcal100g: 500, sugarsG100g: 0, saturatedFatG100g: 14.0, sodiumMg100g: 680, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171422/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(potato|potatoes|lettuce|squash|beans?|peas|apple|peanut|almond|cashew|sunflower|cocoa|shea|cookie)\b).*\b(unsalted\s+butter|no\s+salt.*butter|salt[\s-]*free.*butter|butter.*unsalted)\b/i,
    brand: "Unsalted Creamery Butter",
    ingredients: "Pasteurized Cream, Natural Flavorings.",
    nutrition: { caloriesKcal100g: 717, sugarsG100g: 0.1, saturatedFatG100g: 51.0, sodiumMg100g: 11, fiberG100g: 0, proteinG100g: 0.9, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/173430/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(unsalted|no\s+salt|salt[\s-]*free|potato|potatoes|lettuce|squash|beans?|peas|apple|peanut|almond|cashew|sunflower|cocoa|shea|cookie)\b).*\b(salted\s+butter|sweet\s+cream\s+butter|irish\s+butter|\bbutter\b)\b/i,
    brand: "Creamery Butter",
    ingredients: "Pasteurized Cream, Salt.",
    nutrition: { caloriesKcal100g: 717, sugarsG100g: 0.1, saturatedFatG100g: 51.0, sodiumMg100g: 640, fiberG100g: 0, proteinG100g: 0.9, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/173410/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(strawberry|vanilla|blueberry|peach|cherry|flip|cookie)\b).*\b(greek\s+yogurt|plain\s+yogurt|sour\s+cream|cottage\s+cheese)\b/i,
    brand: "Cultured Dairy",
    ingredients: "Cultured Pasteurized Grade A Milk and Cream, Live and Active Cultures.",
    nutrition: { caloriesKcal100g: 95, sugarsG100g: 3.5, saturatedFatG100g: 2.5, sodiumMg100g: 65, fiberG100g: 0, proteinG100g: 10.0, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/170903/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(yogurt)\b/i,
    brand: "Dairy Yogurt",
    ingredients: "Cultured Grade A Lowfat Milk, Cane Sugar, Fruit Puree, Modified Corn Starch, Natural Flavors, Pectin, Citric Acid, Fruit & Vegetable Juice (for Color), Vitamin D3.",
    nutrition: { caloriesKcal100g: 88, sugarsG100g: 11.5, saturatedFatG100g: 1.0, sodiumMg100g: 50, fiberG100g: 0.2, proteinG100g: 4.5, fruitsVegNutsPct: 8, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/170888/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(cheddar|mozzarella|parmesan|provolone|swiss\s+cheese|gouda|feta|ricotta|colby\s+jack|pepper\s+jack|monterey\s+jack|american\s+cheese|string\s+cheese|shredded\s+cheese|sliced\s+cheese|cream\s+cheese)\b/i,
    brand: "Dairy Cheese",
    ingredients: "Pasteurized Milk, Cheese Culture, Salt, Enzymes, Annatto (Vegetable Color), Potato Starch and Powdered Cellulose (to Prevent Caking), Natamycin (a Natural Mold Inhibitor).",
    nutrition: { caloriesKcal100g: 380, sugarsG100g: 1.0, saturatedFatG100g: 18.5, sodiumMg100g: 620, fiberG100g: 0, proteinG100g: 23.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/173414/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(bread|loaf|bagels?|buns?|hamburger\s+buns?|hot\s+dog\s+buns?|dinner\s+rolls?|hawaiian\s+rolls?|english\s+muffins?|tortillas?|wraps?|pita|naan|flatbread|waffles?|pancakes?|biscuits?|croissants?)\b/i,
    brand: "Bakery & Bread",
    ingredients: "Enriched Wheat Flour (Wheat Flour, Malted Barley Flour, Niacin, Reduced Iron, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Sugar, Soybean or Canola Oil, Yeast, Salt, Mono- and Diglycerides, Calcium Propionate (Preservative), DATEM, Sodium Stearoyl Lactylate, Soy Lecithin.",
    nutrition: { caloriesKcal100g: 265, sugarsG100g: 5.5, saturatedFatG100g: 1.0, sodiumMg100g: 460, fiberG100g: 2.2, proteinG100g: 8.0, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/172687/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(maple|brown\s+sugar|apple\s+cinnamon|peaches|strawberries)\b).*\b(rolled\s+oats|old\s+fashioned\s+oats|steel\s+cut\s+oats|quick\s+oats)\b/i,
    brand: "Whole Grain Oats",
    ingredients: "100% Whole Grain Rolled Oats.",
    nutrition: { caloriesKcal100g: 379, sugarsG100g: 1.0, saturatedFatG100g: 1.2, sodiumMg100g: 5, fiberG100g: 10.1, proteinG100g: 13.2, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: true },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/173904/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(cereal|honey\s+bunches|raisin\s+bran|rice\s+krispies|chex|granola|oatmeal|instant\s+oats|granola\s+bars?|protein\s+bars?|chewy\s+bars?)\b/i,
    brand: "Cereal & Bars",
    ingredients: "Whole Grain Oats, Sugar, Corn Syrup, Enriched Flour, Canola or Palm Kernel Oil, Honey, Brown Sugar Syrup, Salt, Soy Lecithin, Trisodium Phosphate, Natural Flavor, Vitamin E (Mixed Tocopherols) Added to Preserve Freshness.",
    nutrition: { caloriesKcal100g: 410, sugarsG100g: 24.0, saturatedFatG100g: 3.5, sodiumMg100g: 350, fiberG100g: 4.5, proteinG100g: 7.0, fruitsVegNutsPct: 10, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/173915/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(cookies?|wafers?|brownies?|muffins?|donuts?|doughnuts?|bismarks?|pastries|pastry|danish|cinnamon\s+rolls?|cupcakes?|cake|pie|strudel|turnover|candy|chocolate|gummies|gummy|fruit\s+snacks?|sorbet|sherbet|popsicle|ice\s+pop)\b/i,
    brand: "Bakery & Sweets",
    ingredients: "Sugar, Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Palm or Soybean Oil, Corn Syrup, High Fructose Corn Syrup, Cocoa, Cornstarch, Dextrose, Salt, Soy Lecithin, Baking Soda, Artificial Flavor, Citric Acid, Red 40, Yellow 5, Blue 1.",
    nutrition: { caloriesKcal100g: 445, sugarsG100g: 36.0, saturatedFatG100g: 8.5, sodiumMg100g: 260, fiberG100g: 1.5, proteinG100g: 4.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/172710/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(frozen\s+pizza|rising\s+crust|thin\s+crust|pepperoni\s+pizza|cheese\s+pizza|supreme\s+pizza|pizza|burritos?|chimichangas?|taquitos?|quesadillas?|enchiladas?|egg\s+rolls?|spring\s+rolls?|potstickers?|dumplings?|casserole|pasta\s+salad|potato\s+salad|chicken\s+salad|tuna\s+salad|egg\s+salad|breakfast\s+sandwich)\b/i,
    brand: "Prepared Meals & Pizza",
    ingredients: "Enriched Wheat Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Low-Moisture Part-Skim Mozzarella and Cheddar Cheese, Tomato Paste, Soybean or Palm Oil, Sugar, Salt, Modified Corn Starch, Whey, Sodium Phosphate, Yeast, Spices, Natural and Artificial Flavor.",
    nutrition: { caloriesKcal100g: 255, sugarsG100g: 4.2, saturatedFatG100g: 5.5, sodiumMg100g: 610, fiberG100g: 2.0, proteinG100g: 10.5, fruitsVegNutsPct: 15, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/173292/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(pickles?|dill\s+pickles?|pickled)\b/i,
    brand: "Pickles",
    ingredients: "Cucumbers, Water, Distilled Vinegar, Salt, Calcium Chloride, Garlic, Spices, Polysorbate 80, Sodium Benzoate (Preservative), Yellow 5.",
    nutrition: { caloriesKcal100g: 35, sugarsG100g: 1.0, saturatedFatG100g: 0.2, sodiumMg100g: 780, fiberG100g: 1.2, proteinG100g: 0.5, fruitsVegNutsPct: 80, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/169378/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(hummus|tzatziki)\b/i,
    brand: "Deli Dips",
    ingredients: "Cooked Chickpeas, Water, Tahini (Ground Sesame), Olive or Soybean Oil, Salt, Citric Acid, Garlic, Cumin, Guar Gum, Potassium Sorbate (to Maintain Freshness).",
    nutrition: { caloriesKcal100g: 210, sugarsG100g: 1.5, saturatedFatG100g: 2.2, sodiumMg100g: 410, fiberG100g: 5.0, proteinG100g: 6.5, fruitsVegNutsPct: 70, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/174289/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(baked\s+beans|refried\s+beans)\b/i,
    brand: "Pantry Beans",
    ingredients: "Prepared Beans, Water, Brown Sugar, Sugar, Salt, Mustard, Modified Corn Starch, Onion Powder, Caramel Color, Spice, Garlic Powder.",
    nutrition: { caloriesKcal100g: 115, sugarsG100g: 9.2, saturatedFatG100g: 0.3, sodiumMg100g: 420, fiberG100g: 5.0, proteinG100g: 5.5, fruitsVegNutsPct: 75, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/175188/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(fruit\s+cups?|applesauce|canned\s+(peaches|pears|pineapple|fruit|mandarin\s+oranges))\b/i,
    brand: "Packaged Fruit",
    ingredients: "Fruit, Water, Sugar or Pear Juice Concentrate, Ascorbic Acid (Vitamin C) to Promote Color Retention, Citric Acid.",
    nutrition: { caloriesKcal100g: 68, sugarsG100g: 14.5, saturatedFatG100g: 0, sodiumMg100g: 8, fiberG100g: 1.2, proteinG100g: 0.4, fruitsVegNutsPct: 80, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171690/nutrients",
    verifiedAt: "2026-11-08",
  },
];

/**
 * Rejects a catalog fallback candidate when the user query specifies a dietary, allergen,
 * or nutrition modifier (e.g. "Gluten Free Oreo", "Zero Sugar", "Dairy Free", "2%") that
 * contradicts the static catalog entry's ingredients or nutrition profile.
 */
export function isDietaryOrVariantMismatch(
  query: string,
  entryTitle: string,
  entryIngredients: string,
  entryNutrition?: NutritionInput
): boolean {
  const q = query.toLowerCase();
  const t = entryTitle.toLowerCase();
  const ing = entryIngredients.toLowerCase();

  // Strip precautionary cross-contact trailers and explicit "-free" / "no ..." negations before ingredient checks
  const ingClean = ing
    .replace(
      /(?:[.;,(\[]|\b)(?:may\s+contain(?:\s+traces\s+of)?|(?:manufactured|processed|produced|packaged|made|prepared)\s+(?:in|on)\s+(?:a\s+)?(?:facility|plant|bakery|kitchen|equipment|shared\s+equipment|lines?|machinery)|shared\s+equipment\s+with|facility\s+that\s+(?:also\s+)?(?:processes|handles|uses|manufactures|packages))(?!\s*:)[^.;)\]\r\n]*?(?=\b(?:ingredients?|contains)\s*:|$|[.;)\]\r\n])/gi,
      " ",
    )
    .replace(
      /\b(?:gluten|wheat|grain|dairy|milk|lactose|casein|egg|nut|peanut|allergen|sugar|fat|salt|sodium)[\s-]+free\b/g,
      " ",
    )
    .replace(/\b(?:non[\s-]+dairy|no\s+(?:added\s+)?(?:sugar|salt|milk|dairy|gluten))\b/g, " ");

  // 1. Gluten-free / grain-free query vs gluten-containing ingredients (never trust candidate title claim over actual ingredients)
  if (/\b(gluten[\s-]*free|grain[\s-]*free|celiac)\b/.test(q)) {
    const ingNoBuckwheat = ingClean.replace(/\bbuckwheat\b/g, " ");
    if (
      /\b(wheat|barley|rye|malt|triticale|spelt|farro|kamut|semolina|durum|einkorn|emmer|graham\s+flour|enriched\s+flour)\b/.test(
        ingNoBuckwheat
      )
    ) {
      return true;
    }
  }

  // 2. Dairy-free / non-dairy / plant-based / vegan query vs dairy or animal ingredients
  // Strip plant-qualified milk/cream/butter phrases ("almond milk", "coconut cream", "cocoa butter", nut butters) first.
  if (/\b(dairy[\s-]*free|non[\s-]*dairy|plant[\s-]*based|vegan)\b/.test(q)) {
    const ingWithoutPlantTerms = ingClean
      .replace(
        /\b(?:almond|oat|soy|coconut|cashew|rice|hemp|pea|flax|macadamia|hazelnut|walnut|pecan|pistachio|sesame|sunflower(?:\s+seed)?|pumpkin\s+seed|tiger\s*nut|banana|plant|non[\s-]*dairy|vegan)\s+(?:milks?|creams?|creamers?|butters?|yogurts?|cheeses?|ice\s+creams?)\b/g,
        " ",
      )
      .replace(/\b(?:almond|oat|soy|coconut|cashew|rice|hemp|pea|flax|walnut|hazelnut|pistachio|pecan|macadamia)milks?\b/g, " ")
      .replace(
        /\b(?:cocoa|shea|mango|illipe|kokum|peanut|almond|cashew|hazelnut|walnut|pecan|pistachio|macadamia|sunflower(?:\s+seed)?|pumpkin\s+seed|sesame|tahini|soy(?:\s+nut)?|cookie|apple|pumpkin|maple|lemon|fruit)\s+butters?\b/g,
        " ",
      )
      .replace(/\bcream\s+of\s+(?:tartar|coconut|rice|wheat)\b/g, " ")
      .replace(/\bbutter\s+(?:beans?|lettuce)\b|\bbutternut\b/g, " ")
      .replace(/\blactic\s+acid\b|\bcalcium\s+lactate\b|\bsodium\s+(?:lactate|stearoyl\s+lactylate)\b/g, " ");
    const pattern = /\b(milk|milkfat|butterfat|butteroil|ghee|cream|whey|casein\w*|butter|cheese|yogurt|lactose|egg|eggs|beef|pork|chicken|turkey|fish|anchov\w*|gelatin)\b/;
    const dairyOnlyPattern = /\b(milk|milkfat|butterfat|butteroil|ghee|cream|whey|casein\w*|butter|cheese|yogurt|lactose)\b/;
    if ((/\b(vegan|plant[\s-]*based)\b/.test(q) ? pattern : dairyOnlyPattern).test(ingWithoutPlantTerms)) {
      return true;
    }
  }

  // 3. Zero-sugar / sugar-free / unsweetened / no-sugar-added / diet query vs caloric sugars
  if (/\b(zero\s+sugar|sugar[\s-]*free|sugarfree|no\s+sugar(?:\s+added)?|no\s+added\s+sugars?|unsweetened|\bdiet\b)\b/.test(q)) {
    const ingForSugar = ingClean.replace(/\bsugar\s+(?:snap|kelp|alcohols?|cane\s+fiber|beet\s+fiber)\b/g, " ");
    const isNoSugarAddedOnly =
      /\bno\s+(?:sugar\s+added|added\s+sugars?)\b/.test(q) &&
      !/\b(zero\s+sugar|sugar[\s-]*free|sugarfree|unsweetened|\bdiet\b)\b/.test(q);
    const hasAddedCaloricSweetener = isNoSugarAddedOnly
      ? /\b(sugar|cane\s+sugar|brown\s+sugar|invert\s+sugar|sucrose|glucose|fructose|corn\s+syrup|high\s+fructose\s+corn\s+syrup|rice\s+syrup|malt\s+syrup|tapioca\s+syrup|dextrose|maltose|honey|maple\s+syrup|molasses|agave)\b/.test(
          ingForSugar
        )
      : /\b(sugar|cane\s+sugar|brown\s+sugar|invert\s+sugar|sucrose|glucose|fructose|corn\s+syrup|high\s+fructose\s+corn\s+syrup|rice\s+syrup|malt\s+syrup|tapioca\s+syrup|dextrose|maltose|honey|maple\s+syrup|molasses|agave|fruit\s+juice\s+concentrate)\b/.test(
          ingForSugar
        );
    if (hasAddedCaloricSweetener) {
      return true;
    }
    if (!isNoSugarAddedOnly) {
      const isStrictZeroSugarQuery = /\b(zero\s+sugar|sugar[\s-]*free|sugarfree|no\s+sugar(?!\s+added)|\bdiet\b)\b/.test(q);
      if (isStrictZeroSugarQuery) {
        if ((entryNutrition?.sugarsG100g ?? 0) > 1) {
          return true;
        }
      } else if (!/\bunsweetened\b/.test(t)) {
        const isPlantOrDairyMilk =
          /\b(milk|oat\s*milk|almond\s*milk|soy\s*milk|coconut\s*milk|cashew\s*milk|milked\s+\w+|malk|elmhurst|califia|planet\s+oat)\b/.test(
            t
          );
        const maxIntrinsicSugar = isPlantOrDairyMilk ? 5 : 0.5;
        if ((entryNutrition?.sugarsG100g ?? 0) > maxIntrinsicSugar) {
          return true;
        }
      }
    }
  }

  // 3b. Unsalted / no-salt-added / salt-free query vs salted ingredients or high sodium
  if (/\b(unsalted|no\s+salt(?:\s+added)?|salt[\s-]*free|without\s+salt)\b/.test(q)) {
    const ingNoBenignSaltCompounds = ingClean.replace(
      /\b(?:potassium|calcium|magnesium|ammonium|disodium|trisodium|tetrasodium|edta|citrate|phosphate|bicarbonate|carbonate|lactate|alginate|ascorbate|benzoate|propionate|sorbate|caseinate|stearoyl)\b/g,
      " ",
    );
    if (
      /\b(?:sea\s+|kosher\s+|himalayan\s+|pink\s+|table\s+|iodized\s+|celtic\s+)?salt\b/.test(ingNoBenignSaltCompounds) ||
      (entryNutrition?.sodiumMg100g !== undefined && entryNutrition.sodiumMg100g > 140)
    ) {
      return true;
    }
  }

  // 4. Tree-nut / seed butter query vs peanut ingredients
  if (
    /\b(almond|cashew|sunflower|walnut|pecan|hazelnut)\s+butter\b/.test(q) &&
    /\bpeanut\b/.test(ingClean)
  ) {
    return true;
  }

  // 5. Fat-free / nonfat / skim / 2% / reduced-fat query vs full-fat entry
  if (
    /\b(fat[\s-]*free|non[\s-]*fat|skim|2%|1%|reduced[\s-]*fat|low[\s-]*fat)\b/.test(q) &&
    /\bwhole\s+milk\b/.test(t)
  ) {
    return true;
  }

  // 6. Reverse guard: candidate is a Light / Lite / Reduced-Fat Ice Cream / Vegan / Plant-Based variant when query did NOT request it
  const candWithoutNonVariantLight = t.replace(
    /\b(?:light\s+roast|(?:chunk\s+)?light\s+tuna|light\s+brown\s+sugar|light\s+corn\s+syrup|in\s+(?:extra\s+)?light\s+syrup|light\s+cream(?!\s+cheese)|light\s+(?:amber|red|pink)\b|lightly\s+(?:salted|breaded|seasoned|sweetened))\b/g,
    " ",
  );
  if (
    /\b(light|lite|reduced[\s-]*fat\s+ice\s+cream|vegan|plant[\s-]*based)\b/.test(candWithoutNonVariantLight) &&
    !/\b(light|lite|reduced[\s-]*fat|low[\s-]*fat|fat[\s-]*free|non[\s-]*fat|skim|vegan|plant[\s-]*based)\b/.test(q)
  ) {
    return true;
  }

  // 6b. Reverse guard: candidate is an unlabelled or explicit Sugar-Free / Artificially-Sweetened variant (e.g. OFF "Seedless Strawberry Jam" with 0g sugar + Sucralose) when query asked for a classic sugar-sweetened food
  if (
    !/\b(sugar[\s-]*free|sugarfree|no\s+(?:added\s+)?sugar|zero|diet|keto|light|lite|reduced\s+sugar|less\s+sugar|unsweetened|splenda|stevia)\b/.test(q) &&
    !/\b(zevia|sparkling\s+ice|celsius|ghost|alani|reign|bang|c4|propel|premier\s+protein|owyn|quest|halo\s+top)\b/.test(q)
  ) {
    if (/\b(sugar[\s-]*free|sugarfree|no\s+sugar\s+added|zero\s+sugar|keto)\b/.test(t)) {
      return true;
    }
    if (
      /\b(jam|jelly|preserves|marmalade|pancake\s+syrup|maple\s+syrup|chocolate\s+syrup|cookies?|brownies?|cake|cupcakes?|frosting|icing|fudge|marshmallows?|ice\s+cream)\b/.test(q) &&
      entryNutrition?.sugarsG100g !== undefined &&
      entryNutrition.sugarsG100g <= 1 &&
      /\b(sucralose|aspartame|acesulfame|saccharin|maltitol|sorbitol|erythritol|allulose|polydextrose)\b/.test(ing)
    ) {
      return true;
    }
  }

  // 7. Plain whole-produce or plain fresh meat/seafood query vs processed / seasoned / buttered / oil-added candidate
  if (
    !PROCESSED_FOOD_GUARD.test(q) &&
    !/\b(?:olive|avocado|coconut)\s+oil\b/.test(q) &&
    /\b(sweet\s+potato(?:es)?|yams?|potato(?:es)?|russet|yukon\s+gold|carrots?|apples?|bananas?|broccoli|cauliflower|spinach|kale|lettuce|avocados?|tomatoes?|onions?|peppers?|mushrooms?|zucchini|squash|celery|cucumbers?|berries|strawberries|blueberries|raspberries|grapes?|oranges?|peaches?|pears?|mangoes?|pineapple|fresh\s+whole|fresh\s+produce|salmon|cod|tilapia|halibut|trout|mahi|shrimp|scallops?|pork\s+chops?|pork\s+loin|pork\s+tenderloin|ribeye|sirloin|new\s+york\s+strip|flank\s+steak|skirt\s+steak|chuck\s+roast|beef\s+stew\s+meat|chicken\s+breasts?|chicken\s+thighs?|chicken\s+drumsticks?|chicken\s+tenderloins?)\b/.test(
      q
    )
  ) {
    if (
      /\b(chips?|crisps?|crispy|fries|fried|tots|puffs?|crackers?|cookies?|bars?|cereal|pie|cake|muffin|waffles?|pancakes?|pasta|gnocchi|ramen|noodles?|soup|sauce|dressing|dip|salsa|ketchup|jam|jelly|syrup|candy|gummies|soda|drink|beverage|juice|herb\s+butter|garlic\s+butter|stuffed|breaded|battered|marinated|teriyaki|bbq|barbecue|glazed|smoked|jerky|sausage|bacon|ham|hot\s+dog|frank|deli|sliced\s+oven\s+roasted)\b/.test(
        t
      ) ||
      /\b(canola\s+oil|sunflower\s+oil|safflower\s+oil|soybean\s+oil|vegetable\s+oil|palm\s+oil|palm\s+kernel\s+oil|corn\s+oil|cottonseed\s+oil|peanut\s+oil|coconut\s+oil|avocado\s+oil|olive\s+oil|rice\s+bran\s+oil|shortening|lard|tallow|hydrogenated|corn\s+syrup|high\s+fructose\s+corn\s+syrup|maltodextrin|dextrose|enriched\s+flour|wheat\s+flour|modified\s+(?:food|corn|potato)\s+starch|sodium\s+nitrite|sodium\s+phosphate|caramel\s+color|monosodium\s+glutamate)\b/.test(
        ing
      )
    ) {
      return true;
    }
  }

  return false;
}

const CATALOG_MARKETING_NOISE_TOKENS = new Set([
  "original", "classic", "traditional", "authentic", "real", "natural", "all", "pure",
  "fresh", "flavored", "flavor", "taste", "style", "brand", "recipe", "famous", "select", "premium",
  "quality", "grade", "usda", "choice", "prime", "thirst", "quencher", "portable",
  "size", "pack", "packs", "count", "can", "cans", "bottle", "bottles", "jar", "jars", "box", "boxes",
  "bag", "bags", "pouch", "pouches", "tub", "tubs", "carton", "cartons", "tray", "trays", "container",
  "brick", "bricks",
  "gallon", "gallons", "quart", "quarts", "pint", "pints", "liter", "liters", "ounce", "ounces", "pound", "pounds",
  "each", "per",
]);

const CATALOG_CRITICAL_UNEXPLAINED_TOKEN_RE =
  /^(?:condensed|homestyle|chunky|arrabbiata|tostadas?|punched|praline|tempura|tikka|masala|refried|tomato|mushroom|celery|broccoli|spinach|potato|corn|beans?|peas?|beef|pork|chicken|turkey|bacon|sausage|ham|salmon|tuna|shrimp|clam|crab|lobster|cheese|cheddar|mozzarella|parmesan|swiss|gouda|american|provolone|velveeta|butter|buttermilk|sour|cream|ranch|caesar|italian|french|thousand|bleu|blue|honey|mustard|ketchup|mayo|mayonnaise|bbq|barbecue|teriyaki|buffalo|sriracha|jalapeno|habanero|chipotle|poblano|chilis?|chiles?|cayenne|flamin|spicy|hot|mild|medium|zesty|tangy|sweet|salted|unsalted|smoked|hickory|mesquite|maple|applewood|brown|sugar|cinnamon|vanilla|chocolate|cocoa|dark|milk|white|fudge|caramel|butterscotch|toffee|peanut|almond|almondmilk|cashew|pecan|walnut|hazelnut|pistachio|macadamia|coconut|oat|oatmilk|soy|soymilk|strawberr\w*|raspberr\w*|blueberr\w*|blackberr\w*|cranberr\w*|cherr\w*|berr\w*|apples?|peach\w*|pears?|plums?|mangos?|mangoes|pineapple|bananas?|oranges?|lemons?|limes?|grapefruit|tangerine|mandarin|grapes?|watermelon|melon|pomegranate|passionfruit|dragonfruit|guava|kiwi|hibiscus|ginger|mint|peppermint|coffee|mocha|espresso|latte|matcha|chai|green|black|garlic|onion|chive|herb|basil|oregano|rosemary|thyme|dill|cilantro|nacho|cool|taco|fajita|queso|salsa|verde|picante|pesto|alfredo|vodka|marinara|bolognese|soup|stew|chowder|bisque|broth|stock|ramen|noodles?|pasta|macaroni|mac|shells|spaghetti|penne|rotini|ravioli|tortellini|gnocchi|lasagna|pizza|rolls?|burritos?|taquitos?|quesadillas?|enchiladas?|tacos?|tortillas?|wraps?|bread|loaf|bagels?|buns?|muffins?|croissants?|biscuits?|waffles?|pancakes?|toaster|pastr\w*|poptarts?|donuts?|doughnuts?|bismarks?|danish|fritters?|cakes?|cupcakes?|brownies?|pies?|tarts?|cookies?|wafers?|crackers?|pretzels?|chips?|crisps?|puffs?|popcorn|cereal|flakes|granola|oatmeal|oats|bars?|bites?|thins|stuf|minis|rings|tots|fries|mash|mashed|puree|applesauce|sauce|syrup|dressing|dip|spread|jam|jelly|preserves|margarine|oil|vinegar|gravy|seasoning|powder|mix|flour|starch|frosting|icing|cand\w*|gumm\w*|truffles?|cups?|bark|jerky|sticks?|patt\w*|burgers?|nuggets?|tenders?|strips?|fillets?|steaks?|roast|chops?|wings?|franks?|wieners?|hotdogs?|deli|slices|shreds|chunks?|ice|gelato|sorbet|sherbet|popsicle|yogurt|pudding|jello|gelatin|creamer|milkshake|shakes?|smoothie|juice|cider|lemonade|limeade|tea|kombucha|soda|cola|water|seltzer|sparkling|energy|electrolyte|supplement|kcup|pods|sandwich\w*|salad|kit|olives|pickles|guacamole|hummus|diet|zero|sugarfree|unsweetened|sweetened|light|lite|low|less|reduced|free|nonfat|lowfat|skim|whole|fat|sodium|salt|lightly|keto|carb|gluten|grain|dairy|nondairy|lactose|vegan|vegetarian|plant|organic|decaf|caffeine|protein|high|ultra|pro|elite|plus|advanced|sport|extra|creamy|crunchy|smooth|whipped|thick|thin|double|mega|stuffed|filled|glazed|frosted|unfrosted|baked|fried|kettle|wavy|ridged|pulp|raw|uncured|cured|boneless|skinless|seedless|pitted)$/i;

/**
 * Verifies that every brand named in `query` matches `entry` and that every distinctive query token
 * (after stripping pack/weight/marketing noise) is explained strictly by `entry.brand + entry.title + entry.keywords`
 * (plus upward parent/retailer brand aliases). Broad `entry.match` regexes never explain tokens.
 * - Leading non-modifier token outside `entry` always rejects.
 * - <= 4 distinctive tokens: 100% must be explained.
 * - > 4 distinctive tokens: <= 34% may be unexplained, and none may be a flavor, product form,
 *   variant modifier, or different known brand.
 */
export function passesCatalogIdentityGuard(
  query: string,
  entry: { brand: string; title: string; keywords?: string[]; match: RegExp },
): boolean {
  const entryHaystackRaw = `${entry.brand} ${entry.title} ${(entry.keywords || []).join(" ")}`;
  const entryBrandHaystack = buildCandidateBrandHaystack(entryHaystackRaw);

  // 1. Any different brand named in the query always rejects.
  if (hasConflictingBrand(query, entryHaystackRaw)) return false;
  for (const qb of detectQueryBrands(query)) {
    const nb = normalizeBrandPhrase(qb);
    if (!nb) continue;
    const alts =
      nb === "coke" || nb === "coca cola" || nb === "cocacola"
        ? ["coke", "coca cola", "cocacola"]
        : nb === "rxbar" || nb === "rx bar" || nb === "rxbars"
          ? ["rx", "rxbar", "rx bar"]
          : [nb];
    if (!alts.some((alt) => containsWholeBrandPhrase(entryBrandHaystack, alt))) {
      return false;
    }
  }

  // 2. Capture any >=4-char truncated trailing prefix token (e.g. "Bisma..." -> "bisma") before stripping noise.
  const truncPrefixes = new Set<string>();
  const truncMatch = query.trim().match(/\b([a-z]{4,})['’]?\.{2,}\s*$/i);
  if (truncMatch) {
    truncPrefixes.add(truncMatch[1].toLowerCase());
  }

  let strippedQuery = query
    .replace(/\s*[.,•|\-]?\s*\bbased\s+on(?:\s+[\d,]+\s+ratings?|\s+customer\s+ratings?|\s+star\s+ratings?)?\s*[.,•|\-]*$/i, " ")
    .replace(/,\s*(?:now|was)\b.*$/i, " ")
    .replace(/\bfree\s+of\s+top\s+\d+\s+allergens?\b/gi, " ")
    .replace(/\btop\s+\d+\s+allergen[\s-]*free\b/gi, " ")
    .replace(/\b100%\s+(?:all\s+)?natural\s+ingredients?\b/gi, " ")
    .replace(/\b(?:breakfast|comfort|frozen)\s+foods?\b/gi, " ")
    .replace(/\b(?:kids'?|school|lunch(?:\s*box)?)\s+(?:snacks?|lunch|drinks?|breakfast|treats?)\b/gi, " ")
    .replace(/\bshelf[\s-]*stable\b/gi, " ")
    .replace(/\bpantry\s+staples?\b/gi, " ")
    .replace(/\bsoft\s*(?:&|and)\s*moist\b/gi, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:g|mg|mcg|kcal|cal)\s+(?:of\s+)?[a-z]*\.{2,}/gi, " ")
    .replace(/\b\d+\s+[a-z]{1,3}\.{2,}/gi, " ")
    .replace(/\bserves\s+\d+(?:\s*[-–—]\s*\d+)?\b/gi, " ")
    .replace(/\b(?:family|party|value|mega|giant|king|share|fun|snack|travel|club|bulk|big)\s+(?:size|pack)\b/gi, " ")
    .replace(
      /\b\d+(?:\.\d+)?(?:\s*[-–—x×/]\s*\d+(?:\.\d+)?)?\s*(?:fl\.?\s*oz|oz|ounces?|lbs?|pounds?|g|grams?|kg|mg|ml|l|liters?|gal|gallons?|qt|quarts?|pt|pints?|ct|count|pk|packs?|pcs?|pieces?|slices?|cans?|bottles?|jars?|boxes?|bags?|pouches?|tubs?|cartons?|trays?|cups?|rolls?|tubes?|bricks?|dozens?)\b\.?/gi,
      " ",
    )
    .replace(/\bpack\s+of\s+\d+\b/gi, " ")
    .replace(/\bsoda\s+pop\b/gi, "soda");

  if (/\b(cheerios|oats?|oatmeal)\b/i.test(query)) {
    strippedQuery = strippedQuery.replace(/\bheart\s+healthy\b/gi, " ");
  }

  const rawQueryTokens = tokens(strippedQuery);
  const distinctive = rawQueryTokens.filter((t) => !CATALOG_MARKETING_NOISE_TOKENS.has(t));
  if (distinctive.length === 0) return true;

  const entryTokens = tokens(`${entryHaystackRaw} ${entryBrandHaystack}`);

  const isExplained = (qt: string): boolean => {
    if (entryTokens.some((et) => tokenEquivalent(et, qt))) return true;
    if (truncPrefixes.has(qt) && qt.length >= 4 && entryTokens.some((et) => et.startsWith(qt))) return true;
    return false;
  };

  // Leading non-modifier brand/anchor token outside the entry's brand/title/keywords always rejects
  if (
    rawQueryTokens.length >= 2 &&
    !GENERIC_LEADING_MODIFIERS.has(rawQueryTokens[0]) &&
    !CATALOG_MARKETING_NOISE_TOKENS.has(rawQueryTokens[0]) &&
    !isExplained(rawQueryTokens[0])
  ) {
    return false;
  }

  const unexplained = distinctive.filter((qt) => !isExplained(qt));
  if (unexplained.length === 0) return true;
  if (distinctive.length <= 4) return false;
  if (unexplained.length / distinctive.length > 0.34) return false;

  for (const ut of unexplained) {
    if (FLAVOR_TOKENS.has(ut) || CATALOG_CRITICAL_UNEXPLAINED_TOKEN_RE.test(ut)) return false;
    if (detectQueryBrands(ut).length > 0) return false;
  }
  return true;
}

const CATEGORY_HEAD_CONFLICT_NOUN_RE =
  /\b(peanuts?|almonds?|cashews?|pecans?|walnuts?|pistachios?|hazelnuts?|macadamias?|nuts?|seeds?|pepitas|popcorn|pretzels?|chips?|crisps?|crackers?|tortillas?|tostadas?|wraps?|cookies?|wafers?|brownies?|cakes?|cupcakes?|muffins?|donuts?|doughnuts?|pastries|pastry|pies?|waffles?|pancakes?|bread|bagels?|buns?|rolls?|croissants?|biscuits?|cereal|granola|oatmeal|oats|bars?|gummies|cand(?:y|ies)|ice\s+cream|gelato|sorbet|yogurt|cheese|milk|soda|juice|lemonade|tea|coffee|soup|chowder|broth|ramen|noodles?|pasta|pizza|burritos?|tacos?|quesadillas?|enchiladas?|dumplings?|potstickers?|nuggets?|tenders?|wings?|strips?|burgers?|patties|sausage|bacon|ham|hot\s*dogs?|franks?|jerky|chicken|beef|pork|turkey|salmon|shrimp|tuna|fish|beans?|chickpeas?|lentils?|hummus|pickles?)\b/gi;

/**
 * Prevents `CATEGORY_FALLBACK_CATALOG` entries from hijacking queries where the matched category word
 * is only a modifier before a different food head noun (e.g. "Honey Roasted Peanuts" -> Natural Sweeteners,
 * "wasabi almonds" -> Horseradish & Wasabi Condiments, "Peanut Butter Chocolate Chip Bar" -> Peanut Butter).
 */
function passesCategoryFallbackHeadGuard(
  query: string,
  cat: { match: RegExp; brand: string },
): boolean {
  const stripped = query
    .replace(/\s*[.,•|\-]?\s*\bbased\s+on.*$/i, " ")
    .replace(
      /\b\d+(?:\.\d+)?(?:\s*[-–—x×/]\s*\d+(?:\.\d+)?)?\s*(?:fl\.?\s*oz|oz|ounces?|lbs?|pounds?|g|grams?|kg|ml|l|liters?|gal|gallons?|qt|quarts?|pt|pints?|ct|count|pk|packs?|pcs?|pieces?|cans?|bottles?|jars?|boxes?|bags?|pouches?|tubs?|cartons?|trays?|dozens?)\b\.?/gi,
      " ",
    )
    .replace(/\b(?:jar|bottle|can|bag|box|tub|carton|pouch|pack|package|container|squeeze)\b/gi, " ")
    .trim();

  const headClause = (
    stripped.split(/\b(?:with|w\/|in|topped\s+with|filled\s+with|stuffed\s+with|dipped\s+in|drizzled\s+with|coated\s+in)\b/i)[0] ||
    stripped
  ).trim();

  if (!cat.match.test(headClause)) return false;

  const globalRe = new RegExp(cat.match.source, `${cat.match.flags.replace("g", "")}g`);
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = globalRe.exec(headClause)) !== null) {
    lastEnd = m.index + m[0].length;
    if (m.index === globalRe.lastIndex) globalRe.lastIndex++;
  }
  if (lastEnd < 0) return false;

  const afterMatch = headClause.slice(lastEnd);
  CATEGORY_HEAD_CONFLICT_NOUN_RE.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = CATEGORY_HEAD_CONFLICT_NOUN_RE.exec(afterMatch)) !== null) {
    const noun = cm[0];
    const inCatMatch = cat.match.test(noun);
    const inCatBrand = new RegExp(`\\b${noun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(cat.brand);
    if (!inCatMatch && !inCatBrand) {
      return false;
    }
  }
  return true;
}

const WHOLE_FOOD_COMMON_POST_DESCRIPTORS = new Set([
  "each", "ea", "bunch", "bunches", "bag", "bags", "bagged", "tray", "trays", "pack", "packs",
  "package", "packaged", "box", "boxes", "container", "clamshell", "carton", "pint", "pints",
  "quart", "quarts", "lb", "lbs", "pound", "pounds", "oz", "ounce", "ounces", "ct", "count",
  "bulk", "loose", "single", "singles", "dozen", "small", "medium", "large", "jumbo", "mini",
  "petite", "baby", "extra", "xl", "family", "value",
  "fresh", "raw", "whole", "organic", "conventional", "natural", "all", "pure", "unwashed",
  "washed", "triple", "prewashed", "local", "grown", "usa", "california", "idaho", "washington",
  "florida", "mexico", "imported", "greenhouse", "hydroponic", "heirloom", "ripe", "seedless",
  "pitted", "unpitted", "hulled", "unhulled", "shelled", "unshelled", "in", "shell", "unblanched", "blanched",
  "unsalted",
  "cut", "cuts", "chopped", "diced", "sliced", "halves", "halved", "quarters", "quarter",
  "quartered", "florets", "floret", "hearts", "spears", "spear", "stalks", "stalk", "crowns", "crown",
  "leaves", "leaf", "sprigs", "sprig", "peeled", "trimmed", "snipped", "shredded", "slivered",
  "crushed", "minced", "riced", "spiralized", "cubed", "chunks", "pieces", "wedges", "segments",
  "medallions", "clusters", "on", "the", "vine", "stem", "cob", "ear", "ears", "head", "heads",
  "bulb", "bulbs", "cloves", "clove", "root", "of", "and", "or",
]);

const WHOLE_FOOD_PRODUCE_DESCRIPTORS = new Set([
  ...WHOLE_FOOD_COMMON_POST_DESCRIPTORS,
  // Produce varieties, cultivars, colors, and botanical parts (supports both pre-noun & inverted "<Noun>, <Variety>")
  "honeycrisp", "gala", "fuji", "granny", "smith", "pink", "lady", "cosmic", "crisp", "mcintosh",
  "envy", "jazz", "kanzi", "braeburn", "cortland", "empire", "golden", "delicious",
  "russet", "yukon", "gold", "fingerling", "baking",
  "roma", "cherry", "grape", "beefsteak", "campari", "plum", "vine",
  "vidalia", "walla", "sweet", "bell", "english", "persian", "kirby", "pickling",
  "hass", "navel", "valencia", "cara", "blood", "mandarin", "clementine", "meyer", "key",
  "bartlett", "anjou", "bosc", "asian", "bing", "rainier", "concord", "cotton",
  "portobello", "portabella", "cremini", "crimini", "bella", "shiitake", "button", "oyster", "enoki",
  "acorn", "butternut", "delicata", "kabocha", "yellow", "summer", "winter",
  "romaine", "iceberg", "butterhead", "bibb", "boston", "rainbow", "swiss", "tuscan", "lacinato", "curly",
  "red", "green", "white", "black", "purple", "orange",
  "fruit", "fruits", "vegetable", "vegetables", "produce", "herb", "herbs", "garden", "flat",
]);

const WHOLE_FOOD_NUTS_DESCRIPTORS = new Set([
  ...WHOLE_FOOD_COMMON_POST_DESCRIPTORS,
  "dry", "dried", "sprouted", "english", "spanish", "marcona", "valencia",
  "black", "red", "green", "brown", "white", "yellow", "french", "beluga", "golden", "light", "dark",
  "nuts", "nut", "seeds", "seed", "beans", "bean", "peas", "pea", "kernels", "hearts",
]);

const WHOLE_FOOD_MEAT_DESCRIPTORS = new Set([
  ...WHOLE_FOOD_COMMON_POST_DESCRIPTORS,
  "beef", "chicken", "pork", "turkey", "lamb", "veal", "bison",
  "fillet", "fillets", "filet", "filets", "steak", "steaks", "roast", "roasts", "chop", "chops",
  "loin", "loins", "tenderloin", "tenderloins", "breast", "breasts", "thigh", "thighs",
  "drumstick", "drumsticks", "wing", "wings", "leg", "legs", "rib", "ribs", "brisket", "chuck",
  "sirloin", "ribeye", "flank", "skirt", "shank", "shoulder", "belly", "cutlet", "cutlets",
  "strip", "tails", "tail", "claws", "meat", "portions", "portion", "boneless", "skinless",
  "skin", "bone", "in", "on", "off", "peeled", "deveined", "easy", "peel", "with", "without",
  "frozen", "thawed", "previously", "wild", "caught", "farm", "raised", "grass", "fed", "finished",
  "pasture", "cage", "free", "range", "antibiotic", "hormone", "vegetarian", "grade", "aa", "a",
  "usda", "prime", "choice", "select", "angus", "lean", "fat",
  "atlantic", "pacific", "alaskan", "alaska", "sockeye", "coho", "chinook", "king", "pink",
  "norwegian", "scottish", "chilean", "gulf", "argentine", "maine", "key", "west", "sea", "bay",
  "white", "brown", "red", "black", "yellowfin", "ahi", "bluefin", "albacore", "skipjack", "mahi",
  "new", "york", "ny", "kansas", "city", "top", "bottom", "round", "eye", "flat", "iron",
  "tri", "tip", "t", "center", "thick", "thin", "ground", "young", "hen", "tom",
  "cornish", "game", "split", "half", "uncooked", "chilled", "air", "humanely", "certified",
  "american", "wagyu", "kobe", "grassfed", "pastured", "cagefree", "freerange", "non", "gmo",
  "never", "ever", "hormones", "antibiotics", "steroids", "colossal",
]);

const MEAT_SPECIES_FAMILIES: RegExp[] = [
  /\b(?:beef|veal|angus|wagyu|kobe|ribeye|sirloin|brisket)\b/,
  /\bchicken\b/,
  /\bpork\b/,
  /\bturkey\b/,
  /\blamb\b/,
  /\bbison\b/,
  /\bsalmon\b/,
  /\btuna\b/,
  /\bshrimp\b/,
  /\bcod\b/,
  /\btilapia\b/,
  /\bhaddock\b/,
  /\bhalibut\b/,
  /\btrout\b/,
  /\bmahi\b/,
  /\bswordfish\b/,
  /\bcatfish\b/,
  /\bsnapper\b/,
  /\bbass\b/,
  /\bscallops?\b/,
  /\bcrab\b/,
  /\blobster\b/,
  /\beggs?\b/,
];

/**
 * Enforces that a single whole-food head noun anchors the phrase:
 * - Strips explicit "no salt added" / "without salt" / "no water added" / "no added hormones" claims first
 *   (while bare "salt", "water", or "added" is rejected).
 * - Requires `matchCount === 1` (and <= 1 animal/seafood species in meat mode) so multi-ingredient dishes
 *   and blends ("Beef & Broccoli", "beef and turkey", "pork and shrimp", "tuna steak in water") never pass.
 * - Checks BOTH words before and words after the matched noun against category-specific descriptor sets.
 */
export function hasWholeFoodHeadNoun(
  rawQuery: string,
  nounRegex: RegExp,
  options?: { checkBefore?: boolean; allowMeatCuts?: boolean; mode?: "produce" | "meat" | "nuts" },
): boolean {
  const cleaned = rawQuery
    .replace(STORE_HOUSE_WHOLE_FOOD_BRAND_RE, " ")
    .toLowerCase()
    .replace(/\s*[.,•|\-]?\s*\bbased\s+on(?:\s+[\d,]+\s+ratings?|\s+customer\s+ratings?|\s+star\s+ratings?)?\s*[.,•|\-]*$/i, " ")
    .replace(/,\s*(?:now|was)\b.*$/i, " ")
    .replace(/\b(?:priced|price)\s+per\s+(?:pound|lb)\b/gi, " ")
    .replace(
      /\b(?:no\s+salt\s+added|without\s+salt|salt[\s-]+free|no\s+water\s+added|without\s+added\s+water|no\s+(?:added\s+)?(?:hormones?|antibiotics?|steroids?|preservatives?|nitrates?|nitrites?)|never\s+any\s+(?:hormones?|antibiotics?))\b/gi,
      " ",
    )
    .replace(
      /\b\d+(?:\.\d+)?(?:\s*[-–—x×/]\s*\d+(?:\.\d+)?)?\s*(?:%|fl\.?\s*oz|oz|ounces?|lbs?|pounds?|g|grams?|kg|ct|count|pk|packs?|pcs?|pieces?|dozens?)\b/gi,
      " ",
    )
    .replace(/\b\d+(?:\.\d+)?\b/g, " ");

  const mode = options?.mode ?? (options?.allowMeatCuts ? "meat" : "produce");
  if (mode === "meat") {
    let speciesCount = 0;
    for (const spRe of MEAT_SPECIES_FAMILIES) {
      if (spRe.test(cleaned)) speciesCount++;
    }
    if (speciesCount > 1) return false;
  }

  const globalRe = new RegExp(nounRegex.source, "gi");
  let lastMatch: RegExpExecArray | null = null;
  let matchCount = 0;
  let m: RegExpExecArray | null;
  while ((m = globalRe.exec(cleaned)) !== null) {
    lastMatch = m;
    matchCount++;
    if (m.index === globalRe.lastIndex) globalRe.lastIndex++;
  }
  if (!lastMatch || matchCount !== 1) return false;

  const descriptorSet =
    mode === "meat"
      ? WHOLE_FOOD_MEAT_DESCRIPTORS
      : mode === "nuts"
        ? WHOLE_FOOD_NUTS_DESCRIPTORS
        : WHOLE_FOOD_PRODUCE_DESCRIPTORS;

  const beforeText = cleaned.slice(0, lastMatch.index);
  const afterText = cleaned.slice(lastMatch.index + lastMatch[0].length);

  const afterWords = afterText.split(/[^a-z]+/).filter(Boolean);
  if (afterWords.some((w) => !descriptorSet.has(w))) return false;

  if (options?.checkBefore !== false) {
    const beforeWords = beforeText.split(/[^a-z]+/).filter(Boolean);
    if (beforeWords.some((w) => !descriptorSet.has(w))) return false;
  }
  return true;
}

const NON_BRAND_CATEGORY_LABELS =
  /^(?:Representative\b|Fresh Produce$|Canned Vegetables$|100% Fruit Juice$|Grade A Dairy$|Baked Crackers$|Rotisserie Deli$|Grilled Poultry$|Breaded Poultry$|Cured Pork Bacon$|Natural Uncured$|Sweetened Dried Fruit$|Freeze-Dried$|Mediterranean Olives$|Extra Virgin Olive Oil$|USDA Organic Grass-Fed Beef$)/i;

const BARE_PURE_WATER_QUERY_RE =
  /^(?:(?:100%\s+)?(?:plain|pure|fresh|bottled|tap|filtered|purified|drinking|distilled)\s+){0,2}water$/i;

function catalogFallback(query: string): Omit<LookupResult, "ms"> | null {
  const cleanTitle = normalizeOffDisplayTitle(
    query
      .trim()
      .replace(/\s*[.,•|\-]?\s*\bbased\s+on(?:\s+[\d,]+\s+ratings?|\s+customer\s+ratings?|\s+star\s+ratings?)?\s*[.,•|\-]*$/i, "")
      .replace(/,?\s*\b(?:priced|price)\s+per\s+(?:pound|lb)\b.*$/i, "")
      .replace(/\s*,\s*\d+\s*\.\.\.+$/, "")
      .replace(/,\s*(now|was)$/i, "")
      .replace(/\s*[.,•|\-]+\s*$/, ""),
  );

  // Resolve bare unbranded pure water queries ("Water", "Purified water", "Plain water", "Drinking water", "Distilled water")
  // cleanly so they never fall through to unrelated branded/sparkling OFF matches and score 100/100 without altering rubric math.
  const bareWaterCandidate = cleanSearchQuery(cleanTitle) || cleanTitle;
  if (BARE_PURE_WATER_QUERY_RE.test(bareWaterCandidate.trim())) {
    const pureWaterIngredients = /\bdistilled\b/i.test(bareWaterCandidate)
      ? "Distilled Water."
      : /\bpurified\b/i.test(bareWaterCandidate)
        ? "Purified Water."
        : /\bfiltered\b/i.test(bareWaterCandidate)
          ? "Filtered Water."
          : "Drinking Water.";
    return {
      sourceUrl: "https://fdc.nal.usda.gov/food-details/173647/nutrients",
      productTitle: cleanTitle || "Water",
      brand: "Pure Water",
      category: "Waters & Seltzers",
      description:
        "Pure unflavored water with 0 calories, 0 sugar, 0 sodium, and 0 synthetic additives (USDA FoodData Central).",
      ingredients: pureWaterIngredients,
      imageUrl: undefined,
      nutrition: {
        caloriesKcal100g: 0,
        sugarsG100g: 0,
        saturatedFatG100g: 0,
        sodiumMg100g: 0,
        fiberG100g: 0,
        proteinG100g: 0,
        fruitsVegNutsPct: 0,
        nutriScoreGrade: "a",
        isOrganic: false,
        isWholeFood: false,
      },
      source: "catalog",
      sourceUpdatedAt: "2026-11-18",
    };
  }

  // Check Just Bare before generic breaded poultry
  if (/\bjust\s+bare\b/i.test(query)) {
    const jbTitle = "Just Bare Lightly Breaded Chicken Breast Strips";
    const jbIng =
      "Boneless Skinless Chicken Breast with Rib Meat, Water, Wheat Flour, Contains 2% or Less of: Yellow Corn Flour, Sea Salt, Rice Starch, Spices, Dried Garlic, Dried Onion, Paprika, Yeast, Cream of Tartar, Sodium Bicarbonate.";
    const jbSourceUrl = "https://www.justbarefoods.com/product/lightly-breaded-chicken-breast-strips/";
    if (
      hasValidCatalogProvenance(jbSourceUrl, "2026-11-08") &&
      passesVariantGuard(query, jbTitle) &&
      passesCatalogIdentityGuard(query, {
        brand: "Just Bare",
        title: "Lightly Breaded Chicken Breast Strips",
        match: /\bjust\s+bare\b/i,
      }) &&
      !isDietaryOrVariantMismatch(query, jbTitle, jbIng)
    ) {
      return {
        sourceUrl: jbSourceUrl,
        productTitle: jbTitle,
        brand: "Just Bare",
        ingredients: jbIng,
        imageUrl: `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(jbTitle)}&v=4`,
        nutrition: { caloriesKcal100g: 175, sugarsG100g: 1.0, saturatedFatG100g: 1.5, sodiumMg100g: 380, fiberG100g: 1.0, proteinG100g: 18.5, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isWholeFood: false, isOrganic: false },
        source: "catalog",
        sourceUpdatedAt: "2026-11-08",
      };
    }
  }

  // Check comprehensive Drinks & Beverages Catalog (Energy Drinks, Pre-Workouts, Sodas, Milks, Waters, Juices, Sports Drinks, Tea/Coffee)
  const drinkHit = matchDrinkCatalog(query);
  if (
    drinkHit &&
    passesCatalogIdentityGuard(query, drinkHit) &&
    !isDietaryOrVariantMismatch(query, drinkHit.title, drinkHit.ingredients, drinkHit.nutrition)
  ) {
    const fullDrinkTitle = mergeBrandAndTitle(drinkHit.brand, drinkHit.title);
    const curatedDrink = lookupCuratedPhoto({
      brand: drinkHit.brand,
      title: fullDrinkTitle,
      barcode: drinkHit.barcode,
    });
    const directDrinkImg =
      drinkHit.imageUrl?.startsWith("https://")
        ? drinkHit.imageUrl
        : curatedDrink?.imageUrl?.startsWith("https://")
          ? curatedDrink.imageUrl
          : undefined;
    return {
      sourceUrl: drinkHit.sourceUrl,
      productTitle: fullDrinkTitle,
      brand: drinkHit.brand,
      barcode: drinkHit.barcode || curatedDrink?.barcode,
      category: drinkHit.category,
      description: drinkHit.description,
      ingredients: drinkHit.ingredients,
      imageUrl: directDrinkImg,
      nutrition: { ...drinkHit.nutrition, isOrganic: drinkHit.nutrition?.isOrganic === true },
      source: "catalog",
      sourceUpdatedAt: drinkHit.verifiedAt,
    };
  }

  for (const entry of INSTANT_GROCERY_CATALOG) {
    const isRepresentativeEntry = /representative|category\s+estimate/i.test(`${entry.brand} ${entry.title}`);
    if (
      isRepresentativeEntry &&
      (NAMED_BRAND_GUARD.test(query) || detectQueryBrand(query) !== "") &&
      !/\bjimmy\s+dean\b/i.test(query)
    ) {
      continue;
    }
    if (
      hasValidCatalogProvenance(entry.sourceUrl, entry.verifiedAt) &&
      !entry.title.includes("/") &&
      !entry.brand.includes("/") &&
      entry.match.test(query) &&
      passesVariantGuard(query, entry.title) &&
      !hasConflictingBrand(query, `${entry.brand} ${entry.title} ${(entry.keywords || []).join(" ")}`) &&
      passesCatalogIdentityGuard(query, entry) &&
      !isDietaryOrVariantMismatch(query, entry.title, entry.ingredients, entry.nutrition)
    ) {
      const resolvedTitle = NON_BRAND_CATEGORY_LABELS.test(entry.brand)
        ? entry.title
        : mergeBrandAndTitle(entry.brand, entry.title);
      const curatedGrocery =
        lookupCuratedPhoto({
          brand: entry.brand,
          title: entry.title,
          barcode: entry.barcode,
        }) ??
        lookupCuratedPhoto({
          brand: NON_BRAND_CATEGORY_LABELS.test(entry.brand) ? "" : entry.brand,
          title: resolvedTitle,
          barcode: entry.barcode,
        });
      const resolvedImageUrl = entry.imageUrl?.startsWith("https://images.openfoodfacts.org/")
        ? entry.imageUrl
        : curatedGrocery?.imageUrl?.startsWith("https://")
          ? curatedGrocery.imageUrl
          : undefined;
      return {
        sourceUrl: entry.sourceUrl,
        productTitle: resolvedTitle,
        brand: entry.brand,
        barcode: entry.barcode || curatedGrocery?.barcode,
        ingredients: entry.ingredients,
        imageUrl: resolvedImageUrl,
        nutrition: { ...entry.nutrition, isOrganic: entry.nutrition?.isOrganic === true },
        source: "catalog",
        sourceUpdatedAt: entry.verifiedAt,
      };
    }
  }
  const s = query.toLowerCase();
  if (NON_FOOD_GUARD.test(s)) {
    return null;
  }
  const detectedBrandForFallback = detectQueryBrand(query);
  const queryWithoutStoreHouseBrand = query.replace(STORE_HOUSE_WHOLE_FOOD_BRAND_RE, " ").trim();
  const hasNonStoreBrand =
    NAMED_BRAND_GUARD.test(queryWithoutStoreHouseBrand.toLowerCase()) ||
    detectQueryBrand(queryWithoutStoreHouseBrand) !== "";
  if (hasNonStoreBrand) {
    return null;
  }

  if (!detectedBrandForFallback && !NAMED_BRAND_GUARD.test(s)) {
    for (const cat of CATEGORY_FALLBACK_CATALOG) {
      if (
        hasValidCatalogProvenance(cat.sourceUrl, cat.verifiedAt) &&
        cat.match.test(query) &&
        passesCategoryFallbackHeadGuard(query, cat) &&
        (!/\borganic\b/i.test(query) || /\borganic\b/i.test(cat.brand)) &&
        !isDietaryOrVariantMismatch(query, cat.brand, cat.ingredients, cat.nutrition) &&
        !isDietaryOrVariantMismatch(query, `${cat.brand} ${cleanTitle}`, cat.ingredients, cat.nutrition)
      ) {
        return {
          sourceUrl: cat.sourceUrl,
          productTitle: `${cleanTitle} (Category Estimate)`,
          brand: `${cat.brand} (Category Estimate — Verify Package Label)`,
          description:
            "Representative category formulation shown because an exact product/UPC label was not returned by Open Food Facts or USDA. Formulations vary by brand and batch; always verify the physical package label.",
          ingredients: `${cat.ingredients} [Representative Category Formulation — Verify Physical Package Label]`,
          imageUrl: undefined,
          nutrition: { ...cat.nutrition, isOrganic: cat.nutrition.isOrganic === true },
          source: "catalog",
          sourceUpdatedAt: cat.verifiedAt,
        };
      }
    }
  }

  if (PROCESSED_FOOD_GUARD.test(s)) {
    return null;
  }

  // Generic USDA whole-food fallbacks (produce, meat/eggs, raw nuts/seeds) represent unverified
  // single-ingredient whole foods and must NEVER assert verified USDA Organic certification from free-text queries.
  const storeHouseBrandLabel = detectedBrandForFallback ? normalizeOffDisplayTitle(detectedBrandForFallback) : "";

  // 1. Fresh Produce, Fruits, Vegetables, Herbs & Salad Greens (strictly single-ingredient)
  const PRODUCE_NOUN_RE =
    /\b(romaine\s+(?:lettuce|hearts|salad)|butter(?:head)?\s+lettuce|lettuce\s*,?\s*butter(?:head)?|butter\s+potato(?:es)?|potato(?:es)?\s*,?\s*butter|spaghetti\s+squash|squash\s*,?\s*spaghetti|ambrosia\s+apples?|apples?\s*,?\s*ambrosia|cosmic\s+crisp\s+apples?|apples?\s*,?\s*cosmic\s+crisp|italian\s+(?:parsley|plums?|squash)|iceberg\s+lettuce|(?:red\s+|green\s+)?leaf\s+lettuce|(?:spinach|kale|arugula|spring|field|garden|mixed|baby)\s+(?:salad|greens)|salad\s+(?:greens|mix)|spring\s+mix|grape\s+tomato(?:es)?|cherry\s+tomato(?:es)?|plum\s+tomato(?:es)?|roma\s+tomato(?:es)?|orange\s+(?:bell\s+|sweet\s+)?peppers?|(?:(?:red|green|yellow)\s+)?bell\s+peppers?|sweet\s+peppers?|sweet\s+potato(?:es)?|green\s+onions?|spring\s+onions?|green\s+beans?|string\s+beans?|(?:sugar\s+)?snap\s+peas?|snow\s+peas?|brussels\s+sprouts?|bok\s+choy|ginger\s+gold\s+apples?|(?:fresh|organic)\s+(?:[a-z]+\s+)*mint|mint\s+(?:leaves|leaf|bunch|bunches|sprigs?|herb)|lettuce|romaine|spinach|kale|arugula|cabbage|broccoli|cauliflower|carrots?|celery|cucumbers?|tomato(?:es)?|potato(?:es)?|yams?|onions?|scallions?|shallots?|leeks?|garlic|ginger|parsley|cilantro|basil|rosemary|thyme|dill|sage|chives|oregano|peppers?|mushrooms?|avocados?|zucchini|squash|pumpkin|asparagus|beets?|radish\w*|turnips?|eggplants?|artichokes?|okra|fennel|chard|collards?|edamame|peas?|apples?|bananas?|strawberr(?:y|ies)|blueberr(?:y|ies)|raspberr(?:y|ies)|blackberr(?:y|ies)|cranberr(?:y|ies)|cherr(?:y|ies)|grapes?|oranges?|mandarins?|clementines?|tangerines?|grapefruits?|lemons?|limes?|peaches?|plums?|nectarines?|apricots?|pears?|kiwis?|mangos?|mangoes|pineapples?|watermelons?|cantaloupes?|honeydews?|papayas?|pomegranates?|figs?|dates?|berries|vegetables?|veggies|fresh\s+produce)\b/;
  if (PRODUCE_NOUN_RE.test(s) && hasWholeFoodHeadNoun(query, PRODUCE_NOUN_RE, { checkBefore: true, mode: "produce" })) {
    const produceCurated = lookupCuratedPhoto({ brand: storeHouseBrandLabel || "Fresh Produce", title: cleanTitle });
    return {
      sourceUrl: "https://fdc.nal.usda.gov/food-details/169247/nutrients",
      productTitle: cleanTitle,
      brand: storeHouseBrandLabel || "Fresh Produce",
      ingredients: "100% Fresh Whole Produce (Single-Ingredient Whole Food).",
      imageUrl: produceCurated?.imageUrl?.startsWith("https://") ? produceCurated.imageUrl : undefined,
      nutrition: { fruitsVegNutsPct: 100, isWholeFood: true, isOrganic: false },
      source: "catalog",
      sourceUpdatedAt: "2026-11-08",
    };
  }

  // 2. Plain Fresh / Frozen Meat, Poultry (Whole Turkey, Chicken Breast Fillets, Beef Bottom Round Roast, etc.), Seafood & Shell Eggs (unbreaded, uncured)
  const MEAT_NOUN_RE =
    /\b(chicken\s+(breasts?|fillets?|cutlets?|thighs?|drumsticks?|wings?|tenderloins?|quarters?|legs?)|whole\s+chicken|young\s+chicken|(?:whole|frozen|young|fresh|antibiotic[- ]?free|organic|pasture[- ]?raised|grade\s+a)\s+turkey|turkey\s+(breasts?|thighs?|drumsticks?|wings?|tenderloins?)|whole\s+turkey|\bturkey\b|ground\s+(beef|chuck|turkey|chicken|pork|bison|lamb)|(?:bottom\s+round|top\s+round|eye\s+of\s+round|rump|chuck|sirloin\s+tip|rib)\s+roast|beef\s+(stew\s+meat|chuck|roast|brisket|sirloin|ribeye|tenderloin|short\s+ribs?|flank|skirt)|stew\s+beef|ribeye|sirloin|filet|new\s+york\s+strip|t-bone|porterhouse|pork\s+(chops?|loin|tenderloin|roast|shoulder|ribs?|belly)|lamb\s+(chops?|leg|shank|rack)|salmon|cod|tilapia|haddock|halibut|trout|mahi|swordfish|catfish|snapper|sea\s+bass|tuna\s+steak|shrimp|scallops?|crab\s+legs?|lobster\s+tails?|large\s+eggs?|white\s+eggs?|brown\s+eggs?|cage[- ]?free\s+eggs?|pasture[- ]?raised\s+eggs?|grade\s+aa?\s+(?:large\s+|extra\s+large\s+|jumbo\s+|medium\s+)?(?:white\s+|brown\s+)?eggs?|\beggs\b)\b/;
  const isFrozenChickenWingsFallback = /\bfrozen\b/i.test(s) && /\bwings?\b/i.test(s) && /\bchicken\b/i.test(s);
  if (!isFrozenChickenWingsFallback && MEAT_NOUN_RE.test(s) && hasWholeFoodHeadNoun(query, MEAT_NOUN_RE, { checkBefore: true, allowMeatCuts: true, mode: "meat" })) {
    const isSkinOnChickenWings = /\bchicken\s+wings?\b/i.test(s) && !/\bskinless\b/i.test(s);
    const wholeMeatIng = /\b(beef|angus|wagyu|ribeye|sirloin|tenderloin|brisket|chuck|round\s+roast|rump\s+roast|new\s+york\s+strip|t-bone|porterhouse)\b/i.test(s)
      ? "100% Beef (Single-Ingredient Unprocessed Whole Food)."
      : /\bchicken\b/i.test(s)
        ? "100% Chicken (Single-Ingredient Unprocessed Whole Food)."
        : /\bturkey\b/i.test(s)
          ? "100% Turkey (Single-Ingredient Unprocessed Whole Food)."
          : /\bpork\b/i.test(s)
            ? "100% Pork (Single-Ingredient Unprocessed Whole Food)."
            : /\blamb\b/i.test(s)
              ? "100% Lamb (Single-Ingredient Unprocessed Whole Food)."
              : /\beggs?\b/i.test(s)
                ? "100% Shell Eggs (Single-Ingredient Whole Food)."
                : "100% Whole Food Protein (Single-Ingredient Unprocessed Meat, Poultry, or Seafood).";
    const meatCurated = lookupCuratedPhoto({ brand: storeHouseBrandLabel || "Fresh Meat & Eggs", title: cleanTitle });
    return {
      sourceUrl: isSkinOnChickenWings
        ? "https://fdc.nal.usda.gov/food-details/172390/nutrients"
        : "https://fdc.nal.usda.gov/food-details/171477/nutrients",
      productTitle: cleanTitle,
      brand: storeHouseBrandLabel || "Fresh Meat & Eggs",
      ingredients: wholeMeatIng,
      imageUrl: meatCurated?.imageUrl?.startsWith("https://") ? meatCurated.imageUrl : undefined,
      nutrition: isSkinOnChickenWings
        ? { caloriesKcal100g: 222, sugarsG100g: 0, saturatedFatG100g: 4.45, sodiumMg100g: 73, fiberG100g: 0, proteinG100g: 18.3, fruitsVegNutsPct: 0, isWholeFood: false, isOrganic: false }
        : { fruitsVegNutsPct: 0, isWholeFood: true, isOrganic: false },
      source: "catalog",
      sourceUpdatedAt: isSkinOnChickenWings ? "2026-11-19" : "2026-11-08",
    };
  }

  // 3. Raw Nuts, Seeds, Legumes & Whole Grains (unflavored, uncandied single-ingredient whole foods)
  const NUTS_NOUN_RE =
    /\b(raw\s+almonds?|whole\s+almonds?|\balmonds?\b|walnuts?|pecans?|cashews?|pistachios?|macadamia\s+nuts?|macadamias?|hazelnuts?|brazil\s+nuts?|pine\s+nuts?|chia\s+seeds?|flax\s*seeds?|hemp\s+(?:seeds?|hearts?)|pumpkin\s+seeds?|pepitas|sunflower\s+seeds?|sesame\s+seeds?|quinoa|lentils?|chickpeas?|garbanzo\s+beans?|black\s+beans?|pinto\s+beans?|kidney\s+beans?|navy\s+beans?|cannellini\s+beans?|great\s+northern\s+beans?|lima\s+beans?|mung\s+beans?|fava\s+beans?|black[- ]?eyed\s+peas?|split\s+peas?)\b/;
  if (NUTS_NOUN_RE.test(s) && hasWholeFoodHeadNoun(query, NUTS_NOUN_RE, { checkBefore: true, mode: "nuts" })) {
    const nutsCurated = lookupCuratedPhoto({ brand: storeHouseBrandLabel || "Whole Nuts, Seeds & Legumes", title: cleanTitle });
    return {
      sourceUrl: "https://fdc.nal.usda.gov/food-details/170567/nutrients",
      productTitle: cleanTitle,
      brand: storeHouseBrandLabel || "Whole Nuts, Seeds & Legumes",
      ingredients: "100% Whole Nuts, Seeds, or Legumes (Single-Ingredient Whole Food).",
      imageUrl: nutsCurated?.imageUrl?.startsWith("https://") ? nutsCurated.imageUrl : undefined,
      nutrition: { fruitsVegNutsPct: 100, isWholeFood: true, isOrganic: false },
      source: "catalog",
      sourceUpdatedAt: "2026-11-08",
    };
  }

  return null;
}

const RETAILER_SEO_COMMA_SEGMENT_RE =
  /^(?:free\s+of\s+top\s+\d+\s+allergens?|top\s+\d+\s+allergen[\s-]*free|allergen[\s-]*free|100%\s+(?:all\s+)?natural\s+ingredients?|soft\s*(?:&|and)\s*moist|\d+\s*g\s+(?:whey\s+|plant\s+)?protein(?:\s+per\s+(?:serving|cup))?|big\s+pack|good\s+source\s+of\s+.+|excellent\s+source\s+of\s+.+|rich\s+in\s+.+|heart\s+healthy|shelf[\s-]*stable|pantry\s+staples?|ready[\s-]*to[\s-]*(?:eat|drink|serve|bake|cook)|easy\s+(?:dinner|meal|lunch|prep)|quick\s+(?:meal|lunch|dinner|breakfast)|comfort\s+foods?|breakfast\s+foods?|breakfast\s+spread|frozen\s+(?:breakfast|food|meal|snack|entree|dessert)s?|fresh\s+deli(?:\s+soup)?|deli\s+soup|refrigerated|frozen|previously\s+frozen|(?:kids'?|school|lunch(?:\s*box)?|office|party|holiday|game\s+day|after[\s-]*school|on[\s-]*the[\s-]*go|bedtime|afternoon|everyday|family)\s+(?:snacks?|breakfast|treats?|drinks?|favorites?|lunch)|snacks?\s+for\s+.+|great\s+for\s+.+|perfect\s+for\s+.+|ideal\s+for\s+.+|snap\s+ebt(?:\s+eligible)?|seasonal(?:\s*[-–—]\s*\w+)?|mini\s+size|regular\s+size|king\s+size|share\s+size|family(?:\s+size|\s+pack)?|mega(?:\s+size|\s+pack)?|giant(?:\s+size)?|party(?:\s+size|\s+pack)?|value(?:\s+size|\s+pack)?|single[\s-]*serve|multi[\s-]*pack|about\s+\d+\s+[a-z]+\s+per\s+pack|serves\s+\d+(?:\s*[-–—]\s*\d+)?)$/i;

const AMBIGUOUS_SHORT_SEO_SEGMENT_RE = /^(?:high\s+(?:in\s+)?fiber|small|medium|large)$/i;
const PRESERVED_VARIANT_ELLIPSIS_TOKEN_RE =
  /\b(?:zero|diet|free|sugar|sweet|unsweet\w*|fat|light|lite|low|less|reduced|no|added|sodium|salt|organic|simply|nkd|healthy|request|protein|pro|elite|plus|ultra|max|keto|gluten|dairy|lactose|vegan|plant|soy|oat|almond|decaf|caffeine|spicy|hot|flamin|jalapeno|habanero|buffalo|chipotle|extra|creamy|crunchy|chunky|raw|sharp|mild|unflavored|plain)\b/i;

/** Strips club-store pack counts, decimal weights, and Walmart/Amazon/Whole Foods promo suffixes for cleaner external API queries. */
export function cleanSearchQuery(title: string): string {
  let out = title
    .replace(/[®™©]/g, "")
    .replace(/^\s*(?:sponsored(?:\s+ad)?|ad(?=\s*[-–—:|•]))\s*[,•|:\-–—]?\s*/i, "")
    .replace(/\s*[.,•|\-]?\s*\bbased\s+on(?:\s+[\d,]+\s+ratings?|\s+customer\s+ratings?|\s+star\s+ratings?)?\s*[.,•|\-]*$/i, "")
    .replace(/,\s*([^,]{0,28}?)(?:\.\.\.+|…)+\s*$/g, (_m, seg: string) => {
      const trimmedSeg = (seg || "").trim();
      if (!trimmedSeg) return "";
      if (PRESERVED_VARIANT_ELLIPSIS_TOKEN_RE.test(trimmedSeg)) {
        return `, ${trimmedSeg}`;
      }
      return "";
    })
    .replace(/(?:\.\.\.+|…)+\s*$/g, "")
    .replace(/,?\s*\b(?:priced|price)\s+per\s+(?:pound|lb)\b.*$/i, "")
    .replace(/,?\s*\b(?:final\s+cost\s+by\s+weight|avg\.?\s+price|average\s+price)\b.*$/i, "")
    .replace(/\s+for\s+(?:sandwiches|sushi|sashimi|dipping|prime\s+rib|steak|salads?|marinades?)\b.*$/i, "")
    .replace(/\s*[-–—|]\s*pack\s+of\s+\d+.*$/i, "")
    .replace(/\s*\(\d+(\.\d+)?\s*(?:fl\.?\s*oz|oz|lb|lbs|ct|count|pk|pack|g|kg|ml|pop[- ]?tarts?|bars?|pouches?|packs?|packets?|cups?|bottles?|cans?|cookies?|pies?|cakes?|waffles?|rolls?|slices?)\.?\)\s*[-–—|]?.*$/i, "")
    .replace(/\s*\(\d*[^)]*$/g, "")
    .replace(/:\s*\d+(?:\s*[-–—]\s*\d+)?\s*(?:fl\.?\s*oz|lbs?|oz|ct|count|pk|pack|g|kg|gal|gallon)\.?\b.*$/i, "")
    .replace(/,\s*(about\s+\d+\s+[a-z]+\s+per\s+pack|serves\s+\d+|\d+(\.\d+)?\s*(fl\.?\s*oz|pk|pack|ct|count|oz|lb|lbs|gal|gallon|qt|pt|g|kg|ml|l|box|bag|tub|can|jar|bottle|carton|cup|bowl|tray|pouch|dozen)\.?(?:\s*(?:can|cans|box|boxes|bag|bags|bottle|bottles|jar|jars|tub|tubs|carton|cartons|pouch|pouches|pack|packs|kit))?)\b.*$/i, "")
    .replace(/\s+\d+(\.\d+)?\s*(fl\.?\s*oz|oz|lb|lbs|gal|gallon|qt|pt|ct|count|pk|pack|dozen)\.?(?:\s*(?:can|cans|box|boxes|bag|bags|bottle|bottles|jar|jars|tub|tubs|carton|cartons|pouch|pouches|pack|packs|kit))?\b.*$/i, "")
    .replace(/\s*[-–—]\s*\d+(\.\d+)?\s*(fl\.?\s*oz|pk|pack|ct|count|oz|lb|lbs|gal|gallon|qt|pt|g|kg|ml|l|dozen)\.?\b.*$/i, "")
    .replace(/\s*\((fresh|refrigerated|frozen)\)\s*$/i, "")
    .replace(/,\s*(now|was)\b.*$/i, "")
    .replace(/\bbig\s+pack\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*[.,•|\-]+\s*$/, "")
    .trim();

  if (out.includes(",")) {
    const rawParts = out.split(",").map((s) => s.trim()).filter(Boolean);
    if (rawParts.length >= 2) {
      const headWords = rawParts[0].split(/\s+/).filter(Boolean);
      if (headWords.length >= 2) {
        const kept = [rawParts[0]];
        let wordAccum = headWords.length;
        for (let i = 1; i < rawParts.length; i++) {
          const seg = rawParts[i];
          if (RETAILER_SEO_COMMA_SEGMENT_RE.test(seg)) {
            continue;
          }
          if (wordAccum >= 4 && AMBIGUOUS_SHORT_SEO_SEGMENT_RE.test(seg)) {
            continue;
          }
          kept.push(seg);
          wordAccum += seg.split(/\s+/).filter(Boolean).length;
        }
        out = kept.join(", ").replace(/\s*[.,•|\-]+\s*$/, "").trim();
      }
    }
  } else {
    out = out
      .replace(
        /\b(?:breakfast\s+foods?|kids['’]?\s+snacks?|lunch(?:\s*box)?\s+snacks?|pantry\s+staples?|shelf[\s-]*stable|value\s+pack|family\s+(?:size|pack)|party\s+(?:size|pack)|mega\s+(?:size|pack)|snap\s+ebt(?:\s+eligible)?|\d+\s+pop[\s-]*tarts?)\b/gi,
        " ",
      )
      .replace(/\s+/g, " ")
      .replace(/\s*[.,•|\-]+\s*$/, "")
      .trim();
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function lookupIngredients(input: LookupInput): Promise<LookupResult | null> {
  const t0 = performance.now();
  const ms = () => Math.round((performance.now() - t0) * 100) / 100;
  const rawTitle = (input.productTitle || "").trim();

  const hasPackagedFoodNoun =
    /\b(chicken|beef|pork|turkey|fish|shrimp|salmon|tuna|sausage|bacon|meatballs?|peas|corn|berries|strawberries|blueberries|raspberries|fruit|vegetables?|broccoli|fries|tots|nuggets?|strips?|tenders?|wings?|pizza|burritos?|waffles?|pancakes?|peanut\s+butter|almond\s+butter|reese'?s|hershey'?s|chocolate|candy|fudge|caramel|ice\s+cream|gelato|sorbet|yogurt|pudding|oatmeal|oats|granola|cereal|soup|broth|rice|pasta|ravioli|dumplings?|popcorn|pretzels?|crackers?|cookies?|chips)\b/i.test(
      rawTitle,
    );
  if (
    rawTitle &&
    (UI_NOISE_QUERY.test(rawTitle) ||
      /\b(toilet\s+paper|paper\s+towels?|bath\s+tissue|facial\s+tissue|disposable\s+(?:forks?|spoons?|knives|cutlery|utensils?|plates?|cups?|bowls?)|plastic\s+(?:forks?|spoons?|knives|cutlery|utensils?|plates?|cups?|bowls?|straws?)|paper\s+(?:plates?|bowls?|napkins?)|trash\s+bags?|garbage\s+bags?|aluminum\s+foil|plastic\s+wrap|parchment\s+paper|topcare|pain\s*&\s*fever|oral\s+suspension|acetaminophen|ibuprofen|tylenol|advil|motrin|benadryl|mucinex|nyquil|dayquil|robitussin|pepto|tums|laxative|antacid|cough\s+syrup|nasal\s+spray|eye\s+drops)\b/i.test(
        rawTitle,
      ) ||
      (!hasPackagedFoodNoun && /\b(paper\s+cups?|storage\s+bags?|freezer\s+bags?|sandwich\s+bags?)\b/i.test(rawTitle)))
  ) {
    return null;
  }

  const rawIng = input.rawIngredients?.trim() || "";
  if (rawIng) {
    // If productTitle is also provided (e.g. from the mobile screen reader or browser extension),
    // verify that rawIngredients is an actual ingredient list and not an adjacent UI heading like "Items to add next".
    if (!rawTitle || isPlausibleScreenIngredients(rawIng)) {
      const normalizedScreenTitle = rawTitle ? normalizeOffDisplayTitle(rawTitle) : "Scanned product";
      const screenImgUrl =
        rawTitle || input.barcode
          ? `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(normalizedScreenTitle)}${input.barcode ? `&code=${encodeURIComponent(input.barcode)}` : ""}&v=6`
          : undefined;
      return {
        productTitle: normalizedScreenTitle,
        barcode: input.barcode,
        ingredients: sanitizeIngredientDisplay(rawIng),
        imageUrl: screenImgUrl,
        nutrition: SUPPLEMENT_FORM.test(`${rawTitle} ${rawIng}`) ? { productKind: "supplement", isOrganic: false } : undefined,
        source: "screen",
        ms: ms(),
      };
    }
  }

  const normBarcode = normalizeBarcode(input.barcode);
  const title = rawTitle ? canonicalizeGroceryQuery(rawTitle) : "";
  const cleanedCatalogTitle = title ? cleanSearchQuery(title) : "";
  const safeCleanedCatalogFallback = (): Omit<LookupResult, "ms"> | null => {
    if (!cleanedCatalogTitle || cleanedCatalogTitle === title) return null;
    const cand = catalogFallback(cleanedCatalogTitle);
    if (!cand) return null;
    if (
      !passesVariantGuard(title, cand.productTitle) ||
      isDietaryOrVariantMismatch(title, cand.productTitle, cand.ingredients, cand.nutrition)
    ) {
      return null;
    }
    return cand;
  };
  const normalizedInput: LookupInput = {
    ...input,
    barcode: normBarcode || undefined,
    productTitle: title,
  };
  const key = cacheKey(normalizedInput);
  if (!key) return null;

  const DIRECT_CATALOG_PRIORITY =
    /\b(pop[- ]?tarts?|simple\s+truth|private\s+selection|good\s*(?:&|and)\s*gather|favorite\s+day|big\s+k|velveeta|lactaid|fairlife|martin'?s|white\s+sandwich\s+bread|great\s+value.*(?:milk|eggs?|bread|water|potato\s+chips)|clancy'?s.*potato\s+chips|kirkland(?:\s+signature)?.*(?:rotisserie\s+chicken|lightly\s+breaded\s+chicken|purified.*water)|berkley\s+jensen.*water|kroger.*purified.*water|member'?s\s+mark.*(?:rotisserie\s+chicken|breaded\s+chicken\s+breast\s+bites|homestyle\s+chicken\s+bites?|grilled\s+chicken\s+(?:breast\s+)?bites?|(?:bone[- ]?in|frozen).*chicken\s+wings?|chicken\s+wings?.*frozen|hickory\s+smoked\s+bacon)|cinnamon\s+toast\s+crunch|cinnamon\s+chex|lucky\s+charms|froot\s+loops|cheerios|quaker\b.*\b(?:oats?|oatmeal)|bob'?s\s+red\s+mill\b.*\b(?:oats?|oatmeal)|doritos|cheetos|cheez[- ]?its?|oreo|triscuit|lay'?s|pringles|barilla|nutella|hidden\s+valley|campbell'?s|kraft\b.*\b(?:mac|macaroni)|pedialyte|planet\s+oat|doubleshot|owyn|liquid\s+death|silk\s+soy(?:milk)?|soy\s*milk|ito\s+en|oi\s+ocha|ritz\s+original|maruchan|top\s+ramen|nissin|cup\s+noodles?|shin\s+ramyun|buldak|samyang|indomie|nongshim|sapporo\s+ichiban|instant\s+ramen|ramen\s+noodle\s+soup|ramen\s+noodles?|knoppers|tony'?s\s+chocolonely|ferrero|lindt|lindor|hershey'?s|reese'?s|frank'?s\s+redhot|butterball|potatoes,?\s+butter|butter\s+potatoes?|baby\s+cut\s+carrots?|yams?\s*\(sweet\s+potatoes?\)|honeycrisp\s+apples?|bismark|freshness\s+guaranteed|smithfield|my\s+cookie\s+dealer|protein\s+toaster\s+pastr(?:y|ies)|ground\s+(?:beef|chuck|turkey|chicken|pork|bison|lamb)|\d{2}%\s*lean|marketside\s+butcher|marketside\b.*\bblueberry\b.*\bmuffins?|folgers|bar[- ]?s\b|ball\s+park|jimmy\s+dean|chobani|tropicana|little\s+debbie|jackson'?s|drizzilicious|stonyfield|organic\s+valley|applegate|lotus\s+foods|rao'?s|french'?s|mccormick|idahoan|carvel|panera|blount|fresh\s+banana|bananas?|rotisserie|steamfresh|oscar\s+mayer|tyson|ezekiel|dave'?s\s+killer|kind\s+(?:nut\s+)?bars?|inglehoffer|beaver\s+brand|kikkoman.*wasabi|wasabi[- ]?o|wicked\s+cutz|hellmann'?s|best\s+foods|kraft\s+mayo|primal\s+kitchen|chosen\s+foods|boulder\s+canyon|mission\b.*\btortillas?|tortillas?\b.*\bmission|eggo|goldfish|\bjif\b|philadelphia\b.*\bcream\s+cheese|coca[- ]?cola|\bcoke\b|gatorade)\b/i;

  const isPlainProduceDirectPriority =
    !PROCESSED_FOOD_GUARD.test(title) &&
    /\b(fresh\s+whole\b|fresh\s+produce\b|sweet\s+potato(?:es)?|russet\s+potato(?:es)?|idaho\s+potato(?:es)?|yukon\s+gold\s+potato(?:es)?|red\s+potato(?:es)?|yellow\s+potato(?:es)?|raw\s+(?:whole\s+)?(?:almonds?|walnuts?|pecans?|cashews?|pistachios?|hazelnuts?|macadamia\s+nuts?|brazil\s+nuts?|pumpkin\s+seeds?|sunflower\s+seeds?)|chia\s+seeds?|flax\s*seeds?|hemp\s+(?:hearts?|seeds?))\b/i.test(
      title,
    );

  const isBarePureWaterDirectPriority = BARE_PURE_WATER_QUERY_RE.test(
    (cleanedCatalogTitle || title).trim(),
  );

  if (
    !normBarcode &&
    title &&
    (DIRECT_CATALOG_PRIORITY.test(title) || isPlainProduceDirectPriority || isBarePureWaterDirectPriority)
  ) {
    const directCat =
      catalogFallback(title) ??
      (rawTitle && rawTitle !== title ? catalogFallback(rawTitle) : null) ??
      safeCleanedCatalogFallback();
    if (
      directCat &&
      !directCat.productTitle.startsWith("Conventional Grocery") &&
      !/category estimate|representative/i.test(directCat.brand || "")
    ) {
      return { ...directCat, productTitle: normalizeOffDisplayTitle(directCat.productTitle), ms: ms() };
    }
  }

  const cache = await loadCache();
  const hit = cache.get(key);
  if (
    isFreshCacheEntry(hit) &&
    !hit.productTitle.startsWith("Conventional Grocery") &&
    (!title ||
      (doesBarcodeResultMatchTitle(title, hit) &&
        passesVariantGuard(title, hit.productTitle) &&
        !isDietaryOrVariantMismatch(title, hit.productTitle, hit.ingredients, hit.nutrition)))
  ) {
    const { cachedAt: _c, source, ...rest } = hit;
    return {
      ...rest,
      productTitle: normalizeOffDisplayTitle(rest.productTitle),
      ingredients: sanitizeIngredientDisplay(rest.ingredients),
      source: "cache",
      origin: source,
      ms: ms(),
    };
  }

  let found: Omit<LookupResult, "ms"> | null = null;

  ensureLookupRuntimeFreshForFetch();
  const negExpiresAt = negativeLookupCache.get(key);
  if (!negExpiresAt || Date.now() >= negExpiresAt) {
    if (negExpiresAt) negativeLookupCache.delete(key);
    const parentCtx = lookupAttemptContext.getStore();
    const attemptState: LookupAttemptContext = {
      hadOperationalFailure: false,
      isBatch: Boolean(input.isBatch || parentCtx?.isBatch),
      deadlineMs: parentCtx?.deadlineMs,
      onDeadlineExceeded: parentCtx?.onDeadlineExceeded,
    };
    found = await lookupAttemptContext.run(attemptState, () => lookupProviders(normalizedInput));
    if (!found && !providerSignal.getStore()?.aborted && !attemptState.hadOperationalFailure) {
      if (negativeLookupCache.size >= MAX_NEGATIVE_LOOKUP_ENTRIES) {
        const oldestKey = negativeLookupCache.keys().next().value;
        if (oldestKey !== undefined) negativeLookupCache.delete(oldestKey);
      }
      negativeLookupCache.set(key, Date.now() + NEGATIVE_LOOKUP_TTL_MS);
    }
  }
  if (!found && title) {
    found =
      catalogFallback(title) ??
      (rawTitle && rawTitle !== title ? catalogFallback(rawTitle) : null) ??
      safeCleanedCatalogFallback();
  }
  if (!found) return null;

  const normalizedFound = {
    ...found,
    productTitle: normalizeOffDisplayTitle(found.productTitle),
  };

  if (normalizedFound.source !== "catalog") {
    setCacheEntry(cache, key, { ...normalizedFound, cachedAt: new Date().toISOString(), schemaVersion: 3 });
    void persistCache(cache);
  }
  return { ...normalizedFound, ms: ms() };
}

/**
 * Forces a fresh live lookup against Open Food Facts, USDA FoodData Central, and NIH DSLD
 * (bypassing local cache and static catalog priority) for the Auto-Label Verifier.
 */
export async function lookupLiveAuthoritative(input: LookupInput): Promise<LookupResult | null> {
  const t0 = performance.now();
  const ms = () => Math.round((performance.now() - t0) * 100) / 100;
  const rawTitle = (input.productTitle || "").trim();
  const normBarcode = normalizeBarcode(input.barcode);
  const title = rawTitle ? canonicalizeGroceryQuery(rawTitle) : "";
  const normalizedInput: LookupInput = {
    ...input,
    barcode: normBarcode || undefined,
    productTitle: title,
  };
  const found = await lookupProviders(normalizedInput);
  if (!found) return null;
  const normalizedFound = {
    ...found,
    productTitle: normalizeOffDisplayTitle(found.productTitle),
  };
  const key = cacheKey(normalizedInput);
  if (key) {
    const cache = await loadCache();
    setCacheEntry(cache, key, { ...normalizedFound, cachedAt: new Date().toISOString(), schemaVersion: 3 });
    void persistCache(cache);
  }
  return { ...normalizedFound, ms: ms() };
}

