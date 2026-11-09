/**
 * NODE_OPTIONS=--conditions=react-server npx tsx scripts/audit-ingredient-catalog.ts
 *
 * Static inventory, not a claim that a source URL proves a current package label.
 * JSON on stdout makes every included formulation and its remaining evidence gap reviewable.
 */
import { DRINKS_CATALOG, hasValidCatalogProvenance } from "../lib/drinks-catalog";
import { INSTANT_GROCERY_CATALOG, CATEGORY_FALLBACK_CATALOG } from "../lib/lookup";
import { scoreIngredients, scoreProductYuka, RUBRIC_VERSION, type NutritionInput } from "../lib/rubric";
import { CLEAN_ALTERNATIVES, EXACT_PRODUCT_ALTERNATIVES } from "../lib/swaps";
import { SEO_PRODUCTS } from "../lib/seo-catalog";

type Entry = { title: string; brand: string; ingredients: string; nutrition?: NutritionInput; sourceUrl?: string; verifiedAt?: string };
const checkedSources = new Set([
  "https://www.marysgonecrackers.com/products/marys-gone-crackers-original-crackers",
  "https://simplemills.com/Products/Product/Crunchy-Chocolate-Chip-Cookies.aspx",
  "https://www.stokbrew.com/cold-brew/cold-brew-coffee/unsweetened-cold-brew-coffee-48oz/",
  "https://www.stonyfield.com/products/whole-milk-smooth-creamy-plain-32oz/",
  "https://www.applegate.com/products/organic-roasted-turkey-breast",
  "https://www.foodforlife.com/product/breads/ezekiel-49-sprouted-whole-grain-bread",
  "https://www.larabar.com/our-products/larabar/cashew-cookie",
  "https://www.organicvalley.coop/products/grassmilk-whole-milk",
  "https://drinkspindrift.com/products/raspberry-lime-sparkling-water",
]);
const entries: object[] = [];
function add(catalog: string, entry: Entry, always = false) {
  const result = scoreProductYuka(entry.ingredients, {}, [], { ...entry.nutrition, productTitle: entry.title });
  if (!always && result.score < 75) return;
  entries.push({
    catalog, title: entry.title, brand: entry.brand, ingredients: entry.ingredients, nutrition: entry.nutrition,
    sourceUrl: entry.sourceUrl, verifiedAt: entry.verifiedAt,
    score: result.score, ingredientScore: scoreIngredients(entry.ingredients).score,
    flags: result.flagged.map(f => f.id), scoringBasis: result.scoringBasis || "three-pillar",
    hasPooledVariants: /\([^)]*,[^)]*\)/.test(entry.title),
    provenanceMetadataValid: hasValidCatalogProvenance(entry.sourceUrl, entry.verifiedAt),
    evidence: checkedSources.has(entry.sourceUrl || "") && entry.verifiedAt === "2026-11-09"
      ? "Manufacturer ingredient panel checked on 2026-11-09"
      : "Current manufacturer package label not independently reverified in this audit",
  });
}
DRINKS_CATALOG.forEach(e => add("DRINKS_CATALOG", e));
INSTANT_GROCERY_CATALOG.forEach(e => add("INSTANT_GROCERY_CATALOG", e));
CATEGORY_FALLBACK_CATALOG.forEach(e => add("CATEGORY_FALLBACK_CATALOG", { ...e, title: e.brand }));
SEO_PRODUCTS.forEach(e => add("SEO_PRODUCTS", e));
const seen = new Set<string>();
for (const a of [...Object.values(CLEAN_ALTERNATIVES), ...EXACT_PRODUCT_ALTERNATIVES.map(e => e.alt)]) {
  const title = a.brand + " " + a.name;
  if (seen.has(title)) continue;
  seen.add(title);
  add("CLEAN_ALTERNATIVES + EXACT_PRODUCT_ALTERNATIVES", {
    title, brand: a.brand, ingredients: a.ingredients, sourceUrl: a.sourceUrl, verifiedAt: a.verifiedAt,
    nutrition: { ...a.nutrition, isOrganic: a.nutrition?.isOrganic ?? a.isOrganic === true },
  }, true);
}
console.log(JSON.stringify({
  auditedAt: new Date().toISOString().slice(0, 10), rubricVersion: RUBRIC_VERSION,
  rowsEvaluated: { drinks: DRINKS_CATALOG.length, instant: INSTANT_GROCERY_CATALOG.length, categoryFallbacks: CATEGORY_FALLBACK_CATALOG.length, seo: SEO_PRODUCTS.length, distinctSwaps: seen.size },
  entries,
}, null, 2));
