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
import { promises as fs } from "fs";
import path from "path";
import {
  hasConflictingBrand,
  hasValidCatalogProvenance,
  isCatalogEntryFresh,
  matchDrinkCatalog,
  passesVariantGuard,
} from "./drinks-catalog";
import {
  ENGLISH_INGREDIENT_ANCHORS,
  isEnglishIngredientText,
  NON_ENGLISH_INGREDIENTS,
  inferNutritionFromText,
  type NutritionInput,
} from "./rubric";

export { ENGLISH_INGREDIENT_ANCHORS, isEnglishIngredientText, NON_ENGLISH_INGREDIENTS };
export const isInstantCatalogEntryFresh = isCatalogEntryFresh;

export type LookupSource = "screen" | "cache" | "openfoodfacts" | "usda" | "catalog" | "dsld" | "openbeautyfacts" | "openproductsfacts" | "openpetfoodfacts";

export interface LookupInput {
  productTitle?: string;
  barcode?: string;
  rawIngredients?: string;
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
const offBarcodeCache = new Map<string, { product: OffProduct; cachedAt: number }>();

let memory: Map<string, CacheEntry> | null = null;
let loading: Promise<Map<string, CacheEntry>> | null = null;

function isFreshCacheEntry(entry?: CacheEntry): entry is CacheEntry {
  if (!entry || entry.schemaVersion !== 2 || entry.source === "catalog" || !entry.ingredients?.trim()) return false;
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

export function cacheKey(input: LookupInput): string | null {
  if (input.barcode?.trim()) return `upc:${input.barcode.replace(/\D/g, "")}`;
  const t = (input.productTitle || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
  "organic", "free",
  "large", "medium", "small", "baby", "mini", "jumbo", "extra", "super",
  "red", "green", "yellow", "white", "black", "brown", "golden", "dark", "light",
  "sweet", "hot", "mild", "spicy", "sour", "salted", "unsalted", "roasted",
  "sliced", "diced", "chopped", "shredded", "crushed", "peeled", "minced", "ground",
  "frozen", "canned", "raw", "cooked", "baked", "fried", "grilled", "smoked", "cured",
  "boneless", "skinless", "seedless", "pitted", "hulled",
  "unflavored", "unsweetened", "sweetened", "skim", "gluten", "dairy", "sugar", "zero", "diet",
  "pack", "bag", "box", "can", "jar", "bottle", "tub", "carton", "pouch",
]);

const SHORT_BRAND_TOKENS = new Set(["hu", "v8", "gv", "bj", "kc"]);
let usdaUnavailableUntil = 0;
let dsldUnavailableUntil = 0;
const providerSignal = new AsyncLocalStorage<AbortSignal>();

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['’]s\b/g, "s")
    .replace(/['’]/g, "")
    .replace(/\bcr[eè]me\b/g, "cream")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => (t.length >= 3 || SHORT_BRAND_TOKENS.has(t)) && !STOP.has(t) && !/^\d+$/.test(t));
}

const FLAVOR_TOKENS = new Set([
  "strawberry", "strawberries", "vanilla", "chocolate", "blueberry", "blueberries",
  "raspberry", "peach", "mango", "banana", "cherry", "apple", "cinnamon", "honey",
  "caramel", "frosted", "peanut", "almond", "almondmilk", "soy", "soymilk", "oatmilk",
  "cashew", "hazelnut", "coconut", "lemon", "lime",
  "orange", "grape", "watermelon", "mint", "coffee", "mocha", "maple", "brown",
  "bbq", "barbecue", "sour", "cheddar", "nacho", "ranch", "spicy", "flamin",
  "hot", "buffalo", "jalapeno", "garlic", "onion", "teriyaki", "salsa", "flip",
  "marinara", "alfredo", "pesto", "vodka", "bolognese", "ketchup", "mustard",
  "mayonnaise", "mayo", "relish", "chipotle", "habanero", "sriracha", "tartar",
]);

const PLAIN_TOKENS = new Set(["plain", "unsweetened", "unflavored"]);

/**
 * 0–1 relevance of a candidate product name to the user's query. Only distinctive tokens
 * count; short queries (≤2 distinctive tokens) must match all of them.
 * Enforces leading brand token consistency, trailing product noun match, and flavor consistency.
 */
function relevance(query: string, candidate: string): number {
  const all = tokens(query);
  const q = all.filter((t) => !GENERIC.has(t));
  const pool = q.length ? q : all;
  if (!pool.length) return 0;
  const c = tokens(candidate);
  const hasIn = (list: string[], t: string) =>
    list.some(
      (x) =>
        x === t || x === `${t}s` || x === `${t}es` || t === `${x}s` || t === `${x}es`,
    );

  // Prevent cross-category novel spin-offs (e.g. "Oatmeal Creme Pies" matching "Oatmeal Creme Pies Cereal" or "Nutty Bars Ice Cream")
  const FORM_FACTOR_TOKENS = ["cereal", "ice", "seasoning", "syrup", "creamer", "frosting", "powder", "supplement", "kcup", "pods"];
  for (const ff of FORM_FACTOR_TOKENS) {
    if (hasIn(c, ff) && !hasIn(all, ff)) {
      return 0;
    }
  }

  // Leading Brand / Anchor Token Guard: if the query starts with a distinctive brand/anchor token
  // (e.g. "Rao's", "Freihofer's", "Little Debbie", "Wegmans", "Wellsley"), the candidate MUST match it!
  if (all.length >= 2 && !GENERIC_LEADING_MODIFIERS.has(all[0])) {
    if (!hasIn(c, all[0])) {
      return 0;
    }
  }

  // If the query has >= 3 tokens (e.g. "Little Debbie Nutty Bars"), the candidate MUST match at least one of the last 2 product noun tokens,
  // never just the leading 1–2 brand tokens ("Little Debbie Pound Cake")!
  if (pool.length >= 3) {
    const tail = pool.slice(-2);
    if (!tail.some((t) => hasIn(c, t))) {
      return 0;
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
  if (c.some((t) => SPICY_TOKENS.has(t)) && !all.some((t) => SPICY_TOKENS.has(t))) {
    return 0;
  }
  // If the query specifies a flavor (e.g. "strawberry", "honey", "marinara"), candidate must include it
  if (queryFlavors.length > 0 && !queryFlavors.every((f) => hasIn(c, f))) {
    return 0;
  }
  // Penalize candidates that add any unrequested flavor tokens ("Honey Nut Cheerios" for "Cheerios")
  const extraFlavorPenalty =
    unrequestedFlavors.length > 0 ? Math.min(0.45, unrequestedFlavors.length * 0.22) : 0;

  const ratio = pool.filter((t) => hasIn(c, t)).length / pool.length;
  if (pool.length <= 2 && ratio < 1 && ratio < 0.5) return 0;
  if (ratio < 0.55) return 0;
  const base = pool.length <= 2 && ratio === 1 ? 1 : ratio;

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
  return Math.max(0, base + bigramBonus - extraFlavorPenalty - extraTokensPenalty);
}

async function getJson<T>(url: string): Promise<T | null> {
  const isUsda = url.includes("api.nal.usda.gov");
  const isDsld = url.includes("api.ods.od.nih.gov");
  if ((isUsda && Date.now() < usdaUnavailableUntil) || (isDsld && Date.now() < dsldUnavailableUntil)) {
    return null;
  }
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: providerSignal.getStore() ? AbortSignal.any([providerSignal.getStore()!, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      if (isDsld && (res.status === 429 || res.status >= 500)) dsldUnavailableUntil = Date.now() + 60_000;
      if (isUsda && (res.status === 429 || res.status >= 502)) {
        usdaUnavailableUntil = Date.now() + 60 * 1000;
      }
      return null;
    }
    const type = res.headers.get("content-type") || "";
    if (!type.includes("json")) {
      return null;
    }
    return (await res.json()) as T;
  } catch {
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
  nutriscore_grade?: string;
  labels_tags?: string[];
  last_modified_t?: number;
  nutriments?: Record<string, number | string | undefined>;
  categories_tags?: string[];
}

function normalizeOffBrand(brands?: string | string[]): string {
  if (!brands) return "";
  if (Array.isArray(brands)) return brands.filter(Boolean).join(", ");
  return brands;
}

const OFF_FIELDS =
  "product_name,product_name_en,brands,ingredients_text,ingredients_text_en,lang,code,image_front_url,image_url,image_front_small_url,nutriscore_grade,labels_tags,categories_tags,last_modified_t,nutriments";

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
  /\b(?:\d+\s*%\s*(?:fibre|fiber|vitamin|calcium|iron|daily\s+value)|gredients?\b|itamin\s+[a-d]|alcium\s+\d)/i;

function englishIngredients(p: OffProduct): string {
  const clean = (s: string) => s.replace(/_/g, "").replace(/\s+/g, " ").trim();
  const en = clean(p.ingredients_text_en || "");
  if (en && !OCR_NUTRITION_GARBAGE.test(en) && isEnglishIngredientText(en)) return en;
  const raw = clean(p.ingredients_text || "");
  if (raw && (!p.lang || p.lang === "en") && !OCR_NUTRITION_GARBAGE.test(raw) && isEnglishIngredientText(raw)) return raw;
  return "";
}

function bestOffImage(p?: OffProduct): string | undefined {
  if (!p) return undefined;
  return p.image_front_url || p.image_url || p.image_front_small_url || undefined;
}

function pickBestOff(query: string, products: OffProduct[] = []): OffProduct | null {
  let best: OffProduct | null = null;
  let bestScore = 0;
  const qToks = tokens(query);
  const firstTok = qToks[0] || "";
  for (const p of products) {
    const ing = englishIngredients(p);
    if (!ing) continue;
    const brandStr = normalizeOffBrand(p.brands);
    const name = `${brandStr} ${p.product_name_en || p.product_name || ""}`.trim();
    if (!passesVariantGuard(query, name)) continue;
    const nutrition = extractOffNutrition(p);
    if (isDietaryOrVariantMismatch(query, name, ing, nutrition)) continue;
    const r = relevance(query, name);
    if (r < 0.45) continue;
    const brandMatchBonus = firstTok.length >= 3 && brandStr.toLowerCase().includes(firstTok) ? 0.08 : 0;
    const imgBonus = bestOffImage(p) ? 0.03 : 0;
    if (r + brandMatchBonus + imgBonus > bestScore) {
      best = p;
      bestScore = r + brandMatchBonus + imgBonus;
    }
  }
  return best;
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

function offToResult(p: OffProduct, fallbackTitle: string): Omit<LookupResult, "ms"> {
  const sourceUpdatedAt =
    typeof p.last_modified_t === "number" && p.last_modified_t > 0
      ? new Date(p.last_modified_t * 1000).toISOString().slice(0, 10)
      : null;
  const brandStr = normalizeOffBrand(p.brands).split(",")[0]?.trim() || undefined;
  const rawName = (p.product_name_en || p.product_name || fallbackTitle).trim();
  const fullTitle =
    brandStr && !rawName.toLowerCase().startsWith(brandStr.toLowerCase())
      ? `${brandStr} ${rawName}`
      : rawName;
  return {
    productTitle: fullTitle,
    brand: brandStr,
    barcode: p.code,
    ingredients: englishIngredients(p),
    imageUrl: bestOffImage(p),
    nutrition: inferNutritionFromText(fullTitle, englishIngredients(p), {
      ...extractOffNutrition(p),
      productKind: p.categories_tags?.some(t => /^en:(dietary-supplements|food-supplements)$/.test(t)) || SUPPLEMENT_FORM.test(`${fullTitle} ${fallbackTitle}`) ? "supplement" : "food",
    }),
    source: "openfoodfacts",
    sourceUpdatedAt,
  };
}

const NON_FOOD_VERTICAL_QUERY =
  /\b(shampoo|conditioner|body\s*wash|shower\s*gel|soap|hand\s*wash|lotion|moisturizer|cream|cleanser|face\s*wash|serum|toner|sunscreen|spf|deodorant|antiperspirant|toothpaste|mouthwash|lip\s*balm|mascara|foundation|concealer|lipstick|makeup|cosmetic|perfume|cologne|body\s*spray|hair\s*spray|hair\s*gel|mousse|pomade|shaving|aftershave|diapers?|wipes?|detergent|laundry|cleaner|disinfect\w*|bleach|dish\s*soap|dishwashing|dog\s*food|cat\s*food|pet\s*food|puppy|kitten|kibble|purina|pedigree|friskies|blue\s*buffalo|fancy\s*feast|cesar|iams|rachael\s*ray\s*nutrish|cerave|cetaphil|neutrogena|aveeno|olay|dove|pantene|tresemme|herbal\s*essences|head\s*&\s*shoulders|garnier|l'?oreal|maybelline|nyx|revlon|covergirl|e\.?l\.?f\.?|old\s*spice|degree|secret|axe|native|schmidt'?s|tom'?s\s*of\s*maine|colgate|crest|sensodyne|listerine|thera\s*breath|vaseline|aquaphor|eucerin|nivea|jergens|lubriderm|gold\s*bond|coppertone|banana\s*boat|sun\s*bum|la\s*roche|vichy|ordinary|dr\s*bronner|method|mrs\.?\s*meyer'?s|seventh\s*generation|ecos)\b/i;

async function fetchOffProductByCode(
  code: string,
  host = "https://world.openfoodfacts.org",
): Promise<OffProduct | null> {
  const cacheKey = `${host}|${code}`;
  const cached = offBarcodeCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.product;

  let data = await getJson<{ status?: number; product?: OffProduct }>(
    `${host}/api/v2/product/${code}?fields=${OFF_FIELDS}`,
  );
  if (!data?.product && host === "https://world.openfoodfacts.org") {
    // Fallback to Open Food Facts v0 JSON product handler if v2 is rate-limited
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
    return data.product;
  }
  return null;
}

async function offByBarcode(barcode: string): Promise<Omit<LookupResult, "ms"> | null> {
  const code = barcode.replace(/\D/g, "");
  if (!/^\d{8,14}$/.test(code)) return null;
  const codes = [code];
  const hosts = ["https://world.openfoodfacts.org", "https://world.openbeautyfacts.org", "https://world.openproductsfacts.org", "https://world.openpetfoodfacts.org"];
  return firstAvailable(codes.flatMap(c => hosts.map(async host => {
    const p = await fetchOffProductByCode(c, host);
    if (!p?.code || p.code.replace(/^0+/, "") !== code.replace(/^0+/, "")) return null;
    if (host === "https://world.openfoodfacts.org") return englishIngredients(p) ? offToResult(p, c) : null;
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
        `${host}/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page_size=20&fields=${OFF_FIELDS}`,
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

/** One shared wall-clock budget also covers multi-stage provider searches. */
async function lookupProviders(input: LookupInput): Promise<ProviderResult | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(null); }, TIMEOUT_MS);
  });
  const work = providerSignal.run(controller.signal, () => {
    const candidates = input.barcode
      ? [offByBarcode(input.barcode), usdaSearch(input.barcode), lookupDsld(input, getJson)]
      : [offSearch(cleanSearchQuery(input.productTitle || "") || input.productTitle || ""), usdaSearch(input.productTitle || ""), lookupDsld(input, getJson)];
    return firstAvailable(candidates);
  });
  try { return await Promise.race([work, deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}

interface OffSearchHit {
  code?: string;
  product_name?: string;
  product_name_en?: string;
  brands?: string | string[];
  states_tags?: string[];
  countries_tags?: string[];
  image_front_url?: string;
  image_url?: string;
  image_front_small_url?: string;
}

async function offSearch(title: string): Promise<Omit<LookupResult, "ms"> | null> {
  const toks = tokens(title);
  const firstTok = toks[0] || "";
  const brandQuery =
    toks.length >= 2 ? `brands_tags:${firstTok} ${toks.slice(1).join(" ")}` : title;

  // 1. Run Open Food Facts Search-a-licious v3 (brand-tagged + full text) and vertical search concurrently
  const searchFields =
    "code,product_name,product_name_en,brands,states_tags,countries_tags,image_front_url,image_url,image_front_small_url";
  const [v3Brand, v3Text, vertical] = await Promise.all([
    getJson<{ hits?: OffSearchHit[] }>(
      `https://search.openfoodfacts.org/search?q=${encodeURIComponent(brandQuery)}&page_size=12&fields=${searchFields}`,
    ),
    getJson<{ hits?: OffSearchHit[] }>(
      `https://search.openfoodfacts.org/search?q=${encodeURIComponent(title)}&page_size=16&fields=${searchFields}`,
    ),
    openFactsVerticalSearch(title),
  ]);
  if (vertical) return vertical;

  const combinedHits: OffSearchHit[] = [];
  const seenCodes = new Set<string>();
  for (const h of [...(v3Brand?.hits || []), ...(v3Text?.hits || [])]) {
    const code = (h.code || "").trim();
    if (!code || seenCodes.has(code)) continue;
    seenCodes.add(code);
    combinedHits.push(h);
  }

  const ranked = combinedHits
    .filter(
      (h) =>
        h.code &&
        (!Array.isArray(h.states_tags) || h.states_tags.includes("en:ingredients-completed")),
    )
    .map((h) => {
      const brandStr = normalizeOffBrand(h.brands);
      const name = `${brandStr} ${h.product_name_en || h.product_name || ""}`.trim();
      if (!passesVariantGuard(title, name)) return { h, score: 0 };
      const r = relevance(title, name);
      if (r < 0.5) return { h, score: 0 };
      const brandBonus =
        firstTok.length >= 3 &&
        (brandStr.toLowerCase().includes(firstTok) || name.toLowerCase().startsWith(firstTok))
          ? 0.08
          : 0;
      const hasImg = Boolean(h.image_front_url || h.image_url || h.image_front_small_url);
      const codeStr = (h.code || "").trim();
      const isUsCountry =
        Array.isArray(h.countries_tags) && h.countries_tags.includes("en:united-states");
      const isNorthAmericanUpc = /^(?:00?\d{11}|\d{11,12}|0\d{7})$/.test(codeStr);
      const isNonUsEan13 = /^[2-9]\d{12}$/.test(codeStr);
      const usMarketBonus = isNonUsEan13
        ? -0.22
        : isUsCountry && isNorthAmericanUpc
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
    .slice(0, 4);

  if (!ranked.length) return null;

  // Fetch product details sequentially starting with the top-ranked US candidate so 90%+ of queries
  // resolve in 1 request instead of firing 3 parallel requests that trigger Open Food Facts rate limits.
  for (const { h } of ranked) {
    if (!h.code) continue;
    const p = await fetchOffProductByCode(h.code, "https://world.openfoodfacts.org");
    if (!p) continue;
    const ing = englishIngredients(p);
    if (!ing) continue;
    const brandStr = normalizeOffBrand(p.brands);
    const name = `${brandStr} ${p.product_name_en || p.product_name || ""}`.trim();
    if (!passesVariantGuard(title, name)) continue;
    if (isDietaryOrVariantMismatch(title, name, ing, extractOffNutrition(p))) continue;
    if (!bestOffImage(p)) {
      const hitImg = bestOffImage(h);
      if (hitImg) p.image_front_url = hitImg;
    }
    return offToResult(p, title);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* USDA FoodData Central (Branded + Foundation + SR Legacy + Survey)   */
/* ------------------------------------------------------------------ */

export function genericWholeFoodQuery(query: string): string | null {
  if (classifyWholeFood(query).isWholeFood !== true) return null;
  const text = query.toLowerCase();
  const food = text.match(/\b(apples?|almonds?|walnuts?|cashews?|chia\s+seeds?|flax\s*seeds?|pumpkin\s+seeds?|salmon|trout|cod|tuna|chicken|turkey|beef|pork|eggs?|oats?|oatmeal|quinoa|broccoli|spinach|carrots?|sweet\s+potato(?:es)?|potato(?:es)?|yams?|tomato(?:es)?|avocados?|bananas?|lentils?|chickpeas?|olive\s+oil|greek\s+yogurt)\b/)?.[0];
  if (!food) return null;
  const species = text.match(/\b(atlantic|pacific|sockeye|pink|chinook)\b/)?.[0];
  const preparation = /\b(greek\s+yogurt)\b/.test(food) ? "plain" : /olive\s+oil|oats?|oatmeal|quinoa/.test(food) ? "" : /\b(cooked|roasted|boiled|baked)\b/.exec(text)?.[0] || "raw";
  return [food === "oatmeal" ? "oats" : food, species, preparation].filter(Boolean).join(" ");
}

export function matchesGenericWholeFood(query: string, candidate: string): boolean {
  const canonical = genericWholeFoodQuery(query);
  if (!canonical || classifyWholeFood(candidate).isWholeFood !== true) return false;
  const stem = (w: string) => w.length > 3 ? w.replace(/s$/, "") : w;
  const candidateWords = new Set(candidate.toLowerCase().split(/[^a-z]+/).map(stem));
  const identity = canonical.replace(/\b(raw|cooked|roasted|boiled|baked|plain)\b/g, "").trim().split(/\s+/);
  if (!identity.every(word => candidateWords.has(stem(word)))) return false;
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
]);

function buildUsdaLuceneQuery(query: string): string {
  const words = query
    .replace(/['’]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !USDA_LUCENE_SKIP_WORDS.has(w.toLowerCase()) && !/^\d+$/.test(w))
    .slice(0, 5);
  if (words.length < 2) return "";
  return words.map((w) => `+${w}`).join(" ");
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
        ["Foundation", "SR Legacy", "Survey (FNDDS)"].includes(f.dataType || "") &&
        classifyWholeFood(f.description || "").isWholeFood === true;
      const ing =
        f.ingredients?.trim() ||
        (isTrueWholeFood ? `Whole Food: ${f.description}` : "");
      if (!ing || !isEnglishIngredientText(ing)) continue;
      const candidateName = `${f.brandName || f.brandOwner || ""} ${f.description || ""}`.trim();
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
  const requests = [getJson<{ foods?: UsdaFood[] }>(
    `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(luceneQuery || query)}&dataType=Branded&pageSize=18&api_key=${key}`,
  )];
  if (wholeQuery) requests.push(getJson<{ foods?: UsdaFood[] }>(
    `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(wholeQuery)}&dataType=${encodeURIComponent("Foundation,SR Legacy")}&pageSize=20&api_key=${key}`,
  ));
  const responses = await Promise.all(requests);
  for (const response of responses) evaluateFoods(response?.foods);
  if (!best || bestScore < 0.55) return null;
  const titleCase = (s = "") => s.toLowerCase().replace(/(^|[\s\-/(])\w/g, (c) => c.toUpperCase());
  const rawDesc = (best.description || "")
    .replace(/^(.+?),\s*([^,]+)$/, (full: string, prefix: string, suffix: string) => {
      const prefixWords = new Set(prefix.toLowerCase().split(/\W+/).filter(Boolean));
      const suffixWords = suffix.toLowerCase().split(/\W+/).filter(Boolean);
      return suffixWords.length > 0 && suffixWords.every((w) => prefixWords.has(w)) ? prefix : full;
    })
    .trim();
  const brandLabel = titleCase(best.brandName || best.brandOwner) || "USDA FoodData Central";
  const descTitle = titleCase(rawDesc) || query;
  const fullTitle =
    brandLabel !== "USDA FoodData Central" && !descTitle.toLowerCase().startsWith(brandLabel.toLowerCase())
      ? `${brandLabel} ${descTitle}`
      : descTitle;
  const imageUrl = `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(fullTitle)}`;
  return {
    productTitle: fullTitle,
    brand: brandLabel,
    barcode: best.gtinUpc,
    ingredients: best.ingredients!.trim(),
    imageUrl,
    nutrition: inferNutritionFromText(rawDesc, best.ingredients!, extractUsdaNutrition(best)),
    sourceUrl: best.fdcId ? `https://fdc.nal.usda.gov/food-details/${best.fdcId}/nutrients` : undefined,
    source: "usda",
    sourceUpdatedAt: best.publishedDate ? best.publishedDate.slice(0, 10) : null,
  };
}

/* ------------------------------------------------------------------ */
/* Built-In Instant Grocery Encyclopedia + Universal Category Fallback */
/* Fresh reference formulations; unmatched products can return null. */
/* ------------------------------------------------------------------ */

interface CatalogEntry {
  match: RegExp;
  brand: string;
  title: string;
  ingredients: string;
  imageUrl?: string;
  nutrition?: NutritionInput;
  sourceUrl: string;
  verifiedAt: string;
}

export const INSTANT_GROCERY_CATALOG: CatalogEntry[] = [
  {
    match: /\b(simple\s+truth\s+organic.*(?:greek\s+yogurt|plain\s+greek\s+yogurt)|(?:greek\s+yogurt|plain\s+greek\s+yogurt).*simple\s+truth\s+organic)\b/i,
    brand: "Simple Truth Organic",
    title: "Simple Truth Organic Whole Milk Plain Greek Yogurt",
    ingredients: "Cultured Pasteurized Organic Whole Milk. Live and Active Cultures: S. Thermophilus, L. Bulgaricus, L. Acidophilus, Bifidus, L. Casei.",
    imageUrl: "/swaps/yogurt.jpg",
    nutrition: { caloriesKcal100g: 94, sugarsG100g: 3.5, saturatedFatG100g: 3.0, sodiumMg100g: 35, fiberG100g: 0, proteinG100g: 8.8, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isOrganic: true, isWholeFood: true },
    sourceUrl: "https://www.kroger.com/p/simple-truth-organic-plain-whole-milk-greek-yogurt/0001111089910",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(simple\s+truth\s+organic.*applesauce|applesauce.*simple\s+truth\s+organic)\b/i,
    brand: "Simple Truth Organic",
    title: "Simple Truth Organic Unsweetened Applesauce",
    ingredients: "Organic Apples, Water, Ascorbic Acid (Vitamin C) to Maintain Color.",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 44, sugarsG100g: 9.7, saturatedFatG100g: 0, sodiumMg100g: 0, fiberG100g: 1.8, proteinG100g: 0, fruitsVegNutsPct: 100, nutriScoreGrade: "a", isOrganic: true, isWholeFood: true },
    sourceUrl: "https://www.kroger.com/p/simple-truth-organic-unsweetened-applesauce-cups/0001111085432",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(private\s+selection.*(?:angus\s+beef|beef\s+patties|burger\s+patties)|(?:angus\s+beef\s+patties).*private\s+selection)\b/i,
    brand: "Private Selection",
    title: "Private Selection Angus Beef Patties",
    ingredients: "100% USDA Choice Angus Beef.",
    imageUrl: "/swaps/turkey.jpg",
    nutrition: { caloriesKcal100g: 254, sugarsG100g: 0, saturatedFatG100g: 7.7, sodiumMg100g: 66, fiberG100g: 0, proteinG100g: 17.2, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isOrganic: false, isWholeFood: true },
    sourceUrl: "https://www.kroger.com/p/private-selection-80-lean-20-fat-angus-beef-chuck-patties/0001111097111",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(good\s*(?:&|and)\s*gather.*organic.*peanut\s+butter|organic.*peanut\s+butter.*good\s*(?:&|and)\s*gather)\b/i,
    brand: "Good & Gather",
    title: "Good & Gather Organic Creamy Peanut Butter",
    ingredients: "Organic Dry Roasted Peanuts, Sea Salt.",
    imageUrl: "/swaps/peanut-butter.jpg",
    nutrition: { caloriesKcal100g: 593, sugarsG100g: 6.2, saturatedFatG100g: 7.8, sodiumMg100g: 250, fiberG100g: 6.2, proteinG100g: 25.0, fruitsVegNutsPct: 99, nutriScoreGrade: "a", isOrganic: true, isWholeFood: true },
    sourceUrl: "https://www.target.com/p/organic-unsweetened-creamy-peanut-butter-16oz-good-38-gather-8482/-/A-54516890",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(favorite\s+day.*cookies\s*(?:&|and|\x27n)?\s*cr[eè]me\s+ice\s+cream|favorite\s+day.*cookies\s*(?:&|and|\x27n)?\s*cream\s+ice\s+cream|cookies\s*(?:&|and|\x27n)?\s*cream\s+ice\s+cream.*favorite\s+day)\b/i,
    brand: "Favorite Day",
    title: "Favorite Day Cookies & Cream Ice Cream",
    ingredients: "Milk, Cream, Skim Milk, Sugar, Corn Syrup, Chocolate Sandwich Cookie Pieces (Unbleached Enriched Flour [Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid], Sugar, Palm and/or Canola Oil, Cocoa Processed with Alkali, Invert Sugar, Leavening [Baking Soda, Calcium Phosphate], Soy Lecithin, Salt, Chocolate, Natural Flavor), Whey, Contains 1% or Less of Vanilla Extract, Mono and Diglycerides, Guar Gum, Calcium Sulfate, Carob Bean Gum, Carrageenan.",
    imageUrl: "/products/yogurt.jpg",
    nutrition: { caloriesKcal100g: 224, sugarsG100g: 21.3, saturatedFatG100g: 7.3, sodiumMg100g: 95, fiberG100g: 0.5, proteinG100g: 3.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.target.com/p/cookies-38-cream-ice-cream-48oz-favorite-day-8482/-/A-81502226",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?=.*\bfavorite\s+day\b)(?=.*\bvanilla\b)(?=.*\bice\s+cream\b)(?!.*\b(cookies|chocolate|strawberry|mint|pecan|caramel)\b).*$/i,
    brand: "Favorite Day",
    title: "Favorite Day Classic Vanilla Ice Cream",
    ingredients: "Milk, Cream, Skim Milk, Sugar, Corn Syrup, Egg Yolks, Natural Flavor, Mono and Diglycerides, Guar Gum, Locust Bean Gum, Carrageenan, Annatto Extract (Color).",
    imageUrl: "/products/yogurt.jpg",
    nutrition: { caloriesKcal100g: 207, sugarsG100g: 20.7, saturatedFatG100g: 7.0, sodiumMg100g: 65, fiberG100g: 0, proteinG100g: 3.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.target.com/p/vanilla-bean-ice-cream-48oz-favorite-day-8482/-/A-81502235",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(bismark|bismarks|donut|donuts|doughnut|doughnuts|fritter|danish|cinnamon roll|honey bun|eclair|strudel|turnover|glazed donut|jelly donut|raspberry filled)\b/i,
    brand: "Representative Bakery Formulation",
    title: "Bakery Donuts and Filled Pastries (Representative Formulation)",
    ingredients: "Enriched Wheat Flour Bleached (Flour, Malted Barley Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Fruit Filling (High Fructose Corn Syrup, Water, Raspberries, Modified Food Starch, Sugar, Citric Acid, Salt, Potassium Sorbate, Sodium Benzoate, Red 40, Blue 1, Artificial Flavor), Palm and/or Soybean Oil, Sugar, Dextrose, Contains 2% or Less of: Yeast, Soy Flour, Whey, Salt, Mono- and Diglycerides, Sodium Acid Pyrophosphate, Baking Soda, Sodium Stearoyl Lactylate, Soy Lecithin, Calcium Propionate, DATEM, Artificial Flavor, Yellow 5, Yellow 6, Titanium Dioxide (Color).",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 405, sugarsG100g: 25, saturatedFatG100g: 9.0, sodiumMg100g: 340, fiberG100g: 1.2, proteinG100g: 4.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e" },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/1750340/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?=.*\bdoritos\b)(?=.*\b(?:simply\s+nkd|nkd)\b)(?=.*\bcool\s+ranch\b).*$/i,
    brand: "Doritos",
    title: "Doritos Simply NKD Cool Ranch Tortilla Chips",
    ingredients: "Whole Corn, Corn and/or Sunflower Oil, Maltodextrin (Made from Corn), Salt, Tomato Powder, Corn Starch, Lactose, Whey, Skim Milk, Onion Powder, Sugar, Garlic Powder, Monosodium Glutamate, Cheddar Cheese (Milk, Cheese Cultures, Salt, Enzymes), Dextrose, Malic Acid, Buttermilk, Natural and Artificial Flavors, Sodium Acetate, Spice, Citric Acid, Disodium Inosinate, and Disodium Guanylate.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Doritos%20Simply%20NKD%20Cool%20Ranch",
    nutrition: { caloriesKcal100g: 500, sugarsG100g: 3.6, saturatedFatG100g: 3.6, sodiumMg100g: 607, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.target.com/p/doritos-simply-nkd-cool-ranch-flavored-tortilla-chips-8-oz/-/A-94994023",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?=.*\bdoritos\b)(?=.*\b(?:simply\s+nkd|nkd)\b)(?!.*\bcool\s+ranch\b).*$/i,
    brand: "Doritos",
    title: "Doritos Simply NKD Nacho Cheese Tortilla Chips",
    ingredients: "Whole Corn, Corn and/or Sunflower Oil, Maltodextrin (Made from Corn), Salt, Cheddar Cheese (Milk, Cheese Cultures, Salt, Enzymes), Whey, Monosodium Glutamate, Buttermilk, Romano Cheese (Part-Skim Cow's Milk, Cheese Cultures, Salt, Enzymes), Whey Protein Concentrate, Onion Powder, Corn Flour, Natural and Artificial Flavor, Dextrose, Tomato Powder, Lactose, Spices, Lactic Acid, Citric Acid, Sugar, Garlic Powder, Skim Milk, Red and Green Bell Pepper Powder, Yeast Extract, Disodium Inosinate, and Disodium Guanylate.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Doritos%20Simply%20NKD",
    nutrition: { caloriesKcal100g: 500, sugarsG100g: 3.6, saturatedFatG100g: 3.6, sodiumMg100g: 640, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isOrganic: false, isWholeFood: false },
    sourceUrl: "https://www.target.com/p/doritos-simply-nkd-nacho-cheese-flavored-tortilla-chips-8-oz/-/A-94994022",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(simply\s+doritos\s+organic|doritos\s+simply\s+organic|doritos.*organic\s+white\s+cheddar)\b/i,
    brand: "Simply",
    title: "Simply Doritos Organic White Cheddar Tortilla Chips",
    ingredients: "Organic White Corn, Expeller-Pressed Sunflower Oil, Organic Whey, Organic Cheddar Cheese (Organic Milk, Cheese Cultures, Salt, Enzymes), Organic Maltodextrin (Made from Corn), Sea Salt, Organic Butter (Organic Cream, Salt), Organic Nonfat Milk, Natural Flavors, Organic Sour Cream (Organic Cultured Cream, Organic Nonfat Milk), Lactic Acid, Citric Acid.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Simply%20Doritos%20Organic%20White%20Cheddar",
    nutrition: { caloriesKcal100g: 500, sugarsG100g: 3.6, saturatedFatG100g: 3.6, sodiumMg100g: 640, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isOrganic: true, isWholeFood: false },
    sourceUrl: "https://smartlabel.pepsico.info/028400509503-0001-en-US/index.html",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(?:simply\s+nkd|nkd)\b).*(?:\b(cool ranch)\b.*\b(doritos)\b|\b(doritos)\b.*\b(cool ranch)\b).*$/i,
    brand: "Doritos",
    title: "Cool Ranch Flavored Tortilla Chips",
    ingredients: "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin (Made from Corn), Salt, Tomato Powder, Corn Starch, Lactose, Whey, Skim Milk, Corn Syrup Solids, Onion Powder, Sugar, Garlic Powder, Monosodium Glutamate, Cheddar Cheese (Milk, Cheese Cultures, Salt, Enzymes), Dextrose, Malic Acid, Buttermilk, Natural and Artificial Flavors, Sodium Acetate, Artificial Color (Red 40, Blue 1, Yellow 5), Spice, Citric Acid, Disodium Inosinate, and Disodium Guanylate.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Doritos%20Cool%20Ranch%20Tortilla%20Chips",
    sourceUrl: "https://www.doritos.com/products/doritos-cool-ranch-flavored-tortilla-chips",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?=.*\bdoritos\b)(?!.*\b(simply\s+nkd|nkd|cool\s+ranch|flamin|blaze|tapatio|salsa\s+verde|dinamita|organic|spicy\s+sweet\s+chili)\b).*$/i,
    brand: "Doritos",
    title: "Nacho Cheese Flavored Tortilla Chips",
    ingredients: "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin (Made from Corn), Salt, Cheddar Cheese, Whey, Monosodium Glutamate, Buttermilk, Romano Cheese, Onion Powder, Corn Flour, Natural and Artificial Flavor, Dextrose, Tomato Powder, Lactose, Spices, Artificial Color (Yellow 6, Yellow 5, Red 40), Lactic Acid, Citric Acid, Sugar, Garlic Powder, Skim Milk, Red and Green Bell Pepper Powder, Disodium Inosinate, and Disodium Guanylate.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Doritos%20Nacho%20Cheese%20Tortilla%20Chips",
    sourceUrl: "https://www.doritos.com/products/doritos-nacho-cheese-flavored-tortilla-chips",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(cheez[- ]?it)\b/i,
    brand: "Cheez-It",
    title: "Original Baked Snack Crackers",
    ingredients: "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1, Vitamin B2, Folic Acid), Vegetable Oil (High Oleic Soybean, Soybean, Palm, and/or Canola Oil with TBHQ for Freshness), Cheese Made with Skim Milk (Skim Milk, Whey Protein, Salt, Cheese Cultures, Enzymes, Annatto Extract Color), Contains 2% or Less of Salt, Paprika, Yeast, Paprika Extract Color, Soy Lecithin.",
    imageUrl: "/products/crackers.jpg",
    sourceUrl: "https://www.cheezit.com/en_US/products/crackers/cheez-it-original-product.html",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bmartin'?s\b.*\b(potato|rolls?|buns?|bread)\b/i,
    brand: "Martin's",
    title: "Martin's Famous Pastry Shoppe Potato Sandwich Rolls",
    ingredients: "Unbleached Enriched Wheat Flour (Flour, Ferrous Sulfate, Niacin, Thiamin, Riboflavin, Folic Acid), Nonfat Milk, Reconstituted Potatoes (from Potato Flour), Yeast, Sugar, Wheat Gluten, Sunflower Oil, Contains 2 Percent or Less of Each of the Following: Salt, Butter, Dough Conditioners (Sodium Stearoyl Lactylate, Monoglycerides and Diglycerides, Ascorbic Acid), Monocalcium Phosphate, Cultured Wheat Flour, Calcium Propionate (a Preservative), Guar Gum, Datem, Enzymes, Sesame Seeds, Turmeric Color, Annatto Color.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Martin's%20Potato%20Sandwich%20Rolls",
    nutrition: { caloriesKcal100g: 281, sugarsG100g: 6.2, saturatedFatG100g: 0.8, sodiumMg100g: 390, fiberG100g: 3.1, proteinG100g: 10.9, fruitsVegNutsPct: 12, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://potatorolls.com/products/sandwich-potato-rolls/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(great\s+value|wonder|sara\s+lee|nature'?s\s+own|l'?oven\s+fresh)\b.*\b(white\s+sandwich\s+bread|white\s+bread|enriched\s+bread|sandwich\s+bread)\b/i,
    brand: "Representative Category Formulation",
    title: "White Enriched Sandwich Bread (Representative Formulation)",
    ingredients: "Unbleached Enriched Wheat Flour (Wheat Flour, Malted Barley Flour, Niacin, Reduced Iron, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, High Fructose Corn Syrup, Yeast, Contains 2% or Less of: Soybean Oil, Salt, Wheat Gluten, Calcium Sulfate, Sodium Stearoyl Lactylate, Monoglycerides, Calcium Propionate (to Preserve Freshness), DATEM, Ascorbic Acid, Enzymes.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Great%20Value%20White%20Sandwich%20Bread",
    nutrition: { caloriesKcal100g: 259, sugarsG100g: 5.8, saturatedFatG100g: 0.7, sodiumMg100g: 480, fiberG100g: 1.9, proteinG100g: 7.8, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/174924/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(oreo\s+puffs?|oreo\s+o'?s)\b/i,
    brand: "Post",
    title: "Oreo O's Cereal",
    ingredients: "Corn Flour, Sugar, Whole Grain Oat Flour, Cocoa (Processed with Alkali), Canola and/or Soybean Oil, Corn Syrup, Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Salt, Degerminated Corn Meal, Natural and Artificial Flavor, Cornstarch, Palm Oil, Soy Lecithin, Chocolate, BHT Added to Preserve Freshness.",
    imageUrl: "/products/cereal.jpg",
    nutrition: { caloriesKcal100g: 395, sugarsG100g: 36, saturatedFatG100g: 1.5, sodiumMg100g: 420, fiberG100g: 2.5, proteinG100g: 4.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.postconsumerbrands.com/brands/oreo-os/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(cocoa\s+puffs?|reese'?s\s+puffs?|cookie\s+crisp|cocoa\s+pebbles|fruity\s+pebbles|cap'?n\s+crunch|apple\s+jacks|frosted\s+flakes|krave|pops\s+cereal|honey\s+smacks|golden\s+grahams|trix)\b/i,
    brand: "Representative Category Formulation",
    title: "Sweetened Breakfast Cereal (Representative Formulation)",
    ingredients: "Whole Grain Corn or Corn Flour, Sugar, Corn Syrup, Canola and/or Soybean Oil, Salt, Trisodium Phosphate, Natural and Artificial Flavor, Vitamin E (Mixed Tocopherols) Added to Preserve Freshness.",
    imageUrl: "/products/cereal.jpg",
    nutrition: { caloriesKcal100g: 395, sugarsG100g: 36, saturatedFatG100g: 1.5, sodiumMg100g: 420, fiberG100g: 2.5, proteinG100g: 4.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/173884/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(oreo|oreos)\b(?!\s+(puffs?|o'?s|cereal))/i,
    brand: "OREO",
    title: "Chocolate Sandwich Cookies",
    ingredients: "Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Sugar, Palm and/or Canola Oil, Cocoa (Processed with Alkali), High Fructose Corn Syrup, Leavening (Baking Soda and/or Calcium Phosphate), Salt, Soy Lecithin, Chocolate, Artificial Flavor.",
    imageUrl: "/products/snacks.jpg",
    sourceUrl: "https://www.oreo.com/products/oreo-cookies",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(cheetos)\b/i,
    brand: "Cheetos",
    title: "Crunchy Cheese Flavored Snacks",
    ingredients: "Enriched Corn Meal (Corn Meal, Ferrous Sulfate, Niacin, Thiamin Mononitrate, Riboflavin, Folic Acid), Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Cheese Seasoning (Whey, Cheddar Cheese, Canola Oil, Maltodextrin, Natural and Artificial Flavors, Salt, Whey Protein Concentrate, Monosodium Glutamate, Lactic Acid, Citric Acid, Artificial Color [Yellow 6]), and Salt.",
    imageUrl: "/products/chips.jpg",
    sourceUrl: "https://www.cheetos.com/products/cheetos-crunchy-cheese-flavored-snacks",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(takis)\b/i,
    brand: "Takis",
    title: "Fuego Hot Chili Pepper & Lime Tortilla Chips",
    ingredients: "Corn Masa Flour, Vegetable Oil (Palm and/or Soybean and/or Canola Oil), Seasoning (Maltodextrin, Citric Acid, Sugar, Potassium Chloride, Salt, Monosodium Glutamate, Hydrolyzed Soy Protein, Natural and Artificial Flavors, Hydrolyzed Yeast, Soybean Oil, Onion Powder, Red 40 Lake, Yellow 6 Lake, Sodium Bicarbonate, Chili Pepper, Disodium Inosinate, Disodium Guanylate, TBHQ).",
    imageUrl: "/products/chips.jpg",
    sourceUrl: "https://www.barcel-usa.com/takis-fuego",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(froot loops|fruit loops)\b/i,
    brand: "Kellogg's",
    title: "Froot Loops Sweetened Multigrain Cereal",
    ingredients: "Corn Flour Blend, Sugar, Wheat Flour, Whole Grain Oat Flour, Modified Food Starch, Contains 2% or Less of Vegetable Oil (Hydrogenated Coconut, Soybean and/or Cottonseed), Oat Fiber, Maltodextrin, Salt, Soluble Corn Fiber, Natural Flavor, Red 40, Yellow 5, Blue 1, Yellow 6.",
    imageUrl: "/products/cereal.jpg",
    sourceUrl: "https://www.wkkellogg.com/en_US/products/kellogg-s-froot-loops-cereal-product.html",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(lucky charms)\b/i,
    brand: "General Mills",
    title: "Lucky Charms Cereal with Marshmallows",
    ingredients: "Whole Grain Oats, Sugar, Whole Grain Corn, Corn Starch, Corn Syrup, Dextrose, Contains 2% or Less of: Salt, Modified Corn Starch, Gelatin, Trisodium Phosphate, Fruit and Vegetable Juice for Color, Spirulina Extract for Color, Turmeric Extract for Color, Annatto Extract for Color, Natural Flavor, Vitamin E (mixed tocopherols) Added to Preserve Freshness.",
    imageUrl: "/products/cereal.jpg",
    sourceUrl: "https://www.luckycharms.com/products/original-lucky-charms",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(cinnamon toast crunch)\b/i,
    brand: "General Mills",
    title: "Cinnamon Toast Crunch Cereal",
    ingredients: "Whole Grain Wheat, Sugar, Rice Flour, Canola and/or Sunflower Oil, Fructose, Maltodextrin, Dextrose, Salt, Cinnamon, Trisodium Phosphate, Soy Lecithin, Caramel Color. BHT Added to Preserve Freshness.",
    imageUrl: "/products/cereal.jpg",
    sourceUrl: "https://www.cinnamontoastcrunch.com/products/cinnamon-toast-crunch",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bhoney nut cheerios\b/i,
    brand: "General Mills",
    title: "Honey Nut Cheerios Oats Cereal",
    ingredients: "Whole Grain Oats, Sugar, Corn Starch, Honey, Brown Sugar Syrup, Salt, Tripotassium Phosphate, Canola and/or Sunflower Oil, Natural Almond Flavor. Vitamin E (mixed tocopherols) Added to Preserve Freshness.",
    imageUrl: "/products/cereal.jpg",
    sourceUrl: "https://www.cheerios.com/products/honey-nut-cheerios",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?=.*\bcheerios\b)(?!.*\b(honey|frosted|chocolate|strawberry|berry|apple|cinnamon|multigrain|oat\s*crunch)\b).*$/i,
    brand: "General Mills",
    title: "Original Cheerios Toasted Whole Grain Oat Cereal",
    ingredients: "Whole Grain Oats, Corn Starch, Sugar, Salt, Tripotassium Phosphate. Vitamin E (mixed tocopherols) Added to Preserve Freshness.",
    imageUrl: "/swaps/cereal.jpg",
    sourceUrl: "https://www.cheerios.com/products/original-cheerios",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?=.*\bchobani\b)(?=.*\bplain\b)(?!.*\b(flip|strawberry|vanilla|blueberry|peach|mango|berry|creamer|oat)\b).*$/i,
    brand: "Chobani",
    title: "Non-Fat Greek Yogurt Plain",
    ingredients: "Cultured Nonfat Milk. Live and Active Cultures: S. Thermophilus, L. Bulgaricus, L. Acidophilus, Bifidus, L. Casei, and L. Rhamnosus.",
    imageUrl: "/swaps/yogurt.jpg",
    sourceUrl: "https://www.chobani.com/products/greek/plain/non-fat-plain",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(go[- ]?gurt)\b/i,
    brand: "Yoplait Go-GURT",
    title: "Go-GURT Portable Lowfat Yogurt Tubes",
    ingredients: "Cultured Grade A Low Fat Milk, Sugar, Modified Corn Starch, Kosher Gelatin, Tricalcium Phosphate, Natural Flavor, Colored with Vegetable Juice and Beta Carotene, Citric Acid, Vitamin A Acetate, Vitamin D3.",
    imageUrl: "/products/yogurt.jpg",
    sourceUrl: "https://www.yoplait.com/products/go-gurt",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\bplain\b).*\b(yoplait)\b/i,
    brand: "Yoplait",
    title: "Original Strawberry Lowfat Yogurt",
    ingredients: "Cultured Pasteurized Grade A Lowfat Milk, Sugar, Strawberries, Modified Corn Starch, Nonfat Milk, Kosher Gelatin, Citric Acid, Tricalcium Phosphate, Natural Flavor, Pectin, Colored with Carmine, Vitamin A Acetate, Vitamin D3.",
    imageUrl: "/products/yogurt.jpg",
    sourceUrl: "https://www.yoplait.com/products/original-strawberry",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(hidden valley)\b/i,
    brand: "Hidden Valley",
    title: "Original Ranch Salad Dressing & Topping",
    ingredients: "Vegetable Oil (Soybean and/or Canola), Water, Egg Yolk, Sugar, Salt, Cultured Nonfat Buttermilk, Natural Flavors, Less than 1% of: Spices, Dried Garlic, Dried Onion, Vinegar, Phosphoric Acid, Xanthan Gum, Modified Food Starch, Monosodium Glutamate, Artificial Flavors, Disodium Phosphate, Sorbic Acid and Calcium Disodium EDTA Added to Preserve Freshness, Disodium Inosinate and Disodium Guanylate.",
    imageUrl: "/products/ranch.jpg",
    sourceUrl: "https://www.hiddenvalley.com/products/ranch-condiments/classic-ranch/original-ranch/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /(?<!primal kitchen |avocado oil |organic )\branch dressing\b/i,
    brand: "Representative Category Formulation",
    title: "Creamy Ranch Salad Dressing (Category Estimate)",
    ingredients: "Vegetable Oil (Soybean and/or Canola), Water, Egg Yolk, Sugar, Salt, Cultured Nonfat Buttermilk, Natural Flavors, Less than 1% of: Spices, Dried Garlic, Dried Onion, Vinegar, Phosphoric Acid, Xanthan Gum, Modified Food Starch, Monosodium Glutamate, Artificial Flavors, Disodium Phosphate, Sorbic Acid and Calcium Disodium EDTA Added to Preserve Freshness, Disodium Inosinate and Disodium Guanylate.",
    imageUrl: "/products/ranch.jpg",
    sourceUrl: "https://fdc.nal.usda.gov/food-details/173590/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(triscuit)\b/i,
    brand: "Triscuit",
    title: "Original Whole Grain Wheat Crackers",
    ingredients: "Whole Grain Wheat, Canola Oil, Sea Salt.",
    imageUrl: "/swaps/crackers.jpg",
    nutrition: { caloriesKcal100g: 428, sugarsG100g: 0, saturatedFatG100g: 0.9, sodiumMg100g: 570, fiberG100g: 10.7, proteinG100g: 10.7, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://www.snackworks.com/products/triscuit-original-whole-grain-wheat-crackers/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(ritz)\b/i,
    brand: "Ritz",
    title: "Original Baked Crackers",
    ingredients: "Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Soybean and/or Canola Oil, Palm Oil, Sugar, Salt, Leavening (Calcium Phosphate, Baking Soda), High Fructose Corn Syrup, Soy Lecithin, Natural Flavor.",
    imageUrl: "/products/crackers.jpg",
    sourceUrl: "https://www.snackworks.com/products/ritz-original-crackers/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /(?<!mary'?s gone |organic |seed )\b(club crackers|town house|wheat thins|saltines|butter crackers|holiday crackers)\b/i,
    brand: "Representative Cracker Formulation",
    title: "Baked Snack Crackers (Representative Formulation)",
    ingredients: "Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Soybean and/or Canola Oil, Sugar, Salt, Leavening (Calcium Phosphate, Baking Soda), Soy Lecithin.",
    imageUrl: "/products/crackers.jpg",
    sourceUrl: "https://fdc.nal.usda.gov/food-details/175007/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(knoppers|storck)\b|\b(hazelnut wafers?)\b/i,
    brand: "Storck",
    title: "Knoppers Milk Chocolate & Hazelnut Wafers",
    ingredients: "Sugar, Vegetable Fats (Palm, Shea), Whole Milk Powder, Cocoa Butter, Wheat Flour, Hazelnuts, Cocoa Mass, Skim Milk Powder, Lactose, Butterfat, Low-Fat Cocoa, Soy Lecithin, Whey Product, Salt, Natural Flavors, Sodium Bicarbonate.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 535, sugarsG100g: 44, saturatedFatG100g: 16.5, sodiumMg100g: 160, fiberG100g: 2.0, proteinG100g: 6.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e" },
    sourceUrl: "https://www.knoppers.com/en/products/knoppers",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(tony'?s\s+chocolonely)\b/i,
    brand: "Tony's Chocolonely",
    title: "Milk Chocolate Caramel Sea Salt Bar",
    ingredients: "Sugar, Dry Whole Milk, Cocoa Butter, Chocolate Liquor, Caramel Pieces (Sugar, Corn Syrup, Cream, Butter), Sea Salt, Soy Lecithin.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Tony's%20Chocolonely%20Milk%20Caramel%20Sea%20Salt",
    nutrition: { caloriesKcal100g: 533, sugarsG100g: 50.0, saturatedFatG100g: 18.0, sodiumMg100g: 215, fiberG100g: 3.3, proteinG100g: 6.7, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://us.tonyschocolonely.com/products/milk-caramel-sea-salt-32",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(lindt|lindor)\b/i,
    brand: "Lindt",
    title: "Lindt Lindor Milk Chocolate Candy Truffles",
    ingredients: "Milk Chocolate (Sugar, Cocoa Butter, Milk, Chocolate, Soya Lecithin (Emulsifier), Barley Malt Powder, Vanillin (Artificial Flavoring)), Vegetable Oil (Coconut, Palm Kernel), Sugar, Chocolate, Cocoa Butter, Milk, Soya Lecithin (Emulsifier), Barley Malt Powder, Artificial Flavors.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Lindt%20Lindor%20Milk%20Chocolate%20Candy%20Truffles",
    nutrition: { caloriesKcal100g: 611, sugarsG100g: 44.4, saturatedFatG100g: 33.3, sodiumMg100g: 83, fiberG100g: 2.8, proteinG100g: 5.6, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.lindtusa.com/lindor-milk-chocolate-truffles-bag-431922",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(ferrero\s+(?:rocher|collection))\b/i,
    brand: "Ferrero",
    title: "Ferrero Rocher Fine Hazelnut Milk Chocolates",
    ingredients: "Milk Chocolate (Sugar, Cocoa Butter, Cocoa Mass, Skim Milk Powder, Butteroil, Lecithin as Emulsifier (Soy), Vanillin: An Artificial Flavor), Hazelnuts, Sugar, Palm Oil, Wheat Flour, Whey (Milk), Lowfat Cocoa Powder, Lecithin as Emulsifier (Soy), Sodium Bicarbonate as Leavening Agent, Salt, Vanillin: An Artificial Flavor.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Ferrero%20Rocher%20Fine%20Hazelnut%20Milk%20Chocolate",
    nutrition: { caloriesKcal100g: 595, sugarsG100g: 40.5, saturatedFatG100g: 14.3, sodiumMg100g: 60, fiberG100g: 4.8, proteinG100g: 7.1, fruitsVegNutsPct: 28, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.ferrerorocher.com/us/en/our-products/ferrero-rocher",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(reese'?s)\b(?!\s+puffs)/i,
    brand: "Reese's",
    title: "Reese's Milk Chocolate Peanut Butter Cups",
    ingredients: "Milk Chocolate (Sugar, Cocoa Butter, Chocolate, Skim Milk, Milk Fat, Lactose, Lecithin (Soy), PGPR), Peanuts, Sugar, Dextrose, Salt, TBHQ and Citric Acid, to Maintain Freshness.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Reese's%20Milk%20Chocolate%20Snack%20Size",
    nutrition: { caloriesKcal100g: 500, sugarsG100g: 52.4, saturatedFatG100g: 10.7, sodiumMg100g: 357, fiberG100g: 4.8, proteinG100g: 11.9, fruitsVegNutsPct: 25, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.hersheyland.com/products/reeses-milk-chocolate-peanut-butter-cups-1-5-oz.html",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(hershey'?s?)\b/i,
    brand: "Hershey's",
    title: "Hershey's Milk Chocolate Candy Bar",
    ingredients: "Milk Chocolate (Sugar, Milk, Chocolate, Cocoa Butter, Milk Fat, Lecithin (Soy), PGPR, Natural Flavor).",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Hershey's%20Milk%20Chocolate%20Candy%20Bar",
    nutrition: { caloriesKcal100g: 535, sugarsG100g: 51, saturatedFatG100g: 18.0, sodiumMg100g: 75, fiberG100g: 3.0, proteinG100g: 7.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.hersheyland.com/products/hersheys-milk-chocolate-candy-bars-1-55-oz.html",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(frank'?s\s+redhot)\b.*\b(wings?|buffalo)\b/i,
    brand: "Frank's RedHot",
    title: "Frank's RedHot Wings Buffalo Sauce",
    ingredients: "Distilled Vinegar, Aged Cayenne Red Peppers, Salt, Water, Canola Oil, Paprika, Xanthan Gum, Natural Butter Type Flavor and Garlic Powder.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Frank's%20RedHot%20Wings%20Buffalo%20Sauce",
    nutrition: { caloriesKcal100g: 33, sugarsG100g: 0, saturatedFatG100g: 0, sodiumMg100g: 3060, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 35, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.mccormick.com/franks-redhot/products/sauces/franks-redhot-buffalo-wings-sauce",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(frank'?s\s+redhot)\b/i,
    brand: "Frank's RedHot",
    title: "Frank's RedHot Original Cayenne Pepper Hot Sauce",
    ingredients: "Aged Cayenne Red Peppers, Distilled Vinegar, Water, Salt and Garlic Powder.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Frank's%20RedHot%20Original%20Cayenne%20Pepper%20Sauce",
    nutrition: { caloriesKcal100g: 0, sugarsG100g: 0, saturatedFatG100g: 0, sodiumMg100g: 3800, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 50, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.mccormick.com/franks-redhot/products/sauces/franks-redhot-original-cayenne-pepper-sauce",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(kinder|ghirardelli|snickers|twix|kit\s*kat|m&m'?s|butterfinger|milky way|3 musketeers)\b|\b(chocolate variety|milk and creamy chocolate|chocolate candy|chocolate bar|chocolate truffles)\b/i,
    brand: "Representative Confectionery Formulation",
    title: "Milk Chocolate Confectionery (Representative Formulation)",
    ingredients: "Sugar, Chocolate, Cocoa Butter, Milk, Skim Milk, Milkfat, Soy Lecithin, PGPR (Emulsifier), Natural Flavor.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 535, sugarsG100g: 51, saturatedFatG100g: 18.0, sodiumMg100g: 75, fiberG100g: 3.0, proteinG100g: 7.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e" },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/167587/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(velveeta)\b/i,
    brand: "Velveeta",
    title: "Original Pasteurized Recipe Cheese Product",
    ingredients: "Milk, Water, Whey, Milk Protein Concentrate, Milkfat, Whey Protein Concentrate, Sodium Phosphate, Contains Less than 2% of Salt, Calcium Phosphate, Lactic Acid, Sorbic Acid as a Preservative, Sodium Citrate, Sodium Alginate, Enzymes, Apocarotenal and Annatto (Color), Cheese Culture.",
    imageUrl: "/products/butter.jpg",
    nutrition: { caloriesKcal100g: 285, sugarsG100g: 7.0, saturatedFatG100g: 11.0, sodiumMg100g: 1460, fiberG100g: 0, proteinG100g: 14.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e" },
    sourceUrl: "https://www.myfoodandfamily.com/brands/velveeta/product/00021000611614",
    verifiedAt: "2026-11-08",
  },
  {
    match: /(?<!organic )\b(processed cheese|cheese loaf|queso dip|pasteurized process cheese)\b/i,
    brand: "Representative Process Cheese Formulation",
    title: "Pasteurized Process Cheese and Queso Dip (Representative Formulation)",
    ingredients: "Milk, Water, Whey, Milkfat, Sodium Phosphate, Salt, Calcium Phosphate, Lactic Acid, Sorbic Acid (Preservative), Sodium Citrate, Enzymes, Annatto (Color), Cheese Culture.",
    imageUrl: "/products/butter.jpg",
    nutrition: { caloriesKcal100g: 285, sugarsG100g: 7.0, saturatedFatG100g: 11.0, sodiumMg100g: 1460, fiberG100g: 0, proteinG100g: 14.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e" },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/170851/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(uncured)\b.*\b(turkey bacon)\b|\b(applegate)\b.*\b(turkey bacon)\b/i,
    brand: "Applegate Naturals",
    title: "Hickory Smoked Uncured Turkey Bacon",
    ingredients: "Turkey, Water, Contains Less than 2% of Sea Salt, Cane Sugar, Celery Powder, Rosemary Extract.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 215, sugarsG100g: 1.5, saturatedFatG100g: 2.8, sodiumMg100g: 760, fiberG100g: 0, proteinG100g: 17.0, fruitsVegNutsPct: 0, isWholeFood: false },
    sourceUrl: "https://applegate.com/products/natural-uncured-turkey-bacon",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(uncured)\b.*\b(bacon|sunday bacon|black forest|hickory smoked)\b|\b(applegate|coleman|dietz\s*&\s*watson|nueske'?s|paleo|pederson'?s)\b.*\b(bacon)\b/i,
    brand: "Natural Uncured",
    title: "Hickory Smoked Uncured Pork Bacon",
    ingredients: "Pork, Water, Sea Salt, Less than 2% of Cane Sugar, Celery Powder.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 410, sugarsG100g: 1.5, saturatedFatG100g: 13.5, sodiumMg100g: 920, fiberG100g: 0, proteinG100g: 24.0, fruitsVegNutsPct: 0, isWholeFood: false },
    sourceUrl: "https://applegate.com/products/natural-sunday-bacon",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(uncured|bits|ranch|hot pocket|macaroni)\b).*\b(wellsley farms sliced bacon|hormel.*bacon|smithfield.*bacon|oscar mayer.*bacon|wright.*bacon|farmland.*bacon|kirkland.*bacon|great value.*bacon|member'?s mark.*bacon|thick cut.*bacon|microwave ready bacon|fully cooked bacon|hickory smoked.*bacon|sliced bacon|pork bacon|low sodium bacon|bacon)\b/i,
    brand: "Cured Pork Bacon",
    title: "Hickory Smoked Cured Sliced Bacon",
    ingredients: "Pork, Water, Salt, Sugar, Sodium Phosphate, Sodium Erythorbate, Sodium Nitrite.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 440, sugarsG100g: 1.5, saturatedFatG100g: 14.5, sodiumMg100g: 1080, fiberG100g: 0, proteinG100g: 26.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/168322/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(beyond meat|beyond burger|beyond sausage|beyond beef)\b/i,
    brand: "Beyond Meat",
    title: "Plant-Based Burger Patties",
    ingredients: "Water, Pea Protein, Expeller-Pressed Canola Oil, Refined Coconut Oil, Rice Protein, Natural Flavors, Methylcellulose, Potato Starch, Apple Extract, Pomegranate Extract, Salt, Potassium Chloride, Vinegar, Lemon Juice Concentrate, Sunflower Lecithin, Beet Juice Extract (for Color).",
    imageUrl: "/products/turkey.jpg",
    sourceUrl: "https://www.beyondmeat.com/en-US/products/the-beyond-burger",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(impossible burger|impossible sausage|impossible beef|impossible foods)\b/i,
    brand: "Impossible Foods",
    title: "Plant-Based Burger Patties",
    ingredients: "Water, Soy Protein Concentrate, Sunflower Oil, Coconut Oil, 2% or Less of: Methylcellulose, Yeast Extract, Salt, Natural Flavors, Cultured Dextrose, Modified Food Starch, Soy Leghemoglobin, Mixed Tocopherols (Antioxidant), Soy Protein Isolate, Vitamins and Minerals.",
    imageUrl: "/products/turkey.jpg",
    sourceUrl: "https://impossiblefoods.com/products/beef/impossible-burger-patties",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(morningstar farms|boca|gardein)\b/i,
    brand: "Representative Plant-Based Meat Formulation",
    title: "Plant-Based Patties and Tenders (Representative Formulation)",
    ingredients: "Water, Soy Protein Concentrate, Wheat Gluten, Vegetable Oil (Corn, Canola and/or Sunflower Oil), Soy Protein Isolate, Methylcellulose, Salt, Yeast Extract, Natural Flavors, Spices, Xanthan Gum, Onion Powder, Garlic Powder.",
    imageUrl: "/products/turkey.jpg",
    sourceUrl: "https://fdc.nal.usda.gov/food-details/175114/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(hot pocket|hot pockets|lean pocket|lean pockets|pizza rolls|totino'?s|bagel bites|stouffer'?s)\b/i,
    brand: "Representative Category Formulation",
    title: "Frozen Stuffed Sandwich and Entree (Representative Formulation)",
    ingredients: "Enriched Flour (Wheat Flour, Malted Barley Flour, Niacin, Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Cooked White Meat Chicken, Reduced Fat Cheddar Cheese, Soybean Oil, Bacon (Cured with Water, Salt, Sugar, Smoke Flavoring, Sodium Phosphate, Sodium Erythorbate, Sodium Nitrite), 2% or Less of Modified Food Starch, Sugar, Salt, Buttermilk, Potassium Chloride, Autolyzed Yeast Extract, Disodium Phosphate, Xanthan Gum, Monosodium Glutamate, Natural Flavors.",
    imageUrl: "/products/snacks.jpg",
    sourceUrl: "https://fdc.nal.usda.gov/food-details/167707/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(jimmy\s+dean|breakfast\s+croissant|sausage,?\s*egg\s*(&|and)\s*cheese)\b/i,
    brand: "Jimmy Dean",
    title: "Pork Breakfast Sausage (Representative Formulation)",
    ingredients: "Pork, Water, Contains 2% or Less of: Salt, Sugar, Spices, Dextrose, Monosodium Glutamate, Natural Flavorings, Citric Acid.",
    imageUrl: "/products/turkey.jpg",
    sourceUrl: "https://www.jimmydean.com/products/fresh-sausage/roll-sausage/premium-pork-regular-sausage/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(hillshire farm|kielbasa|polska kielbasa|smoked sausage|eckrich|johnsonville)\b/i,
    brand: "Representative Smoked Sausage Formulation",
    title: "Smoked Sausage and Kielbasa (Representative Formulation)",
    ingredients: "Pork, Turkey, Beef, Water, Corn Syrup, Modified Food Starch, Contains 2% or Less of Salt, Dextrose, Sodium Citrate, Sodium Phosphate, Monosodium Glutamate, Sodium Diacetate, Sodium Erythorbate, Flavorings, Sodium Nitrite.",
    imageUrl: "/products/turkey.jpg",
    sourceUrl: "https://fdc.nal.usda.gov/food-details/174580/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(oscar\s+mayer)\b.*\b(deli\s+fresh|turkey|oven\s+roasted)\b/i,
    brand: "Oscar Mayer",
    title: "Oscar Mayer Deli Fresh Oven Roasted Turkey Breast",
    ingredients: "Turkey Breast, Water, Modified Cornstarch, Contains Less than 2% of Vinegar, Salt, Cultured Dextrose, Sugar, Sodium Phosphates, Carrageenan, Caramel Color.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 89, sugarsG100g: 1.8, saturatedFatG100g: 0.4, sodiumMg100g: 890, fiberG100g: 0, proteinG100g: 16.0, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.oscarmayer.com/products/00044700030806-deli-fresh-oven-roasted-turkey-breast-sliced-lunch-meat",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(tyson)\b.*\b(grilled\s*(&|and)?\s*ready|grilled.*chicken|roasted.*chicken|unbreaded.*chicken)\b/i,
    brand: "Tyson",
    title: "Tyson Grilled & Ready Fully Cooked Chicken Breast Strips",
    ingredients: "Chicken Breast with Rib Meat, Water, Seasoning (Salt, Sugar, Yeast Extract, Maltodextrin, Spices, Chicken Broth, Garlic Powder, Onion Powder, Natural Flavors), Potato Starch, Vinegar.",
    imageUrl: "/swaps/turkey.jpg",
    nutrition: { caloriesKcal100g: 135, sugarsG100g: 0.8, saturatedFatG100g: 0.8, sodiumMg100g: 480, fiberG100g: 0, proteinG100g: 23.0, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.tyson.com/products/grilled-chicken-breast-strips/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(grilled|roasted|rotisserie|unbreaded|naked)\b.*\b(chicken\s+(breast\s+)?(strips?|bites?|cuts?|diced|chunks?))\b|\b(chicken\s+(breast\s+)?(strips?|bites?|cuts?))\b.*\b(grilled|roasted|rotisserie|unbreaded)\b/i,
    brand: "Grilled Poultry",
    title: "Fully Cooked Grilled Chicken Breast Strips",
    ingredients: "Boneless, Skinless Chicken Breast with Rib Meat, Water, Contains 2% or Less of Salt, Vinegar, Natural Flavor, Garlic Powder, Onion Powder, Spices.",
    imageUrl: "/swaps/turkey.jpg",
    nutrition: { caloriesKcal100g: 135, sugarsG100g: 0.5, saturatedFatG100g: 0.8, sodiumMg100g: 410, fiberG100g: 0, proteinG100g: 23.0, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171477/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(grilled|unbreaded|naked)\b).*\b(crispy chicken|breaded chicken|chicken patties|chicken patty|chicken nuggets|chicken tenders|chicken strips|popcorn chicken|chicken fries|perdue.*breaded|tyson.*chicken|wellsley farms.*crispy chicken|wellsley farms.*chicken patties)\b/i,
    brand: "Breaded Poultry",
    title: "Breaded Crispy Chicken Breast Patties",
    ingredients: "Boneless Skinless Chicken Breast with Rib Meat, Water, Wheat Flour, Bleached Wheat Flour, Modified Food Starch, Vegetable Oil (Soybean and/or Canola Oil), Salt, Dextrose, Sodium Phosphates, Leavening (Sodium Acid Pyrophosphate, Sodium Bicarbonate), Yeast Extract, Onion Powder, Garlic Powder, Spice, Natural Flavor.",
    imageUrl: "/products/turkey.jpg",
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171502/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(heinz.*gravy|turkey gravy|chicken gravy|beef gravy|mushroom gravy|country gravy|sausage gravy|homestyle.*gravy|franco[- ]?american.*gravy|mccormick.*gravy|campbell'?s.*gravy|pioneer.*gravy|\bgravy\b)\b/i,
    brand: "Representative Gravy Formulation",
    title: "Homestyle Savory Gravy (Representative Formulation)",
    ingredients: "Turkey Broth, Water, Modified Corn Starch, Enriched Wheat Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Chicken Fat, Contains Less than 2% of Salt, Turkey Meat, Monosodium Glutamate, Autolyzed Yeast Extract, Caramel Color, Onion Powder, Disodium Inosinate, Disodium Guanylate, Natural Flavor.",
    imageUrl: "/products/ranch.jpg",
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171574/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(kettle\s*&\s*fire|organic.*broth|organic.*stock|bone broth)\b/i,
    brand: "Kettle & Fire",
    title: "Organic Slow-Simmered Bone Broth",
    ingredients: "Organic Bone Broth (Water, Organic Chicken Bones, Organic Onions, Organic Carrots, Organic Celery), Organic Apple Cider Vinegar, Sea Salt, Organic Rosemary, Organic Sage, Organic Thyme, Organic Black Pepper.",
    imageUrl: "/swaps/turkey.jpg",
    nutrition: { isOrganic: true, isWholeFood: true },
    sourceUrl: "https://www.kettleandfire.com/products/chicken-bone-broth",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(gatorade)\b/i,
    brand: "Gatorade",
    title: "Thirst Quencher Fruit Punch Sports Drink",
    ingredients: "Water, Sugar, Dextrose, Citric Acid, Salt, Sodium Citrate, Monopotassium Phosphate, Gum Arabic, Natural Flavor, Sucrose Acetate Isobutyrate, Glycerol Ester of Rosin, Red 40.",
    imageUrl: "/products/snacks.jpg",
    sourceUrl: "https://www.gatorade.com/powders-and-liquids/gatorade-thirst-quencher/fruit-punch",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(capri\s*sun)\b/i,
    brand: "Capri Sun",
    title: "Fruit Punch Juice Drink Blend",
    ingredients: "Water, Sugar, Apple, Grape and Cherry Juice Concentrates, Citric Acid, Natural Flavor.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 30, sugarsG100g: 7.2, saturatedFatG100g: 0, sodiumMg100g: 8, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 10 },
    sourceUrl: "https://www.myfoodandfamily.com/brands/capri-sun/product/00087684001035",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(health[- ]?ade)\b/i,
    brand: "Health-Ade",
    title: "Organic Raw Kombucha",
    ingredients: "Purified Water, Kombucha Culture (Yeast and Bacteria Cultures), Organic Black Tea, Organic Green Tea, Organic Cane Sugar, Organic Cold Pressed Juice.",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 15, sugarsG100g: 3.2, saturatedFatG100g: 0, sodiumMg100g: 5, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 20, isOrganic: true },
    sourceUrl: "https://health-ade.com/collections/kombucha/products/kombucha-pink-lady-apple",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(goldfish)\b/i,
    brand: "Pepperidge Farm",
    title: "Goldfish Cheddar Baked Snack Crackers",
    ingredients: "Made With Smiles And Enriched Wheat Flour (Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Cheddar Cheese (Cultured Milk, Salt, Enzymes, Annatto), Vegetable Oils (Canola, Sunflower And/Or Soybean), Salt, Contains 2% Or Less Of: Yeast, Sugar, Autolyzed Yeast Extract, Paprika, Spices, Celery, Onion Powder, Monocalcium Phosphate, Baking Soda.",
    imageUrl: "/products/crackers.jpg",
    sourceUrl: "https://www.pepperidgefarm.com/product/goldfish-cheddar-crackers/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(nutella)\b/i,
    brand: "Ferrero",
    title: "Nutella Hazelnut Spread with Cocoa",
    ingredients: "Sugar, Palm Oil, Hazelnuts, Skim Milk, Cocoa, Soy Lecithin as Emulsifier, Vanillin: An Artificial Flavor.",
    imageUrl: "/products/snacks.jpg",
    sourceUrl: "https://www.nutella.com/us/en/products/nutella",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(goodles)\b/i,
    brand: "Goodles",
    title: "Cheddy Mac Creamy Cheddar Macaroni & Cheese",
    ingredients: "Goodles Noodles (Wheat Flour, Chickpea Protein, Wheat Protein, Oat Fiber, Nutrient Extract Blend), Cheddar Cheese (Cultured Milk, Salt, Enzymes), Whey, Butter (Cream, Natural Flavor), Salt, Disodium Phosphate, Lactic Acid, Annatto Extract (For Color).",
    imageUrl: "/swaps/snacks.jpg",
    sourceUrl: "https://www.goodles.com/products/cheddy-mac/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(annie'?s|organic)\b.*\b(macaroni\s*(and|&)\s*cheese|mac\s*(and|&)\s*cheese|shells\s*(and|&)\s*(?:real\s+aged\s+)?cheddar)\b/i,
    brand: "Annie's Homegrown",
    title: "Organic Grass-Fed Shells & Real Aged Cheddar",
    ingredients: "Organic Wheat Pasta (Organic Wheat Flour), Organic Grass-Fed Cheddar Cheese (Cultured Pasteurized Organic Milk, Salt, Non-Animal Enzymes), Organic Whey, Organic Nonfat Milk, Organic Butter (Organic Cream, Salt), Salt, Cultured Whole Milk, Sodium Phosphate, Organic Annatto Extract (For Color).",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 386, sugarsG100g: 7.1, saturatedFatG100g: 3.6, sodiumMg100g: 757, fiberG100g: 2.9, proteinG100g: 14.3, fruitsVegNutsPct: 0, isOrganic: true, isWholeFood: false },
    sourceUrl: "https://www.annies.com/product/organic-grass-fed-shells-real-aged-cheddar-mac-cheese",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\b(macaroni\s*(and|&)\s*cheese|mac\s*(and|&)\s*cheese|kraft\s+mac|velveeta\s+shells)\b/i,
    brand: "Kraft",
    title: "Original Macaroni & Cheese Dinner",
    ingredients: "Enriched Macaroni Product (Wheat Flour, Durum Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Cheese Sauce Mix (Whey, Milkfat, Salt, Milk Protein Concentrate, Sodium Triphosphate, Contains Less than 2% of Tapioca Flour, Citric Acid, Lactic Acid, Sodium Phosphate, Calcium Phosphate, with Paprika, Turmeric, and Annatto Added for Color, Enzymes, Cheese Culture).",
    imageUrl: "/products/snacks.jpg",
    sourceUrl: "https://www.myfoodandfamily.com/brands/kraft-mac-and-cheese/product/00021000658831",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(organic|alexandre|kalona|maple hill)\b.*\b(eggnog|egg nog)\b/i,
    brand: "Organic Valley",
    title: "Organic Eggnog",
    ingredients: "Organic Grade A Milk, Organic Grade A Cream, Organic Cane Sugar, Organic Egg Yolks, Organic Vanilla Extract, Organic Nutmeg.",
    imageUrl: "/swaps/yogurt.jpg",
    nutrition: { isOrganic: true, isWholeFood: false },
    sourceUrl: "https://www.organicvalley.coop/products/eggnog/eggnog/eggnog-quart/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(eggnog|egg nog)\b/i,
    brand: "Representative Dairy Eggnog Formulation",
    title: "Golden Vanilla Eggnog (Representative Formulation)",
    ingredients: "Milk, Cream, Sugar, Nonfat Milk, Egg Yolks, High Fructose Corn Syrup, Whey, Natural and Artificial Flavor, Nutmeg, Carrageenan, Guar Gum, Mono and Diglycerides, Annatto and Turmeric (Color).",
    imageUrl: "/products/yogurt.jpg",
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171276/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(werther'?s(?:\s+original)?)\b/i,
    brand: "Werther's Original",
    title: "Caramel Hard Candies",
    ingredients: "Sugar, Glucose Syrup (From Wheat or Corn), Cream (Milk), Condensed Whey (Milk), Butter (Milk), Cane Sugar Syrup, Salt, Soy Lecithin (Emulsifier), Artificial Flavor.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 420, sugarsG100g: 74, saturatedFatG100g: 5.5, sodiumMg100g: 260, fiberG100g: 0, proteinG100g: 0.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.werthers-original.us/en/products/hard-candies/caramel-hard-candies",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(red bird|peppermint\s+(candy|puffs?|mints?|bark|stick|canes?)|candy\s+(puffs?|canes?)|starlight\s+mints?|butter\s+mints?|dinner\s+mints?|hard\s+cand(y|ies)|lifesavers|jolly\s+rancher)\b/i,
    brand: "Red Bird",
    title: "Peppermint Candy Puffs",
    ingredients: "Pure Cane Sugar, Invert Sugar, Corn Syrup, Natural Oil of Peppermint, Red 40 (Artificial Color).",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 392, sugarsG100g: 93, saturatedFatG100g: 0, sodiumMg100g: 15, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://piedmontcandy.com/products/all-natural-peppermint-puffs",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(unsweetened|no sugar|freeze[- ]?dried)\b).*\b(auspitee|craisins|sweetened dried|dried cranberr\w*|dried blueberr\w*|dried cherr\w*|dried strawberr\w*|dehydrated\s+(blueberr\w*|cranberr\w*|cherr\w*|strawberr\w*|fruit|berr\w*))\b/i,
    brand: "Sweetened Dried Fruit",
    title: "Sweetened Dried Berries",
    ingredients: "Berries (Blueberries and Cranberries), Cane Sugar, Refined Sunflower Oil (Used as a Processing Aid).",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 325, sugarsG100g: 65, saturatedFatG100g: 0.2, sodiumMg100g: 5, fiberG100g: 5.3, proteinG100g: 0.4, fruitsVegNutsPct: 60, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171723/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(freeze[- ]?dried)\b.*\b(blueberr\w*|strawberr\w*|raspberr\w*|bananas?|apples?|mangos?|peaches|fruit|crisps?)\b|\b(blueberry|strawberry|raspberry|berry|fruit)\s+powder\b/i,
    brand: "Freeze-Dried",
    title: "Freeze-Dried Fruit Crisps",
    ingredients: "Freeze-Dried Fruit (Concentrated Natural Fruit Sugars).",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 345, sugarsG100g: 54, saturatedFatG100g: 0.2, sodiumMg100g: 8, fiberG100g: 7.5, proteinG100g: 2.5, fruitsVegNutsPct: 85, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/173946/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(canola|olive|soybean|vegetable|oil|spread|margarine|peanut|almond|cashew|sunflower|cookie|cocoa|apple|buttermilk|butterfinger|popcorn|croissant|biscuit|crackers|bread|rolls|buns|sauce|chicken)\b).*\b(kerrygold)\b/i,
    brand: "Kerrygold",
    title: "Pure Irish Salted Butter",
    ingredients: "Pasteurized Cream, Salt.",
    imageUrl: "/products/butter.jpg",
    nutrition: { caloriesKcal100g: 717, sugarsG100g: 0.1, saturatedFatG100g: 51.0, sodiumMg100g: 640, fiberG100g: 0, proteinG100g: 0.9, fruitsVegNutsPct: 0, isWholeFood: false },
    sourceUrl: "https://www.kerrygoldusa.com/products/salted-butter/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(soy|soymilk|almond|almondmilk|oat|oatmilk|coconut|cashew|chocolate|strawberry|vanilla|condensed|evaporated|buttermilk|milkshake|creamer|wafer|wafers|candy|bar|fairlife|core\s+power|horizon|organic|lactaid|simple\s+truth|good\s*(?:&|and)\s*gather|favorite\s+day|private\s+selection|protein|shake|elite)\b).*\b(whole.*milk|milk.*whole|2%.*milk|milk.*2%|1%.*milk|skim.*milk|nonfat.*milk|reduced[- ]?fat.*milk|fat[- ]?free.*milk|vitamin d.*milk|great value.*milk|wellsley farms.*milk|kirkland.*milk|member'?s mark.*milk|grade a.*milk)\b/i,
    brand: "Grade A Dairy",
    title: "Grade A Pasteurized Milk",
    ingredients: "Grade A Milk, Vitamin D3.",
    imageUrl: "/swaps/yogurt.jpg",
    nutrition: { isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171265/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(coffee[- ]?mate)\b/i,
    brand: "Coffee mate",
    title: "French Vanilla Liquid Coffee Creamer",
    ingredients: "Water, Sugar, Vegetable Oil (High Oleic Soybean and/or High Oleic Canola), and Less than 2% of Micellar Casein (a Milk Derivative), Mono- and Diglycerides, Dipotassium Phosphate, Natural and Artificial Flavor, Cellulose Gel, Cellulose Gum, Carrageenan.",
    imageUrl: "/products/yogurt.jpg",
    sourceUrl: "https://www.goodnes.com/coffeemate/products/french-vanilla-liquid-coffee-creamer-32-oz-bottle/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(international\s+delight|creamer)\b/i,
    brand: "International Delight",
    title: "Flavored Liquid Coffee Creamer (Representative Formulation)",
    ingredients: "Water, Sugar, Palm and/or Soybean Oil, Contains 2% or Less of: Sodium Caseinate (a Milk Derivative), Dipotassium Phosphate, Carrageenan, Mono and Diglycerides, Cellulose Gel, Cellulose Gum, Natural and Artificial Flavors.",
    imageUrl: "/products/yogurt.jpg",
    sourceUrl: "https://www.internationaldelight.com/products/coffee-creamers/flavor-faves/french-vanilla/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(blount|clam\s+shack)\b.*\b(clam\s+chowder|chowder)\b|\b(clam\s+chowder|new\s+england.*chowder)\b.*\bgluten[\s-]*free\b/i,
    brand: "Blount Clam Shack",
    title: "New England Clam Chowder (Gluten Free)",
    ingredients: "Clam Broth (Water, Clam Juice Concentrate), Potatoes, Clams (Clams, Clam Juice, Salt), Light Cream (Milk, Cream), Onions, Butter (Cream, Salt), Corn Starch, Salt, Spice, Garlic Powder.",
    imageUrl: "/products/ranch.jpg",
    nutrition: { caloriesKcal100g: 110, sugarsG100g: 1.5, saturatedFatG100g: 3.5, sodiumMg100g: 330, fiberG100g: 0.8, proteinG100g: 4.8, fruitsVegNutsPct: 25, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.blountfinefoods.com/products/new-england-clam-chowder",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(panera(\s+bread)?.*broccoli\s+cheddar|broccoli\s+cheddar\s+soup)\b/i,
    brand: "Panera Bread",
    title: "Broccoli Cheddar Soup (Representative Formulation)",
    ingredients: "Water, Milk, Broccoli, Pasteurized Process Cheddar Cheese (Cheddar Cheese [Pasteurized Milk, Cheese Culture, Salt, Enzymes], Water, Sodium Phosphate, Milkfat, Salt, Apocarotenal [Color]), Heavy Cream, Carrots, Seasoning (Modified Corn Starch, Wheat Flour, Salt, Chicken Base [Chicken Meat Including Chicken Juices, Salt, Chicken Fat, Sugar, Maltodextrin, Hydrolyzed Corn Protein, Dried Whey, Natural Flavor, Turmeric], Spices, Paprika), Onions, Butter (Cream, Salt), Soybean Oil, Dijon Mustard (Water, Vinegar, Mustard Seed, Salt, White Wine, Fruit Pectin, Tartaric Acid, Citric Acid, Sugar, Spice), Nisin Preparation, Annatto Extract (Color).",
    imageUrl: "/products/ranch.jpg",
    nutrition: { caloriesKcal100g: 135, sugarsG100g: 2.0, saturatedFatG100g: 5.5, sodiumMg100g: 430, fiberG100g: 1.0, proteinG100g: 4.5, fruitsVegNutsPct: 20, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.panerabreadathome.com/products/soups/broccoli-cheddar-soup",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(clam\s+chowder|new\s+england.*chowder|corn\s+chowder|potato\s+chowder|seafood\s+chowder|lobster\s+bisque|tomato\s+bisque|loaded\s+baked\s+potato\s+soup)\b/i,
    brand: "Representative Deli Soup Formulation",
    title: "New England Style Clam Chowder (Representative Formulation)",
    ingredients: "Light Cream (Milk, Cream), Potatoes, Fish Stock (Water, Cod Bones, Haddock Bones, Onions, Celery, Black Pepper, Thyme, Mustard Seed, Bay Leaves), Sea Clams (Sea Clams, Water), Chopped Cockle (Clam Meat), Onions, Wheat Flour, Soybean Oil, Butter (Cream, Salt), Clam Broth (Dehydrated Clam Broth, Maltodextrin), Sea Salt, Celery, Salt Pork (Pork, Sea Salt), Black Pepper, Worcestershire Sauce (Distilled White Vinegar, Molasses, Sugar, Water, Salt, Onions, Anchovies, Garlic, Cloves, Tamarind Extract, Natural Flavorings, Chili Pepper Extract), Garlic.",
    imageUrl: "/products/ranch.jpg",
    nutrition: { caloriesKcal100g: 115, sugarsG100g: 1.5, saturatedFatG100g: 3.5, sodiumMg100g: 350, fiberG100g: 0.9, proteinG100g: 5.2, fruitsVegNutsPct: 25, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171599/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bmaruchan\b/i,
    brand: "Maruchan",
    title: "Maruchan Ramen Noodle Soup",
    ingredients: "Enriched Wheat Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Vegetable Oil (Contains One or More of the Following: Canola, Cottonseed, Palm) Preserved by TBHQ, Salt, Monosodium Glutamate, Maltodextrin, Hydrolyzed Corn, Wheat and Soy Protein, Dehydrated Vegetables (Onion, Garlic, Chive), Sugar, Spices, Potassium Carbonate, Sodium (Mono, Hexameta, and/or Tripoly) Phosphate, Sodium Carbonate, Soy Sauce (Water, Wheat, Soybeans, Salt), Disodium Inosinate, Disodium Guanylate, Chicken Broth, Caramel Color, Yellow 5, Yellow 6, Silicon Dioxide (Anti-Caking Agent), Natural and Artificial Flavor, Citric Acid, Lactose.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 442, sugarsG100g: 2.3, saturatedFatG100g: 8.2, sodiumMg100g: 1830, fiberG100g: 2.3, proteinG100g: 9.3, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.maruchan.com/products/ramen/chicken-flavor/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(buldak|samyang)\b/i,
    brand: "Samyang",
    title: "Samyang Buldak Hot Chicken Flavor Ramen",
    ingredients: "Noodle: Wheat Flour, Modified Tapioca Starch, Refined Palm Oil, Wheat Gluten, Salt, Emulsifier (Soy Lecithin), Acidity Regulator (Potassium Carbonate, Sodium Carbonate, Sodium Phosphate Dibasic, Citric Acid), Thickener (Guar Gum), Green Tea Flavor Oil, Riboflavin. Soup: Water, Artificial Chicken Flavor Powder (Yeast Extract, Dextrin, Artificial Flavor, Sugar, Monosodium Glutamate), Soy Sauce, Sugar, Chili Pepper Powder, Soybean Oil, Onion, Red Pepper Powder, Red Pepper Seed Oil, Yeast Powder, Garlic, Modified Potato Starch, Decolorized Chili Extract, Paprika Extract, Black Pepper Powder, Curry Powder. Flake: Roasted Sesame, Roasted Laver.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 393, sugarsG100g: 5.0, saturatedFatG100g: 5.7, sodiumMg100g: 914, fiberG100g: 2.9, proteinG100g: 8.6, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://samyangamerica.com/buldak-original/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(lotus\s+foods|organic|mike'?s\s+mighty\s+good|buldak|samyang)\b).*\b(top\s+ramen|nissin|cup\s+noodles?|shin\s+ramyun|indomie|nongshim|sapporo\s+ichiban|instant\s+ramen|ramen\s+noodle\s+soup|ramen\s+noodles?)\b/i,
    brand: "Representative Ramen Formulation",
    title: "Instant Ramen Noodle Soup (Representative Formulation)",
    ingredients: "Enriched Wheat Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Vegetable Oil (Contains One or More of the Following: Canola, Cottonseed, Palm) Preserved by TBHQ, Salt, Monosodium Glutamate, Maltodextrin, Hydrolyzed Corn, Wheat and Soy Protein, Dehydrated Vegetables (Onion, Garlic, Chive), Sugar, Spices, Potassium Carbonate, Sodium (Mono, Hexameta, and/or Tripoly) Phosphate, Sodium Carbonate, Soy Sauce (Water, Wheat, Soybeans, Salt), Disodium Inosinate, Disodium Guanylate, Chicken Broth, Caramel Color, Yellow 5, Yellow 6, Silicon Dioxide (Anti-Caking Agent), Natural and Artificial Flavor, Citric Acid, Lactose.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 442, sugarsG100g: 2.3, saturatedFatG100g: 8.2, sodiumMg100g: 1830, fiberG100g: 2.3, proteinG100g: 9.3, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/168928/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bcampbell'?s\b/i,
    brand: "Campbell's",
    title: "Campbell's Homestyle Chicken Noodle Soup",
    ingredients: "Chicken Stock, Enriched Egg Noodles (Wheat Flour, Egg Whites, Eggs, Niacin, Ferrous Sulfate, Thiamine Mononitrate, Riboflavin, Folic Acid), Cooked Chicken Meat, Carrots, Celery, Contains Less than 2% of: Modified Food Starch, Salt, Chicken Fat, Monosodium Glutamate, Yeast Extract, Soy Protein Isolate, Sodium Phosphate, Potassium Chloride, Natural Flavor, Beta Carotene for Color, Disodium Inosinate, Disodium Guanylate.",
    imageUrl: "/products/ranch.jpg",
    nutrition: { caloriesKcal100g: 55, sugarsG100g: 1.0, saturatedFatG100g: 0.6, sodiumMg100g: 390, fiberG100g: 0.6, proteinG100g: 2.5, fruitsVegNutsPct: 10, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.campbells.com/products/homestyle/chicken-noodle-soup/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(amy'?s|pacific\s+foods|organic|kettle\s*&\s*fire|ramen|maruchan|nissin)\b).*\b(progresso|chunky\s+soup|chicken\s+noodle\s+soup|tomato\s+soup|cream\s+of\s+(mushroom|chicken|celery)|beef\s+stew|vegetable\s+beef\s+soup|minestrone\s+soup|italian\s+wedding\s+soup)\b/i,
    brand: "Representative Soup Formulation",
    title: "Homestyle Canned Soup (Representative Formulation)",
    ingredients: "Chicken Stock, Enriched Egg Noodles (Wheat Flour, Egg Whites, Eggs, Niacin, Ferrous Sulfate, Thiamine Mononitrate, Riboflavin, Folic Acid), Cooked Chicken Meat, Carrots, Celery, Contains Less than 2% of: Modified Food Starch, Salt, Chicken Fat, Monosodium Glutamate, Yeast Extract, Soy Protein Isolate, Sodium Phosphate, Potassium Chloride, Natural Flavor, Beta Carotene for Color, Disodium Inosinate, Disodium Guanylate.",
    imageUrl: "/products/ranch.jpg",
    nutrition: { caloriesKcal100g: 55, sugarsG100g: 1.0, saturatedFatG100g: 0.6, sodiumMg100g: 390, fiberG100g: 0.6, proteinG100g: 2.5, fruitsVegNutsPct: 10, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171590/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(salad\s+kit|chopped\s+kit|caesar\s+salad\s+kit|ranch\s+salad\s+kit|southwest\s+salad\s+kit|asian\s+salad\s+kit|sweet\s+kale\s+kit)\b/i,
    brand: "Representative Salad Kit Formulation",
    title: "Salad Kit with Dressing Packet (Representative Formulation)",
    ingredients: "Romaine Lettuce, Dressing (Soybean and/or Canola Oil, Water, Parmesan Cheese, Egg Yolk, Distilled Vinegar, Salt, Sugar, Garlic, Lemon Juice Concentrate, Natural Flavor, Xanthan Gum), Croutons (Enriched Wheat Flour, Sunflower Oil, Salt, Yeast, Garlic Powder), Parmesan Cheese.",
    imageUrl: "/products/ranch.jpg",
    nutrition: { caloriesKcal100g: 140, sugarsG100g: 3.0, saturatedFatG100g: 2.5, sodiumMg100g: 310, fiberG100g: 2.0, proteinG100g: 3.5, fruitsVegNutsPct: 65, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/173590/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(kit|caesar|ranch|dressing|macaroni|potato\s+salad|chicken\s+salad|tuna\s+salad|egg\s+salad|pasta\s+salad|ham\s+salad|seafood\s+salad)\b).*\b(romaine\s+salad|salad\s+blend|classic\s+romaine|classic\s+iceberg|spring\s+mix|baby\s+spinach|spinach\s+blend|half\s*(&|and)\s*half\s+salad|shredded\s+lettuce|iceberg\s+lettuce|romaine\s+hearts|leaf\s+lettuce|butter\s+lettuce|arugula|kale\s+greens|coleslaw\s+mix|tri[- ]?color\s+slaw|garden\s+salad|field\s+greens|mixed\s+greens|salad\s+greens|sweet\s+butter\s+salad)\b/i,
    brand: "Fresh Produce",
    title: "100% Fresh Washed Salad Greens",
    ingredients: "100% Fresh Whole Produce: Romaine Lettuce, Carrots, Red Cabbage.",
    imageUrl: "/swaps/ranch.jpg",
    nutrition: { caloriesKcal100g: 18, sugarsG100g: 1.5, saturatedFatG100g: 0, sodiumMg100g: 18, fiberG100g: 2.2, proteinG100g: 1.3, fruitsVegNutsPct: 100, nutriScoreGrade: "a", isWholeFood: true },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/169247/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(chips?|crisps?|crispy|fries|fried|tots|waffles?|pie|casserole|canned|syrup|candied|mashed|puffs?|crackers?|pur[eé]e|baby\s+food)\b).*\b(fresh\s+whole\s+sweet\s+potato(?:es)?|whole\s+sweet\s+potato(?:es)?|fresh\s+sweet\s+potato(?:es)?|yams?\s*\(sweet\s+potatoes?\)|sweet\s+potato(?:es)?\b)/i,
    brand: "Fresh Produce",
    title: "Fresh Whole Sweet Potato",
    ingredients: "100% Fresh Whole Sweet Potato (Single-Ingredient Whole Produce).",
    imageUrl: "/swaps/produce.png",
    nutrition: { caloriesKcal100g: 86, sugarsG100g: 4.2, saturatedFatG100g: 0, sodiumMg100g: 55, fiberG100g: 3.0, proteinG100g: 1.6, fruitsVegNutsPct: 100, nutriScoreGrade: "a", isWholeFood: true, isOrganic: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/168482/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(sweet|chips?|crisps?|crispy|fries|fried|tots|hash\s*browns?|instant|mashed|flakes?|au\s+gratin|scalloped|salad|soup|chowder|bread|rolls?|buns?|gnocchi|starch|flour|vodka|canned|roasted|seasoned)\b).*\b(fresh\s+whole\s+(?:russet|idaho|yukon\s+gold|gold|yellow|red|white|baking)?\s*potato(?:es)?|(?:russet|idaho|yukon\s+gold|yellow|red|white|baking)\s+potato(?:es)?|potatoes?,?\s+butter|butter\s+potatoes?)\b/i,
    brand: "Fresh Produce",
    title: "Fresh Whole Potatoes",
    ingredients: "100% Fresh Whole Potatoes (Single-Ingredient Whole Produce).",
    imageUrl: "/swaps/produce.png",
    nutrition: { caloriesKcal100g: 77, sugarsG100g: 0.8, saturatedFatG100g: 0, sodiumMg100g: 6, fiberG100g: 2.2, proteinG100g: 2.0, fruitsVegNutsPct: 100, nutriScoreGrade: "a", isWholeFood: true, isOrganic: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/170026/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(instant\s+mashed\s+potato\w*|potato\s+flakes?|mashed\s+potato\w*\s+mix|idahoan|betty\s+crocker.*potato\w*|great\s+value.*instant\s+mashed|au\s+gratin\s+potato\w*|scalloped\s+potato\w*)\b/i,
    brand: "Representative Instant Potato Formulation",
    title: "Instant Mashed Potatoes (Representative Formulation)",
    ingredients: "Potatoes, Mono- and Diglycerides, Sodium Acid Pyrophosphate (Preservative), Sodium Bisulfite (Preservative), Citric Acid (Preservative).",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 355, sugarsG100g: 2.5, saturatedFatG100g: 1.2, sodiumMg100g: 490, fiberG100g: 5.5, proteinG100g: 7.5, fruitsVegNutsPct: 60, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://idahoan.com/products/idahoan-original-mashed-potatoes/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(ore[- ]?ida|golden\s+crinkles|crispy\s+crowns)\b/i,
    brand: "Ore-Ida",
    title: "Golden Crinkles French Fried Potatoes",
    ingredients: "Potatoes, Vegetable Oil (Canola, Soybean, and/or Sunflower Oil), Salt, Disodium Dihydrogen Pyrophosphate (to Retain Natural Color), Dextrose.",
    imageUrl: "/products/chips.jpg",
    nutrition: { caloriesKcal100g: 155, sugarsG100g: 0.8, saturatedFatG100g: 1.2, sodiumMg100g: 340, fiberG100g: 2.4, proteinG100g: 2.4, fruitsVegNutsPct: 75, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.myfoodandfamily.com/brands/ore-ida/product/00013120000836",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(french\s+fries|crinkle\s+cut\s+fries|waffle\s+fries|steak\s+fries|shoestring\s+fries|curly\s+fries|seasoned\s+fries|tater\s+tots?|hash\s*browns?)\b/i,
    brand: "Representative Frozen Potato Formulation",
    title: "Frozen French Fried Potatoes and Tater Tots (Representative Formulation)",
    ingredients: "Potatoes, Vegetable Oil (Canola, Soybean, and/or Sunflower Oil), Salt, Disodium Dihydrogen Pyrophosphate (to Retain Natural Color), Dextrose.",
    imageUrl: "/products/chips.jpg",
    nutrition: { caloriesKcal100g: 155, sugarsG100g: 0.8, saturatedFatG100g: 1.2, sodiumMg100g: 340, fiberG100g: 2.4, proteinG100g: 2.4, fruitsVegNutsPct: 75, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/170437/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(crispy\s+fried\s+onions?|french'?s.*onions?|french\s+fried\s+onions?|fried\s+onions?|onion\s+rings?)\b/i,
    brand: "French's",
    title: "Original Crispy Fried Onions",
    ingredients: "Onions, Palm Oil, Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Soy Flour, Salt, Dextrose.",
    imageUrl: "/products/chips.jpg",
    nutrition: { caloriesKcal100g: 571, sugarsG100g: 5.0, saturatedFatG100g: 15.5, sodiumMg100g: 800, fiberG100g: 2.8, proteinG100g: 5.2, fruitsVegNutsPct: 20, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.mccormick.com/frenchs/products/crispy-fried-veggies/original-crispy-fried-onions",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(a\.?1\.?\s*(original\s*)?(steak\s*)?sauce|steak\s+sauce|heinz\s+57)\b/i,
    brand: "A.1.",
    title: "Original Steak Sauce",
    ingredients: "Tomato Puree (Water, Tomato Paste), Vinegar, Corn Syrup, Salt, Raisin Paste, Crushed Orange Puree, Spice, Dried Garlic, Caramel Color, Dried Onions, Potassium Sorbate (To Preserve Freshness), Xanthan Gum, Celery Seed.",
    imageUrl: "/products/ranch.jpg",
    nutrition: { caloriesKcal100g: 88, sugarsG100g: 17.6, saturatedFatG100g: 0, sodiumMg100g: 1470, fiberG100g: 0.5, proteinG100g: 1.0, fruitsVegNutsPct: 30, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.myfoodandfamily.com/brands/a1/product/00054400000016",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(steak[- ]?umm\w*)\b/i,
    brand: "Steak-umm",
    title: "100% Beef Sliced Steaks",
    ingredients: "100% Beef.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 280, sugarsG100g: 0, saturatedFatG100g: 9.5, sodiumMg100g: 65, fiberG100g: 0, proteinG100g: 17.5, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.steakumm.com/products/100-beef/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(philly\s+steak|shaved\s+beef\s+steak)\b/i,
    brand: "Representative Sliced Beef Formulation",
    title: "Seasoned Shaved Beef Steak (Representative Formulation)",
    ingredients: "Beef, Water, Salt, Sodium Phosphate.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 280, sugarsG100g: 0, saturatedFatG100g: 9.5, sodiumMg100g: 310, fiberG100g: 0, proteinG100g: 17.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/174036/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b((peaches|pears|mandarin\s+oranges|pineapple|fruit\s+cocktail|mixed\s+fruit|cherries|apricots)\s+in\s+(heavy|light|extra\s+light)\s+syrup|dole.*syrup|del\s+monte.*(peaches|syrup|fruit\s+cup))\b/i,
    brand: "Del Monte",
    title: "Sliced Peaches in Heavy Syrup",
    ingredients: "Peaches, Water, High Fructose Corn Syrup, Corn Syrup, Sugar.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 74, sugarsG100g: 17.5, saturatedFatG100g: 0, sodiumMg100g: 6, fiberG100g: 1.2, proteinG100g: 0.4, fruitsVegNutsPct: 55, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.delmonte.com/products/fruits/peaches/sliced-yellow-cling-peaches-heavy-syrup",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(cake\s+roll|pumpkin\s+cake|swiss\s+roll|snack\s+cakes?|little\s+debbie|hostess|twinkies?|ding\s+dongs?|ho\s*hos?|zebra\s+cakes?|entenmann'?s|freshness\s+guaranteed.*(cake|pie|cupcake|brownie|cookie|muffin|roll)|bake\s+shop.*(cake|pie|cupcake|brownie|cookie|muffin))\b/i,
    brand: "Representative Bakery Formulation",
    title: "Bakery Cake Roll with Creme Filling (Representative Formulation)",
    ingredients: "Sugar, Enriched Wheat Flour Bleached (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Eggs, Water, Pumpkin or Fruit Puree, High Fructose Corn Syrup, Soybean Oil, Palm Oil, Corn Syrup, Contains 2% or Less of: Modified Corn Starch, Mono- and Diglycerides, Polysorbate 60, Sodium Propionate (Preservative), Potassium Sorbate (Preservative), Sodium Acid Pyrophosphate, Soy Lecithin, Natural and Artificial Flavor, Spices, Yellow 5, Yellow 6, Red 40.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 375, sugarsG100g: 36, saturatedFatG100g: 7.5, sodiumMg100g: 330, fiberG100g: 1.0, proteinG100g: 3.8, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/175021/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(cherry\s+garcia)\b/i,
    brand: "Ben & Jerry's",
    title: "Cherry Garcia Ice Cream",
    ingredients: "Cream, Skim Milk, Liquid Sugar (Sugar, Water), Water, Cherries, Sugar, Egg Yolks, Coconut Oil, Cocoa (Processed with Alkali), Fruit and Vegetable Concentrates (Color), Cocoa Powder, Guar Gum, Natural Flavors, Lemon Juice Concentrate, Carrageenan, Milk Fat, Soy Lecithin.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 256, sugarsG100g: 24.0, saturatedFatG100g: 10.0, sodiumMg100g: 60, fiberG100g: 0.9, proteinG100g: 4.1, fruitsVegNutsPct: 12, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.benjerry.com/flavors/cherry-garcia-ice-cream",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(haagen[- ]?dazs|häagen[- ]?dazs)\b/i,
    brand: "Häagen-Dazs",
    title: "Vanilla Dairy Ice Cream",
    ingredients: "Cream, Skim Milk, Cane Sugar, Egg Yolks, Vanilla Extract.",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 250, sugarsG100g: 21.0, saturatedFatG100g: 11.0, sodiumMg100g: 55, fiberG100g: 0, proteinG100g: 4.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.icecream.com/us/en/brands/haagen-dazs/products/vanilla-ice-cream",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(half[- ]?baked|tonight\s+dough|chunky\s+monkey|phish\s+food|americone\s+dream|ben\s*&\s*jerry'?s?)\b/i,
    brand: "Ben & Jerry's",
    title: "Half Baked Ice Cream",
    ingredients: "Cream, Skim Milk, Liquid Sugar (Sugar, Water), Water, Sugar, Wheat Flour, Brown Sugar, Egg Yolks, Butter, Soybean Oil, Coconut Oil, Cocoa (Processed with Alkali), Eggs, Guar Gum, Salt, Vanilla Extract, Carrageenan, Soy Lecithin, Natural Flavor.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 270, sugarsG100g: 25, saturatedFatG100g: 10.5, sodiumMg100g: 85, fiberG100g: 0.9, proteinG100g: 4.2, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.benjerry.com/flavors/half-baked-ice-cream",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(alec'?s|cosmic\s+bliss|organic\s+tahitian)\b).*\b(breyers|blue\s+bell|talenti|edy'?s|dreyer'?s|klondike|drumstick|sundae\s+shoppe|belmont.*ice\s+cream|great\s+value.*ice\s+cream|ice\s+cream|gelato)\b/i,
    brand: "Representative Dairy Ice Cream Formulation",
    title: "Dairy Ice Cream (Representative Formulation)",
    ingredients: "Cream, Skim Milk, Sugar, Corn Syrup, Egg Yolks, Guar Gum, Locust Bean Gum, Carrageenan, Natural Flavor, Annatto (Color).",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 235, sugarsG100g: 22, saturatedFatG100g: 9.5, sodiumMg100g: 65, fiberG100g: 0, proteinG100g: 3.8, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/167575/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(just\s+bare)\b.*\b(chicken|strips?|nuggets?|bites?|fillets?|tenders?|breast)\b/i,
    brand: "Just Bare",
    title: "Lightly Breaded Chicken Breast Strips",
    ingredients: "Boneless Skinless Chicken Breast with Rib Meat, Water, Wheat Flour, Contains 2% or Less of: Yellow Corn Flour, Sea Salt, Rice Starch, Spices, Dried Garlic, Dried Onion, Paprika, Yeast, Cream of Tartar, Sodium Bicarbonate.",
    imageUrl: "/swaps/turkey.jpg",
    nutrition: { caloriesKcal100g: 175, sugarsG100g: 1.0, saturatedFatG100g: 1.5, sodiumMg100g: 380, fiberG100g: 1.0, proteinG100g: 18.5, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.justbarefoods.com/product/lightly-breaded-chicken-breast-strips/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(butterball)\b.*\b(turkey|whole\s+turkey|young\s+turkey|breast)\b/i,
    brand: "Butterball",
    title: "All Natural Whole Turkey (With Salt Solution)",
    ingredients: "Turkey, Contains up to 8% of a Solution of Water, Salt, Spices, and Natural Flavor for Tenderness and Juiciness.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 160, sugarsG100g: 0, saturatedFatG100g: 3.5, sodiumMg100g: 310, fiberG100g: 0, proteinG100g: 19.0, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.butterball.com/products/whole-turkeys/all-natural-frozen-whole-turkey",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(golden\s+sweet.*corn|whole\s+kernel\s+corn|sweet\s+corn.*can|del\s+monte.*corn|green\s+giant.*corn|great\s+value.*corn|happy\s+harvest.*corn)\b/i,
    brand: "Canned Vegetables",
    title: "Golden Sweet Whole Kernel Corn",
    ingredients: "Corn, Water, Sugar, Salt.",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 71, sugarsG100g: 5.3, saturatedFatG100g: 0.2, sodiumMg100g: 230, fiberG100g: 1.8, proteinG100g: 2.4, fruitsVegNutsPct: 85, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://www.delmonte.com/products/vegetables/corn/golden-sweet-whole-kernel-corn",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(drink|cocktail|sunny\s*d|tang)\b).*\b(100%\s+(pure\s+)?(organic\s+)?(orange|apple|grape|cranberry|grapefruit)\s+juice|orange\s+juice|simply\s+orange|tropicana|uncle\s+matt'?s|nature'?s\s+nectar.*orange)\b/i,
    brand: "100% Fruit Juice",
    title: "100% Pasteurized Orange Juice",
    ingredients: "100% Pasteurized Orange Juice (Concentrated Natural Liquid Fruit Sugars — 0g Fiber).",
    imageUrl: "/swaps/drink.png",
    nutrition: { caloriesKcal100g: 45, sugarsG100g: 9.2, saturatedFatG100g: 0, sodiumMg100g: 2, fiberG100g: 0.2, proteinG100g: 0.7, fruitsVegNutsPct: 100, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/169098/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bsiete\b.*\b(chips?|crisps?|tostadas?|tortilla\s+chips)\b/i,
    brand: "Siete",
    title: "Grain-Free Sea Salt Tortilla Chips",
    ingredients: "Cassava Flour, Avocado Oil, Coconut Flour, Chia Seed, Sea Salt.",
    imageUrl: "/swaps/chips.jpg",
    nutrition: { caloriesKcal100g: 464, sugarsG100g: 0, saturatedFatG100g: 3.5, sodiumMg100g: 265, fiberG100g: 6.5, proteinG100g: 3.6, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://sietefoods.com/products/sea-salt-grain-free-tortilla-chips",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bsiete\b.*\b(tortillas?|wraps?)\b/i,
    brand: "Siete",
    title: "Almond Flour Tortillas",
    ingredients: "Almond Flour, Tapioca Flour, Water, Xanthan Gum, Sea Salt.",
    imageUrl: "/swaps/bread.jpg",
    nutrition: { caloriesKcal100g: 290, sugarsG100g: 2.0, saturatedFatG100g: 1.5, sodiumMg100g: 330, fiberG100g: 5.0, proteinG100g: 9.0, fruitsVegNutsPct: 45, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://sietefoods.com/products/almond-flour-tortillas",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(simple\s+mills.*crackers)\b/i,
    brand: "Simple Mills",
    title: "Almond Flour Fine Ground Sea Salt Crackers",
    ingredients: "Nut and Seed Flour Blend (Almonds, Sunflower Seeds, Flax Seeds), Tapioca Starch, Cassava Flour, Organic Sunflower Oil, Sea Salt, Organic Onion, Organic Garlic, Rosemary Extract (For Freshness).",
    imageUrl: "/swaps/crackers.jpg",
    nutrition: { caloriesKcal100g: 500, sugarsG100g: 0, saturatedFatG100g: 3.3, sodiumMg100g: 600, fiberG100g: 6.7, proteinG100g: 10.0, fruitsVegNutsPct: 50, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.simplemills.com/Shop/Product/Almond-Flour-Crackers-Fine-Ground-Sea-Salt.aspx",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(mary'?s\s+gone.*crackers|mary'?s\s+gone)\b/i,
    brand: "Mary's Gone Crackers",
    title: "Organic Original Seed Crackers",
    ingredients: "Organic brown rice, organic quinoa, organic flax seeds, organic sesame seeds, organic tamari (water, organic soybeans, salt, organic vinegar), sea salt.",
    imageUrl: "/swaps/crackers.jpg",
    nutrition: { caloriesKcal100g: 150 / 0.3, sugarsG100g: 0, saturatedFatG100g: 0.5 / 0.3, sodiumMg100g: 180 / 0.3, fiberG100g: 3 / 0.3, proteinG100g: 4 / 0.3, isWholeFood: false, isOrganic: true },
    sourceUrl: "https://www.marysgonecrackers.com/products/marys-gone-crackers-original-crackers",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\b(crunchmaster|\d+-seed.*crackers|seed\s+crackers|multi[- ]?grain\s+crackers)\b/i,
    brand: "Crunchmaster",
    title: "6-Seed Multi-Grain Baked Crackers",
    ingredients: "Brown Rice Flour, Whole Grain Yellow Corn, Potato Starch, Safflower Oil, Oat Fiber, Cane Sugar, Sesame Seeds, Flax Seeds, Millet, Quinoa Seeds, Amaranth Seeds, Chia Seeds, Sea Salt, Tamari Soy Sauce Powder (Tamari Soy Sauce [Soybeans, Salt], Maltodextrin, Salt).",
    imageUrl: "/swaps/crackers.jpg",
    nutrition: { caloriesKcal100g: 465, sugarsG100g: 3.5, saturatedFatG100g: 1.8, sodiumMg100g: 450, fiberG100g: 7.0, proteinG100g: 7.0, fruitsVegNutsPct: 25, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://crunchmaster.com/product/multi-seed-original/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(crackers|saltines|graham\s+crackers|oyster\s+crackers|animal\s+crackers|snack\s+crackers|water\s+crackers|woven\s+wheats?)\b/i,
    brand: "Baked Crackers",
    title: "Enriched Baked Snack Crackers",
    ingredients: "Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Soybean and/or Canola Oil, Palm Oil, Sugar, Salt, Leavening (Calcium Phosphate, Baking Soda), Soy Lecithin, Natural Flavor.",
    imageUrl: "/products/crackers.jpg",
    nutrition: { caloriesKcal100g: 480, sugarsG100g: 6.5, saturatedFatG100g: 7.0, sodiumMg100g: 720, fiberG100g: 2.0, proteinG100g: 7.0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/175007/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(birds\s+eye|green\s+giant|steamfresh|frozen\s+vegetables?)\b.*\b(sauced|cheesy|cheese\s+sauce|alfredo|garlic\s+butter|butter\s+sauce|teriyaki|glaze|seasoned\s+asian)\b/i,
    brand: "Birds Eye",
    title: "Sauced Frozen Vegetables",
    ingredients: "Vegetables (Broccoli, Carrots, Corn), Water, Cheddar Cheese (Cultured Milk, Salt, Enzymes, Annatto), Modified Corn Starch, Skim Milk, Whey, Butter (Cream, Salt), Soybean Oil, Salt, Sodium Phosphate, Xanthan Gum, Natural Flavor, Annatto and Paprika Extract (Color).",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 85, sugarsG100g: 3.0, saturatedFatG100g: 2.5, sodiumMg100g: 340, fiberG100g: 2.0, proteinG100g: 3.5, fruitsVegNutsPct: 70, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://www.birdseye.com/sauced-seasoned/sauced/steamfresh-cheddar-broccoli",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(birds\s+eye|green\s+giant|steamfresh|asian\s+medley|stir[- ]?fry\s+vegetables?|california\s+blend|normandy\s+blend|mixed\s+vegetables?|frozen\s+vegetables?|peas\s+and\s+carrots|broccoli\s+florets)\b/i,
    brand: "Birds Eye Steamfresh",
    title: "Steamfresh Frozen Vegetables",
    ingredients: "100% Flash-Frozen Whole Vegetables: Broccoli, Carrots, Baby Cob Corn, Sugar Snap Peas.",
    imageUrl: "/swaps/ranch.jpg",
    nutrition: { caloriesKcal100g: 42, sugarsG100g: 3.5, saturatedFatG100g: 0.1, sodiumMg100g: 20, fiberG100g: 2.8, proteinG100g: 2.0, fruitsVegNutsPct: 100, nutriScoreGrade: "a", isWholeFood: true },
    sourceUrl: "https://www.birdseye.com/plain-vegetables/steamfresh-selects/mixed-vegetables",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(nathan'?s(?:\s+famous)?)\b.*\b(beef\s+franks?|franks?|hot\s+dogs?|frankfurters?)\b|\b(nathan'?s\s+famous)\b/i,
    brand: "Nathan's Famous",
    title: "Skinless Beef Franks",
    ingredients: "Beef, Water, Contains 2% or Less of Salt, Sorbitol, Sodium Lactate, Natural Flavorings, Sodium Phosphate, Hydrolyzed Corn Protein, Paprika, Sodium Diacetate, Sodium Erythorbate, Sodium Nitrite.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 295, sugarsG100g: 0, saturatedFatG100g: 10.5, sodiumMg100g: 860, fiberG100g: 0, proteinG100g: 12.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://nathansfranks.sfdbrands.com/en-us/products/hot-dogs/skinless-beef-franks-12-oz/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(hebrew\s+national)\b.*\b(beef\s+franks?|franks?|hot\s+dogs?|frankfurters?)\b|\b(hebrew\s+national)\b/i,
    brand: "Hebrew National",
    title: "All-Beef Kosher Franks",
    ingredients: "Beef, Water, Contains 2% or Less of: Salt, Spice, Potassium Lactate, Sodium Lactate, Garlic Powder, Paprika, Hydrolyzed Soy Protein, Sodium Diacetate, Sodium Erythorbate, Flavorings, Sodium Nitrite.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 305, sugarsG100g: 0, saturatedFatG100g: 11.5, sodiumMg100g: 910, fiberG100g: 0, proteinG100g: 12.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.hebrewnational.com/kosher-hot-dogs/beef-franks",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(ball\s+park|oscar\s+mayer.*(wieners?|franks?|hot\s+dogs?)|kirkland.*(franks?|hot\s+dogs?)|member'?s\s+mark.*(franks?|hot\s+dogs?)|beef\s+franks?|meat\s+franks?|turkey\s+franks?|hot\s+dogs?|frankfurters?)\b/i,
    brand: "Representative Beef Franks Formulation",
    title: "Beef Franks and Hot Dogs (Representative Formulation)",
    ingredients: "Beef, Water, Corn Syrup, Contains 2% or Less of: Salt, Potassium Lactate, Hydrolyzed Beef Stock, Sodium Phosphate, Flavorings, Sodium Diacetate, Sodium Erythorbate, Sodium Nitrite, Extractives of Paprika.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 315, sugarsG100g: 3.8, saturatedFatG100g: 11.5, sodiumMg100g: 980, fiberG100g: 0, proteinG100g: 11.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/174576/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(mccormick.*bac'?n|bac'?n\s+(bits|pieces)|bacon\s+bits|imitation\s+bacon)\b/i,
    brand: "McCormick",
    title: "Bac'n Pieces Bacon Flavored Bits",
    ingredients: "Textured Soy Flour, Canola Oil, Salt, Caramel Color, Maltodextrin, Natural and Artificial Flavor, Lactic Acid, Yeast Extract, Disodium Inosinate and Disodium Guanylate (Flavor Enhancers), Red 40.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 428, sugarsG100g: 0, saturatedFatG100g: 2.0, sodiumMg100g: 2280, fiberG100g: 14.0, proteinG100g: 42.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.mccormick.com/spices-and-flavors/other/bacn-pieces-bacon-flavored-bits",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(rotisserie\s+chicken|seasoned\s+rotisserie\s+chicken|member'?s\s+mark.*rotisserie|kirkland.*rotisserie)\b/i,
    brand: "Rotisserie Deli",
    title: "Seasoned Rotisserie Whole Chicken",
    ingredients: "Whole Chicken, Water, Salt, Sodium Phosphate, Sugar, Spices, Garlic Powder, Onion Powder, Natural Flavor.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 165, sugarsG100g: 0.5, saturatedFatG100g: 3.2, sodiumMg100g: 390, fiberG100g: 0, proteinG100g: 21.0, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/171481/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(gnocchi|potato\s+gnocchi|de\s+cecco.*gnocchi)\b/i,
    brand: "De Cecco",
    title: "Potato Gnocchi Pasta",
    ingredients: "Potato Puree (Water, Dehydrated Potato Flakes), Wheat Flour, Potato Starch, Rice Flour, Salt, Acidity Regulator (Lactic Acid), Preservative (Potassium Sorbate).",
    imageUrl: "/swaps/bread.jpg",
    nutrition: { caloriesKcal100g: 160, sugarsG100g: 1.0, saturatedFatG100g: 0.2, sodiumMg100g: 410, fiberG100g: 2.2, proteinG100g: 4.5, fruitsVegNutsPct: 65, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://www.dececco.com/us_us/product/gnocchi/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(hellmann'?s|best\s+foods)\b.*\b(olive\s+oil)\b.*\b(mayo|mayonnaise|dressing)\b|\b(hellmann'?s|best\s+foods)\b.*\b(mayo|mayonnaise)\b.*\b(olive\s+oil)\b/i,
    brand: "Hellmann's",
    title: "Mayonnaise Dressing with Olive Oil",
    ingredients: "Water, Olive Oil, Canola Oil, Soybean Oil, Modified Potato Starch, Eggs, Sugar, Salt, Vinegar, Lemon Juice, Sorbic Acid and Calcium Disodium EDTA (Used to Protect Quality), Natural Flavor, Vitamin E.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Hellmann's%20Mayonnaise%20Dressing%20with%20Olive%20Oil",
    nutrition: { caloriesKcal100g: 400, sugarsG100g: 0, saturatedFatG100g: 5.0, sodiumMg100g: 600, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 15, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.hellmanns.com/us/en/p/mayonnaise-dressing-with-olive-oil.html/00048001354531",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(kraft)\b.*\b(olive\s+oil)\b.*\b(mayo|mayonnaise)\b|\b(kraft)\b.*\b(mayo|mayonnaise)\b.*\b(olive\s+oil)\b/i,
    brand: "Kraft",
    title: "Mayo with Olive Oil Reduced Fat Mayonnaise",
    ingredients: "Water, Olive Oil, Soybean Oil, Vinegar, Modified Food Starch, Sugar, Maltodextrin, Eggs, Contains Less than 2% of Salt, Natural Flavor, Mustard Flour, Potassium Sorbate and Calcium Disodium EDTA (to Protect Flavor), Dried Onions, Dried Garlic, Beta Carotene (Color).",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Kraft%20Mayo%20with%20Olive%20Oil",
    nutrition: { caloriesKcal100g: 333, sugarsG100g: 6.7, saturatedFatG100g: 3.3, sodiumMg100g: 633, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 15, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.kraftheinz.com/kraft-mayo/products/00021000642236-mayo-with-olive-oil-reduced-fat-mayonnaise",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(primal\s+kitchen)\b.*\b(mayo|mayonnaise)\b/i,
    brand: "Primal Kitchen",
    title: "Real Mayonnaise Made with Avocado Oil",
    ingredients: "Avocado Oil, Organic Eggs, Organic Egg Yolks, Organic Vinegar, Sea Salt, Organic Rosemary Extract.",
    imageUrl: "/swaps/ranch.jpg",
    nutrition: { caloriesKcal100g: 140, sugarsG100g: 0.5, saturatedFatG100g: 1.5, sodiumMg100g: 160, fiberG100g: 1.0, proteinG100g: 3.5, fruitsVegNutsPct: 85, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://www.primalkitchen.com/products/avocado-oil-mayo",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(primal\s+kitchen)\b.*\b(ranch|dressing|vinaigrette)\b/i,
    brand: "Primal Kitchen",
    title: "Ranch Dressing & Marinade Made with Avocado Oil",
    ingredients: "Avocado Oil, Water, Organic Apple Cider Vinegar, Organic Distilled Vinegar, Organic Egg Yolks, Sea Salt, Organic Lemon Juice Concentrate, Organic Onion Powder, Organic Garlic Powder, Organic Dill, Organic Parsley, Organic Chives, Organic Black Pepper, Organic Rosemary Extract.",
    imageUrl: "/swaps/ranch.jpg",
    nutrition: { caloriesKcal100g: 140, sugarsG100g: 0.5, saturatedFatG100g: 1.5, sodiumMg100g: 160, fiberG100g: 1.0, proteinG100g: 3.5, fruitsVegNutsPct: 85, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://www.primalkitchen.com/products/ranch-dressing",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(chosen\s+foods)\b.*\b(mayo|mayonnaise)\b/i,
    brand: "Chosen Foods",
    title: "Classic Avocado Oil Mayonnaise",
    ingredients: "Avocado Oil, Filtered Water, Whole Eggs, Egg Yolks, Organic Distilled White Vinegar, Organic Mustard (Distilled Vinegar, Water, Organic Mustard Seed, Salt, Organic Spices), Salt, Organic Rosemary Extract.",
    imageUrl: "/swaps/ranch.jpg",
    nutrition: { caloriesKcal100g: 140, sugarsG100g: 0.5, saturatedFatG100g: 1.5, sodiumMg100g: 160, fiberG100g: 1.0, proteinG100g: 3.5, fruitsVegNutsPct: 85, nutriScoreGrade: "a", isWholeFood: false },
    sourceUrl: "https://chosenfoods.com/products/classic-avocado-oil-mayo",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(boulder\s+canyon)\b.*\b(avocado\s+oil)\b.*\b(chips?|crisps?)\b/i,
    brand: "Boulder Canyon",
    title: "Avocado Oil Classic Sea Salt Kettle Cooked Potato Chips",
    ingredients: "Potatoes, Avocado Oil, Sea Salt.",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 535, sugarsG100g: 0, saturatedFatG100g: 5.3, sodiumMg100g: 392, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 80, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.utzsnacks.com/products/boulder-canyon-kettle-cooked-potato-chips-avocado-oil-classic-sea-salt",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(mayo|mayonnaise|dressing|ranch|vinaigrette|aioli|chips?|crisps?|crackers?|popcorn|pretzels?|tortillas?|bread|pasta|sauce|marinara|pesto|hummus|tuna|sardines?|salmon|olives?|spread|butter|margarine|cookies?|cereal|granola|bars?)\b).*\b(chosen\s+foods.*avocado\s+oil|100%\s*(?:pure\s+)?avocado\s+oil|avocado\s+oil)\b/i,
    brand: "Chosen Foods",
    title: "100% Pure Avocado Oil",
    ingredients: "100% Pure Avocado Oil (Expeller-Pressed Single-Ingredient Fruit Oil).",
    imageUrl: "/swaps/ranch.jpg",
    nutrition: { caloriesKcal100g: 884, sugarsG100g: 0, saturatedFatG100g: 14.0, sodiumMg100g: 0, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 100, nutriScoreGrade: "b", isWholeFood: true },
    sourceUrl: "https://chosenfoods.com/products/100-pure-avocado-oil",
    verifiedAt: "2026-11-08",
  },
  {
    match: /^(?!.*\b(mayo|mayonnaise|dressing|ranch|vinaigrette|aioli|chips?|crisps?|crackers?|popcorn|pretzels?|tortillas?|bread|pasta|sauce|marinara|pesto|hummus|tuna|sardines?|salmon|olives?|spread|butter|margarine|cookies?|cereal|granola|bars?)\b).*\b(extra\s+virgin\s+olive\s+oil|olive\s+oil|pompeian|bertolli.*olive\s+oil|california\s+olive\s+ranch)\b/i,
    brand: "Pompeian",
    title: "100% Extra Virgin Olive Oil",
    ingredients: "100% Extra Virgin Olive Oil (Cold-Pressed Single-Ingredient Fruit Oil).",
    imageUrl: "/swaps/ranch.jpg",
    nutrition: { caloriesKcal100g: 884, sugarsG100g: 0, saturatedFatG100g: 14.0, sodiumMg100g: 0, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 100, nutriScoreGrade: "b", isWholeFood: true },
    sourceUrl: "https://www.pompeian.com/product/smooth-extra-virgin-olive-oil/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(eggo|kellogg'?s\s+eggo)\b/i,
    brand: "Kellogg's Eggo",
    title: "Eggo Homestyle Waffles",
    ingredients: "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1 [Thiamin Mononitrate], Vitamin B2 [Riboflavin], Folic Acid), Water, Vegetable Oil (Soybean, Palm, Canola, and/or Cottonseed), Sugar, Leavening (Baking Soda, Sodium Aluminum Phosphate, Monocalcium Phosphate), Contains 2% or Less of Salt, Dextrose, Spice, Whey, Eggs, Soy Lecithin, Beta-Carotene for Color, Calcium Carbonate, Iron, Vitamin A Palmitate, Vitamin B6, Vitamin B12.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Kellogg's%20Eggo%20Homestyle%20Waffles",
    nutrition: { caloriesKcal100g: 271, sugarsG100g: 5.7, saturatedFatG100g: 2.1, sodiumMg100g: 514, fiberG100g: 1.4, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.eggo.com/en_US/products/waffles/kellogg-s-eggo-homestyle-waffles-product.html",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(homestyle\s+waffles?|buttermilk\s+waffles?|blueberry\s+waffles?|thick\s*&\s*fluffy\s+waffles?)\b/i,
    brand: "Representative Frozen Waffle Formulation",
    title: "Frozen Waffles (Representative Formulation)",
    ingredients: "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Vegetable Oil (Soybean and/or Canola), Sugar, Leavening (Baking Soda, Sodium Aluminum Phosphate, Monocalcium Phosphate), Salt, Whey, Eggs, Soy Lecithin.",
    imageUrl: "/products/bread.jpg",
    nutrition: { caloriesKcal100g: 271, sugarsG100g: 5.7, saturatedFatG100g: 2.1, sodiumMg100g: 514, fiberG100g: 1.4, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/175040/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(crumbled\s+bacon|real\s+bacon\s+(?:bits|pieces|crumbles)|member'?s\s+mark.*bacon|kirkland.*crumbled\s+bacon|hormel.*real\s+bacon)\b/i,
    brand: "Representative Cured Bacon Formulation",
    title: "100% Real Crumbled Bacon (Representative Formulation)",
    ingredients: "Bacon (Cured with Water, Salt, Sugar, Smoke Flavoring, Sodium Phosphate, Sodium Erythorbate, Sodium Nitrite).",
    imageUrl: "https://www.heybroc.com/api/product-image?q=100%25%20Real%20Crumbled%20Bacon",
    nutrition: { caloriesKcal100g: 428, sugarsG100g: 0, saturatedFatG100g: 12.5, sodiumMg100g: 1570, fiberG100g: 0, proteinG100g: 42.8, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.hormel.com/brands/hormel-real-bacon-toppings/product/real-crumbled-bacon/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(member'?s\s+mark.*(?:usda\s+choice|angus\s+beef)|usda\s+choice\s+angus\s+beef)\b/i,
    brand: "Member's Mark",
    title: "Member's Mark USDA Choice Angus Beef Roast",
    ingredients: "100% USDA Choice Angus Beef.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Member's%20Mark%20USDA%20Choice%20Angus%20Beef%20Roast",
    nutrition: { caloriesKcal100g: 185, sugarsG100g: 0, saturatedFatG100g: 3.5, sodiumMg100g: 65, fiberG100g: 0, proteinG100g: 22.5, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: true },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/174032/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(purina.*dog\s+chow|dog\s+chow\s+complete)\b/i,
    brand: "Purina",
    title: "Purina Dog Chow Complete Adult Dry Dog Food",
    ingredients: "Whole Grain Corn, Meat and Bone Meal, Corn Gluten Meal, Beef Fat Preserved with Mixed-Tocopherols, Soybean Meal, Poultry By-Product Meal, Egg and Chicken Flavor, Whole Grain Wheat, Animal Digest, Salt, Calcium Carbonate, Potassium Chloride, Mono and Dicalcium Phosphate, Choline Chloride, Minerals, Vitamins, Yellow 6, Yellow 5, Red 40, Blue 2, BHA (Preservative).",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Purina%20Dog%20Chow%20Complete%20Adult%20Dry%20Dog%20Food",
    nutrition: { caloriesKcal100g: 355, sugarsG100g: 2.0, saturatedFatG100g: 4.5, sodiumMg100g: 380, fiberG100g: 3.0, proteinG100g: 21.0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.purina.com/dogs/dog-food/dry/dog-chow-complete-adult",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(rxbar|rx\s+bar)\b/i,
    brand: "RXBAR",
    title: "Chocolate Sea Salt Whole Food Protein Bar",
    ingredients: "Dates, Egg Whites, Cashews, Almonds, Chocolate, Cocoa, Natural Flavors, Sea Salt.",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 404, sugarsG100g: 28.8, saturatedFatG100g: 3.8, sodiumMg100g: 500, fiberG100g: 9.6, proteinG100g: 23.1, fruitsVegNutsPct: 75, nutriScoreGrade: "a", isWholeFood: true },
    sourceUrl: "https://www.rxbar.com/en_US/shop/protein-bars/chocolate-sea-salt-box-of-12.html",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\b(larabar|lärabar)\b/i,
    brand: "LÄRABAR",
    title: "Fruit & Nut Whole Food Bar",
    ingredients: "Dates, Peanuts, Unsweetened Chocolate, Sea Salt.",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 444, sugarsG100g: 35.5, saturatedFatG100g: 6.5, sodiumMg100g: 140, fiberG100g: 8.9, proteinG100g: 11.1, fruitsVegNutsPct: 90, nutriScoreGrade: "b", isWholeFood: true },
    sourceUrl: "https://www.larabar.com/our-products/larabar/peanut-butter-chocolate-chip",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(bonne\s+maman)\b/i,
    brand: "Bonne Maman",
    title: "Fruit Preserves",
    ingredients: "Strawberries, Sugar, Cane Sugar, Concentrated Lemon Juice, Fruit Pectin.",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 250, sugarsG100g: 60.0, saturatedFatG100g: 0, sodiumMg100g: 0, fiberG100g: 1.0, proteinG100g: 0.4, fruitsVegNutsPct: 50, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://bonnemaman.us/products/strawberry-preserves-13-oz",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(wholly\s+guacamole|guacamole)\b/i,
    brand: "Wholly Guacamole",
    title: "Classic Hass Avocado Guacamole",
    ingredients: "Hass Avocados, Distilled Vinegar, Jalapeño Pepper, Sea Salt, Dehydrated Onion, Granulated Garlic.",
    imageUrl: "/swaps/ranch.jpg",
    nutrition: { caloriesKcal100g: 175, sugarsG100g: 1.0, saturatedFatG100g: 2.5, sodiumMg100g: 370, fiberG100g: 6.5, proteinG100g: 2.0, fruitsVegNutsPct: 95, nutriScoreGrade: "a", isWholeFood: true },
    sourceUrl: "https://www.eatwholly.com/products/wholly-guacamole/classic-guacamole/",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(claussen|grillo'?s\s+pickles)\b/i,
    brand: "Claussen",
    title: "Refrigerated Kosher Dill Pickles",
    ingredients: "Fresh Cucumbers, Water, Salt, Distilled Vinegar, Fresh Garlic, Fresh Dill, Spices, Mustard Seed.",
    imageUrl: "/swaps/ranch.jpg",
    nutrition: { caloriesKcal100g: 18, sugarsG100g: 1.0, saturatedFatG100g: 0, sodiumMg100g: 750, fiberG100g: 1.2, proteinG100g: 0.5, fruitsVegNutsPct: 90, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.myfoodandfamily.com/brands/claussen/product/00044700019559",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(kalamata\s+olives?|castelvetrano\s+olives?|green\s+olives?|black\s+olives?|\bolives\b)\b/i,
    brand: "Mediterranean Olives",
    title: "Pitted Olives in Brine",
    ingredients: "Olives, Water, Sea Salt, Red Wine Vinegar, Extra Virgin Olive Oil.",
    imageUrl: "/swaps/ranch.jpg",
    nutrition: { caloriesKcal100g: 145, sugarsG100g: 0, saturatedFatG100g: 2.0, sodiumMg100g: 1150, fiberG100g: 3.2, proteinG100g: 1.0, fruitsVegNutsPct: 95, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/169094/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(ezekiel(?:\s+4:?9)?|food\s+for\s+life.*sprouted)\b/i,
    brand: "Food for Life Ezekiel 4:9",
    title: "Ezekiel 4:9 Sprouted Whole Grain Bread",
    ingredients: "Organic Sprouted Wheat, Filtered Water, Organic Sprouted Barley, Organic Sprouted Millet, Organic Malted Barley, Organic Sprouted Lentils, Organic Sprouted Soybeans, Organic Sprouted Spelt, Fresh Yeast, Organic Wheat Gluten, Sea Salt.",
    imageUrl: "/swaps/bread.jpg",
    nutrition: { caloriesKcal100g: 235, sugarsG100g: 0, saturatedFatG100g: 0, sodiumMg100g: 220, fiberG100g: 8.8, proteinG100g: 14.7, fruitsVegNutsPct: 15, nutriScoreGrade: "a", isWholeFood: false, isOrganic: true },
    sourceUrl: "https://www.foodforlife.com/product/breads/ezekiel-49-sprouted-whole-grain-bread",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(dave'?s\s+killer|sprouted\s+grain)\b.*\b(bread|bagels?|buns?|english\s+muffins?)\b/i,
    brand: "Dave's Killer Bread",
    title: "Organic 21 Whole Grains and Seeds Bread",
    ingredients: "Organic Whole Wheat (Organic Whole Wheat Flour, Organic Cracked Whole Wheat), Water, Organic Cane Sugar, Organic 21 Whole Grains and Seeds Mix (Organic Whole Flax Seeds, Organic Sunflower Seeds, Organic Ground Whole Flax Seeds, Organic Unhulled Brown Sesame Seeds, Organic Triticale, Organic Pumpkin Seeds, Organic Rolled Barley, Organic Rolled Oats, OrganicRye, Organic Unhulled Black Sesame Seeds, Organic Blue Cornmeal, Organic Millet, Organic Rolled Spelt, Organic Brown Rice Flour, Organic Amaranth Flour, Organic Yellow Cornmeal, Organic Kamut Khorasan Wheat, Organic Sorghum Flour, Organic Buckwheat Flour, Organic Quinoa, Organic Poppy Seeds), Organic Wheat Gluten, Organic Oat Fiber, Organic Molasses, Sea Salt, Organic Cultured Wheat Flour, Yeast, Organic Vinegar, Organic Acerola Cherry Powder, Enzymes.",
    imageUrl: "/swaps/bread.jpg",
    nutrition: { caloriesKcal100g: 244, sugarsG100g: 11.1, saturatedFatG100g: 0, sodiumMg100g: 378, fiberG100g: 11.1, proteinG100g: 11.1, fruitsVegNutsPct: 15, nutriScoreGrade: "a", isWholeFood: false, isOrganic: true },
    sourceUrl: "https://www.daveskillerbread.com/21-whole-grains-and-seeds",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\b(kind\s+(?:nut\s+)?bars?|kind\s+dark\s+chocolate\s+nuts)\b/i,
    brand: "KIND",
    title: "KIND Dark Chocolate Nuts & Sea Salt Bar",
    ingredients: "Almonds, Chicory Root Fiber, Honey, Palm Kernel Oil, Sugar, Glucose Syrup, Rice Flour, Unsweetened Chocolate, Alkalized Cocoa, Soy Lecithin, Sea Salt, Natural Flavor, Cocoa Butter.",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 450, sugarsG100g: 12.5, saturatedFatG100g: 7.5, sodiumMg100g: 310, fiberG100g: 17.5, proteinG100g: 15.0, fruitsVegNutsPct: 60, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://www.kindsnacks.com/products/dark-chocolate-nuts-sea-salt",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\binglehoffer\b.*\b(wasabi|horseradish)\b|\b(hot\s+creamy\s+wasabi\s+horseradish)\b/i,
    brand: "Inglehoffer",
    title: "Inglehoffer Hot Creamy Wasabi Horseradish Sauce",
    ingredients: "Soybean Oil, Water, Horseradish, High Fructose Corn Syrup, White Distilled Vinegar, Egg Yolks, Corn Syrup, Modified Food Starch, Contains Less than 2% of Wasabi Powder, Salt, Mustard Seed, Citric Acid, Mustard Bran, Spices, Xanthan Gum, Sodium Benzoate and Calcium Disodium EDTA (to Preserve Freshness), Artificial Flavor, Yellow 5, Blue 1.",
    imageUrl: "https://images.openfoodfacts.org/images/products/007/182/800/9124/front_en.11.400.jpg",
    nutrition: { caloriesKcal100g: 340, sugarsG100g: 12.0, saturatedFatG100g: 5.0, sodiumMg100g: 780, fiberG100g: 2.0, proteinG100g: 1.0, fruitsVegNutsPct: 20, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://world.openfoodfacts.org/product/0071828009124",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bbeaver(\s+brand)?\b.*\b(wasabi|horseradish)\b|\b(extra\s+hot\s+wasabi\s+horseradish)\b/i,
    brand: "Beaver Brand",
    title: "Beaver Brand Extra Hot Wasabi Horseradish Sauce",
    ingredients: "Grated Horseradish and Wasabi Roots, Water, White Distilled Vinegar, Soybean Oil, Mustard Seed, Sugar, High Fructose Corn Syrup, Eggs, Salt, Modified Food Starch, Xanthan Gum, Citric Acid, Sodium Benzoate, Calcium Disodium EDTA, Artificial Flavor, Yellow 5, Blue 1.",
    imageUrl: "https://images.openfoodfacts.org/images/products/007/182/800/3009/front_en.14.400.jpg",
    nutrition: { caloriesKcal100g: 200, sugarsG100g: 10.0, saturatedFatG100g: 2.5, sodiumMg100g: 920, fiberG100g: 3.0, proteinG100g: 1.5, fruitsVegNutsPct: 35, nutriScoreGrade: "c", isWholeFood: false },
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
    match: /\b(wasabi[- ]?o|s\s*&\s*b.*wasabi|real\s+wasabi\s+paste|authentic\s+japanese.*wasabi|wasabi\s+paste)\b/i,
    brand: "Wasabi-O",
    title: "Wasabi-O Real Prepared Wasabi Paste",
    ingredients: "Water, Wasabi Japonica, Horseradish, Rice Bran Oil, Salt, Sorbitol, Citric Acid, Xanthan Gum, Turmeric, Spirulina Extract.",
    imageUrl: "https://images.openfoodfacts.org/images/products/490/100/207/5484/front_en.101.400.jpg",
    nutrition: { caloriesKcal100g: 240, sugarsG100g: 8.0, saturatedFatG100g: 1.5, sodiumMg100g: 1850, fiberG100g: 4.0, proteinG100g: 2.0, fruitsVegNutsPct: 45, nutriScoreGrade: "c", isWholeFood: false },
    sourceUrl: "https://world.openfoodfacts.org/product/4901002075484",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bwicked\s+cutz\b.*\b(bacon|jerky)\b/i,
    brand: "Wicked Cutz",
    title: "Wicked Cutz Thick Cut Bacon Jerky",
    ingredients: "Pork, Water, Brown Sugar, Sugar, Salt, Maple Syrup, Vinegar, Celery Powder, Sea Salt, Natural Smoke Flavor.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 390, sugarsG100g: 14.0, saturatedFatG100g: 8.5, sodiumMg100g: 1250, fiberG100g: 0, proteinG100g: 35.0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://wickedcutz.com/products/maple-bacon-jerky",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\bfreshness\s+guaranteed\b.*\bglazed\s+donuts?\b|\bglazed\s+donuts?,?\s*12\s*oz\b/i,
    brand: "Freshness Guaranteed",
    title: "Freshness Guaranteed Glazed Donuts",
    ingredients: "Enriched Wheat Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Sugar, Palm Oil, Soybean Oil, Dextrose, Yeast, Soy Flour, Salt, Mono- and Diglycerides, Sodium Stearoyl Lactylate, Calcium Propionate (to Preserve Freshness), Artificial Flavor, Yellow 5, Yellow 6.",
    imageUrl: "https://images.openfoodfacts.org/images/products/077/185/646/5793/front_en.33.400.jpg",
    nutrition: { caloriesKcal100g: 410, sugarsG100g: 24.5, saturatedFatG100g: 9.8, sodiumMg100g: 340, fiberG100g: 1.5, proteinG100g: 4.8, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.walmart.com/ip/Freshness-Guaranteed-Glazed-Donuts-12-oz-6-Count/425027592",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\bfreshness\s+guaranteed\b.*\bregular\s+raspberry\s+bism[a-z']*/i,
    brand: "Freshness Guaranteed",
    title: "Freshness Guaranteed Regular Raspberry Bismark",
    ingredients: "Enriched Wheat Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Raspberry Filling (High Fructose Corn Syrup, Water, Raspberries, Sugar, Modified Food Starch, Citric Acid, Sodium Benzoate, Potassium Sorbate, Red 40, Blue 1, Artificial Flavor), Palm Oil, Soybean Oil, Sugar, Dextrose, Yeast, Mono- and Diglycerides, Salt.",
    imageUrl: "https://images.openfoodfacts.org/images/products/029/961/630/1971/front_en.5.400.jpg",
    nutrition: { caloriesKcal100g: 350, sugarsG100g: 26.0, saturatedFatG100g: 7.5, sodiumMg100g: 310, fiberG100g: 1.5, proteinG100g: 4.5, fruitsVegNutsPct: 5, nutriScoreGrade: "e", isWholeFood: false },
    sourceUrl: "https://www.walmart.com/ip/Freshness-Guaranteed-Regular-Raspberry-Bismark-Donuts-4-Count-11-oz/133163700",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\bfreshness\s+guaranteed\b.*\braspberry\s+filled\s+bism[a-z']*/i,
    brand: "Freshness Guaranteed",
    title: "Freshness Guaranteed Raspberry Filled Bismark",
    ingredients: "Enriched Wheat Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Raspberry Filling (High Fructose Corn Syrup, Water, Raspberries, Sugar, Modified Food Starch, Citric Acid, Sodium Benzoate, Potassium Sorbate, Red 40, Blue 1, Artificial Flavor), Palm Oil, Soybean Oil, Sugar, Dextrose, Yeast, Mono- and Diglycerides, Salt.",
    imageUrl: "https://images.openfoodfacts.org/images/products/029/961/630/1971/front_en.5.400.jpg",
    nutrition: { caloriesKcal100g: 350, sugarsG100g: 26.0, saturatedFatG100g: 7.5, sodiumMg100g: 310, fiberG100g: 1.5, proteinG100g: 4.5, fruitsVegNutsPct: 5, nutriScoreGrade: "e", isWholeFood: false },
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
    imageUrl: "https://images.openfoodfacts.org/images/products/003/800/031/6104/front.9.400.jpg",
    nutrition: { caloriesKcal100g: 325, sugarsG100g: 11.0, saturatedFatG100g: 7.0, sodiumMg100g: 360, fiberG100g: 5.5, proteinG100g: 18.0, fruitsVegNutsPct: 5, nutriScoreGrade: "d", isWholeFood: false },
    sourceUrl: "https://www.walmart.com/ip/My-Cookie-Dealer-Protein-Toaster-Pastry-Powdered-Strawberry-3-88-oz/5470560138",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\b(marketside\s+butcher|organic\s+grass[- ]?fed)\b.*\bground\s+beef\b|\bground\s+beef\b.*\b(organic\s+grass[- ]?fed|marketside\s+butcher)\b/i,
    brand: "Marketside Butcher",
    title: "Marketside Butcher Organic Grass-Fed 93% Lean 7% Fat Ground Beef",
    ingredients: "100% Organic Grass-Fed Beef.",
    imageUrl: "https://images.openfoodfacts.org/images/products/068/113/117/9232/front_en.10.400.jpg",
    nutrition: { caloriesKcal100g: 152, sugarsG100g: 0, saturatedFatG100g: 2.9, sodiumMg100g: 66, fiberG100g: 0, proteinG100g: 20.8, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: true, isOrganic: true },
    sourceUrl: "https://www.walmart.com/ip/Marketside-Butcher-Organic-Grass-Fed-93-Lean-7-Fat-Ground-Beef-1-lb-Tray-Fresh-All-Natural/44391005",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\bstonyfield\b.*\b(whole\s+milk\s+plain|plain.*yogurt)\b/i,
    brand: "Stonyfield Organic",
    title: "Stonyfield Organic Whole Milk Plain Yogurt",
    ingredients: "Cultured Pasteurized Organic Whole Milk, Pectin, Vitamin D3. Live and Active Cultures: S. thermophilus, L. bulgaricus, L. acidophilus, Bifidus, L. paracasei, and L. rhamnosus.",
    imageUrl: "https://images.openfoodfacts.org/images/products/005/215/900/1308/front_en.35.400.jpg",
    nutrition: { caloriesKcal100g: 65, sugarsG100g: 4.1, saturatedFatG100g: 2.1, sodiumMg100g: 47, fiberG100g: 0, proteinG100g: 3.5, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: true, isOrganic: true },
    sourceUrl: "https://www.stonyfield.com/products/whole-milk-plain-32oz/",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\borganic\s+valley\b.*\b(sharp\s+cheddar|cheddar\s+cheese|raw\s+sharp\s+cheddar)\b/i,
    brand: "Organic Valley",
    title: "Organic Valley Organic Raw Sharp Cheddar Cheese",
    ingredients: "Organic Unpasteurized Cultured Milk, Salt, Vegetarianal Enzymes.",
    imageUrl: "https://images.openfoodfacts.org/images/products/009/396/600/0337/front_en.28.400.jpg",
    nutrition: { caloriesKcal100g: 393, sugarsG100g: 0, saturatedFatG100g: 21.4, sodiumMg100g: 643, fiberG100g: 0, proteinG100g: 25.0, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: true, isOrganic: true },
    sourceUrl: "https://www.organicvalley.coop/products/cheese/cheddar/raw-sharp-cheddar-cheese-8-oz/",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\bapplegate\b.*\b(oven\s+roasted\s+turkey|turkey\s+breast)\b/i,
    brand: "Applegate Organics",
    title: "Applegate Organics Oven Roasted Turkey Breast",
    ingredients: "Organic Turkey Breast, Water. Contains Less Than 2% Of The Following: Salt, Organic Potato Starch, Organic Rosemary Extract.",
    imageUrl: "https://images.openfoodfacts.org/images/products/002/531/700/1106/front_en.48.400.jpg",
    nutrition: { caloriesKcal100g: 89, sugarsG100g: 0, saturatedFatG100g: 0, sodiumMg100g: 607, fiberG100g: 0, proteinG100g: 19.6, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: true, isOrganic: true },
    sourceUrl: "https://applegate.com/products/applegate-organics-oven-roasted-turkey-breast",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\blotus\s+foods\b.*\b(millet\s*(?:&|and)\s*brown\s+rice|ramen)\b/i,
    brand: "Lotus Foods",
    title: "Lotus Foods Organic Millet & Brown Rice Ramen",
    ingredients: "Organic Brown Rice Flour, Organic Millet Flour.",
    imageUrl: "https://images.openfoodfacts.org/images/products/007/067/000/3322/front_en.41.400.jpg",
    nutrition: { caloriesKcal100g: 371, sugarsG100g: 0, saturatedFatG100g: 0.7, sodiumMg100g: 0, fiberG100g: 4.3, proteinG100g: 8.6, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: true, isOrganic: true },
    sourceUrl: "https://www.lotusfoods.com/products/organic-millet-brown-rice-ramen-4-pack",
    verifiedAt: "2026-11-09",
  },
  {
    match: /\brao'?s\b.*\b(marinara|tomato\s+basil|arrabbiata|vodka\s+sauce|pasta\s+sauce)\b/i,
    brand: "Rao's Homemade",
    title: "Rao's Homemade Marinara Sauce",
    ingredients: "Italian Whole Peeled Tomatoes, Olive Oil, Onions, Salt, Garlic, Basil, Black Pepper, Oregano.",
    imageUrl: "https://images.openfoodfacts.org/images/products/074/747/900/0017/front_en.77.400.jpg",
    nutrition: { caloriesKcal100g: 80, sugarsG100g: 3.2, saturatedFatG100g: 0.8, sodiumMg100g: 336, fiberG100g: 1.6, proteinG100g: 1.6, fruitsVegNutsPct: 90, nutriScoreGrade: "a", isWholeFood: true, isOrganic: false },
    sourceUrl: "https://www.raos.com/products/marinara-sauce",
    verifiedAt: "2026-11-09",
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
];

const UI_NOISE_QUERY =
  /\b(bought \d+\+?\s*times?|purchased \d+\+?\s*times?|stay stocked|last purchased|price may vary|max \d+ per order|final cost by weight|instant savings|really philly good|straight talk|google pixel|pixel \d+a?|tracfone|boost mobile|cricket wireless|total wireless|gas savings|walmart\+|walmart cash|manufacturer offer|subscribe to save|new notification|scan barcodes?|barcode scanner|opens barcode scanner|qr code|pickup or delivery|pickup and delivery|your favorites, for less|rollbacks & more|the holiday shop|shop all food|thanksgiving\s+meal|feast\s+for\s+\d+|classic\s+sides|meals?\s+made\s+easy|get\s+it\s+fast|household\s+essentials|grocery\s+list\s+staples|weekly\s+essentials|under\s+\$?\d+\s+per\s+person|shop\s+the\s+list|sparky|my items|product information|items to add next|frequently bought together|customers also viewed|similar items|sold by|fulfilled by|sold and shipped by|arrives between|arrives by|free \d+-day returns|free holiday returns|gift eligible|available for \d+ of \d+ items|fees may apply|snap ebt eligible|pro seller|preferred address|change delivery address|change address|usual items in stock|out of stock|replace with best match|add note for shopper|item instructions|visit the store|freshness guarantee|see customer images|from the manufacturer|excellent source of|good source of|hear the highlights|copy associates link|ways to buy|price history|\d+\s*[-–—]\s*\d+\s*min|\d+\s*(?:hr|hour|min)s?\s+or\s+less|\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)|free with w\+)\b|&\s*more\.?$|^(?:(?:flavor|flavor\s+name|size|style|color|colour|scent|count|pack|pack\s+size|variant|option|type|model|pattern|weight|material)\s*:\s*.+|cart\s*,?\s*\(\d+(?:\s+items?)?\)|in\s+\d+[kKmM]?\+?\s*people'?s?\s*c(?:arts?|a.*)|\d+[kKmM]?\+?\s*bought\b.*|options(?:\s+from\s+.*)?|.*\bsam'?s\s+club|\d+\s+[a-z]{2,}(?:\s+[a-z]{2,}){0,2}\s+(?:street|rd|road|drive|ave|avenue|blvd|boulevard|lane|court|place|circle|pkwy|parkway|hwy|highway)\b.*|.*,\s*was|.*\?)$/i;

const NON_FOOD_GUARD =
  /\b(sunscreen|banana\s+boat|coppertone|neutrogena|lotion|spf|lip\s+balm|shampoo|conditioner|body\s+wash|face\s+wash|soap|detergent|cleaner|bleach|wipes?|candle|deodorant|toothpaste|mouthwash|diapers?|litter|pet\s+food|dog\s+food|cat\s+food|toilet\s+paper|paper\s+towels?|bath\s+tissue|facial\s+tissue|disposable\s+(?:forks?|spoons?|knives|cutlery|utensils?|plates?|cups?|bowls?)|plastic\s+(?:forks?|spoons?|knives|cutlery|utensils?|plates?|cups?|bowls?|straws?)|paper\s+(?:plates?|bowls?|cups?|napkins?)|trash\s+bags?|garbage\s+bags?|aluminum\s+foil|plastic\s+wrap|parchment\s+paper|wax\s+paper|storage\s+bags?|freezer\s+bags?|sandwich\s+bags?|topcare|pain\s*&\s*fever|oral\s+suspension|acetaminophen|ibuprofen|tylenol|advil|motrin|benadryl|mucinex|nyquil|dayquil|robitussin|pepto|tums|laxative|antacid|cough\s+syrup|nasal\s+spray|eye\s+drops)\b/i;

const PROCESSED_FOOD_GUARD =
  /\b(chips?|crisps?|crispy|fried|battered|breaded|rings?|instant|mashed|flakes?|au\s+gratin|scalloped|casserole|flavou?red|dressing|ranch|caesar|mayo|mayonnaise|aioli|vinaigrette|marinade|kit|soup|chowder|sauce|a\.?1\.?|steak[- ]?umm\w*|ketchup|salsa|pie|cake|roll|muffin|donuts?|doughnuts?|bismarks?|bismark|pastries|pastry|danish|fritters?|eclairs?|strudels?|turnovers?|toaster|candy|candied|gummies|juice|drink|soda|yogurt|cereal|puffs?|bars?|cookies?|wafers?|dried|dehydrated|craisins|fries|tots|ore[- ]?ida|idahoan|hash\s*browns?|macaroni|pasta\s+salad|potato\s+salad|chicken\s+salad|tuna\s+salad|egg\s+salad|ice\s+cream|gelato|sorbet|popsicle|jam|jelly|spread|syrup|canned|fruit\s+cup|del\s+monte|dole|pickled|marinated|seasoned|grilled|roasted|smoked|cured|jerky|bacon|sausage|hot\s*dog|franks?|frankfurters?|salami|pepperoni|bologna|deli|lunch|ham|nuggets?|tenders?|strips?|patties|patty|popcorn|teriyaki|bbq|barbecue|buffalo|honey|glazed|sandwich|biscuit|croissant|burrito|pizza|ramen|helper|eggnog|egg\s+nog|egg\s+roll|noodles?)\b/i;

const NAMED_BRAND_GUARD =
  /\b(silk|pedialyte|oscar\s+mayer|tyson|applegate|boar'?s\s+head|hormel|perdue|foster\s+farms|barilla|rao'?s|wonder|pepperidge|arnold|orowheat|chobani|fage|tillamook|sargento|philadelphia|haagen[- ]?dazs|häagen[- ]?dazs|ben\s*&\s*jerry|ore[- ]?ida|mccain|alexia|hunt'?s|muir\s+glen|bush'?s|goya|tostitos|pace|herdez|sabra|land\s+o'?\s*lakes|kerrygold|country\s+crock|blue\s+bonnet|hellmann'?s|best\s+foods|duke'?s|french'?s|grey\s+poupon|kikkoman|tabasco|cholula|frank'?s|pillsbury|betty\s+crocker|duncan\s+hines|kodiak|krusteaz|bisquick|aunt\s+jemima|pearl\s+milling|log\s+cabin|mrs\.?\s*butterworth|skippy|jif|peter\s+pan|welch'?s|bonne\s+maman|nissin|nongshim|buldak|samyang|progresso|totino'?s|red\s+baron|tombstone|banquet|healthy\s+choice|lean\s+cuisine|marie\s+callender|breyers|talenti|jennie[- ]?o|hillshire|jimmy\s+dean|smithfield|wright|farmland|nathan'?s|hebrew\s+national|ball\s+park|stouffer'?s|amy'?s|halo\s+top|yasso|clif\s+bar|quest|nature\s+valley|quaker|belvita|thomas'?|canyon\s+bakehouse|udi'?s|sara\s+lee|nature'?s\s+own|king'?s\s+hawaiian|mission|eggo|smucker'?s|heinz|sweet\s+baby\s+ray'?s|stubb'?s|miracle\s+whip|wish[- ]?bone|ken'?s|briannas|marzetti|prego|ragu|classico|bertolli|newman'?s\s+own|mateo'?s|tapatio|valentina|oikos|siggi'?s|dannon|activia|stonyfield|kraft|babybel|laughing\s+cow|chips\s+ahoy|nutter\s+butter|keebler|fig\s+newtons?|haribo|sour\s+patch|skittles|starburst|swedish\s+fish|mott'?s|outshine|digiorno|vlasic|mt\.?\s*olive|lay'?s|ruffles|pringles|fritos|utza?|herr'?s|cape\s+cod|smartfood|skinny\s*pop)\b/i;

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
    nutrition: { caloriesKcal100g: 55, sugarsG100g: 4.5, saturatedFatG100g: 0.4, sodiumMg100g: 360, fiberG100g: 1.8, proteinG100g: 1.5, fruitsVegNutsPct: 85, nutriScoreGrade: "b", isWholeFood: false },
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
    nutrition: { caloriesKcal100g: 270, sugarsG100g: 53.0, saturatedFatG100g: 0, sodiumMg100g: 165, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
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
    nutrition: { caloriesKcal100g: 717, sugarsG100g: 0.1, saturatedFatG100g: 51.0, sodiumMg100g: 640, fiberG100g: 0, proteinG100g: 0.9, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
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
    nutrition: { caloriesKcal100g: 380, sugarsG100g: 1.0, saturatedFatG100g: 18.5, sodiumMg100g: 620, fiberG100g: 0, proteinG100g: 23.0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
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
    nutrition: { caloriesKcal100g: 210, sugarsG100g: 1.5, saturatedFatG100g: 2.2, sodiumMg100g: 410, fiberG100g: 5.0, proteinG100g: 6.5, fruitsVegNutsPct: 70, nutriScoreGrade: "b", isWholeFood: false },
    sourceUrl: "https://fdc.nal.usda.gov/food-details/174289/nutrients",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(baked\s+beans|refried\s+beans)\b/i,
    brand: "Pantry Beans",
    ingredients: "Prepared Beans, Water, Brown Sugar, Sugar, Salt, Mustard, Modified Corn Starch, Onion Powder, Caramel Color, Spice, Garlic Powder.",
    nutrition: { caloriesKcal100g: 115, sugarsG100g: 9.2, saturatedFatG100g: 0.3, sodiumMg100g: 420, fiberG100g: 5.0, proteinG100g: 5.5, fruitsVegNutsPct: 75, nutriScoreGrade: "b", isWholeFood: false },
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
function isDietaryOrVariantMismatch(
  query: string,
  entryTitle: string,
  entryIngredients: string,
  entryNutrition?: NutritionInput
): boolean {
  const q = query.toLowerCase();
  const t = entryTitle.toLowerCase();
  const ing = entryIngredients.toLowerCase();

  // 1. Gluten-free / grain-free query vs gluten-containing ingredients
  if (
    /\b(gluten[\s-]*free|grain[\s-]*free|celiac)\b/.test(q) &&
    !/\b(gluten[\s-]*free|grain[\s-]*free)\b/.test(t) &&
    /\b(wheat|barley|rye|malt|triticale|spelt|graham\s+flour|enriched\s+flour)\b/.test(ing)
  ) {
    return true;
  }

  // 2. Dairy-free / plant-based / vegan query vs dairy or animal ingredients
  if (
    /\b(dairy[\s-]*free|non[\s-]*dairy|plant[\s-]*based|vegan)\b/.test(q) &&
    !/\b(dairy[\s-]*free|non[\s-]*dairy|plant[\s-]*based|vegan)\b/.test(t) &&
    /\b(milk|cream|whey|casein|butter|cheese|yogurt|lactose|egg|beef|pork|chicken|turkey|fish|anchov\w*|gelatin)\b/.test(
      ing
    )
  ) {
    return true;
  }

  // 3. Zero-sugar / sugar-free / unsweetened / diet query vs caloric sugars
  if (
    /\b(zero\s+sugar|sugar[\s-]*free|sugarfree|no\s+sugar|unsweetened|\bdiet\b)\b/.test(q) &&
    !/\b(zero|sugar[\s-]*free|sugarfree|no\s+sugar|unsweetened|\bdiet\b)\b/.test(t)
  ) {
    if (
      (entryNutrition?.sugarsG100g ?? 0) > 0.5 ||
      /\b(sugar|cane\s+sugar|sucrose|glucose|fructose|corn\s+syrup|high\s+fructose\s+corn\s+syrup|dextrose|maltose|honey|maple\s+syrup|molasses|agave)\b/.test(
        ing
      )
    ) {
      return true;
    }
  }

  // 4. Tree-nut / seed butter query vs peanut ingredients
  if (
    /\b(almond|cashew|sunflower|walnut|pecan|hazelnut)\s+butter\b/.test(q) &&
    /\bpeanut\b/.test(ing)
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
  if (
    /\b(light(?!\s+(?:roast|tuna|brown|corn|cream|amber|red|pink|salted|breaded))|lite|reduced[\s-]*fat\s+ice\s+cream|vegan|plant[\s-]*based)\b/.test(t) &&
    !/\b(light|lite|reduced[\s-]*fat|low[\s-]*fat|fat[\s-]*free|non[\s-]*fat|skim|vegan|plant[\s-]*based)\b/.test(q)
  ) {
    return true;
  }

  // 7. Plain whole-produce or plain fresh meat/seafood query vs processed / seasoned / buttered / oil-added candidate
  if (
    !PROCESSED_FOOD_GUARD.test(q) &&
    /\b(sweet\s+potato(?:es)?|yams?|potato(?:es)?|russet|yukon\s+gold|carrots?|apples?|bananas?|broccoli|cauliflower|spinach|kale|lettuce|avocados?|tomatoes?|onions?|peppers?|mushrooms?|zucchini|squash|celery|cucumbers?|berries|strawberries|blueberries|raspberries|grapes?|oranges?|peaches?|pears?|mangoes?|pineapple|fresh\s+whole|fresh\s+produce|salmon|cod|tilapia|halibut|trout|mahi|shrimp|scallops?|pork\s+chops?|pork\s+loin|pork\s+tenderloin|ribeye|sirloin|new\s+york\s+strip|flank\s+steak|skirt\s+steak|chuck\s+roast|beef\s+stew\s+meat|chicken\s+breasts?|chicken\s+thighs?|chicken\s+drumsticks?|chicken\s+tenderloins?)\b/.test(
      q
    )
  ) {
    if (
      /\b(chips?|crisps?|crispy|fries|fried|tots|puffs?|crackers?|cookies?|bars?|cereal|pie|cake|muffin|waffles?|pancakes?|pasta|gnocchi|ramen|noodles?|soup|sauce|dressing|dip|salsa|ketchup|jam|jelly|syrup|candy|gummies|soda|drink|beverage|juice|herb\s+butter|garlic\s+butter|stuffed|breaded|battered|marinated|teriyaki|bbq|barbecue|glazed|smoked|jerky|sausage|bacon|ham|hot\s+dog|frank|deli|sliced\s+oven\s+roasted)\b/.test(
        t
      ) ||
      /\b(canola\s+oil|sunflower\s+oil|safflower\s+oil|soybean\s+oil|vegetable\s+oil|palm\s+oil|palm\s+kernel\s+oil|corn\s+oil|cottonseed\s+oil|peanut\s+oil|coconut\s+oil|avocado\s+oil|olive\s+oil|rice\s+bran\s+oil|shortening|lard|tallow|hydrogenated|corn\s+syrup|high\s+fructose\s+corn\s+syrup|maltodextrin|dextrose|enriched\s+flour|wheat\s+flour|modified\s+(?:food|corn|potato)\s+starch|sodium\s+nitrite|sodium\s+phosphate|caramel\s+color| monosodium\s+glutamate)\b/.test(
        ing
      )
    ) {
      return true;
    }
  }

  return false;
}

function catalogFallback(query: string): Omit<LookupResult, "ms"> | null {
  const cleanTitle = query
    .trim()
    .replace(/\s*[.,•|\-]?\s*\bbased\s+on(?:\s+[\d,]+\s+ratings?|\s+customer\s+ratings?|\s+star\s+ratings?)?\s*[.,•|\-]*$/i, "")
    .replace(/\s*,\s*\d+\s*\.\.\.+$/, "")
    .replace(/,\s*(now|was)$/i, "")
    .replace(/\s*[.,•|\-]+\s*$/, "")
    .replace(/(^|[\s\-/(])\w/g, (c) => c.toUpperCase());
  const wordCount = cleanTitle.split(/\s+/).filter(Boolean).length;
  // Never infer USDA Organic certification from query text alone
  const isOrganic = false;

  // Check Just Bare before generic breaded poultry
  if (/\bjust\s+bare\b/i.test(query)) {
    const jbIng =
      "Boneless Skinless Chicken Breast with Rib Meat, Water, Wheat Flour, Contains 2% or Less of: Yellow Corn Flour, Sea Salt, Rice Starch, Spices, Dried Garlic, Dried Onion, Paprika, Yeast, Cream of Tartar, Sodium Bicarbonate.";
    if (
      hasValidCatalogProvenance("https://www.justbarefoods.com/product/lightly-breaded-chicken-breast-strips/", "2026-11-08") &&
      passesVariantGuard(query, "Just Bare Lightly Breaded Chicken Breast Strips") &&
      !isDietaryOrVariantMismatch(query, "Just Bare Lightly Breaded Chicken Breast Strips", jbIng)
    ) {
      return {
        productTitle: cleanTitle,
        brand: "Just Bare",
        ingredients: jbIng,
        imageUrl: `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(cleanTitle)}&v=4`,
        nutrition: { caloriesKcal100g: 175, sugarsG100g: 1.0, saturatedFatG100g: 1.5, sodiumMg100g: 380, fiberG100g: 1.0, proteinG100g: 18.5, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isWholeFood: false, isOrganic: false },
        source: "catalog",
        sourceUpdatedAt: "2026-11-08",
      };
    }
  }

  // Check comprehensive Drinks & Beverages Catalog (Energy Drinks, Pre-Workouts, Sodas, Milks, Waters, Juices, Sports Drinks, Tea/Coffee)
  const drinkHit = matchDrinkCatalog(query);
  if (drinkHit && !isDietaryOrVariantMismatch(query, drinkHit.title, drinkHit.ingredients, drinkHit.nutrition)) {
    const fullDrinkTitle = drinkHit.title.toLowerCase().startsWith(drinkHit.brand.toLowerCase())
      ? drinkHit.title
      : `${drinkHit.brand} ${drinkHit.title}`;
    const resolvedDrinkTitle = wordCount <= 3 ? fullDrinkTitle : cleanTitle;
    return {
      productTitle: resolvedDrinkTitle,
      brand: drinkHit.brand,
      category: drinkHit.category,
      description: drinkHit.description,
      ingredients: drinkHit.ingredients,
      imageUrl: `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(fullDrinkTitle)}&v=4`,
      nutrition: { ...drinkHit.nutrition, isOrganic: drinkHit.nutrition?.isOrganic === true },
      source: "catalog",
      sourceUpdatedAt: drinkHit.verifiedAt,
    };
  }

  for (const entry of INSTANT_GROCERY_CATALOG) {
    if (
      hasValidCatalogProvenance(entry.sourceUrl, entry.verifiedAt) &&
      !entry.title.includes("/") &&
      !entry.brand.includes("/") &&
      entry.match.test(query) &&
      passesVariantGuard(query, entry.title) &&
      !hasConflictingBrand(query, `${entry.brand} ${entry.title}`) &&
      !isDietaryOrVariantMismatch(query, entry.title, entry.ingredients, entry.nutrition)
    ) {
      const fullEntryTitle = entry.title.toLowerCase().startsWith(entry.brand.toLowerCase())
        ? entry.title
        : `${entry.brand} ${entry.title}`;
      const resolvedTitle = wordCount <= 2 ? fullEntryTitle : cleanTitle;
      const resolvedImageUrl = entry.imageUrl?.startsWith("https://images.openfoodfacts.org/")
        ? entry.imageUrl
        : `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(resolvedTitle)}&v=4`;
      return {
        productTitle: resolvedTitle,
        brand: entry.brand,
        ingredients: entry.ingredients,
        imageUrl: resolvedImageUrl,
        nutrition: { ...entry.nutrition, isOrganic: entry.nutrition?.isOrganic === true },
        source: "catalog",
        sourceUpdatedAt: entry.verifiedAt,
      };
    }
  }
  const s = query.toLowerCase();
  if (NON_FOOD_GUARD.test(s) || NAMED_BRAND_GUARD.test(s)) {
    return null;
  }

  for (const cat of CATEGORY_FALLBACK_CATALOG) {
    if (
      hasValidCatalogProvenance(cat.sourceUrl, cat.verifiedAt) &&
      cat.match.test(query) &&
      passesVariantGuard(query, cat.brand) &&
      !isDietaryOrVariantMismatch(query, cat.brand, cat.ingredients, cat.nutrition)
    ) {
      return {
        productTitle: `${cleanTitle} (Category Estimate)`,
        brand: `${cat.brand} (Category Estimate — Verify Package Label)`,
        description:
          "Representative category formulation shown because an exact product/UPC label was not returned by Open Food Facts or USDA. Formulations vary by brand and batch; always verify the physical package label.",
        ingredients: `${cat.ingredients} [Representative Category Formulation — Verify Physical Package Label]`,
        imageUrl: `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(cleanTitle)}&v=4`,
        nutrition: { ...cat.nutrition, isOrganic: cat.nutrition.isOrganic === true },
        source: "catalog",
        sourceUpdatedAt: cat.verifiedAt,
      };
    }
  }

  if (PROCESSED_FOOD_GUARD.test(s)) {
    return null;
  }

  // 1. Fresh Produce, Fruits, Vegetables, Herbs & Salad Greens (strictly single-ingredient)
  if (
    /\b(salad|lettuce|romaine|spinach|kale|arugula|cabbage|broccoli|cauliflower|carrots?|celery|cucumbers?|tomato(?:es)?|sweet\s+potato(?:es)?|potato(?:es)?|yams?|onions?|scallions?|shallots?|leeks?|garlic|ginger|parsley|cilantro|basil|rosemary|thyme|dill|mint|sage|chives|oregano|peppers?|mushrooms?|avocados?|zucchini|squash|pumpkin|asparagus|green\s+beans|brussels\s+sprouts|beets?|radish\w*|turnips?|eggplants?|artichokes?|okra|fennel|bok\s+choy|chard|collards?|edamame|peas|apples?|bananas?|strawberries|blueberries|raspberries|blackberries|cherries|grapes?|oranges?|mandarins?|clementines?|tangerines?|grapefruits?|lemons?|limes?|peaches?|plums?|nectarines?|apricots?|pears?|kiwis?|mangoes?|pineapple|watermelon|cantaloupe|honeydew|papayas?|pomegranates?|figs?|dates?|berries|vegetables?|veggies|fresh\s+produce)\b/.test(s)
  ) {
    return {
      productTitle: cleanTitle,
      brand: "Fresh Produce",
      ingredients: "100% Fresh Whole Produce (Single-Ingredient Whole Food).",
      imageUrl: `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(cleanTitle)}&v=4`,
      nutrition: { fruitsVegNutsPct: 100, isWholeFood: true, isOrganic },
      source: "catalog",
      sourceUpdatedAt: "2026-11-08",
    };
  }

  // 2. Plain Fresh / Frozen Meat, Poultry (Whole Turkey, Chicken Breast Fillets, etc.), Seafood & Shell Eggs (unbreaded, uncured)
  if (
    /\b(chicken\s+(breasts?|fillets?|cutlets?|thighs?|drumsticks?|wings?|tenderloins?|quarters?|legs?)|whole\s+chicken|young\s+chicken|(?:whole|frozen|young|fresh|antibiotic[- ]?free|organic|pasture[- ]?raised|grade\s+a)\s+turkey|turkey\s+(breasts?|thighs?|drumsticks?|wings?|tenderloins?)|whole\s+turkey|\bturkey\b|ground\s+(beef|chuck|turkey|chicken|pork|bison|lamb)|beef\s+(stew|chuck|roast|brisket|sirloin|ribeye|tenderloin|short\s+ribs?|flank|skirt)|ribeye|sirloin|filet|new\s+york\s+strip|t-bone|porterhouse|pork\s+(chops?|loin|tenderloin|roast|shoulder|ribs?|belly)|lamb\s+(chops?|leg|shank|rack)|salmon|cod|tilapia|haddock|halibut|trout|mahi|swordfish|catfish|snapper|sea\s+bass|tuna\s+steak|shrimp|scallops?|crab\s+legs?|lobster\s+tails?|large\s+eggs?|white\s+eggs?|brown\s+eggs?|cage[- ]?free\s+eggs?|pasture[- ]?raised\s+eggs?|grade\s+aa?\s+.*eggs?|\beggs\b)\b/.test(s)
  ) {
    return {
      productTitle: cleanTitle,
      brand: "Fresh Meat & Eggs",
      ingredients: "100% Whole Food Protein (Single-Ingredient Unprocessed Meat, Poultry, or Eggs).",
      imageUrl: `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(cleanTitle)}&v=4`,
      nutrition: { fruitsVegNutsPct: 0, isWholeFood: true, isOrganic },
      source: "catalog",
      sourceUpdatedAt: "2026-11-08",
    };
  }

  // 3. Raw Nuts, Seeds, Legumes & Whole Grains (unflavored, uncandied single-ingredient whole foods)
  if (
    /\b(raw\s+almonds?|whole\s+almonds?|\balmonds\b|walnuts?|pecans?|cashews?|pistachios?|macadamia\s+nuts?|hazelnuts?|brazil\s+nuts?|pine\s+nuts?|chia\s+seeds?|flax\s*seeds?|hemp\s+(?:seeds?|hearts?)|pumpkin\s+seeds?|pepitas|sunflower\s+seeds?|sesame\s+seeds?|quinoa|lentils?|chickpeas?|garbanzo\s+beans?|black\s+beans?|pinto\s+beans?|kidney\s+beans?|navy\s+beans?|cannellini\s+beans?|great\s+northern\s+beans?|split\s+peas)\b/.test(
      s,
    )
  ) {
    return {
      productTitle: cleanTitle,
      brand: "Whole Nuts, Seeds & Legumes",
      ingredients: "100% Whole Nuts, Seeds, or Legumes (Single-Ingredient Whole Food).",
      imageUrl: `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(cleanTitle)}&v=2`,
      nutrition: { fruitsVegNutsPct: 100, isWholeFood: true, isOrganic },
      source: "catalog",
      sourceUpdatedAt: "2026-11-08",
    };
  }

  return null;
}

/** Strips club-store pack counts, decimal weights, and Walmart/Amazon/Whole Foods promo suffixes for cleaner external API queries. */
function cleanSearchQuery(title: string): string {
  return title
    .replace(/[®™©]/g, "")
    .replace(/\s*[.,•|\-]?\s*\bbased\s+on(?:\s+[\d,]+\s+ratings?|\s+customer\s+ratings?|\s+star\s+ratings?)?\s*[.,•|\-]*$/i, "")
    .replace(/\s+for\s+(?:sandwiches|sushi|sashimi|dipping|prime\s+rib|steak|salads?|marinades?)\b.*$/i, "")
    .replace(/\s*[-–—|]\s*pack\s+of\s+\d+.*$/i, "")
    .replace(/\s*\(\d+(\.\d+)?\s*(?:oz|fl\s*oz|lb|lbs|ct|count|pk|pack|g|kg|ml)\)\s*[-–—|]?.*$/i, "")
    .replace(/:\s*\d+(?:\s*[-–—]\s*\d+)?\s*(?:lbs?|oz|fl\s*oz|ct|count|pk|pack|g|kg)\b.*$/i, "")
    .replace(/,\s*(frozen\s+(?:breakfast|food|meal|snack|entree|dessert)s?|fresh\s+deli\s+soup|deli\s+soup|refrigerated|fresh\s+deli|family\s+size|mega\s+size|giant\s+size|value\s+size|value\s+pack|party\s+size|about\s+\d+\s+[a-z]+\s+per\s+pack|previously\s+frozen|serves\s+\d+|\d+(\.\d+)?\s*(pk|pack|ct|count|oz|fl\s*oz|lb|lbs|g|kg|ml|l|box|bag|tub|can|jar|bottle|carton|cup|bowl|tray|pouch|dozen)\b).*$/i, "")
    .replace(/\s+\d+(\.\d+)?\s*(oz|fl\s*oz|lb|lbs|ct|count|pk|pack|dozen)\b.*$/i, "")
    .replace(/\s*[-–—]\s*\d+(\.\d+)?\s*(pk|pack|ct|count|oz|fl\s*oz|lb|lbs|dozen)\b.*$/i, "")
    .replace(/\s*\((fresh|refrigerated|frozen)\)\s*$/i, "")
    .replace(/,\s*(now|was)\b.*$/i, "")
    .replace(/\s*,\s*\d+\s*\.\.\.+$/, "")
    .replace(/\.\.\.+$/, "")
    .replace(/\s*[.,•|\-]+\s*$/, "")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function lookupIngredients(input: LookupInput): Promise<LookupResult | null> {
  const t0 = performance.now();
  const ms = () => Math.round((performance.now() - t0) * 100) / 100;
  const title = (input.productTitle || "").trim();

  if (
    title &&
    (UI_NOISE_QUERY.test(title) ||
      /\b(toilet\s+paper|paper\s+towels?|bath\s+tissue|facial\s+tissue|disposable\s+(?:forks?|spoons?|knives|cutlery|utensils?|plates?|cups?|bowls?)|plastic\s+(?:forks?|spoons?|knives|cutlery|utensils?|plates?|cups?|bowls?|straws?)|paper\s+(?:plates?|bowls?|cups?|napkins?)|trash\s+bags?|garbage\s+bags?|aluminum\s+foil|plastic\s+wrap|parchment\s+paper|storage\s+bags?|freezer\s+bags?|topcare|pain\s*&\s*fever|oral\s+suspension|acetaminophen|ibuprofen|tylenol|advil|motrin|benadryl|mucinex|nyquil|dayquil|robitussin|pepto|tums|laxative|antacid|cough\s+syrup|nasal\s+spray|eye\s+drops)\b/i.test(
        title,
      ))
  ) {
    return null;
  }

  const rawIng = input.rawIngredients?.trim() || "";
  if (rawIng) {
    // If productTitle is also provided (e.g. from the mobile screen reader or browser extension),
    // verify that rawIngredients is an actual ingredient list and not an adjacent UI heading like "Items to add next".
    if (!title || isPlausibleScreenIngredients(rawIng)) {
      return {
        productTitle: title || "Scanned product",
        barcode: input.barcode,
        ingredients: rawIng,
        nutrition: SUPPLEMENT_FORM.test(`${title} ${rawIng}`) ? { productKind: "supplement", isOrganic: false } : undefined,
        source: "screen",
        ms: ms(),
      };
    }
  }

  const key = cacheKey(input);
  if (!key) return null;

  const DIRECT_CATALOG_PRIORITY =
    /\b(simple\s+truth|private\s+selection|good\s*(?:&|and)\s*gather|favorite\s+day|big\s+k|velveeta|lactaid|fairlife|martin'?s|white\s+sandwich\s+bread|great\s+value.*(?:milk|eggs?|bread|water)|cinnamon\s+toast\s+crunch|lucky\s+charms|doritos|pedialyte|planet\s+oat|doubleshot|owyn|liquid\s+death|silk\s+soy(?:milk)?|soy\s*milk|ito\s+en|oi\s+ocha|ritz\s+original|maruchan|top\s+ramen|nissin|cup\s+noodles?|shin\s+ramyun|buldak|samyang|indomie|nongshim|sapporo\s+ichiban|instant\s+ramen|ramen\s+noodle\s+soup|ramen\s+noodles?|knoppers|tony'?s\s+chocolonely|ferrero|lindt|lindor|hershey'?s|reese'?s|frank'?s\s+redhot|butterball|potatoes,?\s+butter|butter\s+potatoes?|baby\s+cut\s+carrots?|yams?\s*\(sweet\s+potatoes?\)|honeycrisp\s+apples?|bismark|freshness\s+guaranteed|smithfield|my\s+cookie\s+dealer|protein\s+toaster\s+pastr(?:y|ies)|ground\s+(?:beef|chuck|turkey|chicken|pork|bison|lamb)|\d{2}%\s*lean|marketside\s+butcher|stonyfield|organic\s+valley|applegate|lotus\s+foods|rao'?s|french'?s|mccormick|idahoan|carvel|panera|blount|fresh\s+banana|bananas?|rotisserie|steamfresh|oscar\s+mayer|tyson|ezekiel|dave'?s\s+killer|kind\s+(?:nut\s+)?bars?|inglehoffer|beaver\s+brand|kikkoman.*wasabi|wasabi[- ]?o|wicked\s+cutz|hellmann'?s|best\s+foods|kraft\s+mayo|primal\s+kitchen|chosen\s+foods|boulder\s+canyon)\b/i;

  const isPlainProduceDirectPriority =
    !PROCESSED_FOOD_GUARD.test(title) &&
    /\b(fresh\s+whole\b|fresh\s+produce\b|sweet\s+potato(?:es)?|russet\s+potato(?:es)?|idaho\s+potato(?:es)?|yukon\s+gold\s+potato(?:es)?|red\s+potato(?:es)?|yellow\s+potato(?:es)?|raw\s+(?:whole\s+)?(?:almonds?|walnuts?|pecans?|cashews?|pistachios?|hazelnuts?|macadamia\s+nuts?|brazil\s+nuts?|pumpkin\s+seeds?|sunflower\s+seeds?)|chia\s+seeds?|flax\s*seeds?|hemp\s+(?:hearts?|seeds?))\b/i.test(
      title,
    );

  if (!input.barcode && title && (DIRECT_CATALOG_PRIORITY.test(title) || isPlainProduceDirectPriority)) {
    const directCat = catalogFallback(title);
    if (
      directCat &&
      !directCat.productTitle.startsWith("Conventional Grocery") &&
      !/category estimate|representative/i.test(directCat.brand || "")
    ) {
      return { ...directCat, ms: ms() };
    }
  }

  const cache = await loadCache();
  const hit = cache.get(key);
  if (
    isFreshCacheEntry(hit) &&
    !hit.productTitle.startsWith("Conventional Grocery") &&
    (!title ||
      (passesVariantGuard(title, hit.productTitle) &&
        !isDietaryOrVariantMismatch(title, hit.productTitle, hit.ingredients, hit.nutrition)))
  ) {
    const { cachedAt: _c, source, ...rest } = hit;
    return { ...rest, source: "cache", origin: source, ms: ms() };
  }

  let found: Omit<LookupResult, "ms"> | null = null;
  const hasDedicatedUsdaKey = Boolean((process.env.USDA_API_KEY || "").trim());

  found = await lookupProviders({ ...input, productTitle: title });
  if (!found && title) found = catalogFallback(title);
  if (!found) return null;

  if (found.source !== "catalog") {
    setCacheEntry(cache, key, { ...found, cachedAt: new Date().toISOString(), schemaVersion: 2 });
    void persistCache(cache);
  }
  return { ...found, ms: ms() };
}
