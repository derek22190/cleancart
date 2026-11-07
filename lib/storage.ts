import fs from "node:fs";
import path from "node:path";

/**
 * Persistent Key-Value Storage Client (Upstash Redis / Vercel KV HTTP REST API).
 *
 * Uses `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or Vercel KV aliases
 * `KV_REST_API_URL` + `KV_REST_API_TOKEN`) over standard HTTPS fetch with zero
 * native dependencies. Falls back to a local `.cache/kv-store.json` file + in-memory
 * map during local development and offline test runs when Redis env vars are unset.
 */

interface RedisConfig {
  url: string;
  token: string;
}

function getRedisConfig(): RedisConfig | null {
  const url = (
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL ||
    ""
  )
    .trim()
    .replace(/\/+$/, "");
  const token = (
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    ""
  ).trim();
  if (!url || !token) return null;
  return { url, token };
}

export function isPersistentKvConfigured(): boolean {
  return getRedisConfig() !== null;
}

async function upstashCommand<T = unknown>(
  args: (string | number)[]
): Promise<T | null> {
  const cfg = getRedisConfig();
  if (!cfg) return null;

  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
    cache: "no-store",
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Upstash Redis error (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as { result?: T; error?: string };
  if (data.error) {
    throw new Error(`Upstash Redis command error: ${data.error}`);
  }
  return data.result ?? null;
}

// Local development / test fallback store (never uses /tmp on Vercel)
const memoryFallback = new Map<string, { raw: string; expiresAt?: number }>();

function getLocalDevStorePath(): string | null {
  if (process.env.VERCEL) return null;
  return path.join(process.cwd(), ".cache", "heybroc-kv.json");
}

function readLocalDevStore(): Record<string, { raw: string; expiresAt?: number }> {
  const filePath = getLocalDevStorePath();
  if (!filePath) return {};
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {
    /* ignore local dev read errors */
  }
  return {};
}

function writeLocalDevStore(
  data: Record<string, { raw: string; expiresAt?: number }>
): void {
  const filePath = getLocalDevStorePath();
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch {
    /* ignore local dev write errors */
  }
}

export async function kvGet<T>(key: string): Promise<T | null> {
  if (getRedisConfig()) {
    const raw = await upstashCommand<string>(["GET", key]);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  const now = Date.now();
  const localObj = readLocalDevStore();
  const entry = memoryFallback.get(key) ?? localObj[key];
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt <= now) {
    memoryFallback.delete(key);
    delete localObj[key];
    writeLocalDevStore(localObj);
    return null;
  }
  try {
    return JSON.parse(entry.raw) as T;
  } catch {
    return null;
  }
}

export async function kvSet<T>(
  key: string,
  value: T,
  ttlSeconds?: number
): Promise<void> {
  const raw = JSON.stringify(value);
  if (getRedisConfig()) {
    if (ttlSeconds && ttlSeconds > 0) {
      await upstashCommand(["SET", key, raw, "EX", Math.floor(ttlSeconds)]);
    } else {
      await upstashCommand(["SET", key, raw]);
    }
    return;
  }

  const expiresAt =
    ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : undefined;
  const entry = { raw, expiresAt };
  memoryFallback.set(key, entry);
  const localObj = readLocalDevStore();
  localObj[key] = entry;
  writeLocalDevStore(localObj);
}

/**
 * Atomic SET If Not Exists (SET key value NX EX ttlSeconds).
 * Used for Stripe webhook event idempotency so replayed events never double-count commissions.
 */
export async function kvSetNx(
  key: string,
  value: string,
  ttlSeconds = 60 * 60 * 24 * 30
): Promise<boolean> {
  if (getRedisConfig()) {
    const result = await upstashCommand<string>([
      "SET",
      key,
      value,
      "NX",
      "EX",
      Math.floor(ttlSeconds),
    ]);
    return result === "OK";
  }

  const existing = await kvGet<string>(key);
  if (existing !== null) return false;
  await kvSet(key, value, ttlSeconds);
  return true;
}
