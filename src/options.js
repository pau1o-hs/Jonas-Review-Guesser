// Settings for the AI explanations: provider (Claude or Gemini), each one's
// key and model, and auto-explain (src/background.js uses them). Runs on two
// extension pages:
//   options.html – the extension's full options page
//   setup.html   – the same form, framed inside the insight on Steam's page
// Both are extension pages, so Steam's scripts can't read what's typed here.
// When framed, only "saved" / "removed" / "close" / height go to the Steam
// page, never a key.

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const embedded = window.top !== window;
const STEAM_ORIGIN = "https://store.steampowered.com";

const FIELDS = {
  claude: { key: $("apiKey"), keyStorage: "anthropicApiKey" },
  gemini: { key: $("geminiKey"), keyStorage: "geminiApiKey" },
};

function tellSteamPage(type, extra = {}) {
  if (embedded) window.parent.postMessage({ source: "jrg-claude-setup", type, ...extra }, STEAM_ORIGIN);
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || "";
}

const provider = () => $("provider").value;

function showProvider() {
  for (const name of Object.keys(FIELDS)) $(`${name}Fields`).hidden = name !== provider();
  setStatus("");
  updateRemove();
}

function updateRemove() {
  if ($("remove")) $("remove").hidden = !FIELDS[provider()].key.value.trim();
}

async function load() {
  const s = await chrome.storage.local.get([
    "aiProvider", "aiAutoExplain", "claudeAutoExplain",
    "anthropicApiKey", "anthropicWorkspaceId", "claudeModel",
    "geminiApiKey", "geminiModel",
  ]);
  $("provider").value = s.aiProvider || (s.anthropicApiKey ? "claude" : "gemini");
  $("apiKey").value = s.anthropicApiKey || "";
  $("workspaceId").value = s.anthropicWorkspaceId || "";
  if (s.claudeModel) $("model").value = s.claudeModel;
  $("geminiKey").value = s.geminiApiKey || "";
  if (s.geminiModel) $("geminiModel").value = s.geminiModel;
  $("autoExplain").checked = !!(s.aiAutoExplain ?? s.claudeAutoExplain);
  showProvider();
}

$("provider").addEventListener("change", showProvider);

document.querySelectorAll("[data-toggle]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = $(btn.dataset.toggle);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.textContent = show ? "Hide" : "Show";
  });
});

$("save").addEventListener("click", async () => {
  const p = provider();
  const key = FIELDS[p].key.value.trim();
  const workspaceId = $("workspaceId").value.trim();
  if (!key) {
    setStatus("Paste a key first.", "error");
    return;
  }
  if (p === "claude" && workspaceId && !/^wrkspc_\w+$/.test(workspaceId)) {
    setStatus("A workspace ID starts with wrkspc_", "error");
    return;
  }
  await chrome.storage.local.set({
    aiProvider: p,
    aiAutoExplain: $("autoExplain").checked,
    anthropicApiKey: $("apiKey").value.trim(),
    anthropicWorkspaceId: workspaceId,
    claudeModel: $("model").value,
    geminiApiKey: $("geminiKey").value.trim(),
    geminiModel: $("geminiModel").value,
  });
  setStatus("Saved.", "ok");
  updateRemove();
  tellSteamPage("saved");
});

$("test").addEventListener("click", async () => {
  setStatus("Testing…");
  const p = provider();
  const reply = await chrome.runtime.sendMessage({
    type: "ai-test-key",
    provider: p,
    apiKey: FIELDS[p].key.value.trim(),
    workspaceId: $("workspaceId").value.trim(),
    model: p === "claude" ? $("model").value : $("geminiModel").value,
  });
  setStatus(reply.message, reply.ok ? "ok" : "error");
});

if ($("remove")) {
  $("remove").addEventListener("click", async () => {
    const f = FIELDS[provider()];
    await chrome.storage.local.remove(f.keyStorage);
    f.key.value = "";
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
