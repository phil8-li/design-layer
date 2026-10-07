# Contributing to DesignLayer

Thanks for being here. This is a visual editor for a running React or
Angular dev server: it proxies your app, lets you select an element, and writes
the change back into the component source. Bug reports, docs fixes, and code are all
welcome, and you do not need permission to open an issue or a small PR.

By contributing you agree that your work is licensed under the
[MIT License](LICENSE), and you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Try it on your app** and file what broke. A real app we have not seen is
  the most useful test there is.
- **Pick up a [`good first issue`](https://github.com/phil8-li/design-layer/labels/good%20first%20issue)**
  or anything labeled [`help wanted`](https://github.com/phil8-li/design-layer/labels/help%20wanted).
- **Fix the docs.** If something in [docs/](docs/) took you a while to figure
  out, a clearer paragraph is a welcome PR.
- **Propose a feature** in an issue before building something large, so we can
  agree on the shape first.

## Getting set up

You need Node >= 20.19 and nothing else. There is no database, no service, and
no account.

That floor is the test harness's, not the tool's. DesignLayer itself
supports Node >= 20.9 and package.json says so; `jsdom`, which the suite runs
the editor UI under, declares `^20.19.0 || ^22.13.0 || >=24.0.0` because it
reaches a dependency that `require()`s an ES module. On Node 20.9 through
20.18 the tool builds and runs fine and `npm test` dies with
`ERR_REQUIRE_ESM` before the first assertion. CI keeps both promises honest:
the suite runs on 20.19, 22 and 24, and a separate job builds and verifies the
tool on 20.9.

```sh
git clone https://github.com/phil8-li/design-layer.git
cd designlayer
npm install
```

`npm install` runs the `prepare` script, which bundles `src/` into `dist/`.
`dist/` is generated and never committed — do not add it to a PR. Rebuild it
after any change under `src/`:

```sh
npm run build
```

`npm run verify` checks that the committed source and the built bundle agree
and that the CLI's own contract holds. It is the fastest way to find out you
forgot to rebuild.

## Running the tests

```sh
npm test
```

A bare clone is green, and this is the part worth reading before you conclude
you broke something.

Most suites run against this repository alone. Four of them — `token-cases`,
`responsive-cases`, `picker-cases`, `icon-set-cases` — deliberately pin a real
Next.js app's own token catalog, breakpoints, and icon set. They are the net
that catches a change to the tool silently changing what a real app sees. That
net only exists when such an app is on disk, so on your clone those four print

```
token-cases: SKIPPED — no host app found.
```

and exit 0. A skip is a skip; it is never reported as a pass. Everything the
host-pinned suites prove about decoupling is also proved without a host, in
`test/host-agnostic-cases.mjs`, which runs three synthetic apps out of
`test/fixtures` and never reads the repository the package sits in.

Two things follow from that:

- **You are not expected to supply a host app.** If your change is green on a
  bare clone, it is green. CI runs exactly what you ran.
- **Do not point `DESIGNLAYER_HOST` at some other app to "un-skip" them.**
  The numbers those suites pin are one specific app's, so a different app fails
  them on asset counts rather than on any contract you broke. That is the
  known trade for having a real host in the net at all.

The suite that needs a throwaway app builds its own:

```sh
npm run test:standalone-next
```

It packs the package, installs it into a fresh config-free Next app, and
verifies the proxy and the source-write path in both the App and Pages Routers.
It is slower and it hits the network, so it is not part of `npm test`.

`test/ui-change-cases.mjs` exercises the live write path against a running
editor. Its fixtures are throwaway and it restores the one real component it
touches byte for byte.

## Where things live

[docs/architecture.md](docs/architecture.md#layout) has a `Layout` section that
names every file and what owns what, and [AGENTS.md](AGENTS.md) has a shorter
map. Read it before adding a file — most changes belong in something that
already exists. A few load-bearing rules:

- `cli.mjs` owns the argv contract. `config.mjs` owns defaults, discovery, and
  resolution.
- `runtime/vendor-patch.mjs` holds 30 pinned splices against
  `react-rewrite-cli@0.1.1`, exactly. If you bump that dependency, the patches
  are the work — the launcher is written to tell the user it could not patch
  rather than to serve a half-patched bundle.
- `THIRD_PARTY_NOTICES.md` is generated. After adding, removing or bumping a
  dependency, or copying anyone else's code or assets into the repo, run
  `node tools/build-notices.mjs`; code copied by hand also needs an entry in
  that tool's `VENDORED` map. Only bring in code under a license that allows
  redistribution under MIT (MIT, ISC, BSD, Apache-2.0 and the like). Nothing
  under PolyForm, GPL, or no license at all.
- `test/host.mjs` is the single owner of "where is the host". Do not
  recompute a path to it in a suite.
- The host application never imports this package, and this package never
  imports a host. That is the property that makes the tool additive and
  droppable, and a change that breaks it is the one change that will not be
  merged.

## The shape of a change

Write the test with the change. A bug fix that arrives without the case that
would have caught it is hard to keep fixed.

Commit subjects here are a plain sentence saying what the software now does,
from the point of view of someone using it — not a change log of files
touched, and not a `feat:`/`fix:` prefix:

```
Open the page you asked for, and never the last app's folder
Rebuild a bundle that has fallen behind its source, before serving it
Hand a write that cannot reach source to the Changes tab
```

If there is a body, spend it on why the old behavior was wrong. That is the
part nobody can reconstruct later.

## AI-assisted changes

Use whatever tools help. Point your agent at [AGENTS.md](AGENTS.md): it lists
the commands, the file map, and the rules that fail review. Much of this repository was written with an agent, and
a change is judged by whether it works and reads like the file around it, not by
what typed it.

Two rules:

- **Do not list a tool as an author or co-author.** Saying in the body or the PR
  that a change was assisted or generated by one is welcome and useful. A
  `Co-authored-by:` trailer naming a model is not — the authors of a commit are
  the people accountable for it.
- **Read the diff before you send it.** An agent that never ran the suite will
  still tell you it passed. `npm run build && npm test` is the check, and the PR
  should say you ran it.

## Style

Match the surrounding code. There is no linter and no formatter in this repo,
which means the existing files are the style guide: no semicolons, double
quotes, ES modules, comments that explain a decision rather than restate the
line under them.

## Opening a pull request

1. Branch off `main`.
2. `npm run build && npm test` — and say in the PR that you ran them, and on
   what platform. The tool touches the filesystem and a browser, so "works on
   macOS" and "works on Linux" are different claims.
3. Describe the behavior before and after. A screenshot or a short clip is
   worth a lot for anything that changes the overlay, the inspector, or the
   start screen.
4. Small and focused beats large and complete. Two PRs are fine.

Do not commit `dist/`, `node_modules/`, or anything under `.local/` — the
`.gitignore` already covers them.

## Reporting a bug

Open an issue with the version or commit, your OS and Node version, the
framework (Next.js and which router, Vite, or Angular) and its version, whether Tailwind is v3 or v4, and what
you expected instead. If the editor showed the change in the Changes tab rather
than writing it to a file, say so — that is a different failure from silence,
and it narrows things down fast.

## The landing page

The marketing site lives in [`landing/`](landing/) and has its own
[README](landing/README.md). It shares no code with the tool, and a change to it
needs `node landing/check.mjs`, not `npm test`.

## Security

Please do not open a public issue for a vulnerability. [SECURITY.md](SECURITY.md)
explains what counts as one here — this is a local development tool with write
access to your project by design — and how to report it privately.

## Questions

Ask in [Discussions](https://github.com/phil8-li/design-layer/discussions), or
open an issue. A question that took you an hour to answer is a documentation
bug, and it is worth filing as one.
