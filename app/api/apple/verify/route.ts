/**
 * HeyBroc — Direct StoreKit 2 JWS Transaction Verification (`/api/apple/verify`)
 * ------------------------------------------------------------------------------
 * Verifies Apple StoreKit 2 `VerificationResult<Transaction>.jwsRepresentation`
 * directly against Apple's `x5c` X.509 certificate chain pinned to Apple Root CA - G3
 * (SHA-256 `63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79`)
 * and saves the cross-platform Family Pro entitlement immediately across iOS, Android & Web.
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getAuthenticatedUser, saveUser } from "@/lib/auth";
import {
  normalizeRealDeviceId,
  saveEntitlement,
  type EntitlementStatus,
} from "@/lib/entitlements";
import type { PlanId } from "@/lib/pricing";
import { checkRateLimitAsync } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

interface StoreKitTransactionPayload {
  transactionId?: string;
  originalTransactionId?: string;
  bundleId?: string;
  productId?: string;
  purchaseDate?: number;
  originalPurchaseDate?: number;
  expiresDate?: number;
  revocationDate?: number;
  offerType?: number;
  offerDiscountType?: "FREE_TRIAL" | "PAY_AS_YOU_GO" | "PAY_UP_FRONT" | string;
  environment?: "Production" | "Sandbox" | "Xcode" | string;
  type?: string;
  inAppOwnershipType?: string;
  signedDate?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "anon"
  );
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

export function verifyAppleAppStoreX5cJws(
  parts: string[],
  header: AppleJwsHeader,
  options?: { allowNonProdTestPin?: boolean }
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
    const customTestPin =
      options?.allowNonProdTestPin && !isProduction
        ? normalizeSha256Hex((process.env.APPLE_ROOT_CA_SHA256 || "").trim())
        : "";

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

function verifyAppleStoreKitJws(
  jws: string
): { ok: boolean; claims?: StoreKitTransactionPayload; error?: string } {
  const parts = jws.trim().split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, error: "Malformed StoreKit 2 JWS compact token." };
  }

  const header = decodeBase64UrlJson<AppleJwsHeader>(parts[0]);
  const claims = decodeBase64UrlJson<StoreKitTransactionPayload>(parts[1]);
  if (!header || !claims) {
    return { ok: false, error: "Could not decode StoreKit 2 JWS header or payload." };
  }

  const chainCheck = verifyAppleAppStoreX5cJws(parts, header, { allowNonProdTestPin: false });
  if (!chainCheck.ok) {
    return { ok: false, error: chainCheck.error };
  }
  return { ok: true, claims };
}

function inferPlanFromProductId(productId?: string): PlanId {
  const clean = (productId || "").trim().toLowerCase();
  if (/(?:^|[_\-.])(month|monthly|mo|m)(?:$|[_\-.])/i.test(clean)) {
    return "monthly";
  }
  return "annual";
}

export async function POST(request: Request) {
  if (!(await checkRateLimitAsync(`apple-verify:${getClientIp(request)}`, 30))) {
    return NextResponse.json(
      { ok: false, error: "Too many StoreKit verification requests. Please wait a moment." },
      { status: 429 }
    );
  }

  let body: {
    signedTransactionInfo?: string;
    deviceId?: string;
    token?: string;
  };
  try {
    const rawText = await request.text();
    if (rawText.length > 32_000) {
      return NextResponse.json(
        { ok: false, error: "Payload too large." },
        { status: 413 }
      );
    }
    const parsed: unknown = JSON.parse(rawText);
    if (!isPlainObject(parsed) || typeof parsed.signedTransactionInfo !== "string") {
      return NextResponse.json(
        { ok: false, error: "Missing signedTransactionInfo." },
        { status: 400 }
      );
    }
    body = {
      signedTransactionInfo: parsed.signedTransactionInfo,
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : undefined,
      token: typeof parsed.token === "string" ? parsed.token : undefined,
    };
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON payload." },
      { status: 400 }
    );
  }

  const jws = (body.signedTransactionInfo || "").trim();
  if (!jws) {
    return NextResponse.json(
      { ok: false, error: "Missing signedTransactionInfo." },
      { status: 400 }
    );
  }

  const verified = verifyAppleStoreKitJws(jws);
  if (!verified.ok || !verified.claims) {
    return NextResponse.json(
      { ok: false, error: verified.error || "Invalid StoreKit transaction." },
      { status: 401 }
    );
  }

  const claims = verified.claims;
  const expectedBundleId = (process.env.APPLE_BUNDLE_ID || "com.heybroc.app").trim();
  if (claims.bundleId !== expectedBundleId) {
    return NextResponse.json(
      { ok: false, error: "StoreKit bundleId mismatch." },
      { status: 403 }
    );
  }

  const origTxId = String(claims.originalTransactionId || claims.transactionId || "").trim();
  if (!origTxId) {
    return NextResponse.json(
      { ok: false, error: "Missing StoreKit transactionId." },
      { status: 400 }
    );
  }

  const now = Date.now();
  if (typeof claims.revocationDate === "number" && claims.revocationDate > 0) {
    return NextResponse.json(
      { ok: false, active: false, error: "This App Store subscription was refunded or revoked." },
      { status: 403 }
    );
  }

  const expiresAtMs =
    typeof claims.expiresDate === "number" && claims.expiresDate > 0
      ? claims.expiresDate
      : now + 30 * 24 * 60 * 60 * 1000;
  if (expiresAtMs <= now) {
    return NextResponse.json({
      ok: true,
      active: false,
      status: "canceled",
      expiresAtMs,
    });
  }

  const authHeader = request.headers.get("authorization") || "";
  const sessionToken =
    (authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "") ||
    (body.token || "").trim();
  const authedUser = sessionToken ? await getAuthenticatedUser(sessionToken) : null;
  const cleanDeviceId = normalizeRealDeviceId(body.deviceId) || undefined;

  const isFreeTrial =
    claims.offerDiscountType === "FREE_TRIAL" || claims.offerType === 1;
  const status: EntitlementStatus = isFreeTrial ? "trialing" : "active";
  const plan = inferPlanFromProductId(claims.productId);
  const subscriptionId = `apple_${origTxId}`;
  const sessionId = `apple_tx_${String(claims.transactionId || origTxId).trim()}`;

  await saveEntitlement({
    sessionId,
    subscriptionId,
    customerEmail: authedUser?.email,
    deviceId: cleanDeviceId,
    userId: authedUser?.userId,
    plan,
    status,
    active: true,
    expiresAtMs,
    lastChargeSucceeded: !isFreeTrial,
    updatedAt: new Date(now).toISOString(),
  });

  if (authedUser) {
    const nextProUntil = Math.max(authedUser.proUntil || 0, expiresAtMs);
    if (nextProUntil > (authedUser.proUntil || 0)) {
      authedUser.proUntil = nextProUntil;
      await saveUser(authedUser).catch(() => {});
    }
  }

  return NextResponse.json({
    ok: true,
    active: true,
    plan,
    status,
    expiresAtMs,
    subscriptionId,
  });
}
