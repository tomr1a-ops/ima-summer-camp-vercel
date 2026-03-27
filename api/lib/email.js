let warnedDefaultFrom = false;

/** Avoid hanging serverless handlers if Resend is slow or the connection stalls. */
const RESEND_FETCH_TIMEOUT_MS = 15000;

async function sendResend({ to, subject, text, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error(
      '[email] RESEND_API_KEY is not set — no emails will send. Add it in Vercel → Project → Settings → Environment Variables (Production), then redeploy.'
    );
    return { skipped: true, reason: 'missing_key' };
  }
  if (!warnedDefaultFrom && !process.env.RESEND_FROM) {
    warnedDefaultFrom = true;
    console.warn(
      '[email] RESEND_FROM not set — using onboarding@resend.dev. Resend only delivers to your account signup email until you verify a domain and set RESEND_FROM (e.g. Camp <mail@yourdomain.com>). Staff/customer addresses may be rejected with 403.'
    );
  }
  const from = process.env.RESEND_FROM || 'IMA Summer Camp <onboarding@resend.dev>';
  const ac = new AbortController();
  const tid = setTimeout(function () {
    ac.abort();
  }, RESEND_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        text,
        html: html || undefined,
      }),
    });
  } catch (e) {
    const name = e && e.name;
    if (name === 'AbortError') {
      console.error('[email] Resend request timed out after', RESEND_FETCH_TIMEOUT_MS, 'ms');
      return { ok: false, error: 'Resend request timed out', status: 0 };
    }
    throw e;
  } finally {
    clearTimeout(tid);
  }
  const errText = await res.text();
  let bodyJson = {};
  try {
    bodyJson = JSON.parse(errText);
  } catch {
    /* plain text error */
  }
  if (!res.ok) {
    const msg = bodyJson.message || errText;
    console.error('[email] Resend API rejected request', res.status, msg);
    return { ok: false, error: msg, status: res.status };
  }
  console.log('[email] Resend accepted', { subject, id: bodyJson.id || null });
  return { ok: true, id: bodyJson.id };
}

const CAMP_STAFF_NOTIFY = ['tom@imaimpact.com', 'coachshick@imaimpact.com'];

/**
 * Staff notifications: one API call per address so one bad recipient does not hide the other,
 * and Resend errors are logged per inbox.
 */
async function sendResendToStaff(subject, text, html) {
  const out = [];
  for (const to of CAMP_STAFF_NOTIFY) {
    const r = await sendResend({ to, subject, text, html });
    out.push({ to, ...r });
    if (!r.ok && !r.skipped) {
      console.error('[email] staff notify failed for', to, r.error || r.status);
    }
  }
  return out;
}

const META_SENT = 'camp_payment_emails_sent';

const { serviceClient } = require('./supabase');
const {
  buildBookingEmailSummary,
  buildPlainTextBody,
  buildHtmlBody,
} = require('./booking-email-summary');

/** Parent-facing “manage bookings” link (portal path redirects to main camp registration). */
const MANAGE_BOOKINGS_URL = 'https://ima-summer-camp.vercel.app/portal.html';

async function markCampPaymentEmailsSent(stripe, sessionId) {
  if (!stripe || !sessionId) return;
  const fresh = await stripe.checkout.sessions.retrieve(sessionId);
  const metadata = { ...(fresh.metadata || {}), [META_SENT]: '1' };
  await stripe.checkout.sessions.update(sessionId, { metadata });
}

/**
 * Customer receipt + staff alert after paid checkout is confirmed in our DB.
 * Runs whenever result.ok (including already-confirmed) unless Stripe metadata says we already sent.
 * That way: if the webhook confirmed first but Resend failed, the success-page confirm-checkout can retry.
 */
async function sendCampPaymentEmails(stripe, session, result) {
  if (!result || !result.ok) return;
  const meta = session.metadata || {};
  if (meta[META_SENT] === '1') {
    return;
  }

  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  const customerEmail =
    result.email ||
    (session.customer_details && session.customer_details.email) ||
    session.customer_email ||
    '';

  const subject = '🥊 IMA Summer Camp — Booking Confirmed!';

  let textBody;
  let htmlBody;
  try {
    const sb = serviceClient();
    const summary = await buildBookingEmailSummary(sb, session, result);
    textBody = buildPlainTextBody(summary, MANAGE_BOOKINGS_URL);
    htmlBody = buildHtmlBody(summary, MANAGE_BOOKINGS_URL);
  } catch (e) {
    console.error('[email] booking summary build failed, using short receipt:', e && e.message ? e.message : e);
    textBody =
      'Thank you! Your summer camp payment went through.\n\n' +
      'Create a parent account with the same email to add more weeks on the camp site:\n' +
      (baseUrl || 'https://ima-summer-camp.vercel.app') +
      '/register.html\n\n' +
      '— Impact Martial Athletics';
    htmlBody = undefined;
  }

  let customerOk = !customerEmail;
  if (customerEmail) {
    const r = await sendResend({
      to: customerEmail,
      subject,
      text: textBody,
      html: htmlBody,
    });
    customerOk = !!(r.ok && !r.skipped);
    if (!customerOk) {
      console.error('[email] customer receipt Resend failure', customerEmail, r.error || r.reason || r.status);
    }
  }

  const staffSubject = `${subject} [Staff · ${customerEmail || 'no email'}]`;
  const staffText =
    `Customer: ${customerEmail || 'n/a'}\nSession: ${session.id || 'n/a'}\n\n` + textBody;
  const staffResults = await sendResendToStaff(staffSubject, staffText, htmlBody);
  const staffOk = staffResults.length > 0 && staffResults.every((x) => x.ok && !x.skipped);

  if (customerOk && staffOk) {
    try {
      await markCampPaymentEmailsSent(stripe, session.id);
      console.log('[email] camp payment emails complete; marked', META_SENT, 'on', session.id);
    } catch (e) {
      console.error('[email] could not set Stripe metadata after sends:', e && e.message ? e.message : e);
    }
  } else {
    console.error(
      '[email] camp payment emails incomplete — not marking sent (customerOk=%s staffOk=%s). Fix Resend/domain or check logs.',
      customerOk,
      staffOk
    );
  }
}

module.exports = { sendResend, sendCampPaymentEmails, sendResendToStaff, CAMP_STAFF_NOTIFY };
