/**
 * HeyBroc — Shared Apple App Store X.509 Certificate Chain & ES256 JWS Verifier (`lib/apple-jws.ts`)
 * --------------------------------------------------------------------------------------------------
 * Verifies compact JWS tokens signed by Apple's App Store / StoreKit 2 infrastructure:
 *   1. StoreKit 2 `JWSTransaction` (`signedTransactionInfo` in `/api/apple/verify` & `/api/apple/webhook`)
 *   2. StoreKit 2 `JWSRenewalInfo` (`signedRenewalInfo` in `/api/apple/webhook`)
 *   3. App Store Server Notifications V2 (`signedPayload` in `/api/apple/webhook`)
 *   4. App Store Retention Messaging (`signedPayload` in `/api/apple/retention`)
 *
 * Pinned to Apple Root CA - G3 (`63:34:3A:BF:...`) & Apple Root CA G1 (`B0:B1:73:0E:...`)
 * with mandatory X.509 Basic Constraints (`CA:FALSE` leaf, `CA:TRUE` intermediates/root),
 * EC `prime256v1` leaf key check, certificate validity window enforcement, and Apple App Store
 * Leaf (`1.2.840.113635.100.6.11.1`) + WWDR Intermediate (`1.2.840.113635.100.6.2.1`) ASN.1 OIDs.
 */
import crypto from "node:crypto";
import { PRICING, type PlanId } from "@/lib/pricing";

export const APPLE_ROOT_FINGERPRINTS_SHA256 = new Set([
  // Apple Root CA - G3 (App Store Server & StoreKit 2 JWS root)
  "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79",
  // Apple Root CA (G1)
  "B0:B1:73:0E:CB:C7:FF:45:05:14:2C:49:F1:29:5E:6E:DA:6B:CA:ED:7E:2C:68:C5:BE:91:B5:A1:10:01:F0:24",
]);

// ASN.1 DER OIDs required on genuine Apple App Store / StoreKit JWS certificates:
// - Leaf OID 1.2.840.113635.100.6.11.1 (Mac App Store / App Store Receipt & JWS Signing)
// - Intermediate OID 1.2.840.113635.100.6.2.1 (Apple Worldwide Developer Relations CA)
const APPLE_APP_STORE_LEAF_OID_DER = Buffer.from("060a2a864886f76364060b01", "hex");
const APPLE_WWDR_INTERMEDIATE_OID_DER = Buffer.from("060a2a864886f76364060201", "hex");

function normalizeSha256Hex(fingerprint: string): string {
  return fingerprint.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
}

const PINNED_APPLE_ROOT_HEX = new Set(
  Array.from(APPLE_ROOT_FINGERPRINTS_SHA256, (fp) => normalizeSha256Hex(fp))
);

export interface AppleJwsHeader {
  alg?: string;
  x5c?: unknown;
}

export interface AppleTransactionClaims {
  transactionId?: string;
  originalTransactionId?: string;
  bundleId?: string;
  productId?: string;
  purchaseDate?: number;
  originalPurchaseDate?: number;
  expiresDate?: number;
  revocationDate?: number;
  revocationReason?: number;
  offerType?: number;
  offerDiscountType?: "FREE_TRIAL" | "PAY_AS_YOU_GO" | "PAY_UP_FRONT" | string;
  environment?: "Production" | "Sandbox" | "Xcode" | string;
  type?: string;
  inAppOwnershipType?: string;
  signedDate?: number;
  /** StoreKit 2 transaction price in milliunits of `currency` (e.g. `49990` = `$49.99` USD). */
  price?: number;
  currency?: string;
  appAccountToken?: string;
}

export interface AppleRenewalInfoClaims {
  originalTransactionId?: string;
  autoRenewProductId?: string;
  productId?: string;
  autoRenewStatus?: number;
  expirationIntent?: number;
  gracePeriodExpiresDate?: number;
  isInBillingRetryPeriod?: boolean;
  environment?: "Production" | "Sandbox" | "Xcode" | string;
  signedDate?: number;
}

export interface AppleNotificationV2Data {
  appAppleId?: number;
  bundleId?: string;
  bundleVersion?: string;
  environment?: "Production" | "Sandbox" | "Xcode" | string;
  signedTransactionInfo?: string;
  signedRenewalInfo?: string;
  status?: number;
}

export interface AppleNotificationV2Payload {
  notificationType?: string;
  subtype?: string;
  notificationUUID?: string;
  data?: AppleNotificationV2Data;
  version?: string;
  signedDate?: number;
}

export interface VerifyAppleJwsOptions {
  /** Allows `APPLE_ROOT_CA_SHA256` custom test root pin outside production (used by `/api/apple/webhook` & `/api/apple/retention`). */
  allowNonProdTestPin?: boolean;
  /** Allows `APPLE_STOREKIT_TEST_ROOT_SHA256` custom test root pin outside production (used by `/api/apple/verify` without relaxing `APPLE_ROOT_CA_SHA256`). */
  allowStoreKitTestPin?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeAppleJwsSegment<T>(segment: string): T | null {
  try {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const raw = Buffer.from(padded, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

export function verifyAppleAppStoreX5cJws(
  parts: string[],
  header: AppleJwsHeader,
  options?: VerifyAppleJwsOptions
): { ok: boolean; error?: string } {
  if (
    header.alg !== "ES256" ||
    !Array.isArray(header.x5c) ||
    header.x5c.length < 3 ||
    header.x5c.length > 6 ||
    !header.x5c.every((c): c is string => typeof c === "string" && c.trim().length > 0)
  ) {
    return {
      ok: false,
      error: "Apple JWS requires ES256 signature with a 3-to-6 certificate x5c chain.",
    };
  }
  if (!parts[2]) {
    return { ok: false, error: "Missing JWS signature segment." };
  }

  try {
    const certs = header.x5c.map(
      (b64) => new crypto.X509Certificate(Buffer.from(b64, "base64"))
    );
    const now = Date.now();
    const fingerprints = new Set<string>();
    for (const cert of certs) {
      const from = Date.parse(cert.validFrom);
      const to = Date.parse(cert.validTo);
      if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now > to) {
        return { ok: false, error: "Certificate in Apple x5c chain is expired or not yet valid." };
      }
      const fp = normalizeSha256Hex(cert.fingerprint256 || "");
      if (fp.length !== 64 || fingerprints.has(fp)) {
        return { ok: false, error: "Duplicate or malformed certificate in Apple x5c chain." };
      }
      fingerprints.add(fp);
    }

    const leafCert = certs[0];
    const rootCert = certs[certs.length - 1];
    // Enforce X.509 Basic Constraints: end-entity leaf must be CA:FALSE; all intermediates + root must be CA:TRUE.
    if (leafCert.ca || !certs.slice(1).every((c) => c.ca === true)) {
      return { ok: false, error: "Invalid X.509 Basic Constraints (CA) in Apple x5c chain." };
    }
    // Enforce NIST P-256 curve for ES256 leaf signing key.
    if (
      leafCert.publicKey.asymmetricKeyType !== "ec" ||
      leafCert.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    ) {
      return { ok: false, error: "Apple ES256 JWS leaf key must use EC prime256v1." };
    }

    for (let i = 0; i < certs.length - 1; i++) {
      if (!certs[i].verify(certs[i + 1].publicKey)) {
        return { ok: false, error: "Apple x5c intermediate certificate signature invalid." };
      }
    }
    if (!rootCert.verify(rootCert.publicKey)) {
      return { ok: false, error: "Apple x5c root certificate self-signature invalid." };
    }

    const rootFp = normalizeSha256Hex(rootCert.fingerprint256 || "");
    const isProduction = process.env.NODE_ENV === "production";
    const nonProdPin = options?.allowNonProdTestPin
      ? normalizeSha256Hex((process.env.APPLE_ROOT_CA_SHA256 || "").trim())
      : "";
    const storeKitTestPin = options?.allowStoreKitTestPin
      ? normalizeSha256Hex((process.env.APPLE_STOREKIT_TEST_ROOT_SHA256 || "").trim())
      : "";
    const customTestPin = !isProduction ? nonProdPin || storeKitTestPin : "";

    if (customTestPin) {
      if (customTestPin.length !== 64 || rootFp !== customTestPin) {
        return { ok: false, error: "Root CA does not match configured test pin." };
      }
    } else {
      if (!PINNED_APPLE_ROOT_HEX.has(rootFp)) {
        return { ok: false, error: "Untrusted root CA in Apple x5c chain." };
      }
      // Block third-party Apple Developer certs chaining to Apple Root G1/G3 by requiring App Store / WWDR JWS OIDs.
      if (
        !leafCert.raw.includes(APPLE_APP_STORE_LEAF_OID_DER) ||
        !certs[1].raw.includes(APPLE_WWDR_INTERMEDIATE_OID_DER)
      ) {
        return { ok: false, error: "Certificate chain lacks required Apple App Store JWS OIDs." };
      }
    }

    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
    const sigNorm = parts[2].replace(/-/g, "+").replace(/_/g, "/");
    const sigBytes = Buffer.from(
      sigNorm.padEnd(Math.ceil(sigNorm.length / 4) * 4, "="),
      "base64"
    );
    const sigValid = crypto.verify(
      "sha256",
      signingInput,
      { key: leafCert.publicKey, dsaEncoding: "ieee-p1363" },
      sigBytes
    );
    if (!sigValid) {
      return { ok: false, error: "Invalid Apple ES256 JWS signature." };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Failed verifying Apple x5c certificate chain." };
  }
}

export function verifyAppleSignedJws<T extends object = Record<string, unknown>>(
  jws: string,
  options?: VerifyAppleJwsOptions
): { ok: boolean; claims?: T; header?: AppleJwsHeader; error?: string } {
  const parts = (jws || "").trim().split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, error: "Malformed Apple JWS compact token." };
  }

  const header = decodeAppleJwsSegment<AppleJwsHeader>(parts[0]);
  const claims = decodeAppleJwsSegment<T>(parts[1]);
  if (!header || !claims) {
    return { ok: false, error: "Could not decode Apple JWS header or payload." };
  }

  const chainCheck = verifyAppleAppStoreX5cJws(parts, header, options);
  if (!chainCheck.ok) {
    return { ok: false, error: chainCheck.error };
  }
  return { ok: true, claims, header };
}

export function inferApplePlanFromProductId(
  productId?: string,
  fallback: PlanId = "annual"
): PlanId {
  const clean = (productId || "").trim().toLowerCase();
  if (!clean) return fallback;
  if (/(?:^|[_\-.])(month|monthly|mo|m)(?:$|[_\-.])/i.test(clean)) {
    return "monthly";
  }
  return "annual";
}

export function isAppleTrialTransaction(
  claims: Pick<AppleTransactionClaims, "offerDiscountType" | "offerType">
): boolean {
  return claims.offerDiscountType === "FREE_TRIAL" || claims.offerType === 1;
}

/**
 * Resolves gross USD paid for an Apple StoreKit 2 transaction.
 * Apple encodes `price` in milliunits of `currency` (e.g. `49990` = `$49.99` when `currency === "USD"`).
 * Falls back to `PRICING.monthly` (`$9.99`) or `PRICING.annual` (`$49.99`) when `!isFreeTrial` and `claims.price` is omitted.
 */
export function resolveAppleGrossUsd(
  claims: Pick<AppleTransactionClaims, "price" | "currency" | "offerDiscountType" | "offerType">,
  plan: PlanId,
  isFreeTrialOverride?: boolean
): number {
  const isFreeTrial = isFreeTrialOverride ?? isAppleTrialTransaction(claims);
  if (isFreeTrial) return 0;

  if (typeof claims.price === "number" && Number.isFinite(claims.price)) {
    if (claims.price <= 0) return 0;
    const currency = (claims.currency || "USD").trim().toUpperCase();
    if (currency === "USD") {
      return Math.round((claims.price / 1000) * 100) / 100;
    }
    return plan === "monthly" ? PRICING.monthly : PRICING.annual;
  }

  return plan === "monthly" ? PRICING.monthly : PRICING.annual;
}
