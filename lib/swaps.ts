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
import { scoreIngredients, scoreProductYuka, type Watchlist } from "./rubric";

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
  size?: string;
  ingredients: string;
  searchQuery: string;
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
    name: "Organic Pasture-Raised Salted Butter",
    size: "16 oz (4 sticks)",
    price: 6.98,
    image: "/swaps/butter.jpg",
    ingredients: "Organic pasteurized sweet cream, salt.",
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

/**
 * 1-for-1 exact sub-category swap table: ensures butter swaps to butter, milk swaps to milk,
 * cheese swaps to cheese, bacon swaps to bacon, tortilla chips swap to tortilla chips, etc.
 */
export const EXACT_PRODUCT_ALTERNATIVES: { match: RegExp; alt: CleanAlternative }[] = [
  // --- Butter / Margarine / Spreads (1-for-1 Butter, excluding nut/fruit/cookie butters) ---
  {
    match: /^(?!.*\b(peanut|almond|cashew|sunflower|sun|cookie|apple|cocoa|shea|body)\s+butter\b).*\b(unsalted\s+butter|butter\s+unsalted)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Pasture-Raised Unsalted Butter",
      size: "16 oz (4 sticks)",
      price: 6.98,
      image: "/swaps/butter.jpg",
      ingredients: "Organic pasteurized sweet cream, microbial culture.",
    },
  },
  {
    match: /^(?!.*\b(peanut|almond|cashew|sunflower|sun|cookie|apple|cocoa|shea|body|butter\s+milk|buttermilk|butter\s+pecan|butter\s+lettuce|butter\s+beans?)\b).*\b(butter|margarine|buttery spread|country crock|imperial|blue bonnet|parkay|smart balance|earth balance|i can'?t believe it'?s not butter|kerrygold|land o'? ?lakes)\b/i,
    alt: CLEAN_ALTERNATIVES["Butter/Dairy"],
  },

  // --- Milk (1-for-1 Milk: Chocolate, 2%, Whole/Skim/Lactose-Free, Plant Milks) ---
  {
    match: /\b(chocolate\s+milk|fairlife\s+chocolate|nesquik|ooey\s+gooey.*milk|trumu)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Grassmilk Lowfat Chocolate Milk",
      size: "64 oz carton",
      price: 6.48,
      image: "/swaps/milk.png",
      ingredients: "Organic Grade A lowfat milk, organic fair trade cane sugar, organic fair trade cocoa, organic vanilla, salt, vitamin A palmitate, vitamin D3.",
    },
  },
  {
    match: /\b(oat\s*milk|planet\s+oat|oatly|chobani\s+oat)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "MALK",
      name: "Organic Unsweetened Oat Milk",
      size: "28 fl oz bottle",
      price: 5.99,
      image: "/swaps/milk.png",
      ingredients: "Filtered water, organic gluten-free oats, Himalayan pink salt.",
    },
  },
  {
    match: /\b(almond\s*milk|almond\s+breeze|silk\s+almond)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "MALK",
      name: "Organic Unsweetened Almond Milk",
      size: "28 fl oz bottle",
      price: 5.99,
      image: "/swaps/milk.png",
      ingredients: "Filtered water, organic sprouted almonds, Himalayan pink salt.",
    },
  },
  {
    match: /\b(2%\s*(reduced\s*fat\s*)?milk|reduced\s*fat\s*milk)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Grassmilk 2% Reduced Fat Milk",
      size: "64 oz carton",
      price: 6.28,
      image: "/swaps/milk.png",
      ingredients: "Organic Grade A reduced fat milk, vitamin A palmitate, vitamin D3.",
    },
  },
  {
    match: /^(?!.*\b(milk\s+chocolate|coconut\s+milk)\b).*\b(whole\s+milk|vitamin\s+d\s+milk|1%\s*milk|lowfat\s+milk|skim\s+milk|fat\s*free\s+milk|milk\s*gallon|gallon\s*milk|lactaid|fairlife|horizon.*milk|great\s+value.*milk)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic 100% Grassmilk Whole Milk",
      size: "64 oz carton",
      price: 6.28,
      image: "/swaps/milk.png",
      ingredients: "Organic Grade A whole milk, vitamin D3.",
    },
  },

  // --- Creamer, Heavy Cream, Half & Half, Sour Cream, Cottage Cheese, Cream Cheese ---
  {
    match: /\b(creamer|coffee-?mate|international\s+delight|starbucks\s+creamer|dunkin.*creamer)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Sweet Cream Coffee Creamer",
      size: "28 fl oz bottle",
      price: 5.49,
      image: "/swaps/milk.png",
      ingredients: "Organic milk, organic cream, organic fair trade cane sugar, organic vanilla extract.",
    },
  },
  {
    match: /\b(heavy\s+cream|whipping\s+cream|whipped\s+cream|whipped\s+topping|cool\s+whip|reddi-?wip)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Heavy Whipping Cream",
      size: "16 fl oz carton",
      price: 5.49,
      image: "/swaps/milk.png",
      ingredients: "Organic Grade A pasteurized heavy cream.",
    },
  },
  {
    match: /\b(half\s+and\s+half|half\s*&\s*half)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Half & Half",
      size: "32 fl oz carton",
      price: 4.99,
      image: "/swaps/milk.png",
      ingredients: "Organic Grade A milk, organic Grade A cream.",
    },
  },
  {
    match: /\b(sour\s+cream|daisy\s+sour\s+cream)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Cultured Sour Cream",
      size: "16 oz tub",
      price: 4.49,
      image: "/swaps/milk.png",
      ingredients: "Organic cultured pasteurized Grade A cream, organic nonfat milk, microbial enzyme.",
    },
  },
  {
    match: /\b(cottage\s+cheese)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Good Culture",
      name: "Organic Whole Milk Classic Cottage Cheese",
      size: "16 oz tub",
      price: 4.99,
      image: "/swaps/cheese.png",
      ingredients: "Organic skim milk, organic whole milk, organic cream, Celtic sea salt, live and active cultures.",
    },
  },
  {
    match: /\b(cream\s+cheese|philadelphia|neufchatel)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Cream Cheese",
      size: "8 oz block",
      price: 4.49,
      image: "/swaps/cheese.png",
      ingredients: "Organic pasteurized milk and cream, cheese culture, salt.",
    },
  },

  // --- Cheese, Eggs, Ice Cream ---
  {
    match: /\b(string\s+cheese|mozzarella|babybel)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Mozzarella Stringles String Cheese",
      size: "6 oz pack",
      price: 5.49,
      image: "/swaps/cheese.png",
      ingredients: "Organic pasteurized part-skim milk, cheese cultures, sea salt, vegetarian enzymes.",
    },
  },
  {
    match: /^(?!.*\b(mac.*cheese|macaroni|crackers?|cheetos|doritos|cheez-?it|puffs|bagels?|pizza|pretzels?)\b).*\b(cheese|cheddar|velveeta|kraft\s+singles|american\s+singles|queso|colby|monterey\s+jack|swiss|provolone|gouda|parmesan|sargento|tillamook)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Raw Sharp Cheddar Cheese",
      size: "8 oz block",
      price: 5.99,
      image: "/swaps/cheese.png",
      ingredients: "Organic unpasteurized cultured milk, salt, vegetarian enzyme.",
    },
  },
  {
    match: /\b(eggnog|egg\s+nog)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Organic Valley",
      name: "Organic Classic Eggnog",
      size: "32 fl oz carton",
      price: 5.49,
      image: "/swaps/milk.png",
      ingredients: "Organic Grade A milk, organic Grade A cream, organic cane sugar, organic egg yolks, organic vanilla extract, organic nutmeg.",
    },
  },
  {
    match: /\b(eggs?|egg\s+whites?|egg\s+beaters)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Vital Farms",
      name: "Pasture-Raised Organic Large Eggs",
      size: "12 count carton",
      price: 6.99,
      image: "/swaps/eggs.png",
      ingredients: "Organic pasture-raised shell eggs.",
    },
  },
  {
    match: /\b(ice\s+cream|gelato|sorbet|popsicle|outshine|fudge\s+bar|drumstick|klondike|ben\s*&\s*jerry|talenti|breyers|blue\s+bell|edys|halo\s+top|sundae\s+shoppe|haagen-?dazs|häagen-?dazs)\b/i,
    alt: {
      category: "Butter/Dairy",
      brand: "Alec's Ice Cream",
      name: "Organic Tahitian Vanilla Bean Ice Cream",
      size: "14 oz pint",
      price: 6.99,
      image: "/swaps/icecream.png",
      ingredients: "Organic cream, organic skim milk, organic cane sugar, organic egg yolks, organic vanilla extract, organic vanilla bean specks.",
    },
  },

  // --- Nut Butters, Hazelnut Spread & Jam/Jelly ---
  {
    match: /\b(nutella|hazelnut\s+spread)\b/i,
    alt: {
      category: "Snacks",
      brand: "Artisana Organics",
      name: "Organic Hazelnut Cacao Spread",
      size: "8 oz jar",
      price: 8.99,
      image: "/swaps/peanutbutter.png",
      ingredients: "Organic hazelnuts, organic coconut sugar, organic cacao powder, organic coconut oil, organic vanilla extract.",
    },
  },
  {
    match: /\b(peanut\s+butter|almond\s+butter|cashew\s+butter|sunflower\s+butter|sunbutter|jif|skippy|peter\s+pan)\b/i,
    alt: {
      category: "Snacks",
      brand: "Santa Cruz Organic",
      name: "Organic Creamy Dark Roasted Peanut Butter",
      size: "16 oz jar",
      price: 6.49,
      image: "/swaps/peanutbutter.png",
      ingredients: "Organic roasted peanuts, salt.",
    },
  },
  {
    match: /\b(jam|jelly|preserves|marmalade|fruit\s+spread|smucker'?s|welch'?s\s+grape)\b/i,
    alt: {
      category: "Snacks",
      brand: "Crofter's Organic",
      name: "Organic Strawberry Just Fruit Spread",
      size: "16.5 oz jar",
      price: 5.29,
      image: "/swaps/jam.png",
      ingredients: "Organic strawberries, organic concentrated white grape juice, natural apple pectin, ascorbic acid.",
    },
  },

  // --- Crackers ---
  {
    match: /\b(cheez-?it|goldfish|cheddar\s+crackers?|cheese\s+crackers?)\b/i,
    alt: {
      category: "Crackers",
      brand: "Simple Mills",
      name: "Organic Seed & Nut Flour Cheddar Crackers",
      size: "4.25 oz box",
      price: 4.99,
      image: "/swaps/crackers.jpg",
      ingredients: "Organic cassava flour, organic cheddar cheese (organic cultured milk, salt, enzymes), organic coconut oil, organic chia seeds, sea salt, organic paprika.",
    },
  },
  {
    match: /\b(graham\s+crackers?|honey\s+maid)\b/i,
    alt: {
      category: "Crackers",
      brand: "Annie's Homegrown",
      name: "Organic Honey Graham Crackers",
      size: "14.4 oz box",
      price: 5.29,
      image: "/swaps/crackers.jpg",
      ingredients: "Organic whole grain wheat flour, organic cane sugar, organic expeller-pressed coconut oil, organic honey, baking soda, sea salt.",
    },
  },

  // --- Instant Mashed Potatoes & Crispy Fried Onions ---
  {
    match: /\b(instant\s+mashed|mashed\s+potato(?:es)?|potato\s+flakes?|idahoan|betty\s+crocker.*potato(?:es)?|hungry\s+jack.*potato(?:es)?)\b/i,
    alt: {
      category: "Snacks",
      brand: "USDA Organic",
      name: "Organic Whole Yukon Gold Potatoes",
      size: "3 lb bag",
      price: 4.98,
      image: "/swaps/produce.png",
      ingredients: "100% organic whole Yukon Gold potatoes.",
    },
  },
  {
    match: /\b((?:crispy\s+)?fried\s+onions?|crispy\s+onions?|french'?s.*onions?|onion\s+rings?)\b/i,
    alt: {
      category: "Snacks",
      brand: "USDA Organic",
      name: "Organic Fresh Yellow Onions",
      size: "3 lb bag",
      price: 3.98,
      image: "/swaps/produce.png",
      ingredients: "100% organic fresh yellow onions.",
    },
  },

  // --- Chips, Pretzels, Popcorn, Cheese Puffs ---
  {
    match: /\b(tortilla\s+chips?|corn\s+chips?|doritos|tostitos|fritos|takis|santitas|mission\s+strips)\b/i,
    alt: {
      category: "Chips",
      brand: "Siete",
      name: "Grain Free Sea Salt Tortilla Chips with Avocado Oil",
      size: "5 oz bag",
      price: 4.79,
      image: "/swaps/chips.jpg",
      ingredients: "Cassava flour, avocado oil, coconut flour, ground chia seed, sea salt.",
    },
  },
  {
    match: /^(?!.*\b(cereal|breakfast|marshmallow|cocoa|oreo|reese|wheat|rice|kamut|oat|candy|peppermint|pastry|pastries)\b).*\b(cheetos|cheese\s+puffs?|puffs|pirate'?s\s+booty|funyuns)\b/i,
    alt: {
      category: "Chips",
      brand: "LesserEvil",
      name: "Organic Cheddar Space Balls",
      size: "5 oz bag",
      price: 3.99,
      image: "/swaps/chips.jpg",
      ingredients: "Organic non-GMO cornmeal, organic avocado oil, organic cheddar cheese, sea salt.",
    },
  },
  {
    match: /\b(pretzels?|rold\s+gold|snyder'?s|utz\s+pretzels?)\b/i,
    alt: {
      category: "Chips",
      brand: "Quinn",
      name: "Organic Whole Grain Sea Salt Pretzels",
      size: "7 oz bag",
      price: 4.79,
      image: "/swaps/chips.jpg",
      ingredients: "Organic whole grain sorghum flour, organic brown rice flour, organic cassava flour, organic coconut oil, sea salt.",
    },
  },
  {
    match: /\b(popcorn|smartfood|skinny\s*pop|boomchickapop|act\s+ii|orville)\b/i,
    alt: {
      category: "Chips",
      brand: "LesserEvil",
      name: "Organic Himalayan Pink Salt Coconut Oil Popcorn",
      size: "4.6 oz bag",
      price: 3.98,
      image: "/swaps/chips.jpg",
      ingredients: "Organic non-GMO popcorn, organic extra virgin coconut oil, Himalayan pink salt.",
    },
  },

  // --- Cereal, Oatmeal, Granola, Maple Syrup ---
  {
    match: /\b(oatmeal|rolled\s+oats|steel\s+cut\s+oats|instant\s+oats|quaker\s+oats)\b/i,
    alt: {
      category: "Cereal",
      brand: "One Degree Organic Foods",
      name: "Organic Sprouted Rolled Oats",
      size: "24 oz bag",
      price: 5.99,
      image: "/swaps/oats.png",
      ingredients: "Organic sprouted whole grain oats.",
    },
  },
  {
    match: /\b(granola)\b/i,
    alt: {
      category: "Cereal",
      brand: "Purely Elizabeth",
      name: "Organic Original Ancient Grain Granola",
      size: "12 oz bag",
      price: 5.98,
      image: "/swaps/oats.png",
      ingredients: "Organic gluten-free oats, organic coconut sugar, organic raw virgin coconut oil, organic puffed amaranth, organic quinoa flakes, organic chia seeds, organic cinnamon, sea salt.",
    },
  },
  {
    match: /\b(syrup|mrs\.?\s*butterworth|pearl\s+milling|log\s+cabin|aunt\s+jemima)\b/i,
    alt: {
      category: "Cereal",
      brand: "Crown Maple",
      name: "Organic 100% Pure Grade A Amber Maple Syrup",
      size: "12 fl oz bottle",
      price: 7.98,
      image: "/swaps/syrup.png",
      ingredients: "100% pure organic maple syrup.",
    },
  },
  {
    match: /\b(clam\s+chowder|chowder|soup|bisque|stew|chili|campbell'?s|progresso)\b/i,
    alt: {
      category: "Dressings",
      brand: "Amy's Organic",
      name: "Organic Low Fat Lentil Vegetable Soup",
      size: "14.5 oz can",
      price: 3.49,
      image: "/swaps/soup.png",
      ingredients: "Filtered water, organic onions, organic carrots, organic lentils, organic celery, organic potatoes, organic tomatoes, organic spinach, organic extra virgin olive oil, sea salt, organic garlic, organic bay leaf.",
    },
  },

  // --- Dressings, Condiments, Sauces & Broth ---
  {
    match: /\b(gravy|broth|stock|bouillon)\b/i,
    alt: {
      category: "Dressings",
      brand: "Kettle & Fire",
      name: "Organic Turkey Bone Broth",
      size: "16.9 oz carton",
      price: 6.49,
      image: "/swaps/broth.png",
      ingredients: "Organic turkey bone broth (water, organic turkey bones, organic onions, organic carrots, organic celery), organic apple cider vinegar, sea salt, organic rosemary, organic sage, organic thyme, organic black pepper.",
    },
  },
  {
    match: /\b(mayo|mayonnaise|miracle\s+whip|hellmann'?s|best\s+foods|duke'?s|aioli)\b/i,
    alt: {
      category: "Dressings",
      brand: "Primal Kitchen",
      name: "Real Mayonnaise Made with Avocado Oil",
      size: "12 oz jar",
      price: 7.98,
      image: "/swaps/mayo.png",
      ingredients: "Avocado oil, organic eggs, organic egg yolks, organic vinegar, sea salt, organic rosemary extract.",
    },
  },
  {
    match: /\b(ketchup|catsup|heinz\s+tomato\s+ketchup)\b/i,
    alt: {
      category: "Dressings",
      brand: "Primal Kitchen",
      name: "Organic Unsweetened Ketchup",
      size: "11.3 oz bottle",
      price: 4.98,
      image: "/swaps/ketchup.png",
      ingredients: "Organic tomato concentrate, organic balsamic vinegar, salt, organic onion powder, organic garlic powder, organic spices.",
    },
  },
  {
    match: /^(?!.*\b(onions?|fried|crispy)\b).*\b(mustard|french'?s|grey\s+poupon)\b/i,
    alt: {
      category: "Dressings",
      brand: "Annie's Homegrown",
      name: "Organic Yellow Mustard",
      size: "9 oz bottle",
      price: 3.29,
      image: "/swaps/mustard.png",
      ingredients: "Organic distilled white vinegar, water, organic mustard seed, sea salt, organic turmeric, organic paprika, organic cloves.",
    },
  },
  {
    match: /\b(bbq|barbecue|sweet\s+baby\s+ray'?s|kc\s+masterpiece|bull'?s-?eye)\b/i,
    alt: {
      category: "Dressings",
      brand: "Primal Kitchen",
      name: "Organic Unsweetened Classic BBQ Sauce",
      size: "8.5 oz bottle",
      price: 5.49,
      image: "/swaps/bbq.png",
      ingredients: "Organic tomato puree, organic date paste, organic apple cider vinegar, organic yellow mustard, sea salt, organic black pepper, organic onion powder, organic garlic powder.",
    },
  },
  {
    match: /\b(marinara|pasta\s+sauce|spaghetti\s+sauce|tomato\s+sauce|alfredo|vodka\s+sauce|prego|ragu|bertolli|classico)\b/i,
    alt: {
      category: "Dressings",
      brand: "Rao's Homemade",
      name: "Marinara Pasta Sauce",
      size: "24 oz jar",
      price: 6.88,
      image: "/swaps/marinara.png",
      ingredients: "Italian whole peeled tomatoes, olive oil, onions, salt, garlic, basil, black pepper, oregano.",
    },
  },
  {
    match: /\b(salsa|picante|pace|herdez)\b/i,
    alt: {
      category: "Dressings",
      brand: "Mateo's",
      name: "Gourmet Medium Salsa",
      size: "16 oz jar",
      price: 4.98,
      image: "/swaps/salsa.png",
      ingredients: "Tomatoes, water, jalapeno peppers, dehydrated garlic, salt, cilantro, red wine vinegar, spices, lemon juice.",
    },
  },

  // --- Deli Meat, Bacon, Hot Dogs, Sausage, Nuggets, Meat ---
  {
    match: /\b(bacon)\b/i,
    alt: {
      category: "Deli Meat",
      brand: "Applegate Organics",
      name: "Organic No Sugar Uncured Sunday Bacon",
      size: "8 oz pack",
      price: 7.49,
      image: "/swaps/bacon.png",
      ingredients: "Organic pork, water, sea salt, organic rosemary extract.",
    },
  },
  {
    match: /\b(hot\s*dogs?|franks?|frankfurters?|wieners?|oscar\s+mayer\s+wieners?|ball\s+park|hebrew\s+national|nathan'?s)\b/i,
    alt: {
      category: "Deli Meat",
      brand: "Applegate Organics",
      name: "Organic Uncured Grass-Fed Beef Hot Dog",
      size: "10 oz pack",
      price: 6.99,
      image: "/swaps/hotdog.png",
      ingredients: "Organic grass-fed beef, water, sea salt, organic spices, organic garlic powder, organic onion powder, organic paprika, lactic acid starter culture.",
    },
  },
  {
    match: /\b(sausages?|kielbasa|bratwurst|chorizo|jimmy\s+dean|hillshire\s+farm|johnsonville|eckrich)\b/i,
    alt: {
      category: "Deli Meat",
      brand: "Applegate Organics",
      name: "Organic Chicken & Maple Breakfast Sausage",
      size: "7 oz pack",
      price: 5.99,
      image: "/swaps/sausage.png",
      ingredients: "Organic chicken, water, organic maple syrup, sea salt, organic spices.",
    },
  },
  {
    match: /\b(nuggets?|tenders?|chicken\s+patties|chicken\s+strips|popcorn\s+chicken|tyson)\b/i,
    alt: {
      category: "Deli Meat",
      brand: "Applegate Organics",
      name: "Organic Gluten-Free Chicken Nuggets",
      size: "8 oz box",
      price: 6.99,
      image: "/swaps/nuggets.png",
      ingredients: "Organic chicken breast, water, organic rice flour, organic yellow corn flour, sea salt, organic expeller-pressed coconut oil, organic onion powder, organic garlic powder.",
    },
  },
  {
    match: /\b(ham)\b/i,
    alt: {
      category: "Deli Meat",
      brand: "Applegate Organics",
      name: "Organic Uncured Black Forest Ham",
      size: "6 oz pack",
      price: 6.49,
      image: "/swaps/turkey.jpg",
      ingredients: "Organic pork, water, organic honey, sea salt, organic rosemary extract.",
    },
  },
  {
    match: /\b(salami|pepperoni|bologna)\b/i,
    alt: {
      category: "Deli Meat",
      brand: "Applegate Organics",
      name: "Organic Uncured Genoa Salami",
      size: "4 oz pack",
      price: 6.29,
      image: "/swaps/turkey.jpg",
      ingredients: "Organic pork, sea salt, organic cane sugar, organic spices, organic garlic, lactic acid starter culture, organic rosemary extract.",
    },
  },
  {
    match: /\b(roast\s+beef|ground\s+beef|beef\s+patties|burger\s+patties|steak|sirloin|ribeye)\b/i,
    alt: {
      category: "Deli Meat",
      brand: "Applegate Organics",
      name: "Organic Uncured Roast Beef",
      size: "6 oz pack",
      price: 6.99,
      image: "/swaps/turkey.jpg",
      ingredients: "Organic grass-fed beef, water, sea salt, organic black pepper, organic garlic powder.",
    },
  },

  // --- Bread, Bagels, Tortillas, Buns, Waffles, Pasta, Mac & Cheese, Pizza ---
  {
    match: /\b(mac\s*(&|and)\s*cheese|macaroni\s*(&|and)\s*cheese|kraft\s+mac|velveeta\s+shells)\b/i,
    alt: {
      category: "Bread",
      brand: "Annie's Homegrown",
      name: "Organic Grass-Fed Shells & Real Aged Cheddar",
      size: "6 oz box",
      price: 2.98,
      image: "/swaps/mac.png",
      ingredients: "Organic wheat pasta, organic cheddar cheese (cultured pasteurized organic milk, salt, non-animal enzymes), organic whey, organic nonfat milk, salt.",
    },
  },
  {
    match: /\b(tortillas?|wraps?|mission\s+flour|mission\s+carb|guerrero)\b/i,
    alt: {
      category: "Bread",
      brand: "Siete",
      name: "Almond Flour Grain Free Tortillas",
      size: "7 oz pack (8 tortillas)",
      price: 6.98,
      image: "/swaps/tortillas.png",
      ingredients: "Almond flour, tapioca flour, water, cassava flour, coconut oil, sea salt.",
    },
  },
  {
    match: /\b(bagels?|thomas'?\s+bagels?)\b/i,
    alt: {
      category: "Bread",
      brand: "Dave's Killer Bread",
      name: "Organic Plain Awesome Bagels",
      size: "16.75 oz pack",
      price: 5.98,
      image: "/swaps/bagels.png",
      ingredients: "Organic wheat flour, water, organic whole wheat flour, organic cane sugar, organic cracked wheat, organic quinoa, organic amaranth, yeast, sea salt.",
    },
  },
  {
    match: /^(?!.*\b(cinnamon\s+rolls?|honey\s+buns?|cake\s+rolls?|pumpkin\s+cake\s+rolls?|swiss\s+rolls?)\b).*\b(buns?|rolls?|king'?s\s+hawaiian|hamburger\s+buns?|hot\s+dog\s+buns?)\b/i,
    alt: {
      category: "Bread",
      brand: "Dave's Killer Bread",
      name: "Organic 21 Whole Grains & Seeds Burger Buns",
      size: "16 oz pack (8 buns)",
      price: 6.28,
      image: "/swaps/buns.png",
      ingredients: "Organic whole wheat, water, organic wheat flour, organic cane sugar, organic flax seeds, organic sunflower seeds, organic sesame seeds, yeast, sea salt.",
    },
  },
  {
    match: /\b(waffles?|pancakes?|eggo|krusteaz|bisquick)\b/i,
    alt: {
      category: "Bread",
      brand: "Nature's Path",
      name: "Organic Buckwheat Wildberry Waffles",
      size: "7.4 oz box",
      price: 4.49,
      image: "/swaps/waffles.png",
      ingredients: "Water, organic whole grain wheat flour, organic buckwheat flour, organic wild blueberries, organic coconut oil, organic cane sugar, baking powder, sea salt.",
    },
  },
  {
    match: /\b(pasta|spaghetti|penne|fettuccine|linguine|macaroni|rigatoni|rotini|noodles|ramen|barilla|maruchan|nissin)\b/i,
    alt: {
      category: "Bread",
      brand: "Jovial",
      name: "100% Organic Einkorn Wheat Pasta",
      size: "12 oz box",
      price: 4.49,
      image: "/swaps/pasta.png",
      ingredients: "Organic einkorn wheat flour, water.",
    },
  },
  {
    match: /\b(pizza|digiorno|red\s+baron|totino'?s|hot\s+pockets?|tombstone)\b/i,
    alt: {
      category: "Bread",
      brand: "Amy's Kitchen",
      name: "Organic Margherita Pizza",
      size: "13 oz pizza",
      price: 7.98,
      image: "/swaps/pizza.png",
      ingredients: "Organic wheat flour, filtered water, organic part-skim mozzarella cheese, organic diced tomatoes, organic extra virgin olive oil, organic basil, sea salt, yeast.",
    },
  },

  // --- Snacks, Cookies, Candy, Chocolate, Soda, Sports Drinks, Juice ---
  {
    match: /\b(cookies?|oreos?|chips\s+ahoy|nutter\s+butter|keebler|wafers?|knoppers|biscuits?|biscoff|cake\s+rolls?|swiss\s+rolls?|snack\s+cakes?|little\s+debbie|hostess|twinkies?|cupcakes?|donuts?|doughnuts?|danish|cinnamon\s+rolls?|honey\s+buns?)\b/i,
    alt: {
      category: "Snacks",
      brand: "Simple Mills",
      name: "Crunchy Almond Flour Chocolate Chip Cookies",
      size: "5.5 oz box",
      price: 4.98,
      image: "/swaps/cookies.png",
      ingredients: "Almond flour, organic coconut, tapioca starch, organic coconut sugar, dark chocolate chips (cocoa, coconut sugar, cocoa butter), organic coconut oil, vanilla extract, sea salt, baking soda.",
    },
  },
  {
    match: /\b(gummies|gummy|fruit\s+snacks?|fruit\s+roll|gushers?|welch'?s\s+fruit|haribo|skittles|starburst|sour\s+patch|swedish\s+fish|nerds|twizzlers|candy)\b/i,
    alt: {
      category: "Snacks",
      brand: "That's It.",
      name: "100% Real Fruit Bars (Apple + Strawberry)",
      size: "5 count box",
      price: 5.98,
      image: "/swaps/fruitbar.png",
      ingredients: "Apples, strawberries.",
    },
  },
  {
    match: /\b(chocolate|hershey'?s|reese'?s|snickers|twix|m&m'?s|kit\s*kat|lindt|ghirardelli|kinder|merci|ferrero|brownies?)\b/i,
    alt: {
      category: "Snacks",
      brand: "Hu",
      name: "Simple Organic 70% Dark Chocolate Bar",
      size: "2.1 oz bar",
      price: 4.48,
      image: "/swaps/chocolate.png",
      ingredients: "Organic fair-trade cacao, unrefined organic coconut sugar, organic fair-trade cocoa butter.",
    },
  },
  {
    match: /\b(soda|cola|coca-?cola|coke|pepsi|sprite|dr\.?\s*pepper|mountain\s+dew|fanta|root\s+beer|ginger\s+ale|7up|crush|sunkist)\b/i,
    alt: {
      category: "Snacks",
      brand: "OLIPOP",
      name: "Vintage Cola Prebiotic Soda",
      size: "12 fl oz can",
      price: 2.48,
      image: "/swaps/drink.png",
      ingredients: "Carbonated water, cassava root fiber, chicory root inulin, organic apple juice concentrate, lime juice, cinnamon, vanilla bean.",
    },
  },
  {
    match: /\b(gatorade|powerade|bodyarmor|prime|red\s+bull|monster|celsius|sports\s+drink|energy\s+drink|electrolyte)\b/i,
    alt: {
      category: "Snacks",
      brand: "NOOMA",
      name: "Organic Electrolyte Sports Drink",
      size: "16.9 fl oz carton",
      price: 2.49,
      image: "/swaps/drink.png",
      ingredients: "Filtered water, organic coconut water, Himalayan pink salt, organic mango puree.",
    },
  },
  {
    match: /\b(juice|lemonade|capri\s+sun|kool-?aid|sunnyd|minute\s+maid|tropicana|simply\s+orange|hi-?c|hawaiian\s+punch|fruit\s+punch|pouches)\b/i,
    alt: {
      category: "Snacks",
      brand: "Spindrift",
      name: "Organic Sparkling Water with Real Squeezed Fruit",
      size: "8 pack (12 fl oz cans)",
      price: 5.98,
      image: "/swaps/drink.png",
      ingredients: "Carbonated water, organic strawberry puree, organic lemon juice.",
    },
  },
];

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
  ["Cereal", /\b(cereal|flakes|granola|loops|o's|muesli|oatmeal|cheerios|cinnamon toast|lucky charms|frosted|raisin bran|syrup)\b/i],
  ["Dressings", /\b(gravy|broth|stock|bouillon|dressing|ranch|vinaigrette|mayo|mayonnaise|caesar|aioli|ketchup|mustard|bbq|barbecue|sauce|salsa|marinara)\b/i],
  ["Deli Meat", /\b(turkey|ham|salami|bologna|pepperoni|deli|bacon|hot ?dogs?|franks?|sausages?|kielbasa|lunch ?meat|roast beef|chicken breast|chicken patties|nuggets|tenders|beef|steak|pork)\b/i],
  ["Butter/Dairy", /\b(butter|margarine|spread|milk|eggnog|egg nog|cheese|velveeta|cream|creamer|eggs?|ice cream|gelato|half and half|cottage cheese)\b/i],
  ["Bread", /\b(bread|buns?|rolls?|bagels?|tortillas?|loaf|english muffins?|waffles?|pancakes?|muffins?|croissants?|pasta|noodles|macaroni|pizza|hot pockets?)\b/i],
  ["Snacks", /\b(bars?|cookies?|wafers?|knoppers|storck|merci|kinder|snacks?|gummies|gummy|candy|fruit snacks|pastries|tarts?|oreos?|chocolate|brownies?|soda|cola|juice|drink|gatorade|water|tea|coffee|peanut butter|almond butter|nutella|jam|jelly|cake\s+roll)\b/i],
];

export function detectCategory(productTitle = "", _ingredients = ""): SwapCategory {
  for (const [cat, re] of CATEGORY_KEYWORDS) if (re.test(productTitle)) return cat;
  return "Snacks";
}

/**
 * Resolves the exact 1-for-1 CleanAlternative for a given product title (e.g. butter -> butter,
 * milk -> milk, cheese -> cheese, bacon -> bacon), falling back to the category default.
 */
export function resolveCleanAlternative(productTitle = "", category?: SwapCategory): CleanAlternative {
  const title = productTitle.trim();
  if (title) {
    for (const rule of EXACT_PRODUCT_ALTERNATIVES) {
      if (rule.match.test(title)) {
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
    ""
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
      return (process.env.NEXT_PUBLIC_IMPACT_INSTACART_BASE_URL || process.env.IMPACT_INSTACART_BASE_URL || "").trim();
    default:
      return (process.env.NEXT_PUBLIC_IMPACT_DEFAULT_BASE_URL || process.env.IMPACT_DEFAULT_BASE_URL || "").trim();
  }
}

function withAffiliate(url: string, store: Store, clickId: string): string {
  if (store === "amazon") {
    const tag = amazonPartnerTag();
    if (!tag) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}tag=${encodeURIComponent(tag)}&linkCode=ll2`;
  }
  const redirectBase = impactRedirectBase(store);
  if (redirectBase && url.startsWith("https://")) {
    const baseSep = redirectBase.includes("?") ? "&" : "?";
    const subIdParam = clickId ? `&subId1=${encodeURIComponent(clickId)}` : "";
    return `${redirectBase.replace(/\/+$/, "")}${baseSep}u=${encodeURIComponent(url)}${subIdParam}`;
  }
  return url;
}

/** Concise 2-3 word 1-for-1 search query for grocery stores so native search screens always find in-stock clean matches instead of "0 results". */
function conciseClubQuery(q: string): string {
  const s = q.toLowerCase();
  if (/\b(yukon gold|potatoes)\b/.test(s)) return "Organic Yukon Gold Potatoes";
  if (/\b(yellow onions|fresh yellow onions)\b/.test(s)) return "Organic Yellow Onions";
  if (/\b(spindrift|sparkling water)\b/.test(s)) return "Spindrift Sparkling Water";
  if (/\b(eggnog|egg nog)\b/.test(s)) return "Organic Eggnog";
  if (/\b(soup|chowder|bisque|stew|chili)\b/.test(s)) return "Amy's Organic Soup";
  if (/\b(broth|gravy|stock)\b/.test(s)) return "Organic Broth";
  if (/\b(bacon)\b/.test(s)) return "Applegate Bacon";
  if (/\b(hot dog)\b/.test(s)) return "Organic Hot Dogs";
  if (/\b(sausage)\b/.test(s)) return "Organic Sausage";
  if (/\b(nuggets)\b/.test(s)) return "Organic Chicken Nuggets";
  if (/\b(ham)\b/.test(s)) return "Organic Ham";
  if (/\b(salami)\b/.test(s)) return "Organic Salami";
  if (/\b(roast beef)\b/.test(s)) return "Organic Roast Beef";
  if (/\b(turkey|deli)\b/.test(s)) return "Applegate Organic Turkey";
  if (/\b(yogurt)\b/.test(s)) return "Stonyfield Organic Yogurt";
  if (/\b(graham)\b/.test(s)) return "Organic Graham Crackers";
  if (/\b(cheddar crackers)\b/.test(s)) return "Simple Mills Cheddar Crackers";
  if (/\b(crackers)\b/.test(s)) return "Organic Crackers";
  if (/\b(oats|oatmeal)\b/.test(s)) return "Organic Rolled Oats";
  if (/\b(granola)\b/.test(s)) return "Organic Granola";
  if (/\b(maple syrup)\b/.test(s)) return "Organic Maple Syrup";
  if (/\b(cereal|flakes)\b/.test(s)) return "Organic Cereal";
  if (/\b(tortilla chips)\b/.test(s)) return "Siete Tortilla Chips";
  if (/\b(popcorn)\b/.test(s)) return "Organic Popcorn";
  if (/\b(pretzels)\b/.test(s)) return "Organic Pretzels";
  if (/\b(chips|space balls)\b/.test(s)) return "Avocado Oil Chips";
  if (/\b(peanut butter)\b/.test(s)) return "Organic Peanut Butter";
  if (/\b(hazelnut)\b/.test(s)) return "Organic Hazelnut Spread";
  if (/\b(fruit spread|strawberry)\b/.test(s)) return "Organic Strawberry Spread";
  if (/\b(unsalted butter)\b/.test(s)) return "Organic Unsalted Butter";
  if (/\b(butter)\b/.test(s)) return "Organic Salted Butter";
  if (/\b(creamer)\b/.test(s)) return "Organic Coffee Creamer";
  if (/\b(whipping cream|heavy cream)\b/.test(s)) return "Organic Heavy Cream";
  if (/\b(half & half|half and half)\b/.test(s)) return "Organic Half and Half";
  if (/\b(sour cream)\b/.test(s)) return "Organic Sour Cream";
  if (/\b(cottage cheese)\b/.test(s)) return "Good Culture Cottage Cheese";
  if (/\b(cream cheese)\b/.test(s)) return "Organic Cream Cheese";
  if (/\b(string cheese|stringles)\b/.test(s)) return "Organic String Cheese";
  if (/\b(cheese|cheddar)\b/.test(s)) return "Organic Cheddar Cheese";
  if (/\b(eggs)\b/.test(s)) return "Vital Farms Organic Eggs";
  if (/\b(ice cream)\b/.test(s)) return "Organic Vanilla Ice Cream";
  if (/\b(chocolate milk)\b/.test(s)) return "Organic Chocolate Milk";
  if (/\b(oat milk)\b/.test(s)) return "Organic Oat Milk";
  if (/\b(almond milk)\b/.test(s)) return "Organic Almond Milk";
  if (/\b(2%)\b/.test(s) && /\bmilk\b/.test(s)) return "Organic 2% Milk";
  if (/\b(grassmilk|milk)\b/.test(s)) return "Organic Whole Milk";
  if (/\b(mac|shells & real aged cheddar)\b/.test(s)) return "Annie's Organic Mac and Cheese";
  if (/\b(tortillas)\b/.test(s)) return "Siete Almond Flour Tortillas";
  if (/\b(bagels)\b/.test(s)) return "Organic Bagels";
  if (/\b(buns)\b/.test(s)) return "Organic Burger Buns";
  if (/\b(waffles)\b/.test(s)) return "Organic Waffles";
  if (/\b(pasta|einkorn)\b/.test(s)) return "Organic Pasta";
  if (/\b(pizza)\b/.test(s)) return "Organic Pizza";
  if (/\b(bread|ezekiel|sprouted)\b/.test(s)) return "Ezekiel Sprouted Bread";
  if (/\b(mayonnaise|mayo)\b/.test(s)) return "Primal Kitchen Avocado Oil Mayo";
  if (/\b(ketchup)\b/.test(s)) return "Organic Ketchup";
  if (/\b(mustard)\b/.test(s)) return "Organic Mustard";
  if (/\b(bbq)\b/.test(s)) return "Organic BBQ Sauce";
  if (/\b(marinara|rao)\b/.test(s)) return "Rao's Marinara";
  if (/\b(salsa)\b/.test(s)) return "Mateo's Salsa";
  if (/\b(ranch|dressing)\b/.test(s)) return "Primal Kitchen Ranch";
  if (/\b(cookies)\b/.test(s)) return "Simple Mills Cookies";
  if (/\b(chocolate bar|dark chocolate)\b/.test(s)) return "Organic Dark Chocolate";
  if (/\b(soda|cola|olipop)\b/.test(s)) return "Olipop Soda";
  if (/\b(electrolyte)\b/.test(s)) return "Organic Electrolyte Drink";
  if (/\b(orange juice)\b/.test(s)) return "Organic Orange Juice";
  if (/\b(bar|larabar|lärabar|cashew|fruit bars)\b/.test(s)) return "Larabar Cashew Cookie";
  return q.replace(/['"/\\]+/g, " ").trim().split(/\s+/).slice(0, 3).join(" ");
}

function searchPath(store: Store, q: string): string {
  const concise = conciseClubQuery(q);
  const e = encodeURIComponent(concise);
  switch (store) {
    case "walmart": return `/search?q=${e}`;
    case "instacart": return `/store/s?k=${e}`;
    case "target": return `/s?searchTerm=${e}`;
    case "kroger": return `/search?query=${e}`;
    case "aldi": return `/results?q=${e}`;
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
  const searchQuery = conciseClubQuery(query);
  const id = alt.itemIds?.[store];
  const path = id ? productPath(store, id) : searchPath(store, query);
  const webUrl = withAffiliate(`https://${meta.host}${path}`, store, clickId);
  // Always use HTTPS App Links / Universal Links so native grocery apps preserve Impact/Amazon affiliate params.
  const deepLink = webUrl;
  const androidIntentUrl =
    `intent://${meta.host}${withAffiliate(path, store, clickId)}#Intent;scheme=https;package=${meta.androidPackage};` +
    `S.browser_fallback_url=${encodeURIComponent(webUrl)};end`;
  return { searchQuery, webUrl, deepLink, androidIntentUrl, androidPackage: meta.androidPackage };
}

/**
 * Returns a verified 1-for-1 clean swap when a product scores < 75, else null.
 * The alternative is verified against the deterministic additive rubric (with active watchlist)
 * and scored with the 3-pillar Yuka rubric.
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
  const alt = resolveCleanAlternative(params.productTitle, params.category);
  const category = alt.category;
  const baseClean = scoreIngredients(alt.ingredients, params.watchlist, params.familyWatchlist);
  if (baseClean.score < 90) return null;
  const fullTitle = `${alt.brand} ${alt.name}`;
  const yukaRes = scoreProductYuka(alt.ingredients, params.watchlist, params.familyWatchlist, {
    productTitle: fullTitle,
  });
  const isOrg = /\borganic\b/i.test(`${fullTitle} ${alt.ingredients}`);
  const altScore = Math.max(yukaRes.score, isOrg ? 92 : 90);
  if (altScore <= params.score) return null;
  return {
    category,
    brand: alt.brand,
    name: alt.name,
    title: fullTitle,
    size: alt.size,
    ingredients: alt.ingredients,
    image: alt.image.endsWith(".png")
      ? alt.image
      : `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(fullTitle)}`,
    score: altScore,
    store,
    ...buildLinks(alt, store),
  };
}
