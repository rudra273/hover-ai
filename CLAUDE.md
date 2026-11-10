# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Orbit is

A transparent, always-on-top **local** AI copilot for macOS (Apple Silicon). It floats over every app, chats with local Ollama models, and can listen to system/call audio and transcribe it on-device with MLX Whisper. Everything stays on the machine — the model is plain HTTP to `localhost:11434`, transcription is a local Python process.

There is no build step and no framework: the renderer is vanilla HTML/CSS/JS loaded directly via `loadFile`. There are no tests and no linter configured.

## Commands

```bash
# One-time: create .venv and install the transcription deps (mlx-whisper, numpy)
./setup.sh

# Run the dev build (DevTools detached)
npm run dev          # electron . --dev
npm start            # electron .

# Build the signed Orbit.app bundle into /Applications (see "Packaging" below)
./package-app.sh
```

### Critical launch gotcha
`require('electron')` returns a **string path instead of the module** when `ELECTRON_RUN_AS_NODE=1` leaks from the parent environment — this breaks `ipcMain.handle` with a cryptic `Cannot read properties of undefined`. Always launch with these unset:

```bash
env -u ELECTRON_RUN_AS_NODE -u ELECTRON_NO_ATTACH_CONSOLE open "/Applications/Orbit.app"
```

## Architecture

Three processes, talking over two channels:

```
renderer (app.js)  ──IPC──>  main (main.js)  ──HTTP──>  Ollama (localhost:11434)
                                     │
                                     └──stdin/stdout JSON──>  Python sidecar (transcribe.py)
```

- **`electron/main.js`** — the only privileged process. Owns the window, global hotkeys, the Ollama bridge, the sidecar lifecycle, and all IPC handlers. The renderer touches nothing native directly.
- **`electron/preload.js`** — the entire renderer↔main API surface, exposed as `window.orbit` via `contextBridge`. Any new renderer capability needs a method here **and** a matching `ipcMain.handle` in main.js.
- **`renderer/app.js`** — all UI logic in one file: chat rendering + streaming, the markdown renderer, skills, the history sidebar, audio listening, and mic dictation. State lives in module-level `let`s (`history`, `currentChatId`, `settings`, etc.).
- **`electron/store.js`** — dependency-free JSON persistence. **Two separate files** in `app.getPath('userData')`: `orbit-settings.json` (settings, skills) and `orbit-chats.json` (chat history). Chats are split out so chat writes never rewrite the settings blob. `set()` merges over `DEFAULTS`, so adding a new default key is automatically picked up by existing installs.
- **`sidecar/transcribe.py`** — long-running process. Loads an MLX Whisper model once, then reads `{id, path}` lines on stdin (path points to a temp file of raw float32 mono 16kHz PCM) and writes `{type, ...}` JSON lines on stdout. `{type:"log","msg":"ready"}` signals the model is warm.

### Streaming chat flow
`chat:send` (main.js) POSTs to Ollama with `stream:true`, reads the NDJSON response, and forwards each chunk to the renderer as separate events: `chat:thinking`, `chat:token`, `chat:done`, plus `chat:error`/`chat:warn`. The renderer accumulates tokens into the current assistant bubble. `chat:stop` aborts via a stored `AbortController` (`activeChat`).

**The `think` parameter must be sent explicitly `true` OR `false`** — reasoning models (e.g. `gemma4:12b-mlx`) default to thinking ON when the flag is omitted, so omitting it does not disable reasoning. If a model rejects the param entirely, main.js retries once without it and emits `chat:warn`.

### System prompt + skills
The system message sent to Ollama is composed in the renderer (`composeSystemPrompt()`): the **base `systemPrompt` always applies**, and the active skill's prompt is appended beneath it as a labeled block. Skills are user-editable records (`{id, name, prompt}`) in settings; `activeSkill: ''` means General/none.

### Audio: two independent paths, same sidecar
Both feed float32 PCM to the sidecar via `audio:transcribe` but are separate engines in app.js:
- **Listen** (`startListen`) — captures **system audio** via `getDisplayMedia`; main.js's `setDisplayMediaRequestHandler` answers with `{audio:'loopback'}` (ScreenCaptureKit). Uses RMS-threshold VAD with a silence-hang timer to segment speech into the live transcript pane.
- **Dictation** (`startDictation`) — mic → chat input box; auto-stops after trailing silence.

Audio capture is attempted directly (no permission pre-check) — the attempt itself is what registers Orbit in the macOS Screen Recording / Microphone lists and triggers the prompt. On failure, the renderer checks `perm:status` and opens the relevant System Settings pane via `perm:open`.

### Markdown rendering
`renderMarkdown()` in app.js is a hand-rolled, dependency-free parser used for **assistant messages only** (user messages stay plain text). It escapes HTML first, then applies a markdown subset. Note: because escaping runs first, block rules match the **escaped** form (e.g. blockquotes match `&gt;`, not `>`). Rendered links are opened in the default browser by main.js's `will-navigate` / `setWindowOpenHandler` guards — never in-app.

## Packaging & macOS permissions (the part that bites)

The dev binary (`npm start`) **cannot obtain Screen Recording permission**, so system-audio capture only works from a real app bundle. `./package-app.sh` builds `/Applications/Orbit.app`:

- The app code is **symlinked**, not copied, into the bundle (`Contents/Resources/app`). `codesign` seals the symlinks, not their targets — so editing JS/CSS/HTML afterward keeps the bundle's cdhash stable, and **macOS keeps the granted permissions across code changes**. After most edits you only need to relaunch; no rebuild, no re-grant.
- Re-running `package-app.sh` changes the cdhash and **drops the TCC grant** — avoid unless you changed `Info.plist` or the Electron binary.
- Required `Info.plist` key `NSAudioCaptureUsageDescription` is mandatory for loopback audio on macOS 14.2+ (without it, capture silently dies). `NSMicrophoneUsageDescription` is needed for mic/dictation. Bundle id is `com.orbit.copilot`.
- To clear a stuck permission state during bundle changes: `tccutil reset ScreenCapture com.orbit.copilot`.

## Known sharp edge

`sidecarPython()` / `sidecarScript()` in main.js contain a **hardcoded fallback path** (`/Users/rudra/projects/orbit/...`) so the packaged app can find the repo's `.venv` and sidecar script. This makes the bundle non-portable to other machines/checkouts. Override at runtime with the `ORBIT_PYTHON` env var, or update these paths if the repo moves.
