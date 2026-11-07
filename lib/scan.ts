/**
 * Shared scan pipeline used by /api/scan and /api/audit.
 */
import "server-only";
import { isEnglishIngredientText, lookupIngredients, type LookupResult } from "./lookup";
import { applyOrActivateReferral, serializeEntitlement, type EntitlementSummary } from "./referrals";
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
    if (ipHits.size > 5000) ipHits.clear();
    ipHits.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= limitPerMin;
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

  const rawTitleInput = typeof req.productTitle === "string" ? req.productTitle.trim().slice(0, 300) : "";
  const rawIngredients = typeof req.rawIngredients === "string" ? req.rawIngredients.trim().slice(0, 12_000) : "";
  const barcode =
    typeof req.barcode === "string" || typeof req.barcode === "number" ? String(req.barcode).trim().slice(0, 32) : "";

  // Reject pure store UI controls, quantity +/- steppers, variant labels ("Flavor: Blueberry"), cart headers ("Cart, (12 items)"),
  // addresses ("1034 Elmwood Dr", "Change delivery address...", "This isn't your preferred address..."),
  // barcode scanner buttons ("Opens barcode scanner"), and delivery time slots ("Express, 68-98 min...", "Today, 3 hr or less...", "Today, 6pm-8pm, Free with Walmart+")
  const CART_CONTROL_OR_UI_NOISE =
    /^(?:(?:flavor|size|style|color|colour|scent|count|pack|pack\s+size|variant|option|type|model|pattern|weight|material)\s*:\s*.+|cart\s*,?\s*\(\d+(?:\s+items?)?\)|in\s+\d+[kKmM]?\+?\s*people'?s?\s*c(?:arts?|a.*)|\d+[kKmM]?\+?\s*bought\b.*|options(?:\s+from\s+.*)?|(?:get\s+\$?\d+(?:\.\d{2})?\s+)?walmart\s+cash.*|manufacturer\s+offer.*|subscribe\s+to\s+save.*|(?:increase|decrease)\s+quantity\b.*|reserve\s+a\s+time.*|choose\s+a\s+time.*|select\s+a\s+time.*|book\s+a\s+time.*|hide\s+details.*|show\s+details.*|view\s+details.*|see\s+details.*|don'?t\s+forget.*|delivery\s+from\s+store.*|pickup\s+from\s+store.*|pickup\s+and\s+delivery.*|available\s+for\s+\d+\s+of\s+\d+\s+items.*|free\s+\d+-day\s+returns$|free\s+holiday\s+returns.*|gift\s+eligible.*|sold\s+by\s+.+|fulfilled\s+by\s+.+|sold\s+and\s+shipped\s+by\s+.+|arrives\s+(?:between|by)\s+.+|fees\s+may\s+apply.*|add\s+\$\d+.*|skip\s+the\s+order\s+min\s+fee.*|bought\s+\d+\s+times?$|choose\s+substitution.*|say\s+thanks\s+with\s+a\s+tip.*|product\s+information.*|items\s+to\s+add\s+next.*|many\s+in\s+stock.*|out\s+of\s+stock.*|snap\s+ebt\s+eligible$|pro\s+seller$|save\s+for\s+later$|move\s+to\s+cart$|remove$|delete$|opens?\s+barcode\s+scanner.*|.*barcode\s+scanner.*|.*preferred\s+address.*|change\s+(?:delivery\s+|pickup\s+|shipping\s+)?address.*|\d+\s+[a-z0-9.\s]+\b(?:st|street|rd|road|dr|drive|ave|avenue|blvd|boulevard|ln|lane|ct|court|pl|place|cir|circle|way|pkwy|parkway|hwy|highway|ter|terrace|trl|trail)\b.*|(?:express|today|tomorrow|asap)\s*,?\s*(?:\d+\s*[-–—]\s*\d+\s*min|\d+\s*(?:hr|hour|min)s?\s+or\s+less|\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)).*|.*,\s*was$|.*\b(?:\d+\s*[-–—]\s*\d+\s*min|\d+\s*(?:hr|hour|min)s?\s+or\s+less|\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm))\b.*|.*\bfree\s+with\s+(?:walmart\+?|\bw\+).*|.*\?)$/i;
  if (!rawIngredients && !barcode && CART_CONTROL_OR_UI_NOISE.test(rawTitleInput)) {
    return { ok: false, status: 422, error: "Store UI control or duplicate cart action label ignored." };
  }

  const productTitle = rawTitleInput
    .replace(/^.*?\b(remove from favorites|add to favorites)\s*[,•|\-]?\s*/i, "")
    .replace(/^(?:remove|delete|save\s+for\s+later|move\s+to\s+cart)\s*[,:•|\-]?\s+/i, "")
    .replace(/^\d+\s+in\s+(?:cart|bag|basket|order)\s*[,:•|\-–—]?\s*/i, "")
    .replace(/^(?:quantity|qty)\s*:?\s*\d+\s*[,:•|\-]?\s*/i, "")
    .replace(/^(?:bought\s+\d+\s+times?|best\s+seller|overall\s+pick|popular\s+pick|rollback|sponsored|save\s+for\s+later)\s*[,•|\-]?\s*/gi, "")
    .replace(/^(?:bought\s+\d+\s+times?|best\s+seller|overall\s+pick|popular\s+pick|rollback|sponsored)\s*[,•|\-]?\s*/gi, "")
    .replace(/^\$\s*\d+(?:\.\d{2})?(?:\s*[,•|\-]?\s*\$\s*\d+(?:\.\d{2})?\s*\/?\s*(?:ea|oz|fl\s*oz|lb|ct)?)?\s*[,•|\-]?\s*/i, "")
    .replace(/\s*[,•|\-]?\s*(?:free\s+\d+-day\s+returns|free\s+holiday\s+returns.*|snap\s+ebt\s+eligible|gift\s+eligible.*|subscribe)$/gi, "")
    .replace(/\.\.\.+$/, "")
    .trim();

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

  const store = parseStore(req.store);
  const watchlist =
    req.watchlist && typeof req.watchlist === "object" && !Array.isArray(req.watchlist) ? req.watchlist : undefined;
  const familyWatchlist = Array.isArray(req.familyWatchlist)
    ? req.familyWatchlist.filter((c): c is Category => typeof c === "string" && (ALL_CATEGORIES as string[]).includes(c))
    : undefined;

  const found = await lookupIngredients({
    productTitle,
    barcode,
    rawIngredients,
  });
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
  const title = (
    callerWords.length >= 3
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
  let entitlement: ReturnType<typeof serializeEntitlement> | undefined;
  if (typeof req.deviceId === "string" && req.deviceId.trim().length >= 4) {
    const { device } = await applyOrActivateReferral({
      deviceId: req.deviceId,
      referralCode: req.referredByCode,
      activateNow: true,
    });
    entitlement = serializeEntitlement(device);
  }
  const resolvedImageUrl =
    found.imageUrl && found.imageUrl.startsWith("http")
      ? found.imageUrl
      : `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(title)}`;
  return {
    ok: true,
    product: {
      title,
      brand: found.brand,
      barcode: found.barcode,
      imageUrl: resolvedImageUrl,
      ingredients: found.ingredients,
      nutrition: found.nutrition,
    },
    lookup: { source: found.source, origin: found.origin, ms: found.ms },
    result,
    swap,
    store,
    pill: `${result.score}/100 • Tap to Inspect`,
    ...(entitlement ? { entitlement } : {}),
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
    lines.push("", `🔁 Clean Swap at ${STORE_META[scan.store].label}: ${scan.swap.title} (${scan.swap.score}/100)`, scan.swap.webUrl);
  }
  return lines.join("\n");
}
