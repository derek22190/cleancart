import type { Metadata } from "next";
import Link from "next/link";
import { PRICING, TERMS_VERSION, annualPerMonth } from "@/lib/pricing";

export const metadata: Metadata = {
  title: "Terms of Service & Subscription Terms — HeyBroc",
  description:
    "Terms of Service for HeyBroc, covering automatic renewal subscriptions, free trials, self-serve cancellation, refunds, limitation of liability, and informational-opinion disclaimers.",
};

export default function TermsPage() {
  return (
    <main
      style={{
        maxWidth: 780,
        margin: "0 auto",
        padding: "48px 20px",
        fontFamily: "system-ui, sans-serif",
        lineHeight: 1.65,
        color: "#15201B",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/broc-mascot.jpg"
          alt="HeyBroc mascot"
          style={{
            width: 52,
            height: 52,
            borderRadius: 14,
            objectFit: "contain",
            background: "#fff",
            border: "1.5px solid rgba(15, 122, 74, 0.25)",
          }}
        />
        <div>
          <p
            style={{
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#0F7A4A",
              margin: 0,
            }}
          >
            HeyBroc · Terms of Service &amp; Subscription Agreement
          </p>
          <h1 style={{ fontSize: 28, margin: "4px 0 0" }}>
            Terms of Service &amp; Auto-Renewal Subscription Terms
          </h1>
        </div>
      </div>

      <p style={{ color: "#4A5550" }}>
        <strong>Effective Date:</strong> November 8, 2026 &nbsp;·&nbsp;{" "}
        <strong>Terms Version:</strong> {TERMS_VERSION} &nbsp;·&nbsp;{" "}
        <Link href="/" style={{ color: "#0F7A4A", fontWeight: 600 }}>
          ← Back to HeyBroc
        </Link>{" "}
        &nbsp;·&nbsp;{" "}
        <Link href="/privacy" style={{ color: "#0F7A4A", fontWeight: 600 }}>
          Privacy Policy
        </Link>
      </p>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 20 }}>1. Overview &amp; Acceptance of Terms</h2>
        <p>
          By accessing or using the HeyBroc web application (<code>heybroc.com</code>), browser extensions, iOS
          Shortcut/extension, or Android application (collectively, the &ldquo;Service&rdquo;), or by purchasing a
          HeyBroc Family Pro subscription, you agree to be bound by these Terms of Service (&ldquo;Terms&rdquo;) and
          our <Link href="/privacy" style={{ color: "#0F7A4A" }}>Privacy Policy</Link>.
        </p>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 20 }}>2. Subscriptions, Free Trials &amp; Automatic Renewal Disclosure</h2>
        <p>
          Core product ingredient scores (0–100) and additive explanations are available free of charge, along with a
          weekly allowance of {PRICING.freeWeeklySwaps} free clean swaps. Upgrading to <strong>HeyBroc Family Pro</strong>{" "}
          unlocks unlimited 1-for-1 clean swaps, whole-cart &ldquo;Swap All&rdquo; makeovers, and custom family
          watchlist multipliers.
        </p>
        <ul>
          <li>
            <strong>Plan Pricing:</strong> HeyBroc Family Pro is offered as an <strong>Annual Plan</strong> at{" "}
            <strong>${PRICING.annual.toFixed(2)}/year</strong> (${annualPerMonth.toFixed(2)}/month equivalent, billed
            annually) or a <strong>Monthly Plan</strong> at <strong>${PRICING.monthly.toFixed(2)}/month</strong> (billed
            monthly), plus applicable taxes.
          </li>
          <li>
            <strong>Free Trial Conversion:</strong> Eligible Annual Plan subscriptions include a{" "}
            <strong>{PRICING.trialDays}-day free trial</strong> (or a{" "}
            <strong>{PRICING.creatorTrialDays}-day free trial</strong> when a valid creator or friend referral code is
            applied at checkout). Unless you cancel before the end of your free trial period, your payment method on
            file will automatically be charged <strong>${PRICING.annual.toFixed(2)}</strong> on the final day of your
            trial for your first annual billing cycle.
          </li>
          <li>
            <strong>Continuous Automatic Renewal:</strong> Your subscription will <strong>automatically renew</strong>{" "}
            at the end of each billing cycle (every 12 months for Annual Plans at ${PRICING.annual.toFixed(2)}/year, or
            every month for Monthly Plans at ${PRICING.monthly.toFixed(2)}/month) unless and until you cancel prior to
            the renewal date. By checking the express auto-renewal consent box at checkout, you authorize recurring
            charges to your payment method via Stripe (or Apple App Store / Google Play for in-app purchases).
          </li>
        </ul>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 20 }}>3. How to Cancel Your Subscription Anytime</h2>
        <p>
          You may cancel your HeyBroc Family Pro subscription at any time without penalty before your trial ends or
          before your next billing period renews:
        </p>
        <ul>
          <li>
            <strong>Web, Android &amp; Browser Extension (Stripe Subscriptions):</strong> Click{" "}
            <strong>&ldquo;Manage / Cancel Subscription&rdquo;</strong> in the HeyBroc web header/account menu, inside
            the browser extension popup, or in the Android app Settings screen to open the self-serve{" "}
            <strong>Stripe Customer Billing Portal</strong>, where you can cancel your subscription immediately in one
            click, update your payment method, or download invoices.
          </li>
          <li>
            <strong>Apple App Store / Google Play Subscriptions:</strong> If you subscribed via Apple in-app purchase
            or Google Play Billing, manage or cancel your subscription directly in your device&apos;s{" "}
            <em>Apple ID Subscriptions</em> or <em>Google Play Subscriptions</em> settings.
          </li>
          <li>
            <strong>Email Support Cancellation:</strong> You may also request cancellation at any time by emailing{" "}
            <a href="mailto:billing@heybroc.com" style={{ color: "#0F7A4A", fontWeight: 600 }}>
              billing@heybroc.com
            </a>{" "}
            with the email address used at checkout.
          </li>
        </ul>
        <p>
          When you cancel, you will retain Pro access through the end of your current paid billing period (or free trial
          period), and no further recurring charges will be made.
        </p>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 20 }}>4. Refund Policy</h2>
        <p>
          If you forget to cancel before a trial converts or an annual renewal occurs, you may request a full refund
          within <strong>14 days</strong> of the charge by contacting{" "}
          <a href="mailto:billing@heybroc.com" style={{ color: "#0F7A4A", fontWeight: 600 }}>
            billing@heybroc.com
          </a>
          . Upon issuance of a full refund, your HeyBroc Family Pro subscription entitlement is immediately canceled and
          reverted to the free plan. Statutory refund rights under applicable state or consumer protection laws are not
          affected by this policy.
        </p>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 20 }}>
          5. Informational Opinion, No Medical or Allergen Advice &amp; Physical Label Verification
        </h2>
        <p>
          <strong>Subjective Clean-Label Opinion:</strong> HeyBroc 0–100 product scores, color tiers, additive flags,
          and swap recommendations express HeyBroc&apos;s editorial clean-label methodology and consumer opinion
          regarding food processing, synthetic dyes, refined seed oils, high-fructose corn syrup, preservatives, and
          sweeteners. A low score or flagged ingredient does <strong>not</strong> mean a product is unsafe, adulterated,
          defective, or unlawful.
        </p>
        <p>
          <strong>Not Medical, Glycemic, or Allergen Advice:</strong> The Service is provided strictly for general
          informational and educational comparison. Nothing in HeyBroc constitutes medical advice, clinical nutrition
          counseling, diabetes or blood-glucose management advice, or food-allergen safety certification. Dietary and
          allergen alerts are best-effort keyword aids and <strong>cannot</strong> guarantee the absence of any allergen
          or cross-contamination.
        </p>
        <p>
          <strong>Always Verify the Physical Package Label:</strong> Product ingredient lists and nutrition facts come
          from third-party open databases (Open Food Facts under ODbL, USDA FoodData Central) and dated manufacturer
          reference records. Manufacturers reformulate products, vary recipes by region or package size, and update
          labels without notice. <strong>You must always inspect the physical product packaging and ingredient statement
          before purchasing or consuming any item.</strong>
        </p>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 20 }}>6. Affiliate Links &amp; Third-Party Retailers</h2>
        <p>
          Certain Clean Swap links on the web and approved mobile surfaces include retail affiliate attribution
          parameters (such as Amazon Associates or Walmart Impact links) and are labeled with{" "}
          <code>· paid link</code>. When you purchase through an affiliate link, HeyBroc may earn a small commission at
          no extra cost to you. As an Amazon Associate, HeyBroc earns from qualifying purchases. HeyBroc is independent
          and is not affiliated with, endorsed by, or sponsored by any grocery retailer or food manufacturer.
        </p>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 20 }}>7. Limitation of Liability &amp; Disclaimer of Warranties</h2>
        <p>
          THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; WITHOUT WARRANTIES OF ANY KIND,
          EITHER EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
          PARTICULAR PURPOSE, ACCURACY OF INGREDIENT DATA, OR NON-INFRINGEMENT. TO THE MAXIMUM EXTENT PERMITTED BY
          APPLICABLE LAW, HEYBROC AND ITS OPERATORS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
          CONSEQUENTIAL, OR EXEMPLARY DAMAGES, OR FOR ANY ALLERGIC REACTION, DIETARY INCIDENT, OR PURCHASING DECISION
          ARISING FROM RELIANCE ON THE SERVICE. IN NO EVENT SHALL HEYBROC&apos;S TOTAL AGGREGATE LIABILITY EXCEED THE
          GREATER OF (A) THE AMOUNT YOU PAID TO HEYBROC IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM OR (B) TWENTY-FIVE
          U.S. DOLLARS ($25.00).
        </p>
      </section>

      <section style={{ marginTop: 28 }}>
        <h2 style={{ fontSize: 20 }}>8. Contact &amp; Label Correction Notices</h2>
        <p>
          For billing support, cancellation assistance, manufacturer label updates, or legal inquiries, contact{" "}
          <a href="mailto:privacy@heybroc.com" style={{ color: "#0F7A4A", fontWeight: 600 }}>
            privacy@heybroc.com
          </a>
          .
        </p>
      </section>
    </main>
  );
}
