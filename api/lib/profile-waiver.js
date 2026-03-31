/**
 * Set profiles.waiver_signed after any successful camp checkout (card, $0, Step Up hold).
 * Preserves first waiver_signed_at if already set.
 */
async function markProfileWaiverSigned(sb, parentId) {
  if (!parentId || !sb) return { ok: false, reason: 'missing' };
  const pid = String(parentId).trim();
  if (!pid) return { ok: false, reason: 'missing' };

  const { data: row, error: re } = await sb
    .from('profiles')
    .select('waiver_signed, waiver_signed_at')
    .eq('id', pid)
    .maybeSingle();
  if (re) throw re;
  const nowIso = new Date().toISOString();
  const patch = {
    waiver_signed: true,
    waiver_signed_at: row && row.waiver_signed_at ? row.waiver_signed_at : nowIso,
  };
  const { error: ue } = await sb.from('profiles').update(patch).eq('id', pid);
  if (ue) throw ue;
  return { ok: true };
}

module.exports = { markProfileWaiverSigned };
