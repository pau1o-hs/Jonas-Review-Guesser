// Settings for "Explain with Claude": API key, model and auto-explain
// (src/background.js uses them). Runs on two extension pages:
//   options.html – the extension's full options page
//   setup.html   – the same form, framed inside the insight on Steam's page
// Both are extension pages, so Steam's scripts can't read what's typed here.
// When framed, only "saved" / "removed" / "close" / height go to the Steam
// page, never the key.

const $ = (id) => document.getElementById(id);
const keyInput = $("apiKey");
const statusEl = $("status");
const embedded = window.top !== window;
const STEAM_ORIGIN = "https://store.steampowered.com";

function tellSteamPage(type, extra = {}) {
  if (embedded) window.parent.postMessage({ source: "jrg-claude-setup", type, ...extra }, STEAM_ORIGIN);
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || "";
}

async function load() {
  const s = await chrome.storage.local.get(["anthropicApiKey", "claudeModel", "claudeAutoExplain"]);
  keyInput.value = s.anthropicApiKey || "";
  if (s.claudeModel) $("model").value = s.claudeModel;
  $("autoExplain").checked = !!s.claudeAutoExplain;
  if ($("remove")) $("remove").hidden = !s.anthropicApiKey;
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
    anthropicApiKey: key,
    claudeModel: $("model").value,
    claudeAutoExplain: $("autoExplain").checked,
  });
  setStatus("Saved.", "ok");
  if ($("remove")) $("remove").hidden = false;
  tellSteamPage("saved");
});

$("test").addEventListener("click", async () => {
  setStatus("Testing…");
  const reply = await chrome.runtime.sendMessage({ type: "claude-test-key", apiKey: keyInput.value.trim() });
  setStatus(reply.message, reply.ok ? "ok" : "error");
});

if ($("remove")) {
  $("remove").addEventListener("click", async () => {
    await chrome.storage.local.remove("anthropicApiKey");
    keyInput.value = "";
    $("remove").hidden = true;
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
