<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/grok-mark-white.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/grok-mark-black.svg">
    <img alt="Grok" src="docs/grok-mark-black.svg" width="96">
  </picture>
  <br>
  Grok Build Desktop (<code>not official</code>)
</h1>

Grok Build Desktop is a macOS app for [Grok Build](https://github.com/xai-org/grok-build).
Same Grok that lives in your terminal — chats, files, tools, and your history —
in a quiet window instead of a TUI.

This is not an official SpaceXAI or xAI app. It is an independent desktop shell.

[Get started](#get-started) ·
[What you get](#what-you-get) ·
[Computer use](#computer-use) ·
[Settings](#settings) ·
[Thanks](#thanks)

![Home](docs/screenshots/home.jpg)

![Chat](docs/screenshots/chat.jpg)

Grok Build is at [x.ai/cli](https://x.ai/cli)

This app is a desktop shell around the `grok` you already installed and signed in.

</div>

---

## Get started

1. Install and sign in to [Grok Build](https://x.ai/cli) (`grok`) on this Mac.
2. Download the DMG from [Releases](https://github.com/oleyyu/grok-build-desktop/releases) (Apple silicon or Intel), open it, drag the app to Applications.
3. First open: right-click the app → Open (it is unsigned). macOS may warn that the developer is unidentified.

From source: double-click `启动 Grok Build.command` in this folder. The first launch downloads the desktop runtime into a local cache.

You need macOS and a logged-in Grok account. Chats in the sidebar are the same sessions as `~/.grok/sessions` — pick up in the app what you started in the terminal, and the other way around.

## What you get

- A home screen with one input. Pick a folder and a prompt style, then start chatting.
- The same models and effort levels as Grok (including Grok 4.6).
- Permission modes: ask every time, auto-allow reads, or full access.
- Slash commands (`/` in the box) — compact, usage, and the rest of Grok’s command set.
- Paste images into a message.
- Usage and activity in Settings.
- A button to open the real Grok terminal on the current chat if you want the TUI back.

## Computer use

In Settings → Permissions, turn on Computer use. Grok can then see the screen, move the mouse, and type — useful for clicking through a UI it just built.

You must grant Screen Recording and Accessibility to whatever launched the app (usually Terminal). Use Grok 4.6; leave it off when you don’t need it.

## Settings

Theme, language, profile, usage, account, and providers live in the gear. App preferences are in `home/settings.yaml`. Keys go in `home/.credentials.yaml` (not in the yaml you sync or screenshot). Official Grok login stays in `~/.grok` — this app does not store that token.

Add your own prompt files as `.md` in `home/prompts/`. The first `# heading` is the name in the menu.

## Thanks

Special thanks to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and [Grok Build](https://github.com/xai-org/grok-build) (`grok`, SpaceXAI official) for opening their work on GitHub. This desktop app stands on that movement.
