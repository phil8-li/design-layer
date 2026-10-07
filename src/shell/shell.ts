/**
 * Mounts the editor chrome: a floating toolbar, a layers rail on the left, an
 * inspector on the right, and a transparent overlay layer for canvas chrome.
 *
 * The app is inset with padding on a border-box <html> rather than a transform,
 * because a transformed ancestor would break the app's own `layoutId`
 * shared-element morphs (see docs/agent-rules/card-reader-morph.md).
 */

import { config } from "../core/config"
import { shellCss } from "../core/css"
import { CHROME_ATTR, el } from "../core/dom"
import { focusControl, installFocusModality } from "../core/focus"
import type { EditorSlots } from "../core/context"
import { editorOwnsInput, getState, setState, subscribe } from "../core/store"
import { createLauncher } from "./launcher"
import { mountOverlayScrollbar } from "./overlay-scrollbar"
import { mountPanelResize } from "./resize"

const STYLE_ID = "designlayer-shell-style"

export interface Shell {
  slots: EditorSlots
  root: HTMLElement
  /** The polite live region. See its note where it is built. */
  announcer: HTMLElement
  destroy(): void
}

/**
 * Gives our own controls their focus back.
 *
 * The vendor guards the document against the app stealing a gesture: one of its
 * `mousedown` listeners on `document` (capture) calls `preventDefault()` for
 * anything that is not its own shadow chrome. Focus is a *default action* of
 * mousedown, so the caret never lands in our inspector — every field reads as
 * decorative, and typing goes nowhere. Its guard cannot be reordered: it is
 * registered when the vendor boots, which is before our bundle is even parsed.
 *
 * `window` capture runs before `document` capture, so focusing here happens
 * while the event is still untouched. `preventDefault()` afterwards suppresses
 * the default focus move, not a focus already applied by script.
 */
function restoreChromeFocus(): () => void {
  /**
   * Declaw the guard for our own gestures.
   *
   * `window` capture is the first stop in the propagation path, so by the time
   * the vendor's `document`-capture listener calls these, they do nothing: the
   * event keeps descending to our controls and its default action survives.
   * While the editor owns input, only events aimed at our chrome are touched,
   * so the vendor keeps its guard everywhere it actually means it — over the
   * app being edited. Interactive mode widens that to the app; see below.
   */
  const declaw = (event: Event) => {
    const target = event.target
    const ours = target instanceof Element && target.closest(`[${CHROME_ATTR}]`) !== null
    /*
     * Interactive mode has to be honoured by the VENDOR too, not just by us.
     *
     * Gating our own handlers on `editorOwnsInput()` is only half the mode: the
     * vendor's guard is still on `document` (capture) and still stops every
     * gesture aimed at the app, so with the mode ON the app stayed exactly as
     * dead as with it off — an app button received neither pointerdown nor
     * click. Declawing over the app is therefore the mode's second half, and
     * the one that actually makes the claim true.
     */
    if (!ours && editorOwnsInput()) return
    event.stopPropagation = () => {}
    event.stopImmediatePropagation = () => {}
    event.preventDefault = () => {}

    // Focus is forced only for our own fields. Over the app the native default
    // action is enough, now that nothing is suppressing it.
    if (event.type !== "pointerdown" || !ours) return
    // Belt and braces for focus, which is the one default action that has to
    // survive even if a guard we have not seen yet calls the native methods
    // off a retained reference.
    const focusable = target.closest<HTMLElement>("input, textarea, select, button, [tabindex]")
    // `preventScroll`: the panel is a scroll container, and letting the browser
    // scroll a just-focused field into view would jump the list under the cursor.
    //
    // `focusControl` rather than `focus`, and this is the call that made the
    // helper necessary: forcing focus here is what put a keyboard ring on every
    // control the user CLICKED, because an engine reads a script focus as one
    // it cannot account for and keeps the ring to be safe. See `core/focus`.
    focusControl(focusable, { preventScroll: true })
  }

  const types = ["pointerdown", "mousedown", "click", "pointerup", "mouseup", "dblclick"]
  for (const type of types) window.addEventListener(type, declaw, true)
  return () => {
    for (const type of types) window.removeEventListener(type, declaw, true)
  }
}

/**
 * Words typed into one of our fields stay in it.
 *
 * Selected text in an `input` or a `textarea` is draggable by default, and the
 * default is written for a document editor rather than for a tool floating over
 * somebody else's page. Two things follow from it here, both bad. A same-window
 * text drag is a MOVE, so dragging the words out of a half-written note DELETES
 * them from the field — the note is gone and the only copy of it is whatever
 * the drop landed on. And the drop lands on the APP: a prototype with a
 * `contenteditable` in it accepts the text as an edit nobody made, on the page
 * the note was about.
 *
 * Cancelling `dragstart` is the whole fix, and it has to be `dragstart` rather
 * than `user-select` or `draggable`: the selection is the point — a note is
 * edited by selecting words in it — and `draggable="false"` governs dragging
 * the ELEMENT, which a text selection inside it is not. Cancelling the gesture
 * at its first event leaves selecting, copying and pasting untouched, and
 * leaves a drop INTO the field working, which is the direction that cannot lose
 * anything.
 *
 * Fields only, and that is deliberate: the Layers panel reorders by dragging
 * whole rows, and a guard that cancelled every `dragstart` in the chrome would
 * take that with it. A row's gesture starts on the row, never inside a field.
 *
 * `dragstart` is NOT in `declaw`'s list above, so the `preventDefault` here is
 * still the real one when this runs.
 */
function holdTextInFields(): () => void {
  const onDragStart = (event: DragEvent): void => {
    // `composedPath()[0]` rather than `target`: a companion may mount its own
    // fields in a shadow root, where `target` is retargeted to the host and
    // every field inside it would read as one element that is not a field.
    const source = event.composedPath()[0]
    if (!(source instanceof Element)) return
    if (source.closest(`[${CHROME_ATTR}]`) === null) return
    if (source.closest("input, textarea") === null) return
    event.preventDefault()
  }
  window.addEventListener("dragstart", onDragStart, true)
  return () => window.removeEventListener("dragstart", onDragStart, true)
}

/**
 * Mark a chrome scroller while it scrolls, so its scrollbar can ink in.
 *
 * The other half of the auto-hiding scrollbar in `css/base.ts`
 * (MICRO-INTERACTIONS § 13, the kit's `js/scroll-autohide.js`): the thumb is
 * clear at rest and shows while `data-scrolling` is on, which is cleared 700ms
 * after the last scroll event. Capturing and passive, because a scroll does not
 * bubble and this never cancels one; and it ignores every scroller that is not
 * the chrome's, so the app being edited gets no attribute written into it.
 */
const SCROLL_IDLE_MS = 700
function markScrolling(): () => void {
  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()
  const onScroll = (event: Event): void => {
    const node = event.target
    if (!(node instanceof Element) || !node.hasAttribute(CHROME_ATTR)) return
    node.setAttribute("data-scrolling", "")
    clearTimeout(timers.get(node))
    timers.set(node, setTimeout(() => node.removeAttribute("data-scrolling"), SCROLL_IDLE_MS))
  }
  document.addEventListener("scroll", onScroll, { capture: true, passive: true })
  return () => document.removeEventListener("scroll", onScroll, true)
}

/**
 * Who wants to know when the app area changes width.
 *
 * The two panel flags are store state and anything can subscribe to them, but
 * the WIDTHS deliberately are not: a seam drag moves them on every frame and
 * routing that through the store would wake every lane in the editor on every
 * pointermove (see the note on the subscription in `mountShell`). So the one
 * fact a floating surface actually needs — "the edges moved, re-check yourself"
 * — is published here instead, already filtered by `resize.ts` down to the
 * frames where the reported inset really changed.
 *
 * Module-level rather than on `Shell`, because the lanes that care install
 * after `mountShell` returns and would otherwise each have to be handed it.
 */
const insetListeners = new Set<() => void>()

export function onInsetsChange(fn: () => void): () => void {
  insetListeners.add(fn)
  return () => insetListeners.delete(fn)
}

/**
 * What the panels are holding right now, in the app's own pixels.
 *
 * Read off the inline properties `syncInsets` writes rather than through
 * `getComputedStyle`, for the reason the launcher reads them the same way: a
 * caller woken by `onInsetsChange` is running immediately after those writes,
 * so the inline values are this frame's by construction. A caller that is not
 * gets the last settled pair, which is the same number every surface is
 * currently drawn against.
 */
export function appInsets(): { left: number; right: number } {
  const style = document.documentElement.style
  const read = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0
  return { left: read("--de-left"), right: read("--de-right") }
}

/**
 * How wide the app believes it is: the window, less both panels.
 *
 * This is the width the app's own stylesheet is answering to — `shell/
 * app-viewport.ts` points its `vw` and its breakpoints at exactly this strip —
 * so anything in the chrome that reports "the width the app is laid out at"
 * has to ask this rather than `window.innerWidth`, or it describes a viewport
 * the app stopped using.
 */
export function canvasWidth(): number {
  const { left, right } = appInsets()
  return Math.max(0, window.innerWidth - left - right)
}

export function mountShell(): Shell {
  if (!document.getElementById(STYLE_ID)) {
    const style = el("style", { id: STYLE_ID })
    style.textContent = shellCss
    document.head.append(style)
  }

  const overlay = el("div", { class: "de-overlay-layer" })
  /*
   * WHAT IS SELECTED, SAID OUT LOUD — the chrome had no live region at all.
   *
   * Selecting an element is the most common thing anyone does in this editor
   * and it was completely silent: the outline moves, the inspector repaints
   * with twelve sections of that element's properties, and a screen-reader user
   * got no indication that anything had happened. Arrow-nudging through
   * siblings was the same, only faster.
   *
   * `polite`, not `assertive`. A selection can change several times a second
   * while somebody walks the tree with Tab, and an assertive region interrupts
   * itself on every one of them — which is how a live region becomes the thing
   * a user turns off. Polite queues and coalesces, which is what this wants.
   *
   * `atomic` because the sentence is rewritten whole rather than appended to,
   * and visually hidden rather than `display: none` — a region that is not
   * rendered is not announced, which is the failure mode this pattern exists to
   * avoid. It is clipped to a 1px box rather than sized to zero for the same
   * reason: some engines skip a zero-area node.
   */
  const announcer = el("div", {
    class: "de-announcer",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
  })
  const toolbar = el("div", { class: "de-toolbar", role: "toolbar", "aria-label": "DesignLayer" })

  const left = el("div", { class: "de-panel-body" })
  const leftPanel = el("aside", { class: "de-panel de-panel--left", "aria-label": "Left panel" }, [left])

  const right = el("div", { class: "de-panel-body" })
  const rightPanel = el(
    "aside",
    { class: "de-panel de-panel--right", "aria-label": "Inspector" },
    [right]
  )

  /*
   * The way back, mounted with everything else rather than on demand.
   *
   * It has to exist before it is needed: its entrance is a CSS transition off
   * the state class, and an element created in the same frame the class lands
   * has no previous value to transition FROM — it would simply appear. Parked
   * at the end of its own exit (see `css/launcher.ts`) it is inert and
   * untabbable until the editor actually stands down.
   */
  const launcher = createLauncher(() => setState({ chromeHidden: false, hovered: null }))

  /*
   * The panels stop being two independent slabs and become a row.
   *
   * `mountPanelResize` takes the two elements built above, puts them either
   * side of an empty canvas box in a flex rail, and hangs a draggable seam on
   * each inner edge. Nothing about how either panel LOOKS is decided there —
   * the widths it writes are the same two numbers the stylesheet already had,
   * until the user moves one. See `resize.ts` for why the library's core is
   * wired by hand rather than through its React adapter.
   */
  const resize = mountPanelResize({
    left: leftPanel,
    right: rightPanel,
    onResize: () => syncInsets(),
    onClose: (side) =>
      setState(side === "left" ? { layersOpen: false } : { inspectorOpen: false }),
  })

  /*
   * THE WAY OUT, and it is the pair to ⇧⌘1 rather than a skip link.
   *
   * A skip link is the wrong shape here, and the reason is worth writing down
   * because the instinct is so strong. A skip link exists when a large block of
   * chrome stands BETWEEN the top of a document and its content. This chrome is
   * appended to `<body>`, so it is last in the order: there is nothing behind
   * it to skip to.
   *
   * The real gap is the mirror image. A keyboard user who has arrived in the
   * editor — by ⇧⌘1, or by tabbing to the end of the app — faces roughly forty
   * stops across a toolbar, two panels and whatever the inspector is showing,
   * with no way back to the page short of tabbing through all of them. The
   * editor already owns the right verb for that: collapse to the disc, and the
   * page has its keyboard back.
   *
   * So this is ONE stop, first in the chrome's order, doing exactly that. A
   * real `<button>` rather than an anchor, because it performs an action rather
   * than going to a fragment.
   *
   * VISUALLY HIDDEN UNTIL FOCUSED, which is the whole convention: a pointer
   * user has the launcher disc and the ⌘. accelerator and does not need a
   * forty-first control in the bar, while a keyboard user meets this one before
   * any of the forty. `.de-escape` in `css/base.ts` is the clipped-until-
   * focused half.
   *
   * It does NOT move focus itself. Collapsing takes the chrome to
   * `visibility: hidden`, so the browser drops focus to `<body>` of its own
   * accord and the next Tab resumes at the top of the page — which is where
   * someone leaving the editor is trying to get to. Forcing focus onto a
   * particular element of an app this editor did not write would be a guess.
   */
  const escape = el(
    "button",
    {
      class: "de-escape",
      type: "button",
      onclick: () => setState({ chromeHidden: true }),
    },
    ["Hide the editor and return to the page"]
  )

  const root = el("div", { class: "de-root" }, [
    escape,
    announcer,
    overlay,
    toolbar,
    resize.rail,
    launcher.element,
  ])
  /*
   * THE EDITOR ARRIVES RATHER THAN SIMPLY EXISTING.
   *
   * Five popovers in this chrome were given entrances, and `css/base.ts` argues
   * the case in as many words — a surface that materialises at its final
   * appearance reads as a paste. The three LARGEST surfaces never got one: the
   * bar and both panels appeared between two frames, over an app the reader was
   * already looking at, which is the moment the argument applies hardest.
   *
   * It is spelled as the chrome-hidden state plus a removal rather than as an
   * entrance animation of its own, and that is the whole trick: the editor
   * mounts at the END of its own exit — panels off their edges, bar
   * transparent — and then plays that exit backwards. So arriving and leaving
   * cannot drift apart, there is no second set of keyframes to keep in
   * agreement, and reduced motion is already handled because `css/base.ts`
   * governs those same rules.
   *
   * Two frames, not one. The class has to be on the element for a frame before
   * it is taken off, or the browser coalesces both styles into the same
   * recalculation and there is no starting value to animate from — the surfaces
   * would arrive instantly, which is the bug this replaces.
   *
   * And not drawn at all for the first frame. The shell mounts in the task
   * that committed the app (`core/host-readiness.ts`), so that frame styles
   * and lays out the app for the first time; the chrome in it would be
   * invisible anyway — panels off their edges, bar transparent — but styling
   * it in the same pass made that pass cost the chrome's own share several
   * times over (measured: ~4ms of style on a cold load, against ~1ms when the
   * chrome is styled on its own straight after). So the root is out of the
   * first frame, back in the task after it, and arrives from there. Nothing
   * measures it in between: the travelling tab pill, the one reader, places
   * itself from its ResizeObserver once the root has a size.
   */
  root.classList.add("de-root--arriving")
  root.style.display = "none"
  document.body.append(root)
  document.documentElement.classList.add("designlayer-active")
  requestAnimationFrame(() =>
    setTimeout(() => {
      root.style.removeProperty("display")
      if (!root.getAttribute("style")) root.removeAttribute("style")
      requestAnimationFrame(() => {
        requestAnimationFrame(() => root.classList.remove("de-root--arriving"))
      })
    })
  )
  // Before the focus guard, not after: the guard forces focus from its own
  // window-capture listener, and it has to read a modality that is already this
  // gesture's rather than the last one's.
  const releaseFocusModality = installFocusModality()
  const releaseChromeFocus = restoreChromeFocus()
  const releaseFieldText = holdTextInFields()
  const releaseScrolling = markScrolling()
  const releaseLeftBar = mountOverlayScrollbar(leftPanel, SCROLL_IDLE_MS)
  const releaseRightBar = mountOverlayScrollbar(rightPanel, SCROLL_IDLE_MS)

  /**
   * Which panels exist right now. Separate from the insets below, because a
   * panel opening or closing changes how much room the OTHER one may take —
   * so this has to settle before anything reads a width back out.
   */
  const syncPanels = () => {
    const { layersOpen, inspectorOpen } = getState()
    resize.setOpen("left", layersOpen)
    resize.setOpen("right", inspectorOpen)
  }

  /*
   * The app's inset changes in ONE step, at the moment of the click, while the
   * panels are still covering the ground they are about to leave.
   *
   * The alternative is animating the inset, and it is the wrong one. The inset
   * is padding on `<html>`; transitioning it relayouts the entire app on every
   * frame of a 240ms slide, and the app is precisely what the user asked to
   * see. So the layout moves once and the motion is carried by transforms,
   * which is the trade the whole feature is built around: the panels slide
   * over an app that has already finished resizing.
   *
   * A DRAG is the one exception, and it is `resize.ts` that draws the line
   * rather than this function: while the user is holding a seam, `inset()`
   * reports the live width and the app reflows with it, because a panel you can
   * pull whose page does not follow is not a resize — it is a preview that
   * commits on release. Every other frame still reports the destination, so
   * folds and window resizes keep the one-step behaviour above.
   */
  const syncInsets = () => {
    const { chromeHidden } = getState()
    const style = document.documentElement.style
    // The panels are docked, so the inset is the panel and nothing else. It
    // used to add a gutter on both sides of each one, which is what left a
    // strip of live app showing down the outside edge of a floating card.
    // A closed panel reports zero, so "is it open" is already in these two.
    const left = chromeHidden ? 0 : resize.inset("left")
    const right = chromeHidden ? 0 : resize.inset("right")
    style.setProperty("--de-left", `${left}px`)
    style.setProperty("--de-right", `${right}px`)
    style.setProperty("--de-top", "0px")

    /*
     * The toolbar centres on a second pair that IGNORES hiding.
     *
     * The bar is centred in the canvas — the strip between the two insets —
     * and the insets go to zero the instant the chrome is hidden. Sharing one
     * pair meant the bar re-centred on the viewport in the same frame the hide
     * began: a 10px sideways jump at full opacity, before the fade had started.
     * Invisible while the bar was also dropping off the bottom, obvious the
     * moment the drop was replaced by a fade.
     *
     * Holding the panel-open values through the hide keeps the bar where it
     * was while it fades out, and means it fades back in already in place —
     * there is nothing to re-centre, because it never moved. Where an unseen
     * bar "is" does not otherwise matter.
     */
    style.setProperty("--de-bar-left", `${resize.inset("left")}px`)
    style.setProperty("--de-bar-right", `${resize.inset("right")}px`)
    // The host's docked panel (Leva here) sits against the right edge; keep it
    // clear of the inspector. The property name is the host's to choose.
    style.setProperty(config.chrome.dockedPanel.offsetVar, right ? `-${right}px` : "0px")
    /*
     * Announced AFTER the properties are written, so a listener that clamps
     * itself against them reads this frame's edges rather than the last one's.
     *
     * The bar's clamp reads these two inline values directly (see `edge` in
     * `shell/launcher.ts`), which is only exact because of this ordering.
     */
    for (const listener of insetListeners) listener()
  }

  // The mode as a class, because one thing about it is CSS's to answer: whether
  // the app's `pointer-events: none` glyphs are hit-testable (see base.ts).
  // Hidden chrome answers the same as interactive mode here — it is the same
  // claim, that the editor is not standing between the pointer and the app.
  const syncMode = () => {
    document.documentElement.classList.toggle("designlayer-inspecting", editorOwnsInput())
  }

  /*
   * The whole hide/show transition is a class, and this is the line that
   * flips it.
   *
   * Every surface reads it from CSS — the panels slide off their own edges,
   * the toolbar fades out where it stands, the disc shows up in its corner.
   * Nothing here schedules or sequences any of that: a timer driving three
   * surfaces is a timer that can be interrupted halfway by a second click, and
   * transitions retarget from wherever they are, which is the behaviour a
   * toggle needs.
   */
  const syncChrome = () => {
    document.documentElement.classList.toggle(
      "designlayer-chrome-hidden",
      getState().chromeHidden
    )
  }


  syncPanels()
  /*
   * After `syncInsets` exists, not at the point the rail is appended.
   *
   * `ready` fits the stored widths to the real window, and fitting can move a
   * width — which calls back into `onResize`, which is `syncInsets`. Calling it
   * up at the `append` would reach that binding inside its own temporal dead
   * zone, and the throw takes the rest of `mountShell` with it: the vendor
   * chrome suppression, the focus restoration and the store subscription all
   * sit below it. Measured exactly that way — the editor mounted with no insets
   * and the vendor's own panels showing through.
   */
  resize.ready()
  syncInsets()
  syncMode()
  syncChrome()
  // Only the panel toggles and the hide switch move the insets, and only the
  // mode switch and the hide switch move the mode. `hovered` changes on every
  // pointermove, so an unguarded subscription would write inline custom
  // properties — and force a style recalc of the whole app — on mouse motion.
  //
  // A drag does not come through here at all: the widths it moves are not
  // editor state, and routing them through the store would wake every lane
  // subscribed to it on every frame of a gesture. The resize lane calls
  // `syncInsets` directly instead.
  const unsubscribe = subscribe((next, previous) => {
    const hiddenChanged = next.chromeHidden !== previous.chromeHidden
    if (next.interactive !== previous.interactive || hiddenChanged) syncMode()
    if (hiddenChanged) syncChrome()
    if (
      !hiddenChanged &&
      next.layersOpen === previous.layersOpen &&
      next.inspectorOpen === previous.inspectorOpen
    ) {
      return
    }
    syncPanels()
    syncInsets()
  })

  return {
    slots: { overlay, toolbar, left, right },
    announcer,
    root,
    destroy() {
      unsubscribe()
      releaseChromeFocus()
      releaseFieldText()
      releaseScrolling()
      releaseLeftBar()
      releaseRightBar()
      releaseFocusModality()
      resize.destroy()
      launcher.destroy()
      root.remove()
      document.documentElement.classList.remove("designlayer-active")
      document.documentElement.classList.remove("designlayer-inspecting")
      document.documentElement.classList.remove("designlayer-chrome-hidden")
      document.documentElement.style.removeProperty("--de-left")
      document.documentElement.style.removeProperty("--de-right")
      document.documentElement.style.removeProperty("--de-top")
      document.documentElement.style.removeProperty("--de-bar-left")
      document.documentElement.style.removeProperty("--de-bar-right")
      document.documentElement.style.removeProperty(config.chrome.dockedPanel.offsetVar)
      document.getElementById(STYLE_ID)?.remove()
    },
  }
}
