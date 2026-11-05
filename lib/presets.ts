/**
 * Simulator presets. Ingredient lists are realistic, generic-brand formulations.
 * Scores are NOT hard-coded — they are computed live by lib/rubric.ts.
 */
import type { SwapCategory } from "./swaps";

export interface Preset {
  id: string;
  title: string;
  brand: string;
  size: string;
  price: number;
  image: string;
  category: SwapCategory;
  ingredients: string;
}

export const PRESETS: Preset[] = [
  {
    id: "yogurt",
    brand: "Berry Swirl",
    title: "Strawberry Lowfat Yogurt",
    size: "5.3 oz cup",
    price: 0.98,
    image: "/products/yogurt.jpg",
    category: "Yogurt",
    ingredients:
      "Cultured Pasteurized Grade A Lowfat Milk, Sugar, Strawberries, High Fructose Corn Syrup, Modified Corn Starch, Kosher Gelatin, Red 40, Potassium Sorbate (to maintain freshness), Vitamin A Acetate, Vitamin D3.",
  },
  {
    id: "crackers",
    brand: "Cheddar Bites",
    title: "Baked Cheddar Cheese Crackers",
    size: "7 oz box",
    price: 3.48,
    image: "/products/crackers.jpg",
    category: "Crackers",
    ingredients:
      "Enriched Flour (Wheat Flour, Niacin, Reduced Iron, Thiamine Mononitrate, Riboflavin, Folic Acid), Cheddar Cheese (Cultured Milk, Salt, Enzymes, Annatto), Vegetable Oil (Soybean, Canola and/or Sunflower Oil), Salt, Paprika, Yeast, Onion Powder.",
  },
  {
    id: "turkey",
    brand: "Deli Select",
    title: "Oven Roasted Turkey Breast, Thin Sliced",
    size: "16 oz",
    price: 5.97,
    image: "/products/turkey.jpg",
    category: "Deli Meat",
    ingredients:
      "Turkey Breast, Water, Contains 2% or Less of: Salt, Dextrose, Sodium Phosphate, Carrageenan, Potassium Lactate, Sodium Diacetate, Sodium Erythorbate, Sodium Nitrite.",
  },
  {
    id: "ranch",
    brand: "Ranch House",
    title: "Creamy Ranch Salad Dressing",
    size: "16 fl oz",
    price: 2.94,
    image: "/products/ranch.jpg",
    category: "Dressings",
    ingredients:
      "Vegetable Oil (Soybean and/or Canola), Water, Egg Yolk, Sugar, Salt, Cultured Nonfat Buttermilk, Spices, Less than 1% of: Dried Garlic, Dried Onion, Vinegar, Xanthan Gum, Modified Food Starch, Artificial Flavors.",
  },
  {
    id: "butter",
    brand: "Green Pasture",
    title: "Grass-Fed Salted Butter",
    size: "8 oz",
    price: 4.48,
    image: "/products/butter.jpg",
    category: "Butter/Dairy",
    ingredients: "Pasteurized Cream (from Grass-Fed Cows), Salt.",
  },
];
