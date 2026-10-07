/**
 * The right-click "Select layer" stack menu.
 *
 * This is what makes the scope rule tolerable: a plain click deliberately
 * refuses to go deep, so there has to be one gesture that lists everything
 * under the cursor and lets the user say which one they meant. Rows come from
 * `core/resolve`, which deduplicates SVG geometry and sorts the stack in the
 * same document order as the Layers panel.
 */

import { el, isChrome } from "../core/dom"
import { focusControl } from "../core/focus"
import { playExit } from "../core/motion"
import { getResolver, toSelectable } from "../core/resolve"
import { selectionOwnsInput } from "../core/store"
import type { EditorContext } from "../core/context"

/** Deeper than this the stack is layout wrappers, and the menu is a wall of divs. */
const MAX_ROWS = 12
const EDGE = 8

export function installLayerMenu(context: EditorContext): void {
  const resolver = getResolver(context.bridge)
  const menu = el("div", {
    class: "de-layer-menu",
    role: "menu",
    "aria-label": "Select layer",
    style: "display:none",
  })
  context.slots.overlay.append(menu)

  let open = false
  let returnFocus: HTMLElement | null = null

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
    menu.classList.remove("de-arrive")
    menu.style.display = "none"
    while (menu.firstChild) menu.removeChild(menu.firstChild)
    // Row hover writes `hovered`, and the pointer can leave via the menu
    // closing rather than via a `pointermove` over the canvas. Without this the
    // preview outline sticks to the last row until the pointer moves again.
    context.setState({ hovered: null })
    if (restoreFocus && returnFocus?.isConnected) focusControl(returnFocus)
    returnFocus = null
  }

  const row = (element: Element) => {
    const meta = resolver.meta(element)
    const node = el(
      "button",
      {
        class: `de-layer-menu-row${meta.isRoot ? " de-layer-menu-row--component" : ""}`,
        type: "button",
        role: "menuitem",
        tabindex: "-1",
        /*
         * The row ellipsises inside a 260px-capped card, and this menu exists
         * for exactly the case where the tails are the answer: you right-click
         * an overlapping stack to tell `ProjectCardGridItem` from
         * `ProjectCardGridItemMedia`, and both cut to the same visible string.
         * `panels/layers.ts` writes a `title` on its own rows for this reason
         * and argues it there; the menu built from the same resolver did not.
         */
        title: meta.name,
      },
      [meta.name]
    )
    // Preview what the click will actually select, not the raw stack entry.
    // This was the one call site bypassing `toSelectable`, so hovering a row
    // for an SVG node outlined the `<rect>` and then selected the `<button>`
    // three levels up — the preview promising something the click cannot give.
    node.addEventListener("pointerenter", () =>
      context.setState({ hovered: toSelectable(element) })
    )
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

  const onContextMenu = (event: MouseEvent) => {
    close()
    // Its own window listener, so it needs its own mode gate: interactive mode
    // is a promise that every gesture reaches the app, and a right-click that
    // opened the layer stack instead would break it as surely as a left one.
    if (!selectionOwnsInput()) return
    const { tool } = context.getState()
    if (tool !== "move") return
    if (isChrome(event.target)) return
    const stack = resolver.hitStack(event.clientX, event.clientY).slice(0, MAX_ROWS)
    if (!stack.length) return

    event.preventDefault()
    event.stopPropagation()
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    for (const element of stack) menu.append(row(element))

    // Measured after mount: the row count decides the height, and a menu that
    // opens past the viewport edge is a menu with unreachable entries.
    menu.style.display = "block"
    menu.style.left = "0px"
    menu.style.top = "0px"
    const rect = menu.getBoundingClientRect()
    const rootStyle = document.documentElement.style
    const canvasLeft = Number.parseFloat(rootStyle.getPropertyValue("--de-left")) || 0
    const canvasRight = Number.parseFloat(rootStyle.getPropertyValue("--de-right")) || 0
    const left = Math.min(
      Math.max(event.clientX, canvasLeft + EDGE),
      window.innerWidth - canvasRight - rect.width - EDGE
    )
    const top = Math.min(event.clientY, window.innerHeight - rect.height - EDGE)
    menu.style.left = `${Math.max(canvasLeft + EDGE, left)}px`
    menu.style.top = `${Math.max(EDGE, top)}px`
    /*
     * THIS MENU PLAYS NO ENTRANCE, and it is the only popover in the chrome
     * that does not.
     *
     * Five surfaces shared `.de-arrive`, and the argument for it in
     * `css/base.ts` is sound: a card that materialises at its final appearance
     * reads as a paste rather than as something that opened. The argument has a
     * condition attached, and this one surface is the one that fails it.
     *
     * An entrance earns its 180ms by answering "where did this come from",
     * which is a real question for a card that appears somewhere other than
     * where you pressed. Every other popover here is anchored to a control
     * across the panel from the pointer — the token picker opens off a field,
     * the chooser's menu under a button in the bar. This one opens AT THE
     * POINTER. It is already exactly where you just clicked, so the question
     * was never asked, and what is left of the animation is 180ms of spring in
     * front of a list you are about to arrow through.
     *
     * That is the cheat sheet's rule for a frequently-opened menu, and this is
     * the most frequently-opened surface in the product: right-clicking to
     * disambiguate an overlapping stack is most of what inspecting a page
     * consists of. The fix is a deletion — one class not added — which is the
     * cheapest rung on the ladder.
     *
     * The cards that DO travel keep their entrance, and keep the origin that
     * aims it (`arriveFrom` in `core/motion.ts`). The two decisions compose:
     * animate a card that arrives from somewhere and point it at where it came
     * from; do neither for a card that is already there.
     *
     * The placement above is unchanged. It still paints at `0,0`, measures and
     * moves — which was the reason an entrance had to be armed after the fact
     * rather than declared on the element, and one more reason not to want one.
     */
    open = true
    const first = menu.querySelector<HTMLButtonElement>(".de-layer-menu-row")
    if (first) {
      first.tabIndex = 0
      focusControl(first)
    }
  }

  const menuRows = (): HTMLButtonElement[] =>
    Array.from(menu.querySelectorAll<HTMLButtonElement>(".de-layer-menu-row"))

  const focusRow = (index: number) => {
    const rows = menuRows()
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
      const rows = menuRows()
      const index = rows.indexOf(document.activeElement as HTMLButtonElement)
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopImmediatePropagation()
        close(true)
        return
      }
      if (event.key === "ArrowDown") focusRow(index + 1)
      else if (event.key === "ArrowUp") focusRow(index - 1)
      else if (event.key === "Home") focusRow(0)
      else if (event.key === "End") focusRow(rows.length - 1)
      else if ((event.key === "Enter" || event.key === " ") && index >= 0) rows[index].click()
      else return
      event.preventDefault()
      event.stopImmediatePropagation()
    },
    true
  )
  window.addEventListener("scroll", () => close(), true)
  window.addEventListener("blur", () => close())
}
