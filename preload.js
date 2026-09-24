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
