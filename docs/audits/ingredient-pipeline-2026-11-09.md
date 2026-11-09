**Ingredient lookup and clean-label grading audit — 2026-11-09**

Implemented against main, incorporating concurrent commits f13de56, 38cb4bc and cb2b22a. Rubric version: 1.1.0.

The pipeline fixes below are covered by deterministic runtime regressions and the production build. This is **not a sign-off that every stored recipe matches a current manufacturer package**. The inventory identifies the remaining evidence gaps explicitly.

**Coverage and evidence**

All 191 beverage records, 147 instant grocery records, 27 category fallback records, 25 SEO records, and 78 distinct swap formulations were evaluated with the rubric. The accompanying [JSON inventory](ingredient-catalog-2026-11-09.json) contains all 78 swaps and the static records scoring at least 75: 168 records total. No SEO product scored at least 75.

Nine retained manufacturer ingredient panels were checked directly, covering 12 inventory records. Labels, serving sizes, ingredients, organic assertions, and measured nutrition were corrected where the checked sources supported them. Other records are identified as not independently reverified; a syntactically valid source URL and date do not prove a label is correct.

**Fixed defects**

| Severity | Finding and reproduction | Change / regression evidence |
| --- | --- | --- |
| High | OFF extraction guessed sodium units from numeric magnitude. A sodium_100g value of 12 could become 12mg instead of 12,000mg; salt_100g of 100 could become 40mg instead of 40,000mg sodium. | lib/nutrition.ts:33 applies OFF schema units consistently: sodium grams × 1,000, salt grams × 400. Zero is preserved. Fixtures cover both cases, kcal preference and kJ conversion. |
| High | USDA extraction omitted fiber/protein and used nutrient-name substring searches, including an unsafe generic Energy match. Foundation/SR foods without ingredient strings were discarded. | lib/nutrition.ts:77 maps IDs and legacy nutrient numbers, flat search values and nested detail amounts, kcal/kJ, grams/mg. Branded search values remain per 100g without a second serving-size conversion. lib/lookup.ts:683 supports identifiable plain Foundation/SR foods; FVN=100 for produce/nuts/seeds and FVN=0 for animal foods/grains/oil. |
| High | Several successive upstream timeouts could accumulate. Supplement and non-food vertical records could receive food nutrition scoring. | lib/lookup.ts:516 races validated OFF/USDA/NIH candidates within one 1,800ms deadline and aborts losers. lib/lookup.ts:461 retains Beauty/Products/Pet Food sources and classifies them as non-food. lib/rubric.ts:905 scores supplements on ingredients only, without a food nutrition breakdown. |
| High | A fabricated Simple Mills cheddar recipe omitted sunflower oil and asserted organic certification. SToK omitted natural flavor; its swap claimed organic certification. | lib/swaps.ts:509 uses the sourced Mary's original cracker alternative. SToK now includes natural flavor and explicitly has isOrganic=false in both catalogs and swaps. Manufacturer sources are linked below. |
| High | Milk percentages, plain formulations, plant-based products and specific flavors could borrow another formulation. The OWYN Pro Elite title did not specify Vanilla; pooled Orgain titles listed Chocolate and Vanilla against one recipe. | lib/drinks-catalog.ts:5339 adds milk-percent/plain/plant/flavor checks. Pooled flavor titles cannot substantiate a requested flavor. OWYN Pro Elite Vanilla now returns no static match. Live candidates and autocomplete use the same guard. Tests include Vanilla vs Chocolate, pooled Orgain, 2% vs whole milk and Spindrift Lemon vs Raspberry Lime. |
| High | A Spindrift Raspberry Lime source was attached to a pooled Lemon/Raspberry/Strawberry title and a lemon-juice recipe. | Drink and swap records now identify Raspberry Lime, contain lime juice, and use the manufacturer's 5kcal/1g sugar per 355ml and 3% juice values. |
| Medium | Citric acid was always flagged as a synthetic additive; plain celery juice/powder was treated as a meat-curing nitrate source. | lib/rubric.ts:588 removes the citric-acid penalty and requires curing/meat context for the celery rule. The curing case remains detected. Tests cover requested fortifiers, culinary oils, cultures, vinegars, natural sugars, and hidden soybean/canola oils alongside olive oil. |
| Medium | Missing OFF positive nutrients lost points; generic estimates could credit an unsupported 65% produce content. Old normalized cache values could survive a unit correction. | lib/rubric.ts:871 fills missing positive fields only, preserves measured zeroes and baseline measurements, marks inferred fields and defaults unknown produce percentages conservatively. lib/lookup.ts:77 rejects old normalized cache entries using schema version 2. Generic whole-food fallbacks no longer emit invented measured macros. |
| Medium | Simulator rescoring discarded measured swap nutrition. Retailer links shortened exact products into generic searches. | components/Simulator.tsx:123 and lib/swaps.ts:1362 preserve alternative nutrition. lib/swaps.ts:1220 retains brand/product/variant in retailer searches. Mary's checked panel has 150kcal, 180mg sodium, 3g fiber and 4g protein per 30g; ingredient score 100 and combined score 68 replace the unsupported A/90–100 assumption. |
| Medium | A dietary-specific request could recommend wheat bread for gluten-free bread, whole milk for skim milk, or non-lactose-free milk for Lactaid. | lib/swaps.ts:1340 preserves explicit dietary/formulation restrictions or returns no swap. Tests cover gluten-free bread, skim milk, Lactaid and vegan ranch. Named alternatives may still transparently offer another flavor/protein amount. |
| Medium | Other checked recipes were stale/incomplete, while real certified organic references missed the bonus. | Applegate turkey now includes its potato starch/chicken broth/rosemary formulation. Mary's tamari and measured nutrients were corrected. Simple Mills cookies retain their actual cane-sugar chocolate chips/full ingredients. Food For Life and Mary's get explicit organic metadata supported by product pages. Stonyfield, LÄRABAR and Organic Valley milk use checked serving conversions. |

**API integrations and latency**

| Provider | Runtime behavior |
| --- | --- |
| USDA FDC | Branded plus parallel Foundation,SR Legacy queries for conservative store-trimmed whole-food queries. Preserves species/preparation: rejects cod or cooked salmon for raw Atlantic salmon. A missing/blank USDA_API_KEY uses public DEMO_KEY; a dedicated key increases available quota. A live Foundation,SR Legacy query succeeded. An attempted query including Survey (FNDDS) returned HTTP 400. Survey/FNDDS nutrient records are supported by the normalizer but excluded from that query. |
| NIH DSLD v9 | New no-auth lookup for supplement keywords/barcodes. Uses search-filter followed by at most two label details. Requires active-market status, strict product/flavor or exact normalized UPC identity, active ingredient rows and a nonempty other-ingredients panel. Extracts actives and excipients, including dyes, sucralose and Ace-K. Handles NIH's spaced UPC typography. |
| Open Beauty / Products / Pet Food Facts | Existing vertical lookups retain actual provenance and explicit non-food classification. Exact barcode identity replaces unsafe trailing-digit GTIN truncation. Personal-care records receive nutritionScore=0 / Nutri-Score=N/A, including generic names without cosmetic keywords. |
| OFF | Preserves main's v0 fallback, US-market ranking and sequential detail fetches. Raw barcode responses have a bounded 24-hour cache; a 429 does not globally black out unrelated barcodes. Only the supplied barcode form is requested per host, reducing duplicate requests. Missing positives can be inferred without replacing provider numbers. |

Each upstream request and the whole network phase share a maximum 1,800ms budget. OFF search/detail and NIH search/detail therefore share that deadline. Screen ingredients and cache hits skip network requests. Cache filesystem I/O and local scoring occur outside the network budget; this is not a measured production p95 guarantee.

NIH labels are archived submissions; some active-market records have entry dates years in the past. Responses include the label URL/date and identify ingredient-only scoring without dose, interaction or efficacy assessment. Public matches cannot establish 100% accuracy of a shopper's current package. Simulator provenance labels and the privacy processor list include the added providers.

**Remaining findings**

| Severity | Evidence | Remaining work |
| --- | --- | --- |
| Medium | **69 of 78 distinct swap formulations lack fresh provenance metadata.** Reproduce using the inventory command below; filter provenanceMetadataValid=false. Records begin at lib/swaps.ts:111 and the exact-product table. Their current panels were not independently substantiated in this audit. | Obtain each exact current US panel, certification evidence where relevant, source URL and actual verification date. Do not stamp verification dates from a passing score. This evidence gap does not prove every unsourced recipe is wrong. |
| Medium | Nine high-scoring beverage records still pool same-brand flavors: Clean Cause, Orgain, OLIPOP, Nixie, Waterloo, Bubly, LaCroix, Bai and BodyArmor Lyte. The inventory marks hasPooledVariants=true. Explicit flavor requests now fail closed, but broad brand-only queries/suggestions can expose pooled records. | Replace each with independently sourced single-flavor entries. Aggregate recipes are not certified accurate for every listed flavor. |
| Low | Positive nutrient inference is category-based when providers omit fields. It is marked in nutrition.inferredPositiveFields and preserves verified zeroes, but is not a measured panel. | Prefer measured panels as coverage improves; keep inferred fields distinguishable downstream. Existing broad category estimates remain part of the editorial nutrition model. |

**Manufacturer evidence checked on 2026-11-09**

- [Mary's Original](https://www.marysgonecrackers.com/products/marys-gone-crackers-original-crackers) and its linked [Nutrition Facts image](https://cdn.shopify.com/s/files/1/0768/8742/5319/files/ORIGINAL_NFP.png?v=1764080147).
- [Simple Mills cheddar crackers](https://simplemills.com/Products/Product/Farmhouse-Cheddar-Almond-Flour-Crackers.aspx): confirms sunflower oil and disproves the removed recipe.
- [Simple Mills chocolate chip cookies](https://simplemills.com/Products/Product/Crunchy-Chocolate-Chip-Cookies.aspx).
- [SToK Unsweetened](https://www.stokbrew.com/cold-brew/cold-brew-coffee/unsweetened-cold-brew-coffee-48oz/).
- [Stonyfield Whole Milk Plain](https://www.stonyfield.com/products/whole-milk-smooth-creamy-plain-32oz/).
- [Applegate Organic Roasted Turkey](https://www.applegate.com/products/organic-roasted-turkey-breast).
- [Food For Life Ezekiel 4:9](https://www.foodforlife.com/product/breads/ezekiel-49-sprouted-whole-grain-bread).
- [LÄRABAR Cashew Cookie](https://www.larabar.com/our-products/larabar/cashew-cookie).
- [Organic Valley Whole Grassmilk](https://www.organicvalley.coop/products/grassmilk-whole-milk).
- [Spindrift Raspberry Lime](https://drinkspindrift.com/products/raspberry-lime-sparkling-water).

Nine retained formulations were checked; the removed cheddar candidate is an additional manufacturer comparison.

**Provider schema / live response checks**

- [USDA Branded documentation](https://fdc.nal.usda.gov/GBFPD_Documentation/): nutrient values normalized to 100g.
- [USDA API guide](https://fdc.nal.usda.gov/api-guide/) and live foods/search using DEMO_KEY.
- [OFF field definitions](https://github.com/openfoodfacts/openfoodfacts-server/blob/main/html/data-fields.txt).
- [NIH DSLD API guide](https://dsld.od.nih.gov/api-guide), live search-filter, and [label 249498](https://api.ods.od.nih.gov/dsld/v9/label/249498). Off-market label 82118 was rejected during evaluation.

**Verification**

Final merged-tree results:

| Gate | Exit status |
| --- | --- |
| npm run typecheck | 0 |
| npm run test:rubric | 0 — 465 checks |
| npm run build | 0 |

~~~sh
npm run typecheck
npm run test:rubric
npm run build
NODE_OPTIONS=--conditions=react-server npx tsx scripts/audit-ingredient-catalog.ts
~~~

The regressions cover clean ingredient traps, hidden seed oils, USDA IDs/numbers/units, OFF energy/salt/sodium, measured zeroes, missing positives, product-level organic labels, species/preparation, flavor/percent/dietary guards, NIH archives/excipients/UPCs, non-food barcodes, API provenance, OFF 429/v0 fallback, and cancellation of hung upstream calls.
