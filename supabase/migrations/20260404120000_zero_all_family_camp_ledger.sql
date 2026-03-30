-- Reset all family camp account credits (cancelled-enrollment dollar balance).
-- The registration portal shows this via GET /api/preview-pricing → prepaidCampBalanceCents
-- (see api/lib/family-camp-ledger.js → public.family_camp_credit_ledger).
--
-- "Unused credit" week/day counts also include floating prepaid from **confirmed enrollments**
-- (enrollments.status = 'confirmed') when those weeks are not checked in the grid — that is not
-- stored in profiles or attendance; clear enrollments to remove that pool.
-- Draft picks live in browser localStorage (ima_reg_enroll_v1 / ima_portal_enroll_v1) only.

DELETE FROM public.family_camp_credit_ledger;
