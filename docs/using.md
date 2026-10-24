# Using DesignLayer

## Requirements

- Node >= 20.9
- A React app (Next.js, or Vite) or an Angular app, with a dev script (the start
  screen and `--dev` both run it for you; with neither, start the dev server
  yourself first). Which one it is is detected from the host's `package.json` —
  see [Angular hosts](angular.md).
- App Router and Pages Router are both supported, and neither requires a
  `next.config` file. The overlay can inspect any Next app; durable layout and
  appearance edits currently write Tailwind utilities, so full visual editing
  requires Tailwind. Text edits do not.
- A project under a folder macOS guards — Documents, Desktop, iCloud Drive — is
  supported. Such a folder can read perfectly and still refuse `stat`,
  `realpath`, `mkdir` and `write` to this process, which is enough to break a
  tool that assumes a readable path is a fully usable one. The config is read as
  source rather than imported, the working directory is taken from config rather
  than read back from the OS, and the containment guard and control defaults
  degrade instead of refusing.
- The package installs `react-rewrite-cli@0.1.1` exactly. The runtime patches
  that build's minified bundle at serve time against 31 pinned anchors; a
  different version will not patch, and the launcher tells you so instead.

## Install


The package is not on npm. Install it from source as a development
dependency; its prepare script builds the browser bundle on install.

1. Clone it beside your app, install the checkout's own dependencies (npm
   does not install them for a folder dependency, and its prepare script
   needs them), then add it to your app:

   ```sh
   git clone https://github.com/phil8-li/design-layer.git
   cd design-layer && npm install && cd ..
   cd your-app && npm i -D ../design-layer
   ```

   To try it without touching your app, run `npx designlayer` inside the
   checkout and pick your app on the start screen.

   To hand off one immutable artifact instead, run `npm pack` in this package
   and install the resulting `.tgz` file.

2. Optionally add the scripts. The start screen needs neither — they are the
   shortcut for a project you open every day:

   ```json
   {
     "scripts": {
       "design": "designlayer --dev --open 3000",
       "verify:designlayer": "designlayer --verify"
     }
   }
   ```

3. When developing the package itself, rebuild after a change under its `src/`:

   ```sh
   npm run build
   ```

   You will rarely have to. The launcher compares `dist/` against `src/` at
   startup and rebuilds a bundle that has fallen behind, saying so in a line you
   cannot miss — an editor that silently served last week's `src/` is the kind
   of thing that gets debugged for an hour. Installing a prebuilt `dist/` with
   no `esbuild` present is still supported: it starts, and serves what it has.

4. Ignore the state directory:

   ```
   .local/designlayer/
   ```

   ## Known limitations

- React appearance edits write Tailwind utilities; text edits do not need Tailwind. See [Requirements](#requirements).
- Angular writes touch static template markup only. `[style.x]`, `[class.x]`, `[ngClass]`, interpolations, and `@if` / `@for` are left as they are. See [Angular hosts](angular.md).
- A Vite app is classified as React, including one that is Vue, Svelte, or something else. See `DEV_SERVERS.vite` in [`config.mjs`](../config.mjs).
- Two agents calling `wait_for_change` both receive the same change. There is no claim. See [Agent handoff](agent-handoff.md).
- The package is `"private": true` and is not on npm. Install is from a clone. See [Install](#install).
- `token-cases`, `responsive-cases`, `picker-cases`, and `icon-set-cases` skip unless a host app is on disk, and CI does not provide one. See [Testing](testing.md).

## Updating

DesignLayer checks GitHub for new commits on `main` a few seconds after the
start screen opens, then every six hours. When it finds some, the start screen
shows **Update available** with what changed, and the Mac app shows the same
in its title bar. **Update and restart** brings this copy up to date, rebuilds
it, and restarts it. Editors that were open start again on the same ports, so
a tab that showed one only needs a reload. Unapplied edits in an open editor
are lost, so apply or send them first.

From a terminal:

```sh
npx designlayer --check-update   # say whether main has new commits
npx designlayer --update         # update, then restart designlayer yourself
```

What gets updated depends on how DesignLayer was installed:

| Install | Update |
| --- | --- |
| A git clone (the README, the landing page, `npm i -D ../design-layer`) | Fast-forwards `main`, then runs `npm ci` if the lockfile changed, else the build. A failed build puts the clone back on the commit it was on. |
| The Mac download (`Design-Layer-for-Mac.zip`) | Downloads that commit's archive from GitHub, installs and checks it beside the app, then swaps the folders. The running copy is untouched until the swap. |
| A packed `.tgz` | Not updated. Install the new version the way you installed this one. |

A clone with uncommitted changes, on another branch, or with commits that
`main` does not have is never touched: the start screen says why, and you
update it with git. Set `DESIGNLAYER_NO_UPDATE_CHECK=1` to turn the check off.

## Start

```sh
npx designlayer
```

With no arguments it opens a start screen in your browser and asks which app to
edit, which page of it to open, and where its source is.

- **Which app.** It scans the usual dev-server ports and lists what answered, by
  page title, so `Host App` is what you click rather than `127.0.0.1:3000`.
  Nothing running yet is fine — type the URL you want and it will start the app
  for you. A running app usually knows its own folder, so picking a row fills
  the folder in for you; a row that cannot work its folder out clears the field
  and says so, rather than leaving the previous row's folder standing.
- **Which page.** The URL is where you say it. Type `127.0.0.1:3000/pricing` and
  that is the page you land on, not the app's `/`.
- **Where its source is.** Type or paste the folder's full path. `~` works, and
  so does a folder dragged onto a terminal — the shell's escaping is undone for
  you — so Finder's Copy as Pathname, `pwd`, and the command line of the running
  dev server all produce something the field takes as-is. It reads that folder's
  `package.json` to confirm it is the right project and to find the dev script,
  and tells you what it is about to run before you commit to it.

Press the button and it does the rest: starts the dev server if it has to, waits
for the app to answer, mounts the editing proxy in front of it, and puts the tab
you are already in onto the editor. The page you land on is your app — the
editor is the chrome around it.

An app that is throwing still opens. A dev server answering 500 has plainly been
found, and a broken render is exactly when you want the overlay in front of it.

That is the whole flow, so nothing about your project has to change first. There
is no config file to write, no script to add, and no dependency to install into
the app you are editing.

## Getting the editor out of the way

**⌘. — Ctrl+. on Windows and Linux**, the same key Figma uses, and the collapse
button in the toolbar does the same thing. The panels slide out to the edges
they are docked to, the bar drops through the bottom, and the app gets the full
window and its own clicks back — the same pass-through as interactive mode, with
nothing left on screen to argue with it. What stays is one round button in the
bottom-right corner; press it, or the shortcut again, and everything comes back.

The shortcut works from anywhere on the page, including while the editor is
hidden and the focus is somewhere in your app — it is the way back, so it cannot
depend on the editor having the keyboard. Typing a full stop into one of the
editor's own fields is left alone.

Drag that button somewhere else if it is standing where you want to look. It
stays inside the window, it remembers where you left it, and the drag that ends
on it does not also count as a press.

## Resizing the panels

Grab the inner edge of either panel and pull. There is no gutter and no grip to
find — the hairline between the chrome and your app *is* the handle, and it
lights up when the pointer is near enough to take it. Your app reflows while you
drag rather than when you let go, so the layout you widened the inspector to
look at is the layout you end up looking at.

| Gesture | Does |
| --- | --- |
| **Drag** the inner edge | Resize. The app follows live. |
| **Arrow keys** on a focused edge | 10px a press; 50px with Shift, or Page Up/Down |
| **Home / End** | Straight to the narrowest or widest the panel may be |
| **Double-click** the edge | Back to the width it started at |
| **Drag past half the minimum** | Closes the panel, same as its toolbar toggle |

Each panel keeps its own bounds: it will not go narrower than its contents can
use, and neither may take more than about a third of the window, so the canvas
stays the largest thing on screen. Shrink the window under two wide panels and
they give room back until the app has room to be looked at; grow it again and
they return to the widths you set. Those widths outlive the tab.

The resizing is [`motion-panels`](https://motion-panels.letstri.dev), wired
through its framework-agnostic core rather than its React adapter, because this
overlay is plain DOM. The library owns the drag, the bounds, the keyboard map
and the settle; the panels keep their own stylesheet, and nothing about how the
chrome looks at rest moved to make room for it.

## The canvas is your app's viewport

The panels do not cover your app — they take room from it. The strip between
them is inset as padding on `<html>`, so an app laid out in percentages reflows
into it on its own, and two more things are made to agree with it:

- **Viewport units.** `100vw` means the window, and the window does not change
  when a panel opens, so an app sized that way used to stay full width and run
  on underneath the inspector. Those declarations are re-pointed at the canvas
  while the editor is up, in the live CSSOM — no file is touched, and hiding the
  editor with <kbd>⌘.</kbd> puts every one of them back.
- **Breakpoints.** A `@media (max-width: 1024px)` is asked about the canvas
  rather than the window, so a 940px canvas inside a 1440px window wears the
  layout it would wear in a 940px window — measured on a real prototype, down to
  the pixel. Close the inspector and the app crosses its own breakpoints as it
  widens.

Four things stay on the window, because nothing here can honestly move them:
`position: fixed` chrome (inherent to insetting without a transform, and the
alternative would break shared-element morphs), stylesheets served from another
origin, `vw` written into an inline `style` attribute, and `matchMedia` in your
app's own JavaScript. If one part of a layout ignores the panels, it is almost
always one of those four.

## Every page at once: canvas view

Press the grid button, third in the toolbar, or **⇧1**. The page you are on
shrinks into a frame on a board, and every other page of the app appears beside
it, each laid out at the width you were editing at. Each frame is your real page
running in an iframe, so fixed headers, breakpoints and data all look the way
they do live.

| Gesture | Does |
| --- | --- |
| **⌘/Ctrl + scroll**, or pinch | Zoom around the pointer |
| **Scroll**, **Space + drag**, middle-drag, arrows | Pan |
| **+** / **−**, **⇧0**, **⇧1** | Zoom in or out, 100%, fit everything |
| **Live** (top-right of a frame, on hover) or double-click | Back to the live page, on that page |
| **Esc**, or the grid button again | Back to the live page you came from |

Going live on the page you came from is instant: that page never went away, it
was behind the board. Going live on another page flies into its frame and then
moves the live page there: client-side when the app's router answers (Next's
Pages Router, or any router that listens for `popstate`), and with an ordinary
page load when it doesn't.

Collapsing the editor with **⌘.** keeps you on the board. The board takes the
room the panels gave up, and the frames are laid out again at the new width.

Which pages appear: the routes read from the project (Next `app/` and `pages/`,
React Router and Angular route files, from `GET /__designlayer/pages`) plus the
links on the page you are on. A dynamic route such as `/blog/[slug]` appears when
the page links to a concrete one. The board shows up to 16 pages, and keeps up to
8 of them loaded at once, loading the rest as you pan toward them.

Frames never contain the editor. The launcher keeps the editor bundle out of
every frame, and each frame also hides the editor's chrome, the vendor overlay,
companions and your configured dev chrome. An editor started before canvas view
was added can't guarantee that, so there the toggle says to restart the editor
instead of opening. A page the host would refuse to show in an iframe
(`X-Frame-Options`, CSP `frame-ancestors`) is let through for same-origin iframe
requests only; every other response keeps those headers.

## Switching apps

The chooser lasts as long as the session, not as long as the first app you pick.
The command you ran stays a supervisor on 3455 and never becomes an editor
itself; each app you choose is a child process it starts and watches. So
designing a second app is not a quit and a restart.

Several apps can be open at once, one editor each. Starting an app never stops
another app's editor: the first app's editor keeps running, on its own proxy
port. Choosing an app that already has an editor goes to that editor instead of
starting a second one. An editor stops only when you press **Stop** for it on
the start screen, when it crashes, when you choose a different project folder
for the same app port (that one editor is replaced), or when the supervisor
exits.

Each app keeps its proxy port across restarts, because some editor settings are
still stored per browser origin: the first app gets 3456 (socket 3457), the next
3458/3459, and so on, skipping ports already in use. The pairs are remembered in
`~/.local/state/designlayer/ports.json`. Passing `--proxy-port`/`--ws-port` to
the supervisor moves the first pair; the rest follow from there. When those ports
are free, the first editor takes them even if its app remembers another pair.

Notes, their settings and preview-only changes are kept on this machine, in
`~/.local/state/designlayer/storage/`, as well as in the browser. They follow an
app across ports, host names and the Mac app. Notes saved before this version
live only in the browser at the address they were made on; open that address
(for example http://127.0.0.1:3456) once and they are brought over.

From inside the editor, the **Choose app** pill in the toolbar is the way back.
Unapplied changes and uncopied prompts live only in that tab, so the first click
arms the control rather than leaving — it asks, and reverts on its own if you
walk away. An editor started any other way has no such pill, because there is no
chooser behind it to return to.

## From the command line instead

If you already know the port, name it and the start screen is skipped:

```sh
npm run design            # designlayer --dev --open 3000
```

If a dev server is already up on the port, it attaches to that one instead and
leaves it alone, including on the way out: `Ctrl+C` only stops a server this
command started.

Without `--dev` the app has to be running already, and the launcher says so
rather than failing inside the vendor's health check. Without `--open`, open the
**proxy** URL it prints — not your dev server. The line to trust is the one
prefixed `[designlayer]`; the vendored CLI prints a banner just above it that
reports the ports it asked for rather than the ones it bound.

```
designlayer [appPort] [options]

  (no arguments)          Open the start screen: pick a running app and its folder
  appPort                 Dev server port (default: app.port, else framework detection)
  --start / --no-start    Force or skip the start screen (default: when no port is known)
  --dev                   Start the app's dev server too, and attach when it is up
  --dev-script <name>     npm script --dev runs (default: app.devScript, "dev")
  --config <path>         Config file (default: nearest one above cwd)
  --project-root <path>   Project the config loads against (default: the current folder)
  --start-screen-port <n> Port for the start screen (default: 3455, else any free port)
  --proxy-port <n>        Port for the editing proxy the browser loads
  --ws-port <n>           Port for the source-edit WebSocket
  --host <host>           Dev server host (default: 127.0.0.1)
  --open / --no-open      Open the editing URL on start (default: no)
  --verify                Check the vendor patch still applies, then exit
  --print-config          Print the resolved config as JSON, then exit
```

`--dev` runs your own npm script with `PORT` set, so whatever that script
already does — env files, wrappers, extra flags — keeps happening. The start
screen takes the same path: the script it names in the hint is the one it runs.

Because the folder you choose is the project root, the config file is discovered
from there rather than from wherever you happened to be standing when you typed
the command.

`--verify` is worth running in CI. It is the check that fails loudly when a
dependency bump moves the vendored bundle out from under the patch.

Every edit is undoable with the platform's own pair — `⌘Z` and `⇧⌘Z` on macOS,
`Ctrl+Z` and `Shift+Ctrl+Z` elsewhere — and with the two toolbar buttons, which
run the same call. The timeline lives on the writer rather than on the panels,
so a section added later is undoable without being wired up for it, and it
covers the preview and its note together: undoing a change also takes its
note out of the Changes tab.

Dragging and resizing on the canvas go through that same writer, so a gesture is
one undo step and one note in the Changes tab, such as "Change the width to
200px (was 120px)". A gesture that moved and resized at once is a single step,
not three.

## As a Dock app on a Mac

`desktop/mac` installs DesignLayer as a Mac app, which is a nicer front door
than a terminal for the way this is actually used: opened in the morning, left
running, switched between apps all day.

Install it from a checkout. A git clone carries no quarantine flag, so macOS
shows no security prompt. The app runs from the checkout, so keep it where it
is:

```sh
git clone https://github.com/phil8-li/design-layer.git
cd design-layer && npm install
node desktop/mac/install.mjs              # install and open it
node desktop/mac/install.mjs --status     # LaunchAgent, health, start screen, app
node desktop/mac/install.mjs --uninstall --yes
```

Nothing is compiled and nothing is signed, which is the constraint it is built
around — a managed Mac will not run an ad-hoc signed binary, and this needs no
binary at all. A user LaunchAgent starts a loopback-only desk server at login,
which keeps the start screen up and restarts it if it dies; the window is a
Chrome-installed web app in its own profile, showing a tab strip of Home, your
open editors, and an offer for each other editor running on the machine. An
existing start screen is adopted rather than killed, and `--uninstall` stops
only the Chrome whose command line names this app's own profile, never your
browser.

Once it is installed, an editor opened in a browser tab shows **Open in Mac
app** at the foot of its left panel. Clicking it hands the page to the app: the
app comes forward (or starts), opens the page in that editor's tab, and the
browser tab disconnects from the editor. The banner is left out inside the app,
and on any machine without it.

[desktop/mac/README.md](../desktop/mac/README.md) has the whole thing, including the policy table it was
designed against. The suite is `desktop/mac/test/desk-cases.mjs`; it is in
`npm test` and skips loudly off macOS.

## Deleting a layer

Select an element and press **Delete** or **Backspace** — the same pair Figma
takes, from the canvas or from a row in the Layers panel. Each row also carries
a trash button beside its lock and eye, for when the keyboard is not where your
hand is. A multi-select deletes as one step, and selecting a parent along with
one of its own children deletes the parent once rather than cutting two
overlapping holes in one file.

**Cmd+Z puts it back**, between the same two siblings it came from, and takes
its "Delete this element" note out of the Changes tab.

Locked layers are not deleted. The tree can still select one — that is the only
way back out of the lock — so the refusal lives with the delete itself rather
than with the canvas.

## Where a change ends up

Every direct edit becomes a note in the Changes tab, written by the editor in
plain words: "Change the text to “Save changes” (was “Save”)", "Change the width
to 200px (was 120px)", "Bring it to the front of its siblings", "Delete this
element". That covers text you retype on the page by double-clicking it, and
layer order changed from the Layers panel or the Arrange buttons. DesignLayer
previews the edit on the page and writes nothing to your source files.

**Copy** and **Send to agent** hand the notes over as a brief with detailed
instructions for each edit: the exact CSS, the Tailwind class to write, and
where to make the change. Your coding agent makes each change in code, the way
it would for a note you typed. See
[Handing changes to your coding agent](agent-handoff.md#the-changes-tab).

The tab repaints as edits land, so an edit made while it is open appears in it.
Only while it is the tab being looked at — a hidden pane is read when you
switch to it, which is what keeps both it and the Code view off the hot path of
a drag.
