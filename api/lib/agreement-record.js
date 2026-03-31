const AGREEMENT_VERSION = '1.0';

function clientIpFromRequest(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  const real = req.headers && req.headers['x-real-ip'];
  if (real) return String(real).trim();
  return '';
}

function formatAgreementAckEastern(agreedAt) {
  const d = agreedAt instanceof Date ? agreedAt : new Date(agreedAt);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(d);
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 * @param {{ parentId: string, parentName: string, email: string, ipAddress: string, camperIds: string[], version?: string }} opts
 */
async function insertAgreementRecord(sb, opts) {
  const {
    parentId,
    parentName,
    email,
    ipAddress,
    camperIds,
    version = AGREEMENT_VERSION,
  } = opts;
  const uniqueCampers = [...new Set((camperIds || []).map((id) => String(id).trim()).filter(Boolean))];
  let emailOut = String(email || '').trim();
  if (!emailOut) {
    const pid = parentId ? String(parentId).replace(/[^a-f0-9-]/gi, '').slice(0, 36) : 'unknown';
    emailOut = `parent+${pid}@ima-camp-agreement.local`;
    console.warn('[agreement-record] empty email for agreement insert; using synthetic address', { parentId });
  }
  const { data, error } = await sb
    .from('agreement_records')
    .insert({
      parent_id: parentId || null,
      parent_name: String(parentName || '').trim() || 'Unknown',
      email: emailOut,
      ip_address: ipAddress ? String(ipAddress).slice(0, 200) : null,
      agreement_version: String(version),
      camper_ids: uniqueCampers,
    })
    .select('id, agreed_at')
    .single();
  if (error) throw error;
  return data;
}

async function sendAgreementAcknowledgmentEmailOnce(sb, agreementRecordId, toEmail) {
  if (!agreementRecordId) return { sent: false, reason: 'missing' };
  const { sendResend } = require('./send-resend');
  const { data: row, error } = await sb
    .from('agreement_records')
    .select('id, acknowledgment_email_sent, agreed_at, agreement_version, parent_name, email')
    .eq('id', agreementRecordId)
    .maybeSingle();
  if (error) throw error;
  if (!row || row.acknowledgment_email_sent) return { sent: false, reason: 'already_sent_or_missing' };

  const addr = String(toEmail || row.email || '').trim();
  if (!addr) return { sent: false, reason: 'no_email' };

  const parentName = String(row.parent_name || '').trim();
  const whenEastern = formatAgreementAckEastern(row.agreed_at);
  const ver = row.agreement_version || AGREEMENT_VERSION;
  const subject = 'IMA Summer Camp 2026 — Agreement confirmation';
  const text = [
    `Hi ${parentName || 'there'},`,
    '',
    'This confirms that you agreed to the IMA Summer Camp 2026 Policies, Terms & Liability Agreement.',
    '',
    `Agreement version: ${ver}`,
    `Date and time of agreement (Eastern Time): ${whenEastern}`,
    '',
    'Thank you for completing your registration.',
    '',
    '— Impact Martial Athletics',
  ].join('\n');
  const esc = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55;color:#111;max-width:560px">
  <p>Hi ${esc(parentName || 'there')},</p>
  <p>This confirms that you agreed to the <strong>IMA Summer Camp 2026 Policies, Terms &amp; Liability Agreement</strong>.</p>
  <p><strong>Agreement version:</strong> ${esc(ver)}<br/>
  <strong>Date and time of agreement (Eastern Time):</strong> ${esc(whenEastern)}</p>
  <p>Thank you for completing your registration.</p>
  <p>— Impact Martial Athletics</p>
</div>`;

  const r = await sendResend({ to: addr, subject, text, html });
  if (r.ok && !r.skipped) {
    await sb.from('agreement_records').update({ acknowledgment_email_sent: true }).eq('id', agreementRecordId);
    return { sent: true, id: r.id };
  }
  return { sent: false, reason: r.skipped ? 'skipped' : r.error || 'send_failed' };
}

module.exports = {
  AGREEMENT_VERSION,
  clientIpFromRequest,
  insertAgreementRecord,
  sendAgreementAcknowledgmentEmailOnce,
  formatAgreementAckEastern,
};
