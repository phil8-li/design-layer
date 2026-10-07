# AGENTS.md — landing page

Instructions for AI agents editing the Design Layer landing page. This folder
is independent of the editor in the repository root and will move to its own
repository; do not import from `../src`, `../server`, or `../runtime`.

Design rules live in DESIGN.md. Read it before any UI edit, and add new rules there.

## Commands

```sh
node landing/serve.mjs                 # http://127.0.0.1:4321
node landing/check.mjs --only static   # markup, links, budget (what CI runs)
node landing/check.mjs                 # plus a Playwright browser pass
```

Run `node landing/check.mjs --only static` before saying a change works. The
page has a hard budget: html+css+js under 180 KB, each image under 700 KB, each
video under 4 MB, first view under 2.5 MB.

## Rules

- No build step and no dependencies. Plain HTML, CSS and ES modules.
- Screenshots are real captures under `assets/shots/<demo>/`; regenerate them
  with `tools/optimize-shots.mjs`, never hand-edit.
- `film/iterations/` is an archive of rendered cuts in Git LFS. Add new rounds
  there; never delete or re-encode old ones.
- With `prefers-reduced-motion: reduce`, or without script or WebGL, every
  scene must rest in its final frame.

See [README.md](README.md) for the motion system, the film pipeline, and how
to move this folder to its own repo.
