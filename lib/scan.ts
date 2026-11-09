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
import { resolveSwap, STORES, STORE_META, type ScanSurface, type Store, type SwapResult } from "./swaps";

export interface DietaryAlert {
  id: string;
  label: string;
  shortBadge: string;
  reason: string;
}

export interface ScanRequest {
  productTitle?: string;
  rawIngredients?: string;
  barcode?: string;
  store?: string;
  surface?: ScanSurface;
  watchlist?: Watchlist;
  familyWatchlist?: Category[];
  dietaryWatchlist?: string[];
  deviceId?: string;
  deviceSecret?: string;
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
  lookup: {
    source: LookupResult["source"];
    origin?: LookupResult["origin"];
    sourceUpdatedAt?: string | null;
    ms: number;
  };
  result: ScoreResult;
  dietaryAlerts?: DietaryAlert[];
  swap: SwapResult | null;
  store: Store;
  pill: string;
  entitlement?: EntitlementSummary;
}

export function evaluateDietaryAlerts(
  dietaryWatchlist: string[] | undefined,
  productTitle: string,
  ingredients: string,
  nutrition?: NutritionInput,
): DietaryAlert[] {
  if (!Array.isArray(dietaryWatchlist) || dietaryWatchlist.length === 0) return [];
  const selected = new Set(dietaryWatchlist.map((s) => String(s).trim().toLowerCase()));
  const text = `${productTitle} ${ingredients}`.toLowerCase();
  const ing = ingredients.toLowerCase();
  const alerts: DietaryAlert[] = [];

  if (selected.has("sugar_diabetes")) {
    const sugarsG = nutrition?.sugarsG100g ?? 0;
    const sugarMatch = ing.match(
      /\b(high\s+fructose\s+corn\s+syrup|corn\s+syrup|cane\s+sugar|brown\s+sugar|sugar|sucrose|dextrose|maltose|fructose|glucose\s+syrup|honey|maple\s+syrup|molasses|agave|invert\s+sugar|fruit\s+juice\s+concentrate)\b/i,
    );
    const refinedCarbMatch = ing.match(
      /\b(enriched\s+(?:wheat\s+)?flour|bleached\s+(?:wheat\s+)?flour|maltodextrin|modified\s+(?:corn|food)\s+starch|instant\s+mashed|white\s+rice\s+flour)\b/i,
    );
    if (sugarsG >= 10 || sugarMatch || refinedCarbMatch) {
      const reasons: string[] = [];
      if (sugarsG >= 10) reasons.push(`${sugarsG}g sugar per 100g`);
      if (sugarMatch) reasons.push(`Added sweetener (${sugarMatch[0]})`);
      else if (refinedCarbMatch) reasons.push(`Refined starch (${refinedCarbMatch[0]})`);
      alerts.push({
        id: "sugar_diabetes",
        label: "🩸 Sugar / Diabetes Watch",
        shortBadge: "SUGAR",
        reason: reasons.join(" • "),
      });
    }
  }

  if (selected.has("dairy") && !/\b(dairy[\s-]*free|non[\s-]*dairy|plant[\s-]*based|vegan)\b/i.test(productTitle)) {
    const dairyCleaned = text.replace(
      /\b(coconut\s+milk|almond\s+milk|oat\s+milk|soy\s+milk|soymilk|almondmilk|oatmilk|rice\s+milk|cashew\s+milk|hemp\s+milk|peanut\s+butter|almond\s+butter|cashew\s+butter|sunflower\s+(?:seed\s+)?butter|cocoa\s+butter|shea\s+butter|apple\s+butter|cookie\s+butter|cream\s+of\s+tartar|coconut\s+cream|lactic\s+acid)\b/gi,
      " ",
    );
    const m = dairyCleaned.match(
      /\b(buttermilk|sour\s+cream|half\s+and\s+half|milk|cream|butter|whey|casein|caseinate|lactose|cheese|cheddar|mozzarella|parmesan|provolone|gouda|swiss|ricotta|yogurt|ghee|lactalbumin)\b/i,
    );
    if (m) {
      alerts.push({
        id: "dairy",
        label: "🥛 Dairy / Lactose Alert",
        shortBadge: "DAIRY",
        reason: `Contains ${m[0].toLowerCase()}`,
      });
    }
  }

  if (selected.has("wheat_gluten") && !/\b(gluten[\s-]*free|grain[\s-]*free|celiac)\b/i.test(productTitle)) {
    const wheatCleaned = text.replace(/\b(buckwheat|wheat\s*grass)\b/gi, " ");
    const m = wheatCleaned.match(
      /\b(vital\s+wheat\s+gluten|graham\s+flour|enriched\s+flour|bleached\s+flour|unbleached\s+flour|wheat|durum|semolina|spelt|farro|kamut|bulgur|couscous|seitan|barley|malt|malted|rye|triticale)\b/i,
    );
    if (m) {
      alerts.push({
        id: "wheat_gluten",
        label: "🌾 Wheat / Gluten Alert",
        shortBadge: "WHEAT",
        reason: `Contains ${m[0].toLowerCase()}`,
      });
    }
  }

  if (selected.has("peanuts_nuts")) {
    const nutCleaned = text.replace(
      /\b(nutmeg|butternut|water\s+chestnuts?|coconuts?)\b/gi,
      " ",
    );
    const m = nutCleaned.match(
      /\b(peanut\s+butter|peanut\s+oil|peanut\s+flour|peanuts?|almonds?|cashews?|walnuts?|pecans?|hazelnuts?|filberts?|pistachios?|macadamia|brazil\s+nuts?|pine\s+nuts?|praline|marzipan|nougat|gianduja)\b/i,
    );
    if (m) {
      alerts.push({
        id: "peanuts_nuts",
        label: "🥜 Peanut & Tree Nut Alert",
        shortBadge: "NUTS",
        reason: `Contains ${m[0].toLowerCase()}`,
      });
    }
  }

  if (selected.has("soy")) {
    const m = text.match(
      /\b(soybean\s+oil|soy\s+lecithin|soy\s+protein|soy\s+flour|soy\s+sauce|textured\s+vegetable\s+protein|soybeans?|soymilk|soy|soya|tamari|tofu|tempeh|edamame|miso)\b/i,
    );
    if (m) {
      alerts.push({
        id: "soy",
        label: "🫘 Soy Alert",
        shortBadge: "SOY",
        reason: `Contains ${m[0].toLowerCase()}`,
      });
    }
  }

  if (selected.has("egg")) {
    const eggCleaned = text.replace(/\beggplants?\b/gi, " ");
    const m = eggCleaned.match(
      /\b(egg\s+whites?|egg\s+yolks?|dried\s+egg|powdered\s+egg|eggs?|albumin|ovalbumin|ovomucoid|lysozyme|mayonnaise|aioli|meringue)\b/i,
    );
    if (m) {
      alerts.push({
        id: "egg",
        label: "🥚 Egg Alert",
        shortBadge: "EGG",
        reason: `Contains ${m[0].toLowerCase()}`,
      });
    }
  }

  if (selected.has("shellfish_fish")) {
    const m = text.match(
      /\b(shrimp|prawns?|crab|lobster|crawfish|crayfish|clams?|mussels?|oysters?|scallops?|calamari|squid|octopus|anchov(?:y|ies)|sardines?|salmon|tuna|cod|tilapia|halibut|haddock|trout|mahi|pollock|catfish|krill|fish\s+sauce|fish\s+oil)\b/i,
    );
    if (m) {
      alerts.push({
        id: "shellfish_fish",
        label: "🐟 Shellfish & Fish Alert",
        shortBadge: "FISH",
        reason: `Contains ${m[0].toLowerCase()}`,
      });
    }
  }

  if (selected.has("high_sodium")) {
    const sodiumMg = nutrition?.sodiumMg100g ?? 0;
    const sodiumAddMatch = ing.match(
      /\b(monosodium\s+glutamate|sodium\s+phosphate|disodium\s+inosinate|disodium\s+guanylate|sodium\s+tripolyphosphate|sodium\s+nitrite|sodium\s+nitrate|sodium\s+benzoate|sodium\s+caseinate|brine|saline\s+solution)\b/i,
    );
    if (sodiumMg >= 400 || sodiumAddMatch) {
      const reasons: string[] = [];
      if (sodiumMg >= 400) reasons.push(`${sodiumMg}mg sodium per 100g`);
      if (sodiumAddMatch) reasons.push(`Contains ${sodiumAddMatch[0].toLowerCase()}`);
      alerts.push({
        id: "high_sodium",
        label: "🧂 High Sodium Watch",
        shortBadge: "SODIUM",
        reason: reasons.join(" • "),
      });
    }
  }

  return alerts;
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
      .replace(/\s*[,•|\-]?\s*(?:average|avg)\s+price\b.*$/gi, "")
      .replace(/\b93?%\s*lean\s*\/?\s*7?%\s*fat\b/gi, "93% Lean/7% Fat")
      .replace(/\b80?%\s*lean\s*\/?\s*20?%\s*fat\b/gi, "80% Lean/20% Fat")
      .replace(/\b85?%\s*lean\s*\/?\s*15?%\s*fat\b/gi, "85% Lean/15% Fat")
      .replace(/\b73?%\s*lean\s*\/?\s*27?%\s*fat\b/gi, "73% Lean/27% Fat")
      .replace(/\btruffl(?:\.\.\.+|…|\b)/gi, "Truffles")
      .replace(/\bchocolat(?:\.\.\.+|…|\b)/gi, "Chocolate")
      .replace(/\bappl(?:\.\.\.+|…|\b)/gi, "Apples")
      .replace(/\bwing\s+sa(?:\.\.\.+|…|\b)/gi, "Wing Sauce")
      .replace(/\band\s+re(?:\.\.\.+|…|\b)/gi, "and Reese's")
      .replace(/\s*\(\d+(?:\.\d+)?\s*[a-z]{0,4}\s*(?:\.\.\.+|…)?\s*$/i, "")
      .replace(/\s*,\s*\d+\s*[a-z]{0,3}\s*(?:\.\.\.+|…)\s*$/i, "")
      .replace(/\.\.\.+$/, "")
      .replace(/…+$/, "")
      .replace(/\s*[.,•|\-]+\s*$/, "")
      .trim();

  let productTitle = cleanCandidate(rawTitleInput);

  if (!productTitle && !rawIngredients && !barcode) {
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
  const genericBrand = /^(conventional grocery|clean grocery verified|usda verified|fresh whole food|.*category estimate.*)$/i;
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
  const effectiveDeviceId =
    typeof req.deviceId === "string" && req.deviceId.trim().length >= 4
      ? req.deviceId.trim()
      : "anon-web";
  const resolvedSurface: ScanSurface =
    req.surface === "extension" || req.surface === "android" || req.surface === "web"
      ? req.surface
      : effectiveDeviceId.startsWith("ext-")
        ? "extension"
        : effectiveDeviceId !== "anon-web" && !effectiveDeviceId.startsWith("web-")
          ? "android"
          : "web";
  const swap = resolveSwap({
    score: result.score,
    productTitle: `${productTitle} ${title}`,
    ingredients: found.ingredients,
    store,
    watchlist,
    familyWatchlist,
    surface: resolvedSurface,
  });
  let entitlement: EntitlementSummary | undefined;
  try {
    if (req.referredByCode && effectiveDeviceId !== "anon-web") {
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
  const canAccessSwapLinks = Boolean(
    entitlement && (entitlement.isProActive || entitlement.swapsRemaining > 0)
  );
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
      source: found.source,
      origin: found.origin,
      sourceUpdatedAt: found.sourceUpdatedAt,
      ms: found.ms,
    },
    result,
    ...(dietaryAlerts.length > 0 ? { dietaryAlerts } : {}),
    swap: resolvedSwap,
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
  if (r.flagged.length) {
    lines.push("", "⚠️ Flagged:");
    for (const f of r.flagged.slice(0, 6)) lines.push(`• ${f.name} (-${f.penalty}): ${f.explanation}`);
    if (r.flagged.length > 6) lines.push(`• +${r.flagged.length - 6} more`);
  } else {
    lines.push("", "✅ No watchlist additives found.");
  }
  if (scan.swap) {
    const paidLabel = scan.swap.isPaidLink ? " (paid link)" : "";
    lines.push("", `🔁 Clean Swap at ${STORE_META[scan.store].label}${paidLabel}: ${scan.swap.title} (${scan.swap.score}/100)`);
    if (scan.swap.webUrl) lines.push(`${scan.swap.webUrl}${paidLabel}`);
  }
  return lines.join("\n");
}
