/**
 * The icon section: which icon this `<svg>` is, and the set it can be swapped
 * for.
 *
 * Figma puts an instance's variant properties directly under the layer name,
 * before paint and box — the first question about a placed symbol is which
 * symbol it is. This section is registered in the same position, and it is the
 * only reason an `<svg>` is selectable at all.
 *
 * One field, one list of names, one glyph each. No file, no import, no
 * component spelling: a designer picking an icon is choosing a mark.
 *
 * ## Two controls, and they need not be about the same element
 *
 * `icon-size` moved here from the dissolved `Design system` section, and it
 * brought that section's target rule with it. The name field is about the
 * SELECTED element — it reads the icon attribute off it, and returns null when
 * there is none. The size row is about whatever `iconTarget` answers, which on
 * an icon-only host is the single `<svg>` inside it rather than the box the user
 * clicked. That is not a quirk to tidy away: a width on the `<button>` sizes the
 * button, and the thing a designer means by "icon size" is the glyph.
 *
 * So this is the one section in the panel whose two controls can be addressing
 * two different elements, and the row does not assume otherwise — it passes its
 * target and that target's own computed style explicitly, because reading the
 * selection's style for another element's property is how a row reports the
 * wrong number with full confidence.
 *
 * The two gates are narrower together than either is alone, and deliberately so
 * rather than by oversight: the name field needs the selection to BE an `<svg>`
 * carrying the host's icon attribute, and `iconTarget` answers with a selected
 * `<svg>` only when it declares itself an image. An icon-only `<button>` passes
 * the second and fails the first, so it gets no section at all — which is
 * right, because there is no icon NAME to show for a box, and a section holding
 * one size row would be claiming otherwise.
 *
 * The evidence comes from `iconSizeEvidence` rather than being assembled here:
 * the axis writes TWO declarations, width and height, so there is no single CSS
 * property for the helper to read back and a hand-built pair would silently
 * never match a token.
 */

import { loadIconSet, loadedIconSet, iconNameOf, type IconVariant } from "../../core/icon-set"
import { drawHostIcon } from "../../core/icons"
import { el } from "../../core/dom"
import { section } from "./field"
import { iconSizeEvidence, tokenRow } from "./token-row"
import { tokenField, type TokenChoice } from "./token-picker"
import type { InspectorSection, SectionContext } from "./index"
import { tokens } from "../../core/tokens"

/** Every icon is one flat set, so the picker's group headers stay out of the way. */
const GROUP = ""

function choiceFor(variant: IconVariant): TokenChoice {
  return {
    id: variant.name,
    group: GROUP,
    leaf: variant.name,
    name: variant.name,
    // 16px on the 24 grid: the same size the row's other previews occupy, and
    // the size the app draws most of these at.
    preview: { kind: "glyph", draw: () => drawHostIcon(variant, tokens.icon.action) },
    detail: "",
    disabled: false,
  }
}

/**
 * The size binding, about the `<svg>` this section is already about.
 *
 * The target is the SELECTION, not `iconTarget(context)`, and that difference
 * is the whole reason this is a function rather than one call inline.
 * `iconTarget` answers "which element near here is an icon" for a caller that
 * does not know — Fill and Stroke, handed a `<button>` and needing the glyph
 * inside it. It returns the selection itself only for an `<img>` or something
 * carrying `role="img"`, and otherwise takes its only-child branch.
 *
 * Neither branch fires here. This section has already established that the
 * selection IS the icon — `iconNameOf` found the host's icon attribute on it —
 * and an `<svg>` does not contain an `<svg>`, so the child branch finds
 * nothing. Routing through `iconTarget` therefore made the size row wait on a
 * `role="img"` that the editor never writes and Lucide's output does not emit:
 * unreachable for the ordinary case of selecting an icon, which is the only
 * case this section runs in at all.
 *
 * So it asks the question it can already answer.
 */
function sizeRow(context: SectionContext): HTMLElement | null {
  const target = context.selection
  const computed = getComputedStyle(target.element)
  return tokenRow(context, "icon-size", "Icon size", {
    target,
    computed,
    ...iconSizeEvidence(target.element, computed),
  })
}

export const iconSection: InspectorSection = (context) => {
  const current = iconNameOf(context.selection.element)
  if (!current) return null

  const variants = loadedIconSet()
  if (!variants.length) {
    // The set is 114KB, so it is fetched on the first icon selection rather than
    // at page load. Re-render when it lands: the field below is honest in the
    // meantime — it names the icon, it just cannot offer the others yet.
    void loadIconSet(context.editor.apiBase).then((loaded) => {
      if (loaded.length) context.invalidate()
    })
  }

  const field = tokenField({
    id: "icon.name",
    title: "Icon",
    selectedId: variants.some((variant) => variant.name === current) ? current : "",
    choices: variants.map(choiceFor),
    fallback: {
      preview: { kind: "none" },
      text: current,
    },
    onCommit: (id) => {
      const variant = variants.find((entry) => entry.name === id)
      if (!variant) return
      context.writer.applyIcon(context.selection, variant)
      context.invalidate()
    },
  })

  return section("Icon", el("div", { class: "de-stack" }, [field, sizeRow(context)]))
}
