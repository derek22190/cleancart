import { NextResponse } from "next/server";
import {
  getSubscriptionEntitlement,
  recordSubscriptionConsent,
  refreshSubscriptionConsentOnRenewal,
  saveEntitlement,
  updateSubscriptionEntitlement,
  type EntitlementStatus,
} from "@/lib/entitlements";
import {
  recordStripeCreatorConversionOnce,
  recordStripeCreatorRefundOnce,
} from "@/lib/influencers";
import { TERMS_VERSION, type PlanId } from "@/lib/pricing";
import { applyOrActivateReferral } from "@/lib/referrals";
import { kvGet, kvSet } from "@/lib/storage";
import { verifyStripeWebhookSignature } from "@/lib/stripe-webhook";

interface StripeEventPayload {
  id: string;
  type: string;
  api_version?: string;
  created?: number;
  data?: {
    object?: Record<string, unknown>;
  };
}

function normalizeStripeSubStatus(raw: unknown): EntitlementStatus {
  switch (raw) {
    case "active":
    case "trialing":
    case "past_due":
    case "unpaid":
    case "canceled":
    case "paused":
    case "incomplete":
    case "incomplete_expired":
      return raw;
    default:
      return "incomplete";
  }
}

function extractSubIdFromInvoiceObject(inv: Record<string, unknown>): string {
  const parentObj = (inv.parent ?? {}) as {
    subscription_details?: {
      subscription?: string | { id?: string } | null;
    };
  };
  const subDetails = (inv.subscription_details ?? {}) as {
    subscription?: string | { id?: string } | null;
  };
  const rawSub =
    parentObj.subscription_details?.subscription ??
    inv.subscription ??
    subDetails.subscription;
  if (typeof rawSub === "string") return rawSub;
  if (rawSub && typeof (rawSub as { id?: string }).id === "string") {
    return (rawSub as { id: string }).id;
  }
  return "";
}

function chargeObjHasSubscriptionLink(
  chargeObj: Record<string, unknown>
): boolean {
  const metadata = (chargeObj.metadata ?? {}) as Record<string, string>;
  if (metadata.subscription_id) return true;
  if (chargeObj.invoice) return true;
  if (chargeObj.payment_intent) return true;
  // If chargeObj explicitly sets `invoice: null` with no payment_intent or subscription_id, it is a one-off charge
  if ("invoice" in chargeObj && chargeObj.invoice === null) return false;
  return true;
}

async function resolveSubscriptionFromCharge(
  chargeObj: Record<string, unknown>
): Promise<string> {
  const metadata = (chargeObj.metadata ?? {}) as Record<string, string>;
  if (metadata.subscription_id) {
    return metadata.subscription_id;
  }

  const rawInvoice = chargeObj.invoice;
  if (rawInvoice && typeof rawInvoice === "object") {
    const subFromExpanded = extractSubIdFromInvoiceObject(
      rawInvoice as Record<string, unknown>
    );
    if (subFromExpanded) return subFromExpanded;
  }

  const secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
  const invoiceId =
    typeof rawInvoice === "string"
      ? rawInvoice
      : rawInvoice && typeof (rawInvoice as { id?: string }).id === "string"
        ? (rawInvoice as { id: string }).id
        : "";

  if (secretKey && invoiceId) {
    const invRes = await fetch(
      `https://api.stripe.com/v1/invoices/${encodeURIComponent(invoiceId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${secretKey}` },
        cache: "no-store",
      }
    );
    if (!invRes.ok) {
      throw new Error(`Stripe invoice lookup failed with HTTP ${invRes.status}`);
    }
    const invData = (await invRes.json()) as Record<string, unknown>;
    const subId = extractSubIdFromInvoiceObject(invData);
    if (subId) return subId;
  }

  // Basil+ API: resolve invoice from payment_intent via /v1/invoice_payments
  const rawPi = chargeObj.payment_intent;
  const paymentIntentId =
    typeof rawPi === "string"
      ? rawPi
      : rawPi && typeof (rawPi as { id?: string }).id === "string"
        ? (rawPi as { id: string }).id
        : "";

  if (secretKey && paymentIntentId) {
    const ipUrl = new URL("https://api.stripe.com/v1/invoice_payments");
    ipUrl.searchParams.set("payment[type]", "payment_intent");
    ipUrl.searchParams.set("payment[payment_intent]", paymentIntentId);
    ipUrl.searchParams.set("expand[]", "data.invoice");
    const ipRes = await fetch(ipUrl.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${secretKey}` },
      cache: "no-store",
    });
    if (!ipRes.ok) {
      throw new Error(`Stripe invoice_payments lookup failed with HTTP ${ipRes.status}`);
    }
    const ipData = (await ipRes.json()) as {
      data?: Array<{
        invoice?: string | Record<string, unknown>;
      }>;
    };
    const firstInv = ipData.data?.[0]?.invoice;
    if (firstInv && typeof firstInv === "object") {
      const subId = extractSubIdFromInvoiceObject(firstInv);
      if (subId) return subId;
    } else if (typeof firstInv === "string" && firstInv) {
      const invRes = await fetch(
        `https://api.stripe.com/v1/invoices/${encodeURIComponent(firstInv)}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${secretKey}` },
          cache: "no-store",
        }
      );
      if (!invRes.ok) {
        throw new Error(`Stripe invoice lookup failed with HTTP ${invRes.status}`);
      }
      const invData = (await invRes.json()) as Record<string, unknown>;
      const subId = extractSubIdFromInvoiceObject(invData);
      if (subId) return subId;
    }
  }

  // Never fall back to getCustomerEntitlement(customerId) when a charge has no subscription invoice,
  // so refunding a one-off non-subscription charge never cancels an unrelated active subscription (H2).
  return "";
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

  console.info("[stripe-webhook]", {
    id: event.id,
    type: event.type,
    api_version: event.api_version ?? "unknown",
  });

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
        const resolvedEmail =
          customerDetails?.email || metadata.customer_email || "";

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
          customerEmail: resolvedEmail || undefined,
          deviceId,
          plan,
          creatorCode,
          status,
          active: isPaid || isTrial,
          lastStripeEventCreated: eventCreated,
          updatedAt: new Date().toISOString(),
        });

        await recordSubscriptionConsent({
          deviceId: deviceId || "anon-web",
          email: resolvedEmail,
          plan,
          termsVersion: metadata.terms_version || TERMS_VERSION,
          timestamp: metadata.terms_accepted_at || new Date().toISOString(),
          ip: "stripe-webhook",
          sessionId,
          customerId,
          subscriptionId,
        });

        if (creatorCode && (isTrial || isPaid)) {
          if (/^BROC-[A-Z0-9]{4,10}$/.test(creatorCode)) {
            await applyOrActivateReferral({
              deviceId: deviceId || `checkout:${sessionId}`,
              referralCode: creatorCode,
              activateNow: true,
            });
          } else if (isTrial) {
            // Non-monetary trial start tracking only; paid commissions are credited strictly on invoice.paid (amount_paid > 0)
            const refKey = subscriptionId || sessionId;
            await recordStripeCreatorConversionOnce(
              `trial:${refKey}`,
              creatorCode,
              "trial"
            );
          }
        }
        if (isTrial || isPaid) {
          void import("@/lib/analytics")
            .then(({ assignPaywallVariant, trackServerEvent }) =>
              trackServerEvent({
                event: "pro_subscribed",
                distinctId: deviceId || sessionId,
                platform: "web",
                variant: assignPaywallVariant(deviceId, true),
                properties: {
                  plan,
                  status: isTrial ? "trialing" : "active",
                  source: "stripe",
                  creatorCode: creatorCode || null,
                },
              }),
            )
            .catch(() => {});
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscriptionId = typeof obj.id === "string" ? obj.id : "";
        if (!subscriptionId) break;

        const status = normalizeStripeSubStatus(obj.status);
        const metadata = (obj.metadata ?? {}) as Record<string, string>;
        const plan: PlanId | undefined =
          metadata.plan === "monthly"
            ? "monthly"
            : metadata.plan === "annual"
              ? "annual"
              : undefined;
        const creatorCode = metadata.creator_code || undefined;
        const deviceId = metadata.device_id || undefined;
        const customerEmail = metadata.customer_email || undefined;
        const customerId =
          typeof obj.customer === "string" ? obj.customer : undefined;

        await updateSubscriptionEntitlement(subscriptionId, {
          status,
          plan,
          customerId,
          customerEmail,
          creatorCode,
          deviceId,
          lastStripeEventCreated: eventCreated,
        });
        // Paid creator commissions are credited strictly in invoice.paid (when amount_paid > 0)
        break;
      }

      case "invoice.paid":
      case "invoice.payment_succeeded": {
        const invoiceId = typeof obj.id === "string" ? obj.id : "";
        const parentObj = (obj.parent ?? {}) as {
          subscription_details?: {
            subscription?: string | { id?: string } | null;
            metadata?: Record<string, string>;
          };
        };
        const parentSubDetails = parentObj.subscription_details ?? {};
        const subDetails = (obj.subscription_details ?? {}) as {
          subscription?: string | { id?: string } | null;
          metadata?: Record<string, string>;
        };
        const subscriptionId = extractSubIdFromInvoiceObject(obj);
        if (!subscriptionId) break;

        const amountPaidCents =
          typeof obj.amount_paid === "number" ? obj.amount_paid : 0;
        const customerId =
          typeof obj.customer === "string"
            ? obj.customer
            : typeof (obj.customer as { id?: string } | null)?.id === "string"
              ? (obj.customer as { id: string }).id
              : undefined;

        const metadata = {
          ...((obj.metadata ?? {}) as Record<string, string>),
          ...(subDetails.metadata ?? {}),
          ...(parentSubDetails.metadata ?? {}),
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

        const updated = await updateSubscriptionEntitlement(subscriptionId, {
          status: "active",
          plan,
          customerId,
          creatorCode,
          lastStripeEventCreated: eventCreated,
        });

        await refreshSubscriptionConsentOnRenewal({
          sessionId: updated?.sessionId || existing?.sessionId,
          customerId: customerId || updated?.customerId || existing?.customerId,
          email:
            (typeof obj.customer_email === "string" ? obj.customer_email : "") ||
            metadata.customer_email ||
            updated?.customerEmail ||
            existing?.customerEmail,
          deviceId: metadata.device_id || updated?.deviceId || existing?.deviceId,
          subscriptionId,
          plan,
        });

        const invoiceDeviceId =
          metadata.device_id || updated?.deviceId || existing?.deviceId;
        const invoiceRefCode =
          metadata.referral_code ||
          (creatorCode && /^BROC-[A-Z0-9]{4,10}$/.test(creatorCode)
            ? creatorCode
            : undefined);
        if (invoiceDeviceId && invoiceRefCode) {
          await applyOrActivateReferral({
            deviceId: invoiceDeviceId,
            referralCode: invoiceRefCode,
            activateNow: true,
          });
        }

        // Credit creators ONLY from invoice.paid / invoice.payment_succeeded with amount_paid > 0, key invoice:${id}, using actual paid USD
        if (
          creatorCode &&
          !/^BROC-[A-Z0-9]{4,10}$/.test(creatorCode) &&
          amountPaidCents > 0 &&
          invoiceId
        ) {
          await recordStripeCreatorConversionOnce(
            `invoice:${invoiceId}`,
            creatorCode,
            plan === "monthly" ? "paid_monthly" : "paid_annual",
            amountPaidCents / 100
          );
        }
        break;
      }

      case "charge.refunded":
      case "charge.dispute.created": {
        const isDispute = event.type === "charge.dispute.created";
        const chargeId = isDispute
          ? typeof obj.charge === "string"
            ? obj.charge
            : typeof obj.id === "string"
              ? obj.id
              : event.id
          : typeof obj.id === "string"
            ? obj.id
            : event.id;
        const amountRefundedCents = isDispute
          ? typeof obj.amount === "number"
            ? obj.amount
            : 0
          : typeof obj.amount_refunded === "number"
            ? obj.amount_refunded
            : 0;
        const amountCapturedCents =
          typeof obj.amount === "number" ? obj.amount : amountRefundedCents;
        const metadata = (obj.metadata ?? {}) as Record<string, string>;

        const subscriptionId = await resolveSubscriptionFromCharge(obj);
        const existing = subscriptionId
          ? await getSubscriptionEntitlement(subscriptionId)
          : null;
        const creatorCode =
          metadata.creator_code || existing?.creatorCode || undefined;
        const plan: PlanId =
          metadata.plan === "monthly"
            ? "monthly"
            : existing?.plan || "annual";

        const isFullRefund =
          isDispute ||
          (amountRefundedCents >= amountCapturedCents && amountCapturedCents > 0);

        const hasInvoiceReference = Boolean(
          chargeObjHasSubscriptionLink(obj)
        );
        if (isFullRefund && !subscriptionId && hasInvoiceReference) {
          throw new Error(
            `Unable to resolve subscription for refunded/disputed charge ${chargeId}`
          );
        }

        if (subscriptionId && isFullRefund) {
          await updateSubscriptionEntitlement(subscriptionId, {
            status: "canceled",
            lastStripeEventCreated: eventCreated,
          });
          const secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
          if (secretKey) {
            const delRes = await fetch(
              `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
              {
                method: "DELETE",
                headers: { Authorization: `Bearer ${secretKey}` },
              }
            );
            if (!delRes.ok && delRes.status !== 404) {
              throw new Error(
                `Stripe subscription cancellation failed (${delRes.status})`
              );
            }
          }
        }

        if (creatorCode && amountRefundedCents > 0) {
          const refundsObj = obj.refunds as
            | { data?: Array<{ id?: string; amount?: number }> }
            | undefined;
          const refundList = Array.isArray(refundsObj?.data)
            ? refundsObj.data.filter(
                (r) => typeof r?.id === "string" && typeof r?.amount === "number" && r.amount > 0
              )
            : [];
          if (refundList.length > 0) {
            for (const r of refundList) {
              await recordStripeCreatorRefundOnce(
                `refund:${r.id!}`,
                creatorCode,
                plan,
                r.amount! / 100
              );
            }
          } else {
            const chargeRefundTrackerKey = `heybroc:charge:refunded:${chargeId}`;
            const prevRefundedCents =
              (await kvGet<number>(chargeRefundTrackerKey)) ?? 0;
            const deltaCents = isDispute
              ? amountRefundedCents
              : Math.max(0, amountRefundedCents - prevRefundedCents);
            if (deltaCents > 0) {
              const recorded = await recordStripeCreatorRefundOnce(
                `refund:${chargeId}:${event.id || amountRefundedCents}`,
                creatorCode,
                plan,
                deltaCents / 100
              );
              if (recorded && !isDispute) {
                await kvSet(
                  chargeRefundTrackerKey,
                  Math.max(prevRefundedCents, amountRefundedCents),
                  400 * 24 * 60 * 60
                );
              }
            }
          }
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
