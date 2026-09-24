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
        ipcRenderer.send('open-media-dialog', u.href);
      }
    } catch {}
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
