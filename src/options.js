// Settings for the AI explanation: Gemini API key, model and auto-explain
// (src/background.js uses them). Runs on two extension pages:
//   options.html – the extension's full options page
//   setup.html   – the same form, framed inside the insight on Steam's page
// Both are extension pages, so Steam's scripts can't read what's typed here.
// When framed, only "saved" / "removed" / "close" / height go to the Steam
// page, never the key.

const $ = (id) => document.getElementById(id);
const keyInput = $("geminiKey");
const statusEl = $("status");
const embedded = window.top !== window;
const STEAM_ORIGIN = "https://store.steampowered.com";

function tellSteamPage(type, extra = {}) {
  if (embedded) window.parent.postMessage({ source: "jrg-ai-setup", type, ...extra }, STEAM_ORIGIN);
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || "";
}

function updateRemove() {
  if ($("remove")) $("remove").hidden = !keyInput.value.trim();
}

async function load() {
  const s = await chrome.storage.local.get(["geminiApiKey", "geminiModel", "aiAutoExplain"]);
  keyInput.value = s.geminiApiKey || "";
  if (s.geminiModel) $("geminiModel").value = s.geminiModel;
  $("autoExplain").checked = !!s.aiAutoExplain;
  updateRemove();
}

$("toggleKey").addEventListener("click", () => {
  const show = keyInput.type === "password";
  keyInput.type = show ? "text" : "password";
  $("toggleKey").textContent = show ? "Hide" : "Show";
});

$("save").addEventListener("click", async () => {
  const key = keyInput.value.trim();
  if (!key) {
    setStatus("Paste a key first.", "error");
    return;
  }
  await chrome.storage.local.set({
    geminiApiKey: key,
    geminiModel: $("geminiModel").value,
    aiAutoExplain: $("autoExplain").checked,
  });
  setStatus("Saved.", "ok");
  updateRemove();
  tellSteamPage("saved");
});

$("test").addEventListener("click", async () => {
  setStatus("Testing…");
  const reply = await chrome.runtime.sendMessage({
    type: "ai-test-key",
    apiKey: keyInput.value.trim(),
    model: $("geminiModel").value,
  });
  setStatus(reply.message, reply.ok ? "ok" : "error");
});

if ($("remove")) {
  $("remove").addEventListener("click", async () => {
    await chrome.storage.local.remove("geminiApiKey");
    keyInput.value = "";
    updateRemove();
    setStatus("Key removed.", "ok");
    tellSteamPage("removed");
  });
}

if ($("close")) $("close").addEventListener("click", () => tellSteamPage("close"));

// Let the framing insight size the frame to its content
if (embedded) {
  new ResizeObserver(() => tellSteamPage("height", { height: document.documentElement.scrollHeight })).observe(document.body);
}

load();
