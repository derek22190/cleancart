#!/usr/bin/env tsx
/**
 * Step 1: Curated Product Photo & Barcode Backfill (`scripts/backfill-product-photos.ts`)
 * ---------------------------------------------------------------------------------------
 * Enumerates every curated product across:
 *   1. `INSTANT_GROCERY_CATALOG` (`lib/lookup.ts`)
 *   2. `DRINKS_CATALOG` (`lib/drinks-catalog.ts`)
 *   3. `SEO_PRODUCTS` (`lib/seo-catalog.ts`)
 *   4. All Clean Swap pools (`lib/swaps.ts`)
 *
 * Resolves Open Food Facts barcodes and direct `https://images.openfoodfacts.org/...`
 * front photos via either:
 *   - `--offline-report`: deterministic local coverage audit (zero network calls)
 *   - `--jsonl=<path>`: local Open Food Facts `.jsonl` / `.jsonl.gz` export stream
 *   - Live Open Food Facts API strictly rate-limited to <= 1 request every 6.2 seconds
 *     (`--max-queries=<N>` caps total live searches per run; default 150)
 *
 * Saves verified `{ barcode, imageUrl, verifiedAt }` records into `data/curated-product-photos.json`.
 */

import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";

// Allow importing server-only modules (`lib/lookup.ts`) from standalone CLI scripts
const origLoad = (
  Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown }
)._load;
(
  Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown }
)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};

interface CuratedTarget {
  pool: "main" | "drinks" | "seo" | "swaps";
  brand: string;
  title: string;
  key: string;
  existingBarcode?: string;
  existingImageUrl?: string;
  ingredients?: string;
}

interface OffImageMeta {
  rev?: string | number;
  sizes?: Record<string, unknown>;
}

interface OffRawProduct {
  code?: string;
  product_name?: string;
  product_name_en?: string;
  brands?: string;
  countries_tags?: string[];
  image_front_url?: string;
  image_url?: string;
  selected_images?: {
    front?: {
      display?: Record<string, string>;
      small?: Record<string, string>;
    };
  };
  images?: Record<string, OffImageMeta>;
}

const OFF_MIN_SPACING_MS = 6200; // <= 1 request every 6.2s (< 10/min)
const USER_AGENT = "HeyBroc/2.5 (https://www.heybroc.com; support@heybroc.com)";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function offFolderForBarcode(rawBarcode: string): string | null {
  const digits = rawBarcode.replace(/\D/g, "");
  if (digits.length < 8) return null;
  if (digits.length <= 8) return digits;
  const padded = digits.length < 13 ? digits.padStart(13, "0") : digits;
  return `${padded.slice(0, 3)}/${padded.slice(3, 6)}/${padded.slice(6, 9)}/${padded.slice(9)}`;
}

function normalizeOffUrl(url?: string | null): string | null {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim().replace(/^http:\/\//i, "https://");
  if (!/^https:\/\/images\.openfoodfacts\.(?:org|net)\/images\/products\//i.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/images\.openfoodfacts\.net/i, "images.openfoodfacts.org");
}

function isUsOrCanadaOffProduct(p: OffRawProduct): boolean {
  const tags = Array.isArray(p.countries_tags) ? p.countries_tags : [];
  if (tags.length === 0) return true;
  return tags.some((t) => /united-states|canada|world/i.test(String(t)));
}

function pickBestOffFrontUrl(p: OffRawProduct): string | null {
  const display = p.selected_images?.front?.display || {};
  const small = p.selected_images?.front?.small || {};

  // 1. Prefer English front photo
  const enFront = normalizeOffUrl(display.en || small.en);
  if (enFront) return enFront;

  // 2. Accept Spanish / French front when sold in US/CA and no English front exists (Step 7)
  if (isUsOrCanadaOffProduct(p)) {
    const regionalFront = normalizeOffUrl(display.es || display.fr || small.es || small.fr);
    if (regionalFront) return regionalFront;
  }

  // 3. Reconstruct from `images` map (`front_en` -> `front_es` -> `front_fr` -> raw numeric `"1"`)
  const code = String(p.code || "").replace(/\D/g, "");
  const folder = offFolderForBarcode(code);
  const imgs = p.images && typeof p.images === "object" ? p.images : null;
  if (folder && imgs) {
    const candidateKeys = isUsOrCanadaOffProduct(p)
      ? ["front_en", "front_es", "front_fr", "front"]
      : ["front_en", "front"];
    for (const k of candidateKeys) {
      const meta = imgs[k];
      const rev = meta?.rev !== undefined ? String(meta.rev) : "";
      if (rev && /^\d+$/.test(rev)) {
        return `https://images.openfoodfacts.org/images/products/${folder}/${k}.${rev}.400.jpg`;
      }
    }
    const numericKeys = Object.keys(imgs)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    if (numericKeys.length > 0) {
      const rawKey = numericKeys[0];
      return `https://images.openfoodfacts.org/images/products/${folder}/${rawKey}.400.jpg`;
    }
  }

  // 4. Generic `image_front_url` / `image_url` if English or numeric raw file
  for (const raw of [p.image_front_url, p.image_url]) {
    const norm = normalizeOffUrl(raw);
    if (!norm) continue;
    if (/\/(?:front_en|front_es|front_fr|\d+)\.(?:\d+\.)?\d+\.jpg$/i.test(norm)) {
      return norm;
    }
  }

  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const offlineReportOnly = args.includes("--offline-report");
  const jsonlArg = args.find((a) => a.startsWith("--jsonl="))?.slice("--jsonl=".length) || "";
  const maxQueriesRaw =
    args.find((a) => a.startsWith("--max-queries="))?.slice("--max-queries=".length) || "150";
  const maxQueries = Math.max(0, Number.parseInt(maxQueriesRaw, 10) || 0);

  const { INSTANT_GROCERY_CATALOG } = await import("../lib/lookup");
  const { DRINKS_CATALOG, hasProductIdentityMatch, passesVariantGuard } = await import(
    "../lib/drinks-catalog"
  );
  const { SEO_PRODUCTS } = await import("../lib/seo-catalog");
  const {
    CLEAN_ALTERNATIVES,
    EXACT_PRODUCT_ALTERNATIVES,
    STORE_SPECIFIC_OVERRIDES,
    WALMART_STORE_BRAND_ALTERNATIVES,
    SECONDARY_CLEAN_ALTERNATIVES,
    formatSwapFullTitle,
  } = await import("../lib/swaps");
  const { hasConflictingBrand } = await import("../lib/brands");
  const {
    curatedPhotoKey,
    extractBarcodeFromOffImageUrl,
    isDirectVerifiedPhotoUrl,
    resolveProductMediaFields,
  } = await import("../lib/curated-product-photos");

  const manifestPath = path.resolve(process.cwd(), "data/curated-product-photos.json");
  const manifest: Record<string, { barcode?: string; imageUrl?: string; verifiedAt?: string }> =
    fs.existsSync(manifestPath)
      ? (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<
          string,
          { barcode?: string; imageUrl?: string; verifiedAt?: string }
        >)
      : {};

  const targets: CuratedTarget[] = [];

  for (const item of INSTANT_GROCERY_CATALOG) {
    targets.push({
      pool: "main",
      brand: item.brand,
      title: item.title,
      key: curatedPhotoKey(item.brand, item.title),
      existingBarcode: item.barcode || extractBarcodeFromOffImageUrl(item.imageUrl),
      existingImageUrl: isDirectVerifiedPhotoUrl(item.imageUrl) ? item.imageUrl : undefined,
      ingredients: item.ingredients,
    });
  }

  for (const drink of DRINKS_CATALOG) {
    targets.push({
      pool: "drinks",
      brand: drink.brand,
      title: drink.title,
      key: curatedPhotoKey(drink.brand, drink.title),
      existingBarcode: drink.barcode || extractBarcodeFromOffImageUrl(drink.imageUrl),
      existingImageUrl: isDirectVerifiedPhotoUrl(drink.imageUrl) ? drink.imageUrl : undefined,
      ingredients: drink.ingredients,
    });
  }

  for (const seo of SEO_PRODUCTS) {
    targets.push({
      pool: "seo",
      brand: seo.brand,
      title: seo.title,
      key: curatedPhotoKey(seo.brand, seo.title),
      existingBarcode: seo.barcode || extractBarcodeFromOffImageUrl(seo.imageUrl),
      existingImageUrl: isDirectVerifiedPhotoUrl(seo.imageUrl) ? seo.imageUrl : undefined,
      ingredients: seo.ingredients,
    });
  }

  const allSwapAlts = [
    ...Object.values(CLEAN_ALTERNATIVES),
    ...EXACT_PRODUCT_ALTERNATIVES.map((e) => e.alt),
    ...Object.values(STORE_SPECIFIC_OVERRIDES).flatMap((list) => (list || []).map((e) => e.alt)),
    ...WALMART_STORE_BRAND_ALTERNATIVES.map((e) => e.alt),
    ...SECONDARY_CLEAN_ALTERNATIVES.flatMap((e) => e.alts),
  ];

  const seenSwapKeys = new Set<string>();
  for (const alt of allSwapAlts) {
    const fullTitle = formatSwapFullTitle(alt);
    const key = curatedPhotoKey(alt.brand, fullTitle);
    if (seenSwapKeys.has(key)) continue;
    seenSwapKeys.add(key);
    targets.push({
      pool: "swaps",
      brand: alt.brand,
      title: fullTitle,
      key,
      existingBarcode: alt.barcode || extractBarcodeFromOffImageUrl(alt.image),
      existingImageUrl: isDirectVerifiedPhotoUrl(alt.image) ? alt.image : undefined,
      ingredients: alt.ingredients,
    });
  }

  const todayIso = new Date().toISOString().slice(0, 10);

  // Sync any inline verified URLs/barcodes into the manifest first
  let updatedCount = 0;
  for (const t of targets) {
    const cur = manifest[t.key] || {};
    const nextBarcode = cur.barcode || t.existingBarcode;
    const nextImage = isDirectVerifiedPhotoUrl(cur.imageUrl) ? cur.imageUrl : t.existingImageUrl;
    if (
      (nextBarcode && nextBarcode !== cur.barcode) ||
      (nextImage && nextImage !== cur.imageUrl)
    ) {
      manifest[t.key] = {
        ...(nextImage ? { imageUrl: nextImage } : {}),
        ...(nextBarcode ? { barcode: nextBarcode } : {}),
        verifiedAt: cur.verifiedAt || todayIso,
      };
      updatedCount++;
    }
  }

  const matchesTargetCandidate = (t: CuratedTarget, p: OffRawProduct): boolean => {
    const candTitle = String(p.product_name_en || p.product_name || "").trim();
    const candBrand = String(p.brands || "").split(",")[0]?.trim() || "";
    if (!candTitle) return false;
    const query =
      t.brand && !t.title.toLowerCase().includes(t.brand.toLowerCase())
        ? `${t.brand} ${t.title}`.trim()
        : t.title;
    const fullCand = `${candBrand} ${candTitle}`.trim();
    if (!passesVariantGuard(query, fullCand)) return false;
    if (hasConflictingBrand(query, fullCand)) return false;
    if (t.brand && hasConflictingBrand(t.brand, fullCand)) return false;
    return hasProductIdentityMatch(query, fullCand);
  };

  // Optional JSONL stream pass (`--jsonl=<file>`)
  if (!offlineReportOnly && jsonlArg && fs.existsSync(jsonlArg)) {
    const missingByKey = new Map<string, CuratedTarget>();
    for (const t of targets) {
      if (!isDirectVerifiedPhotoUrl(manifest[t.key]?.imageUrl)) {
        missingByKey.set(t.key, t);
      }
    }
    if (missingByKey.size > 0) {
      console.log(
        `[backfill] Scanning local OFF JSONL (${jsonlArg}) for ${missingByKey.size} uncached targets...`
      );
      const rawStream = fs.createReadStream(jsonlArg);
      const lineStream = jsonlArg.endsWith(".gz")
        ? rawStream.pipe(zlib.createGunzip())
        : rawStream;
      const rl = readline.createInterface({ input: lineStream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim() || missingByKey.size === 0) continue;
        let prod: OffRawProduct;
        try {
          prod = JSON.parse(line) as OffRawProduct;
        } catch {
          continue;
        }
        if (!isUsOrCanadaOffProduct(prod)) continue;
        const bestUrl = pickBestOffFrontUrl(prod);
        if (!bestUrl) continue;
        const code = String(prod.code || "").replace(/\D/g, "");
        for (const [key, target] of missingByKey.entries()) {
          const targetCode = (manifest[key]?.barcode || target.existingBarcode || "").replace(
            /\D/g,
            ""
          );
          const isBarcodeExact =
            targetCode.length >= 8 &&
            (code === targetCode ||
              `0${code}` === targetCode ||
              code === `0${targetCode}`);
          if (isBarcodeExact || matchesTargetCandidate(target, prod)) {
            manifest[key] = {
              imageUrl: bestUrl,
              barcode: code || targetCode || undefined,
              verifiedAt: todayIso,
            };
            missingByKey.delete(key);
            updatedCount++;
          }
        }
      }
    }
  }

  // Live rate-limited OFF API pass (`<= 1` request every 6.2 seconds)
  if (!offlineReportOnly && !jsonlArg && maxQueries > 0) {
    const uniqueMissing = new Map<string, CuratedTarget>();
    for (const t of targets) {
      if (!isDirectVerifiedPhotoUrl(manifest[t.key]?.imageUrl) && !uniqueMissing.has(t.key)) {
        uniqueMissing.set(t.key, t);
      }
    }

    let queriesUsed = 0;
    let lastReqAt = 0;
    for (const [key, target] of uniqueMissing.entries()) {
      if (queriesUsed >= maxQueries) break;
      // Skip generic unbranded USDA whole-produce entries that intentionally use studio art
      if (/^(?:fresh produce|fresh meat|usda|produce)$/i.test(target.brand.trim())) {
        continue;
      }

      const elapsed = Date.now() - lastReqAt;
      if (lastReqAt > 0 && elapsed < OFF_MIN_SPACING_MS) {
        await sleep(OFF_MIN_SPACING_MS - elapsed);
      }

      const knownCode = (manifest[key]?.barcode || target.existingBarcode || "").replace(/\D/g, "");
      lastReqAt = Date.now();
      queriesUsed++;

      try {
        if (knownCode.length >= 8) {
          const byCodeRes = await fetch(
            `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(knownCode)}.json?fields=code,product_name,product_name_en,brands,countries_tags,image_front_url,image_url,selected_images,images`,
            {
              headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
              signal: AbortSignal.timeout(8000),
            }
          );
          if (byCodeRes.ok) {
            const payload = (await byCodeRes.json()) as {
              status?: number;
              product?: OffRawProduct;
            };
            if (payload.status === 1 && payload.product) {
              const bestUrl = pickBestOffFrontUrl({ ...payload.product, code: knownCode });
              if (bestUrl) {
                manifest[key] = {
                  imageUrl: bestUrl,
                  barcode: knownCode,
                  verifiedAt: todayIso,
                };
                updatedCount++;
                console.log(`  [hit:barcode] ${target.title} -> ${bestUrl}`);
                continue;
              }
            }
          }
        }

        const queryText =
          target.brand && !target.title.toLowerCase().includes(target.brand.toLowerCase())
            ? `${target.brand} ${target.title}`.trim()
            : target.title;
        const searchUrl = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(
          queryText
        )}&search_simple=1&action=process&json=1&page_size=10&fields=code,product_name,product_name_en,brands,countries_tags,image_front_url,image_url,selected_images,images`;
        const searchRes = await fetch(searchUrl, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          signal: AbortSignal.timeout(9000),
        });
        if (!searchRes.ok) continue;
        const searchJson = (await searchRes.json()) as { products?: OffRawProduct[] };
        const products = Array.isArray(searchJson.products) ? searchJson.products : [];
        for (const cand of products) {
          if (!isUsOrCanadaOffProduct(cand)) continue;
          if (!matchesTargetCandidate(target, cand)) continue;
          const bestUrl = pickBestOffFrontUrl(cand);
          if (!bestUrl) continue;
          const cleanCode =
            String(cand.code || "").replace(/\D/g, "") ||
            extractBarcodeFromOffImageUrl(bestUrl);
          manifest[key] = {
            imageUrl: bestUrl,
            ...(cleanCode ? { barcode: cleanCode } : {}),
            verifiedAt: todayIso,
          };
          updatedCount++;
          console.log(`  [hit:search] ${target.title} -> ${bestUrl}`);
          break;
        }
      } catch (err) {
        console.warn(
          `  [warn] OFF lookup failed for "${target.title}": ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  if (updatedCount > 0 && !offlineReportOnly) {
    const sortedKeys = Object.keys(manifest).sort();
    const sortedManifest: Record<
      string,
      { barcode?: string; imageUrl?: string; verifiedAt?: string }
    > = {};
    for (const k of sortedKeys) {
      sortedManifest[k] = manifest[k];
    }
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(sortedManifest, null, 2)}\n`, "utf8");
    console.log(`[backfill] Saved ${updatedCount} updates to ${manifestPath}`);
  }

  // Print deterministic coverage table across all 4 curated pools
  const stats: Record<
    CuratedTarget["pool"],
    { total: number; directPhoto: number; studioArt: number; missing: number }
  > = {
    main: { total: 0, directPhoto: 0, studioArt: 0, missing: 0 },
    drinks: { total: 0, directPhoto: 0, studioArt: 0, missing: 0 },
    seo: { total: 0, directPhoto: 0, studioArt: 0, missing: 0 },
    swaps: { total: 0, directPhoto: 0, studioArt: 0, missing: 0 },
  };

  for (const t of targets) {
    const rec = manifest[t.key];
    const resolved = resolveProductMediaFields({
      brand: t.brand,
      title: t.title,
      barcode: rec?.barcode || t.existingBarcode,
      rawImageUrl: rec?.imageUrl || t.existingImageUrl,
      ingredients: t.ingredients,
    });
    stats[t.pool].total++;
    if (resolved.imageKind === "photo") stats[t.pool].directPhoto++;
    else if (resolved.imageKind === "category-art") stats[t.pool].studioArt++;
    else stats[t.pool].missing++;
  }

  console.log("\n=== Curated Product Photo Coverage Summary ===");
  for (const [pool, s] of Object.entries(stats)) {
    const guaranteed = s.directPhoto + s.studioArt;
    console.log(
      `  ${pool.padEnd(8)} | total=${String(s.total).padStart(3)} | directPhoto=${String(
        s.directPhoto
      ).padStart(3)} | categoryStudioArt=${String(s.studioArt).padStart(
        3
      )} | guaranteedNonPlaceholder=${guaranteed}/${s.total}`
    );
  }
}

main().catch((err) => {
  console.error("[backfill] Fatal error:", err);
  process.exit(1);
});
