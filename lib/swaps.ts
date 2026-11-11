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
import { scoreIngredients, scoreProductYuka, type Watchlist, type NutritionInput } from "./rubric";
import { passesVariantGuard } from "./drinks-catalog";
import { detectMajorAllergens, detectPesticideRisk, evaluateDietaryAlerts } from "./dietary";

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
  sourceUrl?: string;
  verifiedAt?: string;
  nutrition?: NutritionInput;
  category: SwapCategory;
  brand: string;
  name: string;
  searchQuery?: string;
  size?: string;
  isOrganic?: boolean;
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

export type ScanSurface = "web" | "android" | "extension";

export type ClientPlatform =
  | "web"
  | "android"
  | "chrome-extension"
  | "ios-safari"
  | "ios-share"
  | "ios-shortcut"
  | "ios-app";

export interface SwapResult {
  sourceUrl?: string;
  verifiedAt?: string;
  nutrition?: NutritionInput;
  category: SwapCategory;
  brand: string;
  name: string;
  title: string;
  size?: string;
  ingredients: string;
  searchQuery: string;
  image: string;
  score: number;
  store: Store;
  webUrl?: string;
  deepLink?: string;
  androidPackage: string;
  /** Android browser intent URL that opens the store app if installed, else falls back to web. */
  androidIntentUrl?: string;
  /** True when webUrl/deepLink contains an affiliate tag or Impact redirect requiring " · paid link" disclosure. */
  isPaidLink: boolean;
  /** True when the clean swap is a budget-friendly private-label brand owned by the active store (e.g. Great Value, Good & Gather, Simply Nature, Kirkland Signature, Simple Truth Organic). */
  isStoreBrand?: boolean;
}

export const STORE_META: Record<Store, { label: string; host: string; androidPackage: string; scheme: string }> = {
  walmart: { label: "Walmart", host: "www.walmart.com", androidPackage: "com.walmart.android", scheme: "walmart" },
  instacart: { label: "Instacart", host: "www.instacart.com", androidPackage: "com.instacart.client", scheme: "instacart" },
  target: { label: "Target", host: "www.target.com", androidPackage: "com.target.ui", scheme: "target" },
  kroger: { label: "Kroger", host: "www.kroger.com", androidPackage: "com.kroger.mobile", scheme: "kroger" },
  aldi: { label: "ALDI", host: "shop.aldi.us", androidPackage: "de.apptiv.business.android.aldi_us", scheme: "aldi" },
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
    isOrganic: true,
    image: "/swaps/yogurt.jpg",
    ingredients: "Cultured pasteurized organic whole milk, pectin, vitamin D3.",
    nutrition: { caloriesKcal100g: 120 / 1.7, sugarsG100g: 6 / 1.7, saturatedFatG100g: 4.5 / 1.7, sodiumMg100g: 85 / 1.7, fiberG100g: 0, proteinG100g: 6 / 1.7, fruitsVegNutsPct: 0, isOrganic: true },
    sourceUrl: "https://www.stonyfield.com/products/whole-milk-smooth-creamy-plain-32oz/",
    verifiedAt: "2026-11-09",
    itemIds: { walmart: "10535275" },
  },
  Crackers: {
    category: "Crackers",
    brand: "Mary's Gone Crackers",
    name: "Organic Original Seed Crackers",
    size: "6.5 oz box",
    isOrganic: true,
    image: "/swaps/crackers.jpg",
    ingredients: "Organic brown rice, organic quinoa, organic flax seeds, organic sesame seeds, organic tamari (water, organic soybeans, salt, organic vinegar), sea salt.",
    nutrition: { caloriesKcal100g: 150 / 0.3, sugarsG100g: 0, saturatedFatG100g: 0.5 / 0.3, sodiumMg100g: 180 / 0.3, fiberG100g: 3 / 0.3, proteinG100g: 4 / 0.3, isOrganic: true },
    sourceUrl: "https://www.marysgonecrackers.com/products/marys-gone-crackers-original-crackers",
    verifiedAt: "2026-11-09",
  },
  Cereal: {
    category: "Cereal",
    brand: "Nature's Path",
    name: "Organic Heritage Flakes",
    sourceUrl: "https://www.naturespath.com/en-us/products/natures-path-foods/heritage-flakes/",
    verifiedAt: "2026-11-09",
    size: "13.25 oz box",
    isOrganic: true,
    image: "/swaps/cereal.jpg",
    ingredients: "Organic whole wheat meal, organic oat flour, organic khorasan wheat, organic barley flour, organic spelt flour, organic millet, organic quinoa, organic cane sugar, sea salt.",
    itemIds: { walmart: "10898744" },
  },
  "Deli Meat": {
    category: "Deli Meat",
    brand: "Applegate Organics",
    name: "Oven Roasted Turkey Breast",
    size: "6 oz pack",
    isOrganic: true,
    image: "/swaps/turkey.jpg",
    ingredients: "Organic turkey breast, water. Contains 2% or less of: sea salt, organic potato starch, organic chicken broth, rosemary extract.",
    sourceUrl: "https://www.applegate.com/products/organic-roasted-turkey-breast",
    verifiedAt: "2026-11-09",
    itemIds: { walmart: "15610519" },
  },
  Chips: {
    category: "Chips",
    brand: "Boulder Canyon",
    name: "Avocado Oil Kettle Chips",
    sourceUrl: "https://www.utzsnacks.com/products/boulder-canyon-kettle-cooked-potato-chips-avocado-oil-classic-sea-salt",
    verifiedAt: "2026-11-09",
    size: "5.25 oz bag",
    image: "/swaps/chips.jpg",
    ingredients: "Potatoes, avocado oil, sea salt.",
    nutrition: { caloriesKcal100g: 535, sugarsG100g: 0, saturatedFatG100g: 5.3, sodiumMg100g: 392, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 80 },
    itemIds: { walmart: "44391408" },
  },
  "Butter/Dairy": {
    category: "Butter/Dairy",
    brand: "Organic Valley",
    name: "Organic Pasture-Raised Salted Butter",
    sourceUrl: "https://www.organicvalley.coop/products/butter/salted-butter/salted-butter-1-lb-4-quarters/",
    verifiedAt: "2026-11-09",
    size: "16 oz (4 sticks)",
    isOrganic: true,
    image: "/swaps/butter.jpg",
    ingredients: "Organic pasteurized sweet cream, salt.",
    itemIds: { walmart: "10804556" },
  },
  Bread: {
    category: "Bread",
    brand: "Dave's Killer Bread",
    name: "Organic 21 Whole Grains & Seeds Bread",
    size: "27 oz loaf",
    isOrganic: true,
    image: "/swaps/bread.jpg",
    ingredients: "Organic whole wheat, water, organic 21 whole grains and seeds mix (organic whole flax seeds, organic sunflower seeds, organic sesame seeds, organic rolled oats, organic millet, organic quinoa), organic cane sugar, organic wheat gluten, organic oat fiber, sea salt, yeast.",
    sourceUrl: "https://www.daveskillerbread.com/21-whole-grains-and-seeds",
    verifiedAt: "2026-11-09",
    itemIds: { walmart: "45804393" },
  },
  Dressings: {
    category: "Dressings",
    brand: "Primal Kitchen",
    name: "Ranch Dressing with Avocado Oil",
    sourceUrl: "https://www.primalkitchen.com/products/ranch-dressing",
    verifiedAt: "2026-11-09",
    size: "8 fl oz bottle",
    image: "/swaps/ranch.jpg",
    ingredients: "Avocado oil, water, organic eggs, organic distilled vinegar, organic egg yolks, sea salt, organic garlic, organic onion, organic lemon juice concentrate, organic dried parsley, organic dill, black pepper, organic chives, rosemary extract.",
    itemIds: { walmart: "262135036" },
  },
  Snacks: {
    category: "Snacks",
    brand: "That's It.",
    name: "100% Real Fruit Bars (Apple + Strawberry)",
    size: "5 count box",
    image: "/swaps/fruitbar.png",
    ingredients: "Apples, strawberries.",
    nutrition: {
      caloriesKcal100g: 100 / 0.35,
      sugarsG100g: 19 / 0.35,
      saturatedFatG100g: 0,
      sodiumMg100g: 25 / 0.35,
      fiberG100g: 3 / 0.35,
      proteinG100g: 1 / 0.35,
      fruitsVegNutsPct: 100,
      isOrganic: false,
    },
    sourceUrl: "https://www.thatsitfruit.com/products/apple-strawberry",
    verifiedAt: "2026-11-09",
    itemIds: { walmart: "470907558" },
  },
};

const PLANT_OR_DAIRY_FREE_BRAND_OR_TERM_RE =
  "earth\\s+balance|country\\s+crock\\s+plant|plant[- ]?based|plant\\s+(?:butter|buttery|cream|creamer|cheese|spread|yogh?urt|milk)|violife|daiya|miyoko(?:'?s)?|kite\\s+hill|follow\\s+your\\s+heart|so\\s+delicious|forager|chao|dairy[- ]?free|non[- ]?dairy|vegan";

const PLANT_MILK_QUALIFIER_RE =
  `almond|almondmilk|oat|oatmilk|oatly|planet\\s+oat|soy|soymilk|silk|westsoy|edensoy|coconut|coconutmilk|cashew|cashewmilk|rice\\s+milk|hemp|pea\\s+milk|ripple|malk|califia|nutpods|elmhurst|laird|${PLANT_OR_DAIRY_FREE_BRAND_OR_TERM_RE}`;

const DAIRY_BUTTER_EXCLUSIONS_RE =
  `peanut|almond|cashew|sunflower|sun|cookie|cookies|apple|cocoa|shea|body|butter\\s+milk|buttermilk|butter\\s+pecan|butter\\s+lettuce|butter\\s+beans?|butter\\s+potato\\w*|butternut|steak|salmon|shrimp|fish|chicken|turkey|beef|pork|crab|lobster|jam|jelly|preserves|fruit\\s+spread|latte|matcha|tea|coffee|popcorn|crackers?|wafers?|croissants?|rolls?|roll|buns?|bread|waffles?|pancakes?|syrup|pasta|noodles?|ramen|shells|macaroni|sauce|soup|chowder|candy|toffee|butterfinger|${PLANT_OR_DAIRY_FREE_BRAND_OR_TERM_RE}`;

/**
 * 1-for-1 exact sub-category swap table: ensures butter swaps to butter, milk swaps to milk,
 * cheese swaps to cheese, bacon swaps to bacon, tortilla chips swap to tortilla chips, etc.
 */
export const EXACT_PRODUCT_ALTERNATIVES: { match: RegExp; alt: CleanAlternative }[] = [
  // --- Plant-Based / Vegan / Dairy-Free Butters & Spreads (seed-oil-free, zero cow's dairy) ---
  {
    match: /\b(miyoko(?:'?s)?.*\b(?:butter|spread)\b|(?:cashew|almond)\b.*\b(?:plant[- ]?(?:based\s+)?|vegan\s+|dairy[- ]?free\s+|non[- ]?dairy\s+)(?:butter|buttery\s+spread))\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Miyoko's Creamery",
      name: "Organic Cultured Vegan Butter",
      sourceUrl: "https://www.miyokos.com/products/european-style-plant-milk-butter-salted",
      verifiedAt: "2026-11-11",
      size: "8 oz block",
      isOrganic: true,
      image: "/swaps/butter.jpg",
      ingredients: "Organic coconut oil, filtered water, organic cashew milk (filtered water, organic cashews), organic sunflower lecithin, sea salt, cultures.",
      nutrition: {
        caloriesKcal100g: 714,
        sugarsG100g: 0,
        saturatedFatG100g: 57.1,
        sodiumMg100g: 500,
        fiberG100g: 0,
        proteinG100g: 0,
        fruitsVegNutsPct: 0,
        isOrganic: true,
        isWholeFood: false,
      },
    },
  },
  {
    match: /\b(earth\s+balance|country\s+crock\s+plant|plant[- ]?(?:based\s+)?(?:butter|buttery\s+spread)|vegan\s+(?:butter|buttery\s+spread)|dairy[- ]?free\s+(?:butter|buttery\s+spread)|non[- ]?dairy\s+(?:butter|buttery\s+spread))\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Nutiva",
      name: "Organic Coconut Oil Buttery Flavor",
      sourceUrl: "https://nutiva.com/products/organic-buttery-coconut-oil",
      verifiedAt: "2026-11-11",
      size: "14 fl oz jar",
      isOrganic: true,
      image: "/swaps/butter.jpg",
      ingredients: "Organic refined expeller-pressed coconut oil, organic natural flavors, organic annatto extract (for color).",
      nutrition: {
        caloriesKcal100g: 928,
        sugarsG100g: 0,
        saturatedFatG100g: 85.7,
        sodiumMg100g: 0,
        fiberG100g: 0,
        proteinG100g: 0,
        fruitsVegNutsPct: 0,
        isOrganic: true,
        isWholeFood: false,
      },
    },
  },

  // --- Butter / Margarine / Spreads (1-for-1 Dairy Butter, excluding plant-based, nut/fruit/cookie butters & butter-seasoned entrees) ---
  {
    match: new RegExp(`^(?!.*\\b(${DAIRY_BUTTER_EXCLUSIONS_RE})\\b).*\\b(unsalted\\s+butter|butter\\s+unsalted)\\b`, "i"),
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Pasture-Raised Unsalted Butter",
      sourceUrl: "https://www.organicvalley.coop/products/butter/unsalted-butter/unsalted-butter-1-lb-4-quarters/",
      verifiedAt: "2026-11-09",
      size: "16 oz (4 sticks)",
      isOrganic: true,
      image: "/swaps/butter.jpg",
      ingredients: "Organic pasteurized sweet cream, microbial culture.",
      itemIds: { walmart: "10804557" },
    },
  },
  {
    match: new RegExp(`^(?!.*\\b(${DAIRY_BUTTER_EXCLUSIONS_RE})\\b).*\\b(butter|margarine|buttery spread|country crock|imperial|blue bonnet|parkay|smart balance|i can'?t believe it'?s not butter|kerrygold|land o'? ?lakes)\\b`, "i"),
    alt: CLEAN_ALTERNATIVES["Butter/Dairy"],
  },

  // --- Milk & Protein Shakes (1-for-1: Protein Shakes, Chocolate Milk, Plant Milks, 2%, Whole/Skim/Lactose-Free) ---
  {
    match: /\b(core\s+power|premier\s+protein|muscle\s+milk|fairlife\s+(?:elite|nutrition\s+plan|protein)|whey\s+protein|gold\s+standard\s+whey|ghost\s+whey|protein\s+shake|protein\s+milk\s+shake|protein\s+powder)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Orgain",
      name: "Organic Grass-Fed Clean Protein Shake",
      size: "4 pack (11 fl oz cartons)",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Filtered Water, Orgain Organic Grass-Fed Milk Protein Concentrate, Organic Erythritol, Organic Fair Trade Alkalized Cocoa, Organic Acacia, Sea Salt, Organic Monk Fruit Extract, Organic Stevia.",
      nutrition: { caloriesKcal100g: 42, sugarsG100g: 0.6, saturatedFatG100g: 0.3, sodiumMg100g: 55, fiberG100g: 0.9, proteinG100g: 6.5, fruitsVegNutsPct: 0, isOrganic: true, isWholeFood: false },
      sourceUrl: "https://orgain.com/products/organic-grass-fed-clean-protein-shake",
      verifiedAt: "2026-11-09",
      itemIds: { walmart: "747542700" },
    },
  },
  {
    match: new RegExp(`^(?=.*\\b(${PLANT_MILK_QUALIFIER_RE})\\b).*\\bchocolate\\b.*\\b(milk|almondmilk|oatmilk|soymilk|coconutmilk|beverage)\\b`, "i"),
    alt: {
      category: "Butter/Dairy",
      brand: "MALK",
      name: "Organic Chocolate Oat Milk",
      sourceUrl: "https://malkorganics.com/products/chocolate-oat-malk/",
      verifiedAt: "2026-11-10",
      size: "28 fl oz bottle",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Filtered water, organic gluten-free oats, organic coconut sugar, organic dutch processed cocoa powder, Himalayan pink salt.",
      nutrition: {
        caloriesKcal100g: 37.5,
        sugarsG100g: 3.8,
        saturatedFatG100g: 0.2,
        sodiumMg100g: 46,
        fiberG100g: 0.8,
        proteinG100g: 1.3,
        fruitsVegNutsPct: 0,
        isOrganic: true,
        isWholeFood: false,
      },
    },
  },
  {
    match: new RegExp(`^(?!.*\\b(${PLANT_MILK_QUALIFIER_RE})\\b).*\\b(chocolate\\s+milk|fairlife\\s+chocolate|nesquik|ooey\\s+gooey.*milk|trumu|tru\\s*moo)\\b`, "i"),
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Grassmilk Lowfat Chocolate Milk",
      sourceUrl: "https://www.organicvalley.coop/products/milk/grassmilk/grassmilk-lowfat-chocolate-half-gallon/",
      verifiedAt: "2026-11-09",
      size: "64 oz carton",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Organic Grade A lowfat milk, organic fair trade cane sugar, organic fair trade cocoa, organic vanilla, salt, vitamin A palmitate, vitamin D3.",
      itemIds: { walmart: "10804553" },
    },
  },
  {
    match: /^(?!.*\bcreamer\b).*\b(oat\s*(?:milk|beverage|drink|barista)|oatmilk|milked\s+oats?|planet\s+oat|oatly|chobani\s+oat|silk\s+oat(?:milk|\s+yeah)?|califia.*\boat\b)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Califia Farms",
      name: "Organic Unsweetened Oatmilk",
      sourceUrl: "https://www.califiafarms.com/products/organic-oatmilk/",
      verifiedAt: "2026-11-09",
      size: "48 fl oz bottle",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Purified water, organic oats, sea salt.",
      nutrition: {
        caloriesKcal100g: 33.3,
        sugarsG100g: 1.3,
        saturatedFatG100g: 0,
        sodiumMg100g: 43.8,
        fiberG100g: 0.4,
        proteinG100g: 0.8,
        fruitsVegNutsPct: 0,
        isOrganic: true,
        isWholeFood: false,
      },
      itemIds: { walmart: "269553533" },
    },
  },
  {
    match: /^(?!.*\bcreamer\b).*\b(soy\s*(?:milk|beverage|drink)|soymilk|silk\s+(?:original\s+|unsweetened\s+|vanilla\s+|organic\s+)?soy|westsoy|edensoy)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "WestSoy",
      name: "Organic Unsweetened Plain Soymilk",
      sourceUrl: "https://www.westsoytofu.com/products/unsweetened-plain-organic-plus/",
      verifiedAt: "2026-11-10",
      size: "32 fl oz carton",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Filtered water, whole organic soybeans.",
      nutrition: {
        caloriesKcal100g: 37.5,
        sugarsG100g: 0.8,
        saturatedFatG100g: 0.2,
        sodiumMg100g: 12.5,
        fiberG100g: 0.8,
        proteinG100g: 3.8,
        fruitsVegNutsPct: 0,
        isOrganic: true,
        isWholeFood: false,
      },
    },
  },
  {
    match: /^(?!.*\b(creamer|coconut\s+water|harmless\s+harvest|vita\s+coco)\b).*\b(coconut\s*(?:milk\s+beverage|beverage|drink)|coconutmilk|so\s+delicious.*coconut|silk.*coconut)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Native Forest",
      name: "Organic Simple Unsweetened Coconut Milk",
      sourceUrl: "https://store.edwardandsons.com/products/organic-simple-coconut-milk",
      verifiedAt: "2026-11-10",
      size: "13.5 fl oz can",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Organic coconut, filtered water.",
      nutrition: {
        caloriesKcal100g: 185,
        sugarsG100g: 1.2,
        saturatedFatG100g: 15,
        sodiumMg100g: 18,
        fiberG100g: 0,
        proteinG100g: 1.2,
        fruitsVegNutsPct: 0,
        isOrganic: true,
        isWholeFood: false,
      },
    },
  },
  {
    match: /^(?!.*\bcreamer\b).*\b(almond\s*(?:milk|beverage|drink)|almondmilk|almond\s+breeze|silk\s+almond|califia.*\balmond\b)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Califia Farms",
      name: "Organic Unsweetened Almondmilk",
      sourceUrl: "https://www.califiafarms.com/products/organic-almondmilk/",
      verifiedAt: "2026-11-09",
      size: "48 fl oz bottle",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Purified water, organic almonds, sea salt.",
      nutrition: {
        caloriesKcal100g: 14.6,
        sugarsG100g: 0,
        saturatedFatG100g: 0,
        sodiumMg100g: 58.3,
        fiberG100g: 0.4,
        proteinG100g: 0.4,
        fruitsVegNutsPct: 5,
        isOrganic: true,
        isWholeFood: false,
      },
      itemIds: { walmart: "520102935" },
    },
  },
  {
    match: new RegExp(`^(?!.*\\b(${PLANT_MILK_QUALIFIER_RE}|milk\\s+chocolate)\\b).*\\b(2%\\s*(?:reduced\\s*fat\\s*)?milk|reduced\\s*fat\\s*milk)\\b`, "i"),
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Grassmilk 2% Reduced Fat Milk",
      sourceUrl: "https://www.organicvalley.coop/products/milk/grassmilk/grassmilk-2-half-gallon/",
      verifiedAt: "2026-11-09",
      size: "64 oz carton",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Organic Grade A reduced fat milk, vitamin A palmitate, vitamin D3.",
      itemIds: { walmart: "142608569" },
    },
  },
  {
    match: new RegExp(`^(?!.*\\b(${PLANT_MILK_QUALIFIER_RE}|milk\\s+chocolate|condensed|evaporated)\\b).*\\b(whole\\s+milk|vitamin\\s+d\\s+milk|1%\\s*milk|lowfat\\s+milk|skim\\s+milk|fat\\s*free\\s+milk|milk\\s*gallon|gallon\\s*milk|lactaid|fairlife|horizon.*milk|great\\s+value.*milk)\\b`, "i"),
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic 100% Grassmilk Whole Milk",
      size: "59 fl oz carton",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Organic Grade A whole milk, vitamin D3.",
      nutrition: { caloriesKcal100g: 150 / 2.4, sugarsG100g: 11 / 2.4, saturatedFatG100g: 5 / 2.4, sodiumMg100g: 120 / 2.4, fiberG100g: 0, proteinG100g: 8 / 2.4, fruitsVegNutsPct: 0, isOrganic: true },
      sourceUrl: "https://www.organicvalley.coop/products/grassmilk-whole-milk",
      verifiedAt: "2026-11-09",
      itemIds: { walmart: "142608568" },
    },
  },

  // --- Creamer, Heavy Cream, Half & Half, Sour Cream, Cottage Cheese, Cream Cheese ---
  {
    match: new RegExp(`^(?=.*\\b(${PLANT_MILK_QUALIFIER_RE})\\b).*\\b(creamer|barista\\s+blend)\\b|\\bnutpods\\b`, "i"),
    alt: {
      category: "Butter/Dairy",
      brand: "Laird Superfood",
      name: "Organic Unsweetened Non-Dairy Superfood Creamer",
      sourceUrl: "https://lairdsuperfood.com/products/unsweetened-superfood-creamer",
      verifiedAt: "2026-11-10",
      size: "8 oz bag",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Organic coconut milk powder, organic extra virgin coconut oil, aquamin (calcified marine algae).",
    },
  },
  {
    match: new RegExp(`^(?!.*\\b(${PLANT_MILK_QUALIFIER_RE})\\b).*\\b(creamer|coffee-?mate|international\\s+delight|starbucks\\s+creamer|dunkin.*creamer)\\b`, "i"),
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Sweet Cream Coffee Creamer",
      sourceUrl: "https://www.organicvalley.coop/products/cream/sweet-cream-creamer/",
      verifiedAt: "2026-11-09",
      size: "28 fl oz bottle",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Organic milk, organic cream, organic fair trade cane sugar, organic vanilla extract.",
      itemIds: { walmart: "46330062" },
    },
  },
  {
    match: new RegExp(`^(?!.*\\b(${PLANT_OR_DAIRY_FREE_BRAND_OR_TERM_RE})\\b).*\\b(heavy\\s+cream|whipping\\s+cream|whipped\\s+cream|whipped\\s+topping|cool\\s+whip|reddi-?wip)\\b`, "i"),
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Heavy Whipping Cream",
      sourceUrl: "https://www.organicvalley.coop/products/cream/heavy-whipping-cream/heavy-whipping-cream-pint/",
      verifiedAt: "2026-11-09",
      size: "16 fl oz carton",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Organic Grade A pasteurized heavy cream.",
      itemIds: { walmart: "10804564" },
    },
  },
  {
    match: new RegExp(`^(?!.*\\b(${PLANT_OR_DAIRY_FREE_BRAND_OR_TERM_RE})\\b).*\\b(half\\s+and\\s+half|half\\s*&\\s*half)\\b`, "i"),
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Half & Half",
      sourceUrl: "https://www.organicvalley.coop/products/cream/half-half/half-half-quart/",
      verifiedAt: "2026-11-09",
      size: "32 fl oz carton",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Organic Grade A milk, organic Grade A cream.",
      itemIds: { walmart: "10804562" },
    },
  },
  {
    match: new RegExp(`^(?!.*\\b(${PLANT_OR_DAIRY_FREE_BRAND_OR_TERM_RE})\\b).*\\b(sour\\s+cream|daisy\\s+sour\\s+cream)\\b`, "i"),
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Cultured Sour Cream",
      sourceUrl: "https://www.organicvalley.coop/products/sour-cream/sour-cream/sour-cream-16-oz/",
      verifiedAt: "2026-11-09",
      size: "16 oz tub",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Organic cultured pasteurized Grade A cream, organic nonfat milk, microbial enzyme.",
      itemIds: { walmart: "10804568" },
    },
  },
  {
    match: new RegExp(`^(?!.*\\b(${PLANT_OR_DAIRY_FREE_BRAND_OR_TERM_RE})\\b).*\\b(cottage\\s+cheese)\\b`, "i"),
    alt: {
      category: "Butter/Dairy",
      brand: "Good Culture",
      name: "Organic Whole Milk Classic Cottage Cheese",
      sourceUrl: "https://goodculture.com/organic-whole-milk-classic/",
      verifiedAt: "2026-11-09",
      size: "16 oz tub",
      isOrganic: true,
      image: "/swaps/cheese.png",
      ingredients: "Organic skim milk, organic whole milk, organic cream, Celtic sea salt, live and active cultures.",
      itemIds: { walmart: "189402512" },
    },
  },
  {
    match: new RegExp(`^(?!.*\\b(${PLANT_OR_DAIRY_FREE_BRAND_OR_TERM_RE})\\b).*\\b(cream\\s+cheese|philadelphia|neufchatel)\\b`, "i"),
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Cream Cheese",
      sourceUrl: "https://www.organicvalley.coop/products/cheese/cream-cheese/cream-cheese-8-oz/",
      verifiedAt: "2026-11-09",
      size: "8 oz block",
      isOrganic: true,
      image: "/swaps/cheese.png",
      ingredients: "Organic pasteurized milk and cream, cheese culture, salt.",
      itemIds: { walmart: "10804559" },
    },
  },

  // --- Cheese, Eggs, Ice Cream ---
  {
    match: new RegExp(`^(?!.*\\b(${PLANT_OR_DAIRY_FREE_BRAND_OR_TERM_RE})\\b).*\\b(string\\s+cheese|mozzarella|babybel)\\b`, "i"),
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Mozzarella Stringles String Cheese",
      sourceUrl: "https://www.organicvalley.coop/products/cheese/stringles/mozzarella-stringles-6-oz/",
      verifiedAt: "2026-11-09",
      size: "6 oz pack",
      isOrganic: true,
      image: "/swaps/cheese.png",
      ingredients: "Organic pasteurized part-skim milk, cheese cultures, sea salt, vegetarian enzymes.",
      itemIds: { walmart: "10804566" },
    },
  },
  {
    match: new RegExp(`^(?!.*\\b(${PLANT_OR_DAIRY_FREE_BRAND_OR_TERM_RE}|mac.*cheese|macaroni|crackers?|cheetos|doritos|cheez-?it|puffs?|chips?|crisps?|tortilla|popcorn|fries|tots|dip|sauce|soup|chowder|burrito|sandwich|croissant|danish|pastry|bagels?|pizza|pretzels?)\\b).*\\b(american\\s+(?:sliced\\s+|cheese|pasteurized|singles)|kraft\\s+singles|velveeta\\s+slices|sargento.*\\bamerican\\b|borden.*\\bamerican\\b|great\\s+value.*\\bamerican\\b)\\b`, "i"),
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic American Cheese Slices",
      sourceUrl: "https://www.organicvalley.coop/products/cheese/american/american-cheese-slices-6-oz/",
      verifiedAt: "2026-11-09",
      size: "6 oz pack",
      isOrganic: true,
      image: "/swaps/cheese.png",
      ingredients: "Organic cultured pasteurized milk, organic cream, water, sodium citrate, salt, organic annatto (color), vegetarian enzyme.",
      itemIds: { walmart: "1814292019" },
    },
  },
  {
    match: new RegExp(`^(?!.*\\b(${PLANT_OR_DAIRY_FREE_BRAND_OR_TERM_RE}|mac.*cheese|macaroni|shells?\\s*(?:&|and)\\s*(?:real\\s+aged\\s+|white\\s+)?cheddar|annie'?s.*shells|crackers?|cheetos|doritos|cheez-?it|puffs?|chips?|crisps?|tortilla|popcorn|fries|tots|dip|sauce|soup|chowder|burrito|sandwich|croissant|danish|pastry|bagels?|pizza|pretzels?)\\b).*\\b(cheese|cheddar|velveeta|kraft\\s+singles|american\\s+singles|queso|colby|monterey\\s+jack|swiss|provolone|gouda|parmesan|sargento|tillamook)\\b`, "i"),
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Sharp Cheddar Cheese",
      sourceUrl: "https://www.organicvalley.coop/products/cheese/cheddar/sharp-cheddar-8-oz/",
      verifiedAt: "2026-11-09",
      size: "8 oz block",
      isOrganic: true,
      image: "/swaps/cheese.png",
      ingredients: "Organic cultured pasteurized milk, salt, vegetarian enzyme.",
      itemIds: { walmart: "19757363" },
    },
  },
  {
    match: /\b(eggnog|egg\s+nog)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Classic Eggnog",
      sourceUrl: "https://www.organicvalley.coop/products/eggnog/eggnog/eggnog-quart/",
      verifiedAt: "2026-11-09",
      size: "32 fl oz carton",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Organic Grade A milk, organic Grade A cream, organic cane sugar, organic egg yolks, organic vanilla extract, organic nutmeg.",
      itemIds: { walmart: "47224562" },
    },
  },
  {
    match: /^(?!.*\b(noodles?|rolls?|soup|salad|fried\s+rice|pasta|waffles?|mcmuffin|sandwich|custard|nog|mayo|mayonnaise|cookies?|cake|pastry|pastries)\b).*\b(eggs?|egg\s+whites?|egg\s+beaters)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Vital Farms",
      name: "Pasture-Raised Organic Large Eggs",
      sourceUrl: "https://vitalfarms.com/pasture-raised-organic-eggs/",
      verifiedAt: "2026-11-09",
      size: "12 count carton",
      isOrganic: true,
      image: "/swaps/eggs.png",
      ingredients: "Organic pasture-raised shell eggs.",
      itemIds: { walmart: "47908222" },
    },
  },
  {
    match: new RegExp(`^(?!.*\\b(${PLANT_OR_DAIRY_FREE_BRAND_OR_TERM_RE})\\b).*\\b(ice\\s+cream|gelato|sorbet|popsicle|outshine|fudge\\s+bar|drumstick|klondike|ben\\s*&\\s*jerry|talenti|breyers|blue\\s+bell|edys|halo\\s+top|sundae\\s+shoppe|haagen-?dazs|häagen-?dazs)\\b`, "i"),
    alt: {
      category: "Butter/Dairy",
      brand: "Alden's Organic",
      name: "Vanilla Bean Ice Cream",
      sourceUrl: "https://www.aldensorganic.com/products/vanilla-bean-pint/",
      verifiedAt: "2026-11-09",
      size: "14 oz pint",
      isOrganic: true,
      image: "/swaps/icecream.png",
      ingredients: "Organic milk, organic cream, organic cane sugar, organic egg yolks, organic vanilla extract, organic ground vanilla beans.",
      nutrition: {
        caloriesKcal100g: 223.5,
        sugarsG100g: 18.8,
        saturatedFatG100g: 7.1,
        sodiumMg100g: 58.8,
        fiberG100g: 0,
        proteinG100g: 3.5,
        fruitsVegNutsPct: 0,
        isOrganic: true,
        isWholeFood: false,
      },
      itemIds: { walmart: "46791616" },
    },
  },

  // --- Nut Butters, Hazelnut Spread & Jam/Jelly ---
  {
    match: /\b(nutella|hazelnut\s+spread)\b/i,
    alt: {
      category: "Snacks",
      brand: "Nutiva",
      name: "Organic Hazelnut Spread Classic",
      sourceUrl: "https://nutiva.com/products/organic-hazelnut-spread-classic/",
      verifiedAt: "2026-11-09",
      size: "13 oz jar",
      isOrganic: true,
      image: "/swaps/peanutbutter.png",
      ingredients: "Organic hazelnuts, organic cane sugar, organic cocoa powder, organic coconut oil, organic vanilla extract.",
      itemIds: { walmart: "44391172" },
    },
  },
  {
    match: /\b(sunflower\s+(seed\s+)?butter|sunbutter)\b/i,
    alt: {
      category: "Snacks",
      brand: "SunButter",
      name: "Organic Unsweetened Sunflower Butter (Nut-Free)",
      sourceUrl: "https://sunbutter.com/product/organic-sunflower-butter/",
      verifiedAt: "2026-11-09",
      size: "16 oz jar",
      isOrganic: true,
      image: "/swaps/peanutbutter.png",
      ingredients: "Organic roasted sunflower seeds.",
      itemIds: { walmart: "26965043" },
    },
  },
  {
    match: /\b(almond\s+butter|cashew\s+butter|maranatha|justin'?s\s+almond)\b/i,
    alt: {
      category: "Snacks",
      brand: "MaraNatha",
      name: "Organic Raw Creamy Almond Butter (Peanut-Free)",
      sourceUrl: "https://www.maranathabutters.com/product/organic-raw-almond-butter-creamy/",
      verifiedAt: "2026-11-09",
      size: "12 oz jar",
      isOrganic: true,
      image: "/swaps/peanutbutter.png",
      ingredients: "Organic raw almonds.",
      itemIds: { walmart: "38440284" },
    },
  },
  {
    match: /\b(peanut\s+butter|jif|skippy|peter\s+pan)\b/i,
    alt: {
      category: "Snacks",
      brand: "Santa Cruz Organic",
      name: "Creamy Dark Roasted Peanut Butter",
      sourceUrl: "https://www.santacruzorganic.com/products/peanut-butter/creamy-dark-roasted-peanut-butter",
      verifiedAt: "2026-11-09",
      size: "16 oz jar",
      isOrganic: true,
      image: "/swaps/peanutbutter.png",
      ingredients: "Organic roasted peanuts, salt.",
      itemIds: { walmart: "10308907" },
    },
  },
  {
    match: /\b(jam|jelly|preserves|marmalade|fruit\s+spread|smucker'?s|welch'?s\s+grape)\b/i,
    alt: {
      category: "Snacks",
      brand: "Crofter's Organic",
      name: "Strawberry Just Fruit Spread",
      sourceUrl: "https://croftersorganic.com/product/strawberry-just-fruit-spread/",
      verifiedAt: "2026-11-09",
      size: "16.5 oz jar",
      isOrganic: true,
      image: "/swaps/jam.png",
      ingredients: "Organic strawberries, organic concentrated white grape juice, natural apple pectin, ascorbic acid.",
      itemIds: { walmart: "25856565" },
    },
  },

  // --- Crackers ---
  {
    match: /\b(cheez-?it|goldfish|cheddar\s+crackers?|cheese\s+crackers?)\b/i,
    alt: CLEAN_ALTERNATIVES.Crackers,
  },
  {
    match: /\b(graham\s+crackers?|honey\s+maid)\b/i,
    alt: {
      category: "Crackers",
      brand: "Annie's Homegrown",
      name: "Organic Honey Graham Crackers",
      sourceUrl: "https://www.annies.com/products/organic-honey-graham-crackers",
      verifiedAt: "2026-11-09",
      size: "14.4 oz box",
      isOrganic: true,
      image: "/swaps/crackers.jpg",
      ingredients: "Organic whole grain wheat flour, organic cane sugar, organic expeller-pressed coconut oil, organic honey, baking soda, sea salt.",
      itemIds: { walmart: "10448935" },
    },
  },

  // --- Instant Mashed Potatoes, French Fries & Crispy Fried Onions ---
  {
    match: /\b(instant\s+mashed|mashed\s+potato(?:es)?|potato\s+flakes?|idahoan|betty\s+crocker.*potato(?:es)?|hungry\s+jack.*potato(?:es)?|ore[- ]?ida|french\s+fries|crinkle\s+cut|waffle\s+fries|steak\s+fries|curly\s+fries|shoestring\s+fries|tater\s+tots?|hash\s*browns?|golden\s+crinkles)\b/i,
    alt: {
      category: "Snacks",
      brand: "Organic Produce",
      name: "Organic Whole Yukon Gold Potatoes",
      sourceUrl: "https://fdc.nal.usda.gov/food-details/170026/nutrients",
      verifiedAt: "2026-11-09",
      size: "3 lb bag",
      image: "/swaps/produce.png",
      ingredients: "100% organic whole Yukon Gold potatoes.",
      isOrganic: true,
      itemIds: { walmart: "44391097" },
    },
  },
  {
    match: /\b((?:crispy\s+)?fried\s+onions?|crispy\s+onions?|french'?s.*onions?|onion\s+rings?)\b/i,
    alt: {
      category: "Snacks",
      brand: "Organic Produce",
      name: "Organic Fresh Yellow Onions",
      sourceUrl: "https://fdc.nal.usda.gov/food-details/170000/nutrients",
      verifiedAt: "2026-11-09",
      size: "3 lb bag",
      image: "/swaps/produce.png",
      ingredients: "100% organic fresh yellow onions.",
      isOrganic: true,
      itemIds: { walmart: "51259029" },
    },
  },

  // --- Chips, Pretzels, Popcorn, Cheese Puffs ---
  {
    match: /\b(tortilla\s+chips?|corn\s+chips?|doritos|tostitos|fritos|takis|santitas|mission\s+strips)\b/i,
    alt: {
      category: "Chips",
      brand: "Siete",
      name: "Grain Free Sea Salt Tortilla Chips with Avocado Oil",
      sourceUrl: "https://sietefoods.com/products/sea-salt-grain-free-tortilla-chips",
      verifiedAt: "2026-11-09",
      size: "5 oz bag",
      image: "/swaps/chips.jpg",
      ingredients: "Cassava flour, avocado oil, coconut flour, ground chia seed, sea salt.",
      itemIds: { walmart: "526863587" },
    },
  },
  {
    match: /^(?!.*\b(cereal|breakfast|marshmallow|cocoa|oreo|reese|wheat|rice|kamut|oat|candy|peppermint|pastry|pastries)\b).*\b(cheetos|cheese\s+puffs?|puffs|pirate'?s\s+booty|funyuns)\b/i,
    alt: {
      category: "Chips",
      brand: "LesserEvil",
      name: "Organic Cheddar Space Balls",
      sourceUrl: "https://lesserevil.com/products/interstellar-cheddar-space-balls",
      verifiedAt: "2026-11-09",
      size: "5 oz bag",
      isOrganic: true,
      image: "/swaps/chips.jpg",
      ingredients: "Organic non-GMO cornmeal, organic avocado oil, organic cheddar cheese, sea salt.",
      itemIds: { walmart: "1284592031" },
    },
  },
  {
    match: /\b(pretzels?|rold\s+gold|snyder'?s|utz\s+pretzels?)\b/i,
    alt: {
      category: "Chips",
      brand: "Newman's Own",
      name: "Organic Spelt Pretzels",
      sourceUrl: "https://newmansown.com/product/spelt-pretzels/",
      verifiedAt: "2026-11-09",
      size: "7 oz bag",
      isOrganic: true,
      image: "/swaps/chips.jpg",
      ingredients: "Organic spelt wheat flour, organic unbleached wheat flour, organic extra virgin olive oil, organic malt syrup, salt, yeast, baking soda.",
      itemIds: { walmart: "24184031" },
    },
  },
  {
    match: /\b(popcorn|smartfood|skinny\s*pop|boomchickapop|act\s+ii|orville)\b/i,
    alt: {
      category: "Chips",
      brand: "LesserEvil",
      name: "Organic Himalayan Pink Salt Coconut Oil Popcorn",
      sourceUrl: "https://lesserevil.com/products/himalayan-pink-salt-organic-popcorn",
      verifiedAt: "2026-11-09",
      size: "4.6 oz bag",
      isOrganic: true,
      image: "/swaps/chips.jpg",
      ingredients: "Organic non-GMO popcorn, organic extra virgin coconut oil, Himalayan pink salt.",
      itemIds: { walmart: "351896748" },
    },
  },

  // --- Cereal, Oatmeal, Granola, Maple Syrup ---
  {
    match: /\b(oatmeal|rolled\s+oats|steel\s+cut\s+oats|instant\s+oats|quaker\s+oats)\b/i,
    alt: {
      category: "Cereal",
      brand: "Bob's Red Mill",
      name: "Organic Old Fashioned Rolled Oats",
      sourceUrl: "https://www.bobsredmill.com/organic-old-fashioned-rolled-oats.html",
      verifiedAt: "2026-11-09",
      size: "32 oz bag",
      isOrganic: true,
      image: "/swaps/oats.png",
      ingredients: "100% organic whole grain rolled oats.",
      itemIds: { walmart: "10449439" },
    },
  },
  {
    match: /\b(granola)\b/i,
    alt: {
      category: "Cereal",
      brand: "Purely Elizabeth",
      name: "Organic Original Ancient Grain Granola",
      sourceUrl: "https://purelyelizabeth.com/products/original-ancient-grain-granola",
      verifiedAt: "2026-11-09",
      size: "12 oz bag",
      isOrganic: true,
      image: "/swaps/oats.png",
      ingredients: "Organic gluten-free oats, organic coconut sugar, organic raw virgin coconut oil, organic puffed amaranth, organic quinoa flakes, organic chia seeds, organic cinnamon, sea salt.",
      itemIds: { walmart: "55305740" },
    },
  },
  {
    match: /\b(fruit\s+cups?|fruit\s+bowls?|dole\s+.*\b(?:peaches?|pears?|pineapple|mandarins?|fruit)|del\s+monte\s+.*\b(?:peaches?|pears?|pineapple|mandarins?|fruit)|(?:peaches?|pears?|mandarin\s+oranges?|fruit\s+cocktail)\s+in\s+(?:heavy|light|extra\s+light|100%\s*juice|syrup))\b/i,
    alt: {
      category: "Snacks",
      brand: "Mott's",
      name: "No Sugar Added Unsweetened Applesauce",
      sourceUrl: "https://www.motts.com/products/applesauce/unsweetened-applesauce",
      verifiedAt: "2026-11-10",
      size: "6 count cups",
      image: "/swaps/produce.png",
      ingredients: "Apples, water, ascorbic acid (vitamin C).",
      nutrition: { caloriesKcal100g: 45, sugarsG100g: 9.9, saturatedFatG100g: 0, sodiumMg100g: 0, fiberG100g: 0.9, proteinG100g: 0, fruitsVegNutsPct: 100, isWholeFood: true },
    },
  },
  {
    match: /^(?!.*\b(peaches?|pears?|pineapple|mandarins?|oranges?|cherries|cocktail|fruit\s+cups?|heavy\s+syrup|light\s+syrup|cough)\b).*\b(syrup|mrs\.?\s*butterworth|pearl\s+milling|log\s+cabin|aunt\s+jemima)\b/i,
    alt: {
      category: "Cereal",
      brand: "Coombs Family Farms",
      name: "Organic 100% Pure Grade A Amber Maple Syrup",
      sourceUrl: "https://www.coombsfamilyfarms.com/products/organic-maple-syrup/",
      verifiedAt: "2026-11-09",
      size: "12 fl oz bottle",
      isOrganic: true,
      image: "/swaps/syrup.png",
      ingredients: "100% pure organic maple syrup.",
      itemIds: { walmart: "10315075" },
    },
  },
  {
    match: /\b(ramen|maruchan|top\s+ramen|nissin|cup\s+noodles?|shin\s+ramyun|buldak|samyang|indomie|nongshim|sapporo\s+ichiban)\b/i,
    alt: {
      category: "Cereal",
      brand: "Lotus Foods",
      name: "Organic Millet & Brown Rice Ramen",
      sourceUrl: "https://www.lotusfoods.com/products/organic-millet-brown-rice-ramen-4-pack",
      verifiedAt: "2026-11-09",
      size: "10 oz (4 pack)",
      isOrganic: true,
      image: "/swaps/soup.png",
      ingredients: "Organic brown rice flour, organic millet flour, water.",
    },
  },
  {
    match: /\b(cream\s+of\s+(?:chicken|mushroom|celery)|condensed\s+.*soup)\b/i,
    alt: {
      category: "Dressings",
      brand: "Pacific Foods",
      name: "Organic Cream of Chicken Condensed Soup",
      sourceUrl: "https://www.pacificfoods.com/products/organic-cream-of-chicken-condensed-soup/",
      verifiedAt: "2026-11-09",
      size: "10.5 oz can",
      isOrganic: true,
      image: "/swaps/soup.png",
      ingredients: "Water, organic chicken, organic rice flour, organic heavy cream, organic chicken broth, organic cornstarch, sea salt, organic onion powder, organic garlic powder, organic spices.",
      itemIds: { walmart: "541659748" },
    },
  },
  {
    match: /\b(clam\s+chowder|chowder|soup|bisque|stew|chili|campbell'?s|progresso)\b/i,
    alt: {
      category: "Dressings",
      brand: "Amy's Organic",
      name: "Low Fat Lentil Vegetable Soup",
      sourceUrl: "https://www.amys.com/our-foods/organic-lentil-vegetable-soup-low-fat",
      verifiedAt: "2026-11-09",
      size: "14.5 oz can",
      isOrganic: true,
      image: "/swaps/soup.png",
      ingredients: "Filtered water, organic onions, organic carrots, organic lentils, organic celery, organic potatoes, organic tomatoes, organic spinach, organic extra virgin olive oil, sea salt, organic garlic, organic bay leaf.",
      itemIds: { walmart: "29873666" },
    },
  },

  // --- Dressings, Condiments, Sauces, Dips & Broth ---
  {
    match: /\b(guacamole|wholly\s+guacamole|park\s+street\s+deli.*guac)\b/i,
    alt: {
      category: "Dressings",
      brand: "Wholly Guacamole",
      name: "Organic Classic Guacamole (Sesame-Free)",
      sourceUrl: "https://www.eatwholly.com/products/wholly-guacamole/organic-classic-guacamole/",
      verifiedAt: "2026-11-09",
      size: "7.5 oz tub",
      isOrganic: true,
      image: "/swaps/salsa.png",
      ingredients: "Organic Hass avocados, organic white vinegar, organic jalapeno puree, organic dehydrated onion, sea salt, organic granulated garlic.",
      itemIds: { walmart: "15544056" },
    },
  },
  {
    match: /\b(hummus|tzatziki|sabra|park\s+street\s+deli.*(hummus|dip))\b/i,
    alt: {
      category: "Dressings",
      brand: "Hope Foods",
      name: "Organic Original Sea Salt Hummus with Extra Virgin Olive Oil",
      sourceUrl: "https://hopefoods.com/products/original-recipe-hummus",
      verifiedAt: "2026-11-09",
      size: "8 oz tub",
      isOrganic: true,
      image: "/swaps/salsa.png",
      ingredients: "Organic garbanzo beans, water, organic tahini (ground sesame), organic extra virgin olive oil, sea salt, organic lemon juice, organic garlic, organic cumin.",
      itemIds: { walmart: "46791619" },
    },
  },
  {
    match: /\b(gravy|broth|stock|bouillon)\b/i,
    alt: {
      category: "Dressings",
      brand: "Kettle & Fire",
      name: "Organic Turkey Bone Broth",
      sourceUrl: "https://www.kettleandfire.com/products/turkey-bone-broth",
      verifiedAt: "2026-11-09",
      size: "16.9 oz carton",
      isOrganic: true,
      image: "/swaps/broth.png",
      ingredients: "Organic turkey bone broth (water, organic turkey bones, organic onions, organic carrots, organic celery), organic apple cider vinegar, sea salt, organic rosemary, organic sage, organic thyme, organic black pepper.",
      itemIds: { walmart: "194761382" },
    },
  },
  {
    match: /\b(mayo|mayonnaise|miracle\s+whip|hellmann'?s|best\s+foods|duke'?s|aioli)\b/i,
    alt: {
      category: "Dressings",
      brand: "Primal Kitchen",
      name: "Real Mayonnaise Made with Avocado Oil",
      sourceUrl: "https://www.primalkitchen.com/products/avocado-oil-mayo",
      verifiedAt: "2026-11-09",
      size: "12 oz jar",
      image: "/swaps/mayo.png",
      ingredients: "Avocado oil, organic eggs, organic egg yolks, organic vinegar, sea salt, organic rosemary extract.",
      itemIds: { walmart: "673755804" },
    },
  },
  {
    match: /\b(ketchup|catsup|heinz\s+tomato\s+ketchup)\b/i,
    alt: {
      category: "Dressings",
      brand: "Primal Kitchen",
      name: "Organic Unsweetened Ketchup",
      sourceUrl: "https://www.primalkitchen.com/products/organic-unsweetened-ketchup",
      verifiedAt: "2026-11-09",
      size: "11.3 oz bottle",
      isOrganic: true,
      image: "/swaps/ketchup.png",
      ingredients: "Organic tomato concentrate, organic balsamic vinegar, salt, organic onion powder, organic garlic powder, organic spices.",
      itemIds: { walmart: "904602875" },
    },
  },
  {
    match: /^(?!.*\b(onions?|fried|crispy)\b).*\b(mustard|french'?s|grey\s+poupon)\b/i,
    alt: {
      category: "Dressings",
      brand: "Annie's Homegrown",
      name: "Organic Yellow Mustard",
      sourceUrl: "https://www.annies.com/products/organic-yellow-mustard",
      verifiedAt: "2026-11-09",
      size: "9 oz bottle",
      isOrganic: true,
      image: "/swaps/mustard.png",
      ingredients: "Organic distilled white vinegar, water, organic mustard seed, sea salt, organic turmeric, organic paprika, organic cloves.",
      itemIds: { walmart: "15556013" },
    },
  },
  {
    match: /\b(wasabi|horseradish|inglehoffer|beaver\s+brand)\b/i,
    alt: {
      category: "Dressings",
      brand: "Bubbies",
      name: "Organic Pure Prepared Horseradish & Wasabi",
      sourceUrl: "https://www.bubbies.com/products/prepared-horseradish",
      verifiedAt: "2026-11-09",
      size: "6.5 oz jar",
      isOrganic: true,
      image: "/swaps/mustard.png",
      ingredients: "Organic grated horseradish roots, water, organic white distilled vinegar, organic wasabi root, sea salt.",
      itemIds: { walmart: "47228901" },
    },
  },
  {
    match: /\b(bbq|barbecue|sweet\s+baby\s+ray'?s|kc\s+masterpiece|bull'?s-?eye|steak\s+sauce|a\.?1\.?|heinz\s+57|worcestershire)\b/i,
    alt: {
      category: "Dressings",
      brand: "Primal Kitchen",
      name: "Organic Unsweetened Classic Steak & BBQ Sauce",
      sourceUrl: "https://www.primalkitchen.com/products/classic-bbq-sauce",
      verifiedAt: "2026-11-09",
      size: "8.5 oz bottle",
      isOrganic: true,
      image: "/swaps/bbq.png",
      ingredients: "Organic tomato puree, organic date paste, organic apple cider vinegar, organic yellow mustard, sea salt, organic black pepper, organic onion powder, organic garlic powder.",
      itemIds: { walmart: "478556215" },
    },
  },
  {
    match: /\b(marinara|pasta\s+sauce|spaghetti\s+sauce|tomato\s+sauce|alfredo|vodka\s+sauce|prego|ragu|bertolli|classico)\b/i,
    alt: {
      category: "Dressings",
      brand: "Rao's Homemade",
      name: "Marinara Pasta Sauce",
      sourceUrl: "https://www.raos.com/products/marinara-sauce",
      verifiedAt: "2026-11-09",
      size: "24 oz jar",
      image: "/swaps/marinara.png",
      ingredients: "Italian whole peeled tomatoes, olive oil, onions, salt, garlic, basil, black pepper, oregano.",
      itemIds: { walmart: "47228945" },
    },
  },
  {
    match: /\b(salsa|picante|pace|herdez)\b/i,
    alt: {
      category: "Dressings",
      brand: "Mateo's",
      name: "Gourmet Medium Salsa",
      sourceUrl: "https://mateossalsa.com/products/medium-gourmet-salsa",
      verifiedAt: "2026-11-09",
      size: "16 oz jar",
      image: "/swaps/salsa.png",
      ingredients: "Tomatoes, water, jalapeno peppers, dehydrated garlic, salt, cilantro, red wine vinegar, spices, lemon juice.",
      itemIds: { walmart: "37552509" },
    },
  },

  // --- Deli Meat, Bacon, Hot Dogs, Sausage, Nuggets, Meat ---
  {
    match: /\b(bacon)\b/i,
    alt: {
      category: "Deli Meat",
      brand: "Applegate Organics",
      name: "Organic No Sugar Uncured Sunday Bacon",
      sourceUrl: "https://applegate.com/products/organic-no-sugar-bacon",
      verifiedAt: "2026-11-09",
      size: "8 oz pack",
      isOrganic: true,
      image: "https://images.openfoodfacts.org/images/products/002/531/733/1005/front_en.3.400.jpg",
      ingredients: "Organic pork, water, sea salt, organic rosemary extract.",
      itemIds: { walmart: "22210691" },
    },
  },
  {
    match: /\b(hot\s*dogs?|franks?|frankfurters?|wieners?|oscar\s+mayer\s+wieners?|ball\s+park|hebrew\s+national|nathan'?s)\b/i,
    alt: {
      category: "Deli Meat",
      brand: "Applegate Organics",
      name: "Organic Uncured Grass-Fed Beef Hot Dog",
      sourceUrl: "https://applegate.com/products/the-great-organic-uncured-beef-hot-dog",
      verifiedAt: "2026-11-09",
      size: "10 oz pack",
      isOrganic: true,
      image: "https://images.openfoodfacts.org/images/products/002/531/753/2006/front_en.3.400.jpg",
      ingredients: "Organic grass-fed beef, water, sea salt, organic spices, organic garlic powder, organic onion powder, organic paprika, lactic acid starter culture.",
      itemIds: { walmart: "15610515" },
    },
  },
  {
    match: /\b(sausages?|kielbasa|bratwurst|chorizo|jimmy\s+dean|hillshire\s+farm|johnsonville|eckrich)\b/i,
    alt: {
      category: "Deli Meat",
      brand: "Applegate Organics",
      name: "Organic Chicken & Maple Breakfast Sausage",
      sourceUrl: "https://applegate.com/products/organic-chicken-and-maple-breakfast-sausage",
      verifiedAt: "2026-11-09",
      size: "7 oz pack",
      isOrganic: true,
      image: "/swaps/sausage.png",
      ingredients: "Organic chicken, water, organic maple syrup, sea salt, organic spices.",
      itemIds: { walmart: "967953484" },
    },
  },
  {
    match: /\b(nuggets?|tenders?|chicken\s+patties|chicken\s+strips|popcorn\s+chicken|tyson)\b/i,
    alt: {
      category: "Deli Meat",
      brand: "Applegate Organics",
      name: "Organic Gluten-Free Chicken Nuggets",
      sourceUrl: "https://applegate.com/products/organic-gluten-free-chicken-nuggets",
      verifiedAt: "2026-11-09",
      size: "8 oz box",
      isOrganic: true,
      image: "https://images.openfoodfacts.org/images/products/002/531/760/5519/front_en.6.400.jpg",
      ingredients: "Organic chicken breast, water, organic rice flour, organic yellow corn flour, sea salt, organic expeller-pressed coconut oil, organic onion powder, organic garlic powder.",
      itemIds: { walmart: "21296165" },
    },
  },
  {
    match: /\b(ham|spam)\b/i,
    alt: {
      category: "Deli Meat",
      brand: "Applegate Organics",
      name: "Organic Uncured Black Forest Ham",
      sourceUrl: "https://applegate.com/products/organic-uncured-black-forest-ham",
      verifiedAt: "2026-11-09",
      size: "6 oz pack",
      isOrganic: true,
      image: "https://images.openfoodfacts.org/images/products/002/531/767/0012/front_en.23.400.jpg",
      ingredients: "Organic pork, water, organic honey, sea salt, organic rosemary extract.",
      itemIds: { walmart: "15610517" },
    },
  },
  {
    match: /\b(salami|pepperoni|bologna)\b/i,
    alt: {
      category: "Deli Meat",
      brand: "Applegate Organics",
      name: "Organic Uncured Genoa Salami",
      sourceUrl: "https://applegate.com/products/organic-uncured-genoa-salami",
      verifiedAt: "2026-11-09",
      size: "4 oz pack",
      isOrganic: true,
      image: "https://images.openfoodfacts.org/images/products/002/531/765/6009/front_en.25.400.jpg",
      ingredients: "Organic pork, sea salt, organic cane sugar, organic spices, organic garlic, lactic acid starter culture, organic rosemary extract.",
      itemIds: { walmart: "22210693" },
    },
  },
  {
    match: /\b((?:beyond|impossible|morningstar|boca|gardenburger)\b.*\b(?:burger|patt(?:y|ies)|beef|meat)|(?:plant[- ]?based|vegan|veggie|black\s+bean)\s+(?:burger|patt(?:y|ies)|ground))\b/i,
    alt: {
      category: "Snacks",
      brand: "Dr. Praeger's",
      name: "California Veggie Burgers",
      sourceUrl: "https://drpraegers.com/our-food/california-veggie-burgers/",
      verifiedAt: "2026-11-10",
      size: "10 oz box (4 patties)",
      image: "/swaps/produce.png",
      ingredients: "Carrots, onions, string beans, oat bran, soybeans, zucchini, peas, broccoli, corn, spinach, expeller pressed avocado oil, sea salt, garlic, black pepper.",
      nutrition: { caloriesKcal100g: 155, sugarsG100g: 2.8, saturatedFatG100g: 0.7, sodiumMg100g: 352, fiberG100g: 5.6, proteinG100g: 7.0, fruitsVegNutsPct: 75 },
    },
  },
  {
    match: /^(?!.*\b(sauce|fries|soup|gravy|seasoning|jerky|stick|broth|stock|beyond|impossible|plant[- ]?based|vegan|veggie|black\s+bean|morningstar|boca|gardenburger)\b).*\b(ground\s+beef|ground\s+chuck|beef\s+patties|burger\s+patties|\d{2}%\s*lean\s*\/?\s*\d{1,2}%\s*fat\s*(?:ground\s+)?beef)\b/i,
    alt: {
      category: "Deli Meat",
      brand: "Marketside Butcher",
      name: "Organic Grass-Fed 93% Lean 7% Fat Ground Beef",
      searchQuery: "Organic Grass Fed Ground Beef",
      sourceUrl: "https://www.walmart.com/ip/Marketside-Butcher-Organic-Grass-Fed-93-Lean-7-Fat-Ground-Beef-1-lb/51259058",
      verifiedAt: "2026-11-09",
      size: "1 lb brick",
      isOrganic: true,
      image: "https://images.openfoodfacts.org/images/products/068/113/137/7416/front_en.3.400.jpg",
      ingredients: "100% Organic Grass-Fed Beef.",
    },
  },
  {
    match: /^(?!.*\b(sauce|fries|soup|gravy|seasoning)\b).*\b(roast\s+beef|deli\s+beef|sliced\s+beef|corned\s+beef|pastrami)\b/i,
    alt: {
      category: "Deli Meat",
      brand: "Applegate Organics",
      name: "Organic Uncured Roast Beef",
      searchQuery: "Organic Roast Beef",
      sourceUrl: "https://applegate.com/products/organic-uncured-roast-beef",
      verifiedAt: "2026-11-09",
      size: "6 oz pack",
      isOrganic: true,
      image: "https://images.openfoodfacts.org/images/products/002/531/715/6745/front_en.12.400.jpg",
      ingredients: "Organic grass-fed beef, water, sea salt, organic black pepper, organic garlic powder.",
      itemIds: { walmart: "15610518" },
    },
  },
  {
    match: /^(?!.*\b(sauce|fries|soup|gravy|seasoning|jerky|broth|stock|plant[- ]?based|vegan)\b).*\b(steak|sirloin|ribeye|strip\s+steak|flank|brisket|chuck\s+roast|beef\s+roast|tenderloin)\b/i,
    alt: {
      category: "Deli Meat",
      brand: "Verde Farms",
      name: "Organic 100% Grass-Fed Beef Ribeye Steak",
      searchQuery: "Organic Grass Fed Steak",
      sourceUrl: "https://verdefarms.com/product/organic-grass-fed-ribeye-steak/",
      verifiedAt: "2026-11-10",
      size: "10 oz steak",
      isOrganic: true,
      image: "",
      ingredients: "100% organic grass-fed beef.",
      nutrition: { caloriesKcal100g: 191, sugarsG100g: 0, saturatedFatG100g: 4.5, sodiumMg100g: 58, fiberG100g: 0, proteinG100g: 21.5, isOrganic: true, isWholeFood: true },
    },
  },
  {
    match: /^(?!.*\b(sauce|soup|chowder|cat\s+food|pet\s+food)\b).*\b(salmon|tuna|cod|tilapia|halibut|haddock|fish\s+sticks?|fish\s+fillets?|battered\s+fish|breaded\s+(?:fish|shrimp)|popcorn\s+shrimp|fried\s+shrimp|crab\s+cakes?|gorton'?s|van\s+de\s+kamp'?s|mrs\.?\s*paul'?s|starkist|bumble\s+bee)\b/i,
    alt: {
      category: "Deli Meat",
      brand: "Wild Planet",
      name: "Wild Pink Salmon",
      searchQuery: "Wild Caught Salmon",
      sourceUrl: "https://wildplanetfoods.com/products/wild-pink-salmon",
      verifiedAt: "2026-11-10",
      size: "6 oz can",
      image: "/swaps/fish.png",
      ingredients: "Wild pink salmon (Oncorhynchus gorbuscha), sea salt.",
      nutrition: { caloriesKcal100g: 129, sugarsG100g: 0, saturatedFatG100g: 0.6, sodiumMg100g: 294, fiberG100g: 0, proteinG100g: 21.2, isWholeFood: true },
    },
  },

  // --- Bread, Bagels, Tortillas, Buns, Waffles, Pasta, Mac & Cheese, Pizza ---
  {
    match: /\b(mac\s*(&|and)\s*cheese|macaroni\s*(&|and)\s*cheese|kraft\s+mac|velveeta\s+shells|shells?\s*(?:&|and)\s*(?:real\s+aged\s+|white\s+)?cheddar)\b/i,
    alt: {
      category: "Bread",
      brand: "Annie's Homegrown",
      name: "Organic Grass-Fed Shells & Real Aged Cheddar",
      size: "6 oz box",
      isOrganic: true,
      image: "/swaps/mac.png",
      ingredients: "Organic wheat pasta (organic wheat flour), organic grass-fed cheddar cheese (cultured pasteurized organic milk, salt, non-animal enzymes), organic whey, organic nonfat milk, organic butter (organic cream, salt), salt, cultured whole milk, sodium phosphate, organic annatto extract (for color).",
      nutrition: { caloriesKcal100g: 386, sugarsG100g: 7.1, saturatedFatG100g: 3.6, sodiumMg100g: 757, fiberG100g: 2.9, proteinG100g: 14.3, fruitsVegNutsPct: 0, isOrganic: true, isWholeFood: false },
      sourceUrl: "https://www.annies.com/product/organic-grass-fed-shells-real-aged-cheddar-mac-cheese",
      verifiedAt: "2026-11-09",
      itemIds: { walmart: "197468167" },
    },
  },
  {
    match: /\balmond\s+flour\s+tortillas?\b/i,
    alt: {
      category: "Bread",
      brand: "Siete",
      name: "Almond Flour Grain Free Tortillas",
      sourceUrl: "https://sietefoods.com/products/almond-flour-tortillas",
      verifiedAt: "2026-11-09",
      size: "7 oz pack (8 tortillas)",
      image: "/swaps/tortillas.png",
      ingredients: "Almond flour, tapioca flour, water, cassava flour, coconut oil, sea salt.",
      itemIds: { walmart: "506938184" },
    },
  },
  {
    match: /\b(tortillas?|wraps?|mission\s+flour|mission\s+carb|guerrero)\b/i,
    alt: {
      category: "Bread",
      brand: "Mi Rancho",
      name: "Organic Corn Tortillas",
      sourceUrl: "https://mirancho.com/products/organic-corn-tortillas/",
      verifiedAt: "2026-11-10",
      size: "10.9 oz pack (12 tortillas)",
      isOrganic: true,
      image: "/swaps/tortillas.png",
      ingredients: "Water, organic white corn, organic yellow corn, trace of lime.",
    },
  },
  {
    match: /\b(bagels?|thomas'?\s+bagels?)\b/i,
    alt: {
      category: "Bread",
      brand: "Dave's Killer Bread",
      name: "Organic Plain Awesome Bagels",
      sourceUrl: "https://www.daveskillerbread.com/plain-awesome-bagels",
      verifiedAt: "2026-11-09",
      size: "16.75 oz pack",
      isOrganic: true,
      image: "/swaps/bagels.png",
      ingredients: "Organic wheat flour, water, organic whole wheat flour, organic cane sugar, organic cracked wheat, organic quinoa, organic amaranth, yeast, sea salt.",
      itemIds: { walmart: "109128726" },
    },
  },
  {
    match: /^(?!.*\b(cinnamon\s+rolls?|honey\s+buns?|cake\s+rolls?|pumpkin\s+cake\s+rolls?|swiss\s+rolls?)\b).*\b(buns?|rolls?|king'?s\s+hawaiian|hamburger\s+buns?|hot\s+dog\s+buns?)\b/i,
    alt: {
      category: "Bread",
      brand: "Dave's Killer Bread",
      name: "Organic 21 Whole Grains & Seeds Burger Buns",
      sourceUrl: "https://www.daveskillerbread.com/21-whole-grains-and-seeds-buns",
      verifiedAt: "2026-11-09",
      size: "16 oz pack (8 buns)",
      isOrganic: true,
      image: "/swaps/buns.png",
      ingredients: "Organic whole wheat, water, organic wheat flour, organic cane sugar, organic flax seeds, organic sunflower seeds, organic sesame seeds, yeast, sea salt.",
      itemIds: { walmart: "975361545" },
    },
  },
  {
    match: /\b(waffles?|pancakes?|eggo|krusteaz|bisquick)\b/i,
    alt: {
      category: "Bread",
      brand: "Nature's Path",
      name: "Organic Buckwheat Wildberry Waffles",
      sourceUrl: "https://www.naturespath.com/en-us/products/natures-path-foods/buckwheat-wildberry-waffles/",
      verifiedAt: "2026-11-09",
      size: "7.4 oz box",
      isOrganic: true,
      image: "/swaps/waffles.png",
      ingredients: "Water, organic whole grain wheat flour, organic buckwheat flour, organic wild blueberries, organic coconut oil, organic cane sugar, baking powder, sea salt.",
      itemIds: { walmart: "10898751" },
    },
  },
  {
    match: /\b(pasta|spaghetti|penne|fettuccine|linguine|macaroni|rigatoni|rotini|noodles|ramen|barilla|maruchan|nissin)\b/i,
    alt: {
      category: "Bread",
      brand: "Barilla",
      name: "Organic Spaghetti Pasta",
      sourceUrl: "https://www.barilla.com/en-us/products/pasta/organic/organic-spaghetti",
      verifiedAt: "2026-11-09",
      size: "16 oz box",
      isOrganic: true,
      image: "/swaps/pasta.png",
      ingredients: "Organic durum wheat semolina, water.",
    },
  },
  {
    match: /\b(pizza|digiorno|red\s+baron|totino'?s|hot\s+pockets?|tombstone)\b/i,
    alt: {
      category: "Bread",
      brand: "Amy's Kitchen",
      name: "Organic Margherita Pizza",
      sourceUrl: "https://www.amys.com/our-foods/margherita-pizza",
      verifiedAt: "2026-11-09",
      size: "13 oz pizza",
      isOrganic: true,
      image: "/swaps/pizza.png",
      ingredients: "Organic wheat flour, filtered water, organic part-skim mozzarella cheese, organic diced tomatoes, organic extra virgin olive oil, organic basil, sea salt, yeast.",
      itemIds: { walmart: "10308475" },
    },
  },

  // --- Snacks, Cookies, Candy, Chocolate, Soda, Sports Drinks, Juice ---
  {
    match: /\b(almond.*cookies?|nutter\s+butter|peanut\s+butter\s+cookies?|pecan\s+sandies|macadamia.*cookies?)\b/i,
    alt: {
      category: "Snacks",
      brand: "Simple Mills",
      name: "Crunchy Almond Flour Chocolate Chip Cookies",
      size: "5.5 oz box",
      image: "/swaps/cookies.png",
      ingredients: "Nut and seed flour blend (almonds, organic coconut, flaxseeds), tapioca starch, chocolate chips (cane sugar, unsweetened chocolate, cocoa butter), organic coconut sugar, organic coconut oil, arrowroot, vanilla extract, sea salt, baking soda, cream of tartar, rosemary extract.",
      sourceUrl: "https://simplemills.com/Products/Product/Crunchy-Chocolate-Chip-Cookies.aspx",
      verifiedAt: "2026-11-09",
      itemIds: { walmart: "189635069" },
    },
  },
  {
    match: /^(?!.*\b(cereal|puffs?|o'?s)\b).*\b(cookies?|oreos?|chips\s+ahoy|keebler|wafers?|knoppers|biscuits?|biscoff|cake\s+rolls?|swiss\s+rolls?|snack\s+cakes?|little\s+debbie|hostess|twinkies?|cupcakes?|donuts?|doughnuts?|bismarks?|fritters?|eclairs?|strudels?|turnovers?|muffins?|pastries|pastry|toaster\s+pastr(?:y|ies)|pop[- ]?tarts?|danish|cinnamon\s+rolls?|honey\s+buns?)\b/i,
    alt: {
      category: "Snacks",
      brand: "Simple Mills",
      name: "Honey Cinnamon Seed Flour Sweet Thins",
      size: "4.25 oz box",
      image: "/swaps/cookies.png",
      ingredients: "Seed flour blend (sunflower seeds, pumpkin seeds, flax seeds), tapioca starch, arrowroot, organic coconut oil, organic coconut sugar, organic honey, organic cinnamon, vanilla extract, sea salt, baking soda, rosemary extract.",
      sourceUrl: "https://www.simplemills.com/Shop/Product/Honey-Cinnamon-Seed-Flour-Sweet-Thins.aspx",
      verifiedAt: "2026-11-10",
    },
  },
  {
    match: /\b(larabar|lärabar|rxbar|kind\s+bar|nut\s+bar|cashew\s+bar|almond\s+bar|trail\s+mix\s+bar)\b/i,
    alt: {
      category: "Snacks",
      brand: "LÄRABAR",
      name: "Cashew Cookie Fruit & Nut Bar",
      sourceUrl: "https://www.larabar.com/products/cashew-cookie",
      verifiedAt: "2026-11-10",
      size: "1.7 oz bar",
      image: "/swaps/fruitbar.png",
      ingredients: "Cashews, dates.",
      itemIds: { walmart: "10311610" },
    },
  },
  {
    match: /\b(gummies|gummy|fruit\s+snacks?|fruit\s+roll|gushers?|welch'?s\s+fruit|haribo|skittles|starburst|sour\s+patch|swedish\s+fish|nerds|twizzlers|candy)\b/i,
    alt: {
      category: "Snacks",
      brand: "That's It.",
      name: "100% Real Fruit Bars (Apple + Strawberry)",
      sourceUrl: "https://www.thatsitfruit.com/products/apple-strawberry",
      verifiedAt: "2026-11-09",
      size: "5 count box",
      image: "/swaps/fruitbar.png",
      ingredients: "Apples, strawberries.",
      itemIds: { walmart: "470907558" },
    },
  },
  {
    match: /\b(chocolate|hershey'?s|reese'?s|snickers|twix|m&m'?s|kit\s*kat|lindt|ghirardelli|kinder|merci|ferrero|brownies?)\b/i,
    alt: {
      category: "Snacks",
      brand: "Hu",
      name: "Simple Organic 70% Dark Chocolate Bar",
      sourceUrl: "https://hukitchen.com/products/simple-dark-chocolate",
      verifiedAt: "2026-11-09",
      size: "2.1 oz bar",
      isOrganic: true,
      image: "/swaps/chocolate.png",
      ingredients: "Organic fair-trade cacao, unrefined organic coconut sugar, organic fair-trade cocoa butter.",
      itemIds: { walmart: "521984316" },
    },
  },
  {
    match: /\b(pre[- ]?workout|preworkout|c4\s+(?:original|ultimate|ripped|sport|dynasty)|cellucor|ghost\s+legend|gorilla\s+mode|ryse\s+loaded|bucked\s+up|woke\s+af|total\s+war|redcon1|nitraflex)\b/i,
    alt: {
      category: "Snacks",
      brand: "Ora Organic",
      name: "Renewable Energy Clean Pre-Workout",
      sourceUrl: "https://www.ora.organic/products/organic-pre-workout-powder",
      verifiedAt: "2026-11-09",
      size: "9.5 oz tub (20 servings)",
      isOrganic: true,
      image: "/swaps/drink.png",
      ingredients: "Organic beet root, organic coconut water, organic green coffee bean, organic yerba mate, organic matcha green tea, organic maca root, organic panax ginseng.",
    },
  },
  {
    match: /\b(core\s+power|premier\s+protein|muscle\s+milk|fairlife\s+(?:elite|nutrition\s+plan|protein)|whey\s+protein|gold\s+standard\s+whey|ghost\s+whey|protein\s+shake|protein\s+powder)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Orgain",
      name: "Organic Grass-Fed Clean Protein Shake",
      size: "4 pack (11 fl oz cartons)",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Filtered Water, Orgain Organic Grass-Fed Milk Protein Concentrate, Organic Erythritol, Organic Fair Trade Alkalized Cocoa, Organic Acacia, Sea Salt, Organic Monk Fruit Extract, Organic Stevia.",
      nutrition: { caloriesKcal100g: 42, sugarsG100g: 0.6, saturatedFatG100g: 0.3, sodiumMg100g: 55, fiberG100g: 0.9, proteinG100g: 6.5, fruitsVegNutsPct: 0, isOrganic: true, isWholeFood: false },
      sourceUrl: "https://orgain.com/products/organic-grass-fed-clean-protein-shake",
      verifiedAt: "2026-11-09",
      itemIds: { walmart: "194225410" },
    },
  },
  {
    match: /\b(monster|red\s*bull|celsius|alani(?:\s+nu)?|ghost\s+energy|c4\s+(?:performance\s+|smart\s+)?energy|frozen\s+bombsicle|bang\s+energy|reign|rockstar|prime\s+energy|5[- ]?hour\s+energy|zoa|nos\s+energy|full\s+throttle|energy\s+drink)\b/i,
    alt: {
      category: "Snacks",
      brand: "Guayakí",
      name: "Organic Yerba Mate Unsweetened Traditional Tereré",
      size: "15.5 fl oz can",
      isOrganic: true,
      image: "/swaps/drink.png",
      ingredients: "Purified water, organic brewed yerba mate (purified water, organic yerba mate), organic ascorbic acid.",
      nutrition: { caloriesKcal100g: 1.1, sugarsG100g: 0, saturatedFatG100g: 0, sodiumMg100g: 2.2, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 80, isOrganic: true, isWholeFood: false },
      sourceUrl: "https://guayaki.com/products/unsweetened-traditional-terere",
      verifiedAt: "2026-11-09",
      itemIds: { walmart: "183157294" },
    },
  },
  {
    match: /\b(sprite|7\s*up|starry|squirt|fresca|sunkist|fanta|crush|mountain\s+dew|mtn\s+dew|baja\s+blast|lemon[- ]?lime\s+soda|orange\s+soda)\b/i,
    alt: {
      category: "Snacks",
      brand: "Spindrift",
      name: "Raspberry Lime Sparkling Water",
      size: "8 pack (12 fl oz cans)",
      image: "/swaps/drink.png",
      ingredients: "Carbonated water, raspberry puree, lime juice.",
      nutrition: { caloriesKcal100g: 5 / 3.55, sugarsG100g: 1 / 3.55, saturatedFatG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 3, isOrganic: false },
      sourceUrl: "https://drinkspindrift.com/products/raspberry-lime-sparkling-water",
      verifiedAt: "2026-11-09",
      itemIds: { walmart: "895065260" },
    },
  },
  {
    match: /\b(soda|cola|coca[- ]?cola|coke|pepsi|dr\.?\s*pepper|root\s+beer|a\s*&\s*w|barq'?s|mug\s+root\s+beer|ginger\s+ale|canada\s+dry|schweppes|seagram'?s|jarritos|cream\s+soda)\b/i,
    alt: {
      category: "Snacks",
      brand: "OLIPOP",
      name: "Vintage Cola Prebiotic Soda",
      sourceUrl: "https://drinkolipop.com/products/vintage-cola",
      verifiedAt: "2026-11-09",
      size: "12 fl oz can",
      image: "/swaps/drink.png",
      ingredients: "Carbonated water, cassava root fiber, chicory root inulin, organic apple juice concentrate, lime juice, cinnamon, vanilla bean.",
      itemIds: { walmart: "848292458" },
    },
  },
  {
    match: /\b(gatorade|gatorlyte|powerade|body\s*armor|prime\s+hydration|\bprime\b|liquid\s+i\.?v\.?|pedialyte|electrolit|biolyte|nuun|propel|vitamin\s*water|sports?\s+drink|electrolyte)\b/i,
    alt: {
      category: "Snacks",
      brand: "Harmless Harvest",
      name: "Organic Coconut Water",
      sourceUrl: "https://harmlessharvest.com/products/organic-coconut-water",
      verifiedAt: "2026-11-09",
      size: "16 fl oz bottle",
      isOrganic: true,
      image: "/swaps/drink.png",
      ingredients: "100% organic coconut water.",
      itemIds: { walmart: "46330157" },
    },
  },
  {
    match: /\b(frappuccino|doubleshot|tripleshot|dunkin'?\s+iced\s+coffee|international\s+delight\s+iced\s+coffee|iced\s+coffee|draft\s+latte)\b/i,
    alt: {
      category: "Snacks",
      brand: "SToK",
      name: "Unsweetened Black Cold Brew Coffee",
      size: "48 fl oz bottle",
      isOrganic: false,
      image: "/swaps/drink.png",
      ingredients: "Coffee (filtered water, coffee), natural flavor.",
      nutrition: { caloriesKcal100g: 15 / 3.6, sugarsG100g: 0, saturatedFatG100g: 0, sodiumMg100g: 10 / 3.6, fiberG100g: 0, isOrganic: false },
      sourceUrl: "https://www.stokbrew.com/cold-brew/cold-brew-coffee/unsweetened-cold-brew-coffee-48oz/",
      verifiedAt: "2026-11-09",
      itemIds: { walmart: "172959656" },
    },
  },
  {
    match: /\b(arizona|arnold\s+palmer|mucho\s+mango|peace\s+tea|pure\s+leaf|gold\s+peak|snapple|brisk|lipton|milo'?s|sweet\s+tea|iced\s+tea)\b/i,
    alt: {
      category: "Snacks",
      brand: "Ito En",
      name: "Oi Ocha Organic Unsweetened Green Tea",
      sourceUrl: "https://itoen.com/products/oi-ocha-unsweetened-green-tea",
      verifiedAt: "2026-11-09",
      size: "16.9 fl oz bottle",
      isOrganic: true,
      image: "/swaps/drink.png",
      ingredients: "Purified water, organic green tea, organic ascorbic acid.",
      itemIds: { walmart: "21805412" },
    },
  },
  {
    match: /\b(juice|lemonade|limeade|capri\s*sun|kool[- ]?aid|sunny\s*d|minute\s+maid|tropicana|simply\s+orange|simply\s+lemonade|florida'?s\s+natural|mott'?s|martinelli'?s|welch'?s|ocean\s+spray|pom\s+wonderful|hi[- ]?c|hawaiian\s+punch|tampico|tang|fruit\s+punch|pouches|naked\s+juice|mighty\s+mango|green\s+machine|bolthouse|sparkling\s+ice|bai)\b/i,
    alt: {
      category: "Snacks",
      brand: "Spindrift",
      name: "Raspberry Lime Sparkling Water",
      size: "8 pack (12 fl oz cans)",
      image: "/swaps/drink.png",
      ingredients: "Carbonated water, raspberry puree, lime juice.",
      nutrition: { caloriesKcal100g: 5 / 3.55, sugarsG100g: 1 / 3.55, saturatedFatG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 3, isOrganic: false },
      sourceUrl: "https://drinkspindrift.com/products/raspberry-lime-sparkling-water",
      verifiedAt: "2026-11-09",
      itemIds: { walmart: "895065260" },
    },
  },
  // --- USDA Organic High-Residue Produce, Grains & Legumes (for 🌱 Herbicides & Pesticides Watch) ---
  {
    match: /^(?!.*\b(yogurt|ice\s+cream|gelato|sorbet|milk|creamer|cheese|butter|jam|jelly|preserves?|marmalade|syrup|sauce|dressing|cereal|oatmeal|granola|muffin|bagel|waffle|pancake|bread|cookie|cake|pie|pastry|tart|donut|bars?|snacks?|gummies|candy|chocolate|juice|soda|pop|tea|lemonade|drink|beverage|water|seltzer|energy|smoothie|shake|pouch|pouches|frosting|jell-?o|pudding)\b).*\b(strawberries|fresh\s+strawberry)\b/i,
    alt: {
      category: "Snacks",
      brand: "Driscoll's",
      name: "Organic Fresh Strawberries",
      size: "16 oz clamshell",
      isOrganic: true,
      image: "/swaps/produce.png",
      ingredients: "Organic strawberries.",
      nutrition: { caloriesKcal100g: 32, sugarsG100g: 4.9, saturatedFatG100g: 0, sodiumMg100g: 1, fiberG100g: 2.0, proteinG100g: 0.7, fruitsVegNutsPct: 100, isOrganic: true, isWholeFood: true },
      sourceUrl: "https://www.driscolls.com/strawberries/organic-strawberries",
      verifiedAt: "2026-11-11",
    },
  },
  {
    match: /^(?!.*\b(yogurt|ice\s+cream|gelato|sorbet|milk|creamer|cheese|butter|jam|jelly|preserves?|syrup|sauce|cereal|oatmeal|granola|muffin|bagel|waffle|pancake|bread|cookie|cake|pie|pastry|tart|donut|bars?|snacks?|gummies|candy|chocolate|juice|soda|pop|tea|lemonade|drink|beverage|water|seltzer|energy|smoothie|pouch|pouches)\b).*\b(blueberries|fresh\s+blueberry)\b/i,
    alt: {
      category: "Snacks",
      brand: "Driscoll's",
      name: "Organic Fresh Blueberries",
      size: "6 oz clamshell",
      isOrganic: true,
      image: "/swaps/produce.png",
      ingredients: "Organic blueberries.",
      nutrition: { caloriesKcal100g: 57, sugarsG100g: 10.0, saturatedFatG100g: 0, sodiumMg100g: 1, fiberG100g: 2.4, proteinG100g: 0.7, fruitsVegNutsPct: 100, isOrganic: true, isWholeFood: true },
      sourceUrl: "https://www.driscolls.com/blueberries/organic-blueberries",
      verifiedAt: "2026-11-11",
    },
  },
  {
    match: /^(?!.*\b(dip|pizza|ravioli|pasta|tortellini|lasagna|quiche|wrap|tortilla|chips?|crackers?|soup|broth|artichoke|fet[ta]|pie|pastry|nuggets?|bites|smoothie|juice|powder)\b).*\b(spinach|kale|collard\s+greens?|mustard\s+greens?)\b/i,
    alt: {
      category: "Snacks",
      brand: "Earthbound Farm",
      name: "Organic Baby Spinach",
      size: "5 oz clamshell",
      isOrganic: true,
      image: "/swaps/produce.png",
      ingredients: "Organic baby spinach.",
      nutrition: { caloriesKcal100g: 23, sugarsG100g: 0.4, saturatedFatG100g: 0, sodiumMg100g: 79, fiberG100g: 2.2, proteinG100g: 2.9, fruitsVegNutsPct: 100, isOrganic: true, isWholeFood: true },
      sourceUrl: "https://www.earthboundfarm.com/products/organic-baby-spinach/",
      verifiedAt: "2026-11-11",
    },
  },
  {
    match: /^(?!.*\b(yogurt|milk|butter|jam|jelly|syrup|cider|vinegar|juice|soda|tea|drink|beverage|water|seltzer|energy|cereal|oatmeal|granola|muffin|waffle|bread|cookie|cake|pie|pastry|tart|donut|bars?|snacks?|chips?|crisps?|gummies|candy|caramel|sausage|bacon|ham|pouch|pouches)\b).*\b(apples|honeycrisp|gala\s+apples?|fuji\s+apples?|granny\s+smith|pink\s+lady\s+apples?)\b/i,
    alt: {
      category: "Snacks",
      brand: "Stemilt",
      name: "Organic Honeycrisp Apples",
      size: "2 lb pouch",
      isOrganic: true,
      image: "/swaps/produce.png",
      ingredients: "Organic Honeycrisp apples.",
      nutrition: { caloriesKcal100g: 52, sugarsG100g: 10.4, saturatedFatG100g: 0, sodiumMg100g: 1, fiberG100g: 2.4, proteinG100g: 0.3, fruitsVegNutsPct: 100, isOrganic: true, isWholeFood: true },
      sourceUrl: "https://www.stemilt.com/fruits/apples/artisan-organics/",
      verifiedAt: "2026-11-11",
    },
  },
  {
    match: /^(?!.*\b(jam|jelly|preserves?|juice|soda|pop|drink|beverage|water|seltzer|energy|candy|gummies|snacks?|bars?|cereal|bran|bread|bagel|cookie|oatmeal|chocolate|seed\s+oil|grapeseed)\b).*\b(grapes|seedless\s+grapes?|red\s+grapes?|green\s+grapes?|black\s+grapes?)\b/i,
    alt: {
      category: "Snacks",
      brand: "Sunview",
      name: "Organic Red Seedless Grapes",
      size: "2 lb bag",
      isOrganic: true,
      image: "/swaps/produce.png",
      ingredients: "Organic red seedless grapes.",
      nutrition: { caloriesKcal100g: 69, sugarsG100g: 15.5, saturatedFatG100g: 0, sodiumMg100g: 2, fiberG100g: 0.9, proteinG100g: 0.7, fruitsVegNutsPct: 100, isOrganic: true, isWholeFood: true },
      sourceUrl: "https://www.sunviewmarketing.com/organic-grapes",
      verifiedAt: "2026-11-11",
    },
  },
  {
    match: /^(?!.*\b(yogurt|ice\s+cream|jam|jelly|preserves?|syrup|juice|soda|tea|drink|beverage|water|seltzer|energy|candy|rings|gummies|cereal|oatmeal|pie|cobbler|tart|bars?|snacks?|pouch|pouches)\b).*\b(peaches|sliced\s+peaches|yellow\s+peaches|white\s+peaches|pears|bartlett\s+pears?|anjou\s+pears?|nectarines|cherries|sweet\s+cherries)\b/i,
    alt: {
      category: "Snacks",
      brand: "Cascadian Farm",
      name: "Organic Sliced Peaches",
      size: "10 oz bag",
      isOrganic: true,
      image: "/swaps/produce.png",
      ingredients: "Organic peaches.",
      nutrition: { caloriesKcal100g: 39, sugarsG100g: 8.4, saturatedFatG100g: 0, sodiumMg100g: 0, fiberG100g: 1.5, proteinG100g: 0.9, fruitsVegNutsPct: 100, isOrganic: true, isWholeFood: true },
      sourceUrl: "https://www.cascadianfarm.com/products/frozen-fruits/",
      verifiedAt: "2026-11-11",
    },
  },
  {
    match: /^(?!.*\b(soup|broth|sauce|paste|salsa|ketchup|juice|chips?|crackers?|dip|salad|dressing|cheese|pizza|pasta|sausage|turkey|bacon|ham|deli|salt|powder|seed|bites|crisps?)\b).*\b(bell\s+peppers?|sweet\s+peppers?|celery|green\s+beans?|string\s+beans?|fresh\s+tomatoes|roma\s+tomatoes|cherry\s+tomatoes|grape\s+tomatoes)\b/i,
    alt: {
      category: "Snacks",
      brand: "Earthbound Farm",
      name: "Organic Celery Hearts",
      size: "16 oz bag",
      isOrganic: true,
      image: "/swaps/produce.png",
      ingredients: "Organic celery.",
      nutrition: { caloriesKcal100g: 14, sugarsG100g: 1.3, saturatedFatG100g: 0, sodiumMg100g: 80, fiberG100g: 1.6, proteinG100g: 0.7, fruitsVegNutsPct: 100, isOrganic: true, isWholeFood: true },
      sourceUrl: "https://www.earthboundfarm.com/products/organic-celery-hearts/",
      verifiedAt: "2026-11-11",
    },
  },
  {
    match: /^(?!.*\b(chips?|crisps?|fries|tots|hash\s*browns?|mashed|salad|soup|au\s+gratin|scalloped|bread|rolls?|buns?|starch|flakes?|gnocchi|knish|pierog\w*|skins?|wedges)\b).*\b(russet\s+potatoes?|yukon\s+gold\s+potatoes?|red\s+potatoes?|yellow\s+potatoes?|baby\s+potatoes?|idaho\s+potatoes?|fresh\s+potatoes|potatoes)\b/i,
    alt: {
      category: "Snacks",
      brand: "Cal-Organic Farms",
      name: "Organic Russet Potatoes",
      size: "5 lb bag",
      isOrganic: true,
      image: "/swaps/produce.png",
      ingredients: "Organic russet potatoes.",
      nutrition: { caloriesKcal100g: 77, sugarsG100g: 0.8, saturatedFatG100g: 0, sodiumMg100g: 6, fiberG100g: 2.2, proteinG100g: 2.0, fruitsVegNutsPct: 100, isOrganic: true, isWholeFood: true },
      sourceUrl: "https://www.calorganicfarms.com/products/potatoes/",
      verifiedAt: "2026-11-11",
    },
  },
  {
    match: /^(?!.*\b(tortillas?|wraps?|bread|buns?|rolls?|bagels?|pasta|noodles?|crackers?|cookies?|pretzels?|pancake|waffle|muffin|cake|brownie|biscuit|crust)\b).*\b(all[- ]?purpose\s+flour|wheat\s+flour|bleached\s+flour|unbleached\s+flour|bread\s+flour)\b/i,
    alt: {
      category: "Bread",
      brand: "King Arthur Baking Company",
      name: "Organic Unbleached All-Purpose Flour",
      size: "5 lb bag",
      isOrganic: true,
      image: "/swaps/bread.jpg",
      ingredients: "Organic unbleached hard red wheat flour, organic malted barley flour.",
      nutrition: { caloriesKcal100g: 366, sugarsG100g: 0, saturatedFatG100g: 0, sodiumMg100g: 0, fiberG100g: 3.3, proteinG100g: 13.3, fruitsVegNutsPct: 0, isOrganic: true, isWholeFood: true },
      sourceUrl: "https://shop.kingarthurbaking.com/items/organic-all-purpose-flour",
      verifiedAt: "2026-11-11",
    },
  },
  {
    match: /^(?!.*\b(pasta|rotini|penne|spaghetti|macaroni|chips?|puffs?|crisps?|crackers?|soup|chili|burrito|dip|salad|flour)\b).*\b(chickpeas?|garbanzo\s+beans?|lentils?|pinto\s+beans?|black\s+beans?|navy\s+beans?|kidney\s+beans?)\b/i,
    alt: {
      category: "Snacks",
      brand: "Eden Organic",
      name: "Organic Garbanzo Beans No Salt Added",
      size: "15 oz can",
      isOrganic: true,
      image: "/swaps/produce.png",
      ingredients: "Organic garbanzo beans, water.",
      nutrition: { caloriesKcal100g: 115, sugarsG100g: 0.8, saturatedFatG100g: 0.4, sodiumMg100g: 12, fiberG100g: 5.4, proteinG100g: 6.9, fruitsVegNutsPct: 90, isOrganic: true, isWholeFood: true },
      sourceUrl: "https://store.edenfoods.com/garbanzo-beans-chick-peas-organic-15-oz/",
      verifiedAt: "2026-11-11",
    },
  },
];

/**
 * Store-specific clean swap overrides so every retailer recommends products
 * guaranteed to be carried in that store's inventory (e.g., Member's Mark Organic at Sam's Club,
 * Kirkland Signature Organic at Costco, Simply Nature Organic at ALDI, Wellsley Farms Organic at BJ's,
 * Good & Gather Organic at Target, Simple Truth Organic at Kroger, and 365 by Whole Foods Market at Amazon).
 */
const STORE_DAIRY_REDUCED_FAT_MILK_MATCH = new RegExp(
  `^(?!.*\\b(${PLANT_MILK_QUALIFIER_RE}|milk\\s+chocolate|creamer)\\b)(?:.*\\b(?:2%|reduced\\s+fat|1%|low\\s*fat)\\s+milk\\b|.*\\bmilk\\b.*\\b(?:2%|reduced\\s+fat|1%|low\\s*fat)\\b)`,
  "i"
);
const STORE_DAIRY_WHOLE_MILK_MATCH = new RegExp(
  `^(?!.*\\b(chocolate|strawberry|condensed|evaporated|creamer|milk\\s+chocolate|${PLANT_MILK_QUALIFIER_RE})\\b).*\\b(whole\\s+milk|vitamin\\s+d\\s+milk|milk)\\b`,
  "i"
);
const STORE_DAIRY_BUTTER_MATCH = new RegExp(
  `^(?!.*\\b(${DAIRY_BUTTER_EXCLUSIONS_RE})\\b).*\\b(butter|margarine|country\\s+crock|parkay|imperial|blue\\s+bonnet|i\\s+can'?t\\s+believe)\\b`,
  "i"
);
const STORE_DAIRY_YOGURT_MATCH = new RegExp(
  `^(?!.*\\b(${PLANT_OR_DAIRY_FREE_BRAND_OR_TERM_RE})\\b)(?:.*\\b(yogh?urt|skyr|yoplait|dannon)\\b|(?!.*\\b(creamer|coffee|oat\\s*milk|oatmilk|barista)\\b).*\\bchobani\\b)`,
  "i"
);

export const STORE_SPECIFIC_OVERRIDES: Partial<Record<Store, { match: RegExp; alt: CleanAlternative }[]>> = {
  sams: [
    {
      match: STORE_DAIRY_BUTTER_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Member's Mark",
        name: "Organic Creamy Salted Butter",
        sourceUrl: "https://www.samsclub.com/p/members-mark-organic-salted-butter/prod22690830",
        verifiedAt: "2026-11-09",
        size: "2 lb (4 count)",
        isOrganic: true,
        image: "/swaps/butter.jpg",
        ingredients: "Organic pasteurized sweet cream, salt.",
      },
    },
    {
      match: STORE_DAIRY_REDUCED_FAT_MILK_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Member's Mark",
        name: "Organic 2% Reduced Fat Milk",
        sourceUrl: "https://www.samsclub.com/p/members-mark-organic-2-percent-milk/prod21220214",
        verifiedAt: "2026-11-09",
        size: "0.5 gal (3 pack)",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Organic Grade A reduced fat milk, vitamin A palmitate, vitamin D3.",
      },
    },
    {
      match: /^(?!.*\b(creamer|chocolate)\b).*\b(almond\s*(?:milk|beverage)|almondmilk|silk\s+almond|almond\s+breeze|califia.*almond|malk.*almond)\b/i,
      alt: {
        category: "Butter/Dairy",
        brand: "Member's Mark",
        name: "Organic Unsweetened Almond Milk",
        sourceUrl: "https://www.samsclub.com/p/members-mark-organic-unsweetened-almond-milk/prod22400496",
        verifiedAt: "2026-11-09",
        size: "32 fl oz (6 pack)",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Filtered water, organic almonds, sea salt.",
      },
    },
    {
      match: STORE_DAIRY_WHOLE_MILK_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Member's Mark",
        name: "Organic Whole Milk",
        sourceUrl: "https://www.samsclub.com/p/members-mark-organic-whole-milk/prod21220212",
        verifiedAt: "2026-11-09",
        size: "0.5 gal (3 pack)",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Organic Grade A whole milk, vitamin D3.",
      },
    },
    {
      match: /^(?!.*\b(noodles?|rolls?|soup|salad|fried\s+rice|pasta|waffles?|mcmuffin|sandwich|custard|nog|mayo|mayonnaise|cookies?|cake|pastry|pastries)\b).*\b(eggs?|egg\s+whites?|egg\s+beaters)\b/i,
      alt: {
        category: "Butter/Dairy",
        brand: "Member's Mark",
        name: "Organic Pasture-Raised Large Brown Eggs",
        sourceUrl: "https://www.samsclub.com/p/members-mark-organic-pasture-raised-eggs-18ct/prod24960693",
        verifiedAt: "2026-11-09",
        size: "18 count carton",
        isOrganic: true,
        image: "/swaps/eggs.png",
        ingredients: "Organic pasture-raised shell eggs.",
      },
    },
    {
      match: STORE_DAIRY_YOGURT_MATCH,
      alt: {
        category: "Yogurt",
        brand: "Member's Mark",
        name: "Organic Plain Nonfat Greek Yogurt",
        sourceUrl: "https://www.samsclub.com/p/members-mark-organic-plain-nonfat-greek-yogurt-40-oz/prod23120312",
        verifiedAt: "2026-11-09",
        size: "40 oz tub",
        isOrganic: true,
        image: "/swaps/yogurt.jpg",
        ingredients: "Cultured pasteurized organic nonfat milk, live and active cultures.",
      },
    },
    {
      match: /\b(peanut\s+butter|jif|skippy|peter\s+pan)\b/i,
      alt: {
        category: "Snacks",
        brand: "Member's Mark",
        name: "Organic Creamy Peanut Butter",
        sourceUrl: "https://www.samsclub.com/p/members-mark-organic-creamy-peanut-butter/prod21021048",
        verifiedAt: "2026-11-09",
        size: "28 oz (2 pack)",
        isOrganic: true,
        image: "/swaps/peanutbutter.png",
        ingredients: "Organic dry roasted peanuts, sea salt.",
      },
    },
    {
      match: /^(?!.*\b(peaches?|pears?|pineapple|mandarins?|oranges?|cherries|cocktail|fruit\s+cups?|heavy\s+syrup|light\s+syrup|cough)\b).*\b(syrup|mrs\.?\s*butterworth|pearl\s+milling|log\s+cabin|aunt\s+jemima)\b/i,
      alt: {
        category: "Cereal",
        brand: "Member's Mark",
        name: "Organic 100% Pure Grade A Amber Maple Syrup",
        sourceUrl: "https://www.samsclub.com/p/members-mark-organic-100-pure-maple-syrup-32-oz/prod20061634",
        verifiedAt: "2026-11-09",
        size: "32 fl oz jug",
        isOrganic: true,
        image: "/swaps/syrup.png",
        ingredients: "100% pure organic Grade A amber maple syrup.",
      },
    },
    {
      match: /\b(gravy|broth|stock|bouillon)\b/i,
      alt: {
        category: "Dressings",
        brand: "Member's Mark",
        name: "Organic Chicken Bone Broth",
        sourceUrl: "https://www.samsclub.com/p/members-mark-organic-chicken-bone-broth-6-pk/prod24541162",
        verifiedAt: "2026-11-09",
        size: "32 oz (6 pack)",
        isOrganic: true,
        image: "/swaps/broth.png",
        ingredients: "Organic chicken stock, organic vegetable stock (organic carrot, organic celery, organic onion), sea salt, organic rosemary extract.",
      },
    },
  ],
  costco: [
    {
      match: STORE_DAIRY_BUTTER_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Kirkland Signature",
        name: "Organic Grass-Fed Salted Butter",
        sourceUrl: "https://www.costco.com/kirkland-signature-grass-fed-butter%2C-salted%2C-8-oz%2C-4-count.product.100766451.html",
        verifiedAt: "2026-11-09",
        size: "2 lb (4 count)",
        isOrganic: true,
        image: "/swaps/butter.jpg",
        ingredients: "Organic pasteurized cream, salt.",
      },
    },
    {
      match: STORE_DAIRY_REDUCED_FAT_MILK_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Kirkland Signature",
        name: "Organic 2% Reduced Fat Milk",
        sourceUrl: "https://www.costco.com/kirkland-signature-organic-reduced-fat-2-milk%2C-0.5-gallon%2C-3-count.product.100334955.html",
        verifiedAt: "2026-11-09",
        size: "0.5 gal (3 pack)",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Organic Grade A reduced fat milk, vitamin A palmitate, vitamin D3.",
      },
    },
    {
      match: /^(?!.*\b(creamer|chocolate)\b).*\b(oat\s*(?:milk|beverage|drink|barista)|oatmilk|milked\s+oats?|planet\s+oat|oatly|chobani\s+oat|silk\s+oat(?:milk|\s+yeah)?|califia.*\boat\b)\b/i,
      alt: {
        category: "Butter/Dairy",
        brand: "Kirkland Signature",
        name: "Organic Non-Dairy Oat Beverage",
        sourceUrl: "https://www.costco.com/kirkland-signature-organic-non-dairy-oat-beverage%2C-32-fl-oz%2C-6-count.product.100638343.html",
        verifiedAt: "2026-11-09",
        size: "32 fl oz (6 pack)",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Filtered water, organic oats, sea salt.",
      },
    },
    {
      match: /^(?!.*\b(creamer|chocolate)\b).*\b(almond\s*(?:milk|beverage)|almondmilk|silk\s+almond|almond\s+breeze|califia.*almond|malk.*almond)\b/i,
      alt: {
        category: "Butter/Dairy",
        brand: "Kirkland Signature",
        name: "Organic Unsweetened Almond Beverage",
        sourceUrl: "https://www.costco.com/kirkland-signature-organic-unsweetened-almond-non-dairy-beverage%2C-32-fl-oz%2C-6-count.product.100438695.html",
        verifiedAt: "2026-11-10",
        size: "32 fl oz (6 pack)",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Filtered water, organic almonds, sea salt.",
      },
    },
    {
      match: STORE_DAIRY_WHOLE_MILK_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Kirkland Signature",
        name: "Organic Whole Milk",
        sourceUrl: "https://www.costco.com/kirkland-signature-organic-whole-milk%2C-0.5-gallon%2C-3-count.product.100334957.html",
        verifiedAt: "2026-11-09",
        size: "0.5 gal (3 pack)",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Organic Grade A whole milk, vitamin D3.",
      },
    },
    {
      match: /^(?!.*\b(noodles?|rolls?|soup|salad|fried\s+rice|pasta|waffles?|mcmuffin|sandwich|custard|nog|mayo|mayonnaise|cookies?|cake|pastry|pastries)\b).*\b(eggs?|egg\s+whites?|egg\s+beaters)\b/i,
      alt: {
        category: "Butter/Dairy",
        brand: "Kirkland Signature",
        name: "Organic Pasture-Raised Large Brown Eggs",
        sourceUrl: "https://www.costco.com/kirkland-signature-organic-pasture-raised-24-eggs.product.100422405.html",
        verifiedAt: "2026-11-09",
        size: "24 count carton",
        isOrganic: true,
        image: "/swaps/eggs.png",
        ingredients: "Organic pasture-raised shell eggs.",
      },
    },
    {
      match: STORE_DAIRY_YOGURT_MATCH,
      alt: {
        category: "Yogurt",
        brand: "Kirkland Signature",
        name: "Organic Plain Nonfat Greek Yogurt",
        sourceUrl: "https://www.costco.com/kirkland-signature-organic-greek-nonfat-yogurt%2C-plain%2C-48-oz.product.100334952.html",
        verifiedAt: "2026-11-09",
        size: "48 oz tub",
        isOrganic: true,
        image: "/swaps/yogurt.jpg",
        ingredients: "Cultured pasteurized organic nonfat milk, live and active cultures.",
      },
    },
    {
      match: /\b(peanut\s+butter|jif|skippy|peter\s+pan)\b/i,
      alt: {
        category: "Snacks",
        brand: "Kirkland Signature",
        name: "Organic Creamy Peanut Butter",
        sourceUrl: "https://www.costco.com/kirkland-signature-organic-peanut-butter%2C-28-oz%2C-2-count.product.100334334.html",
        verifiedAt: "2026-11-09",
        size: "28 oz (2 pack)",
        isOrganic: true,
        image: "/swaps/peanutbutter.png",
        ingredients: "Organic dry roasted Valencia peanuts, sea salt.",
      },
    },
    {
      match: /\b(almond\s+butter|cashew\s+butter|maranatha|justin'?s\s+almond)\b/i,
      alt: {
        category: "Snacks",
        brand: "Kirkland Signature",
        name: "Organic Creamy Almond Butter (Peanut-Free)",
        sourceUrl: "https://www.costco.com/kirkland-signature-creamy-almond-butter%2C-27-oz.product.100333881.html",
        verifiedAt: "2026-11-09",
        size: "27 oz jar",
        isOrganic: true,
        image: "/swaps/peanutbutter.png",
        ingredients: "Organic roasted almonds.",
      },
    },
    {
      match: /\b(jam|jelly|preserves|marmalade|fruit\s+spread|smucker'?s|welch'?s\s+grape)\b/i,
      alt: {
        category: "Snacks",
        brand: "Kirkland Signature",
        name: "Organic Strawberry Spread",
        sourceUrl: "https://www.costco.com/kirkland-signature-organic-strawberry-spread%2C-42-oz.product.100334857.html",
        verifiedAt: "2026-11-09",
        size: "42 oz jar",
        isOrganic: true,
        image: "/swaps/jam.png",
        ingredients: "Organic strawberries, organic cane sugar, fruit pectin, citric acid.",
      },
    },
    {
      match: /\b(oatmeal|rolled\s+oats|steel\s+cut\s+oats|instant\s+oats|quaker\s+oats)\b/i,
      alt: {
        category: "Cereal",
        brand: "One Degree Organic Foods",
        name: "Organic Sprouted Rolled Oats",
        sourceUrl: "https://onedegreeorganics.com/products/organic-sprouted-rolled-oats/",
        verifiedAt: "2026-11-09",
        size: "80 oz bag",
        isOrganic: true,
        image: "/swaps/oats.png",
        ingredients: "100% organic sprouted whole grain oats.",
      },
    },
    {
      match: /^(?!.*\b(peaches?|pears?|pineapple|mandarins?|oranges?|cherries|cocktail|fruit\s+cups?|heavy\s+syrup|light\s+syrup|cough)\b).*\b(syrup|mrs\.?\s*butterworth|pearl\s+milling|log\s+cabin|aunt\s+jemima)\b/i,
      alt: {
        category: "Cereal",
        brand: "Kirkland Signature",
        name: "Organic 100% Pure Grade A Amber Maple Syrup",
        sourceUrl: "https://www.costco.com/kirkland-signature-organic-pure-maple-syrup%2C-33.8-oz.product.100333884.html",
        verifiedAt: "2026-11-09",
        size: "33.8 fl oz jug",
        isOrganic: true,
        image: "/swaps/syrup.png",
        ingredients: "100% pure organic Grade A amber maple syrup.",
      },
    },
    {
      match: /\b(gravy|broth|stock|bouillon)\b/i,
      alt: {
        category: "Dressings",
        brand: "Kirkland Signature",
        name: "Organic Chicken Bone Broth",
        sourceUrl: "https://www.costco.com/kirkland-signature-organic-chicken-stock%2C-32-fl-oz%2C-6-count.product.100334966.html",
        verifiedAt: "2026-11-09",
        size: "32 fl oz (6 pack)",
        isOrganic: true,
        image: "/swaps/broth.png",
        ingredients: "Organic chicken stock, organic vegetable stock (organic carrot, organic celery, organic onion), sea salt, organic rosemary extract.",
      },
    },
    {
      match: /\b(salsa|picante|pace|herdez)\b/i,
      alt: {
        category: "Dressings",
        brand: "Kirkland Signature",
        name: "Organic Medium Salsa",
        sourceUrl: "https://www.costco.com/kirkland-signature-organic-medium-salsa%2C-38-oz%2C-2-count.product.100334890.html",
        verifiedAt: "2026-11-09",
        size: "38 oz (2 pack)",
        isOrganic: true,
        image: "/swaps/salsa.png",
        ingredients: "Organic diced tomatoes, organic tomato puree, organic jalapeno peppers, organic onions, organic distilled vinegar, organic cilantro, sea salt, organic garlic.",
      },
    },
  ],
  aldi: [
    {
      match: STORE_DAIRY_BUTTER_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Simply Nature",
        name: "Organic Salted Butter",
        sourceUrl: "https://www.aldi.us/products/dairy-eggs/butter-margarine/detail/ps/p/simply-nature-organic-salted-butter/",
        verifiedAt: "2026-11-09",
        size: "16 oz box",
        isOrganic: true,
        image: "/swaps/butter.jpg",
        ingredients: "Organic pasteurized sweet cream, salt.",
      },
    },
    {
      match: STORE_DAIRY_REDUCED_FAT_MILK_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Simply Nature",
        name: "Organic 2% Reduced Fat Milk",
        sourceUrl: "https://www.aldi.us/products/dairy-eggs/milk-milk-substitutes/detail/ps/p/simply-nature-organic-2-percent-milk/",
        verifiedAt: "2026-11-09",
        size: "64 fl oz carton",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Organic Grade A reduced fat milk, vitamin A palmitate, vitamin D3.",
      },
    },
    {
      match: STORE_DAIRY_WHOLE_MILK_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Simply Nature",
        name: "Organic Whole Milk",
        sourceUrl: "https://www.aldi.us/products/dairy-eggs/milk-milk-substitutes/detail/ps/p/simply-nature-organic-whole-milk/",
        verifiedAt: "2026-11-09",
        size: "64 fl oz carton",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Organic Grade A whole milk, vitamin D3.",
      },
    },
    {
      match: /^(?!.*\b(noodles?|rolls?|soup|salad|fried\s+rice|pasta|waffles?|mcmuffin|sandwich|custard|nog|mayo|mayonnaise|cookies?|cake|pastry|pastries)\b).*\b(eggs?|egg\s+whites?|egg\s+beaters)\b/i,
      alt: {
        category: "Butter/Dairy",
        brand: "Simply Nature",
        name: "Organic Cage-Free Large Brown Eggs",
        sourceUrl: "https://www.aldi.us/products/dairy-eggs/eggs/detail/ps/p/simply-nature-organic-cage-free-brown-eggs/",
        verifiedAt: "2026-11-09",
        size: "12 count carton",
        isOrganic: true,
        image: "/swaps/eggs.png",
        ingredients: "Organic cage-free shell eggs.",
      },
    },
    {
      match: STORE_DAIRY_YOGURT_MATCH,
      alt: {
        category: "Yogurt",
        brand: "Simply Nature",
        name: "Organic Plain Whole Milk Greek Yogurt",
        sourceUrl: "https://www.aldi.us/products/dairy-eggs/yogurt-sour-cream/detail/ps/p/simply-nature-organic-greek-yogurt/",
        verifiedAt: "2026-11-09",
        size: "32 oz tub",
        isOrganic: true,
        image: "/swaps/yogurt.jpg",
        ingredients: "Cultured pasteurized organic whole milk, live and active cultures.",
      },
    },
    {
      match: /\b(peanut\s+butter|jif|skippy|peter\s+pan)\b/i,
      alt: {
        category: "Snacks",
        brand: "Simply Nature",
        name: "Organic Creamy Peanut Butter",
        sourceUrl: "https://www.aldi.us/products/pantry-essentials/spreads-condiments-dressing/detail/ps/p/simply-nature-organic-creamy-peanut-butter/",
        verifiedAt: "2026-11-09",
        size: "16 oz jar",
        isOrganic: true,
        image: "/swaps/peanutbutter.png",
        ingredients: "Organic roasted peanuts, sea salt.",
      },
    },
    {
      match: /\b(tortilla\s+chips?|corn\s+chips?|doritos|tostitos|fritos|takis|santitas|mission\s+strips)\b/i,
      alt: {
        category: "Chips",
        brand: "Simply Nature",
        name: "Organic Blue Corn Tortilla Chips",
        sourceUrl: "https://www.aldi.us/products/snacks/chips-crisps-popcorn/detail/ps/p/simply-nature-organic-blue-corn-tortilla-chips/",
        verifiedAt: "2026-11-09",
        size: "8.25 oz bag",
        isOrganic: true,
        image: "/swaps/chips.jpg",
        ingredients: "Organic blue corn, organic avocado oil, sea salt.",
      },
    },
    {
      match: /\b(hummus|tzatziki|sabra|park\s+street\s+deli.*(hummus|dip))\b/i,
      alt: {
        category: "Dressings",
        brand: "Simply Nature",
        name: "Organic Classic Hummus",
        sourceUrl: "https://www.aldi.us/products/deli/dips-hummus/detail/ps/p/simply-nature-organic-classic-hummus/",
        verifiedAt: "2026-11-09",
        size: "8 oz tub",
        isOrganic: true,
        image: "/swaps/salsa.png",
        ingredients: "Organic chickpeas, water, organic tahini (ground sesame), organic extra virgin olive oil, sea salt, organic garlic, citric acid, organic cumin.",
      },
    },
    {
      match: /^(?!.*\b(peaches?|pears?|pineapple|mandarins?|oranges?|cherries|cocktail|fruit\s+cups?|heavy\s+syrup|light\s+syrup|cough)\b).*\b(syrup|mrs\.?\s*butterworth|pearl\s+milling|log\s+cabin|aunt\s+jemima)\b/i,
      alt: {
        category: "Cereal",
        brand: "Simply Nature",
        name: "Organic 100% Pure Grade A Maple Syrup",
        sourceUrl: "https://www.aldi.us/products/breakfast-cereals/syrup-breakfast-bars/detail/ps/p/simply-nature-100-pure-maple-syrup/",
        verifiedAt: "2026-11-09",
        size: "8.5 fl oz bottle",
        isOrganic: true,
        image: "/swaps/syrup.png",
        ingredients: "100% pure organic Grade A amber maple syrup.",
      },
    },
    {
      match: /\b(gravy|broth|stock|bouillon)\b/i,
      alt: {
        category: "Dressings",
        brand: "Simply Nature",
        name: "Organic Chicken Bone Broth",
        sourceUrl: "https://www.aldi.us/products/pantry-essentials/soups-broth/detail/ps/p/simply-nature-organic-chicken-bone-broth/",
        verifiedAt: "2026-11-09",
        size: "32 oz carton",
        isOrganic: true,
        image: "/swaps/broth.png",
        ingredients: "Organic chicken bone broth (water, organic chicken bones, organic onions, organic carrots, organic celery), sea salt, organic rosemary extract.",
      },
    },
    {
      match: /\b(marinara|pasta\s+sauce|spaghetti\s+sauce|tomato\s+sauce|alfredo|vodka\s+sauce|prego|ragu|bertolli|classico)\b/i,
      alt: {
        category: "Dressings",
        brand: "Simply Nature",
        name: "Organic Marinara Pasta Sauce",
        sourceUrl: "https://www.aldi.us/products/pantry-essentials/pasta-rice-grains/detail/ps/p/simply-nature-organic-marinara-pasta-sauce/",
        verifiedAt: "2026-11-09",
        size: "24 oz jar",
        isOrganic: true,
        image: "/swaps/marinara.png",
        ingredients: "Organic tomato puree, organic diced tomatoes, organic extra virgin olive oil, organic onions, sea salt, organic garlic, organic basil, organic oregano.",
      },
    },
    {
      match: /\b(salsa|picante|pace|herdez)\b/i,
      alt: {
        category: "Dressings",
        brand: "Simply Nature",
        name: "Organic Thick & Chunky Medium Salsa",
        sourceUrl: "https://www.aldi.us/products/snacks/salsa-dips/detail/ps/p/simply-nature-organic-thick-chunky-salsa/",
        verifiedAt: "2026-11-09",
        size: "16 oz jar",
        isOrganic: true,
        image: "/swaps/salsa.png",
        ingredients: "Organic diced tomatoes, water, organic tomato paste, organic jalapeno peppers, organic onions, organic distilled vinegar, sea salt, organic garlic, organic cilantro.",
      },
    },
    {
      match: /\b(bread|loaf|sandwich\s+bread|wonder\s+bread|sara\s+lee|nature'?s\s+own)\b/i,
      alt: {
        category: "Bread",
        brand: "Simply Nature",
        name: "Organic Seedtastic 21 Whole Grains & Seeds Bread",
        sourceUrl: "https://www.aldi.us/products/bakery-bread/bread/detail/ps/p/simply-nature-organic-seedtastic-bread/",
        verifiedAt: "2026-11-09",
        size: "27 oz loaf",
        isOrganic: true,
        image: "/swaps/bread.jpg",
        ingredients: "Organic whole wheat, water, organic whole grain oats, organic sunflower seeds, organic flax seeds, organic sesame seeds, organic cane sugar, yeast, sea salt.",
      },
    },
  ],
  bjs: [
    {
      match: STORE_DAIRY_BUTTER_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Wellsley Farms",
        name: "Organic Salted Butter",
        sourceUrl: "https://www.bjs.com/product/wellsley-farms-organic-salted-butter-4-pk-1-lb/3000000000000185243",
        verifiedAt: "2026-11-09",
        size: "4 lb (4 pack)",
        isOrganic: true,
        image: "/swaps/butter.jpg",
        ingredients: "Organic pasteurized sweet cream, salt.",
      },
    },
    {
      match: STORE_DAIRY_REDUCED_FAT_MILK_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Wellsley Farms",
        name: "Organic 2% Reduced Fat Milk",
        sourceUrl: "https://www.bjs.com/product/wellsley-farms-organic-2-reduced-fat-milk-3-pk-64-oz/3000000000000143211",
        verifiedAt: "2026-11-09",
        size: "0.5 gal (3 pack)",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Organic Grade A reduced fat milk, vitamin A palmitate, vitamin D3.",
      },
    },
    {
      match: STORE_DAIRY_WHOLE_MILK_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Wellsley Farms",
        name: "Organic Whole Milk",
        sourceUrl: "https://www.bjs.com/product/wellsley-farms-organic-whole-milk-3-pk-64-oz/3000000000000143210",
        verifiedAt: "2026-11-09",
        size: "0.5 gal (3 pack)",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Organic Grade A whole milk, vitamin D3.",
      },
    },
    {
      match: /^(?!.*\b(noodles?|rolls?|soup|salad|fried\s+rice|pasta|waffles?|mcmuffin|sandwich|custard|nog|mayo|mayonnaise|cookies?|cake|pastry|pastries)\b).*\b(eggs?|egg\s+whites?|egg\s+beaters)\b/i,
      alt: {
        category: "Butter/Dairy",
        brand: "Wellsley Farms",
        name: "Organic Free-Range Large Brown Eggs",
        sourceUrl: "https://www.bjs.com/product/wellsley-farms-organic-free-range-large-brown-eggs-24-ct/3000000000000167422",
        verifiedAt: "2026-11-09",
        size: "24 count carton",
        isOrganic: true,
        image: "/swaps/eggs.png",
        ingredients: "Organic free-range shell eggs.",
      },
    },
    {
      match: /\b(peanut\s+butter|jif|skippy|peter\s+pan)\b/i,
      alt: {
        category: "Snacks",
        brand: "Wellsley Farms",
        name: "Organic Creamy Peanut Butter",
        sourceUrl: "https://www.bjs.com/product/wellsley-farms-organic-creamy-peanut-butter-2-pk-28-oz/3000000000000158319",
        verifiedAt: "2026-11-09",
        size: "28 oz (2 pack)",
        isOrganic: true,
        image: "/swaps/peanutbutter.png",
        ingredients: "Organic roasted peanuts, sea salt.",
      },
    },
    {
      match: /^(?!.*\b(peaches?|pears?|pineapple|mandarins?|oranges?|cherries|cocktail|fruit\s+cups?|heavy\s+syrup|light\s+syrup|cough)\b).*\b(syrup|mrs\.?\s*butterworth|pearl\s+milling|log\s+cabin|aunt\s+jemima)\b/i,
      alt: {
        category: "Cereal",
        brand: "Wellsley Farms",
        name: "Organic 100% Pure Grade A Amber Maple Syrup",
        sourceUrl: "https://www.bjs.com/product/wellsley-farms-organic-100-pure-maple-syrup-32-oz/3000000000000138922",
        verifiedAt: "2026-11-09",
        size: "32 fl oz jug",
        isOrganic: true,
        image: "/swaps/syrup.png",
        ingredients: "100% pure organic Grade A amber maple syrup.",
      },
    },
    {
      match: /\b(gravy|broth|stock|bouillon)\b/i,
      alt: {
        category: "Dressings",
        brand: "Wellsley Farms",
        name: "Organic Chicken Bone Broth",
        sourceUrl: "https://www.bjs.com/product/wellsley-farms-organic-chicken-broth-6-pk-32-oz/3000000000000178114",
        verifiedAt: "2026-11-09",
        size: "32 oz (6 pack)",
        isOrganic: true,
        image: "/swaps/broth.png",
        ingredients: "Organic chicken stock, organic vegetable stock (organic carrot, organic celery, organic onion), sea salt, organic rosemary extract.",
      },
    },
  ],
  target: [
    {
      match: STORE_DAIRY_BUTTER_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Good & Gather",
        name: "Organic Salted Butter",
        sourceUrl: "https://www.target.com/p/organic-salted-butter-16oz-4ct-good-38-gather-8482/-/A-54527664",
        verifiedAt: "2026-11-09",
        size: "16 oz (4 sticks)",
        isOrganic: true,
        image: "/swaps/butter.jpg",
        ingredients: "Organic pasteurized sweet cream, salt.",
      },
    },
    {
      match: STORE_DAIRY_REDUCED_FAT_MILK_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Good & Gather",
        name: "Organic 2% Reduced Fat Milk",
        sourceUrl: "https://www.target.com/p/organic-2-reduced-fat-milk-0-5gal-good-38-gather-8482/-/A-54463486",
        verifiedAt: "2026-11-09",
        size: "64 fl oz carton",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Organic Grade A reduced fat milk, vitamin A palmitate, vitamin D3.",
      },
    },
    {
      match: STORE_DAIRY_WHOLE_MILK_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Good & Gather",
        name: "Organic Whole Milk",
        sourceUrl: "https://www.target.com/p/organic-whole-milk-0-5gal-good-38-gather-8482/-/A-54463484",
        verifiedAt: "2026-11-09",
        size: "64 fl oz carton",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Organic Grade A whole milk, vitamin D3.",
      },
    },
    {
      match: /\b(peanut\s+butter|jif|skippy|peter\s+pan)\b/i,
      alt: {
        category: "Snacks",
        brand: "Good & Gather",
        name: "Organic Creamy Peanut Butter",
        sourceUrl: "https://www.target.com/p/organic-stir-creamy-peanut-butter-16oz-good-38-gather-8482/-/A-54515883",
        verifiedAt: "2026-11-09",
        size: "16 oz jar",
        isOrganic: true,
        image: "/swaps/peanutbutter.png",
        ingredients: "Organic dry roasted peanuts, sea salt.",
      },
    },
    {
      match: /^(?!.*\b(peaches?|pears?|pineapple|mandarins?|oranges?|cherries|cocktail|fruit\s+cups?|heavy\s+syrup|light\s+syrup|cough)\b).*\b(syrup|mrs\.?\s*butterworth|pearl\s+milling|log\s+cabin|aunt\s+jemima)\b/i,
      alt: {
        category: "Cereal",
        brand: "Good & Gather",
        name: "Organic 100% Pure Grade A Amber Maple Syrup",
        sourceUrl: "https://www.target.com/p/organic-100-pure-grade-a-amber-rich-maple-syrup-12-fl-oz-good-38-gather-8482/-/A-54514772",
        verifiedAt: "2026-11-09",
        size: "12 fl oz bottle",
        isOrganic: true,
        image: "/swaps/syrup.png",
        ingredients: "100% pure organic Grade A amber maple syrup.",
      },
    },
    {
      match: /^(?!.*\b(sauce|fries|soup|gravy|seasoning|jerky|stick|broth|stock|beyond|impossible|plant[- ]?based|vegan|veggie|black\s+bean|morningstar|boca|gardenburger)\b).*\b(ground\s+beef|ground\s+chuck|beef\s+patties|burger\s+patties|\d{2}%\s*lean\s*\/?\s*\d{1,2}%\s*fat\s*(?:ground\s+)?beef)\b/i,
      alt: {
        category: "Deli Meat",
        brand: "Good & Gather",
        name: "Organic 100% Grass-Fed 85% Lean 15% Fat Ground Beef",
        searchQuery: "Organic Grass Fed Ground Beef",
        sourceUrl: "https://www.target.com/p/organic-100-grass-fed-85-15-ground-beef-1lb-good-38-gather-8482/-/A-54582406",
        verifiedAt: "2026-11-10",
        size: "1 lb brick",
        isOrganic: true,
        image: "/swaps/beef.png",
        ingredients: "100% Organic Grass-Fed Beef.",
      },
    },
  ],
  kroger: [
    {
      match: STORE_DAIRY_BUTTER_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Simple Truth Organic",
        name: "Salted Butter",
        sourceUrl: "https://www.kroger.com/p/simple-truth-organic-salted-butter-sticks/0001111089515",
        verifiedAt: "2026-11-09",
        size: "16 oz (4 sticks)",
        isOrganic: true,
        image: "/swaps/butter.jpg",
        ingredients: "Organic pasteurized sweet cream, salt.",
      },
    },
    {
      match: STORE_DAIRY_REDUCED_FAT_MILK_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Simple Truth Organic",
        name: "2% Reduced Fat Milk",
        sourceUrl: "https://www.kroger.com/p/simple-truth-organic-2-reduced-fat-milk-half-gallon/0001111040651",
        verifiedAt: "2026-11-09",
        size: "64 fl oz carton",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Organic Grade A reduced fat milk, vitamin A palmitate, vitamin D3.",
      },
    },
    {
      match: STORE_DAIRY_WHOLE_MILK_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "Simple Truth Organic",
        name: "Whole Milk",
        sourceUrl: "https://www.kroger.com/p/simple-truth-organic-whole-milk-half-gallon/0001111040650",
        verifiedAt: "2026-11-09",
        size: "64 fl oz carton",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Organic Grade A whole milk, vitamin D3.",
      },
    },
    {
      match: STORE_DAIRY_YOGURT_MATCH,
      alt: {
        category: "Yogurt",
        brand: "Simple Truth Organic",
        name: "Plain Whole Milk Greek Yogurt",
        sourceUrl: "https://www.kroger.com/p/simple-truth-organic-plain-whole-milk-greek-yogurt/0001111042159",
        verifiedAt: "2026-11-09",
        size: "32 oz tub",
        isOrganic: true,
        image: "/swaps/yogurt.jpg",
        ingredients: "Cultured pasteurized organic whole milk, live and active cultures.",
      },
    },
    {
      match: /\b(peanut\s+butter|jif|skippy|peter\s+pan)\b/i,
      alt: {
        category: "Snacks",
        brand: "Simple Truth Organic",
        name: "Creamy Peanut Butter",
        sourceUrl: "https://www.kroger.com/p/simple-truth-organic-creamy-peanut-butter/0001111085566",
        verifiedAt: "2026-11-09",
        size: "16 oz jar",
        isOrganic: true,
        image: "/swaps/peanutbutter.png",
        ingredients: "Organic roasted peanuts, sea salt.",
      },
    },
    {
      match: /^(?!.*\b(peaches?|pears?|pineapple|mandarins?|oranges?|cherries|cocktail|fruit\s+cups?|heavy\s+syrup|light\s+syrup|cough)\b).*\b(syrup|mrs\.?\s*butterworth|pearl\s+milling|log\s+cabin|aunt\s+jemima)\b/i,
      alt: {
        category: "Cereal",
        brand: "Simple Truth Organic",
        name: "100% Pure Grade A Amber Maple Syrup",
        sourceUrl: "https://www.kroger.com/p/simple-truth-organic-pure-maple-syrup/0001111087855",
        verifiedAt: "2026-11-09",
        size: "12 fl oz bottle",
        isOrganic: true,
        image: "/swaps/syrup.png",
        ingredients: "100% pure organic Grade A amber maple syrup.",
      },
    },
    {
      match: /^(?!.*\b(sauce|fries|soup|gravy|seasoning|jerky|stick|broth|stock|beyond|impossible|plant[- ]?based|vegan|veggie|black\s+bean|morningstar|boca|gardenburger)\b).*\b(ground\s+beef|ground\s+chuck|beef\s+patties|burger\s+patties|\d{2}%\s*lean\s*\/?\s*\d{1,2}%\s*fat\s*(?:ground\s+)?beef)\b/i,
      alt: {
        category: "Deli Meat",
        brand: "Simple Truth Organic",
        name: "Organic 100% Grass-Fed Ground Beef",
        searchQuery: "Organic Grass Fed Ground Beef",
        sourceUrl: "https://www.kroger.com/p/simple-truth-organic-85-lean-15-fat-grass-fed-ground-beef/0001111097023",
        verifiedAt: "2026-11-10",
        size: "1 lb brick",
        isOrganic: true,
        image: "/swaps/beef.png",
        ingredients: "100% Organic Grass-Fed Beef.",
      },
    },
  ],
  amazon: [
    {
      match: STORE_DAIRY_BUTTER_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "365 by Whole Foods Market",
        name: "Organic Salted Butter",
        sourceUrl: "https://www.wholefoodsmarket.com/product/365-by-whole-foods-market-organic-salted-butter-16-oz-b074h58zbb",
        verifiedAt: "2026-11-09",
        size: "16 oz (4 sticks)",
        isOrganic: true,
        image: "/swaps/butter.jpg",
        ingredients: "Organic pasteurized sweet cream, salt.",
      },
    },
    {
      match: STORE_DAIRY_REDUCED_FAT_MILK_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "365 by Whole Foods Market",
        name: "Organic Reduced Fat 2% Milk",
        sourceUrl: "https://www.wholefoodsmarket.com/product/365-by-whole-foods-market-organic-reduced-fat-milk-64-fl-oz-b074h5p45d",
        verifiedAt: "2026-11-09",
        size: "64 fl oz carton",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Organic Grade A reduced fat milk, vitamin A palmitate, vitamin D3.",
      },
    },
    {
      match: STORE_DAIRY_WHOLE_MILK_MATCH,
      alt: {
        category: "Butter/Dairy",
        brand: "365 by Whole Foods Market",
        name: "Organic Whole Milk",
        sourceUrl: "https://www.wholefoodsmarket.com/product/365-by-whole-foods-market-organic-whole-milk-64-fl-oz-b074h68h9p",
        verifiedAt: "2026-11-09",
        size: "64 fl oz carton",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Organic Grade A whole milk, vitamin D3.",
      },
    },
    {
      match: /\b(peanut\s+butter|jif|skippy|peter\s+pan)\b/i,
      alt: {
        category: "Snacks",
        brand: "365 by Whole Foods Market",
        name: "Organic Creamy Peanut Butter",
        sourceUrl: "https://www.wholefoodsmarket.com/product/365-by-whole-foods-market-organic-creamy-peanut-butter-16-oz-b074h5v376",
        verifiedAt: "2026-11-09",
        size: "16 oz jar",
        isOrganic: true,
        image: "/swaps/peanutbutter.png",
        ingredients: "Organic dry roasted peanuts, sea salt.",
      },
    },
    {
      match: /^(?!.*\b(peaches?|pears?|pineapple|mandarins?|oranges?|cherries|cocktail|fruit\s+cups?|heavy\s+syrup|light\s+syrup|cough)\b).*\b(syrup|mrs\.?\s*butterworth|pearl\s+milling|log\s+cabin|aunt\s+jemima)\b/i,
      alt: {
        category: "Cereal",
        brand: "365 by Whole Foods Market",
        name: "Organic 100% Pure Grade A Amber Maple Syrup",
        sourceUrl: "https://www.wholefoodsmarket.com/product/365-by-whole-foods-market-organic-grade-a-amber-maple-syrup-12-fl-oz-b074h5s8l2",
        verifiedAt: "2026-11-09",
        size: "12 fl oz bottle",
        isOrganic: true,
        image: "/swaps/syrup.png",
        ingredients: "100% pure organic Grade A amber maple syrup.",
      },
    },
  ],
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
  [
    "Yogurt",
    /\b(yogh?urt|skyr|kefir|yoplait|dannon|fage|siggi)\b|^(?!.*\b(creamer|coffee|oat\s*milk|oatmilk|barista)\b).*\bchobani\b/i,
  ],
  ["Crackers", /\b(crackers?|cheez|goldfish|triscuit|saltines?|ritz|wheat thins|graham)\b/i],
  ["Chips", /\b(chips|crisps|tortilla chips|doritos|pringles|cheetos|cheese puffs|takis|fritos|lay's|lays|ruffles|pretzels?|popcorn)\b/i],
  ["Cereal", /\b(cereal|flakes|granola|loops|o'?s|oreo\s+puffs?|reese'?s\s+puffs?|cocoa\s+puffs?|muesli|oatmeal|cheerios|cinnamon toast|lucky charms|frosted|raisin bran|syrup)\b/i],
  ["Dressings", /\b(gravy|broth|stock|bouillon|dressing|ranch|vinaigrette|mayo|mayonnaise|caesar|aioli|ketchup|mustard|wasabi|horseradish|bbq|barbecue|sauce|salsa|marinara|hummus|guacamole|tzatziki)\b/i],
  ["Deli Meat", /\b(turkey|ham|spam|salami|bologna|pepperoni|deli|bacon|hot ?dogs?|franks?|sausages?|kielbasa|lunch ?meat|roast beef|chicken breast|chicken patties|nuggets|tenders|beef|steak|pork|jerky)\b/i],
  ["Butter/Dairy", /\b(butter|margarine|spread|milk|eggnog|egg nog|cheese|velveeta|cream|creamer|eggs?|ice cream|gelato|half and half|cottage cheese)\b/i],
  ["Bread", /\b(bread|buns?|rolls?|bagels?|tortillas?|loaf|english muffins?|waffles?|pancakes?|muffins?|croissants?|pasta|noodles|macaroni|pizza|hot pockets?)\b/i],
  ["Snacks", /\b(bars?|cookies?|wafers?|knoppers|storck|merci|kinder|snacks?|gummies|gummy|candy|fruit snacks|pastries|tarts?|oreos?|chocolate|brownies?|soda|cola|juice|drink|gatorade|monster|red\s*bull|celsius|pre[- ]?workout|water|tea|coffee|peanut butter|almond butter|nutella|jam|jelly|cake\s+roll)\b/i],
];

export function detectCategory(productTitle = "", _ingredients = ""): SwapCategory {
  for (const [cat, re] of CATEGORY_KEYWORDS) if (re.test(productTitle)) return cat;
  return "Snacks";
}

/**
 * Private-label store brands owned by each grocery retailer (used for "Store-Brand Value Pick" badges
 * and budget-first clean swap sorting — never hardcoding retail dollar prices).
 */
export const STORE_PRIVATE_LABEL_BRANDS: Partial<Record<Store, readonly string[]>> = {
  walmart: ["great value", "bettergoods", "marketside", "sam's choice"],
  target: ["good & gather", "favorite day", "market pantry"],
  aldi: ["simply nature", "friendly farms", "livegfree", "specially selected", "l'oven fresh", "park street deli", "millville"],
  costco: ["kirkland signature"],
  sams: ["member's mark"],
  bjs: ["wellsley farms", "berkley jensen"],
  kroger: ["simple truth", "simple truth organic", "private selection", "kroger"],
  amazon: ["365 by whole foods market", "whole foods market", "amazon fresh", "happy belly"],
};

export function isStoreBrandForStore(brand = "", store?: Store): boolean {
  const norm = brand.trim().toLowerCase();
  if (!norm) return false;
  if (store && STORE_PRIVATE_LABEL_BRANDS[store]) {
    return STORE_PRIVATE_LABEL_BRANDS[store]!.some((b) => norm === b || norm.startsWith(`${b} `));
  }
  return Object.values(STORE_PRIVATE_LABEL_BRANDS).some((list) =>
    (list || []).some((b) => norm === b || norm.startsWith(`${b} `))
  );
}

/**
 * Budget-friendly Walmart private-label (Great Value Organic & bettergoods) clean alternatives.
 * Included automatically in `swapCandidates` at Walmart and promoted to #1 when `preferStoreBrand: true`.
 */
export const WALMART_STORE_BRAND_ALTERNATIVES: { match: RegExp; alt: CleanAlternative }[] = [
  {
    match: STORE_DAIRY_BUTTER_MATCH,
    alt: {
      category: "Butter/Dairy",
      brand: "Great Value",
      name: "Organic Salted Butter",
      sourceUrl: "https://www.walmart.com/search?q=Great%20Value%20Organic%20Salted%20Butter%2016%20oz",
      verifiedAt: "2026-11-10",
      size: "16 oz (4 sticks)",
      isOrganic: true,
      image: "/swaps/butter.jpg",
      ingredients: "Organic pasteurized sweet cream, salt.",
    },
  },
  {
    match: STORE_DAIRY_REDUCED_FAT_MILK_MATCH,
    alt: {
      category: "Butter/Dairy",
      brand: "Great Value",
      name: "Organic Reduced Fat 2% Milk",
      sourceUrl: "https://www.walmart.com/search?q=Great%20Value%20Organic%20Reduced%20Fat%202%25%20Milk",
      verifiedAt: "2026-11-10",
      size: "64 fl oz carton",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Organic Grade A reduced fat milk, vitamin A palmitate, vitamin D3.",
    },
  },
  {
    match: STORE_DAIRY_WHOLE_MILK_MATCH,
    alt: {
      category: "Butter/Dairy",
      brand: "Great Value",
      name: "Organic Whole Vitamin D Milk",
      sourceUrl: "https://www.walmart.com/search?q=Great%20Value%20Organic%20Whole%20Vitamin%20D%20Milk",
      verifiedAt: "2026-11-10",
      size: "64 fl oz carton",
      isOrganic: true,
      image: "/swaps/milk.png",
      ingredients: "Organic Grade A whole milk, vitamin D3.",
    },
  },
  {
    match: /^(?!.*\b(noodles?|rolls?|soup|salad|fried\s+rice|pasta|waffles?|mcmuffin|sandwich|custard|nog|mayo|mayonnaise|cookies?|cake|pastry|pastries)\b).*\b(eggs?|egg\s+whites?|egg\s+beaters)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Great Value",
      name: "Organic Cage-Free Large Brown Eggs",
      sourceUrl: "https://www.walmart.com/search?q=Great%20Value%20Organic%20Cage-Free%20Large%20Brown%20Eggs%2012%20Count",
      verifiedAt: "2026-11-10",
      size: "12 count carton",
      isOrganic: true,
      image: "/swaps/eggs.png",
      ingredients: "Organic cage-free shell eggs.",
    },
  },
  {
    match: STORE_DAIRY_YOGURT_MATCH,
    alt: {
      category: "Yogurt",
      brand: "Great Value",
      name: "Organic Plain Nonfat Greek Yogurt",
      sourceUrl: "https://www.walmart.com/search?q=Great%20Value%20Organic%20Plain%20Nonfat%20Greek%20Yogurt%2032%20oz",
      verifiedAt: "2026-11-10",
      size: "32 oz tub",
      isOrganic: true,
      image: "/swaps/yogurt.jpg",
      ingredients: "Cultured pasteurized organic nonfat milk, live and active cultures.",
    },
  },
  {
    match: /\b(peanut\s+butter|jif|skippy|peter\s+pan)\b/i,
    alt: {
      category: "Snacks",
      brand: "Great Value",
      name: "Organic Creamy Stir Peanut Butter",
      sourceUrl: "https://www.walmart.com/search?q=Great%20Value%20Organic%20Creamy%20Stir%20Peanut%20Butter%2016%20oz",
      verifiedAt: "2026-11-10",
      size: "16 oz jar",
      isOrganic: true,
      image: "/swaps/peanutbutter.png",
      ingredients: "Organic roasted peanuts, sea salt.",
    },
  },
  {
    match: /^(?!.*\b(peaches?|pears?|pineapple|mandarins?|oranges?|cherries|cocktail|fruit\s+cups?|heavy\s+syrup|light\s+syrup|cough)\b).*\b(syrup|mrs\.?\s*butterworth|pearl\s+milling|log\s+cabin|aunt\s+jemima)\b/i,
    alt: {
      category: "Cereal",
      brand: "Great Value",
      name: "Organic 100% Pure Maple Syrup",
      sourceUrl: "https://www.walmart.com/search?q=Great%20Value%20Organic%20100%25%20Pure%20Maple%20Syrup",
      verifiedAt: "2026-11-10",
      size: "12 fl oz bottle",
      isOrganic: true,
      image: "/swaps/syrup.png",
      ingredients: "Organic pure maple syrup.",
    },
  },
  {
    match: /\b(potato\s+chips|kettle\s+chips|lay'?s|ruffles|pringles|wavy\s+chips)\b/i,
    alt: {
      category: "Chips",
      brand: "bettergoods",
      name: "Avocado Oil Sea Salt Potato Chips",
      sourceUrl: "https://www.walmart.com/search?q=bettergoods%20Avocado%20Oil%20Sea%20Salt%20Potato%20Chips",
      verifiedAt: "2026-11-10",
      size: "7 oz bag",
      image: "/swaps/chips.jpg",
      ingredients: "Potatoes, avocado oil, sea salt.",
      nutrition: { caloriesKcal100g: 535, sugarsG100g: 0, saturatedFatG100g: 5.3, sodiumMg100g: 390, fiberG100g: 3.6, proteinG100g: 7.1, fruitsVegNutsPct: 80 },
    },
  },
  {
    match: /\b(salsa|picante|pace|herdez|tostitos\s+salsa)\b/i,
    alt: {
      category: "Dressings",
      brand: "Great Value",
      name: "Organic Medium Salsa",
      sourceUrl: "https://www.walmart.com/search?q=Great%20Value%20Organic%20Medium%20Salsa%2016%20oz",
      verifiedAt: "2026-11-10",
      size: "16 oz jar",
      isOrganic: true,
      image: "/swaps/salsa.png",
      ingredients: "Organic diced tomatoes in juice, organic tomato puree, organic onions, organic jalapeno peppers, organic distilled vinegar, sea salt, organic garlic, organic cilantro.",
    },
  },
  {
    match: /\b(gravy|broth|stock|bouillon)\b/i,
    alt: {
      category: "Dressings",
      brand: "Great Value",
      name: "Organic Low Sodium Chicken Broth",
      sourceUrl: "https://www.walmart.com/search?q=Great%20Value%20Organic%20Low%20Sodium%20Chicken%20Broth%2032%20oz",
      verifiedAt: "2026-11-10",
      size: "32 oz carton",
      isOrganic: true,
      image: "/swaps/broth.png",
      ingredients: "Organic chicken stock, sea salt, organic carrot juice concentrate, organic celery juice concentrate, organic onion juice concentrate.",
    },
  },
];

/**
 * Resolves the exact 1-for-1 CleanAlternative for a given product title and active store
 * (e.g. Member's Mark at Sam's Club, Kirkland Signature at Costco, Simply Nature at ALDI,
 * Wellsley Farms at BJ's, Good & Gather at Target, Simple Truth at Kroger, 365 at Amazon,
 * and Great Value / bettergoods at Walmart when `preferStoreBrand === true`),
 * falling back to the nationwide 1-for-1 match or category default.
 */
export function resolveCleanAlternative(
  productTitle = "",
  category?: SwapCategory,
  store?: Store,
  preferStoreBrand = false,
  requireOrganic = false
): CleanAlternative {
  const title = productTitle.trim();
  const passesOrganic = (alt: CleanAlternative) =>
    !requireOrganic || alt.isOrganic === true || alt.nutrition?.isOrganic === true;
  if (title && store) {
    if (preferStoreBrand && store === "walmart") {
      for (const rule of WALMART_STORE_BRAND_ALTERNATIVES) {
        if (rule.match.test(title) && passesOrganic(rule.alt)) {
          return rule.alt;
        }
      }
    }
    const storeRules = STORE_SPECIFIC_OVERRIDES[store];
    if (storeRules) {
      for (const rule of storeRules) {
        if (rule.match.test(title) && passesOrganic(rule.alt)) {
          return rule.alt;
        }
      }
    }
  }
  if (title) {
    for (const rule of EXACT_PRODUCT_ALTERNATIVES) {
      if (rule.match.test(title) && passesOrganic(rule.alt)) {
        return rule.alt;
      }
    }
  }
  const cat = category ?? detectCategory(title);
  return CLEAN_ALTERNATIVES[cat];
}

export function impactClickId(): string {
  return (
    (typeof process !== "undefined" && (process.env?.NEXT_PUBLIC_IMPACT_CLICK_ID || process.env?.IMPACT_CLICK_ID)) ||
    ""
  ).trim();
}

export function amazonPartnerTag(): string {
  return (
    (typeof process !== "undefined" && (process.env?.NEXT_PUBLIC_AMAZON_TAG || process.env?.AMAZON_PARTNER_TAG)) ||
    "heybroc-20"
  ).trim();
}

function impactRedirectBase(store: Store): string {
  if (typeof process === "undefined" || !process.env) return "";
  switch (store) {
    case "walmart":
      return (process.env.NEXT_PUBLIC_IMPACT_WALMART_BASE_URL || process.env.IMPACT_WALMART_BASE_URL || "").trim();
    case "target":
      return (process.env.NEXT_PUBLIC_IMPACT_TARGET_BASE_URL || process.env.IMPACT_TARGET_BASE_URL || "").trim();
    case "instacart":
    case "aldi":
      return (process.env.NEXT_PUBLIC_IMPACT_INSTACART_BASE_URL || process.env.IMPACT_INSTACART_BASE_URL || "").trim();
    default:
      return (process.env.NEXT_PUBLIC_IMPACT_DEFAULT_BASE_URL || process.env.IMPACT_DEFAULT_BASE_URL || "").trim();
  }
}

export function isAffiliateAllowedOnClient(
  surface: ScanSurface = "web",
  clientPlatform?: ClientPlatform
): boolean {
  if (surface === "extension") return false;
  if (
    clientPlatform === "chrome-extension" ||
    clientPlatform === "ios-safari" ||
    clientPlatform === "ios-share" ||
    clientPlatform === "ios-shortcut" ||
    clientPlatform === "ios-app"
  ) {
    return false;
  }
  return true;
}

function withAffiliate(
  url: string,
  store: Store,
  clickId: string,
  surface: ScanSurface = "web",
  clientPlatform?: ClientPlatform
): { url: string; isPaidLink: boolean } {
  // Browser extensions (Chrome / Safari) and all iOS App Store surfaces (Guideline 3.2.2(ix))
  // must never inject Amazon Associates tags or Walmart/Target/Instacart Impact affiliate links.
  if (!isAffiliateAllowedOnClient(surface, clientPlatform)) {
    return { url, isPaidLink: false };
  }
  const sep = url.includes("?") ? "&" : "?";
  if (store === "amazon") {
    // Android must not attach Amazon Associates tag until explicitly approved by Amazon
    if (
      (surface === "android" || clientPlatform === "android") &&
      (typeof process === "undefined" ||
        (process.env?.AMAZON_APP_APPROVED !== "true" &&
          process.env?.CLEANCART_AMAZON_MOBILE_APPROVED !== "true"))
    ) {
      return { url, isPaidLink: false };
    }
    const tag = amazonPartnerTag();
    if (!tag) return { url, isPaidLink: false };
    return {
      url: `${url}${sep}tag=${encodeURIComponent(tag)}&linkCode=ll2`,
      isPaidLink: true,
    };
  }
  const redirectBase = impactRedirectBase(store);
  if (redirectBase && url.startsWith("https://")) {
    const baseSep = redirectBase.includes("?") ? "&" : "?";
    const subIdParam = clickId ? `&subId1=${encodeURIComponent(clickId)}` : "";
    return {
      url: `${redirectBase.replace(/\/+$/, "")}${baseSep}u=${encodeURIComponent(url)}${subIdParam}`,
      isPaidLink: true,
    };
  }
  return { url, isPaidLink: false };
}

/** Keep the scored product's brand and variant in every retailer search. */
function conciseClubQuery(q: string): string {
  return q
    .replace(/\((?:nut[- ]?free|peanut[- ]?free|dairy[- ]?free|gluten[- ]?free|sesame[- ]?free|100%\s*pure|apple\s*\+\s*strawberry)\)/gi, " ")
    .replace(/[\"/\\]+/g, " ")
    .replace(/\borganics\s+organic\b/gi, "Organic")
    .replace(/\b(organic\s+[a-z0-9'&]+)\s+organic\b/gi, "$1")
    .replace(/\b(organic)\s+\1\b/gi, "$1")
    .replace(/\braw\s+(?=sharp\s+cheddar\b)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

const RESERVED_INSTACART_SEGMENTS = new Set([
  "s",
  "search",
  "cart",
  "checkout",
  "account",
  "hub",
  "referrals",
  "orders",
  "lists",
  "store",
  "stores",
  "items",
  "products",
  "help",
  "login",
  "signup",
  "categories",
  "collections",
]);

export function sanitizeInstacartRetailerSlug(slug?: string): string {
  if (!slug || typeof slug !== "string") return "";
  const cleaned = slug
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "")
    .replace(/^store\//, "")
    .split("/")[0]
    .replace(/[^a-z0-9_-]/g, "");
  if (!cleaned || cleaned.length < 2 || RESERVED_INSTACART_SEGMENTS.has(cleaned)) {
    return "";
  }
  return cleaned;
}

export function formatSwapFullTitle(alt: { brand: string; name: string }): string {
  return `${alt.brand} ${alt.name}`
    .replace(/\b(organic)\s+\1\b/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function searchPath(store: Store, q: string, instacartRetailerSlug?: string): string {
  const concise = conciseClubQuery(q);
  const e = encodeURIComponent(concise);
  switch (store) {
    case "walmart": return `/search?q=${e}`;
    case "instacart": {
      const slug = sanitizeInstacartRetailerSlug(instacartRetailerSlug);
      return slug ? `/store/${slug}/s?k=${e}` : `/store/s?k=${e}`;
    }
    case "target": return `/s?searchTerm=${e}`;
    case "kroger": return `/search?query=${e}`;
    case "aldi": return `/store/aldi/s?k=${e}`;
    case "doordash": return `/search/store/${e}`;
    case "ubereats": return `/search?q=${e}`;
    case "amazon": return `/s?k=${e}&i=amazonfresh`;
    case "sams": return `/s/${e}`;
    case "bjs": {
      return `/search/${e}?q=${e}&query=${e}&searchTerm=${e}`;
    }
    case "costco": return `/CatalogSearch?dept=All&keyword=${e}`;
    case "shipt": return `/shop/search?query=${e}`;
  }
}

function productPath(store: Store, id: string, instacartRetailerSlug?: string): string {
  switch (store) {
    case "walmart": return `/ip/${id}`;
    case "instacart": {
      const slug = sanitizeInstacartRetailerSlug(instacartRetailerSlug);
      return slug ? `/store/${slug}/products/${id}` : `/products/${id}`;
    }
    case "target": return `/p/${id}`;
    case "kroger": return `/p/item/${id}`;
    case "aldi": return `/store/aldi/products/${id}`;
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
export function buildLinks(
  alt: CleanAlternative,
  store: Store,
  clickId = impactClickId(),
  surface: ScanSurface = "web",
  instacartRetailerSlug?: string,
  clientPlatform?: ClientPlatform
) {
  const meta = STORE_META[store];
  const query = alt.searchQuery || formatSwapFullTitle(alt);
  const searchQuery = conciseClubQuery(query);
  const id = alt.itemIds?.[store];
  const path = id
    ? productPath(store, id, instacartRetailerSlug)
    : searchPath(store, query, instacartRetailerSlug);
  const { url: webUrl, isPaidLink } = withAffiliate(
    `https://${meta.host}${path}`,
    store,
    clickId,
    surface,
    clientPlatform
  );
  // Always use HTTPS App Links / Universal Links so native grocery apps preserve Impact/Amazon affiliate params when permitted.
  const deepLink = webUrl;
  const { url: intentPath } = withAffiliate(path, store, clickId, surface, clientPlatform);
  const androidIntentUrl =
    `intent://${meta.host}${intentPath}#Intent;scheme=https;package=${meta.androidPackage};` +
    `S.browser_fallback_url=${encodeURIComponent(webUrl)};end`;
  return {
    searchQuery,
    webUrl,
    deepLink,
    androidIntentUrl,
    androidPackage: meta.androidPackage,
    isPaidLink,
  };
}

const NON_FOOD_SWAP_GUARD =
  /\b(sunscreen|banana\s+boat|coppertone|neutrogena|lotion|spf|lip\s+balm|shampoo|conditioner|body\s+wash|face\s+wash|soap|detergent|cleaner|bleach|wipes?|candle|deodorant|toothpaste|mouthwash|diapers?|litter|pet\s+food|dog\s+food|cat\s+food|toilet\s+paper|paper\s+towels?|bath\s+tissue)\b/i;

const ALREADY_PURE_MAPLE_SYRUP_GUARD =
  /\b(100%\s*(?:pure\s*)?(?:organic\s*)?(?:grade\s+a\s+)?maple\s+syrup|pure\s+maple\s+syrup|organic\s+(?:grade\s+a\s+)?maple\s+syrup|grade\s+a\s+(?:golden|amber|dark|very\s+dark)\b.*\bmaple\s+syrup|crown\s+maple|coombs\s+family|sapjack)\b/i;

const SECONDARY_CLEAN_ALTERNATIVES: Array<{ match: RegExp; alts: CleanAlternative[] }> = [
  {
    match: /^(?!.*\b(creamer|chocolate)\b).*\b(oat\s*(?:milk|beverage|drink|barista)|oatmilk|milked\s+oats?|planet\s+oat|oatly|chobani\s+oat|silk\s+oat(?:milk|\s+yeah)?|califia.*\boat\b)\b/i,
    alts: [
      {
        category: "Butter/Dairy",
        brand: "MALK",
        name: "Organic Unsweetened Oat Milk",
        sourceUrl: "https://malkorganics.com/products/unsweetened-oat-malk/",
        verifiedAt: "2026-11-09",
        size: "28 fl oz bottle",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Filtered water, organic gluten-free oats, Himalayan pink salt.",
        nutrition: {
          caloriesKcal100g: 25,
          sugarsG100g: 0.4,
          saturatedFatG100g: 0.1,
          sodiumMg100g: 45,
          fiberG100g: 0.4,
          proteinG100g: 1.2,
          fruitsVegNutsPct: 0,
          isOrganic: true,
          isWholeFood: false,
        },
      },
    ],
  },
  {
    match: /^(?!.*\b(creamer|chocolate)\b).*\b(soy\s*(?:milk|beverage|drink)|soymilk|silk\s+(?:original\s+|unsweetened\s+|vanilla\s+|organic\s+)?soy|westsoy|edensoy)\b/i,
    alts: [
      {
        category: "Butter/Dairy",
        brand: "Edensoy",
        name: "Organic Unsweetened Soymilk",
        sourceUrl: "https://store.edenfoods.com/edensoy-unsweetened-organic/",
        verifiedAt: "2026-11-10",
        size: "32 fl oz carton",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Purified water, organic soybeans.",
        nutrition: {
          caloriesKcal100g: 37.5,
          sugarsG100g: 0.4,
          saturatedFatG100g: 0.4,
          sodiumMg100g: 12.5,
          fiberG100g: 0.8,
          proteinG100g: 4.2,
          fruitsVegNutsPct: 0,
          isOrganic: true,
          isWholeFood: false,
        },
      },
    ],
  },
  {
    match: /^(?!.*\b(creamer|chocolate)\b).*\b(almond\s*(?:milk|beverage)|almondmilk|almond\s+breeze|silk\s+almond|califia.*almond|malk.*almond)\b/i,
    alts: [
      {
        category: "Butter/Dairy",
        brand: "MALK",
        name: "Organic Unsweetened Almond Milk",
        sourceUrl: "https://malkorganics.com/products/unsweetened-almond-malk/",
        verifiedAt: "2026-11-09",
        size: "28 fl oz bottle",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Filtered water, organic sprouted almonds, Himalayan pink salt.",
        nutrition: {
          caloriesKcal100g: 25,
          sugarsG100g: 0,
          saturatedFatG100g: 0.1,
          sodiumMg100g: 45,
          fiberG100g: 0.4,
          proteinG100g: 1.2,
          fruitsVegNutsPct: 15,
          isOrganic: true,
          isWholeFood: false,
        },
      },
    ],
  },
  {
    match: STORE_DAIRY_WHOLE_MILK_MATCH,
    alts: [
      {
        category: "Butter/Dairy",
        brand: "Organic Valley",
        name: "Organic Grassmilk Whole Milk",
        sourceUrl: "https://www.organicvalley.coop/products/milk/grassmilk/grassmilk-whole-half-gallon/",
        verifiedAt: "2026-11-09",
        size: "64 fl oz carton",
        isOrganic: true,
        image: "/swaps/milk.png",
        ingredients: "Organic Grade A whole milk, vitamin D3.",
      },
    ],
  },
  {
    match: /\b(tortillas?|wraps?|mission\s+flour|mission\s+carb|guerrero)\b/i,
    alts: [
      {
        category: "Bread",
        brand: "Food For Life",
        name: "Ezekiel 4:9 Organic Sprouted Whole Grain Tortillas",
        sourceUrl: "https://www.foodforlife.com/product/tortillas/ezekiel-49-sprouted-whole-grain-tortillas",
        verifiedAt: "2026-11-10",
        size: "12 oz pack (6 tortillas)",
        isOrganic: true,
        image: "/swaps/tortillas.png",
        ingredients: "Organic sprouted wheat, filtered water, organic sesame seeds, organic sprouted soybeans, organic sprouted barley, organic sprouted millet, organic sprouted lentils, organic sprouted spelt, sea salt.",
      },
      {
        category: "Bread",
        brand: "Siete",
        name: "Almond Flour Grain Free Tortillas",
        sourceUrl: "https://sietefoods.com/products/almond-flour-tortillas",
        verifiedAt: "2026-11-09",
        size: "7 oz pack (8 tortillas)",
        image: "/swaps/tortillas.png",
        ingredients: "Almond flour, tapioca flour, water, cassava flour, coconut oil, sea salt.",
        itemIds: { walmart: "506938184" },
      },
    ],
  },
  {
    match: /\b(crackers?|cheez|goldfish|triscuit|saltines?|ritz|wheat\s+thins|graham)\b/i,
    alts: [
      {
        category: "Crackers",
        brand: "Lundberg Family Farms",
        name: "Organic Brown Rice Thin Stackers",
        sourceUrl: "https://www.lundberg.com/products/organic-brown-rice-thin-stackers",
        verifiedAt: "2026-11-10",
        size: "5.9 oz box",
        isOrganic: true,
        image: "/swaps/crackers.jpg",
        ingredients: "Organic whole grain brown rice, sea salt.",
      },
    ],
  },
  {
    match: /\b(tortilla\s+chips|doritos|tostitos|takis|fritos|corn\s+chips)\b/i,
    alts: [
      {
        category: "Chips",
        brand: "Siete",
        name: "Grain Free Sea Salt Tortilla Chips",
        sourceUrl: "https://sietefoods.com/products/sea-salt-grain-free-tortilla-chips",
        verifiedAt: "2026-11-09",
        size: "5 oz bag",
        image: "/swaps/chips.jpg",
        ingredients: "Cassava flour, avocado oil, coconut flour, ground chia seed, sea salt.",
      },
    ],
  },
  {
    match: /\b(popcorn|puffs|cheetos)\b/i,
    alts: [
      {
        category: "Chips",
        brand: "LesserEvil",
        name: "Organic Himalayan Pink Salt Popcorn",
        sourceUrl: "https://shop.lesserevil.com/products/himalayan-pink-salt-organic-popcorn",
        verifiedAt: "2026-11-09",
        size: "4.6 oz bag",
        isOrganic: true,
        image: "/swaps/chips.jpg",
        ingredients: "Organic non-GMO popcorn, organic extra virgin coconut oil, Himalayan salt.",
      },
    ],
  },
  {
    match: /\b(cereal|flakes|loops|puffs|cheerios|cinnamon\s+toast|lucky\s+charms|frosted|froot\s+loops|granola)\b/i,
    alts: [
      {
        category: "Cereal",
        brand: "One Degree Organic Foods",
        name: "Organic Sprouted Oat O's",
        sourceUrl: "https://onedegreeorganics.com/products/sprouted-oat-os/",
        verifiedAt: "2026-11-09",
        size: "10 oz box",
        isOrganic: true,
        image: "/swaps/cereal.jpg",
        ingredients: "Organic sprouted whole grain oats, organic coconut palm sugar, organic tapioca syrup, organic oat bran, unrefined salt, tocopherols (vitamin E).",
      },
    ],
  },
  {
    match: /\b(bread|loaf|wonder\s+bread|sara\s+lee|nature'?s\s+own)\b/i,
    alts: [
      {
        category: "Bread",
        brand: "Food For Life",
        name: "Ezekiel 4:9 Organic Sprouted Whole Grain Bread",
        sourceUrl: "https://www.foodforlife.com/product/breads/ezekiel-49-sprouted-whole-grain-bread",
        verifiedAt: "2026-11-09",
        size: "24 oz loaf",
        isOrganic: true,
        image: "/swaps/bread.jpg",
        ingredients: "Organic sprouted wheat, filtered water, organic sprouted barley, organic sprouted millet, organic malted barley, organic sprouted lentils, organic sprouted soybeans, organic sprouted spelt, fresh yeast, organic wheat gluten, sea salt.",
      },
    ],
  },
  {
    match: /\b(earth\s+balance|country\s+crock\s+plant|miyoko(?:'?s)?.*\b(?:butter|spread)\b|plant[- ]?(?:based\s+)?(?:butter|buttery\s+spread)|vegan\s+(?:butter|buttery\s+spread)|dairy[- ]?free\s+(?:butter|buttery\s+spread)|non[- ]?dairy\s+(?:butter|buttery\s+spread))\b/i,
    alts: [
      {
        category: "Butter/Dairy",
        brand: "Miyoko's Creamery",
        name: "Organic Cultured Vegan Butter",
        sourceUrl: "https://www.miyokos.com/products/european-style-plant-milk-butter-salted",
        verifiedAt: "2026-11-11",
        size: "8 oz block",
        isOrganic: true,
        image: "/swaps/butter.jpg",
        ingredients: "Organic coconut oil, filtered water, organic cashew milk (filtered water, organic cashews), organic sunflower lecithin, sea salt, cultures.",
        nutrition: {
          caloriesKcal100g: 714,
          sugarsG100g: 0,
          saturatedFatG100g: 57.1,
          sodiumMg100g: 500,
          fiberG100g: 0,
          proteinG100g: 0,
          fruitsVegNutsPct: 0,
          isOrganic: true,
          isWholeFood: false,
        },
      },
    ],
  },
  {
    match: new RegExp(
      `^(?!.*\\b(${PLANT_OR_DAIRY_FREE_BRAND_OR_TERM_RE})\\b)(?:.*\\b(yogh?urt|skyr|yoplait|dannon|oikos)\\b|(?!.*\\b(creamer|coffee|oat\\s*milk|oatmilk|barista)\\b).*\\bchobani\\b)`,
      "i"
    ),
    alts: [
      {
        category: "Yogurt",
        brand: "Siggi's",
        name: "Simple Ingredient Whole Milk Plain Skyr",
        sourceUrl: "https://siggis.com/product/plain-whole-milk-24oz",
        verifiedAt: "2026-11-09",
        size: "24 oz tub",
        image: "/swaps/yogurt.jpg",
        ingredients: "Pasteurized whole milk, live active cultures.",
      },
    ],
  },
  {
    match: /^(?!.*\b(cereal|puffs?|o'?s)\b).*\b(cookies?|oreos?|chips\s+ahoy|nutter\s+butter|keebler|wafers?|biscuits?)\b/i,
    alts: [
      {
        category: "Snacks",
        brand: "Simple Mills",
        name: "Crunchy Almond Flour Chocolate Chip Cookies",
        size: "5.5 oz box",
        image: "/swaps/cookies.png",
        ingredients: "Nut and seed flour blend (almonds, organic coconut, flaxseeds), tapioca starch, chocolate chips (cane sugar, unsweetened chocolate, cocoa butter), organic coconut sugar, organic coconut oil, arrowroot, vanilla extract, sea salt, baking soda, cream of tartar, rosemary extract.",
        sourceUrl: "https://simplemills.com/Products/Product/Crunchy-Chocolate-Chip-Cookies.aspx",
        verifiedAt: "2026-11-09",
        itemIds: { walmart: "189635069" },
      },
    ],
  },
  {
    match: /\b(soda|cola|pepsi|coca[- ]?cola|coke|sprite|7\s*up|mountain\s+dew|dr\.?\s*pepper|fanta|root\s+beer|ginger\s+ale|sparkling)\b/i,
    alts: [
      {
        category: "Snacks",
        brand: "Spindrift",
        name: "Sparkling Water Lemon",
        sourceUrl: "https://drinkspindrift.com/products/lemon-sparkling-water",
        verifiedAt: "2026-11-09",
        size: "8 pack (12 fl oz cans)",
        image: "/swaps/drink.png",
        ingredients: "Carbonated water, lemon juice.",
      },
      {
        category: "Snacks",
        brand: "Nixie",
        name: "Organic Lime Ginger Sparkling Water",
        sourceUrl: "https://drinknixie.com/products/lime-ginger",
        verifiedAt: "2026-11-09",
        size: "8 pack (12 fl oz cans)",
        isOrganic: true,
        image: "/swaps/drink.png",
        ingredients: "Purified carbonated water, organic lime flavor, organic ginger extract.",
      },
    ],
  },
  {
    match: /\b(ranch|dressing|vinaigrette|caesar)\b/i,
    alts: [
      {
        category: "Dressings",
        brand: "Chosen Foods",
        name: "Classic Ranch Avocado Oil Dressing",
        sourceUrl: "https://chosenfoods.com/products/classic-ranch-dressing",
        verifiedAt: "2026-11-09",
        size: "8 fl oz bottle",
        image: "/swaps/ranch.jpg",
        ingredients: "Avocado oil, water, organic distilled white vinegar, cage-free egg yolk, organic gum acacia, sea salt, organic buttermilk powder, organic onion powder, organic garlic powder, organic dill, organic parsley, organic chives, organic black pepper, organic rosemary extract.",
      },
    ],
  },
  {
    match: /\b(turkey|ham|deli|lunch\s*meat|oscar\s+mayer|hillshire)\b/i,
    alts: [
      {
        category: "Deli Meat",
        brand: "True Story Foods",
        name: "Organic Oven Roasted Turkey Breast",
        sourceUrl: "https://www.truestoryfoods.com/products/organic-oven-roasted-turkey-breast/",
        verifiedAt: "2026-11-09",
        size: "6 oz pack",
        isOrganic: true,
        image: "/swaps/turkey.jpg",
        ingredients: "Organic turkey breast, water, sea salt, organic vinegar.",
      },
    ],
  },
];

export type RetailerId = Store;

const PLANT_OR_DAIRY_FREE_SOURCE_RE = new RegExp(`\\b(${PLANT_MILK_QUALIFIER_RE})\\b`, "i");

const BENIGN_NON_DAIRY_COMPOUNDS_RE =
  /\b(?:(?:coconut|oat|almond|soy|cashew|rice|hemp|pea|flax|macadamia)\s+milk|(?:cocoa|cacao|shea|peanut|almond|cashew|sunflower|seed|apple|pumpkin|fruit|vegan|plant[- ]?(?:based\s+)?)\s*butter|sunbutter|cream\s+of\s+tartar|coconut\s+cream|lactic\s+acid)\b/gi;

function stripBenignNonDairyCompounds(text: string): string {
  return text.replace(BENIGN_NON_DAIRY_COMPOUNDS_RE, " ");
}

function hasMatchedSpecificSwapRule(
  productTitle = "",
  store?: Store,
  preferStoreBrand = false,
  requireOrganic = false
): boolean {
  const title = productTitle.trim();
  if (!title) return false;
  const passesOrganic = (alt: CleanAlternative) =>
    !requireOrganic || alt.isOrganic === true || alt.nutrition?.isOrganic === true;
  if (store) {
    if (preferStoreBrand && store === "walmart") {
      if (WALMART_STORE_BRAND_ALTERNATIVES.some((r) => r.match.test(title) && passesOrganic(r.alt))) return true;
    }
    const storeRules = STORE_SPECIFIC_OVERRIDES[store];
    if (storeRules && storeRules.some((r) => r.match.test(title) && passesOrganic(r.alt))) return true;
  }
  return EXACT_PRODUCT_ALTERNATIVES.some((r) => r.match.test(title) && passesOrganic(r.alt));
}

function evaluateCandidateForSwap(
  alt: CleanAlternative,
  params: {
    score: number;
    productTitle?: string;
    ingredients?: string;
    store: Store;
    watchlist?: Watchlist;
    familyWatchlist?: import("./rubric").Category[];
    dietaryWatchlist?: string[];
    surface: ScanSurface;
    clientPlatform?: ClientPlatform;
    instacartRetailerSlug?: string;
    requireZeroFlags?: boolean;
    requireOrganicUpgrade?: boolean;
  }
): { swap: SwapResult; baseCleanScore: number; flagCount: number } | null {
  const isOrganic = alt.nutrition?.isOrganic ?? alt.isOrganic === true;
  if (params.requireOrganicUpgrade && !isOrganic) return null;

  const baseClean = scoreIngredients(alt.ingredients, params.watchlist, params.familyWatchlist);
  if (baseClean.score < 85) return null;
  if (params.requireZeroFlags && baseClean.flagged.length > 0) return null;

  const fullTitle = formatSwapFullTitle(alt);

  // Enforce explicit household dietary / allergy watchlist (Dairy, Gluten, Nuts, Soy, Egg, Fish, Sesame, High Sodium)
  if (params.dietaryWatchlist && params.dietaryWatchlist.length > 0) {
    const dietaryViolations = evaluateDietaryAlerts(
      params.dietaryWatchlist,
      fullTitle,
      alt.ingredients,
      { ...alt.nutrition, isOrganic }
    );
    if (dietaryViolations.length > 0) return null;
  }

  // Implicit major-allergen introduction guard:
  // Never introduce Peanuts/Tree Nuts, Shellfish/Fish, or Dairy (onto plant-based/non-dairy items)
  // when absent from the scanned product.
  const sourceTitle = params.productTitle || "";
  const sourceIng = params.ingredients || "";
  const sourceAllergens = detectMajorAllergens(sourceTitle, sourceIng);
  const candidateAllergens = detectMajorAllergens(fullTitle, alt.ingredients);

  if (candidateAllergens.has("peanuts_nuts")) {
    if (!sourceAllergens.has("peanuts_nuts")) return null;
    const sourceCombined = `${sourceTitle} ${sourceIng}`;
    const candCombined = `${fullTitle} ${alt.ingredients}`;
    const sourceHasPeanut = /\b(peanuts?|jif|skippy|peter\s+pan|reese'?s|nutter\s+butter)\b/i.test(sourceCombined);
    const sourceHasTreeNut =
      /\b(almonds?|almondmilk|cashews?|cashewmilk|walnuts?|pecans?|hazelnuts?|nutella|pistachios?|macadamia|brazil\s+nuts?|pine\s+nuts?)\b/i.test(
        sourceCombined
      );
    const candHasPeanut = /\bpeanuts?\b/i.test(candCombined) && !/\bpeanut[\s-]*free\b/i.test(fullTitle);
    const candHasTreeNut =
      /\b(almonds?|almondmilk|cashews?|cashewmilk|walnuts?|pecans?|hazelnuts?|pistachios?|macadamia|brazil\s+nuts?|pine\s+nuts?)\b/i.test(
        candCombined
      );
    if (candHasPeanut && !sourceHasPeanut) return null;
    if (candHasTreeNut && !sourceHasTreeNut) return null;
  }
  if (candidateAllergens.has("shellfish_fish") && !sourceAllergens.has("shellfish_fish")) {
    return null;
  }
  if (candidateAllergens.has("dairy") && PLANT_OR_DAIRY_FREE_SOURCE_RE.test(sourceTitle)) {
    return null;
  }

  if (params.productTitle) {
    const normTitle = params.productTitle.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const normBrand = alt.brand.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const coreAltWords = alt.name
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !/^(organic|natural|pure|real|made|with|from|pack|count|original|classic)$/.test(w));
    if (
      normBrand &&
      normTitle.includes(normBrand) &&
      coreAltWords.length > 0 &&
      coreAltWords.every((w) => normTitle.includes(w))
    ) {
      return null;
    }

    const requested = params.productTitle.replace(/\blactaid\b/gi, "lactose-free");
    const variantTitle = (
      (alt.isOrganic === true || alt.nutrition?.isOrganic === true ? "Organic " : "") + fullTitle
    )
      .replace(/\b(organic)\s+\1\b/gi, "$1")
      .trim();
    const isPlainDairyMilk =
      /\bmilk\b/i.test(requested) &&
      !PLANT_OR_DAIRY_FREE_SOURCE_RE.test(requested) &&
      !/\b(chocolate|strawberry|yogurt|yoghurt|ice\s+cream|cheese|butter|condensed|evaporated)\b/i.test(requested);
    const altHasZeroAddedSugar =
      !/\b(sugar|cane\s+sugar|maple\s+syrup|honey|agave|corn\s+syrup|dextrose|fructose|malt\s+syrup|date\s+paste|concentrated\s+.*juice)\b/i.test(
        alt.ingredients
      );
    // A named alternative can have a different flavor or protein amount, but must
    // preserve explicit dietary/formulation restrictions requested by the shopper.
    // ("extra creamy" / "full fat" on plant milks indicate emulsified oil blends being swapped away from, not a dietary restriction.)
    const rawRestrictions =
      requested.match(
        /\b(?:plain|unflavored|unsweetened|zero\s+sugar|sugar[ -]*free|organic|gluten[ -]*free|grain[ -]*free|lactose[ -]*free|skim|nonfat|fat[ -]*free|whole\s+milk)\b|\b[012]\s*%/gi
      ) || [];
    const restrictions = rawRestrictions.filter((tok) => {
      if (/^(?:[012]\s*%|skim|nonfat|fat[ -]*free|whole\s+milk)$/i.test(tok) && !isPlainDairyMilk) {
        return false;
      }
      if (/^plain$/i.test(tok) && PLANT_OR_DAIRY_FREE_SOURCE_RE.test(requested) && altHasZeroAddedSugar) {
        return false;
      }
      if (/^(?:zero\s+sugar|sugar[ -]*free)$/i.test(tok) && altHasZeroAddedSugar && !/\b(soda|cola|pop|energy|drink|tea|lemonade)\b/i.test(requested)) {
        return false;
      }
      return true;
    });
    const guardQuery = restrictions.join(" ") + (isPlainDairyMilk ? " milk" : "");
    if (!passesVariantGuard(guardQuery, variantTitle, { allowCleanerSwap: true })) return null;
    const sanitizedAltTitle = stripBenignNonDairyCompounds(fullTitle);
    const sanitizedAltIng = stripBenignNonDairyCompounds(alt.ingredients);
    const sanitizedAltCombined = `${sanitizedAltTitle} ${sanitizedAltIng}`;
    if (
      (PLANT_OR_DAIRY_FREE_SOURCE_RE.test(requested) || /\b(vegan|dairy[ -]*free|non[ -]*dairy)\b/i.test(requested)) &&
      /\b(milk|cream|whey|casein|butter|cheese|yogh?urt|lactose|ghee|buttermilk|milkfat)\b/i.test(
        sanitizedAltCombined
      )
    ) {
      return null;
    }
    if (
      /\bvegan\b/i.test(requested) &&
      /\b(eggs?|beef|pork|chicken|turkey|fish|gelatin|honey|lard|tallow)\b/i.test(
        sanitizedAltCombined
      )
    ) {
      return null;
    }
  }

  const yukaRes = scoreProductYuka(alt.ingredients, params.watchlist, params.familyWatchlist, {
    ...alt.nutrition,
    productTitle: fullTitle,
    isOrganic,
  });
  const altScore = yukaRes.score;
  if (params.requireOrganicUpgrade ? altScore < params.score : altScore <= params.score) return null;

  const swap: SwapResult = {
    category: alt.category,
    brand: alt.brand,
    name: alt.name,
    title: fullTitle,
    size: alt.size,
    ingredients: alt.ingredients,
    nutrition: { ...alt.nutrition, isOrganic },
    sourceUrl: alt.sourceUrl,
    verifiedAt: alt.verifiedAt,
    image: alt.image.startsWith("https://")
      ? alt.image
      : `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(fullTitle)}&v=4`,
    score: altScore,
    store: params.store,
    isStoreBrand: isStoreBrandForStore(alt.brand, params.store),
    ...buildLinks(
      alt,
      params.store,
      impactClickId(),
      params.surface,
      params.instacartRetailerSlug,
      params.clientPlatform
    ),
  };

  return {
    swap,
    baseCleanScore: baseClean.score,
    flagCount: baseClean.flagged.length,
  };
}

function isPesticideWatchTriggered(
  dietaryWatchlist: string[] | undefined,
  productTitle?: string,
  ingredients?: string,
  nutrition?: NutritionInput,
): { watchActive: boolean; hasPesticideRisk: boolean } {
  const watchActive =
    Array.isArray(dietaryWatchlist) &&
    dietaryWatchlist.some((d) => String(d).trim().toLowerCase() === "pesticide_risk");
  if (!watchActive) return { watchActive: false, hasPesticideRisk: false };
  const hasPesticideRisk = Boolean(detectPesticideRisk(productTitle || "", ingredients || "", nutrition));
  return { watchActive, hasPesticideRisk };
}

const SUBTYPE_INCOMPATIBLE_WITH_CATEGORY_DEFAULT = new RegExp(
  `\\b(soda|cola|pepsi|coke|sprite|mountain\\s+dew|fanta|root\\s+beer|ginger\\s+ale|energy\\s+drink|monster|red\\s*bull|celsius|alani|ghost|c4|gatorade|powerade|juice|lemonade|coffee|frappuccino|tea|water|pre[- ]?workout|protein\\s+(?:shake|powder)|peanut\\s+butter|almond\\s+butter|cashew\\s+butter|sunflower\\s+butter|sunbutter|hazelnut|nutella|jam|jelly|preserves|chocolate|cacao|hershey'?s|reese'?s|snickers|twix|m&m'?s|kit\\s*kat|lindt|ghirardelli|cookies?|oreos?|chips\\s+ahoy|brownies?|cupcakes?|donuts?|doughnuts?|pop[- ]?tarts?|cheese|cheddar|mozzarella|parmesan|gouda|provolone|swiss|velveeta|kraft\\s+singles|american\\s+singles|cream\\s+cheese|sour\\s+cream|cottage\\s+cheese|heavy\\s+cream|whipping\\s+cream|half\\s+and\\s+half|ice\\s+cream|gelato|milk|oat\\s*milk|oatmilk|soymilk|soy\\s*milk|almond\\s*milk|almondmilk|coconutmilk|coconut\\s*milk|cashew\\s*milk|creamer|eggs?|eggnog|soup|chowder|broth|stock|gravy|ketchup|mustard|mayo|mayonnaise|aioli|salsa|marinara|pasta\\s+sauce|bbq|barbecue|guacamole|hummus|tzatziki|ramen|pasta|spaghetti|mac\\s*(?:&|and)\\s*cheese|macaroni|pizza|tortillas?|waffles?|pancakes?|syrup|oatmeal|fries|tater\\s+tots?|hash\\s*browns?|mashed\\s+potato|burger|beyond|impossible|strawberr\\w*|blueberr\\w*|spinach|kale|apples?|grapes?|peaches?|pears?|nectarines?|cherries|peppers?|potatoes?|celery|tomatoes?|green\\s+beans?|chickpeas?|garbanzo|lentils?|flour|${PLANT_OR_DAIRY_FREE_BRAND_OR_TERM_RE})\\b`,
  "i"
);

function isCategoryDefaultAllowed(productTitle = "", category: SwapCategory): boolean {
  const title = productTitle.trim();
  if (!title) return true;
  if (
    PLANT_OR_DAIRY_FREE_SOURCE_RE.test(title) &&
    (category === "Yogurt" || category === "Butter/Dairy" || category === "Deli Meat")
  ) {
    return false;
  }
  if (/\bvegan\b/i.test(title) && category === "Dressings") {
    return false;
  }
  if (
    category === "Yogurt" &&
    /\b(yogh?urt|skyr|kefir)\b/i.test(title) &&
    !/\b(pretzels?|raisins?|bites?|drops?|bars?|covered|coated)\b/i.test(title)
  ) {
    return true;
  }
  if (
    category === "Cereal" &&
    /\b(cereals?|flakes|puffs|granola|muesli|o'?s|crunch)\b/i.test(title) &&
    !/\b(oatmeal|instant\s+oats|bars?|shakes?|powders?)\b/i.test(title)
  ) {
    return true;
  }
  if (
    category === "Chips" &&
    /\b(chips|crisps)\b/i.test(title) &&
    !/\b(chocolate\s+chips?|chips\s+ahoy|cookies?)\b/i.test(title)
  ) {
    return true;
  }
  if (category === "Crackers" && /\bcrackers?\b/i.test(title)) {
    return true;
  }
  if (
    category === "Bread" &&
    /\b(bread|loaf|buns?|rolls?)\b/i.test(title) &&
    !/\b(tortillas?|waffles?|pancakes?|pizza|garlic\s+bread)\b/i.test(title)
  ) {
    return true;
  }
  if (SUBTYPE_INCOMPATIBLE_WITH_CATEGORY_DEFAULT.test(title)) return false;
  return true;
}

/**
 * Returns a reference clean swap when a product scores < 75 (or when pesticide_risk is triggered
 * on a non-organic high-residue crop / conventional grain), else null.
 * The alternative is checked against the deterministic additive rubric (with active watchlist),
 * household dietary/allergen watchlist, and scored with the 3-pillar Yuka rubric.
 */
export function resolveSwap(params: {
  score: number;
  productTitle?: string;
  ingredients?: string;
  nutrition?: NutritionInput;
  store?: Store;
  category?: SwapCategory;
  watchlist?: Watchlist;
  familyWatchlist?: import("./rubric").Category[];
  dietaryWatchlist?: string[];
  surface?: ScanSurface;
  clientPlatform?: ClientPlatform;
  instacartRetailerSlug?: string;
  preferStoreBrand?: boolean;
}): SwapResult | null {
  const { watchActive: pesticideWatchActive, hasPesticideRisk } = isPesticideWatchTriggered(
    params.dietaryWatchlist,
    params.productTitle,
    params.ingredients,
    params.nutrition,
  );
  if (params.score >= 75 && !hasPesticideRisk) return null;
  if (
    params.productTitle &&
    (NON_FOOD_SWAP_GUARD.test(params.productTitle) || ALREADY_PURE_MAPLE_SYRUP_GUARD.test(params.productTitle))
  ) {
    return null;
  }
  const store = params.store && STORES.includes(params.store) ? params.store : "walmart";
  const surface: ScanSurface =
    params.surface === "android" || params.surface === "extension"
      ? params.surface
      : !isAffiliateAllowedOnClient("web", params.clientPlatform)
        ? "extension"
        : "web";
  const requireOrganicUpgrade = params.score >= 75 && hasPesticideRisk;
  const title = (params.productTitle || "").trim();
  const detectedCat = params.category ?? detectCategory(title, params.ingredients);
  const allowCatDefault = isCategoryDefaultAllowed(title, detectedCat);

  const matchedSpecificPrimary = hasMatchedSpecificSwapRule(
    title,
    store,
    Boolean(params.preferStoreBrand),
    pesticideWatchActive
  );
  if (matchedSpecificPrimary || allowCatDefault) {
    const alt = resolveCleanAlternative(
      params.productTitle,
      params.category,
      store,
      Boolean(params.preferStoreBrand),
      pesticideWatchActive
    );
    const evaluated = evaluateCandidateForSwap(alt, {
      score: params.score,
      productTitle: params.productTitle,
      ingredients: params.ingredients,
      store,
      watchlist: params.watchlist,
      familyWatchlist: params.familyWatchlist,
      dietaryWatchlist: params.dietaryWatchlist,
      surface,
      clientPlatform: params.clientPlatform,
      instacartRetailerSlug: params.instacartRetailerSlug,
      requireOrganicUpgrade,
    });
    if (evaluated) return evaluated.swap;
  }

  if (params.preferStoreBrand || (pesticideWatchActive && !requireOrganicUpgrade)) {
    const matchedSpecificFallback = hasMatchedSpecificSwapRule(title, store, false, requireOrganicUpgrade);
    if (matchedSpecificFallback || allowCatDefault) {
      const fallbackAlt = resolveCleanAlternative(
        params.productTitle,
        params.category,
        store,
        false,
        requireOrganicUpgrade
      );
      const fallbackEval = evaluateCandidateForSwap(fallbackAlt, {
        score: params.score,
        productTitle: params.productTitle,
        ingredients: params.ingredients,
        store,
        watchlist: params.watchlist,
        familyWatchlist: params.familyWatchlist,
        dietaryWatchlist: params.dietaryWatchlist,
        surface,
        clientPlatform: params.clientPlatform,
        instacartRetailerSlug: params.instacartRetailerSlug,
        requireOrganicUpgrade,
      });
      if (fallbackEval) return fallbackEval.swap;
    }
  }
  if (params.productTitle) {
    const fallbackPool = resolveSwapCandidates({
      score: params.score,
      productTitle: params.productTitle,
      ingredients: params.ingredients,
      nutrition: params.nutrition,
      category: params.category,
      store,
      watchlist: params.watchlist,
      familyWatchlist: params.familyWatchlist,
      dietaryWatchlist: params.dietaryWatchlist,
      surface,
      clientPlatform: params.clientPlatform,
      instacartRetailerSlug: params.instacartRetailerSlug,
      preferStoreBrand: params.preferStoreBrand,
      limit: 1,
    });
    if (fallbackPool.length > 0) return fallbackPool[0];
  }
  return null;
}

/**
 * Returns ranked clean alternatives (up to `limit ?? 4`) for a product's exact food type,
 * deduplicated by brand + name, passing `passesVariantGuard`, with 0 watchlist & dietary violations,
 * and preserving `instacartRetailerSlug` when shopping inside Instacart.
 */
export function resolveSwapCandidates(params: {
  score: number;
  productTitle: string;
  ingredients?: string;
  nutrition?: NutritionInput;
  category?: SwapCategory;
  store: Store;
  watchlist?: Watchlist;
  familyWatchlist?: import("./rubric").Category[];
  dietaryWatchlist?: string[];
  surface?: ScanSurface;
  clientPlatform?: ClientPlatform;
  instacartRetailerSlug?: string;
  limit?: number;
  preferStoreBrand?: boolean;
}): SwapResult[] {
  const title = (params.productTitle || "").trim();
  const { watchActive: pesticideWatchActive, hasPesticideRisk } = isPesticideWatchTriggered(
    params.dietaryWatchlist,
    title,
    params.ingredients,
    params.nutrition,
  );
  if ((params.score >= 75 && !hasPesticideRisk) || !title) return [];
  if (NON_FOOD_SWAP_GUARD.test(title) || ALREADY_PURE_MAPLE_SYRUP_GUARD.test(title)) {
    return [];
  }

  const store = params.store && STORES.includes(params.store) ? params.store : "walmart";
  const surface: ScanSurface =
    params.surface === "android" || params.surface === "extension"
      ? params.surface
      : !isAffiliateAllowedOnClient("web", params.clientPlatform)
        ? "extension"
        : "web";
  const maxItems = Math.max(1, Math.min(10, params.limit ?? 4));
  const requireOrganicUpgrade = params.score >= 75 && hasPesticideRisk;

  const detectedCat = params.category ?? detectCategory(title, params.ingredients);
  const allowCatDefault = isCategoryDefaultAllowed(title, detectedCat);
  const matchedSpecificPrimary = hasMatchedSpecificSwapRule(
    title,
    store,
    Boolean(params.preferStoreBrand),
    pesticideWatchActive
  );
  const primaryAltKey =
    matchedSpecificPrimary || allowCatDefault
      ? formatSwapFullTitle(
          resolveCleanAlternative(title, params.category, store, Boolean(params.preferStoreBrand), pesticideWatchActive)
        ).toLowerCase()
      : "";

  const rawPool: Array<{ alt: CleanAlternative; tier: number }> = [];

  // Store-specific 1-for-1 overrides & Walmart private-label budget picks:
  // When `preferStoreBrand` is false, Walmart private-label sits at tier 0.9 (behind national primary/category
  // picks at tier >= 1 so `#switch-to-store-brand-swap` is offered); when `preferStoreBrand` is true, tier 4 promotes to #1.
  if (store === "walmart") {
    for (const rule of WALMART_STORE_BRAND_ALTERNATIVES) {
      if (rule.match.test(title)) {
        rawPool.push({ alt: rule.alt, tier: params.preferStoreBrand ? 4 : 0.9 });
      }
    }
  }
  const storeRules = STORE_SPECIFIC_OVERRIDES[store];
  if (storeRules) {
    for (const rule of storeRules) {
      if (rule.match.test(title)) {
        rawPool.push({ alt: rule.alt, tier: params.preferStoreBrand ? 4 : 3 });
      }
    }
  }

  // Tier 2.2: Nationwide 1-for-1 exact product rules
  for (const rule of EXACT_PRODUCT_ALTERNATIVES) {
    if (rule.match.test(title)) {
      rawPool.push({ alt: rule.alt, tier: 2.2 });
    }
  }

  // Tier 2: Secondary curated 1-for-1 clean alternatives for the same food sub-type
  for (const group of SECONDARY_CLEAN_ALTERNATIVES) {
    if (group.match.test(title)) {
      for (const alt of group.alts) {
        rawPool.push({ alt, tier: 2 });
      }
    }
  }

  // Tier 1: Category clean default only if the food sub-type & dietary profile align
  // (never suggest Fruit Bars for Cheese/Chocolate/Soda or cow's Dairy for Plant-Based items)
  if (allowCatDefault) {
    rawPool.push({ alt: CLEAN_ALTERNATIVES[detectedCat], tier: 1 });
  }

  const seen = new Set<string>();
  const evaluated: Array<{ swap: SwapResult; tier: number; isPrimary: boolean }> = [];

  for (const entry of rawPool) {
    const key = formatSwapFullTitle(entry.alt).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const res = evaluateCandidateForSwap(entry.alt, {
      score: params.score,
      productTitle: title,
      ingredients: params.ingredients,
      store,
      watchlist: params.watchlist,
      familyWatchlist: params.familyWatchlist,
      dietaryWatchlist: params.dietaryWatchlist,
      surface,
      clientPlatform: params.clientPlatform,
      instacartRetailerSlug: params.instacartRetailerSlug,
      requireZeroFlags: true,
      requireOrganicUpgrade,
    });
    if (res) {
      evaluated.push({ swap: res.swap, tier: entry.tier, isPrimary: key === primaryAltKey });
    }
  }

  // Prefer Yuka >= 85 candidates (plus the primary 1-for-1 clean match & verified 0-flag store-brand picks);
  // fall back to clean-additive (>=85 ingredient rubric) 1-for-1 swaps where Nutri-Score caps energy-dense foods < 85.
  const highYuka = evaluated.filter((e) => e.swap.score >= 85 || e.isPrimary || e.swap.isStoreBrand);
  const pool = highYuka.length > 0 ? highYuka : evaluated;

  pool.sort((a, b) => {
    if (pesticideWatchActive) {
      const aOrg = Boolean(a.swap.nutrition?.isOrganic);
      const bOrg = Boolean(b.swap.nutrition?.isOrganic);
      if (aOrg !== bOrg) return bOrg ? 1 : -1;
    }
    if (params.preferStoreBrand && Boolean(b.swap.isStoreBrand) !== Boolean(a.swap.isStoreBrand)) {
      return b.swap.isStoreBrand ? 1 : -1;
    }
    if (b.tier !== a.tier) return b.tier - a.tier;
    return b.swap.score - a.swap.score;
  });

  return pool.slice(0, maxItems).map((e) => e.swap);
}



