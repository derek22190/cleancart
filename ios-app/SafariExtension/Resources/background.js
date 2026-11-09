// CleanCart background service worker.
// Content scripts can't reliably call our API from store pages (page CORS + mixed content),
// so they message this worker, which has host_permissions to reach the API.

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

async function getSettings() {
  const [syncData, localData, { deviceId, deviceSecret }] = await Promise.all([
    chrome.storage.sync.get(["apiBase", "watchlist", "familyWatchlist", "dietaryWatchlist"]),
    chrome.storage.local.get(["watchlist", "familyWatchlist", "dietaryWatchlist"]),
    getOrCreateDeviceCredentials(),
  ]);
  const rawBase = (syncData.apiBase || DEFAULT_API).replace(/\/+$/, "");
  const normalizedBase = rawBase === "https://heybroc.com" ? "https://www.heybroc.com" : rawBase;
  return {
    apiBase: normalizedBase,
    watchlist: syncData.watchlist || localData.watchlist || undefined,
    familyWatchlist: syncData.familyWatchlist || localData.familyWatchlist || undefined,
    dietaryWatchlist: syncData.dietaryWatchlist || localData.dietaryWatchlist || undefined,
    deviceId,
    deviceSecret,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "CLEANCART_SCAN") {
    (async () => {
      try {
        const { apiBase, watchlist, familyWatchlist, dietaryWatchlist, deviceId, deviceSecret } = await getSettings();
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
            deviceId,
            deviceSecret,
            surface: "extension",
            format: "json",
          }),
        });
        const data = await res.json();
        sendResponse(data);
      } catch (err) {
        sendResponse({ ok: false, error: `CleanCart API unreachable: ${err?.message || err}` });
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

  return false;
});
