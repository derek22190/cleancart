import { NextResponse } from "next/server";
import { scoreProductYuka } from "@/lib/rubric";
import { CLEAN_ALTERNATIVES, EXACT_PRODUCT_ALTERNATIVES } from "@/lib/swaps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SuggestEntry {
  title: string;
  brand: string;
  ingredients: string;
}

const POPULAR_GROCERY_INDEX: SuggestEntry[] = [
  {
    title: "Doritos Nacho Cheese Tortilla Chips",
    brand: "Doritos",
    ingredients:
      "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin, Salt, Cheddar Cheese, Whey, Monosodium Glutamate, Buttermilk, Romano Cheese, Onion Powder, Corn Flour, Natural and Artificial Flavor, Dextrose, Tomato Powder, Artificial Color (Yellow 6, Yellow 5, Red 40), Disodium Inosinate, Disodium Guanylate.",
  },
  {
    title: "Doritos Cool Ranch Tortilla Chips",
    brand: "Doritos",
    ingredients:
      "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin, Salt, Tomato Powder, Corn Starch, Lactose, Whey, Skim Milk, Corn Syrup Solids, Onion Powder, Sugar, Garlic Powder, Monosodium Glutamate, Cheddar Cheese, Dextrose, Malic Acid, Buttermilk, Natural and Artificial Flavors, Sodium Acetate, Artificial Color (Red 40, Blue 1, Yellow 5), Disodium Inosinate, Disodium Guanylate.",
  },
  {
    title: "Doritos Spicy Sweet Chili Tortilla Chips",
    brand: "Doritos",
    ingredients:
      "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Salt, Sugar, Monosodium Glutamate, Fructose, Sodium Diacetate, Soy Sauce (Soybeans, Wheat, Salt), Onion Powder, Maltodextrin, Hydrolyzed Soy Protein, Hydrolyzed Corn Protein, Garlic Powder, Torula Yeast, Malic Acid, Paprika Extracts, Spices, Caramel Color, Disodium Inosinate, Disodium Guanylate, Natural Flavor.",
  },
  {
    title: "Doritos Spicy Nacho Tortilla Chips",
    brand: "Doritos",
    ingredients:
      "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin, Salt, Whey, Monosodium Glutamate, Buttermilk, Romano Cheese, Cheddar Cheese, Corn Starch, Onion Powder, Garlic Powder, Dextrose, Spices, Natural and Artificial Flavor, Artificial Color (Yellow 6 Lake, Red 40 Lake, Yellow 6, Red 40, Yellow 5, Blue 1), Disodium Inosinate, Disodium Guanylate.",
  },
  {
    title: "Siete Grain-Free Sea Salt Tortilla Chips",
    brand: "Siete",
    ingredients: "Cassava Flour, Avocado Oil, Coconut Flour, Chia Seed, Sea Salt.",
  },
  {
    title: "Siete Sea Salt Kettle Cooked Potato Chips",
    brand: "Siete",
    ingredients: "Potatoes, Avocado Oil, Sea Salt.",
  },
  {
    title: "Marketside New England Clam Chowder, 16 oz",
    brand: "Marketside",
    ingredients:
      "Light Cream, Potatoes, Fish Stock, Sea Clams, Chopped Cockle, Onions, Wheat Flour, Soybean Oil, Butter, Clam Broth, Sea Salt, Celery, Salt Pork, Black Pepper, Worcestershire Sauce, Garlic, Natural Flavors.",
  },
  {
    title: "Campbell's New England Clam Chowder Soup",
    brand: "Campbell's",
    ingredients:
      "Clam Stock, Potatoes, Clams, Vegetable Oil (Corn, Canola, And/Or Soybean), Celery, Modified Food Starch, Wheat Flour, Salt, Cream, Soy Protein Concentrate, Monosodium Glutamate, Sodium Phosphate, Disodium Inosinate, Disodium Guanylate, Natural Flavoring, Soy Lecithin.",
  },
  {
    title: "Progresso Traditional New England Clam Chowder Soup",
    brand: "Progresso",
    ingredients:
      "Clam Broth, Potatoes, Clams, Soybean Oil, Modified Food Starch, Cream, Contains Less than 2% of: Salt, Wheat Flour, Soy Protein Concentrate, Sugar, Monosodium Glutamate, Onion Powder, Sodium Phosphate, Natural Flavor, Garlic Powder, Dried Parsley.",
  },
  {
    title: "Amy's Organic Low Fat Lentil Vegetable Soup",
    brand: "Amy's",
    ingredients:
      "Filtered Water, Organic Onions, Organic Green Lentils, Organic Carrots, Organic Celery, Organic Potatoes, Organic Spinach, Organic Extra Virgin Olive Oil, Sea Salt, Organic Garlic, Organic Bay Leaves.",
  },
  {
    title: "Marketside Premium Romaine Salad Blend",
    brand: "Marketside",
    ingredients: "Romaine Lettuce, Red Cabbage, Carrots.",
  },
  {
    title: "Marketside Caesar Salad Kit",
    brand: "Marketside",
    ingredients:
      "Romaine Lettuce, Caesar Dressing (Soybean Oil, Water, Parmesan Cheese, Egg Yolk, Distilled Vinegar, Salt, Sugar, Garlic, Lemon Juice Concentrate, Natural Flavor, Xanthan Gum), Croutons (Enriched Wheat Flour, Sunflower Oil, Salt, Yeast, Garlic Powder), Parmesan Cheese.",
  },
  {
    title: "Hidden Valley Original Ranch Salad Dressing",
    brand: "Hidden Valley",
    ingredients:
      "Vegetable Oil (Soybean and/or Canola), Water, Sugar, Salt, Buttermilk, Egg Yolk, Natural Flavors, Phosphoric Acid, Xanthan Gum, Monosodium Glutamate, Artificial Flavors, Disodium Phosphate, Sorbic Acid, Calcium Disodium EDTA.",
  },
  {
    title: "Primal Kitchen Avocado Oil Ranch Dressing",
    brand: "Primal Kitchen",
    ingredients:
      "Avocado Oil, Water, Organic Vinegar, Organic Cage-Free Eggs, Organic Lemon Juice, Salt, OrganicGum Acacia, Organic Guar Gum, Organic Garlic, Organic Onion, Organic Dill, Organic Chives.",
  },
  {
    title: "General Mills Cinnamon Toast Crunch Cereal",
    brand: "General Mills",
    ingredients:
      "Whole Grain Wheat, Sugar, Rice Flour, Canola and/or Sunflower Oil, Fructose, Maltodextrin, Dextrose, Salt, Cinnamon, Trisodium Phosphate, Soy Lecithin, Caramel Color, BHT Added to Preserve Freshness.",
  },
  {
    title: "General Mills Honey Nut Cheerios Cereal",
    brand: "General Mills",
    ingredients:
      "Whole Grain Oats, Sugar, Oat Bran, Corn Starch, Honey, Brown Sugar Syrup, Salt, Tripotassium Phosphate, Canola and/or Sunflower Oil, Natural Almond Flavor, Vitamin E (Mixed Tocopherols).",
  },
  {
    title: "General Mills Lucky Charms Cereal",
    brand: "General Mills",
    ingredients:
      "Whole Grain Oats, Sugar, Oat Flour, Corn Syrup, Modified Corn Starch, Corn Starch, Dextrose, Salt, Gelatin, Trisodium Phosphate, Yellow 5 & 6, Red 40, Blue 1, Natural and Artificial Flavor.",
  },
  {
    title: "Post Oreo O's / Oreo Puffs Cereal",
    brand: "Post",
    ingredients:
      "Corn Flour, Sugar, Whole Grain Oat Flour, Cocoa (Processed with Alkali), Canola Oil, Corn Syrup, Unbleached Enriched Flour, Salt, Cornstarch, Palm Oil, Soy Lecithin, Natural and Artificial Flavor, Chocolate Liquor, BHT Added to Preserve Freshness.",
  },
  {
    title: "Three Wishes Cinnamon Grain-Free Cereal",
    brand: "Three Wishes",
    ingredients: "Chickpea, Tapioca, Pea Protein, Organic Cane Sugar, Cinnamon, Monk Fruit, Salt.",
  },
  {
    title: "Three Wishes Unsweetened Cocoa Grain-Free Cereal",
    brand: "Three Wishes",
    ingredients: "Chickpea, Tapioca, Pea Protein, Organic Cocoa, Monk Fruit, Salt.",
  },
  {
    title: "Kerrygold Pure Irish Grass-Fed Salted Butter",
    brand: "Kerrygold",
    ingredients: "Pasteurized Cream, Salt.",
  },
  {
    title: "Lactaid 100% Lactose-Free Fat Free Milk",
    brand: "Lactaid",
    ingredients: "Fat Free Milk, Lactase Enzyme, Vitamin A Palmitate, Vitamin D3.",
  },
  {
    title: "Great Value Whole Vitamin D Milk, Gallon",
    brand: "Great Value",
    ingredients: "Milk, Vitamin D3.",
  },
  {
    title: "Chobani Non-Fat Plain Greek Yogurt",
    brand: "Chobani",
    ingredients: "Cultured Nonfat Milk.",
  },
  {
    title: "Dave's Killer Bread Organic 21 Whole Grains & Seeds",
    brand: "Dave's Killer Bread",
    ingredients:
      "Organic Whole Wheat, Water, Organic Cane Sugar, Organic Cracked Whole Wheat, Organic 21 Whole Grains and Seeds Mix, Organic Vital Wheat Gluten, Organic Oat Fiber, Yeast, Sea Salt.",
  },
  {
    title: "Santa Cruz Organic Dark Roasted Peanut Butter",
    brand: "Santa Cruz Organic",
    ingredients: "Organic Roasted Peanuts, Salt (1% or less).",
  },
  {
    title: "Jif Creamy Peanut Butter",
    brand: "Jif",
    ingredients: "Made From Roasted Peanuts And Sugar, Contains 2% Or Less Of: Molasses, Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Mono And Diglycerides, Salt.",
  },
  {
    title: "Oreo Chocolate Sandwich Cookies",
    brand: "Nabisco",
    ingredients:
      "Unbleached Enriched Flour, Sugar, Palm and/or Canola Oil, Cocoa (Processed with Alkali), High Fructose Corn Syrup, Leavening (Baking Soda and/or Calcium Phosphate), Salt, Soy Lecithin, Chocolate, Artificial Flavor.",
  },
  {
    title: "Cheez-It Original Baked Snack Crackers",
    brand: "Cheez-It",
    ingredients:
      "Enriched Flour, Vegetable Oil (High Oleic Soybean, Soybean, Palm, and/or Canola Oil with TBHQ for Freshness), Cheese Made with Skim Milk, Salt, Paprika, Yeast, Paprika Extract Color, Soy Lecithin, Annatto Extract Color.",
  },
  {
    title: "Pepperidge Farm Goldfish Cheddar Crackers",
    brand: "Pepperidge Farm",
    ingredients:
      "Enriched Wheat Flour, Cheddar Cheese (Cultured Milk, Salt, Enzymes, Annatto), Vegetable Oils (Canola, Sunflower and/or Soybean), Salt, Yeast, Sugar, Autolyzed Yeast Extract, Paprika, Spices, Celery, Onion Powder, Monocalcium Phosphate, Baking Soda.",
  },
  {
    title: "Hu Simple Organic 70% Dark Chocolate Bar",
    brand: "Hu Kitchen",
    ingredients: "Organic Fair-Trade Cacao, Unrefined Organic Coconut Sugar, Organic Fair-Trade Cocoa Butter.",
  },
];

// Merge clean alternatives into the autocomplete index
const FULL_INDEX: SuggestEntry[] = (() => {
  const seen = new Set<string>();
  const out: SuggestEntry[] = [];
  for (const item of POPULAR_GROCERY_INDEX) {
    const k = item.title.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  for (const alt of Object.values(CLEAN_ALTERNATIVES)) {
    const title = `${alt.brand} ${alt.name}`.trim();
    const k = title.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ title, brand: alt.brand, ingredients: alt.ingredients });
    }
  }
  for (const entry of EXACT_PRODUCT_ALTERNATIVES) {
    const alt = entry.alt;
    const title = `${alt.brand} ${alt.name}`.trim();
    const k = title.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ title, brand: alt.brand, ingredients: alt.ingredients });
    }
  }
  return out;
})();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || "").trim().toLowerCase();
  if (!q) {
    return NextResponse.json({ ok: true, suggestions: [] }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  const tokens = q.split(/\s+/).filter(Boolean);
  const scored: Array<{ entry: SuggestEntry; rank: number }> = [];

  for (const entry of FULL_INDEX) {
    const hay = `${entry.title} ${entry.brand}`.toLowerCase();
    const matchedTokens = tokens.filter((t) => hay.includes(t));
    if (matchedTokens.length === 0) continue;
    let rank = matchedTokens.length * 10;
    if (hay.startsWith(q) || entry.brand.toLowerCase().startsWith(q)) rank += 15;
    if (matchedTokens.length === tokens.length) rank += 20;
    scored.push({ entry, rank });
  }

  scored.sort((a, b) => b.rank - a.rank);

  const suggestions = scored.slice(0, 8).map(({ entry }) => {
    const res = scoreProductYuka(entry.ingredients, {}, [], { productTitle: entry.title });
    return {
      title: entry.title,
      brand: entry.brand,
      score: res.score,
      rating: res.rating,
      color: res.color,
      imageUrl: `https://www.heybroc.com/api/product-image?q=${encodeURIComponent(entry.title)}`,
    };
  });

  return NextResponse.json(
    { ok: true, suggestions },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}
