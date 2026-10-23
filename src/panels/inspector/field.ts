/**
 * Inspector control primitives.
 *
 * One place for every control so a change to focus, drag-scrub, or commit
 * behaviour lands everywhere at once instead of drifting section by section.
 */

import { el, holdTransitions, isChrome, round } from "../../core/dom"
import { icon } from "../../core/icons"
import {
  installIconSegmentThumb,
  installSegmentThumb,
  type TravellingSurface,
} from "../../core/travelling-surface"
import { tokens } from "../../core/tokens"
import { TIP_ATTR, TIP_WRAP_ATTR } from "../../core/tooltip"

/**
 * Panel-level memory. Collapse and expander state belong to the *panel*, not to
 * the selected element: the inspector is torn down and rebuilt on every write,
 * so anything held in the DOM or in a section-local variable would reset the
 * moment you typed into the control you just opened.
 */
const collapsedSections = new Map<string, boolean>()
const expanders = new Map<string, boolean>()

export function isExpanded(key: string): boolean {
  return expanders.get(key) === true
}

export function setExpanded(key: string, value: boolean): void {
  expanders.set(key, value)
  justExpanded = key
}

/**
 * Which disclosure the user just flipped, for the ONE render that follows.
 *
 * The Design tab rebuilds every section on every commit, so a group cannot tell
 * from its own existence whether it has just been revealed or has been open all
 * along. Without that distinction the reveal animation would play on every
 * scrub commit and every keystroke in a field — punctuation for edits that have
 * nothing to do with the disclosure.
 *
 * Read once and cleared, so it describes an interaction rather than a state.
 */
let justExpanded: string | null = null

export function takeJustExpanded(key: string): boolean {
  if (justExpanded !== key) return false
  justExpanded = null
  return true
}

/* ---------- numeric expressions ---------- */

interface Cursor {
  text: string
  at: number
}

function skipSpace(cursor: Cursor): void {
  while (cursor.at < cursor.text.length && /\s/.test(cursor.text[cursor.at])) cursor.at += 1
}

function readPrimary(cursor: Cursor): number | null {
  skipSpace(cursor)
  if (cursor.text[cursor.at] === "(") {
    cursor.at += 1
    const inner = readSum(cursor)
    skipSpace(cursor)
    if (inner === null || cursor.text[cursor.at] !== ")") return null
    cursor.at += 1
    return inner
  }
  const match = /^\d*\.?\d+/.exec(cursor.text.slice(cursor.at))
  if (!match) return null
  cursor.at += match[0].length
  // Units are display sugar in Figma-style fields; the field's glyph already
  // says what the number means, so a typed `px`/`%`/`rem` is stripped, not an error.
  const unit = /^(px|%|rem|em|ch|vh|vw|deg|pt)/i.exec(cursor.text.slice(cursor.at))
  if (unit) cursor.at += unit[0].length
  return Number.parseFloat(match[0])
}

function readSigned(cursor: Cursor): number | null {
  skipSpace(cursor)
  const sign = cursor.text[cursor.at]
  if (sign === "-" || sign === "+") {
    cursor.at += 1
    const value = readSigned(cursor)
    return value === null ? null : sign === "-" ? -value : value
  }
  return readPrimary(cursor)
}

function readProduct(cursor: Cursor): number | null {
  let left = readSigned(cursor)
  if (left === null) return null
  for (;;) {
    skipSpace(cursor)
    const operator = cursor.text[cursor.at]
    if (operator !== "*" && operator !== "/") return left
    cursor.at += 1
    const right = readSigned(cursor)
    if (right === null) return null
    if (operator === "/" && right === 0) return null
    left = operator === "*" ? left * right : left / right
  }
}

function readSum(cursor: Cursor): number | null {
  let left = readProduct(cursor)
  if (left === null) return null
  for (;;) {
    skipSpace(cursor)
    const operator = cursor.text[cursor.at]
    if (operator !== "+" && operator !== "-") return left
    cursor.at += 1
    const right = readProduct(cursor)
    if (right === null) return null
    left = operator === "+" ? left + right : left - right
  }
}

/**
 * Arithmetic-only evaluator for numeric fields, so `(240-16)/2` is a value.
 *
 * Hand-rolled rather than `eval`/`new Function`: the editor runs inside the
 * app's own document, and a field that executes arbitrary text is a script
 * injection point one paste away.
 */
export function evaluateNumeric(raw: string): number | null {
  const cursor: Cursor = { text: raw.trim(), at: 0 }
  if (!cursor.text) return null
  const value = readSum(cursor)
  skipSpace(cursor)
  if (value === null || cursor.at !== cursor.text.length || !Number.isFinite(value)) return null
  return value
}

/* ---------- controls ---------- */

export interface NumberFieldOptions {
  /** Stable identity so focus survives the panel rebuild after a write. */
  id?: string
  /**
   * What is printed in the field's leading strip — a letter, or a drawn mark.
   *
   * A `Node` is allowed because Figma's fields label themselves with a GLYPH
   * wherever one exists (the four padding sides, the gap, the opacity) and with
   * a single letter where one does not (`W`, `H`, `X`, `Y`). What it never uses
   * is a word: the strip is about 20px wide inside an 88px control, so a word
   * either eats the number beside it or gets clipped, and the word belongs in
   * the caption above the group anyway.
   *
   * This existed as a workaround before it existed as an option —
   * `section-autolayout.ts` carried a `withSideGlyph()` helper that reached into
   * the returned DOM and replaced `.de-field-label`'s children, because the
   * type said `string`. That is a section reaching through a primitive's
   * skin to change something the primitive owns, and it silently stops working
   * the moment the field's internals move.
   *
   * `title` stays the accessible name in both cases, which is what makes a
   * glyph label legal at all: a mark with no text needs the name stated.
   */
  label: string | Node
  title?: string
  value: number | null
  /** Shown when `value` is null — `Mixed` across a multi-selection, say. */
  placeholder?: string
  suffix?: string
  /**
   * The field's trailing slot — Figma's `W 708 ⌄`.
   *
   * A node rather than a string so the caller can hand over a real control:
   * today it is the sizing-mode menu button, which has to be pressable and
   * therefore cannot be a `suffix`. `suffix` stays for the inert case (`px`,
   * `%`), because a unit is printed ON a field and a menu is a thing IN one.
   */
  trailing?: Node
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  /**
   * A design-system token this number can be bound to — Figma's "Apply
   * variable". Absent when the catalog stocks nothing for the property.
   */
  token?: FieldToken
  /**
   * Live value during a scrub. Sections wire this to an inline style so the
   * drag is visible without queueing a source write (and a toast) per frame.
   */
  onPreview?(value: number): void
  onCommit(value: number): void
}

/**
 * A number field's token binding, already resolved by the caller.
 *
 * This module knows nothing about catalogs: `token-row.ts` decides which token
 * is bound and what a pick writes, and hands over the name and two callbacks.
 */
export interface FieldToken {
  /** Focus memory for the field's token button, kept across the rebuild a pick causes. */
  id: string
  /** The bound token's display name, or null while the field holds a plain number. */
  bound: string | null
  /** Opens the token list. `trigger` takes focus back; `anchor` is what the list lines up under. */
  open(trigger: HTMLElement, anchor: HTMLElement): void
  /** Writes the resolved number in place of the token. */
  detach(): void
}

/** "Corner radius" as it reads mid-sentence in a tooltip. */
const midSentence = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1)

/**
 * The accessible name for a field whose label may be a drawn mark.
 *
 * `title` wins when it is given, which is the normal case. Falling back to the
 * label only works while the label is text — a glyph has no name of its own, so
 * a field that passes a `Node` and no `title` would otherwise be announced as
 * nothing at all. The empty string is deliberate rather than a guess: it makes
 * the omission visible in an accessibility audit instead of shipping
 * `[object SVGSVGElement]` as a control's name, which is what string coercion
 * would have produced.
 */
const accessibleName = (title: string | undefined, label: string | Node): string =>
  title ?? (typeof label === "string" ? label : "")

/**
 * The inline styles a scrub's previews wrote, rewound before its commit.
 *
 * A preview writes straight onto the element, and `writer.applyStyles` reads
 * the element to learn what an edit changed FROM. So a scrub that ended on the
 * value its last preview drew committed a change from that value to itself: no
 * undo step and no row in the Changes tab, and anything the preview wrote that
 * the commit did not, such as a W scrub's `shrink-0`, stayed on the element.
 * The canvas gesture rewinds before it commits (`canvas/transform.ts`); this is
 * the same rewind for every field, whatever its preview touches.
 *
 * Only `style` writes made inside a preview call are kept. The app goes on
 * animating while a scrub runs, and rewinding its writes would undo them.
 */
function previewLog(): { record(preview: () => void): void; rewind(commit: () => void): void } {
  const originals = new Map<HTMLElement | SVGElement, string | null>()
  let observer: MutationObserver | null = null
  return {
    record(preview) {
      if (!observer && typeof MutationObserver === "function") {
        // Read only through `takeRecords`, so the callback has nothing to do.
        observer = new MutationObserver(() => {})
        observer.observe(document.documentElement, {
          subtree: true,
          attributes: true,
          attributeFilter: ["style"],
          attributeOldValue: true,
        })
      }
      observer?.takeRecords()
      preview()
      for (const record of observer?.takeRecords() ?? []) {
        const target = record.target
        if (!(target instanceof HTMLElement || target instanceof SVGElement)) continue
        if (originals.has(target) || isChrome(target)) continue
        originals.set(target, record.oldValue)
      }
    },
    rewind(commit) {
      observer?.disconnect()
      observer = null
      // Back as it was with transitions held, so neither the rewind nor the
      // commit after it animates: the last value painted was the preview's.
      const releases = [...originals].map(([element, style]) => {
        if (style === null) element.removeAttribute("style")
        else element.setAttribute("style", style)
        return holdTransitions(element)
      })
      originals.clear()
      try {
        commit()
      } finally {
        for (const release of releases) release()
      }
    },
  }
}

/** Figma-style scrubbable number input: drag the label, or type a value. */
export function numberField(options: NumberFieldOptions): HTMLElement {
  if (options.token?.bound) return boundNumberField(options, options.token)
  const initial = options.value === null ? "" : String(round(options.value))
  const input = el("input", {
    type: "text",
    inputmode: "decimal",
    "aria-label": accessibleName(options.title, options.label),
    value: initial,
    placeholder: options.placeholder ?? "",
    disabled: options.disabled,
    "data-de-field": options.id,
  }) as HTMLInputElement

  const clampValue = (value: number) =>
    Math.min(options.max ?? Number.POSITIVE_INFINITY, Math.max(options.min ?? Number.NEGATIVE_INFINITY, value))

  const commit = (raw: string) => {
    const parsed = evaluateNumeric(raw)
    if (parsed === null) return
    const next = clampValue(parsed)
    // Show the result, not the expression — the field is now the value again.
    // As its default too: a committed value is no longer typing in progress,
    // which is what holds the panel's geometry repaints off (`follow.ts`).
    input.value = String(round(next))
    input.defaultValue = input.value
    options.onCommit(next)
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault()
      commit(input.value)
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      input.value = initial
      input.blur()
      return
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    event.preventDefault()
    const step = (options.step ?? 1) * modifierScale(event)
    const current = evaluateNumeric(input.value) ?? 0
    commit(String(round(event.key === "ArrowUp" ? current + step : current - step)))
  })
  /*
   * Commit on blur only when the person left a changed value behind.
   *
   * Chrome fires `blur` on a focused input that is REMOVED, and every commit
   * rebuilds the panel, so an unconditional commit here re-ran the last edit on
   * the field it was removing; any section whose commit invalidates the panel
   * (Rotation's does) then rebuilt, blurred and committed again in a microtask
   * loop that froze the page. A detached input or an unedited value is not a
   * person leaving the field.
   */
  input.addEventListener("blur", () => {
    if (!input.isConnected || input.value === initial) return
    commit(input.value)
  })

  const label = el(
    "span",
    { class: "de-field-label", title: accessibleName(options.title, options.label) },
    [options.label]
  )

  // Drag the label to scrub, the way Figma and Leva both behave. The commit is
  // deferred to pointerup: committing per pointermove queues a source write and
  // fires the engine toast dozens of times for one gesture.
  label.addEventListener("pointerdown", (event) => {
    if (options.disabled) return
    event.preventDefault()
    label.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startValue = evaluateNumeric(input.value) ?? 0
    let latest = startValue
    let frame = 0
    const previews = previewLog()

    // Say that the gesture is what is driving the number. The lit label is the
    // pressed-control appearance from `css/panels.ts`; the field's own accent
    // border is the one it already wears for focus, which is the other way this
    // control gets driven. Both are cleared in `onUp`, including the
    // `pointercancel` path, so a drag that ends off the label cannot strand it.
    label.classList.add("de-field-label--scrubbing")
    label.closest(".de-field")?.classList.add("de-field--scrubbing")

    const onMove = (move: PointerEvent) => {
      latest = clampValue(startValue + (move.clientX - startX) * (options.step ?? 1) * modifierScale(move))
      input.value = String(round(latest))
      if (!options.onPreview || frame) return
      // One preview per frame: the value changes faster than the app can paint.
      frame = requestAnimationFrame(() => {
        frame = 0
        previews.record(() => options.onPreview?.(latest))
      })
    }
    const onUp = () => {
      if (frame) cancelAnimationFrame(frame)
      label.classList.remove("de-field-label--scrubbing")
      label.closest(".de-field")?.classList.remove("de-field--scrubbing")
      // `pointercancel` has already dropped the capture; releasing twice throws.
      if (label.hasPointerCapture(event.pointerId)) label.releasePointerCapture(event.pointerId)
      label.removeEventListener("pointermove", onMove)
      label.removeEventListener("pointerup", onUp)
      label.removeEventListener("pointercancel", onUp)
      previews.rewind(() => {
        if (latest !== startValue) options.onCommit(latest)
      })
    }
    label.addEventListener("pointermove", onMove)
    label.addEventListener("pointerup", onUp)
    label.addEventListener("pointercancel", onUp)
  })

  // `--numeric` rather than styling every `.de-field input`: tabular figures
  // stop the digits walking sideways under a scrub, but the same treatment on
  // a text field would space out prose that has no columns to keep.
  const field = el("div", { class: options.token ? "de-field de-field--numeric de-tokenbind" : "de-field de-field--numeric" }, [
    label,
    input,
    options.suffix ? el("span", { class: "de-field-suffix" }, [options.suffix]) : null,
    options.trailing ?? null,
  ])
  if (options.token) field.append(applyTokenButton(options, options.token, field))
  return field
}

/**
 * The hexagon at the field's end. Hidden until the field is hovered or holds
 * focus, as in Figma, but always in the tab order so a keyboard reaches it.
 */
function applyTokenButton(options: NumberFieldOptions, token: FieldToken, field: HTMLElement): HTMLElement {
  const name = midSentence(accessibleName(options.title, options.label))
  const button = el(
    "button",
    {
      class: "de-tokenbind-apply",
      type: "button",
      "aria-label": "Apply token",
      title: token.bound ? `Change ${name} token` : `Apply token to ${name}`,
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      "aria-pressed": token.bound ? "true" : undefined,
      "data-de-field": token.id,
      disabled: options.disabled,
    },
    [icon("Variable", tokens.icon.action)]
  )
  button.addEventListener("click", () => token.open(button, field))
  return button
}

/**
 * A bound field: the token's name as a chip where the number was, and a detach
 * action on the chip. The number is not drawn, so there is nothing to type or
 * scrub until the token is detached; Figma's bound fields behave the same way.
 */
function boundNumberField(options: NumberFieldOptions, token: FieldToken): HTMLElement {
  const title = accessibleName(options.title, options.label)
  const bound = token.bound ?? ""
  const detach = el(
    "button",
    {
      class: "de-tokenbind-detach",
      type: "button",
      "aria-label": "Detach token",
      title: `Detach token from ${midSentence(title)}`,
      disabled: options.disabled,
    },
    [icon("XSmall", tokens.icon.marker)]
  )
  detach.addEventListener("click", () => token.detach())
  // The leaf never clips: in a field this narrow, "Radius/…" names the group
  // and hides the answer, so the group gives way first.
  const cut = bound.lastIndexOf("/") + 1
  const name = el("span", { class: "de-tokenbind-name" }, [
    cut ? el("span", { class: "de-tokenbind-group" }, [bound.slice(0, cut)]) : null,
    el("span", { class: "de-tokenbind-leaf" }, [bound.slice(cut)]),
  ])
  const chip = el("span", { class: "de-tokenbind-chip", title: `${title}: ${bound}` }, [name, detach])
  const field = el("div", { class: "de-field de-field--numeric de-tokenbind de-tokenbind--bound" }, [
    el("span", { class: "de-field-label de-tokenbind-label", title }, [options.label]),
    chip,
    options.trailing ?? null,
  ])
  const apply = applyTokenButton(options, token, field)
  // The name is the larger target, so a press on it opens the same list.
  name.addEventListener("click", () => apply.click())
  field.append(apply)
  return field
}

/**
 * A control group under a small grey label — Figma's `Alignment`, `Gap`,
 * `Padding`.
 *
 * Takes the caption rather than exporting the two class names, so the pairing
 * cannot be half-applied. A group with no caption is a plain `.de-stack`; this
 * exists for the ones that need naming, which in Figma's panel is most of them.
 */
export function group(caption: string, ...children: Array<Node | null>): HTMLElement {
  return el("div", { class: "de-group" }, [
    el("div", { class: "de-group-caption" }, [caption]),
    ...children,
  ])
}

export interface PropRowOptions {
  /**
   * One caption over the whole row (Figma's `Position`), or one per column
   * (`Opacity` over the first field, `Corner radius` over the second). A `null`
   * column caption leaves that column's caption cell empty, so a lone second
   * caption still lands over the second field.
   */
  caption?: string | [string | null, string | null]
  /** One control spanning both columns, or one per column. */
  cells: Array<Node | null>
  /**
   * The row's 24px action: individual corners, individual padding, aspect lock,
   * wrap, a settings popover. The column is drawn whether or not this row has
   * one, so every trailing action in the panel sits on one vertical line.
   */
  trailing?: Node | null
  /** Stable id for tests and focus memory. */
  id?: string
}

/**
 * Figma's property row: captions over a `1fr 1fr 24px` grid.
 *
 * Measured off Figma's own panel (`ui3OneInputOneIconRow` and its siblings):
 * every row is two equal field columns and one icon column, and a control that
 * needs the whole width spans the first two. Building each section's rows on
 * this one grid is what lines the X field up with W, Opacity, the fill hex and
 * the font family, and puts every per-side toggle in the same column, so a
 * Figma user finds a control by where it sits.
 *
 * Expanded follow-up rows (individual corners, individual padding) are more
 * `propRow`s with no caption, so they keep the same columns.
 */
export function propRow(options: PropRowOptions): HTMLElement {
  const captions: HTMLElement[] = []
  if (typeof options.caption === "string") {
    captions.push(el("div", { class: "de-prow-caption de-prow-caption--span" }, [options.caption]))
  } else if (options.caption) {
    const [first, second] = options.caption
    captions.push(el("div", { class: "de-prow-caption" }, [first ?? ""]))
    captions.push(el("div", { class: "de-prow-caption" }, [second ?? ""]))
  }
  const present = options.cells.filter((cell): cell is Node => cell !== null)
  const cells = present.map((cell) =>
    el("div", { class: present.length === 1 ? "de-prow-cell de-prow-cell--span" : "de-prow-cell" }, [cell])
  )
  return el("div", { class: "de-prow", "data-de-row": options.id }, [
    // Its own subgrid row, so the cells below always start back at column 1.
    captions.length ? el("div", { class: "de-prow-captions" }, captions) : null,
    ...cells,
    options.trailing ? el("div", { class: "de-prow-trail" }, [options.trailing]) : null,
  ])
}

/**
 * A toggle for the row's trailing column — Figma's individual-corners button.
 * `pressed` draws the selected plate so an expanded row says it is expanded.
 */
export function trailingToggle(options: {
  label: string
  glyph: Node
  pressed: boolean
  onClick(): void
}): HTMLElement {
  const button = iconButton({
    label: options.label,
    glyph: options.glyph,
    pressed: options.pressed,
    onClick: options.onClick,
  })
  button.classList.add("de-prow-toggle")
  return button
}

export interface IconChoice {
  value: string
  label: string
  glyph: Node
  disabled?: boolean
}

/**
 * One-of-several, drawn as glyphs on a continuous rail.
 *
 * The icon twin of `segmented` — Auto layout's flow strip, the sizing modes,
 * both text-alignment triples. Exactly one cell is chosen at a time, which is
 * the invariant that earns the rail: it says the choice is among THESE.
 */
export function iconSegmented(options: {
  label: string
  value: string
  options: IconChoice[]
  onCommit(value: string): void
}): HTMLElement {
  const buttons = options.options.map((choice) => {
    const button = iconButton({
      label: choice.label,
      glyph: choice.glyph,
      pressed: choice.value === options.value,
      onClick: () => {
        justSegmented = options.label
        options.onCommit(choice.value)
      },
    })
    if (choice.disabled) (button as HTMLButtonElement).disabled = true
    return button
  })
  const node = el("div", { class: "de-iseg", role: "group", "aria-label": options.label }, buttons)

  /*
   * The same travelling chip the word version gets, for the reason its own
   * comment gives: this is called the icon twin of `segmented`, and a twin that
   * teleports beside one that slides is two answers to one gesture.
   *
   * The park-then-release in `placeThumb` is the same trick too, needed for the
   * same reason: this panel rebuilds all thirteen sections on every commit, so
   * the control the user pressed no longer exists by the time anything could
   * animate. Placing the chip where the PREVIOUS build had it and releasing it
   * a frame later makes the replacement perform the move its predecessor never
   * got to. `justSegmented` keeps that honest — without it, selecting a second
   * element whose value differs would slide the chip as though somebody had
   * pressed it.
   */
  const thumb = installIconSegmentThumb(node)
  const was = segmentedWas.get(options.label)
  segmentedWas.set(options.label, options.value)
  const pressed = justSegmented === options.label
  if (pressed) justSegmented = null

  const at = (value: string): HTMLElement | null => {
    const index = options.options.findIndex((choice) => choice.value === value)
    return index < 0 ? null : buttons[index]
  }
  placeThumb(thumb, at, was, options.value, pressed)
  return node
}

export interface ActionChoice {
  label: string
  glyph: Node
  /** Present only for a cell that HOLDS a state; omit for a pure action. */
  pressed?: boolean
  disabled?: boolean
  onClick(): void
}

/**
 * Two to four buttons drawn as one joined block — Figma's align and flip
 * triples.
 *
 * Unlike `iconSegmented` there is no invariant that one of them is on: these
 * are actions, and `pressed` is optional per cell. The visual difference is a
 * hairline of panel ground between the cells instead of a continuous rail, so
 * the two never have to be told apart by reading the handler.
 */
export function actionGroup(options: { label: string; buttons: ActionChoice[] }): HTMLElement {
  return el(
    "div",
    { class: "de-agroup", role: "group", "aria-label": options.label },
    options.buttons.map((entry) => {
      const button = iconButton({
        label: entry.label,
        glyph: entry.glyph,
        pressed: entry.pressed,
        onClick: entry.onClick,
      })
      if (entry.disabled) (button as HTMLButtonElement).disabled = true
      return button
    })
  )
}

/**
 * The 3x3 position field — one filled block with nine rests and one mark.
 *
 * `cells` arrives row-major, nine of them. The chosen cell carries its glyph
 * and the other eight draw the stylesheet's dot, which is why `glyph` is only
 * read when `pressed` is true: a dot is not an icon and must not come off the
 * ramp.
 */
export function alignPad(options: {
  label: string
  cells: Array<{ label: string; pressed: boolean; glyph: Node; onClick(): void }>
}): HTMLElement {
  return el(
    "div",
    { class: "de-pad", role: "group", "aria-label": options.label },
    options.cells.map((cell) =>
      el(
        "button",
        {
          class: "de-pad-cell",
          type: "button",
          title: cell.label,
          "aria-label": cell.label,
          "aria-pressed": String(cell.pressed),
          onclick: cell.onClick,
        },
        /*
         * The mark is mounted on every cell, not only the pressed one.
         *
         * Appending it on press gave the browser nothing to interpolate: a node
         * that did not exist a frame ago has no previous state, so the dot-to-
         * mark swap could only ever be a substitution. Both are present now and
         * `css/panels.ts` crossfades between them off `aria-pressed`. The cost
         * is eight hidden 12px glyphs per pad, which is the same trade
         * `core/swap-mark.ts` makes everywhere else in the chrome.
         */
        [cell.glyph]
      )
    )
  )
}

/** Shift coarsens, Alt/Cmd refines — Figma's two scrub gears. */
function modifierScale(event: { shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }): number {
  if (event.shiftKey) return 10
  if (event.altKey || event.metaKey || event.ctrlKey) return 0.1
  return 1
}

export interface TextFieldOptions {
  id?: string
  /** A letter or a drawn mark, never a word — see `NumberFieldOptions.label`. */
  label: string | Node
  /** The accessible name, required once `label` can be a glyph with no text. */
  title?: string
  value: string
  placeholder?: string
  onCommit(value: string): void
}

export function textField(options: TextFieldOptions): HTMLElement {
  const name = accessibleName(options.title, options.label)
  const input = el("input", {
    type: "text",
    "aria-label": name,
    value: options.value,
    placeholder: options.placeholder ?? "",
    "data-de-field": options.id,
  }) as HTMLInputElement
  input.addEventListener("change", () => options.onCommit(input.value))
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return
    event.preventDefault()
    options.onCommit(input.value)
    input.blur()
  })
  return el("div", { class: "de-field" }, [
    el("span", { class: "de-field-label", style: "cursor:default", title: name }, [options.label]),
    input,
  ])
}

export interface SelectFieldOptions {
  id?: string
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  /**
   * Shown when `value` names no option — `Mixed` across a multi-selection.
   * Without it a native select falls back to its first option and claims a
   * value no layer has.
   */
  placeholder?: string
  onCommit(value: string): void
}

/**
 * A select, and a chevron so it looks like one.
 *
 * `appearance: none` is what lets `.de-select` wear the panel's own well
 * instead of the operating system's, and it takes the platform's disclosure
 * mark away with it. Nothing put one back, so every dropdown in the inspector —
 * the font weight, the stroke style, the effect type — was drawn as a text
 * field that happened to open a menu when pressed. The only way to discover it
 * was a dropdown was to click it.
 *
 * The mark is a SIBLING laid over the control rather than a `::after` on it,
 * because a `<select>` is a replaced element and its pseudo-elements are not
 * reliably drawn. That means the glyph sits on top of the thing it decorates
 * and would swallow the click that opens the menu — `css/base.ts` forces
 * `pointer-events: all` onto every `<svg>` in inspecting mode, which beats a
 * plain `pointer-events: none` on the wrapper. The rule in `css/panels.ts`
 * therefore targets `.de-select-caret svg` directly, which outranks it on
 * specificity rather than on source order.
 */
export function selectField(options: SelectFieldOptions): HTMLElement {
  const select = el("select", {
    class: "de-select",
    "aria-label": options.label,
    "data-de-field": options.id,
  }) as HTMLSelectElement
  if (options.placeholder !== undefined && !options.options.some((option) => option.value === options.value)) {
    // Disabled and hidden: it names the state and cannot be picked back.
    const blank = el("option", { value: "", disabled: true, hidden: true }, [options.placeholder]) as HTMLOptionElement
    blank.selected = true
    select.append(blank)
  }
  for (const option of options.options) {
    const node = el("option", { value: option.value }, [option.label]) as HTMLOptionElement
    if (option.value === options.value) node.selected = true
    select.append(node)
  }
  select.addEventListener("change", () => options.onCommit(select.value))
  return el("span", { class: "de-select-shell" }, [
    select,
    el("span", { class: "de-select-caret", "aria-hidden": "true" }, [
      icon("ChevronDown", tokens.icon.marker),
    ]),
  ])
}

export interface SegmentedOptions {
  label: string
  value: string
  options: Array<{ value: string; label: string; title?: string }>
  onCommit(value: string): void
}

/**
 * Where each segmented control last was, and which one the user just pressed.
 *
 * The chip travels, which is what a segmented control is for — but this panel
 * rebuilds all thirteen sections on every commit, so the control the user
 * pressed is gone before anything could animate and its replacement arrives
 * already correct.
 *
 * So the chip is placed at the value the control had LAST time it was built and
 * moved to the current one a frame later. The rebuild stops mattering: the new
 * control performs the transition the old one would have.
 *
 * Keyed by label, which is unique within a panel. `justSegmented` is what keeps
 * this honest — without it, selecting a second element whose value differs
 * would slide the chip as if somebody had pressed it, and a panel that animates
 * on selection change is a panel that animates constantly.
 */
const segmentedWas = new Map<string, string>()
let justSegmented: string | null = null

/** Two or three mutually exclusive words — Figma's `Packed | Space between`. */
export function segmented(options: SegmentedOptions): HTMLElement {
  const buttons = options.options.map((option) =>
    el(
      "button",
      {
        class: "de-segment",
        type: "button",
        title: option.title ?? option.label,
        "aria-pressed": String(option.value === options.value),
        onclick: () => {
          justSegmented = options.label
          options.onCommit(option.value)
        },
      },
      [option.label]
    )
  )
  const node = el(
    "div",
    { class: "de-segmented", role: "group", "aria-label": options.label },
    buttons
  )
  // The same helper the tab strips use — measurement, the zero-refusal, the
  // first-placement jump and the resize re-measure are one implementation now.
  const thumb = installSegmentThumb(node)

  const was = segmentedWas.get(options.label)
  segmentedWas.set(options.label, options.value)
  const pressed = justSegmented === options.label
  if (pressed) justSegmented = null

  const at = (value: string): HTMLElement | null => {
    const index = options.options.findIndex((option) => option.value === value)
    return index < 0 ? null : buttons[index]
  }

  placeThumb(thumb, at, was, options.value, pressed)
  return node
}

/**
 * Puts a segmented control's chip under its value, the moment the control is
 * on screen.
 *
 * A control that is only being SHOWN — a new selection, a rebuild after some
 * other row's commit — is placed in a microtask. The inspector builds in a
 * microtask of its own and appends every section before it ends, so by this
 * one the control is attached and the next frame paints it with its chip.
 * This was a `requestAnimationFrame`, which from inside a build that ran in a
 * frame callback means the NEXT frame: every selection painted the per-item
 * fallback for one frame and swapped in the chip a frame later, and the panel
 * did not settle until then. A control built anywhere that is not yet attached
 * measures zero, which the surface refuses, and its resize observer places it
 * once it is laid out.
 *
 * A control that was just PRESSED keeps the two frames: park where the
 * previous build had the chip, paint that, then release to the new value so
 * the chip performs the move its replaced predecessor never got to.
 */
function placeThumb(
  thumb: TravellingSurface,
  at: (value: string) => HTMLElement | null,
  was: string | undefined,
  value: string,
  pressed: boolean
): void {
  const travels = pressed && was !== undefined && was !== value
  if (!travels) {
    queueMicrotask(() => thumb.track(at(value)))
    return
  }
  requestAnimationFrame(() => {
    thumb.track(at(was))
    requestAnimationFrame(() => thumb.track(at(value)))
  })
}

export interface IconButtonOptions {
  label: string
  /**
   * A unicode mark or a drawn one.
   *
   * It was `string` while every caller had a `⇤` to hand. The align strip draws
   * real glyphs now, and a caller that has an `<svg>` should not have to build
   * the button itself just to pass one in — that is how a second, subtly
   * different button gets written.
   */
  glyph: string | Node
  pressed?: boolean
  onClick(): void
}

export function iconButton(options: IconButtonOptions): HTMLElement {
  return el(
    "button",
    {
      class: "de-tool",
      type: "button",
      title: options.label,
      "aria-label": options.label,
      "aria-pressed": options.pressed === undefined ? undefined : String(options.pressed),
      onclick: options.onClick,
    },
    [options.glyph]
  )
}

/** Small trailing affordance on a list row or a section header: `+`, eye, `−`. */
export function miniButton(options: {
  label: string
  glyph: string | Node
  pressed?: boolean
  danger?: boolean
  /* The event is passed through so a handler can reach the row it is in — a
     destructive one needs to close that row before the panel rebuilds without
     it. Optional in the signature, so the many handlers that ignore it are
     unchanged. */
  onClick(event: Event): void
}): HTMLElement {
  return el(
    "button",
    {
      class: options.danger ? "de-mini de-mini--danger" : "de-mini",
      type: "button",
      title: options.label,
      "aria-label": options.label,
      "aria-pressed": options.pressed === undefined ? undefined : String(options.pressed),
      onclick: options.onClick,
    },
    [options.glyph]
  )
}

/** Drops the user's fold choice for one section, so its default applies again. */
export function forgetSectionFold(title: string): void {
  collapsedSections.delete(title)
}

/**
 * A collapsible section. The header folds the body in place rather than asking
 * the panel to re-render: a rebuild here would drop focus from whatever the
 * user was editing two controls down.
 */
export function section(
  title: string,
  body: HTMLElement,
  actions?: HTMLElement,
  /**
   * Whether this section starts folded the FIRST time it is drawn.
   *
   * Only consulted when the panel has no memory of the title yet, so it is a
   * default rather than a state: once the user has folded or unfolded it, their
   * choice wins for the rest of the session and this argument is ignored.
   *
   * It exists for Settings in the Changes tab, which is the one section in the
   * panel that should not be open on arrival — it is somewhere you go once,
   * below a list you are reading every time, and unfolded by default it pushes
   * that list up by the height of six rows for a block nobody asked for.
   */
  collapsedByDefault = false,
  /**
   * A sentence that explains the SECTION, shown when the title is hovered.
   *
   * Replaced the help dot this slot used to take: the explanation now opens
   * from the title itself, so there is no glyph to find. The same sentence is
   * set as the fold button's `aria-description` for keyboard and screen-reader
   * users, since the tooltip card is `aria-hidden`.
   */
  hint?: string
): HTMLElement {
  // A default, not a choice: it is not stored, so a section whose default
  // changes with its content (Selection colors folds above four colours)
  // follows it until the user presses the header, and their choice wins after.
  const folded = (): boolean => collapsedSections.get(title) ?? collapsedByDefault
  const collapsed = folded()
  const wrapped = el("div", { class: "de-section-body" }, [body])
  wrapped.hidden = collapsed
  /*
   * The layer that CLIPS, so the body can be seen to open and shut.
   *
   * The fold used to be `hidden` and nothing else: the chevron turned over
   * 120ms and the section it describes arrived between two frames. A mark that
   * animates over a body that does not is the worst of both — it promises a
   * movement and then denies it, which is what makes a press on one of these
   * headers read as a flicker rather than as something opening.
   *
   * A wrapper, and not a height written onto the body, because the thing being
   * animated is a grid row: see `.de-section-fold` in `css/panels.ts` for why
   * the row goes on a box of its own and the padded body stays inside it. The
   * body keeps its `hidden` — that attribute is still the fold's STATE, read by
   * the CSS and by every test that asks whether a section is shut; the wrapper
   * only draws it.
   */
  const fold = el("div", { class: "de-section-fold" }, [wrapped])

  /*
   * Title first, chevron last, and the fold button behind both.
   *
   * The chevron used to lead the header, which pushed every section title one
   * glyph plus a gap to the right of the rows it heads — the panel's left edge
   * read as bent, because the titles started on a column nothing else in the
   * body used. Moving it to the trailing edge puts the title back on the 8px
   * the body pads to, and gives the chevrons a column of their own against the
   * panel's right edge.
   *
   * That splits one control across a third thing that has to stay separately
   * clickable: the `+` some sections carry. A `+` nested inside the fold button
   * would be a button inside a button — invalid, and unreachable by keyboard.
   * So the button holds no content at all. It is an empty layer stretched over
   * the whole bar (see `.de-section-toggle`), with the title, the actions and
   * the chevron laid over it as grid items; only the actions take their own
   * clicks back.
   */
  const toggle = el("button", {
    class: "de-section-toggle",
    type: "button",
    "aria-expanded": String(!collapsed),
    // The button has no text of its own now, so the name has to be stated.
    "aria-label": title,
    title: `${collapsed ? "Expand" : "Collapse"} ${title}`,
  })
  if (hint) toggle.setAttribute("aria-description", hint)

  const header = el("div", { class: "de-section-header de-section-header--collapsible" }, [
    toggle,
    sectionHeading(title, hint),
    actions ? el("span", { class: "de-section-actions" }, [actions]) : null,
    el("span", { class: "de-chevron", "aria-hidden": "true" }, [icon("ChevronRight", tokens.icon.marker)]),
  ])

  /*
   * The listener sits on the header, not on the button, and catches the
   * button's own click on the way up.
   *
   * The chevron is no longer inside the button, and `pointer-events: none` is
   * not enough to make a click on it reach the layer underneath: inspecting
   * mode forces `pointer-events: all` onto every `<svg>` in the document so
   * that icons in the APP can be selected, and that sweeps up the chrome's own
   * glyphs. That was harmless while every glyph sat inside the control it
   * belonged to and its click merely bubbled there. Listening one level up
   * restores that, and keeps working whatever the glyph's hit behaviour is.
   */
  header.addEventListener("click", (event) => {
    // The `+` is inside the bar but is not part of the fold: a press on it must
    // add a fill, not collapse the section the new row would land in.
    if ((event.target as HTMLElement | null)?.closest(".de-section-actions")) return
    const next = !folded()
    collapsedSections.set(title, next)
    wrapped.hidden = next
    toggle.setAttribute("aria-expanded", String(!next))
    toggle.setAttribute("title", `${next ? "Expand" : "Collapse"} ${title}`)
    header.classList.toggle("de-section-header--collapsed", next)
  })
  header.classList.toggle("de-section-header--collapsed", collapsed)

  return el("div", { class: "de-section" }, [header, fold])
}

/**
 * A section with nothing in it yet: the title, dimmed, and the `+` that adds
 * the first entry. Figma draws an empty Stroke, Effects or Export this way, a
 * one-line header instead of a body that says "No stroke", so the sections an
 * element does use stay near the top of the panel.
 *
 * No fold: there is no body to fold, and a chevron on an empty header would
 * promise content that is not there.
 */
export function emptySection(title: string, actions: HTMLElement, hint?: string): HTMLElement {
  const header = el("div", { class: "de-section-header de-section-header--empty" }, [
    sectionHeading(title, hint),
    el("span", { class: "de-section-actions" }, [actions]),
  ])
  return el("div", { class: "de-section de-section--empty", "data-de-empty": "true" }, [header])
}

/**
 * The header's first track: the title. With a hint, the title carries it as
 * its tooltip and is lifted above the fold layer so the pointer reaches it; a
 * click on it still bubbles to the header and folds the section.
 */
function sectionHeading(title: string, hint?: string): HTMLElement {
  const text = el("span", { class: "de-section-title" }, [title])
  if (hint) setTitleHint(text, hint)
  return text
}

function setTitleHint(text: HTMLElement, hint: string): void {
  text.classList.add("de-section-title--hint")
  text.setAttribute(TIP_ATTR, hint)
  text.setAttribute(TIP_WRAP_ATTR, "")
}

/**
 * Rewrite a section's header hint after it is built — for a sentence that
 * changes, like the DS lint header's list of checkers.
 */
export function setSectionHint(section: HTMLElement, hint: string): void {
  const text = section.querySelector<HTMLElement>(":scope > .de-section-header > .de-section-title")
  if (text) setTitleHint(text, hint)
  section
    .querySelector(":scope > .de-section-header > .de-section-toggle")
    ?.setAttribute("aria-description", hint)
}
