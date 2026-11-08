const DEFAULT_API = "https://www.heybroc.com";
const input = document.getElementById("api");
const status = document.getElementById("status");

chrome.storage.sync.get("apiBase").then(({ apiBase }) => {
  input.value = apiBase || DEFAULT_API;
});

document.getElementById("save").addEventListener("click", async () => {
  const apiBase = input.value.trim().replace(/\/+$/, "") || DEFAULT_API;
  await chrome.storage.sync.set({ apiBase });
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
