# CleanCart on iPhone — Share Sheet, Back Tap & Action Button

iOS doesn't allow apps to float over other apps, so CleanCart on iPhone runs as a **Shortcut** that calls the same deterministic `POST /api/scan` endpoint used by Android and Chrome.

> **Live Production API URL:** `https://heybroc.com` (fallback: `https://cleancart-teal.vercel.app`)

---

## Step 1 — Build the "CleanCart Scan" shortcut (2 min)

Open the **Shortcuts** app → **+** → name it **CleanCart Scan**, then add these actions in order:

| # | Action | Setting |
|---|--------|---------|
| 1 | **Receive** *Text, URLs, Safari web pages* input from **Share Sheet** | If there's no input: **Get Clipboard** |
| 2 | **Text** | `Shortcut Input` (the shared product title / page title) |
| 3 | **Get Contents of URL** | URL: `https://heybroc.com/api/scan` · Method: **POST** · Request Body: **JSON** |
|   |   | `productTitle` → *Text* (from step 2) |
|   |   | `store` → `walmart` *(or instacart / sams / bjs)* |
|   |   | `format` → `ios_text` |
| 4 | **Show Result** | *Contents of URL* |

The `ios_text` response is a ready-to-read summary:

```text
🔴 35/100 Poor — Berry Swirl Strawberry Lowfat Yogurt

⚠️ Flagged:
• Red 40 (-35): A petroleum-derived dye linked to hyperactivity…
• High Fructose Corn Syrup (-20): A highly refined industrial sweetener…

🔁 Clean Swap at Walmart: Stonyfield Organic Whole Milk Plain Yogurt (100/100)
https://www.walmart.com/search?q=Stonyfield…&irgwc=1&clickid=YOUR_IMPACT_ID
```

**Optional — 1-tap Swap:** add a second **Get Contents of URL** (same as step 3 but `format` = `json`) → **Get Dictionary Value** for key `swap.webUrl` → **Choose from Menu** with "Swap Item" / "Close" → under *Swap Item* add **Open URLs**. The affiliate link only opens when you tap "Swap Item".

**Optional — rich card:** replace step 4 with **Quick Look** on `https://heybroc.com`, or **Show Web View**, for the full Health Insights card.

---

## Step 2 — Use it from the Share Sheet

1. In the Shortcut's **ⓘ Details**, enable **Show in Share Sheet**.
2. In the Walmart / Instacart / Sam's Club / BJ's app, open a product → **Share** → **CleanCart Scan**.
3. The score card appears in ~1 s (cached repeat scans return in < 5 ms server-side).

---

## Step 3 — Trigger hands-free with Back Tap or the Action Button

**Back Tap (iPhone 8 and later)**
Settings → **Accessibility** → **Touch** → **Back Tap** → **Double Tap** → choose **CleanCart Scan**.
Copy a product title, then double-tap the back of your phone.

**Action Button (iPhone 15 Pro / 16 / 17)**
Settings → **Action Button** → swipe to **Shortcut** → choose **CleanCart Scan**.
Copy a product title, then press and hold the Action Button.

---

### API reference

```http
POST https://heybroc.com/api/scan
Content-Type: application/json

{
  "productTitle": "Cheez-It Original",
  "rawIngredients": "optional — skips lookup if provided",
  "store": "walmart | instacart | sams | bjs",
  "watchlist": { "seedOils": false },
  "format": "ios_text | json"
}
```
