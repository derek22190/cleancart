# HeyBroc — Google Play & Apple App Store Submission Kit

> [!CAUTION]
> **🛑 HARD REMINDER BEFORE SUBMITTING TO EITHER STORE:**
> 1. **Wait for your 9-digit D-U-N-S number** from Dun & Bradstreet (verification files sent Nov 7, 2026).
> 2. **Verify your LLC (Organization)** on both **Google Play Console** and **Apple Developer** (`developer.apple.com/account` → Individual to Organization Migration) **before** creating the public store listing.
> 3. Doing this first ensures your **LLC name** is shown publicly instead of your personal name/home address, and **skips Google Play's 14-day / 12-tester wait** so you can publish straight to Production.

---

## 1. Ready-to-Upload Store Graphics (Included in `store-assets/`)

- **Google Play Store Icon (512×512 PNG, 32-bit RGBA):** [`store-assets/google-play/icon-512x512.png`](file:///home/antigravity/derek22190/cleancart/store-assets/google-play/icon-512x512.png)
- **Google Play Feature Graphic (1024×500 PNG, 24-bit RGB):** [`store-assets/google-play/feature-graphic-1024x500.png`](file:///home/antigravity/derek22190/cleancart/store-assets/google-play/feature-graphic-1024x500.png)
- **Google Play Phone Screenshots (Exact `1080×1920 px` 9:16 Full HD, Ready to Drag & Drop):** [`store-assets/google-play/screenshots-1080x1920/`](file:///home/antigravity/derek22190/cleancart/store-assets/google-play/screenshots-1080x1920/slide-1-hook-poster.jpg)
- **Apple App Store Icon (1024×1024 PNG, 24-bit RGB opaque, no alpha):** [`store-assets/apple-app-store/icon-1024x1024.png`](file:///home/antigravity/derek22190/cleancart/store-assets/apple-app-store/icon-1024x1024.png)
- **Apple App Store 6.7" iPhone Screenshots (Exact `1290×2796 px`, Ready to Drag & Drop into App Store Connect):** [`store-assets/apple-app-store/screenshots-1290x2796/`](file:///home/antigravity/derek22190/cleancart/store-assets/apple-app-store/screenshots-1290x2796/slide-1-hook-poster.jpg)
- **Interactive 6-Slide ASO Screenshot Gallery (Control Variant A):** [`store-assets/aso-screenshots/index.html`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/index.html)
- **A/B Screenshot Testing Studio (Control A vs. Challenger B "Shock-Score" vs. Challenger C "Online Cart"):** [`store-assets/aso-screenshots/ab-variants.html`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/ab-variants.html)
- **App Store PPO & Google Play Store Listing Experiments Playbook:** [`store-assets/ASO_AB_TESTING_PLAYBOOK.md`](file:///home/antigravity/derek22190/cleancart/store-assets/ASO_AB_TESTING_PLAYBOOK.md)
  - Slide 1 (Hook Poster — Store-Safe `"Barcode Apps"` crossed out + HeyBroc Mascot in Cart with Red Superhero Cape): [`store-assets/aso-screenshots/slide-1-hook-poster.jpg`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/slide-1-hook-poster.jpg)
  - Slide 2 (0–100 Clean Score & 1-Tap Swap): [`store-assets/aso-screenshots/slide-2-score-card.jpg`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/slide-2-score-card.jpg)
  - Slide 3 (Flagged Additives Breakdown): [`store-assets/aso-screenshots/slide-3-flagged-additives.jpg`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/slide-3-flagged-additives.jpg)
  - Slide 4 (Clean Grocery Library & 13 Apps): [`store-assets/aso-screenshots/slide-4-clean-library.jpg`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/slide-4-clean-library.jpg)
  - Slide 5 (HeyBroc Mascot in Red Cape + Clean Cart Streak): [`store-assets/aso-screenshots/slide-5-mascot-streak.jpg`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/slide-5-mascot-streak.jpg)
  - Slide 6 (12 Grocery Stores Live Shop + Family Watchlist & Independent Scoring): [`store-assets/aso-screenshots/slide-6-awards-quote.jpg`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/slide-6-awards-quote.jpg)
- **Privacy Policy URL (Required by both stores):** `https://www.heybroc.com/privacy`
- **Terms of Use (EULA) URL (Required by Apple Guideline 3.1.2):** `https://www.heybroc.com/terms`

---

## 1B. Deepstash-Style 6-Slide ASO Screenshot Blueprint (Hard Notes for Store Packaging)

When packaging the final store screenshots for **Apple App Store (1290×2796 px, 6.7")** and **Google Play Store (1080×1920 or 1290×2796 px)**, follow the proven **Deepstash ASO formula** (saved in [`store-assets/aso-screenshots/`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/index.html)):

### Core Visual Rules (Why Deepstash Converts)
1. **Bold Color-Blocking Per Slide**: Every slide uses a distinct, saturated background color (`#F03E2F` Coral Red → `#19D37E` Mint Green → `#7C5CFF` Royal Violet → `#1890FF` Sky Blue → `#F59E0B` Warm Amber → `#10B981` Emerald Green) with high-contrast `#111814` ultra-bold headlines (`3–5 words max` per line).
2. **Hero & Feature Posters**:
   - **Slide 1** is a store-safe category poster (`~~Barcode Apps~~ for online grocery`) with zero third-party trademarks.
   - **Slide 6** is a crisp 12-Store Live Shop + Family Watchlist & Allergens feature showcase with zero award laurels, zero unattributed quotes, and zero government endorsement claims.
3. **Zoomed, Bottom-Bleeding Phone Cards (Slides 2–6)**:
   - Never shrink a whole tiny phone into the middle of the slide where text is unreadable.
   - Crop the top 65% of a clean white-card UI inside a bold black bezel (`border: 6px solid #111814; border-radius: 44px 44px 0 0`) bleeding off the bottom edge so every ingredient flag, score ring, and swap button is huge and legible from the search results page.

### Slide-by-Slide Copy & Layout Spec
| Slide | Background | Headline (Top 25%) | Visual / UI Focus (Bottom 75%) |
| :--- | :--- | :--- | :--- |
| **Slide 1 (Hook Poster)** | Coral Red (`#F03E2F`) | `~~Barcode Apps~~ for online grocery` | `Works on 13+ Grocery Apps · 0–100 Clean Score` + 3D Broc mascot with glowing ingredient-radar network nodes (`Seed Oils`, `Red 40`, `HFCS`, `Sucralose`). |
| **Slide 2 (Core Action)** | Mint Green (`#19D37E`) | `Replace mystery labels with 0–100 scores` | Bottom-cropped phone showing the floating HeyBroc pill + instant `6/100 Bad` → `100/100 Excellent` Product Grade sheet over Walmart, Amazon, Instacart & Shipt. |
| **Slide 3 (Additive X-Ray)** | Royal Violet (`#7C5CFF`) | `Spot Seed Oils, Red 40 & hidden toxins` | Zoomed-in flagged additive breakdown (`1. Red 40 · −25 pts`, `2. Soybean Oil · −15 pts`, `3. Sucralose · −20 pts`) with plain-English scientific citations. |
| **Slide 4 (Swaps & Library)** | Sky Blue (`#1890FF`) | `Build your clean grocery library` | `My Scans` & `♥ Saved Swaps` folders (`Clean Drinks`, `Avocado Oil Picks`) + `1-Tap Clean Swap: Guayakí Organic Yerba Mate (100/100) — Find in Shipt ↗`. |
| **Slide 5 (Mascot + Watchlist)** | Warm Amber (`#F59E0B`) | `Shop cleaner daily, the easy way` | 3D Broc mascot standing proud above `"Clean Cart Streak"` + `🛡️ Allergies & Diabetes` and `Family Watchlist (2x Penalty)` badges. |
| **Slide 6 (12 Stores + Watchlist)** | Emerald Green (`#10B981`) | `12 Grocery Stores. Your Family Watchlist.` | Live Shop retailer chip grid (all 13 tiles across 12 store backends) + Family Watchlist & Allergens 2x Penalty/Instant Alert cards + transparent independent rubric disclaimer. |

---

## 2. Copy-Paste Store Listing Text

### App Name / Title (Max 30 characters — 29 chars)
```text
HeyBroc - Online Food Scanner
```

### Apple Subtitle (Max 30 characters)
```text
Ingredient Score & Clean Swaps
```

### Google Play Short Description (Max 80 characters — 77 chars)
```text
Instant 0–100 ingredient health scores & 1-Tap Clean Swaps while you shop!
```

### Full Description (Google Play & Apple App Store)
```text
Shop clean and skip hidden food additives, seed oils, and artificial dyes—automatically while you browse your favorite grocery stores.

HeyBroc grades grocery foods and beverages across our curated grocery catalog, Open Food Facts, and USDA FoodData Central on a transparent 0–100 scale and recommends healthier 1-for-1 Clean Swaps in a single tap.

HOW HEYBROC WORKS:
• Transparent 3-Pillar Score (0–100): Every product is graded across Nutritional Quality (60%), Additive & Chemical Safety (30%), and Organic Bonus (10%).
• Instant Flagged Ingredient Breakdown: Immediately see high-risk and moderate-risk additives like Red 40, Yellow 5 & 6, Titanium Dioxide, Potassium Bromate, BHA/BHT, High Fructose Corn Syrup, Nitrites, Carrageenan, and Refined Seed Oils—with plain-English explanations and scientific citations.
• 1-Tap Clean Swaps: Whenever a product scores poorly, HeyBroc shows a real, same-category healthier alternative (like swapping conventional chips or dressings for avocado-oil or organic picks) so you never have to guess what to buy instead.
• Live Store Browser & Safari Extension: Shows on-photo 0–100 score badges right inside Live Shop for Walmart, Target, Instacart, Kroger, ALDI, Costco, Sam's Club, BJ's, Amazon Fresh, Whole Foods, DoorDash, Uber Eats, and Shipt.
• Custom Family Watchlist: Toggle the exact categories your household avoids (Seed Oils, Artificial Dyes, Artificial Sweeteners, Preservatives & Nitrites, Emulsifiers, Thickening Gums, or Artificial Flavors & MSG).

100% INDEPENDENT RATING:
HeyBroc never accepts payments from food brands to boost product scores. Every score is calculated deterministically from the ingredient list and nutrition data.

SUBSCRIPTION & LEGAL:
HeyBroc Family Pro is available as an auto-renewable subscription ($49.99/year or $9.99/month, with a 7-day free trial for eligible new subscribers). Payment is charged to your Apple ID or Google Play account at confirmation of purchase or end of trial, and renews automatically unless canceled at least 24 hours before the end of the current period.

Terms of Use (EULA): https://www.heybroc.com/terms
Privacy Policy: https://www.heybroc.com/privacy
```

### Apple App Store Keywords (Max 100 characters, comma-separated)
```text
food scanner,ingredients,clean eating,seed oil,grocery,nutrition,additives,healthy swaps,organic
```

---

## 3. Google Play Console — Accessibility Service Declaration

In Google Play Console → **Policy and programs → App content → Accessibility API**:
- **Does your app use the AccessibilityService API?** Select **No** (the `play` Gradle flavor built for Google Play removes `BIND_ACCESSIBILITY_SERVICE` and `SYSTEM_ALERT_WINDOW` entirely and uses the in-app Live Shop browser `LiveStoreBrowserActivity` plus Google Play Billing).
- *(Note: Only the optional direct-download APK (`direct` flavor) distributed outside Google Play includes the opt-in floating `AccessibilityService` overlay.)*

---

## 4. Google Play Data Safety & Apple App Privacy Answers

- **Does your app collect or share any of the required user data types?**
  - **Yes**:
    - **App-scoped Device ID (`deviceId`)**: Install-scoped random UUID transmitted for free weekly swap accounting, referral credit, and Pro entitlement verification (App Functionality).
    - **Product Browsing Queries (`productTitle`, `rawIngredients`, visible cart item titles)**: Transmitted over HTTPS to `heybroc.com/api/scan` to compute 0–100 ingredient scores and Clean Swaps (App Functionality).
    - **Email Address & Name (Optional)**: Collected only if the user voluntarily creates an account or subscribes via web checkout, with full in-app account deletion (*Menu → Account → Delete Account & All Saved Data*).
- **Does your app track users across other companies' apps or websites (Apple ATT)?**
  - **No** (`NSPrivacyTracking = false` in `ios-app/App/PrivacyInfo.xcprivacy`).
- **Is all network traffic encrypted in transit (HTTPS)?**
  - **Yes** (`https://www.heybroc.com`).
