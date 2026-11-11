import fs from "node:fs";
import path from "node:path";

/**
 * Persistent Key-Value Storage Client (Upstash Redis / Vercel KV HTTP REST API).
 *
 * Uses `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or Vercel KV aliases
 * `KV_REST_API_URL` + `KV_REST_API_TOKEN`) over standard HTTPS fetch with zero
 * native dependencies.
 *
 * IMPORTANT: On Vercel (`process.env.VERCEL`), missing Upstash/KV credentials throw
 * immediately (`StorageConfigError`) rather than silently falling back to ephemeral
 * per-instance memory. Local development and offline test runs use `.cache/heybroc-kv.json`
 * + in-memory map when `process.env.VERCEL` is not set.
 */

export class StorageConfigError extends Error {
  constructor(message = "Persistent Upstash Redis / Vercel KV is not configured on Vercel.") {
    super(message);
    this.name = "StorageConfigError";
  }
}

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

export const CRITICAL_KV_KEY_PATTERN =
  /^(?:ent:|heybroc:entitlement:|consent:|heybroc:consent:|stripe:webhook:|heybroc:stripe:|rc:webhook:|heybroc:rc:|inf:|heybroc:inf|heybroc:creator:|heybroc:creators:|heybroc:influencers|heybroc:device:|heybroc:refcode:|heybroc:auth:|heybroc:charge:|heybroc:user:|heybroc:referral:)/i;

function ensureStorageReady(key?: string): RedisConfig | null {
  const cfg = getRedisConfig();
  if (!cfg) {
    const isVercel = Boolean(process.env.VERCEL);
    const isProd = process.env.NODE_ENV === "production";
    if (
      isVercel ||
      (isProd &&
        process.env.NEXT_PHASE !== "phase-production-build" &&
        (!key || CRITICAL_KV_KEY_PATTERN.test(key)))
    ) {
      throw new StorageConfigError(
        "Durable KV storage (UPSTASH_REDIS_REST_URL / KV_REST_API_URL) is required in production."
      );
    }
  }
  return cfg;
}

async function upstashCommand<T = unknown>(
  args: (string | number)[],
  keyHint?: string
): Promise<T | null> {
  const cfg = ensureStorageReady(keyHint);
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

// Local dev / test fallback store when Upstash Redis is not configured outside production
const MAX_MEMORY_FALLBACK_ENTRIES = 5000;
const memoryFallback = new Map<string, { raw: string; expiresAt?: number }>();

function setBoundedMemoryFallback(
  key: string,
  entry: { raw: string; expiresAt?: number }
): void {
  if (
    memoryFallback.size >= MAX_MEMORY_FALLBACK_ENTRIES &&
    !memoryFallback.has(key)
  ) {
    const now = Date.now();
    for (const [k, v] of memoryFallback) {
      if (v.expiresAt && v.expiresAt <= now) memoryFallback.delete(k);
      if (memoryFallback.size < MAX_MEMORY_FALLBACK_ENTRIES) break;
    }
    if (memoryFallback.size >= MAX_MEMORY_FALLBACK_ENTRIES) {
      const oldest = memoryFallback.keys().next().value;
      if (oldest !== undefined) memoryFallback.delete(oldest);
    }
  }
  memoryFallback.set(key, entry);
}

function getLocalDevStorePath(): string | null {
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    return null;
  }
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
  const cfg = ensureStorageReady(key);
  if (cfg) {
    const raw = await upstashCommand<string>(["GET", key], key);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new Error(
        `Corrupted JSON in KV for key "${key}": ${err instanceof Error ? err.message : String(err)}`
      );
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
  } catch (err) {
    throw new Error(
      `Corrupted JSON in local KV for key "${key}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function kvSet<T>(
  key: string,
  value: T,
  ttlSeconds?: number
): Promise<void> {
  const cfg = ensureStorageReady(key);
  const raw = JSON.stringify(value);
  if (cfg) {
    if (ttlSeconds && ttlSeconds > 0) {
      await upstashCommand(["SET", key, raw, "EX", Math.floor(ttlSeconds)], key);
    } else {
      await upstashCommand(["SET", key, raw], key);
    }
    return;
  }

  const expiresAt =
    ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : undefined;
  const entry = { raw, expiresAt };
  setBoundedMemoryFallback(key, entry);
  const localObj = readLocalDevStore();
  localObj[key] = entry;
  writeLocalDevStore(localObj);
}

export async function kvDel(key: string): Promise<void> {
  const cfg = ensureStorageReady(key);
  if (cfg) {
    await upstashCommand(["DEL", key], key);
    return;
  }
  memoryFallback.delete(key);
  const localObj = readLocalDevStore();
  if (key in localObj) {
    delete localObj[key];
    writeLocalDevStore(localObj);
  }
}

/**
 * Atomic Redis INCR + PEXPIRE rate-limit counter.
 */
export async function kvIncrWithPExpire(
  key: string,
  windowMs = 60_000
): Promise<number> {
  const cfg = getRedisConfig();
  if (cfg) {
    const lua = [
      'local c = redis.call("INCR", KEYS[1])',
      "if c == 1 then",
      '  redis.call("PEXPIRE", KEYS[1], tonumber(ARGV[1]))',
      "end",
      "return c",
    ].join("\n");
    const res = await upstashCommand<number>(
      ["EVAL", lua, 1, key, Math.max(1000, Math.floor(windowMs))],
      key
    );
    return Number(res ?? 1);
  }
  const now = Date.now();
  const existing = memoryFallback.get(key);
  if (!existing || (existing.expiresAt && existing.expiresAt <= now)) {
    setBoundedMemoryFallback(key, {
      raw: "1",
      expiresAt: now + Math.max(1000, Math.floor(windowMs)),
    });
    return 1;
  }
  const next = (Number(existing.raw) || 0) + 1;
  setBoundedMemoryFallback(key, {
    raw: String(next),
    expiresAt: existing.expiresAt,
  });
  return next;
}

/**
 * Atomic SET If Not Exists (SET key value NX EX ttlSeconds).
 */
export async function kvSetNx(
  key: string,
  value: string,
  ttlSeconds = 60 * 60 * 24 * 30
): Promise<boolean> {
  const cfg = ensureStorageReady(key);
  if (cfg) {
    const result = await upstashCommand<string>(
      [
        "SET",
        key,
        JSON.stringify(value),
        "NX",
        "EX",
        Math.floor(ttlSeconds),
      ],
      key
    );
    return result === "OK";
  }

  const now = Date.now();
  const localObj = readLocalDevStore();
  const entry = memoryFallback.get(key) ?? localObj[key];
  if (entry && (!entry.expiresAt || entry.expiresAt > now)) {
    return false;
  }
  const raw = JSON.stringify(value);
  const expiresAt =
    ttlSeconds && ttlSeconds > 0 ? now + ttlSeconds * 1000 : undefined;
  const newEntry = { raw, expiresAt };
  setBoundedMemoryFallback(key, newEntry);
  localObj[key] = newEntry;
  writeLocalDevStore(localObj);
  return true;
}

/**
 * Redis Set helpers (SADD / SREM / SMEMBERS) for atomic index tracking.
 */
export async function kvSAdd(key: string, member: string): Promise<void> {
  const cfg = ensureStorageReady();
  if (cfg) {
    await upstashCommand(["SADD", key, member]);
    return;
  }
  const current = (await kvGet<string[]>(key)) ?? [];
  if (!current.includes(member)) {
    current.push(member);
    await kvSet(key, current);
  }
}

export async function kvSRem(key: string, member: string): Promise<void> {
  const cfg = ensureStorageReady();
  if (cfg) {
    await upstashCommand(["SREM", key, member]);
    return;
  }
  const current = (await kvGet<string[]>(key)) ?? [];
  const filtered = current.filter((m) => m !== member);
  await kvSet(key, filtered);
}

export async function kvSMembers(key: string): Promise<string[]> {
  const cfg = ensureStorageReady();
  if (cfg) {
    const res = await upstashCommand<string[]>(["SMEMBERS", key]);
    return Array.isArray(res) ? res : [];
  }
  const current = await kvGet<string[]>(key);
  return Array.isArray(current) ? current : [];
}

/**
 * Redis Hash helpers (HSET / HGETALL / HINCRBY / HINCRBYFLOAT) for atomic per-record counters.
 */
export async function kvHSet(
  key: string,
  fields: Record<string, string | number>
): Promise<void> {
  const cfg = ensureStorageReady();
  const entries = Object.entries(fields);
  if (entries.length === 0) return;

  if (cfg) {
    const args: (string | number)[] = ["HSET", key];
    for (const [k, v] of entries) {
      args.push(k, String(v));
    }
    await upstashCommand(args);
    return;
  }

  const current = (await kvGet<Record<string, string>>(key)) ?? {};
  for (const [k, v] of entries) {
    current[k] = String(v);
  }
  await kvSet(key, current);
}

export async function kvHGetAll(
  key: string
): Promise<Record<string, string> | null> {
  const cfg = ensureStorageReady();
  if (cfg) {
    const raw = await upstashCommand<string[] | Record<string, string>>([
      "HGETALL",
      key,
    ]);
    if (!raw) return null;
    if (Array.isArray(raw)) {
      if (raw.length === 0) return null;
      const out: Record<string, string> = {};
      for (let i = 0; i < raw.length; i += 2) {
        out[String(raw[i])] = String(raw[i + 1] ?? "");
      }
      return out;
    }
    if (typeof raw === "object" && Object.keys(raw).length > 0) {
      return raw;
    }
    return null;
  }

  const current = await kvGet<Record<string, string>>(key);
  if (!current || Object.keys(current).length === 0) return null;
  return current;
}

export async function kvHIncrBy(
  key: string,
  field: string,
  increment: number
): Promise<number> {
  const cfg = ensureStorageReady();
  if (cfg) {
    const res = await upstashCommand<number | string>([
      "HINCRBY",
      key,
      field,
      Math.trunc(increment),
    ]);
    return Number(res ?? 0);
  }

  const current = (await kvGet<Record<string, string>>(key)) ?? {};
  const nextVal = Math.trunc(Number(current[field] ?? 0)) + Math.trunc(increment);
  current[field] = String(nextVal);
  await kvSet(key, current);
  return nextVal;
}

export async function kvHIncrByFloat(
  key: string,
  field: string,
  increment: number
): Promise<number> {
  const cfg = ensureStorageReady();
  if (cfg) {
    const res = await upstashCommand<number | string>([
      "HINCRBYFLOAT",
      key,
      field,
      increment,
    ]);
    return Math.round(Number(res ?? 0) * 100) / 100;
  }

  const current = (await kvGet<Record<string, string>>(key)) ?? {};
  const nextVal =
    Math.round((Number(current[field] ?? 0) + increment) * 100) / 100;
  current[field] = String(nextVal);
  await kvSet(key, current);
  return nextVal;
}

let localAtomicQueue: Promise<unknown> = Promise.resolve();

/**
 * Atomically claims `markerKey` (SET NX EX) and applies all hash field increments
 * on `hashKey` in a single Redis Lua script (or serialized local mutex in dev/test).
 * Returns `true` if applied for the first time, or `false` if `markerKey` already existed.
 */
export async function kvAtomicHashUpdateOnce(
  markerKey: string,
  hashKey: string,
  deltas: Array<{ field: string; delta: number; isFloat?: boolean }>,
  ttlSeconds = 60 * 60 * 24 * 365
): Promise<boolean> {
  const cfg = ensureStorageReady();
  if (cfg) {
    const lua = [
      'if redis.call("SET", KEYS[1], "1", "NX", "EX", tonumber(ARGV[1])) == false then return 0 end',
      "for i = 2, #ARGV, 3 do",
      "  local f = ARGV[i]",
      "  local d = ARGV[i + 1]",
      "  local k = ARGV[i + 2]",
      '  if k == "float" then',
      '    redis.call("HINCRBYFLOAT", KEYS[2], f, d)',
      "  else",
      '    redis.call("HINCRBY", KEYS[2], f, tonumber(d))',
      "  end",
      "end",
      "return 1",
    ].join("\n");

    const args: (string | number)[] = [
      "EVAL",
      lua,
      2,
      markerKey,
      hashKey,
      Math.floor(ttlSeconds),
    ];
    for (const item of deltas) {
      args.push(
        item.field,
        item.isFloat
          ? String(Math.round(item.delta * 100) / 100)
          : String(Math.trunc(item.delta)),
        item.isFloat ? "float" : "int"
      );
    }
    const res = await upstashCommand<number>(args);
    return Number(res) === 1;
  }

  const runLocal = async (): Promise<boolean> => {
    const existing = await kvGet<string>(markerKey);
    if (existing !== null) return false;
    for (const item of deltas) {
      if (item.isFloat) {
        await kvHIncrByFloat(hashKey, item.field, item.delta);
      } else {
        await kvHIncrBy(hashKey, item.field, item.delta);
      }
    }
    await kvSet(markerKey, "1", ttlSeconds);
    return true;
  };

  const next = localAtomicQueue.then(runLocal, runLocal);
  localAtomicQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/**
 * Evaluates a Redis Lua script (`EVAL script numkeys key... arg...`) when persistent KV
 * is configured, or runs `localFallback` sequentially inside the in-process atomic mutex
 * in local development / offline test runs.
 */
export async function kvEvalLua<T = unknown>(
  script: string,
  keys: string[],
  args: (string | number)[],
  localFallback?: () => Promise<T>
): Promise<T | null> {
  const cfg = ensureStorageReady(keys[0]);
  if (cfg) {
    return upstashCommand<T>(
      ["EVAL", script, keys.length, ...keys, ...args],
      keys[0]
    );
  }
  if (localFallback) {
    const next = localAtomicQueue.then(localFallback, localFallback);
    localAtomicQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
  return null;
}


