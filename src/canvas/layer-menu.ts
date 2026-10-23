/**
 * The canvas context menu: Figma's right-click menu, with the "Select layer"
 * stack as its first entry.
 *
 * The stack is what makes the scope rule tolerable: a plain click deliberately
 * refuses to go deep, so there has to be one gesture that lists everything
 * under the cursor and lets the user say which one they meant. Its rows come
 * from `core/resolve`, which deduplicates SVG geometry and sorts the stack in
 * the same document order as the Layers panel. It sits in a submenu, as in
 * Figma, so the actions below it stay one short list.
 *
 * Every action is a named command from `core/commands.ts` and every shortcut
 * is read from `core/keymap.ts`, so the menu cannot advertise a key or a
 * behavior the keyboard does not have. Copy and Select matching are the two
 * items with no command: copy needs the click's user activation, and no key is
 * bound to either.
 */

import { arrangeRef, canArrange, siblingLines, type ArrangeMove } from "../core/arrange"
import { copyText, COPY_REFUSED } from "../core/clipboard"
import { hasCommand, runCommand } from "../core/commands"
import { el, isCanvasElement, isChrome } from "../core/dom"
import { CODE_VIEWS, codeText, elementCode } from "../core/element-code"
import { focusControl } from "../core/focus"
import { icon } from "../core/icons"
import { chordLabel, SHORTCUTS } from "../core/keymap"
import { playExit } from "../core/motion"
import { getResolver, toSelectable } from "../core/resolve"
import { isLocked, selectionOwnsInput } from "../core/store"
import { tokens } from "../core/tokens"
import type { EditorContext } from "../core/context"
import type { LayerElement } from "../core/types"
import { matchingLayers } from "./matching"

/** Deeper than this the stack is layout wrappers, and the menu is a wall of divs. */
const MAX_ROWS = 12
const EDGE = 8
/** The submenu's first row lines up with its trigger: the card's padding plus hairline. */
const SUBMENU_INSET = 6

/** The key printed beside a command, read off the one keymap. */
export function shortcutText(command: string): string {
  const shortcut = SHORTCUTS.find((entry) => entry.command === command)
  return shortcut ? chordLabel(shortcut.chord) : ""
}

interface Action {
  label: string
  /** The command whose key is printed, and which runs unless `run` is given. */
  command?: string
  run?: () => void
  enabled: boolean
}

/** Whether the element lays out its children, which is what auto layout means here. */
function hasAutoLayout(element: Element): boolean {
  const display = getComputedStyle(element).display
  return display === "flex" || display === "inline-flex" || display === "grid" || display === "inline-grid"
}

export function installLayerMenu(context: EditorContext): void {
  const resolver = getResolver(context.bridge)
  const submenu = el("div", {
    class: "de-layer-menu de-ctx-submenu",
    role: "menu",
    "aria-label": "Select layer",
    style: "display:none",
  })
  // The stack card lives inside the action card, so one `contains` answers
  // "was this click outside the menu" for both.
  const menu = el(
    "div",
    {
      class: "de-layer-menu de-ctx-menu",
      role: "menu",
      "aria-label": "Layer actions",
      style: "display:none",
    },
    [submenu]
  )
  context.slots.overlay.append(menu)

  let open = false
  let returnFocus: HTMLElement | null = null
  let trigger: HTMLButtonElement | null = null
  let stack: LayerElement[] = []

  const submenuOpen = () => submenu.style.display === "block"

  const closeSubmenu = () => {
    if (!submenuOpen()) return
    submenu.style.display = "none"
    while (submenu.firstChild) submenu.removeChild(submenu.firstChild)
    trigger?.setAttribute("aria-expanded", "false")
    context.setState({ hovered: null })
  }

  const clearItems = () => {
    for (const child of Array.from(menu.children)) if (child !== submenu) child.remove()
  }

  const close = (restoreFocus = false) => {
    if (!open) return
    open = false
    /*
     * Gone at the instant it is dismissed: this card is `pointer-events: auto`
     * and on the Escape stack, so a card still in the document could take a
     * click and absorb the next dismissal. The kit's 150ms fade plays on an
     * inert copy instead (`playExit` in core/motion).
     */
    playExit(menu)
    menu.style.display = "none"
    closeSubmenu()
    clearItems()
    trigger = null
    stack = []
    // Row hover writes `hovered`, and the pointer can leave via the menu
    // closing rather than via a `pointermove` over the canvas. Without this the
    // preview outline sticks to the last row until the pointer moves again.
    context.setState({ hovered: null })
    if (restoreFocus && returnFocus?.isConnected) focusControl(returnFocus)
    returnFocus = null
  }

  const stackRow = (element: Element) => {
    const meta = resolver.meta(element)
    const node = el(
      "button",
      {
        class: `de-layer-menu-row${meta.isRoot ? " de-layer-menu-row--component" : ""}`,
        type: "button",
        role: "menuitem",
        tabindex: "-1",
        /*
         * The row ellipsises inside a capped card, and this menu exists for
         * exactly the case where the tails are the answer: you right-click an
         * overlapping stack to tell `ProjectCardGridItem` from
         * `ProjectCardGridItemMedia`, and both cut to the same visible string.
         */
        // The tag rides along as it does on a Layers row, so a row named by
        // its text or id still says what element it is.
        title: meta.name === meta.tag ? meta.name : `${meta.name} · ${meta.tag}`,
      },
      [meta.name]
    )
    // Preview what the click will actually select, not the raw stack entry, so
    // an SVG row outlines the `<svg>` the click will pick and not its `<rect>`.
    node.addEventListener("pointerenter", () => {
      context.setState({ hovered: toSelectable(element) })
      focusControl(node)
    })
    node.addEventListener("click", () => {
      const target = toSelectable(element)
      close(true)
      if (!target) return
      // `selectMany` rather than `select`: the latter early-returns on an
      // unchanged selection, and re-picking the same row must still take.
      context.selectMany([target])
      // Picking out of the stack is an explicit depth choice, so the scope
      // follows it and the next plain click stays at that level.
      context.setState({ scope: resolver.layerParent(target) })
    })
    return node
  }

  const item = (label: string, options: { shortcut?: string; enabled?: boolean } = {}) => {
    const enabled = options.enabled ?? true
    const node = el(
      "button",
      {
        class: "de-ctx-item",
        type: "button",
        role: "menuitem",
        tabindex: "-1",
        ...(enabled ? {} : { "aria-disabled": "true" }),
      },
      [el("span", { class: "de-ctx-label" }, [label])]
    )
    if (options.shortcut) {
      node.append(el("span", { class: "de-ctx-shortcut", "aria-hidden": "true" }, [options.shortcut]))
    }
    // Hovering a sibling closes the stack, as a native submenu does.
    node.addEventListener("pointerenter", () => {
      if (node !== trigger) closeSubmenu()
      if (enabled) focusControl(node)
    })
    return node
  }

  const actionItem = (action: Action) => {
    const node = item(action.label, {
      shortcut: action.command ? shortcutText(action.command) : "",
      enabled: action.enabled,
    })
    node.addEventListener("click", () => {
      if (!action.enabled) return
      const command = action.command
      const run = action.run ?? (() => command && runCommand(command))
      close(true)
      // Synchronous, so Copy still holds the click's user activation, which
      // both clipboard routes need (`core/clipboard.ts`).
      run()
    })
    return node
  }

  const separator = () => el("div", { class: "de-ctx-separator", role: "separator" })

  const copyAction = (label: string, text: string | null, toast: string): Action => ({
    label,
    enabled: text !== null,
    run: () => {
      if (text === null) return
      void copyText(text).then((copied) =>
        copied ? context.toast(toast) : context.toast(COPY_REFUSED, "error")
      )
    },
  })

  /*
   * Arrange is offered only where it goes somewhere, which needs the sibling
   * list from the server. A known list decides it now; an unknown one leaves
   * the item on and repaints when the reply lands. The command itself is a
   * no-op at the end of the list, so the brief "on" is harmless.
   */
  const arrangeEnabled = (move: ArrangeMove, onReady: () => void): boolean => {
    const primary = context.primarySelection()
    if (!primary || !hasCommand(`arrange.${move}`)) return false
    const ref = arrangeRef(context.bridge, primary.element)
    if (!ref) return false
    const lines = siblingLines(context.bridge, ref, onReady)
    return lines ? canArrange(lines, ref, move) : true
  }

  const actions = (onArrangeReady: () => void): Action[][] => {
    const state = context.getState()
    const primary = context.primarySelection()
    const selected = state.selection.length > 0
    // JSX in React, HTML in Angular: the first dialect `CODE_VIEWS` offers.
    const codeView = CODE_VIEWS.find((view) => view.id !== "classes")
    const hasClasses = Boolean(primary?.element.getAttribute("class")?.trim())
    const matches = primary
      ? matchingLayers(resolver, state.selection.map((entry) => entry.element))
      : []
    const auto = primary ? hasAutoLayout(primary.element) : false
    const hidden = primary ? getComputedStyle(primary.element).display === "none" : false
    // The command locks a mixed selection, so the label says Unlock only when it will.
    const locked = selected && state.selection.every((entry) => isLocked(entry.element))
    const can = (command: string) => selected && hasCommand(command)
    const arrangeItem = (label: string, move: ArrangeMove): Action => ({
      label,
      command: `arrange.${move}`,
      enabled: arrangeEnabled(move, onArrangeReady),
    })
    return [
      [
        copyAction(
          "Copy as code",
          primary && codeView ? codeText(elementCode(primary, codeView.id)) : null,
          `Copied ${codeView?.label ?? "code"}`
        ),
        copyAction(
          "Copy classes",
          primary && hasClasses ? codeText(elementCode(primary, "classes")) : null,
          "Copied classes"
        ),
      ],
      [
        arrangeItem("Bring to front", "front"),
        arrangeItem("Bring forward", "forward"),
        arrangeItem("Send backward", "backward"),
        arrangeItem("Send to back", "back"),
      ],
      [
        auto
          ? { label: "Remove auto layout", command: "layout.auto.remove", enabled: can("layout.auto.remove") }
          : {
              label: "Add auto layout",
              command: "layout.auto.add",
              // The command refuses an element with no children to lay out.
              enabled: can("layout.auto.add") && (primary?.element.childElementCount ?? 0) > 0,
            },
        {
          label: "Select matching layers",
          enabled: matches.length > state.selection.length,
          run: () => context.selectMany(matches),
        },
      ],
      [
        { label: hidden ? "Show" : "Hide", command: "select.hide", enabled: can("select.hide") },
        { label: locked ? "Unlock" : "Lock", command: "select.lock", enabled: can("select.lock") },
      ],
      [{ label: "Delete", command: "element.delete", enabled: can("element.delete") }],
    ]
  }

  /** Viewport limits for a card: inside the canvas, between the two panels. */
  const bounds = () => {
    const rootStyle = document.documentElement.style
    const left = (Number.parseFloat(rootStyle.getPropertyValue("--de-left")) || 0) + EDGE
    const right =
      window.innerWidth - (Number.parseFloat(rootStyle.getPropertyValue("--de-right")) || 0) - EDGE
    return { left, right, top: EDGE, bottom: window.innerHeight - EDGE }
  }

  /** Starts at `start`; when that crosses `max`, flips to end at `flipEnd`. Then clamps. */
  const place = (start: number, size: number, min: number, max: number, flipEnd = start) => {
    const at = start + size > max ? flipEnd - size : start
    return Math.max(min, Math.min(at, max - size))
  }

  const build = () => {
    const before = Array.from(menu.querySelectorAll(":scope > .de-ctx-item"))
    const focused = before.indexOf(document.activeElement as Element)
    clearItems()
    trigger = item("Select layer")
    trigger.classList.add("de-ctx-item--submenu")
    trigger.setAttribute("aria-haspopup", "menu")
    trigger.setAttribute("aria-expanded", String(submenuOpen()))
    trigger.append(
      el("span", { class: "de-ctx-chevron", "aria-hidden": "true" }, [icon("ChevronRight", tokens.icon.marker)])
    )
    trigger.addEventListener("pointerenter", () => openSubmenu(false))
    trigger.addEventListener("click", () => openSubmenu(true))
    menu.insertBefore(trigger, submenu)

    let repainted = false
    const onArrangeReady = () => {
      // One repaint per open; the menu may have closed while the server answered.
      if (!open || repainted) return
      repainted = true
      build()
    }
    for (const group of actions(onArrangeReady)) {
      menu.insertBefore(separator(), submenu)
      for (const action of group) menu.insertBefore(actionItem(action), submenu)
    }
    const after = Array.from(menu.querySelectorAll<HTMLButtonElement>(":scope > .de-ctx-item"))
    if (focused >= 0 && after[focused]) focusControl(after[focused])
  }

  const openSubmenu = (focusFirst: boolean) => {
    if (!open || !trigger) return
    if (!submenuOpen()) {
      for (const element of stack) submenu.append(stackRow(element))
      submenu.style.display = "block"
      submenu.style.left = "0px"
      submenu.style.top = "0px"
      const menuRect = menu.getBoundingClientRect()
      const triggerRect = trigger.getBoundingClientRect()
      const rect = submenu.getBoundingClientRect()
      const limits = bounds()
      const left = place(menuRect.right, rect.width, limits.left, limits.right, menuRect.left)
      const top = place(triggerRect.top - SUBMENU_INSET, rect.height, limits.top, limits.bottom)
      // Positioned inside the outer card, so the offsets are relative to it.
      submenu.style.left = `${left - menuRect.left}px`
      submenu.style.top = `${top - menuRect.top}px`
      trigger.setAttribute("aria-expanded", "true")
    }
    if (focusFirst) focusRow(submenuRows(), 0)
  }

  const onContextMenu = (event: MouseEvent) => {
    close()
    // Its own window listener, so it needs its own mode gate: interactive mode
    // is a promise that every gesture reaches the app, and a right-click that
    // opened this menu instead would break it as surely as a left one.
    if (!selectionOwnsInput()) return
    const { tool } = context.getState()
    if (tool !== "move") return
    // A selection handle is chrome, but it sits on the canvas and Figma opens
    // the menu there too. The corners are where a right-click often lands.
    const onHandle = event.target instanceof Element && event.target.closest("[data-handle]") !== null
    if (isChrome(event.target) && !onHandle) return
    stack = resolver.hitStack(event.clientX, event.clientY).slice(0, MAX_ROWS)
    if (!stack.length) return

    event.preventDefault()
    event.stopPropagation()
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null

    /*
     * Figma selects what you right-clicked, so the actions apply to the thing
     * under the pointer. A press over anything already selected keeps the
     * selection: a deep-selected child is not swapped for its parent, and a
     * multi-selection survives. The target is what a plain click there would
     * select, through the same scope rule.
     */
    const hit = isCanvasElement(event.target) ? event.target : stack[stack.length - 1]
    const overSelection =
      onHandle ||
      context.getState().selection.some((entry) => entry.element === hit || entry.element.contains(hit))
    const target = overSelection ? null : resolver.resolve(hit, context.getState().scope)
    const selecting = Boolean(target && !isLocked(target))
    if (target && selecting) context.selectMany([target])

    open = true
    build()
    // The inspector registers the layout commands for the selection it renders,
    // on a microtask queued by the select above. Asked again once it has run,
    // so a fresh selection does not open with auto layout greyed out.
    if (selecting) queueMicrotask(() => open && build())
    // Measured after mount: the item count decides the height, and a menu that
    // opens past the viewport edge is a menu with unreachable entries.
    menu.style.display = "block"
    menu.style.left = "0px"
    menu.style.top = "0px"
    const rect = menu.getBoundingClientRect()
    const limits = bounds()
    menu.style.left = `${place(event.clientX, rect.width, limits.left, limits.right)}px`
    menu.style.top = `${place(event.clientY, rect.height, limits.top, limits.bottom)}px`
    /*
     * No entrance animation, unlike the chrome's other popovers. An entrance
     * answers "where did this come from", and a card that opens AT THE POINTER
     * is already where you clicked, so all it would add is 180ms in front of
     * the most frequently opened surface in the product. Cards anchored to a
     * control elsewhere keep theirs (`arriveFrom` in `core/motion.ts`).
     */
    focusRow(menuItems(), 0)
  }

  // Disabled items are skipped by the arrows, as in Figma's and the system's menus.
  const menuItems = (): HTMLButtonElement[] =>
    Array.from(menu.querySelectorAll<HTMLButtonElement>(":scope > .de-ctx-item")).filter(
      (node) => node.getAttribute("aria-disabled") !== "true"
    )

  const submenuRows = (): HTMLButtonElement[] =>
    Array.from(submenu.querySelectorAll<HTMLButtonElement>(".de-layer-menu-row"))

  const focusRow = (rows: HTMLButtonElement[], index: number) => {
    if (!rows.length) return
    const target = rows[(index + rows.length) % rows.length]
    for (const row of rows) row.tabIndex = row === target ? 0 : -1
    focusControl(target)
  }

  window.addEventListener("contextmenu", onContextMenu, true)
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (open && !menu.contains(event.target as Node)) close()
    },
    true
  )
  window.addEventListener(
    "keydown",
    (event) => {
      if (!open) return
      const inSubmenu = submenu.contains(document.activeElement)
      const rows = inSubmenu ? submenuRows() : menuItems()
      const index = rows.indexOf(document.activeElement as HTMLButtonElement)
      if (event.key === "Escape" && !inSubmenu) close(true)
      else if ((event.key === "Escape" || event.key === "ArrowLeft") && inSubmenu) {
        closeSubmenu()
        focusControl(trigger)
      } else if (event.key === "ArrowDown") focusRow(rows, index + 1)
      else if (event.key === "ArrowUp") focusRow(rows, index < 0 ? -1 : index - 1)
      else if (event.key === "Home") focusRow(rows, 0)
      else if (event.key === "End") focusRow(rows, rows.length - 1)
      else if (event.key === "ArrowRight" && document.activeElement === trigger) openSubmenu(true)
      else if (event.key === "Tab") close(true)
      else if ((event.key === "Enter" || event.key === " ") && index >= 0) rows[index].click()
      else return
      event.preventDefault()
      event.stopImmediatePropagation()
    },
    true
  )
  window.addEventListener("scroll", () => close(), true)
  window.addEventListener("blur", () => close())
  // Closed when the editor is hidden. The card is in the overlay layer, which
  // does not stand down, so ⌘. left it open over the page, its rows still
  // acting on the app the editor had just handed back.
  context.subscribe((state, previous) => {
    if (state.chromeHidden && !previous.chromeHidden) close()
  })
}
