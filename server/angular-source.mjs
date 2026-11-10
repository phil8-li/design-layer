/**
 * Angular host support: which file an element is written in.
 *
 * This is the Angular half of the one question `src/core/bridge.ts` owns for
 * React — "where is this element authored". There is no fiber, so there is no
 * `_debugSource` and no owner stack: the browser gets the component from
 * Angular's own dev-mode `ng` global (`ng.getOwningComponent`) and sends this
 * module a CLASS NAME. An Angular component's markup is a separate `.html` file
 * (or an inline template string), so resolution is `class name -> @Component
 * decorator -> templateUrl`, and then a START TAG located in that template.
 * Nothing here parses Angular's binding syntax, and nothing here writes: edits
 * are notes for a coding agent, and this answers where the agent should look.
 *
 * What it deliberately will not do is guess. A descriptor that matches two
 * template elements equally well locates nothing, and `resolve` falls back to
 * naming the component's own file with `located: false`.
 */

import fs from "node:fs"
import path from "node:path"

import { matchNode } from "./element-match.mjs"

/**
 * Re-exported because `matchNode` is the Angular lane's own answer to "which
 * template node is this", and every caller and test here has always asked this
 * module for it.
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
 * The range covers the template TEXT only, so an offset into it is an offset
 * into the markup rather than into the quote that delimits it.
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
 * Replacing rather than removing keeps every index this module hands out an
 * index into the file as it sits on disk.
 */
function blankComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (comment) => " ".repeat(comment.length))
}

const START_TAG = /<([a-zA-Z][-\w.:]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
const END_TAG = /<\/([a-zA-Z][-\w.:]*)\s*>/g
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

function parseAttributes(raw) {
  const attributes = new Map()
  ATTRIBUTE.lastIndex = 0
  let match
  while ((match = ATTRIBUTE.exec(raw))) {
    const name = match[1]
    if (!name || name === "/") continue
    attributes.set(name, { name, value: match[2] ?? match[3] ?? match[4] ?? "" })
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
 * siblings, and where it starts.
 *
 * A hand-rolled scanner rather than a real parser on purpose. An Angular
 * template is not HTML — `@if`/`@for` blocks, `*ngFor`, `{{ }}` interpolation
 * and `[attr]` bindings all appear inside it — and every HTML parser worth
 * using normalises exactly the offsets a line number is counted from.
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
    tokens.push({ kind: "end", index: match.index, name: match[1].toLowerCase() })
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
          stack.length = depth
          counters.length = depth + 1
          break
        }
      }
      continue
    }

    const [whole, rawName, rawAttributes, selfClosing] = token.match
    const tagName = rawName.toLowerCase()
    const attributes = parseAttributes(rawAttributes)
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
      selfClosing: Boolean(selfClosing) || VOID_ELEMENTS.has(tagName),
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
   * not the project's — a button from an installed component library —
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
   * `inlineTemplate` is a byte range into the file as it was scanned, and
   * `resolve` reads the template text out of the file as it is NOW. An edit
   * from the IDE or an agent — one line added above `@Component` — would leave
   * the index pointing a line early and every inline-template line number off
   * by one. A stat per lookup is what catches that before any offset is used.
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
     * true and useful — the inspector header and the agent's brief both want
     * somewhere to point — while `located: false` says the line is not a
     * position anybody verified.
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

    /** Test seam: drops the cached component index. */
    reset() {
      index = null
    },
  }
}
