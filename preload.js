const { ipcRenderer } = require('electron');

window.__closeVideoOverlay = () => ipcRenderer.send('close-video-overlay');
window.__openVideoInBrowser = () => ipcRenderer.send('open-video-in-browser');

// Facebook links (reel, watch, photo, ...) are rendered by the SPA in-page,
// so no navigation event reaches the main process - the page would show the
// media with its top (close button) cropped into the hidden banner area.
// Intercept the click before FB handles it and open the app dialog instead.
function isMediaPath(p) {
  return (
    p.startsWith('/messenger_media') ||
    p.startsWith('/share/') ||
    p.startsWith('/reel') ||
    p.startsWith('/watch') ||
    p.startsWith('/video.php') ||
    p.startsWith('/photo') ||
    p.startsWith('/permalink.php') ||
    p.startsWith('/story.php') ||
    /^\/[^/]+\/(videos|photos|posts)\//.test(p)
  );
}

// Photo pages open in the app's own image viewer (main.js); the image shown
// in the chat is passed along so the viewer can show it instantly while the
// full resolution version is being looked up
function isPhotoViewerPath(p) {
  return p.startsWith('/messenger_media') || p.startsWith('/photo');
}

function findThumbnail(a, target) {
  const imgs = target && target.tagName === 'IMG' ? [target] : [];
  imgs.push(...a.querySelectorAll('img'));
  let best = null;
  let bestArea = 0;
  for (const img of imgs) {
    const src = img.currentSrc || img.src;
    if (!src) continue;
    const area = (img.naturalWidth || img.width) * (img.naturalHeight || img.height);
    if (area > bestArea) {
      best = src;
      bestArea = area;
    }
  }
  return best;
}

// Encrypted chats show decrypted images as blob: URLs, which only work in this
// page - hand them to the viewer as data: URLs instead
function blobToDataUrl(url) {
  return fetch(url)
    .then((r) => r.blob())
    .then(
      (blob) =>
        new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        })
    )
    .catch(() => null);
}

// The photo page a chat link points to (shim unwrapped), or null
function photoHref(a) {
  try {
    let u = new URL(a.href);
    if (u.hostname.endsWith('facebook.com') && u.pathname === '/l.php') {
      const target = u.searchParams.get('u');
      if (target) u = new URL(target);
    }
    if (u.hostname.endsWith('facebook.com') && isPhotoViewerPath(u.pathname)) return u.href;
  } catch {}
  return null;
}

// All photos of the open conversation currently on the page (Messenger only
// keeps the loaded part of the history in the DOM), oldest first, so the
// viewer can page between them
function collectGallery(href, a, target) {
  const root = a.closest('[role="main"]') || document;
  const items = [];
  const seen = new Set();
  for (const link of root.querySelectorAll('a[href]')) {
    const url = link === a ? href : photoHref(link);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    items.push({ url, thumb: findThumbnail(link, link === a ? target : null) });
  }
  let index = items.findIndex((it) => it.url === href);
  if (index < 0) {
    items.length = 0;
    items.push({ url: href, thumb: findThumbnail(a, target) });
    index = 0;
  }
  return { items, index };
}

function openPhoto(href, a, target) {
  const { items, index } = collectGallery(href, a, target);
  // blob: thumbnails (encrypted chats) only work in this page: the clicked
  // one is converted before opening, the rest are sent along afterwards
  const blobs = [];
  for (const [i, it] of items.entries()) {
    if (i !== index && it.thumb && it.thumb.startsWith('blob:')) {
      blobs.push({ url: it.url, blob: it.thumb });
      it.thumb = null;
    }
  }
  const sendRest = () => {
    for (const b of blobs) {
      blobToDataUrl(b.blob).then((data) => {
        if (data) ipcRenderer.send('photo-gallery-thumb', b.url, data);
      });
    }
  };
  const clicked = items[index];
  if (clicked.thumb && clicked.thumb.startsWith('blob:')) {
    blobToDataUrl(clicked.thumb).then((data) => {
      clicked.thumb = data;
      ipcRenderer.send('open-photo-gallery', items, index);
      sendRest();
    });
  } else {
    ipcRenderer.send('open-photo-gallery', items, index);
    sendRest();
  }
}

document.addEventListener(
  'click',
  (e) => {
    const a = e.target.closest('a');
    if (!a || !a.href) return;
    try {
      let u = new URL(a.href);
      // unwrap the l.facebook.com/l.php?u=<target> link shim
      if (u.hostname.endsWith('facebook.com') && u.pathname === '/l.php') {
        const target = u.searchParams.get('u');
        if (target) u = new URL(target);
      }
      const isMedia =
        u.hostname === 'fb.watch' ||
        (u.hostname.endsWith('facebook.com') && isMediaPath(u.pathname));
      if (isMedia) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (isPhotoViewerPath(u.pathname)) openPhoto(u.href, a, e.target);
        else ipcRenderer.send('open-media-dialog', u.href);
      }
    } catch {}
  },
  true
);

// Video links (reels, /share/r/, watch, ...) appearing in the open chat are
// reported to main.js, which looks up their direct MP4 link in the background,
// so clicking one starts playback right away. Hovering a link reports it too.
function videoHref(a) {
  try {
    let u = new URL(a.href);
    if (u.hostname.endsWith('facebook.com') && u.pathname === '/l.php') {
      const target = u.searchParams.get('u');
      if (target) u = new URL(target);
    }
    if (u.hostname === 'fb.watch') return u.href;
    if (!u.hostname.endsWith('facebook.com')) return null;
    const p = u.pathname;
    if (
      p.startsWith('/share/r/') ||
      p.startsWith('/share/v/') ||
      p.startsWith('/reel') ||
      p.startsWith('/watch') ||
      p.startsWith('/video.php') ||
      /^\/[^/]+\/videos\//.test(p)
    )
      return u.href;
  } catch {}
  return null;
}

const reportedVideos = new Set();
let videoScanTimer = null;
let lastHoveredVideo = null;

function scanVideoLinks() {
  videoScanTimer = null;
  const root = document.querySelector('[role="main"]');
  if (!root) return;
  const urls = [];
  for (const a of root.querySelectorAll('a[href]')) {
    const url = videoHref(a);
    if (url && !reportedVideos.has(url)) {
      reportedVideos.add(url);
      urls.push(url);
    }
  }
  if (urls.length) ipcRenderer.send('prefetch-videos', urls); // DOM order: newest last
}

function scheduleVideoScan() {
  if (!videoScanTimer) videoScanTimer = setTimeout(scanVideoLinks, 800);
}

new MutationObserver(scheduleVideoScan).observe(document, { childList: true, subtree: true });

document.addEventListener(
  'mouseover',
  (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    const url = a && videoHref(a);
    if (!url || url === lastHoveredVideo) return;
    lastHoveredVideo = url;
    // re-sent on hover: main.js skips it when a fresh link is already cached
    ipcRenderer.send('prefetch-videos', [url]);
  },
  true
);

// Switch chats on mousedown instead of click: the SPA starts loading the
// conversation ~0.1-0.2s earlier. The synthetic click goes through FB's own
// router; the real click that follows on mouseup is swallowed so the chat
// isn't opened twice.
const CHAT_LINK_RE = /^\/messages\/(e2ee\/)?t\/[^/]+\/?$/;
let pendingChatLink = null;

document.addEventListener(
  'mousedown',
  (e) => {
    pendingChatLink = null;
    if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
    const a = e.target.closest('a');
    if (!a || !a.href) return;
    // the row's "..." menu and other buttons inside the row keep normal behavior
    const btn = e.target.closest('[role="button"], button');
    if (btn && btn !== a && a.contains(btn)) return;
    try {
      const u = new URL(a.href);
      if (!u.hostname.endsWith('facebook.com') || !CHAT_LINK_RE.test(u.pathname)) return;
      if (u.pathname.replace(/\/$/, '') === location.pathname.replace(/\/$/, '')) return;
    } catch {
      return;
    }
    pendingChatLink = a;
    a.click();
  },
  true
);

document.addEventListener(
  'click',
  (e) => {
    if (!e.isTrusted || !pendingChatLink) return;
    const a = pendingChatLink;
    pendingChatLink = null;
    if (a.contains(e.target)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  true
);

// Notifications: Facebook's click handler opens the conversation with
// window.open(), which would end up in the default browser. Bring the app
// window to the front and open the conversation in the app instead.
const MESSENGER_THREAD_RE = /^\/(messages\/)?(e2ee\/)?t\//;

function toAppThreadUrl(href) {
  try {
    const u = new URL(href, location.href);
    if (u.hostname.endsWith('messenger.com') && MESSENGER_THREAD_RE.test(u.pathname)) {
      return new URL(`/messages${u.pathname}`, 'https://www.facebook.com');
    }
    if (u.hostname.endsWith('facebook.com') && u.pathname.startsWith('/messages')) return u;
  } catch {}
  return null;
}

// Prefer the chat list link (FB's in-page router, no reload), fall back to
// a normal navigation
function openThreadInApp(u) {
  const path = u.pathname.replace(/\/$/, '');
  if (path === location.pathname.replace(/\/$/, '')) return;
  const link = Array.from(document.querySelectorAll('a[href*="/t/"]')).find((a) => {
    try {
      return new URL(a.href).pathname.replace(/\/$/, '') === path;
    } catch {
      return false;
    }
  });
  if (link) link.click();
  else location.assign(u.href);
}

const nativeOpen = window.open;
window.open = function (url, ...rest) {
  const u = url && toAppThreadUrl(String(url));
  if (u) {
    ipcRenderer.send('focus-main-window');
    openThreadInApp(u);
    return window;
  }
  return nativeOpen.call(window, url, ...rest);
};

const NativeNotification = window.Notification;
if (NativeNotification) {
  window.Notification = class extends NativeNotification {
    constructor(...args) {
      super(...args);
      // registered before FB's own onclick, so it runs first
      this.addEventListener('click', () => ipcRenderer.send('focus-main-window'));
    }
  };
}

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  ipcRenderer.send('show-context-menu', {
    x: e.x,
    y: e.y,
    linkURL: e.target.closest('a')?.href || '',
    srcURL: e.target.src || '',
    selectionText: window.getSelection().toString(),
    isEditable: e.target.isContentEditable || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA',
    isImage: e.target.tagName === 'IMG',
  });
});
