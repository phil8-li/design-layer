# DesignLayer for Mac

A Dock app for DesignLayer that installs on macOS without compiling or signing anything.

- **Desk server** (`desk-server.mjs`): listens on `127.0.0.1:3454`, loopback only, and the window loads it as `http://localhost:3454`. A user LaunchAgent (`dev.designlayer.desk`) starts it at login. It keeps the start screen (`cli.mjs --start --no-open`, port 3455) running and restarts it with backoff if it dies. If a start screen is already running on 3455, the desk uses that one and never kills it.
- **Window**: a Chrome-installed web app (PWA) named DesignLayer, kept in its own Chrome profile. It shows a tab strip in the title bar: Home (the start screen), your open editors, and `+`. Drag a tab out of the strip to give it a window of its own, and onto another window's strip to put it back (see [Windows and tabs](#windows-and-tabs)).

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

Running the installer again is safe. It rewrites the plist, restarts the desk, and keeps the existing app registration. An app installed from `http://127.0.0.1:3454/` (before the window moved to localhost) is a different app to Chrome: the installer removes it and installs the one from `http://localhost:3454/`, and the window's tabs come back from the desk's copy. If the app is open, the installer and `--uninstall` quit it first: they stop only the Chrome instance whose command line names the app's own profile, never your browser.

Tests: `node desktop/mac/test/desk-cases.mjs`. Icons: `icons/app-icon.svg` is the Dock icon and `runtime/favicon.svg` the tab icon. `node desktop/mac/make-icons.mjs` renders the first to the manifest's PNGs in a headless Playwright Chromium and copies the second to `icons/mark.svg`. An installed app keeps the icon it was installed with: delete `~/Applications/Chrome Apps.localized/DesignLayer.app` and run the installer again to reinstall it with the new one.

## Updates

The start screen the desk runs checks GitHub for new commits on `main` (`runtime/updater.mjs`, see [Updating](../../docs/using.md#updating)). The desk relays what it found in `/api/health` (`startScreen.update`), and the title bar shows **Update available** while there is one. It opens Home, where **Update and restart** runs the update.

- **Restart.** Once the files are new, the start screen saves its open editors to `~/.local/state/designlayer/resume.json` and runs `launchctl kickstart -k` on this LaunchAgent, in a process group of its own. launchd stops the desk and the start screen with it, and starts the desk again from the updated folder. The new start screen reopens the saved editors on their remembered ports.
- **Window.** The desk page carries the commit it was served from. When `/api/health` reports another commit, the window reloads and keeps its tabs. A background tab whose editor restarted loads it again when you select it.
- **Download installs** (no `.git`) carry `.designlayer-source.json`, the commit `package.mjs` built them from. The update downloads the new commit's archive and installs it in `app.updating` beside `app`, with the same payload list (`runtime/payload.mjs`), then swaps the two folders.
- **Testing it.** `DESIGNLAYER_DESK_LABEL` runs a second desk under its own LaunchAgent label, so a test can update and restart it without touching the installed app. Give that agent its own `HOME` too: the desk keeps its tab copy and the editor registry under `HOME`, and a second desk that shares them frames the installed app's editors and takes their sockets.

## Download package

The landing page installs from a git clone (`git clone`, `npm install`, `node desktop/mac/install.mjs`). A clone carries no quarantine flag, so macOS shows no security prompt, and there is no `curl | bash`, which managed Macs warn about. For people without git, `node desktop/mac/package.mjs` builds `Design-Layer-for-Mac.zip` into `dist/`, and CI publishes it at https://phil8-li.github.io/design-layer/downloads/Design-Layer-for-Mac.zip on every push to `main`. Double-clicking its `Install Design Layer.command` makes macOS 15+ show "Apple could not verify … is free of malware": the file is quarantined and unsigned, and right-click › Open no longer bypasses that. The user clicks Open Anyway in System Settings › Privacy & Security once, or runs it with `bash`; the zip's README.txt says both. The zip has no uninstaller to double-click, since that copy would be refused the same way. The installer writes it with `cat` (a new file has no quarantine flag) to `~/Library/Application Support/Design Layer/Uninstall Design Layer.command`, which opens on a double-click or with `bash`.

## Why it is built this way

Nothing is compiled, signed, or downloaded at install time. It uses Apple's `launchctl`, `open`, `osascript` and `plutil`, your existing `node`, and the app shim Chrome writes when it installs a web app (`app_mode_loader`), which gives DesignLayer its own Dock icon and window without bundling Electron or requiring an Apple Developer certificate.

The PWA is installed over Chrome's DevTools pipe (`--remote-debugging-pipe --enable-devtools-pwa-handler`, `PWA.install`). Chrome accepts that only on a non-default `--user-data-dir`, which is why the app has its own profile at `~/Library/Application Support/DesignLayer/Chrome`.

## How the window works

- The start screen and the editor proxies send no `X-Frame-Options` or `frame-ancestors` header (checked in `runtime/`, `server/` and `react-rewrite-cli`), so each one loads directly in an iframe. No reverse proxy is needed. They are all framed on localhost, the host name apps treat as their dev host, and the desk page is on localhost too. That makes every frame same-site with the desk, so an app's `SameSite=Lax` sign-in cookie reaches it. While the page was on 127.0.0.1 the frames were cross-site, and such apps showed as signed out.
- Choosing an app in a Home tab selects the tab already showing that app's editor and closes the Home tab. When no tab shows it, the Home tab becomes that editor's tab.
- Choosing another app inside an editor never replaces that editor, which could lose its unapplied edits. The desk selects the tab already showing the other app, or opens it in a new tab beside this one.
- Each editor has one tab, in one window. As the window opens, an editor tab loads once, on the page its app was last used on: it waits up to 1.5 s for the desk's editor list before it loads anything.
- Tabs are saved per window in the page's storage and mirrored to the desk (`GET`/`PUT /api/tabs?window=<id>`, in `~/Library/Application Support/DesignLayer/desk-tabs.json`). Storage belongs to an origin, so a window that opens with nothing saved, such as the first one on localhost, takes the desk's copy once.
- An editor that is already running gets no tab until you choose it on Home. The window never opens one for you, because an editor's socket takes one client: opening it here disconnects any other window showing it.
- Shortcuts: ⌘1–9 switch tabs, ⌘T opens a new Home tab, ⌘W closes a tab. They only work when focus is on the tab strip or the desk page, because a cross-origin frame keeps its own keystrokes. Chrome can also reserve ⌘T and ⌘W for itself.
- Title bar: the tabs always sit in the title bar (Window Controls Overlay), with no Chrome toggle to move them out, and Extensions lives in the ⋮ menu instead of beside it. That takes the app's Chrome running with `--enable-features=DesktopPWAsWindowControlsOverlayWithNoToggle,DesktopPWAsElidedExtensionsMenu`, which Chrome reads only at launch. The installer and the desk pass it whenever they open the app (`open <shim> --args …`; the shim hands `--enable-features` on to the Chrome it starts). The Dock icon passes nothing, so when the app was opened from the Dock the desk restarts it once with the flag as its window connects: the window closes and reopens with its tabs. The ⋮ menu stays: Chrome draws it for every installed app on the Mac.
- Title-bar glyphs in `symbols/` are drawn at 20px to match the ⋮ button Chrome draws beside them.
- The folder button opens the macOS folder picker (`osascript choose folder`) and copies the path you choose to the clipboard, so you can paste it into the start screen.

## Windows and tabs

- **Widths**: a tab is as wide as its whole name needs, so names show in full while the strip has room. Short of room, the ⌘ shortcuts go first, then the widest tabs give way, down to equal widths and on to a 72px minimum, as Chrome's tabs shrink. The tabs are drawn as Chrome draws them: the active tab runs into the bottom edge with rounded feet; separators sit between the others.
- **Closing several**: after you click a tab's close button, the tabs keep their widths while the pointer stays on the strip. The tab after the closed one takes its width and slides into its place, so its close button is under the pointer and you can click on the spot to close tab after tab. Closing the last tab shares its width out among the rest, which also puts a close button under the pointer. The tabs take their own widths again once the pointer leaves the strip (Chrome's tab closing mode, `TabContainerImpl`).
- **Tooltip**: the localhost address of what the tab shows, with the tab's full name above it only when the tab cuts the name short.
- **Rename**: double-click an app's tab, press F2 on it, or choose **Rename tab…** from its menu, and type. Enter or a click elsewhere saves the name, Escape keeps the old one, and an empty name (or **Use folder name**) gives the tab its folder's name again. The name belongs to the app (its project folder and app port, so two apps from one folder are named apart), not to one tab: it shows in any tab and window for that app, and comes back after the app quits. The desk keeps it in `desk-names.json` beside `desk-tabs.json` (`GET`/`PUT /api/names`). Nothing in the project changes, and the start screen and the editor still show the folder name. Home cannot be renamed.
- **Reorder**: drag a tab along the strip. As in Chrome, a neighbour slides aside as soon as the dragged tab covers half of it (the slot nearest the tab's left edge wins), and the tab lands where you let go. A new slot is taken only after the pointer moves about 16px more, so the row does not jitter at a boundary.
- **Pull out**: drag a tab down out of the strip, or out of the window, and let go anywhere but another window's strip. It opens in a new window under the pointer (see **Size of a new window**). A window's only tab drags its window instead (see **Merge**).
- **Merge**: drag a tab onto another window's strip. That window shows where it will land, and takes it there. A window left with no tabs closes. A window's only tab drags the whole window, as in Chrome: over another window's strip the window hangs just below it, so the strip and the drop slot stay in view. A window the page may not move (one the desk reopened) shows a copy of the tab instead, and its tab can still drop on a strip underneath it.
- **Size of a new window**: the size of the window the tab came from, except that a window filling the screen gives four fifths of the screen, so the strip the tab came from stays visible.
- **Without dragging**: right-click a tab (or press Shift+F10 on it) for **Move to new window**, **Move to window with …** for each other window, and **Close tab**. ⌘⇧← and ⌘⇧→ move the focused tab along the strip. File › New Window (⌘N) opens a window with a Home tab.
- A tab that moves to another window loads its page again there. A frame cannot move between documents without reloading, so the new window loads the page the editor last reported, and takes the editor's socket.
- Each window has an id in its address (`/?window=<id>`): `main` for the one the app opens with. The windows tell each other over a `BroadcastChannel` which editors they show, where their strips are on screen, and which window was used last. A page from Open in Mac app opens in the window that shows its editor, or else in the window used last.
- Pulling a tab out calls `window.open` with the drop point. Chrome allows that only for a few seconds after a press, so after a longer drag the page asks the desk instead (`POST /api/windows/open`), which opens the window without a position.
- **Quitting and reopening**: Chrome reopens only the app's first window. That window asks the desk to reopen the others, and the desk runs Chrome on the app's profile with `--app-launch-url-for-shortcuts-menu-item=<window address>`, which opens an app window there. If the desk cannot open a window, its tabs join the first window.
- **Which windows come back**: every window open when the app quit. A window you close while another stays up does not: Chrome drops any request a closing window sends, so a window still up tells the desk 2 seconds later, unless the closed window reloaded and is back by then. A window that gives its last tab away waits for the desk to note it is gone, then closes. The desk keeps that note for a day and drops any save older than the copy it holds, so a late save cannot bring a closed window back.

## Open in Mac app

An editor in an ordinary browser tab shows an **Open in Mac app** banner at the bottom of its left panel. Clicking it moves that page into the app:

1. The editor POSTs its URL to `http://localhost:3454/api/open`. The body is JSON sent as `text/plain`, so the cross-origin request needs no preflight. The desk echoes CORS only to loopback origins and refuses anything that is not an http page on this Mac.
2. The desk passes the URL to the app window over `GET /api/events` (server-sent events). If the window is closed, the desk holds the URL for up to 60 seconds and gives it to the first window that connects. A desk page open in an ordinary browser tab only gets a URL when no app window is open.
3. The desk runs `open` on the app shim to bring the window forward, or to launch it. With the `--app-window` fallback there is no shim, so it starts that Chrome window only when none is open.
4. The window opens the page in the tab that already shows that editor, or in a new tab. Taking the editor's socket disconnects the browser tab.

The banner appears only when both of these are true:

- **The app is installed.** The launcher checks for this LaunchAgent's plist when it starts (`runtime/mac-desk.mjs`), so a browser that has never seen the desk makes no requests to it. An editor started before the app was installed shows the banner after its next restart.
- **The editor is not already in the app.** Each app tab's iframe is named `designlayer-desk:<tab id>`, and the editor checks that name. It also checks `location.ancestorOrigins`, for frames created before the desk started naming them.

## Limits and fallback

- **If the Chrome app shim cannot be created or opened**, use `install.mjs --app-window` instead: it opens `Chrome --app=http://localhost:3454/ --user-data-dir=<the same profile>`, which runs Chrome directly and needs no shim.
- **Homebrew node upgrades**: the plist uses the stable `/opt/homebrew/bin/node` symlink rather than the versioned Cellar path, so `brew upgrade node` needs no reinstall.
- The window needs the desk server. When the server is down, the service worker shows an offline page with the command to start it.

## Troubleshooting

- Logs: `~/Library/Logs/DesignLayer/desk.log` (desk) and `start-screen.log` (start screen and the editors it starts).
- `launchctl print gui/$(id -u)/dev.designlayer.desk` shows the agent's state and last exit code.
- "A Chrome instance is using …/DesignLayer/Chrome": the app's Chrome did not quit within 10 s. Quit the DesignLayer app (⌘Q) and run the command again.
