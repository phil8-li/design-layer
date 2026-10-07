/**
 * The chrome's tooltip: React Bits' `WarmTooltip`, ported to plain DOM.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS
 *
 * Started as a port of React Bits' `WarmTooltip`
 * (https://reactbits.dev/micro/warm-tooltip) and now follows the design
 * foundations kit (MICRO-INTERACTIONS § 7). One card shared by every control on
 * the page, with a small state machine:
 *
 *   OPEN    the pointer arrives on a control and the card is there, in its
 *           final state, with NO delay. A delayed tooltip makes people wait on
 *           every hover; the kit overrides any caller's delay app-wide.
 *   WARM    a card is up, or closed within the last 320ms. A tip opening now
 *           NEAR the last one (within twice its height) travels from where the
 *           old one was displayed, 150ms on `easeReveal`, translate only —
 *           the size jumps, because animating it would rewrap the label. A
 *           strip of tools reads as one label following the pointer.
 *   GRACE   the pointer leaves. Nothing happens for 80ms, because the 4px gap
 *           between two toolbar buttons is not the reader leaving the toolbar.
 *   CLOSE   a 150ms fade to scale 0.99, so the label does not vanish in the
 *           frame the pointer left. Reduced motion paints every step in place.
 *
 * ---------------------------------------------------------------------------
 * THE BUDGET
 *
 * Zero animation frames. Every motion is a CSS transition between two declared
 * states — the exit on `.de-tip-box`, the travel on `.de-tip`'s transform — so
 * the compositor interpolates, an interruption resumes from the displayed
 * value for free, and no script runs per frame. (The React Bits port this
 * replaced ran a `requestAnimationFrame` spring on position and size, and a
 * scripted blurred label swap; both broke kit rules and both are gone.)
 *
 * The three listeners that cost something when NOTHING is happening — scroll,
 * resize and `visibilitychange` — are attached when a card opens and removed
 * when it closes.
 *
 * ---------------------------------------------------------------------------
 * PLACEMENT: VIEWPORT, NOT THE APP INSET
 *
 * `placeTip` below is the standard three-step — PREFER a side, FLIP to the
 * other when the preferred one overflows, SHIFT along the cross axis to stay
 * inside — as a pure function, so it can be checked against synthetic rects
 * without a browser. It is kept from the implementation this replaces and is
 * strictly more than upstream does: `WarmTooltip` clamps the cross axis and
 * never flips, which is fine for a demo page and not for a card hung off a
 * toolbar pinned 12px from the bottom of the window.
 *
 * `annotations/canvas.ts` clamps its composer against `--de-left`/`--de-right`
 * rather than the window, because a composer that slides under the inspector
 * has a Save button nobody can press. This does the opposite and the difference
 * is stacking: the composer is painted below the panels, the tooltip is painted
 * above everything (`css/tooltip.ts` pins it over the shortcuts sheet). A tip
 * overlapping a panel is a tip sitting on top of a panel, which is what a
 * tooltip is for. The viewport is the only edge it has.
 *
 * ---------------------------------------------------------------------------
 * ACCESSIBILITY: THE CARD IS DECORATION, AND IS MARKED AS SUCH
 *
 * `aria-hidden="true"` on the card; the control keeps its own `aria-label`.
 * Upstream does the opposite — `role="tooltip"` plus an `aria-describedby`
 * pointed at it — and that is the one part of the component this port
 * deliberately did not take, for three reasons that are all about what the call
 * sites already say. Every tipped control in this chrome is named with the same
 * words as its tip: `shell/toolbar.ts` emits `data-de-tip` and `aria-label`
 * from one helper, and `test/annotation-cases.mjs` asserts the two attributes
 * are EQUAL on the row actions. A description would therefore read the label
 * back a second time ("Undo, button, Undo"). Second, one shared card means one
 * id pointed at by whichever control is hovered, re-pointed on every pointer
 * move — a moving target in the accessibility tree for a surface that exists
 * only for a pointer, and upstream only gets away with it because its card
 * unmounts between runs. Third, the three implementations this lineage replaced
 * were pseudo-elements, which are not in the accessibility tree at all, so
 * hiding the card keeps the announced experience byte-for-byte what it is.
 *
 * The one thing that is genuinely not announced either way is the toolbar's
 * shortcut suffix — the tip says "Undo · ⌘Z" and the label says "Undo". That is
 * unchanged, and the fix for it is a real `aria-keyshortcuts` on the control,
 * not a description on a hover card.
 */

import { TIP_CLOSE_MS, TIP_TRAVEL_MS, TIP_WRAP_WIDTH } from "./css/tooltip"
import { el } from "./dom"
import { tokens as t } from "./tokens"

// ─────────────────────────────────────────────────────── the contract ──────

/** The label. Read from the control, or written by `tip()` / `tipAttrs()`. */
export const TIP_ATTR = "data-de-tip"
/**
 * Which side to try FIRST — `"above"` or `"below"`. Optional, and read from the
 * nearest ancestor that carries it, so a container can set it for its children
 * (the toolbar strip, a row of actions) instead of every button repeating it.
 */
export const TIP_PLACEMENT_ATTR = "data-de-tip-placement"
/**
 * Kept for the call sites that set it. Every tip opens without a wait now (the
 * kit's zero delay), so the attribute no longer changes anything.
 */
export const TIP_INSTANT_ATTR = "data-de-tip-instant"
/** Present = the label is a sentence and may take more than one line. */
export const TIP_WRAP_ATTR = "data-de-tip-wrap"
/** Written on the card itself while it is visible. */
const OPEN_ATTR = "data-de-tip-open"

export type TipSide = "above" | "below"

export interface TipOptions {
  /** Try this side first. Default `"below"`; see `DEFAULT_SIDE`. */
  side?: TipSide
  /** No-op since tips open instantly; kept so existing call sites compile. */
  instant?: boolean
  /** The label is prose. Let it wrap rather than run as one line. */
  wrap?: boolean
  /** Appended after a `·`, for what the name cannot say: a shortcut, a result. */
  second?: string
}

/** Enough of a `DOMRect` to place against, so a test can hand over a literal. */
export interface TipRect {
  left: number
  top: number
  width: number
  height: number
}

export interface TipSize {
  width: number
  height: number
}

export interface TipPlacement {
  /** Viewport pixels, ready for the card's `translate()`. */
  left: number
  top: number
  /** Which side it ended up on. */
  side: TipSide
  /** True when `side` is not the side that was asked for. */
  flipped: boolean
  /** True when the cross axis had to move off the control's centre. */
  shifted: boolean
  /**
   * True when the card does not fit the viewport at all and was parked at the
   * margin — the last resort, and the only outcome where it may cover its own
   * control.
   */
  clamped: boolean
}

// ──────────────────────────────────────────────────────── the numbers ──────

/**
 * BELOW by default, and the bottom toolbar does not need to say otherwise.
 *
 * Figma hangs its tooltips under the control inside a panel and over it on the
 * bottom bar, which sounds like two rules and is one: below, unless below is
 * off the screen. The bar is pinned `panelInset` (12px) from the bottom of the
 * viewport and stands 36 tall, so a card needing ~33px plus an 8px gap cannot
 * fit under it and `placeTip` flips it above on its own. The attribute exists
 * for a surface that wants to declare the intent rather than inherit it from
 * the geometry — it costs nothing and it survives the bar being moved.
 */
const DEFAULT_SIDE: TipSide = "below"

/** Between the control and the card: the kit's 6px tooltip offset. */
const GAP = t.space.xs

/**
 * How close to the edge of the window the card may come.
 *
 * The same 8 that `token-picker.ts`, `app-chooser.ts`, `layer-menu.ts` and
 * `annotations/canvas.ts` each call `EDGE`, and the same 8 upstream calls
 * `MARGIN`. A card flush to the edge reads as clipped even when it is whole.
 */
const MARGIN = t.space.sm

/**
 * How long the primitive stays WARM after a card closes: the kit's warm window,
 * its `--duration-resize`. Inside it, a nearby tip travels from the old one's
 * place instead of appearing cold.
 */
const WARM = Number.parseFloat(t.duration.resize)

/**
 * How long a card waits after the pointer leaves.
 *
 * The gap between two toolbar buttons is 4px of padding the pointer crosses in
 * one frame. Closing on the way across and reopening on the other side is two
 * state changes for something the reader experienced as one movement.
 */
const GRACE = 80

/** "Nearby", for warm travel: within this many card heights, edge to edge. */
const NEAR = 2

// ───────────────────────────────────────────────────────── the geometry ────

/**
 * Where the card goes: prefer, flip, shift, clamp — in that order.
 *
 * Pure, and exported, because this is the part that is worth being sure about
 * and the part a browser makes hard to see. Everything it needs is an argument;
 * nothing it does touches the DOM.
 *
 * The order is not interchangeable. FLIP first, because the main axis is where
 * a tooltip can actually be rescued — there is usually a whole screen on the
 * other side of the control. SHIFT second, because sliding along the cross axis
 * keeps the card touching its control even when it is no longer centred on it.
 * CLAMP last and only when the card is bigger than the space that exists, which
 * is the one case with no good answer: park it at the margin and let it overlap
 * rather than let it leave the screen.
 */
export function placeTip(input: {
  anchor: TipRect
  tip: TipSize
  viewport: TipSize
  /** Default `DEFAULT_SIDE`. */
  prefer?: TipSide
  /** Default `GAP`. */
  gap?: number
  /** Default `MARGIN`. */
  margin?: number
}): TipPlacement {
  const { anchor, tip, viewport } = input
  const prefer = input.prefer ?? DEFAULT_SIDE
  const gap = input.gap ?? GAP
  const margin = input.margin ?? MARGIN

  const topFor = (side: TipSide): number =>
    side === "above" ? anchor.top - gap - tip.height : anchor.top + anchor.height + gap
  const fits = (side: TipSide): boolean => {
    const top = topFor(side)
    return top >= margin && top + tip.height <= viewport.height - margin
  }

  const other: TipSide = prefer === "above" ? "below" : "above"
  let side = prefer
  if (!fits(prefer)) {
    if (fits(other)) {
      side = other
    } else {
      /*
       * Neither side fits — a short window, or a control taller than the room
       * around it. Take whichever has more space and let the clamp below deal
       * with the remainder, rather than honouring a preference that puts the
       * card further off-screen than the alternative would.
       */
      const above = anchor.top - margin
      const below = viewport.height - margin - (anchor.top + anchor.height)
      side = below > above ? "below" : "above"
    }
  }

  // ---- cross axis: centred on the control, then slid back inside ----
  const centred = anchor.left + anchor.width / 2 - tip.width / 2
  const minLeft = margin
  const maxLeft = viewport.width - tip.width - margin
  let left = centred
  let shifted = false
  let clamped = false
  if (maxLeft < minLeft) {
    // Wider than the whole band. Nothing to shift to; start at the margin and
    // let the overflow fall off the far side, where less of the label is lost.
    left = minLeft
    clamped = true
  } else if (centred < minLeft) {
    left = minLeft
    shifted = true
  } else if (centred > maxLeft) {
    left = maxLeft
    shifted = true
  }

  // ---- main axis: the chosen side, then the last resort ----
  let top = topFor(side)
  const minTop = margin
  const maxTop = viewport.height - tip.height - margin
  if (maxTop < minTop) {
    top = minTop
    clamped = true
  } else if (top < minTop) {
    top = minTop
    clamped = true
  } else if (top > maxTop) {
    top = maxTop
    clamped = true
  }

  /*
   * Rounded, because a card at a half pixel is a card with a soft edge and
   * blurred text — the one rendering artefact a 12px label cannot carry.
   */
  return { left: Math.round(left), top: Math.round(top), side, flipped: side !== prefer, shifted, clamped }
}

// ───────────────────────────────────────────────────── the environment ─────

const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now()

/**
 * Reduced motion, asked of the platform rather than guessed.
 *
 * The stylesheet already clamps the transitions; this is the other half, for
 * the two things a stylesheet cannot reach — the spring, which is arithmetic in
 * this file, and the swap, which is a scripted animation. The query object is
 * cached because `matchMedia` allocates, and it is re-read every time because
 * the setting can change while the editor is open.
 *
 * Guarded for jsdom, which implements neither this nor the Web Animations API
 * and drives every suite in `test/`.
 */
let reduceQuery: MediaQueryList | null | undefined
function prefersReducedMotion(): boolean {
  if (reduceQuery === undefined) {
    reduceQuery =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null
  }
  return reduceQuery?.matches === true
}

/** True when frames exist. jsdom only has them under `pretendToBeVisual`. */
const framed = (): boolean => typeof requestAnimationFrame === "function"

// ───────────────────────────────────────────────────────── the runtime ─────

interface Card {
  /** The placed, sized box. Carries the open attribute and the side variables. */
  root: HTMLElement
  /** The surface, and the exit fade. */
  box: HTMLElement
  /** Two label slots from the port this replaced; only `live` is shown. */
  layers: [HTMLElement, HTMLElement]
  /** Which of the two is showing. */
  live: 0 | 1
  /** An unseen copy of the face, for measuring. See `css/tooltip.ts`. */
  ruler: HTMLElement
}

type Phase = "closed" | "open" | "closing"

let card: Card | null = null
let phase: Phase = "closed"
/** The control the card is showing for. */
let anchored: HTMLElement | null = null
/** The control the pointer is on. */
let hovered: HTMLElement | null = null
/** The side `anchored` asked for, kept so scrolling can re-place without it. */
let preferred: TipSide = DEFAULT_SIDE
/** The last measured card size, kept so scrolling can re-place without it. */
let measured: TipSize = { width: 0, height: 0 }
/** Where the card was last put, so a warm successor can travel from it. */
let shown: TipRect | null = null

let leaveTimer: ReturnType<typeof setTimeout> | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null
/** When the warm window shuts. See `WARM`. */
let warmUntil = 0

let release: (() => void) | null = null

/**
 * A `title` taken off its control for as long as its tip is up.
 *
 * While the markup keeps a `title`, the browser paints ITS tooltip over ours
 * about a second later, in operating-system chrome, saying the same thing
 * twice. The attribute cannot be styled or suppressed, only removed — so it is
 * removed while our card is up and put back when it goes.
 *
 * The observer is what makes that survive a card that FOLLOWS a scroll.
 * `annotations/canvas.ts` and `lint/markers.ts` both reposition pooled markers
 * every scroll frame and write `title` back if it does not match, which it
 * never does while this has taken it; so the borrow watches its own attribute,
 * takes it away again and keeps the latest text to hand back.
 */
let borrowed: { node: HTMLElement; value: string; watch: MutationObserver | null } | null = null

// ---- placing the card ----------------------------------------------------

/**
 * Put the card at `rect`, travelling there or not.
 *
 * `travel` sets the transform's transition to the kit's 150ms for this one
 * write and to zero otherwise; the variable and the transform change in the
 * same style update, so the browser starts the transition with the new
 * duration. Only `translate` travels: width and height are written plainly.
 */
function place(rect: TipRect, travel: boolean): void {
  if (!card) return
  const style = card.root.style
  style.setProperty("--de-tip-travel", `${travel ? TIP_TRAVEL_MS : 0}ms`)
  style.transform = `translate(${rect.left}px, ${rect.top}px)`
  style.width = `${rect.width}px`
  style.height = `${rect.height}px`
  shown = rect
}

/**
 * Whether a tip landing at `next` is a neighbour of the last one — the kit's
 * warm-hover test: the gap between the two rectangles, edge to edge, within
 * twice the smaller height. An unrelated control elsewhere opens in place.
 */
function nearby(next: TipRect): boolean {
  if (!shown) return false
  if (shown.left === next.left && shown.top === next.top) return false
  const gapX = Math.max(0, shown.left - (next.left + next.width), next.left - (shown.left + shown.width))
  const gapY = Math.max(0, shown.top - (next.top + next.height), next.top - (shown.top + shown.height))
  return Math.hypot(gapX, gapY) <= Math.min(shown.height, next.height) * NEAR
}

// ---- the card ------------------------------------------------------------

function layer(): HTMLElement {
  return el("div", { class: "de-tip-layer" }, [el("div", { class: "de-tip-face" })])
}

/** The card, made once. Idempotent, and re-parents itself if it is torn out. */
function ensureCard(): Card {
  if (card && card.root.isConnected && card.ruler.isConnected) return card
  if (!card) {
    const layers: [HTMLElement, HTMLElement] = [layer(), layer()]
    layers[1].style.opacity = "0"
    const box = el("div", { class: "de-tip-box" }, layers)
    card = {
      root: el("div", {
        class: "de-tip",
        // Decoration. The control keeps its own name — see the header.
        "aria-hidden": "true",
      }, [box]),
      box,
      layers,
      live: 0,
      ruler: el("div", { class: "de-tip-ruler de-tip-face" }),
    }
  }
  document.body.append(card.root, card.ruler)
  return card
}

const face = (node: HTMLElement): HTMLElement => node.firstElementChild as HTMLElement

function setWrap(node: HTMLElement, wrap: boolean): void {
  if (wrap) node.setAttribute(TIP_WRAP_ATTR, "")
  else node.removeAttribute(TIP_WRAP_ATTR)
}

/**
 * How big the card has to be for this label — from a second, unseen face.
 *
 * The card carries an explicit width and height at all times, so it cannot be
 * measured by looking at it. The ruler shares `.de-tip-face`, so its box IS the
 * answer. Ceiled rather than rounded: a card a third of a pixel narrower than
 * its text drops the last glyph to a second line.
 */
function measure(text: string, wrap: boolean): TipSize {
  const ruler = ensureCard().ruler
  ruler.textContent = text
  setWrap(ruler, wrap)
  const box = ruler.getBoundingClientRect()
  return { width: Math.ceil(box.width), height: Math.ceil(box.height) }
}

/** How long the next open/close fade takes: 0 to open, the exit to close. */
function pop(ms: number): void {
  card?.root.style.setProperty("--de-tip-pop", `${prefersReducedMotion() ? 0 : ms}ms`)
}

/** The side, as the origin the exit shrinks toward: the control's edge. */
function applySide(side: TipSide): void {
  card?.root.style.setProperty("--de-tip-origin", side === "above" ? "center bottom" : "center top")
}

/** Write the label into the live slot. Nothing slides, blurs or crossfades. */
function relabel(text: string, wrap: boolean): void {
  const c = ensureCard()
  const target = face(c.layers[c.live])
  target.textContent = text
  setWrap(target, wrap)
  c.layers[c.live].style.opacity = "1"
  c.layers[c.live ^ 1].style.opacity = "0"
}

// ---- reading the call site -----------------------------------------------

/** The nearest ancestor carrying `attribute`, including the control itself. */
const inherited = (node: HTMLElement, attribute: string): string | null =>
  node.closest(`[${attribute}]`)?.getAttribute(attribute) ?? null

const restoreTitle = (): void => {
  if (!borrowed) return
  /* Before the write, or handing the attribute back would look like the call
     site putting it back and the observer would take it away again. */
  borrowed.watch?.disconnect()
  if (borrowed.node.isConnected) borrowed.node.setAttribute("title", borrowed.value)
  borrowed = null
}

/** Take the `title` off `node` and keep it off. See `borrowed`. */
function borrowTitle(node: HTMLElement, value: string): void {
  restoreTitle()
  node.removeAttribute("title")
  let watch: MutationObserver | null = null
  if (typeof MutationObserver === "function") {
    watch = new MutationObserver(() => {
      const held = borrowed
      if (!held || held.node !== node) return
      // The control went away under the pointer — Apply hiding itself once
      // nothing is left to write. No pointer event says so until the pointer
      // next moves, so the card stood over nothing until the grace timer ran
      // out. It closes now, and hands the title back in the same breath.
      if (node.hidden) {
        hideTip()
        return
      }
      const written = node.getAttribute("title")
      if (written === null) return
      held.value = written
      node.removeAttribute("title")
    })
    watch.observe(node, { attributes: true, attributeFilter: ["title", "hidden"] })
  }
  borrowed = { node, value, watch }
}

/**
 * The label, and where it came from.
 *
 * `data-de-tip` wins over `title` where both are present, which is the same
 * precedence `css/annotations.ts` already established so that a call site can
 * add the attribute before taking the other one away without doubling up.
 */
function labelOf(node: HTMLElement): { text: string; fromTitle: boolean } | null {
  const tip = node.getAttribute(TIP_ATTR)
  if (tip) return { text: tip, fromTitle: false }
  const title = node.getAttribute("title")
  if (title) return { text: title, fromTitle: true }
  return null
}

/** The tipped control at or above `target`, if any. */
function anchorFor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const node = target.closest<HTMLElement>(`[${TIP_ATTR}], [title]`)
  if (!node || !labelOf(node)) return null
  return node
}

// ---- the state machine ---------------------------------------------------

const clearLeaveTimer = (): void => {
  if (leaveTimer === null) return
  clearTimeout(leaveTimer)
  leaveTimer = null
}
const clearCloseTimer = (): void => {
  if (closeTimer === null) return
  clearTimeout(closeTimer)
  closeTimer = null
}

/**
 * Show the card for `node`, now.
 *
 *   closed, cold      appear in place, in the final state.
 *   warm or open      appear (or stay) and TRAVEL from the last card's place
 *                     if the two are neighbours; otherwise appear in place.
 *   closing           caught on the way out: back to open at once, no fade in.
 */
function show(node: HTMLElement): void {
  // A hidden control still gets the `pointerover` the press that hid it left
  // behind, and a card opened for it stood over nothing until the pointer moved.
  if (!node.isConnected || node.closest("[hidden]")) return
  const label = labelOf(node)
  if (!label) return

  if (label.fromTitle) borrowTitle(node, label.text)
  else restoreTitle()

  const c = ensureCard()
  const warm = phase !== "closed" || now() < warmUntil
  clearCloseTimer()

  /*
   * Wrap, then measure, then wrap again if the answer was too wide — against
   * the SMALLER of `TIP_WRAP_WIDTH` (where the sheet says a label has become
   * prose) and the viewport band (where the screen runs out of room).
   */
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  let wrap = node.closest(`[${TIP_WRAP_ATTR}]`) !== null
  let size = measure(label.text, wrap)
  const widest = Math.min(TIP_WRAP_WIDTH, viewport.width - MARGIN * 2)
  if (!wrap && size.width > widest) {
    wrap = true
    size = measure(label.text, wrap)
  }

  const declared = inherited(node, TIP_PLACEMENT_ATTR)
  preferred = declared === "above" || declared === "below" ? declared : DEFAULT_SIDE
  const placement = placeTip({
    anchor: node.getBoundingClientRect(),
    tip: size,
    viewport,
    prefer: preferred,
  })

  anchored = node
  measured = size
  applySide(placement.side)
  relabel(label.text, wrap)

  const next = { left: placement.left, top: placement.top, width: size.width, height: size.height }
  place(next, warm && !prefersReducedMotion() && nearby(next))

  pop(0)
  c.root.setAttribute(OPEN_ATTR, "")
  phase = "open"
  /* Idempotent, and unconditional so the listeners cannot be left off. */
  attachFollow()
}

function finishClose(): void {
  clearCloseTimer()
  detachFollow()
  restoreTitle()
  phase = "closed"
  anchored = null
  card?.root.removeAttribute(OPEN_ATTR)
}

/**
 * Start taking the card down, and open the warm window as it goes.
 *
 * The window opens HERE rather than when the card has finished fading, because
 * that is what makes a sweep feel continuous: the 320ms is measured from the
 * reader's decision to leave, not from the end of an animation.
 */
function beginClose(instant: boolean): void {
  if (phase !== "open") return
  phase = "closing"
  warmUntil = now() + WARM
  if (instant || prefersReducedMotion() || !card) {
    pop(0)
    finishClose()
    return
  }
  pop(TIP_CLOSE_MS)
  card.root.removeAttribute(OPEN_ATTR)
  closeTimer = setTimeout(finishClose, TIP_CLOSE_MS)
}

/**
 * Arrive on a control: the card is there at once.
 *
 * Deduplicated on `hovered` because this is delegated from the document and
 * `pointerover` bubbles — crossing from a button's icon to the button itself is
 * a second event about the same control.
 */
function schedule(node: HTMLElement): void {
  if (node === hovered) return
  hovered = node
  clearLeaveTimer()
  show(node)
}

/** Leave a control: nothing for `GRACE`, then close. */
function leave(): void {
  hovered = null
  if (phase === "closed") return
  clearLeaveTimer()
  leaveTimer = setTimeout(() => {
    leaveTimer = null
    beginClose(false)
  }, GRACE)
}

/**
 * Take the card down now, with no grace and no fade.
 *
 * For the answers rather than the departures: Escape, a press, the window going
 * away. Exported because it is the one piece of this a surface outside the file
 * may legitimately need — a menu opening under the pointer, say.
 */
export function hideTip(): void {
  hovered = null
  clearLeaveTimer()
  if (phase === "open") beginClose(true)
  else if (phase === "closing") finishClose()
}

// ---- following the control ------------------------------------------------

let followFrame = 0
let following = false

/**
 * The control moved under the card. Put the card back on it.
 *
 * The version this replaces HID on scroll, and that was right for a card that
 * could only appear and disappear: re-placing it every frame would have been a
 * card pinned to something the reader is moving away from. It is wrong for one
 * that travels — the card is an object now, and an object does not evaporate
 * because the page moved two pixels. Upstream follows, and so does this.
 *
 * Coalesced into one frame, so a scroll that fires forty events does four
 * measurements, and only attached while a card is up.
 */
function reposition(): void {
  followFrame = 0
  if (phase === "closed" || !anchored || !card) return
  if (!anchored.isConnected) {
    hideTip()
    return
  }
  const placement = placeTip({
    anchor: anchored.getBoundingClientRect(),
    tip: measured,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    prefer: preferred,
  })
  applySide(placement.side)
  /* A jump: the card is keeping up with a control the reader is scrolling
     past, and easing after it would lag by exactly the easing. */
  place({ left: placement.left, top: placement.top, width: measured.width, height: measured.height }, false)
}

const onFollow = (): void => {
  if (followFrame || !framed()) return
  followFrame = requestAnimationFrame(reposition)
}
const onHidden = (): void => {
  if (document.visibilityState === "hidden") hideTip()
}

/**
 * Attach the three listeners that only matter while a card is up.
 *
 * Capturing, because a scroll inside a panel does not bubble to the window.
 * Passive, because this never calls `preventDefault` and a non-passive scroll
 * listener on the document taxes every scroll in the app being edited — which
 * is the cost the previous implementation paid for the whole session, and this
 * one pays only while something is on screen.
 */
function attachFollow(): void {
  if (following) return
  following = true
  window.addEventListener("scroll", onFollow, { capture: true, passive: true })
  window.addEventListener("resize", onFollow)
  document.addEventListener("visibilitychange", onHidden)
}

function detachFollow(): void {
  if (!following) return
  following = false
  if (followFrame) {
    cancelAnimationFrame(followFrame)
    followFrame = 0
  }
  window.removeEventListener("scroll", onFollow, true)
  window.removeEventListener("resize", onFollow)
  document.removeEventListener("visibilitychange", onHidden)
}

// ---- installation ---------------------------------------------------------

/**
 * True when the focus that just landed is the kind a tooltip answers.
 *
 * `:focus-visible`, the same test the three stylesheets used, so clicking a
 * toolbar button does not leave a label hanging over the bar after the pointer
 * has gone. Guarded because a `matches()` with a selector the engine does not
 * know throws, and the suites drive this chrome under jsdom — where the honest
 * answer to "is this focus visible" is that there is nothing to see, so the
 * tip is allowed and the test can assert on it.
 */
function focusIsVisible(node: HTMLElement): boolean {
  try {
    return node.matches(":focus-visible")
  } catch {
    return true
  }
}

/**
 * Mount the one tooltip. Idempotent; returns the teardown.
 *
 * Delegated from `document` rather than from the editor root, and that is the
 * reason ~40 call sites need no change: every one of them already writes
 * `data-de-tip` or `title`, and four separate chrome roots are mounted on
 * `<body>` (the editor, the options window, the token popover, the inspector's
 * probe). One listener set at the document covers all of them and covers
 * anything mounted later, which a per-surface install cannot — and it is also
 * what lets this be a port of a component whose whole model is ONE card shared
 * by every trigger, without the per-trigger wrapper element upstream needs.
 *
 * `pointerover` rather than `mouseenter`: it bubbles, so one listener sees
 * every control, and it reports its `pointerType`, so a touch — which has no
 * hover and cannot dismiss a card — is ignored outright. Upstream offers a
 * long-press path for touch; it is not taken here, because the delegated
 * listener would have to claim a press anywhere in the document to implement
 * it, and this chrome's canvas is nothing but presses.
 */
export function installTooltips(): () => void {
  if (release) return release

  /* Eagerly, so the first card of the session has a computed style for its
     exit fade and its travel to start from. */
  ensureCard()

  const onPointerOver = (event: PointerEvent): void => {
    if (event.pointerType === "touch") return
    const node = anchorFor(event.target)
    if (node) schedule(node)
    else leave()
  }
  /* Leaving the window entirely: `relatedTarget` is null and no `pointerover`
     will follow to close it. */
  const onPointerOut = (event: PointerEvent): void => {
    if (event.relatedTarget === null) leave()
  }
  const onFocusIn = (event: FocusEvent): void => {
    const node = anchorFor(event.target)
    if (node && focusIsVisible(node)) schedule(node)
    else leave()
  }
  /*
   * Only the control the card is FOR. A `focusout` anywhere else in the
   * document — a field the reader left, a panel that took focus as it opened —
   * says nothing about a tip the pointer is still resting on, and hiding on it
   * unconditionally made a hover tip vanish for a reason on the other side of
   * the screen.
   */
  const onFocusOut = (event: FocusEvent): void => {
    if (anchorFor(event.target) === anchored) hideTip()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") hideTip()
  }
  /*
   * A press is an answer. The reader stopped asking what the control does and
   * did it — and on a control that opens a menu, the card would otherwise sit
   * over the menu it just opened.
   */
  const onPointerDown = (): void => hideTip()

  document.addEventListener("pointerover", onPointerOver, true)
  document.addEventListener("pointerout", onPointerOut, true)
  document.addEventListener("focusin", onFocusIn, true)
  document.addEventListener("focusout", onFocusOut, true)
  document.addEventListener("keydown", onKeyDown, true)
  document.addEventListener("pointerdown", onPointerDown, true)
  window.addEventListener("blur", hideTip)

  release = () => {
    document.removeEventListener("pointerover", onPointerOver, true)
    document.removeEventListener("pointerout", onPointerOut, true)
    document.removeEventListener("focusin", onFocusIn, true)
    document.removeEventListener("focusout", onFocusOut, true)
    document.removeEventListener("keydown", onKeyDown, true)
    document.removeEventListener("pointerdown", onPointerDown, true)
    window.removeEventListener("blur", hideTip)
    hideTip()
    detachFollow()
    card?.root.remove()
    card?.ruler.remove()
    card = null
    shown = null
    warmUntil = 0
    release = null
  }
  return release
}

// ───────────────────────────────────────────────────── the call sites ──────

/**
 * The attribute bag for an `el()` call — the shape the chrome already builds.
 *
 * `shell/toolbar.ts` has a private helper of exactly this signature, down to
 * the ` · ` separator, and its comment argues the case: one parameter rather
 * than two "because the tip has one shape, and a second overload would be how
 * the separator ends up spelled two ways". That is now true of the whole
 * chrome rather than of one file, which is why the helper moves here.
 *
 * `aria-label` comes with it and is not optional. A card marked `aria-hidden`
 * is not a name, so a control given only a tip is a control with no accessible
 * name at all — the thing this pairing exists to make unspellable.
 */
export function tipAttrs(label: string, options: TipOptions = {}): Record<string, string> {
  const attrs: Record<string, string> = {
    [TIP_ATTR]: options.second ? `${label} · ${options.second}` : label,
    "aria-label": label,
  }
  if (options.side) attrs[TIP_PLACEMENT_ATTR] = options.side
  if (options.instant) attrs[TIP_INSTANT_ATTR] = ""
  if (options.wrap) attrs[TIP_WRAP_ATTR] = ""
  return attrs
}

/**
 * The same thing for an element that already exists.
 *
 * Writes attributes and nothing else — there is no per-element listener and no
 * registry, so a control built this way behaves identically to one built with
 * `tipAttrs`, and removing the attribute is all it takes to remove the tip.
 *
 * It does NOT touch `aria-label`: a control may well be named by its own text
 * and overwriting that with the tip's wording is how a "Save" button comes to
 * announce "Save · ⌘S". Pass the name through `tipAttrs` at construction, or
 * set it at the call site.
 */
export function tip(node: HTMLElement, label: string, options: TipOptions = {}): void {
  node.setAttribute(TIP_ATTR, options.second ? `${label} · ${options.second}` : label)
  if (options.side) node.setAttribute(TIP_PLACEMENT_ATTR, options.side)
  if (options.instant) node.setAttribute(TIP_INSTANT_ATTR, "")
  if (options.wrap) node.setAttribute(TIP_WRAP_ATTR, "")
  /* A `title` left behind would paint the OS tip over ours a second later. */
  node.removeAttribute("title")
}
