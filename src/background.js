// Background service worker: the only place the AI API keys are used.
// Keys live in chrome.storage.local (this browser profile only, never in
// the repo); content scripts on Steam ask for explanations via messages and
// only ever get the resulting text back.
//
// Two providers:
//   claude – Anthropic Messages API, the user's own key (billed)
//   gemini – Google Gemini API, a free-tier AI Studio key
//
// Raw fetch rather than the providers' SDKs: this extension has no build
// step to bundle an SDK into a service worker.

const SYSTEM_PROMPT =
  "You explain why a Steam game has the number of user reviews it has. The reader " +
  "just guessed the review count in a guessing game and wants a quick, insightful " +
  "explanation. Write 2-3 sentences of plain prose: no lists, headings or preamble. " +
  "Name the one or two factors that most likely explain the count, compared with " +
  "what is typical on Steam. Work from the facts provided; you may add what you " +
  "reliably know about this game, its studio or its launch, but never invent " +
  "numbers. Sound appropriately tentative (\"likely\", \"probably\").";

const userPrompt = (facts) =>
  `Game facts (JSON):\n${JSON.stringify(facts)}\n\nWhy does it have ${facts.reviews} reviews?`;

const offline = (name) => ({ error: `Couldn't reach the ${name} API. Check your connection.` });

async function errorMessage(response) {
  try {
    const body = await response.json();
    return body?.error?.message || "";
  } catch (err) {
    return ""; // not JSON
  }
}

// ---------------------------------------------------------------------------
// Claude (Anthropic)
// ---------------------------------------------------------------------------

const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";

// Prices per million tokens (input / output), for the cost shown to the user
const CLAUDE_MODELS = {
  "claude-haiku-5-5": { label: "Claude Haiku 5.5", inPerM: 0.1, outPerM: 0.5, serverFallback: false },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5", inPerM: 2, outPerM: 10, serverFallback: true },
  "claude-opus-5-5": { label: "Claude Opus 5.5", inPerM: 4, outPerM: 20, serverFallback: true },
};
const CLAUDE_DEFAULT = "claude-haiku-5-5";

function claudeHeaders(apiKey, workspaceId, extra = {}) {
  const h = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    // Required for requests sent from a browser context
    "anthropic-dangerous-direct-browser-access": "true",
    ...extra,
  };
  // Keys that can act in several workspaces must name one per request
  if (workspaceId) h["anthropic-workspace-id"] = workspaceId;
  return h;
}

const WORKSPACE_HELP =
  "This key isn't tied to one workspace. Either create a key scoped to a single workspace " +
  "in the Claude Console, or paste your workspace ID (wrkspc_..., listed at " +
  "platform.claude.com/settings/workspaces) under AI settings.";

async function claudeError(response) {
  const message = await errorMessage(response);
  if (response.status === 401) return "Your Claude API key was rejected. Check it under AI settings.";
  if (/workspace/i.test(message)) {
    if (response.status === 400) return WORKSPACE_HELP;
    if (response.status === 404) return "That workspace ID wasn't found, or this key can't use it. Check it under AI settings.";
  }
  if (response.status === 429) return "Rate limited by the Claude API. Try again in a moment." + (message ? ` (${message})` : "");
  if (response.status === 529 || response.status >= 500) return "The Claude API is busy right now. Try again shortly.";
  return message || `Claude API error ${response.status}`;
}

async function claudeExplain(s, facts) {
  if (!s.claudeKey) return { error: "No Claude API key set. Add one under AI settings." };
  const info = CLAUDE_MODELS[s.claudeModel];

  const body = {
    model: s.claudeModel,
    max_tokens: 1500, // room for thinking plus a short answer
    output_config: { effort: "low" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt(facts) }],
  };
  const extra = {};
  if (info.serverFallback) {
    // Retry a safety decline on the model Anthropic recommends for it
    body.fallbacks = "default";
    extra["anthropic-beta"] = "server-side-fallback-2026-07-01";
  }

  let response;
  try {
    response = await fetch(CLAUDE_URL, {
      method: "POST",
      headers: claudeHeaders(s.claudeKey, s.workspaceId, extra),
      body: JSON.stringify(body),
    });
  } catch (err) {
    return offline("Claude");
  }
  if (!response.ok) return { error: await claudeError(response) };

  const data = await response.json();
  if (data.stop_reason === "refusal") return { error: "Claude declined to answer this one." };
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
  const usedModel = CLAUDE_MODELS[data.model] ? CLAUDE_MODELS[data.model].label : info.label;
  return { text, modelLabel: usedModel, costLabel: costUSD != null ? `≈ $${costUSD.toFixed(4)}` : null };
}

// Free check: counting tokens needs a valid key, a usable workspace and access
// to the model, like a real request, but runs no model and isn't billed
async function claudeTest({ apiKey, workspaceId, model }) {
  if (!apiKey) return { ok: false, message: "Enter a key first." };
  try {
    const response = await fetch(CLAUDE_COUNT_TOKENS_URL, {
      method: "POST",
      headers: claudeHeaders(apiKey, workspaceId),
      body: JSON.stringify({
        model: CLAUDE_MODELS[model] ? model : CLAUDE_DEFAULT,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    if (response.ok) return { ok: true, message: "Key works." };
    return { ok: false, message: await claudeError(response) };
  } catch (err) {
    return { ok: false, message: offline("Claude").error };
  }
}

// ---------------------------------------------------------------------------
// Gemini (Google), free tier
// ---------------------------------------------------------------------------

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Both have a free tier on the Gemini API (Google may use free-tier prompts
// to improve its products; these prompts are public Steam data only)
const GEMINI_MODELS = {
  "gemini-3.5-flash-lite": { label: "Gemini 3.5 Flash-Lite" },
  "gemini-3.8-flash": { label: "Gemini 3.8 Flash" },
};
const GEMINI_DEFAULT = "gemini-3.5-flash-lite";

// Key in a header rather than the URL, so it doesn't end up in logs
const geminiHeaders = (apiKey) => ({ "content-type": "application/json", "x-goog-api-key": apiKey });

async function geminiError(response) {
  const message = await errorMessage(response);
  if (/API key not valid|API_KEY_INVALID/i.test(message) || response.status === 401 || response.status === 403) {
    return "Your Gemini API key was rejected. Check it under AI settings.";
  }
  if (response.status === 429) {
    return "Gemini's free-tier limit for this model is used up for now. Try again later, or switch model under AI settings.";
  }
  if (response.status === 404) return "That Gemini model isn't available to this key. Pick another under AI settings.";
  if (response.status >= 500) return "The Gemini API is busy right now. Try again shortly.";
  return message || `Gemini API error ${response.status}`;
}

async function geminiExplain(s, facts) {
  if (!s.geminiKey) return { error: "No Gemini API key set. Add one under AI settings." };
  const info = GEMINI_MODELS[s.geminiModel];

  let response;
  try {
    response = await fetch(`${GEMINI_BASE}/${s.geminiModel}:generateContent`, {
      method: "POST",
      headers: geminiHeaders(s.geminiKey),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userPrompt(facts) }] }],
        generationConfig: { maxOutputTokens: 2048 }, // room for thinking plus a short answer
      }),
    });
  } catch (err) {
    return offline("Gemini");
  }
  if (!response.ok) return { error: await geminiError(response) };

  const data = await response.json();
  if (data.promptFeedback?.blockReason) return { error: "Gemini declined to answer this one." };
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("")
    .trim();
  if (!text) {
    if (candidate?.finishReason === "MAX_TOKENS") return { error: "Gemini ran out of room before answering. Try again." };
    if (candidate?.finishReason === "SAFETY") return { error: "Gemini declined to answer this one." };
    return { error: "Gemini returned no text." };
  }
  return { text, modelLabel: info.label, costLabel: "free tier" };
}

// Free check: reading the model's metadata needs a valid key, runs nothing
async function geminiTest({ apiKey, model }) {
  if (!apiKey) return { ok: false, message: "Enter a key first." };
  try {
    const response = await fetch(`${GEMINI_BASE}/${GEMINI_MODELS[model] ? model : GEMINI_DEFAULT}`, {
      headers: geminiHeaders(apiKey),
    });
    if (response.ok) return { ok: true, message: "Key works." };
    return { ok: false, message: await geminiError(response) };
  } catch (err) {
    return { ok: false, message: offline("Gemini").error };
  }
}

// ---------------------------------------------------------------------------
// Settings + messages
// ---------------------------------------------------------------------------

const PROVIDERS = {
  claude: { label: "Claude", explain: claudeExplain, test: claudeTest },
  gemini: { label: "Gemini", explain: geminiExplain, test: geminiTest },
};

async function getSettings() {
  const s = await chrome.storage.local.get([
    "aiProvider", "aiAutoExplain",
    "anthropicApiKey", "anthropicWorkspaceId", "claudeModel", "claudeAutoExplain",
    "geminiApiKey", "geminiModel",
  ]);
  // Not chosen yet: Claude if a Claude key is already saved, else free Gemini
  const provider = PROVIDERS[s.aiProvider] ? s.aiProvider : s.anthropicApiKey ? "claude" : "gemini";
  return {
    provider,
    autoExplain: !!(s.aiAutoExplain ?? s.claudeAutoExplain),
    claudeKey: s.anthropicApiKey || "",
    workspaceId: s.anthropicWorkspaceId || "",
    claudeModel: CLAUDE_MODELS[s.claudeModel] ? s.claudeModel : CLAUDE_DEFAULT,
    geminiKey: s.geminiApiKey || "",
    geminiModel: GEMINI_MODELS[s.geminiModel] ? s.geminiModel : GEMINI_DEFAULT,
  };
}

function status(s) {
  const claude = s.provider === "claude";
  return {
    provider: s.provider,
    providerLabel: PROVIDERS[s.provider].label,
    hasKey: !!(claude ? s.claudeKey : s.geminiKey),
    modelLabel: claude ? CLAUDE_MODELS[s.claudeModel].label : GEMINI_MODELS[s.geminiModel].label,
    autoExplain: s.autoExplain,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "ai-status":
        return status(await getSettings());
      case "ai-explain": {
        const s = await getSettings();
        return PROVIDERS[s.provider].explain(s, message.facts);
      }
      case "ai-test-key": {
        const p = PROVIDERS[message.provider];
        return p ? p.test(message) : { ok: false, message: "Unknown provider" };
      }
      case "open-options":
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      default:
        return { error: "Unknown request" };
    }
  })().then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true; // reply asynchronously
});
