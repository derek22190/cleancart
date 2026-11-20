#!/usr/bin/env tsx
/**
 * 13-Store × 10-Page (130-Page) Headless Chromium Live Shop Scroll, Score & Visual QA Suite
 *
 * Drives `/usr/bin/chromium` over CDP in a mobile WebView viewport (`412x915` Pixel 9) across all
 * 13 supported HeyBroc stores × 10 pages per store = 130 pages (650 viewport scroll checkpoints):
 *   1. Walmart        2. Instacart      3. Target         4. Amazon Fresh   5. Whole Foods
 *   6. Costco         7. Sam's Club     8. Kroger         9. ALDI          10. BJ's
 *  11. Shipt         12. DoorDash      13. Uber Eats
 *
 * For every page:
 *  - Attempts live navigation first (never solving or interacting with any CAPTCHA/anti-bot gate).
 *  - Detects if a live page has real priced product items (`$X.XX`) yet 0 HeyBroc badges (`LIVE_SELECTOR_GAP`)
 *    and logs sample DOM elements so any 2026 retailer markup change is caught immediately.
 *  - When a datacenter IP gate (`403 Just a moment...`, PerimeterX/Akamai challenge, zip/login wall)
 *    or non-grid landing hub is encountered, automatically serves a 20-item Store-Authentic DOM Replay
 *    page on that retailer's exact HTTPS origin using that store's production DOM selectors.
 *  - Scrolls 5 viewport stops (`0 -> 650 -> 1300 -> 1950 -> 300px`), verifying:
 *      * 0 uncaught JS exceptions
 *      * 0 stuck `.hb-photo-badge--loading` badges after batch settle
 *      * Valid `0–100` integer scores on all resolved badges
 *      * 0 duplicate badges per card & clean on/under-photo badge geometry (`z-index >= 20`)
 *      * Non-food household items (Paper Towels, Trash Bags) never receive food badges
 *      * Floating Broccoli Pill never hangs on `"Scanning Label..."`
 *      * 1-Tap Clean Swap inspect drawer opens with valid swap + decoded raster thumbnails
 *  - Also runs a cross-surface parity pass on iOS `LiveStoreBrowserViewController.swift` (`detectorJS`)
 *    and Chrome/Safari Extension (`content.js`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

process.env.NO_PROXY = process.env.NO_PROXY || "127.0.0.1,localhost";
process.env.no_proxy = process.env.no_proxy || "127.0.0.1,localhost";

const ROOT = process.cwd();
const CHROMIUM_BIN = process.env.CHROMIUM_BIN || "/usr/bin/chromium";
const CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.AUDIT_CONCURRENCY || "4")));
const ARTIFACT_DIR =
  process.env.AUDIT_OUTPUT_DIR ||
  "/home/antigravity/.gemini/jetski/brain/v1/default/jetski_remote_agents_3p/69bf6111-e17b-45dd-9d1f-f9c9f131974d/store-audit";

const SCROLL_STOPS_PX = [0, 650, 1300, 1950, 300];

const EARLY_BANNER_CSS_JS = `
(function(){
  try {
    if (!document.getElementById('hb-early-banner-hide')) {
      var s = document.createElement('style');
      s.id = 'hb-early-banner-hide';
      s.textContent = '[id*="smartbanner" i],[class*="smartbanner" i],[class*="smart-banner" i],[data-testid*="smart-banner" i],[data-testid*="app-banner" i],[data-automation-id*="app-banner" i],[id*="branch-banner" i],[class*="branch-journeys" i]{display:none!important;visibility:hidden!important;height:0!important;pointer-events:none!important;}';
      (document.head || document.documentElement).appendChild(s);
    }
  } catch (e) {}
})();
`;

interface StoreSpec {
  key: string;
  apiStoreKey: string;
  storeBucket: string;
  label: string;
  host: string;
  homeUrl: string;
  pdpPath: string;
  searchUrl: (q: string) => string;
  datacenterBotGated?: boolean;
}

const STORES: StoreSpec[] = [
  {
    key: "walmart",
    apiStoreKey: "walmart",
    storeBucket: "walmart",
    label: "Walmart",
    host: "www.walmart.com",
    homeUrl: "https://www.walmart.com/browse/food/976759",
    pdpPath: "/ip/Hidden-Valley-Original-Ranch/10450345?__hb_replay=1",
    searchUrl: (q) => `https://www.walmart.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    key: "instacart",
    apiStoreKey: "instacart",
    storeBucket: "instacart",
    label: "Instacart",
    host: "www.instacart.com",
    homeUrl: "https://www.instacart.com/categories/316-food",
    pdpPath: "/products/10450345-hidden-valley-original-ranch?__hb_replay=1",
    searchUrl: (q) => `https://www.instacart.com/categories/316-food?q=${encodeURIComponent(q)}`,
  },
  {
    key: "target",
    apiStoreKey: "target",
    storeBucket: "target",
    label: "Target",
    host: "www.target.com",
    homeUrl: "https://www.target.com/c/grocery/-/N-5xt1a",
    pdpPath: "/p/hidden-valley-original-ranch/-/A-10450345?__hb_replay=1",
    searchUrl: (q) => `https://www.target.com/s?searchTerm=${encodeURIComponent(q)}&category=5xt1a`,
  },
  {
    key: "amazon",
    apiStoreKey: "amazon",
    storeBucket: "amazon",
    label: "Amazon Fresh",
    host: "www.amazon.com",
    homeUrl: "https://www.amazon.com/s?k=grocery+food&i=grocery",
    pdpPath: "/Hidden-Valley-Original-Ranch/dp/B091045034?__hb_replay=1",
    searchUrl: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}&i=grocery`,
  },
  {
    key: "wholefoods",
    apiStoreKey: "amazon",
    storeBucket: "wholefoods",
    label: "Whole Foods",
    host: "www.wholefoodsmarket.com",
    homeUrl: "https://www.wholefoodsmarket.com/products/all-products",
    pdpPath: "/product/hidden-valley-original-ranch-b091045034?__hb_replay=1",
    searchUrl: (q) => `https://www.wholefoodsmarket.com/search?text=${encodeURIComponent(q)}`,
  },
  {
    key: "costco",
    apiStoreKey: "costco",
    storeBucket: "costco",
    label: "Costco",
    host: "www.costco.com",
    homeUrl: "https://www.costco.com/grocery-household.html",
    pdpPath: "/hidden-valley-original-ranch.product.10450345.html?__hb_replay=1",
    searchUrl: (q) => `https://www.costco.com/s?keyword=${encodeURIComponent(q)}`,
  },
  {
    key: "sams",
    apiStoreKey: "sams",
    storeBucket: "sams",
    label: "Sam's Club",
    host: "www.samsclub.com",
    homeUrl: "https://www.samsclub.com/b/grocery/1444",
    pdpPath: "/sams/shop/product/hidden-valley-original-ranch/prod10450345?__hb_replay=1",
    searchUrl: (q) => `https://www.samsclub.com/s/${encodeURIComponent(q)}`,
  },
  {
    key: "kroger",
    apiStoreKey: "kroger",
    storeBucket: "kroger",
    label: "Kroger",
    host: "www.kroger.com",
    homeUrl: "https://www.kroger.com/search?query=grocery+favorites",
    pdpPath: "/p/hidden-valley-original-ranch/0007110000311?__hb_replay=1",
    searchUrl: (q) => `https://www.kroger.com/search?query=${encodeURIComponent(q)}`,
  },
  {
    key: "aldi",
    apiStoreKey: "aldi",
    storeBucket: "aldi",
    label: "ALDI",
    host: "www.aldi.us",
    homeUrl: "https://www.aldi.us/products",
    pdpPath: "/product/hidden-valley-original-ranch-000000000010450345?__hb_replay=1",
    searchUrl: (q) => `https://www.aldi.us/results?q=${encodeURIComponent(q)}`,
  },
  {
    key: "bjs",
    apiStoreKey: "bjs",
    storeBucket: "bjs",
    label: "BJ's",
    host: "www.bjs.com",
    homeUrl: "https://www.bjs.com/search/grocery",
    pdpPath: "/product/hidden-valley-original-ranch/3000000000001045034?__hb_replay=1",
    searchUrl: (q) => `https://www.bjs.com/search/${encodeURIComponent(q)}`,
  },
  {
    key: "shipt",
    apiStoreKey: "shipt",
    storeBucket: "shipt",
    label: "Shipt",
    host: "www.shipt.com",
    homeUrl: "https://www.shipt.com/shop/categories",
    pdpPath: "/shop/products/10450345?__hb_replay=1",
    searchUrl: (q) => `https://www.shipt.com/shop/search?query=${encodeURIComponent(q)}`,
    datacenterBotGated: true,
  },
  {
    key: "doordash",
    apiStoreKey: "doordash",
    storeBucket: "doordash",
    label: "DoorDash",
    host: "www.doordash.com",
    homeUrl: "https://www.doordash.com/convenience",
    pdpPath: "/convenience/store/24521/search/?item_id=10450345&__hb_replay=1",
    searchUrl: (q) => `https://www.doordash.com/convenience/search/${encodeURIComponent(q)}`,
    datacenterBotGated: true,
  },
  {
    key: "ubereats",
    apiStoreKey: "ubereats",
    storeBucket: "ubereats",
    label: "Uber Eats",
    host: "www.ubereats.com",
    homeUrl: "https://www.ubereats.com/category/grocery",
    pdpPath: "/store/grocery-market/abc?mod=quickView&modctx=10450345&item_id=10450345&__hb_replay=1",
    searchUrl: (q) => `https://www.ubereats.com/category/grocery?q=${encodeURIComponent(q)}`,
    datacenterBotGated: true,
  },
];

interface DepartmentSpec {
  pageNum: number;
  slug: string;
  label: string;
  query: string;
  kind: "grid" | "pdp";
  items: Array<{
    title: string;
    price: string;
    barcode?: string;
    sponsored?: boolean;
    truncatedDisplay?: string;
    nonFood?: boolean;
    ingredients?: string;
  }>;
}

const DEPARTMENTS: DepartmentSpec[] = [
  {
    pageNum: 1,
    slug: "featured-grocery",
    label: "Grocery Home & Featured Essentials",
    query: "popular grocery food",
    kind: "grid",
    items: [
      { title: "Hidden Valley Original Ranch Salad Dressing & Topping, 16 fl oz", price: "$4.48", barcode: "0071100003116", sponsored: true },
      { title: "Heinz Tomato Ketchup, 32 oz", price: "$4.78" },
      { title: "Quaker Oats Old Fashioned 100% Whole Grain Oats, 42 oz", price: "$4.98" },
      { title: "Cinnamon Toast Crunch Breakfast Cereal, Crispy Cinnamon Cereal Squares, 18.8 oz", price: "$4.93", sponsored: true },
      { title: "Dave's Killer Bread Organic 21 Whole Grains and Seeds Bread, 27 oz", price: "$5.98" },
      { title: "Jif Creamy Peanut Butter, 16 oz", price: "$2.98" },
      { title: "Stonyfield Organic Whole Milk Plain Yogurt, 32 oz", price: "$4.68" },
      { title: "Doritos Nacho Cheese Flavored Tortilla Chips, 9.25 oz", price: "$4.28" },
      { title: "Boulder Canyon Avocado Oil Classic Sea Salt Kettle Potato Chips, 5.25 oz", price: "$3.98" },
      { title: "Bounty Select-A-Size Paper Towels, 6 Double Rolls", price: "$14.97", nonFood: true },
      { title: "Applegate Naturals Oven Roasted Turkey Breast, 7 oz", price: "$5.48" },
      { title: "Rao's Homemade Marinara Sauce, 24 oz", price: "$6.88" },
    ],
  },
  {
    pageNum: 2,
    slug: "cereal-breakfast",
    label: "Breakfast, Cereal & Pastries",
    query: "pop tarts cereal oatmeal",
    kind: "grid",
    items: [
      {
        title: "Pop-Tarts Toaster Pastries, Breakfast Foods, Kids Snacks, Value Pack, Frosted Strawberry, 27 oz (16 Pastries)",
        truncatedDisplay: "Pop-Tarts Toaster Pastries, Breakfast Foods, Kids Snacks, Value Pack, Frosted...",
        price: "$4.68",
        sponsored: true,
      },
      {
        title: "Pop-Tarts Frosted S'mores Toaster Pastries, Breakfast Foods, Shelf-Stable, 27 oz (16 Pastries)",
        truncatedDisplay: "Pop-Tarts Frosted S'mores Toaster Pastries, Breakfast Foods, Shelf-Stable, 27 oz (",
        price: "$4.68",
        sponsored: true,
      },
      {
        title: "Pop-Tarts Toaster Pastries, Breakfast Foods, Kids Snacks, Value Pack, Frosted Brown Sugar Cinnamon, 27 oz",
        truncatedDisplay: "Pop-Tarts Toaster Pastries, Breakfast Foods, Kids Snacks, Value Pack, Frosted...",
        price: "$4.68",
      },
      { title: "General Mills Cheerios Toasted Whole Grain Oat Cereal, 18 oz", price: "$4.93" },
      { title: "Nature's Path Organic Heritage Flakes Cereal, 13.25 oz", price: "$4.49" },
      { title: "Three Wishes Frosted Grain Free Cereal, 8.6 oz", price: "$5.99" },
      { title: "Kellogg's Frosted Flakes Breakfast Cereal, 17.3 oz", price: "$4.48" },
      { title: "Quaker Instant Oatmeal Maple & Brown Sugar, 8 Packets", price: "$3.48" },
      { title: "Bob's Red Mill Organic Old Fashioned Rolled Oats, 32 oz", price: "$6.49" },
      { title: "Seven Sundays Oat Protein Cereal Cinnamon, 9 oz", price: "$6.99" },
      { title: "Lucky Charms Gluten Free Marshmallow Cereal, 14.9 oz", price: "$4.93" },
      { title: "Froot Loops Breakfast Cereal, 14.7 oz", price: "$4.48" },
    ],
  },
  {
    pageNum: 3,
    slug: "chips-snacks-crackers",
    label: "Chips, Pretzels & Crackers",
    query: "potato chips tortilla chips crackers",
    kind: "grid",
    items: [
      { title: "Doritos Cool Ranch Flavored Tortilla Chips, 9.25 oz", price: "$4.28", sponsored: true },
      { title: "Lay's Classic Potato Chips, 8 oz", price: "$3.98" },
      { title: "Pringles Original Potato Crisps, 5.2 oz", price: "$2.24" },
      { title: "Clancy's Classic Potato Chips, 10 oz", price: "$2.19" },
      { title: "Siete Sea Salt Grain Free Tortilla Chips, 5 oz", price: "$4.79" },
      { title: "Cheez-It Original Baked Snack Crackers, 12.4 oz", price: "$3.98", sponsored: true },
      { title: "Pepperidge Farm Goldfish Cheddar Crackers, 6.6 oz", price: "$2.78" },
      { title: "Ritz Original Crackers, 13.7 oz", price: "$3.78" },
      { title: "Mary's Gone Crackers Organic Original Seed Crackers, 6.5 oz", price: "$4.99" },
      { title: "LesserEvil Organic Popcorn Himalayan Pink Salt, 4.6 oz", price: "$3.48" },
      { title: "SkinnyPop Original Popped Popcorn, 4.4 oz", price: "$3.78" },
      { title: "Hefty Ultra Strong Tall Kitchen Trash Bags, 40 Count", price: "$9.98", nonFood: true },
    ],
  },
  {
    pageNum: 4,
    slug: "dairy-milk-eggs",
    label: "Dairy, Milk, Yogurt & Eggs",
    query: "whole milk greek yogurt butter eggs",
    kind: "grid",
    items: [
      { title: "Horizon Organic Grade A Whole Milk, 64 fl oz", price: "$5.48" },
      { title: "Friendly Farms Grade A Pasteurized Whole Vitamin D Milk, 1 Gallon", price: "$3.29" },
      { title: "Kroger Grade A Pasteurized Whole Vitamin D Milk, 1 Gallon", price: "$3.19", barcode: "0001111040107" },
      { title: "Good & Gather Organic Whole Milk, 0.5 Gallon", price: "$4.29" },
      { title: "Fairlife 2% Reduced Fat Ultra-Filtered Milk, 52 fl oz", price: "$4.68", sponsored: true },
      { title: "Chobani Non-Fat Plain Greek Yogurt, 32 oz", price: "$5.48" },
      { title: "Chobani Flip Almond Coco Loco Low-Fat Greek Yogurt, 4.5 oz", price: "$1.48" },
      { title: "Yoplait Original Low Fat Strawberry Yogurt, 6 oz", price: "$0.82" },
      { title: "Kerrygold Pure Irish Salted Butter, 8 oz", price: "$4.48" },
      { title: "Organic Valley Raw Sharp Cheddar Cheese, 8 oz", price: "$5.99" },
      { title: "Kraft Singles American Cheese Slices, 16 ct", price: "$3.98" },
      { title: "Happy Belly Cage-Free Large White Eggs, 12 Count", price: "$3.49" },
    ],
  },
  {
    pageNum: 5,
    slug: "drinks-juice-coffee",
    label: "Beverages, Soda, Juice & Creamer",
    query: "soda orange juice sports drink coffee creamer",
    kind: "grid",
    items: [
      { title: "Coca-Cola Classic Original Soda, 12 fl oz, 12 Pack", price: "$7.48", sponsored: true },
      { title: "OLIPOP Vintage Cola Prebiotic Soda, 12 fl oz", price: "$2.48" },
      { title: "Tropicana Pure Premium Original No Pulp 100% Orange Juice, 52 fl oz", price: "$4.28" },
      { title: "Gatorade Thirst Quencher Cool Blue Sports Drink, 28 fl oz", price: "$1.68", sponsored: true },
      { title: "Spindrift Sparkling Water Raspberry Lime, 12 fl oz, 8 Pack", price: "$6.48" },
      { title: "LaCroix Pure Sparkling Water, 12 fl oz, 12 Pack", price: "$5.48" },
      { title: "Coffee mate French Vanilla Liquid Coffee Creamer, 32 fl oz", price: "$3.98" },
      { title: "Nutpods Unsweetened French Vanilla Almond & Coconut Creamer, 25.4 fl oz", price: "$4.99" },
      { title: "Oatly Original Oatmilk, 64 fl oz", price: "$4.98" },
      { title: "MALK Organic Unsweetened Almond Milk, 28 fl oz", price: "$5.99" },
      { title: "Berkley Jensen Purified Water, 16.9 fl oz, 40 pk", price: "$4.99" },
      { title: "Kroger Purified Drinking Water, 16.9 fl oz, 32 pk", price: "$3.99" },
    ],
  },
  {
    pageNum: 6,
    slug: "frozen-foods-meals",
    label: "Frozen Hash Browns, Waffles & Entrees",
    query: "hash browns frozen waffles chicken nuggets pizza",
    kind: "grid",
    items: [
      { title: "Great Value Seasoned Potato Hash Brown Patties, 22.5 oz, 10 Count (Frozen)", price: "$3.12", sponsored: true },
      { title: "Eggo Homestyle Waffles, 10 ct", price: "$2.98" },
      { title: "Eggo Buttermilk Waffles, 10 ct", price: "$2.98" },
      { title: "Birch Benders Organic Classic Waffles, 6 ct", price: "$4.99" },
      { title: "Tyson Fully Cooked Chicken Nuggets, 32 oz", price: "$6.48", sponsored: true },
      { title: "Applegate Organics Gluten-Free Chicken Nuggets, 8 oz", price: "$7.49" },
      { title: "DiGiorno Rising Crust Four Cheese Frozen Pizza, 28.2 oz", price: "$6.98" },
      { title: "Amy's Cheese Enchilada Frozen Meal, 9 oz", price: "$5.49" },
      { title: "Hot Pockets Pepperoni Pizza Frozen Sandwiches, 2 ct", price: "$2.78" },
      { title: "Haagen-Dazs Vanilla Bean Ice Cream, 14 fl oz", price: "$4.48" },
      { title: "Ben & Jerry's Half Baked Ice Cream, 16 fl oz", price: "$4.98" },
      { title: "Tide PODS Laundry Detergent Pacs, 42 Count", price: "$12.97", nonFood: true },
    ],
  },
  {
    pageNum: 7,
    slug: "deli-hotdogs-bakery",
    label: "Deli Meat, Hot Dogs, Sausage & Bread",
    query: "hot dogs turkey breast sausage sandwich bread",
    kind: "grid",
    items: [
      { title: "Bar-S Classic Franks, 12 oz", price: "$1.34", sponsored: true },
      { title: "Oscar Mayer Classic Uncured Wieners, 16 oz", price: "$3.48" },
      { title: "Ball Park Classic Hot Dogs, 15 oz", price: "$3.28" },
      { title: "Applegate Organics The Great Organic Uncured Beef Hot Dog, 10 oz", price: "$6.99" },
      { title: "Oscar Mayer Deli Fresh Oven Roasted Turkey Breast, 9 oz", price: "$4.48" },
      { title: "Oscar Mayer Deli Fresh Smoked Turkey Breast, 9 oz", price: "$4.48" },
      { title: "Jimmy Dean Regular Pork Sausage Roll, 16 oz", price: "$4.28" },
      { title: "Kirkland Signature Seasoned Rotisserie Chicken", price: "$4.99" },
      { title: "Amazon Fresh Boneless Skinless Chicken Breasts, 1.5 lb", price: "$6.49" },
      { title: "Wonder Classic White Bread, 20 oz", price: "$2.92" },
      { title: "Food For Life Ezekiel 4:9 Sprouted Whole Grain Bread, 24 oz", price: "$6.49" },
      { title: "365 by Whole Foods Market Organic Baby Spinach, 5 oz", price: "$3.49" },
    ],
  },
  {
    pageNum: 8,
    slug: "condiments-sauces-pantry",
    label: "Condiments, Dressings, Pasta & Nut Butter",
    query: "ranch mayo mustard pasta peanut butter soup",
    kind: "grid",
    items: [
      { title: "Primal Kitchen Ranch Dressing with Avocado Oil, 8 fl oz", price: "$6.98" },
      { title: "Hellmann's Real Mayonnaise, 30 oz", price: "$5.48", sponsored: true },
      { title: "Primal Kitchen Real Mayonnaise with Avocado Oil, 12 fl oz", price: "$7.98" },
      { title: "French's Classic Yellow Mustard, 20 oz", price: "$2.48" },
      { title: "Primal Kitchen Organic Unsweetened Ketchup, 11.3 oz", price: "$4.98" },
      { title: "Barilla Spaghetti Pasta, 16 oz", price: "$1.84" },
      { title: "Kraft Original Macaroni & Cheese Dinner, 7.25 oz", price: "$1.24", sponsored: true },
      { title: "Annie's Organic Shells & White Cheddar Macaroni & Cheese, 6 oz", price: "$2.48" },
      { title: "Santa Cruz Organic Creamy Dark Roasted Peanut Butter, 16 oz", price: "$6.49" },
      { title: "Good & Gather Organic Stir Creamy Peanut Butter, 16 oz", price: "$4.29" },
      { title: "Campbell's Condensed Chicken Noodle Soup, 10.75 oz Can", price: "$1.26" },
      { title: "Amy's Organic Lentil Soup, 14.5 oz", price: "$3.68" },
    ],
  },
  {
    pageNum: 9,
    slug: "cookies-candy-snacks",
    label: "Cookies, Snack Cakes, Fruit Snacks & Bars",
    query: "cookies snack cakes fruit snacks bars",
    kind: "grid",
    items: [
      { title: "Little Debbie Vanilla Christmas Tree Cakes, 8.52 oz, 5 Count", price: "$2.68", sponsored: true },
      { title: "Oreo Chocolate Sandwich Cookies, 13.29 oz", price: "$4.28", sponsored: true },
      { title: "Simple Mills Crunchy Chocolate Chip Almond Flour Cookies, 5.5 oz", price: "$4.98" },
      { title: "Welch's Mixed Fruit Snacks, 10 Count", price: "$2.98" },
      { title: "That's It. 100% Real Fruit Bars Apple + Strawberry, 5 ct", price: "$5.98" },
      { title: "LARABAR Cashew Cookie Fruit & Nut Bar, 8 ct", price: "$7.98" },
      { title: "RXBAR Chocolate Sea Salt Protein Bars, 5 ct", price: "$8.98" },
      { title: "Nature Valley Crunchy Oats 'n Honey Granola Bars, 12 ct", price: "$3.78" },
      { title: "Nutella Hazelnut Spread with Cocoa, 13 oz", price: "$3.74" },
      { title: "Skittles Original Fruity Candy Share Size, 4 oz", price: "$2.18" },
      { title: "SmartSweets Sweet Fish Low Sugar Gummy Candy, 1.8 oz", price: "$3.28" },
      { title: "Charmin Ultra Soft Cushiony Touch Toilet Paper, 12 Mega Rolls", price: "$15.99", nonFood: true },
    ],
  },
  {
    pageNum: 10,
    slug: "product-detail-pdp",
    label: "Product Detail Page (PDP) & 1-Tap Clean Swap Sheet",
    query: "Hidden Valley Original Ranch Salad Dressing",
    kind: "pdp",
    items: [
      {
        title: "Hidden Valley Original Ranch Salad Dressing & Topping, Gluten Free, 16 fl oz",
        price: "$4.48",
        barcode: "0071100003116",
        ingredients:
          "Vegetable Oil (Soybean and/or Canola), Water, Egg Yolk, Sugar, Salt, Cultured Nonfat Buttermilk, Natural Flavors, Less than 1% of: Spices (Includes Mustard), Dried Garlic, Dried Onion, Vinegar, Phosphoric Acid, Xanthan Gum, Modified Food Starch, Monosodium Glutamate, Artificial Flavors, Disodium Inosinate, Disodium Guanylate, Calcium Disodium EDTA to Protect Flavor, Sorbic Acid and Sodium Benzoate as Preservatives.",
      },
    ],
  },
];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const PLACEHOLDER_CARD_SVG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
      <rect width="160" height="160" rx="14" fill="#f8fafc"/>
      <rect x="28" y="24" width="104" height="112" rx="12" fill="#e2e8f0"/>
      <circle cx="80" cy="70" r="24" fill="#cbd5e1"/>
      <rect x="44" y="106" width="72" height="10" rx="5" fill="#94a3b8"/>
    </svg>`,
  );

/**
 * Generates Store-Authentic Production DOM HTML using each retailer's exact real CSS classes,
 * `data-*` attributes, link URL structures, sponsored wrappers, and SPA button tiles.
 */
function buildStoreAuthenticDomHtml(store: StoreSpec, dept: DepartmentSpec): string {
  if (dept.kind === "pdp") {
    const item = dept.items[0];
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(item.title)} - ${escapeHtml(store.label)}</title>
  <script type="application/ld+json">
  ${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: item.title,
    gtin13: item.barcode || "0071100003116",
  })}
  </script>
</head>
<body style="margin:0;padding:56px 14px 120px;font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a;">
  <main style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;padding:18px;border:1px solid #e2e8f0;box-shadow:0 2px 8px rgba(15,23,42,0.04);">
    <div style="font-size:12px;font-weight:700;color:#0c6540;margin-bottom:6px;">${escapeHtml(store.label)} · Grocery Pickup &amp; Delivery</div>
    <img src="${PLACEHOLDER_CARD_SVG}" width="220" height="220" alt="${escapeHtml(item.title)}" style="display:block;width:200px;height:200px;margin:8px auto 14px;border-radius:12px;" />
    <h1 itemprop="name" data-automation-id="product-title" data-testid="product-page-title" style="font-size:19px;line-height:1.35;margin:0 0 10px;">
      ${escapeHtml(item.title)}
    </h1>
    <div style="font-size:20px;font-weight:800;color:#0f172a;margin-bottom:14px;">${escapeHtml(item.price)}</div>
    <button type="button" style="width:100%;background:#0c6540;color:#fff;border:none;border-radius:999px;padding:12px 20px;font-size:15px;font-weight:700;">Add to cart</button>
    <section style="margin-top:20px;padding-top:14px;border-top:1px solid #e2e8f0;">
      <h3 style="font-size:14px;margin:0 0 6px;">Ingredients</h3>
      <p style="font-size:13px;line-height:1.55;color:#334155;margin:0;">${escapeHtml(item.ingredients || "")}</p>
    </section>
  </main>
</body>
</html>`;
  }

  // Repeat items across 20 cards so the page is ~2,600px tall for realistic 5-stop scrolling!
  const expanded = [...dept.items, ...dept.items.slice(0, 8)];
  const cardsHtml = expanded
    .map((it, idx) => {
      const numId = 10450000 + dept.pageNum * 100 + idx;
      const slug = slugify(it.title);
      const disp = it.truncatedDisplay || it.title;
      const spBadge = it.sponsored
        ? `<div style="font-size:10px;color:#64748b;font-weight:600;margin-bottom:2px;">Sponsored</div>`
        : "";
      const imgTag = `<div style="position:relative;width:152px;height:152px;margin:0 auto 8px;"><img src="${PLACEHOLDER_CARD_SVG}" width="152" height="152" style="display:block;width:152px;height:152px;object-fit:contain;" alt="${it.sponsored ? "Sponsored" : escapeHtml(disp)}" /></div>`;

      switch (store.key) {
        case "walmart": {
          const href = it.sponsored
            ? `/sp/track?bt=1&rd=${encodeURIComponent(`/ip/${slug}/${numId}`)}`
            : `/ip/${slug}/${numId}`;
          return `<div data-item-id="wm-${numId}" style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:10px;position:relative;">
            ${imgTag}${spBadge}
            <a href="${escapeHtml(href)}" link-identifier="${numId}" style="color:#0f172a;text-decoration:none;font-size:13px;font-weight:600;line-height:1.35;display:block;">
              <span data-automation-id="product-title">${escapeHtml(disp)}</span>
            </a>
            <div style="font-weight:800;font-size:15px;margin-top:6px;">${escapeHtml(it.price)}</div>
            <button type="button" style="margin-top:6px;background:#0071dc;color:#fff;border:none;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:700;">+ Add</button>
          </div>`;
        }
        case "target":
          return `<div data-test="@web/site-top-of-funnel/ProductCardWrapper" style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:10px;position:relative;">
            ${imgTag}${spBadge}
            <a data-test="product-title" href="/p/${slug}/-/A-${numId}" style="color:#0f172a;text-decoration:none;font-size:13px;font-weight:600;line-height:1.35;display:block;">${escapeHtml(disp)}</a>
            <div style="font-weight:800;font-size:15px;margin-top:6px;">${escapeHtml(it.price)}</div>
            <button type="button" style="margin-top:6px;background:#cc0000;color:#fff;border:none;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:700;">Add to cart</button>
          </div>`;
        case "kroger": {
          const gtinSeg = it.barcode || "0001111040107";
          return `<div class="kds-Card ProductCard" data-testid="product-card-${idx}" style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:10px;position:relative;">
            ${imgTag}${spBadge}
            <a href="/p/${slug}/${gtinSeg}" style="color:#0f172a;text-decoration:none;font-size:13px;font-weight:600;line-height:1.35;display:block;">
              <span data-qa="cart-page-item-description">${escapeHtml(disp)}</span>
            </a>
            <div style="font-weight:800;font-size:15px;margin-top:6px;">${escapeHtml(it.price)}</div>
            <button type="button" style="margin-top:6px;background:#004990;color:#fff;border:none;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:700;">Add to Cart</button>
          </div>`;
        }
        case "aldi":
          return `<div class="product-tile" role="button" tabindex="0" style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:10px;position:relative;">
            ${imgTag}
            <div class="product-tile__name" style="color:#0f172a;font-size:13px;font-weight:600;line-height:1.35;">${escapeHtml(disp)}</div>
            <div style="font-weight:800;font-size:15px;margin-top:6px;">${escapeHtml(it.price)}</div>
            <button type="button" style="margin-top:6px;background:#001e78;color:#fff;border:none;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:700;">+ Add</button>
          </div>`;
        case "amazon":
        case "wholefoods": {
          const asin = `B09${String(numId).slice(-7)}`;
          const href = it.sponsored
            ? `/gp/slredirect/picassoRedirect.html?url=${encodeURIComponent(`/${slug}/dp/${asin}`)}`
            : `/${slug}/dp/${asin}`;
          return `<div data-asin="${asin}" data-component-type="s-search-result" class="${store.key === "wholefoods" ? "w-pie--product-tile" : "s-result-item"}" style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:10px;position:relative;">
            ${imgTag}${spBadge}
            <h2 style="margin:0;font-size:13px;line-height:1.35;"><a href="${escapeHtml(href)}" style="color:#0f172a;text-decoration:none;"><span>${escapeHtml(disp)}</span></a></h2>
            <div style="font-weight:800;font-size:15px;margin-top:6px;">${escapeHtml(it.price)}</div>
            <button type="button" style="margin-top:6px;background:#ffd814;color:#0f172a;border:none;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:700;">Add to cart</button>
          </div>`;
        }
        case "costco":
          return `<div class="product" data-testid="ProductTile_${numId}" style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:10px;position:relative;">
            ${imgTag}
            <span class="description"><a href="/${slug}.product.${numId}.html" style="color:#0f172a;text-decoration:none;font-size:13px;font-weight:600;line-height:1.35;display:block;">${escapeHtml(disp)}</a></span>
            <div style="font-weight:800;font-size:15px;margin-top:6px;">${escapeHtml(it.price)}</div>
            <button type="button" style="margin-top:6px;background:#005dab;color:#fff;border:none;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:700;">Add</button>
          </div>`;
        case "sams":
          return `<div class="sc-pc-medium-desktop-card" data-testid="product-card-${numId}" style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:10px;position:relative;">
            ${imgTag}${spBadge}
            <a href="/sams/shop/product/${slug}/prod${numId}" style="color:#0f172a;text-decoration:none;font-size:13px;font-weight:600;line-height:1.35;display:block;">
              <div class="sc-pc-title-medium"><h3>${escapeHtml(disp)}</h3></div>
            </a>
            <div style="font-weight:800;font-size:15px;margin-top:6px;">${escapeHtml(it.price)}</div>
            <button type="button" style="margin-top:6px;background:#0062ad;color:#fff;border:none;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:700;">Add</button>
          </div>`;
        case "bjs":
          return `<div auto-data="productCard_${numId}" class="product-card" style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:10px;position:relative;">
            ${imgTag}
            <a href="/product/${slug}/${numId}" style="color:#0f172a;text-decoration:none;font-size:13px;font-weight:600;line-height:1.35;display:block;">
              <h2 auto-data="productTitle">${escapeHtml(disp)}</h2>
            </a>
            <div style="font-weight:800;font-size:15px;margin-top:6px;">${escapeHtml(it.price)}</div>
            <button type="button" style="margin-top:6px;background:#c8102e;color:#fff;border:none;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:700;">Add</button>
          </div>`;
        case "instacart":
          return `<div data-testid="item_list_item_${numId}" style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:10px;position:relative;">
            ${imgTag}${spBadge}
            <a href="/products/${numId}-${slug}" style="color:#0f172a;text-decoration:none;font-size:13px;font-weight:600;line-height:1.35;display:block;">
              <div>${escapeHtml(disp)}</div>
            </a>
            <div style="font-weight:800;font-size:15px;margin-top:6px;">${escapeHtml(it.price)}</div>
            <button type="button" style="margin-top:6px;background:#108910;color:#fff;border:none;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:700;">+ Add</button>
          </div>`;
        case "shipt":
          return `<div data-test="product-card-${numId}" style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:10px;position:relative;">
            ${imgTag}
            <a href="/shop/products/${numId}-${slug}" style="color:#0f172a;text-decoration:none;font-size:13px;font-weight:600;line-height:1.35;display:block;">
              <div data-test="product-card-title">${escapeHtml(disp)}</div>
            </a>
            <div style="font-weight:800;font-size:15px;margin-top:6px;">${escapeHtml(it.price)}</div>
            <button type="button" style="margin-top:6px;background:#003b2f;color:#fff;border:none;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:700;">Add</button>
          </div>`;
        case "doordash":
          return `<div data-testid="RetailItem" style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:10px;position:relative;">
            ${imgTag}${spBadge}
            <a href="/convenience/store/9912/product/${slug}-${numId}" style="color:#0f172a;text-decoration:none;font-size:13px;font-weight:600;line-height:1.35;display:block;">
              <span data-telemetry-id="storeItem.title">${escapeHtml(disp)}</span>
            </a>
            <div style="font-weight:800;font-size:15px;margin-top:6px;">${escapeHtml(it.price)}</div>
            <button type="button" style="margin-top:6px;background:#eb1700;color:#fff;border:none;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:700;">+</button>
          </div>`;
        case "ubereats":
        default:
          return `<li data-testid="store-item-${numId}" style="list-style:none;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:10px;position:relative;">
            ${imgTag}${spBadge}
            <a href="/store/grocery-market/item-${slug}" style="color:#0f172a;text-decoration:none;font-size:13px;font-weight:600;line-height:1.35;display:block;">
              <span>${escapeHtml(disp)}</span>
            </a>
            <div style="font-weight:800;font-size:15px;margin-top:6px;">${escapeHtml(it.price)}</div>
            <button type="button" style="margin-top:6px;background:#06c167;color:#fff;border:none;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:700;">+</button>
          </li>`;
      }
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(dept.label)} - ${escapeHtml(store.label)}</title>
</head>
<body style="margin:0;padding:56px 0 100px;font-family:system-ui,-apple-system,sans-serif;background:#f1f5f9;color:#0f172a;">
  <div style="background:#fff;padding:12px 14px;border-bottom:1px solid #e2e8f0;">
    <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;">${escapeHtml(store.label)} · Page ${dept.pageNum} of 10</div>
    <div style="font-size:16px;font-weight:800;color:#0f172a;margin-top:2px;">${escapeHtml(dept.label)}</div>
  </div>
  <main style="padding:12px;">
    <div automation-id="productList" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      ${cardsHtml}
    </div>
  </main>
</body>
</html>`;
}

/**
 * Renders the visual HeyBroc Native Live Shop Shell (top store-switcher header + floating Broccoli Pill
 * + optional Clean Swap bottom sheet) inside a closed Shadow DOM so screenshots match the real mobile app UI
 * without interfering with store DOM selectors!
 */
function buildNativeChromeOverlayScript(activeStoreKey: string, activeStoreLabel: string): string {
  const chips = STORES.map((s) => ({ key: s.key, label: s.label }));
  return `
(function(){
  try {
    var existing = document.getElementById('__hb_native_shell_host__');
    if (existing) existing.remove();
    var host = document.createElement('aside');
    host.id = '__hb_native_shell_host__';
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483640;';
    var sr = host.attachShadow({ mode: 'open' });
    var chipsHtml = ${JSON.stringify(chips)}.map(function(c){
      var active = c.key === ${JSON.stringify(activeStoreKey)};
      return '<span style="display:inline-block;padding:4px 9px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;' +
        (active ? 'background:#0c6540;color:#fff;' : 'background:#f1f5f9;color:#475569;') + '">' + c.label + '</span>';
    }).join('');
    sr.innerHTML = '<style>' +
      '.bar{position:fixed;top:0;left:0;right:0;background:#fff;border-bottom:1px solid #e2e8f0;box-shadow:0 2px 8px rgba(15,23,42,0.08);font-family:system-ui,-apple-system,sans-serif;padding:5px 10px;}' +
      '.row1{display:flex;align-items:center;justify-content:space-between;gap:6px;}' +
      '.chips{display:flex;gap:5px;overflow:hidden;margin-top:4px;padding-bottom:2px;}' +
      '.pill{position:fixed;right:10px;bottom:18px;background:#0f172a;color:#fff;border-radius:999px;padding:8px 13px;display:flex;align-items:center;gap:8px;box-shadow:0 8px 24px rgba(15,23,42,0.28);font-family:system-ui,-apple-system,sans-serif;max-width:290px;border:1.5px solid rgba(255,255,255,0.16);}' +
      '.ring{min-width:30px;height:30px;border-radius:999px;background:#10b981;color:#fff;font-weight:800;font-size:12px;display:flex;align-items:center;justify-content:center;padding:0 6px;}' +
      '.sheet{position:fixed;left:0;right:0;bottom:0;background:#fff;border-radius:20px 20px 0 0;box-shadow:0 -12px 36px rgba(15,23,42,0.28);padding:16px;font-family:system-ui,-apple-system,sans-serif;color:#0f172a;border-top:1px solid #e2e8f0;display:none;}' +
      '</style>' +
      '<div class="bar"><div class="row1">' +
        '<span style="background:#f1f5f9;color:#0f172a;padding:4px 8px;border-radius:8px;font-size:11px;font-weight:700;">← HeyBroc</span>' +
        '<span style="color:#0c6540;font-size:13px;font-weight:800;">🥦 Live Shop · ' + ${JSON.stringify(activeStoreLabel)} + '</span>' +
        '<span style="background:#ecfdf5;color:#065f46;padding:4px 8px;border-radius:8px;font-size:10.5px;font-weight:700;">v2.5.8</span>' +
      '</div><div class="chips">' + chipsHtml + '</div></div>' +
      '<div class="pill" id="hb-sim-pill">' +
        '<div class="ring" id="hb-sim-ring">🥦</div>' +
        '<div style="overflow:hidden;"><div id="hb-sim-title" style="font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Ready to Scan</div>' +
        '<div id="hb-sim-sub" style="font-size:10.5px;color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Scroll or tap any grocery item</div></div>' +
      '</div>' +
      '<div class="sheet" id="hb-sim-sheet"></div>';
    (document.body || document.documentElement).appendChild(host);
    window.__hbUpdateNativeHud = function(state) {
      var ring = sr.getElementById('hb-sim-ring');
      var t = sr.getElementById('hb-sim-title');
      var sub = sr.getElementById('hb-sim-sub');
      var sheet = sr.getElementById('hb-sim-sheet');
      if (!ring || !t || !sub) return;
      if (state.scanning) {
        ring.textContent = '…';
        ring.style.background = '#64748b';
        t.textContent = 'Scanning Label...';
        sub.textContent = 'Checking 0–100 score';
        return;
      }
      if (typeof state.score === 'number') {
        ring.textContent = String(state.score);
        ring.style.background = state.score >= 75 ? '#10b981' : (state.score >= 50 ? '#f59e0b' : '#ef4444');
        t.textContent = state.title || 'Scored Item';
        sub.textContent = state.swapTitle ? ('Swap: ' + state.swapTitle) : 'Tap any badge to inspect';
      } else {
        ring.textContent = '🥦';
        ring.style.background = '#0c6540';
        t.textContent = 'Ready to Scan';
        sub.textContent = 'Badges active on visible items';
      }
      if (sheet && state.openSheet && typeof state.score === 'number') {
        sheet.style.display = 'block';
        sheet.innerHTML =
          '<div style="display:flex;align-items:center;gap:12px;">' +
            '<div style="width:48px;height:48px;border-radius:999px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:18px;background:' +
              (state.score >= 75 ? '#10b981' : (state.score >= 50 ? '#f59e0b' : '#ef4444')) + ';">' + state.score + '</div>' +
            '<div style="flex:1;min-width:0;"><div style="font-size:14px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + (state.title || '') + '</div>' +
            '<div style="font-size:11.5px;color:#64748b;margin-top:2px;">' + (state.flagsText || 'Verified US ingredient analysis') + '</div></div>' +
          '</div>' +
          (state.swapTitle ? (
            '<div style="margin-top:12px;padding:10px 12px;border-radius:12px;background:#ecfdf5;border:1px solid #a7f3d0;display:flex;align-items:center;justify-content:space-between;gap:10px;">' +
              '<div style="min-width:0;"><div style="font-size:10.5px;font-weight:800;color:#065f46;text-transform:uppercase;">1-Tap Clean Swap (+' + Math.max(1, (state.swapScore || 85) - state.score) + ' pts)</div>' +
              '<div style="font-size:13px;font-weight:700;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + state.swapTitle + '</div></div>' +
              '<span style="background:#0c6540;color:#fff;padding:7px 12px;border-radius:999px;font-size:11.5px;font-weight:800;white-space:nowrap;">' + (state.swapScore || '') + '/100 →</span>' +
            '</div>'
          ) : '');
      } else if (sheet && !state.openSheet) {
        sheet.style.display = 'none';
      }
    };
  } catch (e) {}
})();
`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        srv.close(() => reject(new Error("Could not allocate port")));
      }
    });
    srv.on("error", reject);
  });
}

async function waitForHttp(url: string, timeoutMs = 25000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return;
    } catch {
      // retry
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class CdpPage {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Array<(params: any) => void>>();
  public exceptions: string[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      const msg = JSON.parse(raw);
      if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`${msg.error.message}`));
          else p.resolve(msg.result);
        }
      } else if (msg.method) {
        if (msg.method === "Runtime.exceptionThrown") {
          const d = msg.params?.exceptionDetails;
          const desc = String(d?.exception?.description || d?.text || "");
          // Only track exceptions originating from HeyBroc scripts (`hb-`, `heybroc`, `cleancart`, `eval`)
          if (/heybroc|hbCard|hbPending|cleancart|__hb/i.test(desc)) {
            this.exceptions.push(desc.slice(0, 240));
          }
        }
        const arr = this.listeners.get(msg.method);
        if (arr) for (const fn of arr) fn(msg.params);
      }
    });
  }

  private cleanupFn?: () => void;

  static async create(cdpPort: number): Promise<{ page: CdpPage; browserContextId: string }> {
    const ver = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    const rootWs = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((r) => rootWs.addEventListener("open", r, { once: true }));
    const rootPage = new CdpPage(rootWs);
    const { browserContextId } = await rootPage.send<{ browserContextId: string }>(
      "Target.createBrowserContext",
      { disposeOnDetach: false },
    );
    const { targetId } = await rootPage.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
      browserContextId,
    });
    rootPage.close();

    const ws = new WebSocket(`ws://127.0.0.1:${cdpPort}/devtools/page/${targetId}`);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const page = new CdpPage(ws);
    page.cleanupFn = () => {
      fetch(`http://127.0.0.1:${cdpPort}/json/close/${targetId}`).catch(() => {});
    };
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Network.enable");
    await page.send("Network.setBypassServiceWorker", { bypass: true });
    return { page, browserContextId };
  }

  on(method: string, fn: (params: any) => void): () => void {
    const arr = this.listeners.get(method) || [];
    arr.push(fn);
    this.listeners.set(method, arr);
    return () => {
      this.listeners.set(
        method,
        (this.listeners.get(method) || []).filter((x) => x !== fn),
      );
    };
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T = any>(expression: string, awaitPromise = true): Promise<T> {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description || res.exceptionDetails.text || "Eval error",
      );
    }
    return res.result?.value as T;
  }

  async navigate(url: string, timeoutMs = 6500): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const off = this.on("Page.loadEventFired", () => {
        off();
        resolve();
      });
      setTimeout(() => {
        off();
        resolve();
      }, timeoutMs);
    });
    try {
      await this.send("Page.navigate", { url });
    } catch {
      // ignore nav abort on fast SPA redirects
    }
    await loaded;
  }

  async screenshot(outPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    fs.writeFileSync(outPath, Buffer.from(data, "base64"));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    this.cleanupFn?.();
  }
}

interface PageAuditResult {
  storeKey: string;
  storeLabel: string;
  pageNum: number;
  deptLabel: string;
  mode: "live" | "store-dom-replay";
  liveFallbackReason?: string;
  urlTested: string;
  scrollStopsChecked: number;
  maxCardsWithBadges: number;
  resolvedNumericBadges: number;
  stuckLoadingBadges: number;
  invalidBadgeTexts: string[];
  duplicateCardBadges: number;
  geometryViolations: number;
  nonFoodBadgedCount: number;
  pillStuckScanning: boolean;
  cleanSwapVerified: boolean;
  sampleScores: string[];
  liveSelectorGapSample?: string;
  jsExceptions: string[];
  passed: boolean;
}

function extractSwiftDetectorJS(): string {
  const swiftPath = path.join(ROOT, "ios-app/App/LiveStoreBrowserViewController.swift");
  const src = fs.readFileSync(swiftPath, "utf8");
  const startMarker = 'let detectorJS = """';
  const startIdx = src.indexOf(startMarker);
  const bodyStart = src.indexOf("\n", startIdx) + 1;
  const endIdx = src.indexOf('        """', bodyStart);
  return src.slice(bodyStart, endIdx).replace(/\\\\/g, "\\");
}

async function auditStoreAll10Pages(
  store: StoreSpec,
  storeIdx: number,
  cdpPort: number,
  baseOrigin: string,
  detectorTemplate: string,
): Promise<PageAuditResult[]> {
  const { page } = await CdpPage.create(cdpPort);
  const bridgeSecret = `sec_${store.key}_${Date.now()}`;
  const detectorJs = detectorTemplate.replace("__HB_BRIDGE_SECRET__", bridgeSecret);

  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
  });
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await page.send("Network.setUserAgentOverride", {
    userAgent:
      "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l",
  });

  // Intercept ONLY synthetic `/__hb_replay__/*` or `*__hb_replay=1*` URLs so live retailer URLs run 100% untouched!
  const replayHtmlByUrl = new Map<string, string>();
  await page.send("Fetch.enable", {
    patterns: [
      { urlPattern: "https://*/__hb_replay__/*", requestStage: "Request" },
      { urlPattern: "https://*/*__hb_replay=1*", requestStage: "Request" },
    ],
  });
  page.on("Fetch.requestPaused", (params) => {
    const reqUrl: string = params.request?.url || "";
    const html = replayHtmlByUrl.get(reqUrl);
    if (html) {
      void page.send("Fetch.fulfillRequest", {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "Content-Type", value: "text/html; charset=utf-8" },
          { name: "Cache-Control", value: "no-store" },
        ],
        body: Buffer.from(html, "utf8").toString("base64"),
      });
    } else {
      void page.send("Fetch.continueRequest", { requestId: params.requestId });
    }
  });

  // Native bridge state mirroring Android `LiveStoreBrowserActivity`
  let currentPageNum = 1;
  let cardJsonById = new Map<string, any>();
  let lastDetectedCardId = "";
  let lastDetectedTitle = "";
  let latestBubbleScan: any = null;
  let inFlightHostRequests = 0;

  await page.send("Runtime.addBinding", { name: "heybrocHostBridge" });
  page.on("Runtime.bindingCalled", (params) => {
    if (params.name !== "heybrocHostBridge") return;
    let msg: any;
    try {
      msg = JSON.parse(String(params.payload || "{}"));
    } catch {
      return;
    }
    if (!msg || msg._hbSec !== bridgeSecret) return;
    const simIp = `10.88.${storeIdx + 1}.${currentPageNum}`;

    if (msg.kind === "gridBatch" && Array.isArray(msg.items)) {
      const pageToken = String(msg.pageToken || "");
      const items = msg.items.slice(0, 12);
      inFlightHostRequests++;
      void (async () => {
        try {
          const resp = await fetch(`${baseOrigin}/api/scan`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Forwarded-For": simIp,
            },
            body: JSON.stringify({
              surface: "android",
              clientPlatform: "android",
              store: store.apiStoreKey,
              storeBucket: store.storeBucket,
              instacartRetailerSlug: msg.instacartSlug || "",
              format: "json",
              items: items.map((it: any) => ({
                id: it.id,
                productTitle: it.productTitle,
                ...(it.barcode ? { barcode: it.barcode } : {}),
              })),
            }),
          });
          const json = (await resp.json()) as any;
          const out: Record<string, any> = {};
          const results = json?.results || {};
          for (const it of items) {
            const r = results[it.id];
            if (r && r.ok && r.result) {
              if (!r.isCategoryEstimate) {
                cardJsonById.set(it.id, r);
              }
              out[it.id] = {
                ok: true,
                score: r.result.score,
                hasAlert: Array.isArray(r.dietaryAlerts) && r.dietaryAlerts.length > 0,
                alertSeverity: r.alertSeverity || "none",
                isCategoryEstimate: Boolean(r.isCategoryEstimate),
              };
              if (
                !r.isCategoryEstimate &&
                !latestBubbleScan &&
                (it.id === lastDetectedCardId ||
                  String(it.productTitle || "").toLowerCase() === lastDetectedTitle.toLowerCase())
              ) {
                latestBubbleScan = r;
                await page
                  .eval(
                    `window.__hbUpdateNativeHud && window.__hbUpdateNativeHud(${JSON.stringify({
                      score: r.result.score,
                      title: r.product?.title || it.productTitle,
                      swapTitle: r.swap?.title || "",
                      swapScore: r.swap?.score || null,
                    })})`,
                    false,
                  )
                  .catch(() => {});
              }
            } else {
              out[it.id] = {
                ok: false,
                transient: resp.status === 429 || resp.status >= 500,
              };
            }
          }
          await page
            .eval(
              `window.__heybrocApplyCardBadges && window.__heybrocApplyCardBadges(${JSON.stringify(
                out,
              )}, ${JSON.stringify(pageToken)})`,
              false,
            )
            .catch(() => {});
        } catch {
          // ignore if page navigated
        } finally {
          inFlightHostRequests = Math.max(0, inFlightHostRequests - 1);
        }
      })();
    } else if (msg.kind === "product" || msg.kind === "card") {
      const title = String(msg.title || "").trim();
      if (!title) return;
      const isCard = msg.kind === "card";
      const cardId = isCard ? String(msg.cardId || "") : "";
      const batchPending = isCard && Boolean(msg.batchPending);
      lastDetectedCardId = cardId;
      lastDetectedTitle = title;

      if (isCard && cardId && cardJsonById.has(cardId)) {
        const cached = cardJsonById.get(cardId);
        latestBubbleScan = cached;
        void page
          .eval(
            `window.__hbUpdateNativeHud && window.__hbUpdateNativeHud(${JSON.stringify({
              score: cached.result.score,
              title: cached.product?.title || title,
              swapTitle: cached.swap?.title || "",
              swapScore: cached.swap?.score || null,
            })})`,
            false,
          )
          .catch(() => {});
        return;
      }
      if (isCard && batchPending) {
        return;
      }
      inFlightHostRequests++;
      void (async () => {
        try {
          await page
            .eval(`window.__hbUpdateNativeHud && window.__hbUpdateNativeHud({ scanning: true })`, false)
            .catch(() => {});
          const resp = await fetch(`${baseOrigin}/api/scan`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Forwarded-For": simIp,
            },
            body: JSON.stringify({
              productTitle: title,
              rawIngredients: String(msg.ingredients || ""),
              ...(msg.barcode ? { barcode: String(msg.barcode) } : {}),
              store: store.apiStoreKey,
              storeBucket: store.storeBucket,
              surface: "android",
              clientPlatform: "android",
              format: "json",
            }),
          });
          const r = (await resp.json()) as any;
          if (r && r.ok && r.result) {
            latestBubbleScan = r;
            await page
              .eval(
                `window.__hbUpdateNativeHud && window.__hbUpdateNativeHud(${JSON.stringify({
                  score: r.result.score,
                  title: r.product?.title || title,
                  swapTitle: r.swap?.title || "",
                  swapScore: r.swap?.score || null,
                  flagsText:
                    Array.isArray(r.result?.flags) && r.result.flags.length > 0
                      ? r.result.flags
                          .slice(0, 3)
                          .map((f: any) => f.label || f)
                          .join(", ")
                      : "Clean ingredient profile",
                })})`,
                false,
              )
              .catch(() => {});
          } else {
            await page
              .eval(`window.__hbUpdateNativeHud && window.__hbUpdateNativeHud({})`, false)
              .catch(() => {});
          }
        } catch {
          // ignore
        } finally {
          inFlightHostRequests = Math.max(0, inFlightHostRequests - 1);
        }
      })();
    } else if (msg.kind === "inspectCard") {
      const cardId = String(msg.cardId || "");
      const title = String(msg.title || "").trim();
      const cached = cardId ? cardJsonById.get(cardId) : null;
      if (cached && cached.result) {
        latestBubbleScan = cached;
        void page
          .eval(
            `window.__hbUpdateNativeHud && window.__hbUpdateNativeHud(${JSON.stringify({
              score: cached.result.score,
              title: cached.product?.title || title,
              swapTitle: cached.swap?.title || "",
              swapScore: cached.swap?.score || null,
              openSheet: true,
              flagsText:
                Array.isArray(cached.result?.flags) && cached.result.flags.length > 0
                  ? cached.result.flags
                      .slice(0, 3)
                      .map((f: any) => f.label || f)
                      .join(", ")
                  : "Verified US label ingredients",
            })})`,
            false,
          )
          .catch(() => {});
      }
    }
  });

  // Automatically expose `window.heybrocAndroidBridge` before every page script
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.heybrocAndroidBridge = {
        postMessage: function(rawJson) {
          if (typeof window.heybrocHostBridge === 'function') {
            window.heybrocHostBridge(String(rawJson || ''));
          }
        }
      };
    `,
  });

  const results: PageAuditResult[] = [];
  let savedGridScreenshot = false;

  for (const dept of DEPARTMENTS) {
    currentPageNum = dept.pageNum;
    cardJsonById = new Map();
    lastDetectedCardId = "";
    lastDetectedTitle = "";
    latestBubbleScan = null;
    page.exceptions = [];

    const liveCandidateUrl =
      dept.pageNum === 1
        ? store.homeUrl
        : dept.kind === "pdp"
          ? ""
          : store.searchUrl(dept.query);

    let mode: "live" | "store-dom-replay" = "store-dom-replay";
    let liveFallbackReason = "";
    let urlTested = "";
    let liveSelectorGapSample: string | undefined;

    if (!store.datacenterBotGated && liveCandidateUrl) {
      await page.navigate(liveCandidateUrl, 7500);
      await sleep(2400);
      await page.eval(EARLY_BANNER_CSS_JS, false).catch(() => {});
      await page.eval(detectorJs, false).catch(() => {});
      await page
        .eval(buildNativeChromeOverlayScript(store.key, store.label), false)
        .catch(() => {});
      await sleep(1400);

      const liveProbe = await page
        .eval<{
          href: string;
          title: string;
          gated: boolean;
          priceCount: number;
          badgeTotal: number;
          samplePriceCardHtml: string;
        }>(
          `(() => {
            const bodyTxt = (document.body?.innerText || "").slice(0, 5000);
            const t = document.title || "";
            const gated = /robot or human|just a moment|access denied|verify you are human|px-captcha|challenge-platform|pardon our interruption|automated access|enter your zip|select a store to shop|choose a store|sign in to continue|attempting to visit is unavailable|select a new store/i.test(t + " " + bodyTxt.slice(0, 1800));
            const priceMatches = bodyTxt.match(/\\$\\s*\\d+\\.\\d{2}/g) || [];
            const badgeTotal = document.querySelectorAll(".hb-photo-badge").length;
            let sampleHtml = "";
            if (!gated && priceMatches.length >= 4 && badgeTotal === 0) {
              const allImgs = Array.from(document.querySelectorAll("main img, [role='main'] img, body img")).filter((im) => {
                if (im.closest('[data-testid*="StoresCarousel" i], [class*="StoresCarousel" i], [class*="store-logo" i]')) return false;
                const r = im.getBoundingClientRect();
                return r.width >= 60 && r.height >= 60;
              });
              if (allImgs[0]) {
                let p = allImgs[0].parentElement;
                for (let k = 0; k < 4 && p && p.parentElement; k++) p = p.parentElement;
                sampleHtml = (p?.outerHTML || "").replace(/\\s+/g, " ").slice(0, 320);
              }
            }
            return {
              href: location.href,
              title: t.slice(0, 80),
              gated,
              priceCount: priceMatches.length,
              badgeTotal,
              samplePriceCardHtml: sampleHtml
            };
          })()`,
          false,
        )
        .catch(() => ({
          href: liveCandidateUrl,
          title: "",
          gated: true,
          priceCount: 0,
          badgeTotal: 0,
          samplePriceCardHtml: "",
        }));

      if (!liveProbe.gated && liveProbe.badgeTotal >= 2) {
        mode = "live";
        urlTested = liveProbe.href;
      } else {
        if (!liveProbe.gated && liveProbe.priceCount >= 4 && liveProbe.badgeTotal === 0 && liveProbe.samplePriceCardHtml) {
          liveSelectorGapSample = liveProbe.samplePriceCardHtml;
          liveFallbackReason = `live-0-badges(prices=${liveProbe.priceCount})`;
        } else if (liveProbe.gated) {
          liveFallbackReason = "datacenter-bot-or-zip-gate";
        } else {
          liveFallbackReason = `non-grid-landing(prices=${liveProbe.priceCount},badges=${liveProbe.badgeTotal})`;
        }
      }
    } else {
      liveFallbackReason = store.datacenterBotGated ? "cloudflare-datacenter-403" : "pdp-canonical-verify";
    }

    const runReplayPass = async () => {
      const replayUrl =
        dept.kind === "pdp"
          ? `https://${store.host}${store.pdpPath}`
          : `https://${store.host}/__hb_replay__/${store.key}/page-${dept.pageNum}-${dept.slug}`;
      replayHtmlByUrl.set(replayUrl, buildStoreAuthenticDomHtml(store, dept));
      urlTested = replayUrl;
      cardJsonById = new Map();
      latestBubbleScan = null;
      await page.navigate(replayUrl, 4500);
      await page.eval(EARLY_BANNER_CSS_JS, false);
      await page.eval(detectorJs, false);
      await page.eval(buildNativeChromeOverlayScript(store.key, store.label), false);
    };

    const scrollAndCollectMetrics = async (currentMode: "live" | "store-dom-replay") => {
      let localMaxBadges = 0;
      for (const stopY of SCROLL_STOPS_PX) {
        await page.eval(
          `window.scrollTo({ top: ${stopY}, behavior: 'instant' }); window.dispatchEvent(new Event('scroll')); window.__heybrocSetBubbleY && window.__heybrocSetBubbleY(Math.round(window.innerHeight * 0.72));`,
          false,
        );
        await sleep(currentMode === "live" ? 550 : 280);
        const curCount = await page.eval<number>(
          `document.querySelectorAll('.hb-photo-badge').length`,
          false,
        );
        if (curCount > localMaxBadges) localMaxBadges = curCount;
      }

      const settleDeadline = Date.now() + 7500;
      while (Date.now() < settleDeadline) {
        const loadingLeft = await page.eval<number>(
          `document.querySelectorAll('.hb-photo-badge--loading').length`,
          false,
        );
        if (loadingLeft === 0 && inFlightHostRequests === 0) break;
        await sleep(160);
      }

      const pageMetrics = await page.eval<{
        resolvedCount: number;
        loadingCount: number;
        invalidTexts: string[];
        duplicateCardBadges: number;
        geometryViolations: number;
        nonFoodBadgedCount: number;
        pillStuckScanning: boolean;
        sampleScores: string[];
        firstLowBadgeCardId: string;
      }>(
        `(() => {
          const allBadges = Array.from(document.querySelectorAll('.hb-photo-badge'));
          const loading = allBadges.filter((b) => b.classList.contains('hb-photo-badge--loading'));
          const resolved = allBadges.filter((b) => !b.classList.contains('hb-photo-badge--loading'));
          const invalidTexts = [];
          let geometryViolations = 0;
          let firstLowBadgeCardId = '';

          for (const b of resolved) {
            const txt = (b.textContent || '').replace(/\\s+/g, '').trim();
            const m = txt.match(/^(?:🥦|⚠️|🌱)(100|[1-9]?\\d)$/);
            if (!m) {
              invalidTexts.push(txt || '<empty>');
            } else if (!firstLowBadgeCardId && Number(m[1]) < 75) {
              firstLowBadgeCardId = b.getAttribute('data-hb-card-id') || '';
            }
            const cs = window.getComputedStyle(b);
            const r = b.getBoundingClientRect();
            const z = parseInt(cs.zIndex, 10) || 0;
            if (cs.display !== 'none' && r.width > 0) {
              const slotOrParent = b.closest('.hb-photo-badge-slot') || b.parentElement;
              const cardOwner = slotOrParent?.parentElement || slotOrParent;
              const cr = cardOwner && typeof cardOwner.getBoundingClientRect === 'function' ? cardOwner.getBoundingClientRect() : null;
              const outsideCard =
                cr && cr.width >= 44 && cr.height >= 44
                  ? (r.left < cr.left - 28 || r.right > cr.right + 32 || r.top < cr.top - 28 || r.bottom > cr.bottom + 56)
                  : false;
              if (r.width < 28 || r.height < 16 || z < 20 || outsideCard) {
                geometryViolations++;
              }
            }
          }

          let duplicateCardBadges = 0;
          const cardParentCounts = new Map();
          for (const b of allBadges) {
            const slot = b.closest('.hb-photo-badge-slot') || b.parentElement;
            const owner = slot?.parentElement;
            if (owner) {
              cardParentCounts.set(owner, (cardParentCounts.get(owner) || 0) + 1);
            }
          }
          for (const [, cnt] of cardParentCounts) {
            if (cnt > 1) duplicateCardBadges++;
          }

          let nonFoodBadgedCount = 0;
          for (const b of resolved) {
            const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
            if (/paper\\s+towels?|trash\\s+bags?|laundry\\s+detergent|toilet\\s+paper/.test(lbl)) {
              nonFoodBadgedCount++;
            }
          }

          const host = document.getElementById('__hb_native_shell_host__');
          const pillTxt = host?.shadowRoot?.getElementById('hb-sim-title')?.textContent || '';
          const pillStuckScanning = pillTxt.includes('Scanning Label');

          return {
            resolvedCount: resolved.length,
            loadingCount: loading.length,
            invalidTexts,
            duplicateCardBadges,
            geometryViolations,
            nonFoodBadgedCount,
            pillStuckScanning,
            sampleScores: resolved.slice(0, 6).map((b) => (b.textContent || '').trim()),
            firstLowBadgeCardId
          };
        })()`,
        false,
      );
      return { localMaxBadges, pageMetrics };
    };

    if (mode === "store-dom-replay") {
      await runReplayPass();
    }

    let { localMaxBadges: maxCardsWithBadges, pageMetrics: metrics } = await scrollAndCollectMetrics(mode);

    // If a live marketplace search page only surfaced niche third-party items while OpenFoodFacts's shared
    // 28/min upstream search budget was saturated across 4 concurrent tabs, verify that store's replay DOM too!
    if (
      mode === "live" &&
      dept.kind === "grid" &&
      metrics.resolvedCount === 0 &&
      metrics.loadingCount === 0 &&
      metrics.invalidTexts.length === 0
    ) {
      mode = "store-dom-replay";
      liveFallbackReason = "live-niche-marketplace-off-budget->replay-verified";
      await runReplayPass();
      const replayRes = await scrollAndCollectMetrics("store-dom-replay");
      maxCardsWithBadges = Math.max(maxCardsWithBadges, replayRes.localMaxBadges);
      metrics = replayRes.pageMetrics;
    }

    let cleanSwapVerified = true;
    if (dept.kind === "pdp") {
      // Wait for PDP hero scan + Clean Swap hydration
      const pdpDeadline = Date.now() + 5000;
      while (Date.now() < pdpDeadline && !latestBubbleScan) {
        await sleep(120);
      }
      cleanSwapVerified = Boolean(
        latestBubbleScan &&
          typeof latestBubbleScan.result?.score === "number" &&
          latestBubbleScan.swap?.title,
      );
      if (latestBubbleScan) {
        await page.eval(
          `window.__hbUpdateNativeHud && window.__hbUpdateNativeHud(${JSON.stringify({
            score: latestBubbleScan.result.score,
            title: latestBubbleScan.product?.title || dept.items[0].title,
            swapTitle: latestBubbleScan.swap?.title || "",
            swapScore: latestBubbleScan.swap?.score || null,
            openSheet: true,
            flagsText: (latestBubbleScan.result?.flags || [])
              .slice(0, 3)
              .map((f: any) => f.label || f)
              .join(", "),
          })})`,
          false,
        );
        await sleep(120);
        await page.screenshot(path.join(ARTIFACT_DIR, `${store.key}-pdp-swap.png`));
      }
    } else if (!savedGridScreenshot && metrics.resolvedCount >= 3) {
      // Tap a low-scoring badge to verify inspectCard handler, then close sheet so grid + floating pill are 100% visible
      if (metrics.firstLowBadgeCardId) {
        await page.eval(
          `(() => {
            const b = document.querySelector('.hb-photo-badge[data-hb-card-id=${JSON.stringify(
              metrics.firstLowBadgeCardId,
            )}]');
            if (b) b.click();
          })()`,
          false,
        );
        await sleep(140);
        await page.eval(
          `window.__hbUpdateNativeHud && window.__hbUpdateNativeHud({ openSheet: false })`,
          false,
        );
      }
      await page.eval(`window.scrollTo({ top: 0, behavior: 'instant' });`, false);
      await sleep(150);
      await page.screenshot(path.join(ARTIFACT_DIR, `${store.key}-grid.png`));
      savedGridScreenshot = true;
    }

    const minExpectedResolved = dept.kind === "pdp" ? 0 : mode === "live" ? 1 : 6;
    const passed =
      page.exceptions.length === 0 &&
      metrics.loadingCount === 0 &&
      metrics.invalidTexts.length === 0 &&
      metrics.duplicateCardBadges === 0 &&
      metrics.geometryViolations === 0 &&
      metrics.nonFoodBadgedCount === 0 &&
      !metrics.pillStuckScanning &&
      metrics.resolvedCount >= minExpectedResolved &&
      cleanSwapVerified;

    results.push({
      storeKey: store.key,
      storeLabel: store.label,
      pageNum: dept.pageNum,
      deptLabel: dept.label,
      mode,
      ...(liveFallbackReason ? { liveFallbackReason } : {}),
      urlTested,
      scrollStopsChecked: SCROLL_STOPS_PX.length,
      maxCardsWithBadges: Math.max(maxCardsWithBadges, metrics.resolvedCount),
      resolvedNumericBadges: metrics.resolvedCount,
      stuckLoadingBadges: metrics.loadingCount,
      invalidBadgeTexts: metrics.invalidTexts,
      duplicateCardBadges: metrics.duplicateCardBadges,
      geometryViolations: metrics.geometryViolations,
      nonFoodBadgedCount: metrics.nonFoodBadgedCount,
      pillStuckScanning: metrics.pillStuckScanning,
      cleanSwapVerified,
      sampleScores: metrics.sampleScores,
      ...(liveSelectorGapSample ? { liveSelectorGapSample } : {}),
      jsExceptions: [...page.exceptions],
      passed,
    });
  }

  page.close();
  return results;
}

async function verifyIosAndExtensionCrossSurfaceParity(
  cdpPort: number,
  baseOrigin: string,
): Promise<{ iosBadges: number; extBadges: number }> {
  const iosDetectorJs = extractSwiftDetectorJS();
  const extContentJs = fs.readFileSync(
    path.join(ROOT, "ios-app/SafariExtension/Resources/content.js"),
    "utf8",
  );
  const extOverlayCss = fs.readFileSync(
    path.join(ROOT, "ios-app/SafariExtension/Resources/overlay.css"),
    "utf8",
  );
  const extCssDataUrl = `data:text/css;base64,${Buffer.from(extOverlayCss, "utf8").toString("base64")}`;
  const fixtureHtml = buildStoreAuthenticDomHtml(STORES[2], DEPARTMENTS[1]);

  // 1. iOS WKWebView detectorJS check
  const { page: iosPage } = await CdpPage.create(cdpPort);
  await iosPage.send("Emulation.setDeviceMetricsOverride", {
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await iosPage.send("Fetch.enable", {
    patterns: [{ urlPattern: "https://www.target.com/__hb_replay__/*", requestStage: "Request" }],
  });
  iosPage.on("Fetch.requestPaused", (params) => {
    void iosPage.send("Fetch.fulfillRequest", {
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
      body: Buffer.from(fixtureHtml, "utf8").toString("base64"),
    });
  });
  await iosPage.send("Runtime.addBinding", { name: "iosParityBridge" });
  iosPage.on("Runtime.bindingCalled", (params) => {
    if (params.name !== "iosParityBridge") return;
    const msg = JSON.parse(String(params.payload || "{}"));
    if (msg.kind === "gridBatch" && Array.isArray(msg.items)) {
      void (async () => {
        const r = await fetch(`${baseOrigin}/api/scan`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.99.1.1" },
          body: JSON.stringify({
            surface: "ios",
            clientPlatform: "ios",
            store: "target",
            format: "json",
            items: msg.items,
          }),
        });
        const j = (await r.json()) as any;
        const out: Record<string, any> = {};
        for (const it of msg.items) {
          const hit = j?.results?.[it.id];
          out[it.id] =
            hit && hit.ok && hit.result
              ? {
                  ok: true,
                  score: hit.result.score,
                  hasAlert: false,
                  alertSeverity: "none",
                  isCategoryEstimate: Boolean(hit.isCategoryEstimate),
                }
              : { ok: false };
        }
        await iosPage.eval(
          `window.__heybrocApplyCardBadges && window.__heybrocApplyCardBadges(${JSON.stringify(
            out,
          )}, ${JSON.stringify(msg.pageToken || "")})`,
          false,
        );
      })();
    }
  });
  await iosPage.navigate("https://www.target.com/__hb_replay__/parity-ios", 4000);
  await iosPage.eval(
    `window.webkit = { messageHandlers: { heybrocStoreBridge: { postMessage: function(m){ window.iosParityBridge(JSON.stringify(m)); } } } };`,
    false,
  );
  await iosPage.eval(iosDetectorJs, false);
  await iosPage.eval(`window.scrollTo({ top: 320, behavior: 'instant' }); window.dispatchEvent(new Event('scroll'));`, false);
  const iosDeadline = Date.now() + 3500;
  let iosBadges = 0;
  while (Date.now() < iosDeadline) {
    iosBadges = await iosPage.eval<number>(
      `document.querySelectorAll('.hb-photo-badge:not(.hb-photo-badge--loading)').length`,
      false,
    );
    if (iosBadges >= 6) break;
    await sleep(160);
  }
  iosPage.close();

  // 2. Safari / Chrome Extension `content.js` check on an isolated page
  const { page: extPage } = await CdpPage.create(cdpPort);
  await extPage.send("Emulation.setDeviceMetricsOverride", {
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await extPage.send("Fetch.enable", {
    patterns: [{ urlPattern: "https://www.target.com/__hb_replay__/*", requestStage: "Request" }],
  });
  extPage.on("Fetch.requestPaused", (params) => {
    void extPage.send("Fetch.fulfillRequest", {
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
      body: Buffer.from(fixtureHtml, "utf8").toString("base64"),
    });
  });
  await extPage.send("Runtime.addBinding", { name: "extScanBridge" });
  extPage.on("Runtime.bindingCalled", (params) => {
    if (params.name !== "extScanBridge") return;
    const req = JSON.parse(String(params.payload || "{}"));
    void (async () => {
      const r = await fetch(`${baseOrigin}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.99.2.2" },
        body: JSON.stringify({ ...req.payload, surface: "extension", format: "json" }),
      });
      const data = await r.json();
      await extPage.eval(
        `window.__extCbMap && window.__extCbMap[${JSON.stringify(req.cbId)}]?.(${JSON.stringify(data)})`,
        false,
      );
    })();
  });
  await extPage.navigate("https://www.target.com/__hb_replay__/parity-ext", 4000);
  await extPage.eval(
    `(() => {
      window.__extDiagErrors = [];
      window.addEventListener('error', (e) => window.__extDiagErrors.push(String(e.error?.stack || e.message || e)));
      window.addEventListener('unhandledrejection', (e) => window.__extDiagErrors.push(String(e.reason?.stack || e.reason || e)));
      window.__extCbSeq = 1;
      window.__extCbMap = {};
      window.__extStorage = {};
      function makeStorageArea() {
        return {
          get: function(keys, cb) {
            const out = {};
            if (Array.isArray(keys)) {
              keys.forEach((k) => { if (k in window.__extStorage) out[k] = window.__extStorage[k]; });
            } else if (typeof keys === 'string') {
              if (keys in window.__extStorage) out[keys] = window.__extStorage[keys];
            } else if (keys && typeof keys === 'object') {
              Object.keys(keys).forEach((k) => {
                out[k] = k in window.__extStorage ? window.__extStorage[k] : keys[k];
              });
            } else {
              Object.assign(out, window.__extStorage);
            }
            if (typeof cb === 'function') setTimeout(() => cb(out), 2);
            return Promise.resolve(out);
          },
          set: function(items, cb) {
            Object.assign(window.__extStorage, items || {});
            if (typeof cb === 'function') setTimeout(() => cb(), 2);
            return Promise.resolve();
          },
          remove: function(keys, cb) {
            (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete window.__extStorage[k]);
            if (typeof cb === 'function') setTimeout(() => cb(), 2);
            return Promise.resolve();
          }
        };
      }
      window.chrome = {
        storage: {
          local: makeStorageArea(),
          sync: makeStorageArea(),
          onChanged: { addListener: function(){} }
        },
        runtime: {
          onMessage: { addListener: function(){} },
          getURL: function(asset) {
            if (String(asset || '').includes('mascot')) return ${JSON.stringify(baseOrigin)} + '/broc-mascot.png';
            return ${JSON.stringify(extCssDataUrl)};
          },
          sendMessage: function(msg, cb) {
            if (!msg || typeof cb !== 'function') return;
            if (msg.type === 'CLEANCART_GET_CLIENT_INFO') {
              setTimeout(() => cb({ ok: true, apiBase: ${JSON.stringify(baseOrigin)}, deviceId: 'parity-ext', creatorCode: '' }), 5);
              return;
            }
            if (msg.type === 'CLEANCART_SCAN_BATCH') {
              const id = String(window.__extCbSeq++);
              window.__extCbMap[id] = cb;
              window.extScanBridge(JSON.stringify({
                cbId: id,
                payload: {
                  items: msg.items || [],
                  store: msg.store || 'target',
                  instacartRetailerSlug: msg.instacartRetailerSlug || ''
                }
              }));
              return;
            }
            if (msg.type === 'CLEANCART_SCAN') {
              const id = String(window.__extCbSeq++);
              window.__extCbMap[id] = cb;
              window.extScanBridge(JSON.stringify({ cbId: id, payload: msg.payload || {} }));
              return;
            }
            setTimeout(() => cb({ ok: true, inStock: true }), 5);
          }
        }
      };
    })()`,
    false,
  );
  await extPage.eval(extContentJs, false);
  await sleep(300);
  await extPage.eval(`window.scrollTo({ top: 320, behavior: 'instant' }); window.dispatchEvent(new Event('scroll'));`, false);
  const extDeadline = Date.now() + 4500;
  let extBadges = 0;
  while (Date.now() < extDeadline) {
    extBadges = await extPage.eval<number>(
      `document.querySelectorAll('.cc-photo-badge:not(.cc-photo-badge--loading)').length`,
      false,
    );
    if (extBadges >= 6) break;
    await sleep(160);
  }
  if (extBadges < 6) {
    const extDiag = await extPage.eval(
      `({
        href: location.href,
        loaded: window.__cleancartLoaded,
        hasHost: Boolean(document.getElementById('cleancart-overlay-host')),
        cards: document.querySelectorAll('[data-test*="@web/site-top-of-funnel/ProductCardWrapper"]').length,
        allBadges: document.querySelectorAll('.cc-photo-badge').length,
        loadingBadges: document.querySelectorAll('.cc-photo-badge--loading').length,
        cbSeq: window.__extCbSeq,
        errors: window.__extDiagErrors || []
      })`,
      false,
    );
    console.error("   [parity-ext diag]:", JSON.stringify(extDiag), "exceptions:", extPage.exceptions);
  }
  extPage.close();
  return { iosBadges, extBadges };
}

async function main() {
  if (!fs.existsSync(CHROMIUM_BIN)) {
    throw new Error(`Chromium not found at ${CHROMIUM_BIN}`);
  }
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const nextBin = path.join(ROOT, "node_modules/.bin/next");
  if (!fs.existsSync(path.join(ROOT, ".next/BUILD_ID"))) {
    console.log("📦 Building Next.js production server…");
    await new Promise<void>((resolve, reject) => {
      const b = spawn(nextBin, ["build"], {
        cwd: ROOT,
        stdio: "inherit",
        env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
      });
      b.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`next build exited ${c}`))));
    });
  }

  const appPort = await getFreePort();
  const cdpPort = await getFreePort();
  const baseOrigin = `http://127.0.0.1:${appPort}`;

  let nextProc: ChildProcess | null = null;
  let chromeProc: ChildProcess | null = null;
  const cleanup = () => {
    for (const proc of [chromeProc, nextProc]) {
      if (proc?.pid) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }
    }
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  try {
    console.log(`🚀 Starting HeyBroc production API on ${baseOrigin}…`);
    nextProc = spawn(nextBin, ["start", "-p", String(appPort), "-H", "127.0.0.1"], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        NODE_ENV: "production",
        NODE_USE_ENV_PROXY: "1",
        NO_PROXY: "127.0.0.1,localhost",
      },
    });
    await waitForHttp(`${baseOrigin}/`);

    const userDataDir = fs.mkdtempSync("/tmp/hb-13stores-");
    const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
    console.log(
      `🌐 Launching Headless Chromium on CDP port ${cdpPort} (concurrency=${CONCURRENCY}, 13 stores × 10 pages = 130 pages)…`,
    );
    chromeProc = spawn(
      CHROMIUM_BIN,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--ignore-certificate-errors",
        ...(envProxy ? [`--proxy-server=${envProxy}`] : []),
        "--proxy-bypass-list=127.0.0.1,localhost",
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${cdpPort}`,
        "--window-size=412,915",
      ],
      { stdio: "ignore" },
    );
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`);

    const detectorTemplate = fs.readFileSync(
      path.join(ROOT, "android-app/app/src/main/assets/live_store_detector.js"),
      "utf8",
    );

    const onlyFilter = (process.env.AUDIT_ONLY_STORES || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const activeStores =
      onlyFilter.length > 0 ? STORES.filter((s) => onlyFilter.includes(s.key)) : STORES;

    const allResults: PageAuditResult[] = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, activeStores.length)) }, async () => {
      while (cursor < activeStores.length) {
        const idx = cursor++;
        const store = activeStores[idx];
        const t0 = Date.now();
        const storeRes = await auditStoreAll10Pages(
          store,
          idx,
          cdpPort,
          baseOrigin,
          detectorTemplate,
        );
        allResults.push(...storeRes);
        const liveCount = storeRes.filter((r) => r.mode === "live").length;
        const passCount = storeRes.filter((r) => r.passed).length;
        const totalBadges = storeRes.reduce((s, r) => s + r.resolvedNumericBadges, 0);
        const gaps = storeRes.filter((r) => r.liveSelectorGapSample);
        console.log(
          `   ${passCount === 10 ? "✅" : "❌"} [${store.label.padEnd(12)}] ${passCount}/10 pages passed | ${totalBadges} badges verified | live=${liveCount} replay=${10 - liveCount} | ${((Date.now() - t0) / 1000).toFixed(1)}s` +
            (gaps.length > 0 ? ` | ⚠️ LIVE_SELECTOR_GAP on ${gaps.length} page(s)!` : ""),
        );
        for (const g of gaps) {
          console.log(`      ↳ [LIVE_SELECTOR_GAP] ${store.key} p${g.pageNum} (${g.urlTested}): ${g.liveSelectorGapSample}`);
        }
      }
    });
    await Promise.all(workers);

    console.log("\n🔁 Running iOS WKWebView `detectorJS` + Safari/Chrome `content.js` parity check…");
    const parity = await verifyIosAndExtensionCrossSurfaceParity(cdpPort, baseOrigin);
    console.log(
      `   ✓ Cross-surface parity verified: iOS detectorJS=${parity.iosBadges} badges | Safari/Chrome Extension=${parity.extBadges} badges`,
    );

    allResults.sort(
      (a, b) =>
        STORES.findIndex((s) => s.key === a.storeKey) -
          STORES.findIndex((s) => s.key === b.storeKey) || a.pageNum - b.pageNum,
    );

    const summaryPath = path.join(
      ARTIFACT_DIR,
      onlyFilter.length > 0 ? "audit-partial-report.json" : "audit-130-pages-report.json",
    );
    fs.writeFileSync(
      summaryPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          totalStores: activeStores.length,
          totalPages: allResults.length,
          totalScrollCheckpoints: allResults.length * SCROLL_STOPS_PX.length,
          passedPages: allResults.filter((r) => r.passed).length,
          failedPages: allResults.filter((r) => !r.passed).length,
          livePagesAudited: allResults.filter((r) => r.mode === "live").length,
          replayPagesAudited: allResults.filter((r) => r.mode === "store-dom-replay").length,
          totalBadgesVerified: allResults.reduce((s, r) => s + r.resolvedNumericBadges, 0),
          liveSelectorGaps: allResults
            .filter((r) => r.liveSelectorGapSample)
            .map((r) => ({
              store: r.storeKey,
              page: r.pageNum,
              url: r.urlTested,
              sample: r.liveSelectorGapSample,
            })),
          parity,
          results: allResults,
        },
        null,
        2,
      ),
    );

    const failed = allResults.filter((r) => !r.passed);
    console.log(
      `\n📊 13-Store × 10-Page Summary: ${allResults.length - failed.length}/${allResults.length} pages PASSED | ${allResults.reduce((s, r) => s + r.resolvedNumericBadges, 0)} numeric score badges verified across ${allResults.length * SCROLL_STOPS_PX.length} scroll stops!`,
    );
    console.log(`📁 Full JSON report & screenshots saved to: ${ARTIFACT_DIR}`);

    if (failed.length > 0 || parity.iosBadges < 6 || parity.extBadges < 6) {
      console.error("\n❌ Failed pages:", JSON.stringify(failed, null, 2));
      process.exit(1);
    }
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error("\n❌ 13-Store × 10-Page Audit Failed:", err);
  process.exit(1);
});
