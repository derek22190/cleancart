const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "HeyBroc <onboarding@heybroc.com>";

interface SendEmailResult {
  ok: boolean;
  error?: string;
}

async function sendResendEmail(params: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim() || DEFAULT_FROM;

  if (!apiKey) {
    console.warn("[email] RESEND_API_KEY is not configured; skipping outbound email to", params.to);
    return { ok: false, error: "Email delivery is not configured on this server." };
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [params.to],
        subject: params.subject,
        text: params.text,
        html: params.html,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error("[email] Resend API error:", res.status, errBody.slice(0, 200));
      return { ok: false, error: "Failed to deliver email." };
    }

    return { ok: true };
  } catch (err) {
    console.error("[email] Network error sending email:", err);
    return { ok: false, error: "Network error sending email." };
  }
}

export async function sendVerificationEmail(
  to: string,
  code: string
): Promise<SendEmailResult> {
  const subject = `${code} is your HeyBroc email verification code`;
  const text = [
    "Welcome to HeyBroc!",
    "",
    `Your 6-digit email verification code is: ${code}`,
    "",
    "This code expires in 15 minutes. Verify your email in the HeyBroc account sheet to sync paid Family Pro memberships linked to your email address.",
    "",
    "If you didn't create a HeyBroc account, you can safely ignore this email.",
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #18181b;">
      <h2 style="margin: 0 0 12px; color: #0f7a4a;">Verify your HeyBroc email</h2>
      <p style="margin: 0 0 16px; line-height: 1.5; color: #3f3f46;">
        Enter this 6-digit verification code in HeyBroc to verify your email address and sync any Family Pro membership associated with your email:
      </p>
      <div style="background: #f4f4f5; border-radius: 12px; padding: 16px; text-align: center; font-size: 28px; font-weight: 800; letter-spacing: 6px; color: #18181b; margin: 0 0 16px;">
        ${code}
      </div>
      <p style="margin: 0; font-size: 13px; color: #71717a;">
        This code expires in 15 minutes. If you did not create a HeyBroc account, you can ignore this email.
      </p>
    </div>
  `.trim();

  return sendResendEmail({ to, subject, text, html });
}

export async function sendPasswordResetEmail(
  to: string,
  code: string
): Promise<SendEmailResult> {
  const subject = `${code} is your HeyBroc password reset code`;
  const text = [
    "HeyBroc Password Reset",
    "",
    `Your 6-digit password reset code is: ${code}`,
    "",
    "This code expires in 15 minutes and allows up to 5 attempts.",
    "",
    "If you did not request a password reset, you can safely ignore this email.",
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #18181b;">
      <h2 style="margin: 0 0 12px; color: #0f7a4a;">Reset your HeyBroc password</h2>
      <p style="margin: 0 0 16px; line-height: 1.5; color: #3f3f46;">
        Use the 6-digit code below to reset your HeyBroc password:
      </p>
      <div style="background: #f4f4f5; border-radius: 12px; padding: 16px; text-align: center; font-size: 28px; font-weight: 800; letter-spacing: 6px; color: #18181b; margin: 0 0 16px;">
        ${code}
      </div>
      <p style="margin: 0; font-size: 13px; color: #71717a;">
        This code expires in 15 minutes. If you did not request a password reset, you can safely ignore this email.
      </p>
    </div>
  `.trim();

  return sendResendEmail({ to, subject, text, html });
}
