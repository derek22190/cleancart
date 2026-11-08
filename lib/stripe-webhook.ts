import crypto from "node:crypto";

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
