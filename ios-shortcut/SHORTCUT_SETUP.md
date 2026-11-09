# CleanCart on iPhone — Safari Floating Pill, Share Sheet, Back Tap & Action Button

CleanCart on iPhone supports **two instant ways** to scan groceries:
1. **Safari Floating Pill (`ios-app/SafariExtension`)**: Enable **HeyBroc** in *Settings → Apps → Safari → Extensions* (`Allow on All Websites` or grocery domains) to get the live floating `0–100` score pill automatically on `walmart.com`, `instacart.com`, `target.com`, `kroger.com`, `aldi.us`, `amazon.com`, and `costco.com`.
2. **1-Line Apple Shortcut (for Native Store Apps via Share Sheet, Back Tap, or Action Button)**: Calls `GET /api/scan?format=ios_text&q=...` (or `POST /api/scan`) with zero manual JSON dictionary setup required.

> **Live Production API URL:** `https://heybroc.com` (fallback: `https://cleancart-teal.vercel.app`)

---

## Step 1 — 30-Second "CleanCart Scan" Shortcut (Zero JSON Setup)

Open the **Shortcuts** app (`shortcuts://create-shortcut`) → name it **CleanCart Scan**, then add just **3 simple blocks** (no POST body or JSON dictionary keys needed!):

| # | Action | Setting |
|---|--------|---------|
| 1 | **Receive** *Text, URLs, Safari web pages* input from **Share Sheet** | If there's no input: **Get Clipboard** |
| 2 | **URL Encode** | *Shortcut Input* |
| 3 | **Get Contents of URL** | `https://heybroc.com/api/scan?format=ios_text&q=[URL Encoded Text]` *(Method: default **GET**)* |
| 4 | **Show Result** | *Contents of URL* |

*(Advanced POST option: `POST https://heybroc.com/api/scan` with JSON `{ "productTitle": Shortcut Input, "store": "walmart", "format": "ios_text" }` continues to work identically.)*

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
2. In the Walmart / Instacart / Target / Kroger / ALDI / Amazon / Whole Foods / Sam's Club / BJ's / Costco app, open a product → **Share** → **CleanCart Scan**.
3. Even if the store app only shares a product URL (e.g., `https://www.target.com/p/...` or `https://www.walmart.com/ip/...`) or share boilerplate, `/api/scan` automatically extracts the product slug and detects the store for the Clean Swap link.
4. The score card appears in ~1 s (cached repeat scans return in < 5 ms server-side).

---

## Step 3 — Trigger hands-free with Back Tap or the Action Button (Screenshot OCR or Clipboard)

You can set up a 1-tap **Screen Scanner Shortcut** (`Take Screenshot` → `Extract Text from Image` → send `Text from Image` as `productTitle` to `https://heybroc.com/api/scan`):

**Back Tap (iPhone 8 and later)**
Settings → **Accessibility** → **Touch** → **Back Tap** → **Double Tap** → choose **CleanCart Scan**.
Double-tap the back of your iPhone on any grocery app product page to scan the screen (or clipboard) automatically.

**Action Button (iPhone 15 Pro / 16 / 17)**
Settings → **Action Button** → swipe to **Shortcut** → choose **CleanCart Scan**.
Press and hold the Action Button on any product page.

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
