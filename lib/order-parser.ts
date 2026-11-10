/**
 * Deterministic Weekly Grocery Order, Receipt & "Buy Again" List Parser
 * ---------------------------------------------------------------------
 * Parses pasted Walmart Curbside, Target Drive Up, Instacart, Amazon Fresh, Kroger,
 * ALDI, or Costco order confirmations, receipts, and shopping lists into clean
 * `{ productTitle, quantity }` items for `POST /api/audit`.
 */
import type { Store } from "./swaps";

export interface ParsedOrderItem {
  productTitle: string;
  quantity: number;
}

export interface ParsedGroceryOrder {
  items: ParsedOrderItem[];
  detectedStore?: Store;
}

const ORDER_NOISE_LINE =
  /^(?:.*\b(?:order\s*(?:#\s*\w+|number|summary|details|total|confirmed|confirmation|placed|status)|receipt\s*#?)\b.*|(?:walmart|target|instacart|kroger|aldi|costco|amazon(?:\s+fresh)?|whole\s+foods(?:\s+market)?|sam'?s\s+club|bj'?s)\s+(?:curbside|pickup|delivery|drive\s+up|express|grocery|store|receipt)\b.*|order\s*(?:#|number|summary|details|total|confirmed|placed|status).*|receipt.*|subtotal.*|estimated\s+tax.*|sales\s+tax.*|tax\b.*|total\b.*|bag\s+fee.*|delivery\s+fee.*|service\s+fee.*|driver\s+tip.*|tip\b.*|savings.*|you\s+saved.*|payment\s+method.*|visa\b.*|mastercard\b.*|amex\b.*|discover\b.*|ebt\b.*|pickup\s+(?:time|location|ready).*|curbside.*|drive\s+up.*|shopped\s+by.*|delivered\s+(?:by|on|at).*|substituted.*|out\s+of\s+stock.*|unavailable.*|refunded.*|weight[- ]adjusted.*|qty\s*:?\s*\d+\s*$|quantity\s*:?\s*\d+\s*$|items?\s*\(\d+\).*|buy\s+it\s+again|frequently\s+purchased|your\s+items|groceries|refrigerated|frozen|pantry|produce|bakery|dairy(?:\s*&\s*eggs)?|meat(?:\s*&\s*seafood)?|snacks|beverages|thank\s+you\s+for\s+shopping.*|view\s+order.*|track\s+order.*|https?:\/\/\S+)$/i;

const PRICE_ONLY_LINE =
  /^(?:[-+]?\$?\d+(?:\.\d{2})\s*(?:ea|each|\/ea|\/lb|lb|ct)?|\d+(?:\.\d+)?\s*(?:lb|lbs|oz|fl\s*oz|ct|pk|pack)\s*@\s*\$?\d+(?:\.\d{2}).*|\d{8,14})$/i;

function detectOrderStore(text: string): Store | undefined {
  const lower = text.toLowerCase();
  if (/\bwalmart\b|\bgreat\s+value\b|\bbettergoods\b/.test(lower)) return "walmart";
  if (/\btarget\b|\bgood\s*&\s*gather\b|\bdrive\s+up\b/.test(lower)) return "target";
  if (/\binstacart\b/.test(lower)) return "instacart";
  if (/\bcostco\b|\bkirkland\s+signature\b/.test(lower)) return "costco";
  if (/\bsam'?s\s+club\b|\bmember'?s\s+mark\b/.test(lower)) return "sams";
  if (/\baldi\b|\bsimply\s+nature\b|\bmillville\b/.test(lower)) return "aldi";
  if (/\bkroger\b|\bsimple\s+truth\b/.test(lower)) return "kroger";
  if (/\bwhole\s+foods\b|\b365\s+by\s+whole\s+foods\b|\bamazon\s+fresh\b/.test(lower)) return "amazon";
  if (/\bbj'?s\b|\bwellsley\s+farms\b/.test(lower)) return "bjs";
  return undefined;
}

export function parseGroceryOrderText(rawText: string, maxItems = 50): ParsedGroceryOrder {
  if (!rawText || !rawText.trim()) {
    return { items: [] };
  }

  const detectedStore = detectOrderStore(rawText);
  const rawLines = rawText
    .split(/\r?\n/)
    .map((l) => l.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const merged = new Map<string, ParsedOrderItem>();

  for (const rawLine of rawLines) {
    if (rawLine.length > 350) continue;

    // Strip bullet prefixes / checkboxes ("- ", "• ", "[x] ", "1. ")
    let line = rawLine
      .replace(/^(?:[-•*▪✓✔☐☑]|\[\s*[xX]?\s*\]|\d{1,2}[.)])\s+/, "")
      .trim();

    if (!line || line.length > 260 || ORDER_NOISE_LINE.test(line) || PRICE_ONLY_LINE.test(line)) {
      continue;
    }

    let quantity = 1;

    // Leading quantity: "2x Doritos Nacho Cheese", "3 x Chobani...", "Qty 2: ...", "Qty 2 Cheez-It..."
    const leadQty = line.match(
      /^(?:(?:qty|quantity)\s*:?\s*(\d{1,2})(?:\s*(?:x|×|:|-)\s+|\s+)(.+)|(\d{1,2})\s*(?:x|×|:|-)\s+(.+))$/i
    );
    if (leadQty) {
      const qNum = Number(leadQty[1] || leadQty[3]) || 1;
      quantity = Math.min(99, Math.max(1, qNum));
      line = (leadQty[2] || leadQty[4] || "").trim();
    }

    // Trailing quantity without backtracking: "... (x2)", "... Qty: 3", "... × 2"
    const trailMatch = line.match(
      /\s+(?:\(\s*(?:x|×|qty:?)\s*(\d{1,2})\s*\)|\bqty\s*:?\s*(\d{1,2})|(?:x|×)\s*(\d{1,2}))$/i
    );
    if (trailMatch && typeof trailMatch.index === "number" && trailMatch.index > 0) {
      const qVal = Number(trailMatch[1] || trailMatch[2] || trailMatch[3]);
      if (Number.isFinite(qVal) && qVal >= 1) {
        quantity = Math.min(99, qVal);
        line = line.slice(0, trailMatch.index).trim();
      }
    }

    // Strip trailing receipt prices / SKU codes if pasted from an email receipt
    line = line
      .replace(/\s+\$\d+(?:\.\d{2})(?:\s*\/?\s*(?:ea|each|lb|oz|ct))?(?:\s+total)?$/i, "")
      .replace(/\s+\b(?:upc|item|sku)\s*#?:?\s*\d{6,14}\b[\s\S]*$/i, "")
      .replace(/\s+[|·•]\s*\$\d+(?:\.\d{2})[\s\S]*$/i, "")
      .trim();

    if (
      line.length < 3 ||
      line.length > 140 ||
      !/[a-zA-Z]{3,}/.test(line) ||
      ORDER_NOISE_LINE.test(line) ||
      PRICE_ONLY_LINE.test(line)
    ) {
      continue;
    }

    const normKey = line.toLowerCase();
    const existing = merged.get(normKey);
    if (existing) {
      existing.quantity = Math.min(99, existing.quantity + quantity);
    } else {
      merged.set(normKey, { productTitle: line, quantity });
    }

    if (merged.size >= maxItems) break;
  }

  return {
    items: Array.from(merged.values()),
    ...(detectedStore ? { detectedStore } : {}),
  };
}

export const SAMPLE_WEEKLY_FAMILY_ORDER = `Walmart Curbside Pickup Order #482910
2x Doritos Nacho Cheese Tortilla Chips, 9.25 oz
Yoplait Original Strawberry Low Fat Yogurt, 6 oz
Cheez-It Original Baked Snack Crackers, 12.4 oz
Hidden Valley Original Ranch Salad Dressing, 16 fl oz
Oscar Mayer Deli Fresh Oven Roasted Turkey Breast, 9 oz
2x Capri Sun Strawberry Kiwi Juice Drink Pouches, 10 ct
Quaker Chewy Chocolate Chip Granola Bars, 8 ct
Jif Creamy Peanut Butter, 16 oz`;
