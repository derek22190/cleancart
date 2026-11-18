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

    let offCdnReachable = false;
    try {
      const probe = await fetch(
        "https://images.openfoodfacts.org/images/products/007/110/000/3116/front_en.7.400.jpg",
        { method: "HEAD", signal: AbortSignal.timeout(2500) },
      );
      offCdnReachable = probe.status >= 200 && probe.status < 400;
    } catch {
      offCdnReachable = false;
    }
    const offlineStubJpegBase64 = fs
      .readFileSync(path.join(ROOT, "public/swaps/ranch.jpg"))
      .toString("base64");
    const offlineStubJpegBytes = fs.readFileSync(path.join(ROOT, "public/swaps/ranch.jpg"));

    async function enableOfflineOffPhotoStub(page: CdpSession): Promise<void> {
      if (offCdnReachable) return;
      await page.send("Fetch.enable", {
        patterns: [{ urlPattern: "https://images.openfoodfacts.org/*", requestStage: "Request" }],
      });
      page.on("Fetch.requestPaused", (params) => {
        const reqUrl: string = params.request?.url || "";
        if (reqUrl.startsWith("https://images.openfoodfacts.org/")) {
          void page.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "Content-Type", value: "image/jpeg" },
              { name: "Access-Control-Allow-Origin", value: "*" },
              { name: "Cache-Control", value: "public, max-age=3600" },
            ],
            body: offlineStubJpegBase64,
          });
        } else {
          void page.send("Fetch.continueRequest", { requestId: params.requestId });
        }
      });
    }

    const userDataDir = fs.mkdtempSync("/tmp/heybroc-chromium-");
    const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
    console.log(
      `🌐 Launching Headless Chromium on CDP port ${cdpPort}${offCdnReachable ? "" : " (offline OFF photo fixture mode)"}…`,
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
        `--proxy-bypass-list=127.0.0.1,localhost,www.walmart.com${offCdnReachable ? "" : ",images.openfoodfacts.org"}`,
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
    await enableOfflineOffPhotoStub(iosPage);
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
    await enableOfflineOffPhotoStub(androidPage);
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

    const fetchRasterWithOfflineStub = async (
      url: string,
    ): Promise<{ status: number; contentType: string; byteLength: number }> => {
      if (!offCdnReachable && url.startsWith("https://images.openfoodfacts.org/images/products/")) {
        return {
          status: 200,
          contentType: "image/jpeg",
          byteLength: offlineStubJpegBytes.byteLength,
        };
      }
      const resp = await fetch(url);
      const contentType = resp.headers.get("content-type") || "";
      if (
        !offCdnReachable &&
        url.includes("/api/product-image") &&
        resp.headers.get("x-image-retry") === "1"
      ) {
        return {
          status: 200,
          contentType: "image/jpeg",
          byteLength: offlineStubJpegBytes.byteLength,
        };
      }
      const buf = await resp.arrayBuffer();
      return { status: resp.status, contentType, byteLength: buf.byteLength };
    };

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
      const prodRaster = await fetchRasterWithOfflineStub(resolvedProdImg);
      assert(
        prodRaster.status === 200 &&
          (prodRaster.contentType.includes("image/jpeg") ||
            prodRaster.contentType.includes("image/png") ||
            prodRaster.contentType.includes("image/webp")) &&
          prodRaster.byteLength > 1500,
        `Android resolved product image failed raster check (${resolvedProdImg} -> status=${prodRaster.status}, type=${prodRaster.contentType}, bytes=${prodRaster.byteLength})`,
      );

      if (json.swap?.title) {
        const resolvedSwapImg = androidResolveBestImageUrl(
          baseOrigin,
          json.swap.title,
          json.swap.imageUrl || json.swap.image || "",
          json.swap.brand || "",
        );
        const swapRaster = await fetchRasterWithOfflineStub(resolvedSwapImg);
        assert(
          swapRaster.status === 200 &&
            (swapRaster.contentType.includes("image/jpeg") ||
              swapRaster.contentType.includes("image/png") ||
              swapRaster.contentType.includes("image/webp")) &&
            swapRaster.byteLength > 1500,
          `Android resolved swap image failed raster check (${resolvedSwapImg} -> status=${swapRaster.status}, type=${swapRaster.contentType}, bytes=${swapRaster.byteLength})`,
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
  <div id="walmart-mobile-app-upsell" style="position:fixed; left:0; right:0; bottom:0; z-index:9999; background:#ffffff; padding:16px; border-top:1px solid #e2e8f0; box-shadow:0 -8px 24px rgba(15,23,42,0.14);">
    <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
      <div>
        <div style="font-size:13px; color:#475569;">Walmart - Shopping &amp; Grocery</div>
        <div style="font-size:14px; font-weight:700; color:#0f172a; margin-top:2px;">The easiest way to shop, check out &amp; track your orders - anywhere you are.</div>
        <div style="font-size:13px; color:#0f172a; margin-top:4px;">★★★★★</div>
      </div>
      <button id="walmart-upsell-close" type="button" aria-label="Close app banner" onclick="window.__walmartAppBannerDismissClicks = (window.__walmartAppBannerDismissClicks || 0) + 1;" style="background:transparent; border:none; font-size:22px; line-height:1; padding:4px; cursor:pointer;">×</button>
    </div>
    <a href="https://walmart.onelink.me/UIev?pid=SmartBanner" style="display:block; margin-top:12px; background:#0071dc; color:#ffffff; text-align:center; padding:12px; border-radius:999px; font-weight:700; text-decoration:none;">Get the app</a>
  </div>
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
        ...(offCdnReachable
          ? []
          : [{ urlPattern: "https://images.openfoodfacts.org/*", requestStage: "Request" }]),
      ],
    });
    storePage.on("Fetch.requestPaused", (params) => {
      const reqUrl: string = params.request?.url || "";
      if (!offCdnReachable && reqUrl.startsWith("https://images.openfoodfacts.org/")) {
        void storePage.send("Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "Content-Type", value: "image/jpeg" },
            { name: "Access-Control-Allow-Origin", value: "*" },
            { name: "Cache-Control", value: "public, max-age=3600" },
          ],
          body: offlineStubJpegBase64,
        });
        return;
      }
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
    const appBannerCheck = await storePage.eval<{
      bannerDisplay: string;
      dismissClicks: number;
      mainTitleVisible: boolean;
    }>(`(() => {
      const b = document.getElementById("walmart-mobile-app-upsell");
      const h1 = document.querySelector("h1");
      return {
        bannerDisplay: b ? window.getComputedStyle(b).display : "missing",
        dismissClicks: Number(window.__walmartAppBannerDismissClicks || 0),
        mainTitleVisible: Boolean(h1 && window.getComputedStyle(h1).display !== "none"),
      };
    })()`);
    assert(
      appBannerCheck.bannerDisplay === "none" &&
        appBannerCheck.dismissClicks >= 1 &&
        appBannerCheck.mainTitleVisible,
      `Walmart 'Get the app' banner was not auto-dismissed cleanly: ${JSON.stringify(appBannerCheck)}`,
    );
    console.log(
      `   ✓ LiveStoreBrowser detectorJS extracted title, ingredients & GTIN (${detectedPdp.barcode}) and auto-dismissed Walmart 'Get the app' banner`,
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

    // 4C. Verify iOS Safari Mobile Search Page (`walmart.com/search?q=oatmeal`) auto-alignment + 1-tap drawer open without backdrop flicker!
    await storePage.navigate("https://www.walmart.com/search?q=oatmeal");
    await storePage.eval(`
      document.head.innerHTML = '<meta name="viewport" content="width=device-width, initial-scale=1">';
      document.body.style.margin = "0";
      document.body.innerHTML = \`
        <header style="height:64px;position:sticky;top:0;background:#0071dc;color:#fff;">Walmart Search: oatmeal</header>
        <div data-item-id="oat-1" style="height:180px;padding:16px;box-sizing:border-box;border-bottom:1px solid #eee;">
          <a href="/ip/Quaker-Instant-Oatmeal-Maple-Brown-Sugar/10312441">
            <span data-automation-id="product-title">Quaker Instant Oatmeal Maple &amp; Brown Sugar, 8 Packets</span>
          </a>
          <div>$3.48</div>
        </div>
        <div data-item-id="oat-2" style="height:220px;padding:16px;box-sizing:border-box;border-bottom:1px solid #eee;">
          <a href="/ip/Quaker-Oats-Old-Fashioned/10312439">
            <span data-automation-id="product-title">Quaker Oats OLd Fashioned 100% Whole Grain Oats, Old Fashioned</span>
          </a>
          <div>$3.98</div>
        </div>
        <div data-item-id="oat-3" style="height:220px;padding:16px;box-sizing:border-box;border-bottom:1px solid #eee;">
          <a href="/ip/Bobs-Red-Mill-Organic-Rolled-Oats/10312499">
            <span data-automation-id="product-title">Bob's Red Mill Organic Old Fashioned Rolled Oats, 32 oz</span>
          </a>
          <div>$6.98</div>
        </div>
      \`;
      const origMatchMedia = window.matchMedia ? window.matchMedia.bind(window) : null;
      window.matchMedia = function(q) {
        if (typeof q === "string" && (q.includes("pointer: coarse") || q.includes("hover: none"))) {
          return { matches: true, media: q, addEventListener: function(){}, removeEventListener: function(){} };
        }
        return origMatchMedia ? origMatchMedia(q) : { matches: false, media: q };
      };
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
          onChanged: { addListener: function() {} }
        },
        runtime: {
          onMessage: { addListener: function() {} },
          getURL: function(asset) {
            if (asset.includes("mascot")) return window.__heybrocApiBase + "/broc-mascot.png";
            return window.__heybrocOverlayCssUrl;
          },
          sendMessage: function(msg, cb) {
            if (!msg || typeof cb !== "function") return;
            if (msg.type === "CLEANCART_GET_CLIENT_INFO") {
              setTimeout(() => cb({ ok: true, apiBase: window.__heybrocApiBase, deviceId: "e2e-ios-safari-search", creatorCode: "" }), 5);
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
            setTimeout(() => cb({ ok: true, inStock: true }), 5);
          }
        }
      };
    `);
    await storePage.eval(extContentJS, false);

    let mobileSearchPill: {
      ringVal: string;
      subText: string;
    };
    try {
      mobileSearchPill = await storePage.waitFor(
        `(() => {
          const sr = document.getElementById("cleancart-overlay-host")?.shadowRoot;
          const pill = sr?.querySelector(".cc-pill");
          if (!pill || pill.hidden) return null;
          const val = (pill.querySelector(".cc-mini-ring-val")?.textContent || "").trim();
          if (!/^\\d+$/.test(val)) return null;
          return {
            ringVal: val,
            subText: (pill.querySelector(".cc-pill-sub")?.textContent || "").trim()
          };
        })()`,
        "iOS Safari mobile search auto-aligned Quaker Oats pill score",
        10000,
      );
    } catch (err) {
      const diagSearch = await storePage.eval<unknown>(`(() => {
        const host = document.getElementById("cleancart-overlay-host");
        const sr = host?.shadowRoot;
        const pill = sr?.querySelector(".cc-pill");
        const cards = [...document.querySelectorAll("[data-item-id]")].map((c) => ({
          id: c.getAttribute("data-item-id"),
          rect: c.getBoundingClientRect(),
          text: (c.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80)
        }));
        return {
          href: location.href,
          loadedFlag: window.__cleancartLoaded,
          hasHost: Boolean(host),
          pillHidden: pill?.hidden ?? null,
          pillHtml: pill?.innerHTML?.slice(0, 260) || null,
          ringVal: pill?.querySelector(".cc-mini-ring-val")?.textContent || null,
          subText: pill?.querySelector(".cc-pill-sub")?.textContent || null,
          innerHeight: window.innerHeight,
          innerWidth: window.innerWidth,
          userAgent: navigator.userAgent,
          cards
        };
      })()`);
      console.error("   [DIAGNOSTIC 4C] Mobile search state:", JSON.stringify(diagSearch, null, 2));
      console.error("   [DIAGNOSTIC 4C] Page exceptions:", storePage.exceptions);
      throw err;
    }
    assert(
      Number(mobileSearchPill.ringVal) >= 85 &&
        /quaker/i.test(mobileSearchPill.subText) &&
        !mobileSearchPill.subText.includes("OLd"),
      `Expected mobile search pill to auto-align & score Quaker Oats Old Fashioned (>=85, clean casing), got ${JSON.stringify(mobileSearchPill)}`,
    );

    // Simulate iOS Safari single-tap sequence: pointerdown -> pointerup -> 25ms delayed click on newly exposed .cc-backdrop!
    const singleTapResult = await storePage.eval<{
      stayedOpen: boolean;
      cardTitle: string;
    }>(`new Promise((resolve) => {
      const sr = document.getElementById("cleancart-overlay-host")?.shadowRoot;
      const pill = sr?.querySelector(".cc-pill");
      const rect = pill.getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width / 2);
      const cy = Math.round(rect.top + rect.height / 2);
      pill.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, isPrimary: true, pointerId: 1, pointerType: "touch", button: 0, clientX: cx, clientY: cy }));
      pill.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, isPrimary: true, pointerId: 1, pointerType: "touch", button: 0, clientX: cx, clientY: cy }));
      setTimeout(() => {
        const backdrop = sr?.querySelector(".cc-backdrop");
        if (backdrop && !backdrop.hidden) {
          backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
        }
        setTimeout(() => {
          const card = sr?.querySelector(".cc-card");
          const bd = sr?.querySelector(".cc-backdrop");
          resolve({
            stayedOpen: Boolean(bd && !bd.hidden && card),
            cardTitle: (card?.querySelector(".cc-product")?.textContent || "").trim()
          });
        }, 40);
      }, 25);
    })`, true);
    assert(
      singleTapResult.stayedOpen &&
        /quaker\s+oats\s+old\s+fashioned/i.test(singleTapResult.cardTitle) &&
        !singleTapResult.cardTitle.includes("OLd"),
      `Expected 1-tap on Safari pill to keep drawer open without backdrop flicker and normalize 'OLd', got ${JSON.stringify(singleTapResult)}`,
    );
    console.log(
      `   ✓ iOS Safari mobile Walmart search auto-alignment (${mobileSearchPill.ringVal}/100 · "${mobileSearchPill.subText}") + 1-tap zero-flicker drawer verified!`,
    );

    // 4D. Verify Android In-App LiveStoreBrowserActivity live_store_detector.js asset on nested Walmart Sponsored (/sp/track) + w_iUH7 mobile cards!
    const androidLiveKt = fs.readFileSync(
      path.join(
        ROOT,
        "android-app/app/src/main/java/com/cleancart/overlay/LiveStoreBrowserActivity.kt",
      ),
      "utf8",
    );
    assert(
      androidLiveKt.includes('"live_store_detector.js"') &&
        !androidLiveKt.includes("private const val DETECTOR_JS_TEMPLATE") &&
        !androidLiveKt.includes("DETECTOR_JS_PARTS"),
      "Expected LiveStoreBrowserActivity.kt to load live_store_detector.js from assets",
    );
    const androidDetTemplate = fs.readFileSync(
      path.join(ROOT, "android-app/app/src/main/assets/live_store_detector.js"),
      "utf8",
    );
    assert(androidDetTemplate.includes("__HB_BRIDGE_SECRET__"), "Missing __HB_BRIDGE_SECRET__ placeholder in live_store_detector.js");
    const androidBridgeSecret = "sec_e2e_android_bridge_987654";
    const androidDetectorJS = androidDetTemplate.replace(
      "__HB_BRIDGE_SECRET__",
      androidBridgeSecret,
    );
    const placeholderSvgDataUrl =
      "data:image/svg+xml;utf8," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#f1f5f9"/></svg>',
      );

    await storePage.navigate("https://www.walmart.com/search?q=chips");
    await storePage.eval(`
      document.head.innerHTML = '<meta name="viewport" content="width=device-width, initial-scale=1">';
      document.body.style.margin = "0";
      document.body.innerHTML = \`
        <header style="height:56px;background:#0071dc;color:#fff;">Walmart Mobile Browse</header>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px;">
          <div data-item-id="wm-sp-1" style="border:1px solid #e2e8f0;border-radius:12px;padding:8px;">
            <div class="mb0 ph1 pa0-xl bb b--near-white w-25" style="position:relative;">
              <div style="position:relative;width:148px;height:148px;">
                <img src=${JSON.stringify(placeholderSvgDataUrl)} width="148" height="148" style="display:block;width:148px;height:148px;" alt="" />
              </div>
              <div style="font-size:11px;color:#64748b;">Sponsored</div>
              <a href="/sp/track?bt=1&amp;eventST=click&amp;rd=%2Fip%2FDoritos-Nacho-Cheese%2F1045" link-identifier="1045" style="display:block;position:absolute;inset:0;z-index:1;">
                <span class="w_iUH7" style="position:absolute;width:1px;height:1px;overflow:hidden;">Doritos Nacho Cheese Flavored Tortilla Chips, 9.25 oz</span>
              </a>
              <div aria-hidden="true">Doritos Nacho Cheese Flavored Tortilla Chips, 9.25 oz</div>
              <div>$3.98</div>
            </div>
          </div>
          <div data-item-id="wm-org-2" style="border:1px solid #e2e8f0;border-radius:12px;padding:8px;">
            <div class="mb0 ph1 pa0-xl bb b--near-white w-25" style="position:relative;">
              <div style="position:relative;width:148px;height:148px;">
                <img src=${JSON.stringify(placeholderSvgDataUrl)} width="148" height="148" style="display:block;width:148px;height:148px;" alt="" />
              </div>
              <a href="/ip/Boulder-Canyon-Avocado-Oil-Kettle-Chips/44391408" link-identifier="44391408" style="display:block;position:absolute;inset:0;z-index:1;">
                <span class="w_iUH7" style="position:absolute;width:1px;height:1px;overflow:hidden;">Boulder Canyon Avocado Oil Kettle Chips</span>
              </a>
              <div aria-hidden="true">Boulder Canyon Avocado Oil Kettle Chips</div>
              <div>$4.48</div>
            </div>
          </div>
        </div>
      \`;
      window.__hbSecretChecks = { valid: 0, invalid: 0 };
      window.heybrocAndroidBridge = {
        postMessage: function(rawJson) {
          const msg = JSON.parse(rawJson);
          if (msg._hbSec !== ${JSON.stringify(androidBridgeSecret)}) {
            window.__hbSecretChecks.invalid++;
            return;
          }
          window.__hbSecretChecks.valid++;
          if (msg.kind === "gridBatch" && Array.isArray(msg.items)) {
            fetch(${JSON.stringify("https://www.heybroc.com/api/scan")}, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                surface: "android",
                clientPlatform: "android",
                store: "walmart",
                format: "json",
                items: msg.items
              })
            })
              .then((r) => r.json())
              .then((batchResp) => {
                const out = {};
                const results = batchResp.results || {};
                for (const it of msg.items) {
                  const r = results[it.id];
                  if (r && r.ok && r.result) {
                    out[it.id] = {
                      ok: true,
                      score: r.result.score,
                      hasAlert: Array.isArray(r.dietaryAlerts) && r.dietaryAlerts.length > 0,
                      alertSeverity: r.alertSeverity || "none",
                      isCategoryEstimate: Boolean(r.isCategoryEstimate)
                    };
                  } else {
                    out[it.id] = { ok: false, transient: false };
                  }
                }
                if (typeof window.__heybrocApplyCardBadges === "function") {
                  window.__heybrocApplyCardBadges(out, msg.pageToken || "");
                }
              });
          }
        }
      };
    `);
    await storePage.eval(androidDetectorJS, false);

    const androidWalmartBadges = await storePage.waitFor<{
      count: number;
      texts: string[];
      zIndexes: string[];
      validBridgeMsgs: number;
      invalidBridgeMsgs: number;
    }>(
      `(() => {
        const badges = [...document.querySelectorAll(".hb-photo-badge:not(.hb-photo-badge--loading)")];
        if (badges.length < 2) return null;
        return {
          count: badges.length,
          texts: badges.map((b) => (b.textContent || "").trim()),
          zIndexes: badges.map((b) => window.getComputedStyle(b).zIndex),
          validBridgeMsgs: window.__hbSecretChecks?.valid || 0,
          invalidBridgeMsgs: window.__hbSecretChecks?.invalid || 0
        };
      })()`,
      "Android LiveStoreBrowserActivity Walmart Sponsored + organic photo badges",
      10000,
    );
    assert(
      androidWalmartBadges.count === 2 &&
        androidWalmartBadges.zIndexes.every((z) => Number(z) >= 20) &&
        androidWalmartBadges.validBridgeMsgs >= 1 &&
        androidWalmartBadges.invalidBridgeMsgs === 0,
      `Expected exactly 2 non-duplicated Walmart photo badges (z-index >= 20) with valid bridge secret, got ${JSON.stringify(androidWalmartBadges)}`,
    );
    console.log(
      `   ✓ Android LiveStoreBrowserActivity Walmart Sponsored + nested-card photo badges (${androidWalmartBadges.texts.join(" | ")}, z-index=${androidWalmartBadges.zIndexes[0]}) verified!`,
    );

    // 4E. Verify Walmart Screenshot Regressions (truncated Sponsored Pop-Tarts slug recovery, Little Debbie, Bar-S) + Multi-Store DOM Card Parity (ALDI button-tile SPA, DoorDash RetailItem, Kroger 13-digit GS1 link, Target ProductCardWrapper)
    await storePage.navigate("https://www.walmart.com/search?q=grocery");
    await storePage.eval(`
      document.head.innerHTML = '<meta name="viewport" content="width=device-width, initial-scale=1">';
      document.body.style.margin = "0";
      document.body.innerHTML = \`
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px;">
          <div data-item-id="wm-pt-straw" style="border:1px solid #e2e8f0;border-radius:10px;padding:8px;position:relative;">
            <img src=${JSON.stringify(placeholderSvgDataUrl)} width="140" height="140" style="display:block;width:140px;height:140px;" alt="Sponsored" />
            <div>Sponsored</div>
            <a href="/sp/track?bt=1&amp;rd=%2Fip%2FPop-Tarts-Toaster-Pastries-Breakfast-Foods-Kids-Snacks-Value-Pack-Frosted-Strawberry-27-oz-16-Pastries%2F10818661">
              <span data-automation-id="product-title">Pop-Tarts Toaster Pastries, Breakfast Foods, Kids Snacks, Value Pack, Frosted...</span>
            </a>
            <button>+ Add</button>
          </div>
          <div data-item-id="wm-ld-tree" style="border:1px solid #e2e8f0;border-radius:10px;padding:8px;position:relative;">
            <img src=${JSON.stringify(placeholderSvgDataUrl)} width="140" height="140" style="display:block;width:140px;height:140px;" alt="Little Debbie Vanilla Christmas Tree Cakes, 8.52 oz, 5 Count" />
            <a href="/ip/Little-Debbie-Vanilla-Christmas-Tree-Cakes-8-52-oz-5-Count/38291044">
              <span data-automation-id="product-title">Little Debbie Vanilla Christmas Tree Cakes, 8.52 oz, 5 Count</span>
            </a>
          </div>
          <div data-item-id="wm-bars" style="border:1px solid #e2e8f0;border-radius:10px;padding:8px;position:relative;">
            <img src=${JSON.stringify(placeholderSvgDataUrl)} width="140" height="140" style="display:block;width:140px;height:140px;" alt="Bar-S Classic Franks, 12 oz" />
            <a href="/ip/Bar-S-Classic-Franks-12-oz/10291612">
              <span data-automation-id="product-title">Bar-S Classic Franks, 12 oz</span>
            </a>
          </div>
          <div class="product-tile" role="button" tabindex="0" style="border:1px solid #e2e8f0;border-radius:10px;padding:8px;position:relative;">
            <img src=${JSON.stringify(placeholderSvgDataUrl)} width="140" height="140" style="display:block;width:140px;height:140px;" alt="Clancy's Classic Potato Chips, 10 oz" />
            <div class="product-tile__name">Clancy's Classic Potato Chips, 10 oz</div>
            <button>Add to cart</button>
          </div>
          <div data-testid="RetailItem" style="border:1px solid #e2e8f0;border-radius:10px;padding:8px;position:relative;">
            <img src=${JSON.stringify(placeholderSvgDataUrl)} width="140" height="140" style="display:block;width:140px;height:140px;" alt="Eggo Buttermilk Waffles, 10 ct" />
            <a href="/convenience/store/123/product/eggo-buttermilk-waffles-10-ct">Eggo Buttermilk Waffles, 10 ct</a>
          </div>
          <div class="kds-Card ProductCard" style="border:1px solid #e2e8f0;border-radius:10px;padding:8px;position:relative;">
            <img src=${JSON.stringify(placeholderSvgDataUrl)} width="140" height="140" style="display:block;width:140px;height:140px;" alt="" />
            <a href="/p/kroger-vitamin-d-whole-milk-gallon/0001111040107">
              <span data-qa="cart-page-item-description">Kroger Grade A Whole Vitamin D Milk, 1 gal</span>
            </a>
          </div>
        </div>
      \`;
      window.__hbMultiStoreBatches = [];
      window.heybrocAndroidBridge = {
        postMessage: function(rawJson) {
          const msg = JSON.parse(rawJson);
          if (msg._hbSec !== ${JSON.stringify(androidBridgeSecret)}) return;
          if (msg.kind === "gridBatch" && Array.isArray(msg.items)) {
            window.__hbMultiStoreBatches.push(msg.items);
            fetch(${JSON.stringify("https://www.heybroc.com/api/scan")}, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                surface: "android",
                clientPlatform: "android",
                store: "walmart",
                format: "json",
                items: msg.items
              })
            })
              .then((r) => r.json())
              .then((batchResp) => {
                const out = {};
                const results = batchResp.results || {};
                for (const it of msg.items) {
                  const r = results[it.id];
                  if (r && r.ok && r.result) {
                    out[it.id] = {
                      ok: true,
                      score: r.result.score,
                      hasAlert: Array.isArray(r.dietaryAlerts) && r.dietaryAlerts.length > 0,
                      alertSeverity: r.alertSeverity || "none",
                      isCategoryEstimate: Boolean(r.isCategoryEstimate)
                    };
                  } else {
                    out[it.id] = { ok: false, transient: false };
                  }
                }
                if (typeof window.__heybrocApplyCardBadges === "function") {
                  window.__heybrocApplyCardBadges(out, msg.pageToken || "");
                }
              });
          }
        }
      };
    `);
    await storePage.eval(androidDetectorJS, false);

    const multiStoreBadges = await storePage.waitFor<{
      count: number;
      texts: string[];
      recoveredPopTartsFlavor: boolean;
      recoveredKrogerBarcode: boolean;
    }>(
      `(() => {
        const badges = [...document.querySelectorAll(".hb-photo-badge:not(.hb-photo-badge--loading)")];
        if (badges.length < 6) return null;
        const flatItems = (window.__hbMultiStoreBatches || []).flat();
        return {
          count: badges.length,
          texts: badges.map((b) => (b.textContent || "").trim()),
          recoveredPopTartsFlavor: flatItems.some((i) => /pop[ -]*tarts/i.test(i.productTitle || "") && /strawberry/i.test(i.productTitle || "")),
          recoveredKrogerBarcode: flatItems.some((i) => i.barcode === "0001111040107")
        };
      })()`,
      "Walmart screenshot regressions + ALDI/DoorDash/Kroger multi-store photo badges",
      10000,
    );
    assert(
      multiStoreBadges.count === 6 &&
        multiStoreBadges.recoveredPopTartsFlavor &&
        multiStoreBadges.recoveredKrogerBarcode,
      `Expected all 6 screenshot & multi-store cards to score with Pop-Tarts slug flavor + Kroger GS1 barcode recovery, got ${JSON.stringify(multiStoreBadges)}`,
    );
    console.log(
      `   ✓ Walmart screenshot items + ALDI SPA button-tile + DoorDash RetailItem + Kroger GS1 barcode (${multiStoreBadges.texts.join(" | ")}) verified!`,
    );

    // 4F. P1-3 Price, Cent, Star-Rating & Review Title-Rejection Across All 3 Surfaces (Android, iOS, Extension)
    const p13GridHtml = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:10px;">
        <div data-item-id="p13-wm-1" style="border:1px solid #e2e8f0;border-radius:10px;padding:8px;position:relative;">
          <img src=${JSON.stringify(placeholderSvgDataUrl)} width="140" height="140" style="display:block;width:140px;height:140px;" alt="Chobani Greek Yogurt" />
          <span class="w_iUH7">current price Now $3.48, Was $4.98</span>
          <span class="w_iUH7">4.5 out of 5 Stars. 1,232 reviews</span>
          <a href="/ip/Chobani-Greek-Yogurt-Strawberry-5-3-oz/10452099">
            <span data-automation-id="product-title">Chobani Greek Yogurt, Strawberry, 5.3 oz</span>
          </a>
        </div>
        <div data-item-id="p13-wm-2" style="border:1px solid #e2e8f0;border-radius:10px;padding:8px;position:relative;">
          <img src=${JSON.stringify(placeholderSvgDataUrl)} width="140" height="140" style="display:block;width:140px;height:140px;" alt="" />
          <h3>Now $3.99</h3>
          <h4>4.8 out of 5 ★ (842 reviews)</h4>
          <a href="/ip/Quaker-Old-Fashioned-Oats-42-oz/10312439">Quaker Old Fashioned Oats, 42 oz</a>
        </div>
        <div data-item-id="p13-wm-3" style="border:1px solid #e2e8f0;border-radius:10px;padding:8px;position:relative;">
          <img src=${JSON.stringify(placeholderSvgDataUrl)} width="140" height="140" style="display:block;width:140px;height:140px;" alt="" />
          <span class="w_iUH7">99¢</span>
          <a link-identifier="banana-1" href="/ip/Fresh-Organic-Bananas-Bunch/44390948">Fresh Organic Bananas, Bunch</a>
        </div>
      </div>
    `;
    const isCleanP13Titles = (titles: string[]) =>
      titles.length >= 3 &&
      titles.every((t) => !/\$\s*\d|\b\d+(?:\.\d+)?\s*¢|\b(?:current|was|now|sale|unit|list)\s+price\b|\b\d(?:\.\d)?\s+out\s+of\s+5\b|\b\d[\d,]*\s+reviews?\b|★/i.test(t)) &&
      titles.some((t) => /chobani/i.test(t)) &&
      titles.some((t) => /quaker/i.test(t)) &&
      titles.some((t) => /banana/i.test(t));

    // Surface 1: Android live_store_detector.js
    await storePage.navigate("https://www.walmart.com/search?q=p13-android");
    await storePage.eval(`
      document.body.innerHTML = ${JSON.stringify(p13GridHtml)};
      window.__p13AndroidTitles = [];
      window.heybrocAndroidBridge = {
        postMessage: function(rawJson) {
          const msg = JSON.parse(rawJson);
          if (msg._hbSec !== ${JSON.stringify(androidBridgeSecret)}) return;
          if (msg.kind === "gridBatch" && Array.isArray(msg.items)) {
            msg.items.forEach((it) => window.__p13AndroidTitles.push(it.productTitle || ""));
          }
        }
      };
    `);
    await storePage.eval(androidDetectorJS, false);
    const p13AndroidTitles = await storePage.waitFor<string[]>(
      `window.__p13AndroidTitles.length >= 3 ? window.__p13AndroidTitles : null`,
      "P1-3 Android price/rating title rejection",
      6000,
    );
    assert(isCleanP13Titles(p13AndroidTitles), `P1-3 Android captured noisy titles: ${JSON.stringify(p13AndroidTitles)}`);

    // Surface 2: iOS detectorJS
    await storePage.navigate("https://www.walmart.com/search?q=p13-ios");
    await storePage.eval(`
      document.body.innerHTML = ${JSON.stringify(p13GridHtml)};
      window.__p13IosTitles = [];
      window.webkit = {
        messageHandlers: {
          heybrocStore: {
            postMessage: function(msg) {
              if (msg && msg.kind === "gridBatch" && Array.isArray(msg.items)) {
                msg.items.forEach((it) => window.__p13IosTitles.push(it.productTitle || ""));
              }
            }
          }
        }
      };
    `);
    await storePage.eval(detectorJS, false);
    const p13IosTitles = await storePage.waitFor<string[]>(
      `window.__p13IosTitles.length >= 3 ? window.__p13IosTitles : null`,
      "P1-3 iOS price/rating title rejection",
      6000,
    );
    assert(isCleanP13Titles(p13IosTitles), `P1-3 iOS captured noisy titles: ${JSON.stringify(p13IosTitles)}`);

    // Surface 3: Chrome/Safari Extension content.js
    await storePage.navigate("https://www.walmart.com/search?q=p13-ext");
    await storePage.eval(`
      document.body.innerHTML = ${JSON.stringify(p13GridHtml)};
      window.__p13ExtTitles = [];
      window.__heybrocApiBase = "https://www.heybroc.com";
      window.__heybrocOverlayCssUrl = ${JSON.stringify(extOverlayCssDataUrl)};
      window.__heybrocExtStorage = { cc_photo_badges_enabled: true };
      window.chrome = {
        storage: {
          local: {
            get: function(keys, cb) { const out = Object.assign({}, window.__heybrocExtStorage); if (cb) setTimeout(() => cb(out), 1); return Promise.resolve(out); },
            set: function(items, cb) { Object.assign(window.__heybrocExtStorage, items || {}); if (cb) setTimeout(() => cb(), 1); return Promise.resolve(); },
            remove: function(_k, cb) { if (cb) setTimeout(() => cb(), 1); return Promise.resolve(); }
          },
          onChanged: { addListener: function() {} }
        },
        runtime: {
          id: "cleancart-p13-ext",
          getURL: function(p) { return p === "overlay.css" ? window.__heybrocOverlayCssUrl : ("https://www.heybroc.com/" + p); },
          sendMessage: function(msg, cb) {
            if (msg && msg.type === "CLEANCART_SCAN_BATCH" && Array.isArray(msg.items)) {
              msg.items.forEach((it) => window.__p13ExtTitles.push(it.productTitle || ""));
              const out = { ok: true, results: {} };
              if (cb) setTimeout(() => cb(out), 2);
              return Promise.resolve(out);
            }
            const empty = { ok: false };
            if (cb) setTimeout(() => cb(empty), 2);
            return Promise.resolve(empty);
          },
          onMessage: { addListener: function() {} }
        }
      };
    `);
    await storePage.eval(extContentJS, false);
    const p13ExtTitles = await storePage.waitFor<string[]>(
      `window.__p13ExtTitles.length >= 3 ? window.__p13ExtTitles : null`,
      "P1-3 Extension price/rating title rejection",
      6000,
    );
    assert(isCleanP13Titles(p13ExtTitles), `P1-3 Extension captured noisy titles: ${JSON.stringify(p13ExtTitles)}`);
    console.log(
      `   ✓ P1-3 price/cent/rating title filters verified across Android, iOS & Extension (${p13AndroidTitles.join(" | ")})!`,
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
