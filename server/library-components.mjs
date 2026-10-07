/**
 * The components a React or Angular library declares, read out of its source.
 *
 * This is the source kind behind "point the editor at your design system's
 * component directory". Everything else a library can contribute is a token — a
 * value the inspector writes into a style. A component is not a value; it is a
 * name, a set of props, and for each prop the options that prop accepts. That
 * last part is the whole reason this file exists: an inspector that knows a
 * button declares `variant: 'primary' | 'ghost' | 'danger'` can OFFER those
 * three, where one that does not can only guess at them from class names.
 *
 * `server/variants.mjs` reads the same KIND of fact out of a React file and is
 * the closest sibling to this module, but it reads a different fact and the two
 * must not be confused. That one parses a call to a variant factory — `cva`,
 * `tv` — in the ONE file the client already has selected, to learn which class
 * strings an axis swaps between. This one reads a whole DIRECTORY it has never
 * seen before and learns the declared API of every component in it. They are
 * complementary: the factory knows what a variant paints, the declaration knows
 * which variants exist at all.
 *
 * Alongside the API, every component carries where it came from — the folder it
 * is filed under, the file that declares it, and the name that file exports it
 * as. Those are not bookkeeping. The folder is the only structure a browser can
 * offer that the user will recognize as their own, and the file and the export
 * name are what an inserted element's `import` is built from: get them wrong
 * and the editor writes markup that does not compile, which is a worse outcome
 * than refusing to write it at all.
 *
 * It is deliberately textual rather than AST-based, which is the opposite of
 * the choice `variants.mjs` made, and the reason only shows up at this scale.
 * `variants.mjs` parses one file per request and needs real expression
 * semantics — whether an option's classes are statically knowable is a question
 * only the tree can answer. Here every question is lexical (is there an `export
 * interface ButtonProps`, does this member's type read as a union of string
 * literals, which string is in `selector:`), the corpus is several hundred
 * files scanned in one request, and half of it is Angular, whose decorators
 * `@babel/parser` reads only under plugins that vary from codebase to codebase.
 * A scanner that answers a lexical question lexically cannot be defeated by a
 * syntax it has never met: the worst an unreadable file can do is contribute
 * nothing. A library of four hundred components still loading while one of its
 * files sits half-typed in an editor is worth more here than exactness on the
 * handful of files where a parser and a scanner would disagree.
 *
 * Nothing here knows any particular design system. React and Angular each
 * declare a component in a small, documented set of ways, and those ways are
 * what is recognized; a library's own naming conventions are never consulted.
 */

import fs from "node:fs/promises"
import path from "node:path"

/**
 * Guards on a directory nobody vetted, not product limits. A user can point
 * this at their whole `src/`, so every loop that could run away has a ceiling.
 */
const MAX_DEPTH = 12
const MAX_TYPES = 200
const MAX_PROPS = 40
const MAX_VALUES = 32
const MAX_TYPE_TEXT = 120
const MAX_DESCRIPTION = 280
const MAX_DEFAULT = 120
const MAX_GROUP = 60

/** Budget for the discovery probe, which runs per directory across a whole tree. */
const PROBE_BYTES = 4096
const PROBE_READS = 8
const PROBE_OWN_FILES = 8
const PROBE_SUBDIRECTORIES = 6
const PROBE_HITS = 2

const SOURCE_EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js"])

/**
 * Files that are about components without declaring any.
 *
 * A barrel re-exports names that are already being read from the file that
 * declares them, so scanning one would list every component twice. A spec, a
 * test and a story all MENTION a component in exactly the shapes this module
 * looks for — `<Button variant="primary" />` in a story is the snippet, not the
 * declaration — and a `.d.ts` is a mirror of a source file that is usually
 * sitting right next to it.
 */
function isScannableFile(name) {
  if (!SOURCE_EXTENSIONS.has(path.extname(name))) return false
  if (name.startsWith("index.")) return false
  if (name.endsWith(".d.ts")) return false
  return !/\.(spec|test|stories)\./.test(name)
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function collapse(text) {
  return String(text).replace(/\s+/g, " ").trim()
}

function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`
}

/* ------------------------------------------------------------------------ *
 * Where a component lives
 * ------------------------------------------------------------------------ */

/** A folder name as a person reads it: `action-bar` becomes `Action Bar`. */
function titleCase(segment) {
  return segment
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ")
}

/**
 * The group a component is filed under, which is the folder it was found in.
 *
 * This is derived from the directory tree and from nothing else, and the
 * alternative — reading a group out of the component's own name, so that
 * `AvatarStack` files itself under "Avatar" — is the reason the rule is written
 * down rather than left to taste. A name-derived taxonomy disagrees with the
 * folders the author actually made: it invents groups nobody has, splits a
 * folder whose components are named inconsistently, and merges two folders that
 * happen to share a prefix. The folders ARE the library's own answer to "how is
 * this organized", and a browser that shows anything else is showing the user a
 * structure they cannot find again in their editor.
 *
 * Only the folder the file sits in counts, not the whole path to it, because
 * the panel lists one flat level of groups. A file lying directly in the
 * library root has no folder and therefore no group, which the panel reads as
 * "show this library's components without a grouping level at all".
 */
function groupFor(libraryRoot, file) {
  const relative = path.relative(libraryRoot, path.dirname(file))
  if (!relative || relative === "." || relative.startsWith("..")) return ""
  const segments = relative.split(path.sep).filter((part) => part && part !== ".")
  if (!segments.length) return ""
  return truncate(titleCase(segments[segments.length - 1]), MAX_GROUP)
}

/**
 * The declaring file, spelled the way every other path this server hands out is.
 *
 * Project-relative and POSIX, because this path is not decoration: it is what
 * the insertion writer resolves to find the file an `import` has to point at,
 * and it travels to the browser and back through JSON on the way. An absolute
 * path would leak a machine's directory layout into the client and stop working
 * the moment the project moves; a path relative to the LIBRARY would be
 * meaningless to a writer that only knows where the project starts.
 *
 * A library outside the project root keeps its `..` segments rather than being
 * blanked. Joining that back onto the root still names the right file, which is
 * all the writer needs, and reporting nothing would silently cost the user the
 * import on every component in that library.
 */
function projectRelative(projectRoot, file) {
  const relative = path.relative(projectRoot, file)
  if (!relative) return path.basename(file)
  return relative.split(path.sep).join("/")
}

/* ------------------------------------------------------------------------ *
 * Masking
 * ------------------------------------------------------------------------ */

/** The index just past a closing quote, or past the line when it never closes. */
function endOfQuoted(text, start) {
  const quote = text[start]
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === "\\") {
      i += 2
      continue
    }
    if (ch === quote) return i + 1
    // An unterminated string is a typo, not a licence to swallow the rest of
    // the file — stop at the line end so the scan stays in sync.
    if (ch === "\n") return i
    i += 1
  }
  return text.length
}

function endOfInterpolation(text, start) {
  let depth = 1
  let i = start
  while (i < text.length) {
    const ch = text[i]
    if (ch === "\\") {
      i += 2
      continue
    }
    if (ch === "`") {
      i = endOfTemplate(text, i)
      continue
    }
    if (ch === "'" || ch === '"') {
      i = endOfQuoted(text, i)
      continue
    }
    if (ch === "{") depth += 1
    else if (ch === "}") {
      depth -= 1
      if (depth === 0) return i + 1
    }
    i += 1
  }
  return text.length
}

function endOfTemplate(text, start) {
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === "\\") {
      i += 2
      continue
    }
    if (ch === "`") return i + 1
    if (ch === "$" && text[i + 1] === "{") {
      i = endOfInterpolation(text, i + 2)
      continue
    }
    i += 1
  }
  return text.length
}

/**
 * The source with its comments and template-literal bodies blanked out, plus
 * the comments that were removed.
 *
 * Every structural search below runs over the blanked copy, and it has to,
 * because an Angular component carries its entire template inside the file as a
 * template literal. That template is full of the exact strings being searched
 * for — tag names, attribute quotes, braces — and searching the raw text finds
 * them and believes them. Blanking is done in place rather than by deletion so
 * that every index into the masked copy is still a valid index into the
 * original: descriptions are read back out of the comment list at the offsets
 * the masked copy reports, and a length-changing rewrite would break that.
 * Newlines survive blanking for the same reason line-anchored patterns need
 * them to.
 */
function maskSource(source) {
  const comments = []
  const blanks = []
  let i = 0

  while (i < source.length) {
    const ch = source[i]
    if (ch === "/" && source[i + 1] === "/") {
      let end = source.indexOf("\n", i)
      if (end === -1) end = source.length
      comments.push({ end, text: source.slice(i, end) })
      blanks.push([i, end])
      i = end
    } else if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2)
      // An unclosed `/*` is far likelier a slash inside a regular expression
      // than a comment running to end of file, so it is left alone.
      if (close === -1) {
        i += 2
        continue
      }
      const end = close + 2
      comments.push({ end, text: source.slice(i, end) })
      blanks.push([i, end])
      i = end
    } else if (ch === "`") {
      const end = endOfTemplate(source, i)
      blanks.push([i + 1, Math.max(i + 1, end - 1)])
      i = end
    } else if (ch === "'" || ch === '"') {
      i = endOfQuoted(source, i)
    } else {
      i += 1
    }
  }

  if (!blanks.length) return { code: source, comments }

  let code = ""
  let at = 0
  for (const [start, end] of blanks) {
    code += source.slice(at, start) + source.slice(start, end).replace(/[^\n]/g, " ")
    at = end
  }
  code += source.slice(at)
  return { code, comments }
}

/**
 * A copy in which `=>` reads as `=_`.
 *
 * Bracket depth is how this module finds the end of a type, and an arrow's `>`
 * is the one closing bracket in TypeScript that never opened. Left alone it
 * drives the depth negative and every subsequent separator is read at the wrong
 * level, so `onChange: (e: Event) => void; size: 'sm' | 'md'` collapses into one
 * member. Neutering the arrow — at the same length, so indices still line up —
 * is cheaper and far more predictable than trying to tell a generic's `>` from
 * an arrow's.
 */
function neutralized(text) {
  return text.replace(/=>/g, "=_")
}

/** The index of the bracket closing the one at `open`, or -1. */
function matchBracket(scratch, open) {
  let depth = 0
  let i = open
  while (i < scratch.length) {
    const ch = scratch[i]
    if (ch === "'" || ch === '"') {
      i = endOfQuoted(scratch, i)
      continue
    }
    if (ch === "{" || ch === "(" || ch === "[") depth += 1
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

/**
 * The `{` that opens a declaration body, skipping past whatever type syntax
 * stands between it and the name.
 *
 * `interface Props extends Omit<Attributes<HTMLDivElement>, "onChange"> {` has a
 * brace-free header, but `interface Props extends Base<{ tone: string }> {` does
 * not: the first `{` in it belongs to a type argument, and matching on it reads
 * the wrong members. Only a brace at angle and paren depth zero is the body.
 */
function findBodyBrace(scratch, from, limit = from + 600) {
  let angle = 0
  let paren = 0
  let i = from
  const stop = Math.min(scratch.length, limit)
  while (i < stop) {
    const ch = scratch[i]
    if (ch === "'" || ch === '"') {
      i = endOfQuoted(scratch, i)
      continue
    }
    if (ch === "<") angle += 1
    else if (ch === ">") angle = Math.max(0, angle - 1)
    else if (ch === "(") paren += 1
    else if (ch === ")") paren = Math.max(0, paren - 1)
    else if (ch === "{" && angle === 0 && paren === 0) return i
    else if (ch === ";" && angle === 0 && paren === 0) return -1
    i += 1
  }
  return -1
}

function splitTopLevel(text, separator) {
  const scratch = neutralized(text)
  const parts = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < scratch.length) {
    const ch = scratch[i]
    if (ch === "'" || ch === '"') {
      i = endOfQuoted(scratch, i)
      continue
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth += 1
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth = Math.max(0, depth - 1)
    else if (depth === 0 && ch === separator) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
    i += 1
  }
  parts.push(text.slice(start))
  return parts
}

/* ------------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------------ */

/**
 * The options a prop accepts, when the prop's type says so outright.
 *
 * Every member of the union has to be a string literal. `'sm' | 'md' | string`
 * is a union whose real domain is every string, and offering the two named ones
 * as though they were the options would be a picker that quietly lies — the
 * author widened the type precisely because those two are not all of them.
 */
function literalUnionValues(typeText) {
  if (!typeText.includes("'") && !typeText.includes('"')) return []
  const values = []
  for (const part of splitTopLevel(typeText, "|")) {
    const trimmed = part.trim()
    if (!trimmed || trimmed === "undefined" || trimmed === "null") continue
    const literal = /^(["'])(.*)\1$/.exec(trimmed)
    if (!literal) return []
    if (!values.includes(literal[2])) values.push(literal[2])
    if (values.length >= MAX_VALUES) break
  }
  return values
}

/**
 * The string literal a fragment of source begins with, and what follows it.
 *
 * Escapes are unwrapped so the value read here is the value the attribute will
 * be written with — a picker that offers `it\'s` and inserts `it\'s` has
 * shipped a backslash into the user's markup.
 */
function leadingLiteral(text) {
  const match = /^\s*(["'])((?:[^"'\\\n]|\\.)*)\1/.exec(text)
  if (!match) return null
  return { value: match[2].replace(/\\(.)/g, "$1"), rest: text.slice(match[0].length) }
}

/**
 * A value expression that is nothing but a string literal, unwrapped.
 *
 * `'md' as const` and `'md' satisfies Size` are the same value with a type
 * assertion stapled on, and both are common in a library that types its own
 * defaults. Anything else trailing the quote — a concatenation, a ternary, a
 * call — makes the expression something this scanner cannot evaluate, and
 * reporting its first literal as though it were the answer would preselect a
 * value the component never defaults to.
 */
function stringLiteral(text) {
  const found = leadingLiteral(String(text ?? ""))
  if (!found) return ""
  return /^\s*(?:(?:as|satisfies)\s+[^\n]*)?$/.test(found.rest) ? found.value : ""
}

/**
 * A prop's declared default, once it has been checked against the prop's own
 * options.
 *
 * The check is the point. A default the popover preselects is what makes
 * "Insert instance" produce the component's INTENDED variant rather than
 * whichever one sorts first, so it has to be a value the control can actually
 * hold: a `<select>` told to show an option it was not given shows its first
 * option instead and reports success, which is exactly the silent wrong answer
 * this field exists to prevent. A default that contradicts the declared union
 * is therefore dropped rather than passed on — the union is the better evidence
 * of the two, because it is what the compiler enforces.
 *
 * Only string defaults are recorded. A boolean's `= false` is real, but the
 * popover renders a boolean as a toggle, and a toggle fed the string "false"
 * reads it as a non-empty string and comes up ON.
 */
function literalDefault(text, values) {
  const literal = stringLiteral(text)
  if (!literal || literal.length > MAX_DEFAULT) return ""
  if (values?.length && !values.includes(literal)) return ""
  return literal
}

/**
 * Attaches defaults read from an implementation to props read from a type.
 *
 * The two halves of a React component are declared apart — the props interface
 * says which values are legal, the function signature says which one you get
 * when you pass nothing — so the defaults arrive as a separate map and are
 * married to the props by name here. A name in the map that is not a declared
 * prop is ignored: a destructuring pattern also picks up `className` and
 * `children` from an extended DOM type, and those are not options a picker has
 * anything to say about.
 */
function applyDefaults(props, defaults) {
  if (!defaults?.size) return
  for (const prop of props) {
    if (prop.default) continue
    const literal = literalDefault(defaults.get(prop.name), prop.values)
    if (literal) prop.default = literal
  }
}

/** The end of the statement starting at `from`, for a type alias's right side. */
function statementEnd(scratch, from) {
  let depth = 0
  let i = from
  const limit = Math.min(scratch.length, from + 2000)
  while (i < limit) {
    const ch = scratch[i]
    if (ch === "'" || ch === '"') {
      i = endOfQuoted(scratch, i)
      continue
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth += 1
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth = Math.max(0, depth - 1)
    else if (depth === 0 && ch === ";") return i
    else if (depth === 0 && ch === "\n" && !/^\s*[|&]/.test(scratch.slice(i + 1, i + 40))) return i
    i += 1
  }
  return limit
}

/**
 * Every named type in the file, split by what it can tell us.
 *
 * `bodies` are object types, which is where a component's props live. `unions`
 * are string-literal aliases, which is where a prop's options live when the
 * author pulled them out into a name of their own — `type Size = 'sm' | 'md'`
 * followed by `size?: Size` is the same declaration as writing the union
 * inline, and a reader that only understood the inline form would report the
 * most carefully-typed libraries as having no options at all.
 */
function collectTypeDeclarations(code, scratch) {
  const bodies = new Map()
  const unions = new Map()
  const starts = new Map()

  const interfaces = /\binterface\s+([A-Za-z_$][\w$]*)/g
  let match
  while ((match = interfaces.exec(code))) {
    if (bodies.size >= MAX_TYPES) break
    const name = match[1]
    const open = findBodyBrace(scratch, match.index + match[0].length)
    if (open === -1) continue
    const close = matchBracket(scratch, open)
    if (close === -1) continue
    if (!bodies.has(name)) {
      bodies.set(name, code.slice(open + 1, close))
      starts.set(name, match.index)
    }
    interfaces.lastIndex = Math.max(interfaces.lastIndex, close)
  }

  const aliases = /\btype\s+([A-Za-z_$][\w$]*)\s*(?:<[^<>=]*>)?\s*=/g
  while ((match = aliases.exec(code))) {
    if (bodies.size + unions.size >= MAX_TYPES) break
    const name = match[1]
    const from = match.index + match[0].length
    const end = statementEnd(scratch, from)
    const open = findBodyBrace(scratch, from, end)
    if (open !== -1) {
      const close = matchBracket(scratch, open)
      if (close !== -1 && !bodies.has(name)) {
        bodies.set(name, code.slice(open + 1, close))
        starts.set(name, match.index)
      }
      aliases.lastIndex = Math.max(aliases.lastIndex, end)
      continue
    }
    const values = literalUnionValues(collapse(code.slice(from, end)))
    if (values.length && !unions.has(name)) unions.set(name, values)
    aliases.lastIndex = Math.max(aliases.lastIndex, end)
  }

  return { bodies, unions, starts }
}

/**
 * The options a prop accepts, whether written inline or behind a name.
 *
 * The named case only counts when the type IS the alias. A prop typed
 * `(kind: Tone) => void` mentions an options union without being one, and
 * reaching inside the signature to find it produces a picker offering to set a
 * callback to the string `"loud"` — a control that cannot do anything except
 * break the element it is pointed at. Optionality is stripped first, because
 * `Tone | undefined` is the same prop as `Tone`.
 */
function resolveValues(typeText, types) {
  const direct = literalUnionValues(typeText)
  if (direct.length) return direct
  const named = splitTopLevel(typeText, "|")
    .map((part) => part.trim())
    .filter((part) => part && part !== "undefined" && part !== "null")
  if (named.length !== 1 || !/^[A-Za-z_$][\w$]*$/.test(named[0])) return []
  return types.unions.get(named[0]) ?? []
}

const MEMBER_START = /^\s*(?:readonly\s+)?(?:[A-Za-z_$][\w$]*|["'][^"'\n]+["'])\s*\??\s*[:(<]/

/**
 * One object type's members.
 *
 * Splitting on `;` and `,` alone loses the members of an interface written
 * without separators, which is valid TypeScript and not rare. Splitting on
 * newlines as well loses the opposite case — a long union that a formatter has
 * broken across lines, one `| 'value'` per line — by reading each continuation
 * as a member of its own. So a newline only ends a member when the line after
 * it starts one.
 */
function splitMembers(body) {
  const scratch = neutralized(body)
  const bounds = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < scratch.length) {
    const ch = scratch[i]
    if (ch === "'" || ch === '"') {
      i = endOfQuoted(scratch, i)
      continue
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth += 1
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth = Math.max(0, depth - 1)
    else if (depth === 0 && (ch === ";" || ch === ",")) {
      bounds.push([start, i])
      start = i + 1
    } else if (depth === 0 && ch === "\n") {
      let lineEnd = scratch.indexOf("\n", i + 1)
      if (lineEnd === -1) lineEnd = scratch.length
      if (MEMBER_START.test(scratch.slice(i + 1, lineEnd))) {
        bounds.push([start, i])
        start = i + 1
      }
    }
    i += 1
  }
  bounds.push([start, scratch.length])
  return bounds.map(([from, to]) => body.slice(from, to).trim()).filter(Boolean)
}

/**
 * One member, as a prop.
 *
 * The name has to be followed by a colon, which is what leaves method
 * signatures (`onClose(): void`) and index signatures (`[key: string]: unknown`)
 * out — neither is a prop a picker can offer a value for.
 */
function parseMember(text, types) {
  const match = /^(?:readonly\s+)?(?:(["'])([^"'\n]+)\1|([A-Za-z_$][\w$]*))\s*\??\s*:\s*([\s\S]+)$/.exec(text)
  if (!match) return null
  const name = match[2] ?? match[3]
  // A formatter that breaks a long union across lines leads with a `|`, which
  // is syntax rather than part of the type a reader should be shown.
  const typeText = collapse(match[4]).replace(/^\|\s*/, "")
  if (!name || !typeText) return null
  const values = resolveValues(typeText, types)
  return {
    name,
    type: truncate(typeText, MAX_TYPE_TEXT),
    ...(values.length ? { values } : {}),
  }
}

function parseProps(body, types) {
  const props = []
  for (const member of splitMembers(body)) {
    if (props.length >= MAX_PROPS) break
    const prop = parseMember(member, types)
    if (prop && !props.some((existing) => existing.name === prop.name)) props.push(prop)
  }
  return props
}

/* ------------------------------------------------------------------------ *
 * Descriptions
 * ------------------------------------------------------------------------ */

function commentText(raw) {
  const lines = raw
    .replace(/^\/\*+/, "")
    .replace(/\*+\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*+ ?/, "").trim())
  const kept = []
  for (const line of lines) {
    if (!line) {
      if (kept.length) break
      continue
    }
    // A tag line is metadata for a tool, not a sentence for a designer.
    if (line.startsWith("@")) break
    kept.push(line)
  }
  return truncate(collapse(kept.join(" ")), MAX_DESCRIPTION)
}

/**
 * The JSDoc written directly above a declaration, if there is one.
 *
 * Only the NEAREST preceding comment counts, and only when nothing but
 * whitespace and the declaration's own modifiers sit between the two. Without
 * that the first paragraph of a file header ends up described as every
 * component in it.
 */
function jsDocAbove(comments, code, at) {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i]
    if (comment.end > at) continue
    if (!/^\s*(?:export\s+)?(?:declare\s+)?$/.test(code.slice(comment.end, at))) return ""
    return comment.text.startsWith("/**") ? commentText(comment.text) : ""
  }
  return ""
}

/* ------------------------------------------------------------------------ *
 * Exports
 * ------------------------------------------------------------------------ */

/**
 * How a component is spelled at an import, which decides whether inserted
 * markup compiles at all.
 *
 * Every component carries `exportName` and `defaultExport`, and they are a
 * pair: a named export is `("Button", false)`, a default export is `("", true)`
 * and a component that is declared but never exported is `("", false)`. That
 * third state is not a failure to detect anything — it is the honest answer for
 * a class an Angular module declares privately, and the writer has to see it,
 * because the import it would otherwise emit names a symbol the file does not
 * publish and turns a working page into a build error.
 *
 * A file that exports the same component BOTH ways reports the named export.
 * Both imports work, but only one of them keeps working: a default import binds
 * whatever the file happens to default-export today, so it survives a rename
 * silently and starts rendering the wrong component, while a named import fails
 * loudly the moment the name it asks for goes away.
 */
function isDefaultExport(declaration) {
  return /\bexport\s+default\b/.test(declaration)
}

/**
 * Names the file hands out as its default in a statement of their own.
 *
 * `export default Button` at the foot of the file is the other half of the
 * `default` keyword, and the half that is written furthest from the
 * declaration — which is why it is collected for the whole file rather than
 * looked for beside each component.
 */
function defaultExportNames(code) {
  const names = new Set()
  const statements = /(?:^|[\n;}])\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*(?:;|\n|$)/g
  let match
  while ((match = statements.exec(code))) names.add(match[1])
  const lists = /\bexport\s*\{([^}]*)\}/g
  while ((match = lists.exec(code))) {
    const alias = /\b([A-Za-z_$][\w$]*)\s+as\s+default\b/.exec(match[1])
    if (alias) names.add(alias[1])
  }
  return names
}

/* ------------------------------------------------------------------------ *
 * React
 * ------------------------------------------------------------------------ */

/**
 * Where a `const` declaration's initializer begins, past any type annotation.
 *
 * Scanning for the assignment rather than matching it is what survives
 * `const Button: FC<{ onPress: () => void }> = …`, where the annotation itself
 * contains something that looks like an assignment. Only a top-level `=`, in a
 * copy where arrows no longer read as `>`, is the real one.
 */
function initializerStart(scratch, from) {
  let depth = 0
  let i = from
  const limit = Math.min(scratch.length, from + 400)
  while (i < limit) {
    const ch = scratch[i]
    if (ch === "'" || ch === '"') {
      i = endOfQuoted(scratch, i)
      continue
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth += 1
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth = Math.max(0, depth - 1)
    else if (depth === 0 && ch === "=") return i + 1
    else if (depth === 0 && ch === ";") return -1
    i += 1
  }
  return -1
}

/**
 * Whether what is being assigned could render.
 *
 * An exported capitalized name is a weak signal on its own — a colour map, a
 * schema and a lookup table all get one. What separates a component is that its
 * value is callable: a function, an arrow, or one of the wrappers React
 * libraries put around one. Anything opening with a brace or a bracket is data,
 * and listing data in a component picker is worse than listing nothing.
 */
const COMPONENT_INITIALIZER =
  /^(?:\(|<|async\s|function\b|styled\b|(?:React\.)?(?:forwardRef|memo|lazy)\b)/

function looksLikeComponentInitializer(scratch, at) {
  return COMPONENT_INITIALIZER.test(scratch.slice(at, at + 160).trimStart())
}

/**
 * The props type a component declares.
 *
 * `NameProps` beside `Name` is the convention nearly every React library
 * follows, so it is tried first. When it is absent the declaration itself
 * usually still names one — `React.FC<ButtonProps>` and
 * `forwardRef<HTMLButtonElement, ButtonProps>` both write it down — and that is
 * read straight out of the declaration head, which covers both forms without
 * knowing either.
 */
function propsTypeFor(name, head, types) {
  if (types.bodies.has(`${name}Props`)) return `${name}Props`
  for (const candidate of head.match(/\b[A-Z][\w$]*Props\b/g) ?? []) {
    if (types.bodies.has(candidate)) return candidate
  }
  return ""
}

/**
 * The object pattern a component destructures its props into, if it takes one.
 *
 * This is where a React component states its defaults — `size = 'medium'` in
 * the parameter list, not in the props interface, which can only say that
 * `size` is optional. Finding it means finding the parameter LIST specifically
 * and not merely the next `({` in the file: a component body is full of calls
 * that open with an object, and reading `cn({ active: true })` as a parameter
 * pattern would invent defaults for props that have none.
 *
 * So the scan walks to the first parenthesis that is not inside a type argument
 * and stops dead at anything that proves there is no parameter list — a body
 * brace, a statement end. One level of unwrapping is allowed after that,
 * because the commonest declaration in a typed library is
 * `forwardRef<E, P>((props, ref) => …)`, where the parameter list belongs to
 * the arrow inside the call rather than to the call itself.
 */
function parameterPattern(code, scratch, from, budget = 2) {
  if (from < 0) return ""
  let depth = 0
  let i = from
  const stop = Math.min(scratch.length, from + 300)
  while (i < stop) {
    const ch = scratch[i]
    if (ch === "'" || ch === '"') {
      i = endOfQuoted(scratch, i)
      continue
    }
    if (ch === "(" && depth === 0) break
    if (ch === "<" || ch === "[" || ch === "{") {
      if (ch === "{" && depth === 0) return ""
      depth += 1
    } else if (ch === ">" || ch === "]" || ch === "}" || ch === ")") {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && (ch === ";" || ch === ",")) return ""
    i += 1
  }
  if (i >= stop || scratch[i] !== "(") return ""
  const close = matchBracket(scratch, i)
  if (close === -1) return ""
  const inner = code.slice(i + 1, close)
  const first = (splitTopLevel(inner, ",")[0] ?? "").trim()
  if (first.startsWith("{")) {
    const open = i + 1 + inner.indexOf("{")
    const end = matchBracket(scratch, open)
    return end === -1 ? "" : code.slice(open + 1, end)
  }
  if (first.startsWith("(") && budget > 0) return parameterPattern(code, scratch, i + 1, budget - 1)
  return ""
}

/** Every `name = <expression>` in a destructuring pattern, by name. */
function patternDefaults(pattern) {
  const defaults = new Map()
  if (!pattern) return defaults
  for (const part of splitTopLevel(pattern, ",")) {
    if (defaults.size >= MAX_PROPS) break
    // `label: text = "Save"` renames the binding; the PROP is still `label`,
    // and the rename is the local variable's business rather than the picker's.
    const match = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*[A-Za-z_$][\w$]*\s*)?=\s*([\s\S]+)$/.exec(part)
    if (!match) continue
    if (!defaults.has(match[1])) defaults.set(match[1], match[2].trim())
  }
  return defaults
}

/**
 * The older spelling of the same fact: `Button.defaultProps = { … }`.
 *
 * React has deprecated it for function components and a library written this
 * year will not have one, but a design system that predates hooks very often
 * still does, and the whole promise of this feature is that it reads the
 * library the user already has rather than the one they would write today.
 */
function defaultPropsOf(code, scratch, name) {
  const defaults = new Map()
  const anchor = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\s*\\.\\s*defaultProps\\s*=\\s*\\{`)
  const match = anchor.exec(code)
  if (!match) return defaults
  const open = match.index + match[0].length - 1
  const close = matchBracket(scratch, open)
  if (close === -1) return defaults
  for (const part of splitTopLevel(code.slice(open + 1, close), ",")) {
    if (defaults.size >= MAX_PROPS) break
    const pair = /^\s*(?:(["'])([^"'\n]+)\1|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+)$/.exec(part)
    if (!pair) continue
    const key = pair[2] ?? pair[3]
    if (key && !defaults.has(key)) defaults.set(key, pair[4].trim())
  }
  return defaults
}

function reactSnippet(name, props) {
  const carrier = props.find((prop) => prop.values?.length)
  return carrier ? `<${name} ${carrier.name}="${carrier.values[0]}" />` : `<${name} />`
}

function extractReact(code, scratch, comments, types) {
  const found = []
  const named = new Set()

  const build = (name, declStart, headEnd, patternFrom, isDefault) => {
    const head = code.slice(declStart, Math.min(code.length, headEnd))
    const propsType = propsTypeFor(name, head, types)
    const props = propsType ? parseProps(types.bodies.get(propsType), types) : []
    const description =
      jsDocAbove(comments, code, declStart) ||
      (propsType ? jsDocAbove(comments, code, types.starts.get(propsType) ?? 0) : "")
    // A destructuring default and a `defaultProps` entry say the same thing, and
    // when a component carries both the signature is the one that runs: React
    // fills a missing prop from `defaultProps` first, and the parameter default
    // then applies to whatever is still undefined. Reading them in that order
    // means the picker preselects the value the component would really render.
    const defaults = patternDefaults(parameterPattern(code, scratch, patternFrom))
    for (const [key, value] of defaultPropsOf(code, scratch, name)) {
      if (!defaults.has(key)) defaults.set(key, value)
    }
    applyDefaults(props, defaults)
    found.push({
      framework: "react",
      name,
      propsType,
      props,
      description,
      defaults,
      exportName: isDefault ? "" : name,
      defaultExport: isDefault,
    })
  }

  const functions =
    /(?:^|[\n;}])[ \t]*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Z][\w$]*)\s*[<(]/g
  let match
  while ((match = functions.exec(code))) {
    const name = match[1]
    if (named.has(name)) continue
    named.add(name)
    const declStart = match.index + match[0].indexOf("export")
    build(name, declStart, declStart + 300, match.index + match[0].length - 1, isDefaultExport(match[0]))
  }

  const constants = /(?:^|[\n;}])[ \t]*export\s+(?:default\s+)?(?:const|let|var)\s+([A-Z][\w$]*)\b/g
  while ((match = constants.exec(code))) {
    const name = match[1]
    if (named.has(name)) continue
    const initializer = initializerStart(scratch, match.index + match[0].length)
    if (initializer === -1 || !looksLikeComponentInitializer(scratch, initializer)) continue
    named.add(name)
    const declStart = match.index + match[0].indexOf("export")
    build(name, declStart, initializer + 200, initializer, isDefaultExport(match[0]))
  }

  // A file holding one component and one props type has said everything it
  // needs to; the pairing is unambiguous even when the two names do not match,
  // which is how `interface Props` next to `export function Button` is read.
  if (found.length === 1 && !found[0].propsType) {
    const spare = [...types.bodies.keys()].filter((key) => /Props$/.test(key))
    if (spare.length === 1) {
      found[0].propsType = spare[0]
      found[0].props = parseProps(types.bodies.get(spare[0]), types)
      // These props were parsed after the defaults were read, so they have not
      // met them yet.
      applyDefaults(found[0].props, found[0].defaults)
      found[0].description =
        found[0].description || jsDocAbove(comments, code, types.starts.get(spare[0]) ?? 0)
    }
  }

  for (const entry of found) entry.snippet = reactSnippet(entry.name, entry.props)
  return found
}

/* ------------------------------------------------------------------------ *
 * Angular
 * ------------------------------------------------------------------------ */

/**
 * The element name a component answers to.
 *
 * Only a plain element selector is kept. An Angular selector is a CSS selector
 * and may be an attribute or a class, which a component-shaped snippet cannot
 * express, and the selector is also what the client matches a live DOM tag
 * against — a tag is the only form that comparison can succeed on.
 */
function angularSelector(config) {
  const match = /(?:^|[\s,{])selector\s*:\s*(["'])([^"'\n]*)\1/.exec(config)
  if (!match) return ""
  const first = match[2].split(",")[0].trim()
  return /^[a-z][a-z0-9-]*$/.test(first) ? first : ""
}

/** `@Input("label")` and `@Input({ alias: "label" })` rename the prop. */
function decoratorAlias(args) {
  const positional = /^\s*(["'])([^"'\n]+)\1/.exec(args)
  if (positional) return positional[2]
  const named = /\balias\s*:\s*(["'])([^"'\n]+)\1/.exec(args)
  return named ? named[2] : ""
}

/**
 * The expression a class member is initialized to, read from where its type
 * stopped.
 *
 * It is returned as written rather than interpreted here, because deciding
 * whether an expression is a value this editor can offer is one judgement and
 * it belongs in one place — `literalDefault`, which is also where the React
 * side's defaults arrive. The window is cut at the first `;` or line end, which
 * gives up on a multi-line initializer: nothing spelled across lines is a
 * string literal anyway. `=>` and `==` are stepped over rather than read as an
 * assignment, because the type scan stops at the `=` of an arrow return type
 * and taking that as a default would read a function's body as one.
 */
function initializerExpression(body, at) {
  let i = at
  while (i < body.length && /[ \t]/.test(body[i])) i += 1
  if (body[i] !== "=" || body[i + 1] === "=" || body[i + 1] === ">") return ""
  const window = body.slice(i + 1, i + 1 + 400)
  const end = window.search(/[;\n]/)
  return (end === -1 ? window : window.slice(0, end)).trim()
}

/**
 * The written type of a class member, and the value it defaults to.
 *
 * Both are read in one pass because the second begins exactly where the first
 * ends — `variant: 'a' | 'b' = 'a'` is one declaration, and finding the `=`
 * again from outside would mean re-deciding where the type stopped, which is
 * the hard half. A member with no annotation at all still has its initializer
 * read: `@Input() tone = 'loud'` declares a default and no type, and it is
 * still the value the component renders with.
 */
function memberTypeAndDefault(body, scratch, from) {
  let i = from
  while (i < body.length && /[ \t!?]/.test(body[i])) i += 1
  let type = ""
  if (body[i] === ":") {
    i += 1
    const start = i
    const limit = Math.min(body.length, start + 400)
    let depth = 0
    while (i < limit) {
      const ch = scratch[i]
      if (ch === "'" || ch === '"') {
        i = endOfQuoted(scratch, i)
        continue
      }
      if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth += 1
      else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
        if (depth === 0) break
        depth -= 1
      } else if (depth === 0 && (ch === "=" || ch === ";")) break
      else if (depth === 0 && ch === "\n" && !/^\s*\|/.test(scratch.slice(i + 1, i + 40))) break
      i += 1
    }
    type = body.slice(start, i)
  }
  return { type, initial: initializerExpression(body, i) }
}

/** `@Input() set value(next: Tone)` declares its type on the parameter. */
function setterParameterType(body, scratch, from) {
  const open = body.indexOf("(", from)
  if (open === -1 || open > from + 40) return ""
  const close = matchBracket(scratch, open)
  if (close === -1) return ""
  const first = splitTopLevel(body.slice(open + 1, close), ",")[0] ?? ""
  const match = /:\s*([\s\S]+)$/.exec(first)
  return match ? match[1] : ""
}

/** The index just past the `>` closing the `<` at `open`, or -1. */
function angleEnd(scratch, open) {
  let depth = 0
  let i = open
  const limit = Math.min(scratch.length, open + 400)
  while (i < limit) {
    const ch = scratch[i]
    if (ch === "'" || ch === '"') {
      i = endOfQuoted(scratch, i)
      continue
    }
    if (ch === "<") depth += 1
    else if (ch === ">") {
      depth -= 1
      if (depth === 0) return i + 1
    }
    i += 1
  }
  return -1
}

/** The text inside `input<…>`, so its type argument can be read for options. */
function angleArgument(body, scratch, open) {
  const end = angleEnd(scratch, open)
  return end === -1 ? "" : body.slice(open + 1, end - 1)
}

/** The first argument of the call beginning at or just after `from`. */
function firstCallArgument(body, scratch, from) {
  let i = from
  while (i < body.length && /\s/.test(body[i])) i += 1
  if (body[i] !== "(") return ""
  const close = matchBracket(scratch, i)
  if (close === -1) return ""
  return (splitTopLevel(body.slice(i + 1, close), ",")[0] ?? "").trim()
}

/**
 * The inputs a component class declares, in both spellings Angular supports.
 *
 * `@Input()` is the decorator form and `input()` the signal form, and a library
 * mid-migration has both — often in the same class — so neither can be treated
 * as the modern one and skipped. `model()` is read alongside `input()` because
 * it is an input that also writes back; from the inspector's side, which only
 * wants to know that the prop exists and which values it takes, the difference
 * does not show.
 */
function angularProps(classBody, types) {
  const scratch = neutralized(classBody)
  const props = []
  const taken = new Set()

  const add = (name, typeText, defaultText) => {
    if (!name || taken.has(name) || props.length >= MAX_PROPS) return
    taken.add(name)
    const collapsed = collapse(typeText ?? "")
    const values = collapsed ? resolveValues(collapsed, types) : []
    const initial = literalDefault(defaultText, values)
    props.push({
      name,
      ...(collapsed ? { type: truncate(collapsed, MAX_TYPE_TEXT) } : {}),
      ...(values.length ? { values } : {}),
      ...(initial ? { default: initial } : {}),
    })
  }

  const decorated = /@Input\s*\(/g
  let match
  while ((match = decorated.exec(classBody))) {
    const open = match.index + match[0].length - 1
    const close = matchBracket(scratch, open)
    if (close === -1) continue
    const alias = decoratorAlias(classBody.slice(open + 1, close))
    const member =
      /^\s*(?:(?:public|protected|private|readonly|override|declare|static|accessor)\s+)*(?:(set)\s+)?([A-Za-z_$][\w$]*)/.exec(
        classBody.slice(close + 1, close + 200)
      )
    if (!member) continue
    const memberEnd = close + 1 + member.index + member[0].length
    // A setter has no initializer to read — the default of a `set` input lives
    // in whatever the backing field was declared with, which is a different
    // member under a different name and not a fact this scanner can pair up.
    const declared =
      member[1] === "set"
        ? { type: setterParameterType(classBody, scratch, memberEnd), initial: "" }
        : memberTypeAndDefault(classBody, scratch, memberEnd)
    add(alias || member[2], declared.type, declared.initial)
    decorated.lastIndex = Math.max(decorated.lastIndex, memberEnd)
  }

  const signals =
    /(?:^|[\n;{}])\s*(?:(?:public|protected|private|readonly|override|static|accessor)\s+)*([A-Za-z_$][\w$]*)\s*=\s*(?:input|model)(\.required)?\s*[<(]/g
  while ((match = signals.exec(classBody))) {
    const end = match.index + match[0].length
    const angled = classBody[end - 1] === "<"
    // `input('md')` takes its initial value first and `input.required()` takes
    // none at all — its first argument is the options object, and reading that
    // as a default would offer `{ alias: … }` as a value of the prop.
    const callAt = angled ? angleEnd(scratch, end - 1) : end - 1
    const initial =
      match[2] || callAt === -1 ? "" : firstCallArgument(classBody, scratch, callAt)
    add(match[1], angled ? angleArgument(classBody, scratch, end - 1) : "", initial)
  }

  return props
}

function angularSnippet(selector, props) {
  if (!selector) return ""
  const carrier = props.find((prop) => prop.values?.length)
  const attribute = carrier ? ` ${carrier.name}="${carrier.values[0]}"` : ""
  return `<${selector}${attribute}></${selector}>`
}

function extractAngular(code, scratch, comments, types) {
  const found = []
  const decorators = /@Component\s*\(/g
  let match
  while ((match = decorators.exec(code))) {
    const open = match.index + match[0].length - 1
    const close = matchBracket(scratch, open)
    if (close === -1) continue
    const selector = angularSelector(code.slice(open + 1, close))

    const classMatch = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(code.slice(close, close + 600))
    if (!classMatch) continue
    const classNameEnd = close + classMatch.index + classMatch[0].length
    // Whatever stands between the decorator and the `class` keyword says how
    // the class leaves the file. Anchoring at the end tolerates a second
    // decorator in between without letting that decorator's own words count.
    const modifiers = code.slice(close + 1, close + classMatch.index)
    const exported = /\bexport\s+(?:default\s+)?(?:abstract\s+)?$/.test(modifiers)
    const isDefault = /\bexport\s+default\s+(?:abstract\s+)?$/.test(modifiers)
    const bodyOpen = findBodyBrace(scratch, classNameEnd)
    const bodyClose = bodyOpen === -1 ? -1 : matchBracket(scratch, bodyOpen)
    const classBody = bodyClose === -1 ? "" : code.slice(bodyOpen + 1, bodyClose)

    const props = classBody ? angularProps(classBody, types) : []
    found.push({
      framework: "angular",
      name: classMatch[1],
      selector,
      props,
      // The doc comment sits above the decorator, not above the class — the
      // decorator is what the author writes first.
      description: jsDocAbove(comments, code, match.index),
      snippet: angularSnippet(selector, props),
      exportName: exported && !isDefault ? classMatch[1] : "",
      defaultExport: isDefault,
    })
    if (bodyClose !== -1) decorators.lastIndex = Math.max(decorators.lastIndex, bodyClose)
  }
  return found
}

/* ------------------------------------------------------------------------ *
 * Scanning
 * ------------------------------------------------------------------------ */

function extractComponents(source) {
  const { code, comments } = maskSource(source)
  const scratch = neutralized(code)
  const types = collectTypeDeclarations(code, scratch)
  const found = [
    ...extractAngular(code, scratch, comments, types),
    ...extractReact(code, scratch, comments, types),
  ]

  // A component the declaration did not show leaving the file may still leave
  // it from the foot of the file, and only a whole-file look can tell.
  const defaulted = defaultExportNames(code)
  for (const entry of found) {
    if (!entry.exportName && !entry.defaultExport && defaulted.has(entry.name)) {
      entry.defaultExport = true
    }
  }
  return found
}

/**
 * absolute file -> `{ mtimeMs, size, found }`: what `extractComponents` read out
 * of each file, kept while its stat holds.
 *
 * A directory library is re-scanned on every Libraries repaint, which is what
 * keeps a component added to it visible without a restart. The walk and a stat
 * per file still run every time, so additions, edits and deletions are all
 * seen; what an unchanged file stops costing is the read and the parse. Never
 * mutated after it is stored — the loop below copies each entry into its own
 * component record.
 */
const extracted = new Map()

async function collectSourceFiles(root, maxFiles) {
  const files = []
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length && files.length < maxFiles) {
    const { dir, depth } = queue.shift()
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (files.length >= maxFiles) break
      // A symlink is skipped rather than followed: it is the one entry that can
      // point back up the tree and turn a walk into a loop.
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || depth >= MAX_DEPTH) continue
        queue.push({ dir: full, depth: depth + 1 })
      } else if (entry.isFile() && isScannableFile(entry.name)) {
        files.push(full)
      }
    }
  }
  return files
}

/**
 * Every component declared under a directory, or in one file.
 *
 * Nothing in here throws. A library is read as a whole and a user who points at
 * four hundred components must get the ones that parsed, not an error raised by
 * the one file that was mid-edit when they clicked — which is also the file
 * they are most likely to be working on. Every read and every extraction is
 * therefore wrapped, and an unreadable path resolves to an empty library rather
 * than a failure the caller has to spell an error message for.
 *
 * `projectRoot` is what every reported `file` is measured against, and it is
 * separate from `absDir` because the two answer different questions: the
 * scanned directory is where the library's own structure starts, so it is what
 * a component's GROUP is relative to, while the project is what a path has to
 * be relative to for the client and the insertion writer to resolve it. A
 * caller that does not name a project root gets paths relative to the only root
 * it did name, which is the one honest fallback available — that caller has not
 * told this function a project exists.
 */
export async function scanComponentLibrary(
  absDir,
  { maxFiles = 3000, maxComponents = 400, maxBytes = 2_000_000, projectRoot = "" } = {}
) {
  let stats
  try {
    stats = await fs.stat(absDir)
  } catch {
    return { components: [], framework: null }
  }

  const files = stats.isDirectory()
    ? await collectSourceFiles(absDir, maxFiles)
    : SOURCE_EXTENSIONS.has(path.extname(absDir))
      ? [absDir]
      : []

  // A single file is its own library of one, and it has no folder structure
  // above it to group by — so the root is the directory holding it, which puts
  // it at that root and leaves its group empty.
  const libraryRoot = stats.isDirectory() ? absDir : path.dirname(absDir)
  const root = projectRoot || libraryRoot

  const components = []
  const ids = new Set()
  let react = 0
  let angular = 0

  for (const file of files) {
    if (components.length >= maxComponents) break
    let found
    try {
      const info = await fs.stat(file)
      if (info.size > maxBytes) continue
      const cached = extracted.get(file)
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        found = cached.found
      } else {
        const source = await fs.readFile(file, "utf8")
        try {
          found = extractComponents(source)
        } catch {
          found = []
        }
        extracted.set(file, { mtimeMs: info.mtimeMs, size: info.size, found })
      }
    } catch {
      continue
    }

    const group = groupFor(libraryRoot, file)
    const relative = projectRelative(root, file)

    for (const entry of found) {
      if (components.length >= maxComponents) break
      if (entry.framework === "angular") angular += 1
      else react += 1

      // Two directories in one library may each declare a `Card`, and they are
      // two different components. The id disambiguates so neither is lost.
      const base = slug(entry.name) || "component"
      let id = `component:${base}`
      for (let n = 2; ids.has(id); n += 1) id = `component:${base}-${n}`
      ids.add(id)

      components.push({
        id,
        name: entry.name,
        ...(entry.selector ? { selector: entry.selector } : {}),
        ...(entry.description ? { description: entry.description } : {}),
        ...(entry.snippet ? { snippet: entry.snippet } : {}),
        ...(entry.props?.length ? { props: entry.props } : {}),
        // These four are always present, empty string and `false` included. A
        // browser that groups by a field has to be able to ask every component
        // for it, and an absent key would make "this component is at the
        // library root" and "this component was read before groups existed"
        // the same answer.
        group,
        file: relative,
        exportName: entry.exportName ?? "",
        defaultExport: entry.defaultExport === true,
      })
    }
  }

  components.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const framework = react && angular ? "mixed" : react ? "react" : angular ? "angular" : null
  return { components, framework }
}

/* ------------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------------ */

/**
 * Whether a file's opening bytes read as a component declaration.
 *
 * Only the head is read, and only enough of it to answer the question. The
 * capitalized-`const` case additionally wants some JSX in view, because that is
 * the one form an exported constant shares with a data table — a file exporting
 * `const Palette = {…}` and nothing else is not a component library, and
 * offering it as one costs the user a click and their trust in the list.
 */
async function headLooksLikeComponent(file) {
  let handle
  try {
    handle = await fs.open(file, "r")
    const buffer = Buffer.alloc(PROBE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, PROBE_BYTES, 0)
    const head = buffer.toString("utf8", 0, bytesRead)
    if (/@Component\s*\(/.test(head)) return true
    if (/\bexport\s+(?:default\s+)?(?:async\s+)?function\s+[A-Z]/.test(head)) return true
    return /\bexport\s+(?:default\s+)?const\s+[A-Z]/.test(head) && /(?:<\/|\/>)/.test(head)
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function scannableFilesIn(dir, limit) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return { files: [], directories: [] }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const files = []
  const directories = []
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && directories.length < PROBE_SUBDIRECTORIES) {
        directories.push(path.join(dir, entry.name))
      }
    } else if (entry.isFile() && isScannableFile(entry.name) && files.length < limit) {
      files.push(path.join(dir, entry.name))
    }
  }
  return { files, directories }
}

/**
 * Whether a directory is worth offering as a component library.
 *
 * This runs once per directory of a whole project walk, so it reads a handful
 * of file heads and stops the moment two of them answer yes. It looks one level
 * down as well, because the commonest layout by far puts each component in a
 * folder of its own — a directory whose own files are a barrel and a service,
 * with the components in subfolders beside them, is exactly the directory a
 * user means when they say "my components live here".
 *
 * Two hits, not one: a single component file is far more often an ordinary
 * source file that happens to export something capitalized than it is a library.
 */
export async function looksLikeComponentLibrary(absDir) {
  try {
    if (!(await fs.stat(absDir)).isDirectory()) return false
  } catch {
    return false
  }

  const own = await scannableFilesIn(absDir, PROBE_OWN_FILES)
  const candidates = [...own.files]
  for (const directory of own.directories) {
    if (candidates.length >= PROBE_READS) break
    const nested = await scannableFilesIn(directory, 2)
    candidates.push(...nested.files)
  }

  let hits = 0
  for (const file of candidates.slice(0, PROBE_READS)) {
    if (await headLooksLikeComponent(file)) {
      hits += 1
      if (hits >= PROBE_HITS) return true
    }
  }
  return false
}
