/**
 * Authoritative Terms of Service & Auto-Renewal Consent Versioning.
 * Kept in a dedicated isomorphic module so Next.js App Router pages (`app/terms/page.tsx`),
 * client components (`components/Paywall.tsx`), and server routes (`app/api/checkout/route.ts`)
 * share a single source of truth without violating Next.js page export rules.
 */

export const TERMS_VERSION = "2026-11-08";

/** Minimum 3-year statutory retention window for affirmative auto-renewal consent (Cal. Bus. & Prof. Code § 17602). */
export const CONSENT_RETENTION_SECONDS = 3 * 365 * 86400;
