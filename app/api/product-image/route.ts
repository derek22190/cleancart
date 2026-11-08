import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const imageUrlCache = new Map<string, string>();
const imageBytesCache = new Map<string, { bytes: ArrayBuffer; contentType: string }>();

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function resolveRealProductImageUrl(rawQuery: string): Promise<string | null> {
  const clean = rawQuery
    .replace(/\b(\d+(\.\d+)?\s*(oz|fl\s*oz|lb|lbs|ct|count|pack|g|kg|ml|l|cup|bag|box|can|jar|bottle))\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cacheKey = clean.toLowerCase();
  const cached = imageUrlCache.get(cacheKey);
  if (cached) return cached;

  // 1. Primary: Bing Product Image Thumbnail (fast, reliable, covers Walmart/Marketside/Great Value/national brands)
  try {
    const searchQ = `${clean} grocery product package`;
    const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(searchQ)}&qft=+filterui:aspect-square&form=IRFLTR`;
    const res = await fetch(bingUrl, {
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(4500),
    });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/https:\/\/th\.bing\.com\/th\/id\/OIP\.[A-Za-z0-9_-]+/);
      if (match?.[0]) {
        const resolved = `${match[0]}?w=260&h=260&c=7&r=0&o=5&pid=1.7`;
        if (imageUrlCache.size > 1000) imageUrlCache.clear();
        imageUrlCache.set(cacheKey, resolved);
        return resolved;
      }
    }
  } catch {
    // Fall through to OpenFoodFacts
  }

  // 2. Fallback: OpenFoodFacts search
  try {
    const offUrl = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(clean)}&search_simple=1&action=process&json=1&page_size=3&fields=image_front_small_url,image_front_url`;
    const res = await fetch(offUrl, {
      headers: { "User-Agent": "HeyBroc/2.0 (https://www.heybroc.com)" },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        products?: Array<{ image_front_small_url?: string; image_front_url?: string }>;
      };
      const hit = (data.products || []).find((p) => p.image_front_small_url || p.image_front_url);
      const url = hit?.image_front_small_url || hit?.image_front_url;
      if (url) {
        imageUrlCache.set(cacheKey, url);
        return url;
      }
    }
  } catch {
    // Ignore
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
      },
    });
  }

  const targetUrl = await resolveRealProductImageUrl(q);
  if (targetUrl) {
    try {
      const imgRes = await fetch(targetUrl, {
        headers: { "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(4500),
      });
      if (imgRes.ok) {
        const contentType = imgRes.headers.get("content-type") || "image/jpeg";
        const bytes = await imgRes.arrayBuffer();
        if (bytes.byteLength > 200) {
          if (imageBytesCache.size > 400) imageBytesCache.clear();
          imageBytesCache.set(key, { bytes, contentType });
          return new NextResponse(bytes, {
            status: 200,
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "public, max-age=604800, immutable",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
      }
    } catch {
      // Fall through
    }
  }

  return new NextResponse("Not found", { status: 404 });
}
