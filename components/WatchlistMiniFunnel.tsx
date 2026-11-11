"use client";

import { useEffect, useRef, useState } from "react";
import type { DietaryOptionId } from "@/lib/dietary";
import { PRICING, annualPerMonth } from "@/lib/pricing";
import type { Category } from "@/lib/rubric";
import { STORE_META, type Store } from "@/lib/swaps";

export type { DietaryOptionId };
export type HouseholdProfileId = "kids_family" | "partner" | "myself" | "sensitivity";
export type PrimaryGoalId = "seed_oil_free" | "kids_dye_free" | "whole_foods" | "clean_swaps";
export type FunnelStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface OnboardingSelections {
  watchlist: Category[];
  dietaryWatchlist?: DietaryOptionId[];
  store?: Store;
  stores?: Store[];
  householdProfile?: HouseholdProfileId;
  householdProfiles?: HouseholdProfileId[];
  primaryGoal?: PrimaryGoalId;
}

export interface WatchlistMiniFunnelProps {
  open: boolean;
  initialSelected: Category[];
  initialStore?: Store;
  initialStores?: Store[];
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
    subtitle: "Keep Red 40, seed oils & hidden syrups out of family meals",
    badge: "Most Popular",
    recommendedCats: ["seedOils", "dyes", "hfcs", "nitrates"],
  },
  {
    id: "partner",
    icon: "💑",
    title: "Me & My Partner",
    subtitle: "Upgrade our shared grocery cart to clean whole-food staples",
    badge: "Household",
    recommendedCats: ["seedOils", "hfcs", "preservatives"],
  },
  {
    id: "myself",
    icon: "🏃",
    title: "Just Myself",
    subtitle: "Hit my personal clean-eating, fitness & ingredient goals",
    badge: "Personal",
    recommendedCats: ["seedOils", "hfcs", "sweeteners"],
  },
  {
    id: "sensitivity",
    icon: "🛡️",
    title: "Managing Food Sensitivities",
    subtitle: "Strict ingredient, additive & allergen screening on every label",
    badge: "Strict Guard",
    recommendedCats: ["seedOils", "dyes", "hfcs", "preservatives", "sweeteners"],
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
    problemNote: "Hidden in 70%+ of 'Natural' dressings, chips & crackers",
  },
  {
    id: "dyes",
    icon: "🧪",
    title: "Red 40 & Artificial Dyes",
    subtitle: "Red 40, Yellow 5 & 6, Blue 1, Titanium Dioxide",
    badge: "Kids' Watchlist",
    problemNote: "Disguised in kids' yogurts, fruit snacks & cereals",
  },
  {
    id: "hfcs",
    icon: "🌽",
    title: "High-Fructose Corn Syrup",
    subtitle: "HFCS, corn syrup solids & hidden refined syrups",
    badge: "Added Syrups",
    problemNote: "Slipped into breads, ketchup & barbecue sauces",
  },
  {
    id: "nitrates",
    icon: "🥓",
    title: "Nitrites & Curing Nitrates",
    subtitle: "Sodium nitrite/nitrate in bacon, deli meat & hot dogs",
    badge: "Deli & Meat",
    problemNote: "Found in conventional lunch meats, bacon & hot dogs",
  },
  {
    id: "sweeteners",
    icon: "🥤",
    title: "Artificial Sweeteners",
    subtitle: "Sucralose, aspartame, acesulfame potassium & saccharin",
    badge: "Zero Artificial",
    problemNote: "Used in 'Zero Sugar' sodas, shakes & light yogurts",
  },
  {
    id: "preservatives",
    icon: "🛡️",
    title: "BHA, BHT & Harsh Preservatives",
    subtitle: "TBHQ, BHA/BHT, potassium bromate & propylparaben",
    badge: "Synthetic",
    problemNote: "Added to cereals, tortillas & frozen family meals",
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
    id: "pesticide_risk",
    icon: "🌱",
    title: "Herbicides & Pesticides (Glyphosate) Watch",
    subtitle: "Flags non-organic Dirty-Dozen produce & conventional oats/wheat/legumes (glyphosate desiccant risk); swaps to USDA Organic",
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
    dirtyFlags: "Flagged (2x): Red 40, High-Fructose Corn Syrup & Sorbate",
    cleanTitle: "Organic Whole Milk Berry Yogurt",
    cleanScore: 94,
    cleanPerks: "Organic milk & real strawberries — 0 dyes, 0 corn syrup",
  },
  {
    id: "ranch",
    icon: "🥗",
    shortLabel: "Creamy Ranch",
    dirtyTitle: '"Homestyle" Creamy Ranch Dressing',
    dirtyScore: 18,
    dirtyFlags: "Flagged (2x): Soybean Oil (#1), MSG & Polysorbate 60",
    cleanTitle: "100% Avocado Oil Ranch Dressing",
    cleanScore: 92,
    cleanPerks: "100% pure avocado oil & organic herbs — 0 seed oils",
  },
  {
    id: "crackers",
    icon: "🧀",
    shortLabel: "Cheddar Crackers",
    dirtyTitle: "Baked Cheddar Snack Crackers",
    dirtyScore: 24,
    dirtyFlags: "Flagged (2x): Soybean/Canola Oil, TBHQ & Yellow 6",
    cleanTitle: "Organic Grass-Fed Cheddar Crackers",
    cleanScore: 95,
    cleanPerks: "Organic wheat & grass-fed cheddar — 0 seed oils, 0 dyes",
  },
];

const STEP_TITLES: Record<FunnelStep, string> = {
  1: "Household",
  2: "Your Goals",
  3: "Your Stores",
  4: "Allergy Guard",
  5: "Why It Matters",
  6: "Live Demo",
  7: "Your Plan",
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

function resolveStoreLabel(id: Store): string {
  return STORE_CHOICES.find((s) => s.id === id)?.label || STORE_META[id]?.label || "Walmart";
}

function formatStoresSummary(stores: Store[]): string {
  if (stores.length === 0) return "all 12+ stores";
  if (stores.length === 1) return resolveStoreLabel(stores[0]);
  if (stores.length === 2) {
    return `${resolveStoreLabel(stores[0])} & ${resolveStoreLabel(stores[1])}`;
  }
  if (stores.length === 3) {
    return `${resolveStoreLabel(stores[0])}, ${resolveStoreLabel(stores[1])} & ${resolveStoreLabel(stores[2])}`;
  }
  return `${resolveStoreLabel(stores[0])}, ${resolveStoreLabel(stores[1])} + ${stores.length - 2} more`;
}

export default function WatchlistMiniFunnel({
  open,
  initialSelected,
  initialStore = "walmart",
  initialStores,
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
  const normalizeChoiceStores = (storesArg?: Store[], fallbackStore: Store = "walmart"): Store[] => {
    const choiceIds = new Set<Store>(STORE_CHOICES.map((s) => s.id));
    if (storesArg !== undefined) {
      return storesArg.filter((s) => choiceIds.has(s));
    }
    return [choiceIds.has(fallbackStore) ? fallbackStore : "walmart"];
  };

  const [selected, setSelected] = useState<Category[]>(initialSelected);
  const [dietarySelected, setDietarySelected] = useState<DietaryOptionId[]>(initialDietary);
  const [selectedStores, setSelectedStores] = useState<Store[]>(() =>
    normalizeChoiceStores(initialStores, initialStore)
  );
  const [households, setHouseholds] = useState<HouseholdProfileId[]>(["kids_family"]);
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
      setSelectedStores(normalizeChoiceStores(initialStores, initialStore));
      if (typeof window !== "undefined") {
        const savedHouseholdsCsv = window.localStorage.getItem("heybroc_household_profiles");
        const validIds = new Set<HouseholdProfileId>(HOUSEHOLD_OPTIONS.map((h) => h.id));
        if (savedHouseholdsCsv) {
          const parsed = savedHouseholdsCsv
            .split(",")
            .map((s) => s.trim() as HouseholdProfileId)
            .filter((s) => validIds.has(s));
          setHouseholds(parsed.length > 0 ? parsed : ["kids_family"]);
        } else {
          const savedSingle = window.localStorage.getItem("heybroc_household_profile") as HouseholdProfileId | null;
          setHouseholds(savedSingle && validIds.has(savedSingle) ? [savedSingle] : ["kids_family"]);
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
  }, [open, initialSelected, initialDietary, initialStore, initialStores, initialStep]);

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

  const primaryStore: Store = selectedStores[0] ?? initialStore ?? "walmart";
  const primaryHousehold: HouseholdProfileId = households[0] ?? "kids_family";

  const buildExtras = (): OnboardingSelections => ({
    watchlist: selected,
    dietaryWatchlist: dietarySelected,
    store: primaryStore,
    stores: selectedStores,
    householdProfile: primaryHousehold,
    householdProfiles: households,
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
        if (isReturningUser) {
          handleBackdropOrEscapeDismiss();
        } else if (step > 1) {
          setStep((s) => (s > 1 ? ((s - 1) as FunnelStep) : 1));
        }
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
  const effectiveTrialDays = PRICING.trialDays;

  const toggleHousehold = (id: HouseholdProfileId) => {
    setHouseholds((prev) => {
      const next = prev.includes(id) ? prev.filter((h) => h !== id) : [...prev, id];
      const finalNext = next.length > 0 ? next : [id];
      const unionCats = Array.from(
        new Set(
          finalNext.flatMap(
            (hId) => HOUSEHOLD_OPTIONS.find((o) => o.id === hId)?.recommendedCats ?? []
          )
        )
      );
      if (unionCats.length > 0) {
        setSelected(unionCats);
      }
      if (typeof window !== "undefined") {
        window.localStorage.setItem("heybroc_household_profiles", finalNext.join(","));
      }
      return finalNext;
    });
  };

  const toggle = (cat: Category) => {
    setSelected((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  };

  const toggleStore = (storeId: Store) => {
    setSelectedStores((prev) =>
      prev.includes(storeId) ? prev.filter((s) => s !== storeId) : [...prev, storeId]
    );
  };

  const toggleDietary = (id: DietaryOptionId) => {
    setDietarySelected((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]
    );
  };

  const activeGoalItems = WATCHLIST_PILLS.filter((p) => selected.includes(p.id));
  const displayGoalItems =
    activeGoalItems.length > 0 ? activeGoalItems : WATCHLIST_PILLS.slice(0, 2);
  const activeHouseholdObj =
    HOUSEHOLD_OPTIONS.find((h) => h.id === primaryHousehold) || HOUSEHOLD_OPTIONS[0];
  const householdSummaryLabel =
    households.length > 1
      ? `${activeHouseholdObj.title} + ${households.length - 1} more`
      : activeHouseholdObj.title;
  const storeDisplayName = resolveStoreLabel(primaryStore);
  const storesSummaryLabel = formatStoresSummary(selectedStores);
  const activeSample = MINI_TEST_SAMPLES[sampleIdx] || MINI_TEST_SAMPLES[0];

  return (
    <div
      className="modal-backdrop gococo-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="heybroc-onboarding-heading"
      onClick={isReturningUser ? handleBackdropOrEscapeDismiss : undefined}
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
        {/* Top Header: Back Button / Step Pill + Returning-User Close Button */}
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
              🥦 Step {step} of 7 · {STEP_TITLES[step]}
            </span>
          </div>

          {isReturningUser && (
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
          )}
        </div>

        {/* 7-Segment Progress Bar */}
        <div
          role="progressbar"
          aria-valuenow={step}
          aria-valuemin={1}
          aria-valuemax={7}
          aria-label={`Onboarding step ${step} of 7: ${STEP_TITLES[step]}`}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7, 1fr)",
            gap: 5,
            marginBottom: 16,
          }}
        >
          {([1, 2, 3, 4, 5, 6, 7] as FunnelStep[]).map((idx) =>
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

        {/* ==================== STEP 1: HOUSEHOLD PROFILE (MULTI-SELECT) ==================== */}
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
              Select <b>all that apply</b> — we&apos;ll calibrate your <b>0–100 food grading</b> in 60 seconds:
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {HOUSEHOLD_OPTIONS.map((opt) => {
                const active = households.includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleHousehold(opt.id)}
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
                        width: 23,
                        height: 23,
                        borderRadius: 7,
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

        {/* ==================== STEP 2: 2X INGREDIENT WATCHLIST GOALS (MULTI-SELECT) ==================== */}
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
              Select <b>as many as you want</b> — HeyBroc applies <b>2x strictness</b> to your choices and finds <b>90–100/100 Clean Swaps</b>:
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
                        borderRadius: 7,
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
                onClick={() => setStep(3)}
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

        {/* ==================== STEP 3: FAVORITE GROCERY STORES (MULTI-SELECT) ==================== */}
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
                margin: "0 0 10px",
                lineHeight: 1.45,
              }}
            >
              Select <b>all the stores</b> you shop at — we&apos;ll pin your favorites first:
            </p>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                background: "#ecfdf5",
                border: "1.5px solid #86efac",
                borderRadius: 12,
                padding: "8px 11px",
                marginBottom: 10,
              }}
            >
              <span style={{ fontSize: 11.5, fontWeight: 700, color: "#14532d", lineHeight: 1.35 }}>
                ✓ All 12+ grocery &amp; delivery stores + 1.5M+ barcodes stay unlocked
              </span>
              <button
                type="button"
                onClick={() => {
                  const allChecked = STORE_CHOICES.every((s) => selectedStores.includes(s.id));
                  if (allChecked) {
                    setSelectedStores(normalizeChoiceStores(undefined, initialStore));
                  } else {
                    setSelectedStores(STORE_CHOICES.map((s) => s.id));
                  }
                }}
                style={{
                  background: "#ffffff",
                  border: "1px solid #86efac",
                  borderRadius: 999,
                  padding: "3px 9px",
                  fontSize: 11,
                  fontWeight: 800,
                  color: "#15803d",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                {STORE_CHOICES.every((s) => selectedStores.includes(s.id)) ? "Reset" : "Select all"}
              </button>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(185px, 1fr))",
                gap: 8,
              }}
            >
              {STORE_CHOICES.map((st) => {
                const active = selectedStores.includes(st.id);
                return (
                  <button
                    key={st.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleStore(st.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      textAlign: "left",
                      padding: "10px 12px",
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
                    <span
                      style={{
                        width: 21,
                        height: 21,
                        borderRadius: 6,
                        background: active ? "#16a34a" : "#ffffff",
                        border: active ? "2px solid #16a34a" : "2px solid #d1d5db",
                        color: "#ffffff",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 12,
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
                {selectedStores.length === 0
                  ? "Continue (All 12+ Stores Unlocked) →"
                  : `Continue (${selectedStores.length} ${selectedStores.length === 1 ? "Store" : "Stores"} Selected) →`}
              </button>
            </div>
          </>
        )}

        {/* ==================== STEP 4: ALLERGY, DIETARY & GLYPHOSATE GUARD (MULTI-SELECT) ==================== */}
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
              Optional — select any watches below for instant <b>🛡️ Allergy, Sugar &amp; Glyphosate alerts</b>:
            </p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))",
                gap: 7,
              }}
            >
              {DIETARY_PILLS.map((item) => {
                const active = dietarySelected.includes(item.id);
                const isGlyphosate = item.id === "pesticide_risk";
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleDietary(item.id)}
                    style={{
                      gridColumn: isGlyphosate ? "1 / -1" : undefined,
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 10px",
                      borderRadius: 14,
                      border: active ? "2px solid #16a34a" : "1.5px solid #e5e7eb",
                      background: active ? "#f0fdf4" : "#ffffff",
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <span
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 9,
                        background: active ? "#dcfce7" : "#f3f4f6",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 16,
                        flexShrink: 0,
                      }}
                    >
                      {item.icon}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12.5,
                          fontWeight: 800,
                          color: "#111814",
                          whiteSpace: isGlyphosate ? "normal" : "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {item.title}
                      </div>
                      {isGlyphosate && (
                        <div
                          style={{
                            fontSize: 11,
                            color: "#6b7280",
                            marginTop: 1,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {item.subtitle}
                        </div>
                      )}
                    </div>
                    <span
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 6,
                        background: active ? "#16a34a" : "#ffffff",
                        border: active ? "2px solid #16a34a" : "2px solid #d1d5db",
                        color: "#ffffff",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 11.5,
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

            {/* Full USA Side-by-Side Glyphosate Usage vs. Cancer Incidence Comparison Map Card */}
            <div
              id="onboarding-iowa-glyphosate-map"
              style={{
                marginTop: 12,
                background: "linear-gradient(180deg, #fffbeb 0%, #fef2f2 100%)",
                border: "1.5px solid #fca5a5",
                borderRadius: 16,
                padding: "12px 13px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 6,
                  flexWrap: "wrap",
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 800,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "#991b1b",
                    background: "#fee2e2",
                    padding: "3px 8px",
                    borderRadius: 999,
                  }}
                >
                  🇺🇸 U.S. Glyphosate Map vs. U.S. Cancer Map
                </span>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: "#78350f" }}>
                  USGS National Map × CDC / NCI Registry
                </span>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                {/* Left Map: Full USA USGS Glyphosate Application Map */}
                <div
                  style={{
                    background: "#ffffff",
                    border: "1px solid #fed7aa",
                    borderRadius: 12,
                    padding: "8px 9px",
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#9a3412", marginBottom: 4 }}>
                    1. U.S. Glyphosate Usage (USGS)
                  </div>
                  <svg
                    viewBox="0 0 320 195"
                    role="img"
                    aria-label="United States map of agricultural glyphosate usage showing low usage in Western states and a dark crimson bullseye over Iowa and the Midwest Corn Belt"
                    style={{ width: "100%", height: "auto", display: "block", borderRadius: 6, background: "#fffaf5" }}
                  >
                    <path
                      d="M26,18 L174,18 L186,28 L206,26 L224,38 L236,52 L252,48 L278,34 L292,18 L304,28 L296,48 L286,62 L282,84 L274,108 L256,132 L268,172 L254,176 L240,144 L204,146 L182,156 L166,152 L148,180 L132,176 L116,148 L98,150 L82,138 L52,136 L24,120 L12,86 L14,48 Z"
                      fill="#fef3c7"
                      stroke="#9a3412"
                      strokeWidth="1.8"
                    />
                    <g stroke="#d97706" strokeWidth="0.7" opacity="0.45" fill="none">
                      <path d="M56,18 L48,132 M96,18 L92,148 M134,18 L134,174 M174,18 L176,154 M214,34 L212,146 M252,48 L244,144" />
                      <path d="M14,54 L288,56 M12,92 L278,94 M36,124 L258,126" />
                    </g>
                    <path
                      d="M124,22 L192,24 L214,44 L236,56 L238,88 L218,108 L196,148 L172,152 L166,118 L126,110 L118,68 Z"
                      fill="#fb923c"
                      opacity="0.72"
                    />
                    <path
                      d="M142,44 L198,44 L228,62 L232,88 L204,98 L188,138 L174,138 L172,98 L144,92 Z"
                      fill="#c2410c"
                      opacity="0.88"
                    />
                    <path
                      d="M156,54 L192,54 L196,68 L192,82 L158,82 L154,68 Z"
                      fill="#431407"
                      stroke="#ffffff"
                      strokeWidth="2"
                    />
                    <path
                      d="M194,58 L214,58 L216,90 L196,92 L192,82 L196,68 Z"
                      fill="#7c2d12"
                      stroke="#fed7aa"
                      strokeWidth="1"
                    />
                    <circle
                      cx="175"
                      cy="68"
                      r="22"
                      fill="none"
                      stroke="#dc2626"
                      strokeWidth="2"
                      strokeDasharray="4 2"
                    />
                    <text x="175" y="72" textAnchor="middle" fill="#ffffff" fontSize="10" fontWeight="900">
                      IA
                    </text>
                    <text x="54" y="82" textAnchor="middle" fill="#92400e" fontSize="8.5" fontWeight="700">
                      LOW
                    </text>
                    <rect x="64" y="6" width="192" height="20" rx="10" fill="#7c2d12" />
                    <text x="160" y="19" textAnchor="middle" fill="#ffffff" fontSize="9.5" fontWeight="800">
                      🎯 IOWA &amp; CORN BELT: #1 GLYPHOSATE ZONE
                    </text>
                  </svg>
                  <div style={{ fontSize: 10.5, color: "#7c2d12", marginTop: 4, lineHeight: 1.3 }}>
                    <b>#1 U.S. Spray Zone:</b> Concentrated in <b>Iowa &amp; the Corn Belt</b> on conventional oats, wheat &amp; produce.
                  </div>
                </div>

                {/* Right Map: Full USA Cancer Incidence Hotspot Map */}
                <div
                  style={{
                    background: "#ffffff",
                    border: "1px solid #fecaca",
                    borderRadius: 12,
                    padding: "8px 9px",
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#991b1b", marginBottom: 4 }}>
                    2. U.S. Cancer Incidence (CDC/NCI)
                  </div>
                  <svg
                    viewBox="0 0 320 195"
                    role="img"
                    aria-label="United States cancer incidence map showing matching dark crimson hotspot over Iowa (#2 highest and #1 fastest-rising cancer rate in the US)"
                    style={{ width: "100%", height: "auto", display: "block", borderRadius: 6, background: "#fff5f5" }}
                  >
                    <path
                      d="M26,18 L174,18 L186,28 L206,26 L224,38 L236,52 L252,48 L278,34 L292,18 L304,28 L296,48 L286,62 L282,84 L274,108 L256,132 L268,172 L254,176 L240,144 L204,146 L182,156 L166,152 L148,180 L132,176 L116,148 L98,150 L82,138 L52,136 L24,120 L12,86 L14,48 Z"
                      fill="#fee2e2"
                      stroke="#991b1b"
                      strokeWidth="1.8"
                    />
                    <g stroke="#ef4444" strokeWidth="0.7" opacity="0.38" fill="none">
                      <path d="M56,18 L48,132 M96,18 L92,148 M134,18 L134,174 M174,18 L176,154 M214,34 L212,146 M252,48 L244,144" />
                      <path d="M14,54 L288,56 M12,92 L278,94 M36,124 L258,126" />
                    </g>
                    <path
                      d="M126,24 L196,26 L220,46 L242,60 L240,94 L220,114 L198,146 L172,148 L164,114 L128,106 L122,66 Z"
                      fill="#f87171"
                      opacity="0.72"
                    />
                    <path
                      d="M144,42 L202,42 L228,62 L230,90 L204,100 L186,132 L172,132 L170,96 L144,90 Z"
                      fill="#dc2626"
                      opacity="0.88"
                    />
                    <path
                      d="M156,54 L192,54 L196,68 L192,82 L158,82 L154,68 Z"
                      fill="#450a0a"
                      stroke="#ffffff"
                      strokeWidth="2"
                    />
                    <path
                      d="M194,58 L214,58 L216,90 L196,92 L192,82 L196,68 Z"
                      fill="#991b1b"
                      stroke="#fecaca"
                      strokeWidth="1"
                    />
                    <circle
                      cx="175"
                      cy="68"
                      r="22"
                      fill="none"
                      stroke="#fef08a"
                      strokeWidth="2.2"
                      strokeDasharray="4 2"
                    />
                    <text x="175" y="72" textAnchor="middle" fill="#ffffff" fontSize="10" fontWeight="900">
                      IA
                    </text>
                    <text x="54" y="82" textAnchor="middle" fill="#991b1b" fontSize="8.5" fontWeight="700">
                      LOW
                    </text>
                    <rect x="54" y="6" width="212" height="20" rx="10" fill="#7f1d1d" />
                    <text x="160" y="19" textAnchor="middle" fill="#ffffff" fontSize="9.5" fontWeight="800">
                      🎯 IOWA: #2 US CANCER RATE (#1 RISING)
                    </text>
                  </svg>
                  <div style={{ fontSize: 10.5, color: "#7f1d1d", marginTop: 4, lineHeight: 1.3 }}>
                    <b>Same U.S. Bullseye:</b> Iowa has the <b>#2 highest &amp; fastest-rising cancer rate</b> (<b>82%</b> of high-spray counties exceed U.S. lymphoma avg).
                  </div>
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  flexWrap: "wrap",
                  paddingTop: 4,
                  borderTop: "1px solid rgba(239, 68, 68, 0.2)",
                }}
              >
                <span style={{ fontSize: 11, color: "#7f1d1d", lineHeight: 1.35, flex: 1, minWidth: 180 }}>
                  <b>USDA Organic</b> prohibits synthetic glyphosate &amp; pesticides.
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (!dietarySelected.includes("pesticide_risk")) {
                      toggleDietary("pesticide_risk");
                    }
                  }}
                  style={{
                    padding: "6px 11px",
                    borderRadius: 999,
                    border: dietarySelected.includes("pesticide_risk")
                      ? "1.5px solid #16a34a"
                      : "1.5px solid #dc2626",
                    background: dietarySelected.includes("pesticide_risk") ? "#dcfce7" : "#dc2626",
                    color: dietarySelected.includes("pesticide_risk") ? "#14532d" : "#ffffff",
                    fontSize: 11,
                    fontWeight: 800,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {dietarySelected.includes("pesticide_risk")
                    ? "✓ Glyphosate Watch Active"
                    : "🌱 Guard Against Glyphosate"}
                </button>
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
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
                {dietarySelected.length > 0
                  ? `Save ${dietarySelected.length} ${dietarySelected.length === 1 ? "Alert" : "Alerts"} & Continue →`
                  : "No Allergies — Continue →"}
              </button>
            </div>
          </>
        )}

        {/* ==================== STEP 5: WHY IT MATTERS (HEALTHY FAMILY PHOTO + CONCISE VISUALS) ==================== */}
        {step === 5 && (
          <>
            {/* Warm Healthy Family Hero Photo */}
            <div
              style={{
                position: "relative",
                borderRadius: 18,
                overflow: "hidden",
                marginBottom: 12,
                border: "1.5px solid #bbf7d0",
                boxShadow: "0 8px 20px rgba(15, 23, 42, 0.08)",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/onboarding-healthy-family.jpg"
                alt="Happy family with kids eating healthy whole foods together at the kitchen table"
                style={{
                  width: "100%",
                  height: 176,
                  objectFit: "cover",
                  display: "block",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: 10,
                  bottom: 10,
                  background: "rgba(20, 83, 45, 0.90)",
                  color: "#ffffff",
                  fontSize: 11,
                  fontWeight: 800,
                  padding: "4px 10px",
                  borderRadius: 999,
                }}
              >
                💚 Protecting {householdSummaryLabel}
              </div>
            </div>

            <h2
              id="heybroc-onboarding-heading"
              style={{
                fontSize: 21,
                fontWeight: 800,
                color: "#111814",
                margin: "0 0 4px",
                lineHeight: 1.22,
              }}
            >
              Front Labels Say &ldquo;Natural.&rdquo; Back Labels Hide the Truth.
            </h2>
            <p
              style={{
                fontSize: 13,
                color: "#4b5563",
                margin: "0 0 12px",
                lineHeight: 1.4,
              }}
            >
              HeyBroc reads the fine print instantly so clean family meals take seconds, not hours:
            </p>

            {/* Clean Side-by-Side Before vs. After Visual */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  background: "#fff5f5",
                  border: "1.5px solid #fca5a5",
                  borderRadius: 16,
                  padding: "11px 12px",
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
                    marginBottom: 5,
                  }}
                >
                  ✕ 18/100 · Poor
                </div>
                <div style={{ fontSize: 13, fontWeight: 800, color: "#111814" }}>
                  &ldquo;Natural&rdquo; Store Pick
                </div>
                <div style={{ fontSize: 11.5, color: "#991b1b", marginTop: 3, lineHeight: 1.3 }}>
                  Soybean oil, corn syrup &amp; Red 40.
                </div>
              </div>

              <div
                style={{
                  background: "#f0fdf4",
                  border: "1.5px solid #86efac",
                  borderRadius: 16,
                  padding: "11px 12px",
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
                    marginBottom: 5,
                  }}
                >
                  ✓ 95/100 · Clean
                </div>
                <div style={{ fontSize: 13, fontWeight: 800, color: "#111814" }}>
                  1-Tap Clean Swap
                </div>
                <div style={{ fontSize: 11.5, color: "#166534", marginTop: 3, lineHeight: 1.3 }}>
                  Real organic ingredients at {storeDisplayName}.
                </div>
              </div>
            </div>

            {/* Compact Watchlist Chips */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginBottom: 14,
              }}
            >
              {displayGoalItems.slice(0, 3).map((g) => (
                <span
                  key={g.id}
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    background: "#fef2f2",
                    color: "#991b1b",
                    border: "1px solid #fecaca",
                    borderRadius: 999,
                    padding: "4px 10px",
                  }}
                >
                  {g.icon} No {g.title}
                </span>
              ))}
            </div>

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
              See How HeyBroc Solves This →
            </button>
          </>
        )}

        {/* ==================== STEP 6: LIVE 1-SECOND DEMO (CONCISE) ==================== */}
        {step === 6 && (
          <>
            <h2
              id="heybroc-onboarding-heading"
              style={{
                fontSize: 21.5,
                fontWeight: 800,
                color: "#111814",
                margin: "0 0 4px",
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
                lineHeight: 1.4,
              }}
            >
              Tap a staple below to preview an instant <b>Clean Swap</b>:
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
                  {activeSample.dirtyScore}/100
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: "#7f1d1d", marginTop: 2 }}>
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
                  {activeSample.cleanScore}/100
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: "#166534", marginTop: 2 }}>
                {activeSample.cleanPerks}
              </div>
            </div>

            {/* Ultra-Short 2-Chip Feature Summary */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
              <div
                style={{
                  padding: "10px 11px",
                  borderRadius: 14,
                  background: "#f8fafc",
                  border: "1.5px solid #e2e8f0",
                }}
              >
                <div style={{ fontSize: 12.5, fontWeight: 800, color: "#111814" }}>
                  📷 Free Barcode &amp; Search
                </div>
                <div style={{ fontSize: 11.5, color: "#4b5563", marginTop: 2 }}>
                  0–100 scores on 1.5M+ foods.
                </div>
              </div>

              <div
                style={{
                  padding: "10px 11px",
                  borderRadius: 14,
                  background: "#f0fdf4",
                  border: "1.5px solid #bbf7d0",
                }}
              >
                <div style={{ fontSize: 12.5, fontWeight: 800, color: "#14532d" }}>
                  🟢 Live Store Bubble
                </div>
                <div style={{ fontSize: 11.5, color: "#166534", marginTop: 2 }}>
                  Auto-grades &amp; swaps your cart.
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
              Build My Personalized Plan →
            </button>
          </>
        )}

        {/* ==================== STEP 7: PERSONALIZED PLAN (FREEMIUM + PRO TRIAL) ==================== */}
        {step === 7 && (
          <>
            <div
              style={{
                background: "#ecfdf5",
                border: "1.5px solid #6ee7b7",
                borderRadius: 14,
                padding: "9px 12px",
                marginBottom: 12,
                display: "flex",
                alignItems: "center",
                gap: 9,
              }}
            >
              <span style={{ fontSize: 18 }}>✅</span>
              <div style={{ fontSize: 12, color: "#065f46", lineHeight: 1.35 }}>
                <b>Ready:</b> {householdSummaryLabel} · <b>{storesSummaryLabel}</b> ·{" "}
                <b>{selected.length}</b> {selected.length === 1 ? "goal" : "goals"}
                {dietarySelected.length > 0
                  ? ` · ${dietarySelected.length} ${dietarySelected.length === 1 ? "alert" : "alerts"}`
                  : ""}
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
                    🎁 <b>Friend Invite ({appliedCreator.code}) Applied:</b>{" "}
                    <b>{PRICING.trialDays}-Day Free Trial</b> +{" "}
                    <b>+{PRICING.referralBonusDays} Free Pro Days</b> for both of you!
                  </>
                ) : (
                  <>
                    🎉 <b>Creator Code {appliedCreator.code} Applied:</b> {appliedCreator.name} unlocked your{" "}
                    <b>VIP {PRICING.trialDays}-Day Free Pro Trial ($0 Today)!</b>
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
                lineHeight: 1.4,
              }}
            >
              Unlock unlimited 1-tap Clean Swaps with a <b>{effectiveTrialDays}-Day Free Pro Trial ($0 today)</b>, or start on the Free Plan ({PRICING.freeWeeklySwaps} free Clean Swaps included):
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
                  <b>Unlimited 1-Tap Clean Swaps</b> across{" "}
                  {selectedStores.length > 0
                    ? `${storesSummaryLabel} & all 12+ stores`
                    : "all 12+ grocery & delivery stores"}
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
                    householdProfiles: extras.householdProfiles,
                    store: extras.store,
                    stores: extras.stores,
                    storesCount: selectedStores.length,
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
                    householdProfiles: extras.householdProfiles,
                    store: extras.store,
                    stores: extras.stores,
                    storesCount: selectedStores.length,
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
                Continue with Free Plan ({PRICING.freeWeeklySwaps} Free Swaps Included) →
              </button>

              <button
                type="button"
                onClick={() => {
                  const extras = buildExtras();
                  trackOnboardingEvent("onboarding_completed", {
                    exitAction: "signin",
                    householdProfile: extras.householdProfile,
                    householdProfiles: extras.householdProfiles,
                    store: extras.store,
                    stores: extras.stores,
                    storesCount: selectedStores.length,
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

