const { sendResend, resolveResendApiKey, DEFAULT_RESEND_FROM } = require('./send-resend');

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

  const agreementId = meta.agreement_record_id && String(meta.agreement_record_id).trim();
  if (agreementId && customerEmail) {
    try {
      const sbAck = serviceClient();
      const { sendAgreementAcknowledgmentEmailOnce } = require('./agreement-record');
      const ack = await sendAgreementAcknowledgmentEmailOnce(sbAck, agreementId, customerEmail);
      console.log('[email] agreement acknowledgment', ack.sent ? 'sent' : ack.reason || 'skip');
    } catch (ackErr) {
      console.error('[email] agreement acknowledgment failed:', ackErr && ackErr.message ? ackErr.message : ackErr);
    }
  }
}

const STEP_UP_PARENT_BODY =
  'We have reserved your child\'s spot. You must visit the Step Up for Students website and allocate funds to IMA Impact Martial Athletics to complete payment. Once Step Up processes your allocation, your registration will be finalized.';

/**
 * Parent + staff email after Step Up path (no Stripe).
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 */
async function sendStepUpReservationEmails(sb, { batchId, parentEmail, parentName, testPricing }) {
  const bid = batchId && String(batchId).trim();
  if (!bid) return { ok: false, reason: 'no_batch' };

  const { data: rows, error } = await sb
    .from('enrollments')
    .select(
      'id, day_ids, week_id, price_paid, status, campers(first_name, last_name), weeks(label, week_number)'
    )
    .eq('checkout_batch_id', bid)
    .order('created_at', { ascending: true });
  if (error) throw error;
  const list = rows || [];
  if (!list.length) return { ok: false, reason: 'no_rows' };

  const lines = list.map((r) => {
    const c = r.campers || {};
    const w = r.weeks || {};
    const nm = `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Camper';
    const wl = w.label || 'Week';
    return `• ${nm} — ${wl} (status: ${r.status || 'n/a'})`;
  });

  const greet = (parentName && String(parentName).trim()) || 'there';
  const testNote = testPricing ? '\n\n[Test pricing was on for this request — staff only.]' : '';
  const textBody = [
    `Hi ${greet},`,
    '',
    STEP_UP_PARENT_BODY,
    '',
    'Reserved sessions:',
    ...lines,
    '',
    'Manage or review: ' + MANAGE_BOOKINGS_URL,
    '',
    'Questions? tom@imaimpact.com',
    '',
    '— Impact Martial Athletics',
    testNote,
  ]
    .filter(Boolean)
    .join('\n');

  const esc = escapeHtml;
  const htmlBody = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">
  <p>Hi ${esc(greet)},</p>
  <p>${esc(STEP_UP_PARENT_BODY)}</p>
  <p><strong>Reserved sessions</strong></p>
  <ul style="margin:0;padding-left:1.2em">${list
    .map((r) => {
      const c = r.campers || {};
      const w = r.weeks || {};
      const nm = esc(`${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Camper');
      const wl = esc(w.label || 'Week');
      return `<li>${nm} — ${wl}</li>`;
    })
    .join('')}</ul>
  <p><a href="${esc(MANAGE_BOOKINGS_URL)}">Open camp registration</a></p>
  <p>Questions? <a href="mailto:tom@imaimpact.com">tom@imaimpact.com</a></p>
  <p>— <strong>Impact Martial Athletics</strong></p>
  ${testPricing ? '<p><em>Test pricing was on — staff only.</em></p>' : ''}
</div>`;

  const subject = '🥊 IMA Summer Camp — Spot reserved (Step Up for Students)';

  if (parentEmail && String(parentEmail).trim()) {
    const r = await sendResend({
      to: String(parentEmail).trim(),
      subject,
      text: textBody,
      html: htmlBody,
    });
    console.log('[email] step-up parent', r.ok ? 'ok' : 'fail', parentEmail, r.error || r.id || '');
  } else {
    console.warn('[email] step-up parent skipped (no email)');
  }

  const adminSubject = `🥊 Step Up reservation — ${list.length} row(s) — ${parentEmail || 'no email'}`;
  const adminText = [
    'Step Up for Students — spot reserved (pending funding).',
    '',
    `Parent: ${parentName || 'n/a'} <${parentEmail || 'n/a'}>`,
    `Batch: ${bid}`,
    testPricing ? 'TEST PRICING: yes' : '',
    '',
    ...lines,
    '',
    'Admin: ' + ADMIN_DASHBOARD_URL,
  ]
    .filter(Boolean)
    .join('\n');

  const adminHtml = `<p><strong>Step Up reservation</strong> (pending Step Up funding)</p>
  <p>Parent: ${esc(parentName || 'n/a')} &lt;${esc(parentEmail || 'n/a')}&gt;</p>
  <p>Batch: ${esc(bid)}</p>
  <ul>${list
    .map((r) => {
      const c = r.campers || {};
      const w = r.weeks || {};
      const nm = esc(`${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Camper');
      return `<li>${nm} — ${esc(w.label || 'Week')}</li>`;
    })
    .join('')}</ul>
  <p><a href="${esc(ADMIN_DASHBOARD_URL)}">Admin</a></p>`;

  await sendResendToStaff(adminSubject, adminText, adminHtml);
  return { ok: true };
}

module.exports = {
  sendResend,
  sendCampPaymentEmails,
  sendStepUpReservationEmails,
  sendResendToStaff,
  resolveResendApiKey,
  CAMP_STAFF_NOTIFY,
  DEFAULT_RESEND_FROM,
};
