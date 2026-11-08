import { scoreProductYuka, type ScoreResult } from "./rubric";
import { resolveSwap, type SwapResult } from "./swaps";

export interface SeoProductEntry {
  slug: string;
  title: string;
  brand: string;
  category: string;
  searchVolumeTag: string;
  ingredients: string;
}

export const SEO_PRODUCTS: SeoProductEntry[] = [
  {
    slug: "doritos-nacho-cheese",
    title: "Doritos Nacho Cheese Tortilla Chips",
    brand: "Doritos",
    category: "Chips & Snacks",
    searchVolumeTag: "High-Intent Snack Search",
    ingredients:
      "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin (Made from Corn), Salt, Cheddar Cheese (Milk, Cheese Cultures, Salt, Enzymes), Whey, Monosodium Glutamate, Buttermilk, Romano Cheese, Whey Protein Concentrate, Onion Powder, Corn Flour, Natural and Artificial Flavor, Dextrose, Tomato Powder, Lactose, Spices, Artificial Color (Yellow 6, Yellow 5, Red 40), Lactic Acid, Citric Acid, Sugar, Garlic Powder, Skim Milk, Red and Green Bell Pepper Powder, Disodium Inosinate, Disodium Guanylate.",
  },
  {
    slug: "hidden-valley-ranch",
    title: "Hidden Valley Original Ranch Salad Dressing",
    brand: "Hidden Valley",
    category: "Dressings & Sauces",
    searchVolumeTag: "#1 Searched Salad Dressing",
    ingredients:
      "Vegetable Oil (Soybean and/or Canola Oil), Water, Sugar, Salt, Less than 2% of: Buttermilk, Egg Yolk, Garlic, Onion, Monosodium Glutamate, Phosphoric Acid, Xanthan Gum, Modified Food Starch, Natural and Artificial Flavor, Disodium Inosinate, Disodium Guanylate, Sorbic Acid, Calcium Disodium EDTA.",
  },
  {
    slug: "cheez-it-original-crackers",
    title: "Cheez-It Original Baked Snack Crackers",
    brand: "Cheez-It",
    category: "Crackers",
    searchVolumeTag: "#1 Kids Lunchbox Cracker",
    ingredients:
      "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1, Vitamin B2, Folic Acid), Vegetable Oil (High Oleic Soybean, Soybean, Palm, and/or Canola Oil with TBHQ for Freshness), Cheese Made with Skim Milk (Skim Milk, Whey Protein, Salt, Cheese Cultures, Enzymes, Annatto Extract Color), Salt, Paprika, Yeast, Paprika Extract Color, Soy Lecithin.",
  },
  {
    slug: "yoplait-original-strawberry-yogurt",
    title: "Yoplait Original Strawberry Yogurt",
    brand: "Yoplait",
    category: "Yogurt & Dairy",
    searchVolumeTag: "High-Sugar Dairy Search",
    ingredients:
      "Cultured Grade A Reduced Fat Milk, Sugar, Strawberries, Modified Corn Starch, High Fructose Corn Syrup, Corn Starch, Citric Acid, Tricalcium Phosphate, Natural Flavor, Potassium Sorbate Added to Maintain Freshness, Red 40, Vitamin A Acetate, Vitamin D3.",
  },
  {
    slug: "oscar-mayer-deli-fresh-turkey",
    title: "Oscar Mayer Deli Fresh Oven Roasted Turkey Breast",
    brand: "Oscar Mayer",
    category: "Deli Meat",
    searchVolumeTag: "#1 Deli Meat Nitrite Check",
    ingredients:
      "Turkey Breast, Water, Modified Cornstarch, Contains Less than 2% of Sodium Lactate, Salt, Sugar, Sodium Phosphates, Carrageenan, Sodium Diacetate, Sodium Ascorbate, Sodium Nitrite, Natural Flavor.",
  },
  {
    slug: "heinz-tomato-ketchup",
    title: "Heinz Tomato Ketchup",
    brand: "Heinz",
    category: "Condiments",
    searchVolumeTag: "#1 Condiment HFCS Check",
    ingredients:
      "Tomato Concentrate from Red Ripe Tomatoes, Distilled Vinegar, High Fructose Corn Syrup, Corn Syrup, Salt, Spice, Onion Powder, Natural Flavoring.",
  },
  {
    slug: "coffee-mate-french-vanilla-creamer",
    title: "Coffee mate French Vanilla Liquid Coffee Creamer",
    brand: "Coffee mate",
    category: "Coffee Creamer",
    searchVolumeTag: "#1 Seed Oil Creamer Check",
    ingredients:
      "Water, Sugar, Vegetable Oil (High Oleic Soybean and/or High Oleic Canola), and Less than 2% of Micellar Casein (a Milk Derivative), Mono- and Diglycerides, Dipotassium Phosphate, Natural and Artificial Flavor, Cellulose Gel, Cellulose Gum, Carrageenan.",
  },
  {
    slug: "gatorade-fruit-punch",
    title: "Gatorade Thirst Quencher Fruit Punch",
    brand: "Gatorade",
    category: "Sports Drinks",
    searchVolumeTag: "#1 Red 40 Sports Drink Check",
    ingredients:
      "Water, Sugar, Dextrose, Citric Acid, Salt, Sodium Citrate, Monopotassium Phosphate, Gum Arabic, Natural Flavor, Sucrose Acetate Isobutyrate, Glycerol Ester of Rosin, Red 40.",
  },
  {
    slug: "kelloggs-froot-loops-cereal",
    title: "Kellogg's Froot Loops Breakfast Cereal",
    brand: "Kellogg's",
    category: "Kids Cereal",
    searchVolumeTag: "#1 Kids Cereal Dye Check",
    ingredients:
      "Corn Flour Blend (Whole Grain Yellow Corn Flour, Degerminated Yellow Corn Flour), Sugar, Wheat Flour, Whole Grain Oat Flour, Modified Food Starch, Contains 2% or Less of Vegetable Oil (Hydrogenated Coconut, Soybean and/or Cottonseed), Oat Fiber, Maltodextrin, Salt, Soluble Corn Fiber, Natural Flavor, Red 40, Yellow 5, Blue 1, Yellow 6, BHT for Freshness.",
  },
  {
    slug: "nutella-hazelnut-spread",
    title: "Nutella Hazelnut Spread with Cocoa",
    brand: "Ferrero",
    category: "Spreads & Nut Butters",
    searchVolumeTag: "High-Sugar Spread Check",
    ingredients:
      "Sugar, Palm Oil, Hazelnuts, Skim Milk, Cocoa, Soy Lecithin as Emulsifier, Vanillin: An Artificial Flavor.",
  },
  {
    slug: "oreo-chocolate-sandwich-cookies",
    title: "Oreo Chocolate Sandwich Cookies",
    brand: "Nabisco",
    category: "Cookies & Snacks",
    searchVolumeTag: "Top Ultraprocessed Cookie Search",
    ingredients:
      "Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Sugar, Palm and/or Canola Oil, Cocoa (Processed with Alkali), High Fructose Corn Syrup, Leavening (Baking Soda and/or Calcium Phosphate), Salt, Soy Lecithin, Chocolate, Artificial Flavor.",
  },
  {
    slug: "siete-grain-free-sea-salt-tortilla-chips",
    title: "Siete Grain-Free Sea Salt Tortilla Chips",
    brand: "Siete",
    category: "Chips & Snacks",
    searchVolumeTag: "Popular Clean Chip Benchmark",
    ingredients:
      "Cassava Flour, Avocado Oil, Coconut Flour, Chia Seed, Sea Salt.",
  },
];

export interface EvaluatedSeoProduct {
  entry: SeoProductEntry;
  result: ScoreResult;
  swap: SwapResult | null;
  imageUrl: string;
}

export function evaluateSeoProduct(entry: SeoProductEntry): EvaluatedSeoProduct {
  const result = scoreProductYuka(entry.ingredients, {}, [], {
    productTitle: `${entry.brand} ${entry.title}`,
  });
  const swap = resolveSwap({
    productTitle: entry.title,
    ingredients: entry.ingredients,
    score: result.score,
    watchlist: {},
    familyWatchlist: [],
    store: "walmart",
  });
  return {
    entry,
    result,
    swap,
    imageUrl: `/api/product-image?q=${encodeURIComponent(entry.title)}`,
  };
}
