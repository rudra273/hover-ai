# 🛰️ Orbit

A transparent, always-on-top **local-first** AI copilot for macOS. Floats over every app,
chats with your local Ollama models (or cloud models via API), and can listen to your
call/system audio and transcribe it on-device with MLX Whisper. Nothing leaves your machine
unless you choose a cloud provider.

## Requirements
- macOS on Apple Silicon
- **Node.js 18+** and **Python 3.10+** (3.12 recommended)
- [Ollama](https://ollama.com) for the local model (optional if you only use cloud providers)

## Quick start

Orbit ships with a small CLI that handles everything:

```bash
./orbit init     # check prereqs, create the venv, install deps, build the app
./orbit run      # launch Orbit
./orbit stop     # quit Orbit
```

That's it. `./orbit init` will:
- verify Python 3.10+ and Node 18+ are installed,
- create `.venv` and install the transcription deps (`mlx-whisper`, `numpy`),
- run `npm install` (Electron),
- build a signed `Orbit.app` into `/Applications`.

> **Tip:** symlink the CLI onto your `PATH` to call it from anywhere:
> ```bash
> ln -s "$(pwd)/orbit" /usr/local/bin/orbit
> # then: orbit init / orbit run / orbit stop / orbit restart
> ```

### First launch & permissions
On first use of **Listen**, macOS asks for **Screen Recording** (to capture system audio via
ScreenCaptureKit) and **Microphone** (for the mic). Grant them in
**System Settings → Privacy & Security**, then `./orbit run` again.

## Features
- **Overlay** — transparent, frameless, always-on-top, floats over all Spaces. Drag by the title bar; the green traffic light steps the width, yellow minimizes to a strip.
- **Chat** — streaming replies with full **markdown + syntax-highlighted code blocks** (per-block copy button). Hover any message to **copy**, **regenerate**, or **edit & resend**.
- **Providers** — **Local (Ollama)**, **Gemini**, and **OpenRouter** in one model dropdown. Cloud keys live in your app-data folder or env vars (`GEMINI_API_KEY` / `OPENROUTER_API_KEY`), never in the repo. Curate which cloud models show, with price tags.
- **Thinking ON/OFF** — toggles the model's reasoning (auto-handles models that force it on).
- **Skills** — selectable modes (Coding, Interview, Research, Writing, + your own) layered on top of your base system prompt.
- **Chat history** — a toggleable sidebar with saved conversations and a new-chat button.
- **Listen** — captures system/call audio (or mic), transcribes live with MLX Whisper into a review panel; **Add to message** drops it into the composer.
- **Mic dictation** — speak directly into the message box.
- **Settings** — model/provider, temperature, system prompt, skills, whisper model, audio source, stealth (hide from screen-share), opacity, theme, Ollama host, hotkey rebinding.
- **Restart** — a one-click in-app fresh restart.

## API keys (cloud providers)
Resolution order is **stored key → environment variable**, so you can stay env-var style:
```bash
cp .env.example .env     # then fill in keys (this file is git-ignored)
```
or paste keys in **Settings → Providers**. `.env`, `orbit-settings.json`, and
`orbit-chats.json` are all git-ignored — secrets and chats never enter the repo.

## Hotkeys (default, rebind in Settings)
- `⌘⇧Space` — show / hide
- `⌘⇧K` — focus input
- `⌘⇧⌫` — new chat

## How it works
- **Electron** shell (`electron/`) owns the window, hotkeys, the provider bridge, and the sidecar.
- **Vanilla JS renderer** (`renderer/`) — chat UI, markdown, skills, history, audio.
- **Python sidecar** (`sidecar/transcribe.py`) — long-running MLX Whisper process, fed 16 kHz PCM over stdin/stdout JSON.
- The app bundle **symlinks** to this repo, so editing code only needs `./orbit run` again — macOS keeps your granted permissions across code changes (no re-grant).

## Notes
- First time you press Listen, the Whisper model downloads (~150 MB for `base`).
- The local model is plain HTTP to `localhost:11434` — no API keys, fully offline.
- Re-running `./orbit init` (or `./package-app.sh`) rebuilds the bundle; that changes its signature and may reset Screen Recording permission once.
