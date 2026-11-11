import type { NutritionInput } from "./rubric";

export type DietaryOptionId =
  | "sugar_diabetes"
  | "pesticide_risk"
  | "dairy"
  | "wheat_gluten"
  | "peanuts_nuts"
  | "soy"
  | "egg"
  | "shellfish_fish"
  | "high_sodium";

export interface DietaryAlert {
  id: DietaryOptionId;
  label: string;
  shortBadge: string;
  reason: string;
}

const CERTIFIED_ORGANIC_OR_CLEAN_CROP =
  /\b(organic|organics|usda\s+organic|biodynamic|glyphosate[\s-]*residue[\s-]*free|pesticide[\s-]*free|herbicide[\s-]*free|regenerative\s+organic)\b/i;

const NON_PRODUCE_BEVERAGE_OR_CANDY =
  /\b(sparkling\s+water|seltzer|club\s+soda|energy\s+drink|diet\s+soda|cola|sprite|fanta|gatorade|powerade|chewing\s+gum|gummy|gummies|jelly\s+beans?|skittles|starburst|jolly\s+rancher|cough\s+drop|sunscreen|lotion|shampoo|conditioner|body\s+wash|soap|detergent|toothpaste|deodorant|lip\s+balm)\b/i;

export interface PesticideRiskMatch {
  crop: string;
  category: "high_residue_produce" | "conventional_grain_legume";
  reason: string;
}

/**
 * Deterministic USDA Pesticide Data Program (PDP) & conventional herbicide/desiccant crop detector.
 * Never accuses a specific brand or lot of illegal contamination; strictly identifies non-organic
 * high-residue produce and conventional grain/legume crop categories vs. USDA Organic (7 CFR § 205.105).
 */
export function detectPesticideRisk(
  productTitle: string,
  ingredients: string,
  nutrition?: NutritionInput,
): PesticideRiskMatch | null {
  const combined = `${productTitle || ""} ${ingredients || ""}`.trim();
  if (!combined) return null;
  if (nutrition?.isOrganic === true || CERTIFIED_ORGANIC_OR_CLEAN_CROP.test(combined)) {
    return null;
  }
  if (NON_PRODUCE_BEVERAGE_OR_CANDY.test(productTitle || "") && !/\b(oats?|oatmeal|wheat|flour)\b/i.test(ingredients || "")) {
    return null;
  }

  // Strip explicitly organic sub-ingredients and flavor/pectin/vinegar trace terms so they don't trigger false positives
  const stripOrganicAndFlavorNoise = (s: string) =>
    s
      .replace(
        /\borganic\s+(?:whole\s+grain\s+|rolled\s+|steel[\s-]*cut\s+|sprouted\s+|gluten[\s-]*free\s+|unbleached\s+|enriched\s+|durum\s+|baby\s+|fresh\s+|frozen\s+|sweet\s+|red\s+|green\s+|black\s+)?[a-z]+(?:\s+(?:oats?|wheat|flour|strawberr\w*|blueberr\w*|spinach|kale|apples?|grapes?|peaches?|pears?|peppers?|cherries|beans?|potatoes?|celery|tomatoes?|chickpeas?|lentils?|semolina))?/gi,
        " ",
      )
      .replace(
        /\b(?:natural|artificial)\s+[a-z\s]{0,20}flavors?\b|\b(?:apple\s+cider\s+vinegar|apple\s+pectin|fruit\s+pectin|citrus\s+pectin|tomato\s+lycopene|grape\s+skin\s+extract|rosemary\s+extract)\b/gi,
        " ",
      );

  const cleanTitle = stripOrganicAndFlavorNoise(productTitle || "");
  const cleanIng = stripOrganicAndFlavorNoise(ingredients || "");
  const cleanCombined = `${cleanTitle} ${cleanIng}`;

  // 1) USDA Pesticide Data Program (PDP) high-residue conventional produce categories
  const produceMatch = cleanCombined.match(
    /\b(strawberries|strawberry|baby\s+spinach|spinach|kale|collard\s+greens?|mustard\s+greens?|seedless\s+grapes?|red\s+grapes?|green\s+grapes?|grapes?|raisins?|peaches|peach|pears|pear|nectarines?|honeycrisp\s+apples?|gala\s+apples?|fuji\s+apples?|granny\s+smith\s+apples?|applesauce|apples?|bell\s+peppers?|sweet\s+peppers?|jalape[nñ]o\s+peppers?|hot\s+peppers?|cherries|blueberries|blueberry|green\s+beans?|string\s+beans?|russet\s+potatoes?|yukon\s+gold\s+potatoes?|red\s+potatoes?|potatoes|celery|roma\s+tomatoes?|cherry\s+tomatoes?|grape\s+tomatoes?|tomatoes)\b/i,
  );
  if (produceMatch) {
    const crop = produceMatch[0].toLowerCase();
    return {
      crop,
      category: "high_residue_produce",
      reason: `Conventional ${crop} — high-residue produce category in USDA Pesticide Data Program (Dirty Dozen) monitoring; USDA Organic (7 CFR § 205.105) prohibits synthetic pesticides & herbicides (including glyphosate)`,
    };
  }

  // 2) Conventional grains & legumes where synthetic herbicides / pre-harvest desiccants (such as glyphosate) are permitted in non-organic farming
  const grainLegumeMatch = cleanCombined.match(
    /\b(rolled\s+oats?|steel[\s-]*cut\s+oats?|whole\s+grain\s+oats?|instant\s+oats?|oatmeal|oat\s+flour|oat\s+bran|oat\s*milk|granola|oats|whole\s+wheat(?:\s+flour)?|enriched\s+(?:wheat\s+)?flour|bleached\s+(?:wheat\s+)?flour|unbleached\s+(?:wheat\s+)?flour|graham\s+flour|durum\s+wheat|semolina|wheat\s+flour|chickpeas?|garbanzo\s+beans?|hummus|red\s+lentils?|green\s+lentils?|brown\s+lentils?|lentils?|pinto\s+beans?|black\s+beans?|navy\s+beans?|kidney\s+beans?)\b/i,
  );
  if (grainLegumeMatch) {
    const crop = grainLegumeMatch[0].toLowerCase();
    return {
      crop,
      category: "conventional_grain_legume",
      reason: `Conventional ${crop} — non-organic grain/legume farming permits synthetic herbicides & pre-harvest desiccants (such as glyphosate); USDA Organic (7 CFR § 205.105) prohibits glyphosate & synthetic herbicides`,
    };
  }

  return null;
}

export function evaluateDietaryAlerts(
  dietaryWatchlist: string[] | undefined,
  productTitle: string,
  ingredients: string,
  nutrition?: NutritionInput,
): DietaryAlert[] {
  if (!Array.isArray(dietaryWatchlist) || dietaryWatchlist.length === 0) return [];
  const selected = new Set(dietaryWatchlist.map((s) => String(s).trim().toLowerCase()));
  const text = `${productTitle} ${ingredients}`.toLowerCase();
  const ing = ingredients.toLowerCase();
  const alerts: DietaryAlert[] = [];

  if (
    selected.has("sugar_diabetes") &&
    !/\b(zero\s+sugar|sugar[\s-]*free|unsweetened|\bdiet\b)\b/i.test(productTitle)
  ) {
    const sugarsG = nutrition?.sugarsG100g ?? 0;
    const ingCleanedForSugar = ing.replace(
      /\b(no\s+(?:added\s+)?sugars?|sugar[\s-]*free|zero\s+sugar|unsweetened|without\s+(?:added\s+)?sugar|0\s*g\s+sugar|sugar\s+snap(?:\s+peas?)?|sugar\s+kelp|sugar\s+pumpkin)\b/gi,
      " ",
    );
    const sugarMatch = ingCleanedForSugar.match(
      /\b(high\s+fructose\s+corn\s+syrup|corn\s+syrup|cane\s+sugar|brown\s+sugar|sugar|sucrose|dextrose|maltose|fructose|glucose\s+syrup|honey|maple\s+syrup|molasses|agave|invert\s+sugar|fruit\s+juice\s+concentrate)\b/i,
    );
    const refinedCarbMatch = ing.match(
      /\b(enriched\s+(?:wheat\s+)?flour|bleached\s+(?:wheat\s+)?flour|maltodextrin|modified\s+(?:corn|food)\s+starch|instant\s+mashed|white\s+rice\s+flour)\b/i,
    );
    if (sugarsG >= 10 || sugarMatch || refinedCarbMatch) {
      const reasons: string[] = [];
      if (sugarsG >= 10) reasons.push(`${sugarsG}g sugar per 100g`);
      if (sugarMatch) reasons.push(`Added sweetener (${sugarMatch[0]})`);
      else if (refinedCarbMatch) reasons.push(`Refined starch (${refinedCarbMatch[0]})`);
      alerts.push({
        id: "sugar_diabetes",
        label: "🩸 Sugar / Diabetes Watch",
        shortBadge: "SUGAR",
        reason: reasons.join(" • "),
      });
    }
  }

  if (selected.has("dairy") && !/\b(dairy[\s-]*free|non[\s-]*dairy|plant[\s-]*based|vegan)\b/i.test(productTitle)) {
    const dairyCleaned = text.replace(
      /\b(coconut\s+milk|almond\s+milk|oat\s+milk|soy\s+milk|soymilk|almondmilk|oatmilk|rice\s+milk|cashew\s+milk|hemp\s+milk|milk\s+thistle|peanut\s+butter|almond\s+butter|cashew\s+butter|sunflower\s+(?:seed\s+)?butter|cocoa\s+butter|shea\s+butter|apple\s+butter|cookie\s+butter|butter\s+beans?|butter\s+lettuce|butter\s+potato\w*|butternut(?:\s+squash)?|cream\s+of\s+tartar|coconut\s+cream|lactic\s+acid)\b/gi,
      " ",
    );
    const m = dairyCleaned.match(
      /\b(buttermilk|sour\s+cream|half\s+and\s+half|milk|cream|butter|whey|casein|caseinate|lactose|cheese|cheddar|mozzarella|parmesan|provolone|gouda|swiss|ricotta|yogurt|ghee|lactalbumin)\b/i,
    );
    if (m) {
      alerts.push({
        id: "dairy",
        label: "🥛 Dairy / Lactose Alert",
        shortBadge: "DAIRY",
        reason: `Contains ${m[0].toLowerCase()}`,
      });
    }
  }

  if (selected.has("wheat_gluten") && !/\b(gluten[\s-]*free|grain[\s-]*free|celiac)\b/i.test(productTitle)) {
    const wheatCleaned = text.replace(/\b(buckwheat|wheat\s*grass|wheat[\s-]*free|gluten[\s-]*free)\b/gi, " ");
    const m = wheatCleaned.match(
      /\b(vital\s+wheat\s+gluten|graham\s+flour|enriched\s+flour|bleached\s+flour|unbleached\s+flour|wheat|durum|semolina|spelt|farro|kamut|bulgur|couscous|seitan|barley|malt|malted|rye|triticale)\b/i,
    );
    if (m) {
      alerts.push({
        id: "wheat_gluten",
        label: "🌾 Wheat / Gluten Alert",
        shortBadge: "WHEAT",
        reason: `Contains ${m[0].toLowerCase()}`,
      });
    }
  }

  if (selected.has("peanuts_nuts")) {
    const nutCleaned = text.replace(
      /\b(nutmeg|butternut|water\s+chestnuts?|coconuts?|nut[\s-]*free|peanut[\s-]*free|tree\s+nut[\s-]*free)\b/gi,
      " ",
    );
    const m = nutCleaned.match(
      /\b(peanut\s+butter|peanut\s+oil|peanut\s+flour|peanuts?|almonds?|cashews?|walnuts?|pecans?|hazelnuts?|filberts?|pistachios?|macadamia|brazil\s+nuts?|pine\s+nuts?|praline|marzipan|nougat|gianduja)\b/i,
    );
    if (m) {
      alerts.push({
        id: "peanuts_nuts",
        label: "🥜 Peanut & Tree Nut Alert",
        shortBadge: "NUTS",
        reason: `Contains ${m[0].toLowerCase()}`,
      });
    }
  }

  if (selected.has("soy")) {
    const soyCleaned = text.replace(/\b(soy[\s-]*free|no\s+soy(?:\s+lecithin)?|without\s+soy|free\s+of\s+soy)\b/gi, " ");
    const m = soyCleaned.match(
      /\b(soybean\s+oil|soy\s+lecithin|soy\s+protein|soy\s+flour|soy\s+sauce|textured\s+vegetable\s+protein|soybeans?|soymilk|soy|soya|tamari|tofu|tempeh|edamame|miso)\b/i,
    );
    if (m) {
      alerts.push({
        id: "soy",
        label: "🫘 Soy Alert",
        shortBadge: "SOY",
        reason: `Contains ${m[0].toLowerCase()}`,
      });
    }
  }

  if (selected.has("egg")) {
    const eggCleaned = text.replace(/\b(eggplants?|egg[\s-]*free|no\s+eggs?|vegan\s+mayo(?:nnaise)?)\b/gi, " ");
    const m = eggCleaned.match(
      /\b(egg\s+whites?|egg\s+yolks?|dried\s+egg|powdered\s+egg|eggs?|albumin|ovalbumin|ovomucoid|lysozyme|mayonnaise|aioli|meringue)\b/i,
    );
    if (m) {
      alerts.push({
        id: "egg",
        label: "🥚 Egg Alert",
        shortBadge: "EGG",
        reason: `Contains ${m[0].toLowerCase()}`,
      });
    }
  }

  if (selected.has("shellfish_fish")) {
    const m = text.match(
      /\b(shrimp|prawns?|crab|lobster|crawfish|crayfish|clams?|mussels?|oysters?|scallops?|calamari|squid|octopus|anchov(?:y|ies)|sardines?|salmon|tuna|cod|tilapia|halibut|haddock|trout|mahi|pollock|catfish|krill|fish\s+sauce|fish\s+oil)\b/i,
    );
    if (m) {
      alerts.push({
        id: "shellfish_fish",
        label: "🐟 Shellfish & Fish Alert",
        shortBadge: "FISH",
        reason: `Contains ${m[0].toLowerCase()}`,
      });
    }
  }

  if (selected.has("high_sodium")) {
    const sodiumMg = nutrition?.sodiumMg100g ?? 0;
    const sodiumAddMatch = ing.match(
      /\b(monosodium\s+glutamate|sodium\s+phosphate|disodium\s+inosinate|disodium\s+guanylate|sodium\s+tripolyphosphate|sodium\s+nitrite|sodium\s+nitrate|sodium\s+benzoate|sodium\s+caseinate|brine|saline\s+solution)\b/i,
    );
    if (sodiumMg >= 400 || sodiumAddMatch) {
      const reasons: string[] = [];
      if (sodiumMg >= 400) reasons.push(`${sodiumMg}mg sodium per 100g`);
      if (sodiumAddMatch) reasons.push(`Contains ${sodiumAddMatch[0].toLowerCase()}`);
      alerts.push({
        id: "high_sodium",
        label: "🧂 High Sodium Watch",
        shortBadge: "SODIUM",
        reason: reasons.join(" • "),
      });
    }
  }

  if (selected.has("pesticide_risk")) {
    const pestMatch = detectPesticideRisk(productTitle, ingredients, nutrition);
    if (pestMatch) {
      alerts.push({
        id: "pesticide_risk",
        label: "🌱 Herbicides & Pesticides (Glyphosate) Watch",
        shortBadge: "PESTICIDE",
        reason: pestMatch.reason,
      });
    }
  }

  return alerts;
}
