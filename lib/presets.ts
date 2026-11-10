/**
 * Simulator presets — verified US grocery brand formulations with live rubric scoring.
 * Scores are NOT hard-coded — they are computed live by lib/rubric.ts.
 */
import type { NutritionInput } from "./rubric";
import type { SwapCategory } from "./swaps";

export interface Preset {
  id: string;
  title: string;
  brand: string;
  size: string;
  image: string;
  category: SwapCategory;
  ingredients: string;
  nutrition?: NutritionInput;
  sourceUrl?: string;
  verifiedAt?: string;
}

export const PRESETS: Preset[] = [
  {
    id: "yogurt",
    brand: "Yoplait",
    title: "Original Strawberry Low Fat Yogurt",
    size: "6 oz cup",
    image: "/api/product-image?title=Yoplait%20Original%20Strawberry%20Low%20Fat%20Yogurt",
    category: "Yogurt",
    ingredients:
      "Cultured Grade A Reduced Fat Milk, Sugar, Strawberries, Modified Corn Starch, High Fructose Corn Syrup, Kosher Gelatin, Citric Acid, Tricalcium Phosphate, Colored with Carmine, Natural Flavor, Pectin, Vitamin A Acetate, Vitamin D3.",
    nutrition: {
      caloriesKcal100g: 88,
      sugarsG100g: 11.2,
      saturatedFatG100g: 0.9,
      sodiumMg100g: 50,
      fiberG100g: 0,
      proteinG100g: 3.5,
      fruitsVegNutsPct: 5,
      isOrganic: false,
      isWholeFood: false,
    },
    sourceUrl: "https://www.yoplait.com/products/original-single-serve-strawberry/",
    verifiedAt: "2026-11-10",
  },
  {
    id: "crackers",
    brand: "Cheez-It",
    title: "Original Baked Snack Crackers",
    size: "12.4 oz box",
    image: "/api/product-image?title=Cheez-It%20Original%20Baked%20Snack%20Crackers",
    category: "Crackers",
    ingredients:
      "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Vitamin B1 [Thiamin Mononitrate], Vitamin B2 [Riboflavin], Folic Acid), Vegetable Oil (High Oleic Soybean, Soybean, Palm, and/or Canola Oil with TBHQ for Freshness), Cheese Made with Skim Milk (Skim Milk, Whey Protein, Salt, Cheese Cultures, Enzymes, Annatto Extract Color), Salt, Paprika, Yeast, Paprika Extract Color, Soy Lecithin.",
    nutrition: {
      caloriesKcal100g: 500,
      sugarsG100g: 0,
      saturatedFatG100g: 5.0,
      sodiumMg100g: 767,
      fiberG100g: 3.3,
      proteinG100g: 10.0,
      fruitsVegNutsPct: 0,
      isOrganic: false,
      isWholeFood: false,
    },
    sourceUrl: "https://www.cheezit.com/en_US/products/crackers/cheez-it-original-product.html",
    verifiedAt: "2026-11-10",
  },
  {
    id: "turkey",
    brand: "Oscar Mayer",
    title: "Deli Fresh Honey Smoked Turkey Breast",
    size: "9 oz tub",
    image: "/api/product-image?title=Oscar%20Mayer%20Deli%20Fresh%20Honey%20Smoked%20Turkey%20Breast",
    category: "Deli Meat",
    ingredients:
      "Turkey Breast, Water, Honey, Sugar, Cultured Dextrose, Modified Potato Starch, Salt, Vinegar, Cultured Celery Juice, Sodium Phosphates, Cherry Powder.",
    nutrition: {
      caloriesKcal100g: 107,
      sugarsG100g: 5.4,
      saturatedFatG100g: 0,
      sodiumMg100g: 893,
      fiberG100g: 0,
      proteinG100g: 16.1,
      fruitsVegNutsPct: 0,
      isOrganic: false,
      isWholeFood: false,
    },
    sourceUrl: "https://www.oscarmayer.com/products/00044700075050-deli-fresh-honey-smoked-turkey-breast-sliced-lunch-meat",
    verifiedAt: "2026-11-10",
  },
  {
    id: "ranch",
    brand: "Hidden Valley",
    title: "Original Ranch Salad Dressing",
    size: "16 fl oz bottle",
    image: "/api/product-image?title=Hidden%20Valley%20Original%20Ranch%20Salad%20Dressing",
    category: "Dressings",
    ingredients:
      "Vegetable Oil (Soybean and/or Canola), Water, Sugar, Salt, Less than 2% of: Buttermilk, Egg Yolk, Garlic, Onion, Monosodium Glutamate, Phosphoric Acid, Xanthan Gum, Modified Food Starch, Natural Flavors, Spices, Disodium Inosinate, Disodium Guanylate, Vinegar, Sorbic Acid and Calcium Disodium EDTA Added to Preserve Freshness.",
    nutrition: {
      caloriesKcal100g: 433,
      sugarsG100g: 3.3,
      saturatedFatG100g: 6.7,
      sodiumMg100g: 867,
      fiberG100g: 0,
      proteinG100g: 0,
      fruitsVegNutsPct: 0,
      isOrganic: false,
      isWholeFood: false,
    },
    sourceUrl: "https://www.hiddenvalley.com/products/ranch-condiments/classic-ranch/original-ranch/",
    verifiedAt: "2026-11-10",
  },
  {
    id: "cereal",
    brand: "Kellogg's",
    title: "Frosted Flakes Cereal",
    size: "13.5 oz box",
    image: "/api/product-image?title=Kellogg's%20Frosted%20Flakes%20Cereal",
    category: "Cereal",
    ingredients:
      "Milled Corn, Sugar, Malt Flavor, Salt, BHT Added to Packaging for Freshness. Vitamins and Minerals: Iron, Vitamin C (Ascorbic Acid), Niacinamide, Vitamin B6 (Pyridoxine Hydrochloride), Vitamin B1 (Thiamin Hydrochloride), Vitamin A Palmitate, Vitamin B2 (Riboflavin), Folic Acid, Vitamin B12, Vitamin D3.",
    nutrition: {
      caloriesKcal100g: 351,
      sugarsG100g: 32.4,
      saturatedFatG100g: 0,
      sodiumMg100g: 514,
      fiberG100g: 0,
      proteinG100g: 5.4,
      fruitsVegNutsPct: 0,
      isOrganic: false,
      isWholeFood: false,
    },
    sourceUrl: "https://www.frostedflakes.com/en_US/products/kellogg-s-frosted-flakes-cereal-product.html",
    verifiedAt: "2026-11-10",
  },
  {
    id: "chips",
    brand: "Lay's",
    title: "Wavy Original Potato Chips",
    size: "7.75 oz bag",
    image: "/api/product-image?title=Lay's%20Wavy%20Original%20Potato%20Chips",
    category: "Chips",
    ingredients:
      "Potatoes, Vegetable Oil (Canola, Corn, Soybean, and/or Sunflower Oil), and Salt.",
    nutrition: {
      caloriesKcal100g: 571,
      sugarsG100g: 0,
      saturatedFatG100g: 5.4,
      sodiumMg100g: 500,
      fiberG100g: 3.6,
      proteinG100g: 7.1,
      fruitsVegNutsPct: 0,
      isOrganic: false,
      isWholeFood: false,
    },
    sourceUrl: "https://www.lays.com/products/lays-wavy-original-potato-chips",
    verifiedAt: "2026-11-10",
  },
  {
    id: "bread",
    brand: "Wonder",
    title: "Classic White Bread",
    size: "20 oz loaf",
    image: "/api/product-image?title=Wonder%20Classic%20White%20Bread",
    category: "Bread",
    ingredients:
      "Unbleached Enriched Flour (Wheat Flour, Malted Barley Flour, Niacin, Reduced Iron, Thiamin Mononitrate, Riboflavin, Folic Acid), Water, Sugar, Yeast, Contains 2% or Less of Each of the Following: Calcium Carbonate, Soybean Oil, Wheat Gluten, Salt, Dough Conditioners (Sodium Stearoyl Lactylate, Calcium Stearoyl Lactylate, Monoglycerides, Mono- and Diglycerides, Ethoxylated Mono- and Diglycerides, DATEM, Enzymes, Ascorbic Acid), Vinegar, Monocalcium Phosphate, Soy Lecithin, Calcium Propionate (to Retard Spoilage), Vitamin D3.",
    nutrition: {
      caloriesKcal100g: 246,
      sugarsG100g: 8.8,
      saturatedFatG100g: 0,
      sodiumMg100g: 351,
      fiberG100g: 1.8,
      proteinG100g: 7.0,
      fruitsVegNutsPct: 0,
      isOrganic: false,
      isWholeFood: false,
    },
    sourceUrl: "https://www.wonderbread.com/product/classic-white/",
    verifiedAt: "2026-11-10",
  },
  {
    id: "snacks",
    brand: "Welch's",
    title: "Mixed Fruit Snacks",
    size: "10 ct box",
    image: "/api/product-image?title=Welch's%20Mixed%20Fruit%20Snacks",
    category: "Snacks",
    ingredients:
      "Fruit Puree (Grape, Peach, Orange, Strawberry and Raspberry), Corn Syrup, Sugar, Modified Corn Starch, Gelatin, Concord Grape Juice from Concentrate, Citric Acid, Lactic Acid, Natural and Artificial Flavors, Ascorbic Acid (Vitamin C), Alpha Tocopherol Acetate (Vitamin E), Vitamin A Palmitate, Sodium Citrate, Coconut Oil, Carnauba Wax, Annatto (Color), Turmeric (Color), Red 40, and Blue 1.",
    nutrition: {
      caloriesKcal100g: 312,
      sugarsG100g: 42.3,
      saturatedFatG100g: 0,
      sodiumMg100g: 38,
      fiberG100g: 0,
      proteinG100g: 3.8,
      fruitsVegNutsPct: 25,
      isOrganic: false,
      isWholeFood: false,
    },
    sourceUrl: "https://welchsfruitsnacks.com/products/mixed-fruit/",
    verifiedAt: "2026-11-10",
  },
  {
    id: "clean",
    brand: "Stonyfield Organic",
    title: "Whole Milk Plain Yogurt",
    size: "32 oz tub",
    image: "/api/product-image?title=Stonyfield%20Organic%20Whole%20Milk%20Plain%20Yogurt",
    category: "Yogurt",
    ingredients: "Cultured pasteurized organic whole milk, pectin, vitamin D3.",
    nutrition: {
      caloriesKcal100g: 70.6,
      sugarsG100g: 3.5,
      saturatedFatG100g: 2.6,
      sodiumMg100g: 50,
      fiberG100g: 0,
      proteinG100g: 3.5,
      fruitsVegNutsPct: 0,
      isOrganic: true,
      isWholeFood: false,
    },
    sourceUrl: "https://www.stonyfield.com/products/whole-milk-smooth-creamy-plain-32oz/",
    verifiedAt: "2026-11-10",
  },
];
