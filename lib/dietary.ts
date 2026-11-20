import { stripPrecautionaryCrossContactClauses, type NutritionInput } from "./rubric";

export type DietaryOptionId =
  | "sugar_diabetes"
  | "pesticide_risk"
  | "dairy"
  | "wheat_gluten"
  | "peanuts_nuts"
  | "soy"
  | "egg"
  | "shellfish_fish"
  | "sesame"
  | "high_sodium";

export const MAJOR_ALLERGEN_IDS: readonly DietaryOptionId[] = [
  "peanuts_nuts",
  "dairy",
  "wheat_gluten",
  "soy",
  "egg",
  "shellfish_fish",
  "sesame",
] as const;

export type DietaryAlertSeverity = "allergen" | "advisory" | "none";

export interface DietaryAlert {
  id: DietaryOptionId;
  label: string;
  shortBadge: string;
  reason: string;
}

export function classifyDietaryAlertSeverity(alerts: readonly DietaryAlert[] | undefined): DietaryAlertSeverity {
  if (!Array.isArray(alerts) || alerts.length === 0) return "none";
  for (const alert of alerts) {
    if ((MAJOR_ALLERGEN_IDS as readonly string[]).includes(alert.id)) {
      return "allergen";
    }
  }
  return "advisory";
}

const CERTIFIED_ORGANIC_OR_CLEAN_CROP =
  /(?<!\bnon[\s-]+)\b(organic|organics|usda\s+organic|biodynamic|glyphosate[\s-]*residue[\s-]*free|pesticide[\s-]*free|herbicide[\s-]*free|regenerative\s+organic)\b/i;

const NON_PRODUCE_BEVERAGE_OR_CANDY =
  /\b(sparkling\s+water|seltzer|club\s+soda|energy\s+drink|diet\s+soda|cola|sprite|fanta|gatorade|powerade|chewing\s+gum|gummy|gummies|jelly\s+beans?|skittles|starburst|jolly\s+rancher|cough\s+drop|sunscreen|lotion|shampoo|conditioner|body\s+wash|soap|detergent|toothpaste|deodorant|lip\s+balm)\b/i;

export interface PesticideRiskMatch {
  crop: string;
  category: "high_residue_produce" | "conventional_grain_legume";
  reason: string;
}

export const PESTICIDE_PRODUCE_DEDUCTION = 25;
export const PESTICIDE_PRODUCE_SCORE_CAP = 65;
export const PESTICIDE_GRAIN_DEDUCTION = 20;
export const PESTICIDE_GRAIN_SCORE_CAP = 69;

export interface PesticidePenalty {
  points: number;
  maxScoreCap: number;
  match: PesticideRiskMatch;
}

/**
 * Deterministic USDA Pesticide Data Program (PDP) & conventional herbicide/desiccant crop detector.
 * Never accuses a specific brand or lot of illegal contamination; strictly identifies non-organic
 * high-residue produce and conventional grain/legume crop categories vs. USDA Organic (7 CFR § 205.105).
 */
const PARTIAL_ORGANIC_TITLE_RE =
  /\b(?:made\s+with|crafted\s+with|baked\s+with|sweetened\s+with|topped\s+with|blended\s+with|seasoned\s+with|cooked\s+in|with|in|from|contains|and|plus)\s+organic\b|&\s*organic\b/i;

export function detectPesticideRisk(
  productTitle: string,
  ingredients: string,
  nutrition?: NutritionInput,
): PesticideRiskMatch | null {
  const combined = `${productTitle || ""} ${ingredients || ""}`.trim();
  if (!combined) return null;
  const hasWholeProductOrganicClaim =
    CERTIFIED_ORGANIC_OR_CLEAN_CROP.test(productTitle || "") &&
    !PARTIAL_ORGANIC_TITLE_RE.test(productTitle || "");
  if (nutrition?.isOrganic === true || hasWholeProductOrganicClaim) {
    return null;
  }
  if (NON_PRODUCE_BEVERAGE_OR_CANDY.test(productTitle || "") && !/\b(oats?|oatmeal|wheat|flour)\b/i.test(ingredients || "")) {
    return null;
  }

  // Strip explicitly organic sub-ingredient clauses (never "non-organic ...") and flavor/pectin/vinegar trace terms
  const stripOrganicAndFlavorNoise = (s: string) =>
    s
      .replace(
        /(?<!\bnon[\s-]+)\b(?:100%\s+)?organic\s+[a-z0-9\s'’-]+?(?=\s*(?:[,;():[\]&]|\.|$|\band\b|\bnon[\s-]+organic\b|\bconventional\b))/gi,
        " ",
      )
      .replace(
        /\b(?:natural|artificial)\s+[a-z\s]{0,20}flavors?\b|\b(?:apple\s+cider\s+vinegar|apple\s+pectin|fruit\s+pectin|citrus\s+pectin|tomato\s+lycopene|grape\s+skin\s+extract|rosemary\s+extract)\b|\b(?:(?:red|green|yellow|sweet|jalape[nñ]o|hot|chili|chilli)\s+(?:(?:and|&|\/)\s+(?:red|green|yellow|sweet)\s+)?)?(?:bell\s+peppers?|sweet\s+peppers?|jalape[nñ]o\s+peppers?|hot\s+peppers?|celery|tomato(?:es)?)\s+(?:powder|seed|seeds|salt|extract|oleoresin|oil|flakes?)\b/gi,
        " ",
      );

  const cleanTitle = stripOrganicAndFlavorNoise(productTitle || "");
  const cleanIng = stripOrganicAndFlavorNoise(ingredients || "");
  const rawIngTrimmed = (ingredients || "").trim();
  const hasSpecificIngredientList =
    rawIngTrimmed.length > 0 &&
    !/^(?:single[\s-]*ingredient\b|100%\s+(?:fresh|whole|pure)\b|fresh\s+produce\b)/i.test(rawIngTrimmed);
  const cleanCombined = hasSpecificIngredientList ? cleanIng : `${cleanTitle} ${cleanIng}`;

  // 1) USDA Pesticide Data Program (PDP) & EWG Dirty Dozen high-residue conventional produce categories
  const produceMatch = cleanCombined.match(
    /\b(strawberries|strawberry|baby\s+spinach|spinach|kale|collard\s+greens?|mustard\s+greens?|seedless\s+grapes?|red\s+grapes?|green\s+grapes?|grapes?|raisins?|peaches|peach|pears|pear|nectarines?|honeycrisp\s+apples?|gala\s+apples?|fuji\s+apples?|granny\s+smith\s+apples?|applesauce|apples?|bell\s+peppers?|sweet\s+peppers?|jalape[nñ]o\s+peppers?|hot\s+peppers?|cherries|blueberries|blueberry|green\s+beans?|string\s+beans?|russet\s+potatoes?|yukon\s+gold\s+potatoes?|red\s+potatoes?|potatoes|celery|roma\s+tomatoes?|cherry\s+tomatoes?|grape\s+tomatoes?|tomatoes)\b/i,
  );
  if (produceMatch) {
    const crop = produceMatch[0].toLowerCase();
    return {
      crop,
      category: "high_residue_produce",
      reason: `Conventional ${crop} (-${PESTICIDE_PRODUCE_DEDUCTION} pts) — high-residue produce category in USDA Pesticide Data Program & EWG Dirty Dozen monitoring; USDA Organic (7 CFR § 205.105) prohibits synthetic pesticides & herbicides (including glyphosate)`,
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
      reason: `Conventional ${crop} (-${PESTICIDE_GRAIN_DEDUCTION} pts) — non-organic grain/legume category tracked in USDA Pesticide Data Program & EWG Dirty Dozen / herbicide monitoring where pre-harvest desiccants (such as glyphosate) are permitted; USDA Organic (7 CFR § 205.105) prohibits glyphosate & synthetic herbicides`,
    };
  }

  return null;
}

export function computePesticidePenalty(
  dietaryWatchlist: string[] | undefined,
  productTitle: string,
  ingredients: string,
  nutrition?: NutritionInput,
): PesticidePenalty | null {
  if (!Array.isArray(dietaryWatchlist) || dietaryWatchlist.length === 0) return null;
  const active = dietaryWatchlist.some((s) => String(s).trim().toLowerCase() === "pesticide_risk");
  if (!active) return null;
  const match = detectPesticideRisk(productTitle, ingredients, nutrition);
  if (!match) return null;
  return match.category === "high_residue_produce"
    ? { points: PESTICIDE_PRODUCE_DEDUCTION, maxScoreCap: PESTICIDE_PRODUCE_SCORE_CAP, match }
    : { points: PESTICIDE_GRAIN_DEDUCTION, maxScoreCap: PESTICIDE_GRAIN_SCORE_CAP, match };
}

export function evaluateDietaryAlerts(
  dietaryWatchlist: string[] | undefined,
  productTitle: string,
  ingredients: string,
  nutrition?: NutritionInput,
): DietaryAlert[] {
  if (!Array.isArray(dietaryWatchlist) || dietaryWatchlist.length === 0) return [];
  const selected = new Set(dietaryWatchlist.map((s) => String(s).trim().toLowerCase()));
  const stripCoordinatedFreeClaims = (s: string) =>
    s
      .replace(
        /\b(?:gluten|wheat)[\s-]*free(?:\s+(?:all[\s-]*purpose|baking|blend|1[\s-]*to[\s-]*1|measure[\s-]*for[\s-]*measure))?\s+flour\b/gi,
        " ",
      )
      .replace(
        /\b(?:peanuts?|tree\s+nuts?|nuts?|eggs?|dairy|milk|lactose|soy|sesame|wheat|gluten|grains?|shellfish|fish|allergens?)(?:\s*(?:,|&|and|or|\/)\s*(?:peanuts?|tree\s+nuts?|nuts?|eggs?|dairy|milk|lactose|soy|sesame|wheat|gluten|grains?|shellfish|fish|allergens?))*\s*[\s-]+free\b/gi,
        " ",
      )
      .replace(
        /\b(?:free\s+(?:from|of)|without|no)\s+(?:peanuts?|tree\s+nuts?|nuts?|eggs?|dairy|milk|lactose|soy(?:\s+lecithin)?|sesame|wheat|gluten)(?:\s*(?:,|&|and|or|\/)\s*(?:peanuts?|tree\s+nuts?|nuts?|eggs?|dairy|milk|lactose|soy(?:\s+lecithin)?|sesame|wheat|gluten))*\b/gi,
        " ",
      );
  const ing = stripCoordinatedFreeClaims(
    stripPrecautionaryCrossContactClauses(ingredients).toLowerCase(),
  );
  const cleanTitleForAlerts = stripCoordinatedFreeClaims(productTitle.toLowerCase());
  const text = `${cleanTitleForAlerts} ${ing}`;
  const alerts: DietaryAlert[] = [];

  if (selected.has("sugar_diabetes")) {
    const sugarsG = nutrition?.sugarsG100g ?? 0;
    const ingCleanedForSugar = ing.replace(
      /\b(no\s+(?:added\s+)?sugars?|sugar[\s-]*free|zero\s+sugar|unsweetened|without\s+(?:added\s+)?sugar|0\s*g\s+sugar|sugar\s+alcohols?|sugar\s+snap(?:\s+peas?)?|sugar\s+kelp|sugar\s+pumpkin)\b/gi,
      " ",
    );
    const sugarMatch = ingCleanedForSugar.match(
      /\b(high\s+fructose\s+corn\s+syrup|corn\s+syrup|cane\s+sugar|brown\s+sugar|sugar|sucrose|dextrose|maltose|fructose|glucose\s+syrup|honey|maple\s+syrup|molasses|agave|invert\s+sugar|fruit\s+juice\s+concentrate)\b/i,
    );
    const refinedCarbMatch = ing.match(
      /\b(enriched\s+(?:wheat\s+)?flour|bleached\s+(?:wheat\s+)?flour|maltodextrin|modified\s+(?:corn|food)\s+starch|instant\s+mashed|white\s+rice\s+flour)\b/i,
    );
    const titleClaimsSugarFreeOrUnsweetened = /\b(zero\s+sugar|sugar[\s-]*free|unsweetened|\bdiet\b)\b/i.test(
      productTitle,
    );
    const triggersIntrinsicSugar =
      sugarsG >= 10 &&
      !(titleClaimsSugarFreeOrUnsweetened && /\bunsweetened\b/i.test(productTitle) && !sugarMatch && !refinedCarbMatch && sugarsG <= 12);
    if (triggersIntrinsicSugar || sugarMatch || refinedCarbMatch) {
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

  if (selected.has("dairy")) {
    const titleClaimsDairyFree = /\b(dairy[\s-]*free|non[\s-]*dairy|milk[\s-]*free|plant[\s-]*based|vegan)\b/i.test(
      productTitle,
    );
    const dairySource = titleClaimsDairyFree ? ing : text;
    const dairyCleaned = dairySource.replace(
      /\b(dairy[\s-]*free|non[\s-]*dairy|milk[\s-]*free|lactose[\s-]*free|butter[\s-]*free|whey[\s-]*free|casein[\s-]*free|no\s+(?:dairy|milk|lactose|butter|whey|casein)|plant\s+(?:milk|butter|cream\w*|cheese|yogurt)|vegan\s+(?:milk|butter|cream\w*|cheese|yogurt)|coconut\s+milk|almond\s+milk|oat\s+milk|soy\s+milk|soymilk|almondmilk|oatmilk|rice\s+milk|cashew\s*milk|walnut\s*milk|hazelnut\s*milk|pistachio\s*milk|pecan\s*milk|macadamia\s*milk|hemp\s*milk|pea\s*milk|flax\s*milk|banana\s*milk|oat\s+beverage|almond\s+beverage|soy\s+beverage|coconut\s+beverage|milked\s+\w+|milk\s+thistle|peanut\s+butter|almond\s+butter|cashew\s+butter|hazelnut\s+butter|walnut\s+butter|pecan\s+butter|pistachio\s+butter|macadamia\s+butter|sunflower\s+(?:seed\s+)?butter|sunbutter|pumpkin\s+seed\s+butter|sesame\s+butter|cocoa\s+butter|shea\s+butter|mango\s+butter|apple\s+butter|pumpkin\s+butter|cookie\s+butter|fruit\s+butter|butter\s+beans?|butter\s+lettuce|butter\s+potato\w*|butternut(?:\s+squash)?|cream\s+of\s+(?:tartar|coconut|rice|wheat)|cream\s+soda|coconut\s+cream|oat\s+cream\w*|almond\s+cream\w*|soy\s+cream\w*|coconut\s+cream\w*|plant\s+cream\w*|lactic\s+acid|calcium\s+lactate|sodium\s+lactate|sodium\s+stearoyl\s+lactylate|(?:bean|soy|tofu)\s+curds?)\b/gi,
      " ",
    );
    const m = dairyCleaned.match(
      /\b(buttermilk|sour\s+cream|half\s+and\s+half|milk|milkfat|butterfat|butteroil|cream|butter|whey|casein|caseinate|lactose|cheese|cheddar|mozzarella|parmesan|provolone|gouda|swiss|ricotta|paneer|curds?|yogurt|ghee|lactalbumin)\b/i,
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

  if (selected.has("wheat_gluten")) {
    const titleClaimsGlutenFree = /\b(gluten[\s-]*free|grain[\s-]*free|wheat[\s-]*free|celiac)\b/i.test(productTitle);
    const wheatSource = titleClaimsGlutenFree ? ing : text;
    const wheatCleaned = wheatSource
      .replace(
        /\b(?:(?:organic|whole\s+grain|brown|white|sweet|yellow|blue|green|red|defatted|toasted|blanched|roasted|stone[\s-]*ground|fine|superfine|sprouted|gluten[\s-]*free)\s+)*(?:almond|coconut|rice|oat|corn|masa|cassava|tapioca|chickpea|garbanzo(?:\s+bean)?|potato|buckwheat|sorghum|quinoa|pea|peanut|soy|soya|hazelnut|chestnut|amaranth|teff|millet|banana|plantain|tiger\s*nut|flax(?:\s*seed)?|hemp|sunflower(?:\s*seed)?|lupin|lupine|konjac|arrowroot|sesame|lentil|bean|fava\s+bean|chia|mesquite|cauliflower|carob)\s+flour\b|\bgluten[\s-]*free(?:\s+all[\s-]*purpose|\s+baking|\s+blend)?\s+flour\b/gi,
        " ",
      )
      .replace(
        /\b(buckwheat|wheat\s*grass|wheat[\s-]*free|gluten[\s-]*free|no\s+(?:wheat|gluten)|corn\s+gluten)\b/gi,
        " ",
      );
    const m = wheatCleaned.match(
      /\b(vital\s+wheat\s+gluten|graham\s+flour|enriched\s+flour|bleached\s+flour|unbleached\s+flour|matz[ao]h?\s+meal|panko|einkorn|wheat|durum|semolina|spelt|farro|kamut|bulgur|couscous|seitan|barley|malt|malted|rye|triticale|flour)\b/i,
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
    const titleClaimsNutFree = /\b(nut[\s-]*free|peanut[\s-]*free|tree\s+nut[\s-]*free|no\s+(?:peanuts?|tree\s+nuts?|nuts?))\b/i.test(
      productTitle,
    );
    const nutSource = titleClaimsNutFree ? ing : text;
    const nutCleaned = nutSource.replace(
      /\b(nutmeg|butternut|water\s+chestnuts?|coconuts?|nut[\s-]*free|peanut[\s-]*free|tree\s+nut[\s-]*free)\b/gi,
      " ",
    );
    const m = nutCleaned.match(
      /\b(peanut\s+butter|peanut\s+oil|peanut\s+flour|arachis\s+oil|groundnuts?|peanuts?|tree\s+nuts?|almonds?|almondmilk|cashews?|cashewmilk|walnuts?|walnutmilk|pecans?|pecanmilk|hazelnuts?|hazelnutmilk|filberts?|pistachios?|pistachiomilk|macadamias?|macadamiamilk|chestnuts?|brazil\s+nuts?|pine\s+nuts?|praline|marzipan|nougat|gianduja)\b/i,
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
    const titleClaimsSoyFree = /\b(soy[\s-]*free|no\s+soy)\b/i.test(productTitle);
    const soySource = titleClaimsSoyFree ? ing : text;
    const soyCleaned = soySource.replace(/\b(soy[\s-]*free|no\s+soy(?:\s+lecithin)?|without\s+soy|free\s+of\s+soy)\b/gi, " ");
    const m = soyCleaned.match(
      /\b(soybean\s+oil|soy\s+lecithin|soy\s+protein|soy\s+flour|soy\s+sauce|textured\s+vegetable\s+protein|soybeans?|soymilk|soy|soya|tamari|shoyu|natto|tofu|tempeh|edamame|miso)\b/i,
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
    const titleClaimsEggFree = /\b(egg[\s-]*free|no\s+eggs?|vegan)\b/i.test(productTitle);
    const eggSource = titleClaimsEggFree ? ing : text;
    const eggCleaned = eggSource.replace(/\b(eggplants?|egg[\s-]*free|no\s+eggs?|vegan\s+mayo(?:nnaise)?)\b/gi, " ");
    const m = eggCleaned.match(
      /\b(egg\s+whites?|egg\s+yolks?|dried\s+egg|powdered\s+egg|eggs?|albumen|albumin|ovalbumin|ovomucoid|lysozyme|mayonnaise|aioli|meringue)\b/i,
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
    const titleClaimsFishFree = /\b(shellfish[\s-]*free|fish[\s-]*free|seafood[\s-]*free|vegan)\b/i.test(productTitle);
    const fishSource = titleClaimsFishFree ? ing : text;
    const m = fishSource.match(
      /\b((?:crustacean\s+|molluscan\s+)?shellfish|crustaceans?|mollusks?|molluscs?|shrimp|prawns?|crab|lobster|langostino|crawfish|crayfish|clams?|mussels?|oysters?|scallops?|calamari|squid|octopus|anchov(?:y|ies)|sardines?|salmon|tuna|cod|tilapia|halibut|haddock|trout|mahi|pollock|catfish|bonito(?:\s+flakes)?|surimi|krill|fish\s+sauce|fish\s+oil)\b/i,
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

  if (selected.has("sesame")) {
    const titleClaimsSesameFree = /\b(sesame[\s-]*free|no\s+sesame)\b/i.test(productTitle);
    const sesameSource = titleClaimsSesameFree ? ing : text;
    const sesameCleaned = sesameSource.replace(/\b(sesame[\s-]*free|no\s+sesame|without\s+sesame|free\s+of\s+sesame)\b/gi, " ");
    const m = sesameCleaned.match(
      /\b(sesame\s+seeds?|sesame\s+oil|sesame\s+flour|sesame\s+paste|tahini|sesame|benne\s+seeds?|gomasio|halvah)\b/i,
    );
    if (m) {
      alerts.push({
        id: "sesame",
        label: "🌱 Sesame Alert",
        shortBadge: "SESAME",
        reason: `Contains ${m[0].toLowerCase()}`,
      });
    }
  }

  if (selected.has("high_sodium")) {
    const sodiumMg = nutrition?.sodiumMg100g ?? 0;
    const sodiumAddMatch = ing.match(
      /\b(monosodium\s+glutamate|(?:di|tri|mono|penta)?sodium\s+(?:(?:dihydrogen|acid|aluminum|hexameta|tripoly|pyro|poly)\s+)?(?:phosphates?|triphosphate|tripolyphosphate|pyrophosphate|hexametaphosphate|polyphosphates?)|disodium\s+inosinate|disodium\s+guanylate|sodium\s+nitrite|sodium\s+nitrate|sodium\s+benzoate|sodium\s+caseinate|brine|saline\s+solution)\b/i,
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

export function detectMajorAllergens(productTitle: string, ingredients = ""): Set<DietaryOptionId> {
  const alerts = evaluateDietaryAlerts([...MAJOR_ALLERGEN_IDS], productTitle, ingredients);
  return new Set(alerts.map((a) => a.id));
}
