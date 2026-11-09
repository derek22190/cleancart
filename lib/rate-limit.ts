import { isPersistentKvConfigured, kvIncrWithPExpire } from "./storage";

const MAX_RATE_BUCKETS = 5000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function incrementLocalBucket(
  key: string,
  windowMs: number,
  remoteCount?: number
): number {
  const now = Date.now();
  const existing = rateBuckets.get(key);
  if (!existing || now > existing.resetAt) {
    if (rateBuckets.size >= MAX_RATE_BUCKETS && !rateBuckets.has(key)) {
      for (const [k, v] of rateBuckets) {
        if (now > v.resetAt) rateBuckets.delete(k);
        if (rateBuckets.size <= MAX_RATE_BUCKETS - 1000) break;
      }
      if (rateBuckets.size >= MAX_RATE_BUCKETS) {
        const oldest = rateBuckets.keys().next().value;
        if (oldest !== undefined) rateBuckets.delete(oldest);
      }
    }
    const nextCount = remoteCount !== undefined ? Math.max(1, remoteCount) : 1;
    rateBuckets.set(key, { count: nextCount, resetAt: now + windowMs });
    return nextCount;
  }
  existing.count =
    remoteCount !== undefined
      ? Math.max(existing.count + 1, remoteCount)
      : existing.count + 1;
  return existing.count;
}

/**
 * Distributed rate limiter backed by atomic Redis `INCR` + `PEXPIRE` when Upstash/KV
 * is configured, with a bounded 5,000-entry sliding-window fallback.
 */
export async function checkRateLimitAsync(
  key: string,
  limitPerMin = 90,
  windowMs = 60_000
): Promise<boolean> {
  const safeKey = `heybroc:ratelimit:${key.trim().slice(0, 128)}`;
  if (isPersistentKvConfigured()) {
    try {
      const count = await kvIncrWithPExpire(safeKey, windowMs);
      incrementLocalBucket(safeKey, windowMs, count);
      return count <= limitPerMin;
    } catch {
      // Fall back to bounded local bucket if Redis experiences transient network error
    }
  }
  const localCount = incrementLocalBucket(safeKey, windowMs);
  return localCount <= limitPerMin;
}

/**
 * Synchronous rate-limit check that enforces the bounded local window immediately and
 * synchronizes with atomic Redis `INCR` + `PEXPIRE` when Upstash/KV is configured.
 */
export function checkRateLimit(
  key: string,
  limitPerMin = 90,
  windowMs = 60_000
): boolean {
  const safeKey = `heybroc:ratelimit:${key.trim().slice(0, 128)}`;
  const localCount = incrementLocalBucket(safeKey, windowMs);
  if (isPersistentKvConfigured()) {
    void kvIncrWithPExpire(safeKey, windowMs)
      .then((remoteCount) => {
        const bucket = rateBuckets.get(safeKey);
        if (bucket && remoteCount > bucket.count) {
          bucket.count = remoteCount;
        }
      })
      .catch(() => {});
  }
  return localCount <= limitPerMin;
}
