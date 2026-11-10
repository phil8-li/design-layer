# AGENTS.md

Instructions for AI coding agents working in this repository. Humans: see
[CONTRIBUTING.md](CONTRIBUTING.md).

If you are an agent *using* DesignLayer to edit someone's app (not editing
DesignLayer itself), read [docs/agent-handoff.md](docs/agent-handoff.md)
instead.

Editor design rules (icons and keyboard included) live in `DESIGN.md`. Read it
before any UI edit, and add new rules there. The landing page is its own
repository, phil8-li/design-layer-landing-page.

## What this is

A visual editor that proxies a running React or Angular dev server, injects an
editor overlay, and turns each edit into a plain-language note. It serves MCP so
a coding agent receives the notes and makes the changes in the host app's
source. DesignLayer itself writes only a lint fix and a saved control default.

## Commands

```sh
npm install          # also builds src/ into dist/ (prepare script)
npm run build        # rebuild dist/ after any change under src/
npm test             # full suite, no host app needed; a bare clone is green
node test/run.mjs mcp board --skip library-signin-live   # filter by substring
node test/mcp-handoff-cases.mjs                          # one suite alone
npm run verify       # generated files are fresh + vendor patch still applies
npx tsc --noEmit     # typecheck src/
```

Run `npm run build && npm test` before saying a change works. Four suites
(`token-cases`, `responsive-cases`, `picker-cases`, `icon-set-cases`) print
`SKIPPED — no host app found` on a clean clone. That is expected; do not point
`DESIGNLAYER_HOST` at another app to un-skip them. `library-signin-live-cases`
opens a real Chrome window. More runner flags: [docs/testing.md](docs/testing.md).

The Mac app is its own surface. Its window loads the desk page at
`http://localhost:3454`, which frames the start screen and the editors, served
by the checkout its LaunchAgent names (`WorkingDirectory` in the plist that
`node desktop/mac/install.mjs --status` prints). After a change to UI the app
shows, open `http://localhost:3454` and check the change there as well as in a
browser tab before you say it works.

## Map

| Path | Owns |
| --- | --- |
| `cli.mjs` | argv contract, entry point, app supervisor |
| `config.mjs` | config defaults, discovery, resolution, host detection |
| `build.mjs` | bundles `src/` to `dist/designlayer.js`, `dist/toaster.js`, `dist/tokens.mjs` |
| `designlayer.config.example.mjs` | every config key, commented |
| `runtime/` | start screen, launcher, port scan, state dir, exit hooks, the patches against `react-rewrite-cli@0.1.1` |
| `server/` | loopback HTTP routes (`routes.mjs`), MCP server (`mcp.mjs`, queue in `handoff.mjs`), the `/agent` handoff, library readers, source lookups for React and Angular |
| `src/` | the editor UI (TypeScript, plain DOM, bundled to an IIFE) |
| `test/` | one `*-cases.mjs` file per area; `test/run.mjs` runs them; `test/host.mjs` locates the optional host app |
| `tools/` | generators (`build-icons`, `build-notices`, `build-sonner-css`), build plugins, the motion budget and contrast sweep used by tests, perf and e2e harnesses |
| `desktop/mac/` | the Mac Dock app (LaunchAgent + Chrome web app) |
| `launch/` | double-click launcher for a remote dev box |
| `docs/` | user documentation |

File list (`src/` by folder): [docs/architecture.md](docs/architecture.md#layout).

## Rules that break builds or reviews

- **The host app never imports this package, and this package never imports a
  host.** A change that breaks this will not be merged.
- **Never commit `dist/`**, `node_modules/`, or `.local/`.
- **No Git LFS files.** People install by cloning `main`, and a clone that
  meets an LFS file stops short on a Mac whose Git LFS setup is incomplete.
  Large media belongs in phil8-li/design-layer-landing-page;
  `test/updater-cases.mjs` fails on an LFS path.
- **Generated files:** `src/core/icons.ts` (from `tools/build-icons.mjs`), the
  Sonner CSS (`tools/build-sonner-css.mjs`) and `THIRD_PARTY_NOTICES.md`
  (`tools/build-notices.mjs`). Edit the generator, re-run it, and let
  `npm run verify` confirm.
- **New dependencies** must be MIT, ISC, BSD, Apache-2.0 or similar. No GPL,
  AGPL, PolyForm, or unlicensed code. Run `node tools/build-notices.mjs` after
  any dependency change.
- **`runtime/vendor-patch.mjs`** splices a minified bundle at pinned anchors. Do
  not bump `react-rewrite-cli` unless the task is to redo those patches.
- **UI copy is asserted by tests and tools.** Changing a label or message means
  updating every place that quotes it
  (`grep -rn "old text" src test tools desktop docs README.md DESIGN.md`).
- **Every route is loopback-only.** Add a route as a branch inside `route()` in
  `server/routes.mjs`: the `isLocalRequest` guard and the JSON content-type
  check run before it. Keep the guard in `server/mcp.mjs`.

## Style

- No linter or formatter: match the file. ES modules, double quotes, no
  semicolons.
- Comments explain a decision, not the line below them.
- Add or update a `test/*-cases.mjs` case with every behavior change. The
  runner finds a new suite file on its own.
- Commit subject: one plain sentence on what the software now does, from a
  user's point of view. No `feat:`/`fix:` prefixes. The body explains why the
  old behavior was wrong.
- Do not add `Co-authored-by:` trailers naming a model. Saying a change was
  AI-assisted in the body or PR is welcome.

## Running it against an app

```sh
npx designlayer                 # start screen on :3455
node cli.mjs --dev --open 3000  # from a host app folder, attach to port 3000
```

The editor is the chrome around the proxied app. MCP listens on
`127.0.0.1:5747/mcp` by default.
