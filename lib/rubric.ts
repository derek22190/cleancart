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

export type Watchlist = Partial<Record<Category, boolean | "2x" | number>>;

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

export const HIGH_RISK_SCORE_CAP = 49;

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
    patterns: ["potassium bromate", "(?<!un|non|never )bromated( wheat| flour)?"],
    explanation: "A flour improver classified as a possible human carcinogen and banned in the EU, UK, Canada and California.",
  },
  {
    id: "propylparaben", name: "Parabens (Propyl/Methyl/Butyl)", risk: "high", category: "preservatives",
    patterns: ["(propyl|methyl|ethyl|butyl|heptyl) ?paraben", "e ?21[456789]"],
    explanation: "A paraben preservative that can mimic estrogen and has been linked to reproductive effects in animals.",
  },
  {
    id: "propylgallate", name: "Propyl Gallate", risk: "high", category: "preservatives",
    patterns: ["propyl gallate", "e ?310"],
    explanation: "A synthetic antioxidant preservative with suspected endocrine-disrupting properties.",
  },
  {
    id: "bvo", name: "Brominated Vegetable Oil (BVO)", risk: "high", category: "emulsifiers",
    patterns: ["brominated vegetable oil", "bvo", "e ?443"],
    explanation: "A brominated emulsifier banned by the FDA in 2024 due to bromine accumulation and thyroid/nervous system toxicity.",
  },
  {
    id: "ada", name: "Azodicarbonamide", risk: "high", category: "preservatives",
    patterns: ["azodicarbonamide", "e ?927a?"],
    explanation: "A synthetic foaming agent and dough conditioner banned in Europe and Australia.",
  },
  {
    id: "nanitrite", name: "Sodium Nitrite", risk: "high", category: "nitrates",
    patterns: ["(sodium|potassium) nitrite", "e ?249", "e ?250"],
    explanation: "A curing agent that can form carcinogenic nitrosamines, especially when processed meat is cooked at high heat.",
  },
  {
    id: "nanitrate", name: "Sodium Nitrate", risk: "high", category: "nitrates",
    patterns: ["(sodium|potassium) nitrate", "e ?251", "e ?252"],
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
    patterns: ["canola oil", "rapeseed oil"],
    explanation: "A refined, bleached and deodorized seed oil typically extracted with hexane solvent.",
  },
  {
    id: "cornoil", name: "Corn Oil", risk: "moderate", category: "seedOils",
    patterns: ["corn oil"],
    explanation: "A highly processed seed oil with one of the most lopsided omega-6 to omega-3 ratios.",
  },
  {
    id: "cottonseedoil", name: "Cottonseed Oil", risk: "moderate", category: "seedOils",
    patterns: ["cottonseed oil"],
    explanation: "A refined oil from a non-food crop that is heavily sprayed and high in omega-6 fats.",
  },
  {
    id: "sunfloweroil", name: "Sunflower Oil", risk: "moderate", category: "seedOils",
    patterns: ["sunflower( seed)? oil"],
    explanation: "A refined seed oil whose polyunsaturated fats oxidize readily under high-heat processing.",
  },
  {
    id: "saffloweroil", name: "Safflower Oil", risk: "moderate", category: "seedOils",
    patterns: ["safflower( seed)? oil"],
    explanation: "A refined seed oil rich in omega-6 fats that are prone to oxidation during frying.",
  },
  {
    id: "grapeseedoil", name: "Grapeseed Oil", risk: "moderate", category: "seedOils",
    patterns: ["grape ?seed oil"],
    explanation: "A by-product seed oil that is usually chemically extracted and very high in omega-6.",
  },
  {
    id: "phoil", name: "Partially Hydrogenated Oil", risk: "moderate", category: "seedOils",
    patterns: ["partially hydrogenated"],
    explanation: "The primary source of artificial trans fat, which raises LDL cholesterol and heart-disease risk.",
  },
  {
    id: "hydrogoil", name: "Hydrogenated Oil", risk: "moderate", category: "seedOils",
    patterns: ["(?<!partially )hydrogenated (vegetable|soybean|canola|cottonseed|rapeseed|palm|coconut) oils?"],
    explanation: "Chemically hardened industrial fat used to make ultra-processed spreads and snacks shelf-stable.",
  },
  {
    id: "caramelcolor", name: "Caramel Color", risk: "moderate", category: "dyes",
    patterns: ["caramel colou?r(ing)?", "e ?150[abcd]?"],
    explanation: "Industrial ammonia-sulfite caramel coloring that can contain 4-MEI, a California Prop 65 listed carcinogen.",
  },
  {
    id: "edta", name: "Calcium Disodium EDTA", risk: "moderate", category: "preservatives",
    patterns: ["(calcium )?disodium edta", "e ?385"],
    explanation: "A synthetic chelating chemical used to lock colour and flavour in shelf-stable dressings and mayonnaise.",
  },
  {
    id: "datem", name: "DATEM / Dough Conditioners", risk: "moderate", category: "emulsifiers",
    patterns: ["datem", "diacetyl tartaric acid esters?", "(sodium|calcium) stearoyl lactylate", "polyglycerol polyricinoleate", "pgpr"],
    explanation: "Synthetic industrial dough emulsifiers used in ultra-processed commercial breads.",
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
    id: "saccharin", name: "Saccharin / Neotame", risk: "moderate", category: "sweeteners",
    patterns: ["saccharin", "e ?954", "neotame", "e ?961", "advantame", "e ?969"],
    explanation: "High-intensity synthetic artificial sweeteners linked to gut microbiome disruption.",
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
    patterns: ["(mono|di|tri)?(sodium|potassium|calcium) (acid )?(phosphates?|tripolyphosphate|pyrophosphate|hexametaphosphate)"],
    explanation: "An added inorganic phosphate that is absorbed far more readily than natural phosphorus and may stress the kidneys.",
  },
  {
    id: "msg", name: "MSG / Synthetic Flavor Enhancers", risk: "low", category: "flavors",
    patterns: ["monosodium glutamate", "msg", "disodium inosinate", "disodium guanylate"],
    explanation: "Isolated glutamate and nucleotide flavor enhancers engineered to trigger hyper-palatability.",
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
    explanation: "Manufactured citric acid is commonly produced by fermentation and is used to add tartness or preserve shelf life.",
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
    .replace(/\b(un|non)\s*-\s*([a-z]+)/g, "$1$2")
    .replace(/&/g, " and ")
    .replace(/\band\s*\/\s*or\b/g, " or ");

  // Strip negated label marketing claims ("no sodium nitrite", "no artificial flavors", "free of bha/bht")
  s = s.replace(
    /\b(no|without|free of|never any|zero)\s+(added\s+)?(nitrates?( or nitrites?)?|nitrites?( or nitrates?)?|sodium nitrite|artificial (flavou?rs?|colou?rs?|dyes?|sweeteners?|preservatives?)|high fructose corn syrup|hfcs|bha( or bht)?|bht|tbhq|msg|monosodium glutamate|seed oils?|bromated\s+flour)\b(\s+added)?/g,
    " ",
  );

  // 1) "oil/shortening/fat (soybean, canola or sunflower)" -> "... (soybean oil, canola oil or sunflower oil)"
  s = s.replace(/(?:oils?|shortening|fats?)\s*[([]([^)\]]*)[)\]]/g, (whole, inner: string) => {
    if (/\b(facility|equipment|processed|allergen|traces|may contain)\b/.test(inner)) return whole;
    const expanded = inner.replace(
      new RegExp(`\\b(${SEED_WORDS})\\b(?!\\s+(oil|lecithin))`, "g"),
      "$1 oil",
    );
    return whole.replace(inner, expanded);
  });

  // 2) "soybean, canola or/and sunflower oil" -> "soybean oil, canola oil or/and sunflower oil".
  //    Only explicit "... or/and X oil(s)" lists are expanded, so "corn, sunflower oil" (tortilla
  //    chips) is NOT misread as corn oil. "corn" is only expanded when directly joined by
  //    "or"/"and" (e.g. "corn or canola oil"), never as a comma-list item ("corn, safflower or ...").
  const NON_GRAIN = SEED_WORDS.replace("|corn", "");
  const seq = new RegExp(
    `\\b((?:(?:${NON_GRAIN})\\s*,\\s*)*(?:${SEED_WORDS})\\s+(?:or|and)\\s+(?:${SEED_WORDS}))\\s+oils?\\b`,
    "g",
  );
  s = s.replace(seq, (_whole, list: string) =>
    list.replace(new RegExp(`\\b(${SEED_WORDS})\\b`, "g"), "$1 oil"),
  );

  // 3) Expand shared dye prefixes: "Yellow 5 & 6", "FD&C Red No. 40 and 3", "Blue 1, 2"
  s = s.replace(
    /\b((?:fd\s+and\s+c\s+)?)(red|yellow|blue|green)(?:\s+no\.?)?\s+(\d+)\s*(?:,|or|and)\s*(?:no\.?\s*)?(\d+)\b/g,
    "$1$2 $3 $1$2 $4",
  );

  return s
    .replace(/[,;]+/g, " , ")
    .replace(/[^a-z0-9,]+/g, " ")
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
export function scoreIngredients(
  rawIngredients: string,
  watchlist: Watchlist = {},
  familyWatchlist: Category[] = [],
): ScoreResult {
  const normalized = normalizeIngredients(rawIngredients);
  const flagged: FlaggedAdditive[] = [];
  const ignored: FlaggedAdditive[] = [];
  const familySet = new Set(familyWatchlist);

  for (const { rule, regex } of COMPILED) {
    const m = normalized.match(regex);
    if (!m) continue;
    const pref = watchlist[rule.category];
    const mult =
      pref === "2x" || (typeof pref === "number" && pref === 2) || familySet.has(rule.category)
        ? 2
        : typeof pref === "number" && pref > 0
          ? pref
          : 1;
    const hit: FlaggedAdditive = {
      id: rule.id,
      name: rule.name,
      risk: rule.risk,
      category: rule.category,
      penalty: Math.round(PENALTIES[rule.risk] * mult),
      explanation: rule.explanation,
      matched: m[0],
    };
    if (pref === false) ignored.push(hit);
    else flagged.push(hit);
  }

  const totalPenalty = flagged.reduce((sum, f) => sum + f.penalty, 0);
  const hasHighRisk = flagged.some((f) => f.risk === "high");
  const rawScore = Math.max(0, Math.min(100, 100 - totalPenalty));
  // Core Product Rule #1: Any high-risk additive caps the maximum score at 49/100 (Poor).
  const score = hasHighRisk ? Math.min(HIGH_RISK_SCORE_CAP, rawScore) : rawScore;
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

export const NON_ENGLISH_INGREDIENTS =
  /\b(eau\b|sucre\b|huile\b|farine\b|lait\b|sirop\b|lécithine|acide\b|arômes?|colorants?|amidon|émulsifiants?|conservateurs?|noisettes|poudre\b|zutaten|wasser\b|zucker\b|pflanzliches|weizenmehl|speisesalz|säuerungsmittel|magermilchpulver|ingredientes|agua\b|azúcar|aceite\b|harina\b|leche\b|jarabe\b)/i;

const ENGLISH_INGREDIENT_ANCHORS =
  /\b(water|sugar|salt|flour|milk|oil|cream|butter|cheese|eggs?|corn|wheat|rice|oats?|soy|acid|flavor|flavors|starch|syrup|extract|vinegar|yeast|cocoa|beef|chicken|pork|turkey|apple|strawberry)\b/i;

export function isEnglishIngredientText(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (NON_ENGLISH_INGREDIENTS.test(s) && !ENGLISH_INGREDIENT_ANCHORS.test(s)) {
    return false;
  }
  const foreignHits = s.match(new RegExp(NON_ENGLISH_INGREDIENTS.source, "gi")) || [];
  if (foreignHits.length >= 2) return false;
  return true;
}
