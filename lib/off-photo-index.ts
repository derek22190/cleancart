/**
 * Prebuilt US/Canada Open Food Facts Photo Index (Server-Side)
 * ------------------------------------------------------------
 * Resolves product photos in <2ms from:
 *   1. Checked-in compact US/CA index shard (`data/off-us-photo-index.json`)
 *   2. Optional Upstash KV index (`heybroc:offidx:bc:<barcode>` / `heybroc:offidx:q:<slug>`)
 *
 * Enforces strict brand conflict & variant guards so base-product photos never attach
 * to distinct variants ("Simply NKD", "Zero Sugar", "Unflavored", "Extra Creamy", etc.).
 */

import offIndexRaw from "../data/off-us-photo-index.json";
import {
  buildCandidateBrandHaystack,
  detectFirstBrand,
  hasConflictingBrand,
  normalizeBrandPhrase,
} from "./brands";
import { hasProductIdentityMatch, passesVariantGuard } from "./drinks-catalog";
import { isPersistentKvConfigured, kvGet } from "./storage";

/**
 * Compact tuple format in `data/off-us-photo-index.json`:
 *   [barcode, brand, productName, offImageFileOrFullUrl]
 *
 * When `offImageFileOrFullUrl` does not start with `https://`, it represents the relative
 * image filename under `https://images.openfoodfacts.org/images/products/<folder>/`
 * (e.g. `"front_en.3.400.jpg"` or `"1.400.jpg"`).
 */
export type OffPhotoIndexTuple = [string, string, string, string];

interface OffPhotoIndexData {
  version: number;
  generatedAt: string;
  entries: OffPhotoIndexTuple[];
}

const parsedIndex = offIndexRaw as OffPhotoIndexData;

export function offBarcodeFolderPath(rawBarcode: string): string | null {
  const digits = rawBarcode.replace(/\D/g, "");
  if (!digits || digits.length < 8) return null;
  if (digits.length <= 8) return digits;
  const padded = digits.length < 13 ? digits.padStart(13, "0") : digits;
  return `${padded.slice(0, 3)}/${padded.slice(3, 6)}/${padded.slice(6, 9)}/${padded.slice(9)}`;
}

export function expandOffIndexImageUrl(barcode: string, fileOrUrl: string): string | null {
  const trimmed = (fileOrUrl || "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("https://")) return trimmed;
  const folder = offBarcodeFolderPath(barcode);
  if (!folder) return null;
  return `https://images.openfoodfacts.org/images/products/${folder}/${trimmed}`;
}

interface IndexedRecord {
  barcode: string;
  brand: string;
  title: string;
  imageUrl: string;
}

const byBarcode = new Map<string, IndexedRecord>();
const byBrandToken = new Map<string, IndexedRecord[]>();
const allRecords: IndexedRecord[] = [];

function registerIndexEntries(tuples: OffPhotoIndexTuple[]): void {
  for (const tuple of tuples) {
    if (!Array.isArray(tuple) || tuple.length < 4) continue;
    const [rawCode, brand, title, fileOrUrl] = tuple;
    const code = String(rawCode || "").replace(/\D/g, "");
    const imageUrl = expandOffIndexImageUrl(code, String(fileOrUrl || ""));
    if (!imageUrl) continue;
    const rec: IndexedRecord = {
      barcode: code,
      brand: String(brand || "").trim(),
      title: String(title || "").trim(),
      imageUrl,
    };
    allRecords.push(rec);
    if (code.length >= 8) {
      byBarcode.set(code, rec);
      if (code.length === 13 && code.startsWith("0")) {
        byBarcode.set(code.slice(1), rec);
      } else if (code.length === 12) {
        byBarcode.set(`0${code}`, rec);
      }
    }
    const normBrand = normalizeBrandPhrase(rec.brand || rec.title);
    const firstTok = normBrand.split(" ").find((t) => t.length >= 2);
    if (firstTok) {
      const bucket = byBrandToken.get(firstTok);
      if (bucket) bucket.push(rec);
      else byBrandToken.set(firstTok, [rec]);
    }
  }
}

registerIndexEntries(parsedIndex?.entries || []);

const INDEX_FORM_AND_SUBLINE_WORDS = [
  "packet", "packets", "seasoning", "mix", "powder", "canister", "tub", "sticks", "stick", "pods", "concentrate", "shaker",
  "dog", "cat", "puppy", "kitten", "pet", "treats", "treat", "baby", "toddler", "puree",
  "churros", "churro", "popcorn", "bunnies", "bunny", "crackers", "cracker", "cookies", "cookie",
  "bites", "bite", "bars", "bar", "rolls", "roll", "gummies", "chews",
  "bacon", "ground", "burgers", "burger", "patties", "patty", "sausage", "meatballs", "meatball",
  "vegan", "plant", "condensed", "chunky", "flip", "organic",
];

const WHOLE_PRODUCE_DISQUALIFIER_RE =
  /\b(?:peppers?|cheerios|cereals?|oatmeal|granola|yogh?urts?|skyr|kefir|puddings?|baby|infant|toddler|gerber|pouch(?:es)?|purees?|mashed|dogs?|cats?|pets?|treats?|jerky|blue\s+buffalo|mezzetta|bars?|bites?|muffins?|breads?|rolls?|buns?|bagels?|pancakes?|waffles?|cakes?|pies?|cookies?|crackers?|wafers?|pretzels?|popcorn|puffs?|chips?|crisps?|fries|tots|gnocchi|pasta|noodles?|soups?|broths?|stews?|chowders?|salads?|slaws?|dips?|salsas?|sauces?|ketchup|mustard|mayo|dressings?|pickled|pickles?|nut|nuts|protein|shakes?|smoothies?|juices?|sodas?|waters?|teas?|coffees?|creamers?|milks?|ice\s+cream|cand(?:y|ies)|gumm(?:y|ies)|snacks?|seasonings?|powders?|flours?|syrups?|jams?|jell(?:y|ies)|spreads?|butters?|cheeses?|bacon|sausages?|hot\s*dogs?)\b/i;

const GENERIC_BRAND_FILLER_TOKENS = new Set([
  "the", "organic", "organics", "foods", "food", "farms", "farm",
  "market", "markets", "brand", "brands", "company", "co", "inc",
  "family", "natural", "naturals", "homemade",
]);

const NON_BRAND_PLACEHOLDER_RE =
  /(?:category\s+estimate|representative(?:\s+category)?\s+formulation|verify\s+package\s+label)/i;

const GENERIC_NON_BRAND_EXACT_RE =
  /^(?:|usda|fresh(?:\s+produce|\s+meat|\s+fruit|\s+vegetables?)?|produce|whole\s+nuts|organic|unbranded|generic|conventional|grocery|scanned\s+product|unknown|n\/a|none)$/i;

function sanitizeLookupBrand(rawBrand: string): string {
  const trimmed = rawBrand.trim();
  if (!trimmed) return "";
  if (NON_BRAND_PLACEHOLDER_RE.test(trimmed) || GENERIC_NON_BRAND_EXACT_RE.test(trimmed)) {
    return "";
  }
  return trimmed;
}

function passesIndexCandidateGuard(query: string, rawBrand: string, candBrand: string, candTitle: string): boolean {
  const fullCand = `${candBrand} ${candTitle}`.trim();
  if (!fullCand) return false;
  const effectiveBrand = sanitizeLookupBrand(rawBrand);

  if (!candBrand) {
    // Unbranded whole produce entry: reject processed foods or branded packaged items
    if (WHOLE_PRODUCE_DISQUALIFIER_RE.test(query) || WHOLE_PRODUCE_DISQUALIFIER_RE.test(effectiveBrand)) {
      return false;
    }
    if (effectiveBrand) {
      return false;
    }
  } else {
    const normCandBrand = normalizeBrandPhrase(candBrand);
    const normQueryAll = normalizeBrandPhrase(`${effectiveBrand} ${query}`);
    const candTokens = normCandBrand.split(" ").filter((t) => t.length >= 2);
    const distinctiveBrandTokens = candTokens.filter((t) => !GENERIC_BRAND_FILLER_TOKENS.has(t));
    const requiredTokens = distinctiveBrandTokens.length > 0 ? distinctiveBrandTokens : candTokens.slice(0, 1);
    for (const tok of requiredTokens) {
      if (!new RegExp(`\\b${tok}\\b`, "i").test(normQueryAll)) {
        return false;
      }
    }
  }

  if (!passesVariantGuard(query, fullCand)) return false;
  if (hasConflictingBrand(query, fullCand)) return false;
  if (effectiveBrand && hasConflictingBrand(effectiveBrand, fullCand)) return false;

  const qLower = query.toLowerCase();
  const cLower = fullCand.toLowerCase();
  for (const word of INDEX_FORM_AND_SUBLINE_WORDS) {
    const wordRe = new RegExp(`\\b${word}\\b`, "i");
    const qHas = wordRe.test(qLower);
    const cHas = wordRe.test(cLower);
    if (qHas !== cHas) {
      return false;
    }
  }

  return hasProductIdentityMatch(query, fullCand);
}

const NON_SPECIFIC_BRAND_LABEL_RE =
  /^(?:|usda|fresh(?:\s+produce|\s+meat(?:\s*&\s*eggs)?)?|whole\s+nuts.*|produce|organic|unbranded|scanned\s+product|category\s+estimate.*)$/i;

function distinctiveBrandTokensOf(phrase: string): string[] {
  return normalizeBrandPhrase(phrase)
    .split(" ")
    .filter((t) => t.length >= 2 && !GENERIC_BRAND_FILLER_TOKENS.has(t));
}

export function passesBarcodePhotoGuard(
  rawTitle: string,
  rawBrand: string,
  candBrand: string,
  candTitle: string,
): boolean {
  const title = (rawTitle || "").trim();
  const brand = (rawBrand || "").trim();
  if (!title && !brand) return true;

  const fullCand = `${candBrand || ""} ${candTitle || ""}`.trim();
  if (!fullCand) return false;

  const combinedQuery =
    brand && !title.toLowerCase().includes(brand.toLowerCase())
      ? `${brand} ${title}`.trim()
      : title || brand;

  if (title && !passesVariantGuard(title, fullCand)) return false;
  if (combinedQuery && hasConflictingBrand(combinedQuery, fullCand)) return false;
  if (brand && hasConflictingBrand(brand, fullCand)) return false;

  const usableRawBrand = brand && !NON_SPECIFIC_BRAND_LABEL_RE.test(brand) ? brand : "";
  const requestedBrand = usableRawBrand || (title ? detectFirstBrand(title) : "");
  const candBrandClean =
    candBrand && !NON_SPECIFIC_BRAND_LABEL_RE.test(candBrand.trim()) ? candBrand.trim() : "";

  if (requestedBrand && candBrandClean) {
    const reqDirect = distinctiveBrandTokensOf(requestedBrand);
    const candDirect = distinctiveBrandTokensOf(candBrandClean);
    if (reqDirect.length > 0 && candDirect.length > 0) {
      const reqHaystack = new Set(distinctiveBrandTokensOf(buildCandidateBrandHaystack(requestedBrand)));
      const candHaystack = new Set(distinctiveBrandTokensOf(buildCandidateBrandHaystack(candBrandClean)));
      const sharesBrandToken =
        reqDirect.some((t) => candHaystack.has(t)) ||
        candDirect.some((t) => reqHaystack.has(t));
      if (!sharesBrandToken) {
        return false;
      }
    }
  }

  return true;
}

export function lookupOffPhotoIndexSync(params: {
  barcode?: string | null;
  title?: string | null;
  brand?: string | null;
}): { imageUrl: string; barcode?: string } | null {
  const rawTitle = (params.title || "").trim();
  const rawBrand = sanitizeLookupBrand(params.brand || "");
  const cleanCode = (params.barcode || "").replace(/\D/g, "");
  if (cleanCode.length >= 8) {
    const hit = byBarcode.get(cleanCode);
    if (hit && passesBarcodePhotoGuard(rawTitle, rawBrand, hit.brand, hit.title)) {
      return { imageUrl: hit.imageUrl, barcode: hit.barcode };
    }
  }

  const combinedQuery =
    rawBrand && !rawTitle.toLowerCase().includes(rawBrand.toLowerCase())
      ? `${rawBrand} ${rawTitle}`.trim()
      : rawTitle;
  if (combinedQuery.length < 3) return null;

  const queryNormBrand = normalizeBrandPhrase(rawBrand || combinedQuery);
  const firstTok = queryNormBrand.split(" ").find((t) => t.length >= 2);
  const bucket = firstTok ? byBrandToken.get(firstTok) : undefined;

  if (bucket) {
    for (const cand of bucket) {
      if (!passesIndexCandidateGuard(combinedQuery, rawBrand, cand.brand, cand.title)) continue;
      return { imageUrl: cand.imageUrl, barcode: cand.barcode || undefined };
    }
  }

  for (const cand of allRecords) {
    if (bucket && bucket.includes(cand)) continue;
    if (!passesIndexCandidateGuard(combinedQuery, rawBrand, cand.brand, cand.title)) continue;
    return { imageUrl: cand.imageUrl, barcode: cand.barcode || undefined };
  }

  return null;
}

export async function lookupOffPhotoIndex(params: {
  barcode?: string | null;
  title?: string | null;
  brand?: string | null;
}): Promise<{ imageUrl: string; barcode?: string } | null> {
  const localHit = lookupOffPhotoIndexSync(params);
  if (localHit) return localHit;

  if (!isPersistentKvConfigured()) return null;

  try {
    const rawTitle = (params.title || "").trim();
    const rawBrand = sanitizeLookupBrand(params.brand || "");
    const cleanCode = (params.barcode || "").replace(/\D/g, "");
    if (cleanCode.length >= 8) {
      const kvCodeHit = await kvGet<{ u: string; b?: string; t?: string }>(`heybroc:offidx:bc:${cleanCode}`);
      if (
        kvCodeHit?.u &&
        kvCodeHit.u.startsWith("https://") &&
        passesBarcodePhotoGuard(rawTitle, rawBrand, kvCodeHit.b || "", kvCodeHit.t || "")
      ) {
        return { imageUrl: kvCodeHit.u, barcode: cleanCode };
      }
    }
    const combinedQuery =
      rawBrand && !rawTitle.toLowerCase().includes(rawBrand.toLowerCase())
        ? `${rawBrand} ${rawTitle}`.trim()
        : rawTitle;
    if (combinedQuery.length >= 3) {
      const slug = normalizeBrandPhrase(combinedQuery).replace(/\s+/g, "-").slice(0, 96);
      if (slug.length >= 3) {
        const kvTitleHit = await kvGet<{ u: string; bc?: string; b?: string; t?: string }>(`heybroc:offidx:q:${slug}`);
        if (
          kvTitleHit?.u &&
          kvTitleHit.u.startsWith("https://") &&
          passesIndexCandidateGuard(combinedQuery, rawBrand, kvTitleHit.b || "", kvTitleHit.t || "")
        ) {
          return { imageUrl: kvTitleHit.u, barcode: kvTitleHit.bc };
        }
      }
    }
  } catch {
    // Ignore transient KV errors; live OFF fallback or studio art will handle
  }

  return null;
}
