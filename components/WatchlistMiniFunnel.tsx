"use client";

import { useEffect, useRef, useState } from "react";
import type { DietaryOptionId } from "@/lib/dietary";
import { PRICING, annualPerMonth } from "@/lib/pricing";
import type { Category } from "@/lib/rubric";
import { STORE_META, type Store } from "@/lib/swaps";

export type { DietaryOptionId };
export type HouseholdProfileId = "kids_family" | "partner" | "myself" | "sensitivity";
export type PrimaryGoalId = "seed_oil_free" | "kids_dye_free" | "whole_foods" | "clean_swaps";
export type FunnelStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface OnboardingSelections {
  watchlist: Category[];
  dietaryWatchlist?: DietaryOptionId[];
  store?: Store;
  householdProfile?: HouseholdProfileId;
  primaryGoal?: PrimaryGoalId;
}

export interface WatchlistMiniFunnelProps {
  open: boolean;
  initialSelected: Category[];
  initialStore?: Store;
  initialDietary?: DietaryOptionId[];
  initialStep?: FunnelStep;
  isReturningUser?: boolean;
  appliedCreator?: { code: string; name: string } | null;
  onApplyAndGuest: (selected: Category[], extras?: OnboardingSelections) => void;
  onApplyAndSignIn: (selected: Category[], extras?: OnboardingSelections) => void;
  onApplyAndStartTrial?: (selected: Category[], extras?: OnboardingSelections) => void;
  onDismissFirstTime?: (selected: Category[], extras: OnboardingSelections) => void;
  onClose: () => void;
}

const HOUSEHOLD_OPTIONS: Array<{
  id: HouseholdProfileId;
  icon: string;
  title: string;
  subtitle: string;
  badge: string;
  recommendedCats: Category[];
}> = [
  {
    id: "kids_family",
    icon: "👨‍👩‍👧‍👦",
    title: "My Kids & Family",
    subtitle: "Keep Red 40, seed oils & hidden syrups out of family meals and lunchboxes",
    badge: "Most Popular",
    recommendedCats: ["seedOils", "dyes", "hfcs", "nitrates"],
  },
  {
    id: "partner",
    icon: "💑",
    title: "Me & My Partner",
    subtitle: "Upgrade our shared grocery cart to clean, whole-ingredient staples",
    badge: "Household",
    recommendedCats: ["seedOils", "hfcs", "preservatives"],
  },
  {
    id: "myself",
    icon: "🏃",
    title: "Just Myself",
    subtitle: "Hit my personal clean-eating, fitness & ingredient quality goals",
    badge: "Personal",
    recommendedCats: ["seedOils", "hfcs", "sweeteners"],
  },
  {
    id: "sensitivity",
    icon: "🛡️",
    title: "Managing Food Sensitivities",
    subtitle: "Strict ingredient, additive & allergen screening on every food label",
    badge: "Strict Guard",
    recommendedCats: ["seedOils", "dyes", "hfcs", "preservatives", "sweeteners"],
  },
];

const PRIMARY_GOAL_OPTIONS: Array<{
  id: PrimaryGoalId;
  icon: string;
  title: string;
  subtitle: string;
  boostCats: Category[];
}> = [
  {
    id: "seed_oil_free",
    icon: "🌻",
    title: "Eliminate Industrial Seed Oils",
    subtitle: "Swap soybean, canola & corn oil for 100% avocado, olive & grass-fed butter",
    boostCats: ["seedOils"],
  },
  {
    id: "kids_dye_free",
    icon: "🧪",
    title: "Protect Against Red 40 & Dyes",
    subtitle: "Spot petroleum-derived synthetic dyes disguised in snacks, cereals & drinks",
    boostCats: ["dyes"],
  },
  {
    id: "whole_foods",
    icon: "🥑",
    title: "Cut Ultra-Processed Additives & HFCS",
    subtitle: "Ditch high-fructose corn syrup, curing nitrates & harsh BHA/BHT preservatives",
    boostCats: ["hfcs", "nitrates", "preservatives"],
  },
  {
    id: "clean_swaps",
    icon: "⇄",
    title: "Save Time with 1-Tap Clean Swaps",
    subtitle: "Stop reading 40-ingredient labels — get instant 90–100/100 store replacements",
    boostCats: ["seedOils", "dyes", "hfcs"],
  },
];

const STORE_CHOICES: Array<{
  id: Store;
  icon: string;
  label: string;
  sub: string;
}> = [
  { id: "walmart", icon: "🏬", label: "Walmart", sub: "Pickup, Delivery & In-Store" },
  { id: "target", icon: "🎯", label: "Target", sub: "Drive Up & Same-Day" },
  { id: "costco", icon: "🏷️", label: "Costco", sub: "Warehouse & Bulk Picks" },
  { id: "sams", icon: "💎", label: "Sam's Club", sub: "Club Pickup & Scan & Go" },
  { id: "aldi", icon: "🏪", label: "ALDI", sub: "Simply Nature & Aisle Swaps" },
  { id: "kroger", icon: "🛒", label: "Kroger", sub: "Simple Truth & Pickup" },
  { id: "instacart", icon: "🥕", label: "Instacart", sub: "All Local Supermarkets" },
  { id: "amazon", icon: "📦", label: "Amazon / Whole Foods", sub: "365 & Prime Delivery" },
];

const WATCHLIST_PILLS: Array<{
  id: Category;
  icon: string;
  title: string;
  subtitle: string;
  badge: string;
  problemNote: string;
}> = [
  {
    id: "seedOils",
    icon: "🌻",
    title: "Industrial Seed Oils",
    subtitle: "Soybean, canola, corn, cottonseed & sunflower oil",
    badge: "Most Popular",
    problemNote: "Hidden in 70%+ of 'Natural' dressings, chips, crackers & oat milks",
  },
  {
    id: "dyes",
    icon: "🧪",
    title: "Red 40 & Artificial Dyes",
    subtitle: "Red 40, Yellow 5 & 6, Blue 1, Titanium Dioxide",
    badge: "Kids' Watchlist",
    problemNote: "Disguised inside yogurts, fruit snacks, cereals & sports drinks",
  },
  {
    id: "hfcs",
    icon: "🌽",
    title: "High-Fructose Corn Syrup",
    subtitle: "HFCS, corn syrup solids & hidden refined syrups",
    badge: "Added Syrups",
    problemNote: "Slipped into breads, ketchup, barbecue sauces & family staples",
  },
  {
    id: "nitrates",
    icon: "🥓",
    title: "Nitrites & Curing Nitrates",
    subtitle: "Sodium nitrite/nitrate in bacon, deli meat & hot dogs",
    badge: "Deli & Meat",
    problemNote: "Found in conventional lunch meats, sausage & cured deli turkey",
  },
  {
    id: "sweeteners",
    icon: "🥤",
    title: "Artificial Sweeteners",
    subtitle: "Sucralose, aspartame, acesulfame potassium & saccharin",
    badge: "Zero Artificial",
    problemNote: "Used in 'Zero Sugar' sodas, protein shakes & light yogurts",
  },
  {
    id: "preservatives",
    icon: "🛡️",
    title: "BHA, BHT & Harsh Preservatives",
    subtitle: "TBHQ, BHA/BHT, potassium bromate & propylparaben",
    badge: "Synthetic",
    problemNote: "Added to extend shelf life in cereals, tortillas & frozen meals",
  },
];

const DIETARY_PILLS: Array<{
  id: DietaryOptionId;
  icon: string;
  title: string;
  subtitle: string;
}> = [
  {
    id: "sugar_diabetes",
    icon: "🩸",
    title: "Added Sugar & Syrup Watch",
    subtitle: "Flags added cane sugar, corn syrups, >=10g sugar/100g & refined starches",
  },
  {
    id: "dairy",
    icon: "🥛",
    title: "Dairy & Lactose Guard",
    subtitle: "Flags milk, cream, butter, whey, casein, lactose, cheese & yogurt",
  },
  {
    id: "wheat_gluten",
    icon: "🌾",
    title: "Wheat & Gluten Guard",
    subtitle: "Flags wheat, enriched flour, barley, malt, rye, spelt & semolina",
  },
  {
    id: "peanuts_nuts",
    icon: "🥜",
    title: "Peanut & Tree Nut Guard",
    subtitle: "Flags peanuts, almonds, cashews, walnuts, pecans, hazelnuts & pistachios",
  },
  {
    id: "soy",
    icon: "🫘",
    title: "Soy Guard",
    subtitle: "Flags soy protein, soy lecithin, soybean oil, tofu & edamame",
  },
  {
    id: "egg",
    icon: "🥚",
    title: "Egg Guard",
    subtitle: "Flags whole egg, egg whites/yolks, albumin & mayonnaise",
  },
  {
    id: "shellfish_fish",
    icon: "🐟",
    title: "Shellfish & Fish Guard",
    subtitle: "Flags shrimp, crab, lobster, salmon, tuna, cod, anchovy & fish sauce",
  },
  {
    id: "high_sodium",
    icon: "🧂",
    title: "High Sodium Watch",
    subtitle: "Flags >=400mg sodium/100g, MSG, sodium nitrite/benzoate & brines",
  },
];

const MINI_TEST_SAMPLES: Array<{
  id: string;
  icon: string;
  shortLabel: string;
  dirtyTitle: string;
  dirtyScore: number;
  dirtyFlags: string;
  cleanTitle: string;
  cleanScore: number;
  cleanPerks: string;
}> = [
  {
    id: "yogurt",
    icon: "🍓",
    shortLabel: "Kids' Yogurt",
    dirtyTitle: "Berry Swirl Lowfat Yogurt",
    dirtyScore: 22,
    dirtyFlags: "Flagged (2x): Red 40, High-Fructose Corn Syrup & Potassium Sorbate",
    cleanTitle: "Organic Whole Milk Berry Yogurt",
    cleanScore: 94,
    cleanPerks: "Organic milk & real strawberries — 0 synthetic dyes, 0 corn syrup",
  },
  {
    id: "ranch",
    icon: "🥗",
    shortLabel: "Creamy Ranch",
    dirtyTitle: '"Homestyle" Creamy Ranch Dressing',
    dirtyScore: 18,
    dirtyFlags: "Flagged (2x): Soybean Oil (#1 ingredient), MSG, Calcium Disodium EDTA & Polysorbate 60",
    cleanTitle: "100% Avocado Oil Ranch Dressing",
    cleanScore: 92,
    cleanPerks: "Made with 100% pure avocado oil & organic herbs — 0 seed oils, 0 EDTA",
  },
  {
    id: "crackers",
    icon: "🧀",
    shortLabel: "Cheddar Crackers",
    dirtyTitle: "Baked Cheddar Snack Crackers",
    dirtyScore: 24,
    dirtyFlags: "Flagged (2x): Soybean & Canola Oil, TBHQ Preservative & Yellow 6",
    cleanTitle: "Organic Grass-Fed Cheddar Crackers",
    cleanScore: 95,
    cleanPerks: "Organic wheat & grass-fed cheddar — 0 seed oils, 0 TBHQ, 0 artificial dyes",
  },
];

const STEP_TITLES: Record<FunnelStep, string> = {
  1: "Household",
  2: "#1 Priority",
  3: "Your Store",
  4: "Your Goals",
  5: "Allergy Guard",
  6: "The Problem",
  7: "How Broc Works",
  8: "Your Plan",
};

function trackOnboardingEvent(event: string, properties: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  const deviceId = window.localStorage.getItem("heybroc_device_id") || "anon-web";
  void fetch("/api/analytics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "track",
      event,
      deviceId,
      platform: "web",
      properties,
    }),
  }).catch(() => {});
}

export default function WatchlistMiniFunnel({
  open,
  initialSelected,
  initialStore = "walmart",
  initialDietary = [],
  initialStep = 1,
  isReturningUser = false,
  appliedCreator,
  onApplyAndGuest,
  onApplyAndSignIn,
  onApplyAndStartTrial,
  onDismissFirstTime,
  onClose,
}: WatchlistMiniFunnelProps) {
  const [selected, setSelected] = useState<Category[]>(initialSelected);
  const [dietarySelected, setDietarySelected] = useState<DietaryOptionId[]>(initialDietary);
  const [selectedStore, setSelectedStore] = useState<Store>(initialStore);
  const [household, setHousehold] = useState<HouseholdProfileId>("kids_family");
  const [primaryGoal, setPrimaryGoal] = useState<PrimaryGoalId>("seed_oil_free");
  const [sampleIdx, setSampleIdx] = useState<number>(0);
  const [step, setStep] = useState<FunnelStep>(initialStep);
  const wasOpenRef = useRef<boolean>(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      prevFocusRef.current =
        typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
      setSelected(initialSelected);
      setDietarySelected(initialDietary);
      setSelectedStore(initialStore);
      if (typeof window !== "undefined") {
        const savedHousehold = window.localStorage.getItem("heybroc_household_profile") as HouseholdProfileId | null;
        if (savedHousehold && HOUSEHOLD_OPTIONS.some((h) => h.id === savedHousehold)) {
          setHousehold(savedHousehold);
        } else {
          setHousehold("kids_family");
        }
        const savedPrimaryGoal = window.localStorage.getItem("heybroc_primary_goal") as PrimaryGoalId | null;
        if (savedPrimaryGoal && PRIMARY_GOAL_OPTIONS.some((g) => g.id === savedPrimaryGoal)) {
          setPrimaryGoal(savedPrimaryGoal);
        } else {
          setPrimaryGoal("seed_oil_free");
        }
      }
      setSampleIdx(0);
      setStep(initialStep);
      requestAnimationFrame(() => {
        cardRef.current?.focus({ preventScroll: true });
      });
    } else if (!open && wasOpenRef.current) {
      prevFocusRef.current?.focus?.({ preventScroll: true });
      prevFocusRef.current = null;
    }
    wasOpenRef.current = open;
  }, [open, initialSelected, initialDietary, initialStore, initialStep]);

  useEffect(() => {
    if (open) {
      cardRef.current?.scrollTo({ top: 0 });
      trackOnboardingEvent("onboarding_step_viewed", {
        step,
        stepTitle: STEP_TITLES[step],
        isReturningUser,
      });
    }
  }, [open, step, isReturningUser]);

  const buildExtras = (): OnboardingSelections => ({
    watchlist: selected,
    dietaryWatchlist: dietarySelected,
    store: selectedStore,
    householdProfile: household,
    primaryGoal,
  });

  const handleBackdropOrEscapeDismiss = () => {
    trackOnboardingEvent("onboarding_dismissed", { step, isReturningUser });
    if (!isReturningUser && onDismissFirstTime) {
      onDismissFirstTime(selected, buildExtras());
      return;
    }
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleBackdropOrEscapeDismiss();
        return;
      }
      if (e.key === "Tab" && cardRef.current) {
        const focusable = Array.from(
          cardRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first || document.activeElement === cardRef.current) {
            e.preventDefault();
            last.focus();
          }
        } else if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!open) return null;

  const isFriendInvite = Boolean(
    appliedCreator?.code && appliedCreator.code.toUpperCase().startsWith("BROC-")
  );
  const effectiveTrialDays =
    appliedCreator && !isFriendInvite ? PRICING.creatorTrialDays : PRICING.trialDays;

  const toggle = (cat: Category) => {
    setSelected((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  };

  const toggleDietary = (id: DietaryOptionId) => {
    setDietarySelected((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]
    );
  };

  const activeGoalItems = WATCHLIST_PILLS.filter((p) => selected.includes(p.id));
  const displayGoalItems =
    activeGoalItems.length > 0 ? activeGoalItems : WATCHLIST_PILLS.slice(0, 3);
  const activeHouseholdObj =
    HOUSEHOLD_OPTIONS.find((h) => h.id === household) || HOUSEHOLD_OPTIONS[0];
  const activePrimaryGoalObj =
    PRIMARY_GOAL_OPTIONS.find((g) => g.id === primaryGoal) || PRIMARY_GOAL_OPTIONS[0];
  const storeDisplayName =
    STORE_CHOICES.find((s) => s.id === selectedStore)?.label ||
    STORE_META[selectedStore]?.label ||
    "Walmart";
  const activeSample = MINI_TEST_SAMPLES[sampleIdx] || MINI_TEST_SAMPLES[0];

  return (
    <div
      className="modal-backdrop gococo-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="heybroc-onboarding-heading"
      onClick={handleBackdropOrEscapeDismiss}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(15, 22, 18, 0.66)",
        backdropFilter: "blur(7px)",
        WebkitBackdropFilter: "blur(7px)",
      }}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        className="modal-card gococo-sheet"
        style={{
          width: "100%",
          maxWidth: 488,
          maxHeight: "calc(100vh - 32px)",
          overflowY: "auto",
          background: "#ffffff",
          borderRadius: 26,
          padding: "22px 20px 20px",
          boxShadow: "0 24px 48px rgba(0, 0, 0, 0.30)",
          outline: "none",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header: Back Button / Step Pill + Skip / Close Button */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 6,
            marginBottom: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
            {step > 1 && (
              <button
                type="button"
                onClick={() => setStep((s) => (s > 1 ? ((s - 1) as FunnelStep) : 1))}
                style={{
                  background: "#f3f4f6",
                  border: "none",
                  borderRadius: 999,
                  padding: "5px 10px",
                  fontSize: 12,
                  fontWeight: 700,
                  color: "#374151",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                ← Back
              </button>
            )}
            <span
              style={{
                display: "inline-block",
                background: "#e6f5ec",
                color: "#0b5e39",
                fontSize: 10.5,
                fontWeight: 800,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                padding: "5px 10px",
                borderRadius: 999,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              🥦 Step {step} of 8 · {STEP_TITLES[step]}
            </span>
          </div>

          {isReturningUser ? (
            <button
              type="button"
              onClick={() => {
                trackOnboardingEvent("onboarding_dismissed", { step, isReturningUser: true });
                onClose();
              }}
              aria-label="Close watchlist calibration without saving"
              style={{
                background: "#f3f4f6",
                border: "none",
                borderRadius: 999,
                padding: "5px 11px",
                fontSize: 12,
                fontWeight: 700,
                color: "#4b5563",
                cursor: "pointer",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              ✕ Close
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                const extras = buildExtras();
                trackOnboardingEvent("onboarding_completed", {
                  exitAction: "skip",
                  step,
                  householdProfile: extras.householdProfile,
                  primaryGoal: extras.primaryGoal,
                  store: extras.store,
                  watchlistCount: selected.length,
                  dietaryCount: dietarySelected.length,
                });
                onApplyAndGuest(selected, extras);
              }}
              aria-label="Skip and continue with Free Plan"
              style={{
                background: "#f3f4f6",
                border: "none",
                borderRadius: 999,
                padding: "5px 11px",
                fontSize: 12,
                fontWeight: 700,
                color: "#4b5563",
                cursor: "pointer",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              Skip →
            </button>
          )}
        </div>

        {/* 8-Segment Progress Bar */}
        <div
          role="progressbar"
          aria-valuenow={step}
          aria-valuemin={1}
          aria-valuemax={8}
          aria-label={`Onboarding step ${step} of 8: ${STEP_TITLES[step]}`}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(8, 1fr)",
            gap: 5,
            marginBottom: 16,
          }}
        >
          {([1, 2, 3, 4, 5, 6, 7, 8] as FunnelStep[]).map((idx) =>
            isReturningUser ? (
              <button
                key={idx}
                type="button"
                aria-label={`Jump to Step ${idx}: ${STEP_TITLES[idx]}`}
                onClick={() => setStep(idx)}
                style={{
                  height: 6,
                  padding: 0,
                  border: "none",
                  borderRadius: 999,
                  background: idx <= step ? "#16a34a" : "#e5e7eb",
                  cursor: "pointer",
                  transition: "background 0.2s ease",
                }}
              />
            ) : (
              <div
                key={idx}
                style={{
                  height: 5,
                  borderRadius: 999,
                  background: idx <= step ? "#16a34a" : "#e5e7eb",
                  transition: "background 0.2s ease",
                }}
              />
            )
          )}
        </div>

        {/* ==================== STEP 1: HOUSEHOLD PROFILE ==================== */}
        {step === 1 && (
          <>
            <h2
              id="heybroc-onboarding-heading"
              style={{
                fontSize: 22.5,
                fontWeight: 800,
                color: "#111814",
                margin: "0 0 6px",
                lineHeight: 1.2,
              }}
            >
              Who are you protecting with HeyBroc?
            </h2>
            <p
              style={{
                fontSize: 13.5,
                color: "#4b5563",
                margin: "0 0 14px",
                lineHeight: 1.45,
              }}
            >
              We&apos;ll calibrate your <b>0–100 food grading strictness</b> and{" "}
              <b>1-tap Clean Swaps</b> for your household in 60 seconds:
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {HOUSEHOLD_OPTIONS.map((opt) => {
                const active = household === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setHousehold(opt.id);
                      setSelected([...opt.recommendedCats]);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      width: "100%",
                      textAlign: "left",
                      padding: "12px 14px",
                      borderRadius: 16,
                      border: active ? "2px solid #16a34a" : "1.5px solid #e5e7eb",
                      background: active ? "#f0fdf4" : "#ffffff",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <span
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 12,
                        background: active ? "#dcfce7" : "#f3f4f6",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 21,
                        flexShrink: 0,
                      }}
                    >
                      {opt.icon}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <span style={{ fontSize: 14.5, fontWeight: 800, color: "#111814" }}>
                          {opt.title}
                        </span>
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            padding: "2px 7px",
                            borderRadius: 999,
                            background: active ? "#16a34a" : "#e5e7eb",
                            color: active ? "#ffffff" : "#4b5563",
                          }}
                        >
                          {opt.badge}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2, lineHeight: 1.35 }}>
                        {opt.subtitle}
                      </div>
                    </div>
                    <span
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 999,
                        background: active ? "#16a34a" : "#ffffff",
                        border: active ? "2px solid #16a34a" : "2px solid #d1d5db",
                        color: "#ffffff",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 13,
                        fontWeight: 800,
                        flexShrink: 0,
                      }}
                    >
                      {active ? "✓" : ""}
                    </span>
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                onClick={() => {
                  if (!isReturningUser && selected.length === 0) {
                    setSelected([...activeHouseholdObj.recommendedCats]);
                  }
                  setStep(2);
                }}
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  borderRadius: 999,
                  border: "none",
                  background: "#16a34a",
                  color: "#ffffff",
                  fontSize: 15,
                  fontWeight: 800,
                  cursor: "pointer",
                  boxShadow: "0 6px 18px rgba(22, 163, 74, 0.25)",
                }}
              >
                Continue →
              </button>
            </div>
          </>
        )}

        {/* ==================== STEP 2: #1 CLEAN-EATING PRIORITY ==================== */}
        {step === 2 && (
          <>
            <h2
              id="heybroc-onboarding-heading"
              style={{
                fontSize: 22.5,
                fontWeight: 800,
                color: "#111814",
                margin: "0 0 6px",
                lineHeight: 1.2,
              }}
            >
              What is your #1 clean-eating priority?
            </h2>
            <p
              style={{
                fontSize: 13.5,
                color: "#4b5563",
                margin: "0 0 14px",
                lineHeight: 1.45,
              }}
            >
              Pick what matters most right now — we&apos;ll prioritize Clean Swaps that match this first:
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {PRIMARY_GOAL_OPTIONS.map((opt) => {
                const active = primaryGoal === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setPrimaryGoal(opt.id);
                      setSelected((prev) =>
                        Array.from(new Set([...prev, ...opt.boostCats]))
                      );
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      width: "100%",
                      textAlign: "left",
                      padding: "12px 14px",
                      borderRadius: 16,
                      border: active ? "2px solid #16a34a" : "1.5px solid #e5e7eb",
                      background: active ? "#f0fdf4" : "#ffffff",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <span
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 12,
                        background: active ? "#dcfce7" : "#f3f4f6",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 21,
                        flexShrink: 0,
                      }}
                    >
                      {opt.icon}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14.5, fontWeight: 800, color: "#111814" }}>
                        {opt.title}
                      </div>
                      <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2, lineHeight: 1.35 }}>
                        {opt.subtitle}
                      </div>
                    </div>
                    <span
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 999,
                        background: active ? "#16a34a" : "#ffffff",
                        border: active ? "2px solid #16a34a" : "2px solid #d1d5db",
                        color: "#ffffff",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 13,
                        fontWeight: 800,
                        flexShrink: 0,
                      }}
                    >
                      {active ? "✓" : ""}
                    </span>
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                onClick={() => {
                  if (!isReturningUser && selected.length === 0) {
                    setSelected([...activePrimaryGoalObj.boostCats]);
                  }
                  setStep(3);
                }}
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  borderRadius: 999,
                  border: "none",
                  background: "#16a34a",
                  color: "#ffffff",
                  fontSize: 15,
                  fontWeight: 800,
                  cursor: "pointer",
                  boxShadow: "0 6px 18px rgba(22, 163, 74, 0.25)",
                }}
              >
                Continue →
              </button>
            </div>
          </>
        )}

        {/* ==================== STEP 3: FAVORITE GROCERY STORE ==================== */}
        {step === 3 && (
          <>
            <h2
              id="heybroc-onboarding-heading"
              style={{
                fontSize: 22.5,
                fontWeight: 800,
                color: "#111814",
                margin: "0 0 6px",
                lineHeight: 1.2,
              }}
            >
              Where do you usually grocery shop?
            </h2>
            <p
              style={{
                fontSize: 13.5,
                color: "#4b5563",
                margin: "0 0 14px",
                lineHeight: 1.45,
              }}
            >
              HeyBroc supports <b>all 12+ grocery &amp; delivery stores</b>. Pick your main store so 1-tap Clean Swaps open directly in your store:
            </p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
              }}
            >
              {STORE_CHOICES.map((st) => {
                const active = selectedStore === st.id;
                return (
                  <button
                    key={st.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setSelectedStore(st.id);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      textAlign: "left",
                      padding: "11px 12px",
                      borderRadius: 15,
                      border: active ? "2px solid #16a34a" : "1.5px solid #e5e7eb",
                      background: active ? "#f0fdf4" : "#ffffff",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <span style={{ fontSize: 21, flexShrink: 0 }}>{st.icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13.5,
                          fontWeight: 800,
                          color: "#111814",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {st.label}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "#6b7280",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {st.sub}
                      </div>
                    </div>
                    {active && (
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 800,
                          color: "#16a34a",
                          flexShrink: 0,
                        }}
                      >
                        ✓
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                onClick={() => setStep(4)}
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  borderRadius: 999,
                  border: "none",
                  background: "#16a34a",
                  color: "#ffffff",
                  fontSize: 15,
                  fontWeight: 800,
                  cursor: "pointer",
                  boxShadow: "0 6px 18px rgba(22, 163, 74, 0.25)",
                }}
              >
                Continue with {storeDisplayName} →
              </button>
            </div>
          </>
        )}

        {/* ==================== STEP 4: 2X INGREDIENT WATCHLIST GOALS ==================== */}
        {step === 4 && (
          <>
            <h2
              id="heybroc-onboarding-heading"
              style={{
                fontSize: 22.5,
                fontWeight: 800,
                color: "#111814",
                margin: "0 0 6px",
                lineHeight: 1.2,
              }}
            >
              What are your clean-eating goals?
            </h2>
            <p
              style={{
                fontSize: 13.5,
                color: "#4b5563",
                margin: "0 0 14px",
                lineHeight: 1.45,
              }}
            >
              Tap the ingredients you want out of your kitchen. HeyBroc applies{" "}
              <b>2x strictness</b> to your goals and finds{" "}
              <b>90–100/100 Clean Swaps</b> at {storeDisplayName} automatically.
            </p>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 7,
              }}
            >
              {WATCHLIST_PILLS.map((item) => {
                const active = selected.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggle(item.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      width: "100%",
                      textAlign: "left",
                      padding: "9px 12px",
                      borderRadius: 15,
                      border: active ? "2px solid #16a34a" : "1.5px solid #e5e7eb",
                      background: active ? "#f0fdf4" : "#ffffff",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <span
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 11,
                        background: active ? "#dcfce7" : "#f3f4f6",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 19,
                        flexShrink: 0,
                      }}
                    >
                      {item.icon}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 7,
                          flexWrap: "wrap",
                        }}
                      >
                        <span
                          style={{
                            fontSize: 14,
                            fontWeight: 800,
                            color: "#111814",
                          }}
                        >
                          {item.title}
                        </span>
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            padding: "2px 7px",
                            borderRadius: 999,
                            background: active ? "#16a34a" : "#e5e7eb",
                            color: active ? "#ffffff" : "#4b5563",
                          }}
                        >
                          {active ? "2x Penalty On" : item.badge}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: "#6b7280",
                          marginTop: 1,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {item.subtitle}
                      </div>
                    </div>
                    <span
                      style={{
                        width: 23,
                        height: 23,
                        borderRadius: 999,
                        background: active ? "#16a34a" : "#ffffff",
                        border: active ? "2px solid #16a34a" : "2px solid #d1d5db",
                        color: "#ffffff",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 12.5,
                        fontWeight: 800,
                        flexShrink: 0,
                      }}
                    >
                      {active ? "✓" : ""}
                    </span>
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 14 }}>
              <button
                type="button"
                onClick={() => setStep(5)}
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  borderRadius: 999,
                  border: "none",
                  background: "#16a34a",
                  color: "#ffffff",
                  fontSize: 15,
                  fontWeight: 800,
                  cursor: "pointer",
                  boxShadow: "0 6px 18px rgba(22, 163, 74, 0.25)",
                }}
              >
                Continue ({selected.length} {selected.length === 1 ? "Goal" : "Goals"} Selected) →
              </button>
            </div>
          </>
        )}

        {/* ==================== STEP 5: ALLERGY & DIETARY GUARD ==================== */}
        {step === 5 && (
          <>
            <h2
              id="heybroc-onboarding-heading"
              style={{
                fontSize: 22.5,
                fontWeight: 800,
                color: "#111814",
                margin: "0 0 6px",
                lineHeight: 1.2,
              }}
            >
              Any family allergies or dietary watches?
            </h2>
            <p
              style={{
                fontSize: 13.5,
                color: "#4b5563",
                margin: "0 0 14px",
                lineHeight: 1.45,
              }}
            >
              Optional — check any boxes below and HeyBroc will display instant{" "}
              <b>🛡️ Allergy &amp; Sugar badges</b> on your floating store pill:
            </p>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 7,
              }}
            >
              {DIETARY_PILLS.map((item) => {
                const active = dietarySelected.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleDietary(item.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      width: "100%",
                      textAlign: "left",
                      padding: "9px 12px",
                      borderRadius: 15,
                      border: active ? "2px solid #16a34a" : "1.5px solid #e5e7eb",
                      background: active ? "#f0fdf4" : "#ffffff",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <span
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 11,
                        background: active ? "#dcfce7" : "#f3f4f6",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 19,
                        flexShrink: 0,
                      }}
                    >
                      {item.icon}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 800, color: "#111814" }}>
                        {item.title}
                      </div>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: "#6b7280",
                          marginTop: 1,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {item.subtitle}
                      </div>
                    </div>
                    <span
                      style={{
                        width: 23,
                        height: 23,
                        borderRadius: 999,
                        background: active ? "#16a34a" : "#ffffff",
                        border: active ? "2px solid #16a34a" : "2px solid #d1d5db",
                        color: "#ffffff",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 12.5,
                        fontWeight: 800,
                        flexShrink: 0,
                      }}
                    >
                      {active ? "✓" : ""}
                    </span>
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                onClick={() => setStep(6)}
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  borderRadius: 999,
                  border: "none",
                  background: "#16a34a",
                  color: "#ffffff",
                  fontSize: 15,
                  fontWeight: 800,
                  cursor: "pointer",
                  boxShadow: "0 6px 18px rgba(22, 163, 74, 0.25)",
                }}
              >
                {dietarySelected.length > 0
                  ? `Save ${dietarySelected.length} ${dietarySelected.length === 1 ? "Alert" : "Alerts"} & Continue →`
                  : "No Allergies — Continue →"}
              </button>
            </div>
          </>
        )}

        {/* ==================== STEP 6: THE PROBLEM ==================== */}
        {step === 6 && (
          <>
            <h2
              id="heybroc-onboarding-heading"
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: "#111814",
                margin: "0 0 6px",
                lineHeight: 1.22,
              }}
            >
              Why &ldquo;Healthy-Looking&rdquo; Groceries Fail Your Goals
            </h2>
            <p
              style={{
                fontSize: 13.5,
                color: "#4b5563",
                margin: "0 0 14px",
                lineHeight: 1.45,
              }}
            >
              Big food brands print <b>&ldquo;Natural&rdquo;</b> or{" "}
              <b>&ldquo;Made with Real Fruit&rdquo;</b> on the front at {storeDisplayName} while hiding ultra-processed additives in tiny 6-point text on the back:
            </p>

            {/* Personalized Trigger Traps Based on Selected Goals */}
            <div
              style={{
                background: "#fef2f2",
                border: "1.5px solid #fecaca",
                borderRadius: 16,
                padding: "12px 14px",
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 800,
                  color: "#991b1b",
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  marginBottom: 8,
                }}
              >
                ⚠️ Hidden in Everyday {storeDisplayName} Staples ({activeHouseholdObj.title}):
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {displayGoalItems.slice(0, 3).map((g) => (
                  <div
                    key={g.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      fontSize: 12.5,
                      color: "#7f1d1d",
                    }}
                  >
                    <span>{g.icon}</span>
                    <div>
                      <b>{g.title}:</b> {g.problemNote}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Side-by-Side Before vs. After Example */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  background: "#fff5f5",
                  border: "1.5px solid #fca5a5",
                  borderRadius: 16,
                  padding: "12px",
                }}
              >
                <div
                  style={{
                    display: "inline-block",
                    background: "#dc2626",
                    color: "#ffffff",
                    fontSize: 10.5,
                    fontWeight: 800,
                    padding: "2px 8px",
                    borderRadius: 999,
                    marginBottom: 6,
                  }}
                >
                  ✕ 18/100 · Poor
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 800, color: "#111814" }}>
                  &ldquo;Natural&rdquo; Store Brand Pick
                </div>
                <div style={{ fontSize: 11.5, color: "#991b1b", marginTop: 4, lineHeight: 1.35 }}>
                  Hides Soybean Oil, High-Fructose Corn Syrup &amp; Red 40 in fine print.
                </div>
              </div>

              <div
                style={{
                  background: "#f0fdf4",
                  border: "1.5px solid #86efac",
                  borderRadius: 16,
                  padding: "12px",
                }}
              >
                <div
                  style={{
                    display: "inline-block",
                    background: "#16a34a",
                    color: "#ffffff",
                    fontSize: 10.5,
                    fontWeight: 800,
                    padding: "2px 8px",
                    borderRadius: 999,
                    marginBottom: 6,
                  }}
                >
                  ✓ 95/100 · Excellent
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 800, color: "#111814" }}>
                  1-Tap {storeDisplayName} Swap
                </div>
                <div style={{ fontSize: 11.5, color: "#166534", marginTop: 4, lineHeight: 1.35 }}>
                  100% Avocado/Olive Oil or Organic whole ingredients — 0 seed oils, 0 dyes.
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setStep(7)}
              style={{
                width: "100%",
                padding: "14px 16px",
                borderRadius: 999,
                border: "none",
                background: "#16a34a",
                color: "#ffffff",
                fontSize: 15,
                fontWeight: 800,
                cursor: "pointer",
                boxShadow: "0 6px 18px rgba(22, 163, 74, 0.25)",
              }}
            >
              See How HeyBroc Solves This →
            </button>
          </>
        )}

        {/* ==================== STEP 7: INTERACTIVE MINI-TEST & HOW HEYBROC SOLVES IT ==================== */}
        {step === 7 && (
          <>
            <h2
              id="heybroc-onboarding-heading"
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: "#111814",
                margin: "0 0 6px",
                lineHeight: 1.22,
              }}
            >
              How HeyBroc Protects Your Cart in 1 Second
            </h2>
            <p
              style={{
                fontSize: 13,
                color: "#4b5563",
                margin: "0 0 10px",
                lineHeight: 1.42,
              }}
            >
              Tap an everyday staple below to see how your <b>2x Watchlist</b> grades it and swaps it at <b>{storeDisplayName}</b> across <b>1.5M+ foods</b>:
            </p>

            {/* 1-Tap Interactive Sample Switcher */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginBottom: 10 }}>
              {MINI_TEST_SAMPLES.map((s, idx) => {
                const active = sampleIdx === idx;
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSampleIdx(idx)}
                    style={{
                      padding: "8px 5px",
                      borderRadius: 12,
                      border: active ? "2px solid #16a34a" : "1.5px solid #e5e7eb",
                      background: active ? "#f0fdf4" : "#ffffff",
                      fontSize: 11.5,
                      fontWeight: 800,
                      color: active ? "#14532d" : "#374151",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      minWidth: 0,
                    }}
                  >
                    {s.icon} {s.shortLabel}
                  </button>
                );
              })}
            </div>

            {/* Live Mini-Test Preview Card */}
            <div
              style={{
                background: "#f8fafc",
                border: "1.5px solid #cbd5e1",
                borderRadius: 16,
                padding: "11px 13px",
                marginBottom: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#991b1b" }}>
                  ✕ {activeSample.dirtyTitle}
                </span>
                <span
                  style={{
                    background: "#dc2626",
                    color: "#ffffff",
                    fontSize: 10.5,
                    fontWeight: 800,
                    padding: "2px 8px",
                    borderRadius: 999,
                    flexShrink: 0,
                  }}
                >
                  {activeSample.dirtyScore}/100 · Poor
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: "#7f1d1d", marginTop: 3 }}>
                {activeSample.dirtyFlags}
              </div>

              <div
                style={{
                  height: 1,
                  background: "#e2e8f0",
                  margin: "8px 0",
                }}
              />

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#14532d" }}>
                  ⇄ {activeSample.cleanTitle} ({storeDisplayName})
                </span>
                <span
                  style={{
                    background: "#16a34a",
                    color: "#ffffff",
                    fontSize: 10.5,
                    fontWeight: 800,
                    padding: "2px 8px",
                    borderRadius: 999,
                    flexShrink: 0,
                  }}
                >
                  {activeSample.cleanScore}/100 · Clean
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: "#166534", marginTop: 3 }}>
                {activeSample.cleanPerks}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "10px 12px",
                  borderRadius: 14,
                  background: "#f8fafc",
                  border: "1.5px solid #e2e8f0",
                }}
              >
                <span style={{ fontSize: 19 }}>📷</span>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 800, color: "#111814" }}>
                    1. Instant 0–100 Barcode &amp; Search Grading (100% Free)
                  </div>
                  <div style={{ fontSize: 12, color: "#4b5563", marginTop: 1, lineHeight: 1.35 }}>
                    Transparent 60/30/10 Yuka-style breakdown with <b>2x strictness</b> on your watchlist.
                  </div>
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "10px 12px",
                  borderRadius: 14,
                  background: "#f0fdf4",
                  border: "1.5px solid #bbf7d0",
                }}
              >
                <span style={{ fontSize: 19 }}>🟢</span>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 800, color: "#14532d" }}>
                    2. Live Store Bubble &amp; Whole-Cart Health Check
                  </div>
                  <div style={{ fontSize: 12, color: "#166534", marginTop: 1, lineHeight: 1.35 }}>
                    Grades items automatically while you browse {storeDisplayName} and swaps your whole cart in 1 tap.
                  </div>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setStep(8)}
              style={{
                width: "100%",
                padding: "14px 16px",
                borderRadius: 999,
                border: "none",
                background: "#16a34a",
                color: "#ffffff",
                fontSize: 15,
                fontWeight: 800,
                cursor: "pointer",
                boxShadow: "0 6px 18px rgba(22, 163, 74, 0.25)",
              }}
            >
              Build My Personalized Plan →
            </button>
          </>
        )}

        {/* ==================== STEP 8: PERSONALIZED PLAN (FREEMIUM + PRO TRIAL) ==================== */}
        {step === 8 && (
          <>
            <div
              style={{
                background: "#ecfdf5",
                border: "1.5px solid #6ee7b7",
                borderRadius: 14,
                padding: "10px 13px",
                marginBottom: 12,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span style={{ fontSize: 20 }}>✅</span>
              <div style={{ fontSize: 12, color: "#065f46", lineHeight: 1.4 }}>
                <b>Your Custom Profile Is Calibrated:</b> {activeHouseholdObj.title} ·{" "}
                <b>{storeDisplayName}</b> · <b>{selected.length}</b> 2x Watchlist{" "}
                {selected.length === 1 ? "goal" : "goals"}
                {dietarySelected.length > 0
                  ? ` · ${dietarySelected.length} Allergy/Diet ${dietarySelected.length === 1 ? "alert" : "alerts"}`
                  : ""}
                .
              </div>
            </div>

            {appliedCreator && (
              <div
                style={{
                  background: "#fefce8",
                  border: "1.5px solid #fde047",
                  borderRadius: 14,
                  padding: "9px 13px",
                  marginBottom: 10,
                  fontSize: 12.5,
                  color: "#854d0e",
                }}
              >
                {isFriendInvite ? (
                  <>
                    🎁 <b>Friend Invite ({appliedCreator.code}) Applied:</b> Start your trial to unlock{" "}
                    <b>+{PRICING.referralBonusDays} Free Pro Days</b> for both of you!
                  </>
                ) : (
                  <>
                    🎉 <b>Creator Code {appliedCreator.code} Applied:</b> {appliedCreator.name} unlocked your{" "}
                    <b>{PRICING.creatorTrialDays}-Day Extended Free Pro Trial!</b>
                  </>
                )}
              </div>
            )}

            <h2
              id="heybroc-onboarding-heading"
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: "#111814",
                margin: "0 0 6px",
                lineHeight: 1.22,
              }}
            >
              Choose How You Want to Start
            </h2>
            <p
              style={{
                fontSize: 13,
                color: "#4b5563",
                margin: "0 0 12px",
                lineHeight: 1.45,
              }}
            >
              Barcode &amp; search grading is <b>always 100% free</b>. Unlock unlimited 1-tap {storeDisplayName} Clean Swaps &amp; Whole-Cart Checks with a{" "}
              <b>{effectiveTrialDays}-Day Free Pro Trial ($0 today)</b>, or start on the Free Plan:
            </p>

            {/* Plan Comparison Card */}
            <div
              style={{
                background: "#f0fdf4",
                border: "2px solid #16a34a",
                borderRadius: 18,
                padding: "14px",
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 6,
                }}
              >
                <span style={{ fontSize: 14.5, fontWeight: 800, color: "#14532d" }}>
                  ⭐ HeyBroc Family Pro
                </span>
                <span
                  style={{
                    background: "#16a34a",
                    color: "#ffffff",
                    fontSize: 10.5,
                    fontWeight: 800,
                    padding: "3px 9px",
                    borderRadius: 999,
                  }}
                >
                  {effectiveTrialDays} DAYS FREE · $0 TODAY
                </span>
              </div>
              <ul
                style={{
                  margin: "0 0 8px",
                  paddingLeft: 18,
                  fontSize: 12.5,
                  color: "#166534",
                  lineHeight: 1.55,
                }}
              >
                <li>
                  <b>Unlimited 1-Tap Clean Swaps</b> at {storeDisplayName} &amp; all 12+ stores
                </li>
                <li>
                  <b>Whole-Cart Health Check</b> &amp; Swap-All Cart Cleaner
                </li>
                <li>
                  <b>Unlimited Live Store Bubble</b> &amp; Family Cloud Sync
                </li>
              </ul>
              <div style={{ fontSize: 11.5, color: "#15803d" }}>
                $0 due today · Then ${annualPerMonth.toFixed(2)}/mo billed annually (${PRICING.annual}/yr) or ${PRICING.monthly}/mo. Cancel anytime in 1 tap.
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  const extras = buildExtras();
                  trackOnboardingEvent("onboarding_completed", {
                    exitAction: "trial",
                    householdProfile: extras.householdProfile,
                    primaryGoal: extras.primaryGoal,
                    store: extras.store,
                    watchlistCount: selected.length,
                    dietaryCount: dietarySelected.length,
                  });
                  if (onApplyAndStartTrial) {
                    onApplyAndStartTrial(selected, extras);
                  } else {
                    onApplyAndSignIn(selected, extras);
                  }
                }}
                style={{
                  width: "100%",
                  padding: "14px 16px",
                  borderRadius: 999,
                  border: "none",
                  background: "#16a34a",
                  color: "#ffffff",
                  fontSize: 15,
                  fontWeight: 800,
                  cursor: "pointer",
                  boxShadow: "0 6px 18px rgba(22, 163, 74, 0.28)",
                }}
              >
                Start {effectiveTrialDays}-Day Free Pro Trial ($0 Today) →
              </button>

              <button
                type="button"
                onClick={() => {
                  const extras = buildExtras();
                  trackOnboardingEvent("onboarding_completed", {
                    exitAction: "guest",
                    householdProfile: extras.householdProfile,
                    primaryGoal: extras.primaryGoal,
                    store: extras.store,
                    watchlistCount: selected.length,
                    dietaryCount: dietarySelected.length,
                  });
                  onApplyAndGuest(selected, extras);
                }}
                style={{
                  width: "100%",
                  padding: "12px 14px",
                  borderRadius: 999,
                  border: "1.5px solid #d1d5db",
                  background: "#ffffff",
                  color: "#1f2937",
                  fontSize: 13.5,
                  fontWeight: 800,
                  cursor: "pointer",
                }}
              >
                Continue with Free Plan (Unlimited Scans + {PRICING.freeWeeklySwaps} Swaps/Wk) →
              </button>

              <button
                type="button"
                onClick={() => {
                  const extras = buildExtras();
                  trackOnboardingEvent("onboarding_completed", {
                    exitAction: "signin",
                    householdProfile: extras.householdProfile,
                    primaryGoal: extras.primaryGoal,
                    store: extras.store,
                    watchlistCount: selected.length,
                    dietaryCount: dietarySelected.length,
                  });
                  onApplyAndSignIn(selected, extras);
                }}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  borderRadius: 999,
                  border: "none",
                  background: "transparent",
                  color: "#0f7a4a",
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Save Watchlist ({selected.length}) &amp; Sign In / Sync Free Across Devices →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
