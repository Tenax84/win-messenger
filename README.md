# Messenger

A lightweight Electron wrapper that runs Facebook Messenger as a standalone desktop application on Windows.

## Features

- **Clean UI** - No browser chrome, address bar, or Facebook navigation banner
- **Window state persistence** - Remembers position, size, and monitor across restarts
- **External link handling** - Clicked links open in your default browser instead of inside the app
- **Fast image viewer** - Photos sent in chat open in a built-in viewer showing the direct full-resolution image (zoom, pan, save, copy), instead of Facebook's slow photo page; page between the chat's photos with the arrow keys
- **Right-click context menu** - Copy, paste, open links, copy URLs, and logout
- **Session management** - Logout option available via right-click menu (clears all session data)

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)

### Install & Run

```bash
npm install
npm start
```

### Build Windows Installer

```bash
npm run build
```

The installer will be generated at `dist/Messenger Setup <version>.exe`.

## How It Works

The app uses Electron's `BrowserView` with a negative Y offset to hide the Facebook navigation banner, giving Messenger a native app feel. Navigation is restricted to Messenger and Facebook authentication pages only — all other links are redirected to the system's default browser.

## License

ISC
