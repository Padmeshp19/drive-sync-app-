// Centralized classification of "worth retrying" errors, shared by every
// withBackoff() in the app.
//
// Previously each withBackoff only retried on HTTP 429/503, so any
// transient network failure — a dropped connection, a DNS hiccup, no route
// to a particular Google/Microsoft IP, etc. — was treated as permanent on
// the very first attempt. That's why the sync log showed files being
// skipped outright with messages like "connect ETIMEDOUT ..." / "connect
// ENETUNREACH ..." instead of being retried the way a 429 already was.
const RETRYABLE_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ECONNABORTED',
]);

const RETRYABLE_MESSAGE = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up/i;

function isRetryableError(err) {
  if (!err) return false;

  const status = err.response?.status || err.status;
  if (status === 429 || status === 503) return true;

  if (RETRYABLE_CODES.has(err.code)) return true;

  // Node's happy-eyeballs dual-stack connect attempt failures surface as an
  // AggregateError whose top-level .code is undefined but whose nested
  // .errors[] each carry a real code — this is exactly the
  // "connect ETIMEDOUT 13.x.x.x:443; connect ENETUNREACH 2620:...:443 ..."
  // message shape seen in the sync log.
  if (Array.isArray(err.errors)) {
    return err.errors.some((e) => RETRYABLE_CODES.has(e?.code));
  }

  // Fallback for cases where the code got stringified into the message
  // instead of preserved on .code (seen with some axios/gaxios wrapping).
  return RETRYABLE_MESSAGE.test(err.message || '');
}

module.exports = { isRetryableError };
