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

Source files, all at the repo root:

- **`main.js`** — the Electron main process. Owns the `BrowserWindow`, the Messenger `BrowserView` (`view`), and the on-demand media-dialog `BrowserView` (`videoView`). Handles navigation interception, window-state persistence, the context menu, single-instance lock, and startup cache clearing.
- **`preload.js`** — injected into the Messenger view (`contextIsolation: false`). Intercepts in-page clicks and `contextmenu` events that never reach the main process (Facebook is a SPA), forwarding them over IPC.
- **`viewer.html` / `viewer-preload.js`** — the in-app image viewer (zoom, pan, save, copy) and its `contextBridge` IPC bridge.
- **`loading.html`** — loading screen shown until the Messenger UI is ready.
- **`package.json`** — `electron-builder` config lives under the `build` key (`appId: com.datamagic.messenger`, NSIS one-click per-user installer).

### Key mechanisms

- **Banner hiding:** the Messenger `BrowserView` is offset upward by `BANNER_HEIGHT` (58px) via a negative Y in `setBounds` (`updateViewBounds`), cropping Facebook's top navigation banner out of view. Because of this offset, "top of the window" is at `BANNER_HEIGHT` in page coordinates — relevant when positioning injected overlays.
- **Link routing:** clicks/navigations are classified by URL. Video (`isVideoUrl`) and photo (`isPhotoUrl`) links open in an in-app dialog (`openVideoWindow`); everything else opens in the system browser via `shell.openExternal`. Facebook wraps outbound links in a shim (`l.facebook.com/l.php?u=...`) — always run URLs through `unwrapLinkShim` before classifying.
- **Media dialog:** `videoView` is a second `BrowserView` centered over the window with a dimmed backdrop (`BACKDROP_JS` injected into the main view). Closed via Esc, backdrop click, or navigation away. Vertical media (reels, `/share/r/`) uses a taller portrait size.
- **Image viewer:** photo links (`/messenger_media`, `/photo`, direct image files — `isImageViewerUrl`) open in the app's own viewer (`viewer.html` + `viewer-preload.js`, a full-window `BrowserView` `imageView`) instead of Facebook's slow photo page. The clicked chat thumbnail (passed from `preload.js`; `blob:` URLs of encrypted chats converted to `data:`) is shown immediately, fitted to the window the same way the full image will be, while a hidden `BrowserWindow` (`createResolver`) loads the Facebook viewer page and polls it (`FIND_IMAGE_JS`) for the largest `fbcdn.net` image; the viewer swaps to it at the same on-screen rectangle when the aspect ratio matches, so the picture only sharpens (cached per page URL in `hiResCache`). **Paging:** on click `preload.js` collects every photo link of the open conversation (`[role="main"]`, DOM order) and sends them as a gallery (`open-photo-gallery`); the viewer pages with ←/→ and arrow buttons (`viewer:navigate` → `showGalleryItem`), and the neighbouring photo in the paging direction is resolved in advance (`prefetch`, taken over if the user pages to it). The clicked item being a video, or a failed lookup with no thumbnail, falls back to the media dialog; a video reached by paging shows a play button (`viewer:play-video`). `openMedia` routes between the image viewer and `openVideoWindow`.
- **In-app video player:** video links (`isVideoUrl` — reels, `/share/r/`, `/watch`, `fb.watch`, ...) also open in the viewer as a single `video: true` item. `resolveVideo` fetches the page HTML both with `session.defaultSession` (cookies, friends-only videos) and in parallel with a cookie-less in-memory session (`video-anon`; logged-in users may get a client-rendered page without the links), the logged-in hit winning, and pulls the direct progressive MP4 link out of it (`findVideoSource`: `browser_native_hd_url` > `playable_url_quality_hd` > `browser_native_sd_url` > `playable_url`, on `fbcdn.net`), plus `og:image` as the poster; cached for 30 min (`videoCache`, the links expire). The viewer plays it in a plain `<video>` (Space/K play-pause, ←/→ seek 5 s, M mute; Save downloads the MP4, Copy link / Open in browser use the Facebook page URL). No link found or a `<video>` error (`viewer:video-error`) falls back to the media dialog. Lookups and playback errors are logged to `<userData>/video-debug.log`. **Prefetch:** `preload.js` watches the open conversation (`[role="main"]`, `MutationObserver`) and hovered links for video links and reports them (`prefetch-videos`); `main.js` resolves them in the background (`queueVideoPrefetch`, 2 at a time, newest first, failed lookups not re-prefetched for 10 min), and concurrent lookups of the same page share one promise (`videoPending`), so a click usually finds the MP4 link already cached.
- **Click interception (preload):** Facebook renders media links in-page without a navigation event, so `preload.js` catches clicks in the capture phase, unwraps the shim, and sends `open-media-dialog` (or `open-photo-gallery` for chat photos) over IPC. `main.js` has additional safety nets on `will-navigate`, `did-navigate-in-page`, and `did-start-navigation`.
- **Navigation guard:** `will-navigate` only permits Messenger pages, `messenger.com`, and Facebook auth flows (`/login`, `/checkpoint`, `/two_step_verification`, `/recover`, `/cookie`, `/logout`, `/`). Anything else is prevented and rerouted to the browser or media dialog.
- **Window state:** position/size/maximized state is persisted with `electron-store` (`windowBounds`, `isMaximized`) and restored on launch, with a guard that discards positions no longer on a connected display.
- **Unread flashing:** `page-title-updated` parses the unread count Messenger prefixes onto the title (e.g. `"(2) Messenger"`); a new unread message while the window is unfocused triggers `flashFrame(true)`, cleared on focus.
- **Single instance + cache:** a second instance corrupts the shared profile cache, so `requestSingleInstanceLock` focuses the existing window instead. On startup the app clears caches (`clearCache` / `clearCodeCaches`) but keeps cookies, so the user stays logged in.

### IPC channels (renderer → main)

- `open-media-dialog` — open a media URL in the image viewer or media dialog (optional 2nd arg: chat thumbnail URL)
- `open-photo-gallery` — open the image viewer on a chat photo: `(items: [{ url, thumb }], index)`
- `prefetch-videos` — video link URLs seen in the open chat (or hovered), to be resolved in the background: `(urls: string[])`, newest last
- `photo-gallery-thumb` — late `data:` thumbnail for a gallery item (`blob:` thumbnails of encrypted chats are converted after opening)
- `close-video-overlay` — close the media dialog
- `open-video-in-browser` — close the media dialog and open its current URL in the system browser
- `viewer:*` — from the image viewer page: `shown`, `navigate`, `play-video`, `video-error`, `close`, `open-browser`, `copy-link`, `save`, `copy-image`, `context-menu`
- `show-context-menu` — build and show the native right-click menu (open/copy link, open/copy image, edit roles, and always a "Kijelentkezes" logout that clears session storage and reloads Messenger)

## Conventions

- Plain CommonJS (`require`), no build step or transpilation for the app code.
- Keep everything URL-classification-related going through `unwrapLinkShim` first.
- New user-facing labels in Hungarian.
- Bump `version` in `package.json` when releasing; commits historically pair the version bump with the feature (see git log).
