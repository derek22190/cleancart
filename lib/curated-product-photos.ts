/**
 * Curated Product Photo & Barcode Registry
 * ----------------------------------------
 * Maps curated entries in `INSTANT_GROCERY_CATALOG`, `DRINKS_CATALOG`, `SEO_PRODUCTS`,
 * and `CLEAN_ALTERNATIVES` / `EXACT_PRODUCT_ALTERNATIVES` / `SECONDARY_CLEAN_ALTERNATIVES`
 * to verified direct Open Food Facts image URLs (`https://images.openfoodfacts.org/...`)
 * and UPC/EAN barcodes, falling back deterministically to brand-neutral studio art
 * (`imageKind: "category-art"`) or a brand-letter tile (`imageKind: "none"`).
 *
 * Safe to import from both Server and Client components.
 */

import curatedManifestRaw from "../data/curated-product-photos.json";
import { resolveCategoryStudioArt, type ImageKind } from "./category-art";

export interface CuratedPhotoRecord {
  barcode?: string;
  imageUrl?: string;
  verifiedAt?: string;
}

const curatedManifest = curatedManifestRaw as Record<string, CuratedPhotoRecord>;

const barcodeIndex = new Map<string, CuratedPhotoRecord>();
for (const rec of Object.values(curatedManifest)) {
  if (rec?.barcode && rec.imageUrl?.startsWith("https://")) {
    const cleanCode = rec.barcode.replace(/\D/g, "");
    if (cleanCode.length >= 8) {
      barcodeIndex.set(cleanCode, rec);
      if (cleanCode.length === 13 && cleanCode.startsWith("0")) {
        barcodeIndex.set(cleanCode.slice(1), rec);
      } else if (cleanCode.length === 12) {
        barcodeIndex.set(`0${cleanCode}`, rec);
      }
    }
  }
}

export function normalizeCuratedKeyText(raw?: string | null): string {
  return (raw || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Produces a stable canonical key (`brand::full_title`) where `full_title` avoids
 * duplicating `brand` when `title` already begins with `brand`.
 */
export function curatedPhotoKey(brand?: string | null, title?: string | null): string {
  const b = normalizeCuratedKeyText(brand);
  const t = normalizeCuratedKeyText(title);
  if (!b) return `::${t}`;
  if (!t) return `${b}::${b}`;
  const full = t === b || t.startsWith(`${b} `) ? t : `${b} ${t}`;
  return `${b}::${full}`;
}

/**
 * Extracts a numeric barcode (8-14 digits) from an Open Food Facts image URL path
 * such as `https://images.openfoodfacts.org/images/products/007/110/000/3116/front_en.7.400.jpg`.
 */
export function extractBarcodeFromOffImageUrl(url?: string | null): string | undefined {
  if (!url || !/openfoodfacts\.(?:org|net)\/images\/products\//i.test(url)) return undefined;
  const m = url.match(/\/images\/products\/([0-9/]+?)\/[^/]+$/i);
  if (!m) return undefined;
  const digits = m[1].replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 14 ? digits : undefined;
}

/**
 * Checks whether a URL is a direct verified product photo URL (excluding API proxy URLs,
 * local `/swaps/` or `/products/` category illustrations, and placeholder SVGs).
 */
export function isDirectVerifiedPhotoUrl(url?: string | null): url is string {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed.startsWith("https://")) return false;
  const lower = trimmed.toLowerCase();
  if (
    lower.includes("/api/product-image") ||
    lower.includes("product-photo-unavailable") ||
    lower.includes("placeholder")
  ) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    // Local heybroc.com `/swaps/` or `/products/` assets are category studio illustrations, not brand photos
    if (
      (host === "heybroc.com" || host === "www.heybroc.com") &&
      (parsed.pathname.startsWith("/swaps/") || parsed.pathname.startsWith("/products/"))
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function lookupCuratedPhoto(params: {
  brand?: string | null;
  title?: string | null;
  barcode?: string | null;
}): CuratedPhotoRecord | null {
  const cleanCode = (params.barcode || "").replace(/\D/g, "");
  if (cleanCode.length >= 8) {
    const byCode = barcodeIndex.get(cleanCode);
    if (byCode?.imageUrl && isDirectVerifiedPhotoUrl(byCode.imageUrl)) {
      return byCode;
    }
  }
  const key = curatedPhotoKey(params.brand, params.title);
  const direct = curatedManifest[key];
  if (direct?.imageUrl && isDirectVerifiedPhotoUrl(direct.imageUrl)) {
    return direct;
  }
  if (params.brand) {
    const titleOnlyKey = curatedPhotoKey("", params.title);
    const fallback = curatedManifest[titleOnlyKey];
    if (fallback?.imageUrl && isDirectVerifiedPhotoUrl(fallback.imageUrl)) {
      return fallback;
    }
  }
  return direct || null;
}

export interface ResolvedProductMedia {
  imageUrl: string | null;
  imageKind: ImageKind;
  categoryArtUrl: string | null;
  barcode?: string;
}

/**
 * Deterministic media resolver for curated items and client/server product payloads.
 * Returns `{ imageUrl, imageKind, categoryArtUrl, barcode }`.
 */
export function resolveProductMediaFields(params: {
  brand?: string | null;
  title?: string | null;
  barcode?: string | null;
  rawImageUrl?: string | null;
  storeImageUrl?: string | null;
  ingredients?: string | null;
  offCategoriesTags?: readonly string[] | null;
  explicitCategory?: string | null;
  /** Absolute origin prefix for category art when consumed by native/extension clients (e.g. "https://www.heybroc.com"). */
  assetOrigin?: string;
}): ResolvedProductMedia {
  const fullTitle =
    params.brand && params.title && !params.title.toLowerCase().includes(params.brand.toLowerCase())
      ? `${params.brand.trim()} ${params.title.trim()}`
      : (params.title || params.brand || "").trim();

  const relStudio = resolveCategoryStudioArt({
    title: fullTitle,
    ingredients: params.ingredients,
    offCategoriesTags: params.offCategoriesTags,
    explicitCategory: params.explicitCategory,
  });
  const origin = (params.assetOrigin || "").replace(/\/+$/, "");
  const categoryArtUrl = relStudio ? (origin ? `${origin}${relStudio}` : relStudio) : null;

  const storeImg = (params.storeImageUrl || "").trim();
  if (storeImg.startsWith("https://") || storeImg.startsWith("http://")) {
    return {
      imageUrl: storeImg,
      imageKind: "store-photo",
      categoryArtUrl,
      barcode: params.barcode || undefined,
    };
  }

  if (isDirectVerifiedPhotoUrl(params.rawImageUrl)) {
    return {
      imageUrl: params.rawImageUrl.trim(),
      imageKind: "photo",
      categoryArtUrl,
      barcode: params.barcode || extractBarcodeFromOffImageUrl(params.rawImageUrl) || undefined,
    };
  }

  const curated = lookupCuratedPhoto({
    brand: params.brand,
    title: params.title,
    barcode: params.barcode,
  });
  if (curated?.imageUrl && isDirectVerifiedPhotoUrl(curated.imageUrl)) {
    return {
      imageUrl: curated.imageUrl,
      imageKind: "photo",
      categoryArtUrl,
      barcode: params.barcode || curated.barcode || extractBarcodeFromOffImageUrl(curated.imageUrl),
    };
  }

  if (categoryArtUrl) {
    return {
      imageUrl: categoryArtUrl,
      imageKind: "category-art",
      categoryArtUrl,
      barcode: params.barcode || curated?.barcode || undefined,
    };
  }

  return {
    imageUrl: null,
    imageKind: "none",
    categoryArtUrl: null,
    barcode: params.barcode || curated?.barcode || undefined,
  };
}
