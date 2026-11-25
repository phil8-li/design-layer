/**
 * THE CANVAS IS THE APP'S VIEWPORT.
 *
 * `shell.ts` insets the app with padding on a border-box `<html>`, and for an
 * app laid out in percentages that is the whole story: the containing block
 * narrows, the app reflows, both panels behave the same way.
 *
 * An app laid out in VIEWPORT UNITS never hears about it. `100vw` is the
 * window, and the window does not change when a panel opens — so a shell with
 * `width: 100vw` stayed 1440px wide inside a 940px containing block and simply
 * overflowed. The asymmetry that gets reported is the giveaway: padding on the
 * LEFT moves the app's origin, so the left panel looks like it works, while
 * padding on the right has nothing to push against and the app runs on
 * underneath the inspector. Measured exactly that way on a real prototype —
 * `.app-shell { width: calc(100vw - …) }`, right edge at 1680px on a 1440px
 * window with the inspector open.
 *
 * MEDIA QUERIES are the same claim in the other direction, and leaving them out
 * makes "responsive" a half-truth. An app whose canvas is 940px wide should be
 * wearing its 940px layout; asking the window means it wears the 1440px one,
 * squeezed — which is not a width the designer can ever ship. So a width
 * feature is shifted by the inset: `(max-width: 1024px)` matches when the
 * CANVAS is under 1024, which is when the window is under 1024 plus whatever
 * the panels are holding.
 *
 * FIXED LAYERS are the third half-truth. Padding on `<html>` narrows the
 * containing block of everything in flow, but a `position: fixed` element is
 * laid out against the window, so the app's drawers, toasts and floating
 * panels kept the window's edges. Measured on two prototypes: a drawer at
 * `right: 0` ran 260px under the inspector, and a tuner at
 * `inset-inline-start: 16px` sat under the layers panel.
 *
 * So every rule that declares `position` gets three companions beside it: how
 * far the element's left edge moves, how far its right edge moves, and one
 * percent of what the panels hold. A `fixed` value sets them from the insets;
 * any other value sets them to zero. Because they sit in the same rule, the
 * cascade that picks an element's `position` picks its companions too, and a
 * `fixed md:static` element moves at one width and not at the other. Every
 * `left`, `right` and `inset-inline-*` then adds its side's companion, and a
 * percentage in an offset or a width gives up its share of the panels, so a
 * fixed layer's `50%` is half the canvas, not half the window.
 *
 * The companions are registered as NON-INHERITING. Inherited, a drawer's
 * children would take its values: every `100%` inside it would shrink and
 * every `right: 0` would move a second time. A browser that cannot register
 * them gets no fixed-layer rewrite at all, which is what every fixed layer
 * had before.
 *
 * ## What this does not reach
 *
 * Inline `style` attributes, stylesheets from another origin (their rules are
 * unreadable by definition), rules a library inserts straight into the CSSOM
 * after the last scan, `vmin`/`vmax` (they mix an axis this does not move),
 * and `matchMedia` in the app's own JavaScript, which reports the window and
 * would need its listeners re-fired to say anything else. Each of those is a
 * layout the editor leaves as the window drew it, which is what it did for
 * everything before this file existed.
 *
 * Fixed layers have three more. An offset in an inline `style` stays on the
 * window ON PURPOSE: a menu or a hover card a script placed under its button
 * was placed from measured window coordinates, and is already in the right
 * place. A fixed element inside an ancestor that captures fixed descendants
 * (a transform, a filter, containment) is laid out against that ancestor,
 * which already sits in the canvas, so the shift moves it twice. And logical
 * offsets are read left to right. Angular CDK's overlay container is excluded
 * by name, with the app's own top layer handled in `css/base.ts`.
 *
 * ## Why the CSSOM rather than the source
 *
 * Nothing here touches a file. The rewrite is a live edit of the rules the
 * browser already parsed, undone in full by `destroy()`, and no lane in this
 * editor reads the app's CSSOM — so a rewritten value cannot travel back into
 * anyone's stylesheet on a source write.
 */

import { forgetNormalizedCssValues } from "../core/design-system"
import { appInsets, onInsetsChange } from "./shell"

/** 1% of the canvas width. Declared by `css/base.ts`; see the note there. */
const CANVAS_VW = "--de-vw"

/**
 * `vw` and the flavours of it an app may have reached for.
 *
 * `dvw`/`svw`/`lvw` differ from `vw` only where a mobile browser's toolbars
 * come and go, and `vi` is the same measure named after the inline axis. All
 * four are "one percent of the width the app has", which is the thing this file
 * is redefining, so all four are rewritten.
 */
const WIDTH_UNIT = /(?<![\w.-])(-?\d*\.?\d+)(?:[dsl]?v(?:w|i))\b/gi

/*
 * The parts of a value that are not lengths: a `url(...)` and a quoted
 * string. `hero-2vw.png` in a path or "Version 2vi" in `content` are text,
 * and rewriting them broke the image or changed the words while the editor
 * was mounted. The lookbehind on `WIDTH_UNIT` keeps `hero-2vw` out of a bare
 * identifier too, so its `-` is never read as a minus sign.
 */
const NOT_A_LENGTH = /url\([^)]*\)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gi

/** `value` with every width length pointed at the canvas, text left alone. Test seam. */
export function rewriteWidthUnits(value: string): string {
  let out = ""
  let last = 0
  const rewrite = (part: string) =>
    part.replace(WIDTH_UNIT, (_, size: string) => `calc(var(${CANVAS_VW}, 1vw) * ${size})`)
  for (const skip of value.matchAll(NOT_A_LENGTH)) {
    out += rewrite(value.slice(last, skip.index)) + skip[0]
    last = (skip.index ?? 0) + skip[0].length
  }
  return out + rewrite(value.slice(last))
}

/**
 * The same question asked without state.
 *
 * `WIDTH_UNIT` is global, so `test` leaves `lastIndex` wherever it stopped and
 * the next call resumes from there — a per-declaration guard written with it
 * would answer "no" every second time it was asked.
 */
const HAS_WIDTH_UNIT = /\d(?:[dsl]?v(?:w|i))\b/i

/**
 * A width media feature whose value is a single number, with the unit captured.
 *
 * Deliberately refuses anything more complicated. A value that is already a
 * `calc()`, a `var()` or a keyword is left exactly as the author wrote it,
 * because a query this rewrites into something the parser rejects does not fail
 * loudly — it becomes `not all` and silently takes a whole block of the app's
 * styles with it. Simple lengths are what real stylesheets are written in, and
 * they are the ones that can be shifted with confidence.
 *
 * `device-width` cannot match: the feature name has to start at a boundary that
 * is not a hyphen, and that is what the leading group pins.
 */
const WIDTH_FEATURE =
  /(^|[\s(,])((?:min-|max-)?width)(\s*:\s*)(-?\d*\.?\d+)(px|rem|em|ch|ex|pt|pc|in|cm|mm|q)?(?=\s*[),]|\s*$)/gi

/**
 * `width <= 600px`, and the mirrored `600px <= width` of range syntax.
 *
 * Both spell "not part of a longer identifier" with a captured leading or
 * trailing character rather than with a lookbehind. Lookbehind is the shorter
 * way to say it and this bundle cannot use it: the build targets Safari 16,
 * which did not support the syntax until 16.4, and an unsupported regex LITERAL
 * is a parse error — it would take the whole editor down on that browser rather
 * than degrading one rewrite.
 */
const RANGE_AFTER =
  /([^-\w]|^)(width)(\s*(?:<=|>=|<|>|=)\s*)(-?\d*\.?\d+)(px|rem|em|ch|ex|pt|pc|in|cm|mm|q)?\b/gi
const RANGE_BEFORE =
  /(-?\d*\.?\d+)(px|rem|em|ch|ex|pt|pc|in|cm|mm|q)?(\s*(?:<=|>=|<|>|=)\s*)(width)(?![-\w])/gi

/*
 * The companions a fixed layer reads. Each says how far this element moves,
 * so each is zero on every element whose winning `position` is not `fixed`.
 */
const FIXED_LEFT = "--de-fixed-left"
const FIXED_RIGHT = "--de-fixed-right"
/** One percent of what the panels hold, both sides together. */
const FIXED_HELD = "--de-fixed-held"

const COMPANIONS_FIXED: ReadonlyArray<readonly [string, string]> = [
  [FIXED_LEFT, "var(--de-left, 0px)"],
  [FIXED_RIGHT, "var(--de-right, 0px)"],
  [FIXED_HELD, "calc((var(--de-left, 0px) + var(--de-right, 0px)) / 100)"],
]
const COMPANIONS_NOT_FIXED: ReadonlyArray<readonly [string, string]> = [
  [FIXED_LEFT, "0px"],
  [FIXED_RIGHT, "0px"],
  [FIXED_HELD, "0px"],
]

/** The offsets a fixed layer is moved by, and the side each one measures from. */
const FIXED_OFFSETS: ReadonlyArray<readonly [string, "left" | "right"]> = [
  ["left", "left"],
  ["right", "right"],
  ["inset-inline-start", "left"],
  ["inset-inline-end", "right"],
]

/** The sizes whose percentages are of the containing block's width. */
const FIXED_WIDTHS = ["width", "min-width", "max-width", "inline-size", "min-inline-size", "max-inline-size"]

/** The shorthands the offsets can hide in, and which of their parts is each side. */
const FIXED_SHORTHANDS: ReadonlyArray<{
  shorthand: string
  left: string
  right: string
  sides: (parts: string[]) => [string, string]
}> = [
  {
    // Top, right, bottom, left, with the CSS fallbacks for one to three parts.
    shorthand: "inset",
    left: "left",
    right: "right",
    sides: (parts) => [parts[3] ?? parts[1] ?? parts[0], parts[1] ?? parts[0]],
  },
  {
    shorthand: "inset-inline",
    left: "inset-inline-start",
    right: "inset-inline-end",
    sides: (parts) => [parts[0], parts[1] ?? parts[0]],
  },
]

/** A rule that may hold one of the above. `border-left` and `--left` do not match. */
const FIXED_PROPERTY =
  /(?:^|[;\s])(?:position|left|right|inset-inline[a-z-]*|inset|(?:min-|max-)?(?:width|inline-size))\s*:/i

/** Functions a length may be written with that are still a length inside `calc()`. */
const LENGTH_FUNCTIONS = new Set(["calc", "min", "max", "clamp", "var", "env", "round", "mod", "rem", "abs", "sign"])

/**
 * Whether `value` is a length this file may add to.
 *
 * Not a keyword: `auto` is the element's static position, which the padding
 * already put in the canvas. Not `anchor()` or any other function that is not
 * a length: an anchored offset already measures from the right box, and
 * `fit-content(50%)` inside a `calc()` is invalid. And not a value that names
 * the editor's own variables: a companion that docks itself with
 * `--de-bar-right`, or a host that reads the docked-panel offset, has made
 * room once already. That last test is also what keeps a second pass from
 * wrapping its own output.
 */
function movable(value: string): boolean {
  const text = value.trim()
  if (!text || /^[a-z-]+$/i.test(text)) return false
  if (/--de-|--designlayer-/i.test(text)) return false
  for (const [, name] of text.matchAll(/([\w-]+)\(/g)) {
    if (!LENGTH_FUNCTIONS.has(name.toLowerCase())) return false
  }
  return true
}

/** A percentage, with the character before it captured rather than looked behind (see `RANGE_AFTER`). */
const PERCENTAGE = /(^|[^\w.%-])(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)%/gi

/**
 * Every percentage in `value` taken of the canvas, as a fixed layer reads it.
 *
 * A fixed element's `50%` is half its containing block, the window less any
 * scrollbar. Taking 50 of `--de-fixed-held` away leaves half of what the
 * panels leave, whatever the scrollbar is. On any other element the companion
 * is zero and the percentage is the author's.
 */
function ofCanvas(value: string): string {
  return value.replace(
    PERCENTAGE,
    (_, lead: string, size: string) => `${lead}(${size}% - var(${FIXED_HELD}, 0px) * ${size})`
  )
}

/** A fixed layer's offset, measured from the canvas edge on `side`. Null when there is no length to move. Test seam. */
export function rewriteFixedOffset(value: string, side: "left" | "right"): string | null {
  if (!movable(value)) return null
  return `calc(${ofCanvas(value)} + var(${side === "left" ? FIXED_LEFT : FIXED_RIGHT}, 0px))`
}

/** A fixed layer's width, with each percentage taken of the canvas. Null when it holds none. Test seam. */
export function rewriteFixedWidth(value: string): string | null {
  if (!value.includes("%") || !movable(value)) return null
  return `calc(${ofCanvas(value)})`
}

/** `value` split at top-level spaces, so `calc(var(--spacing) * 2) 0px` is two parts. */
function topLevelParts(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let part = ""
  for (const char of value.trim()) {
    if (char === "(") depth += 1
    else if (char === ")") depth -= 1
    if (depth === 0 && /\s/.test(char)) {
      if (part) parts.push(part)
      part = ""
    } else {
      part += char
    }
  }
  if (part) parts.push(part)
  return parts
}

/**
 * Registers the companions, and says whether fixed layers can be moved here.
 *
 * `false` turns the whole fixed-layer rewrite off; see the note at the top on
 * why an inheriting companion is worse than none. A registration that already
 * exists is this editor's own, from an earlier mount on the same document.
 */
function registerFixedCompanions(): boolean {
  const css = (globalThis as { CSS?: { registerProperty?: (definition: PropertyDefinition) => void } }).CSS
  if (typeof css?.registerProperty !== "function") return false
  for (const name of [FIXED_LEFT, FIXED_RIGHT, FIXED_HELD]) {
    try {
      css.registerProperty({ name, syntax: "<length>", inherits: false, initialValue: "0px" })
    } catch (error) {
      if ((error as Error | null)?.name !== "InvalidModificationError") return false
    }
  }
  return true
}

/**
 * A declaration we rewrote or added, and what it said before we did. An empty
 * `value` is a declaration we added: `setProperty` with an empty value removes
 * it. `sheet` is the document-level sheet it came from, so a patch can be
 * dropped once an HMR update has replaced that sheet and the declaration is
 * garbage.
 */
interface DeclarationPatch {
  sheet: CSSStyleSheet
  style: CSSStyleDeclaration
  property: string
  value: string
  priority: string
}

/** A media rule we may shift, and the condition its author wrote. */
interface QueryPatch {
  sheet: CSSStyleSheet
  media: MediaList
  original: string
}

interface AppViewport {
  /**
   * Re-read the app's stylesheets. Called for you when one arrives or changes;
   * exposed because a test should not have to wait for a MutationObserver.
   */
  rescan(): void
  /** Put every rule back the way its author wrote it. */
  destroy(): void
}

/**
 * Ours, and therefore not to be rewritten.
 *
 * The chrome's own sheet uses `100vw` on purpose — the toolbar centres on the
 * WINDOW and clamps itself against the panels by hand (`css/toolbar.ts`), so
 * redefining its `vw` to the canvas would be a circular definition of where the
 * bar goes. Every stylesheet this package injects is either stamped by `el()`
 * or carries an id in the same namespace, and both are checked because two of
 * them are built with `createElement` rather than `el`.
 */
function isOurs(sheet: CSSStyleSheet): boolean {
  return isOurNode(sheet.ownerNode)
}

function isOurNode(node: Node | null): boolean {
  if (!(node instanceof Element)) return false
  return node.hasAttribute("data-designlayer") || node.id.startsWith("designlayer")
}

/** A sheet `document.styleSheets` no longer holds: removed, or replaced by a reparse. */
function isDetached(sheet: CSSStyleSheet): boolean {
  return !sheet.ownerNode || !sheet.ownerNode.isConnected
}

/** The app's own sheets, including any reachable through an `@import`. */
function appRules(sheet: CSSStyleSheet): CSSRuleList | null {
  if (isOurs(sheet)) return null
  try {
    return sheet.cssRules
    /*
     * A cross-origin sheet throws here rather than returning nothing, and that
     * is the end of it: its rules are unreadable, so an app sized in `vw` by a
     * stylesheet it loaded from a CDN keeps the window's idea of its width.
     */
  } catch {
    return null
  }
}

export function installAppViewport(): AppViewport {
  const declarations: DeclarationPatch[] = []
  const queries: QueryPatch[] = []
  const fixedLayers = registerFixedCompanions()
  /*
   * Which media rules have been collected already.
   *
   * A rescan walks sheets it has walked before — that is the cheap way to pick
   * up an HMR update — and a query collected twice would record its own SHIFTED
   * text as the author's original, so the next shift would compound on top of
   * the last one. Keyed on the rule rather than on the `MediaList`, because the
   * rule is the object with a stable identity for as long as the sheet is not
   * reparsed.
   */
  const seen = new WeakSet<CSSRule>()
  /*
   * How many top-level rules each sheet had when it was last walked.
   *
   * A pass used to walk every rule of every sheet whenever any `<style>` or
   * `<link>` appeared — 10ms on a host with a few thousand rules, after every
   * hot update and every CSS-in-JS insert. An HMR update or a reparse is a NEW
   * sheet object, and an `insertRule` changes the count, so only sheets that
   * are new or have grown or shrunk are walked again. A sheet that holds an
   * `@import` is never recorded: the imported sheet can load after the walk
   * without its parent's count moving.
   */
  const walked = new WeakMap<CSSStyleSheet, number>()
  let importing = false
  /** The inset the queries are currently written for. */
  let shifted = 0

  /** The document-level sheet the current walk is under. */
  let sheet: CSSStyleSheet = null as unknown as CSSStyleSheet

  const rewriteUnits = (style: CSSStyleDeclaration): void => {
    /*
     * Names first, values second. `setProperty` replaces a declaration in
     * place rather than appending, so mutating while iterating is safe today —
     * but the list is the thing being indexed and the loop below is the thing
     * writing to it, and that is a coupling no reader should have to check.
     */
    const properties: string[] = []
    for (let index = 0; index < style.length; index += 1) properties.push(style.item(index))
    for (const property of properties) {
      const value = style.getPropertyValue(property)
      // Already ours. The substitution carries `1vw` as its own fallback, so a
      // second pass over a rewritten declaration would match the regex and nest
      // one rewrite inside another.
      if (value.includes(CANVAS_VW)) continue
      if (!HAS_WIDTH_UNIT.test(value)) continue
      const priority = style.getPropertyPriority(property)
      const next = rewriteWidthUnits(value)
      if (next === value) continue
      style.setProperty(property, next, priority)
      // Recorded even if the engine refused the new value: restoring a
      // declaration to what it already says costs nothing and cannot be wrong.
      declarations.push({ sheet, style, property, value, priority })
    }
  }

  const write = (style: CSSStyleDeclaration, property: string, next: string | null): void => {
    if (next === null) return
    const value = style.getPropertyValue(property)
    const priority = style.getPropertyPriority(property)
    style.setProperty(property, next, priority)
    declarations.push({ sheet, style, property, value, priority })
  }

  const rewriteFixed = (style: CSSStyleDeclaration, keyframe: boolean): void => {
    /*
     * The companions, beside the `position` they describe and at its priority,
     * so whichever rule wins `position` wins them too. Never in a keyframe: a
     * registered property there would animate, and `position` itself does not.
     * A `var()` could resolve to either, so it gets none.
     */
    const position = style.getPropertyValue("position").trim().toLowerCase()
    if (!keyframe && position && !position.includes("var(") && !style.getPropertyValue(FIXED_LEFT)) {
      const priority = style.getPropertyPriority("position")
      for (const [name, value] of position === "fixed" ? COMPANIONS_FIXED : COMPANIONS_NOT_FIXED) {
        style.setProperty(name, value, priority)
        declarations.push({ sheet, style, property: name, value: "", priority: "" })
      }
    }

    /*
     * A shorthand holding a `var()` hides its sides: Tailwind 4 writes
     * `inset: calc(var(--spacing) * 0)`, and its `left` reads back empty until
     * the variable resolves. Read every shorthand before any side is written,
     * because writing a side changes what its shorthand reads back as.
     */
    const hidden = FIXED_SHORTHANDS.map(({ shorthand, left, right }) =>
      style.getPropertyValue(left) || style.getPropertyValue(right) ? "" : style.getPropertyValue(shorthand)
    )

    for (const [property, side] of FIXED_OFFSETS) {
      const value = style.getPropertyValue(property)
      if (value) write(style, property, rewriteFixedOffset(value, side))
    }
    for (const property of FIXED_WIDTHS) {
      const value = style.getPropertyValue(property)
      if (value) write(style, property, rewriteFixedWidth(value))
    }

    FIXED_SHORTHANDS.forEach(({ shorthand, left, right, sides }, index) => {
      const value = hidden[index]
      const parts = topLevelParts(value)
      // A bare `var()` may stand for several sides, and which is unknowable here.
      if (!parts.length || parts.length > 4 || parts.some((part) => /^var\(/i.test(part))) return
      const [start, end] = sides(parts)
      const nextLeft = rewriteFixedOffset(start, "left")
      const nextRight = rewriteFixedOffset(end, "right")
      if (!nextLeft && !nextRight) return
      const priority = style.getPropertyPriority(shorthand)
      /*
       * Unwound in reverse: the written sides are removed first, then the
       * shorthand is put back, which restores every side. Removing the sides
       * by hand is for engines in which setting a shorthand leaves a side
       * written beside it alone (jsdom does).
       */
      declarations.push({ sheet, style, property: shorthand, value, priority })
      for (const [property, next] of [[left, nextLeft], [right, nextRight]] as const) {
        if (!next) continue
        style.setProperty(property, next, priority)
        declarations.push({ sheet, style, property, value: "", priority: "" })
      }
    })
  }

  const walk = (rules: CSSRuleList): void => {
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index]
      // `cssText` first: one string test answers for the whole rule, and most
      // rules hold no width unit at all, so the per-declaration loop is skipped.
      const style = (rule as CSSStyleRule).style as CSSStyleDeclaration | undefined
      if (style) {
        const text = style.cssText
        /*
         * The fixed pass before the unit pass. A fixed `left: 10vw` has to be
         * moved as well as re-measured, and once the unit pass has written
         * `--de-vw` into it, the value names an editor variable and `movable`
         * leaves it alone. The unit pass does not mind the other order: it
         * skips only values that already hold `--de-vw`.
         */
        if (fixedLayers && FIXED_PROPERTY.test(text)) rewriteFixed(style, "keyText" in rule)
        if (HAS_WIDTH_UNIT.test(text)) rewriteUnits(style)
      }

      const media = (rule as CSSMediaRule).media as MediaList | undefined
      if (media && !seen.has(rule) && /width/i.test(media.mediaText)) {
        seen.add(rule)
        queries.push({ sheet, media, original: media.mediaText })
      }

      // `@media`, `@supports`, `@layer`, `@container`, `@scope` and keyframes
      // all hold rules of their own, and a `vw` inside one is no different from
      // a `vw` at the top level. Nesting means a plain style rule has an (empty)
      // list too, which is why the length is checked rather than the property.
      const nested = (rule as CSSGroupingRule).cssRules as CSSRuleList | undefined
      if (nested && nested.length) walk(nested)

      // `@import`ed sheets are a separate CSSStyleSheet that never appears in
      // `document.styleSheets`, so nothing else in this walk would reach them.
      const imported = (rule as CSSImportRule).styleSheet as CSSStyleSheet | undefined
      if (imported) {
        importing = true
        const rules = appRules(imported)
        if (rules) walk(rules)
      }
    }
  }

  /** How much of the window the panels are holding, both sides together. */
  const inset = (): number => {
    const { left, right } = appInsets()
    return left + right
  }

  const shiftQueries = (delta: number): void => {
    for (const query of queries) {
      const next = delta === 0 ? query.original : shiftCondition(query.original, delta)
      if (query.media.mediaText === next) continue
      try {
        query.media.mediaText = next
      } catch {
        query.media.mediaText = query.original
        continue
      }
      /*
       * An unparseable media query does not throw — it becomes `not all`, which
       * matches nothing and would quietly delete a whole block of the app's
       * styles. `shiftCondition` only ever rewrites plain lengths, so this
       * should not happen; it is checked because the cost of being wrong is a
       * chunk of the app's CSS disappearing with no error anywhere.
       */
      if (/not all/i.test(query.media.mediaText) && !/not all/i.test(query.original)) {
        query.media.mediaText = query.original
      }
    }
    shifted = delta
  }

  /** Drops patches of sheets that are gone, so neither a shift nor `destroy` writes into them. */
  const dropDetached = (): void => {
    const live = <T extends { sheet: CSSStyleSheet }>(list: T[]) => {
      let kept = 0
      for (const patch of list) if (!isDetached(patch.sheet)) list[kept++] = patch
      list.length = kept
    }
    live(declarations)
    live(queries)
  }

  const rescan = (): void => {
    dropDetached()
    for (const next of Array.from(document.styleSheets)) {
      const rules = appRules(next)
      if (!rules || walked.get(next) === rules.length) continue
      sheet = next
      importing = false
      /*
       * One sheet at a time, so one refusal cannot cost the others.
       *
       * A pass that throws halfway leaves every stylesheet after it unscanned,
       * and because the throw escapes a scheduled task there is nothing on
       * screen to say so. Which declaration an engine might refuse is not
       * knowable from here; that the rest of the document should still be
       * scanned is.
       */
      try {
        walk(rules)
        if (!importing) walked.set(next, rules.length)
      } catch {
        continue
      }
      // A sheet that changed can move what the token probe resolves against
      // body (`currentColor`, em, rem), so its memo is stale from here.
      forgetNormalizedCssValues()
    }
    // Unconditionally, not only when the inset has moved: a sheet that arrived
    // since the last pass is holding its author's thresholds, and this is the
    // pass that puts them on the canvas. `shiftQueries` skips a query that
    // already says the right thing, so the queries already shifted cost a
    // string comparison each.
    shiftQueries(inset())
  }

  /*
   * A stylesheet can turn up long after boot: a route's chunk, a lazily
   * inserted `<style>`, an HMR update that rewrites the text of one already
   * there. Two observers rather than one broad one — `characterData` over the
   * whole document would wake this on every text node an app renders, and the
   * text that matters is inside `<head>`.
   *
   * Our own nodes are skipped: the chrome rebuilds whole panels, and the board
   * inserts its view-transition `<style>` on every open and close — a pass
   * landing inside that transition's snapshot is the last thing it needs.
   *
   * The pass runs in the observer's own callback, not in a task queued from
   * it. A task does not run before the next paint: the browser may render
   * between the microtask that reported the mutation and any task after it,
   * and it does. Tailwind's Play CDN regenerates its whole `<style>` each time
   * the app renders a class it has not seen, and with the pass queued as a
   * `setTimeout` the regenerated sheet painted first — the app's `w-screen`
   * shell drew at the window's width inside the canvas for one to three
   * frames, 21 times in 40s of a prototype's scripted playback, which looked
   * like the prototype's own motion jittering. An observer callback is a
   * microtask, and microtasks drain before rendering. Nothing is lost: the
   * observer already batches a task's records into one callback, it runs in a
   * background tab too, and a pass over sheets it has already walked costs a
   * length comparison each.
   */
  const onMutation = (records: MutationRecord[]): void => {
    for (const record of records) {
      if (record.type === "characterData") {
        if (!isOurNode(record.target.parentNode)) return rescan()
        continue
      }
      /*
       * The TARGET, not only the added nodes, and this is the case that gets
       * missed. Filling an empty `<style>` — which is how Angular's runtime and
       * every `textContent =` do it — is a childList mutation whose added node
       * is a TEXT node, and a text node is neither of the two elements below.
       * Caught until now only by accident, when the element itself happened to
       * be inserted in the same batch.
       */
      if (record.target instanceof HTMLStyleElement) {
        if (!isOurNode(record.target)) return rescan()
        continue
      }
      const added = record.addedNodes
      if (!added.length) continue
      if (record.target instanceof Element && record.target.closest("[data-designlayer]")) continue
      for (let index = 0; index < added.length; index += 1) {
        const node = added[index]
        if ((node instanceof HTMLStyleElement || node instanceof HTMLLinkElement) && !isOurNode(node)) {
          return rescan()
        }
      }
    }
  }
  const headObserver = new MutationObserver(onMutation)
  headObserver.observe(document.head, { childList: true, subtree: true, characterData: true })
  const bodyObserver = new MutationObserver(onMutation)
  bodyObserver.observe(document.documentElement, { childList: true, subtree: true })

  /*
   * A `<link>` has no rules to read until it has loaded, and its `load` does
   * not bubble — capture on the window is what sees it. Without this a
   * stylesheet added by the app would be scanned by the observer above at the
   * exact moment it is still empty, and never again.
   */
  const onLoad = (event: Event): void => {
    if (event.target instanceof HTMLLinkElement) rescan()
  }
  window.addEventListener("load", onLoad, true)

  /*
   * At most one rewrite per frame. Each one invalidates every rule set in the
   * document, and a panel drag on a high-rate pointer reports several insets a
   * frame. The first in a frame still lands at once — a panel animating from
   * its own frame callback reports once per frame and must not trail a frame
   * behind its padding — and the rest collapse into one more rewrite in the
   * next frame callback, which runs before that frame paints.
   */
  let shiftFrame = 0
  let shiftLate = false
  const stopInsets = onInsetsChange(() => {
    if (shiftFrame) {
      shiftLate = true
      return
    }
    const delta = inset()
    if (delta !== shifted) shiftQueries(delta)
    shiftFrame = requestAnimationFrame(() => {
      shiftFrame = 0
      if (!shiftLate) return
      shiftLate = false
      const late = inset()
      if (late !== shifted) shiftQueries(late)
    })
  })

  rescan()

  return {
    rescan,
    destroy() {
      stopInsets()
      window.removeEventListener("load", onLoad, true)
      headObserver.disconnect()
      bodyObserver.disconnect()
      if (shiftFrame) cancelAnimationFrame(shiftFrame)
      shiftFrame = 0
      dropDetached()
      for (const query of queries) {
        try {
          query.media.mediaText = query.original
        } catch {
          // The sheet is gone; there is nothing left to put back.
        }
      }
      queries.length = 0
      // Last written wins, so unwinding in reverse restores the earliest value
      // for a declaration this rewrote more than once. A companion this added
      // has an empty `value`, and an empty `setProperty` removes it.
      for (const patch of declarations.reverse()) {
        try {
          patch.style.setProperty(patch.property, patch.value, patch.priority)
        } catch {
          // Same: a rule whose sheet has been replaced has nothing to restore.
        }
      }
      declarations.length = 0
      shifted = 0
    },
  }
}

/**
 * The same condition, asked of the canvas instead of the window.
 *
 * Every length compared against `width` moves the same way and by the same
 * amount, whichever side of the comparison it is on and whichever operator
 * joins them: the app wants to know about `canvas`, the browser can only answer
 * about `window`, and `canvas = window - inset`. So `canvas ≤ 1024` is asked as
 * `window ≤ 1024 + inset`, and a range with a bound on each side shifts both.
 *
 * Exported for the tests, which pin the rewrite as a string rather than through
 * a CSSOM that jsdom would have to be talked into evaluating.
 */
export function shiftCondition(condition: string, delta: number): string {
  const shift = (size: string, unit: string | undefined): string => {
    const value = Number(size)
    if (!Number.isFinite(value)) return `${size}${unit ?? ""}`
    // A unitless length in a media query is only legal as zero, and zero plus
    // the inset is a pixel length like any other.
    if (!unit || unit.toLowerCase() === "px") return `${round(value + delta)}px`
    /*
     * A `rem` threshold cannot be added to a pixel one without deciding what a
     * rem is, and in a media query that is the INITIAL font size rather than
     * the root element's — a distinction the engine is better placed to make
     * than this file. `calc()` hands it back to the engine.
     */
    return `calc(${size}${unit} + ${round(delta)}px)`
  }

  return condition
    .replace(
      WIDTH_FEATURE,
      (_, lead: string, feature: string, colon: string, size: string, unit?: string) =>
        `${lead}${feature}${colon}${shift(size, unit)}`
    )
    .replace(
      RANGE_AFTER,
      (_, lead: string, feature: string, operator: string, size: string, unit?: string) =>
        `${lead}${feature}${operator}${shift(size, unit)}`
    )
    .replace(
      RANGE_BEFORE,
      (_, size: string, unit: string | undefined, operator: string, feature: string) =>
        `${shift(size, unit)}${operator}${feature}`
    )
}

/** Three decimals is past the precision of any layout and short enough to read. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
