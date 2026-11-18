// HeyBroc background service worker.
// Content scripts message this worker so API calls bypass store-page CORS / CSP restrictions
// and attach authenticated device credentials + active Watchlist preferences.

const DEFAULT_API = "https://www.heybroc.com";

async function getOrCreateDeviceCredentials() {
  const stored = await chrome.storage.local.get(["heybroc_device_id", "heybroc_device_secret"]);
  let deviceId = stored.heybroc_device_id;
  let deviceSecret = stored.heybroc_device_secret;
  if (!deviceId || !deviceSecret) {
    deviceId = `ext-${crypto.randomUUID()}`;
    deviceSecret = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
    await chrome.storage.local.set({
      heybroc_device_id: deviceId,
      heybroc_device_secret: deviceSecret,
    });
  }
  return { deviceId, deviceSecret };
}

chrome.runtime.onInstalled.addListener(() => {
  void getOrCreateDeviceCredentials();
});

async function sendNativeAppGroupMessage(payload) {
  try {
    const rt = (typeof browser !== "undefined" && browser.runtime?.sendNativeMessage)
      ? browser.runtime
      : chrome?.runtime;
    if (typeof rt?.sendNativeMessage !== "function") return null;
    const reply = await new Promise((resolve) => {
      try {
        const maybePromise = rt.sendNativeMessage("com.heybroc.app", payload, (res) => {
          resolve(res || null);
        });
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.then((res) => resolve(res || null)).catch(() => resolve(null));
        }
      } catch {
        resolve(null);
      }
    });
    return reply && reply.ok ? reply : null;
  } catch {
    return null;
  }
}

async function readNativeAppGroupPrefs() {
  return sendNativeAppGroupMessage({ action: "getSharedPreferences" });
}

async function persistRotatedDeviceSecret(secret) {
  if (!secret || typeof secret !== "string") return;
  try {
    await chrome.storage.local.set({ heybroc_device_secret: secret });
  } catch {
    /* ignore */
  }
  await sendNativeAppGroupMessage({ action: "setSharedPreferences", deviceSecret: secret });
}

function sameJsonValue(a, b) {
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  } catch {
    return false;
  }
}

async function getSettings() {
  const [syncData, localData, { deviceId, deviceSecret }, nativePrefs] = await Promise.all([
    chrome.storage.sync.get(["apiBase", "watchlist", "familyWatchlist", "dietaryWatchlist", "preferStoreBrand"]),
    chrome.storage.local.get(["watchlist", "familyWatchlist", "dietaryWatchlist", "preferStoreBrand", "heybroc_creator_code", "heybroc_auth_token"]),
    getOrCreateDeviceCredentials(),
    readNativeAppGroupPrefs(),
  ]);
  const hasNativePrefs = Boolean(nativePrefs && nativePrefs.ok);
  const resolvedDeviceId =
    hasNativePrefs && nativePrefs.deviceId && String(nativePrefs.deviceId).length >= 8
      ? String(nativePrefs.deviceId)
      : deviceId;
  const resolvedDeviceSecret =
    hasNativePrefs && nativePrefs.deviceSecret && String(nativePrefs.deviceSecret).length > 0
      ? String(nativePrefs.deviceSecret)
      : deviceSecret;
  const resolvedAuthToken = hasNativePrefs
    ? (nativePrefs.authToken && String(nativePrefs.authToken)) || undefined
    : localData.heybroc_auth_token || undefined;

  const resolvedDietary = hasNativePrefs && Array.isArray(nativePrefs.dietaryWatchlist)
    ? nativePrefs.dietaryWatchlist
    : syncData.dietaryWatchlist || localData.dietaryWatchlist || undefined;
  const resolvedFamily = hasNativePrefs && Array.isArray(nativePrefs.familyWatchlist)
    ? nativePrefs.familyWatchlist
    : syncData.familyWatchlist || localData.familyWatchlist || undefined;
  const resolvedPreferStoreBrand =
    hasNativePrefs && typeof nativePrefs.preferStoreBrand === "boolean"
      ? nativePrefs.preferStoreBrand
      : syncData.preferStoreBrand ?? localData.preferStoreBrand ?? undefined;

  const updates = {};
  if (resolvedDeviceId !== deviceId) updates.heybroc_device_id = resolvedDeviceId;
  if (resolvedDeviceSecret !== deviceSecret) updates.heybroc_device_secret = resolvedDeviceSecret;
  if (resolvedAuthToken && resolvedAuthToken !== localData.heybroc_auth_token) {
    updates.heybroc_auth_token = resolvedAuthToken;
  }
  if (hasNativePrefs) {
    if (Array.isArray(nativePrefs.dietaryWatchlist) && !sameJsonValue(localData.dietaryWatchlist, nativePrefs.dietaryWatchlist)) {
      updates.dietaryWatchlist = nativePrefs.dietaryWatchlist;
    }
    if (Array.isArray(nativePrefs.familyWatchlist) && !sameJsonValue(localData.familyWatchlist, nativePrefs.familyWatchlist)) {
      updates.familyWatchlist = nativePrefs.familyWatchlist;
    }
    if (typeof nativePrefs.preferStoreBrand === "boolean" && localData.preferStoreBrand !== nativePrefs.preferStoreBrand) {
      updates.preferStoreBrand = nativePrefs.preferStoreBrand;
    }
  }

  try {
    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }
    if (hasNativePrefs && !resolvedAuthToken && localData.heybroc_auth_token) {
      await chrome.storage.local.remove("heybroc_auth_token");
    }
  } catch {
    /* ignore */
  }

  const rawBase = (syncData.apiBase || DEFAULT_API).replace(/\/+$/, "");
  const normalizedBase = rawBase === "https://heybroc.com" ? "https://www.heybroc.com" : rawBase;
  return {
    apiBase: normalizedBase,
    watchlist: syncData.watchlist || localData.watchlist || undefined,
    familyWatchlist: resolvedFamily,
    dietaryWatchlist: resolvedDietary,
    preferStoreBrand: resolvedPreferStoreBrand,
    creatorCode: localData.heybroc_creator_code || undefined,
    deviceId: resolvedDeviceId,
    deviceSecret: resolvedDeviceSecret,
    authToken: resolvedAuthToken,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "CLEANCART_GET_CLIENT_INFO") {
    (async () => {
      try {
        const { apiBase, deviceId, creatorCode } = await getSettings();
        sendResponse({ ok: true, apiBase, deviceId, creatorCode });
      } catch (err) {
        sendResponse({ ok: false, apiBase: DEFAULT_API, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "CLEANCART_SCAN") {
    (async () => {
      try {
        const { apiBase, watchlist, familyWatchlist, dietaryWatchlist, preferStoreBrand, deviceId, deviceSecret, authToken } = await getSettings();
        const res = await fetch(`${apiBase}/api/scan`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Device-Secret": deviceSecret,
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({
            ...msg.payload,
            watchlist,
            familyWatchlist,
            dietaryWatchlist,
            ...(preferStoreBrand !== undefined ? { preferStoreBrand } : {}),
            ...(authToken ? { authToken } : {}),
            deviceId,
            deviceSecret,
            surface: "extension",
            clientPlatform: "ios-safari",
            format: "json",
          }),
        });
        const data = await res.json();
        if (data?.issuedDeviceSecret) {
          await persistRotatedDeviceSecret(data.issuedDeviceSecret);
        }
        sendResponse(data);
      } catch (err) {
        sendResponse({ ok: false, error: `HeyBroc API unreachable: ${err?.message || err}` });
      }
    })();
    return true;
  }

  if (msg?.type === "CLEANCART_SCAN_BATCH") {
    (async () => {
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 8500);
      try {
        const { apiBase, watchlist, familyWatchlist, dietaryWatchlist, preferStoreBrand, deviceId, deviceSecret, authToken } = await getSettings();
        const res = await fetch(`${apiBase}/api/scan`, {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            "Content-Type": "application/json",
            "X-Device-Secret": deviceSecret,
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({
            items: Array.isArray(msg.items) ? msg.items.slice(0, 8) : [],
            store: msg.store,
            instacartRetailerSlug: msg.instacartRetailerSlug,
            watchlist,
            familyWatchlist,
            dietaryWatchlist,
            ...(preferStoreBrand !== undefined ? { preferStoreBrand } : {}),
            ...(authToken ? { authToken } : {}),
            deviceId,
            deviceSecret,
            surface: "extension",
            clientPlatform: "ios-safari",
            format: "json",
          }),
        });
        const retrySec = Number(res.headers.get("retry-after")) || 0;
        const data = await res.json().catch(() => null);
        if (data?.issuedDeviceSecret) {
          await persistRotatedDeviceSecret(data.issuedDeviceSecret);
        }
        if (!res.ok || !data) {
          sendResponse({
            ok: false,
            status: res.status,
            transient: res.status === 429 || res.status >= 500,
            retryAfterMs: retrySec > 0 ? retrySec * 1000 : 2200,
            error: data?.error || `HTTP ${res.status}`,
          });
          return;
        }
        sendResponse(data);
      } catch (err) {
        sendResponse({
          ok: false,
          transient: true,
          retryAfterMs: 2500,
          error: `HeyBroc Batch API unreachable: ${err?.message || err}`,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    })();
    return true;
  }

  if (msg?.type === "CLEANCART_AUDIT") {
    (async () => {
      try {
        const { apiBase, watchlist, familyWatchlist, dietaryWatchlist, deviceId, deviceSecret, authToken } = await getSettings();
        const res = await fetch(`${apiBase}/api/audit`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Device-Secret": deviceSecret,
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({
            ...msg.payload,
            watchlist,
            familyWatchlist,
            dietaryWatchlist,
            ...(authToken ? { authToken } : {}),
            deviceId,
            deviceSecret,
            surface: "extension",
            clientPlatform: "ios-safari",
          }),
        });
        const data = await res.json();
        if (data?.issuedDeviceSecret) {
          await persistRotatedDeviceSecret(data.issuedDeviceSecret);
        }
        sendResponse(data);
      } catch (err) {
        sendResponse({ ok: false, error: `HeyBroc Audit unreachable: ${err?.message || err}` });
      }
    })();
    return true;
  }

  if (msg?.type === "CLEANCART_RECORD_SWAP") {
    (async () => {
      try {
        const { apiBase, deviceId, deviceSecret, authToken } = await getSettings();
        const res = await fetch(`${apiBase}/api/referral`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Device-Secret": deviceSecret,
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({
            action: "record_swap",
            deviceId,
            deviceSecret,
            productKey: msg.productKey,
          }),
        });
        const data = await res.json();
        if (data?.issuedDeviceSecret) {
          await persistRotatedDeviceSecret(data.issuedDeviceSecret);
        }
        sendResponse(data);
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "CLEANCART_LABEL_REPORT") {
    (async () => {
      try {
        const { apiBase, watchlist, familyWatchlist, dietaryWatchlist, preferStoreBrand, deviceId, deviceSecret } = await getSettings();
        const res = await fetch(`${apiBase}/api/label-report`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Device-Secret": deviceSecret,
          },
          body: JSON.stringify({
            ...msg.payload,
            watchlist,
            familyWatchlist,
            dietaryWatchlist,
            ...(preferStoreBrand !== undefined ? { preferStoreBrand } : {}),
            deviceId,
          }),
        });
        const data = await res.json();
        sendResponse(data);
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "CLEANCART_FETCH_IMAGE_DATA_URL") {
    (async () => {
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 6000);
      try {
        const rawUrl = typeof msg.url === "string" ? msg.url.trim() : "";
        if (!rawUrl) {
          sendResponse({ ok: false });
          return;
        }
        const { apiBase } = await getSettings();
        const parsed = new URL(rawUrl);
        let allowed =
          parsed.protocol === "https:" &&
          parsed.hostname === "images.openfoodfacts.org" &&
          parsed.pathname.startsWith("/images/products/");
        if (!allowed) {
          let apiOrigin = "https://www.heybroc.com";
          try {
            apiOrigin = new URL(apiBase).origin;
          } catch {
            /* ignore */
          }
          const isHeyBrocOrigin =
            parsed.origin === apiOrigin ||
            parsed.origin === "https://www.heybroc.com" ||
            parsed.origin === "https://heybroc.com";
          if (
            isHeyBrocOrigin &&
            (parsed.pathname.startsWith("/swaps/") ||
              parsed.pathname.startsWith("/products/") ||
              parsed.pathname.startsWith("/api/product-image"))
          ) {
            allowed = true;
          }
        }
        if (!allowed) {
          sendResponse({ ok: false });
          return;
        }
        const res = await fetch(parsed.toString(), {
          method: "GET",
          signal: ctrl.signal,
          credentials: "omit",
        });
        if (!res.ok) {
          sendResponse({ ok: false, status: res.status });
          return;
        }
        const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!ct.startsWith("image/") || ct.includes("svg")) {
          sendResponse({ ok: false });
          return;
        }
        const contentLen = Number(res.headers.get("content-length") || "0");
        if (contentLen > 2 * 1024 * 1024) {
          sendResponse({ ok: false });
          return;
        }
        const buf = await res.arrayBuffer();
        if (!buf || buf.byteLength === 0 || buf.byteLength > 2 * 1024 * 1024) {
          sendResponse({ ok: false });
          return;
        }
        const bytes = new Uint8Array(buf);
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        sendResponse({ ok: true, dataUrl: `data:${ct};base64,${btoa(binary)}` });
      } catch {
        sendResponse({ ok: false });
      } finally {
        clearTimeout(timeoutId);
      }
    })();
    return true;
  }

  return false;
});
