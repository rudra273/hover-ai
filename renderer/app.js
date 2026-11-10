const api = window.orbit;

// ---- State ------------------------------------------------------------------
let settings = {};
let history = []; // [{role, content}]
let streaming = false;
let cur = null; // { contentEl, thinkEl, thinkBody, content, thinking }
let currentChatId = null; // id of the chat being viewed (null = fresh, unsaved)

const $ = (id) => document.getElementById(id);
const els = {
  messages: $('messages'),
  input: $('input'),
  send: $('sendBtn'),
  stop: $('stopBtn'),
  model: $('modelSelect'),
  skill: $('skillSelect'),
  think: $('thinkBtn'),
  mic: $('micBtn'),
  listen: $('listenBtn'),
  listenPanel: $('listenPanel'),
  lpBody: $('lpBody'),
  lpStatus: $('lpStatus'),
  lpAdd: $('lpAdd'),
  lpClear: $('lpClear'),
  settingsBtn: $('settingsBtn'),
  restartBtn: $('restartBtn'),
  settings: $('settings'),
  settingsClose: $('settingsClose'),
  toast: $('toast'),
  tlClose: $('tlClose'),
  tlMin: $('tlMin'),
  tlZoom: $('tlZoom'),
  sidebarBtn: $('sidebarBtn'),
  sidebar: $('sidebar'),
  sidebarScrim: $('sidebarScrim'),
  newChatBtn: $('newChatBtn'),
  chatList: $('chatList')
};

// small helper: build an <svg><use href="#id"/></svg> string
function icon(id, cls) {
  return `<svg class="${cls || ''}" viewBox="0 0 24 24"><use href="#${id}"/></svg>`;
}
// Animated orbit mark: gradient planet + inclined orbit with a comet-trail
// satellite. Mirrors the titlebar brand mark in index.html (same .orbit-mark
// CSS rules); the #lg-core / #lg-trail gradients live in the sprite <defs>.
function orbitLogo(cls) {
  return `<svg class="orbit-mark ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true">
    <g class="mark-tilt"><g class="mark-plane">
      <circle class="mark-path" cx="12" cy="12" r="9.4"/>
      <g class="mark-spin">
        <path class="mark-trail" d="M12 2.6 A9.4 9.4 0 0 1 21.4 12"/>
        <circle class="mark-sat" cx="21.4" cy="12" r="1.8"/>
      </g>
    </g></g>
    <circle class="mark-core" cx="12" cy="12" r="3.1" fill="url(#lg-core)"/>
    <circle class="mark-glint" cx="10.9" cy="10.8" r="0.85"/>
  </svg>`;
}

// ---- Markdown ---------------------------------------------------------------
// Compact, dependency-free markdown → HTML for assistant messages.
// Escapes HTML first (content is local/self-authored, but we stay safe), then
// applies a practical subset: fenced + inline code, bold/italic, headings,
// lists, blockquotes, links, and paragraph/line breaks. Tolerates an unclosed
// ``` fence mid-stream so streaming text doesn't flicker.
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function unescapeHtml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Lightweight, language-agnostic syntax highlighting. Input is already
// HTML-escaped. We tokenize comments, strings, numbers, and common keywords
// with placeholder sentinels so later passes don't double-wrap, then restore.
const CODE_KEYWORDS = new RegExp(
  '\\b(' +
  ['const','let','var','function','return','if','else','for','while','do','switch','case','break',
   'continue','class','extends','new','import','from','export','default','async','await','try','catch',
   'finally','throw','typeof','instanceof','in','of','this','super','yield','static','get','set',
   'def','elif','lambda','None','True','False','and','or','not','pass','with','as','print',
   'public','private','protected','void','int','float','double','string','bool','struct','enum',
   'fn','pub','use','mut','impl','match','where','null','undefined','true','false'
  ].join('|') +
  ')\\b', 'g'
);

function highlightCode(escaped, lang) {
  const store = [];
  // sentinel-wrap each token so later passes don't double-process it
  const stash = (cls, text) => {
    store.push('<span class="tok-' + cls + '">' + text + '</span>');
    return 'HLTOK' + (store.length - 1) + 'HLTOK';
  };
  let s = escaped;
  // comments: /* block */, // line, # line
  s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => stash('comment', m));
  s = s.replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + stash('comment', m.slice(p.length)));
  s = s.replace(/#[^\n]*/g, (m) => stash('comment', m));
  // strings: ' " ` (allowing escaped chars inside)
  s = s.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (m) => stash('str', m));
  // numbers
  s = s.replace(/\b\d+(?:\.\d+)?\b/g, (m) => stash('num', m));
  // keywords
  s = s.replace(CODE_KEYWORDS, (m) => stash('kw', m));
  // restore (match ONLY sentinel-wrapped indices)
  s = s.replace(/HLTOK(\d+)HLTOK/g, (_, i) => store[+i]);
  return s;
}

function inlineMd(s) {
  // inline code first, so its contents aren't touched by other rules
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return '@@CODE' + (codes.length - 1) + '@@';
  });
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  // bold then italic (bold uses ** or __, italic uses single * or _)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  // restore inline code
  s = s.replace(/@@CODE(\d+)@@/g, (_, i) => '<code>' + codes[+i] + '</code>');
  return s;
}

function renderMarkdown(src) {
  const text = escapeHtml(src || '');
  const lines = text.split('\n');
  let html = '';
  let i = 0;
  let listType = null; // 'ul' | 'ol' | null

  const closeList = () => { if (listType) { html += '</' + listType + '>'; listType = null; } };

  while (i < lines.length) {
    let line = lines[i];

    // fenced code block ``` (optional language)
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      closeList();
      const lang = fence[1];
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // skip closing fence (if missing, we just consumed to EOF — fine mid-stream)
      const code = buf.join('\n'); // already HTML-escaped by escapeHtml()
      const raw = encodeURIComponent(unescapeHtml(code)); // for the copy button
      html +=
        '<div class="codeblock">' +
        '<div class="cb-head"><span class="cb-lang">' + (lang || 'code') + '</span>' +
        '<button class="cb-copy" data-code="' + raw + '" title="Copy code">' +
        '<svg viewBox="0 0 24 24"><use href="#i-copy"/></svg></button></div>' +
        '<pre><code' + (lang ? ' class="lang-' + lang + '"' : '') + '>' +
        highlightCode(code, lang) + '</code></pre>' +
        '</div>';
      continue;
    }

    // heading #..######
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = h[1].length;
      html += '<h' + lvl + ' class="md-h">' + inlineMd(h[2]) + '</h' + lvl + '>';
      i++;
      continue;
    }

    // blockquote (escapeHtml has already turned a leading ">" into "&gt;")
    if (/^\s*&gt;\s?/.test(line)) {
      closeList();
      html += '<blockquote>' + inlineMd(line.replace(/^\s*&gt;\s?/, '')) + '</blockquote>';
      i++;
      continue;
    }

    // unordered list item
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
      html += '<li>' + inlineMd(ul[1]) + '</li>';
      i++;
      continue;
    }
    // ordered list item
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
      html += '<li>' + inlineMd(ol[1]) + '</li>';
      i++;
      continue;
    }

    // blank line → paragraph break
    if (/^\s*$/.test(line)) {
      closeList();
      i++;
      continue;
    }

    // plain paragraph — gather consecutive non-special lines
    closeList();
    const para = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*#{1,6}\s/.test(lines[i]) &&
      !/^\s*[-*+]\s/.test(lines[i]) &&
      !/^\s*\d+\.\s/.test(lines[i]) &&
      !/^\s*&gt;\s?/.test(lines[i])
    ) { para.push(lines[i]); i++; }
    html += '<p>' + inlineMd(para.join('<br/>')) + '</p>';
  }
  closeList();
  return html;
}

// ---- Boot -------------------------------------------------------------------
(async function init() {
  settings = await api.getSettings();
  applyTheme();
  setupDropdowns();
  updateThinkBtn();
  await refreshProviders();
  await refreshModels();
  refreshSkills();
  bindUI();
  bindStream();
  renderEmpty();
  autoGrow();
})();

// models that require reasoning (can't be turned off) — keyed by "provider::model"
const forcedThinkingModels = new Set();

function updateThinkBtn() {
  const key = encodeModel(settings.provider || 'local', settings.model);
  const forced = forcedThinkingModels.has(key);
  const on = forced || !!settings.thinking;
  els.think.classList.toggle('active', on);
  els.think.classList.toggle('forced', forced);
  els.think.title = forced
    ? 'This model always thinks (reasoning required)'
    : on ? 'Thinking mode: ON' : 'Thinking mode: OFF';
}

function applyTheme() {
  // toggle (don't assign className) so unrelated body classes like `compact` survive
  document.body.classList.toggle('theme-dark', settings.theme === 'dark');
  document.body.classList.toggle('theme-glass', settings.theme !== 'dark');
  // stealth also neutralizes cursor/caret changes (see styles.css)
  document.body.classList.toggle('stealth', !!settings.stealth);
  document.body.style.opacity = settings.opacity ?? 1;
  // stealth off → give back the tooltips stashed by the hover interceptor below
  if (!settings.stealth) {
    for (const el of document.querySelectorAll('[data-stealth-title]')) {
      if (!el.title) el.title = el.dataset.stealthTitle;
      delete el.dataset.stealthTitle;
    }
  }
}

// Native title-attribute tooltips are OS-drawn popups, so setContentProtection
// can't hide them from screen capture. While stealth is on, stash the title
// right before the tooltip would appear; applyTheme() restores stashed titles
// when stealth turns off. Hover-time stripping (vs a one-shot sweep) also
// catches titles that code re-sets dynamically, e.g. the thinking button.
document.addEventListener('mouseover', (e) => {
  if (!settings || !settings.stealth) return;
  const t = e.target.closest && e.target.closest('[title]');
  if (t && t.title) {
    t.dataset.stealthTitle = t.title;
    t.removeAttribute('title');
  }
}, true);

// ---- Stealth-safe dropdowns ---------------------------------------------------
// Native <select> popups are drawn by macOS as separate OS windows, so
// setContentProtection can't hide them from screen capture — they'd leak in
// stealth mode. Each <select> stays in the DOM (hidden) as the source of truth;
// a button + in-DOM menu renders in its place. Existing code keeps reading and
// writing sel.value / sel.onchange unchanged.
const dropdowns = [];
let openDropdown = null;

function setupDropdowns() {
  for (const id of ['skillSelect', 'modelSelect', 'setModel', 'setTheme', 'setAudioSource', 'setWhisper']) {
    const sel = $(id);
    if (sel) dropdowns.push(makeDropdown(sel));
  }
  document.addEventListener('mousedown', (e) => {
    if (openDropdown && !openDropdown.menu.contains(e.target) && !openDropdown.btn.contains(e.target)) {
      closeDropdown();
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDropdown(); });
  document.addEventListener('scroll', closeDropdown, true);
  window.addEventListener('resize', closeDropdown);
}

function makeDropdown(sel) {
  sel.classList.add('dd-native');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dd-btn dd-' + sel.id;
  if (sel.title) btn.title = sel.title;
  const lab = document.createElement('span');
  lab.className = 'dd-label';
  btn.appendChild(lab);
  sel.after(btn);

  const dd = { sel, btn, lab, menu: null };
  btn.onclick = () => {
    if (openDropdown === dd) closeDropdown();
    else { closeDropdown(); openDropdownMenu(dd); }
  };
  return dd;
}

function closeDropdown() {
  if (!openDropdown) return;
  openDropdown.menu.remove();
  openDropdown.menu = null;
  openDropdown.btn.classList.remove('open');
  openDropdown = null;
}

// Build the menu fresh from the select's current options/optgroups each open,
// so dynamically refilled lists (models, skills) are always current.
function openDropdownMenu(dd) {
  const menu = document.createElement('div');
  menu.className = 'dd-menu';
  const addItem = (o) => {
    const it = document.createElement('div');
    it.className = 'dd-item' + (o.value === dd.sel.value ? ' selected' : '');
    it.textContent = o.dataset.full || o.textContent;
    it.onclick = () => {
      const changed = dd.sel.value !== o.value;
      dd.sel.value = o.value;
      closeDropdown();
      if (changed) dd.sel.dispatchEvent(new Event('change'));
      syncDropdowns();
    };
    menu.appendChild(it);
  };
  for (const child of dd.sel.children) {
    if (child.tagName === 'OPTGROUP') {
      const h = document.createElement('div');
      h.className = 'dd-group';
      h.textContent = child.label;
      menu.appendChild(h);
      for (const o of child.children) addItem(o);
    } else {
      addItem(child);
    }
  }
  document.body.appendChild(menu);
  positionMenu(menu, dd.btn.getBoundingClientRect());
  dd.menu = menu;
  dd.btn.classList.add('open');
  openDropdown = dd;
}

// Place an already-appended fixed-position menu next to the control rect `r`,
// clamped inside the window; opens upward when there's no room below.
function positionMenu(menu, r) {
  menu.style.minWidth = r.width + 'px';
  const below = window.innerHeight - r.bottom - 12;
  const above = r.top - 12;
  if (below < 140 && above > below) {
    menu.style.maxHeight = above + 'px';
    menu.style.top = Math.max(8, r.top - 4 - menu.offsetHeight) + 'px';
  } else {
    menu.style.maxHeight = Math.max(80, below) + 'px';
    menu.style.top = (r.bottom + 4) + 'px';
  }
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
}

// In-DOM replacement for <datalist> autocomplete: its suggestion popup is an
// OS-drawn window, so it would leak through stealth just like native <select>.
// `loadIds` is called once, lazily, on first focus.
function attachSuggestions(input, loadIds) {
  let ids = null;
  let menu = null;
  const close = () => { if (menu) { menu.remove(); menu = null; } };
  const render = () => {
    close();
    const q = input.value.trim().toLowerCase();
    const matches = (ids || []).filter((m) => m.toLowerCase().includes(q)).slice(0, 40);
    if (!matches.length) return;
    menu = document.createElement('div');
    menu.className = 'dd-menu';
    for (const m of matches) {
      const it = document.createElement('div');
      it.className = 'dd-item';
      it.textContent = m;
      // mousedown (not click) so it wins over the input's blur
      it.onmousedown = (e) => { e.preventDefault(); input.value = m; close(); };
      menu.appendChild(it);
    }
    document.body.appendChild(menu);
    positionMenu(menu, input.getBoundingClientRect());
  };
  input.addEventListener('focus', async () => {
    if (!ids) ids = (await loadIds()) || null;
    if (ids && document.activeElement === input) render();
  });
  input.addEventListener('input', () => { if (ids) render(); });
  input.addEventListener('blur', () => setTimeout(close, 0));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === 'Enter') close(); });
  document.addEventListener('scroll', close, true);
}

// Mirror each select's state (selected label, disabled, .active) onto its button.
function syncDropdowns() {
  for (const dd of dropdowns) {
    const o = dd.sel.selectedOptions[0];
    dd.lab.textContent = o ? (o.dataset.id || o.dataset.full || o.textContent) : '';
    dd.btn.disabled = dd.sel.disabled;
    dd.btn.classList.toggle('active', dd.sel.classList.contains('active'));
  }
}

// ---- Providers & models -----------------------------------------------------
// The titlebar shows ONE dropdown of every model across all configured
// providers. Provider selection is implicit: choosing a model selects its
// provider too. Option values are encoded "providerId::modelName".
let providerMeta = []; // [{id, name, needsKey, hasKey, keyFromEnv}]

const encodeModel = (pid, model) => pid + '::' + model;
function decodeModel(value) {
  const i = value.indexOf('::');
  return i < 0 ? { provider: 'local', model: value } : { provider: value.slice(0, i), model: value.slice(i + 2) };
}

async function refreshProviders() {
  providerMeta = await api.listProviders();
}

// Curated entries for a cloud provider: [{id, in, out}]. Local has none.
function curatedFor(pid) {
  return ((settings.curatedModels || {})[pid] || []).slice();
}

// Compact price label, e.g. "$1.5/$9" or "free". null in/out => unknown.
function priceLabel(entry) {
  if (!entry) return '';
  if (entry.in == null && entry.out == null) return '';
  if (entry.in === 0 && entry.out === 0) return 'free';
  const f = (n) => (n == null ? '?' : '$' + n);
  return f(entry.in) + '/' + f(entry.out);
}

// Build the titlebar dropdown. Local => installed models (from Ollama).
// Cloud providers => your curated list only (with price tags).
async function refreshModels() {
  els.model.disabled = true;

  // Local models come from the Ollama API; cloud models come from the curated list.
  const local = providerMeta.find((p) => p.id === 'local');
  let localModels = [];
  let localErr = null;
  if (local) {
    const r = await api.listModels('local');
    localModels = r.ok ? r.models : [];
    if (!r.ok) localErr = r.error;
  }
  els.model.disabled = false;

  const groups = [];
  if (local) {
    groups.push({
      provider: local,
      entries: localModels.map((m) => ({ id: m })) // no price for local
    });
  }
  for (const p of providerMeta) {
    if (p.id === 'local') continue;
    if (p.needsKey && !p.hasKey) continue; // skip providers without a key
    groups.push({ provider: p, entries: curatedFor(p.id) });
  }

  // ensure the currently-active model is always selectable
  const cur = { provider: settings.provider || 'local', model: settings.model };
  const curGroup = groups.find((g) => g.provider.id === cur.provider);
  if (cur.model && curGroup && !curGroup.entries.some((e) => e.id === cur.model)) {
    curGroup.entries.unshift({ id: cur.model });
  }

  fillModelSelects(groups, encodeModel(cur.provider, cur.model));

  if (localErr) toast('Local: ' + trimErr(localErr));
}

function fillModelSelects(groups, chosenValue) {
  for (const sel of [els.model, $('setModel')]) {
    if (!sel) continue;
    sel.innerHTML = '';
    for (const g of groups) {
      if (!g.entries.length) continue;
      const og = document.createElement('optgroup');
      og.label = g.provider.name;
      for (const e of g.entries) {
        const o = document.createElement('option');
        o.value = encodeModel(g.provider.id, e.id);
        const price = priceLabel(e);
        // full text (id + price) shown when the list is OPEN; store the bare id
        // so we can shrink the option while it's the closed/selected one.
        o.textContent = e.id + (price ? '  ·  ' + price : '');
        o.dataset.id = e.id;
        o.dataset.full = o.textContent;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    if (chosenValue) sel.value = chosenValue;
  }
  // collapse the selected option in the titlebar so the closed box is compact
  collapseSelectedOption(els.model);
  syncDropdowns();
}

// When closed, the selected <option>'s text is what the box shows. Strip its
// price to id-only; restore the full id·price text whenever the list opens.
function collapseSelectedOption(sel) {
  if (!sel) return;
  const opts = sel.options;
  for (const o of opts) if (o.dataset.full) o.textContent = o.dataset.id; // bare while closed
  const restore = () => { for (const o of opts) if (o.dataset.full) o.textContent = o.dataset.full; };
  const collapse = () => {
    for (const o of opts) o.textContent = o === sel.selectedOptions[0] ? o.dataset.id : o.dataset.full;
  };
  // open → show prices; close/change → collapse selected back to id
  sel.onmousedown = restore;
  sel.onfocus = restore;
  sel.onblur = collapse;
}

function trimErr(e) {
  const s = String(e);
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

// Selecting a model also sets its provider. Remembers the per-provider choice.
async function setActiveModel(value) {
  const { provider, model } = decodeModel(value);
  const providerModels = { ...(settings.providerModels || {}), [provider]: model };
  settings = await api.setSettings({ provider, model, providerModels });
}

// ---- Skills -----------------------------------------------------------------
// Populate the titlebar picker (+ the Settings copy) from settings.skills.
// '' = None / General (base prompt only).
function refreshSkills() {
  const skills = settings.skills || [];
  const sel = els.skill;
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'General';
  sel.appendChild(none);
  for (const sk of skills) {
    const o = document.createElement('option');
    o.value = sk.id;
    o.textContent = sk.name;
    sel.appendChild(o);
  }
  sel.value = settings.activeSkill || '';
  updateSkillUI();
  renderSkillList();
}

function updateSkillUI() {
  els.skill.classList.toggle('active', !!settings.activeSkill);
  els.skill.value = settings.activeSkill || '';
  syncDropdowns();
}

function activeSkillObj() {
  if (!settings.activeSkill) return null;
  return (settings.skills || []).find((s) => s.id === settings.activeSkill) || null;
}

// Base prompt always applies; the active skill's prompt is layered beneath it.
function composeSystemPrompt() {
  const base = settings.systemPrompt || '';
  const sk = activeSkillObj();
  if (!sk) return base;
  return base + '\n\n--- Active skill: ' + sk.name + ' ---\n' + sk.prompt;
}

// Persist the skills array, then refresh both the picker and the editor.
async function saveSkills(skills) {
  settings = await api.setSettings({ skills });
  refreshSkills();
}

let skillSlug = 0;
function makeSkillId(name) {
  const base = (name || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return (base || 'skill') + '-' + (++skillSlug) + '-' + (settings.skills || []).length;
}

// Build the editable list inside Settings.
function renderSkillList() {
  const wrap = $('skillList');
  if (!wrap) return;
  wrap.innerHTML = '';
  const skills = settings.skills || [];
  if (!skills.length) {
    const e = document.createElement('div');
    e.className = 'muted small';
    e.textContent = 'No skills yet. Add one to specialize Orbit.';
    wrap.appendChild(e);
    return;
  }
  for (const sk of skills) {
    const item = document.createElement('div');
    item.className = 'skill-item' + (settings.activeSkill === sk.id ? ' is-active' : '');

    const head = document.createElement('div');
    head.className = 'skill-item-head';

    const dot = document.createElement('span');
    dot.className = 'skill-active-dot';
    dot.title = 'Active skill indicator';

    const name = document.createElement('input');
    name.className = 'skill-name';
    name.type = 'text';
    name.value = sk.name;
    name.onchange = () => updateSkill(sk.id, { name: name.value.trim() || 'Untitled' });

    const del = document.createElement('button');
    del.className = 'skill-del';
    del.title = 'Delete skill';
    del.innerHTML = icon('i-trash');
    let confirmTimer = null;
    const resetDel = () => {
      del.classList.remove('confirm');
      del.innerHTML = icon('i-trash');
      del.title = 'Delete skill';
      clearTimeout(confirmTimer);
      confirmTimer = null;
    };
    del.onclick = () => {
      if (del.classList.contains('confirm')) { resetDel(); deleteSkill(sk.id); return; }
      // arm: ask for a second click to confirm
      del.classList.add('confirm');
      del.textContent = 'Delete?';
      del.title = 'Click again to confirm';
      confirmTimer = setTimeout(resetDel, 3000);
    };

    head.appendChild(dot);
    head.appendChild(name);
    head.appendChild(del);

    const prompt = document.createElement('textarea');
    prompt.className = 'skill-prompt';
    prompt.value = sk.prompt;
    prompt.placeholder = 'What should Orbit do in this skill?';
    prompt.onchange = () => updateSkill(sk.id, { prompt: prompt.value });

    item.appendChild(head);
    item.appendChild(prompt);
    wrap.appendChild(item);
  }
}

function updateSkill(id, patch) {
  const skills = (settings.skills || []).map((s) => (s.id === id ? { ...s, ...patch } : s));
  saveSkills(skills);
}

async function deleteSkill(id) {
  const skills = (settings.skills || []).filter((s) => s.id !== id);
  // if we deleted the active skill, fall back to General
  const patch = { skills };
  if (settings.activeSkill === id) patch.activeSkill = '';
  settings = await api.setSettings(patch);
  refreshSkills();
  toast('Skill deleted');
}

async function addSkill() {
  const skills = [...(settings.skills || [])];
  const id = makeSkillId('new skill');
  skills.push({ id, name: 'New skill', prompt: '' });
  await saveSkills(skills);
  // focus the new skill's name field for immediate editing
  const last = $('skillList').querySelector('.skill-item:last-child .skill-name');
  if (last) { last.focus(); last.select(); }
}

// ---- UI events --------------------------------------------------------------
function bindUI() {
  els.send.onclick = sendMessage;
  els.stop.onclick = stopGenerating;
  els.mic.onclick = toggleDictation;

  // macOS-style window controls (top-left) — each does something distinct
  els.tlClose.onclick = () => api.hide();                  // red: hide overlay
  els.tlMin.onclick = async () => {                        // yellow: minimize to strip
    const r = await api.compact();
    document.body.classList.toggle('compact', !!(r && r.compact));
  };
  els.tlZoom.onclick = () => api.widen();                  // green: widen a step

  // Sidebar / chat history
  els.sidebarBtn.onclick = toggleSidebar;
  els.sidebarScrim.onclick = closeSidebar;
  els.newChatBtn.onclick = () => { newChat(); closeSidebar(); };

  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  els.input.addEventListener('input', autoGrow);

  els.model.onchange = async () => {
    await setActiveModel(els.model.value);
    $('setModel').value = els.model.value; // keep settings copy in sync
    updateThinkBtn(); // reflect whether the new model forces reasoning
    syncDropdowns();
  };

  els.skill.onchange = async () => {
    settings = await api.setSettings({ activeSkill: els.skill.value });
    updateSkillUI();
    const sk = activeSkillObj();
    toast(sk ? 'Skill: ' + sk.name : 'Skill off — general mode');
  };

  els.think.onclick = async () => {
    settings = await api.setSettings({ thinking: !settings.thinking });
    updateThinkBtn();
    toast(settings.thinking ? 'Thinking mode on' : 'Thinking mode off');
  };

  els.listen.onclick = toggleListen;
  els.lpAdd.onclick = addToMessage;
  els.lpClear.onclick = clearTranscript;

  els.settingsBtn.onclick = openSettings;
  els.settingsClose.onclick = () => els.settings.classList.add('hidden');

  // Quick restart — click once to arm ("Restart?"), click again within 3s to do it.
  let restartArmed = null;
  els.restartBtn.onclick = () => {
    if (restartArmed) { clearTimeout(restartArmed); api.restart(); return; }
    els.restartBtn.classList.add('armed');
    toast('Click restart again to relaunch Orbit');
    restartArmed = setTimeout(() => {
      restartArmed = null;
      els.restartBtn.classList.remove('armed');
    }, 3000);
  };

  api.onAudioStatus(onAudioStatus);

  api.onFocusInput(() => els.input.focus());
  api.onClearChat(clearChat);

  // Delegated: copy buttons inside rendered code blocks.
  els.messages.addEventListener('click', (e) => {
    const btn = e.target.closest('.cb-copy');
    if (!btn) return;
    const code = decodeURIComponent(btn.dataset.code || '');
    navigator.clipboard.writeText(code).then(() => {
      btn.classList.add('ok');
      btn.innerHTML = icon('i-check');
      setTimeout(() => { btn.classList.remove('ok'); btn.innerHTML = icon('i-copy'); }, 1100);
    });
  });

  bindSettingsForm();
}

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 120) + 'px';
}

// ---- Chat -------------------------------------------------------------------
function sendMessage() {
  const text = els.input.value.trim();
  if (!text || streaming) return;
  els.input.value = '';
  autoGrow();

  history.push({ role: 'user', content: text });
  addMessage('user', text);
  resend();
}

function bindStream() {
  api.onThinking((t) => {
    if (!cur) return;
    revealThink();
    cur.thinking += t;
    cur.thinkBody.textContent = cur.thinking;
    scroll();
  });
  api.onToken((t) => {
    if (!cur) return;
    cur.content += t;
    cur.contentEl.innerHTML = renderMarkdown(cur.content);
    scroll();
  });
  api.onDone(() => {
    if (cur) {
      history.push({ role: 'assistant', content: cur.content });
      attachActions(cur.contentEl.closest('.msg'), 'assistant');
    }
    finishStream();
    persistCurrentChat();
  });
  api.onError((m) => {
    if (cur) {
      cur.contentEl.innerHTML = renderMarkdown((cur.content || '') + '\n\n— ' + m);
      if (cur.content) history.push({ role: 'assistant', content: cur.content });
    }
    finishStream();
    persistCurrentChat();
  });
  api.onWarn((m) => toast(m));
  api.onForcedThinking((d) => {
    const key = encodeModel(d.provider, d.model);
    if (!forcedThinkingModels.has(key)) {
      forcedThinkingModels.add(key);
      updateThinkBtn();
      toast('This model always thinks — reasoning can’t be turned off');
    }
  });
}

function setStreaming(on) {
  streaming = on;
  els.send.classList.toggle('hidden', on);
  els.stop.classList.toggle('hidden', !on);
}
function finishStream() {
  setStreaming(false);
  if (cur && cur.contentEl) cur.contentEl.classList.remove('streaming');
  cur = null;
}

// User clicked Stop. Tell main to abort, and flip the UI out of the streaming
// state immediately so the button never gets stuck waiting on the round-trip.
function stopGenerating() {
  if (!streaming) return;
  api.stopChat();
  if (cur) {
    // keep whatever streamed so far as a finished message
    history.push({ role: 'assistant', content: cur.content || '…' });
    attachActions(cur.contentEl.closest('.msg'), 'assistant');
  }
  finishStream();
  persistCurrentChat();
}

function startAssistant() {
  removeEmpty();
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML = '<div class="role">orbit</div>';

  const think = document.createElement('details');
  think.className = 'think hidden';
  think.innerHTML = '<summary>' + icon('i-spark', 'tk-ic') + 'Thinking…</summary>';
  const thinkBody = document.createElement('div');
  thinkBody.className = 'think-body';
  think.appendChild(thinkBody);

  const bubble = document.createElement('div');
  bubble.className = 'bubble streaming';
  bubble.textContent = '';

  wrap.appendChild(think);
  wrap.appendChild(bubble);
  els.messages.appendChild(wrap);

  cur = { contentEl: bubble, thinkEl: think, thinkBody, content: '', thinking: '' };
  scroll(true);
}
function revealThink() {
  if (cur && cur.thinkEl.classList.contains('hidden')) {
    cur.thinkEl.classList.remove('hidden');
    cur.thinkEl.open = true;
  }
}

function addMessage(role, text) {
  removeEmpty();
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  wrap.innerHTML = `<div class="role">${role === 'user' ? 'you' : 'orbit'}</div>`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  attachActions(wrap, role);
  els.messages.appendChild(wrap);
  scroll(true);
}

// ---- Message actions (hover toolbar) ----------------------------------------
// Index of a message wrapper among the .msg elements == its index in `history`.
function msgIndex(wrap) {
  return [...els.messages.querySelectorAll('.msg')].indexOf(wrap);
}

function attachActions(wrap, role) {
  const bar = document.createElement('div');
  bar.className = 'msg-actions';

  const mkBtn = (iconId, title, fn) => {
    const b = document.createElement('button');
    b.className = 'msg-act';
    b.title = title;
    b.innerHTML = icon(iconId);
    b.onclick = fn;
    return b;
  };

  // Copy (both roles) — copies the message's raw text from history.
  const copyBtn = mkBtn('i-copy', 'Copy', () => {
    const i = msgIndex(wrap);
    const text = (history[i] && history[i].content) || wrap.querySelector('.bubble').textContent;
    navigator.clipboard.writeText(text).then(() => flashCopied(copyBtn));
  });
  bar.appendChild(copyBtn);

  if (role === 'assistant') {
    bar.appendChild(mkBtn('i-regen', 'Regenerate', () => regenerateFrom(wrap)));
  } else {
    bar.appendChild(mkBtn('i-edit', 'Edit & resend', () => editAndResend(wrap)));
  }

  wrap.appendChild(bar);
}

function flashCopied(btn) {
  const prev = btn.innerHTML;
  btn.innerHTML = icon('i-check');
  btn.classList.add('ok');
  setTimeout(() => { btn.innerHTML = prev; btn.classList.remove('ok'); }, 1100);
}

// Regenerate: drop this assistant message (and anything after), re-send the
// conversation up to the preceding user turn.
function regenerateFrom(wrap) {
  if (streaming) return;
  const i = msgIndex(wrap);
  if (i < 0) return;
  // truncate history to everything before this assistant message
  history = history.slice(0, i);
  // remove DOM from this message onward
  truncateMessagesFrom(wrap);
  resend();
}

// Edit & resend: put the user message back in the composer, truncate from it.
function editAndResend(wrap) {
  if (streaming) return;
  const i = msgIndex(wrap);
  if (i < 0) return;
  const text = (history[i] && history[i].content) || '';
  history = history.slice(0, i);
  truncateMessagesFrom(wrap);
  els.input.value = text;
  autoGrow();
  els.input.focus();
}

function truncateMessagesFrom(wrap) {
  const msgs = [...els.messages.querySelectorAll('.msg')];
  const start = msgs.indexOf(wrap);
  if (start < 0) return;
  for (let k = msgs.length - 1; k >= start; k--) msgs[k].remove();
}

// Re-send the current `history` to the model (used by regenerate).
function resend() {
  if (!history.length) return;
  const messages = [{ role: 'system', content: composeSystemPrompt() }, ...history];
  startAssistant();
  setStreaming(true);
  api
    .sendChat({
      provider: settings.provider,
      model: settings.model,
      messages,
      thinking: settings.thinking,
      temperature: settings.temperature
    })
    .then((res) => {
      if (res && res.ok === false) toast(trimErr(res.error || 'Request failed'));
    });
}

function clearChat() {
  newChat();
}
function renderEmpty() {
  if (els.messages.children.length) return;
  const e = document.createElement('div');
  e.className = 'empty';
  e.innerHTML =
    orbitLogo('mark') +
    '<div class="title">Ask Orbit anything</div>';
  els.messages.appendChild(e);
}
function removeEmpty() {
  const e = els.messages.querySelector('.empty');
  if (e) e.remove();
}
// Auto-scroll only when the user is already near the bottom, so scrolling up
// to read earlier text mid-stream doesn't yank the view back down.
function scroll(force) {
  const el = els.messages;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (force || nearBottom) el.scrollTop = el.scrollHeight;
}

// ---- Sidebar / chat history -------------------------------------------------
function toggleSidebar() {
  if (els.sidebar.classList.contains('closed')) openSidebar();
  else closeSidebar();
}
function openSidebar() {
  els.sidebar.classList.remove('closed');
  els.sidebarScrim.classList.remove('hidden');
  renderChatList();
}
function closeSidebar() {
  els.sidebar.classList.add('closed');
  els.sidebarScrim.classList.add('hidden');
}

// Derive a short title from the first user message.
function titleFrom(msgs) {
  const first = (msgs || []).find((m) => m.role === 'user');
  const t = (first ? first.content : 'New chat').trim().replace(/\s+/g, ' ');
  return t.length > 48 ? t.slice(0, 47) + '…' : t || 'New chat';
}

// Persist the in-memory `history` as a chat. Creates an id on first save.
async function persistCurrentChat() {
  if (!history.length) return; // nothing worth saving
  if (!currentChatId) currentChatId = 'c' + Date.now() + Math.floor(Math.random() * 1000);
  const existing = await api.getChat(currentChatId);
  const chat = {
    id: currentChatId,
    title: existing && existing.titleEdited ? existing.title : titleFrom(history),
    titleEdited: existing ? existing.titleEdited : false,
    messages: history,
    createdAt: existing ? existing.createdAt : Date.now(),
    updatedAt: Date.now()
  };
  await api.saveChat(chat);
}

// Start a fresh, unsaved chat.
function newChat() {
  history = [];
  currentChatId = null;
  els.messages.innerHTML = '';
  renderEmpty();
  els.input.focus();
}

// Load a saved chat into the view.
async function openChat(id) {
  const chat = await api.getChat(id);
  if (!chat) return;
  currentChatId = id;
  history = chat.messages.slice();
  els.messages.innerHTML = '';
  for (const m of history) {
    if (m.role === 'user') addMessage('user', m.content);
    else renderAssistantStatic(m.content);
  }
  if (!history.length) renderEmpty();
  closeSidebar();
  scroll();
}

// Render a finished assistant message (markdown, no streaming caret).
function renderAssistantStatic(content) {
  removeEmpty();
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  wrap.innerHTML = '<div class="role">orbit</div>';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = renderMarkdown(content);
  wrap.appendChild(bubble);
  attachActions(wrap, 'assistant');
  els.messages.appendChild(wrap);
}

async function renderChatList() {
  const chats = await api.listChats();
  els.chatList.innerHTML = '';
  if (!chats.length) {
    const e = document.createElement('div');
    e.className = 'empty-hist';
    e.textContent = 'No saved chats yet.';
    els.chatList.appendChild(e);
    return;
  }
  for (const c of chats) {
    const row = document.createElement('div');
    row.className = 'chat-row' + (c.id === currentChatId ? ' active' : '');
    row.onclick = (e) => { if (e.target.closest('.chat-del')) return; openChat(c.id); };

    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    const name = document.createElement('div');
    name.className = 'chat-name';
    name.textContent = c.title || 'Untitled';
    const sub = document.createElement('div');
    sub.className = 'chat-sub';
    sub.textContent = relativeTime(c.updatedAt) + ' · ' + c.count + ' msg';
    meta.appendChild(name);
    meta.appendChild(sub);

    const del = document.createElement('button');
    del.className = 'chat-del';
    del.title = 'Delete chat';
    del.innerHTML = icon('i-trash');
    let t = null;
    const reset = () => { del.classList.remove('confirm'); del.innerHTML = icon('i-trash'); clearTimeout(t); t = null; };
    del.onclick = (e) => {
      e.stopPropagation();
      if (del.classList.contains('confirm')) { reset(); removeChat(c.id); return; }
      del.classList.add('confirm');
      del.textContent = 'Delete?';
      t = setTimeout(reset, 3000);
    };

    row.appendChild(meta);
    row.appendChild(del);
    els.chatList.appendChild(row);
  }
}

async function removeChat(id) {
  await api.deleteChat(id);
  if (id === currentChatId) newChat();
  renderChatList();
  toast('Chat deleted');
}

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 7) return d + 'd ago';
  return new Date(ts).toLocaleDateString();
}

// ---- Settings form ----------------------------------------------------------
function openSettings() {
  $('setModel').value = encodeModel(settings.provider || 'local', settings.model);
  $('setThinking').checked = !!settings.thinking;
  $('setTemp').value = settings.temperature;
  $('tempVal').textContent = settings.temperature;
  $('setSystem').value = settings.systemPrompt;
  $('setStealth').checked = !!settings.stealth;
  $('setOpacity').value = settings.opacity;
  $('opVal').textContent = settings.opacity;
  $('setTheme').value = settings.theme;
  $('setHost').value = settings.ollamaHost;
  renderProviderBlocks();
  $('hkToggle').value = settings.hotkeys.toggle;
  $('hkFocus').value = settings.hotkeys.focus;
  $('hkClear').value = settings.hotkeys.clear;
  $('setAudioSource').value = settings.audioSource;
  $('setWhisper').value = settings.whisperModel;
  $('setAutoShow').checked = !!settings.autoShowOnSpeech;
  renderSkillList();
  syncDropdowns();
  els.settings.classList.remove('hidden');
}

function keyFromEnv(id) {
  const p = providerMeta.find((x) => x.id === id);
  return !!(p && p.keyFromEnv);
}

// Persist an API key, then re-evaluate provider readiness + reload models.
async function saveKey(provId, value) {
  const apiKeys = { ...(settings.apiKeys || {}), [provId]: value.trim() };
  settings = await api.setSettings({ apiKeys });
  await refreshProviders();
  await refreshModels();
  renderProviderBlocks();
}

// Build the per-cloud-provider Settings block: key field + curated model chips
// (with price tags) + an add-model row backed by the API's available ids.
const ENV_VARS = { gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
const PROV_NAMES = { gemini: 'Gemini', openrouter: 'OpenRouter' };

function renderProviderBlocks() {
  for (const pid of ['gemini', 'openrouter']) {
    const mount = $('prov' + pid[0].toUpperCase() + pid.slice(1));
    if (!mount) continue;
    mount.innerHTML = '';

    // header
    const head = document.createElement('div');
    head.className = 'prov-head';
    head.innerHTML = PROV_NAMES[pid] +
      (keyFromEnv(pid) ? ' <span class="prov-env small">· key from env</span>' : '');
    mount.appendChild(head);

    // API key field
    const keyLabel = document.createElement('label');
    keyLabel.textContent = 'API key';
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.autocomplete = 'off';
    keyInput.value = (settings.apiKeys || {})[pid] || '';
    keyInput.placeholder = 'leave blank to use ' + ENV_VARS[pid];
    keyInput.onchange = () => saveKey(pid, keyInput.value);
    keyLabel.appendChild(keyInput);
    mount.appendChild(keyLabel);

    // curated model chips
    const chips = document.createElement('div');
    chips.className = 'model-chips';
    const curated = curatedFor(pid);
    if (!curated.length) {
      const e = document.createElement('div');
      e.className = 'muted small';
      e.textContent = 'No models added yet.';
      chips.appendChild(e);
    }
    for (const entry of curated) {
      chips.appendChild(buildModelChip(pid, entry));
    }
    mount.appendChild(chips);

    // add-model row (datalist autocomplete from the API's available ids)
    mount.appendChild(buildAddRow(pid));
  }
}

function buildModelChip(pid, entry) {
  const chip = document.createElement('div');
  chip.className = 'model-chip';
  const id = document.createElement('span');
  id.className = 'mc-id';
  id.textContent = entry.id;
  id.title = entry.id;
  chip.appendChild(id);

  const price = priceLabel(entry);
  if (price) {
    const tag = document.createElement('span');
    tag.className = 'mc-price' + (price === 'free' ? ' free' : '');
    tag.textContent = price === 'free' ? 'free' : price + ' /1M';
    chip.appendChild(tag);
  }

  const del = document.createElement('button');
  del.className = 'mc-del';
  del.textContent = '×';
  del.title = 'Remove';
  del.onclick = () => removeCuratedModel(pid, entry.id);
  chip.appendChild(del);
  return chip;
}

function buildAddRow(pid) {
  const row = document.createElement('div');
  row.className = 'model-add-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'model id (e.g. ' + (pid === 'gemini' ? 'gemini-3.5-flash' : 'openai/gpt-oss-120b') + ')';

  // available ids fetched lazily on first focus (needs a key)
  attachSuggestions(input, async () => {
    const meta = providerMeta.find((p) => p.id === pid);
    if (!meta || (meta.needsKey && !meta.hasKey)) return null;
    const r = await api.listModels(pid);
    return r.ok ? r.models : null;
  });

  const priceIn = document.createElement('input');
  priceIn.type = 'text'; priceIn.placeholder = '$in'; priceIn.style.maxWidth = '52px';
  const priceOut = document.createElement('input');
  priceOut.type = 'text'; priceOut.placeholder = '$out'; priceOut.style.maxWidth = '52px';

  const add = document.createElement('button');
  add.className = 'skill-add';
  add.textContent = '+ Add';
  const doAdd = () => {
    const id = input.value.trim();
    if (!id) return;
    addCuratedModel(pid, id, parseNum(priceIn.value), parseNum(priceOut.value));
    input.value = priceIn.value = priceOut.value = '';
  };
  add.onclick = doAdd;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });

  row.appendChild(input);
  row.appendChild(priceIn);
  row.appendChild(priceOut);
  row.appendChild(add);
  return row;
}

function parseNum(s) {
  const n = parseFloat(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function addCuratedModel(pid, id, priceIn, priceOut) {
  const list = curatedFor(pid);
  if (list.some((e) => e.id === id)) { toast('Already added'); return; }
  list.push({ id, in: priceIn, out: priceOut });
  const curatedModels = { ...(settings.curatedModels || {}), [pid]: list };
  settings = await api.setSettings({ curatedModels });
  renderProviderBlocks();
  await refreshModels();
  toast('Added ' + id);
}

async function removeCuratedModel(pid, id) {
  const list = curatedFor(pid).filter((e) => e.id !== id);
  const curatedModels = { ...(settings.curatedModels || {}), [pid]: list };
  settings = await api.setSettings({ curatedModels });
  renderProviderBlocks();
  await refreshModels();
}

function bindSettingsForm() {
  const patch = async (p) => { settings = await api.setSettings(p); };

  $('setModel').onchange = async (e) => { await setActiveModel(e.target.value); els.model.value = e.target.value; syncDropdowns(); };
  $('setThinking').onchange = async (e) => {
    await patch({ thinking: e.target.checked });
    updateThinkBtn();
  };
  $('setTemp').oninput = (e) => { $('tempVal').textContent = e.target.value; patch({ temperature: parseFloat(e.target.value) }); };
  $('setSystem').onchange = (e) => patch({ systemPrompt: e.target.value });
  $('setStealth').onchange = async (e) => { await patch({ stealth: e.target.checked }); applyTheme(); };
  $('setOpacity').oninput = (e) => { $('opVal').textContent = e.target.value; settings.opacity = parseFloat(e.target.value); document.body.style.opacity = e.target.value; patch({ opacity: parseFloat(e.target.value) }); };
  $('setTheme').onchange = (e) => { settings.theme = e.target.value; applyTheme(); patch({ theme: e.target.value }); };
  $('setHost').onchange = async (e) => { await patch({ ollamaHost: e.target.value }); refreshModels(); };

  $('setAudioSource').onchange = (e) => patch({ audioSource: e.target.value });
  $('setWhisper').onchange = (e) => patch({ whisperModel: e.target.value });
  $('setAutoShow').onchange = (e) => patch({ autoShowOnSpeech: e.target.checked });
  $('addSkillBtn').onclick = addSkill;

  // Hotkey capture
  for (const [id, key] of [['hkToggle', 'toggle'], ['hkFocus', 'focus'], ['hkClear', 'clear']]) {
    const inp = $(id);
    inp.addEventListener('keydown', async (e) => {
      e.preventDefault();
      const accel = toAccelerator(e);
      if (!accel) return;
      inp.value = accel;
      const hotkeys = { ...settings.hotkeys, [key]: accel };
      await patch({ hotkeys });
    });
  }
}

function toAccelerator(e) {
  const parts = [];
  if (e.metaKey) parts.push('CommandOrControl');
  if (e.ctrlKey && !e.metaKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(k)) return null;
  if (k === ' ') k = 'Space';
  else if (k === 'Backspace') k = 'Backspace';
  else if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join('+');
}

// ---- Audio listening mode ---------------------------------------------------
const SR = 16000; // AudioContext resamples sources to this for Whisper
const THRESH = 0.006; // RMS speech threshold (system/loopback audio runs quieter than mic)
const SILENCE_HANG_MS = 700; // silence after speech that ends a segment
const MIN_SEG_SEC = 0.4; // ignore blips shorter than this
const MAX_SEG_SEC = 6;  // flush a segment after this long even without a silence gap
                        // (continuous media like YouTube never pauses, so silence
                        //  alone would never close a segment)

let listening = false;
let audioCtx = null;
let processor = null;
let mediaStreams = [];
let srcNodes = [];
let speechBuf = [];
let speaking = false;
let silenceMs = 0;
let transcriptText = ''; // accumulated heard text, shown in the panel

async function toggleListen() {
  if (listening) return stopListen();
  return startListen();
}

function lpSetStatus(s) { if (els.lpStatus) els.lpStatus.textContent = s; }

function renderListenPanel() {
  const has = !!transcriptText.trim();
  els.lpBody.innerHTML = has
    ? escapeHtml(transcriptText)
    : '<span class="lp-empty">Waiting for speech…</span>';
  els.lpBody.scrollTop = els.lpBody.scrollHeight;
  els.lpAdd.disabled = !has;
  els.lpClear.disabled = !has;
}

function addToMessage() {
  const t = transcriptText.trim();
  if (!t) return;
  els.input.value = (els.input.value ? els.input.value.trim() + ' ' : '') + t;
  autoGrow();
  transcriptText = '';
  renderListenPanel();
  if (!listening) updateListenUI(); // hide panel if we're already stopped
  els.input.focus();
}

function clearTranscript() {
  transcriptText = '';
  renderListenPanel();
  if (!listening) updateListenUI();
}

function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))
  ]);
}

async function startListen() {
  try {
    // fresh start every time — drop any leftover speech buffer/state
    speechBuf = [];
    speaking = false;
    silenceMs = 0;
    dbgPeak = 0;
    dbgSeg = 0;
    els.listen.classList.add('active');
    els.listen.title = 'Starting…';
    const wanted = settings.audioSource || 'system';

    await api.audioStart(); // boots the whisper sidecar (may download model first run)

    // Attempt capture. The attempt itself is what makes macOS prompt AND register
    // "Orbit" in the Screen Recording / Microphone lists — so we must try it, not
    // bail out beforehand.
    mediaStreams = [];
    try {
      if (wanted === 'mic' || wanted === 'both') {
        mediaStreams.push(await navigator.mediaDevices.getUserMedia({ audio: true }));
      }
      if (wanted === 'system' || wanted === 'both') {
        const s = await withTimeout(
          navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
          15000,
          'system-audio capture timed out'
        );
        s.getVideoTracks().forEach((t) => t.stop()); // we only want the audio
        mediaStreams.push(s);
      }
    } catch (capErr) {
      await cleanupAudio();
      await api.audioStop();
      els.listen.classList.remove('active');
      const perm = await api.permStatus();
      const needScreen = wanted !== 'mic';
      if (needScreen && perm.screen === 'denied') {
        // macOS quirk: after you toggle Screen Recording ON, the grant only takes
        // effect once the app FULLY restarts — the running process still sees it
        // denied. So the fix is almost always "relaunch", not "enable again".
        await api.openPerm('screen');
        toast('Screen Recording: if it already shows ON for Orbit, just RESTART Orbit (↻) — macOS applies the grant only after a relaunch.');
      } else if (needScreen && perm.screen !== 'granted') {
        await api.openPerm('screen');
        toast('Enable Screen Recording for Orbit in System Settings, then restart Orbit (↻).');
      } else if (perm.mic === 'denied') {
        await api.openPerm('mic');
        toast('Turn ON “Orbit” under Microphone in System Settings, then try again.');
      } else {
        // permission looks fine — a transient capture failure; let the user retry
        toast('Audio capture failed — try Listen again. (' + (capErr.message || capErr) + ')');
      }
      updateListenUI();
      return;
    }
    if (!mediaStreams.length) throw new Error('no audio source');

    audioCtx = new AudioContext({ sampleRate: SR });
    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    srcNodes = mediaStreams.map((s) => {
      const node = audioCtx.createMediaStreamSource(s);
      node.connect(processor);
      return node;
    });
    // ScriptProcessor only runs when connected to the destination, but we
    // mute it (gain 0) so we don't echo the call back through the speakers.
    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(audioCtx.destination);
    processor.onaudioprocess = onAudio;

    listening = true;
    updateListenUI();
    els.listenPanel.classList.remove('hidden');
    lpSetStatus('Listening…');
    renderListenPanel();
    toast('Listening — review the transcript, then “Add to message”');
  } catch (e) {
    toast('Audio error: ' + (e.message || e));
    await cleanupAudio();
    updateListenUI();
  }
}

async function stopListen() {
  // flip state + UI immediately so the button never feels stuck
  listening = false;
  updateListenUI();
  lpSetStatus('Stopped — add the text or clear it');
  toast('Stopped listening');
  // flush whatever was buffered, then tear down capture (async, in background)
  if (speechBuf.length) finalizeSegment();
  try { await cleanupAudio(); } catch (e) { console.error('cleanupAudio', e); }
  try { await api.audioStop(); } catch (e) { console.error('audioStop', e); }
}

async function cleanupAudio() {
  if (processor) {
    processor.onaudioprocess = null;
    processor.disconnect();
    processor = null;
  }
  srcNodes.forEach((n) => n.disconnect());
  srcNodes = [];
  mediaStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  mediaStreams = [];
  if (audioCtx) {
    try { await audioCtx.close(); } catch {}
    audioCtx = null;
  }
}

let dbgPeak = 0; // peak RMS seen (debug HUD)
let dbgSeg = 0;  // segments sent to transcribe
function dbgHud() {
  // live readout in the panel status so we can diagnose without DevTools
  lpSetStatus(`Listening · level ${dbgPeak.toFixed(3)} (need >${THRESH}) · ${dbgSeg} seg`);
}

function onAudio(e) {
  if (!listening) return; // user turned it off — ignore any trailing frames
  const input = e.inputBuffer.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
  const rms = Math.sqrt(sum / input.length);
  const frameMs = (input.length / SR) * 1000;

  if (rms > dbgPeak) dbgPeak = rms;
  window._rmsTick = (window._rmsTick || 0) + 1;
  if (window._rmsTick % 10 === 0) { dbgHud(); dbgPeak *= 0.6; } // decay so it tracks recent peak

  if (rms > THRESH) {
    speaking = true;
    silenceMs = 0;
    speechBuf.push(new Float32Array(input));
  } else if (speaking) {
    speechBuf.push(new Float32Array(input));
    silenceMs += frameMs;
    if (silenceMs > SILENCE_HANG_MS) finalizeSegment();
  }

  // Continuous audio (media playback) may never go silent — flush periodically
  // so we don't accumulate forever and never transcribe.
  const bufSamples = speechBuf.reduce((a, b) => a + b.length, 0);
  if (speaking && bufSamples >= SR * MAX_SEG_SEC) finalizeSegment();
}

function finalizeSegment() {
  const total = speechBuf.reduce((a, b) => a + b.length, 0);
  const buf = speechBuf;
  speechBuf = [];
  speaking = false;
  silenceMs = 0;
  if (total < SR * MIN_SEG_SEC) return; // too short to be speech

  dbgSeg++;
  const merged = new Float32Array(total);
  let o = 0;
  for (const c of buf) {
    merged.set(c, o);
    o += c.length;
  }
  api.transcribe(merged.buffer).then((r) => {
    lpSetStatus('Listening · last transcribe: ' + JSON.stringify(r && r.text));
    if (r && r.text) addTranscript(r.text);
  });
}

// Heard speech → accumulate into the transcript panel (NOT the input box).
// The user reviews it and clicks "Add to message" to move it into the composer.
function addTranscript(text) {
  const t = text.trim();
  if (!t) return;
  transcriptText += (transcriptText ? ' ' : '') + t;
  els.listenPanel.classList.remove('hidden'); // keep visible if a late result arrives
  renderListenPanel();
  if (settings.autoShowOnSpeech) api.show();
}

function onAudioStatus(status) {
  if (status === 'loading') els.listen.title = 'Loading transcriber…';
  else if (status === 'ready') updateListenUI();
  else if (status === 'crashed') {
    toast('Transcriber crashed (is mlx-whisper installed? run setup)');
    listening = false;
    cleanupAudio();
    updateListenUI();
  } else if (typeof status === 'string' && status.startsWith('error')) {
    toast(String(status));
  }
}

function updateListenUI() {
  els.listen.classList.toggle('active', listening);
  els.listen.title = listening
    ? 'Listening — click to stop'
    : 'Listen to call / system audio';
  // hide the panel only once we're stopped AND nothing is left to add
  if (!listening && !transcriptText.trim()) els.listenPanel.classList.add('hidden');
}

// ---- Voice dictation (mic -> chat input) ------------------------------------
const DICT_SILENCE_MS = 1200; // auto-stop after this much trailing silence
let dictating = false;
let dictCtx = null;
let dictProc = null;
let dictSrc = null;
let dictStream = null;
let dictBuf = [];
let dictSpoke = false;
let dictSilence = 0;

async function toggleDictation() {
  if (dictating) return stopDictation(true);
  return startDictation();
}

async function startDictation() {
  try {
    els.mic.classList.add('active');
    els.mic.classList.remove('busy');
    await api.audioStart(); // ensure whisper sidecar is up

    dictStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    dictCtx = new AudioContext({ sampleRate: SR });
    dictProc = dictCtx.createScriptProcessor(4096, 1, 1);
    dictSrc = dictCtx.createMediaStreamSource(dictStream);
    dictSrc.connect(dictProc);
    const mute = dictCtx.createGain();
    mute.gain.value = 0;
    dictProc.connect(mute);
    mute.connect(dictCtx.destination);

    dictBuf = [];
    dictSpoke = false;
    dictSilence = 0;
    dictProc.onaudioprocess = onDictAudio;
    dictating = true;
    toast('Speak now — pause when done');
  } catch (e) {
    await teardownDictation();
    els.mic.classList.remove('active', 'busy');
    const perm = await api.permStatus();
    if (perm.mic === 'denied') {
      await api.openPerm('mic');
      toast('Enable Microphone for Orbit in System Settings, then try again.');
    } else {
      toast('Mic error: ' + (e.message || e));
    }
  }
}

function onDictAudio(e) {
  const input = e.inputBuffer.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
  const rms = Math.sqrt(sum / input.length);
  const frameMs = (input.length / SR) * 1000;
  dictBuf.push(new Float32Array(input));
  if (rms > THRESH) {
    dictSpoke = true;
    dictSilence = 0;
  } else if (dictSpoke) {
    dictSilence += frameMs;
    if (dictSilence > DICT_SILENCE_MS) stopDictation(true);
  }
}

async function teardownDictation() {
  if (dictProc) {
    dictProc.onaudioprocess = null;
    dictProc.disconnect();
    dictProc = null;
  }
  if (dictSrc) {
    dictSrc.disconnect();
    dictSrc = null;
  }
  if (dictStream) {
    dictStream.getTracks().forEach((t) => t.stop());
    dictStream = null;
  }
  if (dictCtx) {
    try { await dictCtx.close(); } catch {}
    dictCtx = null;
  }
}

async function stopDictation(transcribe) {
  if (!dictating) return;
  dictating = false;
  const buf = dictBuf;
  const spoke = dictSpoke;
  dictBuf = [];
  await teardownDictation();
  els.mic.classList.remove('active');

  const total = buf.reduce((a, b) => a + b.length, 0);
  if (!transcribe || !spoke || total < SR * 0.3) {
    els.mic.classList.remove('busy');
    return;
  }
  const merged = new Float32Array(total);
  let o = 0;
  for (const c of buf) {
    merged.set(c, o);
    o += c.length;
  }
  els.mic.classList.add('busy');
  const r = await api.transcribe(merged.buffer);
  els.mic.classList.remove('busy');
  if (r && r.text) {
    els.input.value = (els.input.value ? els.input.value.trim() + ' ' : '') + r.text;
    autoGrow();
    els.input.focus();
  } else {
    toast("Didn't catch that — try again");
  }
}

// ---- Toast ------------------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2600);
}
