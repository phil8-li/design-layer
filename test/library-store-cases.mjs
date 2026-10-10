/**
 * The server side of libraries: what is persisted, what is re-read, what is
 * refused, and the six routes the browser reaches all of it through.
 *
 * Everything here runs against a REAL project directory created under
 * `os.tmpdir()` and thrown away afterwards, and the routes run against a real
 * `http.createServer` on 127.0.0.1 — the same harness `options-cases.mjs` uses.
 * A fake filesystem would not be able to prove the two things this module is
 * most likely to get wrong, because both of them are facts about real paths:
 *
 *  - **Path safety is the whole security story.** This process writes and reads
 *    project files on behalf of a page. `path` arrives from the browser, so
 *    `../../etc/passwd`, an absolute path, and a symlink that leaves the project
 *    are each a way to read a file the designer never opened. All three are
 *    asserted, and all three must be refused as a 400 rather than as a 500:
 *    the difference is whether the panel can say "that file is outside your
 *    project" or has to say "something went wrong";
 *  - **the pointer is persisted, the catalog is not.** `libraries.json` holds
 *    an id, a name, a flag, a source and a timestamp, and nothing else. That is
 *    not a size optimisation — it is what makes a designer's edit to their own
 *    token file show up in the inspector without touching the editor, because
 *    `list()` re-reads and re-parses the source every time. A catalog cached in
 *    that file would be a design system frozen at the moment it was added.
 *
 * Two consequences of re-reading are pinned as well. A source that has been
 * DELETED still comes back from `list()`, with `error` set and `enabled`
 * untouched — dropping the row would take away the only control that can remove
 * it, leaving a phantom library the designer cannot get rid of. And `list()`
 * never carries icon drawings: they are path data, they are large, and most
 * sessions never open the picker, so `icons(id)` is the only thing that serves
 * them. That is the same trade `server/icon-set.mjs` documents for the host's
 * own set.
 *
 * `fs.realpath` is applied to the temp root before anything else, because
 * `os.tmpdir()` on macOS is itself a symlink (`/var` -> `/private/var`). A
 * store that resolves real paths on one side of its comparison and not the
 * other would refuse every file in the project here while working on Linux —
 * so the fixture removes that difference and the traversal cases below assert
 * the guard on its own terms.
 *
 * Usage: node designlayer/test/library-store-cases.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import { resolveConfig } from "../config.mjs"
import { createLibraryStore } from "../server/libraries.mjs"
import { createDesignLayerRoutes } from "../server/routes.mjs"

import { PACKAGE_DIR } from "./host.mjs"

let passed = 0
let failed = 0

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

const FIXTURES = path.join(PACKAGE_DIR, "test/fixtures/libraries")
const fixture = (name) => fs.readFile(path.join(FIXTURES, name), "utf8")

const [MANIFEST, TOKENS, ICONS, THEME] = await Promise.all(
  ["manifest.json", "tokens.json", "icons.json", "theme.css"].map(fixture)
)

/**
 * A throwaway project with one of each kind of design-system file in it, plus
 * the four places a scan must not look.
 *
 * The decoys are not padding: `node_modules` and `dist` both contain a REAL
 * stylesheet that would otherwise be detected as a library, so a walker that
 * forgets to skip them fails here rather than in a designer's panel with forty
 * vendored candidates in it.
 */
async function project() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "de-libraries-")))
  const write = async (relative, contents) => {
    const file = path.join(root, relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, contents, "utf8")
    return file
  }

  await write("src/styles/theme.css", THEME)
  await write("design/meridian.json", MANIFEST)
  await write("design/brand-tokens.json", TOKENS)
  await write("design/glyphs.json", ICONS)
  await write("package.json", '{ "name": "temp-host", "version": "0.0.0" }\n')
  await write("tsconfig.json", '{ "compilerOptions": { "strict": true } }\n')
  await write("notes.txt", "Nothing in here is a design system.\n")
  await write("README.md", "# Temp host\n")
  await write("node_modules/@vendor/ui/theme.css", THEME)
  await write("dist/bundle.css", THEME)
  await write(".local/designlayer/scratch.css", THEME)

  const config = resolveConfig({ projectRoot: root }, { cwd: root })
  return {
    root,
    config,
    write,
    store: createLibraryStore(config),
    stateFile: path.join(config.stateDir, "libraries.json"),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  }
}

/** Runs a case against its own project directory, and always cleans up. */
async function withProject(name, fn) {
  await checkAsync(name, async () => {
    const context = await project()
    try {
      await fn(context)
    } finally {
      await context.cleanup()
    }
  })
}

/** The 400/404 assertion, spelled once so every refusal is checked the same way. */
const refusedWith = (statusCode) => (error) => {
  assert.ok(error instanceof Error, `refusal was not an Error: ${error}`)
  assert.equal(error.statusCode, statusCode, `refused as ${error.statusCode}: ${error.message}`)
  return true
}

// ── The round trip ─────────────────────────────────────────────────────────

console.log("\nAdding, listing, toggling and removing")

await withProject("a CSS file becomes a library with its tokens counted", async ({ store }) => {
  const { library } = await store.add({ path: "src/styles/theme.css" })
  assert.equal(library.id, "src-styles-theme-css")
  assert.deepEqual(library.source, { kind: "css", path: "src/styles/theme.css" })
  assert.equal(typeof library.addedAt, "number")
  assert.ok(library.addedAt > 0)
  assert.equal(library.counts.colors, 3)
  assert.equal(library.counts.spacing, 3)
  assert.equal(library.counts.textStyles, 1)
  assert.equal(library.counts.iconDrawings, 0)
  assert.equal(library.catalog.colors.length, 3)
  assert.equal(library.error, undefined)

  const { libraries } = await store.list()
  assert.deepEqual(libraries.map((entry) => entry.id), ["src-styles-theme-css"])
})

/*
 * A design system's published entry is often nothing but `@import`s over its
 * parts. Read alone it declares no custom properties, and the library was
 * refused as "carries no tokens" with the tokens one file away. Imports are
 * followed one level, inside the project, and editing an imported file is
 * picked up like editing the entry.
 */
await withProject("a stylesheet that imports its parts is read with them", async ({ store, write }) => {
  await write(
    "vendor/kit/index.css",
    '@import "./colors.css";\n@import url("./scale.css");\n@import "../../../outside.css";\n'
  )
  await write("vendor/kit/colors.css", ":root { --kit-color-ink: #101010; --kit-color-page: #ffffff; }\n")
  await write("vendor/kit/scale.css", ":root { --kit-space-sm: 8px; --kit-space-md: 16px; }\n")

  const { library } = await store.add({ path: "vendor/kit/index.css" })
  assert.equal(library.error, undefined, library.error)
  assert.equal(library.counts.colors, 2)
  assert.equal(library.counts.spacing, 2)

  await write("vendor/kit/scale.css", ":root { --kit-space-sm: 8px; --kit-space-md: 16px; --kit-space-lg: 24px; }\n")
  const [listed] = (await store.list()).libraries
  assert.equal(listed.counts.spacing, 3, "an edit to an imported file was not picked up")
})

await withProject("enabled is a flag the store remembers, both ways", async ({ store }) => {
  const { library } = await store.add({ path: "src/styles/theme.css" })
  const off = await store.update(library.id, { enabled: false })
  assert.equal(off.library.enabled, false)
  assert.equal((await store.list()).libraries[0].enabled, false)

  const on = await store.update(library.id, { enabled: true })
  assert.equal(on.library.enabled, true)
  assert.equal((await store.list()).libraries[0].enabled, true)

  const renamed = await store.update(library.id, { name: "Nimbus (vendored)" })
  assert.equal(renamed.library.name, "Nimbus (vendored)")
  assert.equal(renamed.library.enabled, true, "renaming a library turned it off")
})

await withProject("removing takes the row and the file's claim on it", async ({ store }) => {
  const { library } = await store.add({ path: "src/styles/theme.css" })
  assert.deepEqual(await store.remove(library.id), { ok: true })
  assert.deepEqual((await store.list()).libraries, [])
  assert.deepEqual(await store.remove(library.id), { ok: false })
  assert.deepEqual(await store.remove("never-existed"), { ok: false })
})

/*
 * The file on disk, and the one thing it must never contain.
 *
 * A catalog written here is a design system frozen at the moment it was added:
 * the designer edits their token file, nothing changes in the inspector, and
 * the only way out is to remove and re-add the library. Re-reading on every
 * `list()` is the feature, and this is what proves the file cannot be used as a
 * cache by accident.
 */
await withProject("libraries.json holds the pointer and never the catalog", async ({ store, stateFile }) => {
  await store.add({ path: "src/styles/theme.css" })
  const text = await fs.readFile(stateFile, "utf8")
  const stored = JSON.parse(text)

  assert.deepEqual(Object.keys(stored), ["libraries"])
  assert.equal(stored.libraries.length, 1)
  assert.deepEqual(Object.keys(stored.libraries[0]).sort(), [
    "addedAt",
    "enabled",
    "id",
    "name",
    "source",
  ])
  assert.deepEqual(stored.libraries[0].source, { kind: "css", path: "src/styles/theme.css" })
  for (const leak of ["catalog", "counts", "color:brand-500", "--color-brand-500", "trackingUnit"]) {
    assert.equal(text.includes(leak), false, `the persisted pointer carries ${leak}`)
  }
})

await withProject("adding the same path twice is one library, not two", async ({ store }) => {
  const first = await store.add({ path: "src/styles/theme.css" })
  const second = await store.add({ path: "src/styles/theme.css" })
  assert.equal(second.library.id, first.library.id)
  assert.equal(second.library.addedAt, first.library.addedAt, "the second add re-created the row")
  assert.equal((await store.list()).libraries.length, 1)
})

await withProject("a name is the system's own, or the file's, title-cased", async ({ store }) => {
  // The manifest names itself, and the name it chose wins over the filename.
  assert.equal((await store.add({ path: "design/meridian.json" })).library.name, "Meridian")
  // Nothing in a bare stylesheet or a DTCG file says what the system is called,
  // so the filename is the only thing left — and `brand-tokens` is a filename,
  // while `Brand Tokens` is a label.
  assert.equal((await store.add({ path: "src/styles/theme.css" })).library.name, "Theme")
  assert.equal(
    (await store.add({ path: "design/brand-tokens.json" })).library.name,
    "Brand Tokens"
  )
  // An explicit name beats both.
  assert.equal(
    (await store.add({ path: "design/glyphs.json", name: "Nimbus Icons" })).library.name,
    "Nimbus Icons"
  )
})

await withProject("the kind is detected when the caller does not say", async ({ store }) => {
  assert.equal((await store.add({ path: "design/meridian.json" })).library.source.kind, "manifest")
  assert.equal(
    (await store.add({ path: "design/brand-tokens.json" })).library.source.kind,
    "tokens"
  )
  assert.equal((await store.add({ path: "design/glyphs.json" })).library.source.kind, "icons")
  assert.equal((await store.add({ path: "src/styles/theme.css" })).library.source.kind, "css")
})

await withProject("a file that is not a design system is refused by name", async ({ store }) => {
  await assert.rejects(store.add({ path: "notes.txt" }), (error) => {
    assert.equal(error.statusCode, 400)
    for (const kind of ["manifest", "css", "tokens", "icons"]) {
      assert.match(error.message, new RegExp(kind), `the refusal never names ${kind}`)
    }
    return true
  })
})

await withProject("updating a library nobody added is a 404", async ({ store }) => {
  await assert.rejects(store.update("never-existed", { enabled: true }), refusedWith(404))
})

// ── Path safety ────────────────────────────────────────────────────────────

console.log("\nWhat a page may not ask this process to read")

await withProject("a path that climbs out of the project is refused", async ({ store }) => {
  await assert.rejects(store.add({ path: "../../etc/passwd" }), refusedWith(400))
  await assert.rejects(store.add({ path: "src/../../../etc/passwd" }), refusedWith(400))
  assert.deepEqual((await store.list()).libraries, [], "a refused add still wrote a row")
})

await withProject("an absolute path is refused even when it is inside the project", async ({ store, root }) => {
  await assert.rejects(store.add({ path: "/etc/passwd" }), refusedWith(400))
  // Inside the root, and still refused: `path` is project-relative by contract,
  // and accepting absolutes here is how the relative rule stops being checked.
  await assert.rejects(
    store.add({ path: path.join(root, "src/styles/theme.css") }),
    refusedWith(400)
  )
})

await withProject("a symlink that leaves the project is refused", async ({ store, root }) => {
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "de-outside-")))
  try {
    await fs.writeFile(path.join(outside, "secrets.css"), THEME, "utf8")
    await fs.symlink(path.join(outside, "secrets.css"), path.join(root, "src/styles/linked.css"))
    await assert.rejects(store.add({ path: "src/styles/linked.css" }), refusedWith(400))
  } finally {
    await fs.rm(outside, { recursive: true, force: true })
  }
})

// ── Re-reading the source ──────────────────────────────────────────────────

console.log("\nThe source is the truth, on every read")

await withProject("editing the token file changes what list() reports", async ({ store, write }) => {
  await store.add({ path: "src/styles/theme.css" })
  assert.equal((await store.list()).libraries[0].counts.colors, 3)

  await write("src/styles/theme.css", `${THEME}\n:root {\n  --color-accent: #ff0066;\n}\n`)
  const [library] = (await store.list()).libraries
  assert.equal(library.counts.colors, 4, "the edit never reached the inspector")
  assert.ok(
    library.catalog.colors.some((token) => token.cssVar === "--color-accent"),
    "the new token is counted but not offered"
  )
})

/*
 * A directory library keeps each file's parse while its stat holds, so the
 * rule has to be proved for directories too: a component added to the folder,
 * renamed in place, or deleted shows on the very next list().
 */
await withProject("adding, renaming or deleting a component in a directory changes list()", async ({ store, write, root }) => {
  await write("src/kit/Badge.tsx", "export function Badge() { return <span /> }\n")
  await write("src/kit/Chip.tsx", "export function Chip() { return <span /> }\n")
  await store.add({ path: "src/kit", kind: "components" })
  const names = async () => (await store.list()).libraries[0].catalog.components.map((entry) => entry.name)
  assert.deepEqual(await names(), ["Badge", "Chip"])

  await write("src/kit/Avatar.tsx", "export function Avatar() { return <img /> }\n")
  await write("src/kit/Badge.tsx", "export function Pill() { return <span /> }\n")
  await fs.rm(path.join(root, "src/kit/Chip.tsx"))
  assert.deepEqual(await names(), ["Avatar", "Pill"])
})

/*
 * The row that must survive its own file.
 *
 * Deleting the source is how a designer discovers they added the wrong file, or
 * how a branch switch breaks a library. If the row disappears with the file,
 * the toggle and the remove button disappear with it, and the entry stays in
 * `libraries.json` forever with nothing in the UI able to reach it.
 */
await withProject("a library whose file is gone is still a library", async ({ store, root }) => {
  const { library } = await store.add({ path: "src/styles/theme.css" })
  await store.update(library.id, { enabled: true })
  await fs.rm(path.join(root, "src/styles/theme.css"))

  const [orphan] = (await store.list()).libraries
  assert.equal(orphan.id, library.id)
  assert.equal(typeof orphan.error, "string")
  assert.ok(orphan.error.length > 0, "the card has nothing to show the designer")
  assert.equal(orphan.enabled, true, "the enabled flag was lost with the file")
  assert.deepEqual(orphan.catalog.colors, [])
  assert.equal(orphan.counts.colors, 0)
  // And the one thing the row exists for still works.
  assert.deepEqual(await store.remove(library.id), { ok: true })
})

await withProject("a file that stops parsing is reported, not dropped", async ({ store, write }) => {
  const { library } = await store.add({ path: "design/meridian.json" })
  await write("design/meridian.json", "{ this is no longer JSON")
  const [broken] = (await store.list()).libraries
  assert.equal(broken.id, library.id)
  assert.equal(typeof broken.error, "string")
  assert.ok(broken.error.length > 0)
})

// ── Drawings ───────────────────────────────────────────────────────────────

console.log("\nIcon drawings are served, never listed")

await withProject("list() carries no path data and icons() carries all of it", async ({ store }) => {
  const { library } = await store.add({ path: "design/glyphs.json" })
  assert.deepEqual(library.catalog.iconDrawings, [], "add() handed back the whole icon set")

  const [listed] = (await store.list()).libraries
  assert.deepEqual(listed.catalog.iconDrawings, [])
  assert.equal(listed.counts.iconDrawings, 2, "the count was lost along with the drawings")

  const served = await store.icons(library.id)
  assert.equal(served.attribute, "data-icon")
  assert.deepEqual(served.icons.map((icon) => icon.name), ["arrow-right", "circle"])
  assert.equal(served.icons[0].nodes.length, 2)
})

// ── Discovery ──────────────────────────────────────────────────────────────

console.log("\nFinding the design-system files a project already has")

await withProject("every kind is found, ranked, and nothing vendored is", async ({ store }) => {
  const { candidates } = await store.discover()
  const paths = candidates.map((candidate) => candidate.path)

  assert.ok(paths.includes("design/meridian.json"), "the manifest was not found")
  assert.ok(paths.includes("design/brand-tokens.json"), "the token file was not found")
  assert.ok(paths.includes("design/glyphs.json"), "the icon file was not found")
  assert.ok(paths.includes("src/styles/theme.css"), "the stylesheet was not found")

  for (const skipped of [
    "node_modules/@vendor/ui/theme.css",
    "dist/bundle.css",
    ".local/designlayer/scratch.css",
    "package.json",
    "tsconfig.json",
  ]) {
    assert.equal(paths.includes(skipped), false, `${skipped} was offered as a library`)
  }
  // Nothing outside the two extensions the scan considers, either.
  for (const candidate of candidates) {
    assert.match(candidate.path, /\.(css|json)$/)
    assert.equal(candidate.installed, false)
    assert.equal(typeof candidate.detail, "string")
    assert.ok(candidate.detail.length > 0, `${candidate.path} describes itself as nothing`)
    assert.ok(candidate.name.length > 0)
  }

  const kinds = candidates.map((candidate) => candidate.kind)
  const rank = ["manifest", "tokens", "icons", "css"]
  assert.deepEqual(
    kinds,
    [...kinds].sort((a, b) => rank.indexOf(a) - rank.indexOf(b)),
    `the candidates are not ranked manifest-first: ${kinds.join(", ")}`
  )
})

await withProject("a candidate already added says so", async ({ store }) => {
  await store.add({ path: "design/meridian.json" })
  const { candidates } = await store.discover()
  const added = candidates.find((candidate) => candidate.path === "design/meridian.json")
  assert.ok(added, "an installed library vanished from the scan")
  assert.equal(added.installed, true)
  const other = candidates.find((candidate) => candidate.path === "src/styles/theme.css")
  assert.equal(other.installed, false)
})

// ── The cap ────────────────────────────────────────────────────────────────

console.log("\nThe ceiling on how many libraries one project may hold")

await withProject("the twenty-first library is refused", async ({ store, write }) => {
  for (let index = 0; index < 21; index += 1) {
    await write(
      `scale/lib-${index}.css`,
      `:root {\n  --color-a-${index}: #fff;\n  --color-b-${index}: #000;\n  --spacing-sm: 8px;\n  --radius-sm: 4px;\n}\n`
    )
  }
  for (let index = 0; index < 20; index += 1) {
    await store.add({ path: `scale/lib-${index}.css` })
  }
  assert.equal((await store.list()).libraries.length, 20)
  await assert.rejects(store.add({ path: "scale/lib-20.css" }), refusedWith(400))
  assert.equal((await store.list()).libraries.length, 20, "the refused add still landed")
})

// ── The routes ─────────────────────────────────────────────────────────────

console.log("\nThe six endpoints the browser reaches all of this through")

/**
 * The routes over a real loopback server, driven exactly the way
 * `options-cases.mjs` drives the control-default routes.
 *
 * A real socket rather than a fake request object, because the loopback guard
 * in `routes.mjs` reads `req.socket.remoteAddress` and the `Host` header — so a
 * hand-rolled request would be testing a guard that never runs.
 */
await checkAsync("every library endpoint answers over loopback", async () => {
  const { config, cleanup } = await project()
  const routes = createDesignLayerRoutes(config)
  const server = http.createServer((request, response) => {
    if (routes.handle(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}${config.apiPrefix}/libraries`
  const json = async (url, init) => {
    const response = await fetch(url, init)
    return { status: response.status, body: await response.json() }
  }
  const send = (method, body) => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  try {
    const empty = await json(base)
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body, { libraries: [] })

    // `available` is a literal segment that also matches the id pattern, so it
    // has to be matched first or this answers as an unknown library instead.
    const scan = await json(`${base}/available`)
    assert.equal(scan.status, 200)
    assert.ok(Array.isArray(scan.body.candidates), "GET /libraries/available is not the scan")
    assert.ok(
      scan.body.candidates.some((candidate) => candidate.path === "design/meridian.json"),
      "the scan came back without the manifest this project ships"
    )

    const created = await json(base, send("POST", { path: "design/glyphs.json" }))
    assert.equal(created.status, 200)
    const id = created.body.library.id
    assert.equal(id, "design-glyphs-json")
    assert.deepEqual(created.body.library.catalog.iconDrawings, [])

    const listed = await json(base)
    assert.deepEqual(listed.body.libraries.map((library) => library.id), [id])

    const patched = await json(`${base}/${id}`, send("PATCH", { enabled: false }))
    assert.equal(patched.status, 200)
    assert.equal(patched.body.library.enabled, false)

    const drawings = await json(`${base}/${id}/icons`)
    assert.equal(drawings.status, 200)
    assert.equal(drawings.body.attribute, "data-icon")
    assert.deepEqual(drawings.body.icons.map((icon) => icon.name), ["arrow-right", "circle"])

    const dropped = await json(`${base}/${id}`, { method: "DELETE" })
    assert.equal(dropped.status, 200)
    assert.deepEqual(dropped.body, { ok: true })
    assert.deepEqual((await json(base)).body, { libraries: [] })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await cleanup()
  }
})

await checkAsync("an unknown library is a 404 and a malformed id is a 400", async () => {
  const { config, cleanup } = await project()
  const routes = createDesignLayerRoutes(config)
  const server = http.createServer((request, response) => {
    if (routes.handle(request, response)) return
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}${config.apiPrefix}/libraries`

  try {
    const missing = await fetch(`${base}/never-existed`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
    assert.equal(missing.status, 404)

    // Not `[a-z0-9-]`: an id is a slug, and anything else is a client that has
    // started composing paths rather than echoing an id the server handed it.
    // `..` is absent on purpose — `fetch` normalizes it out of the path before
    // the server ever sees it, so it would be testing undici, not the guard.
    for (const bad of ["Bad_Id", "id%2Fwith%2Fslash", "a".repeat(201)]) {
      const response = await fetch(`${base}/${bad}`, { method: "DELETE" })
      assert.equal(response.status, 400, `DELETE /libraries/${bad} answered ${response.status}`)
    }

    const traversal = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "../../etc/passwd" }),
    })
    assert.equal(traversal.status, 400)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await cleanup()
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
