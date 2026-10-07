/**
 * How the brief names and locates an element, in Agentation's vocabulary.
 *
 * The brief is written in Agentation's `## Page Feedback` format, so a note
 * left with either tool reaches the agent in the same shape. That format leans
 * on short human descriptions — `button "Save"`, `paragraph: "…"`,
 * `.card > .card-title` — and this module is where DesignLayer produces them.
 *
 * It is written here rather than imported. Agentation is PolyForm Shield and
 * loads as a companion from outside this MIT repository; what is shared is the
 * shape of the text, not the code that makes it.
 *
 * Everything here is synchronous and reads only the element and its immediate
 * family — never computed styles — because the journal calls it inside a write.
 */

const XHTML = "http://www.w3.org/1999/xhtml"

/** Parts of a drawing, named after the thing they draw inside. */
const SVG_PARTS = new Set(["path", "circle", "rect", "line", "g", "ellipse", "polygon", "polyline", "use"])

/** Boxes with no meaning of their own, named from their label, role, text or class. */
const CONTAINERS = new Set(["div", "section", "article", "nav", "header", "footer", "aside", "main"])

/**
 * Attributes a test suite or a design system put there to be found by.
 *
 * Printed in the location because they are the most stable handle an element
 * has: a class is restyled, a `data-testid` is a contract.
 */
const IDENTIFYING_ATTRIBUTES = ["data-testid", "data-test", "data-qa", "data-cy", "data-component"]

/** Levels in `**Location:**` — enough to find the element, short enough to read. */
const LOCATION_DEPTH = 4

/** Whitespace collapsed, so a heading split over three lines of JSX reads as one line. */
function textOf(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim()
}

/** Only the element's own text nodes: a card's name, not every word inside it. */
function ownText(element: Element): string {
  return Array.from(element.childNodes)
    .filter((child) => child.nodeType === 3)
    .map((child) => (child.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
}

/** Up the tree, stepping out of a shadow root onto its host. */
function parentOf(element: Element): Element | null {
  if (element.parentElement) return element.parentElement
  const root = element.getRootNode()
  return typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot ? root.host : null
}

function classNames(element: Element): string[] {
  return (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)
}

/**
 * `Card_title__x1Y2z` → `Card_title`.
 *
 * A CSS-module class ends in a build hash that changes whenever the file does.
 * The hash is only stripped when it looks like one — it has a digit or a capital
 * in it — so BEM's `card__title` keeps its element name.
 */
export function withoutModuleHash(name: string): string {
  const match = /^(.+?)_+([A-Za-z0-9]{5,})$/.exec(name)
  return match && /[0-9A-Z]/.test(match[2]) ? match[1] : name
}

/**
 * A class a person would recognise: not a one- or two-letter utility, not an
 * Angular view-state class that is gone after the next change detection, and
 * not a generated CSS-in-JS name.
 */
function isReadableClass(name: string): boolean {
  if (name.length <= 2 || name.startsWith("ng-")) return false
  if (/^css-[a-z0-9]+$/.test(name)) return false
  return !/[A-Z0-9]{5,}/.test(name)
}

function readableClass(element: Element): string | null {
  const name = classNames(element).find(isReadableClass)
  return name ? withoutModuleHash(name) : null
}

function quoteAttribute(value: string): string {
  return value.replace(/["\\]/g, "\\$&").replace(/[\r\n]+/g, " ")
}

function identifyingAttributes(element: Element): string {
  return IDENTIFYING_ATTRIBUTES.flatMap((name) => {
    const value = element.getAttribute(name)
    return value && value.length <= 120 ? [`[${name}="${quoteAttribute(value)}"]`] : []
  })
    .slice(0, 2)
    .join("")
}

/** `"Save"`, capped, with no ellipsis — the label is a handle, not a quotation. */
function quoted(text: string, max: number): string {
  return `"${text.slice(0, max)}"`
}

/**
 * The words in a class list, for a box that has nothing better to be called.
 *
 * `lt-empty-icon` reads as "empty icon": split on the separators, drop the
 * short prefixes and utilities, keep two words.
 */
function classWords(element: Element): string {
  return classNames(element)
    .flatMap((name) => withoutModuleHash(name).split(/[_-]+/))
    .filter((word) => word.length > 2 && !/[A-Z0-9]{5,}/.test(word))
    .slice(0, 2)
    .join(" ")
}

function containerName(element: Element, tag: string): string {
  const label = element.getAttribute("aria-label")
  if (label) return `${tag} [${label}]`
  const role = element.getAttribute("role")
  if (role) return role
  const own = ownText(element)
  if (own && own.length < 50) return `"${own}"`
  return classWords(element) || (tag === "div" ? "container" : tag)
}

/**
 * What the element is, in a few words: `button "Save"`, `paragraph: "…"`,
 * `icon in "Delete" button`, `empty icon`.
 *
 * This is the heading of every item in the brief. A `data-element` attribute
 * wins outright, because it is the host naming its own element on purpose.
 */
export function elementName(element: Element): string {
  const declared = element.getAttribute("data-element")
  if (declared) return declared

  const tag = element.tagName.toLowerCase()

  if (SVG_PARTS.has(tag)) {
    const svg = element.closest("svg")
    const host = svg ? parentOf(svg) : null
    return host && host.namespaceURI === XHTML ? `graphic in ${elementName(host)}` : "graphic element"
  }
  if (CONTAINERS.has(tag)) return containerName(element, tag)

  const text = textOf(element)
  switch (tag) {
    case "svg": {
      const parent = parentOf(element)
      if (parent?.tagName.toLowerCase() !== "button") return "icon"
      const label = textOf(parent)
      return label ? `icon in "${label}" button` : "button icon"
    }
    case "button": {
      const label = element.getAttribute("aria-label")
      if (label) return `button [${label}]`
      return text ? `button ${quoted(text, 25)}` : "button"
    }
    case "a": {
      if (text) return `link ${quoted(text, 25)}`
      const href = element.getAttribute("href")
      return href ? `link to ${href.slice(0, 30)}` : "link"
    }
    case "input": {
      const placeholder = element.getAttribute("placeholder")
      if (placeholder) return `input "${placeholder}"`
      const name = element.getAttribute("name")
      if (name) return `input [${name}]`
      return `${element.getAttribute("type") || "text"} input`
    }
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return text ? `${tag} ${quoted(text, 35)}` : tag
    case "p":
      if (!text) return "paragraph"
      return `paragraph: "${text.slice(0, 40)}${text.length > 40 ? "..." : ""}"`
    case "span":
    case "label":
      return text && text.length < 40 ? `"${text}"` : tag
    case "li":
      return text && text.length < 40 ? `list item: ${quoted(text, 35)}` : "list item"
    case "code":
      return text && text.length < 30 ? `code: \`${text}\`` : "code"
    case "pre":
      return "code block"
    case "img": {
      const alt = element.getAttribute("alt")
      return alt ? `image ${quoted(alt, 30)}` : "image"
    }
    default:
      return tag
  }
}

/**
 * `.lt-page[data-testid="live-translate"] > .lt-conversation > .lt-empty-title`
 *
 * The brief's `**Location:**`: four levels, each named by its id, its first
 * readable class or its tag. It is for a person scanning the brief and an agent
 * grepping the source, not for `querySelector` — `AnnotationTarget.selector` is
 * the one that resolves.
 */
export function locationPath(element: Element): string {
  const parts: string[] = []
  let node: Element | null = element
  while (node && parts.length < LOCATION_DEPTH) {
    const tag = node.tagName.toLowerCase()
    if (tag === "html" || tag === "body") {
      if (!parts.length) parts.push(tag)
      break
    }
    const id = node.getAttribute("id")
    const cls = id ? null : readableClass(node)
    let part = (id ? `#${id}` : cls ? `.${cls}` : tag) + identifyingAttributes(node)
    const parent = parentOf(node)
    if (!node.parentElement && parent) part = `⟨shadow⟩ ${part}`
    parts.unshift(part)
    node = parent
  }
  return parts.join(" > ")
}

/** Every level from `<body>` down, `tag.class` or `tag#id` each. Forensic only. */
export function fullDomPath(element: Element): string {
  const parts: string[] = []
  let node: Element | null = element
  while (node && node.tagName.toLowerCase() !== "html") {
    const tag = node.tagName.toLowerCase()
    const id = node.getAttribute("id")
    const cls = classNames(node).map(withoutModuleHash).find((name) => name.length > 2)
    let part = id ? `${tag}#${id}` : cls ? `${tag}.${cls}` : tag
    const parent = parentOf(node)
    if (!node.parentElement && parent) part = `⟨shadow⟩ ${part}`
    parts.unshift(part)
    node = parent
  }
  return parts.join(" > ")
}

/** `btn, px-4` — the class attribute, de-hashed and de-duplicated, comma-separated. */
export function classSummary(className: string): string {
  const names = className.split(/\s+/).filter(Boolean).map(withoutModuleHash)
  return [...new Set(names)].join(", ")
}

/**
 * The words on and around the element: its own text when it is short, and the
 * text of the siblings either side, so "the second price" can be told from the
 * first.
 */
export function nearbyText(element: Element): string {
  const parts: string[] = []
  const own = textOf(element)
  if (own && own.length < 100) parts.push(own)
  const before = element.previousElementSibling ? textOf(element.previousElementSibling) : ""
  if (before && before.length < 50) parts.unshift(`[before: "${before.slice(0, 40)}"]`)
  const after = element.nextElementSibling ? textOf(element.nextElementSibling) : ""
  if (after && after.length < 50) parts.push(`[after: "${after.slice(0, 40)}"]`)
  return parts.join(" ")
}

function siblingLabel(element: Element): string {
  const tag = element.tagName.toLowerCase()
  const cls = classNames(element)
    .map(withoutModuleHash)
    .find((name) => name.length > 2 && !/^[a-z]{1,2}$/.test(name))
  const base = `${tag}${cls ? `.${cls}` : ""}`
  if (tag !== "button" && tag !== "a") return base
  const text = textOf(element).slice(0, 15)
  return text ? `${base} "${text}"` : base
}

/** `button.btn "Cancel", span.tag (5 total in .row)` — what sits beside it. */
export function nearbyElements(element: Element): string {
  const parent = parentOf(element)
  if (!parent) return ""
  const siblings = Array.from((element.parentElement ?? parent).children).filter(
    (child) => child !== element && child.namespaceURI === XHTML
  )
  if (!siblings.length) return ""
  const shown = siblings.slice(0, 4).map(siblingLabel)
  const total = parent.children.length
  const parentCls = classNames(parent)
    .map(withoutModuleHash)
    .find((name) => name.length > 2 && !/^[a-z]{1,2}$/.test(name))
  const parentLabel = parentCls ? `.${parentCls}` : parent.tagName.toLowerCase()
  return shown.join(", ") + (total > shown.length + 1 ? ` (${total} total in ${parentLabel})` : "")
}

/** `role="tab", aria-label="Close", focusable` — what assistive technology is told. */
export function accessibilitySummary(element: Element): string {
  const parts: string[] = []
  const role = element.getAttribute("role")
  const label = element.getAttribute("aria-label")
  const describedBy = element.getAttribute("aria-describedby")
  const tabIndex = element.getAttribute("tabindex")
  if (role) parts.push(`role="${role}"`)
  if (label) parts.push(`aria-label="${label}"`)
  if (describedBy) parts.push(`aria-describedby="${describedBy}"`)
  if (tabIndex) parts.push(`tabindex=${tabIndex}`)
  if (element.getAttribute("aria-hidden") === "true") parts.push("aria-hidden")
  try {
    if (element.matches("a, button, input, select, textarea, [tabindex]")) parts.push("focusable")
  } catch {
    // `matches` on a node from a document with no selector engine. Nothing to add.
  }
  return parts.join(", ")
}
