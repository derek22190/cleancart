import { scoreProductYuka, type ScoreResult } from "./rubric";
import { resolveSwap, type RetailerId, type SwapResult } from "./swaps";

export interface SeoProductEntry {
  slug: string;
  title: string;
  brand: string;
  category: string;
  searchVolumeTag: string;
  ingredients: string;
  sourceUrl: string;
  verifiedAt: string;
}

export const SEO_PRODUCTS: SeoProductEntry[] = [
  {
    slug: "doritos-nacho-cheese",
    title: "Doritos Nacho Cheese Tortilla Chips",
    brand: "Doritos",
    category: "Chips & Snacks",
    searchVolumeTag: "High-Intent Snack Search",
    ingredients:
      "Corn, Vegetable Oil (Corn, Canola, or Sunflower Oil), Maltodextrin (Made from Corn), Salt, Cheddar Cheese (Milk, Cheese Cultures, Salt, Enzymes), Whey, Monosodium Glutamate, Buttermilk, Romano Cheese, Whey Protein Concentrate, Onion Powder, Corn Flour, Natural and Artificial Flavor, Dextrose, Tomato Powder, Lactose, Spices, Artificial Color (Yellow 6, Yellow 5, Red 40), Lactic Acid, Citric Acid, Sugar, Garlic Powder, Skim Milk, Red and Green Bell Pepper Powder, Disodium Inosinate, Disodium Guanylate.",
    sourceUrl: "https://www.doritos.com/products/doritos-nacho-cheese-flavored-tortilla-chips",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "hidden-valley-ranch",
    title: "Hidden Valley Original Ranch Salad Dressing",
    brand: "Hidden Valley",
    category: "Dressings & Sauces",
    searchVolumeTag: "#1 Searched Salad Dressing",
    ingredients:
      "Vegetable Oil (Soybean or Canola Oil), Water, Sugar, Salt, Less than 2% of: Buttermilk, Egg Yolk, Garlic, Onion, Monosodium Glutamate, Phosphoric Acid, Xanthan Gum, Modified Food Starch, Natural and Artificial Flavor, Disodium Inosinate, Disodium Guanylate, Sorbic Acid, Calcium Disodium EDTA.",
    sourceUrl: "https://www.hiddenvalley.com/products/ranch-condiments/classic-ranch/original-ranch/",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "cheez-it-original-crackers",
    title: "Cheez-It Original Baked Snack Crackers",
    brand: "Cheez-It",
    category: "Crackers",
    searchVolumeTag: "#1 Kids Lunchbox Cracker",
    ingredients:
      "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1, Vitamin B2, Folic Acid), Vegetable Oil (High Oleic Soybean, Soybean, Palm, or Canola Oil with TBHQ for Freshness), Cheese Made with Skim Milk (Skim Milk, Whey Protein, Salt, Cheese Cultures, Enzymes, Annatto Extract Color), Salt, Paprika, Yeast, Paprika Extract Color, Soy Lecithin.",
    sourceUrl: "https://www.cheezit.com/en_US/products/crackers/cheez-it-original-snack-crackers-product.html",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "yoplait-original-strawberry-yogurt",
    title: "Yoplait Original Strawberry Yogurt",
    brand: "Yoplait",
    category: "Yogurt & Dairy",
    searchVolumeTag: "High-Sugar Dairy Search",
    ingredients:
      "Cultured Pasteurized Grade A Lowfat Milk, Sugar, Strawberries, Modified Corn Starch, Nonfat Milk, Kosher Gelatin, Citric Acid, Tricalcium Phosphate, Natural Flavor, Pectin, Colored with Carmine, Vitamin A Acetate, Vitamin D3.",
    sourceUrl: "https://www.yoplait.com/products/original-single-serve-strawberry/",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "oscar-mayer-deli-fresh-turkey",
    title: "Oscar Mayer Deli Fresh Oven Roasted Turkey Breast",
    brand: "Oscar Mayer",
    category: "Deli Meat",
    searchVolumeTag: "#1 Deli Meat Ingredient Check",
    ingredients:
      "Turkey Breast, Water, Modified Cornstarch, Contains Less than 2% of Vinegar, Salt, Cultured Dextrose, Sugar, Sodium Phosphates, Carrageenan, Caramel Color.",
    sourceUrl: "https://www.oscarmayer.com/product/00044700075036/deli-fresh-oven-roasted-turkey-breast-sliced-lunch-meat",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "heinz-tomato-ketchup",
    title: "Heinz Tomato Ketchup",
    brand: "Heinz",
    category: "Condiments",
    searchVolumeTag: "#1 Condiment HFCS Check",
    ingredients:
      "Tomato Concentrate from Red Ripe Tomatoes, Distilled Vinegar, High Fructose Corn Syrup, Corn Syrup, Salt, Spice, Onion Powder, Natural Flavoring.",
    sourceUrl: "https://www.heinz.com/products/00013000006408-tomato-ketchup",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "coffee-mate-french-vanilla-creamer",
    title: "Coffee mate French Vanilla Liquid Coffee Creamer",
    brand: "Coffee mate",
    category: "Coffee Creamer",
    searchVolumeTag: "#1 Seed Oil Creamer Check",
    ingredients:
      "Water, Sugar, Vegetable Oil (High Oleic Soybean or High Oleic Canola), and Less than 2% of Micellar Casein (a Milk Derivative), Mono- and Diglycerides, Dipotassium Phosphate, Natural and Artificial Flavor, Cellulose Gel, Cellulose Gum, Carrageenan.",
    sourceUrl: "https://www.goodnes.com/coffeemate/products/french-vanilla-liquid-coffee-creamer-32-oz-bottle/",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "gatorade-fruit-punch",
    title: "Gatorade Thirst Quencher Fruit Punch",
    brand: "Gatorade",
    category: "Sports Drinks",
    searchVolumeTag: "#1 Red 40 Sports Drink Check",
    ingredients:
      "Water, Sugar, Dextrose, Citric Acid, Salt, Sodium Citrate, Monopotassium Phosphate, Gum Arabic, Natural Flavor, Sucrose Acetate Isobutyrate, Glycerol Ester of Rosin, Red 40.",
    sourceUrl: "https://www.gatorade.com/powders-and-liquids/gatorade-thirst-quencher/liquid/fruit-punch",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "kelloggs-froot-loops-cereal",
    title: "Kellogg's Froot Loops Breakfast Cereal",
    brand: "Kellogg's",
    category: "Kids Cereal",
    searchVolumeTag: "#1 Kids Cereal Dye Check",
    ingredients:
      "Corn Flour Blend (Whole Grain Yellow Corn Flour, Degerminated Yellow Corn Flour), Sugar, Wheat Flour, Whole Grain Oat Flour, Modified Food Starch, Contains 2% or Less of Vegetable Oil (Hydrogenated Coconut, Soybean or Cottonseed), Oat Fiber, Maltodextrin, Salt, Soluble Corn Fiber, Natural Flavor, Red 40, Yellow 5, Blue 1, Yellow 6.",
    sourceUrl: "https://www.wkkellogg.com/en-us/brands/froot-loops/froot-loops-cereal.html",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "cinnamon-toast-crunch",
    title: "General Mills Cinnamon Toast Crunch Cereal",
    brand: "General Mills",
    category: "Kids Cereal",
    searchVolumeTag: "#1 Cinnamon Cereal BHT & Seed Oil Check",
    ingredients:
      "Whole Grain Wheat, Sugar, Rice Flour, Canola and/or Sunflower Oil, Fructose, Maltodextrin, Dextrose, Salt, Cinnamon, Trisodium Phosphate, Soy Lecithin, Caramel Color. BHT Added to Preserve Freshness.",
    sourceUrl: "https://www.cinnamontoastcrunch.com/products/cinnamon-toast-crunch",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "nutella-hazelnut-spread",
    title: "Nutella Hazelnut Spread with Cocoa",
    brand: "Ferrero",
    category: "Spreads & Nut Butters",
    searchVolumeTag: "High-Sugar Spread Check",
    ingredients:
      "Sugar, Palm Oil, Hazelnuts, Skim Milk, Cocoa, Soy Lecithin as Emulsifier, Vanillin: An Artificial Flavor.",
    sourceUrl: "https://www.nutella.com/us/en/inside-nutella/quality-and-ingredients",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "oreo-chocolate-sandwich-cookies",
    title: "Oreo Chocolate Sandwich Cookies",
    brand: "Nabisco",
    category: "Cookies & Snacks",
    searchVolumeTag: "Top Ultraprocessed Cookie Search",
    ingredients:
      "Unbleached Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Sugar, Palm or Canola Oil, Cocoa (Processed with Alkali), High Fructose Corn Syrup, Leavening (Baking Soda or Calcium Phosphate), Salt, Soy Lecithin, Chocolate, Artificial Flavor.",
    sourceUrl: "https://www.oreo.com/products/oreo-original",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "siete-grain-free-sea-salt-tortilla-chips",
    title: "Siete Grain-Free Sea Salt Tortilla Chips",
    brand: "Siete",
    category: "Chips & Snacks",
    searchVolumeTag: "Popular Clean Chip Benchmark",
    ingredients:
      "Cassava Flour, Avocado Oil, Coconut Flour, Chia Seed, Sea Salt.",
    sourceUrl: "https://sietefoods.com/products/sea-salt-grain-free-tortilla-chips",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "eggo-homestyle-waffles",
    title: "Eggo Homestyle Frozen Waffles",
    brand: "Eggo",
    category: "Frozen Breakfast",
    searchVolumeTag: "#1 Frozen Breakfast Search",
    ingredients:
      "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1, Vitamin B2, Folic Acid), Water, Vegetable Oil (Soybean, Palm, Canola or Cottonseed), Sugar, Leavening (Baking Soda, Sodium Aluminum Phosphate, Monocalcium Phosphate), Eggs, Salt, Whey, Soy Lecithin, Beta-Carotene for Color.",
    sourceUrl: "https://www.leggomyeggo.com/en_US/products/waffles/kelloggs-eggo-homestyle-product.html",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "pepperidge-farm-goldfish-cheddar",
    title: "Pepperidge Farm Goldfish Cheddar Crackers",
    brand: "Pepperidge Farm",
    category: "Crackers",
    searchVolumeTag: "#1 Toddler Snack Search",
    ingredients:
      "Made with Smiles and Enriched Wheat Flour (Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Cheddar Cheese ([Cultured Milk, Salt, Enzymes], Annatto), Vegetable Oils (Canola, Sunflower or Soybean), Salt, Contains 2% or Less of: Yeast, Sugar, Autolyzed Yeast Extract, Paprika, Spices, Celery, Onion Powder, Monocalcium Phosphate, Baking Soda.",
    sourceUrl: "https://www.pepperidgefarm.com/product/goldfish-cheddar-crackers/",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "smuckers-uncrustables-pbj",
    title: "Smucker's Uncrustables Peanut Butter & Grape Jelly Sandwich",
    brand: "Smucker's",
    category: "Frozen Lunchbox",
    searchVolumeTag: "#1 School Lunchbox Search",
    ingredients:
      "Peanut Butter (Peanuts, Sugar, Contains 2% or Less of: Molasses, Fully Hydrogenated Vegetable Oils [Rapeseed and Soybean], Mono- and Diglycerides, Salt), Bread (Unbleached Enriched Flour [Wheat Flour, Malted Barley Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid], Water, Sugar, Soybean Oil, Salt, Yeast, Cultured Wheat Flour, Distilled Vinegar, Enzymes, Ascorbic Acid), Grape Spread (Sugar, Concord Grape Juice, Pectin, Citric Acid, Potassium Sorbate as Preservative, Sodium Citrate).",
    sourceUrl: "https://www.uncrustables.com/sandwiches/peanut-butter-and-grape-jelly",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "kraft-macaroni-and-cheese-original",
    title: "Kraft Original Macaroni & Cheese Dinner",
    brand: "Kraft",
    category: "Pantry & Pasta",
    searchVolumeTag: "#1 Boxed Mac & Cheese Search",
    ingredients:
      "Enriched Macaroni (Wheat Flour, Durum Flour, Niacin, Ferrous Sulfate, Thiamin Mononitrate, Riboflavin, Folic Acid), Cheese Sauce Mix (Whey, Milkfat, Salt, Milk Protein Concentrate, Sodium Triphosphate, Contains Less than 2% of Tapioca Flour, Citric Acid, Lactic Acid, Sodium Phosphate, Calcium Phosphate, with Paprika, Turmeric, and Annatto Added for Color, Enzymes, Cheese Culture).",
    sourceUrl: "https://www.kraftmacandcheese.com/product/00021000658831/kraft-original-macaroni-cheese-dinner-7-25-oz-box",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "capri-sun-strawberry-kiwi",
    title: "Capri Sun Strawberry Kiwi Flavored Juice Drink",
    brand: "Capri Sun",
    category: "Kids Drinks",
    searchVolumeTag: "#1 Kids Juice Pouch Search",
    ingredients:
      "Water, Sugar, Pear and Grape Juice Concentrate, Citric Acid, Strawberry and Kiwi Juice Concentrate, Natural Flavor.",
    sourceUrl: "https://www.myfoodandfamily.com/brands/capri-sun/product/00087684001059",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "monster-energy-zero-ultra-white",
    title: "Monster Energy Zero Ultra (White Monster)",
    brand: "Monster Energy",
    category: "Energy Drinks",
    searchVolumeTag: "#1 Zero Sugar Energy Drink Search",
    ingredients:
      "Carbonated Water, Citric Acid, Erythritol, Taurine, Sodium Citrate, Panax Ginseng Flavor, Natural and Artificial Flavors, L-Carnitine L-Tartrate, Potassium Sorbate, Caffeine, Sucralose, Sorbic Acid, Acesulfame Potassium, Niacinamide, D-Calcium Pantothenate, Inositol, Pyridoxine Hydrochloride, Cyanocobalamin.",
    sourceUrl: "https://www.monsterenergy.com/en-us/energy-drinks/zero-sugar/zero-ultra/",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "fairlife-core-power-chocolate-protein",
    title: "Fairlife Core Power 26g Chocolate Protein Shake",
    brand: "Fairlife",
    category: "Protein Shakes",
    searchVolumeTag: "#1 RTD Protein Shake Search",
    ingredients:
      "Filtered Lowfat Grade A Milk, Alkalized Cocoa, Natural Flavors, Cellulose Gel, Cellulose Gum, Salt, Carrageenan, Acesulfame Potassium, Sucralose, Lactase Enzyme, Vitamin A Palmitate, Vitamin D3.",
    sourceUrl: "https://fairlife.com/core-power/chocolate-protein-shake-26g/",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "celsius-sparkling-orange-energy",
    title: "Celsius Live Fit Sparkling Orange Energy Drink",
    brand: "Celsius",
    category: "Energy Drinks",
    searchVolumeTag: "Top Fitness Energy Drink Search",
    ingredients:
      "Carbonated Filtered Water, Citric Acid, Taurine, Guarana Seed Extract, Green Tea Extract, Caffeine, Ascorbic Acid, Sucralose, Glucuronolactone, Ginger Root Extract, Calcium Pantothenate, Niacinamide, Beta-Carotene for Color, Natural Flavor, Pyridoxine Hydrochloride, Riboflavin, Chromium Chelate, Biotin, Cyanocobalamin.",
    sourceUrl: "https://www.celsius.com/products/celsius/sparkling-orange/",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "takis-fuego-rolled-tortilla-chips",
    title: "Takis Fuego Hot Chili Pepper & Lime Tortilla Chips",
    brand: "Takis",
    category: "Chips & Snacks",
    searchVolumeTag: "#1 Red 40 Spicy Chip Search",
    ingredients:
      "Corn Masa Flour (Processed with Lime), Vegetable Oil (Palm or Soybean or Canola or Rice Bran Oil), Seasoning (Salt, Maltodextrin, Citric Acid, Sugar, Monosodium Glutamate, Hydrolyzed Soy Protein, Onion Powder, Yeast Extract, Red 40 Lake, Yellow 6 Lake, Natural and Artificial Flavors, Baking Soda, Soybean Oil, Chili Pepper, Disodium Inosinate, Disodium Guanylate, TBHQ).",
    sourceUrl: "https://www.barcel-usa.com/takis-fuego",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "ore-ida-golden-crinkles-french-fries",
    title: "Ore-Ida Golden Crinkles Frozen French Fries",
    brand: "Ore-Ida",
    category: "Frozen Potatoes",
    searchVolumeTag: "#1 Frozen French Fry Seed Oil Check",
    ingredients:
      "Potatoes, Vegetable Oil (Soybean, Canola, or Cottonseed Oils), Disodium Dihydrogen Pyrophosphate (to Retain Natural Color), Dextrose.",
    sourceUrl: "https://www.oreida.com/product/00013120000836/golden-crinkles-french-fried-potatoes",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "skippy-creamy-peanut-butter",
    title: "Skippy Creamy Peanut Butter",
    brand: "Skippy",
    category: "Spreads & Nut Butters",
    searchVolumeTag: "#1 Hydrogenated Oil Peanut Butter Check",
    ingredients:
      "Roasted Peanuts, Sugar, Hydrogenated Vegetable Oil (Cottonseed, Soybean and Rapeseed Oil) to Prevent Separation, Salt.",
    sourceUrl: "https://www.peanutbutter.com/products/skippy-creamy-peanut-butter",
    verifiedAt: "2026-11-08",
  },
  {
    slug: "prego-traditional-italian-pasta-sauce",
    title: "Prego Traditional Italian Tomato Pasta Sauce",
    brand: "Prego",
    category: "Dressings & Sauces",
    searchVolumeTag: "#1 Jarred Pasta Sauce Canola Check",
    ingredients:
      "Tomato Puree (Water, Tomato Paste), Diced Tomatoes in Tomato Juice, Sugar, Canola Oil, Contains Less than 1% of: Salt, Dehydrated Onions, Spices, Citric Acid, Dehydrated Garlic, Onion Extract, Natural Flavoring.",
    sourceUrl: "https://www.campbells.com/prego/products/traditional-italian-sauce/",
    verifiedAt: "2026-11-08",
  },
];

export interface EvaluatedSeoProduct {
  entry: SeoProductEntry;
  result: ScoreResult;
  swap: SwapResult | null;
  imageUrl: string;
}

export function evaluateSeoProduct(
  entry: SeoProductEntry,
  store: RetailerId = "walmart",
): EvaluatedSeoProduct {
  const result = scoreProductYuka(entry.ingredients, {}, [], {
    productTitle: `${entry.brand} ${entry.title}`,
  });
  const swap = resolveSwap({
    productTitle: entry.title,
    ingredients: entry.ingredients,
    score: result.score,
    watchlist: {},
    familyWatchlist: [],
    store,
  });
  return {
    entry,
    result,
    swap,
    imageUrl: `/api/product-image?q=${encodeURIComponent(entry.title)}`,
  };
}
