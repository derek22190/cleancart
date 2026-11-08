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
|   |   | `store` → `walmart` *(or instacart / target / kroger / aldi / doordash / ubereats / amazon / sams / bjs / costco / shipt)* |
|   |   | `format` → `ios_text` |
| 4 | **Show Result** | *Contents of URL* |

The `ios_text` response is a ready-to-read summary:

```text
🔴 35/100 Poor — Berry Swirl Strawberry Lowfat Yogurt

⚠️ Flagged:
• Red 40 (-35): A petroleum-derived dye linked to hyperactivity…
• High Fructose Corn Syrup (-20): A highly refined industrial sweetener…

🔁 Clean Swap at Walmart: Stonyfield Organic Whole Milk Plain Yogurt (100/100)
https://www.walmart.com/search?q=Stonyfield%20Organic%20Yogurt
```

**Optional — 1-tap Swap:** add a second **Get Contents of URL** (same as step 3 but `format` = `json`) → **Get Dictionary Value** for key `swap.webUrl` → **Choose from Menu** with "Swap Item" / "Close" → under *Swap Item* add **Open URLs**. The swap link only opens when you tap "Swap Item".

**Optional — rich card:** replace step 4 with **Quick Look** on `https://heybroc.com`, or **Show Web View**, for the full Health Insights card.

---

## Step 2 — Use it from the Share Sheet

1. In the Shortcut's **ⓘ Details**, enable **Show in Share Sheet**.
2. In the Walmart / Instacart / Target / Kroger / ALDI / Amazon / Sam's Club / BJ's / Costco app, open a product → **Share** → **CleanCart Scan**.
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
  "rawIngredients": "optional — skips lookup if provided (must be 10–10,000 chars of English ingredient text)",
  "barcode": "optional — UPC/EAN barcode string",
  "store": "walmart | instacart | target | kroger | aldi | doordash | ubereats | amazon | sams | bjs | costco | shipt",
  "watchlist": { "seedOils": false },
  "familyWatchlist": ["dyes", "seedOils", "hfcs", "preservatives", "nitrites", "sweeteners"],
  "deviceId": "optional — install-scoped random UUID for Pro & free weekly swap tracking",
  "format": "ios_text | json"
}
```
