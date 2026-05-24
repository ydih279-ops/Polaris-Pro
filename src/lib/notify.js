import nodemailer from 'nodemailer';
import { config } from '../config.js';

// If SMTP isn't configured we don't crash — we log to the console. This means
// the whole alert/report pipeline runs end-to-end with zero external setup,
// and lights up for real the moment SMTP env vars are present.
let transporter = null;
if (config.smtp.host && config.smtp.user) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
}

export async function sendEmail(to, subject, text) {
  if (!transporter) {
    console.log(`[notify:email→console] to=${to} subject="${subject}"\n${text}`);
    return { delivered: false, simulated: true };
  }
  await transporter.sendMail({ from: config.smtp.from, to, subject, text });
  return { delivered: true };
}

export async function sendWebhook(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { delivered: res.ok, status: res.status };
  } catch (err) {
    console.error('[notify:webhook] failed:', err.message);
    return { delivered: false, error: err.message };
  }
}

export async function notify(channel, target, subject, body) {
  if (channel === 'webhook') return sendWebhook(target, { subject, body });
  return sendEmail(target, subject, body);
}
