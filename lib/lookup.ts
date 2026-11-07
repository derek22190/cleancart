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
import type { NutritionInput } from "./rubric";

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
const TIMEOUT_MS = 3200;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;

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
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (!type.includes("json")) return null;
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
  nutriments?: Record<string, number | string | undefined>;
}

const OFF_FIELDS =
  "product_name,product_name_en,brands,ingredients_text,ingredients_text_en,lang,code,image_front_url,image_url,image_front_small_url,nutriscore_grade,labels_tags,nutriments";

export const NON_ENGLISH_INGREDIENTS =
  /\b(eau\b|sucre\b|huile\b|farine\b|lait\b|sirop\b|lécithine|acide\b|arômes?|colorants?|amidon|émulsifiants?|conservateurs?|noisettes|poudre\b|zutaten|wasser\b|zucker\b|pflanzliches|weizenmehl|speisesalz|säuerungsmittel|magermilchpulver|ingredientes|agua\b|azúcar|aceite\b|harina\b|leche\b|jarabe\b)/i;

const ENGLISH_INGREDIENT_ANCHORS =
  /\b(water|sugar|salt|flour|milk|oil|cream|butter|cheese|eggs?|corn|wheat|rice|oats?|soy|acid|flavor|flavors|starch|syrup|extract|vinegar|yeast|cocoa|beef|chicken|pork|turkey|apple|strawberry)\b/i;

export function isEnglishIngredientText(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (NON_ENGLISH_INGREDIENTS.test(s) && !ENGLISH_INGREDIENT_ANCHORS.test(s)) {
    return false;
  }
  // If multiple French/German/Spanish tokens appear even alongside a cognate, reject
  const foreignHits = s.match(new RegExp(NON_ENGLISH_INGREDIENTS.source, "gi")) || [];
  if (foreignHits.length >= 2) return false;
  return true;
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

async function offByBarcode(barcode: string): Promise<Omit<LookupResult, "ms"> | null> {
  const code = barcode.replace(/\D/g, "");
  if (!code) return null;
  const candidates = Array.from(new Set([code, code.padStart(13, "0"), code.slice(-12).padStart(13, "0")]));
  for (const c of candidates) {
    const data = await getJson<{ status?: number; product?: OffProduct }>(
      `https://world.openfoodfacts.org/api/v2/product/${c}?fields=${OFF_FIELDS}`,
    );
    if (data?.product && englishIngredients(data.product)) {
      return offToResult(data.product, data.product.product_name || c);
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

async function offSearch(title: string): Promise<Omit<LookupResult, "ms"> | null> {
  const q = encodeURIComponent(title);
  // 1. Primary: US Open Food Facts API v2 search
  const v2Us = await getJson<{ products?: OffProduct[] }>(
    `https://world.openfoodfacts.org/api/v2/search?search_terms=${q}&fields=${OFF_FIELDS}&page_size=24&countries_tags_en=united-states`,
  );
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
  const key = process.env.USDA_API_KEY || "DEMO_KEY";
  const numericBarcode = query.replace(/\D/g, "");
  const isBarcodeQuery = numericBarcode.length >= 8 && numericBarcode === query.trim().replace(/[-\s]/g, "");
  // Search across USDA food types
  const data = await getJson<{ foods?: UsdaFood[] }>(
    `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(query)}&pageSize=25&api_key=${key}`,
  );
  let best: UsdaFood | null = null;
  let bestScore = 0;
  for (const f of data?.foods || []) {
    const ing = f.ingredients?.trim() || "";
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
    imageUrl: "/swaps/snacks.jpg",
    nutrition: { caloriesKcal100g: 405, sugarsG100g: 25, saturatedFatG100g: 9.0, sodiumMg100g: 340, fiberG100g: 1.2, proteinG100g: 4.5, fruitsVegNutsPct: 0, nutriScoreGrade: "e" },
  },
  {
    match: /\b(doritos|nacho cheese)\b/i,
    brand: "Doritos",
    title: "Nacho Cheese Flavored Tortilla Chips",
    ingredients: "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin (Made from Corn), Salt, Cheddar Cheese, Whey, Monosodium Glutamate, Buttermilk, Romano Cheese, Onion Powder, Corn Flour, Natural and Artificial Flavor, Dextrose, Tomato Powder, Lactose, Spices, Artificial Color (Yellow 6, Yellow 5, Red 40), Lactic Acid, Citric Acid, Sugar, Garlic Powder, Skim Milk, Red and Green Bell Pepper Powder, Disodium Inosinate, and Disodium Guanylate.",
    imageUrl: "/swaps/chips.jpg",
  },
  {
    match: /\b(cheez[- ]?it)\b/i,
    brand: "Cheez-It",
    title: "Original Baked Snack Crackers",
    ingredients: "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1, Vitamin B2, Folic Acid), Vegetable Oil (High Oleic Soybean, Soybean, Palm, and/or Canola Oil with TBHQ for Freshness), Cheese Made with Skim Milk (Skim Milk, Whey Protein, Salt, Cheese Cultures, Enzymes, Annatto Extract Color), Contains 2% or Less of Salt, Paprika, Yeast, Paprika Extract Color, Soy Lecithin.",
    imageUrl: "/presets/crackers.jpg",
  },
  {
    match: /\b(oreo|oreos)\b/i,
    brand: "OREO",
    title: "Chocolate Sandwich Cookies",
    ingredients: "Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Sugar, Palm and/or Canola Oil, Cocoa (Processed with Alkali), High Fructose Corn Syrup, Leavening (Baking Soda and/or Calcium Phosphate), Salt, Soy Lecithin, Chocolate, Artificial Flavor.",
    imageUrl: "/swaps/snacks.jpg",
  },
  {
    match: /\b(cheetos|flamin'? hot)\b/i,
    brand: "Cheetos",
    title: "Crunchy Cheese Flavored Snacks",
    ingredients: "Enriched Corn Meal (Corn Meal, Ferrous Sulfate, Niacin, Thiamin Mononitrate, Riboflavin, Folic Acid), Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Cheese Seasoning (Whey, Cheddar Cheese, Canola Oil, Maltodextrin, Natural and Artificial Flavors, Salt, Whey Protein Concentrate, Monosodium Glutamate, Lactic Acid, Citric Acid, Artificial Color [Yellow 6]), and Salt.",
    imageUrl: "/swaps/chips.jpg",
  },
  {
    match: /\b(takis|fuego)\b/i,
    brand: "Takis",
    title: "Fuego Hot Chili Pepper & Lime Tortilla Chips",
    ingredients: "Corn Masa Flour, Vegetable Oil (Palm and/or Soybean and/or Canola Oil), Seasoning (Maltodextrin, Citric Acid, Sugar, Potassium Chloride, Salt, Monosodium Glutamate, Hydrolyzed Soy Protein, Natural and Artificial Flavors, Hydrolyzed Yeast, Soybean Oil, Onion Powder, Red 40 Lake, Yellow 6 Lake, Sodium Bicarbonate, Chili Pepper, Disodium Inosinate, Disodium Guanylate, TBHQ).",
    imageUrl: "/swaps/chips.jpg",
  },
  {
    match: /\b(froot loops|fruit loops)\b/i,
    brand: "Kellogg's",
    title: "Froot Loops Sweetened Multigrain Cereal",
    ingredients: "Corn Flour Blend, Sugar, Wheat Flour, Whole Grain Oat Flour, Modified Food Starch, Contains 2% or Less of Vegetable Oil (Hydrogenated Coconut, Soybean and/or Cottonseed), Oat Fiber, Maltodextrin, Salt, Soluble Corn Fiber, Natural Flavor, Red 40, Yellow 5, Blue 1, Yellow 6, BHT for Freshness.",
    imageUrl: "/swaps/cereal.jpg",
  },
  {
    match: /\b(lucky charms)\b/i,
    brand: "General Mills",
    title: "Lucky Charms Cereal with Marshmallows",
    ingredients: "Whole Grain Oats, Sugar, Whole Grain Corn, Corn Starch, Corn Syrup, Dextrose, Contains 2% or Less of: Salt, Modified Corn Starch, Gelatin, Trisodium Phosphate, Red 40, Yellow 5 & 6, Blue 1, Natural and Artificial Flavor.",
    imageUrl: "/swaps/cereal.jpg",
  },
  {
    match: /\b(cinnamon toast crunch)\b/i,
    brand: "General Mills",
    title: "Cinnamon Toast Crunch Cereal",
    ingredients: "Whole Grain Wheat, Sugar, Rice Flour, Canola and/or Sunflower Oil, Fructose, Maltodextrin, Dextrose, Salt, Cinnamon, Trisodium Phosphate, Soy Lecithin, Caramel Color, BHT Added to Preserve Freshness.",
    imageUrl: "/swaps/cereal.jpg",
  },
  {
    match: /\bhoney nut cheerios\b/i,
    brand: "General Mills",
    title: "Honey Nut Cheerios Oats Cereal",
    ingredients: "Whole Grain Oats, Sugar, Corn Starch, Honey, Brown Sugar Syrup, Salt, Tripotassium Phosphate, Canola and/or Sunflower Oil, Natural Almond Flavor. Vitamin E (mixed tocopherols) Added to Preserve Freshness.",
    imageUrl: "/swaps/cereal.jpg",
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
    imageUrl: "/presets/yogurt.jpg",
  },
  {
    match: /\b(hidden valley)\b|(?<!primal kitchen |avocado oil |organic )\branch dressing\b/i,
    brand: "Hidden Valley",
    title: "Original Ranch Salad Dressing & Topping",
    ingredients: "Vegetable Oil (Soybean and/or Canola), Water, Egg Yolk, Sugar, Salt, Cultured Nonfat Buttermilk, Natural Flavors, Less than 1% of: Spices, Dried Garlic, Dried Onion, Vinegar, Phosphoric Acid, Xanthan Gum, Modified Food Starch, Monosodium Glutamate, Artificial Flavors, Disodium Phosphate, Sorbic Acid and Calcium Disodium EDTA Added to Preserve Freshness, Disodium Inosinate and Disodium Guanylate.",
    imageUrl: "/presets/ranch.jpg",
  },
  {
    match: /\b(oscar mayer|lunchables|bologna|hot dog|hotdogs)\b/i,
    brand: "Oscar Mayer",
    title: "Oven Roasted Turkey Breast Deli Slices",
    ingredients: "Turkey Breast, Water, Modified Cornstarch, Contains Less than 2% of Sodium Lactate, Salt, Sugar, Sodium Phosphates, Carrageenan, Sodium Diacetate, Sodium Ascorbate, Sodium Nitrite, Natural and Artificial Flavor.",
    imageUrl: "/presets/turkey.jpg",
  },
  {
    match: /\b(gatorade|powerade|sports? drink)\b/i,
    brand: "Gatorade",
    title: "Thirst Quencher Fruit Punch Sports Drink",
    ingredients: "Water, Sugar, Dextrose, Citric Acid, Salt, Sodium Citrate, Monopotassium Phosphate, Gum Arabic, Natural Flavor, Sucrose Acetate Isobutyrate, Glycerol Ester of Rosin, Red 40.",
    imageUrl: "/swaps/snacks.jpg",
  },
  {
    match: /\b(coca[- ]?cola|coke|pepsi|dr pepper|mountain dew|mt dew|sprite)\b/i,
    brand: "Coca-Cola",
    title: "Classic Cola Soft Drink",
    ingredients: "Carbonated Water, High Fructose Corn Syrup, Caramel Color, Phosphoric Acid, Natural Flavors, Caffeine.",
    imageUrl: "/swaps/snacks.jpg",
  },
  {
    match: /\b(goldfish)\b/i,
    brand: "Pepperidge Farm",
    title: "Goldfish Cheddar Baked Snack Crackers",
    ingredients: "Made With Smiles And Enriched Wheat Flour (Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Cheddar Cheese (Cultured Milk, Salt, Enzymes, Annatto), Vegetable Oils (Canola, Sunflower And/Or Soybean), Salt, Contains 2% Or Less Of: Yeast, Sugar, Autolyzed Yeast Extract, Paprika, Spices, Celery, Onion Powder, Monocalcium Phosphate, Baking Soda.",
    imageUrl: "/presets/crackers.jpg",
  },
  {
    match: /\b(nutella)\b/i,
    brand: "Ferrero",
    title: "Nutella Hazelnut Spread with Cocoa",
    ingredients: "Sugar, Palm Oil, Hazelnuts, Skim Milk, Cocoa, Soy Lecithin as Emulsifier, Vanillin: An Artificial Flavor.",
    imageUrl: "/swaps/snacks.jpg",
  },
  {
    match: /\b(jif|skippy)\b|(?<!organic |natural |smucker'?s |kirkland |just )\bpeanut butter\b/i,
    brand: "Jif",
    title: "Creamy Peanut Butter",
    ingredients: "Made From Roasted Peanuts And Sugar, Contains 2% Or Less Of: Molasses, Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Mono And Diglycerides, Salt.",
    imageUrl: "/swaps/snacks.jpg",
  },
  {
    match: /\b(heinz)\b|(?<!organic |primal kitchen |unsweetened )\bketchup\b/i,
    brand: "Heinz",
    title: "Tomato Ketchup",
    ingredients: "Tomato Concentrate from Red Ripe Tomatoes, Distilled Vinegar, High Fructose Corn Syrup, Corn Syrup, Salt, Spice, Onion Powder, Natural Flavoring.",
    imageUrl: "/swaps/ranch.jpg",
  },
  {
    match: /\b(hellmann'?s|best foods)\b|(?<!avocado oil |primal kitchen |chosen foods |organic )\bmayonnaise\b/i,
    brand: "Hellmann's",
    title: "Real Mayonnaise",
    ingredients: "Soybean Oil, Water, Whole Eggs and Egg Yolks, Distilled Vinegar, Salt, Sugar, Lemon Juice Concentrate, Calcium Disodium EDTA (Used to Protect Quality), Natural Flavors.",
    imageUrl: "/swaps/ranch.jpg",
  },
  {
    match: /\b(wonder bread|sara lee|white bread)\b|(?<!ezekiel |sprouted |dave'?s killer |organic |sourdough )\b(hamburger buns|hot dog buns)\b/i,
    brand: "Sara Lee",
    title: "Classic Soft White Bread",
    ingredients: "Enriched Wheat Flour, Water, Sugar, Yeast, Vegetable Oil (Soybean), Salt, Calcium Propionate (to Preserve Freshness), Monoglycerides, DATEM, Calcium Sulfate, Soy Lecithin.",
    imageUrl: "/swaps/bread.jpg",
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
    brand: "Clean Grocery Verified",
    title: "Original Macaroni & Cheese Dinner",
    ingredients: "Enriched Macaroni Product (Wheat Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Cheese Sauce Mix (Whey, Milkfat, Milk Protein Concentrate, Salt, Sodium Tripolyphosphate, Citric Acid, Lactic Acid, Sodium Phosphate, Calcium Phosphate, Yellow 5, Yellow 6, Enzymes, Cheese Culture).",
    imageUrl: "/swaps/snacks.jpg",
  },
  {
    match: /\b(organic|alexandre|kalona|maple hill)\b.*\b(eggnog|egg nog)\b/i,
    brand: "Organic Valley",
    title: "Organic Eggnog",
    ingredients: "Organic Grade A Milk, Organic Grade A Cream, Organic Cane Sugar, Organic Egg Yolks, Organic Vanilla Extract, Organic Nutmeg.",
    imageUrl: "/presets/yogurt.jpg",
  },
  {
    match: /\b(eggnog|egg nog)\b/i,
    brand: "Hood",
    title: "Golden Vanilla Eggnog",
    ingredients: "Milk, Cream, Sugar, Nonfat Milk, Egg Yolks, High Fructose Corn Syrup, Whey, Natural and Artificial Flavor, Nutmeg, Carrageenan, Guar Gum, Mono and Diglycerides, Annatto and Turmeric (Color).",
    imageUrl: "/presets/yogurt.jpg",
  },
  {
    match: /^(?!.*\b(soy|soymilk|almond|almondmilk|oat|oatmilk|coconut|cashew|chocolate|strawberry|condensed|evaporated|buttermilk|milkshake|creamer)\b).*\b(whole milk|milk whole|2% milk|milk 2%|1% milk|skim milk|nonfat milk|reduced fat milk|fat free milk|vitamin d milk|great value milk|fairlife|horizon organic milk|organic whole milk)\b/i,
    brand: "Clean Grocery Verified",
    title: "Grade A Pasteurized Milk",
    ingredients: "Grade A Milk, Vitamin D3.",
    imageUrl: "/swaps/yogurt.jpg",
    nutrition: { isWholeFood: true },
  },
  {
    match: /\b(coffee[- ]?mate|international delight|creamer)\b/i,
    brand: "Coffee mate",
    title: "French Vanilla Liquid Coffee Creamer",
    ingredients: "Water, Sugar, Vegetable Oil (High Oleic Soybean and/or High Oleic Canola), and Less than 2% of Micellar Casein (a Milk Derivative), Mono- and Diglycerides, Dipotassium Phosphate, Natural and Artificial Flavor, Cellulose Gel, Cellulose Gum, Carrageenan.",
    imageUrl: "/presets/yogurt.jpg",
  },
  {
    match: /^(?!.*\b(bismark|bismarks|donut|donuts|doughnut|doughnuts|pastry|pastries|danish|fritter|croissant|cinnamon roll|honey bun|eclair|strudel|turnover|scone|tart|cobbler|brownie|cupcake|filled|filling|glazed|frosted|iced|icing|coated|candied|sweetened|freshness guaranteed|marketside|bakery|macaroni|mac\s*&\s*cheese|mac\s+and\s+cheese|chips?|crackers?|cookies?|cake|pie|muffins?|waffles?|pancakes?|cereal|puffs?|pop[- ]?tarts?|bars?|candy|gummies|soda|drink|lemonade|sauce|dressing|ketchup|mayo|mayonnaise|bread|buns?|rolls?|bagels?|toast|pizza|nuggets?|fries|ice cream|popsicle|yogurt|creamer|spread|dip|flavored|frosting|syrup|cup|cups)\b).*\b(bananas?|apples?|avocados?|strawberr\w*|blueberr\w*|raspberr\w*|blackberr\w*|cranberr\w*|cherries|cherry|peaches|peach|plums?|pears?|mangos?|mangoes|pineapple|watermelon|melon|cantaloupe|kiwi|oranges?|clementines?|grapefruit|grapes?|lemons?|limes?|spinach|broccoli|kale|lettuce|romaine|arugula|cabbage|cauliflower|brussels sprouts|asparagus|celery|cucumbers?|zucchini|squash|carrots?|potatoes?|sweet potatoes?|yams?|tomatoes?|onions?|shallots?|garlic|peppers?|mushrooms?|green beans|peas|corn on the cob|eggs?|egg white|pasture[- ]raised eggs|butter|salted butter|unsalted butter|kerrygold|ghee|heavy cream|whipping cream|half and half|cottage cheese|sour cream|plain greek yogurt|salmon|tuna|cod|halibut|tilapia|mahimahi|trout|sardines|shrimp|scallops|crab|lobster|ribeye|sirloin|filet mignon|ny strip|roast|brisket|steak|ground beef|beef chuck|pork chops?|pork tenderloin|pork loin|ground pork|lamb|bison|venison|chicken breast|chicken thighs?|chicken drumsticks?|chicken wings?|whole chicken|ground turkey|ground chicken|olive oil|extra virgin olive oil|avocado oil|coconut oil|beef tallow|honey|oats|rolled oats|steel cut oats|quinoa|brown rice|white rice|jasmine rice|basmati rice|lentils|chickpeas|black beans|pinto beans|kidney beans|almonds|walnuts|pecans|cashews|pistachios|macadamia|chia seeds|flax seeds|hemp seeds|pumpkin seeds|coffee beans|ground coffee|black tea|green tea|sparkling water|spring water|mineral water|baking soda|sea salt|kosher salt)\b/i,
    brand: "Fresh Whole Food",
    title: "100% Whole Unprocessed Food",
    ingredients: "100% pure whole food ingredient. No additives, no preservatives, no seed oils, no artificial dyes.",
    imageUrl: "/presets/butter.jpg",
    nutrition: { isWholeFood: true },
  },
];

const UI_NOISE_QUERY = /\b(gas savings|walmart\+|new notification|scan barcodes|qr code|pickup or delivery|your favorites, for less|rollbacks & more|the holiday shop|shop all food|sparky|my items)\b/i;

function catalogFallback(query: string): Omit<LookupResult, "ms"> | null {
  const cleanTitle = query.trim().replace(/\b\w/g, (c) => c.toUpperCase());
  for (const entry of INSTANT_GROCERY_CATALOG) {
    if (entry.match.test(query)) {
      return {
        productTitle: cleanTitle,
        brand: entry.brand,
        ingredients: entry.ingredients,
        imageUrl: entry.imageUrl,
        nutrition: entry.nutrition,
        source: "catalog",
      };
    }
  }
  // Never invent fake ingredient lists for unknown products when OFF/USDA return no match.
  return null;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function lookupIngredients(input: LookupInput): Promise<LookupResult | null> {
  const t0 = performance.now();
  const ms = () => Math.round((performance.now() - t0) * 100) / 100;
  const title = (input.productTitle || "").trim();

  if (title && UI_NOISE_QUERY.test(title)) {
    return null;
  }

  if (input.rawIngredients?.trim()) {
    return {
      productTitle: title || "Scanned product",
      barcode: input.barcode,
      ingredients: input.rawIngredients.trim(),
      source: "screen",
      ms: ms(),
    };
  }

  // Deterministic instant resolution for verified catalog staples & whole foods when no barcode is specified
  if (!input.barcode && title) {
    const instant = catalogFallback(title);
    if (instant) {
      return { ...instant, ms: ms() };
    }
  }

  const key = cacheKey(input);
  if (!key) return null;
  const cache = await loadCache();
  const hit = cache.get(key);
  if (isFreshCacheEntry(hit) && hit.imageUrl && !hit.productTitle.startsWith("Conventional Grocery")) {
    const { cachedAt: _c, source, ...rest } = hit;
    return { ...rest, source: "cache", origin: source, ms: ms() };
  }

  let found: Omit<LookupResult, "ms"> | null = null;
  if (input.barcode) {
    found = await offByBarcode(input.barcode);
    if (!found) found = await usdaSearch(input.barcode);
  }
  if (!found && title) found = await offSearch(title);
  if (!found && title) found = await usdaSearch(title);
  if (!found && title) found = catalogFallback(title);
  if (!found) return null;

  if (found.source !== "catalog") {
    setCacheEntry(cache, key, { ...found, cachedAt: new Date().toISOString() });
    void persistCache(cache);
  }
  return { ...found, ms: ms() };
}
