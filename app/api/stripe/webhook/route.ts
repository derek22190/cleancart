import { NextResponse } from "next/server";
import {
  getSubscriptionEntitlement,
  saveEntitlement,
  updateSubscriptionEntitlement,
  type EntitlementStatus,
} from "@/lib/entitlements";
import {
  recordStripeCreatorConversionOnce,
  recordStripeCreatorRefundOnce,
} from "@/lib/influencers";
import type { PlanId } from "@/lib/pricing";
import { applyOrActivateReferral } from "@/lib/referrals";
import { verifyStripeWebhookSignature } from "@/lib/stripe-webhook";

interface StripeEventPayload {
  id: string;
  type: string;
  created?: number;
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
  const eventCreated =
    typeof event.created === "number" && Number.isFinite(event.created)
      ? event.created
      : undefined;

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
        const deviceId =
          metadata.device_id ||
          (typeof obj.client_reference_id === "string"
            ? obj.client_reference_id
            : undefined);

        // Require explicit payment_status ("paid" or "no_payment_required" for trial)
        const paymentStatus =
          typeof obj.payment_status === "string" ? obj.payment_status : "";
        const isPaid = paymentStatus === "paid";
        const isTrial = paymentStatus === "no_payment_required";
        const status: EntitlementStatus = isPaid
          ? "active"
          : isTrial
            ? "trialing"
            : "incomplete";

        await saveEntitlement({
          sessionId,
          subscriptionId,
          customerId,
          customerEmail: customerDetails?.email || undefined,
          deviceId,
          plan,
          creatorCode,
          status,
          active: isPaid || isTrial,
          lastStripeEventCreated: eventCreated,
          updatedAt: new Date().toISOString(),
        });

        if (creatorCode && (isTrial || isPaid)) {
          if (/^BROC-[A-Z0-9]{4,10}$/.test(creatorCode)) {
            await applyOrActivateReferral({
              deviceId: deviceId || `checkout:${sessionId}`,
              referralCode: creatorCode,
              activateNow: true,
            });
          } else {
            const refKey = subscriptionId || sessionId;
            if (isTrial) {
              await recordStripeCreatorConversionOnce(
                `trial:${refKey}`,
                creatorCode,
                "trial"
              );
            } else if (isPaid) {
              await recordStripeCreatorConversionOnce(
                `paid:${refKey}`,
                creatorCode,
                plan === "monthly" ? "paid_monthly" : "paid_annual"
              );
            }
          }
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscriptionId = typeof obj.id === "string" ? obj.id : "";
        if (!subscriptionId) break;

        const status = (
          typeof obj.status === "string" ? obj.status : "incomplete"
        ) as EntitlementStatus;
        const metadata = (obj.metadata ?? {}) as Record<string, string>;
        const plan: PlanId | undefined =
          metadata.plan === "monthly"
            ? "monthly"
            : metadata.plan === "annual"
              ? "annual"
              : undefined;
        const creatorCode = metadata.creator_code || undefined;
        const deviceId = metadata.device_id || undefined;
        const customerId =
          typeof obj.customer === "string" ? obj.customer : undefined;

        const updated = await updateSubscriptionEntitlement(subscriptionId, {
          status,
          plan,
          customerId,
          creatorCode,
          deviceId,
          lastStripeEventCreated: eventCreated,
        });

        // If subscription transitioned to active paid state and has a creator code, credit initial conversion once
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

      case "invoice.paid": {
        const invoiceId = typeof obj.id === "string" ? obj.id : "";
        const subscriptionId =
          typeof obj.subscription === "string"
            ? obj.subscription
            : typeof (obj.subscription as { id?: string } | null)?.id === "string"
              ? (obj.subscription as { id: string }).id
              : "";
        if (!subscriptionId) break;

        const billingReason =
          typeof obj.billing_reason === "string" ? obj.billing_reason : "";
        const amountPaidCents =
          typeof obj.amount_paid === "number" ? obj.amount_paid : 0;

        const subDetails = (obj.subscription_details ?? {}) as {
          metadata?: Record<string, string>;
        };
        const metadata = {
          ...((obj.metadata ?? {}) as Record<string, string>),
          ...(subDetails.metadata ?? {}),
        };

        const existing = await getSubscriptionEntitlement(subscriptionId);
        const plan: PlanId =
          metadata.plan === "monthly"
            ? "monthly"
            : metadata.plan === "annual"
              ? "annual"
              : existing?.plan || "annual";
        const creatorCode =
          metadata.creator_code || existing?.creatorCode || undefined;

        await updateSubscriptionEntitlement(subscriptionId, {
          status: "active",
          plan,
          creatorCode,
          lastStripeEventCreated: eventCreated,
        });

        // Credit recurring renewals (and initial paid invoices) to creator ledger
        if (creatorCode && amountPaidCents > 0) {
          const isRenewal = billingReason === "subscription_cycle";
          const convKey = isRenewal && invoiceId
            ? `invoice:${invoiceId}`
            : `paid:${subscriptionId}`;
          await recordStripeCreatorConversionOnce(
            convKey,
            creatorCode,
            plan === "monthly" ? "paid_monthly" : "paid_annual"
          );
        }
        break;
      }

      case "charge.refunded": {
        const chargeId = typeof obj.id === "string" ? obj.id : event.id;
        const amountRefundedCents =
          typeof obj.amount_refunded === "number" ? obj.amount_refunded : 0;
        const amountCapturedCents =
          typeof obj.amount === "number" ? obj.amount : amountRefundedCents;
        const metadata = (obj.metadata ?? {}) as Record<string, string>;
        const subscriptionId = metadata.subscription_id || "";
        const existing = subscriptionId
          ? await getSubscriptionEntitlement(subscriptionId)
          : null;
        const creatorCode =
          metadata.creator_code || existing?.creatorCode || undefined;
        const plan: PlanId =
          metadata.plan === "monthly"
            ? "monthly"
            : existing?.plan || "annual";

        if (subscriptionId && amountRefundedCents >= amountCapturedCents && amountCapturedCents > 0) {
          await updateSubscriptionEntitlement(subscriptionId, {
            status: "canceled",
            lastStripeEventCreated: eventCreated,
          });
        }

        if (creatorCode && amountRefundedCents > 0) {
          await recordStripeCreatorRefundOnce(
            `refund:${chargeId}`,
            creatorCode,
            plan,
            amountRefundedCents / 100
          );
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscriptionId = typeof obj.id === "string" ? obj.id : "";
        if (!subscriptionId) break;
        await updateSubscriptionEntitlement(subscriptionId, {
          status: "canceled",
          lastStripeEventCreated: eventCreated,
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
