// Background service worker: the only place the Gemini API key is used.
// The key lives in chrome.storage.local (this browser profile only, never in
// the repo); content scripts on Steam ask for explanations via messages and
// only ever get the resulting text back.
//
// Raw fetch rather than Google's SDK: this extension has no build step to
// bundle an SDK into a service worker.

const SYSTEM_PROMPT =
  "A player just guessed this Steam game's review count. In 3-4 sentences of plain " +
  "text (no Markdown), explain: what drove its reach (studio, price, timing, genre, " +
  "audience), what players praise and complain about (quote or paraphrase " +
  "sampleReviews), and whether it seems well made. Be specific and opinionated, " +
  "never generic; never invent numbers.";

const userPrompt = (facts) =>
  `Facts (JSON):\n${JSON.stringify(facts)}\n\nWhy ${facts.reviews} reviews, and what do players think?`;

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Both have a free tier on the Gemini API (Google may use free-tier prompts
// to improve its products; these prompts are public Steam data only)
const GEMINI_MODELS = {
  "gemini-3.5-flash-lite": { label: "Gemini 3.5 Flash-Lite" },
  "gemini-3.8-flash": { label: "Gemini 3.8 Flash" },
};
const GEMINI_DEFAULT = "gemini-3.5-flash-lite";

// Settings left over from the removed Claude option (v1.5-1.7): don't keep
// an unused API key lying around in storage
const LEGACY_KEYS = ["anthropicApiKey", "anthropicWorkspaceId", "claudeModel", "claudeAutoExplain", "aiProvider"];
chrome.runtime.onInstalled.addListener(() => chrome.storage.local.remove(LEGACY_KEYS));

// Key in a header rather than the URL, so it doesn't end up in logs
const geminiHeaders = (apiKey) => ({ "content-type": "application/json", "x-goog-api-key": apiKey });

const OFFLINE = "Couldn't reach the Gemini API. Check your connection.";

async function geminiError(response) {
  let message = "";
  try {
    message = (await response.json())?.error?.message || "";
  } catch (err) {
    // not JSON
  }
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

async function getSettings() {
  const s = await chrome.storage.local.get(["geminiApiKey", "geminiModel", "aiAutoExplain"]);
  return {
    apiKey: s.geminiApiKey || "",
    model: GEMINI_MODELS[s.geminiModel] ? s.geminiModel : GEMINI_DEFAULT,
    autoExplain: !!s.aiAutoExplain,
  };
}

async function explain(facts) {
  const s = await getSettings();
  if (!s.apiKey) return { error: "No Gemini API key set. Add one under AI settings." };

  let response;
  try {
    response = await fetch(`${GEMINI_BASE}/${s.model}:generateContent`, {
      method: "POST",
      headers: geminiHeaders(s.apiKey),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userPrompt(facts) }] }],
        generationConfig: { maxOutputTokens: 2048 }, // room for thinking plus a short answer
      }),
    });
  } catch (err) {
    return { error: OFFLINE };
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
  return { text, modelLabel: GEMINI_MODELS[s.model].label, costLabel: "free tier" };
}

// Free check: reading the model's metadata needs a valid key, runs nothing
async function testKey({ apiKey, model }) {
  if (!apiKey) return { ok: false, message: "Enter a key first." };
  try {
    const response = await fetch(`${GEMINI_BASE}/${GEMINI_MODELS[model] ? model : GEMINI_DEFAULT}`, {
      headers: geminiHeaders(apiKey),
    });
    if (response.ok) return { ok: true, message: "Key works." };
    return { ok: false, message: await geminiError(response) };
  } catch (err) {
    return { ok: false, message: OFFLINE };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "ai-status": {
        const s = await getSettings();
        return { hasKey: !!s.apiKey, providerLabel: "Gemini", modelLabel: GEMINI_MODELS[s.model].label, autoExplain: s.autoExplain };
      }
      case "ai-explain":
        return explain(message.facts);
      case "ai-test-key":
        return testKey(message);
      case "open-options":
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      default:
        return { error: "Unknown request" };
    }
  })().then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true; // reply asynchronously
});
