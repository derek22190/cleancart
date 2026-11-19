/**
 * HeyBroc — Persona-Specific Growth Angles & UGC Operator Playbooks
 * -----------------------------------------------------------------
 * Shared source of truth across:
 *   - `/test?angle=<id>` (Duolingo-style Free 3-Second Grocery Score Test)
 *   - `/r/[code]?angle=<id>` (Creator & referral landing pages)
 *   - `/creators` (UGC operator script kits & angle-tagged link builder)
 *   - `/admin` (Per-angle Paywall Reach Rate & Initial Conversion telemetry)
 *   - `components/Paywall.tsx` (Personalized paywall headline matching entry hook)
 */
import type { DietaryOptionId } from "./dietary";
import type { Category } from "./rubric";

export type GrowthAngleId = "red40" | "seedoils" | "allergies" | "online" | "budget";

export interface GrowthAngleSpec {
  id: GrowthAngleId;
  shortLabel: string;
  audienceTag: string;
  emoji: string;
  /** Eyebrow badge on `/test?angle=...` and `/r/[code]?angle=...` */
  eyebrow: string;
  /** Tailored hero H2 on `/test?angle=...` */
  testHeadline: string;
  /** Tailored hero subheadline on `/test?angle=...` */
  testSubheadline: string;
  /** Featured preset ID from `lib/presets.ts` hoisted first for instant shock-score demo */
  featuredPresetId: "snacks" | "ranch" | "bread" | "crackers" | "cereal";
  /** Pre-selected 2x Family Watchlist categories */
  familyWatchlist: Category[];
  /** Optional pre-selected dietary/allergen watch alerts */
  dietaryWatchlist?: DietaryOptionId[];
  /** Optional Store-Brand Value swap preference */
  preferStoreBrand?: boolean;
  /** Personalized Paywall headline when user arrives via this angle */
  paywallHeadline: string;
  /** Personalized Paywall subheadline */
  paywallSubheadline: string;
  /** Personalized Step 2 CTA button copy on `/test` */
  step2CtaLabel: string;
  /** UGC Creator Operator Kit (for `/creators`) */
  ugcKit: {
    targetAudience: string;
    hook0to3s: string;
    demoBeat3to12s: string;
    cta12to18s: string;
    whyItConverts: string;
  };
}

export const GROWTH_ANGLES: readonly GrowthAngleSpec[] = [
  {
    id: "red40",
    shortLabel: "Kids' Snacks & Red 40",
    audienceTag: "Parents avoiding synthetic food dyes",
    emoji: "🎨",
    eyebrow: "🎨 FREE 3-SECOND DYE & KIDS' SNACK CHECK",
    testHeadline: "Is Red 40 or Blue 1 Hiding in Your Kids' Lunchbox? Test 1 Snack Free.",
    testSubheadline:
      "HeyBroc applies 2x strictness to synthetic food dyes, HFCS, and preservatives — showing instant 0–100 scores and 1-tap dye-free swaps across 12 online stores.",
    featuredPresetId: "snacks",
    familyWatchlist: ["dyes", "hfcs", "preservatives"],
    paywallHeadline: "Keep synthetic dyes & hidden preservatives out of every grocery order",
    paywallSubheadline:
      "Your 2x Dye-Free Watchlist is ready. Unlock unlimited 1-tap cleaner snack swaps and Whole-Cart Audits across Walmart, Target, Instacart, Costco & 8 more stores.",
    step2CtaLabel: "Step 2: Unlock Unlimited Dye-Free Swaps Across All 12 Stores ($0 Today) →",
    ugcKit: {
      targetAudience: "Parents buying school snacks, fruit snacks, cereals & drinks",
      hook0to3s:
        "\"I thought these fruit snacks were made with real fruit until I ran my Walmart cart through this...\"",
      demoBeat3to12s:
        "Screen-record tapping Welch's Mixed Fruit Snacks (0/100 · Red 40, Blue 1, Corn Syrup) → 1-tap swap to That's It 100% Real Fruit Bars (90/100) right inside Walmart or Target online.",
      cta12to18s:
        "\"Test one snack from your pantry free at my link in bio — and use code {CODE} for 7 days of Family Pro free.\"",
      whyItConverts:
        "Parents don't care about generic 'clean eating' — they immediately test a snack their kids actually eat, triggering a polarizing comment section and high paywall intent.",
    },
  },
  {
    id: "seedoils",
    shortLabel: "Seed-Oil Free Cart",
    audienceTag: "Shoppers avoiding soybean, canola & corn oils",
    emoji: "🥑",
    eyebrow: "🥑 FREE 3-SECOND SEED-OIL CHECK",
    testHeadline: "Spot Hidden Soybean & Canola Oil Before You Checkout. Test 1 Item Free.",
    testSubheadline:
      "HeyBroc flags refined seed oils (soybean, canola, corn, cottonseed, sunflower, safflower) with 2x strictness and finds avocado-oil & olive-oil swaps in 1 tap.",
    featuredPresetId: "ranch",
    familyWatchlist: ["seedOils", "preservatives", "emulsifiers"],
    paywallHeadline: "Swap hidden seed oils for avocado-oil & olive-oil picks automatically",
    paywallSubheadline:
      "Your 2x Seed-Oil Free Watchlist is active. Unlock unlimited cleaner store links and weekly pickup order audits across all 12 grocery apps.",
    step2CtaLabel: "Step 2: Unlock Unlimited Seed-Oil-Free Swaps ($0 Today) →",
    ugcKit: {
      targetAudience: "Seed-oil-free shoppers, fitness & whole-food households",
      hook0to3s:
        "\"90% of salad dressings and crackers in your online cart are mostly soybean oil — watch how fast you can swap them...\"",
      demoBeat3to12s:
        "Show Hidden Valley Original Ranch (0/100 · Soybean/Canola Oil, EDTA, MSG) → 1-tap swap to Primal Kitchen Avocado Oil Ranch (80/100), then show a chip or cracker swap.",
      cta12to18s:
        "\"Check the dressing in your fridge free at my link — use code {CODE} to get 7 days of Family Pro free.\"",
      whyItConverts:
        "Condiments and chips have the sharpest visual score jump (0/100 → 80+/100) and instant aha-moment when shoppers realize they don't have to read tiny ingredient paragraphs online.",
    },
  },
  {
    id: "allergies",
    shortLabel: "Allergy & Gluten-Free",
    audienceTag: "Families checking dairy, gluten, soy, peanut & sesame labels",
    emoji: "🛡️",
    eyebrow: "🛡️ FREE 3-SECOND ALLERGEN & LABEL CHECK",
    testHeadline: "Catch Hidden Gluten, Dairy, Soy & Additives in 1 Tap. Test Any Food Free.",
    testSubheadline:
      "Combine deterministic 0–100 additive scoring with instant top-allergen label alerts while browsing Walmart, Target, Instacart, Kroger, Costco & Whole Foods.",
    featuredPresetId: "bread",
    familyWatchlist: ["emulsifiers", "preservatives", "seedOils"],
    dietaryWatchlist: ["wheat_gluten", "dairy", "soy", "peanuts_nuts"],
    paywallHeadline: "Shop online with automatic allergen alerts & 0–100 ingredient grades",
    paywallSubheadline:
      "Keep your family's allergen & additive alerts active across every aisle, plus unlimited 1-tap cleaner alternatives across all 12 stores.",
    step2CtaLabel: "Step 2: Keep Allergen Alerts & Unlimited Clean Swaps Active ($0 Today) →",
    ugcKit: {
      targetAudience: "Gluten-free, dairy-free, soy-free & food-allergy families",
      hook0to3s:
        "\"Reading every single online ingredient label for dairy, soy, and wheat takes forever — here's how I cut grocery shopping in half...\"",
      demoBeat3to12s:
        "Open Allergen & Dietary Watchlist toggles, scan a bread or snack item showing instant red allergen badges + flagged dough conditioners, then tap into a cleaner alternative.",
      cta12to18s:
        "\"Try a free label check with your family's allergens at my link and use code {CODE} for 7 days of Family Pro.\"",
      whyItConverts:
        "Allergy households have the highest recurring retention and willingness to pay because label-checking friction happens on every single weekly grocery order.",
    },
  },
  {
    id: "online",
    shortLabel: "Online Grocery (Yuka Alternative)",
    audienceTag: "Walmart, Instacart, Target, Costco & Amazon Fresh shoppers",
    emoji: "🛒",
    eyebrow: "🛒 LIVE SCORES FOR ONLINE GROCERY CARTS",
    testHeadline: "Can't Scan Barcodes When You Order Groceries Online? Test Any Product Free.",
    testSubheadline:
      "HeyBroc works where barcode-only apps can't — putting live 0–100 ingredient badges directly on Walmart, Instacart, Target, Costco, Kroger, ALDI & Amazon Fresh.",
    featuredPresetId: "crackers",
    familyWatchlist: ["seedOils", "dyes", "preservatives"],
    paywallHeadline: "Live 0–100 badges & 1-tap Clean Swaps across all 12 online grocery stores",
    paywallSubheadline:
      "Stop switching tabs to check ingredients. Unlock unlimited 1-tap cleaner store links and Whole-Cart Health Audits on iPhone, Android, Chrome & Safari.",
    step2CtaLabel: "Step 2: Unlock Live 12-Store Cart Swaps ($0 Today) →",
    ugcKit: {
      targetAudience: "Busy parents & professionals using Walmart+, Instacart, Target Drive Up, Costco",
      hook0to3s:
        "\"You can't scan barcodes with Yuka when you're doing Walmart pickup or Instacart — this puts live 0–100 scores right on the store page...\"",
      demoBeat3to12s:
        "Screen-record HeyBroc Live Shop or the Safari/Chrome extension displaying red/green 0–100 badges on search tiles, tapping a 0/100 cracker box (TBHQ + Soybean Oil) and swapping in 1 tap.",
      cta12to18s:
        "\"Test one item from your last pickup order free at my link — code {CODE} unlocks 7 days of Family Pro free.\"",
      whyItConverts:
        "Directly taps existing awareness of barcode food scanners while solving their #1 frustration: online grocery delivery and curbside pickup.",
    },
  },
  {
    id: "budget",
    shortLabel: "Clean Swaps on a Budget",
    audienceTag: "Shoppers wanting affordable store-brand clean swaps",
    emoji: "💚",
    eyebrow: "💚 STORE-BRAND CLEAN SWAPS · NO EREWHON BUDGET",
    testHeadline: "Eating Clean Shouldn't Double Your Grocery Bill. Test Any Pantry Staple Free.",
    testSubheadline:
      "Turn on Store-Brand Priority to find clean Walmart, ALDI, Target, Kroger & Costco swaps without synthetic dyes, BHT, or refined seed oils.",
    featuredPresetId: "cereal",
    familyWatchlist: ["seedOils", "dyes", "hfcs"],
    preferStoreBrand: true,
    paywallHeadline: "Find cleaner everyday & store-brand swaps in 1 tap on every order",
    paywallSubheadline:
      "Store-Brand Priority is enabled. Unlock unlimited 1-tap Clean Swaps and Weekly Pickup Order Audits across Walmart, ALDI, Kroger, Target, Costco & 7 more stores.",
    step2CtaLabel: "Step 2: Unlock Unlimited Budget-Friendly Clean Swaps ($0 Today) →",
    ugcKit: {
      targetAudience: "ALDI, Walmart, Sam's Club & Costco budget-conscious family shoppers",
      hook0to3s:
        "\"Everyone thinks clean groceries have to come from a $14 specialty store — watch this budget swap trick at Walmart & ALDI...\"",
      demoBeat3to12s:
        "Toggle Store-Brand Priority on, score a mainstream cereal or cracker (0–49 Poor · BHT / seed oils), and tap the cleaner everyday store swap in 1 tap.",
      cta12to18s:
        "\"Run one item from your weekly list free at my link and use code {CODE} for 7 days of Family Pro.\"",
      whyItConverts:
        "Removes the #1 objection in food-scanner comment sections ('clean food is too expensive') by proving everyday stores carry high-scoring alternatives.",
    },
  },
] as const;

const ANGLE_MAP: Record<string, GrowthAngleSpec> = Object.fromEntries(
  GROWTH_ANGLES.map((a) => [a.id, a]),
);

/** Resolve a URL `?angle=` parameter to a known GrowthAngleSpec (case-insensitive, safe fallback). */
export function resolveGrowthAngle(raw?: string | null): GrowthAngleSpec | null {
  if (!raw) return null;
  const clean = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!clean) return null;
  if (ANGLE_MAP[clean]) return ANGLE_MAP[clean];
  // Friendly aliases for ad URLs & creator links
  if (clean === "dyes" || clean === "kids" || clean === "red-40" || clean === "red_40") {
    return ANGLE_MAP.red40;
  }
  if (clean === "seed-oils" || clean === "seed_oils" || clean === "seedoil") {
    return ANGLE_MAP.seedoils;
  }
  if (clean === "allergy" || clean === "gluten" || clean === "gluten-free" || clean === "dairy-free") {
    return ANGLE_MAP.allergies;
  }
  if (clean === "yuka" || clean === "walmart" || clean === "instacart" || clean === "cart") {
    return ANGLE_MAP.online;
  }
  if (clean === "aldi" || clean === "value" || clean === "store-brand" || clean === "cheap") {
    return ANGLE_MAP.budget;
  }
  return null;
}

export function isValidGrowthAngleId(raw?: string | null): raw is GrowthAngleId {
  return Boolean(raw && raw in ANGLE_MAP);
}
