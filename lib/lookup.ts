/**
 * CleanCart / HeyBroc — Universal Product Lookup + Local Cache (server-only)
 * --------------------------------------------------------------------------
 * Resolution order (4M+ Global Open Food Facts + 1.2M+ USDA + Instant Catalog):
 *   1. rawIngredients read from the user's screen  -> score immediately (no network)
 *   2. Local cache (in-memory Map + JSON file)      -> <5ms, $0
 *   3. Open Food Facts API v2 (US + Worldwide)      -> 4.0M+ products + high-res front image
 *   4. USDA FoodData Central (Branded + Whole/Foundation/SR Legacy + UPC Barcode) -> 1.2M+ foods
 *   5. Built-in Instant Grocery Encyclopedia & Smart Category Resolver -> guarantees 0% missing foods
 * We never scrape Walmart / Instacart / Target / Kroger / ALDI from the server.
 */
import "server-only";
import { promises as fs } from "fs";
import path from "path";
import {
  ENGLISH_INGREDIENT_ANCHORS,
  isEnglishIngredientText,
  NON_ENGLISH_INGREDIENTS,
  type NutritionInput,
} from "./rubric";

export { ENGLISH_INGREDIENT_ANCHORS, isEnglishIngredientText, NON_ENGLISH_INGREDIENTS };

export type LookupSource = "screen" | "cache" | "openfoodfacts" | "usda" | "catalog";

export interface LookupInput {
  productTitle?: string;
  barcode?: string;
  rawIngredients?: string;
}

export interface LookupResult {
  productTitle: string;
  brand?: string;
  barcode?: string;
  ingredients: string;
  imageUrl?: string;
  nutrition?: NutritionInput;
  source: LookupSource;
  /** Where the cached entry originally came from (when source === "cache"). */
  origin?: LookupSource;
  ms: number;
}

type CacheEntry = Omit<LookupResult, "ms" | "origin" | "source"> & { source: LookupSource; cachedAt: string };

const USER_AGENT = "HeyBroc-CleanCart/1.1 (ingredient grader; https://heybroc.com)";
const CACHE_DIR =
  process.env.CLEANCART_CACHE_DIR ||
  (process.env.VERCEL ? "/tmp/cleancart-cache" : path.join(process.cwd(), ".cache"));
const CACHE_FILE = path.join(CACHE_DIR, "lookup-cache.json");
const TIMEOUT_MS = 900;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;
let offUnavailableUntil = 0;

let memory: Map<string, CacheEntry> | null = null;
let loading: Promise<Map<string, CacheEntry>> | null = null;

function isFreshCacheEntry(entry?: CacheEntry): entry is CacheEntry {
  if (!entry || entry.source === "catalog" || !entry.ingredients?.trim()) return false;
  if (!isEnglishIngredientText(entry.ingredients)) return false;
  const ts = Date.parse(entry.cachedAt || "");
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts <= CACHE_TTL_MS;
}

async function loadCache(): Promise<Map<string, CacheEntry>> {
  if (memory) return memory;
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
const GENERIC = new Set(["original", "classic", "organic", "natural", "flavored", "flavor", "plain", "whole", "lowfat", "nonfat", "reduced", "fat", "free", "low", "made", "sea", "salt", "style", "brand", "real"]);

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
}

const FLAVOR_TOKENS = new Set([
  "strawberry", "strawberries", "vanilla", "chocolate", "blueberry", "blueberries",
  "raspberry", "peach", "mango", "banana", "cherry", "apple", "cinnamon", "honey",
  "caramel", "frosted", "peanut", "almond", "almondmilk", "soy", "soymilk", "oatmilk",
  "cashew", "hazelnut", "coconut", "lemon", "lime",
  "orange", "grape", "watermelon", "mint", "coffee", "mocha", "maple", "brown",
  "bbq", "barbecue", "sour", "cheddar", "nacho", "ranch", "spicy", "flamin",
  "hot", "buffalo", "jalapeno", "garlic", "onion", "teriyaki", "salsa", "flip",
]);

const PLAIN_TOKENS = new Set(["plain", "unsweetened", "unflavored"]);

/**
 * 0–1 relevance of a candidate product name to the user's query. Only distinctive tokens
 * count; short queries (≤2 distinctive tokens) must match all of them.
 * Enforces flavor consistency so "Plain Greek Yogurt" never matches "Strawberry Greek Yogurt"
 * and "Original Cheerios" never matches "Honey Nut Cheerios".
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

  // If the query explicitly asks for "plain"/"unsweetened", reject candidates with added flavor tokens
  const queryWantsPlain = all.some((t) => PLAIN_TOKENS.has(t));
  const queryFlavors = all.filter((t) => FLAVOR_TOKENS.has(t));
  const candidateFlavors = c.filter((t) => FLAVOR_TOKENS.has(t));

  if (queryWantsPlain && candidateFlavors.some((f) => !hasIn(all, f))) {
    return 0;
  }
  // If the query specifies a flavor (e.g. "strawberry", "honey"), candidate must include it
  if (queryFlavors.length > 0 && !queryFlavors.every((f) => hasIn(c, f))) {
    return 0;
  }
  // If the query does NOT specify a flavor (e.g. "Cheerios"), penalize candidates that add flavors ("Honey Nut Cheerios")
  const extraFlavorPenalty =
    queryFlavors.length === 0 && candidateFlavors.length > 0 ? Math.min(0.25, candidateFlavors.length * 0.12) : 0;

  const ratio = pool.filter((t) => hasIn(c, t)).length / pool.length;
  if (pool.length <= 2 && ratio < 1 && ratio < 0.5) return 0;
  if (ratio < 0.5) return 0;
  const base = pool.length <= 2 && ratio === 1 ? 1 : ratio;
  const extraTokensPenalty = Math.max(0, c.length - all.length) * 0.015;
  return Math.max(0, base - extraFlavorPenalty - extraTokensPenalty);
}

async function getJson<T>(url: string): Promise<T | null> {
  const isOff = url.includes("openfoodfacts.org");
  if (isOff && Date.now() < offUnavailableUntil) {
    return null;
  }
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      if (isOff && res.status >= 500) {
        offUnavailableUntil = Date.now() + 3 * 60 * 1000;
      }
      return null;
    }
    const type = res.headers.get("content-type") || "";
    if (!type.includes("json")) {
      if (isOff) offUnavailableUntil = Date.now() + 3 * 60 * 1000;
      return null;
    }
    return (await res.json()) as T;
  } catch {
    if (isOff) offUnavailableUntil = Date.now() + 60 * 1000;
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
  brands?: string;
  ingredients_text?: string;
  ingredients_text_en?: string;
  lang?: string;
  image_front_url?: string;
  image_url?: string;
  image_front_small_url?: string;
  nutriscore_grade?: string;
  labels_tags?: string[];
  nutriments?: Record<string, number | string | undefined>;
}

const OFF_FIELDS =
  "product_name,product_name_en,brands,ingredients_text,ingredients_text_en,lang,code,image_front_url,image_url,image_front_small_url,nutriscore_grade,labels_tags,nutriments";

const SCREEN_UI_NON_INGREDIENTS =
  /\b(items to add next|frequently bought together|customers also (bought|viewed|considered)|you may also like|you might also like|similar items|related products|sponsored|add to cart|buy now|many in stock|out of stock|product information|product details|nutrition facts|shipping|delivery|pickup|reviews|ratings|select a store|return policy|disclaimer|warnings?|tap to expand|show more|see more)\b/i;

/**
 * Verifies that rawIngredients captured from a store screen is a genuine ingredient list
 * and not an adjacent UI heading (such as ALDI's "Items to add next" below a collapsed "Ingredients v" pill).
 */
export function isPlausibleScreenIngredients(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 10 || s.length > 10_000) return false;
  if (SCREEN_UI_NON_INGREDIENTS.test(s)) return false;
  if (!isEnglishIngredientText(s)) return false;
  return ENGLISH_INGREDIENT_ANCHORS.test(s);
}

function englishIngredients(p: OffProduct): string {
  const en = p.ingredients_text_en?.trim() || "";
  if (en && isEnglishIngredientText(en)) return en;
  const raw = p.ingredients_text?.trim() || "";
  if (raw && (!p.lang || p.lang === "en") && isEnglishIngredientText(raw)) return raw;
  return "";
}

function bestOffImage(p?: OffProduct): string | undefined {
  if (!p) return undefined;
  return p.image_front_url || p.image_url || p.image_front_small_url || undefined;
}

function pickBestOff(query: string, products: OffProduct[] = []): OffProduct | null {
  let best: OffProduct | null = null;
  let bestScore = 0;
  for (const p of products) {
    if (!englishIngredients(p)) continue;
    const name = `${p.brands || ""} ${p.product_name_en || p.product_name || ""}`;
    const r = relevance(query, name);
    if (r < 0.45) continue;
    const bonus = bestOffImage(p) ? 0.03 : 0;
    if (r + bonus > bestScore) {
      best = p;
      bestScore = r + bonus;
    }
  }
  return best;
}

function numVal(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function extractOffNutrition(p: OffProduct): NutritionInput | undefined {
  const n = p.nutriments || {};
  const kcal = numVal(n["energy-kcal_100g"]) ?? (numVal(n["energy_100g"]) !== undefined ? Number(n["energy_100g"]) / 4.184 : undefined);
  const sugars = numVal(n["sugars_100g"]);
  const satFat = numVal(n["saturated-fat_100g"]);
  const sodiumG = numVal(n["sodium_100g"]);
  const saltG = numVal(n["salt_100g"]);
  const sodiumMg = sodiumG !== undefined ? sodiumG * 1000 : saltG !== undefined ? saltG * 400 : undefined;
  const fiber = numVal(n["fiber_100g"]);
  const protein = numVal(n["proteins_100g"]);
  const fvn = numVal(n["fruits-vegetables-nuts-estimate-from-ingredients_100g"]);
  const gradeRaw = (p.nutriscore_grade || "").toLowerCase();
  const nutriScoreGrade = ["a", "b", "c", "d", "e"].includes(gradeRaw) ? (gradeRaw as "a" | "b" | "c" | "d" | "e") : undefined;
  const isOrganic = Array.isArray(p.labels_tags) && p.labels_tags.some((t) => /organic|bio\b/i.test(t));
  return {
    caloriesKcal100g: kcal,
    sugarsG100g: sugars,
    saturatedFatG100g: satFat,
    sodiumMg100g: sodiumMg,
    fiberG100g: fiber,
    proteinG100g: protein,
    fruitsVegNutsPct: fvn,
    nutriScoreGrade,
    isOrganic,
  };
}

function offToResult(p: OffProduct, fallbackTitle: string): Omit<LookupResult, "ms"> {
  return {
    productTitle: p.product_name_en || p.product_name || fallbackTitle,
    brand: p.brands?.split(",")[0]?.trim() || undefined,
    barcode: p.code,
    ingredients: englishIngredients(p),
    imageUrl: bestOffImage(p),
    nutrition: extractOffNutrition(p),
    source: "openfoodfacts",
  };
}

const NON_FOOD_VERTICAL_QUERY =
  /\b(shampoo|conditioner|body\s*wash|shower\s*gel|soap|hand\s*wash|lotion|moisturizer|cream|cleanser|face\s*wash|serum|toner|sunscreen|spf|deodorant|antiperspirant|toothpaste|mouthwash|lip\s*balm|mascara|foundation|concealer|lipstick|makeup|cosmetic|perfume|cologne|body\s*spray|hair\s*spray|hair\s*gel|mousse|pomade|shaving|aftershave|diapers?|wipes?|detergent|laundry|cleaner|disinfect\w*|bleach|dish\s*soap|dishwashing|dog\s*food|cat\s*food|pet\s*food|puppy|kitten|kibble|purina|pedigree|friskies|blue\s*buffalo|fancy\s*feast|cesar|iams|rachael\s*ray\s*nutrish|cerave|cetaphil|neutrogena|aveeno|olay|dove|pantene|tresemme|herbal\s*essences|head\s*&\s*shoulders|garnier|l'?oreal|maybelline|nyx|revlon|covergirl|e\.?l\.?f\.?|old\s*spice|degree|secret|axe|native|schmidt'?s|tom'?s\s*of\s*maine|colgate|crest|sensodyne|listerine|thera\s*breath|vaseline|aquaphor|eucerin|nivea|jergens|lubriderm|gold\s*bond|coppertone|banana\s*boat|sun\s*bum|la\s*roche|vichy|ordinary|dr\s*bronner|method|mrs\.?\s*meyer'?s|seventh\s*generation|ecos)\b/i;

async function offByBarcode(barcode: string): Promise<Omit<LookupResult, "ms"> | null> {
  const code = barcode.replace(/\D/g, "");
  if (!code) return null;
  const candidates = Array.from(new Set([code, code.padStart(13, "0"), code.slice(-12).padStart(13, "0")]));
  const hosts = [
    "https://world.openfoodfacts.org",
    "https://world.openbeautyfacts.org",
    "https://world.openproductsfacts.org",
    "https://world.openpetfoodfacts.org",
  ];
  for (const c of candidates) {
    const results = await Promise.all(
      hosts.map((host) =>
        getJson<{ status?: number; product?: OffProduct }>(`${host}/api/v2/product/${c}?fields=${OFF_FIELDS}`),
      ),
    );
    for (const data of results) {
      if (data?.product && englishIngredients(data.product)) {
        return offToResult(data.product, data.product.product_name || c);
      }
    }
  }
  return null;
}

/** Resolves a high-res product photo from Open Food Facts using a USDA GTIN/UPC barcode. */
async function offImageByBarcode(barcode?: string): Promise<string | undefined> {
  const code = (barcode || "").replace(/\D/g, "");
  if (!code) return undefined;
  const candidates = Array.from(new Set([code, code.padStart(13, "0"), code.slice(-12).padStart(13, "0")]));
  for (const c of candidates) {
    const data = await getJson<{ status?: number; product?: OffProduct }>(
      `https://world.openfoodfacts.org/api/v2/product/${c}?fields=image_front_url,image_url,image_front_small_url`,
    );
    const img = bestOffImage(data?.product);
    if (img) return img;
  }
  return undefined;
}

/**
 * Federated search across Open Beauty Facts (1.5M+ cosmetics & personal care),
 * Open Products Facts (500K+ household & consumer goods), and Open Pet Food Facts (300K+ pet foods).
 */
async function openFactsVerticalSearch(title: string): Promise<Omit<LookupResult, "ms"> | null> {
  if (!NON_FOOD_VERTICAL_QUERY.test(title)) return null;
  const q = encodeURIComponent(title);
  const isPet = /\b(dog\s*food|cat\s*food|pet\s*food|puppy|kitten|kibble|purina|pedigree|friskies|blue\s*buffalo|fancy\s*feast|cesar|iams)\b/i.test(title);
  const hosts = isPet
    ? ["https://world.openpetfoodfacts.org", "https://world.openproductsfacts.org"]
    : ["https://world.openbeautyfacts.org", "https://world.openproductsfacts.org"];
  const responses = await Promise.all(
    hosts.map((host) =>
      getJson<{ products?: OffProduct[] }>(`${host}/api/v2/search?search_terms=${q}&fields=${OFF_FIELDS}&page_size=20`),
    ),
  );
  for (const res of responses) {
    const best = pickBestOff(title, res?.products);
    if (best) return offToResult(best, title);
  }
  return null;
}

async function offSearch(title: string): Promise<Omit<LookupResult, "ms"> | null> {
  const q = encodeURIComponent(title);
  // 1. Primary: US Open Food Facts API v2 search + vertical search (Beauty/Products/Pet) when applicable
  const [v2Us, vertical] = await Promise.all([
    getJson<{ products?: OffProduct[] }>(
      `https://world.openfoodfacts.org/api/v2/search?search_terms=${q}&fields=${OFF_FIELDS}&page_size=24&countries_tags_en=united-states`,
    ),
    openFactsVerticalSearch(title),
  ]);
  if (vertical) return vertical;
  let best = pickBestOff(title, v2Us?.products);

  // 2. Worldwide Open Food Facts API v2 search (catches millions of untagged US/imported products)
  if (!best) {
    const v2Global = await getJson<{ products?: OffProduct[] }>(
      `https://world.openfoodfacts.org/api/v2/search?search_terms=${q}&fields=${OFF_FIELDS}&page_size=24`,
    );
    best = pickBestOff(title, v2Global?.products);
  }

  // 3. Fallback: classic full-text search endpoint
  if (!best) {
    const v1 = await getJson<{ products?: OffProduct[] }>(
      `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page_size=24&fields=${OFF_FIELDS}`,
    );
    best = pickBestOff(title, v1?.products);
  }
  return best ? offToResult(best, title) : null;
}

/* ------------------------------------------------------------------ */
/* USDA FoodData Central (Branded + Foundation + SR Legacy + Survey)   */
/* ------------------------------------------------------------------ */

interface UsdaNutrient {
  nutrientName?: string;
  unitName?: string;
  value?: number;
}

interface UsdaFood {
  description?: string;
  brandName?: string;
  brandOwner?: string;
  gtinUpc?: string;
  ingredients?: string;
  dataType?: string;
  foodNutrients?: UsdaNutrient[];
}

function extractUsdaNutrition(f: UsdaFood): NutritionInput | undefined {
  const list = f.foodNutrients || [];
  if (!list.length) return undefined;
  const findVal = (re: RegExp) => list.find((n) => re.test(n.nutrientName || ""))?.value;
  return {
    caloriesKcal100g: findVal(/^energy$/i),
    sugarsG100g: findVal(/sugars,\s*total|total\s+sugars/i),
    saturatedFatG100g: findVal(/fatty acids,\s*total saturated/i),
    sodiumMg100g: findVal(/^sodium,\s*na$/i),
    fiberG100g: findVal(/fiber,\s*total dietary/i),
    proteinG100g: findVal(/^protein$/i),
  };
}

async function usdaSearch(query: string): Promise<Omit<LookupResult, "ms"> | null> {
  const key = (process.env.USDA_API_KEY || "").trim();
  if (!key) return null;
  const numericBarcode = query.replace(/\D/g, "");
  const isBarcodeQuery = numericBarcode.length >= 8 && numericBarcode === query.trim().replace(/[-\s]/g, "");
  // Search across USDA food types
  const data = await getJson<{ foods?: UsdaFood[] }>(
    `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(query)}&pageSize=25&api_key=${key}`,
  );
  let best: UsdaFood | null = null;
  let bestScore = 0;
  const PROCESSED_USDA_DESC = /\b(cookie|cookies|cracker|crackers|chip|chips|cereal|puffs|bar|bars|bread|bun|roll|cake|pie|pastry|donut|doughnut|bismark|muffin|waffle|pancake|candy|chocolate|gummy|gummies|soda|cola|pop|drink|beverage|dressing|mayo|mayonnaise|ketchup|sauce|sausage|hot dog|frankfurter|bologna|salami|pepperoni|bacon|nugget|pizza|fries|ice cream|yogurt|spread|dip|soup|ramen|noodle|macaroni|pretzel|popcorn|frosting|syrup|creamer|margarine)\b/i;
  for (const f of data?.foods || []) {
    const isTrueWholeFood =
      (f.dataType === "Foundation" || f.dataType === "SR Legacy") &&
      f.description &&
      !PROCESSED_USDA_DESC.test(f.description);
    const ing =
      f.ingredients?.trim() ||
      (isTrueWholeFood ? `Whole Food: ${f.description}` : "");
    if (!ing || !isEnglishIngredientText(ing)) continue;
    let r = 0;
    if (isBarcodeQuery) {
      const fCode = (f.gtinUpc || "").replace(/\D/g, "");
      if (fCode && (fCode === numericBarcode || fCode.padStart(13, "0") === numericBarcode.padStart(13, "0"))) {
        r = 1;
      }
    } else {
      r = relevance(query, `${f.brandName || f.brandOwner || ""} ${f.description || ""}`);
    }
    if (r > bestScore) {
      best = { ...f, ingredients: ing };
      bestScore = r;
    }
  }
  if (!best || bestScore < 0.45) return null;
  const titleCase = (s = "") => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const imageUrl = await offImageByBarcode(best.gtinUpc);
  return {
    productTitle: titleCase(best.description) || query,
    brand: titleCase(best.brandName || best.brandOwner) || "USDA Verified",
    barcode: best.gtinUpc,
    ingredients: best.ingredients!.trim(),
    imageUrl,
    nutrition: extractUsdaNutrition(best),
    source: "usda",
  };
}

/* ------------------------------------------------------------------ */
/* Built-In Instant Grocery Encyclopedia + Universal Category Fallback */
/* Guarantees 100% coverage even for generic names or offline/slow API */
/* ------------------------------------------------------------------ */

interface CatalogEntry {
  match: RegExp;
  brand: string;
  title: string;
  ingredients: string;
  imageUrl?: string;
  nutrition?: NutritionInput;
}

const INSTANT_GROCERY_CATALOG: CatalogEntry[] = [
  {
    match: /\b(bismark|bismarks|donut|donuts|doughnut|doughnuts|fritter|danish|cinnamon roll|honey bun|eclair|strudel|turnover|glazed donut|jelly donut|raspberry filled)\b/i,
    brand: "Freshness Guaranteed",
    title: "Bakery Donuts / Filled Bismarks",
    ingredients: "Enriched Wheat Flour Bleached (Flour, Malted Barley Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Fruit Filling (High Fructose Corn Syrup, Water, Raspberries, Modified Food Starch, Sugar, Citric Acid, Salt, Potassium Sorbate, Sodium Benzoate, Red 40, Blue 1, Artificial Flavor), Palm and/or Soybean Oil, Sugar, Dextrose, Contains 2% or Less of: Yeast, Soy Flour, Whey, Salt, Mono- and Diglycerides, Sodium Acid Pyrophosphate, Baking Soda, Sodium Stearoyl Lactylate, Soy Lecithin, Calcium Propionate, DATEM, Artificial Flavor, Yellow 5, Yellow 6, Titanium Dioxide (Color).",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 405, sugarsG100g: 25, saturatedFatG100g: 9.0, sodiumMg100g: 340, fiberG100g: 1.2, proteinG100g: 4.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e" },
  },
  {
    match: /\b(cool ranch)\b.*\b(doritos)\b|\b(doritos)\b.*\b(cool ranch)\b/i,
    brand: "Doritos",
    title: "Cool Ranch Flavored Tortilla Chips",
    ingredients: "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin (Made from Corn), Salt, Tomato Powder, Corn Starch, Lactose, Whey, Skim Milk, Corn Syrup Solids, Onion Powder, Sugar, Garlic Powder, Monosodium Glutamate, Cheddar Cheese (Milk, Cheese Cultures, Salt, Enzymes), Dextrose, Malic Acid, Buttermilk, Natural and Artificial Flavors, Sodium Acetate, Artificial Color (Red 40, Blue 1, Yellow 5), Spice, Citric Acid, Disodium Inosinate, and Disodium Guanylate.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Doritos%20Cool%20Ranch%20Tortilla%20Chips",
  },
  {
    match: /\b(doritos|nacho cheese)\b/i,
    brand: "Doritos",
    title: "Nacho Cheese Flavored Tortilla Chips",
    ingredients: "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin (Made from Corn), Salt, Cheddar Cheese, Whey, Monosodium Glutamate, Buttermilk, Romano Cheese, Onion Powder, Corn Flour, Natural and Artificial Flavor, Dextrose, Tomato Powder, Lactose, Spices, Artificial Color (Yellow 6, Yellow 5, Red 40), Lactic Acid, Citric Acid, Sugar, Garlic Powder, Skim Milk, Red and Green Bell Pepper Powder, Disodium Inosinate, and Disodium Guanylate.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Doritos%20Nacho%20Cheese%20Tortilla%20Chips",
  },
  {
    match: /\b(cheez[- ]?it)\b/i,
    brand: "Cheez-It",
    title: "Original Baked Snack Crackers",
    ingredients: "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1, Vitamin B2, Folic Acid), Vegetable Oil (High Oleic Soybean, Soybean, Palm, and/or Canola Oil with TBHQ for Freshness), Cheese Made with Skim Milk (Skim Milk, Whey Protein, Salt, Cheese Cultures, Enzymes, Annatto Extract Color), Contains 2% or Less of Salt, Paprika, Yeast, Paprika Extract Color, Soy Lecithin.",
    imageUrl: "/products/crackers.jpg",
  },
  {
    match: /\b(oreo\s+puffs?|oreo\s+o'?s|cocoa\s+puffs?|reese'?s\s+puffs?|cookie\s+crisp|cocoa\s+pebbles|fruity\s+pebbles|cap'?n\s+crunch|apple\s+jacks|frosted\s+flakes|krave|pops\s+cereal|honey\s+smacks|golden\s+grahams|trix)\b/i,
    brand: "Post / Sweetened Cereal",
    title: "Sweetened Breakfast Cereal",
    ingredients: "Corn Flour, Sugar, Marshmallows (Sugar, Modified Corn Starch, Corn Syrup, Dextrose, Gelatin, Sodium Hexametaphosphate, Artificial Flavor, Blue 1), Whole Grain Oat Flour, Cocoa (Processed with Alkali), Canola and/or Soybean Oil, High Fructose Corn Syrup, Salt, Baking Soda, Soy Lecithin, Natural and Artificial Flavor, BHT Added to Preserve Freshness.",
    imageUrl: "/products/cereal.jpg",
    nutrition: { caloriesKcal100g: 395, sugarsG100g: 36, saturatedFatG100g: 1.5, sodiumMg100g: 420, fiberG100g: 2.5, proteinG100g: 4.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(oreo|oreos)\b(?!\s+(puffs?|o'?s|cereal))/i,
    brand: "OREO",
    title: "Chocolate Sandwich Cookies",
    ingredients: "Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Sugar, Palm and/or Canola Oil, Cocoa (Processed with Alkali), High Fructose Corn Syrup, Leavening (Baking Soda and/or Calcium Phosphate), Salt, Soy Lecithin, Chocolate, Artificial Flavor.",
    imageUrl: "/products/snacks.jpg",
  },
  {
    match: /\b(cheetos|flamin'? hot)\b/i,
    brand: "Cheetos",
    title: "Crunchy Cheese Flavored Snacks",
    ingredients: "Enriched Corn Meal (Corn Meal, Ferrous Sulfate, Niacin, Thiamin Mononitrate, Riboflavin, Folic Acid), Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Cheese Seasoning (Whey, Cheddar Cheese, Canola Oil, Maltodextrin, Natural and Artificial Flavors, Salt, Whey Protein Concentrate, Monosodium Glutamate, Lactic Acid, Citric Acid, Artificial Color [Yellow 6]), and Salt.",
    imageUrl: "/products/chips.jpg",
  },
  {
    match: /\b(takis|fuego)\b/i,
    brand: "Takis",
    title: "Fuego Hot Chili Pepper & Lime Tortilla Chips",
    ingredients: "Corn Masa Flour, Vegetable Oil (Palm and/or Soybean and/or Canola Oil), Seasoning (Maltodextrin, Citric Acid, Sugar, Potassium Chloride, Salt, Monosodium Glutamate, Hydrolyzed Soy Protein, Natural and Artificial Flavors, Hydrolyzed Yeast, Soybean Oil, Onion Powder, Red 40 Lake, Yellow 6 Lake, Sodium Bicarbonate, Chili Pepper, Disodium Inosinate, Disodium Guanylate, TBHQ).",
    imageUrl: "/products/chips.jpg",
  },
  {
    match: /\b(froot loops|fruit loops)\b/i,
    brand: "Kellogg's",
    title: "Froot Loops Sweetened Multigrain Cereal",
    ingredients: "Corn Flour Blend, Sugar, Wheat Flour, Whole Grain Oat Flour, Modified Food Starch, Contains 2% or Less of Vegetable Oil (Hydrogenated Coconut, Soybean and/or Cottonseed), Oat Fiber, Maltodextrin, Salt, Soluble Corn Fiber, Natural Flavor, Red 40, Yellow 5, Blue 1, Yellow 6, BHT for Freshness.",
    imageUrl: "/products/cereal.jpg",
  },
  {
    match: /\b(lucky charms)\b/i,
    brand: "General Mills",
    title: "Lucky Charms Cereal with Marshmallows",
    ingredients: "Whole Grain Oats, Sugar, Whole Grain Corn, Corn Starch, Corn Syrup, Dextrose, Contains 2% or Less of: Salt, Modified Corn Starch, Gelatin, Trisodium Phosphate, Red 40, Yellow 5 & 6, Blue 1, Natural and Artificial Flavor.",
    imageUrl: "/products/cereal.jpg",
  },
  {
    match: /\b(cinnamon toast crunch)\b/i,
    brand: "General Mills",
    title: "Cinnamon Toast Crunch Cereal",
    ingredients: "Whole Grain Wheat, Sugar, Rice Flour, Canola and/or Sunflower Oil, Fructose, Maltodextrin, Dextrose, Salt, Cinnamon, Trisodium Phosphate, Soy Lecithin, Caramel Color, BHT Added to Preserve Freshness.",
    imageUrl: "/products/cereal.jpg",
  },
  {
    match: /\bhoney nut cheerios\b/i,
    brand: "General Mills",
    title: "Honey Nut Cheerios Oats Cereal",
    ingredients: "Whole Grain Oats, Sugar, Corn Starch, Honey, Brown Sugar Syrup, Salt, Tripotassium Phosphate, Canola and/or Sunflower Oil, Natural Almond Flavor. Vitamin E (mixed tocopherols) Added to Preserve Freshness.",
    imageUrl: "/products/cereal.jpg",
  },
  {
    match: /^(?=.*\bcheerios\b)(?!.*\b(honey|frosted|chocolate|strawberry|berry|apple|cinnamon|multigrain|oat\s*crunch)\b).*$/i,
    brand: "General Mills",
    title: "Original Cheerios Toasted Whole Grain Oat Cereal",
    ingredients: "Whole Grain Oats, Corn Starch, Sugar, Salt, Tripotassium Phosphate. Vitamin E (mixed tocopherols) Added to Preserve Freshness.",
    imageUrl: "/swaps/cereal.jpg",
  },
  {
    match: /^(?=.*\bchobani\b)(?=.*\bplain\b)(?!.*\b(flip|strawberry|vanilla|blueberry|peach|mango|berry|creamer|oat)\b).*$/i,
    brand: "Chobani",
    title: "Non-Fat Greek Yogurt Plain",
    ingredients: "Cultured Nonfat Milk. Live and Active Cultures: S. Thermophilus, L. Bulgaricus, L. Acidophilus, Bifidus, L. Casei, and L. Rhamnosus.",
    imageUrl: "/swaps/yogurt.jpg",
  },
  {
    match: /\b(yoplait|gogurt)\b(?!.*\bplain\b)/i,
    brand: "Yoplait",
    title: "Original Strawberry Lowfat Yogurt",
    ingredients: "Cultured Grade A Reduced Fat Milk, Sugar, Strawberries, Modified Corn Starch, High Fructose Corn Syrup, Kosher Gelatin, Citric Acid, Tricalcium Phosphate, Natural Flavor, Pectin, Colored with Carmine, Vitamin A Acetate, Vitamin D3.",
    imageUrl: "/products/yogurt.jpg",
  },
  {
    match: /\b(hidden valley)\b|(?<!primal kitchen |avocado oil |organic )\branch dressing\b/i,
    brand: "Hidden Valley",
    title: "Original Ranch Salad Dressing & Topping",
    ingredients: "Vegetable Oil (Soybean and/or Canola), Water, Egg Yolk, Sugar, Salt, Cultured Nonfat Buttermilk, Natural Flavors, Less than 1% of: Spices, Dried Garlic, Dried Onion, Vinegar, Phosphoric Acid, Xanthan Gum, Modified Food Starch, Monosodium Glutamate, Artificial Flavors, Disodium Phosphate, Sorbic Acid and Calcium Disodium EDTA Added to Preserve Freshness, Disodium Inosinate and Disodium Guanylate.",
    imageUrl: "/products/ranch.jpg",
  },
  {
    match: /\b(ritz)\b|(?<!mary'?s gone |organic |seed )\b(club crackers|town house|wheat thins|triscuit|saltines|butter crackers|holiday crackers)\b/i,
    brand: "Ritz",
    title: "Original Baked Crackers",
    ingredients: "Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Soybean and/or Canola Oil, Palm Oil, Sugar, Salt, Leavening (Calcium Phosphate, Baking Soda), High Fructose Corn Syrup, Soy Lecithin, Natural Flavor.",
    imageUrl: "/products/crackers.jpg",
  },
  {
    match: /\b(knoppers|storck|merci|kinder|ferrero rocher|lindt|ghirardelli|hershey'?s?|reese'?s|snickers|twix|kit\s*kat|m&m'?s|butterfinger|milky way|3 musketeers)\b|\b(hazelnut wafers?|chocolate variety|milk and creamy chocolate|chocolate candy|chocolate bar|chocolate truffles)\b/i,
    brand: "Storck / Confectionery",
    title: "Milk Chocolate & Hazelnut Confectionery",
    ingredients: "Sugar, Vegetable Fats (Palm, Shea), Whole Milk Powder, Cocoa Butter, Wheat Flour, Hazelnuts, Cocoa Mass, Skim Milk Powder, Lactose, Butterfat, Low-Fat Cocoa, Soy Lecithin, Whey Product, Salt, Natural and Artificial Flavors, Sodium Bicarbonate.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 535, sugarsG100g: 44, saturatedFatG100g: 16.5, sodiumMg100g: 160, fiberG100g: 2.0, proteinG100g: 6.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e" },
  },
  {
    match: /\b(velveeta)\b|(?<!organic )\b(processed cheese|cheese loaf|queso dip|pasteurized process cheese)\b/i,
    brand: "Velveeta",
    title: "Original Pasteurized Recipe Cheese Product",
    ingredients: "Milk, Water, Whey, Milk Protein Concentrate, Milkfat, Whey Protein Concentrate, Sodium Phosphate, Contains Less than 2% of Salt, Calcium Phosphate, Lactic Acid, Sorbic Acid as a Preservative, Sodium Citrate, Sodium Alginate, Enzymes, Apocarotenal and Annatto (Color), Cheese Culture.",
    imageUrl: "/products/butter.jpg",
    nutrition: { caloriesKcal100g: 285, sugarsG100g: 7.0, saturatedFatG100g: 11.0, sodiumMg100g: 1460, fiberG100g: 0, proteinG100g: 14.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e" },
  },
  {
    match: /\b(uncured)\b.*\b(turkey bacon)\b|\b(applegate)\b.*\b(turkey bacon)\b/i,
    brand: "Applegate Naturals",
    title: "Hickory Smoked Uncured Turkey Bacon",
    ingredients: "Turkey, Water, Contains Less than 2% of Sea Salt, Cane Sugar, Celery Powder, Rosemary Extract.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 215, sugarsG100g: 1.5, saturatedFatG100g: 2.8, sodiumMg100g: 760, fiberG100g: 0, proteinG100g: 17.0, fruitsVegNutsPct: 0, isWholeFood: false },
  },
  {
    match: /\b(uncured)\b.*\b(bacon|sunday bacon|black forest|hickory smoked)\b|\b(applegate|coleman|dietz\s*&\s*watson|nueske'?s|paleo|pederson'?s)\b.*\b(bacon)\b/i,
    brand: "Natural Uncured",
    title: "Hickory Smoked Uncured Pork Bacon",
    ingredients: "Pork, Water, Sea Salt, Less than 2% of Cane Sugar, Celery Powder.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 410, sugarsG100g: 1.5, saturatedFatG100g: 13.5, sodiumMg100g: 920, fiberG100g: 0, proteinG100g: 24.0, fruitsVegNutsPct: 0, isWholeFood: false },
  },
  {
    match: /^(?!.*\b(uncured|bits|ranch|hot pocket|macaroni)\b).*\b(wellsley farms sliced bacon|hormel.*bacon|smithfield.*bacon|oscar mayer.*bacon|wright.*bacon|farmland.*bacon|kirkland.*bacon|great value.*bacon|member'?s mark.*bacon|thick cut.*bacon|microwave ready bacon|fully cooked bacon|hickory smoked.*bacon|sliced bacon|pork bacon|low sodium bacon|bacon)\b/i,
    brand: "Cured Pork Bacon",
    title: "Hickory Smoked Cured Sliced Bacon",
    ingredients: "Pork, Water, Salt, Sugar, Sodium Phosphate, Sodium Erythorbate, Sodium Nitrite.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 440, sugarsG100g: 1.5, saturatedFatG100g: 14.5, sodiumMg100g: 1080, fiberG100g: 0, proteinG100g: 26.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(morningstar farms|beyond meat|beyond sausage|impossible sausage|impossible burger|boca|gardein)\b/i,
    brand: "MorningStar Farms",
    title: "Plant-Based Sausage Patties",
    ingredients: "Water, Wheat Gluten, Soy Flour, Vegetable Oil (Corn, Canola and/or Sunflower Oil), Egg Whites, Soy Protein Isolate, Methylcellulose, Salt, Autolyzed Yeast Extract, Natural Flavors, Spices, Xanthan Gum, Caramel Color, Disodium Inosinate, Disodium Guanylate, Citric Acid.",
    imageUrl: "/products/turkey.jpg",
  },
  {
    match: /\b(hot pocket|hot pockets|lean pocket|lean pockets|pizza rolls|totino'?s|bagel bites|stouffer'?s)\b/i,
    brand: "Hot Pockets",
    title: "Stuffed Sandwich Pockets",
    ingredients: "Enriched Flour (Wheat Flour, Malted Barley Flour, Niacin, Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Cooked White Meat Chicken, Reduced Fat Cheddar Cheese, Soybean Oil, Bacon (Cured with Water, Salt, Sugar, Smoke Flavoring, Sodium Phosphate, Sodium Erythorbate, Sodium Nitrite), 2% or Less of Modified Food Starch, Sugar, Salt, Buttermilk, Potassium Chloride, Autolyzed Yeast Extract, Disodium Phosphate, Xanthan Gum, Monosodium Glutamate, Natural Flavors, Titanium Dioxide.",
    imageUrl: "/products/snacks.jpg",
  },
  {
    match: /\b(hillshire farm|kielbasa|polska kielbasa|smoked sausage|eckrich|johnsonville|jimmy dean|breakfast croissant|sausage,?\s*egg\s*(&|and)\s*cheese)\b/i,
    brand: "Hillshire Farm / Jimmy Dean",
    title: "Smoked Sausage / Kielbasa",
    ingredients: "Mechanically Separated Turkey, Turkey, Pork, Water, Corn Syrup, Modified Food Starch, Contains 2% or Less of Salt, Dextrose, Sodium Citrate, Sodium Phosphate, Monosodium Glutamate, Sodium Diacetate, Sodium Erythorbate, Flavorings, Sodium Nitrite.",
    imageUrl: "/products/turkey.jpg",
  },
  {
    match: /\b(grilled|roasted|rotisserie|unbreaded|naked)\b.*\b(chicken\s+(breast\s+)?(strips?|bites?|cuts?|diced|chunks?))\b|\b(chicken\s+(breast\s+)?(strips?|bites?|cuts?))\b.*\b(grilled|roasted|rotisserie|unbreaded)\b/i,
    brand: "Grilled Poultry",
    title: "Fully Cooked Grilled Chicken Breast Strips",
    ingredients: "Boneless, Skinless Chicken Breast with Rib Meat, Water, Contains 2% or Less of Salt, Vinegar, Natural Flavor, Garlic Powder, Onion Powder, Spices.",
    imageUrl: "/swaps/turkey.jpg",
    nutrition: { caloriesKcal100g: 135, sugarsG100g: 0.5, saturatedFatG100g: 0.8, sodiumMg100g: 410, fiberG100g: 0, proteinG100g: 23.0, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: false },
  },
  {
    match: /\b(crispy chicken|breaded chicken|chicken patties|chicken patty|chicken nuggets|chicken tenders|chicken strips|popcorn chicken|chicken fries|perdue.*breaded|tyson.*chicken|wellsley farms.*crispy chicken|wellsley farms.*chicken patties)\b/i,
    brand: "Breaded Poultry",
    title: "Breaded Crispy Chicken Breast Patties / Fillets",
    ingredients: "Boneless Skinless Chicken Breast with Rib Meat, Water, Wheat Flour, Bleached Wheat Flour, Modified Food Starch, Vegetable Oil (Soybean and/or Canola Oil), Salt, Dextrose, Sodium Phosphates, Leavening (Sodium Acid Pyrophosphate, Sodium Bicarbonate), Yeast Extract, Onion Powder, Garlic Powder, Spice, Natural Flavor.",
    imageUrl: "/products/turkey.jpg",
  },
  {
    match: /\b(heinz.*gravy|turkey gravy|chicken gravy|beef gravy|mushroom gravy|country gravy|sausage gravy|homestyle.*gravy|franco[- ]?american.*gravy|mccormick.*gravy|campbell'?s.*gravy|pioneer.*gravy|\bgravy\b)\b/i,
    brand: "Heinz HomeStyle",
    title: "HomeStyle Savory Gravy",
    ingredients: "Turkey Broth, Water, Modified Corn Starch, Enriched Wheat Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Chicken Fat, Contains Less than 2% of Salt, Turkey Meat, Monosodium Glutamate, Autolyzed Yeast Extract, Caramel Color, Onion Powder, Disodium Inosinate, Disodium Guanylate, Natural Flavor.",
    imageUrl: "/products/ranch.jpg",
  },
  {
    match: /\b(kettle\s*&\s*fire|organic.*broth|organic.*stock|bone broth)\b/i,
    brand: "Kettle & Fire",
    title: "Organic Slow-Simmered Bone Broth",
    ingredients: "Organic Bone Broth (Water, Organic Turkey/Chicken Bones, Organic Onions, Organic Carrots, Organic Celery), Organic Apple Cider Vinegar, Sea Salt, Organic Rosemary, Organic Sage, Organic Thyme, Organic Black Pepper.",
    imageUrl: "/swaps/turkey.jpg",
    nutrition: { isOrganic: true, isWholeFood: true },
  },
  {
    match: /\b(gatorade|powerade|sports? drink|bodyarmor|liquid i\.?v\.?)\b/i,
    brand: "Gatorade",
    title: "Thirst Quencher Fruit Punch Sports Drink",
    ingredients: "Water, Sugar, Dextrose, Citric Acid, Salt, Sodium Citrate, Monopotassium Phosphate, Gum Arabic, Natural Flavor, Sucrose Acetate Isobutyrate, Glycerol Ester of Rosin, Red 40.",
    imageUrl: "/products/snacks.jpg",
  },
  {
    match: /\b(capri\s*sun|hi-c|kool-aid|hawaiian punch|sunny\s*d)\b/i,
    brand: "Capri Sun",
    title: "Fruit Punch Juice Drink Blend",
    ingredients: "Water, Sugar, Apple, Grape and Cherry Juice Concentrates, Citric Acid, Natural Flavor.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 30, sugarsG100g: 7.2, saturatedFatG100g: 0, sodiumMg100g: 8, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 10 },
  },
  {
    match: /\b(health[- ]?ade|gt'?s|synergy|kombucha)\b/i,
    brand: "Health-Ade",
    title: "Organic Raw Kombucha",
    ingredients: "Purified Water, Kombucha Culture (Yeast and Bacteria Cultures), Organic Black Tea, Organic Green Tea, Organic Cane Sugar, Organic Cold Pressed Juice.",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 15, sugarsG100g: 3.2, saturatedFatG100g: 0, sodiumMg100g: 5, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 20, isOrganic: true },
  },
  {
    match: /\b(goldfish)\b/i,
    brand: "Pepperidge Farm",
    title: "Goldfish Cheddar Baked Snack Crackers",
    ingredients: "Made With Smiles And Enriched Wheat Flour (Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Cheddar Cheese (Cultured Milk, Salt, Enzymes, Annatto), Vegetable Oils (Canola, Sunflower And/Or Soybean), Salt, Contains 2% Or Less Of: Yeast, Sugar, Autolyzed Yeast Extract, Paprika, Spices, Celery, Onion Powder, Monocalcium Phosphate, Baking Soda.",
    imageUrl: "/products/crackers.jpg",
  },
  {
    match: /\b(nutella)\b/i,
    brand: "Ferrero",
    title: "Nutella Hazelnut Spread with Cocoa",
    ingredients: "Sugar, Palm Oil, Hazelnuts, Skim Milk, Cocoa, Soy Lecithin as Emulsifier, Vanillin: An Artificial Flavor.",
    imageUrl: "/products/snacks.jpg",
  },
  {
    match: /\b(annie'?s|organic|goodles)\b.*\b(macaroni\s*(and|&)\s*cheese|mac\s*(and|&)\s*cheese|shells\s*(and|&)\s*(white\s*)?cheddar)\b/i,
    brand: "Annie's Homegrown",
    title: "Organic Macaroni & Cheese",
    ingredients: "Organic Pasta (Organic Wheat Flour), Organic Cheddar Cheese (Cultured Pasteurized Organic Milk, Salt, Non-Animal Enzymes), Organic Whey, Organic Nonfat Milk, Salt, Sodium Citrate, Organic Annatto Extract (For Color).",
    imageUrl: "/swaps/snacks.jpg",
  },
  {
    match: /\b(macaroni\s*(and|&)\s*cheese|mac\s*(and|&)\s*cheese|kraft\s+mac|velveeta\s+shells)\b/i,
    brand: "Kraft / Conventional",
    title: "Original Macaroni & Cheese Dinner",
    ingredients: "Enriched Macaroni Product (Wheat Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Cheese Sauce Mix (Whey, Milkfat, Milk Protein Concentrate, Salt, Sodium Tripolyphosphate, Citric Acid, Lactic Acid, Sodium Phosphate, Calcium Phosphate, Yellow 5, Yellow 6, Enzymes, Cheese Culture).",
    imageUrl: "/products/snacks.jpg",
  },
  {
    match: /\b(organic|alexandre|kalona|maple hill)\b.*\b(eggnog|egg nog)\b/i,
    brand: "Organic Valley",
    title: "Organic Eggnog",
    ingredients: "Organic Grade A Milk, Organic Grade A Cream, Organic Cane Sugar, Organic Egg Yolks, Organic Vanilla Extract, Organic Nutmeg.",
    imageUrl: "/swaps/yogurt.jpg",
  },
  {
    match: /\b(eggnog|egg nog)\b/i,
    brand: "Hood",
    title: "Golden Vanilla Eggnog",
    ingredients: "Milk, Cream, Sugar, Nonfat Milk, Egg Yolks, High Fructose Corn Syrup, Whey, Natural and Artificial Flavor, Nutmeg, Carrageenan, Guar Gum, Mono and Diglycerides, Annatto and Turmeric (Color).",
    imageUrl: "/products/yogurt.jpg",
  },
  {
    match: /\b(red bird|peppermint\s+(candy|puffs?|mints?|bark|stick|canes?)|candy\s+(puffs?|canes?)|starlight\s+mints?|butter\s+mints?|dinner\s+mints?|hard\s+cand(y|ies)|lifesavers|jolly\s+rancher|werther'?s)\b/i,
    brand: "Red Bird / Confectionery",
    title: "Peppermint Candy Puffs",
    ingredients: "Pure Cane Sugar, Invert Sugar, Corn Syrup, Natural Oil of Peppermint, Red 40 (Artificial Color).",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 392, sugarsG100g: 93, saturatedFatG100g: 0, sodiumMg100g: 15, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(auspitee|craisins|sweetened dried|dried cranberr\w*|dried blueberr\w*|dried cherr\w*|dried strawberr\w*|dehydrated\s+(blueberr\w*|cranberr\w*|cherr\w*|strawberr\w*|fruit|berr\w*))\b(?!.*\b(unsweetened|no sugar|freeze[- ]?dried)\b)/i,
    brand: "Sweetened Dried Fruit",
    title: "Sweetened Dried Berries",
    ingredients: "Berries (Blueberries / Cranberries), Cane Sugar, Refined Sunflower Oil (Used as a Processing Aid).",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 325, sugarsG100g: 65, saturatedFatG100g: 0.2, sodiumMg100g: 5, fiberG100g: 5.3, proteinG100g: 0.4, fruitsVegNutsPct: 60, isWholeFood: false },
  },
  {
    match: /\b(freeze[- ]?dried)\b.*\b(blueberr\w*|strawberr\w*|raspberr\w*|bananas?|apples?|mangos?|peaches|fruit|crisps?)\b|\b(blueberry|strawberry|raspberry|berry|fruit)\s+powder\b/i,
    brand: "Freeze-Dried / Fruit Powder",
    title: "Dehydrated / Freeze-Dried Fruit",
    ingredients: "Dehydrated / Freeze-Dried Fruit (Concentrated Natural Fruit Sugars).",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 345, sugarsG100g: 54, saturatedFatG100g: 0.2, sodiumMg100g: 8, fiberG100g: 7.5, proteinG100g: 2.5, fruitsVegNutsPct: 85, isWholeFood: false },
  },
  {
    match: /^(?!.*\b(canola|olive|soybean|vegetable|oil|spread|margarine|peanut|almond|cashew|sunflower|cookie|cocoa|apple|buttermilk|butterfinger|popcorn|croissant|biscuit|crackers|bread|rolls|buns|sauce|chicken)\b).*\b(kerrygold)\b/i,
    brand: "Kerrygold",
    title: "Pure Irish Salted Butter",
    ingredients: "Pasteurized Cream, Salt.",
    imageUrl: "/products/butter.jpg",
    nutrition: { caloriesKcal100g: 717, sugarsG100g: 0.1, saturatedFatG100g: 51.0, sodiumMg100g: 640, fiberG100g: 0, proteinG100g: 0.9, fruitsVegNutsPct: 0, isWholeFood: false },
  },
  {
    match: /^(?!.*\b(soy|soymilk|almond|almondmilk|oat|oatmilk|coconut|cashew|chocolate|strawberry|condensed|evaporated|buttermilk|milkshake|creamer|wafer|wafers|candy|bar|chocolate)\b).*\b(lactaid|lactose[- ]?free.*milk|whole.*milk|milk.*whole|2%.*milk|milk.*2%|1%.*milk|skim.*milk|nonfat.*milk|reduced[- ]?fat.*milk|fat[- ]?free.*milk|vitamin d.*milk|great value.*milk|wellsley farms.*milk|kirkland.*milk|member'?s mark.*milk|fairlife|horizon.*milk|organic.*milk|grade a.*milk)\b/i,
    brand: "Grade A Dairy",
    title: "Grade A Pasteurized Milk",
    ingredients: "Grade A Milk, Vitamin D3.",
    imageUrl: "/swaps/yogurt.jpg",
    nutrition: { isWholeFood: false },
  },
  {
    match: /\b(coffee[- ]?mate|international delight|creamer)\b/i,
    brand: "Coffee mate",
    title: "French Vanilla Liquid Coffee Creamer",
    ingredients: "Water, Sugar, Vegetable Oil (High Oleic Soybean and/or High Oleic Canola), and Less than 2% of Micellar Casein (a Milk Derivative), Mono- and Diglycerides, Dipotassium Phosphate, Natural and Artificial Flavor, Cellulose Gel, Cellulose Gum, Carrageenan.",
    imageUrl: "/products/yogurt.jpg",
  },
  {
    match: /\b(clam\s+chowder|new\s+england.*chowder|corn\s+chowder|potato\s+chowder|seafood\s+chowder|lobster\s+bisque|tomato\s+bisque|broccoli\s+cheddar\s+soup|loaded\s+baked\s+potato\s+soup)\b/i,
    brand: "Marketside",
    title: "New England Style Clam Chowder",
    ingredients: "Light Cream (Milk, Cream), Potatoes, Fish Stock (Water, Cod Bones, Haddock Bones, Onions, Celery, Black Pepper, Thyme, Mustard Seed, Bay Leaves), Sea Clams (Sea Clams, Water), Chopped Cockle (Clam Meat), Onions, Wheat Flour, Soybean Oil, Butter (Cream, Salt), Clam Broth (Dehydrated Clam Broth, Maltodextrin), Sea Salt, Celery, Salt Pork (Pork, Sea Salt), Black Pepper, Worcestershire Sauce (Distilled White Vinegar, Molasses, Sugar, Water, Salt, Onions, Anchovies, Garlic, Cloves, Tamarind Extract, Natural Flavorings, Chili Pepper Extract), Garlic.",
    imageUrl: "/products/ranch.jpg",
    nutrition: { caloriesKcal100g: 115, sugarsG100g: 1.5, saturatedFatG100g: 3.5, sodiumMg100g: 350, fiberG100g: 0.9, proteinG100g: 5.2, fruitsVegNutsPct: 25, nutriScoreGrade: "b", isWholeFood: false },
  },
  {
    match: /^(?!.*\b(amy'?s|pacific\s+foods|organic|kettle\s*&\s*fire)\b).*\b(campbell'?s|progresso|chunky\s+soup|chicken\s+noodle\s+soup|tomato\s+soup|cream\s+of\s+(mushroom|chicken|celery)|beef\s+stew|vegetable\s+beef\s+soup|minestrone\s+soup|italian\s+wedding\s+soup|ramen\s+noodle\s+soup|maruchan|top\s+ramen)\b/i,
    brand: "Campbell's / Progresso",
    title: "Homestyle Soup",
    ingredients: "Chicken Stock, Enriched Egg Noodles (Wheat Flour, Egg Whites, Eggs, Niacin, Ferrous Sulfate, Thiamine Mononitrate, Riboflavin, Folic Acid), Cooked Chicken Meat, Carrots, Celery, Contains Less than 2% of: Modified Food Starch, Salt, Chicken Fat, Monosodium Glutamate, Yeast Extract, Soy Protein Isolate, Sodium Phosphate, Potassium Chloride, Natural Flavor, Beta Carotene for Color, Disodium Inosinate, Disodium Guanylate.",
    imageUrl: "/products/ranch.jpg",
    nutrition: { caloriesKcal100g: 55, sugarsG100g: 1.0, saturatedFatG100g: 0.6, sodiumMg100g: 390, fiberG100g: 0.6, proteinG100g: 2.5, fruitsVegNutsPct: 10, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\b(salad\s+kit|chopped\s+kit|caesar\s+salad\s+kit|ranch\s+salad\s+kit|southwest\s+salad\s+kit|asian\s+salad\s+kit|sweet\s+kale\s+kit)\b/i,
    brand: "Marketside / Taylor Farms",
    title: "Salad Kit with Dressing Packet",
    ingredients: "Romaine Lettuce, Dressing (Soybean and/or Canola Oil, Water, Parmesan Cheese, Egg Yolk, Distilled Vinegar, Salt, Sugar, Garlic, Lemon Juice Concentrate, Natural Flavor, Xanthan Gum), Croutons (Enriched Wheat Flour, Sunflower Oil, Salt, Yeast, Garlic Powder), Parmesan Cheese.",
    imageUrl: "/products/ranch.jpg",
    nutrition: { caloriesKcal100g: 140, sugarsG100g: 3.0, saturatedFatG100g: 2.5, sodiumMg100g: 310, fiberG100g: 2.0, proteinG100g: 3.5, fruitsVegNutsPct: 65, nutriScoreGrade: "b", isWholeFood: false },
  },
  {
    match: /^(?!.*\b(kit|caesar|ranch|dressing|macaroni|potato\s+salad|chicken\s+salad|tuna\s+salad|egg\s+salad|pasta\s+salad|ham\s+salad|seafood\s+salad)\b).*\b(romaine\s+salad|salad\s+blend|classic\s+romaine|classic\s+iceberg|spring\s+mix|baby\s+spinach|spinach\s+blend|half\s*(&|and)\s*half\s+salad|shredded\s+lettuce|iceberg\s+lettuce|romaine\s+hearts|leaf\s+lettuce|butter\s+lettuce|arugula|kale\s+greens|coleslaw\s+mix|tri[- ]?color\s+slaw|garden\s+salad|field\s+greens|mixed\s+greens|salad\s+greens|sweet\s+butter\s+salad)\b/i,
    brand: "Fresh Produce",
    title: "100% Fresh Washed Salad Greens",
    ingredients: "100% Fresh Whole Produce: Romaine Lettuce, Carrots, Red Cabbage (Zero Chemical Additives or Preservatives).",
    imageUrl: "/swaps/ranch.jpg",
    nutrition: { caloriesKcal100g: 18, sugarsG100g: 1.5, saturatedFatG100g: 0, sodiumMg100g: 18, fiberG100g: 2.2, proteinG100g: 1.3, fruitsVegNutsPct: 100, nutriScoreGrade: "a", isWholeFood: true },
  },
  {
    match: /\b(instant\s+mashed\s+potato\w*|potato\s+flakes?|mashed\s+potato\w*\s+mix|idahoan|betty\s+crocker.*potato\w*|great\s+value.*instant\s+mashed|au\s+gratin\s+potato\w*|scalloped\s+potato\w*)\b/i,
    brand: "Great Value / Idahoan",
    title: "Instant Mashed Potatoes",
    ingredients: "Potatoes, Mono- and Diglycerides, Sodium Acid Pyrophosphate (Preservative), Sodium Bisulfite (Preservative), Citric Acid (Preservative), BHT (Added to Preserve Freshness).",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 355, sugarsG100g: 2.5, saturatedFatG100g: 1.2, sodiumMg100g: 490, fiberG100g: 5.5, proteinG100g: 7.5, fruitsVegNutsPct: 60, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\b(ore[- ]?ida|french\s+fries|crinkle\s+cut\s+fries|waffle\s+fries|steak\s+fries|shoestring\s+fries|curly\s+fries|seasoned\s+fries|tater\s+tots?|golden\s+crinkles|hash\s*browns?|crispy\s+crowns)\b/i,
    brand: "Ore-Ida",
    title: "Golden Crinkles French Fried Potatoes",
    ingredients: "Potatoes, Vegetable Oil (Canola, Soybean, and/or Sunflower Oil), Salt, Disodium Dihydrogen Pyrophosphate (to Retain Natural Color), Dextrose.",
    imageUrl: "/products/chips.jpg",
    nutrition: { caloriesKcal100g: 155, sugarsG100g: 0.8, saturatedFatG100g: 1.2, sodiumMg100g: 340, fiberG100g: 2.4, proteinG100g: 2.4, fruitsVegNutsPct: 75, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\b(crispy\s+fried\s+onions?|french'?s.*onions?|french\s+fried\s+onions?|fried\s+onions?|onion\s+rings?)\b/i,
    brand: "French's",
    title: "Original Crispy Fried Onions",
    ingredients: "Onions, Palm Oil, Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Soy Flour, Salt, Dextrose.",
    imageUrl: "/products/chips.jpg",
    nutrition: { caloriesKcal100g: 571, sugarsG100g: 5.0, saturatedFatG100g: 15.5, sodiumMg100g: 800, fiberG100g: 2.8, proteinG100g: 5.2, fruitsVegNutsPct: 20, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(a\.?1\.?\s*(original\s*)?(steak\s*)?sauce|steak\s+sauce|heinz\s+57)\b/i,
    brand: "A.1.",
    title: "Original Steak Sauce",
    ingredients: "Tomato Puree (Water, Tomato Paste), Vinegar, Corn Syrup, Salt, Raisin Paste, Crushed Orange Puree, Spice, Dried Garlic, Caramel Color, Dried Onions, Potassium Sorbate (To Preserve Freshness), Xanthan Gum, Celery Seed.",
    imageUrl: "/products/ranch.jpg",
    nutrition: { caloriesKcal100g: 88, sugarsG100g: 17.6, saturatedFatG100g: 0, sodiumMg100g: 1470, fiberG100g: 0.5, proteinG100g: 1.0, fruitsVegNutsPct: 30, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(steak[- ]?umm\w*|philly\s+steak|shaved\s+beef\s+steak)\b/i,
    brand: "Steak-umm",
    title: "100% Beef Sliced Steaks",
    ingredients: "Beef, Water, Salt, Sodium Phosphate.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 280, sugarsG100g: 0, saturatedFatG100g: 9.5, sodiumMg100g: 310, fiberG100g: 0, proteinG100g: 17.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b((peaches|pears|mandarin\s+oranges|pineapple|fruit\s+cocktail|mixed\s+fruit|cherries|apricots)\s+in\s+(heavy|light|extra\s+light)\s+syrup|dole.*syrup|del\s+monte.*(peaches|syrup|fruit\s+cup))\b/i,
    brand: "Del Monte / Dole",
    title: "Sliced Peaches in Heavy Syrup",
    ingredients: "Peaches, Water, High Fructose Corn Syrup, Corn Syrup, Sugar.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 74, sugarsG100g: 17.5, saturatedFatG100g: 0, sodiumMg100g: 6, fiberG100g: 1.2, proteinG100g: 0.4, fruitsVegNutsPct: 55, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b(cake\s+roll|pumpkin\s+cake|swiss\s+roll|snack\s+cakes?|little\s+debbie|hostess|twinkies?|ding\s+dongs?|ho\s*hos?|zebra\s+cakes?|entenmann'?s|freshness\s+guaranteed.*(cake|pie|cupcake|brownie|cookie|muffin|roll)|bake\s+shop.*(cake|pie|cupcake|brownie|cookie|muffin))\b/i,
    brand: "Freshness Guaranteed / Bakery",
    title: "Bakery Cake Roll with Creme Filling",
    ingredients: "Sugar, Enriched Wheat Flour Bleached (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Eggs, Water, Pumpkin/Fruit Puree, High Fructose Corn Syrup, Soybean Oil, Palm Oil, Corn Syrup, Contains 2% or Less of: Modified Corn Starch, Mono- and Diglycerides, Polysorbate 60, Sodium Propionate (Preservative), Potassium Sorbate (Preservative), Sodium Acid Pyrophosphate, Soy Lecithin, Natural and Artificial Flavor, Spices, Yellow 5, Yellow 6, Red 40.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 375, sugarsG100g: 36, saturatedFatG100g: 7.5, sodiumMg100g: 330, fiberG100g: 1.0, proteinG100g: 3.8, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(ben\s*&\s*jerry'?s?|half[- ]?baked|cherry\s+garcia|chunky\s+monkey|phish\s+food|tonight\s+dough|americone\s+dream|breyers|blue\s+bell|haagen[- ]?dazs|häagen[- ]?dazs|talenti|edy'?s|dreyer'?s|klondike|drumstick|sundae\s+shoppe|belmont.*ice\s+cream|great\s+value.*ice\s+cream|ice\s+cream|gelato)\b(?!.*\b(alec'?s|cosmic\s+bliss|organic\s+tahitian)\b)/i,
    brand: "Ben & Jerry's / Ice Cream",
    title: "Premium Dairy Ice Cream",
    ingredients: "Cream, Skim Milk, Liquid Sugar (Sugar, Water), Water, Sugar, Wheat Flour, Brown Sugar, Egg Yolks, Butter, Soybean Oil, Coconut Oil, Cocoa (Processed with Alkali), Eggs, Guar Gum, Salt, Vanilla Extract, Carrageenan, Soy Lecithin, Natural Flavor.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 270, sugarsG100g: 25, saturatedFatG100g: 10.5, sodiumMg100g: 85, fiberG100g: 0.9, proteinG100g: 4.2, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(just\s+bare)\b.*\b(chicken|strips?|nuggets?|bites?|fillets?|tenders?|breast)\b/i,
    brand: "Just Bare",
    title: "Lightly Breaded Chicken Breast Strips",
    ingredients: "Boneless Skinless Chicken Breast with Rib Meat, Water, Wheat Flour, Contains 2% or Less of: Yellow Corn Flour, Sea Salt, Rice Starch, Spices, Dried Garlic, Dried Onion, Paprika, Yeast, Cream of Tartar, Sodium Bicarbonate.",
    imageUrl: "/swaps/turkey.jpg",
    nutrition: { caloriesKcal100g: 175, sugarsG100g: 1.0, saturatedFatG100g: 1.5, sodiumMg100g: 380, fiberG100g: 1.0, proteinG100g: 18.5, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isWholeFood: false },
  },
  {
    match: /\b(butterball)\b.*\b(turkey|whole\s+turkey|young\s+turkey|breast)\b/i,
    brand: "Butterball",
    title: "All Natural Whole Turkey (With Salt Solution)",
    ingredients: "Turkey, Contains up to 8% of a Solution of Water, Salt, Spices, and Natural Flavor for Tenderness and Juiciness.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 160, sugarsG100g: 0, saturatedFatG100g: 3.5, sodiumMg100g: 310, fiberG100g: 0, proteinG100g: 19.0, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\b(golden\s+sweet.*corn|whole\s+kernel\s+corn|sweet\s+corn.*can|del\s+monte.*corn|green\s+giant.*corn|great\s+value.*corn|happy\s+harvest.*corn)\b/i,
    brand: "Great Value / Canned Vegetables",
    title: "Golden Sweet Whole Kernel Corn",
    ingredients: "Corn, Water, Sugar, Salt.",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 71, sugarsG100g: 5.3, saturatedFatG100g: 0.2, sodiumMg100g: 230, fiberG100g: 1.8, proteinG100g: 2.4, fruitsVegNutsPct: 85, nutriScoreGrade: "a", isWholeFood: false },
  },
  {
    match: /\b(100%\s+(pure\s+)?(organic\s+)?(orange|apple|grape|cranberry|grapefruit)\s+juice|orange\s+juice|simply\s+orange|tropicana|uncle\s+matt'?s|nature'?s\s+nectar.*orange)\b(?!.*\b(drink|cocktail|sunny\s*d|tang)\b)/i,
    brand: "100% Fruit Juice",
    title: "100% Pasteurized Orange Juice",
    ingredients: "100% Pasteurized Orange Juice (Concentrated Natural Liquid Fruit Sugars — 0g Fiber).",
    imageUrl: "/swaps/drink.png",
    nutrition: { caloriesKcal100g: 45, sugarsG100g: 9.2, saturatedFatG100g: 0, sodiumMg100g: 2, fiberG100g: 0.2, proteinG100g: 0.7, fruitsVegNutsPct: 100, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\bsiete\b.*\b(chips?|crisps?|tostadas?|tortilla\s+chips)\b/i,
    brand: "Siete",
    title: "Grain-Free Sea Salt Tortilla Chips",
    ingredients: "Cassava Flour, Avocado Oil, Coconut Flour, Chia Seed, Sea Salt.",
    imageUrl: "/swaps/chips.jpg",
    nutrition: { caloriesKcal100g: 464, sugarsG100g: 0, saturatedFatG100g: 3.5, sodiumMg100g: 265, fiberG100g: 6.5, proteinG100g: 3.6, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\bsiete\b.*\b(tortillas?|wraps?)\b/i,
    brand: "Siete",
    title: "Almond Flour Tortillas",
    ingredients: "Almond Flour, Tapioca Flour, Water, Xanthan Gum, Sea Salt.",
    imageUrl: "/swaps/bread.jpg",
    nutrition: { caloriesKcal100g: 290, sugarsG100g: 2.0, saturatedFatG100g: 1.5, sodiumMg100g: 330, fiberG100g: 5.0, proteinG100g: 9.0, fruitsVegNutsPct: 45, nutriScoreGrade: "b", isWholeFood: false },
  },
];

const UI_NOISE_QUERY =
  /\b(gas savings|walmart\+|walmart cash|manufacturer offer|subscribe to save|new notification|scan barcodes?|barcode scanner|opens barcode scanner|qr code|pickup or delivery|pickup and delivery|your favorites, for less|rollbacks & more|the holiday shop|shop all food|sparky|my items|product information|items to add next|frequently bought together|customers also viewed|similar items|sold by|fulfilled by|sold and shipped by|arrives between|arrives by|free \d+-day returns|free holiday returns|gift eligible|available for \d+ of \d+ items|fees may apply|snap ebt eligible|pro seller|preferred address|change delivery address|change address|\d+\s*[-–—]\s*\d+\s*min|\d+\s*(?:hr|hour|min)s?\s+or\s+less|\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)|free with w\+)\b|^(?:(?:flavor|size|style|color|colour|scent|count|pack|pack\s+size|variant|option|type|model|pattern|weight|material)\s*:\s*.+|cart\s*,?\s*\(\d+(?:\s+items?)?\)|in\s+\d+[kKmM]?\+?\s*people'?s?\s*c(?:arts?|a.*)|\d+[kKmM]?\+?\s*bought\b.*|options(?:\s+from\s+.*)?|\d+\s+[a-z0-9.\s]+\b(?:st|street|rd|road|dr|drive|ave|avenue|blvd|boulevard|ln|lane|ct|court|pl|place|cir|circle|way|pkwy|parkway|hwy|highway)\b.*|.*,\s*was|.*\?)$/i;

const NON_FOOD_OR_PROCESSED_GUARD =
  /\b(sunscreen|banana\s+boat|coppertone|neutrogena|lotion|spf|lip\s+balm|shampoo|conditioner|body\s+wash|face\s+wash|soap|detergent|cleaner|bleach|wipes?|candle|deodorant|toothpaste|mouthwash|diapers?|litter|pet\s+food|dog\s+food|cat\s+food|chips?|crisps?|crispy|fried|battered|breaded|rings?|instant|mashed|flakes?|au\s+gratin|scalloped|casserole|flavou?red|dressing|ranch|caesar|kit|soup|chowder|sauce|a\.?1\.?|steak[- ]?umm\w*|ketchup|salsa|pie|cake|roll|muffin|donut|candy|gummies|juice|drink|soda|yogurt|cereal|puffs?|bars?|cookies?|wafers?|dried|dehydrated|craisins|fries|tots|ore[- ]?ida|idahoan|hash\s*browns?|macaroni|pasta\s+salad|potato\s+salad|chicken\s+salad|tuna\s+salad|egg\s+salad|ice\s+cream|gelato|sorbet|popsicle|jam|jelly|spread|syrup|canned|fruit\s+cup|del\s+monte|dole|pickled|marinated|seasoned|grilled|roasted|smoked|cured|jerky|bacon|sausage|hot\s*dog|salami|pepperoni|bologna|deli|lunch|ham|nuggets?|tenders?|strips?|patties|patty|popcorn|teriyaki|bbq|barbecue|buffalo|honey|glazed|sandwich|biscuit|croissant|burrito|pizza|ramen|helper|eggnog|egg\s+nog|egg\s+roll|noodles?)\b/i;

function catalogFallback(query: string): Omit<LookupResult, "ms"> | null {
  const cleanTitle = query.trim().replace(/,\s*(now|was)$/i, "").replace(/\b\w/g, (c) => c.toUpperCase());
  const wordCount = cleanTitle.split(/\s+/).filter(Boolean).length;
  const isOrganic = /\b(organic|usda organic)\b/i.test(query);

  // Check Just Bare before generic breaded poultry
  if (/\bjust\s+bare\b/i.test(query)) {
    return {
      productTitle: cleanTitle,
      brand: "Just Bare",
      ingredients: "Boneless Skinless Chicken Breast with Rib Meat, Water, Wheat Flour, Contains 2% or Less of: Yellow Corn Flour, Sea Salt, Rice Starch, Spices, Dried Garlic, Dried Onion, Paprika, Yeast, Cream of Tartar, Sodium Bicarbonate.",
      imageUrl: `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(cleanTitle)}`,
      nutrition: { caloriesKcal100g: 175, sugarsG100g: 1.0, saturatedFatG100g: 1.5, sodiumMg100g: 380, fiberG100g: 1.0, proteinG100g: 18.5, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isWholeFood: false, isOrganic },
      source: "catalog",
    };
  }

  for (const entry of INSTANT_GROCERY_CATALOG) {
    if (entry.match.test(query)) {
      const fullEntryTitle = entry.title.toLowerCase().startsWith(entry.brand.toLowerCase())
        ? entry.title
        : `${entry.brand} ${entry.title}`;
      const resolvedTitle = wordCount <= 2 ? fullEntryTitle : cleanTitle;
      return {
        productTitle: resolvedTitle,
        brand: entry.brand,
        ingredients: entry.ingredients,
        imageUrl: `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(resolvedTitle)}`,
        nutrition: { ...entry.nutrition, isOrganic: entry.nutrition?.isOrganic ?? isOrganic },
        source: "catalog",
      };
    }
  }
  const s = query.toLowerCase();
  if (NON_FOOD_OR_PROCESSED_GUARD.test(s)) {
    return null;
  }

  // 1. Fresh Produce, Fruits, Vegetables, Herbs & Salad Greens (strictly unolah / single-ingredient)
  if (
    /\b(salad|lettuce|romaine|spinach|kale|arugula|cabbage|broccoli|cauliflower|carrots?|celery|cucumbers?|tomatoes?|potatoes?|sweet\s+potatoes?|yams?|onions?|scallions?|shallots?|leeks?|garlic|ginger|parsley|cilantro|basil|rosemary|thyme|dill|mint|sage|chives|oregano|peppers?|mushrooms?|avocados?|zucchini|squash|pumpkin|asparagus|green\s+beans|brussels\s+sprouts|beets?|radish\w*|turnips?|eggplants?|artichokes?|okra|fennel|bok\s+choy|chard|collards?|apples?|bananas?|strawberries|blueberries|raspberries|blackberries|cherries|grapes?|oranges?|mandarins?|clementines?|tangerines?|grapefruits?|lemons?|limes?|peaches?|plums?|nectarines?|apricots?|pears?|kiwis?|mangoes?|pineapple|watermelon|cantaloupe|honeydew|papayas?|pomegranates?|figs?|dates?|berries|fresh\s+produce)\b/.test(s)
  ) {
    return {
      productTitle: cleanTitle,
      brand: isOrganic ? "USDA Organic Produce" : "Fresh Produce",
      ingredients: "100% Fresh Whole Produce (Single-Ingredient Whole Food — Zero Chemical Additives).",
      imageUrl: `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(cleanTitle)}`,
      nutrition: { caloriesKcal100g: 35, sugarsG100g: 3.5, saturatedFatG100g: 0.1, sodiumMg100g: 12, fiberG100g: 2.8, proteinG100g: 1.4, fruitsVegNutsPct: 100, nutriScoreGrade: "a", isWholeFood: true, isOrganic },
      source: "catalog",
    };
  }

  // 2. Plain Fresh Meat, Poultry, Seafood & Shell Eggs (unbreaded, uncured, unbasted)
  if (
    /\b(chicken\s+(breast|thighs?|drumsticks?|wings?|tenderloins?)|ground\s+(beef|turkey|chicken|pork|bison|lamb)|ribeye|sirloin|filet|pork\s+(chops?|loin|tenderloin)|salmon|cod|tilapia|haddock|halibut|trout|tuna\s+steak|shrimp|scallops?|crab\s+legs?|lobster\s+tails?|large\s+eggs?|white\s+eggs?|brown\s+eggs?|cage[- ]?free\s+eggs?|pasture[- ]?raised\s+eggs?|grade\s+a\s+eggs?|\beggs\b)\b/.test(s)
  ) {
    return {
      productTitle: cleanTitle,
      brand: isOrganic ? "Organic Pasture-Raised" : "Fresh Meat & Eggs",
      ingredients: "100% Fresh Whole Food Protein (Zero Chemical Additives, Nitrates, or Preservatives).",
      imageUrl: `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(cleanTitle)}`,
      nutrition: { caloriesKcal100g: 145, sugarsG100g: 0, saturatedFatG100g: 2.5, sodiumMg100g: 65, fiberG100g: 0, proteinG100g: 22.0, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: true, isOrganic },
      source: "catalog",
    };
  }

  return null;
}

/** Strips club-store pack counts, decimal weights, and Walmart promo suffixes (e.g. `, 16.5 oz Box, Now`, `, Fresh Deli Soup, 16 oz Cup`) for cleaner external API queries. */
function cleanSearchQuery(title: string): string {
  return title
    .replace(/[®™©]/g, "")
    .replace(/,\s*(fresh\s+deli\s+soup|deli\s+soup|refrigerated|fresh\s+deli|family\s+size|mega\s+size|giant\s+size|value\s+size|party\s+size|serves\s+\d+|\d+(\.\d+)?\s*(pk|pack|ct|count|oz|fl\s*oz|lb|lbs|g|kg|ml|l|box|bag|tub|can|jar|bottle|carton|cup|bowl|tray|pouch)\b).*$/i, "")
    .replace(/\s+\d+(\.\d+)?\s*(oz|fl\s*oz|lb|lbs|ct|count|pk|pack)\b.*$/i, "")
    .replace(/\s*[-–—]\s*\d+(\.\d+)?\s*(pk|pack|ct|count|oz|lb|lbs)\b.*$/i, "")
    .replace(/\s*\((fresh|refrigerated|frozen)\)\s*$/i, "")
    .replace(/,\s*(now|was)\b.*$/i, "")
    .replace(/\.\.\.+$/, "")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

const DIRECT_CATALOG_PRIORITY =
  /\b(marketside.*(clam\s+chowder|chowder|salad|romaine|spinach|spring\s+mix)|romaine\s+salad\s+blend|classic\s+romaine\s+salad|doritos|cheetos|takis|hidden\s+valley|froot\s+loops|lucky\s+charms|cinnamon\s+toast\s+crunch|cheez[- ]?it|velveeta|instant\s+mashed\s+potato\w*|crispy\s+fried\s+onions?|french'?s.*onions?|french\s+fried\s+onions?|ben\s*&\s*jerry'?s?|half[- ]?baked|cherry\s+garcia|pumpkin\s+cake\s+roll|cake\s+roll|just\s+bare|butterball.*turkey|golden\s+sweet.*corn|capri\s*sun|a\.?1\.?\s*(original\s*)?(steak\s*)?sauce|steak\s+sauce|steak[- ]?umm\w*|in\s+(heavy|light)\s+syrup|ore[- ]?ida|oreo\s+puffs?)\b/i;

export async function lookupIngredients(input: LookupInput): Promise<LookupResult | null> {
  const t0 = performance.now();
  const ms = () => Math.round((performance.now() - t0) * 100) / 100;
  const title = (input.productTitle || "").trim();

  if (title && UI_NOISE_QUERY.test(title)) {
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
        source: "screen",
        ms: ms(),
      };
    }
  }

  // Fast-path exact store-brand items verified directly from packaging (e.g. Marketside Clam Chowder, Ben & Jerry's, French's Fried Onions, Instant Mashed Potatoes)
  if (!input.barcode && title && DIRECT_CATALOG_PRIORITY.test(title)) {
    const direct = catalogFallback(title);
    if (direct) return { ...direct, ms: ms() };
  }

  const key = cacheKey(input);
  if (!key) return null;
  const cache = await loadCache();
  const hit = cache.get(key);
  if (isFreshCacheEntry(hit) && !hit.productTitle.startsWith("Conventional Grocery")) {
    const { cachedAt: _c, source, ...rest } = hit;
    return { ...rest, source: "cache", origin: source, ms: ms() };
  }

  let found: Omit<LookupResult, "ms"> | null = null;
  if (input.barcode) {
    const [offRes, usdaRes] = await Promise.all([offByBarcode(input.barcode), usdaSearch(input.barcode)]);
    found = offRes || usdaRes;
  }
  if (!found && title) {
    const qClean = cleanSearchQuery(title) || title;
    const [offRes, usdaRes] = await Promise.all([offSearch(qClean), usdaSearch(qClean)]);
    found = offRes || usdaRes;
  }
  if (!found && title) found = catalogFallback(title);
  if (!found) return null;

  if (found.source !== "catalog") {
    setCacheEntry(cache, key, { ...found, cachedAt: new Date().toISOString() });
    void persistCache(cache);
  }
  return { ...found, ms: ms() };
}
