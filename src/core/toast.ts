/**
 * The editor's toast. One surface, one owner, bottom-right.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A REACT ROOT IN A CODEBASE THAT SAYS THERE ISN'T
 *
 * `core/dom.ts` opens by stating that the overlay is plain DOM on purpose,
 * because a second React tree would fight the app's own reconciler and its
 * Motion layout animations. That reason is about rendering CHROME INTO THE
 * APP'S DOCUMENT TREE, where two reconcilers end up arguing over the same
 * nodes. It does not reach this file:
 *
 *   - This root is mounted on a shadow root hung off `<body>`, outside every
 *     element the app renders. React roots are independent of one another;
 *     nothing here ever touches a node the app's reconciler owns.
 *   - It renders one component that renders a list of strings. There is no
 *     shared element, no layout animation, and no hand-off.
 *
 * The rest of the chrome stays plain DOM, and a second component arriving here
 * would be the signal that this exception has stopped being one.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY TOAST IN THE SYSTEM COMES THROUGH HERE
 *
 * Before this file there were two toasts and they did not look alike. Ours went
 * `context.toast` -> `bridge.toast` -> the vendor's `V`, which sets the text on
 * one fixed `div` at bottom-left, ignores the `kind` argument outright, and
 * clears it after two seconds — so the 40-odd `"…", "error"` call sites in this
 * package rendered exactly like the success ones. The vendor also calls `V`
 * from inside its own bundle, for socket failures we never see the source of.
 *
 * Both are funnelled here:
 *
 *   - Ours, by `core/bridge.ts` replacing `toast` on the bridge it hands out.
 *     Every `context.toast` and every `bridge.toast` in the package lands on
 *     `notify` without a single call site changing, and `kind` survives.
 *   - The vendor's, by `mirrorVendorToasts` below, which watches the node `V`
 *     writes into and re-emits what it says. The node itself is suppressed with
 *     the rest of the vendor chrome (`css/base.ts`), so it is observed rather
 *     than seen.
 *
 * Nothing double-fires: with the bridge wrapped, our calls never reach `V`, so
 * the mirror only ever sees messages the vendor raised on its own.
 *
 * ---------------------------------------------------------------------------
 * WHEN TO TOAST
 *
 * A toast is for news the reader cannot see on the canvas. Raise one for:
 *
 *   - an error, or a change that did not fully land ("preview only");
 *   - a handoff: notes or change prompts copied, or sent to the agent;
 *   - something copied to the clipboard, which has no visible trace;
 *   - a write to source or to disk (Apply to code, a lint fix, a saved default);
 *   - a destructive step that offers Undo (deleting notes);
 *   - a system change: switching apps, adding a library, signing in.
 *
 * Never for direct manipulation — a style, class, icon or attribute edit, a
 * drag, resize, delete, hide or lock on the canvas, undo and redo, toggling the
 * note pins. The canvas already shows the result. The one exception is when a
 * direct edit loses part of itself on the way to source, which is an error.
 *
 * `tools/toast-gallery.mjs` renders every toast the editor raises, and the
 * silent events, on one page for review.
 */

import { toasterCss } from "./css/toast"
import { CHROME_ATTR } from "./dom"

type View = typeof import("./toaster-view")

export type ToastKind = "info" | "error"

/**
 * One button on a toast, for the one thing a toast can offer that a sentence
 * cannot: taking the action back.
 *
 * Deliberately a single optional action rather than a general options bag. A
 * toast in this chrome is a statement about something that already happened,
 * and the only interaction that belongs on one is undoing it — anything else a
 * card wants a reader to DO belongs on the surface that owns the thing, which
 * is the standing rule `css/lint.ts` records. Keeping the shape this narrow is
 * what stops the toast layer growing into a second, worse dialog.
 */
export interface ToastAction {
  label: string
  onClick(): void
}

const HOST_ID = "designlayer-toaster"

/**
 * Four seconds for news. A failure waits to be dismissed.
 *
 * The vendor used two seconds for everything, which is too short for the
 * longest thing the editor says — "Applied 3 changes — width, height is preview
 * only" is 48 characters past the point where two seconds is a glimpse.
 *
 * THE ERROR RUNG IS NOT A DURATION ANY MORE, and that is the change. It was six
 * seconds, on the argument that an error is the thing the reader has to act on
 * and therefore needs longer. The argument was right and the conclusion was one
 * step short: 52 of the product's 77 error states exist ONLY as a toast, every
 * one of those sentences now ends in an instruction, and an instruction that
 * removes itself after six seconds is an instruction for whoever happened to be
 * looking at the corner of the screen. The rest are told that something went
 * wrong by nothing at all — while the preview still shows the change that did
 * not get written.
 *
 * So an error stays, and `closeButton` below turns on to give it a way out. The
 * standing rule `css/lint.ts` documents — that anything needing to outlive the
 * glance belongs on a surface rather than in a toast — is still the right rule,
 * and the 52 states that break it are a backlog rather than a reason to keep
 * discarding them silently in the meantime.
 */
const DURATION: Record<ToastKind, number> = { info: 4000, error: Number.POSITIVE_INFINITY }

interface Mounted {
  host: HTMLElement
  shadow: ShadowRoot
  mountPoint: HTMLElement
  /** Set once `toaster-view` has loaded and rendered into `mountPoint`. */
  unmount: (() => void) | null
  loading: boolean
}

/**
 * What a card says: a short title, and optionally a body under it.
 *
 * Call sites may pass either. A plain string is split by `splitToast`, so the
 * common "What happened. What to do." sentence gets the title/body treatment
 * without every caller spelling it out; pass the object when the first clause
 * is not a concise title on its own.
 *
 * `id` names a card so it can be taken back with `retract` — for a notice
 * about a state that may end before the card would, like the boot wait.
 */
export type ToastMessage = string | { title: string; description?: string; id?: string }

export interface ToastContent {
  title: string
  description?: string
  id?: string
}

/**
 * Title and body from one sentence, at its first break.
 *
 * A break is a sentence end (". "), an ellipsis followed by more text ("… "),
 * or a spaced em dash (" — "), whichever comes first. The title drops a closing
 * period — a title is a label, not a sentence — but keeps an ellipsis, which
 * means "still going". The body is capitalized after a dash, and gets a period
 * when it ends without one, so every body reads as the sentence it is.
 *
 * A message with no break is all title: short news ("Copied JSX") has nothing
 * to put underneath, and a lone line in the body style would read as a caption
 * missing its heading.
 */
export function splitToast(message: ToastMessage): ToastContent {
  if (typeof message !== "string") {
    const title = message.title.trim()
    const description = message.description?.trim()
    return {
      title,
      ...(description ? { description } : {}),
      ...(message.id ? { id: message.id } : {}),
    }
  }
  const text = message.trim()
  const match = /(\.|…|\s—)\s+/.exec(text)
  if (!match || match.index === 0) return { title: text }
  const title = text.slice(0, match.index) + (match[1] === "…" ? "…" : "")
  let description = text.slice(match.index + match[0].length).trim()
  if (!description) return { title: text }
  if (match[1] !== ".") description = description[0].toUpperCase() + description.slice(1)
  if (!/[.!?…)]$/.test(description)) description += "."
  return { title, description }
}

let mounted: Mounted | null = null
/** The React half, once loaded. Its Toaster may still be subscribing. */
let view: View | null = null
let ready = false
/** Raised before the Toaster's subscription exists. Drained once, in order. */
const pending: Array<[ToastContent, ToastKind, ToastAction | undefined]> = []

function emit(sonner: View["sonner"], content: ToastContent, kind: ToastKind, action?: ToastAction): void {
  /*
   * An action on an INFO card lengthens it, and only that card.
   *
   * `DURATION.info` is four seconds, which is the right length for a sentence
   * you read and forget. It is the wrong length for a button: four seconds is
   * about as long as it takes to notice a row has gone, decide it should not
   * have, and move the pointer — so an undo that expires on the reading rung
   * would be an offer withdrawn just as it was being accepted.
   *
   * Eight, not `Infinity`. An undo is not an error: it has a natural end,
   * because the moment passes and the reader moves on, and a card that sat
   * there until dismissed would make every delete cost two clicks after all —
   * which is exactly what keeping the row's single click was for.
   */
  const options = {
    description: content.description,
    ...(content.id ? { id: content.id } : {}),
    ...(action ? { duration: 8000, action: { label: action.label, onClick: action.onClick } } : {}),
  }
  // An error is the typed call, because the type is what selects the glyph.
  // News is the UNTYPED call, which has no glyph at all: an icon on every card
  // made the rare one that matters look like the rest. So the only card with
  // an icon, and the only colour in the toaster, is a failure (`css/toast.ts`).
  if (kind === "error") sonner.error(content.title, { duration: DURATION.error, ...options })
  else sonner(content.title, { duration: DURATION.info, ...options })
}

/** Called by `toaster-view`'s ReadyGate once Sonner's subscription exists. */
function onReady(): void {
  ready = true
  for (const [content, kind, action] of pending.splice(0)) emit(view!.sonner, content, kind, action)
}

declare global {
  interface Window {
    /** Where the launcher serves the React half; set by the overlay script. */
    __DESIGNLAYER_TOASTER__?: string
  }
}

/**
 * Loads and renders the React half into the mounted shadow root. Idempotent.
 *
 * The launcher serves it as a module of its own beside the overlay, and the
 * overlay names its URL, so React and Sonner are not even parsed until the
 * first message (see `build.mjs`). A bundle run without the launcher — the
 * suites bundle `src/` themselves — has no URL and compiles the view in
 * through the plain `import()`.
 */
function load(): void {
  const target = mounted
  if (!target || target.loading) return
  target.loading = true
  const url = window.__DESIGNLAYER_TOASTER__
  const loading: Promise<View> = url ? import(url) : import("./toaster-view")
  loading.then(
    (loaded) => {
      // Destroyed (or destroyed and re-installed) while loading: the shadow root
      // this was meant for is gone, and the new one schedules its own load.
      if (mounted !== target) return
      view = loaded
      target.unmount = loaded.mountToaster(target.mountPoint, onReady)
    },
    (error) => {
      // Messages stay queued: a later one retries the load.
      if (mounted === target) target.loading = false
      console.warn("[designlayer] toaster failed to load", error)
    }
  )
}

/**
 * Mounts the toaster. Idempotent, and cheap enough to call from `notify`.
 *
 * Called from `notify`, so a toast raised before anything else has mounted is
 * queued rather than lost.
 *
 * Only the cheap half runs here: the host, its shadow root and stylesheet. The
 * React half loads at idle after the first input (`prepareToasterOnFirstInput`)
 * or with the first message, whichever is first — never on the boot path.
 */
export function installToaster(): () => void {
  if (mounted) return destroy

  const host = document.createElement("div")
  host.id = HOST_ID
  // The chrome marker, and it is load-bearing rather than decorative: the
  // vendor guards `document` against gestures that are not its own, and
  // `shell.ts` only declaws that guard for elements under this attribute. It
  // is what lets a toast be swiped away and an action button be clicked.
  host.setAttribute(CHROME_ATTR, "")

  const shadow = host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = toasterCss
  const mountPoint = document.createElement("div")
  shadow.append(style, mountPoint)
  document.body.append(host)

  mounted = { host, shadow, mountPoint, unmount: null, loading: false }
  return destroy
}

/**
 * Loads the React half ahead of the first message, once one is likely.
 *
 * The first card used to wait for React to load at all — measured ~27ms from
 * an Apply click to the card, against ~1ms for every card after it. A toast
 * answers something the user did, so the first input is the earliest moment
 * one becomes likely. The load then waits for the user to pause — 300ms
 * with no pointer or key — and for an idle callback after that, so its
 * ~15ms lands in time nobody is waiting on rather than between the moves of a
 * hover or a drag. Boot still never loads React, and a session nobody touches
 * never does.
 */
const PREPARE_PAUSE_MS = 300

export function prepareToasterOnFirstInput(): void {
  const first = ["pointerdown", "keydown"] as const
  const activity = ["pointerdown", "pointermove", "keydown", "wheel"] as const
  const options = { capture: true, passive: true }
  let pause = 0
  const run = () => {
    for (const type of activity) window.removeEventListener(type, rearm, true)
    installToaster()
    load()
  }
  const idle = () => {
    // Safari has no idle callback; the pause is the promise there.
    if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 1000 })
    else run()
  }
  const rearm = () => {
    window.clearTimeout(pause)
    pause = window.setTimeout(idle, PREPARE_PAUSE_MS)
  }
  const start = () => {
    for (const type of first) window.removeEventListener(type, start, true)
    for (const type of activity) window.addEventListener(type, rearm, options)
    rearm()
  }
  for (const type of first) window.addEventListener(type, start, options)
}

function destroy(): void {
  if (!mounted) return
  const { host, unmount } = mounted
  mounted = null
  view = null
  ready = false
  pending.length = 0
  unmount?.()
  host.remove()
}

/**
 * Say something. The one entry point — see the header for who reaches it.
 */
export function notify(message: ToastMessage, kind: ToastKind = "info", action?: ToastAction): void {
  const content = splitToast(message)
  if (!content.title) return
  installToaster()
  if (ready && view) {
    emit(view.sonner, content, kind, action)
    return
  }
  /*
   * An action survives the queue, and it has to.
   *
   * A toast raised before Sonner's subscription exists is held here and drained
   * once it does. Dropping the action on the way through would be the worst
   * possible failure mode: the card still appears, still says what happened,
   * and silently is not offering the way back — which reads as an undo that was
   * pressed and did nothing rather than as one that was never there.
   */
  pending.push([content, kind, action])
  load()
}

/**
 * Takes back a card raised with an `id`, whether it is showing or still queued.
 *
 * For notices about a state that can end before the card would: "Waiting for
 * the app…" is raised on a timer during boot, and once the editor is up (or
 * has given up) a card still saying it is waiting is wrong.
 */
export function retract(id: string): void {
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    if (pending[i][0].id === id) pending.splice(i, 1)
  }
  if (ready && view) view.sonner.dismiss(id)
}

/*
 * ---------------------------------------------------------------------------
 * The vendor's own toasts
 * ---------------------------------------------------------------------------
 */

/** The class the vendor puts on the single `div` its `V` writes into. */
const VENDOR_TOAST = ".toast"
/** The class `V` adds to show it, and removes on its own two-second timer. */
const VENDOR_VISIBLE = "visible"

/**
 * What a vendor message becomes here: said as info, said as an error, or not
 * said at all.
 *
 * The vendor's `V` takes a kind and ignores it, so every message it raises
 * arrives as plain text — its failures included. The kind is recovered from the
 * wording, which is the only thing that survives the trip. The vendor is pinned
 * (`react-rewrite-cli@0.1.1`), so its sentences are a closed set; the error
 * pattern is written against the words they share rather than each sentence,
 * so a server error forwarded verbatim (`V(i.error)`) still reads as one.
 *
 * Silent: the two the vendor raises for direct manipulation — its own undo
 * report and the reset after it — by the rule in the header.
 */
export function classifyVendorToast(text: string): ToastKind | null {
  if (/^Undo: /.test(text) || text === "Everything reset") return null
  if (/fail|error|can't|couldn't|could not|\bdisconnected\b/i.test(text)) return "error"
  return "info"
}

/**
 * Re-emits the vendor's toasts through ours, from the node it writes into.
 *
 * There is no seam to hook: `V` is a minified function inside a pinned bundle,
 * called from the vendor's own code paths, and the bridge patch exposes it
 * rather than wrapping it. The DOM it writes is the only thing both sides can
 * see, so that is what is watched.
 *
 * Three mutations matter and they do not arrive together. `V` sets
 * `textContent` and then adds the visible class — which, for a toast raised
 * while an earlier one is still up, is a no-op that queues NO record at all,
 * because `DOMTokenList.add` does not touch an attribute whose token set is
 * unchanged. So the trigger cannot be the class alone: it is any mutation that
 * leaves the node visible with text that is new, or visible again after having
 * been hidden.
 */
export function mirrorVendorToasts(root: ShadowRoot): () => void {
  let lastText = ""
  let lastVisible = false

  const read = (): void => {
    const node = root.querySelector(VENDOR_TOAST)
    if (!node) return
    const text = (node.textContent ?? "").trim()
    const visible = node.classList.contains(VENDOR_VISIBLE)
    if (visible && text && (text !== lastText || !lastVisible)) {
      const kind = classifyVendorToast(text)
      if (kind) notify(text, kind)
    }
    lastText = text
    lastVisible = visible
  }

  const observer = new MutationObserver(read)
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class"],
  })
  // The node is created by the vendor's own mount, which may be ahead of this
  // call or behind it; observing the ROOT rather than the node is what makes
  // both orders work, and this covers a toast already up when we arrived.
  read()

  return () => observer.disconnect()
}
