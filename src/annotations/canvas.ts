/**
 * Annotation capture on the canvas, and the pins it leaves behind.
 *
 * The store remembers notes; this is where one gets made. Three gestures,
 * because the thing worth annotating is not always an element: a click pins a
 * note on what is under it, a drag pins one on a box that may contain nothing
 * at all, and a text selection pins one on the exact words. The drag is the
 * reason the mode exists — a gap that is too tight has no element to select,
 * and every other surface in this editor can only talk about elements.
 *
 * Everything here is inert unless `annotating` is set. The mode lives in the
 * store rather than in this file for the reason `core/store` gives, and the
 * consequence lands here: the selection lane keeps every handler it has
 * installed and stands down through `selectionOwnsInput()`, so this module
 * never unbinds anything to take the pointer. It only has to be sure that when
 * it does take it, it takes all of it.
 */

import { clamp, el, isCanvasElement, isChrome } from "../core/dom"
import { tokens } from "../core/tokens"
import { arriveFrom, playExit, prefersReducedMotion } from "../core/motion"
import { editorOwnsInput, editorStandDownChanged } from "../core/store"
import type { EditorContext } from "../core/context"
import { MARKER } from "../core/css/annotations"
import {
  annotationSettings,
  annotations,
  notePinsVisible,
  onAnnotationsChange,
  onMarkerLayerChange,
  onSettingsChange,
  setMarkerLayer,
} from "./store"
import { pinNote, rewriteNote } from "./actions"
import { editElement, onEditsChange } from "./journal"
import { describeElement, outboxItems, outboxNumbers } from "./output"
import type { AnnotationKind, AnnotationRect, AnnotationRecord, EditRecord, OutboxItem } from "./types"

/**
 * One pixel more than the marquee's threshold, and deliberately so: a region
 * note is the only gesture here that cannot be undone by clicking elsewhere —
 * it opens a composer — so a hand that shook during a click should still read
 * as a click.
 */
const DRAG_THRESHOLD = 4

/** Keep-out from the viewport edge, the same margin the token picker uses. */
const EDGE = 8

/** Gap between the thing being annotated and the composer above or below it. */
const GAP = 8

/** How far past the viewport a pin may sit before it stops being painted. */
const BLEED = 32

/**
 * The contract between a note's two views: the pin here, and the row in the
 * Notes panel.
 *
 * They are ONE note seen twice, so they have to light up together — a list of
 * six rows beside six pins is unreadable unless pointing at either half says
 * which half of the pair the other is. The seam is three events on `window`,
 * the same one `designlayer:highlight-elements` already uses between the
 * options panel and the canvas, and for the same reason: the two surfaces are
 * mounted independently, neither owns the other, and an import either way
 * would make the marker layer unusable without the panel or vice versa.
 *
 *   `designlayer:annotation-hover`  panel -> canvas  `{ id: string | null }`
 *     The pointer is on that row, or has left every row (`null`). The matching
 *     pin takes `MARKER_ACTIVE`; the stylesheet owns what that looks like.
 *
 *   `designlayer:marker-hover`      canvas -> panel  `{ id: string | null }`
 *     The mirror of it. The pointer is on that pin, or has left it (`null`),
 *     and the panel lights the matching row.
 *
 *   `designlayer:annotation-edit`   panel -> canvas  `{ id: string }`
 *     Re-open that note's composer over the page, prefilled, saving back to
 *     the SAME note rather than writing a second one.
 *
 * `null` is a value in the hover pair rather than a second event, because the
 * two halves have to be handled by one code path: a listener that only ever
 * hears "now this one" is how a highlight gets stuck on a row nobody is on.
 */
const HOVER_EVENT = "designlayer:annotation-hover"
const MARKER_HOVER_EVENT = "designlayer:marker-hover"
const EDIT_EVENT = "designlayer:annotation-edit"

/** The pin the panel is pointing at. The look belongs to `css/annotations`. */
const MARKER_ACTIVE = "de-ann-marker--active"
/**
 * A pin that has just been placed, for the length of its arrival.
 *
 * Saving a note used to reveal a pooled node with `display: block`, which is
 * not something the browser can animate and is the one moment in this layer
 * that is genuinely an OBJECT landing on a surface rather than a value
 * changing. The class is added for the note's first paint and taken off once
 * the animation has run; `css/annotations.ts` owns the rest.
 */
const MARKER_ARRIVING = "de-ann-marker--arriving"
/** Read off the ramp rather than restated, so the class and the timer agree. */
const ARRIVE_MS = (): number =>
  prefersReducedMotion() ? 0 : Number.parseFloat(tokens.duration.reveal)

/** A viewport-space box: what a gesture produced and what the composer anchors to. */
interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** A viewport-space point: the top-left corner a pin is anchored to. */
interface Point {
  left: number
  top: number
}

/**
 * One pin as `paint` decided it, before any of it is written to a node.
 *
 * Built for every item first and written second, which is the read-then-write
 * split `paint` exists to keep: every rect this needs has been measured by the
 * time the first style is set.
 */
interface Pin {
  id: string
  kind: "note" | "edit"
  label: string
  /** The accessible name, which carries the number and says which kind it is. */
  name: string
  /** The tooltip: a note's own words, an edit's change. */
  title: string
  left: number
  top: number
}

/**
 * Space between two pins fanned out from one anchor. Enough to read them as two
 * objects; small enough that they still read as belonging to one element.
 */
const FAN_GAP = 2

/** One completed gesture, before the user has said anything about it. */
interface Gesture {
  kind: AnnotationKind
  box: Box
  /** The live node the note is about, or `null` for a region over empty space. */
  element: Element | null
  selectedText: string | null
}


export function installAnnotations(context: EditorContext): void {
  const layer = el("div", { class: "de-ann-layer" })
  context.slots.overlay.append(layer)

  /** Pins are pooled: a scroll must not allocate DOM on every frame. */
  const markers: HTMLButtonElement[] = []

  let outline: HTMLElement | null = null
  let region: HTMLElement | null = null
  let composer: HTMLElement | null = null
  let dismiss: () => void = () => {}

  /**
   * The element under the pointer while annotating.
   *
   * Local rather than `state.hovered`, and that is not tidiness: writing it to
   * the store would wake the selection painter and draw an accent outline over
   * the element as well, which is the editor claiming it is about to select
   * something it will not select.
   */
  let hovered: Element | null = null

  /**
   * Whether the mode's transient surfaces are currently on screen.
   *
   * Not the same question as "is the mode on", and the gap is the bug it was
   * added for. The mode is a switch the designer threw; this is whether the
   * editor is in a position to honour it. Collapsing the editor answers the
   * second one NO while leaving the first one YES, and before this existed the
   * hover outline stayed painted over the app — an accent frame around whatever
   * the pointer happened to be over when the chrome went down, with no editor on
   * screen to explain it and no gesture left that could clear it.
   *
   * Held as a flag rather than recomputed, because `enter` and `leave` are not
   * idempotent — `enter` would append a second outline and `leave` would
   * discard a composer that is already gone — so the transition has to be
   * detected, not the state.
   */
  let showing = false

  /**
   * The note the PANEL says its pointer is on, held as an id rather than as a
   * node.
   *
   * The pins are pooled, so the button carrying a note this frame may carry a
   * different one the next. Latching onto whichever element matched when the
   * event arrived is exactly how a highlight ends up on the wrong pin after a
   * scroll; deriving it in `paint` from the id means the class follows the
   * note, which is the only thing the panel named.
   */
  let activeNote: string | null = null
  /** Which notes have already had their pin arrive — see `MARKER_ARRIVING`. */
  const announced = new Set<string>()

  /**
   * The note whose pin we last told the panel about, so the mirror is only
   * dispatched on a real change.
   */
  let reportedHover: string | null = null

  const reportMarkerHover = (id: string | null): void => {
    if (reportedHover === id) return
    reportedHover = id
    window.dispatchEvent(new CustomEvent(MARKER_HOVER_EVENT, { detail: { id } }))
  }

  let originX = 0
  let originY = 0
  let pending = false
  let dragging = false
  let started: Gesture | null = null

  const annotating = (): boolean => context.getState().annotating

  /**
   * Whether a node may be the subject of a note, under the scope now active.
   *
   * One question asked in five places, because the alternative — `isChrome`
   * spelled out at each gesture — is what made "annotate the editor itself"
   * look like a five-way change rather than a one-way one. Every caller wants
   * the same answer and none of them wants to know how the scope is stored.
   *
   * `layer.contains` is the guard against infinite regress, and it is the part
   * that CANNOT be dropped. In app scope `isCanvasElement` already rejected
   * everything this module draws, because `el()` marks it `data-designlayer`;
   * in editor scope that rejection is precisely what is being turned off, so
   * the lane's own pins, composer and drag rect would become annotatable and
   * the first note filed would be a note about a note. Excluding this one
   * container is narrower, and it survives the flip.
   */
  const targetable = (node: EventTarget | null): node is Element => {
    if (!(node instanceof Element)) return false
    if (layer.contains(node)) return false
    return annotationSettings().scope === "editor" ? isChrome(node) : isCanvasElement(node)
  }

  /**
   * The topmost targetable element under a point.
   *
   * `elementsFromPoint` rather than `elementFromPoint` because our own pins,
   * the composer and the live drag rect all sit over the page: the first hit is
   * regularly one of ours, and `targetable` walks past it to whatever is really
   * being pointed at — the app in app scope, the editor's chrome in editor
   * scope.
   */
  const elementAt = (x: number, y: number): Element | null => {
    for (const node of document.elementsFromPoint(x, y)) {
      if (targetable(node)) return node
    }
    return null
  }

  const boxOf = (rect: DOMRect): Box => ({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  })

  /**
   * Viewport to page, at the moment of the gesture.
   *
   * Converted here and never later: the composer stays open while the user
   * types, the page underneath still scrolls, and a conversion done at save
   * time would offset the note by however far they scrolled while thinking.
   */
  const toPageRect = (box: Box): AnnotationRect => ({
    x: box.left + window.scrollX,
    y: box.top + window.scrollY,
    width: box.width,
    height: box.height,
  })

  // ---------- blocking the app ----------

  /**
   * Swallow a page interaction while annotating.
   *
   * Capture on `window`, which is the first node in the propagation path, so
   * the app never sees the event at all. Bubble phase would be far too late:
   * by then the menu item the user was trying to annotate has already run its
   * own handler and closed the menu it lives in, and there is no state left to
   * annotate. That case is the whole reason `blockPageInteractions` defaults
   * on, and turning it off is for the other case — driving the app INTO the
   * state worth a note — where the click has to land.
   *
   * Cancelling the press has a second effect worth having: the default action
   * of a press is to collapse the current text selection, so preventing it is
   * what keeps a selection alive long enough for the gesture to read it.
   */
  const swallow = (event: Event): void => {
    if (!annotating() || !editorOwnsInput()) return
    if (!targetable(event.target)) return
    // Editor scope always swallows. The whole gesture is aimed at the editor's
    // own controls, so letting the click through would switch the tab you were
    // trying to annotate, and leave a note about the tab you landed on.
    if (annotationSettings().scope === "app" && !annotationSettings().blockPageInteractions) return
    event.preventDefault()
    event.stopPropagation()
  }

  // ---------- the composer ----------

  /**
   * The edges the composer may not cross.
   *
   * NOT the viewport. The shell insets the app between its docked panels and
   * publishes where they end as `--de-left` / `--de-right`, so on a 1440px
   * screen with the inspector open the last usable pixel is 1180. Clamping
   * against `innerWidth` put the Save button underneath the inspector — seen
   * on the Angular host the first time a note was written on anything in the
   * right half of the page, with Cancel the only button still reachable.
   *
   * Read per placement rather than cached: a panel can be toggled while the
   * composer is open, and Hide editor moves both edges at once.
   */
  const bounds = (): { left: number; right: number } => {
    const style = getComputedStyle(document.documentElement)
    const read = (name: string): number => {
      const value = Number.parseFloat(style.getPropertyValue(name))
      return Number.isFinite(value) ? value : 0
    }
    return { left: read("--de-left"), right: window.innerWidth - read("--de-right") }
  }

  /**
   * Anchored to what is being annotated, flipped above it when the popover
   * would run off the bottom. Measured after mount rather than estimated: the
   * stylesheet owns its size, and a Save button past the edge is a note that
   * cannot be saved.
   */
  const place = (node: HTMLElement, anchor: Box): (() => void) => {
    const box = node.getBoundingClientRect()
    const edges = bounds()
    const min = edges.left + EDGE
    const max = Math.max(min, edges.right - box.width - EDGE)
    const left = clamp(anchor.left, min, max)
    const below = anchor.top + anchor.height + GAP
    const fits = below + box.height + EDGE <= window.innerHeight
    const top = fits ? below : Math.max(EDGE, anchor.top - GAP - box.height)
    /*
     * Measured now, written when the caller says. `openComposer` focuses the
     * field between the two: focus reads layout to scroll the caret into view,
     * and with the position already written that read was a second forced
     * layout of the page on the release that opens the card. The card sits in
     * a fixed, full-viewport layer, so focusing it a line before it moves can
     * scroll nothing, and its size does not depend on where it sits.
     */
    return () => {
      node.style.left = `${left}px`
      node.style.top = `${top}px`
      // Aim the entrance at the pin. A composer pushed above its anchor — which
      // is every note taken on the lower half of a page — used to grow out of
      // its top edge and drift downward, away from the thing it is attached to.
      arriveFrom(node, fits ? "below" : "above")
    }
  }

  /**
   * Hold an already-placed card inside the window after it has changed height.
   *
   * `place` runs once, on open, and the card it measured is not the card that
   * exists ten words later: the field grows with the note. Without this, a note
   * started near the foot of the page pushes its own Save button under the edge
   * of the window as it is typed — which is what the textarea's resize grip
   * used to do in one drag, and the reason the grip is gone.
   *
   * Only the top moves. The left edge was clamped against the docked panels,
   * and sliding it sideways mid-sentence would be the card wandering away from
   * the pin it names.
   */
  const settle = (node: HTMLElement): void => {
    const box = node.getBoundingClientRect()
    const top = clamp(box.top, EDGE, Math.max(EDGE, window.innerHeight - EDGE - box.height))
    if (Math.abs(top - box.top) < 0.5) return
    node.style.top = `${top}px`
  }

  const openComposer = (anchor: Box, initial: string, commit: (comment: string) => void): void => {
    // One at a time. A second gesture while the first is still being typed
    // discards the draft rather than stacking two popovers over each other.
    dismiss()

    const text = el("textarea", {
      class: "de-ann-composer-text",
      placeholder: "What should change?",
      "aria-label": "Note",
      rows: 3,
    })
    text.value = initial

    /**
     * The field follows the note, instead of being dragged to fit it.
     *
     * `css/annotations.ts` sets `resize: none` and a `max-height`; this is the
     * other half of that decision. Height is measured from the content — the
     * box is collapsed to `auto` first, because a field that has already grown
     * reports its own height as `scrollHeight` and would never come back down
     * when the note is cut back to one line. Past the ceiling the stylesheet
     * caps the box and the field scrolls, so this can never place the actions
     * out of reach the way the grip could.
     *
     * A field that reports no layout at all — jsdom, or a card mounted while
     * hidden — is left at its stylesheet height rather than pinned to 0px.
     */
    const grow = (): void => {
      text.style.height = "auto"
      const content = text.scrollHeight
      if (!content) return
      // `box-sizing: border-box` in the chrome's reset, so the height we set
      // has to carry the borders that `scrollHeight` leaves out.
      text.style.height = `${content + text.offsetHeight - text.clientHeight}px`
    }

    const close = (): void => {
      window.removeEventListener("keydown", onKey, true)
      // Gone now, faded on an inert copy (`playExit` in core/motion).
      if (composer) playExit(composer)
      composer?.remove()
      composer = null
      dismiss = () => {}
    }

    const save = (): void => {
      const comment = text.value.trim()
      // An empty note is the user changing their mind mid-gesture, which is the
      // same thing as cancelling — and a pin with nothing to say would be one
      // more marker on the page that an agent has to be told to ignore.
      if (comment) commit(comment)
      close()
    }

    /**
     * Escape cancels wherever the focus happens to be.
     *
     * At capture on `window`, because the canvas keymap answers Escape too: it
     * stands down for a text field, but the moment focus is anywhere else the
     * first Escape would clear the selection instead of closing this.
     */
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      close()
    }

    text.addEventListener("keydown", (event) => {
      // Enter saves and Shift+Enter is the newline, not the other way round:
      // almost every note is one line, and every comment box the designer has
      // ever used has already trained this pair.
      if (event.key !== "Enter" || event.shiftKey) return
      event.preventDefault()
      save()
    })

    text.addEventListener("input", () => {
      grow()
      if (card) settle(card)
    })

    const card = el(
      "div",
      {
        class: "de-ann-composer",
        role: "dialog",
        "aria-label": "Leave a note",
        // The layer is inert so it cannot swallow the app's clicks; each
        // interactive surface opts back in for itself, the same shape the
        // resize handles in `canvas/selection` use.
        style: "pointer-events:auto",
      },
      [
        text,
        el("div", { class: "de-ann-composer-actions" }, [
          el("button", { class: "de-button", type: "button", onclick: close }, ["Cancel"]),
          el("button", { class: "de-button de-button--primary", type: "button", onclick: save }, [
            "Save note",
          ]),
        ]),
      ]
    )

    composer = card
    layer.append(card)
    // Sized before it is placed, so a note being re-opened for editing is
    // measured at the height its text needs rather than at the empty one.
    grow()
    const position = place(card, anchor)
    window.addEventListener("keydown", onKey, true)
    dismiss = close
    text.focus()
    position()
  }

  /**
   * Turn a finished gesture into a note.
   *
   * The target is described HERE rather than when the user presses Save. The
   * page under this editor is a dev server that hot-reloads, and a reload while
   * the composer is open would otherwise have us write down whatever replaced
   * the element instead of the one they pointed at.
   */
  const capture = (gesture: Gesture): void => {
    const target = gesture.element ? describeElement(gesture.element) : null
    const rect = toPageRect(gesture.box)
    // `pinNote`, not the store's `addAnnotation`: pinning is a step on the one
    // undo timeline, so Cmd+Z after a note takes the note back rather than the
    // padding change made before it.
    openComposer(gesture.box, "", (comment) => {
      pinNote({
        kind: gesture.kind,
        comment,
        url: window.location.href,
        rect,
        target,
        selectedText: gesture.selectedText,
        element: gesture.element,
      })
    })
  }

  /**
   * A stored box dragged back inside the editable band, keeping its size.
   *
   * Only the fallback path needs this. A pin can only be clicked where it is
   * painted, and `markerPoint` hides the ones that are off screen — but the
   * Notes panel can ask to edit a note that is a screen and a half further
   * down, and the stored rect converted at the current scroll then anchors the
   * composer somewhere nobody can see or type into.
   */
  const intoView = (box: Box): Box => {
    const edges = bounds()
    const min = edges.left + EDGE
    return {
      ...box,
      left: clamp(box.left, min, Math.max(min, edges.right - EDGE)),
      top: clamp(box.top, EDGE, Math.max(EDGE, window.innerHeight - EDGE)),
    }
  }

  /**
   * Re-opening a note edits it rather than starting another one.
   *
   * The live element wins when there still is one; a reload dropped every
   * node, so the stored page rect is all a rehydrated note has left, and it is
   * still enough to put the composer beside the place the note is about.
   */
  const reopen = (note: AnnotationRecord): void => {
    const live = note.element
    const anchor =
      live && live.isConnected
        ? boxOf(live.getBoundingClientRect())
        : intoView({
            left: note.rect.x - window.scrollX,
            top: note.rect.y - window.scrollY,
            width: note.rect.width,
            height: note.rect.height,
          })
    openComposer(anchor, note.comment, (comment) => rewriteNote(note.id, comment))
  }

  // ---------- the marker layer ----------

  /*
   * The outbox as the pins need it, rebuilt only when notes or edits change.
   *
   * `paint` runs every frame while any pin is on a live element, which is from
   * the first style change of a session onward. Rebuilding the merged, sorted
   * list, its numbering and a linear `editElement` lookup per edit on each of
   * those frames was O(edits²) per frame, forever. Both stores announce every
   * change, and the element an edit was made on never changes afterwards.
   */
  let outbox: {
    items: OutboxItem[]
    numbers: Map<string, number>
    elements: Map<string, Element | null>
    ids: Set<string>
  } | null = null
  const cached = () => {
    if (!outbox) {
      const items = outboxItems()
      const elements = new Map<string, Element | null>()
      for (const item of items) if (item.type === "edit") elements.set(item.edit.id, editElement(item.edit.id))
      outbox = {
        items,
        numbers: outboxNumbers(items),
        elements,
        ids: new Set(items.map((item) => (item.type === "note" ? item.note.id : item.edit.id))),
      }
    }
    return outbox
  }
  const liveEditElement = (id: string): Element | null => {
    const element = cached().elements.get(id)
    return element?.isConnected ? element : null
  }

  /*
   * When each unattached note last tried its selector. A miss is retried at
   * most this often — or at once when the notes or the route change — rather
   * than on every frame of every scroll.
   */
  const REATTACH_MS = 500
  const attempted = new Map<string, number>()

  const markerAt = (index: number): HTMLButtonElement => {
    const pooled = markers[index]
    if (pooled) return pooled
    const marker = el("button", {
      class: "de-ann-marker",
      type: "button",
      style: "pointer-events:auto",
    })
    marker.addEventListener("click", (event) => {
      // The pin belongs to the editor, not to the page beneath it, and while
      // annotating the next press would otherwise pin a second note on top.
      event.preventDefault()
      event.stopPropagation()
      const id = marker.dataset.item
      if (!id) return
      /*
       * An edit's pin SELECTS what was edited instead of opening a composer.
       * There are no words on an edit to rewrite: what the designer wants from
       * that pin is the element back under the inspector, where the change can
       * be looked at or changed again.
       */
      if (marker.dataset.kind === "edit") {
        const element = editElement(id)
        if (element?.isConnected) context.select(element)
        return
      }
      const note = annotations().find((entry) => entry.id === id)
      if (note) reopen(note)
    })
    /**
     * The mirror of the panel's own hover, and the id is captured on the way
     * IN rather than re-read on the way out.
     *
     * `dataset.item` is repainted under the pointer whenever the set of items
     * changes, so a leave handler that read it again could clear the highlight
     * for a note the pointer never touched — or, worse, decline to clear the
     * one it did. The guard is what makes pins that overlap safe: the second
     * pin has already claimed the mirror by the time the first one leaves.
     */
    let entered: string | null = null
    marker.addEventListener("pointerenter", () => {
      entered = marker.dataset.item ?? null
      reportMarkerHover(entered)
    })
    marker.addEventListener("pointerleave", () => {
      if (reportedHover === entered) reportMarkerHover(null)
      entered = null
    })
    markers.push(marker)
    layer.append(marker)
    return marker
  }

  /**
   * Put a rehydrated note back on the element it was written about.
   *
   * A reload drops every `element`, and until this existed the marker fell
   * straight through to its stored page rect for the rest of the session. That
   * is only equivalent to the live node while the PAGE is what scrolls, and in
   * an app that scrolls an inner container — which is most of them — the window
   * never scrolls at all. `window.scrollY` stays 0, the rect never changes, and
   * the pin freezes at the coordinate it was dropped on while the content
   * moves out from under it: the first note ends up somewhere its element no
   * longer is, or off the top of the viewport where `markerPoint` hides it, and
   * it reads as a marker that has gone missing.
   *
   * The selector is the same one `cssPath` built for the agent brief, and it
   * was already written to disambiguate siblings. Re-resolving costs one query
   * per note; a hit is cached back onto the record, and a miss waits
   * `REATTACH_MS` before the next try (see `attempted`). It is deliberately
   * NOT persisted: the element is live state, and the whole point is that it
   * is re-derived after a reload.
   */
  const reattach = (note: AnnotationRecord): Element | null => {
    const selector = note.target?.selector
    if (!selector) return null
    let found: Element | null = null
    try {
      found = document.querySelector(selector)
    } catch {
      // A selector the page can no longer parse is a miss, not a crash.
      found = null
    }
    // Re-attach only to something the CURRENT scope would let you annotate.
    //
    // The rule used to be "never the editor's own chrome", on the grounds that
    // a marker anchored to a panel would follow the panel around and annotate
    // the annotator. That is still exactly right in app scope, and `targetable`
    // still says so — it also keeps rejecting this lane's own layer, which is
    // the half of that reasoning that must never lapse.
    //
    // In editor scope a panel is the legitimate subject, so a note about one
    // re-finds it after a reload instead of falling back to its captured box
    // and drifting the moment the panel is resized.
    note.element = targetable(found) ? found : null
    return note.element
  }

  /**
   * Where a note's pin goes this frame, before it is fanned out or culled.
   *
   * The live element wins over the stored rect whenever there still is one:
   * that is the whole reason the record holds a node it never persists — a
   * sticky header or an accordion opening above the element moves it without
   * moving the page, and the stored page rect cannot know. Off-screen pins are
   * hidden (`inView`) rather than parked past the edge, because a button
   * positioned out of view is still in the tab order and Tab would walk pins
   * nobody can see.
   */
  const noteAnchor = (note: AnnotationRecord, now: number): Point => {
    let live = note.element?.isConnected ? note.element : null
    if (!live && now - (attempted.get(note.id) ?? -Infinity) >= REATTACH_MS) {
      attempted.set(note.id, now)
      live = reattach(note)
    }
    const rect =
      live && live.isConnected
        ? live.getBoundingClientRect()
        : { left: note.rect.x - window.scrollX, top: note.rect.y - window.scrollY }
    return { left: rect.left, top: rect.top }
  }

  /**
   * Where an edit's pin goes, or `null` when it has nowhere to go.
   *
   * Only ever the live element. An edit keeps no page rect of its own, and
   * the node it was made on is the only honest place to say "this changed":
   * once the app has re-rendered it away the row stays in the Changes tab, but
   * a pin at a remembered coordinate would claim a change on whatever now sits
   * there.
   */
  const editAnchor = (edit: EditRecord): Point | null => {
    const live = liveEditElement(edit.id)
    if (!live) return null
    const rect = live.getBoundingClientRect()
    return { left: rect.left, top: rect.top }
  }

  const inView = (point: Point): boolean =>
    point.left >= -BLEED &&
    point.top >= -BLEED &&
    point.left <= window.innerWidth + BLEED &&
    point.top <= window.innerHeight + BLEED

  /** Every item that currently exists, painted or not — see the pruning in `paint`. */
  const liveIds = (): Set<string> => cached().ids

  /**
   * Every pin this frame, in outbox order, measured and not yet written.
   *
   * ONE pin per outbox item, notes and edits alike, numbered by
   * `outboxNumbers` — the same number the item's row in the Changes tab and
   * its heading in the brief carry. A canvas that numbered notes on their own
   * would put a 2 on the page for the item the panel calls 3, and "fix 3" would
   * name two different things depending on where the designer was looking.
   *
   * Pins that share an anchor fan out to the right, one pin and `FAN_GAP`
   * apart, in outbox order. Several edits on one element — or a note and the
   * edit it prompted — all anchor at the element's top-left, and stacked
   * exactly they read as ONE pin whose number is whichever was painted last:
   * the others are on the page and cannot be seen, pointed at or clicked. The
   * fan is counted before culling, so a pin keeps its slot while its siblings
   * scroll in and out.
   */
  const layout = (): Pin[] => {
    const { items, numbers } = cached()
    const taken = new Map<string, number>()
    const pins: Pin[] = []
    const now = performance.now()
    for (const item of items) {
      const anchor = item.type === "note" ? noteAnchor(item.note, now) : editAnchor(item.edit)
      if (!anchor) continue
      const key = `${Math.round(anchor.left)},${Math.round(anchor.top)}`
      const slot = taken.get(key) ?? 0
      taken.set(key, slot + 1)
      if (!inView(anchor)) continue
      const id = item.type === "note" ? item.note.id : item.edit.id
      const label = String(numbers.get(id) ?? pins.length + 1)
      const left = anchor.left + slot * (MARKER + FAN_GAP)
      if (item.type === "note") {
        const words = item.note.comment
        pins.push({ id, kind: "note", label, name: `Note ${label}: ${words}`, title: words, left, top: anchor.top })
      } else {
        const { property, from, to } = item.edit
        const name = `Edit ${label}: ${property}: ${from} → ${to}`
        pins.push({ id, kind: "edit", label, name, title: name, left, top: anchor.top })
      }
    }
    return pins
  }

  /**
   * One pin per outbox item, plus the outline under the pointer.
   *
   * Every rect is read before anything is written, for the reason
   * `canvas/selection` spells out: a style write between two reads invalidates
   * layout, so an interleaved pass costs one synchronous reflow per pin on
   * every frame of a scroll.
   */
  /** Last frame's pin and outline geometry, so a still page can stop polling every frame. */
  let geometry: number[] = []

  const paint = (): boolean => {
    // Stood-down chrome answers the same way `hideUntilRestart` does: an editor
    // that has handed the page back must not leave its own marks over it. And
    // the audit layer answers alongside it: `notePinsVisible` is the hide
    // setting AND this being the layer in charge, because the two badges would
    // otherwise land on the same corner. See `MarkerLayer` in `./store`.
    const shown = notePinsVisible() && editorOwnsInput()

    const pins = shown ? layout() : []
    // `showing` and not `annotating()`, for the same reason `shown` above is not
    // just the hide setting: a mode whose surfaces have stood down must not have
    // one of them painted back in by the next frame of a scroll.
    const hoverRect = showing && hovered?.isConnected ? hovered.getBoundingClientRect() : null
    const next: number[] = [pins.length]
    for (const pin of pins) next.push(pin.left, pin.top)
    if (hoverRect) next.push(hoverRect.left, hoverRect.top, hoverRect.width, hoverRect.height)
    const moved = next.length !== geometry.length || next.some((value, index) => value !== geometry[index])
    geometry = next

    /**
     * Which items ended up on screen this frame.
     *
     * Both highlights are reconciled against it below rather than trusted to
     * the pointer, because neither half of the correspondence is guaranteed to
     * be told when it ends. A note deleted while its row is hovered takes the
     * row away without a `pointerleave`; a pin scrolled out of view is hidden
     * under the pointer and fires none either. Either way the class or the
     * mirror would be left standing, which is the one failure that makes the
     * pairing untrustworthy — a lit pin for a note nobody is pointing at.
     */
    const onScreen = new Set<string>()

    for (let index = 0; index < pins.length; index += 1) {
      const pin = pins[index]
      const marker = markerAt(index)
      onScreen.add(pin.id)
      /*
       * The pop fires once per ITEM, not once per reveal.
       *
       * The obvious trigger — this pooled node going from hidden to shown — is
       * wrong twice over: the pool reassigns nodes between items as the list
       * changes, and a pin scrolled off the bottom and back re-enters through
       * exactly the same path. Either would pop a pin that has been there all
       * along. Keying off the item id instead means the arrival belongs to the
       * note or edit, which is the thing that actually arrived.
       */
      if (!announced.has(pin.id)) {
        announced.add(pin.id)
        marker.classList.add(MARKER_ARRIVING)
        const arriving = marker
        setTimeout(() => arriving.classList.remove(MARKER_ARRIVING), ARRIVE_MS())
      }
      marker.style.display = "block"
      marker.style.left = `${pin.left}px`
      marker.style.top = `${pin.top}px`
      // Written only on change. These are the properties that would otherwise
      // be re-set on every frame of every scroll, and `title` in particular
      // closes the tooltip the user is reading when it is re-set.
      if (marker.dataset.item !== pin.id) marker.dataset.item = pin.id
      if (marker.dataset.kind !== pin.kind) marker.dataset.kind = pin.kind
      // `data-note` survives for notes only: it is the name the Notes panel and
      // the suites have always read a note's pin by, and an edit is not one.
      if (pin.kind === "note") {
        if (marker.dataset.note !== pin.id) marker.dataset.note = pin.id
      } else if (marker.dataset.note !== undefined) {
        delete marker.dataset.note
      }
      if (marker.textContent !== pin.label) marker.textContent = pin.label
      if (marker.title !== pin.title) marker.title = pin.title
      // Compared on its own rather than riding on `title`: the name carries the
      // number, and a note renumbered by an edit undone before it keeps its
      // words, so a name written only when the words change would go on
      // announcing the old number.
      if (marker.getAttribute("aria-label") !== pin.name) marker.setAttribute("aria-label", pin.name)
      // Re-stated rather than added once, because the nodes are pooled: a pin
      // that last drew an edit would keep the edit's square under whichever
      // note reuses it next.
      marker.classList.toggle("de-ann-marker--edit", pin.kind === "edit")
      // Same reason, and the reason the panel names an item rather than a pin:
      // re-derived from the id every frame, so the emphasis follows the item
      // through a repool instead of staying on the button it first landed on.
      marker.classList.toggle(MARKER_ACTIVE, pin.id === activeNote)
    }
    for (let index = pins.length; index < markers.length; index += 1) {
      markers[index].style.display = "none"
      // `toggle(…, false)`, not `remove`: `remove` rewrites the attribute even
      // when the class is absent, a write every pass over a still page.
      markers[index].classList.toggle(MARKER_ACTIVE, false)
    }

    // Deleted, not merely off screen. A pin scrolled out of view under a row
    // the pointer is still on must light up again when it scrolls back, so the
    // id survives; what it must never survive is the item itself going away.
    // Both kinds count: the Changes tab hovers edit rows as well as notes.
    const live = activeNote || announced.size > 0 ? liveIds() : null
    if (activeNote && live && !live.has(activeNote)) activeNote = null
    /*
     * Forget items that no longer exist, so a deleted-then-undone note — or an
     * edit undone and redone — arrives again rather than reappearing fully
     * formed. Pruned against the live lists rather than against `onScreen`,
     * which is only what is in the viewport.
     */
    if (live) {
      for (const id of announced) if (!live.has(id)) announced.delete(id)
    }
    // The mirror is the opposite case and answers to the pointer: a pin that
    // is no longer painted is a pin the pointer is no longer on, whatever the
    // browser did or did not send us on the way out.
    if (reportedHover && !onScreen.has(reportedHover)) reportMarkerHover(null)

    if (!outline) return moved
    if (!hoverRect) {
      outline.style.display = "none"
      return moved
    }
    outline.style.display = "block"
    outline.style.left = `${hoverRect.left}px`
    outline.style.top = `${hoverRect.top}px`
    outline.style.width = `${hoverRect.width}px`
    outline.style.height = `${hoverRect.height}px`
    return moved
  }

  let frame = 0
  let destroyed = false
  /** The slow poll a still page drops to, and how many still frames earned it. */
  let idleTimer = 0
  let stillFrames = 0
  const STILL_FRAMES = 30
  const IDLE_POLL_MS = 250

  const schedule = (): void => {
    if (destroyed || frame !== 0) return
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = 0
    }
    frame = requestAnimationFrame(draw)
  }
  /** Every event that may move something wakes the loop at once and resets the count. */
  const wake = (): void => {
    stillFrames = 0
    schedule()
  }
  const paintNow = (): void => {
    if (destroyed || !layer.isConnected) return
    paint()
    wake()
  }

  /**
   * Whether anything on screen can move without telling us.
   *
   * A note pinned to a live element follows a sticky header or an accordion,
   * and neither fires an event worth waking on. A note pinned to page
   * coordinates moves only when the page scrolls, and that wakes the loop by
   * itself — so a reloaded page of notes, whose records lost their elements,
   * costs no frames at all until the user touches it.
   */
  const tracking = (): boolean => {
    if (!editorOwnsInput()) return false
    if (annotating() && hovered) return true
    // The same pair `paint` asks, and it has to be the same pair: a loop that
    // kept running for a layer the audit has taken over would read a rect per
    // note per frame to draw nothing at all.
    if (!notePinsVisible()) return false
    if (annotations().some((note) => Boolean(note.element?.isConnected))) return true
    // An edit's pin only ever sits on a live element, so every painted edit pin
    // is one that can move without telling us.
    for (const element of cached().elements.values()) if (element?.isConnected) return true
    return false
  }

  /*
   * Per frame while anything moves, four times a second once it has held still
   * for half a second. A page at rest used to cost a rect per pin per frame
   * forever. An animation that starts with no input at all (a timer, an
   * autoplaying Motion) is followed within one poll and per frame from then
   * on; scroll, resize, pointer and key events and every store change wake the
   * loop at once.
   */
  function draw(): void {
    frame = 0
    if (!layer.isConnected) {
      destroyed = true
      teardown()
      return
    }
    stillFrames = paint() ? 0 : stillFrames + 1
    if (!tracking()) return
    if (stillFrames < STILL_FRAMES) schedule()
    else poll()
  }

  /*
   * The poll paints from its own timer rather than requesting a frame for it:
   * a pass over a still page writes nothing, and a frame requested only to
   * find that out cost a frame callback and a compositor commit each time.
   */
  function poll(): void {
    idleTimer = setTimeout(() => {
      idleTimer = 0
      if (destroyed) return
      if (paint()) wake()
      else if (tracking()) poll()
    }, IDLE_POLL_MS) as unknown as number
  }

  // ---------- mode surfaces ----------

  const enter = (): void => {
    showing = true
    if (!outline) {
      outline = el("div", { class: "de-ann-target", style: "display:none" })
      layer.append(outline)
    }
    if (!region) {
      region = el("div", { class: "de-ann-region", style: "display:none" })
      layer.append(region)
    }
  }

  /**
   * Leaving the mode takes every transient surface with it and leaves the pins.
   *
   * The distinction is the feature: the notes are the output and stay readable
   * with the mode off, while the hover outline, the drag region and a half-typed
   * composer are all statements that the next click will annotate something —
   * and once it will not, each of them is a lie on the screen.
   *
   * The hovered element is cleared with them, and it has to be: it is the state
   * the outline is drawn FROM, so a stand-down that dropped the node and kept
   * the element would repaint the frame the moment the editor came back, around
   * whatever the pointer had been over a minute ago rather than where it is now.
   */
  const leave = (): void => {
    showing = false
    dismiss()
    outline?.remove()
    outline = null
    region?.remove()
    region = null
    hovered = null
    pending = false
    dragging = false
    started = null
  }

  /**
   * Put the mode's surfaces where the CURRENT state says they belong.
   *
   * The two inputs are the mode and whether the editor is standing over the page
   * at all, and they are separate facts: `editorOwnsInput()` goes false when the
   * chrome is collapsed or handed to the app, while `annotating` stays exactly
   * as the designer left it. Reconciling both here — rather than off the
   * `annotating` flip alone, which is all this used to watch — is what makes
   * collapsing the editor take the hover outline with it, and
   * what puts them back, still in the mode, when it is opened again.
   */
  const syncSurfaces = (): void => {
    const wanted = annotating() && editorOwnsInput()
    if (wanted === showing) return
    if (wanted) enter()
    else leave()
  }

  // ---------- gestures ----------

  const onPointerDown = (event: PointerEvent): void => {
    if (!annotating() || !editorOwnsInput()) return
    if (event.button !== 0) return
    if (!targetable(event.target)) return

    originX = event.clientX
    originY = event.clientY
    pending = true
    dragging = false
    // Read at the START of the gesture, not the end. With blocking off the
    // press itself collapses the selection, and by pointerup the words the
    // note is about are gone.
    started = textGesture()
    swallow(event)
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (!annotating() || !editorOwnsInput()) return

    if (pending) {
      const dx = event.clientX - originX
      const dy = event.clientY - originY
      if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      // Past the threshold this is a region, not a click — the same test the
      // marquee makes, because the two gestures start identically and only the
      // distance travelled tells them apart.
      dragging = true
      if (hovered) {
        // An element outline under a drag rect reads as a second selection.
        hovered = null
        wake()
      }
      event.preventDefault()
      if (region) {
        region.style.display = "block"
        region.style.left = `${Math.min(originX, event.clientX)}px`
        region.style.top = `${Math.min(originY, event.clientY)}px`
        region.style.width = `${Math.abs(dx)}px`
        region.style.height = `${Math.abs(dy)}px`
      }
      return
    }

    const next = targetable(event.target) ? elementAt(event.clientX, event.clientY) : null
    if (next === hovered) return
    hovered = next
    wake()
  }

  const onPointerUp = (event: PointerEvent): void => {
    if (!pending) return
    pending = false
    if (region) region.style.display = "none"
    swallow(event)

    const snapshot = started
    started = null

    if (dragging) {
      dragging = false
      const left = Math.min(originX, event.clientX)
      const top = Math.min(originY, event.clientY)
      const width = Math.abs(event.clientX - originX)
      const height = Math.abs(event.clientY - originY)
      // The element under the middle of the box, when there is one. A region
      // over empty space has no target at all, and that is the case the kind
      // exists for rather than a gap in it.
      capture({
        kind: "region",
        box: { left, top, width, height },
        element: elementAt(left + width / 2, top + height / 2),
        selectedText: null,
      })
      return
    }

    if (snapshot) {
      capture(snapshot)
      return
    }

    const element = elementAt(event.clientX, event.clientY)
    // A click on nothing is not a note. Empty space is annotated by dragging a
    // box round it, which is the only gesture that can say how much of it.
    if (!element) return
    capture({
      kind: "element",
      box: boxOf(element.getBoundingClientRect()),
      element,
      selectedText: null,
    })
  }

  /**
   * A live text selection, as a gesture, or `null` when there is none.
   *
   * The range's own box is the subject rather than the element's: a note on one
   * sentence of a paragraph should pin to that sentence, and an element rect
   * would put the marker at the top of a block the user never pointed at.
   */
  const textGesture = (): Gesture | null => {
    if (!selectionMayExist) return null
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      selectionMayExist = false
      return null
    }
    const selectedText = selection.toString().trim()
    if (!selectedText) return null

    const range = selection.getRangeAt(0)
    const node = range.commonAncestorContainer
    const element = node instanceof Element ? node : node.parentElement
    // A selection inside our own panels is someone copying a class name out of
    // the inspector, not a note about the page.
    if (!element || !targetable(element)) return null

    const rect = range.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) return null
    return {
      kind: "text",
      box: boxOf(rect),
      element: targetable(element) ? element : null,
      selectedText,
    }
  }

  /*
   * Whether the page's selection may have changed since a press last found it
   * collapsed. Every getter on a Selection flushes style and layout, and a
   * press always arrives with style dirty from its own `:active`, so asking on
   * every press paid a forced recalc that the release then paid again. A
   * selection only changes with a `selectionchange` to say so, and that event
   * is queued ahead of any later press.
   */
  let selectionMayExist = true
  const onSelectionChange = (): void => {
    selectionMayExist = true
  }
  document.addEventListener("selectionchange", onSelectionChange)

  const onPointerCancel = (): void => {
    pending = false
    dragging = false
    started = null
    if (region) region.style.display = "none"
  }

  // ---------- wiring ----------

  window.addEventListener("pointerdown", onPointerDown, true)
  window.addEventListener("pointermove", onPointerMove, true)
  window.addEventListener("pointerup", onPointerUp, true)
  window.addEventListener("pointercancel", onPointerCancel, true)

  // Blocking `click` alone is not enough, which is what the selection lane gets
  // away with: a dropdown written against the native pattern closes on
  // `mousedown`, so by the time a click could be swallowed the item the user
  // was annotating has gone.
  for (const type of ["mousedown", "mouseup", "click", "dblclick"]) {
    window.addEventListener(type, swallow, true)
  }

  /**
   * The panel's half of the correspondence.
   *
   * Bound once here, beside every other listener this module owns, rather than
   * per marker: the pins are pooled and rebuilt, and a listener added where
   * they are would be added again on every note that outgrows the pool.
   *
   * Nothing is looked up or written on the DOM in either handler — one records
   * an id and asks for a frame, the other opens the composer. The highlight is
   * `paint`'s job, which is the only place that knows which pin is currently
   * showing which note.
   */
  const onPanelHover = (event: Event): void => {
    const detail = (event as CustomEvent<{ id?: string | null }>).detail
    const next = typeof detail?.id === "string" ? detail.id : null
    if (next === activeNote) return
    activeNote = next
    wake()
  }

  const onPanelEdit = (event: Event): void => {
    const id = (event as CustomEvent<{ id?: string | null }>).detail?.id
    if (typeof id !== "string") return
    // Every note, not just the open ones: a resolved note is still a note you
    // can be asked to rewrite, and it has no pin of its own to reopen from.
    const note = annotations().find((entry) => entry.id === id)
    if (note) reopen(note)
  }

  window.addEventListener(HOVER_EVENT, onPanelHover)
  window.addEventListener(EDIT_EVENT, onPanelEdit)

  // Capture, because `scroll` does not bubble: a note pinned inside a scrolling
  // panel would otherwise only be repositioned when the window itself moved.
  window.addEventListener("scroll", wake, { capture: true, passive: true })
  window.addEventListener("resize", wake)
  window.addEventListener("pointerdown", wake, { capture: true, passive: true })
  window.addEventListener("keydown", wake, { capture: true, passive: true })
  // A route change can bring an unattached note's element back.
  const onRoute = (): void => {
    attempted.clear()
    wake()
  }
  window.addEventListener("popstate", onRoute)
  window.addEventListener("hashchange", onRoute)

  const onNotes = (): void => {
    outbox = null
    attempted.clear()
    wake()
  }
  const stopNotes = onAnnotationsChange(onNotes)
  // Edits are pins too, and the journal is a separate store with its own
  // listeners: a change made, or taken back by Cmd+Z, renumbers every pin after it.
  const stopEdits = onEditsChange(() => {
    outbox = null
    wake()
  })
  const stopSettings = onSettingsChange(wake)
  const stopLayer = onMarkerLayerChange(wake)
  const unsubscribe = context.subscribe((next, previous) => {
    // Every input of the stand-down gate, `canvasView` included: the board
    // opening has to take the pins and the hover outline off the page under it,
    // and closing it has to put them back.
    if (!editorStandDownChanged(next, previous)) return
    if (next.annotating && !previous.annotating) {
      /*
       * Entering the mode claims the marker layer back for the notes.
       *
       * Not tidiness — it is the only thing that makes the mode honest while
       * an audit is on screen. The gesture that follows pins a note, the note
       * is drawn as a pin, and the pin is on the layer the audit badges are
       * currently occupying: without this the user clicks, types, saves, and
       * nothing appears on the page. They have written a note they cannot
       * see, and every reasonable reading of that is "the editor lost it".
       *
       * Done here rather than in `addAnnotation` because the decision belongs
       * to the MODE, not to the record: the hover outline already promises
       * that the next click will leave a mark, and the promise is made on
       * entry, not on save.
       *
       * Keyed to the MODE being switched on and not to `syncSurfaces` below,
       * which also runs when the editor is merely opened again: coming back
       * from a collapse is not a moment to take the layer off an audit that
       * claimed it in the meantime.
       */
      setMarkerLayer("notes")
    }
    syncSurfaces()
    // Painted in this task rather than the next frame, as `canvas/selection`
    // does for the same switch: pins left over an app the editor has just
    // handed back were the last thing Cmd+. changed, a frame after all the rest.
    queueMicrotask(paintNow)
  })

  function teardown(): void {
    unsubscribe()
    stopNotes()
    stopEdits()
    stopSettings()
    stopLayer()
    window.removeEventListener(HOVER_EVENT, onPanelHover)
    window.removeEventListener(EDIT_EVENT, onPanelEdit)
    window.removeEventListener("scroll", wake, true)
    window.removeEventListener("resize", wake)
    window.removeEventListener("pointerdown", wake, true)
    window.removeEventListener("keydown", wake, true)
    document.removeEventListener("selectionchange", onSelectionChange)
    window.removeEventListener("popstate", onRoute)
    window.removeEventListener("hashchange", onRoute)
    if (idleTimer) clearTimeout(idleTimer)
    // A layer torn down mid-hover would otherwise leave the panel lighting a
    // row whose pin no longer exists to un-light it.
    reportMarkerHover(null)
  }

  schedule()
  window.addEventListener("beforeunload", () => {
    destroyed = true
    teardown()
    if (frame) cancelAnimationFrame(frame)
  })
}
