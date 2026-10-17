// Background service worker: the only place the Anthropic API key is used.
// The key lives in chrome.storage.local (this browser profile only, never in
// the repo); content scripts on Steam ask for explanations via messages and
// only ever get the resulting text back.
//
// Raw fetch rather than the Anthropic SDK: this extension has no build step
// to bundle the SDK into a service worker.

const API_URL = "https://api.anthropic.com/v1/messages";
const MODELS_URL = "https://api.anthropic.com/v1/models";

// Prices per million tokens (input / output), for the cost shown to the user
const MODELS = {
  "claude-haiku-5-5": { label: "Claude Haiku 5.5", inPerM: 0.1, outPerM: 0.5, serverFallback: false },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5", inPerM: 2, outPerM: 10, serverFallback: true },
  "claude-opus-5-5": { label: "Claude Opus 5.5", inPerM: 4, outPerM: 20, serverFallback: true },
};
const DEFAULT_MODEL = "claude-haiku-5-5";

const SYSTEM_PROMPT =
  "You explain why a Steam game has the number of user reviews it has. The reader " +
  "just guessed the review count in a guessing game and wants a quick, insightful " +
  "explanation. Write 2-3 sentences of plain prose: no lists, headings or preamble. " +
  "Name the one or two factors that most likely explain the count, compared with " +
  "what is typical on Steam. Work from the facts provided; you may add what you " +
  "reliably know about this game, its studio or its launch, but never invent " +
  "numbers. Sound appropriately tentative (\"likely\", \"probably\").";

async function getSettings() {
  const s = await chrome.storage.local.get(["anthropicApiKey", "claudeModel", "claudeAutoExplain"]);
  const model = MODELS[s.claudeModel] ? s.claudeModel : DEFAULT_MODEL;
  return { apiKey: s.anthropicApiKey || "", model, autoExplain: !!s.claudeAutoExplain };
}

function headers(apiKey, extra = {}) {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    // Required for requests sent from a browser context
    "anthropic-dangerous-direct-browser-access": "true",
    ...extra,
  };
}

async function readError(response) {
  let message = "";
  try {
    const body = await response.json();
    message = body?.error?.message || "";
  } catch (err) {
    // not JSON
  }
  if (response.status === 401) return "Your API key was rejected. Check it in the extension's options.";
  if (response.status === 429) return "Rate limited by the Claude API. Try again in a moment." + (message ? ` (${message})` : "");
  if (response.status === 529 || response.status >= 500) return "The Claude API is busy right now. Try again shortly.";
  return message || `Claude API error ${response.status}`;
}

async function explain(facts) {
  const { apiKey, model } = await getSettings();
  if (!apiKey) return { error: "No API key set. Add one in the extension's options." };
  const info = MODELS[model];

  const body = {
    model,
    max_tokens: 1500, // room for thinking plus a short answer
    output_config: { effort: "low" },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Game facts (JSON):\n${JSON.stringify(facts)}\n\nWhy does it have ${facts.reviews} reviews?`,
      },
    ],
  };
  const extra = {};
  if (info.serverFallback) {
    // Retry a safety decline on the model Anthropic recommends for it
    body.fallbacks = "default";
    extra["anthropic-beta"] = "server-side-fallback-2026-07-01";
  }

  let response;
  try {
    response = await fetch(API_URL, { method: "POST", headers: headers(apiKey, extra), body: JSON.stringify(body) });
  } catch (err) {
    return { error: "Couldn't reach the Claude API. Check your connection." };
  }
  if (!response.ok) return { error: await readError(response) };

  const data = await response.json();
  if (data.stop_reason === "refusal") {
    return { error: "Claude declined to answer this one." };
  }
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) {
    return { error: data.stop_reason === "max_tokens" ? "Claude ran out of room before answering. Try again." : "Claude returned no text." };
  }

  const usage = data.usage || {};
  const costUSD =
    usage.input_tokens != null
      ? (usage.input_tokens * info.inPerM + (usage.output_tokens || 0) * info.outPerM) / 1e6
      : null;
  const usedModel = MODELS[data.model] ? MODELS[data.model].label : info.label;
  return { text, modelLabel: usedModel, costUSD };
}

// Free check: listing models needs a valid key but runs no model
async function testKey(apiKey) {
  if (!apiKey) return { ok: false, message: "Enter a key first." };
  try {
    const response = await fetch(MODELS_URL, { headers: headers(apiKey) });
    if (response.ok) return { ok: true, message: "Key works." };
    return { ok: false, message: await readError(response) };
  } catch (err) {
    return { ok: false, message: "Couldn't reach the Claude API. Check your connection." };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "claude-status": {
        const s = await getSettings();
        return { hasKey: !!s.apiKey, modelLabel: MODELS[s.model].label, autoExplain: s.autoExplain };
      }
      case "claude-explain":
        return explain(message.facts);
      case "claude-test-key":
        return testKey(message.apiKey);
      case "open-options":
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      default:
        return { error: "Unknown request" };
    }
  })().then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true; // reply asynchronously
});
