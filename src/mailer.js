import nodemailer from 'nodemailer';

export function smtpConfigured(s) {
  return Boolean(s.smtp_host && s.smtp_from && s.notify_emails);
}

export async function sendMail(s, { subject, text, html }) {
  if (!smtpConfigured(s)) throw new Error('SMTP non configuré (hôte, expéditeur et destinataires requis)');
  const transport = nodemailer.createTransport({
    host: s.smtp_host,
    port: Number(s.smtp_port) || 587,
    secure: Boolean(s.smtp_secure),
    auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_password } : undefined,
  });
  return transport.sendMail({
    from: s.smtp_from,
    to: s.notify_emails.split(/[,;\s]+/).filter(Boolean).join(', '),
    subject, text, html,
  });
}
