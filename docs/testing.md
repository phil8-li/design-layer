# Testing

```sh
npm test                                        # every suite, no host needed (node test/run.mjs)
node test/run.mjs mcp board                     # only suites whose id contains "mcp" or "board"
node test/run.mjs --skip library-signin-live    # leave suites out (comma list of substrings)
node test/run.mjs --from toast-cases            # resume at that suite, keep the order
node test/run.mjs --list                        # print the plan, run nothing
node test/run.mjs --jobs 4                      # run the parallel-safe suites 4 at a time
node test/mcp-handoff-cases.mjs                 # one suite alone
DESIGNLAYER_HOST=../host-app npm test           # plus the host-pinned suites
npm run test:standalone-next                    # needs a host
```

`test/run.mjs` finds every `test/*-cases.mjs` and `desktop/mac/test/*-cases.mjs`
on disk, so a new suite needs no edit to `package.json` or to the runner. A
filter matches a substring of the suite id (its path without `.mjs`). Every
suite runs to the end after a failure. Each prints one line (`ok`, `FAIL` or
`skipped`), and a summary closes the run. `--verbose` streams each suite's own
output, and `--timeout <s>` changes the 300 s limit per suite. A new suite runs
serially until someone adds it to `PARALLEL_SAFE` in `test/run.mjs`.

`test/library-signin-live-cases.mjs` opens a real Chrome window. Skip it with
`--skip library-signin-live` when you do not want a window on screen.

Most of the suite runs against this repository alone. Four suites —
`token-cases`, `responsive-cases`, `picker-cases`, `icon-set-cases` — pin a real
app's own catalog, breakpoints and icon set, deliberately: they are the net that
catches a change to the tool silently changing what a real app sees. They find
that app through `test/host.mjs`, which is the single owner of "where is the
host": `DESIGNLAYER_HOST` if set, otherwise a `host-app` checkout beside
this one. With neither present they print a skip and exit 0, and the runner
counts them as `skipped`, so a bare clone is green and a skip never reads as a
pass.

The package suite covers its npm-bin entry point, options, selection, shell,
hydration readiness, and offline source translation. `test/resize-cases.mjs`
drives the panel seams through jsdom — a supplied viewport rather than a real
one, because a bounds check against a window that is always zero wide cannot
tell a clamp from a no-op — and pins the parts the library does not own: the
group it needs in order to work, the seam as a `role="separator"`, the app's
inset following a live drag, and the rule that a panel gives room up when the
window shrinks and takes exactly that room back when it grows. It also covers the paths
this tool is judged on and cannot watch itself: the start screen and its folder
dialog, bundle freshness, and whole drag gestures driven through jsdom — pinning
the value each one records as its "from".
`test/delete-cases.mjs` pins the delete key, the undo that puts an element back
between its original siblings, and the note a delete leaves for the agent.
`test/host-agnostic-cases.mjs` is the decoupling proof: three synthetic hosts
under `test/fixtures` — a Tailwind v4 app whose `@theme` namespaces are spelled
differently from this repo's, a Tailwind v3 app with a classic config scale and
no motion or text tokens at all, and an adapter-only app with no manifest — each
resolving a catalog, aliases, and inspector rows. It never reads the repository
the package sits in.

The standalone test packs the package, installs it into a throwaway
config-free Next app, and checks the isolated proxy and the vendor engine's
write protocol in both the App and Pages Routers. It reads the Next and React
versions from the host app, so it needs one. `node test/ui-change-cases.mjs`
without `--offline` drives the same protocol against a running editor. No
editor surface sends that protocol now; the two suites pin it for the vendor
patch. The live levels use throwaway fixtures and restore the one real
component they touch byte for byte. Ports and the API prefix come from the
launcher's `endpoint.json`.

## Real-browser tools

`tools/board-e2e.mjs`, `design-panel-e2e.mjs`, `measure-e2e.mjs`,
`resize-e2e.mjs` and `perf.mjs` stand up a throwaway Vite + React host. Set
`DESIGNLAYER_E2E_DEPS` to a `node_modules` folder that has that toolchain; the
tools link it rather than install it. They are not part of `npm test`. To know
when the editor is ready on a page, wait for
`window.__designlayer.boot === "attached"` (or the `designlayer:boot` event).
