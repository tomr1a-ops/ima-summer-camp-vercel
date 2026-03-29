const EARLY = new Date('2026-05-01T00:00:00.000Z');

function dayRate(testPricing) {
  if (testPricing) return 1;
  const now = new Date();
  if (now < EARLY) return 85;
  return 95;
}

function weekRate(testPricing) {
  if (testPricing) return 1;
  const now = new Date();
  if (now < EARLY) return 375;
  return 425;
}

function registrationFee(testPricing) {
  return testPricing ? 1 : 65;
}

/** Additional camp T-shirt (optional add-on at checkout). Override with EXTRA_CAMP_SHIRT_USD. */
function extraCampShirt(testPricing) {
  if (testPricing) return 1;
  const env = process.env.EXTRA_CAMP_SHIRT_USD;
  if (env != null && String(env).trim() !== '' && !Number.isNaN(Number(env))) return Number(env);
  return 20;
}

module.exports = { dayRate, weekRate, registrationFee, extraCampShirt, EARLY };
