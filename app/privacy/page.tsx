import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy & Accessibility Disclosure — HeyBroc",
  description:
    "How HeyBroc processes product titles and ingredient lists across web, Chrome extension, iOS Shortcut, and Android AccessibilityService.",
};

export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 780, margin: "0 auto", padding: "48px 20px", fontFamily: "system-ui, sans-serif", lineHeight: 1.65, color: "#15201B" }}>
      <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#0F7A4A", margin: 0 }}>
        HeyBroc · Privacy &amp; Google Play Compliance
      </p>
      <h1 style={{ fontSize: 32, margin: "8px 0 16px" }}>Privacy Policy &amp; Accessibility Data Disclosure</h1>
      <p style={{ color: "#4A5550" }}>
        <strong>Effective Date:</strong> November 6, 2026 &nbsp;·&nbsp; <strong>Service:</strong> HeyBroc (heybroc.com)
      </p>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 20 }}>1. Android AccessibilityService API Prominent Disclosure</h2>
        <p>
          The HeyBroc Android application uses the Android <code>AccessibilityService</code> API solely to provide its core user-requested feature:
          displaying a floating 0–100 ingredient score bubble and clean swap suggestions while you browse groceries inside 12 supported retail and
          delivery apps (Walmart, Instacart, Target, Kroger, ALDI, DoorDash, Uber Eats, Amazon Fresh / Whole Foods, Sam&apos;s Club, BJ&apos;s Wholesale,
          Costco, and Shipt).
        </p>
        <ul>
          <li>
            <strong>What screen content is accessed:</strong> When one of the 12 supported store apps is actively in the foreground and you have
            granted explicit in-app consent, HeyBroc inspects visible, non-editable text nodes to detect when a single product page is open and
            extracts only the visible <strong>product title</strong>, <strong>ingredient text</strong> (if expanded on screen), and active{" "}
            <strong>store identifier</strong>.
          </li>
          <li>
            <strong>What is strictly excluded:</strong> HeyBroc never reads password fields, editable text inputs, payment forms, personal identifiers,
            notifications, SMS/chat messages, or any app outside the 12 allowlisted grocery packages.
          </li>
          <li>
            <strong>How extracted product data is transmitted and used:</strong> Extracted product titles and ingredient strings are sent over encrypted
            HTTPS to <code>https://www.heybroc.com/api/scan</code> to compute a deterministic 0–100 ingredient grade and identify cleaner store
            alternatives. When a product page does not display ingredients directly on screen, our server may query public food databases
            (Open Food Facts and USDA FoodData Central) by product title or barcode.
          </li>
          <li>
            <strong>No autonomous actions:</strong> HeyBroc is a read-only ingredient grader (`isAccessibilityTool=&quot;false&quot;`). It never performs
            automated clicks, gestures, cart modifications, or purchases on your behalf. Store swap links open only when you explicitly tap them.
          </li>
          <li>
            <strong>Revoking consent at any time:</strong> You can stop screen reading immediately inside the HeyBroc app via the{" "}
            <em>&ldquo;Turn off HeyBroc reading&rdquo;</em> button or by disabling HeyBroc in Android <em>Settings → Accessibility → Installed apps</em>.
          </li>
        </ul>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 20 }}>2. Data Storage, Caching &amp; Retention</h2>
        <ul>
          <li>
            <strong>Public product lookup cache:</strong> Public product ingredient lookups (product title, barcode, and public ingredient list) are
            cached in server memory for up to 24 hours to reduce latency and upstream load on Open Food Facts and USDA.
          </li>
          <li>
            <strong>On-device preferences &amp; trip history:</strong> Your ingredient watchlist preferences, floating bubble position, and recently
            graded items for your current shopping trip are stored locally on your device (`SharedPreferences` / `localStorage`) and can be cleared at
            any time by clearing app data or uninstalling the app.
          </li>
          <li>
            <strong>No sale of personal data:</strong> HeyBroc does not sell, rent, or share personal user data with data brokers or ad networks.
          </li>
        </ul>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 20 }}>3. Affiliate Links &amp; Subscriptions</h2>
        <p>
          When you tap a Clean Swap link to view an alternative product in your grocery store app or browser, the link may include retail affiliate
          attribution parameters (such as Walmart Impact or Amazon Associates tags). Subscription payments on the web are processed by Stripe; HeyBroc
          never receives or stores your raw credit card number.
        </p>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 20 }}>4. Non-Medical Disclaimer</h2>
        <p>
          HeyBroc scores reflect deterministic ingredient preferences (flagging synthetic dyes, industrial seed oils, high-fructose corn syrup,
          synthetic preservatives, nitrites, and artificial sweeteners). Scores are for informational grocery comparison only and do not constitute
          medical, nutritional, or allergen-safety advice. Always verify the physical product package before consumption.
        </p>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 20 }}>5. Contact &amp; Data Deletion Requests</h2>
        <p>
          For privacy questions, data inquiries, or support, contact the HeyBroc team at{" "}
          <a href="mailto:privacy@heybroc.com" style={{ color: "#0F7A4A", fontWeight: 600 }}>
            privacy@heybroc.com
          </a>
          .
        </p>
      </section>
    </main>
  );
}
