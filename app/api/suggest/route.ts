import { NextResponse } from "next/server";
import { DRINKS_CATALOG, hasValidCatalogProvenance } from "@/lib/drinks-catalog";
import { checkRateLimit } from "@/lib/scan";
import { scoreProductYuka, type NutritionInput } from "@/lib/rubric";
import { CLEAN_ALTERNATIVES, EXACT_PRODUCT_ALTERNATIVES } from "@/lib/swaps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SuggestEntry {
  title: string;
  brand: string;
  category?: string;
  description?: string;
  ingredients: string;
  keywords?: string[];
  nutrition?: NutritionInput;
  sourceUrl?: string;
  verifiedAt?: string;
}

const POPULAR_GROCERY_INDEX: SuggestEntry[] = [
  {
    title: "Doritos Nacho Cheese Tortilla Chips",
    brand: "Doritos",
    ingredients:
      "Corn, Vegetable Oil (Corn, Canola, or Sunflower Oil), Maltodextrin, Salt, Cheddar Cheese, Whey, Monosodium Glutamate, Buttermilk, Romano Cheese, Onion Powder, Corn Flour, Natural and Artificial Flavor, Dextrose, Tomato Powder, Artificial Color (Yellow 6, Yellow 5, Red 40), Disodium Inosinate, Disodium Guanylate.",
    sourceUrl: "https://www.doritos.com/products/doritos-nacho-cheese-flavored-tortilla-chips",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Doritos Cool Ranch Tortilla Chips",
    brand: "Doritos",
    ingredients:
      "Corn, Vegetable Oil (Corn, Canola, or Sunflower Oil), Maltodextrin, Salt, Tomato Powder, Corn Starch, Lactose, Whey, Skim Milk, Corn Syrup Solids, Onion Powder, Sugar, Garlic Powder, Monosodium Glutamate, Cheddar Cheese, Dextrose, Malic Acid, Buttermilk, Natural and Artificial Flavors, Sodium Acetate, Artificial Color (Red 40, Blue 1, Yellow 5), Disodium Inosinate, Disodium Guanylate.",
    sourceUrl: "https://www.doritos.com/products/doritos-cool-ranch-flavored-tortilla-chips",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Doritos Spicy Sweet Chili Tortilla Chips",
    brand: "Doritos",
    ingredients:
      "Corn, Vegetable Oil (Corn, Canola, or Sunflower Oil), Salt, Sugar, Monosodium Glutamate, Fructose, Sodium Diacetate, Soy Sauce (Soybeans, Wheat, Salt), Onion Powder, Maltodextrin, Hydrolyzed Soy Protein, Hydrolyzed Corn Protein, Garlic Powder, Torula Yeast, Malic Acid, Paprika Extracts, Spices, Caramel Color, Disodium Inosinate, Disodium Guanylate, Natural Flavor.",
    sourceUrl: "https://www.doritos.com/products/doritos-spicy-sweet-chili-flavored-tortilla-chips",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Doritos Spicy Nacho Tortilla Chips",
    brand: "Doritos",
    ingredients:
      "Corn, Vegetable Oil (Corn, Canola, or Sunflower Oil), Maltodextrin, Salt, Whey, Cheddar Cheese, Monosodium Glutamate, Buttermilk, Romano Cheese, Onion Powder, Garlic Powder, Spices, Dextrose, Natural and Artificial Flavors, Artificial Color (Red 40 Lake, Yellow 6, Yellow 5, Red 40), Disodium Inosinate, Disodium Guanylate.",
    sourceUrl: "https://www.doritos.com/products/doritos-spicy-nacho-flavored-tortilla-chips",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Doritos Tapatio Tortilla Chips",
    brand: "Doritos",
    ingredients:
      "Corn, Vegetable Oil (Corn, Canola, or Sunflower Oil), Maltodextrin, Salt, Spices, Garlic Powder, Monosodium Glutamate, Tomato Powder, Onion Powder, Sugar, Natural and Artificial Flavors, Dextrose, Malic Acid, Sodium Diacetate, Artificial Color (Red 40 Lake, Yellow 6 Lake, Red 40, Yellow 6, Yellow 5), Disodium Inosinate, Disodium Guanylate.",
    sourceUrl: "https://www.doritos.com/products/doritos-tapatio-flavored-tortilla-chips",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Kirkwood 99% Fat Free Fresh Ground Turkey Breast",
    brand: "Kirkwood",
    ingredients: "Ground Turkey Breast (99% Fat Free, 1% Fat), Natural Rosemary Extract.",
    sourceUrl: "https://www.aldi.us/products/fresh-meat-seafood/fresh-poultry/",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Parkview USDA Beef Smoked Sausage",
    brand: "Parkview",
    ingredients: "Beef, Water, Corn Syrup, Salt, Dextrose, Spices, Sodium Phosphate, Monosodium Glutamate, Garlic Powder, Sodium Erythorbate, Sodium Nitrite.",
    sourceUrl: "https://www.aldi.us/products/deli/lunch-meat-sausages/",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Siete Grain-Free Sea Salt Tortilla Chips",
    brand: "Siete",
    ingredients: "Cassava Flour, Avocado Oil, Coconut Flour, Chia Seed, Sea Salt.",
    sourceUrl: "https://sietefoods.com/products/sea-salt-grain-free-tortilla-chips",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Siete Sea Salt Kettle Cooked Potato Chips",
    brand: "Siete",
    ingredients: "Potatoes, Avocado Oil, Sea Salt.",
    sourceUrl: "https://sietefoods.com/products/sea-salt-kettle-cooked-potato-chips",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Marketside New England Clam Chowder, 16 oz",
    brand: "Marketside",
    ingredients:
      "Light Cream, Potatoes, Fish Stock, Sea Clams, Chopped Cockle, Onions, Wheat Flour, Soybean Oil, Butter, Clam Broth, Sea Salt, Celery, Salt Pork, Black Pepper, Worcestershire Sauce, Garlic, Natural Flavors.",
    sourceUrl: "https://www.walmart.com/ip/Marketside-New-England-Clam-Chowder-16-oz/13908742",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Campbell's New England Clam Chowder Soup",
    brand: "Campbell's",
    ingredients:
      "Clam Stock, Potatoes, Clams, Vegetable Oil (Corn, Canola, or Soybean), Celery, Modified Food Starch, Wheat Flour, Salt, Cream, Soy Protein Concentrate, Monosodium Glutamate, Sodium Phosphate, Disodium Inosinate, Disodium Guanylate, Natural Flavoring, Soy Lecithin.",
    sourceUrl: "https://www.campbells.com/products/chunky/new-england-clam-chowder/",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Progresso Traditional New England Clam Chowder Soup",
    brand: "Progresso",
    ingredients:
      "Clam Broth, Potatoes, Clams, Soybean Oil, Modified Food Starch, Cream, Contains Less than 2% of: Salt, Wheat Flour, Soy Protein Concentrate, Sugar, Monosodium Glutamate, Onion Powder, Sodium Phosphate, Natural Flavor, Garlic Powder, Dried Parsley.",
    sourceUrl: "https://www.progresso.com/products/traditional-new-england-clam-chowder/",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Amy's Organic Low Fat Lentil Vegetable Soup",
    brand: "Amy's",
    ingredients:
      "Filtered Water, Organic Onions, Organic Green Lentils, Organic Carrots, Organic Celery, Organic Potatoes, Organic Spinach, Organic Extra Virgin Olive Oil, Sea Salt, Organic Garlic, Organic Bay Leaves.",
    nutrition: { isOrganic: true },
    sourceUrl: "https://www.amys.com/our-foods/organic-lentil-vegetable-soup-low-fat",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Marketside Premium Romaine Salad Blend",
    brand: "Marketside",
    ingredients: "Romaine Lettuce, Red Cabbage, Carrots.",
    sourceUrl: "https://www.walmart.com/browse/food/fresh-packaged-salads/976759_976793_9756351",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Marketside Caesar Salad Kit",
    brand: "Marketside",
    ingredients:
      "Romaine Lettuce, Caesar Dressing (Soybean Oil, Water, Parmesan Cheese, Egg Yolk, Distilled Vinegar, Salt, Sugar, Garlic, Lemon Juice Concentrate, Natural Flavor, Xanthan Gum), Croutons (Enriched Wheat Flour, Sunflower Oil, Salt, Yeast, Garlic Powder), Parmesan Cheese.",
    sourceUrl: "https://www.walmart.com/browse/food/fresh-packaged-salads/976759_976793_9756351",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Hidden Valley Original Ranch Salad Dressing",
    brand: "Hidden Valley",
    ingredients:
      "Vegetable Oil (Soybean or Canola), Water, Sugar, Salt, Buttermilk, Egg Yolk, Natural Flavors, Phosphoric Acid, Xanthan Gum, Monosodium Glutamate, Artificial Flavors, Disodium Phosphate, Sorbic Acid, Calcium Disodium EDTA.",
    sourceUrl: "https://www.hiddenvalley.com/products/ranch-condiments/classic-ranch/original-ranch/",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Primal Kitchen Avocado Oil Ranch Dressing",
    brand: "Primal Kitchen",
    ingredients:
      "Avocado Oil, Water, Organic Vinegar, Organic Cage-Free Eggs, Organic Lemon Juice, Salt, Organic Gum Acacia, Organic Guar Gum, Organic Garlic, Organic Onion, Organic Dill, Organic Chives.",
    sourceUrl: "https://www.primalkitchen.com/products/ranch-dressing",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Simple Truth Organic Whole Milk Plain Greek Yogurt",
    brand: "Simple Truth Organic",
    ingredients:
      "Cultured Pasteurized Organic Whole Milk. Live and Active Cultures: S. Thermophilus, L. Bulgaricus, L. Acidophilus, Bifidus, L. Casei.",
    nutrition: { isOrganic: true, isWholeFood: true },
    sourceUrl: "https://www.kroger.com/p/simple-truth-organic-plain-whole-milk-greek-yogurt/0001111089910",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Simple Truth Organic Unsweetened Applesauce",
    brand: "Simple Truth Organic",
    ingredients: "Organic Apples, Water, Ascorbic Acid (Vitamin C) to Maintain Color.",
    nutrition: { isOrganic: true, isWholeFood: true },
    sourceUrl: "https://www.kroger.com/p/simple-truth-organic-unsweetened-applesauce-cups/0001111085432",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Private Selection Angus Beef Patties",
    brand: "Private Selection",
    ingredients: "100% USDA Choice Angus Beef.",
    nutrition: { isOrganic: false, isWholeFood: true },
    sourceUrl: "https://www.kroger.com/p/private-selection-80-lean-20-fat-angus-beef-chuck-patties/0001111097111",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Good & Gather Organic Creamy Peanut Butter",
    brand: "Good & Gather",
    ingredients: "Organic Dry Roasted Peanuts, Sea Salt.",
    nutrition: { isOrganic: true, isWholeFood: true },
    sourceUrl: "https://www.target.com/p/organic-unsweetened-creamy-peanut-butter-16oz-good-38-gather-8482/-/A-54516890",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Favorite Day Classic Vanilla Ice Cream",
    brand: "Favorite Day",
    ingredients:
      "Milk, Cream, Skim Milk, Sugar, Corn Syrup, Egg Yolks, Natural Flavor, Mono and Diglycerides, Guar Gum, Locust Bean Gum, Carrageenan, Annatto Extract (Color).",
    sourceUrl: "https://www.target.com/p/vanilla-bean-ice-cream-48oz-favorite-day-8482/-/A-81502235",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Big K Cola Soda, 12 fl oz",
    brand: "Big K",
    ingredients:
      "Carbonated Water, High Fructose Corn Syrup, Caramel Color, Phosphoric Acid, Natural Flavor, Caffeine.",
    sourceUrl: "https://www.kroger.com/p/big-k-cola-soda-cans/0001111049105",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Simple Truth Organic Kombucha Gingerberry, 16 fl oz",
    brand: "Simple Truth Organic",
    ingredients:
      "Purified Water, Organic Kombucha Culture (Water, Organic Cane Sugar, Organic Black Tea, Organic Green Tea, Active Cultures), Organic Ginger Juice, Organic Blueberry Juice, Organic Cane Sugar, Bacillus Coagulans GBI-30 6086.",
    nutrition: { isOrganic: true },
    sourceUrl: "https://www.kroger.com/p/simple-truth-organic-gingerberry-kombucha/0001111002555",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Good & Gather Sparkling Water Pomegranate Dragonfruit, 12 fl oz",
    brand: "Good & Gather",
    ingredients: "Carbonated Water, Natural Flavors.",
    sourceUrl: "https://www.target.com/p/pomegranate-dragon-fruit-sparkling-water-8pk-12-fl-oz-cans-good-38-gather-8482/-/A-54545721",
    verifiedAt: "2026-11-08",
  },
  {
    title: "General Mills Cinnamon Toast Crunch Cereal",
    brand: "General Mills",
    ingredients:
      "Whole Grain Wheat, Sugar, Rice Flour, Canola and/or Sunflower Oil, Fructose, Maltodextrin, Dextrose, Salt, Cinnamon, Trisodium Phosphate, Soy Lecithin, Caramel Color. BHT Added to Preserve Freshness.",
    sourceUrl: "https://www.cinnamontoastcrunch.com/products/cinnamon-toast-crunch",
    verifiedAt: "2026-11-08",
  },
  {
    title: "General Mills Honey Nut Cheerios Cereal",
    brand: "General Mills",
    ingredients:
      "Whole Grain Oats, Sugar, Oat Bran, Corn Starch, Honey, Brown Sugar Syrup, Salt, Tripotassium Phosphate, Canola or Sunflower Oil, Natural Almond Flavor, Vitamin E (Mixed Tocopherols).",
    sourceUrl: "https://www.cheerios.com/products/honey-nut-cheerios",
    verifiedAt: "2026-11-08",
  },
  {
    title: "General Mills Lucky Charms Cereal",
    brand: "General Mills",
    ingredients:
      "Whole Grain Oats, Sugar, Whole Grain Corn, Corn Starch, Corn Syrup, Dextrose, Contains 2% or Less of: Salt, Modified Corn Starch, Gelatin, Trisodium Phosphate, Spirulina Extract, Turmeric Extract, Annatto Extract, Vegetable and Fruit Juice Color, Natural and Artificial Flavor. Vitamin E (mixed tocopherols) Added to Preserve Freshness.",
    sourceUrl: "https://www.luckycharms.com/products/lucky-charms",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Post Oreo Puffs Cereal",
    brand: "Post",
    ingredients:
      "Corn Flour, Sugar, Whole Grain Oat Flour, Cocoa (Processed with Alkali), Canola Oil, Corn Syrup, Unbleached Enriched Flour, Salt, Cornstarch, Palm Oil, Soy Lecithin, Natural and Artificial Flavor, Chocolate Liquor, BHT Added to Preserve Freshness.",
    sourceUrl: "https://www.postconsumerbrands.com/brands/oreo-os/",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Three Wishes Cinnamon Grain-Free Cereal",
    brand: "Three Wishes",
    ingredients: "Chickpea, Tapioca, Pea Protein, Organic Cane Sugar, Cinnamon, Monk Fruit, Salt.",
    sourceUrl: "https://threewishescereal.com/products/cinnamon",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Three Wishes Unsweetened Cocoa Grain-Free Cereal",
    brand: "Three Wishes",
    ingredients: "Chickpea, Tapioca, Pea Protein, Organic Cocoa, Monk Fruit, Salt.",
    sourceUrl: "https://threewishescereal.com/products/cocoa",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Kerrygold Pure Irish Grass-Fed Salted Butter",
    brand: "Kerrygold",
    ingredients: "Pasteurized Cream, Salt.",
    sourceUrl: "https://www.kerrygoldusa.com/products/salted-butter/",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Lactaid 100% Lactose-Free Fat Free Milk",
    brand: "Lactaid",
    ingredients: "Fat Free Milk, Lactase Enzyme, Vitamin A Palmitate, Vitamin D3.",
    sourceUrl: "https://www.lactaid.com/products/lactaid-fat-free-milk",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Great Value Whole Vitamin D Milk, Gallon",
    brand: "Great Value",
    ingredients: "Milk, Vitamin D3.",
    sourceUrl: "https://www.walmart.com/ip/Great-Value-Whole-Vitamin-D-Milk-Gallon-128-fl-oz/10450114",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Chobani Non-Fat Plain Greek Yogurt",
    brand: "Chobani",
    ingredients: "Cultured Nonfat Milk.",
    sourceUrl: "https://www.chobani.com/products/greek/plain/non-fat-plain",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Dave's Killer Bread Organic 21 Whole Grains & Seeds",
    brand: "Dave's Killer Bread",
    ingredients:
      "Organic Whole Wheat, Water, Organic Cane Sugar, Organic Cracked Whole Wheat, Organic 21 Whole Grains and Seeds Mix, Organic Vital Wheat Gluten, Organic Oat Fiber, Yeast, Sea Salt.",
    nutrition: { isOrganic: true },
    sourceUrl: "https://www.daveskillerbread.com/21-whole-grains-and-seeds",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Santa Cruz Organic Dark Roasted Peanut Butter",
    brand: "Santa Cruz Organic",
    ingredients: "Organic Roasted Peanuts, Salt (1% or less).",
    nutrition: { isOrganic: true },
    sourceUrl: "https://www.santacruzorganic.com/products/peanut-butter/dark-roasted-creamy-peanut-butter",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Jif Creamy Peanut Butter",
    brand: "Jif",
    ingredients: "Made From Roasted Peanuts And Sugar, Contains 2% Or Less Of: Molasses, Fully Hydrogenated Vegetable Oils (Rapeseed And Soybean), Mono And Diglycerides, Salt.",
    sourceUrl: "https://www.jif.com/ peanut-butter/creamy/creamy-peanut-butter".replace(/\s+/g, ""),
    verifiedAt: "2026-11-08",
  },
  {
    title: "Oreo Chocolate Sandwich Cookies",
    brand: "Nabisco",
    ingredients:
      "Unbleached Enriched Flour, Sugar, Palm or Canola Oil, Cocoa (Processed with Alkali), High Fructose Corn Syrup, Leavening (Baking Soda or Calcium Phosphate), Salt, Soy Lecithin, Chocolate, Artificial Flavor.",
    sourceUrl: "https://www.oreo.com/products/oreo-original",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Cheez-It Original Baked Snack Crackers",
    brand: "Cheez-It",
    ingredients:
      "Enriched Flour, Vegetable Oil (High Oleic Soybean, Soybean, Palm, or Canola Oil with TBHQ for Freshness), Cheese Made with Skim Milk, Salt, Paprika, Yeast, Paprika Extract Color, Soy Lecithin, Annatto Extract Color.",
    sourceUrl: "https://www.cheezit.com/en_US/products/crackers/cheez-it-original-snack-crackers-product.html",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Pepperidge Farm Goldfish Cheddar Crackers",
    brand: "Pepperidge Farm",
    ingredients:
      "Enriched Wheat Flour, Cheddar Cheese (Cultured Milk, Salt, Enzymes, Annatto), Vegetable Oils (Canola, Sunflower or Soybean), Salt, Yeast, Sugar, Autolyzed Yeast Extract, Paprika, Spices, Celery, Onion Powder, Monocalcium Phosphate, Baking Soda.",
    sourceUrl: "https://www.pepperidgefarm.com/product/goldfish-cheddar-crackers/",
    verifiedAt: "2026-11-08",
  },
  {
    title: "Hu Simple Organic 70% Dark Chocolate Bar",
    brand: "Hu Kitchen",
    ingredients: "Organic Fair-Trade Cacao, Unrefined Organic Coconut Sugar, Organic Fair-Trade Cocoa Butter.",
    nutrition: { isOrganic: true },
    sourceUrl: "https://hukitchen.com/products/simple-dark-chocolate",
    verifiedAt: "2026-11-08",
  },
];

// Merge comprehensive Drinks Catalog + popular grocery items + clean alternatives into the autocomplete index
const FULL_INDEX: SuggestEntry[] = (() => {
  const seen = new Set<string>();
  const out: SuggestEntry[] = [];
  for (const drink of DRINKS_CATALOG) {
    if (!hasValidCatalogProvenance(drink.sourceUrl, drink.verifiedAt) || drink.title.includes("/") || drink.brand.includes("/")) {
      continue;
    }
    const k = drink.title.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push({
        title: drink.title,
        brand: drink.brand,
        category: drink.category,
        description: drink.description,
        ingredients: drink.ingredients,
        keywords: drink.keywords,
        nutrition: drink.nutrition,
        sourceUrl: drink.sourceUrl,
        verifiedAt: drink.verifiedAt,
      });
    }
  }
  for (const item of POPULAR_GROCERY_INDEX) {
    if (!hasValidCatalogProvenance(item.sourceUrl, item.verifiedAt) || item.title.includes("/") || item.brand.includes("/")) {
      continue;
    }
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
      out.push({ title, brand: alt.brand, category: alt.category, ingredients: alt.ingredients });
    }
  }
  for (const entry of EXACT_PRODUCT_ALTERNATIVES) {
    const alt = entry.alt;
    const title = `${alt.brand} ${alt.name}`.trim();
    const k = title.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ title, brand: alt.brand, category: alt.category, ingredients: alt.ingredients });
    }
  }
  return out;
})();

export async function GET(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "anon";
  if (!checkRateLimit(`suggest:${ip}`, 120)) {
    return NextResponse.json(
      { ok: false, suggestions: [], error: "Rate limit exceeded" },
      { status: 429, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || "").trim().toLowerCase();
  if (!q) {
    return NextResponse.json({ ok: true, suggestions: [] }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  const tokens = q.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) {
    return NextResponse.json({ ok: true, suggestions: [] }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }
  const scored: Array<{ entry: SuggestEntry; rank: number }> = [];

  for (const entry of FULL_INDEX) {
    const titleLower = entry.title.toLowerCase();
    const brandLower = entry.brand.toLowerCase();
    const catLower = (entry.category || "").toLowerCase();
    const kwLower = (entry.keywords || []).join(" ").toLowerCase();
    const hay = `${titleLower} ${brandLower} ${catLower} ${kwLower}`;
    const hayWords = hay.split(/[^a-z0-9]+/).filter(Boolean);

    // Every query token must match a word prefix (or 4+ char substring) — prevents "red" in "red bull" from matching "reduced" or "cultured"
    const matchedTokens = tokens.filter((t) =>
      hayWords.some((w) => w.startsWith(t) || (t.length >= 4 && w.includes(t))),
    );
    if (matchedTokens.length < tokens.length) continue;

    let rank = matchedTokens.length * 15;
    if (titleLower.startsWith(q) || brandLower.startsWith(q)) rank += 40;
    else if (titleLower.includes(q) || brandLower.includes(q)) rank += 25;
    else if (kwLower.includes(q)) rank += 18;
    if (hayWords.some((w) => w === tokens[0])) rank += 12;
    scored.push({ entry, rank });
  }

  scored.sort((a, b) => b.rank - a.rank);

  const suggestions = scored.slice(0, 10).map(({ entry }) => {
    const res = scoreProductYuka(entry.ingredients, {}, [], {
      ...entry.nutrition,
      productTitle: entry.title,
    });
    return {
      title: entry.title,
      brand: entry.brand,
      category: entry.category || "Grocery",
      description: entry.description || "",
      ingredients: entry.ingredients,
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
