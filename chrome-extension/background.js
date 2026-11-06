// CleanCart background service worker.
// Content scripts can't reliably call our API from store pages (page CORS + mixed content),
// so they message this worker, which has host_permissions to reach the API.

const DEFAULT_API = "https://heybroc.com";

async function getSettings() {
  const { apiBase, watchlist } = await chrome.storage.sync.get(["apiBase", "watchlist"]);
  return { apiBase: (apiBase || DEFAULT_API).replace(/\/+$/, ""), watchlist: watchlist || undefined };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "CLEANCART_SCAN") return false;
  (async () => {
    try {
      const { apiBase, watchlist } = await getSettings();
      const res = await fetch(`${apiBase}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...msg.payload, watchlist, format: "json" }),
      });
      const data = await res.json();
      sendResponse(data);
    } catch (err) {
      sendResponse({ ok: false, error: `CleanCart API unreachable: ${err?.message || err}` });
    }
  })();
  return true; // keep the message channel open for the async response
});
