import { isPersistentKvConfigured, kvIncrWithPExpire } from "./storage";

const MAX_RATE_BUCKETS = 5000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function incrementLocalBucket(
  key: string,
  windowMs: number,
  remoteCount?: number,
  cost = 1
): number {
  const safeCost = Math.max(1, Math.floor(cost));
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
    const nextCount = remoteCount !== undefined ? remoteCount : safeCost;
    rateBuckets.set(key, { count: nextCount, resetAt: now + windowMs });
    return nextCount;
  }
  existing.count =
    remoteCount !== undefined
      ? remoteCount
      : existing.count + safeCost;
  return existing.count;
}

/**
 * Distributed rate limiter backed by atomic Redis `INCR` + `PEXPIRE` when Upstash/KV
 * is configured, with a bounded 5,000-entry sliding-window fallback.
 */
export async function checkRateLimitAsync(
  key: string,
  limitPerMin = 90,
  windowMs = 60_000,
  cost = 1
): Promise<boolean> {
  const safeCost = Math.max(1, Math.min(12, Math.floor(cost)));
  const safeKey = `heybroc:ratelimit:${key.trim().slice(0, 128)}`;
  if (isPersistentKvConfigured()) {
    try {
      const count = await kvIncrWithPExpire(safeKey, windowMs, safeCost);
      incrementLocalBucket(safeKey, windowMs, count, safeCost);
      return count <= limitPerMin;
    } catch {
      // Fall back to bounded local bucket if Redis experiences transient network error
    }
  }
  const localCount = incrementLocalBucket(safeKey, windowMs, undefined, safeCost);
  return localCount <= limitPerMin;
}

/**
 * Synchronous rate-limit check that enforces the bounded local window immediately and
 * synchronizes with atomic Redis `INCR` + `PEXPIRE` when Upstash/KV is configured.
 */
export function checkRateLimit(
  key: string,
  limitPerMin = 90,
  windowMs = 60_000,
  cost = 1
): boolean {
  const safeCost = Math.max(1, Math.min(12, Math.floor(cost)));
  const safeKey = `heybroc:ratelimit:${key.trim().slice(0, 128)}`;
  const localCount = incrementLocalBucket(safeKey, windowMs, undefined, safeCost);
  if (isPersistentKvConfigured()) {
    void kvIncrWithPExpire(safeKey, windowMs, safeCost)
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
