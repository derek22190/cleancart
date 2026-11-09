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
  const fullTitle = `${a.brand} ${a.name}`;
  const isOrganic = a.isOrganic ?? /\b(organic|organics)\b/i.test(fullTitle);
  const ry = scoreProductYuka(a.ingredients, {}, [], { productTitle: fullTitle, isOrganic });
  const b = ry.yukaBreakdown!;
  check(`${a.brand} ${a.name} >= 90 (${r.score} ${r.flagged.map((f) => f.name)})`, r.score >= 90);
  check(`${a.brand} additiveScore === 30 (${b.additiveScore})`, b.additiveScore === 30);
  check(`${a.brand} 3-pillar sum matches score (${ry.score} vs ${b.nutritionScore + b.additiveScore + b.organicScore})`, ry.score === b.nutritionScore + b.additiveScore + b.organicScore);
}
for (const entry of EXACT_PRODUCT_ALTERNATIVES) {
  const a = entry.alt;
  const r = scoreIngredients(a.ingredients);
  const fullTitle = `${a.brand} ${a.name}`;
  const isOrganic = a.isOrganic ?? /\b(organic|organics)\b/i.test(fullTitle);
  const ry = scoreProductYuka(a.ingredients, {}, [], { productTitle: fullTitle, isOrganic });
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
check("swap deepLink uses https universal link", Boolean(resolveSwap({ score: 40, productTitle: "Strawberry Yogurt", store: "walmart" })?.deepLink?.startsWith("https://")));
check("Capri Sun scores Poor <= 24 and swaps to Spindrift with drink.png", (() => {
  const s = scoreProductYuka("Water, sugar, pear and grape juice concentrate, citric acid, strawberry and kiwi juice concentrate, natural flavor.", {}, [], { productTitle: "Capri Sun Strawberry Kiwi Juice Pouches" });
  const sw = resolveSwap({ score: s.score, productTitle: "Capri Sun Strawberry Kiwi Juice Pouches", store: "aldi" });
  return s.score <= 24 && s.rating === "Poor" && Boolean(sw?.title.includes("Spindrift")) && sw?.image === "/swaps/drink.png";
})());
check("100% Orange Juice never scores 100 (scores <= 75)", (() => {
  const conv = scoreProductYuka("100% pure squeezed pasteurized orange juice.", {}, [], { productTitle: "100% Pure Squeezed Orange Juice" });
  const org = scoreProductYuka("100% organic pasteurized orange juice.", {}, [], { productTitle: "Uncle Matt's Organic 100% Pulp-Free Orange Juice", isOrganic: true });
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
check("Siete Grain-Free Sea Salt Tortilla Chips scores 72 (42 + 30 + 0) with Glucose Insight", (() => {
  const s = scoreProductYuka("Cassava Flour, Avocado Oil, Coconut Flour, Chia Seed, Sea Salt.", {}, [], {
    productTitle: "Siete Grain-Free Sea Salt Tortilla Chips, 5 oz",
    nutriScoreGrade: "c",
    isOrganic: false,
  });
  return s.score === 72 && s.yukaBreakdown?.nutritionScore === 42 && s.yukaBreakdown?.additiveScore === 30 && s.yukaBreakdown?.organicScore === 0 && Boolean(s.yukaBreakdown?.glucoseImpact);
})());
check("Diet Coke never claims High Sugar, High Saturated Fat, or High Calorie Density", (() => {
  const s = scoreProductYuka(
    "Carbonated water, caramel color, aspartame, phosphoric acid, potassium benzoate (to protect taste), natural flavors, citric acid, caffeine.",
    {},
    [],
    { productTitle: "Diet Coke, 12 fl oz Cans" },
  );
  const hasFalseNutrition = s.flagged.some((f) =>
    f.id === "nutri_sugar" || f.id === "nutri_satfat" || f.id === "nutri_calories" || /\bg\s*\/\s*100g\b|\bkcal\s*\/\s*100g\b/i.test(f.name),
  );
  return !hasFalseNutrition && s.flagged.some((f) => f.id === "aspartame") && s.flagged.some((f) => f.id === "caramelcolor");
})());
check("Pure maple syrup, honey, Kerrygold butter, and organic cane sugar never score 100", (() => {
  const maple = scoreProductYuka("100% Pure Organic Grade A Dark Robust Maple Syrup.", {}, [], { productTitle: "100% Pure Organic Maple Syrup" });
  const honey = scoreProductYuka("100% Pure Raw Unfiltered Honey.", {}, [], { productTitle: "Raw Unfiltered Honey" });
  const butter = scoreProductYuka("Pasteurized Cream, Salt.", {}, [], { productTitle: "Kerrygold Pure Irish Salted Butter" });
  const orgSugar = scoreProductYuka("Organic Cane Sugar, Water.", {}, [], { productTitle: "Organic Simple Syrup" });
  return maple.score <= 65 && honey.score <= 65 && butter.score < 60 && orgSugar.score <= 65;
})());
check("Measured nutrition emits verified numeric flag, while unmeasured estimation never emits numeric g/100g claim", (() => {
  const unmeasured = scoreProductYuka("Cream, skim milk, cane sugar, egg yolks, vanilla extract.", {}, [], { productTitle: "Vanilla Ice Cream" });
  const measured = scoreProductYuka("Cream, skim milk, cane sugar, egg yolks, vanilla extract.", {}, [], {
    productTitle: "Vanilla Ice Cream",
    sugarsG100g: 24,
    saturatedFatG100g: 11,
  });
  return (
    !unmeasured.flagged.some((f) => /\bg\s*\/\s*100g\b/.test(f.name)) &&
    measured.flagged.some((f) => f.id === "nutri_sugar" && f.name.includes("24g / 100g")) &&
    measured.flagged.some((f) => f.id === "nutri_satfat" && f.name.includes("11g / 100g"))
  );
})());
import { DRINKS_CATALOG, matchDrinkCatalog } from "../lib/drinks-catalog";

check("DRINKS_CATALOG has >= 60 entries with descriptions & ingredients", DRINKS_CATALOG.length >= 60 && DRINKS_CATALOG.every((d) => d.description.length > 20 && d.ingredients.length > 10));
check("Monster Energy lookup + Poor score + Guayaki swap", (() => {
  const m = matchDrinkCatalog("monster");
  if (!m) return false;
  const s = scoreProductYuka(m.ingredients, {}, [], { ...m.nutrition, productTitle: m.title });
  const sw = resolveSwap({ score: s.score, productTitle: m.title, store: "walmart" });
  return m.brand === "Monster Energy" && s.score <= 25 && s.rating === "Poor" && Boolean(sw?.title.includes("Guayakí"));
})());
check("White Monster / Monster Zero Ultra lookup + Poor score + Guayaki swap", (() => {
  const m = matchDrinkCatalog("white monster");
  if (!m) return false;
  const s = scoreProductYuka(m.ingredients, {}, [], { ...m.nutrition, productTitle: m.title });
  const sw = resolveSwap({ score: s.score, productTitle: m.title, store: "walmart" });
  return m.title.includes("Zero Ultra") && s.score <= 45 && s.rating === "Poor" && Boolean(sw?.title.includes("Guayakí"));
})());
check("Red Bull lookup + Poor score + Guayaki swap", (() => {
  const m = matchDrinkCatalog("red bull");
  if (!m) return false;
  const s = scoreProductYuka(m.ingredients, {}, [], { ...m.nutrition, productTitle: m.title });
  const sw = resolveSwap({ score: s.score, productTitle: m.title, store: "walmart" });
  return m.brand === "Red Bull" && s.score <= 25 && s.rating === "Poor" && Boolean(sw?.title.includes("Guayakí"));
})());
check("C4 Pre-Workout lookup + Poor score + Ora Organic Pre-Workout swap", (() => {
  const m = matchDrinkCatalog("c4 pre workout");
  if (!m) return false;
  const s = scoreProductYuka(m.ingredients, {}, [], { ...m.nutrition, productTitle: m.title });
  const sw = resolveSwap({ score: s.score, productTitle: m.title, store: "walmart" });
  return m.category === "Pre-Workouts & Fitness" && s.score <= 45 && Boolean(sw?.title.includes("Ora Organic"));
})());
check("Core Power Protein Shake lookup + Orgain Protein Shake swap", (() => {
  const m = matchDrinkCatalog("core power");
  if (!m) return false;
  const s = scoreProductYuka(m.ingredients, {}, [], { ...m.nutrition, productTitle: m.title });
  const sw = resolveSwap({ score: s.score, productTitle: m.title, store: "walmart" });
  return s.score < 75 && Boolean(sw?.title.includes("Orgain"));
})());
check("Fiji Water & Spindrift score >= 90 Excellent", (() => {
  const fiji = matchDrinkCatalog("fiji water")!;
  const spin = matchDrinkCatalog("spindrift")!;
  const sf = scoreProductYuka(fiji.ingredients, {}, [], { ...fiji.nutrition, productTitle: fiji.title });
  const ss = scoreProductYuka(spin.ingredients, {}, [], { ...spin.nutrition, productTitle: spin.title });
  return sf.score >= 90 && ss.score >= 90;
})());
check("1-for-1 cheese tortilla chips -> Siete Tortilla Chips (not block cheese)", Boolean(resolveSwap({ score: 12, productTitle: "Clancy's Nacho Cheese Tortilla Chips", store: "aldi" })?.title.includes("Tortilla Chips")));
check("1-for-1 Park Street Deli Hummus -> Hope Foods Organic Hummus (not turkey)", Boolean(resolveSwap({ score: 49, productTitle: "Park Street Deli Classic Hummus", store: "aldi" })?.title.includes("Hummus")));
check("1-for-1 Ore-Ida French Fries -> Organic Yukon Gold Potatoes (not fruit bar)", Boolean(resolveSwap({ score: 49, productTitle: "Ore-Ida Golden Crinkles French Fries", store: "aldi" })?.title.includes("Potatoes")));
check("1-for-1 A.1. Steak Sauce -> Primal Kitchen Steak & BBQ Sauce (not roast beef)", Boolean(resolveSwap({ score: 18, productTitle: "A.1. Original Steak Sauce", store: "aldi" })?.title.includes("Sauce")));
check("1-for-1 Oreo Puffs Cereal -> Nature's Path Organic Heritage Flakes (not cookies)", Boolean(resolveSwap({ score: 6, productTitle: "Oreo Puffs Cereal", store: "aldi" })?.title.includes("Heritage Flakes")));
check("Monster Energy Zero Sugar / Monster Ultra Zero / Sugar Free Monster never return sucrose or glucose", (() => {
  const queries = ["Monster Energy Zero Sugar", "Monster Ultra Zero", "Sugar Free Monster"];
  return queries.every((q) => {
    const m = matchDrinkCatalog(q);
    return (
      Boolean(m) &&
      (m!.nutrition.sugarsG100g ?? 0) === 0 &&
      !/\b(sucrose|glucose)\b/i.test(m!.ingredients)
    );
  });
})());
check("1-for-1 Maruchan Ramen Noodle Soup -> Lotus Foods Organic Millet & Brown Rice Ramen", Boolean(resolveSwap({ score: 0, productTitle: "Maruchan Ramen Noodle Soup, Chicken Flavor, 3 oz", store: "walmart" })?.title.includes("Lotus Foods")));

import Module from "module";
const origLoad = (Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown })._load;
(Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown })._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};

(async () => {
  const { runScan } = await import("../lib/scan");
  const ramenScan = await runScan({
    productTitle: "Maruchan Ramen Noodle Soup, Chicken Flavor, 3 oz, 12 Count",
    store: "walmart",
    dietaryWatchlist: ["wheat_gluten", "soy", "high_sodium"],
  });
  check(
    "Maruchan Ramen Noodle Soup scores Poor (<= 15) and triggers checked Wheat/Soy/Sodium alerts",
    Boolean(
      ramenScan.ok &&
      (ramenScan.result?.score ?? 100) <= 15 &&
      ramenScan.result?.rating === "Poor" &&
      (ramenScan.dietaryAlerts?.length ?? 0) >= 3 &&
      ramenScan.swap?.title.includes("Lotus Foods")
    )
  );

  const ramenUncheckedScan = await runScan({
    productTitle: "Maruchan Ramen Noodle Soup, Chicken Flavor, 3 oz, 12 Count",
    store: "walmart",
    dietaryWatchlist: [],
  });
  check(
    "Dietary alerts are empty when user has not checked any allergy/diabetes boxes",
    Boolean(ramenUncheckedScan.ok && (ramenUncheckedScan.dietaryAlerts?.length ?? 0) === 0)
  );

  const promoBannerScan = await runScan({
    productTitle: "A full Thanksgiving meal, Turkey, classic sides & more.",
    store: "walmart",
  });
  check(
    "Promotional Thanksgiving meal banner is ignored (422 status)",
    Boolean(!promoBannerScan.ok && promoBannerScan.status === 422)
  );

  // Step 4f & High 1 / High 3 / High 4 / Step 3 / Step 6 Regression Assertions
  check(
    "DRINKS_CATALOG has 0 multi-brand '/' entries and every entry has sourceUrl + verifiedAt",
    DRINKS_CATALOG.every(
      (d) =>
        !d.brand.includes("/") &&
        Boolean(d.sourceUrl && d.sourceUrl.startsWith("https://")) &&
        Boolean(d.verifiedAt && !Number.isNaN(Date.parse(d.verifiedAt)))
    )
  );

  const silkSoyScan = await runScan({ productTitle: "Silk Soymilk Original", store: "walmart" });
  check(
    "Silk Soymilk lists soy and NEVER lists almonds",
    Boolean(
      silkSoyScan.ok &&
      /\bsoybeans?\b/i.test(silkSoyScan.product?.ingredients ?? "") &&
      !/\balmonds?\b/i.test(silkSoyScan.product?.ingredients ?? "")
    )
  );

  const liquidDeathWaterScan = await runScan({ productTitle: "Liquid Death Mountain Water", store: "walmart" });
  check(
    "Liquid Death Mountain Water returns plain mountain water only and scores 100/100",
    Boolean(
      liquidDeathWaterScan.ok &&
      /^mountain water\.?$/i.test((liquidDeathWaterScan.product?.ingredients ?? "").trim()) &&
      liquidDeathWaterScan.result?.score === 100 &&
      liquidDeathWaterScan.result?.yukaBreakdown?.organicScore === 0
    )
  );

  const doritosNkdScan = await runScan({ productTitle: "Doritos Simply NKD Nacho Cheese Tortilla Chips", store: "walmart" });
  check(
    "Doritos Simply NKD does not list Red 40, Yellow 5, or Yellow 6",
    Boolean(
      doritosNkdScan.ok &&
      !/\b(red\s*40|yellow\s*5|yellow\s*6)\b/i.test(doritosNkdScan.product?.ingredients ?? "")
    )
  );

  const luckyCharmsScan = await runScan({ productTitle: "General Mills Lucky Charms Cereal", store: "walmart" });
  check(
    "Lucky Charms does not list Red 40, Yellow 5, Yellow 6, or Blue 1",
    Boolean(
      luckyCharmsScan.ok &&
      !/\b(red\s*40|yellow\s*5|yellow\s*6|blue\s*1)\b/i.test(luckyCharmsScan.product?.ingredients ?? "")
    )
  );

  const pedialyteUnflavored = matchDrinkCatalog("Pedialyte Unflavored Electrolyte Solution");
  check(
    "Pedialyte Unflavored Electrolyte Solution does not list Red 40, sucralose, or acesulfame potassium",
    Boolean(
      pedialyteUnflavored &&
      pedialyteUnflavored.id === "pedialyte-unflavored" &&
      !/\b(red\s*40|sucralose|acesulfame)\b/i.test(pedialyteUnflavored.ingredients)
    )
  );

  const planetOatExtraCreamy = matchDrinkCatalog("Planet Oat Extra Creamy Oatmilk");
  check(
    "Planet Oat Extra Creamy Oatmilk lists sunflower oil",
    Boolean(
      planetOatExtraCreamy &&
      planetOatExtraCreamy.id === "planet-oat-extra-creamy" &&
      /\bsunflower\s+oil\b/i.test(planetOatExtraCreamy.ingredients)
    )
  );

  const doubleshot = matchDrinkCatalog("Starbucks Doubleshot Espresso and Cream");
  check(
    "Starbucks Doubleshot Espresso matches dedicated Doubleshot entry (not Frappuccino Mocha)",
    Boolean(doubleshot && doubleshot.id === "starbucks-doubleshot-espresso")
  );

  const owynProElite = matchDrinkCatalog("OWYN Pro Elite Vanilla Protein Shake");
  check(
    "OWYN Pro Elite Vanilla Protein Shake matches dedicated 0g-sugar Pro Elite entry (no cane sugar)",
    Boolean(
      owynProElite &&
      owynProElite.id === "owyn-pro-elite-shake" &&
      !/\bcane\s+sugar\b/i.test(owynProElite.ingredients)
    )
  );

  const itoEnRegular = matchDrinkCatalog("Ito En Oi Ocha Unsweetened Green Tea");
  const itoEnOrganic = matchDrinkCatalog("Ito En Organic Green Tea");
  check(
    "Ito En regular Oi Ocha is not marked USDA Organic, while Ito En Organic Green Tea is",
    Boolean(
      itoEnRegular &&
      itoEnRegular.nutrition.isOrganic === false &&
      itoEnOrganic &&
      itoEnOrganic.nutrition.isOrganic === true
    )
  );

  const teaOrganicCheck = scoreProductYuka("Water, Organic Green Tea", {}, [], {
    productTitle: "Tea",
    isOrganic: false,
  });
  check(
    "High 3: scoreProductYuka('Water, Organic Green Tea', {}, [], {productTitle:'Tea', isOrganic:false}) returns organicScore === 0",
    teaOrganicCheck.yukaBreakdown?.organicScore === 0
  );

  const spikeCheck = scoreProductYuka("Sugar, corn syrup, enriched wheat flour", {}, [], {
    productTitle: "Sweet Pastry",
  });
  check(
    "High 4: yukaBreakdown never emits blood-glucose 'Spike' predictions",
    Boolean(
      spikeCheck.yukaBreakdown &&
      !/spike/i.test(spikeCheck.yukaBreakdown.glucoseImpact ?? "") &&
      !/glycemic profile/i.test(spikeCheck.yukaBreakdown.glucoseNote ?? "")
    )
  );

  const extSwap = resolveSwap({ score: 20, productTitle: "Coca-Cola Classic", store: "amazon", surface: "extension" });
  const androidSwap = resolveSwap({ score: 20, productTitle: "Coca-Cola Classic", store: "amazon", surface: "android" });
  const webSwap = resolveSwap({ score: 20, productTitle: "Coca-Cola Classic", store: "amazon", surface: "web" });
  check(
    "Step 3: extension and unapproved android never attach Amazon affiliate tag, while web does",
    Boolean(
      extSwap && !(extSwap.deepLink ?? "").includes("tag=") && !extSwap.isPaidLink &&
      androidSwap && !(androidSwap.deepLink ?? "").includes("tag=") && !androidSwap.isPaidLink &&
      webSwap && (webSwap.deepLink ?? "").includes("tag=heybroc-20") && webSwap.isPaidLink
    )
  );

  const wholeOatsScan = await runScan({
    productTitle: "Pure Whole Grain Rolled Oats",
    rawIngredients: "100% Whole Grain Rolled Oats.",
    store: "walmart",
    dietaryWatchlist: ["wheat_gluten", "egg"],
  });
  check(
    "Step 6 allergen word-boundary fix: 'Whole Grain Rolled Oats' never triggers wheat_gluten or egg alerts",
    Boolean(wholeOatsScan.ok && (wholeOatsScan.dietaryAlerts?.length ?? 0) === 0)
  );

  // ==================== FULL AUDIT REGRESSION SUITE (C1, H1–H11, M1–M9, L1–L3) ====================
  const { hasValidCatalogProvenance, hasProductIdentityMatch } = await import("../lib/drinks-catalog");
  const { INSTANT_GROCERY_CATALOG } = await import("../lib/lookup");
  const { SEO_PRODUCTS } = await import("../lib/seo-catalog");
  const { resolveBillingPortalCustomer } = await import("../lib/entitlements");

  // C1: Unauthenticated requests to resolveBillingPortalCustomer without verified identity return null
  const unverifiedPortal = await resolveBillingPortalCustomer({ deviceId: "anon-web", email: "" });
  const unboundDevicePortal = await resolveBillingPortalCustomer({ deviceId: "unbound-victim-device-id" });
  check(
    "C1: resolveBillingPortalCustomer rejects unverified/anon and unbound device requests",
    unverifiedPortal === null && unboundDevicePortal === null
  );

  // H1 & H2: Every DRINKS_CATALOG, INSTANT_GROCERY_CATALOG, and SEO_PRODUCTS entry has valid provenance & zero '/' in title/brand
  check(
    "H1/H2: DRINKS_CATALOG has zero '/' in title or brand and every entry passes hasValidCatalogProvenance",
    DRINKS_CATALOG.every(
      (d) => !d.title.includes("/") && !d.brand.includes("/") && hasValidCatalogProvenance(d.sourceUrl, d.verifiedAt)
    )
  );
  check(
    "H1/H2: INSTANT_GROCERY_CATALOG has zero '/' in title or brand and every entry passes hasValidCatalogProvenance",
    INSTANT_GROCERY_CATALOG.every(
      (g) => !g.title.includes("/") && !g.brand.includes("/") && hasValidCatalogProvenance(g.sourceUrl, g.verifiedAt)
    )
  );
  check(
    "H2/H3: SEO_PRODUCTS every entry passes hasValidCatalogProvenance",
    SEO_PRODUCTS.every((s) => hasValidCatalogProvenance(s.sourceUrl, s.verifiedAt))
  );
  check(
    "H2: hasValidCatalogProvenance rejects missing, root-only, future, or stale (>90d) provenance",
    !hasValidCatalogProvenance("https://world.openfoodfacts.org/", "2026-11-08") &&
      !hasValidCatalogProvenance("https://www.fda.gov/food", "2099-01-01") &&
      !hasValidCatalogProvenance("https://www.fda.gov/food", "2020-01-01") &&
      !hasValidCatalogProvenance(undefined, undefined)
  );

  // H1: Sunkist, Mug, GT's, Doritos Simply NKD vs Simply Organic White Cheddar, Pedialyte Classic, Starbucks Doubleshot, Liquid Death
  const sunkistMatch = matchDrinkCatalog("Sunkist Orange Soda");
  const mugMatch = matchDrinkCatalog("Mug Root Beer");
  const gtsMatch = matchDrinkCatalog("GT's Synergy Raw Kombucha Gingerade");
  check(
    "H1: Sunkist, Mug, and GT's resolve to their own dedicated brand entries (never Fanta, A&W, or Health-Ade)",
    Boolean(
      sunkistMatch && sunkistMatch.brand === "Sunkist" &&
      mugMatch && mugMatch.brand === "Mug" &&
      gtsMatch && gtsMatch.brand === "GT's Living Foods"
    )
  );

  const pedialyteClassic = matchDrinkCatalog("Pedialyte Classic Electrolyte Solution");
  check(
    "H1: Pedialyte Classic does not list Milk allergens",
    Boolean(pedialyteClassic && !/\bmilk\b/i.test(pedialyteClassic.ingredients))
  );
  check(
    "H1: Starbucks Doubleshot Espresso does not list taurine, ginseng, or guarana",
    Boolean(doubleshot && !/\b(taurine|ginseng|guarana)\b/i.test(doubleshot.ingredients))
  );
  check(
    "H1: Liquid Death Severed Lime Sparkling Water never matches plain Mountain Water",
    matchDrinkCatalog("Liquid Death Severed Lime Sparkling Water")?.id !== "liquid-death-mountain-water"
  );

  const doritosSimplyOrganicScan = await runScan({
    productTitle: "Simply Doritos Organic White Cheddar Nacho Tortilla Chips",
    store: "walmart",
  });
  check(
    "H1: Doritos Simply NKD (non-organic) and Simply Doritos Organic White Cheddar (organic) are distinct",
    Boolean(
      doritosNkdScan.ok &&
      doritosNkdScan.result?.yukaBreakdown?.organicScore === 0 &&
      doritosSimplyOrganicScan.ok &&
      doritosSimplyOrganicScan.result?.yukaBreakdown?.organicScore === 10
    )
  );

  // H3: Cereal formulations match between INSTANT_GROCERY_CATALOG and SEO_PRODUCTS
  const seoCtc = SEO_PRODUCTS.find((p) => p.title.includes("Cinnamon Toast Crunch"));
  const instantCtc = INSTANT_GROCERY_CATALOG.find((p) => p.title.includes("Cinnamon Toast Crunch"));
  check(
    "H3: Cinnamon Toast Crunch formulation is consistent across INSTANT_GROCERY_CATALOG and SEO_PRODUCTS",
    Boolean(seoCtc && instantCtc && /\bbht\b/i.test(seoCtc.ingredients) && /\bbht\b/i.test(instantCtc.ingredients))
  );

  // H4: Product title containing 'Organic' never grants organicScore when isOrganic is not explicitly true
  const titleOrganicCheck = scoreProductYuka("Whole milk, vitamin D3.", {}, [], {
    productTitle: "Organic Valley Whole Milk",
  });
  check(
    "H4: scoreProductYuka never infers USDA Organic bonus from productTitle when isOrganic is not true",
    titleOrganicCheck.yukaBreakdown?.organicScore === 0
  );

  // H5: Non-food items receive nutritionScore 0 and nutriScoreGrade 'N/A', never 'A'
  const nonFoodCheck = scoreProductYuka(
    "Water, sodium lauryl sulfate, lauramine oxide, fragrance, methylisothiazolinone.",
    {},
    [],
    { productTitle: "Dawn Ultra Dishwashing Liquid Dish Soap" }
  );
  check(
    "H5: Non-food items receive nutritionScore === 0 and nutriScoreGrade === 'N/A'",
    nonFoodCheck.yukaBreakdown?.nutritionScore === 0 &&
      nonFoodCheck.yukaBreakdown?.nutriScoreGrade === "N/A"
  );

  // M5: hasProductIdentityMatch rejects cross-brand generic overlap ('Silk Soymilk' vs 'Great Value Soymilk')
  check(
    "M5: hasProductIdentityMatch rejects 'Great Value Soymilk' for query 'Silk Soymilk' and accepts 'Silk Original Soymilk'",
    !hasProductIdentityMatch("Silk Soymilk", "Great Value Original Soymilk") &&
      hasProductIdentityMatch("Silk Soymilk", "Silk Original Soymilk, 64 fl oz")
  );

  // C1 Triple-Audit: Direct call to resolveBillingPortalCustomer with email or deviceId but no authToken/deviceSecret returns null
  const spoofedEmailPortal = await resolveBillingPortalCustomer({ email: "victim@example.com" });
  const spoofedDevicePortal = await resolveBillingPortalCustomer({ deviceId: "victim-device", deviceSecret: "wrong-secret" });
  check(
    "C1 Triple-Audit: resolveBillingPortalCustomer enforces authToken / deviceSecret inside lib/entitlements.ts",
    spoofedEmailPortal === null && spoofedDevicePortal === null
  );

  // Kroger, Shipt, and DoorDash store-brand catalog & swap verification
  const bigKMatch = matchDrinkCatalog("Big K Cola Soda");
  const simpleTruthKombuchaMatch = matchDrinkCatalog("Simple Truth Organic Kombucha Gingerberry");
  const goodGatherSparklingMatch = matchDrinkCatalog("Good & Gather Sparkling Water Pomegranate Dragonfruit");
  check(
    "Kroger/Shipt/DoorDash Drinks: Big K Cola, Simple Truth Organic Kombucha, and Good & Gather Sparkling Water resolve accurately",
    Boolean(
      bigKMatch && bigKMatch.brand === "Big K" &&
      simpleTruthKombuchaMatch && simpleTruthKombuchaMatch.brand === "Simple Truth Organic" && simpleTruthKombuchaMatch.nutrition.isOrganic === true &&
      goodGatherSparklingMatch && goodGatherSparklingMatch.brand === "Good & Gather" && !goodGatherSparklingMatch.nutrition.isOrganic
    )
  );

  const simpleTruthYogurtScan = await runScan({
    productTitle: "Simple Truth Organic Whole Milk Plain Greek Yogurt",
    store: "kroger",
  });
  const goodGatherPbScan = await runScan({
    productTitle: "Good & Gather Organic Creamy Peanut Butter",
    store: "shipt",
  });
  const favoriteDayIceCreamScan = await runScan({
    productTitle: "Favorite Day Classic Vanilla Ice Cream",
    store: "doordash",
  });
  check(
    "Kroger/Shipt/DoorDash Foods: Simple Truth Organic Greek Yogurt (100/100), Good & Gather Organic PB (85/100), and Favorite Day Vanilla Ice Cream resolve accurately",
    Boolean(
      simpleTruthYogurtScan.ok && simpleTruthYogurtScan.result?.score === 100 && simpleTruthYogurtScan.result?.yukaBreakdown?.organicScore === 10 &&
      goodGatherPbScan.ok && goodGatherPbScan.result?.score === 85 && goodGatherPbScan.result?.yukaBreakdown?.organicScore === 10 &&
      favoriteDayIceCreamScan.ok && (favoriteDayIceCreamScan.result?.score ?? 100) < 50 &&
      favoriteDayIceCreamScan.swap?.deepLink?.includes("doordash.com/search/store/")
    )
  );

  const shiptSwap = resolveSwap({ score: 20, productTitle: "Big K Cola Soda", store: "shipt", surface: "android" });
  const krogerSwap = resolveSwap({ score: 20, productTitle: "Big K Cola Soda", store: "kroger", surface: "android" });
  check(
    "Kroger/Shipt Swap Routing: Shipt uses /shop/search?query= and Kroger uses kroger.com/search?query=",
    Boolean(
      shiptSwap?.deepLink?.startsWith("https://www.shipt.com/shop/search?query=") &&
      krogerSwap?.deepLink?.startsWith("https://www.kroger.com/search?query=")
    )
  );

  // Source-file verification for M4, M6, H5 badge colors, and Shipt onboarding gate
  const fs = await import("fs");
  const overlayKt = fs.readFileSync("android-app/app/src/main/java/com/cleancart/overlay/OverlayWindowService.kt", "utf8");
  const readerKt = fs.readFileSync("android-app/app/src/main/java/com/cleancart/overlay/GroceryScreenReaderService.kt", "utf8");
  const mainKt = fs.readFileSync("android-app/app/src/main/java/com/cleancart/overlay/MainActivity.kt", "utf8");
  const productImgRoute = fs.readFileSync("app/api/product-image/route.ts", "utf8");
  const simTsx = fs.readFileSync("components/Simulator.tsx", "utf8");
  const authModalTsx = fs.readFileSync("components/AuthModal.tsx", "utf8");

  check(
    "M4/M6/Shipt UX: OverlayWindowService paid-link + CC BY-SA 3.0, product-image HEAD + CORS, Simulator CC BY-SA 3.0, and Shipt onboarding gate + Continue as guest",
    overlayKt.includes("Open Food Facts (CC BY-SA 3.0)") &&
      productImgRoute.includes("Access-Control-Expose-Headers") &&
      productImgRoute.includes("export const HEAD = GET") &&
      simTsx.includes("CC BY-SA 3.0") &&
      readerKt.includes("STORE_ONBOARDING_OR_AUTH_GATE") &&
      readerKt.includes("ONBOARDING_AUTH_GATE") &&
      mainKt.includes("Continue as guest") &&
      authModalTsx.includes("Continue as guest")
  );

  console.log(normalizeIngredients("Vegetable Oil (Soybean, Canola and/or Sunflower), corn, safflower or sunflower oil"));
  console.log(fail ? `${fail} FAILED` : "ALL CHECKS PASSED");
  process.exit(fail ? 1 : 0);
})();



