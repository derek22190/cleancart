# Stripe Test Clock & Webhook Verification Guide

Use the official [Stripe CLI](https://docs.stripe.com/cli) and Stripe Test Clocks to verify end-to-end subscription lifecycle events (`trial -> paid`, `failed card`, `refund`, and `cancel`) against `/api/stripe/webhook` and `/api/billing/portal`.

---

## 0. Prerequisites & Local Webhook Forwarding

```bash
# 1. Start the local Next.js dev server
npm run dev

# 2. In a second terminal, forward Stripe webhook events to your local endpoint
stripe listen --forward-to http://localhost:3000/api/stripe/webhook

# 3. Copy the printed whsec_... signing secret into .env.local:
# STRIPE_WEBHOOK_SECRET=whsec_...
# STRIPE_SECRET_KEY=sk_test_...
```

---

## 1. Create a Test Clock & Customer

```bash
# Create a test clock frozen at the current Unix timestamp
FROZEN_TIME=$(date +%s)
CLOCK_ID=$(stripe test_helpers test_clocks create \
  --frozen-time="$FROZEN_TIME" \
  --name="HeyBroc Annual Trial Lifecycle" \
  --format=json | jq -r '.id')

echo "Test Clock ID: $CLOCK_ID"

# Create a customer attached to the test clock with a valid test card
CUSTOMER_ID=$(stripe customers create \
  --email="test-family@heybroc.com" \
  --test-clock="$CLOCK_ID" \
  --payment-method="pm_card_visa" \
  --invoice-settings.default_payment_method="pm_card_visa" \
  --format=json | jq -r '.id')

echo "Customer ID: $CUSTOMER_ID"
```

---

## 2. Scenario A: `trial -> paid` Conversion (Creator Commission Credited Only on `invoice.paid`)

```bash
# Create an Annual Price ($23.88/yr)
PRICE_ID=$(stripe prices create \
  --currency=usd \
  --unit-amount=2388 \
  --recurring.interval=year \
  --product-data.name="HeyBroc Family Pro (Annual)" \
  --format=json | jq -r '.id')

# Start a 7-day trial subscription with creator_code=CLEANMOM and device_id=android-test-01
SUB_ID=$(stripe subscriptions create \
  --customer="$CUSTOMER_ID" \
  --items[0].price="$PRICE_ID" \
  --trial-period-days=7 \
  --metadata[plan]=annual \
  --metadata[creator_code]=CLEANMOM \
  --metadata[device_id]=android-test-01 \
  --metadata[terms_version]=2026-11-08 \
  --format=json | jq -r '.id')

echo "Subscription ID: $SUB_ID"
# Verify: During the $0 trial invoice, CLEANMOM receives 0 paid commission.

# Advance the test clock by 8 days to trigger trial -> paid conversion and invoice.paid
ADVANCE_TO=$((FROZEN_TIME + 8 * 86400))
stripe test_helpers test_clocks advance "$CLOCK_ID" --frozen-time="$ADVANCE_TO"

# Verify:
# 1. `invoice.paid` fires with `amount_paid = 2388` (> 0).
# 2. Creator `CLEANMOM` is credited exactly once under key `invoice:<in_id>`.
# 3. GET /api/entitlement?deviceId=android-test-01 returns `active: true, status: "active"`.
```

---

## 3. Scenario B: `failed card` (`invoice.payment_failed` / `past_due`)

```bash
# Attach a failing card before the next renewal or trial end
PM_FAIL=$(stripe payment_methods attach pm_card_chargeCustomerFail \
  --customer="$CUSTOMER_ID" --format=json | jq -r '.id')

stripe customers update "$CUSTOMER_ID" \
  --invoice-settings.default_payment_method="$PM_FAIL"

# Advance the test clock by 1 year (+366 days) to trigger annual renewal failure
RENEWAL_TIME=$((ADVANCE_TO + 366 * 86400))
stripe test_helpers test_clocks advance "$CLOCK_ID" --frozen-time="$RENEWAL_TIME"

# Verify:
# 1. `invoice.payment_failed` and `customer.subscription.updated` (status: `past_due`) fire.
# 2. GET /api/entitlement?deviceId=android-test-01 returns `active: false, status: "past_due"`.
# 3. No creator commission is credited because `invoice.paid` did not fire.
```

---

## 4. Scenario C: `refund` (`charge.refunded` -> Entitlement Canceled & Commission Reversed)

```bash
# Find the latest paid charge for the customer
CHARGE_ID=$(stripe charges list --customer="$CUSTOMER_ID" --limit=1 --format=json | jq -r '.data[0].id')
echo "Refunding Charge: $CHARGE_ID"

# Issue a full refund on the charge
stripe refunds create --charge="$CHARGE_ID"

# Verify:
# 1. `charge.refunded` webhook resolves `SUB_ID` via the charge's invoice / `invoice_payments` (Basil+).
# 2. Full refund marks entitlement `status: "canceled"` (`active: false`) and cancels the Stripe subscription.
# 3. Creator commission for `CLEANMOM` is reversed once per `refund:<re_id>`.
```

---

## 5. Scenario D: `cancel` via Self-Serve Billing Portal (`POST /api/billing/portal`)

```bash
# Request a self-serve Stripe Billing Portal session for the device or email
curl -s -X POST http://localhost:3000/api/billing/portal \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"android-test-01","email":"test-family@heybroc.com"}' | jq .

# Or trigger direct subscription deletion via Stripe CLI:
stripe subscriptions cancel "$SUB_ID"

# Verify:
# 1. `customer.subscription.deleted` webhook fires.
# 2. GET /api/entitlement?deviceId=android-test-01 returns `active: false, status: "canceled"`.
```
