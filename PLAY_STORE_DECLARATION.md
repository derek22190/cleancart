# Google Play Console — AccessibilityService & Data Safety Declaration (`com.cleancart.overlay`)

## 1. AccessibilityService API Declaration
- **Is this app an accessibility tool for users with disabilities?** `No` (`android:isAccessibilityTool="false"` in `accessibility_service_config.xml`).
- **Core user-facing feature requiring `AccessibilityService`:**
  HeyBroc displays a user-initiated floating 0–100 ingredient health score bubble and clean product swap suggestions while the user browses grocery items inside 12 allowlisted grocery retail and delivery apps (`com.walmart.android`, `com.instacart.client`, `com.target.ui`, `com.kroger.mobile`, `de.apptelligence.aldi`, `com.dd.doordash`, `com.ubercab.eats`, `com.amazon.mShop.android.shopping`, `com.rfi.sams.android`, `com.bjs.mobile`, `com.costco.app.android`, `com.shipt.grocer`).
- **Why `AccessibilityService` is required:**
  Android provides no public inter-app API to read the currently viewed grocery product title or expanded ingredient text inside third-party grocery shopping apps.
- **Explicit two-step in-app consent (`MainActivity.kt` & `ProductDetectorService.kt`):**
  1. Before opening Android Accessibility Settings, `MainActivity.showProminentAccessibilityDisclosure()` displays a modal disclosure explaining what screen text is read (`productTitle`, `rawIngredients`, visible cart item titles, and store identifier), what device metadata is transmitted (`deviceId` install-scoped random UUID, `familyWatchlist`, `referredByCode`), and retention limits (up to 1 year).
  2. `ProductDetectorService.onAccessibilityEvent()` checks `ScanApi.hasAccessibilityDisclosureConsent(this)` on every event and immediately aborts without inspecting any window nodes if the user has not accepted the in-app disclosure.
- **Read-only guardrails:**
  - `canPerformGestures="false"`
  - Password nodes (`node.isPassword`) and editable text fields (`node.isEditable`) are skipped immediately.
  - Non-food Amazon product pages are filtered out (`isAmazonGroceryScreen`).

---

## 2. Google Play Data Safety Form Mapping

| Data Type | Collected / Transmitted? | Purpose | Ephemeral / Retained? | User Control / Deletion |
| :--- | :--- | :--- | :--- | :--- |
| **App-scoped ID (`deviceId`)** | Yes — install-scoped random `UUID.randomUUID()` stored in `SharedPreferences` (never hardware `ANDROID_ID` or IMEI). | Enforcing free weekly swap limits, Pro subscription status, and referral credits (`POST /api/scan`, `POST /api/referral`). | Retained in Upstash Redis for up to 365 days (7 days if unactivated). | Resettable at any time by clearing app storage or uninstalling HeyBroc, or via `privacy@heybroc.com`. |
| **In-app product browsing text (`productTitle`, `rawIngredients`, visible cart item titles)** | Yes — only from the 12 allowlisted grocery apps while in foreground after in-app consent. | Computing deterministic 0–100 ingredient scores and Whole-Cart Health Check (`POST /api/scan`, `POST /api/audit`). | Public product lookups cached up to 24 hours; not linked to personal identity. | Users can revoke screen reading at any time via the in-app *"Turn off HeyBroc reading"* button. |
| **Email address (`customerEmail`)** | Web Stripe Checkout only. | Verifying Pro subscription entitlements and handling billing webhooks. | Retained in Upstash Redis with a 400-day TTL (`ENTITLEMENT_TTL_SECONDS`). | Automatically expires after 400 days or upon request to `privacy@heybroc.com`. |
| **Personal identifiers (Name, Phone, Contacts, SMS, Location, Payment Card)** | **No** | N/A | N/A | N/A |

---

## 3. Release Signing Verification
- Production APKs/AABs are signed exclusively in CI or local release environments via `KEYSTORE_BASE64` / `KEYSTORE_FILE`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, and `KEY_PASSWORD` environment variables (`android-app/app/build.gradle.kts`).
- No keystore files or default passwords exist in the repository.
