const { app, BrowserWindow, BrowserView, screen, shell, ipcMain, Menu, session } = require('electron');
const path = require('path');
const Store = require('electron-store').default;

const BANNER_HEIGHT = 58;

const store = new Store({
  defaults: {
    windowBounds: { x: undefined, y: undefined, width: 1024, height: 768 },
    isMaximized: false,
  },
});

let mainWindow;
let view;
let videoView;
let videoViewVertical = false;
let lastUnreadCount = 0;

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
  videoViewVertical = isVerticalVideoUrl(url);

  if (!videoView) {
    videoView = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
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

function updateViewBounds() {
  if (!mainWindow || !view) return;
  const [width, height] = mainWindow.getContentSize();
  view.setBounds({ x: 0, y: -BANNER_HEIGHT, width, height: height + BANNER_HEIGHT });
  updateVideoViewBounds();
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
  mainWindow.setBrowserView(view);

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
    if (isVideoUrl(target) || isPhotoUrl(target)) {
      openVideoWindow(target);
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
          openVideoWindow(target);
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
    if (details.isMainFrame && !details.isSameDocument) closeVideoOverlay();
  });

  // Safety net: if the FB SPA still navigates in-page to a media URL
  // (e.g. keyboard activation bypassing the click handler), step back
  // and open the dialog instead
  view.webContents.on('did-navigate-in-page', (event, url, isMainFrame) => {
    if (!isMainFrame) return;
    const target = unwrapLinkShim(url);
    if (isVideoUrl(target) || isPhotoUrl(target)) {
      if (view.webContents.canGoBack()) view.webContents.goBack();
      openVideoWindow(target);
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
    mainWindow = null;
    view = null;
  });
}

ipcMain.on('close-video-overlay', closeVideoOverlay);

ipcMain.on('open-media-dialog', (event, url) => openVideoWindow(unwrapLinkShim(url)));

ipcMain.on('show-context-menu', (event, params) => {
  const menuItems = [];

  if (params.linkURL) {
    menuItems.push({
      label: 'Link megnyitasa bongeszoben',
      click: () => shell.openExternal(params.linkURL),
    });
    menuItems.push({
      label: 'Link masolasa',
      click: () => require('electron').clipboard.writeText(params.linkURL),
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
      click: () => require('electron').clipboard.writeText(params.srcURL),
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
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // Clear leftover caches from previous runs (keeps cookies, so no re-login)
    try {
      await session.defaultSession.clearCache();
      await session.defaultSession.clearCodeCaches({});
    } catch {}
    createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('activate', () => {
    if (mainWindow === null) createWindow();
  });
}
