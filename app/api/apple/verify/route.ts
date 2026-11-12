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

const APPLE_ROOT_FINGERPRINTS_SHA256 = new Set([
  // Apple Root CA - G3 (App Store Server & StoreKit 2 JWS root)
  "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79",
  // Apple Root CA (G1)
  "B0:B1:73:0E:CB:C7:FF:45:05:14:2C:49:F1:29:5E:6E:DA:6B:CA:ED:7E:2C:68:C5:BE:91:B5:A1:10:01:F0:24",
]);

interface StoreKitJwsHeader {
  alg?: string;
  x5c?: string[];
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
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function verifyAppleStoreKitJws(
  jws: string
): { ok: boolean; claims?: StoreKitTransactionPayload; error?: string } {
  const parts = jws.trim().split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, error: "Malformed StoreKit 2 JWS compact token." };
  }

  const header = decodeBase64UrlJson<StoreKitJwsHeader>(parts[0]);
  const claims = decodeBase64UrlJson<StoreKitTransactionPayload>(parts[1]);
  if (!header || !claims) {
    return { ok: false, error: "Could not decode StoreKit 2 JWS header or payload." };
  }
  if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length < 3) {
    return {
      ok: false,
      error: "StoreKit 2 JWS requires ES256 signature with full Apple x5c certificate chain.",
    };
  }

  try {
    const certs = header.x5c.map(
      (b64) => new crypto.X509Certificate(Buffer.from(b64, "base64"))
    );
    for (let i = 0; i < certs.length - 1; i++) {
      if (!certs[i].verify(certs[i + 1].publicKey)) {
        return { ok: false, error: "Apple x5c intermediate certificate signature invalid." };
      }
    }
    const rootCert = certs[certs.length - 1];
    if (!rootCert.verify(rootCert.publicKey)) {
      return { ok: false, error: "Apple x5c root certificate self-signature invalid." };
    }
    const rootFp = (rootCert.fingerprint256 || "").toUpperCase();
    if (!APPLE_ROOT_FINGERPRINTS_SHA256.has(rootFp)) {
      return { ok: false, error: "Untrusted root CA in StoreKit 2 x5c chain." };
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
      { key: certs[0].publicKey, dsaEncoding: "ieee-p1363" },
      sigBytes
    );
    if (!sigValid) {
      return { ok: false, error: "Invalid StoreKit 2 ES256 transaction signature." };
    }

    return { ok: true, claims };
  } catch {
    return { ok: false, error: "Failed verifying Apple StoreKit 2 certificate chain." };
  }
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
    body = (await request.json()) as {
      signedTransactionInfo?: string;
      deviceId?: string;
      token?: string;
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
