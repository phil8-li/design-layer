# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`0.1.0` is the version in `package.json`. It has not been tagged or published.
The entry below describes what `main` contains as of 2026-10-22, taken from the
commit history since the repository was made public on 2026-10-06. It is not a
release announcement.

## [Unreleased]

## [0.1.0] - 2026-10-22

### Added

- A visual editor that proxies a running dev server and writes edits back into
  component source. React hosts are Next.js, Vite, and Create React App.
  Angular is detected from `@angular/core` and edited as a first-class host.
  The host app does not import this package.
- Direct writes for the edits the source writer can spell: Tailwind utility
  classes on React, and static `style`, `class`, and text in Angular templates.
  Insert and delete splice the element out of JSX or the template. Anything the
  writer refuses stays in the Changes tab instead of being guessed.
- An inspector for layout, spacing, typography, fill, and effects, a layers
  pane, and canvas view, which lays every route out as a frame.
- Design tokens, components, and icons read from the host: a manifest or
  adapter, Tailwind v3 and v4 aliases, and an icon set. `DESIGN.md` carries the
  same token values the code does, and the suite fails when the two drift.
- Notes pinned on elements. **Send to agent** hands the notes and the edits no
  commit can write to a coding agent over MCP at `127.0.0.1:5747/mcp`
  (`wait_for_change`, `list_changes`, `get_change`, `resolve_change`). Copy
  still puts the same brief on the clipboard. Setup snippets cover Claude Code,
  OpenCode, Cursor, and VS Code.
- A start screen that can launch the dev server, and one editor per app so
  opening a second prototype does not replace the first. The same MCP endpoint
  stays up across apps, and each change names its `projectRoot`.
- A Mac Dock app: a Chrome web app in its own profile, plus a login LaunchAgent.
  Tabs can be renamed, reordered, and moved between windows. The app checks
  GitHub for a newer `main` and can update a checkout in place.
- A landing page in `landing/`, deployed to GitHub Pages from `main`.
- A loopback-only security boundary: every route checks the peer address,
  `Host`, and `Origin`, the servers bind `127.0.0.1`, and a file allowlist is
  what stands between the browser and the rest of the project root.

### Changed

- Dependency updates since the public import, including Motion 14, motion-panels
  0.6.1, ws 8.22, and `@babel/parser` 8, with third-party notices regenerated
  from those versions. GitHub Actions steps are on checkout, setup-node,
  upload-pages-artifact, and deploy-pages current major versions.

[0.1.0]: https://github.com/phil8-li/design-layer/commits/main
