/**
 * Deterministic Ingredient-Label & Grocery Screenshot OCR Parser
 * --------------------------------------------------------------
 * Cleans real-world OCR artifacts from package photos and mobile grocery-app screenshots,
 * extracting the focal product title, Ingredients panel, barcode, and store without
 * requiring external LLM API keys or risking hallucinated ingredients.
 */
import type { Store } from "./swaps";

export interface ParsedLabelOcr {
  productTitle: string;
  rawIngredients: string;
  barcode?: string;
  detectedStore?: Store;
  cleanedText: string;
}

const OCR_SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/-\s*\r?\n\s*/g, ""], // rejoin line-wrapped hyphenated words (e.g. "hydro-\ngenated" -> "hydrogenated")
  [/\bsoybe[ao0]n\s+oil\b/gi, "Soybean Oil"],
  [/\bcan[o0]la\s+oil\b/gi, "Canola Oil"],
  [/\bsunfl[o0]wer\s+oil\b/gi, "Sunflower Oil"],
  [/\bcott[o0]nseed\s+oil\b/gi, "Cottonseed Oil"],
  [/\bhigh\s+fruct[o0]se\s+c[o0]rn\s+syrup\b/gi, "High Fructose Corn Syrup"],
  [/\bfruclose\b/gi, "Fructose"],
  [/\bmalt[o0]dex[tl]rin\b/gi, "Maltodextrin"],
  [/\bcarrageen[ao]n\b/gi, "Carrageenan"],
  [/\bred\s*#?\s*4[oO]\b/gi, "Red 40"],
  [/\byellow\s*#?\s*[sS5]\b/gi, "Yellow 5"],
  [/\byellow\s*#?\s*[bG6]\b/gi, "Yellow 6"],
  [/\bblue\s*#?\s*[lI1]\b/gi, "Blue 1"],
  [/\bsucral[o0]se\b/gi, "Sucralose"],
  [/\baspar[tl]ame\b/gi, "Aspartame"],
  [/\bacesulfame\s+p[o0]tassium\b/gi, "Acesulfame Potassium"],
  [/\bs[o0]dium\s+nitri[tl]e\b/gi, "Sodium Nitrite"],
  [/\bs[o0]dium\s+benz[o0]ate\b/gi, "Sodium Benzoate"],
  [/\bp[o0]tassium\s+s[o0]rbate\b/gi, "Potassium Sorbate"],
  [/\btitanium\s+di[o0]xide\b/gi, "Titanium Dioxide"],
  [/\bmon[o0]s[o0]dium\s+glutamate\b/gi, "Monosodium Glutamate"],
];

const UI_NOISE_LINE =
  /^(?:[\d:\s]*(?:am|pm)?\s*(?:5g|lte|wi-?fi|\d{1,3}%).*|\d{1,2}:\d{2}(?:\s*(?:am|pm))?|(?:5g|lte|wi-?fi)(?:\s+\d{1,3}%)?|\d{1,3}%|(?:https?:\/\/)?(?:www\.)?[\w-]+\.(?:com|org|net|us|co)(?:\/\S*)?|(?:walmart|target|instacart|kroger|aldi|costco|amazon(?:\s+fresh)?|whole\s+foods(?:\s+market)?|sam'?s\s+club|bj'?s(?:\s+wholesale)?|doordash|uber\s*eats|shipt)|[<‹«←×✕\s]*(?:back|close|cancel|done|share)\b.*|search\b.*|home|cart|account|reorder|my items|lists?|add to (?:cart|bag|basket|list|order).*|buy now.*|clip coupon.*|sponsored|best seller|overall pick|popular pick|rollback|snap ebt.*|out of stock|in stock.*|\$?\d+(?:\.\d{2})?(?:\s*\/?\s*(?:ea|oz|fl oz|lb|ct|pkg))?.*|\d+(?:\.\d+)?\s*¢\s*\/.*|(?:upc|ean|gtin|barcode|item\s*#?|sku)\s*[:#]?\s*\d{6,14}.*|nutrition\s+facts.*|serving\s+size.*|servings?\s+per\s+container.*|amount\s+per\s+serving.*|calories\s*\d*.*|%\s*daily\s+value.*|total\s+fat.*|saturated\s+fat.*|trans\s+fat.*|cholesterol.*|sodium\s+\d+.*|total\s+carbohydrate.*|dietary\s+fiber.*|total\s+sugars.*|includes\s+\d+g\s+added\s+sugars.*|protein\s+\d+.*|vitamin\s+[a-d].*|calcium\s+\d+.*|iron\s+\d+.*|potassium\s+\d+.*|product\s+details|specifications|about\s+this\s+item|description|highlights|reviews|ratings.*|customers\s+also.*|similar\s+items.*)$/i;

function detectStoreHint(text: string): Store | undefined {
  const lower = text.toLowerCase();
  if (/\bwalmart\b|\bgreat\s+value\b|\bbettergoods\b/.test(lower)) return "walmart";
  if (/\btarget\b|\bgood\s*&\s*gather\b|\bfavorite\s+day\b/.test(lower)) return "target";
  if (/\bcostco\b|\bkirkland\s+signature\b/.test(lower)) return "costco";
  if (/\bsam'?s\s+club\b|\bmember'?s\s+mark\b/.test(lower)) return "sams";
  if (/\baldi\b|\bsimply\s+nature\b|\bmillville\b|\bclancy'?s\b/.test(lower)) return "aldi";
  if (/\bkroger\b|\bsimple\s+truth\b|\bprivate\s+selection\b/.test(lower)) return "kroger";
  if (/\binstacart\b/.test(lower)) return "instacart";
  if (/\bwhole\s+foods\b|\b365\s+by\s+whole\s+foods\b|\bamazon\s+fresh\b/.test(lower)) return "amazon";
  if (/\bbj'?s\b|\bwellsley\s+farms\b|\bberkley\s+jensen\b/.test(lower)) return "bjs";
  return undefined;
}

export function cleanLabelOcrArtifacts(raw: string): string {
  if (!raw) return "";
  let text = raw.replace(/\u00a0/g, " ");
  for (const [re, replacement] of OCR_SUBSTITUTIONS) {
    text = text.replace(re, replacement);
  }
  return text
    .replace(/[|•·▪►]+/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function parseLabelOcrText(rawText: string): ParsedLabelOcr {
  const cleanedText = cleanLabelOcrArtifacts(rawText);
  if (!cleanedText) {
    return { productTitle: "", rawIngredients: "", cleanedText: "" };
  }

  const detectedStore = detectStoreHint(cleanedText);

  // Detect standalone 12-digit UPC or 13-digit EAN if visible in OCR text
  const barcodeMatch = cleanedText.match(/(?:^|[\s:#])(\d{12,13})(?:\s|$)/);
  const barcode = barcodeMatch?.[1];

  // Extract Ingredients block ("INGREDIENTS: ..." up to Allergen/UPC/Distributed/Nutrition boundary)
  let rawIngredients = "";
  const ingHeaderMatch = cleanedText.match(
    /\bingredients?\s*[:.;-]?\s*([\s\S]{10,2500})/i
  );
  if (ingHeaderMatch?.[1]) {
    const candidate = ingHeaderMatch[1]
      .split(
        /(?:\r?\n|\.\s+)(?:contains\s*:?\s*(?:milk|wheat|soy|egg|peanut|tree\s+nut|fish|shellfish|sesame)|allergen\s+information|may\s+contain|(?:upc|ean|gtin|barcode|item\s*#?|sku)\s*[:#]?\s*\d{6,14}|manufactured\s+(?:in|for|by)|distributed\s+by|produced\s+for|packed\s+(?:by|for)|marketed\s+by|nutrition\s+facts|questions\s+or\s+comments|keep\s+refrigerated|best\s+if\s+used\s+by|store\s+in\s+a\s+cool)/i
      )[0]
      .replace(/\s+/g, " ")
      .trim();
    if (candidate.length >= 10) {
      rawIngredients = candidate;
    }
  } else {
    // Handle cropped photo of JUST an ingredient panel (comma-separated list of >= 3 food terms without the word "Ingredients:")
    const flattened = cleanedText.replace(/\s+/g, " ").trim();
    const commaCount = (flattened.match(/,/g) || []).length;
    if (
      commaCount >= 2 &&
      flattened.length >= 18 &&
      /\b(water|flour|sugar|oil|milk|salt|corn|oat|syrup|starch|acid|flavor|cocoa|cream|cheese|wheat|soy|rice|butter|peanuts?|almonds?)\b/i.test(
        flattened
      )
    ) {
      rawIngredients = flattened;
    }
  }

  // Extract best Product Title from non-noise lines preceding Ingredients/Nutrition Facts
  const lines = cleanedText
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  let productTitle = "";
  for (const line of lines) {
    if (/^ingredients?\b/i.test(line)) break;
    if (line.length < 4 || line.length > 120) continue;
    if (UI_NOISE_LINE.test(line)) continue;
    // Skip lines that look like pure comma-separated ingredient continuations
    if ((line.match(/,/g) || []).length >= 3) continue;
    if (/[a-zA-Z]{3,}/.test(line)) {
      productTitle = line;
      break;
    }
  }

  return {
    productTitle,
    rawIngredients,
    ...(barcode ? { barcode } : {}),
    ...(detectedStore ? { detectedStore } : {}),
    cleanedText,
  };
}
