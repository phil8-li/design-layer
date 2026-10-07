/**
 * Saved styles, scoped to the section they describe.
 *
 * A saved style is an `ElementOption` this editor owns, and every verb on
 * `optionsStore` takes a `Selection`. They used to live in a standalone "Saved
 * styles" section that snapshotted the whole element. Now each is scoped
 * (`options/scopes.ts`) and lives inside the section whose properties it
 * captures, the way Figma puts text styles in Typography and color styles in
 * Fill: Typography, Fill, Stroke, Effects, Appearance and Layout each get a
 * header button that opens this panel at the top of their body.
 *
 * The app's own leva controls are not here. They are a left-panel tab
 * (`panels/controls.ts`), because their verbs take no selection at all.
 */

import { el } from "../core/dom"
import { icon } from "../core/icons"
import { miniButton, section } from "../panels/inspector/field"
import { SCOPE_LABELS } from "./scopes"
import type { StyleScope } from "./scopes"
import { optionsStore } from "./store"
import type { SectionContext } from "../panels/inspector/index"
import type { ElementOption } from "../core/types"
import { tokens } from "../core/tokens"

/**
 * Which scopes have their styles panel open. Module-level so the inspector's
 * full rebuild after every store write keeps the panel the user just used open.
 */
const openScopes = new Set<StyleScope>()

/** Swaps the name for an input in place; Enter commits, Escape reverts. */
function startRename(
  name: HTMLElement,
  option: ElementOption,
  commit: (value: string) => void
): void {
  const input = el("input", {
    type: "text",
    value: option.name,
    "aria-label": "Style name",
  }) as HTMLInputElement
  // Keeps `.de-field`'s own 24px height, so the row does not shrink while
  // the name is being edited.
  const field = el("div", { class: "de-field", style: "flex:1" }, [input])
  // The row itself applies the style on click; renaming must not trigger that.
  field.addEventListener("click", (event) => event.stopPropagation())
  field.addEventListener("dblclick", (event) => event.stopPropagation())

  name.replaceWith(field)
  input.focus()
  input.select()

  let settled = false
  const finish = (keep: boolean) => {
    if (settled) return
    settled = true
    const value = input.value.trim()
    field.replaceWith(name)
    if (keep && value && value !== option.name) commit(value)
  }

  input.addEventListener("blur", () => finish(true))
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault()
      finish(true)
    }
    if (event.key === "Escape") {
      event.preventDefault()
      finish(false)
    }
  })
}

/**
 * A verb that is unavailable, kept in the tab order and told to say so.
 *
 * Never native `disabled`: a disabled button leaves the tab order and stops
 * receiving pointer events, so its `title` can never explain why it is greyed.
 * `aria-disabled` keeps it reachable and announced; the handler returns early.
 * This helper is the only place either attribute is written.
 */
function verb(
  content: Node | string,
  options: { className: string; label: string; title: string; unavailable: boolean; run: () => void }
): HTMLElement {
  return el(
    "button",
    {
      class: options.className,
      type: "button",
      title: options.title,
      "aria-label": options.label,
      "aria-disabled": String(options.unavailable),
      onclick: () => {
        if (options.unavailable) return
        options.run()
      },
    },
    [content]
  )
}

function styleRow(
  context: SectionContext,
  scope: StyleScope,
  option: ElementOption,
  active: boolean
): HTMLElement {
  const store = optionsStore(context.editor)
  const { selection, writer } = context

  // `option.name` is the one string here the user typed, so an ellipsis keeps
  // the whole of it in the title.
  const name = el("span", { class: "de-option-name", title: option.name }, [option.name])
  const apply = () => store.applyScoped(selection, writer, option, scope)

  // The radio is the choice itself; its verbs are siblings, because a `radio`
  // may not own a control.
  const choice = el(
    "div",
    {
      class: "de-option",
      role: "radio",
      tabindex: "0",
      "aria-checked": String(active),
      onclick: apply,
      onkeydown: (event: Event) => {
        const key = (event as KeyboardEvent).key
        if (key !== "Enter" && key !== " ") return
        event.preventDefault()
        apply()
      },
    },
    [icon("Grid2x2", tokens.icon.marker), name]
  )

  const beginRename = () =>
    startRename(name, option, (value) => store.rename(selection.key, option.id, value))
  // Double-click is a shortcut for the hand already on the name; the button is
  // the way in for a keyboard.
  name.addEventListener("dblclick", (event) => {
    event.stopPropagation()
    beginRename()
  })

  const rename = el(
    "button",
    {
      class: "de-option-rename",
      type: "button",
      title: "Rename this style",
      "aria-label": `Rename ${option.name}`,
      onclick: beginRename,
    },
    [icon("Pencil", tokens.icon.marker)]
  )

  const update = verb(icon("ArrowUpToLine", tokens.icon.marker), {
    className: "de-option-rename",
    label: `Update ${option.name} from this element`,
    title: active
      ? "Already matches this element"
      : "Overwrite this style with the element’s current values",
    unavailable: active,
    run: () => store.updateScoped(selection, option.id, scope),
  })

  const remove = el(
    "button",
    {
      class: "de-option-delete",
      type: "button",
      title: "Delete this style",
      "aria-label": `Delete ${option.name}`,
      onclick: () => store.removeStyle(selection, option.id),
    },
    [icon("X", tokens.icon.marker)]
  )

  return el("div", { class: "de-option-row" }, [choice, rename, update, remove])
}

/**
 * The styles control for one section: a header `action` that toggles the
 * panel, and a `body` to draw at the top of the section — the applied-style
 * row while the panel is shut, the full list while it is open. `body` is
 * `hidden` when the panel is shut and no style is applied.
 */
export function scopedStyles(
  context: SectionContext,
  scope: StyleScope
): { action: HTMLElement; body: HTMLElement } {
  const store = optionsStore(context.editor)
  void store.ready()
  const { selection, writer } = context

  const label = SCOPE_LABELS[scope]
  const plural = `${label}s`
  const lower = label.toLowerCase()
  const styles = store.stylesFor(selection.key, scope)
  const activeId = store.activeStyleId(selection, scope)
  const applied = activeId ? styles.find((style) => style.id === activeId) ?? null : null
  const open = openScopes.has(scope)

  // Which style is applied, visible without opening anything. While the panel
  // is open the checked radio says the same, so this row steps aside.
  const appliedRow = applied
    ? el("div", { class: "de-style-applied", title: `${label}: ${applied.name}` }, [
        icon("Grid2x2", tokens.icon.marker),
        el("span", { class: "de-option-name" }, [applied.name]),
        el("span", { class: "de-style-applied-kind" }, [label]),
      ])
    : null

  const list = styles.length
    ? el(
        "div",
        { class: "de-style-list", role: "radiogroup", "aria-label": plural },
        styles.map((style) => styleRow(context, scope, style, style.id === activeId))
      )
    : el("p", { class: "de-style-empty" }, [
        `No ${lower}s yet. Save this element’s ${scope} to reuse it.`,
      ])

  const noBaseline = !store.hasBaseline(selection.key)
  const actions = el("div", { class: "de-opt-actions" }, [
    verb(`Save as ${lower}`, {
      className: "de-button",
      label: `Save as ${lower}`,
      title: `Save this element’s ${scope} as a named ${lower}`,
      unavailable: false,
      run: () => store.saveScoped(selection, writer, scope),
    }),
    verb("Revert", {
      className: "de-button",
      label: `Revert ${scope}`,
      title: noBaseline
        ? "Apply a style first"
        : `Restore this element’s ${scope} from before its first style`,
      unavailable: noBaseline,
      run: () => store.revertScoped(selection, writer, scope),
    }),
  ])

  const panel = el("div", { class: "de-style-panel" }, [list, actions])
  const body = el("div", { class: "de-style-block" }, [appliedRow, panel])

  /*
   * Toggled in place rather than through `context.invalidate()`: a rebuild
   * would replace this button and drop keyboard focus off it. The Set keeps
   * the state across the rebuilds that store writes cause.
   */
  const paint = (isOpen: boolean) => {
    panel.hidden = !isOpen
    if (appliedRow) appliedRow.hidden = isOpen
    body.hidden = !isOpen && !appliedRow
    action.setAttribute("aria-expanded", String(isOpen))
  }
  const action = miniButton({
    label: plural,
    glyph: icon("Grid2x2", tokens.icon.marker),
    onClick: () => {
      const next = !openScopes.has(scope)
      if (next) openScopes.add(scope)
      else openScopes.delete(scope)
      paint(next)
    },
  })
  action.classList.add("de-style-toggle")
  if (applied) action.classList.add("de-style-toggle--applied")
  paint(open)

  return { action, body }
}

/**
 * `section()` with the scope's styles wired in: the toggle beside any existing
 * header action (`+`), and the styles block above the section's own body.
 */
export function styledSection(
  context: SectionContext,
  scope: StyleScope,
  title: string,
  body: HTMLElement,
  actions?: HTMLElement
): HTMLElement {
  const styles = scopedStyles(context, scope)
  const header = el("span", { class: "de-style-actions" }, [styles.action, actions ?? null])
  return section(title, el("div", { class: "de-stack" }, [styles.body, body]), header)
}
