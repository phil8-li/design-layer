/**
 * The design-system libraries a project has ADDED, and the pointer file that
 * remembers them.
 *
 * The host's own catalog is resolved once at startup from `designSystem` in the
 * config and frozen into the browser prelude. Libraries are the runtime layer on
 * top of it: a designer points the Libraries tab at a stylesheet, a manifest, a
 * token file, an icon set or a directory of components, and from then on every
 * token-bearing control in the inspector offers what was found there — with no
 * restart, because nothing about a library is compiled into anything.
 *
 * Two decisions shape everything below.
 *
 * WHAT IS PERSISTED IS A POINTER, NEVER A CATALOG — EXCEPT AT A URL.
 * `libraries.json` holds an id, a name, an enabled flag, a source and a
 * timestamp, and `list()` re-reads every source on every call: it stats each
 * file, and re-parses the ones whose `mtimeMs:size` changed — the parse of an
 * unchanged file is kept in memory, never in that file. That is what makes an
 * edit to the designer's own token file show up in the inspector without
 * touching the editor. A catalog cached in that file would be
 * a design system frozen at the moment it was added, and the only way to
 * refresh it would be to remove the library and add it back.
 *
 * A URL LIBRARY IS THE ONE EXCEPTION, AND IT IS CACHED FOR THE SAME REASON THE
 * OTHERS ARE NOT. Re-reading a local file costs a `stat` and a parse; re-reading
 * a URL costs a round trip to somebody else's server, and `list()` is called on
 * every panel repaint. Left uncached, every repaint would put a stranger's
 * latency between a designer and their own inspector — and a design system
 * published at a URL does not change while they work, which is exactly the
 * property the local case does not have. So a URL row carries its catalog in
 * `libraries.json` and `update(id, { refresh: true })` is how it is renewed.
 * Local libraries keep re-parsing from disk; that behaviour is load-bearing and
 * must not be "unified" with this one.
 *
 * THE PATH IN AN `add` IS ATTACKER-ADJACENT INPUT. It arrives from a page and
 * becomes a file this process reads on that page's behalf, so `../../etc/passwd`,
 * `/etc/passwd` and a symlink pointing out of the project are three ways to read
 * something the designer never opened. The loopback guard in `routes.mjs` is not
 * an answer to any of them: it establishes that the request came from this
 * machine, not that the path is one the editor may read. Every path goes through
 * `resolveSource` below, which refuses all three as a 400 — a status the panel
 * can turn into "that file is outside your project" rather than "something went
 * wrong".
 *
 * The state directory comes from the resolved config for the reason
 * `server/options-store.mjs` gives: once this package is installed, `../../` is
 * `node_modules/`, and everything the editor persists would land inside a
 * dependency instead of the host project.
 */

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { importedStylesheets } from "./design-system-detect.mjs"
import { looksLikeComponentLibrary, scanComponentLibrary } from "./library-components.mjs"
import {
  CATALOG_READER_VERSION,
  LIBRARY_SOURCE_KINDS,
  describeLibrary,
  detectLibraryKind,
  libraryCounts,
  libraryId,
  parseLibrary,
} from "./library-sources.mjs"
import { URL_SOURCE_KIND, isLibraryUrl, libraryNameFromUrl, parseUrlLibrary } from "./library-url.mjs"

/** A ceiling on the panel rather than a product limit: twenty cards is already a scroll. */
const MAX_LIBRARIES = 20
/** How long a list waits for an out-of-date URL catalog to be re-read before answering. */
const REREAD_WAIT_MS = 6000
const MAX_NAME = 120
const MAX_PATH = 400
/**
 * A URL is allowed to be longer than a project path, because a deep link into a
 * documentation site routinely is — but its id is a slug of it, and an id past
 * `LIBRARY_ID_PATTERN`'s ceiling is a row that vanishes the next time the file
 * is read. So the id is cut to fit and the URL is capped where a longer one
 * stops being something a person pasted.
 */
const MAX_URL = 2000
const MAX_ID = 200
/** Past this a "design system file" is a build output, and parsing it is a stall. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
/**
 * How many files the walk will READ, which is not how many it will see.
 *
 * The distinction is the whole budget. Counting every file visited sounds
 * conservative and is the opposite: a stock Next app ships a `public/` folder
 * of images, fonts and generated OG cards, `public` sorts before `src`, and
 * four thousand PNGs that could never be a candidate spent the entire budget
 * before the walk reached the stylesheet it was looking for. Measured on a
 * project with 4,100 SVGs in `public/img/` and a real `src/styles/tokens.css`,
 * discovery answered `[]` in 18ms — fast, confident and wrong.
 *
 * Counting only the files that pass the extension test makes the budget mean
 * what it is for: a ceiling on the work of PARSING candidates, which is the only
 * expensive thing in here. Reading a directory entry's name and rejecting it on
 * its extension costs nothing and is not rationed.
 */
const MAX_VISITED_FILES = 4000
/**
 * And a ceiling on the walk itself, since an unbudgeted tree still has to
 * terminate. A project with a hundred thousand empty directories and not one
 * stylesheet would otherwise walk all of them for free under the rule above.
 */
const MAX_VISITED_DIRECTORIES = 5000
const MAX_CANDIDATES = 40
const MAX_COMPONENT_CANDIDATES = 10
/** A ceiling on how many directories are probed, since every probe reads files. */
const MAX_COMPONENT_PROBES = 500
/** Enough of a component directory to describe it, without scanning a monorepo. */
const DISCOVERY_SCAN_FILES = 400

const LIBRARY_ID_PATTERN = /^[a-z0-9-]{1,200}$/
const SOURCE_EXTENSIONS = new Set([".css", ".json"])
/**
 * Folders whose contents are never this project's design system.
 *
 * Three groups, and each one was a measured false positive rather than a
 * precaution.
 *
 * VENDORED AND GENERATED — `node_modules`, `dist`, `build`, `coverage`, `out`,
 * `storybook-static`: somebody else's CSS, or a copy of the project's own with
 * a hash in the name. A build output is the worst kind of candidate because it
 * is a faithful copy of a real design system and adding it pins the tokens to
 * whatever the last build emitted.
 *
 * SERVED ASSETS — `public`, `static`, `vendor`: the folder a project drops a
 * downloaded stylesheet into. A vendored copy of Open Props here was offered
 * ABOVE the project's own `src/styles/tokens.css`, because ranking is by token
 * count and a general-purpose CSS library has two hundred colours to the
 * project's four. The bigger file is not the more relevant one.
 *
 * TEST MATERIAL — `__tests__`, `__mocks__`, `fixtures`, `e2e`, `cypress`: a
 * `theme.css` under `test/fixtures/` exists precisely BECAUSE it looks like a
 * design system, so every content-based bar in this file passes it by design.
 * The only thing that distinguishes it is where it lives. Note `test/` itself is
 * not listed: a folder called `test` in somebody's project is not reliably a
 * test folder, and `fixtures` catches the shape that actually occurs.
 */
const SKIP_DIRECTORIES = new Set([
  "node_modules", "dist", "build", "coverage", "out", "storybook-static",
  "public", "static", "vendor",
  "__tests__", "__mocks__", "fixtures", "e2e", "cypress",
])
/** JSON that is certainly not a design system, skipped before it is parsed. */
const SKIP_JSON = /^(package\.json|package-lock\.json|tsconfig[^/]*\.json)$/
/** Candidate order in the Add panel: whatever describes a system best, first. */
const KIND_RANK = ["manifest", "tokens", "icons", "components", "css"]
/**
 * Where a project keeps the file it thinks of as its design system.
 *
 * A tiebreak, not a filter — nothing is hidden for living somewhere else. It
 * exists because the other tiebreak is token count, and token count is a
 * measure of SIZE rather than of relevance: a single busy component stylesheet
 * that enumerates thirty shades of one colour outranks the four colours, four
 * spacing steps and two radii that are demonstrably the whole system. Between
 * two files that both cleared the bar, the one in the folder a person would look
 * in first is the better guess, and the guess is all this list is.
 */
const CONVENTIONAL_LOCATIONS = [
  "app/", "src/app/", "src/styles/", "styles/", "src/theme/", "theme/",
  "src/tokens/", "tokens/", "design/", "src/design/",
]

/** Project root or a conventional folder — a shallow, deliberate-looking home. */
function conventionallyPlaced(relative) {
  if (!relative.includes("/")) return true
  return CONVENTIONAL_LOCATIONS.some((prefix) => relative.startsWith(prefix))
}
const FRAMEWORK_LABELS = { react: "React", angular: "Angular" }

/**
 * The bar a stylesheet clears to be OFFERED as a library, and the two shapes
 * that clear it.
 *
 * `detectLibraryKind` answers "can this file be read as a design system?", and
 * four custom properties is the right answer to THAT question: it is the
 * cheapest test that separates a stylesheet carrying tokens from one carrying
 * only rules. It is the wrong answer to the question discovery actually asks,
 * which is "would a designer ever mean this file?". Measured against a real
 * app, the four-property rule finds the project's design system and then a
 * dozen component stylesheets behind it, each declaring the two or three
 * one-off values that one component happened to need. Every one of them parses.
 * None of them is a library, and a chooser whose list is mostly noise is one a
 * designer stops reading — so the noise costs more than the misses do.
 *
 * DISCOVERY IS A RECOMMENDATION; `add` IS A CAPABILITY. Nothing here changes
 * what `add` accepts. A designer who types one of these paths into the manual
 * field still gets the library, because the editor can genuinely read the file
 * and refusing it would be the editor pretending it cannot. The bar governs
 * only what the editor volunteers unasked, which is why it is applied in `scan`
 * and nowhere near `sourceKind`.
 *
 * The bar is read off the PARSED catalog, never off the path. A path rule would
 * be one framework's convention — `*.component.css` is how Angular spells
 * "private stylesheet", and means nothing in a Vue, Svelte or plain-CSS project
 * — and what makes a file a design system is what is inside it.
 *
 * Two ways to clear it, because design systems come in both shapes:
 *
 *  - BREADTH. A system declares more than one axis and gives each one a scale.
 *    The shortest run of values anyone calls a scale is four steps (xs/sm/md/lg
 *    is the near-universal floor), so two axes at four steps each is eight
 *    tokens — the smallest count that is credibly a system rather than a
 *    handful of values one component needed. The component stylesheets this
 *    rule is aimed at carry one to three, so they are not near misses.
 *  - DEPTH. A file may be a single axis and still be a library: a palette is
 *    nothing but colours. With one group there is no second axis corroborating
 *    the claim, so the count has to carry it alone and the bar is higher.
 *    Twenty-four is a palette enumerated on purpose — eight hues in three
 *    shades, or a twelve-step ramp declared for light and again for dark —
 *    where a dozen colours is still what one busy component declares inline.
 */
const MIN_SYSTEM_TOKENS = 8
const MIN_SINGLE_AXIS_TOKENS = 24

function badRequest(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** A catalog with nothing in it: what a source that cannot be read contributes. */
function emptyCatalog(name) {
  return {
    name,
    trackingUnit: "px",
    colors: [],
    spacing: [],
    radii: [],
    textStyles: [],
    uiTextStyles: [],
    effects: [],
    icons: [],
    motion: [],
    components: [],
    iconDrawings: [],
    iconAttribute: "",
  }
}

/** `brand-tokens.json` -> `Brand Tokens`: a filename read as a label. */
function nameFromPath(relative) {
  const base = path.posix.basename(relative)
  const words = base
    .replace(/\.[^.]+$/, "")
    .split(/[-_\s.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
  return words.join(" ") || base || relative
}

function totalTokens(counts) {
  return Object.values(counts ?? {}).reduce(
    (total, value) => total + (Number.isFinite(value) ? value : 0),
    0
  )
}

/** How many of the count groups a source actually put anything in. */
function filledGroups(counts) {
  return Object.values(counts ?? {}).filter((value) => Number.isFinite(value) && value > 0).length
}

/**
 * Whether a parsed candidate is enough of a design system to be offered
 * unasked. See `MIN_SYSTEM_TOKENS` above for the bar and the reasoning.
 *
 * Only a stylesheet is judged against the counts. A manifest, a token file and
 * an icon set are already declarations of intent — somebody wrote that file in a
 * design-system format on purpose, and a small one is a small design system
 * rather than an accident — and a component directory had to pass
 * `looksLikeComponentLibrary` to get this far. A stylesheet is the one kind with
 * no intent behind it: every app has dozens, and it is the only kind the
 * four-property rule over-collects.
 *
 * WHAT NO KIND IS EXEMPT FROM IS BEING EMPTY. The detector for `tokens` matches
 * any JSON with a nested `{ value: … }` leaf, which is also the shape of an i18n
 * catalog, a Cypress fixture and a chart's data file — and `tokens` outranks
 * `css`, so `locales/en.json` was offered at the TOP of the list, describing
 * itself as "no tokens", above the project's real `src/styles/tokens.css`. A
 * candidate that parses to nothing is not a small design system, it is a file
 * that answered the detector's question by accident. Judging it on its parsed
 * catalog rather than on a tighter detector keeps the rule where every other
 * rule in this file already is: what makes a file a design system is what is
 * inside it.
 *
 * Exported because `server/design-system-detect.mjs` reads the same parsed
 * shape. It asks a DIFFERENT question, and `worthAdopting` below is that one —
 * the two sit together so the difference between them is stated once, where
 * both are read from.
 */
export function worthOffering(kind, counts) {
  const total = totalTokens(counts)
  if (total === 0) return false
  if (kind !== "css") return true
  return filledGroups(counts) > 1 ? total >= MIN_SYSTEM_TOKENS : total >= MIN_SINGLE_AXIS_TOKENS
}

/**
 * Whether a stylesheet at a project's CONVENTIONAL ENTRY POINT is that
 * project's design system.
 *
 * The bar above answers "should this file, out of the hundreds in a project, be
 * offered to somebody who did not ask for it". It is strict because it chooses
 * from a whole tree: a lone list of a dozen colours could be a palette or could
 * be one busy component, and with nothing else to go on the count has to settle
 * it.
 *
 * The detector is not choosing from a tree. It has already been told where to
 * look — `src/index.css`, `app/globals.css`, or whatever `components.json`
 * names as the Tailwind entry — and a stylesheet at that path is the one the
 * BUILD treats as the project's own. That is the corroborating signal the depth
 * bar was standing in for, and it is a better signal than any count: a
 * component's private stylesheet is never the configured entry point.
 *
 * Applying the strict bar there rejected real projects. Measured across four
 * prototypes whose tokens live in `src/index.css`, two were adopted and two were
 * refused for declaring a palette and nothing else — thirteen colours in one,
 * seven in the other, both inside an explicit theme block with the words "Design
 * tokens" written above them. The editor then offered no tokens at all for a
 * project that plainly had them, which is the exact failure this detection was
 * added to end.
 *
 * So the only bar left is emptiness. A file that parses to nothing is still
 * nothing — which is what keeps a CSS reset, or an entry that does no more than
 * `@import` a framework, from being adopted — but a conventional entry that
 * declares any token at all is declaring the project's tokens, and the editor
 * should read them.
 */
export function worthAdopting(counts) {
  return totalTokens(counts) > 0
}

/**
 * A path with its symlinks resolved, or null when it cannot be reached.
 *
 * `realpath` lstats, and on a managed Mac lstat is the one call TCC refuses for
 * a protected folder it will otherwise read and list perfectly — `canonicalPath`
 * in `config.mjs` documents the same trap for source files. So only EPERM falls
 * back to the lexical path; a path that is genuinely absent stays null, because
 * the caller has to be able to tell "this machine will not resolve it" from "it
 * is not there any more".
 */
async function canonical(target) {
  try {
    return await fs.realpath(target)
  } catch (error) {
    if (error?.code !== "EPERM") return null
    try {
      await fs.access(target)
      return path.resolve(target)
    } catch {
      return null
    }
  }
}

/**
 * The absolute path a project-relative `path` names, with BOTH ends of the
 * containment check resolved.
 *
 * Resolving both is not symmetry for its own sake. On macOS a project under
 * `os.tmpdir()` lives at `/var/folders/…`, which is a symlink to
 * `/private/var/folders/…`. Resolve only the candidate and every file in the
 * project reads as `/private/var/…` while the root is still spelled `/var/…`, so
 * the guard refuses the entire project while looking from the outside exactly
 * like a guard that works. Resolving only the root has the mirror-image failure,
 * and a test suite that plants its fixtures in a temp directory hits one or the
 * other every time.
 *
 * Returns `{ absolute, real, relative }`. `real` is null when the path is gone
 * or unreadable, which is a state `list()` has to report rather than throw on —
 * an added file can be deleted at any moment, and losing the row with it would
 * take away the only control that can remove the library.
 */
async function resolveSource(projectRoot, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest("A library needs a path to a file inside the project")
  }
  const requested = value.trim()
  if (requested.length > MAX_PATH) {
    throw badRequest("That library path is too long to be a path in this project")
  }
  if (path.isAbsolute(requested) || /^[A-Za-z]:[\\/]/.test(requested)) {
    throw badRequest(
      `Library paths are relative to the project, and "${requested}" is absolute`
    )
  }

  const absolute = path.resolve(projectRoot, requested)
  const lexical = path.relative(projectRoot, absolute)
  if (lexical === "" || lexical.startsWith("..") || path.isAbsolute(lexical)) {
    throw badRequest(`"${requested}" is outside this project`)
  }

  const real = await canonical(absolute)
  if (real !== null) {
    const realRoot = (await canonical(projectRoot)) ?? projectRoot
    const contained = path.relative(realRoot, real)
    if (contained === "" || contained.startsWith("..") || path.isAbsolute(contained)) {
      throw badRequest(`"${requested}" points outside this project`)
    }
  }

  return { absolute, real, relative: lexical.split(path.sep).join("/") }
}

/**
 * One store per project. Reads and writes of the pointer file are serialised
 * inside it the way `server/options-store.mjs` serialises option sets: two
 * panels adding a library at once must not both read the same file and clobber
 * each other's row.
 */
/**
 * `urlOptions` is the injection seam for everything `library-url.mjs` does over
 * the network — `{ fetchImpl, runHelper, timeoutMs }`. It is a second parameter
 * rather than a config key because it is not a thing a project configures: it
 * exists so the suite can prove what happens behind a sign-in wall without
 * needing a sign-in wall, and `routes.mjs` never passes it.
 */
export function createLibraryStore(config, urlOptions = {}, authStore = null) {
  const projectRoot = path.resolve(config.projectRoot)
  const storeDir = path.resolve(config.stateDir)
  const librariesFile = path.join(storeDir, "libraries.json")
  let queue = Promise.resolve()

  function serial(task) {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** A stored row, or null when the file was hand-edited into nonsense. */
  function normalizeEntry(value) {
    if (!isPlainObject(value)) return null
    if (typeof value.id !== "string" || !LIBRARY_ID_PATTERN.test(value.id)) return null
    if (!isPlainObject(value.source)) return null
    const { kind, path: sourcePath } = value.source
    if (!LIBRARY_SOURCE_KINDS.includes(kind)) return null
    const remote = kind === URL_SOURCE_KIND
    const ceiling = remote ? MAX_URL : MAX_PATH
    if (typeof sourcePath !== "string" || !sourcePath || sourcePath.length > ceiling) return null

    const name = typeof value.name === "string" ? value.name.trim() : ""
    const fallback = remote ? libraryNameFromUrl(sourcePath) : nameFromPath(sourcePath)
    return {
      id: value.id,
      name: name ? name.slice(0, MAX_NAME) : fallback,
      // A row with no flag is a row from a hand-written file, and a library
      // nobody switched off is on.
      enabled: value.enabled !== false,
      source: { kind, path: sourcePath },
      addedAt: Number.isFinite(value.addedAt) ? value.addedAt : Date.now(),
      // Only a URL row carries these three, and only a URL row is allowed to:
      // see the header on why a cached catalog is right here and wrong for a
      // file. A row whose cache was hand-edited away simply reports nothing
      // until it is refreshed, which is a better failure than refusing the row.
      ...(remote
        ? {
            catalog: isPlainObject(value.catalog) ? value.catalog : null,
            detail: typeof value.detail === "string" ? value.detail : "",
            error: typeof value.error === "string" ? value.error : "",
            // Which reading rules produced `catalog`. No stamp means the row was
            // cached before there were stamps — see `CATALOG_READER_VERSION`.
            reader: Number.isFinite(value.reader) ? value.reader : 1,
          }
        : {}),
    }
  }

  async function readEntries() {
    let parsed
    try {
      parsed = JSON.parse(await fs.readFile(librariesFile, "utf8"))
    } catch {
      // Missing or corrupt: the editor keeps working with no libraries, and the
      // next write heals the file.
      return []
    }
    const rows = Array.isArray(parsed?.libraries) ? parsed.libraries : []

    const entries = []
    const seen = new Set()
    for (const row of rows) {
      const entry = normalizeEntry(row)
      if (!entry || seen.has(entry.id)) continue
      seen.add(entry.id)
      entries.push(entry)
      if (entries.length >= MAX_LIBRARIES) break
    }
    return entries
  }

  async function writeEntries(entries) {
    await fs.mkdir(storeDir, { recursive: true })
    const temp = `${librariesFile}.${process.pid}.tmp`
    const payload = { libraries: entries }
    await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
    await fs.rename(temp, librariesFile)
  }

  /**
   * Everything a source contributes right now, parsed from scratch.
   *
   * A directory is always a component library, and it is read by SCANNING
   * rather than by parsing a text blob — which is why `components` has no
   * `parseLibrary` branch and never will.
   */
  async function readCatalog(source, fallbackName) {
    const { absolute, real } = await resolveSource(projectRoot, source.path)
    if (real === null) throw new Error(`${source.path} is no longer in this project`)

    if (source.kind === "components") {
      // `projectRoot` is only nominally optional here. Each component reports
      // the file that declares it, and that path is what the insertion writer
      // turns into an `import` specifier — so measured against the scanned
      // directory rather than the project, every import a placed component
      // needs would name a file that does not exist. The scan's own fallback is
      // for a caller with no project to measure against; this one has one.
      const scan = await scanComponentLibrary(absolute, { projectRoot })
      return { ...emptyCatalog(fallbackName), components: scan?.components ?? [] }
    }

    const stat = await fs.stat(absolute)
    if (!stat.isFile()) throw new Error(`${source.path} is a directory, not a ${source.kind} file`)
    if (stat.size > MAX_SOURCE_BYTES) {
      throw new Error(`${source.path} is too large to read as a design system`)
    }
    // The same file under the same kind and name parses to the same catalog
    // until its stat changes — or the stat of a stylesheet it imports — and
    // `list()` runs on every panel repaint. Callers copy what they hand out
    // (`libraryView`), so sharing the object is safe.
    const key = `${source.kind}\0${absolute}\0${fallbackName}`
    const cached = parsedCatalogs.get(key)
    if (cached && cached.stamp === (await stampOf([absolute, ...cached.imports]))) return cached.catalog
    let text = await fs.readFile(absolute, "utf8")
    let imports = []
    if (source.kind === "css") {
      const parts = await importedInProject(absolute, text)
      imports = parts.map((part) => part.absolute)
      // Imports first, which is where the cascade puts them: a name the file
      // itself redeclares is the file's.
      text = [...parts.map((part) => part.text), text].join("\n")
    }
    const catalog = parseLibrary(source.kind, text, { name: fallbackName })
    parsedCatalogs.set(key, { stamp: await stampOf([absolute, ...imports]), imports, catalog })
    return catalog
  }

  /** `mtimeMs:size` for every path, so a change to any of them is a new stamp. */
  async function stampOf(paths) {
    const parts = await Promise.all(
      paths.map((file) =>
        fs.stat(file).then(
          (stat) => `${stat.mtimeMs}:${stat.size}`,
          () => "missing"
        )
      )
    )
    return parts.join("|")
  }

  /**
   * The stylesheets a library stylesheet `@import`s, one level down, kept to
   * this project.
   *
   * A design system's published entry is often nothing but imports — an
   * `index.css` over its global, colour and scale files — and read alone it
   * declared no custom properties: the library was refused as "carries no
   * tokens" while the tokens sat one file away. The same rule the host's own
   * detection follows (`importedStylesheets`), plus the symlink check every
   * other path here goes through, because an import is a path too.
   */
  async function importedInProject(absolute, text) {
    const realRoot = (await canonical(projectRoot)) ?? projectRoot
    const parts = importedStylesheets(absolute, text, projectRoot)
    const kept = []
    for (const part of parts) {
      const real = await canonical(part.absolute)
      const contained = real === null ? null : path.relative(realRoot, real)
      if (contained && !contained.startsWith("..") && !path.isAbsolute(contained)) kept.push(part)
    }
    return kept
  }

  /** `kind\0absolute\0name` -> `{ mtimeMs, size, catalog }`; see `readCatalog`. */
  const parsedCatalogs = new Map()

  /**
   * The wire shape of one library — and the one place icon drawings are dropped.
   *
   * `counts.iconDrawings` still reports how many there are; `icons(id)` is the
   * only thing that serves them. That is the trade `server/icon-set.mjs` makes
   * for the host's own set, for the same reason: path data is big (the set this
   * package was built against is 114KB), and most sessions never open the icon
   * picker. Listing libraries is something the panel does on every refresh.
   */
  function libraryView(entry, catalog, error, detail) {
    return {
      id: entry.id,
      name: entry.name,
      enabled: entry.enabled,
      source: { ...entry.source },
      addedAt: entry.addedAt,
      counts: libraryCounts(catalog),
      catalog: { ...catalog, iconDrawings: [] },
      ...(detail ? { detail } : {}),
      ...(error ? { error } : {}),
    }
  }

  /**
   * Whether a stored row is a URL library nobody is signed in to.
   *
   * Read off the SHAPE of the row rather than off a flag, because the rows this
   * has to catch were written by a version that had no flag to set: a url
   * source, an empty catalog, and an error that is the sign-in sentence. The
   * sentence is matched on its stable half — the two words the panel shows —
   * rather than on the whole string, so rewording the message does not quietly
   * turn the sweep off.
   */
  function isWalledEntry(entry) {
    if (entry?.source?.kind !== URL_SOURCE_KIND) return false
    const components = entry.catalog?.components?.length ?? 0
    const empty = !entry.catalog || components === 0
    return empty && /needs sign-in/i.test(String(entry.error ?? ""))
  }

  async function loadLibrary(entry) {
    if (entry.source.kind === URL_SOURCE_KIND) {
      // No fetch and no parse: the catalog was resolved when the library was
      // added and renewed when it was refreshed. See the header.
      return libraryView(
        entry,
        entry.catalog ?? emptyCatalog(entry.name),
        entry.error || (entry.catalog ? "" : "This library has not been fetched yet"),
        entry.detail
      )
    }
    try {
      return libraryView(entry, await readCatalog(entry.source, entry.name))
    } catch (error) {
      return libraryView(
        entry,
        emptyCatalog(entry.name),
        error?.message || "This library could not be read"
      )
    }
  }

  /**
   * Everything at a URL, in the shape the pointer file stores.
   *
   * Icon drawings are dropped before the catalog is cached, and that is a
   * decision rather than an oversight. This catalog is written into
   * `libraries.json` verbatim and read back on every `list()`; a four-thousand
   * glyph dump would turn a file the editor re-reads constantly into megabytes
   * of path data. The local kinds can afford drawings because they are re-read
   * from their own source and served by `icons(id)` on demand — a URL library
   * has no such source to go back to without another round trip, so it
   * contributes tokens and components and no glyphs.
   */
  async function fetchUrlCatalog(url, requestedName) {
    /*
     * The stored credential for this origin, looked up per fetch rather than
     * held.
     *
     * Per fetch because signing in happens WHILE the editor is open — that is
     * the entire point of the flow — so a credential captured at construction
     * would make every library added before the sign-in permanently walled, and
     * a refresh would not fix it.
     */
    const credential = authStore ? await authStore.credentialFor(url) : null
    const result = await parseUrlLibrary(url, { ...urlOptions, credential })
    const named = typeof requestedName === "string" ? requestedName.trim() : ""
    const name = (named || result.name || url).slice(0, MAX_NAME)
    return {
      name,
      catalog: { ...result.catalog, name, iconDrawings: [] },
      detail: result.detail,
      auth: result.auth ?? null,
      error: result.error,
    }
  }

  /**
   * Re-reading a URL catalog that older reading rules produced.
   *
   * Re-pasting the link already re-reads it (see `addUrl`), but nobody re-pastes
   * a link that looks fine, and a wrong reading usually does: an icon scale
   * listed as text styles is a full, plausible picker. So `list()` does it for
   * them, once per process per row — a site that is down or walled is not asked
   * again on every repaint, and keeps the reading it had, exactly as a failed
   * re-paste does. Only enabled rows: a switched-off library's tokens are in no
   * picker, and its first list after being switched on catches it.
   */
  const rereads = new Map()

  function readByOlderRules(entry) {
    return (
      entry.source.kind === URL_SOURCE_KIND &&
      entry.enabled &&
      isPlainObject(entry.catalog) &&
      (entry.reader ?? 1) < CATALOG_READER_VERSION
    )
  }

  function reread(entry) {
    const pending = rereads.get(entry.id)
    if (pending) return pending
    const run = fetchUrlCatalog(entry.source.path, entry.name)
      .then((fresh) => {
        if (fresh.auth || fresh.error) return
        return serial(async () => {
          const entries = await readEntries()
          const index = entries.findIndex((row) => row.id === entry.id)
          if (index === -1) return
          entries[index] = {
            ...entries[index],
            catalog: fresh.catalog,
            detail: fresh.detail,
            error: "",
            reader: CATALOG_READER_VERSION,
          }
          await writeEntries(entries)
        })
      })
      .catch(() => undefined)
    rereads.set(entry.id, run)
    return run
  }

  /**
   * A URL's library id: the same slug every other source gets, cut to the
   * ceiling `LIBRARY_ID_PATTERN` enforces.
   *
   * The cut is where a hash becomes necessary. Two deep links into one
   * documentation site share a long prefix, so a plain truncation would give
   * them the same id — and `add` answers an id it already holds by returning
   * the EXISTING library, so the second paste would silently hand the designer
   * the first one back and look like it worked.
   */
  function urlLibraryId(target) {
    const full = libraryId(target)
    if (full.length <= MAX_ID) return full
    const digest = createHash("sha1").update(target).digest("hex").slice(0, 8)
    return `${full.slice(0, MAX_ID - digest.length - 1).replace(/-+$/, "")}-${digest}`
  }

  /**
   * Install a URL.
   *
   * Separate from `add`'s path branch rather than folded into it, because
   * `resolveSource` is the whole of that branch and none of it applies here.
   * Absolute, `..` and symlink-escapes are statements about a filesystem a URL
   * is not on; run against one they would refuse the feature rather than secure
   * it. What replaces them is `isLibraryUrl`, which is the matching question for
   * this input: is this a thing this process is willing to fetch at all.
   */
  async function addUrl(requested, name) {
    if (requested.length > MAX_URL) {
      throw badRequest("That URL is too long to be a page somebody pasted")
    }
    if (!isLibraryUrl(requested)) {
      throw badRequest(
        `"${requested}" is not a web address this editor can fetch. ` +
          "A library URL starts with http:// or https://"
      )
    }
    // Normalized so that the same page pasted twice — once with a trailing
    // slash, once without — is one library rather than two.
    const target = new URL(requested).toString()
    const id = urlLibraryId(target)

    /*
     * PASTING A LINK THAT IS ALREADY INSTALLED RE-READS IT, where this used to
     * hand back the stored row untouched.
     *
     * A URL library's catalog is a snapshot. `list()` re-parses a local file on
     * every call, but re-fetching every URL on every call would put somebody
     * else's network on the panel's hot path — so what is on disk is whatever
     * the site said at the moment it was added, and there was no way back once
     * that snapshot was wrong.
     *
     * It is wrong more often than "the site changed". It is wrong for every row
     * added while this editor had a bug in its own reading, which is not
     * hypothetical: a stylesheet-parsing fix landed here and left every library
     * added before it reporting zero colours, with the designer looking at an
     * empty row and an editor that by then knew perfectly well how to read it.
     *
     * Re-pasting the link is what a person does when something looks wrong, and
     * it is the only gesture the panel already has that means "try that again".
     * So it means that now. Nothing else moves: the id is derived from the URL,
     * so the row keeps its place, its name and its switch, and the list does
     * not grow — which is what adding the same page twice has always promised.
     *
     * A FAILED re-read keeps the catalog it had. Otherwise a designer who
     * re-pastes on a flaky connection loses the tokens that were working a
     * moment ago, and the gesture becomes one to be afraid of.
     */
    const installed = (await serial(readEntries)).find(
      (entry) => entry.id === id || entry.source.path === target
    )
    if (installed) {
      const fresh = await fetchUrlCatalog(target, installed.name)
      // A wall is reported exactly as it is on a first add: the credential has
      // expired, and the panel's sign-in is the way back to a reading.
      if (fresh.auth) {
        const error = badRequest(fresh.error)
        error.auth = { ...fresh.auth, url: target }
        throw error
      }
      if (fresh.error) return { library: await loadLibrary(installed) }
      return serial(async () => {
        const entries = await readEntries()
        const index = entries.findIndex((entry) => entry.id === installed.id)
        if (index === -1) return { library: await loadLibrary(installed) }
        const entry = {
          ...entries[index],
          catalog: fresh.catalog,
          detail: fresh.detail,
          error: "",
          reader: CATALOG_READER_VERSION,
        }
        entries[index] = entry
        await writeEntries(entries)
        return { library: await loadLibrary(entry) }
      })
    }

    // Outside the queue on purpose: `serial` keeps two panels from clobbering
    // each other's row, and holding it across somebody else's network latency
    // would block every `list()` the panel makes while this is in flight.
    const fetched = await fetchUrlCatalog(target, name)

    /*
     * Refused, with the challenge attached so the panel can offer a way in.
     *
     * Thrown BEFORE the queue is taken: there is nothing to write, and holding
     * the write lock to decline would block every `list()` a panel makes for
     * the length of somebody else's failed sign-in.
     */
    if (fetched.auth) {
      const error = badRequest(fetched.error)
      error.auth = { ...fetched.auth, url: target }
      throw error
    }

    return serial(async () => {
      const entries = await readEntries()
      // Checked twice: once above to skip a pointless fetch, and again here
      // because the fetch is where a second panel gets its chance to add the
      // same URL.
      const already = entries.find((entry) => entry.id === id || entry.source.path === target)
      if (already) return { library: await loadLibrary(already) }
      if (entries.length >= MAX_LIBRARIES) {
        throw badRequest(
          `This project already has ${MAX_LIBRARIES} libraries. Remove one before adding another.`
        )
      }

      /*
       * A URL that could not be read is INSTALLED ANYWAY, carrying its
       * sentence — the opposite of what the path branch does, and deliberately.
       *
       * A file is refused at the door because the designer chose it out of
       * their own project and can immediately choose a better one. A URL fails
       * for reasons that are about the network and about whether this machine
       * is signed in, and the first of those changes while the editor is open.
       * The row is what carries the retry and the removal, so declining to
       * create it would leave a designer holding a failure with nothing to
       * click — which is the same rule `list()` already applies to a file that
       * has been deleted out from under a library.
       *
       * A SIGN-IN WALL IS THE ONE EXCEPTION, and it is refused above rather
       * than stored. The others are a library this editor can see and could not
       * use; a wall is a library this editor cannot see AT ALL. Storing one
       * puts a row in the panel named after a site, reporting zero colours and
       * zero components, and that row is a lie in the only way that matters: a
       * designer reading it concludes the design system is empty rather than
       * that they are signed out. The whole authentication flow hangs off that
       * distinction — see `library-auth.mjs`.
       */
      const entry = {
        id,
        name: fetched.name,
        enabled: true,
        source: { kind: URL_SOURCE_KIND, path: target },
        addedAt: Date.now(),
        catalog: fetched.catalog,
        detail: fetched.detail,
        error: fetched.error,
        reader: CATALOG_READER_VERSION,
      }
      await writeEntries([...entries, entry])
      return { library: await loadLibrary(entry) }
    })
  }

  /** The kind a path is, which for a directory is settled before anything is read. */
  async function sourceKind(source, stat, requested) {
    const explicit = typeof requested === "string" ? requested.trim() : ""

    if (stat.isDirectory()) {
      if (explicit && explicit !== "components") {
        throw badRequest(
          `"${source.relative}" is a directory, which can only be added as a components library`
        )
      }
      return "components"
    }

    if (explicit) {
      if (!LIBRARY_SOURCE_KINDS.includes(explicit)) {
        throw badRequest(`"${explicit}" is not a library kind`)
      }
      // `url` is a kind, but it is not a kind a PATH can be. Letting it through
      // here would store a row claiming a file is a web page, and every reader
      // of that row would then look for a cached catalog that does not exist.
      if (explicit === URL_SOURCE_KIND) {
        throw badRequest("A url library is added with a url, not with a path inside the project")
      }
      return explicit
    }

    if (stat.size > MAX_SOURCE_BYTES) {
      throw badRequest(`"${source.relative}" is too large to read as a design system`)
    }
    let text = await fs.readFile(source.absolute, "utf8")
    // Judged with its imports, as it will be read: an entry made of nothing but
    // `@import`s carries its tokens in the files it names.
    if (/\.s?css$/i.test(source.relative)) {
      const parts = await importedInProject(source.absolute, text)
      text = [...parts.map((part) => part.text), text].join("\n")
    }
    const detected = detectLibraryKind(source.relative, text)
    if (!detected) {
      throw badRequest(
        `"${source.relative}" is not a design system this editor recognises. It reads one of: ` +
          "manifest, css, tokens, icons — or a directory of components."
      )
    }
    return detected
  }

  /**
   * Everything a project already has that could be a library.
   *
   * The walk skips what a designer would never mean: vendored and generated
   * directories, every dot-directory (which is also how the editor's own state
   * directory stays out of its own scan), and the JSON files that are certainly
   * configuration. Only real files and real directories are considered —
   * `withFileTypes` reports a symlink as neither, so the scan cannot be led out
   * of the project by one and never offers a candidate `add` would then refuse.
   */
  async function scan(installed) {
    const found = []
    const componentDirs = []
    let visited = 0
    let walked = 0
    let probed = 0

    const fileCandidate = async (absolute, relative) => {
      const extension = path.extname(relative).toLowerCase()
      if (!SOURCE_EXTENSIONS.has(extension)) return null
      if (extension === ".json" && SKIP_JSON.test(path.posix.basename(relative))) return null

      let text
      try {
        const stat = await fs.stat(absolute)
        if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return null
        text = await fs.readFile(absolute, "utf8")
        // Offered as it would be read once added: with what it imports.
        if (extension === ".css" && /@import\b/.test(text)) {
          const parts = await importedInProject(absolute, text)
          text = [...parts.map((part) => part.text), text].join("\n")
        }
      } catch {
        return null
      }

      // A file that cannot be detected or parsed is not a candidate. Discovery
      // is a suggestion, so it stays silent about anything it is unsure of
      // rather than offering a card whose Add button would fail.
      try {
        const kind = detectLibraryKind(relative, text)
        if (!kind) return null
        const fallback = nameFromPath(relative)
        const catalog = parseLibrary(kind, text, { name: fallback })
        const counts = libraryCounts(catalog)
        if (!worthOffering(kind, counts)) return null
        const name = typeof catalog?.name === "string" && catalog.name.trim() ? catalog.name : fallback
        return {
          weight: totalTokens(counts),
          candidate: {
            path: relative,
            kind,
            name: name.slice(0, MAX_NAME),
            detail: describeLibrary(kind, catalog) || "A design system file",
            installed: false,
          },
        }
      } catch {
        return null
      }
    }

    const componentCandidate = async (absolute, relative) => {
      let components = []
      let framework = null
      try {
        // A bounded scan: this runs over the whole project, and the detail line
        // only has to be true enough to choose by. The add itself scans fully.
        const result = await scanComponentLibrary(absolute, {
          maxFiles: DISCOVERY_SCAN_FILES,
          projectRoot,
        })
        components = Array.isArray(result?.components) ? result.components : []
        framework = result?.framework ?? null
      } catch {
        return null
      }
      if (components.length === 0) return null

      const label = FRAMEWORK_LABELS[framework] ? `${FRAMEWORK_LABELS[framework]} ` : ""
      const noun = components.length === 1 ? "component" : "components"
      return {
        weight: components.length,
        candidate: {
          path: relative,
          kind: "components",
          name: nameFromPath(relative),
          detail: `${components.length} ${label}${noun}`,
          installed: false,
        },
      }
    }

    const qualifiesAsComponents = async (absolute) => {
      try {
        return (await looksLikeComponentLibrary(absolute)) === true
      } catch {
        return false
      }
    }

    /**
     * Returns whether a component library was taken at or below `directory`,
     * which is how the DEEPEST qualifying directory becomes the candidate.
     *
     * `looksLikeComponentLibrary` reads a directory's own files and one level
     * below them, because a library that gives each component its own folder is
     * a real layout. That generosity is why a qualifying directory cannot be
     * claimed on the way down: `src/` passes the probe on the strength of
     * `src/components/*.tsx`, and claiming it there would offer a designer their
     * whole source tree as one library — and, because a claimed directory is not
     * descended into, would hide every stylesheet under it as well. Going down
     * first and claiming on the way back up names `src/components`, which is
     * what the designer meant.
     *
     * Files are collected on the way down regardless, so a component library
     * that also ships a `tokens.css` offers both.
     */
    const walk = async (directory, relative) => {
      if (visited >= MAX_VISITED_FILES || found.length >= MAX_CANDIDATES) return false
      if (walked >= MAX_VISITED_DIRECTORIES) return false
      walked += 1
      let entries
      try {
        entries = await fs.readdir(directory, { withFileTypes: true })
      } catch {
        // A directory this process may not read is a directory with no
        // libraries in it, not a reason to abandon the scan.
        return false
      }
      entries.sort((first, second) => first.name.localeCompare(second.name))

      const subdirectories = []
      for (const entry of entries) {
        if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) continue
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          subdirectories.push([path.join(directory, entry.name), childRelative])
          continue
        }
        if (!entry.isFile()) continue
        // The budget is spent on files this walk would actually open. A name and
        // an extension are already in hand from `readdir`, so rejecting an image
        // here costs nothing and must not be charged for — see
        // `MAX_VISITED_FILES`.
        if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
        if (visited >= MAX_VISITED_FILES) break
        visited += 1
        const hit = await fileCandidate(path.join(directory, entry.name), childRelative)
        if (hit) found.push(hit)
        if (found.length >= MAX_CANDIDATES) return false
      }

      let claimedBelow = false
      for (const [child, childRelative] of subdirectories) {
        if (await walk(child, childRelative)) claimedBelow = true
      }
      if (claimedBelow || relative === "") return claimedBelow
      if (componentDirs.length >= MAX_COMPONENT_CANDIDATES || probed >= MAX_COMPONENT_PROBES) {
        return false
      }

      probed += 1
      if (!(await qualifiesAsComponents(directory))) return false
      const hit = await componentCandidate(directory, relative)
      if (!hit) return false
      componentDirs.push(hit)
      return true
    }

    await walk(projectRoot, "")

    return [...found, ...componentDirs]
      .sort((first, second) => {
        const byKind =
          KIND_RANK.indexOf(first.candidate.kind) - KIND_RANK.indexOf(second.candidate.kind)
        if (byKind !== 0) return byKind
        const byPlace =
          Number(conventionallyPlaced(second.candidate.path)) -
          Number(conventionallyPlaced(first.candidate.path))
        return byPlace !== 0 ? byPlace : second.weight - first.weight
      })
      .map(({ candidate }) => ({ ...candidate, installed: installed.has(candidate.path) }))
  }

  return {
    librariesFile,

    /**
     * Every library, re-read from its source. The catalogs here are current as
     * of this call: only the parse of an unchanged file is reused — see the
     * header.
     */
    async list() {
      const entries = await serial(readEntries)
      /*
       * A stored URL library that is behind a sign-in wall is swept, not shown.
       *
       * `addUrl` refuses to create one, so in a store written by this version
       * there are none — but a store written before the wall was refused still
       * holds them, and so does one whose credential has since been forgotten
       * or expired. The rule the designer was promised is that an
       * unauthenticated library does not appear, and a rule that only holds for
       * rows added after the upgrade is not the rule.
       *
       * Swept from the FILE as well as from the answer, so the next add of the
       * same URL is a clean install rather than a collision with a ghost that
       * `addUrl`'s own idempotence check would hand straight back.
       */
      const walled = entries.filter(isWalledEntry)
      if (walled.length) {
        const ghosts = new Set(walled.map((entry) => entry.id))
        await serial(async () => {
          const current = await readEntries()
          const kept = current.filter((entry) => !ghosts.has(entry.id))
          if (kept.length !== current.length) await writeEntries(kept)
        })
      }
      let live = entries.filter((entry) => !isWalledEntry(entry))
      /*
       * Waited for, up to a bound. The list this answers is the one the pickers
       * are built from, so answering before the re-read lands would show the old
       * reading for the whole of the first session after an upgrade. A site
       * slower than the bound is answered with what is cached, and the re-read
       * still lands for the next list.
       */
      const stale = live.filter(readByOlderRules)
      if (stale.length) {
        let timer = null
        await Promise.race([
          Promise.all(stale.map(reread)),
          new Promise((resolve) => {
            timer = setTimeout(resolve, REREAD_WAIT_MS)
            timer.unref?.()
          }),
        ])
        clearTimeout(timer)
        live = (await serial(readEntries)).filter((entry) => !isWalledEntry(entry))
      }
      return { libraries: await Promise.all(live.map(loadLibrary)) }
    },

    async discover() {
      const entries = await serial(readEntries)
      return { candidates: await scan(new Set(entries.map((entry) => entry.source.path))) }
    },

    /**
     * Install a source. Idempotent on a path that is already installed, because
     * the Add panel keeps offering a candidate after it has been added and a
     * double click on it must not produce a second card with a second id.
     *
     * `{ url }` and `{ path }` are two different inputs rather than one field
     * the caller spells differently, so that neither branch has to guess which
     * it was handed. See `addUrl` for why they cannot share a validator.
     */
    async add({ path: requestedPath, url, kind, name } = {}) {
      if (typeof url === "string" && url.trim()) return addUrl(url.trim(), name)

      const source = await resolveSource(projectRoot, requestedPath)
      if (source.real === null) {
        throw badRequest(`There is nothing at "${source.relative}" in this project`)
      }

      let id
      try {
        id = libraryId(source.relative)
      } catch {
        throw badRequest(`"${source.relative}" cannot be named as a library`)
      }

      return serial(async () => {
        const entries = await readEntries()
        const existing = entries.find(
          (entry) => entry.id === id || entry.source.path === source.relative
        )
        if (existing) return { library: await loadLibrary(existing) }

        if (entries.length >= MAX_LIBRARIES) {
          throw badRequest(
            `This project already has ${MAX_LIBRARIES} libraries. Remove one before adding another.`
          )
        }

        const stat = await fs.stat(source.absolute)
        const resolvedKind = await sourceKind(source, stat, kind)
        const fallback = nameFromPath(source.relative)

        let catalog
        try {
          catalog = await readCatalog({ kind: resolvedKind, path: source.relative }, fallback)
        } catch (error) {
          // A source that cannot be parsed is refused at the door rather than
          // stored as a row that will only ever report an error. Once a library
          // is installed a later failure is reported instead — the row is the
          // only way to remove it.
          if (error?.statusCode) throw error
          throw badRequest(
            `"${source.relative}" could not be read as a ${resolvedKind} library: ${error.message}`
          )
        }

        const requestedName = typeof name === "string" ? name.trim() : ""
        const catalogName = typeof catalog?.name === "string" ? catalog.name.trim() : ""
        const entry = {
          id,
          name: (requestedName || catalogName || fallback).slice(0, MAX_NAME),
          enabled: true,
          source: { kind: resolvedKind, path: source.relative },
          addedAt: Date.now(),
        }

        await writeEntries([...entries, entry])
        return { library: libraryView(entry, catalog) }
      })
    },

    /**
     * `{ enabled }`, `{ name }` and `{ refresh: true }`.
     *
     * Refresh is a verb only a URL library has. A file library re-reads and
     * re-parses on every `list()`, so asking one to refresh is asking for what
     * it is already doing — and answering with a no-op rather than an error
     * keeps the panel from having to know which kind it is looking at.
     */
    async update(id, changes = {}) {
      // The fetch is outside the queue for the reason `addUrl` gives: a refresh
      // in flight must not stop the panel from listing.
      let refreshed = null
      if (changes?.refresh === true) {
        const current = (await serial(readEntries)).find((entry) => entry.id === id)
        if (current?.source.kind === URL_SOURCE_KIND) {
          refreshed = await fetchUrlCatalog(current.source.path, current.name)
        }
      }

      return serial(async () => {
        const entries = await readEntries()
        const index = entries.findIndex((entry) => entry.id === id)
        if (index === -1) throw badRequest(`No library with the id "${id}"`, 404)

        const entry = { ...entries[index] }
        if (typeof changes?.enabled === "boolean") entry.enabled = changes.enabled
        const renamed = typeof changes?.name === "string" ? changes.name.trim() : ""
        if (renamed) entry.name = renamed.slice(0, MAX_NAME)
        if (refreshed) {
          entry.catalog = refreshed.catalog
          entry.detail = refreshed.detail
          entry.error = refreshed.error
          entry.reader = CATALOG_READER_VERSION
        }

        entries[index] = entry
        await writeEntries(entries)
        return { library: await loadLibrary(entry) }
      })
    },

    /** `{ ok: false }` rather than a 404: removing a row twice is not an error. */
    async remove(id) {
      return serial(async () => {
        const entries = await readEntries()
        const kept = entries.filter((entry) => entry.id !== id)
        if (kept.length === entries.length) return { ok: false }
        await writeEntries(kept)
        return { ok: true }
      })
    },

    /** The drawings `list()` deliberately does not carry, for one library. */
    async icons(id) {
      const entries = await serial(readEntries)
      const entry = entries.find((candidate) => candidate.id === id)
      if (!entry) throw badRequest(`No library with the id "${id}"`, 404)
      // A URL library's cached catalog deliberately carries no drawings, so
      // there is nothing here to serve and nowhere to go and get them without
      // a second round trip. See `fetchUrlCatalog`.
      if (entry.source.kind === URL_SOURCE_KIND) return { attribute: "", icons: [] }

      try {
        const catalog = await readCatalog(entry.source, entry.name)
        return {
          attribute: typeof catalog?.iconAttribute === "string" ? catalog.iconAttribute : "",
          icons: Array.isArray(catalog?.iconDrawings) ? catalog.iconDrawings : [],
        }
      } catch {
        // Same answer `list()` gives for a source that has gone away: the row
        // survives its file, and a picker with no glyphs in it still renders.
        return { attribute: "", icons: [] }
      }
    },
  }
}
