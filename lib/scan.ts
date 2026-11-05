/**
 * Shared scan pipeline used by /api/scan and /api/audit.
 */
import "server-only";
import { lookupIngredients, type LookupResult } from "./lookup";
import { scoreIngredients, type ScoreResult, type Watchlist } from "./rubric";
import { resolveSwap, STORES, STORE_META, type Store, type SwapResult } from "./swaps";

export interface ScanRequest {
  productTitle?: string;
  rawIngredients?: string;
  barcode?: string;
  store?: string;
  watchlist?: Watchlist;
  format?: "json" | "ios_text";
}

export interface ScanResponse {
  ok: true;
  product: {
    title: string;
    brand?: string;
    barcode?: string;
    imageUrl?: string;
    ingredients: string;
  };
  lookup: { source: LookupResult["source"]; origin?: LookupResult["origin"]; ms: number };
  result: ScoreResult;
  swap: SwapResult | null;
  store: Store;
  pill: string;
}

export interface ScanError {
  ok: false;
  error: string;
  status: number;
}

export function parseStore(s?: string): Store {
  return (STORES as string[]).includes(s || "") ? (s as Store) : "walmart";
}

export async function runScan(req: ScanRequest): Promise<ScanResponse | ScanError> {
  if (!req.productTitle?.trim() && !req.rawIngredients?.trim() && !req.barcode?.trim()) {
    return { ok: false, status: 400, error: "Provide productTitle, barcode, or rawIngredients." };
  }
  const store = parseStore(req.store);
  const found = await lookupIngredients({
    productTitle: req.productTitle,
    barcode: req.barcode,
    rawIngredients: req.rawIngredients,
  });
  if (!found) {
    return {
      ok: false,
      status: 404,
      error: `No ingredient list found for "${req.productTitle || req.barcode}" on Open Food Facts or USDA. Try adding the brand name.`,
    };
  }
  const result = scoreIngredients(found.ingredients, req.watchlist);
  const title = [found.brand, found.productTitle].filter(Boolean).join(" ").trim() || found.productTitle;
  const swap = resolveSwap({
    score: result.score,
    productTitle: `${req.productTitle || ""} ${title}`,
    ingredients: found.ingredients,
    store,
  });
  return {
    ok: true,
    product: {
      title,
      brand: found.brand,
      barcode: found.barcode,
      imageUrl: found.imageUrl,
      ingredients: found.ingredients,
    },
    lookup: { source: found.source, origin: found.origin, ms: found.ms },
    result,
    swap,
    store,
    pill: `${result.score}/100 • Tap to Inspect`,
  };
}

/** Concise plain-text payload for iOS Shortcuts "Show Result" / notifications. */
export function toIosText(scan: ScanResponse): string {
  const r = scan.result;
  const dot = r.color === "green" ? "🟢" : r.color === "yellow" ? "🟡" : "🔴";
  const lines = [`${dot} ${r.score}/100 ${r.rating} — ${scan.product.title}`];
  if (r.flagged.length) {
    lines.push("", "⚠️ Flagged:");
    for (const f of r.flagged.slice(0, 6)) lines.push(`• ${f.name} (-${f.penalty}): ${f.explanation}`);
    if (r.flagged.length > 6) lines.push(`• +${r.flagged.length - 6} more`);
  } else {
    lines.push("", "✅ No watchlist additives found.");
  }
  if (scan.swap) {
    lines.push("", `🔁 Clean Swap at ${STORE_META[scan.store].label}: ${scan.swap.title} (${scan.swap.score}/100)`, scan.swap.webUrl);
  }
  return lines.join("\n");
}
