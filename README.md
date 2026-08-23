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
[Thanks](#thanks) ·
[License](#license)

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
- While a turn is running, the Mac stays awake so Grok can keep going with the display dimmed, locked, or off. Menu: Energy → Turn Display Off. Closing the lid or Sleep still pauses the machine.

## Computer use

In Settings → Permissions, turn on Computer use. Grok can then see a window on your screen and click and type in it — useful for clicking through a UI it just built.

You must grant Screen Recording and Accessibility to whatever launched the app (usually Terminal). Use Grok 4.6; leave it off when you don’t need it.

While Grok is controlling the Mac, a **“Grok is working on your Mac.”** banner floats at the top of the screen (visible on every desktop, but never inside Grok’s own screenshots).

### Independent pointer (default)

Grok gets its own pointer — a purple “Grok” arrow drawn over the screen, separate from your cursor. It works on one window at a time: it screenshots that window (not your whole screen) and clicks through macOS’s accessibility layer, so your real cursor never moves, your keystrokes still go where you are typing, and your desktops stay yours. Switching desktops — or switching back to watch — does not pause it. It never sees or touches anything outside its target window, and it cannot target the Grok Build window itself.

Grok prefers a window that is visible on your current desktop; if there is none it falls back to another window it can capture. It raises the chosen window and parks the purple pointer on it, so you can see where it is working. It can switch targets with its `target_window` tool (“work on Safari instead”).

Rather than reading coordinates off a screenshot, Grok can ask the window for a numbered list of what it can actually operate — every button, checkbox, field and link — and press one by number. Controls are found by their place in the window, not by pixel position, so a window that moved or scrolled between looking and clicking no longer causes a misplaced click; if the interface changed underneath, Grok is told to read the list again instead. It will not press a control that closes or minimises the window it is working through.

Clicks prefer the accessibility layer, which reports back what was actually pressed. When a point has no accessibility control — a canvas-painted UI, a game, a chart — Grok falls back to a real mouse event addressed to that window, so those surfaces are clickable too. Dragging and scrolling always use real mouse events. None of this moves your cursor.

What this mode cannot do:

- No right-click menus — a native context menu would open on whichever desktop you happen to be looking at instead of inside the target window, so Grok declines to open one.
- A fallback click or a drag cannot be confirmed. macOS lets a window ignore mouse buttons while its app is inactive (`acceptsFirstMouse`), and nothing reports back whether it did. Standard controls accept them; some canvas and slider controls silently do not. Grok is told to screenshot and check rather than assume it worked.

Scrolling is the one input a background window always accepts, so it is reliable everywhere.

A window only exposes an accessibility tree while it is on the desktop you are looking at — step into a full-screen app and every window on the desktop you left goes quiet. Mouse and keyboard still reach them, so Grok keeps working in a reduced mode: it screenshots and clicks as usual, but cannot list controls or confirm what it pressed, and it says so. Come back to that desktop and the control list returns on its own. Grok only falls back to sharing your cursor when it cannot even capture a window.

Set `engine.cuGhost: false` in `home/settings.yaml` to always use the shared-cursor mode below (that is the mode to use if you need right-click menus, or a drag that is guaranteed to land).

### Shared-cursor fallback

With `engine.cuGhost: false`, or when no window on your desktop can be driven through accessibility, Grok uses the real cursor on the whole screen — the same mouse you are holding — and is then locked to the desktop (Space) it started on:

- In always-approve mode it creates a second desktop for you (and notifies you) — press ⌃→ to go do your own thing there. The app window hides itself so it stays out of screenshots and clicks; it comes back when the turn ends.
- The moment you switch away, Grok pauses (even mid-typing) and the banner flips to “paused”; switch back and it resumes. It never screenshots or clicks the desktop you are on.
- In ask / auto-safe mode the app stays visible (you need the permission cards) and no desktop is created — but the switch-away pause still protects you.

If you are here because nothing on your desktop could be driven, you can still name a window — `target_window(app="Safari")` — and if that one does expose accessibility controls, Grok moves to the independent pointer from then on. With `engine.cuGhost: false` the independent pointer is off for the whole session, and `target_window` only tells Grok which mode it is in.

Set `engine.cuHideApp: false` in `home/settings.yaml` if you *want* the Grok Build window to stay visible and be fair game for Grok in this mode (with the independent pointer, this app’s own windows are off limits either way). Desktop detection uses a private macOS API; if a future macOS removes it, everything degrades gracefully (banner still shows, guard turns off with a warning notification).

## Settings

Theme, language, profile, usage, account, and providers live in the gear. App preferences are in `home/settings.yaml`. Keys go in `~/Library/Application Support/Grok Build Desktop/.credentials.yaml` (mode 0600) — deliberately outside the `home/` folder you sync or screenshot; an existing `home/.credentials.yaml` is moved there for you on first read. Official Grok login stays in `~/.grok` for the *active* account. Settings → Account can sign in more than one Grok account; plan usage is the combined pool, and the app switches to the next account when the current one hits its limit. Extra account tokens stay in the app’s user-data folder (mode 0600), not in `home/`.

Settings → General → “Keep working when the display sleeps” (on by default) takes a macOS idle-sleep assertion only while Grok is generating. The display is still allowed to sleep. `/display-off` blanks the screen immediately.

Add your own prompt files as `.md` in `home/prompts/`. The first `# heading` is the name in the menu.

## Thanks

Special thanks to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and [Grok Build](https://github.com/xai-org/grok-build) (`grok`, SpaceXAI official) for opening their work on GitHub. This desktop app stands on that movement.

## License

[MIT](LICENSE). Copyright (c) 2026 Oley Yu.
