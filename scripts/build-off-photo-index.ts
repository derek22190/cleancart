#!/usr/bin/env tsx
/**
 * Step 4: Nightly US/Canada Open Food Facts Photo Index Builder (`scripts/build-off-photo-index.ts`)
 * --------------------------------------------------------------------------------------------------
 * Streams the Open Food Facts nightly JSONL export (`https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz`
 * or `--input=<local.jsonl[.gz]>`) using streaming gunzip + line reader, keeps products sold in
 * the US or Canada that have verified front/raw photos, and writes:
 *   1. Compact git-friendly shard `data/off-us-photo-index.json` (`[barcode, brand, title, relativeFile]`)
 *   2. Optional Upstash KV index (`heybroc:offidx:bc:<barcode>` and `heybroc:offidx:q:<slug>`) when `--sync-kv` is passed.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import zlib from "node:zlib";
import { normalizeBrandPhrase } from "../lib/brands";
import type { OffPhotoIndexTuple } from "../lib/off-photo-index";

const DEFAULT_OFF_EXPORT_URL =
  "https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz";
const USER_AGENT = "HeyBroc/2.5 (https://www.heybroc.com; support@heybroc.com)";

interface OffExportLine {
  code?: string;
  product_name?: string;
  product_name_en?: string;
  brands?: string;
  countries_tags?: string[];
  unique_scans_n?: number;
  selected_images?: {
    front?: {
      display?: Record<string, string>;
      small?: Record<string, string>;
    };
  };
  images?: Record<string, { rev?: string | number }>;
}

interface CandidateRow {
  barcode: string;
  brand: string;
  title: string;
  relFile: string;
  scans: number;
}

function isUsOrCanada(tags?: string[]): boolean {
  if (!Array.isArray(tags) || tags.length === 0) return false;
  for (const tag of tags) {
    if (tag === "en:united-states" || tag === "en:canada") return true;
  }
  return false;
}

function extractRelativeImageFile(prod: OffExportLine): string | null {
  const imgs = prod.images && typeof prod.images === "object" ? prod.images : null;
  if (imgs) {
    for (const key of ["front_en", "front_es", "front_fr", "front"]) {
      const rev = imgs[key]?.rev !== undefined ? String(imgs[key].rev) : "";
      if (rev && /^\d+$/.test(rev)) {
        return `${key}.${rev}.400.jpg`;
      }
    }
    const rawNumeric = Object.keys(imgs)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    if (rawNumeric.length > 0) {
      return `${rawNumeric[0]}.400.jpg`;
    }
  }

  const display = prod.selected_images?.front?.display || {};
  const small = prod.selected_images?.front?.small || {};
  for (const candidate of [
    display.en,
    display.es,
    display.fr,
    small.en,
    small.es,
    small.fr,
  ]) {
    if (typeof candidate === "string" && candidate.includes("/images/products/")) {
      const filePart = candidate.split("/").pop()?.trim() || "";
      if (filePart.endsWith(".jpg")) return filePart;
    }
  }
  return null;
}

async function syncRowsToUpstashKv(rows: CandidateRow[]): Promise<number> {
  const kvUrl = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(
    /\/+$/,
    ""
  );
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!kvUrl || !kvToken || rows.length === 0) return 0;

  let written = 0;
  const batchSize = 100;
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const pipeline: Array<[string, string, string, string, number]> = [];
    for (const row of slice) {
      const digits = row.barcode.replace(/\D/g, "");
      const padded = digits.length <= 8 ? digits : digits.padStart(13, "0");
      const folder =
        padded.length <= 8
          ? padded
          : `${padded.slice(0, 3)}/${padded.slice(3, 6)}/${padded.slice(6, 9)}/${padded.slice(9)}`;
      const fullUrl = `https://images.openfoodfacts.org/images/products/${folder}/${row.relFile}`;

      pipeline.push([
        "SET",
        `heybroc:offidx:bc:${digits}`,
        JSON.stringify({ u: fullUrl, b: row.brand, t: row.title }),
        "EX",
        60 * 60 * 24 * 14,
      ]);
      const combined =
        row.brand && !row.title.toLowerCase().includes(row.brand.toLowerCase())
          ? `${row.brand} ${row.title}`.trim()
          : row.title;
      const slug = normalizeBrandPhrase(combined).replace(/\s+/g, "-").slice(0, 96);
      if (slug.length >= 3) {
        pipeline.push([
          "SET",
          `heybroc:offidx:q:${slug}`,
          JSON.stringify({ u: fullUrl, bc: digits, b: row.brand, t: row.title }),
          "EX",
          60 * 60 * 24 * 14,
        ]);
      }
    }

    const res = await fetch(`${kvUrl}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${kvToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(pipeline),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      written += slice.length;
    }
  }
  return written;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputArg = args.find((a) => a.startsWith("--input="))?.slice("--input=".length) || "";
  const maxEntriesRaw =
    args.find((a) => a.startsWith("--max-entries="))?.slice("--max-entries=".length) || "50000";
  const maxEntries = Math.max(100, Number.parseInt(maxEntriesRaw, 10) || 50000);
  const syncKv = args.includes("--sync-kv");

  const outputPath = path.resolve(process.cwd(), "data/off-us-photo-index.json");
  const existingData: { version?: number; generatedAt?: string; entries?: OffPhotoIndexTuple[] } =
    fs.existsSync(outputPath)
      ? (JSON.parse(fs.readFileSync(outputPath, "utf8")) as {
          version?: number;
          generatedAt?: string;
          entries?: OffPhotoIndexTuple[];
        })
      : { version: 1, entries: [] };

  let lineSource: NodeJS.ReadableStream;
  if (inputArg) {
    const resolved = path.resolve(process.cwd(), inputArg);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Input file not found: ${resolved}`);
    }
    const fileStream = fs.createReadStream(resolved);
    lineSource = resolved.endsWith(".gz") ? fileStream.pipe(zlib.createGunzip()) : fileStream;
    console.log(`[off-index] Streaming local OFF export: ${resolved}`);
  } else {
    console.log(`[off-index] Streaming nightly OFF export: ${DEFAULT_OFF_EXPORT_URL}`);
    const response = await fetch(DEFAULT_OFF_EXPORT_URL, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to fetch OFF export: HTTP ${response.status}`);
    }
    const nodeReadable = Readable.fromWeb(response.body as unknown as WebReadableStream);
    lineSource = nodeReadable.pipe(zlib.createGunzip());
  }

  const rl = readline.createInterface({ input: lineSource, crlfDelay: Infinity });
  const candidatesByBarcode = new Map<string, CandidateRow>();

  // Preserve existing baseline tuples so curated seed barcodes never drop out
  for (const tuple of existingData.entries || []) {
    if (!Array.isArray(tuple) || tuple.length < 4) continue;
    const [bc, brand, title, file] = tuple;
    const digits = String(bc || "").replace(/\D/g, "");
    if (digits.length >= 8 && file) {
      candidatesByBarcode.set(digits, {
        barcode: digits,
        brand: String(brand || ""),
        title: String(title || ""),
        relFile: String(file),
        scans: 1_000_000, // Keep verified baseline entries pinned at top priority
      });
    }
  }

  let scannedLines = 0;
  for await (const line of rl) {
    scannedLines++;
    if (!line || line[0] !== "{") continue;
    let parsed: OffExportLine;
    try {
      parsed = JSON.parse(line) as OffExportLine;
    } catch {
      continue;
    }
    if (!isUsOrCanada(parsed.countries_tags)) continue;
    const code = String(parsed.code || "").replace(/\D/g, "");
    if (code.length < 8 || code.length > 14) continue;
    const title = String(parsed.product_name_en || parsed.product_name || "").trim();
    if (title.length < 2) continue;
    const relFile = extractRelativeImageFile(parsed);
    if (!relFile) continue;

    const brand = String(parsed.brands || "").split(",")[0]?.trim() || "";
    const scans = Math.max(0, Number(parsed.unique_scans_n) || 0);
    const existing = candidatesByBarcode.get(code);
    if (!existing || scans > existing.scans) {
      candidatesByBarcode.set(code, {
        barcode: code,
        brand,
        title,
        relFile,
        scans,
      });
    }
  }

  const ranked = Array.from(candidatesByBarcode.values()).sort((a, b) => {
    if (b.scans !== a.scans) return b.scans - a.scans;
    return a.barcode.localeCompare(b.barcode);
  });

  const topRows = ranked.slice(0, maxEntries);
  const tuples: OffPhotoIndexTuple[] = topRows.map((r) => [
    r.barcode,
    r.brand,
    r.title,
    r.relFile,
  ]);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString().slice(0, 10),
        entries: tuples,
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(
    `[off-index] Processed ${scannedLines} lines -> wrote ${tuples.length} US/CA photo entries to ${outputPath}`
  );

  if (syncKv) {
    const kvCount = await syncRowsToUpstashKv(ranked);
    console.log(`[off-index] Synced ${kvCount} US/CA photo entries to Upstash KV`);
  }
}

main().catch((err) => {
  console.error("[off-index] Fatal error:", err);
  process.exit(1);
});
