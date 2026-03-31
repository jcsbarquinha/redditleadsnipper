import nodemailer from "nodemailer";

export function isMailConfigured(): boolean {
  const host = process.env.SMTP_HOST?.trim() || "";
  const port = Number(process.env.SMTP_PORT || "");
  const user = process.env.SMTP_USER?.trim() || "";
  const pass = process.env.SMTP_PASS?.trim() || "";
  const from = process.env.EMAIL_FROM?.trim() || "";
  return Boolean(host && port && user && pass && from);
}

export async function sendTransactionalMail(params: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const SMTP_HOST = process.env.SMTP_HOST?.trim() || "";
  const SMTP_PORT = Number(process.env.SMTP_PORT || "");
  const SMTP_USER = process.env.SMTP_USER?.trim() || "";
  const SMTP_PASS = process.env.SMTP_PASS?.trim() || "";
  const EMAIL_FROM = process.env.EMAIL_FROM?.trim() || "";

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !EMAIL_FROM) {
    throw new Error("Email is not configured (SMTP_* + EMAIL_FROM).");
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: params.to,
    subject: params.subject,
    text: params.text,
    html: params.html,
  });
}
