/**
 * Putting an element INTO source: the validation both hosts share, the
 * indentation rules, and the import bookkeeping that makes the result compile.
 *
 * This is the other half of the delete path. `src/core/removal.ts` explains why
 * a structural edit is routed through this server at all — neither host's own
 * write lane can express one, so the browser sends one shape and the framework
 * decides what it means. An insertion is the same kind of edit in the other
 * direction, and it inherits the same three problems plus one of its own.
 *
 * The inherited ones: the splice has to be a byte range (a codemod reprints the
 * file and turns a one-line addition into a two-hundred-line diff), the element
 * has to be FOUND before anything is written, and a batch has to be able to
 * half-succeed.
 *
 * The new one is that a deletion takes bytes away, while an insertion adds
 * bytes the author never wrote, and those bytes have to look like they were
 * always there. `elementRange` in `angular-source.mjs` takes a deleted
 * element's whole line with it so the file is not left holding a ragged blank
 * line; this module is that comment's mirror image. An element spliced in at
 * column zero, under siblings sitting at four spaces, is just as obviously
 * machine output — so every insertion is indented from what is already around
 * it: the reference element's own line for `before`/`after`, an existing child's
 * line for `prepend`/`append`, and the house two-space step only when the
 * container has no child to copy.
 *
 * And it adds an import, which is the part that decides whether the feature
 * works at all. `<Button/>` spliced into a file that does not import `Button`
 * renders nothing on React and nothing on Angular, and the user sees a library
 * panel that "does not work" for a reason nowhere on their screen. So the
 * markup splice and the import edit are one operation, and an operation that
 * cannot write the import does not write the markup either.
 */

import path from "node:path"

/**
 * One request is one gesture — a click on "Insert instance", or a drag. Fifty
 * is far past anything a person can mean by that and still small enough that a
 * batch cannot be used to keep this process reading and rewriting files.
 */
export const MAX_INSERT_OPERATIONS = 50

/** A component instance, even a verbose one, is a line or two of markup. */
export const MAX_MARKUP_LENGTH = 2000

const POSITIONS = new Set(["before", "after", "prepend", "append"])

/** A JavaScript identifier, which is all an imported symbol may ever be. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * What may appear in an import's `from`: a project-relative source path or a
 * bare package name. No quote, no backtick, no backslash and no whitespace,
 * because this value is written verbatim INTO a string literal in the user's
 * file and those are exactly the characters that would end the literal early.
 */
const IMPORT_FROM = /^[A-Za-z0-9._@/-]{1,300}$/

/** Extensions a module specifier drops, and only these. */
const MODULE_EXTENSIONS = new Set([".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs", ".cts", ".cjs"])

/**
 * A second copy of `routes.mjs`'s helper rather than an import of it, because
 * `routes.mjs` imports THIS module and a cycle between the two is worth more
 * than the five lines it would save.
 */
export function badRequest(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

/* -------------------------------------------------------------------------
 * The markup allowlist
 * ---------------------------------------------------------------------- */

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * One attribute: a plain name, and if it carries a value at all, a quoted one.
 *
 * The leading whitespace is required, so `<a"evil"` cannot be read as a tag
 * with an attribute. An unquoted value matches neither alternative, the name
 * alone is consumed, and the `=` left behind matches nothing — which is how
 * `variant=filled` is refused rather than silently accepted.
 */
const MARKUP_ATTRIBUTE = /^\s+[A-Za-z_][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))?/

/**
 * `markup` is the most dangerous input this server accepts, because it does not
 * become data inside a file — it becomes SOURCE CODE in the user's project, on
 * disk, which their dev server then compiles and runs.
 *
 * So this is an allowlist, and deliberately not an escape. Escaping is the
 * right tool when untrusted DATA has to sit inside a known grammar: you know
 * which characters would break out of the string, the attribute or the text
 * node, and you neutralize those. None of that applies here. This input's whole
 * purpose is to be parsed as markup — escaping `<` would turn the one thing the
 * caller asked for into visible text and break the feature, so there is nothing
 * to neutralize without destroying it. The only question that can be answered
 * safely is the other one: is this one of the small set of shapes we intended
 * to write? A single element, a restricted tag charset, quoted attribute
 * values, at most some plain text inside. Everything else — a second element, a
 * `{` that would open a JSX expression or an Angular interpolation, a `<script`,
 * an unclosed tag — is refused, INCLUDING things that would have been harmless.
 * A conservative allowlist rejecting a legitimate shape is a bug report; an
 * escape missing a case writes executable code into a stranger's repository.
 *
 * Returns the trimmed markup with the facts the callers need for their error
 * messages. Throws `badRequest` on anything it does not recognize.
 */
export function checkMarkup(value) {
  if (typeof value !== "string" || !value.trim()) throw badRequest("Insert needs markup to write")
  const markup = value.trim()

  if (markup.length > MAX_MARKUP_LENGTH) {
    throw badRequest(`Markup is longer than ${MAX_MARKUP_LENGTH} characters`)
  }
  if (/<script/i.test(markup)) throw badRequest("Markup may not contain a script tag")
  // `{` opens a JSX expression and `{{` an Angular interpolation; either one is
  // a way to get an arbitrary expression evaluated in the user's app.
  if (/[{}]/.test(markup)) throw badRequest("Markup may not contain an expression")
  if (markup.includes("`")) throw badRequest("Markup may not contain a backtick")

  const opening = /^<([A-Za-z][A-Za-z0-9._-]*)/.exec(markup)
  if (!opening) throw badRequest("Markup must be a single element")
  const tagName = opening[1]

  let index = opening[0].length
  let selfClosing = false
  for (;;) {
    const rest = markup.slice(index)
    const end = /^\s*(\/?)>/.exec(rest)
    if (end) {
      selfClosing = end[1] === "/"
      index += end[0].length
      break
    }
    const attribute = MARKUP_ATTRIBUTE.exec(rest)
    if (!attribute) {
      throw badRequest(`Markup has an attribute <${tagName}> cannot be given safely`)
    }
    index += attribute[0].length
  }

  const body = markup.slice(index)
  if (selfClosing) {
    if (body.length) throw badRequest("Markup must be a single element")
    return { markup, tagName, selfClosing: true }
  }

  // One regex for both remaining rules, so the message can say what the shape
  // is instead of naming whichever half failed: no nested element (the text may
  // not hold `<` or `>`), and the close tag is the last thing in the string (a
  // second top-level element leaves it in the middle).
  const closing = new RegExp(`^([^<>]*)</${escapeRegExp(tagName)}\\s*>$`).exec(body)
  if (!closing) {
    throw badRequest(`Markup must be one <${tagName}> element holding only simple text`)
  }
  return { markup, tagName, selfClosing: false }
}

/* -------------------------------------------------------------------------
 * The request
 * ---------------------------------------------------------------------- */

function readImport(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("An insert's import must be an object")
  }
  const name = typeof value.name === "string" ? value.name.trim() : ""
  const from = typeof value.from === "string" ? value.from.trim() : ""
  if (!IDENTIFIER.test(name)) throw badRequest("An insert's import needs a symbol name")
  if (!IMPORT_FROM.test(from)) throw badRequest("An insert's import needs a module path")
  return { name, from, defaultImport: Boolean(value.defaultImport) }
}

/**
 * One operation, validated into the shape the framework lanes may trust.
 *
 * Everything a lane would otherwise have to re-check is checked once, here, and
 * a violation is a 400 rather than a per-operation failure — a malformed
 * request is a bug in the caller, while a failure is a fact about the user's
 * source, and reporting the first as the second hides it in a list the panel
 * shows as "3 of 4 placed".
 */
function readInsertOperation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("Each insert needs an operation object")
  }
  if (value.op !== undefined && value.op !== "insertElement") {
    throw badRequest(`Unsupported insert operation ${value.op}`)
  }
  const componentName = typeof value.componentName === "string" ? value.componentName.trim() : ""
  if (!componentName || componentName.length > 200) {
    throw badRequest("Each insert needs the component whose file receives it")
  }
  const position = typeof value.position === "string" ? value.position : ""
  if (!POSITIONS.has(position)) {
    throw badRequest("Each insert needs a position of before, after, prepend or append")
  }
  const target = value.target ?? null
  if (target !== null && (typeof target !== "object" || Array.isArray(target))) {
    throw badRequest("An insert's target must be an element descriptor or null")
  }
  // A null target means "the root", which is a container — it can be opened up
  // and written into, but there is no element for something to sit beside. The
  // caller asking for one is incoherent rather than unlucky, so it is refused
  // here instead of failing four operations deep inside a framework lane.
  if (target === null && (position === "before" || position === "after")) {
    throw badRequest(`An insert with no target element cannot be placed ${position} one`)
  }
  const filePath = typeof value.filePath === "string" ? value.filePath : null

  return {
    op: "insertElement",
    componentName,
    filePath,
    target,
    position,
    markup: checkMarkup(value.markup).markup,
    import: readImport(value.import),
  }
}

/** The body of `POST {prefix}/source/insert`, or the reason it is not one. */
export function readInsertOperations(body) {
  const operations = Array.isArray(body?.operations) ? body.operations : null
  if (!operations) throw badRequest("Insert needs an operations array")
  if (operations.length === 0) throw badRequest("Insert needs at least one operation")
  if (operations.length > MAX_INSERT_OPERATIONS) {
    throw badRequest(`Too many elements in one insert (max ${MAX_INSERT_OPERATIONS})`)
  }
  return operations.map(readInsertOperation)
}

/* -------------------------------------------------------------------------
 * Indentation and the splice
 * ---------------------------------------------------------------------- */

/** The whitespace between the start of `offset`'s line and `offset` itself. */
export function lineIndentAt(text, offset) {
  let start = offset
  while (start > 0 && text[start - 1] !== "\n") start -= 1
  return /^[ \t]*/.exec(text.slice(start, offset))[0]
}

/**
 * Whether a range has its line to itself.
 *
 * The same question `lineExtendedRange` asks before it grows a deletion out to
 * the whole line, asked for the opposite reason: an element on its own line
 * gets a new line of its own beside it, while one sharing a line with a sibling
 * or with text is spliced in right where it sits. Adding line breaks around
 * `<b>bold</b>` inside a sentence would change what the sentence renders as.
 */
export function ownsLine(text, start, end) {
  let before = start
  while (before > 0 && (text[before - 1] === " " || text[before - 1] === "\t")) before -= 1
  if (before !== 0 && text[before - 1] !== "\n") return false

  let after = end
  while (after < text.length && (text[after] === " " || text[after] === "\t")) after += 1
  return after >= text.length || text[after] === "\n"
}

/** Markup re-indented to sit at `indent`; its first line is placed by the caller. */
function indentBlock(markup, indent) {
  if (!markup.includes("\n")) return markup
  return markup
    .split("\n")
    .map((line, position) => (position === 0 ? line : `${indent}${line}`))
    .join("\n")
}

/**
 * The indentation a new child of this element should sit at.
 *
 * Copied from a sibling wherever there is one, because the file's real indent
 * step is whatever its author used — two spaces, four, or a tab — and this
 * module has no business teaching them otherwise. The two-space fallback is
 * only reached for a container that is currently empty, where there is nothing
 * to copy and something has to be chosen.
 */
function childIndent(text, contentStart, contentEnd, outerIndent, fromEnd) {
  const lines = text.slice(contentStart, contentEnd).split("\n").slice(1)
  const ordered = fromEnd ? [...lines].reverse() : lines
  for (const line of ordered) {
    if (!line.trim()) continue
    return /^[ \t]*/.exec(line)[0]
  }
  return `${outerIndent}  `
}

/**
 * Where a reference element sits, in the one shape the splice understands.
 *
 * Each lane builds this itself rather than handing over its own node, because
 * the two scanners disagree about what `end` means: a template node's `end` is
 * the end of its START tag, while a JSX node's is the end of the whole element.
 * A shared helper guessing which convention it was handed is a splice landing
 * in the middle of a tag.
 *
 * @typedef {object} InsertAnchor
 * @property {string} tagName
 * @property {number} elementStart first byte of the reference element
 * @property {number} elementEnd one past its last byte
 * @property {number} contentStart first byte inside it, -1 when it holds none
 * @property {number} contentEnd one past its last content byte, -1 when unknown
 * @property {boolean} selfClosing
 */

/**
 * The one splice an insertion makes to the markup.
 *
 * Throws with a reason rather than returning null: every caller reports the
 * reason to the user, and a boolean would make each of them invent the words.
 */
export function insertionEdit(anchor, position, markup, text) {
  if (position === "before" || position === "after") {
    if (anchor.elementEnd < 0) {
      throw new Error(`<${anchor.tagName}> has no closing tag, so its end cannot be found`)
    }
    const indent = lineIndentAt(text, anchor.elementStart)
    const body = indentBlock(markup, indent)
    if (!ownsLine(text, anchor.elementStart, anchor.elementEnd)) {
      const at = position === "before" ? anchor.elementStart : anchor.elementEnd
      return { start: at, end: at, text: body }
    }
    if (position === "before") {
      return { start: anchor.elementStart, end: anchor.elementStart, text: `${body}\n${indent}` }
    }
    return { start: anchor.elementEnd, end: anchor.elementEnd, text: `\n${indent}${body}` }
  }

  if (anchor.selfClosing) {
    throw new Error(`<${anchor.tagName}> is self-closing, so there is nothing inside it to ${position}`)
  }
  if (anchor.contentStart < 0 || anchor.contentEnd < 0) {
    throw new Error(`<${anchor.tagName}> has no closing tag, so its content range cannot be found`)
  }

  const outerIndent = lineIndentAt(text, anchor.elementStart)
  const content = text.slice(anchor.contentStart, anchor.contentEnd)

  if (position === "prepend") {
    const indent = childIndent(text, anchor.contentStart, anchor.contentEnd, outerIndent, false)
    const body = indentBlock(markup, indent)
    // Content that starts on the next line gets another such line; content
    // written inline — `<p>text</p>` — is left on its one line.
    if (!/^[ \t]*\n/.test(content)) {
      return { start: anchor.contentStart, end: anchor.contentStart, text: body }
    }
    return { start: anchor.contentStart, end: anchor.contentStart, text: `\n${indent}${body}` }
  }

  const indent = childIndent(text, anchor.contentStart, anchor.contentEnd, outerIndent, true)
  const body = indentBlock(markup, indent)
  const trailing = /\n([ \t]*)$/.exec(content)
  if (!trailing) return { start: anchor.contentEnd, end: anchor.contentEnd, text: body }
  // The close tag's own indentation is already in the file, just before
  // `contentEnd`, so the splice goes IN FRONT of it rather than after it: the
  // new line is written and the indentation that was already there carries the
  // close tag, exactly as it did before. Appending at `contentEnd` instead
  // would push the close tag out by its own indentation every time.
  //
  // Staying zero-width matters beyond tidiness — two appends into the same
  // element in one batch are then two insertions at one offset, which stack,
  // while two ranges covering the same bytes would be an overlap and fail both.
  const at = anchor.contentEnd - trailing[1].length
  return { start: at, end: at, text: `${indent}${body}\n` }
}

/* -------------------------------------------------------------------------
 * Imports
 * ---------------------------------------------------------------------- */

/**
 * The module specifier that reaches `from` from the file being written.
 *
 * Both halves of the answer come from the RECEIVING file: a component declared
 * in `src/ui/button.tsx` is `./button` to its neighbour and `../ui/button` to a
 * page one directory down, and writing the project-relative path into either of
 * them produces an import that does not resolve.
 *
 * A `from` that is not a path at all — `@scope/kit`, `react` — is a package
 * name and is used exactly as given. It is recognized by having no source
 * extension and not already being relative, which is the same test a bundler
 * applies.
 */
export function importSpecifier(from, receiving) {
  const extension = path.posix.extname(from.replace(/\\/g, "/")).toLowerCase()
  const relativeAlready = from.startsWith(".") || from.startsWith("/")
  if (!MODULE_EXTENSIONS.has(extension) && !relativeAlready) return from

  const fromPosix = from.replace(/\\/g, "/").replace(/^\/+/, "")
  const receivingPosix = receiving.replace(/\\/g, "/").replace(/^\/+/, "")
  const relative = path.posix.relative(path.posix.dirname(receivingPosix), fromPosix)
  const withoutExtension = MODULE_EXTENSIONS.has(path.posix.extname(relative).toLowerCase())
    ? relative.slice(0, -path.posix.extname(relative).length)
    : relative
  if (!withoutExtension) return "."
  return withoutExtension.startsWith(".") ? withoutExtension : `./${withoutExtension}`
}

/**
 * Whether `from` names the very file the markup is being written into.
 *
 * The one case where the correct import statement is no import statement at
 * all. A component's own file already has the declaration in scope, so an
 * import of it from itself is not a redundant line — it is a second binding of
 * a name the file already binds, which is a hard error in every toolchain, and
 * the file stops compiling the moment it is written. Seen in the wild:
 * `<Card>` dropped into the file that declares `Card` wrote
 * `import { Card } from "./card"` directly above `export const Card`, and the
 * dev server answered 500 for every page that imported it.
 *
 * Both sides are normalized the way `importSpecifier` normalizes them — POSIX
 * separators, no leading slash, no source extension — because `src/ui/card.tsx`
 * and `/src/ui/card` are the same module and arrive in both spellings
 * depending on which host resolved the path. A bare package name normalizes to
 * itself and matches no project file, which is the right answer for it.
 */
export function isSameModule(from, receiving) {
  if (!from || !receiving) return false
  const normalize = (value) => {
    const posix = value.replace(/\\/g, "/").replace(/^\/+/, "")
    const extension = path.posix.extname(posix).toLowerCase()
    return MODULE_EXTENSIONS.has(extension) ? posix.slice(0, -extension.length) : posix
  }
  return normalize(from) === normalize(receiving)
}

/** The ES import statement itself, in this repo's quote style. */
export function formatImport(name, defaultImport, specifier) {
  const clause = defaultImport ? name : `{ ${name} }`
  return `import ${clause} from "${specifier}"`
}

/**
 * Whether the import still has to be written, given what the file already
 * binds that name to.
 *
 * The third case is the one worth naming. A file that already has a `Button`
 * from somewhere else cannot be given a second one: two imports binding the
 * same local name is a hard error in every toolchain, so writing it would break
 * a build that was working. Neither can the markup be spliced in and the import
 * quietly skipped — `<Button/>` would then render whatever the OTHER Button is,
 * which is worse than not inserting at all because it looks like it worked. So
 * the operation fails and says which import is in the way.
 */
export function importDecision(name, specifier, boundFrom) {
  if (!boundFrom) return { add: true, reason: null }
  if (boundFrom === specifier) return { add: false, reason: null }
  return {
    add: false,
    reason: `${name} is already imported from "${boundFrom}", so a second import of it would not compile`,
  }
}

/**
 * Every local name a file's import statements bind, to the module it came from.
 *
 * A regex scan rather than a parse, for the Angular lane: that module reads
 * `.ts` files with hand-rolled scanners on purpose — see the header of
 * `angular-source.mjs` — and pulling a JavaScript parser into it to answer one
 * question would be the first place its cost shows up. The React lane has a
 * real AST in hand already and asks it instead.
 *
 * Side-effect imports (`import "./styles.css"`) bind nothing and are skipped by
 * construction: with no `from` clause they do not match at all.
 */
export function scanImportBindings(source) {
  const bindings = new Map()
  const statement = /\bimport\s+([\s\S]*?)\s+from\s*(['"])([^'"\n]+)\2/g
  let match
  while ((match = statement.exec(source))) {
    const [, clause, , specifier] = match
    const braces = /\{([\s\S]*?)\}/.exec(clause)
    const outside = clause.replace(/\{[\s\S]*?\}/, "").replace(/,/g, " ")
    for (const part of outside.split(/\s+/)) {
      const name = part.trim()
      // `*`, `as` and `type` are syntax rather than bindings; what a namespace
      // or type-only import actually binds is the identifier beside them.
      if (!name || name === "*" || name === "as" || name === "type") continue
      bindings.set(name, specifier)
    }
    // `* as ns` leaves `ns` behind above, which is the local name; `X as Y`
    // inside the braces binds `Y`, so the tail of each entry is what counts.
    for (const entry of braces ? braces[1].split(",") : []) {
      const parts = entry.trim().split(/\s+as\s+/)
      const name = parts[parts.length - 1]?.trim()
      if (name && IDENTIFIER.test(name)) bindings.set(name, specifier)
    }
  }
  return bindings
}
