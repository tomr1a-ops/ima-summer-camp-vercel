/** Prevent browsers and shared caches from treating parent/registration JSON as fresh. */
function setNoStoreJsonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

module.exports = { setNoStoreJsonHeaders };
