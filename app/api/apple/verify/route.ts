/**
 * HeyBroc — Direct StoreKit 2 JWS Transaction Verification (`/api/apple/verify`)
 * ------------------------------------------------------------------------------
 * Verifies Apple StoreKit 2 `VerificationResult<Transaction>.jwsRepresentation`
 * directly against Apple's `x5c` X.509 certificate chain pinned to Apple Root CA - G3
 * (SHA-256 `63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79`),
 * attributes optional creator affiliate codes (first paid billing cycle only) or friend invite codes,
 * and saves the cross-platform Family Pro entitlement immediately across iOS, Android & Web.
 */
import { NextResponse } from "next/server";
import {
  APPLE_ROOT_FINGERPRINTS_SHA256,
  inferApplePlanFromProductId,
  isAppleTrialTransaction,
  resolveAppleGrossUsd,
  verifyAppleAppStoreX5cJws,
  verifyAppleSignedJws,
  type AppleJwsHeader,
  type AppleTransactionClaims,
} from "@/lib/apple-jws";
import { getAuthenticatedUser, saveUser } from "@/lib/auth";
import {
  getSubscriptionEntitlement,
  normalizeRealDeviceId,
  saveEntitlement,
  type EntitlementStatus,
} from "@/lib/entitlements";
import {
  getCreator,
  normalizeCode,
  recordStripeCreatorConversionOnce,
} from "@/lib/influencers";
import { applyOrActivateReferral } from "@/lib/referrals";
import { checkRateLimitAsync } from "@/lib/scan";

export {
  APPLE_ROOT_FINGERPRINTS_SHA256,
  verifyAppleAppStoreX5cJws,
  verifyAppleSignedJws,
  type AppleJwsHeader,
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function verifyAppleStoreKitJws(
  jws: string
): { ok: boolean; claims?: AppleTransactionClaims; error?: string } {
  return verifyAppleSignedJws<AppleTransactionClaims>(jws, {
    allowNonProdTestPin: false,
    allowStoreKitTestPin: true,
  });
}

export async function POST(request: Request) {
  if (!(await checkRateLimitAsync(`apple-verify:${getClientIp(request)}`, 30))) {
    return NextResponse.json(
      {
        ok: false,
        error: "Too many StoreKit verification requests. Please wait a moment.",
      },
      { status: 429 }
    );
  }

  let body: {
    signedTransactionInfo?: string;
    deviceId?: string;
    token?: string;
    creatorCode?: string;
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
    if (
      !isPlainObject(parsed) ||
      typeof parsed.signedTransactionInfo !== "string"
    ) {
      return NextResponse.json(
        { ok: false, error: "Missing signedTransactionInfo." },
        { status: 400 }
      );
    }
    body = {
      signedTransactionInfo: parsed.signedTransactionInfo,
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : undefined,
      token: typeof parsed.token === "string" ? parsed.token : undefined,
      creatorCode:
        typeof parsed.creatorCode === "string" ? parsed.creatorCode : undefined,
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
  const expectedBundleId = (
    process.env.APPLE_BUNDLE_ID || "com.heybroc.app"
  ).trim();
  if (claims.bundleId !== expectedBundleId) {
    return NextResponse.json(
      { ok: false, error: "StoreKit bundleId mismatch." },
      { status: 403 }
    );
  }

  const claimEnv = String(claims.environment || "").trim();
  if (
    process.env.NODE_ENV === "production" &&
    process.env.APPLE_ALLOW_SANDBOX_IN_PRODUCTION !== "true" &&
    (claimEnv === "Sandbox" || claimEnv === "Xcode")
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: "Sandbox StoreKit transactions are not accepted in production.",
      },
      { status: 403 }
    );
  }

  const allowedProductIds = new Set(
    [
      "com.heybroc.pro.annual",
      "com.heybroc.pro.monthly",
      "heybroc_pro_annual",
      "heybroc_pro_monthly",
      ...(process.env.APPLE_PRODUCT_IDS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ].map((s) => s.toLowerCase())
  );
  const claimProductId = String(claims.productId || "").trim().toLowerCase();
  if (!claimProductId || !allowedProductIds.has(claimProductId)) {
    return NextResponse.json(
      { ok: false, error: "Unrecognized App Store subscription productId." },
      { status: 403 }
    );
  }

  const origTxId = String(
    claims.originalTransactionId || claims.transactionId || ""
  ).trim();
  if (!origTxId) {
    return NextResponse.json(
      { ok: false, error: "Missing StoreKit transactionId." },
      { status: 400 }
    );
  }

  const now = Date.now();
  if (typeof claims.revocationDate === "number" && claims.revocationDate > 0) {
    return NextResponse.json(
      {
        ok: false,
        active: false,
        error: "This App Store subscription was refunded or revoked.",
      },
      { status: 403 }
    );
  }

  if (
    typeof claims.expiresDate !== "number" ||
    !Number.isFinite(claims.expiresDate) ||
    claims.expiresDate <= 0
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: "StoreKit subscription transaction is missing a valid expiresDate.",
      },
      { status: 400 }
    );
  }
  const expiresAtMs = claims.expiresDate;
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
  const authedUser = sessionToken
    ? await getAuthenticatedUser(sessionToken)
    : null;
  const cleanDeviceId = normalizeRealDeviceId(body.deviceId) || undefined;

  const isFreeTrial = isAppleTrialTransaction(claims);
  const status: EntitlementStatus = isFreeTrial ? "trialing" : "active";
  const plan = inferApplePlanFromProductId(claims.productId);
  const subscriptionId = `apple_${origTxId}`;
  const txId = String(claims.transactionId || origTxId).trim();
  const sessionId = `apple_tx_${txId}`;

  const existingEntitlement = await getSubscriptionEntitlement(
    subscriptionId
  ).catch(() => null);

  let validCreatorCode: string | undefined = existingEntitlement?.creatorCode;
  const rawCreatorInput = (body.creatorCode || "").trim().toUpperCase();
  if (rawCreatorInput) {
    if (rawCreatorInput.startsWith("BROC")) {
      if (cleanDeviceId && /^BROC-[A-Z0-9]{4,10}$/.test(rawCreatorInput)) {
        await applyOrActivateReferral({
          deviceId: cleanDeviceId,
          referralCode: rawCreatorInput,
          activateNow: true,
        }).catch(() => {});
      }
    } else if (!validCreatorCode) {
      const normCode = normalizeCode(rawCreatorInput);
      if (normCode) {
        const creator = await getCreator(normCode).catch(() => null);
        if (creator && creator.active) {
          validCreatorCode = creator.code;
        }
      }
    }
  } else if (cleanDeviceId) {
    await applyOrActivateReferral({
      deviceId: cleanDeviceId,
      activateNow: true,
    }).catch(() => {});
  }

  const buyerEmail = authedUser?.email || existingEntitlement?.customerEmail;

  await saveEntitlement({
    sessionId,
    subscriptionId,
    customerEmail: buyerEmail,
    deviceId: cleanDeviceId,
    userId: authedUser?.userId,
    creatorCode: validCreatorCode,
    plan,
    status,
    active: true,
    expiresAtMs,
    lastChargeSucceeded: !isFreeTrial,
    updatedAt: new Date(now).toISOString(),
  });

  if (validCreatorCode && !validCreatorCode.startsWith("BROC")) {
    if (isFreeTrial) {
      await recordStripeCreatorConversionOnce(
        `apple_trial:${origTxId}`,
        validCreatorCode,
        "trial",
        undefined,
        buyerEmail
      );
    } else {
      const grossUsd = resolveAppleGrossUsd(claims, plan, false);
      if (grossUsd > 0) {
        await recordStripeCreatorConversionOnce(
          `apple_orig:${origTxId}`,
          validCreatorCode,
          plan === "monthly" ? "paid_monthly" : "paid_annual",
          grossUsd,
          buyerEmail,
          {
            creditedTransactionId: txId,
            subscriptionKey: `apple_orig:${origTxId}`,
          }
        );
      }
    }
  }

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
    ...(validCreatorCode ? { creatorCode: validCreatorCode } : {}),
  });
}
