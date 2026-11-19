import type { Metadata } from "next";
import Link from "next/link";
import DeleteAccountClient from "./DeleteAccountClient";

export const metadata: Metadata = {
  title: "Delete Your HeyBroc Account & Data",
  description:
    "Request permanent deletion of your HeyBroc account, synced Family Watchlist, and associated cloud profile data from the web without reinstalling the app.",
  alternates: {
    canonical: "https://www.heybroc.com/delete-account",
  },
};

export default function DeleteAccountPage() {
  return (
    <main
      style={{
        maxWidth: 760,
        margin: "0 auto",
        padding: "48px 20px",
        fontFamily: "system-ui, sans-serif",
        lineHeight: 1.65,
        color: "#15201B",
      }}
    >
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
        HeyBroc · Account &amp; Data Deletion
      </p>
      <h1 style={{ fontSize: 28, margin: "6px 0 12px" }}>
        Delete Your HeyBroc Account &amp; Associated Data
      </h1>
      <p style={{ color: "#4A5550", marginTop: 0 }}>
        You can permanently delete your HeyBroc account directly from this web page at any time (even if you have
        already uninstalled the iPhone or Android app), or inside the app under <strong>Account → Delete Account</strong>.
      </p>

      <DeleteAccountClient />

      <section style={{ marginTop: 30 }}>
        <h2 style={{ fontSize: 19 }}>What Data Is Deleted Immediately</h2>
        <ul>
          <li>Your HeyBroc user profile (email address, display name, and hashed password).</li>
          <li>All active web and mobile session tokens and linked Sign in with Apple authorization tokens.</li>
          <li>Your synced Family Watchlist, allergen alerts, and account-linked device associations.</li>
        </ul>
      </section>

      <section style={{ marginTop: 22 }}>
        <h2 style={{ fontSize: 19 }}>What Data May Be Retained &amp; Subscription Cancellation</h2>
        <ul>
          <li>
            <strong>App Store / Google Play / Stripe Subscriptions:</strong> Deleting your HeyBroc account does not
            automatically cancel recurring billing managed by Apple or Google. Please cancel active subscriptions in{" "}
            <em>iPhone Settings → Apple ID → Subscriptions</em>, <em>Google Play → Payments &amp; subscriptions</em>, or
            the Stripe Billing Portal.
          </li>
          <li>
            <strong>Statutory billing &amp; consent logs:</strong> Payment transaction records and affirmative
            auto-renewal consent timestamps may be retained for up to 400 days (billing lookup) and up to 5 years
            (auto-renewal recordkeeping) as required by law and described in our{" "}
            <Link href="/privacy" style={{ color: "#0F7A4A", fontWeight: 600 }}>
              Privacy Policy
            </Link>
            .
          </li>
        </ul>
      </section>

      <section style={{ marginTop: 22 }}>
        <h2 style={{ fontSize: 19 }}>Need Help or Want to Delete Anonymous Device Data?</h2>
        <p>
          If you used HeyBroc without creating an account, clearing app storage or uninstalling HeyBroc resets your
          install-scoped random <code>deviceId</code> on device (unactivated device records expire automatically after
          7 days). For manual account or device-record deletion assistance, email{" "}
          <a href="mailto:privacy@heybroc.com" style={{ color: "#0F7A4A", fontWeight: 600 }}>
            privacy@heybroc.com
          </a>{" "}
          from the email address associated with your account.
        </p>
      </section>
    </main>
  );
}
