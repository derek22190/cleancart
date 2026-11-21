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
import * as http from "node:http";
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
  let kvServer: http.Server | null = null;

  // Ephemeral in-memory Upstash Redis REST mock so local `next start` (NODE_ENV=production)
  // exercises the real Upstash client in lib/storage.ts & lib/auth.ts end-to-end.
  const kvStrings = new Map<string, { val: string; exp?: number }>();
  const kvSets = new Map<string, Set<string>>();
  const kvHashes = new Map<string, Map<string, string>>();
  const kvGetLive = (k: string): string | null => {
    const e = kvStrings.get(k);
    if (!e) return null;
    if (e.exp && e.exp <= Date.now()) {
      kvStrings.delete(k);
      return null;
    }
    return e.val;
  };
  let kvMockUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
  let kvMockToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";
  if (!kvMockUrl || !kvMockToken) {
    const kvPort = await getFreePort();
    kvMockUrl = `http://127.0.0.1:${kvPort}`;
    kvMockToken = "headless-e2e-kv-token";
    kvServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let result: unknown = null;
        try {
          const args = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Array<string | number>;
          const cmd = String(args[0] || "").toUpperCase();
          if (cmd === "GET") {
            result = kvGetLive(String(args[1]));
          } else if (cmd === "SET") {
            const k = String(args[1]);
            const v = String(args[2] ?? "");
            const rest = args.slice(3).map((x) => String(x).toUpperCase());
            const isNx = rest.includes("NX");
            const exIdx = rest.indexOf("EX");
            const ttlSec = exIdx >= 0 ? Number(args[3 + exIdx + 1]) : 0;
            if (isNx && kvGetLive(k) !== null) {
              result = null;
            } else {
              kvStrings.set(k, {
                val: v,
                exp: ttlSec > 0 ? Date.now() + ttlSec * 1000 : undefined,
              });
              result = "OK";
            }
          } else if (cmd === "DEL") {
            const k = String(args[1]);
            kvStrings.delete(k);
            kvSets.delete(k);
            kvHashes.delete(k);
            result = 1;
          } else if (cmd === "SADD") {
            const k = String(args[1]);
            if (!kvSets.has(k)) kvSets.set(k, new Set());
            kvSets.get(k)!.add(String(args[2]));
            result = 1;
          } else if (cmd === "SREM") {
            kvSets.get(String(args[1]))?.delete(String(args[2]));
            result = 1;
          } else if (cmd === "SMEMBERS") {
            result = Array.from(kvSets.get(String(args[1])) || []);
          } else if (cmd === "HSET") {
            const k = String(args[1]);
            if (!kvHashes.has(k)) kvHashes.set(k, new Map());
            const h = kvHashes.get(k)!;
            for (let i = 2; i + 1 < args.length; i += 2) {
              h.set(String(args[i]), String(args[i + 1]));
            }
            result = 1;
          } else if (cmd === "HGETALL") {
            const h = kvHashes.get(String(args[1]));
            const arr: string[] = [];
            if (h) {
              for (const [fk, fv] of h) arr.push(fk, fv);
            }
            result = arr;
          } else if (cmd === "HINCRBY" || cmd === "HINCRBYFLOAT") {
            const k = String(args[1]);
            const f = String(args[2]);
            const inc = Number(args[3] || 0);
            if (!kvHashes.has(k)) kvHashes.set(k, new Map());
            const h = kvHashes.get(k)!;
            const next = (Number(h.get(f) || 0) || 0) + inc;
            h.set(f, String(next));
            result = next;
          } else if (cmd === "EVAL") {
            const lua = String(args[1] || "");
            const numKeys = Number(args[2] || 0);
            const k1 = String(args[3] || "");
            if (lua.includes('redis.call("DEL", KEYS[1])')) {
              result = kvGetLive(k1);
              kvStrings.delete(k1);
            } else if (lua.includes("INCRBY") && lua.includes("PEXPIRE")) {
              const winMs = Number(args[3 + numKeys] || 60000);
              const delta = Number(args[3 + numKeys + 1] || 1);
              const cur = Number(kvGetLive(k1) || 0);
              const next = cur + delta;
              kvStrings.set(k1, {
                val: String(next),
                exp: kvStrings.get(k1)?.exp || Date.now() + winMs,
              });
              result = next;
            } else if (lua.includes("HINCRBY")) {
              if (kvGetLive(k1) !== null) {
                result = 0;
              } else {
                const k2 = String(args[4] || "");
                const ttl = Number(args[5] || 3600);
                kvStrings.set(k1, { val: "1", exp: Date.now() + ttl * 1000 });
                if (!kvHashes.has(k2)) kvHashes.set(k2, new Map());
                const h = kvHashes.get(k2)!;
                for (let i = 6; i + 2 < args.length; i += 3) {
                  const f = String(args[i]);
                  const d = Number(args[i + 1] || 0);
                  h.set(f, String((Number(h.get(f) || 0) || 0) + d));
                }
                result = 1;
              }
            }
          }
        } catch {
          result = null;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result }));
      });
    });
    await new Promise<void>((resolve) => kvServer!.listen(kvPort, "127.0.0.1", resolve));
  }

  const cleanup = () => {
    if (kvServer) {
      try {
        kvServer.close();
      } catch {
        // ignore
      }
      kvServer = null;
    }
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
        AUTH_SECRET:
          process.env.AUTH_SECRET ||
          "headless-e2e-ephemeral-auth-secret-0123456789abcdef",
        UPSTASH_REDIS_REST_URL: kvMockUrl,
        UPSTASH_REDIS_REST_TOKEN: kvMockToken,
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

    const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
    let activeCdpPort = cdpPort;
    const launchChromium = async (port: number): Promise<void> => {
      const userDataDir = fs.mkdtempSync("/tmp/heybroc-chromium-");
      let stderrBuf = "";
      console.log(
        `🌐 Launching Headless Chromium on CDP port ${port}${offCdnReachable ? "" : " (offline OFF photo fixture mode)"}…`,
      );
      chromeProc = spawn(
        CHROMIUM_BIN,
        [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--disable-background-networking",
          "--no-first-run",
          "--no-default-browser-check",
          "--ignore-certificate-errors",
          ...(envProxy ? [`--proxy-server=${envProxy}`] : []),
          `--proxy-bypass-list=127.0.0.1,localhost,www.walmart.com,www.costco.com,www.instacart.com,i5.walmartimages.com${offCdnReachable ? "" : ",images.openfoodfacts.org"}`,
          `--user-data-dir=${userDataDir}`,
          `--remote-debugging-port=${port}`,
          "--window-size=393,852",
        ],
        { detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      chromeProc.stderr?.on("data", (chunk: Buffer) => {
        if (stderrBuf.length < 4000) stderrBuf += chunk.toString("utf8");
      });
      try {
        await waitForHttp(`http://127.0.0.1:${port}/json/version`, 45000);
      } catch (err) {
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
        chromeProc = null;
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}${stderrBuf ? `\nChromium stderr:\n${stderrBuf.trim()}` : ""}`,
        );
      }
    };

    try {
      await launchChromium(activeCdpPort);
    } catch (firstErr) {
      console.warn(
        `⚠️ First Chromium CDP launch failed (${firstErr instanceof Error ? firstErr.message.split("\n")[0] : String(firstErr)}); retrying on a fresh port…`,
      );
      activeCdpPort = await getFreePort();
      await launchChromium(activeCdpPort);
    }
    const resolvedCdpPort = activeCdpPort;

    // =========================================================================
    // SUITE 1: iPhone 16 Pro Native App WKWebView (`/?platform=ios`, Build 122)
    // =========================================================================
    console.log("\n📱 [1/6] Testing iPhone Native App WKWebView (/?platform=ios)...");
    const iosPage = await createPageTarget(resolvedCdpPort);
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
    console.log("\n📲 [2/6] Testing Legacy iPhone Build Fallback Banner & Sheet...");
    const legacyIosPage = await createPageTarget(resolvedCdpPort);
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
      `document.body.innerText.includes("Update HeyBroc in the App Store to Open Walmart Inside the App")`,
      "Legacy build fallback store sheet",
    );
    console.log("   ✓ Legacy App Store update banner & fallback store sheet verified");
    legacyIosPage.close();

    // =========================================================================
    // SUITE 3: Android Mobile Web (`412x915`, Pixel 9) + Android Native API/Image Parity
    // =========================================================================
    console.log("\n🤖 [3/6] Testing Android Chrome Mobile Web & Android Native API/Image Parity...");
    const androidPage = await createPageTarget(resolvedCdpPort);
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

    for (const route of ["/", "/test", "/tools", "/swaps/hidden-valley-ranch", "/compare", "/compare/heybroc-vs-yuka"]) {
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

    // Verify /test?angle=red40 interactive Free 3-Second Grocery Score Test on Android
    await androidPage.navigate(`${baseOrigin}/test?angle=red40`);
    await androidPage.waitFor(
      `Boolean(document.getElementById("ad-free-test-hero")) && /Red 40/i.test(document.getElementById("ad-free-test-hero")?.textContent || "")`,
      "Android /test?angle=red40 persona-tailored Free Score Test hero",
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
    console.log("\n🥦 [4/6] Testing LiveStoreBrowser detectorJS & Safari/Chrome Extension Overlay on Walmart PDP...");
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

    const storePage = await createPageTarget(resolvedCdpPort);
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

    // Intercept https://www.walmart.com/*, https://www.instacart.com/*, and https://www.heybroc.com/* locally via CDP Fetch
    // so no external retailer request is hit and HTTPS->HTTPS extension calls hit our local Next.js build!
    await storePage.send("Fetch.enable", {
      patterns: [
        { urlPattern: "https://www.walmart.com/*", requestStage: "Request" },
        { urlPattern: "https://www.costco.com/*", requestStage: "Request" },
        { urlPattern: "https://www.instacart.com/*", requestStage: "Request" },
        { urlPattern: "https://www.doordash.com/*", requestStage: "Request" },
        { urlPattern: "https://i5.walmartimages.com/*", requestStage: "Request" },
        { urlPattern: "https://www.heybroc.com/*", requestStage: "Request" },
        ...(offCdnReachable
          ? []
          : [{ urlPattern: "https://images.openfoodfacts.org/*", requestStage: "Request" }]),
      ],
    });
    storePage.on("Fetch.requestPaused", (params) => {
      const reqUrl: string = params.request?.url || "";
      if (
        reqUrl.startsWith("https://i5.walmartimages.com/") ||
        (!offCdnReachable && reqUrl.startsWith("https://images.openfoodfacts.org/"))
      ) {
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
        reqUrl.startsWith("https://www.walmart.com/search") ||
        reqUrl.startsWith("https://www.walmart.com/cart") ||
        reqUrl.startsWith("https://www.costco.com/CheckoutCartDisplayView") ||
        reqUrl.startsWith("https://www.instacart.com/") ||
        reqUrl.startsWith("https://www.doordash.com/")
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
        // Any stray relative request to www.walmart.com / www.costco.com (e.g. if a relative /api/... or /swaps/... leaked!) returns 404 immediately!
        void storePage.send("Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: 404,
          responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
          body: Buffer.from("Not Found on Store Fixture", "utf8").toString("base64"),
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
          heybrocStoreBridge: {
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

    // 4G. P1-8 Costco /CheckoutCartDisplayView Cart Recognition & Persistence Across All 3 Surfaces
    const costcoCartHtml = `
      <main>
        <h1>Cart (2 Items)</h1>
        <div automation-id="cart-items-container">
          <div automation-id="cartItemRow" style="display:flex;gap:12px;padding:12px;border-bottom:1px solid #ddd;">
            <img src=${JSON.stringify(placeholderSvgDataUrl)} width="90" height="90" alt="Kirkland Signature Organic Extra Virgin Olive Oil" />
            <a automation-id="productTitleLink" href="/kirkland-signature-organic-extra-virgin-olive-oil.product.100334841.html">Kirkland Signature Organic Extra Virgin Olive Oil, 2 L</a>
            <span>$19.99</span>
            <input type="number" aria-label="Quantity" value="1" />
            <button automation-id="removeItemBtn">Remove</button>
          </div>
          <div automation-id="cartItemRow" style="display:flex;gap:12px;padding:12px;border-bottom:1px solid #ddd;">
            <img src=${JSON.stringify(placeholderSvgDataUrl)} width="90" height="90" alt="Simple Mills Almond Flour Crackers" />
            <a automation-id="productTitleLink" href="/simple-mills-almond-flour-crackers.product.100456789.html">Simple Mills Almond Flour Crackers, 17 oz</a>
            <span>$10.49</span>
            <input type="number" aria-label="Quantity" value="2" />
            <button automation-id="removeItemBtn">Remove</button>
          </div>
        </div>
      </main>
    `;
    await storePage.navigate("https://www.costco.com/CheckoutCartDisplayView");
    await storePage.eval(`
      document.body.innerHTML = ${JSON.stringify(costcoCartHtml)};
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
          id: "cleancart-p18-costco",
          getURL: function(p) { return p === "overlay.css" ? window.__heybrocOverlayCssUrl : ("https://www.heybroc.com/" + p); },
          sendMessage: function(msg, cb) {
            const resp = msg && msg.type === "CLEANCART_AUDIT_CART_BATCH" ? { ok: true, results: {} } : { ok: false };
            if (cb) setTimeout(() => cb(resp), 2);
            return Promise.resolve(resp);
          },
          onMessage: { addListener: function() {} }
        }
      };
    `);
    await storePage.eval(extContentJS, false);
    const p18StoredCart = await storePage.waitFor<{ titles: string[]; quantities: number[] }>(
      `(() => {
        const st = window.__heybrocExtStorage || {};
        const key = Object.keys(st).find((k) => k.includes("costco") && Array.isArray(st[k]) && st[k].length >= 2);
        if (!key) return null;
        return {
          titles: st[key].map((i) => i.title || ""),
          quantities: st[key].map((i) => i.quantity || 1)
        };
      })()`,
      "P1-8 Costco CheckoutCartDisplayView extension cart scraping & storage persistence",
      6000,
    );
    assert(
      p18StoredCart.titles.some((t) => /olive oil/i.test(t)) &&
        p18StoredCart.titles.some((t) => /simple mills/i.test(t)) &&
        p18StoredCart.quantities.includes(2),
      `P1-8 Costco cart failed to persist expected items: ${JSON.stringify(p18StoredCart)}`,
    );

    // Verify Android & iOS detectors recognize /CheckoutCartDisplayView as cart (zero gridBatch emitted)
    await storePage.navigate("https://www.costco.com/CheckoutCartDisplayView");
    await storePage.eval(`
      document.body.innerHTML = ${JSON.stringify(costcoCartHtml)};
      window.__p18AndroidCartGrid = 0;
      window.heybrocAndroidBridge = {
        postMessage: function(rawJson) {
          const msg = JSON.parse(rawJson);
          if (msg._hbSec === ${JSON.stringify(androidBridgeSecret)} && msg.kind === "gridBatch") {
            window.__p18AndroidCartGrid += (msg.items || []).length;
          }
        }
      };
    `);
    await storePage.eval(androidDetectorJS, false);
    await new Promise((r) => setTimeout(r, 450));
    const p18AndroidGridCount = await storePage.eval<number>(`window.__p18AndroidCartGrid`);
    assert(p18AndroidGridCount === 0, `P1-8 Android emitted ${p18AndroidGridCount} grid scans on Costco CheckoutCartDisplayView`);

    await storePage.navigate("https://www.costco.com/CheckoutCartDisplayView");
    await storePage.eval(`
      document.body.innerHTML = ${JSON.stringify(costcoCartHtml)};
      window.__p18IosCartGrid = 0;
      window.webkit = {
        messageHandlers: {
          heybrocStoreBridge: {
            postMessage: function(msg) {
              if (msg && msg.kind === "gridBatch") {
                window.__p18IosCartGrid += (msg.items || []).length;
              }
            }
          }
        }
      };
    `);
    await storePage.eval(detectorJS, false);
    await new Promise((r) => setTimeout(r, 450));
    const p18IosGridCount = await storePage.eval<number>(`window.__p18IosCartGrid`);
    assert(p18IosGridCount === 0, `P1-8 iOS emitted ${p18IosGridCount} grid scans on Costco CheckoutCartDisplayView`);
    console.log(
      `   ✓ P1-8 Costco /CheckoutCartDisplayView cart scraped & persisted (${p18StoredCart.titles.join(" + ")})!`,
    );

    // 4H. P2-1 Brand-Logo Badge Guard & Re-Anchoring on Android & iOS
    const p21BrandLogoHtml = `
      <div style="display:grid;grid-template-columns:1fr;gap:12px;padding:12px;">
        <div data-item-id="p21-brand-card" style="width:220px;border:1px solid #e2e8f0;border-radius:10px;padding:8px;position:relative;">
          <div id="p21-logo-wrap" style="width:52px;height:52px;">
            <img id="p21-logo-img" class="brand-logo" src="https://i5.walmartimages.com/assets/brand-logo.png" width="52" height="52" style="display:block;width:52px;height:52px;" alt="Organic Valley brand logo" />
          </div>
          <div id="p21-photo-wrap" style="width:160px;height:160px;margin-top:6px;">
            <img id="p21-prod-img" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="160" height="160" style="display:block;width:160px;height:160px;" alt="Organic Valley Whole Milk, 64 fl oz" />
          </div>
          <a href="/ip/Organic-Valley-Whole-Milk-64-fl-oz/10452101">
            <span data-automation-id="product-title">Organic Valley Organic Whole Milk, 64 fl oz</span>
          </a>
        </div>
      </div>
    `;
    await storePage.navigate("https://www.walmart.com/search?q=p21-android");
    await storePage.eval(`
      document.body.innerHTML = ${JSON.stringify(p21BrandLogoHtml)};
      window.__p21AndroidBatches = 0;
      window.heybrocAndroidBridge = {
        postMessage: function(rawJson) {
          const msg = JSON.parse(rawJson);
          if (msg._hbSec === ${JSON.stringify(androidBridgeSecret)} && msg.kind === "gridBatch") {
            window.__p21AndroidBatches += (msg.items || []).length;
          }
        }
      };
    `);
    await storePage.eval(androidDetectorJS, false);
    await new Promise((r) => setTimeout(r, 450));
    const p21BeforeLoadAndroid = await storePage.eval<{ badges: number; batches: number }>(
      `({ badges: document.querySelectorAll(".hb-photo-badge").length, batches: window.__p21AndroidBatches })`,
    );
    assert(
      p21BeforeLoadAndroid.badges === 0 && p21BeforeLoadAndroid.batches === 0,
      `P2-1 Android badged a brand logo before real product photo loaded: ${JSON.stringify(p21BeforeLoadAndroid)}`,
    );
    await storePage.eval(`
      const prodImg = document.getElementById("p21-prod-img");
      prodImg.src = ${JSON.stringify(placeholderSvgDataUrl)};
      prodImg.dispatchEvent(new Event("load"));
    `);
    const p21AfterLoadAndroid = await storePage.waitFor<{ badges: number; batches: number; inLogoWrap: boolean }>(
      `(() => {
        const b = document.querySelector(".hb-photo-badge");
        if (!b || window.__p21AndroidBatches < 1) return null;
        const logoWrap = document.getElementById("p21-logo-wrap");
        return { badges: document.querySelectorAll(".hb-photo-badge").length, batches: window.__p21AndroidBatches, inLogoWrap: Boolean(logoWrap && logoWrap.contains(b)) };
      })()`,
      "P2-1 Android badge appears on real product photo once loaded",
      5000,
    );
    assert(
      p21AfterLoadAndroid.badges === 1 && p21AfterLoadAndroid.batches >= 1 && !p21AfterLoadAndroid.inLogoWrap,
      `P2-1 Android badge anchored incorrectly after real photo loaded: ${JSON.stringify(p21AfterLoadAndroid)}`,
    );

    await storePage.navigate("https://www.walmart.com/search?q=p21-ios");
    await storePage.eval(`
      document.body.innerHTML = ${JSON.stringify(p21BrandLogoHtml)};
      window.__p21IosBatches = 0;
      window.webkit = {
        messageHandlers: {
          heybrocStoreBridge: {
            postMessage: function(msg) {
              if (msg && msg.kind === "gridBatch") {
                window.__p21IosBatches += (msg.items || []).length;
              }
            }
          }
        }
      };
    `);
    await storePage.eval(detectorJS, false);
    await new Promise((r) => setTimeout(r, 450));
    const p21BeforeLoadIos = await storePage.eval<{ badges: number; batches: number }>(
      `({ badges: document.querySelectorAll(".hb-photo-badge").length, batches: window.__p21IosBatches })`,
    );
    assert(
      p21BeforeLoadIos.badges === 0 && p21BeforeLoadIos.batches === 0,
      `P2-1 iOS badged a brand logo before real product photo loaded: ${JSON.stringify(p21BeforeLoadIos)}`,
    );
    await storePage.eval(`
      const prodImg = document.getElementById("p21-prod-img");
      prodImg.src = ${JSON.stringify(placeholderSvgDataUrl)};
      prodImg.dispatchEvent(new Event("load"));
    `);
    const p21AfterLoadIos = await storePage.waitFor<{ badges: number; batches: number; inLogoWrap: boolean }>(
      `(() => {
        const b = document.querySelector(".hb-photo-badge");
        if (!b || window.__p21IosBatches < 1) return null;
        const logoWrap = document.getElementById("p21-logo-wrap");
        return { badges: document.querySelectorAll(".hb-photo-badge").length, batches: window.__p21IosBatches, inLogoWrap: Boolean(logoWrap && logoWrap.contains(b)) };
      })()`,
      "P2-1 iOS badge appears on real product photo once loaded",
      5000,
    );
    assert(
      p21AfterLoadIos.badges === 1 && p21AfterLoadIos.batches >= 1 && !p21AfterLoadIos.inLogoWrap,
      `P2-1 iOS badge anchored incorrectly after real photo loaded: ${JSON.stringify(p21AfterLoadIos)}`,
    );
    console.log("   ✓ P2-1 brand-logo badge guard & lazy-photo anchoring verified on Android & iOS!");

    // 4I. P2-2 Extension Lazy-Loaded Photo Retry (awaiting_photo -> badged on img src/load mutation)
    const p22LazyHtml = `
      <div style="display:grid;grid-template-columns:1fr;gap:12px;padding:12px;">
        <div data-item-id="p22-lazy-card" style="width:220px;border:1px solid #e2e8f0;border-radius:10px;padding:8px;position:relative;">
          <div style="width:160px;height:160px;">
            <img id="p22-lazy-img" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="160" height="160" style="display:block;width:160px;height:160px;" alt="Siete Sea Salt Tortilla Chips" />
          </div>
          <a href="/ip/Siete-Sea-Salt-Tortilla-Chips-5-oz/44390999">
            <span data-automation-id="product-title">Siete Grain Free Sea Salt Tortilla Chips, 5 oz</span>
          </a>
        </div>
      </div>
    `;
    await storePage.navigate("https://www.walmart.com/search?q=p22-lazy-ext");
    await storePage.eval(`
      document.body.innerHTML = ${JSON.stringify(p22LazyHtml)};
      window.__p22ExtBatches = 0;
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
          id: "cleancart-p22-ext",
          getURL: function(p) { return p === "overlay.css" ? window.__heybrocOverlayCssUrl : ("https://www.heybroc.com/" + p); },
          sendMessage: function(msg, cb) {
            if (msg && msg.type === "CLEANCART_SCAN_BATCH" && Array.isArray(msg.items)) {
              window.__p22ExtBatches += msg.items.length;
              const results = {};
              for (const it of msg.items) {
                results[it.id] = { ok: true, result: { score: 82, rating: "Excellent", flagged: [] }, dietaryAlerts: [] };
              }
              const out = { ok: true, results };
              if (cb) setTimeout(() => cb(out), 5);
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
    await new Promise((r) => setTimeout(r, 450));
    const p22Before = await storePage.eval<{ badges: number; batches: number }>(
      `({ badges: document.querySelectorAll(".cc-photo-badge").length, batches: window.__p22ExtBatches })`,
    );
    assert(
      p22Before.badges === 0 && p22Before.batches === 0,
      `P2-2 Extension badged a 1x1 lazy placeholder prematurely: ${JSON.stringify(p22Before)}`,
    );
    await storePage.eval(`
      const lazyImg = document.getElementById("p22-lazy-img");
      lazyImg.src = ${JSON.stringify(placeholderSvgDataUrl)};
      lazyImg.dispatchEvent(new Event("load"));
    `);
    const p22After = await storePage.waitFor<{ badges: number; text: string }>(
      `(() => {
        const b = document.querySelector(".cc-photo-badge:not(.cc-photo-badge--loading)");
        if (!b) return null;
        return { badges: document.querySelectorAll(".cc-photo-badge").length, text: (b.textContent || "").trim() };
      })()`,
      "P2-2 Extension badges lazy-loaded photo card after src/load mutation",
      6000,
    );
    assert(
      p22After.badges === 1 && p22After.text.includes("82"),
      `P2-2 Extension failed to badge card after lazy image loaded: ${JSON.stringify(p22After)}`,
    );
    console.log(`   ✓ P2-2 Extension lazy-loaded photo retry verified (${p22After.text})!`);

    // 4J. P2-3 Exclude "Saved for later" & "Buy it again" inside plain <div> wrappers from Extension Cart
    const p23CartHtml = `
      <main>
        <h1>Cart (1 item)</h1>
        <div class="active-cart-box">
          <div data-testid="cart-item" style="display:flex;gap:12px;padding:12px;">
            <img src=${JSON.stringify(placeholderSvgDataUrl)} width="80" height="80" alt="Organic Honeycrisp Apples" />
            <a href="/ip/Organic-Honeycrisp-Apples-3-lb/10452110">Organic Honeycrisp Apples, 3 lb</a>
            <span>$6.99</span>
            <input type="number" aria-label="Quantity" value="1" />
            <button>Save for later</button>
          </div>
        </div>
        <div class="plain-saved-wrapper">
          <div><h2>Saved for later (2)</h2></div>
          <div data-testid="cart-item" style="display:flex;gap:12px;padding:12px;">
            <img src=${JSON.stringify(placeholderSvgDataUrl)} width="80" height="80" alt="Doritos Nacho Cheese" />
            <a href="/ip/Doritos-Nacho-Cheese-Tortilla-Chips/10452111">Doritos Nacho Cheese Tortilla Chips, 9.25 oz</a>
            <span>$4.98</span>
            <button>Move to cart</button>
          </div>
        </div>
        <div class="plain-buy-again-wrapper">
          <h3>Buy it again</h3>
          <div data-testid="cart-item" style="display:flex;gap:12px;padding:12px;">
            <img src=${JSON.stringify(placeholderSvgDataUrl)} width="80" height="80" alt="Hidden Valley Ranch" />
            <a href="/ip/Hidden-Valley-Original-Ranch/10452112">Hidden Valley Original Ranch Dressing, 16 fl oz</a>
            <span>$4.28</span>
            <button>Add to cart</button>
          </div>
        </div>
      </main>
    `;
    await storePage.navigate("https://www.walmart.com/cart");
    await storePage.eval(`
      document.body.innerHTML = ${JSON.stringify(p23CartHtml)};
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
          id: "cleancart-p23-ext",
          getURL: function(p) { return p === "overlay.css" ? window.__heybrocOverlayCssUrl : ("https://www.heybroc.com/" + p); },
          sendMessage: function(msg, cb) {
            const resp = msg && msg.type === "CLEANCART_AUDIT_CART_BATCH" ? { ok: true, results: {} } : { ok: false };
            if (cb) setTimeout(() => cb(resp), 2);
            return Promise.resolve(resp);
          },
          onMessage: { addListener: function() {} }
        }
      };
    `);
    await storePage.eval(extContentJS, false);
    const p23Cart = await storePage.waitFor<string[]>(
      `(() => {
        const st = window.__heybrocExtStorage || {};
        const key = Object.keys(st).find((k) => k.includes("walmart") && Array.isArray(st[k]) && st[k].length >= 1);
        if (!key) return null;
        return st[key].map((i) => i.title || "");
      })()`,
      "P2-3 Walmart cart excludes plain-div Saved for later & Buy it again items",
      6000,
    );
    assert(
      p23Cart.length === 1 &&
        /apples/i.test(p23Cart[0]) &&
        !p23Cart.some((t) => /doritos|ranch/i.test(t)),
      `P2-3 Cart accidentally included Saved for later / Buy it again items: ${JSON.stringify(p23Cart)}`,
    );
    console.log(`   ✓ P2-3 plain-div Saved for later & Buy it again excluded from cart (${p23Cart.join(", ")})!`);

    // 4K. Release Audit P1 #2: Hidden display:none ingredient panels must NEVER attach to the visible hero product
    // across Android live_store_detector.js, iOS detectorJS, and Chrome/Safari Extension content.js.
    const p12HiddenIngHtml = `
      <main>
        <h1>Quaker Old Fashioned Oats, 42 oz</h1>
        <img src=${JSON.stringify(placeholderSvgDataUrl)} width="280" height="280" alt="Quaker Old Fashioned Oats" />
        <button type="button">Add to cart</button>
        <div id="stale-hidden-panel" style="display:none">
          <h2>Ingredients</h2>
          <p>Water, Sugar, Corn Syrup, Red 40, Artificial Flavor.</p>
        </div>
        <div id="aria-hidden-panel" aria-hidden="true">
          <h3>Ingredients</h3>
          <div>High Fructose Corn Syrup, Yellow 5, Blue 1, Sodium Benzoate.</div>
        </div>
      </main>
    `;

    // Surface 1: Android live_store_detector.js
    await storePage.navigate("https://www.walmart.com/ip/Quaker-Old-Fashioned-Oats-42-oz/10312440");
    await storePage.eval(`
      document.body.innerHTML = ${JSON.stringify(p12HiddenIngHtml)};
      window.__p12AndroidProduct = null;
      window.heybrocAndroidBridge = {
        postMessage: function(rawJson) {
          const msg = JSON.parse(rawJson);
          if (msg._hbSec !== ${JSON.stringify(androidBridgeSecret)}) return;
          if (msg.kind === "product") window.__p12AndroidProduct = msg;
        }
      };
    `);
    await storePage.eval(androidDetectorJS, false);
    const p12Android = await storePage.waitFor<{ title?: string; ingredients?: string }>(
      `window.__p12AndroidProduct && /Quaker/i.test(window.__p12AndroidProduct.title || "") ? window.__p12AndroidProduct : null`,
      "P1 #2 Android hidden ingredient isolation",
      6000,
    );
    assert(
      !p12Android.ingredients || !/Red 40|Corn Syrup|Yellow 5/i.test(p12Android.ingredients),
      `P1 #2 Android detector leaked hidden ingredients: ${JSON.stringify(p12Android)}`,
    );

    // Surface 2: iOS detectorJS
    await storePage.navigate("https://www.walmart.com/ip/Quaker-Old-Fashioned-Oats-42-oz/10312441");
    await storePage.eval(`
      document.body.innerHTML = ${JSON.stringify(p12HiddenIngHtml)};
      window.__p12IosProduct = null;
      window.webkit = {
        messageHandlers: {
          heybrocStoreBridge: {
            postMessage: function(msg) {
              if (msg && msg.kind === "product") window.__p12IosProduct = msg;
            }
          }
        }
      };
    `);
    await storePage.eval(detectorJS, false);
    const p12Ios = await storePage.waitFor<{ title?: string; ingredients?: string }>(
      `window.__p12IosProduct && /Quaker/i.test(window.__p12IosProduct.title || "") ? window.__p12IosProduct : null`,
      "P1 #2 iOS hidden ingredient isolation",
      6000,
    );
    assert(
      !p12Ios.ingredients || !/Red 40|Corn Syrup|Yellow 5/i.test(p12Ios.ingredients),
      `P1 #2 iOS detector leaked hidden ingredients: ${JSON.stringify(p12Ios)}`,
    );

    // Surface 3: Chrome/Safari Extension content.js
    await storePage.navigate("https://www.walmart.com/ip/Quaker-Old-Fashioned-Oats-42-oz/10312442");
    await storePage.eval(`
      document.body.innerHTML = ${JSON.stringify(p12HiddenIngHtml)};
      window.__p12ExtScanPayload = null;
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
          id: "cleancart-p12-ext",
          getURL: function(p) { return p === "overlay.css" ? window.__heybrocOverlayCssUrl : ("https://www.heybroc.com/" + p); },
          sendMessage: function(msg, cb) {
            if (msg && msg.type === "CLEANCART_SCAN" && msg.payload) {
              window.__p12ExtScanPayload = msg.payload;
              const okResp = { ok: true, result: { score: 90, rating: "Excellent", flagged: [] }, product: { title: "Quaker Old Fashioned Oats", ingredients: "Whole grain rolled oats." } };
              if (cb) setTimeout(() => cb(okResp), 2);
              return Promise.resolve(okResp);
            }
            const empty = { ok: true, results: {} };
            if (cb) setTimeout(() => cb(empty), 2);
            return Promise.resolve(empty);
          },
          onMessage: { addListener: function() {} }
        }
      };
    `);
    await storePage.eval(extContentJS, false);
    const p12Ext = await storePage.waitFor<{ productTitle?: string; rawIngredients?: string }>(
      `window.__p12ExtScanPayload && /Quaker/i.test(window.__p12ExtScanPayload.productTitle || "") ? window.__p12ExtScanPayload : null`,
      "P1 #2 Chrome/Safari extension hidden ingredient isolation",
      6000,
    );
    assert(
      !p12Ext.rawIngredients || !/Red 40|Corn Syrup|Yellow 5/i.test(p12Ext.rawIngredients),
      `P1 #2 Chrome/Safari extension leaked hidden ingredients: ${JSON.stringify(p12Ext)}`,
    );
    console.log("   ✓ P1 #2 Hidden ingredient panels ignored across Android, iOS, and Chrome/Safari extension detectors!");

    // =========================================================================
    // SUITE 6 (Store Overlay v2.6.2/v2.6.3): Walmart /cart + Saved for later +
    // 2D Pill Aiming + Carousel Unpin + Instacart Cart Drawer + Unified 🌱 Icon
    // =========================================================================
    console.log("\n🛒 [5/6] Testing v2.6.2/v2.6.3 Floating Pill 2D Aiming, Carousel Unpin, Walmart /cart, Instacart Drawer & Unified 🌱 Icon...");

    // 6A: Walmart /cart with full-page <section>, Usuals horizontal carousel, Saved for later, and non-food Power Bank
    const walmartCartFixtureHtml = `
      <main style="padding:12px; font-family:system-ui,sans-serif;">
        <section style="display:block; width:100%; min-height:240px; padding:10px; background:#fff;">
          <h1>Cart (2 items)</h1>
          <div data-testid="cart-item-row" data-item-id="cart-milk-1" style="display:flex; gap:10px; padding:8px; border:1px solid #e2e8f0; margin-bottom:10px; width:340px; height:120px;">
            <img src="https://i5.walmartimages.com/asr/milk.jpg" width="90" height="90" alt="Great Value 2% Reduced Fat Milk, 1 Gallon" />
            <div>
              <a href="/ip/Great-Value-2-Reduced-Fat-Milk-Gallon/10450115" data-automation-id="product-title">Great Value 2% Reduced Fat Milk, 1 Gallon</a>
              <div>$3.48</div>
            </div>
          </div>
          <button type="button" style="width:100%; padding:10px; background:#0071dc; color:#fff;">Continue to checkout</button>
        </section>

        <section style="margin-top:16px;">
          <h2>Don't forget your usuals</h2>
          <div id="hb-usuals-carousel" style="display:flex; gap:12px; overflow-x:auto; width:370px; padding:8px 0;">
            <div data-item-id="usual-corn-1" style="flex:0 0 150px; width:150px; height:190px; border:1px solid #e2e8f0; padding:6px;">
              <img src="https://i5.walmartimages.com/asr/corn.jpg" width="120" height="100" alt="Great Value Whole Kernel Sweet Corn, 15.25 oz" />
              <a href="/ip/Great-Value-Whole-Kernel-Sweet-Corn/10415511" data-automation-id="product-title">Great Value Whole Kernel Sweet Corn, 15.25 oz</a>
            </div>
            <div data-item-id="usual-mac-2" style="flex:0 0 150px; width:150px; height:190px; border:1px solid #e2e8f0; padding:6px;">
              <img src="https://i5.walmartimages.com/asr/mac.jpg" width="120" height="100" alt="Kraft Original Macaroni and Cheese Dinner, 7.25 oz" />
              <a href="/ip/Kraft-Original-Macaroni-and-Cheese-Dinner/10295546" data-automation-id="product-title">Kraft Original Macaroni and Cheese Dinner, 7.25 oz</a>
            </div>
            <div data-item-id="usual-powerbank-3" style="flex:0 0 150px; width:150px; height:190px; border:1px solid #e2e8f0; padding:6px;">
              <img src="https://i5.walmartimages.com/asr/pb.jpg" width="120" height="100" alt="Anker PowerCore 10000mAh Portable Power Bank USB-C Charger" />
              <a href="/ip/Anker-PowerCore-10000-Power-Bank/99887766" data-automation-id="product-title">Anker PowerCore 10000mAh Portable Power Bank USB-C Charger</a>
            </div>
          </div>
        </section>

        <section style="margin-top:16px;">
          <h2>Saved for later</h2>
          <div data-item-id="saved-yogurt-1" style="display:flex; gap:10px; padding:8px; border:1px solid #e2e8f0; width:340px; height:120px;">
            <img src="https://i5.walmartimages.com/asr/yogurt.jpg" width="90" height="90" alt="Stonyfield Organic Whole Milk Plain Yogurt, 32 oz" />
            <div>
              <a href="/ip/Stonyfield-Organic-Whole-Milk-Plain-Yogurt/10801433" data-automation-id="product-title">Stonyfield Organic Whole Milk Plain Yogurt, 32 oz</a>
            </div>
          </div>
        </section>
      </main>
    `;

    await storePage.navigate("https://www.walmart.com/cart");
    await storePage.eval(`
      document.body.innerHTML = ${JSON.stringify(walmartCartFixtureHtml)};
      window.__s6BatchPayloads = [];
      window.__s6CardEvents = [];
      window.__heybrocBridgeSecret = ${JSON.stringify(androidBridgeSecret)};
      window.heybrocAndroidBridge = {
        postMessage: function(rawJson) {
          const msg = JSON.parse(rawJson);
          if (msg._hbSec !== ${JSON.stringify(androidBridgeSecret)}) return;
          if (msg.kind === "gridBatch") window.__s6BatchPayloads.push(msg);
          if (msg.kind === "card" || msg.kind === "inspectCard" || msg.kind === "product") window.__s6CardEvents.push(msg);
        }
      };
    `);
    await storePage.eval(androidDetectorJS, false);

    const s6BatchMeta = await storePage.waitFor<{
      pageToken: number;
      items: Array<{ id: string; productTitle: string }>;
    }>(
      `(() => {
        const payloads = window.__s6BatchPayloads || [];
        const all = payloads.flatMap((p) => p.items || []);
        const hasMilk = all.some((i) => /Great Value 2% Reduced Fat Milk/i.test(i.productTitle || ""));
        const hasCorn = all.some((i) => /Great Value Whole Kernel Sweet Corn/i.test(i.productTitle || ""));
        const hasSaved = all.some((i) => /Stonyfield Organic Whole Milk Plain Yogurt/i.test(i.productTitle || ""));
        return hasMilk && hasCorn && hasSaved
          ? { pageToken: payloads[payloads.length - 1]?.pageToken || 1, items: all }
          : null;
      })()`,
      "Walmart /cart + Usuals + Saved for later gridBatch candidates",
      8000,
    );
    const s6Batch = s6BatchMeta.items;
    assert(
      !s6Batch.some((i) => /Power Bank|PowerCore/i.test(i.productTitle || "")),
      `Non-food Power Bank should NEVER be batched for food scoring: ${JSON.stringify(s6Batch)}`,
    );
    console.log(
      `   ✓ Walmart /cart, Usuals carousel, and Saved-for-later food items all queued (${s6Batch.length} food items; non-food Power Bank skipped)`,
    );

    // Render photo badges (including unified 🌱 pesticide icon vs ⚠️ allergen icon), then test 2D pill aiming + badge pin + carousel swipe unpin!
    const cornCard = s6Batch.find((i) => /Sweet Corn/i.test(i.productTitle));
    const macCard = s6Batch.find((i) => /Macaroni/i.test(i.productTitle));
    const milkCard = s6Batch.find((i) => /Reduced Fat Milk/i.test(i.productTitle));
    assert(Boolean(cornCard && macCard && milkCard), "Expected corn, mac, and milk cardIds in Walmart /cart batch");

    const badgeAndPinResult = await storePage.eval<{
      cornBadgeText: string;
      macBadgeText: string;
      milkBadgeText: string;
      aimedLeftTitle: string;
      aimedRightTitle: string;
      pinnedTitle: string;
      unpinnedAfterCarouselSwipe: boolean;
    }>(`(async () => {
      window.__heybrocApplyCardBadges({
        [${JSON.stringify(cornCard!.id)}]: { ok: true, score: 65, hasAlert: true, alertSeverity: "advisory", alertIcon: "🌱" },
        [${JSON.stringify(macCard!.id)}]: { ok: true, score: 43, hasAlert: true, alertSeverity: "allergen", alertIcon: "⚠️" },
        [${JSON.stringify(milkCard!.id)}]: { ok: true, score: 88, hasAlert: false, alertSeverity: "none" }
      }, ${JSON.stringify(s6BatchMeta.pageToken)});
      await new Promise((r) => setTimeout(r, 120));

      const cornEl = document.querySelector('[data-item-id="usual-corn-1"]');
      const macEl = document.querySelector('[data-item-id="usual-mac-2"]');
      const cornBadge = document.querySelector('.hb-photo-badge[data-hb-card-id=' + ${JSON.stringify(JSON.stringify(cornCard!.id))} + ']');
      const macBadge = document.querySelector('.hb-photo-badge[data-hb-card-id=' + ${JSON.stringify(JSON.stringify(macCard!.id))} + ']');
      const milkBadge = document.querySelector('.hb-photo-badge[data-hb-card-id=' + ${JSON.stringify(JSON.stringify(milkCard!.id))} + ']');
      if (!cornBadge || !macBadge || !milkBadge) {
        throw new Error("Missing rendered photo badge(s): corn=" + Boolean(cornBadge) + " mac=" + Boolean(macBadge) + " milk=" + Boolean(milkBadge));
      }

      // Aim 2D bubble (in CSS pixels) directly over far-left Corn card
      const cr = cornEl.getBoundingClientRect();
      window.__heybrocBubbleCenterX = cr.left + cr.width * 0.5;
      window.__heybrocBubbleCenterY = cr.top + cr.height * 0.5;
      window.__s6CardEvents = [];
      if (typeof window.__heybrocScheduleCheck === "function") window.__heybrocScheduleCheck(true);
      await new Promise((r) => setTimeout(r, 260));
      const aimedLeftTitle = (window.__s6CardEvents[window.__s6CardEvents.length - 1]?.title) || "";

      // Aim 2D bubble (in CSS pixels) directly over center Mac & Cheese card
      const mr = macEl.getBoundingClientRect();
      window.__heybrocBubbleCenterX = mr.left + mr.width * 0.5;
      window.__heybrocBubbleCenterY = mr.top + mr.height * 0.5;
      window.__s6CardEvents = [];
      if (typeof window.__heybrocScheduleCheck === "function") window.__heybrocScheduleCheck(true);
      await new Promise((r) => setTimeout(r, 260));
      const aimedRightTitle = (window.__s6CardEvents[window.__s6CardEvents.length - 1]?.title) || "";

      // Tap the Corn badge to pin it, verify it emits inspectCard for Sweet Corn
      window.__s6CardEvents = [];
      cornBadge.click();
      await new Promise((r) => setTimeout(r, 180));
      const pinnedTitle = (window.__s6CardEvents[window.__s6CardEvents.length - 1]?.title) || "";

      // Horizontally swipe the Usuals carousel >28px -> should unpin Corn and re-aim at Mac (at bubble X/Y)
      const carousel = document.getElementById("hb-usuals-carousel");
      carousel.scrollLeft = 90;
      carousel.dispatchEvent(new Event("scroll", { bubbles: true }));
      window.__s6CardEvents = [];
      await new Promise((r) => setTimeout(r, 320));
      if (typeof window.__heybrocScheduleCheck === "function") window.__heybrocScheduleCheck(true);
      await new Promise((r) => setTimeout(r, 260));
      const afterSwipeTitle = (window.__s6CardEvents[window.__s6CardEvents.length - 1]?.title) || "";

      return {
        cornBadgeText: (cornBadge?.textContent || "").trim(),
        macBadgeText: (macBadge?.textContent || "").trim(),
        milkBadgeText: (milkBadge?.textContent || "").trim(),
        aimedLeftTitle,
        aimedRightTitle,
        pinnedTitle,
        unpinnedAfterCarouselSwipe: /Macaroni/i.test(afterSwipeTitle) || !/Sweet Corn/i.test(afterSwipeTitle)
      };
    })()`);

    assert(
      badgeAndPinResult.cornBadgeText.includes("🌱") && !badgeAndPinResult.cornBadgeText.includes("⚠"),
      `Pesticide-only badge must render 🌱 (not ⚠️), got "${badgeAndPinResult.cornBadgeText}"`,
    );
    assert(
      badgeAndPinResult.macBadgeText.includes("⚠") && !badgeAndPinResult.macBadgeText.includes("🌱"),
      `Allergen badge must render ⚠️ (not 🌱), got "${badgeAndPinResult.macBadgeText}"`,
    );
    assert(
      /88/.test(badgeAndPinResult.milkBadgeText),
      `Milk badge should show 88, got "${badgeAndPinResult.milkBadgeText}"`,
    );
    assert(
      /Sweet Corn/i.test(badgeAndPinResult.aimedLeftTitle),
      `2D bubble over far-left Corn card should aim at Sweet Corn, got "${badgeAndPinResult.aimedLeftTitle}"`,
    );
    assert(
      /Macaroni/i.test(badgeAndPinResult.aimedRightTitle),
      `2D bubble over center Mac card should aim at Macaroni, got "${badgeAndPinResult.aimedRightTitle}"`,
    );
    assert(
      /Sweet Corn/i.test(badgeAndPinResult.pinnedTitle),
      `Tapping Corn photo badge should pin Sweet Corn, got "${badgeAndPinResult.pinnedTitle}"`,
    );
    assert(
      badgeAndPinResult.unpinnedAfterCarouselSwipe,
      "Horizontal carousel scroll should unpin previously tapped Corn badge",
    );
    console.log("   ✓ 2D Floating Pill aiming, badge tap-pin, carousel swipe unpin, and unified 🌱 vs ⚠️ badge icons verified!");

    // 6B: Instacart slide-over Cart Drawer suppression (zero Scanning <-> Unavailable flicker)
    const instacartDrawerHtml = `
      <main style="padding:12px;">
        <div data-testid="item-card" style="width:180px; height:220px;">
          <img src="https://i5.walmartimages.com/asr/bg.jpg" width="120" height="120" alt="Chobani Greek Yogurt" />
          <a href="/products/12345">Chobani Non-Fat Plain Greek Yogurt, 32 oz</a>
        </div>
      </main>
      <div role="dialog" aria-modal="true" style="position:fixed; top:0; right:0; width:340px; height:852px; z-index:9999; background:#fff; padding:16px;">
        <h2>Personal Market 32 and Price Chopper Cart</h2>
        <p>Subtotal $42.19</p>
        <button type="button" style="width:100%; padding:14px; background:#108910; color:#fff;">Go to checkout</button>
      </div>
    `;
    await storePage.navigate("https://www.instacart.com/store/price-chopper-market-32/storefront");
    await storePage.eval(`
      document.body.innerHTML = ${JSON.stringify(instacartDrawerHtml)};
      window.__icEvents = [];
      window.__heybrocBridgeSecret = ${JSON.stringify(androidBridgeSecret)};
      window.heybrocAndroidBridge = {
        postMessage: function(rawJson) {
          const msg = JSON.parse(rawJson);
          if (msg._hbSec !== ${JSON.stringify(androidBridgeSecret)}) return;
          window.__icEvents.push(msg);
        }
      };
    `);
    await storePage.eval(androidDetectorJS, false);
    await sleep(600);
    const icDrawerEvents = await storePage.eval<{ productOrCardCount: number; browseCount: number }>(`({
      productOrCardCount: (window.__icEvents || []).filter((e) => e.kind === "product" || e.kind === "card").length,
      browseCount: (window.__icEvents || []).filter((e) => e.kind === "browse").length
    })`);
    assert(
      icDrawerEvents.productOrCardCount === 0,
      `Instacart slide-over cart drawer must suppress product/card scanning (zero flicker), got ${icDrawerEvents.productOrCardCount} events`,
    );
    console.log("   ✓ Instacart slide-over Cart Drawer suppresses background scanning with 0 flicker!");

    // 6C: 2D Horizontal Carousel Viewport Gating (off-screen horizontal cards wait until scrolled into view)
    const carouselHtml = `
      <main style="padding:8px; margin:0;">
        <div id="hb-test-carousel" style="display:flex; flex-direction:row; gap:10px; overflow-x:auto; width:374px; padding:4px 0;">
          ${Array.from({ length: 8 }, (_, idx) => `
            <div data-testid="item-card" style="flex:0 0 170px; width:170px; min-height:220px; display:flex; flex-direction:column;">
              <img src="https://i5.walmartimages.com/asr/car-${idx}.jpg" width="140" height="140" alt="Carousel Food ${idx}" style="width:140px;height:140px;display:block;" />
              <a href="/ip/carousel-item-${idx}/1000${idx}">Great Value Organic Pasta Sauce Variant ${idx + 1}, 24 oz</a>
            </div>
          `).join("")}
        </div>
      </main>
    `;
    await storePage.navigate("https://www.walmart.com/browse/food/976759");
    await storePage.eval(`
      if (!document.querySelector('meta[name="viewport"]')) {
        const mv = document.createElement('meta');
        mv.name = 'viewport';
        mv.content = 'width=device-width, initial-scale=1';
        document.head.appendChild(mv);
      }
      document.body.innerHTML = ${JSON.stringify(carouselHtml)};
      window.__carBatchTitles = [];
      window.__heybrocBridgeSecret = ${JSON.stringify(androidBridgeSecret)};
      window.heybrocAndroidBridge = {
        postMessage: function(rawJson) {
          const msg = JSON.parse(rawJson);
          if (msg._hbSec !== ${JSON.stringify(androidBridgeSecret)}) return;
          if (msg.kind === "gridBatch" && Array.isArray(msg.items)) {
            const respMap = {};
            for (const it of msg.items) {
              window.__carBatchTitles.push(String(it.productTitle || it.title || ""));
              respMap[it.id] = { ok: true, score: 88, hasAlert: false, alertSeverity: "none" };
            }
            setTimeout(function() {
              window.__heybrocApplyCardBadges && window.__heybrocApplyCardBadges(respMap, msg.pageToken);
            }, 30);
          }
        }
      };
    `);
    await storePage.eval(androidDetectorJS, false);
    await sleep(750);
    const carBefore = await storePage.eval<{ count: number; hasCard7: boolean; hasCard8: boolean }>(`({
      count: (window.__carBatchTitles || []).length,
      hasCard7: (window.__carBatchTitles || []).some((t) => t.includes("Variant 7")),
      hasCard8: (window.__carBatchTitles || []).some((t) => t.includes("Variant 8")),
    })`);
    assert(
      carBefore.count >= 1 && !carBefore.hasCard7 && !carBefore.hasCard8,
      `2D horizontal carousel gating failed: far off-screen cards queued prematurely: ${JSON.stringify(carBefore)}`,
    );
    await storePage.eval(`
      const car = document.getElementById("hb-test-carousel");
      if (car) {
        car.scrollLeft = 1050;
        car.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
      window.dispatchEvent(new Event("scroll"));
    `);
    await sleep(750);
    const carAfter = await storePage.eval<{ hasCard7: boolean; hasCard8: boolean }>(`({
      hasCard7: (window.__carBatchTitles || []).some((t) => t.includes("Variant 7")),
      hasCard8: (window.__carBatchTitles || []).some((t) => t.includes("Variant 8")),
    })`);
    assert(
      carAfter.hasCard7 || carAfter.hasCard8,
      `2D horizontal carousel did not queue newly revealed cards after horizontal scroll: ${JSON.stringify(carAfter)}`,
    );
    console.log("   ✓ 2D horizontal carousel viewport gating holds far off-screen cards and scans upon horizontal swipe!");

    // 6D: Sam's Club 2-Column List Card Below-Photo Placement & Stretched-Link Tap-Hijack Immunity
    const samsCrabHtml = `
      <main style="padding:10px; margin:0; width:370px;">
        <div class="sc-pc-medium-desktop-card-canary" style="position:relative; display:flex; flex-direction:row; gap:12px; padding:10px; border:1px solid #e2e8f0; border-radius:12px; background:#fff;">
          <div id="sams-crab-photo-col" style="position:relative; display:flex; flex-direction:column; width:136px; flex:0 0 136px;">
            <img id="sams-crab-img" src="https://scene7.samsclub.com/is/image/samsclub/crab-cakes.jpg" width="136" height="136" alt="Member's Mark Wild Caught Handmade Crab Cakes" style="width:136px;height:136px;display:block;object-fit:contain;" />
            <a id="sams-stretched-link" href="/p/members-mark-wild-caught-handmade-crab-cakes/prod999111" style="position:absolute; inset:0; z-index:50; display:block;" aria-label="Member's Mark Wild Caught Handmade Crab Cakes, Frozen, 6 ct."></a>
          </div>
          <div style="flex:1 1 auto; display:flex; flex-direction:column; gap:6px;">
            <a href="/p/members-mark-wild-caught-handmade-crab-cakes/prod999111" style="font-size:15px; font-weight:600; color:#0f172a; text-decoration:none;">
              Member's Mark Wild Caught Handmade Crab Cakes, Frozen, 6 ct.
            </a>
            <div style="font-size:14px; color:#334155;">Frozen Seafood · 6 ct.</div>
          </div>
        </div>
      </main>
    `;
    await storePage.navigate("https://www.samsclub.com/s/crab%20cakes");
    await storePage.eval(`
      document.body.innerHTML = ${JSON.stringify(samsCrabHtml)};
      window.__samsBatchItems = [];
      window.__samsPageToken = "";
      window.__samsInspects = [];
      window.__samsNavigated = false;
      window.__heybrocBridgeSecret = ${JSON.stringify(androidBridgeSecret)};
      window.heybrocAndroidBridge = {
        postMessage: function(rawJson) {
          const msg = JSON.parse(rawJson);
          if (msg._hbSec !== ${JSON.stringify(androidBridgeSecret)}) return;
          if (msg.kind === "gridBatch" && Array.isArray(msg.items)) {
            window.__samsPageToken = msg.pageToken || "";
            window.__samsBatchItems.push(...msg.items);
          } else if (msg.kind === "inspectCard") {
            window.__samsInspects.push(msg);
          }
        }
      };
      document.getElementById("sams-stretched-link")?.addEventListener("click", function(ev) {
        if (!ev.defaultPrevented) {
          window.__samsNavigated = true;
          ev.preventDefault();
        }
      });
    `);
    await storePage.eval(androidDetectorJS, false);
    await storePage.waitFor(`(window.__samsBatchItems || []).length >= 1`, "Sam's Club Crab Cakes card to queue");
    const samsCrabCheck = await storePage.eval<{
      isOverlay: boolean;
      inSlot: boolean;
      belowImage: boolean;
      badgeTop: number;
      imgBottom: number;
      inspectCount: number;
      inspectTitle: string;
      navigated: boolean;
      clickPrevented: boolean;
    }>(`(() => {
      const item = window.__samsBatchItems[0];
      const map = {};
      map[item.id] = { ok: true, score: 18, hasAlert: false, alertSeverity: "none" };
      window.__heybrocApplyCardBadges(map, window.__samsPageToken);
      const badge = document.querySelector('.hb-photo-badge[data-hb-card-id="' + item.id + '"]');
      const img = document.getElementById("sams-crab-img");
      const stretchedLink = document.getElementById("sams-stretched-link");
      const br = badge.getBoundingClientRect();
      const ir = img.getBoundingClientRect();
      // Simulate tapping directly at the badge center, dispatched on the stretched <a> overlay!
      const clickEv = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: br.left + br.width / 2,
        clientY: br.top + br.height / 2,
      });
      stretchedLink.dispatchEvent(clickEv);
      return {
        isOverlay: badge.classList.contains("hb-photo-badge--overlay"),
        inSlot: Boolean(badge.closest(".hb-photo-badge-slot")),
        belowImage: br.top >= ir.bottom - 2,
        badgeTop: Math.round(br.top),
        imgBottom: Math.round(ir.bottom),
        inspectCount: window.__samsInspects.length,
        inspectTitle: String(window.__samsInspects[0]?.title || ""),
        navigated: Boolean(window.__samsNavigated),
        clickPrevented: Boolean(clickEv.defaultPrevented),
      };
    })()`);
    assert(
      !samsCrabCheck.isOverlay && samsCrabCheck.inSlot && samsCrabCheck.belowImage,
      `Sam's Club Crab Cakes badge must mount cleanly BELOW the photo (not overlay): ${JSON.stringify(samsCrabCheck)}`,
    );
    assert(
      samsCrabCheck.inspectCount >= 1 &&
        /Crab Cakes/i.test(samsCrabCheck.inspectTitle) &&
        !samsCrabCheck.navigated &&
        samsCrabCheck.clickPrevented,
      `Sam's Club stretched-link tap-hijack protection failed: ${JSON.stringify(samsCrabCheck)}`,
    );
    console.log(
      `   ✓ Sam's Club Crab Cakes mounts cleanly below photo (imgBottom=${samsCrabCheck.imgBottom}px, badgeTop=${samsCrabCheck.badgeTop}px) & blocks stretched-link tap hijack!`,
    );

    // 6E: Option A "🥦 Check" Pill vs Blank Non-Food + Per-Item Transient Fast-Retry + PDP Hydration
    const optionAHtml = `
      <main style="padding:10px; display:grid; grid-template-columns:1fr 1fr; gap:10px; width:370px;">
        <div data-testid="item-card" style="display:flex; flex-direction:column;">
          <img src="https://i5.walmartimages.com/asr/nonfood.jpg" width="130" height="130" alt="Glass Jar" />
          <a href="/ip/ball-mason-jar/2001">Ball Wide Mouth Glass Canning Jar, 32 oz</a>
        </div>
        <div data-testid="item-card" style="display:flex; flex-direction:column;">
          <img src="https://i5.walmartimages.com/asr/unindexed.jpg" width="130" height="130" alt="Artisan Dip" />
          <a id="unindexed-food-link" href="/ip/local-artisan-garlic-dip/2002">Small Batch Local Artisan Roasted Garlic Dip, 8 oz</a>
        </div>
        <div data-testid="item-card" style="display:flex; flex-direction:column;">
          <img src="https://i5.walmartimages.com/asr/transient.jpg" width="130" height="130" alt="Organic Salsa" />
          <a href="/ip/transient-salsa/2003">Mesa Verde Organic Fire Roasted Salsa, 16 oz</a>
        </div>
      </main>
    `;
    await storePage.navigate("https://www.walmart.com/search?q=dips");
    await storePage.eval(`
      if (!document.querySelector('meta[name="viewport"]')) {
        const mv = document.createElement('meta');
        mv.name = 'viewport';
        mv.content = 'width=device-width, initial-scale=1';
        document.head.appendChild(mv);
      }
      document.body.innerHTML = ${JSON.stringify(optionAHtml)};
      window.__optABatch = [];
      window.__optAPageToken = "";
      window.__optAOpenUrls = [];
      window.__optALinkClicked = false;
      window.__heybrocBridgeSecret = ${JSON.stringify(androidBridgeSecret)};
      window.heybrocAndroidBridge = {
        postMessage: function(rawJson) {
          const msg = JSON.parse(rawJson);
          if (msg._hbSec !== ${JSON.stringify(androidBridgeSecret)}) return;
          if (msg.kind === "gridBatch" && Array.isArray(msg.items)) {
            window.__optAPageToken = msg.pageToken || "";
            window.__optABatch.push(...msg.items);
          } else if (msg.kind === "openCardUrl") {
            window.__optAOpenUrls.push(msg.url);
          }
        }
      };
      document.getElementById("unindexed-food-link")?.addEventListener("click", function(ev) {
        window.__optALinkClicked = true;
        ev.preventDefault();
      });
    `);
    await storePage.eval(androidDetectorJS, false);
    await storePage.waitFor(`(window.__optABatch || []).length >= 3`, "Option A cards to queue");
    const optACheck = await storePage.eval<{
      nonFoodBadgeRemoved: boolean;
      checkPillRendered: boolean;
      checkPillText: string;
      checkExcludedFromVisibleIds: boolean;
      checkTapNavigatedToPdp: boolean;
      upgradedScoreTextAfterPdpCache: string;
      transientClearedForRetry: boolean;
    }>(`(() => {
      const byTitle = (sub) => window.__optABatch.find((it) => String(it.productTitle || it.title || "").includes(sub));
      const nonFood = byTitle("Canning Jar");
      const unindexed = byTitle("Artisan Roasted Garlic Dip");
      const trans = byTitle("Fire Roasted Salsa");
      const map = {};
      map[nonFood.id] = { ok: false, isNonFood: true, transient: false };
      map[unindexed.id] = { ok: false, isNonFood: false, transient: false };
      map[trans.id] = { ok: false, isNonFood: false, transient: true };
      window.__heybrocApplyCardBadges(map, window.__optAPageToken);

      const nonFoodBadge = document.querySelector('.hb-photo-badge[data-hb-card-id="' + nonFood.id + '"]');
      const checkBadge = document.querySelector('.hb-photo-badge[data-hb-card-id="' + unindexed.id + '"]');
      const visIds = window.__heybrocGetVisibleCardIds ? window.__heybrocGetVisibleCardIds() : [];
      const checkExcludedFromVisibleIds = !visIds.includes(unindexed.id);
      const checkPillRendered = Boolean(checkBadge && checkBadge.classList.contains("hb-photo-badge--check"));
      const checkPillText = String(checkBadge?.textContent || "").trim();

      // Tap "Check" pill -> should trigger card product link click (or openCardUrl)
      if (checkBadge) checkBadge.click();
      const checkTapNavigatedToPdp = Boolean(window.__optALinkClicked || window.__optAOpenUrls.length > 0);

      // Simulate PDP verified scan hydrating the grid cache
      window.__heybrocCacheTitleScore(unindexed.productTitle || unindexed.title, { ok: true, score: 84, hasAlert: false, alertSeverity: "none" });
      const upgradedBadge = document.querySelector('.hb-photo-badge[data-hb-card-id="' + unindexed.id + '"]');
      const upgradedScoreTextAfterPdpCache = String(upgradedBadge?.textContent || "").trim();

      // Confirm transient card removed its loading badge and scheduled a retry (not stuck on Check)
      const transBadgeBeforeRetry = document.querySelector('.hb-photo-badge[data-hb-card-id="' + trans.id + '"]');
      window.__optATransientOrigId = trans.id;
      window.__optABatchCountBeforeRetry = window.__optABatch.length;

      return {
        nonFoodBadgeRemoved: !nonFoodBadge,
        checkPillRendered,
        checkPillText,
        checkExcludedFromVisibleIds,
        checkTapNavigatedToPdp,
        upgradedScoreTextAfterPdpCache,
        transientClearedForRetry: !transBadgeBeforeRetry,
      };
    })()`);
    assert(
      optACheck.nonFoodBadgeRemoved &&
        optACheck.checkPillRendered &&
        /Check/i.test(optACheck.checkPillText) &&
        optACheck.checkExcludedFromVisibleIds &&
        optACheck.checkTapNavigatedToPdp &&
        /84/.test(optACheck.upgradedScoreTextAfterPdpCache) &&
        optACheck.transientClearedForRetry,
      `Option A Check pill / blank non-food / PDP hydration check failed: ${JSON.stringify(optACheck)}`,
    );
    // Wait for the real 2.2s transient fast-retry batch to fire for Fire Roasted Salsa
    await storePage.waitFor(
      `window.__optABatch.slice(window.__optABatchCountBeforeRetry).some((it) => String(it.productTitle || it.title || "").includes("Fire Roasted Salsa"))`,
      "Transient Fire Roasted Salsa fast-retry gridBatch",
      5000,
    );
    const transResolvedText = await storePage.eval<string>(`(() => {
      const retryItem = window.__optABatch.slice(window.__optABatchCountBeforeRetry).find((it) => String(it.productTitle || it.title || "").includes("Fire Roasted Salsa"));
      const retryMap = {};
      retryMap[retryItem.id] = { ok: true, score: 91, hasAlert: false, alertSeverity: "none" };
      window.__heybrocApplyCardBadges(retryMap, window.__optAPageToken);
      const transBadge = document.querySelector('.hb-photo-badge[data-hb-card-id="' + retryItem.id + '"]');
      return String(transBadge?.textContent || "").trim();
    })()`);
    assert(/91/.test(transResolvedText), `Transient card fast-retry did not upgrade to 91: ${transResolvedText}`);
    console.log("   ✓ Option A 🥦 Check pill, blank non-food, PDP score hydration (Check -> 84), and real 2.2s transient fast-retry (91) verified!");

    // 6F: DoorDash & Cross-Store Smart App Banner Suppression (Whole-Banner <a> + Spacer, Clickable <div>/<span>, Bottom-Sheet Modal, Branch <iframe> & Header "Open App")
    const doorDashBannerHtml = `
      <div id="dd-smart-wrapper" style="width:390px; background:#fff; border-bottom:1px solid #e2e8f0;">
        <a id="dd-smart-app-banner" href="https://www.doordash.com/download" style="display:flex; align-items:center; justify-content:space-between; width:390px; height:84px; padding:8px 12px; text-decoration:none; color:#0f172a;">
          <div>
            <div style="font-weight:700;">Browse faster in the app</div>
            <div>$0 delivery fee on first order</div>
            <div>★★★★★ 20M ratings</div>
          </div>
          <span id="dd-smart-open-pill" style="background:#ef4444; color:#fff; padding:6px 14px; border-radius:999px;">Open</span>
        </a>
      </div>
      <div id="dd-banner-spacer" style="width:390px; height:76px;"></div>
      <iframe id="dd-branch-iframe" title="Open in App Banner" src="about:blank" style="width:390px; height:64px; border:0;"></iframe>
      <header id="dd-main-header" style="width:390px; background:#fff;">
        <div id="dd-div-only-banner" style="display:flex; align-items:center; justify-content:space-between; width:390px; height:60px; padding:6px 12px; cursor:pointer;">
          <div><div><div><div><div><div><div><div>
            <span>Better in the app — switch to the app</span>
          </div></div></div></div></div></div></div></div>
          <span>Open</span>
        </div>
        <div style="display:flex; align-items:center; justify-content:space-between; width:390px; height:54px; padding:0 12px;">
          <span id="dd-logo">DoorDash</span>
          <div style="display:flex; gap:8px;">
            <button id="dd-login-btn" type="button">Login</button>
            <a id="dd-header-open-app" href="https://doordash.onelink.me/12345">Open App</a>
          </div>
        </div>
      </header>
      <div id="dd-modal-backdrop" style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.45);">
        <div id="dd-upsell-modal" role="dialog" aria-modal="true" style="position:fixed; bottom:0; left:0; width:390px; height:180px; background:#fff; padding:16px;">
          <div>Continue in the DoorDash app for faster ordering</div>
          <button id="dd-modal-open" type="button">Open in App</button>
          <button id="dd-modal-dismiss" type="button" onclick="window.__ddModalDismissed = true;">Continue on web</button>
        </div>
      </div>
      <div id="dd-checkout-dialog" role="dialog" aria-modal="true" style="position:fixed; top:260px; left:20px; width:350px; height:140px; background:#fff; padding:12px;">
        <div>Review checkout delivery address</div>
        <button type="button">Place order</button>
      </div>
      <main style="padding:12px;">
        <div id="dd-address-bar">Your Addr...</div>
        <h1>Grocery Delivery</h1>
        <button id="dd-cart-btn" type="button">View Cart ($42.50)</button>
      </main>
    `;
    for (const surface of ["android", "ios"] as const) {
      await storePage.navigate(
        surface === "android"
          ? "https://www.doordash.com/grocery"
          : "https://www.doordash.com/grocery?ios_check=1",
      );
      await storePage.eval(`
        if (!document.querySelector('meta[name="viewport"]')) {
          const mv = document.createElement('meta');
          mv.name = 'viewport';
          mv.content = 'width=device-width, initial-scale=1';
          document.head.appendChild(mv);
        }
        document.body.innerHTML = ${JSON.stringify(doorDashBannerHtml)};
        document.body.style.overflow = "hidden";
        window.__ddModalDismissed = false;
        window.__heybrocBridgeSecret = ${JSON.stringify(androidBridgeSecret)};
        window.heybrocAndroidBridge = { postMessage: function() {} };
        window.webkit = { messageHandlers: { heybrocStoreBridge: { postMessage: function() {} } } };
      `);
      await storePage.eval(surface === "android" ? androidDetectorJS : detectorJS, false);
      await sleep(300);
      const ddBannerCheck = await storePage.eval<{
        smartWrapperHidden: boolean;
        spacerHidden: boolean;
        iframeHidden: boolean;
        divOnlyBannerHidden: boolean;
        headerOpenAppHidden: boolean;
        modalHiddenAndDismissed: boolean;
        backdropHidden: boolean;
        checkoutDialogStillVisible: boolean;
        scrollRestored: boolean;
        loginStillVisible: boolean;
        headerStillVisible: boolean;
        cartStillVisible: boolean;
      }>(`(() => {
        const isHid = (el) => Boolean(el && (el.getAttribute("data-hb-app-banner-hidden") === "1" || getComputedStyle(el).display === "none"));
        const isVis = (el) => Boolean(el && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden");
        return {
          smartWrapperHidden: isHid(document.getElementById("dd-smart-wrapper")) || isHid(document.getElementById("dd-smart-app-banner")),
          spacerHidden: isHid(document.getElementById("dd-banner-spacer")),
          iframeHidden: isHid(document.getElementById("dd-branch-iframe")),
          divOnlyBannerHidden: isHid(document.getElementById("dd-div-only-banner")),
          headerOpenAppHidden: isHid(document.getElementById("dd-header-open-app")),
          modalHiddenAndDismissed: isHid(document.getElementById("dd-upsell-modal")) && Boolean(window.__ddModalDismissed),
          backdropHidden: isHid(document.getElementById("dd-modal-backdrop")),
          checkoutDialogStillVisible: isVis(document.getElementById("dd-checkout-dialog")),
          scrollRestored: document.body.style.overflow !== "hidden",
          loginStillVisible: isVis(document.getElementById("dd-login-btn")),
          headerStillVisible: isVis(document.getElementById("dd-main-header")),
          cartStillVisible: isVis(document.getElementById("dd-cart-btn")),
        };
      })()`);
      assert(
        ddBannerCheck.smartWrapperHidden &&
          ddBannerCheck.spacerHidden &&
          ddBannerCheck.iframeHidden &&
          ddBannerCheck.divOnlyBannerHidden &&
          ddBannerCheck.headerOpenAppHidden &&
          ddBannerCheck.modalHiddenAndDismissed &&
          ddBannerCheck.backdropHidden &&
          ddBannerCheck.checkoutDialogStillVisible &&
          ddBannerCheck.scrollRestored &&
          ddBannerCheck.loginStillVisible &&
          ddBannerCheck.headerStillVisible &&
          ddBannerCheck.cartStillVisible,
        `[${surface}] DoorDash/cross-store app banner suppression failed: ${JSON.stringify(ddBannerCheck)}`,
      );
    }
    console.log("   ✓ DoorDash & cross-store app banners (whole-banner <a> + spacer, clickable <div>, upsell modal + backdrop, SmartBanner <iframe>, header Open App) suppressed on Android & iOS while Header/Login/Cart/Checkout dialog stay intact!");

    storePage.close();

    // =========================================================================
    // SUITE 5 (6/6): Full-App Route & Interactive Button Matrix (Desktop Chrome)
    // =========================================================================
    console.log("\n🖱️  [6/6] Auditing Every App Route & Interactive Button in Headless Chromium...");
    const appPage = await createPageTarget(resolvedCdpPort);
    await enableOfflineOffPhotoStub(appPage);
    await appPage.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });

    // 1) Visit every route across the entire Next.js app and assert healthy render & zero JS exceptions
    const allRoutes: Array<{ path: string; expectText: RegExp }> = [
      { path: "/", expectText: /HeyBroc/i },
      { path: "/test", expectText: /Score|Ingredient|Free/i },
      { path: "/tools", expectText: /Ingredient|Grader|Android/i },
      { path: "/swaps", expectText: /Clean.*Swaps/i },
      { path: "/swaps/doritos-nacho-cheese", expectText: /Doritos/i },
      { path: "/compare", expectText: /Yuka|Bobby/i },
      { path: "/compare/heybroc-vs-yuka", expectText: /Yuka/i },
      { path: "/creators", expectText: /Creator|Commission/i },
      { path: "/r/CLEANMOM", expectText: /CLEANMOM|Free Trial/i },
      { path: "/login", expectText: /HeyBroc/i },
      { path: "/delete-account", expectText: /Delete|Account/i },
      { path: "/privacy", expectText: /privacy@heybroc\.com/i },
      { path: "/terms", expectText: /billing@heybroc\.com/i },
      { path: "/independence", expectText: /Independent|100%/i },
    ];

    for (const r of allRoutes) {
      await appPage.navigate(`${baseOrigin}${r.path}`);
      const pageCheck = await appPage.eval<{ textLen: number; bodyText: string; url: string }>(`({
        textLen: (document.body.innerText || "").trim().length,
        bodyText: (document.body.innerText || ""),
        url: window.location.href
      })`);
      assert(pageCheck.textLen > 60, `Route ${r.path} rendered empty page`);
      assert(r.expectText.test(pageCheck.bodyText), `Route ${r.path} missing expected copy (${r.expectText})`);
      if (r.path === "/login") {
        assert(pageCheck.url.includes("login=1"), `/login should redirect to /?login=1, got ${pageCheck.url}`);
      }
      if (r.path === "/swaps/doritos-nacho-cheese") {
        const swapButtons = await appPage.eval<{ primaryLinks: number; allLinksAfterExpand: number; hasHttpsOnly: boolean; hasDisclosure: boolean }>(`(() => {
          const getRetailLinks = () => Array.from(document.querySelectorAll('a[target="_blank"]')).filter((a) => /Shop|Walmart|Target|Instacart|Amazon|Costco|Kroger|ALDI|Sam|BJ|DoorDash|Uber|Shipt/i.test(a.textContent || ""));
          const primaryLinks = getRetailLinks().length;
          const summary = Array.from(document.querySelectorAll("summary")).find((s) => /more stores/i.test(s.textContent || ""));
          if (summary) summary.click();
          const allLinks = getRetailLinks();
          return {
            primaryLinks,
            allLinksAfterExpand: allLinks.length,
            hasHttpsOnly: allLinks.every((a) => (a.getAttribute("href") || "").startsWith("https://")),
            hasDisclosure: /Amazon Associate|paid link|affiliate/i.test(document.body.innerText)
          };
        })()`);
        assert(swapButtons.primaryLinks >= 3, `/swaps/doritos-nacho-cheese missing primary store links (${swapButtons.primaryLinks})`);
        assert(swapButtons.allLinksAfterExpand >= 12, `/swaps/doritos-nacho-cheese should expose all 12 stores after expanding, got ${swapButtons.allLinksAfterExpand}`);
        assert(swapButtons.hasHttpsOnly, `/swaps/doritos-nacho-cheese has non-HTTPS store link`);
        assert(swapButtons.hasDisclosure, `/swaps/doritos-nacho-cheese missing affiliate/FTC disclosure`);
      }
      if (r.path === "/r/CLEANMOM") {
        const refCheck = await appPage.eval<{ hasTestHref: boolean; copyBtnWorks: boolean }>(`(async () => {
          const btn = Array.from(document.querySelectorAll("button")).find((b) => /Copy Code/i.test(b.textContent || ""));
          if (btn) btn.click();
          await new Promise((r) => setTimeout(r, 80));
          const testLink = Array.from(document.querySelectorAll("a")).find((a) => (a.getAttribute("href") || "").includes("/test"));
          return {
            hasTestHref: Boolean(testLink && testLink.getAttribute("href")?.includes("code=CLEANMOM")),
            copyBtnWorks: Boolean(btn)
          };
        })()`);
        assert(refCheck.hasTestHref, "/r/CLEANMOM missing /test?code=CLEANMOM CTA");
      }
    }
    console.log(`   ✓ All ${allRoutes.length} app routes rendered cleanly with verified links, FTC disclosures & /login redirect`);

    // 2) Verify /tools?platform=ios hides Android APK download card
    await appPage.navigate(`${baseOrigin}/tools?platform=ios`);
    const toolsIosCheck = await appPage.eval<boolean>(`!document.body.innerText.includes("Download Android APK")`);
    assert(toolsIosCheck, "/tools?platform=ios must hide Android APK download card");
    console.log("   ✓ /tools?platform=ios cleanly hides Android APK card");

    // 3) Verify EVERY interactive button & modal on / (Home Simulator, Floating Pill, AuthModal incl. Send Reset Code + Post-Signup Verification, Paywall, Watchlist, Label Scanner, Weekly Audit)
    await appPage.navigate(`${baseOrigin}/`);
    await appPage.waitFor(`Boolean(document.getElementById("open-auth-modal"))`, "Home page topbar to mount");

    // 3a) Test AuthModal: 1-tap buttons -> Email tab -> Sign In / Create Account tabs -> Forgot Password + Send Reset Code button -> Full Email Sign-Up stays open on Verification screen -> Log out
    const testEmail = `audit-e2e-${Date.now()}@example.com`;
    const authMatrix = await appPage.eval<{
      hasAppleBtn: boolean;
      hasGoogleBtn: boolean;
      hasUseEmailBtn: boolean;
      hasGuestBtn: boolean;
      hasSendResetCodeBtn: boolean;
      resetCodePromptShown: boolean;
      signupStayedOpenOnVerify: boolean;
      hasVerifyLaterCta: boolean;
      loggedOutCleanly: boolean;
    }>(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const setVal = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        setter?.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };

      document.getElementById("open-auth-modal")?.click();
      await wait(120);
      const hasAppleBtn = Boolean(document.getElementById("auth-apple-btn"));
      const hasGoogleBtn = Boolean(document.getElementById("auth-google-btn"));
      const hasUseEmailBtn = Boolean(document.getElementById("auth-use-email-btn"));
      const hasGuestBtn = Boolean(document.getElementById("auth-continue-guest"));

      // Expand email form -> switch to Sign In -> tap Forgot password? BEFORE typing email
      document.getElementById("auth-use-email-btn")?.click();
      await wait(80);
      document.getElementById("auth-tab-signin")?.click();
      await wait(80);
      const forgotBtn = Array.from(document.querySelectorAll("button")).find((b) => /Forgot password/i.test(b.textContent || ""));
      forgotBtn?.click();
      await wait(120);
      const sendResetBtn = document.getElementById("auth-send-reset-code-btn");
      const hasSendResetCodeBtn = Boolean(sendResetBtn);
      sendResetBtn?.click();
      await wait(100);
      const resetCodePromptShown = /Enter your account email/i.test(document.body.innerText);

      // Go back from forgot -> Create Free Account -> submit fresh email account -> verify stays open on verification step
      document.querySelector('button[aria-label="Back to email sign in"]')?.click();
      await wait(80);
      document.getElementById("auth-tab-signup")?.click();
      await wait(80);
      setVal(document.getElementById("auth-email-input"), ${JSON.stringify(testEmail)});
      setVal(document.getElementById("auth-password-input"), "CleanCartTest123!");
      await wait(60);
      document.getElementById("auth-submit-btn")?.click();

      // Wait for logged-in verification screen
      let signupStayedOpenOnVerify = false;
      let hasVerifyLaterCta = false;
      for (let i = 0; i < 30; i++) {
        await wait(120);
        const contBtn = document.getElementById("auth-continue-shopping-btn");
        if (contBtn && document.body.innerText.includes("6-digit verification code")) {
          signupStayedOpenOnVerify = true;
          hasVerifyLaterCta = /Verify Later/i.test(contBtn.textContent || "");
          break;
        }
      }

      // Log out cleanly
      const logoutBtn = Array.from(document.querySelectorAll("button")).find((b) => /^Log out$/i.test((b.textContent || "").trim()));
      logoutBtn?.click();
      await wait(120);
      const loggedOutCleanly = !document.getElementById("auth-continue-shopping-btn");

      return {
        hasAppleBtn,
        hasGoogleBtn,
        hasUseEmailBtn,
        hasGuestBtn,
        hasSendResetCodeBtn,
        resetCodePromptShown,
        signupStayedOpenOnVerify,
        hasVerifyLaterCta,
        loggedOutCleanly
      };
    })()`);

    assert(
      authMatrix.hasAppleBtn && authMatrix.hasGoogleBtn && authMatrix.hasUseEmailBtn && authMatrix.hasGuestBtn,
      `AuthModal missing core 1-tap buttons: ${JSON.stringify(authMatrix)}`,
    );
    assert(
      authMatrix.hasSendResetCodeBtn && authMatrix.resetCodePromptShown,
      `AuthModal forgot-password Send Reset Code button broken: ${JSON.stringify(authMatrix)}`,
    );
    assert(
      authMatrix.signupStayedOpenOnVerify && authMatrix.hasVerifyLaterCta,
      `AuthModal email signup should stay open on 6-digit verification step with Verify Later CTA: ${JSON.stringify(authMatrix)}`,
    );
    assert(authMatrix.loggedOutCleanly, "AuthModal Log out button failed to close/reset");
    console.log("   ✓ AuthModal 1-tap, Forgot Password Send Reset Code, Email Signup Verification & Logout verified!");

    // 3b) Test Topbar More Menu, Floating Pill, Watchlist, Label Scanner, Weekly Audit, and Paywall buttons on /
    const uiButtonChecks = await appPage.eval<{
      pesticideToggled: boolean;
      labelScannerOpened: boolean;
      weeklyAuditOpened: boolean;
      floatingPillPresent: boolean;
      paywallControlsWorked: boolean;
    }>(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));

      // More menu -> Pesticide toggle
      document.getElementById("topbar-more-menu-btn")?.click();
      await wait(80);
      const pestBtn = document.getElementById("topbar-pesticide-toggle");
      const beforePest = pestBtn?.getAttribute("aria-pressed") || pestBtn?.textContent || "";
      pestBtn?.click();
      await wait(80);
      const afterPest = document.getElementById("topbar-pesticide-toggle")?.getAttribute("aria-pressed") || document.getElementById("topbar-pesticide-toggle")?.textContent || "";
      const pesticideToggled = Boolean(pestBtn) && (beforePest !== afterPest || Boolean(document.getElementById("pill-dietary-alert")));

      // More menu -> Label Scanner modal
      if (!document.getElementById("topbar-label-scanner")) {
        document.getElementById("topbar-more-menu-btn")?.click();
        await wait(80);
      }
      document.getElementById("topbar-label-scanner")?.click();
      await wait(150);
      const labelCloseBtn = document.querySelector('button[aria-label="Close label scanner"]');
      const labelScannerOpened = Boolean(labelCloseBtn) && /Scan.*Label|Upload.*Photo|Ingredients/i.test(document.body.innerText);
      labelCloseBtn?.click();
      await wait(100);

      // More menu -> Weekly Order Audit modal
      if (!document.getElementById("topbar-weekly-audit")) {
        document.getElementById("topbar-more-menu-btn")?.click();
        await wait(80);
      }
      document.getElementById("topbar-weekly-audit")?.click();
      await wait(150);
      const weeklyCloseBtn = document.querySelector('button[aria-label="Close weekly order auditor"]');
      const weeklyAuditOpened = Boolean(weeklyCloseBtn) && /Weekly.*Audit|Paste.*Order|Receipt/i.test(document.body.innerText);
      weeklyCloseBtn?.click();
      await wait(100);

      // Floating pill + 5-Tab Overlay Bottom Nav + Store Brand toggle + Paywall modal
      const floatingPillPresent = Boolean(document.getElementById("floating-overlay-pill"));
      document.getElementById("floating-overlay-pill")?.click();
      await wait(140);
      const navButtons = Array.from(document.querySelectorAll('nav[aria-label="HeyBroc tabs"] button'));
      for (const tabLabel of ["Scans", "Top Picks", "Swaps", "Search"]) {
        const tabBtn = navButtons.find((b) => (b.textContent || "").trim().includes(tabLabel));
        tabBtn?.click();
        await wait(90);
      }
      document.getElementById("toggle-prefer-store-brand")?.click();
      await wait(80);

      // Open Paywall & click Annual/Monthly/ARL checkbox/Close
      let paywallBtn = document.getElementById("app-open-paywall");
      if (!paywallBtn) {
        paywallBtn = Array.from(document.querySelectorAll("button")).find((b) => /Unlock.*Pro|Upgrade|7-Day Free/i.test(b.textContent || "")) || null;
      }
      let paywallControlsWorked = false;
      if (paywallBtn) {
        paywallBtn.click();
        await wait(180);
        const mBtn = document.getElementById("plan-monthly");
        const aBtn = document.getElementById("plan-annual");
        const arl = document.getElementById("paywall-arl-consent");
        const closePw = document.querySelector('button[aria-label="Close paywall"]');
        mBtn?.click();
        await wait(60);
        aBtn?.click();
        await wait(60);
        arl?.click();
        await wait(60);
        paywallControlsWorked = Boolean(mBtn && aBtn && document.getElementById("paywall-cta") && closePw);
        closePw?.click();
        await wait(80);
      }

      return {
        pesticideToggled,
        labelScannerOpened,
        weeklyAuditOpened,
        floatingPillPresent,
        paywallControlsWorked
      };
    })()`);

    assert(uiButtonChecks.floatingPillPresent, "Floating overlay pill (#floating-overlay-pill) missing on /");
    assert(uiButtonChecks.pesticideToggled, "Topbar 🌱 Pesticide toggle button did not respond");
    assert(uiButtonChecks.labelScannerOpened, "Label Scanner modal button did not open");
    assert(uiButtonChecks.weeklyAuditOpened, "Weekly Order Audit modal button did not open");
    assert(uiButtonChecks.paywallControlsWorked, "Paywall modal plan/consent buttons failed");
    assert(
      appPage.exceptions.length === 0,
      `Uncaught JS exceptions across Full-App Button Matrix: ${appPage.exceptions.join(" | ")}`,
    );
    console.log("   ✓ Topbar More menu, 🌱 Pesticides toggle, Floating Pill, Label Scanner, Weekly Audit & Paywall buttons verified with 0 JS exceptions!");
    appPage.close();

    console.log("\n✅ ALL 6 HEADLESS BROWSER E2E SUITES PASSED (iPhone + Android + Extension + Floating Pill 2D + Full-App Button Matrix)!");
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
