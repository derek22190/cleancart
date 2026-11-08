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

export type Rating = "Excellent" | "Good" | "Mediocre" | "Poor" | "Bad";
export type RatingColor = "green" | "yellow" | "red";

export interface NutritionInput {
  caloriesKcal100g?: number;
  sugarsG100g?: number;
  saturatedFatG100g?: number;
  sodiumMg100g?: number;
  fiberG100g?: number;
  proteinG100g?: number;
  fruitsVegNutsPct?: number;
  nutriScoreGrade?: "a" | "b" | "c" | "d" | "e";
  isOrganic?: boolean;
  isWholeFood?: boolean;
  productTitle?: string;
}

export interface YukaBreakdown {
  /** 0..60 points (60% of score, based on Nutri-Score A-E). */
  nutritionScore: number;
  nutriScoreGrade: "A" | "B" | "C" | "D" | "E";
  /** 0..30 points (30% of score, based on additive count & risk tier). */
  additiveScore: number;
  /** 0..10 points (10% of score, awarded for certified Organic or 100% whole foods). */
  organicScore: number;
  /** True when a High-Risk (Red) additive capped the total score at <= 49/100. */
  highRiskCapped: boolean;
  /** Blood sugar / glycemic impact tier for Diabetes & PCOS awareness. */
  glucoseImpact?: "Low Spike" | "Moderate Spike" | "High Spike";
  glucoseColor?: RatingColor;
  glucoseNote?: string;
  calorieNote?: string;
}

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
  matched?: string;
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
  yukaBreakdown?: YukaBreakdown;
}

export const HIGH_RISK_SCORE_CAP = 49;

export const PENALTIES: Record<RiskLevel, number> = {
  high: 35,
  moderate: 20,
  low: 10,
};

export const RISK_LABEL: Record<RiskLevel, string> = {
  high: "High Risk",
  moderate: "Moderate Risk",
  low: "Limited Risk",
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
  {
    id: "celerynitrate", name: "Celery Powder (Natural Nitrates)", risk: "moderate", category: "nitrates",
    patterns: ["(cultured )?celery (powder|juice( powder)?|extract)"],
    explanation: "Concentrated natural source of nitrates and nitrites used to cure 'uncured' bacon and deli meats; reacts with meat proteins under high heat similarly to synthetic nitrites.",
  },

  {
    id: "phoil", name: "Partially Hydrogenated Oil", risk: "high", category: "seedOils",
    patterns: ["partially hydrogenated"],
    explanation: "Artificial trans fat that raises harmful LDL cholesterol, lowers protective HDL cholesterol, stiffens arteries, and increases blood pressure and heart-disease risk.",
  },
  {
    id: "hydrogoil", name: "Hydrogenated Oil", risk: "high", category: "seedOils",
    patterns: ["(?<!partially )hydrogenated (vegetable|soybean|canola|cottonseed|rapeseed|palm|coconut|corn|sunflower) oils?"],
    explanation: "Chemically hardened industrial fat that promotes vascular inflammation, poor LDL/HDL cholesterol ratios, and cardiovascular stress.",
  },
  {
    id: "soybeanoil", name: "Soybean Oil", risk: "high", category: "seedOils",
    patterns: ["soy(bean|a)? oil"],
    explanation: "Hexane-extracted industrial seed oil high in unstable omega-6 linoleic acid and hidden trans fats that drive oxidized LDL cholesterol and blood vessel inflammation.",
  },
  {
    id: "canolaoil", name: "Canola Oil", risk: "high", category: "seedOils",
    patterns: ["canola oil", "rapeseed oil"],
    explanation: "High-heat refined, bleached, and deodorized seed oil with hidden trans fats (0.5%–3%) that degrade LDL cholesterol quality and impair blood vessel elasticity.",
  },
  {
    id: "cornoil", name: "Corn Oil", risk: "high", category: "seedOils",
    patterns: ["corn oil"],
    explanation: "Industrially refined seed oil with a lopsided ~46:1 omega-6 to omega-3 ratio linked to oxidized LDL cholesterol, arterial stiffness, and elevated blood pressure.",
  },
  {
    id: "cottonseedoil", name: "Cottonseed Oil", risk: "high", category: "seedOils",
    patterns: ["cottonseed oil"],
    explanation: "Refined industrial oil from a heavily sprayed non-food crop; high in pro-inflammatory omega-6 fats that harm cholesterol quality and endothelial health.",
  },
  {
    id: "grapeseedoil", name: "Grapeseed Oil", risk: "high", category: "seedOils",
    patterns: ["grape ?seed oil"],
    explanation: "Solvent-extracted by-product oil (~70% omega-6 linoleic acid) that oxidizes rapidly into toxic aldehydes linked to oxidized LDL and vascular stress.",
  },
  {
    id: "ricebranoil", name: "Rice Bran Oil", risk: "high", category: "seedOils",
    patterns: ["rice ?bran oil"],
    explanation: "Industrially solvent-extracted seed/bran oil high in omega-6 linoleic acid and prone to oxidation and hidden trans-fat formation during refining.",
  },
  {
    id: "vegoil", name: "Vegetable Oil (Industrial Blend)", risk: "high", category: "seedOils",
    patterns: ["(?<!brominated |hydrogenated )vegetable oils?"],
    explanation: "Undisclosed industrial blend of refined seed oils (typically soybean, canola, or corn oil) high in oxidized omega-6 fats that harm cholesterol and blood pressure.",
  },

  // ---------------- MODERATE RISK (-20) ----------------
  {
    id: "hfcs", name: "High Fructose Corn Syrup", risk: "moderate", category: "hfcs",
    patterns: ["high fructose corn syrup", "hfcs", "glucose fructose syrup", "isoglucose"],
    explanation: "A highly refined industrial sweetener tied to fatty-liver, high triglycerides, and metabolic issues when consumed regularly.",
  },
  {
    id: "cornsyrup", name: "Corn Syrup", risk: "moderate", category: "hfcs",
    // Negative lookbehind prevents double-counting inside "high fructose corn syrup".
    patterns: ["(?<!fructose )corn syrup( solids)?"],
    explanation: "A refined glucose syrup used as cheap filler sweetener in ultra-processed foods.",
  },
  {
    id: "sunfloweroil", name: "Sunflower Oil", risk: "moderate", category: "seedOils",
    patterns: ["sunflower( seed)? oil"],
    explanation: "Refined seed oil rich in omega-6 fats that oxidize under high-heat frying; cleaner than soybean or canola oil, but far less stable than avocado, olive, or coconut oil.",
  },
  {
    id: "saffloweroil", name: "Safflower Oil", risk: "moderate", category: "seedOils",
    patterns: ["safflower( seed)? oil"],
    explanation: "Refined seed oil rich in omega-6 fats prone to heat oxidation; better than hexane-extracted soybean/canola oil, but inferior to olive or avocado oil.",
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
    id: "ksorbate", name: "Potassium Sorbate / Sorbic Acid", risk: "low", category: "preservatives",
    patterns: ["potassium sorbate", "sorbic acid", "e ?200", "e ?202"],
    explanation: "A common synthetic mold and yeast inhibitor that signals a highly shelf-stabilized product.",
  },
  {
    id: "nabenzoate", name: "Sodium / Potassium Benzoate", risk: "low", category: "preservatives",
    patterns: ["(sodium|potassium) benzoate", "benzoic acid", "e ?210", "e ?211", "e ?212"],
    explanation: "A synthetic beverage preservative that can form small amounts of benzene when combined with vitamin C (ascorbic acid).",
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
  {
    id: "carmine", name: "Carmine", risk: "low", category: "dyes",
    patterns: ["carmine", "cochineal( extract)?", "e ?120"],
    explanation: "An insect-derived red pigment that can trigger allergic reactions in sensitive individuals.",
  },
  {
    id: "quats", name: "Quaternary Ammonium Compounds (Quats)", risk: "high", category: "preservatives",
    patterns: ["quaternary ammonium", "alkyl[a-z0-9 ]*dimethyl[a-z0-9 ]*ammonium chloride", "benzalkonium chloride", "didecyldimethylammonium chloride"],
    explanation: "Harsh chemical disinfectant ('Quats') linked to asthma, airway irritation, skin sensitization, and indoor surface residue.",
  },
  {
    id: "sles", name: "Sodium Laureth Sulfate (Ethoxylated)", risk: "high", category: "emulsifiers",
    patterns: ["sodium laureth sulfate", "linear alkylbenzene sulfonate"],
    explanation: "Ethoxylated surfactant that can carry trace 1,4-dioxane (a probable carcinogen) and harsh skin/respiratory irritants.",
  },
  {
    id: "mit", name: "Methylisothiazolinone (MIT)", risk: "high", category: "preservatives",
    patterns: ["methylisothiazolinone", "methylchloroisothiazolinone", "benzisothiazolinone"],
    explanation: "High-risk synthetic biocide and potent contact allergen linked to severe skin sensitization and dermatitis.",
  },
  {
    id: "parabens", name: "Parabens (Endocrine Disruptor)", risk: "high", category: "preservatives",
    patterns: ["methylparaben", "propylparaben", "butylparaben", "ethylparaben", "isobutylparaben"],
    explanation: "Synthetic cosmetic preservatives shown to mimic estrogen and disrupt hormone signaling.",
  },
  {
    id: "chem_sunscreen", name: "Chemical UV Filters (Oxybenzone / Homosalate)", risk: "high", category: "preservatives",
    patterns: ["oxybenzone", "octinoxate", "homosalate", "octocrylene", "avobenzone"],
    explanation: "Chemical sunscreen filters that absorb through skin into the bloodstream and are linked to hormone disruption.",
  },
  {
    id: "formaldehyde_releaser", name: "DMDM Hydantoin (Formaldehyde Releaser)", risk: "high", category: "preservatives",
    patterns: ["dmdm hydantoin", "imidazolidinyl urea", "diazolidinyl urea", "quaternium 15", "bronopol"],
    explanation: "Preservative that slowly releases formaldehyde, a known human carcinogen and scalp/skin sensitizer.",
  },
  {
    id: "triclosan", name: "Triclosan / Synthetic Antibacterial", risk: "high", category: "preservatives",
    patterns: ["triclosan", "triclocarban", "chlorhexidine"],
    explanation: "Halogenated antibacterial agent linked to thyroid hormone disruption and antibiotic resistance.",
  },
  {
    id: "synfragrance", name: "Synthetic Fragrance / Parfum", risk: "moderate", category: "flavors",
    patterns: ["synthetic (lemon )?fragrance", "parfum"],
    explanation: "Undisclosed chemical scent mixture and solvent carriers that can trigger allergies, migraines, and airway irritation.",
  },
  {
    id: "opticalbrightener", name: "Optical Brighteners", risk: "moderate", category: "dyes",
    patterns: ["optical brighteners?", "disodium distyrylbiphenyl disulfonate"],
    explanation: "Synthetic UV-reflecting chemical dyes designed to remain bound to fabric against skin; non-biodegradable.",
  },
  {
    id: "aluminum_salts", name: "Aluminum Zirconium / Chlorohydrate", risk: "moderate", category: "preservatives",
    patterns: ["aluminum zirconium[a-z0-9 ]*", "aluminum chlorohydrate", "aluminum sesquichlorohydrate"],
    explanation: "Synthetic aluminum salts used in antiperspirants to plug sweat ducts.",
  },
  {
    id: "wetstrengthresin", name: "Bleached Pulp & Wet-Strength Resin", risk: "low", category: "emulsifiers",
    patterns: ["wet strength polyamide epichlorohydrin resin", "elemental chlorine free bleached"],
    explanation: "Conventional virgin wood pulp treated with chlorine-derivative bleaching and synthetic wet-strength binder resins.",
  },
  {
    id: "phenoxyethanol", name: "Phenoxyethanol", risk: "low", category: "preservatives",
    patterns: ["phenoxyethanol"],
    explanation: "Synthetic glycol-ether preservative used in cosmetics, lotions, and wipes; restricted in infant products in the EU.",
  },
  {
    id: "petrolatum_peg", name: "Petrolatum / Mineral Oil / Dimethicone", risk: "low", category: "emulsifiers",
    patterns: ["petrolatum", "mineral oil", "paraffinum liquidum", "dimethicone", "cocamidopropyl betaine"],
    explanation: "Petroleum-derived occlusives, silicones, or synthetic foaming surfactants used in conventional personal care.",
  },
];

/* ------------------------------------------------------------------------ */
/* Normalization                                                             */
/* ------------------------------------------------------------------------ */

const SEED_WORDS = "soybean|soy|canola|corn|cottonseed|sunflower|safflower|grapeseed|rapeseed|rice bran";

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
  s = s.replace(/(?:vegetable\s+)?(oils?|shortening|fats?)\s*[([]([^)\]]*)[)\]]/g, (whole, kind: string, inner: string) => {
    if (/\b(facility|equipment|processed|allergen|traces|may contain)\b/.test(inner)) return whole;
    const expanded = inner.replace(
      new RegExp(`\\b(${SEED_WORDS})\\b(?!\\s+(oil|lecithin))`, "g"),
      "$1 oil",
    );
    return `${kind} (${expanded})`;
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

function stepPoints(val: number, thresholds: number[]): number {
  let pts = 0;
  for (const t of thresholds) {
    if (val > t) pts++;
    else break;
  }
  return pts;
}

/**
 * Estimates per-100g nutrition when Open Food Facts / USDA did not supply a full nutriments block,
 * using product category keywords and FDA ingredient-order weight position.
 */
export function estimateNutritionFromProduct(productTitle = "", rawIngredients = ""): Required<Pick<NutritionInput, "caloriesKcal100g" | "sugarsG100g" | "saturatedFatG100g" | "sodiumMg100g" | "fiberG100g" | "proteinG100g" | "fruitsVegNutsPct">> {
  const combined = `${productTitle} ${rawIngredients}`.toLowerCase();
  const clauses = rawIngredients.toLowerCase().split(/[,;]/).map((c) => c.trim()).filter(Boolean);
  const top3 = clauses.slice(0, 3).join(" ");

  // 1. Real Butter & Ghee (excluding nut/seed butters and buttermilk)
  if (
    /\b(butter|kerrygold|ghee|land o'? ?lakes)\b/.test(combined) &&
    !/\b(peanut butter|almond butter|cashew butter|sunflower butter|cookie butter|cocoa butter|apple butter|buttermilk|butterfinger|butter pecan|popcorn)\b/.test(combined)
  ) {
    const isUnsalted = /\b(unsalted|ghee|clarified)\b/.test(combined);
    return {
      caloriesKcal100g: 717,
      sugarsG100g: 0.1,
      saturatedFatG100g: 51.0,
      sodiumMg100g: isUnsalted ? 11 : 640,
      fiberG100g: 0,
      proteinG100g: 0.9,
      fruitsVegNutsPct: 0,
    };
  }
  // 2. Bakery Donuts, Bismarks, Pastries, Danishes, Cinnamon Rolls, Fritters, Cake, Frosting
  if (/\b(bismark|bismarks|donut|donuts|doughnut|doughnuts|fritter|danish|cinnamon roll|honey bun|eclair|strudel|turnover|cupcake|frosting|icing|glazed|cake|brownie|pie|pastry|pastries|pop[- ]?tart|toaster strudel|muffin|muffins|croissant)\b/.test(combined) && !/\b(sausage|bacon|ham|egg)\b/.test(combined)) {
    return { caloriesKcal100g: 405, sugarsG100g: 25, saturatedFatG100g: 9.0, sodiumMg100g: 340, fiberG100g: 1.2, proteinG100g: 4.5, fruitsVegNutsPct: 0 };
  }
  // 2b. Diet / Zero-Sugar Sodas, Sparkling Waters, Pre-Workouts & Sugar-Free Beverages (must run BEFORE candy/caramel checks so "caramel color" in Diet Coke never matches candy!)
  if (
    /\b(diet\s+coke|coke\s+zero|pepsi\s+zero|diet\s+pepsi|diet\s+dr\.?\s*pepper|dr\.?\s*pepper\s+zero|diet\s+mountain\s+dew|mtn\s+dew\s+zero|sprite\s+zero|zero\s+sugar|sugar[- ]?free|monster\s+(?:energy\s+)?(?:zero|ultra)|white\s+monster|red\s*bull\s+(?:sugar\s*free|sugarfree|zero)|celsius|alani(?:\s+nu)?|ghost\s+(?:energy|legend|pre)|c4\s+(?:energy|performance|smart|pre|original|ultimate)|bang\s+energy|reign|rockstar\s+pure\s+zero|prime\s+(?:energy|hydration)|5[- ]?hour\s+energy|zoa|pre[- ]?workout|preworkout|gorilla\s+mode|ryse|bucked\s+up|total\s+war|gatorade\s+zero|powerade\s+zero|propel|vitamin\s*water\s+zero|sparkling\s+ice|zevia|fiji|evian|smart\s*water|dasani|aquafina|essentia|core\s+hydration|liquid\s+death|san\s+pellegrino|perrier|topo\s+chico|saratoga|waterloo|bubly|polar\s+seltzer|nixie|ito\s+en|unsweetened\s+(?:tea|green\s+tea|black\s+tea|iced\s+tea|cold\s+brew|yerba\s+mate)|yerba\s+mate\s+unsweetened|stok.*unsweetened|lmnt|carbonated\s+water|sparkling\s+water|seltzer|club\s+soda|la\s*croix|spindrift|hint\s+water)\b/.test(combined) &&
    !/\b(cane\s+sugar|high\s+fructose\s+corn\s+syrup|corn\s+syrup|liquid\s+sugar)\b/.test(combined)
  ) {
    return { caloriesKcal100g: 0, sugarsG100g: 0, saturatedFatG100g: 0, sodiumMg100g: 12, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 0 };
  }
  // 3. Cookies, Candy, Chocolate, Wafers (Knoppers, Storck/Merci, Kinder, Ferrero), Gummies, Ice Cream, Sweet Snacks
  // Strip "caramel color" / "caramel colour" before testing so beverages/sauces with caramel color never match candy
  const combinedWithoutCaramelColor = combined.replace(/\bcaramel\s+colou?r\b/g, "");
  if (/\b(cookie|cookies|oreo|candy|gummies|chocolate|knoppers|storck|merci|kinder|ferrero|lindt|ghirardelli|hershey|reese'?s|snickers|twix|kit\s*kat|m&m'?s|wafer|wafers|truffle|truffles|praline|toffee|nutella|marshmallow|fudge|caramel|ice cream|gelato|popsicle)\b/.test(combinedWithoutCaramelColor) && !/\b(cashew cookie|larabar|lärabar|oats|cereal|puffs|chocolate\s+milk|protein\s+shake)\b/.test(combinedWithoutCaramelColor)) {
    return { caloriesKcal100g: 510, sugarsG100g: 38, saturatedFatG100g: 14.5, sodiumMg100g: 180, fiberG100g: 1.8, proteinG100g: 5.0, fruitsVegNutsPct: 0 };
  }
  // 3b. Pure Sugars, Maple Syrup, Honey, Agave & Molasses
  if (/\b(maple\s+syrup|pure\s+honey|raw\s+honey|clover\s+honey|wildflower\s+honey|manuka\s+honey|agave\s+(?:nectar|syrup)|molasses|cane\s+sugar|granulated\s+sugar|brown\s+sugar|powdered\s+sugar|confectioners\s+sugar|coconut\s+sugar|turbinado\s+sugar)\b/.test(combined) && !/\b(cured|uncured|bacon|ham|turkey|sausage|jerky|salmon|beans|mustard|ketchup|bbq|sauce|cereal|granola|oats|yogurt|bread|chips|crackers|tea|yerba\s+mate|kombucha|lemonade|coffee|latte)\b/.test(combined)) {
    return { caloriesKcal100g: 285, sugarsG100g: 68, saturatedFatG100g: 0, sodiumMg100g: 10, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 0 };
  }
  // 4. Beverages: Sodas, Juice Drinks (Capri Sun, Hi-C, Kool-Aid, SunnyD), Lemonade, Sweet Tea, Sports Drinks, Energy Drinks
  if (/\b(capri\s*sun|hi-?c|kool-?aid|hawaiian\s+punch|sunny\s*d|tang|tampico|fruit\s+punch|juice\s+pouch\w*|juice\s+drink|lemonade|limeade|sweet\s+tea|arizona|arnold\s+palmer|mucho\s+mango|pure\s+leaf|gold\s+peak|snapple|brisk|milo'?s|soda|cola|pepsi|coke|mountain\s+dew|mtn\s+dew|baja\s+blast|sprite|dr\.?\s*pepper|fanta|root\s+beer|a\s*&\s*w|barq'?s|mug\s+root\s+beer|ginger\s+ale|canada\s+dry|schweppes|seagram'?s|7\s*up|crush|sunkist|starry|squirt|jarritos|gatorade|powerade|bodyarmor|vitamin\s*water|electrolit|biolyte|liquid\s+i\.?v\.?|red\s*bull|monster|rockstar|nos\s+energy|full\s+throttle|frappuccino|doubleshot|dunkin'?\s+iced\s+coffee|sports?\s+drink|energy\s+drink)\b/.test(combined) && !/\b(unsweetened|zero\s+sugar|zero\s+ultra|sugar\s*free|sugarfree|diet|spindrift|la\s*croix|hint\s+water|nooma|olipop|poppi|ito\s+en|stok)\b/.test(combined)) {
    return { caloriesKcal100g: 42, sugarsG100g: 9.8, saturatedFatG100g: 0, sodiumMg100g: 15, fiberG100g: 0, proteinG100g: 0, fruitsVegNutsPct: 10 };
  }
  // 4b. 100% Fruit Juices (Orange Juice, Apple Juice, Grape Juice, Cranberry Juice — ~9-10g natural liquid sugar/100ml with 0g fiber)
  if (/\b(orange\s+juice|apple\s+juice|grape\s+juice|cranberry\s+juice|pineapple\s+juice|grapefruit\s+juice|pomegranate\s+juice|tart\s+cherry\s+juice|tropicana|simply\s+orange|minute\s+maid|uncle\s+matt'?s|mott'?s|martinelli'?s|welch'?s.*juice|ocean\s+spray|pom\s+wonderful|lakewood|knudsen|honest\s+kids|naked\s+juice|bolthouse|nature'?s\s+nectar|100%\s+(pure\s+)?(organic\s+)?(orange|apple|grape|cranberry|pomegranate|fruit)\s+juice)\b/.test(combined)) {
    return { caloriesKcal100g: 45, sugarsG100g: 9.2, saturatedFatG100g: 0, sodiumMg100g: 2, fiberG100g: 0.2, proteinG100g: 0.7, fruitsVegNutsPct: 100 };
  }
  // 4c. Eggnog & Liquid Coffee Creamers
  if (/\b(eggnog|egg nog|creamer|coffee[- ]?mate|international delight)\b/.test(combined)) {
    return { caloriesKcal100g: 145, sugarsG100g: 21, saturatedFatG100g: 4.5, sodiumMg100g: 95, fiberG100g: 0, proteinG100g: 1.5, fruitsVegNutsPct: 0 };
  }
  // 5. Sweetened Breakfast Cereals
  if (/\b(froot loops|lucky charms|cinnamon toast|frosted|crunch|puffs|cereal)\b/.test(combined) && !/\b(original cheerios|heritage flakes|rolled oats|steel cut)\b/.test(combined)) {
    return { caloriesKcal100g: 385, sugarsG100g: 28, saturatedFatG100g: 1.5, sodiumMg100g: 460, fiberG100g: 3.5, proteinG100g: 5.5, fruitsVegNutsPct: 0 };
  }
  // 5b. Crispy Fried Onions, Onion Rings, French Fries, Tater Tots, Fried Battered Sides
  if (/\b(crispy\s+fried\s+onions?|french'?s.*onions?|fried\s+onions?|french\s+fried\s+onions?|onion\s+rings?|mozzarella\s+sticks?|jalapeno\s+poppers?|corn\s*dogs?|funnel\s+cake)\b/.test(combined)) {
    return { caloriesKcal100g: 570, sugarsG100g: 5.5, saturatedFatG100g: 15.5, sodiumMg100g: 800, fiberG100g: 2.5, proteinG100g: 5.0, fruitsVegNutsPct: 15 };
  }
  // 6. Chips, Crackers (Ritz, Cheez-It, Goldfish), Pretzels, Macaroni & Cheese, Salty Snacks
  if (
    /\b(doritos|cheetos|takis|chips|crisps|ritz|cheez[- ]?it|goldfish|triscuit|wheat thins|saltines|crackers|pretzels|macaroni|mac\s*&\s*cheese|mac and cheese|shells and cheese|velveeta|ramen)\b/.test(combined)
  ) {
    if (/\b(mary'?s gone crackers|boulder canyon|avocado oil|extra virgin olive oil|siete|lesserevil|quinn|annie'?s|goodles|simple mills)\b/.test(combined)) {
      const hasOrganicTag = /\borganic\b/.test(combined);
      return hasOrganicTag
        ? { caloriesKcal100g: 430, sugarsG100g: 1.0, saturatedFatG100g: 2.2, sodiumMg100g: 250, fiberG100g: 5.5, proteinG100g: 6.5, fruitsVegNutsPct: 65 }
        : { caloriesKcal100g: 464, sugarsG100g: 0, saturatedFatG100g: 3.5, sodiumMg100g: 265, fiberG100g: 6.5, proteinG100g: 3.6, fruitsVegNutsPct: 0 };
    }
    return { caloriesKcal100g: 485, sugarsG100g: 5.5, saturatedFatG100g: 6.5, sodiumMg100g: 680, fiberG100g: 2.0, proteinG100g: 6.5, fruitsVegNutsPct: 0 };
  }
  // 7. Bacon, Sausage, Kielbasa, Hot Dogs, Salami, Pepperoni, Processed Deli Meat (excluding Deli Soups & Salads)
  if (
    /\b(deli|bologna|hot dog|hotdogs|frankfurter|salami|pepperoni|bacon|sausage|kielbasa|bratwurst|chorizo|pancetta|prosciutto|lunchables|jimmy dean)\b/.test(combined) &&
    !/\b(soup|chowder|bisque|stew|chili|broth|stock|salad|lettuce|romaine|spinach)\b/.test(combined)
  ) {
    if (/\b(applegate organics|oven roasted turkey breast)\b/.test(combined) && !/\b(bacon|sausage|kielbasa|nitrite|celery powder)\b/.test(combined)) {
      return { caloriesKcal100g: 98, sugarsG100g: 1.0, saturatedFatG100g: 0.4, sodiumMg100g: 250, fiberG100g: 0, proteinG100g: 19.0, fruitsVegNutsPct: 0 };
    }
    if (/\bturkey bacon\b/.test(combined)) {
      return { caloriesKcal100g: 215, sugarsG100g: 1.5, saturatedFatG100g: 2.8, sodiumMg100g: 760, fiberG100g: 0, proteinG100g: 17.0, fruitsVegNutsPct: 0 };
    }
    return { caloriesKcal100g: 420, sugarsG100g: 1.5, saturatedFatG100g: 14.0, sodiumMg100g: 980, fiberG100g: 0, proteinG100g: 22.0, fruitsVegNutsPct: 0 };
  }
  // 7b. Basted / Solution-Injected Whole Turkey & Poultry (e.g. Butterball Whole Turkey with salt solution)
  if (/\b(butterball|whole.*turkey|frozen.*turkey|basted.*turkey|young\s+turkey)\b/.test(combined) && !/\b(organic|plain\s+raw)\b/.test(combined)) {
    return { caloriesKcal100g: 160, sugarsG100g: 0, saturatedFatG100g: 4.2, sodiumMg100g: 310, fiberG100g: 0, proteinG100g: 19.0, fruitsVegNutsPct: 0 };
  }
  // 8. Breaded / Crispy Chicken Patties, Fillets, Nuggets, Tenders, Hot Pockets, Stuffed Sandwiches
  if (/\b(crispy chicken|breaded chicken|chicken patties|chicken patty|chicken nuggets|chicken tenders|chicken strips|popcorn chicken|hot pocket|hot pockets|lean pocket|pizza rolls|bagel bites|corn dog)\b/.test(combined)) {
    if (/\b(just\s+bare|applegate|organic)\b/.test(combined)) {
      return { caloriesKcal100g: 175, sugarsG100g: 1.0, saturatedFatG100g: 1.5, sodiumMg100g: 380, fiberG100g: 1.0, proteinG100g: 18.5, fruitsVegNutsPct: 0 };
    }
    return { caloriesKcal100g: 265, sugarsG100g: 2.5, saturatedFatG100g: 4.8, sodiumMg100g: 620, fiberG100g: 1.5, proteinG100g: 13.0, fruitsVegNutsPct: 0 };
  }
  // 9. Gravy, Condensed Soup, Bouillon vs. Fresh Soups / Clam Chowder / Stews
  if (/\b(gravy|bouillon|condensed soup|cream of mushroom|cream of chicken)\b/.test(combined)) {
    return { caloriesKcal100g: 65, sugarsG100g: 1.5, saturatedFatG100g: 1.8, sodiumMg100g: 560, fiberG100g: 0, proteinG100g: 2.0, fruitsVegNutsPct: 0 };
  }
  if (/\b(clam chowder|chowder|bisque|stew|chili|soup)\b/.test(combined)) {
    return { caloriesKcal100g: 115, sugarsG100g: 1.5, saturatedFatG100g: 3.2, sodiumMg100g: 350, fiberG100g: 1.2, proteinG100g: 5.5, fruitsVegNutsPct: 45 };
  }
  // 10. Dressings, Mayonnaise, Ketchup, Condiments
  if (/\b(ranch|dressing|mayo|mayonnaise|ketchup|bbq sauce|barbecue sauce)\b/.test(combined)) {
    const isCleanAvocado = /\b(avocado oil|extra virgin olive oil|primal kitchen|chosen foods)\b/.test(combined);
    return isCleanAvocado
      ? { caloriesKcal100g: 140, sugarsG100g: 0.5, saturatedFatG100g: 1.5, sodiumMg100g: 160, fiberG100g: 1.0, proteinG100g: 3.5, fruitsVegNutsPct: 85 }
      : { caloriesKcal100g: 440, sugarsG100g: 14, saturatedFatG100g: 6.5, sodiumMg100g: 820, fiberG100g: 0, proteinG100g: 1.0, fruitsVegNutsPct: 0 };
  }
  // 11. Flavored / Sweetened Yogurt vs Plain Yogurt
  if (/\byogurt\b/.test(combined)) {
    const isPlain = /\b(plain|unsweetened)\b/.test(combined) && !/\b(strawberry|berry|vanilla|peach|mango|flip|sugar|corn syrup)\b/.test(combined);
    return isPlain
      ? { caloriesKcal100g: 62, sugarsG100g: 3.5, saturatedFatG100g: 0.8, sodiumMg100g: 38, fiberG100g: 0, proteinG100g: 9.5, fruitsVegNutsPct: 0 }
      : { caloriesKcal100g: 105, sugarsG100g: 14.5, saturatedFatG100g: 1.8, sodiumMg100g: 55, fiberG100g: 0, proteinG100g: 4.2, fruitsVegNutsPct: 10 };
  }
  // 12. Sweetened Dried / Dehydrated Fruit (e.g. AUSPITEE Dried Blueberries / Dried Cranberries / Craisins)
  if (
    /\b(auspitee|craisins|sweetened dried|dried cranberr\w*|dried blueberr\w*|dried cherr\w*|dried strawberr\w*|dehydrated\s+(blueberr\w*|cranberr\w*|fruit|berr\w*))\b/.test(combined) &&
    !/\b(unsweetened|freeze[- ]?dried)\b/.test(combined)
  ) {
    return { caloriesKcal100g: 325, sugarsG100g: 65, saturatedFatG100g: 0.2, sodiumMg100g: 5, fiberG100g: 5.0, proteinG100g: 0.5, fruitsVegNutsPct: 60 };
  }
  // 13. Freeze-Dried Fruit Crisps & Fruit Powders (concentrated natural fruit sugars ~52-60g/100g & ~345 kcal/100g)
  if (/\b(freeze[- ]?dried|fruit crisps?|berry powder|blueberry powder|strawberry powder|fruit powder)\b/.test(combined)) {
    return { caloriesKcal100g: 345, sugarsG100g: 54, saturatedFatG100g: 0.2, sodiumMg100g: 8, fiberG100g: 7.5, proteinG100g: 2.5, fruitsVegNutsPct: 85 };
  }
  // 14. Dairy Milk (Whole Milk has ~2.0g/100ml saturated fat; Reduced-Fat/Skim has lower saturated fat)
  if (
    /\b(milk|lactaid|fairlife)\b/.test(combined) &&
    !/\b(yogurt|yoghurt|kefir|skyr|cheese|butter|cream|ice cream|coconut milk|almond milk|oat milk|soy milk|chocolate|condensed|evaporated|buttermilk)\b/.test(combined)
  ) {
    const isLowFat = /\b(skim|nonfat|fat[- ]?free|1%|2%|reduced[- ]?fat)\b/.test(combined);
    return isLowFat
      ? { caloriesKcal100g: 46, sugarsG100g: 4.8, saturatedFatG100g: 0.9, sodiumMg100g: 44, fiberG100g: 0, proteinG100g: 3.4, fruitsVegNutsPct: 0 }
      : { caloriesKcal100g: 62, sugarsG100g: 4.8, saturatedFatG100g: 2.1, sodiumMg100g: 43, fiberG100g: 0, proteinG100g: 3.2, fruitsVegNutsPct: 0 };
  }
  // 14b. Canned Sweet Corn / Canned Vegetables with Added Salt/Sugar
  if (/\b(sweet\s+corn|whole\s+kernel\s+corn|golden\s+sweet\s+corn|canned\s+corn|cream\s+style\s+corn)\b/.test(combined)) {
    return { caloriesKcal100g: 71, sugarsG100g: 5.3, saturatedFatG100g: 0.2, sodiumMg100g: 230, fiberG100g: 1.8, proteinG100g: 2.4, fruitsVegNutsPct: 85 };
  }
  // 15. Ingredient-order heuristic: if Sugar/Syrup/Honey/Maple/Agave is in the first 3 ingredients
  if (/\b(sugar|cane sugar|brown sugar|coconut sugar|corn syrup|high fructose corn syrup|dextrose|fructose|maltose|maple syrup|honey|agave|molasses)\b/.test(top3)) {
    return { caloriesKcal100g: 370, sugarsG100g: 22, saturatedFatG100g: 5.0, sodiumMg100g: 260, fiberG100g: 1.5, proteinG100g: 4.0, fruitsVegNutsPct: 0 };
  }
  // Default balanced whole/minimally-processed staple
  return { caloriesKcal100g: 110, sugarsG100g: 2.0, saturatedFatG100g: 1.2, sodiumMg100g: 65, fiberG100g: 3.0, proteinG100g: 6.5, fruitsVegNutsPct: 65 };
}

/**
 * Yuka 3-Pillar Breakdown + Deterministic Additive Rubric (0–100):
 *  - Computes Yuka's 3-pillar breakdown (60% Nutrition, 30% Additives, 10% Organic)
 *    using official Nutri-Score tables for both solid foods and beverages.
 *  - Ensures the final 0–100 score always matches the 3-pillar breakdown so high-sugar,
 *    high-saturated-fat, high-sodium, or non-organic items never falsely display 100/100.
 *  - HONESTY INVARIANT: Never displays estimated gram/mg/kcal numbers as measured facts
 *    when nutrition was estimated from keywords rather than provided by a database/label.
 */
export function scoreProductYuka(
  rawIngredients: string,
  watchlist: Watchlist = {},
  familyWatchlist: Category[] = [],
  nutrition: NutritionInput = {},
): ScoreResult {
  const base = scoreIngredients(rawIngredients, watchlist, familyWatchlist);
  const titleAndIng = `${nutrition.productTitle || ""} ${rawIngredients}`;
  const clauses = rawIngredients.toLowerCase().split(/[,;]/).map((c) => c.trim()).filter(Boolean);
  const top3 = clauses.slice(0, 3).join(" ");
  // Organic sugar is still sugar — never exempt organic cane sugar from top-3 added sugar!
  const hasTop3AddedSugar =
    /\b(corn syrup|high fructose corn syrup|dextrose|fructose|maltose|frosting|icing|liquid sugar|invert sugar|sugar|cane sugar|brown sugar|coconut sugar|maple syrup|honey|agave|molasses)\b/.test(top3);

  const isBeverage =
    /\b(capri\s*sun|hi-?c|kool-?aid|hawaiian\s+punch|sunny\s*d|tang|tampico|fruit\s+punch|juice\s+pouch\w*|juice\s+drink|orange\s+juice|apple\s+juice|grape\s+juice|cranberry\s+juice|pineapple\s+juice|grapefruit\s+juice|pomegranate\s+juice|tart\s+cherry\s+juice|tropicana|simply\s+orange|simply\s+lemonade|minute\s+maid|uncle\s+matt'?s|mott'?s|martinelli'?s|welch'?s|ocean\s+spray|pom\s+wonderful|lakewood|knudsen|honest\s+kids|naked\s+juice|bolthouse|suja|v8|nature'?s\s+nectar|lemonade|limeade|sweet\s+tea|iced\s+tea|green\s+tea|black\s+tea|yerba\s+mate|guayaki|guayakí|clean\s+cause|guru|arizona|arnold\s+palmer|mucho\s+mango|pure\s+leaf|gold\s+peak|snapple|brisk|milo'?s|ito\s+en|just\s+ice\s+tea|cold\s+brew|stok|frappuccino|doubleshot|dunkin|la\s+colombe|soda|cola|pepsi|coke|coca[- ]?cola|mountain\s+dew|mtn\s+dew|baja\s+blast|sprite|dr\.?\s*pepper|fanta|root\s+beer|a\s*&\s*w|barq'?s|mug\s+root\s+beer|ginger\s+ale|canada\s+dry|schweppes|seagram'?s|7\s*up|crush|sunkist|starry|squirt|fresca|jarritos|zevia|culture\s+pop|gatorade|gatorlyte|powerade|bodyarmor|prime|red\s*bull|monster|celsius|alani|ghost\s+(?:energy|legend)|c4\s+(?:energy|performance|smart|original|ultimate|pre)|bang\s+energy|reign|rockstar|5[- ]?hour\s+energy|zoa|nos\s+energy|full\s+throttle|pre[- ]?workout|preworkout|gorilla\s+mode|ryse|bucked\s+up|total\s+war|sports?\s+drink|energy\s+drink|electrolyte|liquid\s+i\.?v\.?|lmnt|pedialyte|electrolit|biolyte|nuun|propel|vitamin\s*water|sparkling\s+ice|bai|kombucha|olipop|poppi|spindrift|la\s*croix|waterloo|bubly|polar\s+seltzer|nixie|hint\s+water|fiji|evian|smart\s*water|dasani|aquafina|essentia|core\s+hydration|liquid\s+death|san\s+pellegrino|perrier|topo\s+chico|saratoga|spring\s+water|mineral\s+water|artesian\s+water|purified\s+water|alkaline\s+water|coconut\s+water|harmless\s+harvest|vita\s+coco|sparkling\s+water|seltzer|club\s+soda)\b/i.test(titleAndIng) &&
    !/\b(gummies|gummy|bars?|chews?|crisps?|sauce|marinade|glaze|dressing|vinaigrette|vanilla\s+extract|almond\s+extract|lemon\s+extract|fruit\s+spread|jam|jelly)\b/i.test(nutrition.productTitle || "");

  const is100PctFruitJuice =
    isBeverage &&
    !hasTop3AddedSugar &&
    /\b(100%\s+(pure\s+)?(organic\s+)?(orange|apple|grape|cranberry|grapefruit|pomegranate|pineapple|tart\s+cherry|fruit)\s+juice|orange\s+juice|apple\s+juice|grape\s+juice|pomegranate\s+juice|tart\s+cherry\s+juice|simply\s+orange|tropicana|uncle\s+matt'?s|mott'?s|martinelli'?s|pom\s+wonderful|lakewood|knudsen)\b/i.test(titleAndIng) &&
    !/\b(capri\s*sun|hi-?c|kool-?aid|hawaiian\s+punch|sunny\s*d|juice\s+drink|juice\s+pouch\w*|cocktail|blend\s+with\s+sugar|high\s+fructose|lemonade|limeade)\b/i.test(titleAndIng);

  const NON_WHOLE_FOOD =
    /\b(wipes?|disinfect\w*|detergent|laundry|bleach|cleaner|toilet\s*paper|paper\s*towels?|shampoo|conditioner|body\s*wash|lotion|moisturizer|sunscreen|deodorant|antiperspirant|toothpaste|mouthwash|cleanser|serum|soap|diapers?|kibble|dog\s*food|cat\s*food|butter|ghee|margarine|shortening|lard|milk|lactaid|bacon|sausage|kielbasa|hot\s*dog|frankfurter|salami|pepperoni|bologna|prosciutto|pancetta|chorizo|deli\s+meat|lunch\s*meat|gravy|bouillon|cheese|cheddar|mozzarella|parmesan|provolone|swiss|gouda|brie|feta|velveeta|cream\s+cheese|sour\s+cream|heavy\s+cream|whipping\s+cream|ice\s+cream|gelato|chips|crisps|crispy|fried|battered|breaded|instant\s+mashed|potato\s+flakes|freeze[- ]?dried|powder|dried|dehydrated|auspitee|craisins|ritz|crackers|pretzels|popcorn|cookie|cookies|wafer|wafers|knoppers|storck|merci|kinder|ferrero|chocolate|candy|gummies|truffle|praline|cake|pie|pastry|pastries|donut|doughnut|bismark|muffin|croissant|waffle|pancake|patties|patty|nuggets|tenders|strips|hot\s*pocket|pizza|fries|ramen|macaroni|juice|soda|cola|capri\s*sun|lemonade|maple\s+syrup|honey|agave|molasses|cane\s+sugar)\b/i;

  const isWholeFood =
    nutrition.isWholeFood !== false &&
    !NON_WHOLE_FOOD.test(titleAndIng) &&
    !isBeverage &&
    !hasTop3AddedSugar &&
    (Boolean(nutrition.isWholeFood) ||
      /100% (pure |fresh )?whole (food|produce)|^whole food:/i.test(rawIngredients));

  const isOrganic =
    Boolean(nutrition.isOrganic) ||
    /\b(organic|usda organic|biologique)\b/i.test(titleAndIng);

  const hasMeasuredCalories = typeof nutrition.caloriesKcal100g === "number" && Number.isFinite(nutrition.caloriesKcal100g);
  const hasMeasuredSugars = typeof nutrition.sugarsG100g === "number" && Number.isFinite(nutrition.sugarsG100g);
  const hasMeasuredSatFat = typeof nutrition.saturatedFatG100g === "number" && Number.isFinite(nutrition.saturatedFatG100g);
  const hasMeasuredSodium = typeof nutrition.sodiumMg100g === "number" && Number.isFinite(nutrition.sodiumMg100g);

  const est = estimateNutritionFromProduct(nutrition.productTitle, rawIngredients);
  const kcal = hasMeasuredCalories ? nutrition.caloriesKcal100g! : (isWholeFood ? 75 : est.caloriesKcal100g);
  const sugars = hasMeasuredSugars ? nutrition.sugarsG100g! : (isWholeFood ? 2.0 : est.sugarsG100g);
  const satFat = hasMeasuredSatFat ? nutrition.saturatedFatG100g! : (isWholeFood ? 1.0 : est.saturatedFatG100g);
  const sodium = hasMeasuredSodium ? nutrition.sodiumMg100g! : (isWholeFood ? 45 : est.sodiumMg100g);
  const fiber = nutrition.fiberG100g ?? (isWholeFood ? 3.5 : est.fiberG100g);
  const protein = nutrition.proteinG100g ?? (isWholeFood ? 6.5 : est.proteinG100g);
  const fvn = nutrition.fruitsVegNutsPct ?? (isWholeFood ? 85 : est.fruitsVegNutsPct);

  // Nutri-Score Negative points (0..40) — uses official Beverage thresholds for drinks/juices
  const nCal = isBeverage
    ? stepPoints(kcal, [0, 7.2, 14.3, 21.5, 28.5, 35.9, 43.0, 50.2, 57.4, 64.5])
    : stepPoints(kcal, [80, 160, 240, 320, 400, 480, 560, 640, 720, 800]);
  const nSug = isBeverage
    ? stepPoints(sugars, [0, 1.5, 3.0, 4.5, 6.0, 7.5, 9.0, 10.5, 12.0, 13.5])
    : stepPoints(sugars, [4.5, 9, 13.5, 18, 22.5, 27, 31, 36, 40, 45]);
  const nSat = stepPoints(satFat, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const nSod = stepPoints(sodium, [90, 180, 270, 360, 450, 540, 630, 720, 810, 900]);
  const negativePoints = nCal + nSug + nSat + nSod;

  // Nutri-Score Positive points (0..15)
  const pFvn = fvn > 80 ? 5 : fvn > 60 ? 2 : fvn > 40 ? 1 : 0;
  const pFib = stepPoints(fiber, [0.9, 1.9, 2.8, 3.7, 4.7]);
  const pPro = stepPoints(protein, [1.6, 3.2, 4.8, 6.4, 8.0]);
  const positivePoints = negativePoints >= 11 && pFvn < 5 ? pFvn + pFib : pFvn + pFib + pPro;

  const nutriRaw = negativePoints - positivePoints;
  let nutriGrade: "A" | "B" | "C" | "D" | "E" = isBeverage
    ? nutriRaw <= 0 ? "A" : nutriRaw <= 2 ? "B" : nutriRaw <= 6 ? "C" : nutriRaw <= 9 ? "D" : "E"
    : nutriRaw <= -1 ? "A" : nutriRaw <= 2 ? "B" : nutriRaw <= 10 ? "C" : nutriRaw <= 18 ? "D" : "E";
  if (nutrition.nutriScoreGrade) {
    nutriGrade = nutrition.nutriScoreGrade.toUpperCase() as "A" | "B" | "C" | "D" | "E";
  }

  const isPureButterOrGhee =
    /\b(butter|kerrygold|ghee|land o'? ?lakes)\b/i.test(titleAndIng) &&
    !/\b(peanut|almond|cashew|sunflower|cookie|cocoa|apple|buttermilk|clam|chowder|soup|bisque)\b/i.test(titleAndIng);

  const isWholeMilk =
    /\b(milk|lactaid|fairlife)\b/i.test(titleAndIng) &&
    !/\b(yogurt|yoghurt|kefir|skyr|cheese|butter|cream|ice cream|skim|nonfat|fat[- ]?free|1%|2%|reduced[- ]?fat|coconut|almond|oat|soy|chocolate|condensed|evaporated|buttermilk|wafer|candy|clam|chowder|soup|bisque)\b/i.test(titleAndIng);

  let nutritionScore: number;
  if (isWholeFood) {
    nutritionScore = 60;
    nutriGrade = "A";
  } else if (is100PctFruitJuice) {
    // 100% Orange / Apple / Fruit Juice has ~9-10g liquid sugar per 100ml (~22g per cup) with 0g fiber -> Nutri-Score C (34/60)
    nutritionScore = 34;
    nutriGrade = "C";
  } else if (isBeverage && (sugars >= 5 || hasTop3AddedSugar)) {
    // Sweetened beverages (Capri Sun, Soda, Hi-C, Kool-Aid, Lemonade, Sweet Tea, Sports Drinks, Sugary Energy Drinks) -> Nutri-Score E (6/60)
    nutritionScore = sugars >= 7 ? 6 : 14;
    nutriGrade = sugars >= 7 ? "E" : "D";
  } else if (isBeverage && sugars <= 3.5 && kcal <= 25) {
    // Nutri-Score (2024 beverage algorithm): artificially sweetened zero-sugar drinks (Sucralose, Aspartame, Ace-K)
    // do not receive Nutri-Score A (60/60); they are capped at Nutri-Score C (36/60).
    // Clean unsweetened waters, seltzers, teas & prebiotic sodas (Fiji, Spindrift, LaCroix, Olipop, Nooma, Guayakí) get 60/60 (A).
    const hasArtificialSweetener = base.flagged.some((f) => f.category === "sweeteners");
    if (hasArtificialSweetener) {
      nutritionScore = 36;
      nutriGrade = "C";
    } else {
      nutritionScore = 60;
      nutriGrade = "A";
    }
  } else if (/\byogurt\b/i.test(titleAndIng) && hasTop3AddedSugar) {
    nutritionScore = 28;
    nutriGrade = "C";
  } else if (isPureButterOrGhee) {
    // Pure grass-fed/dairy butter has 0 chemical additives (30/30) and Tier 3 natural fat,
    // but high saturated fat (51g/100g) and calories (717 kcal/100g) -> Mediocre (~52-68/100), never 100/100.
    nutritionScore = sodium <= 50 ? 28 : 22;
    nutriGrade = sodium <= 50 ? "D" : "E";
  } else if (isWholeMilk) {
    // Whole milk has ~2.1g/100ml saturated fat (5g per cup) -> Nutri-Score B (50/60 nutrition points)
    nutritionScore = 50;
    nutriGrade = "B";
  } else if (nutriRaw <= -2) {
    nutritionScore = 60;
  } else if (nutriRaw <= -1) {
    nutritionScore = 55;
  } else if (nutriRaw <= 0) {
    nutritionScore = 50;
  } else if (nutriRaw <= 2) {
    nutritionScore = 45;
  } else if (nutriRaw <= 6) {
    nutritionScore = 42;
  } else if (nutriRaw <= 10) {
    nutritionScore = 28;
  } else if (nutriRaw <= 14) {
    nutritionScore = 18;
  } else if (nutriRaw <= 18) {
    nutritionScore = 12;
  } else if (nutriRaw <= 23) {
    nutritionScore = 6;
  } else {
    nutritionScore = 2;
  }

  // High-protein real meats/sausages (protein >= 14g/100g, e.g., Beef Smoked Sausage, Kielbasa, Bacon)
  // earn at least 10/60 in the Nutrition Pillar for high protein content rather than dropping to 2/60 or 0/100.
  const isHighProteinMeatOrSausage =
    protein >= 14 &&
    /\b(beef|pork|turkey|chicken|sausage|kielbasa|bratwurst|frankfurter|hot\s*dog|bacon|ham|salami|pepperoni|steak|meat)\b/i.test(titleAndIng) &&
    !/\b(ice\s+cream|cookie|candy|chocolate|cake|soda|juice)\b/i.test(titleAndIng);
  if (isHighProteinMeatOrSausage && nutritionScore < 10) {
    nutritionScore = 10;
    nutriGrade = "D";
  }

  const hasHighRisk = base.flagged.some((f) => f.risk === "high");
  const seedOilHits = base.flagged.filter((f) => f.category === "seedOils");
  const multiAdditiveDeduction = Math.max(0, base.flagged.length - 1) * 3;
  const additiveDeduction = Math.min(30, Math.round(base.totalPenalty * 0.45) + multiAdditiveDeduction);
  const additiveScore = hasHighRisk ? 0 : Math.max(0, 30 - additiveDeduction);
  // Yuka 10% Organic bonus (10/10) is awarded strictly to certified Organic items
  const organicScore = isOrganic ? 10 : 0;

  // Always compute finalScore from Yuka's 3 pillars (60% Nutrition + 30% Additives + 10% Organic)
  // so the 0-100 gauge score always equals the sum of the 3 pillars (capped by high-risk / seed-oil caps).
  // Never subtract additive penalties a second time out of the 60-point Nutrition Pillar.
  const yukaPillarScore = Math.max(0, nutritionScore + additiveScore + organicScore);
  let finalScore = yukaPillarScore;
  if (hasHighRisk || seedOilHits.length >= 2) {
    finalScore = Math.max(0, Math.min(HIGH_RISK_SCORE_CAP, finalScore));
  } else if (seedOilHits.length === 1) {
    // Tier 2 Seed Oil Cap (Sunflower / Safflower Oil): capped at <= 59/100 (Mediocre / Orange) — never Green
    finalScore = Math.max(0, Math.min(59, finalScore));
  }

  // Surface nutritional risk flags ONLY with measured numbers when measured nutrition was provided;
  // when nutrition is estimated from ingredient order/category, never fabricate specific g/mg/kcal numbers.
  const flagged: FlaggedAdditive[] = [...base.flagged];
  if (!isWholeFood && finalScore < 90) {
    if (is100PctFruitJuice) {
      flagged.push({
        id: "nutri_liquid_fruit_sugar",
        name: hasMeasuredSugars
          ? `Liquid Fruit Sugar (${Math.round(sugars * 10) / 10}g / 100ml)`
          : "Concentrated Liquid Fruit Sugar",
        risk: "low",
        category: "hfcs",
        penalty: 26,
        explanation: "Even 100% fruit juice removes whole-fruit fiber and delivers concentrated free liquid sugar, lowering its nutrition score.",
        matched: "juice",
      });
    } else if (isBeverage && sugars >= 5 && (hasMeasuredSugars || hasTop3AddedSugar)) {
      flagged.push({
        id: "nutri_beverage_sugar",
        name: hasMeasuredSugars
          ? `High Liquid Sugar (${Math.round(sugars * 10) / 10}g / 100ml)`
          : "Sweetened Beverage (Added Liquid Sugar)",
        risk: "moderate",
        category: "hfcs",
        penalty: 35,
        explanation: "Sugary beverages spike blood glucose rapidly with zero dietary fiber, receiving the lowest Nutri-Score beverage grade (E).",
        matched: "sugar",
      });
    } else if (hasMeasuredSugars && (sugars >= 18 || (hasTop3AddedSugar && sugars >= 12))) {
      flagged.push({
        id: "nutri_sugar",
        name: `High Sugar (${Math.round(sugars * 10) / 10}g / 100g)`,
        risk: sugars >= 25 ? "moderate" : "low",
        category: "hfcs",
        penalty: sugars >= 25 ? 20 : 12,
        explanation: "High measured sugar concentration (per 100g) lowers the 60% Nutritional Quality score.",
        matched: "sugar",
      });
    } else if (!hasMeasuredSugars && hasTop3AddedSugar) {
      flagged.push({
        id: "nutri_sugar",
        name: "Added Sugar in Top Ingredients",
        risk: "low",
        category: "hfcs",
        penalty: 12,
        explanation: "Sugar or syrup appears among the first three ingredients by weight, lowering the 60% Nutritional Quality score.",
        matched: "sugar",
      });
    }

    if (hasMeasuredSatFat && satFat >= 10) {
      flagged.push({
        id: "nutri_satfat",
        name: `High Saturated Fat (${Math.round(satFat * 10) / 10}g / 100g)`,
        risk: "moderate",
        category: "emulsifiers",
        penalty: 18,
        explanation: "Exceeds Nutri-Score's 10g/100g saturated fat threshold, reducing the 60% Nutritional Quality pillar.",
        matched: "saturated fat",
      });
    }

    if (hasMeasuredSodium && sodium >= 600) {
      flagged.push({
        id: "nutri_sodium",
        name: `High Sodium (${Math.round(sodium)}mg / 100g)`,
        risk: sodium >= 850 ? "moderate" : "low",
        category: "preservatives",
        penalty: sodium >= 850 ? 18 : 10,
        explanation: "High measured sodium content lowers the 60% Nutritional Quality score.",
        matched: "sodium",
      });
    } else if (sodium >= 280 && nutritionScore <= 42 && /\b(turkey|chicken|poultry|pork|ham|roast)\b/i.test(titleAndIng)) {
      flagged.push({
        id: "nutri_moderate_sodium",
        name: hasMeasuredSodium ? `Added Sodium Solution (${Math.round(sodium)}mg / 100g)` : "Added Sodium / Basting Solution",
        risk: "low",
        category: "preservatives",
        penalty: 10,
        explanation: "Contains added salt/basting solution that lowers the 60% Nutritional Quality score compared to plain unbasted meat.",
        matched: "salt",
      });
    }

    if (hasMeasuredCalories && kcal >= 500) {
      flagged.push({
        id: "nutri_calories",
        name: `High Calorie Density (${Math.round(kcal)} kcal / 100g)`,
        risk: "low",
        category: "flavors",
        penalty: 10,
        explanation: "Calorie-dense food (>500 kcal per 100g); best enjoyed in small portions.",
        matched: "calories",
      });
    }
  }

  // Compute Blood Sugar / Glucose Spike & Calorie Smart insight (for Diabetes, PCOS & metabolic clarity)
  const hasRapidGlycemicAdditive =
    base.flagged.some((f) => f.category === "hfcs") ||
    /\b(maltodextrin|dextrose|corn syrup|glucose syrup|cane sugar|brown sugar|invert sugar)\b/i.test(base.normalizedIngredients);
  const hasRefinedCarbBase =
    /\b(enriched\s+(?:wheat\s+)?flour|bleached\s+flour|corn\s*starch|tapioca\s+starch|potato\s+starch|cassava\s+flour|white\s+rice\s+flour)\b/i.test(base.normalizedIngredients);

  let glucoseImpact: "Low Spike" | "Moderate Spike" | "High Spike" = "Low Spike";
  let glucoseColor: RatingColor = "green";
  let glucoseNote =
    "Steady glycemic profile — low added sugar and minimal glucose spike risk (PCOS & blood-sugar friendly).";

  if (
    (isBeverage && sugars >= 5) ||
    is100PctFruitJuice ||
    sugars >= 15 ||
    (hasRapidGlycemicAdditive && sugars >= 8)
  ) {
    glucoseImpact = "High Spike";
    glucoseColor = "red";
    glucoseNote =
      "High glucose spike risk — concentrated sugars or fast-absorbing syrups can rapidly elevate blood glucose and insulin (watch for Type 2 Diabetes & PCOS).";
  } else if (sugars >= 6 || hasRapidGlycemicAdditive || (hasRefinedCarbBase && fiber < 4)) {
    glucoseImpact = "Moderate Spike";
    glucoseColor = "yellow";
    glucoseNote =
      "Moderate glucose impact — contains fast-digesting starches or sugars; pair with protein or healthy fats to steady blood sugar.";
  }

  const calorieSuffix = hasMeasuredCalories ? ` (${Math.round(kcal)} kcal/100g)` : "";
  const calorieNote =
    kcal <= 120
      ? `Calorie-Smart${calorieSuffix}`
      : kcal <= 360
        ? `Moderate Calories${calorieSuffix}`
        : `Calorie-Dense${calorieSuffix}`;

  return {
    ...base,
    flagged,
    score: finalScore,
    ...ratingFor(finalScore),
    yukaBreakdown: {
      nutritionScore,
      nutriScoreGrade: nutriGrade,
      additiveScore,
      organicScore,
      highRiskCapped: hasHighRisk,
      glucoseImpact,
      glucoseColor,
      glucoseNote,
      calorieNote,
    },
  };
}

export const NON_ENGLISH_INGREDIENTS =
  /\b(eau\b|sucre\b|huile\b|farine\b|lait\b|sirop\b|lécithine|acide\b|arômes?|colorants?|amidon|émulsifiants?|conservateurs?|noisettes|poudre\b|zutaten|wasser\b|zucker\b|pflanzliches|weizenmehl|speisesalz|säuerungsmittel|magermilchpulver|ingredientes|agua\b|azúcar|aceite\b|harina\b|leche\b|jarabe\b)/i;

export const ENGLISH_INGREDIENT_ANCHORS =
  /\b(water|sugar|salt|flour|milk|cream|butter|cheese|whey|casein|yogurt|eggs?|oil|fat|tallow|lard|corn|wheat|rice|oats?|barley|rye|quinoa|millet|sorghum|flax|chia|hemp|sesame|soy|soybeans?|peanuts?|almonds?|cashews?|walnuts?|pecans?|hazelnuts?|pistachios?|macadamia|coconut|cocoa|chocolate|vanilla|cinnamon|honey|molasses|syrup|dextrose|fructose|sucrose|maltose|lactose|maltodextrin|starch|pectin|gelatin|vinegar|yeast|baking|soda|acid|citric|lactic|malic|ascorbic|tocopherols?|lecithin|gum|carrageenan|cellulose|flavor\w*|color\w*|extract|spices?|garlic|onion|paprika|turmeric|annatto|celery|carrots?|tomato\w*|potato\w*|apples?|strawberr\w*|raspberr\w*|blueberr\w*|cranberr\w*|cherries|cherry|lemon|lime|orange|peach|mango|banana|pineapple|grape|dates?|raisins?|figs?|beans?|lentils?|chickpeas?|peas|spinach|broccoli|kale|peppers?|chili|jalapeno|mushrooms?|beef|pork|chicken|turkey|lamb|bison|duck|salmon|tuna|cod|fish|shrimp|broth|stock|cultures?|enzymes?|vitamins?|niacin|riboflavin|thiamin\w*|folic|iron|calcium|sodium|potassium|phosphate\w*|nitrite|nitrate|erythorbate|sorbate|benzoate|propionate|sulfite|bht|bha|tbhq|edta|datem|monoglycerides|diglycerides|polysorbate|sucralose|aspartame|acesulfame|stevia|erythritol|xylitol|sorbitol|red 40|yellow 5|yellow 6|blue 1|blue 2|titanium dioxide|caramel)\b/i;

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
