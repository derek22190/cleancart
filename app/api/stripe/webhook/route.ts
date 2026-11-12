import { NextResponse } from "next/server";
import {
  applyOneTimeAnnualPass,
  getCustomerEntitlement,
  getDevicePaidEntitlement,
  getEmailEntitlement,
  getSubscriptionEntitlement,
  normalizeRealDeviceId,
  recordSubscriptionConsent,
  refreshSubscriptionConsentOnRenewal,
  revokeCheckoutSessionEntitlement,
  revokeOneTimeAnnualPass,
  saveEntitlement,
  updateSubscriptionEntitlement,
  type EntitlementStatus,
} from "@/lib/entitlements";
import {
  recordStripeCreatorConversionOnce,
  recordStripeCreatorRefundOnce,
} from "@/lib/influencers";
import { PRICING, TERMS_VERSION, type PlanId } from "@/lib/pricing";
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

const DAY_MS = 86_400_000;

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

function extractStripeCustomerId(raw: unknown): string | undefined {
  const candidate =
    typeof raw === "string"
      ? raw.trim()
      : raw && typeof (raw as { id?: unknown }).id === "string"
        ? (raw as { id: string }).id.trim()
        : "";
  return typeof candidate === "string" && candidate.startsWith("cus_")
    ? candidate
    : undefined;
}

function inferPlanFromStripeInterval(
  obj: Record<string, unknown>,
  metadata: Record<string, string>,
  fallback?: PlanId
): PlanId | undefined {
  if (metadata.plan === "monthly") return "monthly";
  if (metadata.plan === "annual") return "annual";
  if (metadata.oto_offer === "oto_annual" || metadata.oto_offer === "oto_gift_year") {
    return "annual";
  }

  // Check subscription items: items.data[0].price.recurring.interval or plan.interval
  const items = obj.items as
    | {
        data?: Array<{
          price?: { recurring?: { interval?: string } };
          plan?: { interval?: string };
        }>;
      }
    | undefined;
  const subInterval =
    items?.data?.[0]?.price?.recurring?.interval ||
    items?.data?.[0]?.plan?.interval;
  if (subInterval === "year") return "annual";
  if (subInterval === "month") return "monthly";

  // Check invoice lines: lines.data[0].price.recurring.interval or plan.interval
  const lines = obj.lines as
    | {
        data?: Array<{
          price?: { recurring?: { interval?: string } };
          plan?: { interval?: string };
          pricing?: {
            price_details?: { recurring?: { interval?: string } };
          };
        }>;
      }
    | undefined;
  for (const line of lines?.data ?? []) {
    const lineInterval =
      line?.price?.recurring?.interval ||
      line?.plan?.interval ||
      line?.pricing?.price_details?.recurring?.interval;
    if (lineInterval === "year") return "annual";
    if (lineInterval === "month") return "monthly";
  }

  const singlePlan = obj.plan as { interval?: string } | undefined;
  if (singlePlan?.interval === "year") return "annual";
  if (singlePlan?.interval === "month") return "monthly";

  return fallback;
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

function extractInvoicePeriodEndMs(inv: Record<string, unknown>): number | undefined {
  const lines = inv.lines as
    | { data?: Array<{ period?: { end?: number } }> }
    | undefined;
  let maxLineEndSec = 0;
  for (const line of lines?.data ?? []) {
    if (typeof line?.period?.end === "number" && line.period.end > maxLineEndSec) {
      maxLineEndSec = line.period.end;
    }
  }
  if (maxLineEndSec > 0) {
    return maxLineEndSec * 1000;
  }
  if (typeof inv.period_end === "number" && inv.period_end > 0) {
    return inv.period_end * 1000;
  }
  return undefined;
}

function extractSubscriptionExpiryMs(
  sub: Record<string, unknown>,
  status: EntitlementStatus
): number | undefined {
  const trialEndSec =
    typeof sub.trial_end === "number" && sub.trial_end > 0 ? sub.trial_end : 0;
  const metaObj = (sub.metadata ?? {}) as Record<string, string>;
  const metaTrialEndSec = Number(metaObj.trial_end_sec || 0);
  const subPeriodEndSec =
    typeof sub.current_period_end === "number" && sub.current_period_end > 0
      ? sub.current_period_end
      : 0;
  const items = sub.items as
    | { data?: Array<{ current_period_end?: number }> }
    | undefined;
  const itemPeriodEndSec =
    typeof items?.data?.[0]?.current_period_end === "number" &&
    items.data[0].current_period_end > 0
      ? items.data[0].current_period_end
      : 0;
  const periodEndSec = Math.max(subPeriodEndSec, itemPeriodEndSec);

  if (status === "trialing" || trialEndSec > periodEndSec) {
    const bestTrialSec = Math.max(
      trialEndSec,
      periodEndSec,
      status === "trialing" && Number.isFinite(metaTrialEndSec) && metaTrialEndSec > 0
        ? metaTrialEndSec
        : 0
    );
    if (bestTrialSec > 0) {
      return bestTrialSec * 1000;
    }
  }
  if (periodEndSec > 0) {
    return periodEndSec * 1000;
  }
  if (trialEndSec > 0) {
    return trialEndSec * 1000;
  }
  return undefined;
}

function chargeObjHasSubscriptionLink(
  chargeObj: Record<string, unknown>
): boolean {
  if (chargeObj._confirmedNonInvoice === true) return false;
  const metadata = (chargeObj.metadata ?? {}) as Record<string, string>;
  if (metadata.oto_offer === "oto_gift_year") return false;
  if (metadata.subscription_id) return true;
  if (chargeObj.invoice) return true;
  // Explicit `invoice: null` means Stripe created a one-off non-invoice charge (e.g. Checkout mode=payment)
  if ("invoice" in chargeObj && chargeObj.invoice === null) return false;
  if (chargeObj.payment_intent) return true;
  return false;
}

async function resolveChargeObjectForRefundOrDispute(
  rawObj: Record<string, unknown>,
  isDispute: boolean
): Promise<Record<string, unknown>> {
  if (!isDispute) return rawObj;

  if (rawObj.charge && typeof rawObj.charge === "object") {
    return rawObj.charge as Record<string, unknown>;
  }

  const secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
  const chargeId = typeof rawObj.charge === "string" ? rawObj.charge : "";
  if (secretKey && chargeId) {
    const chRes = await fetch(
      `https://api.stripe.com/v1/charges/${encodeURIComponent(chargeId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${secretKey}` },
        cache: "no-store",
      }
    );
    if (chRes.ok) {
      return (await chRes.json()) as Record<string, unknown>;
    }
  }

  return {
    id: chargeId || rawObj.id,
    amount: rawObj.amount,
    invoice: rawObj.invoice ?? null,
    payment_intent: rawObj.payment_intent ?? null,
    metadata: rawObj.metadata ?? {},
  };
}

async function resolveSubscriptionFromCharge(
  chargeObj: Record<string, unknown>
): Promise<string> {
  const metadata = (chargeObj.metadata ?? {}) as Record<string, string>;
  if (metadata.oto_offer === "oto_gift_year") {
    return "";
  }
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

  if (secretKey && paymentIntentId && !("invoice" in chargeObj && chargeObj.invoice === null)) {
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
      throw new Error(
        `Stripe invoice_payments lookup failed with HTTP ${ipRes.status}`
      );
    }
    const ipData = (await ipRes.json()) as {
      data?: Array<{
        invoice?: string | Record<string, unknown>;
      }>;
    };
    if (!ipData.data || ipData.data.length === 0) {
      chargeObj._confirmedNonInvoice = true;
      return "";
    }
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
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const sessionId = typeof obj.id === "string" ? obj.id : "";
        if (!sessionId) break;

        const mode = typeof obj.mode === "string" ? obj.mode : "";
        const metadata = (obj.metadata ?? {}) as Record<string, string>;
        const otoOffer = metadata.oto_offer || "";
        const rawSubscriptionId =
          typeof obj.subscription === "string"
            ? obj.subscription
            : typeof (obj.subscription as { id?: string } | null)?.id === "string"
              ? (obj.subscription as { id: string }).id
              : undefined;
        const isOneTimeOtoPass =
          (mode === "payment" || !rawSubscriptionId) && otoOffer === "oto_gift_year";
        const subscriptionId =
          rawSubscriptionId ||
          (isOneTimeOtoPass ? `oto_pass_${sessionId}` : undefined);
        const customerId = extractStripeCustomerId(obj.customer);
        const customerDetails = obj.customer_details as
          | { email?: string | null }
          | undefined;
        const plan: PlanId =
          inferPlanFromStripeInterval(obj, metadata, "annual") || "annual";
        const creatorCode = metadata.creator_code || undefined;
        const deviceId =
          normalizeRealDeviceId(
            metadata.device_id ||
              (typeof obj.client_reference_id === "string"
                ? obj.client_reference_id
                : undefined)
          ) || undefined;
        const userId = metadata.user_id || undefined;
        const resolvedEmail =
          customerDetails?.email || metadata.customer_email || "";
        const amountTotalCents =
          typeof obj.amount_total === "number" ? obj.amount_total : 0;
        const amountSubtotalCents =
          typeof obj.amount_subtotal === "number" && obj.amount_subtotal > 0
            ? Math.min(amountTotalCents || obj.amount_subtotal, obj.amount_subtotal)
            : amountTotalCents;

        // Require explicit payment_status ("paid" or "no_payment_required" for trial), or async_payment_succeeded event
        const paymentStatus =
          typeof obj.payment_status === "string" ? obj.payment_status : "";
        const isPaid =
          paymentStatus === "paid" ||
          event.type === "checkout.session.async_payment_succeeded";
        const isTrial =
          event.type === "checkout.session.completed" &&
          paymentStatus === "no_payment_required";

        if (isOneTimeOtoPass) {
          if (isPaid) {
            await applyOneTimeAnnualPass({
              sessionId,
              customerId,
              customerEmail: resolvedEmail || undefined,
              deviceId,
              userId,
              creatorCode,
              lastStripeEventCreated: eventCreated,
            });
            if (creatorCode) {
              if (/^BROC-[A-Z0-9]{4,10}$/.test(creatorCode)) {
                await applyOrActivateReferral({
                  deviceId: deviceId || `checkout:${sessionId}`,
                  referralCode: creatorCode,
                  activateNow: true,
                  userId,
                });
              } else if (amountSubtotalCents > 0) {
                // One-time payment (`mode=payment`) does not emit `invoice.paid`; credit creator here idempotently on pre-tax subtotal
                await recordStripeCreatorConversionOnce(
                  `session:${sessionId}`,
                  creatorCode,
                  "paid_annual",
                  amountSubtotalCents / 100,
                  resolvedEmail
                );
              }
            }
          }
        } else {
          // If `invoice.paid` already arrived ahead of `checkout.session.completed`, preserve its exact period end while writing `session:${sessionId}`
          const existingSub = subscriptionId
            ? await getSubscriptionEntitlement(subscriptionId)
            : null;
          const status: EntitlementStatus = isPaid
            ? "active"
            : isTrial
              ? "trialing"
              : existingSub?.active
                ? existingSub.status
                : "incomplete";
          const nowMs = Date.now();
          const metaTrialEndSec = Number(metadata.trial_end_sec || 0);
          const computedInitialExpiresAtMs = isTrial
            ? Number.isFinite(metaTrialEndSec) && metaTrialEndSec * 1000 > nowMs
              ? metaTrialEndSec * 1000 + 2 * DAY_MS
              : nowMs + PRICING.trialDays * DAY_MS
            : isPaid
              ? nowMs + (plan === "monthly" ? 32 : 366) * DAY_MS
              : undefined;
          const initialExpiresAtMs =
            existingSub?.expiresAtMs && existingSub.expiresAtMs > nowMs
              ? computedInitialExpiresAtMs
                ? Math.max(existingSub.expiresAtMs, computedInitialExpiresAtMs)
                : existingSub.expiresAtMs
              : computedInitialExpiresAtMs;

          await saveEntitlement({
            sessionId,
            checkoutSessionId: sessionId,
            subscriptionId,
            customerId,
            customerEmail: resolvedEmail || undefined,
            deviceId,
            userId,
            plan,
            creatorCode,
            status,
            active: isPaid || isTrial || Boolean(existingSub?.active),
            ...(initialExpiresAtMs ? { expiresAtMs: initialExpiresAtMs } : {}),
            ...(isPaid && amountTotalCents > 0
              ? { lastChargeSucceeded: true }
              : {}),
            ...(metadata.retention_source === "cancel_flow" &&
            otoOffer === "oto_annual"
              ? { lastRetentionOfferAtMs: Date.now() }
              : {}),
            lastStripeEventCreated: eventCreated,
            updatedAt: new Date().toISOString(),
          });

          await recordSubscriptionConsent({
            deviceId: deviceId || `session:${sessionId}`,
            email: resolvedEmail,
            plan,
            termsVersion: metadata.terms_version || TERMS_VERSION,
            timestamp: metadata.terms_accepted_at || new Date().toISOString(),
            ip: "stripe-webhook",
            sessionId,
            customerId,
            subscriptionId,
            otoOffer: otoOffer || undefined,
            recurringPriceUsd:
              otoOffer === "oto_annual"
                ? PRICING.otoAnnualLockIn
                : plan === "annual"
                  ? PRICING.annual
                  : PRICING.monthly,
          });

          // If this is a Monthly -> Annual upgrade (`oto_annual` or `cancel_flow`), cancel the superseded subscription
          const prevSubId = (
            metadata.previous_subscription_id ||
            metadata.replaces_subscription_id ||
            ""
          ).trim();
          if (
            (isPaid || isTrial) &&
            (otoOffer === "oto_annual" || metadata.retention_source === "cancel_flow") &&
            prevSubId &&
            prevSubId.startsWith("sub_") &&
            prevSubId !== subscriptionId
          ) {
            await updateSubscriptionEntitlement(prevSubId, {
              status: "canceled",
              lastStripeEventCreated: eventCreated,
            });
            const secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
            if (secretKey) {
              const cancelOldRes = await fetch(
                `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(prevSubId)}`,
                {
                  method: "DELETE",
                  headers: { Authorization: `Bearer ${secretKey}` },
                }
              );
              if (!cancelOldRes.ok && cancelOldRes.status !== 404) {
                throw new Error(
                  `Failed to cancel superseded monthly subscription ${prevSubId} (${cancelOldRes.status})`
                );
              }
            }
          }

          if (creatorCode && (isTrial || isPaid)) {
            if (/^BROC-[A-Z0-9]{4,10}$/.test(creatorCode)) {
              await applyOrActivateReferral({
                deviceId: deviceId || `checkout:${sessionId}`,
                referralCode: creatorCode,
                activateNow: true,
                userId,
              });
            } else if (isTrial) {
              // Non-monetary trial start tracking only; paid subscription commissions are credited strictly on invoice.paid (amount_paid > 0)
              const refKey = subscriptionId || sessionId;
              await recordStripeCreatorConversionOnce(
                `trial:${refKey}`,
                creatorCode,
                "trial",
                undefined,
                resolvedEmail
              );
            }
          }
        }

        if (isTrial || isPaid) {
          const paidUsd =
            isPaid && amountTotalCents > 0
              ? Number((amountTotalCents / 100).toFixed(2))
              : 0;
          void import("@/lib/analytics")
            .then(({ assignPaywallVariant, trackServerEvent }) =>
              trackServerEvent({
                event: "pro_subscribed",
                distinctId: deviceId || sessionId,
                platform: "web",
                variant: assignPaywallVariant(deviceId || sessionId, true),
                userEmail: resolvedEmail || undefined,
                properties: {
                  plan,
                  otoOffer: otoOffer || null,
                  status: isTrial ? "trialing" : "active",
                  source: "stripe",
                  amountUsd: paidUsd,
                  creatorCode: creatorCode || null,
                },
              })
            )
            .catch(() => {});
        }
        break;
      }

      case "checkout.session.async_payment_failed": {
        const sessionId = typeof obj.id === "string" ? obj.id : "";
        if (!sessionId) break;
        const rawSubscriptionId =
          typeof obj.subscription === "string"
            ? obj.subscription
            : typeof (obj.subscription as { id?: string } | null)?.id === "string"
              ? (obj.subscription as { id: string }).id
              : undefined;
        if (rawSubscriptionId) {
          await updateSubscriptionEntitlement(rawSubscriptionId, {
            status: "unpaid",
            checkoutSessionId: sessionId,
            lastStripeEventCreated: eventCreated,
          });
        }
        await revokeCheckoutSessionEntitlement(sessionId, eventCreated);
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscriptionId = typeof obj.id === "string" ? obj.id : "";
        if (!subscriptionId) break;

        const status = normalizeStripeSubStatus(obj.status);
        const metadata = (obj.metadata ?? {}) as Record<string, string>;
        const plan = inferPlanFromStripeInterval(obj, metadata);
        const creatorCode = metadata.creator_code || undefined;
        const deviceId = normalizeRealDeviceId(metadata.device_id) || undefined;
        const userId = metadata.user_id || undefined;
        const customerEmail = metadata.customer_email || undefined;
        const customerId = extractStripeCustomerId(obj.customer);
        const expiresAtMs = extractSubscriptionExpiryMs(obj, status);
        const pauseCollection = obj.pause_collection as
          | { behavior?: string; resumes_at?: number | null }
          | null
          | undefined;
        const pausedUntilMs =
          pauseCollection === null
            ? 0
            : typeof pauseCollection?.resumes_at === "number" &&
                pauseCollection.resumes_at > 0
              ? pauseCollection.resumes_at * 1000
              : undefined;

        await updateSubscriptionEntitlement(subscriptionId, {
          status,
          plan,
          customerId,
          customerEmail,
          creatorCode,
          deviceId,
          userId,
          expiresAtMs,
          ...(pausedUntilMs !== undefined ? { pausedUntilMs } : {}),
          lastStripeEventCreated: eventCreated,
        });
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
        const preTaxPaidCents =
          typeof obj.total_excluding_tax === "number" &&
          obj.total_excluding_tax > 0
            ? Math.min(amountPaidCents, obj.total_excluding_tax)
            : typeof obj.subtotal_excluding_tax === "number" &&
                obj.subtotal_excluding_tax > 0
              ? Math.min(amountPaidCents, obj.subtotal_excluding_tax)
              : amountPaidCents;

        const customerId = extractStripeCustomerId(obj.customer);

        const metadata = {
          ...((obj.metadata ?? {}) as Record<string, string>),
          ...(subDetails.metadata ?? {}),
          ...(parentSubDetails.metadata ?? {}),
        };

        const existing = await getSubscriptionEntitlement(subscriptionId);
        const plan: PlanId =
          inferPlanFromStripeInterval(obj, metadata, existing?.plan || "annual") ||
          "annual";
        const creatorCode =
          metadata.creator_code || existing?.creatorCode || undefined;
        const metaDeviceId = normalizeRealDeviceId(metadata.device_id) || undefined;
        const userId = metadata.user_id || existing?.userId || undefined;
        const periodEndMs = extractInvoicePeriodEndMs(obj);
        const nowMs = Date.now();
        const invoiceMetaTrialSec = Number(metadata.trial_end_sec || 0);
        const invoiceTrialEndMs =
          amountPaidCents === 0 &&
          Number.isFinite(invoiceMetaTrialSec) &&
          invoiceMetaTrialSec * 1000 > nowMs
            ? invoiceMetaTrialSec * 1000 + 2 * DAY_MS
            : undefined;
        const fallbackRenewalMs =
          nowMs + (plan === "monthly" ? 32 : 370) * DAY_MS;
        const isRenewalCycle =
          obj.billing_reason === "subscription_cycle" ||
          (typeof periodEndMs === "number" &&
            typeof existing?.expiresAtMs === "number" &&
            periodEndMs > existing.expiresAtMs);
        const resolvedExpiresAtMs = invoiceTrialEndMs
          ? Math.max(periodEndMs ?? 0, invoiceTrialEndMs)
          : periodEndMs ??
            (isRenewalCycle && amountPaidCents > 0 ? fallbackRenewalMs : undefined);

        // Extend `paidPassExpiresAtMs` on renewals (and stack paid Year 1 if trialing annual had a +366d OTO pass)
        let nextPaidPassExpiresAtMs: number | undefined;
        if (
          existing?.status === "trialing" &&
          amountPaidCents > 0 &&
          plan === "annual" &&
          existing?.paidPassExpiresAtMs &&
          existing.paidPassExpiresAtMs > nowMs
        ) {
          nextPaidPassExpiresAtMs = existing.paidPassExpiresAtMs + 365 * DAY_MS;
        } else if (
          isRenewalCycle &&
          (amountPaidCents > 0 || typeof periodEndMs === "number")
        ) {
          const cycleEndMs = periodEndMs ?? fallbackRenewalMs;
          if (existing?.otoPassSessionIds && existing.otoPassSessionIds.length > 0) {
            nextPaidPassExpiresAtMs = Math.max(
              existing.paidPassExpiresAtMs ?? 0,
              cycleEndMs + existing.otoPassSessionIds.length * 366 * DAY_MS
            );
          } else {
            nextPaidPassExpiresAtMs = cycleEndMs;
          }
        }

        const nextInvoiceStatus: EntitlementStatus =
          amountPaidCents === 0 &&
          (existing?.status === "trialing" || Boolean(invoiceTrialEndMs))
            ? "trialing"
            : "active";

        const updated = await updateSubscriptionEntitlement(subscriptionId, {
          status: nextInvoiceStatus,
          plan,
          customerId,
          creatorCode,
          deviceId: metaDeviceId,
          userId,
          ...(resolvedExpiresAtMs ? { expiresAtMs: resolvedExpiresAtMs } : {}),
          ...(nextPaidPassExpiresAtMs
            ? { paidPassExpiresAtMs: nextPaidPassExpiresAtMs }
            : {}),
          ...(amountPaidCents > 0 ? { lastChargeSucceeded: true } : {}),
          lastStripeEventCreated: eventCreated,
        });

        const resolvedInvoiceEmail =
          (typeof obj.customer_email === "string" ? obj.customer_email : "") ||
          metadata.customer_email ||
          updated?.customerEmail ||
          existing?.customerEmail ||
          "";

        const invoiceDeviceId =
          metaDeviceId ||
          normalizeRealDeviceId(updated?.deviceId) ||
          normalizeRealDeviceId(existing?.deviceId) ||
          undefined;

        await refreshSubscriptionConsentOnRenewal({
          sessionId: updated?.sessionId || existing?.sessionId,
          customerId: customerId || updated?.customerId || existing?.customerId,
          email: resolvedInvoiceEmail,
          deviceId: invoiceDeviceId,
          subscriptionId,
          plan,
        });

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
            userId,
          });
        }

        // Report trial-to-paid conversions & renewals to Meta CAPI for accurate ROAS without double-counting pro_subscribed
        if (amountPaidCents > 0 && obj.billing_reason !== "subscription_create") {
          void import("@/lib/analytics")
            .then(({ sendMetaCapiPurchaseEvent }) =>
              sendMetaCapiPurchaseEvent({
                distinctId: invoiceDeviceId || subscriptionId,
                amountUsd: amountPaidCents / 100,
                plan,
                userEmail: resolvedInvoiceEmail || undefined,
                eventId: invoiceId ? `inv_${invoiceId}` : undefined,
              })
            )
            .catch(() => {});
        }

        // Credit creators strictly from invoice.paid / invoice.payment_succeeded with amount_paid > 0 on pre-tax net USD
        if (
          creatorCode &&
          !/^BROC-[A-Z0-9]{4,10}$/.test(creatorCode) &&
          preTaxPaidCents > 0 &&
          invoiceId
        ) {
          await recordStripeCreatorConversionOnce(
            `invoice:${invoiceId}`,
            creatorCode,
            plan === "monthly" ? "paid_monthly" : "paid_annual",
            preTaxPaidCents / 100,
            resolvedInvoiceEmail
          );
        }
        break;
      }

      case "charge.refunded":
      case "charge.dispute.created": {
        const isDispute = event.type === "charge.dispute.created";
        const chargeSource = await resolveChargeObjectForRefundOrDispute(
          obj,
          isDispute
        );
        const chargeId = isDispute
          ? typeof obj.charge === "string"
            ? obj.charge
            : typeof (obj.charge as { id?: string } | null)?.id === "string"
              ? (obj.charge as { id: string }).id
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
          typeof chargeSource.amount === "number"
            ? chargeSource.amount
            : typeof obj.amount === "number"
              ? obj.amount
              : amountRefundedCents;

        const piObj =
          chargeSource.payment_intent &&
          typeof chargeSource.payment_intent === "object"
            ? (chargeSource.payment_intent as {
                id?: string;
                metadata?: Record<string, string>;
              })
            : null;
        const paymentIntentId =
          typeof chargeSource.payment_intent === "string"
            ? chargeSource.payment_intent
            : piObj?.id || "";

        const metadata = {
          ...(piObj?.metadata ?? {}),
          ...((chargeSource.metadata ?? {}) as Record<string, string>),
          ...((obj.metadata ?? {}) as Record<string, string>),
        };

        const customerId =
          extractStripeCustomerId(chargeSource.customer) ??
          extractStripeCustomerId(obj.customer);
        const normChargeDeviceId =
          normalizeRealDeviceId(metadata.device_id) || undefined;
        const billingDetails = chargeSource.billing_details as
          | { email?: string | null }
          | undefined;
        const chargeEmail =
          metadata.customer_email ||
          (typeof chargeSource.receipt_email === "string"
            ? chargeSource.receipt_email
            : "") ||
          billingDetails?.email ||
          "";

        let subscriptionId = await resolveSubscriptionFromCharge(chargeSource);
        let existing = subscriptionId
          ? await getSubscriptionEntitlement(subscriptionId)
          : null;
        const isOneTimeOtoPassCharge = metadata.oto_offer === "oto_gift_year";

        const existingPass =
          !existing && (isOneTimeOtoPassCharge || !subscriptionId)
            ? (customerId ? await getCustomerEntitlement(customerId) : null) ??
              (normChargeDeviceId
                ? await getDevicePaidEntitlement(normChargeDeviceId)
                : null) ??
              (chargeEmail ? await getEmailEntitlement(chargeEmail) : null)
            : null;

        if (
          !subscriptionId &&
          !isOneTimeOtoPassCharge &&
          existingPass?.subscriptionId?.startsWith("sub_")
        ) {
          subscriptionId = existingPass.subscriptionId;
          existing =
            (await getSubscriptionEntitlement(subscriptionId)) ?? existingPass;
        }

        let resolvedCheckoutSessionId =
          metadata.session_id ||
          metadata.checkout_session_id ||
          (isOneTimeOtoPassCharge
            ? existingPass?.otoPassSessionIds?.[
                existingPass.otoPassSessionIds.length - 1
              ] || existingPass?.checkoutSessionId
            : existing?.checkoutSessionId || existingPass?.checkoutSessionId) ||
          (existing?.sessionId?.startsWith("cs_") ? existing.sessionId : "") ||
          (existingPass?.sessionId?.startsWith("cs_")
            ? existingPass.sessionId
            : "") ||
          "";

        const isFullRefund =
          isDispute ||
          (amountRefundedCents >= amountCapturedCents && amountCapturedCents > 0);

        const secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
        if (
          isFullRefund &&
          !resolvedCheckoutSessionId &&
          secretKey &&
          paymentIntentId
        ) {
          try {
            const csUrl = new URL("https://api.stripe.com/v1/checkout/sessions");
            csUrl.searchParams.set("payment_intent", paymentIntentId);
            csUrl.searchParams.set("limit", "1");
            const csRes = await fetch(csUrl.toString(), {
              method: "GET",
              headers: { Authorization: `Bearer ${secretKey}` },
              cache: "no-store",
            });
            if (csRes.ok) {
              const csList = (await csRes.json()) as {
                data?: Array<{ id?: string }>;
              };
              const foundCsId = csList.data?.[0]?.id;
              if (typeof foundCsId === "string" && foundCsId.startsWith("cs_")) {
                resolvedCheckoutSessionId = foundCsId;
              }
            }
          } catch {
            /* best-effort session lookup */
          }
        }

        const creatorCode =
          metadata.creator_code ||
          existing?.creatorCode ||
          existingPass?.creatorCode ||
          undefined;
        const plan: PlanId =
          metadata.plan === "monthly"
            ? "monthly"
            : existing?.plan || existingPass?.plan || "annual";

        const hasInvoiceReference = Boolean(
          chargeObjHasSubscriptionLink(chargeSource)
        );
        if (isFullRefund && !subscriptionId && hasInvoiceReference) {
          throw new Error(
            `Unable to resolve subscription for refunded/disputed charge ${chargeId}`
          );
        }

        if (isFullRefund && isOneTimeOtoPassCharge) {
          await revokeOneTimeAnnualPass({
            sessionId: resolvedCheckoutSessionId || undefined,
            customerId,
            deviceId: normChargeDeviceId,
            customerEmail: chargeEmail || undefined,
          });
          if (resolvedCheckoutSessionId) {
            await revokeCheckoutSessionEntitlement(
              resolvedCheckoutSessionId,
              eventCreated
            );
          }
        }

        if (subscriptionId && isFullRefund) {
          await updateSubscriptionEntitlement(subscriptionId, {
            status: "canceled",
            checkoutSessionId: resolvedCheckoutSessionId || undefined,
            lastStripeEventCreated: eventCreated,
          });
          if (resolvedCheckoutSessionId) {
            await revokeCheckoutSessionEntitlement(
              resolvedCheckoutSessionId,
              eventCreated
            );
          }
          if (secretKey && subscriptionId.startsWith("sub_")) {
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
        } else if (
          isFullRefund &&
          !subscriptionId &&
          !isOneTimeOtoPassCharge &&
          resolvedCheckoutSessionId
        ) {
          await revokeCheckoutSessionEntitlement(
            resolvedCheckoutSessionId,
            eventCreated
          );
        }

        if (creatorCode && !/^BROC-[A-Z0-9]{4,10}$/.test(creatorCode) && amountRefundedCents > 0) {
          const rawInvoice = chargeSource.invoice;
          const invoiceIdForClawback =
            typeof rawInvoice === "string"
              ? rawInvoice
              : rawInvoice &&
                  typeof (rawInvoice as { id?: string }).id === "string"
                ? (rawInvoice as { id: string }).id
                : "";
          const originalConversionKey = invoiceIdForClawback
            ? `invoice:${invoiceIdForClawback}`
            : isOneTimeOtoPassCharge && resolvedCheckoutSessionId
              ? `session:${resolvedCheckoutSessionId}`
              : undefined;
          const buyerEmail =
            chargeEmail ||
            existing?.customerEmail ||
            existingPass?.customerEmail ||
            undefined;
          const otoOfferMeta = metadata.oto_offer || undefined;

          const refundsObj = chargeSource.refunds as
            | { data?: Array<{ id?: string; amount?: number }> }
            | undefined;
          const refundList =
            !isDispute && Array.isArray(refundsObj?.data)
              ? refundsObj.data.filter(
                (r) =>
                  typeof r?.id === "string" &&
                  typeof r?.amount === "number" &&
                  r.amount > 0
              )
              : [];
          if (refundList.length > 0) {
            for (const r of refundList) {
              const itemIsFullRefund =
                amountCapturedCents > 0 && r.amount! >= amountCapturedCents;
              const refundRatio =
                amountCapturedCents > 0
                  ? Math.min(1, r.amount! / amountCapturedCents)
                  : undefined;
              await recordStripeCreatorRefundOnce(
                `refund:${r.id!}`,
                creatorCode,
                plan,
                r.amount! / 100,
                itemIsFullRefund ? true : undefined,
                {
                  buyerEmail,
                  originalConversionKey,
                  otoOffer: otoOfferMeta,
                  refundRatio,
                }
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
              const deltaIsFullRefund =
                isDispute ||
                (amountCapturedCents > 0 && deltaCents >= amountCapturedCents);
              const refundRatio =
                amountCapturedCents > 0
                  ? Math.min(1, deltaCents / amountCapturedCents)
                  : undefined;
              const recorded = await recordStripeCreatorRefundOnce(
                `${isDispute ? "dispute" : "refund"}:${chargeId}:${event.id || amountRefundedCents}`,
                creatorCode,
                plan,
                deltaCents / 100,
                deltaIsFullRefund ? true : undefined,
                {
                  buyerEmail,
                  originalConversionKey,
                  otoOffer: otoOfferMeta,
                  refundRatio,
                }
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
        const existing = await getSubscriptionEntitlement(subscriptionId);
        await updateSubscriptionEntitlement(subscriptionId, {
          status: "canceled",
          lastStripeEventCreated: eventCreated,
        });
        if (existing?.checkoutSessionId) {
          await revokeCheckoutSessionEntitlement(
            existing.checkoutSessionId,
            eventCreated
          );
        }
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
        error:
          err instanceof Error ? err.message : "Webhook processing failed.",
      },
      { status: 500 }
    );
  }
}
