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
- **Privacy Policy URL (Required by both stores):** `https://www.heybroc.com/privacy`

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
