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
import { isCatalogEntryFresh, matchDrinkCatalog, passesVariantGuard } from "./drinks-catalog";
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

type CacheEntry = Omit<LookupResult, "ms" | "origin" | "source"> & { source: LookupSource; cachedAt: string };

const USER_AGENT = "HeyBroc-CleanCart/1.1 (ingredient grader; https://heybroc.com)";
const CACHE_DIR =
  process.env.CLEANCART_CACHE_DIR ||
  (process.env.VERCEL ? "/tmp/cleancart-cache" : path.join(process.cwd(), ".cache"));
const CACHE_FILE = path.join(CACHE_DIR, "lookup-cache.json");
const TIMEOUT_MS = 1800;
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

  // Prevent cross-category novel spin-offs (e.g. "Oatmeal Creme Pies" matching "Oatmeal Creme Pies Cereal" or "Nutty Bars Ice Cream")
  const FORM_FACTOR_TOKENS = ["cereal", "ice", "cream", "seasoning", "syrup", "creamer", "frosting", "powder", "supplement", "K-cup", "pods"];
  for (const ff of FORM_FACTOR_TOKENS) {
    if (hasIn(c, ff) && !hasIn(all, ff)) {
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
  if (ratio < 0.55) return 0;
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
      if (isOff && res.status >= 502) {
        offUnavailableUntil = Date.now() + 60 * 1000;
      }
      return null;
    }
    const type = res.headers.get("content-type") || "";
    if (!type.includes("json")) {
      if (isOff) offUnavailableUntil = Date.now() + 60 * 1000;
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
  brands?: string;
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
}

const OFF_FIELDS =
  "product_name,product_name_en,brands,ingredients_text,ingredients_text_en,lang,code,image_front_url,image_url,image_front_small_url,nutriscore_grade,labels_tags,last_modified_t,nutriments";

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
  const en = p.ingredients_text_en?.trim() || "";
  if (en && !OCR_NUTRITION_GARBAGE.test(en) && isEnglishIngredientText(en)) return en;
  const raw = p.ingredients_text?.trim() || "";
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
  for (const p of products) {
    if (!englishIngredients(p)) continue;
    const name = `${p.brands || ""} ${p.product_name_en || p.product_name || ""}`;
    if (!passesVariantGuard(query, name)) continue;
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
  // If a crowdsourced contributor entered sodium_100g in mg instead of g (e.g. 106 instead of 0.106g), normalize it
  const rawSodiumMg = sodiumG !== undefined ? (sodiumG > 10 ? sodiumG : sodiumG * 1000) : saltG !== undefined ? (saltG > 25 ? saltG * 0.4 : saltG * 400) : undefined;
  const sodiumMg = rawSodiumMg !== undefined && rawSodiumMg <= 40000 ? rawSodiumMg : undefined;
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
  const sourceUpdatedAt =
    typeof p.last_modified_t === "number" && p.last_modified_t > 0
      ? new Date(p.last_modified_t * 1000).toISOString().slice(0, 10)
      : null;
  return {
    productTitle: p.product_name_en || p.product_name || fallbackTitle,
    brand: p.brands?.split(",")[0]?.trim() || undefined,
    barcode: p.code,
    ingredients: englishIngredients(p),
    imageUrl: bestOffImage(p),
    nutrition: extractOffNutrition(p),
    source: "openfoodfacts",
    sourceUpdatedAt,
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

interface OffSearchHit {
  code?: string;
  product_name?: string;
  product_name_en?: string;
  brands?: string | string[];
  states_tags?: string[];
  image_front_url?: string;
  image_url?: string;
  image_front_small_url?: string;
}

async function offSearch(title: string): Promise<Omit<LookupResult, "ms"> | null> {
  const q = encodeURIComponent(title);
  // 1. Run Open Food Facts Search-a-licious v3 full-text search + vertical search concurrently
  // (Note: world.openfoodfacts.org/api/v2/search ignores search_terms and returns random French products;
  //  search.openfoodfacts.org/search is Open Food Facts' actual full-text search index.)
  const [searchRes, vertical] = await Promise.all([
    getJson<{ hits?: OffSearchHit[] }>(
      `https://search.openfoodfacts.org/search?q=${q}&page_size=16&fields=code,product_name,product_name_en,brands,states_tags,image_front_url,image_url,image_front_small_url`,
    ),
    openFactsVerticalSearch(title),
  ]);
  if (vertical) return vertical;

  const hits = searchRes?.hits || [];
  const ranked = hits
    .filter(
      (h) =>
        h.code &&
        (!Array.isArray(h.states_tags) || h.states_tags.includes("en:ingredients-completed")),
    )
    .map((h) => {
      const brandStr = Array.isArray(h.brands) ? h.brands.join(" ") : h.brands || "";
      const name = `${brandStr} ${h.product_name_en || h.product_name || ""}`.trim();
      if (!passesVariantGuard(title, name)) return { h, score: 0 };
      const r = relevance(title, name);
      if (r < 0.55) return { h, score: 0 };
      const hasImg = Boolean(h.image_front_url || h.image_url || h.image_front_small_url);
      return { h, score: r + (hasImg ? 0.03 : 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  if (!ranked.length) return null;

  const productDetails = await Promise.all(
    ranked.map(({ h }) =>
      getJson<{ product?: OffProduct }>(
        `https://world.openfoodfacts.org/api/v2/product/${h.code}?fields=${OFF_FIELDS}`,
      ),
    ),
  );

  for (const detail of productDetails) {
    const p = detail?.product;
    if (!p) continue;
    const ing = englishIngredients(p);
    if (!ing) continue;
    const name = `${p.brands || ""} ${p.product_name_en || p.product_name || ""}`.trim();
    if (!passesVariantGuard(title, name)) continue;
    if (isDietaryOrVariantMismatch(title, name, ing, extractOffNutrition(p))) continue;
    return offToResult(p, title);
  }
  return null;
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
  publishedDate?: string;
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
  const PROCESSED_USDA_DESC = /\b(cookie|cookies|cracker|crackers|chip|chips|crisps|crispy|fried|battered|breaded|rings|cereal|puffs|bar|bars|bread|bun|roll|cake|pie|pastry|donut|doughnut|bismark|muffin|waffle|pancake|candy|chocolate|gummy|gummies|soda|cola|pop|drink|beverage|dressing|mayo|mayonnaise|ketchup|sauce|sausage|hot dog|frankfurter|bologna|salami|pepperoni|bacon|nugget|tenders|strips|pizza|fries|tots|instant|mashed|flakes|dehydrated|dried|canned|pickled|cured|smoked|salted|sweetened|candied|glazed|frosted|flavored|ice cream|gelato|sorbet|yogurt|spread|dip|soup|chowder|ramen|noodle|macaroni|pretzel|popcorn|frosting|syrup|creamer|margarine)\b/i;
  for (const f of data?.foods || []) {
    const isTrueWholeFood =
      (f.dataType === "Foundation" || f.dataType === "SR Legacy") &&
      f.description &&
      !PROCESSED_USDA_DESC.test(f.description);
    const ing =
      f.ingredients?.trim() ||
      (isTrueWholeFood ? `Whole Food: ${f.description}` : "");
    if (!ing || !isEnglishIngredientText(ing)) continue;
    const candidateName = `${f.brandName || f.brandOwner || ""} ${f.description || ""}`;
    if (!isBarcodeQuery && !passesVariantGuard(query, candidateName)) continue;
    let r = 0;
    if (isBarcodeQuery) {
      const fCode = (f.gtinUpc || "").replace(/\D/g, "");
      if (fCode && (fCode === numericBarcode || fCode.padStart(13, "0") === numericBarcode.padStart(13, "0"))) {
        r = 1;
      }
    } else {
      r = relevance(query, candidateName);
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
    sourceUpdatedAt: best.publishedDate ? best.publishedDate.slice(0, 10) : null,
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
  sourceUrl?: string;
  verifiedAt?: string;
}

const INSTANT_GROCERY_CATALOG: CatalogEntry[] = [
  {
    match: /\b(bismark|bismarks|donut|donuts|doughnut|doughnuts|fritter|danish|cinnamon roll|honey bun|eclair|strudel|turnover|glazed donut|jelly donut|raspberry filled)\b/i,
    brand: "Representative Bakery Formulation",
    title: "Bakery Donuts / Filled Pastries (Representative Formulation)",
    ingredients: "Enriched Wheat Flour Bleached (Flour, Malted Barley Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Fruit Filling (High Fructose Corn Syrup, Water, Raspberries, Modified Food Starch, Sugar, Citric Acid, Salt, Potassium Sorbate, Sodium Benzoate, Red 40, Blue 1, Artificial Flavor), Palm and/or Soybean Oil, Sugar, Dextrose, Contains 2% or Less of: Yeast, Soy Flour, Whey, Salt, Mono- and Diglycerides, Sodium Acid Pyrophosphate, Baking Soda, Sodium Stearoyl Lactylate, Soy Lecithin, Calcium Propionate, DATEM, Artificial Flavor, Yellow 5, Yellow 6, Titanium Dioxide (Color).",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 405, sugarsG100g: 25, saturatedFatG100g: 9.0, sodiumMg100g: 340, fiberG100g: 1.2, proteinG100g: 4.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e" },
  },
  {
    match: /\b(doritos.*(?:simply\s+nkd|nkd)|(?:simply\s+nkd|nkd).*doritos)\b/i,
    brand: "Doritos",
    title: "Doritos Simply NKD Organic White Cheddar Tortilla Chips",
    ingredients: "Organic White Corn, Expeller-Pressed Sunflower Oil, White Cheddar Cheese (Milk, Cheese Cultures, Salt, Enzymes), Whey, Buttermilk, Salt, Onion Powder, Garlic Powder, Lactic Acid, Citric Acid, Natural Flavor.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Doritos%20Simply%20NKD",
    nutrition: { caloriesKcal100g: 500, sugarsG100g: 3.6, saturatedFatG100g: 3.6, sodiumMg100g: 640, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isOrganic: true, isWholeFood: false },
    sourceUrl: "https://www.simplyfritolay.com",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(cool ranch)\b.*\b(doritos)\b|\b(doritos)\b.*\b(cool ranch)\b/i,
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
  },
  {
    match: /\bmartin'?s\b.*\b(potato|rolls?|buns?|bread)\b/i,
    brand: "Martin's",
    title: "Martin's Famous Pastry Shoppe Potato Sandwich Rolls",
    ingredients: "Unbleached Enriched Wheat Flour (Flour, Ferrous Sulfate, Niacin, Thiamin, Riboflavin, Folic Acid), Nonfat Milk, Reconstituted Potatoes (from Potato Flour), Yeast, Sugar, Wheat Gluten, Sunflower Oil, Contains 2 Percent or Less of Each of the Following: Salt, Butter, Dough Conditioners (Sodium Stearoyl Lactylate, Monoglycerides and Diglycerides, Ascorbic Acid), Monocalcium Phosphate, Cultured Wheat Flour, Calcium Propionate (a Preservative), Guar Gum, Datem, Enzymes, Sesame Seeds, Turmeric Color, Annatto Color.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Martin's%20Potato%20Sandwich%20Rolls",
    nutrition: { caloriesKcal100g: 281, sugarsG100g: 6.2, saturatedFatG100g: 0.8, sodiumMg100g: 390, fiberG100g: 3.1, proteinG100g: 10.9, fruitsVegNutsPct: 12, nutriScoreGrade: "b", isWholeFood: false },
  },
  {
    match: /\b(great\s+value|wonder|sara\s+lee|nature'?s\s+own|l'?oven\s+fresh)\b.*\b(white\s+sandwich\s+bread|white\s+bread|enriched\s+bread|sandwich\s+bread)\b/i,
    brand: "Representative Category Formulation",
    title: "White Enriched Sandwich Bread (Representative Formulation)",
    ingredients: "Unbleached Enriched Wheat Flour (Wheat Flour, Malted Barley Flour, Niacin, Reduced Iron, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, High Fructose Corn Syrup, Yeast, Contains 2% or Less of: Soybean Oil, Salt, Wheat Gluten, Calcium Sulfate, Sodium Stearoyl Lactylate, Monoglycerides, Calcium Propionate (to Preserve Freshness), DATEM, Ascorbic Acid, Enzymes.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Great%20Value%20White%20Sandwich%20Bread",
    nutrition: { caloriesKcal100g: 259, sugarsG100g: 5.8, saturatedFatG100g: 0.7, sodiumMg100g: 480, fiberG100g: 1.9, proteinG100g: 7.8, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\b(oreo\s+puffs?|oreo\s+o'?s)\b/i,
    brand: "Post",
    title: "Oreo O's / Oreo Puffs Cereal",
    ingredients: "Corn Flour, Sugar, Whole Grain Oat Flour, Cocoa (Processed with Alkali), Canola and/or Soybean Oil, Corn Syrup, Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Salt, Degerminated Corn Meal, Natural and Artificial Flavor, Cornstarch, Palm Oil, Soy Lecithin, Chocolate, BHT Added to Preserve Freshness.",
    imageUrl: "/products/cereal.jpg",
    nutrition: { caloriesKcal100g: 395, sugarsG100g: 36, saturatedFatG100g: 1.5, sodiumMg100g: 420, fiberG100g: 2.5, proteinG100g: 4.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(cocoa\s+puffs?|reese'?s\s+puffs?|cookie\s+crisp|cocoa\s+pebbles|fruity\s+pebbles|cap'?n\s+crunch|apple\s+jacks|frosted\s+flakes|krave|pops\s+cereal|honey\s+smacks|golden\s+grahams|trix)\b/i,
    brand: "Representative Category Formulation",
    title: "Sweetened Breakfast Cereal (Representative Formulation)",
    ingredients: "Whole Grain Corn or Corn Flour, Sugar, Corn Syrup, Canola and/or Soybean Oil, Salt, Trisodium Phosphate, Natural and Artificial Flavor, Vitamin E (Mixed Tocopherols) Added to Preserve Freshness.",
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
    match: /\b(cheetos)\b/i,
    brand: "Cheetos",
    title: "Crunchy Cheese Flavored Snacks",
    ingredients: "Enriched Corn Meal (Corn Meal, Ferrous Sulfate, Niacin, Thiamin Mononitrate, Riboflavin, Folic Acid), Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Cheese Seasoning (Whey, Cheddar Cheese, Canola Oil, Maltodextrin, Natural and Artificial Flavors, Salt, Whey Protein Concentrate, Monosodium Glutamate, Lactic Acid, Citric Acid, Artificial Color [Yellow 6]), and Salt.",
    imageUrl: "/products/chips.jpg",
  },
  {
    match: /\b(takis)\b/i,
    brand: "Takis",
    title: "Fuego Hot Chili Pepper & Lime Tortilla Chips",
    ingredients: "Corn Masa Flour, Vegetable Oil (Palm and/or Soybean and/or Canola Oil), Seasoning (Maltodextrin, Citric Acid, Sugar, Potassium Chloride, Salt, Monosodium Glutamate, Hydrolyzed Soy Protein, Natural and Artificial Flavors, Hydrolyzed Yeast, Soybean Oil, Onion Powder, Red 40 Lake, Yellow 6 Lake, Sodium Bicarbonate, Chili Pepper, Disodium Inosinate, Disodium Guanylate, TBHQ).",
    imageUrl: "/products/chips.jpg",
  },
  {
    match: /\b(froot loops|fruit loops)\b/i,
    brand: "Kellogg's",
    title: "Froot Loops Sweetened Multigrain Cereal",
    ingredients: "Corn Flour Blend, Sugar, Wheat Flour, Whole Grain Oat Flour, Modified Food Starch, Contains 2% or Less of Vegetable Oil (Hydrogenated Coconut, Soybean and/or Cottonseed), Oat Fiber, Maltodextrin, Salt, Soluble Corn Fiber, Natural Flavor, Red 40, Yellow 5, Blue 1, Yellow 6.",
    imageUrl: "/products/cereal.jpg",
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
    ingredients: "Whole Grain Wheat, Sugar, Rice Flour, Canola and/or Sunflower Oil, Fructose, Maltodextrin, Dextrose, Salt, Cinnamon, Trisodium Phosphate, Soy Lecithin, Caramel Color. Vitamin E (mixed tocopherols) Added to Preserve Freshness.",
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
    match: /\b(go[- ]?gurt)\b/i,
    brand: "Yoplait Go-GURT",
    title: "Go-GURT Portable Lowfat Yogurt Tubes",
    ingredients: "Cultured Grade A Low Fat Milk, Sugar, Modified Corn Starch, Kosher Gelatin, Tricalcium Phosphate, Natural Flavor, Colored with Vegetable Juice and Beta Carotene, Citric Acid, Vitamin A Acetate, Vitamin D3.",
    imageUrl: "/products/yogurt.jpg",
  },
  {
    match: /\b(yoplait)\b(?!.*\bplain\b)/i,
    brand: "Yoplait",
    title: "Original Strawberry Lowfat Yogurt",
    ingredients: "Cultured Pasteurized Grade A Lowfat Milk, Sugar, Strawberries, Modified Corn Starch, Nonfat Milk, Kosher Gelatin, Citric Acid, Tricalcium Phosphate, Natural Flavor, Pectin, Colored with Carmine, Vitamin A Acetate, Vitamin D3.",
    imageUrl: "/products/yogurt.jpg",
  },
  {
    match: /\b(hidden valley)\b/i,
    brand: "Hidden Valley",
    title: "Original Ranch Salad Dressing & Topping",
    ingredients: "Vegetable Oil (Soybean and/or Canola), Water, Egg Yolk, Sugar, Salt, Cultured Nonfat Buttermilk, Natural Flavors, Less than 1% of: Spices, Dried Garlic, Dried Onion, Vinegar, Phosphoric Acid, Xanthan Gum, Modified Food Starch, Monosodium Glutamate, Artificial Flavors, Disodium Phosphate, Sorbic Acid and Calcium Disodium EDTA Added to Preserve Freshness, Disodium Inosinate and Disodium Guanylate.",
    imageUrl: "/products/ranch.jpg",
  },
  {
    match: /(?<!primal kitchen |avocado oil |organic )\branch dressing\b/i,
    brand: "Representative Category Formulation",
    title: "Creamy Ranch Salad Dressing (Category Estimate)",
    ingredients: "Vegetable Oil (Soybean and/or Canola), Water, Egg Yolk, Sugar, Salt, Cultured Nonfat Buttermilk, Natural Flavors, Less than 1% of: Spices, Dried Garlic, Dried Onion, Vinegar, Phosphoric Acid, Xanthan Gum, Modified Food Starch, Monosodium Glutamate, Artificial Flavors, Disodium Phosphate, Sorbic Acid and Calcium Disodium EDTA Added to Preserve Freshness, Disodium Inosinate and Disodium Guanylate.",
    imageUrl: "/products/ranch.jpg",
  },
  {
    match: /\b(triscuit)\b/i,
    brand: "Triscuit",
    title: "Original Whole Grain Wheat Crackers",
    ingredients: "Whole Grain Wheat, Canola Oil, Sea Salt.",
    imageUrl: "/swaps/crackers.jpg",
    nutrition: { caloriesKcal100g: 428, sugarsG100g: 0, saturatedFatG100g: 0.9, sodiumMg100g: 570, fiberG100g: 10.7, proteinG100g: 10.7, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: false },
  },
  {
    match: /\b(ritz)\b/i,
    brand: "Ritz",
    title: "Original Baked Crackers",
    ingredients: "Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Soybean and/or Canola Oil, Palm Oil, Sugar, Salt, Leavening (Calcium Phosphate, Baking Soda), High Fructose Corn Syrup, Soy Lecithin, Natural Flavor.",
    imageUrl: "/products/crackers.jpg",
  },
  {
    match: /(?<!mary'?s gone |organic |seed )\b(club crackers|town house|wheat thins|saltines|butter crackers|holiday crackers)\b/i,
    brand: "Representative Cracker Formulation",
    title: "Baked Snack Crackers (Representative Formulation)",
    ingredients: "Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Soybean and/or Canola Oil, Sugar, Salt, Leavening (Calcium Phosphate, Baking Soda), Soy Lecithin.",
    imageUrl: "/products/crackers.jpg",
  },
  {
    match: /\b(knoppers|storck|merci)\b|\b(hazelnut wafers?)\b/i,
    brand: "Storck",
    title: "Milk Chocolate & Hazelnut Wafers",
    ingredients: "Sugar, Vegetable Fats (Palm, Shea), Whole Milk Powder, Cocoa Butter, Wheat Flour, Hazelnuts, Cocoa Mass, Skim Milk Powder, Lactose, Butterfat, Low-Fat Cocoa, Soy Lecithin, Whey Product, Salt, Natural Flavors, Sodium Bicarbonate.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 535, sugarsG100g: 44, saturatedFatG100g: 16.5, sodiumMg100g: 160, fiberG100g: 2.0, proteinG100g: 6.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e" },
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
    sourceUrl: "https://www.hersheyland.com/products/hersheys-milk-chocolate-candy-bars-1-55-oz.html",
    verifiedAt: "2026-11-08",
  },
  {
    match: /\b(velveeta)\b/i,
    brand: "Velveeta",
    title: "Original Pasteurized Recipe Cheese Product",
    ingredients: "Milk, Water, Whey, Milk Protein Concentrate, Milkfat, Whey Protein Concentrate, Sodium Phosphate, Contains Less than 2% of Salt, Calcium Phosphate, Lactic Acid, Sorbic Acid as a Preservative, Sodium Citrate, Sodium Alginate, Enzymes, Apocarotenal and Annatto (Color), Cheese Culture.",
    imageUrl: "/products/butter.jpg",
    nutrition: { caloriesKcal100g: 285, sugarsG100g: 7.0, saturatedFatG100g: 11.0, sodiumMg100g: 1460, fiberG100g: 0, proteinG100g: 14.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e" },
  },
  {
    match: /(?<!organic )\b(processed cheese|cheese loaf|queso dip|pasteurized process cheese)\b/i,
    brand: "Representative Process Cheese Formulation",
    title: "Pasteurized Process Cheese / Queso Dip (Representative Formulation)",
    ingredients: "Milk, Water, Whey, Milkfat, Sodium Phosphate, Salt, Calcium Phosphate, Lactic Acid, Sorbic Acid (Preservative), Sodium Citrate, Enzymes, Annatto (Color), Cheese Culture.",
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
    match: /\b(beyond meat|beyond burger|beyond sausage|beyond beef)\b/i,
    brand: "Beyond Meat",
    title: "Plant-Based Patties / Sausage",
    ingredients: "Water, Pea Protein, Expeller-Pressed Canola Oil, Refined Coconut Oil, Rice Protein, Natural Flavors, Methylcellulose, Potato Starch, Apple Extract, Pomegranate Extract, Salt, Potassium Chloride, Vinegar, Lemon Juice Concentrate, Sunflower Lecithin, Beet Juice Extract (for Color).",
    imageUrl: "/products/turkey.jpg",
  },
  {
    match: /\b(impossible burger|impossible sausage|impossible beef|impossible foods)\b/i,
    brand: "Impossible Foods",
    title: "Plant-Based Burger Patties / Sausage",
    ingredients: "Water, Soy Protein Concentrate, Sunflower Oil, Coconut Oil, 2% or Less of: Methylcellulose, Yeast Extract, Salt, Natural Flavors, Cultured Dextrose, Modified Food Starch, Soy Leghemoglobin, Mixed Tocopherols (Antioxidant), Soy Protein Isolate, Vitamins and Minerals.",
    imageUrl: "/products/turkey.jpg",
  },
  {
    match: /\b(morningstar farms|boca|gardein)\b/i,
    brand: "Representative Plant-Based Meat Formulation",
    title: "Plant-Based Patties / Tenders (Representative Formulation)",
    ingredients: "Water, Soy Protein Concentrate, Wheat Gluten, Vegetable Oil (Corn, Canola and/or Sunflower Oil), Soy Protein Isolate, Methylcellulose, Salt, Yeast Extract, Natural Flavors, Spices, Xanthan Gum, Onion Powder, Garlic Powder.",
    imageUrl: "/products/turkey.jpg",
  },
  {
    match: /\b(hot pocket|hot pockets|lean pocket|lean pockets|pizza rolls|totino'?s|bagel bites|stouffer'?s)\b/i,
    brand: "Representative Category Formulation",
    title: "Frozen Stuffed Sandwich / Entree (Representative Formulation)",
    ingredients: "Enriched Flour (Wheat Flour, Malted Barley Flour, Niacin, Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Cooked White Meat Chicken, Reduced Fat Cheddar Cheese, Soybean Oil, Bacon (Cured with Water, Salt, Sugar, Smoke Flavoring, Sodium Phosphate, Sodium Erythorbate, Sodium Nitrite), 2% or Less of Modified Food Starch, Sugar, Salt, Buttermilk, Potassium Chloride, Autolyzed Yeast Extract, Disodium Phosphate, Xanthan Gum, Monosodium Glutamate, Natural Flavors.",
    imageUrl: "/products/snacks.jpg",
  },
  {
    match: /\b(jimmy\s+dean|breakfast\s+croissant|sausage,?\s*egg\s*(&|and)\s*cheese)\b/i,
    brand: "Jimmy Dean",
    title: "Pork Breakfast Sausage / Sandwich (Representative Formulation)",
    ingredients: "Pork, Water, Contains 2% or Less of: Salt, Sugar, Spices, Dextrose, Monosodium Glutamate, Natural Flavorings, Citric Acid.",
    imageUrl: "/products/turkey.jpg",
  },
  {
    match: /\b(hillshire farm|kielbasa|polska kielbasa|smoked sausage|eckrich|johnsonville)\b/i,
    brand: "Representative Smoked Sausage Formulation",
    title: "Smoked Sausage / Kielbasa (Representative Formulation)",
    ingredients: "Pork, Turkey, Beef, Water, Corn Syrup, Modified Food Starch, Contains 2% or Less of Salt, Dextrose, Sodium Citrate, Sodium Phosphate, Monosodium Glutamate, Sodium Diacetate, Sodium Erythorbate, Flavorings, Sodium Nitrite.",
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
    brand: "Representative Gravy Formulation",
    title: "Homestyle Savory Gravy (Representative Formulation)",
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
    match: /\b(gatorade|powerade|sports? drink)\b/i,
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
    match: /\b(goodles)\b/i,
    brand: "Goodles",
    title: "Cheddy Mac Creamy Cheddar Macaroni & Cheese",
    ingredients: "Goodles Noodles (Wheat Flour, Chickpea Protein, Wheat Protein, Oat Fiber, Nutrient Extract Blend), Cheddar Cheese (Cultured Milk, Salt, Enzymes), Whey, Butter (Cream, Natural Flavor), Salt, Disodium Phosphate, Lactic Acid, Annatto Extract (For Color).",
    imageUrl: "/swaps/snacks.jpg",
  },
  {
    match: /\b(annie'?s|organic)\b.*\b(macaroni\s*(and|&)\s*cheese|mac\s*(and|&)\s*cheese|shells\s*(and|&)\s*(white\s*)?cheddar)\b/i,
    brand: "Annie's Homegrown",
    title: "Organic Macaroni & Cheese",
    ingredients: "Organic Pasta (Organic Wheat Flour), Organic Cheddar Cheese (Cultured Pasteurized Organic Milk, Salt, Non-Animal Enzymes), Organic Whey, Organic Nonfat Milk, Salt, Sodium Citrate, Organic Annatto Extract (For Color).",
    imageUrl: "/swaps/snacks.jpg",
  },
  {
    match: /\b(macaroni\s*(and|&)\s*cheese|mac\s*(and|&)\s*cheese|kraft\s+mac|velveeta\s+shells)\b/i,
    brand: "Kraft",
    title: "Original Macaroni & Cheese Dinner",
    ingredients: "Enriched Macaroni Product (Wheat Flour, Durum Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Cheese Sauce Mix (Whey, Milkfat, Salt, Milk Protein Concentrate, Sodium Triphosphate, Contains Less than 2% of Tapioca Flour, Citric Acid, Lactic Acid, Sodium Phosphate, Calcium Phosphate, with Paprika, Turmeric, and Annatto Added for Color, Enzymes, Cheese Culture).",
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
    brand: "Representative Dairy Eggnog Formulation",
    title: "Golden Vanilla Eggnog (Representative Formulation)",
    ingredients: "Milk, Cream, Sugar, Nonfat Milk, Egg Yolks, High Fructose Corn Syrup, Whey, Natural and Artificial Flavor, Nutmeg, Carrageenan, Guar Gum, Mono and Diglycerides, Annatto and Turmeric (Color).",
    imageUrl: "/products/yogurt.jpg",
  },
  {
    match: /\b(werther'?s(?:\s+original)?)\b/i,
    brand: "Werther's Original",
    title: "Caramel Hard Candies",
    ingredients: "Sugar, Glucose Syrup (From Wheat or Corn), Cream (Milk), Condensed Whey (Milk), Butter (Milk), Cane Sugar Syrup, Salt, Soy Lecithin (Emulsifier), Artificial Flavor.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 420, sugarsG100g: 74, saturatedFatG100g: 5.5, sodiumMg100g: 260, fiberG100g: 0, proteinG100g: 0.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(red bird|peppermint\s+(candy|puffs?|mints?|bark|stick|canes?)|candy\s+(puffs?|canes?)|starlight\s+mints?|butter\s+mints?|dinner\s+mints?|hard\s+cand(y|ies)|lifesavers|jolly\s+rancher)\b/i,
    brand: "Red Bird",
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
    nutrition: { caloriesKcal100g: 325, sugarsG100g: 65, saturatedFatG100g: 0.2, sodiumMg100g: 5, fiberG100g: 5.3, proteinG100g: 0.4, fruitsVegNutsPct: 60, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b(freeze[- ]?dried)\b.*\b(blueberr\w*|strawberr\w*|raspberr\w*|bananas?|apples?|mangos?|peaches|fruit|crisps?)\b|\b(blueberry|strawberry|raspberry|berry|fruit)\s+powder\b/i,
    brand: "Freeze-Dried",
    title: "Dehydrated / Freeze-Dried Fruit",
    ingredients: "Dehydrated / Freeze-Dried Fruit (Concentrated Natural Fruit Sugars).",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 345, sugarsG100g: 54, saturatedFatG100g: 0.2, sodiumMg100g: 8, fiberG100g: 7.5, proteinG100g: 2.5, fruitsVegNutsPct: 85, nutriScoreGrade: "c", isWholeFood: false },
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
    match: /\b(coffee[- ]?mate)\b/i,
    brand: "Coffee mate",
    title: "French Vanilla Liquid Coffee Creamer",
    ingredients: "Water, Sugar, Vegetable Oil (High Oleic Soybean and/or High Oleic Canola), and Less than 2% of Micellar Casein (a Milk Derivative), Mono- and Diglycerides, Dipotassium Phosphate, Natural and Artificial Flavor, Cellulose Gel, Cellulose Gum, Carrageenan.",
    imageUrl: "/products/yogurt.jpg",
  },
  {
    match: /\b(international\s+delight|creamer)\b/i,
    brand: "International Delight",
    title: "Flavored Liquid Coffee Creamer (Representative Formulation)",
    ingredients: "Water, Sugar, Palm and/or Soybean Oil, Contains 2% or Less of: Sodium Caseinate (a Milk Derivative), Dipotassium Phosphate, Carrageenan, Mono and Diglycerides, Cellulose Gel, Cellulose Gum, Natural and Artificial Flavors.",
    imageUrl: "/products/yogurt.jpg",
  },
  {
    match: /\b(blount|clam\s+shack)\b.*\b(clam\s+chowder|chowder)\b|\b(clam\s+chowder|new\s+england.*chowder)\b.*\bgluten[\s-]*free\b/i,
    brand: "Blount Clam Shack",
    title: "New England Clam Chowder (Gluten Free)",
    ingredients: "Clam Broth (Water, Clam Juice Concentrate), Potatoes, Clams (Clams, Clam Juice, Salt), Light Cream (Milk, Cream), Onions, Butter (Cream, Salt), Corn Starch, Salt, Spice, Garlic Powder.",
    imageUrl: "/products/ranch.jpg",
    nutrition: { caloriesKcal100g: 110, sugarsG100g: 1.5, saturatedFatG100g: 3.5, sodiumMg100g: 330, fiberG100g: 0.8, proteinG100g: 4.8, fruitsVegNutsPct: 25, nutriScoreGrade: "b", isWholeFood: false },
  },
  {
    match: /\b(panera(\s+bread)?.*broccoli\s+cheddar|broccoli\s+cheddar\s+soup)\b/i,
    brand: "Panera Bread",
    title: "Broccoli Cheddar Soup (Representative Formulation)",
    ingredients: "Water, Milk, Broccoli, Pasteurized Process Cheddar Cheese (Cheddar Cheese [Pasteurized Milk, Cheese Culture, Salt, Enzymes], Water, Sodium Phosphate, Milkfat, Salt, Apocarotenal [Color]), Heavy Cream, Carrots, Seasoning (Modified Corn Starch, Wheat Flour, Salt, Chicken Base [Chicken Meat Including Chicken Juices, Salt, Chicken Fat, Sugar, Maltodextrin, Hydrolyzed Corn Protein, Dried Whey, Natural Flavor, Turmeric], Spices, Paprika), Onions, Butter (Cream, Salt), Soybean Oil, Dijon Mustard (Water, Vinegar, Mustard Seed, Salt, White Wine, Fruit Pectin, Tartaric Acid, Citric Acid, Sugar, Spice), Nisin Preparation, Annatto Extract (Color).",
    imageUrl: "/products/ranch.jpg",
    nutrition: { caloriesKcal100g: 135, sugarsG100g: 2.0, saturatedFatG100g: 5.5, sodiumMg100g: 430, fiberG100g: 1.0, proteinG100g: 4.5, fruitsVegNutsPct: 20, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\b(clam\s+chowder|new\s+england.*chowder|corn\s+chowder|potato\s+chowder|seafood\s+chowder|lobster\s+bisque|tomato\s+bisque|loaded\s+baked\s+potato\s+soup)\b/i,
    brand: "Representative Deli Soup Formulation",
    title: "New England Style Clam Chowder (Representative Formulation)",
    ingredients: "Light Cream (Milk, Cream), Potatoes, Fish Stock (Water, Cod Bones, Haddock Bones, Onions, Celery, Black Pepper, Thyme, Mustard Seed, Bay Leaves), Sea Clams (Sea Clams, Water), Chopped Cockle (Clam Meat), Onions, Wheat Flour, Soybean Oil, Butter (Cream, Salt), Clam Broth (Dehydrated Clam Broth, Maltodextrin), Sea Salt, Celery, Salt Pork (Pork, Sea Salt), Black Pepper, Worcestershire Sauce (Distilled White Vinegar, Molasses, Sugar, Water, Salt, Onions, Anchovies, Garlic, Cloves, Tamarind Extract, Natural Flavorings, Chili Pepper Extract), Garlic.",
    imageUrl: "/products/ranch.jpg",
    nutrition: { caloriesKcal100g: 115, sugarsG100g: 1.5, saturatedFatG100g: 3.5, sodiumMg100g: 350, fiberG100g: 0.9, proteinG100g: 5.2, fruitsVegNutsPct: 25, nutriScoreGrade: "b", isWholeFood: false },
  },
  {
    match: /^(?!.*\b(lotus\s+foods|organic|mike'?s\s+mighty\s+good)\b).*\b(maruchan|top\s+ramen|nissin|cup\s+noodles?|shin\s+ramyun|buldak|samyang|indomie|nongshim|sapporo\s+ichiban|instant\s+ramen|ramen\s+noodle\s+soup|ramen\s+noodles?)\b/i,
    brand: "Maruchan",
    title: "Instant Ramen Noodle Soup (Representative Formulation)",
    ingredients: "Enriched Wheat Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Vegetable Oil (Contains One or More of the Following: Canola, Cottonseed, Palm) Preserved by TBHQ, Salt, Monosodium Glutamate, Maltodextrin, Hydrolyzed Corn, Wheat and Soy Protein, Dehydrated Vegetables (Onion, Garlic, Chive), Sugar, Spices, Potassium Carbonate, Sodium (Mono, Hexameta, and/or Tripoly) Phosphate, Sodium Carbonate, Soy Sauce (Water, Wheat, Soybeans, Salt), Disodium Inosinate, Disodium Guanylate, Chicken Broth, Caramel Color, Yellow 5, Yellow 6, Silicon Dioxide (Anti-Caking Agent), Natural and Artificial Flavor, Citric Acid, Lactose.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 442, sugarsG100g: 2.3, saturatedFatG100g: 8.2, sodiumMg100g: 1830, fiberG100g: 2.3, proteinG100g: 9.3, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /^(?!.*\b(amy'?s|pacific\s+foods|organic|kettle\s*&\s*fire|ramen|maruchan|nissin)\b).*\b(campbell'?s|progresso|chunky\s+soup|chicken\s+noodle\s+soup|tomato\s+soup|cream\s+of\s+(mushroom|chicken|celery)|beef\s+stew|vegetable\s+beef\s+soup|minestrone\s+soup|italian\s+wedding\s+soup)\b/i,
    brand: "Campbell's",
    title: "Homestyle Soup",
    ingredients: "Chicken Stock, Enriched Egg Noodles (Wheat Flour, Egg Whites, Eggs, Niacin, Ferrous Sulfate, Thiamine Mononitrate, Riboflavin, Folic Acid), Cooked Chicken Meat, Carrots, Celery, Contains Less than 2% of: Modified Food Starch, Salt, Chicken Fat, Monosodium Glutamate, Yeast Extract, Soy Protein Isolate, Sodium Phosphate, Potassium Chloride, Natural Flavor, Beta Carotene for Color, Disodium Inosinate, Disodium Guanylate.",
    imageUrl: "/products/ranch.jpg",
    nutrition: { caloriesKcal100g: 55, sugarsG100g: 1.0, saturatedFatG100g: 0.6, sodiumMg100g: 390, fiberG100g: 0.6, proteinG100g: 2.5, fruitsVegNutsPct: 10, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\b(salad\s+kit|chopped\s+kit|caesar\s+salad\s+kit|ranch\s+salad\s+kit|southwest\s+salad\s+kit|asian\s+salad\s+kit|sweet\s+kale\s+kit)\b/i,
    brand: "Representative Salad Kit Formulation",
    title: "Salad Kit with Dressing Packet (Representative Formulation)",
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
    brand: "Representative Instant Potato Formulation",
    title: "Instant Mashed Potatoes (Representative Formulation)",
    ingredients: "Potatoes, Mono- and Diglycerides, Sodium Acid Pyrophosphate (Preservative), Sodium Bisulfite (Preservative), Citric Acid (Preservative).",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 355, sugarsG100g: 2.5, saturatedFatG100g: 1.2, sodiumMg100g: 490, fiberG100g: 5.5, proteinG100g: 7.5, fruitsVegNutsPct: 60, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\b(ore[- ]?ida|golden\s+crinkles|crispy\s+crowns)\b/i,
    brand: "Ore-Ida",
    title: "Golden Crinkles French Fried Potatoes",
    ingredients: "Potatoes, Vegetable Oil (Canola, Soybean, and/or Sunflower Oil), Salt, Disodium Dihydrogen Pyrophosphate (to Retain Natural Color), Dextrose.",
    imageUrl: "/products/chips.jpg",
    nutrition: { caloriesKcal100g: 155, sugarsG100g: 0.8, saturatedFatG100g: 1.2, sodiumMg100g: 340, fiberG100g: 2.4, proteinG100g: 2.4, fruitsVegNutsPct: 75, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\b(french\s+fries|crinkle\s+cut\s+fries|waffle\s+fries|steak\s+fries|shoestring\s+fries|curly\s+fries|seasoned\s+fries|tater\s+tots?|hash\s*browns?)\b/i,
    brand: "Representative Frozen Potato Formulation",
    title: "Frozen French Fried Potatoes / Tater Tots (Representative Formulation)",
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
    match: /\b(steak[- ]?umm\w*)\b/i,
    brand: "Steak-umm",
    title: "100% Beef Sliced Steaks",
    ingredients: "100% Beef.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 280, sugarsG100g: 0, saturatedFatG100g: 9.5, sodiumMg100g: 65, fiberG100g: 0, proteinG100g: 17.5, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\b(philly\s+steak|shaved\s+beef\s+steak)\b/i,
    brand: "Representative Sliced Beef Formulation",
    title: "Seasoned Shaved Beef Steak (Representative Formulation)",
    ingredients: "Beef, Water, Salt, Sodium Phosphate.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 280, sugarsG100g: 0, saturatedFatG100g: 9.5, sodiumMg100g: 310, fiberG100g: 0, proteinG100g: 17.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b((peaches|pears|mandarin\s+oranges|pineapple|fruit\s+cocktail|mixed\s+fruit|cherries|apricots)\s+in\s+(heavy|light|extra\s+light)\s+syrup|dole.*syrup|del\s+monte.*(peaches|syrup|fruit\s+cup))\b/i,
    brand: "Del Monte",
    title: "Sliced Peaches in Heavy Syrup",
    ingredients: "Peaches, Water, High Fructose Corn Syrup, Corn Syrup, Sugar.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 74, sugarsG100g: 17.5, saturatedFatG100g: 0, sodiumMg100g: 6, fiberG100g: 1.2, proteinG100g: 0.4, fruitsVegNutsPct: 55, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b(cake\s+roll|pumpkin\s+cake|swiss\s+roll|snack\s+cakes?|little\s+debbie|hostess|twinkies?|ding\s+dongs?|ho\s*hos?|zebra\s+cakes?|entenmann'?s|freshness\s+guaranteed.*(cake|pie|cupcake|brownie|cookie|muffin|roll)|bake\s+shop.*(cake|pie|cupcake|brownie|cookie|muffin))\b/i,
    brand: "Representative Bakery Formulation",
    title: "Bakery Cake Roll with Creme Filling (Representative Formulation)",
    ingredients: "Sugar, Enriched Wheat Flour Bleached (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Eggs, Water, Pumpkin/Fruit Puree, High Fructose Corn Syrup, Soybean Oil, Palm Oil, Corn Syrup, Contains 2% or Less of: Modified Corn Starch, Mono- and Diglycerides, Polysorbate 60, Sodium Propionate (Preservative), Potassium Sorbate (Preservative), Sodium Acid Pyrophosphate, Soy Lecithin, Natural and Artificial Flavor, Spices, Yellow 5, Yellow 6, Red 40.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 375, sugarsG100g: 36, saturatedFatG100g: 7.5, sodiumMg100g: 330, fiberG100g: 1.0, proteinG100g: 3.8, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(cherry\s+garcia)\b/i,
    brand: "Ben & Jerry's",
    title: "Cherry Garcia Ice Cream",
    ingredients: "Cream, Skim Milk, Liquid Sugar (Sugar, Water), Water, Cherries, Sugar, Egg Yolks, Coconut Oil, Cocoa (Processed with Alkali), Fruit and Vegetable Concentrates (Color), Cocoa Powder, Guar Gum, Natural Flavors, Lemon Juice Concentrate, Carrageenan, Milk Fat, Soy Lecithin.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 256, sugarsG100g: 24.0, saturatedFatG100g: 10.0, sodiumMg100g: 60, fiberG100g: 0.9, proteinG100g: 4.1, fruitsVegNutsPct: 12, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(haagen[- ]?dazs|häagen[- ]?dazs)\b/i,
    brand: "Häagen-Dazs",
    title: "Vanilla / Classic Dairy Ice Cream",
    ingredients: "Cream, Skim Milk, Cane Sugar, Egg Yolks, Vanilla Extract.",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 250, sugarsG100g: 21.0, saturatedFatG100g: 11.0, sodiumMg100g: 55, fiberG100g: 0, proteinG100g: 4.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b(half[- ]?baked|tonight\s+dough|chunky\s+monkey|phish\s+food|americone\s+dream|ben\s*&\s*jerry'?s?)\b/i,
    brand: "Ben & Jerry's",
    title: "Half Baked / Classic Mix-In Ice Cream",
    ingredients: "Cream, Skim Milk, Liquid Sugar (Sugar, Water), Water, Sugar, Wheat Flour, Brown Sugar, Egg Yolks, Butter, Soybean Oil, Coconut Oil, Cocoa (Processed with Alkali), Eggs, Guar Gum, Salt, Vanilla Extract, Carrageenan, Soy Lecithin, Natural Flavor.",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 270, sugarsG100g: 25, saturatedFatG100g: 10.5, sodiumMg100g: 85, fiberG100g: 0.9, proteinG100g: 4.2, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(breyers|blue\s+bell|talenti|edy'?s|dreyer'?s|klondike|drumstick|sundae\s+shoppe|belmont.*ice\s+cream|great\s+value.*ice\s+cream|ice\s+cream|gelato)\b(?!.*\b(alec'?s|cosmic\s+bliss|organic\s+tahitian)\b)/i,
    brand: "Representative Dairy Ice Cream Formulation",
    title: "Dairy Ice Cream (Representative Formulation)",
    ingredients: "Cream, Skim Milk, Sugar, Corn Syrup, Egg Yolks, Guar Gum, Locust Bean Gum, Carrageenan, Natural Flavor, Annatto (Color).",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 235, sugarsG100g: 22, saturatedFatG100g: 9.5, sodiumMg100g: 65, fiberG100g: 0, proteinG100g: 3.8, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
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
    brand: "Canned Vegetables",
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
  {
    match: /\b(simple\s+mills.*crackers)\b/i,
    brand: "Simple Mills",
    title: "Almond Flour Fine Ground Sea Salt Crackers",
    ingredients: "Nut and Seed Flour Blend (Almonds, Sunflower Seeds, Flax Seeds), Tapioca Starch, Cassava Flour, Organic Sunflower Oil, Sea Salt, Organic Onion, Organic Garlic, Rosemary Extract (For Freshness).",
    imageUrl: "/swaps/crackers.jpg",
    nutrition: { caloriesKcal100g: 500, sugarsG100g: 0, saturatedFatG100g: 3.3, sodiumMg100g: 600, fiberG100g: 6.7, proteinG100g: 10.0, fruitsVegNutsPct: 50, nutriScoreGrade: "b", isWholeFood: false },
  },
  {
    match: /\b(mary'?s\s+gone.*crackers|mary'?s\s+gone)\b/i,
    brand: "Mary's Gone Crackers",
    title: "Organic Original Seed Crackers",
    ingredients: "Organic Whole Grain Brown Rice, Organic Whole Grain Quinoa, Organic Brown Flax Seeds, Organic Brown Sesame Seeds, Filtered Water, Sea Salt, Organic Wheat-Free Tamari (Water, Organic Soybeans, Salt, Organic Alcohol).",
    imageUrl: "/swaps/crackers.jpg",
    nutrition: { caloriesKcal100g: 466, sugarsG100g: 0, saturatedFatG100g: 1.7, sodiumMg100g: 450, fiberG100g: 10.0, proteinG100g: 10.0, fruitsVegNutsPct: 35, nutriScoreGrade: "a", isWholeFood: false, isOrganic: true },
  },
  {
    match: /\b(crunchmaster|\d+-seed.*crackers|seed\s+crackers|multi[- ]?grain\s+crackers)\b/i,
    brand: "Crunchmaster",
    title: "6-Seed Multi-Grain Baked Crackers",
    ingredients: "Brown Rice Flour, Whole Grain Yellow Corn, Potato Starch, Safflower Oil, Oat Fiber, Cane Sugar, Sesame Seeds, Flax Seeds, Millet, Quinoa Seeds, Amaranth Seeds, Chia Seeds, Sea Salt, Tamari Soy Sauce Powder (Tamari Soy Sauce [Soybeans, Salt], Maltodextrin, Salt).",
    imageUrl: "/swaps/crackers.jpg",
    nutrition: { caloriesKcal100g: 465, sugarsG100g: 3.5, saturatedFatG100g: 1.8, sodiumMg100g: 450, fiberG100g: 7.0, proteinG100g: 7.0, fruitsVegNutsPct: 25, nutriScoreGrade: "b", isWholeFood: false },
  },
  {
    match: /\b(crackers|saltines|graham\s+crackers|oyster\s+crackers|animal\s+crackers|snack\s+crackers|water\s+crackers|woven\s+wheats?)\b/i,
    brand: "Baked Crackers",
    title: "Enriched Baked Snack Crackers",
    ingredients: "Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Soybean and/or Canola Oil, Palm Oil, Sugar, Salt, Leavening (Calcium Phosphate, Baking Soda), Soy Lecithin, Natural Flavor.",
    imageUrl: "/products/crackers.jpg",
    nutrition: { caloriesKcal100g: 480, sugarsG100g: 6.5, saturatedFatG100g: 7.0, sodiumMg100g: 720, fiberG100g: 2.0, proteinG100g: 7.0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b(birds\s+eye|green\s+giant|steamfresh|frozen\s+vegetables?)\b.*\b(sauced|cheesy|cheese\s+sauce|alfredo|garlic\s+butter|butter\s+sauce|teriyaki|glaze|seasoned\s+asian)\b/i,
    brand: "Birds Eye",
    title: "Sauced Frozen Vegetables",
    ingredients: "Vegetables (Broccoli, Carrots, Corn), Water, Cheddar Cheese (Cultured Milk, Salt, Enzymes, Annatto), Modified Corn Starch, Skim Milk, Whey, Butter (Cream, Salt), Soybean Oil, Salt, Sodium Phosphate, Xanthan Gum, Natural Flavor, Annatto and Paprika Extract (Color).",
    imageUrl: "/products/snacks.jpg",
    nutrition: { caloriesKcal100g: 85, sugarsG100g: 3.0, saturatedFatG100g: 2.5, sodiumMg100g: 340, fiberG100g: 2.0, proteinG100g: 3.5, fruitsVegNutsPct: 70, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\b(birds\s+eye|green\s+giant|steamfresh|asian\s+medley|stir[- ]?fry\s+vegetables?|california\s+blend|normandy\s+blend|mixed\s+vegetables?|frozen\s+vegetables?|peas\s+and\s+carrots|broccoli\s+florets)\b/i,
    brand: "Birds Eye Steamfresh",
    title: "Steamfresh Frozen Vegetables",
    ingredients: "100% Flash-Frozen Whole Vegetables: Broccoli, Carrots, Baby Cob Corn, Sugar Snap Peas (Zero Sauces, Preservatives, or Chemical Additives).",
    imageUrl: "/swaps/ranch.jpg",
    nutrition: { caloriesKcal100g: 42, sugarsG100g: 3.5, saturatedFatG100g: 0.1, sodiumMg100g: 20, fiberG100g: 2.8, proteinG100g: 2.0, fruitsVegNutsPct: 100, nutriScoreGrade: "a", isWholeFood: true },
  },
  {
    match: /\b(nathan'?s(?:\s+famous)?)\b.*\b(beef\s+franks?|franks?|hot\s+dogs?|frankfurters?)\b|\b(nathan'?s\s+famous)\b/i,
    brand: "Nathan's Famous",
    title: "Skinless Beef Franks",
    ingredients: "Beef, Water, Contains 2% or Less of Salt, Sorbitol, Sodium Lactate, Natural Flavorings, Sodium Phosphate, Hydrolyzed Corn Protein, Paprika, Sodium Diacetate, Sodium Erythorbate, Sodium Nitrite.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 295, sugarsG100g: 0, saturatedFatG100g: 10.5, sodiumMg100g: 860, fiberG100g: 0, proteinG100g: 12.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(hebrew\s+national)\b.*\b(beef\s+franks?|franks?|hot\s+dogs?|frankfurters?)\b|\b(hebrew\s+national)\b/i,
    brand: "Hebrew National",
    title: "All-Beef Kosher Franks",
    ingredients: "Beef, Water, Contains 2% or Less of: Salt, Spice, Potassium Lactate, Sodium Lactate, Garlic Powder, Paprika, Hydrolyzed Soy Protein, Sodium Diacetate, Sodium Erythorbate, Flavorings, Sodium Nitrite.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 305, sugarsG100g: 0, saturatedFatG100g: 11.5, sodiumMg100g: 910, fiberG100g: 0, proteinG100g: 12.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(ball\s+park|oscar\s+mayer.*(wieners?|franks?|hot\s+dogs?)|kirkland.*(franks?|hot\s+dogs?)|member'?s\s+mark.*(franks?|hot\s+dogs?)|beef\s+franks?|meat\s+franks?|turkey\s+franks?|hot\s+dogs?|frankfurters?)\b/i,
    brand: "Representative Beef Franks Formulation",
    title: "Beef Franks / Hot Dogs (Representative Formulation)",
    ingredients: "Beef, Water, Corn Syrup, Contains 2% or Less of: Salt, Potassium Lactate, Hydrolyzed Beef Stock, Sodium Phosphate, Flavorings, Sodium Diacetate, Sodium Erythorbate, Sodium Nitrite, Extractives of Paprika.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 315, sugarsG100g: 3.8, saturatedFatG100g: 11.5, sodiumMg100g: 980, fiberG100g: 0, proteinG100g: 11.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(mccormick.*bac'?n|bac'?n\s+(bits|pieces)|bacon\s+bits|imitation\s+bacon)\b/i,
    brand: "McCormick",
    title: "Bac'n Pieces Bacon Flavored Bits",
    ingredients: "Textured Soy Flour, Canola Oil, Salt, Caramel Color, Maltodextrin, Natural and Artificial Flavor, Lactic Acid, Yeast Extract, Disodium Inosinate and Disodium Guanylate (Flavor Enhancers), Red 40.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 428, sugarsG100g: 0, saturatedFatG100g: 2.0, sodiumMg100g: 2280, fiberG100g: 14.0, proteinG100g: 42.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(rotisserie\s+chicken|seasoned\s+rotisserie\s+chicken|member'?s\s+mark.*rotisserie|kirkland.*rotisserie)\b/i,
    brand: "Rotisserie Deli",
    title: "Seasoned Rotisserie Whole Chicken",
    ingredients: "Whole Chicken, Water, Salt, Sodium Phosphate, Sugar, Spices, Garlic Powder, Onion Powder, Natural Flavor.",
    imageUrl: "/products/turkey.jpg",
    nutrition: { caloriesKcal100g: 165, sugarsG100g: 0.5, saturatedFatG100g: 3.2, sodiumMg100g: 390, fiberG100g: 0, proteinG100g: 21.0, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isWholeFood: false },
  },
  {
    match: /\b(gnocchi|potato\s+gnocchi|de\s+cecco.*gnocchi)\b/i,
    brand: "De Cecco",
    title: "Potato Gnocchi Pasta",
    ingredients: "Potato Puree (Water, Dehydrated Potato Flakes), Wheat Flour, Potato Starch, Rice Flour, Salt, Acidity Regulator (Lactic Acid), Preservative (Potassium Sorbate).",
    imageUrl: "/swaps/bread.jpg",
    nutrition: { caloriesKcal100g: 160, sugarsG100g: 1.0, saturatedFatG100g: 0.2, sodiumMg100g: 410, fiberG100g: 2.2, proteinG100g: 4.5, fruitsVegNutsPct: 65, nutriScoreGrade: "a", isWholeFood: false },
  },
  {
    match: /\b(chosen\s+foods.*avocado\s+oil|avocado\s+oil)\b/i,
    brand: "Chosen Foods",
    title: "100% Pure Avocado Oil",
    ingredients: "100% Pure Avocado Oil (Expeller-Pressed Single-Ingredient Fruit Oil).",
    imageUrl: "/swaps/ranch.jpg",
    nutrition: { caloriesKcal100g: 884, sugarsG100g: 0, saturatedFatG100g: 14.0, sodiumMg100g: 0, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 100, nutriScoreGrade: "b", isWholeFood: true },
  },
  {
    match: /\b(extra\s+virgin\s+olive\s+oil|olive\s+oil|pompeian|bertolli.*olive\s+oil|california\s+olive\s+ranch)\b/i,
    brand: "Pompeian",
    title: "100% Extra Virgin Olive Oil",
    ingredients: "100% Extra Virgin Olive Oil (Cold-Pressed Single-Ingredient Fruit Oil).",
    imageUrl: "/swaps/ranch.jpg",
    nutrition: { caloriesKcal100g: 884, sugarsG100g: 0, saturatedFatG100g: 14.0, sodiumMg100g: 0, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 100, nutriScoreGrade: "b", isWholeFood: true },
  },
  {
    match: /\b(eggo|kellogg'?s\s+eggo)\b/i,
    brand: "Kellogg's Eggo",
    title: "Eggo Homestyle Waffles",
    ingredients: "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1 [Thiamin Mononitrate], Vitamin B2 [Riboflavin], Folic Acid), Water, Vegetable Oil (Soybean, Palm, Canola, and/or Cottonseed), Sugar, Leavening (Baking Soda, Sodium Aluminum Phosphate, Monocalcium Phosphate), Contains 2% or Less of Salt, Dextrose, Spice, Whey, Eggs, Soy Lecithin, Beta-Carotene for Color, Calcium Carbonate, Iron, Vitamin A Palmitate, Vitamin B6, Vitamin B12.",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Kellogg's%20Eggo%20Homestyle%20Waffles",
    nutrition: { caloriesKcal100g: 271, sugarsG100g: 5.7, saturatedFatG100g: 2.1, sodiumMg100g: 514, fiberG100g: 1.4, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b(homestyle\s+waffles?|buttermilk\s+waffles?|blueberry\s+waffles?|thick\s*&\s*fluffy\s+waffles?)\b/i,
    brand: "Representative Frozen Waffle Formulation",
    title: "Frozen Waffles (Representative Formulation)",
    ingredients: "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Vegetable Oil (Soybean and/or Canola), Sugar, Leavening (Baking Soda, Sodium Aluminum Phosphate, Monocalcium Phosphate), Salt, Whey, Eggs, Soy Lecithin.",
    imageUrl: "/products/bread.jpg",
    nutrition: { caloriesKcal100g: 271, sugarsG100g: 5.7, saturatedFatG100g: 2.1, sodiumMg100g: 514, fiberG100g: 1.4, proteinG100g: 7.1, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b(crumbled\s+bacon|real\s+bacon\s+(?:bits|pieces|crumbles)|member'?s\s+mark.*bacon|kirkland.*crumbled\s+bacon|hormel.*real\s+bacon)\b/i,
    brand: "Representative Cured Bacon Formulation",
    title: "100% Real Crumbled Bacon (Representative Formulation)",
    ingredients: "Bacon (Cured with Water, Salt, Sugar, Smoke Flavoring, Sodium Phosphate, Sodium Erythorbate, Sodium Nitrite).",
    imageUrl: "https://www.heybroc.com/api/product-image?q=100%25%20Real%20Crumbled%20Bacon",
    nutrition: { caloriesKcal100g: 428, sugarsG100g: 0, saturatedFatG100g: 12.5, sodiumMg100g: 1570, fiberG100g: 0, proteinG100g: 42.8, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(member'?s\s+mark.*(?:usda\s+choice|angus\s+beef)|usda\s+choice\s+angus\s+beef)\b/i,
    brand: "Member's Mark",
    title: "Member's Mark USDA Choice Angus Beef Roast",
    ingredients: "100% USDA Choice Angus Beef (Single-Ingredient Whole Food Protein — Zero Nitrates, Preservatives, or Chemical Additives).",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Member's%20Mark%20USDA%20Choice%20Angus%20Beef%20Roast",
    nutrition: { caloriesKcal100g: 185, sugarsG100g: 0, saturatedFatG100g: 3.5, sodiumMg100g: 65, fiberG100g: 0, proteinG100g: 22.5, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: true },
  },
  {
    match: /\b(purina.*dog\s+chow|dog\s+chow\s+complete)\b/i,
    brand: "Purina",
    title: "Purina Dog Chow Complete Adult Dry Dog Food",
    ingredients: "Whole Grain Corn, Meat and Bone Meal, Corn Gluten Meal, Beef Fat Preserved with Mixed-Tocopherols, Soybean Meal, Poultry By-Product Meal, Egg and Chicken Flavor, Whole Grain Wheat, Animal Digest, Salt, Calcium Carbonate, Potassium Chloride, Mono and Dicalcium Phosphate, Choline Chloride, Minerals, Vitamins, Yellow 6, Yellow 5, Red 40, Blue 2, BHA (Preservative).",
    imageUrl: "https://www.heybroc.com/api/product-image?q=Purina%20Dog%20Chow%20Complete%20Adult%20Dry%20Dog%20Food",
    nutrition: { caloriesKcal100g: 355, sugarsG100g: 2.0, saturatedFatG100g: 4.5, sodiumMg100g: 380, fiberG100g: 3.0, proteinG100g: 21.0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b(rxbar|rx\s+bar)\b/i,
    brand: "RXBAR",
    title: "Whole Food Protein Bar",
    ingredients: "Dates, Egg Whites, Almonds, Cashews, Cocoa, Natural Flavors, Sea Salt.",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 404, sugarsG100g: 28.8, saturatedFatG100g: 2.9, sodiumMg100g: 270, fiberG100g: 9.6, proteinG100g: 23.0, fruitsVegNutsPct: 75, nutriScoreGrade: "a", isWholeFood: true },
  },
  {
    match: /\b(larabar|lärabar)\b/i,
    brand: "LÄRABAR",
    title: "Fruit & Nut Whole Food Bar",
    ingredients: "Dates, Peanuts, Unsweetened Chocolate, Sea Salt.",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 444, sugarsG100g: 35.5, saturatedFatG100g: 6.5, sodiumMg100g: 140, fiberG100g: 8.9, proteinG100g: 11.1, fruitsVegNutsPct: 90, nutriScoreGrade: "b", isWholeFood: true },
  },
  {
    match: /\b(bonne\s+maman)\b/i,
    brand: "Bonne Maman",
    title: "Fruit Preserves",
    ingredients: "Strawberries, Sugar, Cane Sugar, Concentrated Lemon Juice, Fruit Pectin.",
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 250, sugarsG100g: 60.0, saturatedFatG100g: 0, sodiumMg100g: 0, fiberG100g: 1.0, proteinG100g: 0.4, fruitsVegNutsPct: 50, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b(wholly\s+guacamole|guacamole)\b/i,
    brand: "Wholly Guacamole",
    title: "Classic Hass Avocado Guacamole",
    ingredients: "Hass Avocados, Distilled Vinegar, Jalapeño Pepper, Sea Salt, Dehydrated Onion, Granulated Garlic.",
    imageUrl: "/swaps/ranch.jpg",
    nutrition: { caloriesKcal100g: 175, sugarsG100g: 1.0, saturatedFatG100g: 2.5, sodiumMg100g: 370, fiberG100g: 6.5, proteinG100g: 2.0, fruitsVegNutsPct: 95, nutriScoreGrade: "a", isWholeFood: true },
  },
  {
    match: /\b(claussen|grillo'?s\s+pickles)\b/i,
    brand: "Claussen",
    title: "Refrigerated Kosher Dill Pickles",
    ingredients: "Fresh Cucumbers, Water, Salt, Distilled Vinegar, Fresh Garlic, Fresh Dill, Spices, Mustard Seed.",
    imageUrl: "/swaps/ranch.jpg",
    nutrition: { caloriesKcal100g: 18, sugarsG100g: 1.0, saturatedFatG100g: 0, sodiumMg100g: 750, fiberG100g: 1.2, proteinG100g: 0.5, fruitsVegNutsPct: 90, nutriScoreGrade: "b", isWholeFood: false },
  },
  {
    match: /\b(kalamata\s+olives?|castelvetrano\s+olives?|green\s+olives?|black\s+olives?|\bolives\b)\b/i,
    brand: "Mediterranean Olives",
    title: "Pitted Olives in Brine",
    ingredients: "Olives, Water, Sea Salt, Red Wine Vinegar, Extra Virgin Olive Oil.",
    imageUrl: "/swaps/ranch.jpg",
    nutrition: { caloriesKcal100g: 145, sugarsG100g: 0, saturatedFatG100g: 2.0, sodiumMg100g: 1150, fiberG100g: 3.2, proteinG100g: 1.0, fruitsVegNutsPct: 95, nutriScoreGrade: "c", isWholeFood: false },
  },
];

const UI_NOISE_QUERY =
  /\b(bought \d+\+?\s*times?|stay stocked|last purchased|price may vary|max \d+ per order|final cost by weight|instant savings|really philly good|straight talk|google pixel|pixel \d+a?|tracfone|boost mobile|cricket wireless|total wireless|gas savings|walmart\+|walmart cash|manufacturer offer|subscribe to save|new notification|scan barcodes?|barcode scanner|opens barcode scanner|qr code|pickup or delivery|pickup and delivery|your favorites, for less|rollbacks & more|the holiday shop|shop all food|thanksgiving\s+meal|feast\s+for\s+\d+|classic\s+sides|meals?\s+made\s+easy|get\s+it\s+fast|household\s+essentials|grocery\s+list\s+staples|weekly\s+essentials|under\s+\$?\d+\s+per\s+person|shop\s+the\s+list|sparky|my items|product information|items to add next|frequently bought together|customers also viewed|similar items|sold by|fulfilled by|sold and shipped by|arrives between|arrives by|free \d+-day returns|free holiday returns|gift eligible|available for \d+ of \d+ items|fees may apply|snap ebt eligible|pro seller|preferred address|change delivery address|change address|usual items in stock|out of stock|replace with best match|add note for shopper|item instructions|visit the store|freshness guarantee|see customer images|from the manufacturer|\d+\s*[-–—]\s*\d+\s*min|\d+\s*(?:hr|hour|min)s?\s+or\s+less|\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)|free with w\+)\b|&\s*more\.?$|^(?:(?:flavor|size|style|color|colour|scent|count|pack|pack\s+size|variant|option|type|model|pattern|weight|material)\s*:\s*.+|cart\s*,?\s*\(\d+(?:\s+items?)?\)|in\s+\d+[kKmM]?\+?\s*people'?s?\s*c(?:arts?|a.*)|\d+[kKmM]?\+?\s*bought\b.*|options(?:\s+from\s+.*)?|.*\bsam'?s\s+club|\d+\s+[a-z]{2,}(?:\s+[a-z]{2,}){0,2}\s+(?:street|rd|road|drive|ave|avenue|blvd|boulevard|lane|court|place|circle|pkwy|parkway|hwy|highway)\b.*|.*,\s*was|.*\?)$/i;

const NON_FOOD_GUARD =
  /\b(sunscreen|banana\s+boat|coppertone|neutrogena|lotion|spf|lip\s+balm|shampoo|conditioner|body\s+wash|face\s+wash|soap|detergent|cleaner|bleach|wipes?|candle|deodorant|toothpaste|mouthwash|diapers?|litter|pet\s+food|dog\s+food|cat\s+food|toilet\s+paper|paper\s+towels?|bath\s+tissue|topcare|pain\s*&\s*fever|oral\s+suspension|acetaminophen|ibuprofen|tylenol|advil|motrin|benadryl|mucinex|nyquil|dayquil|robitussin|pepto|tums|laxative|antacid|cough\s+syrup|nasal\s+spray|eye\s+drops)\b/i;

const PROCESSED_FOOD_GUARD =
  /\b(chips?|crisps?|crispy|fried|battered|breaded|rings?|instant|mashed|flakes?|au\s+gratin|scalloped|casserole|flavou?red|dressing|ranch|caesar|kit|soup|chowder|sauce|a\.?1\.?|steak[- ]?umm\w*|ketchup|salsa|pie|cake|roll|muffin|donut|candy|gummies|juice|drink|soda|yogurt|cereal|puffs?|bars?|cookies?|wafers?|dried|dehydrated|craisins|fries|tots|ore[- ]?ida|idahoan|hash\s*browns?|macaroni|pasta\s+salad|potato\s+salad|chicken\s+salad|tuna\s+salad|egg\s+salad|ice\s+cream|gelato|sorbet|popsicle|jam|jelly|spread|syrup|canned|fruit\s+cup|del\s+monte|dole|pickled|marinated|seasoned|grilled|roasted|smoked|cured|jerky|bacon|sausage|hot\s*dog|franks?|frankfurters?|salami|pepperoni|bologna|deli|lunch|ham|nuggets?|tenders?|strips?|patties|patty|popcorn|teriyaki|bbq|barbecue|buffalo|honey|glazed|sandwich|biscuit|croissant|burrito|pizza|ramen|helper|eggnog|egg\s+nog|egg\s+roll|noodles?)\b/i;

const CATEGORY_FALLBACK_CATALOG: Array<{
  match: RegExp;
  brand: string;
  ingredients: string;
  nutrition: NutritionInput & { isWholeFood?: boolean };
}> = [
  {
    match: /\b(potato\s+chips?|kettle\s+chips?|wavy\s+chips?|ridged\s+chips?|tortilla\s+chips?|corn\s+chips?|pita\s+chips?|veggie\s+straws?|veggie\s+chips?|cheese\s+curls?|cheese\s+puffs?|pretzels?|popcorn|clancy'?s|lay'?s|ruffles|pringles|fritos|tostitos|utza?|herr'?s|cape\s+cod|smartfood|skinny\s*pop)\b/i,
    brand: "Salty Snacks",
    ingredients: "Potatoes or Whole Corn, Vegetable Oil (Canola, Corn, Soybean, and/or Sunflower Oil), Salt, Dextrose, Maltodextrin, Yeast Extract, Natural Flavors.",
    nutrition: { caloriesKcal100g: 515, sugarsG100g: 2.0, saturatedFatG100g: 4.5, sodiumMg100g: 520, fiberG100g: 4.0, proteinG100g: 6.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b(uncured|no\s+nitrates?|applegate|never\s+any)\b.*\b(hot\s*dogs?|franks?|frankfurters?|wieners?|sausage|kielbasa|bratwurst|salami|pepperoni|ham|turkey|roast\s+beef|deli)\b/i,
    brand: "Uncured Meats",
    ingredients: "Beef, Pork, or Poultry, Water, Contains Less than 2% of Sea Salt, Cane Sugar, Cultured Celery Powder, Organic Spices, Garlic Powder, Onion Powder.",
    nutrition: { caloriesKcal100g: 235, sugarsG100g: 1.0, saturatedFatG100g: 7.5, sodiumMg100g: 740, fiberG100g: 0, proteinG100g: 14.5, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /^(?!.*\b(redhot|wing\s+sauce|buffalo\s+sauce|hot\s+sauce)\b).*\b(hot\s*dogs?|franks?|frankfurters?|wieners?|bologna|salami|pepperoni|pastrami|deli\s+(ham|turkey|chicken|roast\s+beef)|sliced\s+(ham|turkey|chicken)|lunch\s*meat|lunchables?|beef\s+jerky|turkey\s+jerky|oscar\s+mayer|ball\s+park|parkview|appleton\s+farms)\b/i,
    brand: "Deli & Cured Meats",
    ingredients: "Beef, Pork, or Poultry, Water, Corn Syrup, Contains 2% or Less of Salt, Dextrose, Sodium Phosphates, Sodium Propionate, Sodium Diacetate, Sodium Benzoate, Flavorings, Sodium Erythorbate, Sodium Nitrite.",
    nutrition: { caloriesKcal100g: 265, sugarsG100g: 2.5, saturatedFatG100g: 8.5, sodiumMg100g: 980, fiberG100g: 0, proteinG100g: 13.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(ketchup|catsup|bbq\s+sauce|barbecue\s+sauce|teriyaki\s+sauce|cocktail\s+sauce|sweet\s*(&|and)\s*sour\s+sauce|hoisin\s+sauce|heinz.*ketchup|sweet\s+baby\s+ray'?s|stubb'?s|burman'?s.*(ketchup|bbq|barbecue))\b/i,
    brand: "Condiments & Sauces",
    ingredients: "Tomato Concentrate from Red Ripe Tomatoes, Distilled Vinegar, High Fructose Corn Syrup, Corn Syrup, Salt, Spice, Onion Powder, Natural Flavoring.",
    nutrition: { caloriesKcal100g: 112, sugarsG100g: 22.8, saturatedFatG100g: 0.1, sodiumMg100g: 905, fiberG100g: 0.5, proteinG100g: 1.1, fruitsVegNutsPct: 45, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b(mayo|mayonnaise|miracle\s+whip|salad\s+dressing|caesar\s+dressing|italian\s+dressing|thousand\s+island|blue\s+cheese\s+dressing|vinaigrette|tartar\s+sauce|aioli|french\s+onion\s+dip|spinach\s+dip|hellmann'?s|best\s+foods|wish[- ]?bone|ken'?s|briannas|marzetti|tuscan\s+garden)\b/i,
    brand: "Dressings & Spreads",
    ingredients: "Soybean Oil, Water, Whole Eggs and Egg Yolks, Distilled Vinegar, Salt, Sugar, Lemon Juice Concentrate, Calcium Disodium EDTA (Used to Protect Quality), Natural Flavors, Xanthan Gum.",
    nutrition: { caloriesKcal100g: 640, sugarsG100g: 1.8, saturatedFatG100g: 10.0, sodiumMg100g: 620, fiberG100g: 0, proteinG100g: 1.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(pasta\s+sauce|marinara|spaghetti\s+sauce|tomato\s+sauce|pizza\s+sauce|vodka\s+sauce|meat\s+sauce|salsa|picante|pico\s+de\s+gallo|rao'?s|prego|ragu|classico|bertolli|newman'?s\s+own|muir\s+glen|hunt'?s|pace|herdez|mateo'?s|priano.*sauce)\b/i,
    brand: "Tomato Sauce & Salsa",
    ingredients: "Tomato Puree (Water, Tomato Paste), Diced Tomatoes in Tomato Juice, Onions, Olive Oil, Salt, Garlic, Basil, Oregano, Black Pepper, Citric Acid.",
    nutrition: { caloriesKcal100g: 55, sugarsG100g: 4.5, saturatedFatG100g: 0.4, sodiumMg100g: 360, fiberG100g: 1.8, proteinG100g: 1.5, fruitsVegNutsPct: 85, nutriScoreGrade: "b", isWholeFood: false },
  },
  {
    match: /\b(mustard|dijon|yellow\s+mustard|hot\s+sauce|buffalo\s+sauce|wing\s+sauce|sriracha|tabasco|cholula|frank'?s\s+redhot|tapatio|valentina|soy\s+sauce|tamari|worcestershire|grey\s+poupon)\b/i,
    brand: "Condiments",
    ingredients: "Distilled Vinegar, Water, Mustard Seed or Aged Cayenne Red Peppers, Salt, Turmeric, Paprika, Spice, Garlic Powder, Xanthan Gum.",
    nutrition: { caloriesKcal100g: 60, sugarsG100g: 1.0, saturatedFatG100g: 0.2, sodiumMg100g: 1120, fiberG100g: 3.0, proteinG100g: 3.8, fruitsVegNutsPct: 20, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\b(pancake\s+syrup|breakfast\s+syrup|table\s+syrup|mrs\.?\s*butterworth'?s|pearl\s+milling|log\s+cabin|aunt\s+jemima)\b/i,
    brand: "Breakfast Syrup",
    ingredients: "Corn Syrup, High Fructose Corn Syrup, Water, Cellulose Gum, Caramel Color, Salt, Natural and Artificial Flavor, Sodium Benzoate and Sorbic Acid (Preservatives), Sodium Hexametaphosphate.",
    nutrition: { caloriesKcal100g: 270, sugarsG100g: 53.0, saturatedFatG100g: 0, sodiumMg100g: 165, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(pure\s+maple\s+syrup|organic\s+maple\s+syrup|maple\s+syrup|raw\s+honey|unfiltered\s+honey|pure\s+honey|clover\s+honey|\bhoney\b)\b/i,
    brand: "Natural Sweeteners",
    ingredients: "100% Pure Maple Syrup or Raw Honey (Concentrated Natural Sugars).",
    nutrition: { caloriesKcal100g: 290, sugarsG100g: 68.0, saturatedFatG100g: 0, sodiumMg100g: 10, fiberG100g: 0, proteinG100g: 0.2, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b(jam|jelly|preserves|marmalade|fruit\s+spread|grape\s+jelly|strawberry\s+jam|smucker'?s)\b/i,
    brand: "Jams & Preserves",
    ingredients: "Fruit, High Fructose Corn Syrup or Cane Sugar, Corn Syrup, Fruit Pectin, Citric Acid.",
    nutrition: { caloriesKcal100g: 250, sugarsG100g: 48.0, saturatedFatG100g: 0, sodiumMg100g: 25, fiberG100g: 1.0, proteinG100g: 0.3, fruitsVegNutsPct: 45, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b(peanut\s+butter|jif|skippy|peter\s+pan)\b(?!.*\b(natural|organic|unsweetened|no\s+sugar|almond|cashew|sunflower)\b)/i,
    brand: "Peanut Butter",
    ingredients: "Roasted Peanuts, Sugar, Hydrogenated Vegetable Oil (Rapeseed, Cottonseed, and Soybean Oils) to Prevent Separation, Molasses, Mono- and Diglycerides, Salt.",
    nutrition: { caloriesKcal100g: 588, sugarsG100g: 9.2, saturatedFatG100g: 10.3, sodiumMg100g: 425, fiberG100g: 6.0, proteinG100g: 24.0, fruitsVegNutsPct: 90, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\b(country\s+crock|blue\s+bonnet|i\s+can'?t\s+believe\s+it'?s\s+not\s+butter|margarine|buttery\s+spread|vegetable\s+oil\s+spread)\b/i,
    brand: "Buttery Spread",
    ingredients: "Vegetable Oil Blend (Soybean Oil, Palm Oil, Palm Kernel Oil, Canola Oil), Water, Salt, Whey, Mono- and Diglycerides, Soy Lecithin, Potassium Sorbate and Calcium Disodium EDTA (to Preserve Freshness), Natural and Artificial Flavor, Vitamin A Palmitate, Beta Carotene (Color).",
    nutrition: { caloriesKcal100g: 500, sugarsG100g: 0, saturatedFatG100g: 14.0, sodiumMg100g: 680, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /^(?!.*\b(potato|potatoes|lettuce|squash|beans?|peas|apple|peanut|almond|cashew|sunflower|cocoa|shea|cookie)\b).*\b(salted\s+butter|unsalted\s+butter|sweet\s+cream\s+butter|irish\s+butter|land\s+o'?\s*lakes.*butter|great\s+value.*butter|kirkland.*butter|wellsley\s+farms.*butter|country\s+side\s+creamery.*butter|\bbutter\b)\b/i,
    brand: "Creamery Butter",
    ingredients: "Pasteurized Cream, Salt.",
    nutrition: { caloriesKcal100g: 717, sugarsG100g: 0.1, saturatedFatG100g: 51.0, sodiumMg100g: 640, fiberG100g: 0, proteinG100g: 0.9, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(greek\s+yogurt|plain\s+yogurt|sour\s+cream|cottage\s+cheese|fage|oikos|siggi'?s)\b(?!.*\b(strawberry|vanilla|blueberry|peach|cherry|flip|cookie)\b)/i,
    brand: "Cultured Dairy",
    ingredients: "Cultured Pasteurized Grade A Milk and Cream, Live and Active Cultures.",
    nutrition: { caloriesKcal100g: 95, sugarsG100g: 3.5, saturatedFatG100g: 2.5, sodiumMg100g: 65, fiberG100g: 0, proteinG100g: 10.0, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: false },
  },
  {
    match: /\b(yogurt|chobani|dannon|activia|stonyfield|friendly\s+farms.*yogurt)\b/i,
    brand: "Dairy Yogurt",
    ingredients: "Cultured Grade A Lowfat Milk, Cane Sugar, Fruit Puree, Modified Corn Starch, Natural Flavors, Pectin, Citric Acid, Fruit & Vegetable Juice (for Color), Vitamin D3.",
    nutrition: { caloriesKcal100g: 88, sugarsG100g: 11.5, saturatedFatG100g: 1.0, sodiumMg100g: 50, fiberG100g: 0.2, proteinG100g: 4.5, fruitsVegNutsPct: 8, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\b(cheddar|mozzarella|parmesan|provolone|swiss\s+cheese|gouda|feta|ricotta|colby\s+jack|pepper\s+jack|monterey\s+jack|american\s+cheese|string\s+cheese|shredded\s+cheese|sliced\s+cheese|cream\s+cheese|sargento|tillamook|philadelphia|kraft\s+singles|babybel|laughing\s+cow|happy\s+farms)\b/i,
    brand: "Dairy Cheese",
    ingredients: "Pasteurized Milk, Cheese Culture, Salt, Enzymes, Annatto (Vegetable Color), Potato Starch and Powdered Cellulose (to Prevent Caking), Natamycin (a Natural Mold Inhibitor).",
    nutrition: { caloriesKcal100g: 380, sugarsG100g: 1.0, saturatedFatG100g: 18.5, sodiumMg100g: 620, fiberG100g: 0, proteinG100g: 23.0, fruitsVegNutsPct: 0, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b(ezekiel(?:\s+4:?9)?|food\s+for\s+life.*sprouted)\b/i,
    brand: "Food for Life Ezekiel 4:9",
    ingredients: "Organic Sprouted Wheat, Filtered Water, Organic Sprouted Barley, Organic Sprouted Millet, Organic Malted Barley, Organic Sprouted Lentils, Organic Sprouted Soybeans, Organic Sprouted Spelt, Fresh Yeast, Organic Wheat Gluten, Sea Salt.",
    nutrition: { caloriesKcal100g: 235, sugarsG100g: 0, saturatedFatG100g: 0, sodiumMg100g: 220, fiberG100g: 8.8, proteinG100g: 14.7, fruitsVegNutsPct: 15, nutriScoreGrade: "a", isWholeFood: false, isOrganic: true },
  },
  {
    match: /\b(dave'?s\s+killer|sprouted\s+grain)\b.*\b(bread|bagels?|buns?|english\s+muffins?)\b/i,
    brand: "Dave's Killer Bread",
    ingredients: "Organic Whole Wheat, Water, Organic Cracked Wheat, Organic Cane Sugar, Organic Grain & Seed Mix (Organic Flax, Organic Sesame, Organic Quinoa), Sea Salt, Organic Yeast.",
    nutrition: { caloriesKcal100g: 245, sugarsG100g: 5.0, saturatedFatG100g: 0.5, sodiumMg100g: 340, fiberG100g: 7.0, proteinG100g: 10.5, fruitsVegNutsPct: 15, nutriScoreGrade: "a", isWholeFood: false, isOrganic: true },
  },
  {
    match: /\b(bread|loaf|bagels?|buns?|hamburger\s+buns?|hot\s+dog\s+buns?|dinner\s+rolls?|hawaiian\s+rolls?|english\s+muffins?|tortillas?|wraps?|pita|naan|flatbread|waffles?|pancakes?|eggo|biscuits?|croissants?|l'?oven\s+fresh|nature'?s\s+own|sara\s+lee|wonder\s+bread|thomas'?|mission\s+tortillas?|king'?s\s+hawaiian)\b/i,
    brand: "Bakery & Bread",
    ingredients: "Enriched Wheat Flour (Wheat Flour, Malted Barley Flour, Niacin, Reduced Iron, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Sugar, Soybean and/or Canola Oil, Yeast, Salt, Mono- and Diglycerides, Calcium Propionate (Preservative), DATEM, Sodium Stearoyl Lactylate, Soy Lecithin.",
    nutrition: { caloriesKcal100g: 265, sugarsG100g: 5.5, saturatedFatG100g: 1.0, sodiumMg100g: 460, fiberG100g: 2.2, proteinG100g: 8.0, fruitsVegNutsPct: 0, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\b(rolled\s+oats|old\s+fashioned\s+oats|steel\s+cut\s+oats|quick\s+oats)\b(?!.*\b(maple|brown\s+sugar|apple\s+cinnamon|peaches|strawberries)\b)/i,
    brand: "Whole Grain Oats",
    ingredients: "100% Whole Grain Rolled Oats.",
    nutrition: { caloriesKcal100g: 379, sugarsG100g: 1.0, saturatedFatG100g: 1.2, sodiumMg100g: 5, fiberG100g: 10.1, proteinG100g: 13.2, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: true },
  },
  {
    match: /\b(kind\s+(?:nut\s+)?bars?|kind\s+dark\s+chocolate\s+nuts)\b/i,
    brand: "KIND",
    ingredients: "Almonds, Chicory Root Fiber, Honey, Palm Kernel Oil, Sugar, Glucose Syrup, Rice Flour, Unsweetened Chocolate, Alkalized Cocoa, Soy Lecithin, Sea Salt, Natural Flavor, Cocoa Butter.",
    nutrition: { caloriesKcal100g: 450, sugarsG100g: 12.5, saturatedFatG100g: 7.5, sodiumMg100g: 310, fiberG100g: 17.5, proteinG100g: 15.0, fruitsVegNutsPct: 60, nutriScoreGrade: "b", isWholeFood: false },
  },
  {
    match: /\b(cereal|honey\s+bunches|raisin\s+bran|rice\s+krispies|chex|special\s+k|granola|oatmeal|instant\s+oats|granola\s+bars?|protein\s+bars?|chewy\s+bars?|nutri[- ]?grain|belvita|millville|elevation|nature\s+valley|clif\s+bar|quaker)\b/i,
    brand: "Cereal & Bars",
    ingredients: "Whole Grain Oats, Sugar, Corn Syrup, Enriched Flour, Canola and/or Palm Kernel Oil, Honey, Brown Sugar Syrup, Salt, Soy Lecithin, Trisodium Phosphate, Natural Flavor, Vitamin E (Mixed Tocopherols) Added to Preserve Freshness.",
    nutrition: { caloriesKcal100g: 410, sugarsG100g: 24.0, saturatedFatG100g: 3.5, sodiumMg100g: 350, fiberG100g: 4.5, proteinG100g: 7.0, fruitsVegNutsPct: 10, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b(cookies?|chips\s+ahoy|nutter\s+butter|keebler|fig\s+newtons?|wafers?|brownies?|muffins?|donuts?|doughnuts?|bismarks?|pastries|pastry|danish|cinnamon\s+rolls?|cupcakes?|cake|pie|strudel|turnover|benton'?s|bake\s+shop|candy|chocolate|gummies|gummy|haribo|sour\s+patch|skittles|starburst|swedish\s+fish|fruit\s+snacks?|welch'?s\s+fruit\s+snacks?|mott'?s\s+fruit\s+snacks?|choceur|moser\s+roth|sorbet|sherbet|popsicle|ice\s+pop|outshine)\b/i,
    brand: "Bakery & Sweets",
    ingredients: "Sugar, Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Palm and/or Soybean Oil, Corn Syrup, High Fructose Corn Syrup, Cocoa, Cornstarch, Dextrose, Salt, Soy Lecithin, Baking Soda, Artificial Flavor, Citric Acid, Red 40, Yellow 5, Blue 1.",
    nutrition: { caloriesKcal100g: 445, sugarsG100g: 36.0, saturatedFatG100g: 8.5, sodiumMg100g: 260, fiberG100g: 1.5, proteinG100g: 4.0, fruitsVegNutsPct: 0, nutriScoreGrade: "e", isWholeFood: false },
  },
  {
    match: /\b(frozen\s+pizza|rising\s+crust|thin\s+crust|pepperoni\s+pizza|cheese\s+pizza|supreme\s+pizza|pizza|digiorno|red\s+baron|mama\s+cozzi|burritos?|chimichangas?|taquitos?|quesadillas?|enchiladas?|egg\s+rolls?|spring\s+rolls?|potstickers?|dumplings?|lean\s+cuisine|marie\s+callender'?s|banquet|casserole|hamburger\s+helper|tuna\s+helper|pasta\s+salad|potato\s+salad|chicken\s+salad|tuna\s+salad|egg\s+salad|breakfast\s+sandwich)\b/i,
    brand: "Prepared Meals & Pizza",
    ingredients: "Enriched Wheat Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Water, Low-Moisture Part-Skim Mozzarella and Cheddar Cheese, Tomato Paste, Soybean and/or Palm Oil, Sugar, Salt, Modified Corn Starch, Whey, Sodium Phosphate, Yeast, Spices, Natural and Artificial Flavor.",
    nutrition: { caloriesKcal100g: 255, sugarsG100g: 4.2, saturatedFatG100g: 5.5, sodiumMg100g: 610, fiberG100g: 2.0, proteinG100g: 10.5, fruitsVegNutsPct: 15, nutriScoreGrade: "d", isWholeFood: false },
  },
  {
    match: /\b(pickles?|dill\s+pickles?|mt\.?\s*olive|vlasic|pickled)\b/i,
    brand: "Pickles",
    ingredients: "Cucumbers, Water, Distilled Vinegar, Salt, Calcium Chloride, Garlic, Spices, Polysorbate 80, Sodium Benzoate (Preservative), Yellow 5.",
    nutrition: { caloriesKcal100g: 35, sugarsG100g: 1.0, saturatedFatG100g: 0.2, sodiumMg100g: 780, fiberG100g: 1.2, proteinG100g: 0.5, fruitsVegNutsPct: 80, nutriScoreGrade: "c", isWholeFood: false },
  },
  {
    match: /\b(hummus|tzatziki|sabra|park\s+street\s+deli)\b/i,
    brand: "Deli Dips",
    ingredients: "Cooked Chickpeas, Water, Tahini (Ground Sesame), Olive and/or Soybean Oil, Salt, Citric Acid, Garlic, Cumin, Guar Gum, Potassium Sorbate (to Maintain Freshness).",
    nutrition: { caloriesKcal100g: 210, sugarsG100g: 1.5, saturatedFatG100g: 2.2, sodiumMg100g: 410, fiberG100g: 5.0, proteinG100g: 6.5, fruitsVegNutsPct: 70, nutriScoreGrade: "b", isWholeFood: false },
  },
  {
    match: /\b(baked\s+beans|bush'?s|refried\s+beans)\b/i,
    brand: "Pantry Beans",
    ingredients: "Prepared Beans, Water, Brown Sugar, Sugar, Salt, Mustard, Modified Corn Starch, Onion Powder, Caramel Color, Spice, Garlic Powder.",
    nutrition: { caloriesKcal100g: 115, sugarsG100g: 9.2, saturatedFatG100g: 0.3, sodiumMg100g: 420, fiberG100g: 5.0, proteinG100g: 5.5, fruitsVegNutsPct: 75, nutriScoreGrade: "b", isWholeFood: false },
  },
  {
    match: /\b(fruit\s+cups?|applesauce|mott'?s.*applesauce|sweet\s+harvest|canned\s+(peaches|pears|pineapple|fruit|mandarin\s+oranges))\b/i,
    brand: "Packaged Fruit",
    ingredients: "Fruit, Water, Sugar or Pear Juice Concentrate, Ascorbic Acid (Vitamin C) to Promote Color Retention, Citric Acid.",
    nutrition: { caloriesKcal100g: 68, sugarsG100g: 14.5, saturatedFatG100g: 0, sodiumMg100g: 8, fiberG100g: 1.2, proteinG100g: 0.4, fruitsVegNutsPct: 80, nutriScoreGrade: "b", isWholeFood: false },
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
  const isOrganic = /\b(organic|usda organic|\bog\b)\b/i.test(query);

  // Check Just Bare before generic breaded poultry
  if (/\bjust\s+bare\b/i.test(query)) {
    const jbIng =
      "Boneless Skinless Chicken Breast with Rib Meat, Water, Wheat Flour, Contains 2% or Less of: Yellow Corn Flour, Sea Salt, Rice Starch, Spices, Dried Garlic, Dried Onion, Paprika, Yeast, Cream of Tartar, Sodium Bicarbonate.";
    if (
      isCatalogEntryFresh("2026-11-08") &&
      passesVariantGuard(query, "Just Bare Lightly Breaded Chicken Breast Strips") &&
      !isDietaryOrVariantMismatch(query, "Just Bare Lightly Breaded Chicken Breast Strips", jbIng)
    ) {
      return {
        productTitle: cleanTitle,
        brand: "Just Bare",
        ingredients: jbIng,
        imageUrl: `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(cleanTitle)}`,
        nutrition: { caloriesKcal100g: 175, sugarsG100g: 1.0, saturatedFatG100g: 1.5, sodiumMg100g: 380, fiberG100g: 1.0, proteinG100g: 18.5, fruitsVegNutsPct: 0, nutriScoreGrade: "b", isWholeFood: false, isOrganic },
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
      imageUrl: `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(fullDrinkTitle)}`,
      nutrition: { ...drinkHit.nutrition, isOrganic: drinkHit.nutrition?.isOrganic ?? isOrganic },
      source: "catalog",
      sourceUpdatedAt: drinkHit.verifiedAt || "2026-11-08",
    };
  }

  for (const entry of INSTANT_GROCERY_CATALOG) {
    if (
      isCatalogEntryFresh(entry.verifiedAt) &&
      entry.match.test(query) &&
      passesVariantGuard(query, entry.title) &&
      !isDietaryOrVariantMismatch(query, entry.title, entry.ingredients, entry.nutrition)
    ) {
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
        sourceUpdatedAt: entry.verifiedAt || "2026-11-08",
      };
    }
  }
  const s = query.toLowerCase();
  if (NON_FOOD_GUARD.test(s)) {
    return null;
  }

  for (const cat of CATEGORY_FALLBACK_CATALOG) {
    if (
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
        imageUrl: `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(cleanTitle)}`,
        nutrition: { ...cat.nutrition, isOrganic: cat.nutrition.isOrganic ?? isOrganic },
        source: "catalog",
        sourceUpdatedAt: "2026-11-08",
      };
    }
  }

  if (PROCESSED_FOOD_GUARD.test(s)) {
    return null;
  }

  // 1. Fresh Produce, Fruits, Vegetables, Herbs & Salad Greens (strictly single-ingredient)
  if (
    /\b(salad|lettuce|romaine|spinach|kale|arugula|cabbage|broccoli|cauliflower|carrots?|celery|cucumbers?|tomatoes?|potatoes?|sweet\s+potatoes?|yams?|onions?|scallions?|shallots?|leeks?|garlic|ginger|parsley|cilantro|basil|rosemary|thyme|dill|mint|sage|chives|oregano|peppers?|mushrooms?|avocados?|zucchini|squash|pumpkin|asparagus|green\s+beans|brussels\s+sprouts|beets?|radish\w*|turnips?|eggplants?|artichokes?|okra|fennel|bok\s+choy|chard|collards?|edamame|peas|apples?|bananas?|strawberries|blueberries|raspberries|blackberries|cherries|grapes?|oranges?|mandarins?|clementines?|tangerines?|grapefruits?|lemons?|limes?|peaches?|plums?|nectarines?|apricots?|pears?|kiwis?|mangoes?|pineapple|watermelon|cantaloupe|honeydew|papayas?|pomegranates?|figs?|dates?|berries|vegetables?|veggies|fresh\s+produce)\b/.test(s)
  ) {
    return {
      productTitle: cleanTitle,
      brand: isOrganic ? "USDA Organic Produce" : "Fresh Produce",
      ingredients: "100% Fresh Whole Produce (Single-Ingredient Whole Food — Zero Chemical Additives).",
      imageUrl: `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(cleanTitle)}`,
      nutrition: { caloriesKcal100g: 35, sugarsG100g: 3.5, saturatedFatG100g: 0.1, sodiumMg100g: 12, fiberG100g: 2.8, proteinG100g: 1.4, fruitsVegNutsPct: 100, nutriScoreGrade: "a", isWholeFood: true, isOrganic },
      source: "catalog",
      sourceUpdatedAt: "2026-11-08",
    };
  }

  // 2. Plain Fresh / Frozen Meat, Poultry (Whole Turkey, Chicken Breast Fillets, etc.), Seafood & Shell Eggs (unbreaded, uncured)
  if (
    /\b(chicken\s+(breasts?|fillets?|cutlets?|thighs?|drumsticks?|wings?|tenderloins?|quarters?|legs?)|whole\s+chicken|young\s+chicken|(?:whole|frozen|young|fresh|antibiotic[- ]?free|organic|pasture[- ]?raised|grade\s+a)\s+turkey|turkey\s+(breasts?|thighs?|drumsticks?|wings?|tenderloins?)|whole\s+turkey|\bturkey\b|ground\s+(beef|turkey|chicken|pork|bison|lamb)|beef\s+(stew|chuck|roast|brisket|sirloin|ribeye|tenderloin|short\s+ribs?|flank|skirt)|ribeye|sirloin|filet|new\s+york\s+strip|t-bone|porterhouse|pork\s+(chops?|loin|tenderloin|roast|shoulder|ribs?|belly)|lamb\s+(chops?|leg|shank|rack)|salmon|cod|tilapia|haddock|halibut|trout|mahi|swordfish|catfish|snapper|sea\s+bass|tuna\s+steak|shrimp|scallops?|crab\s+legs?|lobster\s+tails?|large\s+eggs?|white\s+eggs?|brown\s+eggs?|cage[- ]?free\s+eggs?|pasture[- ]?raised\s+eggs?|grade\s+aa?\s+.*eggs?|\beggs\b)\b/.test(s)
  ) {
    return {
      productTitle: cleanTitle,
      brand: isOrganic ? "Organic Pasture-Raised" : "Fresh Meat & Eggs",
      ingredients: "100% Whole Food Protein (Single-Ingredient Unprocessed Meat/Poultry/Eggs — Zero Nitrates, Preservatives, or Chemical Additives).",
      imageUrl: `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(cleanTitle)}`,
      nutrition: { caloriesKcal100g: 145, sugarsG100g: 0, saturatedFatG100g: 2.5, sodiumMg100g: 65, fiberG100g: 0, proteinG100g: 22.0, fruitsVegNutsPct: 0, nutriScoreGrade: "a", isWholeFood: true, isOrganic },
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
      /\b(topcare|pain\s*&\s*fever|oral\s+suspension|acetaminophen|ibuprofen|tylenol|advil|motrin|benadryl|mucinex|nyquil|dayquil|robitussin|pepto|tums|laxative|antacid|cough\s+syrup|nasal\s+spray|eye\s+drops)\b/i.test(
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
        source: "screen",
        ms: ms(),
      };
    }
  }

  const key = cacheKey(input);
  if (!key) return null;

  const DIRECT_CATALOG_PRIORITY =
    /\b(velveeta|lactaid|fairlife|martin'?s|white\s+sandwich\s+bread|great\s+value.*(?:milk|eggs?|bread)|cinnamon\s+toast\s+crunch|lucky\s+charms|doritos|pedialyte|planet\s+oat|doubleshot|owyn|liquid\s+death|silk\s+soy(?:milk)?|soy\s*milk|ito\s+en|oi\s+ocha|ritz\s+original|maruchan|top\s+ramen|nissin|cup\s+noodles?|shin\s+ramyun|buldak|samyang|indomie|nongshim|sapporo\s+ichiban|instant\s+ramen|ramen\s+noodle\s+soup|ramen\s+noodles?|knoppers|tony'?s\s+chocolonely|ferrero|lindt|lindor|hershey'?s|reese'?s|frank'?s\s+redhot|potatoes,?\s+butter|butter\s+potatoes?|baby\s+cut\s+carrots?|yams?\s*\(sweet\s+potatoes?\)|honeycrisp\s+apples?|bismark|french'?s|mccormick|idahoan|carvel|panera|blount|fresh banana|bananas?|rotisserie|steamfresh)\b/i;

  if (!input.barcode && title && DIRECT_CATALOG_PRIORITY.test(title)) {
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
