const { dayRate, weekRate } = require('./pricing');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '$0';
  const rounded = Math.round(x * 100) / 100;
  const isWhole = Math.abs(rounded - Math.round(rounded)) < 0.001;
  return '$' + (isWhole ? String(Math.round(rounded)) : rounded.toFixed(2));
}

async function fetchEnrollmentRows(sb, stripeSessionId) {
  const { data, error } = await sb
    .from('enrollments')
    .select(
      'id, day_ids, price_paid, parent_id, camper_id, week_id, created_at, campers(first_name,last_name), weeks(id,label,week_number)'
    )
    .eq('stripe_session_id', stripeSessionId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function fetchDaysForWeeks(sb, weekIds) {
  if (!weekIds.length) return new Map();
  const { data, error } = await sb
    .from('days')
    .select('id, week_id, day_name, date')
    .in('week_id', weekIds);
  if (error) throw error;
  const m = new Map();
  (data || []).forEach((d) => {
    const k = String(d.week_id);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(d);
  });
  m.forEach((arr) => arr.sort((a, b) => String(a.date).localeCompare(String(b.date))));
  return m;
}

function formatScheduleForRow(dayIds, weekDays, mode) {
  if (mode === 'full_week') return 'Full week (Mon–Fri)';
  const idSet = new Set((dayIds || []).map(String));
  const picked = (weekDays || []).filter((d) => idSet.has(String(d.id)));
  const labels = picked.map((d) => d.day_name || String(d.date)).filter(Boolean);
  return labels.length ? labels.join(', ') : 'Daily';
}

/**
 * Build parent email copy from Stripe session + Supabase enrollments (stripe_session_id).
 * @param {import('@supabase/supabase-js').SupabaseClient} sb
 */
async function buildBookingEmailSummary(sb, session, result) {
  const meta = session.metadata || {};
  const testPricing = meta.test_pricing === 'true';
  const dr = dayRate(testPricing);
  const wr = weekRate(testPricing);
  const sessionId = session.id;

  const regCents = Number(meta.registration_fee_cents || 0) || 0;
  const shirtCents = Number(meta.extra_shirt_cents || 0) || 0;
  const regTotal = regCents / 100;
  const shirtTotal = shirtCents / 100;

  const modes = (meta.booking_modes || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const enrollRows = await fetchEnrollmentRows(sb, sessionId);
  const weekIds = [...new Set(enrollRows.map((r) => r.week_id).filter(Boolean))];
  const daysByWeek = await fetchDaysForWeeks(sb, weekIds);

  /** @type {{ childName: string, weekCol: string, schedule: string, amount: number, kind: string }[]} */
  const tableRows = [];
  let campSubtotal = 0;

  enrollRows.forEach((row, i) => {
    const wkKey = String(row.week_id);
    const weekDaysForRow = daysByWeek.get(wkKey) || [];
    let mode = modes[i];
    if (!mode) {
      const idSet = new Set((row.day_ids || []).map(String));
      if (weekDaysForRow.length === 5 && weekDaysForRow.every((d) => idSet.has(String(d.id)))) {
        mode = 'full_week';
      } else {
        mode = 'daily';
      }
    }
    const week = row.weeks;
    const weekLabel = week && week.label ? week.label : 'Camp week';
    const camper = row.campers;
    const childName =
      camper && (camper.first_name || camper.last_name)
        ? `${camper.first_name || ''} ${camper.last_name || ''}`.trim()
        : 'Camper';
    const weekDays = weekDaysForRow;
    const schedule = formatScheduleForRow(row.day_ids, weekDays, mode);
    const campAmount = mode === 'full_week' ? wr : (row.day_ids || []).length * dr;
    campSubtotal += campAmount;
    tableRows.push({
      childName,
      weekCol: weekLabel,
      schedule,
      amount: campAmount,
      kind: 'camp',
    });
  });

  const shirtIds = (meta.extra_shirt_camper_ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (shirtTotal > 0 && shirtIds.length) {
    const each = shirtTotal / shirtIds.length;
    const { data: shirtCampers, error: se } = await sb
      .from('campers')
      .select('id, first_name, last_name')
      .in('id', shirtIds);
    if (se) throw se;
    const byId = {};
    (shirtCampers || []).forEach((c) => {
      byId[String(c.id)] = `${c.first_name || ''} ${c.last_name || ''}`.trim();
    });
    shirtIds.forEach((cid) => {
      tableRows.push({
        childName: byId[cid] || 'Camper',
        weekCol: 'Extra camp T-shirt',
        schedule: 'Add-on',
        amount: each,
        kind: 'shirt',
      });
    });
  }

  let parentId = enrollRows[0] && enrollRows[0].parent_id;
  if (!parentId && shirtIds.length) {
    const { data: c0, error: pe } = await sb.from('campers').select('parent_id').eq('id', shirtIds[0]).maybeSingle();
    if (pe) throw pe;
    parentId = c0 && c0.parent_id;
  }

  let parentFirst = 'there';
  let parentFullName = '';
  if (parentId) {
    const { data: prof, error: perr } = await sb.from('profiles').select('full_name').eq('id', parentId).maybeSingle();
    if (perr) throw perr;
    parentFullName = (prof && prof.full_name && prof.full_name.trim()) || '';
    const fn = parentFullName.split(/\s+/)[0] || '';
    if (fn) parentFirst = fn;
  }
  if (parentFirst === 'there' && session.customer_details && session.customer_details.name) {
    const full = String(session.customer_details.name).trim();
    if (full && !parentFullName) parentFullName = full;
    const fn = full.split(/\s+/)[0];
    if (fn) parentFirst = fn;
  }

  const grandTotal = (session.amount_total != null ? Number(session.amount_total) : 0) / 100;

  return {
    parentFirst,
    parentFullName: parentFullName || parentFirst,
    tableRows,
    campSubtotal,
    regTotal,
    shirtTotal,
    grandTotal,
    hasEnrollments: enrollRows.length > 0,
    shirtOnly: !!(result && result.shirtOnly),
  };
}

const ADMIN_DASHBOARD_URL = 'https://ima-summer-camp.vercel.app/admin.html';

function buildAdminPaidNotificationText(summary, customerEmail, stripeSessionId) {
  const uniqueChildren = [...new Set(summary.tableRows.map((r) => r.childName))];
  const bookingLines = summary.tableRows.length
    ? summary.tableRows.map((r) => {
        if (r.kind === 'shirt') {
          return `• ${r.childName} — Extra T-shirt — ${formatMoney(r.amount)}`;
        }
        return `• ${r.childName} — ${r.weekCol} — ${r.schedule} — ${formatMoney(r.amount)}`;
      })
    : ['• (No line items parsed — check Stripe dashboard or admin enrollments.)'];

  const lines = [];
  lines.push('New booking received!');
  lines.push('');
  lines.push(`Parent: ${summary.parentFullName} <${customerEmail || 'n/a'}>`);
  lines.push(`Child: ${uniqueChildren.length ? uniqueChildren.join(', ') : '—'}`);
  lines.push('');
  lines.push('Weeks / days booked:');
  bookingLines.forEach(function (line) {
    lines.push(line);
  });
  lines.push('');
  lines.push(`Amount paid: ${formatMoney(summary.grandTotal)}`);
  lines.push(`Registration fee: ${summary.regTotal > 0 ? 'Yes' : 'No'}`);
  lines.push('');
  lines.push(`Stripe session: ${stripeSessionId || 'n/a'}`);
  lines.push(`View in admin: ${ADMIN_DASHBOARD_URL}`);
  return lines.join('\n');
}

function buildAdminPaidNotificationHtml(summary, customerEmail, stripeSessionId) {
  const uniqueChildren = [...new Set(summary.tableRows.map((r) => r.childName))];
  const rows = summary.tableRows
    .map((r) => {
      if (r.kind === 'shirt') {
        return `<li>${escapeHtml(r.childName)} — <strong>Extra T-shirt</strong> — ${escapeHtml(formatMoney(r.amount))}</li>`;
      }
      return `<li>${escapeHtml(r.childName)} — ${escapeHtml(r.weekCol)} — ${escapeHtml(r.schedule)} — ${escapeHtml(
        formatMoney(r.amount)
      )}</li>`;
    })
    .join('');
  const listBlock = summary.tableRows.length
    ? `<ul style="margin:8px 0;padding-left:20px">${rows}</ul>`
    : '<p style="color:#666">No line items parsed.</p>';

  return `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">
  <p><strong>New booking received!</strong></p>
  <p><strong>Parent:</strong> ${escapeHtml(summary.parentFullName)} &lt;${escapeHtml(customerEmail || 'n/a')}&gt;</p>
  <p><strong>Child:</strong> ${escapeHtml(uniqueChildren.length ? uniqueChildren.join(', ') : '—')}</p>
  <p><strong>Weeks / days booked:</strong></p>
  ${listBlock}
  <p><strong>Amount paid:</strong> ${escapeHtml(formatMoney(summary.grandTotal))}</p>
  <p><strong>Registration fee:</strong> ${summary.regTotal > 0 ? 'Yes' : 'No'}</p>
  <p><strong>Stripe session:</strong> ${escapeHtml(stripeSessionId || 'n/a')}</p>
  <p><a href="${escapeHtml(ADMIN_DASHBOARD_URL)}" style="color:#0d9488">View in admin</a></p>
</div>`;
}

function buildAdminPaidSubject(summary) {
  return `🥊 New IMA Camp Booking — ${formatMoney(summary.grandTotal)}`;
}

function buildPlainTextBody(summary, manageUrl) {
  const lines = [];
  lines.push(`Hi ${summary.parentFullName || summary.parentFirst},`);
  lines.push('');
  lines.push('Your booking is confirmed! Here\'s your summary:');
  lines.push('');
  lines.push('BOOKING SUMMARY');
  lines.push('Child | Week / days | Schedule | Amount paid');
  summary.tableRows.forEach((r) => {
    lines.push(`${r.childName} | ${r.weekCol} | ${r.schedule} | ${formatMoney(r.amount)}`);
  });
  if (!summary.tableRows.length) {
    lines.push('(No line items in summary — see your Stripe receipt for details.)');
  }
  lines.push('');
  lines.push('TOTALS');
  lines.push(`Camp total: ${formatMoney(summary.campSubtotal)}`);
  if (summary.shirtTotal > 0) {
    lines.push(`Extra T-shirts: ${formatMoney(summary.shirtTotal)}`);
  }
  if (summary.regTotal > 0) {
    lines.push(`Registration fee: ${formatMoney(summary.regTotal)}`);
  }
  lines.push(`TOTAL PAID: ${formatMoney(summary.grandTotal)}`);
  lines.push('');
  lines.push('CAMP DETAILS');
  lines.push('Location: Impact Martial Athletics, 4401 S Flamingo Rd, Davie FL 33330');
  lines.push('Time: Monday – Friday, check in at 9:00 AM');
  lines.push('What to bring: Water bottle, athletic clothes, closed-toe shoes');
  lines.push('Questions? Contact us at tom@imaimpact.com');
  lines.push('');
  lines.push(`Manage your bookings at: ${manageUrl}`);
  lines.push('');
  lines.push('— Impact Martial Athletics Team');
  return lines.join('\n');
}

function buildHtmlBody(summary, manageUrl) {
  const rowsHtml = summary.tableRows
    .map(
      (r) =>
        `<tr><td style="padding:10px 12px;border-bottom:1px solid #e5e5e5">${escapeHtml(r.childName)}</td>` +
        `<td style="padding:10px 12px;border-bottom:1px solid #e5e5e5">${escapeHtml(r.weekCol)}</td>` +
        `<td style="padding:10px 12px;border-bottom:1px solid #e5e5e5">${escapeHtml(r.schedule)}</td>` +
        `<td style="padding:10px 12px;border-bottom:1px solid #e5e5e5;text-align:right;white-space:nowrap">${escapeHtml(
          formatMoney(r.amount)
        )}</td></tr>`
    )
    .join('');

  const totals = [
    `<p style="margin:8px 0"><strong>Camp total:</strong> ${escapeHtml(formatMoney(summary.campSubtotal))}</p>`,
  ];
  if (summary.shirtTotal > 0) {
    totals.push(
      `<p style="margin:8px 0"><strong>Extra T-shirts:</strong> ${escapeHtml(formatMoney(summary.shirtTotal))}</p>`
    );
  }
  if (summary.regTotal > 0) {
    totals.push(
      `<p style="margin:8px 0"><strong>Registration fee:</strong> ${escapeHtml(formatMoney(summary.regTotal))}</p>`
    );
  }
  totals.push(
    `<p style="margin:16px 0 8px;font-size:18px"><strong>TOTAL PAID:</strong> ${escapeHtml(
      formatMoney(summary.grandTotal)
    )}</p>`
  );

  const tableBlock =
    summary.tableRows.length > 0
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;border-collapse:collapse;margin:16px 0;font-size:14px">
  <thead><tr style="background:#0f172a;color:#fff;text-align:left">
    <th style="padding:10px 12px">Child</th>
    <th style="padding:10px 12px">Week / days</th>
    <th style="padding:10px 12px">Schedule</th>
    <th style="padding:10px 12px;text-align:right">Amount paid</th>
  </tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>`
      : '<p style="color:#666">No camp weeks in this order — see your Stripe receipt for details.</p>';

  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#111">
  <p>Hi ${escapeHtml(summary.parentFullName || summary.parentFirst)},</p>
  <p>Your booking is confirmed! Here&rsquo;s your summary:</p>
  ${tableBlock}
  <div style="margin-top:20px;padding-top:16px;border-top:1px solid #ddd">
    <h2 style="font-size:16px;margin:0 0 12px">Totals</h2>
    ${totals.join('')}
  </div>
  <div style="margin-top:24px;padding-top:16px;border-top:1px solid #ddd">
    <h2 style="font-size:16px;margin:0 0 12px">Camp details</h2>
    <p style="margin:8px 0"><strong>Location:</strong> Impact Martial Athletics, 4401 S Flamingo Rd, Davie FL 33330</p>
    <p style="margin:8px 0"><strong>Time:</strong> Monday &ndash; Friday, check in at 9:00 AM</p>
    <p style="margin:8px 0"><strong>What to bring:</strong> Water bottle, athletic clothes, closed-toe shoes</p>
    <p style="margin:8px 0"><strong>Questions?</strong> Contact us at <a href="mailto:tom@imaimpact.com">tom@imaimpact.com</a></p>
  </div>
  <p style="margin-top:28px;font-size:14px;color:#444">Manage your bookings at:<br/>
  <a href="${escapeHtml(manageUrl)}" style="color:#0d9488">${escapeHtml(manageUrl)}</a></p>
  <p style="margin-top:24px;color:#555">&mdash; Impact Martial Athletics Team</p>
</div>`;
}

module.exports = {
  buildBookingEmailSummary,
  buildPlainTextBody,
  buildHtmlBody,
  buildAdminPaidNotificationText,
  buildAdminPaidNotificationHtml,
  buildAdminPaidSubject,
  formatMoney,
  escapeHtml,
};
