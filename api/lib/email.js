async function sendResend({ to, subject, text, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn('RESEND_API_KEY missing; skip email');
    return { skipped: true };
  }
  const from = process.env.RESEND_FROM || 'IMA Summer Camp <onboarding@resend.dev>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
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
  if (!res.ok) {
    const errText = await res.text();
    console.error('Resend error', res.status, errText);
    return { ok: false, error: errText };
  }
  return { ok: true };
}

module.exports = { sendResend };
