# Architecture, security, and performance

## What it writes, and where

- **Your component source**, only through an explicit edit, and only for files
  that pass both the extension allowlist and a denylist you cannot widen
  (`.env*`, `*.config.*`, `node_modules`, `.git`). If `source.roots` is set,
  files outside those roots are refused as well.
- **`<stateDir>/options.json`** — saved option sets, written atomically.
- **`<stateDir>/requests/`** — one markdown file per handover, carrying the same
  brief the Copy button writes. Written even when an agent is attached over MCP:
  the file is the durable record, the queue push is only the trigger, and the
  two answer different questions a week later.
- **`<stateDir>/endpoint.json`** — the ports actually bound, so tooling can find
  a running instance without guessing. Best-effort: the start screen learns that
  an editor is up over IPC from the child that bound the ports, so a project
  folder that refuses the write still starts.

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
it was built from, and loads the source-write engine on its first write. An
Apply is worked out while the edits settle, so the click only writes the file.

`node tools/perf.mjs` measures every flow — launch, boot, hover, select, the
panels, apply, toasts, canvas view, the start screen and the server routes — in a real
browser against a throwaway host it stands up on free ports. `--label <name>`
saves a run and `--compare <name>` prints the speedup against a saved one.

## Layout

```
cli.mjs                     argv contract, entry point, and the app supervisor
config.mjs                  defaults, discovery, resolution, browser prelude, host detection
build.mjs                   bundles src/ into dist/designlayer.js, dist/toaster.js and dist/tokens.mjs
runtime/start-screen.mjs    the loopback server behind the no-arguments flow
runtime/start-screen-page.mjs   its document, and the script that drives it
runtime/start-screen-style.mjs  its stylesheet, built from the editor's tokens
runtime/local-apps.mjs      port scan, project inspection, folder listing
runtime/launcher.mjs        vendor resolution, monkey-patches, route mount, the cached overlay
runtime/bundle-stamp.mjs    what the last build compiled from, so a launch can skip the check
runtime/vendor-patch.mjs    the 30 splices against react-rewrite-cli 0.1.1
tools/build-icons.mjs       vendors src/core/icons.ts from Phosphor; owns the name mapping
tools/icon-sticker-sheet.mjs  before/after sheet of the glyph set, written to .demos/icons/
server/angular-source.mjs   Angular component index, template scan, template writer
server/react-source.mjs     JSX element removal, the one React write not in the vendor
server/element-match.mjs    descriptor scoring and byte-range splicing, shared by both
server/design-system-config.mjs token manifest and authored-alias normalization
server/icon-set.mjs         the host icon set, read once and served on request
server/routes.mjs           loopback-guarded HTTP routes
server/options-store.mjs    saved option sets
server/control-defaults.mjs configured literal default reader/writer
server/agent.mjs            AI edit transport
src/core/angular.ts         the Angular resolver, edit queue and commit
src/core/element-target.ts  how the browser describes an element to a source writer
src/core/removal.ts         the delete queue, one for both hosts
src/shell/resize.ts         the panel rail: motion-panels' core wired to plain DOM
src/                        the editor UI, bundled to an IIFE
test/host.mjs               where this package is, and where a host app is
test/ui-change-cases.mjs    the harness
```

`runtime/` is the only part that knows the vendored CLI exists. Everything the
patches need about your app arrives as resolved config, so replacing the vendor
later is a change confined to those two files.

## Third-party code

### Open source it uses

designlayer is built on other open source projects, and some of their code
ships with it: Motion and motion-panels are compiled into
`dist/designlayer.js` and React and Sonner into `dist/toaster.js`, Sonner's
stylesheet and Phosphor's icon paths are copied
into `src/`, and the edit engine is
[React Rewrite](https://github.com/donghaxkim/react-rewrite). All of them are
MIT or ISC licensed. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists
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
to `.demos/icons/`.

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
