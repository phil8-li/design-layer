# Testing

```sh
npm test                                        # no host needed
DESIGNLAYER_HOST=../host-app npm test           # plus the host-pinned suites
npm run test:standalone-next                    # needs a host
```

Most of the suite runs against this repository alone. Four suites —
`token-cases`, `responsive-cases`, `picker-cases`, `icon-set-cases` — pin a real
app's own catalog, breakpoints and icon set, deliberately: they are the net that
catches a change to the tool silently changing what a real app sees. They find
that app through `test/host.mjs`, which is the single owner of "where is the
host": `DESIGNLAYER_HOST` if set, otherwise a `host-app` checkout beside
this one. With neither present they print a skip and exit 0, so a bare clone is
green and a skip never reads as a pass.

The package suite covers its npm-bin entry point, options, selection, shell,
hydration readiness, and offline source translation. `test/resize-cases.mjs`
drives the panel seams through jsdom — a supplied viewport rather than a real
one, because a bounds check against a window that is always zero wide cannot
tell a clamp from a no-op — and pins the parts the library does not own: the
group it needs in order to work, the seam as a `role="separator"`, the app's
inset following a live drag, and the rule that a panel gives room up when the
window shrinks and takes exactly that room back when it grows. It also covers the paths
this tool is judged on and cannot watch itself: the start screen and its folder
dialog, bundle freshness, whole drag gestures driven through jsdom — pinning the
value each one records as its "from" — and the two ways a write can fail to
reach source, which must land in the Changes tab rather than vanish.
`test/delete-cases.mjs` runs the delete path end to end on both hosts, against
real files in a temp project: the key, the undo that restores an element between
its original siblings, and every refusal the two source writers are allowed to
make — because a refusal that quietly becomes a write deletes the wrong element.
`test/host-agnostic-cases.mjs` is the decoupling proof: three synthetic hosts
under `test/fixtures` — a Tailwind v4 app whose `@theme` namespaces are spelled
differently from this repo's, a Tailwind v3 app with a classic config scale and
no motion or text tokens at all, and an adapter-only app with no manifest — each
resolving a catalog, aliases, and inspector rows. It never reads the repository
the package sits in. The standalone test packs
the package, installs it into a throwaway config-free Next app, and verifies the
isolated proxy and source-write path in both the App and Pages Routers. To
exercise the live write path against the current app, run
`node test/ui-change-cases.mjs` while the editor is running. Its live levels use
throwaway fixtures and restore the one real component they touch byte for byte.
Ports and the API prefix come from the launcher's `endpoint.json`.
