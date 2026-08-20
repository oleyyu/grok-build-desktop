# <img src="renderer/assets/grok-mark.svg" alt="" width="36" height="36" />
Grok Build Desktop

**Grok Build Desktop** is a macOS app for [Grok Build](https://github.com/xai-org/grok-build). Same Grok agent you use in the terminal — chats, files, tools, and your history — in a quiet dark window instead of a TUI.

[Get started](#get-started) · [What you get](#what-you-get) · [Computer use](#computer-use) · [Settings](#settings)

[![Home](docs/screenshots/home.jpg)](docs/screenshots/home.jpg)

[![Chat](docs/screenshots/chat.jpg)](docs/screenshots/chat.jpg)

Grok Build itself lives at [x.ai/cli](https://x.ai/cli). This app is a desktop shell around the Grok you already installed.

---

## Get started

1. Install and sign in to [Grok Build](https://x.ai/cli) (`grok`) on this Mac.
2. Double-click **启动 Grok Build.command** in this folder.
3. The first launch downloads the desktop runtime (kept in a local cache, not in this folder). Close that terminal window to quit the app.

You need macOS and a logged-in Grok account. Chats in the sidebar are the same sessions as `~/.grok/sessions` — pick up in the app what you started in the terminal, and the other way around.

## What you get

- A home screen with one input. Pick a folder and a prompt style, then start chatting.
- The same models and effort levels as Grok (including Grok 4.6).
- Permission modes: ask every time, auto-allow reads, or full access.
- Slash commands (`/` in the box) — compact, usage, and the rest of Grok’s command set.
- Paste images into a message.
- Usage and activity in **Settings**.
- A button to open the real Grok terminal on the current chat if you want the TUI back.

## Computer use

In **Settings → Permissions**, turn on **Computer use**. Grok can then see the screen, move the mouse, and type — useful for clicking through a UI it just built.

You must grant **Screen Recording** and **Accessibility** to whatever launched the app (usually Terminal). Use Grok 4.6; leave it off when you don’t need it.

## Settings

Theme, language, profile, usage, account, and providers live in the gear. App preferences are in `home/settings.yaml`. Keys go in `home/.credentials.yaml` (not in the yaml you sync or screenshot). Official Grok login stays in `~/.grok` — this app does not store that token.

Add your own prompt files as `.md` in `home/prompts/`. The first `# heading` is the name in the menu.

## Learn more

- [Grok Build](https://github.com/xai-org/grok-build)
- [docs.x.ai/build](https://docs.x.ai/build/overview)
- `读我.txt` in this folder (Chinese)
