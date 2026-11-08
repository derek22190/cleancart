# Google Play Console — AccessibilityService & Data Safety Declaration (`com.cleancart.overlay`)

## 1. AccessibilityService API Declaration
- **Is this app an accessibility tool for users with disabilities?** `No` (`android:isAccessibilityTool="false"` in `accessibility_service_config.xml`).
- **Core user-facing feature requiring `AccessibilityService`:**
  HeyBroc displays a user-initiated floating 0–100 ingredient health score bubble and clean product swap suggestions while the user browses grocery items inside 12 allowlisted grocery retail and delivery apps (`com.walmart.android`, `com.instacart.client`, `com.target.ui`, `com.kroger.mobile`, `de.apptiv.business.android.aldi_us`, `com.dd.doordash`, `com.ubercab.eats`, `com.amazon.mShop.android.shopping`, `com.wholefoods.wholefoodsmarket`, `com.rfi.sams.android`, `com.samsclub.app`, `com.brandingbrand.reactnative.and.bjs`, `com.bjs.mobile`, `com.costco.app.android`, `com.shipt.groceries`).
- **Why `AccessibilityService` is required:**
  Android provides no public inter-app API to read the currently viewed grocery product title, expanded ingredient text, or visible cart item titles inside third-party grocery shopping apps.
- **Explicit two-step in-app consent (`MainActivity.kt`, `AccessibilityConsent.kt` & `GroceryScreenReaderService.kt`):**
  1. Before opening Android Accessibility Settings, `MainActivity.showProminentAccessibilityDisclosure()` displays a modal disclosure explaining what screen text is read (`productTitle`, `rawIngredients`, visible cart item titles up to 20 items, and store identifier), what device metadata is transmitted (`deviceId` install-scoped random UUID, `familyWatchlist`, `referredByCode`), and retention limits (up to 1 year).
  2. `GroceryScreenReaderService.onAccessibilityEvent()` checks `AccessibilityConsent.granted(this)` on every event and immediately aborts without inspecting any window nodes if the user has not accepted the current version of the in-app disclosure.
- **Read-only guardrails:**
  - `canPerformGestures="false"`
  - Password nodes (`node.isPassword`), invisible off-screen nodes (`!node.isVisibleToUser`), and editable text fields (`node.isEditable`) are skipped immediately.
  - Non-food Amazon product pages are filtered out (`isAmazonGroceryScreen`).

---

## 2. Google Play Data Safety Form Mapping

| Data Type | Collected / Transmitted? | Purpose | Ephemeral / Retained? | User Control / Deletion |
| :--- | :--- | :--- | :--- | :--- |
| **App-scoped ID (`deviceId`)** | Yes — install-scoped random `UUID.randomUUID()` stored in `SharedPreferences` (never hardware `ANDROID_ID` or IMEI). | Enforcing free weekly swap limits, Pro subscription status, and referral credits (`POST /api/scan`, `POST /api/referral`). | Retained in Upstash Redis for up to 365 days (7 days if unactivated). | Resettable at any time by clearing app storage or uninstalling HeyBroc, or via `privacy@heybroc.com`. |
| **In-app product browsing text (`productTitle`, `rawIngredients`, visible cart item titles)** | Yes — only from the 12 allowlisted grocery apps while in foreground after in-app consent. | Computing deterministic 0–100 ingredient scores and Whole-Cart Health Check (`POST /api/scan`, `POST /api/audit`). | Public product lookups cached up to 24 hours; not linked to personal identity. | Users can revoke screen reading at any time via the in-app *"Pause / Turn Off Store Bubble"* button. |
| **Email address & optional display name (`email`, `name`)** | Optional — only when the user voluntarily signs up / logs in or completes web Stripe Checkout. | Syncing Family Watchlist preferences and Pro subscription entitlements across devices (`POST /api/auth`, transactional email via Resend). | Retained in Upstash Redis for up to 400 days or until account deletion. | Users can permanently delete their account and all saved data in-app via *Menu → Account → Delete Account & All Saved Data* or via `privacy@heybroc.com`. |
| **Contacts, SMS, Location, Microphone, Camera, Raw Payment Card** | **No** | N/A | N/A | N/A |

---

## 3. Release Signing Verification
- Production APKs/AABs are signed exclusively in CI or local release environments via `KEYSTORE_BASE64` / `KEYSTORE_FILE`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, and `KEY_PASSWORD` environment variables (`android-app/app/build.gradle.kts`).
- No keystore files or default passwords exist in the repository.
