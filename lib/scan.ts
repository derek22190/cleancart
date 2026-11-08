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
import { resolveSwap, STORES, STORE_META, type Store, type SwapResult } from "./swaps";

export interface ScanRequest {
  productTitle?: string;
  rawIngredients?: string;
  barcode?: string;
  store?: string;
  watchlist?: Watchlist;
  familyWatchlist?: Category[];
  deviceId?: string;
  referredByCode?: string;
  format?: "json" | "ios_text";
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
  lookup: { source: LookupResult["source"]; origin?: LookupResult["origin"]; ms: number };
  result: ScoreResult;
  swap: SwapResult | null;
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

const ipHits = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(ip: string, limitPerMin = 90): boolean {
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now > entry.resetAt) {
    if (ipHits.size > 5000) {
      for (const [k, v] of ipHits) {
        if (now > v.resetAt) ipHits.delete(k);
        if (ipHits.size <= 4000) break;
      }
      if (ipHits.size > 5000) {
        const oldest = ipHits.keys().next().value;
        if (oldest !== undefined) ipHits.delete(oldest);
      }
    }
    ipHits.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= limitPerMin;
}

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

function extractTitleSlugFromUrl(urlStr: string): string {
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
        return m[1]
          .replace(/[-_]+/g, " ")
          .replace(/\b(?:prod|item)?\d{6,}\b/gi, "")
          .replace(/\s+/g, " ")
          .trim();
      }
    }
  } catch {
    /* ignore malformed URL */
  }
  return "";
}

function normalizeIosShareOrOcrInput(
  rawTitle: string,
  rawIng: string,
): { title: string; candidates: string[]; extractedIngredients: string; detectedStore?: Store } {
  const detectedStore = detectStoreFromUrl(rawTitle);
  let extractedIngredients = rawIng;
  const ocrCandidates: string[] = [];

  // Handle multi-line iOS Shortcut Screenshot OCR ("Take Screenshot -> Extract Text from Image")
  if (rawTitle.includes("\n")) {
    if (!extractedIngredients) {
      const ingMatch = rawTitle.match(/\bingredients\s*:?\s*([\s\S]{12,1500})/i);
      if (ingMatch?.[1]) {
        const stopMatch = ingMatch[1].split(/\n(?:allergen|contains\b.*?(?:may contain|facility)|warnings?|directions|nutrition facts|distributed by|manufactured)/i)[0];
        const candidateIng = stopMatch.replace(/\s+/g, " ").trim();
        if (candidateIng.includes(",") && candidateIng.length >= 12) {
          extractedIngredients = candidateIng;
        }
      }
    }
    const rawLines = rawTitle
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const IOS_OCR_NOISE_LINE =
      /^(?:[\d:\s]*(?:am|pm)?\s*(?:5g|lte|wi-?fi|\d{1,3}%).*|\d{1,2}:\d{2}(?:\s*(?:am|pm))?|(?:5g|lte|wi-?fi)(?:\s+\d{1,3}%)?|\d{1,3}%|[<‹«←\s]*(?:back|close|cancel|done|share)\b.*|<+|search\b.*|home|cart|account|reorder|my items|lists?|scan\s*&\s*go.*|in-?club.*|curbside.*|delivery.*|pickup.*|shipping.*|free\s+(?:shipping|delivery|pickup).*|add to (?:cart|bag|basket|list|order)|buy now|clip coupon|sponsored|best seller|overall pick|popular pick|rollback|snap ebt.*|out of stock|in stock.*|many in stock|\$?\d+(?:\.\d{2})?(?:\s*\/?\s*(?:ea|oz|fl oz|lb|ct|pkg))?(?:\s*\(.*?\))?|\d+(?:\.\d+)?\s*¢\s*\/.*|\d\.\d\s*\(?[\d,]+\)?|\([\d,]+\)|product details|specifications|about this item|description|highlights|nutrition facts|reviews|ratings.*|similar items|often bought with|customers also.*)$/i;
    const KNOWN_BRAND_LINE =
      /^(?:365 by whole foods market|whole foods market|member'?s mark|kirkland signature|great value|good\s*&\s*gather|favorite day|market pantry|up\s*&\s*up|simple truth(?:\s+organic)?|private selection|kroger|friendly farms|specially selected|simply nature|millville|clancy'?s|l'?oven fresh|park street deli|livegfree|kirkwood|appleton farms|southern grove|happy farms|season'?s choice|mama cozzi'?s|burman'?s|savoritz|boulder|wellsley farms|berkley jensen)$/i;
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (IOS_OCR_NOISE_LINE.test(line)) continue;
      if (KNOWN_BRAND_LINE.test(line) && i + 1 < rawLines.length && !IOS_OCR_NOISE_LINE.test(rawLines[i + 1])) {
        ocrCandidates.push(`${line} ${rawLines[i + 1]}`.trim());
        i++;
        continue;
      }
      if (line.length >= 5 && line.length <= 160 && /[a-zA-Z]{3,}/.test(line)) {
        ocrCandidates.push(line);
      }
    }
    if (ocrCandidates.length > 0) {
      rawTitle = ocrCandidates[0];
    }
  }

  // Extract URL if present (iOS Share Sheet from Walmart, Target, Sam's Club, Costco, Amazon, Instacart, ALDI, Kroger)
  const urlMatch = rawTitle.match(/https?:\/\/[^\s]+/i);
  const sharedUrl = urlMatch?.[0] || "";
  const withoutUrl = rawTitle
    .replace(/https?:\/\/[^\s]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:check\s+(?:this\s+)?out(?:\s+this\s+item)?(?:\s+(?:at|on|from)\s+[a-z0-9.'\s]+?)?\s*[:\-–—!]?\s*)/i, "")
    .replace(/^(?:i\s+found\s+this|look\s+what\s+i\s+found)\s+(?:at|on|from)\s+[a-z0-9.'\s]+?\s*[:\-–—!]?\s*/i, "")
    .replace(/\s+(?:from|at|on)\s+(?:sam'?s\s+club|walmart|target|costco|instacart|amazon(?:\.com)?|aldi|kroger|whole\s+foods(?:\s+market)?)\s*[!.]*$/i, "")
    .trim();

  if (withoutUrl && /[a-zA-Z]{2,}\s+[a-zA-Z0-9]{2,}/.test(withoutUrl)) {
    return { title: withoutUrl, candidates: ocrCandidates.length ? ocrCandidates : [withoutUrl], extractedIngredients, detectedStore };
  }
  if (sharedUrl) {
    const slugTitle = extractTitleSlugFromUrl(sharedUrl);
    if (slugTitle) {
      return { title: slugTitle, candidates: [slugTitle], extractedIngredients, detectedStore };
    }
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
    (req.barcode !== undefined && typeof req.barcode !== "string" && typeof req.barcode !== "number")
  ) {
    return { ok: false, status: 400, error: "productTitle, rawIngredients, and barcode must be strings." };
  }

  if (typeof req.rawIngredients === "string" && req.rawIngredients.length > 12_000) {
    return {
      ok: false,
      status: 413,
      error: "rawIngredients exceeds maximum length of 12,000 characters.",
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
  const normalizedIos = normalizeIosShareOrOcrInput(rawTitleOrig, rawIngOrig);
  const rawTitleInput = normalizedIos.title;
  const rawIngredients = normalizedIos.extractedIngredients;
  const barcode =
    typeof req.barcode === "string" || typeof req.barcode === "number" ? String(req.barcode).trim().slice(0, 32) : "";

  if (rawIngredients && !/[a-zA-Z]{2,}/.test(rawIngredients)) {
    return {
      ok: false,
      status: 422,
      error: "rawIngredients must contain valid alphabetic ingredient names.",
    };
  }

  // Reject pure store UI controls, quantity +/- steppers, variant labels ("Flavor: Blueberry"), cart headers ("Cart, (12 items)"),
  // addresses ("1034 Elmwood Dr", "Change delivery address...", "This isn't your preferred address..."),
  // barcode scanner buttons ("Opens barcode scanner"), and delivery time slots ("Express, 68-98 min...", "Today, 3 hr or less...", "Today, 6pm-8pm, Free with Walmart+")
  const CART_CONTROL_OR_UI_NOISE =
    /^(?:[✓✔☑•·\s]*(?:bought\s+\d+\+?\s*times?.*|stay\s+stocked.*|last\s+purchased.*)|(?:flavor|size|style|color|colour|scent|count|pack|pack\s+size|variant|option|type|model|pattern|weight|material)\s*:\s*.+|cart\s*,?\s*\(\d+(?:\s+items?)?\)|in\s+\d+[kKmM]?\+?\s*people'?s?\s*c(?:arts?|a.*)|\d+[kKmM]?\+?\s*bought\b.*|options(?:\s+from\s+.*)?|(?:get\s+\$?\d+(?:\.\d{2})?\s+)?walmart\s+cash.*|manufacturer\s+offer.*|subscribe\s+to\s+save.*|(?:increase|decrease)\s+quantity\b.*|reserve\s+a\s+time.*|choose\s+a\s+time.*|select\s+a\s+time.*|book\s+a\s+time.*|hide\s+details.*|show\s+details.*|view\s+details.*|see\s+details.*|don'?t\s+forget.*|delivery\s+from\s+store.*|pickup\s+from\s+store.*|pickup\s+and\s+delivery.*|available\s+for\s+\d+\s+of\s+\d+\s+items.*|free\s+\d+-day\s+returns$|free\s+holiday\s+returns.*|gift\s+eligible.*|sold\s+by\s+.+|fulfilled\s+by\s+.+|sold\s+and\s+shipped\s+by\s+.+|arrives\s+(?:between|by)\s+.+|fees\s+may\s+apply.*|add\s+\$\d+.*|skip\s+the\s+order\s+min\s+fee.*|bought\s+\d+\+?\s*times?.*|.*stay\s+stocked\s+and\s+subscribe.*|.*last\s+purchased\s+on.*|.*(?:straight\s+talk|google\s+pixel|pixel\s+\d+a?|tracfone|boost\s+mobile|cricket\s+wireless|total\s+wireless).*|choose\s+substitution.*|say\s+thanks\s+with\s+a\s+tip.*|product\s+information.*|items\s+to\s+add\s+next.*|many\s+in\s+stock.*|out\s+of\s+stock.*|snap\s+ebt\s+eligible$|pro\s+seller$|save\s+for\s+later$|move\s+to\s+cart$|remove$|delete$|opens?\s+barcode\s+scanner.*|.*barcode\s+scanner.*|.*preferred\s+address.*|change\s+(?:delivery\s+|pickup\s+|shipping\s+)?address.*|\d+\s+[a-z0-9.\s]+\b(?:st|street|rd|road|dr|drive|ave|avenue|blvd|boulevard|ln|lane|ct|court|pl|place|cir|circle|way|pkwy|parkway|hwy|highway|ter|terrace|trl|trail)\b.*|(?:express|today|tomorrow|asap)\s*,?\s*(?:\d+\s*[-–—]\s*\d+\s*min|\d+\s*(?:hr|hour|min)s?\s+or\s+less|\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)).*|.*,\s*was$|.*\b(?:\d+\s*[-–—]\s*\d+\s*min|\d+\s*(?:hr|hour|min)s?\s+or\s+less|\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm))\b.*|.*\bfree\s+with\s+(?:walmart\+?|\bw\+).*|.*\?)$/i;
  if (!rawIngredients && !barcode && CART_CONTROL_OR_UI_NOISE.test(rawTitleInput)) {
    return { ok: false, status: 422, error: "Store UI control or duplicate cart action label ignored." };
  }

  const cleanCandidate = (s: string) =>
    s
      .replace(/^[✓✔☑•·\s]+/, "")
      .replace(/^.*?\b(remove from favorites|add to favorites)\s*[,•|\-]?\s*/i, "")
      .replace(/^(?:remove|delete|save\s+for\s+later|move\s+to\s+cart)\s*[,:•|\-]?\s+/i, "")
      .replace(/^\d+\s+in\s+(?:cart|bag|basket|order)\s*[,:•|\-–—]?\s*/i, "")
      .replace(/^(?:quantity|qty)\s*:?\s*\d+\s*[,:•|\-]?\s*/i, "")
      .replace(/^(?:[✓✔]?\s*bought\s+\d+\+?\s*times?(?:\s*,\s*stay\s+stocked(?:\s+and\s+subscribe)?)?|best\s+seller|overall\s+pick|popular\s+pick|rollback|sponsored|save\s+for\s+later)\s*[,•|\-]?\s*/gi, "")
      .replace(/^(?:[✓✔]?\s*bought\s+\d+\+?\s*times?(?:\s*,\s*stay\s+stocked(?:\s+and\s+subscribe)?)?|best\s+seller|overall\s+pick|popular\s+pick|rollback|sponsored)\s*[,•|\-]?\s*/gi, "")
      .replace(/^\$\s*\d+(?:\.\d{2})?(?:\s*[,•|\-]?\s*\$\s*\d+(?:\.\d{2})?\s*\/?\s*(?:ea|oz|fl\s*oz|lb|ct)?)?\s*[,•|\-]?\s*/i, "")
      .replace(/\s*[,•|\-]?\s*(?:free\s+\d+-day\s+returns|free\s+holiday\s+returns.*|snap\s+ebt\s+eligible|gift\s+eligible.*|subscribe)$/gi, "")
      .replace(/\.\.\.+$/, "")
      .trim();

  let productTitle = cleanCandidate(rawTitleInput);

  if (!productTitle && !rawIngredients && !barcode) {
    return { ok: false, status: 400, error: "Provide productTitle, barcode, or rawIngredients." };
  }
  if (!rawIngredients && !barcode && CART_CONTROL_OR_UI_NOISE.test(productTitle)) {
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
  const genericBrand = /^(conventional grocery|clean grocery verified|usda verified|fresh whole food)$/i;
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
  const title = (
    callerWords.length >= 3 && !isAllLowerQuery && !isCatalogPrefix
      ? productTitle
      : shouldPrependBrand
        ? `${found.brand} ${found.productTitle}`
        : found.productTitle
  ).trim();
  const result = scoreProductYuka(found.ingredients, watchlist, familyWatchlist, {
    ...found.nutrition,
    productTitle: `${productTitle} ${title}`.trim(),
  });
  const swap = resolveSwap({
    score: result.score,
    productTitle: `${productTitle} ${title}`,
    ingredients: found.ingredients,
    store,
    watchlist,
    familyWatchlist,
  });
  const effectiveDeviceId =
    typeof req.deviceId === "string" && req.deviceId.trim().length >= 4
      ? req.deviceId.trim()
      : "anon-web";
  let entitlement: EntitlementSummary | undefined;
  try {
    if (req.referredByCode && effectiveDeviceId !== "anon-web") {
      const { device } = await applyOrActivateReferral({
        deviceId: effectiveDeviceId,
        referralCode: req.referredByCode,
        activateNow: false,
      });
      entitlement = await serializeEntitlementWithPaidLookup(device);
    } else {
      const device = await getOrCreateDevice(effectiveDeviceId);
      entitlement = await serializeEntitlementWithPaidLookup(device);
    }
  } catch {
    entitlement = undefined;
  }
  const canAccessSwapLinks = !entitlement || entitlement.isProActive || entitlement.swapsRemaining > 0;
  const resolvedImageUrl =
    found.imageUrl && found.imageUrl.startsWith("http")
      ? found.imageUrl
      : `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(title)}`;
  const resolvedSwap: SwapResult | null = swap
    ? {
        ...swap,
        image:
          swap.image && swap.image.startsWith("http")
            ? swap.image
            : `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(swap.title)}`,
        ...(canAccessSwapLinks
          ? {}
          : {
              webUrl: undefined,
              deepLink: undefined,
              androidIntentUrl: undefined,
            }),
      }
    : null;
  void import("./analytics")
    .then(({ trackServerEvent }) =>
      trackServerEvent({
        event: "product_scanned",
        distinctId: req.deviceId || "anon",
        platform: req.format === "ios_text" ? "ios" : req.deviceId ? "android" : "web",
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
    lookup: { source: found.source, origin: found.origin, ms: found.ms },
    result,
    swap: resolvedSwap,
    store,
    pill: `${result.score}/100 • Tap to Inspect`,
    entitlement,
  };
}

/** Concise plain-text payload for iOS Shortcuts "Show Result" / notifications. */
export function toIosText(scan: ScanResponse): string {
  const r = scan.result;
  const dot = r.color === "green" ? "🟢" : r.color === "yellow" ? "🟡" : "🔴";
  const lines = [`${dot} ${r.score}/100 ${r.rating} — ${scan.product.title}`];
  if (r.flagged.length) {
    lines.push("", "⚠️ Flagged:");
    for (const f of r.flagged.slice(0, 6)) lines.push(`• ${f.name} (-${f.penalty}): ${f.explanation}`);
    if (r.flagged.length > 6) lines.push(`• +${r.flagged.length - 6} more`);
  } else {
    lines.push("", "✅ No watchlist additives found.");
  }
  if (scan.swap) {
    lines.push("", `🔁 Clean Swap at ${STORE_META[scan.store].label}: ${scan.swap.title} (${scan.swap.score}/100)`);
    if (scan.swap.webUrl) lines.push(scan.swap.webUrl);
  }
  return lines.join("\n");
}
