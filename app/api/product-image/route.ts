import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { hasProductIdentityMatch, passesVariantGuard } from "@/lib/drinks-catalog";
import { checkRateLimitAsync } from "@/lib/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const imageUrlCache = new Map<string, string>();
const imageBytesCache = new Map<string, { bytes: ArrayBuffer; contentType: string; sourceUrl: string }>();

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_HOST_SUFFIXES = [".openfoodfacts.org", ".openfoodfacts.net"];
const PLACEHOLDER_SVG_REL_PATH = "public/product-photo-unavailable.svg";

const NON_ENGLISH_OFF_FRONT_IMAGE_RE =
  /\/front_(?:fr|de|es|it|nl|pl|pt|ru|ja|zh|ar|ro|hu|cs|sv|da|fi|el|tr|he|ko|th|vi)\./i;

function isAllowedImageUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    if (NON_ENGLISH_OFF_FRONT_IMAGE_RE.test(parsed.pathname)) return false;
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

/**
 * Curated Open Food Facts front-of-pack product photos (CC BY-SA 3.0) and verified
 * Clean Swap product photos for exact Brand + Variant matches.
 * Never assign generic category illustrations or misleading organic/grass-fed labels to unmatched items.
 */
const VERIFIED_PRODUCT_IMAGES: Array<[RegExp, string]> = [
  [/\b(?:simply\s+nature|wellsley\s+farms|member'?s\s+mark|365\s+by\s+whole\s+foods|simple\s+truth|great\s+value)\b.*\borganic\b.*\bpeanut\s+butter\b/i, "local:" + "public/swaps/peanutbutter.png"],
  [/\bthat'?s\s+it\b.*\b(?:fruit\s+bars?|apple\b.*\bstrawberr)/i, "https://images.openfoodfacts.org/images/products/638/859/700/4996/front_en.3.400.jpg"],
  [/\b(?:solely|simply\s+nature)\b.*\bfruit\s+(?:bars?|strips?)\b/i, "local:" + "public/swaps/fruitbar.png"],
  [/\bhidden\s+valley\b.*\branch\b/i, "https://images.openfoodfacts.org/images/products/007/110/000/3116/front_en.7.400.jpg"],
  [/\bprimal\s+kitchen\b.*\branch\b/i, "local:public/swaps/ranch.jpg"],
  [/\bprimal\s+kitchen\b.*\b(?:mayo|mayonnaise)\b/i, "https://images.openfoodfacts.org/images/products/066/369/002/4048/front_en.3.400.jpg"],
  [/\bprimal\s+kitchen\b.*\bketchup\b/i, "https://images.openfoodfacts.org/images/products/827/574/200/7125/front_en.8.400.jpg"],
  [/\bmarketside\b(?!.*\b(?:romaine|dip|artichoke)\b).*\bbaby\s+spinach\b/i, "https://images.openfoodfacts.org/images/products/068/113/132/8982/front_en.3.400.jpg"],
  [/\bcinnamon\s+toast\s+crunch\b/i, "https://images.openfoodfacts.org/images/products/10167730/front_en.3.400.jpg"],
  [/\bkellogg'?s\b.*\bfrosted\s+flakes\b/i, "https://images.openfoodfacts.org/images/products/003/800/012/7502/front_en.3.400.jpg"],
  [/\bnature'?s\s+path\b.*\bheritage\s+flakes\b/i, "https://images.openfoodfacts.org/images/products/991/360/277/0206/front_en.4.400.jpg"],
  [/\bcampbell'?s\b.*\bmanhattan\b.*\bclam\s+chowder\b/i, "https://images.openfoodfacts.org/images/products/005/100/000/5540/front_en.11.400.jpg"],
  [/\bcampbell'?s\b.*\bchunky\b.*\bnew\s+england\s+clam\s+chowder\b/i, "https://images.openfoodfacts.org/images/products/75395322/front_en.3.400.jpg"],
  [/\bmarketside\b.*\bclam\s+chowder\b/i, "https://images.openfoodfacts.org/images/products/084/013/430/8029/front_en.3.400.jpg"],
  [/\bcampbell'?s\b.*\bclam\s+chowder\b/i, "https://images.openfoodfacts.org/images/products/005/100/000/5540/front_en.11.400.jpg"],
  [/\bamy'?s\b.*\blentil\b.*\bsoup\b/i, "https://images.openfoodfacts.org/images/products/004/223/400/5833/front_en.3.400.jpg"],
  [/\bdoritos\b.*\bnacho\s+cheese\b/i, "https://images.openfoodfacts.org/images/products/120/010/800/0721/front_en.3.400.jpg"],
  [/\bdoritos\b.*\bcool\s+ranch\b/i, "https://images.openfoodfacts.org/images/products/000/284/000/9151/front_en.7.400.jpg"],
  [/\blay'?s\b.*\bwavy\b.*\boriginal\b/i, "https://images.openfoodfacts.org/images/products/002/840/031/0468/front_en.13.400.jpg"],
  [/\bsiete\b.*\btortilla\s+chips\b/i, "https://images.openfoodfacts.org/images/products/085/176/900/7003/front_en.13.400.jpg"],
  [/\bsiete\b.*\btortillas?\b/i, "local:public/swaps/tortillas.png"],
  [/\bsanta\s+cruz\b.*\bpeanut\s+butter\b/i, "https://images.openfoodfacts.org/images/products/005/150/090/2882/front_en.28.400.jpg"],
  [/\bgood\s*(?:&|and)?\s*gather\b.*\bpeanut\s+butter\b/i, "https://images.openfoodfacts.org/images/products/008/523/934/0400/front_en.3.400.jpg"],
  [/\bthree\s+wishes\b.*\bcocoa\b/i, "https://images.openfoodfacts.org/images/products/086/000/215/2493/front_en.3.400.jpg"],
  [/\bthree\s+wishes\b.*\b(?:frosted|vanilla|cereal)\b/i, "https://images.openfoodfacts.org/images/products/085/001/681/3046/front_en.11.400.jpg"],
  [/\borganic\s+valley\b.*\bamerican\b.*\bcheese\b/i, "https://images.openfoodfacts.org/images/products/009/396/600/4861/front_en.5.400.jpg"],
  [/\borganic\s+valley\b.*\bsharp\s+cheddar\b/i, "https://images.openfoodfacts.org/images/products/009/396/600/5431/front_en.5.400.jpg"],
  [/\b(?:organic\s+valley|kerrygold)\b.*\bbutter\b/i, "local:public/swaps/butter.jpg"],
  [/\blactaid\b(?!.*\bchocolate\b).*\bmilk\b/i, "https://images.openfoodfacts.org/images/products/004/410/012/2392/front_en.3.400.jpg"],
  [/\bboulder\s+canyon\b.*\b(?:avocado|chips)\b/i, "local:public/swaps/chips.jpg"],
  [/\bdave'?s\s+killer\s+bread\b.*\b21\s+whole\s+grains\b/i, "https://images.openfoodfacts.org/images/products/002/376/400/5043/front_en.3.400.jpg"],
  [/\bwonder\b.*\b(?:classic\s+)?white\b.*\bbread\b/i, "https://images.openfoodfacts.org/images/products/007/225/001/1372/front_en.17.400.jpg"],
  [/\byoplait\b.*\boriginal\b.*\bstrawberry\b/i, "https://images.openfoodfacts.org/images/products/007/047/000/4303/front_en.24.400.jpg"],
  [/\bstonyfield\b.*\bwhole\s+milk\b.*\bplain\b.*\byogurt\b/i, "https://images.openfoodfacts.org/images/products/005/215/900/0011/front_en.11.400.jpg"],
  [/\bcheez[- ]?it\b.*\boriginal\b/i, "https://images.openfoodfacts.org/images/products/002/410/012/2615/front_en.44.400.jpg"],
  [/\bpepperidge\s+farm\b.*\bgoldfish\b.*\bcheddar\b/i, "https://images.openfoodfacts.org/images/products/001/410/008/4761/front_en.16.400.jpg"],
  [/\bmary'?s\s+gone\s+crackers\b.*\boriginal\b/i, "https://images.openfoodfacts.org/images/products/065/439/124/6006/front_en.3.400.jpg"],
  [/\boscar\s+mayer\b.*\bdeli\s+fresh\b.*\b(?:honey\s+)?smoked\s+turkey\b/i, "https://images.openfoodfacts.org/images/products/004/470/003/1483/front_en.10.400.jpg"],
  [/\bwelch'?s\b.*\bmixed\s+fruit\s+snacks?\b/i, "https://images.openfoodfacts.org/images/products/003/485/601/5987/front_en.13.400.jpg"],
  [/\b(?:larabar|lärabar)\b.*\bcashew\s+cookie\b/i, "https://images.openfoodfacts.org/images/products/002/190/840/9528/front_en.11.400.jpg"],
  [/\bsimple\s+mills\b.*\bchocolate\s+chip\b.*\bcookies?\b/i, "https://images.openfoodfacts.org/images/products/84664945/front_en.10.400.jpg"],
  [/\bmade\s*good\b.*\bchocolate\s+chip\b.*\bcookies?\b/i, "local:public/swaps/cookies.png"],
  [/\boreo\b(?!.*\b(?:mint|golden|double\s+stuf|peanut\s+butter|thins|lemon)\b).*\bchocolate\s+sandwich\s+cookies?\b/i, "https://images.openfoodfacts.org/images/products/004/400/004/7009/front_en.20.400.jpg"],
  [/\beggo\b.*\bhomestyle\b.*\bwaffles?\b/i, "https://images.openfoodfacts.org/images/products/003/800/040/2609/front_en.21.400.jpg"],
  [/\bkraft\b.*\bmacaroni\s*(?:&|and)\s*cheese\b.*\boriginal\b/i, "https://images.openfoodfacts.org/images/products/002/100/003/3720/front_en.15.400.jpg"],
  [/\brao'?s\b.*\bmarinara\b/i, "local:public/swaps/marinara.png"],
  [/\bannie'?s\b.*\byellow\s+mustard\b/i, "https://images.openfoodfacts.org/images/products/009/232/522/2243/front_en.5.400.jpg"],
  [/\bcoombs\s+family\s+farms\b.*\bmaple\s+syrup\b/i, "https://images.openfoodfacts.org/images/products/071/028/232/9644/front_en.3.400.jpg"],
  [/\bbob'?s\s+red\s+mill\b.*\brolled\s+oats\b/i, "https://images.openfoodfacts.org/images/products/003/997/803/3758/front_en.43.400.jpg"],
  [/\balden'?s\s+organic\b.*\bvanilla\s+bean\b.*\bice\s+cream\b/i, "https://images.openfoodfacts.org/images/products/007/269/274/1851/front_en.3.400.jpg"],
  [/\bcoffee[- ]?mate\b.*\bfrench\s+vanilla\b/i, "https://images.openfoodfacts.org/images/products/005/000/032/2756/front_en.31.400.jpg"],
  [/\bsmucker'?s\b.*\buncrustables?\b/i, "https://images.openfoodfacts.org/images/products/005/150/005/0163/front_en.14.400.jpg"],
  [/\bcapri\s*sun\b.*\bstrawberry\s+kiwi\b/i, "https://images.openfoodfacts.org/images/products/008/768/400/0991/front_en.14.400.jpg"],
  [/\bhu\b.*\b(?:simple|salty)\b.*\bdark\s+chocolate\b/i, "https://images.openfoodfacts.org/images/products/123/000/009/7000/front_en.18.400.jpg"],
  [/\bmonster\b.*\b(?:zero\s+ultra|ultra\s+white)\b/i, "https://images.openfoodfacts.org/images/products/007/084/789/2519/front_en.3.400.jpg"],
  [/\bmonster\s+energy\b.*\b(?:original|green)\b/i, "https://images.openfoodfacts.org/images/products/007/084/703/7712/front_en.8.400.jpg"],
  [/\bred\s*bull\b.*\bsugar\s*free\b/i, "https://images.openfoodfacts.org/images/products/900/249/025/7064/front_en.4.400.jpg"],
  [/\bred\s*bull\b(?!.*\b(?:sugar\s*free|zero|edition|peach|watermelon|amber|juneberry|tropical|coconut)\b).*\benergy\s+drink\b/i, "https://images.openfoodfacts.org/images/products/900/249/020/5973/front.24.400.jpg"],
  [/\bcelsius\b.*\borange\b/i, "https://images.openfoodfacts.org/images/products/088/939/200/0412/front_en.3.400.jpg"],
  [/\bcelsius\b.*\bwild\s+berry\b/i, "https://images.openfoodfacts.org/images/products/088/939/201/0145/front_en.10.400.jpg"],
  [/\bc4\b.*\b(?:pre[- ]?workout|icy\s+blue)\b/i, "https://images.openfoodfacts.org/images/products/084/259/510/5575/front_en.3.400.jpg"],
  [/\b(?:guayaki|guayakí)\b.*\byerba\s+mate\b.*\b(?:enlighten\s+mint|traditional|unsweetened)\b/i, "https://images.openfoodfacts.org/images/products/063/243/200/0046/front_en.6.400.jpg"],
  [/\bora\s+organic\b.*\b(?:renewable|pre[- ]?workout)\b/i, "https://images.openfoodfacts.org/images/products/085/672/000/7115/front_en.3.400.jpg"],
  [/\bcore\s+power\b.*\bchocolate\b/i, "https://images.openfoodfacts.org/images/products/061/134/003/2066/front_en.3.400.jpg"],
  [/\borgain\b.*\bclean\s+protein\s+shake\b/i, "https://images.openfoodfacts.org/images/products/085/177/000/8938/front_en.3.400.jpg"],
  [/\bdiet\s+coke\b(?!.*\b(?:caffeine[- ]?free|cherry|lime)\b)/i, "https://images.openfoodfacts.org/images/products/004/900/002/4692/front_en.11.400.jpg"],
  [/\b(?:mountain|mtn)\s+dew\b(?!.*\b(?:zero|diet|baja|code\s+red|voltage|major\s+melon)\b)/i, "https://images.openfoodfacts.org/images/products/001/200/003/2448/front_en.12.400.jpg"],
  [/\bolipop\b.*\bvintage\s+cola\b/i, "https://images.openfoodfacts.org/images/products/086/948/401/5005/front_en.3.400.jpg"],
  [/\bpoppi\b.*\bstrawberry\s+lemon\b/i, "https://images.openfoodfacts.org/images/products/081/006/371/0668/front_en.3.400.jpg"],
  [/\bfiji\b.*\bwater\b/i, "https://images.openfoodfacts.org/images/products/941/757/400/1424/front_en.3.400.jpg"],
  [/\bspindrift\b.*\blemon\b(?!\s*lime)/i, "https://images.openfoodfacts.org/images/products/085/657/900/2910/front_en.19.400.jpg"],
  [/\bgatorade\b(?!.*\b(?:g2|zero|fit)\b).*\bfruit\s+punch\b/i, "https://images.openfoodfacts.org/images/products/005/200/024/1211/front_en.12.400.jpg"],
  [/\bnooma\b.*\borganic\s+electrolyte\b/i, "https://images.openfoodfacts.org/images/products/085/137/300/5044/front_en.5.400.jpg"],
  [/\bprime\b.*\bice\s+pop\b/i, "https://images.openfoodfacts.org/images/products/085/004/000/5226/front_en.3.400.jpg"],
  [/\bsimply\s+orange\b(?!.*\b(?:mango|pineapple|calcium|high\s+pulp)\b)/i, "https://images.openfoodfacts.org/images/products/002/500/010/0000/front_en.30.400.jpg"],
  [/\buncle\s+matt'?s\b.*\borange\s+juice\b/i, "https://images.openfoodfacts.org/images/products/069/706/852/0139/front_en.12.400.jpg"],
  [/\bharmless\s+harvest\b.*\bcoconut\s+water\b/i, "https://images.openfoodfacts.org/images/products/85902800/front_en.3.400.jpg"],
  [/\bsunny\s*d\b.*\btangy\s+original\b/i, "https://images.openfoodfacts.org/images/products/005/020/012/1005/front_en.3.400.jpg"],
  [/\bstarbucks\b.*\bmocha\b.*\bfrappuccino\b/i, "https://images.openfoodfacts.org/images/products/001/200/000/4520/front_en.4.400.jpg"],
  [/\bstok\b.*\bunsweetened\b.*\bcold\s+brew\b/i, "https://images.openfoodfacts.org/images/products/003/663/207/2634/front_en.3.400.jpg"],
  [/\bfairlife\b(?!.*\b(?:chocolate|strawberry|skim|fat\s*free|whole)\b).*\b2%\b.*\bmilk\b/i, "https://images.openfoodfacts.org/images/products/081/162/002/0169/front_en.83.400.jpg"],
  [/\bmalk\b.*\bunsweetened\b.*\boat\b/i, "https://images.openfoodfacts.org/images/products/076/574/644/4432/front_en.3.400.jpg"],
  [/\bmalk\b.*\bunsweetened\b.*\balmond\b/i, "https://images.openfoodfacts.org/images/products/085/003/046/4040/front_en.3.400.jpg"],
  [/\bcalifia\b.*\borganic\b.*\boat/i, "https://images.openfoodfacts.org/images/products/081/363/602/1932/front_en.30.400.jpg"],
  [/\bcalifia\b.*\borganic\b.*\balmond/i, "https://images.openfoodfacts.org/images/products/085/290/900/3855/front_en.9.400.jpg"],
  [/\boatly\b(?!.*\b(?:chocolate|barista|full\s+fat|super\s+basic|vanilla)\b).*\b(?:original|oat\s*milk)\b/i, "https://images.openfoodfacts.org/images/products/001/906/466/4110/front_en.3.400.jpg"],
  [/\bnesquik\b.*\bchocolate\b.*\bmilk\b/i, "https://images.openfoodfacts.org/images/products/002/800/077/1720/front_en.3.400.jpg"],
  [/\bhorizon\s+organic\b.*\bchocolate\b.*\bmilk\b/i, "https://images.openfoodfacts.org/images/products/003/663/207/8513/front_en.3.400.jpg"],
  [/\bsimple\s+truth\b.*\bplain\b.*\bgreek\s+yogurt\b/i, "https://images.openfoodfacts.org/images/products/001/111/010/8333/front_en.3.400.jpg"],
  [/\bbig\s+k\b(?!.*\b(?:zero|diet)\b).*\bcola\b/i, "https://images.openfoodfacts.org/images/products/001/111/049/1053/front_en.3.400.jpg"],
  [/\bprivate\s+selection\b.*\bangus\b/i, "https://images.openfoodfacts.org/images/products/001/111/022/0691/front_en.3.400.jpg"],
  [/\bfavorite\s+day\b.*\bnon[- ]?dairy\b.*\bvanilla\b/i, "https://images.openfoodfacts.org/images/products/008/523/914/1694/front_en.8.400.jpg"],
  [/\bbutterball\b.*\bturkey\b/i, "https://images.openfoodfacts.org/images/products/023/007/223/1082/front_en.3.400.jpg"],
  [/\bapplegate\b.*\broast\s+beef\b/i, "https://images.openfoodfacts.org/images/products/002/531/715/6745/front_en.12.400.jpg"],
  [/\bapplegate\b.*\b(?:hot\s*dog|frank)\b/i, "https://images.openfoodfacts.org/images/products/002/531/753/2006/front.3.400.jpg"],
  [/\bapplegate\b.*\bbacon\b/i, "https://images.openfoodfacts.org/images/products/002/531/733/1005/front_en.3.400.jpg"],
  [/\bapplegate\b.*\bblack\s+forest\s+ham\b/i, "https://images.openfoodfacts.org/images/products/002/531/700/5906/front_en.5.400.jpg"],
  [/\bapplegate\b.*\borganic.*\bsalami\b/i, "https://images.openfoodfacts.org/images/products/002/531/765/6009/front.7.400.jpg"],
  [/\bapplegate\b.*\bsalami\b/i, "https://images.openfoodfacts.org/images/products/002/531/766/8569/front_en.4.400.jpg"],
  [/\bapplegate\b.*\bbreakfast\s+sausage\b/i, "https://images.openfoodfacts.org/images/products/002/531/700/5890/front_en.5.400.jpg"],
  [/\bapplegate\b.*\borganic.*\bnuggets?\b/i, "https://images.openfoodfacts.org/images/products/002/531/760/5519/front_en.6.400.jpg"],
  [/\bapplegate\b.*\bnuggets?\b/i, "https://images.openfoodfacts.org/images/products/002/531/705/5192/front_en.22.400.jpg"],
  [/\bannie'?s\b.*\b(?:shells|cheddar|mac)\b/i, "https://images.openfoodfacts.org/images/products/26565859/front_en.3.400.jpg"],
  [/\blotus\s+foods\b.*\bramen\b/i, "https://images.openfoodfacts.org/images/products/070/895/362/8172/front_en.3.400.jpg"],
  [/\bmarketside\s+butcher\b.*\borganic\b.*\bground\s+beef\b/i, "https://images.openfoodfacts.org/images/products/068/113/137/7416/front_en.3.400.jpg"],
  [/\bverde(?:\s+farms)?\b.*\bground\s+beef\b/i, "https://images.openfoodfacts.org/images/products/082/581/911/0319/front_en.14.400.jpg"],
  [/\bsmithfield\b.*\bham\b/i, "https://images.openfoodfacts.org/images/products/020/634/010/5485/front_en.3.400.jpg"],
  [/\bvital\s+farms\b.*\beggs?\b/i, "https://images.openfoodfacts.org/images/products/086/174/500/0010/front_en.27.400.jpg"],
  [/\borganic\s+valley\b(?!.*\b(?:chocolate|2%|1%|skim|fat\s*free|lowfat)\b).*\b(?:grassmilk|whole\s+milk)\b/i, "https://images.openfoodfacts.org/images/products/64715087/front_en.3.400.jpg"],
  [/\bgreat\s+value\b(?!.*\b(?:chocolate|2%|1%|skim|fat\s*free|lowfat|almond|oat|organic)\b).*\bwhole\b.*\bmilk\b/i, "https://images.openfoodfacts.org/images/products/007/874/215/9034/front_en.4.400.jpg"],
  [/\bgreat\s+value\b(?!.*\borganic\b).*\bsweet\s+cream\b.*\bbutter\b/i, "https://images.openfoodfacts.org/images/products/007/874/202/5933/front_en.16.400.jpg"],
  [/\bgreat\s+value\b(?!.*\borganic\b).*\blarge\s+white\s+eggs?\b/i, "https://images.openfoodfacts.org/images/products/007/874/233/0624/front_en.3.400.jpg"],
  [/\bgreat\s+value\b.*\b(?:macaroni|mac\s*(?:&|and)\s*cheese)\b/i, "https://images.openfoodfacts.org/images/products/007/874/235/8857/front_en.4.400.jpg"],
  [/\bgreat\s+value\b.*\bdiced\s+tomatoes\b/i, "https://images.openfoodfacts.org/images/products/007/874/202/0976/front_en.4.400.jpg"],
  [/\bgreat\s+value\b.*\bpurified\b.*\bwater\b/i, "https://images.openfoodfacts.org/images/products/84464033/front_en.3.400.jpg"],
  [/^(?!.*\b(?:chips?|crisps?|fries|tots|mashed|salad)\b).*\b(?:sweet\s+potato(?:es)?|yams?)\b/i, "https://images.openfoodfacts.org/images/products/017/620/200/0336/front_en.7.400.jpg"],
  [/^(?!.*\b(?:chips?|crisps?|fries|tots|mashed|salad)\b).*\b(?:russet\s+potato(?:es)?|idaho\s+potato(?:es)?|yukon\s+gold\s+potato(?:es)?|red\s+potato(?:es)?|yellow\s+potato(?:es)?|butter\s+potato(?:es)?|potatoes,?\s+butter|fresh\s+whole\s+potato(?:es)?)\b/i, "https://images.openfoodfacts.org/images/products/007/078/401/2964/front_en.3.400.jpg"],
  [/^(?!.*\b(?:pudding|bread|muffin|chips?|boat|sunscreen)\b).*\b(?:fresh\s+bananas?|bananas?)\b/i, "https://images.openfoodfacts.org/images/products/200/000/015/1418/front_en.3.400.jpg"],
  [/^(?!.*\b(?:juice|cider|sauce|applesauce|pie|chips?|strudel|fritter|danish)\b).*\b(?:honeycrisp\s+apples?|gala\s+apples?|fuji\s+apples?|granny\s+smith\s+apples?|fresh\s+apples?)\b/i, "https://images.openfoodfacts.org/images/products/002/290/630/0183/front_en.3.400.jpg"],
  [/\bezekiel\b.*\bbread\b/i, "local:public/swaps/bread.jpg"],
  [/\brao'?s\b.*\b(?:marinara|tomato\s+basil|arrabbiata|vodka\s+sauce|pasta\s+sauce)\b/i, "local:public/swaps/marinara.png"],
  [/\b(?:applegate|true\s+story)\b.*\borganic\b.*\bturkey\s+breast\b/i, "local:public/swaps/turkey.jpg"],
  [/\bchosen\s+foods\b.*\b(?:mayo|mayonnaise)\b/i, "local:public/swaps/mayo.png"],
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

const BLOCKED_ROTATED_OFF_IMAGE_RE =
  /\/10603499\/|\/468\/112\/060\/0422\/|\/009\/396\/600\/6469\/|\/022\/517\/201\/1436\/|\/002\/531\/700\/1106\/|\/002\/190\/811\/0110\/|\/074\/747\/900\/1199\//;

function headersForLocalAsset(relPath: string, contentType: string): Record<string, string> {
  const isPlaceholder = relPath === PLACEHOLDER_SVG_REL_PATH;
  return {
    "Content-Type": contentType,
    "Cache-Control": isPlaceholder ? "public, max-age=3600" : "public, max-age=86400",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "X-Image-Source, X-Image-License",
    "X-Image-Source": isPlaceholder
      ? "HeyBroc Placeholder (No Verified Package Photo)"
      : "HeyBroc Verified Product Photo",
    "X-Image-License": "Proprietary",
  };
}

async function serveLocalAsset(relPath: string, request: Request): Promise<NextResponse> {
  const contentType = relPath.endsWith(".svg")
    ? "image/svg+xml"
    : relPath.endsWith(".png")
      ? "image/png"
      : "image/jpeg";
  try {
    const buf = await fs.readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), relPath));
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: headersForLocalAsset(relPath, contentType),
    });
  } catch {
    const publicPath = relPath.replace(/^public/, "");
    return NextResponse.redirect(new URL(publicPath, request.url), 302);
  }
}

async function resolveRealProductImageUrl(rawQuery: string): Promise<string | null> {
  for (const [re, verifiedUrl] of VERIFIED_PRODUCT_IMAGES) {
    if (re.test(rawQuery)) {
      if (verifiedUrl.startsWith("local:") || !BLOCKED_ROTATED_OFF_IMAGE_RE.test(verifiedUrl)) {
        return verifiedUrl;
      }
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
      const offUrl = `https://search.openfoodfacts.org/search?q=${encodeURIComponent(searchQ)}&page_size=10&fields=code,product_name,product_name_en,brands,countries_tags,image_front_small_url,image_front_url`;
      const res = await fetch(offUrl, {
        headers: { "User-Agent": "HeyBroc/2.0 (https://www.heybroc.com)" },
        signal: AbortSignal.timeout(3800),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          hits?: Array<{
            code?: string;
            product_name?: string;
            product_name_en?: string;
            brands?: string | string[];
            countries_tags?: string[];
            image_front_small_url?: string;
            image_front_url?: string;
          }>;
        };
        const hits = (data.hits || []).slice().sort((a, b) => {
          const aUs = Array.isArray(a.countries_tags) && a.countries_tags.includes("en:united-states") ? 1 : 0;
          const bUs = Array.isArray(b.countries_tags) && b.countries_tags.includes("en:united-states") ? 1 : 0;
          return bUs - aUs;
        });
        let hit = hits.find((p) => {
          const imgCandidate = p.image_front_small_url || p.image_front_url;
          if (!imgCandidate || BLOCKED_ROTATED_OFF_IMAGE_RE.test(imgCandidate) || !isAllowedImageUrl(imgCandidate)) {
            return false;
          }
          const brandsStr = Array.isArray(p.brands) ? p.brands.join(" ") : p.brands || "";
          const candidateTitle = `${brandsStr} ${p.product_name_en || p.product_name || ""}`.trim();
          if (!passesVariantGuard(rawQuery, candidateTitle)) return false;
          return (
            hasProductIdentityMatch(conciseQuery, candidateTitle) ||
            hasProductIdentityMatch(rawQuery, candidateTitle)
          );
        });
        if (!hit) {
          const minOverlap = tokens.length >= 2 ? 2 : 1;
          hit = hits.find((p) => {
            const imgCandidate = p.image_front_small_url || p.image_front_url;
            if (!imgCandidate || BLOCKED_ROTATED_OFF_IMAGE_RE.test(imgCandidate) || !isAllowedImageUrl(imgCandidate)) {
              return false;
            }
            const brandsStr = Array.isArray(p.brands) ? p.brands.join(" ") : p.brands || "";
            const candidateTitle = `${brandsStr} ${p.product_name_en || p.product_name || ""}`.trim();
            if (!passesVariantGuard(rawQuery, candidateTitle)) return false;
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
      // Ignore and try next query or fall through to Yuka-style neutral placeholder
    }
  }

  return null;
}

export async function GET(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "anon";
  if (!(await checkRateLimitAsync(`img:${ip}`, 300))) {
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
  if (targetUrl?.startsWith("local:")) {
    return serveLocalAsset(targetUrl.slice("local:".length), request);
  }
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
      // Fall through to Yuka-style neutral missing-photo placeholder
    }
  }

  // Honest Yuka-style soft neutral rounded placeholder when no verified front-of-pack photo exists
  return serveLocalAsset(PLACEHOLDER_SVG_REL_PATH, request);
}

export async function HEAD(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "anon";
  if (!(await checkRateLimitAsync(`img:${ip}`, 300))) {
    return new NextResponse(null, { status: 429 });
  }
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || searchParams.get("title") || "").trim().slice(0, 160);
  if (!q) {
    return new NextResponse(null, { status: 400 });
  }
  const key = q.toLowerCase();
  const cachedBytes = imageBytesCache.get(key);
  if (cachedBytes) {
    return new NextResponse(null, {
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
  if (targetUrl) {
    if (targetUrl.startsWith("local:")) {
      const relPath = targetUrl.slice("local:".length);
      return new NextResponse(null, {
        status: 200,
        headers: headersForLocalAsset(relPath, relPath.endsWith(".png") ? "image/png" : "image/jpeg"),
      });
    }
    return new NextResponse(null, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=604800, immutable",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "X-Image-Source, X-Image-License",
        "X-Image-Source": `Open Food Facts (${targetUrl})`,
        "X-Image-License": "CC BY-SA 3.0 (https://world.openfoodfacts.org/terms-of-use)",
      },
    });
  }
  return new NextResponse(null, {
    status: 200,
    headers: headersForLocalAsset(PLACEHOLDER_SVG_REL_PATH, "image/svg+xml"),
  });
}
