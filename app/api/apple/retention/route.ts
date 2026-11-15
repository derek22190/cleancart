/**
 * HeyBroc — Apple App Store Real-Time Subscription Retention Messaging Endpoint
 * (`POST /api/apple/retention`)
 * -----------------------------------------------------------------------------
 * Implements Apple's `Get Retention Message` specification (`RealtimeRequestBody` -> `RealtimeResponseBody`)
 * with HeyBroc's Zero-Leakage Retention policy:
 *
 * 1. Free-Trial Subscribers (`status === "trialing"` or unpaid):
 *    -> Returns a personalized value reminder `message` ONLY ($0 discount, zero coupon leakage).
 * 2. Annual Subscribers (`productId` contains `annual` / `year` or `record.plan === "annual"`):
 *    -> Returns `alternateProduct` offering a flexible switch to `com.heybroc.pro.monthly`.
 * 3. Paid Monthly Subscribers (`status === "active"` && `lastChargeSucceeded === true`):
 *    -> Returns `alternateProduct` offering the Annual plan (`com.heybroc.pro.annual`).
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import {
  evaluateZeroLeakageRetentionEligibility,
  getSubscriptionEntitlement,
} from "@/lib/entitlements";
import { APPLE_ROOT_FINGERPRINTS_SHA256 } from "../verify/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SIGNED_DATE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SIGNED_DATE_FUTURE_SKEW_MS = 5 * 60 * 1000;

interface AppleRetentionJwsHeader {
  alg?: string;
  x5c?: string[];
}

interface AppleRealtimeRequestPayload {
  appAppleId?: number;
  bundleId?: string;
  environment?: "Production" | "Sandbox" | "Xcode" | string;
  locale?: string;
  originalTransactionId?: string;
  productId?: string;
  signedDate?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64UrlJson<T>(segment: string): T | null {
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

function normalizeSha256Hex(fingerprint: string): string {
  return fingerprint.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
}

const PINNED_APPLE_ROOT_HEX = new Set(
  Array.from(APPLE_ROOT_FINGERPRINTS_SHA256, (fp) => normalizeSha256Hex(fp))
);

function verifyAppleRetentionJws(
  parts: string[],
  header: AppleRetentionJwsHeader
): { ok: boolean; usedX5c: boolean } {
  const isProduction = process.env.NODE_ENV === "production";
  const allowUnsignedDev =
    process.env.APPLE_RETENTION_REQUIRE_X5C === "false" && !isProduction;

  if (!Array.isArray(header.x5c) || header.x5c.length === 0) {
    return { ok: allowUnsignedDev, usedX5c: false };
  }
  if (
    header.alg !== "ES256" ||
    header.x5c.length !== 3 ||
    !header.x5c.every((c) => typeof c === "string" && c.trim().length > 0)
  ) {
    return { ok: false, usedX5c: true };
  }
  try {
    const certs = header.x5c.map(
      (b64) => new crypto.X509Certificate(Buffer.from(b64, "base64"))
    );
    const now = Date.now();
    for (const cert of certs) {
      const from = Date.parse(cert.validFrom);
      const to = Date.parse(cert.validTo);
      if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now > to) {
        return { ok: false, usedX5c: true };
      }
    }
    const [leafCert, intermediateCert, rootCert] = certs;
    const leafFp = normalizeSha256Hex(leafCert.fingerprint256 || "");
    const intFp = normalizeSha256Hex(intermediateCert.fingerprint256 || "");
    const rootFp = normalizeSha256Hex(rootCert.fingerprint256 || "");
    if (!leafFp || !intFp || !rootFp) {
      return { ok: false, usedX5c: true };
    }
    // Prevent repeated self-signed certificates in x5c and enforce X.509 Basic Constraints (CA vs end-entity).
    if (leafFp === intFp || intFp === rootFp || leafFp === rootFp) {
      return { ok: false, usedX5c: true };
    }
    if (leafCert.ca || !intermediateCert.ca || !rootCert.ca) {
      return { ok: false, usedX5c: true };
    }
    // Enforce ES256 key type and NIST P-256 curve (reject P-384 / P-521 / RSA under alg=ES256).
    if (
      leafCert.publicKey.asymmetricKeyType !== "ec" ||
      leafCert.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    ) {
      return { ok: false, usedX5c: true };
    }
    if (!leafCert.verify(intermediateCert.publicKey)) {
      return { ok: false, usedX5c: true };
    }
    if (!intermediateCert.verify(rootCert.publicKey)) {
      return { ok: false, usedX5c: true };
    }
    if (!rootCert.verify(rootCert.publicKey)) {
      return { ok: false, usedX5c: true };
    }

    // Production ALWAYS requires Apple's official Root CA G1/G3 SHA-256 fingerprints.
    // Non-production tests may supply an explicit 64-hex-char APPLE_ROOT_CA_SHA256 pin override.
    const customTestPin = !isProduction
      ? normalizeSha256Hex((process.env.APPLE_ROOT_CA_SHA256 || "").trim())
      : "";
    if (customTestPin) {
      if (customTestPin.length !== 64 || rootFp !== customTestPin) {
        return { ok: false, usedX5c: true };
      }
    } else if (!PINNED_APPLE_ROOT_HEX.has(rootFp)) {
      return { ok: false, usedX5c: true };
    }

    if (!parts[2]) {
      return { ok: false, usedX5c: true };
    }
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
    const sigNorm = parts[2].replace(/-/g, "+").replace(/_/g, "/");
    const sigBytes = Buffer.from(
      sigNorm.padEnd(Math.ceil(sigNorm.length / 4) * 4, "="),
      "base64"
    );
    const sigOk = crypto.verify(
      "sha256",
      signingInput,
      { key: leafCert.publicKey, dsaEncoding: "ieee-p1363" },
      sigBytes
    );
    return { ok: sigOk, usedX5c: true };
  } catch {
    return { ok: false, usedX5c: true };
  }
}

function inferApplePlan(productId?: string): "annual" | "monthly" {
  const clean = (productId || "").trim().toLowerCase();
  if (/(?:^|[_\-.])(month|monthly|mo|m)(?:$|[_\-.])/i.test(clean)) {
    return "monthly";
  }
  return "annual";
}

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }
  if (!isPlainObject(rawBody) || typeof rawBody.signedPayload !== "string") {
    return NextResponse.json(
      { error: "Missing or malformed signedPayload JWS." },
      { status: 400 }
    );
  }

  const signedPayload = rawBody.signedPayload.trim();
  const parts = signedPayload.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    return NextResponse.json(
      { error: "Missing or malformed signedPayload JWS." },
      { status: 400 }
    );
  }

  const header = decodeBase64UrlJson<AppleRetentionJwsHeader>(parts[0]);
  const claims = decodeBase64UrlJson<AppleRealtimeRequestPayload>(parts[1]);
  if (!header || !claims) {
    return NextResponse.json(
      { error: "Unable to decode signedPayload claims." },
      { status: 400 }
    );
  }

  const verification = verifyAppleRetentionJws(parts, header);
  if (!verification.ok) {
    return NextResponse.json(
      { error: "Invalid Apple JWS signature." },
      { status: 401 }
    );
  }

  const isProduction = process.env.NODE_ENV === "production";
  const configuredBundleId = (process.env.APPLE_BUNDLE_ID || "").trim();
  const expectedBundleId = configuredBundleId || "com.heybroc.app";
  if (verification.usedX5c || isProduction || claims.bundleId !== undefined) {
    if (
      typeof claims.bundleId !== "string" ||
      claims.bundleId.trim() !== expectedBundleId
    ) {
      return NextResponse.json(
        { error: "Bundle ID mismatch." },
        { status: 403 }
      );
    }
  }

  if (verification.usedX5c || isProduction || claims.signedDate !== undefined) {
    if (typeof claims.signedDate !== "number" || !Number.isFinite(claims.signedDate)) {
      return NextResponse.json(
        { error: "Missing or invalid signedDate claim." },
        { status: 401 }
      );
    }
    const signedMs =
      claims.signedDate > 1e9 && claims.signedDate < 1e11
        ? claims.signedDate * 1000
        : claims.signedDate;
    const now = Date.now();
    if (
      signedMs < now - MAX_SIGNED_DATE_AGE_MS ||
      signedMs > now + MAX_SIGNED_DATE_FUTURE_SKEW_MS
    ) {
      return NextResponse.json(
        { error: "Stale or future-dated Apple JWS signedDate." },
        { status: 401 }
      );
    }
  }

  const valueMessageId =
    (process.env.APPLE_RETENTION_MSG_VALUE_ID || "").trim() ||
    "00000000-0000-4000-8000-000000000001";
  const switchMonthlyMessageId =
    (process.env.APPLE_RETENTION_MSG_SWITCH_MONTHLY_ID || "").trim() ||
    "00000000-0000-4000-8000-000000000002";
  const loyaltyAnnualMessageId =
    (process.env.APPLE_RETENTION_MSG_LOYALTY_ANNUAL_ID || "").trim() ||
    "00000000-0000-4000-8000-000000000003";

  const monthlyProductId =
    (process.env.APPLE_MONTHLY_PRODUCT_ID || "").trim() ||
    "com.heybroc.pro.monthly";
  const annualProductId =
    (process.env.APPLE_ANNUAL_PRODUCT_ID || "").trim() ||
    "com.heybroc.pro.annual";

  const origTxId = (claims.originalTransactionId || "").trim();
  const storedRecord = origTxId
    ? await getSubscriptionEntitlement(`rc_${origTxId}`).catch(() => null)
    : null;

  const inferredPlan = storedRecord?.plan || inferApplePlan(claims.productId);
  const eligibility = storedRecord
    ? evaluateZeroLeakageRetentionEligibility(storedRecord)
    : null;

  // 1. ZERO-LEAKAGE TRIAL GUARD: Free-trialing or unverified-charge subscribers NEVER receive discounts
  if (!storedRecord || storedRecord.status === "trialing") {
    // Annual trialers can still downshift to flexible standard Monthly at full public price ($0 discount leakage)
    if (storedRecord?.status === "trialing" && inferredPlan === "annual") {
      return NextResponse.json(
        {
          alternateProduct: {
            messageIdentifier: switchMonthlyMessageId,
            productId: monthlyProductId,
          },
        },
        { status: 200 }
      );
    }
    return NextResponse.json(
      {
        message: {
          messageIdentifier: valueMessageId,
        },
      },
      { status: 200 }
    );
  }

  // 2. PAID MONTHLY SUBSCRIBERS -> Alternate Product switch to Annual (best value, zero trial-hunter leakage)
  if (
    inferredPlan === "monthly" &&
    (eligibility?.canLoyaltyAnnual39 || storedRecord.lastChargeSucceeded === true)
  ) {
    return NextResponse.json(
      {
        alternateProduct: {
          messageIdentifier: loyaltyAnnualMessageId,
          productId: annualProductId,
        },
      },
      { status: 200 }
    );
  }

  // 3. PAID ANNUAL SUBSCRIBERS -> Alternate Product switch to flexible Monthly renewal
  if (inferredPlan === "annual") {
    return NextResponse.json(
      {
        alternateProduct: {
          messageIdentifier: switchMonthlyMessageId,
          productId: monthlyProductId,
        },
      },
      { status: 200 }
    );
  }

  return NextResponse.json(
    {
      message: {
        messageIdentifier: valueMessageId,
      },
    },
    { status: 200 }
  );
}
