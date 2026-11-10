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
 *   - an error, or a change that did not fully land;
 *   - a handoff: notes copied, or sent to the agent;
 *   - something copied to the clipboard, which has no visible trace;
 *   - a write to source or to disk (a lint fix, a saved default);
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
 *
 * ---------------------------------------------------------------------------
 * THE TOASTER'S LIFECYCLE
 *
 * One `Toaster` value, read through `toasterPhase()` and moved only by
 * `transition()`:
 *
 *   idle    --install-->                         loading (host mounted, import started)
 *   loading --imported-->                        loading (rendered; Sonner not subscribed yet)
 *   loading --subscribed-->                      ready   (the queue drains, in order)
 *   loading --import failed, retries left-->     loading (re-import after RETRY_DELAY_MS)
 *   loading --import failed, no retries left-->  failed  (the queue shows as fallback cards)
 *   *       --destroy-->                         idle
 *
 * A message raised while `loading` waits in that phase's queue; in `ready` it
 * goes to Sonner; in `failed` it is drawn as a plain DOM card, so an error is
 * never silent just because the React half could not load.
 *
 * `imported`, `subscribed` and `import failed` each name the mount (its
 * `generation`) they were raised for. One that arrives for a mount that has
 * since been destroyed, or destroyed and installed again, is ignored: a
 * ReadyGate effect from a root that is still unmounting must not mark the new
 * one ready before its own Sonner is listening.
 */

import { TOAST_FALLBACK_ATTR, TOAST_FALLBACK_CARD_ATTR, toasterCss } from "./css/toast"
import { CHROME_ATTR } from "./dom"

type View = typeof import("./toaster-view")

export type ToastKind = "info" | "error"

/**
 * One button on a toast: taking the action back, or opening the surface that
 * owns the thing the toast is about.
 *
 * Deliberately a single optional action rather than a general options bag. A
 * toast in this chrome is a statement about something that already happened.
 * Undoing it belongs on the toast; anything else a reader has to DO belongs on
 * the surface that owns the thing, which is the standing rule `css/lint.ts`
 * records. So the second kind of action only opens that surface (the app
 * chooser's "Open" lands on its ready row, where the real choice is made).
 * Keeping the shape this narrow is what stops the toast layer growing into a
 * second, worse dialog.
 */
export interface ToastAction {
  label: string
  onClick(): void
}

const HOST_ID = "designlayer-toaster"

/**
 * How long a card stays, by what it is.
 *
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
 * So an error stays, and `closeButton` in `toaster-view.ts` turns on to give it
 * a way out. The standing rule `css/lint.ts` documents — that anything needing
 * to outlive the glance belongs on a surface rather than in a toast — is still
 * the right rule, and the 52 states that break it are a backlog rather than a
 * reason to keep discarding them silently in the meantime.
 *
 * AN ACTION ON AN INFO CARD LENGTHENS IT, and only that card (`infoAction`).
 * Four seconds is the right length for a sentence you read and forget, and the
 * wrong length for a button: about as long as it takes to notice a row has
 * gone, decide it should not have, and move the pointer — so an undo that
 * expired on the reading rung would be an offer withdrawn just as it was being
 * accepted. Eight, not `Infinity`: an undo is not an error, it has a natural
 * end, and a card that sat there until dismissed would make every delete cost
 * two clicks after all. An ERROR with an action keeps the error rung — it
 * stays until dismissed, with or without a button on it.
 *
 * `sticky` is for a notice about a state that lasts as long as it lasts — the
 * boot wait — and is taken back with `retract` when that state ends.
 */
const DURATION = {
  info: 4000,
  infoAction: 8000,
  error: Number.POSITIVE_INFINITY,
  sticky: Number.POSITIVE_INFINITY,
} as const

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
 * `sticky` keeps an info card up until it is retracted or closed, for the
 * same kind of notice when the state can outlast the four-second rung.
 */
export type ToastMessage = string | { title: string; description?: string; id?: string; sticky?: boolean }

export interface ToastContent {
  title: string
  description?: string
  id?: string
  sticky?: boolean
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
      ...(message.sticky ? { sticky: true } : {}),
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

/** One card's worth: what it says, its kind, and its button if it has one. */
interface Toast {
  content: ToastContent
  kind: ToastKind
  /*
   * An action survives the queue, and it has to. Dropping it on the way
   * through would be the worst possible failure mode: the card still appears,
   * still says what happened, and silently is not offering the way back —
   * which reads as an undo that was pressed and did nothing rather than as one
   * that was never there.
   */
  action?: ToastAction
}

/** The shadow-root host every phase past `idle` owns. */
interface Mount {
  host: HTMLElement
  mountPoint: HTMLElement
  /** Which install this is; events raised for an earlier one are stale. */
  generation: number
}

/** The lifecycle in the header, one variant per phase, each with what it owns. */
type Toaster =
  | { phase: "idle" }
  | {
      phase: "loading"
      mount: Mount
      /** Imports that have failed on this mount; the one in flight is number `attempts`. */
      attempts: number
      /** Raised before Sonner's subscription exists. Drained once, in order. */
      queue: Toast[]
      /** The React half, once loaded and rendered. Its Toaster may still be subscribing. */
      rendered: { view: View; unmount: () => void } | null
    }
  | { phase: "ready"; mount: Mount; view: View; unmount: () => void }
  | { phase: "failed"; mount: Mount; attempts: number; error: unknown; list: HTMLElement }

export type ToasterPhase = Toaster["phase"]

type ToasterEvent =
  | { type: "install" }
  | { type: "imported"; generation: number; view: View }
  | { type: "subscribed"; generation: number }
  | { type: "importFailed"; generation: number; error: unknown }
  | { type: "destroy" }

let toaster: Toaster = { phase: "idle" }
let installs = 0

/** Where the lifecycle is. For suites and tools; nothing in the editor branches on it. */
export function toasterPhase(): ToasterPhase {
  return toaster.phase
}

/**
 * Re-imports after a failed one, then gives up: two retries, at these delays.
 *
 * A failed module fetch is cached by the browser for that URL, so a retry asks
 * for the same module under a new query (`retry=N`), which the launcher's
 * route ignores. Two, because the failures worth retrying are short — the
 * launcher rebuilding or replacing `dist/toaster.js` while a tab boots — and
 * each retry holds the queue back, errors included: two retries spread over
 * about two and a half seconds outlast a rebuild without leaving a failure
 * unseen for long. A failure that outlasts both will outlast more, and the
 * fallback card takes over from there.
 */
const RETRY_DELAY_MS = [500, 2000] as const

function retryUrl(url: string, attempt: number): string {
  if (attempt === 0) return url
  return `${url}${url.includes("?") ? "&" : "?"}retry=${attempt}`
}

declare global {
  interface Window {
    /** Where the launcher serves the React half; set by the overlay script. */
    __DESIGNLAYER_TOASTER__?: string
  }
}

/**
 * Imports the React half for one mount, and reports back as an event.
 *
 * The launcher serves it as a module of its own beside the overlay, and the
 * overlay names its URL, so React and Sonner are not even parsed until the
 * first message (see `build.mjs`). A bundle run without the launcher — the
 * suites bundle `src/` themselves — has no URL and compiles the view in
 * through the plain `import()`, where a retry simply calls it again.
 */
function startImport(generation: number, attempt: number): void {
  const url = window.__DESIGNLAYER_TOASTER__
  const loading: Promise<View> = url ? import(retryUrl(url, attempt)) : import("./toaster-view")
  loading.then(
    (view) => transition({ type: "imported", generation, view }),
    (error) => transition({ type: "importFailed", generation, error })
  )
}

function createMount(generation: number): Mount {
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
  return { host, mountPoint, generation }
}

/** The one place the lifecycle moves. See the table in the header. */
function transition(event: ToasterEvent): void {
  const current = toaster

  if (event.type === "destroy") {
    if (current.phase === "idle") return
    toaster = { phase: "idle" }
    if (current.phase === "ready") current.unmount()
    if (current.phase === "loading") current.rendered?.unmount()
    current.mount.host.remove()
    return
  }

  if (event.type === "install") {
    if (current.phase !== "idle") return
    installs += 1
    toaster = { phase: "loading", mount: createMount(installs), attempts: 0, queue: [], rendered: null }
    startImport(installs, 0)
    return
  }

  // The rest answer an import or a render begun for one mount; drop them
  // when that mount is no longer the current one.
  if (current.phase !== "loading" || current.mount.generation !== event.generation) return
  const { generation } = current.mount

  switch (event.type) {
    case "imported": {
      if (current.rendered) return
      // In the state before `mountToaster` runs, so a ReadyGate that fired
      // synchronously would still find it; `unmount` is filled in after.
      const rendered = { view: event.view, unmount: () => {} }
      toaster = { ...current, rendered }
      rendered.unmount = event.view.mountToaster(current.mount.mountPoint, () =>
        transition({ type: "subscribed", generation })
      )
      return
    }
    case "subscribed": {
      if (!current.rendered) return
      const { view, unmount } = current.rendered
      toaster = { phase: "ready", mount: current.mount, view, unmount }
      for (const toast of current.queue) emit(view.sonner, toast)
      return
    }
    case "importFailed": {
      const attempts = current.attempts + 1
      console.warn(`[designlayer] toaster failed to load (attempt ${attempts})`, event.error)
      const delay = RETRY_DELAY_MS[attempts - 1]
      if (delay !== undefined) {
        toaster = { ...current, attempts }
        window.setTimeout(() => {
          if (toaster.phase === "loading" && toaster.mount.generation === generation) startImport(generation, attempts)
        }, delay)
        return
      }
      const list = createFallbackList(current.mount)
      toaster = { phase: "failed", mount: current.mount, attempts, error: event.error, list }
      for (const toast of current.queue) showFallback(list, toast)
      return
    }
  }
}

function durationOf({ content, kind, action }: Toast): number {
  if (kind === "error") return DURATION.error
  if (content.sticky) return DURATION.sticky
  return action ? DURATION.infoAction : DURATION.info
}

function emit(sonner: View["sonner"], toast: Toast): void {
  const { content, kind, action } = toast
  const options = {
    duration: durationOf(toast),
    description: content.description,
    ...(content.id ? { id: content.id } : {}),
    ...(action ? { action: { label: action.label, onClick: action.onClick } } : {}),
  }
  // An error is the typed call, because the type is what selects the glyph.
  // News is the UNTYPED call, which has no glyph at all: an icon on every card
  // made the rare one that matters look like the rest. So the only card with
  // an icon, and the only colour in the toaster, is a failure (`css/toast.ts`).
  if (kind === "error") sonner.error(content.title, options)
  else sonner(content.title, options)
}

/*
 * ---------------------------------------------------------------------------
 * The fallback card, for a session whose React half never loaded
 *
 * Plain DOM in the same shadow root, styled by `css/toast.ts` to read like the
 * Sonner card: same surface, corner, cast, type, glyph and close button, same
 * corner of the screen. What it does not have is Sonner's motion, swipe and
 * stack: it is the floor under an error, not a second toaster. Durations are
 * the same table, so news still leaves by itself and an error still waits.
 * ---------------------------------------------------------------------------
 */

/** Sonner's own error glyph and close cross (sonner@2, MIT), so the two cards match. */
const ERROR_GLYPH =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" height="20" width="20" aria-hidden="true"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd"/></svg>'
const CLOSE_GLYPH =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'

function createFallbackList(mount: Mount): HTMLElement {
  const section = document.createElement("section")
  section.setAttribute(TOAST_FALLBACK_ATTR, "")
  // Sonner's own region semantics, minus its hotkey.
  section.setAttribute("aria-label", "Notifications")
  section.setAttribute("aria-live", "polite")
  const list = document.createElement("ol")
  section.append(list)
  mount.mountPoint.append(section)
  return list
}

function showFallback(list: HTMLElement, toast: Toast): void {
  const { content, kind, action } = toast
  const card = document.createElement("li")
  card.setAttribute(TOAST_FALLBACK_CARD_ATTR, "")
  card.dataset.type = kind
  if (content.id) {
    // Sonner replaces a card raised again under the same id; so does this.
    for (const other of [...list.children]) if ((other as HTMLElement).dataset.id === content.id) other.remove()
    card.dataset.id = content.id
  }
  const remove = () => card.remove()

  if (kind === "error") {
    const icon = document.createElement("div")
    icon.setAttribute("data-icon", "")
    icon.innerHTML = ERROR_GLYPH
    card.append(icon)
  }
  const title = document.createElement("div")
  title.setAttribute("data-title", "")
  title.textContent = content.title
  card.append(title)
  if (content.description) {
    const description = document.createElement("div")
    description.setAttribute("data-description", "")
    description.textContent = content.description
    card.append(description)
  }
  if (action) {
    const button = document.createElement("button")
    button.type = "button"
    button.setAttribute("data-button", "")
    button.textContent = action.label
    button.addEventListener("click", () => {
      action.onClick()
      remove()
    })
    card.append(button)
  }
  const close = document.createElement("button")
  close.type = "button"
  close.setAttribute("data-close-button", "")
  close.setAttribute("aria-label", "Close toast")
  close.innerHTML = CLOSE_GLYPH
  close.addEventListener("click", remove)
  card.append(close)

  list.append(card)
  const duration = durationOf(toast)
  if (Number.isFinite(duration)) window.setTimeout(remove, duration)
}

/*
 * ---------------------------------------------------------------------------
 * The entry points
 * ---------------------------------------------------------------------------
 */

/**
 * Mounts the toaster and starts loading its React half. Idempotent, and cheap
 * enough to call from `notify`.
 *
 * The host, its shadow root and stylesheet are created at once; React and
 * Sonner arrive with the import. Only two callers reach it — the first message
 * (`notify`) and the prewarm at idle after the first input
 * (`prepareToasterOnFirstInput`) — so it never runs on the boot path.
 */
export function installToaster(): () => void {
  transition({ type: "install" })
  return destroy
}

/**
 * Loads the React half ahead of the first message, once one is likely.
 *
 * The first card used to wait for React to load at all — measured ~27ms from
 * a click to its card, against ~1ms for every card after it. A toast
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
  transition({ type: "destroy" })
}

/**
 * Say something. The one entry point — see the header for who reaches it.
 */
export function notify(message: ToastMessage, kind: ToastKind = "info", action?: ToastAction): void {
  const content = splitToast(message)
  if (!content.title) return
  installToaster()
  const toast: Toast = { content, kind, action }
  switch (toaster.phase) {
    case "ready":
      emit(toaster.view.sonner, toast)
      return
    case "failed":
      showFallback(toaster.list, toast)
      return
    case "loading":
      toaster.queue.push(toast)
      return
  }
}

/**
 * Takes back a card raised with an `id`, whether it is showing or still queued.
 *
 * For notices about a state that can end before the card would: "Waiting for
 * the app…" is raised on a timer during boot, and once the editor is up (or
 * has given up) a card still saying it is waiting is wrong.
 */
export function retract(id: string): void {
  switch (toaster.phase) {
    case "loading": {
      const { queue } = toaster
      for (let i = queue.length - 1; i >= 0; i -= 1) if (queue[i].content.id === id) queue.splice(i, 1)
      return
    }
    case "ready":
      toaster.view.sonner.dismiss(id)
      return
    case "failed":
      for (const card of [...toaster.list.children]) if ((card as HTMLElement).dataset.id === id) card.remove()
      return
  }
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
