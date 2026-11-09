import type { LookupInput, LookupResult } from "./lookup";
import { hasConflictingBrand, passesVariantGuard } from "./drinks-catalog";
export { SUPPLEMENT_FORM } from "./nutrition";

const BASE = "https://api.ods.od.nih.gov/dsld/v9";
export const SUPPLEMENT_QUERY = /\b(supplement|pre[- ]?workout|protein\s+(?:powder|isolate)|whey|creatine|collagen|electrolyte|greens\s+powder|gummy\s+vitamins?|multivitamin|ghost\s+legend|c4\s+(?:original|ultimate)|total\s+war|lmnt|liquid\s+i\.?v\.?)\b/i;
interface IngredientRow { name?: string; nestedRows?: IngredientRow[] }
export interface DsldLabel {
  id?: number;
  fullName?: string;
  brandName?: string;
  upcSku?: string;
  offMarket?: number;
  entryDate?: string;
  ingredientRows?: IngredientRow[];
  otheringredients?: { text?: string | null; ingredients?: IngredientRow[] };
}

const words = (s: string) => s.toLowerCase().replace(/pre[- ]?workout/g, " ").replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(w => w && !/^(powder|supplement|dietary|flavored|flavour|flavor|servings?|oz|g|pack)$/.test(w) && !/^\d+$/.test(w));
const barcodeKey = (s = "") => s.replace(/\D/g, "").replace(/^0+(?=\d)/, "");

/** Unspecified flavors/lines must not select an arbitrary NIH label. */
export function matchesDsldLabel(input: LookupInput, label: DsldLabel): boolean {
  if (label.offMarket !== 0 || !label.fullName || !label.brandName) return false;
  if (input.barcode) return Boolean(label.upcSku) && barcodeKey(input.barcode) === barcodeKey(label.upcSku);
  const query = input.productTitle || "";
  const title = `${label.brandName} ${label.fullName}`;
  if (!passesVariantGuard(query, title) || hasConflictingBrand(query, title)) return false;
  const q = new Set(words(query));
  const brand = new Set(words(label.brandName));
  const name = words(label.fullName);
  const all = new Set([...brand, ...name]);
  return q.size >= 2 && [...q].every(w => all.has(w)) && name.every(w => q.has(w) || brand.has(w));
}

export function dsldLabelResult(input: LookupInput, label: DsldLabel): Omit<LookupResult, "ms"> | null {
  if (!Number.isInteger(label.id) || !matchesDsldLabel(input, label)) return null;
  const other = label.otheringredients;
  const inactive = other?.text?.trim() || other?.ingredients?.map(r => r.name?.trim()).filter(Boolean).join(", ");
  // Without a complete other-ingredients panel, do not imply additive absence.
  if (!inactive || !label.ingredientRows?.length) return null;
  const active: string[] = [];
  const walk = (rows: IngredientRow[]) => rows.forEach(r => {
    if (r.name && !/^(calories|total carbohydrates?|total sugars?|added sugars?|total fat|dietary fiber)$/i.test(r.name)) active.push(r.name);
    if (r.nestedRows) walk(r.nestedRows);
  });
  walk(label.ingredientRows);
  if (!active.length) return null;
  return {
    productTitle: `${label.brandName} ${label.fullName}`,
    brand: label.brandName,
    barcode: label.upcSku?.replace(/\D/g, ""),
    ingredients: `${active.join(", ")}. Other ingredients: ${inactive}`,
    nutrition: { productKind: "supplement", isOrganic: false },
    source: "dsld",
    sourceUrl: `https://dsld.od.nih.gov/label/${label.id}`,
    sourceUpdatedAt: label.entryDate || null,
    description: "NIH DSLD label record; verify the current package and Supplement Facts panel. Ingredient-only score; no assessment of dose, interactions or efficacy.",
  };
}

export async function lookupDsld(input: LookupInput, json: <T>(url: string) => Promise<T | null>): Promise<Omit<LookupResult, "ms"> | null> {
  if (!input.barcode && !SUPPLEMENT_QUERY.test(input.productTitle || "")) return null;
  const digits = (input.barcode || "").replace(/\D/g, "");
  if (input.barcode && !/^\d{8,14}$/.test(digits)) return null;
  const upc = digits.length === 13 && digits.startsWith("0") ? digits.slice(1) : digits;
  // NIH indexes UPCs in label typography (1-5-5-1), not consistently as joined digits.
  const q = input.barcode ? (upc.length === 12 ? `"${upc[0]} ${upc.slice(1, 6)} ${upc.slice(6, 11)} ${upc[11]}"` : `"${upc}"`) : input.productTitle!;
  const res = await json<{ hits?: Array<{ _id?: string; _source?: DsldLabel }> }>(`${BASE}/search-filter?q=${encodeURIComponent(q)}&status=1&size=8`);
  const hits = (res?.hits || []).filter(h => h._id && /^\d+$/.test(h._id) && (input.barcode || (h._source && matchesDsldLabel(input, h._source)))).slice(0, 2);
  const records = await Promise.all(hits.map(h => json<DsldLabel>(`${BASE}/label/${h._id}`)));
  for (const record of records) {
    if (!record) continue;
    const match = dsldLabelResult(input, record);
    if (match) return match;
  }
  return null;
}
