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
  "https://www.stonyfield.com/products/whole-milk-smooth-creamy-plain-32oz/",
  "https://www.marysgonecrackers.com/products/marys-gone-crackers-original-crackers",
  "https://www.naturespath.com/en-us/products/natures-path-foods/heritage-flakes/",
  "https://www.applegate.com/products/organic-roasted-turkey-breast",
  "https://www.utzsnacks.com/products/boulder-canyon-kettle-cooked-potato-chips-avocado-oil-classic-sea-salt",
  "https://www.organicvalley.coop/products/butter/salted-butter/salted-butter-1-lb-4-quarters/",
  "https://www.foodforlife.com/product/breads/ezekiel-49-sprouted-whole-grain-bread",
  "https://www.primalkitchen.com/products/ranch-dressing",
  "https://www.larabar.com/our-products/larabar/cashew-cookie",
  "https://www.organicvalley.coop/products/butter/unsalted-butter/unsalted-butter-1-lb-4-quarters/",
  "https://orgain.com/products/organic-grass-fed-clean-protein-shake",
  "https://www.organicvalley.coop/products/milk/grassmilk/grassmilk-lowfat-chocolate-half-gallon/",
  "https://malkorganics.com/products/unsweetened-oat-malk/",
  "https://malkorganics.com/products/unsweetened-almond-malk/",
  "https://www.organicvalley.coop/products/milk/grassmilk/grassmilk-2-half-gallon/",
  "https://www.organicvalley.coop/products/grassmilk-whole-milk",
  "https://www.organicvalley.coop/products/cream/sweet-cream-creamer/",
  "https://www.organicvalley.coop/products/cream/heavy-whipping-cream/heavy-whipping-cream-pint/",
  "https://www.organicvalley.coop/products/cream/half-half/half-half-quart/",
  "https://www.organicvalley.coop/products/sour-cream/sour-cream/sour-cream-16-oz/",
  "https://goodculture.com/organic-whole-milk-classic/",
  "https://www.organicvalley.coop/products/cheese/cream-cheese/cream-cheese-8-oz/",
  "https://www.organicvalley.coop/products/cheese/stringles/mozzarella-stringles-6-oz/",
  "https://www.organicvalley.coop/products/cheese/cheddar/raw-sharp-cheddar-8-oz/",
  "https://www.organicvalley.coop/products/eggnog/eggnog/eggnog-quart/",
  "https://vitalfarms.com/pasture-raised-organic-eggs/",
  "https://www.alecsicecream.com/products/tahitian-vanilla-bean",
  "https://artisanaorganics.com/products/hazelnut-cacao-spread",
  "https://www.onceagainnutbutter.com/products/organic-sunflower-seed-butter-unsweetened-salt-free",
  "https://artisanaorganics.com/products/raw-almond-butter",
  "https://www.santacruzorganic.com/products/peanut-butter/creamy-dark-roasted-peanut-butter",
  "https://croftersorganic.com/product/strawberry-just-fruit-spread/",
  "https://www.annies.com/products/organic-honey-graham-crackers",
  "https://fdc.nal.usda.gov/food-details/170026/nutrients",
  "https://fdc.nal.usda.gov/food-details/170000/nutrients",
  "https://sietefoods.com/products/sea-salt-grain-free-tortilla-chips",
  "https://lesserevil.com/products/interstellar-cheddar-space-balls",
  "https://quinnsnacks.com/products/classic-sea-salt-pretzel-twists",
  "https://lesserevil.com/products/himalayan-pink-salt-organic-popcorn",
  "https://onedegreeorganics.com/products/organic-sprouted-rolled-oats-us/",
  "https://purelyelizabeth.com/products/original-ancient-grain-granola",
  "https://www.crownmaple.com/amber-color-rich-taste-organic-maple-syrup/",
  "https://www.lotusfoods.com/products/organic-millet-brown-rice-ramen-4-pack",
  "https://www.amys.com/our-foods/organic-lentil-vegetable-soup-low-fat",
  "https://www.eatwholly.com/products/wholly-guacamole/organic-classic-guacamole/",
  "https://hopefoods.com/products/original-recipe-hummus",
  "https://www.kettleandfire.com/products/turkey-bone-broth",
  "https://www.primalkitchen.com/products/avocado-oil-mayo",
  "https://www.primalkitchen.com/products/organic-unsweetened-ketchup",
  "https://www.annies.com/products/organic-yellow-mustard",
  "https://www.bubbies.com/products/prepared-horseradish",
  "https://www.primalkitchen.com/products/classic-bbq-sauce",
  "https://www.raos.com/products/marinara-sauce",
  "https://mateossalsa.com/products/medium-gourmet-salsa",
  "https://applegate.com/products/organic-no-sugar-bacon",
  "https://applegate.com/products/the-great-organic-uncured-beef-hot-dog",
  "https://applegate.com/products/organic-chicken-and-maple-breakfast-sausage",
  "https://applegate.com/products/organic-gluten-free-chicken-nuggets",
  "https://applegate.com/products/organic-uncured-black-forest-ham",
  "https://applegate.com/products/organic-uncured-genoa-salami",
  "https://applegate.com/products/organic-uncured-roast-beef",
  "https://www.annies.com/product/organic-grass-fed-shells-real-aged-cheddar-mac-cheese",
  "https://sietefoods.com/products/almond-flour-tortillas",
  "https://www.daveskillerbread.com/plain-awesome-bagels",
  "https://www.daveskillerbread.com/21-whole-grains-and-seeds-buns",
  "https://www.naturespath.com/en-us/products/natures-path-foods/buckwheat-wildberry-waffles/",
  "https://jovialfoods.com/100-organic-einkorn-spaghetti/",
  "https://www.amys.com/our-foods/margherita-pizza",
  "https://simplemills.com/Products/Product/Crunchy-Chocolate-Chip-Cookies.aspx",
  "https://www.thatsitfruit.com/products/apple-strawberry",
  "https://hukitchen.com/products/simple-dark-chocolate",
  "https://www.ora.organic/products/organic-pre-workout-powder",
  "https://guayaki.com/products/unsweetened-traditional-terere",
  "https://yerbamadre.com/products/enlightenmint",
  "https://drinkspindrift.com/products/raspberry-lime-sparkling-water",
  "https://drinkolipop.com/products/vintage-cola",
  "https://drinknooma.com/products/mango-organic-electrolyte-drink",
  "https://www.stokbrew.com/cold-brew/cold-brew-coffee/unsweetened-cold-brew-coffee-48oz/",
  "https://itoen.com/products/oi-ocha-unsweetened-green-tea",
  "https://www.daveskillerbread.com/21-whole-grains-and-seeds",
  "https://www.rxbar.com/en_US/shop/protein-bars/chocolate-sea-salt-box-of-12.html",
  "https://fairlife.com/core-power-elite/chocolate-42g-protein-shake/",
  "https://fairlife.com/core-power/chocolate-protein-shake/",
  "https://www.premierprotein.com/products/chocolate-shake",
  "https://www.goodnes.com/nesquik/products/chocolate-lowfat-milk-14-fl-oz-bottle/",
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
