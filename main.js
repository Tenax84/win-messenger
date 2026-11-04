const { app, BrowserWindow, BrowserView, screen, shell, ipcMain, Menu, session, clipboard } = require('electron');
const path = require('path');
const Store = require('electron-store').default;

const BANNER_HEIGHT = 58;

const store = new Store({
  defaults: {
    windowBounds: { x: undefined, y: undefined, width: 1024, height: 768 },
    isMaximized: false,
    cleanExit: true,
  },
});

let mainWindow;
let view;
let videoView;
let videoViewVertical = false;
let lastUnreadCount = 0;

// Facebook may serve some pages (e.g. logged-in reels) as a blank white page to
// non-Chrome user agents - drop the "Electron/x" token so it looks like Chrome
const CHROME_UA = (ua) => ua.replace(/\s(Electron|messenger)\/\S+/gi, '');

// Links in chat messages go through Facebook's link shim
// (l.facebook.com/l.php?u=<target>) - unwrap to get the real destination
function unwrapLinkShim(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('facebook.com') && parsed.pathname === '/l.php') {
      const target = parsed.searchParams.get('u');
      if (target) return target;
    }
  } catch {}
  return url;
}

function isVideoUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'fb.watch') return true;
    if (!parsed.hostname.endsWith('facebook.com')) return false;
    return (
      parsed.pathname.startsWith('/share/r/') ||
      parsed.pathname.startsWith('/share/v/') ||
      parsed.pathname.startsWith('/reel') ||
      parsed.pathname.startsWith('/watch') ||
      parsed.pathname.startsWith('/video.php') ||
      /^\/[^/]+\/videos\//.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function isPhotoUrl(url) {
  try {
    const parsed = new URL(url);
    // direct image file links (any host)
    if (/\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(parsed.pathname)) return true;
    if (!parsed.hostname.endsWith('facebook.com')) return false;
    return (
      parsed.pathname.startsWith('/photo') ||
      parsed.pathname.startsWith('/messenger_media') ||
      parsed.pathname.startsWith('/share/p/') ||
      parsed.pathname.startsWith('/permalink.php') ||
      parsed.pathname.startsWith('/story.php') ||
      /^\/[^/]+\/photos\//.test(parsed.pathname) ||
      /^\/[^/]+\/posts\//.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

// A link that points straight at an image file, e.g. an fbcdn.net photo
function isDirectImageUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      /\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

// Photos shown in the in-app image viewer instead of Facebook's (slow) photo
// viewer page: chat attachments, photo pages and direct image links
function isImageViewerUrl(url) {
  if (isDirectImageUrl(url)) return true;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('facebook.com')) return false;
    return parsed.pathname.startsWith('/messenger_media') || parsed.pathname.startsWith('/photo');
  } catch {
    return false;
  }
}

function isVerticalVideoUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.startsWith('/share/r/') || parsed.pathname.startsWith('/reel');
  } catch {
    return false;
  }
}

function updateVideoViewBounds() {
  if (!mainWindow || !videoView) return;
  const [winW, winH] = mainWindow.getContentSize();
  const margin = 40;
  const size = videoViewVertical
    ? { width: Math.min(920, winW - margin), height: Math.min(820, winH - margin) }
    : { width: Math.min(1280, winW - margin), height: Math.min(720, winH - margin) };
  videoView.setBounds({
    x: Math.round((winW - size.width) / 2),
    y: Math.round((winH - size.height) / 2),
    width: size.width,
    height: size.height,
  });
}

// The messenger view is shifted up by BANNER_HEIGHT, so "top of the window"
// is at BANNER_HEIGHT in page coordinates.
const BACKDROP_JS = `
(() => {
  if (document.getElementById('__videoOverlayBackdrop')) return;
  const d = document.createElement('div');
  d.id = '__videoOverlayBackdrop';
  d.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:2147483647;cursor:pointer;';
  const c = document.createElement('div');
  c.textContent = '\\u2715';
  c.title = 'Bezaras (Esc)';
  c.style.cssText = 'position:fixed;top:${BANNER_HEIGHT + 12}px;right:18px;font-size:26px;line-height:1;color:#fff;font-family:sans-serif;';
  d.appendChild(c);
  const b = document.createElement('div');
  b.textContent = 'Megnyitas bongeszoben';
  b.style.cssText = 'position:fixed;top:${BANNER_HEIGHT + 16}px;right:60px;font-size:15px;color:#fff;font-family:sans-serif;text-decoration:underline;';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    window.__openVideoInBrowser && window.__openVideoInBrowser();
  });
  d.appendChild(b);
  d.addEventListener('click', () => window.__closeVideoOverlay && window.__closeVideoOverlay());
  document.body.appendChild(d);
})();
`;

function closeVideoOverlay() {
  if (!videoView) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.removeBrowserView(videoView);
  }
  videoView.webContents.destroy();
  videoView = null;
  if (view && !view.webContents.isDestroyed()) {
    view.webContents
      .executeJavaScript(`document.getElementById('__videoOverlayBackdrop')?.remove();`)
      .catch(() => {});
    view.webContents.focus();
  }
}

function openVideoWindow(url) {
  if (!mainWindow || !view) return;
  closeImageViewer();
  videoViewVertical = isVerticalVideoUrl(url);

  if (!videoView) {
    videoView = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    videoView.setBackgroundColor('#000000');
    videoView.webContents.setUserAgent(CHROME_UA(videoView.webContents.getUserAgent()));

    // If the media page can't be shown, fall back to the default browser
    const fallbackToBrowser = () => {
      if (!videoView) return;
      const current = videoView.webContents.getURL() || url;
      setImmediate(closeVideoOverlay);
      shell.openExternal(current);
    };
    videoView.webContents.on('render-process-gone', (event, details) => {
      // 'killed' / 'clean-exit' happen when the dialog itself is closed
      if (details.reason !== 'killed' && details.reason !== 'clean-exit') fallbackToBrowser();
    });
    videoView.webContents.on('did-fail-load', (event, code, desc, failedUrl, isMainFrame) => {
      // -3 = ERR_ABORTED (redirects, cancelled loads) is not a real failure
      if (isMainFrame && code !== -3) fallbackToBrowser();
    });

    // Links opened from the video dialog go to the default browser
    videoView.webContents.setWindowOpenHandler(({ url: childUrl }) => {
      shell.openExternal(childUrl);
      return { action: 'deny' };
    });

    // Esc closes the dialog
    videoView.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        closeVideoOverlay();
      }
    });

    mainWindow.addBrowserView(videoView);
  }

  view.webContents.executeJavaScript(BACKDROP_JS).catch(() => {});
  updateVideoViewBounds();
  videoView.webContents.loadURL(url);
  videoView.webContents.focus();
}

// ---------------------------------------------------------------------------
// In-app image viewer
//
// Facebook's photo viewer (/messenger_media, /photo) is slow, so photos are
// shown in our own viewer (viewer.html) instead. It shows the chat thumbnail
// right away, while a hidden window loads Facebook's viewer page just to read
// the full resolution fbcdn.net image URL out of it; once found, the viewer
// swaps the thumbnail for it.
// ---------------------------------------------------------------------------

let imageView = null;
// The photos of the chat the viewer pages through: [{ url, thumb }]
let gallery = null; // { items, index }
let current = null; // { item, shownUrl, resolver, initial }
let prefetch = null; // resolver looking up a neighbouring photo in advance
let lastDir = 1; // paging direction, the next photo that way is prefetched
const hiResCache = new Map(); // viewer page URL -> full resolution image URL
const videoPages = new Set(); // viewer page URLs that turned out to be videos
const HIRES_TIMEOUT_MS = 20000;
const HIRES_SETTLE_MS = 1500;

// Runs in the hidden Facebook viewer page: the largest fbcdn image is the photo
// (profile pictures and icons are small). Reports videos so they can go to
// the regular media dialog instead.
const FIND_IMAGE_JS = `
(() => {
  let best = null;
  for (const img of document.images) {
    const src = img.currentSrc || img.src;
    if (!/^https:\\/\\/[^/]*fbcdn\\.net\\//.test(src)) continue;
    const r = img.getBoundingClientRect();
    const area = img.naturalWidth ? img.naturalWidth * img.naturalHeight : r.width * r.height;
    if (area < 250 * 250) continue;
    if (!best || area > best.area) best = { src, area };
  }
  const video = !!document.querySelector('video');
  return { best, video };
})()
`;

function isHttpUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

// The best URL to hand to the browser / clipboard for the shown image
function viewerLinkUrl() {
  if (!current) return null;
  return isHttpUrl(current.shownUrl) ? current.shownUrl : current.item.url;
}

function sendToViewer(channel, ...args) {
  if (imageView && !imageView.webContents.isDestroyed()) {
    imageView.webContents.send(channel, ...args);
  }
}

function stopResolver(r) {
  if (!r || r.done) return;
  r.done = true;
  clearInterval(r.poll);
  clearTimeout(r.timeout);
  if (!r.win.isDestroyed()) r.win.destroy();
}

// Loads a Facebook photo page in a hidden window and reads the full resolution
// image URL out of it. handlers: onImage(src) for every better version found,
// onDone('found' | 'video' | 'failed'). The handlers can be swapped while it
// runs (a prefetch taken over by the viewer).
function createResolver(pageUrl, handlers) {
  const win = new BrowserWindow({
    show: false,
    width: 2048,
    height: 1536,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setUserAgent(CHROME_UA(win.webContents.getUserAgent()));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const r = { pageUrl, win, handlers, best: null, lastUpgrade: 0, done: false };

  const finish = (result) => {
    if (r.done) return;
    stopResolver(r);
    if (r.handlers.onDone) r.handlers.onDone(result);
  };

  r.poll = setInterval(async () => {
    if (r.done || win.isDestroyed()) return;
    let result;
    try {
      result = await win.webContents.executeJavaScript(FIND_IMAGE_JS);
    } catch {
      return;
    }
    if (r.done || !result) return;
    const { best, video } = result;
    if (video && !r.best) {
      videoPages.add(pageUrl);
      finish('video');
      return;
    }
    if (best && (!r.best || best.area > r.best.area)) {
      r.best = best;
      r.lastUpgrade = Date.now();
      hiResCache.set(pageUrl, best.src);
      if (r.handlers.onImage) r.handlers.onImage(best.src);
    }
    // Facebook may swap in a larger version shortly after the first one -
    // stop once the image hasn't changed for a while
    if (r.best && Date.now() - r.lastUpgrade > HIRES_SETTLE_MS) finish('found');
  }, 250);
  r.timeout = setTimeout(() => finish(r.best ? 'found' : 'failed'), HIRES_TIMEOUT_MS);

  win.webContents.on('did-fail-load', (event, code, desc, failedUrl, isMainFrame) => {
    if (isMainFrame && code !== -3) finish(r.best ? 'found' : 'failed');
  });

  win.loadURL(pageUrl);
  return r;
}

function stopPrefetch() {
  stopResolver(prefetch);
  prefetch = null;
}

// Look up a neighbouring photo (in the paging direction first) in advance, so
// paging to it shows the full resolution image right away. Only one runs at a
// time, and only while the current photo isn't being looked up.
function startPrefetch() {
  if (!gallery || !current || current.resolver || (prefetch && !prefetch.done)) return;
  for (const step of [lastDir, -lastDir]) {
    const item = gallery.items[gallery.index + step];
    if (!item || isDirectImageUrl(item.url) || hiResCache.has(item.url) || videoPages.has(item.url)) continue;
    const r = createResolver(item.url, {
      onDone: () => {
        if (prefetch !== r) return;
        prefetch = null;
        startPrefetch();
      },
    });
    prefetch = r;
    return;
  }
}

function openCurrentAsVideo() {
  if (!current) return;
  const url = current.item.url;
  closeImageViewer();
  openVideoWindow(url);
}

// The photo turned out to be a video: the clicked one plays in the media
// dialog right away, one reached by paging offers a play button instead
function handleVideo(state) {
  if (state.initial) openCurrentAsVideo();
  else sendToViewer('viewer:status', 'video');
}

function showGalleryItem(index, initial) {
  if (!gallery || !gallery.items[index]) return;
  if (current) stopResolver(current.resolver);
  gallery.index = index;
  const item = gallery.items[index];
  const url = item.url;
  const state = { item, shownUrl: null, resolver: null, initial };
  current = state;
  if (prefetch && prefetch.pageUrl !== url) stopPrefetch();

  sendToViewer('viewer:reset', { index, total: gallery.items.length });

  if (isDirectImageUrl(url)) {
    sendToViewer('viewer:image', url, 'full');
    startPrefetch();
    return;
  }
  if (videoPages.has(url)) {
    if (item.thumb) sendToViewer('viewer:image', item.thumb, 'preview');
    handleVideo(state);
    return;
  }

  const handlers = {
    onImage: (src) => {
      if (current === state) sendToViewer('viewer:image', src, 'full');
    },
    onDone: (result) => {
      if (current !== state) return;
      state.resolver = null;
      if (result === 'video') {
        handleVideo(state);
        return;
      }
      if (result === 'found') {
        sendToViewer('viewer:status', 'done');
      } else if (!item.thumb && state.initial) {
        // nothing to show at all - use Facebook's own viewer in the media dialog
        openCurrentAsVideo();
        return;
      } else {
        sendToViewer('viewer:status', 'failed');
      }
      startPrefetch();
    },
  };

  const cached = hiResCache.get(url);
  if (cached) sendToViewer('viewer:image', cached, 'full');
  else if (item.thumb) sendToViewer('viewer:image', item.thumb, 'preview');

  if (prefetch && prefetch.pageUrl === url && !prefetch.done) {
    // already being looked up in advance - take it over
    state.resolver = prefetch;
    prefetch = null;
    state.resolver.handlers = handlers;
    sendToViewer('viewer:status', 'loading');
  } else if (cached) {
    sendToViewer('viewer:status', 'done');
    startPrefetch();
  } else {
    sendToViewer('viewer:status', 'loading');
    state.resolver = createResolver(url, handlers);
  }
}

function closeImageViewer() {
  if (current) stopResolver(current.resolver);
  current = null;
  gallery = null;
  stopPrefetch();
  if (!imageView) return;
  const iv = imageView;
  imageView = null;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.removeBrowserView(iv);
  if (!iv.webContents.isDestroyed()) iv.webContents.destroy();
  if (view && !view.webContents.isDestroyed()) view.webContents.focus();
}

function updateImageViewBounds() {
  if (!mainWindow || !imageView) return;
  const [width, height] = mainWindow.getContentSize();
  imageView.setBounds({ x: 0, y: 0, width, height });
}

// items: [{ url, thumb }] - url: Facebook photo page or direct image URL,
// thumb: the image shown in the chat (https or data: URL), if known.
// index: the clicked one; the viewer can page to the others.
function openImageViewer(items, index) {
  if (!mainWindow || !view || !items.length) return;
  closeVideoOverlay();
  closeImageViewer();

  const g = { items, index };
  gallery = g;
  lastDir = 1;

  imageView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'viewer-preload.js'),
    },
  });
  imageView.setBackgroundColor('#0e0f10');
  mainWindow.addBrowserView(imageView);
  updateImageViewBounds();

  const wc = imageView.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // Esc closes the viewer even if the page hasn't loaded yet
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      closeImageViewer();
    }
  });

  wc.once('did-finish-load', () => {
    if (gallery === g) showGalleryItem(g.index, true);
  });

  wc.loadFile(path.join(__dirname, 'viewer.html'));
  wc.focus();
}

// Photos go to the image viewer, everything else (videos, posts) to the
// media dialog
function openMedia(url, thumbUrl) {
  if (isImageViewerUrl(url)) openImageViewer([{ url, thumb: thumbUrl || null }], 0);
  else openVideoWindow(url);
}

function isFromViewer(event) {
  return imageView && !imageView.webContents.isDestroyed() && event.sender === imageView.webContents;
}

ipcMain.on('viewer:shown', (event, url) => {
  if (isFromViewer(event) && current) current.shownUrl = url;
});

ipcMain.on('viewer:navigate', (event, step) => {
  if (!isFromViewer(event) || !gallery || (step !== 1 && step !== -1)) return;
  const index = gallery.index + step;
  if (index < 0 || index >= gallery.items.length) return;
  lastDir = step;
  showGalleryItem(index, false);
});

ipcMain.on('viewer:play-video', (event) => {
  if (isFromViewer(event)) openCurrentAsVideo();
});

ipcMain.on('viewer:close', (event) => {
  if (isFromViewer(event)) closeImageViewer();
});

ipcMain.on('viewer:open-browser', (event) => {
  if (!isFromViewer(event)) return;
  const url = viewerLinkUrl();
  closeImageViewer();
  if (url) shell.openExternal(url);
});

ipcMain.on('viewer:copy-link', (event) => {
  if (!isFromViewer(event)) return;
  const url = viewerLinkUrl();
  if (url) clipboard.writeText(url);
});

ipcMain.on('viewer:save', (event) => {
  if (!isFromViewer(event) || !current) return;
  const url = current.shownUrl;
  if (url) imageView.webContents.downloadURL(url);
});

ipcMain.on('viewer:copy-image', (event, x, y) => {
  if (isFromViewer(event)) imageView.webContents.copyImageAt(x, y);
});

ipcMain.on('viewer:context-menu', (event, x, y, onImage) => {
  if (!isFromViewer(event) || !current) return;
  const wc = imageView.webContents;
  const items = [];
  if (onImage && current.shownUrl) {
    items.push({ label: 'Kép másolása', click: () => wc.copyImageAt(x, y) });
  }
  items.push({
    label: 'Link másolása',
    click: () => {
      const url = viewerLinkUrl();
      if (url) clipboard.writeText(url);
    },
  });
  const shownUrl = current.shownUrl;
  if (shownUrl) {
    items.push({ label: 'Mentés másként…', click: () => wc.downloadURL(shownUrl) });
  }
  if (gallery && gallery.items.length > 1) {
    items.push({ type: 'separator' });
    items.push({
      label: 'Előző kép',
      enabled: gallery.index > 0,
      click: () => {
        lastDir = -1;
        showGalleryItem(gallery.index - 1, false);
      },
    });
    items.push({
      label: 'Következő kép',
      enabled: gallery.index < gallery.items.length - 1,
      click: () => {
        lastDir = 1;
        showGalleryItem(gallery.index + 1, false);
      },
    });
    items.push({ type: 'separator' });
  }
  items.push({
    label: 'Megnyitás böngészőben',
    click: () => {
      const url = viewerLinkUrl();
      closeImageViewer();
      if (url) shell.openExternal(url);
    },
  });
  items.push({ type: 'separator' });
  items.push({ label: 'Bezárás', click: closeImageViewer });
  Menu.buildFromTemplate(items).popup({ window: mainWindow });
});

// Photo click in the chat (preload.js): the clicked photo plus all photos of
// the chat currently loaded on the page, for paging
function sanitizeThumb(thumb) {
  return typeof thumb === 'string' && /^(https:|data:image\/)/.test(thumb) ? thumb : null;
}

ipcMain.on('open-photo-gallery', (event, items, index) => {
  if (!Array.isArray(items)) return;
  const clean = [];
  let cleanIndex = 0;
  items.forEach((it, i) => {
    if (!it || typeof it.url !== 'string') return;
    const url = unwrapLinkShim(it.url);
    if (!isImageViewerUrl(url)) return;
    if (i === index) cleanIndex = clean.length;
    clean.push({ url, thumb: sanitizeThumb(it.thumb) });
  });
  if (!clean.length) return;
  openImageViewer(clean, cleanIndex);
});

// Thumbnails of encrypted chats arrive later (converted from blob: URLs)
ipcMain.on('photo-gallery-thumb', (event, url, thumb) => {
  thumb = sanitizeThumb(thumb);
  if (!gallery || !thumb) return;
  for (const item of gallery.items) {
    if (item.url !== url || item.thumb) continue;
    item.thumb = thumb;
    if (current && current.item === item && !current.shownUrl) {
      sendToViewer('viewer:image', thumb, 'preview');
    }
  }
});

// Facebook first paints a placeholder skeleton (fake sidebar, empty chat) and
// only fills in the real chats later - cover the messenger view with a loading
// screen until the real UI is there
const LOADING_BG = '#18191a';
const LOADING_TIMEOUT_MS = 30000;

// True once the page shows something real: the chat list (plus the open
// conversation's composer or a dialog, e.g. the encrypted chat PIN prompt),
// or a non-messenger page such as the login form
const READY_CHECK_JS = `
(() => {
  if (!location.pathname.startsWith('/messages')) return document.readyState === 'complete';
  const hasThreads = !!document.querySelector('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]');
  if (!hasThreads) return false;
  if (!/\\/t\\//.test(location.pathname)) return true;
  return !!document.querySelector('[role="textbox"][contenteditable="true"], [role="dialog"]');
})()
`;

let loadingView;
let loadingPoll;
let loadingTimeout;

function showLoading() {
  if (!mainWindow || loadingView) return;
  loadingView = new BrowserView({
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  loadingView.setBackgroundColor(LOADING_BG);
  mainWindow.addBrowserView(loadingView);
  updateViewBounds();
  loadingView.webContents.loadFile(path.join(__dirname, 'loading.html'));

  // only check the new document, not the one being replaced (e.g. on logout)
  let navigated = false;
  view.webContents.once('did-navigate', () => { navigated = true; });
  loadingPoll = setInterval(async () => {
    if (!navigated || !view || view.webContents.isDestroyed()) return;
    try {
      if (await view.webContents.executeJavaScript(READY_CHECK_JS)) hideLoading();
    } catch {}
  }, 300);
  // never leave the user stuck behind the loading screen
  loadingTimeout = setTimeout(hideLoading, LOADING_TIMEOUT_MS);
}

function hideLoading() {
  clearInterval(loadingPoll);
  clearTimeout(loadingTimeout);
  if (!loadingView) return;
  const lv = loadingView;
  loadingView = null;
  const remove = () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.removeBrowserView(lv);
    if (!lv.webContents.isDestroyed()) lv.webContents.destroy();
  };
  // fade out, then remove
  lv.webContents.executeJavaScript(`document.body.classList.add('hide')`).catch(() => {});
  setTimeout(remove, 260);
}

function isMessengerPage(url) {
  try {
    const u = new URL(url);
    return (
      (u.hostname.endsWith('facebook.com') && u.pathname.startsWith('/messages')) ||
      u.hostname.endsWith('messenger.com')
    );
  } catch {
    return false;
  }
}

// Messenger links that point at a conversation, e.g. when Facebook's
// notification click handler calls window.open() - load them in the app
// instead of the default browser
function toAppMessengerUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('messenger.com') && u.pathname.startsWith('/t/')) {
      return `https://www.facebook.com/messages${u.pathname}`;
    }
  } catch {}
  return url;
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (view && !view.webContents.isDestroyed()) view.webContents.focus();
}

function updateViewBounds() {
  if (!mainWindow || !view) return;
  const [width, height] = mainWindow.getContentSize();
  view.setBounds({ x: 0, y: -BANNER_HEIGHT, width, height: height + BANNER_HEIGHT });
  if (loadingView) loadingView.setBounds({ x: 0, y: 0, width, height });
  updateVideoViewBounds();
  updateImageViewBounds();
}

function createWindow() {
  const { windowBounds, isMaximized } = {
    windowBounds: store.get('windowBounds'),
    isMaximized: store.get('isMaximized'),
  };

  // Check if saved position is still on a visible display
  let positionValid = false;
  if (windowBounds.x !== undefined && windowBounds.y !== undefined) {
    const displays = screen.getAllDisplays();
    positionValid = displays.some((display) => {
      const b = display.bounds;
      return (
        windowBounds.x >= b.x - 50 &&
        windowBounds.x < b.x + b.width &&
        windowBounds.y >= b.y - 50 &&
        windowBounds.y < b.y + b.height
      );
    });
  }

  mainWindow = new BrowserWindow({
    width: windowBounds.width,
    height: windowBounds.height,
    x: positionValid ? windowBounds.x : undefined,
    y: positionValid ? windowBounds.y : undefined,
    autoHideMenuBar: true,
    title: 'Messenger',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    // match the loading screen so there is no black/white flash before it paints
    backgroundColor: LOADING_BG,
  });

  // Hide the menu bar completely
  mainWindow.setMenuBarVisibility(false);

  // Create BrowserView offset upward to hide the banner
  view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  view.setBackgroundColor(LOADING_BG);
  mainWindow.setBrowserView(view);
  showLoading();

  if (isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.once('ready-to-show', updateViewBounds);
  view.webContents.on('did-finish-load', updateViewBounds);

  updateViewBounds();

  view.webContents.loadURL('https://www.facebook.com/messages');

  // Video and photo links open in an in-app dialog, everything else in default browser
  view.webContents.setWindowOpenHandler(({ url }) => {
    const target = unwrapLinkShim(url);
    if (isMessengerPage(target)) {
      focusMainWindow();
      view.webContents.loadURL(toAppMessengerUrl(target));
    } else if (isVideoUrl(target) || isPhotoUrl(target)) {
      openMedia(target);
    } else {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Intercept navigation - only allow messenger pages, open everything else in browser
  view.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      const isFbAuth = parsed.hostname.endsWith('facebook.com') && (
        parsed.pathname.startsWith('/login') ||
        parsed.pathname.startsWith('/checkpoint') ||
        parsed.pathname.startsWith('/two_step_verification') ||
        parsed.pathname.startsWith('/recover') ||
        parsed.pathname.startsWith('/cookie') ||
        parsed.pathname.startsWith('/logout') ||
        parsed.pathname === '/'
      );
      const isMessenger =
        (parsed.hostname.endsWith('facebook.com') && parsed.pathname.startsWith('/messages')) ||
        parsed.hostname.endsWith('messenger.com') ||
        isFbAuth;
      if (!isMessenger) {
        event.preventDefault();
        const target = unwrapLinkShim(url);
        if (isVideoUrl(target) || isPhotoUrl(target)) {
          openMedia(target);
        } else {
          shell.openExternal(url);
        }
      }
    } catch {
      // invalid URL, let it pass
    }
  });

  // Close the video dialog if the messenger view navigates away
  view.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      closeVideoOverlay();
      closeImageViewer();
      // Facebook sometimes switches chats with a full page reload instead of
      // its in-page router - cover the slow reload with the loading screen
      if (isMessengerPage(details.url)) showLoading();
    }
  });

  // Safety net: if the FB SPA still navigates in-page to a media URL
  // (e.g. keyboard activation bypassing the click handler), step back
  // and open the dialog instead
  view.webContents.on('did-navigate-in-page', (event, url, isMainFrame) => {
    if (!isMainFrame) return;
    const target = unwrapLinkShim(url);
    if (isVideoUrl(target) || isPhotoUrl(target)) {
      if (view.webContents.canGoBack()) view.webContents.goBack();
      openMedia(target);
    }
  });

  // Flash the taskbar icon when a new message arrives - Messenger prefixes
  // the page title with the unread count, e.g. "(2) Messenger"
  view.webContents.on('page-title-updated', (event, title) => {
    const match = title.match(/^\((\d+)\+?\)/);
    const unread = match ? parseInt(match[1], 10) : 0;
    if (unread > lastUnreadCount && !mainWindow.isFocused()) {
      mainWindow.flashFrame(true);
    }
    lastUnreadCount = unread;
  });

  // Stop the highlight once the user switches back to the window
  mainWindow.on('focus', () => mainWindow.flashFrame(false));

  // Update view bounds on resize
  mainWindow.on('resize', updateViewBounds);

  // Save window state on move/resize
  const saveWindowState = () => {
    if (mainWindow.isMaximized() || mainWindow.isMinimized()) return;
    const bounds = mainWindow.getBounds();
    store.set('windowBounds', bounds);
  };

  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);
  mainWindow.on('maximize', () => {
    store.set('isMaximized', true);
    updateViewBounds();
  });
  mainWindow.on('unmaximize', () => {
    store.set('isMaximized', false);
    updateViewBounds();
  });

  mainWindow.on('closed', () => {
    hideLoading();
    // the hidden image resolver window would otherwise keep the app alive
    closeImageViewer();
    mainWindow = null;
    view = null;
  });
}

ipcMain.on('close-video-overlay', closeVideoOverlay);

ipcMain.on('open-video-in-browser', () => {
  if (!videoView) return;
  const url = videoView.webContents.getURL();
  closeVideoOverlay();
  if (url) shell.openExternal(url);
});

ipcMain.on('focus-main-window', focusMainWindow);

// thumbUrl: the image the user clicked in the chat, shown until the full
// resolution version is found
ipcMain.on('open-media-dialog', (event, url, thumbUrl) => {
  const target = unwrapLinkShim(url);
  const thumb = typeof thumbUrl === 'string' && /^(https:|data:image\/)/.test(thumbUrl) ? thumbUrl : null;
  openMedia(target, thumb);
});

ipcMain.on('show-context-menu', (event, params) => {
  const menuItems = [];

  if (params.linkURL) {
    menuItems.push({
      label: 'Link megnyitasa bongeszoben',
      click: () => shell.openExternal(params.linkURL),
    });
    menuItems.push({
      label: 'Link masolasa',
      click: () => clipboard.writeText(params.linkURL),
    });
    menuItems.push({ type: 'separator' });
  }

  if (params.isImage) {
    menuItems.push({
      label: 'Kep megnyitasa bongeszoben',
      click: () => shell.openExternal(params.srcURL),
    });
    menuItems.push({
      label: 'Kep URL masolasa',
      click: () => clipboard.writeText(params.srcURL),
    });
    menuItems.push({ type: 'separator' });
  }

  if (params.selectionText) {
    menuItems.push({
      label: 'Masolas',
      role: 'copy',
    });
    menuItems.push({ type: 'separator' });
  }

  if (params.isEditable) {
    menuItems.push({ label: 'Visszavonas', role: 'undo' });
    menuItems.push({ label: 'Ujra', role: 'redo' });
    menuItems.push({ type: 'separator' });
    menuItems.push({ label: 'Kivagás', role: 'cut' });
    menuItems.push({ label: 'Masolas', role: 'copy' });
    menuItems.push({ label: 'Beillesztes', role: 'paste' });
    menuItems.push({ label: 'Osszes kijelolese', role: 'selectAll' });
  }

  // Always add logout option
  if (menuItems.length > 0) {
    // Remove trailing separator if present
    if (menuItems[menuItems.length - 1].type === 'separator') {
      menuItems.pop();
    }
    menuItems.push({ type: 'separator' });
  }
  menuItems.push({
    label: 'Kijelentkezes',
    click: () => {
      if (view) {
        view.webContents.session.clearStorageData().then(() => {
          showLoading();
          view.webContents.loadURL('https://www.facebook.com/messages');
        });
      }
    },
  });

  const menu = Menu.buildFromTemplate(menuItems);
  menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
});

// A second instance sharing the same profile directory corrupts the cache and
// leaves the page stuck on the loading skeleton - allow only one instance
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows may also start the app again when an older notification is
  // clicked in the Action Center - just bring the existing window forward
  app.on('second-instance', focusMainWindow);

  app.whenReady().then(async () => {
    // Keeping the HTTP and code caches makes startup much faster (Facebook's
    // JS doesn't have to be downloaded and compiled again). Only clear them
    // if the previous run didn't exit cleanly, since that can leave a broken
    // cache behind (keeps cookies, so no re-login)
    if (!store.get('cleanExit')) {
      try {
        await session.defaultSession.clearCache();
        await session.defaultSession.clearCodeCaches({});
      } catch {}
    }
    store.set('cleanExit', false);
    createWindow();
  });

  app.on('will-quit', () => {
    store.set('cleanExit', true);
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('activate', () => {
    if (mainWindow === null) createWindow();
  });
}
