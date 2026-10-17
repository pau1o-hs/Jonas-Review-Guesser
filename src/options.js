// Options page: Anthropic API key, model and auto-explain (src/background.js uses them)

const $ = (id) => document.getElementById(id);
const keyInput = $("apiKey");
const statusEl = $("status");

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || "";
}

async function load() {
  const s = await chrome.storage.local.get(["anthropicApiKey", "claudeModel", "claudeAutoExplain"]);
  keyInput.value = s.anthropicApiKey || "";
  if (s.claudeModel) $("model").value = s.claudeModel;
  $("autoExplain").checked = !!s.claudeAutoExplain;
}

$("toggleKey").addEventListener("click", () => {
  const show = keyInput.type === "password";
  keyInput.type = show ? "text" : "password";
  $("toggleKey").textContent = show ? "Hide" : "Show";
});

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    anthropicApiKey: keyInput.value.trim(),
    claudeModel: $("model").value,
    claudeAutoExplain: $("autoExplain").checked,
  });
  setStatus("Saved.", "ok");
});

$("test").addEventListener("click", async () => {
  setStatus("Testing…");
  const reply = await chrome.runtime.sendMessage({ type: "claude-test-key", apiKey: keyInput.value.trim() });
  setStatus(reply.message, reply.ok ? "ok" : "error");
});

$("remove").addEventListener("click", async () => {
  await chrome.storage.local.remove("anthropicApiKey");
  keyInput.value = "";
  setStatus("Key removed.", "ok");
});

load();
