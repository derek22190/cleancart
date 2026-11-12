# Apple Subscription Retention Messaging Setup Guide (`POST /api/apple/retention`)

Apple's **Subscription Retention Messaging** feature displays a native sheet inside iOS Settings when a subscriber taps **Cancel Subscription**, showing what they'll lose or offering a plan switch right before they confirm cancellation.

HeyBroc's real-time endpoint (`https://www.heybroc.com/api/apple/retention`) enforces our **Zero-Leakage Retention Policy** so bargain hunters can never trigger hidden discounts from a free trial:

1. **Free-Trial Users (`Day 1–7`)**: Receive **\$0 discounts**. Annual trialers get a standard switch option to flexible Monthly billing; all other trialers get a personalized value reminder of what turns off.
2. **Paid Monthly Members**: Receive an **Alternate Product** prompt to switch to Annual Family Pro for maximum year-round savings.
3. **Paid Annual Members**: Receive an **Alternate Product** prompt to switch their next renewal to flexible Monthly billing.

---

## 1. Critical App Store Review Rule (No `$` or `%` in Message Text!)

Apple rejects Retention Messages whose **Header** or **Body** text contains dollar amounts, currencies, free-time claims, or discount percentages (for example, `"Save 58%"`, `"$39.99"`, or `"1 month free"`). Apple automatically renders the exact localized StoreKit price and billing cadence right underneath your message body.

Copy and paste the exact pre-compliant text below when creating your 3 messages in **App Store Connect → Subscriptions → Retention Messaging**.

---

## 2. Ready-to-Paste Messages in App Store Connect

### Message 1 — Value Reminder (`APPLE_RETENTION_MSG_VALUE_ID`)
- **Purpose**: Shown to free-trialing subscribers (zero discount leakage).
- **Header** *(max 65 chars)*:
  `Keep Your Family Watchlist & Clean Swaps Active`
- **Body** *(max 180 chars)*:
  `Canceling turns off your custom 2x additive alerts, Weekly Order Health Audits, and unlimited cleaner swaps across all 12 grocery apps.`

### Message 2 — Switch Annual to Flexible Monthly (`APPLE_RETENTION_MSG_SWITCH_MONTHLY_ID`)
- **Purpose**: Shown with `alternateProduct` (`com.heybroc.pro.monthly`) when an Annual trialer or subscriber prefers smaller month-to-month payments.
- **Header** *(max 65 chars)*:
  `Prefer Smaller Month-to-Month Payments Instead?`
- **Body** *(max 180 chars)*:
  `Keep your custom Family Watchlist, allergy alerts, and unlimited 1-tap Clean Swaps active by switching to flexible monthly billing.`

### Message 3 — Switch Monthly to Annual Value (`APPLE_RETENTION_MSG_LOYALTY_ANNUAL_ID`)
- **Purpose**: Shown with `alternateProduct` (`com.heybroc.pro.annual`) to verified paid Monthly subscribers.
- **Header** *(max 65 chars)*:
  `Lock In Year-Round Clean Grocery Protection`
- **Body** *(max 180 chars)*:
  `Already loving HeyBroc every week? Switch from monthly billing to our annual Family Pro plan to keep every grocery trip covered all year.`

---

## 3. Connect Your Real-Time URL & Environment Variables

1. In **App Store Connect → Subscriptions → Retention Messaging**, set the **Retention Messaging URL** to:
   `https://www.heybroc.com/api/apple/retention`
2. Click **Performance Test** in App Store Connect (Apple sends Sandbox test JWS payloads and verifies `<1000ms` latency; HeyBroc responds in `<50ms`).
3. Once your 3 messages above are approved in App Store Connect, add their UUIDs in Vercel:
   - `APPLE_RETENTION_MSG_VALUE_ID` = `<UUID of Message 1>`
   - `APPLE_RETENTION_MSG_SWITCH_MONTHLY_ID` = `<UUID of Message 2>`
   - `APPLE_RETENTION_MSG_LOYALTY_ANNUAL_ID` = `<UUID of Message 3>`
   - `APPLE_MONTHLY_PRODUCT_ID` = `com.heybroc.pro.monthly` (or your exact App Store Monthly product ID)
   - `APPLE_ANNUAL_PRODUCT_ID` = `com.heybroc.pro.annual` (or your exact App Store Annual product ID)
   - `APPLE_BUNDLE_ID` = `com.heybroc.app` (optional strict bundle guard)
