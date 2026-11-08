const DEFAULT_API = "https://heybroc.com";
const input = document.getElementById("api");
const status = document.getElementById("status");

chrome.storage.sync.get("apiBase").then(({ apiBase }) => {
  input.value = apiBase || DEFAULT_API;
});

function validateApiBase(raw) {
  const candidate = (raw || "").trim().replace(/\/+$/, "") || DEFAULT_API;
  try {
    const u = new URL(candidate);
    const isLocalHttp =
      u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
    if (u.protocol !== "https:" && !isLocalHttp) {
      return { ok: false, error: "API URL must use https:// (or http://localhost for local dev)." };
    }
    return { ok: true, url: `${u.origin}${u.pathname.replace(/\/+$/, "")}` };
  } catch {
    return { ok: false, error: "Enter a valid URL (e.g. https://heybroc.com)." };
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const checked = validateApiBase(input.value);
  if (!checked.ok) {
    status.style.color = "#dc2626";
    status.textContent = checked.error;
    return;
  }
  const apiBase = checked.url;
  input.value = apiBase;
  await chrome.storage.sync.set({ apiBase });
  status.style.color = "";
  status.textContent = "Testing…";
  try {
    const res = await fetch(`${apiBase}/api/scan`);
    const data = await res.json();
    status.textContent = `✓ Connected — rubric v${data.rubricVersion}`;
  } catch {
    status.style.color = "#dc2626";
    status.textContent = "Saved, but the API didn't respond.";
  }
});
