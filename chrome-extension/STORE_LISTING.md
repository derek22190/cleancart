# HeyBroc (CleanCart) — Chrome Web Store Listing & Disclosures

## Summary
Instant 0–100 ingredient health scores, additive explanations, and 1-tap clean swaps while you shop online at Walmart, Instacart, Target, Kroger, ALDI, Amazon Fresh / Whole Foods, Costco, Sam's Club, BJ's, DoorDash, Uber Eats, and Shipt.

## How HeyBroc Works
1. **Product Page Score Bubble:** When you open a grocery product page on a supported store (or an Amazon page categorized under *Grocery & Gourmet Food*, *Amazon Fresh*, or *Whole Foods Market*), HeyBroc reads the visible product title and ingredient list on the page and displays a color-coded 0–100 score pill.
2. **Whole-Cart Health Check:** While browsing search results or your cart, the floating pill switches to your live Cart Average and highlights 1-for-1 clean swaps for any item scoring under 75/100.
3. **Custom Family Watchlist:** Penalize or filter out synthetic dyes, industrial seed oils, high-fructose corn syrup, synthetic preservatives, nitrites, and artificial sweeteners.

## Privacy & Permissions Disclosure
- **Host Permissions (12 Supported Retailers):** Used strictly to read grocery product titles and ingredient text on supported store pages and render the Shadow DOM score overlay. On `amazon.com`, scanning runs only on grocery/food product pages.
- **Storage Permission (`chrome.storage`):** Stores your API endpoint setting, trip cart items, and watchlist preferences locally in your browser.
- **No Background Tracking:** HeyBroc never reads passwords, form inputs, checkout fields, or browsing history outside the 12 supported grocery domains.

## Affiliate Link Disclosure (Chrome Web Store Policy Compliance)
When you explicitly click a **"Swap Item"** or **"Find Clean Swap"** button inside the HeyBroc overlay, the resulting store link may include retail affiliate attribution parameters or route through an affiliate partner link (such as Walmart Impact or Amazon Associates) at no additional cost to you. HeyBroc never injects affiliate cookies, modifies store URLs automatically, or opens affiliate links without your explicit click.
