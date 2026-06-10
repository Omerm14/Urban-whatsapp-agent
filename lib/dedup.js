// In-memory message-id deduplication with a short TTL.
//
// Meta retries webhook deliveries (and can deliver the same message more than
// once). The 10s batching queue absorbs rapid duplicates, but a retry arriving
// after the batch has flushed would otherwise be processed again. This guards
// against that. Single-instance only: entries are lost on redeploy, which is
// acceptable since Meta's retries happen within minutes.
const TTL_MS = 10 * 60 * 1000;
const seen = new Map(); // id -> expiry timestamp (ms)

function isDuplicate(id) {
  if (!id) return false;
  const now = Date.now();

  const expiry = seen.get(id);
  if (expiry && expiry > now) {
    return true;
  }

  seen.set(id, now + TTL_MS);

  // Opportunistic cleanup of expired entries.
  if (seen.size > 1000) {
    for (const [k, exp] of seen) {
      if (exp <= now) seen.delete(k);
    }
  }

  return false;
}

module.exports = { isDuplicate };
