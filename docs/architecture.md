# Architecture, security, and performance

## What it writes, and where

- **Your component source**, never for a Design panel edit: those become notes
  that your coding agent makes in code. Only an explicit write such as a lint
  fix or a saved control default reaches a file, and only for files
  that pass both the extension allowlist and a denylist you cannot widen
  (`.env*`, `*.config.*`, `node_modules`, `.git`). If `source.roots` is set,
  files outside those roots are refused as well. Lint fixes run one at a time,
  so two fixes to one file cannot drop each other's change.
- **`<stateDir>/options.json`** — saved option sets, written atomically.
- **`<stateDir>/requests/`** — one markdown file per handover, carrying the same
  brief the Copy button writes. Written even when an agent is attached over MCP:
  the file is the durable record, the queue push is only the trigger, and the
  two answer different questions a week later.
- **`<stateDir>/endpoint.json`** — the ports actually bound, so tooling can find
  a running instance without guessing. Best-effort: the start screen learns that
  an editor is up over IPC from the child that bound the ports, so a project
  folder that refuses the write still starts. Removed when the editor exits.

## Security model

This process edits files in your project, so it is a development tool and
nothing else. Ship it nowhere near production.

- Every route refuses a request that is not loopback, by peer address, `Host`,
  and `Origin`.
- All three servers are forced to bind `127.0.0.1`, overriding the vendored CLI,
  which binds every interface.
- The MCP endpoint applies that same guard, rather than a second copy of it. The
  transport spec requires `Origin` validation against DNS rebinding, and it is
  reachable by anything on the machine that can open a socket — so it shares the
  routes' own `isLocalRequest`, including the part that treats `Origin: null` as
  hostile rather than absent.
- The file allowlist above is the only thing standing between the browser and
  `.env.local`, which lives in the same project root as your components. Keep
  `source.extensions` restrictive.

### What leaves your machine

Nothing, and there is no setting that changes it. The editor opens no connection
to anything but the dev server you pointed it at and loopback. It holds no API
key, sends no telemetry, and never calls a model: handing work over means writing
a brief to `<stateDir>/requests/` and waking a coding agent you are already
running, over MCP on `127.0.0.1`.

That agent is of course free to send your source anywhere it likes — but it is
*your* agent, running under whatever rules you already gave it, and this tool
adds nothing to that.

It was not always true. An earlier version could send the selected element and
its whole source file to the Anthropic API when `ANTHROPIC_API_KEY` was set, and
the `agent.transport` setting existed to turn that off. Both are gone with the
"Ask AI" panel that was the only way to reach them, so the answer no longer
depends on your environment.

If your employer restricts which AI services may see your source code — many do,
and the rule usually covers anything you write at work — the question to ask is
about the coding agent on the other end of the handoff, not about this editor.

## Performance boundary

The host application never imports this package. A normal development server
and every production build therefore ship zero editor JavaScript; the editor
bundle is injected only by the separate proxy started with `designlayer`.

While that proxy is active, selection geometry is tracked only while an element
is selected, hovered, or highlighted. The shared animation-frame loop batches
layout reads before overlay writes, reads computed styles only while Option/Alt
measurement is active, and rests once the page has held still — woken by
anything that can move an element (a DOM change, a CSS or WAAPI animation,
scroll, resize, input). A selection, walk or show/hide is drawn in the task
that caused it, not on the next frame.

On a client-rendered app the editor mounts in the task that commits the app,
so the app is laid out once, already inset beside the panels; a page that
hydrates server markup still waits two paints. The vendored engine boots after
the app has rendered, not before.

The editor's script is built once per change of its inputs and served
compressed under a versioned URL, so a reload runs it from cache, and Chrome
reuses the code it already compiled. Canvas view's frames are served without
it. React and Sonner, which only draw toasts, are a module of their own,
`dist/toaster.js`, loaded at idle after the first input or with the first
toast, never while the app is waiting to render. A launch on an untouched tree
skips the bundle freshness compile, because the last build left a stamp of what
it was built from. The vendor's source-write engine (jscodeshift) loads only on
first use, which the editor no longer asks for.

`node tools/perf.mjs` measures every flow — launch, boot, hover, select, the
panels, Send to agent, toasts, canvas view, the start screen and the server routes — in a real
browser against a throwaway host it stands up on free ports. `--label <name>`
saves a run and `--compare <name>` prints the speedup against a saved one.

## Layout

Every file outside `src/`, `test/` and `docs/`. `src/` is listed by folder,
with the files a maintainer most often needs.

```
cli.mjs                     argv contract, entry point, and the app supervisor (one editor per app)
config.mjs                  defaults, discovery, resolution, browser prelude, host detection
build.mjs                   bundles src/ into dist/designlayer.js, dist/toaster.js and dist/tokens.mjs
designlayer.config.example.mjs  every config key, commented
launch/DesignLayer.command  double-click launcher: the start screen of a remote dev box
runtime/start-screen.mjs    the loopback server behind the no-arguments flow, and its editors by id
runtime/start-screen-page.mjs   its document, and the script that drives it
runtime/start-screen-style.mjs  its stylesheet, built from the editor's tokens
runtime/start-choice.mjs    validates a start-screen choice (address, folder, dev script)
runtime/local-apps.mjs      port scan and project inspection for the start screen
runtime/dev-server.mjs      starts the host's dev script and waits for it to answer
runtime/editor-ports.mjs    each app's proxy and socket ports, remembered across restarts
runtime/editor-registry.mjs every editor running on this machine
runtime/last-pages.mjs      the page each app was last used on, one file per app
runtime/app-storage.mjs     notes and their settings, kept for every origin of an app
runtime/app-name.mjs        the name every surface shows for an app: its project folder
runtime/chooser-url.mjs     where the start screen is, for the launcher and server/apps.mjs
runtime/mac-desk.mjs        where DesignLayer.app's desk is, when this Mac has one
runtime/mcp-hub.mjs         the start screen's MCP endpoint, for "Stay on between apps"
runtime/updater.mjs         checks GitHub for a newer main, updates this copy, restarts it
runtime/payload.mjs         the files a copy without .git runs from (the Mac download, an update)
runtime/state-dir.mjs       ~/.local/state/designlayer, and the package's one temp-and-rename writer
runtime/loopback.mjs        the loopback guard every route, the MCP endpoint, the start screen and the desk apply
runtime/http-error.mjs      the one way a server or start-screen module refuses a request
runtime/exit-hooks.mjs      one exit path for every process
runtime/project-facts.mjs   manifest and framework file names
runtime/config-file.mjs     where a host's designlayer.config.mjs is, without loading it
runtime/source-guard.mjs    which files the server may read and write
runtime/launcher.mjs        vendor resolution, monkey-patches, route mount, publication
runtime/overlay-responder.mjs   the overlay script: built, cached, compressed, versioned
runtime/bundle-stamp.mjs    what the last build compiled from, so a launch can skip the check
runtime/board-frame.mjs     keeps the editor out of canvas-view frames, and lets them load
runtime/open-browser.mjs    opens the editor URL, not the one the vendor would open
runtime/proxy-retry.mjs     retries a proxied GET or HEAD whose upstream connection failed
runtime/vendor-patch.mjs    the 31 exact-once splices against react-rewrite-cli 0.1.1
runtime/vendor-server-patch.mjs one fix to the vendor's server-side batch writer
runtime/vendor-lazy.mjs     keeps jscodeshift out of the launch, loads it on first use
runtime/favicon.svg         the start screen's icon
server/routes.mjs           loopback-guarded HTTP routes
server/http-json.mjs        JSON replies, body reader, content-type check
server/serial.mjs           a promise chain that runs tasks one after another
server/file-io.mjs          the file cache, limiter and known-size read the server modules share
server/babel.mjs            the host-first @babel/parser loader and its one plugin list
server/agent.mjs            the /agent route: writes the request file, queues the change for MCP
server/handoff.mjs          the change queue between Send to agent and wait_for_change
server/mcp.mjs              the MCP server: four tools over JSON-RPC
server/mcp-control.mjs      where the editor's MCP endpoint runs: here, or relayed to the start screen
server/apps.mjs             the other apps running on this machine, relayed for the page
server/pages.mjs            the host's pages, read from its source tree for canvas view
server/angular-source.mjs   Angular component index and template scan
server/react-source.mjs     the JSX walk component usage counts from
server/element-match.mjs    descriptor scoring for the Angular lookup
server/component-usage.mjs  how many places render a component
server/variants.mjs         a component's declared variant axes
server/companions.mjs       companion scripts loaded beside the editor
server/control-defaults.mjs configured literal default reader/writer
server/options-store.mjs    saved option sets
server/design-lint.mjs      the design-system audit and its fixes
server/design-system-config.mjs token manifest and authored-alias normalization
server/design-system-detect.mjs where a project's own design system is, when nobody said
server/design-system-manifest.mjs validates the manifest and the designSystem config blocks
server/design-system-aliases.mjs traces authored CSS variables and theme aliases to tokens
server/icon-set.mjs         the host icon set, read once and served on request
server/libraries.mjs        the libraries a project has added, and their pointer file
server/library-sources.mjs  library parser facade: kinds, reader version, detection
server/library-catalog.mjs  the catalog shape every library reader produces
server/library-common.mjs   helpers every library reader and the manifest share
server/library-classify.mjs which axis a token belongs to, read off its name
server/library-values.mjs   a CSS value as far as a library file can settle it
server/library-css.mjs      a stylesheet read as a design system
server/library-tokens.mjs   a DTCG or Style Dictionary token file read as a design system
server/library-icons.mjs    an icon file read as glyphs
server/library-components.mjs the components a React or Angular library declares
server/library-url.mjs      URL scraping and the reading cascade
server/library-fetch.mjs    one URL fetch: redirects, sign-in walls, the helper command
server/library-auth.mjs     credentials for design-system URLs behind a sign-in wall
server/library-signin.mjs   signs in through the site's own page, in a browser window
server/cdp-browser.mjs      a small driver for a Chromium browser over the DevTools protocol
src/index.ts                entry point; publishes window.__designlayer.boot
src/core/                   store, config, bridge, tokens, icons, history, the shared DOM helpers
src/core/css/               the editor's stylesheets, one module per surface
src/core/store.ts           editor state, and the EditorMode machine (one reader, one writer)
src/core/prefs.ts           guarded localStorage preferences
src/core/api.ts             sendJson, the JSON transport the lint and library stores share
src/core/angular.ts         the Angular half of "where is this element written"
src/core/element-target.ts  how the browser describes an element to the server
src/core/element-code.ts    a selected element written out as JSX or HTML, for Copy as code
src/core/sizing.ts          a length the layout honors, for the canvas handles and the W/H fields alike
src/shell/                  toolbar, panel rail, launcher button, desk bridge
src/shell/resize.ts         the panel rail: motion-panels' core wired to plain DOM
src/shell/drag.ts           the floating-chrome drag gesture
src/shell/insets.ts         the panel inset readers
src/canvas/                 selection, handles, measuring, text editing on the page
src/canvas/gesture.ts       the one pointer-gesture tracker: capture, threshold, every cancel
src/canvas/modifiers.ts     the shared Alt/Shift tracker
src/canvas/text-edit.ts     text retyped on the page becomes an edit note
src/panels/                 left panel, layers, app chooser, controls
src/panels/arm.ts           arm before a costly press
src/panels/pane.ts          whether a left-panel pane is on screen
src/panels/page-reporter.ts the page this document is on, filed with the server
src/panels/inspector/       the right panel: Design, Changes and Design system tabs
src/panels/inspector/index.ts   SECTIONS, the Design tab's section registry
src/panels/inspector/parked-paint.ts paints the eye has switched off
src/annotations/            notes, the edit journal, the brief, the send
src/annotations/edit-words.ts  what an edit note says: a plain sentence for the designer, instructions for the agent
src/annotations/output.ts   the brief Copy and Send to agent write
src/annotations/handover.ts the send flow, as one state value
src/ai/transport.ts         the one call to the /agent route
src/board/                  canvas view: frames, camera, page list
src/libraries/              the Libraries section and its store
src/lint/                   lint findings, markers, and the selector resolver
src/options/                option sets and saved control defaults
tools/build-icons.mjs       vendors src/core/icons.ts from Phosphor; owns the name mapping
tools/build-notices.mjs     writes THIRD_PARTY_NOTICES.md
tools/build-sonner-css.mjs  vendors Sonner's stylesheet into src/core/css/sonner-css.ts
tools/sonner-plugin.mjs     esbuild plugin: Sonner, patched at bundle time
tools/strip-css-comments.mjs esbuild plugin: CSS prose comments stripped at bundle time
tools/motion-budget.mjs     the motion budget npm test runs (+ motion-budget.json)
tools/contrast.mjs          every ink-and-fill pair the chrome renders, measured (used by a suite)
tools/perf.mjs              the performance harness
tools/board-e2e.mjs         real-browser check of canvas view
tools/clipboard-e2e.mjs     real-browser check of every Copy
tools/design-panel-e2e.mjs  real-browser check of the Design tab's flows
tools/measure-e2e.mjs       real-browser check of the Alt/Option spacing readout
tools/resize-e2e.mjs        real-browser check of resizing
tools/shortcut-e2e.mjs      real-browser check of ⌘. hide and show
tools/tracking-e2e.mjs      real-browser check that the outline follows a moving element
tools/panel-harness.mjs     renders the Design tab in a real browser and measures it (+ -scene.js)
tools/concentric-audit.mjs  the browser half of the concentric-radius check
tools/before-after.mjs      renders one state before and after a change, side by side
tools/break.mjs             surfaces rendered under worst-case content (+ chrome-demo-scene.js)
tools/toast-gallery.mjs     every toast on one page, through the real toaster
tools/icon-sticker-sheet.mjs  before/after sheet of the glyph set, written to .demos/icons/
tools/icons/                frozen legacy glyph artwork
desktop/mac/install.mjs     installs, reports (--status) and uninstalls the Mac app
desktop/mac/agent.mjs       every launchctl write; saves resume.json before a restart
desktop/mac/launch-agent.mjs  the LaunchAgent plist, as a pure function
desktop/mac/desk-server.mjs the desk: the loopback server the Chrome app window loads
desktop/mac/shell-page.mjs  the desk shell: tab strip and one iframe per tab
desktop/mac/chrome-pipe.mjs the app's Chrome: where it is and how it is opened
desktop/mac/package.mjs     builds Design-Layer-for-Mac.zip
desktop/mac/make-icons.mjs  renders the app icons from icons/app-icon.svg
test/run.mjs                the runner npm test calls
test/host.mjs               where this package is, and where a host app is
test/ui-change-cases.mjs    the vendor engine's write protocol, against a live editor
```

`runtime/` owns the vendor patches (`vendor-patch.mjs`,
`vendor-server-patch.mjs`, `vendor-lazy.mjs`, `launcher.mjs`). Everything the
patches need about your app arrives as resolved config. The editor also talks
to the vendor through its bridge and its overlay markup (`src/core/bridge.ts`,
`src/core/dom.ts`, `src/shell/vendor-chrome.ts`, `src/board/`), so replacing the
vendor touches those files as well.

## Third-party code

### Open source it uses

designlayer is built on other open source projects, and some of their code
ships with it: Motion and motion-panels are compiled into
`dist/designlayer.js` and React and Sonner into `dist/toaster.js`, Sonner's
stylesheet and Phosphor's icon paths are copied
into `src/`, and the edit engine is
[React Rewrite](https://github.com/donghaxkim/react-rewrite). All of them are
MIT or ISC licensed. [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) lists
every dependency with its version, license and role, and reproduces the full
license text of each project whose code is included.

That file is generated by `node tools/build-notices.mjs`, which reads the
bundle's contents from esbuild rather than from a hand-kept list;
`npm run verify` fails if it has gone stale.

### Icons

The editor's glyphs are [Phosphor](https://phosphoricons.com) (MIT), regular
weight, vendored as path data by `tools/build-icons.mjs` from
`@phosphor-icons/core` rather than imported, because the overlay bundle takes
no runtime dependencies. Change which glyph a name draws by editing the mapping
in that script and re-running it; `npm run verify` fails if its output has gone
stale. Seventeen glyphs — the bottom toolbar except the pointer, ExternalLink,
the object-align marks and Trash — keep their earlier artwork, frozen in
`tools/icons/legacy-glyphs.json`; `DESIGN.md` has the rule. `node
tools/icon-sticker-sheet.mjs` writes a before-and-after sheet of the whole set
to `.demos/icons/`; `--before=<rev>` picks the revision to compare (default
HEAD).

Three rules hold that set together, and each is enforced rather than documented
and hoped for:

- **One size ramp: 12, 14, 16, 18, 20, 24.** Call sites name a role from
  `tokens.icon` and `IconSize` makes anything off the ramp a compile error.
- **One grid, never re-windowed.** Phosphor's 256 grid is rewritten onto the
  shared `0 0 24 24` viewBox, so the size a call site asks for is the box it
  gets. A few glyphs carry a `scale` that keeps their ink extent close to the
  set they replaced.
- **Pressed is heavier; a toggle that is on is filled.** Every glyph is a
  filled outline stroked on top at its rung's width; the stylesheet adds half a
  unit when the control reports `aria-pressed` / `aria-selected`. The toolbar
  toggles ship Phosphor's fill weight for their on state.
