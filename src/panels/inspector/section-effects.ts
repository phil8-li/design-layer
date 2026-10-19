/**
 * Effects — the one genuinely stackable paint in CSS.
 *
 * `box-shadow` is a comma list, so this is Figma's row model for real: add,
 * reorder-free stacking, a per-row eye that parks an effect without losing its
 * values, and a remove. Everything is serialised back into one declaration.
 *
 * ## The two token rows that moved in
 *
 * The `Design system` section is gone and its rows went to whichever section
 * owns their property (`token-row.ts` carries the argument). Two landed here.
 *
 * `shadow` is the obvious one and the awkward one — see the comment on the
 * binding below. `motion-duration` is neither: a transition is not an effect in
 * Figma's sense at all, because Figma has no transitions. It is here because
 * this is the only section in the panel about how the box PRESENTS itself
 * rather than where it sits or what it contains, and how long that presentation
 * takes to arrive is the same kind of question as how far the shadow is thrown.
 * The alternative was a `Motion` section holding exactly one row, which is a
 * header, a chevron and a fold state spent on a single select — more panel for
 * less information, and one more place a designer has to look.
 */

import { el, round } from "../../core/dom"
import { leaveRow, revealGroup } from "../../core/leave"
import { icon } from "../../core/icons"
import { tokens } from "../../core/tokens"
import { alphaOf, emptyPaintSection, paintRow, withAlpha } from "./color"
import { isExpanded, miniButton, numberField, propRow, selectField, setExpanded, takeJustExpanded } from "./field"
import { styledSection } from "../../options/panel"
import { hasUtility, tokenRow } from "./token-row"
import { isMulti, mixedPaintSection, selectedOf, sharedValue } from "./multi"
import type { InspectorSection } from "./index"

interface Shadow {
  inset: boolean
  x: number
  y: number
  blur: number
  spread: number
  color: string
}

const EXPANDER = "effects"
const DEFAULT_SHADOW: Shadow = { inset: false, x: 0, y: 2, blur: 8, spread: 0, color: "#00000026" }

/** Effects parked by the eye, keyed by element — see the Fill section's note. */
const parked = new Map<string, Array<{ index: number; shadow: Shadow }>>()

/** Splits on commas that are not inside `rgb()`/`hsl()`/`var()`. */
function splitLayers(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let at = 0; at < value.length; at += 1) {
    const char = value[at]
    if (char === "(") depth += 1
    else if (char === ")") depth -= 1
    else if (char === "," && depth === 0) {
      parts.push(value.slice(start, at))
      start = at + 1
    }
  }
  parts.push(value.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

function parseShadow(raw: string): Shadow | null {
  const inset = /\binset\b/.test(raw)
  let rest = raw.replace(/\binset\b/, " ")
  const colorMatch = rest.match(/(?:rgba?|hsla?)\([^)]*\)|#[0-9a-f]{3,8}\b/i)
  const color = colorMatch ? colorMatch[0] : "#000000"
  if (colorMatch) rest = rest.replace(colorMatch[0], " ")
  const lengths = rest.match(/-?\d*\.?\d+px/g)
  if (!lengths || lengths.length < 2) return null
  const [x, y, blur = "0px", spread = "0px"] = lengths
  return {
    inset,
    x: Number.parseFloat(x),
    y: Number.parseFloat(y),
    blur: Number.parseFloat(blur),
    spread: Number.parseFloat(spread),
    color,
  }
}

function serialize(shadow: Shadow): string {
  const lengths = `${round(shadow.x)}px ${round(shadow.y)}px ${round(shadow.blur)}px ${round(shadow.spread)}px`
  return `${shadow.inset ? "inset " : ""}${lengths} ${shadow.color}`
}

export const effectsSection: InspectorSection = (context) => {
  // Destructured here rather than in the parameter list: the token helpers below
  // take the whole `SectionContext`, and a partial rebuilt from four of its
  // fields is a second, silently divergent copy of the panel's own state.
  const { selection, computed, writer, invalidate } = context

  const visible =
    computed.boxShadow === "none" ? [] : splitLayers(computed.boxShadow).map(parseShadow).filter((s): s is Shadow => s !== null)

  // Re-seat the parked rows at the positions they were switched off from, so
  // hiding the middle effect of three does not shuffle the other two.
  const rows: Array<{ shadow: Shadow; hidden: boolean }> = visible.map((shadow) => ({ shadow, hidden: false }))
  for (const entry of parked.get(selection.key) ?? []) {
    rows.splice(Math.min(entry.index, rows.length), 0, { shadow: entry.shadow, hidden: true })
  }

  const commit = (next: Array<{ shadow: Shadow; hidden: boolean }>, summary: string) => {
    const held = next.map((row, index) => ({ index, shadow: row.shadow })).filter((_, index) => next[index].hidden)
    if (held.length) parked.set(selection.key, held)
    else parked.delete(selection.key)

    const painted = next.filter((row) => !row.hidden).map((row) => serialize(row.shadow))
    writer.applyStyles(selection, [{ property: "box-shadow", value: painted.join(", ") || "none" }], summary)
    invalidate()
  }

  const replace = (index: number, patch: Partial<Shadow>, summary: string) => {
    const next = rows.map((row, at) => (at === index ? { ...row, shadow: { ...row.shadow, ...patch } } : row))
    commit(next, summary)
  }

  // Different shadows across the selection: Figma's hint, and `+` replaces
  // every layer's effects with the one default shadow.
  const mixed = isMulti(context) && sharedValue(context, (style) => style.boxShadow) === null

  const add = miniButton({
    label: "Add effect",
    glyph: icon("Plus", tokens.icon.marker),
    onClick: () => {
      if (!mixed) return commit([...rows, { shadow: DEFAULT_SHADOW, hidden: false }], "Add effect")
      for (const entry of selectedOf(context)) parked.delete(entry.key)
      commit([{ shadow: DEFAULT_SHADOW, hidden: false }], "Add effect")
    },
  })
  if (mixed) return mixedPaintSection(context, "effects", "Effects", add)

  /*
   * The shadow binding, and it sits ABOVE the stack on purpose.
   *
   * This section models `box-shadow` as a list of parsed layers with an eye
   * each; a shadow token binds the whole declaration in one write. Those are two
   * views of one property, and they cannot both be authoritative — so the panel
   * has to say which wins, and it is the token: picking one replaces the
   * declaration, layers and all, and the rows below redraw as whatever the
   * token turned out to be. Nothing here merges a token into layer three. The
   * parked rows are the one thing that survives it, and should: the eye is a
   * statement about a layer the designer switched off, not about the value that
   * happened to be painted when they did.
   *
   * Placement says that without a sentence. Under the rows it would read as a
   * setting of the last effect; above them it reads as the whole effect, with
   * the per-layer rows as the long form of the same answer.
   */
  const shadowBinding =
    computed.boxShadow !== "none" || hasUtility(selection.element, "shadow")
      ? tokenRow(context, "shadow", "Shadow / effect")
      : null

  /*
   * Last, and outside the stack entirely — this one is about time, not paint.
   * A transition the element does not have is a row with nothing to bind, so
   * the gate is the duration itself rather than a class stem: `transition-*`
   * utilities set a property each and none of them implies a duration.
   */
  const motionBinding =
    Number.parseFloat(computed.transitionDuration) > 0
      ? tokenRow(context, "motion-duration", "Motion duration")
      : null

  const blocks = rows.map((row, index) => {
    const preview = (patch: Partial<Shadow>) => {
      if (row.hidden) return
      const drafted = rows.map((entry, at) => (at === index ? { ...entry, shadow: { ...entry.shadow, ...patch } } : entry))
      selection.element.style.setProperty(
        "box-shadow",
        drafted.filter((entry) => !entry.hidden).map((entry) => serialize(entry.shadow)).join(", ") || "none"
      )
    }

    const scalar = (key: "x" | "y" | "blur" | "spread", label: string, title: string) => {
      const patch = (value: number): Partial<Shadow> => {
        const draft: Partial<Shadow> = {}
        draft[key] = value
        return draft
      }
      return numberField({
        id: `effects.${index}.${key}`,
        label,
        title,
        value: row.shadow[key],
        min: key === "blur" ? 0 : undefined,
        disabled: row.hidden,
        onPreview: (value) => preview(patch(value)),
        onCommit: (value) => replace(index, patch(value), `Set effect ${title.toLowerCase()}`),
      })
    }

    /*
     * Figma opens an effect's numbers in a popover from the row's icon. Here
     * they open under the row instead, remembered per effect index, so the
     * closed list is one row per effect and an open one stays open across the
     * rebuild every commit causes.
     */
    const key = `${EXPANDER}.${index}`
    const open = isExpanded(key)
    const settings = miniButton({
      label: "Effect settings",
      glyph: icon("Settings", tokens.icon.action),
      onClick: () => {
        setExpanded(key, !open)
        invalidate()
      },
    })
    settings.setAttribute("aria-expanded", String(open))

    const head = el("div", { class: "de-paint-row" }, [
      el("div", { class: "de-effect-well" }, [
        settings,
        selectField({
          id: `effects.${index}.type`,
          label: "Effect type",
          value: row.shadow.inset ? "inner" : "drop",
          options: [
            { value: "drop", label: "Drop shadow" },
            { value: "inner", label: "Inner shadow" },
          ],
          onCommit: (value) => replace(index, { inset: value === "inner" }, "Set effect type"),
        }),
      ]),
      miniButton({
        label: row.hidden ? "Show effect" : "Hide effect",
        glyph: icon(row.hidden ? "EyeOff" : "Eye", tokens.icon.action),
        onClick: () =>
          commit(
            rows.map((entry, at) => (at === index ? { ...entry, hidden: !entry.hidden } : entry)),
            row.hidden ? "Show effect" : "Hide effect"
          ),
      }),
    ])
    if (row.hidden) head.classList.add("de-paint-row--hidden")

    const remove = miniButton({
      label: "Remove effect",
      glyph: icon("Minus", tokens.icon.action),
      danger: true,
      onClick: (event: Event) => {
        // The whole effect leaves, its open settings with it.
        const block = (event.currentTarget as HTMLElement).closest(".de-effect")
        const write = () => commit(rows.filter((_, at) => at !== index), "Remove effect")
        const closing = block instanceof HTMLElement ? leaveRow(block) : null
        if (closing) void closing.then(write)
        else write()
      },
    })

    const details = open
      ? el("div", { class: "de-effect-settings" }, [
          propRow({ id: `effects.${index}.offset`, cells: [scalar("x", "X", "Offset X"), scalar("y", "Y", "Offset Y")] }),
          propRow({ id: `effects.${index}.size`, cells: [scalar("blur", "B", "Blur"), scalar("spread", "S", "Spread")] }),
          paintRow({
            id: `effects.${index}.color`,
            label: "Effect color",
            value: row.shadow.color,
            live: !row.hidden,
            binding: null,
            onColor: (next) =>
              replace(index, { color: withAlpha(next, alphaOf(row.shadow.color)) ?? next }, "Set effect color"),
            alpha: {
              onPreview: (alpha) => {
                const next = withAlpha(row.shadow.color, alpha)
                if (next) preview({ color: next })
              },
              onCommit: (alpha) => {
                const next = withAlpha(row.shadow.color, alpha)
                if (next) replace(index, { color: next }, "Set effect opacity")
              },
            },
          }),
        ])
      : null
    if (details && takeJustExpanded(key)) revealGroup(details)

    return el("div", { class: "de-effect" }, [
      propRow({ id: `effects.${index}`, cells: [head], trailing: remove }),
      details,
    ])
  })

  if (!blocks.length) return emptyPaintSection(context, "effects", "Effects", add, [shadowBinding, motionBinding])

  const body = el("div", { class: "de-stack" }, [shadowBinding, ...blocks, motionBinding])

  return styledSection(context, "effects", "Effects", body, add)
}
