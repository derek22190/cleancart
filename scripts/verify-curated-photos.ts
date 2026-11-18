#!/usr/bin/env tsx
/**
 * Step 8: Curated Photo HTTP 200 Verifier & Barcode Auto-Healer (`scripts/verify-curated-photos.ts`)
 * --------------------------------------------------------------------------------------------------
 * Verifies every direct `https://images.openfoodfacts.org/...` URL stored across:
 *   - `data/curated-product-photos.json`
 *   - `data/off-us-photo-index.json`
 *   - `lib/lookup.ts` (`INSTANT_GROCERY_CATALOG`)
 *   - `lib/drinks-catalog.ts` (`DRINKS_CATALOG`)
 *   - `lib/seo-catalog.ts` (`SEO_PRODUCTS`)
 *   - `lib/swaps.ts` (all Clean Swap pools)
 *   - `app/api/product-image/route.ts` (`VERIFIED_PRODUCT_IMAGES`)
 *
 * Distinguishes confirmed HTTP 404/410 deletions from transient CDN timeouts / 429 / 5xx so
 * temporary Open Food Facts slowness never prunes valid curated URLs. Forces IPv4 DNS resolution
 * so GitHub Actions (`ubuntu-latest`) runners never stall on broken IPv6 routes.
 *
 * Supports `--dry-run` for local URL syntax & studio-asset verification without network calls.
 */

import dns from "node:dns";
import fs from "node:fs";
import Module from "node:module";
import net from "node:net";
import path from "node:path";
import type { OffPhotoIndexTuple } from "../lib/off-photo-index";

dns.setDefaultResultOrder("ipv4first");
if (typeof net.setDefaultAutoSelectFamily === "function") {
  net.setDefaultAutoSelectFamily(false);
}

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
const OFF_IMAGE_CDN_SPACING_MS = 320;
const OFF_PRODUCT_READ_SPACING_MS = 4700; // <= 12.7 product reads/min (< 14/min limit)
const STRICT_OFF_PRODUCT_PHOTO_RE =
  /^https:\/\/images\.openfoodfacts\.(?:org|net)\/images\/products\/[0-9/]+\/[A-Za-z0-9_.-]+\.(?:jpg|jpeg|png|webp)$/i;
const OFF_PANEL_PATH_RE = /\/(?:ingredients|nutrition|packaging)(?:_|\.)/i;
const FOREIGN_NON_NA_FRONT_RE =
  /\/front_(?:de|it|nl|pl|pt|ru|ja|zh|ar|ro|hu|cs|sv|da|fi|el|tr|he|ko|th|vi)\./i;

type ImageCheckStatus = "ok" | "not_found" | "transient";

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

function isSafeOffFrontUrl(url?: string | null): url is string {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!STRICT_OFF_PRODUCT_PHOTO_RE.test(trimmed)) return false;
  if (OFF_PANEL_PATH_RE.test(trimmed) || FOREIGN_NON_NA_FRONT_RE.test(trimmed)) return false;
  return true;
}

async function checkImageOnce(url: string): Promise<ImageCheckStatus> {
  try {
    const headRes = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (headRes.status === 200) {
      return isSafeOffFrontUrl(headRes.url || url) ? "ok" : "transient";
    }
    if (headRes.status === 404 || headRes.status === 410) {
      return "not_found";
    }
    if (headRes.status === 405 || headRes.status === 403) {
      const getRes = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": USER_AGENT, Range: "bytes=0-1023" },
        redirect: "follow",
        signal: AbortSignal.timeout(10000),
      });
      await getRes.body?.cancel().catch(() => {});
      if (getRes.status === 200 || getRes.status === 206) {
        return isSafeOffFrontUrl(getRes.url || url) ? "ok" : "transient";
      }
      if (getRes.status === 404 || getRes.status === 410) {
        return "not_found";
      }
    }
    return "transient";
  } catch {
    return "transient";
  }
}

async function checkImageStatus(url: string): Promise<ImageCheckStatus> {
  const first = await checkImageOnce(url);
  if (first !== "transient") return first;
  await sleep(900);
  return checkImageOnce(url);
}

async function fetchReplacementPhotoByBarcode(
  barcode: string
): Promise<
  | { status: "healed"; url: string }
  | { status: "confirmed_missing" }
  | { status: "transient" }
> {
  const digits = barcode.replace(/\D/g, "");
  if (digits.length < 8) return { status: "confirmed_missing" };
  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(
        digits
      )}.json?fields=code,countries_tags,image_front_url,image_url,selected_images,images`,
      {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (res.status === 404) return { status: "confirmed_missing" };
    if (!res.ok) return { status: "transient" };
    const json = (await res.json()) as {
      status?: number;
      product?: {
        countries_tags?: string[];
        selected_images?: {
          front?: { display?: Record<string, string>; small?: Record<string, string> };
        };
        images?: Record<string, { imgid?: string | number; rev?: string | number }>;
        image_front_url?: string;
        image_url?: string;
      };
    };
    if (json.status !== 1 || !json.product) return { status: "confirmed_missing" };
    const p = json.product;
    const tags = Array.isArray(p.countries_tags)
      ? p.countries_tags.map((t) => String(t).trim().toLowerCase())
      : [];
    const allowEsFr =
      tags.length === 0 || tags.includes("en:united-states") || tags.includes("en:canada");

    const display = p.selected_images?.front?.display || {};
    const small = p.selected_images?.front?.small || {};
    const selectedPool = allowEsFr
      ? [display.en, small.en, display.es, display.fr, small.es, small.fr]
      : [display.en, small.en];
    for (const raw of selectedPool) {
      if (typeof raw === "string") {
        const normalized = raw.trim().replace(/images\.openfoodfacts\.net/i, "images.openfoodfacts.org");
        if (isSafeOffFrontUrl(normalized)) {
          return { status: "healed", url: normalized };
        }
      }
    }

    const folder = offFolderForBarcode(digits);
    const imgs = p.images && typeof p.images === "object" ? p.images : null;
    if (folder && imgs) {
      const panelImgIds = new Set<string>();
      for (const [k, meta] of Object.entries(imgs)) {
        if (/^(?:ingredients|nutrition|packaging)(?:_|$)/i.test(k) && meta?.imgid !== undefined) {
          panelImgIds.add(String(meta.imgid));
        }
      }
      const frontKeys = allowEsFr
        ? ["front_en", "front_es", "front_fr", "front"]
        : ["front_en", "front"];
      for (const k of frontKeys) {
        const rev = imgs[k]?.rev !== undefined ? String(imgs[k].rev) : "";
        if (rev && /^\d+$/.test(rev)) {
          const candidate = `https://images.openfoodfacts.org/images/products/${folder}/${k}.${rev}.400.jpg`;
          if (isSafeOffFrontUrl(candidate)) {
            return { status: "healed", url: candidate };
          }
        }
      }
      const rawNumeric = Object.keys(imgs)
        .filter((k) => /^\d+$/.test(k) && !panelImgIds.has(k))
        .sort((a, b) => Number(a) - Number(b));
      if (rawNumeric.length > 0) {
        const candidate = `https://images.openfoodfacts.org/images/products/${folder}/${rawNumeric[0]}.400.jpg`;
        if (isSafeOffFrontUrl(candidate)) {
          return { status: "healed", url: candidate };
        }
      }
    }
    return { status: "confirmed_missing" };
  } catch {
    return { status: "transient" };
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
    if (!url || typeof url !== "string") return;
    const trimmed = url.trim();
    if (!trimmed.startsWith("https://")) return;
    if (!isDirectVerifiedPhotoUrl(trimmed)) {
      throw new Error(`Invalid or non-OFF curated photo URL detected: ${trimmed}`);
    }
    const code = (barcode || extractBarcodeFromOffImageUrl(trimmed) || "").replace(/\D/g, "");
    if (!urlToBarcode.has(trimmed) || (!urlToBarcode.get(trimmed) && code)) {
      urlToBarcode.set(trimmed, code);
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
      if (!isSafeOffFrontUrl(url)) {
        throw new Error(`Unexpected non-OFF or panel curated photo URL: ${url}`);
      }
    }
    console.log(`[verify-photos] Dry-run syntax check passed for all ${urlToBarcode.size} URLs.`);
    return;
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const replacements = new Map<string, string>();
  const confirmedDeadUrls = new Set<string>();
  let okCount = 0;
  let transientCount = 0;
  let lastCdnCheckAt = 0;
  let lastOffApiReadAt = 0;

  for (const [url, barcode] of urlToBarcode.entries()) {
    const cdnElapsed = Date.now() - lastCdnCheckAt;
    if (lastCdnCheckAt > 0 && cdnElapsed < OFF_IMAGE_CDN_SPACING_MS) {
      await sleep(OFF_IMAGE_CDN_SPACING_MS - cdnElapsed);
    }
    lastCdnCheckAt = Date.now();

    const status = await checkImageStatus(url);
    if (status === "ok") {
      okCount++;
      continue;
    }
    if (status === "transient") {
      transientCount++;
      console.warn(`  [transient] Skipping prune on temporary CDN error/timeout for ${url}`);
      continue;
    }

    console.warn(`  [404/410] HTTP not found for ${url} (barcode=${barcode || "none"})`);
    if (!barcode) {
      confirmedDeadUrls.add(url);
      continue;
    }

    const elapsed = Date.now() - lastOffApiReadAt;
    if (lastOffApiReadAt > 0 && elapsed < OFF_PRODUCT_READ_SPACING_MS) {
      await sleep(OFF_PRODUCT_READ_SPACING_MS - elapsed);
    }
    lastOffApiReadAt = Date.now();

    const healRes = await fetchReplacementPhotoByBarcode(barcode);
    if (healRes.status === "transient") {
      transientCount++;
      console.warn(`  [transient] OFF Product API temporarily unavailable for barcode=${barcode}; keeping ${url}`);
      continue;
    }
    if (healRes.status === "healed") {
      const verifyHealed = await checkImageStatus(healRes.url);
      if (verifyHealed === "ok") {
        replacements.set(url, healRes.url);
        console.log(`  [healed] ${url} -> ${healRes.url}`);
        continue;
      }
      if (verifyHealed === "transient") {
        transientCount++;
        continue;
      }
    }
    confirmedDeadUrls.add(url);
  }

  const indexPath = path.resolve(process.cwd(), "data/off-us-photo-index.json");

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
      "app/api/product-image/route.ts",
    ];
    for (const relFile of sourceFiles) {
      const absFile = path.resolve(process.cwd(), relFile);
      if (!fs.existsSync(absFile)) continue;
      let text = fs.readFileSync(absFile, "utf8");
      let changed = false;
      for (const [oldUrl, newUrl] of replacements.entries()) {
        const quotedOld = JSON.stringify(oldUrl);
        const quotedNew = JSON.stringify(newUrl);
        if (text.includes(quotedOld)) {
          text = text.split(quotedOld).join(quotedNew);
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(absFile, text, "utf8");
      }
    }

    if (fs.existsSync(indexPath)) {
      const idxData = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
        version: number;
        generatedAt: string;
        entries: OffPhotoIndexTuple[];
      };
      let idxChanged = false;
      for (const [oldUrl, newUrl] of replacements.entries()) {
        const bc = extractBarcodeFromOffImageUrl(newUrl);
        const newFile = newUrl.split("/").pop() || "";
        if (!bc || !newFile) continue;
        for (const tuple of idxData.entries) {
          if (tuple[0] === bc && tuple[3] !== newFile && oldUrl.endsWith(`/${tuple[3]}`)) {
            tuple[3] = newFile;
            idxChanged = true;
          }
        }
      }
      if (idxChanged) {
        fs.writeFileSync(indexPath, `${JSON.stringify(idxData, null, 2)}\n`, "utf8");
      }
    }
  }

  // Only prune URLs that returned confirmed HTTP 404/410 AND confirmed missing on OFF Product API
  if (confirmedDeadUrls.size > 0) {
    let pruned = 0;
    for (const [key, rec] of Object.entries(manifest)) {
      if (rec.imageUrl && confirmedDeadUrls.has(rec.imageUrl)) {
        manifest[key] = {
          ...(rec.barcode ? { barcode: rec.barcode } : {}),
          verifiedAt: todayIso,
        };
        pruned++;
      }
    }
    if (pruned > 0) {
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }

    const catalogFiles = ["lib/lookup.ts", "lib/drinks-catalog.ts", "lib/seo-catalog.ts", "lib/swaps.ts"];
    for (const relFile of catalogFiles) {
      const absFile = path.resolve(process.cwd(), relFile);
      if (!fs.existsSync(absFile)) continue;
      let text = fs.readFileSync(absFile, "utf8");
      let changed = false;
      for (const deadUrl of confirmedDeadUrls) {
        const escaped = deadUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const lineRe = new RegExp(`^[ \\t]*(?:imageUrl|image):\\s*"${escaped}",?\\r?\\n`, "gm");
        const next = text.replace(lineRe, "");
        if (next !== text) {
          text = next;
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(absFile, text, "utf8");
      }
    }

    if (fs.existsSync(indexPath)) {
      const idxData = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
        version: number;
        generatedAt: string;
        entries: OffPhotoIndexTuple[];
      };
      const deadCodes = new Set(
        Array.from(confirmedDeadUrls)
          .map((u) => extractBarcodeFromOffImageUrl(u))
          .filter((c): c is string => Boolean(c))
      );
      const filtered = idxData.entries.filter((t) => !deadCodes.has(t[0]));
      if (filtered.length !== idxData.entries.length) {
        idxData.entries = filtered;
        fs.writeFileSync(indexPath, `${JSON.stringify(idxData, null, 2)}\n`, "utf8");
      }
    }

    console.warn(
      `[verify-photos] Pruned ${confirmedDeadUrls.size} confirmed-404 URLs across manifest/catalogs so studio category art renders cleanly.`
    );
  }

  console.log(
    `[verify-photos] Complete: ${okCount} healthy, ${replacements.size} auto-healed, ${transientCount} transient-skipped, ${confirmedDeadUrls.size} confirmed-dead pruned.`
  );
}

main().catch((err) => {
  console.error("[verify-photos] Fatal error:", err);
  process.exit(1);
});
