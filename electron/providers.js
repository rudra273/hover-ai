// Provider abstraction: each provider knows how to (1) list models and
// (2) stream a chat, normalizing its wire format into a common callback shape.
//
// streamChat(opts, handlers) where handlers = { onThinking, onToken } and it
// resolves when the stream ends (or throws on error). Aborting is done via the
// AbortSignal passed in opts.signal.
//
// API keys resolve from the stored key first, then the matching env var — so you
// can run env-var style (nothing written to disk) or paste a key in Settings.

const ENV_KEYS = {
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY'
};

function resolveKey(providerId, storedKeys) {
  const stored = (storedKeys && storedKeys[providerId]) || '';
  if (stored.trim()) return stored.trim();
  const env = process.env[ENV_KEYS[providerId]];
  return env ? env.trim() : '';
}

// Read an SSE / NDJSON stream line-by-line, calling onLine for each data chunk.
async function readLines(resp, onLine) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  }
  if (buf.trim()) onLine(buf.trim());
}

// ---- Local (Ollama) ---------------------------------------------------------
const local = {
  id: 'local',
  name: 'Local',
  needsKey: false,

  async listModels({ ollamaHost }) {
    const r = await fetch(`${ollamaHost}/api/tags`);
    const j = await r.json();
    return (j.models || []).map((m) => m.name);
  },

  async streamChat({ ollamaHost, model, messages, temperature, thinking, signal }, h) {
    const body = {
      model,
      messages,
      stream: true,
      options: { temperature }
    };
    // Send `think` EXPLICITLY (true OR false) — reasoning models default ON, so
    // omitting it won't disable reasoning. When `thinking` is undefined we omit
    // the param entirely (fallback for models that reject it).
    if (thinking !== undefined) body.think = !!thinking;
    const resp = await fetch(`${ollamaHost}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);
    await readLines(resp, (line) => {
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      if (obj.message) {
        if (obj.message.thinking) h.onThinking(obj.message.thinking);
        if (obj.message.content) h.onToken(obj.message.content);
      }
    });
  }
};

// ---- Gemini -----------------------------------------------------------------
const gemini = {
  id: 'gemini',
  name: 'Gemini',
  needsKey: true,

  async listModels({ apiKey }) {
    if (!apiKey) throw new Error('Gemini API key not set');
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
    const j = await r.json();
    return (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => /gemini/i.test(n));
  },

  async streamChat({ apiKey, model, messages, temperature, signal }, h) {
    if (!apiKey) throw new Error('Gemini API key not set');
    // Gemini takes a system instruction separately and uses role "model" for the assistant.
    const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));
    const body = {
      contents,
      generationConfig: { temperature }
    };
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent` +
      `?alt=sse&key=${apiKey}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
    if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${await resp.text()}`);
    await readLines(resp, (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let obj;
      try { obj = JSON.parse(data); } catch { return; }
      const parts = obj.candidates?.[0]?.content?.parts || [];
      for (const p of parts) if (p.text) h.onToken(p.text);
    });
  }
};

// ---- OpenRouter (OpenAI-compatible) -----------------------------------------
const openrouter = {
  id: 'openrouter',
  name: 'OpenRouter',
  needsKey: true,

  async listModels({ apiKey }) {
    // /models is public, but send the key if we have it.
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const r = await fetch('https://openrouter.ai/api/v1/models', { headers });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${await r.text()}`);
    const j = await r.json();
    return (j.data || []).map((m) => m.id).sort();
  },

  async streamChat({ apiKey, model, messages, temperature, thinking, signal }, h) {
    if (!apiKey) throw new Error('OpenRouter API key not set');

    const post = (reasoning) => {
      const payload = { model, messages, temperature, stream: true };
      if (reasoning) payload.reasoning = reasoning;
      return fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://orbit.local',
          'X-Title': 'Orbit'
        },
        body: JSON.stringify(payload),
        signal
      });
    };

    // Reasoning models think by default on OpenRouter. Honor Orbit's toggle:
    // false -> try to disable; true -> enable; undefined -> leave default.
    let reasoning = null;
    if (thinking === false) reasoning = { enabled: false, exclude: true };
    else if (thinking === true) reasoning = { enabled: true };

    let resp = await post(reasoning);
    if (!resp.ok) {
      const text = await resp.text();
      // Some models REQUIRE reasoning and reject {enabled:false}. Retry without
      // the reasoning field and tell the UI thinking is forced-on for this model.
      if (resp.status === 400 && /reasoning is mandatory/i.test(text)) {
        if (h.onForcedThinking) h.onForcedThinking();
        resp = await post(null);
        if (!resp.ok) throw new Error(`OpenRouter ${resp.status}: ${await resp.text()}`);
      } else {
        throw new Error(`OpenRouter ${resp.status}: ${text}`);
      }
    }
    await readLines(resp, (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let obj;
      try { obj = JSON.parse(data); } catch { return; }
      const delta = obj.choices?.[0]?.delta || {};
      if (delta.reasoning) h.onThinking(delta.reasoning);
      if (delta.content) h.onToken(delta.content);
    });
  }
};

const PROVIDERS = { local, gemini, openrouter };

module.exports = {
  PROVIDERS,
  resolveKey,
  ENV_KEYS,
  get(id) {
    return PROVIDERS[id] || PROVIDERS.local;
  },
  // metadata for the UI (no secrets)
  list() {
    return Object.values(PROVIDERS).map((p) => ({ id: p.id, name: p.name, needsKey: p.needsKey }));
  }
};
