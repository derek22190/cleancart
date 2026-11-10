import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { hasProductIdentityMatch } from "@/lib/drinks-catalog";
import { checkRateLimit } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const imageUrlCache = new Map<string, string>();
const imageBytesCache = new Map<string, { bytes: ArrayBuffer; contentType: string; sourceUrl: string }>();

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_HOST_SUFFIXES = [".openfoodfacts.org", ".openfoodfacts.net"];

function isAllowedImageUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === "openfoodfacts.org" ||
      host === "openfoodfacts.net" ||
      ALLOWED_IMAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
    );
  } catch {
    return false;
  }
}

function localFallbackAssetForQuery(q: string): { relPath: string; contentType: string } {
  const s = q.toLowerCase();
  if (/\b(peanut\s+butter|almond\s+butter|cashew\s+butter|sunflower\s+butter|sunflower\s+seed\s+butter|nut\s+butter|hazelnut\s+spread|nutiva|nutella|sunbutter|maranatha|santa\s+cruz.*peanut|jif|skippy|justin'?s)\b/.test(s)) {
    return { relPath: "public/swaps/peanutbutter.png", contentType: "image/png" };
  }
  if (/\b(fruit\s+bars?|that'?s\s+it|larabar|lärabar|rxbar|clif\s+bar|kind\s+bar)\b/.test(s)) {
    return { relPath: "public/swaps/fruitbar.png", contentType: "image/png" };
  }
  if (/\b(yogurt|yoghurt|skyr|chobani|fage|stonyfield|siggi'?s|oikos|yoplait|dannon)\b/.test(s)) {
    return { relPath: "public/swaps/yogurt.jpg", contentType: "image/jpeg" };
  }
  if (/\b(ice\s+cream|gelato|sorbet|ben\s*&\s*jerry|häagen|haagen|alden'?s|alec'?s|favorite\s+day.*ice\s+cream|breyers|talenti)\b/.test(s)) {
    return { relPath: "public/swaps/icecream.png", contentType: "image/png" };
  }
  if (/\b(cottage\s+cheese|cream\s+cheese|sour\s+cream|good\s+culture)\b/.test(s)) {
    return { relPath: "public/swaps/cheese.png", contentType: "image/png" };
  }
  if (/\b(milk|lactaid|fairlife|oatly|malk|califia|silk|chobani\s+oat|ripple|darigold|core\s+power|premier\s+protein|muscle\s+milk|orgain|protein\s+shake|kefir|creamer|half\s+and\s+half|heavy\s+cream|nesquik|horizon\s+organic)\b/.test(s)) {
    return { relPath: "public/swaps/milk.png", contentType: "image/png" };
  }
  if (/\b(monster|red\s*bull|celsius|alani|ghost|c4|bang|reign|rockstar|prime|5[- ]?hour|zoa|nos|yerba\s+mate|guayaki|guayakí|pre[- ]?workout|preworkout|gorilla\s+mode|ryse|bucked\s+up|total\s+war|ora\s+organic|soda|cola|coke|coca[- ]?cola|pepsi|sprite|dr\.?\s*pepper|mountain\s+dew|mtn\s+dew|baja\s+blast|fanta|root\s+beer|a\s*&\s*w|barq|mug|ginger\s+ale|canada\s+dry|schweppes|7\s*up|crush|sunkist|starry|squirt|fresca|jarritos|olipop|poppi|zevia|culture\s+pop|water|fiji|evian|smartwater|dasani|aquafina|essentia|liquid\s+death|san\s+pellegrino|perrier|topo\s+chico|saratoga|spindrift|la\s*croix|waterloo|bubly|polar|nixie|hint|sparkling\s+ice|bai|juice|tropicana|simply|minute\s+maid|uncle\s+matt|mott|martinelli|welch|ocean\s+spray|pom\s+wonderful|lakewood|knudsen|capri\s*sun|kool[- ]?aid|hi[- ]?c|sunny\s*d|hawaiian\s+punch|tampico|naked\s+juice|bolthouse|suja|harmless\s+harvest|vita\s+coco|v8|lemonade|limeade|gatorade|powerade|bodyarmor|liquid\s+i\.?v\.?|lmnt|pedialyte|electrolit|biolyte|nuun|nooma|propel|vitaminwater|electrolyte|sports?\s+drink|energy\s+drink|coffee|frappuccino|cold\s+brew|stok|dunkin|la\s+colombe|tea|arizona|arnold\s+palmer|pure\s+leaf|gold\s+peak|snapple|brisk|ito\s+en|kombucha|gt'?s|health[- ]?ade)\b/.test(s)) {
    return { relPath: "public/swaps/drink.png", contentType: "image/png" };
  }
  if (/\b(syrup|maple|honey)\b/.test(s)) return { relPath: "public/swaps/syrup.png", contentType: "image/png" };
  if (/\b(eggs?|vital\s+farms)\b/.test(s)) return { relPath: "public/swaps/eggs.png", contentType: "image/png" };
  if (/\b(mac\s*(&|and)\s*cheese|macaroni)\b/.test(s)) return { relPath: "public/swaps/mac.png", contentType: "image/png" };
  if (/\b(pasta|spaghetti|penne|rigatoni|rotini|fettuccine|linguine|noodles?|ramen|jovial)\b/.test(s)) return { relPath: "public/swaps/pasta.png", contentType: "image/png" };
  if (/\b(chips|doritos|cheetos|takis|lays|lay'?s|ruffles|pringles|popcorn|pretzels|space\s+balls|puffs|siete.*chips|boulder\s+canyon)\b/.test(s)) return { relPath: "public/swaps/chips.jpg", contentType: "image/jpeg" };
  if (/\b(crackers|cheez[- ]?it|goldfish|ritz|triscuit|wheat\s+thins|mary'?s\s+gone)\b/.test(s)) return { relPath: "public/swaps/crackers.jpg", contentType: "image/jpeg" };
  if (/\b(cheese|cheddar|mozzarella|parmesan|provolone|gouda|swiss|velveeta|kraft\s+singles)\b/.test(s)) return { relPath: "public/swaps/cheese.png", contentType: "image/png" };
  if (/\b(butter|ghee|margarine|kerrygold|organic\s+valley.*butter)\b/.test(s)) return { relPath: "public/swaps/butter.jpg", contentType: "image/jpeg" };
  if (/\b(oats|oatmeal)\b/.test(s)) return { relPath: "public/swaps/oats.png", contentType: "image/png" };
  if (/\b(cereal|froot\s+loops|lucky\s+charms|cinnamon\s+toast|cheerios|granola|three\s+wishes|nature'?s\s+path)\b/.test(s)) return { relPath: "public/swaps/cereal.jpg", contentType: "image/jpeg" };
  if (/\b(cookie|cookies|oreo|wafer|simple\s+mills.*cookie|my\s+cookie\s+dealer|toaster\s+pastr(?:y|ies))\b/.test(s)) return { relPath: "public/swaps/cookies.png", contentType: "image/png" };
  if (/\b(chocolate|cacao|hershey|reese|snickers|twix|m&m|kit\s*kat|brownie|\bhu\b)\b/.test(s)) return { relPath: "public/swaps/chocolate.png", contentType: "image/png" };
  if (/\b(jam|jelly|preserves|marmalade|bonne\s+maman|smucker)\b/.test(s)) return { relPath: "public/swaps/jam.png", contentType: "image/png" };
  if (/\b(tortillas?|wraps?|siete.*tortilla)\b/.test(s)) return { relPath: "public/swaps/tortillas.png", contentType: "image/png" };
  if (/\b(waffles?|pancakes?|eggo|birch\s+benders)\b/.test(s)) return { relPath: "public/swaps/waffles.png", contentType: "image/png" };
  if (/\b(bagels?)\b/.test(s)) return { relPath: "public/swaps/bagels.png", contentType: "image/png" };
  if (/\b(buns?|rolls?)\b/.test(s)) return { relPath: "public/swaps/buns.png", contentType: "image/png" };
  if (/\b(bread|dave'?s\s+killer|ezekiel|muffin|pastry|donut|bismarks?)\b/.test(s)) return { relPath: "public/swaps/bread.jpg", contentType: "image/jpeg" };
  if (/\b(soup|chowder|amy'?s.*soup|campbell'?s|progresso)\b/.test(s)) return { relPath: "public/swaps/soup.png", contentType: "image/png" };
  if (/\b(broth|stock|bone\s+broth|kettle\s*&\s*fire)\b/.test(s)) return { relPath: "public/swaps/broth.png", contentType: "image/png" };
  if (/\b(salsa|picante|mateo'?s|tostitos\s+salsa)\b/.test(s)) return { relPath: "public/swaps/salsa.png", contentType: "image/png" };
  if (/\b(mayo|mayonnaise|hellmann|duke'?s)\b/.test(s)) return { relPath: "public/swaps/mayo.png", contentType: "image/png" };
  if (/\b(ketchup|heinz)\b/.test(s)) return { relPath: "public/swaps/ketchup.png", contentType: "image/png" };
  if (/\b(mustard|french'?s|grey\s+poupon)\b/.test(s)) return { relPath: "public/swaps/mustard.png", contentType: "image/png" };
  if (/\b(bbq|barbecue|sweet\s+baby\s+ray)\b/.test(s)) return { relPath: "public/swaps/bbq.png", contentType: "image/png" };
  if (/\b(marinara|pasta\s+sauce|tomato\s+sauce|rao'?s|prego|ragu)\b/.test(s)) return { relPath: "public/swaps/marinara.png", contentType: "image/png" };
  if (/\b(ranch|dressing|vinaigrette|wasabi|horseradish|sauce|guacamole|hummus|dip)\b/.test(s)) return { relPath: "public/swaps/ranch.jpg", contentType: "image/jpeg" };
  if (/\b(bacon)\b/.test(s)) return { relPath: "public/swaps/bacon.png", contentType: "image/png" };
  if (/\b(hot\s*dogs?|franks?|wiener)\b/.test(s)) return { relPath: "public/swaps/hotdog.png", contentType: "image/png" };
  if (/\b(sausages?|bratwurst|kielbasa)\b/.test(s)) return { relPath: "public/swaps/sausage.png", contentType: "image/png" };
  if (/\b(nuggets?|tenders?|strips?)\b/.test(s)) return { relPath: "public/swaps/nuggets.png", contentType: "image/png" };
  if (/\b(pizza|totino|digiorno|amy'?s.*pizza)\b/.test(s)) return { relPath: "public/swaps/pizza.png", contentType: "image/png" };
  if (/\b(turkey|chicken|beef|angus|pork|salami|ham|deli|meat|jerky|patties|burger|steak)\b/.test(s)) return { relPath: "public/swaps/turkey.jpg", contentType: "image/jpeg" };
  if (/\b(fresh\s+whole|fresh\s+produce|sweet\s+potato|russet\s+potato|yukon\s+gold|idaho\s+potato|red\s+potato|yellow\s+potato|potatoes?|yams?|bananas?|apples?|oranges?|lemons?|limes?|avocados?|tomatoes?|onions?|garlic|carrots?|celery|broccoli|cauliflower|spinach|lettuce|romaine|kale|cabbage|cucumbers?|peppers?|mushrooms?|zucchini|squash|strawberries|blueberries|raspberries|blackberries|grapes?|watermelon|pineapple|mangoes?|peaches?|pears?|produce|vegetables?|fruit)\b/.test(s)) {
    return { relPath: "public/swaps/produce.png", contentType: "image/png" };
  }
  return { relPath: "public/swaps/snacks.jpg", contentType: "image/jpeg" };
}

/**
 * Curated Open Food Facts front-of-pack product photos (CC BY-SA 3.0) for popular
 * catalog items, Explore items, Presets, and Clean Swaps so they resolve in 0ms
 * without failing on verbose catalog descriptors. Every barcode verified HTTP 200.
 */
const VERIFIED_PRODUCT_IMAGES: Array<[RegExp, string]> = [
  [/\bhidden\s+valley\b.*\branch\b/i, "https://images.openfoodfacts.org/images/products/007/110/000/3116/front_en.7.400.jpg"],
  [/\bprimal\s+kitchen\b.*\branch\b/i, "https://images.openfoodfacts.org/images/products/086/369/900/0146/front_en.4.400.jpg"],
  [/\bprimal\s+kitchen\b.*\b(?:mayo|mayonnaise)\b/i, "https://images.openfoodfacts.org/images/products/066/369/002/4048/front_en.3.400.jpg"],
  [/\bprimal\s+kitchen\b.*\bketchup\b/i, "https://images.openfoodfacts.org/images/products/827/574/200/7125/front_en.8.400.jpg"],
  [/\bmarketside\b(?!.*\b(?:romaine|dip|artichoke)\b).*\bbaby\s+spinach\b/i, "https://images.openfoodfacts.org/images/products/068/113/132/8982/front_en.3.400.jpg"],
  [/\bcinnamon\s+toast\s+crunch\b/i, "https://images.openfoodfacts.org/images/products/10167730/front_en.3.400.jpg"],
  [/\bkellogg'?s\b.*\bfrosted\s+flakes\b/i, "https://images.openfoodfacts.org/images/products/003/800/012/7502/front_en.3.400.jpg"],
  [/\bnature'?s\s+path\b.*\bheritage\s+flakes\b/i, "https://images.openfoodfacts.org/images/products/991/360/277/0206/front_en.4.400.jpg"],
  [/\bcampbell'?s\b.*\bmanhattan\b.*\bclam\s+chowder\b/i, "https://images.openfoodfacts.org/images/products/005/100/000/5540/front_en.11.400.jpg"],
  [/\bcampbell'?s\b.*\bchunky\b.*\bnew\s+england\s+clam\s+chowder\b/i, "https://images.openfoodfacts.org/images/products/75395322/front_en.3.400.jpg"],
  [/\bcampbell'?s\b.*\bnew\s+england\s+clam\s+chowder\b/i, "https://images.openfoodfacts.org/images/products/005/100/001/3675/front_fr.3.400.jpg"],
  [/\bamy'?s\b.*\blentil\b.*\bsoup\b/i, "https://images.openfoodfacts.org/images/products/004/223/400/5833/front_en.3.400.jpg"],
  [/\bdoritos\b.*\bnacho\s+cheese\b/i, "https://images.openfoodfacts.org/images/products/120/010/800/0721/front_en.3.400.jpg"],
  [/\bdoritos\b.*\bcool\s+ranch\b/i, "https://images.openfoodfacts.org/images/products/000/284/000/9151/front_en.7.400.jpg"],
  [/\blay'?s\b.*\bwavy\b.*\boriginal\b/i, "https://images.openfoodfacts.org/images/products/002/840/031/0468/front_en.13.400.jpg"],
  [/\bsiete\b.*\btortilla\s+chips\b/i, "https://images.openfoodfacts.org/images/products/085/176/900/7003/front_en.13.400.jpg"],
  [/\bsanta\s+cruz\b.*\bpeanut\s+butter\b/i, "https://images.openfoodfacts.org/images/products/005/150/090/2882/front_en.28.400.jpg"],
  [/\bgood\s*(?:&|and)?\s*gather\b.*\bpeanut\s+butter\b/i, "https://images.openfoodfacts.org/images/products/008/523/934/0400/front_en.3.400.jpg"],
  [/\bthree\s+wishes\b.*\bcocoa\b/i, "https://images.openfoodfacts.org/images/products/086/000/215/2493/front_en.3.400.jpg"],
  [/\bthree\s+wishes\b.*\b(?:frosted|vanilla)\b/i, "https://images.openfoodfacts.org/images/products/085/001/681/3046/front_en.11.400.jpg"],
  [/\borganic\s+valley\b.*\bamerican\b.*\bcheese\b/i, "https://images.openfoodfacts.org/images/products/009/396/600/4861/front_en.5.400.jpg"],
  [/\borganic\s+valley\b.*\bsharp\s+cheddar\b/i, "https://images.openfoodfacts.org/images/products/009/396/600/5431/front_en.5.400.jpg"],
  [/\borganic\s+valley\b.*\bbutter\b/i, "https://images.openfoodfacts.org/images/products/009/396/600/6469/front_en.3.400.jpg"],
  [/\blactaid\b.*\bmilk\b/i, "https://images.openfoodfacts.org/images/products/004/410/012/2392/front_en.3.400.jpg"],
  [/\bboulder\s+canyon\b.*\b(?:avocado|chips)\b/i, "https://images.openfoodfacts.org/images/products/39369635/front_en.3.400.jpg"],
  [/\bdave'?s\s+killer\s+bread\b/i, "https://images.openfoodfacts.org/images/products/002/376/400/5043/front_en.3.400.jpg"],
  [/\bwonder\b.*\b(?:classic\s+)?white\s+bread\b/i, "https://images.openfoodfacts.org/images/products/007/225/001/1372/front_en.17.400.jpg"],
  [/\byoplait\b.*\boriginal\b.*\bstrawberry\b/i, "https://images.openfoodfacts.org/images/products/007/047/000/4303/front_en.24.400.jpg"],
  [/\bstonyfield\b.*\bwhole\s+milk\b.*\bplain\b.*\byogurt\b/i, "https://images.openfoodfacts.org/images/products/005/215/900/0011/front_en.11.400.jpg"],
  [/\bcheez[- ]?it\b.*\boriginal\b/i, "https://images.openfoodfacts.org/images/products/002/410/012/2615/front_en.44.400.jpg"],
  [/\bpepperidge\s+farm\b.*\bgoldfish\b.*\bcheddar\b/i, "https://images.openfoodfacts.org/images/products/001/410/008/4761/front_en.16.400.jpg"],
  [/\bmary'?s\s+gone\s+crackers\b.*\boriginal\b/i, "https://images.openfoodfacts.org/images/products/065/439/124/6006/front_en.3.400.jpg"],
  [/\boscar\s+mayer\b.*\bdeli\s+fresh\b.*\b(?:honey\s+)?smoked\s+turkey\b/i, "https://images.openfoodfacts.org/images/products/004/470/003/1483/front_en.10.400.jpg"],
  [/\bwelch'?s\b.*\bmixed\s+fruit\s+snacks?\b/i, "https://images.openfoodfacts.org/images/products/003/485/601/5987/front_en.13.400.jpg"],
  [/\b(?:larabar|lärabar)\b.*\bcashew\s+cookie\b/i, "https://images.openfoodfacts.org/images/products/002/190/840/9528/front_en.11.400.jpg"],
  [/\bthat'?s\s+it\b.*\bapple\b.*\bstrawberr/i, "https://images.openfoodfacts.org/images/products/638/859/700/4996/front_en.3.400.jpg"],
  [/\bsimple\s+mills\b.*\bchocolate\s+chip\b.*\bcookies?\b/i, "https://images.openfoodfacts.org/images/products/84664945/front_en.10.400.jpg"],
  [/\boreo\b.*\bchocolate\s+sandwich\s+cookies?\b/i, "https://images.openfoodfacts.org/images/products/004/400/004/7009/front_en.20.400.jpg"],
  [/\beggo\b.*\bhomestyle\b.*\bwaffles?\b/i, "https://images.openfoodfacts.org/images/products/003/800/040/2609/front_en.21.400.jpg"],
  [/\bkraft\b.*\bmacaroni\s*(?:&|and)\s*cheese\b.*\boriginal\b/i, "https://images.openfoodfacts.org/images/products/002/100/003/3720/front_en.15.400.jpg"],
  [/\brao'?s\b.*\bmarinara\b/i, "https://images.openfoodfacts.org/images/products/074/747/900/0017/front_en.12.400.jpg"],
  [/\bannie'?s\b.*\byellow\s+mustard\b/i, "https://images.openfoodfacts.org/images/products/009/232/522/2243/front_en.5.400.jpg"],
  [/\bcoombs\s+family\s+farms\b.*\bmaple\s+syrup\b/i, "https://images.openfoodfacts.org/images/products/071/028/232/9644/front_en.3.400.jpg"],
  [/\bbob'?s\s+red\s+mill\b.*\brolled\s+oats\b/i, "https://images.openfoodfacts.org/images/products/003/997/803/3758/front_en.43.400.jpg"],
  [/\balden'?s\s+organic\b.*\bvanilla\s+bean\b.*\bice\s+cream\b/i, "https://images.openfoodfacts.org/images/products/007/269/274/1851/front_en.3.400.jpg"],
  [/\bcoffee[- ]?mate\b.*\bfrench\s+vanilla\b/i, "https://images.openfoodfacts.org/images/products/005/000/032/2756/front_en.31.400.jpg"],
  [/\bsmucker'?s\b.*\buncrustables?\b/i, "https://images.openfoodfacts.org/images/products/005/150/005/0163/front_en.14.400.jpg"],
  [/\bcapri\s*sun\b.*\bstrawberry\s+kiwi\b/i, "https://images.openfoodfacts.org/images/products/008/768/400/0991/front_en.14.400.jpg"],
  [/\bhu\b.*\b(?:simple|dark\s+chocolate|chocolate)\b/i, "https://images.openfoodfacts.org/images/products/123/000/009/7000/front_en.18.400.jpg"],
  [/\bmonster\b.*\b(?:zero\s+ultra|ultra\s+white)\b/i, "https://images.openfoodfacts.org/images/products/007/084/789/2519/front_en.3.400.jpg"],
  [/\bmonster\s+energy\b/i, "https://images.openfoodfacts.org/images/products/007/084/703/7712/front_en.8.400.jpg"],
  [/\bred\s*bull\b.*\bsugar\s*free\b/i, "https://images.openfoodfacts.org/images/products/900/249/025/7064/front_en.4.400.jpg"],
  [/\bred\s*bull\b/i, "https://images.openfoodfacts.org/images/products/900/249/020/5973/front.24.400.jpg"],
  [/\bcelsius\b.*\borange\b/i, "https://images.openfoodfacts.org/images/products/088/939/200/0412/front_en.3.400.jpg"],
  [/\bcelsius\b/i, "https://images.openfoodfacts.org/images/products/088/939/201/0145/front_en.10.400.jpg"],
  [/\bc4\b.*\b(?:pre[- ]?workout|icy\s+blue|powder)\b/i, "https://images.openfoodfacts.org/images/products/084/259/510/5575/front_en.3.400.jpg"],
  [/\bc4\b/i, "https://images.openfoodfacts.org/images/products/084/259/512/0349/front_en.17.400.jpg"],
  [/\balani\s+nu\b/i, "https://images.openfoodfacts.org/images/products/081/003/051/0024/front_en.3.400.jpg"],
  [/\bghost\b.*\benergy\b/i, "https://images.openfoodfacts.org/images/products/081/002/829/5988/front_en.3.400.jpg"],
  [/\b(?:guayaki|guayakí)\b.*\byerba\s+mate\b/i, "https://images.openfoodfacts.org/images/products/063/243/200/0046/front_en.6.400.jpg"],
  [/\bora\s+organic\b.*\b(?:renewable|pre[- ]?workout)\b/i, "https://images.openfoodfacts.org/images/products/085/672/000/7115/front_en.3.400.jpg"],
  [/\bcore\s+power\b/i, "https://images.openfoodfacts.org/images/products/061/134/003/2066/front_en.3.400.jpg"],
  [/\borgain\b.*\bprotein\b/i, "https://images.openfoodfacts.org/images/products/085/177/000/8938/front_en.3.400.jpg"],
  [/\bdiet\s+coke\b/i, "https://images.openfoodfacts.org/images/products/004/900/002/4692/front_en.11.400.jpg"],
  [/\bcoca[- ]?cola\b.*\b(?:classic|original)\b/i, "https://images.openfoodfacts.org/images/products/500/011/254/6415/front_de.137.400.jpg"],
  [/\b(?:mountain|mtn)\s+dew\b/i, "https://images.openfoodfacts.org/images/products/001/200/003/2448/front_en.12.400.jpg"],
  [/\bolipop\b.*\b(?:vintage\s+cola|cola)\b/i, "https://images.openfoodfacts.org/images/products/086/948/401/5005/front_en.3.400.jpg"],
  [/\bpoppi\b.*\bstrawberry\s+lemon\b/i, "https://images.openfoodfacts.org/images/products/081/006/371/0668/front_en.3.400.jpg"],
  [/\bpoppi\b/i, "https://images.openfoodfacts.org/images/products/081/006/371/0309/front_en.3.400.jpg"],
  [/\bfiji\b.*\bwater\b/i, "https://images.openfoodfacts.org/images/products/941/757/400/1424/front_en.3.400.jpg"],
  [/\bspindrift\b/i, "https://images.openfoodfacts.org/images/products/085/657/900/2910/front_en.19.400.jpg"],
  [/\bgatorade\b(?!.*\bg2\b).*\bfruit\s+punch\b/i, "https://images.openfoodfacts.org/images/products/005/200/024/1211/front_en.12.400.jpg"],
  [/\bnooma\b/i, "https://images.openfoodfacts.org/images/products/085/137/300/5044/front_en.5.400.jpg"],
  [/\bprime\b.*\b(?:hydration|ice\s+pop)\b/i, "https://images.openfoodfacts.org/images/products/085/004/000/5226/front_en.3.400.jpg"],
  [/\bsimply\s+orange\b/i, "https://images.openfoodfacts.org/images/products/002/500/010/0000/front_en.30.400.jpg"],
  [/\buncle\s+matt'?s\b.*\borange\s+juice\b/i, "https://images.openfoodfacts.org/images/products/069/706/852/0139/front_en.12.400.jpg"],
  [/\bharmless\s+harvest\b.*\bcoconut\s+water\b/i, "https://images.openfoodfacts.org/images/products/85902800/front_en.3.400.jpg"],
  [/\bsunny\s*d\b/i, "https://images.openfoodfacts.org/images/products/005/020/012/1005/front_en.3.400.jpg"],
  [/\bstarbucks\b.*\bfrappuccino\b/i, "https://images.openfoodfacts.org/images/products/001/200/000/4520/front_en.4.400.jpg"],
  [/\bstok\b.*\bcold\s+brew\b/i, "https://images.openfoodfacts.org/images/products/003/663/207/2634/front_en.3.400.jpg"],
  [/\bfairlife\b.*\bmilk\b/i, "https://images.openfoodfacts.org/images/products/081/162/002/0169/front_en.83.400.jpg"],
  [/\bmalk\b.*\boat\b/i, "https://images.openfoodfacts.org/images/products/076/574/644/4432/front_en.3.400.jpg"],
  [/\bmalk\b.*\balmond\b/i, "https://images.openfoodfacts.org/images/products/085/003/046/4040/front_en.3.400.jpg"],
  [/\bcalifia\b.*\boat/i, "https://images.openfoodfacts.org/images/products/081/363/602/1932/front_en.30.400.jpg"],
  [/\bcalifia\b.*\balmond/i, "https://images.openfoodfacts.org/images/products/085/290/900/3855/front_en.9.400.jpg"],
  [/\boatly\b/i, "https://images.openfoodfacts.org/images/products/001/906/466/4110/front_en.3.400.jpg"],
  [/\bnesquik\b.*\bchocolate\b/i, "https://images.openfoodfacts.org/images/products/002/800/077/1720/front_en.3.400.jpg"],
  [/\bhorizon\s+organic\b.*\bchocolate\b/i, "https://images.openfoodfacts.org/images/products/003/663/207/8513/front_en.3.400.jpg"],
  [/\bsimple\s+truth\b.*\bgreek\s+yogurt\b/i, "https://images.openfoodfacts.org/images/products/001/111/010/8333/front_en.3.400.jpg"],
  [/\bbig\s+k\b(?!.*\b(?:zero|diet)\b).*\bcola\b/i, "https://images.openfoodfacts.org/images/products/001/111/049/1053/front_en.3.400.jpg"],
  [/\bprivate\s+selection\b.*\bangus\b/i, "https://images.openfoodfacts.org/images/products/001/111/022/0691/front_en.3.400.jpg"],
  [/\bfavorite\s+day\b.*\bnon[- ]?dairy\b.*\bvanilla\b/i, "https://images.openfoodfacts.org/images/products/008/523/914/1694/front_en.8.400.jpg"],
  [/\bbutterball\b.*\bturkey\b/i, "https://images.openfoodfacts.org/images/products/023/007/223/1082/front_en.3.400.jpg"],
  [/\bapplegate\b.*\broast\s+beef\b/i, "https://images.openfoodfacts.org/images/products/002/531/715/6745/front_en.12.400.jpg"],
  [/\bapplegate\b.*\b(?:hot\s*dog|frank)\b/i, "https://images.openfoodfacts.org/images/products/002/531/753/2006/front.3.400.jpg"],
  [/\bapplegate\b.*\bbacon\b/i, "https://images.openfoodfacts.org/images/products/002/531/733/1005/front_en.3.400.jpg"],
  [/\bapplegate\b.*\bturkey\s+breast\b/i, "https://images.openfoodfacts.org/images/products/022/517/201/1436/front_en.3.400.jpg"],
  [/\bapplegate\b.*\bblack\s+forest\s+ham\b/i, "https://images.openfoodfacts.org/images/products/002/531/700/5906/front_en.5.400.jpg"],
  [/\bapplegate\b.*\borganic.*\bsalami\b/i, "https://images.openfoodfacts.org/images/products/002/531/765/6009/front.7.400.jpg"],
  [/\bapplegate\b.*\bsalami\b/i, "https://images.openfoodfacts.org/images/products/002/531/766/8569/front_en.4.400.jpg"],
  [/\bapplegate\b.*\bbreakfast\s+sausage\b/i, "https://images.openfoodfacts.org/images/products/002/531/700/5890/front_en.5.400.jpg"],
  [/\bapplegate\b.*\borganic.*\bnuggets?\b/i, "https://images.openfoodfacts.org/images/products/002/531/760/5519/front_en.6.400.jpg"],
  [/\bapplegate\b.*\bnuggets?\b/i, "https://images.openfoodfacts.org/images/products/002/531/705/5192/front_en.22.400.jpg"],
  [/\bannie'?s\b.*\b(?:shells|cheddar|mac)\b/i, "https://images.openfoodfacts.org/images/products/26565859/front_en.3.400.jpg"],
  [/\blotus\s+foods\b.*\bramen\b/i, "https://images.openfoodfacts.org/images/products/070/895/362/8172/front_en.3.400.jpg"],
  [/\bmaruchan\b.*\bramen\b/i, "https://images.openfoodfacts.org/images/products/004/178/900/2915/front_es.14.400.jpg"],
  [/\bmarketside\s+butcher\b.*\bground\s+beef\b/i, "https://images.openfoodfacts.org/images/products/068/113/137/7416/front_en.3.400.jpg"],
  [/\bverde(?:\s+farms)?\b.*\bground\s+beef\b/i, "https://images.openfoodfacts.org/images/products/082/581/911/0319/front_en.14.400.jpg"],
  [/\b(?:ground\s+beef|ground\s+chuck|\d{2}%\s*lean.*beef)\b/i, "https://images.openfoodfacts.org/images/products/020/434/580/7045/front_en.3.400.jpg"],
  [/\bsmithfield\b.*\bham\b/i, "https://images.openfoodfacts.org/images/products/020/634/010/5485/front_en.3.400.jpg"],
  [/\bvital\s+farms\b.*\beggs?\b/i, "https://images.openfoodfacts.org/images/products/086/174/500/0010/front_en.27.400.jpg"],
  [/\borganic\s+valley\b.*\bmilk\b/i, "https://images.openfoodfacts.org/images/products/64715087/front_en.3.400.jpg"],
  [/\bgreat\s+value\b.*\bmilk\b/i, "https://images.openfoodfacts.org/images/products/007/874/215/9034/front_en.4.400.jpg"],
  [/\bgreat\s+value\b.*\bbutter\b/i, "https://images.openfoodfacts.org/images/products/007/874/202/5933/front_en.16.400.jpg"],
  [/\bgreat\s+value\b.*\beggs?\b/i, "https://images.openfoodfacts.org/images/products/007/874/233/0624/front_en.3.400.jpg"],
  [/\bgreat\s+value\b.*\b(?:macaroni|mac\s*(?:&|and)\s*cheese)\b/i, "https://images.openfoodfacts.org/images/products/007/874/235/8857/front_en.4.400.jpg"],
  [/\bgreat\s+value\b.*\bdiced\s+tomatoes\b/i, "https://images.openfoodfacts.org/images/products/007/874/202/0976/front_en.4.400.jpg"],
  [/\bgreat\s+value\b.*\bwater\b/i, "https://images.openfoodfacts.org/images/products/84464033/front_en.3.400.jpg"],
  [/^(?!.*\b(?:chips?|crisps?|fries|tots|mashed|salad)\b).*\b(?:sweet\s+potato(?:es)?|yams?)\b/i, "https://images.openfoodfacts.org/images/products/017/620/200/0336/front_en.7.400.jpg"],
  [/^(?!.*\b(?:chips?|crisps?|fries|tots|mashed|salad)\b).*\b(?:russet\s+potato(?:es)?|idaho\s+potato(?:es)?|yukon\s+gold\s+potato(?:es)?|red\s+potato(?:es)?|yellow\s+potato(?:es)?|butter\s+potato(?:es)?|potatoes,?\s+butter|fresh\s+whole\s+potato(?:es)?)\b/i, "https://images.openfoodfacts.org/images/products/007/078/401/2964/front_en.3.400.jpg"],
  [/^(?!.*\b(?:pudding|bread|muffin|chips?|boat|sunscreen)\b).*\b(?:fresh\s+bananas?|bananas?)\b/i, "https://images.openfoodfacts.org/images/products/200/000/015/1418/front_en.3.400.jpg"],
  [/^(?!.*\b(?:juice|cider|sauce|applesauce|pie|chips?|strudel|fritter|danish)\b).*\b(?:honeycrisp\s+apples?|gala\s+apples?|fuji\s+apples?|granny\s+smith\s+apples?|fresh\s+apples?)\b/i, "https://images.openfoodfacts.org/images/products/002/290/630/0183/front_en.3.400.jpg"],
  [/\bstonyfield\b.*\byogurt\b/i, "https://images.openfoodfacts.org/images/products/343/886/000/1863/front.4.400.jpg"],
  [/\bmary'?s\s+gone\s+crackers\b/i, "https://images.openfoodfacts.org/images/products/065/439/124/6006/front_en.3.400.jpg"],
  [/\bezekiel\b.*\bbread\b/i, "https://images.openfoodfacts.org/images/products/007/347/200/1202/front_en.46.400.jpg"],
  [/\b(?:larabar|lärabar)\b/i, "https://images.openfoodfacts.org/images/products/002/190/811/0110/front_en.4.400.jpg"],
  [/\brao'?s\b.*\b(?:marinara|sauce)\b/i, "https://images.openfoodfacts.org/images/products/074/747/900/1199/front_en.3.400.jpg"],
  [/\bprimal\s+kitchen\b.*\b(?:mayo|mayonnaise)\b/i, "https://images.openfoodfacts.org/images/products/468/112/060/0422/front_en.7.400.jpg"],
  [/^(?!.*\b(?:cake|juice|soup)\b).*\b(?:baby\s+cut\s+carrots?|whole\s+carrots?|fresh\s+carrots?)\b/i, "https://images.openfoodfacts.org/images/products/003/582/608/6372/front_en.3.400.jpg"],
];

const STOP_TOKENS = new Set([
  "the", "and", "with", "for", "oz", "fl", "lb", "lbs", "ct", "count", "pack", "pk",
  "flavored", "flavor",
  "grade", "category", "estimate", "verify", "package", "label", "rating", "ratings",
  "sweeteners", "sweetener", "creamery", "fresh", "each", "average", "price",
  "snack", "size", "family", "party", "share", "fun", "giant", "king", "bag", "box",
  "pouch", "jar", "bottle", "can", "carton", "candy", "bars", "bar", "gourmet", "gift",
  "energy", "drink", "drinks", "pre", "workout", "preworkout", "fitness", "live", "fit",
  "performance", "clean", "renewable", "original", "classic", "salad", "dressing",
  "ready", "soda", "pop", "soft", "shake", "squeezed", "pure", "natural", "artesian",
  "thirst", "quencher", "sports", "hydration", "chilled", "ultra", "filtered",
  "lactose", "free", "whole", "grains", "seeds", "simple", "plain", "low", "fat",
  "lowfat", "tangy",
]);

const TWO_CHAR_BRAND_TOKENS = new Set(["c4", "hu", "v8", "gt", "7up", "aw"]);

function distinctiveTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\btruffl\b/g, "truffles")
    .replace(/\bchocolat\b/g, "chocolate")
    .replace(/\bappl\b/g, "apples")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(
      (t) =>
        (t.length >= 3 || TWO_CHAR_BRAND_TOKENS.has(t)) &&
        !STOP_TOKENS.has(t) &&
        !/^\d+$/.test(t),
    );
}

const BLOCKED_ROTATED_OFF_IMAGE_RE = /\/10603499\//;

async function resolveRealProductImageUrl(rawQuery: string): Promise<string | null> {
  for (const [re, verifiedUrl] of VERIFIED_PRODUCT_IMAGES) {
    if (re.test(rawQuery)) {
      return verifiedUrl;
    }
  }

  const clean = rawQuery
    .replace(/\(category\s+estimate[^)]*\)/gi, " ")
    .replace(/\(representative\s+formulation[^)]*\)/gi, " ")
    .replace(/\([^)]*$/g, " ")
    .replace(/\b(natural\s+sweeteners|creamery\s+butter|conventional\s+grocery)\b/gi, " ")
    .replace(/\s*,\s*ratings?\b/gi, " ")
    .replace(/\b(\d+(\.\d+)?\s*(oz|fl\s*oz|lb|lbs|ct|count|pack|pk|g|kg|ml|l|cup|bag|box|can|jar|bottle|as|assorted)s?)\b/gi, " ")
    .replace(/\bpack\s+of\s+\d+\b/gi, " ")
    .replace(/\b(snack\s+size|family\s+size|party\s+size|share\s+size|fun\s+size|candy\s+bag|candy\s+bars?|gourmet\s+gift\s+box)\b/gi, " ")
    .replace(/\btruffl\.*/gi, "Truffles")
    .replace(/\bchocolat\.*/gi, "Chocolate")
    .replace(/\bappl\.*/gi, "Apples")
    .replace(/[.,•|\-–—…]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cacheKey = clean.toLowerCase();
  const tokens = distinctiveTokens(clean);
  if (tokens.length < 1) return null;
  const cached = imageUrlCache.get(cacheKey);
  if (cached) return cached;

  const conciseQuery = tokens.slice(0, 4).join(" ");
  const queriesToTry: string[] = [];
  if (tokens.length >= 3) {
    queriesToTry.push(`brands_tags:"${tokens[0]}-${tokens[1]}" ${tokens.slice(2, 5).join(" ")}`);
  }
  if (tokens.length >= 2) {
    queriesToTry.push(`brands_tags:"${tokens[0]}" ${tokens.slice(1, 4).join(" ")}`);
  }
  queriesToTry.push(conciseQuery);
  if (clean.toLowerCase() !== conciseQuery) {
    queriesToTry.push(clean);
  }

  // OpenFoodFacts Search-a-licious v3 open-licensed product image lookup (ODbL / CC-BY-SA 3.0)
  for (const searchQ of queriesToTry) {
    try {
      const offUrl = `https://search.openfoodfacts.org/search?q=${encodeURIComponent(searchQ)}&page_size=8&fields=code,product_name,product_name_en,brands,image_front_small_url,image_front_url`;
      const res = await fetch(offUrl, {
        headers: { "User-Agent": "HeyBroc/2.0 (https://www.heybroc.com)" },
        signal: AbortSignal.timeout(3800),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          hits?: Array<{
            product_name?: string;
            product_name_en?: string;
            brands?: string | string[];
            image_front_small_url?: string;
            image_front_url?: string;
          }>;
        };
        const hits = data.hits || [];
        let hit = hits.find((p) => {
          const imgCandidate = p.image_front_small_url || p.image_front_url;
          if (!imgCandidate || BLOCKED_ROTATED_OFF_IMAGE_RE.test(imgCandidate)) return false;
          const brandsStr = Array.isArray(p.brands) ? p.brands.join(" ") : p.brands || "";
          const candidateTitle = `${brandsStr} ${p.product_name_en || p.product_name || ""}`.trim();
          return (
            hasProductIdentityMatch(conciseQuery, candidateTitle) ||
            hasProductIdentityMatch(rawQuery, candidateTitle)
          );
        });
        if (!hit) {
          const minOverlap = tokens.length >= 2 ? 2 : 1;
          hit = hits.find((p) => {
            const imgCandidate = p.image_front_small_url || p.image_front_url;
            if (!imgCandidate || BLOCKED_ROTATED_OFF_IMAGE_RE.test(imgCandidate)) return false;
            const brandsStr = Array.isArray(p.brands) ? p.brands.join(" ") : p.brands || "";
            const candidateTitle = `${brandsStr} ${p.product_name_en || p.product_name || ""}`.trim();
            if (
              !hasProductIdentityMatch(clean, candidateTitle) &&
              !hasProductIdentityMatch(rawQuery, candidateTitle)
            ) {
              return false;
            }
            const candidateTokens = new Set(distinctiveTokens(candidateTitle));
            if (tokens.length >= 1 && !candidateTokens.has(tokens[0])) return false;
            const matchedCount = tokens.filter((t) => candidateTokens.has(t)).length;
            return matchedCount >= minOverlap;
          });
        }
        const url = hit?.image_front_small_url || hit?.image_front_url;
        if (url && isAllowedImageUrl(url)) {
          if (imageUrlCache.size >= 1000) {
            const oldest = imageUrlCache.keys().next().value;
            if (oldest !== undefined) imageUrlCache.delete(oldest);
          }
          imageUrlCache.set(cacheKey, url);
          return url;
        }
      }
    } catch {
      // Ignore and try next query or fall through to local category asset
    }
  }

  return null;
}

export async function GET(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "anon";
  if (!checkRateLimit(`img:${ip}`, 300)) {
    return new NextResponse("Too many requests", { status: 429 });
  }
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || searchParams.get("title") || "").trim().slice(0, 160);
  if (!q) {
    return new NextResponse("Missing query", { status: 400 });
  }

  const key = q.toLowerCase();
  const cachedBytes = imageBytesCache.get(key);
  if (cachedBytes) {
    return new NextResponse(cachedBytes.bytes, {
      status: 200,
      headers: {
        "Content-Type": cachedBytes.contentType,
        "Cache-Control": "public, max-age=604800, immutable",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "X-Image-Source, X-Image-License",
        "X-Image-Source": `Open Food Facts (${cachedBytes.sourceUrl})`,
        "X-Image-License": "CC BY-SA 3.0 (https://world.openfoodfacts.org/terms-of-use)",
      },
    });
  }

  const targetUrl = await resolveRealProductImageUrl(q);
  if (targetUrl && isAllowedImageUrl(targetUrl)) {
    try {
      const imgRes = await fetch(targetUrl, {
        headers: { "User-Agent": "HeyBroc/2.0 (https://www.heybroc.com)" },
        signal: AbortSignal.timeout(4500),
      });
      if (imgRes.ok) {
        const contentType = imgRes.headers.get("content-type") || "image/jpeg";
        const contentLength = Number(imgRes.headers.get("content-length") || "0");
        if (contentType.startsWith("image/") && contentLength <= MAX_IMAGE_BYTES) {
          const bytes = await imgRes.arrayBuffer();
          if (bytes.byteLength > 200 && bytes.byteLength <= MAX_IMAGE_BYTES) {
            if (imageBytesCache.size >= 250) {
              const oldest = imageBytesCache.keys().next().value;
              if (oldest !== undefined) imageBytesCache.delete(oldest);
            }
            imageBytesCache.set(key, { bytes, contentType, sourceUrl: targetUrl });
            return new NextResponse(bytes, {
              status: 200,
              headers: {
                "Content-Type": contentType,
                "Cache-Control": "public, max-age=604800, immutable",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Expose-Headers": "X-Image-Source, X-Image-License",
                "X-Image-Source": `Open Food Facts (${targetUrl})`,
                "X-Image-License": "CC BY-SA 3.0 (https://world.openfoodfacts.org/terms-of-use)",
              },
            });
          }
        }
      }
    } catch {
      // Fall through to local fallback asset
    }
  }

  // 3. Guaranteed local studio category photo so product cards never show broken images
  const fallback = localFallbackAssetForQuery(q);
  try {
    const buf = await fs.readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), fallback.relPath));
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": fallback.contentType,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "X-Image-Source, X-Image-License",
        "X-Image-Source": "local-category-photo",
        "X-Image-License": "Proprietary",
      },
    });
  } catch {
    const publicPath = fallback.relPath.replace(/^public/, "");
    return NextResponse.redirect(new URL(publicPath, request.url), 302);
  }
}

export const HEAD = GET;
