# CLAUDE.md

This file gives guidance to Claude Code (claude.ai/code) when working in this repository.

## Overview

A lightweight **Electron wrapper** that runs **Facebook Messenger** (`https://www.facebook.com/messages`) as a standalone desktop app on Windows. There is no custom web UI — the app loads the real Messenger site inside a `BrowserView` and adds native-feeling behavior around it (banner hiding, link handling, in-app media dialogs, taskbar flashing).

UI strings shown to the user (context menu labels, dialog hints) are in **Hungarian**. Keep new user-facing strings in Hungarian to match.

## Commands

```bash
npm install      # install dependencies
npm start        # run the app (electron .)
npm run build    # build the Windows NSIS installer via electron-builder
```

The installer is generated at `dist/Messenger Setup <version>.exe`. There is no test suite, linter, or typecheck configured — verify changes by running `npm start`.

## Architecture

Three source files, all at the repo root:

- **`main.js`** — the Electron main process. Owns the `BrowserWindow`, the Messenger `BrowserView` (`view`), and the on-demand media-dialog `BrowserView` (`videoView`). Handles navigation interception, window-state persistence, the context menu, single-instance lock, and startup cache clearing.
- **`preload.js`** — injected into the Messenger view (`contextIsolation: false`). Intercepts in-page clicks and `contextmenu` events that never reach the main process (Facebook is a SPA), forwarding them over IPC.
- **`package.json`** — `electron-builder` config lives under the `build` key (`appId: com.datamagic.messenger`, NSIS one-click per-user installer).

### Key mechanisms

- **Banner hiding:** the Messenger `BrowserView` is offset upward by `BANNER_HEIGHT` (58px) via a negative Y in `setBounds` (`updateViewBounds`), cropping Facebook's top navigation banner out of view. Because of this offset, "top of the window" is at `BANNER_HEIGHT` in page coordinates — relevant when positioning injected overlays.
- **Link routing:** clicks/navigations are classified by URL. Video (`isVideoUrl`) and photo (`isPhotoUrl`) links open in an in-app dialog (`openVideoWindow`); everything else opens in the system browser via `shell.openExternal`. Facebook wraps outbound links in a shim (`l.facebook.com/l.php?u=...`) — always run URLs through `unwrapLinkShim` before classifying.
- **Media dialog:** `videoView` is a second `BrowserView` centered over the window with a dimmed backdrop (`BACKDROP_JS` injected into the main view). Closed via Esc, backdrop click, or navigation away. Vertical media (reels, `/share/r/`) uses a taller portrait size.
- **Click interception (preload):** Facebook renders media links in-page without a navigation event, so `preload.js` catches clicks in the capture phase, unwraps the shim, and sends `open-media-dialog` over IPC. `main.js` has additional safety nets on `will-navigate`, `did-navigate-in-page`, and `did-start-navigation`.
- **Navigation guard:** `will-navigate` only permits Messenger pages, `messenger.com`, and Facebook auth flows (`/login`, `/checkpoint`, `/two_step_verification`, `/recover`, `/cookie`, `/logout`, `/`). Anything else is prevented and rerouted to the browser or media dialog.
- **Window state:** position/size/maximized state is persisted with `electron-store` (`windowBounds`, `isMaximized`) and restored on launch, with a guard that discards positions no longer on a connected display.
- **Unread flashing:** `page-title-updated` parses the unread count Messenger prefixes onto the title (e.g. `"(2) Messenger"`); a new unread message while the window is unfocused triggers `flashFrame(true)`, cleared on focus.
- **Single instance + cache:** a second instance corrupts the shared profile cache, so `requestSingleInstanceLock` focuses the existing window instead. On startup the app clears caches (`clearCache` / `clearCodeCaches`) but keeps cookies, so the user stays logged in.

### IPC channels (renderer → main)

- `open-media-dialog` — open the in-app media dialog for a URL
- `close-video-overlay` — close the media dialog
- `open-video-in-browser` — close the media dialog and open its current URL in the system browser
- `show-context-menu` — build and show the native right-click menu (open/copy link, open/copy image, edit roles, and always a "Kijelentkezes" logout that clears session storage and reloads Messenger)

## Conventions

- Plain CommonJS (`require`), no build step or transpilation for the app code.
- Keep everything URL-classification-related going through `unwrapLinkShim` first.
- New user-facing labels in Hungarian.
- Bump `version` in `package.json` when releasing; commits historically pair the version bump with the feature (see git log).
