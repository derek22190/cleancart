import { passesVariantGuard } from "../lib/drinks-catalog";
import { extractOffNutrition, extractUsdaNutrition, classifyWholeFood } from "../lib/nutrition";
import { dsldLabelResult, matchesDsldLabel, type DsldLabel } from "../lib/dsld";
import { scoreIngredients, scoreProductYuka, normalizeIngredients, isEnglishIngredientText, inferNutritionFromText } from "../lib/rubric";
import { PRESETS } from "../lib/presets";
import { CLEAN_ALTERNATIVES, EXACT_PRODUCT_ALTERNATIVES, resolveSwap } from "../lib/swaps";

Object.assign(process.env, { NODE_ENV: "test" });
// Deterministic catalog regressions: no real provider, quota, or developer cache dependency.
globalThis.fetch = async () => Response.json({ status: 0, hits: [], products: [], foods: [] });
let fail = 0;
let checks = 0;
const check = (label: string, cond: boolean) => { checks++; if (!cond) { fail++; console.log("FAIL", label); } };

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
  const isOrganic = a.isOrganic === true;
  const ry = scoreProductYuka(a.ingredients, {}, [], { ...a.nutrition, productTitle: fullTitle, isOrganic });
  const b = ry.yukaBreakdown;
  check(`${a.brand} ${a.name} >= 90 (${r.score} ${r.flagged.map((f) => f.name)})`, r.score >= 90);
  check(`${a.brand} additive pillar is accurate`, b ? b.additiveScore === 30 : ry.scoringBasis === "ingredient-only");
  check(`${a.brand} declared score basis matches score`, b ? ry.score === b.nutritionScore + b.additiveScore + b.organicScore : ry.score === r.score);
}
for (const entry of EXACT_PRODUCT_ALTERNATIVES) {
  const a = entry.alt;
  const r = scoreIngredients(a.ingredients);
  const fullTitle = `${a.brand} ${a.name}`;
  const isOrganic = a.isOrganic === true;
  const ry = scoreProductYuka(a.ingredients, {}, [], { ...a.nutrition, productTitle: fullTitle, isOrganic });
  const b = ry.yukaBreakdown;
  check(`1-for-1 ${a.brand} ${a.name} >= 90 (${r.score} ${r.flagged.map((f) => f.name)})`, r.score >= 90);
  check(`1-for-1 ${a.brand} ${a.name} additive pillar reflects its actual declared flags`, b ? (r.flagged.length === 0 ? b.additiveScore === 30 : b.additiveScore < 30) : ry.scoringBasis === "ingredient-only");
  check(`1-for-1 ${a.brand} ${a.name} declared score basis matches score`, b ? ry.score === b.nutritionScore + b.additiveScore + b.organicScore : ry.score === r.score);
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
check("Capri Sun remains Poor without falsely penalizing citric acid and swaps to Spindrift", (() => {
  const s = scoreProductYuka("Water, sugar, pear and grape juice concentrate, citric acid, strawberry and kiwi juice concentrate, natural flavor.", {}, [], { productTitle: "Capri Sun Strawberry Kiwi Juice Pouches" });
  const sw = resolveSwap({ score: s.score, productTitle: "Capri Sun Strawberry Kiwi Juice Pouches", store: "aldi" });
  return s.score < 50 && s.rating === "Poor" && Boolean(sw?.title.includes("Spindrift")) && Boolean(sw?.image.startsWith("https://"));
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
  return s.score <= 35 && Boolean(sw?.title.includes("Yellow Onions")) && Boolean(sw?.image.startsWith("https://"));
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

// Clean-label fortifiers, culinary oils, fermentation and naturally occurring sugars.
const cleanIngredients = ["ascorbic acid", "mixed tocopherols", "riboflavin", "niacinamide", "ferrous sulfate", "zinc oxide", "thiamine mononitrate", "folic acid", "citric acid", "lactic acid", "pectin", "cream of tartar", "baking soda", "sodium bicarbonate", "avocado oil", "extra virgin olive oil", "coconut oil", "grass-fed butter", "ghee", "cocoa butter", "dates", "100% fruit", "unsweetened applesauce", "plain milk lactose", "100% pure maple syrup", "raw honey", "live and active cultures", "S. thermophilus, L. bulgaricus", "cheese cultures, microbial enzymes", "apple cider vinegar", "distilled vinegar", "cold pressed celery juice"];
for (const ingredient of cleanIngredients) check(`clean ingredient has no additive flags: ${ingredient}`, scoreIngredients(ingredient).flagged.length === 0);
check("olive oil marketing does not mask soybean/canola", scoreIngredients("Soybean oil, canola oil, extra virgin olive oil, egg yolk, vinegar").flagged.filter(f => f.category === "seedOils").length === 2);
check("curing celery is still detected", scoreIngredients("Pork, sea salt, celery powder").flagged.some(f => f.id === "celerynitrate"));
check("HFCS and corn syrup remain detected", scoreIngredients("High fructose corn syrup, corn syrup solids").flagged.some(f => f.id === "hfcs"));
for (const dataType of ["Branded", "Foundation", "SR Legacy", "Survey (FNDDS)"]) {
  const n = extractUsdaNutrition({dataType, description:"Almonds, raw", foodNutrients:[
    {nutrientId:1062,nutrientName:"Energy",unitName:"kJ",value:418.4},
    {nutrientId:1008,nutrientName:"Energy",unitName:"KCAL",value:100},
    {nutrientNumber:"269",nutrientName:"Sugars, total including NLEA",unitName:"G",value:0},
    {nutrientId:1258,unitName:"G",value:1}, {nutrientNumber:"307",unitName:"MG",value:200},
    {nutrientId:1079,unitName:"G",value:8}, {nutrientNumber:"203",unitName:"G",value:20},
  ]});
  check(`${dataType} USDA IDs/numbers/units and zero preserve per100g`, n.caloriesKcal100g===100 && n.sugarsG100g===0 && n.saturatedFatG100g===1 && n.sodiumMg100g===200 && n.fiberG100g===8 && n.proteinG100g===20);
  if(dataType!=="Branded") check(`${dataType} almonds are whole food/FVN`, n.isWholeFood===true && n.fruitsVegNutsPct===100);
}
const usdaKj = extractUsdaNutrition({foodNutrients:[{nutrientId:1062,unitName:"kJ",value:418.4}]});
check("USDA kJ never treated as kcal", Math.abs(usdaKj.caloriesKcal100g!-100)<0.001);
check("USDA kJ identifier without a unit is still converted", Math.abs(extractUsdaNutrition({foodNutrients:[{nutrientId:1062,value:418.4}]}).caloriesKcal100g!-100)<0.001);
check("USDA Branded per100g nutrients are not divided by serving size", extractUsdaNutrition({dataType:"Branded",foodNutrients:[{nutrientId:1008,unitName:"KCAL",value:400}]}).caloriesKcal100g===400);
check("unsweetened does not turn coated nuts or smoked salmon into plain whole foods", classifyWholeFood("unsweetened chocolate covered almonds").isWholeFood!==true && classifyWholeFood("unsweetened smoked salmon").isWholeFood!==true);
check("USDA nested detail nutrients support amount and units", extractUsdaNutrition({foodNutrients:[{nutrient:{id:1093,unitName:"g"},amount:0.2}]}).sodiumMg100g===200);
const offSalt = extractOffNutrition({nutriments:{"energy_100g":418.4,"salt_100g":100,"sugars_100g":0,"proteins_100g":0},labels_tags:["en:usda-organic"]});
check("OFF salt grams and energy kJ use schema units", Math.abs(offSalt.caloriesKcal100g!-100)<0.001 && offSalt.sodiumMg100g===40000 && offSalt.isOrganic===true);
check("OFF sodium grams are not guessed as milligrams", extractOffNutrition({nutriments:{sodium_100g:12}}).sodiumMg100g===12000);
check("OFF kcal wins over kJ", extractOffNutrition({nutriments:{"energy-kcal_100g":50,energy_100g:418.4}}).caloriesKcal100g===50);
for(const tag of ["en:organic","en:eu-organic","en:usda-organic"]) check(`OFF product organic label ${tag}`,extractOffNutrition({labels_tags:[tag]}).isOrganic===true);
check("OFF organic ingredient/name is not certification",extractOffNutrition({product_name:"Organic ingredients",nutriments:{}}).isOrganic===false);
const filled = inferNutritionFromText("Whole Grain Oats", "Whole grain oats", {proteinG100g:0,fiberG100g:0,caloriesKcal100g:80,sugarsG100g:0});
check("inference never overwrites measured zeroes or baseline",filled.proteinG100g===0 && filled.fiberG100g===0 && filled.caloriesKcal100g===80 && filled.sugarsG100g===0);
check("missing protein/fiber in oats gets conservative positive estimate",inferNutritionFromText("Whole Grain Oats","Whole grain oats").fiberG100g!>0);
for (const name of ["Fresh Atlantic salmon", "organic honeycrisp apples", "raw almonds", "chia seeds", "Plain Greek Yogurt", "extra virgin olive oil"]) check(`plain whole food classifier: ${name}`,classifyWholeFood(name).isWholeFood===true);
for (const name of ["Made with olive oil mayonnaise", "sweet potato chips", "almond milk", "chicken nuggets"]) check(`processed food is not whole produce: ${name}`,classifyWholeFood(name).isWholeFood!==true);
const dsldFixture: DsldLabel = {id:249498,brandName:"GHOST",fullName:"Legend Swedish Fish",upcSku:"8 10028 29603 9",offMarket:0,entryDate:"2021-05-22",ingredientRows:[{name:"L-Citrulline"},{name:"Beta-Alanine"}],otheringredients:{ingredients:[{name:"Citric Acid"},{name:"Sucralose"},{name:"Acesulfame Potassium"},{name:"FD&C Red #40"}]}};
const dsldProduct = dsldLabelResult({productTitle:"GHOST Legend Swedish Fish Pre-Workout"},dsldFixture);
check("NIH exact label includes actives plus excipients",Boolean(dsldProduct?.ingredients.includes("L-Citrulline") && dsldProduct.ingredients.includes("Sucralose")));
const dsldScore = scoreProductYuka(dsldProduct?.ingredients || "",{},[],dsldProduct?.nutrition);
check("Supplement Facts uses ingredient-only grading, not invented food nutrition",dsldScore.scoringBasis==="ingredient-only" && !dsldScore.yukaBreakdown && dsldScore.flagged.some(f=>f.id==="red40") && !dsldScore.flagged.some(f=>f.id==="citricacid"));
check("NIH rejects unspecified/different flavor",!matchesDsldLabel({productTitle:"GHOST Legend Pre-Workout"},dsldFixture) && !matchesDsldLabel({productTitle:"GHOST Legend Lemon Pre-Workout"},dsldFixture));
check("NIH rejects off-market/incomplete-label records",!dsldLabelResult({barcode:"810028296039"},{...dsldFixture,offMarket:1}) && !dsldLabelResult({barcode:"810028296039"},{...dsldFixture,otheringredients:undefined}));
check("NIH matches UPC typography but never different barcode",matchesDsldLabel({barcode:"0810028296039"},dsldFixture) && !matchesDsldLabel({barcode:"810028296030"},dsldFixture));
check("2% milk never matches whole milk even across punctuation", !passesVariantGuard("Organic Valley 2% Milk", "Organic Valley Whole Milk") && passesVariantGuard("Organic Valley 2% Milk", "Organic Valley 2% Reduced Fat Milk"));
check("specific flavors cannot use pooled or different flavor formulations", !passesVariantGuard("Orgain Vanilla Protein Shake", "Orgain Protein Shake (Creamy Chocolate, Vanilla Bean)") && !passesVariantGuard("Orgain Vanilla Protein Shake", "Orgain Creamy Chocolate Protein Shake") && !passesVariantGuard("Orgain Plant Protein Shake", "Orgain Grass-Fed Milk Protein Shake"));
check("Spindrift Raspberry Lime is a single verified flavor; Lemon never gets its recipe", matchDrinkCatalog("Spindrift Lemon Sparkling Water")===null && matchDrinkCatalog("Spindrift Raspberry Lime Sparkling Water")?.ingredients==="Carbonated Water, Raspberry Puree, Lime Juice.");
check("plain, organic, unsweetened and gluten-free variant requests fail closed", !passesVariantGuard("Plain Greek Yogurt", "Vanilla Greek Yogurt") && !passesVariantGuard("Organic Almond Milk", "Almond Milk") && !passesVariantGuard("Unsweetened Almond Milk", "Original Almond Milk") && !passesVariantGuard("Gluten Free Oats", "Rolled Oats"));
const stokAlt = EXACT_PRODUCT_ALTERNATIVES.find(e=>e.alt.brand==="SToK")?.alt;
check("SToK label retains natural flavor and has no invented organic bonus", Boolean(stokAlt?.ingredients.toLowerCase().includes("natural flavor") && stokAlt.isOrganic===false && stokAlt.sourceUrl?.includes("stokbrew.com/cold-brew/") && scoreProductYuka(stokAlt.ingredients,{},[],{...stokAlt.nutrition,productTitle:stokAlt.name}).yukaBreakdown?.organicScore===0));
check("cheddar-cracker swap never invents a seed-oil-free Simple Mills formulation",resolveSwap({score:0,productTitle:"Cheez-It Original Crackers",store:"walmart"})?.brand==="Mary's Gone Crackers");
check("manufacturer label nutrients, not a hardcoded A, drive the cracker swap score", CLEAN_ALTERNATIVES.Crackers.nutrition?.sodiumMg100g===600 && resolveSwap({score:0,productTitle:"Cheez-It Original Crackers"})?.score===68);
const brandedSwap = resolveSwap({score:0,productTitle:"Cheez-It Original Crackers",store:"walmart"});
check("requested dietary variants cannot swap to an incompatible formulation", !resolveSwap({score:0,productTitle:"Gluten Free Sandwich Bread"}) && !resolveSwap({score:0,productTitle:"Lactaid Whole Milk"}) && !resolveSwap({score:0,productTitle:"Skim Milk"}) && !resolveSwap({score:0,productTitle:"Vegan Ranch Dressing"}));
check("retailer search preserves the scored swap brand and recipe",Boolean(brandedSwap?.webUrl && new URL(brandedSwap.webUrl).searchParams.get("q")===brandedSwap.title));
import Module from "module";
const origLoad = (Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown })._load;
(Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown })._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};

(async () => {
  const { runScan } = await import("../lib/scan");
  const {lookupIngredients, matchesGenericWholeFood} = await import("../lib/lookup");
  check("USDA whole food identity rejects substitute species or cooked preparation", !matchesGenericWholeFood("Fresh Atlantic Salmon","Fish, cod, Atlantic, raw") && !matchesGenericWholeFood("Fresh Atlantic Salmon","Fish, salmon, Atlantic, cooked") && matchesGenericWholeFood("Fresh Atlantic Salmon","Fish, salmon, Atlantic, wild, raw"));
  const beforeProviders = globalThis.fetch;
  const providerCalls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input); providerCalls.push(url);
    if(url.includes("api.nal.usda.gov")) return Response.json({foods:[{fdcId:12345,description:"Fish, salmon, Atlantic, wild, raw",dataType:"Foundation",foodNutrients:[{nutrientId:1008,unitName:"KCAL",value:142},{nutrientId:1003,unitName:"G",value:20}]}]});
    return beforeProviders(input,init);
  };
  const previousKey=process.env.USDA_API_KEY;delete process.env.USDA_API_KEY;
  const salmon = await lookupIngredients({productTitle:"Fresh Atlantic Salmon"});
  check("USDA unbranded Foundation path works with public DEMO_KEY",salmon?.source==="usda" && salmon.nutrition?.isWholeFood===true && salmon.nutrition?.proteinG100g===20 && providerCalls.some(u=>u.includes("Foundation")&&u.includes("DEMO_KEY")));
  if(previousKey===undefined) delete process.env.USDA_API_KEY;else process.env.USDA_API_KEY=previousKey;
  globalThis.fetch = async (input,init) => {
    const url=String(input);
    if(url.includes("openbeautyfacts.org/api/v2/product/"))return Response.json({product:{code:"123456789012",product_name_en:"Sample Cosmetic",ingredients_text_en:"Water, Glycerin",nutriments:{}}});
    return beforeProviders(input,init);
  };
  const nonFood = await lookupIngredients({barcode:"123456789012"});
  check("non-food UPC vertical supplies explicit classification",nonFood?.source==="openbeautyfacts" && nonFood.nutrition?.productKind==="non-food" && scoreProductYuka(nonFood.ingredients,{},[],nonFood.nutrition).yukaBreakdown?.nutriScoreGrade==="N/A");
  globalThis.fetch = async (input,init) => {
    if(String(input).includes("world.openfoodfacts.org/api/v2/product/"))return Response.json({product:{code:"123456789013",product_name_en:"Whole Grain Oats",ingredients_text_en:"Whole grain oats",nutriments:{"energy-kcal_100g":380,sugars_100g:0,"saturated-fat_100g":1,sodium_100g:0},labels_tags:["en:usda-organic"]}});
    return beforeProviders(input,init);
  };
  const partialOff = await lookupIngredients({barcode:"123456789013"});
  check("live OFF path fills missing positives while preserving verified zeroes and certification", partialOff?.source==="openfoodfacts" && partialOff.nutrition?.caloriesKcal100g===380 && partialOff.nutrition?.sugarsG100g===0 && partialOff.nutrition?.fiberG100g!>0 && partialOff.nutrition?.proteinG100g!>0 && partialOff.nutrition?.isOrganic===true && partialOff.nutrition?.inferredPositiveFields?.includes("fiberG100g")===true);
  const fallbackCalls: string[] = [];
  globalThis.fetch = async (input,init) => {
    const url = String(input); fallbackCalls.push(url);
    if(url.includes("world.openfoodfacts.org/api/v2/product/123456789014")) return Response.json({}, {status:429});
    if(url.includes("world.openfoodfacts.org/api/v0/product/123456789014.json")) return Response.json({product:{code:"123456789014",product_name_en:"Plain Rolled Oats",ingredients_text_en:"Whole grain oats"}});
    if(url.includes("world.openfoodfacts.org/api/v2/product/123456789015")) return Response.json({product:{code:"123456789015",product_name_en:"Plain Rolled Oats",ingredients_text_en:"Whole grain oats"}});
    return beforeProviders(input,init);
  };
  const v0Fallback = await lookupIngredients({barcode:"123456789014"});
  const followingOff = await lookupIngredients({barcode:"123456789015"});
  check("OFF rate-limit fallback survives without globally blacking out other barcodes",v0Fallback?.source==="openfoodfacts" && followingOff?.source==="openfoodfacts" && fallbackCalls.some(url=>url.includes("/api/v0/product/123456789014.json")));
  globalThis.fetch = async (input,init) => {
    const url=String(input);
    if(url.includes("api.ods.od.nih.gov") && url.includes("search-filter"))return Response.json({hits:[{_id:"249498",_source:dsldFixture}]});
    if(url.endsWith("label/249498"))return Response.json(dsldFixture);
    return beforeProviders(input,init);
  };
  const supplement = await lookupIngredients({productTitle:"GHOST Legend Swedish Fish Pre-Workout"});
  check("specialized NIH lookup is wired into live waterfall",supplement?.source==="dsld" && supplement.ingredients.includes("FD&C Red #40"));
  const supplementScan = await runScan({productTitle:"GHOST Legend Swedish Fish Pre-Workout"});
  check("scan API preserves the archived label link and ingredient-only scoring", supplementScan.ok && supplementScan.lookup.sourceUrl==="https://dsld.od.nih.gov/label/249498" && supplementScan.result.scoringBasis==="ingredient-only" && !supplementScan.result.yukaBreakdown);
  const supplementUpc = await lookupIngredients({barcode:"810028296039"});
  check("NIH UPC lookup resolves only the exact label barcode",supplementUpc?.source==="dsld" && supplementUpc.barcode==="810028296039");
  globalThis.fetch=beforeProviders;
  const genericProduce = await lookupIngredients({productTitle:"Fresh Whole Papayas"});
  check("whole-food fallback does not present invented measured macros",genericProduce?.source==="catalog" && genericProduce.nutrition?.isWholeFood===true && genericProduce.nutrition?.caloriesKcal100g===undefined && scoreProductYuka(genericProduce.ingredients,{},[],{...genericProduce.nutrition,productTitle:genericProduce.productTitle}).yukaBreakdown?.calorieNote==="Calories Not Measured");
  const screenSupplement = await lookupIngredients({productTitle:"Sample Pre-Workout Powder",rawIngredients:"L-Citrulline, Sucralose, Citric Acid"});
  check("screen supplement ingredients are not given food nutrition",screenSupplement?.source==="screen" && screenSupplement.nutrition?.productKind==="supplement");
  const startBudget = performance.now();
  const pendingSignals: AbortSignal[] = [];
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve,reject)=> {
    const signal=init?.signal;
    if(signal){pendingSignals.push(signal); if(signal.aborted)reject(new Error("aborted"));else signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true});}
  });
  const expired = await lookupIngredients({productTitle:"Unmatchable Deadline Fixture"});
  const budgetElapsed = performance.now()-startBudget;
  check("hung upstreams obey shared1800ms deadline and cancel requests",!expired && budgetElapsed<2800 && pendingSignals.length>0 && pendingSignals.every(signal=>signal.aborted));
  globalThis.fetch=beforeProviders;
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
    "OWYN Pro Elite Vanilla cannot borrow an unspecified-flavor recipe",
    Boolean(
      owynProElite === null &&
      matchDrinkCatalog("OWYN Pro Elite Protein Shake")?.nutrition.sugarsG100g === 0
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
    productTitle: "Simply Doritos Organic White Cheddar Flavored Tortilla Chips",
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
      (productImgRoute.includes("export const HEAD = GET") || productImgRoute.includes("export async function HEAD")) &&
      simTsx.includes("CC BY-SA 3.0") &&
      readerKt.includes("STORE_ONBOARDING_OR_AUTH_GATE") &&
      readerKt.includes("ONBOARDING_AUTH_GATE") &&
      mainKt.includes("Continue as guest") &&
      authModalTsx.includes("Continue as guest")
  );

  // --- Post-Audit Remediation Regression Suite (C-1, H-1..H-5, M-1..M-13, L-1..L-12) ---
  const { isCatalogEntryFresh, passesVariantGuard } = await import("../lib/drinks-catalog");
  const { isInstantCatalogEntryFresh } = await import("../lib/lookup");
  const { TERMS_VERSION } = await import("../lib/terms");
  const { TERMS_VERSION: PRICING_TERMS_VERSION } = await import("../lib/pricing");
  const { isAdminAuthorized } = await import("../lib/admin-auth");

  // C-1: Favorite Day Cookies & Cream Ice Cream includes wheat & soy allergens; Rocky Road does not match Vanilla
  const favDayCookiesScan = await runScan({
    productTitle: "Favorite Day Cookies & Cream Ice Cream",
    store: "target",
    dietaryWatchlist: ["wheat_gluten", "soy", "dairy"],
  });
  check(
    "C-1: Favorite Day Cookies & Cream Ice Cream flags wheat/gluten, soy, and dairy allergens",
    Boolean(
      favDayCookiesScan.ok &&
      /\bwheat\s+flour\b/i.test(favDayCookiesScan.product?.ingredients ?? "") &&
      /\bsoy\s+lecithin\b/i.test(favDayCookiesScan.product?.ingredients ?? "") &&
      (favDayCookiesScan.dietaryAlerts?.length ?? 0) >= 3
    )
  );

  // H-2: Lactaid Chocolate Milk resolves to Lactaid (not Nesquik/TruMoo); Pedialyte AdvancedCare Plus does not match Classic
  const lactaidChoc = matchDrinkCatalog("Lactaid Chocolate Whole Milk");
  const pedialyteAdv = matchDrinkCatalog("Pedialyte AdvancedCare Plus Berry Frost Electrolyte Solution");
  check(
    "H-2: Lactaid Chocolate Whole Milk resolves to Lactaid and Pedialyte AdvancedCare Plus does not match Pedialyte Classic",
    Boolean(
      lactaidChoc && lactaidChoc.id === "lactaid-chocolate-milk" && lactaidChoc.brand === "Lactaid" &&
      pedialyteAdv === null
    )
  );

  // H-3 / M1: Single-flavor drink splits (Coca-Cola Cherry vs Vanilla, Gatorade Cool Blue vs Lemon-Lime, Zevia Ginger Root Beer vs Cola, Core Power Elite 42g vs 26g, Great Value vs TruMoo vs Nesquik)
  const cokeCherry = matchDrinkCatalog("Coca-Cola Cherry Soda");
  const cokeVanilla = matchDrinkCatalog("Coca-Cola Vanilla Soda");
  const gatoradeCoolBlue = matchDrinkCatalog("Gatorade Cool Blue Thirst Quencher");
  const gatoradeLemonLime = matchDrinkCatalog("Gatorade Lemon-Lime Thirst Quencher");
  const zeviaRootBeer = matchDrinkCatalog("Zevia Zero Sugar Ginger Root Beer");
  const zeviaCola = matchDrinkCatalog("Zevia Zero Sugar Cola");
  const corePowerElite = matchDrinkCatalog("Core Power Elite 42g High Protein Shake");
  const corePower26 = matchDrinkCatalog("Core Power 26g Protein Milk Shake");
  const gvChocMilk = matchDrinkCatalog("Great Value Whole Chocolate Milk");
  const trumooChocMilk = matchDrinkCatalog("TruMoo Chocolate Lowfat Milk");
  const nesquikChocMilk = matchDrinkCatalog("Nesquik Chocolate Lowfat Milk");
  check(
    "H-3/M1: Split drink variants resolve to distinct single-formulation entries",
    Boolean(
      cokeCherry?.id === "coca-cola-cherry" &&
      cokeVanilla?.id === "coca-cola-vanilla" &&
      gatoradeCoolBlue?.id === "gatorade-cool-blue" && /\bblue\s*1\b/i.test(gatoradeCoolBlue.ingredients) && !/\bred\s*40\b/i.test(gatoradeCoolBlue.ingredients) &&
      gatoradeLemonLime?.id === "gatorade-lemon-lime" && /\byellow\s*5\b/i.test(gatoradeLemonLime.ingredients) && !/\bred\s*40\b/i.test(gatoradeLemonLime.ingredients) &&
      zeviaRootBeer?.id === "zevia-ginger-root-beer" &&
      zeviaCola?.id === "zevia-zero-sugar-soda" &&
      corePowerElite?.id === "core-power-elite-fairlife-protein" &&
      corePower26?.id === "core-power-fairlife-protein" &&
      gvChocMilk?.id === "great-value-chocolate-milk" &&
      trumooChocMilk?.id === "trumoo-chocolate-milk" &&
      nesquikChocMilk?.id === "nesquik-trumoo-chocolate-milk"
    )
  );

  // H-4: Oscar Mayer Deli Fresh Oven Roasted Turkey Breast matches current US label across INSTANT_GROCERY_CATALOG and SEO_PRODUCTS
  const oscarInstant = INSTANT_GROCERY_CATALOG.find((p) => p.title.includes("Oscar Mayer Deli Fresh"));
  const oscarSeo = SEO_PRODUCTS.find((p) => p.slug === "oscar-mayer-deli-fresh-turkey");
  check(
    "H-4: Oscar Mayer Deli Fresh Turkey matches current US label (carrageenan, sodium phosphates, caramel color) across catalogs",
    Boolean(
      oscarInstant && oscarSeo &&
      /\bcarrageenan\b/i.test(oscarInstant.ingredients) &&
      /\bsodium\s+phosphates?\b/i.test(oscarInstant.ingredients) &&
      oscarInstant.ingredients === oscarSeo.ingredients
    )
  );

  // H-5: passesVariantGuard blocks flavor/pulp/sweetness/fat/protein variant mismatches
  check(
    "H-5: passesVariantGuard blocks variant mismatches across beverages and foods",
    !passesVariantGuard("Starbucks Iced Espresso Vanilla Latte", "Starbucks Iced Espresso Classics Caffe Latte") &&
      !passesVariantGuard("Tropicana Pure Premium Orange Juice Some Pulp", "Tropicana Pure Premium Original No Pulp 100% Orange Juice") &&
      !passesVariantGuard("Silk Unsweetened Almondmilk", "Silk Original Almondmilk") &&
      !passesVariantGuard("GT's Synergy Trilogy Raw Kombucha", "GT's Synergy Raw Kombucha Gingerade") &&
      !passesVariantGuard("Oatly Full Fat Oatmilk", "Oatly Original Oatmilk") &&
      !passesVariantGuard("Core Power Elite 42g Protein Shake", "Core Power 26g Protein Milk Shake") &&
      !passesVariantGuard("Favorite Day Cookies & Cream Ice Cream", "Favorite Day Classic Vanilla Ice Cream")
  );

  // M-2, M-4, M-5: Doritos Simply NKD Nacho Cheese vs Cool Ranch, Samyang Buldak Ramen, and Grade A Dairy tightening
  const doritosNkdCoolRanch = await runScan({
    productTitle: "Doritos Simply NKD Cool Ranch Flavored Tortilla Chips",
    store: "target",
  });
  const buldakScan = await runScan({
    productTitle: "Samyang Buldak Hot Chicken Flavor Ramen",
    store: "walmart",
  });
  check(
    "M-2/M-5: Doritos Simply NKD Cool Ranch and Samyang Buldak Hot Chicken Ramen resolve to dedicated formulations",
    Boolean(
      doritosNkdCoolRanch.ok && doritosNkdCoolRanch.product?.title.includes("Cool Ranch") &&
      buldakScan.ok && buldakScan.product?.brand === "Samyang" && (buldakScan.result?.score ?? 100) < 50
    )
  );

  // M-9: Sugary beverage calorieNote says "Liquid Calories", never "Low-to-Moderate Calories"
  const cokeCalorieCheck = scoreProductYuka(
    "Carbonated water, high fructose corn syrup, caramel color, phosphoric acid, natural flavors, caffeine.",
    {},
    [],
    { productTitle: "Coca-Cola Original Taste Soda", caloriesKcal100g: 39, sugarsG100g: 10.6 }
  );
  check(
    "M-9: Sugary beverage calorieNote reports Liquid Calories instead of Low-to-Moderate Calories",
    Boolean(cokeCalorieCheck.yukaBreakdown?.calorieNote?.startsWith("Liquid Calories"))
  );

  // H4 (non-food): Pet food, cosmetics, household, and OTC items receive nutritionScore 0 and nutriScoreGrade 'N/A'
  const petFoodCheck = scoreProductYuka(
    "Ground yellow corn, chicken by-product meal, corn gluten meal, beef tallow, soybean meal, red 40, yellow 5, bha.",
    {},
    [],
    { productTitle: "Purina Dog Chow Complete Adult Dry Dog Food" }
  );
  const lotionCheck = scoreProductYuka(
    "Water, glycerin, cetyl alcohol, dimethicone, petrolatum, phenoxyethanol.",
    {},
    [],
    { productTitle: "CeraVe Daily Moisturizing Lotion" }
  );
  check(
    "H4 (Non-food): Pet food and cosmetics receive nutritionScore === 0 and nutriScoreGrade === 'N/A'",
    petFoodCheck.yukaBreakdown?.nutritionScore === 0 &&
      petFoodCheck.yukaBreakdown?.nutriScoreGrade === "N/A" &&
      lotionCheck.yukaBreakdown?.nutritionScore === 0 &&
      lotionCheck.yukaBreakdown?.nutriScoreGrade === "N/A"
  );

  // L-9 & Freshness: isCatalogEntryFresh and isInstantCatalogEntryFresh reject invalid calendar dates (2026-02-31) and future dates
  const tomorrowIso = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  check(
    "L-9: isCatalogEntryFresh and isInstantCatalogEntryFresh reject impossible calendar dates and future dates",
    !isCatalogEntryFresh("2026-02-31") &&
      !isCatalogEntryFresh(tomorrowIso) &&
      !isInstantCatalogEntryFresh("2026-02-31") &&
      !isInstantCatalogEntryFresh(tomorrowIso) &&
      isCatalogEntryFresh("2026-11-08")
  );

  // L-12: Sprite swaps to Spindrift Sparkling Water (not Olipop Vintage Cola); Spam Classic swaps to uncured ham/bacon (not cereal)
  const spriteSwap = resolveSwap({ score: 15, productTitle: "Sprite Lemon-Lime Soda", store: "walmart" });
  const spamSwap = resolveSwap({ score: 15, productTitle: "Spam Classic Canned Pork", store: "walmart" });
  check(
    "L-12: Sprite swaps to Spindrift Sparkling Water and Spam Classic swaps to Applegate Uncured Ham",
    Boolean(
      spriteSwap?.title.includes("Spindrift") &&
      spamSwap?.title.includes("Applegate")
    )
  );

  // M-11 & L-8: Unified TERMS_VERSION across lib/terms.ts and lib/pricing.ts, and SHA-256 isAdminAuthorized
  process.env.HEYBROC_ADMIN_SECRET = "test-secret-for-rubric";
  check(
    "M-11/L-8: TERMS_VERSION is unified and isAdminAuthorized safely validates bearer tokens of any length",
    TERMS_VERSION === "2026-11-08" &&
      PRICING_TERMS_VERSION === TERMS_VERSION &&
      isAdminAuthorized(new Request("https://heybroc.com/api/analytics", { headers: { authorization: "Bearer test-secret-for-rubric" } })) &&
      !isAdminAuthorized(new Request("https://heybroc.com/api/analytics", { headers: { authorization: "Bearer short" } })) &&
      !isAdminAuthorized(new Request("https://heybroc.com/api/analytics", { headers: { authorization: "Bearer a-much-longer-wrong-secret-token-value" } }))
  );
  delete process.env.HEYBROC_ADMIN_SECRET;

  // Source-level checks for Android & Extension remediations
  const scanApiKt = fs.readFileSync("android-app/app/src/main/java/com/cleancart/overlay/ScanApi.kt", "utf8");
  const historyStoreKt = fs.readFileSync("android-app/app/src/main/java/com/cleancart/overlay/ScanHistoryStore.kt", "utf8");
  const chromeExtJs = fs.readFileSync("chrome-extension/content.js", "utf8");
  const safariExtJs = fs.readFileSync("ios-app/SafariExtension/Resources/content.js", "utf8");
  check(
    "Android/Extension Remediation Checks: no 'refined starch spikes', Big K Cola score 7, passesVariantGuard in ScanHistoryStore, paid link in extension cart drawer, and PROTECTED_CONTAINER_RESOURCE_ID + isSensitiveCandidate in GroceryScreenReaderService",
    !scanApiKt.includes("refined starch spikes") &&
      historyStoreKt.includes("fun passesVariantGuard") &&
      historyStoreKt.includes("Favorite Day Cookies & Cream Ice Cream") &&
      readerKt.includes("PROTECTED_CONTAINER_RESOURCE_ID") &&
      readerKt.includes("isSensitiveCandidate") &&
      readerKt.includes("hasProductContext") &&
      readerKt.includes("looksLikeFoodTitle") &&
      chromeExtJs.includes("swapIsPaidLink") &&
      safariExtJs.includes("swapIsPaidLink")
  );

  // Family Watchlist 2x strictness verification
  const yogurtIng =
    "Cultured Grade A Reduced Fat Milk, Sugar, High Fructose Corn Syrup, Modified Corn Starch, Natural Flavor, Potassium Sorbate, Red 40.";
  const yogurt1x = scoreProductYuka(yogurtIng, {}, [], {
    productTitle: "Berry Swirl Strawberry Lowfat Yogurt",
  });
  const yogurt2xDyes = scoreProductYuka(yogurtIng, {}, ["dyes"], {
    productTitle: "Berry Swirl Strawberry Lowfat Yogurt",
  });
  const yogurt2xBoth = scoreProductYuka(yogurtIng, {}, ["dyes", "hfcs"], {
    productTitle: "Berry Swirl Strawberry Lowfat Yogurt",
  });
  check(
    "Family Watchlist 2x Strictness: enabling 2x categories strictly lowers finalScore even when a high-risk additive is already present",
    yogurt1x.score === 28 &&
      yogurt2xDyes.score < yogurt1x.score &&
      yogurt2xBoth.score < yogurt2xDyes.score &&
      yogurt2xBoth.score === 6
  );

  check(
    "Android 1-Switch Overlay + Instant Pre-Scan + Watchlist Live Refresh verification",
    overlayKt.includes("TYPE_ACCESSIBILITY_OVERLAY") &&
      overlayKt.includes("ScanApi.applyLocalWatchlistToData") &&
      readerKt.includes("ScanApi.prewarmScan") &&
      readerKt.includes("ScanApi.peekCachedScan") &&
      scanApiKt.includes("fun applyLocalWatchlistToData") &&
      mainKt.includes("import android.content.ClipboardManager")
  );

  // --- Walmart Screenshot Regression Suite: Whole Sweet Potato (90/100), Russet Potatoes (90/100), Butterball Turkey (70/100), and Non-Food Paper Towels / Plastic Cutlery ---
  const sweetPotatoScan = await runScan({
    productTitle: "Fresh Whole Sweet Potato",
    store: "walmart",
  });
  const russetPotatoScan = await runScan({
    productTitle: "Fresh Whole Russet Potatoes, 5 lb Bag",
    store: "walmart",
  });
  const butterballTurkeyScan = await runScan({
    productTitle: "Butterball Frozen Whole Turkey, All Natural, 10-16 lbs., Serves 7-11, 21g of P...",
    store: "walmart",
  });
  const plasticForksScan = await runScan({
    productTitle: "Great Value Disposable Plastic Forks and Spoons, White, 48 Count",
    store: "walmart",
  });
  const paperTowelsScan = await runScan({
    productTitle: "Great Value Everyday Strong Paper Towels, 2 Double Rolls",
    store: "walmart",
  });
  check(
    "Walmart Produce & Turkey Accuracy: Fresh Whole Sweet Potato (90/100, 0 seed oils), Fresh Whole Russet Potatoes (90/100), Butterball Frozen Whole Turkey (70/100), and Paper Towels / Plastic Forks rejected as non-food",
    Boolean(
      sweetPotatoScan.ok &&
        sweetPotatoScan.result?.score === 90 &&
        sweetPotatoScan.result?.rating === "Excellent" &&
        (sweetPotatoScan.result?.flagged?.length ?? 1) === 0 &&
        !/\boil\b/i.test(sweetPotatoScan.product?.ingredients ?? "") &&
        russetPotatoScan.ok &&
        russetPotatoScan.result?.score === 90 &&
        russetPotatoScan.result?.rating === "Excellent" &&
        butterballTurkeyScan.ok &&
        butterballTurkeyScan.product?.brand === "Butterball" &&
        butterballTurkeyScan.result?.score === 70 &&
        !plasticForksScan.ok &&
        plasticForksScan.status === 404 &&
        !paperTowelsScan.ok &&
        paperTowelsScan.status === 404 &&
        readerKt.includes("NON_FOOD_PRODUCT") &&
        historyStoreKt.includes("isPoisonedProduceEntry")
    )
  );

  const lookupTs = fs.readFileSync("lib/lookup.ts", "utf8");
  check(
    "Open Food Facts & USDA FoodData Central Resilience: DEMO_KEY fallback, 1800ms shared budget, v0 barcode fallback, US GS1 UPC priority, and No Salt Added / Spicy variant guards",
    lookupTs.includes("const TIMEOUT_MS = 1800") &&
      lookupTs.includes("fetchOffProductByCode") &&
      lookupTs.includes('/api/v0/product/${code}.json') &&
      lookupTs.includes('|| "DEMO_KEY"') &&
      !passesVariantGuard("Heinz Tomato Ketchup", "Heinz Tomato Ketchup No Salt Added") &&
      !passesVariantGuard("Heinz Tomato Ketchup", "Heinz No Sugar Added Tomato Ketchup")
  );

  // --- Part A & Part B Clean-Ingredient, USDA/OFF Extraction & NIH DSLD Regression Suite ---
  const { inferNutritionFromText } = await import("../lib/rubric");
  const { extractOffNutrition, extractUsdaNutrition, lookupDSLD } = await import("../lib/lookup");
  const { evaluateDietaryAlerts } = await import("../lib/scan");

  // A1.1: Natural vitamin/mineral fortifiers & fermentation cultures have 0 false-positive additive flags
  const cleanFortifiers = scoreIngredients(
    "Organic Whole Grain Oats, Ascorbic Acid (Vitamin C), Mixed Tocopherols (Vitamin E), Riboflavin (Vitamin B2), Niacinamide (Vitamin B3), Ferrous Sulfate (Iron), Zinc Oxide, Thiamine Mononitrate (Vitamin B1), Folic Acid, Lactic Acid, Fruit Pectin, Cream of Tartar, Baking Soda (Sodium Bicarbonate).",
  );
  const cleanFortifiersYuka = scoreProductYuka(
    "Organic Whole Grain Oats, Ascorbic Acid (Vitamin C), Mixed Tocopherols (Vitamin E), Riboflavin (Vitamin B2), Niacinamide (Vitamin B3), Ferrous Sulfate (Iron), Zinc Oxide, Thiamine Mononitrate (Vitamin B1), Folic Acid, Lactic Acid, Fruit Pectin, Cream of Tartar, Baking Soda (Sodium Bicarbonate).",
    {},
    [],
    { productTitle: "Organic Whole Grain Oats", isOrganic: true },
  );
  const cleanCultures = scoreIngredients(
    "Cultured Pasteurized Grade A Organic Whole Milk, Live and Active Cultures (S. Thermophilus, L. Bulgaricus, L. Acidophilus, Bifidus, L. Casei), Cheese Cultures, Microbial Enzymes, Organic Apple Cider Vinegar, Distilled White Vinegar.",
  );
  check(
    "Part A1: Natural vitamin/mineral fortifiers and fermentation cultures have 0 false-positive additive flags (score 100, additiveScore 30)",
    cleanFortifiers.score === 100 &&
      cleanFortifiers.flagged.length === 0 &&
      cleanFortifiersYuka.yukaBreakdown?.additiveScore === 30 &&
      cleanFortifiersYuka.score >= 95 &&
      cleanCultures.score === 100 &&
      cleanCultures.flagged.length === 0
  );

  // A1.2: Cold-pressed celery juice in green juices is NOT flagged as a meat-curing nitrate, whereas celery powder/cultured celery juice IS flagged
  const sujaGreens = scoreProductYuka(
    "Organic Cucumber Juice, Organic Celery Juice, Organic Grapefruit Juice, Organic Green Leaf Lettuce Juice, Organic Lacinato Kale Juice, Organic Lemon Juice, Organic Parsley Juice, Organic Spinach Juice, Organic Mint Tea.",
  {},
    [],
    { productTitle: "Suja Organic Cold-Pressed Uber Greens Juice", isOrganic: true },
  );
  const curedBaconCelery = scoreIngredients("Pork, Water, Sea Salt, Cultured Celery Powder, Celery Juice Powder.");
  check(
    "Part A1: Cold-pressed celery juice in Suja Uber Greens has 0 nitrate flags (scores 100/100), while Cultured Celery Powder is flagged",
    sujaGreens.score === 100 &&
      sujaGreens.flagged.length === 0 &&
      curedBaconCelery.flagged.some((f) => f.id === "celerynitrate")
  );

  // A1.3: Clean culinary oils (100% avocado, extra virgin olive, virgin coconut, grass-fed ghee, cocoa butter) vs deceptive seed-oil blends
  const pureCulinaryOils = scoreIngredients(
    "100% Pure Avocado Oil, Extra Virgin Olive Oil, Organic Virgin Coconut Oil, Grass-Fed Ghee (Clarified Butter), Organic Cocoa Butter.",
  );
  const sharedSuffixBlend1 = scoreIngredients("Potatoes, Canola and Extra Virgin Olive Oil, Sea Salt.");
  const sharedSuffixBlend2 = scoreIngredients("Whole Grain Oats, Canola or Palm Kernel Oil, Honey.");
  const sharedSuffixBlend3 = scoreIngredients("Cooked Chickpeas, Water, Tahini, Olive or Soybean Oil, Salt.");
  const hellmannsOliveMayoScan = await runScan({
    productTitle: "Hellmann's Mayonnaise Dressing with Olive Oil",
    store: "walmart",
  });
  const primalAvocadoMayoScan = await runScan({
    productTitle: "Primal Kitchen Real Mayonnaise Made with Avocado Oil",
    store: "walmart",
  });
  const chosenPureAvocadoOilScan = await runScan({
    productTitle: "Chosen Foods 100% Pure Avocado Oil",
    store: "walmart",
  });
  check(
    "Part A1: 100% Avocado/Olive/Coconut Oil & Ghee have 0 seed-oil flags, while deceptive 'with Olive Oil' mayo and shared-suffix blends flag hidden seed oils",
    Boolean(
      pureCulinaryOils.score === 100 &&
        pureCulinaryOils.flagged.length === 0 &&
        sharedSuffixBlend1.flagged.some((f) => f.id === "canolaoil") &&
        sharedSuffixBlend2.flagged.some((f) => f.id === "canolaoil") &&
        sharedSuffixBlend3.flagged.some((f) => f.id === "soybeanoil") &&
        hellmannsOliveMayoScan.ok &&
        hellmannsOliveMayoScan.product?.brand === "Hellmann's" &&
        hellmannsOliveMayoScan.result?.flagged.some((f) => f.id === "canolaoil" || f.id === "soybeanoil") &&
        (hellmannsOliveMayoScan.result?.score ?? 100) <= 49 &&
        primalAvocadoMayoScan.ok &&
        primalAvocadoMayoScan.product?.brand === "Primal Kitchen" &&
        (primalAvocadoMayoScan.result?.score ?? 0) >= 75 &&
        chosenPureAvocadoOilScan.ok &&
        chosenPureAvocadoOilScan.product?.title.includes("100% Pure Avocado Oil") &&
        (chosenPureAvocadoOilScan.result?.score ?? 0) >= 85
    )
  );

  // A1.4: Negated marketing claims ("no bht or bha", "no carrageenan", "no sugar added", "milk thistle") never trigger false flags or alerts
  const negatedClaimsCheck = scoreIngredients(
    "Organic Pasteurized Milk, No Carrageenan, No BHT or BHA, No Artificial Sweeteners, Seed-Oil-Free.",
  );
  const noSugarAddedAlerts = evaluateDietaryAlerts(
    ["sugar_diabetes", "dairy"],
    "Organic Unsweetened Applesauce & Milk Thistle Herbal Tea",
    "Organic Apples, Water, Ascorbic Acid (Vitamin C), No Sugar Added, Sugar Free, Organic Milk Thistle Extract.",
    { sugarsG100g: 9.0 },
  );
  check(
    "Part A1: Negated claims ('No BHT or BHA', 'No Carrageenan', 'No Sugar Added', 'Milk Thistle') never trigger false additive or dietary alerts",
    negatedClaimsCheck.score === 100 &&
      negatedClaimsCheck.flagged.length === 0 &&
      noSugarAddedAlerts.length === 0
  );

  // A1.5: Clean nut/seed butters (Sunflower Seed Butter, Tahini), clean chocolate milk, and clean whole-grain ramen score >= 80
  const sunButterCheck = scoreProductYuka(
    "Organic Roasted Sunflower Seeds.",
    {},
    [],
    { productTitle: "SunButter Organic Unsweetened Sunflower Seed Butter", isOrganic: true },
  );
  const chocGrassmilkCheck = scoreProductYuka(
    "Organic Grade A Lowfat Milk, Organic Fair Trade Unrefined Cane Sugar, Organic Fair Trade Dutch Cocoa, Organic Vanilla, Salt, Lactase Enzyme, Vitamin A Palmitate, Vitamin D3.",
    {},
    [],
    { productTitle: "Organic Valley Lowfat Chocolate Grassmilk", isOrganic: true },
  );
  const lotusRamenCheck = scoreProductYuka(
    "Organic Brown Rice Flour, Organic Millet Flour.",
    {},
    [],
    { productTitle: "Lotus Foods Organic Millet & Brown Rice Ramen", isOrganic: true },
  );
  check(
    "Part A1/A4: Clean sunflower seed butter, Organic Valley Chocolate Grassmilk, and Lotus Foods Millet & Brown Rice Ramen score >= 90",
    sunButterCheck.score >= 90 &&
      chocGrassmilkCheck.score >= 90 &&
      lotusRamenCheck.score >= 90
  );

  // A2: USDA FoodData Central extraction accuracy (1008 kcal vs 1062 kJ, Atwater 2047, Foundation/SR Legacy whole foods)
  const usdaKjOnlyAndKcal = extractUsdaNutrition({
    dataType: "Foundation",
    description: "Apples, honeycrisp, raw",
    foodNutrients: [
      { nutrientId: 1062, nutrientNumber: "268", nutrientName: "Energy", unitName: "kJ", value: 218 },
      { nutrientId: 2047, nutrientNumber: "957", nutrientName: "Energy (Atwater General Factors)", unitName: "KCAL", value: 52 },
      { nutrientId: 2000, nutrientNumber: "269", nutrientName: "Total Sugars", unitName: "G", value: 10.4 },
      { nutrientId: 1258, nutrientNumber: "606", nutrientName: "Fatty acids, total saturated", unitName: "G", value: 0.03 },
      { nutrientId: 1093, nutrientNumber: "307", nutrientName: "Sodium, Na", unitName: "MG", value: 1 },
      { nutrientId: 1079, nutrientNumber: "291", nutrientName: "Fiber, total dietary", unitName: "G", value: 2.4 },
      { nutrientId: 1003, nutrientNumber: "203", nutrientName: "Protein", unitName: "G", value: 0.26 },
    ],
  });
  const usdaChiaSeeds = extractUsdaNutrition({
    dataType: "SR Legacy",
    description: "Seeds, chia seeds, dried",
    foodNutrients: [
      { nutrientId: 1008, nutrientNumber: "208", nutrientName: "Energy", unitName: "KCAL", value: 486 },
      { nutrientId: 1079, nutrientNumber: "291", nutrientName: "Fiber, total dietary", unitName: "G", value: 34.4 },
      { nutrientId: 1003, nutrientNumber: "203", nutrientName: "Protein", unitName: "G", value: 16.5 },
    ],
  });
  check(
    "Part A2: extractUsdaNutrition never treats 1062 kJ as kcal, supports Atwater 2047 kcal, and sets isWholeFood + fruitsVegNutsPct=100 on Foundation/SR Legacy produce & dried seeds",
    usdaKjOnlyAndKcal?.caloriesKcal100g === 52 &&
      usdaKjOnlyAndKcal?.isWholeFood === true &&
      usdaKjOnlyAndKcal?.fruitsVegNutsPct === 100 &&
      usdaChiaSeeds?.caloriesKcal100g === 486 &&
      usdaChiaSeeds?.isWholeFood === true &&
      usdaChiaSeeds?.fruitsVegNutsPct === 100
  );

  // A3: Open Food Facts v2 extraction accuracy (kJ conversion, sodium g->mg, labels_tags isOrganic, and inferNutritionFromText filling missing positive nutrients)
  const offPartialWholeGrain = extractOffNutrition({
    product_name_en: "Organic Sprouted Rolled Oats",
    ingredients_text_en: "100% Organic Sprouted Whole Grain Oats.",
    labels_tags: ["en:organic", "en:usda-organic"],
    nutriments: {
      "energy_100g": 1586, // kJ only (~379 kcal)
      "sugars_100g": 1.0,
      "saturated-fat_100g": 1.2,
      "sodium_100g": 0.005, // 5 mg
      // fiber_100g and proteins_100g missing from OFF payload!
    },
  });
  const offScore = scoreProductYuka(
    "100% Organic Sprouted Whole Grain Oats.",
    {},
    [],
    { ...offPartialWholeGrain, productTitle: "Organic Sprouted Rolled Oats" },
  );
  const inferredPreservesMeasured = inferNutritionFromText(
    "100% Whole Grain Rolled Oats",
    "100% Whole Grain Rolled Oats.",
    { caloriesKcal100g: 370, sugarsG100g: 0.8, saturatedFatG100g: 1.4, sodiumMg100g: 3 },
    { onlyPositive: true },
  );
  check(
    "Part A3: extractOffNutrition converts kJ->kcal, sodium g->mg, detects en:usda-organic from labels_tags, and inferNutritionFromText fills missing positive nutrients",
    Math.round(offPartialWholeGrain.caloriesKcal100g ?? 0) === 379 &&
      offPartialWholeGrain.sodiumMg100g === 5 &&
      offPartialWholeGrain.isOrganic === true &&
      (offPartialWholeGrain.fiberG100g ?? 0) >= 8 &&
      (offPartialWholeGrain.proteinG100g ?? 0) >= 10 &&
      offScore.score >= 95 &&
      inferredPreservesMeasured.caloriesKcal100g === 370 &&
      inferredPreservesMeasured.sugarsG100g === 0.8 &&
      (inferredPreservesMeasured.fiberG100g ?? 0) >= 8
  );

  // Part B: Whole nuts/seeds/legumes resolver & NIH DSLD supplement API integration
  const rawAlmondsScan = await runScan({
    productTitle: "Raw Whole Almonds, 16 oz",
    store: "walmart",
  });
  const dsldLiveResult = await lookupDSLD("Optimum Nutrition Gold Standard 100% Whey");
  check(
    "Part B: Raw Whole Almonds resolve as single-ingredient whole food (90/100 Excellent), and lookupDSLD is wired for dietary supplements",
    Boolean(
      rawAlmondsScan.ok &&
        rawAlmondsScan.result?.score === 90 &&
        rawAlmondsScan.result?.rating === "Excellent" &&
        rawAlmondsScan.product?.nutrition?.isWholeFood === true &&
        rawAlmondsScan.result?.yukaBreakdown?.organicScore === 0 &&
        (dsldLiveResult === null || (dsldLiveResult.source === "dsld" && dsldLiveResult.ingredients.length > 10))
    )
  );

  // Additional edge-case checks: Sugar Snap Peas, Mott's Unsweetened Applesauce, Baking Soda in pancake mix, single-ingredient EVOO, and Soy-Free/Butter Beans/Egg-Free dietary alerts
  const sugarSnapPeasCheck = scoreProductYuka(
    "Organic Sugar Snap Peas.",
    {},
    [],
    { productTitle: "Fresh Organic Sugar Snap Peas" },
  );
  const unsweetenedApplesauceCheck = scoreProductYuka(
    "Apples, Water, Ascorbic Acid (Vitamin C) to Maintain Color.",
    {},
    [],
    { productTitle: "Mott's Unsweetened Applesauce" },
  );
  const almondPancakeMixCheck = scoreProductYuka(
    "Blanched Almond Flour, Arrowroot, Tapioca, Organic Coconut Sugar, Cream of Tartar, Baking Soda, Sea Salt.",
    {},
    [],
    { productTitle: "Simple Mills Almond Flour Pancake & Waffle Mix" },
  );
  const pureEvooYukaCheck = scoreProductYuka(
    "100% Extra Virgin Olive Oil.",
    {},
    [],
    { productTitle: "Pompeian 100% Extra Virgin Olive Oil" },
  );
  const falsePositiveAlerts = evaluateDietaryAlerts(
    ["sugar_diabetes", "soy", "dairy", "egg"],
    "Organic Sugar Snap Peas & Butternut Squash with Vegan Mayo",
    "Organic Sugar Snap Peas, Butternut Squash, Butter Beans, Water, Avocado Oil, Sunflower Lecithin (Soy-Free), Egg-Free Vegan Mayonnaise, No Sugar Added.",
    { sugarsG100g: 3.5 },
  );
  check(
    "Part A1/A4 Edge Cases: Sugar Snap Peas (90/100), Unsweetened Applesauce (90/100), Baking Soda in pancake mix, 100% EVOO (90/100), and Soy-Free / Butter Beans / Egg-Free alerts have 0 false positives",
    sugarSnapPeasCheck.score === 90 &&
      sugarSnapPeasCheck.flagged.length === 0 &&
      unsweetenedApplesauceCheck.score === 90 &&
      unsweetenedApplesauceCheck.flagged.length === 0 &&
      almondPancakeMixCheck.flagged.length === 0 &&
      almondPancakeMixCheck.yukaBreakdown?.additiveScore === 30 &&
      !almondPancakeMixCheck.yukaBreakdown?.calorieNote?.includes("Liquid Calories") &&
      pureEvooYukaCheck.score === 90 &&
      pureEvooYukaCheck.flagged.length === 0 &&
      falsePositiveAlerts.length === 0
  );

  // Final sign-off regression checks: Vitamin E IU vs E150/E110, calcium phosphates vs sodium/potassium phosphates,
  // non-bromated flour, glucose/rice/tapioca syrups, variant guard sugar/fat rules, Guayaki Enlighten Mint vs Terere,
  // Annie's Shells & Real Aged Cheddar 63/100, 0 pooled drink titles, and 100% swap provenance
  const vitEIuCheck = scoreIngredients("Purified Water, Vitamin C 250 mg, Vitamin E 150 IU, Vitamin E (d-alpha-tocopherol) 110 IU.");
  const realENumberCheck = scoreIngredients("Carbonated Water, E150d, E110.");
  check(
    "Vitamin E 150 IU / 110 IU never false-positives on E150 caramel color or E110 Yellow 6, while E150d and E110 remain flagged",
    vitEIuCheck.score === 100 &&
      vitEIuCheck.flagged.length === 0 &&
      realENumberCheck.flagged.some((f) => f.id === "caramelcolor") &&
      realENumberCheck.flagged.some((f) => f.id === "yellow6")
  );

  const caPhosphateCheck = scoreIngredients("Filtered Water, Almonds, Tricalcium Phosphate, Dicalcium Phosphate, Calcium Phosphate, Sea Salt.");
  const naKPhosphateCheck = scoreIngredients("Water, Trisodium Phosphate, Dipotassium Phosphate.");
  check(
    "Calcium fortifiers (tricalcium/dicalcium/calcium phosphate) are not flagged as synthetic sodium/potassium phosphates",
    caPhosphateCheck.score === 100 &&
      caPhosphateCheck.flagged.length === 0 &&
      naKPhosphateCheck.flagged.some((f) => f.id === "naphosphate")
  );

  const nonBromatedCheck = scoreIngredients("Unbleached Non Bromated Wheat Flour, Unbromated Flour, Water, Sea Salt.");
  const bromatedCheck = scoreIngredients("Enriched Bromated Wheat Flour, Water, Salt.");
  check(
    "Non bromated / unbromated flour (with space or hyphen) never triggers Potassium Bromate",
    nonBromatedCheck.score === 100 &&
      nonBromatedCheck.flagged.length === 0 &&
      bromatedCheck.flagged.some((f) => f.id === "kbromate")
  );

  const syrupBarCheck = scoreProductYuka(
    "Organic Brown Rice Syrup, Organic Tapioca Syrup, Glucose Syrup, Rolled Oats, Roasted Peanuts.",
    {},
    [],
    { productTitle: "Chewy Granola Bar" },
  );
  check(
    "Glucose syrup is flagged under corn/glucose syrup and rice/tapioca/glucose syrups never claim No Added Sugar in Ingredients",
    syrupBarCheck.flagged.some((f) => f.id === "cornsyrup") &&
      syrupBarCheck.yukaBreakdown?.glucoseImpact !== "No Added Sugar in Ingredients"
  );

  check(
    "Variant guard enforces dairy fat %, unsweetened plant milk, and zero-sugar drink modifiers while allowing inherently zero-sugar brands",
    !passesVariantGuard("Whole Milk", "Great Value 2% Reduced Fat Milk") &&
      !passesVariantGuard("2% Milk", "Great Value Whole Milk") &&
      !passesVariantGuard("Monster Energy", "Monster Energy Zero Ultra") &&
      !passesVariantGuard("Silk Almondmilk", "Silk Unsweetened Almondmilk") &&
      passesVariantGuard("Zevia Cola", "Zevia Zero Sugar Cola Soda")
  );

  const guayakiMint = matchDrinkCatalog("Guayaki Enlighten Mint Yerba Mate");
  const guayakiTerere = matchDrinkCatalog("Guayaki Unsweetened Traditional Terere");
  const guayakiMintScore = guayakiMint
    ? scoreProductYuka(guayakiMint.ingredients, {}, [], { ...guayakiMint.nutrition, productTitle: guayakiMint.title })
    : null;
  const guayakiTerereScore = guayakiTerere
    ? scoreProductYuka(guayakiTerere.ingredients, {}, [], { ...guayakiTerere.nutrition, productTitle: guayakiTerere.title })
    : null;
  const monsterSwap = resolveSwap({ score: 15, productTitle: "Monster Energy Drink", store: "walmart" });
  check(
    "Guayaki Enlighten Mint reflects 28g cane sugar (49/100 Poor), while Unsweetened Traditional Terere scores 100/100 and serves as the clean energy swap",
    Boolean(
      guayakiMint &&
        guayakiMint.nutrition.sugarsG100g === 6.1 &&
        guayakiMintScore?.score === 49 &&
        guayakiMintScore?.rating === "Poor" &&
        guayakiTerere &&
        guayakiTerere.nutrition.sugarsG100g === 0 &&
        guayakiTerereScore?.score === 100 &&
        monsterSwap?.name.includes("Unsweetened Traditional Tereré") &&
        monsterSwap?.score === 100
    )
  );

  const anniesLookup = await lookupIngredients({ productTitle: "Annie's Organic Grass-Fed Shells & Real Aged Cheddar" });
  const anniesScore = anniesLookup
    ? scoreProductYuka(anniesLookup.ingredients, {}, [], { ...anniesLookup.nutrition, productTitle: anniesLookup.productTitle })
    : null;
  const kraftMacSwap = resolveSwap({ score: 22, productTitle: "Kraft Macaroni & Cheese Dinner", store: "walmart" });
  check(
    "Annie's Organic Grass-Fed Shells & Real Aged Cheddar reflects US label nutrition and Sodium Phosphate (53/100 Mediocre)",
    Boolean(
      anniesLookup &&
        anniesScore?.score === 53 &&
        anniesScore?.rating === "Mediocre" &&
        kraftMacSwap?.score === 53
    )
  );

  const allSwaps = [...Object.values(CLEAN_ALTERNATIVES), ...EXACT_PRODUCT_ALTERNATIVES.map((e) => e.alt)];
  check(
    "Catalog sign-off: 0 pooled multi-flavor titles in DRINKS_CATALOG and 100% valid provenance on all swaps",
    DRINKS_CATALOG.every((item) => !/\([^)]*,[^)]*\)/.test(item.title)) &&
      allSwaps.every((alt) => hasValidCatalogProvenance(alt.sourceUrl, alt.verifiedAt))
  );

  const sweetPotatoLookup = await lookupIngredients({ productTitle: "Fresh Whole Sweet Potato" });
  const sweetPotatoScore = sweetPotatoLookup
    ? scoreProductYuka(sweetPotatoLookup.ingredients, {}, [], {
        ...sweetPotatoLookup.nutrition,
        productTitle: sweetPotatoLookup.productTitle,
      })
    : null;
  check(
    "Fresh Whole Sweet Potato resolves to Fresh Produce (90/100 Excellent, 0 flags, never Simply Nature chips or canned yams)",
    Boolean(
      sweetPotatoLookup &&
        sweetPotatoLookup.brand === "Fresh Produce" &&
        sweetPotatoScore?.score === 90 &&
        sweetPotatoScore?.rating === "Excellent" &&
        sweetPotatoScore?.flagged.length === 0 &&
        sweetPotatoLookup.imageUrl?.includes("&v=4")
    )
  );

  check(
    "Beverage flavor guard rejects unmatched flavor queries (LaCroix Pamplemousse, Bubly Grapefruit, Guayaki Revel Berry, C4 Skittles)",
    matchDrinkCatalog("LaCroix Pamplemousse") === null &&
      matchDrinkCatalog("Bubly Grapefruit") === null &&
      matchDrinkCatalog("Guayaki Revel Berry") === null &&
      matchDrinkCatalog("C4 Skittles") === null &&
      matchDrinkCatalog("Clean Cause Blackberry") === null &&
      matchDrinkCatalog("Vitaminwater Dragonfruit") === null
  );

  const frapSwap = resolveSwap({ score: 30, productTitle: "Starbucks Bottled Mocha Frappuccino", store: "walmart" });
  check(
    "Starbucks Bottled Mocha Frappuccino resolves to SToK Unsweetened Black Cold Brew Coffee (85/100)",
    Boolean(frapSwap && frapSwap.brand === "SToK" && frapSwap.score === 85)
  );

  const productImageRouteTs = fs.readFileSync("app/api/product-image/route.ts", "utf8");
  const simulatorTsx = fs.readFileSync("components/Simulator.tsx", "utf8");
  check(
    "Product Image Resolution & Brand-Neutral Fallbacks: Verified Open Food Facts catalog mapping, peanut butter before butter routing, hyphenated multi-word brands_tags, and Android history URL auto-upgrade",
    productImageRouteTs.includes("VERIFIED_PRODUCT_IMAGES") &&
      productImageRouteTs.indexOf("peanutbutter.png") < productImageRouteTs.indexOf("butter.jpg") &&
      productImageRouteTs.includes('brands_tags:"${tokens[0]}-${tokens[1]}"') &&
      productImageRouteTs.includes("BLOCKED_ROTATED_OFF_IMAGE_RE") &&
      historyStoreKt.includes("VERIFIED_OFF_IMAGES") &&
      historyStoreKt.includes("fun resolveBestImageUrl") &&
      historyStoreKt.includes("fun productImageApiFallbackUrl") &&
      mainKt.includes("ScanHistoryStore.resolveBestImageUrl(title, imgUrl") &&
      !mainKt.includes('imgSource.contains("Category Illustration", ignoreCase = true)') &&
      overlayKt.includes("ScanHistoryStore.resolveBestImageUrl(swapTitle, rawImage") &&
      simulatorTsx.includes("/api/product-image?q=${encodeURIComponent(`${alt.brand} ${alt.name}`)}")
  );

  const { buildLinks } = await import("../lib/swaps");
  const { PRICING, commissionFor, annualSavingsPct } = await import("../lib/pricing");
  const { verifyStripeWebhookSignature } = await import("../lib/stripe-webhook");
  const crypto = await import("node:crypto");

  const webAmz = buildLinks(CLEAN_ALTERNATIVES.Snacks, "amazon", "", "web");
  const extAmz = buildLinks(CLEAN_ALTERNATIVES.Snacks, "amazon", "", "extension");
  const androidAmz = buildLinks(CLEAN_ALTERNATIVES.Snacks, "amazon", "", "android");
  const rCodePageTsx = fs.readFileSync("app/r/[code]/page.tsx", "utf8");
  const creatorsPageTsx = fs.readFileSync("app/creators/page.tsx", "utf8");
  const infRouteTs = fs.readFileSync("app/api/influencers/route.ts", "utf8");
  const rcWebhookTs = fs.readFileSync("app/api/revenuecat/webhook/route.ts", "utf8");
  const checkoutRouteTs = fs.readFileSync("app/api/checkout/route.ts", "utf8");

  const testSecret = "whsec_test_audit_secret";
  const testPayload = JSON.stringify({ id: "evt_test_123", type: "checkout.session.completed" });
  const nowSec = Math.floor(Date.now() / 1000);
  const validSig = crypto
    .createHmac("sha256", testSecret)
    .update(`${nowSec}.${testPayload}`, "utf8")
    .digest("hex");

  const paywallTsx = fs.readFileSync("components/Paywall.tsx", "utf8");
  const referralRouteTs = fs.readFileSync("app/api/referral/route.ts", "utf8");
  const stripeWebhookRouteTs = fs.readFileSync("app/api/stripe/webhook/route.ts", "utf8");
  const {
    applyOrActivateReferral,
    ensureReferralCodeRegistered,
    getOrCreateDevice,
    isValidReferralCode,
  } = await import("../lib/referrals");
  const {
    createCreator,
    recordStripeCreatorConversionOnce,
    recordStripeCreatorRefundOnce,
  } = await import("../lib/influencers");

  try {
    fs.rmSync(".cache/heybroc-kv.json", { force: true });
  } catch {
    /* ignore */
  }
  const runSuffix = Date.now().toString(36).toUpperCase();
  const reauditDev = await getOrCreateDevice(`dev_reaudit_friend_${runSuffix}`, "secret_reaudit_12345");
  const invalidClaimRes = await applyOrActivateReferral({
    deviceId: reauditDev.deviceId,
    deviceSecret: "secret_reaudit_12345",
    referralCode: "BROC-ZZZZ9999",
    activateNow: false,
  });
  const selfClaimRes = await applyOrActivateReferral({
    deviceId: reauditDev.deviceId,
    deviceSecret: "secret_reaudit_12345",
    referralCode: reauditDev.referralCode,
    activateNow: false,
  });
  const authRefCode = `BROC-AU${runSuffix.replace(/[^A-Z0-9]/g, "2").slice(-6).padStart(6, "2")}`;
  await ensureReferralCodeRegistered(authRefCode, `user:usr_reaudit_${runSuffix}`);
  const validUserCode = await isValidReferralCode(authRefCode);
  const validClaimRes = await applyOrActivateReferral({
    deviceId: reauditDev.deviceId,
    deviceSecret: "secret_reaudit_12345",
    referralCode: authRefCode,
    activateNow: false,
  });
  const validActivateRes = await applyOrActivateReferral({
    deviceId: reauditDev.deviceId,
    activateNow: true,
  });

  const reauditCreatorCode = `REAUDIT_${runSuffix}`;
  await createCreator({ code: reauditCreatorCode, name: "Reaudit Creator", commissionPct: 25 });
  await recordStripeCreatorConversionOnce(`inv_reaudit_${runSuffix}`, reauditCreatorCode, "paid_annual", 49.99);
  const afterRefund1 = await recordStripeCreatorRefundOnce(`ref_reaudit_1_${runSuffix}`, reauditCreatorCode, "annual", 49.99);
  const afterRefund2 = await recordStripeCreatorRefundOnce(`ref_reaudit_2_${runSuffix}`, reauditCreatorCode, "annual", 49.99);

  check(
    "Affiliate Links, Creator Promo Codes, Friend Referrals & Stripe/RevenueCat Audit Verification",
    Boolean(
      webAmz.isPaidLink === true &&
        webAmz.webUrl.includes("tag=heybroc-20") &&
        extAmz.isPaidLink === false &&
        !extAmz.webUrl.includes("tag=") &&
        androidAmz.isPaidLink === false &&
        !androidAmz.webUrl.includes("tag=") &&
        PRICING.trialDays === 7 &&
        PRICING.creatorTrialDays === 7 &&
        PRICING.referralBonusDays === 7 &&
        PRICING.freeWeeklySwaps === 3 &&
        commissionFor("annual", 25) === 12.5 &&
        commissionFor("monthly", 25) === 2.5 &&
        annualSavingsPct === 58 &&
        PRICING_TERMS_VERSION === "2026-11-08" &&
        verifyStripeWebhookSignature(testPayload, `t=${nowSec},v1=${validSig}`, testSecret, nowSec) === true &&
        verifyStripeWebhookSignature(testPayload, `t=${nowSec - 999},v1=${validSig}`, testSecret, nowSec) === false &&
        rCodePageTsx.includes("isFriendInvite") &&
        rCodePageTsx.includes("7-DAY FREE PRO TRIAL") &&
        !rCodePageTsx.includes("14-DAY") &&
        creatorsPageTsx.includes('cleanCode.startsWith("BROC")') &&
        infRouteTs.includes('rawCode.startsWith("BROC")') &&
        rcWebhookTs.includes("amountPaidUsd") &&
        rcWebhookTs.includes("rc_sess_${subscriptionId}") &&
        rcWebhookTs.includes("isFriendCreatorAttr") &&
        checkoutRouteTs.includes("resolveAllowedOrigin") &&
        simulatorTsx.includes('params.get("upgrade") === "1"') &&
        paywallTsx.includes('window.localStorage.getItem("heybroc_device_secret")') &&
        referralRouteTs.includes("if (!res.ok)") &&
        stripeWebhookRouteTs.includes("invoiceRefCode") &&
        invalidClaimRes.ok === false &&
        selfClaimRes.ok === false &&
        validUserCode === true &&
        validClaimRes.ok === true &&
        validActivateRes.ok === true &&
        validActivateRes.rewardedNow === true &&
        afterRefund1?.paidAnnual === 0 &&
        afterRefund1?.grossRevenue === 0 &&
        afterRefund2?.grossRevenue === 0 &&
        afterRefund2?.commissionOwed === 0
    )
  );

  const sargentoAmericanSwap = resolveSwap({
    score: 26,
    productTitle: "Sargento Natural American Sliced Cheese, 12 Slices",
    store: "walmart",
    surface: "android",
  });
  const creamOfChickenSwap = resolveSwap({
    score: 12,
    productTitle: "Campbell's Condensed Cream of Chicken Soup, 10.5 oz Can",
    store: "walmart",
    surface: "android",
  });
  const ramenWalmartSwap = resolveSwap({
    score: 6,
    productTitle: "Maruchan Ramen Noodle Soup, Chicken Flavor",
    store: "walmart",
    surface: "android",
  });
  const sausageWalmartSwap = resolveSwap({
    score: 6,
    productTitle: "Great Value Original Pork Sausage Patties",
    store: "walmart",
    surface: "android",
  });
  const a11yXml = fs.readFileSync("android-app/app/src/main/res/xml/accessibility_service_config.xml", "utf8");
  check(
    "1-for-1 American Cheese & Cream of Chicken swaps, verified Walmart /ip/ deep links, Cart Check inline swap preview, and PiP-safe multi-window search",
    Boolean(
      sargentoAmericanSwap?.title === "Organic Valley Organic American Cheese Slices" &&
        sargentoAmericanSwap.deepLink === "https://www.walmart.com/ip/1814292019" &&
        creamOfChickenSwap?.title === "Pacific Foods Organic Cream of Chicken Condensed Soup" &&
        creamOfChickenSwap.deepLink === "https://www.walmart.com/ip/541659748" &&
        ramenWalmartSwap?.deepLink === "https://www.walmart.com/search?q=Lotus%20Foods%20Organic%20Millet%20%26%20Brown%20Rice%20Ramen" &&
        sausageWalmartSwap?.deepLink === "https://www.walmart.com/ip/967953484" &&
        a11yXml.includes("flagRetrieveInteractiveWindows") &&
        readerKt.includes("fun findStoreWindowRoot") &&
        overlayKt.includes("↳ Clean Swap: $swapTitle$swapScoreSuffix") &&
        overlayKt.includes("Preview Swap") &&
        overlayKt.includes("Review All $count Clean Swaps")
    )
  );

  const { STORE_SPECIFIC_OVERRIDES, resolveCleanAlternative } = await import("../lib/swaps");
  const allStoreOverrides = Object.values(STORE_SPECIFIC_OVERRIDES)
    .flatMap((rules) => (rules ?? []).map((r) => r.alt));
  const samsButterSwap = resolveSwap({
    score: 20,
    productTitle: "Country Crock Original Vegetable Oil Spread",
    store: "sams",
    surface: "android",
  });
  const costcoMilkSwap = resolveSwap({
    score: 54,
    productTitle: "Great Value Whole Vitamin D Milk",
    store: "costco",
    surface: "android",
  });
  const aldiPbSwap = resolveSwap({
    score: 35,
    productTitle: "Jif Creamy Peanut Butter",
    store: "aldi",
    surface: "android",
  });
  const bjsEggsSwap = resolveSwap({
    score: 50,
    productTitle: "Grade A Large White Eggs",
    store: "bjs",
    surface: "android",
  });
  const targetSyrupSwap = resolveSwap({
    score: 12,
    productTitle: "Pearl Milling Company Original Syrup",
    store: "target",
    surface: "android",
  });
  const krogerMilkSwap = resolveSwap({
    score: 54,
    productTitle: "Kroger 2% Reduced Fat Milk",
    store: "kroger",
    surface: "android",
  });
  const amazonButterSwap = resolveSwap({
    score: 20,
    productTitle: "Imperial Vegetable Oil Spread",
    store: "amazon",
    surface: "android",
  });
  const walmartBreadSwap = resolveSwap({
    score: 25,
    productTitle: "Wonder Classic White Sandwich Bread",
    store: "walmart",
    surface: "android",
  });
  const walmartOatMilkSwap = resolveSwap({
    score: 35,
    productTitle: "Planet Oat Original Oatmilk",
    store: "walmart",
    surface: "android",
  });

  check(
    "Store-Specific Clean Swaps: Sam's Club (Member's Mark), Costco (Kirkland Signature), ALDI (Simply Nature), BJ's (Wellsley Farms), Target (Good & Gather), Kroger (Simple Truth Organic), Amazon (365 by Whole Foods Market), and Walmart nationwide brands with /ip/ IDs",
    Boolean(
      allStoreOverrides.length >= 40 &&
        allStoreOverrides.every(
          (alt) =>
            !alt.brand.includes("/") &&
            !alt.name.includes("/") &&
            hasValidCatalogProvenance(alt.sourceUrl, alt.verifiedAt) &&
            scoreIngredients(alt.ingredients).score >= 90
        ) &&
        samsButterSwap?.brand === "Member's Mark" &&
        samsButterSwap.title.includes("Salted Butter") &&
        samsButterSwap.webUrl?.includes("samsclub.com") &&
        costcoMilkSwap?.brand === "Kirkland Signature" &&
        costcoMilkSwap.title.includes("Organic Whole Milk") &&
        costcoMilkSwap.webUrl?.includes("costco.com") &&
        aldiPbSwap?.brand === "Simply Nature" &&
        aldiPbSwap.title.includes("Organic Creamy Peanut Butter") &&
        aldiPbSwap.webUrl?.includes("shop.aldi.us") &&
        bjsEggsSwap?.brand === "Wellsley Farms" &&
        bjsEggsSwap.title.includes("Eggs") &&
        bjsEggsSwap.webUrl?.includes("bjs.com") &&
        targetSyrupSwap?.brand === "Good & Gather" &&
        targetSyrupSwap.title.includes("Maple Syrup") &&
        targetSyrupSwap.webUrl?.includes("target.com") &&
        krogerMilkSwap?.brand === "Simple Truth Organic" &&
        krogerMilkSwap.title.includes("2% Reduced Fat Milk") &&
        krogerMilkSwap.webUrl?.includes("kroger.com") &&
        amazonButterSwap?.brand === "365 by Whole Foods Market" &&
        amazonButterSwap.title.includes("Salted Butter") &&
        amazonButterSwap.webUrl?.includes("amazon.com") &&
        walmartBreadSwap?.brand === "Dave's Killer Bread" &&
        walmartBreadSwap.deepLink === "https://www.walmart.com/ip/45804393" &&
        walmartOatMilkSwap?.brand === "Califia Farms" &&
        walmartOatMilkSwap.deepLink === "https://www.walmart.com/ip/269553533"
    )
  );

  let brocCreatorBlocked = false;
  try {
    await createCreator({ code: "BROCRESERVED", name: "Reserved Test" });
  } catch {
    brocCreatorBlocked = true;
  }
  const selfDev = await getOrCreateDevice("test-audit5-self-dev");
  const selfApply = await applyOrActivateReferral({
    deviceId: "test-audit5-self-dev",
    referralCode: selfDev.referralCode,
  });
  const invalidApply = await applyOrActivateReferral({
    deviceId: "test-audit5-self-dev",
    referralCode: "BROC-ZZZZ9999",
  });
  const nextConfigSrc = fs.readFileSync("next.config.ts", "utf8");
  const mainActivityKtSrc = fs.readFileSync(
    "android-app/app/src/main/java/com/cleancart/overlay/MainActivity.kt",
    "utf8"
  );
  const chromePopupHtml = fs.readFileSync("chrome-extension/popup.html", "utf8");
  const iosPopupHtml = fs.readFileSync(
    "ios-app/SafariExtension/Resources/popup.html",
    "utf8"
  );

  check(
    "Audit Pass 3–5 hardening: createCreator reserves BROC prefix, applyOrActivateReferral rejects self/invalid codes with ok:false, store-aware resolveCleanAlternative, /login redirect, and ScanApi weeklySwapsLimit clamping",
    Boolean(
      brocCreatorBlocked &&
        selfApply.ok === false &&
        invalidApply.ok === false &&
        resolveCleanAlternative("Country Crock Original Spread", "Butter/Dairy", "costco").brand ===
          "Kirkland Signature" &&
        nextConfigSrc.includes('source: "/login"') &&
        nextConfigSrc.includes('destination: "/?login=1"') &&
        !mainActivityKtSrc.includes("https://www.heybroc.com/login") &&
        !chromePopupHtml.includes("https://www.heybroc.com/login") &&
        !iosPopupHtml.includes("https://www.heybroc.com/login") &&
        scanApiKt.includes("val limit = weeklySwapsLimit(ctx)") &&
        scanApiKt.includes("val limit = weeklySwapsLimit(appCtx)")
    )
  );

  const registeredOwner = await ensureReferralCodeRegistered("BROC-AUDIT7", "user:audit-owner-7");
  const auditFriendDev = await getOrCreateDevice("device-audit-friend-7", "secret_audit_777");
  const auditClaimRes = await applyOrActivateReferral({
    deviceId: auditFriendDev.deviceId,
    deviceSecret: "secret_audit_777",
    referralCode: "BROC-AUDIT7",
    activateNow: false,
  });
  const auditSelfClaimRes = await applyOrActivateReferral({
    deviceId: "user:audit-owner-7",
    referralCode: "BROC-AUDIT7",
    activateNow: false,
  });
  const prodImgRouteTs = fs.readFileSync("app/api/product-image/route.ts", "utf8");
  const seoSwapsPageTsx = fs.readFileSync("app/swaps/[slug]/page.tsx", "utf8");
  check(
    "Audit Pass 6–7 regression: ensureReferralCodeRegistered registers owner, self-referral is rejected, and SEO/image/Android guards hold",
    Boolean(
      brocCreatorBlocked &&
        registeredOwner?.referralCode === "BROC-AUDIT7" &&
        auditClaimRes.ok &&
        auditClaimRes.device.referredByCode === "BROC-AUDIT7" &&
        !auditSelfClaimRes.ok &&
        prodImgRouteTs.includes('"public/swaps/fruitbar.png"') &&
        seoSwapsPageTsx.includes('{ id: "sams", label: "Sam\'s Club" }') &&
        seoSwapsPageTsx.includes('{ id: "aldi", label: "ALDI" }') &&
        seoSwapsPageTsx.includes('{ id: "bjs", label: "BJ\'s" }')
    )
  );

  // Regression suite for Ground Beef 90/100 + Grass-Fed Ground Beef swap, Walmart Cart 5-item coverage, real OFF images, and UI polish
  const groundBeefScan = await runScan({
    productTitle: "80% Lean / 20% Fat Ground Beef, 1 lb",
    store: "walmart",
  });
  const groundBeefAlt = resolveCleanAlternative(
    "80% Lean / 20% Fat Ground Beef, 1 lb",
    "Deli Meat",
    "walmart",
  );
  const glazedDonutsScan = await runScan({
    productTitle: "Freshness Guaranteed Glazed Donuts, 12 oz, 6 C...",
    store: "walmart",
  });
  const regBismarkScan = await runScan({
    productTitle: "Freshness Guaranteed Regular Raspberry Bisma...",
    store: "walmart",
  });
  const filledBismarkScan = await runScan({
    productTitle: "Freshness Guaranteed Raspberry Filled Bismark'...",
    store: "walmart",
  });
  const smithfieldHamScan = await runScan({
    productTitle: "Smithfield, Boneless Cooked Hickory Smoked ...",
    store: "walmart",
  });
  const toasterPastryScan = await runScan({
    productTitle: "My Cookie Dealer Protein Toaster Pastry, Powdered...",
    store: "walmart",
  });
  const readerKtSrc = fs.readFileSync(
    "android-app/app/src/main/java/com/cleancart/overlay/GroceryScreenReaderService.kt",
    "utf8",
  );
  const overlayKtSrc = fs.readFileSync(
    "android-app/app/src/main/java/com/cleancart/overlay/OverlayWindowService.kt",
    "utf8",
  );
  const historyStoreKtSrc = fs.readFileSync(
    "android-app/app/src/main/java/com/cleancart/overlay/ScanHistoryStore.kt",
    "utf8",
  );
  check(
    "Walmart 2-col grid, Cart sync/removal, Ground Beef 90/100 + Grass-Fed Ground Beef swap, real OFF product/produce photos, and Home/Top Picks UI cleanup",
    Boolean(
      groundBeefScan.ok &&
        groundBeefScan.result.score === 90 &&
        groundBeefScan.result.rating === "Excellent" &&
        groundBeefAlt.brand === "Marketside Butcher" &&
        groundBeefAlt.name.includes("Organic Grass-Fed 93% Lean 7% Fat Ground Beef") &&
        glazedDonutsScan.ok &&
        glazedDonutsScan.result.score < 50 &&
        regBismarkScan.ok &&
        regBismarkScan.result.score < 50 &&
        filledBismarkScan.ok &&
        filledBismarkScan.result.score < 50 &&
        smithfieldHamScan.ok &&
        smithfieldHamScan.result.score < 50 &&
        toasterPastryScan.ok &&
        toasterPastryScan.result.score < 50 &&
        !prodImgRouteTs.includes("PROCESSED_FOOD_IMAGE_QUERY") &&
        prodImgRouteTs.includes("local:public/swaps/ranch.jpg") &&
        (historyStoreKtSrc.includes("&v=6") || historyStoreKtSrc.includes("&v=4")) &&
        !mainActivityKtSrc.includes('"● Live"') &&
        mainActivityKtSrc.includes("includeWatchlist: Boolean = false") &&
        (readerKtSrc.includes("val shouldReplace = (isFirstCartFrame || allCartRowsVisible) && cartTitles.isNotEmpty()") ||
          readerKtSrc.includes("val shouldReplace = isFirstCartFrame && cartTitles.isNotEmpty()")) &&
        readerKtSrc.includes("rowBand") &&
        !readerKtSrc.includes("SUPPORTED_PACKAGES") &&
        overlayKtSrc.includes("if (replaceCart) {")
    )
  );

  const watchlistFunnelSrc = fs.readFileSync("components/WatchlistMiniFunnel.tsx", "utf8");
  const scanApiKtSrc = fs.readFileSync("android-app/app/src/main/java/com/cleancart/overlay/ScanApi.kt", "utf8");
  const simulatorOnboardingSrc = fs.readFileSync("components/Simulator.tsx", "utf8");
  check(
    "7-Step Non-Repeating Multi-Select Onboarding Funnel (Multi-Select Household/Goals/Stores/Allergy + Healthy Family Hero + 3 Starter Swaps) on Web & Android",
    Boolean(
      !watchlistFunnelSrc.includes("Skip →") &&
        !mainActivityKtSrc.includes("Skip →") &&
        !watchlistFunnelSrc.includes("What is your #1 clean-eating priority?") &&
        !mainActivityKtSrc.includes("What is your #1 clean-eating priority?") &&
        !watchlistFunnelSrc.includes("Swaps/Wk") &&
        !mainActivityKtSrc.includes("Swaps/Wk") &&
        watchlistFunnelSrc.includes("✕ Close") &&
        mainActivityKtSrc.includes("✕ Close") &&
        watchlistFunnelSrc.includes("Who are you protecting with HeyBroc?") &&
        watchlistFunnelSrc.includes("toggleHousehold") &&
        watchlistFunnelSrc.includes("What are your clean-eating goals?") &&
        watchlistFunnelSrc.includes("Where do you usually grocery shop?") &&
        watchlistFunnelSrc.includes("All 12+ grocery &amp; delivery stores + 1.5M+ barcodes stay unlocked") &&
        watchlistFunnelSrc.includes("toggleStore") &&
        watchlistFunnelSrc.includes("formatStoresSummary") &&
        watchlistFunnelSrc.includes("Any family allergies or dietary watches?") &&
        watchlistFunnelSrc.includes("/onboarding-healthy-family.jpg") &&
        fs.existsSync("public/onboarding-healthy-family.jpg") &&
        fs.existsSync("android-app/app/src/main/res/drawable-nodpi/onboarding_healthy_family.jpg") &&
        watchlistFunnelSrc.includes("See How HeyBroc Solves This") &&
        watchlistFunnelSrc.includes("How HeyBroc Protects Your Cart in 1 Second") &&
        watchlistFunnelSrc.includes("Choose How You Want to Start") &&
        watchlistFunnelSrc.includes("Step {step} of 7") &&
        watchlistFunnelSrc.includes("onApplyAndStartTrial") &&
        watchlistFunnelSrc.includes("appliedCreator") &&
        watchlistFunnelSrc.includes("aria-pressed={active}") &&
        watchlistFunnelSrc.includes('role="progressbar"') &&
        watchlistFunnelSrc.includes("isReturningUser") &&
        watchlistFunnelSrc.includes("Continue with Free Plan ({PRICING.freeWeeklySwaps} Free Swaps Included) →") &&
        simulatorOnboardingSrc.includes("heybroc_preferred_stores") &&
        simulatorOnboardingSrc.includes("orderedStores") &&
        simulatorOnboardingSrc.includes("manualFunnelOpen") &&
        mainActivityKtSrc.includes("fun showOnboardingFunnelDialog()") &&
        mainActivityKtSrc.includes("selectedHouseholds") &&
        mainActivityKtSrc.includes("STEP 1 OF 7 · HOUSEHOLD") &&
        mainActivityKtSrc.includes("STEP 2 OF 7 · YOUR GOALS") &&
        mainActivityKtSrc.includes("STEP 3 OF 7 · YOUR STORES") &&
        mainActivityKtSrc.includes("STEP 4 OF 7 · ALLERGY GUARD") &&
        mainActivityKtSrc.includes("STEP 7 OF 7 · YOUR PLAN") &&
        mainActivityKtSrc.includes("R.drawable.onboarding_healthy_family") &&
        mainActivityKtSrc.includes("preferredStoresCsv") &&
        mainActivityKtSrc.includes("All 12+ grocery & delivery stores + 1.5M+ barcodes stay unlocked") &&
        mainActivityKtSrc.includes("onboarding_funnel_done_v1") &&
        mainActivityKtSrc.includes("KEYCODE_BACK") &&
        mainActivityKtSrc.includes("OnBackInvokedDispatcher") &&
        mainActivityKtSrc.includes('"nitrates" to "Nitrites & Curing Nitrates (2x)"') &&
        mainActivityKtSrc.includes('Start $effectiveTrialDays-Day Free Pro Trial ($0 Today)') &&
        mainActivityKtSrc.includes('Continue with Free Plan ($freeStarterSwaps Free Swaps Included) →') &&
        mainActivityKtSrc.includes('if (!alreadyDone) {') &&
        scanApiKtSrc.includes("val is2x = cat.isNotEmpty() && cat in familySet")
    )
  );

  const { evaluateDietaryAlerts: evalDietaryShared } = await import("../lib/dietary");
  const allEightDietary = [
    "sugar_diabetes",
    "dairy",
    "wheat_gluten",
    "peanuts_nuts",
    "soy",
    "egg",
    "shellfish_fish",
    "high_sodium",
  ];
  const multiAlerts = evalDietaryShared(
    allEightDietary,
    "Creamy Shrimp Ramen & Peanut Sauce Bowl",
    "Enriched Wheat Flour, Cultured Milk, Cane Sugar, High Fructose Corn Syrup, Peanuts, Soybean Oil, Whole Egg, Shrimp, Monosodium Glutamate.",
    { sugarsG100g: 14, sodiumMg100g: 620 }
  );
  const falsePositiveChecks = evalDietaryShared(
    allEightDietary,
    "Zero Sugar Dairy-Free Gluten-Free Vegan Mayo & Peanut Butter Pack",
    "Organic Peanuts, Avocado Oil, Chickpea Aquafaba, Sea Salt, Egg-Free Vegan Mayonnaise, Soy-Free Seasoning.",
    { sugarsG100g: 1, sodiumMg100g: 120 }
  );
  check(
    "Shared lib/dietary.ts Allergy & Sugar Guard (all 8 guards + false-positive immunity + Web Floating Pill & Inspect Drawer parity)",
    Boolean(
      multiAlerts.length === 8 &&
        multiAlerts.some((a) => a.id === "sugar_diabetes" && a.shortBadge === "SUGAR") &&
        multiAlerts.some((a) => a.id === "dairy" && a.shortBadge === "DAIRY") &&
        multiAlerts.some((a) => a.id === "wheat_gluten" && a.shortBadge === "WHEAT") &&
        multiAlerts.some((a) => a.id === "peanuts_nuts" && a.shortBadge === "NUTS") &&
        multiAlerts.some((a) => a.id === "soy" && a.shortBadge === "SOY") &&
        multiAlerts.some((a) => a.id === "egg" && a.shortBadge === "EGG") &&
        multiAlerts.some((a) => a.id === "shellfish_fish" && a.shortBadge === "FISH") &&
        multiAlerts.some((a) => a.id === "high_sodium" && a.shortBadge === "SODIUM") &&
        falsePositiveChecks.length === 1 &&
        falsePositiveChecks[0]?.id === "peanuts_nuts"
    )
  );

  const { otoAnnualSavingsPct } = await import("../lib/pricing");
  const testLandingPageTsx = fs.readFileSync("app/test/page.tsx", "utf8");
  const otoModalTsx = fs.readFileSync("components/PostCheckoutOtoModal.tsx", "utf8");
  const latestSimulatorTsx = fs.readFileSync("components/Simulator.tsx", "utf8");
  const latestPaywallTsx = fs.readFileSync("components/Paywall.tsx", "utf8");
  const latestCheckoutRouteTs = fs.readFileSync("app/api/checkout/route.ts", "utf8");
  const latestAnalyticsTs = fs.readFileSync("lib/analytics.ts", "utf8");

  check(
    "Ryan Mathews Meta Ads Funnel & 3 CRO Tests: Low-Friction /test Landing Mode, Post-Checkout OTO Modal ($39.99/yr & $29 Pass), Paywall Value Prop + Skeptic FAQ, and CAPI Free Score Test Signal",
    Boolean(
      PRICING.otoAnnualLockIn === 39.99 &&
        PRICING.otoExtraYearPass === 29.0 &&
        otoAnnualSavingsPct === 67 &&
        testLandingPageTsx.includes("initialAdTestMode={true}") &&
        latestSimulatorTsx.includes('id="ad-free-test-hero"') &&
        latestSimulatorTsx.includes('id="ad-test-step2-cta"') &&
        latestSimulatorTsx.includes("<PostCheckoutOtoModal") &&
        latestSimulatorTsx.includes('id="pill-dietary-alert"') &&
        latestSimulatorTsx.includes('id="inspect-dietary-alert-card"') &&
        otoModalTsx.includes('id="oto-claim-btn"') &&
        otoModalTsx.includes('id="oto-decline-btn"') &&
        latestCheckoutRouteTs.includes("oto_annual") &&
        latestCheckoutRouteTs.includes("oto_gift_year") &&
        latestPaywallTsx.includes('id="paywall-how-it-works-strip"') &&
        latestPaywallTsx.includes('id="paywall-skeptic-faq"') &&
        latestAnalyticsTs.includes("Free Product Score Test")
    )
  );

  const {
    saveEntitlement,
    updateSubscriptionEntitlement,
    applyOneTimeAnnualPass,
    revokeOneTimeAnnualPass,
    getDevicePaidEntitlement,
    getCustomerEntitlement,
    getEmailEntitlement,
    hasPriorEntitlementHistory,
  } = await import("../lib/entitlements");
  const {
    createCreatorAccessToken,
    verifyCreatorAccessToken,
    executeCreatorPayout,
    listCreatorPayouts,
    deleteCreator,
    getCreator: getCreatorDirect,
  } = await import("../lib/influencers");
  const { resolveSwapCandidates } = await import("../lib/swaps");
  const { POST: postAuditRoute } = await import("../app/api/audit/route");

  // 1. One-time pass stacking, idempotency, Billing Portal preservation, and safe revocation
  const passDeviceId = `audit-pass-dev-${Date.now()}`;
  const passCustomerId = `cus_audit_pass_${Date.now()}`;
  const passEmail = `audit-pass-${Date.now()}@heybroc.test`;
  const passBaseExpiry = Date.now() + 365 * 86_400_000;
  await saveEntitlement({
    sessionId: `cs_base_${Date.now()}`,
    subscriptionId: `sub_base_${Date.now()}`,
    customerId: passCustomerId,
    customerEmail: passEmail,
    deviceId: passDeviceId,
    plan: "annual",
    status: "active",
    active: true,
    expiresAtMs: passBaseExpiry,
    updatedAt: new Date().toISOString(),
  });
  const stackedOnce = await applyOneTimeAnnualPass({
    sessionId: `cs_oto_pass_${Date.now()}`,
    customerId: passCustomerId,
    customerEmail: passEmail,
    deviceId: passDeviceId,
  });
  const stackedDuplicate = await applyOneTimeAnnualPass({
    sessionId: stackedOnce.sessionId,
    customerId: passCustomerId,
    customerEmail: passEmail,
    deviceId: passDeviceId,
  });
  await revokeOneTimeAnnualPass({
    sessionId: stackedOnce.sessionId,
    customerId: passCustomerId,
    deviceId: passDeviceId,
    customerEmail: passEmail,
  });
  const afterPassRevoke = await getDevicePaidEntitlement(passDeviceId);

  // 2. Multi-subscription isolation: canceling old monthly sub must not overwrite active new OTO annual sub
  const upgradeDeviceId = `audit-upg-dev-${Date.now()}`;
  const upgradeCustomerId = `cus_audit_upg_${Date.now()}`;
  const upgradeEmail = `audit-upg-${Date.now()}@heybroc.test`;
  const oldMonthlySubId = `sub_monthly_old_${Date.now()}`;
  const newAnnualSubId = `sub_annual_new_${Date.now()}`;
  await saveEntitlement({
    sessionId: `cs_monthly_${Date.now()}`,
    subscriptionId: oldMonthlySubId,
    customerId: upgradeCustomerId,
    customerEmail: upgradeEmail,
    deviceId: upgradeDeviceId,
    plan: "monthly",
    status: "trialing",
    active: true,
    expiresAtMs: Date.now() + 7 * 86_400_000,
    updatedAt: new Date().toISOString(),
  });
  await saveEntitlement({
    sessionId: `cs_oto_annual_${Date.now()}`,
    subscriptionId: newAnnualSubId,
    customerId: upgradeCustomerId,
    customerEmail: upgradeEmail,
    deviceId: upgradeDeviceId,
    plan: "annual",
    status: "active",
    active: true,
    expiresAtMs: Date.now() + 365 * 86_400_000,
    updatedAt: new Date().toISOString(),
  });
  await updateSubscriptionEntitlement(oldMonthlySubId, {
    status: "canceled",
    lastStripeEventCreated: Math.floor(Date.now() / 1000) + 10,
  });
  const devAfterOldCancel = await getDevicePaidEntitlement(upgradeDeviceId);
  const cusAfterOldCancel = await getCustomerEntitlement(upgradeCustomerId);
  const emailAfterOldCancel = await getEmailEntitlement(upgradeEmail);

  // 3. Discounted OTO creator full-refund clawback ($39.99 annual lock-in)
  const otoCreatorCode = `AUDITOTO${Date.now().toString().slice(-4)}`;
  await createCreator({ code: otoCreatorCode, name: "Audit OTO Creator", commissionPct: 30 });
  await recordStripeCreatorConversionOnce(
    `conv_${otoCreatorCode}`,
    otoCreatorCode,
    "paid_annual",
    39.99
  );
  const creatorAfterOtoRefund = await recordStripeCreatorRefundOnce(
    `ref_${otoCreatorCode}`,
    otoCreatorCode,
    "annual",
    39.99,
    true
  );
  await deleteCreator(otoCreatorCode);

  const globalsCssSrc = fs.readFileSync("app/globals.css", "utf8");
  const opsCliSrc = fs.readFileSync("scripts/ops-cli.ts", "utf8");
  const latestWebhookSrc = fs.readFileSync("app/api/stripe/webhook/route.ts", "utf8");

  check(
    "OTO & Meta Funnel Security/Billing Audit: Pass Stacking + Idempotency, Old-Sub Cancel Isolation, Discounted OTO Creator Clawback, OTO Eligibility Gate, CAPI Purchase ROAS, and Mobile /test Layout",
    Boolean(
      stackedOnce.subscriptionId?.startsWith("sub_base_") &&
        stackedOnce.paidPassExpiresAtMs &&
        stackedOnce.paidPassExpiresAtMs > Date.now() + 720 * 86_400_000 &&
        stackedDuplicate.paidPassExpiresAtMs === stackedOnce.paidPassExpiresAtMs &&
        afterPassRevoke?.active === true &&
        afterPassRevoke?.subscriptionId?.startsWith("sub_base_") &&
        !afterPassRevoke?.paidPassExpiresAtMs &&
        devAfterOldCancel?.active === true &&
        devAfterOldCancel?.subscriptionId === newAnnualSubId &&
        cusAfterOldCancel?.active === true &&
        cusAfterOldCancel?.subscriptionId === newAnnualSubId &&
        emailAfterOldCancel?.active === true &&
        emailAfterOldCancel?.subscriptionId === newAnnualSubId &&
        creatorAfterOtoRefund?.paidAnnual === 0 &&
        creatorAfterOtoRefund?.grossRevenue === 0 &&
        creatorAfterOtoRefund?.commissionOwed === 0 &&
        latestCheckoutRouteTs.includes("if (!priorEntitlement?.active && !isPreviewAllowed)") &&
        latestWebhookSrc.includes("previous_subscription_id") &&
        latestWebhookSrc.includes("sendMetaCapiPurchaseEvent") &&
        latestAnalyticsTs.includes('? "Purchase"') &&
        globalsCssSrc.includes(".layout--ad-test .stage") &&
        !opsCliSrc.includes("process.env.META_ADS_ACCESS_TOKEN || process.env.META_CAPI_TOKEN")
    )
  );

  // ==================== 12-AREA COMPLETE AUDIT REGRESSION SUITE ====================
  // 1. Affiliate Program, Creator Tokens, Self-Dealing Block & Payout Ledger
  await createCreator({
    code: "AUDITPAY26",
    name: "Audit Payout Creator",
    commissionPct: 35,
    payoutEmail: "creator-self@heybroc.test",
    payoutMethod: "paypal",
    payoutHandle: "@auditpay26",
  });
  const validTok = createCreatorAccessToken("AUDITPAY26");
  check(
    "1. Creator HMAC access token validates owner and rejects tampered/other codes",
    verifyCreatorAccessToken("AUDITPAY26", validTok) &&
      !verifyCreatorAccessToken("OTHERCODE", validTok) &&
      !verifyCreatorAccessToken("AUDITPAY26", "bad-token")
  );
  const selfDealRes = await recordStripeCreatorConversionOnce(
    "inv_selfdeal_audit_1",
    "AUDITPAY26",
    "paid_annual",
    49.99,
    "CREATOR-SELF@heybroc.test"
  );
  const afterSelfDeal = await getCreatorDirect("AUDITPAY26");
  check(
    "1b. Affiliate self-dealing conversion is blocked automatically",
    selfDealRes?.paidAnnual === 0 &&
      (selfDealRes?.commissionEarned ?? 0) === 0 &&
      (afterSelfDeal?.commissionOwed ?? 0) === 0
  );
  const legitConv = await recordStripeCreatorConversionOnce(
    "inv_legit_audit_1",
    "AUDITPAY26",
    "paid_annual",
    49.99,
    "shopper@heybroc.test"
  );
  const expectedComm = Number((49.99 * 0.35).toFixed(2));
  const payoutRes = await executeCreatorPayout({
    code: "AUDITPAY26",
    amount: 10,
    method: "paypal",
    note: "Partial test payout",
  });
  const payoutsList = await listCreatorPayouts("AUDITPAY26");
  await deleteCreator("AUDITPAY26");
  check(
    "1c. Creator commissionEarned, partial payout deduction, commissionOwed & payout history ledger are exact",
    Boolean(
      legitConv &&
        legitConv.commissionEarned === expectedComm &&
        payoutRes.payout.amount === 10 &&
        payoutRes.creator.commissionPaid === 10 &&
        payoutRes.creator.commissionOwed === Number((expectedComm - 10).toFixed(2)) &&
        payoutsList.some((p) => p.id === payoutRes.payout.id)
    )
  );

  // 2. Trial Period Accuracy & Repeat-Trial Prevention
  await saveEntitlement({
    sessionId: "cs_prior_trial_audit",
    deviceId: "dev_prior_trial_audit",
    customerEmail: "prior-trial@heybroc.test",
    customerId: "cus_prior_audit",
    subscriptionId: "sub_prior_audit",
    plan: "annual",
    status: "canceled",
    active: false,
    expiresAtMs: Date.now() - 60_000,
    updatedAt: new Date().toISOString(),
  });
  const priorByDev = await hasPriorEntitlementHistory({ deviceId: "dev_prior_trial_audit" });
  const priorByEmail = await hasPriorEntitlementHistory({ email: "PRIOR-TRIAL@heybroc.test" });
  const freshUser = await hasPriorEntitlementHistory({ deviceId: "dev_brand_new_audit_999", email: "brandnew999@heybroc.test" });
  const stripeWebhookSrc = fs.readFileSync("app/api/stripe/webhook/route.ts", "utf8");
  check(
    "2. Trial periods (universal 7d annual, 0d monthly/OTO), repeat-trial guard, OTO pass stacking & Dispute webhook handling",
    PRICING.trialDays === 7 &&
      PRICING.creatorTrialDays === 7 &&
      Boolean(priorByDev) &&
      Boolean(priorByEmail) &&
      freshUser === null &&
      stripeWebhookSrc.includes("oto_pass_") &&
      stripeWebhookSrc.includes("total_excluding_tax") &&
      stripeWebhookSrc.includes("replaces_subscription_id")
  );

  // 3. Up-to-Date 2026 Bad Chemicals, Seed Oil Modifier Lists & Zero False Positives on Clean Foods
  const multiOilMod = scoreIngredients("Potatoes, High Oleic Canola, High Oleic Sunflower, or Safflower Oil, Sea Salt.");
  const fullyHydrog = scoreIngredients("Roasted Peanuts, Sugar, Fully Hydrogenated Vegetable Oils (Cottonseed, Soybean, Rapeseed), Salt.");
  const partHydrog = scoreIngredients("Enriched Flour, Partially Hydrogenated Soybean Oil, Salt.");
  const datemBread = scoreIngredients("Wheat Flour, Water, DATEM, Sodium Stearoyl Lactylate, Salt, Yeast.");
  const modernChems = scoreIngredients(
    "Carbonated Water, Citric Acid, Sodium Benzoate, Ascorbic Acid, Sucrose Acetate Isobutyrate, Ester Gum, Neotame, Advantame, Disodium Dihydrogen Pyrophosphate, Brominated Soybean Oil, Sulfur Dioxide."
  );
  const cleanYeast = scoreIngredients("Organic Whole Wheat Flour, Water, Nutritional Yeast, Baker's Yeast, Sea Salt.");
  check(
    "3. 2026 chemical coverage (SAIB, Ester Gum, Neotame, Advantame, Sulfites, Pyrophosphate, Brominated Soybean Oil, Benzoate+VitC, SSL, 3+ oil modifiers, Fully vs Partially Hydrogenated, clean yeast 0 flags)",
    multiOilMod.flagged.some((f) => f.id === "canolaoil") &&
      multiOilMod.flagged.some((f) => f.id === "sunfloweroil") &&
      multiOilMod.flagged.some((f) => f.id === "saffloweroil") &&
      !fullyHydrog.flagged.some((f) => f.id === "hydrogoil") &&
      !fullyHydrog.flagged.some((f) => f.id === "phoil") &&
      fullyHydrog.flagged.some((f) => f.id === "fully_hydrog_oil") &&
      partHydrog.flagged.some((f) => f.id === "phoil") &&
      datemBread.flagged.some((f) => f.id === "datem") &&
      datemBread.flagged.some((f) => f.id === "ssl_csl") &&
      !datemBread.flagged.some((f) => f.id === "monodiglycerides") &&
      modernChems.flagged.some((f) => f.id === "saib") &&
      modernChems.flagged.some((f) => f.id === "ester_gum") &&
      modernChems.flagged.some((f) => f.id === "neotame") &&
      modernChems.flagged.some((f) => f.id === "advantame") &&
      modernChems.flagged.some((f) => f.id === "naphosphate") &&
      modernChems.flagged.some((f) => f.id === "bvo") &&
      modernChems.flagged.some((f) => f.id === "sulfites") &&
      modernChems.flagged.some((f) => f.id === "nabenzoate" && f.name.includes("Benzene Precursor")) &&
      cleanYeast.flagged.length === 0 &&
      cleanYeast.score === 100
  );

  // 4. Plant Milk / Ultra-Filtered Milk Variant Guard & Score Consistency
  const fairlife2Scan = await runScan({ productTitle: "Fairlife 2% Reduced Fat Ultra-Filtered Milk", store: "walmart" });
  const malkOatScan = await runScan({ productTitle: "MALK Organic Unsweetened Oat Milk", store: "target" });
  const pipelineScan = await runScan({ productTitle: "Monster Pipeline Punch Energy Drink", store: "walmart" });
  const pepsiZeroScan = await runScan({ productTitle: "Pepsi Zero Sugar Cola", store: "walmart" });
  check(
    "4. Fairlife Ultra-Filtered, MALK Unsweetened Oat Milk (100/100 Nutri-Score A), Monster Pipeline Punch & Pepsi Zero Sugar match accurately",
    Boolean(
      fairlife2Scan.ok &&
        fairlife2Scan.product.title.toLowerCase().includes("fairlife") &&
        malkOatScan.ok &&
        malkOatScan.result.score >= 90 &&
        malkOatScan.result.yukaBreakdown?.nutriScoreGrade === "A" &&
        pipelineScan.ok &&
        pipelineScan.product.title.includes("Pipeline Punch") &&
        pepsiZeroScan.ok &&
        pepsiZeroScan.product.title.includes("Zero")
    )
  );

  // 5. Zero Placeholder Pictures & Zero Revoked Barcodes
  const revokedBarcodes = [
    "0681131395502",
    "0044500201956",
    "0085239053218",
    "0038000316104",
    "4901002075484",
    "0052000122022",
    "0011110005526",
    "0299616301971",
    "0771856465793",
  ];
  const swapsSrcAll = fs.readFileSync("lib/swaps.ts", "utf8");
  const lookupSrcAll = fs.readFileSync("lib/lookup.ts", "utf8");
  const noRevokedInCatalogs = revokedBarcodes.every(
    (bc) => !swapsSrcAll.includes(bc) && !lookupSrcAll.includes(bc)
  );
  const allLocalImgDirs = ["public/products", "public/swaps", "public/presets"];
  const allLocalImgsValid = allLocalImgDirs.every((dir) =>
    fs.readdirSync(dir).every((fn) => {
      const buf = fs.readFileSync(`${dir}/${fn}`);
      const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
      return buf.length > 4000 && (isPng || isJpg);
    })
  );
  check(
    "5. Zero placeholder graphics, valid PNG/JPEG photography across all 59 public assets, real US PRESETS, and 0 revoked OFF barcodes",
    noRevokedInCatalogs &&
      allLocalImgsValid &&
      PRESETS.every((p) => Boolean(p.brand && p.sourceUrl && !/Berry Swirl|Cheddar Bites|Deli Select|Ranch House|Green Pasture/i.test(p.title)))
  );

  // 6. Multi-Food Screen Disambiguation + Ranked Swap Candidates + Instacart Retailer Preservation + Weighted Audit API
  const multiProductRawScan = await runScan({
    productTitle: "Stonyfield Organic Whole Milk Plain Yogurt",
    rawText:
      "Stonyfield Organic Whole Milk Plain Yogurt\nIngredients: Cultured pasteurized organic whole milk, pectin, vitamin D3.\nCustomers also bought\nRainbow Fruit Snacks\nIngredients: Corn Syrup, Sugar, Red 40, Blue 1, Yellow 5.",
    store: "walmart",
  });
  const instacartCostcoCandidates = resolveSwapCandidates({
    score: 25,
    productTitle: "Hidden Valley Original Ranch Dressing",
    store: "instacart",
    instacartRetailerSlug: "costco",
    limit: 4,
  });
  const nonFoodOnlyAuditRes = await (
    await postAuditRoute(
      new Request("https://heybroc.com/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.88" },
        body: JSON.stringify({
          store: "walmart",
          items: [{ productTitle: "Bounty Select-A-Size Paper Towels, 6 Double Rolls" }],
        }),
      })
    )
  ).json();
  const weightedZeroAuditRes = await (
    await postAuditRoute(
      new Request("https://heybroc.com/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.88" },
        body: JSON.stringify({
          store: "walmart",
          items: [
            { productTitle: "Rainbow Dye Candy", ingredients: "Sugar, Corn Syrup, Red 40, Yellow 5, Blue 1, TBHQ, BHT.", quantity: 3 },
            { productTitle: "Organic Baby Spinach", ingredients: "Organic baby spinach.", quantity: 1 },
          ],
        }),
      })
    )
  ).json();
  const extContentSrc = fs.readFileSync("chrome-extension/content.js", "utf8");
  const safariContentSrc = fs.readFileSync("ios-app/SafariExtension/Resources/content.js", "utf8");
  const mergedSimSrc = fs.readFileSync("components/Simulator.tsx", "utf8");
  check(
    "6. Multi-food OCR focal block isolation, Instacart retailer swap candidates, zero-safe weighted Cart Avg (null when 0 food items), in-stock swap guard, per-store carts & Chrome/Safari byte parity",
    Boolean(
      multiProductRawScan.ok &&
        multiProductRawScan.result.flagged.length === 0 &&
        multiProductRawScan.result.score >= 90 &&
        instacartCostcoCandidates.length >= 1 &&
        decodeURIComponent(instacartCostcoCandidates[0].webUrl || "").includes("/store/costco/s?k=") &&
        nonFoodOnlyAuditRes.ok &&
        nonFoodOnlyAuditRes.averageBefore === null &&
        weightedZeroAuditRes.ok &&
        typeof weightedZeroAuditRes.averageBefore === "number" &&
        weightedZeroAuditRes.averageBefore < 30 &&
        extContentSrc === safariContentSrc &&
        extContentSrc.includes("resolveFirstInStockSwap") &&
        extContentSrc.includes("resolveStoreBucket") &&
        mergedSimSrc.includes("cartsByStore")
    )
  );

  try {
    fs.rmSync(".cache/heybroc-kv.json", { force: true });
  } catch {
    /* ignore */
  }

  // Full end-to-end audit regressions: whole-food beef patties & NY strip, distilled/purified water, olive oil, egg noodles vs eggs, plant burger vs beef, and 43 unique swap studio images
  const cryptoMod = await import("node:crypto");
  const swapAssetFiles = fs
    .readdirSync("public/swaps")
    .filter((f: string) => /\.(?:png|jpe?g)$/i.test(f));
  const swapAssetHashes = new Set(
    swapAssetFiles.map((f: string) =>
      cryptoMod.createHash("sha256").update(fs.readFileSync(`public/swaps/${f}`)).digest("hex")
    )
  );
  const beefPattyScan = await runScan({
    productTitle: "Private Selection Angus Beef Patties, 4 ct",
    store: "kroger",
  });
  const nyStripScan = await runScan({
    productTitle: "USDA Choice Boneless New York Strip Steak, 1 lb",
    store: "walmart",
  });
  const distilledWaterScan = await runScan({
    productTitle: "Great Value Distilled Water, 1 Gallon",
    store: "walmart",
  });
  const membersMarkWaterScan = await runScan({
    productTitle: "Member's Mark Purified Water, 40 pk",
    store: "sams",
  });
  const oliveOilScan = await runScan({
    productTitle: "Extra Virgin Olive Oil, 17 fl oz",
    store: "walmart",
  });
  const fgDonutBrandScan = await runScan({
    productTitle: "Freshness Guaranteed Glazed Donuts, 12 Count",
    store: "walmart",
  });
  const eggNoodlesAlt = resolveCleanAlternative(
    "Great Value Wide Egg Noodles, 16 oz",
    undefined,
    "walmart",
  );
  const beyondBurgerAlt = resolveCleanAlternative(
    "Beyond Burger Plant-Based Patties, 8 oz",
    "Snacks",
    "walmart",
  );
  check(
    "Full Post-Commit Audit: zero duplicate swap photos (43/43 unique), Angus patties & NY strip 90/100, Distilled water 100/100, Purified water & Olive Oil 90/100, Egg Noodles -> Pasta, Beyond Burger -> Dr. Praeger's, no placeholder tiles, and safe Android swap browser routing",
    Boolean(
      swapAssetFiles.length === 43 &&
        swapAssetHashes.size === 43 &&
        beefPattyScan.ok &&
        beefPattyScan.result.score === 90 &&
        nyStripScan.ok &&
        nyStripScan.result.score === 90 &&
        distilledWaterScan.ok &&
        distilledWaterScan.result.score === 100 &&
        membersMarkWaterScan.ok &&
        membersMarkWaterScan.result.score === 90 &&
        !String(membersMarkWaterScan.product?.brand || "").toLowerCase().includes("glacéau") &&
        oliveOilScan.ok &&
        oliveOilScan.result.score === 90 &&
        fgDonutBrandScan.ok &&
        fgDonutBrandScan.product?.brand === "Freshness Guaranteed" &&
        eggNoodlesAlt.brand === "Barilla" &&
        eggNoodlesAlt.name.includes("Organic Spaghetti Pasta") &&
        beyondBurgerAlt.brand === "Dr. Praeger's" &&
        !latestSimulatorTsx.includes("product-art--tile") &&
        mainActivityKtSrc.includes("resolveExternalBrowserPackage") &&
        overlayKtSrc.includes("resolveExternalBrowserPackage") &&
        readerKtSrc.includes("activeCartSectionNodes")
    )
  );
  // 5-Feature Upgrade Suite Regressions: Share Sheet, Label OCR, Weekly Order Auditor, Product Exposé Card & Store-Brand Swaps
  const swapsMod = await import("../lib/swaps");
  const labelOcrMod = await import("../lib/label-ocr");
  const orderParserMod = await import("../lib/order-parser");
  const auditRouteMod = await import("../app/api/audit/route");

  const nowMs = Date.now();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  const walmartSbValid = swapsMod.WALMART_STORE_BRAND_ALTERNATIVES.every((entry) => {
    const a = entry.alt;
    const ingScore = scoreIngredients(a.ingredients).score;
    const verifiedMs = a.verifiedAt ? Date.parse(a.verifiedAt) : NaN;
    return (
      !a.brand.includes("/") &&
      !a.name.includes("/") &&
      swapsMod.isStoreBrandForStore(a.brand, "walmart") &&
      ingScore >= 90 &&
      typeof a.sourceUrl === "string" &&
      a.sourceUrl.startsWith("https://") &&
      Number.isFinite(verifiedMs) &&
      nowMs - verifiedMs <= ninetyDaysMs
    );
  });
  check(
    "Option 5: WALMART_STORE_BRAND_ALTERNATIVES all have single-brand titles, score >= 90, sourceUrl, and 90-day verifiedAt",
    swapsMod.WALMART_STORE_BRAND_ALTERNATIVES.length >= 8 && walmartSbValid
  );

  const defaultChipsSwap = resolveSwap({
    score: 22,
    productTitle: "Lay's Classic Potato Chips, 8 oz",
    store: "walmart",
    preferStoreBrand: false,
  });
  const sbChipsSwap = resolveSwap({
    score: 22,
    productTitle: "Lay's Classic Potato Chips, 8 oz",
    store: "walmart",
    preferStoreBrand: true,
  });
  const sbPeanutButterSwap = resolveSwap({
    score: 28,
    productTitle: "Jif Creamy Peanut Butter, 16 oz",
    store: "walmart",
    preferStoreBrand: true,
  });
  const chipsScanDefault = await runScan({
    productTitle: "Lay's Classic Potato Chips, 8 oz",
    rawIngredients: "Potatoes, Vegetable Oil (Sunflower, Corn, and/or Canola Oil), and Salt.",
    store: "walmart",
    preferStoreBrand: false,
  });
  const chipsScanStoreBrand = await runScan({
    productTitle: "Lay's Classic Potato Chips, 8 oz",
    rawIngredients: "Potatoes, Vegetable Oil (Sunflower, Corn, and/or Canola Oil), and Salt.",
    store: "walmart",
    preferStoreBrand: true,
  });
  const jifScanDefault = await runScan({
    productTitle: "Jif Creamy Peanut Butter, 16 oz",
    store: "walmart",
    preferStoreBrand: false,
  });
  check(
    "Option 5: preferStoreBrand=false keeps national brand default while populating storeBrandSwap, and preferStoreBrand=true promotes bettergoods & Great Value Store-Brand swaps",
    Boolean(
      defaultChipsSwap &&
        !defaultChipsSwap.isStoreBrand &&
        sbChipsSwap &&
        sbChipsSwap.isStoreBrand === true &&
        sbChipsSwap.title.includes("bettergoods") &&
        sbPeanutButterSwap &&
        sbPeanutButterSwap.isStoreBrand === true &&
        sbPeanutButterSwap.title.includes("Great Value") &&
        chipsScanDefault.ok &&
        chipsScanDefault.swapCandidates?.[0]?.isStoreBrand === false &&
        chipsScanDefault.storeBrandSwap?.isStoreBrand === true &&
        chipsScanStoreBrand.ok &&
        chipsScanStoreBrand.swap?.isStoreBrand === true &&
        jifScanDefault.ok &&
        jifScanDefault.storeBrandSwap?.title.includes("Great Value")
    )
  );

  const parsedLabelSample = labelOcrMod.parseLabelOcrText(
    "9:41 AM 5G\nWalmart.com\nGreat Value Fruit Spins Cereal, 12 oz\nAdd to cart\nIngredients: Milled Corn, Sugar, Corn Syrup, Canola Oil, Red 4O, Yellow S, Blue 1, BHT Added to Preserve Freshness.\nUPC: 078742123455\nDistributed by Walmart Inc."
  );
  check(
    "Option 2: parseLabelOcrText strips status-bar/button noise, normalizes Red 40 & Yellow 5 OCR typos, and extracts title, ingredients, barcode & store",
    Boolean(
      parsedLabelSample.productTitle.includes("Fruit Spins") &&
        parsedLabelSample.rawIngredients.includes("Red 40") &&
        parsedLabelSample.rawIngredients.includes("Yellow 5") &&
        !parsedLabelSample.rawIngredients.includes("Distributed by") &&
        !parsedLabelSample.rawIngredients.includes("078742123455") &&
        parsedLabelSample.barcode === "078742123455" &&
        parsedLabelSample.detectedStore === "walmart"
    )
  );

  const parsedSampleOrder = orderParserMod.parseGroceryOrderText(orderParserMod.SAMPLE_WEEKLY_FAMILY_ORDER);
  const doritosOrderRow = parsedSampleOrder.items.find((i) => i.productTitle.includes("Doritos"));
  const capriSunOrderRow = parsedSampleOrder.items.find((i) => i.productTitle.includes("Capri Sun"));
  const spaceQtyOrder = orderParserMod.parseGroceryOrderText(
    "Qty 3 Cheez-It Original Baked Snack Crackers $8.94\n2x Doritos Nacho Cheese $7.96\nSubtotal $16.90"
  );
  check(
    "Option 3: parseGroceryOrderText extracts 8 grocery items with quantities, strips prices/receipt headers, supports 'Qty 3 ...', and detects walmart",
    Boolean(
      parsedSampleOrder.detectedStore === "walmart" &&
        parsedSampleOrder.items.length === 8 &&
        doritosOrderRow?.quantity === 2 &&
        capriSunOrderRow?.quantity === 2 &&
        spaceQtyOrder.items.length === 2 &&
        spaceQtyOrder.items[0]?.quantity === 3 &&
        spaceQtyOrder.items.every((i) => !/\$/.test(i.productTitle)) &&
        parsedSampleOrder.items.every((i) => !/\$/.test(i.productTitle))
    )
  );

  const auditReq = new Request("http://localhost:3000/api/audit", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "127.0.0.77" },
    body: JSON.stringify({
      rawOrderText: orderParserMod.SAMPLE_WEEKLY_FAMILY_ORDER,
      preferStoreBrand: true,
    }),
  });
  const auditRes = await auditRouteMod.POST(auditReq);
  const auditData = (await auditRes.json()) as {
    ok: boolean;
    detectedStore?: string;
    itemsScored: number;
    averageBefore: number | null;
    averageAfter: number | null;
    results: Array<{ ok: boolean; swap?: { isStoreBrand?: boolean } | null }>;
  };
  check(
    "Option 3 + Option 5: POST /api/audit grades rawOrderText, improves averageBefore -> averageAfter, and attaches store-brand swaps",
    Boolean(
      auditData.ok === true &&
        auditData.detectedStore === "walmart" &&
        auditData.itemsScored >= 6 &&
        typeof auditData.averageBefore === "number" &&
        typeof auditData.averageAfter === "number" &&
        auditData.averageAfter > auditData.averageBefore &&
        auditData.results.some((r) => r.ok && r.swap?.isStoreBrand === true)
    )
  );

  const manifestJson = JSON.parse(fs.readFileSync("public/manifest.json", "utf8"));
  const iosShareSwift = fs.readFileSync("ios-app/ShareExtension/ShareViewController.swift", "utf8");
  const androidManifestXml = fs.readFileSync("android-app/app/src/main/AndroidManifest.xml", "utf8");
  const updatedMainActivityKt = fs.readFileSync(
    "android-app/app/src/main/java/com/cleancart/overlay/MainActivity.kt",
    "utf8"
  );
  const labelModalSrc = fs.readFileSync("components/LabelScannerModal.tsx", "utf8");
  const auditModalSrc = fs.readFileSync("components/WeeklyOrderAuditModal.tsx", "utf8");
  const exposeModalSrc = fs.readFileSync("components/ProductExposeModal.tsx", "utf8");
  check(
    "Options 1–5 Cross-Platform Parity: PWA share_target, iOS ShareExtension, Android ACTION_SEND/PROCESS_TEXT, LabelScannerModal, WeeklyOrderAuditModal & ProductExposeModal",
    Boolean(
      manifestJson.share_target?.action === "/" &&
        manifestJson.share_target?.params?.text === "text" &&
        iosShareSwift.includes('URLComponents(string: "https://www.heybroc.com/")') &&
        iosShareSwift.includes('URLQueryItem(name: "share"') &&
        androidManifestXml.includes("android.intent.action.SEND") &&
        androidManifestXml.includes("android.intent.action.PROCESS_TEXT") &&
        updatedMainActivityKt.includes("handleIncomingShareIntent") &&
        updatedMainActivityKt.includes("showLabelScannerDialog") &&
        updatedMainActivityKt.includes("showWeeklyOrderAuditDialog") &&
        updatedMainActivityKt.includes("shareProductScoreCard") &&
        updatedMainActivityKt.includes("isPreferStoreBrand") &&
        labelModalSrc.includes("tesseract.js") &&
        auditModalSrc.includes("/api/audit") &&
        exposeModalSrc.includes("1080") &&
        exposeModalSrc.includes("1350")
    )
  );

  const iosViewControllerSrc = fs.readFileSync("ios-app/App/ViewController.swift", "utf8");
  const iosMainHtmlSrc = fs.readFileSync("ios-app/App/Main.html", "utf8");
  const buildIosYmlSrc = fs.readFileSync(".github/workflows/build-ios.yml", "utf8");
  const freshSimTsx = fs.readFileSync("components/Simulator.tsx", "utf8");
  check(
    "iOS TestFlight App Host: custom ViewController.swift replaces dead Safari placeholder with full HeyBroc WKWebView, AVCaptureSession barcode scanner, Safari setup sheet, and auto-incremented build numbers",
    Boolean(
      iosViewControllerSrc.includes("@IBOutlet var webView: WKWebView!") &&
        iosViewControllerSrc.includes("https://www.heybroc.com/?platform=ios") &&
        iosViewControllerSrc.includes("isScrollEnabled = true") &&
        iosViewControllerSrc.includes("NativeBarcodeScannerViewController") &&
        iosViewControllerSrc.includes("AVCaptureSession") &&
        iosViewControllerSrc.includes("SafariSetupSheetViewController") &&
        iosViewControllerSrc.includes("UIApplication.openSettingsURLString") &&
        !iosMainHtmlSrc.includes("You can turn on HeyBroc") &&
        iosMainHtmlSrc.includes("sendNative('open-settings')") &&
        iosMainHtmlSrc.includes("sendNative('reload-app')") &&
        buildIosYmlSrc.includes("ios-app/App/ViewController.swift") &&
        buildIosYmlSrc.includes("ios-app/App/Main.html") &&
        buildIosYmlSrc.includes("GITHUB_RUN_NUMBER") &&
        buildIosYmlSrc.includes("NSCameraUsageDescription") &&
        buildIosYmlSrc.includes("ITSAppUsesNonExemptEncryption") &&
        freshSimTsx.includes("__heybrocNativeBarcode") &&
        freshSimTsx.includes("open-ios-safari-setup")
    )
  );
  const dietaryMod = await import("../lib/dietary");
  const scanMod = await import("../lib/scan");

  const convStrawberryRisk = dietaryMod.detectPesticideRisk("Fresh Strawberries, 1 lb", "Fresh strawberries.");
  const convSpinachRisk = dietaryMod.detectPesticideRisk("Fresh Baby Spinach, 10 oz", "Baby spinach.");
  const convOatsRisk = dietaryMod.detectPesticideRisk("Quaker Old Fashioned Oats, 42 oz", "Whole grain rolled oats.");
  const convFlourRisk = dietaryMod.detectPesticideRisk("Gold Medal Unbleached All-Purpose Flour", "Bleached wheat flour, niacin, iron.");
  const convHummusRisk = dietaryMod.detectPesticideRisk("Classic Hummus, 10 oz", "Cooked chickpeas, tahini, olive oil, garlic, sea salt.");
  const orgStrawberryRisk = dietaryMod.detectPesticideRisk(
    "Driscoll's Organic Fresh Strawberries, 16 oz",
    "Organic strawberries.",
    { isOrganic: true }
  );
  const orgOatsRisk = dietaryMod.detectPesticideRisk(
    "One Degree Organic Foods Sprouted Rolled Oats",
    "Organic sprouted whole grain oats.",
    { isOrganic: true }
  );
  const sparklingWaterNoFalsePositive = dietaryMod.detectPesticideRisk(
    "Spindrift Raspberry Lime Sparkling Water",
    "Carbonated water, raspberry puree, lime juice."
  );
  const pectinNoFalsePositive = dietaryMod.detectPesticideRisk(
    "Stonyfield Organic Whole Milk Berry Yogurt",
    "Cultured pasteurized organic whole milk, apple pectin."
  );
  const alertsWhenOff = dietaryMod.evaluateDietaryAlerts([], "Fresh Strawberries, 1 lb", "Fresh strawberries.");
  const alertsWhenOn = dietaryMod.evaluateDietaryAlerts(["pesticide_risk"], "Fresh Strawberries, 1 lb", "Fresh strawberries.");
  const watchlistFunnelTsxSrc = fs.readFileSync("components/WatchlistMiniFunnel.tsx", "utf8");
  check(
    "Herbicide & Pesticide (Glyphosate) Watch (pesticide_risk): flags conventional USDA PDP Dirty Dozen produce & desiccant-risk oats/wheat/chickpeas with explicit Glyphosate wording, renders Iowa Glyphosate vs. Cancer Map in onboarding, never flags USDA Organic or trace pectin/flavors, and stays opt-in when off",
    Boolean(
      convStrawberryRisk !== null &&
        convStrawberryRisk.category === "high_residue_produce" &&
        convStrawberryRisk.reason.toLowerCase().includes("glyphosate") &&
        convSpinachRisk !== null &&
        convOatsRisk !== null &&
        convOatsRisk.category === "conventional_grain_legume" &&
        convOatsRisk.reason.toLowerCase().includes("glyphosate") &&
        convFlourRisk !== null &&
        convHummusRisk !== null &&
        orgStrawberryRisk === null &&
        orgOatsRisk === null &&
        sparklingWaterNoFalsePositive === null &&
        pectinNoFalsePositive === null &&
        alertsWhenOff.length === 0 &&
        alertsWhenOn.length === 1 &&
        alertsWhenOn[0]?.id === "pesticide_risk" &&
        alertsWhenOn[0]?.label.includes("Glyphosate") &&
        watchlistFunnelTsxSrc.includes("Herbicides & Pesticides (Glyphosate) Watch") &&
        watchlistFunnelTsxSrc.includes("onboarding-iowa-glyphosate-map")
    )
  );

  const convStrawberryScanOff = await runScan({
    productTitle: "Fresh Strawberries, 1 lb",
    rawIngredients: "Fresh strawberries.",
    store: "walmart",
    dietaryWatchlist: [],
  });
  const convStrawberryScanOn = await runScan({
    productTitle: "Fresh Strawberries, 1 lb",
    rawIngredients: "Fresh strawberries.",
    store: "walmart",
    dietaryWatchlist: ["pesticide_risk"],
  });
  const convOatsScanOn = await runScan({
    productTitle: "Old Fashioned Rolled Oats, 42 oz",
    rawIngredients: "100% whole grain rolled oats.",
    store: "walmart",
    dietaryWatchlist: ["pesticide_risk"],
  });
  const orgStrawberryScanOn = await runScan({
    productTitle: "Driscoll's Organic Fresh Strawberries, 1 lb",
    rawIngredients: "Organic fresh strawberries.",
    store: "walmart",
    dietaryWatchlist: ["pesticide_risk"],
  });
  check(
    "Herbicide & Pesticide Watch Swaps: conventional strawberries & oats (90/100) keep swap=null when off, upgrade to certified USDA Organic swaps when pesticide_risk is on, and already-organic berries emit 0 alerts & null swap",
    Boolean(
      convStrawberryScanOff.ok &&
        convStrawberryScanOff.result.score >= 85 &&
        convStrawberryScanOff.swap === null &&
        convStrawberryScanOn.ok &&
        convStrawberryScanOn.dietaryAlerts?.some((a) => a.id === "pesticide_risk") &&
        convStrawberryScanOn.swap &&
        convStrawberryScanOn.swap.title.includes("Organic") &&
        convOatsScanOn.ok &&
        convOatsScanOn.dietaryAlerts?.some((a) => a.id === "pesticide_risk") &&
        convOatsScanOn.swap &&
        convOatsScanOn.swap.title.includes("Organic") &&
        orgStrawberryScanOn.ok &&
        (orgStrawberryScanOn.dietaryAlerts?.length ?? 0) === 0 &&
        orgStrawberryScanOn.swap === null
    )
  );

  const seortSlug = scanMod.extractTitleSlugFromUrl("https://www.walmart.com/ip/seort/197577662");
  const normalizedWalmartShare = scanMod.normalizeIosShareOrOcrInput(
    "Hey, check this out at Walmart! Great Value Crunchy Cheese Puffs, 8 oz https://www.walmart.com/ip/seort/197577662",
    ""
  );
  const liveBrowserSwiftSrc = fs.readFileSync("ios-app/App/LiveStoreBrowserViewController.swift", "utf8");
  const shortcutsSwiftSrc = fs.readFileSync("ios-app/App/HeyBrocShortcuts.swift", "utf8");
  const shareInfoPlistSrc = fs.readFileSync("ios-app/ShareExtension/Info.plist", "utf8");
  const androidScanApiKtSrc = fs.readFileSync(
    "android-app/app/src/main/java/com/cleancart/overlay/ScanApi.kt",
    "utf8"
  );
  const strawberryYogurtSwap = resolveSwap({
    score: 45,
    productTitle: "Strawberry Lowfat Yogurt, 32 oz",
    category: "Yogurt",
    store: "walmart",
    dietaryWatchlist: ["pesticide_risk"],
  });
  check(
    "3-Part Native iPhone Grocery Suite + Share Boilerplate Guard + Android Pesticide Parity: LiveStoreBrowserViewController, AppIntents (Back-Tap/OCR), App-Store-safe ShareExtension (.appex), and seort URL guard",
    Boolean(
      seortSlug === "" &&
        normalizedWalmartShare.title.includes("Great Value Crunchy Cheese Puffs") &&
        !normalizedWalmartShare.title.toLowerCase().includes("check this out") &&
        strawberryYogurtSwap?.title.includes("Stonyfield") &&
        liveBrowserSwiftSrc.includes("websiteDataStore = .default()") &&
        liveBrowserSwiftSrc.includes("heybrocStoreBridge") &&
        liveBrowserSwiftSrc.includes("floatingBubble") &&
        liveBrowserSwiftSrc.includes("tapTogglePesticide") &&
        shortcutsSwiftSrc.includes("ScanGroceryScreenshotIntent") &&
        shortcutsSwiftSrc.includes("CheckFoodWithHeyBrocIntent") &&
        shortcutsSwiftSrc.includes("TogglePesticideWatchIntent") &&
        shortcutsSwiftSrc.includes("HeyBrocShortcutsProvider") &&
        shortcutsSwiftSrc.includes("VNRecognizeTextRequest") &&
        !iosShareSwift.includes("UIApplication.shared") &&
        !shareInfoPlistSrc.includes("TRUEPREDICATE") &&
        shareInfoPlistSrc.includes("com.apple.share-services") &&
        buildIosYmlSrc.includes("LiveStoreBrowserViewController.swift") &&
        buildIosYmlSrc.includes("HeyBrocShortcuts.swift") &&
        buildIosYmlSrc.includes("com.heybroc.app.ShareExtension") &&
        buildIosYmlSrc.includes("APPLICATION_EXTENSION_API_ONLY") &&
        freshSimTsx.includes("open-ios-live-shop") &&
        freshSimTsx.includes("topbar-pesticide-toggle") &&
        androidScanApiKtSrc.includes('"pesticide_risk"')
    )
  );

  const toolsClientSrc = fs.readFileSync("app/tools/ToolsClient.tsx", "utf8");
  const swapsPageSrc = fs.readFileSync("app/swaps/page.tsx", "utf8");
  const swapsDirClientSrc = fs.readFileSync("app/swaps/SwapsDirectoryClient.tsx", "utf8");
  const cleanArcSrc = fs.readFileSync("components/CleanArcScoreCard.tsx", "utf8");
  const weeklyAuditSrc = fs.readFileSync("components/WeeklyOrderAuditModal.tsx", "utf8");
  check(
    "Compact Mobile Topbar & Scannable Subpages: single-row home header with overflow menu, 3-tab /tools layout, searchable capped /swaps directory, and CleanArcScoreCard horseshoe gauge + 3 mini rings",
    Boolean(
      freshSimTsx.includes("topbar-more-menu-btn") &&
        freshSimTsx.includes("topbar-dropdown") &&
        !freshSimTsx.includes('className="topbar-subnav"') &&
        freshSimTsx.includes("inspect-clean-arc-card") &&
        freshSimTsx.includes("cart-audit-arc-card") &&
        weeklyAuditSrc.includes("weekly-audit-arc-card") &&
        cleanArcSrc.includes("cleanArcGrad-") &&
        toolsClientSrc.includes("tools-clean-arc-card") &&
        toolsClientSrc.includes("tools-tab-${tab.id}") &&
        toolsClientSrc.includes('id: "grader"') &&
        toolsClientSrc.includes('id: "additives"') &&
        toolsClientSrc.includes('id: "setup"') &&
        swapsPageSrc.includes("SwapsDirectoryClient") &&
        swapsDirClientSrc.includes("swaps-search-input") &&
        swapsDirClientSrc.includes("swaps-show-all-btn")
    )
  );

  // ==================== 10-PILLAR LAUNCH AUDIT REGRESSION SUITE (WORKSTREAMS 1–5) ====================
  const { isUsMarketOffProduct } = await import("../lib/lookup");
  const { detectMajorAllergens } = await import("../lib/dietary");
  const { isAffiliateAllowedOnClient } = await import("../lib/swaps");
  const { inferClientPlatform } = await import("../lib/scan");
  const productImageRouteMod = await import("../app/api/product-image/route");
  const influencersRouteMod = await import("../app/api/influencers/route");
  const influencersLibMod = await import("../lib/influencers");
  const entitlementsLibMod = await import("../lib/entitlements");

  // Workstream 1A: US label formulation priority in Open Food Facts lookups
  check(
    "Workstream 1A: isUsMarketOffProduct accepts US-tagged & North American UPC entries and rejects UK/EU/CA/AU & foreign EAN-13 entries",
    isUsMarketOffProduct({ countries_tags: ["en:united-states"], code: "016000275287" }) === true &&
      isUsMarketOffProduct({ countries_tags: undefined, code: "016000275287" }) === true &&
      isUsMarketOffProduct({ countries_tags: undefined, code: "0016000275287" }) === true &&
      isUsMarketOffProduct({ countries_tags: ["en:united-kingdom"], code: "5000159459228" }) === false &&
      isUsMarketOffProduct({ countries_tags: ["en:france", "en:germany"], code: "3017620422003" }) === false &&
      isUsMarketOffProduct({ countries_tags: ["en:canada"], code: "0060383888237" }) === false &&
      isUsMarketOffProduct({ countries_tags: ["en:australia"], code: "9300675024846" }) === false &&
      isUsMarketOffProduct({ countries_tags: undefined, code: "5000159459228" }) === false &&
      isUsMarketOffProduct({ countries_tags: undefined, code: "3017620422003" }) === false
  );

  // Workstream 1B: Plant-milk/dairy separation, nut-free defaults & dietaryWatchlist (including sesame) swap safety
  const oatExtraCreamySwap = resolveSwap({
    score: 42,
    productTitle: "Planet Oat Extra Creamy Oatmilk, 52 fl oz",
    store: "walmart",
  });
  const oatKrogerSwap = resolveSwap({
    score: 42,
    productTitle: "Chobani Oat Milk Extra Creamy, 52 fl oz",
    store: "kroger",
  });
  const oatCostcoSwap = resolveSwap({
    score: 42,
    productTitle: "Oatly Oatmilk Original, 64 fl oz",
    store: "costco",
  });
  const soyMilkSwap = resolveSwap({
    score: 45,
    productTitle: "Silk Original Soymilk, 64 fl oz",
    store: "target",
  });
  const coconutMilkSwap = resolveSwap({
    score: 45,
    productTitle: "Silk Unsweetened Coconut Milk, 64 fl oz",
    store: "walmart",
  });
  const plantCreamerSwap = resolveSwap({
    score: 38,
    productTitle: "Silk Vanilla Oat Coffee Creamer, 32 fl oz",
    store: "walmart",
  });
  check(
    "Workstream 1B: Oat, soy, coconut, and plant-based creamers swap strictly to plant-based dairy-free & nut-free alternatives across stores",
    Boolean(
      oatExtraCreamySwap &&
        !detectMajorAllergens(oatExtraCreamySwap.title, oatExtraCreamySwap.ingredients).has("dairy") &&
        !detectMajorAllergens(oatExtraCreamySwap.title, oatExtraCreamySwap.ingredients).has("peanuts_nuts") &&
        oatKrogerSwap &&
        !detectMajorAllergens(oatKrogerSwap.title, oatKrogerSwap.ingredients).has("dairy") &&
        oatCostcoSwap &&
        oatCostcoSwap.brand === "Kirkland Signature" &&
        !detectMajorAllergens(oatCostcoSwap.title, oatCostcoSwap.ingredients).has("dairy") &&
        soyMilkSwap &&
        soyMilkSwap.brand === "WestSoy" &&
        !detectMajorAllergens(soyMilkSwap.title, soyMilkSwap.ingredients).has("dairy") &&
        coconutMilkSwap &&
        coconutMilkSwap.brand === "Native Forest" &&
        !detectMajorAllergens(coconutMilkSwap.title, coconutMilkSwap.ingredients).has("dairy") &&
        plantCreamerSwap &&
        plantCreamerSwap.brand === "Laird Superfood" &&
        !detectMajorAllergens(plantCreamerSwap.title, plantCreamerSwap.ingredients).has("dairy")
    )
  );

  const tortillaNutFreeSwap = resolveSwap({
    score: 25,
    productTitle: "Mission Soft Taco Flour Tortillas, 10 ct",
    store: "walmart",
  });
  const cookieNutFreeSwap = resolveSwap({
    score: 18,
    productTitle: "Nabisco Oreo Chocolate Sandwich Cookies",
    store: "walmart",
  });
  const snackDefaultSwap = resolveSwap({
    score: 22,
    productTitle: "Hostess Mystery Snack Pack",
    store: "walmart",
  });
  const sesameFreeCrackerSwap = resolveSwap({
    score: 15,
    productTitle: "Cheez-It Original Crackers",
    store: "walmart",
    dietaryWatchlist: ["sesame"],
  });
  const pbStaysPeanutSwap = resolveSwap({
    score: 25,
    productTitle: "Skippy Creamy Peanut Butter",
    store: "walmart",
  });
  const abStaysTreeNutSwap = resolveSwap({
    score: 35,
    productTitle: "Justin's Classic Almond Butter",
    store: "walmart",
  });
  check(
    "Workstream 1B: Nut-free tortillas/cookies/snacks never introduce nuts, peanut/tree-nut stay separated, and sesame dietaryWatchlist filters swaps",
    Boolean(
      tortillaNutFreeSwap &&
        tortillaNutFreeSwap.brand === "Mi Rancho" &&
        !detectMajorAllergens(tortillaNutFreeSwap.title, tortillaNutFreeSwap.ingredients).has("peanuts_nuts") &&
        cookieNutFreeSwap &&
        cookieNutFreeSwap.name.includes("Seed Flour") &&
        !detectMajorAllergens(cookieNutFreeSwap.title, cookieNutFreeSwap.ingredients).has("peanuts_nuts") &&
        snackDefaultSwap &&
        !detectMajorAllergens(snackDefaultSwap.title, snackDefaultSwap.ingredients).has("peanuts_nuts") &&
        sesameFreeCrackerSwap &&
        sesameFreeCrackerSwap.brand === "Lundberg Family Farms" &&
        !detectMajorAllergens(sesameFreeCrackerSwap.title, sesameFreeCrackerSwap.ingredients).has("sesame") &&
        pbStaysPeanutSwap &&
        /peanut/i.test(pbStaysPeanutSwap.ingredients) &&
        !/almond|cashew/i.test(pbStaysPeanutSwap.ingredients) &&
        abStaysTreeNutSwap &&
        /almond/i.test(abStaysTreeNutSwap.ingredients) &&
        !/\bpeanuts?\b/i.test(abStaysTreeNutSwap.ingredients)
    )
  );

  // Workstream 1C: Verified product photos & Yuka-style missing-photo UX
  const missingPhotoRes = await productImageRouteMod.GET(
    new Request("http://localhost:3000/api/product-image?q=Unverified+Fictional+Item+998877", {
      headers: { "x-forwarded-for": "127.0.0.88" },
    })
  );
  const missingPhotoBody = await missingPhotoRes.text();
  const simulatorSrc = fs.readFileSync("components/Simulator.tsx", "utf8");
  const chromeContentJs = fs.readFileSync("chrome-extension/content.js", "utf8");
  const safariContentJs = fs.readFileSync("ios-app/SafariExtension/Resources/content.js", "utf8");
  check(
    "Workstream 1C: /api/product-image serves Yuka-style neutral SVG placeholder on unverified items, Simulator taps to LabelScannerModal, and extensions sync domImageUrl",
    Boolean(
      missingPhotoRes.status === 200 &&
        (missingPhotoRes.headers.get("content-type") || "").includes("image/svg+xml") &&
        (missingPhotoRes.headers.get("x-image-source") || "").includes("Placeholder") &&
        missingPhotoBody.includes("<svg") &&
        !missingPhotoBody.includes("Grass-Fed") &&
        fs.existsSync("public/product-photo-unavailable.svg") &&
        simulatorSrc.includes("product-art--missing-photo") &&
        simulatorSrc.includes("setLabelScannerOpen(true)") &&
        chromeContentJs === safariContentJs &&
        chromeContentJs.includes("domImageUrl") &&
        chromeContentJs.includes("cc-thumb-empty")
    )
  );

  // Workstream 2: iOS Guideline 3.2.2(ix) / 4.2 zero-affiliate compliance & 3-target Xcode project
  const iosShareAmzScan = await runScan({
    productTitle: "Nabisco Oreo Chocolate Sandwich Cookies",
    store: "amazon",
    clientPlatform: "ios-share",
  });
  const iosSafariAmzScan = await runScan({
    productTitle: "Nabisco Oreo Chocolate Sandwich Cookies",
    store: "amazon",
    clientPlatform: "ios-safari",
  });
  const iosShortcutAmzScan = await runScan({
    productTitle: "Nabisco Oreo Chocolate Sandwich Cookies",
    store: "amazon",
    format: "ios_text",
  });
  const iosAppAmzScan = await runScan({
    productTitle: "Nabisco Oreo Chocolate Sandwich Cookies",
    store: "amazon",
    clientPlatform: "ios-app",
  });
  check(
    "Workstream 2: Zero affiliate tags or paid links across all iOS surfaces (ios-share, ios-safari, ios-shortcut, ios-app) & complete 3-target Xcode project",
    Boolean(
      !isAffiliateAllowedOnClient("web", "ios-share") &&
        !isAffiliateAllowedOnClient("web", "ios-safari") &&
        !isAffiliateAllowedOnClient("web", "ios-shortcut") &&
        !isAffiliateAllowedOnClient("web", "ios-app") &&
        !isAffiliateAllowedOnClient("extension", "chrome-extension") &&
        inferClientPlatform({ origin: "safari-web-extension://abc" }) === "ios-safari" &&
        inferClientPlatform({ format: "ios_text" }) === "ios-shortcut" &&
        inferClientPlatform({ deviceId: "ios-share-1234" }) === "ios-share" &&
        inferClientPlatform({ clientPlatform: "ios" }) === "ios-app" &&
        iosShareAmzScan.ok &&
        iosShareAmzScan.swap &&
        !iosShareAmzScan.swap.isPaidLink &&
        !(iosShareAmzScan.swap.webUrl || "").includes("tag=") &&
        iosSafariAmzScan.ok &&
        iosSafariAmzScan.swap &&
        !iosSafariAmzScan.swap.isPaidLink &&
        !(iosSafariAmzScan.swap.webUrl || "").includes("tag=") &&
        iosShortcutAmzScan.ok &&
        iosShortcutAmzScan.swap &&
        !iosShortcutAmzScan.swap.isPaidLink &&
        !(iosShortcutAmzScan.swap.webUrl || "").includes("tag=") &&
        iosAppAmzScan.ok &&
        iosAppAmzScan.swap &&
        !iosAppAmzScan.swap.isPaidLink &&
        !(iosAppAmzScan.swap.webUrl || "").includes("tag=") &&
        fs.existsSync("ios-app/HeyBroc.xcodeproj/project.pbxproj") &&
        fs.existsSync("ios-app/App/HeyBrocApp.swift") &&
        fs.existsSync("ios-app/SafariExtension/SafariWebExtensionHandler.swift") &&
        fs.existsSync("ios-app/App/PrivacyInfo.xcprivacy") &&
        fs.existsSync("ios-app/SafariExtension/PrivacyInfo.xcprivacy") &&
        fs.existsSync("ios-app/ShareExtension/PrivacyInfo.xcprivacy") &&
        iosShareSwift.includes("sanitizedRetailerURL")
    )
  );

  // Workstream 3 & 4: Android race/stepper/cart guards & self-hosted Tesseract v7 + CSP/camera headers
  const androidReaderKt = fs.readFileSync(
    "android-app/app/src/main/java/com/cleancart/overlay/GroceryScreenReaderService.kt",
    "utf8"
  );
  const androidOverlayKt = fs.readFileSync(
    "android-app/app/src/main/java/com/cleancart/overlay/OverlayWindowService.kt",
    "utf8"
  );
  const androidScanApiKt = fs.readFileSync(
    "android-app/app/src/main/java/com/cleancart/overlay/ScanApi.kt",
    "utf8"
  );
  const auditNextConfigSrc = fs.readFileSync("next.config.ts", "utf8");
  check(
    "Workstreams 3 & 4: Android scanGeneration/EXTRA_QTY_DELTA/storeBucket guards + self-hosted /tesseract/* OCR & CSP/camera=(self)",
    Boolean(
      androidReaderKt.includes("scanGeneration") &&
        androidReaderKt.includes("EXTRA_QTY_DELTA") &&
        androidOverlayKt.includes("matchesCartRemovalTarget") &&
        androidScanApiKt.includes("storeBucket") &&
        updatedMainActivityKt.includes("liveSearchSeq") &&
        fs.existsSync("public/tesseract/worker.min.js") &&
        fs.existsSync("public/tesseract/eng.traineddata.gz") &&
        auditNextConfigSrc.includes("camera=(self)") &&
        auditNextConfigSrc.includes("wasm-unsafe-eval") &&
        auditNextConfigSrc.includes("worker-src 'self' blob:") &&
        labelModalSrc.includes("/tesseract/worker.min.js") &&
        auditModalSrc.includes("/tesseract/worker.min.js")
    )
  );

  // Workstream 5: Creator takeover block, anon-web isolation, OTO trial_end, RevenueCat CUSTOMER_SUPPORT refund, atomic Lua payout & referral lock
  const testHijackCode = `AUDITLOCK${Date.now().toString(36).slice(-4).toUpperCase()}`;
  const initialClaimRes = await influencersRouteMod.POST(
    new Request("http://localhost:3000/api/influencers", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "127.0.0.98" },
      body: JSON.stringify({
        action: "self_register",
        code: testHijackCode,
        name: "Verified Creator",
        payoutEmail: "owner@heybroc-test.example",
        payoutMethod: "paypal",
        payoutHandle: "@owner-real",
      }),
    })
  );
  const hijackRes = await influencersRouteMod.POST(
    new Request("http://localhost:3000/api/influencers", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "127.0.0.99" },
      body: JSON.stringify({
        action: "self_register",
        code: testHijackCode,
        name: "Attacker",
        payoutEmail: "owner@heybroc-test.example",
        payoutMethod: "venmo",
        payoutHandle: "@attacker-stolen",
      }),
    })
  );
  const creatorAfterHijack = await influencersLibMod.getCreator(testHijackCode);
  await influencersLibMod.deleteCreator(testHijackCode).catch(() => {});
  const checkoutRouteSrc = fs.readFileSync("app/api/checkout/route.ts", "utf8");
  const rcWebhookSrc = fs.readFileSync("app/api/revenuecat/webhook/route.ts", "utf8");
  const storageSrc = fs.readFileSync("lib/storage.ts", "utf8");
  const referralsSrc = fs.readFileSync("lib/referrals.ts", "utf8");
  const authSrc = fs.readFileSync("lib/auth.ts", "utf8");
  check(
    "Workstream 5: Unauthenticated creator takeover returns 409, anon-web rejected, OTO trial_end & RC CUSTOMER_SUPPORT refund wired, and Lua/kvSetNx/GDPR locks active",
    Boolean(
      initialClaimRes.status === 200 &&
        hijackRes.status === 409 &&
        creatorAfterHijack?.payoutHandle === "@owner-real" &&
        entitlementsLibMod.normalizeRealDeviceId("anon-web") === "" &&
        entitlementsLibMod.normalizeRealDeviceId("anonymous") === "" &&
        entitlementsLibMod.normalizeRealDeviceId("web-valid-device-123") === "web-valid-device-123" &&
        checkoutRouteSrc.includes("subscription_data[trial_end]") &&
        rcWebhookSrc.includes("CUSTOMER_SUPPORT") &&
        storageSrc.includes("kvEvalLua") &&
        referralsSrc.includes("reward-lock") &&
        authSrc.includes("redactEntitlementEmail")
    )
  );

  // ==================== PASS-2 ADVERSARIAL DIFF AUDIT REGRESSIONS (#1–#13) ====================
  const earthBalanceSwap = resolveSwap({
    score: 28,
    productTitle: "Earth Balance Original Buttery Spread, 15 oz",
    store: "walmart",
  });
  const countryCrockPlantSwap = resolveSwap({
    score: 28,
    productTitle: "Country Crock Plant Butter with Olive Oil",
    store: "kroger",
    preferStoreBrand: true,
  });
  const violifeCheeseSwap = resolveSwap({
    score: 35,
    productTitle: "Violife Just Like Cheddar Shreds, 8 oz",
    store: "walmart",
  });
  const daiyaSlicesSwap = resolveSwap({
    score: 35,
    productTitle: "Daiya Dairy-Free Cheddar Style Slices",
    store: "target",
  });
  const naturalBlissOatCreamerSwap = resolveSwap({
    score: 38,
    productTitle: "Coffee mate Natural Bliss Non-Dairy Oat Milk Creamer",
    store: "walmart",
  });
  const enjoyLifeChocSwap = resolveSwap({
    score: 48,
    productTitle: "Enjoy Life Dairy-Free Dark Chocolate Bar",
    store: "walmart",
  });
  const chobaniCreamerKrogerSwap = resolveSwap({
    score: 45,
    productTitle: "Chobani Coffee Creamer Sweet Cream, 24 fl oz",
    store: "kroger",
    preferStoreBrand: true,
  });
  const chobaniCreamerCostcoSwap = resolveSwap({
    score: 45,
    productTitle: "Chobani Coffee Creamer Sweet Cream, 24 fl oz",
    store: "costco",
    preferStoreBrand: true,
  });
  check(
    "Pass-2 (#1–#3): Plant-based butters/cheeses never swap to cow's dairy or Fruit Bars, benign coconut milk/cocoa butter pass dairy guard, and Chobani Creamer never swaps to Greek yogurt",
    Boolean(
      earthBalanceSwap &&
        !detectMajorAllergens(earthBalanceSwap.title, earthBalanceSwap.ingredients).has("dairy") &&
        countryCrockPlantSwap &&
        !detectMajorAllergens(countryCrockPlantSwap.title, countryCrockPlantSwap.ingredients).has("dairy") &&
        violifeCheeseSwap === null &&
        daiyaSlicesSwap === null &&
        naturalBlissOatCreamerSwap &&
        naturalBlissOatCreamerSwap.brand === "Laird Superfood" &&
        enjoyLifeChocSwap &&
        enjoyLifeChocSwap.brand === "Hu" &&
        chobaniCreamerKrogerSwap &&
        !/yogurt|skyr/i.test(chobaniCreamerKrogerSwap.title) &&
        /creamer/i.test(chobaniCreamerKrogerSwap.title) &&
        chobaniCreamerCostcoSwap &&
        !/yogurt|skyr/i.test(chobaniCreamerCostcoSwap.title)
    )
  );

  const iosHeyBrocAppSwift = fs.readFileSync("ios-app/App/HeyBrocApp.swift", "utf8");
  const weeklyOrderModalUpdatedSrc = fs.readFileSync("components/WeeklyOrderAuditModal.tsx", "utf8");
  const simulatorUpdatedSrc = fs.readFileSync("components/Simulator.tsx", "utf8");
  const iosWebViewSwapCheck = resolveSwap({
    score: 18,
    productTitle: "Nabisco Oreo Chocolate Sandwich Cookies",
    store: "amazon",
    surface: "extension",
    clientPlatform: "ios-app",
  });
  check(
    "Pass-2 (#4–#7): Web Simulator wires dietaryWatchlist & isIosAppClient, suppresses Stripe Paywall in iOS WKWebView, syncs preferStoreBrand & sesame guard, and blocks *.stripe.com in WKWebView",
    Boolean(
      simulatorUpdatedSrc.includes("detectIosAppClient") &&
        simulatorUpdatedSrc.includes("requestProUpgrade") &&
        simulatorUpdatedSrc.includes("dietaryWatchlist,") &&
        weeklyOrderModalUpdatedSrc.includes("detectIosAppClient") &&
        iosHeyBrocAppSwift.includes('applicationNameForUserAgent = "HeyBrocIOS/1.0"') &&
        iosHeyBrocAppSwift.includes("checkout.stripe.com") &&
        iosHeyBrocAppSwift.includes("billing.stripe.com") &&
        iosHeyBrocAppSwift.includes('"sesame"') &&
        iosViewControllerSrc.includes('host.hasSuffix(".stripe.com")') &&
        iosWebViewSwapCheck &&
        iosWebViewSwapCheck.isPaidLink === false &&
        !(iosWebViewSwapCheck.webUrl || "").includes("tag=")
    )
  );

  // Verify unverified squatter creatorToken cannot update payout settings or connect Stripe (#8)
  const squatterCode = `SQUAT${Date.now().toString(36).slice(-4).toUpperCase()}`;
  const squatterRegRes = await influencersRouteMod.POST(
    new Request("http://localhost:3000/api/influencers", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "127.0.0.101" },
      body: JSON.stringify({
        action: "self_register",
        code: squatterCode,
        name: "Squatter",
        payoutEmail: "victim-creator@heybroc-test.example",
        payoutMethod: "paypal",
        payoutHandle: "@victim-public",
      }),
    })
  );
  const squatterRegData = (await squatterRegRes.json()) as { creatorToken?: string };
  const squatterMutateRes = await influencersRouteMod.POST(
    new Request("http://localhost:3000/api/influencers", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "127.0.0.102" },
      body: JSON.stringify({
        action: "update_payout_settings",
        code: squatterCode,
        creatorToken: squatterRegData.creatorToken,
        payoutMethod: "venmo",
        payoutHandle: "@squatter-theft",
      }),
    })
  );
  await influencersLibMod.deleteCreator(squatterCode).catch(() => {});

  const stripeWebhookUpdatedSrc = fs.readFileSync("app/api/stripe/webhook/route.ts", "utf8");
  const rcWebhookUpdatedSrc = fs.readFileSync("app/api/revenuecat/webhook/route.ts", "utf8");
  const checkoutUpdatedSrc = fs.readFileSync("app/api/checkout/route.ts", "utf8");
  const billingPortalUpdatedSrc = fs.readFileSync("app/api/billing/portal/route.ts", "utf8");
  const paywallUpdatedSrc = fs.readFileSync("components/Paywall.tsx", "utf8");
  const otoModalUpdatedSrc = fs.readFileSync("components/PostCheckoutOtoModal.tsx", "utf8");
  const influencersLibUpdatedSrc = fs.readFileSync("lib/influencers.ts", "utf8");
  const entitlementsUpdatedSrc = fs.readFileSync("lib/entitlements.ts", "utf8");
  const referralsUpdatedSrc = fs.readFileSync("lib/referrals.ts", "utf8");
  const authUpdatedSrc = fs.readFileSync("lib/auth.ts", "utf8");
  check(
    "Pass-2 (#8–#13): Unverified squatter creatorToken blocked (403), OTO trial_end_sec & non-regressing expiry preserved, RC $0 trial clawback blocked, Billing Portal auth precedence, paidPassExpiresAtMs serialized, atomic Lua payout history & SHA-256 GDPR scrubbing",
    Boolean(
      squatterRegRes.status === 200 &&
        (squatterMutateRes.status === 401 || squatterMutateRes.status === 403) &&
        influencersLibUpdatedSrc.includes("tokenNonce") &&
        influencersLibUpdatedSrc.includes("prependPayoutRecordAtomic") &&
        checkoutUpdatedSrc.includes("metadata[trial_end_sec]") &&
        stripeWebhookUpdatedSrc.includes("trial_end_sec") &&
        entitlementsUpdatedSrc.includes("resolveNonRegressingExpiryMs") &&
        rcWebhookUpdatedSrc.includes("TRIAL") &&
        rcWebhookUpdatedSrc.includes("lastChargeSucceeded") &&
        billingPortalUpdatedSrc.includes("isSessionAuthenticated") &&
        paywallUpdatedSrc.includes("Authorization") &&
        otoModalUpdatedSrc.includes("Authorization") &&
        referralsUpdatedSrc.includes("paidPassExpiresAtMs") &&
        authUpdatedSrc.includes("paidPassExpiresAtMs") &&
        authUpdatedSrc.includes("email_sha256") &&
        authUpdatedSrc.includes("purgeUserVirtualDevice")
    )
  );

  const labelReportRouteMod = await import("../app/api/label-report/route");
  const labelRepReq = new Request("http://localhost:3000/api/label-report", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "127.0.0.88" },
    body: JSON.stringify({
      productTitle: "Strawberry Low Fat Yogurt",
      brand: "Yoplait",
      currentIngredients:
        "Cultured Grade A Reduced Fat Milk, Sugar, Strawberries, Modified Corn Starch, High Fructose Corn Syrup, Kosher Gelatin, Citric Acid, Tricalcium Phosphate, Colored with Carmine, Natural Flavor, Pectin, Vitamin A Acetate, Vitamin D3.",
      reportedIngredients:
        "Cultured Pasteurized Organic Whole Milk, Organic Strawberries, Live and Active Cultures.",
      issueType: "reformulated",
      store: "walmart",
    }),
  });
  const labelRepRes = await labelReportRouteMod.POST(labelRepReq);
  const labelRepJson = (await labelRepRes.json()) as {
    ok: boolean;
    report?: { status: string; previousScore: number; verifiedScore: number };
  };
  const labelVerifierModalSrc = fs.readFileSync("components/LabelAutoVerifierModal.tsx", "utf8");
  check(
    "Automatic AI Label & Score Verifier: replaces mailto:support@heybroc.com with in-app /api/label-report auto-verifier across Web, iOS Safari & Android",
    Boolean(
      labelRepJson.ok &&
        labelRepJson.report?.status === "auto_updated" &&
        (labelRepJson.report?.verifiedScore ?? 0) > (labelRepJson.report?.previousScore ?? 100) &&
        freshSimTsx.includes("open-label-auto-verifier") &&
        freshSimTsx.includes("LabelAutoVerifierModal") &&
        !freshSimTsx.includes("mailto:support@heybroc.com") &&
        labelVerifierModalSrc.includes("run-auto-label-check-btn") &&
        safariContentSrc.includes('data-act="auto-verify-label"') &&
        !safariContentSrc.includes("mailto:support@heybroc.com") &&
        androidScanApiKtSrc.includes("autoVerifyLabel")
    )
  );

  const authModalLatestSrc = fs.readFileSync("components/AuthModal.tsx", "utf8");
  const exposeModalLatestSrc = fs.readFileSync("components/ProductExposeModal.tsx", "utf8");
  const applegateImgReq = new Request(
    "http://localhost:3000/api/product-image?q=" +
      encodeURIComponent("Applegate Organics Oven Roasted Turkey Breast"),
  );
  const applegateImgRes = await productImageRouteMod.GET(applegateImgReq);
  const applegateContentType = applegateImgRes.headers.get("content-type") || "";
  const applegateImgSource = applegateImgRes.headers.get("x-image-source") || "";
  check(
    "Mobile UX Polish: transparent /broc-mascot.png everywhere, zero purple arc strokes, single green share pill without guest BROC code, Applegate Organics photo match, real Google OAuth chooser & scroll-locked AuthModal",
    Boolean(
      freshSimTsx.includes("/broc-mascot.png") &&
        !freshSimTsx.includes("/broc-mascot.jpg") &&
        freshSimTsx.includes("independent-section") &&
        freshSimTsx.includes("phone-store-search-input") &&
        !freshSimTsx.includes("/llms.txt") &&
        !freshSimTsx.includes("/sitemap.xml") &&
        !cleanArcSrc.toLowerCase().includes("#a855f7") &&
        !cleanArcSrc.toLowerCase().includes("#8b5cf6") &&
        !freshSimTsx.toLowerCase().includes("#a855f7") &&
        exposeModalLatestSrc.includes("expose-share-primary-btn") &&
        !exposeModalLatestSrc.includes("expose-download-png-btn") &&
        !exposeModalLatestSrc.includes("expose-copy-link-btn") &&
        applegateImgRes.status === 200 &&
        applegateContentType.includes("image/jpeg") &&
        applegateImgSource === "HeyBroc Verified Product Photo" &&
        authModalLatestSrc.includes("accounts.google.com/o/oauth2/v2/auth") &&
        authModalLatestSrc.includes("select_account") &&
        authModalLatestSrc.includes("document.body.style.overflow")
    )
  );

  const finalFunnelSrc = fs.readFileSync("components/WatchlistMiniFunnel.tsx", "utf8");
  const finalSimSrc = fs.readFileSync("components/Simulator.tsx", "utf8");
  const finalPaywallSrc = fs.readFileSync("components/Paywall.tsx", "utf8");
  const finalMainKtSrc = fs.readFileSync(
    "android-app/app/src/main/java/com/cleancart/overlay/MainActivity.kt",
    "utf8"
  );
  const finalCheckoutSrc = fs.readFileSync("app/api/checkout/route.ts", "utf8");
  const paywallConsentPos = finalPaywallSrc.indexOf('id="paywall-arl-consent"');
  const paywallCtaPos = finalPaywallSrc.indexOf('id="paywall-cta"');
  const paywallPromoPos = finalPaywallSrc.indexOf('id="creator-code-input"');
  check(
    "Onboarding & Paywall UX Polish: 12 stores, dedicated Step 5 Glyphosate Map slide, real product comparison photos, honest store-link copy, single-screen Watchlist Quick Editor, above-the-fold Trial CTA, and sanitized KV checkout error",
    Boolean(
      finalFunnelSrc.includes('id: "ubereats"') &&
        finalFunnelSrc.includes('id: "doordash"') &&
        finalFunnelSrc.includes('id: "shipt"') &&
        finalFunnelSrc.includes('id: "bjs"') &&
        finalFunnelSrc.includes("Glyphosate Map") &&
        finalFunnelSrc.includes("/onboarding-poor-pick.jpg") &&
        finalFunnelSrc.includes("/onboarding-clean-pick.jpg") &&
        !finalFunnelSrc.includes("miniTestSamples") &&
        finalFunnelSrc.includes('id="watchlist-quick-editor"') &&
        finalFunnelSrc.includes("quickEditMode") &&
        fs.existsSync("public/onboarding-poor-pick.jpg") &&
        fs.existsSync("public/onboarding-clean-pick.jpg") &&
        fs.existsSync("android-app/app/src/main/res/drawable-nodpi/onboarding_poor_pick.jpg") &&
        fs.existsSync("android-app/app/src/main/res/drawable-nodpi/onboarding_clean_pick.jpg") &&
        finalSimSrc.includes("quickEditMode={manualFunnelOpen}") &&
        !finalSimSrc.includes("showAllPresets") &&
        !finalSimSrc.includes("Show all {") &&
        paywallConsentPos > 0 &&
        paywallCtaPos > paywallConsentPos &&
        paywallPromoPos > paywallCtaPos &&
        !finalPaywallSrc.includes("Swap All") &&
        finalMainKtSrc.includes("STEP 5 OF 7 · GLYPHOSATE MAP") &&
        finalMainKtSrc.includes("STEP 6 OF 7 · WHY IT MATTERS") &&
        finalMainKtSrc.includes("R.drawable.onboarding_poor_pick") &&
        finalMainKtSrc.includes("R.drawable.onboarding_clean_pick") &&
        finalMainKtSrc.includes('"ubereats"') &&
        !finalMainKtSrc.includes("Swap-All Cart Cleaner") &&
        finalCheckoutSrc.includes("StorageConfigError")
    )
  );

  {
    const { NextRequest } = await import("next/server");
    const checkoutRouteHandler = await import("../app/api/checkout/route");
    const appleRetentionHandler = await import("../app/api/apple/retention/route");
    const billingRetentionHandler = await import("../app/api/billing/retention/route");
    const { TERMS_VERSION } = await import("../lib/pricing");

    const nowT = Date.now();
    const trialAnnualElig = entitlementsLibMod.evaluateZeroLeakageRetentionEligibility(
      {
        sessionId: "cs_trial_ann_1",
        subscriptionId: "sub_trial_ann_1",
        plan: "annual",
        status: "trialing",
        active: true,
        updatedAt: new Date(nowT).toISOString(),
      },
      nowT
    );
    const unpaidMonthlyElig = entitlementsLibMod.evaluateZeroLeakageRetentionEligibility(
      {
        sessionId: "cs_trial_mo_1",
        subscriptionId: "sub_trial_mo_1",
        plan: "monthly",
        status: "trialing",
        active: true,
        lastChargeSucceeded: false,
        updatedAt: new Date(nowT).toISOString(),
      },
      nowT
    );
    const paidMonthlyElig = entitlementsLibMod.evaluateZeroLeakageRetentionEligibility(
      {
        sessionId: "cs_paid_mo_1",
        subscriptionId: "sub_paid_mo_1",
        plan: "monthly",
        status: "active",
        active: true,
        lastChargeSucceeded: true,
        updatedAt: new Date(nowT).toISOString(),
      },
      nowT
    );
    const cooldownMonthlyElig = entitlementsLibMod.evaluateZeroLeakageRetentionEligibility(
      {
        sessionId: "cs_paid_mo_cd",
        subscriptionId: "sub_paid_mo_cd",
        plan: "monthly",
        status: "active",
        active: true,
        lastChargeSucceeded: true,
        lastRetentionOfferAtMs: nowT - 86_400_000,
        lastRetentionPauseAtMs: nowT - 86_400_000,
        updatedAt: new Date(nowT).toISOString(),
      },
      nowT
    );
    const paidAnnualElig = entitlementsLibMod.evaluateZeroLeakageRetentionEligibility(
      {
        sessionId: "cs_paid_ann_1",
        subscriptionId: "sub_paid_ann_1",
        plan: "annual",
        status: "active",
        active: true,
        lastChargeSucceeded: true,
        updatedAt: new Date(nowT).toISOString(),
      },
      nowT
    );

    check(
      "Zero-Leakage Retention Eligibility: $0 trialers never qualify for $39.99/yr or 30d pause; only paid Monthly ($9.99 + $39.99 = $49.98) qualifies with 180-day cooldown",
      Boolean(
        trialAnnualElig.canLoyaltyAnnual39 === false &&
          trialAnnualElig.canPause30d === false &&
          trialAnnualElig.canSwitchToMonthly === true &&
          unpaidMonthlyElig.canLoyaltyAnnual39 === false &&
          unpaidMonthlyElig.canPause30d === false &&
          unpaidMonthlyElig.canStandardAnnual49 === true &&
          paidMonthlyElig.canLoyaltyAnnual39 === true &&
          paidMonthlyElig.canPause30d === true &&
          cooldownMonthlyElig.canLoyaltyAnnual39 === false &&
          cooldownMonthlyElig.canPause30d === false &&
          paidAnnualElig.canLoyaltyAnnual39 === false &&
          paidAnnualElig.canPause30d === false &&
          paidAnnualElig.canSwitchToMonthly === true
      )
    );

    // Seed a trialing monthly entitlement and verify POST /api/checkout blocks cancel_flow $39.99/yr with HTTP 403
    const trialCancelSessionId = "cs_test_cancel_leak_guard_001";
    const trialCancelDeviceId = "web-cancel-leak-guard-001";
    await entitlementsLibMod.saveEntitlement({
      sessionId: trialCancelSessionId,
      checkoutSessionId: trialCancelSessionId,
      subscriptionId: "sub_cancel_leak_guard_001",
      deviceId: trialCancelDeviceId,
      plan: "monthly",
      status: "trialing",
      active: true,
      expiresAtMs: nowT + 5 * 86_400_000,
      updatedAt: new Date(nowT).toISOString(),
    });
    const prevStripeKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_zero_leakage_guard";
    let cancelGuardStatus = 0;
    let unauthInspectHasSub = true;
    try {
      const leakGuardReq = new NextRequest("http://localhost:3000/api/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "127.0.0.91",
        },
        body: JSON.stringify({
          plan: "annual",
          otoOffer: "oto_annual",
          retentionSource: "cancel_flow",
          previousSessionId: trialCancelSessionId,
          deviceId: trialCancelDeviceId,
          termsAccepted: true,
          termsVersion: TERMS_VERSION,
        }),
      });
      const leakGuardRes = await checkoutRouteHandler.POST(leakGuardReq);
      cancelGuardStatus = leakGuardRes.status;

      const unauthInspectRes = await billingRetentionHandler.POST(
        new Request("http://localhost:3000/api/billing/retention", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": "127.0.0.92",
          },
          body: JSON.stringify({ action: "inspect", deviceId: "web-unknown-999" }),
        })
      );
      const unauthInspectJson = (await unauthInspectRes.json()) as {
        ok?: boolean;
        hasManagedStripeSub?: boolean;
      };
      unauthInspectHasSub = Boolean(unauthInspectJson.hasManagedStripeSub);
    } finally {
      if (prevStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = prevStripeKey;
    }

    // Apple Real-Time Retention Messaging Webhook checks
    const makeTestJws = (payload: Record<string, unknown>) => {
      const h = Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url");
      const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
      return `${h}.${p}.sig`;
    };
    await entitlementsLibMod.saveEntitlement({
      sessionId: "rc_sess_rc_apple_trial_ann_99",
      subscriptionId: "rc_apple_trial_ann_99",
      plan: "annual",
      status: "trialing",
      active: true,
      expiresAtMs: nowT + 6 * 86_400_000,
      updatedAt: new Date(nowT).toISOString(),
    });
    await entitlementsLibMod.saveEntitlement({
      sessionId: "rc_sess_rc_apple_paid_mo_99",
      subscriptionId: "rc_apple_paid_mo_99",
      plan: "monthly",
      status: "active",
      active: true,
      lastChargeSucceeded: true,
      expiresAtMs: nowT + 25 * 86_400_000,
      updatedAt: new Date(nowT).toISOString(),
    });

    const prevRequireX5c = process.env.APPLE_RETENTION_REQUIRE_X5C;
    process.env.APPLE_RETENTION_REQUIRE_X5C = "false";
    let appleUnknownJson: { message?: { messageIdentifier?: string }; alternateProduct?: unknown } = {};
    let appleTrialAnnJson: { alternateProduct?: { productId?: string } } = {};
    let applePaidMoJson: { alternateProduct?: { productId?: string } } = {};
    try {
      const appleUnknownRes = await appleRetentionHandler.POST(
        new Request("http://localhost:3000/api/apple/retention", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            signedPayload: makeTestJws({
              originalTransactionId: "unknown_tx_000",
              productId: "com.heybroc.pro.annual",
              environment: "Sandbox",
            }),
          }),
        })
      );
      appleUnknownJson = (await appleUnknownRes.json()) as {
        message?: { messageIdentifier?: string };
        alternateProduct?: unknown;
      };

      const appleTrialAnnRes = await appleRetentionHandler.POST(
        new Request("http://localhost:3000/api/apple/retention", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            signedPayload: makeTestJws({
              originalTransactionId: "apple_trial_ann_99",
              productId: "com.heybroc.pro.annual",
              environment: "Sandbox",
            }),
          }),
        })
      );
      appleTrialAnnJson = (await appleTrialAnnRes.json()) as {
        alternateProduct?: { productId?: string };
      };

      const applePaidMoRes = await appleRetentionHandler.POST(
        new Request("http://localhost:3000/api/apple/retention", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            signedPayload: makeTestJws({
              originalTransactionId: "apple_paid_mo_99",
              productId: "com.heybroc.pro.monthly",
              environment: "Sandbox",
            }),
          }),
        })
      );
      applePaidMoJson = (await applePaidMoRes.json()) as {
        alternateProduct?: { productId?: string };
      };
    } finally {
      if (prevRequireX5c === undefined) delete process.env.APPLE_RETENTION_REQUIRE_X5C;
      else process.env.APPLE_RETENTION_REQUIRE_X5C = prevRequireX5c;
    }

    const cancelModalSrc = fs.readFileSync("components/CancelRetentionModal.tsx", "utf8");
    const iosAppSwiftSrc = fs.readFileSync("ios-app/App/HeyBrocApp.swift", "utf8");
    const manifestJsonObj = JSON.parse(fs.readFileSync("public/manifest.json", "utf8")) as {
      shortcuts?: Array<{ url?: string }>;
    };
    const appleDocSrc = fs.readFileSync("docs/apple-retention-messaging.md", "utf8");

    check(
      "Cancel-Flow Guard (HTTP 403), Apple Retention Webhook (<50ms JWS routing), Click-to-Cancel UI, and iOS/Android/PWA Home-Screen Quick Actions",
      Boolean(
        cancelGuardStatus === 403 &&
          unauthInspectHasSub === false &&
          Boolean(appleUnknownJson.message?.messageIdentifier) &&
          !appleUnknownJson.alternateProduct &&
          appleTrialAnnJson.alternateProduct?.productId === "com.heybroc.pro.monthly" &&
          applePaidMoJson.alternateProduct?.productId === "com.heybroc.pro.annual" &&
          cancelModalSrc.includes('id="retention-loss-summary"') &&
          cancelModalSrc.includes('id="retention-continue-cancel-btn"') &&
          cancelModalSrc.includes('id="retention-pause-btn"') &&
          cancelModalSrc.includes('id="retention-switch-plan-btn"') &&
          cancelModalSrc.includes('id="retention-arl-consent"') &&
          iosAppSwiftSrc.includes("HeyBrocShortcutManager") &&
          iosAppSwiftSrc.includes("UIApplicationShortcutItem") &&
          finalMainKtSrc.includes("syncDynamicHomeScreenShortcuts") &&
          finalMainKtSrc.includes("ShortcutManager") &&
          Array.isArray(manifestJsonObj.shortcuts) &&
          manifestJsonObj.shortcuts.length === 3 &&
          manifestJsonObj.shortcuts.some((s) => s.url === "/?audit=1") &&
          manifestJsonObj.shortcuts.some((s) => s.url === "/?scan=1") &&
          appleDocSrc.includes("/api/apple/retention")
      )
    );
  }

  const healthyScenerySrc = fs.readFileSync("components/HealthyScenery.tsx", "utf8");
  const independencePageSrc = fs.readFileSync("app/independence/page.tsx", "utf8");
  const latestGlobalsCssSrc = fs.readFileSync("app/globals.css", "utf8");
  check(
    "Clean Faint-Green Canvas, Mobile Halo Guard, Soft-Mint Pledge Cards & Kitchen Counter Unpacking Scene: no mobile stage halo overlap, sans-serif pledge cards, and giant U-eye Broc mascot",
    Boolean(
      fs.existsSync("public/broc-mascot-meadow.png") &&
        healthyScenerySrc.includes('id="healthy-food-backdrop"') &&
        healthyScenerySrc.includes('id="stage-food-halo"') &&
        healthyScenerySrc.includes('id="independent-section"') &&
        healthyScenerySrc.includes('id="yuka-swap-showcase"') &&
        healthyScenerySrc.includes('id="footer-kitchen-scenery"') &&
        healthyScenerySrc.includes('id="footer-kitchen-broc"') &&
        healthyScenerySrc.includes("Scores Can&apos;t Be Bought") &&
        healthyScenerySrc.includes("Zero Sponsored Placements") &&
        healthyScenerySrc.includes("Shopper-Funded Only") &&
        !healthyScenerySrc.includes("No influence from brands") &&
        !healthyScenerySrc.includes("Responsible financing") &&
        healthyScenerySrc.includes("Our Mission") &&
        healthyScenerySrc.includes("Grocery Tools") &&
        healthyScenerySrc.includes("/broc-mascot-meadow.png") &&
        finalSimSrc.includes("<HealthyFoodBackdrop />") &&
        finalSimSrc.includes("<PhoneStageFoodHalo />") &&
        finalSimSrc.includes("<YukaIndependentShowcase />") &&
        finalSimSrc.includes("<YukaSwapShowcase />") &&
        finalSimSrc.includes("<YukaImpactBand />") &&
        finalSimSrc.includes("<YukaSiteFooter") &&
        finalSimSrc.includes("<FooterKitchenScenery />") &&
        independencePageSrc.includes("100% family-owned. Built for parents, never Big Food.") &&
        independencePageSrc.includes("100% FAMILY OWNED") &&
        independencePageSrc.includes("Scores Can&apos;t Be Bought") &&
        independencePageSrc.includes("Zero Sponsored Placements") &&
        independencePageSrc.includes("Shopper-Funded Only") &&
        independencePageSrc.includes("<FooterKitchenScenery />") &&
        !latestGlobalsCssSrc.includes(".stage { position: static; }") &&
        latestGlobalsCssSrc.includes(".stage { position: relative; top: auto; z-index: 1; overflow: hidden; }") &&
        latestGlobalsCssSrc.includes(".broc-pledge-card") &&
        latestGlobalsCssSrc.includes(".kitchen-broc-mascot") &&
        latestGlobalsCssSrc.includes("height: 196px;")
    )
  );

  const { sanitizeOffFoodNutrition } = await import("../lib/lookup");
  const missionForward = await lookupIngredients({ productTitle: "Mission Flour tortillas" });
  const missionReverse = await lookupIngredients({ productTitle: "Flour tortillas mission" });
  const missionWatchScoreA = missionForward
    ? scoreProductYuka(
        missionForward.ingredients,
        { seedOils: "2x", dyes: "2x", hfcs: "2x" },
        [],
        { ...missionForward.nutrition, productTitle: missionForward.productTitle },
      )
    : null;
  const missionWatchScoreB = missionReverse
    ? scoreProductYuka(
        missionReverse.ingredients,
        { seedOils: "2x", dyes: "2x", hfcs: "2x" },
        [],
        { ...missionReverse.nutrition, productTitle: missionReverse.productTitle },
      )
    : null;
  const latestToolsClientSrc = fs.readFileSync("app/tools/ToolsClient.tsx", "utf8");
  const latestSwapsSlugSrc = fs.readFileSync("app/swaps/[slug]/page.tsx", "utf8");
  check(
    "Word-Order Lookup Symmetry, OFF Corrupt Sodium Sanitizer & Mobile Flagged-Row Overflow Guard: 'Mission Flour tortillas' and 'Flour tortillas mission' return identical verified label & score, corrupt 12,500mg OFF tortilla sodium is dropped, bare vegetable shortening is flagged, and mobile additive badges never overflow",
    Boolean(
      missionForward &&
        missionReverse &&
        missionForward.productTitle === "Mission Soft Taco Flour Tortillas" &&
        missionReverse.productTitle === "Mission Soft Taco Flour Tortillas" &&
        missionWatchScoreA &&
        missionWatchScoreB &&
        missionWatchScoreA.score === missionWatchScoreB.score &&
        missionWatchScoreA.flagged.some((f) => f.id === "soybeanoil") &&
        missionWatchScoreA.flagged.some((f) => f.id === "hydrogoil") &&
        (missionForward.nutrition?.sodiumMg100g ?? 0) < 1200 &&
        scoreIngredients("enriched flour, water, vegetable shortening, salt").flagged.some((f) => f.id === "vegoil") &&
        sanitizeOffFoodNutrition("Mission Flour Tortillas", { sodiumMg100g: 12500 }, { sodium_100g: 12.5 }).sodiumMg100g === undefined &&
        sanitizeOffFoodNutrition("Mission Flour Tortillas", { sodiumMg100g: 12500 }, { sodium_100g: 12.5, salt_100g: 2.1 }).sodiumMg100g === 840 &&
        sanitizeOffFoodNutrition("Morton Fine Sea Salt", { sodiumMg100g: 39000 }, { sodium_100g: 39 }).sodiumMg100g === 39000 &&
        latestToolsClientSrc.includes('gridTemplateColumns: "minmax(0, 1fr)"') &&
        latestToolsClientSrc.includes('overflowWrap: "anywhere"') &&
        latestToolsClientSrc.includes('whiteSpace: "nowrap"') &&
        latestSwapsSlugSrc.includes('gridTemplateColumns: "minmax(0, 1fr)"')
    )
  );

  check(
    "Superhero Cape Mascot ('100% FAMILY OWNED'), Original Horizontal Online Cart Swap Board & Above-the-Fold Online Grocery Shopping Hero: transparent cape mascot crest, zero tilted Yuka cards, and instant Online Pickup/Delivery + In-Store Camera modes",
    Boolean(
      fs.existsSync("public/broc-mascot-cape.png") &&
        healthyScenerySrc.includes("/broc-mascot-cape.png") &&
        healthyScenerySrc.includes("100% FAMILY OWNED") &&
        !healthyScenerySrc.includes("100% INDEPENDENT") &&
        !healthyScenerySrc.includes("yuka-cloud") &&
        !healthyScenerySrc.includes("yuka-tilt-card") &&
        healthyScenerySrc.includes("broc-swap-board") &&
        healthyScenerySrc.includes("1-TAP ONLINE CART UPGRADES") &&
        independencePageSrc.includes("/broc-mascot-cape.png") &&
        independencePageSrc.includes("100% FAMILY OWNED") &&
        finalSimSrc.includes('id="hero-online-shopping-pill"') &&
        finalSimSrc.includes("BUILT FOR ONLINE GROCERY SHOPPING") &&
        finalSimSrc.includes("Know what&apos;s hiding in your online grocery cart.") &&
        finalSimSrc.includes('id="hero-mode-online"') &&
        finalSimSrc.includes('id="hero-mode-camera"') &&
        !latestGlobalsCssSrc.includes("rotate(-3.5deg)") &&
        latestGlobalsCssSrc.includes(".broc-family-crest") &&
        latestGlobalsCssSrc.includes(".broc-swap-board") &&
        latestGlobalsCssSrc.includes(".hero-shopping-modes")
    )
  );

  const {
    canonicalizeGroceryQuery,
    cacheKey,
    mergeBrandAndTitle,
    relevance,
  } = await import("../lib/lookup");

  check(
    "Universal Brand-Order & Punctuation Canonicalization: '<Food> <Brand>' and apostrophe/hyphen shorthands share identical canonical query and cacheKey while preserving leading Diet/Mexican/GHOST modifiers",
    Boolean(
      cacheKey({ productTitle: "Flour tortillas mission" }) === cacheKey({ productTitle: "Mission Flour tortillas" }) &&
        cacheKey({ productTitle: "Strawberry jam smuckers" }) === cacheKey({ productTitle: "Smucker's strawberry jam" }) &&
        cacheKey({ productTitle: "Pizza rolls totinos" }) === cacheKey({ productTitle: "Totino's pizza rolls" }) &&
        cacheKey({ productTitle: "Crackers cheez it" }) === cacheKey({ productTitle: "Cheez-It crackers" }) &&
        cacheKey({ productTitle: "Classic cola coca" }) === cacheKey({ productTitle: "Coca-Cola classic" }) &&
        canonicalizeGroceryQuery("Diet Coke") === "Diet Coke" &&
        canonicalizeGroceryQuery("Mexican Coca-Cola") === "Mexican Coca-Cola" &&
        canonicalizeGroceryQuery("GHOST Legend Swedish Fish Pre-Workout") === "GHOST Legend Swedish Fish Pre-Workout" &&
        mergeBrandAndTitle("Kellogg's Eggo", "Eggo Homestyle Waffles") === "Kellogg's Eggo Homestyle Waffles"
    )
  );

  const eggoA = await lookupIngredients({ productTitle: "Eggo waffles" });
  const eggoB = await lookupIngredients({ productTitle: "Waffles Eggo" });
  const phillyA = await lookupIngredients({ productTitle: "Philadelphia cream cheese" });
  const phillyB = await lookupIngredients({ productTitle: "Cream cheese Philadelphia" });
  const totinosOffline = await lookupIngredients({ productTitle: "Totino's pizza rolls" });
  check(
    "Universal Relevance, Spin-Off & Representative-Hijack Guards: Prego rejects pesto/en:pestos, Quaker oats rejects oat flour, Oscar Mayer hot dogs matches wieners, Eggo/Philadelphia resolve symmetrically without brand duplication, and Totino's never receives chicken-bacon Representative Category Formulation",
    Boolean(
      relevance("Prego traditional pasta sauce", "Prego Basil Pesto") === 0 &&
        relevance("Prego traditional pasta sauce", "Prego Pasta Sauce", ["en:pestos"]) === 0 &&
        relevance("Prego traditional pasta sauce", "Prego Traditional", ["en:pasta-sauces"]) >= 0.7 &&
        relevance("Quaker oats", "Quaker Oat Flour") === 0 &&
        relevance("Quaker oats", "Quaker Oats 100% Whole Grain Oats Old Fashioned") >= 0.85 &&
        relevance("Smucker's strawberry jam", "Smucker's Peanut butter & strawberry jam sandwich soft bread") === 0 &&
        relevance("Oscar Mayer hot dogs", "Oscar Mayer Classic Uncured Wieners") >= 0.85 &&
        passesVariantGuard("strawberries", "Organic Strawberries") &&
        passesVariantGuard("strawberry jam", "Seedless Strawberries Jam") &&
        eggoA?.productTitle === "Kellogg's Eggo Homestyle Waffles" &&
        eggoB?.productTitle === "Kellogg's Eggo Homestyle Waffles" &&
        phillyA?.productTitle === "Philadelphia Original Cream Cheese" &&
        phillyB?.productTitle === "Philadelphia Original Cream Cheese" &&
        totinosOffline === null
    )
  );

  const prevFetchForCoBrand = globalThis.fetch;
  globalThis.fetch = async (urlInput: RequestInfo | URL) => {
    const url = String(urlInput);
    if (url.includes("api.nal.usda.gov")) {
      return Response.json({
        foods: [
          {
            fdcId: 999001,
            brandName: "Herr's",
            brandOwner: "Herr Foods Inc.",
            description: "Potato Chips, Heinz Ketchup",
            dataType: "Branded",
            ingredients: "POTATOES, VEGETABLE OIL, HEINZ KETCHUP SEASONING.",
            foodNutrients: [{ nutrientId: 1008, unitName: "KCAL", value: 536 }],
          },
        ],
      });
    }
    if (url.includes("search.openfoodfacts.org")) {
      return Response.json({
        hits: [
          {
            code: "0051500000946",
            brands: ["Smuckers"],
            product_name: "Seedless Strawberry Jam",
            countries_tags: ["en:united-states"],
            states_tags: ["en:ingredients-completed"],
            categories_tags: ["en:jams"],
          },
          {
            code: "0051500040256",
            brands: ["Smucker's"],
            product_name: "Smucker's Strawberry Jam",
            countries_tags: ["en:united-states"],
            states_tags: ["en:ingredients-completed"],
            categories_tags: ["en:jams"],
          },
        ],
      });
    }
    if (url.includes("0051500000946")) {
      return Response.json({
        status: 1,
        product: {
          code: "0051500000946",
          brands: "Smuckers",
          product_name: "Seedless Strawberry Jam",
          countries_tags: ["en:united-states"],
          ingredients_text: "WATER, STRAWBERRIES, POLYDEXTROSE, FRUIT PECTIN, CITRIC ACID, SUCRALOSE, RED 40.",
          nutriments: { "energy-kcal_100g": 59, sugars_100g: 0, sodium_100g: 0 },
        },
      });
    }
    if (url.includes("0051500040256")) {
      return Response.json({
        status: 1,
        product: {
          code: "0051500040256",
          brands: "Smucker's",
          product_name: "Smucker's Strawberry Jam",
          countries_tags: ["en:united-states"],
          ingredients_text: "STRAWBERRIES, HIGH FRUCTOSE CORN SYRUP, CORN SYRUP, SUGAR, FRUIT PECTIN, CITRIC ACID.",
          nutriments: { "energy-kcal_100g": 250, sugars_100g: 60, sodium_100g: 0 },
        },
      });
    }
    return Response.json({ status: 0, hits: [], products: [], foods: [] });
  };
  const heinzCheck = await lookupIngredients({ productTitle: "Heinz ketchup" });
  const smuckersCheck = await lookupIngredients({ productTitle: "Strawberry jam smuckers" });
  globalThis.fetch = prevFetchForCoBrand;

  const doughConditionerPizzaScore = scoreProductYuka(
    "Enriched wheat flour (wheat flour, niacin, reduced iron), water, mozzarella cheese (part-skim milk, cheese culture, salt, enzymes), pepperoni (pork, beef, salt, sodium nitrite, bha, bht), tomato paste, soybean oil, sugar, salt, ascorbic acid (dough conditioner).",
    {},
    [],
    {
      productTitle: "DiGiorno Rising Crust Pepperoni Frozen Pizza",
      caloriesKcal100g: 231,
      sugarsG100g: 4.6,
      saturatedFatG100g: 3.8,
      sodiumMg100g: 577,
      fiberG100g: 0.8,
      proteinG100g: 11.5,
      productKind: "food",
    }
  );
  const corruptZeroMacroCookieScore = scoreProductYuka(
    "WHEAT flour, sugar, vegetable oils (palm, palm kernel), cocoa, leavening, soy lecithin, salt, natural flavor.",
    {},
    [],
    {
      productTitle: "Chocolate Sandwich Cookies",
      caloriesKcal100g: 0,
      sugarsG100g: 0,
      saturatedFatG100g: 0,
      sodiumMg100g: 150,
      productKind: "food",
    }
  );

  check(
    "Co-Branded Hijack, Unlabelled Sugar-Free Jam, Dough-Conditioner Non-Food & Zero-Macro Cookie Guards: Heinz rejects Herr's ketchup chips, Smucker's skips unlabelled 0g-sugar Sucralose jam, dough conditioner never zeroes pizza to N/A, and 0-kcal cookie records never score Nutri-Score A",
    Boolean(
      heinzCheck === null &&
        smuckersCheck &&
        smuckersCheck.barcode === "0051500040256" &&
        doughConditionerPizzaScore.score > 0 &&
        doughConditionerPizzaScore.yukaBreakdown?.nutriScoreGrade !== "N/A" &&
        corruptZeroMacroCookieScore.score < 45 &&
        corruptZeroMacroCookieScore.yukaBreakdown?.nutriScoreGrade !== "A"
    )
  );

  const authModalIosSrc = fs.readFileSync("components/AuthModal.tsx", "utf8");
  const funnelCompactSrc = fs.readFileSync("components/WatchlistMiniFunnel.tsx", "utf8");
  const appleVerifyRouteMod = await import("../app/api/apple/verify/route");
  const forgedJwsRes = await appleVerifyRouteMod.POST(
    new Request("http://localhost:3000/api/apple/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signedTransactionInfo: "eyJhbGciOiJFUzI1NiIsIng1YyI6W119.eyJidW5kbGVJZCI6ImNvbS5oZXlicm9jLmFwcCJ9.c2ln",
        deviceId: "ios-app-rubric-test",
      }),
    })
  );
  const simPostIosFixSrc = fs.readFileSync("components/Simulator.tsx", "utf8");
  const vcPostIosFixSrc = fs.readFileSync("ios-app/App/ViewController.swift", "utf8");
  const authLibPostIosFixSrc = fs.readFileSync("lib/auth.ts", "utf8");
  const globalsCssPostIosSrc = fs.readFileSync("app/globals.css", "utf8");
  const safariManifestSrc = fs.readFileSync("ios-app/SafariExtension/Resources/manifest.json", "utf8");
  const shareExtPlistUpdatedSrc = fs.readFileSync("ios-app/ShareExtension/Info.plist", "utf8");
  const liveBrowserUpdatedSrc = fs.readFileSync("ios-app/App/LiveStoreBrowserViewController.swift", "utf8");

  check(
    "iOS TestFlight Onboarding, Sign in with Apple & StoreKit 2 Suite: zero-scroll 7-step grids + pinned footer, Sign Up / Sign In tabs + Continue with Apple under Google, StoreKit 2 native sheet + Root CA G3 JWS verification, ITMS-90695 emoji-free CFBundleDisplayName, 1-tap Safari All Websites Allow, and Universal-Link guard",
    Boolean(
      authModalIosSrc.includes('id="auth-apple-btn"') &&
        authModalIosSrc.includes("Continue with Apple") &&
        authModalIosSrc.includes('id="auth-tab-signup"') &&
        authModalIosSrc.includes('id="auth-tab-signin"') &&
        authModalIosSrc.includes("__heybrocNativeAppleAuth") &&
        funnelCompactSrc.includes("calc(100dvh - 20px)") &&
        funnelCompactSrc.includes("repeat(2, minmax(0, 1fr))") &&
        funnelCompactSrc.includes("repeat(3, minmax(0, 1fr))") &&
        vcPostIosFixSrc.includes("import AuthenticationServices") &&
        vcPostIosFixSrc.includes("import StoreKit") &&
        vcPostIosFixSrc.includes("NativeProPaywallSheetViewController") &&
        vcPostIosFixSrc.includes("com.heybroc.pro.annual") &&
        vcPostIosFixSrc.includes("com.heybroc.pro.monthly") &&
        vcPostIosFixSrc.includes('"apple-sign-in"') &&
        vcPostIosFixSrc.includes('"upgrade-pro"') &&
        !vcPostIosFixSrc.includes("Tap ↑ Share") &&
        !shareExtPlistUpdatedSrc.includes("🥦") &&
        safariManifestSrc.includes('"*://*/*"') &&
        !safariManifestSrc.includes("CleanCart PureOverlay") &&
        !safariManifestSrc.includes("cleancart-teal.vercel.app") &&
        liveBrowserUpdatedSrc.includes("navigationType == .linkActivated") &&
        authLibPostIosFixSrc.includes('"com.heybroc.app"') &&
        authLibPostIosFixSrc.includes("user_apple_sub:") &&
        !simPostIosFixSrc.includes(
          "Pro membership is managed natively in the HeyBroc iOS app — sign in to sync an existing account."
        ) &&
        simPostIosFixSrc.includes("__HEYBROC_NATIVE_STOREKIT__") &&
        simPostIosFixSrc.includes("__heybrocNativeProUnlocked") &&
        !globalsCssPostIosSrc.includes(".topbar-btn--signin { max-width: 100px; }") &&
        globalsCssPostIosSrc.includes("max-width: none;") &&
        (forgedJwsRes.status === 400 || forgedJwsRes.status === 401)
    )
  );

  // ==================== 48-HOUR AUDIT REGRESSION SUITE (P0 #1–#2, P1 #3–#9, P2 #10–#17) ====================
  {
    const cryptoMod = await import("node:crypto");
    const lookupMod = await import("../lib/lookup");
    const labelReportMod = await import("../app/api/label-report/route");
    const appleRetentionMod = await import("../app/api/apple/retention/route");

    const prevFetch48h = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ status: 0, hits: [], products: [], foods: [] });

    // P0 #1: Catalog identity guard, canonical productTitle, and Maruchan Chicken Flavor retitle
    const p0CatalogRejectQueries = [
      "Campbell's tomato soup",
      "Butterball turkey bacon",
      "Hershey's chocolate syrup",
      "Breyers Oreo ice cream",
      "Panera mac and cheese",
      "Velveeta shells and cheese",
      "Lactaid ice cream",
      "Gatorade protein bar",
      "Flamin Hot Cheetos",
      "Oreo Double Stuf",
    ];
    const p0CatalogRejectResults = await Promise.all(
      p0CatalogRejectQueries.map((productTitle) => lookupMod.lookupIngredients({ productTitle }))
    );
    const maruchanEntry = lookupMod.INSTANT_GROCERY_CATALOG.find((e) => e.brand === "Maruchan");
    const maruchanChickenHit = await lookupMod.lookupIngredients({ productTitle: "Maruchan chicken ramen" });
    const maruchanBeefHit = await lookupMod.lookupIngredients({ productTitle: "Maruchan beef ramen" });
    const oreoFamilyHit = await lookupMod.lookupIngredients({
      productTitle: "OREO Chocolate Sandwich Cookies, Family Size, 18.12 oz",
    });
    const campbellsCanHit = await lookupMod.lookupIngredients({
      productTitle: "Campbell's Condensed Chicken Noodle Soup, 10.75 oz Can",
    });
    const cokeShortHit = await lookupMod.lookupIngredients({ productTitle: "Coke" });
    const monsterShortHit = await lookupMod.lookupIngredients({ productTitle: "Monster Energy" });

    check(
      "P0 #1: catalogFallback identity guard rejects mismatched flavors/forms/brands, retitles Maruchan to Chicken Flavor, and resolves canonical product titles without echoing query pack noise",
      Boolean(
        p0CatalogRejectResults.every((r) => r === null) &&
          maruchanEntry?.title === "Maruchan Ramen Noodle Soup Chicken Flavor" &&
          maruchanChickenHit?.productTitle === "Maruchan Ramen Noodle Soup Chicken Flavor" &&
          maruchanBeefHit === null &&
          oreoFamilyHit?.source === "catalog" &&
          !/18\.12\s*oz/i.test(oreoFamilyHit.productTitle) &&
          campbellsCanHit?.source === "catalog" &&
          !/10\.75\s*oz/i.test(campbellsCanHit.productTitle) &&
          cokeShortHit?.source === "catalog" &&
          /coca-cola/i.test(cokeShortHit.productTitle) &&
          monsterShortHit?.source === "catalog" &&
          /monster\s+energy/i.test(monsterShortHit.productTitle)
      )
    );

    // P0 #2: Whole-food head-noun guard, baby-food brand guard, and processed-food guard
    const p0WholeFoodRejectQueries = [
      "banana bread",
      "banana pudding",
      "banana milk",
      "Gerber banana baby food",
      "honeycrisp apple cider",
      "orange chicken",
      "garlic powder",
      "cashew milk",
      "salmon burgers",
      "garlic herb salmon",
    ];
    const p0WholeFoodRejectResults = await Promise.all(
      p0WholeFoodRejectQueries.map((productTitle) => lookupMod.lookupIngredients({ productTitle }))
    );
    const p0WholeFoodResolveQueries = [
      "Bananas, each",
      "Honeycrisp Apples, 3 lb Bag",
      "Organic Rainbow Chard Bunch",
      "Boneless Skinless Chicken Breasts, 4.7-6.1 lb Tray",
      "Fresh Atlantic Salmon Fillet",
      "Raw Almonds",
    ];
    const p0WholeFoodResolveResults = await Promise.all(
      p0WholeFoodResolveQueries.map((productTitle) => lookupMod.lookupIngredients({ productTitle }))
    );

    check(
      "P0 #2: Whole-food fallbacks reject prepared/flavored/baby foods and resolve fresh head-noun produce, meat, seafood, and nuts",
      Boolean(
        p0WholeFoodRejectResults.every((r) => r?.nutrition?.isWholeFood !== true && r === null) &&
          p0WholeFoodResolveResults.every((r) => r?.nutrition?.isWholeFood === true)
      )
    );

    // P1 #3: Short brand tokens, single-letter compounds, and store brands
    const pb365Hit = await lookupMod.lookupIngredients({ productTitle: "365 organic creamy peanut butter" });
    const a1SauceHit = await lookupMod.lookupIngredients({ productTitle: "A1 steak sauce" });
    const wegmansPbHit = await lookupMod.lookupIngredients({ productTitle: "Wegmans creamy peanut butter" });
    const hebPbHit = await lookupMod.lookupIngredients({ productTitle: "H-E-B creamy peanut butter" });

    check(
      "P1 #3: tokens() preserves short brand codes ('365', 'rx', 'a1') and single-letter compounds ('mandm', 'hic', 'jello', 'heb') and blocks store-brand hijacks",
      Boolean(
        lookupMod.tokens("365 organic creamy peanut butter").includes("365") &&
          lookupMod.tokens("RX protein bar").includes("rx") &&
          lookupMod.tokens("A1 steak sauce").includes("a1") &&
          lookupMod.tokens("A.1. steak sauce").includes("a1") &&
          lookupMod.tokens("M&M's")[0] === "mandm" &&
          lookupMod.tokens("Hi-C")[0] === "hic" &&
          lookupMod.tokens("Jell-O")[0] === "jello" &&
          lookupMod.tokens("H-E-B")[0] === "heb" &&
          pb365Hit === null &&
          wegmansPbHit === null &&
          hebPbHit === null &&
          !/great\s+value/i.test(a1SauceHit?.productTitle ?? "")
      )
    );

    // P1 #4: Common-word brand negative lookaheads (monster trail mix, ghost pepper salsa)
    const monsterTrailDrink = matchDrinkCatalog("monster trail mix");
    const monsterTrailLookup = await lookupMod.lookupIngredients({ productTitle: "monster trail mix" });
    const ghostPepperSalsaLookup = await lookupMod.lookupIngredients({ productTitle: "ghost pepper salsa" });

    check(
      "P1 #4: Common-word brand lookaheads prevent 'monster trail mix' from matching Monster Energy and allow 'ghost pepper salsa' to resolve",
      Boolean(
        monsterTrailDrink === null &&
          !/monster\s+energy/i.test(monsterTrailLookup?.productTitle ?? "") &&
          ghostPepperSalsaLookup !== null &&
          /salsa/i.test(ghostPepperSalsaLookup.productTitle)
      )
    );

    // P1 #5: isBeverage solid-base veto and solid title exclusions
    const ribeyeYuka = scoreProductYuka("Beef.", {}, [], { productTitle: "USDA Prime Ribeye Steak" });
    const bolthouseCarrotsYuka = scoreProductYuka("Carrots.", {}, [], {
      productTitle: "Bolthouse Farms Baby Carrots",
    });
    const craisinsYuka = scoreProductYuka("Cranberries, Sugar.", {}, [], {
      productTitle: "Ocean Spray Craisins",
      caloriesKcal100g: 325,
      sugarsG100g: 72.5,
      fiberG100g: 7.5,
    });

    check(
      "P1 #5: isBeverage solid-base veto keeps steaks, Bolthouse Farms carrots, and Ocean Spray Craisins on solid-food thresholds",
      Boolean(ribeyeYuka.score === 90 && bolthouseCarrotsYuka.score === 90 && craisinsYuka.score > 50)
    );

    // P1 #6: offToResult & usdaSearch single-ingredient branded whole foods match generic whole-food score
    const genericRibeyeHit = await lookupMod.lookupIngredients({ productTitle: "ribeye steak" });
    const genericRibeyeScore = scoreProductYuka(genericRibeyeHit!.ingredients, {}, [], {
      ...genericRibeyeHit!.nutrition,
      productTitle: genericRibeyeHit!.productTitle,
    });
    const kirklandOffHit = lookupMod.offToResult(
      {
        product_name: "USDA Choice Beef Ribeye Steak",
        brands: "Kirkland Signature",
        ingredients_text: "Beef.",
        nutriments: {
          "energy-kcal_100g": 291,
          "saturated-fat_100g": 10.6,
          proteins_100g: 24,
          sodium_100g: 0.054,
        },
      },
      "Kirkland Signature Ribeye Steak"
    );
    const kirklandOffScore = scoreProductYuka(kirklandOffHit.ingredients, {}, [], {
      ...kirklandOffHit.nutrition,
      productTitle: kirklandOffHit.productTitle,
    });

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.nal.usda.gov")) {
        return Response.json({
          foods: [
            {
              fdcId: 999111,
              dataType: "Branded",
              brandOwner: "Kirkland Signature",
              description: "USDA CHOICE RIBEYE STEAK",
              ingredients: "BEEF.",
              foodNutrients: [
                { nutrientName: "Energy", unitName: "KCAL", value: 291 },
                { nutrientName: "Fatty acids, total saturated", unitName: "G", value: 10.6 },
                { nutrientName: "Protein", unitName: "G", value: 24 },
                { nutrientName: "Sodium, Na", unitName: "MG", value: 54 },
              ],
            },
          ],
        });
      }
      return Response.json({ status: 0, hits: [], products: [], foods: [] });
    };
    const kirklandUsdaHit = await lookupMod.lookupIngredients({
      productTitle: "Kirkland Signature USDA Choice Ribeye Steak",
    });
    const kirklandUsdaScore = kirklandUsdaHit
      ? scoreProductYuka(kirklandUsdaHit.ingredients, {}, [], {
          ...kirklandUsdaHit.nutrition,
          productTitle: kirklandUsdaHit.productTitle,
        })
      : null;
    globalThis.fetch = async () => Response.json({ status: 0, hits: [], products: [], foods: [] });

    check(
      "P1 #6: offToResult and usdaSearch set isWholeFood on single-ingredient branded whole foods so Kirkland 'Beef.' matches generic 'ribeye steak' (90)",
      Boolean(
        kirklandOffHit.nutrition?.isWholeFood === true &&
          kirklandOffScore.score === genericRibeyeScore.score &&
          kirklandUsdaHit?.nutrition?.isWholeFood === true &&
          kirklandUsdaScore?.score === genericRibeyeScore.score
      )
    );

    // P1 #7: passesVariantGuard forward checks for low-sodium, keto, low-carb, low-fat, and light/lite
    const lowSodSoupHit = await lookupMod.lookupIngredients({
      productTitle: "Campbell's low sodium chicken noodle soup",
    });
    const lightMayoHit = await lookupMod.lookupIngredients({ productTitle: "Hellmann's light mayo" });
    const ketoBreadHit = await lookupMod.lookupIngredients({ productTitle: "Nature's Own keto bread" });

    check(
      "P1 #7: passesVariantGuard blocks unfulfilled low-sodium, keto, low-carb, low-fat, and light/lite modifiers while allowing light roast/tuna/brown/corn",
      Boolean(
        !passesVariantGuard("Campbell's low sodium chicken noodle soup", "Campbell's Chicken Noodle Soup") &&
          !passesVariantGuard("Campbell's no salt added tomato soup", "Campbell's Tomato Soup") &&
          !passesVariantGuard("Hellmann's light mayo", "Hellmann's Real Mayonnaise") &&
          !passesVariantGuard("Nature's Own keto bread", "Nature's Own Honey Wheat Bread") &&
          !passesVariantGuard("Mission low carb tortillas", "Mission Soft Taco Flour Tortillas") &&
          !passesVariantGuard("Daisy low fat cottage cheese", "Daisy Cottage Cheese") &&
          passesVariantGuard("Starbucks Light Roast Ground Coffee", "Starbucks Ground Coffee") &&
          passesVariantGuard("StarKist Chunk Light Tuna", "StarKist Tuna") &&
          passesVariantGuard("Domino Light Brown Sugar", "Domino Brown Sugar") &&
          passesVariantGuard("Karo Light Corn Syrup", "Karo Corn Syrup") &&
          lowSodSoupHit === null &&
          lightMayoHit === null &&
          ketoBreadHit === null
      )
    );

    // P1 #8: Category fallback checks cat.brand without query self-echo
    const kiteHillDairyFreeHit = await lookupMod.lookupIngredients({
      productTitle: "dairy free yogurt Kite Hill",
    });
    check(
      "P1 #8: Category fallback rejects 'dairy free yogurt Kite Hill' instead of returning a cow's-milk yogurt estimate",
      kiteHillDairyFreeHit === null
    );

    // P1 #9: WatchlistMiniFunnel glyphosate vs. cancer maps qualifier and attribution
    check(
      "P1 #9: WatchlistMiniFunnel removes 'Same Bullseye', attributes Iowa Cancer Registry, and states correlation/EPA-vs-IARC qualifier",
      Boolean(
        !funnelCompactSrc.includes("Same Bullseye") &&
          funnelCompactSrc.includes("Iowa Cancer Registry") &&
          funnelCompactSrc.includes(
            "Maps show where each is reported, not that one causes the other; EPA and IARC disagree on glyphosate's cancer risk."
          )
      )
    );

    // P2 #10: relevance() form-factor penalty vs reject, 'hot sauce' handling, variety-pack rejection, and leading modifiers
    check(
      "P2 #10: relevance() allows brand-only queries against form-factor titles, allows Cholula vs Hot Sauce, allows leading 'vegan', and rejects unrequested form swaps & variety packs",
      Boolean(
        lookupMod.relevance("Old Bay", "Old Bay Seasoning") > 0 &&
          lookupMod.relevance("Tajin", "Tajin Clasico Seasoning") > 0 &&
          lookupMod.relevance("Frosted Flakes", "Kellogg's Frosted Flakes Cereal") > 0 &&
          lookupMod.relevance("Mrs. Butterworth's original", "Mrs. Butterworth's Original Syrup") > 0 &&
          lookupMod.relevance("Coffee mate french vanilla", "Coffee mate French Vanilla Creamer") > 0 &&
          lookupMod.relevance("Cholula", "Cholula Original Hot Sauce") > 0 &&
          lookupMod.relevance("vegan Hu dark chocolate", "Hu Salty Dark Chocolate Bar") > 0 &&
          lookupMod.relevance("Oatmeal Creme Pies", "Oatmeal Creme Pies Cereal") === 0 &&
          lookupMod.relevance("Pringles", "Pringles Snack Stacks Variety Pack") === 0 &&
          lookupMod.relevance("Quaker instant oatmeal", "Quaker Instant Oatmeal Flavor Variety Pack") === 0
      )
    );

    // P2 #11: isDietaryOrVariantMismatch ignores plant-qualified milk/cream/butter phrases
    check(
      "P2 #11: isDietaryOrVariantMismatch allows cocoa butter, almond milk, coconut cream, and peanut butter on vegan/dairy-free queries while rejecting dairy milk",
      Boolean(
        !lookupMod.isDietaryOrVariantMismatch(
          "vegan dark chocolate",
          "Dark Chocolate Bar",
          "Organic Cacao, Organic Coconut Sugar, Organic Cocoa Butter"
        ) &&
          !lookupMod.isDietaryOrVariantMismatch(
            "dairy free smoothie",
            "Berry Smoothie",
            "Almond Milk, Coconut Cream, Peanut Butter, Strawberries"
          ) &&
          lookupMod.isDietaryOrVariantMismatch(
            "vegan dark chocolate",
            "Milk Chocolate Bar",
            "Sugar, Cocoa Butter, Whole Milk, Chocolate Liquor"
          )
      )
    );

    // P2 #12: matchesRequestedBrand supports legitimate co-branded queries
    check(
      "P2 #12: matchesRequestedBrand accepts co-branded 'Breyers Oreo cookies & cream ice cream' owned by Breyers while rejecting unrelated brand hijacks",
      Boolean(
        lookupMod.matchesRequestedBrand(
          "Breyers Oreo cookies & cream ice cream",
          "Breyers",
          "Breyers Oreo Cookies & Cream Ice Cream"
        ) &&
          !lookupMod.matchesRequestedBrand(
            "Heinz ketchup",
            "Herr's",
            "Herr's Heinz Ketchup Flavored Potato Chips"
          )
      )
    );

    // P2 #13: isNonFoodItem exempts brand-only collisions on measured food items
    const allegraPastaScore = scoreProductYuka(
      "Durum wheat semolina, niacin, iron, thiamine mononitrate, riboflavin, folic acid.",
      {},
      [],
      {
        productTitle: "Allegra Enriched Spaghetti",
        productKind: "food",
        caloriesKcal100g: 371,
        sugarsG100g: 3.5,
        fiberG100g: 3.2,
        proteinG100g: 13,
      }
    );
    const allegraTabletScore = scoreProductYuka("Active ingredient: Fexofenadine HCl 180 mg.", {}, [], {
      productTitle: "Allegra 24hr Allergy Tablets",
    });
    check(
      "P2 #13: Brand-only non-food collision ('Allegra') does not mark measured food pasta as non-food while OTC tablets remain N/A",
      Boolean(
        allegraPastaScore.score >= 80 &&
          allegraPastaScore.yukaBreakdown?.nutriScoreGrade !== "N/A" &&
          allegraTabletScore.yukaBreakdown?.nutriScoreGrade === "N/A"
      )
    );

    // P2 #14: Per-100g upper bounds, kJ-corroborated >905 conversion, and sweetener-first solid plausibility
    const offBounded = extractOffNutrition({
      nutriments: {
        "energy-kcal_100g": 2100,
        energy_100g: 2100,
        sugars_100g: 150,
        "saturated-fat_100g": 120,
        fiber_100g: 110,
        proteins_100g: 250,
        sodium_100g: 50,
      },
    });
    const offUncorroboratedKcal = extractOffNutrition({ nutriments: { "energy-kcal_100g": 2100 } });
    const offImpossibleKcal = extractOffNutrition({ nutriments: { "energy-kcal_100g": 5000, energy_100g: 5000 } });
    const usdaBounded = extractUsdaNutrition({
      foodNutrients: [
        { nutrientName: "Energy", unitName: "KCAL", value: 2100 },
        { nutrientName: "Energy", unitName: "KJ", value: 2100 },
        { nutrientName: "Total Sugars", unitName: "G", value: 150 },
        { nutrientName: "Protein", unitName: "G", value: 250 },
        { nutrientName: "Sodium, Na", unitName: "MG", value: 50000 },
      ],
    });
    const usdaUncorroboratedKcal = extractUsdaNutrition({
      foodNutrients: [{ nutrientName: "Energy", unitName: "KCAL", value: 2100 }],
    });
    const candyImpossibleZero = scoreProductYuka("Sugar, Corn Syrup, Citric Acid.", {}, [], {
      productTitle: "Fruit Hard Candy",
      productKind: "food",
      caloriesKcal100g: 0,
      sugarsG100g: 0,
    });
    const candyUnmeasured = scoreProductYuka("Sugar, Corn Syrup, Citric Acid.", {}, [], {
      productTitle: "Fruit Hard Candy",
      productKind: "food",
    });
    check(
      "P2 #14: extractOffNutrition/extractUsdaNutrition convert >905 energy only when corroborated by kJ, drop uncorroborated >905 kcal & >100g/>40000mg outliers, and sweetener-first solids ignore impossible <15 kcal / <1g sugar",
      Boolean(
        offBounded.caloriesKcal100g !== undefined &&
          Math.round(offBounded.caloriesKcal100g) === 502 &&
          offUncorroboratedKcal.caloriesKcal100g === undefined &&
          offBounded.sugarsG100g === undefined &&
          offBounded.saturatedFatG100g === undefined &&
          offBounded.fiberG100g === undefined &&
          offBounded.proteinG100g === undefined &&
          offBounded.sodiumMg100g === undefined &&
          offImpossibleKcal.caloriesKcal100g === undefined &&
          usdaBounded.caloriesKcal100g !== undefined &&
          Math.round(usdaBounded.caloriesKcal100g) === 502 &&
          usdaUncorroboratedKcal.caloriesKcal100g === undefined &&
          usdaBounded.sugarsG100g === undefined &&
          usdaBounded.proteinG100g === undefined &&
          usdaBounded.sodiumMg100g === undefined &&
          candyImpossibleZero.score === candyUnmeasured.score &&
          candyImpossibleZero.score < 40
      )
    );

    // P2 #15: POST /api/label-report safe coercion, GTIN validation, and allowlist/length caps
    const labelReportRes = await labelReportMod.POST(
      new Request("http://localhost:3000/api/label-report", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.77.66" },
        body: JSON.stringify({
          productTitle: "T".repeat(500),
          brand: 98765,
          barcode: "00-12345-67890-5",
          store: "untrusted-store-xyz",
          currentIngredients: "C".repeat(8500),
          reportedIngredients: "Water, " + "R".repeat(8500),
          issueType: "I".repeat(100),
          familyWatchlist: "invalid-non-array",
          dietaryWatchlist: Array.from({ length: 40 }, (_, idx) => `diet_${idx}`),
        }),
      })
    );
    const labelReportJson = (await labelReportRes.json()) as {
      ok?: boolean;
      report?: {
        productTitle?: string;
        brand?: string;
        barcode?: string;
        store?: string;
        previousIngredients?: string;
        verifiedIngredients?: string;
        issueType?: string;
      };
    };
    const invalidOverlongBarcodeRes = await labelReportMod.POST(
      new Request("http://localhost:3000/api/label-report", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.77.67" },
        body: JSON.stringify({
          productTitle: "Test Cereal",
          barcode: "0012-3456-7890-1234-9999",
          reportedIngredients: "Whole Grain Oats, Sugar, Salt.",
        }),
      })
    );
    check(
      "P2 #15: POST /api/label-report coerces non-string inputs without throwing, validates GTIN check digits (400 on invalid/overlong), and enforces store/issueType allowlists & caps",
      Boolean(
        labelReportRes.status === 200 &&
          labelReportJson.ok === true &&
          (labelReportJson.report?.productTitle?.length ?? 999) <= 300 &&
          labelReportJson.report?.brand === "98765" &&
          labelReportJson.report?.barcode === "0012345678905" &&
          labelReportJson.report?.store === "walmart" &&
          (labelReportJson.report?.previousIngredients?.length ?? 9999) <= 6000 &&
          (labelReportJson.report?.verifiedIngredients?.length ?? 9999) <= 6000 &&
          labelReportJson.report?.issueType === "reformulated" &&
          invalidOverlongBarcodeRes.status === 400
      )
    );

    // P2 #16: POST /api/apple/retention X.509 x5c chain verification and mandatory root CA fingerprint pinning
    const derLen = (len: number): Buffer => {
      if (len < 0x80) return Buffer.from([len]);
      const hex = len.toString(16).padStart(len > 0xff ? 4 : 2, "0");
      const bytes = Buffer.from(hex, "hex");
      return Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes]);
    };
    const derTlv = (tag: number, content: Buffer): Buffer =>
      Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
    const derSeq = (...items: Buffer[]): Buffer => derTlv(0x30, Buffer.concat(items));
    const derSet = (...items: Buffer[]): Buffer => derTlv(0x31, Buffer.concat(items));
    const derOid = (bytes: number[]): Buffer => derTlv(0x06, Buffer.from(bytes));
    const derUtf8 = (s: string): Buffer => derTlv(0x0c, Buffer.from(s, "utf8"));
    const derUtcTime = (d: Date): Buffer =>
      derTlv(
        0x17,
        Buffer.from(
          d
            .toISOString()
            .slice(2)
            .replace(/[-:T]/g, "")
            .replace(/\.\d{3}Z$/, "Z"),
          "ascii"
        )
      );
    const derName = (cn: string): Buffer =>
      derSeq(derSet(derSeq(derOid([0x55, 0x04, 0x03]), derUtf8(cn))));
    const buildTestX509Der = (opts: {
      serial: number;
      issuerCn: string;
      subjectCn: string;
      subjectPubKey: import("node:crypto").KeyObject;
      issuerPrivKey: import("node:crypto").KeyObject;
      notBefore: Date;
      notAfter: Date;
      isCa: boolean;
      sigHash?: "sha256" | "sha384";
    }): Buffer => {
      const sigAlg =
        opts.sigHash === "sha384"
          ? derSeq(derOid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03]))
          : derSeq(derOid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
      const version = derTlv(0xa0, derTlv(0x02, Buffer.from([0x02])));
      const serial = derTlv(0x02, Buffer.from([opts.serial]));
      const validity = derSeq(derUtcTime(opts.notBefore), derUtcTime(opts.notAfter));
      const spki = opts.subjectPubKey.export({ type: "spki", format: "der" }) as Buffer;
      const bcVal = opts.isCa ? derSeq(derTlv(0x01, Buffer.from([0xff]))) : derSeq();
      const bcExt = derSeq(
        derOid([0x55, 0x1d, 0x13]),
        derTlv(0x01, Buffer.from([0xff])),
        derTlv(0x04, bcVal)
      );
      const exts = derTlv(0xa3, derSeq(bcExt));
      const tbs = derSeq(
        version,
        serial,
        sigAlg,
        derName(opts.issuerCn),
        validity,
        derName(opts.subjectCn),
        spki,
        exts
      );
      const sig = cryptoMod.sign(opts.sigHash || "sha256", tbs, opts.issuerPrivKey);
      return derSeq(tbs, sigAlg, derTlv(0x03, Buffer.concat([Buffer.from([0x00]), sig])));
    };

    const certNow = new Date();
    const certNb = new Date(certNow.getTime() - 3600_000);
    const certNa = new Date(certNow.getTime() + 86_400_000);
    const rootKp = cryptoMod.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const intKp = cryptoMod.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const leafKp = cryptoMod.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const rootDer = buildTestX509Der({
      serial: 1,
      issuerCn: "Apple Root CA - G3",
      subjectCn: "Apple Root CA - G3",
      subjectPubKey: rootKp.publicKey,
      issuerPrivKey: rootKp.privateKey,
      notBefore: certNb,
      notAfter: certNa,
      isCa: true,
    });
    const intDer = buildTestX509Der({
      serial: 2,
      issuerCn: "Apple Root CA - G3",
      subjectCn: "Apple WWDR CA",
      subjectPubKey: intKp.publicKey,
      issuerPrivKey: rootKp.privateKey,
      notBefore: certNb,
      notAfter: certNa,
      isCa: true,
    });
    const leafDer = buildTestX509Der({
      serial: 3,
      issuerCn: "Apple WWDR CA",
      subjectCn: "App Store Retention Signing",
      subjectPubKey: leafKp.publicKey,
      issuerPrivKey: intKp.privateKey,
      notBefore: certNb,
      notAfter: certNa,
      isCa: false,
    });
    const fakeRootDer = buildTestX509Der({
      serial: 4,
      issuerCn: "Evil Root CA",
      subjectCn: "Evil Root CA",
      subjectPubKey: rootKp.publicKey,
      issuerPrivKey: rootKp.privateKey,
      notBefore: certNb,
      notAfter: certNa,
      isCa: true,
    });
    const selfSignedLeafNonCaDer = buildTestX509Der({
      serial: 5,
      issuerCn: "Apple Root CA - G3",
      subjectCn: "Apple Root CA - G3",
      subjectPubKey: leafKp.publicKey,
      issuerPrivKey: leafKp.privateKey,
      notBefore: certNb,
      notAfter: certNa,
      isCa: false,
    });
    const p384LeafKp = cryptoMod.generateKeyPairSync("ec", { namedCurve: "P-384" });
    const p384LeafDer = buildTestX509Der({
      serial: 6,
      issuerCn: "Apple WWDR CA",
      subjectCn: "App Store P384 Leaf",
      subjectPubKey: p384LeafKp.publicKey,
      issuerPrivKey: intKp.privateKey,
      notBefore: certNb,
      notAfter: certNa,
      isCa: false,
    });
    const rootX509 = new cryptoMod.X509Certificate(rootDer);

    const signRetentionJws = (
      x5cList?: string[],
      claimOverrides?: Record<string, unknown>,
      signingKey: import("node:crypto").KeyObject = leafKp.privateKey,
      sigHash: "sha256" | "sha384" = "sha256",
    ) => {
      const hdr = Buffer.from(
        JSON.stringify(x5cList ? { alg: "ES256", x5c: x5cList } : { alg: "ES256" })
      ).toString("base64url");
      const baseClaims: Record<string, unknown> = {
        originalTransactionId: "unknown_tx_x5c",
        productId: "com.heybroc.pro.annual",
        bundleId: "com.heybroc.app",
        signedDate: Date.now(),
        environment: "Sandbox",
        ...claimOverrides,
      };
      for (const [k, v] of Object.entries(baseClaims)) {
        if (v === undefined) delete baseClaims[k];
      }
      const pay = Buffer.from(JSON.stringify(baseClaims)).toString("base64url");
      const sig = cryptoMod
        .sign(sigHash, Buffer.from(`${hdr}.${pay}`, "utf8"), {
          key: signingKey,
          dsaEncoding: "ieee-p1363",
        })
        .toString("base64url");
      return `${hdr}.${pay}.${sig}`;
    };

    const prevReqX5cAudit = process.env.APPLE_RETENTION_REQUIRE_X5C;
    const prevRootShaAudit = process.env.APPLE_ROOT_CA_SHA256;
    const prevNodeEnvAudit = process.env.NODE_ENV;
    let unsignedStrictStatus = 0;
    let validX5cStatus = 0;
    let wrongPinStatus = 0;
    let nonAppleRootStatus = 0;
    let prodUnpinnedAppleCnStatus = 0;
    let repeatedLeafCaFalseStatus = 0;
    let p384LeafStatus = 0;
    let wrongBundleStatus = 0;
    let missingBundleStatus = 0;
    let staleSignedDateStatus = 0;
    let nullBodyStatus = 0;
    let nonStringSignedPayloadStatus = 0;
    try {
      delete process.env.APPLE_RETENTION_REQUIRE_X5C;
      delete process.env.APPLE_ROOT_CA_SHA256;

      nullBodyStatus = (
        await appleRetentionMod.POST(
          new Request("http://localhost:3000/api/apple/retention", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "null",
          })
        )
      ).status;

      nonStringSignedPayloadStatus = (
        await appleRetentionMod.POST(
          new Request("http://localhost:3000/api/apple/retention", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ signedPayload: 12345 }),
          })
        )
      ).status;

      unsignedStrictStatus = (
        await appleRetentionMod.POST(
          new Request("http://localhost:3000/api/apple/retention", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ signedPayload: signRetentionJws() }),
          })
        )
      ).status;

      // Production MUST reject a self-signed "Apple Root CA - G3" chain even if APPLE_ROOT_CA_SHA256 is unset or overridden
      Object.assign(process.env, { NODE_ENV: "production" });
      delete process.env.APPLE_ROOT_CA_SHA256;
      prodUnpinnedAppleCnStatus = (
        await appleRetentionMod.POST(
          new Request("http://localhost:3000/api/apple/retention", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              signedPayload: signRetentionJws([
                leafDer.toString("base64"),
                intDer.toString("base64"),
                rootDer.toString("base64"),
              ]),
            }),
          })
        )
      ).status;
      Object.assign(process.env, { NODE_ENV: "test" });

      process.env.APPLE_ROOT_CA_SHA256 = rootX509.fingerprint256;
      const validChainB64 = [
        leafDer.toString("base64"),
        intDer.toString("base64"),
        rootDer.toString("base64"),
      ];
      validX5cStatus = (
        await appleRetentionMod.POST(
          new Request("http://localhost:3000/api/apple/retention", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ signedPayload: signRetentionJws(validChainB64) }),
          })
        )
      ).status;

      wrongBundleStatus = (
        await appleRetentionMod.POST(
          new Request("http://localhost:3000/api/apple/retention", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              signedPayload: signRetentionJws(validChainB64, { bundleId: "com.attacker.spoof" }),
            }),
          })
        )
      ).status;

      missingBundleStatus = (
        await appleRetentionMod.POST(
          new Request("http://localhost:3000/api/apple/retention", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              signedPayload: signRetentionJws(validChainB64, { bundleId: undefined }),
            }),
          })
        )
      ).status;

      staleSignedDateStatus = (
        await appleRetentionMod.POST(
          new Request("http://localhost:3000/api/apple/retention", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              signedPayload: signRetentionJws(validChainB64, { signedDate: Date.now() - 48 * 3600_000 }),
            }),
          })
        )
      ).status;

      p384LeafStatus = (
        await appleRetentionMod.POST(
          new Request("http://localhost:3000/api/apple/retention", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              signedPayload: signRetentionJws(
                [p384LeafDer.toString("base64"), intDer.toString("base64"), rootDer.toString("base64")],
                undefined,
                p384LeafKp.privateKey,
                "sha256"
              ),
            }),
          })
        )
      ).status;

      const selfLeafX509 = new cryptoMod.X509Certificate(selfSignedLeafNonCaDer);
      process.env.APPLE_ROOT_CA_SHA256 = selfLeafX509.fingerprint256;
      const repeatedB64 = selfSignedLeafNonCaDer.toString("base64");
      repeatedLeafCaFalseStatus = (
        await appleRetentionMod.POST(
          new Request("http://localhost:3000/api/apple/retention", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              signedPayload: signRetentionJws([repeatedB64, repeatedB64, repeatedB64]),
            }),
          })
        )
      ).status;

      process.env.APPLE_ROOT_CA_SHA256 = "00".repeat(32);
      wrongPinStatus = (
        await appleRetentionMod.POST(
          new Request("http://localhost:3000/api/apple/retention", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ signedPayload: signRetentionJws(validChainB64) }),
          })
        )
      ).status;

      delete process.env.APPLE_ROOT_CA_SHA256;
      nonAppleRootStatus = (
        await appleRetentionMod.POST(
          new Request("http://localhost:3000/api/apple/retention", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              signedPayload: signRetentionJws([
                leafDer.toString("base64"),
                intDer.toString("base64"),
                fakeRootDer.toString("base64"),
              ]),
            }),
          })
        )
      ).status;
    } finally {
      Object.assign(process.env, { NODE_ENV: prevNodeEnvAudit || "test" });
      if (prevReqX5cAudit === undefined) delete process.env.APPLE_RETENTION_REQUIRE_X5C;
      else process.env.APPLE_RETENTION_REQUIRE_X5C = prevReqX5cAudit;
      if (prevRootShaAudit === undefined) delete process.env.APPLE_ROOT_CA_SHA256;
      else process.env.APPLE_ROOT_CA_SHA256 = prevRootShaAudit;
    }

    check(
      "P2 #16 + Post-Audit P0-1: POST /api/apple/retention enforces mandatory pinned Apple Root CA in production, CA Basic Constraints, P-256 curve, bundleId, signedDate freshness, and safe 400 body checks",
      Boolean(
        nullBodyStatus === 400 &&
          nonStringSignedPayloadStatus === 400 &&
          unsignedStrictStatus === 401 &&
          prodUnpinnedAppleCnStatus === 401 &&
          validX5cStatus === 200 &&
          wrongBundleStatus === 403 &&
          missingBundleStatus === 403 &&
          staleSignedDateStatus === 401 &&
          p384LeafStatus === 401 &&
          repeatedLeafCaFalseStatus === 401 &&
          wrongPinStatus === 401 &&
          nonAppleRootStatus === 401
      )
    );

    // P2 #17: offSearch emits possessive brands_tags OR clause ('trader-joe-s' OR 'trader-joes')
    const capturedOffUrls: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      capturedOffUrls.push(decodeURIComponent(url));
      return Response.json({ status: 0, hits: [], products: [], foods: [] });
    };
    await lookupMod.lookupIngredients({ productTitle: "Trader Joe's Crunchy Almond Butter" });
    globalThis.fetch = prevFetch48h;

    check(
      "P2 #17: offSearch queries both hyphenated and collapsed possessive brands_tags ('trader-joe-s' OR 'trader-joes')",
      capturedOffUrls.some((u) =>
        u.includes('(brands_tags:"trader-joe-s" OR brands_tags:"trader-joes")')
      )
    );

    // ==================== POST-2541d71 DUAL ADVERSARIAL AUDIT REGRESSION SUITE ====================
    const dietaryMod = await import("../lib/dietary");
    const scanMod = await import("../lib/scan");
    globalThis.fetch = async () => Response.json({ status: 0, hits: [], products: [], foods: [] });

    // 1. Consumer-safety dietary contradiction checks (title "-free" claims NEVER suppress actual ingredient allergens)
    const dairyContradictionAlerts = dietaryMod.evaluateDietaryAlerts(
      ["dairy"],
      "Dairy-Free Strawberry Yogurt",
      "Cultured Pasteurized Whole Milk, Cane Sugar, Whey Protein Concentrate, Pectin."
    );
    const dairyCleanPlantAlerts = dietaryMod.evaluateDietaryAlerts(
      ["dairy"],
      "Dairy-Free Strawberry Yogurt",
      "Coconut Milk, Strawberries, Tapioca Starch, Live Cultures; May Contain Milk."
    );
    const glutenContradictionAlerts = dietaryMod.evaluateDietaryAlerts(
      ["wheat_gluten"],
      "Gluten-Free Artisan Bread",
      "Water, Enriched Wheat Flour, Barley Malt, Yeast, Salt."
    );
    const sugarContradictionAlerts = dietaryMod.evaluateDietaryAlerts(
      ["sugar_diabetes"],
      "Sugar-Free Gummy Bears",
      "Corn Syrup, Sugar, Gelatin, Citric Acid."
    );

    check(
      "Post-Audit P0-2: evaluateDietaryAlerts & isDietaryOrVariantMismatch flag actual milk/wheat/sugar/salt contradictions even when productTitle claims '-free' or 'unsalted'",
      Boolean(
        dairyContradictionAlerts.some((a) => a.id === "dairy") &&
          dairyCleanPlantAlerts.length === 0 &&
          glutenContradictionAlerts.some((a) => a.id === "wheat_gluten") &&
          sugarContradictionAlerts.some((a) => a.id === "sugar_diabetes") &&
          lookupMod.isDietaryOrVariantMismatch(
            "gluten free bread",
            "Gluten-Free Bread",
            "Water, Enriched Wheat Flour, Yeast, Salt"
          ) &&
          lookupMod.isDietaryOrVariantMismatch(
            "dairy free yogurt",
            "Dairy-Free Yogurt",
            "Cultured Pasteurized Milk, Whey"
          ) &&
          lookupMod.isDietaryOrVariantMismatch(
            "sugar free gummy bears",
            "Sugar-Free Gummy Bears",
            "Corn Syrup, Sugar, Gelatin"
          ) &&
          lookupMod.isDietaryOrVariantMismatch(
            "Land O Lakes unsalted butter",
            "Land O Lakes Butter",
            "Sweet Cream, Salt",
            { sodiumMg100g: 643 }
          ) &&
          !lookupMod.isDietaryOrVariantMismatch(
            "unsalted butter",
            "Unsalted Creamery Butter",
            "Pasteurized Cream, Natural Flavorings",
            { sodiumMg100g: 11 }
          )
      )
    );

    // 2. Whole-food pre-head + post-head + single-head-noun grammar across Produce, Meat/Seafood, and Nuts/Legumes
    const postAuditWholeFoodRejects = [
      "Beef & Broccoli",
      "chicken alfredo with broccoli",
      "chicken tikka masala with basmati rice and peas",
      "Birds Eye Cheesy Broccoli",
      "cream of mushroom",
      "tempura vegetables",
      "garlic salt",
      "lemon pepper",
      "strawberry banana",
      "lemon lime",
      "mint",
      "Salt and Pepper Raw Almonds",
      "praline pecans",
      "cinnamon pecans",
      "maple walnuts",
      "chili lime cashews",
      "refried black beans",
    ];
    const postAuditWholeFoodRejectResults = await Promise.all(
      postAuditWholeFoodRejects.map((productTitle) => lookupMod.lookupIngredients({ productTitle }))
    );

    const postAuditWholeFoodResolves = [
      "Beef Choice Angus Ribeye Steak, 0.7 - 1.76 lb Tray",
      "Chicken Thighs Bone-In Skin-On Family Pack",
      "Jumbo Raw Shrimp, Peeled & Deveined, Tail-On",
      "Fresh Atlantic Salmon Skin-On Portions, 1 lb",
      "Fresh Chicken Breast Thin Sliced",
      "Apple, Honeycrisp",
      "Potatoes, Russet",
      "Grapes, Red Seedless",
      "Fresh Banana Fruit, Each",
      "Fresh Mint Leaves",
      "Raw Almonds, No Salt Added",
    ];
    const postAuditWholeFoodResolveResults = await Promise.all(
      postAuditWholeFoodResolves.map((productTitle) => lookupMod.lookupIngredients({ productTitle }))
    );

    check(
      "Post-Audit P0-3: Whole-food fallbacks reject prepared meals, seasonings, flavor pairs, and flavored nuts while resolving retailer meat/seafood cuts & inverted '<Noun>, <Variety>' titles",
      Boolean(
        postAuditWholeFoodRejectResults.every((r) => r?.nutrition?.isWholeFood !== true) &&
          postAuditWholeFoodResolveResults.every((r) => r?.nutrition?.isWholeFood === true)
      )
    );

    // 3. FDA 21 CFR 101.61/101.62 bidirectional sodium/fat/light/soup variant tiers & canonical runScan titles
    const campbellsScan = await scanMod.runScan({
      productTitle: "Campbell's Condensed Chicken Noodle Soup, 10.75 oz Can",
      skipAnalytics: true,
    });
    check(
      "Post-Audit P1-4: passesVariantGuard enforces bidirectional 21 CFR sodium/fat/light/soup-line tiers and runScan surfaces canonical provider/catalog titles",
      Boolean(
        !passesVariantGuard("Swanson Unsalted Chicken Broth", "Swanson 33% Less Sodium Chicken Broth") &&
          !passesVariantGuard("Swanson Low Sodium Chicken Broth", "Swanson 33% Less Sodium Chicken Broth") &&
          !passesVariantGuard("Planters Lightly Salted Peanuts", "Planters Unsalted Peanuts") &&
          !passesVariantGuard("Land O Lakes Salted Butter", "Land O Lakes Unsalted Butter") &&
          !passesVariantGuard("Horizon 1% Lowfat Milk", "Horizon 2% Reduced Fat Milk") &&
          !passesVariantGuard("Horizon Fat Free Skim Milk", "Horizon 1% Lowfat Milk") &&
          !passesVariantGuard("Philadelphia light cream cheese", "Philadelphia Original Cream Cheese") &&
          !passesVariantGuard("Philadelphia cream cheese", "Philadelphia Light Cream Cheese") &&
          !passesVariantGuard("Log Cabin light syrup", "Log Cabin Original Syrup") &&
          !passesVariantGuard("Hellmann's mayonnaise", "Hellmann's Light Mayonnaise") &&
          !passesVariantGuard("Del Monte Peaches in Light Syrup", "Del Monte Sliced Peaches in Heavy Syrup") &&
          !passesVariantGuard("Campbell's Homestyle Chicken Noodle Soup", "Campbell's Condensed Chicken Noodle Soup") &&
          !passesVariantGuard("Campbell's Chunky Chicken Noodle Soup", "Campbell's Condensed Chicken Noodle Soup") &&
          campbellsScan.ok &&
          campbellsScan.product.title === "Campbell's Condensed Chicken Noodle Soup"
      )
    );

    // 4. Broad-match catalog leak closure, category head-noun guard, brand aliases & co-brand form taxonomy
    const catalogLeakQueries = [
      "Rao's Homemade Arrabbiata Sauce, 24 oz",
      "mandarin oranges in light syrup",
      "Siete Tostadas",
      "Rockstar Punched",
      "Libby's Sliced Peaches in Heavy Syrup, 15 oz",
      "Campbell's Homestyle Chicken Noodle Soup",
      "Campbell's Chunky Chicken Noodle Soup",
      "Larabar Peanut Butter Chocolate Chip",
    ];
    const catalogLeakResults = await Promise.all(
      catalogLeakQueries.map((productTitle) => lookupMod.lookupIngredients({ productTitle }))
    );
    const honeyRoastedPeanutsHit = await lookupMod.lookupIngredients({ productTitle: "Honey Roasted Peanuts" });
    const wasabiAlmondsHit = await lookupMod.lookupIngredients({ productTitle: "wasabi almonds" });
    const pbChocBarHit = await lookupMod.lookupIngredients({ productTitle: "Peanut Butter Chocolate Chip Bar" });
    const krogerBigKHit = await lookupMod.lookupIngredients({ productTitle: "Kroger Big K Cola 2 L" });
    const phillyBrickHit = await lookupMod.lookupIngredients({
      productTitle: "Philadelphia Original Cream Cheese, 8 oz Brick",
    });
    const cokeSodaPopHit = await lookupMod.lookupIngredients({
      productTitle: "Coca-Cola Classic Soda Pop, 12 fl oz, 12 Pack Cans",
    });
    const cheeriosHeartHealthyHit = await lookupMod.lookupIngredients({
      productTitle: "Cheerios Heart Healthy Cereal, 18 oz",
    });

    check(
      "Post-Audit P1-5: Catalog identity guard closes broad-match leaks, category head-noun guard prevents aisle hijacks, house-brand aliases resolve 'Kroger Big K Cola', and relevance/brand guards block co-brand form swaps & 'A1C Foods'",
      Boolean(
        catalogLeakResults.every((r) => r === null) &&
          !/natural\s+sweeteners/i.test(honeyRoastedPeanutsHit?.brand ?? "") &&
          !/horseradish|wasabi\s+condiments/i.test(wasabiAlmondsHit?.brand ?? "") &&
          !/^peanut\s+butter\b/i.test(pbChocBarHit?.brand ?? "") &&
          krogerBigKHit?.source === "catalog" &&
          /big\s+k/i.test(krogerBigKHit.productTitle) &&
          phillyBrickHit?.source === "catalog" &&
          cokeSodaPopHit?.source === "catalog" &&
          cheeriosHeartHealthyHit?.source === "catalog" &&
          lookupMod.relevance("Coca-Cola Oreo Soda", "OREO Coca-Cola Sandwich Cookies") === 0 &&
          lookupMod.relevance("OREO Coca-Cola Sandwich Cookies", "Coca-Cola Oreo Zero Sugar Soda") === 0 &&
          lookupMod.relevance("Premier Protein Chocolate Shake Multi-Pack", "Premier Protein Chocolate Shake") > 0.7 &&
          !lookupMod.matchesRequestedBrand("A1 steak sauce", "A1C Foods", "A1C Foods Low Carb Sauce") &&
          !lookupMod.matchesRequestedBrand("Heinz ketchup", "", "Herr's Heinz Ketchup Potato Chips")
      )
    );

    // 5. Whole-fruit beverages, pet/OTC brand collisions, '&' single-ingredient separator, and /api/label-report honesty
    const freshOjYuka = scoreProductYuka("Oranges.", {}, [], {
      productTitle: "Fresh Squeezed Orange Juice",
      caloriesKcal100g: 45,
      sugarsG100g: 8.4,
      fiberG100g: 0.2,
      proteinG100g: 0.7,
      fruitsVegNutsPct: 100,
    });
    const freshOjAsSolidCheck = scoreProductYuka("Oranges.", {}, [], {
      productTitle: "Sliced Oranges",
      caloriesKcal100g: 45,
      sugarsG100g: 8.4,
      fiberG100g: 0.2,
      proteinG100g: 0.7,
      fruitsVegNutsPct: 100,
    });
    const lemonadeYuka = scoreProductYuka("Lemons, Water, Cane Sugar.", {}, [], {
      productTitle: "Old Fashioned Lemonade",
      caloriesKcal100g: 42,
      sugarsG100g: 10.2,
    });
    const fancyFeastYuka = scoreProductYuka(
      "Chicken, Poultry Broth, Liver, Meat By-Products, Artificial and Natural Flavors, Tricalcium Phosphate.",
      {},
      [],
      {
        productTitle: "Fancy Feast Classic Chicken Pate",
        productKind: "food",
        caloriesKcal100g: 110,
        proteinG100g: 11,
      }
    );
    const allegraGelcapsYuka = scoreProductYuka("Corn Starch, Povidone, Microcrystalline Cellulose.", {}, [], {
      productTitle: "Allegra Allergy 24hr Gelcaps",
      productKind: "food",
      caloriesKcal100g: 20,
    });
    const offCatFoodHit = lookupMod.offToResult(
      {
        product_name: "Classic Pate Salmon Feast",
        brands: "Fancy Feast",
        ingredients_text: "Salmon, Fish Broth, Liver.",
        categories_tags: ["en:pet-foods", "en:cat-foods"],
      },
      "Fancy Feast Salmon"
    );

    const badCheckDigitReportRes = await labelReportMod.POST(
      new Request("http://localhost:3000/api/label-report", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.77.68" },
        body: JSON.stringify({
          productTitle: "Test Soup",
          barcode: "012345678901",
        }),
      })
    );
    const unverifiedEmptyReportRes = await labelReportMod.POST(
      new Request("http://localhost:3000/api/label-report", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.77.69" },
        body: JSON.stringify({
          productTitle: "Mystery Local Bakery Muffin",
          brand: "Local Bakery",
        }),
      })
    );
    const unverifiedEmptyReportJson = (await unverifiedEmptyReportRes.json()) as {
      ok?: boolean;
      resolutionSource?: string;
      verifiedProduct?: unknown;
      report?: { status?: string };
    };

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("078742000008")) {
        return Response.json({
          status: 1,
          product: {
            code: "078742000008",
            product_name: "Original Soymilk",
            brands: "Great Value",
            countries_tags: ["en:united-states"],
            ingredients_text: "Filtered Water, Whole Soybeans, Cane Sugar, Sea Salt, Carrageenan.",
            nutriments: {
              "energy-kcal_100g": 45,
              sugars_100g: 3.3,
              sodium_100g: 0.045,
              proteins_100g: 2.9,
            },
          },
        });
      }
      return Response.json({ status: 0, hits: [], products: [], foods: [] });
    };
    const conflictingBarcodeReportRes = await labelReportMod.POST(
      new Request("http://localhost:3000/api/label-report", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.77.70" },
        body: JSON.stringify({
          productTitle: "Silk Unsweetened Soymilk",
          brand: "Silk",
          barcode: "078742000008",
        }),
      })
    );
    globalThis.fetch = prevFetch48h;

    check(
      "Post-Audit P2-6: Whole-fruit juices score on beverage curve, Fancy Feast & Allegra Gelcaps classify as non-food, '&' blocks singleIngredientWholeFoodFlags, and /api/label-report enforces GTIN Mod-10 (400), barcode-title conflict (409), and honest unverified flagged_for_review",
      Boolean(
        freshOjYuka.score < freshOjAsSolidCheck.score &&
          lemonadeYuka.score < 60 &&
          fancyFeastYuka.yukaBreakdown?.nutriScoreGrade === "N/A" &&
          allegraGelcapsYuka.yukaBreakdown?.nutriScoreGrade === "N/A" &&
          offCatFoodHit.nutrition?.productKind === "non-food" &&
          lookupMod.singleIngredientWholeFoodFlags("Mixed Spread", "Peanuts & Canola Oil") === null &&
          badCheckDigitReportRes.status === 400 &&
          unverifiedEmptyReportRes.status === 200 &&
          unverifiedEmptyReportJson.resolutionSource === "unverified" &&
          unverifiedEmptyReportJson.verifiedProduct === null &&
          unverifiedEmptyReportJson.report?.status === "flagged_for_review" &&
          conflictingBarcodeReportRes.status === 409
      )
    );

    // ==================== POST-a95f22c SELF-AUDIT REGRESSION SUITE ====================
    {
    const scanRouteMod = await import("../app/api/scan/route");
    const auditRouteMod = await import("../app/api/audit/route");
    const dietarySelfMod = await import("../lib/dietary");
    const nutritionMod = await import("../lib/nutrition");
    const rubricMod = await import("../lib/rubric");
    const brandsMod = await import("../lib/brands");
    const drinksMod = await import("../lib/drinks-catalog");
    const entitlementsMod = await import("../lib/entitlements");
    const scanLibMod = await import("../lib/scan");

    // A. Apple StoreKit 2 JWS OID / CA / P-384 / expiry / 413 hardening + Retention apple_<origTxId> lookup + Paywall verifiedAccountPro spoof guard
    const expiredLeafDer = buildTestX509Der({
      serial: 7,
      issuerCn: "Apple WWDR CA",
      subjectCn: "Expired App Store Leaf",
      subjectPubKey: leafKp.publicKey,
      issuerPrivKey: intKp.privateKey,
      notBefore: new Date(certNow.getTime() - 172_800_000),
      notAfter: new Date(certNow.getTime() - 3600_000),
      isCa: false,
    });
    const nonCaIntDer = buildTestX509Der({
      serial: 8,
      issuerCn: "Apple Root CA - G3",
      subjectCn: "Apple WWDR Non-CA",
      subjectPubKey: intKp.publicKey,
      issuerPrivKey: rootKp.privateKey,
      notBefore: certNb,
      notAfter: certNa,
      isCa: false,
    });

    const signStoreKitTxJws = (
      x5cList: unknown,
      claimOverrides?: Record<string, unknown>,
      signingKey: import("node:crypto").KeyObject = leafKp.privateKey,
      sigHash: "sha256" | "sha384" = "sha256",
    ) => {
      const hdr = Buffer.from(JSON.stringify({ alg: "ES256", x5c: x5cList })).toString("base64url");
      const claimsObj: Record<string, unknown> = {
        transactionId: "tx_self_audit_1",
        originalTransactionId: "orig_tx_self_audit_1",
        bundleId: "com.heybroc.app",
        productId: "com.heybroc.pro.annual",
        signedDate: Date.now(),
        expiresDate: Date.now() + 86_400_000,
        environment: "Sandbox",
        ...claimOverrides,
      };
      const pay = Buffer.from(JSON.stringify(claimsObj)).toString("base64url");
      const sig = cryptoMod
        .sign(sigHash, Buffer.from(`${hdr}.${pay}`, "utf8"), {
          key: signingKey,
          dsaEncoding: "ieee-p1363",
        })
        .toString("base64url");
      return `${hdr}.${pay}.${sig}`;
    };

    const prevRootPinSelfAudit = process.env.APPLE_ROOT_CA_SHA256;
    let verifyNonCaIntStatus = 0;
    let verifyP384Status = 0;
    let verifyExpiredStatus = 0;
    let verifyMissingOidStatus = 0;
    let verifyOversizeStatus = 0;
    let verifyNullBodyStatus = 0;
    let retentionNonArrayX5cStatus = 0;
    let retentionOversizeStatus = 0;
    let retentionApplePrefixStatus = 0;
    let retentionApplePrefixPromoId = "";
    try {
      process.env.APPLE_ROOT_CA_SHA256 = rootX509.fingerprint256;

      verifyNullBodyStatus = (
        await appleVerifyRouteMod.POST(
          new Request("http://localhost:3000/api/apple/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.99.1" },
            body: "null",
          })
        )
      ).status;

      verifyOversizeStatus = (
        await appleVerifyRouteMod.POST(
          new Request("http://localhost:3000/api/apple/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.99.2" },
            body: JSON.stringify({ signedTransactionInfo: "x".repeat(34_000) }),
          })
        )
      ).status;

      verifyNonCaIntStatus = (
        await appleVerifyRouteMod.POST(
          new Request("http://localhost:3000/api/apple/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.99.3" },
            body: JSON.stringify({
              signedTransactionInfo: signStoreKitTxJws([
                leafDer.toString("base64"),
                nonCaIntDer.toString("base64"),
                rootDer.toString("base64"),
              ]),
            }),
          })
        )
      ).status;

      verifyP384Status = (
        await appleVerifyRouteMod.POST(
          new Request("http://localhost:3000/api/apple/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.99.4" },
            body: JSON.stringify({
              signedTransactionInfo: signStoreKitTxJws(
                [
                  p384LeafDer.toString("base64"),
                  intDer.toString("base64"),
                  rootDer.toString("base64"),
                ],
                undefined,
                p384LeafKp.privateKey,
                "sha384",
              ),
            }),
          })
        )
      ).status;

      verifyExpiredStatus = (
        await appleVerifyRouteMod.POST(
          new Request("http://localhost:3000/api/apple/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.99.5" },
            body: JSON.stringify({
              signedTransactionInfo: signStoreKitTxJws([
                expiredLeafDer.toString("base64"),
                intDer.toString("base64"),
                rootDer.toString("base64"),
              ]),
            }),
          })
        )
      ).status;

      // /api/apple/verify sets allowNonProdTestPin: false, so even with APPLE_ROOT_CA_SHA256 set it MUST reject non-Apple roots/missing App Store OIDs
      verifyMissingOidStatus = (
        await appleVerifyRouteMod.POST(
          new Request("http://localhost:3000/api/apple/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.99.6" },
            body: JSON.stringify({
              signedTransactionInfo: signStoreKitTxJws([
                leafDer.toString("base64"),
                intDer.toString("base64"),
                rootDer.toString("base64"),
              ]),
            }),
          })
        )
      ).status;

      retentionNonArrayX5cStatus = (
        await appleRetentionMod.POST(
          new Request("http://localhost:3000/api/apple/retention", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.99.7" },
            body: JSON.stringify({
              signedPayload: signStoreKitTxJws("not-an-array"),
            }),
          })
        )
      ).status;

      retentionOversizeStatus = (
        await appleRetentionMod.POST(
          new Request("http://localhost:3000/api/apple/retention", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.99.8" },
            body: JSON.stringify({ signedPayload: "y".repeat(34_000) }),
          })
        )
      ).status;

      await entitlementsMod.saveEntitlement({
        sessionId: "apple_tx_direct_ret_901",
        subscriptionId: "apple_direct_ret_901",
        plan: "monthly",
        status: "active",
        active: true,
        lastChargeSucceeded: true,
        expiresAtMs: Date.now() + 86_400_000,
        updatedAt: new Date().toISOString(),
      });
      const retApplePrefixRes = await appleRetentionMod.POST(
        new Request("http://localhost:3000/api/apple/retention", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.99.9" },
          body: JSON.stringify({
            signedPayload: signRetentionJws(
              [
                leafDer.toString("base64"),
                intDer.toString("base64"),
                rootDer.toString("base64"),
              ],
              { originalTransactionId: "direct_ret_901", productId: "com.heybroc.pro.monthly" },
            ),
          }),
        })
      );
      retentionApplePrefixStatus = retApplePrefixRes.status;
      const retApplePrefixJson = (await retApplePrefixRes.json()) as {
        alternateProduct?: { productId?: string; messageIdentifier?: string };
      };
      retentionApplePrefixPromoId = retApplePrefixJson.alternateProduct?.productId || "";
    } finally {
      if (prevRootPinSelfAudit === undefined) delete process.env.APPLE_ROOT_CA_SHA256;
      else process.env.APPLE_ROOT_CA_SHA256 = prevRootPinSelfAudit;
    }

    globalThis.fetch = async () => Response.json({ status: 0, hits: [], products: [], foods: [] });
    let spoofScanIsPro: boolean | undefined;
    let spoofAuditIsPro: boolean | undefined;
    try {
      const spoofScanRes = await scanRouteMod.POST(
        new Request("http://localhost:3000/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.99.10" },
          body: JSON.stringify({
            productTitle: "Doritos Nacho Cheese",
            deviceId: "dev_spoof_audit_999111",
            verifiedAccountPro: true,
            skipAnalytics: true,
          }),
        })
      );
      const spoofScanJson = (await spoofScanRes.json()) as {
        entitlement?: { isProActive?: boolean };
      };
      spoofScanIsPro = spoofScanJson.entitlement?.isProActive;

      const spoofAuditRes = await auditRouteMod.POST(
        new Request("http://localhost:3000/api/audit", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.99.11" },
          body: JSON.stringify({
            deviceId: "dev_spoof_audit_999111",
            items: [
              {
                productTitle: "Doritos Nacho Cheese",
                deviceId: "dev_spoof_audit_999111",
                verifiedAccountPro: true,
              },
            ],
          }),
        })
      );
      const spoofAuditJson = (await spoofAuditRes.json()) as {
        results?: Array<{ entitlement?: { isProActive?: boolean } }>;
      };
      spoofAuditIsPro = spoofAuditJson.results?.[0]?.entitlement?.isProActive;
    } finally {
      globalThis.fetch = prevFetch48h;
    }

    check(
      "Self-Audit A: /api/apple/verify & /api/apple/retention enforce X.509 CA constraints, P-256 leaf curve, expiry, App Store OIDs, 32KB cap, and apple_<origTxId> lookup; /api/scan & /api/audit reject untrusted verifiedAccountPro spoofing",
      Boolean(
        verifyNullBodyStatus === 400 &&
          verifyOversizeStatus === 413 &&
          verifyNonCaIntStatus === 401 &&
          verifyP384Status === 401 &&
          verifyExpiredStatus === 401 &&
          verifyMissingOidStatus === 401 &&
          retentionNonArrayX5cStatus === 401 &&
          retentionOversizeStatus === 413 &&
          retentionApplePrefixStatus === 200 &&
          retentionApplePrefixPromoId === "com.heybroc.pro.annual" &&
          spoofScanIsPro === false &&
          spoofAuditIsPro === false
      )
    );

    // B. Precautionary allergen preservation ("processed in alkali", "packaged in soybean oil", "\nContains:") + coordinated "-free" claims + Sesame pill
    const alkaliCookieAlerts = dietarySelfMod.evaluateDietaryAlerts(
      ["dairy", "wheat_gluten", "soy", "egg", "shellfish_fish"],
      "Chocolate Cookie",
      "Sugar, Cocoa Processed in Alkali, Anchovies Packaged in Soybean Oil, Enriched Wheat Flour, Whole Milk, Eggs."
    );
    const alkaliCookieAlertIds = new Set(alkaliCookieAlerts.map((a) => a.id));
    const newlineContainsAlerts = dietarySelfMod.evaluateDietaryAlerts(
      ["dairy", "soy", "wheat_gluten", "sesame"],
      "Butter Crackers",
      "Enriched Flour, Canola Oil. May contain sesame\nContains: Wheat, Milk, Soy."
    );
    const newlineContainsIds = new Set(newlineContainsAlerts.map((a) => a.id));
    const coordinatedFreeGranolaAlerts = dietarySelfMod.evaluateDietaryAlerts(
      ["peanuts_nuts", "egg", "dairy"],
      "Peanut & Tree Nut Free, Egg & Dairy Free Granola",
      "Rolled Oats, Maple Syrup, Cashewmilk."
    );
    const coordinatedFreeIds = new Set(coordinatedFreeGranolaAlerts.map((a) => a.id));
    const watchlistMiniFunnelSrc = fs.readFileSync("components/WatchlistMiniFunnel.tsx", "utf8");

    check(
      "Self-Audit B: evaluateDietaryAlerts & isDietaryOrVariantMismatch preserve allergens after 'processed in alkali'/'packaged in oil' and across '\\nContains:', detect compound Cashewmilk despite coordinated '-free' title claims, and expose Sesame Guard in WatchlistMiniFunnel",
      Boolean(
        alkaliCookieAlertIds.has("dairy") &&
          alkaliCookieAlertIds.has("wheat_gluten") &&
          alkaliCookieAlertIds.has("soy") &&
          alkaliCookieAlertIds.has("egg") &&
          alkaliCookieAlertIds.has("shellfish_fish") &&
          newlineContainsIds.has("dairy") &&
          newlineContainsIds.has("soy") &&
          newlineContainsIds.has("wheat_gluten") &&
          !newlineContainsIds.has("sesame") &&
          coordinatedFreeIds.has("peanuts_nuts") &&
          !coordinatedFreeIds.has("egg") &&
          !coordinatedFreeIds.has("dairy") &&
          lookupMod.isDietaryOrVariantMismatch(
            "dairy free hot cocoa",
            "Hot Cocoa Mix",
            "Sugar, Cocoa Processed in Alkali, Nonfat Dry Milk."
          ) &&
          lookupMod.isDietaryOrVariantMismatch(
            "no sugar added peach cups",
            "Sliced Peaches",
            "Peaches, Water, Cane Sugar."
          ) &&
          watchlistMiniFunnelSrc.includes('id: "sesame"')
      )
    );

    // C. Whole-food descriptor hardening, multi-species meat guard, USDA Survey (FNDDS) prepared-dish exclusion, canonical word-order catalog self-resolution, & runScan aisle-prefix isolation
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("019156552641")) {
        return Response.json({
          status: 1,
          product: {
            code: "019156552641",
            product_name: "Grade A Large Brown Eggs",
            brands: "Happy Egg",
            countries_tags: ["en:united-states"],
            ingredients_text: "Shell Eggs.",
            nutriments: { "energy-kcal_100g": 143, sugars_100g: 0.4, "saturated-fat_100g": 3.1, sodium_100g: 0.142, proteins_100g: 12.6 },
          },
        });
      }
      return Response.json({ status: 0, hits: [], products: [], foods: [] });
    };
    let sneakyWholeRejectsOk = false;
    let legitWholeHitsOk = false;
    let wordOrderCatalogOk = false;
    let aisleEggScanOk = false;
    try {
      const sneakyWholeQueries = [
        "apple butter",
        "tomato spaghetti",
        "spaghetti salad",
        "italian salad",
        "ambrosia salad",
        "tuna steak in water",
        "beef stew",
        "beef and turkey",
        "pork and shrimp",
        "chicken and salmon",
      ];
      const sneakyResults = await Promise.all(
        sneakyWholeQueries.map((productTitle) => lookupMod.lookupIngredients({ productTitle }))
      );
      sneakyWholeRejectsOk = sneakyResults.every((r) => r?.nutrition?.isWholeFood !== true);

      const legitWholeQueries = [
        "Cosmic Crisp Apples",
        "Spaghetti Squash",
        "Butter Potatoes",
        "Beef Stew Meat",
      ];
      const legitResults = await Promise.all(
        legitWholeQueries.map((productTitle) => lookupMod.lookupIngredients({ productTitle }))
      );
      legitWholeHitsOk = legitResults.every((r) => r?.nutrition?.isWholeFood === true);

      const wordOrderQueries = [
        "Honey Nut Cheerios",
        "Cherry Coke",
        "Post Oreo O's Cereal",
        "Ben & Jerry's Cherry Garcia Ice Cream",
      ];
      const wordOrderResults = await Promise.all(
        wordOrderQueries.map((productTitle) => lookupMod.lookupIngredients({ productTitle }))
      );
      wordOrderCatalogOk = wordOrderResults.every((r) => r?.source === "catalog");

      const aisleEggScan = await scanLibMod.runScan({
        productTitle: "Milk & Eggs - Grade A Large Brown Eggs",
        barcode: "019156552641",
        dietaryWatchlist: ["dairy"],
        skipAnalytics: true,
      });
      aisleEggScanOk =
        aisleEggScan.ok === true &&
        aisleEggScan.result.score >= 80 &&
        !(aisleEggScan.dietaryAlerts || []).some((a) => a.id === "dairy");
    } finally {
      globalThis.fetch = prevFetch48h;
    }

    const fnddsPotPieNut = nutritionMod.extractUsdaNutrition({
      description: "Chicken pot pie, NFS",
      dataType: "Survey (FNDDS)",
      foodNutrients: [],
    });
    const foundationAppleNut = nutritionMod.extractUsdaNutrition({
      description: "Apples, raw",
      dataType: "Foundation",
      foodNutrients: [],
    });
    const clampedWatchlistRubric = rubricMod.scoreIngredients("Water, Red 40", {
      dyes: 999_999,
    });
    const normalWatchlistRubric = rubricMod.scoreIngredients("Water, Red 40", {
      dyes: 3,
    });

    check(
      "Self-Audit C: Prepared dishes & multi-species meats never score as whole foods, USDA Survey (FNDDS) prepared dishes never auto-flag isWholeFood, canonicalized word-order brands resolve from catalog, runScan isolates aisle prefixes, and rubric clamps watchlist multipliers",
      Boolean(
        sneakyWholeRejectsOk &&
          legitWholeHitsOk &&
          wordOrderCatalogOk &&
          aisleEggScanOk &&
          !nutritionMod.classifyWholeFood("Oatmeal creme pie").isWholeFood &&
          !nutritionMod.classifyWholeFood("Beef burrito").isWholeFood &&
          !nutritionMod.classifyWholeFood("Tuna salad").isWholeFood &&
          !nutritionMod.classifyWholeFood("Chicken pot pie").isWholeFood &&
          !nutritionMod.classifyWholeFood("Corned beef").isWholeFood &&
          !fnddsPotPieNut.isWholeFood &&
          foundationAppleNut.isWholeFood === true &&
          Number.isFinite(clampedWatchlistRubric.score) &&
          clampedWatchlistRubric.score === normalWatchlistRubric.score
      )
    );

    // D. Brand guards (Fudge Ripple / A1 Milk / Peeps Ghost / CPG parent umbrellas), leading modifiers, passesVariantGuard, and /api/label-report digit & dual-input conflict hardening
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("078742000008")) {
        return Response.json({
          status: 1,
          product: {
            code: "078742000008",
            product_name: "Original Soymilk",
            brands: "Great Value",
            countries_tags: ["en:united-states"],
            ingredients_text: "Filtered Water, Whole Soybeans, Cane Sugar, Sea Salt, Carrageenan.",
            nutriments: { "energy-kcal_100g": 45, sugars_100g: 3.3, sodium_100g: 0.045, proteins_100g: 2.9 },
          },
        });
      }
      return Response.json({ status: 0, hits: [], products: [], foods: [] });
    };
    let upcInTextareaJson: { resolutionSource?: string; verifiedProduct?: { score?: number } | null } = {};
    let badUpcInTextareaStatus = 0;
    let gibberishTextareaStatus = 0;
    let dualInputConflictStatus = 0;
    try {
      const upcInTextareaRes = await labelReportMod.POST(
        new Request("http://localhost:3000/api/label-report", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.99.20" },
          body: JSON.stringify({
            productTitle: " Coca-Cola Classic ",
            reportedIngredients: "049000028904",
          }),
        })
      );
      upcInTextareaJson = (await upcInTextareaRes.json()) as typeof upcInTextareaJson;

      badUpcInTextareaStatus = (
        await labelReportMod.POST(
          new Request("http://localhost:3000/api/label-report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.99.21" },
            body: JSON.stringify({
              productTitle: "Test Soup",
              reportedIngredients: "012345678901",
            }),
          })
        )
      ).status;

      gibberishTextareaStatus = (
        await labelReportMod.POST(
          new Request("http://localhost:3000/api/label-report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.99.22" },
            body: JSON.stringify({
              productTitle: "Test Soup",
              reportedIngredients: "12345 !!!",
            }),
          })
        )
      ).status;

      dualInputConflictStatus = (
        await labelReportMod.POST(
          new Request("http://localhost:3000/api/label-report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "10.88.99.23" },
            body: JSON.stringify({
              productTitle: "Silk Unsweetened Soymilk",
              brand: "Silk",
              barcode: "078742000008",
              reportedIngredients: "Filtered Water, Whole Soybeans.",
            }),
          })
        )
      ).status;
    } finally {
      globalThis.fetch = prevFetch48h;
    }

    check(
      "Self-Audit D: Brand guards allow Fudge Ripple / A1 Milk / Peeps Ghost & CPG parent credits, passesVariantGuard catches '(2%)' / 'No Sugar Added' / 'Crunchy vs Creamy', and /api/label-report blocks raw UPC/gibberish scoring & dual-input barcode conflicts",
      Boolean(
        !brandsMod.hasConflictingBrand("Turkey Hill Fudge Ripple Ice Cream", "Turkey Hill Vanilla Ice Cream") &&
          !brandsMod.hasConflictingBrand("A1 Milk", "Origin A1 & A2 Whole Milk") &&
          !brandsMod.hasConflictingBrand("Peeps Ghost Marshmallows", "Peeps Marshmallows") &&
          lookupMod.matchesRequestedBrand("Kraft Velveeta", "Velveeta", "Velveeta Original") &&
          lookupMod.matchesRequestedBrand("Hershey's Reese's", "Reese's", "Reese's Peanut Butter Cups") &&
          lookupMod.matchesRequestedBrand("Ferrero Nutella", "Nutella", "Nutella Hazelnut Spread") &&
          lookupMod.relevance("Creamy Peanut Butter", "Skippy Creamy Peanut Butter") > 0.6 &&
          !drinksMod.passesVariantGuard("Horizon Milk (2%)", "Horizon 1% Lowfat Milk") &&
          !drinksMod.passesVariantGuard("No Sugar Added Peach Cups", "Del Monte Sliced Peaches in Heavy Syrup") &&
          !drinksMod.passesVariantGuard("Crunchy Skippy Peanut Butter", "Skippy Creamy Peanut Butter") &&
          upcInTextareaJson.resolutionSource !== "package_label" &&
          (upcInTextareaJson.verifiedProduct?.score ?? 0) < 50 &&
          badUpcInTextareaStatus === 400 &&
          gibberishTextareaStatus === 400 &&
          dualInputConflictStatus === 409
      )
    );
      const funnelVisualSrc = fs.readFileSync("components/WatchlistMiniFunnel.tsx", "utf8");
      const mainKtVisualSrc = fs.readFileSync(
        "android-app/app/src/main/java/com/cleancart/overlay/MainActivity.kt",
        "utf8"
      );
      const overlaySvcVisualSrc = fs.readFileSync(
        "android-app/app/src/main/java/com/cleancart/overlay/OverlayWindowService.kt",
        "utf8"
      );
      check(
        "Onboarding Visual Polish & Android APK Build Guard: Step 5 US choropleth map images + Iowa Cancer Registry/EPA-IARC parity, Step 6 uncropped studio product stages + swap bridge, and zero unresolved Kotlin references",
        Boolean(
          fs.existsSync("public/onboarding-usgs-map.jpg") &&
            fs.existsSync("public/onboarding-cdc-map.jpg") &&
            fs.existsSync("android-app/app/src/main/res/drawable-nodpi/onboarding_usgs_map.jpg") &&
            fs.existsSync("android-app/app/src/main/res/drawable-nodpi/onboarding_cdc_map.jpg") &&
            funnelVisualSrc.includes("/onboarding-usgs-map.jpg") &&
            funnelVisualSrc.includes("/onboarding-cdc-map.jpg") &&
            funnelVisualSrc.includes('background: "#eae5df"') &&
            mainKtVisualSrc.includes("R.drawable.onboarding_usgs_map") &&
            mainKtVisualSrc.includes("R.drawable.onboarding_cdc_map") &&
            mainKtVisualSrc.includes("ImageView.ScaleType.FIT_CENTER") &&
            mainKtVisualSrc.includes("Iowa Cancer Registry") &&
            mainKtVisualSrc.includes("EPA and IARC disagree on glyphosate's cancer risk") &&
            !mainKtVisualSrc.includes("showPaywallDialog()") &&
            !/autoVerifyLabel\([^)]*selectedStore/.test(mainKtVisualSrc) &&
            overlaySvcVisualSrc.includes("ScanApi.autoVerifyLabel(prodTitle, prodIngredients, currentStoreKey)") &&
            !overlaySvcVisualSrc.includes("ScanApi.autoVerifyLabel(prodTitle, ing, currentStore)")
        )
      );

      // --- Nov 15 Mobile QA Suite: Cinnamon Toast Crunch Swap, Non-Food Appliance/Cart Guards, PDP Photo Gallery, 1-Step Bubble Setup & Google OAuth ---
      const ctcScan = await runScan({
        productTitle: "Cinnamon Toast Crunch Breakfast Cereal, Crispy Cinnamon Cereal, Family Size, 18.8 oz",
        store: "walmart",
      });
      const airFryerScan = await runScan({
        productTitle: "12QT Air Fryer Toaster Oven, Digital Stainless Steel Countertop Convection Oven",
        store: "walmart",
      });
      const inCartBowlScan = await runScan({
        productTitle: "In Cart - Mainstays Stainless Steel Mixing Bowl, 5 Quart",
        store: "walmart",
      });
      const toasterPastryFoodScan = await runScan({
        productTitle: "My Cookie Dealer Protein Toaster Pastry, Powdered...",
        store: "walmart",
      });
      const readerQaSrc = fs.readFileSync(
        "android-app/app/src/main/java/com/cleancart/overlay/GroceryScreenReaderService.kt",
        "utf8"
      );
      const ctcSwap = ctcScan.ok ? ctcScan.swap : null;
      const ctcSwapName = `${ctcSwap?.brand ?? ""} ${ctcSwap?.name ?? ""}`.trim();
      const ctcSwapUrl = `${ctcSwap?.deepLink ?? ""} ${ctcSwap?.webUrl ?? ""}`;

      check(
        "Nov 15 Mobile QA Suite: Cinnamon Toast Crunch swaps to >=90/100 Food For Life Ezekiel 4:9 Cinnamon Raisin Sprouted Whole Grain Cereal (no dead /ip/10898744), Air Fryer & 'In Cart - Mainstays' bowls rejected as non-food while Toaster Pastries still scan, PDP Photo Gallery ('Images (14) | Videos (1)') stays scannable, and 1-Step Bubble Setup replaces 'Step 1 of 3'",
        Boolean(
          ctcScan.ok &&
            ctcSwapName.includes("Ezekiel 4:9 Cinnamon Raisin") &&
            (ctcSwap?.score ?? 0) >= 90 &&
            !ctcSwapUrl.includes("10898744") &&
            !airFryerScan.ok &&
            airFryerScan.status === 404 &&
            !inCartBowlScan.ok &&
            inCartBowlScan.status === 404 &&
            toasterPastryFoodScan.ok &&
            readerQaSrc.includes("isCartEndHeader") &&
            readerQaSrc.includes("SAVED_FOR_LATER_ROW_CTA") &&
            readerQaSrc.includes("NON_CART_ROW_CTA") &&
            readerQaSrc.includes("isPdpMediaGallery") &&
            overlaySvcVisualSrc.includes("preferNativeInAppSearch") &&
            !mainKtVisualSrc.includes("Step 1 of 3") &&
            !mainKtVisualSrc.includes("Step 2 of 3") &&
            mainKtVisualSrc.includes("AUTOFILL_HINT_PASSWORD")
        )
      );
    }
  }

  // ==================== BUILD 120 REGRESSION: SELF-HEALING 5M PHOTOS, 1-SWITCH SAFARI & IOS 26 CRASH GUARD ====================
  {
    const fakeJpegBytes = new Uint8Array(512).fill(0xff);
    fakeJpegBytes[0] = 0xff;
    fakeJpegBytes[1] = 0xd8;
    const prevFetchImg = globalThis.fetch;
    let healedHiddenValleyRes: Response | null = null;
    let frontLabelBrandRes: Response | null = null;
    let crossBrandRejectedRes: Response | null = null;
    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (u.includes("/007/110/000/3116/front_en.7.400.jpg")) {
          return new Response("Not Found", { status: 404 });
        }
        if (u.includes("/api/v2/product/0071100003116.json")) {
          return Response.json({
            status: 1,
            product: {
              code: "0071100003116",
              brands: "Hidden Valley",
              product_name: "THE ORIGINAL Ranch",
              image_front_url: "https://images.openfoodfacts.org/images/products/007/110/000/3116/front_en.29.400.jpg",
            },
          });
        }
        if (u.includes("/007/110/000/3116/front_en.29.400.jpg")) {
          return new Response(fakeJpegBytes, { status: 200, headers: { "content-type": "image/jpeg" } });
        }
        if (u.includes("search.openfoodfacts.org/search") && decodeURIComponent(u).toLowerCase().includes("kens")) {
          return Response.json({
            hits: [
              {
                code: "0041335000129",
                brands: "Ken's Steak House",
                product_name: "Country French",
                countries_tags: ["en:united-states"],
                image_front_small_url: "https://images.openfoodfacts.org/images/products/004/133/500/0129/front_en.9.400.jpg",
              },
            ],
          });
        }
        if (u.includes("/004/133/500/0129/front_en.9.400.jpg")) {
          return new Response(fakeJpegBytes, { status: 200, headers: { "content-type": "image/jpeg" } });
        }
        if (u.includes("search.openfoodfacts.org/search") && decodeURIComponent(u).toLowerCase().includes("briannas")) {
          return Response.json({
            hits: [
              {
                code: "0078742000114",
                brands: "Great Value",
                product_name: "Homestyle French",
                countries_tags: ["en:united-states"],
                image_front_small_url: "https://images.openfoodfacts.org/images/products/007/874/200/0114/front_en.4.400.jpg",
              },
            ],
          });
        }
        return Response.json({ status: 0, hits: [], products: [] });
      };

      healedHiddenValleyRes = await productImageRouteMod.GET(
        new Request(
          "http://localhost:3000/api/product-image?q=" +
            encodeURIComponent("Hidden Valley Original Ranch Salad Dressing") +
            "&brand=" +
            encodeURIComponent("Hidden Valley"),
          { headers: { "x-forwarded-for": "127.0.0.91" } },
        ),
      );
      frontLabelBrandRes = await productImageRouteMod.GET(
        new Request(
          "http://localhost:3000/api/product-image?q=" +
            encodeURIComponent("Ken's Steak House Country French Salad Dressing") +
            "&brand=" +
            encodeURIComponent("Ken's Steak House"),
          { headers: { "x-forwarded-for": "127.0.0.92" } },
        ),
      );
      crossBrandRejectedRes = await productImageRouteMod.GET(
        new Request(
          "http://localhost:3000/api/product-image?q=" +
            encodeURIComponent("Briannas Homestyle French Salad Dressing") +
            "&brand=" +
            encodeURIComponent("Briannas"),
          { headers: { "x-forwarded-for": "127.0.0.93" } },
        ),
      );
    } finally {
      globalThis.fetch = prevFetchImg;
    }

    const safariManifest120 = fs.readFileSync("ios-app/SafariExtension/Resources/manifest.json", "utf8");
    const liveBrowser120 = fs.readFileSync("ios-app/App/LiveStoreBrowserViewController.swift", "utf8");
    const hostVc120 = fs.readFileSync("ios-app/App/ViewController.swift", "utf8");

    check(
      "Build 120 Suite: Hidden Valley stale OFF revision self-heals via live UPC v2, front-of-pack titles omitting generic category nouns match while cross-brand collisions reject, Safari manifest has 1-switch *://*/* matches, and iOS 26 LiveStoreBrowser eliminates force-unwraps & synchronous WebKit re-entrancy",
      Boolean(
        healedHiddenValleyRes?.status === 200 &&
          (healedHiddenValleyRes?.headers.get("content-type") || "").includes("image/jpeg") &&
          (healedHiddenValleyRes?.headers.get("x-image-source") || "").includes("front_en.29.400.jpg") &&
          frontLabelBrandRes?.status === 200 &&
          (frontLabelBrandRes?.headers.get("content-type") || "").includes("image/jpeg") &&
          crossBrandRejectedRes?.status === 200 &&
          (crossBrandRejectedRes?.headers.get("content-type") || "").includes("image/svg+xml") &&
          !safariManifest120.includes("walmart.com") &&
          liveBrowser120.includes("WeakStoreScriptMessageProxy") &&
          liveBrowser120.includes("didStartInitialLoad") &&
          !liveBrowser120.includes("storeWebView: WKWebView!") &&
          hostVc120.includes("WeakHostScriptMessageProxy") &&
          hostVc120.includes("Other Websites")
      ),
    );
    // --- Sam's Club & 5M-Food Systemic Regression Suite ---
    const { relevance, normalizeOffDisplayTitle, sanitizeIngredientDisplay } = await import("../lib/lookup");
    const samsBaconScan = await runScan({
      productTitle: "Member's Mark Naturally Hickory Smoked Bacon 3 lbs.",
      store: "sams",
    });
    const samsChickenBitesScan = await runScan({
      productTitle: "Member's Mark Fully Cooked Lightly Breaded Chicken Breast Bites, Frozen",
      store: "sams",
    });
    const samsRotisserieScan = await runScan({
      productTitle: "Member's Mark Seasoned Rotisserie Chicken",
      store: "sams",
    });
    const samsBeefRoastScan = await runScan({
      productTitle: "Member's Mark USDA Choice Angus Beef Boneless Bottom Round Roast, priced per pound",
      store: "sams",
    });

    const overlayKtLatest = fs.readFileSync("android-app/app/src/main/java/com/cleancart/overlay/OverlayWindowService.kt", "utf8");
    const readerKtLatest = fs.readFileSync("android-app/app/src/main/java/com/cleancart/overlay/GroceryScreenReaderService.kt", "utf8");
    const historyKtLatest = fs.readFileSync("android-app/app/src/main/java/com/cleancart/overlay/ScanHistoryStore.kt", "utf8");

    check(
      "Sam's Club & 5M-Food Systemic Suite: Bacon never matches Turkey Breast, Breaded Chicken Bites never match Grilled Breasts, Rotisserie Chicken never matches Chicken Salad/Shredded Breast, Angus Beef Bottom Round Roast resolves as whole beef, 2nd-letter cap typos heal, and Capped <=49 UI clutter is hidden",
      Boolean(
        relevance("Member's Mark Naturally Hickory Smoked Bacon 3 lbs.", "Member's Mark Hickory Smoked Turkey Breast") === 0 &&
          relevance("Member's Mark Fully Cooked Lightly Breaded Chicken Breast Bites, Frozen", "Member's Mark Fire Grilled Chicken Breasts") === 0 &&
          relevance("Member's Mark Seasoned Rotisserie Chicken", "Member's Mark Rotisserie Seasoned Chicken Breast") === 0 &&
          relevance("Member's Mark Seasoned Rotisserie Chicken", "Rotisserie Chicken Salad") === 0 &&
          normalizeOffDisplayTitle("KEllogg Eggo Waffles Homestyle 86.4Oz") === "Kellogg Eggo Waffles Homestyle 86.4 oz" &&
          normalizeOffDisplayTitle("Member's Mark 100% REal CRumbled BAcon") === "Member's Mark 100% Real Crumbled Bacon" &&
          normalizeOffDisplayTitle("Member's Mark HIckory Smoked Turkey Breast") === "Member's Mark Hickory Smoked Turkey Breast" &&
          normalizeOffDisplayTitle("Member's Mark PURIFIED WATER") === "Member's Mark Purified Water" &&
          samsBaconScan.ok &&
          !/turkey/i.test(samsBaconScan.product?.title ?? "") &&
          /\bbacon\b/i.test(samsBaconScan.product?.title ?? "") &&
          samsChickenBitesScan.ok &&
          /\bbites\b/i.test(samsChickenBitesScan.product?.title ?? "") &&
          !/fire\s+grilled/i.test(samsChickenBitesScan.product?.title ?? "") &&
          /\bwheat\s+flour\b/i.test(samsChickenBitesScan.product?.ingredients ?? "") &&
          samsRotisserieScan.ok &&
          !/breast|salad|wings/i.test(samsRotisserieScan.product?.title ?? "") &&
          samsBeefRoastScan.ok &&
          /\bbeef\b/i.test(samsBeefRoastScan.product?.ingredients ?? "") &&
          (samsBeefRoastScan.result?.score ?? 0) >= 75 &&
          !overlayKtLatest.includes("Capped ≤49") &&
          overlayKtLatest.includes("swapScore > item.score") &&
          readerKtLatest.includes("your recently viewed items") &&
          !readerKtLatest.includes("\\d+\\s*ct\\s+)(.+)") &&
          historyKtLatest.includes("fun cleanDisplayTitle")
      ),
    );
    const { normalizeIosShareOrOcrInput } = await import("../lib/scan");
    const walmartShareNorm = normalizeIosShareOrOcrInput(
      "Take a look at this item from Walmart Take a look at this item https://www.walmart.com/ip/Stonyfield-Organic-Whole-Milk-Plain-Yogurt-32-oz/10535275",
      "",
    );
    const walmartActionBtnOcr = normalizeIosShareOrOcrInput(
      "",
      "",
      [
        "4:12",
        "Off",
        "oatmeal",
        "$4.42",
        "Pickup or delivery? 234 Poplar Hill Rd, Bi...",
        "Rollbacks New Arrivals Oatmeal recipes Instant oatmeal",
        "1000+ Results Uses item details. Price when purchased online.",
        "Bought 5 times",
        "$6.12 $3.23/lb",
        "Options from $6.12 - $46.51",
        "Quaker Maple & Brown",
        "Sugar Flavor Instant",
        "Oatmeal, 1.51 oz 20 Packets",
        "11,431",
        "SNAP EBT eligible",
        "W+ Free delivery as soon as 7pm",
        "Add to cart",
        "Single",
        "2 Pack",
        "8 Pack",
        "Sponsored",
        "$6.56 $3.28/lb",
        "Bob's Red Mill Non-GMO",
        "Organic Old Fashioned",
        "Rolled Oats 32 oz Bag",
      ].join("\n"),
    );
    check(
      "iPhone Walmart Share boilerplate ('Take a look at this item from Walmart') strips cleanly and Action Button screenshot OCR reconstructs wrapped Walmart titles",
      Boolean(
        walmartShareNorm.detectedStore === "walmart" &&
          !/take a look/i.test(walmartShareNorm.title) &&
          /stonyfield organic whole milk plain yogurt/i.test(walmartShareNorm.title) &&
          walmartActionBtnOcr.detectedStore === "walmart" &&
          walmartActionBtnOcr.title === "Quaker Maple & Brown Sugar Flavor Instant Oatmeal, 1.51 oz 20 Packets" &&
          walmartActionBtnOcr.candidates.some((c) => /bob's red mill.*organic old fashioned rolled oats/i.test(c))
      ),
    );

    // --- Build 121 / Android v2.4.0 Regression Suite ---
    const buildHeaderBarSlice = liveBrowser120.slice(
      liveBrowser120.indexOf("private func buildHeaderBar()"),
      liveBrowser120.indexOf("private func setupStoreWebView()"),
    );
    const addSubviewContainerIdx = buildHeaderBarSlice.indexOf("view.addSubview(container)");
    const safeAreaAnchorIdx = buildHeaderBarSlice.indexOf("view.safeAreaLayoutGuide.topAnchor");

    const quakerOldFashionedScan = await runScan({
      productTitle: "Quaker Oats OLd Fashioned 100% Whole Grain Oats, Old Fashioned",
      store: "walmart",
    });
    const quakerMapleScan = await runScan({
      productTitle: "Quaker Instant Oatmeal Maple & Brown Sugar",
      store: "walmart",
    });
    const bobsOrganicOatsScan = await runScan({
      productTitle: "Bob's Red Mill Organic Old Fashioned Rolled Oats",
      store: "walmart",
    });

    const safariContent121 = fs.readFileSync("ios-app/SafariExtension/Resources/content.js", "utf8");
    const chromeContent121 = fs.readFileSync("chrome-extension/content.js", "utf8");
    const mainKt121 = fs.readFileSync(
      "android-app/app/src/main/java/com/cleancart/overlay/MainActivity.kt",
      "utf8",
    );

    check(
      "Build 121 / v2.4.0 Suite: iOS LiveStoreBrowser adds header container to view BEFORE safeAreaLayoutGuide constraints, Safari/Chrome content.js match identically with mobile touch alignment & 450ms backdrop click guard, OLd/ALL-CAPS/Spanish OCR spillover normalize cleanly, Quaker/Bob's Red Mill oats resolve accurately, and Android overlay aligns to currentPillCenterY",
      Boolean(
        addSubviewContainerIdx > 0 &&
          safeAreaAnchorIdx > addSubviewContainerIdx &&
          safariContent121 === chromeContent121 &&
          safariContent121.includes("alignMobileSearchCardToPill") &&
          safariContent121.includes("Date.now() - modalOpenedAt < 450") &&
          overlayKtLatest.includes("var currentPillCenterY: Int") &&
          readerKtLatest.includes("OverlayWindowService.currentPillCenterY") &&
          mainKt121.includes("Settings & Account") &&
          mainKt121.includes("🧾 Receipt & Cart Audit") &&
          normalizeOffDisplayTitle("Quaker Oats OLd Fashioned 100% Whole Grain Oats, Old Fashioned") ===
            "Quaker Oats Old Fashioned 100% Whole Grain Oats" &&
          normalizeOffDisplayTitle("QUAKER INSTANT OATMEAL MAPLE & BROWN SUGAR") ===
            "Quaker Instant Oatmeal Maple & Brown Sugar" &&
          normalizeOffDisplayTitle("McCormick Non-GMO USDA Organic RXBAR") ===
            "McCormick Non-GMO USDA Organic RXBAR" &&
          sanitizeIngredientDisplay(
            "100% WHOLE GRAIN ROLLED OATS. ENTERO dtros alimentos yodeterol queden",
          ) === "100% Whole Grain Rolled Oats." &&
          sanitizeIngredientDisplay("SOYBEAN OIL, BHT, TBHQ, MONOSODIUM GLUTAMATE (MSG).") ===
            "Soybean Oil, BHT, TBHQ, Monosodium Glutamate (MSG)." &&
          quakerOldFashionedScan.ok &&
          quakerOldFashionedScan.product?.title === "Quaker Oats Old Fashioned 100% Whole Grain Oats" &&
          (quakerOldFashionedScan.result?.score ?? 0) >= 85 &&
          (quakerOldFashionedScan.result?.flagged?.length ?? 1) === 0 &&
          !/yodeterol|alimentos/i.test(quakerOldFashionedScan.product?.ingredients ?? "") &&
          quakerMapleScan.ok &&
          quakerMapleScan.product?.title === "Quaker Instant Oatmeal Maple & Brown Sugar" &&
          (quakerMapleScan.result?.score ?? 100) < (quakerOldFashionedScan.result?.score ?? 0) &&
          bobsOrganicOatsScan.ok &&
          bobsOrganicOatsScan.product?.nutrition?.isOrganic === true &&
          (bobsOrganicOatsScan.result?.score ?? 0) >= 90
      ),
    );

    // --- Automatic On-Photo Score Badges Suite (Batch API + Chrome/Safari Extension + iPhone Live Shop) ---
    const { runBatchScan } = await import("../lib/scan");
    const scanRouteMod = await import("../app/api/scan/route");
    const gridBatchRes = await runBatchScan(
      {
        store: "walmart",
        surface: "extension",
        clientPlatform: "ios-safari",
        dietaryWatchlist: ["pesticide_risk"],
      },
      [
        { id: "c1", productTitle: "Quaker Maple & Brown Sugar Flavor Instant Oatmeal, 1.51 oz 20 Packets" },
        { id: "c2", productTitle: "Bob's Red Mill Organic Old Fashioned Rolled Oats 32 oz Bag" },
        { id: "c3", productTitle: "Bounty Select-A-Size Paper Towels, 6 Double Rolls" },
        { id: "c4", productTitle: "Bob's Red Mill Organic Old Fashioned Rolled Oats 32 oz Bag" },
      ],
    );
    const routeBatchHttpRes = await scanRouteMod.POST(
      new Request("http://localhost:3000/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "10.77.66.55" },
        body: JSON.stringify({
          store: "walmart",
          surface: "extension",
          clientPlatform: "chrome-extension",
          items: [
            { id: "cardA", productTitle: "Stonyfield Organic Whole Milk Plain Yogurt, 32 oz" },
            { id: "cardB", productTitle: "Tide Pods Liquid Laundry Detergent Pacs, 42 ct" },
          ],
        }),
      }),
    );
    const routeBatchJson = (await routeBatchHttpRes.json()) as {
      ok?: boolean;
      results?: Record<string, { ok: boolean; result?: { score: number } }>;
    };

    const chromeContentJs = fs.readFileSync("chrome-extension/content.js", "utf8");
    const safariContentJs = fs.readFileSync("ios-app/SafariExtension/Resources/content.js", "utf8");
    const chromeOverlayCss = fs.readFileSync("chrome-extension/overlay.css", "utf8");
    const safariOverlayCss = fs.readFileSync("ios-app/SafariExtension/Resources/overlay.css", "utf8");
    const chromeBgJs = fs.readFileSync("chrome-extension/background.js", "utf8");
    const safariBgJs = fs.readFileSync("ios-app/SafariExtension/Resources/background.js", "utf8");
    const liveBrowserSwift = fs.readFileSync("ios-app/App/LiveStoreBrowserViewController.swift", "utf8");
    const shortcutsSwift = fs.readFileSync("ios-app/App/HeyBrocShortcuts.swift", "utf8");

    const c1Out = gridBatchRes.results.c1;
    const c2Out = gridBatchRes.results.c2;
    const c3Out = gridBatchRes.results.c3;
    const c4Out = gridBatchRes.results.c4;

    check(
      "Automatic On-Photo Score Badges: runBatchScan & POST /api/scan score multi-card grids in one trip, flag conventional oats under Pesticide Watch, skip non-food household cards, and maintain Chrome/Safari/iOS Live Shop parity",
      Boolean(
        gridBatchRes.ok &&
          c1Out?.ok &&
          c1Out.result.score < 55 &&
          (c1Out.dietaryAlerts?.length ?? 0) > 0 &&
          Boolean(c1Out.swap) &&
          c2Out?.ok &&
          c2Out.result.score >= 85 &&
          (c2Out.dietaryAlerts?.length ?? 0) === 0 &&
          c3Out?.ok === false &&
          c3Out.status === 422 &&
          c4Out?.ok &&
          c4Out.result.score === c2Out.result.score &&
          routeBatchHttpRes.status === 200 &&
          routeBatchJson.ok === true &&
          routeBatchJson.results?.cardA?.ok === true &&
          (routeBatchJson.results?.cardA?.result?.score ?? 0) >= 85 &&
          routeBatchJson.results?.cardB?.ok === false &&
          chromeContentJs === safariContentJs &&
          chromeOverlayCss === safariOverlayCss &&
          chromeContentJs.includes("cc-photo-badge") &&
          chromeContentJs.includes("CLEANCART_SCAN_BATCH") &&
          chromeContentJs.includes("isIgnoredOverlayMutation") &&
          chromeBgJs.includes("CLEANCART_SCAN_BATCH") &&
          safariBgJs.includes("CLEANCART_SCAN_BATCH") &&
          liveBrowserSwift.includes("hb-photo-badge") &&
          liveBrowserSwift.includes("gridBatch") &&
          liveBrowserSwift.includes("inspectCard") &&
          liveBrowserSwift.includes("__heybrocRefreshPhotoBadges") &&
          shortcutsSwift.includes("static func scanBatch")
      ),
    );
    // ==================== BEHAVIOURAL SECURITY, SWAP INTEGRITY, BARCODE & TITLE SUITE ====================
    {
      const nodeCrypto = await import("node:crypto");
      const authRouteMod = await import("../app/api/auth/route");
      const { getOrCreateDevice, saveDevice } = await import("../lib/referrals");
      const { normalizeBarcode, cacheKey } = await import("../lib/lookup");

      // 1. P0.1 + P1.2 Behavioural OAuth / OIDC Security Suite (zero source-string checks)
      const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
      });
      const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
      const testKid = `behav-google-kid-${Date.now()}`;
      const b64u = (obj: unknown) =>
        Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj))
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/g, "");
      const signMockGoogleJwt = (claims: Record<string, unknown>) => {
        const header = b64u({ alg: "RS256", typ: "JWT", kid: testKid });
        const payload = b64u({
          iss: "https://accounts.google.com",
          sub: "google-sub-behav-991",
          email: "behav.oauth.victim@example.com",
          email_verified: true,
          iat: Math.floor(Date.now() / 1000) - 10,
          exp: Math.floor(Date.now() / 1000) + 600,
          ...claims,
        });
        const sig = nodeCrypto
          .sign("RSA-SHA256", Buffer.from(`${header}.${payload}`, "utf8"), privateKey)
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/g, "");
        return `${header}.${payload}.${sig}`;
      };

      const prevGoogleClientId = process.env.GOOGLE_CLIENT_ID;
      const prevFetchOAuth = globalThis.fetch;
      let accessTokenRejected400 = false;
      let foreignAudRejected401 = false;
      let foreignAzpRejected401 = false;
      let missingNonceRejected401 = false;
      let wrongNonceRejected401 = false;
      let validIdTokenAccepted200 = false;

      try {
        process.env.GOOGLE_CLIENT_ID = "heybroc-test-web-client.apps.googleusercontent.com";
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (u.includes("googleapis.com/oauth2/v3/certs")) {
            return Response.json({
              keys: [{ ...jwk, kid: testKid, kty: "RSA", alg: "RS256", use: "sig" }],
            });
          }
          if (u.includes("googleapis.com/oauth2/v3/userinfo")) {
            // Even if userinfo would return 200 for a foreign app's access token, /api/auth must never accept accessToken!
            return Response.json({
              sub: "google-sub-behav-991",
              email: "behav.oauth.victim@example.com",
              email_verified: true,
            });
          }
          return prevFetchOAuth(input, init);
        };

        const postAuth = (body: Record<string, unknown>, ipSuffix: number) =>
          authRouteMod.POST(
            new Request("http://localhost:3000/api/auth", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-forwarded-for": `10.188.42.${ipSuffix}`,
              },
              body: JSON.stringify(body),
            }),
          );

        const resAccess = await postAuth(
          {
            action: "oauth",
            provider: "google",
            accessToken: "ya29.foreign-app-access-token",
          },
          11,
        );
        accessTokenRejected400 = resAccess.status === 400;

        const foreignAudJwt = signMockGoogleJwt({
          aud: "some-other-app.apps.googleusercontent.com",
          nonce: "nonce_valid_abc",
        });
        const resForeignAud = await postAuth(
          {
            action: "oauth",
            provider: "google",
            idToken: foreignAudJwt,
            nonce: "nonce_valid_abc",
          },
          12,
        );
        foreignAudRejected401 = resForeignAud.status === 401;

        const foreignAzpJwt = signMockGoogleJwt({
          aud: "heybroc-test-web-client.apps.googleusercontent.com",
          azp: "some-other-app.apps.googleusercontent.com",
          nonce: "nonce_valid_abc",
        });
        const resForeignAzp = await postAuth(
          {
            action: "oauth",
            provider: "google",
            idToken: foreignAzpJwt,
            nonce: "nonce_valid_abc",
          },
          13,
        );
        foreignAzpRejected401 = resForeignAzp.status === 401;

        const validJwtWithNonce = signMockGoogleJwt({
          aud: "heybroc-test-web-client.apps.googleusercontent.com",
          azp: "heybroc-test-web-client.apps.googleusercontent.com",
          nonce: "nonce_valid_abc",
        });
        const resMissingNonce = await postAuth(
          {
            action: "oauth",
            provider: "google",
            idToken: validJwtWithNonce,
          },
          14,
        );
        missingNonceRejected401 = resMissingNonce.status === 401;

        const resWrongNonce = await postAuth(
          {
            action: "oauth",
            provider: "google",
            idToken: validJwtWithNonce,
            nonce: "nonce_attacker_xyz",
          },
          15,
        );
        wrongNonceRejected401 = resWrongNonce.status === 401;

        const resValid = await postAuth(
          {
            action: "oauth",
            provider: "google",
            idToken: validJwtWithNonce,
            nonce: "nonce_valid_abc",
          },
          16,
        );
        const validJson = (await resValid.json()) as { ok?: boolean; token?: string };
        validIdTokenAccepted200 = resValid.status === 200 && validJson.ok === true && Boolean(validJson.token);
      } finally {
        if (prevGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
        else process.env.GOOGLE_CLIENT_ID = prevGoogleClientId;
        globalThis.fetch = prevFetchOAuth;
      }

      check(
        "Behavioural OAuth Security: foreign Google accessToken rejected (400), foreign aud/azp rejected (401), missing/mismatched OIDC nonce rejected (401), and audience+nonce-verified ID token succeeds (200)",
        accessTokenRejected400 &&
          foreignAudRejected401 &&
          foreignAzpRejected401 &&
          missingNonceRejected401 &&
          wrongNonceRejected401 &&
          validIdTokenAccepted200,
      );

      // 2. P1.3 Behavioural Soy Watchlist & Server-Gated Locked Swap Suite
      const soyWatchCtc = await runScan({
        productTitle: "Cinnamon Toast Crunch",
        store: "walmart",
        dietaryWatchlist: ["soy"],
      });
      const gatedDevId = `dev_behav_gate_${Date.now()}`;
      const gatedSecret = "sec_behav_gate_1234567890";
      const gatedDevice = await getOrCreateDevice(gatedDevId, gatedSecret);
      gatedDevice.weeklySwapsUsed = ["item_0", "item_1", "item_2", "item_3", "item_4", "item_5"];
      await saveDevice(gatedDevice);
      const exhaustedScan = await runScan({
        productTitle: "Cinnamon Toast Crunch",
        store: "walmart",
        surface: "android",
        clientPlatform: "android",
        deviceId: gatedDevId,
        deviceSecret: gatedSecret,
      });

      check(
        "Behavioural Soy Watchlist & Free-Tier Swap Lock: Cinnamon Toast Crunch with soy watchlist never returns soy-containing Ezekiel 4:9, and exhausted free device receives locked: true with zero store URLs",
        Boolean(
          soyWatchCtc.ok &&
            soyWatchCtc.swap &&
            !/soy|ezekiel/i.test(`${soyWatchCtc.swap.title} ${soyWatchCtc.swap.ingredients}`) &&
            soyWatchCtc.swap.score >= 85 &&
            exhaustedScan.ok &&
            exhaustedScan.swap &&
            exhaustedScan.swap.locked === true &&
            exhaustedScan.swap.webUrl === undefined &&
            exhaustedScan.swap.deepLink === undefined &&
            exhaustedScan.swap.androidIntentUrl === undefined
        ),
      );

      // 3. P1.4, P2.7 & P2.11 Behavioural Gluten-Free, Category-Default, Cinnamon Over-Match, Cinnamon Chex & Ezekiel Label Suite
      const gfConesScan = await runScan({
        productTitle: "Joy Gluten Free Sugar Cones",
        store: "walmart",
      });
      const gfFishSticksScan = await runScan({
        productTitle: "Gluten Free Fish Sticks",
        store: "walmart",
      });
      const gfSoySauceSwap = resolveSwap({
        score: 25,
        productTitle: "Kikkoman Gluten Free Soy Sauce",
        store: "walmart",
      });
      const gfTeriyakiSwap = resolveSwap({
        score: 25,
        productTitle: "Gluten Free Teriyaki Sauce",
        store: "walmart",
      });
      const ctcRollsSwap = resolveSwap({
        score: 20,
        productTitle: "Pillsbury Cinnamon Toast Crunch Rolls",
        store: "walmart",
      });
      const cinnadustSwap = resolveSwap({
        score: 20,
        productTitle: "Cinnamon Toast Crunch Cinnadust Seasoning Blend",
        store: "walmart",
      });
      const ctcBarsSwap = resolveSwap({
        score: 20,
        productTitle: "Cinnamon Toast Crunch Cereal Bars",
        store: "walmart",
      });
      const paneraBagelsSwap = resolveSwap({
        score: 20,
        productTitle: "Panera Cinnamon Crunch Bagels",
        store: "walmart",
      });
      const cinnamonChexScan = await runScan({
        productTitle: "Cinnamon Chex",
        store: "walmart",
      });
      const ezekielDirectScan = await runScan({
        productTitle: "Food For Life Ezekiel 4:9 Cinnamon Raisin Sprouted Whole Grain Cereal",
        store: "walmart",
      });

      check(
        "Behavioural Swap Category, Gluten-Free, Cinnamon Over-Match & Verified Ezekiel US Label Suite: Sugar Cones/Fish Sticks/GF Soy Sauce/Teriyaki never cross-swap to Fruit Bars/Salmon/Ranch, Cinnamon Rolls/Cinnadust/Bars/Bagels never swap to Ezekiel cereal, Cinnamon Chex swaps only to gluten-free & soy-free cereal, and Ezekiel 4:9 matches 57g US label",
        Boolean(
          (!gfConesScan.ok || gfConesScan.swap === null) &&
            (!gfFishSticksScan.ok || gfFishSticksScan.swap === null) &&
            gfSoySauceSwap === null &&
            gfTeriyakiSwap === null &&
            ctcRollsSwap === null &&
            cinnadustSwap === null &&
            ctcBarsSwap === null &&
            !/ezekiel/i.test(paneraBagelsSwap?.title ?? "") &&
            cinnamonChexScan.ok &&
            cinnamonChexScan.swap &&
            !/\b(wheat|barley|spelt|soy|soybeans?|ezekiel)\b|heritage\s+flakes/i.test(
              `${cinnamonChexScan.swap.title} ${cinnamonChexScan.swap.ingredients}`,
            ) &&
            ezekielDirectScan.ok &&
            ezekielDirectScan.product?.nutrition?.caloriesKcal100g === 333 &&
            ezekielDirectScan.product?.nutrition?.sodiumMg100g === 228 &&
            ezekielDirectScan.product?.nutrition?.fiberG100g === 8.8 &&
            /rosemary\s+extract/i.test(ezekielDirectScan.product?.ingredients ?? "")
        ),
      );

      // 4. P1.5 Behavioural Barcode Miss & Conflicting Barcode Fallback Suite
      const prevFetchBarcode = globalThis.fetch;
      let unknownBarcodeFallbackScan: Awaited<ReturnType<typeof runScan>> | null = null;
      let conflictingBarcodeScan: Awaited<ReturnType<typeof runScan>> | null = null;
      try {
        globalThis.fetch = async (input: RequestInfo | URL) => {
          const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (u.includes("0028400090896") || u.includes("28400090896")) {
            return Response.json({
              status: 1,
              product: {
                code: "0028400090896",
                brands: "Doritos",
                product_name: "Nacho Cheese Tortilla Chips",
                ingredients_text_en:
                  "Corn, Vegetable Oil (Corn, Canola, and/or Sunflower Oil), Maltodextrin, Salt, Cheddar Cheese, Monosodium Glutamate, Artificial Color (Yellow 6, Yellow 5, Red 40).",
                countries_tags: ["en:united-states"],
              },
            });
          }
          return Response.json({ status: 0, hits: [], products: [], foods: [] });
        };

        unknownBarcodeFallbackScan = await runScan({
          barcode: "00099999999995",
          productTitle: "Cinnamon Toast Crunch",
          store: "walmart",
        });
        conflictingBarcodeScan = await runScan({
          barcode: "0028400090896",
          productTitle: "Jif Creamy Peanut Butter",
          store: "walmart",
        });
      } finally {
        globalThis.fetch = prevFetchBarcode;
      }

      check(
        "Behavioural Barcode Fallback & Cross-Product Guard: unknown barcode falls back to productTitle instead of 404, conflicting Doritos barcode on Jif Peanut Butter page discards Doritos and scores Peanut Butter, GTIN-14 normalizes cleanly, and cacheKey isolates barcode+title pairs",
        Boolean(
          normalizeBarcode("00012000161155") === "012000161155" &&
            normalizeBarcode("04012345678901") === "4012345678901" &&
            cacheKey({ barcode: "0028400090896", productTitle: "Jif Creamy Peanut Butter" }) !==
              cacheKey({ productTitle: "Jif Creamy Peanut Butter" }) &&
            cacheKey({ barcode: "0028400090896", productTitle: "Jif Creamy Peanut Butter" }) !==
              cacheKey({ barcode: "0028400090896" }) &&
            unknownBarcodeFallbackScan?.ok &&
            /cinnamon\s+toast\s+crunch/i.test(unknownBarcodeFallbackScan.product?.title ?? "") &&
            conflictingBarcodeScan?.ok &&
            !/doritos|tortilla/i.test(conflictingBarcodeScan.product?.title ?? "") &&
            /peanut\s+butter/i.test(conflictingBarcodeScan.product?.title ?? "")
        ),
      );

      // 5. P1.6 Behavioural Idempotent Title Normalization & Mixed-Case Preservation Suite
      const titleCases: Array<[string, string]> = [
        ["Great Value 2% REduced FAt MIlk", "Great Value 2% Reduced Fat Milk"],
        ["REDuced FAT MILk", "Reduced Fat Milk"],
        ["100% PUre PUmpkin", "100% Pure Pumpkin"],
        ["ORganic Whole Milk", "Organic Whole Milk"],
        ["Frank's RedHot Original Cayenne Pepper Sauce", "Frank's RedHot Original Cayenne Pepper Sauce"],
        ["DeLallo Organic Whole Wheat Pasta", "DeLallo Organic Whole Wheat Pasta"],
        ["SmartFood White Cheddar Popcorn", "SmartFood White Cheddar Popcorn"],
      ];
      const allTitlesCleanAndIdempotent = titleCases.every(([raw, expected]) => {
        const once = normalizeOffDisplayTitle(raw);
        const twice = normalizeOffDisplayTitle(once);
        const thrice = normalizeOffDisplayTitle(twice);
        return once === expected && twice === once && thrice === once;
      });

      check(
        "Behavioural Title Normalization Idempotency: heals Shift-hold leading-cap mangling ('REduced FAt MIlk', 'REDuced FAT MILk', '100% PUre PUmpkin', 'ORganic') while preserving genuine mixed-case words ('RedHot', 'DeLallo', 'SmartFood') with f(f(x)) === f(x)",
        allTitlesCleanAndIdempotent,
      );

      // 6. 24-Hour Dual Audit Remediation Suite (P0 / P1 / P2 Behavioural & Cross-Surface Regressions)
      {
        const fsSync = await import("node:fs");
        const vmMod = await import("node:vm");
        const { runScan, runBatchScan } = await import("../lib/scan");
        const { resolveSwapCandidates } = await import("../lib/swaps");
        const scanRouteMod = await import("../app/api/scan/route");
        const prodImgRouteMod = await import("../app/api/product-image/route");
        const ALL_7_ALLERGENS = [
          "peanuts_nuts",
          "dairy",
          "wheat_gluten",
          "soy",
          "egg",
          "shellfish_fish",
          "sesame",
        ] as const;

        // P0-2: All 5 multi-part, UK soya, and unpunctuated OCR ingredient strings retain real allergens through runScan
        const p02Case1 = await runScan({
          productTitle: "Dulce de Leche Pecan Ice Cream",
          rawIngredients: "Cream, Skim Milk, Sugar. Dulce de Leche Swirl: Milk, Sugar, Egg Yolks, Pecans.",
          dietaryWatchlist: [...ALL_7_ALLERGENS],
          skipAnalytics: true,
        });
        const p02Case2 = await runScan({
          productTitle: "Filled Sandwich Cookies",
          rawIngredients: "Cookie: Wheat Flour, Sugar, Palm Oil. Ingredients of filling: Peanut Butter, Sugar, Sesame Seeds.",
          dietaryWatchlist: [...ALL_7_ALLERGENS],
          skipAnalytics: true,
        });
        const p02Case3 = await runScan({
          productTitle: "Milk Chocolate Hazelnut Bar",
          rawIngredients: "Sugar, Cocoa Butter, Cocoa Mass. Emulsifier: Soya Lecithin. Contains Milk, Hazelnuts.",
          dietaryWatchlist: [...ALL_7_ALLERGENS],
          skipAnalytics: true,
        });
        const p02Case4 = await runScan({
          productTitle: "Crunchy Almond Oat Clusters",
          rawIngredients: "Oats, Sugar, Palm Oil, may contain peanuts, Almond Butter, Egg Whites, Salt",
          dietaryWatchlist: [...ALL_7_ALLERGENS],
          skipAnalytics: true,
        });
        const p02Case5 = await runScan({
          productTitle: "Honey Almond Granola Bar",
          rawIngredients: "May contain traces of peanuts and milk Ingredients - Oats, Almonds, Honey, Whey",
          dietaryWatchlist: [...ALL_7_ALLERGENS],
          skipAnalytics: true,
        });
        const alertKeysOf = (res: Awaited<ReturnType<typeof runScan>>) =>
          new Set((res.ok ? (res.dietaryAlerts ?? []) : []).map((a) => a.id));
        const k1 = alertKeysOf(p02Case1);
        const k2 = alertKeysOf(p02Case2);
        const k3 = alertKeysOf(p02Case3);
        const k4 = alertKeysOf(p02Case4);
        const k5 = alertKeysOf(p02Case5);

        check(
          "P0-2 Allergen & OCR Spillover Safety: all 5 multi-part / UK soya / mid-sentence may-contain ingredient labels preserve every real allergen through runScan",
          Boolean(
            p02Case1.ok &&
              p02Case3.ok &&
              k1.has("dairy") &&
              k1.has("egg") &&
              k1.has("peanuts_nuts") &&
              p02Case1.alertSeverity === "allergen" &&
              k2.has("wheat_gluten") &&
              k2.has("peanuts_nuts") &&
              k2.has("sesame") &&
              k3.has("soy") &&
              k3.has("dairy") &&
              k3.has("peanuts_nuts") &&
              p02Case3.result?.flagged.some((f) => f.id === "soylecithin") &&
              k4.has("peanuts_nuts") &&
              k4.has("egg") &&
              k5.has("peanuts_nuts") &&
              k5.has("dairy"),
          ),
        );

        // Codex #6 + Codex #3 + P1-6 + Codex #14: Precautionary cross-contact non-penalty, conventional oats + Organic Cane Sugar pesticide risk, alertSeverity, and Potassium vs Sodium Phosphate
        const crossContactSoy = scoreIngredients("Whole Grain Oats. May contain traces of soy lecithin.");
        const realSoyLecithin = scoreIngredients("Sugar, Cocoa Butter, Soy Lecithin.");
        const convOatsWithOrgSugar = await runScan({
          productTitle: "Maple Brown Sugar Instant Oatmeal",
          rawIngredients: "Whole Grain Rolled Oats, Organic Cane Sugar, Sea Salt.",
          dietaryWatchlist: ["pesticide_risk"],
          skipAnalytics: true,
        });
        const kPhosOnly = scoreIngredients("Oat Base (Water, Oats), Dipotassium Phosphate, Sea Salt.");
        const naPhosOnly = scoreIngredients("Pork, Water, Salt, Sodium Phosphate.");

        check(
          "Scoring & Dietary Precision: precautionary soy lecithin has 0 additive penalty, conventional oats + Organic Cane Sugar triggers advisory pesticide_risk, and Potassium vs Sodium Phosphate are named accurately",
          Boolean(
            crossContactSoy.score === 100 &&
              crossContactSoy.flagged.length === 0 &&
              realSoyLecithin.flagged.some((f) => f.id === "soylecithin") &&
              convOatsWithOrgSugar.ok &&
              convOatsWithOrgSugar.dietaryAlerts?.some(
                (a) => a.id === "pesticide_risk" && a.reason.includes("USDA Pesticide Data Program"),
              ) &&
              convOatsWithOrgSugar.alertSeverity === "advisory" &&
              kPhosOnly.flagged.some((f) => f.id === "naphosphate" && f.name === "Potassium Phosphate") &&
              naPhosOnly.flagged.some((f) => f.id === "naphosphate" && f.name === "Sodium Phosphate"),
          ),
        );

        // P1-7 + Codex #15 + Codex #13 + P2-6 + P2-7 + Codex #8: Category estimate flag, Dough Conditioner food inclusion, swap candidate parity, and null-prototype batch safety
        const prevFetchBatch = globalThis.fetch;
        let catEstimateScan!: Awaited<ReturnType<typeof runScan>>;
        let verifiedCatalogScan!: Awaited<ReturnType<typeof runScan>>;
        let batchProtoAndFoodRes!: Awaited<ReturnType<typeof runBatchScan>>;
        try {
          globalThis.fetch = async (input: RequestInfo | URL) => {
            const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (/dough/i.test(decodeURIComponent(u))) {
              return Response.json({
                hits: [
                  {
                    code: "0041220001122",
                    product_name_en: "Artisan Bakery Dough Conditioner",
                    brands: "King Arthur",
                    countries_tags: ["en:united-states"],
                    ingredients_text_en: "Wheat Flour, Malted Barley Flour, Ascorbic Acid, Enzymes.",
                  },
                ],
                products: [
                  {
                    code: "0041220001122",
                    product_name_en: "Artisan Bakery Dough Conditioner",
                    brands: "King Arthur",
                    countries_tags: ["en:united-states"],
                    ingredients_text_en: "Wheat Flour, Malted Barley Flour, Ascorbic Acid, Enzymes.",
                  },
                ],
              });
            }
            return Response.json({ products: [], hits: [], foods: [] });
          };
          catEstimateScan = await runScan({
            productTitle: "Classic Caesar Salad Dressing, 16 fl oz",
            store: "walmart",
            skipAnalytics: true,
          });
          verifiedCatalogScan = await runScan({
            productTitle: "Quaker Old Fashioned Oats, 42 oz",
            store: "walmart",
            skipAnalytics: true,
          });
          batchProtoAndFoodRes = await runBatchScan({ store: "walmart" }, [
            { id: "__proto__", productTitle: "Quaker Old Fashioned Oats" },
            { id: "constructor", productTitle: "Quaker Old Fashioned Oats" },
            { id: "hb_dough_1", productTitle: "King Arthur Artisan Bakery Dough Conditioner" },
            { id: "hb_hair_2", productTitle: "Pantene Pro-V Daily Moisture Renewal Conditioner" },
          ]);
        } finally {
          globalThis.fetch = prevFetchBatch;
        }
        const mochaCands = resolveSwapCandidates({
          score: 35,
          productTitle: "Starbucks Bottled Mocha Frappuccino Coffee Drink",
          store: "walmart",
        });
        const mochaSingle = resolveSwap({
          score: 35,
          productTitle: "Starbucks Bottled Mocha Frappuccino Coffee Drink",
          store: "walmart",
        });
        const premierCands = resolveSwapCandidates({
          score: 42,
          productTitle: "Premier Protein Chocolate Shake",
          store: "walmart",
        });
        const premierSingle = resolveSwap({
          score: 42,
          productTitle: "Premier Protein Chocolate Shake",
          store: "walmart",
        });
        const allSwapCandsClean = [...mochaCands, ...premierCands].every((cand) => {
          const matchedAlt =
            Object.values(CLEAN_ALTERNATIVES).find((a) => `${a.brand} ${a.name}` === cand.title) ||
            EXACT_PRODUCT_ALTERNATIVES.map((e) => e.alt).find((a) => `${a.brand} ${a.name}` === cand.title);
          if (!matchedAlt) return true;
          return scoreIngredients(matchedAlt.ingredients).flagged.every((f) => f.risk === "low");
        });

        check(
          "Batch & Swap Hardening: isCategoryEstimate flags estimates, 'Dough Conditioner' grades as food while hair conditioner is skipped, __proto__ IDs cannot pollute Object.prototype, duplicate batch field is omitted, and resolveSwapCandidates matches resolveSwap eligibility",
          Boolean(
            catEstimateScan.ok &&
              catEstimateScan.isCategoryEstimate === true &&
              verifiedCatalogScan.ok &&
              verifiedCatalogScan.isCategoryEstimate === false &&
              Object.getPrototypeOf(batchProtoAndFoodRes.results) === null &&
              !("batch" in (batchProtoAndFoodRes as unknown as Record<string, unknown>)) &&
              !Object.prototype.hasOwnProperty.call(batchProtoAndFoodRes.results, "__proto__") &&
              !Object.prototype.hasOwnProperty.call(batchProtoAndFoodRes.results, "constructor") &&
              (({} as Record<string, unknown>).ok === undefined) &&
              batchProtoAndFoodRes.results.hb_dough_1?.ok === true &&
              batchProtoAndFoodRes.results.hb_hair_2?.ok === false &&
              mochaSingle &&
              mochaCands.some((c) => c.title === mochaSingle.title) &&
              premierSingle &&
              premierCands.some((c) => c.title === premierSingle.title) &&
              allSwapCandsClean,
          ),
        );

        // P1-2: Weighted batch rate limiting on POST /api/scan (8-item batch costs ceil(8/2)=4 tokens against 120/min budget -> 429 on batch #31 with Retry-After)
        let batch429Status = 0;
        let batch429RetryAfter = "";
        let batchesSucceededBefore429 = 0;
        for (let b = 1; b <= 35; b++) {
          const res = await scanRouteMod.POST(
            new Request("http://localhost:3000/api/scan", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-forwarded-for": "10.199.77.88",
              },
              body: JSON.stringify({
                store: "walmart",
                items: Array.from({ length: 8 }, (_, idx) => ({
                  id: `c${idx + 1}`,
                  productTitle: "Quaker Old Fashioned Oats, 42 oz",
                })),
              }),
            }),
          );
          if (res.status === 429) {
            batch429Status = res.status;
            batch429RetryAfter = res.headers.get("Retry-After") ?? "";
            break;
          }
          if (res.status === 200) batchesSucceededBefore429++;
        }

        check(
          "P1-2 Weighted Batch Rate Limit: 8-item batches consume proportional tokens (throttling at 30 batches = 120 weighted units instead of allowing 120*8=960 scans/min) and emit Retry-After",
          batchesSucceededBefore429 === 30 && batch429Status === 429 && Number(batch429RetryAfter) >= 1,
        );

        // Codex #5 + P2-8: Pre-created unverified password/session revoked upon verified Google OIDC claim + single-use OIDC token replay rejection
        const prevClientId2 = process.env.GOOGLE_CLIENT_ID;
        const prevFetch2 = globalThis.fetch;
        let preAccountPasswordRevoked = false;
        let preAccountSessionRevoked = false;
        let oidcReplayRejected401 = false;
        try {
          process.env.GOOGLE_CLIENT_ID = "heybroc-test-web-client.apps.googleusercontent.com";
          globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (u.includes("googleapis.com/oauth2/v3/certs")) {
              return Response.json({
                keys: [{ ...jwk, kid: testKid, kty: "RSA", alg: "RS256", use: "sig" }],
              });
            }
            return prevFetch2(input, init);
          };

          const takeoverEmail = `precreated.${Date.now()}@example.com`;
          const regRes = await authRouteMod.POST(
            new Request("http://localhost:3000/api/auth", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-forwarded-for": "10.188.99.21" },
              body: JSON.stringify({
                action: "register",
                email: takeoverEmail,
                password: "AttackerPassword123!",
                deviceId: "dev_attacker_precreated_1",
              }),
            }),
          );
          const regJson = (await regRes.json()) as { token?: string };
          const attackerOldToken = regJson.token ?? "";

          const cfgRes = await authRouteMod.GET(
            new Request("http://localhost:3000/api/auth?config=1", {
              headers: { "x-forwarded-for": "10.188.99.22" },
            }),
          );
          const cfgJson = (await cfgRes.json()) as { oauthNonce?: string };
          const serverNonce = cfgJson.oauthNonce ?? "";

          const ownerIdToken = signMockGoogleJwt({
            sub: `google-owner-${Date.now()}`,
            email: takeoverEmail,
            email_verified: true,
            aud: "heybroc-test-web-client.apps.googleusercontent.com",
            azp: "heybroc-test-web-client.apps.googleusercontent.com",
            nonce: serverNonce,
          });

          const claimRes = await authRouteMod.POST(
            new Request("http://localhost:3000/api/auth", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-forwarded-for": "10.188.99.22" },
              body: JSON.stringify({
                action: "oauth",
                provider: "google",
                idToken: ownerIdToken,
                nonce: serverNonce,
              }),
            }),
          );

          // 1) Attacker tries logging in with the pre-created password -> must be rejected (400/401, ok: false)
          const attackerLoginRes = await authRouteMod.POST(
            new Request("http://localhost:3000/api/auth", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-forwarded-for": "10.188.99.23" },
              body: JSON.stringify({
                action: "login",
                email: takeoverEmail,
                password: "AttackerPassword123!",
              }),
            }),
          );
          const attackerLoginJson = (await attackerLoginRes.json()) as { ok?: boolean };
          preAccountPasswordRevoked =
            claimRes.status === 200 && !attackerLoginRes.ok && attackerLoginJson.ok === false;

          // 2) Attacker tries using old bearer token -> must be unauthenticated
          const oldSessionCheck = await authRouteMod.GET(
            new Request("http://localhost:3000/api/auth", {
              headers: {
                Authorization: `Bearer ${attackerOldToken}`,
                "x-forwarded-for": "10.188.99.23",
              },
            }),
          );
          const oldSessionJson = (await oldSessionCheck.json()) as { authenticated?: boolean };
          preAccountSessionRevoked = oldSessionJson.authenticated === false;

          // 3) Replaying the exact same Google idToken a second time -> must be 401
          const replayRes = await authRouteMod.POST(
            new Request("http://localhost:3000/api/auth", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-forwarded-for": "10.188.99.24" },
              body: JSON.stringify({
                action: "oauth",
                provider: "google",
                idToken: ownerIdToken,
                nonce: serverNonce,
              }),
            }),
          );
          oidcReplayRejected401 = replayRes.status === 401;
        } finally {
          if (prevClientId2 === undefined) delete process.env.GOOGLE_CLIENT_ID;
          else process.env.GOOGLE_CLIENT_ID = prevClientId2;
          globalThis.fetch = prevFetch2;
        }

        check(
          "OAuth Pre-Account Takeover & Replay Defense: verified Google OAuth claim wipes unverified pre-created password + linked devices + old sessions and rejects single-use OIDC token/nonce replay",
          preAccountPasswordRevoked && preAccountSessionRevoked && oidcReplayRejected401,
        );

        // Codex #16: /api/product-image brand + barcode cache isolation
        const prevFetchImg = globalThis.fetch;
        let brandAlphaBody = "";
        let brandBetaBody = "";
        try {
          const fakePngAlpha = new Uint8Array(260);
          fakePngAlpha.set([137, 80, 78, 71, 13, 10, 26, 10, 65, 76, 80, 72, 65]);
          fakePngAlpha.fill(65, 16);
          const fakePngBeta = new Uint8Array(260);
          fakePngBeta.set([137, 80, 78, 71, 13, 10, 26, 10, 66, 69, 84, 65, 33]);
          fakePngBeta.fill(66, 16);
          globalThis.fetch = async (input: RequestInfo | URL) => {
            const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (u.includes("0011111111115")) {
              return Response.json({
                status: 1,
                product: { image_front_small_url: "https://images.openfoodfacts.org/images/products/alpha.png" },
              });
            }
            if (u.includes("0022222222221")) {
              return Response.json({
                status: 1,
                product: { image_front_small_url: "https://images.openfoodfacts.org/images/products/beta.png" },
              });
            }
            if (u.endsWith("/alpha.png")) {
              return new Response(fakePngAlpha, { status: 200, headers: { "content-type": "image/png" } });
            }
            if (u.endsWith("/beta.png")) {
              return new Response(fakePngBeta, { status: 200, headers: { "content-type": "image/png" } });
            }
            return Response.json({ products: [], hits: [] });
          };
          const resAlpha = await prodImgRouteMod.GET(
            new Request(
              "http://localhost:3000/api/product-image?q=Organic%20Whole%20Milk&brand=BrandAlpha&code=0011111111115",
              { headers: { "x-forwarded-for": "10.177.66.11" } },
            ),
          );
          brandAlphaBody = Buffer.from(await resAlpha.arrayBuffer()).toString("hex");
          const resBeta = await prodImgRouteMod.GET(
            new Request(
              "http://localhost:3000/api/product-image?q=Organic%20Whole%20Milk&brand=BrandBeta&code=0022222222221",
              { headers: { "x-forwarded-for": "10.177.66.12" } },
            ),
          );
          brandBetaBody = Buffer.from(await resBeta.arrayBuffer()).toString("hex");
        } finally {
          globalThis.fetch = prevFetchImg;
        }

        check(
          "Product-Image Cache Isolation: distinct brand/barcode queries sharing the same generic product title never collide on title-only imageBytesCache",
          brandAlphaBody.length > 0 && brandBetaBody.length > 0 && brandAlphaBody !== brandBetaBody,
        );

        // P0-1 + P1-1 + P1-3 + P1-4 + P1-5 + P1-8 + Codex #17 + Codex #18: Cross-Surface Extension, iOS Live Shop JS VM Simulation, & Android Invariants
        const extContent = fsSync.readFileSync("chrome-extension/content.js", "utf8");
        const safContent = fsSync.readFileSync("ios-app/SafariExtension/Resources/content.js", "utf8");
        const extBg = fsSync.readFileSync("chrome-extension/background.js", "utf8");
        const safBg = fsSync.readFileSync("ios-app/SafariExtension/Resources/background.js", "utf8");
        const extCss = fsSync.readFileSync("chrome-extension/overlay.css", "utf8");
        const safCss = fsSync.readFileSync("ios-app/SafariExtension/Resources/overlay.css", "utf8");
        const iosLiveSwift = fsSync.readFileSync("ios-app/App/LiveStoreBrowserViewController.swift", "utf8");
        const androidMainKt = fsSync.readFileSync(
          "android-app/app/src/main/java/com/cleancart/overlay/MainActivity.kt",
          "utf8",
        );
        const androidReaderKt = fsSync.readFileSync(
          "android-app/app/src/main/java/com/cleancart/overlay/GroceryScreenReaderService.kt",
          "utf8",
        );
        const androidOverlayKt = fsSync.readFileSync(
          "android-app/app/src/main/java/com/cleancart/overlay/OverlayWindowService.kt",
          "utf8",
        );

        // Extract and execute iOS detectorJS inside a synthetic DOM VM to behaviourally verify P0-1 (reused card mutation oatmeal -> yogurt) & P1-4 (header/cart safety)!
        const detectorMatch = iosLiveSwift.match(/let detectorJS = """\n([\s\S]*?)\n\s+"""/);
        const unescapedDetectorJS = detectorMatch
          ? detectorMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\")
          : "";
        let detectorSyntaxValid = false;
        let p01ReusedCardInvalidatedAndRescanned = false;
        let p14HeaderPreservedOnAppLink = false;
        try {
          // Compile check
          new Function(unescapedDetectorJS);
          detectorSyntaxValid = true;

          // Synthetic DOM harness for iOS detectorJS reused-card lifecycle & banner safety
          const bridgeMessages: Array<Record<string, unknown>> = [];
          class MockElement {
            tagName: string;
            id = "";
            className = "";
            textContent = "";
            innerText = "";
            parentElement: MockElement | null = null;
            children: MockElement[] = [];
            attrs: Record<string, string> = {};
            styleMap: Record<string, string> = { display: "block", visibility: "visible", opacity: "1", position: "relative" };
            rect = { top: 140, bottom: 320, left: 16, right: 196, width: 180, height: 180 };
            isConnected = true;
            currentSrc = "";
            clicked = false;
            constructor(tag: string) {
              this.tagName = tag.toUpperCase();
            }
            get parentNode() {
              return this.parentElement;
            }
            setAttribute(k: string, v: string) {
              this.attrs[k] = String(v);
              if (k === "class") this.className = String(v);
              if (k === "id") this.id = String(v);
            }
            getAttribute(k: string) {
              if (k === "class") return this.className || null;
              if (k === "id") return this.id || null;
              return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
            }
            appendChild(ch: MockElement) {
              ch.parentElement = this;
              ch.isConnected = this.isConnected;
              this.children.push(ch);
              return ch;
            }
            removeChild(ch: MockElement) {
              const i = this.children.indexOf(ch);
              if (i !== -1) this.children.splice(i, 1);
              ch.parentElement = null;
              ch.isConnected = false;
              return ch;
            }
            getBoundingClientRect() {
              return this.rect;
            }
            get style() {
              const self = this;
              return {
                get position() {
                  return self.styleMap.position || "static";
                },
                set position(v: string) {
                  self.styleMap.position = v;
                },
                get display() {
                  return self.styleMap.display || "block";
                },
                set display(v: string) {
                  self.styleMap.display = v;
                },
                setProperty(k: string, v: string) {
                  self.styleMap[k] = v;
                },
              };
            }
            get classList() {
              const self = this;
              return {
                contains(cls: string) {
                  return self.className.split(/\s+/).includes(cls);
                },
              };
            }
            click() {
              this.clicked = true;
            }
            matchesSimple(sel: string): boolean {
              const s = sel.trim();
              if (s === "*") return true;
              if (s === ":scope > .hb-photo-badge") return false;
              if (s.startsWith(".hb-photo-badge[data-hb-card-id=")) {
                const wantId = s.match(/data-hb-card-id="([^"]+)"/)?.[1] ?? "";
                return this.classList.contains("hb-photo-badge") && this.getAttribute("data-hb-card-id") === wantId;
              }
              if (s === ".hb-photo-badge") return this.classList.contains("hb-photo-badge");
              if (s === '[data-hb-app-banner-hidden="1"]') return this.getAttribute("data-hb-app-banner-hidden") === "1";
              if (s === '[data-testid*="product-card" i]' || s.includes("product-card")) {
                return (this.getAttribute("data-testid") || "").toLowerCase().includes("product-card");
              }
              if (s === '[data-testid*="product-title" i]') {
                return (this.getAttribute("data-testid") || "").toLowerCase().includes("product-title");
              }
              if (s === 'a[href*="/ip/"]' || s === "a[href]") {
                return this.tagName === "A" && Boolean(this.getAttribute("href"));
              }
              if (/^[a-z0-9]+$/i.test(s)) return this.tagName === s.toUpperCase();
              return false;
            }
            matchesAny(selectorGroup: string): boolean {
              return selectorGroup.split(",").some((part) => this.matchesSimple(part));
            }
            closest(selectorGroup: string): MockElement | null {
              let cur: MockElement | null = this;
              while (cur) {
                if (cur.matchesAny(selectorGroup)) return cur;
                cur = cur.parentElement;
              }
              return null;
            }
            querySelectorAll(selectorGroup: string): MockElement[] {
              if (selectorGroup === ":scope > .hb-photo-badge") {
                return this.children.filter((c) => c.classList.contains("hb-photo-badge"));
              }
              if (selectorGroup === ".hb-photo-badge") {
                const badges: MockElement[] = [];
                const walkB = (n: MockElement) => {
                  for (const ch of n.children) {
                    if (ch.classList.contains("hb-photo-badge")) badges.push(ch);
                    walkB(ch);
                  }
                };
                walkB(this);
                return badges;
              }
              const out: MockElement[] = [];
              const walk = (node: MockElement) => {
                for (const ch of node.children) {
                  if (ch.matchesAny(selectorGroup)) out.push(ch);
                  walk(ch);
                }
              };
              walk(this);
              return out;
            }
            querySelector(selectorGroup: string): MockElement | null {
              return this.querySelectorAll(selectorGroup)[0] ?? null;
            }
          }

          const docEl = new MockElement("html");
          const headEl = docEl.appendChild(new MockElement("head"));
          const bodyEl = docEl.appendChild(new MockElement("body"));

          // Site <header> containing a "Get the app" link AND a cart button — P1-4 must NEVER hide <header> or click the cart icon!
          const siteHeader = bodyEl.appendChild(new MockElement("header"));
          siteHeader.rect = { top: 0, bottom: 64, left: 0, right: 390, width: 390, height: 64 };
          const headerAppLink = siteHeader.appendChild(new MockElement("a"));
          headerAppLink.textContent = "Get the app";
          headerAppLink.setAttribute("href", "https://apps.apple.com/app/id123");
          const headerCartBtn = siteHeader.appendChild(new MockElement("button"));
          headerCartBtn.setAttribute("aria-label", "Close cart drawer");

          // Reusable product card (starts as Quaker Oatmeal, then mutates in place to Chobani Greek Yogurt)
          const cardEl = bodyEl.appendChild(new MockElement("div"));
          cardEl.setAttribute("data-testid", "product-card");
          const photoWrap = cardEl.appendChild(new MockElement("div"));
          const imgEl = photoWrap.appendChild(new MockElement("img"));
          imgEl.setAttribute("src", "https://cdn.example.com/oatmeal.jpg");
          const linkEl = cardEl.appendChild(new MockElement("a"));
          linkEl.setAttribute("href", "/ip/111");
          const titleEl = linkEl.appendChild(new MockElement("span"));
          titleEl.setAttribute("data-testid", "product-title");
          titleEl.textContent = "Quaker Old Fashioned Oats, 42 oz";

          const clickListeners: Array<(ev: Record<string, unknown>) => void> = [];
          let nextTimerId = 1;
          const pendingTimers = new Map<number, () => void>();
          const flushVmTimers = () => {
            let guard = 0;
            while (pendingTimers.size > 0 && guard++ < 50) {
              const firstKey = pendingTimers.keys().next().value!;
              const fn = pendingTimers.get(firstKey)!;
              pendingTimers.delete(firstKey);
              fn();
            }
          };
          const sandbox: Record<string, unknown> = {
            window: null as unknown,
            document: {
              documentElement: docEl,
              head: headEl,
              body: bodyEl,
              getElementById: (id: string) =>
                docEl.querySelectorAll("*").find((n) => n.id === id) ??
                (headEl.children.find((n) => n.id === id) ?? null),
              createElement: (tag: string) => new MockElement(tag),
              querySelectorAll: (sel: string) => docEl.querySelectorAll(sel),
              querySelector: (sel: string) => docEl.querySelector(sel),
              addEventListener: (type: string, fn: (ev: Record<string, unknown>) => void) => {
                if (type === "click") clickListeners.push(fn);
              },
            },
            location: {
              href: "https://www.walmart.com/search?q=oatmeal",
              hostname: "www.walmart.com",
              pathname: "/search",
              search: "?q=oatmeal",
            },
            history: { pushState: () => {}, replaceState: () => {} },
            MutationObserver: class {
              observe() {}
              disconnect() {}
            },
            WeakMap,
            WeakSet,
            Math,
            Date,
            Number,
            String,
            Boolean,
            Array,
            Object,
            JSON,
            RegExp,
            parseInt,
            setTimeout: (fn: () => void) => {
              const id = nextTimerId++;
              pendingTimers.set(id, fn);
              return id;
            },
            clearTimeout: (id: number) => {
              pendingTimers.delete(id);
            },
          };
          const winObj = {
            ...sandbox,
            innerWidth: 390,
            innerHeight: 844,
            addEventListener: () => {},
            getComputedStyle: (el: MockElement) => el.styleMap,
            webkit: {
              messageHandlers: {
                heybrocStoreBridge: {
                  postMessage: (msg: Record<string, unknown>) => bridgeMessages.push(msg),
                },
              },
            },
          };
          sandbox.window = winObj;
          vmMod.runInNewContext(unescapedDetectorJS, sandbox);
          flushVmTimers();

          p14HeaderPreservedOnAppLink =
            siteHeader.styleMap.display !== "none" && !headerCartBtn.clicked;

          const firstBatchMsg = bridgeMessages.find((m) => m.kind === "gridBatch") as
            | { items: Array<{ id: string; productTitle: string }> }
            | undefined;
          const firstItem = firstBatchMsg?.items?.[0];
          if (firstItem && typeof (winObj as Record<string, unknown>).__heybrocApplyCardBadges === "function") {
            ((winObj as Record<string, unknown>).__heybrocApplyCardBadges as (m: Record<string, unknown>) => void)({
              [firstItem.id]: { ok: true, score: 92, hasAlert: false, alertSeverity: "none", isCategoryEstimate: false },
            });
            // Now mutate the SAME cardEl in place to Yogurt (simulating React index-keyed list reuse!)
            titleEl.textContent = "Chobani Non-Fat Plain Greek Yogurt, 32 oz";
            linkEl.setAttribute("href", "/ip/222");
            imgEl.setAttribute("src", "https://cdn.example.com/yogurt.jpg");

            // Even BEFORE a MutationObserver pass runs, tapping the stale badge on the mutated card must inspect the LIVE Yogurt title, NEVER Oatmeal!
            const currentBadge = photoWrap.querySelector(".hb-photo-badge");
            if (currentBadge && clickListeners[0]) {
              clickListeners[0]({
                target: currentBadge,
                preventDefault() {},
                stopPropagation() {},
                stopImmediatePropagation() {},
              });
            }
            flushVmTimers();
            const inspectMsg = bridgeMessages.find((m) => m.kind === "inspectCard") as
              | { cardId: string; title: string }
              | undefined;
            const batchMsgs = bridgeMessages.filter((m) => m.kind === "gridBatch") as Array<{
              items: Array<{ id: string; productTitle: string }>;
            }>;
            const secondBatchHasYogurt = batchMsgs.some((bm) =>
              bm.items.some((it) => /Chobani Non-Fat Plain Greek Yogurt/i.test(it.productTitle)),
            );
            p01ReusedCardInvalidatedAndRescanned = Boolean(
              inspectMsg &&
                inspectMsg.cardId === "" &&
                /Chobani Non-Fat Plain Greek Yogurt/i.test(inspectMsg.title) &&
                !/Quaker/i.test(inspectMsg.title) &&
                secondBatchHasYogurt,
            );
          }
        } catch (err) {
          console.error("detectorJS VM check error:", err);
        }

        // Verify Android OAuth state check precedes SharedPreferences removal
        const oauthSliceStart = androidMainKt.indexOf("private fun handleIncomingAuthRedirect");
        const oauthSlice = oauthSliceStart >= 0 ? androidMainKt.slice(oauthSliceStart, oauthSliceStart + 3500) : "";
        const stateValidIdx = oauthSlice.indexOf("if (!stateValid)");
        const postValidRemoveIdx = oauthSlice.lastIndexOf('.remove("pending_google_oauth_state")');

        const crossSurfaceMap = {
          extSaf: extContent === safContent,
          cssSaf: extCss === safCss,
          extBgTimeout: extBg.includes("new AbortController()"),
          safBgTimeout: safBg.includes("new AbortController()"),
          sig: extContent.includes("computeCardSignature"),
          adv: extContent.includes("cc-photo-badge--advisory"),
          skip: extContent.includes("skipAnalytics: true"),
          stop: extContent.includes("stopImmediatePropagation"),
          detectorSyntaxValid,
          p14HeaderPreservedOnAppLink,
          p01ReusedCardInvalidatedAndRescanned,
          stateOrder: stateValidIdx > 0 && postValidRemoveIdx > stateValidIdx,
          scroll: androidReaderKt.includes("inspectCartScrollState"),
          boundary: androidReaderKt.includes("findSafeCartBoundaryIndex"),
          noCt: !androidReaderKt.includes("(?:ct|in\\s+(?:cart"),
          frames: androidOverlayKt.includes("consecutiveFullCartFrames >= 2"),
        };
        if (Object.values(crossSurfaceMap).some((v) => !v)) {
          console.error("crossSurfaceMap failure detail:", crossSurfaceMap);
        }

        check(
          "Cross-Surface Client Remediation: Chrome/Safari extension parity, iOS detectorJS VM reused-card invalidation (P0-1) + header/cart banner safety (P1-4), and Android OAuth/Cart/Quantity guards (P1-8, Codex #17, Codex #18)",
          Object.values(crossSurfaceMap).every(Boolean),
        );
      }

      // 7. Behavioural Android Dual-Mode Batch Scan + LiveStoreBrowserActivity JS VM & Overlay Parity Suite
      {
        const fsSync = await import("node:fs");
        const vmMod = await import("node:vm");
        const { runBatchScan } = await import("../lib/scan");

        const batchFreeId = `behav_android_batch_free_${Date.now()}`;
        const batchFreeSecret = "sec_behav_batch_free_1234567890";
        const batchFreeDev = await getOrCreateDevice(batchFreeId, batchFreeSecret);
        const batchFreeBeforeUsed = batchFreeDev.weeklySwapsUsed.length;

        const batchFreeRes = await runBatchScan(
          {
            deviceId: batchFreeId,
            deviceSecret: batchFreeSecret,
            surface: "android",
            clientPlatform: "android",
            store: "walmart",
            dietaryWatchlist: ["soy", "gluten"],
            familyWatchlist: ["dyes", "seedOils"],
            format: "json",
          },
          [
            { id: "g0", productTitle: "Cinnamon Toast Crunch" },
            { id: "g1", productTitle: "Dave's Killer Bread Organic 21 Whole Grains & Seeds Bread" },
            { id: "g2", productTitle: "Bounty Select-A-Size Paper Towels" },
          ],
        );
        const batchFreeAfterDev = await getOrCreateDevice(batchFreeId, batchFreeSecret);

        const batchExhaustedId = `behav_android_batch_exhausted_${Date.now()}`;
        const batchExhaustedSecret = "sec_behav_batch_exh_1234567890";
        const batchExhaustedDev = await getOrCreateDevice(batchExhaustedId, batchExhaustedSecret);
        batchExhaustedDev.weeklySwapsUsed = ["s0", "s1", "s2", "s3", "s4", "s5"];
        batchExhaustedDev.proUntil = 0;
        await saveDevice(batchExhaustedDev);

        const batchExhaustedRes = await runBatchScan(
          {
            deviceId: batchExhaustedId,
            deviceSecret: batchExhaustedSecret,
            surface: "android",
            clientPlatform: "android",
            store: "walmart",
            format: "json",
          },
          [{ id: "g0", productTitle: "Cinnamon Toast Crunch" }],
        );

        const g0Free = batchFreeRes.results["g0"];
        const g1Free = batchFreeRes.results["g1"];
        const g2Free = batchFreeRes.results["g2"];
        const g0Exh = batchExhaustedRes.results["g0"];

        check(
          "Behavioural Android Batch Scan: scores multi-card Walmart grid in 1 call, rejects non-food Paper Towels (422), preserves free swap quota on passive browse, and strips swap URLs when quota is exhausted",
          Boolean(
            batchFreeRes.ok === true &&
              g0Free &&
              g0Free.ok === true &&
              g0Free.result.score < 50 &&
              g0Free.swap &&
              g0Free.swap.locked !== true &&
              g1Free &&
              g1Free.ok === true &&
              g1Free.result.score >= 85 &&
              g2Free &&
              g2Free.ok === false &&
              g2Free.status === 422 &&
              batchFreeAfterDev.weeklySwapsUsed.length === batchFreeBeforeUsed &&
              g0Exh &&
              g0Exh.ok === true &&
              g0Exh.swap &&
              g0Exh.swap.locked === true &&
              g0Exh.swap.webUrl === undefined &&
              g0Exh.swap.deepLink === undefined &&
              g0Exh.swap.androidIntentUrl === undefined
          ),
        );

        const liveBrowserKt = fsSync.readFileSync(
          "android-app/app/src/main/java/com/cleancart/overlay/LiveStoreBrowserActivity.kt",
          "utf8",
        );
        const scanApiKt = fsSync.readFileSync(
          "android-app/app/src/main/java/com/cleancart/overlay/ScanApi.kt",
          "utf8",
        );
        const mainActivityKt = fsSync.readFileSync(
          "android-app/app/src/main/java/com/cleancart/overlay/MainActivity.kt",
          "utf8",
        );
        const overlayKt = fsSync.readFileSync(
          "android-app/app/src/main/java/com/cleancart/overlay/OverlayWindowService.kt",
          "utf8",
        );
        const readerKt = fsSync.readFileSync(
          "android-app/app/src/main/java/com/cleancart/overlay/GroceryScreenReaderService.kt",
          "utf8",
        );
        const manifestXml = fsSync.readFileSync(
          "android-app/app/src/main/AndroidManifest.xml",
          "utf8",
        );

        const detMatch = liveBrowserKt.match(
          /private const val DETECTOR_JS = """\n([\s\S]*?)\n        """/,
        );
        const earlyCssMatch = liveBrowserKt.match(
          /private const val EARLY_BANNER_CSS_JS = """\n([\s\S]*?)\n        """/,
        );
        let androidDetectorSyntaxValid = false;
        if (detMatch && detMatch[1] && earlyCssMatch && earlyCssMatch[1]) {
          try {
            new vmMod.Script(detMatch[1]);
            new vmMod.Script(earlyCssMatch[1]);
            androidDetectorSyntaxValid = true;
          } catch (e) {
            console.error("Android LiveStoreBrowserActivity JS syntax error:", e);
          }
        }

        const androidDualModeMap = {
          manifestRegistered:
            manifestXml.includes('.LiveStoreBrowserActivity') &&
            manifestXml.includes('android:exported="false"'),
          androidDetectorSyntaxValid,
          reusedCardWeakMap:
            Boolean(detMatch?.[1]?.includes("new WeakMap()")) &&
            Boolean(detMatch?.[1]?.includes("hbOwnerCardById")) &&
            Boolean(detMatch?.[1]?.includes("SENSITIVE_BANNER_PATH_RE")) &&
            Boolean(detMatch?.[1]?.includes("isCategoryEstimate")) &&
            Boolean(detMatch?.[1]?.includes("hb-photo-badge--advisory")),
          webviewHardened:
            liveBrowserKt.includes("allowFileAccess = false") &&
            liveBrowserKt.includes("allowContentAccess = false") &&
            liveBrowserKt.includes("MIXED_CONTENT_NEVER_ALLOW") &&
            liveBrowserKt.includes("isAllowedRetailerHost") &&
            liveBrowserKt.includes("isBlockedAppRedirectHost"),
          scanBatchCapped8:
            scanApiKt.includes("items.take(8)") &&
            scanApiKt.includes("VALID_BATCH_ITEM_ID_RE") &&
            scanApiKt.includes("classifyAlertSeverity"),
          smartDualModeRouting:
            mainActivityKt.includes("LiveStoreBrowserActivity.createIntent") &&
            mainActivityKt.includes("isPreferInAppShop") &&
            mainActivityKt.includes("resolveInstalledStorePackage"),
          zeroAllocPassThroughGridOverlay:
            overlayKt.includes("drawnRectPool = Array(12) { RectF() }") &&
            overlayKt.includes("FLAG_NOT_TOUCHABLE") &&
            overlayKt.includes("ACTION_SHOW_GRID_BADGES") &&
            readerKt.includes("if (res.isCategoryEstimate) continue") &&
            readerKt.includes("scheduleVisibleGridBatchScan"),
          iosNativeAlertPropertyValid:
            (() => {
              const iosLiveVc = fsSync.readFileSync(
                "ios-app/App/LiveStoreBrowserViewController.swift",
                "utf8",
              );
              return (
                iosLiveVc.includes("advisoryKeys.contains(alert.id)") &&
                !iosLiveVc.includes("alert.key")
              );
            })(),
        };
        if (Object.values(androidDualModeMap).some((v) => !v)) {
          console.error("androidDualModeMap failure detail:", androidDualModeMap);
        }
        check(
          "Android Dual-Mode Architecture & iOS/Android Parity: LiveStoreBrowserActivity hardened WebView + valid DETECTOR_JS (WeakMap sig invalidation, banner safety, category-estimate suppression), smart single-row store routing, zero-allocation pass-through GridScoreBadgesView, and iOS HeyBrocNativeAlert.id parity",
          Object.values(androidDualModeMap).every(Boolean),
        );
      }
    }
  }

  console.log("Checks executed:", checks);
  console.log(normalizeIngredients("Vegetable Oil (Soybean, Canola and/or Sunflower), corn, safflower or sunflower oil"));
  console.log(fail ? `${fail} FAILED` : "ALL CHECKS PASSED");
  process.exit(fail ? 1 : 0);
})();



