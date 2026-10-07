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
 * `W 708 Fill` once the mode is worth a word. It was a second row of segmented
 * controls under the pair, and the cost of that was structural rather than
 * decorative: two rows of chrome for one property, with the mode parked a whole
 * control away from the number it governs. Figma spells it the first way
 * (measured spec §5) and this now matches.
 */

import { el } from "../../core/dom"
import { icon } from "../../core/icons"
import { tokens } from "../../core/tokens"
import { group, numberField } from "./field"
import type { SectionContext } from "./index"
import type { LayerElement } from "../../core/types"

type Axis = "width" | "height"
type Mode = "fixed" | "hug" | "fill"

const HUG = "fit-content"
const FILL = "100%"

const STEM: Record<Axis, string> = { width: "w", height: "h" }

/**
 * The cycle the trailing button walks, and how each stop is spoken.
 *
 * A click steps to the next mode rather than opening a menu. Three states is
 * short enough that the furthest one is two clicks away, and a popover here
 * would be the panel's only one — a dismissal, focus-return and outside-click
 * problem bought for a choice with three answers. The price of cycling is that
 * the control cannot show where it is going, so the accessible name says it
 * outright: which mode the axis is in now, and which one pressing reaches.
 */
const MODE_ORDER: Mode[] = ["fixed", "hug", "fill"]
const MODE_WORD: Record<Mode, string> = { fixed: "Fixed", hug: "Hug", fill: "Fill" }
const MODE_MEANING: Record<Mode, string> = {
  fixed: "a fixed length",
  hug: `hug contents (${HUG})`,
  fill: `fill container (${FILL})`,
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
  return "hug"
}

/**
 * The `Dimensions` group: two fields, each one control end to end.
 *
 * Returns the group rather than a whole inspector section, because Layout is
 * one section made of two blocks and this is the first of them — see
 * `section-unified-layout.ts`.
 */
export function sizeControls({ selection, writer, invalidate }: SectionContext): HTMLElement {
  const element = selection.element
  const rect = element.getBoundingClientRect()

  const write = (axis: Axis, value: string, summary: string) => {
    writer.applyStyles(selection, [{ property: axis, value }], summary)
    invalidate()
  }

  const axisField = (axis: Axis, label: string, measured: number) => {
    const title = `${axis[0].toUpperCase()}${axis.slice(1)}`
    const mode = modeOf(element, axis)
    const next = MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length]

    const trailing = el(
      "button",
      {
        class: "de-field-trailing",
        type: "button",
        title: `${title}: ${MODE_WORD[mode]}. Press to set ${MODE_MEANING[next]}`,
        "aria-label": `${title} sizing: ${MODE_WORD[mode]}. Press to set ${MODE_MEANING[next]}`,
        onclick: () => {
          if (next === "hug") write(axis, HUG, `Hug ${axis}`)
          else if (next === "fill") write(axis, FILL, `Fill ${axis}`)
          else write(axis, `${Math.round(measured)}px`, `Fixed ${axis}`)
        },
      },
      // The word only where it carries something. `Fixed` beside a number is the
      // number said twice, so that case draws the chevron Figma draws and the
      // two interesting modes spend the space on their own name.
      [mode === "fixed" ? icon("ChevronDown", tokens.icon.marker) : MODE_WORD[mode]]
    )

    return numberField({
      id: `size.${axis}`,
      label,
      title,
      value: Math.round(measured),
      min: 0,
      disabled: mode !== "fixed",
      onPreview: (value) => element.style.setProperty(axis, `${Math.round(value)}px`),
      onCommit: (value) => write(axis, `${Math.round(value)}px`, `Set ${axis}`),
      trailing,
    })
  }

  return group(
    "Dimensions",
    el("div", { class: "de-row--split" }, [
      axisField("width", "W", rect.width),
      axisField("height", "H", rect.height),
    ])
  )
}
