/**
 * Draggable panel seams.
 *
 * Both side panels can be resized by their inner edge, with the keyboard, and
 * by a double-click that puts them back where they started. None of that is
 * written here: the mechanism is `motion-panels`, and specifically its
 * framework-agnostic core rather than its React adapter, because this overlay
 * is plain DOM on purpose (`core/dom.ts` has the reason — a second React tree
 * in the app's document would fight the app's own reconciler).
 *
 * The core is a pure state machine. It owns the drag session, the bounds, the
 * rubber band at the limits, the keyboard map, the fold animation, and the
 * `role="separator"` ARIA values — and it writes no styles at all. What it
 * publishes is a `MotionValue` per panel, and every pixel that reaches the
 * screen is written below, by us, out of that value. So the panels keep their
 * own stylesheet and the library supplies only the number, which is what makes
 * "add resizing" a change with no visual design in it.
 *
 * ## Two widths, not one
 *
 * Each panel has a DESIRED width — what the user dragged it to, and what gets
 * persisted — and an APPLIED width, which is the desired one after the window
 * has had its say. They are separate because the alternative loses information:
 * squeeze a 420px inspector down to 260 to fit a narrow window, write that back
 * as the desired width, and widening the window again leaves it at 260 with
 * nothing to restore from. Keeping the two apart is what makes the layout
 * actually elastic — `layout()` below re-derives applied from desired on every
 * window resize, so a panel gives room up under pressure and takes it back when
 * the pressure goes.
 *
 * ## Where the app's inset comes from
 *
 * The app is inset by padding on `<html>` (`--de-left` / `--de-right`, written
 * by `shell.ts`), and `shell.ts` has a long-standing rule that the inset moves
 * in ONE step rather than animating, because transitioning it relayouts the
 * whole app on every frame. That rule survives here, narrowed rather than
 * broken: during a DRAG the inset follows the live value, because a resize the
 * app does not follow is not a resize — you would be dragging a panel over a
 * page that reflows once you let go. Every other time the width moves under its
 * own animation (a fold settling, a window resize) the inset jumps straight to
 * the destination and the panel slides over ground the app has already given
 * up, which is exactly what the hide/show transition already does.
 */

import {
  attachSeparator,
  createPanel,
  createPanelGroup,
  FILL_ATTRIBUTE,
  SEPARATOR_ATTRIBUTE,
} from "motion-panels"
import type { PanelController, PanelOptions } from "motion-panels"

import { el } from "../core/dom"
import { tokens } from "../core/tokens"
import { prefersReducedMotion } from "../core/motion"

export type PanelSide = "left" | "right"

const SIDES: readonly PanelSide[] = ["left", "right"]

export interface PanelResize {
  /** The flex row holding both panels and the canvas gap between them. */
  rail: HTMLElement
  /**
   * Tell the rail it is on screen. Must be called once the shell has appended
   * it, and see the implementation for what goes wrong if it is not.
   */
  ready(): void
  /** Shows or hides one panel, and the seam that resizes it, together. */
  setOpen(side: PanelSide, open: boolean): void
  /** What the app's inset on that side should be right now, in pixels. */
  inset(side: PanelSide): number
  destroy(): void
}

export interface PanelResizeOptions {
  left: HTMLElement
  right: HTMLElement
  /** A width the insets depend on has moved. */
  onResize(): void
  /**
   * A drag pulled the panel shut.
   *
   * Reported rather than acted on, because "closed" is the shell's state to
   * hold — the toolbar has a toggle for the same thing, and two owners for one
   * boolean is how a panel ends up shut with its toggle still lit.
   */
  onClose(side: PanelSide): void
}

interface Spec {
  label: string
  defaultSize: number
  minSize: number
  /** A share of the window rather than a pixel cap; see `tokens.size`. */
  maxShare: number
}

const SPECS: Record<PanelSide, Spec> = {
  left: {
    label: "Resize left panel",
    defaultSize: tokens.size.panelWidth,
    minSize: tokens.size.panelMinWidth,
    maxShare: tokens.size.panelMaxShare,
  },
  right: {
    label: "Resize inspector",
    defaultSize: tokens.size.inspectorWidth,
    minSize: tokens.size.inspectorMinWidth,
    maxShare: tokens.size.inspectorMaxShare,
  },
}

/**
 * The fold, and it is the drawer curve the panels already leave on.
 *
 * `motion-panels` ships its own default and it is a good one, but the chrome
 * has exactly one motion vocabulary and a panel that settles on a different
 * curve from the one it slides out on reads as two different surfaces.
 *
 * DERIVED, not restated. These were the literals `0.24` and
 * `[0.32, 0.72, 0, 1]` — `tokens.duration.resize` and `tokens.ease` written out
 * by hand, with nothing keeping them in agreement. Motion wants seconds and a
 * number array where CSS wants a string, which is why the conversion exists;
 * it is not a reason for the values to be typed twice.
 */
const FOLD = {
  duration: Number.parseFloat(tokens.duration.resize) / 1000,
  ease: cubicBezierPoints(tokens.ease),
} as const

/**
 * `cubic-bezier(a, b, c, d)` as the four numbers Motion takes.
 *
 * Falls back to the curve's own control points if the token is ever written in
 * a form this cannot read — a keyword, say. A fold on a slightly wrong curve is
 * a much smaller failure than a fold that throws, and the test suite pins the
 * token's shape.
 */
function cubicBezierPoints(curve: string): [number, number, number, number] {
  const numbers = curve.match(/-?\d*\.?\d+/g)?.map(Number)
  return numbers?.length === 4
    ? (numbers as [number, number, number, number])
    : [0.32, 0.72, 0, 1]
}

/**
 * Reduced motion, for the one animation in the chrome that CSS cannot reach.
 *
 * Every other transition here is a stylesheet declaration, so the blanket in
 * `css/base.ts` clamps it. This one is a JS animation writing an inline width
 * per frame, and no media query can touch it: a reader who asked for less
 * motion still got 240ms of panel width on a seam double-click, a keyboard
 * resize, or a window re-fit.
 *
 * The query itself lives in `core/motion.ts`, which is where the other two
 * places JS has to ask this question read it from.
 */
function foldTransition(): typeof FOLD | { duration: 0 } {
  return prefersReducedMotion() ? { duration: 0 } : FOLD
}

// ──────────────────────────────────────────────── remembering widths ───────

/**
 * A panel width is a working preference, so it outlives the tab.
 *
 * Same bargain the launcher's corner and the theme toggle already make, and
 * the same guard: `localStorage` does not return null when an origin's storage
 * is blocked, it THROWS on property access, and this runs during boot.
 */
const STORAGE_KEY = "designlayer:panel-widths"

type Widths = Partial<Record<PanelSide, number>>

function storedWidths(): Widths {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return {}
    const widths: Widths = {}
    for (const side of SIDES) {
      const value = (parsed as Record<string, unknown>)[side]
      // A stored width is clamped on the way IN as well as on the way out: a
      // hand-edited or stale entry should not be able to mount the editor with
      // a panel wider than the screen.
      if (typeof value !== "number" || !Number.isFinite(value)) continue
      widths[side] = Math.max(SPECS[side].minSize, Math.round(value))
    }
    return widths
  } catch {
    return {}
  }
}

function rememberWidths(widths: Record<PanelSide, number>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(widths))
  } catch {
    // The drag still worked; it just will not outlive the tab.
  }
}

// ────────────────────────────────────────────────────────── the rail ───────

interface Entry {
  controller: PanelController<number>
  panel: HTMLElement
  separator: HTMLElement
  spec: Spec
  /** What the user asked for. Never written by the fitting pass. */
  desired: number
  /** What the window allowed. What the controller is actually holding. */
  applied: number
  open: boolean
  /** A drag folded it past its own minimum; acted on once the drag ends. */
  closing: boolean
  /** The last inset reported upward, so an unchanged value costs nothing. */
  reported: number
}

export function mountPanelResize(options: PanelResizeOptions): PanelResize {
  const group = createPanelGroup("horizontal")
  /*
   * The rail's width, read off the viewport rather than the rail.
   *
   * The rail fills `.de-root`, which is fixed at `inset: 0`, so the two are
   * the same number. The root element's `clientWidth` is the viewport minus
   * any classic scrollbar, which is what a fixed box at `inset: 0` gets. It
   * still needs a laid-out page to answer, so boot does not ask it before the
   * first frame (see `ready`).
   */
  const railWidth = () => document.documentElement.clientWidth
  const fill = el("div", { class: "de-rail-fill", [FILL_ATTRIBUTE]: "" })
  const saved = storedWidths()
  const entries = {} as Record<PanelSide, Entry>
  const teardown: Array<() => void> = []

  /**
   * How wide each panel is allowed to be, given the window and each other.
   *
   * Every open panel is guaranteed its minimum, the canvas is guaranteed its
   * floor, and whatever is left over is handed out widest-first — the panel
   * with the most slack above its own minimum is the one with the most to give,
   * so it is the one asked first. A panel never gets more than its share of the
   * window, which is the same ceiling a drag stops at, so the two rules cannot
   * disagree about where the wall is.
   */
  const layout = (instant = false, total = railWidth()): void => {
    if (total <= 0) return

    const open = SIDES.filter((side) => entries[side].open)
    const floors = open.reduce((sum, side) => sum + entries[side].spec.minSize, 0)
    let slack = Math.max(0, total - tokens.size.canvasMinWidth - floors)

    // Widest first. Sorting by the desired width rather than by the applied one
    // keeps the order stable while the window is being dragged: applied widths
    // move on every frame and could swap the two panels' priority mid-gesture.
    for (const side of [...open].sort((a, b) => entries[b].desired - entries[a].desired)) {
      const entry = entries[side]
      const ceiling = Math.min(entry.spec.minSize + slack, Math.round(total * entry.spec.maxShare))
      const applied = Math.max(entry.spec.minSize, Math.min(entry.desired, ceiling))
      slack = Math.max(0, slack - (applied - entry.spec.minSize))
      if (applied === entry.applied) continue
      entry.applied = applied
      entry.controller.sync(optionsFor(entry))
      /*
       * Mounting is a state, not a transition.
       *
       * `sync` reaches its new size by folding to it, which is right for every
       * later fit — the window changed under you and the panel is seen to give
       * way. It is wrong exactly once: a width restored from the last session
       * that no longer fits this window would animate from the old number to
       * the new one while the editor is still booting, which reads as the
       * chrome settling rather than as the chrome arriving. Jumping the value
       * cancels that fold and leaves the panel simply correct.
       */
      if (!instant) continue
      entry.controller.motion.size.jump(applied)
      entry.controller.motion.content.jump(applied)
      paint(entry)
    }
  }

  /**
   * The options object the controller is re-synced with.
   *
   * Rebuilt rather than mutated because `sync` compares the size it is handed
   * against the target it is holding; handing it the same object back with a
   * field changed underneath works, but it makes the one place that decides
   * whether a fold happens depend on aliasing.
   */
  const optionsFor = (entry: Entry): PanelOptions<number> => ({
    size: entry.applied,
    minSize: entry.spec.minSize,
    maxSize: `${Math.round(entry.spec.maxShare * 100)}%`,
    defaultSize: entry.spec.defaultSize,
    transition: foldTransition(),
    onSizeChange: (next) => {
      entry.desired = next
      rememberWidths({ left: entries.left.desired, right: entries.right.desired })
      layout()
    },
    /*
     * Pulling a panel past half its own minimum closes it.
     *
     * Providing this callback is what turns the behaviour on in the library at
     * all, and the close is DEFERRED to the end of the gesture rather than done
     * here. This fires from a `pointermove`, while the seam still holds the
     * pointer capture for the drag — hiding the element it is captured on
     * mid-gesture is how a drag gets stuck with the pointer released and the
     * body still locked. By the time `publish` sees `dragging` go false the
     * pointer is up and the capture is gone.
     */
    onCollapsedChange: (collapsed) => {
      entry.closing = collapsed
    },
  })

  const build = (side: PanelSide): Entry => {
    const spec = SPECS[side]
    const panel = options[side]
    const separator = el("div", {
      class: `de-separator de-separator--${side}`,
      role: "separator",
      tabindex: "0",
      "aria-orientation": "vertical",
      "aria-label": spec.label,
      [SEPARATOR_ATTRIBUTE]: "",
    })

    const desired = saved[side] ?? spec.defaultSize
    const entry: Entry = {
      // Assigned immediately below; the controller needs the entry to exist so
      // its own callbacks can read the widths off it.
      controller: undefined as unknown as PanelController<number>,
      panel,
      separator,
      spec,
      desired,
      applied: desired,
      open: !panel.hidden,
      closing: false,
      reported: -1,
    }
    entry.controller = createPanel<number>(group, optionsFor(entry))
    entries[side] = entry
    return entry
  }

  /** The width the app should be inset by on this side, right now. */
  const insetOf = (entry: Entry): number => {
    if (!entry.open) return 0
    const { controller } = entry
    return Math.round(controller.state.dragging ? controller.motion.size.get() : controller.target)
  }

  /** The one write that puts a width on screen. */
  const paint = (entry: Entry): void => {
    entry.panel.style.width = `${Math.max(0, Math.round(entry.controller.motion.size.get()))}px`
  }

  /**
   * Paint the width, and tell the shell only when its own number moved.
   *
   * The size value changes on every frame of a fold as well as on every frame
   * of a drag, and outside a drag the inset is pinned to the destination — so
   * most of those frames have nothing to say to the shell. Filtering here rather
   * than in `shell.ts` keeps the rule about which frames move the app in the one
   * file that knows what a frame is.
   */
  const publish = (entry: Entry): void => {
    paint(entry)
    const next = insetOf(entry)
    if (next === entry.reported) return
    entry.reported = next
    options.onResize()
  }

  const rail = el("div", { class: "de-rail" })

  for (const side of SIDES) build(side)
  rail.append(
    entries.left.panel,
    entries.left.separator,
    fill,
    entries.right.separator,
    entries.right.panel
  )

  for (const side of SIDES) {
    const entry = entries[side]
    teardown.push(entry.controller.attach(entry.panel))
    teardown.push(attachSeparator(entry.separator, group, entry.controller))
    teardown.push(entry.controller.motion.size.on("change", () => publish(entry)))
    teardown.push(
      entry.controller.subscribe(() => {
        publish(entry)
        if (entry.closing && !entry.controller.state.dragging) {
          entry.closing = false
          options.onClose(side)
        }
      })
    )
    teardown.push(() => entry.controller.destroy())
    /*
     * Mount paints but does not report. `onResize` is the shell's own
     * `syncInsets`, and the shell has not finished building itself yet — it is
     * still inside the call that produces the value it would be reading back.
     * It writes the insets once on its own as soon as it has, which is the
     * same first write this would have triggered.
     */
    paint(entry)
    entry.reported = insetOf(entry)
  }

  /*
   * The window moving is the other half of "responsive".
   *
   * `bounds()` already stops a DRAG from eating the canvas, but nothing stops
   * the window from shrinking under two panels that were legal when they were
   * set. Re-fitting on resize is what gives the canvas its floor back, and
   * because the desired widths are untouched by that, growing the window puts
   * both panels back where the user left them.
   *
   * A window listener rather than a `ResizeObserver` on the rail, even though
   * the rail is the thing being measured. The rail spans the viewport, so the
   * two fire on the same events — but an observer also fires on the resize
   * IT caused, since fitting writes a width, and Chrome reports that as
   * "ResizeObserver loop completed with undelivered notifications". The host
   * app's error handler treats that as an application error and puts it in the
   * console. Nothing but the window can change this element's width, so nothing
   * is lost by asking the window.
   */
  let measured = 0
  const onWindowResize = () => {
    const width = railWidth()
    if (width === measured) return
    measured = width
    layout()
  }
  window.addEventListener("resize", onWindowResize)
  teardown.push(() => window.removeEventListener("resize", onWindowResize))

  return {
    rail,
    /*
     * Everything the library measures, it measures with `getComputedStyle` —
     * how much room is left for a drag, and therefore what the separator
     * publishes as `aria-valuemin` and `aria-valuemax`. An element that is not
     * in the document yet has no computed width to read, so a bound taken
     * before the shell appends the rail is `NaN`, and it STAYS NaN: the
     * separator only recomputes when something tells it to.
     *
     * So this is the shell saying the rail is on screen. `layout()` fits the
     * stored widths to the window that actually turned up, and `notify()` walks
     * both seams over their own bounds again now that there is something to
     * measure.
     */
    ready() {
      /*
       * Fitted against the window's width for now, and against the rail's
       * once the first frame has laid the page out.
       *
       * The shell mounts in the task that committed the app, before the app
       * has ever been laid out, so `railWidth()` here would lay out the whole
       * app on the spot — and the inset written straight after it would make
       * the frame lay it out again. `innerWidth` costs no layout and is the
       * rail's width wherever scrollbars overlay the page; a classic scrollbar
       * makes it the wider of the two, and the second fit corrects for that
       * before the chrome is first drawn. It only moves a width the window is
       * too narrow to hold anyway, and the app's inset with it, by a
       * scrollbar's width, a frame after the app's first paint.
       */
      measured = window.innerWidth
      layout(true, measured)
      // After the frame rather than in it: the bounds are only
      // `aria-valuemin`/`-max`, nobody can reach a seam before the first
      // paint, and `notify` reads computed styles — before that paint, a
      // forced restyle and layout of the whole document in the middle of boot.
      requestAnimationFrame(() => setTimeout(() => {
        const width = railWidth()
        if (width !== measured) {
          measured = width
          layout(true, width)
        }
        group.notify()
      }))
    },
    setOpen(side, open) {
      const entry = entries[side]
      entry.panel.hidden = !open
      entry.separator.hidden = !open
      if (entry.open === open) return
      entry.open = open
      // The other panel's ceiling just moved: a closed neighbour is slack.
      layout()
      for (const other of SIDES) publish(entries[other])
    },
    inset: (side) => insetOf(entries[side]),
    destroy() {
      for (const stop of teardown.reverse()) stop()
      rail.remove()
    },
  }
}
