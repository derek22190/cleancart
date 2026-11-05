# CleanCart (PureOverlay)

Zero-friction grocery **ingredient grader** + **1-tap clean swap** engine that floats over Walmart, Instacart, Sam's Club and BJ's — on the web (Chrome extension), Android (native overlay) and iPhone (Shortcuts).

## Product rules baked into the code

| Rule | Where |
|---|---|
| Ingredient-only scoring — calories, carbs, natural fat and sodium are never scored | `lib/rubric.ts` |
| Deterministic 0–100 rubric (start at 100; −35 high / −20 moderate / −10 low; each additive counted once; clamped) | `lib/rubric.ts` |
| No server scraping of stores — titles/ingredients are read client-side; lookups use Open Food Facts v2 → USDA FDC; local JSON cache | `lib/lookup.ts` |
| Affiliate params (`?irgwc=1&clickid=…`) only on URLs opened by an explicit **Swap Item** tap | `lib/swaps.ts`, overlay clients |

## Run the simulator

```bash
npm install
npm run dev            # http://localhost:3000
npm run typecheck      # zero TypeScript errors
npm run test:rubric    # deterministic rubric checks
```

### Environment (optional)

| Var | Purpose | Default |
|---|---|---|
| `IMPACT_CLICK_ID` | Your Impact.com click/partner id appended to swap links | `YOUR_IMPACT_ID` |
| `USDA_API_KEY` | USDA FoodData Central key (DEMO_KEY is rate-limited) | `DEMO_KEY` |
| `CLEANCART_CACHE_DIR` | Where the JSON lookup cache is written | `./.cache` |

## API

`POST /api/scan` — `{ productTitle?, rawIngredients?, barcode?, store?, watchlist?, format?: "json" | "ios_text" }`
`POST /api/audit` — `{ items: [{ productTitle?, rawIngredients? }], store?, watchlist? }` (Whole-Cart Auditor)
`GET  /api/scan` — returns the full rubric for transparency.

## Clients

- **Chrome extension** — `chrome-extension/` (load unpacked; set API URL in the popup)
- **Android** — `android-app/` (Kotlin, minSdk 26 / targetSdk 34). CI builds `cleancart-debug.apk` via `.github/workflows/build-apk.yml`
- **iPhone** — `ios-shortcut/SHORTCUT_SETUP.md`

## Notes

- Clean-swap links currently point to an exact-match store search (always valid, opens in the native app via App Links). Add verified store item IDs to `CLEAN_ALTERNATIVES[*].itemIds` in `lib/swaps.ts` to generate direct product deep links like `walmart://ip/{id}`.
- Walmart's Impact program officially uses `goto.walmart.com/c/{id}/{ad}/9383?u=<url>` wrapping; swap `withAffiliate()` in `lib/swaps.ts` if your Impact account requires that format.
