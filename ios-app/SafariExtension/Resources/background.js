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

async function readNativeAppGroupPrefs() {
  try {
    const rt = (typeof browser !== "undefined" && browser.runtime?.sendNativeMessage)
      ? browser.runtime
      : chrome?.runtime;
    if (typeof rt?.sendNativeMessage !== "function") return null;
    const reply = await new Promise((resolve) => {
      try {
        const maybePromise = rt.sendNativeMessage("com.heybroc.app", { action: "getSharedPreferences" }, (res) => {
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

async function getSettings() {
  const [syncData, localData, { deviceId, deviceSecret }, nativePrefs] = await Promise.all([
    chrome.storage.sync.get(["apiBase", "watchlist", "familyWatchlist", "dietaryWatchlist", "preferStoreBrand"]),
    chrome.storage.local.get(["watchlist", "familyWatchlist", "dietaryWatchlist", "preferStoreBrand", "heybroc_creator_code"]),
    getOrCreateDeviceCredentials(),
    readNativeAppGroupPrefs(),
  ]);
  const rawBase = (syncData.apiBase || DEFAULT_API).replace(/\/+$/, "");
  const normalizedBase = rawBase === "https://heybroc.com" ? "https://www.heybroc.com" : rawBase;
  const resolvedDietary =
    syncData.dietaryWatchlist ||
    localData.dietaryWatchlist ||
    (Array.isArray(nativePrefs?.dietaryWatchlist) && nativePrefs.dietaryWatchlist.length > 0 ? nativePrefs.dietaryWatchlist : undefined);
  const resolvedFamily =
    syncData.familyWatchlist ||
    localData.familyWatchlist ||
    (Array.isArray(nativePrefs?.familyWatchlist) && nativePrefs.familyWatchlist.length > 0 ? nativePrefs.familyWatchlist : undefined);
  const resolvedPreferStoreBrand =
    syncData.preferStoreBrand ?? localData.preferStoreBrand ?? nativePrefs?.preferStoreBrand ?? undefined;
  return {
    apiBase: normalizedBase,
    watchlist: syncData.watchlist || localData.watchlist || undefined,
    familyWatchlist: resolvedFamily,
    dietaryWatchlist: resolvedDietary,
    preferStoreBrand: resolvedPreferStoreBrand,
    creatorCode: localData.heybroc_creator_code || undefined,
    deviceId: (nativePrefs?.deviceId && String(nativePrefs.deviceId).length >= 8) ? nativePrefs.deviceId : deviceId,
    deviceSecret: (nativePrefs?.deviceSecret && String(nativePrefs.deviceSecret).length > 0) ? nativePrefs.deviceSecret : deviceSecret,
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
        const { apiBase, watchlist, familyWatchlist, dietaryWatchlist, preferStoreBrand, deviceId, deviceSecret } = await getSettings();
        const res = await fetch(`${apiBase}/api/scan`, {
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
            deviceSecret,
            surface: "extension",
            clientPlatform: "ios-safari",
            format: "json",
          }),
        });
        const data = await res.json();
        if (data?.issuedDeviceSecret) {
          await chrome.storage.local.set({ heybroc_device_secret: data.issuedDeviceSecret });
        }
        sendResponse(data);
      } catch (err) {
        sendResponse({ ok: false, error: `HeyBroc API unreachable: ${err?.message || err}` });
      }
    })();
    return true;
  }

  if (msg?.type === "CLEANCART_AUDIT") {
    (async () => {
      try {
        const { apiBase, watchlist, familyWatchlist, dietaryWatchlist, deviceId, deviceSecret } = await getSettings();
        const res = await fetch(`${apiBase}/api/audit`, {
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
            deviceId,
            deviceSecret,
            surface: "extension",
            clientPlatform: "ios-safari",
          }),
        });
        const data = await res.json();
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
        const { apiBase, deviceId, deviceSecret } = await getSettings();
        const res = await fetch(`${apiBase}/api/referral`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Device-Secret": deviceSecret,
          },
          body: JSON.stringify({
            action: "record_swap",
            deviceId,
            deviceSecret,
            productKey: msg.productKey,
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

  return false;
});
