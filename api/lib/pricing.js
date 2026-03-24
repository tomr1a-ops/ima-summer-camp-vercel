const EARLY = new Date('2026-05-01T00:00:00.000Z');

function dayRate(testPricing) {
  if (testPricing) return 1;
  const now = new Date();
  if (now < EARLY) return 75;
  return 85;
}

function registrationFee(testPricing) {
  return testPricing ? 1 : 65;
}

module.exports = { dayRate, registrationFee, EARLY };
