/**
 * Shared scan pipeline used by /api/scan and /api/audit.
 */
import "server-only";
import { isEnglishIngredientText, lookupIngredients, type LookupResult } from "./lookup";
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

import { evaluateDietaryAlerts, type DietaryAlert, type DietaryOptionId } from "./dietary";
export { evaluateDietaryAlerts, type DietaryAlert, type DietaryOptionId };

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
  format?: "json" | "ios_text";
  skipAnalytics?: boolean;
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
  return typeof s === "string" && (STORES as string[]).includes(s) ? (s as Store) : "walmart";
}

export { checkRateLimit, checkRateLimitAsync } from "./rate-limit";

export function detectStoreFromUrl(text: string): Store | undefined {
  const m = text.match(/https?:\/\/(?:www\.|m\.|new\.|shop\.)?([a-z0-9.-]+)/i);
  if (!m) return undefined;
  const host = m[1].toLowerCase();
  if (host.includes("walmart") || host.includes("walmrt")) return "walmart";
  if (host.includes("instacart")) return "instacart";
  if (host.includes("target")) return "target";
  if (host.includes("kroger")) return "kroger";
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

async function resolveRetailerShareUrlTitle(urlStr: string): Promise<string> {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "https:" || !isAllowedRetailerHost(parsed.hostname)) {
      return "";
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2600);
    try {
      const res = await fetch(parsed.toString(), {
        method: "GET",
        redirect: "follow",
        signal: ctrl.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if (res.url) {
        const finalUrl = new URL(res.url);
        if (!isAllowedRetailerHost(finalUrl.hostname)) return "";
        const redirectedSlug = extractTitleSlugFromUrl(res.url);
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
  /^(?:customers\s+also\s+(?:bought|viewed|shopped|considered)|similar\s+items?|compare\s+with\s+similar\s+items?|comparison\s+chart|frequently\s+bought\s+together|sponsored(?:\s+products?|\s+items?)?|products?\s+related\s+to\s+this\s+item|related\s+(?:products?|items?)|buy\s+(?:it\s+)?again|items?\s+to\s+add\s+next|recommended\s+for\s+you|you\s+may\s+also\s+like|more\s+to\s+consider|people\s+also\s+buy|shop\s+similar)\b/i;

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

export function normalizeIosShareOrOcrInput(
  rawTitle: string,
  rawIng: string,
  rawText = "",
): { title: string; candidates: string[]; extractedIngredients: string; detectedStore?: Store; sharedUrl?: string } {
  const combinedSource = rawTitle || rawText;
  const detectedStore = detectStoreFromUrl(combinedSource);
  let extractedIngredients = isolateSingleIngredientsBlock(rawIng);
  const ocrCandidates: string[] = [];

  const multiLineBlock = rawTitle.includes("\n") ? rawTitle : rawText.includes("\n") ? rawText : "";

  // Handle multi-line Screenshot OCR / multi-product rawText disambiguation
  if (multiLineBlock) {
    const allLines = multiLineBlock
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, " ").trim())
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
      const IOS_OCR_NOISE_LINE =
        /^(?:[\d:\s]*(?:am|pm)?\s*(?:5g|lte|wi-?fi|\d{1,3}%).*|\d{1,2}:\d{2}(?:\s*(?:am|pm))?|(?:5g|lte|wi-?fi)(?:\s+\d{1,3}%)?|\d{1,3}%|[<‹«←\s]*(?:back|close|cancel|done|share)\b.*|<+|search\b.*|home|cart|account|reorder|my items|lists?|scan\s*&\s*go.*|in-?club.*|curbside.*|delivery.*|pickup.*|shipping.*|free\s+(?:shipping|delivery|pickup).*|add to (?:cart|bag|basket|list|order)|buy now|clip coupon|sponsored|best seller|overall pick|popular pick|rollback|snap ebt.*|out of stock|in stock.*|many in stock|\$?\d+(?:\.\d{2})?(?:\s*\/?\s*(?:ea|oz|fl oz|lb|ct|pkg))?(?:\s*\(.*?\))?|\d+(?:\.\d+)?\s*¢\s*\/.*|\d\.\d\s*\(?[\d,]+\)?|\([\d,]+\)|product details|specifications|about this item|description|highlights|nutrition facts|reviews|ratings.*|similar items|often bought with|customers also.*|compare with similar.*|frequently bought together.*|ingredients\s*:?.*)$/i;
      const KNOWN_BRAND_LINE =
        /^(?:365 by whole foods market|whole foods market|member'?s mark|kirkland signature|great value|good\s*&\s*gather|favorite day|market pantry|up\s*&\s*up|simple truth(?:\s+organic)?|private selection|kroger|friendly farms|specially selected|simply nature|millville|clancy'?s|l'?oven fresh|park street deli|livegfree|kirkwood|appleton farms|southern grove|happy farms|season'?s choice|mama cozzi'?s|burman'?s|savoritz|boulder|wellsley farms|berkley jensen)$/i;
      // Only consider lines at or above the first Ingredients block as candidate titles for the focal product
      const titleSearchBound = firstIngLineIdx >= 0 ? firstIngLineIdx : scopedLines.length;
      for (let i = 0; i < titleSearchBound; i++) {
        const line = scopedLines[i];
        if (IOS_OCR_NOISE_LINE.test(line) || MULTI_PRODUCT_SECTION_BOUNDARY.test(line)) continue;
        if (KNOWN_BRAND_LINE.test(line) && i + 1 < titleSearchBound && !IOS_OCR_NOISE_LINE.test(scopedLines[i + 1])) {
          ocrCandidates.push(`${line} ${scopedLines[i + 1]}`.trim());
          i++;
          continue;
        }
        if (line.length >= 5 && line.length <= 160 && /[a-zA-Z]{3,}/.test(line)) {
          ocrCandidates.push(line);
        }
      }
      // If multiple candidate lines appeared before an explicit Ingredients block (e.g. top promo + focal item right above Ingredients),
      // keep the first clean product title and also include the line closest to Ingredients as fallback candidate
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
  const withoutUrl = rawTitle
    .replace(/https?:\/\/[^\s]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /^(?:(?:hey|hi|yo)\s*[,!.]*\s*)?(?:check\s+(?:this\s+)?out(?:\s+what\s+i\s+found|\s+this\s+item)?|i\s+found\s+this|look\s+what\s+i\s+found|see\s+what\s+i\s+found|thought\s+you(?:'d|\s+might)\s+like(?:\s+this)?)(?:\s+(?:at|on|from)\s+(?:walmart(?:\.com)?|sam'?s\s+club|target(?:\.com)?|costco(?:\.com)?|instacart|amazon(?:\.com|\s+fresh)?|aldi|kroger|whole\s+foods(?:\s+market)?|bj'?s(?:\s+wholesale)?|shipt|doordash|uber\s*eats))?\s*[:\-–—!.]*\s*/i,
      "",
    )
    .replace(/\s+(?:from|at|on)\s+(?:sam'?s\s+club|walmart|target|costco|instacart|amazon(?:\.com)?|aldi|kroger|whole\s+foods(?:\s+market)?)\s*[!.]*$/i, "")
    .trim();

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
  const finalTitle = withoutUrl || rawTitle;
  return { title: finalTitle, candidates: ocrCandidates.length ? ocrCandidates : [finalTitle], extractedIngredients, detectedStore };
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
  // If the caller/screen-reader provided a full store product title (3+ words), preserve it
  // so a store brand (e.g. "Great Value", "Wellsley Farms") is never overwritten by a different brand ("Dairy Pure").
  const shouldPrependBrand =
    callerWords.length < 3 &&
    found.brand &&
    !genericBrand.test(found.brand) &&
    !found.productTitle.toLowerCase().includes(found.brand.toLowerCase());
  const isAllLowerQuery = productTitle === productTitle.toLowerCase();
  const isCatalogPrefix = found.productTitle.toLowerCase().startsWith(productTitle.toLowerCase());
  const isCategoryEstimate = Boolean(found.brand && /category estimate/i.test(found.brand));
  const baseTitle = (
    found.source !== "catalog" && callerWords.length >= 3 && !isAllLowerQuery && !isCatalogPrefix
      ? productTitle
      : shouldPrependBrand
        ? `${found.brand} ${found.productTitle}`
        : found.productTitle
  ).trim();
  const title =
    isCategoryEstimate && !/category estimate/i.test(baseTitle)
      ? `${baseTitle} (Category Estimate)`
      : baseTitle;
  const result = scoreProductYuka(found.ingredients, watchlist, familyWatchlist, {
    ...found.nutrition,
    productTitle: `${productTitle} ${title}`.trim(),
  });
  const dietaryAlerts = evaluateDietaryAlerts(
    req.dietaryWatchlist,
    `${productTitle} ${title}`.trim(),
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
  const canAccessSwapLinks = isAnonDevice
    ? true
    : Boolean(entitlement && (entitlement.isProActive || entitlement.swapsRemaining > 0));
  const resolvedImageUrl =
    found.imageUrl && found.imageUrl.startsWith("http")
      ? found.imageUrl
      : `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(title)}&v=4`;
  const formatSwapWithAccess = (s: SwapResult): SwapResult => ({
    ...s,
    image:
      s.image && s.image.startsWith("http")
        ? s.image
        : `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(s.title)}&v=4`,
    ...(canAccessSwapLinks
      ? {}
      : {
          webUrl: undefined,
          deepLink: undefined,
          androidIntentUrl: undefined,
        }),
  });
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
      barcode: found.barcode,
      imageUrl: resolvedImageUrl,
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
    if (scan.swap.webUrl) lines.push(`${scan.swap.webUrl}${paidLabel}`);
  }
  return lines.join("\n");
}
