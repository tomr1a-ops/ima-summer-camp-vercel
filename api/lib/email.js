let warnedDefaultFrom = false;

/** Avoid hanging serverless handlers if Resend is slow or the connection stalls. */
const RESEND_FETCH_TIMEOUT_MS = 15000;

/** Default From when RESEND_FROM is unset — use after imaimpact.com is verified in Resend. */
const DEFAULT_RESEND_FROM = 'IMA Summer Camp <noreply@imaimpact.com>';

/**
 * Single place to read the secret (trim whitespace/newlines from Vercel paste mistakes).
 * Only RESEND_API_KEY is supported — do not use public env vars for API keys.
 */
function resolveResendApiKey() {
  const raw = process.env.RESEND_API_KEY;
  if (raw == null || raw === '') return '';
  const k = String(raw).trim();
  return k;
}

async function sendResend({ to, subject, text, html, bcc, cc }) {
  const key = resolveResendApiKey();
  if (!key) {
    console.error(
      '[email] RESEND_API_KEY is not set or empty after trim — no emails will send. Add RESEND_API_KEY in Vercel → Project → Environment Variables (Production), then redeploy.'
    );
    return { skipped: true, reason: 'missing_key' };
  }
  const from = (process.env.RESEND_FROM && String(process.env.RESEND_FROM).trim()) || DEFAULT_RESEND_FROM;
  if (!warnedDefaultFrom && !process.env.RESEND_FROM) {
    warnedDefaultFrom = true;
    console.warn('[email] RESEND_FROM not set — using default', DEFAULT_RESEND_FROM, '(set RESEND_FROM in Vercel to override)');
  }
  const toList = Array.isArray(to) ? to : [to];
  const payload = {
    from,
    to: toList,
    subject,
    text,
  };
  if (html) payload.html = html;
  if (bcc != null && bcc !== '') {
    const b = Array.isArray(bcc) ? bcc : [bcc];
    const bf = b.map(String).map((s) => s.trim()).filter(Boolean);
    if (bf.length) payload.bcc = bf;
  }
  if (cc != null && cc !== '') {
    const c = Array.isArray(cc) ? cc : [cc];
    const cf = c.map(String).map((s) => s.trim()).filter(Boolean);
    if (cf.length) payload.cc = cf;
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
      body: JSON.stringify(payload),
    });
  } catch (e) {
    const name = e && e.name;
    if (name === 'AbortError') {
      console.error('[email] Resend request timed out after', RESEND_FETCH_TIMEOUT_MS, 'ms');
      return { ok: false, error: 'Resend request timed out', status: 0 };
    }
    const msg = e && e.message ? String(e.message) : String(e);
    console.error('[email] Resend fetch failed (network/runtime):', msg);
    return { ok: false, error: msg, status: 0 };
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
 * Staff notifications: tom@ + coachshick@ — single `to` + `bcc` first, then sequential fallback.
 */
async function sendResendToStaff(subject, text, html) {
  const recipients = [...CAMP_STAFF_NOTIFY];
  const primary = recipients[0];
  const rest = recipients.slice(1);
  console.log('[email] ADMIN notify — sendResendToStaff called for tom@imaimpact.com + coachshick@imaimpact.com', {
    primary,
    bcc: rest,
    staffList: recipients,
    subjectPreview: subject ? String(subject).slice(0, 72) : '',
  });

  if (primary && rest.length) {
    const combined = await sendResend({
      to: primary,
      bcc: rest,
      subject,
      text,
      html,
    });
    if (combined.ok && !combined.skipped) {
      console.log('[email] sendResendToStaff SUCCESS (to + bcc, one API call)', {
        resendId: combined.id,
        to: primary,
        bcc: rest,
      });
      return recipients.map(function (addr) {
        return { to: addr, ok: true, id: combined.id };
      });
    }
    if (combined.skipped) {
      console.error('[email] sendResendToStaff SKIPPED (no RESEND_API_KEY)', { recipients });
      return recipients.map(function (to) {
        return { to, skipped: true, reason: combined.reason };
      });
    }
    console.warn('[email] sendResendToStaff to+bcc failed — sequential fallback', {
      status: combined.status,
      error: combined.error,
    });
  }

  const results = [];
  for (let i = 0; i < recipients.length; i++) {
    const addr = recipients[i];
    console.log('[email] sendResendToStaff sequential', `${i + 1}/${recipients.length}`, addr);
    const r = await sendResend({ to: addr, subject, text, html });
    const row = { to: addr, ...r };
    results.push(row);
    if (r.ok && !r.skipped) {
      console.log('[email] sendResendToStaff OK', addr, r.id || '');
    } else if (!r.skipped) {
      console.error('[email] sendResendToStaff FAIL', addr, r.status, r.error);
    }
  }
  return results;
}

const META_SENT = 'camp_payment_emails_sent';

const { serviceClient } = require('./supabase');
const {
  buildBookingEmailSummary,
  buildFallbackSummaryFromStripeSession,
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
 * Callers should await this inside try/catch so serverless runtimes finish the HTTP work before freeze.
 */
async function sendCheckoutStartedAdminNotify(payload) {
  try {
    return await sendCheckoutStartedAdminNotifyInner(payload);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.error('[email] sendCheckoutStartedAdminNotify unexpected error:', msg, e && e.stack ? e.stack : '');
    return [{ to: 'all', ok: false, error: msg }];
  }
}

async function sendCheckoutStartedAdminNotifyInner(payload) {
  const {
    parentName,
    parentEmail,
    sessionId,
    batchId,
    cartLines,
    intendedTotal,
    registrationIncluded,
  } = payload;
  const keyPresent = !!resolveResendApiKey();
  console.log('[email] checkout-started notify begin', {
    sessionId: sessionId || null,
    batchId: batchId || null,
    adminEmailsTomAndCoach: CAMP_STAFF_NOTIFY,
    resendApiKeyConfigured: keyPresent,
  });
  console.log(
    '[email] checkout-started — calling sendResendToStaff → tom@imaimpact.com & coachshick@imaimpact.com'
  );
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

  const results = await sendResendToStaff(subject, text, html);
  const okCount = results.filter(function (r) {
    return r.ok && !r.skipped;
  }).length;
  const skipped = results.some(function (r) {
    return r.skipped;
  });
  if (skipped) {
    console.error('[email] checkout-started notify finished: SKIPPED (missing RESEND_API_KEY)', { sessionId });
  } else if (okCount === results.length) {
    console.log('[email] checkout-started notify success', {
      sessionId,
      sent: okCount,
      resendIds: results.map(function (r) {
        return r.id || null;
      }),
    });
  } else {
    console.error('[email] checkout-started notify partial or full failure', {
      sessionId,
      results: results.map(function (r) {
        return { to: r.to, ok: r.ok, skipped: r.skipped, error: r.error || null };
      }),
    });
  }
  return results;
}

/**
 * Customer receipt + staff paid-booking alerts after payment succeeds (confirm-checkout or webhook).
 * Idempotent via Stripe session metadata camp_payment_emails_sent.
 */
async function sendCampPaymentEmails(stripe, session, result) {
  if (!result || !result.ok) {
    console.log('[email] sendCampPaymentEmails skip (result not ok)', result && result.reason);
    return;
  }
  const metaEarly = session.metadata || {};
  if (metaEarly[META_SENT] === '1') {
    console.log('[email] sendCampPaymentEmails skip (already sent)', session.id);
    return;
  }

  let sessionForEmail = session;
  try {
    const hasLines = session.line_items && session.line_items.data && session.line_items.data.length;
    if (!hasLines && stripe && session.id) {
      sessionForEmail = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['line_items', 'customer_details'],
      });
    }
  } catch (reErr) {
    console.warn('[email] could not re-fetch session for line_items:', reErr && reErr.message ? reErr.message : reErr);
  }

  const meta = sessionForEmail.metadata || {};
  const customerEmail =
    result.email ||
    (sessionForEmail.customer_details && sessionForEmail.customer_details.email) ||
    sessionForEmail.customer_email ||
    '';

  console.log('[email] camp payment emails START', {
    sessionId: sessionForEmail.id,
    parentEmail: customerEmail || '(none)',
    resendKey: !!resolveResendApiKey(),
  });

  const parentSubject = '🥊 IMA Summer Camp — Booking Confirmed!';

  let summary = null;
  try {
    const sb = serviceClient();
    summary = await buildBookingEmailSummary(sb, sessionForEmail, result);
  } catch (e) {
    console.error('[email] buildBookingEmailSummary failed:', e && e.message ? e.message : e, e && e.stack ? e.stack : '');
  }
  if (!summary) {
    try {
      summary = buildFallbackSummaryFromStripeSession(sessionForEmail, result);
      console.log('[email] using Stripe line_items fallback summary', sessionForEmail.id);
    } catch (e2) {
      console.error('[email] buildFallbackSummaryFromStripeSession failed:', e2 && e2.message ? e2.message : e2);
    }
  }

  let textBody;
  let htmlBody;
  if (summary) {
    textBody = buildPlainTextBody(summary, MANAGE_BOOKINGS_URL);
    htmlBody = buildHtmlBody(summary, MANAGE_BOOKINGS_URL);
  } else {
    const gt = (sessionForEmail.amount_total != null ? Number(sessionForEmail.amount_total) : 0) / 100;
    textBody = [
      'Hi there,',
      '',
      'Your IMA Summer Camp payment went through.',
      `Total charged: ${formatMoney(gt)}`,
      '',
      'Manage bookings: ' + MANAGE_BOOKINGS_URL,
      '',
      'Questions? tom@imaimpact.com',
      '',
      '— Impact Martial Athletics',
    ].join('\n');
    htmlBody = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">
  <p>Hi there,</p>
  <p>Your <strong>IMA Summer Camp</strong> payment went through.</p>
  <p><strong>Total charged:</strong> ${escapeHtml(formatMoney(gt))}</p>
  <p><a href="${escapeHtml(MANAGE_BOOKINGS_URL)}">Manage bookings</a></p>
  <p>Questions? <a href="mailto:tom@imaimpact.com">tom@imaimpact.com</a></p>
</div>`;
    console.warn('[email] sent minimal parent receipt (no summary)', sessionForEmail.id);
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
    console.log(
      '[email] parent booking email',
      parentOk ? 'SUCCESS' : 'FAIL',
      customerEmail,
      r.skipped ? '(skipped)' : r.error || r.id || ''
    );
    if (!parentOk && !r.skipped) {
      console.error('[email] parent Resend failure detail', r.error || r.status);
    }
  } else {
    console.warn('[email] no customer email on session — parent booking email skipped');
  }

  let adminText;
  let adminHtml;
  let adminSubject;
  if (summary) {
    adminSubject = buildAdminPaidSubject(summary);
    adminText = buildAdminPaidNotificationText(summary, customerEmail, sessionForEmail.id);
    adminHtml = buildAdminPaidNotificationHtml(summary, customerEmail, sessionForEmail.id);
  } else {
    const gt = (sessionForEmail.amount_total != null ? Number(sessionForEmail.amount_total) : 0) / 100;
    adminSubject = `🥊 New IMA Camp Booking — ${formatMoney(gt)}`;
    adminText = [
      'New booking received!',
      '',
      `Parent: (${customerEmail || 'n/a'})`,
      `TOTAL: ${formatMoney(gt)}`,
      `Stripe session: ${sessionForEmail.id}`,
      `View admin: ${ADMIN_DASHBOARD_URL}`,
    ].join('\n');
    adminHtml = `<p><strong>New booking</strong> — ${escapeHtml(formatMoney(gt))}</p>
  <p>Session ${escapeHtml(sessionForEmail.id)}</p>
  <p><a href="${escapeHtml(ADMIN_DASHBOARD_URL)}">View admin</a></p>`;
  }

  console.log(
    '[email] paid booking ADMIN notify — sendResendToStaff → tom@imaimpact.com & coachshick@imaimpact.com',
    { sessionId: sessionForEmail.id, staffList: [...CAMP_STAFF_NOTIFY] }
  );
  const staffPaidResults = await sendResendToStaff(adminSubject, adminText, adminHtml);
  const staffPaidOk =
    staffPaidResults.length > 0 && staffPaidResults.every((x) => x.ok && !x.skipped);
  console.log(
    '[email] staff booking emails',
    staffPaidOk ? 'SUCCESS' : 'PARTIAL_OR_FAIL',
    staffPaidResults.map((x) => ({ to: x.to, ok: x.ok, skipped: x.skipped }))
  );

  if (parentOk && staffPaidOk) {
    try {
      await markCampPaymentEmailsSent(stripe, sessionForEmail.id);
      console.log('[email] camp payment emails COMPLETE; marked', META_SENT, 'on', sessionForEmail.id);
    } catch (e) {
      console.error('[email] could not set Stripe metadata after sends:', e && e.message ? e.message : e);
    }
  } else {
    console.error(
      '[email] camp payment emails INCOMPLETE — not marking sent (parentOk=%s staffPaidOk=%s). Retry confirm-checkout or check Resend.',
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
  resolveResendApiKey,
  CAMP_STAFF_NOTIFY,
  DEFAULT_RESEND_FROM,
};
