// Tiny JSON-file settings store (no external deps, CJS-safe).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  // model / chat
  ollamaHost: 'http://127.0.0.1:11434',
  model: 'gemma4:12b-mlx',
  thinking: false,
  temperature: 0.7,
  systemPrompt:
    'You are Orbit, a concise, helpful local AI copilot. Answer directly and briefly unless asked for detail.',

  // providers — where chat/model requests go. 'local' is Ollama (the default).
  provider: 'local', // 'local' | 'gemini' | 'openrouter'
  // last-chosen model per provider, so switching back restores it
  providerModels: { local: 'gemma4:12b-mlx', gemini: 'gemini-3.5-flash', openrouter: 'openai/gpt-oss-120b' },
  // API keys (fall back to env vars GEMINI_API_KEY / OPENROUTER_API_KEY if blank).
  // These live in userData's orbit-settings.json, never in the repo.
  apiKeys: { gemini: '', openrouter: '' },

  // Curated model lists per cloud provider. Only these appear in the model
  // dropdown (Ollama is excluded — it lists whatever is installed). Each entry:
  // { id, in, out } where in/out are USD per 1M tokens (null = unknown/free).
  // Prices verified via web search, June 2026 — edit/add freely in Settings.
  curatedModels: {
    gemini: [
      { id: 'gemini-3.5-flash', in: 1.5, out: 9.0 },
      { id: 'gemini-3.1-flash-lite', in: 0.25, out: 1.5 },
      { id: 'gemini-2.5-flash-lite', in: 0.1, out: 0.4 }
    ],
    openrouter: [
      { id: 'openai/gpt-oss-120b', in: 0.03, out: 0.15 },
      { id: 'deepseek/deepseek-v4-flash', in: 0.09, out: 0.18 },
      { id: 'google/gemini-3.5-flash', in: 1.5, out: 9.0 }
    ]
  },

  // skills — selectable "modes" layered on top of the base systemPrompt.
  // activeSkill is the id of the chosen skill ('' = None / general).
  activeSkill: '',
  skills: [
    {
      id: 'coding',
      name: 'Coding',
      prompt:
        'Act as an expert pair-programmer. Be precise and code-first: lead with the solution, ' +
        'use fenced code blocks with the right language, and keep prose tight. Point out edge cases, ' +
        'bugs, and tradeoffs briefly. Prefer idiomatic, production-quality code over toy snippets.'
    },
    {
      id: 'interview',
      name: 'Interview',
      prompt:
        'Act as a rigorous but encouraging interview coach. Ask one focused question at a time, wait ' +
        'for the answer, then evaluate it: what was strong, what was missing, and a tighter model answer. ' +
        'Adapt difficulty to the role the user names. Keep feedback specific and actionable.'
    },
    {
      id: 'research',
      name: 'Research',
      prompt:
        'Act as an analytical research assistant. Structure answers clearly: lead with a short summary, ' +
        'then key points, pros/cons, or steps as appropriate. Distinguish facts from inference, note ' +
        'uncertainty, and avoid filler. Use headings and bullets when they aid scanning.'
    },
    {
      id: 'writing',
      name: 'Writing',
      prompt:
        'Act as a sharp writing editor. When asked to write, produce clean, natural prose in the ' +
        "requested tone. When asked to edit, tighten and clarify without changing the author's voice, " +
        'and briefly note what you changed and why. Cut clichés and hedging.'
    }
  ],

  // window / overlay
  opacity: 0.96,
  theme: 'glass', // 'glass' | 'dark'
  stealth: false, // hide from screen-share / recording
  clickThrough: false,
  bounds: { width: 440, height: 560, x: null, y: null },

  // hotkeys (Electron accelerator strings)
  hotkeys: {
    toggle: 'CommandOrControl+Shift+Space',
    focus: 'CommandOrControl+Shift+K',
    clear: 'CommandOrControl+Shift+Backspace'
  },

  // audio
  audioSource: 'system', // 'system' | 'mic' | 'both'
  whisperModel: 'base',
  autoShowOnSpeech: true
};

let cachePath = null;
let data = null;

function file() {
  if (!cachePath) cachePath = path.join(app.getPath('userData'), 'orbit-settings.json');
  return cachePath;
}

function load() {
  if (data) return data;
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    data = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    data = { ...DEFAULTS };
  }
  return data;
}

function save() {
  try {
    fs.writeFileSync(file(), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('settings save failed', e);
  }
}

// ---- Chats: a separate JSON file so chat I/O never rewrites settings ----
let chatsCache = null;
function chatsFile() {
  return path.join(app.getPath('userData'), 'orbit-chats.json');
}
function loadChats() {
  if (chatsCache) return chatsCache;
  try {
    chatsCache = JSON.parse(fs.readFileSync(chatsFile(), 'utf8'));
    if (!Array.isArray(chatsCache)) chatsCache = [];
  } catch {
    chatsCache = [];
  }
  return chatsCache;
}
function saveChats() {
  try {
    fs.writeFileSync(chatsFile(), JSON.stringify(chatsCache, null, 2));
  } catch (e) {
    console.error('chats save failed', e);
  }
}

module.exports = {
  DEFAULTS,
  getAll() {
    return { ...load() };
  },
  get(key) {
    return load()[key];
  },
  set(patch) {
    load();
    data = { ...data, ...patch };
    save();
    return { ...data };
  },

  // chats — newest first; each: { id, title, messages, createdAt, updatedAt }
  listChats() {
    return loadChats()
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: (c.messages || []).length }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },
  getChat(id) {
    return loadChats().find((c) => c.id === id) || null;
  },
  saveChat(chat) {
    loadChats();
    const i = chatsCache.findIndex((c) => c.id === chat.id);
    if (i >= 0) chatsCache[i] = chat;
    else chatsCache.push(chat);
    saveChats();
    return chat;
  },
  deleteChat(id) {
    loadChats();
    chatsCache = chatsCache.filter((c) => c.id !== id);
    saveChats();
    return true;
  }
};
