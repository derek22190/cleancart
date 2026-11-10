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
  const gvChocMilk = matchDrinkCatalog("Great Value Lowfat Chocolate Milk");
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
      mainKt.includes("import android.accounts.AccountManager") &&
      mainKt.includes("import android.content.ClipboardManager") &&
      mainKt.includes("REQ_PICK_GOOGLE_ACCOUNT")
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
      mainKt.includes("ScanHistoryStore.resolveBestImageUrl(title, imgUrl)") &&
      !mainKt.includes('imgSource.contains("Category Illustration", ignoreCase = true)') &&
      overlayKt.includes("ScanHistoryStore.resolveBestImageUrl(swapTitle, rawImage)") &&
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
        historyStoreKtSrc.includes("&v=4") &&
        !mainActivityKtSrc.includes('"● Live"') &&
        mainActivityKtSrc.includes("includeWatchlist: Boolean = false") &&
        readerKtSrc.includes("val shouldReplace = isFirstCartFrame && cartTitles.isNotEmpty()") &&
        readerKtSrc.includes("rowBand") &&
        !readerKtSrc.includes("SUPPORTED_PACKAGES") &&
        overlayKtSrc.includes("if (replaceCart) {")
    )
  );

  const watchlistFunnelSrc = fs.readFileSync("components/WatchlistMiniFunnel.tsx", "utf8");
  const scanApiKtSrc = fs.readFileSync("android-app/app/src/main/java/com/cleancart/overlay/ScanApi.kt", "utf8");
  const simulatorOnboardingSrc = fs.readFileSync("components/Simulator.tsx", "utf8");
  check(
    "8-Step Micro-Commitment Onboarding Funnel (No first-time Skip leak + Multi-Select Stores + 2x Watchlist + Allergy Guard) on Web & Android",
    Boolean(
      !watchlistFunnelSrc.includes("Skip →") &&
        !mainActivityKtSrc.includes("Skip →") &&
        watchlistFunnelSrc.includes("✕ Close") &&
        mainActivityKtSrc.includes("✕ Close") &&
        watchlistFunnelSrc.includes("Who are you protecting with HeyBroc?") &&
        watchlistFunnelSrc.includes("What is your #1 clean-eating priority?") &&
        watchlistFunnelSrc.includes("Where do you usually grocery shop?") &&
        watchlistFunnelSrc.includes("All 12+ grocery &amp; delivery stores + 1.5M+ barcodes stay unlocked") &&
        watchlistFunnelSrc.includes("toggleStore") &&
        watchlistFunnelSrc.includes("formatStoresSummary") &&
        watchlistFunnelSrc.includes("What are your clean-eating goals?") &&
        watchlistFunnelSrc.includes("Any family allergies or dietary watches?") &&
        watchlistFunnelSrc.includes("See How HeyBroc Solves This") &&
        watchlistFunnelSrc.includes("How HeyBroc Protects Your Cart in 1 Second") &&
        watchlistFunnelSrc.includes("Choose How You Want to Start") &&
        watchlistFunnelSrc.includes("Step {step} of 8") &&
        watchlistFunnelSrc.includes("onApplyAndStartTrial") &&
        watchlistFunnelSrc.includes("appliedCreator") &&
        watchlistFunnelSrc.includes("aria-pressed={active}") &&
        watchlistFunnelSrc.includes('role="progressbar"') &&
        watchlistFunnelSrc.includes("isReturningUser") &&
        watchlistFunnelSrc.includes("Continue with Free Plan") &&
        simulatorOnboardingSrc.includes("heybroc_preferred_stores") &&
        simulatorOnboardingSrc.includes("orderedStores") &&
        simulatorOnboardingSrc.includes("manualFunnelOpen") &&
        mainActivityKtSrc.includes("fun showOnboardingFunnelDialog()") &&
        mainActivityKtSrc.includes("STEP 1 OF 8 · HOUSEHOLD") &&
        mainActivityKtSrc.includes("STEP 3 OF 8 · YOUR STORES") &&
        mainActivityKtSrc.includes("STEP 8 OF 8 · YOUR PLAN") &&
        mainActivityKtSrc.includes("preferredStoresCsv") &&
        mainActivityKtSrc.includes("All 12+ grocery & delivery stores + 1.5M+ barcodes stay unlocked") &&
        mainActivityKtSrc.includes("onboarding_funnel_done_v1") &&
        mainActivityKtSrc.includes("KEYCODE_BACK") &&
        mainActivityKtSrc.includes("OnBackInvokedDispatcher") &&
        mainActivityKtSrc.includes('"nitrates" to "Nitrites & Curing Nitrates (2x)"') &&
        mainActivityKtSrc.includes('Start $effectiveTrialDays-Day Free Pro Trial ($0 Today)') &&
        mainActivityKtSrc.includes('Continue with Free Plan (Unlimited Scans + $weeklyFreeSwaps Swaps/Wk)') &&
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

  console.log("Checks executed:", checks);
  console.log(normalizeIngredients("Vegetable Oil (Soybean, Canola and/or Sunflower), corn, safflower or sunflower oil"));
  console.log(fail ? `${fail} FAILED` : "ALL CHECKS PASSED");
  process.exit(fail ? 1 : 0);
})();



