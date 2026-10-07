/**
 * The left panel's third view, "Design options": every tunable the running app
 * exposes, drawn the way a leva panel draws them.
 *
 * ## Why this is a docked pane and not the window it used to be
 *
 * This content spent a release inside a 460px `role="dialog"` pinned to the
 * bottom-left of the canvas, mounted on `document.body`, for one reason: it had
 * to SURVIVE DESELECTION, because a list of everything the app can be tuned
 * with must not require picking something first. That requirement is real, and
 * surviving deselection is the left panel's ordinary behavior. The window paid
 * for its copy of that with a fixed position, a z-index over the app, a close
 * button and a window-capture Escape listener, none of which a pane needs.
 *
 * ## Why app-scoped options belong on the LEFT
 *
 * `panels/left.ts` argues the strip is about SCOPE, not about editability: the
 * right panel operates on the selection, the left panel holds the subject and
 * the browsing. `readInventory()` takes no selection argument and a write goes
 * to the app's own store, so an option edits the app, and the app is this
 * column's subject.
 *
 * ## One row, one control
 *
 * A row is a label and the thing that sets it: a switch for on/off, a slider
 * and a number for a bounded number, a swatch for a color, the named choices
 * for a select. Rows used to carry a type eyebrow, the dot path, and a "Delete
 * this control?" explainer each, under a count note and over a second
 * explainer — five lines of chrome for one switch. The path is in the label's
 * tooltip now; the rest restated what the control itself shows. The filter
 * appears once a list is long enough to need one (`FILTER_FROM`), and the scope
 * switch only when the host has bound some option to elements, because
 * without a binding it can only ever scope to nothing.
 *
 * ## Names
 *
 * The tab says "Design options": what a designer calls the toggles a prototype
 * ships with. In code the thing is still a CONTROL (`LevaControl`,
 * `controlRow`) and a select's entries are its CHOICES. The right panel's saved
 * styles are a different thing and are never called options here.
 */

import { clear, el } from "../core/dom"
import { icon } from "../core/icons"
import type { EditorContext } from "../core/context"
import {
  controlValueAtPath,
  filterControls,
  filterTree,
  formatValue,
  highlightControlTargets,
  isControlRelevantToElement,
  readInventory,
  setControlValue,
  subscribeToLeva,
  targetsForControl,
} from "../options/inventory"
import type { LevaControl, LevaFolder } from "../options/inventory"
import type { LeftPanelTab } from "./left"
import { tokens } from "../core/tokens"
import { selectField } from "./inspector/field"

const defaultStateCache = new Map<string, boolean>()

/** A list this short is read at a glance; a filter over it is a field to skip. */
export const FILTER_FROM = 8

/** A list this long or shorter opens every section; a longer one starts folded. */
const OPEN_UP_TO = 24

/** Past this many choices a select reads better as a menu than as chips. */
const CHIPS_UP_TO = 8

/** A value that names a CSS color, so it can be shown as one. */
const COLOR_TEXT = /^(#[0-9a-f]{3,8}|(rgb|hsl|hwb|lab|lch|oklab|oklch|color)a?\([^;{}]*\))$/i

function colorOf(value: unknown): string | null {
  return typeof value === "string" && COLOR_TEXT.test(value.trim()) ? value.trim() : null
}

/** `#rgb` / `#rrggbb` as the `#rrggbb` an `<input type="color">` accepts. */
function hex6(value: unknown): string | null {
  if (typeof value !== "string") return null
  const text = value.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(text)) return text
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text)
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : null
}

/** A painted dot of the color itself. Set through `style`, never a CSS string. */
function swatch(color: string): HTMLElement {
  const dot = el("span", { class: "de-opt-swatch", "aria-hidden": "true" })
  dot.style.background = color
  return dot
}

/** The host's panel has the last word on a value; say so, and name the way on. */
function rejected(editor: EditorContext, control: LevaControl, what = "that value"): void {
  editor.toast(`${control.label} rejected ${what}. Try another value.`, "error")
}

/** Named choices as chips — the answer to "what options do we have?", always shown. */
function chips(control: LevaControl, editor: EditorContext): HTMLElement {
  const names = control.variants ?? []
  const values = control.variantValues ?? []
  const buttons: HTMLElement[] = names.map((name, index) => {
    const color = colorOf(values[index])
    return el(
      "button",
      {
        class: "de-opt-chip",
        type: "button",
        disabled: control.disabled,
        "aria-pressed": String(values[index] === control.value),
        title: `Set ${control.label} to “${name}”`,
        onclick: () => {
          if (!setControlValue(control.path, values[index])) {
            rejected(editor, control, `“${name}”`)
            return
          }
          // Repaint the pressed state in place rather than re-rendering: a
          // rebuild would drop the focus the user just put on this chip.
          for (const [other, button] of buttons.entries()) {
            button.setAttribute("aria-pressed", String(other === index))
          }
        },
      },
      [color ? swatch(color) : null, name]
    )
  })
  return el(
    "div",
    { class: "de-opt-chips", role: "group", "aria-label": `${control.label} choices` },
    buttons
  )
}

/** A long list of choices, as the inspector's own menu. */
function choiceMenu(control: LevaControl, editor: EditorContext): HTMLElement {
  const names = control.variants ?? []
  const values = control.variantValues ?? []
  const at = values.findIndex((value) => value === control.value)
  const menu = selectField({
    label: control.label,
    value: String(at),
    options: names.map((name, index) => ({ value: String(index), label: name })),
    onCommit: (index) => {
      if (!setControlValue(control.path, values[Number(index)])) rejected(editor, control)
    },
  })
  const select = menu.querySelector("select")
  if (select) select.disabled = control.disabled
  return menu
}

/**
 * On/off, as the chrome's switch.
 *
 * `.de-instance-switch` is the inspector's drawing, reused rather than drawn a
 * fourth time (`css/variants.ts` keeps the tally). The state is painted on this
 * node before the write so the knob travels: the pane declines to rebuild
 * under a focused control, so nothing else would repaint it.
 */
function switchControl(control: LevaControl, editor: EditorContext): HTMLButtonElement {
  const button = el("button", {
    class: "de-instance-switch",
    type: "button",
    role: "switch",
    "aria-checked": String(control.value === true),
    "aria-label": control.label,
    disabled: control.disabled,
  }) as HTMLButtonElement
  button.addEventListener("click", () => {
    const next = button.getAttribute("aria-checked") !== "true"
    button.setAttribute("aria-checked", String(next))
    if (setControlValue(control.path, next)) return
    button.setAttribute("aria-checked", String(!next))
    rejected(editor, control, next ? "on" : "off")
  })
  return button
}

/**
 * A number, as a short field — and a slider under it when the host gave bounds.
 *
 * The slider writes on every `input`, the way dragging leva's own slider does,
 * so the app moves under the hand; only a rejection at the end of the gesture
 * (`change`) is reported. The field takes typing, Enter, and the arrow keys
 * (Shift for ten steps), and clamps to the bounds.
 */
function numberControl(
  control: LevaControl,
  editor: EditorContext
): { field: HTMLElement; slider: HTMLElement | null } {
  const min = control.bounds?.min ?? null
  const max = control.bounds?.max ?? null
  const step = control.bounds?.step ?? null
  const clamp = (value: number) =>
    Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, value))
  const start = typeof control.value === "number" ? control.value : Number.NaN

  const field = el("input", {
    class: "de-opt-input de-opt-input--number",
    type: "text",
    inputmode: "decimal",
    "aria-label": `${control.label} value`,
    value: control.valueText,
    disabled: control.disabled,
  }) as HTMLInputElement

  const slider =
    min !== null && max !== null && max > min
      ? (el("input", {
          class: "de-opt-slider",
          type: "range",
          min: String(min),
          max: String(max),
          step: step === null ? "any" : String(step),
          value: String(Number.isNaN(start) ? min : start),
          "aria-label": control.label,
          disabled: control.disabled,
        }) as HTMLInputElement)
      : null

  /** How far along the track the value is — the slider's filled part. */
  const fill = (value: number) => {
    if (!slider || min === null || max === null) return
    slider.style.setProperty("--de-fill", `${((clamp(value) - min) / (max - min)) * 100}%`)
  }
  fill(start)

  const commit = (value: number) => {
    const next = clamp(value)
    field.value = formatValue(next)
    if (slider) slider.value = String(next)
    fill(next)
    if (!setControlValue(control.path, next)) rejected(editor, control)
  }

  field.addEventListener("change", () => {
    const parsed = Number.parseFloat(field.value)
    if (Number.isNaN(parsed)) field.value = control.valueText
    else commit(parsed)
  })
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault()
      field.dispatchEvent(new Event("change"))
      field.blur()
      return
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    event.preventDefault()
    const current = Number.parseFloat(field.value)
    const by = (step ?? 1) * (event.shiftKey ? 10 : 1) * (event.key === "ArrowUp" ? 1 : -1)
    commit((Number.isNaN(current) ? 0 : current) + by)
  })

  if (slider) {
    slider.addEventListener("input", () => {
      const value = Number(slider.value)
      field.value = formatValue(value)
      fill(value)
      setControlValue(control.path, value)
    })
    slider.addEventListener("change", () => {
      if (!setControlValue(control.path, Number(slider.value))) rejected(editor, control)
    })
  }

  return { field, slider }
}

/**
 * A color, as a swatch you can press and the text it stands for.
 *
 * The native picker only speaks `#rrggbb`, so a value in any other notation
 * keeps a painted swatch beside a text field instead of a picker that would
 * rewrite it. A color stored as an object is shown, not edited.
 */
function colorControl(control: LevaControl, editor: EditorContext): HTMLElement {
  if (typeof control.value !== "string") return valueText(control)
  const hex = hex6(control.value)
  const text = el("input", {
    class: "de-opt-input de-opt-input--color",
    type: "text",
    "aria-label": `${control.label} value`,
    value: control.value,
    disabled: control.disabled,
  }) as HTMLInputElement
  const picker = hex
    ? (el("input", {
        class: "de-opt-color",
        type: "color",
        value: hex,
        "aria-label": `${control.label} color`,
        disabled: control.disabled,
      }) as HTMLInputElement)
    : null
  const painted = colorOf(control.value)

  picker?.addEventListener("input", () => {
    text.value = picker.value
    setControlValue(control.path, picker.value)
  })
  picker?.addEventListener("change", () => {
    if (!setControlValue(control.path, picker.value)) rejected(editor, control)
  })
  const send = () => {
    if (!setControlValue(control.path, text.value)) {
      rejected(editor, control)
      return
    }
    const next = hex6(text.value)
    if (picker && next) picker.value = next
  }
  text.addEventListener("change", send)
  text.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return
    event.preventDefault()
    send()
    text.blur()
  })

  return el("span", { class: "de-opt-color-field" }, [
    picker ?? (painted ? swatch(painted) : null),
    text,
  ])
}

/** Free text, on its own line under the label: strings run long. */
function textControl(control: LevaControl, editor: EditorContext): HTMLElement {
  const input = el("input", {
    class: "de-opt-input de-opt-input--text",
    type: "text",
    "aria-label": `${control.label} value`,
    value: typeof control.value === "string" ? control.value : control.valueText,
    disabled: control.disabled,
  }) as HTMLInputElement
  const send = () => {
    if (!setControlValue(control.path, input.value)) rejected(editor, control)
  }
  input.addEventListener("change", send)
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return
    event.preventDefault()
    send()
    input.blur()
  })
  return input
}

/**
 * A value this pane cannot edit (a vector, an interval, a button), read-only.
 *
 * `valueText` is cut at 61 characters by `formatValue`, and a leva value is in
 * no file the Code tab shows, so the whole of it rides in `title`.
 */
function valueText(control: LevaControl): HTMLElement {
  const full = formatValue(control.value, false)
  const color = colorOf(control.value)
  return el(
    "span",
    { class: "de-opt-value", ...(full === control.valueText ? {} : { title: full }) },
    [color ? swatch(color) : null, control.valueText]
  )
}

function defaultUrl(editor: EditorContext, control: LevaControl): string | null {
  if (!control.defaultGroup || !control.defaultKey) return null
  const query = new URLSearchParams({ group: control.defaultGroup, key: control.defaultKey })
  return `${editor.apiBase}/control-default?${query}`
}

function sourceDefaultActions(control: LevaControl, editor: EditorContext): HTMLElement | null {
  const url = defaultUrl(editor, control)
  if (!url || !control.canPersistDefault) return null

  const status = el("span", { class: "de-opt-tag", "aria-live": "polite" }, ["source-linked"])
  const apply = el("button", { class: "de-button", type: "button" }, ["Apply to code"])
  const remove = el(
    "button",
    { class: "de-button de-button--danger", type: "button" },
    ["Delete saved default"]
  )

  const setState = (exists: boolean) => {
    defaultStateCache.set(url, exists)
    status.textContent = exists ? "saved" : "not saved"
    apply.textContent = exists ? "Update default" : "Apply to code"
    ;(apply as HTMLButtonElement).disabled = control.disabled
    ;(remove as HTMLButtonElement).disabled = control.disabled || !exists
  }

  const refresh = async () => {
    try {
      const response = await fetch(url, { headers: { accept: "application/json" } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const result = (await response.json()) as { exists?: boolean }
      setState(result.exists === true)
    } catch {
      status.textContent = "source unavailable"
      editor.toast(
        `Could not read the saved default for ${control.label}. Reload the page, then try again.`,
        "error"
      )
    }
  }

  apply.addEventListener("click", async () => {
    const current = controlValueAtPath(control.path)
    const value = current === undefined ? control.value : current
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setState(true)
      editor.toast(`Updated source default for ${control.label}`)
    } catch {
      // The live value already moved; only the durable copy did not. Saying so
      // is the difference between "try again" and "redo the whole adjustment".
      editor.toast(
        {
          title: "Default not saved",
          description: `${control.label} is set here, but its default was not saved to code. Try again.`,
        },
        "error"
      )
    }
  })

  remove.addEventListener("click", async () => {
    try {
      const response = await fetch(url, { method: "DELETE" })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setState(false)
      editor.toast(`Deleted the saved default for ${control.label}`)
    } catch {
      editor.toast(
        `Could not delete the saved default for ${control.label}. Try again, or delete it in the source file.`,
        "error"
      )
    }
  })

  const actions = el("div", { class: "de-opt-actions" }, [status, apply, remove])
  const cached = defaultStateCache.get(url)
  if (cached !== undefined) setState(cached)
  else {
    // A large host may expose hundreds of controls. Read this one literal only
    // when the row is approached rather than parsing the same source file once
    // per collapsed row on panel open.
    let requested = false
    const request = () => {
      if (requested) return
      requested = true
      void refresh()
    }
    actions.addEventListener("pointerenter", request, { once: true })
    actions.addEventListener("focusin", request, { once: true })
  }
  return actions
}

/** "Show 3 affected": only where the host bound this option to elements. */
function highlightAction(control: LevaControl, editor: EditorContext): HTMLElement | null {
  if (!control.relationship) return null
  const targets = targetsForControl(control)
  return el("div", { class: "de-opt-actions" }, [
    el(
      "button",
      {
        class: "de-button",
        type: "button",
        title: `Highlight elements this option ${control.relationship}`,
        onclick: () => {
          const resolved = highlightControlTargets(control)
          if (!resolved?.elements.length) {
            editor.toast(
              `Nothing on this page uses ${control.label}. Open a page that does, then try again.`,
              "error"
            )
          }
        },
      },
      [targets?.elements.length ? `Show ${targets.elements.length} affected` : "Show affected"]
    ),
  ])
}

export function controlRow(control: LevaControl, editor: EditorContext): HTMLElement {
  // No tooltip by default: one that repeats the visible label is noise, and the
  // dot path is a developer's address, not something a designer reads. A cut
  // label gets its tooltip from `titleTruncated`; a hidden one says why it is dim.
  const label = el(
    "span",
    {
      class: "de-opt-label",
      title: control.visible ? undefined : `${control.label} is hidden in the app right now`,
    },
    [control.label]
  )

  let kind = "value"
  let inline: HTMLElement | null = null
  let below: HTMLElement | null = null
  if (control.variants) {
    kind = "choice"
    below = control.variants.length > CHIPS_UP_TO ? choiceMenu(control, editor) : chips(control, editor)
  } else if (control.type === "BOOLEAN") {
    kind = "switch"
    inline = switchControl(control, editor)
  } else if (control.type === "NUMBER") {
    kind = "number"
    const number = numberControl(control, editor)
    inline = number.field
    below = number.slider
  } else if (control.type === "COLOR") {
    kind = "color"
    inline = colorControl(control, editor)
  } else if (control.type === "STRING") {
    kind = "text"
    below = textControl(control, editor)
  } else {
    inline = valueText(control)
  }

  // A switch row is a native <label> around its switch, so the whole line is
  // the target — the drawn track is 28x16, under the 24px a pointer wants —
  // and the browser routes a press on the words to the switch exactly once.
  // A handler on the line that called `.click()` fired twice in the live
  // editor and put the switch straight back.
  const line = el(kind === "switch" ? "label" : "div", { class: "de-opt-line" }, [label, inline])

  return el(
    "div",
    {
      class: "de-opt-row",
      "data-kind": kind,
      "data-path": control.path,
      "data-hidden": control.visible ? undefined : "",
    },
    [line, below, highlightAction(control, editor), sourceDefaultActions(control, editor)]
  )
}

/**
 * Which folders the reader opened or closed, by path, so a rebuild keeps them.
 *
 * The pane is rebuilt on every store write, and a `<details>` rebuilt from
 * scratch forgets that it was opened: flip a switch in a section, tab away,
 * and the next write folded the section shut under the reader.
 */
type FolderMemory = Map<string, boolean>

function folderNode(
  folder: LevaFolder,
  editor: EditorContext,
  depth: number,
  expand: boolean,
  memory: FolderMemory,
  startOpen = depth > 0
): HTMLElement {
  const summary = el("summary", { class: "de-opt-summary" }, [
    el("span", { class: "de-opt-twisty", "aria-hidden": "true" }, [icon("ChevronRight", tokens.icon.marker)]),
    // The name alone. A count beside it was one more thing to decode, and
    // the rows under it are the count. A truncated name gets its tooltip from
    // `titleTruncated` once it is on screen.
    el("span", { class: "de-opt-folder-name" }, [folder.name]),
    folder.hasSaveDefault
      ? el("span", { class: "de-opt-tag de-opt-tag--saved", title: "Values here can be saved as defaults" }, ["default"])
      : null,
  ])

  const body = el("div", { class: "de-opt-folder-body" }, [
    ...folder.controls.map((control) => controlRow(control, editor)),
    ...folder.folders.map((child) => folderNode(child, editor, depth + 1, expand, memory)),
  ])

  // A filter opens everything it matched; otherwise the reader's own choice
  // wins, and failing that the caller's default (nested folders open).
  const open = expand || (memory.get(folder.path) ?? startOpen)
  // The depth is what lets the summary's hover band reach both panel edges from
  // inside however many indented folder bodies it sits in (`css/options.ts`).
  const details = el(
    "details",
    { class: "de-opt-folder", open, style: `--de-opt-depth:${depth}` },
    [summary, body]
  ) as HTMLDetailsElement
  details.addEventListener("toggle", () => {
    // Chrome also fires `toggle` for a node created open, so a state equal to
    // the default is forgotten rather than remembered as a choice.
    if (expand) return
    if (details.open === startOpen) memory.delete(folder.path)
    else memory.set(folder.path, details.open)
  })
  return details
}

/**
 * A tooltip on each name the column cut off, and on nothing else. Measured
 * after layout, so it is right for the width the panel actually has.
 */
function titleTruncated(root: HTMLElement): void {
  for (const node of root.querySelectorAll<HTMLElement>(".de-opt-label, .de-opt-folder-name")) {
    if (node.hasAttribute("title") && node.closest("[data-hidden]")) continue
    if (node.scrollWidth > node.clientWidth) node.title = node.textContent ?? ""
    else node.removeAttribute("title")
  }
}

/** Whether the host bound any option to elements — the only case scope can narrow. */
function hasBindings(sections: readonly LevaFolder[]): boolean {
  return sections.some(
    (folder) =>
      folder.controls.some((control) => control.selectors.length > 0) || hasBindings(folder.folders)
  )
}

/**
 * An empty state in this pane: announced, headed, and with the way out attached.
 *
 * `role="status"` because the pane is rebuilt under a filter the reader is
 * still typing into, under a scope switch, and under the host's own control
 * store — so the list going empty is a change nobody's focus moved for. A
 * sighted reader watches the rows vanish; without this a screen-reader user
 * gets nothing at all. Polite rather than an alert, because most of these are
 * the answer to a keystroke.
 *
 * The headline is separate from the sentence because these states differ in
 * KIND — "this project has no control panel" and "your filter matched nothing"
 * want different first reactions — and a reader scanning a 240px column reads
 * the heading before the prose. Where a state has no distinct kind to announce,
 * the title is null and the sentence stands alone.
 *
 * The action is passed in rather than reached for. The filter and the scope
 * chips belong to the pane and outlive the body, which is rebuilt on every
 * keystroke; a button that closed over a stale node would be a way out that
 * stopped working the second time it was offered.
 */
function emptyState(title: string | null, text: string, action: HTMLElement | null): HTMLElement {
  return el("div", { class: "de-empty", role: "status" }, [
    title ? el("div", { class: "de-empty-title" }, [title]) : null,
    el("div", {}, [text]),
    action,
  ])
}

/**
 * The pane, built once and re-rendered in place.
 *
 * The filter and the scope chips are created ONCE and live outside the part
 * that is rebuilt, which is what lets the leva store fire on every drag frame
 * without the box you are typing in disappearing under you. Only `body` is
 * cleared, so nothing a rebuild can reach is ever focused except the rows
 * themselves — and the scheduler below declines to rebuild while one of those
 * holds focus.
 */
export function controlsTab(editor: EditorContext): LeftPanelTab {
  const filter = el("input", {
    class: "de-opt-filter",
    type: "search",
    placeholder: "Filter options",
    "aria-label": "Filter design options",
  }) as HTMLInputElement

  const body = el("div", { class: "de-opt-body" })
  const folderMemory: FolderMemory = new Map()

  /**
   * The scope switch, and why the unavailable chip is not `disabled`.
   *
   * A natively disabled button leaves the tab order and swallows pointer
   * events, so neither the browser's own tip nor this chrome's delegated
   * tooltip can ever fire on it — the reason a control is unavailable becomes
   * readable only once it is available. `aria-disabled` keeps the chip
   * reachable and announced, the handler returns early instead, and the reason
   * is in visible text beside it where it needs no hover at all. Never both
   * attributes: `disabled` would undo everything `aria-disabled` is here for.
   */
  const scopeReason = el("p", { class: "de-opt-reason" }, [
    "Select an element to scope this list.",
  ])
  const allChip = el("button", { class: "de-opt-chip", type: "button", role: "radio" }, ["All"])
  const elementChip = el("button", { class: "de-opt-chip", type: "button", role: "radio" }, [
    "This element",
  ])
  const scope = el("div", { class: "de-opt-scope" }, [
    el("div", { class: "de-opt-chips", role: "radiogroup", "aria-label": "Option scope" }, [
      allChip,
      elementChip,
    ]),
    scopeReason,
  ])

  const setScope = (next: "all" | "selection") => {
    if (next === "selection" && !editor.primarySelection()) return
    if (editor.getState().controlsScope === next) return
    editor.setState({ controlsScope: next })
  }
  allChip.addEventListener("click", () => setScope("all"))
  elementChip.addEventListener("click", () => setScope("selection"))

  /*
   * A radiogroup is ONE tab stop, and its arrows carry the choice with them.
   *
   * Both chips are native buttons, so without this they are two stops and the
   * arrows do nothing — a `role="radio"` keeping none of the promises the role
   * makes. The start screen's app list was built correctly in this same change;
   * this is deliberately the same pattern, so the two cannot drift.
   *
   * `setScope` rather than `.click()`, so a chip that is `aria-disabled`
   * refuses through the one guard that already knows why. Focus still MOVES to
   * it: the reason it is unavailable is a sentence sitting beside it, and
   * arrowing onto it is how a keyboard reader gets that sentence read out.
   */
  const chips = [allChip, elementChip]
  for (const chip of chips) {
    chip.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key
      const step =
        key === "ArrowRight" || key === "ArrowDown"
          ? 1
          : key === "ArrowLeft" || key === "ArrowUp"
            ? -1
            : 0
      if (step === 0) return
      event.preventDefault()
      const next = chips[(chips.indexOf(chip) + step + chips.length) % chips.length]
      next.focus()
      setScope(next === elementChip ? "selection" : "all")
    })
  }

  const node = el("div", { class: "de-controls" }, [filter, scope, body])

  filter.addEventListener("input", () => render())

  /** Whether this pane is on screen — a hidden tabpanel is not worth painting. */
  function showing(): boolean {
    if (!node.isConnected) return false
    for (let step: HTMLElement | null = node; step; step = step.parentElement) {
      if (step.hidden) return false
    }
    return true
  }

  /** What the body was last built for; see the early return in `render`. */
  let paintedKey: string | null = null

  function render(selectionOnly = false): void {
    const query = filter.value
    const selection = editor.primarySelection()
    // With nothing selected there is nothing to scope TO, so the pane shows
    // everything rather than an empty list explaining itself. The store keeps
    // whatever the user last asked for: reselecting an element puts them back
    // where they were instead of making them ask twice.
    const scoped = Boolean(selection) && editor.getState().controlsScope === "selection"
    allChip.setAttribute("aria-checked", String(!scoped))
    elementChip.setAttribute("aria-checked", String(scoped))
    elementChip.setAttribute("aria-disabled", String(!selection))
    scopeReason.hidden = Boolean(selection)

    /*
     * A selection change that cannot change the list stops at the chips.
     *
     * Unscoped before and after, with the same query, the body is a pure
     * function of the inventory, and the inventory reaches this pane through
     * `subscribeToLeva` and tab activation — both full renders. Rebuilding a
     * 177-row tree on every canvas click to draw it again unchanged was the
     * whole cost of clicking with this tab open.
     */
    const bodyKey = scoped ? "selection" : `all|${query}`
    if (selectionOnly && bodyKey === paintedKey && !scoped) return
    paintedKey = bodyKey

    clear(body)
    const inventory = readInventory()
    // The filter and the scope switch appear only where they can do something.
    // A query already typed keeps its field, so it can always be cleared.
    filter.hidden = !query && !(inventory.available && inventory.controlCount >= FILTER_FROM)
    scope.hidden = !(inventory.available && hasBindings(inventory.sections))
    if (!inventory.available) {
      body.append(emptyState(inventory.title, inventory.reason, null))
      return
    }

    const inScope =
      scoped && selection
        ? filterControls(inventory.sections, (control) =>
            isControlRelevantToElement(control, selection.element)
          )
        : inventory.sections

    if (scoped && inScope.length === 0) {
      body.append(
        emptyState(
          "No options affect this element",
          "Options still work. Map them in your config to see what each one affects.",
          el(
            "button",
            { class: "de-button", type: "button", onclick: () => setScope("all") },
            ["Show all options"]
          )
        )
      )
      return
    }

    const sections = filterTree(inScope, query)
    // Options are shown the way a leva panel shows them — on screen, not behind
    // a fold the reader has to find first. Only a long list starts with its
    // sections shut, so it reads as a map before it reads as rows.
    const startOpen = sections.length === 1 || inventory.controlCount <= OPEN_UP_TO
    requestAnimationFrame(() => titleTruncated(body))
    body.append(
      ...(sections.length
        ? sections.map((section) =>
            folderNode(section, editor, 0, query.trim().length > 0, folderMemory, startOpen)
          )
        : [
            emptyState(
              null,
              `No options match “${query}”. Try another name or value.`,
              el(
                "button",
                {
                  class: "de-button",
                  type: "button",
                  onclick: () => {
                    filter.value = ""
                    render()
                    // Back to the field, not to a button this call is about to
                    // delete from the document: the rows return, the empty
                    // state does not, and a keyboard user who pressed it would
                    // otherwise be dropped on the pane's body.
                    filter.focus()
                  },
                },
                ["Clear filter"]
              )
            ),
          ])
    )
  }

  /**
   * Invariant 5: never rebuild a surface out from under a focused control.
   *
   * Scoped to `body` rather than to the whole pane, which is the difference the
   * split above buys. The filter and the chips survive every rebuild, so a
   * reader typing a query no longer blocks the repaint their own typing asked
   * for; only a row control — a number field mid-edit, a chip mid-press — does.
   */
  const update = (selectionOnly = false): void => {
    if (body.contains(document.activeElement)) {
      // A full render refused here is still owed: the next selection must not
      // read the body as current.
      if (!selectionOnly) paintedKey = null
      return
    }
    render(selectionOnly)
  }

  /*
   * The host's control store fires on every drag frame, so a listener that
   * rendered straight through would rebuild a 177-row tree sixty times a
   * second. One frame's worth is coalesced and a hidden pane is skipped
   * entirely — switching to it renders it, which is the contract `left.ts`
   * keeps for every tab.
   */
  let scheduled = 0
  const schedule = () => {
    if (scheduled) return
    scheduled = requestAnimationFrame(() => {
      scheduled = 0
      if (!showing()) return
      update()
    })
  }
  // `showing` gates the tree walk that finds undeclared options: it runs only
  // while this list is on screen. The page-following and the published stores
  // are watched either way, so switching to the tab never shows a stale list.
  subscribeToLeva(schedule, showing)

  /*
   * The scope is written from two places — the chips here, and the right
   * panel's "N app controls affect this element" button, which sets it in the
   * same `setState` that opens this tab. So the pane cannot own the value as a
   * local: it has to read the store, and it has to hear about a write it did
   * not make. Rendered directly rather than through `schedule`, because a scope
   * change is a deliberate press and a frame of the old list is a frame of the
   * wrong answer.
   */
  editor.subscribe((next, previous) => {
    if (next.controlsScope === previous.controlsScope) return
    if (showing()) update()
  })

  return { node, update }
}
