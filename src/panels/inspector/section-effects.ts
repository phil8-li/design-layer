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
import { leaveRow } from "../../core/leave"
import { icon } from "../../core/icons"
import { tokens } from "../../core/tokens"
import { swatch, toHex } from "./color"
import { miniButton, numberField, selectField } from "./field"
import { styledSection } from "../../options/panel"
import { hasUtility, tokenRow } from "./token-row"
import type { InspectorSection } from "./index"

interface Shadow {
  inset: boolean
  x: number
  y: number
  blur: number
  spread: number
  color: string
}

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

  const add = miniButton({
    label: "Add effect",
    glyph: icon("Plus", tokens.icon.marker),
    onClick: () => commit([...rows, { shadow: DEFAULT_SHADOW, hidden: false }], "Add effect"),
  })

  /*
   * The shadow binding, and it sits ABOVE the stack on purpose.
   *
   * This section models `box-shadow` as a list of parsed layers with an eye
   * each; a shadow token binds the whole declaration in one write. Those are two
   * views of one property, and they cannot both be authoritative — so the panel
   * has to say which wins, and it is the token: picking one replaces the
   * declaration, layers and all, and the cards below redraw as whatever the
   * token turned out to be. Nothing here merges a token into layer three. The
   * parked rows are the one thing that survives it, and should: the eye is a
   * statement about a layer the designer switched off, not about the value that
   * happened to be painted when they did.
   *
   * Placement is how that gets said without a sentence. Under the cards it would
   * read as a fifth field on the last one, and a control that overwrites the
   * four cards above it must not look like it belongs to one of them. Above
   * them, before the list, it reads as what it is: the whole effect, with the
   * per-layer breakdown underneath as the long form of the same answer.
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

  const cards = rows.map((row, index) => {
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
        disabled: row.hidden,
        onPreview: (value) => preview(patch(value)),
        onCommit: (value) => replace(index, patch(value), `Set effect ${title.toLowerCase()}`),
      })
    }

    return el("div", { class: "de-paint-card" }, [
      el("div", { class: "de-paint-row" }, [
        swatch(row.shadow.color, "Effect color", (hex) => replace(index, { color: hex }, "Set effect color")),
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
        miniButton({
          label: row.hidden ? "Show effect" : "Hide effect",
          glyph: row.hidden ? "◎" : "◉",
          pressed: row.hidden,
          onClick: () =>
            commit(
              rows.map((entry, at) => (at === index ? { ...entry, hidden: !entry.hidden } : entry)),
              row.hidden ? "Show effect" : "Hide effect"
            ),
        }),
        miniButton({
          label: "Remove effect",
          glyph: icon("Minus", tokens.icon.marker),
          danger: true,
          onClick: (event: Event) => {
            // The whole CARD leaves, not just its first row: an effect is four
            // rows of one object, and collapsing the top one would leave three
            // orphaned lines standing where the thing they described was.
            const card = (event.currentTarget as HTMLElement).closest(".de-paint-card")
            const write = () => commit(rows.filter((_, at) => at !== index), "Remove effect")
            const closing = card instanceof HTMLElement ? leaveRow(card) : null
            if (closing) void closing.then(write)
            else write()
          },
        }),
      ]),
      el("div", { class: "de-row--split" }, [scalar("x", "X", "Offset X"), scalar("y", "Y", "Offset Y")]),
      el("div", { class: "de-row--split" }, [scalar("blur", "B", "Blur"), scalar("spread", "S", "Spread")]),
      el("div", { class: "de-hint" }, [toHex(row.shadow.color) ?? row.shadow.color]),
    ])
  })

  /*
   * No layers is no longer the end of the section.
   *
   * It used to return early with a bare `No effects.` hint, which was true about
   * the stack and wrong about everything else: an element with a transition and
   * no shadow still has a motion duration to bind, and an element wearing a
   * `shadow-*` utility that computes to `none` — a `shadow-none` override, a
   * variant that only paints on hover — still has a shadow axis to point at a
   * token. Both were unreachable, because the row that would have said so was
   * below a `return`.
   *
   * The hint now describes the stack rather than the section, and it stays: the
   * cards are the only thing here a designer adds to, so the empty list needs a
   * word where the rows would be. The `+` rides on the header in both states, as
   * it always did.
   */
  const body = el("div", { class: "de-stack" }, [
    shadowBinding,
    cards.length
      ? el("div", { class: "de-stack" }, cards)
      : el("div", { class: "de-hint" }, ["No effects"]),
    motionBinding,
  ])

  return styledSection(context, "effects", "Effects", body, add)
}
