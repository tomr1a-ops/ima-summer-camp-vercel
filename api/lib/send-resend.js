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

module.exports = {
  sendResend,
  resolveResendApiKey,
  DEFAULT_RESEND_FROM,
};
