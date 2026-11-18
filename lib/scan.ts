/**
 * Shared scan pipeline used by /api/scan and /api/audit.
 */
import "server-only";
import type { ImageKind } from "./category-art";
import { resolveProductMediaFields } from "./curated-product-photos";
import { isEnglishIngredientText, lookupIngredients, type LookupResult } from "./lookup";
import { lookupOffPhotoIndex } from "./off-photo-index";
import {
  applyOrActivateReferral,
  getOrCreateDevice,
  serializeEntitlementWithPaidLookup,
  type EntitlementSummary,
} from "./referrals";
import { ALL_CATEGORIES, scoreProductYuka, type Category, type NutritionInput, type ScoreResult, type Watchlist } from "./rubric";
import {
  isAffiliateAllowedOnClient,
  resolveSwap,
  resolveSwapCandidates,
  STORES,
  STORE_META,
  type ClientPlatform,
  type ScanSurface,
  type Store,
  type SwapResult,
} from "./swaps";

import {
  classifyDietaryAlertSeverity,
  evaluateDietaryAlerts,
  type DietaryAlert,
  type DietaryAlertSeverity,
  type DietaryOptionId,
} from "./dietary";
export { classifyDietaryAlertSeverity, evaluateDietaryAlerts, type DietaryAlert, type DietaryAlertSeverity, type DietaryOptionId };

const VALID_CLIENT_PLATFORMS = new Set<ClientPlatform>([
  "web",
  "android",
  "chrome-extension",
  "ios-safari",
  "ios-share",
  "ios-shortcut",
  "ios-app",
]);

export function inferClientPlatform(params: {
  clientPlatform?: string;
  surface?: string;
  format?: string;
  deviceId?: string;
  origin?: string;
  userAgent?: string;
}): ClientPlatform {
  const rawLower = (params.clientPlatform || "").trim().toLowerCase();
  if (rawLower === "ios") return "ios-app";
  const rawPlatform = rawLower as ClientPlatform;
  if (VALID_CLIENT_PLATFORMS.has(rawPlatform)) {
    return rawPlatform;
  }
  const origin = (params.origin || "").trim().toLowerCase();
  if (origin.startsWith("safari-web-extension://")) return "ios-safari";
  if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) return "chrome-extension";
  if (origin.startsWith("capacitor://") || origin.startsWith("ionic://")) return "ios-app";

  if (params.format === "ios_text") return "ios-shortcut";

  const dev = (params.deviceId || "").trim().toLowerCase();
  if (dev.startsWith("ios-safari-")) return "ios-safari";
  if (dev.startsWith("ios-app-")) return "ios-app";
  if (dev.startsWith("ios-")) return "ios-share";
  if (dev.startsWith("ext-")) return "chrome-extension";

  const ua = (params.userAgent || "").trim();
  if (/Shortcuts|CFNetwork.*Darwin/i.test(ua)) return "ios-shortcut";
  if (/HeyBrocIOS|CleanCartIOS/i.test(ua) || (/(iPhone|iPad|iPod)/i.test(ua) && /Capacitor/i.test(ua))) {
    return "ios-app";
  }

  if (params.surface === "extension") return "chrome-extension";
  if (params.surface === "ios") return "ios-app";
  if (params.surface === "android") return "android";
  if (dev && dev !== "anon-web" && dev !== "anonymous" && !dev.startsWith("web-")) {
    return "android";
  }
  return "web";
}

export interface ScanRequest {
  productTitle?: string;
  rawIngredients?: string;
  rawText?: string;
  barcode?: string;
  store?: string;
  instacartRetailerSlug?: string;
  surface?: ScanSurface;
  clientPlatform?: ClientPlatform;
  watchlist?: Watchlist;
  familyWatchlist?: Category[];
  dietaryWatchlist?: string[];
  deviceId?: string;
  deviceSecret?: string;
  referredByCode?: string;
  preferStoreBrand?: boolean;
  authToken?: string;
  verifiedAccountPro?: boolean;
  format?: "json" | "ios_text";
  skipAnalytics?: boolean;
  isBatch?: boolean;
}

export interface ScanResponse {
  ok: true;
  product: {
    title: string;
    brand?: string;
    category?: string;
    description?: string;
    barcode?: string;
    imageUrl?: string;
    imageKind?: ImageKind;
    categoryArtUrl?: string | null;
    ingredients: string;
    nutrition?: NutritionInput;
  };
  lookup: {
    sourceUrl?: string;
    source: LookupResult["source"];
    origin?: LookupResult["origin"];
    sourceUpdatedAt?: string | null;
    ms: number;
  };
  result: ScoreResult;
  dietaryAlerts?: DietaryAlert[];
  alertSeverity?: import("./dietary").DietaryAlertSeverity;
  isCategoryEstimate?: boolean;
  swap: SwapResult | null;
  storeBrandSwap?: SwapResult | null;
  swapCandidates?: SwapResult[];
  store: Store;
  pill: string;
  entitlement?: EntitlementSummary;
}

export interface ScanError {
  ok: false;
  error: string;
  status: number;
}

export function parseStore(s?: unknown): Store {
  if (typeof s !== "string") return "walmart";
  const norm = s.trim().toLowerCase();
  if ((STORES as string[]).includes(norm)) return norm as Store;
  if (
    norm === "wholefoods" ||
    norm === "whole_foods" ||
    norm === "wholefoodsmarket" ||
    norm === "amazon_fresh" ||
    norm === "amazon:wholefoods" ||
    norm === "amazon:fresh" ||
    norm === "amazon:core"
  ) {
    return "amazon";
  }
  if (norm === "samsclub" || norm === "sams_club" || norm === "sam's club") return "sams";
  if (norm === "uber_eats" || norm === "uber-eats") return "ubereats";
  if (norm === "bjs_wholesale" || norm === "bj's") return "bjs";
  if (KROGER_BANNER_STORE_KEYS.has(norm)) {
    return "kroger";
  }
  return "walmart";
}

const KROGER_BANNER_STORE_KEYS = new Set([
  "kroger",
  "ralphs",
  "fredmeyer",
  "kingsoopers",
  "frysfood",
  "smithsfoodanddrug",
  "harristeeter",
  "qfc",
  "marianos",
  "picknsave",
  "metromarket",
  "metro-market",
  "dillons",
  "bakersplus",
  "citymarket",
  "foodsco",
  "foodscomarket",
  "food4less",
  "jaycfoods",
  "pay-less",
  "gerbes",
  "owensmarket",
  "rulerfoods",
]);

export const KROGER_BANNER_DOMAINS = [
  "kroger.com",
  "ralphs.com",
  "fredmeyer.com",
  "kingsoopers.com",
  "frysfood.com",
  "smithsfoodanddrug.com",
  "harristeeter.com",
  "qfc.com",
  "marianos.com",
  "picknsave.com",
  "metromarket.net",
  "metro-market.net",
  "dillons.com",
  "bakersplus.com",
  "citymarket.com",
  "foodsco.net",
  "foodscomarket.com",
  "food4less.com",
  "jaycfoods.com",
  "pay-less.com",
  "gerbes.com",
  "owensmarket.com",
  "rulerfoods.com",
] as const;

export { checkRateLimit, checkRateLimitAsync, checkRateLimitDetailedAsync } from "./rate-limit";

export function detectStoreFromUrl(text: string): Store | undefined {
  const m = text.match(/https?:\/\/(?:www\.|m\.|new\.|shop\.)?([a-z0-9.-]+)/i);
  if (!m) return undefined;
  const host = m[1].toLowerCase();
  if (host.includes("walmart") || host.includes("walmrt")) return "walmart";
  if (host.includes("instacart")) return "instacart";
  if (host.includes("target")) return "target";
  if (KROGER_BANNER_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return "kroger";
  }
  if (host.includes("aldi")) return "aldi";
  if (host.includes("doordash")) return "doordash";
  if (host.includes("ubereats")) return "ubereats";
  if (host.includes("amazon") || host === "a.co" || host === "amzn.to" || host.includes("wholefoods")) return "amazon";
  if (host.includes("samsclub")) return "sams";
  if (host.includes("bjs")) return "bjs";
  if (host.includes("costco")) return "costco";
  if (host.includes("shipt")) return "shipt";
  return undefined;
}

const URL_SLUG_PLACEHOLDER_TOKEN =
  /^(?:seort|seo|ip|p|dp|gp|d|s|product|products|item|items|store|stores|shop|browse|detail|ps|ref|-|\d+)$/i;

export function extractTitleSlugFromUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    const p = decodeURIComponent(u.pathname);
    const patterns: RegExp[] = [
      /\/ip\/([^/]+?)(?:\/\d+|\.html|$)/i, // Walmart / Sam's Club
      /\/p\/-\/([^/]+?)(?:\/\d+|$)/i, // Costco /p/-/slug/id
      /\/p\/([^/]+?)(?:\/-\/A-\d+|\/prod\d+|\/\d+|$)/i, // Target / Sam's / Kroger
      /\/([^/]+?)\.product\.\d+\.html/i, // Costco .product.id.html
      /\/([^/]+?)\/dp\/[A-Z0-9]{10}/i, // Amazon /slug/dp/ASIN
      /\/products?\/\d+-([^/]+)/i, // Instacart /products/12345-slug
      /\/detail\/ps\/p\/([^/]+)/i, // ALDI legacy
      /\/products?\/([^/]+?)(?:\/\d+|$)/i, // ALDI / Whole Foods / BJ's / Shipt
    ];
    for (const re of patterns) {
      const m = p.match(re);
      if (m?.[1]) {
        const cleaned = m[1]
          .replace(/[-_]+/g, " ")
          .replace(/\b(?:prod|item)?\d{6,}\b/gi, "")
          .replace(/\s+/g, " ")
          .trim();
        if (cleaned.length >= 3 && !URL_SLUG_PLACEHOLDER_TOKEN.test(cleaned)) {
          return cleaned;
        }
      }
    }
  } catch {
    /* ignore malformed URL */
  }
  return "";
}

const ALLOWED_RETAILER_SHARE_HOSTS = [
  "walmart.com",
  "walmrt.co",
  "target.com",
  "instacart.com",
  "kroger.com",
  "aldi.us",
  "samsclub.com",
  "costco.com",
  "bjs.com",
  "amazon.com",
  "a.co",
  "amzn.to",
  "wholefoodsmarket.com",
  "shipt.com",
  "doordash.com",
  "ubereats.com",
];

function isAllowedRetailerHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return ALLOWED_RETAILER_SHARE_HOSTS.some((base) => h === base || h.endsWith(`.${base}`));
}

function decodeBasicHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;/gi, "-")
    .replace(/&mdash;/gi, "-")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n >= 32 && n <= 126 ? String.fromCharCode(n) : " ";
    });
}

function extractSlugFromRedirectParam(urlObj: URL): string {
  for (const key of ["url", "u", "redirect", "target", "dest"]) {
    const rawParam = urlObj.searchParams.get(key);
    if (!rawParam) continue;
    const candidates = [rawParam];
    try {
      candidates.push(decodeURIComponent(rawParam));
    } catch {
      /* ignore malformed URI */
    }
    if (/^[A-Za-z0-9+/=_-]{12,}$/.test(rawParam)) {
      try {
        const b64 = rawParam.replace(/-/g, "+").replace(/_/g, "/");
        const decoded = Buffer.from(b64, "base64").toString("utf8");
        if (decoded.startsWith("/") || decoded.startsWith("https://")) {
          candidates.push(decoded);
        }
      } catch {
        /* ignore non-base64 */
      }
    }
    for (const c of candidates) {
      const full = c.startsWith("/") ? `https://${urlObj.hostname}${c}` : c;
      const slug = extractTitleSlugFromUrl(full);
      if (slug) return slug;
    }
  }
  return "";
}

async function resolveRetailerShareUrlTitle(urlStr: string): Promise<string> {
  try {
    let current = new URL(urlStr);
    if (current.protocol !== "https:" || !isAllowedRetailerHost(current.hostname)) {
      return "";
    }
    const directParamSlug = extractSlugFromRedirectParam(current);
    if (directParamSlug) return directParamSlug;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2800);
    try {
      let res: Response | null = null;
      for (let hop = 0; hop < 5; hop++) {
        res = await fetch(current.toString(), {
          method: "GET",
          redirect: "manual",
          signal: ctrl.signal,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
            Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
            "Accept-Language": "en-US,en;q=0.9",
          },
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          if (!loc) break;
          const nextUrl = new URL(loc, current);
          if (nextUrl.protocol !== "https:" || !isAllowedRetailerHost(nextUrl.hostname)) {
            return "";
          }
          const hopSlug = extractTitleSlugFromUrl(nextUrl.toString()) || extractSlugFromRedirectParam(nextUrl);
          if (hopSlug) return hopSlug;
          current = nextUrl;
          continue;
        }
        break;
      }
      if (!res) return "";
      if (res.url) {
        const finalUrl = new URL(res.url);
        if (!isAllowedRetailerHost(finalUrl.hostname)) return "";
        const redirectedSlug = extractTitleSlugFromUrl(res.url) || extractSlugFromRedirectParam(finalUrl);
        if (redirectedSlug) return redirectedSlug;
      }
      const html = (await res.text()).slice(0, 64_000);
      const ogMatch =
        html.match(/<meta[^>]+(?:property|name)=["'](?:og:title|twitter:title)["'][^>]+content=["']([^"']{4,220})["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']{4,220})["'][^>]+(?:property|name)=["'](?:og:title|twitter:title)["']/i) ||
        html.match(/<title[^>]*>([^<]{4,220})<\/title>/i);
      if (ogMatch?.[1]) {
        const cleaned = decodeBasicHtmlEntities(ogMatch[1])
          .replace(/^(?:amazon\.com\s*:\s*|walmart\.com\s*:\s*)/i, "")
          .replace(
            /\s*(?:[-|•:]\s*(?:walmart(?:\.com)?|target|instacart|sam'?s\s+club|costco|kroger|aldi|amazon(?:\.com)?|shipt|bjs\.com).*)$/i,
            "",
          )
          .replace(/\s+/g, " ")
          .trim();
        if (
          cleaned.length >= 4 &&
          !/^(?:robot\s+or\s+human|access\s+denied|just\s+a\s+moment|page\s+not\s+found|sign\s+in|verify\s+your\s+identity|walmart(?:\.com)?|target|amazon(?:\.com)?|instacart)$/i.test(
            cleaned,
          )
        ) {
          return cleaned;
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* network or timeout fallback */
  }
  return "";
}

const MULTI_PRODUCT_SECTION_BOUNDARY =
  /^(?:customers\s+also\s+(?:bought|viewed|shopped|considered)|similar\s+items?|compare\s+with\s+similar\s+items?|comparison\s+chart|frequently\s+bought\s+together|sponsored\s+(?:products?|items?)|products?\s+related\s+to\s+this\s+item|related\s+(?:products?|items?)|buy\s+(?:it\s+)?again|items?\s+to\s+add\s+next|recommended\s+for\s+you|you\s+may\s+also\s+like|more\s+to\s+consider|people\s+also\s+buy|shop\s+similar)\b/i;

const RETAILER_SHARE_BOILERPLATE_PHRASE_RE =
  /(?:^|\b)(?:(?:hey|hi|yo)\s*[,!.]*\s*)?(?:take\s+a\s+look\s+at\s+this(?:\s+item)?|look\s+at\s+this\s+item|check\s+(?:this\s+)?out(?:\s+what\s+i\s+found|\s+this\s+item)?|check\s+out\s+this\s+item|i\s+found\s+this(?:\s+item)?|look\s+what\s+i\s+found|see\s+what\s+i\s+found|here'?s\s+something\s+i\s+found|thought\s+you(?:'d|\s+might)\s+like(?:\s+this)?|shared\s+(?:from|via))(?:\s+(?:at|on|from|via)\s+(?:walmart(?:\.com)?|sam'?s\s+club|target(?:\.com)?|costco(?:\.com)?|instacart|amazon(?:\.com|\s+fresh)?|aldi|kroger|whole\s+foods(?:\s+market)?|bj'?s(?:\s+wholesale)?|shipt|doordash|uber\s*eats))?\s*[:\-–—!.,]*/gi;

export function stripRetailerShareBoilerplate(input: string): string {
  return input
    .replace(RETAILER_SHARE_BOILERPLATE_PHRASE_RE, " ")
    .replace(/\s+(?:from|at|on|via)\s+(?:sam'?s\s+club|walmart(?:\.com)?|target(?:\.com)?|costco(?:\.com)?|instacart|amazon(?:\.com)?|aldi|kroger|whole\s+foods(?:\s+market)?|bj'?s(?:\s+wholesale)?|shipt|doordash|uber\s*eats)\s*[!.]*$/i, "")
    .replace(/^(?:from|at|on|via)\s+(?:sam'?s\s+club|walmart(?:\.com)?|target(?:\.com)?|costco(?:\.com)?|instacart|amazon(?:\.com)?|aldi|kroger|whole\s+foods(?:\s+market)?|bj'?s(?:\s+wholesale)?|shipt|doordash|uber\s*eats)\s*[:\-–—!.]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectStoreFromOcrText(text: string): Store | undefined {
  if (/\b(?:walmart(?:\.com|\+)?|w\+\s*free\s+(?:delivery|shipping)|great\s+value|marketside|bettergoods|sam'?s\s+choice)\b/i.test(text)) {
    return "walmart";
  }
  if (/\b(?:sam'?s\s+club|member'?s\s+mark)\b/i.test(text)) return "sams";
  if (/\b(?:costco|kirkland\s+signature)\b/i.test(text)) return "costco";
  if (/\b(?:target\s+circle|good\s*&\s*gather|favorite\s+day|market\s+pantry)\b/i.test(text)) return "target";
  if (/\binstacart\b/i.test(text)) return "instacart";
  if (/\b(?:whole\s+foods\s+market|365\s+by\s+whole\s+foods)\b/i.test(text)) return "amazon";
  if (/\b(?:kroger|simple\s+truth|private\s+selection)\b/i.test(text)) return "kroger";
  if (/\b(?:aldi|simply\s+nature|specially\s+selected)\b/i.test(text)) return "aldi";
  return undefined;
}

function isolateSingleIngredientsBlock(rawIng: string): string {
  if (!rawIng) return "";
  let cleaned = rawIng.replace(/^\s*ingredients\s*:\s*/i, "");
  // If multiple "Ingredients:" blocks were concatenated across products on screen, keep only the first block!
  const secondIngMatch = cleaned.match(/(?:^|\n|[.;])\s*ingredients\s*:/i);
  if (secondIngMatch && secondIngMatch.index !== undefined && secondIngMatch.index >= 8) {
    cleaned = cleaned.slice(0, secondIngMatch.index);
  }
  cleaned = cleaned.split(
    /\n\s*(?:allergen|contains\b.*?(?:may contain|facility)|warnings?|directions|nutrition facts|distributed by|manufactured|customers\s+also|similar\s+items?|compare\s+with\s+similar|frequently\s+bought\s+together|sponsored\s+products?)/i
  )[0];
  return cleaned.replace(/\s+/g, " ").trim();
}

const OCR_PRESERVED_2LETTER_STEMS = new Set([
  "TV", "ID", "CD", "DJ", "PJ", "PC", "UV", "US", "UK", "EU", "UN", "GI", "OZ", "LB", "MG", "ML", "KG",
]);

function fixOcrShiftHoldTypos(s: string): string {
  return s.replace(/\b([A-Z])([A-Z])([a-z]{1,})\b/g, (full, c1: string, c2: string, rest: string) => {
    if (full === "PBfit") return full;
    if (rest === "s" && OCR_PRESERVED_2LETTER_STEMS.has(`${c1}${c2}`)) return full;
    return `${c1}${c2.toLowerCase()}${rest}`;
  });
}

export function normalizeIosShareOrOcrInput(
  rawTitle: string,
  rawIng: string,
  rawText = "",
): { title: string; candidates: string[]; extractedIngredients: string; detectedStore?: Store; sharedUrl?: string } {
  const combinedSource = [rawTitle, rawText].filter(Boolean).join("\n");
  const detectedStore = detectStoreFromUrl(combinedSource) ?? (rawText.includes("\n") || rawTitle.includes("\n") ? detectStoreFromOcrText(combinedSource) : undefined);
  let extractedIngredients = isolateSingleIngredientsBlock(rawIng);
  const ocrCandidates: string[] = [];

  const multiLineBlock = rawTitle.includes("\n") ? rawTitle : rawText.includes("\n") ? rawText : "";

  // Handle multi-line Screenshot OCR / multi-product rawText disambiguation
  if (multiLineBlock) {
    const allLines = multiLineBlock
      .split(/\r?\n/)
      .map((l) => fixOcrShiftHoldTypos(stripRetailerShareBoilerplate(l.replace(/\s+/g, " ").trim())))
      .filter(Boolean);

    // Slice off secondary recommendation carousels / comparison charts so unrelated products never bleed in
    const primaryLines: string[] = [];
    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i];
      if (i > 0 && MULTI_PRODUCT_SECTION_BOUNDARY.test(line)) {
        break;
      }
      primaryLines.push(line);
    }

    // If multiple products with their own "Ingredients:" blocks appear, isolate up to the end of the first Ingredients block
    let firstIngLineIdx = -1;
    let secondIngLineIdx = -1;
    for (let i = 0; i < primaryLines.length; i++) {
      if (/^ingredients\s*:?/i.test(primaryLines[i]) || /\bingredients\s*:\s*[a-z]/i.test(primaryLines[i])) {
        if (firstIngLineIdx === -1) firstIngLineIdx = i;
        else {
          secondIngLineIdx = i;
          break;
        }
      }
    }
    const scopedLines = secondIngLineIdx > 0 ? primaryLines.slice(0, secondIngLineIdx) : primaryLines;
    const scopedText = scopedLines.join("\n");

    if (!extractedIngredients) {
      const ingMatch = scopedText.match(/\bingredients\s*:?\s*([\s\S]{12,1500})/i);
      if (ingMatch?.[1]) {
        const candidateIng = isolateSingleIngredientsBlock(ingMatch[1]);
        if ((candidateIng.includes(",") || candidateIng.length >= 16) && candidateIng.length >= 12) {
          extractedIngredients = candidateIng;
        }
      }
    }

    if (rawTitle.includes("\n") || (!rawTitle && rawText)) {
      const SEARCH_RESULTS_HEADER_LINE =
        /^(?:\d[\d,+kKmM]*\+?\s+results\b.*|uses\s+item\s+details\b.*|price\s+when\s+purchased\s+online.*|results\s+for\s+.+)$/i;
      const IOS_OCR_NOISE_LINE =
        /^(?:off|on|[\d:\s]*(?:am|pm)?\s*(?:5g|lte|wi-?fi|\d{1,3}%).*|\d{1,2}:\d{2}(?:\s*(?:am|pm))?(?:\s+(?:off|on))?|(?:5g|lte|wi-?fi)(?:\s+\d{1,3}%)?|\d{1,3}%|[<‹«←\s]*(?:back|close|cancel|done|share)\b.*|<+|search\b.*|home|cart|account|reorder|my items|lists?|scan\s*&\s*go.*|in-?club.*|curbside.*|delivery.*|pickup.*|shipping.*|(?:w\+?\s*)?free\s+(?:shipping|delivery|pickup).*|add\s+to\s+(?:cart|bag|basket|list|order)|\+?\s*add|choose\s+options|select\s+options|options(?:\s+from\s+.*)?|single|\d+\s*pack|\d+\s*ct|rollbacks?(?:\s+new\s+arrivals.*)?|new\s+arrivals.*|bought\s+\d+\+?\s*times?|\d+[kKmM+]+\s+bought\b.*|uses\s+item\s+details.*|price\s+when\s+purchased\s+online.*|\d[\d,+kKmM]*\+?\s+results\b.*|buy now|clip coupon|sponsored|best seller|overall pick|popular pick|snap ebt.*|out of stock|in stock.*|many in stock|\$?\s*\d+(?:\.\d{2})?(?:\s+\$?\d+(?:\.\d{2})?\s*\/?\s*(?:ea|oz|fl\.?\s*oz|lb|ct|pkg))?(?:\s*\/?\s*(?:ea|oz|fl\.?\s*oz|lb|ct|pkg))?(?:\s*\(.*?\))?|\d+(?:\.\d+)?\s*¢\s*\/.*|\d\.\d\s*\(?[\d,]+\)?|\(?[\d,]+\)?|\d+\s+[a-z0-9.\s]+\b(?:st|street|rd|road|dr|drive|ave|avenue|blvd|ln|lane|way|pkwy|hwy)\b.*|product details|specifications|about this item|description|highlights|nutrition facts|reviews|ratings.*|similar items|often bought with|customers also.*|compare with similar.*|frequently bought together.*|ingredients\s*:?.*)$/i;
      const KNOWN_BRAND_LINE =
        /^(?:365 by whole foods market|whole foods market|member'?s mark|kirkland signature|great value|good\s*&\s*gather|favorite day|market pantry|up\s*&\s*up|simple truth(?:\s+organic)?|private selection|kroger|friendly farms|specially selected|simply nature|millville|clancy'?s|l'?oven fresh|park street deli|livegfree|kirkwood|appleton farms|southern grove|happy farms|season'?s choice|mama cozzi'?s|burman'?s|savoritz|boulder|wellsley farms|berkley jensen|quaker|bob'?s red mill|chobani|stonyfield|fage|siggi'?s|oikos|yoplait|dannon|activia)$/i;
      const ENDS_WITH_PACK_OR_SIZE_RE =
        /\b\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|oz|ounces?|lbs?|pounds?|g|grams?|kg|ml|l|liters?|ct|count|pk|packs?|packets?|bags?|tubs?|bottles?|cans?|boxes?|pouches?|bars?|cups?)\.?$/i;

      const titleSearchBound = firstIngLineIdx >= 0 ? firstIngLineIdx : scopedLines.length;
      // On search result screens (e.g. Walmart "1000+ Results / Uses item details"), skip the search bar & filter chips above the results header!
      let titleSearchStart = 0;
      for (let i = 0; i < Math.min(titleSearchBound, 14); i++) {
        if (SEARCH_RESULTS_HEADER_LINE.test(scopedLines[i]) && i + 1 < titleSearchBound) {
          titleSearchStart = i + 1;
        }
      }

      const collectCandidatesFromRange = (startIdx: number, endIdx: number) => {
        let i = startIdx;
        while (i < endIdx) {
          const line = scopedLines[i];
          if (IOS_OCR_NOISE_LINE.test(line) || MULTI_PRODUCT_SECTION_BOUNDARY.test(line)) {
            i++;
            continue;
          }
          // Merge wrapped multi-line mobile product card titles (e.g. "Quaker Maple & Brown" + "Sugar Flavor Instant" + "Oatmeal, 1.51 oz 20 Packets")
          const parts: string[] = [line];
          let j = i + 1;
          while (
            j < endIdx &&
            parts.length < 4 &&
            !ENDS_WITH_PACK_OR_SIZE_RE.test(parts[parts.length - 1]) &&
            !IOS_OCR_NOISE_LINE.test(scopedLines[j]) &&
            !MULTI_PRODUCT_SECTION_BOUNDARY.test(scopedLines[j])
          ) {
            const nextLine = scopedLines[j];
            if (nextLine.length < 3 || nextLine.length > 90 || !/[a-zA-Z]{2,}/.test(nextLine)) break;
            // Deduplicate standalone brand link immediately above a full brand+product title ("Chobani" + "Chobani Non-Fat Greek Yogurt")
            if (
              parts.length === 1 &&
              KNOWN_BRAND_LINE.test(parts[0]) &&
              nextLine.toLowerCase().startsWith(parts[0].toLowerCase())
            ) {
              parts[0] = nextLine;
            } else {
              parts.push(nextLine);
            }
            j++;
          }
          const merged = parts.join(" ").replace(/\s+/g, " ").trim();
          if (merged.length >= 5 && merged.length <= 200 && /[a-zA-Z]{3,}/.test(merged)) {
            ocrCandidates.push(merged);
          }
          i = j;
        }
      };

      collectCandidatesFromRange(titleSearchStart, titleSearchBound);
      if (ocrCandidates.length === 0 && titleSearchStart > 0) {
        collectCandidatesFromRange(0, titleSearchStart);
      }

      if (ocrCandidates.length > 0) {
        rawTitle = ocrCandidates[0];
      }
    }
  } else if (!extractedIngredients && rawText) {
    const ingMatch = rawText.match(/\bingredients\s*:?\s*([\s\S]{12,1500})/i);
    if (ingMatch?.[1]) {
      const candidateIng = isolateSingleIngredientsBlock(ingMatch[1]);
      if (candidateIng.length >= 12) {
        extractedIngredients = candidateIng;
      }
    }
    if (!rawTitle) {
      const beforeIng = rawText.split(/\bingredients\s*:/i)[0]?.trim() || "";
      rawTitle = beforeIng.split(/\s*[|•·]\s*/)[0]?.trim() || beforeIng;
    }
  }

  // Extract URL if present (iOS Share Sheet from Walmart, Target, Sam's Club, Costco, Amazon, Instacart, ALDI, Kroger)
  const urlMatch = combinedSource.match(/https?:\/\/[^\s"'<>]+/i);
  const sharedUrl = urlMatch?.[0] || "";
  const withoutUrl = stripRetailerShareBoilerplate(
    rawTitle
      .replace(/https?:\/\/[^\s]+/gi, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );

  if (withoutUrl && /[a-zA-Z]{2,}\s+[a-zA-Z0-9]{2,}/.test(withoutUrl)) {
    return {
      title: withoutUrl,
      candidates: ocrCandidates.length ? ocrCandidates : [withoutUrl],
      extractedIngredients,
      detectedStore,
      sharedUrl: sharedUrl || undefined,
    };
  }
  if (sharedUrl) {
    const slugTitle = extractTitleSlugFromUrl(sharedUrl);
    if (slugTitle) {
      return { title: slugTitle, candidates: [slugTitle], extractedIngredients, detectedStore, sharedUrl };
    }
    return { title: "", candidates: [], extractedIngredients, detectedStore, sharedUrl };
  }
  const finalTitle = withoutUrl || stripRetailerShareBoilerplate(rawTitle);
  return {
    title: finalTitle,
    candidates: ocrCandidates.length ? ocrCandidates : finalTitle ? [finalTitle] : [],
    extractedIngredients,
    detectedStore,
  };
}

export async function runScan(req: ScanRequest): Promise<ScanResponse | ScanError> {
  if (!req || typeof req !== "object" || Array.isArray(req)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object." };
  }
  if (
    (req.productTitle !== undefined && typeof req.productTitle !== "string") ||
    (req.rawIngredients !== undefined && typeof req.rawIngredients !== "string") ||
    (req.rawText !== undefined && typeof req.rawText !== "string") ||
    (req.barcode !== undefined && typeof req.barcode !== "string" && typeof req.barcode !== "number")
  ) {
    return { ok: false, status: 400, error: "productTitle, rawIngredients, rawText, and barcode must be strings." };
  }

  if (typeof req.rawIngredients === "string" && req.rawIngredients.length > 12_000) {
    return {
      ok: false,
      status: 413,
      error: "rawIngredients exceeds maximum length of 12,000 characters.",
    };
  }
  if (typeof req.rawText === "string" && req.rawText.length > 16_000) {
    return {
      ok: false,
      status: 413,
      error: "rawText exceeds maximum length of 16,000 characters.",
    };
  }
  if (
    typeof req.productTitle === "string" &&
    ((req.productTitle.length > 500 && !req.productTitle.includes("\n")) || req.productTitle.length > 8_000)
  ) {
    return {
      ok: false,
      status: 413,
      error: "productTitle exceeds maximum length of 500 characters.",
    };
  }

  const rawTitleOrig = typeof req.productTitle === "string" ? req.productTitle.trim() : "";
  const rawIngOrig = typeof req.rawIngredients === "string" ? req.rawIngredients.trim() : "";
  const rawTextOrig = typeof req.rawText === "string" ? req.rawText.trim() : "";
  const normalizedIos = normalizeIosShareOrOcrInput(rawTitleOrig, rawIngOrig, rawTextOrig);
  let rawTitleInput = normalizedIos.title;
  const rawIngredients = normalizedIos.extractedIngredients;
  const barcode =
    typeof req.barcode === "string" || typeof req.barcode === "number" ? String(req.barcode).trim().slice(0, 32) : "";

  if (
    !rawIngredients &&
    !barcode &&
    normalizedIos.sharedUrl &&
    (!rawTitleInput || /^https?:\/\//i.test(rawTitleInput))
  ) {
    const resolvedTitle = await resolveRetailerShareUrlTitle(normalizedIos.sharedUrl);
    if (resolvedTitle) {
      rawTitleInput = resolvedTitle;
      normalizedIos.candidates = [resolvedTitle];
    }
  }

  if (rawIngredients && !/[a-zA-Z]{2,}/.test(rawIngredients)) {
    return {
      ok: false,
      status: 422,
      error: "rawIngredients must contain valid alphabetic ingredient names.",
    };
  }

  // Reject pure store UI controls, quantity +/- steppers, variant labels ("Flavor: Blueberry"), cart headers ("Cart, (12 items)"),
  // addresses ("1034 Elmwood Dr", "Change delivery address...", "This isn't your preferred address..."),
  // barcode scanner buttons ("Opens barcode scanner"), delivery time slots ("Express, 68-98 min..."),
  // and promotional section headers/subtitles ("A full Thanksgiving meal, Turkey, classic sides & more.", "Thanksgiving feast for 4")
  const CART_CONTROL_OR_UI_NOISE =
    /^(?:[✓✔☑•·\s]*(?:bought\s+\d+\+?\s*times?.*|stay\s+stocked.*|last\s+purchased.*)|(?:flavor|size|style|color|colour|scent|count|pack|pack\s+size|variant|option|type|model|pattern|weight|material)\s*:\s*.+|cart\s*,?\s*\(\d+(?:\s+items?)?\)|in\s+\d+[kKmM]?\+?\s*people'?s?\s*c(?:arts?|a.*)|\d+[kKmM]?\+?\s*bought\b.*|options(?:\s+from\s+.*)?|(?:get\s+\$?\d+(?:\.\d{2})?\s+)?walmart\s+cash.*|manufacturer\s+offer.*|subscribe\s+to\s+save.*|one-time\s+purchase.*|recommended\s+for\s+you.*|items\s+that\s+pair\s+well\s+together.*|\d+\s+stars?\s+and\s+above.*|based\s+on\s+customer\s+ratings.*|tasty\s+os\b.*|.*\bmade\s+with\s+care$|unbranded|panera(?:\s+bread)?|blount(?:\s+clam\s+shack)?|(?:increase|decrease)\s+quantity\b.*|reserve\s+a\s+time.*|choose\s+a\s+time.*|select\s+a\s+time.*|book\s+a\s+time.*|hide\s+details.*|show\s+details.*|view\s+details.*|see\s+details.*|don'?t\s+forget.*|delivery\s+from\s+store.*|pickup\s+from\s+store.*|pickup\s+and\s+delivery.*|available\s+for\s+\d+\s+of\s+\d+\s+items.*|free\s+\d+-day\s+returns$|free\s+holiday\s+returns.*|gift\s+eligible.*|sold\s+by\s+.+|fulfilled\s+by\s+.+|sold\s+and\s+shipped\s+by\s+.+|arrives\s+(?:between|by)\s+.+|fees\s+may\s+apply.*|add\s+\$\d+.*|skip\s+the\s+order\s+min.*|bought\s+\d+\+?\s*times?.*|.*stay\s+stocked\s+and\s+subscribe.*|.*last\s+purchased\s+on.*|.*(?:straight\s+talk|google\s+pixel|pixel\s+\d+a?|tracfone|boost\s+mobile|cricket\s+wireless|total\s+wireless).*|choose\s+substitution.*|say\s+thanks\s+with\s+a\s+tip.*|product\s+information.*|items\s+to\s+add\s+next.*|many\s+in\s+stock.*|out\s+of\s+stock.*|snap\s+ebt\s+eligible$|pro\s+seller$|save\s+for\s+later$|move\s+to\s+cart$|remove$|delete$|opens?\s+barcode\s+scanner.*|.*barcode\s+scanner.*|.*preferred\s+address.*|change\s+(?:delivery\s+|pickup\s+|shipping\s+)?address.*|\d+\s+[a-z0-9.\s]+\b(?:st|street|rd|road|dr|drive|ave|avenue|blvd|boulevard|ln|lane|ct|court|pl|place|cir|circle|way|pkwy|parkway|hwy|highway|ter|terrace|trl|trail)\b.*|(?:express|today|tomorrow|asap)\s*,?\s*(?:\d+\s*[-–—]\s*\d+\s*min|\d+\s*(?:hr|hour|min)s?\s+or\s+less|\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)).*|.*,\s*was$|.*\b(?:\d+\s*[-–—]\s*\d+\s*min|\d+\s*(?:hr|hour|min)s?\s+or\s+less|\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm))\b.*|.*\bfree\s+with\s+(?:walmart\+?|\bw\+).*|.*\b(?:thanksgiving\s+meal|feast\s+for\s+\d+|classic\s+sides|meals?\s+made\s+easy|get\s+it\s+fast|household\s+essentials|grocery\s+list\s+staples|weekly\s+essentials|under\s+\$?\d+\s+per\s+person|shop\s+the\s+list|free\s+turkey|turkey\s+earned|pickup\s+benefit|benefit\s+has\s+been\s+applied|same-day\s+select|more\s+deliveries\s+for\s+less|unlimited\s+delivery|pay\s+once\s+for\s+a\s+year|groceries\s+delivered\s+right\s+to\s+your\s+door)\b.*|.*&\s*more\.?$|.*[!?])$/i;
  // On mobile accessibility overlay scans (where deviceId is supplied), reject standalone 1-word packaged brand logos
  // (e.g. "Cheerios" from top Sponsored banner ads, or standalone "Martin's" / "Velveeta" / "Great Value" brand links above titles)
  // so the app's candidate loop immediately advances to the full multi-word product title!
  const STANDALONE_BRAND_BANNER_LOGO =
    /^(?:cheerios|velveeta|martin'?s|thomas'?|dairypure|dairy\s+pure|great\s+value|marketside|freshness\s+guaranteed|bettergoods|sam'?s\s+choice|kirkland(?:\s+signature)?|wellsley\s+farms|berkley\s+jensen|member'?s\s+mark|good\s*&\s*gather|favorite\s+day|simple\s+truth|private\s+selection|kellogg'?s?|general\s+mills|post|quaker|nabisco|kraft|heinz|campbell'?s|progresso|rao'?s|barilla|prego|ragu|chobani|yoplait|dannon|stonyfield|fairlife|lactaid|sargento|tillamook|philadelphia|kerrygold|tyson|perdue|hormel|oscar\s+mayer|applegate|boar'?s\s+head|sara\s+lee|wonder|nature'?s\s+own|maple\s+syrup|pancake\s+syrup|specialty\s+syrup)$/i;
  const isMobileOverlayScan = typeof req.deviceId === "string" && req.deviceId.trim().length >= 4;
  if (
    !rawIngredients &&
    !barcode &&
    (CART_CONTROL_OR_UI_NOISE.test(rawTitleInput) ||
      (isMobileOverlayScan && STANDALONE_BRAND_BANNER_LOGO.test(rawTitleInput.trim())))
  ) {
    return { ok: false, status: 422, error: "Store UI control or duplicate cart action label ignored." };
  }

  const cleanCandidate = (s: string) =>
    s
      .replace(/^[✓✔☑•·\s]+/, "")
      .replace(/^.*?\b(remove from favorites|add to favorites)\s*[,•|\-]?\s*/i, "")
      .replace(/^(?:remove|delete|save\s+for\s+later|move\s+to\s+cart)\s*[,:•|\-]?\s+/i, "")
      .replace(/^\d+\s+in\s+(?:cart|bag|basket|order)\s*[,:•|\-–—]?\s*/i, "")
      .replace(/^\d+\s*(?:ct|count|pk|pack|ea)\s+(?=[a-zA-Z])/i, "")
      .replace(/^(?:quantity|qty)\s*:?\s*\d+\s*[,:•|\-]?\s*/i, "")
      .replace(/^(?:[✓✔]?\s*bought\s+\d+\+?\s*times?(?:\s*,\s*stay\s+stocked(?:\s+and\s+subscribe)?)?|best\s+seller|overall\s+pick|popular\s+pick|rollback|sponsored|save\s+for\s+later)\s*[,•|\-]?\s*/gi, "")
      .replace(/^(?:[✓✔]?\s*bought\s+\d+\+?\s*times?(?:\s*,\s*stay\s+stocked(?:\s+and\s+subscribe)?)?|best\s+seller|overall\s+pick|popular\s+pick|rollback|sponsored)\s*[,•|\-]?\s*/gi, "")
      .replace(/^\$\s*\d+(?:\.\d{2})?(?:\s*[,•|\-]?\s*\$\s*\d+(?:\.\d{2})?\s*\/?\s*(?:ea|oz|fl\s*oz|lb|ct)?)?\s*[,•|\-]?\s*/i, "")
      .replace(/\s*[,•|\-]?\s*(?:free\s+\d+-day\s+returns|free\s+holiday\s+returns.*|snap\s+ebt\s+eligible|gift\s+eligible.*|subscribe)$/gi, "")
      .replace(/\s*[.,•|\-]?\s*(?:rating|rated)?\s*\d+(?:\.\d+)?\s*out\s+of\s*5(?:\s*stars?)?(?:\s*[,•|\-.]?\s*\d[\d,]*\s*(?:reviews?|ratings?))?/gi, "")
      .replace(/\s*[.,•|\-]?\s*\bbased\s+on(?:\s+[\d,]+\s+ratings?|\s+customer\s+ratings?|\s+star\s+ratings?)?\s*[.,•|\-]*$/gi, "")
      .replace(/\s*[,•|\-]\s*ratings?\s*$/gi, "")
      .replace(/\s*[,•|\-]?\s*(?:average|avg)\s+price\b(?:\s*[:$]\s*\d+(?:\.\d{2})?)?/gi, "")
      .replace(/\b93%\s*lean\s*\/?\s*7%\s*fat\b/gi, "93% Lean/7% Fat")
      .replace(/\b80%\s*lean\s*\/?\s*20%\s*fat\b/gi, "80% Lean/20% Fat")
      .replace(/\b85%\s*lean\s*\/?\s*15%\s*fat\b/gi, "85% Lean/15% Fat")
      .replace(/\b73%\s*lean\s*\/?\s*27%\s*fat\b/gi, "73% Lean/27% Fat")
      .replace(/\btruffl(?:\.\.\.+|…|\b)/gi, "Truffles")
      .replace(/\bchocolat(?:\.\.\.+|…|\b)/gi, "Chocolate")
      .replace(/\bappl(?:\.\.\.+|…|\b)/gi, "Apples")
      .replace(/\bbism(?:ark['’]s?(?:\.\.\.+|…)?|a(?:\.\.\.+|…))/gi, "Bismark")
      .replace(/^smithfield,\s*boneless\s+cooked\s+hickory\s+smoked(?:\.\.\.+|…)?$/i, "Smithfield, Boneless Cooked Hickory Smoked Ham Steak")
      .replace(/\bwing\s+sa(?:\.\.\.+|…|\b)/gi, "Wing Sauce")
      .replace(/\band\s+re(?:\.\.\.+|…|\b)/gi, "and Reese's")
      .replace(/\s*,\s*serves\s+\d+(?:\s*[-–—]\s*\d+)?(?:\s*,\s*\d+\s*g\s+of\s+p[a-z]*(?:\.\.\.+|…)?)?\s*$/i, "")
      .replace(/\s*,\s*\d+\s*g\s+of\s+p[a-z]*(?:\.\.\.+|…)?\s*$/i, "")
      .replace(/\s*\(\d+(?:\.\d+)?\s*[a-z]{0,4}\s*(?:\.\.\.+|…)?\s*$/i, "")
      .replace(/\s*,\s*\d+\s*[a-z]{0,3}\s*(?:\.\.\.+|…)\s*$/i, "")
      .replace(/\.\.\.+$/, "")
      .replace(/…+$/, "")
      .replace(/\s*[.,•|\-]+\s*$/, "")
      .trim();

  let productTitle = cleanCandidate(rawTitleInput);

  if ((!productTitle || /^https?:\/\//i.test(productTitle)) && !rawIngredients && !barcode) {
    if (normalizedIos.sharedUrl) {
      return {
        ok: false,
        status: 422,
        error: "Could not read the product name from that short store link. Take a quick screenshot or include the product title.",
      };
    }
    return { ok: false, status: 400, error: "Provide productTitle, barcode, or rawIngredients." };
  }
  if (
    !rawIngredients &&
    !barcode &&
    (CART_CONTROL_OR_UI_NOISE.test(productTitle) ||
      (isMobileOverlayScan && STANDALONE_BRAND_BANNER_LOGO.test(productTitle)))
  ) {
    return { ok: false, status: 422, error: "Store UI control or duplicate cart action label ignored." };
  }
  if (rawIngredients && !isEnglishIngredientText(rawIngredients)) {
    return {
      ok: false,
      status: 422,
      error: "Only English ingredient lists are supported by the deterministic rubric.",
    };
  }

  const store = normalizedIos.detectedStore ?? parseStore(req.store);
  const watchlist =
    req.watchlist && typeof req.watchlist === "object" && !Array.isArray(req.watchlist) ? req.watchlist : undefined;
  const familyWatchlist = Array.isArray(req.familyWatchlist)
    ? req.familyWatchlist.filter((c): c is Category => typeof c === "string" && (ALL_CATEGORIES as string[]).includes(c))
    : undefined;

  const candidateList = normalizedIos.candidates
    .map(cleanCandidate)
    .filter((c) => c && !CART_CONTROL_OR_UI_NOISE.test(c))
    .slice(0, 4);
  if (!candidateList.length && productTitle) candidateList.push(productTitle);

  let found: LookupResult | null = null;
  for (const cand of candidateList.length ? candidateList : [productTitle]) {
    found = await lookupIngredients({
      productTitle: cand,
      barcode,
      rawIngredients,
      isBatch: req.isBatch,
    });
    if (found) {
      productTitle = cand;
      break;
    }
  }
  if (!found) {
    return {
      ok: false,
      status: 404,
      error: `No ingredient list found for "${productTitle || barcode}" on Open Food Facts or USDA. Try adding the brand name.`,
    };
  }
  const genericBrand = /^(conventional grocery|clean grocery verified|usda verified|fresh whole food|fresh produce|fresh meat & eggs|whole nuts, seeds & legumes|.*category estimate.*)$/i;
  const callerWords = productTitle.split(/\s+/).filter(Boolean);
  // Preserve caller's raw store title only when scoring direct screen-captured ingredients;
  // for validated OFF, USDA, DSLD, and catalog matches, always surface the canonical product title.
  const shouldPrependBrand =
    (found.source !== "screen" || callerWords.length < 3) &&
    Boolean(
      found.brand &&
      !genericBrand.test(found.brand) &&
      !found.productTitle.toLowerCase().includes(found.brand.toLowerCase()),
    );
  const isAllLowerQuery = productTitle === productTitle.toLowerCase();
  const isCatalogPrefix = found.productTitle.toLowerCase().startsWith(productTitle.toLowerCase());
  const isCategoryEstimate = Boolean(
    /category\s+estimate|representative(?:\s+category)?\s+formulation/i.test(
      `${found.brand || ""} ${found.productTitle || ""} ${found.description || ""}`,
    ),
  );
  const baseTitle = (
    found.source === "screen" && callerWords.length >= 3 && !isAllLowerQuery && !isCatalogPrefix
      ? productTitle
      : shouldPrependBrand
        ? `${found.brand} ${found.productTitle}`
        : found.productTitle
  ).trim();
  const title =
    isCategoryEstimate && !/category estimate/i.test(baseTitle)
      ? `${baseTitle} (Category Estimate)`
      : baseTitle;
  const scoringTitle =
    found.source === "screen" ? `${productTitle} ${title}`.trim() : title;
  const result = scoreProductYuka(found.ingredients, watchlist, familyWatchlist, {
    ...found.nutrition,
    productTitle: scoringTitle,
  });
  const dietaryAlerts = evaluateDietaryAlerts(
    req.dietaryWatchlist,
    scoringTitle,
    found.ingredients,
    found.nutrition,
  );
  const rawDev = typeof req.deviceId === "string" ? req.deviceId.trim() : "";
  const isAnonDevice =
    !rawDev || rawDev.length < 4 || /^(?:anon-web|anonymous|anon|null|undefined)$/i.test(rawDev);
  const effectiveDeviceId = isAnonDevice ? "anon-web" : rawDev;
  const clientPlatform = inferClientPlatform({
    clientPlatform: req.clientPlatform,
    surface: req.surface,
    format: req.format,
    deviceId: effectiveDeviceId,
  });
  const resolvedSurface: ScanSurface = !isAffiliateAllowedOnClient(req.surface ?? "web", clientPlatform)
    ? "extension"
    : req.surface === "android" || clientPlatform === "android"
      ? "android"
      : "web";
  const preferStoreBrand = req.preferStoreBrand === true;
  const swap = resolveSwap({
    score: result.score,
    productTitle: `${productTitle} ${title}`,
    ingredients: found.ingredients,
    nutrition: found.nutrition,
    store,
    watchlist,
    familyWatchlist,
    dietaryWatchlist: req.dietaryWatchlist,
    surface: resolvedSurface,
    clientPlatform,
    instacartRetailerSlug: req.instacartRetailerSlug,
    preferStoreBrand,
  });
  const rawSwapCandidates = resolveSwapCandidates({
    score: result.score,
    productTitle: `${productTitle} ${title}`,
    ingredients: found.ingredients,
    nutrition: found.nutrition,
    store,
    watchlist,
    familyWatchlist,
    dietaryWatchlist: req.dietaryWatchlist,
    surface: resolvedSurface,
    clientPlatform,
    instacartRetailerSlug: req.instacartRetailerSlug,
    preferStoreBrand,
    limit: 4,
  });
  let entitlement: EntitlementSummary | undefined;
  if (!isAnonDevice) {
    try {
      if (req.referredByCode) {
        const { device } = await applyOrActivateReferral({
          deviceId: effectiveDeviceId,
          referralCode: req.referredByCode,
          activateNow: false,
          deviceSecret: req.deviceSecret,
        });
        entitlement = await serializeEntitlementWithPaidLookup(device);
      } else {
        const device = await getOrCreateDevice(effectiveDeviceId, req.deviceSecret);
        entitlement = await serializeEntitlementWithPaidLookup(device);
      }
    } catch {
      entitlement = undefined;
    }
  }
  if (req.verifiedAccountPro && entitlement) {
    entitlement = { ...entitlement, isProActive: true };
  }
  const canAccessSwapLinks = isAnonDevice
    ? true
    : Boolean(req.verifiedAccountPro || (entitlement && (entitlement.isProActive || entitlement.swapsRemaining > 0)));
  const rawEffectiveBarcode = found.barcode || req.barcode?.replace(/\D/g, "") || "";
  const curatedMedia = resolveProductMediaFields({
    brand: found.brand,
    title,
    barcode: rawEffectiveBarcode,
    rawImageUrl: found.imageUrl,
    ingredients: found.ingredients,
    offCategoriesTags: found.offCategoriesTags,
    explicitCategory: found.category,
    assetOrigin: "https://www.heybroc.com",
  });
  let effectiveBarcode = curatedMedia.barcode || rawEffectiveBarcode;
  let resolvedImageUrl: string | undefined = curatedMedia.imageUrl || undefined;
  let resolvedImageKind: ImageKind = curatedMedia.imageKind;
  const resolvedCategoryArtUrl: string | null = curatedMedia.categoryArtUrl;

  const effectiveSource = found.source === "cache" ? (found.origin ?? "cache") : found.source;
  if (resolvedImageKind !== "photo" && !curatedMedia.knownMissingPhoto) {
    const offIndexHit = await lookupOffPhotoIndex({
      barcode: effectiveBarcode,
      title,
      brand: found.brand,
    });
    if (offIndexHit?.imageUrl) {
      resolvedImageUrl = offIndexHit.imageUrl;
      resolvedImageKind = "photo";
      if (!effectiveBarcode && offIndexHit.barcode) {
        effectiveBarcode = offIndexHit.barcode;
      }
    } else if (
      effectiveSource !== "catalog" &&
      effectiveSource !== "openfoodfacts" &&
      !isCategoryEstimate &&
      resolvedCategoryArtUrl !== null
    ) {
      resolvedImageUrl = `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(title)}${found.brand ? `&brand=${encodeURIComponent(found.brand)}` : ""}${effectiveBarcode ? `&code=${encodeURIComponent(effectiveBarcode)}` : ""}&fallback=404&v=7`;
      resolvedImageKind = "photo";
    }
  }

  const formatSwapWithAccess = (s: SwapResult): SwapResult => {
    const swapMedia =
      s.image && s.image.startsWith("http")
        ? {
            imageUrl: s.image,
            imageKind: s.imageKind || (s.image.includes("/swaps/") ? ("category-art" as ImageKind) : ("photo" as ImageKind)),
            categoryArtUrl: s.categoryArtUrl ?? (s.image.includes("/swaps/") ? s.image : null),
          }
        : resolveProductMediaFields({
            brand: s.brand,
            title: s.title,
            barcode: s.barcode,
            rawImageUrl: s.image,
            ingredients: s.ingredients,
            explicitCategory: s.category,
            assetOrigin: "https://www.heybroc.com",
          });
    return {
      ...s,
      image: swapMedia.imageUrl || swapMedia.categoryArtUrl || "",
      imageKind: swapMedia.imageKind,
      categoryArtUrl: swapMedia.categoryArtUrl,
      ...(canAccessSwapLinks
        ? {}
        : {
            webUrl: undefined,
            deepLink: undefined,
            androidIntentUrl: undefined,
            locked: true,
          }),
    };
  };
  const resolvedSwap: SwapResult | null = swap ? formatSwapWithAccess(swap) : null;
  const resolvedSwapCandidates: SwapResult[] = rawSwapCandidates.map(formatSwapWithAccess);
  // Ensure primary swap is first in swapCandidates if present and not already included
  if (
    resolvedSwap &&
    !resolvedSwapCandidates.some((c) => c.title.toLowerCase() === resolvedSwap.title.toLowerCase())
  ) {
    resolvedSwapCandidates.unshift(resolvedSwap);
  }
  let storeBrandSwap: SwapResult | null =
    resolvedSwapCandidates.find((c) => c.isStoreBrand) ??
    (resolvedSwap?.isStoreBrand ? resolvedSwap : null);
  if (!storeBrandSwap && !preferStoreBrand) {
    const sbCandidate = resolveSwap({
      score: result.score,
      productTitle: `${productTitle} ${title}`,
      ingredients: found.ingredients,
      nutrition: found.nutrition,
      store,
      watchlist,
      familyWatchlist,
      dietaryWatchlist: req.dietaryWatchlist,
      surface: resolvedSurface,
      clientPlatform,
      instacartRetailerSlug: req.instacartRetailerSlug,
      preferStoreBrand: true,
    });
    if (sbCandidate?.isStoreBrand) {
      storeBrandSwap = formatSwapWithAccess(sbCandidate);
    }
  }
  if (!req.skipAnalytics) {
    void import("./analytics")
      .then(({ trackServerEvent }) =>
        trackServerEvent({
          event: "product_scanned",
          distinctId: effectiveDeviceId,
          platform: clientPlatform.startsWith("ios-") ? "ios" : resolvedSurface,
          store,
          properties: {
            title: title.slice(0, 60),
            score: result.score,
            rating: result.rating,
            hasSwap: Boolean(resolvedSwap),
          },
        }),
      )
      .catch(() => {});
  }

  const alertSeverity = classifyDietaryAlertSeverity(dietaryAlerts);
  const pillText =
    dietaryAlerts.length > 0
      ? `⚠️ ${dietaryAlerts.slice(0, 2).map((a) => a.shortBadge).join(" + ")} • ${result.score}/100`
      : `${result.score}/100 • Tap to Inspect`;

  return {
    ok: true,
    product: {
      title,
      brand: found.brand,
      category: found.category,
      description: found.description,
      barcode: effectiveBarcode || found.barcode,
      imageUrl: resolvedImageUrl,
      imageKind: resolvedImageKind,
      categoryArtUrl: resolvedCategoryArtUrl,
      ingredients: found.ingredients,
      nutrition: found.nutrition,
    },
    lookup: {
      sourceUrl: found.sourceUrl,
      source: found.source,
      origin: found.origin,
      sourceUpdatedAt: found.sourceUpdatedAt,
      ms: found.ms,
    },
    result,
    ...(dietaryAlerts.length > 0 ? { dietaryAlerts } : {}),
    alertSeverity,
    isCategoryEstimate,
    swap: resolvedSwap,
    ...(storeBrandSwap ? { storeBrandSwap } : {}),
    ...(resolvedSwapCandidates.length > 0 ? { swapCandidates: resolvedSwapCandidates } : {}),
    store,
    pill: pillText,
    entitlement,
  };
}

/** Concise plain-text payload for iOS Shortcuts "Show Result" / notifications. */
export function toIosText(scan: ScanResponse): string {
  const r = scan.result;
  const dot = r.color === "green" ? "🟢" : r.color === "yellow" ? "🟡" : "🔴";
  const lines = [`${dot} ${r.score}/100 ${r.rating} — ${scan.product.title}`];
  if (scan.dietaryAlerts?.length) {
    for (const alert of scan.dietaryAlerts) {
      lines.push(`${alert.label}: ${alert.reason}`);
    }
  }
  if (r.flagged.length) {
    lines.push("", "⚠️ Flagged:");
    for (const f of r.flagged.slice(0, 6)) lines.push(`• ${f.name} (-${f.penalty}): ${f.explanation}`);
    if (r.flagged.length > 6) lines.push(`• +${r.flagged.length - 6} more`);
  } else if (!scan.dietaryAlerts?.length) {
    lines.push("", "✅ No watchlist additives found.");
  }
  if (scan.swap) {
    const paidLabel = scan.swap.isPaidLink ? " (paid link)" : "";
    const storeBrandTag = scan.swap.isStoreBrand ? " [💚 Store-Brand Value Pick]" : "";
    lines.push("", `🔁 Clean Swap at ${STORE_META[scan.store].label}${paidLabel}: ${scan.swap.title} (${scan.swap.score}/100)${storeBrandTag}`);
    if (scan.swap.flaggedAdditives?.length) {
      lines.push(`Note: contains ${scan.swap.flaggedAdditives.join(", ")}`);
    }
    if (scan.swap.webUrl) lines.push(`${scan.swap.webUrl}${paidLabel}`);
  }
  return lines.join("\n");
}

export interface BatchScanItemInput {
  id: string;
  productTitle?: string;
  barcode?: string;
}

export interface BatchScanResponse {
  ok: true;
  results: Record<string, ScanResponse | ScanError>;
}

const VALID_BATCH_ITEM_ID_RE = /^(?!^(?:__proto__|constructor|prototype)$)[A-Za-z0-9_-]{1,40}$/i;
export const MAX_BATCH_SCAN_ITEMS = 12;
const BATCH_ENTITLEMENT_TIMEOUT_MS = 900;

export const NON_FOOD_GRID_ITEM_RE =
  /\b(?:paper\s+towels?|toilet\s+(?:paper|tissue)|bath\s+tissue|facial\s+tissues?|trash\s+bags?|garbage\s+bags?|aluminum\s+foil|parchment\s+paper|plastic\s+wrap|paper\s+plates?|laundry\s+(?:detergent|pods?|sanitizer)|fabric\s+softener|dryer\s+sheets?|dish\s+(?:soap|detergent)|dishwasher\s+(?:pods?|pac?ks?|detergent)|disinfecting\s+wipes?|bleach|all[- ]purpose\s+cleaner|glass\s+cleaner|toilet\s+bowl\s+cleaner|air\s+freshener|diapers?|pull[- ]ups?|baby\s+wipes?|cat\s+litter|dog\s+(?:food|treats?|pads?)|cat\s+(?:food|treats?)|pet\s+food|alkaline\s+batteries|aa\s+batteries|aaa\s+batteries|motor\s+oil|windshield\s+washer|light\s+bulbs?|toothpaste|toothbrush|mouthwash|shampoo|body\s+wash|deodorant|antiperspirant|razor\s+blades?|shaving\s+cream|sunscreen|tampons?|maxi\s+pads?|pantiliners?)\b/i;

const PACKAGED_FOOD_CONTEXT_RE =
  /\b(?:chicken|beef|pork|turkey|fish|shrimp|salmon|tuna|sausage|bacon|meatballs?|peas|corn|berries|strawberries|blueberries|raspberries|fruit|vegetables?|broccoli|fries|tots|nuggets?|strips?|tenders?|wings?|pizza|burritos?|waffles?|pancakes?|peanut\s+butter|almond\s+butter|reese'?s|hershey'?s|chocolate|candy|fudge|caramel|ice\s+cream|gelato|sorbet|yogurt|pudding|oatmeal|oats|granola|cereal|soup|broth|rice|pasta|ravioli|dumplings?|popcorn|pretzels?|crackers?|cookies?|chips)\b/i;

const BAKING_CONDITIONER_CONTEXT_RE =
  /\b(?:dough|bread|bakery|flour|wheat|baking|gluten|food|meat|beer|wort)\b/i;

export function isNonFoodGridItemTitle(title: string): boolean {
  const s = (title || "").trim();
  if (!s) return false;
  if (NON_FOOD_GRID_ITEM_RE.test(s)) return true;
  if (/\b(?:storage\s+bags?|freezer\s+bags?|sandwich\s+bags?|paper\s+cups?)\b/i.test(s)) {
    if (!PACKAGED_FOOD_CONTEXT_RE.test(s)) return true;
  }
  if (/\bconditioner\b/i.test(s) && !BAKING_CONDITIONER_CONTEXT_RE.test(s)) {
    return true;
  }
  return false;
}

function stripGatedSwapLinks(s: SwapResult): SwapResult {
  return {
    ...s,
    webUrl: undefined,
    deepLink: undefined,
    androidIntentUrl: undefined,
    locked: true,
  };
}

/**
 * Scores up to 8 visible store product cards in a single request for On-Photo Score Badges.
 * Resolves device entitlement once per batch (with a 900ms fail-closed swap-link timeout) and sets
 * skipAnalytics: true so passive grid scrolling never inflates single-scan funnel events or consumes free swap unlocks.
 */
export async function runBatchScan(
  baseReq: ScanRequest,
  rawItems: BatchScanItemInput[],
): Promise<BatchScanResponse> {
  const results: Record<string, ScanResponse | ScanError> = Object.create(null);
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: true, results };
  }

  const validItems: Array<{ id: string; productTitle?: string; barcode?: string; normKey: string }> = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!VALID_BATCH_ITEM_ID_RE.test(id)) continue;
    const productTitle = typeof raw.productTitle === "string" ? raw.productTitle.trim().slice(0, 300) : "";
    const barcode = typeof raw.barcode === "string" ? raw.barcode.replace(/\D/g, "").slice(0, 32) : "";
    if (!productTitle && !barcode) continue;
    const normKey = `${productTitle.toLowerCase().replace(/\s+/g, " ")}|${barcode}`;
    validItems.push({
      id,
      productTitle: productTitle || undefined,
      barcode: barcode || undefined,
      normKey,
    });
    if (validItems.length >= MAX_BATCH_SCAN_ITEMS) break;
  }

  if (validItems.length === 0) {
    return { ok: true, results };
  }

  const rawDev = typeof baseReq.deviceId === "string" ? baseReq.deviceId.trim() : "";
  const isAnonDevice =
    !rawDev || rawDev.length < 4 || /^(?:anon-web|anonymous|anon|null|undefined)$/i.test(rawDev);
  const effectiveDeviceId = isAnonDevice ? "anon-web" : rawDev;
  const clientPlatform = inferClientPlatform({
    clientPlatform: baseReq.clientPlatform,
    surface: baseReq.surface,
    format: "json",
    deviceId: effectiveDeviceId,
  });

  let entitlement: EntitlementSummary | undefined;
  let entitlementTimedOut = false;
  if (!isAnonDevice) {
    const loadEntitlement = async (): Promise<{ ok: true; value?: EntitlementSummary }> => {
      try {
        if (baseReq.referredByCode) {
          const { device } = await applyOrActivateReferral({
            deviceId: effectiveDeviceId,
            referralCode: baseReq.referredByCode,
            activateNow: false,
            deviceSecret: baseReq.deviceSecret,
          });
          return { ok: true, value: await serializeEntitlementWithPaidLookup(device) };
        }
        const device = await getOrCreateDevice(effectiveDeviceId, baseReq.deviceSecret);
        return { ok: true, value: await serializeEntitlementWithPaidLookup(device) };
      } catch {
        return { ok: true, value: undefined };
      }
    };
    let timerId: ReturnType<typeof setTimeout> | undefined;
    try {
      const raced = await Promise.race([
        loadEntitlement(),
        new Promise<{ ok: false }>((resolve) => {
          timerId = setTimeout(() => resolve({ ok: false }), BATCH_ENTITLEMENT_TIMEOUT_MS);
        }),
      ]);
      if (raced.ok) {
        entitlement = raced.value;
      } else {
        entitlementTimedOut = true;
        entitlement = undefined;
      }
    } finally {
      if (timerId !== undefined) clearTimeout(timerId);
    }
  }
  if (baseReq.verifiedAccountPro && entitlement) {
    entitlement = { ...entitlement, isProActive: true };
  }
  const canAccessSwapLinks = entitlementTimedOut
    ? Boolean(baseReq.verifiedAccountPro)
    : isAnonDevice
      ? true
      : Boolean(baseReq.verifiedAccountPro || (entitlement && (entitlement.isProActive || entitlement.swapsRemaining > 0)));

  const uniqueByNorm = new Map<string, { productTitle?: string; barcode?: string }>();
  for (const it of validItems) {
    if (!uniqueByNorm.has(it.normKey)) {
      uniqueByNorm.set(it.normKey, { productTitle: it.productTitle, barcode: it.barcode });
    }
  }

  const resolvedByNorm = new Map<string, ScanResponse | ScanError>();
  const entries = Array.from(uniqueByNorm.entries());
  const CONCURRENCY = 5;
  let cursor = 0;

  const workers = Array.from({ length: Math.min(CONCURRENCY, entries.length) }, async () => {
    while (cursor < entries.length) {
      const idx = cursor++;
      const [normKey, target] = entries[idx];
      if (target.productTitle && !target.barcode && isNonFoodGridItemTitle(target.productTitle)) {
        resolvedByNorm.set(normKey, {
          ok: false,
          status: 422,
          error: "Non-food household item skipped.",
        });
        continue;
      }
      try {
        const single = await runScan({
          ...baseReq,
          productTitle: target.productTitle,
          barcode: target.barcode,
          rawIngredients: undefined,
          rawText: undefined,
          deviceId: undefined,
          clientPlatform,
          format: "json",
          skipAnalytics: true,
          isBatch: true,
        });
        if (single.ok) {
          const gated: ScanResponse = {
            ...single,
            entitlement,
            ...(canAccessSwapLinks
              ? {}
              : {
                  swap: single.swap ? stripGatedSwapLinks(single.swap) : null,
                  ...(single.storeBrandSwap ? { storeBrandSwap: stripGatedSwapLinks(single.storeBrandSwap) } : {}),
                  ...(single.swapCandidates
                    ? { swapCandidates: single.swapCandidates.map(stripGatedSwapLinks) }
                    : {}),
                }),
          };
          resolvedByNorm.set(normKey, gated);
        } else {
          resolvedByNorm.set(normKey, single);
        }
      } catch {
        resolvedByNorm.set(normKey, {
          ok: false,
          status: 500,
          error: "Batch item scan failed.",
        });
      }
    }
  });

  await Promise.all(workers);

  for (const it of validItems) {
    const out = resolvedByNorm.get(it.normKey);
    if (out) {
      results[it.id] = out;
    }
  }

  return { ok: true, results };
}

