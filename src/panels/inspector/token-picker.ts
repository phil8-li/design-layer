/**
 * The design-system token field and the picker it opens.
 *
 * Its own module because a picker is a surface, not a control: it owns a
 * popover, a filter, roving keyboard state and a way back to the field. In
 * `field.ts` it would sit in front of every other inspector section; in the
 * design-system section it would be buried under the catalog logic that decides
 * what the choices are.
 *
 * Nothing here knows what a token is. It takes choices that are already human —
 * a group, a leaf name, a preview — so "no machine spelling reaches the screen"
 * is a property of the type rather than something to re-remember per call site.
 */

import { clamp, clear, el } from "../../core/dom"
import { playExit, smoothScroll } from "../../core/motion"
import { focusControl } from "../../core/focus"
import { icon } from "../../core/icons"
import { tokens } from "../../core/tokens"

/** What the leading 16px slot draws. `none` keeps the name column aligned. */
export type TokenPreview =
  | { kind: "color"; css: string }
  | { kind: "text"; fontSize: number }
  | { kind: "radius"; px: number }
  // A drawing, not data about one: this module deliberately knows nothing about
  // icons, so the caller hands over the mark already made. Rebuilt per row
  // rather than shared, because a node can only be in one place at a time.
  | { kind: "glyph"; draw: () => SVGElement }
  | { kind: "none" }

export interface TokenChoice {
  id: string
  /** The path prefix, shown once as a sticky header rather than on every row. */
  group: string
  /** The segment after that prefix — the only name a row carries. */
  leaf: string
  /** The whole path, which is what the closed field reads. */
  name: string
  preview: TokenPreview
  /** A text style's `16/20`. Empty on every other axis. */
  detail: string
  /** Offered but inert. The row says so before the click, not a toast after it. */
  disabled: boolean
}

/**
 * The way out of the list, when the axis has one.
 *
 * Optional on purpose. An axis whose token is a bundle of declarations — a text
 * style, an icon's two sides — has no single raw form to type, and an axis that
 * refuses some of its own tokens for a reason would have that reason walked
 * around by a typed value. Those axes leave this out and the footer never
 * renders, rather than each of them remembering to suppress it.
 */
export interface TokenCustomValue {
  /** The shape the axis wants, shown in the empty field. Never read as prose. */
  placeholder: string
  onCommit(raw: string): void
}

export interface TokenFieldOptions {
  /** Stable identity so focus survives the panel rebuild a commit causes. */
  id: string
  title: string
  choices: TokenChoice[]
  /** Empty when nothing is bound, or when the binding is not certain. */
  selectedId: string
  /** The element's own value, in the plain spelling, for when nothing is bound. */
  fallback: { preview: TokenPreview; text: string }
  onCommit(id: string): void
  custom?: TokenCustomValue
  /**
   * Drop the field's own leading slot, because the caller already drew one.
   *
   * For the paint rows, and it exists because of what they looked like without
   * it. A fill, a stroke and a text colour are each `[well] [value]`, where the
   * well is a live `input[type=color]` — so folding the token binding in where
   * the value used to sit put a SECOND chip, the field's own preview, 4px to
   * the right of the first. Two swatches of one colour, only one of which
   * opens a picker.
   *
   * The one that goes is the field's. It is a read-out of the same value the
   * well already shows, and the well is the half you can act on; Figma draws
   * exactly one swatch per paint row for the same reason. Rows the picker still
   * leads — a radius, a text style, a shadow — are untouched, because they have
   * no well beside them and their preview is the only mark they get.
   *
   * The POPOVER keeps its previews either way: this hides the closed field's
   * slot, not the list's, and a list of colour names with no colours in it
   * would be the opposite of what the picker is for.
   */
  hidePreview?: boolean
}

const POPOVER_WIDTH = 264
const EDGE = 8
const SWATCH = 16
/**
 * The chip is a scale model of a box this wide, not a box 16px wide.
 *
 * Clamping the radius to half the chip made all eight tokens the same circle:
 * the smallest radius the system ships is already 8px. Drawing the chip as a
 * shrunken 96px card keeps the eight silhouettes eight different silhouettes,
 * and the pill still saturates the cap, so it still reads as a pill.
 */
const RADIUS_REFERENCE = 96

/** One picker at a time: opening a second closes the first. */
let dismiss: ((restoreFocus: boolean) => void) | null = null
/** Which field that picker belongs to, so its own field can close it again. */
let openFor: HTMLElement | null = null
/** Row ids have to be unique in the host document for `aria-activedescendant`. */
let pickerSeq = 0

/**
 * The leading slot.
 *
 * A text style previews its own face rather than describing it, clamped to the
 * slot: a 40px display style would otherwise set the height of every row in the
 * list it appears in.
 */
function previewNode(preview: TokenPreview): HTMLElement {
  if (preview.kind === "color") {
    return el("span", {
      class: "de-token-swatch de-token-swatch--color",
      style: `background:${preview.css}`,
    })
  }
  if (preview.kind === "text") {
    return el(
      "span",
      {
        class: "de-token-swatch de-token-swatch--text",
        style: `font-size:${Math.min(preview.fontSize, SWATCH - 3)}px`,
      },
      ["Ag"]
    )
  }
  if (preview.kind === "glyph") {
    return el("span", { class: "de-token-swatch de-token-swatch--glyph" }, [preview.draw()])
  }
  if (preview.kind === "radius") {
    const scaled = Math.min((preview.px / RADIUS_REFERENCE) * SWATCH, SWATCH / 2)
    return el("span", {
      class: "de-token-swatch de-token-swatch--radius",
      style: `border-radius:${Math.round(scaled * 100) / 100}px`,
    })
  }
  return el("span", { class: "de-token-swatch" })
}

/** Groups in first-appearance order; the catalog interleaves its paths. */
function grouped(choices: readonly TokenChoice[]): Array<[string, TokenChoice[]]> {
  const groups = new Map<string, TokenChoice[]>()
  for (const choice of choices) {
    const bucket = groups.get(choice.group)
    if (bucket) bucket.push(choice)
    else groups.set(choice.group, [choice])
  }
  return [...groups]
}

export function tokenField(options: TokenFieldOptions): HTMLElement {
  const selected = options.choices.find((choice) => choice.id === options.selectedId) ?? null
  const field = el(
    "button",
    {
      class: "de-token-field",
      type: "button",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      "aria-label": `${options.title} token`,
      "data-de-field": options.id,
    },
    [
      options.hidePreview ? null : previewNode(selected ? selected.preview : options.fallback.preview),
      /*
       * The bound token's full path in `title`, because the field shows it in
       * full and then clips it.
       *
       * The popover's rows can afford to print a leaf — the group prefix is a
       * sticky header above them — but the CLOSED field has no header to lean
       * on, so it carries the whole path in a cell that is a fraction of a
       * 260px panel. `Background/Surface/Raised/Hover` reaches the reader as
       * `Background/Surfa…`, which names the group and hides the answer. This
       * is the one control in the inspector whose entire purpose is to say
       * which token is bound.
       */
      el(
        "span",
        {
          class: selected ? "de-token-field-name" : "de-token-field-name de-token-field-name--plain",
          title: selected ? selected.name : options.fallback.text,
        },
        [selected ? selected.name : options.fallback.text]
      ),
    ]
  )
  // The gesture that opened it closes it. Without this the field is the one
  // control on the panel with no way to put away what it put on the screen:
  // the outside-pointerdown handler exempts its own field on purpose.
  field.addEventListener("click", () => {
    if (openFor === field) dismiss?.(true)
    else openPicker(field, options)
  })
  return field
}

function openPicker(field: HTMLElement, options: TokenFieldOptions): void {
  dismiss?.(false)

  const listId = `de-token-list-${(pickerSeq += 1)}`
  const list = el("div", { class: "de-token-list", id: listId, role: "listbox", "aria-label": options.title })
  // A combobox rather than a bare input: focus stays here while the arrows walk
  // the list, so the active row has to be announced from here or a screen
  // reader hears nothing move.
  const search = el("input", {
    class: "de-token-search-input",
    type: "text",
    placeholder: "Search",
    role: "combobox",
    "aria-expanded": "true",
    "aria-autocomplete": "list",
    "aria-controls": listId,
    "aria-label": `Search ${options.title}`,
  }) as HTMLInputElement
  // No `+` beside the close: Figma's picker creates a style there, and this one
  // has nothing to create. A control that cannot do anything is worse than none.
  const closeButton = el(
    "button",
    {
      class: "de-mini",
      type: "button",
      title: `Close ${options.title} picker`,
      "aria-label": `Close ${options.title} picker`,
    },
    [icon("X", tokens.icon.marker)]
  )
  /**
   * The escape hatch, as a fourth child rather than a second control on the
   * closed field: the field is one button that thirty call sites drop into a
   * stack, and the panel hands focus back by that one node's identity.
   */
  const customInput = options.custom
    ? (el("input", {
        class: "de-token-custom-input",
        type: "text",
        placeholder: options.custom.placeholder,
        "aria-label": `Your own ${options.title}`,
      }) as HTMLInputElement)
    : null
  /*
   * No `de-arrive`: the kit opens menus and pickers instantly, in their final
   * geometry, because they are opened dozens of times an hour and an entrance
   * is a tax on every read (MICRO-INTERACTIONS § 6).
   */
  const popover = el(
    "div",
    { class: "de-token-popover", role: "dialog", "aria-label": options.title },
    [
    el("div", { class: "de-token-popover-header" }, [
      el("span", { class: "de-token-popover-title" }, [options.title]),
      closeButton,
    ]),
    el("div", { class: "de-token-search" }, [icon("Search", tokens.icon.marker), search]),
    list,
    customInput
      ? el("div", { class: "de-token-custom" }, [
          el("span", { class: "de-token-custom-label" }, ["Your own value"]),
          customInput,
        ])
      : null,
  ])

  let visible: TokenChoice[] = []
  let rows: HTMLElement[] = []
  let active = -1

  const setActive = (next: number) => {
    if (!rows.length) {
      active = -1
      search.removeAttribute("aria-activedescendant")
      return
    }
    active = (next + rows.length) % rows.length
    for (const [index, row] of rows.entries()) row.setAttribute("data-active", String(index === active))
    search.setAttribute("aria-activedescendant", rows[active].id)
    // jsdom has no scroller, and neither does a list short enough to fit.
    rows[active].scrollIntoView?.({ block: "nearest", behavior: smoothScroll() })
  }

  const close = (restoreFocus: boolean) => {
    if (dismiss !== close) return
    dismiss = null
    openFor = null
    window.removeEventListener("pointerdown", onPointerDown, true)
    window.removeEventListener("keydown", onKeyDown, true)
    window.removeEventListener("scroll", onScroll, true)
    // Closed now; the kit's 150ms dismissal plays on an inert copy.
    playExit(popover)
    popover.remove()
    field.setAttribute("aria-expanded", "false")
    if (restoreFocus) focusControl(field)
  }

  const commit = (choice: TokenChoice) => {
    if (choice.disabled) return
    // Focus goes back to the field BEFORE the write, not after: a commit rebuilds
    // the whole inspector, and the panel restores focus by `data-de-field`. From
    // a row inside a popover it is about to remove, there is nothing to restore.
    close(true)
    options.onCommit(choice.id)
  }

  /**
   * Same order as `commit`, for the same reason: close first, write second. A
   * value typed here is committed from an input the write is about to remove,
   * so the field has to have focus back before the panel rebuilds around it.
   */
  const commitCustom = () => {
    const raw = customInput?.value.trim() ?? ""
    if (!raw || !options.custom) return
    close(true)
    options.custom.onCommit(raw)
  }

  const rowNode = (choice: TokenChoice, index: number): HTMLElement => {
    const chosen = choice.id === options.selectedId
    const row = el(
      "button",
      {
        class: "de-token-row",
        type: "button",
        role: "option",
        id: `${listId}-${index}`,
        tabindex: "-1",
        "aria-selected": String(chosen),
        "aria-disabled": choice.disabled ? "true" : undefined,
        "data-de-choice": choice.id,
      },
      [
        previewNode(choice.preview),
        /*
         * The leaf, with the WHOLE path one hover away.
         *
         * The row already shows a shortened form on purpose — the group prefix
         * is hoisted into a sticky header so it is not repeated forty times —
         * and `.de-token-row-name` then ellipsises whatever is left inside a
         * 260px popover. Two layers of shortening, and the second one is not
         * deliberate: `Background/Surface/Raised/Hover` and
         * `Background/Surface/Raised/Pressed` reduce to `Hover`/`Pressed` fine,
         * but a design system that names its leaves `container-high-emphasis`
         * loses the distinguishing end of the word with nothing to recover it.
         * `choice.name` is the full path, which is what the closed field reads,
         * so the tooltip and the field agree on what was picked.
         */
        el("span", { class: "de-token-row-name", title: choice.name }, [choice.leaf]),
        choice.detail ? el("span", { class: "de-token-row-detail" }, [choice.detail]) : null,
        chosen ? el("span", { class: "de-token-row-check" }, [icon("Check", tokens.icon.marker)]) : null,
      ]
    )
    row.addEventListener("click", () => commit(choice))
    return row
  }

  const render = (query: string) => {
    const needle = query.trim().toLowerCase()
    const groups = grouped(options.choices.filter((choice) => choice.name.toLowerCase().includes(needle)))
    // Flattened through the grouping, so arrow keys walk the rows in the order
    // they are painted rather than the order the catalog happens to store.
    visible = groups.flatMap(([, entries]) => entries)
    clear(list)
    rows = []
    for (const [group, entries] of groups) {
      // Presentational: a listbox's children are its options, and a header
      // announced as one would be an option that cannot be chosen.
      list.append(el("div", { class: "de-token-group", role: "presentation" }, [group]))
      for (const entry of entries) {
        const row = rowNode(entry, rows.length)
        rows.push(row)
        list.append(row)
      }
    }
    if (!visible.length) list.append(
        el("div", { class: "de-token-empty" }, [
          customInput ? "No matching tokens. Enter your own value below." : "No matching tokens",
        ])
      )
    const chosen = visible.findIndex((choice) => choice.id === options.selectedId)
    setActive(chosen < 0 ? 0 : chosen)
    /*
     * RE-ANCHOR, because filtering just changed this popover's height.
     *
     * `place()` used to run once, when the popover opened, and never again. That
     * is fine while the card opens downward — its top edge is the field and the
     * height grows away from it. It is wrong the moment the card has been
     * FLIPPED above its field to fit the viewport, because then the top edge is
     * derived from the height, and typing a filter that shortens the list left
     * the card anchored to a height it no longer had: it detached from the
     * control it belongs to and floated up the screen, by a hundred pixels or
     * more on a list of any length.
     *
     * Cheap to do here — one layout read on a surface the user is already
     * typing into — and it makes the anchor a property of the current list
     * rather than of the list that happened to be there when it opened.
     */
    place(field, popover)
  }

  const onPointerDown = (event: Event) => {
    if (!popover.contains(event.target as Node) && !field.contains(event.target as Node)) close(false)
  }
  /**
   * The popover is anchored to a field that scrolls with the panel, so a scroll
   * anywhere else leaves it pointing at nothing. Its OWN list is the exception,
   * and the important one: capture-phase listeners see scrolls targeted at any
   * descendant, so the unfiltered version closed the picker on the first wheel
   * tick over seventy-one colour rows — the gesture this surface exists for.
   */
  const onScroll = (event: Event) => {
    // `instanceof Node` because a document- or window-level scroll targets
    // neither, and `contains` throws rather than answering false for those.
    if (event.target instanceof Node && popover.contains(event.target)) return
    close(false)
  }
  // No Home/End: while the caret is in the search field those keys belong to
  // the text a designer is typing, and taking them costs more than the two rows
  // of travel they save in a list the arrows already walk.
  const onKeyDown = (event: KeyboardEvent) => {
    // The same reasoning as Home and End, one field further down. While the
    // caret is in the custom field those keys belong to what is being typed:
    // Enter means "take this", not "take the row the arrows last landed on",
    // and the arrows walk the caret. Escape is the exception both ways — it is
    // the only way out of a text field that has taken the keyboard.
    if (customInput && event.target === customInput && event.key !== "Escape") return
    if (event.key === "Escape") close(true)
    else if (event.key === "ArrowDown") setActive(active + 1)
    else if (event.key === "ArrowUp") setActive(active - 1)
    else if (event.key === "Enter" && visible[active]) commit(visible[active])
    else return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  closeButton.addEventListener("click", () => close(true))
  search.addEventListener("input", () => render(search.value))
  customInput?.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key !== "Enter") return
    event.preventDefault()
    commitCustom()
  })

  document.body.append(popover)
  field.setAttribute("aria-expanded", "true")
  render("")
  place(field, popover)
  dismiss = close
  openFor = field
  window.addEventListener("pointerdown", onPointerDown, true)
  window.addEventListener("keydown", onKeyDown, true)
  window.addEventListener("scroll", onScroll, true)
  search.focus()
}

/**
 * Anchored to the field, flipped above it when the list would run off the
 * bottom. Measured after mount rather than estimated: the height depends on how
 * many tokens the axis has, and a picker whose last rows are past the viewport
 * edge is a picker those tokens cannot be chosen from.
 */
function place(field: HTMLElement, popover: HTMLElement): void {
  const anchor = field.getBoundingClientRect()
  popover.style.left = `${clamp(anchor.left, EDGE, Math.max(EDGE, window.innerWidth - POPOVER_WIDTH - EDGE))}px`
  const height = popover.getBoundingClientRect().height
  const below = anchor.bottom + 4
  const fits = below + height + EDGE <= window.innerHeight
  popover.style.top = fits ? `${below}px` : `${Math.max(EDGE, anchor.top - 4 - height)}px`
}
