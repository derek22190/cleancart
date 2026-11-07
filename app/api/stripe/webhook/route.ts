import crypto from "node:crypto";
import { NextResponse } from "next/server";
import {
  saveEntitlement,
  updateSubscriptionEntitlement,
  type EntitlementStatus,
} from "@/lib/entitlements";
import { recordStripeCreatorConversionOnce } from "@/lib/influencers";
import type { PlanId } from "@/lib/pricing";

const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Verifies the Stripe `Stripe-Signature` header (`t=...,v1=...`) using HMAC-SHA256
 * and constant-time comparison against `STRIPE_WEBHOOK_SECRET`.
 */
export function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
  nowUnixSeconds = Math.floor(Date.now() / 1000)
): boolean {
  if (!signatureHeader || !webhookSecret) return false;

  const parts = signatureHeader.split(",").map((p) => p.trim());
  let timestampStr = "";
  const v1Signatures: string[] = [];

  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key === "t") timestampStr = val;
    if (key === "v1" && val) v1Signatures.push(val);
  }

  const timestamp = Number(timestampStr);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || v1Signatures.length === 0) {
    return false;
  }

  if (Math.abs(nowUnixSeconds - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedHex = crypto
    .createHmac("sha256", webhookSecret)
    .update(signedPayload, "utf8")
    .digest("hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");

  for (const sigHex of v1Signatures) {
    if (sigHex.length !== expectedHex.length) continue;
    try {
      const candidateBuf = Buffer.from(sigHex, "hex");
      if (
        candidateBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(candidateBuf, expectedBuf)
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

interface StripeEventPayload {
  id: string;
  type: string;
  data?: {
    object?: Record<string, unknown>;
  };
}

export async function POST(req: Request) {
  const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!webhookSecret) {
    return NextResponse.json(
      { ok: false, error: "STRIPE_WEBHOOK_SECRET is not configured." },
      { status: 500 }
    );
  }

  const sigHeader = req.headers.get("stripe-signature");
  const rawBody = await req.text();

  if (!verifyStripeWebhookSignature(rawBody, sigHeader, webhookSecret)) {
    return NextResponse.json(
      { ok: false, error: "Invalid Stripe webhook signature." },
      { status: 400 }
    );
  }

  let event: StripeEventPayload;
  try {
    event = JSON.parse(rawBody) as StripeEventPayload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Malformed JSON payload." },
      { status: 400 }
    );
  }

  const obj = event.data?.object ?? {};

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const sessionId = typeof obj.id === "string" ? obj.id : "";
        if (!sessionId) break;

        const subscriptionId =
          typeof obj.subscription === "string"
            ? obj.subscription
            : typeof (obj.subscription as { id?: string } | null)?.id === "string"
              ? (obj.subscription as { id: string }).id
              : undefined;
        const customerId =
          typeof obj.customer === "string"
            ? obj.customer
            : typeof (obj.customer as { id?: string } | null)?.id === "string"
              ? (obj.customer as { id: string }).id
              : undefined;
        const customerDetails = obj.customer_details as
          | { email?: string | null }
          | undefined;
        const metadata = (obj.metadata ?? {}) as Record<string, string>;
        const plan: PlanId = metadata.plan === "monthly" ? "monthly" : "annual";
        const creatorCode = metadata.creator_code || undefined;
        const paymentStatus =
          typeof obj.payment_status === "string" ? obj.payment_status : "paid";
        const isTrial = paymentStatus === "no_payment_required";
        const status: EntitlementStatus = isTrial ? "trialing" : "active";

        await saveEntitlement({
          sessionId,
          subscriptionId,
          customerId,
          customerEmail: customerDetails?.email || undefined,
          plan,
          creatorCode,
          status,
          active: true,
          updatedAt: new Date().toISOString(),
        });

        if (creatorCode) {
          const refKey = subscriptionId || sessionId;
          if (isTrial) {
            await recordStripeCreatorConversionOnce(
              `trial:${refKey}`,
              creatorCode,
              "trial"
            );
          } else if (paymentStatus === "paid") {
            await recordStripeCreatorConversionOnce(
              `paid:${refKey}`,
              creatorCode,
              plan === "monthly" ? "paid_monthly" : "paid_annual"
            );
          }
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscriptionId = typeof obj.id === "string" ? obj.id : "";
        if (!subscriptionId) break;

        const status = (
          typeof obj.status === "string" ? obj.status : "active"
        ) as EntitlementStatus;
        const metadata = (obj.metadata ?? {}) as Record<string, string>;
        const plan: PlanId | undefined =
          metadata.plan === "monthly"
            ? "monthly"
            : metadata.plan === "annual"
              ? "annual"
              : undefined;
        const creatorCode = metadata.creator_code || undefined;
        const customerId =
          typeof obj.customer === "string" ? obj.customer : undefined;

        const updated = await updateSubscriptionEntitlement(subscriptionId, {
          status,
          plan,
          customerId,
          creatorCode,
        });

        // If subscription transitioned to active paid state and has a creator code, credit once
        const effectiveCreator = creatorCode || updated?.creatorCode;
        const effectivePlan = plan || updated?.plan || "annual";
        if (status === "active" && effectiveCreator) {
          await recordStripeCreatorConversionOnce(
            `paid:${subscriptionId}`,
            effectiveCreator,
            effectivePlan === "monthly" ? "paid_monthly" : "paid_annual"
          );
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscriptionId = typeof obj.id === "string" ? obj.id : "";
        if (!subscriptionId) break;
        await updateSubscriptionEntitlement(subscriptionId, {
          status: "canceled",
        });
        break;
      }

      default:
        break;
    }

    return NextResponse.json({ ok: true, received: true });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Webhook processing failed.",
      },
      { status: 500 }
    );
  }
}
