**Ingredient lookup and clean-label grading audit — 2026-11-09**

Implemented against `main` (`5349ab8`), unifying all pipeline, rubric, variant-guard, and catalog sign-off fixes. Rubric version: `1.1.0`.

All pipeline and catalog fixes below are covered by 473 deterministic runtime regression checks, full TypeScript verification, and the production build.

**Coverage and evidence**

All 192 beverage records, 147 instant grocery records, 27 category fallback records, 25 SEO records, and 78 distinct swap formulations were evaluated with the rubric. The accompanying [JSON inventory](ingredient-catalog-2026-11-09.json) contains all 78 swaps and the static records scoring at least 75: 167 records total (`hasPooledVariants: 0`, `provenanceMetadataValid: true` across 167/167 records). No SEO product scored at least 75.

All 78 swap formulations in `CLEAN_ALTERNATIVES` and `EXACT_PRODUCT_ALTERNATIVES` carry verified `{ sourceUrl, verifiedAt: "2026-11-09" }` provenance metadata and per-100g nutrition aligned with their US manufacturer labels, and all 37 previously pooled multi-flavor beverage titles in `DRINKS_CATALOG` have been un-pooled into single-flavor formulations.

**Fixed defects**

| Severity | Finding and reproduction | Change / regression evidence |
| --- | --- | --- |
| High | OFF extraction guessed sodium units from numeric magnitude. A `sodium_100g` value of 12 could become 12mg instead of 12,000mg; `salt_100g` of 100 could become 40mg instead of 40,000mg sodium. | `lib/nutrition.ts:33` applies OFF schema units consistently: sodium grams × 1,000, salt grams × 400. Zero is preserved. Fixtures cover both cases, kcal preference and kJ conversion. |
| High | USDA extraction omitted fiber/protein and used nutrient-name substring searches, including an unsafe generic Energy match. Foundation/SR foods without ingredient strings were discarded. | `lib/nutrition.ts:77` maps IDs and legacy nutrient numbers, flat search values and nested detail amounts, kcal/kJ, grams/mg. Branded search values remain per 100g without a second serving-size conversion. `lib/lookup.ts:683` supports identifiable plain Foundation/SR foods; FVN=100 for produce/nuts/seeds and FVN=0 for animal foods/grains/oil. |
| High | Several successive upstream timeouts could accumulate. Supplement and non-food vertical records could receive food nutrition scoring. | `lib/lookup.ts:516` races validated OFF/USDA/NIH candidates within one 1,800ms deadline and aborts losers. `lib/lookup.ts:461` retains Beauty/Products/Pet Food sources and classifies them as non-food. `lib/rubric.ts` scores supplements on ingredients only, without a food nutrition breakdown. |
| High | A fabricated Simple Mills cheddar recipe omitted sunflower oil and asserted organic certification. SToK omitted natural flavor; its swap claimed organic certification. | `lib/swaps.ts` uses the sourced Mary's original cracker alternative. SToK now includes natural flavor and explicitly has `isOrganic=false` in both catalogs and swaps. |
| High | Guayakí / Yerba Madre Enlighten Mint was listed with 0g sugar and no cane sugar (`100/100`), whereas the US 15.5 fl oz can contains `Organic Cane Sugar` as its second ingredient (`28g` added sugar / `120 kcal`). Meanwhile `lib/swaps.ts` referenced a fabricated `"Guayakí Organic Yerba Mate Unsweetened Clean Energy Tea"` product. | `lib/drinks-catalog.ts` updates `guayaki-organic-yerba-mate` (`Enlighten Mint`) to its true 28g cane-sugar recipe (`sugarsG100g: 6.1`, `caloriesKcal100g: 26.2`, capped at `49/100`), adds `guayaki-unsweetened-traditional-terere` (`0g` sugar, `100/100`), and updates `lib/swaps.ts` to recommend **Guayakí Organic Yerba Mate Unsweetened Traditional Tereré**. |
| High | Annie's Organic Grass-Fed Shells & Real Aged Cheddar lacked measured per-100g nutrition in `lib/swaps.ts` / `lib/lookup.ts`, and `"Organic Butter"` inside its ingredients falsely triggered `isPureButterOrGhee`, inflating its score vs. live USDA. | Added US label nutrition (`357 kcal`, `5.7g` sugar, `4.3g` sat fat, `700mg` sodium, `2.9g` fiber, `14.3g` protein per 100g) and exact ingredients (including `Sodium Phosphate`) to `lib/swaps.ts` and `lib/lookup.ts`, and excluded composite foods (`pasta`, `macaroni`, `shells`, `cheese`, `cheddar`, `crackers`, `bread`, etc.) from `isPureButterOrGhee` so both USDA and catalog lookups score `53/100` (`Mediocre`). |
| High | Milk percentages, plain formulations, plant-based products, unsweetened/zero-sugar formulations, and specific flavors could borrow another formulation. Pooled titles in `DRINKS_CATALOG` listed multiple flavors in parentheses against one recipe. | `lib/drinks-catalog.ts` adds bidirectional milk-percent/plain/plant/flavor/unsweetened/zero-sugar checks (while allowing cleaner swaps via `allowCleanerSwap: true` in `lib/swaps.ts` and exempting inherently unsweetened/zero-sugar brands like Zevia). All 37 multi-flavor parenthetical beverage titles in `DRINKS_CATALOG` were un-pooled into single-flavor entries. |
| High | A Spindrift Raspberry Lime source was attached to a pooled Lemon/Raspberry/Strawberry title and a lemon-juice recipe. | Drink and swap records now identify Raspberry Lime, contain lime juice, and use the manufacturer's 5kcal/1g sugar per 355ml and 3% juice values. |
| Medium | Clean-label false-positive additive traps: `"Vitamin E 150 IU"` / `"Vitamin E 110 IU"` matched `E150` (`caramelcolor`) / `E110` (`yellow6`); `"Non bromated flour"` / `"Unbromated flour"` matched `kbromate` (`Potassium Bromate`); calcium fortifiers (`tricalcium phosphate`, `dicalcium phosphate`, `calcium phosphate`) matched `naphosphate`; citric acid and plain celery powder were penalized. | `lib/rubric.ts` normalizes `Vitamin E <number>` before E-number matching, excludes `unbromated`/`non bromated` from `kbromate`, restricts `naphosphate` to sodium/potassium phosphates (`(mono\|di\|tri)?(sodium\|potassium) (acid )?(phosphates?\|...)`), removes the citric-acid penalty, and requires curing/meat context for the celery rule. |
| Medium | Products sweetened with `glucose syrup`, `brown rice syrup`, `tapioca syrup`, `oat syrup`, or `date syrup` were missed by `cornsyrup` / `hasTop3AddedSugar` / `hasAddedSweetenerOrSyrup` and could display `"No Added Sugar in Ingredients"`. | `lib/rubric.ts` flags `(?<!fructose )glucose syrup( solids)?` under `cornsyrup` and includes all syrups and sugars in `hasTop3AddedSugar` and `hasAddedSweetenerOrSyrup`. |
| Medium | Missing OFF positive nutrients lost points; generic estimates could credit an unsupported 65% produce content. Old normalized cache values could survive a unit correction. | `lib/rubric.ts` fills missing positive fields only, preserves measured zeroes and baseline measurements, marks inferred fields and defaults unknown produce percentages conservatively. `lib/lookup.ts:77` rejects old normalized cache entries using schema version 2. |
| Medium | Simulator rescoring discarded measured swap nutrition. Retailer links shortened exact products into generic searches. | `components/Simulator.tsx:123` and `lib/swaps.ts` preserve alternative nutrition and retain brand/product/variant in retailer searches. Mary's checked panel has 150kcal, 180mg sodium, 3g fiber and 4g protein per 30g; ingredient score 100 and combined score 68 replace the unsupported A/90–100 assumption. |
| Medium | A dietary-specific request could recommend wheat bread for gluten-free bread, whole milk for skim milk, or non-lactose-free milk for Lactaid. | `lib/swaps.ts` preserves explicit dietary/formulation restrictions or returns no swap. Tests cover gluten-free bread, skim milk, Lactaid and vegan ranch. |
| Medium | Additional catalog formulations had incomplete or outdated ingredient lists (Dave's Killer Bread 21 Whole Grains, RXBAR Chocolate Sea Salt, Nesquik Chocolate Lowfat Milk, Orgain, Core Power, Premier Protein, Muscle Milk, Optimum Nutrition). | Updated each catalog entry in `lib/lookup.ts`, `lib/drinks-catalog.ts`, and `lib/swaps.ts` to match current US manufacturer panels (`verifiedAt: "2026-11-09"`). |

**API integrations and latency**

| Provider | Runtime behavior |
| --- | --- |
| USDA FDC | Branded plus parallel Foundation,SR Legacy queries for conservative store-trimmed whole-food queries. Preserves species/preparation: rejects cod or cooked salmon for raw Atlantic salmon. A missing/blank `USDA_API_KEY` uses public `DEMO_KEY`; a dedicated key increases available quota. |
| NIH DSLD v9 | No-auth lookup for supplement keywords/barcodes. Uses `search-filter` followed by at most two label details. Requires active-market status, strict product/flavor or exact normalized UPC identity, active ingredient rows and a nonempty other-ingredients panel. Extracts actives and excipients, including dyes, sucralose and Ace-K. Handles NIH's spaced UPC typography. |
| Open Beauty / Products / Pet Food Facts | Vertical lookups retain actual provenance and explicit non-food classification. Exact barcode identity replaces unsafe trailing-digit GTIN truncation. Personal-care records receive `nutritionScore=0` / `Nutri-Score=N/A`, including generic names without cosmetic keywords. |
| OFF | Preserves v0 fallback, US-market ranking and sequential detail fetches. Raw barcode responses have a bounded 24-hour cache; a 429 does not globally black out unrelated barcodes. Only the supplied barcode form is requested per host, reducing duplicate requests. Missing positives can be inferred without replacing provider numbers. |

Each upstream request and the whole network phase share a maximum 1,800ms budget. OFF search/detail and NIH search/detail therefore share that deadline. Screen ingredients and cache hits skip network requests.

**Remaining notes**

| Severity | Note | Status |
| --- | --- | --- |
| Low | Positive nutrient inference is category-based when upstream providers omit positive fields (`fiberG100g`, `proteinG100g`). It is marked in `nutrition.inferredPositiveFields` and preserves verified zeroes. | Tracked in `nutrition.inferredPositiveFields` so inferred fields remain distinguishable from package-label measurements downstream. |

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
- [Yerba Madre / Guayakí Enlighten Mint](https://yerbamadre.com/products/enlightenmint) and [Guayakí Unsweetened Traditional Tereré](https://guayaki.com/products/unsweetened-traditional-terere).
- [Annie's Organic Grass-Fed Shells & Real Aged Cheddar](https://www.annies.com/product/organic-grass-fed-shells-real-aged-cheddar-mac-cheese).
- [Orgain Organic Grass-Fed Clean Protein Shake](https://orgain.com/products/organic-grass-fed-clean-protein-shake).
- [Dave's Killer Bread 21 Whole Grains and Seeds](https://www.daveskillerbread.com/21-whole-grains-and-seeds).
- [RXBAR Chocolate Sea Salt](https://www.rxbar.com/en_US/shop/protein-bars/chocolate-sea-salt-box-of-12.html).

**Verification**

Final merged-tree results:

| Gate | Exit status |
| --- | --- |
| `npm run typecheck` | `0` |
| `npm run test:rubric` | `0` — 473 checks |
| `npm run build` | `0` |

~~~sh
npm run typecheck
npm run test:rubric
npm run build
NODE_OPTIONS=--conditions=react-server npx tsx scripts/audit-ingredient-catalog.ts
~~~

The 473 regression assertions cover clean ingredient traps (`Vitamin E 150 IU`, `tricalcium phosphate`, `unbromated flour`, `citric acid`, plain `celery powder`), syrup detection (`glucose syrup`, `brown rice syrup`, `tapioca syrup`), hidden seed oils, USDA IDs/numbers/units, OFF energy/salt/sodium, measured zeroes, missing positives, product-level organic labels, species/preparation, flavor/percent/dietary/unsweetened/zero-sugar guards, Guayakí Enlighten Mint vs. Unsweetened Traditional Tereré, Annie's Grass-Fed Shells & Real Aged Cheddar (`53/100` across USDA and catalog), NIH archives/excipients/UPCs, non-food barcodes, API provenance, OFF 429/v0 fallback, and cancellation of hung upstream calls.
