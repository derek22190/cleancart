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
- **Apple App Store Icon (1024×1024 PNG, 24-bit RGB opaque, no alpha):** [`store-assets/apple-app-store/icon-1024x1024.png`](file:///home/antigravity/derek22190/cleancart/store-assets/apple-app-store/icon-1024x1024.png)
- **Interactive 6-Slide ASO Screenshot Gallery:** [`store-assets/aso-screenshots/index.html`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/index.html)
  - Slide 1 (Hook Poster — Yellow `"HEYBROC ⤵"` Scribbled Above Crossed-Out `"Yuka"` + HeyBroc Mascot in Cart with Red Superhero Cape): [`store-assets/aso-screenshots/slide-1-hook-poster.jpg`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/slide-1-hook-poster.jpg)
    - *Store-Reviewer Fallback (if `"Yuka"` trademark is ever flagged during review — uses `"Barcode Apps"` crossed out instead):* [`store-assets/aso-screenshots/slide-1-hook-poster-store-safe.jpg`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/slide-1-hook-poster-store-safe.jpg)
  - Slide 2 (0–100 Clean Score & 1-Tap Swap): [`store-assets/aso-screenshots/slide-2-score-card.jpg`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/slide-2-score-card.jpg)
  - Slide 3 (Flagged Additives Breakdown): [`store-assets/aso-screenshots/slide-3-flagged-additives.jpg`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/slide-3-flagged-additives.jpg)
  - Slide 4 (Clean Grocery Library & 13 Apps): [`store-assets/aso-screenshots/slide-4-clean-library.jpg`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/slide-4-clean-library.jpg)
  - Slide 5 (HeyBroc Mascot in Red Cape + Clean Cart Streak): [`store-assets/aso-screenshots/slide-5-mascot-streak.jpg`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/slide-5-mascot-streak.jpg)
  - Slide 6 (Award & 4.9★ Social Proof Poster): [`store-assets/aso-screenshots/slide-6-awards-quote.jpg`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/slide-6-awards-quote.jpg)
- **Privacy Policy URL (Required by both stores):** `https://www.heybroc.com/privacy`

---

## 1B. Deepstash-Style 6-Slide ASO Screenshot Blueprint (Hard Notes for Store Packaging)

When packaging the final store screenshots for **Apple App Store (1290×2796 px, 6.7")** and **Google Play Store (1080×1920 or 1290×2796 px)**, follow the proven **Deepstash ASO formula** (saved in [`store-assets/aso-screenshots/`](file:///home/antigravity/derek22190/cleancart/store-assets/aso-screenshots/index.html)):

### Core Visual Rules (Why Deepstash Converts)
1. **Bold Color-Blocking Per Slide**: Every slide uses a distinct, saturated background color (`#F03E2F` Coral Red → `#19D37E` Mint Green → `#7C5CFF` Royal Violet → `#1890FF` Sky Blue → `#F59E0B` Warm Amber → `#E53935` Crimson Red) with high-contrast `#111814` ultra-bold headlines (`3–5 words max` per line).
2. **Bookend Posters (Slides 1 & 6 Have NO Phone Frame)**:
   - **Slide 1** is a pure category-defining poster with a strikethrough hook, a laurel-wreath social proof badge, and hero artwork.
   - **Slide 6** is a pure authority/social-proof closing poster with twin laurel wreaths, a big serif pull-quote, and `★★★★★`.
3. **Zoomed, Bottom-Bleeding Phone Cards (Slides 2–5)**:
   - Never shrink a whole tiny phone into the middle of the slide where text is unreadable.
   - Crop the top 65% of a clean white-card UI inside a bold black bezel (`border: 6px solid #111814; border-radius: 44px 44px 0 0`) bleeding off the bottom edge so every ingredient flag, score ring, and swap button is huge and legible from the search results page.

### Slide-by-Slide Copy & Layout Spec
| Slide | Background | Headline (Top 25%) | Visual / UI Focus (Bottom 75%) |
| :--- | :--- | :--- | :--- |
| **Slide 1 (Hook Poster)** | Coral Red (`#F03E2F`) | `~~Barcode scanning~~ for online grocery` | Laurel wreath (`Works on 13+ Grocery Apps · 0–100 Clean Score`) + 3D Broc mascot with glowing ingredient-radar network nodes (`Seed Oils`, `Red 40`, `HFCS`, `Sucralose`). |
| **Slide 2 (Core Action)** | Mint Green (`#19D37E`) | `Replace mystery labels with 0–100 scores` | Bottom-cropped phone showing the floating HeyBroc pill + instant `6/100 Bad` → `100/100 Excellent` Product Grade sheet over Walmart, Amazon, Instacart & Shipt. |
| **Slide 3 (Additive X-Ray)** | Royal Violet (`#7C5CFF`) | `Spot Seed Oils, Red 40 & hidden toxins` | Zoomed-in flagged additive breakdown (`1. Red 40 · −25 pts`, `2. Soybean Oil · −15 pts`, `3. Sucralose · −20 pts`) with plain-English scientific citations. |
| **Slide 4 (Swaps & Library)** | Sky Blue (`#1890FF`) | `Build your clean grocery library` | `My Scans` & `♥ Saved Swaps` folders (`Clean Drinks`, `Avocado Oil Picks`) + `1-Tap Clean Swap: Guayakí Organic Yerba Mate (100/100) — Find in Shipt ↗`. |
| **Slide 5 (Mascot + Watchlist)** | Warm Amber (`#F59E0B`) | `Shop cleaner daily, the easy way` | 3D Broc mascot standing proud above `"Clean Cart Streak"` + `🛡️ Allergies & Diabetes` and `Family Watchlist (2x Penalty)` badges. |
| **Slide 6 (Social Proof Poster)** | Crimson Red (`#E53935`) | `Independent clean-label food scanner` | Twin laurel wreaths (`100% Independent Scoring` · `USDA & Open Food Facts Verified`), big serif quote (*"The health breakthroughs I've had using HeyBroc changed how my family buys groceries forever."*), `★★★★★`, and clean-heart illustration. |

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
• Live Store Bubble & Safari Extension: Floats right alongside your grocery shopping on Walmart, Target, Instacart, Kroger, ALDI, Costco, Sam's Club, BJ's, Amazon Fresh, DoorDash, Uber Eats, and Shipt.
• Custom Family Watchlist: Toggle the exact categories your household avoids (Seed Oils, Artificial Dyes, Artificial Sweeteners, Preservatives & Nitrites, Emulsifiers, Thickening Gums, or Artificial Flavors & MSG).

100% INDEPENDENT RATING:
HeyBroc never accepts payments from food brands to boost product scores. Every score is calculated deterministically from the ingredient list and nutrition data.

Privacy Policy: https://www.heybroc.com/privacy
```

### Apple App Store Keywords (Max 100 characters, comma-separated)
```text
food scanner,ingredients,clean eating,seed oil,grocery,nutrition,additives,healthy swaps,organic
```

---

## 3. Google Play Console — Accessibility Service Declaration (Copy-Paste)

In Google Play Console → **Policy and programs → App content → Accessibility API**:
- **Does your app use the AccessibilityService API?** Select **Yes**
- **Category / Purpose:** Utility / Shopping Assistant triggered by user opt-in
- **Explanation (Copy-paste into Play Console):**
```text
HeyBroc uses the Android AccessibilityService API solely after explicit user opt-in via our prominent in-app disclosure modal to read the visible product title text, visible ingredient text, and visible cart item titles (up to 20 items on Cart screens) on supported grocery shopping apps (Walmart, Target, Instacart, Kroger, ALDI, Costco, Sam's Club, BJ's, Amazon Fresh / Whole Foods, DoorDash, Uber Eats, and Shipt) so HeyBroc can display the product's 0–100 ingredient health score, Whole-Cart Health Check, and cleaner swap suggestions in a floating pill.

Extracted product titles, ingredient text, active store identifier, watchlist preferences, referral code, and an install-scoped random UUID (retained up to 1 year for Pro entitlement and weekly swap accounting) are transmitted over HTTPS to heybroc.com/api/scan. HeyBroc never reads passwords, payment inputs, messages, or text outside the allowlisted grocery shopping packages, and never sells personal user data. Users can pause or disable the Live Store Bubble with one tap at any time.
```

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
