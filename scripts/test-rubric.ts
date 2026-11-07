import { scoreIngredients, scoreProductYuka, normalizeIngredients, isEnglishIngredientText } from "../lib/rubric";
import { PRESETS } from "../lib/presets";
import { CLEAN_ALTERNATIVES, EXACT_PRODUCT_ALTERNATIVES, resolveSwap } from "../lib/swaps";

let fail = 0;
const check = (label: string, cond: boolean) => { if (!cond) { fail++; console.log("FAIL", label); } };

for (const p of PRESETS) {
  const r = scoreIngredients(p.ingredients);
  const r2 = scoreIngredients(p.ingredients);
  check(`${p.id} deterministic`, JSON.stringify(r) === JSON.stringify(r2));
  console.log(p.id.padEnd(10), r.score, r.rating, r.flagged.map((f) => f.name).join(", "));
  const s = resolveSwap({ score: r.score, productTitle: p.title, store: "walmart" });
  if (s) console.log("   swap ->", s.title, s.score, s.deepLink);
}
for (const a of Object.values(CLEAN_ALTERNATIVES)) {
  const r = scoreIngredients(a.ingredients);
  const ry = scoreProductYuka(a.ingredients, {}, [], { productTitle: `${a.brand} ${a.name}` });
  const b = ry.yukaBreakdown!;
  check(`${a.brand} ${a.name} >= 90 (${r.score} ${r.flagged.map((f) => f.name)})`, r.score >= 90);
  check(`${a.brand} additiveScore === 30 (${b.additiveScore})`, b.additiveScore === 30);
  check(`${a.brand} 3-pillar sum matches score (${ry.score} vs ${b.nutritionScore + b.additiveScore + b.organicScore})`, ry.score === b.nutritionScore + b.additiveScore + b.organicScore);
}
for (const entry of EXACT_PRODUCT_ALTERNATIVES) {
  const a = entry.alt;
  const r = scoreIngredients(a.ingredients);
  const ry = scoreProductYuka(a.ingredients, {}, [], { productTitle: `${a.brand} ${a.name}` });
  const b = ry.yukaBreakdown!;
  check(`1-for-1 ${a.brand} ${a.name} >= 90 (${r.score} ${r.flagged.map((f) => f.name)})`, r.score >= 90);
  check(`1-for-1 ${a.brand} ${a.name} additiveScore === 30 (${b.additiveScore})`, b.additiveScore === 30);
  check(`1-for-1 ${a.brand} ${a.name} 3-pillar sum matches score (${ry.score} vs ${b.nutritionScore + b.additiveScore + b.organicScore})`, ry.score === b.nutritionScore + b.additiveScore + b.organicScore);
}
const sieteCheck = scoreProductYuka(
  "Cassava flour, avocado oil, coconut flour, ground chia seed, sea salt.",
  {},
  [],
  { productTitle: "Siete Grain-Free Sea Salt Tortilla Chips, 5 oz", caloriesKcal100g: 464, saturatedFatG100g: 2.5, sodiumMg100g: 428, sugarsG100g: 1.8, fiberG100g: 3.6, proteinG100g: 3.6 },
);
check(
  `Siete Tortilla Chips does not falsely score 100/100 and matches 3 pillars (${sieteCheck.score})`,
  sieteCheck.score < 90 &&
    sieteCheck.score ===
      sieteCheck.yukaBreakdown!.nutritionScore +
        sieteCheck.yukaBreakdown!.additiveScore +
        sieteCheck.yukaBreakdown!.organicScore,
);
// 1-for-1 exact product swap checks
check("1-for-1 salted butter -> butter (not milk)", Boolean(resolveSwap({ score: 54, productTitle: "Great Value Sweet Cream Salted Butter", store: "walmart" })?.title.includes("Salted Butter")));
check("1-for-1 unsalted butter -> unsalted butter", Boolean(resolveSwap({ score: 54, productTitle: "Great Value Sweet Cream Unsalted Butter", store: "walmart" })?.title.includes("Unsalted Butter")));
check("1-for-1 whole milk -> whole milk", Boolean(resolveSwap({ score: 54, productTitle: "Great Value Whole Vitamin D Milk", store: "walmart" })?.title.includes("Whole Milk")));
check("1-for-1 2% milk -> 2% milk", Boolean(resolveSwap({ score: 54, productTitle: "Great Value 2% Reduced Fat Milk", store: "walmart" })?.title.includes("2% Reduced Fat Milk")));
check("1-for-1 coffee creamer -> coffee creamer", Boolean(resolveSwap({ score: 35, productTitle: "Coffee mate French Vanilla Liquid Coffee Creamer", store: "walmart" })?.title.includes("Coffee Creamer")));
check("1-for-1 tortilla chips -> tortilla chips", Boolean(resolveSwap({ score: 45, productTitle: "Doritos Nacho Cheese Tortilla Chips", store: "walmart" })?.title.includes("Tortilla Chips")));
check("1-for-1 bacon -> bacon", Boolean(resolveSwap({ score: 30, productTitle: "Oscar Mayer Original Naturally Hardwood Smoked Bacon", store: "walmart" })?.title.includes("Bacon")));
// Edge cases
check("corn chips no corn oil", !scoreIngredients("Corn, sunflower oil, salt").flagged.some((f) => f.id === "cornoil"));
check("corn list no corn oil", !scoreIngredients("Ground corn, safflower or sunflower oil, salt").flagged.some((f) => f.id === "cornoil"));
check("veg oil parenthetical corn", scoreIngredients("Vegetable oil (corn, canola)").flagged.some((f) => f.id === "cornoil"));
check("hfcs not double", scoreIngredients("high fructose corn syrup").flagged.length === 1);
check("fd&c red no. 40", scoreIngredients("FD&C Red No. 40").flagged[0]?.id === "red40");
check("mono- and diglycerides", scoreIngredients("Mono- and Diglycerides").flagged[0]?.id === "monodiglycerides");
check("nat+art flavors", scoreIngredients("Natural and Artificial Flavors").flagged.length === 2);
check("watchlist off", scoreIngredients("soybean oil", { seedOils: false }).score === 100);
check("clamp", scoreIngredients("red 40, red 3, yellow 5, yellow 6").score === 0);
check("calories ignored", scoreIngredients("sugar, salt, butter, cream").score === 100);
check("disodium phosphate", scoreIngredients("disodium phosphate").flagged[0]?.id === "naphosphate");
check("high risk cap at 49", scoreIngredients("Cultured milk, strawberries, red 40").score === 49 && scoreIngredients("Cultured milk, strawberries, red 40").rating === "Poor");
check("watchlist 2x multiplier", scoreIngredients("water, sucralose", { sweeteners: "2x" }).score === 60);
check("non-bromated flour not flagged", scoreIngredients("Unbleached non-bromated wheat flour, water, sea salt").score === 100);
check("no sodium nitrite claim not flagged", scoreIngredients("Pork, water, sea salt, no sodium nitrite, no artificial flavors").score === 100);
check("safflower extract not flagged as oil", scoreIngredients("Organic apple puree, safflower for color, grape seed extract").score === 100);
check("bvo high risk cap", scoreIngredients("Carbonated water, sugar, brominated vegetable oil").score === 49);
check("caramel color & edta & datem & msg", scoreIngredients("Water, caramel color, calcium disodium edta, datem, monosodium glutamate").flagged.length === 4);
check("french ingredients rejected", !isEnglishIngredientText("Eau gazéifiée, sucre, sirop de glucose-fructose, colorant caramel, acide phosphorique, arômes naturels"));
check("english ingredients accepted", isEnglishIngredientText("Carbonated water, high fructose corn syrup, caramel color, phosphoric acid, phosphoric acid, natural flavors"));
check("comma boundary corn, oil of lemon", !scoreIngredients("Organic Corn, Oil of Lemon").flagged.some((f) => f.id === "cornoil"));
check("shared dye prefix Yellow 5 & 6", scoreIngredients("Water, Yellow 5 & 6").flagged.some((f) => f.id === "yellow5") && scoreIngredients("Water, Yellow 5 & 6").flagged.some((f) => f.id === "yellow6"));
check("shared oil suffix sunflower and soybean oil", scoreIngredients("Potatoes, sunflower and soybean oil, salt").flagged.some((f) => f.id === "sunfloweroil") && scoreIngredients("Potatoes, sunflower and soybean oil, salt").flagged.some((f) => f.id === "soybeanoil"));
check("shortening parenthetical soybean, cottonseed", scoreIngredients("Vegetable shortening (soybean, cottonseed)").flagged.some((f) => f.id === "soybeanoil") && scoreIngredients("Vegetable shortening (soybean, cottonseed)").flagged.some((f) => f.id === "cottonseedoil"));
check("familyWatchlist array 2x multiplier", scoreIngredients("Potatoes, sunflower oil, salt", {}, ["seedOils"]).score === 60);
check("tier 1 industrial seed oil high risk cap <= 49", scoreIngredients("Potatoes, canola oil, salt").score === 49 && scoreIngredients("Potatoes, soybean oil, salt").score === 49);
check("tier 2 sunflower oil capped <= 59 Mediocre in Yuka", scoreProductYuka("Organic potatoes, sunflower oil, sea salt").score <= 59 && scoreProductYuka("Organic potatoes, sunflower oil, sea salt").rating === "Mediocre");
check("tier 3 avocado oil scores Green >= 80 in Yuka", scoreProductYuka("Organic potatoes, avocado oil, sea salt").score >= 80 && scoreProductYuka("Organic potatoes, avocado oil, sea salt").rating === "Excellent");
check("adding citric acid never increases Yuka score", scoreProductYuka("Sugar, water, citric acid", {}, [], { nutriScoreGrade: "e" }).score <= scoreProductYuka("Sugar, water", {}, [], { nutriScoreGrade: "e" }).score);
check("tripotassium & tricalcium phosphate", scoreIngredients("Whole grain oats, tripotassium phosphate, tricalcium phosphate").flagged.some((f) => f.id === "naphosphate"));
check("swap deepLink uses https universal link", Boolean(resolveSwap({ score: 40, productTitle: "Strawberry Yogurt", store: "walmart" })?.deepLink.startsWith("https://")));
check("Capri Sun scores Poor <= 24 and swaps to Spindrift with drink.png", (() => {
  const s = scoreProductYuka("Water, sugar, pear and grape juice concentrate, citric acid, strawberry and kiwi juice concentrate, natural flavor.", {}, [], { productTitle: "Capri Sun Strawberry Kiwi Juice Pouches" });
  const sw = resolveSwap({ score: s.score, productTitle: "Capri Sun Strawberry Kiwi Juice Pouches", store: "aldi" });
  return s.score <= 24 && s.rating === "Poor" && Boolean(sw?.title.includes("Spindrift")) && sw?.image === "/swaps/drink.png";
})());
check("100% Orange Juice never scores 100 (scores <= 75)", (() => {
  const conv = scoreProductYuka("100% pure squeezed pasteurized orange juice.", {}, [], { productTitle: "100% Pure Squeezed Orange Juice" });
  const org = scoreProductYuka("100% organic pasteurized orange juice.", {}, [], { productTitle: "Uncle Matt's Organic 100% Pulp-Free Orange Juice" });
  return conv.score === 64 && org.score === 74;
})());
check("Ben & Jerry's Half-Baked scores <= 35 (matches 3-pillar sum, never 100)", (() => {
  const s = scoreProductYuka("Cream, skim milk, liquid sugar, water, wheat flour, brown sugar, sugar, cocoa, egg yolks, butter, soybean oil, eggs, guar gum, carrageenan.", {}, [], { productTitle: "Ben & Jerry's Half-Baked Ice Cream" });
  const cleanIceCream = scoreProductYuka("Cream, skim milk, cane sugar, egg yolks, vanilla extract.", {}, [], { productTitle: "Ben & Jerry's Vanilla Ice Cream" });
  return s.score <= 35 && cleanIceCream.score === 32;
})());
check("French's Original Crispy Fried Onions scores <= 35 (never 100)", (() => {
  const s = scoreProductYuka("Onions, palm oil, enriched flour, soy flour, salt, dextrose.", {}, [], { productTitle: "French's Original Crispy Fried Onions" });
  const sw = resolveSwap({ score: s.score, productTitle: "French's Original Crispy Fried Onions", store: "aldi" });
  return s.score <= 35 && Boolean(sw?.title.includes("Yellow Onions")) && sw?.image === "/swaps/produce.png";
})());
check("Butterball Whole Turkey scores 72 Mediocre (42 + 30 + 0)", (() => {
  const s = scoreProductYuka("Whole young turkey, water, salt.", {}, [], { productTitle: "Butterball Frozen Whole Turkey" });
  return s.score === 72 && s.rating === "Mediocre";
})());
console.log(normalizeIngredients("Vegetable Oil (Soybean, Canola and/or Sunflower), corn, safflower or sunflower oil"));
console.log(fail ? `${fail} FAILED` : "ALL CHECKS PASSED");
process.exit(fail ? 1 : 0);
