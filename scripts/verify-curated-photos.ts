#!/usr/bin/env tsx
/**
 * Step 8: Curated Photo HTTP 200 Verifier & Barcode Auto-Healer (`scripts/verify-curated-photos.ts`)
 * --------------------------------------------------------------------------------------------------
 * Verifies every direct `https://images.openfoodfacts.org/...` URL stored across:
 *   - `data/curated-product-photos.json`
 *   - `lib/lookup.ts` (`INSTANT_GROCERY_CATALOG`)
 *   - `lib/drinks-catalog.ts` (`DRINKS_CATALOG`)
 *   - `lib/seo-catalog.ts` (`SEO_PRODUCTS`)
 *   - `lib/swaps.ts` (all Clean Swap pools)
 *
 * When Open Food Facts rotates an image revision number (returning 404/410), this script
 * queries Open Food Facts Product API v2 by barcode (`<= 13` reads/min, >= 4.7s spacing),
 * verifies the replacement photo returns HTTP 200, and auto-heals the manifest and source files.
 *
 * Supports `--dry-run` for local URL syntax & local studio-asset verification without network calls.
 */

import fs from "node:fs";
import Module from "node:module";
import path from "node:path";

const origLoad = (
  Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown }
)._load;
(
  Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown }
)._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};

const USER_AGENT = "HeyBroc/2.5 (https://www.heybroc.com; support@heybroc.com)";
const OFF_PRODUCT_READ_SPACING_MS = 4700; // <= 12.7 product reads/min (< 14/min limit)

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

async function checkImageHttp200(url: string): Promise<boolean> {
  try {
    const headRes = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (headRes.status === 200) return true;
    if (headRes.status === 405 || headRes.status === 403) {
      const getRes = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": USER_AGENT, Range: "bytes=0-1023" },
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
      });
      return getRes.status === 200 || getRes.status === 206;
    }
    return false;
  } catch {
    return false;
  }
}

async function fetchReplacementPhotoByBarcode(barcode: string): Promise<string | null> {
  const digits = barcode.replace(/\D/g, "");
  if (digits.length < 8) return null;
  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(
        digits
      )}.json?fields=code,countries_tags,image_front_url,image_url,selected_images,images`,
      {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      status?: number;
      product?: {
        selected_images?: {
          front?: { display?: Record<string, string>; small?: Record<string, string> };
        };
        images?: Record<string, { rev?: string | number }>;
        image_front_url?: string;
        image_url?: string;
      };
    };
    if (json.status !== 1 || !json.product) return null;
    const p = json.product;
    const display = p.selected_images?.front?.display || {};
    const small = p.selected_images?.front?.small || {};
    for (const raw of [
      display.en,
      display.es,
      display.fr,
      small.en,
      small.es,
      small.fr,
    ]) {
      if (typeof raw === "string" && raw.startsWith("https://")) {
        return raw.replace(/images\.openfoodfacts\.net/i, "images.openfoodfacts.org");
      }
    }
    const folder = offFolderForBarcode(digits);
    const imgs = p.images && typeof p.images === "object" ? p.images : null;
    if (folder && imgs) {
      for (const k of ["front_en", "front_es", "front_fr", "front"]) {
        const rev = imgs[k]?.rev !== undefined ? String(imgs[k].rev) : "";
        if (rev && /^\d+$/.test(rev)) {
          return `https://images.openfoodfacts.org/images/products/${folder}/${k}.${rev}.400.jpg`;
        }
      }
      const rawNumeric = Object.keys(imgs)
        .filter((k) => /^\d+$/.test(k))
        .sort((a, b) => Number(a) - Number(b));
      if (rawNumeric.length > 0) {
        return `https://images.openfoodfacts.org/images/products/${folder}/${rawNumeric[0]}.400.jpg`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const { INSTANT_GROCERY_CATALOG } = await import("../lib/lookup");
  const { DRINKS_CATALOG } = await import("../lib/drinks-catalog");
  const { SEO_PRODUCTS } = await import("../lib/seo-catalog");
  const {
    CLEAN_ALTERNATIVES,
    EXACT_PRODUCT_ALTERNATIVES,
    STORE_SPECIFIC_OVERRIDES,
    WALMART_STORE_BRAND_ALTERNATIVES,
    SECONDARY_CLEAN_ALTERNATIVES,
  } = await import("../lib/swaps");
  const { extractBarcodeFromOffImageUrl, isDirectVerifiedPhotoUrl } = await import(
    "../lib/curated-product-photos"
  );

  const manifestPath = path.resolve(process.cwd(), "data/curated-product-photos.json");
  const manifest: Record<string, { barcode?: string; imageUrl?: string; verifiedAt?: string }> =
    fs.existsSync(manifestPath)
      ? (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<
          string,
          { barcode?: string; imageUrl?: string; verifiedAt?: string }
        >)
      : {};

  // Map every direct URL -> known barcode so broken links can be healed by barcode
  const urlToBarcode = new Map<string, string>();
  const registerUrl = (url?: string | null, barcode?: string | null) => {
    if (!isDirectVerifiedPhotoUrl(url)) return;
    const cleanUrl = url.trim();
    const code = (barcode || extractBarcodeFromOffImageUrl(cleanUrl) || "").replace(/\D/g, "");
    if (!urlToBarcode.has(cleanUrl) || (!urlToBarcode.get(cleanUrl) && code)) {
      urlToBarcode.set(cleanUrl, code);
    }
  };

  for (const rec of Object.values(manifest)) {
    registerUrl(rec.imageUrl, rec.barcode);
  }
  for (const item of INSTANT_GROCERY_CATALOG) {
    registerUrl(item.imageUrl, item.barcode);
  }
  for (const drink of DRINKS_CATALOG) {
    registerUrl(drink.imageUrl, drink.barcode);
  }
  for (const seo of SEO_PRODUCTS) {
    registerUrl(seo.imageUrl, seo.barcode);
  }
  const allSwapAlts = [
    ...Object.values(CLEAN_ALTERNATIVES),
    ...EXACT_PRODUCT_ALTERNATIVES.map((e) => e.alt),
    ...Object.values(STORE_SPECIFIC_OVERRIDES).flatMap((list) => (list || []).map((e) => e.alt)),
    ...WALMART_STORE_BRAND_ALTERNATIVES.map((e) => e.alt),
    ...SECONDARY_CLEAN_ALTERNATIVES.flatMap((e) => e.alts),
  ];
  for (const alt of allSwapAlts) {
    registerUrl(alt.image, alt.barcode);
  }

  console.log(`[verify-photos] Auditing ${urlToBarcode.size} distinct curated photo URLs...`);

  if (dryRun) {
    for (const [url] of urlToBarcode.entries()) {
      if (!url.startsWith("https://images.openfoodfacts.org/images/products/")) {
        throw new Error(`Unexpected non-OFF direct curated photo URL: ${url}`);
      }
    }
    console.log(`[verify-photos] Dry-run syntax check passed for all ${urlToBarcode.size} URLs.`);
    return;
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const replacements = new Map<string, string>();
  const unhealed: string[] = [];
  let okCount = 0;
  let lastOffApiReadAt = 0;

  for (const [url, barcode] of urlToBarcode.entries()) {
    const alive = await checkImageHttp200(url);
    if (alive) {
      okCount++;
      continue;
    }

    console.warn(`  [broken] HTTP check failed for ${url} (barcode=${barcode || "none"})`);
    if (!barcode) {
      unhealed.push(url);
      continue;
    }

    const elapsed = Date.now() - lastOffApiReadAt;
    if (lastOffApiReadAt > 0 && elapsed < OFF_PRODUCT_READ_SPACING_MS) {
      await sleep(OFF_PRODUCT_READ_SPACING_MS - elapsed);
    }
    lastOffApiReadAt = Date.now();

    const healedUrl = await fetchReplacementPhotoByBarcode(barcode);
    if (healedUrl && (await checkImageHttp200(healedUrl))) {
      replacements.set(url, healedUrl);
      console.log(`  [healed] ${url} -> ${healedUrl}`);
    } else {
      unhealed.push(url);
    }
  }

  if (replacements.size > 0) {
    for (const [key, rec] of Object.entries(manifest)) {
      if (rec.imageUrl && replacements.has(rec.imageUrl)) {
        manifest[key] = {
          ...rec,
          imageUrl: replacements.get(rec.imageUrl),
          verifiedAt: todayIso,
        };
      }
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const sourceFiles = [
      "lib/lookup.ts",
      "lib/drinks-catalog.ts",
      "lib/seo-catalog.ts",
      "lib/swaps.ts",
    ];
    for (const relFile of sourceFiles) {
      const absFile = path.resolve(process.cwd(), relFile);
      if (!fs.existsSync(absFile)) continue;
      let text = fs.readFileSync(absFile, "utf8");
      let changed = false;
      for (const [oldUrl, newUrl] of replacements.entries()) {
        if (text.includes(oldUrl)) {
          text = text.split(oldUrl).join(newUrl);
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(absFile, text, "utf8");
      }
    }
  }

  // If any broken URL could not be healed (e.g. OFF deleted the product photo completely),
  // prune the dead `imageUrl` from `data/curated-product-photos.json` so the entry cleanly falls back
  // to curated studio category art instead of serving a broken image!
  if (unhealed.length > 0) {
    const deadSet = new Set(unhealed);
    let pruned = 0;
    for (const [key, rec] of Object.entries(manifest)) {
      if (rec.imageUrl && deadSet.has(rec.imageUrl)) {
        const nextRec: { barcode?: string; verifiedAt?: string } = {
          ...(rec.barcode ? { barcode: rec.barcode } : {}),
          verifiedAt: todayIso,
        };
        manifest[key] = nextRec;
        pruned++;
      }
    }
    if (pruned > 0) {
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      console.warn(
        `[verify-photos] Pruned ${pruned} unhealable manifest URLs so studio category art renders cleanly.`
      );
    }
  }

  console.log(
    `[verify-photos] Complete: ${okCount} healthy, ${replacements.size} auto-healed, ${unhealed.length} unhealable.`
  );
}

main().catch((err) => {
  console.error("[verify-photos] Fatal error:", err);
  process.exit(1);
});
