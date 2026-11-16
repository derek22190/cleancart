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
  [/\b(?:applegate|true\s+story)\b.*\borganics?\b.*\bturkey\s+breast\b/i, "local:public/swaps/turkey.jpg"],
  [/\bchosen\s+foods\b.*\b(?:mayo|mayonnaise)\b/i, "local:public/swaps/mayo.png"],
  [/^(?!.*\b(?:cake|juice|soup)\b).*\b(?:baby\s+cut\s+carrots?|whole\s+carrots?|fresh\s+carrots?)\b/i, "https://images.openfoodfacts.org/images/products/003/582/608/6372/front_en.3.400.jpg"],
  [/^(?!.*\b(?:breast|salad|wings?|pulled|shredded|soup|broth|nuggets?|bites?)\b).*\brotisserie\s+chicken\b/i, "https://images.openfoodfacts.org/images/products/071/928/314/5598/front_en.10.400.jpg"],
  [/\bmember'?s\s+mark\b.*\b(?:breaded|southern\s+style|homestyle)\b.*\bchicken\b.*\bbites?\b/i, "local:public/swaps/nuggets.png"],
  [/\bmember'?s\s+mark\b(?!.*\b(?:turkey|bits|crumbled|wrapped|dip|macaroni)\b).*\bbacon\b/i, "local:public/swaps/bacon.png"],
  [/^(?!.*\b(?:roast\s+beef|deli|sliced|jerky|broth|soup|stew)\b).*\b(?:bottom\s+round|top\s+round|eye\s+of\s+round|chuck|rump|sirloin\s+tip)\s+roast\b/i, "local:public/swaps/beef.png"],
];

const STOP_TOKENS = new Set([
  "the", "and", "with", "for", "oz", "fl", "lb", "lbs", "ct", "count", "pack", "pk",
  "flavored", "flavor",
  "grade", "category", "estimate", "verify", "package", "label", "rating", "ratings",
  "sweeteners", "sweetener", "creamery", "fresh", "each", "average", "price", "priced", "per", "pound",
  "snack", "size", "family", "party", "share", "fun", "giant", "king", "bag", "box",
  "pouch", "jar", "bottle", "can", "carton", "candy", "bars", "bar", "gourmet", "gift",
  "energy", "drink", "drinks", "pre", "workout", "preworkout", "fitness", "live", "fit",
  "performance", "clean", "renewable", "original", "classic", "dressing",
  "ready", "soda", "pop", "soft", "shake", "squeezed", "pure", "natural", "naturally", "artesian",
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
  /\/10603499\/|\/468\/112\/060\/0422\/|\/009\/396\/600\/6469\/|\/022\/517\/201\/1436\/|\/002\/531\/700\/1106\/|\/002\/190\/811\/0110\/|\/074\/747\/900\/1199\/|\/019\/396\/833\/8879\/|\/007\/874\/226\/7043\/|\/007\/874\/200\/4709\//;

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

const deadOffUrlSet = new Set<string>();

/**
 * Known US retail bottle/box UPCs for iconic national brands so that if a hardcoded
 * Open Food Facts image revision (.7.400.jpg -> .29.400.jpg) ages out, /api/product-image
 * resolves the live front-of-pack photo from Open Food Facts v2 by barcode in one hop.
 */
const KNOWN_CURATED_FALLBACK_UPCS: Array<[RegExp, string[]]> = [
  [
    /\bhidden\s+valley\b(?!.*\b(?:fiesta|bacon|avocado|buffalo|chipotle|pickle|garlic|seasoning|packet|mix|dip\s+mix|light|fat\s*free|plant)\b).*\branch\b/i,
    ["0071100003116", "071100003116", "0071100883534", "071100883534", "0071100212068", "071100212068", "0071100004199"],
  ],
  [/\bheinz\b(?!.*\b(?:no\s+sugar|simply|organic|jalapeno|habanero|pickle)\b).*\bketchup\b/i, ["0013000006408", "013000006408", "0013000006057"]],
  [/\bhellmann'?s\b(?!.*\b(?:light|olive|avocado|vegan|plant|garlic|spicy)\b).*\b(?:real\s+)?(?:mayo|mayonnaise)\b/i, ["0048001213487", "048001213487", "0048001213562"]],
  [/\bjif\b(?!.*\b(?:crunchy|natural|no\s+added|reduced)\b).*\b(?:creamy\s+)?peanut\s+butter\b/i, ["0051500255162", "051500255162"]],
  [/\bfrench'?s\b(?!.*\b(?:honey|dijon|spicy|horseradish)\b).*\byellow\s+mustard\b/i, ["0041500000428", "041500000428"]],
  [/\bkraft\b.*\bmacaroni\s*(?:&|and)\s*cheese\b.*\boriginal\b/i, ["0021000033720", "021000033720", "0021000658831"]],
  [/\boreo\b(?!.*\b(?:mint|golden|double\s+stuf|peanut\s+butter|thins|lemon)\b).*\b(?:chocolate\s+sandwich\s+)?cookies?\b/i, ["0044000047009", "044000047009", "0044000032029"]],
  [/\bcheez[- ]?it\b.*\boriginal\b/i, ["0024100122615", "024100122615", "0024100440702"]],
  [/\bdoritos\b.*\bnacho\s+cheese\b/i, ["0028400090896", "028400090896", "0028400516464"]],
  [/\bdoritos\b.*\bcool\s+ranch\b/i, ["0028400091510", "028400091510", "0028400516310"]],
  [/\bcheerios\b(?!.*\b(?:honey\s+nut|multi\s+grain|apple|chocolate|frosted|berry|protein|oat\s+crunch)\b)/i, ["0016000275287", "016000275287"]],
  [/\bcoca[- ]?cola\b(?!.*\b(?:zero|diet|cherry|vanilla|caffeine[- ]?free|spiced)\b)/i, ["0049000028904", "049000028904"]],
];

function extractOffCodeFromImageUrl(rawUrl: string): string | null {
  const m = rawUrl.match(/\/images\/products\/([0-9/]+)\/front/i);
  if (!m?.[1]) return null;
  const digits = m[1].replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}

function expandBarcodeCandidates(codes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of codes) {
    const clean = raw.replace(/\D/g, "");
    if (clean.length < 8 || clean.length > 14) continue;
    const variants = [clean];
    if (clean.length === 12) variants.push(`0${clean}`);
    if (clean.length === 13 && clean.startsWith("0")) variants.push(clean.slice(1));
    for (const v of variants) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  return out.slice(0, 8);
}

interface OffImageProductRecord {
  code?: string;
  product_name?: string;
  product_name_en?: string;
  brands?: string | string[];
  countries_tags?: string[];
  image_front_small_url?: string;
  image_front_url?: string;
  image_url?: string;
  selected_images?: {
    front?: {
      display?: Record<string, string | undefined>;
      small?: Record<string, string | undefined>;
    };
  };
}

function pickCandidateImageUrls(p: OffImageProductRecord): string[] {
  const rawList = [
    p.selected_images?.front?.display?.en,
    p.selected_images?.front?.small?.en,
    p.image_front_small_url,
    p.image_front_url,
    p.image_url,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of rawList) {
    if (!u || seen.has(u)) continue;
    if (deadOffUrlSet.has(u) || BLOCKED_ROTATED_OFF_IMAGE_RE.test(u) || !isAllowedImageUrl(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

async function fetchAndVerifyImageBytes(
  candidateUrl: string,
): Promise<{ bytes: ArrayBuffer; contentType: string; sourceUrl: string } | null> {
  if (!candidateUrl || deadOffUrlSet.has(candidateUrl) || !isAllowedImageUrl(candidateUrl)) {
    return null;
  }
  try {
    const imgRes = await fetch(candidateUrl, {
      headers: { "User-Agent": "HeyBroc/2.1 (https://www.heybroc.com)" },
      signal: AbortSignal.timeout(4200),
    });
    if (!imgRes.ok) {
      if (imgRes.status === 404 || imgRes.status === 410) {
        if (deadOffUrlSet.size >= 1000) deadOffUrlSet.clear();
        deadOffUrlSet.add(candidateUrl);
      }
      return null;
    }
    const contentType = (imgRes.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    const contentLength = Number(imgRes.headers.get("content-length") || "0");
    if (
      !contentType.startsWith("image/") ||
      contentType.toLowerCase().includes("svg") ||
      (contentLength > 0 && contentLength > MAX_IMAGE_BYTES)
    ) {
      return null;
    }
    const bytes = await imgRes.arrayBuffer();
    if (bytes.byteLength <= 200 || bytes.byteLength > MAX_IMAGE_BYTES) {
      return null;
    }
    return { bytes, contentType, sourceUrl: candidateUrl };
  } catch {
    return null;
  }
}

const GENERIC_PACK_CATEGORY_WORDS = new Set([
  "dressing", "dressings", "condiment", "condiments", "topping", "dip",
  "baked", "snack", "snacks", "crackers", "cracker", "sandwich", "cookies", "cookie",
  "tortilla", "potato", "chips", "chip", "crisps", "cereal", "sweetened", "breakfast",
  "pasta", "macaroni", "sauce", "spread", "yogurt", "beverage", "beverages",
  "soda", "water", "milk", "juice", "cheese", "butter", "bread", "rolls", "buns",
  "grocery", "food", "foods", "creamy", "real",
]);

const CONFLICTING_PRODUCT_FORM_WORDS = [
  "seasoning", "packet", "packets", "mix", "powder", "shaker",
  "salad", "wings", "wing", "nuggets", "nugget", "tenders", "bites", "shredded", "pulled", "turkey",
  "dog", "cat", "puppy", "kitten", "shampoo", "conditioner", "lotion", "candle",
];

function brandTokensOf(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['’®™©]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => (t.length >= 2 || TWO_CHAR_BRAND_TOKENS.has(t)) && t !== "the" && t !== "and" && !/^\d+$/.test(t));
}

function matchesPackagePhotoCandidate(
  rawQuery: string,
  cleanQuery: string,
  conciseQuery: string,
  rawBrand: string,
  candidateBrands: string,
  candidateProductName: string,
): boolean {
  const candidateTitle = `${candidateBrands} ${candidateProductName}`.trim();
  if (!candidateTitle) return false;
  if (!passesVariantGuard(rawQuery, candidateTitle)) return false;

  // Never put an Organic package photo onto a non-organic query
  if (/\borganic\b/i.test(candidateTitle) && !/\borganic\b/i.test(rawQuery)) {
    return false;
  }

  const qLower = rawQuery.toLowerCase();
  const cLower = candidateTitle.toLowerCase();
  for (const formWord of CONFLICTING_PRODUCT_FORM_WORDS) {
    const re = new RegExp(`\\b${formWord}\\b`, "i");
    if (re.test(cLower) && !re.test(qLower)) {
      return false;
    }
  }

  if (
    hasProductIdentityMatch(conciseQuery, candidateTitle) ||
    hasProductIdentityMatch(cleanQuery, candidateTitle) ||
    hasProductIdentityMatch(rawQuery, candidateTitle)
  ) {
    return true;
  }

  // Front-of-pack label match: Open Food Facts entries frequently transcribe only what is printed largest
  // on the front bottle/box (e.g. brands="Hidden Valley", product_name="THE ORIGINAL Ranch", omitting
  // trailing grocery category nouns like "Salad Dressing", "Tortilla Chips", or "Sandwich Cookies").
  const candAllTokens = new Set(brandTokensOf(candidateTitle));
  const candBrandToks = brandTokensOf(candidateBrands);
  const queryAllToks = brandTokensOf(cleanQuery || rawQuery);
  if (queryAllToks.length === 0) return false;

  const usableExplicitBrand =
    rawBrand &&
    !/^(usda|fresh\s+produce|fresh\s+meat|whole\s+nuts|category\s+estimate|scanned\s+product)/i.test(rawBrand)
      ? brandTokensOf(rawBrand)
      : [];

  const requiredBrandToks =
    usableExplicitBrand.length > 0 ? usableExplicitBrand.slice(0, 2) : queryAllToks.slice(0, 1);

  if (requiredBrandToks.length === 0 || !requiredBrandToks.every((bt) => candAllTokens.has(bt))) {
    return false;
  }

  // Prevent cross-brand collisions: if OFF specifies a brand, its leading token must appear in the query or brand
  if (candBrandToks.length > 0) {
    const qBrandUnion = new Set([...queryAllToks, ...usableExplicitBrand]);
    if (!qBrandUnion.has(candBrandToks[0])) {
      return false;
    }
  }

  const brandSet = new Set(requiredBrandToks);
  const nonBrandDistinctive = distinctiveTokens(cleanQuery || rawQuery).filter((t) => !brandSet.has(t));
  const coreProductToks = nonBrandDistinctive.filter((t) => !GENERIC_PACK_CATEGORY_WORDS.has(t));

  if (coreProductToks.length === 0) {
    // Brand-iconic product whose remaining words are purely category nouns (e.g., "Oreo Chocolate Sandwich Cookies")
    if (usableExplicitBrand.length === 0 && candBrandToks.length === 0) return false;
    const anyCategoryOverlap = nonBrandDistinctive.some((t) => candAllTokens.has(t));
    return anyCategoryOverlap || (candBrandToks.length > 0 && requiredBrandToks.every((bt) => candBrandToks.includes(bt)));
  }

  const matchedCore = coreProductToks.filter((t) => candAllTokens.has(t)).length;
  const neededCore = coreProductToks.length >= 3 ? Math.ceil(coreProductToks.length * 0.6) : coreProductToks.length;
  return matchedCore >= neededCore;
}

async function fetchVerifiedImageByBarcodes(
  codes: string[],
  rawQuery: string,
  trustExactScannedCode = false,
): Promise<{ bytes: ArrayBuffer; contentType: string; sourceUrl: string } | null> {
  const expanded = expandBarcodeCandidates(codes);
  for (const code of expanded) {
    try {
      const v2Url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=code,product_name,product_name_en,brands,selected_images,image_front_url,image_front_small_url,image_url`;
      const res = await fetch(v2Url, {
        headers: { "User-Agent": "HeyBroc/2.1 (https://www.heybroc.com)" },
        signal: AbortSignal.timeout(3600),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { status?: number; product?: OffImageProductRecord };
      if (data.status !== 1 || !data.product) continue;
      const p = data.product;
      if (rawQuery && !trustExactScannedCode) {
        const brandsStr = Array.isArray(p.brands) ? p.brands.join(" ") : p.brands || "";
        const candidateTitle = `${brandsStr} ${p.product_name_en || p.product_name || ""}`.trim();
        if (candidateTitle && /\borganic\b/i.test(candidateTitle) && !/\borganic\b/i.test(rawQuery)) {
          continue;
        }
      }
      const urls = pickCandidateImageUrls(p);
      for (const candidateUrl of urls) {
        const verified = await fetchAndVerifyImageBytes(candidateUrl);
        if (verified) return verified;
      }
    } catch {
      // Try next barcode variant
    }
  }
  return null;
}

type ResolvedProductMedia =
  | { kind: "local"; relPath: string }
  | { kind: "remote"; bytes: ArrayBuffer; contentType: string; sourceUrl: string }
  | { kind: "placeholder" };

async function resolveVerifiedProductMedia(
  rawQuery: string,
  rawCode: string,
  rawBrand: string,
): Promise<ResolvedProductMedia> {
  const cacheKey = `${rawQuery.toLowerCase()}|${rawCode}|${rawBrand.toLowerCase()}`;
  const cachedBytes = imageBytesCache.get(cacheKey);
  if (cachedBytes) {
    return { kind: "remote", ...cachedBytes };
  }

  const storeInBytesCache = (entry: { bytes: ArrayBuffer; contentType: string; sourceUrl: string }) => {
    if (!imageBytesCache.has(cacheKey)) {
      while (imageBytesCache.size >= 350) {
        const oldest = imageBytesCache.keys().next().value;
        if (oldest === undefined) break;
        imageBytesCache.delete(oldest);
      }
    }
    imageBytesCache.set(cacheKey, entry);
  };

  // 1. Curated verified matches (instant local swap studio photos or self-healing Open Food Facts URLs)
  if (rawQuery) {
    for (const [re, verifiedUrl] of VERIFIED_PRODUCT_IMAGES) {
      if (re.test(rawQuery)) {
        if (verifiedUrl.startsWith("local:")) {
          return { kind: "local", relPath: verifiedUrl.slice("local:".length) };
        }
        if (!BLOCKED_ROTATED_OFF_IMAGE_RE.test(verifiedUrl)) {
          const directBytes = await fetchAndVerifyImageBytes(verifiedUrl);
          if (directBytes) {
            storeInBytesCache(directBytes);
            return { kind: "remote", ...directBytes };
          }
          // Self-heal if Open Food Facts incremented the image revision (.7.400.jpg -> .29.400.jpg)
          const recoveryCodes: string[] = [];
          const embeddedCode = extractOffCodeFromImageUrl(verifiedUrl);
          if (embeddedCode) recoveryCodes.push(embeddedCode);
          for (const [upcRe, upcs] of KNOWN_CURATED_FALLBACK_UPCS) {
            if (upcRe.test(rawQuery)) recoveryCodes.push(...upcs);
          }
          if (recoveryCodes.length > 0) {
            const healed = await fetchVerifiedImageByBarcodes(recoveryCodes, rawQuery);
            if (healed) {
              storeInBytesCache(healed);
              return { kind: "remote", ...healed };
            }
          }
        }
        break;
      }
    }
  }

  // 2. Direct UPC / GTIN barcode lookup (USDA FoodData Central gtinUpc, Open Food Facts code, or hardware barcode scan)
  const barcodeQueue: string[] = [];
  if (rawCode.length >= 8 && rawCode.length <= 14) {
    barcodeQueue.push(rawCode);
  }
  if (rawQuery) {
    for (const [upcRe, upcs] of KNOWN_CURATED_FALLBACK_UPCS) {
      if (upcRe.test(rawQuery)) {
        barcodeQueue.push(...upcs);
      }
    }
  }
  if (barcodeQueue.length > 0) {
    const byCode = await fetchVerifiedImageByBarcodes(barcodeQueue, rawQuery, rawCode.length >= 8);
    if (byCode) {
      storeInBytesCache(byCode);
      return { kind: "remote", ...byCode };
    }
  }

  if (!rawQuery) {
    return { kind: "placeholder" };
  }

  // 3. Clean title & query Open Food Facts Search v3 + v2 CGI fallback across 5M+ global/US foods
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

  const urlCacheKey = `${clean.toLowerCase()}|${rawCode}|${rawBrand.toLowerCase()}`;
  const cachedUrl = imageUrlCache.get(urlCacheKey);
  if (cachedUrl) {
    const verifiedCached = await fetchAndVerifyImageBytes(cachedUrl);
    if (verifiedCached) {
      storeInBytesCache(verifiedCached);
      return { kind: "remote", ...verifiedCached };
    }
    imageUrlCache.delete(urlCacheKey);
  }

  const tokens = distinctiveTokens(clean);
  if (tokens.length < 1) {
    return { kind: "placeholder" };
  }

  const conciseQuery = tokens.slice(0, 4).join(" ");
  const coreWithoutGenericCategory = tokens.filter((t, idx) => idx === 0 || !GENERIC_PACK_CATEGORY_WORDS.has(t)).slice(0, 4).join(" ");
  const queriesToTry: string[] = [];
  const pushQuery = (qStr: string) => {
    const trimmed = qStr.trim();
    if (trimmed && !queriesToTry.includes(trimmed)) queriesToTry.push(trimmed);
  };

  pushQuery(conciseQuery);
  if (coreWithoutGenericCategory && coreWithoutGenericCategory !== conciseQuery) {
    pushQuery(coreWithoutGenericCategory);
  }
  if (clean.toLowerCase() !== conciseQuery) {
    pushQuery(clean);
  }
  if (tokens.length >= 3) {
    pushQuery(`brands_tags:"${tokens[0]}-${tokens[1]}" ${tokens.slice(2, 5).join(" ")}`);
  }
  if (tokens.length >= 2) {
    pushQuery(`brands_tags:"${tokens[0]}" ${tokens.slice(1, 4).join(" ")}`);
  }

  const sortUsFirst = (list: OffImageProductRecord[]) =>
    list.slice().sort((a, b) => {
      const aUs = Array.isArray(a.countries_tags) && a.countries_tags.includes("en:united-states") ? 1 : 0;
      const bUs = Array.isArray(b.countries_tags) && b.countries_tags.includes("en:united-states") ? 1 : 0;
      return bUs - aUs;
    });

  const verifyMatchingHits = async (hits: OffImageProductRecord[]) => {
    const sorted = sortUsFirst(hits);
    for (const p of sorted) {
      const urls = pickCandidateImageUrls(p);
      if (urls.length === 0) continue;
      const brandsStr = Array.isArray(p.brands) ? p.brands.join(" ") : p.brands || "";
      const prodName = p.product_name_en || p.product_name || "";
      if (!matchesPackagePhotoCandidate(rawQuery, clean, conciseQuery, rawBrand, brandsStr, prodName)) {
        continue;
      }
      for (const candidateUrl of urls) {
        const verified = await fetchAndVerifyImageBytes(candidateUrl);
        if (verified) {
          if (imageUrlCache.size >= 1000) {
            const oldest = imageUrlCache.keys().next().value;
            if (oldest !== undefined) imageUrlCache.delete(oldest);
          }
          imageUrlCache.set(urlCacheKey, candidateUrl);
          storeInBytesCache(verified);
          return verified;
        }
      }
    }
    return null;
  };

  // OpenFoodFacts Search-a-licious v3 open-licensed product image lookup (ODbL / CC-BY-SA 3.0)
  for (const searchQ of queriesToTry.slice(0, 4)) {
    try {
      const offUrl = `https://search.openfoodfacts.org/search?q=${encodeURIComponent(searchQ)}&page_size=14&fields=code,product_name,product_name_en,brands,countries_tags,image_front_small_url,image_front_url,selected_images`;
      const res = await fetch(offUrl, {
        headers: { "User-Agent": "HeyBroc/2.1 (https://www.heybroc.com)" },
        signal: AbortSignal.timeout(3800),
      });
      if (res.ok) {
        const data = (await res.json()) as { hits?: OffImageProductRecord[] };
        const matched = await verifyMatchingHits(data.hits || []);
        if (matched) {
          return { kind: "remote", ...matched };
        }
      }
    } catch {
      // Try next query or fall back to OFF v2 CGI search
    }
  }

  // Fallback: Open Food Facts v2 CGI search (handles exact US brand + front-label phrases when Search v3 lags)
  const cgiTerms = coreWithoutGenericCategory || conciseQuery;
  if (cgiTerms) {
    try {
      const cgiUrl = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(cgiTerms)}&search_simple=1&action=process&json=1&page_size=14&fields=code,product_name,product_name_en,brands,countries_tags,image_front_small_url,image_front_url,selected_images`;
      const res = await fetch(cgiUrl, {
        headers: { "User-Agent": "HeyBroc/2.1 (https://www.heybroc.com)" },
        signal: AbortSignal.timeout(3800),
      });
      if (res.ok) {
        const data = (await res.json()) as { products?: OffImageProductRecord[] };
        const matched = await verifyMatchingHits(data.products || []);
        if (matched) {
          return { kind: "remote", ...matched };
        }
      }
    } catch {
      // Fall through to honest Yuka-style neutral missing-photo placeholder
    }
  }

  return { kind: "placeholder" };
}

function offAttributionHeaders(contentType: string, sourceUrl: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=604800, immutable",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "X-Image-Source, X-Image-License",
    "X-Image-Source": `Open Food Facts (${sourceUrl})`,
    "X-Image-License": "CC BY-SA 3.0 (https://world.openfoodfacts.org/terms-of-use)",
  };
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
  const rawCode = (searchParams.get("code") || searchParams.get("barcode") || "").replace(/\D/g, "").slice(0, 14);
  const rawBrand = (searchParams.get("brand") || "").trim().slice(0, 80);
  if (!q && rawCode.length < 8) {
    return new NextResponse("Missing query", { status: 400 });
  }

  const resolved = await resolveVerifiedProductMedia(q, rawCode, rawBrand);
  if (resolved.kind === "local") {
    return serveLocalAsset(resolved.relPath, request);
  }
  if (resolved.kind === "remote") {
    return new NextResponse(resolved.bytes, {
      status: 200,
      headers: offAttributionHeaders(resolved.contentType, resolved.sourceUrl),
    });
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
  const rawCode = (searchParams.get("code") || searchParams.get("barcode") || "").replace(/\D/g, "").slice(0, 14);
  const rawBrand = (searchParams.get("brand") || "").trim().slice(0, 80);
  if (!q && rawCode.length < 8) {
    return new NextResponse(null, { status: 400 });
  }

  const resolved = await resolveVerifiedProductMedia(q, rawCode, rawBrand);
  if (resolved.kind === "local") {
    const relPath = resolved.relPath;
    return new NextResponse(null, {
      status: 200,
      headers: headersForLocalAsset(relPath, relPath.endsWith(".png") ? "image/png" : "image/jpeg"),
    });
  }
  if (resolved.kind === "remote") {
    return new NextResponse(null, {
      status: 200,
      headers: offAttributionHeaders(resolved.contentType, resolved.sourceUrl),
    });
  }
  return new NextResponse(null, {
    status: 200,
    headers: headersForLocalAsset(PLACEHOLDER_SVG_REL_PATH, "image/svg+xml"),
  });
}
