# AGENTS.md

Instructions for AI coding agents working in this repository. Humans: see
[CONTRIBUTING.md](CONTRIBUTING.md).

If you are an agent *using* DesignLayer to edit someone's app (not editing
DesignLayer itself), read [docs/agent-handoff.md](docs/agent-handoff.md)
instead.

Editor design rules (icons and keyboard included) live in `DESIGN.md`,
landing-page rules in `landing/DESIGN.md`. Read the matching one before any UI
edit, and add new rules there.

## What this is

A visual editor that proxies a running React or Angular dev server, injects an
editor overlay, and writes edits back into the host app's component source. It
also serves MCP so a coding agent can receive notes from the designer.

## Commands

```sh
npm install          # also builds src/ into dist/ (prepare script)
npm run build        # rebuild dist/ after any change under src/
npm test             # full suite, no host app needed; a bare clone is green
npm run verify       # generated files are fresh + vendor patch still applies
npx tsc --noEmit     # typecheck src/
```

Run `npm run build && npm test` before saying a change works. Four suites
(`token-cases`, `responsive-cases`, `picker-cases`, `icon-set-cases`) print
`SKIPPED — no host app found` on a clean clone. That is expected; do not point
`DESIGNLAYER_HOST` at another app to un-skip them.

## Map

| Path | Owns |
| --- | --- |
| `cli.mjs` | argv contract, entry point, app supervisor |
| `config.mjs` | config defaults, discovery, resolution, host detection |
| `build.mjs` | bundles `src/` to `dist/designlayer.js`, `dist/toaster.js`, `dist/tokens.mjs` |
| `runtime/` | start screen, launcher, port scan, the patch against `react-rewrite-cli@0.1.1` |
| `server/` | loopback HTTP routes, MCP server (`mcp.mjs`), source writers for React and Angular |
| `src/` | the editor UI (TypeScript, plain DOM, bundled to an IIFE) |
| `test/` | one `*-cases.mjs` file per area; `test/host.mjs` locates the optional host app |
| `tools/` | generators (`build-icons`, `build-notices`, `build-sonner-css`), perf and e2e harnesses |
| `desktop/mac/` | the Mac Dock app (LaunchAgent + Chrome web app) |
| `landing/` | the marketing site and launch films; independent of the tool, see `landing/AGENTS.md` |
| `docs/` | user documentation |

Full file list: [docs/architecture.md](docs/architecture.md#layout).

## Rules that break builds or reviews

- **The host app never imports this package, and this package never imports a
  host.** A change that breaks this will not be merged.
- **Never commit `dist/`**, `node_modules/`, or `.local/`.
- **Generated files:** `src/core/icons.ts` (from `tools/build-icons.mjs`), the
  Sonner CSS (`tools/build-sonner-css.mjs`) and `THIRD_PARTY_NOTICES.md`
  (`tools/build-notices.mjs`). Edit the generator, re-run it, and let
  `npm run verify` confirm.
- **New dependencies** must be MIT, ISC, BSD, Apache-2.0 or similar. No GPL,
  AGPL, PolyForm, or unlicensed code. Run `node tools/build-notices.mjs` after
  any dependency change.
- **`runtime/vendor-patch.mjs`** splices a minified bundle at pinned anchors. Do
  not bump `react-rewrite-cli` unless the task is to redo those patches.
- **UI copy is asserted by tests.** Changing a label or message means updating
  the cases that assert it (`grep -rn "old text" test/`).
- **Every route is loopback-only.** Keep the `isLocalRequest` guard on anything
  new in `server/routes.mjs` or `server/mcp.mjs`.

## Style

- No linter or formatter: match the file. ES modules, double quotes, no
  semicolons.
- Comments explain a decision, not the line below them.
- Add or update a `test/*-cases.mjs` case with every behavior change, and add a
  new suite file to the `test` script in `package.json`.
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
