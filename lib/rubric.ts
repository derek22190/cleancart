/**
 * CleanCart — Deterministic Additive Rubric
 * -----------------------------------------
 * Scores a product 100% on INGREDIENT QUALITY. Calories, carbs, natural fat and
 * sodium are never considered. The same ingredient string always produces the
 * exact same score: no AI, no randomness, no network.
 *
 * This file is dependency-free and isomorphic (server + browser).
 */

export const RUBRIC_VERSION = "1.0.0";

export type RiskLevel = "high" | "moderate" | "low";

export type Category =
  | "dyes"
  | "preservatives"
  | "nitrates"
  | "seedOils"
  | "hfcs"
  | "emulsifiers"
  | "sweeteners"
  | "gums"
  | "flavors";

export type Watchlist = Partial<Record<Category, boolean>>;

export type Rating = "Excellent" | "Mediocre" | "Poor";
export type RatingColor = "green" | "yellow" | "red";

export interface AdditiveRule {
  id: string;
  name: string;
  risk: RiskLevel;
  category: Category;
  /** Regex sources matched against the normalized ingredient string. */
  patterns: string[];
  explanation: string;
}

export interface FlaggedAdditive {
  id: string;
  name: string;
  risk: RiskLevel;
  category: Category;
  penalty: number;
  explanation: string;
  /** The normalized text fragment that triggered the match. */
  matched: string;
}

export interface ScoreResult {
  score: number;
  rating: Rating;
  color: RatingColor;
  flagged: FlaggedAdditive[];
  /** Additives present in the list but skipped because the user disabled their category. */
  ignored: FlaggedAdditive[];
  totalPenalty: number;
  normalizedIngredients: string;
  rubricVersion: string;
}

export const PENALTIES: Record<RiskLevel, number> = {
  high: 35,
  moderate: 20,
  low: 10,
};

export const CATEGORY_LABELS: Record<Category, string> = {
  dyes: "Synthetic Dyes",
  preservatives: "Preservatives",
  nitrates: "Nitrates / Nitrites",
  seedOils: "Industrial Seed Oils",
  hfcs: "Corn Syrups / HFCS",
  emulsifiers: "Emulsifiers",
  sweeteners: "Artificial Sweeteners",
  gums: "Gums & Lecithins",
  flavors: "Flavorings & Acids",
};

export const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS) as Category[];

export const DEFAULT_WATCHLIST: Record<Category, boolean> = ALL_CATEGORIES.reduce(
  (acc, c) => ({ ...acc, [c]: true }),
  {} as Record<Category, boolean>,
);

/* ------------------------------------------------------------------------ */
/* Watchlist rules. Patterns run on normalized text: lowercase a–z, 0–9 and  */
/* single spaces only (see normalizeIngredients).                            */
/* ------------------------------------------------------------------------ */

export const ADDITIVE_RULES: AdditiveRule[] = [
  // ---------------- HIGH RISK (-35) ----------------
  {
    id: "red40", name: "Red 40", risk: "high", category: "dyes",
    patterns: ["(fd and c )?red( no)? 40", "allura red", "e ?129"],
    explanation: "A petroleum-derived dye linked to hyperactivity in sensitive children and requiring a warning label in the EU.",
  },
  {
    id: "red3", name: "Red 3", risk: "high", category: "dyes",
    patterns: ["(fd and c )?red( no)? 3", "erythrosine?", "e ?127"],
    explanation: "A synthetic dye shown to cause thyroid tumors in animals and banned by the FDA from food starting in 2027.",
  },
  {
    id: "yellow5", name: "Yellow 5", risk: "high", category: "dyes",
    patterns: ["(fd and c )?yellow( no)? 5", "tartrazine", "e ?102"],
    explanation: "A coal-tar azo dye associated with hyperactivity and allergic-type reactions in sensitive people.",
  },
  {
    id: "yellow6", name: "Yellow 6", risk: "high", category: "dyes",
    patterns: ["(fd and c )?yellow( no)? 6", "sunset yellow", "e ?110"],
    explanation: "A synthetic azo dye that can contain trace carcinogenic contaminants and is linked to behavioral effects in kids.",
  },
  {
    id: "blue1", name: "Blue 1", risk: "high", category: "dyes",
    patterns: ["(fd and c )?blue( no)? 1", "brilliant blue", "e ?133"],
    explanation: "A petroleum-based dye used purely for appearance with no nutritional purpose.",
  },
  {
    id: "blue2", name: "Blue 2", risk: "high", category: "dyes",
    patterns: ["(fd and c )?blue( no)? 2", "indigotine", "indigo carmine", "e ?132"],
    explanation: "A synthetic dye that has shown tumor signals in animal studies and adds only color.",
  },
  {
    id: "green3", name: "Green 3", risk: "high", category: "dyes",
    patterns: ["(fd and c )?green( no)? 3", "fast green", "e ?143"],
    explanation: "A synthetic dye banned in the EU that has been linked to bladder tumors in animal research.",
  },
  {
    id: "tio2", name: "Titanium Dioxide", risk: "high", category: "dyes",
    patterns: ["titanium dioxide", "e ?171"],
    explanation: "A whitening agent the EU banned in food in 2022 because it could not be ruled out as damaging to DNA.",
  },
  {
    id: "bht", name: "BHT", risk: "high", category: "preservatives",
    patterns: ["bht", "butylated hydroxy ?toluene", "e ?321"],
    explanation: "A synthetic antioxidant preservative with mixed evidence of hormone disruption and organ toxicity in animals.",
  },
  {
    id: "bha", name: "BHA", risk: "high", category: "preservatives",
    patterns: ["bha", "butylated hydroxy ?anisole", "e ?320"],
    explanation: "A preservative listed as \"reasonably anticipated to be a human carcinogen\" by the U.S. National Toxicology Program.",
  },
  {
    id: "tbhq", name: "TBHQ", risk: "high", category: "preservatives",
    patterns: ["tbhq", "tert(iary)? ?butyl ?hydroquinone", "e ?319"],
    explanation: "A petroleum-derived preservative that animal studies link to immune-system effects.",
  },
  {
    id: "kbromate", name: "Potassium Bromate", risk: "high", category: "preservatives",
    patterns: ["potassium bromate", "bromated"],
    explanation: "A flour improver classified as a possible human carcinogen and banned in the EU, UK, Canada and California.",
  },
  {
    id: "propylparaben", name: "Propylparaben", risk: "high", category: "preservatives",
    patterns: ["propyl ?paraben", "e ?216"],
    explanation: "A paraben preservative that can mimic estrogen and has been linked to reproductive effects in animals.",
  },
  {
    id: "nanitrite", name: "Sodium Nitrite", risk: "high", category: "nitrates",
    patterns: ["sodium nitrite", "e ?250"],
    explanation: "A curing agent that can form carcinogenic nitrosamines, especially when processed meat is cooked at high heat.",
  },
  {
    id: "nanitrate", name: "Sodium Nitrate", risk: "high", category: "nitrates",
    patterns: ["sodium nitrate", "e ?251"],
    explanation: "A curing salt that converts to nitrite and can form nitrosamines linked to colorectal cancer risk.",
  },

  // ---------------- MODERATE RISK (-20) ----------------
  {
    id: "hfcs", name: "High Fructose Corn Syrup", risk: "moderate", category: "hfcs",
    patterns: ["high fructose corn syrup", "hfcs", "glucose fructose syrup", "isoglucose"],
    explanation: "A highly refined industrial sweetener tied to fatty-liver and metabolic issues when consumed regularly.",
  },
  {
    id: "cornsyrup", name: "Corn Syrup", risk: "moderate", category: "hfcs",
    // Negative lookbehind prevents double-counting inside "high fructose corn syrup".
    patterns: ["(?<!fructose )corn syrup( solids)?"],
    explanation: "A refined glucose syrup used as cheap filler sweetener in ultra-processed foods.",
  },
  {
    id: "soybeanoil", name: "Soybean Oil", risk: "moderate", category: "seedOils",
    patterns: ["soy(bean|a)? oil"],
    explanation: "An industrially solvent-extracted seed oil very high in omega-6 linoleic acid.",
  },
  {
    id: "canolaoil", name: "Canola Oil", risk: "moderate", category: "seedOils",
    patterns: ["canola( oil)?", "rapeseed oil"],
    explanation: "A refined, bleached and deodorized seed oil typically extracted with hexane solvent.",
  },
  {
    id: "cornoil", name: "Corn Oil", risk: "moderate", category: "seedOils",
    patterns: ["corn oil"],
    explanation: "A highly processed seed oil with one of the most lopsided omega-6 to omega-3 ratios.",
  },
  {
    id: "cottonseedoil", name: "Cottonseed Oil", risk: "moderate", category: "seedOils",
    patterns: ["cottonseed( oil)?"],
    explanation: "A refined oil from a non-food crop that is heavily sprayed and high in omega-6 fats.",
  },
  {
    id: "sunfloweroil", name: "Sunflower Oil", risk: "moderate", category: "seedOils",
    patterns: ["sunflower( seed)? oil"],
    explanation: "A refined seed oil whose polyunsaturated fats oxidize readily under high-heat processing.",
  },
  {
    id: "saffloweroil", name: "Safflower Oil", risk: "moderate", category: "seedOils",
    patterns: ["safflower( oil)?"],
    explanation: "A refined seed oil rich in omega-6 fats that are prone to oxidation during frying.",
  },
  {
    id: "grapeseedoil", name: "Grapeseed Oil", risk: "moderate", category: "seedOils",
    patterns: ["grape ?seed( oil)?"],
    explanation: "A by-product seed oil that is usually chemically extracted and very high in omega-6.",
  },
  {
    id: "phoil", name: "Partially Hydrogenated Oil", risk: "moderate", category: "seedOils",
    patterns: ["partially hydrogenated"],
    explanation: "The primary source of artificial trans fat, which raises LDL cholesterol and heart-disease risk.",
  },
  {
    id: "carrageenan", name: "Carrageenan", risk: "moderate", category: "emulsifiers",
    patterns: ["carrageenan", "e ?407"],
    explanation: "A seaweed-derived thickener associated with gut inflammation in animal and cell studies.",
  },
  {
    id: "polysorbate80", name: "Polysorbate 80", risk: "moderate", category: "emulsifiers",
    patterns: ["polysorbate 80", "e ?433"],
    explanation: "A synthetic emulsifier shown in research to disrupt the gut lining and microbiome.",
  },
  {
    id: "polysorbate60", name: "Polysorbate 60", risk: "moderate", category: "emulsifiers",
    patterns: ["polysorbate 60", "e ?435"],
    explanation: "A synthetic detergent-like emulsifier that may irritate the gut barrier.",
  },
  {
    id: "cmc", name: "Carboxymethylcellulose", risk: "moderate", category: "emulsifiers",
    patterns: ["(sodium )?carboxy ?methyl ?cellulose", "cellulose gum", "e ?466"],
    explanation: "A synthetic emulsifier that a 2021 human trial found altered gut bacteria and nutrients in the gut.",
  },
  {
    id: "monodiglycerides", name: "Mono- and Diglycerides", risk: "moderate", category: "emulsifiers",
    patterns: ["mono ?(and|or)? ?di ?glycerides", "mono ?glycerides", "di ?glycerides", "e ?471"],
    explanation: "Processed emulsifiers that can carry hidden trans fats not shown on the nutrition label.",
  },
  {
    id: "sucralose", name: "Sucralose", risk: "moderate", category: "sweeteners",
    patterns: ["sucralose", "e ?955"],
    explanation: "A chlorinated artificial sweetener linked to gut-microbiome changes and glucose-response effects.",
  },
  {
    id: "aspartame", name: "Aspartame", risk: "moderate", category: "sweeteners",
    patterns: ["aspartame", "e ?951"],
    explanation: "An artificial sweetener the WHO's IARC classified as \"possibly carcinogenic to humans\" in 2023.",
  },
  {
    id: "acek", name: "Acesulfame Potassium", risk: "moderate", category: "sweeteners",
    patterns: ["acesulfame( potassium| k)?", "ace k", "e ?950"],
    explanation: "An artificial sweetener with limited long-term safety data and possible metabolic effects.",
  },
  {
    id: "artificialflavor", name: "Artificial Flavor", risk: "moderate", category: "flavors",
    patterns: ["artificial(ly)? flavou?r(s|ed|ing|ings)?"],
    explanation: "Lab-synthesized flavor chemicals whose individual components are not disclosed on the label.",
  },

  // ---------------- LOW RISK (-10) ----------------
  {
    id: "ksorbate", name: "Potassium Sorbate", risk: "low", category: "preservatives",
    patterns: ["potassium sorbate", "e ?202"],
    explanation: "A common mold inhibitor that is generally low risk but signals a highly shelf-stabilized product.",
  },
  {
    id: "nabenzoate", name: "Sodium Benzoate", risk: "low", category: "preservatives",
    patterns: ["sodium benzoate", "e ?211"],
    explanation: "A preservative that can form small amounts of benzene when combined with vitamin C.",
  },
  {
    id: "capropionate", name: "Calcium Propionate", risk: "low", category: "preservatives",
    patterns: ["calcium propionate", "e ?282"],
    explanation: "A bread preservative that small studies have linked to irritability and insulin-response changes.",
  },
  {
    id: "naphosphate", name: "Sodium Phosphate", risk: "low", category: "preservatives",
    patterns: ["(mono|di|tri)?sodium (phosphates?|tripolyphosphate|pyrophosphate|hexametaphosphate)"],
    explanation: "An added inorganic phosphate that is absorbed far more readily than natural phosphorus and may stress the kidneys.",
  },
  {
    id: "xanthan", name: "Xanthan Gum", risk: "low", category: "gums",
    patterns: ["xanthan( gum)?", "e ?415"],
    explanation: "A fermented thickener that is mostly benign but can cause bloating in sensitive guts.",
  },
  {
    id: "soylecithin", name: "Soy Lecithin", risk: "low", category: "gums",
    patterns: ["soy(a|bean)? lecithin", "lecithin soy(a|bean)?"],
    explanation: "A solvent-extracted emulsifier by-product of soybean oil refining.",
  },
  {
    id: "naturalflavor", name: "Natural Flavors", risk: "low", category: "flavors",
    patterns: ["natural( and artificial)? flavou?r(s|ing|ings)?"],
    explanation: "A catch-all label that can hide dozens of undisclosed processing solvents and carriers.",
  },
  {
    id: "citricacid", name: "Citric Acid (manufactured)", risk: "low", category: "flavors",
    patterns: ["citric acid", "e ?330"],
    explanation: "Industrial citric acid is made by fermenting black mold, not squeezed from citrus fruit.",
  },
];

/* ------------------------------------------------------------------------ */
/* Normalization                                                             */
/* ------------------------------------------------------------------------ */

const SEED_WORDS = "soybean|soy|canola|corn|cottonseed|sunflower|safflower|grapeseed|rapeseed";

/**
 * Lowercases, strips accents and punctuation, and expands shorthand oil lists like
 * "Vegetable Oil (Soybean, Canola and/or Sunflower)" into explicit "soybean oil, canola oil ..."
 * so every seed oil is detected. Fully deterministic.
 */
export function normalizeIngredients(raw: string): string {
  let s = (raw || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\band\s*\/\s*or\b/g, " or ");

  // 1) "oil (soybean, canola or sunflower)" -> "oil (soybean oil, canola oil or sunflower oil)"
  s = s.replace(/oils?\s*[([]([^)\]]*)[)\]]/g, (whole, inner: string) => {
    const expanded = inner.replace(
      new RegExp(`\\b(${SEED_WORDS})\\b(?!\\s+(oil|lecithin))`, "g"),
      "$1 oil",
    );
    return whole.replace(inner, expanded);
  });

  // 2) "soybean, canola or sunflower oil" -> "soybean oil, canola oil or sunflower oil".
  //    Only explicit "... or X oil" lists are expanded, so "corn, sunflower oil" (tortilla
  //    chips) is NOT misread as corn oil. "corn" is only expanded when directly joined by
  //    "or" (e.g. "corn or canola oil"), never as a comma-list item ("corn, safflower or ...").
  const NON_GRAIN = SEED_WORDS.replace("|corn", "");
  const seq = new RegExp(
    `\\b((?:(?:${NON_GRAIN})\\s*,\\s*)*(?:${SEED_WORDS})\\s+or\\s+(?:${SEED_WORDS}))\\s+oil\\b`,
    "g",
  );
  s = s.replace(seq, (_whole, list: string) =>
    list.replace(new RegExp(`\\b(${SEED_WORDS})\\b`, "g"), "$1 oil"),
  );

  return s
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------------ */
/* Scoring                                                                   */
/* ------------------------------------------------------------------------ */

const COMPILED = ADDITIVE_RULES.map((rule) => ({
  rule,
  regex: new RegExp(`\\b(?:${rule.patterns.join("|")})\\b`),
}));

export function ratingFor(score: number): { rating: Rating; color: RatingColor } {
  if (score >= 75) return { rating: "Excellent", color: "green" };
  if (score >= 50) return { rating: "Mediocre", color: "yellow" };
  return { rating: "Poor", color: "red" };
}

/**
 * Score an ingredient list. Each additive is deducted at most once, in watchlist order,
 * so results are stable regardless of how many times an additive repeats on the label.
 */
export function scoreIngredients(rawIngredients: string, watchlist: Watchlist = {}): ScoreResult {
  const normalized = normalizeIngredients(rawIngredients);
  const flagged: FlaggedAdditive[] = [];
  const ignored: FlaggedAdditive[] = [];

  for (const { rule, regex } of COMPILED) {
    const m = normalized.match(regex);
    if (!m) continue;
    const hit: FlaggedAdditive = {
      id: rule.id,
      name: rule.name,
      risk: rule.risk,
      category: rule.category,
      penalty: PENALTIES[rule.risk],
      explanation: rule.explanation,
      matched: m[0],
    };
    if (watchlist[rule.category] === false) ignored.push(hit);
    else flagged.push(hit);
  }

  const totalPenalty = flagged.reduce((sum, f) => sum + f.penalty, 0);
  const score = Math.max(0, Math.min(100, 100 - totalPenalty));
  return {
    score,
    ...ratingFor(score),
    flagged,
    ignored,
    totalPenalty,
    normalizedIngredients: normalized,
    rubricVersion: RUBRIC_VERSION,
  };
}
