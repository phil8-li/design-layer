# DesignLayer for Mac

A Dock app for DesignLayer that installs on macOS without compiling or signing anything.

- **Desk server** (`desk-server.mjs`): runs on `127.0.0.1:3454`, loopback only. A user LaunchAgent (`dev.designlayer.desk`) starts it at login. It keeps the start screen (`cli.mjs --start --no-open`, port 3455) running and restarts it with backoff if it dies. If a start screen is already running on 3455, the desk uses that one and never kills it.
- **Window**: a Chrome-installed web app (PWA) named DesignLayer, kept in its own Chrome profile. It shows a tab strip in the title bar: Home (the start screen), your open editors, a dashed offer for each other running editor (from `runtime/editor-registry.mjs`), and `+`.

## Install, status, uninstall

```sh
node desktop/mac/install.mjs                   # install and open the app
node desktop/mac/install.mjs --dry-run         # print the plan, change nothing
node desktop/mac/install.mjs --status          # LaunchAgent, health, start screen, app
node desktop/mac/install.mjs --start | --stop  # restart / stop the desk server
node desktop/mac/install.mjs --verify-window   # relaunch the app over CDP and check what it loads (an open window is reopened after)
node desktop/mac/install.mjs --app-window      # fallback window, see below
node desktop/mac/install.mjs --uninstall --yes # remove the LaunchAgent, the app and its Chrome profile
```

Running the installer again is safe. It rewrites the plist, restarts the desk, and keeps the existing app registration. If the app is open, the installer and `--uninstall` quit it first: they stop only the Chrome instance whose command line names the app's own profile, never your browser.

Tests: `node desktop/mac/test/desk-cases.mjs`. Icons: `icons/app-icon.svg` is the Dock icon and `runtime/favicon.svg` the tab icon. `node desktop/mac/make-icons.mjs` renders the first to the manifest's PNGs in a headless Playwright Chromium and copies the second to `icons/mark.svg`. An installed app keeps the icon it was installed with: delete `~/Applications/Chrome Apps.localized/DesignLayer.app` and run the installer again to reinstall it with the new one.

## Why it is built this way

Nothing is compiled, signed, or downloaded at install time. It uses Apple's `launchctl`, `open`, `osascript` and `plutil`, your existing `node`, and the app shim Chrome writes when it installs a web app (`app_mode_loader`), which gives DesignLayer its own Dock icon and window without bundling Electron or requiring an Apple Developer certificate.

The PWA is installed over Chrome's DevTools pipe (`--remote-debugging-pipe --enable-devtools-pwa-handler`, `PWA.install`). Chrome accepts that only on a non-default `--user-data-dir`, which is why the app has its own profile at `~/Library/Application Support/DesignLayer/Chrome`.

## How the window works

- The start screen and the editor proxies send no `X-Frame-Options` or `frame-ancestors` header (checked in `runtime/`, `server/` and `react-rewrite-cli`), so each one loads directly in an iframe. No reverse proxy is needed. They are all on 127.0.0.1, so they are same-site with the desk and keep the same storage they have in a normal tab.
- Pressing Start in a Home tab turns that tab into the editor, the same way it does in a browser. The desk renames the tab to the editor's name rather than opening a second copy.
- Any editor already running appears as a dashed "offer" tab. Click it to open it. Offered editors are never opened for you, because an editor's socket takes one client: opening it here disconnects any other window showing it.
- Shortcuts: ⌘1–9 switch tabs, ⌘T opens a new Home tab, ⌘W closes a tab. They only work when focus is on the tab strip or the desk page, because a cross-origin frame keeps its own keystrokes. Chrome can also reserve ⌘T and ⌘W for itself.
- Title bar: the tabs always sit in the title bar (Window Controls Overlay), with no Chrome toggle to move them out, and Extensions lives in the ⋮ menu instead of beside it. That takes the app's Chrome running with `--enable-features=DesktopPWAsWindowControlsOverlayWithNoToggle,DesktopPWAsElidedExtensionsMenu`, which Chrome reads only at launch. The installer and the desk pass it whenever they open the app (`open <shim> --args …`; the shim hands `--enable-features` on to the Chrome it starts). The Dock icon passes nothing, so when the app was opened from the Dock the desk restarts it once with the flag as its window connects: the window closes and reopens with its tabs. The ⋮ menu stays: Chrome draws it for every installed app on the Mac.
- Title-bar glyphs in `symbols/` are drawn at 20px to match the ⋮ button Chrome draws beside them.
- The folder button opens the macOS folder picker (`osascript choose folder`) and copies the path you choose to the clipboard, so you can paste it into the start screen.

## Open in Mac app

An editor in an ordinary browser tab shows an **Open in Mac app** banner at the bottom of its left panel. Clicking it moves that page into the app:

1. The editor POSTs its URL to `http://127.0.0.1:3454/api/open`. The body is JSON sent as `text/plain`, so the cross-origin request needs no preflight. The desk echoes CORS only to loopback origins and refuses anything that is not an http page on this Mac.
2. The desk passes the URL to the app window over `GET /api/events` (server-sent events). If the window is closed, the desk holds the URL for up to 60 seconds and gives it to the first window that connects. A desk page open in an ordinary browser tab only gets a URL when no app window is open.
3. The desk runs `open` on the app shim to bring the window forward, or to launch it. With the `--app-window` fallback there is no shim, so it starts that Chrome window only when none is open.
4. The window opens the page in the tab that already shows that editor, or in a new tab. Taking the editor's socket disconnects the browser tab.

The banner appears only when both of these are true:

- **The app is installed.** The launcher checks for this LaunchAgent's plist when it starts (`runtime/mac-desk.mjs`), so a browser that has never seen the desk makes no requests to it. An editor started before the app was installed shows the banner after its next restart.
- **The editor is not already in the app.** Each app tab's iframe is named `designlayer-desk:<tab id>`, and the editor checks that name. It also checks `location.ancestorOrigins`, for frames created before the desk started naming them.

## Limits and fallback

- **If the Chrome app shim cannot be created or opened**, use `install.mjs --app-window` instead: it opens `Chrome --app=http://127.0.0.1:3454/ --user-data-dir=<the same profile>`, which runs Chrome directly and needs no shim.
- **Homebrew node upgrades**: the plist uses the stable `/opt/homebrew/bin/node` symlink rather than the versioned Cellar path, so `brew upgrade node` needs no reinstall.
- The window needs the desk server. When the server is down, the service worker shows an offline page with the command to start it.

## Troubleshooting

- Logs: `~/Library/Logs/DesignLayer/desk.log` (desk) and `start-screen.log` (start screen and the editors it starts).
- `launchctl print gui/$(id -u)/dev.designlayer.desk` shows the agent's state and last exit code.
- "A Chrome instance is using …/DesignLayer/Chrome": the app's Chrome did not quit within 10 s. Quit the DesignLayer app (⌘Q) and run the command again.
