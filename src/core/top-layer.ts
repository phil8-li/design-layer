/**
 * Keeps the chrome in front of the app's top layer.
 *
 * A modal `<dialog>` (`showModal()`) and a popover are drawn in the browser's
 * TOP LAYER, above every z-index in the document. So an app's modal covered the
 * panels and the toolbar however high their z-index was, and a modal does one
 * thing more: it makes everything outside its own subtree inert. The covered
 * chrome could not even be clicked; a click on a panel landed on the dialog's
 * backdrop, and the app closed its modal.
 *
 * Neither has a z-index answer, so while the app has anything in the top layer
 * the chrome joins it. Its roots on `<body>` move into one box that is itself
 * in the top layer (a manual popover), shown AFTER the app's element, which is
 * what draws it above. While a modal dialog is open the box sits inside that
 * dialog: only the dialog's own subtree escapes its inertness, and the top
 * layer still draws the box above the dialog, free of the dialog's clip,
 * transform and opacity. Inside the box the roots keep their z-indexes, so
 * menus and tooltips stay over the panels. When the app's top layer empties,
 * after any exit transition, the roots go back to `<body>` and the box goes.
 *
 * The top layer has no way to raise an element already in it, so "above" is
 * kept by building a new box each time the app adds an element and moving the
 * roots into it. `moveBefore` moves them with their focus, scroll positions,
 * text selection and running transitions intact. A browser without it
 * reinserts them, and focus and scroll are put back by hand.
 *
 * Fullscreen is left alone: a video put fullscreen asked to be the only thing
 * on screen.
 */

import { CHROME_ATTR, el } from "./dom"

const OURS = `[${CHROME_ATTR}]`

/** A closed element's exit transition longer than this is not waited out. */
const LEAVE_MS = 2000

/** The box while the app's top layer is in use, or null while the roots are on `<body>`. */
let box: HTMLElement | null = null

/**
 * Where each scroller in the box was last scrolled to. An app that unmounts
 * its open dialog takes the box and the roots with it, and a detached element
 * has no scroll position left to read when the roots are put back.
 */
const scrolls = new WeakMap<Element, readonly [number, number]>()
const remember = (node: Element): void => {
  if (node.scrollTop !== 0 || node.scrollLeft !== 0) scrolls.set(node, [node.scrollTop, node.scrollLeft])
  else scrolls.delete(node)
}

/**
 * Mounts a chrome surface: on `<body>`, or in the box while there is one.
 *
 * A surface mounted on `<body>` while a modal is open is inert until it is
 * moved, and a focus call made in the same breath as the mount goes nowhere.
 * The token picker's search field is one.
 */
export function mountChrome(...nodes: Node[]): void {
  ;(box ?? document.body).append(...nodes)
}

type Movable = Element & { moveBefore?: (node: Node, child: Node | null) => void }
type Toggle = Event & { newState?: string }

/** `matches` for a selector the engine may not know (`:modal`, `:popover-open`). */
function matches(node: Element, selector: string): boolean {
  try {
    return node.matches(selector)
  } catch {
    return false
  }
}

const ours = (node: Element): boolean => node.closest(OURS) !== null

/** An element the app can put in the top layer: a dialog, or a popover. */
const layerable = (node: EventTarget | null): node is Element =>
  node instanceof Element && !ours(node) && (node.localName === "dialog" || node.hasAttribute("popover"))

const inTopLayer = (node: Element): boolean =>
  node.isConnected && (matches(node, ":modal") || matches(node, ":popover-open"))

/** Its own exit transitions and those of its `::backdrop`, while they run. */
function leaving(node: Element): Animation[] {
  if (!node.isConnected || typeof node.getAnimations !== "function") return []
  return node.getAnimations({ subtree: true }).filter((animation) => {
    const effect = animation.effect as KeyframeEffect | null
    return (
      effect?.target === node &&
      animation.playState === "running" &&
      Number.isFinite(Number(effect.getComputedTiming().endTime))
    )
  })
}

/** The chrome's roots on `<body>`. The editor's own dialogs are in the top layer already. */
function homeRoots(): Element[] {
  return Array.from(document.body.children).filter(
    (node) => node.hasAttribute(CHROME_ATTR) && node !== box && !/^(dialog|script|style|link|template)$/.test(node.localName)
  )
}

function move(parent: Element, node: Element): void {
  const into = parent as Movable
  if (typeof into.moveBefore === "function") {
    try {
      into.moveBefore(node, null)
      return
    } catch {
      // A root the app detached along with the box, when it unmounted its
      // dialog or replaced the dialog's content. It is put back below.
    }
  }
  const attached = node.isConnected
  const focused = document.activeElement
  const refocus = focused instanceof HTMLElement && node.contains(focused) ? focused : null
  const scrolled = [node, ...Array.from(node.querySelectorAll("*"))].flatMap((at) => {
    const [top, left] = attached ? [at.scrollTop, at.scrollLeft] : (scrolls.get(at) ?? [0, 0])
    return top !== 0 || left !== 0 ? [[at, top, left] as const] : []
  })
  parent.append(node)
  for (const [at, top, left] of scrolled) {
    at.scrollTop = top
    at.scrollLeft = left
  }
  refocus?.focus({ preventScroll: true })
}

/** Installs the keeper. Returns the function that puts every root back on `<body>`. */
export function keepChromeOnTop(): () => void {
  /** The app's elements in the top layer, in the order they went in. */
  let opened: Element[] = []
  /** Elements that left the top layer and are still drawn while they transition out. */
  let closing: Element[] = []
  const closedAt = new WeakMap<Element, number>()
  /** The app put an element in the top layer since the box was last shown. */
  let behind = false
  let waits = 0

  const observing = typeof MutationObserver === "function"
  const tree = observing ? new MutationObserver(() => sync()) : null
  const onScroll = (event: Event): void => {
    if (event.target instanceof Element && box?.contains(event.target)) remember(event.target)
  }

  const lift = (parent: Element): void => {
    // Listed before the new box is on `<body>`, where it would count as a root.
    const roots = box ? Array.from(box.children) : homeRoots()
    const next = el("div", { class: "de-top-layer", popover: "manual" })
    parent.append(next)
    if (typeof next.showPopover === "function") next.showPopover()
    for (const node of roots) move(next, node)
    box?.remove()
    box = next
    behind = false
    for (const node of Array.from(next.querySelectorAll("*"))) remember(node)
    document.addEventListener("scroll", onScroll, { capture: true, passive: true })
    // The box can be removed with the app's dialog, and surfaces can mount on
    // `<body>` meanwhile: the whole tree is watched, but only while there is a box.
    tree?.observe(document.documentElement, { childList: true, subtree: true })
  }

  const settle = (): void => {
    if (!box) return
    tree?.disconnect()
    document.removeEventListener("scroll", onScroll, true)
    for (const node of Array.from(box.children)) move(document.body, node)
    box.remove()
    box = null
    behind = false
  }

  /** Syncs again once the closing elements' transitions end, or after `LEAVE_MS`. */
  const waitOut = (animations: Animation[]): void => {
    const mine = ++waits
    const ended = Promise.allSettled(animations.map((animation) => animation.finished))
    const late = new Promise((resolve) => setTimeout(resolve, LEAVE_MS))
    void Promise.race([ended, late]).then(() => {
      if (mine === waits) sync()
    })
  }

  function sync(): void {
    const now = performance.now()
    const was = opened
    opened = opened.filter(inTopLayer)
    const left = was.filter((node) => !opened.includes(node))
    for (const node of left) closedAt.set(node, now)
    closing = [...new Set([...closing, ...left])].filter(
      (node) => !opened.includes(node) && now - (closedAt.get(node) ?? now) < LEAVE_MS && leaving(node).length > 0
    )
    if (!opened.length && !closing.length) return settle()
    if (closing.length) waitOut(closing.flatMap(leaving))
    const modal = [...opened].reverse().find((node) => matches(node, ":modal"))
    const parent = modal ?? document.body
    const placed = box !== null && box.isConnected && box.parentElement === parent
    /*
     * The editor's own modal (the shortcuts sheet, the library sign-in) sits
     * over everything, the app's modal included, and a box shown after it
     * would draw the panels over its scrim. The lift waits for it to close.
     */
    const ownModal = (): boolean =>
      Array.from(document.querySelectorAll(`dialog${OURS}`)).some((node) => matches(node, ":modal"))
    if ((!placed || behind) && !ownModal()) return lift(parent)
    if (box) for (const node of homeRoots()) move(box, node)
  }

  const opening = (node: Element): void => {
    opened = [...opened.filter((other) => other !== node), node]
    behind = true
  }

  /*
   * `beforetoggle` comes before a popover or a dialog enters the top layer and
   * `toggle` after it, in a later task. The box is lifted in the microtask
   * after the first, so it is above before the next frame paints. `toggle`
   * catches what `beforetoggle` missed, such as a dialog in an engine that
   * fires none for dialogs, and closes.
   */
  const onBeforeToggle = (event: Event): void => {
    if (!layerable(event.target) || (event as Toggle).newState !== "open") return
    opening(event.target)
    queueMicrotask(sync)
  }
  const onToggle = (event: Event): void => {
    if (!layerable(event.target)) return
    if ((event as Toggle).newState === "open" && !opened.includes(event.target)) opening(event.target)
    sync()
  }
  // `open` is the one trace `showModal()` and `close()` leave that every engine
  // reports, in a microtask that still runs before the next paint.
  const dialogs = observing
    ? new MutationObserver((records) => {
        for (const { target } of records) {
          if (layerable(target) && target.hasAttribute("open") && !opened.includes(target)) opening(target)
        }
        sync()
      })
    : null

  document.addEventListener("beforetoggle", onBeforeToggle, true)
  document.addEventListener("toggle", onToggle, true)
  dialogs?.observe(document.documentElement, { attributes: true, attributeFilter: ["open"], subtree: true })
  // Whatever the app already had open when the editor arrived.
  for (const node of Array.from(document.querySelectorAll("dialog[open], [popover]"))) {
    if (layerable(node) && inTopLayer(node)) opening(node)
  }
  if (opened.length) sync()

  return () => {
    document.removeEventListener("beforetoggle", onBeforeToggle, true)
    document.removeEventListener("toggle", onToggle, true)
    dialogs?.disconnect()
    waits += 1
    opened = []
    closing = []
    settle()
  }
}
