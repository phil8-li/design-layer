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
const WIDTH_UNIT = /(-?\d*\.?\d+)(?:[dsl]?v(?:w|i))\b/gi

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

/**
 * A declaration we rewrote, and what it said before we did. `sheet` is the
 * document-level sheet it came from, so a patch can be dropped once an HMR
 * update has replaced that sheet and the declaration is garbage.
 */
interface UnitPatch {
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

export interface AppViewport {
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
  const units: UnitPatch[] = [];
  const queries: QueryPatch[] = []
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
  /** The scheduled catch-up pass, if one is already queued. */
  let pending = 0

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
      const next = value.replace(
        WIDTH_UNIT,
        (_, size: string) => `calc(var(${CANVAS_VW}, 1vw) * ${size})`
      )
      style.setProperty(property, next, priority)
      // Recorded even if the engine refused the new value: restoring a
      // declaration to what it already says costs nothing and cannot be wrong.
      units.push({ sheet, style, property, value, priority })
    }
  }

  const walk = (rules: CSSRuleList): void => {
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index]
      // `cssText` first: one string test answers for the whole rule, and most
      // rules hold no width unit at all, so the per-declaration loop is skipped.
      const style = (rule as CSSStyleRule).style as CSSStyleDeclaration | undefined
      if (style && HAS_WIDTH_UNIT.test(style.cssText)) rewriteUnits(style)

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
    live(units)
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
   * A timeout rather than a frame, and the difference is a hidden tab.
   *
   * `requestAnimationFrame` does not run in a background tab, so a stylesheet
   * that arrived while the designer was reading something else would sit at the
   * window's thresholds until they came back AND something else moved. A task
   * is scheduled either way, runs before the next paint in a visible tab, and
   * coalesces a burst of inserts into one pass because the flag is only cleared
   * when the pass runs.
   */
  const schedule = (): void => {
    if (pending) return
    pending = setTimeout(() => {
      pending = 0
      rescan()
    }, 0) as unknown as number
  }

  /*
   * A stylesheet can turn up long after boot: a route's chunk, a lazily
   * inserted `<style>`, an HMR update that rewrites the text of one already
   * there. Two observers rather than one broad one — `characterData` over the
   * whole document would wake this on every text node an app renders, and the
   * text that matters is inside `<head>`.
   */
  /*
   * Our own nodes are skipped: the chrome rebuilds whole panels, and the board
   * inserts its view-transition `<style>` on every open and close — a pass
   * landing inside that transition's snapshot is the last thing it needs.
   */
  const onMutation = (records: MutationRecord[]): void => {
    for (const record of records) {
      if (record.type === "characterData") {
        if (!isOurNode(record.target.parentNode)) return schedule()
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
        if (!isOurNode(record.target)) return schedule()
        continue
      }
      const added = record.addedNodes
      if (!added.length) continue
      if (record.target instanceof Element && record.target.closest("[data-designlayer]")) continue
      for (let index = 0; index < added.length; index += 1) {
        const node = added[index]
        if ((node instanceof HTMLStyleElement || node instanceof HTMLLinkElement) && !isOurNode(node)) {
          return schedule()
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
    if (event.target instanceof HTMLLinkElement) schedule()
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
      if (pending) clearTimeout(pending)
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
      // for a declaration this rewrote more than once.
      for (const patch of units.reverse()) {
        try {
          patch.style.setProperty(patch.property, patch.value, patch.priority)
        } catch {
          // Same: a rule whose sheet has been replaced has nothing to restore.
        }
      }
      units.length = 0
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
