/**
 * Size — width and height, each carrying Figma's Fixed / Hug / Fill mode.
 *
 * The X/Y fields that used to live here are gone. They emitted `transform:
 * translate()`, which `core/tailwind.ts` cannot express, so every nudge was
 * dropped on "Apply to code" without saying so. In a flow layout the honest
 * controls are the sizing modes: Fixed is a length, Hug is `fit-content`, Fill
 * is `100%`, and all three reach source.
 *
 * The mode rides INSIDE the field, in its trailing slot — `W 708 ⌄`, and
 * `W 708 Fill` once the mode is worth a word — and pressing it opens a menu of
 * the three modes, as Figma's does. The number stays editable in every mode:
 * typing a length is how Figma switches an axis back to Fixed.
 */

import { el } from "../../core/dom"
import { icon } from "../../core/icons"
import { tokens } from "../../core/tokens"
import { isExpanded, numberField, propRow, setExpanded, trailingToggle } from "./field"
import { mixedNumber, sharedValue } from "./multi"
import type { SectionContext } from "./index"
import type { LayerElement } from "../../core/types"

type Axis = "width" | "height"
type Mode = "fixed" | "hug" | "fill"

const HUG = "fit-content"
const FILL = "100%"

const STEM: Record<Axis, string> = { width: "w", height: "h" }

/** Panel-level, like the per-side toggles: the lock survives the rebuild each write causes. */
const ASPECT_LOCK = "layout.aspect-lock"

const MODE_WORD: Record<Mode, string> = { fixed: "Fixed", hug: "Hug", fill: "Fill" }

/** Figma's menu items, word for word. */
const MODE_ITEM: Record<Axis, Record<Mode, string>> = {
  width: { fixed: "Fixed width", hug: "Hug contents", fill: "Fill container" },
  height: { fixed: "Fixed height", hug: "Hug contents", fill: "Fill container" },
}

/**
 * The mode is a property of the *authored* value, and computed style resolves
 * every one of them to used pixels. So this reads what we wrote inline first,
 * then the Tailwind classes that are the actual source of truth.
 */
function modeOf(element: LayerElement, axis: Axis): Mode {
  const inline = element.style.getPropertyValue(axis).trim()
  if (inline === HUG || inline === "max-content" || inline === "auto") return "hug"
  if (inline === FILL) return "fill"
  if (inline) return "fixed"

  const stem = STEM[axis]
  for (const name of Array.from(element.classList)) {
    if (name === `${stem}-full` || name === `${stem}-[100%]`) return "fill"
    if (name === `${stem}-fit` || name === `${stem}-auto` || name === `${stem}-[${HUG}]`) return "hug"
    if (name.startsWith(`${stem}-`)) return "fixed"
  }
  return stretchesIn(element, axis) ? "fill" : "hug"
}

/**
 * Whether a flex parent makes this unsized axis fill: `flex-grow` along the
 * main axis, stretch across it. Figma reads both as Fill container, and a row
 * in a vertical list showing `Hug` while it spans the list would be wrong.
 */
function stretchesIn(element: LayerElement, axis: Axis): boolean {
  const parent = element.parentElement
  if (!parent) return false
  const outer = getComputedStyle(parent)
  if (outer.display !== "flex" && outer.display !== "inline-flex") return false
  const column = (outer.flexDirection ?? "").startsWith("column")
  const own = getComputedStyle(element)
  if ((axis === "height") === column) return Number.parseFloat(own.flexGrow) > 0
  const self = own.alignSelf
  if (self === "stretch") return true
  const items = outer.alignItems
  return (self === "auto" || self === "normal" || !self) && (items === "stretch" || items === "normal")
}

/**
 * A menu in a field's trailing slot: Figma's `Hug ⌄` and the gap's `⌄`.
 *
 * The face is drawn by us and a transparent native `<select>` lies over it, so
 * the slot can show a single word or a chevron while the menu, its keyboard
 * handling and its dismissal stay the platform's.
 */
export function fieldMenu(options: {
  label: string
  face: string | Node
  value: string
  /** `action` marks an entry that does something rather than naming a state, like "Apply token…". */
  items: Array<{ value: string; label: string; action?: boolean }>
  onPick(value: string): void
}): HTMLElement {
  const select = el("select", { class: "de-lay-menu-select", "aria-label": options.label }) as HTMLSelectElement
  for (const item of options.items) {
    const node = el("option", { value: item.value }, [item.label]) as HTMLOptionElement
    if (item.value === options.value) node.selected = true
    select.append(node)
  }
  select.addEventListener("change", () => {
    const picked = select.value
    // An action is not a state the field can be in, so the menu goes back to the
    // value it shows; a cancelled action then leaves nothing stale behind.
    if (options.items.some((item) => item.value === picked && item.action)) select.value = options.value
    options.onPick(picked)
  })
  return el("span", { class: "de-field-trailing de-lay-menu", title: options.label }, [
    el("span", { class: "de-lay-menu-face", "aria-hidden": "true" }, [options.face]),
    select,
  ])
}

/**
 * Whether this element's size is governed by a flex or grid layout, its own or
 * its parent's. Figma calls the row `Resizing` then and `Dimensions` otherwise.
 */
function inAutoLayout(element: LayerElement, computed: CSSStyleDeclaration): boolean {
  const lays = (display: string) => /^(inline-)?(flex|grid)$/.test(display)
  if (element.childElementCount > 0 && lays(computed.display)) return true
  const parent = element.parentElement
  return parent ? lays(getComputedStyle(parent).display) : false
}

/**
 * The `Dimensions` / `Resizing` row: [W] [H] and the aspect lock.
 *
 * Returns the row rather than a whole inspector section, because Layout is one
 * section built from several files — see `section-unified-layout.ts`.
 */
export function sizeControls(context: SectionContext): HTMLElement {
  const { selection, computed, writer, invalidate } = context
  const element = selection.element
  const rect = element.getBoundingClientRect()
  const locked = isExpanded(ASPECT_LOCK)
  // Measured at render, so a commit scales the other axis by the box as it was
  // drawn rather than by a ratio a previous locked edit already rounded.
  const ratio = rect.width > 0 && rect.height > 0 ? rect.height / rect.width : null

  const write = (axis: Axis, value: string, summary: string) => {
    writer.applyStyles(selection, [{ property: axis, value }], summary)
    invalidate()
  }

  /** The length writes for one axis, plus the other axis while the lock is on. */
  const lengths = (axis: Axis, value: number) => {
    const writes = [{ property: axis, value: `${Math.round(value)}px` }]
    if (locked && ratio) {
      const other: Axis = axis === "width" ? "height" : "width"
      const scaled = axis === "width" ? value * ratio : value / ratio
      writes.push({ property: other, value: `${Math.round(scaled)}px` })
    }
    return writes
  }

  const axisField = (axis: Axis, label: string, measured: number) => {
    const title = axis === "width" ? "Horizontal resizing" : "Vertical resizing"
    const mode = modeOf(element, axis)
    // Across a multi-selection: one shared size or "Mixed", and the mode word
    // only when every layer has that mode.
    const size = sharedValue(context, (_, entry) => Math.round(entry.element.getBoundingClientRect()[axis]))
    const sharedMode = sharedValue(context, (_, entry) => modeOf(entry.element, axis))

    const trailing = fieldMenu({
      label: `${title}: ${MODE_ITEM[axis][mode]}`,
      // The word only where it carries something. `Fixed` beside a number is the
      // number said twice, so that case draws the chevron Figma draws.
      face: mode === "fixed" || sharedMode === null ? icon("ChevronDown", tokens.icon.marker) : MODE_WORD[mode],
      value: mode,
      items: (["fixed", "hug", "fill"] as Mode[]).map((value) => ({ value, label: MODE_ITEM[axis][value] })),
      onPick: (next) => {
        if (next === "hug") write(axis, HUG, `Hug ${axis}`)
        else if (next === "fill") write(axis, FILL, `Fill ${axis}`)
        else write(axis, `${Math.round(measured)}px`, `Fixed ${axis}`)
      },
    })

    return numberField({
      id: `size.${axis}`,
      label,
      title,
      ...mixedNumber(size),
      min: 0,
      onPreview: (value) => {
        for (const entry of lengths(axis, value)) element.style.setProperty(entry.property, entry.value)
      },
      onCommit: (value) => {
        writer.applyStyles(selection, lengths(axis, value), `Set ${axis}`)
        invalidate()
      },
      trailing,
    })
  }

  return propRow({
    id: "layout.size",
    caption: inAutoLayout(element, computed) ? "Resizing" : "Dimensions",
    cells: [axisField("width", "W", rect.width), axisField("height", "H", rect.height)],
    trailing: trailingToggle({
      label: "Lock aspect ratio",
      glyph: icon("Constrain", tokens.icon.action),
      pressed: locked,
      onClick: () => {
        setExpanded(ASPECT_LOCK, !locked)
        invalidate()
      },
    }),
  })
}
