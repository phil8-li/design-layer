/**
 * The Code tab's generator: a selected element written back out as source.
 *
 * There is no file-read route in this editor, so nothing here opens a file.
 * Every view is derived from the live element, which makes this the one
 * description of it that is never stale — and the only one that includes the
 * edits made since the last "Apply to code".
 *
 * Output is a TOKEN LIST, not a string. The panel needs the code tinted, and
 * tinting a finished string means re-parsing it with regexes — which is how a
 * class value containing `<` or a text node containing a quote ends up
 * mis-coloured. The generator already knows what every character it emits is,
 * so it says so once, here, and the panel only picks a class per token.
 *
 * Deliberately NOT taking a computed style. `getComputedStyle` returns three
 * hundred resolved properties, none of which anyone wrote; the style ATTRIBUTE
 * is the short list the editor put there for the live preview, and that is
 * what belongs in a view of the element's source.
 */

import { config } from "./config"
import type { Selection } from "./types"

/** The five tints `css/code.ts` declares, plus `plain` — indentation and text. */
export type CodeTokenKind = "tag" | "attribute" | "string" | "number" | "punctuation" | "plain"

export interface CodeToken {
  kind: CodeTokenKind
  text: string
}

export type CodeView = "jsx" | "html" | "classes"

/**
 * The three views that are actually derivable here.
 *
 * open-pencil offers design-jsx / tailwind-jsx / html-css because it owns a
 * scene graph and can render it in any dialect. We own a DOM node, so the
 * honest menu is the two dialects that node can be spelled in, plus the one
 * list the editor spends all its time writing: the class attribute.
 */
const REACT_CODE_VIEWS: ReadonlyArray<{ id: CodeView; label: string }> = [
  { id: "jsx", label: "JSX" },
  { id: "html", label: "HTML" },
  { id: "classes", label: "Tailwind classes" },
]

/**
 * An Angular host is offered two, and HTML is first.
 *
 * JSX is not a dialect an Angular element can be spelled in — the tab drew
 * `className=` and `_nghost-ng-c3309602102` for a component whose template says
 * `class=`, which is a view of a file that does not exist. Dropping it also
 * makes HTML the default, because the default is the first entry.
 *
 * The class list survives either way; only its NAME follows Tailwind, which is
 * a different question from the framework and answered separately.
 */
const ANGULAR_CODE_VIEWS: ReadonlyArray<{ id: CodeView; label: string }> = [
  { id: "html", label: "HTML" },
  { id: "classes", label: "Classes" },
]

function codeViews(): ReadonlyArray<{ id: CodeView; label: string }> {
  const views = config.host.framework === "angular" ? ANGULAR_CODE_VIEWS : REACT_CODE_VIEWS
  if (config.host.tailwind) return views
  // Calling the class list "Tailwind classes" in a project with no Tailwind
  // names a technology the designer would then go looking for.
  return views.map((view) => (view.id === "classes" ? { ...view, label: "Classes" } : view))
}

export const CODE_VIEWS: ReadonlyArray<{ id: CodeView; label: string }> = codeViews()

/** How far below the selected element the subtree is spelled out in full. */
const MAX_DEPTH = 3
/** Siblings shown before the rest collapse into a count. */
const MAX_CHILDREN = 8
/** A text node longer than this is an article, not a label. */
const MAX_TEXT = 120

const VOID_TAGS = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(" ")
)

/**
 * The handful of DOM attribute names React spells differently. Anything not
 * listed passes through unchanged, which is also what React does with an
 * attribute it does not recognise.
 */
const JSX_ATTRIBUTES: Record<string, string> = {
  class: "className", for: "htmlFor", tabindex: "tabIndex", readonly: "readOnly",
  maxlength: "maxLength", colspan: "colSpan", rowspan: "rowSpan", srcset: "srcSet",
  autocomplete: "autoComplete", contenteditable: "contentEditable",
}

/**
 * Attributes whose presence IS their value.
 *
 * The distinction matters more in JSX than it looks. `disabled=""` is a falsy
 * string and turns the control back on; bare `disabled` is `true`. Going the
 * other way, `alt=""` says an image is decorative, and bare `alt` says
 * `alt={true}`. So an empty value is dropped only where dropping it is right.
 */
const BOOLEAN_ATTRIBUTES = new Set(
  ("autofocus autoplay checked controls default defer disabled hidden loop multiple muted " +
    "novalidate open playsinline readonly required reversed selected").split(" ")
)

const NUMERIC = /^-?\d+(\.\d+)?$/

function emit(sink: CodeToken[], kind: CodeTokenKind, text: string): void {
  if (text) sink.push({ kind, text })
}

/** The generated source as plain text — what the Copy button puts on the clipboard. */
export function codeText(tokens: readonly CodeToken[]): string {
  return tokens.map((token) => token.text).join("")
}

export function elementCode(selection: Selection, view: CodeView): CodeToken[] {
  const sink: CodeToken[] = []
  if (view === "classes") emitClasses(sink, selection.element.getAttribute("class") ?? "")
  else emitElement(sink, view, selection.element, 0, 0)
  return sink
}

// ── The class list ─────────────────────────────────────────────────────────

/**
 * One class per line: a Tailwind string is a list that happens to be
 * space-separated, and a 260px panel wraps it into an unreadable blob. Source
 * order is kept rather than sorted — the order is what is in the file, and
 * comparing this against the file is the main reason to be looking.
 */
function emitClasses(sink: CodeToken[], className: string): void {
  const classes = className.split(/\s+/).filter(Boolean)
  if (classes.length === 0) {
    emit(sink, "plain", "This element carries no classes.")
    return
  }
  classes.forEach((name, index) => {
    if (index > 0) emit(sink, "plain", "\n")
    emitClass(sink, name)
  })
}

/**
 * A utility split into the parts that mean different things: the variants that
 * gate it (`md:`, `hover:`), the utility, and the value on the end. The value
 * is what you scan for when comparing two elements, so it gets its own colour.
 */
function emitClass(sink: CodeToken[], name: string): void {
  const parts = name.split(":")
  const utility = parts.pop() ?? ""
  for (const variant of parts) {
    emit(sink, "attribute", variant)
    emit(sink, "punctuation", ":")
  }

  // An arbitrary value is already delimited by its brackets, so there is
  // nothing to guess about where the utility ends.
  const arbitrary = /^(.*?)\[(.*)\]$/.exec(utility)
  if (arbitrary) {
    emit(sink, "tag", arbitrary[1])
    emit(sink, "punctuation", "[")
    emit(sink, "string", arbitrary[2])
    emit(sink, "punctuation", "]")
    return
  }

  const split = utility.lastIndexOf("-")
  if (split <= 0) {
    emit(sink, "tag", utility)
    return
  }
  const value = utility.slice(split + 1)
  emit(sink, "tag", utility.slice(0, split))
  emit(sink, "punctuation", "-")
  emit(sink, /^[\d.]+(\/\d+)?$/.test(value) ? "number" : "string", value)
}

// ── Markup ─────────────────────────────────────────────────────────────────

type Child = { text: string } | { element: Element }

/** Elements, and text that is not just the whitespace a formatter left behind. */
function readableChildren(element: Element): Child[] {
  // An icon's paths are coordinate data, not structure. Printing forty numbers
  // under `<svg>` buries the one line — the class attribute — that the person
  // looking at an icon in this panel came here to read.
  if (element.tagName.toLowerCase() === "svg") return []
  const children: Child[] = []
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim()
      if (text) children.push({ text })
    } else if (node.nodeType === 1) {
      children.push({ element: node as Element })
    }
  }
  return children
}

function comment(sink: CodeToken[], view: CodeView, body: string): void {
  emit(sink, "punctuation", view === "jsx" ? `{/* ${body} */}` : `<!-- ${body} -->`)
}

function emitElement(
  sink: CodeToken[], view: CodeView, element: Element, depth: number, indent: number
): void {
  const tag = element.tagName.toLowerCase()
  const pad = "  ".repeat(indent)

  emit(sink, "plain", pad)
  emit(sink, "punctuation", "<")
  emit(sink, "tag", tag)
  emitAttributes(sink, view, element)

  const children = readableChildren(element)

  if (children.length === 0) {
    // JSX has one spelling for an empty element; HTML has two, and using the
    // wrong one on a void tag produces markup a browser silently repairs.
    if (view === "jsx") emit(sink, "punctuation", " />")
    else if (VOID_TAGS.has(tag)) emit(sink, "punctuation", ">")
    else emit(sink, "punctuation", `></${tag}>`)
    return
  }

  emit(sink, "punctuation", ">")

  // A label, a heading, a button: one text node and nothing else. Breaking
  // that across three lines makes the common case the hardest one to read.
  const first = children[0]
  if (children.length === 1 && "text" in first) {
    emit(sink, "plain", truncate(first.text))
    emit(sink, "punctuation", `</${tag}>`)
    return
  }

  emit(sink, "plain", "\n")
  if (depth >= MAX_DEPTH) {
    emit(sink, "plain", `${pad}  `)
    comment(sink, view, `${children.length} ${children.length === 1 ? "child" : "children"}`)
    emit(sink, "plain", "\n")
  } else {
    emitChildren(sink, view, children, depth, indent + 1)
  }
  emit(sink, "plain", pad)
  emit(sink, "punctuation", `</${tag}>`)
}

function emitChildren(
  sink: CodeToken[], view: CodeView, children: Child[], depth: number, indent: number
): void {
  const shown = children.slice(0, MAX_CHILDREN)
  for (const child of shown) {
    if ("text" in child) {
      emit(sink, "plain", `${"  ".repeat(indent)}${truncate(child.text)}\n`)
      continue
    }
    emitElement(sink, view, child.element, depth + 1, indent)
    emit(sink, "plain", "\n")
  }
  const rest = children.length - shown.length
  if (rest > 0) {
    emit(sink, "plain", "  ".repeat(indent))
    comment(sink, view, `${rest} more`)
    emit(sink, "plain", "\n")
  }
}

function truncate(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text
}

/**
 * Attributes the framework stamped on at runtime, which are in the DOM and in
 * no source file.
 *
 * Angular writes `_ngcontent-ng-c3539969218=""` onto every element for style
 * encapsulation and `ng-reflect-*` in dev builds. This view claims to show the
 * element as source, so carrying them makes it a view of the rendered DOM
 * wearing source syntax — and the hash changes on every rebuild, so a designer
 * comparing the panel against their template sees a diff that is not there.
 */
const RUNTIME_ATTRIBUTES = /^(_ng(content|host)-|ng-reflect-|ng-version$)/

function emitAttributes(sink: CodeToken[], view: CodeView, element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.name === "style") continue
    if (RUNTIME_ATTRIBUTES.test(attribute.name)) continue
    emit(sink, "plain", " ")
    emit(sink, "attribute", attributeName(view, attribute.name))
    if (attribute.value === "" && BOOLEAN_ATTRIBUTES.has(attribute.name)) continue
    // Braced when it is a number and we are in JSX, because that is how the
    // prop is actually written in a file and the tint has somewhere to land.
    if (view === "jsx" && NUMERIC.test(attribute.value)) {
      emit(sink, "punctuation", "={")
      emit(sink, "number", attribute.value)
      emit(sink, "punctuation", "}")
      continue
    }
    emit(sink, "punctuation", "=")
    emit(sink, "string", `"${attribute.value}"`)
  }
  emitStyle(sink, view, element)
}

/**
 * The inline style, last, because it is the part the editor itself wrote.
 *
 * Read off `element.style` rather than the raw attribute so the declarations
 * come back parsed and in order, and so a preview write the browser rejected
 * never shows up here as source that would not compile.
 */
function emitStyle(sink: CodeToken[], view: CodeView, element: Element): void {
  const style = (element as HTMLElement).style
  if (!style || style.length === 0) return

  emit(sink, "plain", " ")
  emit(sink, "attribute", "style")

  if (view === "html") {
    emit(sink, "punctuation", "=")
    emit(sink, "string", `"${style.cssText}"`)
    return
  }

  emit(sink, "punctuation", "={{ ")
  for (let index = 0; index < style.length; index += 1) {
    const property = style.item(index)
    if (index > 0) emit(sink, "punctuation", ", ")
    // A custom property has no camelCase spelling, so React takes it as a
    // quoted key. Everything else is the ordinary kebab-to-camel rename.
    emit(sink, "attribute", property.startsWith("--") ? `"${property}"` : camel(property))
    emit(sink, "punctuation", ": ")
    emit(sink, "string", `"${style.getPropertyValue(property).trim()}"`)
  }
  emit(sink, "punctuation", " }}")
}

function camel(property: string): string {
  return property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

function attributeName(view: CodeView, name: string): string {
  if (view === "html") return name
  if (name.startsWith("data-") || name.startsWith("aria-")) return name
  return JSX_ATTRIBUTES[name] ?? name
}
