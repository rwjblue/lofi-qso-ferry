/** Transport-neutral content for the native Cloudflare binding and Resend.
 * Both support HTML plus plain text. Keep recipient/sender and delivery state in
 * the caller; these builders neither send nor retain verification codes.
 * https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */
export interface MailContent {
  subject: string;
  html: string;
  text: string;
}

function configuredOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Email origin must be a configured HTTPS origin");
  }
  if (
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && parsed.hostname === "localhost")) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !/^[a-z0-9.-]+$/.test(parsed.hostname) ||
    parsed.hostname.endsWith(".")
  )
    throw new Error("Email origin must be a configured HTTPS origin");
  return parsed;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });

function layout(input: {
  title: string;
  preview: string;
  eyebrow: string;
  body: string;
  footer: string;
  binding?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(input.title)}</title>
  <style>@media (max-width: 480px) { .outer { padding: 20px 12px !important; } .content { padding: 28px 22px !important; } }</style>
</head>
<body style="margin:0;padding:0;background-color:#f4f7f5;color:#16333a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(input.preview)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f4f7f5;">
    <tr><td class="outer" align="center" style="padding:40px 20px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;border:1px solid #d8e2de;border-radius:16px;overflow:hidden;background-color:#ffffff;">
        <tr><td style="padding:24px 32px;background-color:#102e35;color:#edf7ef;font-size:20px;font-weight:700;letter-spacing:-0.4px;">LoFi QSO Ferry</td></tr>
        <tr><td class="content" style="padding:36px 32px 32px;">
          <p style="margin:0 0 12px;color:#146c68;font-size:12px;font-weight:700;letter-spacing:1.5px;">${escapeHtml(input.eyebrow)}</p>
          <h1 style="margin:0 0 20px;font-size:28px;line-height:1.2;letter-spacing:-0.6px;color:#16333a;">${escapeHtml(input.title)}</h1>
          ${input.body}
        </td></tr>
        <tr><td style="padding:22px 32px;border-top:1px solid #d8e2de;background-color:#f8faf9;color:#526d6b;font-size:13px;line-height:1.6;">${escapeHtml(input.footer)}</td></tr>
      </table>
      ${input.binding ? `<p style="margin:20px 0 0;color:#526d6b;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.6;">${escapeHtml(input.binding)}</p>` : ""}
    </td></tr>
  </table>
</body>
</html>`;
}

/** Apple's final-line domain-bound format also keeps a readable plain-text code.
 * This is a compatibility measure, not proof of any device/mail-client AutoFill.
 * https://developer.apple.com/documentation/security/enabling-autofill-for-domain-bound-sms-codes
 */
export function verificationEmail(input: {
  origin: string;
  code: string;
  purpose: "signup" | "email";
}): MailContent {
  const origin = configuredOrigin(input.origin);
  if (input.code.length !== 6 || !/^\d{6}$/.test(input.code))
    throw new Error("Verification code must contain six digits");
  const changingEmail = input.purpose === "email";
  const title = changingEmail ? "Confirm your new email" : "Confirm your email";
  const explanation = changingEmail
    ? "Use this code to confirm the new email address for your Ferry account. Your existing passkeys continue to protect your account."
    : "Use this code to confirm your email address and continue creating your Ferry account. You will create a passkey next.";
  const instructions =
    "Enter it in the original Ferry tab. This verification code expires in 10 minutes.";
  const footer =
    "If you did not request this code, you can ignore this email. This code cannot sign you in or recover an existing account.";
  const binding = `@${origin.hostname} #${input.code}`;
  const subject = `${input.code} is your Ferry verification code`;
  return {
    subject,
    text: [
      "LoFi QSO Ferry",
      title,
      explanation,
      `Verification code: ${input.code}`,
      instructions,
      footer,
      binding,
    ].join("\n\n"),
    html: layout({
      title,
      preview:
        "Confirm your email in the original Ferry tab within 10 minutes.",
      eyebrow: "EMAIL VERIFICATION",
      body: `<p style="margin:0 0 24px;font-size:16px;line-height:1.65;">${escapeHtml(explanation)}</p>
          <div style="margin:0 0 24px;padding:22px 16px;border:1px solid #caddd3;border-radius:10px;background-color:#f0f7f3;text-align:center;">
            <p style="margin:0 0 8px;color:#146c68;font-size:12px;font-weight:700;">VERIFICATION CODE</p>
            <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:38px;line-height:1.2;font-weight:700;letter-spacing:5px;color:#102e35;">${input.code}</p>
          </div>
          <p style="margin:0;font-size:15px;line-height:1.65;">${escapeHtml(instructions)}</p>`,
      footer,
      binding,
    }),
  };
}

export function invitationEmail(input: {
  origin: string;
  /** The durable invitation deadline; omit only when the caller lacks it. */
  expiresAt?: number;
}): MailContent {
  const origin = configuredOrigin(input.origin);
  const join = new URL("/join", origin).href;
  let expiry = "Your invitation expires seven days after it was issued.";
  if (input.expiresAt !== undefined) {
    if (
      !Number.isFinite(input.expiresAt) ||
      !Number.isFinite(new Date(input.expiresAt).getTime())
    )
      throw new Error("Invitation expiry must be a valid timestamp");
    expiry = `Invitations expire seven days after they are issued. This invitation expires ${new Date(
      input.expiresAt,
    )
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, " UTC")}.`;
  }
  const title = "Your logs, quietly in sync.";
  const description =
    "You are invited to LoFi QSO Ferry, which brings contacts from your LoFi log to QRZ and LoTW.";
  const instructions =
    "Open Ferry and use your invited email address. You will confirm it with a separate verification code, then create a passkey. Future sign-ins require a passkey.";
  const terms = `${expiry} It can be used once and only with the invited email address.`;
  const footer =
    "This email does not sign you in. Email confirmation and passkey enrollment are still required.";
  return {
    subject: "You are invited to LoFi QSO Ferry",
    text: [
      "LoFi QSO Ferry",
      title,
      description,
      instructions,
      `Open Ferry: ${join}`,
      terms,
      footer,
    ].join("\n\n"),
    html: layout({
      title,
      preview: "Your invitation to LoFi QSO Ferry is ready.",
      eyebrow: "YOU ARE INVITED",
      body: `<p style="margin:0 0 20px;font-size:16px;line-height:1.65;">${escapeHtml(description)}</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.65;">${escapeHtml(instructions)}</p>
          <p style="margin:0 0 24px;"><a href="${escapeHtml(join)}" style="display:inline-block;min-height:24px;padding:14px 24px;border-radius:8px;background-color:#146c68;color:#ffffff;font-size:16px;line-height:1.5;font-weight:700;text-decoration:none;">Open Ferry</a></p>
          <p style="margin:0;font-size:14px;line-height:1.65;color:#526d6b;">${escapeHtml(terms)}</p>`,
      footer,
    }),
  };
}
