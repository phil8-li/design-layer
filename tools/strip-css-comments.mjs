/**
 * CSS prose comments, stripped from the stylesheets at bundle time.
 *
 * An esbuild plugin for `build.mjs`. The chrome's stylesheets are TypeScript
 * template literals (`src/core/css/*.ts`), and they are commented the way the
 * rest of this codebase is — at length, inside the CSS, where the rule they
 * explain sits. That is the right place to read them and the wrong thing to
 * ship: about 70% of `shellCss` was comment text, which every page load parsed
 * as a JS string, copied into a `<style>`, and had the CSS parser skip again.
 * Removing it took 370KB off the bundle and a third off the stylesheet insert.
 *
 * Only TEMPLATE-LITERAL TEXT is touched. A small scanner walks the TypeScript
 * and tracks where it is — code, a string, a regex, a JS comment, template text
 * or a `${…}` inside one — so a `/*` in any of those is left alone, and the
 * code in an interpolation is never rewritten. Within template text a comment
 * is removed exactly, with nothing else around it changed, so the runtime CSS
 * is the old CSS minus its comments.
 *
 * Exact in the spirit of `tools/sonner-plugin.mjs`: if any `/*` or `*\/` is
 * still in template text afterwards — a comment spanning an interpolation, an
 * unterminated one, a stray closer — the build stops rather than shipping a
 * stylesheet whose comment state nobody checked.
 *
 * The test suites bundle `src/` with their own esbuild calls and so still see
 * the comments; nothing they assert depends on either form.
 */

import fs from "node:fs"

/** Which files carry stylesheets as template literals. */
export const CSS_SOURCES = /[\\/]src[\\/]core[\\/]css[\\/][^\\/]+\.ts$/

// After one of these (or at the start), a `/` begins a regex, not a division.
const REGEX_AFTER = new Set("(,=:[!&|?{};+-*%<>~^".split(""))
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)$/

/**
 * Splits TypeScript source into code and template-text segments.
 * Returns `[{ text, template, path }]` whose concatenation is the input;
 * `path` lists the ids of the template literals the segment sits inside,
 * innermost last (for template text, its own literal is the last).
 */
export function segments(source, file = "<source>") {
  const out = []
  let start = 0
  let i = 0
  const n = source.length
  // One entry per open template: its id, and the `{` depth of the code inside
  // its current `${`, so the matching `}` can be told from an object literal's.
  const templates = []
  let depth = 0
  let ids = 0

  const flush = (end, template) => {
    if (end > start) out.push({ text: source.slice(start, end), template, path: templates.map((t) => t.id) })
    start = end
  }
  const fail = (message) => {
    throw new Error(`strip-css-comments: ${message} in ${file} at offset ${i}`)
  }

  // Template text: from just after "`" or "}" of an interpolation.
  const scanTemplate = () => {
    while (i < n) {
      const c = source[i]
      if (c === "\\") {
        i += 2
        continue
      }
      if (c === "`") {
        flush(i, true)
        i += 1
        templates.pop()
        return
      }
      if (c === "$" && source[i + 1] === "{") {
        flush(i, true)
        i += 2
        templates[templates.length - 1].depth = depth
        depth += 1
        return
      }
      i += 1
    }
    fail("unterminated template literal")
  }

  while (i < n) {
    const c = source[i]
    const next = source[i + 1]
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i)
      i = end === -1 ? n : end
      continue
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2)
      if (end === -1) fail("unterminated block comment")
      i = end + 2
      continue
    }
    if (c === "'" || c === '"') {
      i += 1
      while (i < n && source[i] !== c) {
        if (source[i] === "\\") i += 1
        else if (source[i] === "\n") fail("unterminated string")
        i += 1
      }
      i += 1
      continue
    }
    if (c === "/") {
      const before = source.slice(Math.max(0, i - 12), i).trimEnd()
      const prev = before.slice(-1)
      if (!prev || REGEX_AFTER.has(prev) || REGEX_KEYWORDS.test(before)) {
        i += 1
        let inClass = false
        while (i < n) {
          const r = source[i]
          if (r === "\\") i += 1
          else if (r === "[") inClass = true
          else if (r === "]") inClass = false
          else if (r === "/" && !inClass) break
          else if (r === "\n") fail("unterminated regex")
          i += 1
        }
        i += 1
        while (/[a-z]/.test(source[i] ?? "")) i += 1
        continue
      }
    }
    if (c === "`") {
      i += 1
      flush(i, false)
      templates.push({ id: ids++, depth: -1 })
      scanTemplate()
      continue
    }
    if (c === "{") depth += 1
    else if (c === "}") {
      depth -= 1
      if (templates.length && templates[templates.length - 1].depth === depth) {
        i += 1
        flush(i, false)
        scanTemplate()
        continue
      }
    }
    i += 1
  }
  if (templates.length) fail("unterminated template literal")
  flush(n, false)
  return out
}

/**
 * The source with every CSS comment in template text removed. Throws on leftovers.
 *
 * A comment may quote a value through an interpolation ("a ${SIZE}px circle"),
 * so one can open in one text segment and close several later. Everything
 * between — the interpolations included — is part of the comment and goes
 * with it; those are token reads with no side effects, and what they produced
 * was only ever comment text.
 */
export function stripCssComments(source, file) {
  const open = new Set()
  const fail = (text) => {
    throw new Error(
      `strip-css-comments: a CSS comment in ${file} is unterminated or malformed — ` +
        `near: ${JSON.stringify(text.slice(Math.max(0, text.search(/\/\*|\*\//) - 40)).slice(0, 120))}`
    )
  }
  const out = segments(source, file).map(({ text, template, path }) => {
    const self = template ? path[path.length - 1] : null
    if (path.some((id) => id !== self && open.has(id))) return ""
    if (!template) return text
    let rest = text
    if (open.has(self)) {
      const end = rest.indexOf("*/")
      if (end === -1) return ""
      rest = rest.slice(end + 2)
      open.delete(self)
    }
    rest = rest.replace(/\/\*[\s\S]*?\*\//g, "")
    const unclosed = rest.indexOf("/*")
    if (unclosed !== -1) {
      open.add(self)
      rest = rest.slice(0, unclosed)
    }
    if (rest.includes("/*") || rest.includes("*/")) fail(rest)
    return rest
  })
  // A comment still open here ran to the end of its template literal.
  if (open.size) fail(source.slice(source.lastIndexOf("/*")))
  return out.join("")
}

export const stripCss = {
  name: "strip-css-comments",
  setup(build) {
    build.onLoad({ filter: CSS_SOURCES }, (args) => ({
      contents: stripCssComments(fs.readFileSync(args.path, "utf8"), args.path),
      loader: "ts",
    }))
  },
}
