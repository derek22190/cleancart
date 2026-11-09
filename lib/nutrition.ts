import type { NutritionInput } from "./rubric";

export const SUPPLEMENT_FORM = /\b(supplement\s+facts|pre[- ]?workout|protein\s+powder|creatine|multivitamin|greens\s+powder)\b/i;

/** Missing is different from zero. Reject invalid/negative provider values. */
export function nutrientNumber(value: unknown): number | undefined {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Conservative plain-food classification, never a certification assertion. */
export function classifyWholeFood(title: string): Pick<NutritionInput, "isWholeFood" | "fruitsVegNutsPct"> {
  const s = title.toLowerCase().replace(/\bsugar\s+(snap|kelp|pumpkin)\b/g, "$1");
  if (/\b(chips?|crisps?|cookies?|cakes?|bars?|nuggets?|chocolate|coated|covered|honey|sugar|syrup|salted|seasoned|marinated|breaded|battered|fried|cured|smoked|sausage|bacon|sauce|dressing|mayonnaise|mayo|candy|sweetened|candied|flavored|flavoured|juice|smoothie|powder|supplement)\b/.test(s)) return {};
  if (/\b(apples?|honeycrisp|bananas?|berries|blueberries|strawberries|raspberries|oranges?|avocados?|broccoli|spinach|kale|carrots?|(?:sweet\s+)?potato(?:es)?|yams?|tomato(?:es)?|onions?|peas|lentils|chickpeas|beans|almonds?|walnuts?|cashews?|pecans?|pistachios?|peanuts?|chia\s+seeds?|flax\s*seeds?|pumpkin\s+seeds?|sunflower\s+seeds?|dates|raisins)\b/.test(s) && !/\b(milk|butter|ice\s+cream|cereal|granola|yogurt|yoghurt|pudding|vinegar)\b/.test(s)) {
    return { isWholeFood: true, fruitsVegNutsPct: 100 };
  }
  if (/\b(oats?|oatmeal|quinoa|brown\s+rice|salmon|trout|cod|tuna|sardines?|shrimp|chicken|turkey|beef|pork|lamb|eggs?)\b/.test(s) && !/\b(milk|yogurt|ice\s+cream|sandwich|soup|noodles?|pasta|cereal|granola|patties\s+with|seasoned|marinated|solution|stuffed|sugar|syrup)\b/.test(s)) return { isWholeFood: true, fruitsVegNutsPct: 0 };
  if (/\b(?:plain\s+(?:greek\s+)?yog(?:h)?urt|yog(?:h)?urt.*\bplain|(?:extra\s+virgin\s+)?olive\s+oil)\b/.test(s) && !/\b(fruit|vanilla|chocolate|honey|strawberry|blueberry|sugar|syrup|blend|infused)\b/.test(s)) return { isWholeFood: true, fruitsVegNutsPct: 0 };
  return {};
}

export interface OffNutritionRecord {
  nutriments?: Record<string, unknown>;
  labels_tags?: string[];
  nutriscore_grade?: string;
  product_name?: string;
  product_name_en?: string;
}

/** OFF's *_100g fields are per 100g/100ml; sodium and salt are grams. */
export function extractOffNutrition(p: OffNutritionRecord): NutritionInput {
  const n = p.nutriments || {};
  const kcal = nutrientNumber(n["energy-kcal_100g"]);
  const kj = nutrientNumber(n["energy-kj_100g"]) ?? nutrientNumber(n.energy_100g);
  const sodium = nutrientNumber(n.sodium_100g);
  const salt = nutrientNumber(n.salt_100g);
  const grade = p.nutriscore_grade?.toLowerCase();
  return {
    caloriesKcal100g: kcal ?? (kj === undefined ? undefined : kj / 4.184),
    sugarsG100g: nutrientNumber(n.sugars_100g),
    saturatedFatG100g: nutrientNumber(n["saturated-fat_100g"]),
    sodiumMg100g: sodium !== undefined ? sodium * 1000 : salt !== undefined ? salt * 400 : undefined,
    fiberG100g: nutrientNumber(n.fiber_100g),
    proteinG100g: nutrientNumber(n.proteins_100g),
    fruitsVegNutsPct: nutrientNumber(n["fruits-vegetables-nuts-estimate-from-ingredients_100g"]) ?? nutrientNumber(n["fruits-vegetables-nuts_100g"]),
    nutriScoreGrade: grade && /^[abcde]$/.test(grade) ? grade as "a" | "b" | "c" | "d" | "e" : undefined,
    // These are product-level provider labels, never words in the ingredients/title.
    isOrganic: p.labels_tags?.some(t => /^(en|fr):(organic|usda-organic|eu-organic|ab-agriculture-biologique|bio)$/i.test(t)) === true,
  };
}

export interface UsdaNutrient {
  nutrientId?: number;
  nutrientNumber?: string | number;
  nutrientName?: string;
  unitName?: string;
  value?: number;
  amount?: number;
  nutrient?: { id?: number; number?: string | number; name?: string; unitName?: string };
}

export interface UsdaFood {
  fdcId?: number;
  description?: string;
  brandName?: string;
  brandOwner?: string;
  gtinUpc?: string;
  ingredients?: string;
  dataType?: string;
  publishedDate?: string;
  foodNutrients?: UsdaNutrient[];
}

/** Search foodNutrients are already normalized per 100g, including Branded. */
export function extractUsdaNutrition(f: UsdaFood): NutritionInput {
  const rows = (f.foodNutrients || []).map(n => ({
    id: n.nutrientId ?? n.nutrient?.id,
    number: String(n.nutrientNumber ?? n.nutrient?.number ?? ""),
    name: n.nutrientName ?? n.nutrient?.name ?? "",
    unit: (n.unitName ?? n.nutrient?.unitName ?? "").toLowerCase(),
    value: nutrientNumber(n.value ?? n.amount),
  }));
  const find = (ids: number[], numbers: string[], name: RegExp, target: "g" | "mg" | "kcal") => {
    const candidates = rows.filter(n => n.value !== undefined && (ids.includes(n.id!) || numbers.includes(n.number) || name.test(n.name)));
    const direct = candidates.find(n => n.unit === target);
    if (direct) return direct.value;
    for (const n of candidates) {
      if (target === "kcal" && n.unit === "kj") return n.value! / 4.184;
      if (target === "g" && n.unit === "mg") return n.value! / 1000;
      if (target === "mg" && n.unit === "g") return n.value! * 1000;
      if (!n.unit && (ids.includes(n.id!) || numbers.includes(n.number))) return target === "kcal" && (n.id === 1062 || n.number === "268") ? n.value! / 4.184 : n.value;
    }
    return undefined;
  };
  const whole = ["Foundation", "SR Legacy", "Survey (FNDDS)"].includes(f.dataType || "")
    ? classifyWholeFood(f.description || "") : {};
  return {
    caloriesKcal100g: find([1008, 2047, 2048], ["208"], /^energy(?:\s*\(.*\))?$/i, "kcal") ?? find([1062], ["268"], /^energy$/i, "kcal"),
    sugarsG100g: find([2000], ["269"], /^(?:sugars,?\s*total|total\s+sugars)/i, "g"),
    saturatedFatG100g: find([1258], ["606"], /^fatty acids,\s*total saturated$/i, "g"),
    sodiumMg100g: find([1093], ["307"], /^sodium(?:,\s*na)?$/i, "mg"),
    fiberG100g: find([1079], ["291"], /^fiber,\s*total dietary$/i, "g"),
    proteinG100g: find([1003], ["203"], /^protein$/i, "g"),
    ...whole,
    isOrganic: false,
  };
}
