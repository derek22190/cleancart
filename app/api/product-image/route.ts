import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const imageUrlCache = new Map<string, string>();
const imageBytesCache = new Map<string, { bytes: ArrayBuffer; contentType: string }>();

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_HOST_SUFFIXES = [".openfoodfacts.org", ".openfoodfacts.net"];

function isAllowedImageUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === "openfoodfacts.org" ||
      host === "openfoodfacts.net" ||
      ALLOWED_IMAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
    );
  } catch {
    return false;
  }
}

function localFallbackAssetForQuery(q: string): { relPath: string; contentType: string } {
  const s = q.toLowerCase();
  if (/\b(milk|lactaid|fairlife|oatly|malk|califia|silk|chobani\s+oat|ripple|darigold|core\s+power|premier\s+protein|muscle\s+milk|orgain|protein\s+shake|kefir|creamer|half\s+and\s+half|heavy\s+cream)\b/.test(s)) {
    return { relPath: "public/swaps/milk.png", contentType: "image/png" };
  }
  if (/\b(monster|red\s*bull|celsius|alani|ghost|c4|bang|reign|rockstar|prime|5[- ]?hour|zoa|nos|yerba\s+mate|guayaki|guayakí|pre[- ]?workout|preworkout|gorilla\s+mode|ryse|bucked\s+up|total\s+war|ora\s+organic|soda|cola|coke|coca[- ]?cola|pepsi|sprite|dr\.?\s*pepper|mountain\s+dew|mtn\s+dew|baja\s+blast|fanta|root\s+beer|a\s*&\s*w|barq|mug|ginger\s+ale|canada\s+dry|schweppes|7\s*up|crush|sunkist|starry|squirt|fresca|jarritos|olipop|poppi|zevia|culture\s+pop|water|fiji|evian|smartwater|dasani|aquafina|essentia|liquid\s+death|san\s+pellegrino|perrier|topo\s+chico|saratoga|spindrift|la\s*croix|waterloo|bubly|polar|nixie|hint|sparkling\s+ice|bai|juice|tropicana|simply|minute\s+maid|uncle\s+matt|mott|martinelli|welch|ocean\s+spray|pom\s+wonderful|lakewood|knudsen|capri\s*sun|kool[- ]?aid|hi[- ]?c|sunny\s*d|hawaiian\s+punch|tampico|naked\s+juice|bolthouse|suja|harmless\s+harvest|vita\s+coco|v8|lemonade|limeade|gatorade|powerade|bodyarmor|liquid\s+i\.?v\.?|lmnt|pedialyte|electrolit|biolyte|nuun|nooma|propel|vitaminwater|electrolyte|sports?\s+drink|energy\s+drink|coffee|frappuccino|cold\s+brew|stok|dunkin|la\s+colombe|tea|arizona|arnold\s+palmer|pure\s+leaf|gold\s+peak|snapple|brisk|ito\s+en|kombucha|gt'?s|health[- ]?ade)\b/.test(s)) {
    return { relPath: "public/swaps/drink.png", contentType: "image/png" };
  }
  if (/\b(syrup|maple|honey)\b/.test(s)) return { relPath: "public/swaps/syrup.png", contentType: "image/png" };
  if (/\b(eggs?|vital\s+farms)\b/.test(s)) return { relPath: "public/swaps/eggs.png", contentType: "image/png" };
  if (/\b(mac\s*(&|and)\s*cheese|macaroni)\b/.test(s)) return { relPath: "public/swaps/mac.png", contentType: "image/png" };
  if (/\b(pasta|spaghetti|penne|rigatoni|rotini|fettuccine|linguine|noodles?|ramen)\b/.test(s)) return { relPath: "public/swaps/pasta.png", contentType: "image/png" };
  if (/\b(yogurt|yoghurt|skyr)\b/.test(s)) return { relPath: "public/swaps/yogurt.jpg", contentType: "image/jpeg" };
  if (/\b(ice\s+cream|gelato|ben\s*&\s*jerry)\b/.test(s)) return { relPath: "public/swaps/icecream.png", contentType: "image/png" };
  if (/\b(butter|ghee|margarine|cheese|cheddar|mozzarella)\b/.test(s)) return { relPath: "public/swaps/butter.jpg", contentType: "image/jpeg" };
  if (/\b(chips|doritos|cheetos|takis|lays|ruffles|pringles|popcorn|pretzels)\b/.test(s)) return { relPath: "public/swaps/chips.jpg", contentType: "image/jpeg" };
  if (/\b(crackers|cheez[- ]?it|goldfish|ritz|triscuit|wheat\s+thins)\b/.test(s)) return { relPath: "public/swaps/crackers.jpg", contentType: "image/jpeg" };
  if (/\b(cereal|froot\s+loops|lucky\s+charms|cinnamon\s+toast|cheerios|oats|oatmeal|granola)\b/.test(s)) return { relPath: "public/swaps/cereal.jpg", contentType: "image/jpeg" };
  if (/\b(cookie|cookies|oreo|wafer)\b/.test(s)) return { relPath: "public/swaps/cookies.png", contentType: "image/png" };
  if (/\b(chocolate|hershey|reese|snickers|twix|m&m|kit\s*kat|brownie)\b/.test(s)) return { relPath: "public/swaps/chocolate.png", contentType: "image/png" };
  if (/\b(bread|bagel|bun|roll|tortilla|waffle|pancake|muffin|pastry|donut)\b/.test(s)) return { relPath: "public/swaps/bread.jpg", contentType: "image/jpeg" };
  if (/\b(ranch|dressing|mayo|mayonnaise|ketchup|mustard|bbq|sauce|marinara|salsa|soup|chowder|broth)\b/.test(s)) return { relPath: "public/swaps/ranch.jpg", contentType: "image/jpeg" };
  if (/\b(turkey|chicken|beef|pork|bacon|sausage|hot\s*dog|salami|ham|deli|meat)\b/.test(s)) return { relPath: "public/swaps/turkey.jpg", contentType: "image/jpeg" };
  return { relPath: "public/swaps/drink.png", contentType: "image/png" };
}

const STOP_TOKENS = new Set([
  "the", "and", "with", "for", "oz", "fl", "lb", "lbs", "ct", "count", "pack",
  "original", "classic", "organic", "natural", "flavored", "flavor", "pure",
  "grade", "category", "estimate", "verify", "package", "label", "rating", "ratings",
  "sweeteners", "sweetener", "creamery", "fresh", "each", "average", "price",
]);

function distinctiveTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t) && !/^\d+$/.test(t));
}

function hasProductIdentityMatch(query: string, candidateName: string, candidateBrands = ""): boolean {
  const qTokens = distinctiveTokens(query);
  const cTokens = distinctiveTokens(`${candidateBrands} ${candidateName}`);
  // Require at least 3 distinctive tokens (brand + specific product words) so generic category
  // labels like "Maple Syrup" never pull a random brand's bottle photo from Open Food Facts.
  if (qTokens.length < 3 || !cTokens.length) return false;
  const leadBrandToken = qTokens[0];
  const hasBrandMatch = cTokens.some(
    (ct) => ct === leadBrandToken || ct === `${leadBrandToken}s` || leadBrandToken === `${ct}s`
  );
  if (!hasBrandMatch) return false;
  const matched = qTokens.filter((qt) =>
    cTokens.some((ct) => ct === qt || ct === `${qt}s` || qt === `${ct}s`)
  );
  return matched.length / qTokens.length >= 0.7;
}

async function resolveRealProductImageUrl(rawQuery: string): Promise<string | null> {
  const clean = rawQuery
    .replace(/\(category\s+estimate[^)]*\)/gi, " ")
    .replace(/\b(natural\s+sweeteners|creamery\s+butter|conventional\s+grocery)\b/gi, " ")
    .replace(/\s*,\s*ratings?\b/gi, " ")
    .replace(/\b(\d+(\.\d+)?\s*(oz|fl\s*oz|lb|lbs|ct|count|pack|g|kg|ml|l|cup|bag|box|can|jar|bottle))\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cacheKey = clean.toLowerCase();
  if (distinctiveTokens(clean).length < 3) return null;
  const cached = imageUrlCache.get(cacheKey);
  if (cached) return cached;

  // OpenFoodFacts open-licensed product image lookup (ODbL / CC-BY-SA 3.0)
  try {
    const offUrl = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(clean)}&search_simple=1&action=process&json=1&page_size=5&fields=product_name,brands,image_front_small_url,image_front_url`;
    const res = await fetch(offUrl, {
      headers: { "User-Agent": "HeyBroc/2.0 (https://www.heybroc.com)" },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        products?: Array<{
          product_name?: string;
          brands?: string;
          image_front_small_url?: string;
          image_front_url?: string;
        }>;
      };
      const hit = (data.products || []).find(
        (p) =>
          (p.image_front_small_url || p.image_front_url) &&
          hasProductIdentityMatch(clean, p.product_name || "", p.brands || "")
      );
      const url = hit?.image_front_small_url || hit?.image_front_url;
      if (url && isAllowedImageUrl(url)) {
        if (imageUrlCache.size >= 1000) {
          const oldest = imageUrlCache.keys().next().value;
          if (oldest !== undefined) imageUrlCache.delete(oldest);
        }
        imageUrlCache.set(cacheKey, url);
        return url;
      }
    }
  } catch {
    // Ignore and fall through to local category asset
  }

  return null;
}

export async function GET(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "anon";
  if (!checkRateLimit(`img:${ip}`, 60)) {
    return new NextResponse("Too many requests", { status: 429 });
  }
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || "").trim().slice(0, 160);
  if (!q) {
    return new NextResponse("Missing query", { status: 400 });
  }

  const key = q.toLowerCase();
  const cachedBytes = imageBytesCache.get(key);
  if (cachedBytes) {
    return new NextResponse(cachedBytes.bytes, {
      status: 200,
      headers: {
        "Content-Type": cachedBytes.contentType,
        "Cache-Control": "public, max-age=604800, immutable",
        "Access-Control-Allow-Origin": "*",
        "X-Image-Source": "Open Food Facts (https://world.openfoodfacts.org)",
        "X-Image-License": "CC BY-SA 3.0 (https://world.openfoodfacts.org/terms-of-use)",
      },
    });
  }

  const targetUrl = await resolveRealProductImageUrl(q);
  if (targetUrl && isAllowedImageUrl(targetUrl)) {
    try {
      const imgRes = await fetch(targetUrl, {
        headers: { "User-Agent": "HeyBroc/2.0 (https://www.heybroc.com)" },
        signal: AbortSignal.timeout(4500),
      });
      if (imgRes.ok) {
        const contentType = imgRes.headers.get("content-type") || "image/jpeg";
        const contentLength = Number(imgRes.headers.get("content-length") || "0");
        if (contentType.startsWith("image/") && contentLength <= MAX_IMAGE_BYTES) {
          const bytes = await imgRes.arrayBuffer();
          if (bytes.byteLength > 200 && bytes.byteLength <= MAX_IMAGE_BYTES) {
            if (imageBytesCache.size >= 250) {
              const oldest = imageBytesCache.keys().next().value;
              if (oldest !== undefined) imageBytesCache.delete(oldest);
            }
            imageBytesCache.set(key, { bytes, contentType });
            return new NextResponse(bytes, {
              status: 200,
              headers: {
                "Content-Type": contentType,
                "Cache-Control": "public, max-age=604800, immutable",
                "Access-Control-Allow-Origin": "*",
                "X-Image-Source": "Open Food Facts (https://world.openfoodfacts.org)",
                "X-Image-License": "CC BY-SA 3.0 (https://world.openfoodfacts.org/terms-of-use)",
              },
            });
          }
        }
      }
    } catch {
      // Fall through to local fallback asset
    }
  }

  // 3. Guaranteed local fallback image so product cards never show broken images
  try {
    const fallback = localFallbackAssetForQuery(q);
    const buf = await fs.readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), fallback.relPath));
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": fallback.contentType,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
        "X-Image-Source": "HeyBroc Category Illustration",
        "X-Image-License": "Proprietary",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
