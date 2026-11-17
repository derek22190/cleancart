import { isPersistentKvConfigured, kvEvalLua, kvIncrWithPExpire } from "./storage";

const MAX_RATE_BUCKETS = 5000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function incrementLocalBucket(
  key: string,
  windowMs: number,
  remoteCount?: number,
  cost = 1,
  remotePttlMs?: number
): { count: number; resetAt: number } {
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
    const ttlMs =
      remotePttlMs !== undefined && remotePttlMs > 0 ? remotePttlMs : windowMs;
    const bucket = { count: nextCount, resetAt: now + ttlMs };
    rateBuckets.set(key, bucket);
    return bucket;
  }
  existing.count =
    remoteCount !== undefined
      ? remoteCount
      : existing.count + safeCost;
  if (remotePttlMs !== undefined && remotePttlMs > 0) {
    existing.resetAt = now + remotePttlMs;
  }
  return existing;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterSec: number;
}

/**
 * Distributed rate limiter backed by atomic Redis `INCRBY` + `PEXPIRE` + `PTTL` when
 * Upstash/KV is configured, returning the exact remaining window `retryAfterSec`.
 */
export async function checkRateLimitDetailedAsync(
  key: string,
  limitPerMin = 90,
  windowMs = 60_000,
  cost = 1
): Promise<RateLimitCheckResult> {
  const safeCost = Math.max(1, Math.min(12, Math.floor(cost)));
  const safeWindowMs = Math.max(1000, Math.floor(windowMs));
  const defaultRetrySec = Math.max(1, Math.ceil(safeWindowMs / 1000));
  const safeKey = `heybroc:ratelimit:${key.trim().slice(0, 128)}`;
  if (isPersistentKvConfigured()) {
    try {
      const lua = [
        "local d = tonumber(ARGV[2])",
        "local w = tonumber(ARGV[1])",
        'local c = redis.call("INCRBY", KEYS[1], d)',
        'local ttl = redis.call("PTTL", KEYS[1])',
        "if c == d or ttl < 0 then",
        '  redis.call("PEXPIRE", KEYS[1], w)',
        "  ttl = w",
        "end",
        "return { c, ttl }",
      ].join("\n");
      const res = await kvEvalLua<[number, number]>(
        lua,
        [safeKey],
        [safeWindowMs, safeCost]
      );
      if (Array.isArray(res) && res.length >= 2) {
        const count = Number(res[0] ?? safeCost);
        const pttlMs = Number(res[1] ?? safeWindowMs);
        incrementLocalBucket(safeKey, safeWindowMs, count, safeCost, pttlMs);
        const retryAfterSec =
          pttlMs > 0 ? Math.max(1, Math.ceil(pttlMs / 1000)) : defaultRetrySec;
        return { allowed: count <= limitPerMin, retryAfterSec };
      }
    } catch {
      // Fall back to bounded local bucket if Redis experiences transient network error
    }
  }
  const bucket = incrementLocalBucket(safeKey, safeWindowMs, undefined, safeCost);
  const remainingMs = Math.max(1000, bucket.resetAt - Date.now());
  return {
    allowed: bucket.count <= limitPerMin,
    retryAfterSec: Math.max(1, Math.ceil(remainingMs / 1000)),
  };
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
  const res = await checkRateLimitDetailedAsync(key, limitPerMin, windowMs, cost);
  return res.allowed;
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
  const localBucket = incrementLocalBucket(safeKey, windowMs, undefined, safeCost);
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
  return localBucket.count <= limitPerMin;
}
