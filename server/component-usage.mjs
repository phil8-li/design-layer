/**
 * How many places in the project render a component, so the editor can say so
 * before the designer changes one.
 *
 * Every other module in this folder answers a question about ONE file: where is
 * this element written, which variants does this component declare, what does
 * this library export. This one answers the question that only the whole
 * project can answer, and it exists because of the single most expensive
 * surprise this editor can hand someone. Selecting a button and nudging its
 * colour looks like a local edit — the canvas shows one button, the inspector
 * shows one element, the write touches one file — and if that button is the
 * design system's `Button`, the edit lands on all forty of them. The designer
 * finds out on the next page they open, or in review, or not at all. A count
 * shown BEFORE the write turns that from a discovery into a decision.
 *
 * So the whole contract here is a number a person is going to act on, which is
 * why the honesty rules below are stricter than they would be for a panel that
 * merely lists things:
 *
 *   - A count that is a floor says so. Hitting the file cap sets `truncated`,
 *     because "12" and "at least 12" lead to different decisions and a UI that
 *     cannot tell them apart will print the wrong one.
 *   - A question this module cannot answer is refused in words rather than
 *     answered with a plausible-looking zero. Asking for `button` on a React
 *     project is the case that matters: there really are forty `<button>` tags
 *     out there, they are DOM elements rather than renders of anybody's
 *     component, and both "0" and "40" would be lies of a different kind.
 *   - Counting is by NAME, and the module says what that means rather than
 *     implying more. It does not resolve imports, so two unrelated components
 *     both called `Card` are summed. What it can do cheaply — because it is
 *     already parsing every file — is report every file that DECLARES the name,
 *     and a caller that gets two back knows the number spans two components.
 *
 * Two lanes, chosen by the shape of the name rather than by the host's
 * framework, because the name is the thing the caller actually has:
 *
 *   `Button`, `Card.Header`   JSX elements in .jsx/.tsx/.js
 *   `app-button`              element selectors in Angular .html templates
 *
 * The React lane reads `.js` as well as `.jsx` and `.tsx`, because Next and CRA
 * projects put JSX in `.js` by default and a count that quietly skipped those
 * files would be wrong on a whole class of project. It deliberately does NOT
 * read `.ts`: TypeScript forbids JSX there, `<T>(value)` in a `.ts` file is a
 * type assertion, and a parser running with the JSX plugin reads that as an
 * element — so scanning `.ts` would not find more usages, it would manufacture
 * ones that do not exist.
 *
 * The Angular lane reads `.html` only, and gets its containment for free: this
 * module gates every file on `isEditableSourcePath`, whose extension allowlist
 * includes `.html` only on an Angular host. A component's INLINE template —
 * `template:` inside the `.ts` decorator — is therefore not counted, and that
 * is a known floor rather than a claim of completeness.
 *
 * The ANSWER is never cached: there is no single file whose mtime invalidates
 * it, and a stale "40 places" is worse than a slow one, because the designer
 * acts on it. What is cached is each FILE's contribution — the tags it renders
 * on which lines, and the names it declares — keyed to that file's own mtime
 * and size, which is the same rule every sibling that reads one file keeps.
 * Every request still walks the tree and stats every file, so a new, edited or
 * deleted file is seen on the very next lookup; what a repeat stops paying for
 * is reading and parsing files that have not changed.
 */

import { realpathSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"

import { isEditableSourcePath, resolveEditableSource } from "../config.mjs"
import { scanTemplate } from "./angular-source.mjs"
import { createLimiter } from "./file-io.mjs"
import { scanJsx } from "./react-source.mjs"

/**
 * Guards on a directory nobody vetted, not product limits.
 *
 * `MAX_FILES` and `MAX_DEPTH` match `server/library-components.mjs`, which
 * walks the same tree for a different reason; two whole-project walks that stop
 * in different places would report different projects to the same user. Three
 * thousand files is comfortably more than any hand-written app and far short of
 * a home directory, which is the accident these numbers exist for — a project
 * root resolved one level too high.
 *
 * `MAX_USAGES` bounds the LIST, never the count. Five hundred is already past
 * the point where anyone reads the rows; what the designer acts on is the
 * number, so the number keeps climbing after the list stops growing, and a
 * caller that wants to know whether it is looking at all of them compares
 * `count` with `usages.length`.
 *
 * `MAX_FILE_BYTES` skips a generated or vendored monster before it is read
 * rather than after. A two-megabyte "source" file is a bundle somebody checked
 * in, and parsing it costs more than every hand-written file in the project put
 * together.
 */
const MAX_FILES = 3000
const MAX_DEPTH = 12
const MAX_USAGES = 500
const MAX_FILE_BYTES = 2_000_000
const MAX_DEFINITIONS = 20
/** A component name is an identifier, and nothing legitimate is this long. */
const MAX_NAME = 120

/**
 * Directories that are never a call site.
 *
 * Build output is the important half of this list and the reason it is a list
 * rather than just `node_modules`. `dist`, `build`, `.next` and `coverage` hold
 * COPIES of the source that was compiled into them, so walking them does not
 * find new places the component is rendered — it finds the same places twice,
 * and doubles a number the designer is about to make a decision on.
 */
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "out",
  ".angular",
  ".cache",
  ".git",
  ".turbo",
])

/** Where JSX can legitimately live — see the header for why `.ts` is absent. */
const JSX_EXTENSIONS = new Set([".jsx", ".tsx", ".js"])
const TEMPLATE_EXTENSIONS = new Set([".html"])

/**
 * A React component tag: a capitalised identifier, optionally a member path.
 *
 * The member path is accepted so `Card.Header` can be asked about in its own
 * right, and matching stays exact: `Card` does not count `<Card.Header>`.
 * They are two components that happen to be reachable through one object, they
 * are very often styled apart, and rolling the child into the parent's number
 * would overstate the blast radius of the edit the designer is contemplating.
 */
const REACT_TAG = /^[A-Z][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)*$/

/** An Angular element selector: lowercase words joined by dashes, as HTML requires. */
const ELEMENT_SELECTOR = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/

/** A name that is a legal identifier but starts lowercase, which JSX reads as a DOM tag. */
const LOWERCASE_IDENTIFIER = /^[a-z][A-Za-z0-9_$]*$/

function refusal(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

/**
 * Which lane a name names, or a sentence explaining that it names neither.
 *
 * The refusal is a sentence rather than a code because it is shown to a person
 * who asked a reasonable question and got no number. "button is not a
 * component" reads as a bug in the editor; naming what JSX does with a
 * lowercase tag, and what to ask for instead, reads as an answer.
 */
function laneFor(name) {
  if (REACT_TAG.test(name)) return { lane: "jsx", refused: "" }
  if (ELEMENT_SELECTOR.test(name)) return { lane: "template", refused: "" }
  if (LOWERCASE_IDENTIFIER.test(name)) {
    return {
      lane: "",
      refused:
        `<${name}> is lowercase, which JSX renders as the built-in DOM element of that name ` +
        `rather than as a component — ask for the capitalised name the component is declared ` +
        `under, or for an Angular element selector such as "app-${name}".`,
    }
  }
  return {
    lane: "",
    refused:
      `"${name}" is not a name this can count: a React component is a capitalised identifier ` +
      `such as "Button", and an Angular element selector is lowercase words joined by dashes ` +
      `such as "app-button".`,
  }
}

/** Project-relative and POSIX, the spelling every path this server hands out uses. */
function projectRelative(root, file) {
  const relative = path.relative(root, file)
  if (!relative) return path.basename(file)
  return relative.split(path.sep).join("/")
}

/**
 * The 1-based line each offset falls on, as one pass over the source.
 *
 * The template scanner reports byte offsets and the JSX scanner reports lines,
 * so only the Angular lane needs this — but it needs it once per match, and
 * counting newlines from the start of the file for every match turns a template
 * with fifty usages into fifty scans of the same bytes. Sorting the offsets
 * first means the cursor only ever moves forward.
 */
function linesAt(source, offsets) {
  const lines = new Map()
  let line = 1
  let at = 0
  for (const offset of [...offsets].sort((a, b) => a - b)) {
    while (at < offset && at < source.length) {
      if (source[at] === "\n") line += 1
      at += 1
    }
    lines.set(offset, line)
  }
  return lines
}

/**
 * Every name the file declares itself, imports aside.
 *
 * This is what makes `definedIn` discoverable rather than something the caller
 * has to already know, and it is the same question `declaresLocally` in
 * `server/react-source.mjs` asks for a different purpose — that one is guarding
 * an import it is about to write, this one is looking for the definition the
 * usages point at. Neither can be expressed in terms of the other, so the walk
 * is written twice rather than generalised into a shape that serves neither.
 *
 * Only top-level declarations count. A component declared inside a function is
 * not the project's `Button`, and an import is not a declaration at all — a
 * file that imports the name is a CONSUMER, which is the whole point of the
 * count this module is producing.
 */
function declaredNames(ast) {
  const names = new Set()
  for (const statement of ast.program?.body ?? []) {
    const node =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement
    if (!node) continue
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      if (node.id?.name) names.add(node.id.name)
      continue
    }
    if (node.type !== "VariableDeclaration") continue
    for (const declarator of node.declarations ?? []) {
      if (declarator.id?.type === "Identifier") names.add(declarator.id.name)
    }
  }
  return names
}

/**
 * Babel from the host project when it has one, ours otherwise.
 *
 * The same two-step `server/variants.mjs` and `server/react-source.mjs` each
 * make, and it is duplicated here for the same reason they duplicate it from
 * each other: a project pinned to a newer parser can contain syntax ours cannot
 * read, and the host's own copy is by definition able to parse the host's own
 * files. Neither sibling exports its resolution, and reaching into one of them
 * for it would couple this module to a file it otherwise only borrows a scanner
 * from.
 */
let ourParse = null
function hostParser(projectRoot) {
  try {
    return createRequire(path.join(projectRoot, "package.json"))("@babel/parser").parse
  } catch {
    if (!ourParse) ourParse = createRequire(import.meta.url)("@babel/parser").parse
    return ourParse
  }
}

/** Every plugin a modern React file might need, since we never run the output. */
const PLUGINS = ["jsx", "typescript", "decorators-legacy", "classProperties", "explicitResourceManagement"]

/**
 * Every candidate file under the project root, bounded in both directions.
 *
 * `truncated` is the honest half of this function. It is set when the walk
 * stopped early — the file cap reached, or a directory left unopened because it
 * sat past the depth cap — and it travels all the way out to the caller,
 * because a count taken from a partial walk is a floor and a UI that prints it
 * as a total is lying on this module's behalf.
 *
 * Symlinks are skipped rather than followed: a link is the one entry that can
 * point back up the tree and turn a bounded walk into a loop, and a link
 * pointing OUT of the project is a way to read files the containment check was
 * written to keep out.
 *
 * `onFile` hears about each kept file as it is kept, so its loading can start
 * while the walk is still listing directories.
 */
async function collectFiles(root, accepts, { maxFiles, maxDepth }, onFile) {
  const files = []
  // Project-relative beside each absolute path, built up a name at a time: the
  // counting loop and the editable gate both want it for every file, and
  // `path.relative` on each of thousands was a real share of a first lookup.
  const relatives = []
  // Each directory's listing is asked for the moment the directory is queued,
  // so the walk awaits listings that are already on their way rather than one
  // round trip per directory in series. The order the entries are taken in is
  // unchanged, which is what keeps a capped walk the same walk.
  const list = (dir) => fs.readdir(dir, { withFileTypes: true }).catch(() => null)
  const queue = [{ dir: root, relative: "", depth: 0, listing: list(root) }]
  let truncated = false

  while (queue.length) {
    if (files.length >= maxFiles) {
      truncated = true
      break
    }
    const { dir, relative, depth, listing } = queue.shift()
    const entries = await listing
    if (!entries) continue
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      const fullRelative = relative ? `${relative}${path.sep}${entry.name}` : entry.name
      if (entry.isDirectory()) {
        // A dot-directory is tooling rather than product source, and the two
        // that matter most — `.next` and `.git` — are named in the skip list
        // anyway. Skipping the whole class keeps a `.venv` or a `.yarn` out of
        // the budget the real source files need.
        if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) continue
        if (depth >= maxDepth) {
          truncated = true
          continue
        }
        queue.push({ dir: full, relative: fullRelative, depth: depth + 1, listing: list(full) })
        continue
      }
      if (!entry.isFile() || !accepts(full, fullRelative)) continue
      if (files.length >= maxFiles) {
        truncated = true
        break
      }
      files.push(full)
      relatives.push(fullRelative)
      onFile(full)
    }
  }

  return { files, relatives, truncated }
}

/**
 * The usage counter behind the route.
 *
 * `options` exists so the caps can be lowered, which is how the cases prove
 * what happens AT a cap without writing three thousand fixture files. A host
 * may raise them too; they are guards on an unvetted directory rather than a
 * statement about how big a project is allowed to be.
 */
export function createComponentUsage(config, options = {}) {
  const root = config.projectRoot
  const maxFiles = options.maxFiles ?? MAX_FILES
  const maxDepth = options.maxDepth ?? MAX_DEPTH
  const maxUsages = options.maxUsages ?? MAX_USAGES
  const parse = options.parse ?? hostParser(root)

  /**
   * A client-supplied defining file, made absolute and proven to be inside the
   * project — by `resolveEditableSource`, which owns the Vite leading-slash rule.
   *
   * A hint that fails the check is a refusal rather than something to ignore.
   * Dropping it silently would answer a question nobody asked — the count would
   * come back for a `Button` the caller did not mean — and would hide the bug
   * or the probe that produced the path.
   */
  const resolveDefinedIn = (requested) => {
    const trimmed = typeof requested === "string" ? requested.trim() : ""
    if (!trimmed) return ""
    const resolved = resolveEditableSource(config, trimmed)
    if (!resolved) throw refusal("That defining file is outside the editable source roots", 403)
    return projectRelative(root, resolved)
  }

  /**
   * Whether a walked file may be read, remembered per path.
   *
   * The walk never follows a symlink and the config's roots and extensions are
   * fixed for this instance's life, so a path's answer cannot change between
   * lookups — and asking again cost a `realpath` per file per lookup.
   *
   * The same fact makes the first answer cheap. Every directory the walk
   * enters was reached through real directories and every file it keeps is a
   * regular file, so a walked file's resolved path is the resolved root plus
   * its relative path. Handing that over spares the gate a `realpath` — an
   * lstat per path component — for each of thousands of files.
   */
  const editable = new Map()
  const isEditable = (file, relative, canonicalRoot) => {
    let answer = editable.get(file)
    if (answer === undefined) {
      answer = isEditableSourcePath(
        config,
        file,
        relative,
        canonicalRoot ? path.join(canonicalRoot, relative) : undefined
      )
      editable.set(file, answer)
    }
    return answer
  }

  /**
   * Each file's contribution, keyed by absolute path and valid for one
   * `mtimeMs:size`. `source` is held only until the file is first parsed — a
   * file whose text never contained an asked-for name is never parsed — and is
   * dropped once `tags` (tag name → lines) and `declares` exist. `tags: null`
   * marks a file that did not parse, which contributes nothing until it changes.
   */
  const files = new Map()

  const analyze = (entry, lane) => {
    const tags = new Map()
    const push = (tag, line) => {
      const lines = tags.get(tag)
      if (lines) lines.push(line)
      else tags.set(tag, [line])
    }
    try {
      if (lane === "template") {
        const nodes = scanTemplate(entry.source)
        const lines = linesAt(entry.source, nodes.map((node) => node.start))
        for (const node of nodes) push(node.tagName, lines.get(node.start) ?? 0)
        entry.declares = new Set()
      } else {
        const ast = parse(entry.source, {
          sourceType: "module",
          allowReturnOutsideFunction: true,
          errorRecovery: true,
          plugins: PLUGINS,
        })
        for (const node of scanJsx(ast)) push(node.tagName, node.line)
        entry.declares = declaredNames(ast)
      }
      entry.tags = tags
    } catch {
      // One file mid-edit must not cost the whole answer — and the file being
      // edited is the likeliest one to be half-written, because it is the one
      // the designer is working in.
      entry.tags = null
    }
    entry.source = null
  }

  /**
   * The cache entry for one walked file, or null for a skip, analyzed for
   * `name` when its text mentions it.
   *
   * Parsing here rather than in the counting loop is what lets the parser run
   * while the next files are still being read: the files are loaded a few
   * dozen at a time as the walk finds them, and each is parsed the moment its
   * text arrives.
   */
  const load = async (file, name, lane) => {
    const stat = await fs.stat(file).catch(() => null)
    if (!stat || stat.size > MAX_FILE_BYTES) return null
    let entry = files.get(file)
    if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      let source
      try {
        source = await fs.readFile(file, "utf8")
      } catch {
        return null
      }
      entry = { mtimeMs: stat.mtimeMs, size: stat.size, source, tags: undefined, declares: null }
      files.set(file, entry)
    }
    // The cheapest possible gate, and it decides how expensive the first lookup
    // is: a file whose text does not contain the name anywhere cannot contain a
    // tag for it, and is never handed to a parser until some other name is
    // asked about.
    if (entry.tags === undefined && entry.source.includes(name)) analyze(entry, lane)
    return entry
  }

  return {
    /**
     * Every place `name` is rendered, and how many of them there are.
     *
     * `definedIn` is optional in both directions: the caller may name the file
     * the component is declared in, and when it does not, a lane that found
     * exactly one declaring file fills it in. It is reported rather than used
     * to filter, because a declaration is not a call site and is therefore
     * excluded by construction — while a `<Button>` written INSIDE `button.tsx`
     * is a real render of the component and is counted like any other. A file
     * is not disqualified from using what it declares.
     */
    async read(requestedName, requestedDefinedIn = "") {
      const name = typeof requestedName === "string" ? requestedName.trim() : ""
      if (!name) throw refusal("A usage lookup needs a component name")
      if (name.length > MAX_NAME) throw refusal("That component name is too long to be one")

      const definedIn = resolveDefinedIn(requestedDefinedIn)
      const { lane, refused } = laneFor(name)
      if (refused) {
        // Not an error: the caller asked a well-formed question about something
        // that cannot be a component, and the answer to that is a sentence, not
        // a 400 the panel has to render as a failure.
        return {
          name,
          definedIn,
          usages: [],
          count: 0,
          truncated: false,
          scanned: 0,
          definitions: [],
          refused,
        }
      }

      const extensions = lane === "template" ? TEMPLATE_EXTENSIONS : JSX_EXTENSIONS
      let canonicalRoot
      try {
        canonicalRoot = realpathSync(root)
      } catch {
        // The gate resolves each file itself, and answers for an unreachable root.
      }
      const accepts = (file, relative) =>
        extensions.has(path.extname(file).toLowerCase()) && isEditable(file, relative, canonicalRoot)

      // Each file is loaded the moment the walk keeps it, so reading and parsing
      // run alongside the rest of the walk rather than after it.
      const gate = createLimiter()
      const loading = []
      const walked = await collectFiles(root, accepts, { maxFiles, maxDepth }, (file) =>
        loading.push(gate(() => load(file, name, lane)))
      )
      // A member path is not a declarable name — nothing declares `Card.Header`
      // at the top level of a file — so the definition search is skipped rather
      // than run and always answered no.
      const searchable = lane === "jsx" && !name.includes(".")

      const usages = []
      const definitions = []
      let count = 0
      let scanned = 0

      const entries = await Promise.all(loading)
      for (let index = 0; index < walked.files.length; index += 1) {
        const entry = entries[index]
        if (!entry) continue
        scanned += 1
        if (entry.tags === undefined || entry.tags === null) continue

        const relative = walked.relatives[index].split(path.sep).join("/")
        for (const line of entry.tags.get(name) ?? []) {
          count += 1
          if (usages.length < maxUsages) usages.push({ file: relative, line })
        }
        if (searchable && definitions.length < MAX_DEFINITIONS && entry.declares.has(name)) {
          definitions.push(relative)
        }
      }

      // A file the walk no longer reaches has been deleted or moved; forget it
      // so the cache stays the size of the project. Only after a complete walk,
      // and only this lane's files, since nothing else was looked for.
      if (!walked.truncated) {
        const seen = new Set(walked.files)
        for (const file of files.keys()) {
          if (!seen.has(file) && extensions.has(path.extname(file).toLowerCase())) files.delete(file)
        }
      }

      usages.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

      return {
        name,
        // One declaring file is an answer; several mean the name spans more
        // than one component and no single file is "the" definition, so the
        // list is what the caller has to read instead.
        definedIn: definedIn || (definitions.length === 1 ? definitions[0] : ""),
        usages,
        count,
        // The count is a floor, not a total: the walk stopped before the
        // project did. Never set by the usage list being clipped — that bounds
        // what is listed and leaves the number exact.
        truncated: walked.truncated,
        scanned,
        definitions,
        refused: "",
      }
    },
  }
}
