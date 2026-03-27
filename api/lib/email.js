let warnedDefaultFrom = false;

/** Avoid hanging serverless handlers if Resend is slow or the connection stalls. */
const RESEND_FETCH_TIMEOUT_MS = 15000;

/** Default From when RESEND_FROM is unset (Resend onboarding domain). */
const DEFAULT_RESEND_FROM = 'IMA Summer Camp <onboarding@resend.dev>';

async function sendResend({ to, subject, text, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error(
      '[email] RESEND_API_KEY is not set — no emails will send. Add it in Vercel → Project → Settings → Environment Variables (Production), then redeploy.'
    );
    return { skipped: true, reason: 'missing_key' };
  }
  const from = (process.env.RESEND_FROM && String(process.env.RESEND_FROM).trim()) || DEFAULT_RESEND_FROM;
  if (!warnedDefaultFrom && !process.env.RESEND_FROM) {
    warnedDefaultFrom = true;
    console.warn('[email] RESEND_FROM not set — using', DEFAULT_RESEND_FROM);
  }
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
const ADMIN_DASHBOARD_URL = 'https://ima-summer-camp.vercel.app/admin.html';

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
  buildAdminPaidNotificationText,
  buildAdminPaidNotificationHtml,
  buildAdminPaidSubject,
  formatMoney,
  escapeHtml,
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
 * When a parent opens Checkout (before payment): notify staff only.
 * Fire-and-forget from create-checkout-session.
 */
async function sendCheckoutStartedAdminNotify(payload) {
  const {
    parentName,
    parentEmail,
    sessionId,
    batchId,
    cartLines,
    intendedTotal,
    registrationIncluded,
  } = payload;
  const subject = '🥊 IMA Camp — Checkout started (payment pending)';
  const lines = [
    'A parent opened Stripe Checkout — payment is not confirmed until Stripe completes the session.',
    '',
    `Parent: ${parentName || '—'} <${parentEmail || 'n/a'}>`,
    `Stripe Checkout session: ${sessionId}`,
    `Batch (pending enrollments): ${batchId}`,
    '',
    'Items in cart:',
  ];
  (cartLines && cartLines.length ? cartLines : ['(none)']).forEach(function (l) {
    lines.push(`• ${l}`);
  });
  lines.push('');
  lines.push(`Cart total if paid as shown: ${formatMoney(intendedTotal)}`);
  lines.push(registrationIncluded ? 'Registration fee is included in this cart.' : 'No registration fee line in this cart.');
  lines.push('');
  lines.push(`View in admin: ${ADMIN_DASHBOARD_URL}`);
  const text = lines.join('\n');

  const listItems = (cartLines && cartLines.length ? cartLines : ['(none)'])
    .map((l) => `<li>${escapeHtml(l)}</li>`)
    .join('');
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.5;color:#111">
  <p><strong>Checkout started</strong> — payment still pending.</p>
  <p><strong>Parent:</strong> ${escapeHtml(parentName || '—')} &lt;${escapeHtml(parentEmail || 'n/a')}&gt;</p>
  <p><strong>Session:</strong> ${escapeHtml(sessionId)}<br/><strong>Batch:</strong> ${escapeHtml(batchId)}</p>
  <p><strong>Cart:</strong></p>
  <ul style="margin:8px 0;padding-left:20px">${listItems}</ul>
  <p><strong>Total if paid:</strong> ${escapeHtml(formatMoney(intendedTotal))}</p>
  <p>${registrationIncluded ? 'Registration fee included.' : 'No registration fee in cart.'}</p>
  <p><a href="${escapeHtml(ADMIN_DASHBOARD_URL)}" style="color:#0d9488">View in admin</a></p>
</div>`;

  return sendResendToStaff(subject, text, html);
}

/**
 * Customer receipt + staff paid-booking alerts after checkout is confirmed in our DB.
 * Runs whenever result.ok (including already-confirmed) unless Stripe metadata says we already sent.
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

  const parentSubject = '🥊 IMA Summer Camp — Booking Confirmed!';

  let textBody;
  let htmlBody;
  let summary = null;
  try {
    const sb = serviceClient();
    summary = await buildBookingEmailSummary(sb, session, result);
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

  let parentOk = !customerEmail;
  if (customerEmail) {
    const r = await sendResend({
      to: customerEmail,
      subject: parentSubject,
      text: textBody,
      html: htmlBody,
    });
    parentOk = !!(r.ok && !r.skipped);
    if (!parentOk) {
      console.error('[email] parent confirmation Resend failure', customerEmail, r.error || r.reason || r.status);
    }
  }

  let adminText;
  let adminHtml;
  let adminSubject;
  if (summary) {
    adminSubject = buildAdminPaidSubject(summary);
    adminText = buildAdminPaidNotificationText(summary, customerEmail, session.id);
    adminHtml = buildAdminPaidNotificationHtml(summary, customerEmail, session.id);
  } else {
    adminSubject = '🥊 New IMA Camp Booking — (summary unavailable)';
    adminText = [
      'New booking received (full summary could not be built).',
      `Parent email: ${customerEmail || 'n/a'}`,
      `Stripe session: ${session.id}`,
      `View in admin: ${ADMIN_DASHBOARD_URL}`,
    ].join('\n');
    adminHtml = `<p>Paid checkout — see <a href="${escapeHtml(ADMIN_DASHBOARD_URL)}">admin</a>. Session ${escapeHtml(
      session.id
    )}</p>`;
  }

  const staffPaidResults = await sendResendToStaff(adminSubject, adminText, adminHtml);
  const staffPaidOk =
    staffPaidResults.length > 0 && staffPaidResults.every((x) => x.ok && !x.skipped);

  if (parentOk && staffPaidOk) {
    try {
      await markCampPaymentEmailsSent(stripe, session.id);
      console.log('[email] camp payment emails complete; marked', META_SENT, 'on', session.id);
    } catch (e) {
      console.error('[email] could not set Stripe metadata after sends:', e && e.message ? e.message : e);
    }
  } else {
    console.error(
      '[email] camp payment emails incomplete — not marking sent (parentOk=%s staffPaidOk=%s). Fix Resend/domain or check logs.',
      parentOk,
      staffPaidOk
    );
  }
}

module.exports = {
  sendResend,
  sendCampPaymentEmails,
  sendResendToStaff,
  sendCheckoutStartedAdminNotify,
  CAMP_STAFF_NOTIFY,
  DEFAULT_RESEND_FROM,
};
