const buckets = new Map();

function checkAndConsume(userId, { limit, windowMs }) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const timestamps = (buckets.get(userId) || []).filter(t => t > cutoff);

  if (timestamps.length >= limit) {
    const retryAfterMs = timestamps[0] + windowMs - now;
    buckets.set(userId, timestamps);
    return { allowed: false, retryAfterMs };
  }

  timestamps.push(now);
  buckets.set(userId, timestamps);
  return { allowed: true };
}

module.exports = { checkAndConsume };
