/**
 * Where a project's own design system is, when nobody has said.
 *
 * The host catalog used to be entirely declarative: no `designlayer.config.mjs`
 * naming a manifest, an adapter or a `cssSources` entry meant no tokens at all,
 * and every token picker in the inspector suppressed itself. That is the wrong
 * answer for the commonest project this tool is ever pointed at — a stock
 * Next + Tailwind + shadcn app whose entire palette is twenty-two custom
 * properties in `app/globals.css`, sitting in a file the editor could read the
 * whole time and was never told to look at. A designer running `npx designlayer`
 * against somebody else's prototype has no config file and is not going to write
 * one, so "declare it" is not a workaround, it is the feature not existing.
 *
 * THIS IS RESOLUTION, NOT A WALK, and that is the load-bearing decision.
 *
 * The obvious implementation is to reuse the library discovery scan — it already
 * crawls the project and already finds `app/globals.css`. It is the wrong tool
 * here for two reasons. It runs on the wrong budget: this is on the startup
 * path, ahead of the first paint, and a crawl of a Next app with four thousand
 * generated OG images in `public/` costs real wall-clock time to answer a
 * question a dozen `stat` calls can answer. And it has the wrong failure mode:
 * a crawl offers whatever it happens to find, so it will happily nominate a
 * vendored copy of Open Props under `public/`, a `theme.css` under
 * `test/fixtures/`, or a component stylesheet that declared three one-off
 * values — and where discovery's mistakes cost a bad row in a list the designer
 * is reading, a mistake HERE silently becomes "this project's design system"
 * everywhere in the editor.
 *
 * So this module only ever looks where a build tool would look: the conventional
 * entry stylesheets, what `components.json` points at, one level of the entry's
 * own `@import`s, the Tailwind config, and packages the project's own manifest
 * DECLARES as dependencies. Every one of those is a place the project itself
 * says its styles come from. Nothing is found by crawling, so a file the build
 * never compiles cannot be nominated however token-shaped it looks.
 *
 * WHAT COUNTS AS A DESIGN SYSTEM IS NOT DECIDED HERE. A candidate is parsed with
 * the same `parseLibrary` discovery uses and judged by the same `worthAdopting`
 * bar, so a CSS reset, a component stylesheet or a file of three one-off values
 * is rejected by the rule that already rejects it in the Add panel. A second
 * notion of "is this a design system" would drift from the first one within a
 * release, and then the panel and the startup path would disagree about the same
 * file in front of the same person.
 *
 * Nothing here is authoritative over the host. `resolveDesignSystemConfig` calls
 * this only when the project declared no manifest, no adapter, no `cssSources`
 * and no Tailwind theme — a project that said where its tokens are is never
 * second-guessed, and finding nothing leaves the empty catalog that was the only
 * answer before this existed.
 */

import fs from "node:fs"
import path from "node:path"

import { libraryCounts, parseLibrary } from "./library-sources.mjs"
import { worthAdopting } from "./libraries.mjs"

/** Past this a "stylesheet" is a build output, and reading it is a stall. */
const MAX_STYLESHEET_BYTES = 2 * 1024 * 1024

/**
 * The entry stylesheets, most authoritative first, and why these and not more.
 *
 * Each one is a path a framework's own scaffolder writes, not a path that merely
 * sounds plausible: `app/globals.css` is what `create-next-app` emits and what
 * `shadcn init` writes into, `src/index.css` is Vite's, `src/styles.css` is
 * `ng new`'s, `src/app.css` is SvelteKit's. A list of guesses would be a list of
 * chances to nominate the wrong file; a list of scaffolder output is a list of
 * files the build definitely compiles.
 *
 * Order is by how likely the file is to be THE entry rather than one of several,
 * because the first candidate that clears the bar wins and the rest are never
 * read. A project with both an `app/globals.css` and a `src/styles/tokens.css`
 * is a project whose entry imports the second from the first, which the import
 * pass below picks up — appending every convention hit instead would pull in
 * stylesheets the build may not compile at all, and put tokens in the picker
 * that the page on screen has never seen.
 */
const CONVENTIONAL_STYLESHEETS = [
  "app/globals.css",
  "src/app/globals.css",
  "app/global.css",
  "src/index.css",
  "src/styles/globals.css",
  "styles/globals.css",
  "src/global.css",
  "src/app.css",
  "src/styles.css",
  "src/styles.scss",
]

/**
 * Folders whose stylesheets are read by name when no conventional entry cleared
 * the bar.
 *
 * A project that keeps its tokens in `src/styles/tokens.css` and imports them
 * from a component rather than from a global entry is ordinary, and naming
 * every spelling of "tokens" in the list above would be a losing game
 * (`tokens.css`, `theme.css`, `variables.css`, `design-tokens.css`, …). One
 * `readdir` of a folder that exists to hold stylesheets answers all of them.
 *
 * It stays a resolution rather than a crawl because the folders are named and
 * are never descended into: `src/styles/components/button.css` is not read,
 * which is what keeps a per-component stylesheet from being nominated on the
 * strength of the folder it sits in.
 */
const STYLE_DIRECTORIES = ["src/styles", "styles", "src/css", "app/styles"]

/**
 * `.scss` is read for the same reason `.css` is, and reading it is honest.
 *
 * The custom-property syntax is preprocessor-agnostic — `--brand: #f00` inside a
 * `.scss` file is a CSS custom property that Sass passes straight through — so
 * an Angular or Vue project whose tokens are in `src/styles.scss` is read
 * exactly as accurately as a Next project's `globals.css`. What is NOT read is
 * `$brand: #f00`, a Sass variable that has no existence at run time and that the
 * editor could never write into a page; a token list that included it would
 * offer values the inspector cannot bind to anything.
 */
const STYLE_EXTENSIONS = new Set([".css", ".scss"])

/** One folder listing, not a directory of a thousand generated partials. */
const MAX_DIRECTORY_ENTRIES = 40

/**
 * How many candidates are actually opened and parsed before this gives up.
 *
 * Naming a path costs nothing; reading and parsing one costs real time on the
 * startup path, and the folder sweep above can name forty. The conventional
 * entries are tried first and a stock project hits on the first or second, so
 * this ceiling is only ever reached by a project that keeps two dozen
 * stylesheets in `src/styles/` and none of them is its design system — where the
 * honest answer is the empty catalog rather than a slow one.
 */
const MAX_PARSED_CANDIDATES = 24

/**
 * shadcn's own declaration of where its stylesheet is.
 *
 * Read before the convention list because it is the only signal in this module
 * that is a STATEMENT rather than an inference: `shadcn init` wrote this key,
 * and a project that moved its stylesheet moved this pointer with it. It costs
 * one `readFile` and it is right on projects where every path in the list above
 * is wrong.
 */
const COMPONENTS_JSON = "components.json"

/**
 * Tailwind v3 keeps its scale in a JavaScript object rather than in a
 * stylesheet, so on a v3 project there is no custom property to find and the
 * convention list above can come back empty on a project that plainly has a
 * design system. `.ts` is listed even though `require` cannot evaluate it: the
 * caller degrades to "no v3 theme" rather than failing, and naming the file we
 * could not read is better than behaving as though a v3 project had no config.
 */
const TAILWIND_CONFIGS = [
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts",
]

/**
 * A dependency whose NAME claims to be a design system.
 *
 * The dependency probe exists for the company that ships its tokens as a
 * package — `import "@acme/design-tokens/tokens.css"` in `app/layout.tsx` — and
 * a name filter is what keeps it from becoming "read the first dependency that
 * ships a stylesheet". Without it, a project that depends on Bootstrap gets
 * Bootstrap's palette installed as its own design system, which clears every
 * token-count bar in this codebase with room to spare and is wrong in the way
 * that is hardest to notice: the pickers are full, so nothing looks broken.
 *
 * Matching the name is a weak signal and it is deliberately the only one. A
 * package called `@acme/tokens` is making a claim about itself; a package that
 * merely has a `style` field is not.
 */
const TOKEN_PACKAGE = /(^|[-/])(design-tokens|design-system|tokens|theme|themes)$/

/**
 * Where a token package keeps its stylesheet, plus whatever its own `style`
 * field names. Conventional filenames rather than a walk of the package, for
 * the reason the audit that prompted this gave: `node_modules` must never be
 * crawled, because the budget for it does not exist and every transitive
 * dependency's stylesheet would be a candidate.
 */
const PACKAGE_STYLESHEETS = [
  "tokens.css",
  "theme.css",
  "styles.css",
  "index.css",
  "dist/tokens.css",
  "dist/theme.css",
  "dist/styles.css",
  "dist/index.css",
]

/** A dependency list past this length is a lockfile, not a hand-written manifest. */
const MAX_PROBED_DEPENDENCIES = 100

/**
 * How far up to look for the `node_modules` a dependency was installed into.
 *
 * An app inside a monorepo resolves its dependencies through a hoisted
 * `node_modules` several levels above itself, so stopping at `projectRoot`
 * would make the probe answer "not installed" for a package that is plainly
 * installed. Five levels is deeper than any real `apps/web` sits and shallow
 * enough that a misconfigured root cannot walk to `/`.
 */
const MAX_NODE_MODULES_LEVELS = 5

/**
 * `@import` as it is actually written, in all four spellings.
 *
 * Following one level matters more than it sounds: a `globals.css` that is
 * nothing but three `@import`s over a `styles/` folder is a normal shape, and
 * read on its own it declares no custom properties at all — so without this the
 * detector would reject the project's real entry stylesheet as "carries no
 * tokens" and fall through to whatever it found next.
 *
 * One level and no further. Two levels is a graph, a graph needs cycle
 * detection and a budget, and no project in the wild hides its palette behind
 * two hops from the file the build compiles.
 */
const IMPORT_RULE = /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^\s"';()]+))/g

/** One entry's imports, capped so a generated index cannot become a read loop. */
const MAX_IMPORTS = 12

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * A file's text, or null for anything this process should not spend time on.
 *
 * Every failure is the same answer — absent, unreadable, a directory, too big —
 * because detection has no user to report to. It runs before the editor exists
 * and its only two outcomes are "found the project's tokens" and "found
 * nothing, behave as this tool did before detection existed".
 */
function readTextFile(absolute) {
  try {
    const stat = fs.statSync(absolute)
    if (!stat.isFile() || stat.size > MAX_STYLESHEET_BYTES) return null
    return fs.readFileSync(absolute, "utf8")
  } catch {
    return null
  }
}

function readJsonFile(absolute) {
  const text = readTextFile(absolute)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** True when `target` is at or below `boundary`, with both spelled lexically. */
function contains(boundary, target) {
  const relative = path.relative(boundary, target)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

/**
 * The stylesheets one entry pulls in, resolved against the entry's own folder.
 *
 * Only a specifier that ends in a stylesheet extension is followed, which is
 * what silently drops Tailwind v4's own `@import "tailwindcss"` — a bare package
 * name with no extension, and a file this editor has no business reading even if
 * it could find it. A bare specifier that DOES carry an extension
 * (`@import "tailwindcss/preflight.css"`) resolves to a path that does not
 * exist beside the entry and falls out at the read.
 */
function importedStylesheets(entryAbsolute, text, boundary) {
  const directory = path.dirname(entryAbsolute)
  const imported = []
  const seen = new Set()
  for (const match of text.matchAll(IMPORT_RULE)) {
    if (imported.length >= MAX_IMPORTS) break
    const specifier = (match[1] ?? match[2] ?? match[3] ?? "").trim()
    if (!specifier || /^[a-z][a-z0-9+.-]*:/i.test(specifier) || specifier.startsWith("//")) continue
    if (!STYLE_EXTENSIONS.has(path.extname(specifier).toLowerCase())) continue
    const absolute = path.resolve(directory, specifier)
    if (!contains(boundary, absolute) || seen.has(absolute)) continue
    seen.add(absolute)
    const partial = readTextFile(absolute)
    if (partial === null) continue
    imported.push({ absolute, text: partial })
  }
  return imported
}

/**
 * One entry stylesheet and its imports, as the single stylesheet the cascade
 * makes of them — or null when together they are not a design system.
 *
 * Concatenated rather than parsed separately, because a token file that is
 * split across an entry and two partials is one design system and reading it
 * three times would be three: `--button-bg: var(--brand-600)` in the entry can
 * only be resolved against the ramp the partial declares, and the theme tiers
 * `parseCssLibrary` reasons in — base, themed, dark — are properties of the
 * whole cascade rather than of any one file. Imports come first because that is
 * where the cascade puts them: `@import` must precede every other rule, so a
 * name the entry redeclares is the entry's.
 */
function stylesheetBundle(entryAbsolute, boundary, budget) {
  if (budget.parsed >= MAX_PARSED_CANDIDATES) return null
  const entryText = readTextFile(entryAbsolute)
  // Charged only for a file that was there. Naming a path a project does not
  // have costs one `stat`, and spending the budget on those would let ten
  // conventional misses starve the folder sweep that comes after them.
  if (entryText === null) return null
  budget.parsed += 1
  const imported = importedStylesheets(entryAbsolute, entryText, boundary)
  const parts = [...imported, { absolute: entryAbsolute, text: entryText }]
  const text = parts.map((part) => part.text).join("\n")

  /*
   * Judged on the DETECTION bar, which is not the Add panel's.
   *
   * `worthAdopting` in `libraries.mjs` sits beside `worthOffering` and the two
   * are documented against each other there. The short version: the Add panel
   * chooses one file out of a whole project and has to be strict, while this
   * has already been pointed at the entry stylesheet the build itself uses, and
   * that path is stronger evidence than any token count. Applying the strict
   * bar here refused real projects whose tokens were a palette and nothing
   * else.
   *
   * What still applies is emptiness. `parseLibrary` throws for a stylesheet
   * declaring no custom properties, and a catalog that parses to zero tokens is
   * refused — which is what keeps a CSS reset, or an entry that only `@import`s
   * a framework, from being adopted. The bar is read off the PARSED catalog and
   * never off the path, so it still holds for a file whose name sounds like
   * tokens and whose contents are not.
   */
  let catalog
  try {
    catalog = parseLibrary("css", text, { name: "" })
  } catch {
    return null
  }
  if (!worthAdopting(libraryCounts(catalog))) return null
  return { sources: parts.map((part) => part.absolute), text }
}

/** Every path a project might keep its entry stylesheet at, in order. */
function conventionalEntries(projectRoot) {
  const entries = []
  const add = (relative) => {
    const absolute = path.resolve(projectRoot, relative)
    if (!entries.includes(absolute)) entries.push(absolute)
  }

  const components = readJsonFile(path.join(projectRoot, COMPONENTS_JSON))
  const declared = components?.tailwind?.css
  if (typeof declared === "string" && declared.trim() && !path.isAbsolute(declared)) {
    const absolute = path.resolve(projectRoot, declared.trim())
    if (contains(projectRoot, absolute)) entries.push(absolute)
  }

  for (const relative of CONVENTIONAL_STYLESHEETS) add(relative)

  for (const directory of STYLE_DIRECTORIES) {
    let listing
    try {
      listing = fs.readdirSync(path.join(projectRoot, directory), { withFileTypes: true })
    } catch {
      continue
    }
    listing.sort((first, second) => first.name.localeCompare(second.name))
    let taken = 0
    for (const entry of listing) {
      if (taken >= MAX_DIRECTORY_ENTRIES) break
      if (!entry.isFile()) continue
      if (!STYLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
      taken += 1
      add(`${directory}/${entry.name}`)
    }
  }

  return entries
}

/**
 * The folder a declared dependency was installed into, with the workspace
 * symlink followed.
 *
 * Following it is the whole of the monorepo answer. In a pnpm or npm workspace
 * `apps/web/node_modules/@acme/tokens` is a symlink to `packages/tokens`, so
 * `realpath` lands on the sibling package and the "read the tokens out of a
 * workspace package" case needs no notion of a workspace root, no
 * `pnpm-workspace.yaml` parser, and no widening of any containment rule: the
 * package is reached because the app's own manifest DECLARES it, exactly as a
 * published dependency is.
 */
function packageDirectory(projectRoot, name) {
  let directory = projectRoot
  for (let level = 0; level <= MAX_NODE_MODULES_LEVELS; level += 1) {
    const candidate = path.join(directory, "node_modules", ...name.split("/"))
    try {
      const real = fs.realpathSync(candidate)
      if (fs.statSync(real).isDirectory()) return real
    } catch {
      // Not installed at this level. Keep going up: an app in a monorepo
      // resolves through a hoisted node_modules several folders above itself.
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

/**
 * A design system the project consumes as a package rather than authoring.
 *
 * Bounded by the dependency COUNT and by the name filter, never by a walk:
 * for each declared dependency whose name claims to be a design system, this
 * reads that package's manifest and probes a short list of conventional
 * filenames. A project with sixty dependencies and no token package costs sixty
 * failed `stat`s, which is nothing; a project with `node_modules` crawled would
 * cost the startup path a second and offer every transitive stylesheet.
 *
 * It runs only when the project's own stylesheets came back empty. A project
 * that has both is a project whose own entry is the design system it is looking
 * at on screen — the package is what that entry consumes, and preferring the
 * package would name the wrong owner for tokens the project may have overridden.
 */
function dependencyEntries(projectRoot) {
  const manifest = readJsonFile(path.join(projectRoot, "package.json"))
  if (!manifest) return []
  const names = [
    ...Object.keys(isPlainObject(manifest.dependencies) ? manifest.dependencies : {}),
    ...Object.keys(isPlainObject(manifest.devDependencies) ? manifest.devDependencies : {}),
  ].slice(0, MAX_PROBED_DEPENDENCIES)

  const entries = []
  for (const name of names) {
    if (!TOKEN_PACKAGE.test(name)) continue
    const directory = packageDirectory(projectRoot, name)
    if (!directory) continue

    const candidates = [...PACKAGE_STYLESHEETS]
    const own = readJsonFile(path.join(directory, "package.json"))?.style
    if (typeof own === "string" && own.trim() && !path.isAbsolute(own)) candidates.unshift(own.trim())

    for (const relative of candidates) {
      const absolute = path.resolve(directory, relative)
      if (!contains(directory, absolute)) continue
      entries.push({ absolute, boundary: directory, packageName: name })
    }
  }
  return entries
}

/**
 * A detected path as the panel should name it: project-relative when it is
 * inside the project, and package-relative when it came out of a dependency.
 *
 * The prelude has never carried an absolute path and this is not the reason to
 * start — `browserPrelude` documents why a path is a fact about this machine
 * that the page is not owed. "Detected in `app/globals.css`" is the sentence a
 * designer needs; "detected in /Users/…/Projects/whatever/app/globals.css" is
 * the same sentence with somebody's home directory in it. A dependency's file
 * gets `@acme/tokens/tokens.css`, which is how the project's own manifest
 * already names it and is a path in nobody's filesystem.
 */
function describeSource(projectRoot, absolute, pkg) {
  const base = pkg ? pkg.directory : projectRoot
  const relative = path.relative(base, absolute)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return path.basename(absolute)
  }
  const spelled = relative.split(path.sep).join("/")
  return pkg ? `${pkg.name}/${spelled}` : spelled
}

/**
 * The project's own design system, or nothing.
 *
 * `{ cssSources, tailwindConfig, detectedFrom }` — absolute paths for the
 * resolver to read, and a project-relative description of each for whatever
 * wants to tell the designer where the tokens came from. `cssSources` is in
 * cascade order, so the caller can concatenate it and get what the browser
 * would paint.
 */
export function detectHostDesignSystem(projectRoot) {
  const root = path.resolve(projectRoot)
  const budget = { parsed: 0 }
  let bundle = null
  let pkg = null

  for (const absolute of conventionalEntries(root)) {
    bundle = stylesheetBundle(absolute, root, budget)
    if (bundle) break
  }

  if (!bundle) {
    for (const entry of dependencyEntries(root)) {
      bundle = stylesheetBundle(entry.absolute, entry.boundary, budget)
      if (bundle) {
        pkg = { name: entry.packageName, directory: entry.boundary }
        break
      }
    }
  }

  /*
   * The v3 config is taken only when the stylesheets carry no `@theme`.
   *
   * `@theme` is Tailwind v4's spelling of a scale, so a stylesheet that has one
   * IS the scale and the JavaScript config beside it is either absent or a
   * leftover from the upgrade. Reading both would let a stale v3 `theme.extend`
   * contribute aliases for utilities the v4 build no longer generates — a wrong
   * answer the designer has no way to see, where taking only the v4 source is
   * at worst incomplete.
   */
  const tailwindConfig =
    bundle && /(^|[^\w-])@theme\b/.test(bundle.text)
      ? null
      : TAILWIND_CONFIGS.map((name) => path.join(root, name)).find((candidate) => {
          try {
            return fs.statSync(candidate).isFile()
          } catch {
            return false
          }
        }) ?? null

  const cssSources = bundle?.sources ?? []
  const detectedFrom = [
    ...cssSources.map((absolute) => describeSource(root, absolute, pkg)),
    ...(tailwindConfig ? [describeSource(root, tailwindConfig, null)] : []),
  ]
  return { cssSources, tailwindConfig, detectedFrom }
}
