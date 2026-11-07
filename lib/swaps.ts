/**
 * CleanCart / HeyBroc — 1-Tap Clean Swap & Affiliate Deep-Link Resolver
 * ---------------------------------------------------------------------
 * Supports all 12 major US grocery & delivery apps:
 * Walmart, Instacart, Target, Kroger, ALDI, DoorDash, Uber Eats,
 * Amazon Fresh / Whole Foods, Sam's Club, BJ's Wholesale, Costco, and Shipt.
 *
 * Affiliate tracking is ONLY attached to URLs returned here, and those URLs are only
 * opened when the user actively taps "Swap Item". Nothing is fired passively.
 */
import { scoreIngredients, type Watchlist } from "./rubric";

export type Store =
  | "walmart"
  | "instacart"
  | "target"
  | "kroger"
  | "aldi"
  | "doordash"
  | "ubereats"
  | "amazon"
  | "sams"
  | "bjs"
  | "costco"
  | "shipt";

export const STORES: Store[] = [
  "walmart",
  "instacart",
  "target",
  "kroger",
  "aldi",
  "doordash",
  "ubereats",
  "amazon",
  "sams",
  "bjs",
  "costco",
  "shipt",
];

export type SwapCategory =
  | "Yogurt"
  | "Crackers"
  | "Cereal"
  | "Deli Meat"
  | "Chips"
  | "Butter/Dairy"
  | "Bread"
  | "Dressings"
  | "Snacks";

export interface CleanAlternative {
  category: SwapCategory;
  brand: string;
  name: string;
  size?: string;
  price?: number;
  image: string;
  /** Reference ingredient list used to verify the alternative scores 90–100 with the same rubric. */
  ingredients: string;
  /**
   * Optional verified store item IDs. When present, a direct product deep link is generated
   * (e.g. walmart://ip/{id}). When absent we deep-link to an exact-match store search, which
   * always resolves inside the store's app via Android App Links / iOS Universal Links.
   */
  itemIds?: Partial<Record<Store, string>>;
}

export interface SwapResult {
  category: SwapCategory;
  brand: string;
  name: string;
  title: string;
  image: string;
  score: number;
  store: Store;
  webUrl: string;
  deepLink: string;
  androidPackage: string;
  /** Android browser intent URL that opens the store app if installed, else falls back to web. */
  androidIntentUrl: string;
}

export const STORE_META: Record<Store, { label: string; host: string; androidPackage: string; scheme: string }> = {
  walmart: { label: "Walmart", host: "www.walmart.com", androidPackage: "com.walmart.android", scheme: "walmart" },
  instacart: { label: "Instacart", host: "www.instacart.com", androidPackage: "com.instacart.client", scheme: "instacart" },
  target: { label: "Target", host: "www.target.com", androidPackage: "com.target.ui", scheme: "target" },
  kroger: { label: "Kroger", host: "www.kroger.com", androidPackage: "com.kroger.mobile", scheme: "kroger" },
  aldi: { label: "ALDI", host: "www.aldi.us", androidPackage: "de.apptiv.business.android.aldi_us", scheme: "aldi" },
  doordash: { label: "DoorDash", host: "www.doordash.com", androidPackage: "com.dd.doordash", scheme: "doordash" },
  ubereats: { label: "Uber Eats", host: "www.ubereats.com", androidPackage: "com.ubercab.eats", scheme: "ubereats" },
  amazon: { label: "Amazon Fresh", host: "www.amazon.com", androidPackage: "com.amazon.mShop.android.shopping", scheme: "amazon" },
  sams: { label: "Sam's Club", host: "www.samsclub.com", androidPackage: "com.rfi.sams.android", scheme: "samsclub" },
  bjs: { label: "BJ's Wholesale", host: "www.bjs.com", androidPackage: "com.bjs.mobile", scheme: "bjs" },
  costco: { label: "Costco", host: "www.costco.com", androidPackage: "com.costco.app.android", scheme: "costco" },
  shipt: { label: "Shipt", host: "www.shipt.com", androidPackage: "com.shipt.groceries", scheme: "shipt" },
};

export const CLEAN_ALTERNATIVES: Record<SwapCategory, CleanAlternative> = {
  Yogurt: {
    category: "Yogurt",
    brand: "Stonyfield Organic",
    name: "Whole Milk Plain Yogurt",
    size: "32 oz tub",
    price: 4.98,
    image: "/swaps/yogurt.jpg",
    ingredients: "Cultured pasteurized organic whole milk, pectin, vitamin D3. Live active cultures.",
  },
  Crackers: {
    category: "Crackers",
    brand: "Mary's Gone Crackers",
    name: "Original Seed Crackers",
    size: "6.5 oz box",
    price: 4.79,
    image: "/swaps/crackers.jpg",
    ingredients: "Organic whole grain brown rice, organic whole grain quinoa, organic brown flax seeds, organic brown sesame seeds, filtered water, sea salt, organic wheat-free tamari (water, organic soybeans, salt, organic alcohol).",
  },
  Cereal: {
    category: "Cereal",
    brand: "Nature's Path",
    name: "Organic Heritage Flakes",
    size: "13.25 oz box",
    price: 4.49,
    image: "/swaps/cereal.jpg",
    ingredients: "Organic whole wheat meal, organic oat flour, organic khorasan wheat, organic barley flour, organic spelt flour, organic millet, organic quinoa, organic cane sugar, sea salt.",
  },
  "Deli Meat": {
    category: "Deli Meat",
    brand: "Applegate Organics",
    name: "Oven Roasted Turkey Breast",
    size: "7 oz pack",
    price: 6.48,
    image: "/swaps/turkey.jpg",
    ingredients: "Organic turkey breast, water, sea salt, organic vinegar, organic cane sugar, organic onion powder, organic paprika.",
  },
  Chips: {
    category: "Chips",
    brand: "Boulder Canyon",
    name: "Avocado Oil Kettle Chips",
    size: "5.25 oz bag",
    price: 3.98,
    image: "/swaps/chips.jpg",
    ingredients: "Potatoes, avocado oil, sea salt.",
  },
  "Butter/Dairy": {
    category: "Butter/Dairy",
    brand: "Organic Valley",
    name: "Organic 100% Grassmilk Dairy",
    size: "64 oz carton",
    price: 5.98,
    image: "/swaps/butter.jpg",
    ingredients: "Organic Grade A whole milk, vitamin D3.",
  },
  Bread: {
    category: "Bread",
    brand: "Food For Life",
    name: "Ezekiel 4:9 Sprouted Whole Grain Bread",
    size: "24 oz loaf",
    price: 6.29,
    image: "/swaps/bread.jpg",
    ingredients: "Organic sprouted wheat, filtered water, organic sprouted barley, organic sprouted millet, organic malted barley, organic sprouted lentils, organic sprouted soybeans, organic sprouted spelt, fresh yeast, organic wheat gluten, sea salt.",
  },
  Dressings: {
    category: "Dressings",
    brand: "Primal Kitchen",
    name: "Ranch Dressing with Avocado Oil",
    size: "8 fl oz bottle",
    price: 6.98,
    image: "/swaps/ranch.jpg",
    ingredients: "Avocado oil, water, organic eggs, organic distilled vinegar, organic egg yolks, sea salt, organic garlic, organic onion, organic lemon juice concentrate, organic dried parsley, organic dill, black pepper, organic chives, rosemary extract.",
  },
  Snacks: {
    category: "Snacks",
    brand: "LÄRABAR",
    name: "Cashew Cookie Fruit & Nut Bar",
    size: "1.7 oz bar",
    price: 1.79,
    image: "/swaps/snacks.jpg",
    ingredients: "Cashews, dates.",
  },
};

const BROTH_GRAVY_ALTERNATIVE: CleanAlternative = {
  category: "Dressings",
  brand: "Kettle & Fire",
  name: "Organic Turkey Bone Broth",
  size: "16.9 oz carton",
  price: 6.49,
  image: "/swaps/turkey.jpg",
  ingredients: "Organic turkey bone broth (water, organic turkey bones, organic onions, organic carrots, organic celery), organic apple cider vinegar, sea salt, organic rosemary, organic sage, organic thyme, organic black pepper.",
};

export const DIRTY_FALLBACK_IMAGES: Record<SwapCategory, string> = {
  Yogurt: "/products/yogurt.jpg",
  Crackers: "/products/crackers.jpg",
  Cereal: "/products/cereal.jpg",
  "Deli Meat": "/products/turkey.jpg",
  Chips: "/products/chips.jpg",
  "Butter/Dairy": "/products/butter.jpg",
  Bread: "/products/bread.jpg",
  Dressings: "/products/ranch.jpg",
  Snacks: "/products/snacks.jpg",
};

const CATEGORY_KEYWORDS: [SwapCategory, RegExp][] = [
  ["Yogurt", /\b(yogh?urt|skyr|kefir|chobani|yoplait|dannon|fage|siggi)\b/i],
  ["Crackers", /\b(crackers?|cheez|goldfish|triscuit|saltines?|ritz|wheat thins|graham)\b/i],
  ["Chips", /\b(chips|crisps|tortilla chips|doritos|pringles|cheetos|cheese puffs|puffs|takis|fritos|lay's|lays|ruffles|pretzels?|popcorn)\b/i],
  ["Cereal", /\b(cereal|flakes|granola|loops|o's|muesli|oatmeal|cheerios|cinnamon toast|lucky charms|frosted|raisin bran)\b/i],
  ["Dressings", /\b(gravy|broth|stock|bouillon|dressing|ranch|vinaigrette|mayo|mayonnaise|caesar|aioli|ketchup|mustard|bbq|barbecue|sauce|salsa|marinara)\b/i],
  ["Deli Meat", /\b(turkey|ham|salami|bologna|pepperoni|deli|bacon|hot ?dogs?|franks?|sausages?|kielbasa|lunch ?meat|roast beef|chicken breast|chicken patties|nuggets|tenders|beef|steak|pork)\b/i],
  ["Butter/Dairy", /\b(butter|margarine|spread|milk|eggnog|egg nog|cheese|velveeta|cream|creamer|eggs?|ice cream|gelato|half and half|cottage cheese)\b/i],
  ["Bread", /\b(bread|buns?|rolls?|bagels?|tortillas?|loaf|english muffins?|waffles?|pancakes?|muffins?|croissants?|pasta|noodles|macaroni|pizza|hot pockets?)\b/i],
  ["Snacks", /\b(bars?|cookies?|wafers?|knoppers|storck|merci|kinder|snacks?|gummies|gummy|candy|fruit snacks|pastries|tarts?|oreos?|chocolate|brownies?|soda|cola|juice|drink|gatorade|water|tea|coffee)\b/i],
];

export function detectCategory(productTitle = "", _ingredients = ""): SwapCategory {
  for (const [cat, re] of CATEGORY_KEYWORDS) if (re.test(productTitle)) return cat;
  return "Snacks";
}

export function impactClickId(): string {
  return (
    (typeof process !== "undefined" && (process.env?.NEXT_PUBLIC_IMPACT_CLICK_ID || process.env?.IMPACT_CLICK_ID)) ||
    "heybroc_live"
  );
}

export function amazonPartnerTag(): string {
  return (
    (typeof process !== "undefined" && (process.env?.NEXT_PUBLIC_AMAZON_TAG || process.env?.AMAZON_PARTNER_TAG)) ||
    "heybroc-20"
  );
}

function withAffiliate(url: string, store: Store, clickId: string): string {
  const sep = url.includes("?") ? "&" : "?";
  const cid = encodeURIComponent(clickId);
  switch (store) {
    case "amazon":
      return `${url}${sep}tag=${encodeURIComponent(amazonPartnerTag())}&linkCode=ll2`;
    case "walmart":
      return `${url}${sep}irgwc=1&sourceid=imp_${cid}&veh=aff&wmlspartner=imp_heybroc&clickid=${cid}`;
    case "target":
      return `${url}${sep}irgwc=1&afid=heybroc&ref=tgt_adv_xasd0002&clickid=${cid}`;
    case "instacart":
      return `${url}${sep}irgwc=1&utm_source=instacart_impact&utm_medium=affiliate&clickid=${cid}`;
    default:
      return `${url}${sep}irgwc=1&utm_source=heybroc&utm_medium=affiliate&clickid=${cid}`;
  }
}

/** Concise 2-3 word search query for club stores (BJ's / Costco / Sam's) so native search screens always find in-stock matches. */
function conciseClubQuery(q: string): string {
  const s = q.toLowerCase();
  if (/\b(broth|gravy|stock)\b/.test(s)) return "Organic Broth";
  if (/\b(turkey|bacon|sausage|deli)\b/.test(s)) return "Applegate Organic";
  if (/\b(yogurt)\b/.test(s)) return "Organic Yogurt";
  if (/\b(crackers)\b/.test(s)) return "Organic Crackers";
  if (/\b(cereal|flakes|oats)\b/.test(s)) return "Organic Cereal";
  if (/\b(chips)\b/.test(s)) return "Avocado Oil Chips";
  if (/\b(butter|grassmilk|milk)\b/.test(s)) return "Organic Milk";
  if (/\b(bread|ezekiel|sprouted)\b/.test(s)) return "Organic Bread";
  if (/\b(ranch|dressing)\b/.test(s)) return "Organic Ranch";
  if (/\b(bar|larabar|lärabar|cashew)\b/.test(s)) return "Organic Fruit Bars";
  return q.replace(/['"/\\]+/g, " ").trim().split(/\s+/).slice(0, 3).join(" ");
}

function searchPath(store: Store, q: string): string {
  const e = encodeURIComponent(q);
  switch (store) {
    case "walmart": return `/search?q=${e}`;
    case "instacart": return `/store/s?k=${e}`;
    case "target": return `/s?searchTerm=${e}`;
    case "kroger": return `/search?query=${e}`;
    case "aldi": return `/results?q=${e}`;
    case "doordash": return `/search/store/${e}`;
    case "ubereats": return `/search?q=${e}`;
    case "amazon": return `/s?k=${e}&i=amazonfresh`;
    case "sams": return `/s/${encodeURIComponent(conciseClubQuery(q))}`;
    case "bjs": {
      const bjsQ = encodeURIComponent(conciseClubQuery(q));
      return `/search/${bjsQ}?q=${bjsQ}&query=${bjsQ}&searchTerm=${bjsQ}`;
    }
    case "costco": return `/CatalogSearch?dept=All&keyword=${encodeURIComponent(conciseClubQuery(q))}`;
    case "shipt": return `/shop/search?query=${e}`;
  }
}

function productPath(store: Store, id: string): string {
  switch (store) {
    case "walmart": return `/ip/${id}`;
    case "instacart": return `/products/${id}`;
    case "target": return `/p/${id}`;
    case "kroger": return `/p/item/${id}`;
    case "aldi": return `/product/${id}`;
    case "doordash": return `/products/${id}`;
    case "ubereats": return `/product/${id}`;
    case "amazon": return `/dp/${id}`;
    case "sams": return `/p/${id}`;
    case "bjs": return `/product/${id}`;
    case "costco": return `/p/${id}`;
    case "shipt": return `/shop/products/${id}`;
  }
}

/** Builds web + native deep links for a clean alternative at the active store. */
export function buildLinks(alt: CleanAlternative, store: Store, clickId = impactClickId()) {
  const meta = STORE_META[store];
  const query = `${alt.brand} ${alt.name}`;
  const id = alt.itemIds?.[store];
  const path = id ? productPath(store, id) : searchPath(store, query);
  const webUrl = withAffiliate(`https://${meta.host}${path}`, store, clickId);
  // Always use HTTPS App Links / Universal Links so native grocery apps preserve Impact/Amazon affiliate params.
  const deepLink = webUrl;
  const androidIntentUrl =
    `intent://${meta.host}${withAffiliate(path, store, clickId)}#Intent;scheme=https;package=${meta.androidPackage};` +
    `S.browser_fallback_url=${encodeURIComponent(webUrl)};end`;
  return { webUrl, deepLink, androidIntentUrl, androidPackage: meta.androidPackage };
}

/**
 * Returns a verified clean swap when a product scores < 75, else null.
 * The alternative is re-scored with the same deterministic rubric (with active watchlist)
 * and only returned if it scores 90+.
 */
export function resolveSwap(params: {
  score: number;
  productTitle?: string;
  ingredients?: string;
  store?: Store;
  category?: SwapCategory;
  watchlist?: Watchlist;
  familyWatchlist?: import("./rubric").Category[];
}): SwapResult | null {
  if (params.score >= 75) return null;
  const store = params.store && STORES.includes(params.store) ? params.store : "walmart";
  const isBrothOrGravy = /\b(gravy|broth|stock|bouillon)\b/i.test(params.productTitle || "");
  const category = params.category ?? detectCategory(params.productTitle, params.ingredients);
  const alt = isBrothOrGravy ? BROTH_GRAVY_ALTERNATIVE : CLEAN_ALTERNATIVES[category];
  const altScore = scoreIngredients(alt.ingredients, params.watchlist, params.familyWatchlist).score;
  if (altScore < 90) return null;
  return {
    category,
    brand: alt.brand,
    name: alt.name,
    title: `${alt.brand} ${alt.name}`,
    image: alt.image,
    score: altScore,
    store,
    ...buildLinks(alt, store),
  };
}
