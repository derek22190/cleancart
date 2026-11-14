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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function decodeBase64UrlJson<T>(segment: string): T | null {
  try {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const raw = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizeSha256(fingerprint: string): string {
  return fingerprint.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
}

function verifyAppleRetentionJws(
  parts: string[],
  header: AppleRetentionJwsHeader
): boolean {
  const allowUnsignedDev =
    process.env.APPLE_RETENTION_REQUIRE_X5C === "false" &&
    process.env.NODE_ENV !== "production";

  if (!Array.isArray(header.x5c) || header.x5c.length === 0) {
    return allowUnsignedDev;
  }
  if (header.alg !== "ES256" || header.x5c.length !== 3) {
    return false;
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
        return false;
      }
    }
    const [leafCert, intermediateCert, rootCert] = certs;
    if (!leafCert.verify(intermediateCert.publicKey)) {
      return false;
    }
    if (!intermediateCert.verify(rootCert.publicKey)) {
      return false;
    }
    if (!rootCert.verify(rootCert.publicKey)) {
      return false;
    }
    if (!rootCert.subject.includes("Apple Root CA")) {
      return false;
    }
    const expectedRootSha256 = (process.env.APPLE_ROOT_CA_SHA256 || "").trim();
    if (
      expectedRootSha256 &&
      normalizeSha256(rootCert.fingerprint256) !== normalizeSha256(expectedRootSha256)
    ) {
      return false;
    }

    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
    const sigNorm = parts[2].replace(/-/g, "+").replace(/_/g, "/");
    const sigBytes = Buffer.from(
      sigNorm.padEnd(Math.ceil(sigNorm.length / 4) * 4, "="),
      "base64"
    );
    return crypto.verify(
      "sha256",
      signingInput,
      { key: leafCert.publicKey, dsaEncoding: "ieee-p1363" },
      sigBytes
    );
  } catch {
    return false;
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
  let body: { signedPayload?: string };
  try {
    body = (await request.json()) as { signedPayload?: string };
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const signedPayload = (body.signedPayload || "").trim();
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

  if (!verifyAppleRetentionJws(parts, header)) {
    return NextResponse.json(
      { error: "Invalid Apple JWS signature." },
      { status: 401 }
    );
  }

  const expectedBundleId = (process.env.APPLE_BUNDLE_ID || "").trim();
  if (
    expectedBundleId &&
    claims.bundleId &&
    claims.bundleId !== expectedBundleId
  ) {
    return NextResponse.json(
      { error: "Bundle ID mismatch." },
      { status: 403 }
    );
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
