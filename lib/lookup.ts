/**
 * CleanCart — No-Scroll Product Lookup + Local Cache (server-only)
 * -----------------------------------------------------------------
 * Resolution order:
 *   1. rawIngredients read from the user's screen  -> score immediately (no network)
 *   2. Local cache (in-memory Map + JSON file)      -> <5ms, $0
 *   3. Open Food Facts API v2 (barcode or search)   -> free, open data
 *   4. USDA FoodData Central (Branded foods)        -> free, DEMO_KEY or USDA_API_KEY
 * We never scrape Walmart / Instacart / Sam's / BJ's from the server.
 */
import "server-only";
import { promises as fs } from "fs";
import path from "path";

export type LookupSource = "screen" | "cache" | "openfoodfacts" | "usda";

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
  source: LookupSource;
  /** Where the cached entry originally came from (when source === "cache"). */
  origin?: LookupSource;
  ms: number;
}

type CacheEntry = Omit<LookupResult, "ms" | "origin" | "source"> & { source: LookupSource; cachedAt: string };

const USER_AGENT = "CleanCart/1.0 (ingredient grader; https://github.com/cleancart)";
const CACHE_DIR = process.env.CLEANCART_CACHE_DIR || path.join(process.cwd(), ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "lookup-cache.json");
const TIMEOUT_MS = 7000;

let memory: Map<string, CacheEntry> | null = null;
let loading: Promise<Map<string, CacheEntry>> | null = null;

async function loadCache(): Promise<Map<string, CacheEntry>> {
  if (memory) return memory;
  if (!loading) {
    loading = (async () => {
      try {
        const json = JSON.parse(await fs.readFile(CACHE_FILE, "utf8")) as Record<string, CacheEntry>;
        memory = new Map(Object.entries(json));
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

export function cacheKey(input: LookupInput): string | null {
  if (input.barcode?.trim()) return `upc:${input.barcode.replace(/\D/g, "")}`;
  const t = (input.productTitle || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return t ? `title:${t}` : null;
}

/* ------------------------------------------------------------------ */
/* Relevance helpers                                                   */
/* ------------------------------------------------------------------ */

const STOP = new Set(["the", "and", "with", "for", "oz", "fl", "lb", "pack", "count", "ct", "of", "great", "value", "size", "family"]);
/** Descriptors that appear on thousands of products and must not carry a match on their own. */
const GENERIC = new Set(["original", "classic", "organic", "natural", "flavored", "flavor", "plain", "whole", "lowfat", "nonfat", "reduced", "fat", "free", "low", "made", "sea", "salt", "style", "brand", "real"]);

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
}

/**
 * 0–1 relevance of a candidate product name to the user's query. Only distinctive tokens
 * count; short queries (≤2 distinctive tokens) must match all of them.
 */
function relevance(query: string, candidate: string): number {
  const all = tokens(query);
  const q = all.filter((t) => !GENERIC.has(t));
  const pool = q.length ? q : all;
  if (!pool.length) return 0;
  const c = tokens(candidate);
  const has = (t: string) => c.some((x) => x === t || (t.length >= 4 && (x.startsWith(t) || t.startsWith(x)) && x.length >= 4));
  const ratio = pool.filter(has).length / pool.length;
  if (pool.length <= 2) return ratio === 1 ? 1 : 0;
  return ratio >= 0.67 ? ratio : 0;
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
/* Open Food Facts                                                     */
/* ------------------------------------------------------------------ */

interface OffProduct {
  code?: string;
  product_name?: string;
  product_name_en?: string;
  brands?: string;
  ingredients_text?: string;
  ingredients_text_en?: string;
  lang?: string;
  image_front_small_url?: string;
}

const OFF_FIELDS = "product_name,product_name_en,brands,ingredients_text,ingredients_text_en,lang,code,image_front_small_url";

function englishIngredients(p: OffProduct): string {
  if (p.ingredients_text_en?.trim()) return p.ingredients_text_en.trim();
  if ((p.lang === "en" || !p.lang) && p.ingredients_text?.trim()) return p.ingredients_text.trim();
  return "";
}

function pickBestOff(query: string, products: OffProduct[] = []): OffProduct | null {
  let best: OffProduct | null = null;
  let bestScore = 0;
  for (const p of products) {
    if (!englishIngredients(p)) continue;
    const name = `${p.brands || ""} ${p.product_name_en || p.product_name || ""}`;
    const r = relevance(query, name);
    if (r > bestScore) { best = p; bestScore = r; }
  }
  return bestScore >= 0.5 ? best : null;
}

function offToResult(p: OffProduct, fallbackTitle: string): Omit<LookupResult, "ms"> {
  return {
    productTitle: p.product_name_en || p.product_name || fallbackTitle,
    brand: p.brands?.split(",")[0]?.trim() || undefined,
    barcode: p.code,
    ingredients: englishIngredients(p),
    imageUrl: p.image_front_small_url,
    source: "openfoodfacts",
  };
}

async function offByBarcode(barcode: string): Promise<Omit<LookupResult, "ms"> | null> {
  const code = barcode.replace(/\D/g, "");
  if (!code) return null;
  const data = await getJson<{ status?: number; product?: OffProduct }>(
    `https://world.openfoodfacts.org/api/v2/product/${code}?fields=${OFF_FIELDS}`,
  );
  if (!data?.product || !englishIngredients(data.product)) return null;
  return offToResult(data.product, data.product.product_name || code);
}

async function offSearch(title: string): Promise<Omit<LookupResult, "ms"> | null> {
  const q = encodeURIComponent(title);
  // Primary: API v2 search (per spec).
  const v2 = await getJson<{ products?: OffProduct[] }>(
    `https://world.openfoodfacts.org/api/v2/search?search_terms=${q}&fields=${OFF_FIELDS}&page_size=24&countries_tags_en=united-states`,
  );
  let best = pickBestOff(title, v2?.products);
  // Fallback: classic full-text search endpoint (v2 search can be rate-limited / non-full-text).
  if (!best) {
    const v1 = await getJson<{ products?: OffProduct[] }>(
      `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page_size=24&fields=${OFF_FIELDS}` +
        `&tagtype_0=countries&tag_contains_0=contains&tag_0=united-states`,
    );
    best = pickBestOff(title, v1?.products);
  }
  return best ? offToResult(best, title) : null;
}

/* ------------------------------------------------------------------ */
/* USDA FoodData Central                                               */
/* ------------------------------------------------------------------ */

interface UsdaFood {
  description?: string;
  brandName?: string;
  brandOwner?: string;
  gtinUpc?: string;
  ingredients?: string;
}

async function usdaSearch(query: string): Promise<Omit<LookupResult, "ms"> | null> {
  const key = process.env.USDA_API_KEY || "DEMO_KEY";
  const data = await getJson<{ foods?: UsdaFood[] }>(
    `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(query)}&dataType=Branded&pageSize=25&api_key=${key}`,
  );
  let best: UsdaFood | null = null;
  let bestScore = 0;
  for (const f of data?.foods || []) {
    if (!f.ingredients?.trim()) continue;
    const r = relevance(query, `${f.brandName || f.brandOwner || ""} ${f.description || ""}`);
    if (r > bestScore) { best = f; bestScore = r; }
  }
  if (!best || bestScore < 0.5) return null;
  const titleCase = (s = "") => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    productTitle: titleCase(best.description) || query,
    brand: titleCase(best.brandName || best.brandOwner) || undefined,
    barcode: best.gtinUpc,
    ingredients: best.ingredients!.trim(),
    source: "usda",
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function lookupIngredients(input: LookupInput): Promise<LookupResult | null> {
  const t0 = performance.now();
  const ms = () => Math.round((performance.now() - t0) * 100) / 100;
  const title = (input.productTitle || "").trim();

  if (input.rawIngredients?.trim()) {
    return { productTitle: title || "Scanned product", barcode: input.barcode, ingredients: input.rawIngredients.trim(), source: "screen", ms: ms() };
  }

  const key = cacheKey(input);
  if (!key) return null;
  const cache = await loadCache();
  const hit = cache.get(key);
  if (hit) {
    const { cachedAt: _c, source, ...rest } = hit;
    return { ...rest, source: "cache", origin: source, ms: ms() };
  }

  let found: Omit<LookupResult, "ms"> | null = null;
  if (input.barcode) found = await offByBarcode(input.barcode);
  if (!found && title) found = await offSearch(title);
  if (!found && title) found = await usdaSearch(title);
  if (!found) return null;

  cache.set(key, { ...found, cachedAt: new Date().toISOString() });
  void persistCache(cache);
  return { ...found, ms: ms() };
}
