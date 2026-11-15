#!/usr/bin/env tsx
/**
 * Real Headless Chromium End-to-End Test Suite (iPhone + Android + Safari/Chrome Extension)
 *
 * Drives `/usr/bin/chromium` over Chrome DevTools Protocol (CDP) using Node's native WebSocket:
 *   1. iPhone Native App WKWebView (`/?platform=ios`, `393x852`, `HeyBrocIOS/2.1.0`):
 *      - Verifies every store button, barcode button, label photo button, Safari setup button,
 *        and More menu item dispatches the exact WKScriptMessageHandler bridge action with 0 JS errors.
 *      - Verifies barcode scans (`window.__heybrocNativeBarcode`) and live searches open the
 *        full-width `#ios-full-product-view` (never the desktop fake-Walmart landing preview).
 *      - Verifies 16 iconic US grocery brands decode real raster front-of-pack photos (`naturalWidth >= 50`).
 *   2. Older iPhone Build Fallback (`__HEYBROC_NATIVE_LIVE_SHOP__ = false`):
 *      - Verifies `#ios-testflight-update-banner` and fallback store modal work gracefully.
 *   3. Android Mobile Chrome (`412x915`, Pixel 9 Android 16 UA) + Android Native API/Image Parity:
 *      - Verifies `/`, `/test`, `/tools`, `/swaps/hidden-valley-ranch` have 0 horizontal overflow,
 *        `/heybroc.apk` serves a valid APK binary, and Android `ScanApi` + `ScanHistoryStore`
 *        image URL resolution (`v=6` + `brand` + `code` + barcode scan) returns real raster images.
 *   4. iOS `LiveStoreBrowserViewController.swift` `detectorJS` + Safari/Chrome Extension `content.js`:
 *      - Verifies live PDP title/ingredient/barcode extraction and floating broccoli pill + Clean Swap
 *        Shadow DOM rendering and thumbnail loading on `https://www.walmart.com/ip/...`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

process.env.NO_PROXY = process.env.NO_PROXY || "127.0.0.1,localhost";
process.env.no_proxy = process.env.no_proxy || "127.0.0.1,localhost";

const ROOT = process.cwd();
const CHROMIUM_BIN = process.env.CHROMIUM_BIN || "/usr/bin/chromium";
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || "";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
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
        const port = addr.port;
        srv.close(() => resolve(port));
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

class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (val: any) => void; reject: (err: Error) => void }
  >();
  private listeners = new Map<string, Array<(params: any) => void>>();
  public exceptions: string[] = [];
  public consoleErrors: string[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      const msg = JSON.parse(raw);
      if (typeof msg.id === "number") {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          if (msg.error) {
            entry.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error)})`));
          } else {
            entry.resolve(msg.result);
          }
        }
      } else if (msg.method) {
        if (msg.method === "Runtime.exceptionThrown") {
          const details = msg.params?.exceptionDetails;
          const text =
            details?.exception?.description ||
            details?.text ||
            JSON.stringify(details);
          this.exceptions.push(text);
        } else if (msg.method === "Runtime.consoleAPICalled") {
          if (msg.params?.type === "error") {
            const args = (msg.params.args || [])
              .map((a: any) => a.value ?? a.description ?? "")
              .join(" ");
            // Ignore benign favicon or expected blocked external third-party analytics in sandbox
            if (
              !args.includes("favicon") &&
              !args.includes("posthog") &&
              !args.includes("connect.facebook.net")
            ) {
              this.consoleErrors.push(args);
            }
          }
        }
        const handlers = this.listeners.get(msg.method);
        if (handlers) {
          for (const h of handlers) h(msg.params);
        }
      }
    });
  }

  static async connect(wsUrl: string): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener("open", () => resolve(new CdpSession(ws)), { once: true });
      ws.addEventListener("error", (err) => reject(new Error(`WebSocket error: ${String(err)}`)), {
        once: true,
      });
    });
  }

  on(method: string, handler: (params: any) => void): () => void {
    const arr = this.listeners.get(method) || [];
    arr.push(handler);
    this.listeners.set(method, arr);
    return () => {
      const cur = this.listeners.get(method) || [];
      this.listeners.set(
        method,
        cur.filter((fn) => fn !== handler),
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
        `Eval exception: ${
          res.exceptionDetails.exception?.description || res.exceptionDetails.text
        }`,
      );
    }
    return res.result?.value as T;
  }

  async waitFor<T>(
    fnExpr: string,
    label: string,
    timeoutMs = 15000,
    intervalMs = 150,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        const val = await this.eval<T>(fnExpr, true);
        if (val) return val;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for ${label}${lastErr ? ` (last error: ${lastErr})` : ""}`);
  }

  async navigate(url: string): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const off = this.on("Page.loadEventFired", () => {
        off();
        resolve();
      });
      setTimeout(() => {
        off();
        resolve();
      }, 12000);
    });
    await this.send("Page.navigate", { url });
    await loaded;
    await sleep(350);
  }

  async saveScreenshot(filename: string): Promise<void> {
    if (!SCREENSHOT_DIR) return;
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    fs.writeFileSync(path.join(SCREENSHOT_DIR, filename), Buffer.from(data, "base64"));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

async function createPageTarget(cdpPort: number): Promise<CdpSession> {
  const verRes = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
  const ver = (await verRes.json()) as { webSocketDebuggerUrl: string };
  const browserSession = await CdpSession.connect(ver.webSocketDebuggerUrl);
  const { browserContextId } = await browserSession.send<{ browserContextId: string }>(
    "Target.createBrowserContext",
    { disposeOnDetach: false },
  );
  const { targetId } = await browserSession.send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
    browserContextId,
  });
  browserSession.close();

  const targetsRes = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  const targets = (await targetsRes.json()) as Array<{
    id: string;
    webSocketDebuggerUrl: string;
  }>;
  const matched = targets.find((t) => t.id === targetId);
  assert(Boolean(matched?.webSocketDebuggerUrl), `Failed to locate isolated target ${targetId}`);
  const session = await CdpSession.connect(matched!.webSocketDebuggerUrl);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("DOM.enable");
  await session.send("Network.enable");
  return session;
}

/** Mirrors Android `ScanHistoryStore.resolveBestImageUrl` for exact parity testing. */
function androidResolveBestImageUrl(
  baseOrigin: string,
  title: string,
  rawImageUrl: string,
  brand = "",
  code = "",
): string {
  let normalized = (rawImageUrl || "").trim();
  if (normalized.startsWith("/api/product-image")) {
    normalized = `${baseOrigin}${normalized}`;
  }
  normalized = normalized.replace("https://www.heybroc.com", baseOrigin);
  if (normalized.includes("/api/product-image")) {
    normalized = normalized.replace("v=4", "v=6").replace("v=5", "v=6");
    if (!normalized.includes("v=")) {
      normalized += normalized.includes("?") ? "&v=6" : "?v=6";
    }
  }
  if (
    (normalized.startsWith("https://") || normalized.startsWith("http://127.0.0.1")) &&
    !normalized.toLowerCase().includes("product-photo-unavailable") &&
    !normalized.includes("/swaps/") &&
    !normalized.includes("/products/")
  ) {
    return normalized;
  }
  const params = new URLSearchParams({ q: title.trim() });
  if (brand.trim()) params.set("brand", brand.trim());
  const cleanCode = code.replace(/\D/g, "").slice(0, 14);
  if (cleanCode.length >= 8) params.set("code", cleanCode);
  params.set("v", "6");
  return `${baseOrigin}/api/product-image?${params.toString()}`;
}

function extractSwiftDetectorJS(): string {
  const swiftPath = path.join(ROOT, "ios-app/App/LiveStoreBrowserViewController.swift");
  const src = fs.readFileSync(swiftPath, "utf8");
  const startMarker = 'let detectorJS = """';
  const startIdx = src.indexOf(startMarker);
  assert(startIdx !== -1, "Could not locate detectorJS in LiveStoreBrowserViewController.swift");
  const bodyStart = src.indexOf("\n", startIdx) + 1;
  const endIdx = src.indexOf('        """', bodyStart);
  assert(endIdx !== -1, "Could not locate closing triple-quote for detectorJS");
  // Unescape Swift multi-line string `\\` -> `\`
  return src.slice(bodyStart, endIdx).replace(/\\\\/g, "\\");
}

async function main() {
  assert(fs.existsSync(CHROMIUM_BIN), `Chromium binary not found at ${CHROMIUM_BIN}`);

  const nextBin = path.join(ROOT, "node_modules/.bin/next");
  const buildIdPath = path.join(ROOT, ".next/BUILD_ID");
  if (!fs.existsSync(buildIdPath)) {
    console.log("📦 Building Next.js production bundle before browser E2E run…");
    await new Promise<void>((resolve, reject) => {
      const b = spawn(nextBin, ["build"], {
        cwd: ROOT,
        stdio: "inherit",
        env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
      });
      b.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`next build exited ${code}`))));
    });
  }

  const appPort = Number(process.env.TEST_APP_PORT || (await getFreePort()));
  const cdpPort = await getFreePort();
  const baseOrigin = `http://127.0.0.1:${appPort}`;

  let nextProc: ChildProcess | null = null;
  let chromeProc: ChildProcess | null = null;

  const cleanup = () => {
    if (chromeProc?.pid) {
      try {
        process.kill(-chromeProc.pid, "SIGKILL");
      } catch {
        try {
          chromeProc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    if (nextProc?.pid) {
      try {
        process.kill(-nextProc.pid, "SIGKILL");
      } catch {
        try {
          nextProc.kill("SIGKILL");
        } catch {
          // ignore
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
    console.log(`🚀 Starting local Next.js server on ${baseOrigin}…`);
    nextProc = spawn(nextBin, ["start", "-p", String(appPort), "-H", "127.0.0.1"], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        NODE_ENV: "production",
        NODE_USE_ENV_PROXY: "1",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
    });
    await waitForHttp(`${baseOrigin}/`);

    const userDataDir = fs.mkdtempSync("/tmp/heybroc-chromium-");
    const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
    console.log(`🌐 Launching Headless Chromium on CDP port ${cdpPort}…`);
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
        "--proxy-bypass-list=127.0.0.1,localhost,www.walmart.com",
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${cdpPort}`,
        "--window-size=393,852",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`);

    // =========================================================================
    // SUITE 1: iPhone 16 Pro Native App WKWebView (`/?platform=ios`, Build 122)
    // =========================================================================
    console.log("\n📱 [1/4] Testing iPhone Native App WKWebView (/?platform=ios)...");
    const iosPage = await createPageTarget(cdpPort);
    await iosPage.send("Emulation.setDeviceMetricsOverride", {
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await iosPage.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await iosPage.send("Network.setUserAgentOverride", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 HeyBrocIOS/2.1.0",
      platform: "iPhone",
    });
    await iosPage.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        window.__HEYBROC_NATIVE_APPLE_AUTH__ = true;
        window.__HEYBROC_NATIVE_STOREKIT__ = true;
        window.__HEYBROC_NATIVE_LIVE_SHOP__ = true;
        window.__bridgeLog = [];
        window.webkit = {
          messageHandlers: {
            heybrocNative: {
              postMessage: function(msg) {
                window.__bridgeLog.push({ handler: "heybrocNative", msg: msg });
              }
            },
            controller: {
              postMessage: function(msg) {
                window.__bridgeLog.push({ handler: "controller", msg: msg });
              }
            }
          }
        };
      `,
    });

    await iosPage.navigate(`${baseOrigin}/?platform=ios`);
    await iosPage.waitFor(
      `Boolean(document.getElementById("ios-app-workspace") && document.getElementById("ios-shop-walmart"))`,
      "iOS app workspace to render",
    );
    await iosPage.saveScreenshot("iphone-home.png");

    const iosInitialState = await iosPage.eval<{
      hasWorkspace: boolean;
      hasUpdateBanner: boolean;
      hasFakeWalmartDesktop: boolean;
      scrollWidth: number;
      innerWidth: number;
    }>(`({
      hasWorkspace: Boolean(document.getElementById("ios-app-workspace")),
      hasUpdateBanner: Boolean(document.getElementById("ios-testflight-update-banner")),
      hasFakeWalmartDesktop: Boolean(document.querySelector(".store-frame, .walmart-bar")),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth
    })`);
    assert(iosInitialState.hasWorkspace, "Expected #ios-app-workspace on iPhone app launch");
    assert(
      !iosInitialState.hasUpdateBanner,
      "Expected #ios-testflight-update-banner to be hidden when __HEYBROC_NATIVE_LIVE_SHOP__ is true",
    );
    assert(
      !iosInitialState.hasFakeWalmartDesktop,
      "Desktop fake-Walmart preview must NEVER render inside #ios-app-workspace",
    );
    assert(
      iosInitialState.scrollWidth <= iosInitialState.innerWidth + 2,
      `iPhone home horizontal overflow: scrollWidth=${iosInitialState.scrollWidth} > innerWidth=${iosInitialState.innerWidth}`,
    );

    // Click every store button + barcode button + Safari guide button + More menu buttons
    const storeButtonChecks: Array<[string, string]> = [
      ["ios-shop-walmart", "walmart"],
      ["ios-shop-instacart", "instacart"],
      ["ios-shop-target", "target"],
      ["ios-shop-amazon", "amazon"],
      ["ios-shop-costco", "costco"],
      ["ios-shop-kroger", "kroger"],
      ["ios-shop-aldi", "aldi"],
      ["ios-shop-sams", "sams"],
    ];
    for (const [btnId, expectedStore] of storeButtonChecks) {
      const dispatched = await iosPage.eval<{ ok: boolean; last: any }>(`(() => {
        window.__bridgeLog = [];
        const btn = document.getElementById(${JSON.stringify(btnId)});
        if (!btn) return { ok: false, last: null };
        btn.click();
        const hit = window.__bridgeLog.find((e) => {
          const m = e.msg;
          const act = typeof m === "string" ? m : (m && (m.action || m.type));
          return act === "open-live-shop" || act === "openStoreBrowser";
        });
        return { ok: Boolean(hit && hit.msg && hit.msg.store === ${JSON.stringify(expectedStore)}), last: hit || window.__bridgeLog };
      })()`);
      assert(
        dispatched.ok,
        `Clicking #${btnId} did not dispatch live store browser for ${expectedStore}: ${JSON.stringify(dispatched.last)}`,
      );
    }
    console.log("   ✓ All 8 iPhone store buttons dispatch native LiveStoreBrowser cleanly");

    const barcodeAndSetupChecks = await iosPage.eval<{
      barcodeDispatched: boolean;
      webScannerStayedClosed: boolean;
      safariSetupDispatched: boolean;
      moreMenuLiveShopDispatched: boolean;
    }>(`(async () => {
      window.__bridgeLog = [];
      document.getElementById("ios-scan-barcode-btn")?.click();
      await new Promise((r) => setTimeout(r, 80));
      const barcodeHit = window.__bridgeLog.some((e) => {
        const m = e.msg;
        return m === "open-barcode-scanner" || (m && m.action === "open-barcode-scanner");
      });
      const webScannerBoxVisible = document.body.innerText.includes("Align the target item's barcode") ||
        document.body.innerText.includes("Camera access is unavailable");

      window.__bridgeLog = [];
      document.getElementById("ios-open-pill-setup")?.click();
      await new Promise((r) => setTimeout(r, 60));
      const safariHit = window.__bridgeLog.some((e) => {
        const m = e.msg;
        return m === "open-safari-setup" || (m && m.action === "open-safari-setup");
      });

      window.__bridgeLog = [];
      document.getElementById("topbar-more-menu-btn")?.click();
      await new Promise((r) => setTimeout(r, 80));
      document.getElementById("open-ios-live-shop")?.click();
      await new Promise((r) => setTimeout(r, 80));
      const moreLiveHit = window.__bridgeLog.some((e) => {
        const m = e.msg;
        const act = typeof m === "string" ? m : (m && (m.action || m.type));
        return act === "open-live-shop" || act === "openStoreBrowser";
      });

      return {
        barcodeDispatched: barcodeHit,
        webScannerStayedClosed: !webScannerBoxVisible,
        safariSetupDispatched: safariHit,
        moreMenuLiveShopDispatched: moreLiveHit
      };
    })()`);
    assert(barcodeAndSetupChecks.barcodeDispatched, "#ios-scan-barcode-btn must dispatch open-barcode-scanner");
    assert(
      barcodeAndSetupChecks.webScannerStayedClosed,
      "#ios-scan-barcode-btn must NOT flash the web barcode fallback box on native iOS",
    );
    assert(barcodeAndSetupChecks.safariSetupDispatched, "#ios-open-pill-setup must dispatch open-safari-setup");
    assert(
      barcodeAndSetupChecks.moreMenuLiveShopDispatched,
      "Topbar More -> #open-ios-live-shop must dispatch native live store browser",
    );
    console.log("   ✓ Barcode scanner, Safari Pill Guide, and More menu bridges verified");

    // Reset active store to Walmart, then simulate native barcode scan for Hidden Valley Original Ranch (0071100003116)
    await iosPage.eval(`(() => {
      document.getElementById("ios-shop-walmart")?.click();
      window.__heybrocNativeBarcode("0071100003116");
    })()`);
    const hvCard = await iosPage.waitFor<{
      title: string;
      hasFullView: boolean;
      hasFakeWalmart: boolean;
      prodImgOk: boolean;
      prodImgSrc: string;
      prodImgW: number;
      swapImgOk: boolean;
      swapImgSrc: string;
    }>(
      `(() => {
        const view = document.getElementById("ios-full-product-view");
        if (!view || view.innerText.includes("Scoring ingredients") || view.innerText.includes("Looking up verified")) return null;
        const txt = view.innerText || "";
        if (!/hidden\\s+valley/i.test(txt)) return null;
        if (view.querySelector(".product-art--missing-photo")) {
          throw new Error("Hidden Valley Ranch rendered .product-art--missing-photo placeholder!");
        }
        const imgs = Array.from(view.querySelectorAll("img"));
        if (imgs.length === 0 || imgs.some((img) => !img.complete || img.naturalWidth === 0)) return null;
        const prodImg = imgs[0];
        const swapImg = imgs.length > 1 ? imgs[1] : null;
        return {
          title: (view.querySelector("h2")?.textContent || "").trim(),
          hasFullView: true,
          hasFakeWalmart: Boolean(document.querySelector(".store-frame, .walmart-bar")),
          prodImgOk: Boolean(prodImg && prodImg.complete && prodImg.naturalWidth >= 80 && !prodImg.currentSrc.includes("product-photo-unavailable")),
          prodImgSrc: prodImg?.currentSrc || "",
          prodImgW: prodImg?.naturalWidth || 0,
          swapImgOk: swapImg ? Boolean(swapImg.complete && swapImg.naturalWidth >= 80 && !swapImg.currentSrc.includes("product-photo-unavailable")) : true,
          swapImgSrc: swapImg?.currentSrc || ""
        };
      })()`,
      "Hidden Valley Ranch full-width iOS scan view & decoded photos",
      20000,
    );
    await iosPage.saveScreenshot("iphone-hidden-valley.png");
    assert(hvCard.hasFullView && !hvCard.hasFakeWalmart, "Barcode scan must render #ios-full-product-view");
    assert(
      !/^[a-z]/.test(hvCard.title),
      `Product heading should be cleanly capitalized, got "${hvCard.title}"`,
    );
    assert(
      hvCard.prodImgOk,
      `Hidden Valley Ranch photo failed to decode real pixels (${hvCard.prodImgSrc}, naturalWidth=${hvCard.prodImgW})`,
    );
    assert(
      hvCard.swapImgOk,
      `Hidden Valley Ranch Clean Swap photo failed to decode (${hvCard.swapImgSrc})`,
    );
    console.log(
      `   ✓ Barcode scan 0071100003116 -> "${hvCard.title}" rendered full-width card with ${hvCard.prodImgW}px product photo + Clean Swap photo`,
    );

    // Test 15 additional iconic US grocery brands inside headless Chromium to verify real raster photos!
    const popularBrands = [
      "Heinz Tomato Ketchup",
      "Hellmann's Real Mayonnaise",
      "Kraft Macaroni & Cheese Original",
      "Oreo Chocolate Sandwich Cookies",
      "Doritos Nacho Cheese",
      "Cheez-It Original Crackers",
      "General Mills Cheerios",
      "Jif Creamy Peanut Butter",
      "French's Classic Yellow Mustard",
      "Coca-Cola Classic",
      "Chobani Non-Fat Plain Greek Yogurt",
      "Stonyfield Organic Whole Milk Plain Yogurt",
      "Dave's Killer Bread 21 Whole Grains",
      "Campbell's Condensed Tomato Soup",
      "Nutella Hazelnut Spread",
    ];
    for (const brandQuery of popularBrands) {
      await iosPage.eval(`(() => {
        const input = document.getElementById("ios-app-search-input");
        if (!input) throw new Error("Missing #ios-app-search-input");
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, ${JSON.stringify(brandQuery)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.closest("form")?.requestSubmit();
      })()`);
      const firstToken = brandQuery
        .split(/[^a-zA-Z0-9]+/)[0]
        .toLowerCase();
      const check = await iosPage.waitFor<{
        heading: string;
        imgW: number;
        imgSrc: string;
      }>(
        `(() => {
          const view = document.getElementById("ios-full-product-view");
          if (!view || view.innerText.includes("Scoring ingredients") || view.innerText.includes("Looking up verified")) return null;
          const h2 = (view.querySelector("h2")?.textContent || "").trim();
          const fullText = (view.innerText || "").toLowerCase();
          if (!fullText.includes(${JSON.stringify(firstToken)})) return null;
          const heroMissing = view.querySelector(".yuka-hero-img.product-art--missing-photo");
          if (heroMissing) {
            throw new Error("Rendered missing-photo placeholder for " + ${JSON.stringify(brandQuery)});
          }
          const prodImg = view.querySelector("img");
          if (!prodImg || !prodImg.complete || prodImg.naturalWidth === 0) return null;
          if (prodImg.naturalWidth < 50 || prodImg.currentSrc.includes("product-photo-unavailable")) {
            throw new Error("Missing raster photo for " + ${JSON.stringify(brandQuery)} + " -> src=" + prodImg.currentSrc + " w=" + prodImg.naturalWidth);
          }
          return { heading: h2, imgW: prodImg.naturalWidth, imgSrc: prodImg.currentSrc };
        })()`,
        `Live search + raster photo for "${brandQuery}"`,
        20000,
      );
      assert(
        !/^[,:\-–—]/.test(check.heading),
        `Product heading should not start with punctuation: "${check.heading}"`,
      );
      console.log(`   ✓ Photo verified: ${brandQuery} -> "${check.heading}" (${check.imgW}px)`);
    }

    assert(
      iosPage.exceptions.length === 0,
      `Uncaught JS exceptions on iPhone app: ${iosPage.exceptions.join(" | ")}`,
    );
    iosPage.close();

    // =========================================================================
    // SUITE 2: Older iPhone Build Fallback Check (`__HEYBROC_NATIVE_LIVE_SHOP__ = false`)
    // =========================================================================
    console.log("\n📲 [2/4] Testing Legacy iPhone Build Fallback Banner & Sheet...");
    const legacyIosPage = await createPageTarget(cdpPort);
    await legacyIosPage.send("Emulation.setDeviceMetricsOverride", {
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await legacyIosPage.send("Network.setUserAgentOverride", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 HeyBrocIOS/1.0",
      platform: "iPhone",
    });
    await legacyIosPage.navigate(`${baseOrigin}/?platform=ios`);
    await legacyIosPage.waitFor(
      `Boolean(document.getElementById("ios-testflight-update-banner"))`,
      "Legacy TestFlight update banner",
    );
    await legacyIosPage.eval(`document.getElementById("ios-shop-walmart")?.click()`);
    await legacyIosPage.waitFor(
      `document.body.innerText.includes("Update HeyBroc in TestFlight to Open Walmart Inside the App")`,
      "Legacy build fallback store sheet",
    );
    console.log("   ✓ Legacy TestFlight update banner & fallback store sheet verified");
    legacyIosPage.close();

    // =========================================================================
    // SUITE 3: Android Mobile Web (`412x915`, Pixel 9) + Android Native API/Image Parity
    // =========================================================================
    console.log("\n🤖 [3/4] Testing Android Chrome Mobile Web & Android Native API/Image Parity...");
    const androidPage = await createPageTarget(cdpPort);
    await androidPage.send("Emulation.setDeviceMetricsOverride", {
      width: 412,
      height: 915,
      deviceScaleFactor: 2.625,
      mobile: true,
    });
    await androidPage.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await androidPage.send("Network.setUserAgentOverride", {
      userAgent:
        "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36",
      platform: "Linux armv8l",
    });

    for (const route of ["/", "/test", "/tools", "/swaps/hidden-valley-ranch"]) {
      await androidPage.navigate(`${baseOrigin}${route}`);
      const metrics = await androidPage.eval<{
        scrollWidth: number;
        innerWidth: number;
        titleLen: number;
        hasIosWorkspace: boolean;
      }>(`({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        titleLen: document.body.innerText.trim().length,
        hasIosWorkspace: Boolean(document.getElementById("ios-app-workspace"))
      })`);
      assert(metrics.titleLen > 80, `Android route ${route} rendered empty body`);
      assert(!metrics.hasIosWorkspace, `Android route ${route} must NEVER render #ios-app-workspace`);
      assert(
        metrics.scrollWidth <= metrics.innerWidth + 2,
        `Android route ${route} has horizontal overflow: scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}`,
      );
      if (route === "/") {
        await androidPage.saveScreenshot("android-home.png");
      }
    }

    // Verify /test interactive Free 3-Second Grocery Score Test on Android
    await androidPage.navigate(`${baseOrigin}/test`);
    await androidPage.waitFor(
      `Boolean(document.getElementById("ad-free-test-hero"))`,
      "Android /test Free Score Test hero",
    );
    await androidPage.eval(`(() => {
      const firstPreset = document.querySelector('[id^="ad-test-"]');
      if (firstPreset instanceof HTMLElement) firstPreset.click();
    })()`);
    await androidPage.waitFor(
      `Boolean(document.getElementById("ad-test-step2-cta"))`,
      "Android /test Step 2 CTA after tapping preset",
    );

    // Verify /heybroc.apk downloadable Android binary
    const apkHead = await fetch(`${baseOrigin}/heybroc.apk`, { method: "HEAD" });
    assert(apkHead.status === 200, `Expected /heybroc.apk HTTP 200, got ${apkHead.status}`);
    const apkLen = Number(apkHead.headers.get("content-length") || "0");
    assert(apkLen > 500_000, `Expected /heybroc.apk size > 500KB, got ${apkLen}`);

    // Verify Android ScanApi (including UPC barcode input!) + ScanHistoryStore.resolveBestImageUrl
    const androidScanCases = [
      { productTitle: "0071100003116", barcode: "0071100003116", expectMatch: /hidden\s+valley/i },
      { productTitle: "Heinz Tomato Ketchup", barcode: "", expectMatch: /heinz/i },
      { productTitle: "Hellmann's Real Mayonnaise", barcode: "", expectMatch: /hellmann/i },
      { productTitle: "Hidden Valley Original Ranch", barcode: "", expectMatch: /hidden\s+valley/i },
    ];
    for (const tc of androidScanCases) {
      const scanRes = await fetch(`${baseOrigin}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productTitle: tc.productTitle,
          ...(tc.barcode ? { barcode: tc.barcode } : {}),
          store: "walmart",
          surface: "android",
          format: "json",
        }),
      });
      assert(scanRes.status === 200, `Android /api/scan HTTP ${scanRes.status} for ${tc.productTitle}`);
      const json = (await scanRes.json()) as any;
      assert(json.ok === true, `Android /api/scan ok=false for ${tc.productTitle}: ${JSON.stringify(json)}`);
      assert(
        tc.expectMatch.test(json.product?.title || ""),
        `Android /api/scan unexpected title "${json.product?.title}" for ${tc.productTitle}`,
      );

      const resolvedProdImg = androidResolveBestImageUrl(
        baseOrigin,
        json.product.title,
        json.product.imageUrl || "",
        json.product.brand || "",
        json.product.barcode || json.lookup?.barcode || "",
      );
      const imgResp = await fetch(resolvedProdImg);
      const cType = imgResp.headers.get("content-type") || "";
      const imgBytes = await imgResp.arrayBuffer();
      assert(
        imgResp.status === 200 &&
          (cType.includes("image/jpeg") || cType.includes("image/png") || cType.includes("image/webp")) &&
          imgBytes.byteLength > 1500,
        `Android resolved product image failed raster check (${resolvedProdImg} -> status=${imgResp.status}, type=${cType}, bytes=${imgBytes.byteLength})`,
      );

      if (json.swap?.title) {
        const resolvedSwapImg = androidResolveBestImageUrl(
          baseOrigin,
          json.swap.title,
          json.swap.imageUrl || json.swap.image || "",
          json.swap.brand || "",
        );
        const swResp = await fetch(resolvedSwapImg);
        const swType = swResp.headers.get("content-type") || "";
        const swBytes = await swResp.arrayBuffer();
        assert(
          swResp.status === 200 &&
            (swType.includes("image/jpeg") || swType.includes("image/png") || swType.includes("image/webp")) &&
            swBytes.byteLength > 1500,
          `Android resolved swap image failed raster check (${resolvedSwapImg} -> status=${swResp.status}, type=${swType}, bytes=${swBytes.byteLength})`,
        );
      }
    }
    assert(
      androidPage.exceptions.length === 0,
      `Uncaught JS exceptions on Android web: ${androidPage.exceptions.join(" | ")}`,
    );
    console.log("   ✓ Android responsive pages, /test funnel, /heybroc.apk, UPC scan, and raster image URLs verified");
    androidPage.close();

    // =========================================================================
    // SUITE 4: iOS LiveStoreBrowser `detectorJS` + Safari/Chrome Extension `content.js`
    // =========================================================================
    console.log("\n🥦 [4/4] Testing LiveStoreBrowser detectorJS & Safari/Chrome Extension Overlay on Walmart PDP...");
    const detectorJS = extractSwiftDetectorJS();
    const extContentJS = fs.readFileSync(
      path.join(ROOT, "ios-app/SafariExtension/Resources/content.js"),
      "utf8",
    );
    const extOverlayCSS = fs.readFileSync(
      path.join(ROOT, "ios-app/SafariExtension/Resources/overlay.css"),
      "utf8",
    );

    const walmartFixtureHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Hidden Valley Original Ranch Salad Dressing &amp; Topping, 16 fl oz - Walmart.com</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": "Hidden Valley Original Ranch Salad Dressing & Topping, Gluten Free, 16 fl oz",
    "gtin13": "0071100003116"
  }
  </script>
</head>
<body style="font-family: system-ui, sans-serif; padding: 20px; margin: 0; background: #f8fafc;">
  <main>
    <div style="background:#fff; border-radius:16px; padding:18px; border:1px solid #e2e8f0;">
      <span style="font-size:12px; color:#0071dc; font-weight:700;">Walmart Grocery Pickup &amp; Delivery</span>
      <h1 itemprop="name" data-automation-id="product-title" style="font-size:20px; margin:8px 0 12px; color:#0f172a;">
        Hidden Valley Original Ranch Salad Dressing &amp; Topping, Gluten Free, 16 fl oz
      </h1>
      <button type="button" style="background:#0071dc; color:#fff; border:none; border-radius:999px; padding:12px 22px; font-weight:700;">
        Add to cart
      </button>
      <section style="margin-top:18px;">
        <h3 style="font-size:15px; margin:0 0 6px;">Ingredients</h3>
        <p style="font-size:13.5px; color:#334155; line-height:1.5;">
          Vegetable Oil (Soybean and/or Canola), Water, Egg Yolk, Sugar, Salt, Cultured Nonfat Buttermilk, Natural Flavors, Less than 1% of: Spices (Includes Mustard), Dried Garlic, Dried Onion, Vinegar, Phosphoric Acid, Xanthan Gum, Modified Food Starch, Monosodium Glutamate, Artificial Flavors, Disodium Inosinate, Disodium Guanylate, Calcium Disodium EDTA to Protect Flavor, Sorbic Acid and Sodium Benzoate as Preservatives.
        </p>
      </section>
    </div>
  </main>
</body>
</html>`;

    const storePage = await createPageTarget(cdpPort);
    await storePage.send("Emulation.setDeviceMetricsOverride", {
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await storePage.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await storePage.send("Network.setUserAgentOverride", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
    });

    // Intercept https://www.walmart.com/* and https://www.heybroc.com/* locally via CDP Fetch
    // so no external Walmart request is hit and HTTPS->HTTPS extension calls hit our local Next.js build!
    await storePage.send("Fetch.enable", {
      patterns: [
        { urlPattern: "https://www.walmart.com/*", requestStage: "Request" },
        { urlPattern: "https://www.heybroc.com/*", requestStage: "Request" },
      ],
    });
    storePage.on("Fetch.requestPaused", (params) => {
      const reqUrl: string = params.request?.url || "";
      if (reqUrl.startsWith("https://www.heybroc.com/")) {
        const localUrl = reqUrl.replace("https://www.heybroc.com", baseOrigin);
        const method: string = params.request?.method || "GET";
        if (method === "OPTIONS") {
          void storePage.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: 204,
            responseHeaders: [
              { name: "Access-Control-Allow-Origin", value: "*" },
              { name: "Access-Control-Allow-Methods", value: "GET, HEAD, POST, OPTIONS" },
              { name: "Access-Control-Allow-Headers", value: "*" },
            ],
          });
          return;
        }
        const postData: string | undefined = params.request?.postData;
        void (async () => {
          try {
            const upstream = await fetch(localUrl, {
              method,
              headers: postData ? { "Content-Type": "application/json" } : undefined,
              body: method === "POST" && postData ? postData : undefined,
              redirect: "follow",
            });
            const buf = Buffer.from(await upstream.arrayBuffer());
            const hdrs: Array<{ name: string; value: string }> = [
              { name: "Access-Control-Allow-Origin", value: "*" },
              {
                name: "Access-Control-Expose-Headers",
                value: "X-Image-Source, X-Image-License, Content-Type",
              },
            ];
            const ct = upstream.headers.get("content-type");
            if (ct) hdrs.push({ name: "Content-Type", value: ct });
            const imgSrc = upstream.headers.get("x-image-source");
            if (imgSrc) hdrs.push({ name: "X-Image-Source", value: imgSrc });
            const imgLic = upstream.headers.get("x-image-license");
            if (imgLic) hdrs.push({ name: "X-Image-License", value: imgLic });
            await storePage.send("Fetch.fulfillRequest", {
              requestId: params.requestId,
              responseCode: upstream.status,
              responseHeaders: hdrs,
              body: method === "HEAD" ? undefined : buf.toString("base64"),
            });
          } catch (err) {
            await storePage.send("Fetch.fulfillRequest", {
              requestId: params.requestId,
              responseCode: 502,
              responseHeaders: [
                { name: "Content-Type", value: "text/plain" },
                { name: "Access-Control-Allow-Origin", value: "*" },
              ],
              body: Buffer.from(String(err), "utf8").toString("base64"),
            });
          }
        })();
        return;
      }
      if (reqUrl.startsWith("https://www.walmart.com/ip/Hidden-Valley")) {
        void storePage.send("Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "Content-Type", value: "text/html; charset=utf-8" },
            { name: "Access-Control-Allow-Origin", value: "*" },
          ],
          body: Buffer.from(walmartFixtureHtml, "utf8").toString("base64"),
        });
      } else if (
        reqUrl.startsWith("https://www.walmart.com/ip/") ||
        reqUrl.startsWith("https://www.walmart.com/search")
      ) {
        const searchFixture = `<!doctype html><html><body><div data-item-id="998877"><h1 data-automation-id="product-title">Primal Kitchen Ranch Dressing &amp; Marinade Made with Avocado Oil, 8 fl oz</h1><button>Add to cart</button></div></body></html>`;
        void storePage.send("Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "Content-Type", value: "text/html; charset=utf-8" },
            { name: "Access-Control-Allow-Origin", value: "*" },
          ],
          body: Buffer.from(searchFixture, "utf8").toString("base64"),
        });
      } else {
        // Any stray relative request to www.walmart.com (e.g. if a relative /api/... or /swaps/... leaked!) returns 404 immediately!
        void storePage.send("Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: 404,
          responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
          body: Buffer.from("Not Found on Walmart", "utf8").toString("base64"),
        });
      }
    });

    await storePage.navigate(
      "https://www.walmart.com/ip/Hidden-Valley-Original-Ranch/10451461",
    );

    // 4A. Verify iOS LiveStoreBrowserViewController.swift `detectorJS`
    await storePage.eval(`
      window.__storeBridgeMessages = [];
      window.webkit = {
        messageHandlers: {
          heybrocStoreBridge: {
            postMessage: function(msg) {
              window.__storeBridgeMessages.push(msg);
            }
          }
        }
      };
    `);
    await storePage.eval(detectorJS, false);
    const detectedPdp = await storePage.waitFor<{
      kind: string;
      title: string;
      ingredients: string;
      barcode: string;
    }>(
      `window.__storeBridgeMessages.find((m) => m && m.kind === "product") || null`,
      "LiveStoreBrowser detectorJS PDP detection",
      6000,
    );
    assert(
      /hidden\s+valley/i.test(detectedPdp.title),
      `detectorJS extracted wrong title: ${detectedPdp.title}`,
    );
    assert(
      /soybean/i.test(detectedPdp.ingredients) && /monosodium\s+glutamate/i.test(detectedPdp.ingredients),
      `detectorJS failed to extract Walmart ingredients: ${detectedPdp.ingredients}`,
    );
    assert(
      detectedPdp.barcode === "0071100003116",
      `detectorJS failed to extract JSON-LD GTIN barcode: ${detectedPdp.barcode}`,
    );
    console.log(
      `   ✓ LiveStoreBrowser detectorJS extracted title, ingredients & GTIN (${detectedPdp.barcode})`,
    );

    // 4B. Inject Safari Extension `content.js` + `overlay.css` with chrome.runtime mock forwarding to local Next.js!
    const extOverlayCssDataUrl = `data:text/css;charset=utf-8;base64,${Buffer.from(extOverlayCSS, "utf8").toString("base64")}`;
    await storePage.eval(`
      window.__heybrocApiBase = "https://www.heybroc.com";
      window.__heybrocOverlayCssUrl = ${JSON.stringify(extOverlayCssDataUrl)};
      window.__heybrocExtStorage = {};
      window.chrome = {
        storage: {
          local: {
            get: function(keys, cb) {
              const out = {};
              if (Array.isArray(keys)) {
                keys.forEach((k) => { if (k in window.__heybrocExtStorage) out[k] = window.__heybrocExtStorage[k]; });
              } else if (typeof keys === "string") {
                if (keys in window.__heybrocExtStorage) out[keys] = window.__heybrocExtStorage[keys];
              } else if (keys && typeof keys === "object") {
                Object.keys(keys).forEach((k) => {
                  out[k] = k in window.__heybrocExtStorage ? window.__heybrocExtStorage[k] : keys[k];
                });
              } else {
                Object.assign(out, window.__heybrocExtStorage);
              }
              if (typeof cb === "function") setTimeout(() => cb(out), 2);
              return Promise.resolve(out);
            },
            set: function(items, cb) {
              Object.assign(window.__heybrocExtStorage, items || {});
              if (typeof cb === "function") setTimeout(() => cb(), 2);
              return Promise.resolve();
            },
            remove: function(keys, cb) {
              (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete window.__heybrocExtStorage[k]);
              if (typeof cb === "function") setTimeout(() => cb(), 2);
              return Promise.resolve();
            }
          },
          onChanged: {
            addListener: function() {}
          }
        },
        runtime: {
          onMessage: {
            addListener: function() {}
          },
          getURL: function(asset) {
            if (asset.includes("mascot")) return window.__heybrocApiBase + "/broc-mascot.png";
            return window.__heybrocOverlayCssUrl;
          },
          sendMessage: function(msg, cb) {
            if (!msg || typeof cb !== "function") return;
            if (msg.type === "CLEANCART_GET_CLIENT_INFO") {
              setTimeout(() => cb({ ok: true, apiBase: window.__heybrocApiBase, deviceId: "e2e-ios-safari", creatorCode: "" }), 5);
              return;
            }
            if (msg.type === "CLEANCART_SCAN") {
              fetch(window.__heybrocApiBase + "/api/scan", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(Object.assign({}, msg.payload || {}, { surface: "extension", format: "json" }))
              })
                .then((r) => r.json())
                .then((data) => cb(data))
                .catch((err) => cb({ ok: false, error: String(err) }));
              return;
            }
            if (msg.type === "CLEANCART_CHECK_URL_STOCK") {
              setTimeout(() => cb({ ok: true, inStock: true }), 5);
              return;
            }
            setTimeout(() => cb({ ok: true }), 5);
          }
        }
      };
    `);
    await storePage.eval(extContentJS, false);

    // Wait for floating broccoli pill to score Hidden Valley Ranch
    const pillState = await storePage.waitFor<{
      ringVal: string;
      primaryText: string;
    }>(
      `(() => {
        const host = document.getElementById("cleancart-overlay-host");
        const pill = host?.shadowRoot?.querySelector(".cc-pill");
        if (!pill || pill.hidden) return null;
        const val = (pill.querySelector(".cc-mini-ring-val")?.textContent || "").trim();
        if (!/^\\d+$/.test(val)) return null;
        return {
          ringVal: val,
          primaryText: (pill.querySelector(".cc-pill-primary")?.textContent || "").trim()
        };
      })()`,
      "Safari Extension floating broccoli pill score on Walmart PDP",
      15000,
    );
    const numericScore = Number(pillState.ringVal);
    assert(
      numericScore >= 0 && numericScore < 50,
      `Expected Hidden Valley Ranch poor score (<50) on Walmart pill, got ${pillState.ringVal}`,
    );

    // Tap the floating broccoli pill to expand the Clean Swap drawer and verify BOTH thumbnails load real pixels!
    await storePage.eval(`(() => {
      const pill = document.getElementById("cleancart-overlay-host")?.shadowRoot?.querySelector(".cc-pill");
      pill?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    })()`);

    let drawerState: {
      cardText: string;
      prodThumbSrc: string;
      prodThumbW: number;
      swapThumbSrc: string;
      swapThumbW: number;
    };
    try {
      drawerState = await storePage.waitFor(
        `(() => {
          const sr = document.getElementById("cleancart-overlay-host")?.shadowRoot;
          const card = sr?.querySelector(".cc-card");
          if (!card) return null;
          if (card.querySelector(".cc-thumb-empty")) {
            throw new Error("Extension drawer rendered .cc-thumb-empty placeholder: " + card.innerHTML.slice(0, 300));
          }
          const prodImg = card.querySelector("img.cc-prod-thumb");
          const swapImg = card.querySelector("img.cc-swap-thumb");
          if (!prodImg || !swapImg || !prodImg.complete || !swapImg.complete || prodImg.naturalWidth === 0 || swapImg.naturalWidth === 0) return null;
          return {
            cardText: (card.textContent || "").replace(/\\s+/g, " ").trim(),
            prodThumbSrc: prodImg.currentSrc || prodImg.src,
            prodThumbW: prodImg.naturalWidth,
            swapThumbSrc: swapImg.currentSrc || swapImg.src,
            swapThumbW: swapImg.naturalWidth
          };
        })()`,
        "Safari Extension drawer product + Clean Swap raster thumbnails",
        15000,
      );
    } catch (err) {
      const diag = await storePage.eval<unknown>(`(() => {
        const sr = document.getElementById("cleancart-overlay-host")?.shadowRoot;
        const card = sr?.querySelector(".cc-card");
        const prodImg = card?.querySelector("img.cc-prod-thumb");
        const swapImg = card?.querySelector("img.cc-swap-thumb");
        return {
          hasCard: Boolean(card),
          cardText: (card?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 300),
          prodSrc: prodImg?.getAttribute("src") || null,
          prodComplete: prodImg?.complete ?? null,
          prodW: prodImg?.naturalWidth ?? null,
          swapSrc: swapImg?.getAttribute("src") || null,
          swapComplete: swapImg?.complete ?? null,
          swapW: swapImg?.naturalWidth ?? null
        };
      })()`);
      console.error("   [DIAGNOSTIC] Extension drawer state at timeout:", JSON.stringify(diag, null, 2));
      throw err;
    }
    await storePage.saveScreenshot("extension-walmart-pill.png");

    const foldVisibility = await storePage.eval<{
      gaugeVisible: boolean;
      swapVisible: boolean;
      gaugeBottom: number;
      swapBottom: number;
      vh: number;
    }>(`(() => {
      const sr = document.getElementById("cleancart-overlay-host")?.shadowRoot;
      const gauge = sr?.querySelector(".cc-gauge")?.getBoundingClientRect();
      const swap = sr?.querySelector(".cc-swap")?.getBoundingClientRect();
      const vh = window.innerHeight;
      return {
        gaugeVisible: Boolean(gauge && gauge.width >= 80 && gauge.top >= 0 && gauge.bottom <= vh),
        swapVisible: Boolean(swap && swap.height >= 40 && swap.top >= 0 && swap.bottom <= vh),
        gaugeBottom: Math.round(gauge?.bottom || 0),
        swapBottom: Math.round(swap?.bottom || 0),
        vh
      };
    })()`);
    assert(
      foldVisibility.gaugeVisible && foldVisibility.swapVisible,
      `Extension drawer gauge or Clean Swap pushed below the fold: ${JSON.stringify(foldVisibility)}`,
    );
    assert(
      !drawerState.prodThumbSrc.startsWith("https://www.walmart.com/") && drawerState.prodThumbW >= 40,
      `Extension product thumbnail broke (${drawerState.prodThumbSrc}, w=${drawerState.prodThumbW})`,
    );
    assert(
      !drawerState.swapThumbSrc.startsWith("https://www.walmart.com/") && drawerState.swapThumbW >= 40,
      `Extension swap thumbnail broke (${drawerState.swapThumbSrc}, w=${drawerState.swapThumbW})`,
    );
    assert(
      /primal\s+kitchen/i.test(drawerState.cardText),
      `Expected Clean Swap (Primal Kitchen) inside extension drawer, got: ${drawerState.cardText.slice(0, 220)}`,
    );
    assert(
      storePage.exceptions.length === 0,
      `Uncaught JS exceptions on store extension page: ${storePage.exceptions.join(" | ")}`,
    );
    console.log(
      `   ✓ Safari/Chrome Extension pill (${pillState.ringVal}/100) + Clean Swap drawer + thumbnails (${drawerState.prodThumbW}px / ${drawerState.swapThumbW}px) verified!`,
    );
    storePage.close();

    console.log("\n✅ ALL HEADLESS BROWSER E2E SUITES PASSED (iPhone + Android + Safari/Chrome Extension)!");
  } finally {
    cleanup();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n❌ HEADLESS BROWSER E2E FAILED:", err);
    process.exit(1);
  });
