/**
 * Shared Grocery & Beverage Brand Registry (`lib/brands.ts`)
 * ----------------------------------------------------------
 * Single source of truth for brand recognition, conflict detection,
 * single-letter compound tokenization, and upward sub-brand -> parent-umbrella
 * ownership resolution across `lib/lookup.ts` and `lib/drinks-catalog.ts`.
 */

/** Collapses single-letter compound brands so they survive tokenization (M&M's -> mandm, A.1. -> a1). */
export function collapseSingleLetterCompounds(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\bm\s*&\s*m'?s?\b/g, "mandm")
    .replace(/\ba\s*&\s*w\b/g, "aandw")
    .replace(/\bh(?:\.\s*|\s*-\s*)e(?:\.\s*|\s*-\s*)b\b\.?/g, "heb")
    .replace(/(?<!\bvitamin\s+)(?<!\bgrade\s+)\ba(?:\.\s*|\s*-\s*)1\.?(?!\s*%|\w)/g, "a1")
    .replace(/\bhi\s*-\s*c\b/g, "hic")
    .replace(/\bjell\s*-\s*o\b/g, "jello")
    .replace(/\bland\s+o'?\s*lakes\b/g, "land o lakes");
}

export function normalizeBrandPhrase(s: string): string {
  return collapseSingleLetterCompounds(s)
    .replace(/[ä]/g, "a")
    .replace(/[éè]/g, "e")
    .replace(/[í]/g, "i")
    .replace(/[ñ]/g, "n")
    .replace(/['’]s\b/g, "s")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function containsWholeBrandPhrase(haystackNorm: string, needleNorm: string): boolean {
  if (!haystackNorm || !needleNorm) return false;
  const escaped = needleNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(haystackNorm);
}

/**
 * Canonical multi-word and single-word grocery/beverage brand patterns.
 * Longer multi-word patterns appear first so `detectFirstBrand` prefers full brand names.
 */
export const SHARED_BRAND_PATTERNS: RegExp[] = [
  // Multi-word retailer & house brands
  /\bsimple\s+truth\s+organic\b/i,
  /\bsimple\s+truth\b/i,
  /\bprivate\s+selection\b/i,
  /\bheritage\s+farm\b/i,
  /\bbig\s+k\b/i,
  /\bgood\s*(?:&|and)\s*gather\b/i,
  /\bfavorite\s+day\b/i,
  /\bmarket\s+pantry\b/i,
  /\bup\s*&\s*up\b/i,
  /\bkirkland\s+signature\b/i,
  /\btrader\s+joe'?s?\b/i,
  /\bmember'?s\s+mark\b/i,
  /\bgreat\s+value\b/i,
  /\bsam'?s\s+choice\b/i,
  /\bfreshness\s+guaranteed\b/i,
  /\bmarketside\s+butcher\b/i,
  /\bmarketside\b/i,
  /\bwellsley\s+farms\b/i,
  /\bsimply\s+nature\b/i,
  /\bspecially\s+selected\b/i,
  /\bnature'?s\s+promise\b/i,
  /\bsignature\s+select\b/i,
  /\bo\s+organics\b/i,
  /\bopen\s+nature\b/i,
  /\b365(?!\s*(?:days?|ct|count|g|mg|oz|ml|cal|calories)\b)(?:\s+by\s+whole\s+foods(?:\s+market)?)?\b/i,
  /\bwhole\s+foods(?:\s+market)?\b/i,

  // Multi-word national food & beverage brands
  /\borganic\s+valley\b/i,
  /\bhorizon\s+organic\b/i,
  /\bstonyfield\s+organic\b/i,
  /\bmaple\s+hill\b/i,
  /\bshamrock\s+farms\b/i,
  /\bplanet\s+oat\b/i,
  /\bcalifia\s+farms\b/i,
  /\bthree\s+trees\b/i,
  /\balmond\s+breeze\b/i,
  /\bpacific\s+foods\b/i,
  /\bso\s+delicious\b/i,
  /\bcore\s+hydration\b/i,
  /\bpoland\s+spring\b/i,
  /\bdeer\s+park\b/i,
  /\bice\s+mountain\b/i,
  /\bcrystal\s+geyser\b/i,
  /\bmountain\s+valley\b/i,
  /\bacqua\s+panna\b/i,
  /\btopo\s+chico\b/i,
  /\bsan\s+pellegrino\b/i,
  /\bliquid\s+death\b/i,
  /\bsparkling\s+ice\b/i,
  /\bvitamin\s*water\b/i,
  /\bsmart\s*water\b/i,
  /\bpure\s+life\b/i,
  /\buncle\s+matt'?s?\b/i,
  /\bsimply\s+(?:orange|lemonade|limeade|apple|peach|watermelon|grapefruit|potatoes|nkd)\b/i,
  /\bminute\s+maid\b/i,
  /\bflorida'?s\s+natural\b/i,
  /\bpom\s+wonderful\b/i,
  /\bocean\s+spray\b/i,
  /\bhonest\s+kids\b/i,
  /\bcapri\s*sun\b/i,
  /\bhawaiian\s+punch\b/i,
  /\bbolthouse(?:\s+farms)?\b/i,
  /\bnaked\s+juice\b/i,
  /\bharmless\s+harvest\b/i,
  /\bvita\s+coco\b/i,
  /\bbody\s*armor\b/i,
  /\bliquid\s+i\.?v\.?\b/i,
  /\bla\s+colombe\b/i,
  /\bgold\s+peak\b/i,
  /\bpure\s+leaf\b/i,
  /\bjust\s+ice\s+tea\b/i,
  /\bito\s+en\b/i,
  /\bhealth[- ]?ade\b/i,
  /\bbrew\s+dr\b/i,
  /\bcoca[\s-]+cola\b/i,
  /\bdr\.?\s*pepper\b/i,
  /\b(?:mountain|mtn)\s+dew\b/i,
  /\bmug\s+root\s+beer\b/i,
  /\bcanada\s+dry\b/i,
  /\bred\s+bull\b/i,
  /\balani\s+nu\b/i,
  /\bpremier\s+protein\b/i,
  /\bmuscle\s+milk\b/i,
  /\bearth'?s\s+best\b/i,
  /\bhappy\s+baby\b/i,
  /\bplum\s+organics\b/i,
  /\bonce\s+upon\s+a\s+farm\b/i,
  /\bpanera\s+bread\b/i,
  /\bhidden\s+valley\b/i,
  /\bnature\s+valley\b/i,
  /\bnature'?s\s+own\b/i,
  /\bdave'?s\s+killer\b/i,
  /\boscar\s+mayer\b/i,
  /\bpepperidge\s+farm\b/i,
  /\bfrank'?s\s+redhot\b/i,
  /\bsweet\s+baby\s+ray'?s\b/i,
  /\bland\s+o'?\s*lakes\b/i,
  /\bcountry\s+crock\b/i,
  /\bblue\s+bonnet\b/i,
  /\bearth\s+balance\b/i,
  /\benjoy\s+life\b/i,
  /\bkite\s+hill\b/i,
  /\bbest\s+foods\b/i,
  /\bgrey\s+poupon\b/i,
  /\bbetty\s+crocker\b/i,
  /\bduncan\s+hines\b/i,
  /\bpearl\s+milling\b/i,
  /\baunt\s+jemima\b/i,
  /\blog\s+cabin\b/i,
  /\bmrs\.?\s*butterworth'?s?\b/i,
  /\bpeter\s+pan\b/i,
  /\bbonne\s+maman\b/i,
  /\bdel\s+monte\b/i,
  /\bgreen\s+giant\b/i,
  /\bbirds\s+eye\b/i,
  /\bred\s+baron\b/i,
  /\bhealthy\s+choice\b/i,
  /\blean\s+cuisine\b/i,
  /\bmarie\s+callender'?s?\b/i,
  /\bhebrew\s+national\b/i,
  /\bball\s+park\b/i,
  /\bjennie[- ]?o\b/i,
  /\bjimmy\s+dean\b/i,
  /\bhillshire(?:\s+farm)?\b/i,
  /\bboar'?s\s+head\b/i,
  /\bfoster\s+farms\b/i,
  /\bjust\s+bare\b/i,
  /\bcanyon\s+bakehouse\b/i,
  /\bking'?s\s+hawaiian\b/i,
  /\bsara\s+lee\b/i,
  /\bmiracle\s+whip\b/i,
  /\bwish[- ]?bone\b/i,
  /\bnewman'?s\s+own\b/i,
  /\blaughing\s+cow\b/i,
  /\bchips\s+ahoy\b/i,
  /\bnutter\s+butter\b/i,
  /\bfig\s+newtons?\b/i,
  /\bsour\s+patch\b/i,
  /\bswedish\s+fish\b/i,
  /\bcape\s+cod\b/i,
  /\bskinny\s*pop\b/i,
  /\blittle\s+debbie\b/i,
  /\bpop[- ]?tarts?\b/i,
  /\bcheez[- ]?its?\b/i,
  /\bfroot\s+loops\b/i,
  /\bfrosted\s+flakes\b/i,
  /\blucky\s+charms\b/i,
  /\bcinnamon\s+toast\s+crunch\b/i,
  /\brice\s+krispies\b/i,
  /\bhoney\s+bunches\b/i,
  /\bwheat\s+thins\b/i,
  /\bkettle\s*&\s*fire\b/i,
  /\blotus\s+foods\b/i,
  /\bprimal\s+kitchen\b/i,
  /\bchosen\s+foods\b/i,
  /\bboulder\s+canyon\b/i,
  /\btony'?s\s+chocolonely\b/i,
  /\bferrero(?:\s+rocher)?\b/i,
  /\bh[aä]agen[- ]?dazs\b/i,
  /\bben\s*&\s*jerry'?s?\b/i,
  /\bore[- ]?ida\b/i,
  /\bmuir\s+glen\b/i,
  /\btop\s+ramen\b/i,
  /\bcup\s+noodles?\b/i,
  /\bshin\s+ramyun\b/i,
  /\bgeneral\s+mills\b/i,
  /\bclif\s+bar\b/i,
  /\bhalo\s+top\b/i,
  /\bblue\s+bell\b/i,
  /\bkit\s*kat\b/i,
  /\bmy\s+cookie\s+dealer\b/i,
  /\bbeaver\s+brand\b/i,
  /\bwicked\s+cutz\b/i,
  /\bmt\.?\s*olive\b/i,
  /\bgrillo'?s\b/i,
  /\bfood\s+for\s+life\b/i,

  // Single-word & compound brands
  /\bhorizon\b(?!\s+(?:line|view)\b)/i,
  /\bfairlife\b/i,
  /\blactaid\b/i,
  /\btru\s*moo\b/i,
  /\bnesquik\b/i,
  /\bkirkland\b/i,
  /\baldi\b/i,
  /\bpublix\b/i,
  /\bh-?e-?b\b/i,
  /\bwegmans\b/i,
  /\bkroger\b/i,
  /\bmeijer\b/i,
  /\bbettergoods\b/i,
  /\bmillville\b/i,
  /\bclancy'?s\b/i,
  /\blucerne\b/i,
  /\bdarigold\b/i,
  /\bstonyfield\b/i,
  /\bstraus\b/i,
  /\boatly\b/i,
  /\bchobani\b/i,
  /\bcalifia\b/i,
  /\bmalk\b/i,
  /\belmhurst\b/i,
  /\bsilk\b(?!\s+corn\b)/i,
  /\bwest\s*soy\b/i,
  /\beden\s*soy\b/i,
  /(?<!\b(?:fudge|raspberry|strawberry|cherry|blueberry|blackberry|butterscotch|caramel|chocolate|peanut\s+butter)\s+)\bripple\b(?!\s+(?:ice\s+cream|potato\s+chips?|chips?)\b)/i,
  /\bnutpods\b/i,
  /\bevian\b/i,
  /\bfiji\b/i,
  /\bdasani\b/i,
  /\baquafina\b/i,
  /\bnestl[eé]\b/i,
  /\bniagara\b/i,
  /\bessentia\b/i,
  /\bozarka\b/i,
  /\bzephyrhills\b/i,
  /\bwaiakea\b/i,
  /\bperrier\b/i,
  /\bpellegrino\b/i,
  /\bsaratoga\b/i,
  /\bgerolsteiner\b/i,
  /\bspindrift\b/i,
  /\bwaterloo\b/i,
  /\bbubly\b/i,
  /\bla\s*croix\b/i,
  /\bpolar\b(?!\s+(?:bear|ice)\b)/i,
  /\bnixie\b/i,
  /\bpropel\b/i,
  /\btropicana\b/i,
  /\bnatalie'?s\b/i,
  /\bmartinelli'?s?\b/i,
  /\bmott'?s?\b/i,
  /\bwelch'?s?\b/i,
  /\bhi[- ]?c\b/i,
  /\bsunny\s*d\b/i,
  /\bkool[- ]?aid\b/i,
  /\bsuja\b/i,
  /\bgatorade\b/i,
  /\bpowerade\b/i,
  /\bpedialyte\b/i,
  /\belectrolit\b/i,
  /\bnuun\b/i,
  /\blmnt\b/i,
  /\bnooma\b/i,
  /\bdunkin'?\b/i,
  /\bstarbucks\b/i,
  /\bstok\b/i,
  /\barizona\b/i,
  /\bgt'?s\b/i,
  /\bkevita\b/i,
  /\bcoke\b/i,
  /\bpepsi\b/i,
  /\bsprite\b/i,
  /\b7\s*up\b/i,
  /\bstarry\b/i,
  /\bfanta\b/i,
  /\bsunkist\b/i,
  /\bcrush\b(?!\s+(?:red|peppers?|tomatoes?|pineapple|garlic|ice)\b)/i,
  /\bjarritos\b/i,
  /\ba\s*&\s*w\b/i,
  /\bbarq'?s\b/i,
  /\bschweppes\b/i,
  /\bzevia\b/i,
  /\bolipop\b/i,
  /\bpoppi\b/i,
  /(?<!\bcookie\s+)\bmonster\b(?!\s+(?:trail|cookies?|cookie|size|pack|bag|mix|mash|munch|cereal|popcorn|pretzels?|gummies|candy|bars?|snacks?)\b)/i,
  /\bcelsius\b/i,
  /\balani\b/i,
  /(?<!\b(?:marshmallow|peeps)\s+)\bghost\b(?!\s+(?:peppers?|chilis?|chiles?|marshmallows?|cand(?:y|ies)|cookies?|cupcakes?|gummies|shapes?)\b)/i,
  /\breign\b/i,
  /\bbang\b(?!\s+bang\b)/i,
  /\brockstar\b/i,
  /\bowyn\b/i,
  /\borgain\b/i,
  /\bgerber\b/i,
  /\bbeech[- ]?nut\b/i,
  /\bbutterball\b/i,
  /\bpanera\b/i,
  /\bvelveeta\b/i,
  /\bbreyers\b/i,
  /\bhershey'?s\b/i,
  /\bcampbell'?s\b/i,
  /\bswanson\b/i,
  /\bprogresso\b/i,
  /\bamy'?s\b/i,
  /\boreo\b/i,
  /\bjell-?o\b/i,
  /\brx\s*bars?\b/i,
  /\bl[aä]rabar\b/i,
  /\bplanters\b/i,
  /\bdole\b/i,
  /\blibby'?s\b/i,
  /\byoplait\b/i,
  /\bsiete\b/i,
  /\bstarkist\b/i,
  /\bdomino\b/i,
  /\bkaro\b/i,
  /\bheinz\b/i,
  /\bkraft\b/i,
  /\bnabisco\b/i,
  /\bmondelez\b/i,
  /\bjif\b/i,
  /\bskippy\b/i,
  /\bthomas'?\b/i,
  /\beggo\b/i,
  /\bquaker\b/i,
  /\bbarilla\b/i,
  /\bfage\b/i,
  /\boikos\b/i,
  /\bsiggi'?s\b/i,
  /\bdannon\b/i,
  /\bactivia\b/i,
  /\bdaisy\b(?!\s+chain\b)/i,
  /\bbreakstone'?s\b/i,
  /\bcabot\b/i,
  /\bviolife\b/i,
  /\bdaiya\b/i,
  /\bmiyoko'?s\b/i,
  /\btillamook\b/i,
  /\bsargento\b/i,
  /\bphiladelphia\b(?!\s+(?:rolls?|style|cheesesteaks?)\b)/i,
  /\blay'?s\b(?!\s+(?:flat|eggs?)\b)/i,
  /\bruffles\b/i,
  /\bpringles\b/i,
  /\bdoritos\b/i,
  /\bcheetos\b/i,
  /\btostitos\b/i,
  /\bfritos\b/i,
  /\butz\b/i,
  /\bherr'?s\b/i,
  /\bgoldfish\b/i,
  /\britz\b/i,
  /\btriscuit\b/i,
  /\bnutella\b/i,
  /\bsmucker'?s\b/i,
  /\bprego\b/i,
  /\bragu\b/i,
  /\bclassico\b/i,
  /\bbertolli\b/i,
  /\brao'?s\b/i,
  /\bhunt'?s\b/i,
  /\bbush'?s\b/i,
  /\bgoya\b/i,
  /\bmccain\b/i,
  /\balexia\b/i,
  /\bpace\b/i,
  /\bherdez\b/i,
  /\bmateo'?s\b/i,
  /\bsabra\b/i,
  /\btotino'?s\b/i,
  /\bdigiorno\b/i,
  /\btombstone\b/i,
  /\bstouffer'?s\b/i,
  /\bbanquet\b/i,
  /\bkellogg'?s\b/i,
  /\bcheerios\b/i,
  /\btyson\b/i,
  /\bperdue\b/i,
  /\bapplegate\b/i,
  /\bhormel\b/i,
  /\bsmithfield\b/i,
  /\bwright\b(?=\s+brand|\s+bacon)/i,
  /\bfarmland\b/i,
  /\bnathan'?s\b/i,
  /\bjohnsonville\b/i,
  /\beckrich\b/i,
  /\bbabybel\b/i,
  /\bkerrygold\b/i,
  /\bhellmann'?s\b/i,
  /\bduke'?s\b/i,
  /\bfrench'?s\b/i,
  /\bkikkoman\b/i,
  /\btabasco\b/i,
  /\bcholula\b/i,
  /\btapatio\b/i,
  /\bvalentina\b/i,
  /\bvlasic\b/i,
  /\bclaussen\b/i,
  /\binglehoffer\b/i,
  /\bwasabi[- ]?o\b/i,
  /\bpillsbury\b/i,
  /\bkodiak\b/i,
  /\bkrusteaz\b/i,
  /\bbisquick\b/i,
  /\btalenti\b/i,
  /\bedy'?s\b/i,
  /\bdreyer'?s\b/i,
  /\bklondike\b/i,
  /\byasso\b/i,
  /\boutshine\b/i,
  /\bquest\b(?!\s+for\b)/i,
  /\bharibo\b/i,
  /\bskittles\b/i,
  /\bstarburst\b/i,
  /\bsnickers\b/i,
  /\btwix\b/i,
  /\breese'?s\b/i,
  /\blindt\b/i,
  /\blindor\b/i,
  /\bghirardelli\b/i,
  /\bgoodles\b/i,
  /\bannie'?s\b/i,
  /\bmaruchan\b/i,
  /\bnissin\b/i,
  /\bnongshim\b/i,
  /\bbuldak\b/i,
  /\bsamyang\b/i,
  /\bindomie\b/i,
  /\bmission\b(?!\s+figs?\b)/i,
  /\bmartin'?s\b/i,
  /\bezekiel\b/i,
  /\barnold\b/i,
  /\borowheat\b/i,
  /\budi'?s\b/i,
  /\bwonder\s+bread\b/i,
  /\bbelvita\b/i,
  /\bsmartfood\b/i,
  /\bkeebler\b/i,
  /\bken'?s\b/i,
  /\bbriannas\b/i,
  /\bmarzetti\b/i,
  /\bstubb'?s\b/i,
  /(?<!\bvitamin\s+)(?<!\bgrade\s+)\ba(?:\.\s*|-?)1\.?(?!\s*(?:%|milk|protein|casein|beta|dairy|cows?)\b|\w)/i,
  /\bm\s*&\s*m'?s?\b/i,
  /\bben\s*(?:&|and)\s*jerry'?s?\b/i,
  /\bpost\b(?=\s+(?:oreo|honey|grape|fruity|cocoa|raisin|consumer|foods|cereal|bran|shredded|pebbles)\b)/i,
];

/**
 * Bidirectional brand synonyms (exact same consumer brand) and upward sub-brand -> parent
 * retailer/manufacturer credits. Strictly upward for umbrella parents so sibling brands
 * (e.g. Velveeta vs Kraft, Ritz vs Oreo) NEVER satisfy each other.
 */
const CANDIDATE_BRAND_CREDITS: Array<[RegExp, string[]]> = [
  // Exact brand synonyms (bidirectional)
  [/\b(?:coke|coca[\s-]*cola)\b/i, ["coke", "coca cola", "cocacola"]],
  [/\b(?:hellmann'?s|best\s+foods)\b/i, ["hellmanns", "best foods"]],
  [/\b(?:edy'?s|dreyer'?s)\b/i, ["edys", "dreyers"]],
  [/\b(?:carl'?s|arnold|orowheat)\b/i, ["arnold", "orowheat"]],

  // Retailer house brands -> parent store name
  [/\b(?:big\s+k|simple\s+truth|private\s+selection|heritage\s+farm)\b/i, ["kroger"]],
  [/\b(?:great\s+value|marketside|freshness\s+guaranteed|sam'?s\s+choice|bettergoods)\b/i, ["walmart"]],
  [/\b(?:good\s*(?:&|and)\s*gather|favorite\s+day|market\s+pantry|up\s*&\s*up)\b/i, ["target"]],
  [/\bkirkland(?:\s+signature)?\b/i, ["costco", "kirkland", "kirkland signature"]],
  [/\bmember'?s\s+mark\b/i, ["sams club"]],
  [/\bwellsley\s+farms\b/i, ["bjs"]],
  [/\b365\b/i, ["whole foods", "whole foods market", "365"]],
  [/\b(?:simply\s+nature|millville|clancy'?s|specially\s+selected)\b/i, ["aldi"]],
  [/\b(?:signature\s+select|o\s+organics|open\s+nature|lucerne)\b/i, ["safeway", "albertsons"]],

  // National sub-brands -> parent CPG manufacturer (strictly upward)
  [/\b(?:oreo|ritz|triscuit|chips\s+ahoy|wheat\s+thins|belvita|nutter\s+butter|fig\s+newtons?)\b/i, ["nabisco", "mondelez"]],
  [/\b(?:eggo|pop[- ]?tarts?|cheez[- ]?its?|frosted\s+flakes|froot\s+loops|rice\s+krispies|pringles)\b/i, ["kelloggs", "kellanova"]],
  [/\b(?:cheerios|lucky\s+charms|cinnamon\s+toast\s+crunch|nature\s+valley|annie'?s|l[aä]rabar|pillsbury|betty\s+crocker|bisquick|totino'?s|progresso|muir\s+glen|h[aä]agen[- ]?dazs|yoplait)\b/i, ["general mills"]],
  [/\b(?:lay'?s|doritos|cheetos|fritos|ruffles|tostitos|smartfood|quaker|gatorade|tropicana)\b/i, ["frito lay", "pepsico"]],
  [/\b(?:velveeta|philadelphia|jell-?o|oscar\s+mayer|capri\s+sun|maxwell\s+house|kool[- ]?aid|lunchables|stove\s+top|miracle\s+whip|claussen|jet[- ]?puffed|grey\s+poupon)\b/i, ["kraft", "kraft heinz"]],
  [/\b(?:reese'?s|kit\s*kat|jolly\s+rancher|twizzlers|ice\s+breakers|skinny\s*pop|pirate'?s\s+booty)\b/i, ["hershey", "hersheys"]],
  [/\b(?:nutella|kinder|tic\s+tac|ferrero\s+rocher)\b/i, ["ferrero"]],
  [/\b(?:honey\s+bunches|grape[- ]?nuts|fruity\s+pebbles|cocoa\s+pebbles|raisin\s+bran)\b/i, ["post", "post foods", "post consumer"]],
  [/\b(?:m\s*&\s*m'?s?|snickers|twix|milky\s+way|skittles|starburst|ben'?s\s+original)\b/i, ["mars", "mars wrigley"]],
  [/\b(?:outshine|digiorno|stouffer'?s|lean\s+cuisine|hot\s+pockets?|coffee[- ]?mate|nesquik|gerber)\b/i, ["nestle"]],
  [/\b(?:hellmann'?s|best\s+foods|breyers|talenti|klondike|ben\s*(?:&|and)\s*jerry'?s?|knorr|lipton)\b/i, ["unilever"]],
  [/\b(?:pepperidge\s+farm|goldfish|swanson|prego|pace|\bv8\b|snyder'?s|cape\s+cod|kettle\s+brand|late\s+july|pacific\s+foods)\b/i, ["campbell", "campbells"]],
  [/\b(?:dannon|activia|oikos|silk|so\s+delicious|horizon|international\s+delight|stok|evian)\b/i, ["danone"]],
  [/\b(?:skippy|applegate|planters|justin'?s)\b/i, ["hormel"]],
  [/\b(?:orville\s+redenbacher|hunt'?s|swiss\s+miss|marie\s+callender'?s?|banquet|healthy\s+choice|birds\s+eye|duncan\s+hines|vlasic|wish[- ]?bone|ro[- ]?tel)\b/i, ["conagra"]],
  [/\b(?:ezekiel)\b/i, ["food for life"]],
  [/\brx\s*bars?\b/i, ["rx", "rxbar"]],
];

/** Builds the normalized brand haystack for a candidate, augmented with parent/synonym credits. */
export function buildCandidateBrandHaystack(candidateText: string): string {
  const extras: string[] = [];
  for (const [re, credits] of CANDIDATE_BRAND_CREDITS) {
    if (re.test(candidateText)) {
      extras.push(...credits);
    }
  }
  return normalizeBrandPhrase(`${candidateText} ${extras.join(" ")}`);
}

/** Detects the first canonical brand mentioned in `query`. */
export function detectFirstBrand(query: string): string {
  for (const re of SHARED_BRAND_PATTERNS) {
    const m = re.exec(query);
    if (m && m[0].trim()) return m[0].trim();
  }
  return "";
}

/** Detects every canonical brand mentioned in `query` (including co-brands like "Breyers Oreo"). */
export function detectAllBrands(query: string): string[] {
  const out: string[] = [];
  for (const re of SHARED_BRAND_PATTERNS) {
    const localRe = new RegExp(re.source, re.flags.replace("g", ""));
    const m = localRe.exec(query);
    if (m && m[0].trim()) {
      out.push(m[0].trim());
    }
  }
  return Array.from(new Set(out));
}

/**
 * Returns `true` if `query` names any brand that is NOT explained by `candidateText`
 * (including upward parent/retailer brand credits and exact synonyms).
 */
export function hasConflictingBrand(query: string, candidateText: string): boolean {
  const queryBrands = detectAllBrands(query);
  if (queryBrands.length === 0) return false;
  const candHaystack = buildCandidateBrandHaystack(candidateText);
  for (const qb of queryBrands) {
    const nb = normalizeBrandPhrase(qb);
    if (!nb) continue;
    const alts =
      nb === "coke" || nb === "coca cola" || nb === "cocacola"
        ? ["coke", "coca cola", "cocacola"]
        : nb === "rxbar" || nb === "rx bar" || nb === "rxbars"
          ? ["rx", "rxbar", "rx bar"]
          : [nb];
    if (!alts.some((alt) => containsWholeBrandPhrase(candHaystack, alt))) {
      return true;
    }
  }
  return false;
}
