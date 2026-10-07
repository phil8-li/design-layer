/**
 * Angular host support: which file an element is written in, and how to write
 * to it.
 *
 * This is the Angular half of the one question `src/core/bridge.ts` owns for
 * React — "where is this element authored" — plus the writer that answers what
 * jscodeshift answers there. It exists because neither of the React mechanisms
 * has an Angular equivalent:
 *
 *   - There is no fiber, so there is no `_debugSource` and no owner stack. The
 *     browser side gets the component from Angular's own dev-mode `ng` global
 *     (`ng.getOwningComponent`) and sends this module a CLASS NAME.
 *   - There is no JSX, so the vendor's AST codemod has nothing to walk. An
 *     Angular component's markup is a separate `.html` file (or an inline
 *     template string), which is plain HTML plus Angular's own syntax.
 *
 * So resolution is `class name -> @Component decorator -> templateUrl`, and
 * writing is a byte-range splice into that template. Nothing here parses
 * Angular's binding syntax: it locates a START TAG and edits its attributes,
 * which is the smallest operation that can express a style, a class or a text
 * change, and the only one that cannot silently rewrite control flow.
 *
 * Inserting an element is the one operation that reaches past the template. A
 * standalone component compiles its template against the symbols in its OWN
 * `@Component({ imports: [...] })` array, and nothing else: a component that is
 * imported into the `.ts` file but missing from that array is simply not in
 * scope for the template, so the new tag is left as an unknown element and
 * renders nothing (or fails the build outright under strict templates). The
 * template splice alone therefore produces markup that looks correct in the
 * file and is invisible in the browser, which is the worst outcome available —
 * so an insertion writes the import statement and the `imports` entry too, and
 * fails as a whole if it cannot.
 *
 * What it deliberately will not do is guess. A descriptor that matches two
 * template elements equally well returns `null` rather than a coin flip; the
 * caller strands the change into the Prompts tab, which is the behaviour the
 * React path already has for an element it cannot place.
 */

import fs from "node:fs"
import path from "node:path"

import { isEditableSourcePath } from "../config.mjs"
import { applyEdits, lineExtendedRange, matchNode } from "./element-match.mjs"
import {
  formatImport,
  importDecision,
  importSpecifier,
  insertionEdit,
  isSameModule,
  scanImportBindings,
} from "./source-insert.mjs"

/**
 * Re-exported because `matchNode` is the Angular lane's own answer to "which
 * template node is this", and every caller and test here has always asked this
 * module for it. The implementation moved to `element-match.mjs` when the React
 * lane needed the identical scoring to delete a JSX element.
 */
export { matchNode }

/** Directories never worth walking for component sources. */
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".angular",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".cache",
])

/** Bounded so a mis-pointed project root cannot walk a home directory. */
const MAX_SCANNED_FILES = 4000
/** How long a name that missed a just-verified index is answered as a miss. */
const MISS_TTL_MS = 3000

/** HTML elements that never have a closing tag, so the depth stack must not push them. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
])

/* -------------------------------------------------------------------------
 * The component index
 * ---------------------------------------------------------------------- */

/**
 * The end of a balanced `(...)` or `{...}` run that starts at `open`.
 *
 * String-aware, because a decorator's `template:` is very often a backtick
 * string containing braces of its own, and a brace counter that cannot see
 * quotes stops in the middle of one.
 */
function matchingClose(source, open) {
  const pairs = { "(": ")", "{": "}", "[": "]" }
  const stack = [pairs[source[open]]]
  let index = open + 1
  while (index < source.length && stack.length) {
    const char = source[index]
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(source, index)
      continue
    }
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index)
      if (index === -1) return -1
      continue
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2)
      if (end === -1) return -1
      index = end + 2
      continue
    }
    if (pairs[char]) stack.push(pairs[char])
    else if (char === stack[stack.length - 1]) stack.pop()
    index += 1
  }
  return stack.length ? -1 : index - 1
}

/** The index just past the string literal opening at `start`. */
function skipString(source, start) {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === "\\") {
      index += 2
      continue
    }
    if (char === quote) return index + 1
    // A template literal's `${}` can nest anything, including another string.
    if (quote === "`" && char === "$" && source[index + 1] === "{") {
      const close = matchingClose(source, index + 1)
      if (close === -1) return source.length
      index = close + 1
      continue
    }
    index += 1
  }
  return source.length
}

/** A single-quoted, double-quoted or backticked literal value for `key`. */
function decoratorString(decorator, key) {
  const match = new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^'"\`]*)\\1`).exec(decorator)
  return match ? match[2] : null
}

/** The first entry of `key: [...]`, which is how `styleUrls` is spelled. */
function decoratorFirstOfArray(decorator, key) {
  const match = new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(decorator)
  if (!match) return null
  const first = /(['"`])([^'"`]*)\1/.exec(match[1])
  return first ? first[2] : null
}

/**
 * The inline `template:` literal's byte range inside the `.ts` file, or null.
 *
 * The range covers the template TEXT only, so a splice into it lands in the
 * markup rather than through the quote that delimits it.
 */
function inlineTemplateRange(source, decoratorStart, decoratorEnd) {
  const decorator = source.slice(decoratorStart, decoratorEnd)
  const match = /\btemplate\s*:\s*(['"`])/.exec(decorator)
  if (!match) return null
  const quoteAt = decoratorStart + match.index + match[0].length - 1
  const end = skipString(source, quoteAt)
  return { start: quoteAt + 1, end: end - 1 }
}

function scanComponentFile(absolutePath, source) {
  const found = []
  let cursor = 0
  for (;;) {
    const at = source.indexOf("@Component", cursor)
    if (at === -1) break
    const open = source.indexOf("(", at)
    if (open === -1) break
    const close = matchingClose(source, open)
    if (close === -1) break
    // `export class Foo`, `export default class Foo`, `class Foo` — the name is
    // whatever follows the nearest `class` keyword after the decorator.
    const tail = source.slice(close + 1, close + 400)
    const named = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(tail)
    cursor = close + 1
    if (!named) continue

    const decorator = source.slice(open, close + 1)
    const templateUrl = decoratorString(decorator, "templateUrl")
    const styleUrl =
      decoratorString(decorator, "styleUrl") ?? decoratorFirstOfArray(decorator, "styleUrls")
    const directory = path.dirname(absolutePath)

    found.push({
      componentName: named[1],
      selector: decoratorString(decorator, "selector"),
      tsFile: absolutePath,
      // The decorator's own byte range, `(` through `)`. Inserting an element
      // into the template is only half of what makes it render: a standalone
      // component resolves the tags in its template against the `imports`
      // array written HERE, so the writer needs to find and edit that array.
      decoratorStart: open,
      decoratorEnd: close + 1,
      templateFile: templateUrl ? path.resolve(directory, templateUrl) : null,
      styleFile: styleUrl ? path.resolve(directory, styleUrl) : null,
      inlineTemplate: templateUrl ? null : inlineTemplateRange(source, open, close + 1),
    })
  }
  return found
}

function walkSources(root, onFile) {
  let scanned = 0
  const queue = [root]
  while (queue.length) {
    const directory = queue.shift()
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) continue
        queue.push(path.join(directory, entry.name))
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue
      if (entry.name.endsWith(".spec.ts") || entry.name.endsWith(".d.ts")) continue
      if (scanned >= MAX_SCANNED_FILES) return
      scanned += 1
      onFile(path.join(directory, entry.name))
    }
  }
}

/* -------------------------------------------------------------------------
 * Template scanning
 * ---------------------------------------------------------------------- */

/**
 * Comments blanked, offsets preserved.
 *
 * Replacing rather than removing keeps every index this module hands out — and
 * every index it later splices at — an index into the file as it sits on disk.
 */
function blankComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (comment) => " ".repeat(comment.length))
}

const START_TAG = /<([a-zA-Z][-\w.:]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
const END_TAG = /<\/([a-zA-Z][-\w.:]*)\s*>/g
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

function parseAttributes(raw, rawStart) {
  const attributes = new Map()
  ATTRIBUTE.lastIndex = 0
  let match
  while ((match = ATTRIBUTE.exec(raw))) {
    const name = match[1]
    if (!name || name === "/") continue
    const quoted = match[2] !== undefined ? '"' : match[3] !== undefined ? "'" : ""
    const value = match[2] ?? match[3] ?? match[4] ?? ""
    // Where the VALUE sits, so a rewrite replaces the value and nothing else.
    // The OPENING quote, which is the first one in the match: taking the last
    // one lands past the closing quote, and the splice then writes the new
    // value into the markup after the attribute instead of into it.
    const valueStart = quoted ? rawStart + match.index + match[0].indexOf(quoted) + 1 : -1
    attributes.set(name, {
      name,
      value,
      quote: quoted || '"',
      start: rawStart + match.index,
      end: rawStart + match.index + match[0].length,
      valueStart: quoted ? valueStart : -1,
      valueEnd: quoted ? valueStart + value.length : -1,
    })
  }
  return attributes
}

/** The static class list a template element declares, ignoring bindings. */
function templateClasses(attributes) {
  const attribute = attributes.get("class")
  if (!attribute) return []
  return attribute.value.split(/\s+/).filter(Boolean)
}

/**
 * Every start tag in a template, with its parent, its index among same-tag
 * siblings, and the byte ranges an edit needs.
 *
 * A hand-rolled scanner rather than a real parser on purpose. An Angular
 * template is not HTML — `@if`/`@for` blocks, `*ngFor`, `{{ }}` interpolation
 * and `[attr]` bindings all appear inside it — and every HTML parser worth
 * using normalises exactly the things that must survive a byte-range splice.
 * Scanning start tags leaves the rest of the file untouched by construction.
 */
export function scanTemplate(html) {
  const source = blankComments(html)
  const nodes = []
  const stack = []
  const tokens = []

  START_TAG.lastIndex = 0
  let match
  while ((match = START_TAG.exec(source))) {
    tokens.push({ kind: "start", index: match.index, match })
  }
  END_TAG.lastIndex = 0
  while ((match = END_TAG.exec(source))) {
    // `end` as well as `index`, because deleting an element needs the offset
    // PAST `</div>` and `</div   >` is legal markup — recomputing it later from
    // the tag name would be a second, subtly different parse of the same token.
    tokens.push({
      kind: "end",
      index: match.index,
      end: match.index + match[0].length,
      name: match[1].toLowerCase(),
    })
  }
  tokens.sort((a, b) => a.index - b.index)

  // Same-tag counts per open parent, so `nthOfType` means the same thing here
  // as `previousElementSibling` counting does in the browser.
  const counters = [new Map()]

  for (const token of tokens) {
    if (token.kind === "end") {
      // Unwinding to the matching open tag closes it and everything a malformed
      // template left open under it, which is what a browser does too.
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (stack[depth].tagName === token.name) {
          stack[depth].contentEnd = token.index
          stack[depth].closeEnd = token.end
          stack.length = depth
          counters.length = depth + 1
          break
        }
      }
      continue
    }

    const [whole, rawName, rawAttributes, selfClosing] = token.match
    const tagName = rawName.toLowerCase()
    const attributesStart = token.index + 1 + rawName.length
    const attributes = parseAttributes(rawAttributes, attributesStart)
    const parent = stack[stack.length - 1] ?? null
    const counter = counters[counters.length - 1]
    const seen = counter.get(tagName) ?? 0
    counter.set(tagName, seen + 1)

    const node = {
      tagName,
      attributes,
      classes: templateClasses(attributes),
      nthOfType: seen,
      depth: stack.length,
      parentTagName: parent?.tagName ?? null,
      parentClasses: parent?.classes ?? [],
      // The whole start tag, `<` through `>`.
      start: token.index,
      end: token.index + whole.length,
      // Where a new attribute is inserted: after the last one, which is where a
      // person writing the template would have put it. Straight after the tag
      // name also produces valid HTML, and produces it in an order no author
      // chose — `<h2 style="…" class="card__title">` reads as machine output.
      insertAt: attributesStart + rawAttributes.replace(/\s+$/, "").length,
      selfClosing: Boolean(selfClosing) || VOID_ELEMENTS.has(tagName),
      contentStart: token.index + whole.length,
      contentEnd: -1,
      /** Past the closing tag; the start tag's own end for a self-closing one. */
      closeEnd: -1,
    }
    nodes.push(node)
    if (!node.selfClosing) {
      stack.push(node)
      counters.push(new Map())
    }
  }

  return nodes
}

function lineColumnAt(source, offset) {
  let line = 1
  let lastBreak = -1
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1
      lastBreak = index
    }
  }
  return { lineNumber: line, columnNumber: offset - lastBreak }
}

/* -------------------------------------------------------------------------
 * Edits
 * ---------------------------------------------------------------------- */

function parseStyleAttribute(value) {
  const declarations = new Map()
  for (const part of value.split(";")) {
    const colon = part.indexOf(":")
    if (colon === -1) continue
    const property = part.slice(0, colon).trim()
    const declared = part.slice(colon + 1).trim()
    if (property) declarations.set(property, declared)
  }
  return declarations
}

function formatStyleAttribute(declarations) {
  return [...declarations]
    .filter(([, value]) => value !== "")
    .map(([property, value]) => `${property}: ${value}`)
    .join("; ")
}

/** An attribute rewrite expressed as one splice, so edits can be sorted and applied. */
function setAttribute(node, name, value) {
  const existing = node.attributes.get(name)
  if (existing && existing.valueStart !== -1) {
    return { start: existing.valueStart, end: existing.valueEnd, text: escapeAttribute(value) }
  }
  if (existing) {
    return { start: existing.start, end: existing.end, text: `${name}="${escapeAttribute(value)}"` }
  }
  return { start: node.insertAt, end: node.insertAt, text: ` ${name}="${escapeAttribute(value)}"` }
}

function removeAttribute(node, name) {
  const existing = node.attributes.get(name)
  if (!existing) return null
  return { start: existing.start, end: existing.end, text: "" }
}

function escapeAttribute(value) {
  return String(value).replace(/"/g, "&quot;")
}

/**
 * The whole element, plus the blank line it would otherwise leave behind.
 *
 * Deleting exactly `<div …>…</div>` is correct and looks like a bug: the line
 * the element sat on stays, now holding nothing but its own indentation, and
 * the next person to open the file sees a ragged hole rather than markup with
 * one thing taken out of it. So the range grows to the line when — and only
 * when — the element had that line to itself. An element sharing a line with a
 * sibling or with text keeps every byte of that line that is not its own.
 */
function elementRange(node, template) {
  if (!node.selfClosing && node.closeEnd === -1) {
    throw new Error("element has no closing tag, so its end cannot be found")
  }
  const end = node.selfClosing ? node.end : node.closeEnd
  return lineExtendedRange(node.start, end, template)
}

/**
 * A reference node's bounds, in the shape `source-insert.mjs` splices against.
 *
 * A template node's `end` is the end of its START tag — `<div class="a">` — and
 * its `closeEnd` is what sits past `</div>`, so the whole-element range has to
 * be stated here rather than read off one field. A JSX node spells the same
 * facts differently, which is exactly why the shared helper is handed this
 * shape instead of either scanner's own.
 */
function insertAnchor(node) {
  return {
    tagName: node.tagName,
    elementStart: node.start,
    elementEnd: node.selfClosing ? node.end : node.closeEnd,
    contentStart: node.selfClosing ? -1 : node.contentStart,
    contentEnd: node.selfClosing ? -1 : node.contentEnd,
    selfClosing: node.selfClosing,
  }
}

/**
 * The whole template as a container, for an insertion that named no reference
 * element.
 *
 * A template's root is not an element — it is a file, which may hold several
 * top-level tags or none — so there is nothing to locate and nothing to sit
 * beside. `prepend` and `append` still mean something against it, and that is
 * all the route allows with a null target.
 */
function templateAnchor(template) {
  return {
    tagName: "template",
    elementStart: 0,
    elementEnd: template.length,
    contentStart: 0,
    contentEnd: template.length,
    selfClosing: false,
  }
}

/**
 * The end of a `[ ... ]` or `{ ... }` list's last entry, and how to write one
 * more after it.
 *
 * Used for both halves of the standalone wiring — adding a symbol to
 * `imports: [...]`, and adding the whole `imports: [X]` property to a decorator
 * that has none — because the formatting question is identical and the answer
 * has to come out looking hand-written either way. A list already broken across
 * lines gets a new line at the same indentation as its last entry; a list on
 * one line stays on one line; an empty list is simply filled in.
 */
function listInsertion(source, open, close, entry) {
  const inner = source.slice(open + 1, close)
  if (!inner.trim()) return { start: open + 1, end: close, text: entry }

  let last = close - 1
  while (last > open && /\s/.test(source[last])) last -= 1
  const multiline = inner.includes("\n")
  const indent = multiline ? lineIndentOf(source, last) : ""
  // A list whose last entry already ends in a comma is written in the style
  // that expects one on every entry, so the new entry gets one too — otherwise
  // the addition is visible as the one line the author would not have written.
  const dangling = source[last] === ","
  const opener = dangling ? "" : ","
  const closer = dangling ? "," : ""
  const text = multiline
    ? `${opener}\n${indent}${entry}${closer}`
    : `${opener} ${entry}${closer}`
  return { start: last + 1, end: last + 1, text }
}

/** The whitespace at the start of the line `offset` sits on. */
function lineIndentOf(source, offset) {
  let start = offset
  while (start > 0 && source[start - 1] !== "\n") start -= 1
  return /^[ \t]*/.exec(source.slice(start))[0]
}

/**
 * The `.ts` edits that make an inserted tag resolve: the ES import, and the
 * symbol in the component's `imports` array.
 *
 * Returns `{ edits }` with however many of the two are missing, or `{ reason }`
 * when the file cannot be given the symbol at all. Both refusals are real
 * cases, not defensive noise:
 *
 *   - the name is already bound to a different module, so a second import of
 *     it would not compile, and splicing the tag in anyway would silently point
 *     at whatever that other module exports;
 *   - the component declares `standalone: false`, which means its directives
 *     come from the NgModule that declares it. That module is somewhere else in
 *     the project, this index does not hold it, and guessing which one to edit
 *     is how an editor breaks a build it was asked to help with.
 *
 * A component with no `standalone` key at all is treated as standalone, which
 * is what Angular itself does from v19 on; one that opted out says so.
 */
function standaloneImportEdits(source, component, request, planned) {
  const specifier = importSpecifier(request.from, request.receiving)
  // `planned` is what an earlier operation in this same batch already decided
  // to write. Without it a page inserting two of the same component imports it
  // twice and lists it twice, because neither edit is on disk yet for the
  // second one to see.
  const alreadyPlanned = planned.get(request.name) ?? null
  const bound = scanImportBindings(source).get(request.name) ?? alreadyPlanned
  // A class declared in the very file receiving the tag — a component used
  // inside its own template — needs the decorator entry but must never be
  // given the import statement: see `isSameModule`. The two halves are
  // separate here, so skipping one still writes the other.
  const decision = isSameModule(request.from, request.receiving)
    ? { add: false, reason: null }
    : importDecision(request.name, specifier, bound)
  if (decision.reason) return { reason: decision.reason }

  const edits = []
  if (decision.add) {
    const statement = formatImport(request.name, request.defaultImport, specifier)
    edits.push(importStatementEdit(source, statement))
  }
  if (alreadyPlanned) return { edits, specifier }

  const decorator = source.slice(component.decoratorStart, component.decoratorEnd)
  const array = /\bimports\s*:\s*\[/.exec(decorator)
  if (array) {
    const open = component.decoratorStart + array.index + array[0].length - 1
    const close = matchingClose(source, open)
    if (close === -1) return { reason: `the imports array in ${path.basename(component.tsFile)} does not close` }
    const listed = source.slice(open + 1, close)
    if (!new RegExp(`(^|[^\\w$])${request.name}([^\\w$]|$)`).test(listed)) {
      edits.push(listInsertion(source, open, close, request.name))
    }
  } else if (/\bstandalone\s*:\s*false\b/.test(decorator)) {
    return {
      reason: `${component.componentName} is not standalone, so ${request.name} belongs to the NgModule that declares it`,
    }
  } else {
    const objectOpen = source.indexOf("{", component.decoratorStart)
    const objectClose = objectOpen === -1 ? -1 : matchingClose(source, objectOpen)
    if (objectOpen === -1 || objectClose === -1 || objectClose > component.decoratorEnd) {
      return { reason: `${component.componentName} has no decorator object to add imports to` }
    }
    edits.push(listInsertion(source, objectOpen, objectClose, `imports: [${request.name}]`))
  }

  return { edits, specifier }
}

/**
 * A new import statement, under the last one the `.ts` file already has.
 *
 * The trailing `[ \t]*;?` is deliberately not `\s*`: a greedy whitespace run
 * swallows the blank line between the imports and the decorator, and the
 * statement then lands glued to `@Component`.
 */
function importStatementEdit(source, statement) {
  let at = 0
  const pattern = /^[ \t]*import\s[\s\S]*?(?:from\s*['"][^'"\n]+['"]|['"][^'"\n]+['"])[ \t]*;?/gm
  let match
  while ((match = pattern.exec(source))) {
    at = match.index + match[0].length
  }
  if (at === 0) return { start: 0, end: 0, text: `${statement}\n` }
  return { start: at, end: at, text: `\n${statement}` }
}

/**
 * The splices one operation makes to one template node.
 *
 * Returned rather than applied so a batch can sort every splice across every
 * operation and rewrite the file once, back to front — the only order in which
 * earlier offsets stay valid.
 */
function editsFor(node, operation, template) {
  if (operation.op === "removeElement") {
    const { start, end } = elementRange(node, template)
    return [{ start, end, text: "" }]
  }

  if (operation.op === "insertElement") {
    return [insertionEdit(insertAnchor(node), operation.position, operation.markup, template)]
  }

  if (operation.op === "setStyles") {
    const attribute = node.attributes.get("style")
    const declarations = parseStyleAttribute(attribute?.value ?? "")
    for (const [property, value] of Object.entries(operation.declarations ?? {})) {
      if (value === "" || value === null) declarations.delete(property)
      else declarations.set(property, String(value))
    }
    const next = formatStyleAttribute(declarations)
    if (!next) {
      const removal = removeAttribute(node, "style")
      return removal ? [removal] : []
    }
    return [setAttribute(node, "style", next)]
  }

  if (operation.op === "setClasses") {
    const classes = templateClasses(node.attributes)
    const remove = new Set(operation.remove ?? [])
    const next = classes.filter((name) => !remove.has(name))
    for (const name of operation.add ?? []) {
      if (!next.includes(name)) next.push(name)
    }
    if (!next.length) {
      const removal = removeAttribute(node, "class")
      return removal ? [removal] : []
    }
    return [setAttribute(node, "class", next.join(" "))]
  }

  if (operation.op === "setText") {
    if (node.selfClosing || node.contentEnd === -1) {
      throw new Error("element has no closing tag to hold text")
    }
    const current = template.slice(node.contentStart, node.contentEnd)
    // Refused, not guessed. Replacing content that holds child elements would
    // delete them, and content holding `{{ }}` or an `@if` block is generated —
    // overwriting it edits the render, not the words.
    if (/<[a-zA-Z/]/.test(current)) throw new Error("element contains child elements")
    if (/\{\{|@(if|for|switch|defer|empty|else)\b/.test(current)) {
      throw new Error("element text is bound or inside control flow")
    }
    return [{ start: node.contentStart, end: node.contentEnd, text: String(operation.text ?? "") }]
  }

  throw new Error(`unsupported operation ${operation.op}`)
}

/* -------------------------------------------------------------------------
 * The module
 * ---------------------------------------------------------------------- */

export function createAngularSource(config) {
  const root = config.projectRoot
  /** class name -> component record. Built on first use, rebuilt on a miss. */
  let index = null
  /**
   * absolute `.ts` path -> `{ mtimeMs, size, components }`, so a rebuild costs
   * a walk and a stat per file and rescans only the files that changed.
   */
  const scans = new Map()
  /**
   * raw name -> when it last missed a just-verified index. A component that is
   * not the project's — Angular Material's `MatButton`, anything from the CDK —
   * misses on every selection, and each miss used to rebuild the whole index.
   * Cleared whenever a rebuild sees any file change (the index generation), and
   * short-lived besides, so a class added by an edit is never hidden for long.
   */
  const misses = new Map()

  const build = () => {
    const next = new Map()
    const seen = new Set()
    let changed = false
    walkSources(root, (file) => {
      // Stat before read: a write landing in between leaves a record older than
      // its text, which the next lookup's stat catches — never the reverse.
      let stat
      try {
        stat = fs.statSync(file)
      } catch {
        return
      }
      seen.add(file)
      let scan = scans.get(file)
      if (!scan || scan.mtimeMs !== stat.mtimeMs || scan.size !== stat.size) {
        let source
        try {
          source = fs.readFileSync(file, "utf8")
        } catch {
          scans.delete(file)
          return
        }
        const components = source.includes("@Component")
          ? scanComponentFile(file, source).map((component) => ({
              ...component,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
            }))
          : []
        scan = { mtimeMs: stat.mtimeMs, size: stat.size, components }
        scans.set(file, scan)
        changed = true
      }
      for (const component of scan.components) {
        if (!next.has(component.componentName)) next.set(component.componentName, component)
      }
    })
    for (const file of scans.keys()) {
      if (!seen.has(file)) {
        scans.delete(file)
        changed = true
      }
    }
    if (changed) misses.clear()
    index = next
    return next
  }

  /**
   * Whether a record's offsets still describe its `.ts` file.
   *
   * `decoratorStart/End` and `inlineTemplate` are byte offsets into the file as
   * it was scanned, and the writer splices at them into the file as it is NOW.
   * An edit from the IDE or an agent — one line added above `@Component` — used
   * to leave the index pointing a line early, so an insert duplicated an
   * `imports` entry or spliced into the wrong text. A stat per lookup is what
   * catches that before any offset is used.
   */
  const current = (record) => {
    try {
      const stat = fs.statSync(record.tsFile)
      return stat.mtimeMs === record.mtimeMs && stat.size === record.size
    } catch {
      return false
    }
  }

  /**
   * Angular class names survive bundling, but not untouched: esbuild renames a
   * class it has to keep alive, and the usual result is a `_` prefix
   * (`_OverviewComponent`) or a numeric suffix on a collision. The browser
   * sends what it read off the instance; normalising here keeps that detail out
   * of the client, which has no way to know what a real class name looks like.
   */
  const lookup = (rawName) => {
    if (typeof rawName !== "string" || !rawName) return null
    const candidates = [rawName]
    const unprefixed = rawName.replace(/^_+/, "")
    if (unprefixed !== rawName) candidates.push(unprefixed)
    const unsuffixed = unprefixed.replace(/\$?\d+$/, "")
    if (unsuffixed && unsuffixed !== unprefixed) candidates.push(unsuffixed)

    const find = (table) => {
      for (const candidate of candidates) {
        const found = table.get(candidate)
        if (found) return found
      }
      return null
    }

    // A cached index may be stale; a record found in it is trusted only while
    // its file's stat still matches, and a miss is trusted only briefly.
    if (index) {
      const found = find(index)
      if (found && current(found)) return found
      const missedAt = misses.get(rawName)
      if (!found && missedAt !== undefined && Date.now() - missedAt < MISS_TTL_MS) return null
    }
    const found = find(build())
    if (!found) misses.set(rawName, Date.now())
    return found
  }

  /** The template a component's markup lives in, with its text. */
  const templateOf = (component) => {
    if (component.templateFile) {
      return {
        file: component.templateFile,
        text: fs.readFileSync(component.templateFile, "utf8"),
        offset: 0,
      }
    }
    if (component.inlineTemplate) {
      const text = fs.readFileSync(component.tsFile, "utf8")
      return {
        file: component.tsFile,
        text: text.slice(component.inlineTemplate.start, component.inlineTemplate.end),
        offset: component.inlineTemplate.start,
        whole: text,
      }
    }
    return null
  }

  const relative = (absolute) => {
    const value = path.relative(root, absolute)
    return value.startsWith("..") ? absolute : value
  }

  /**
   * The component and its template text, which is as far as an operation with
   * no reference element needs to get. `locate` is this plus the match.
   */
  const openTemplate = (componentName) => {
    const component = lookup(componentName)
    if (!component) return { ok: false, reason: `no component class named ${componentName}` }
    let template
    try {
      template = templateOf(component)
    } catch (error) {
      return { ok: false, reason: `template unreadable (${error.message})` }
    }
    if (!template) return { ok: false, reason: `${component.componentName} has no template` }
    return { ok: true, component, template }
  }

  const locate = (componentName, descriptor) => {
    const opened = openTemplate(componentName)
    if (!opened.ok) return opened
    const { component, template } = opened

    const node = matchNode(scanTemplate(template.text), descriptor ?? {})
    if (!node) {
      return {
        ok: false,
        component,
        template,
        reason: `no unique <${descriptor?.tagName ?? "?"}> in ${path.basename(template.file)}`,
      }
    }
    const position = lineColumnAt(template.whole ?? template.text, template.offset + node.start)
    return { ok: true, component, template, node, position }
  }

  return {
    /** The component record for a class name the browser read off an instance. */
    component(componentName) {
      const component = lookup(componentName)
      if (!component) return null
      return {
        componentName: component.componentName,
        selector: component.selector,
        tsFile: relative(component.tsFile),
        templateFile: component.templateFile ? relative(component.templateFile) : null,
        styleFile: component.styleFile ? relative(component.styleFile) : null,
      }
    },

    /**
     * Where an element is written: the template file and the line of its start
     * tag, or the component's `.ts` when the element cannot be placed inside it.
     *
     * The degraded answer is deliberate. Naming the component's own file is
     * true and useful — the inspector header, the Code tab and the change
     * prompt all want somewhere to point — while `located: false` is what stops
     * the writer from acting on a position nobody verified.
     */
    resolve(componentName, descriptor) {
      const found = locate(componentName, descriptor)
      if (found.ok) {
        return {
          filePath: relative(found.template.file),
          lineNumber: found.position.lineNumber,
          columnNumber: found.position.columnNumber,
          componentName: found.component.componentName,
          located: true,
        }
      }
      const component = lookup(componentName)
      if (!component) return null
      return {
        filePath: relative(component.templateFile ?? component.tsFile),
        lineNumber: 0,
        columnNumber: 0,
        componentName: component.componentName,
        located: false,
        reason: found.reason,
      }
    },

    /**
     * Writes a batch of operations, grouped by template so each file is read
     * once, spliced once and written once.
     *
     * Partial success is a real outcome and is reported as one: an operation on
     * an element that cannot be placed must not stop the four that can.
     */
    apply(operations) {
      const applied = []
      const failed = []
      /**
       * absolute file -> { source, edits[], reports[], touched, planned }
       *
       * Keyed by FILE rather than by template, which used to be the same thing
       * and stopped being one when insertion arrived: an inserted element needs
       * the component's `.ts` edited as well as its template, and for an inline
       * template those are the same file. Keying on the path is what lets the
       * two sets of splices merge into one write when they land in one file and
       * stay separate when they do not.
       *
       * `touched` is every operation with a splice in this file, while
       * `reports` is only the operations this file answers for — an operation
       * appears in the `touched` of both files it edits and in the `reports` of
       * one, so it is written once and reported once.
       */
      const batches = new Map()

      const batchFor = (file, source) => {
        const existing = batches.get(file)
        if (existing) return existing
        const batch = { source, edits: [], reports: [], touched: new Set(), planned: new Map() }
        batches.set(file, batch)
        return batch
      }

      /** The `.ts` side of an insertion: the import, and the `imports` entry. */
      const wireImport = (operation, component) => {
        const tsFile = component.tsFile
        if (!isEditableSourcePath(config, tsFile)) {
          return { reason: `${relative(tsFile)} is outside the editable roots` }
        }
        let batch = batches.get(tsFile)
        if (!batch) {
          let text
          try {
            text = fs.readFileSync(tsFile, "utf8")
          } catch (error) {
            return { reason: `${relative(tsFile)} is unreadable (${error.message})` }
          }
          batch = batchFor(tsFile, text)
        }
        const plan = standaloneImportEdits(
          batch.source,
          component,
          { ...operation.import, receiving: relative(tsFile) },
          batch.planned
        )
        if (plan.reason) return { reason: plan.reason }
        batch.planned.set(operation.import.name, plan.specifier)
        return { batch, edits: plan.edits }
      }

      for (const operation of operations) {
        // An insertion with no target names the template itself rather than an
        // element in it, so there is nothing to match and nothing to tie.
        const rootInsert = operation.op === "insertElement" && !operation.target
        const found = rootInsert
          ? openTemplate(operation.componentName)
          : locate(operation.componentName, operation.target)
        if (!found.ok) {
          failed.push({ operation, reason: found.reason })
          continue
        }
        const file = found.template.file
        if (!isEditableSourcePath(config, file)) {
          failed.push({ operation, reason: `${relative(file)} is outside the editable roots` })
          continue
        }

        const whole = found.template.whole ?? found.template.text
        const offset = found.template.offset
        const batch = batchFor(file, whole)

        let edits
        try {
          edits = rootInsert
            ? [
                insertionEdit(
                  templateAnchor(found.template.text),
                  operation.position,
                  operation.markup,
                  found.template.text
                ),
              ]
            : editsFor(found.node, operation, found.template.text)
        } catch (error) {
          failed.push({ operation, reason: error.message })
          continue
        }

        let companion = null
        if (operation.op === "insertElement" && operation.import) {
          companion = wireImport(operation, found.component)
          if (companion.reason) {
            // The import is not a follow-up to the markup, it is half of it —
            // so a failure here takes the template splice with it rather than
            // leaving a tag the component cannot resolve.
            failed.push({ operation, reason: companion.reason })
            continue
          }
        }

        // Splices are computed against the template TEXT; an inline template is
        // a window into the `.ts`, so its offsets are rebased before they join
        // a batch that is keyed by, and written as, the whole file.
        for (const edit of edits) {
          batch.edits.push({ start: edit.start + offset, end: edit.end + offset, text: edit.text })
        }
        batch.touched.add(operation)
        batch.reports.push({
          operation,
          filePath: relative(file),
          lineNumber: rootInsert
            ? lineColumnAt(whole, offset + edits[0].start).lineNumber
            : found.position.lineNumber,
        })

        if (companion) {
          for (const edit of companion.edits) companion.batch.edits.push(edit)
          companion.batch.touched.add(operation)
        }
      }

      /** operation -> why its file could not be written. */
      const writeFailures = new Map()

      // Every file is composed before any of them is written. Composition is
      // where an overlap between two splices is caught, and catching it after
      // the first file was already on disk would leave a component half-edited
      // for a reason that was knowable before anything was touched.
      const outputs = []
      for (const [file, batch] of batches) {
        if (!batch.edits.length) continue
        try {
          outputs.push({ file, batch, text: applyEdits(batch.source, batch.edits) })
        } catch (error) {
          for (const operation of batch.touched) writeFailures.set(operation, error.message)
        }
      }
      for (const output of outputs) {
        // A file whose every operation has already failed has nothing left to
        // write: this is the template of an insertion whose import could not be
        // composed, and writing it would produce exactly the unresolvable tag
        // the whole arrangement exists to prevent.
        if ([...output.batch.touched].every((operation) => writeFailures.has(operation))) continue
        try {
          fs.writeFileSync(output.file, output.text, "utf8")
          // Every record in the index carries byte offsets into a `.ts` file —
          // the decorator's range, and an inline template's window. Adding an
          // import moves everything after it, so a cache kept across that write
          // hands the NEXT operation positions that were true a moment ago and
          // splices into the middle of something. Dropping it costs one walk of
          // the project on the next lookup and is the only correct answer.
          if (output.file.endsWith(".ts")) index = null
        } catch (error) {
          for (const operation of output.batch.touched) writeFailures.set(operation, error.message)
        }
      }

      for (const batch of batches.values()) {
        for (const report of batch.reports) {
          const reason = writeFailures.get(report.operation)
          if (reason) {
            failed.push({ operation: report.operation, reason })
            continue
          }
          applied.push({
            op: report.operation.op,
            componentName: report.operation.componentName,
            filePath: report.filePath,
            lineNumber: report.lineNumber,
          })
        }
      }

      return { applied, failed }
    },

    /** Test seam: drops the cached component index. */
    reset() {
      index = null
    },
  }
}
