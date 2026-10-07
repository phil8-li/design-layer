/**
 * The app chooser: the name of the thing being edited, and the menu that
 * changes it.
 *
 * Every other surface in this editor is a view of ONE app — the tree lists its
 * elements, the inspector describes one of them, the audit reports on all of
 * them. Until this control existed, the name of that app appeared nowhere, and
 * the only way to point the editor at a different one was the toolbar's "Choose
 * app" anchor, which navigated away to the start screen and left you to pick
 * again from scratch. That is a strange shape for the most consequential
 * control in the chrome: the one thing that decides what everything else is
 * about was also the one thing you could only change by leaving.
 *
 * So it is a button that names the app and a menu that lists the alternatives,
 * and the menu IS the chooser — the rows are the running prototypes and
 * switching happens on click, with no intermediate screen. The start screen is
 * still what actually performs the swap, because it owns the supervisor that
 * can kill this editor and spawn the next one; the difference is that the
 * designer never sees it as a place they have to visit.
 *
 * ## Why the menu is not a child of the panel
 *
 * `.de-panel` is `overflow: hidden` and the trigger sits at the very top of a
 * 240px column, so a menu mounted beside it would be clipped by its own
 * container on both axes — the rows past the fold would simply not exist.
 *
 * `context.slots.overlay` is the obvious escape hatch and is the WRONG one
 * here, which is the single place this file departs from what it was asked for.
 * `css/base.ts` orders the shell's layers inside `.de-root`: the overlay is
 * `z-index: 1` and the rail holding both panels is `z-index: 2`. A positioned
 * element with a z-index establishes a stacking context, so nothing appended to
 * the overlay can paint above the rail no matter what z-index it asks for — and
 * `.de-panel` has an opaque `background`. The menu would have been perfectly
 * unclipped and perfectly invisible, hidden behind the panel it drops out of.
 *
 * `document.body` with a z-index above `.de-root` is what the other popover
 * launched from this panel already does — see `.de-asset-details` in
 * `css/assets.ts`, which escapes the same clip for the same reason. Reusing its
 * answer keeps one pattern for "a panel control opened a floating card" rather
 * than two, and it is the only mount point in this document from which the card
 * can be both unclipped and on top.
 *
 * ## Why a network failure on the switch is USUALLY the success path
 *
 * The POST asks the start screen to start another app, and the first thing the
 * supervisor does once it accepts is SIGTERM this editor — which is the process
 * serving the proxy this page is loaded from and the route the POST is in
 * flight to. So the happy path frequently ends with a dropped connection and no
 * response at all. Treating that as an error would show a failure message on
 * every successful switch.
 *
 * What that reasoning could not do was tell the supervisor killing us apart
 * from a loopback fetch that failed for any other reason — a proxy restarting
 * under a config change, a laptop that slept mid-request, an abort. Read as
 * success, those put "Starting X…" on screen over an editor that is working
 * perfectly, held the menu open against Escape, and only gave up when a
 * fifteen-second death budget expired. The avoided error was cosmetic; the
 * false positive blocked the whole editor.
 *
 * So a dropped connection asks one more question before it commits to the
 * story, and the question is exactly the thing that distinguishes the two
 * cases: `proxyAlive()`. No answer means the process serving this page is gone,
 * which only the supervisor can have done, and the handover proceeds. An answer
 * means nothing was killed, so nothing switched, and the ordinary failure path
 * reports it. A JSON error body is a third animal entirely: the server is alive
 * and declining, so that one is reported and nothing navigates.
 *
 * ## Why one of the two row kinds arms before it goes
 *
 * An `editor` row is a navigation to a proxy that is already serving. An `app`
 * row asks a supervisor to SIGTERM this process and bind a replacement to its
 * port, then waits the handover out — and if the replacement never binds there
 * is nothing to come back to.
 *
 * Both of them end this document, and ending this document ends the three
 * queues that hold unapplied edits: the removal queue, the Angular queue and
 * the vendor store are all in memory, and nothing in this package writes a
 * `beforeunload`. This file used to argue that a switch costs nothing because
 * the pinned notes and the preview-only ledger are filed per app. That is true
 * of those two and only those two, and the sentence was read as though it
 * covered everything a designer might be holding. It does not.
 *
 * So the confirm is spent where it buys most and costs least. The `app` row
 * arms, and only when `hasPendingChanges()` says there is something to lose:
 * the common empty session keeps its single click, because a navigation that
 * answers the first click with a question has to be performed twice every time,
 * and the second click appears exactly when the loss is real. The `editor` row
 * keeps its single click even with work outstanding, because it is the
 * reversible one — the editor you land on lists the one you came from, so the
 * way back is one more press of the same control, whereas a failed handover
 * leaves no control at all. The edits are gone on both paths, which is worth
 * knowing and is written down here rather than argued away.
 */

import { createApply } from "../core/apply"
import { readScoped, writeScoped } from "../core/app-scope"
import { config } from "../core/config"
import { el } from "../core/dom"
import { focusControl } from "../core/focus"
import { icon } from "../core/icons"
import { arriveFrom, playExit } from "../core/motion"
import { tokens } from "../core/tokens"
import { tip } from "../core/tooltip"
import type { EditorContext } from "../core/context"
import { plural } from "../core/format"

/**
 * One row of the chooser, and there are two kinds of them.
 *
 * `editor` is an app that already has an editor of its own running on this
 * machine, discovered through the registry in `runtime/editor-registry.mjs`.
 * `target` is that editor's proxy, and switching to it is a NAVIGATION — the
 * editor is already up, so there is nothing to start, nothing to kill and
 * nothing to wait for. This used to say the tab's queued work was not at risk
 * either, "because this tab is not the one being replaced". The PROCESS is not,
 * but the document is, and the queues live in the document; see the header.
 * What survives is the way back, which is why this is the kind that does not
 * arm.
 *
 * `app` is a running dev server with no editor pointed at it. Only the start
 * screen can find those and only a supervisor can act on one, so `target` is
 * null and switching means the slower path: ask the screen, let it replace this
 * editor, wait out the handover.
 */
interface RunningApp {
  kind?: "editor" | "app"
  /**
   * Nullable, which this said it was not.
   *
   * `appRow` and `editorRow` in `server/apps.mjs` both write
   * `typeof x === "number" ? x : null`, so a scan that found a server without
   * reading a port off it sends `null` — and this interface promised a number,
   * so nothing on this side was obliged to check. Nothing read the field until
   * `portOf` did, which is the only reason it never printed.
   */
  port: number | null
  url: string
  title: string
  projectRoot: string | null
  packageName: string | null
  /** Another editor's proxy, for a row that is reached by going there. */
  target?: string | null
}

/**
 * The whole answer, including the way it can decline to list anything.
 *
 * `error` is a 200 in the contract, because "the machine that knows what is
 * running is not answering" is a fact about a session rather than a fault, and
 * a menu that renders an answer is worth more than one that renders a failed
 * request.
 *
 * There used to be a `chooser` flag here as well, and the menu branched on it
 * to say the session had been started without an app chooser. The server still
 * sends it and this side no longer reads it: whether a start screen is behind
 * the session decides what can be STARTED, and says nothing about whether there
 * is anything to switch to — editors find each other through the registry with
 * no screen anywhere. Branching on it put "there is nothing to switch between"
 * inside the very control the reader had just opened.
 */
interface AppsResponse {
  apps?: RunningApp[]
  error?: string
}

const CHOOSER = {
  empty: "Choose an app",
  looking: "Looking for running apps\u2026",
} as const

/** Clear of the viewport edge, and the gap under the trigger. Both from the menu's own vocabulary. */
const EDGE = 8
const GAP = 4

/**
 * An id no other element in this document already has.
 *
 * A plain counter was not enough, and the way it failed is worth writing down
 * because nothing about it is visible. A counter is per MODULE, and a module
 * can be instantiated more than once in one document — two bundles built
 * against two different configs, which is exactly how the suites compare a
 * session that knows its app against one that does not. Both counters start at
 * zero, both controls claim `de-app-menu-1`, and `getElementById` hands the
 * second trigger the FIRST trigger's menu. Everything then works except that
 * one control opens a menu nobody can see while the other holds rows nobody
 * asked for, and no assertion about either of them reads as wrong.
 *
 * Asking the document is the only check that cannot be fooled by that, because
 * the document is the thing the id has to be unique in.
 */
let sequence = 0

function freeMenuId(): string {
  let candidate = `de-app-menu-${++sequence}`
  while (document.getElementById(candidate)) candidate = `de-app-menu-${++sequence}`
  return candidate
}


/**
 * The project folder a running app was started from, as a word rather than a
 * path.
 *
 * Split on both separators because the editor's browser half has no `path`
 * module and no idea which platform the server is on — a Windows host answers
 * `C:\work\shop` and the same code has to name the same folder. Trailing
 * separators are dropped by the filter so `/work/shop/` is still `shop`.
 */
function folderName(path: string): string {
  const parts = path.split(/[/\\]+/).filter((part) => part.length > 0)
  return parts[parts.length - 1] ?? path
}

/** Enough of a check that a cache written by an older build cannot draw a broken menu. */
function isRecordLike(value: unknown): value is AppsResponse {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The only part of a row's address that is worth printing.
 *
 * Every app this editor can point at is on loopback — the config reader and the
 * start screen each refuse anything else — so `http://` and the host are the
 * same characters on every row in the card, and a reader comparing two rows is
 * comparing the last four digits of two otherwise identical strings. The port
 * is also the part that carries identity: two checkouts of one project share a
 * package name and differ only here.
 *
 * Read off the url rather than off `app.port`, because the url is what the row
 * is ABOUT and the two can disagree — `server/apps.mjs` types the port as
 * `number | null` while the interface here promises a number, so the field is
 * the one of the two that can arrive empty. An unparseable url falls back to
 * it, and a row with neither says nothing rather than saying `null`.
 */
function portOf(app: RunningApp): string {
  try {
    const listed = new URL(app.url).port
    if (listed) return listed
  } catch {
    // Not a url this browser can parse, so there is no port to read out of it.
  }
  return typeof app.port === "number" ? String(app.port) : ""
}

/**
 * What a row calls an app: its package, then its title, then the folder it was
 * started from, and only then the url it answers on.
 *
 * The folder step is the one that was missing, and the row it fixes is the
 * commonest kind there is. `editorRow` in `server/apps.mjs` hardcodes an empty
 * title — the registry has no reason to know what the served page calls itself
 * — so an editor row with no `package.json` name fell all the way through to
 * its url, and the line underneath it opens with that same url. The row printed
 * one string twice and gave the reader nothing to choose on. The folder is a
 * word a person picked, which is more than can be said for `127.0.0.1:5173`.
 */
function appLabel(app: RunningApp, folder: string | null): string {
  return app.packageName || app.title || folder || app.url
}

/** How much is at stake, for the sentence on an armed row. */
function changeWord(count: number): string {
  return plural(count, "unapplied change")
}

/**
 * Whether a listed app is the one this editor is already pointed at, compared
 * by PORT rather than by string.
 *
 * The two answers are built by different machines and spell loopback
 * differently. The prelude names the app `http://127.0.0.1:<port>`, because
 * that is the address the proxy was aimed at; the scanner names it whichever of
 * `127.0.0.1` and `[::1]` answered first, and on an IPv6-first machine a `vite`
 * or `ng serve` binding the NAME `localhost` answers only on the second. So a
 * string compare marks nothing as current on exactly the machines where the
 * scanner had to work hardest to find the app at all.
 *
 * The port is the part that cannot be spelled two ways. Both sides are loopback
 * by construction — the config reader and the start screen each refuse anything
 * else — so two loopback urls sharing a port are the same server, and there is
 * nothing left for the host to disambiguate.
 */
function isCurrentApp(app: RunningApp, currentUrl: string | null): boolean {
  if (!currentUrl) return false
  if (app.url === currentUrl) return true
  try {
    const listed = new URL(app.url)
    const current = new URL(currentUrl)
    return listed.protocol === current.protocol && listed.port === current.port
  } catch {
    return false
  }
}


export function installAppChooser(context: EditorContext): {
  node: HTMLElement
  destroy(): void
} {
  const menuId = freeMenuId()
  const current = config.app
  const named = typeof current.name === "string" && current.name.length > 0

  /*
   * The name and the ghost instruction are the same span in the same shape.
   *
   * A control that is a button when it has a value and a line of hint text when
   * it does not is two controls, and the second one is the state a new session
   * opens in — so the chevron is drawn in both, and the empty state differs by
   * one modifier class that only changes the ink. Nothing about the box moves.
   */
  const nameNode = el("span", { class: "de-app-chooser-name" }, [
    named ? (current.name as string) : CHOOSER.empty,
  ])
  /*
   * The one surface in this editor that shows the name in full.
   *
   * The band is `size.sectionHeader` tall and one line wide, so it has to
   * truncate — but two checkouts of one project, or two branches of one, differ
   * in the TAIL of the name, which is the part the ellipsis eats. Until this
   * was here, a reader looking at `@acme/design-system-play…` had nowhere in
   * the chrome to find out which of the two they were editing, and that is the
   * single question this control exists to answer.
   *
   * The project's own tip rather than `title`: it is delegated from the
   * document, so a node built here is covered without a listener, and it paints
   * above the menu by construction. `tip` deliberately leaves `aria-label`
   * alone, and the button's own label already carries the whole name, so a
   * screen reader was never the audience for this fix.
   */
  if (named) tip(nameNode, current.name as string)

  const trigger = el(
    "button",
    {
      class: `de-app-chooser${named ? "" : " de-app-chooser--empty"}`,
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-controls": menuId,
      // Names the app AND what pressing does. "Choose app" alone would leave a
      // screen reader user with no way to hear which app they are editing, and
      // the name alone would read as a heading rather than as a control.
      "aria-label": named
        ? `Editing ${current.name}. Choose a different app`
        : CHOOSER.empty,
    },
    [nameNode, icon("ChevronDown", tokens.icon.marker)]
  )

  const menu = el("div", {
    class: "de-app-menu",
    id: menuId,
    role: "menu",
    "aria-label": "Running apps",
    style: "display:none",
  })
  document.body.append(menu)

  let isOpen = false
  /** Set while a menu is opened from the keyboard and its rows have not arrived yet. */
  let focusFirstOnLoad = false
  /** True from the first accepted click until the page is replaced. Rows go dead. */
  let switching = false
  /** The navigation is one-way and must not be attempted twice. */
  let leaving = false
  /**
   * The menu is holding the only explanation of a handover in progress, so it
   * refuses to be dismissed.
   *
   * Separate from `leaving`, and the split is the fix for a control that could
   * become undismissable over a session that was never in any danger. `leaving`
   * says the page is going somewhere and must not be sent twice; this says the
   * reader is not allowed to close the card. The first is permanent by nature.
   * The second is a claim about the next few seconds, and it is stood down the
   * moment the claim stops being true.
   */
  let pinned = false
  /** Torn down. The handover wait reads it, because it outlives the element. */
  let destroyed = false
  /**
   * The last answer this machine gave, seeded from storage so that the FIRST
   * open of a session is warm too — including the open right after an app
   * switch, which is a reload, and which is exactly when someone who has just
   * used this menu is most likely to use it again.
   */
  let cached: AppsResponse | null = null
  /**
   * Which `GET /apps` the menu is currently showing. A menu closed and reopened
   * before the first request settles would otherwise paint the stale answer
   * over the fresh "looking" line.
   */
  let request = 0

  const rows = (): HTMLButtonElement[] =>
    Array.from(menu.querySelectorAll<HTMLButtonElement>(".de-app-menu-row"))

  /**
   * Whether the arrow keys are allowed to stop on a row.
   *
   * Two rows are unpressable and only one of them is skipped, which looks
   * inconsistent and is the whole point. A row killed by a switch in flight has
   * nothing to say — it is the same row it was a second ago and it will be that
   * row again if the switch is refused — so walking onto it wastes a keystroke.
   * A row with no project folder behind it is unpressable for a REASON, and the
   * reason is written into its `aria-label`; skipping it makes that reason
   * reachable by pointer users only, who are the ones who could already read it
   * off the second line. So it stays in the walk and simply refuses to act.
   */
  const walkable = (row: HTMLButtonElement): boolean =>
    row.classList.contains("de-app-menu-row--unplaced") ||
    row.getAttribute("aria-disabled") !== "true"

  /**
   * Moves focus between rows, wrapping, and skipping any that a switch in
   * flight has already killed.
   *
   * A roving tabindex rather than a focusable list: one tab stop for the whole
   * menu means Tab LEAVES it instead of walking it, which is what `role="menu"`
   * promises a keyboard user and the arrow keys then deliver.
   */
  const focusRow = (index: number): void => {
    const live = rows().filter(walkable)
    if (live.length === 0) return
    const target = live[(index + live.length) % live.length]
    for (const row of live) row.tabIndex = row === target ? 0 : -1
    focusControl(target)
  }

  /**
   * A sentence where the rows would be.
   *
   * `role="menuitem"` with `aria-disabled`, rather than the bare `<div>` this
   * started as. Most of the menu's states are a note and nothing else —
   * looking, nothing else running, the request failed — and a `<div>` is not a
   * permitted child of `role="menu"`: a screen reader walking the menu's
   * children is entitled to drop it, which would announce those states as an
   * empty menu. The disabled menu item is the standard way to say "there is one
   * thing here and it is not actionable", and it stays out of the arrow keys'
   * way for free, because `focusRow` walks `.de-app-menu-row` and this is not
   * one.
   */
  const note = (text: string): HTMLElement =>
    el(
      "div",
      { class: "de-app-menu-note", role: "menuitem", "aria-disabled": "true", tabindex: "-1" },
      [text]
    )

  /**
   * The one node in this card that is never replaced, so that a sentence
   * written into it is a sentence a screen reader hears.
   *
   * A live region only announces changes that happen INSIDE it while it is
   * already in the document. Every state of this menu used to arrive as a fresh
   * subtree handed to `replaceChildren`, which is exactly the mutation a live
   * region cannot report — so the handover sentence, the failure sentence and
   * the empty state were all silent, and a screen-reader user watched an open
   * menu say nothing at all while their editor was being killed.
   *
   * The note lives in here rather than beside it. A separate hidden region
   * would mean the same sentence written twice, visible in one copy and
   * inaudible in the other, and the first time they disagreed nobody would
   * notice. `role="status"` is not a permitted child of `role="menu"` and this
   * is the honest cost of the fix: the wrapper is a generic in the tree the
   * menu owns. Set against a control that announced none of its states, a
   * wrapper around a `menuitem` is the smaller problem.
   */
  const liveRegion = el("div", { class: "de-app-menu-live", role: "status" })

  /**
   * The menu's whole content, replaced wholesale — it is never partially right.
   *
   * Focus is the half that is easy to forget. Replacing the children detaches
   * whatever was focused and the browser drops focus to `<body>`, which for the
   * two notes written mid-switch means the row the reader just pressed vanishes
   * and takes their place in the document with it. If the menu held focus, the
   * note takes it: the note is the only thing left in the card and it is
   * carrying the explanation. If focus was somewhere else entirely, it stays
   * there and the live region does the telling.
   */
  const showNote = (text: string): HTMLElement => {
    const held = menu.contains(document.activeElement)
    const node = note(text)
    liveRegion.replaceChildren(node)
    menu.replaceChildren(liveRegion)
    if (focusFirstOnLoad || held) {
      focusFirstOnLoad = false
      focusControl(node)
    }
    return node
  }

  /**
   * Measured after mount, because the row count decides the height.
   *
   * Clamped on both axes for the reason the layer stack is: a menu that opens
   * past the viewport edge is a menu with entries nobody can reach. The flip to
   * above the trigger is the one thing the layer stack does not need — it opens
   * at the pointer, which is never pinned to the top of a panel, while this one
   * always is and would drop off the bottom of a short window every time.
   *
   * `getBoundingClientRect` is called through `?.` for the same reason
   * `scrollIntoView` is everywhere else in this codebase: the suites drive this
   * file under jsdom, where a layout is a polite fiction.
   */
  const position = (): void => {
    const anchor = trigger.getBoundingClientRect?.()
    const box = menu.getBoundingClientRect?.()
    if (!anchor || !box) return
    const left = Math.max(
      EDGE,
      Math.min(anchor.left, window.innerWidth - box.width - EDGE)
    )
    /*
     * The height this measurement is allowed to believe.
     *
     * The card carries a `max-height` of the viewport less both edges and
     * scrolls past it, so a measured box can never legitimately exceed that —
     * but the two sides of that agreement live in different files, and the
     * arithmetic below is the half that goes wrong quietly. A card believed to
     * be taller than the window fails the `below` test, flips above the trigger,
     * clamps to `EDGE`, and lands in the one position where the rows nearest the
     * trigger are the ones off screen. Clamping here means the flip is decided
     * on a height the card can actually have.
     */
    const height = Math.min(box.height, Math.max(0, window.innerHeight - EDGE * 2))
    const below = anchor.bottom + GAP
    const flipped = below + height > window.innerHeight - EDGE
    const top = flipped ? Math.max(EDGE, anchor.top - height - GAP) : below
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
    // The flip is decided here and nowhere else, so the entrance is aimed here
    // too: a card that ends up above the chooser has to grow out of its bottom
    // edge and settle upward, or it opens travelling away from the control that
    // was just pressed. See `arriveFrom`.
    arriveFrom(menu, flipped ? "above" : "below")
  }

  /** The list the last close took down, kept for an open that would draw the same one. */
  let parked: { signature: string; nodes: Node[] } | null = null
  /** Whether the card has a measured place to reopen at, and the frame that re-checks it. */
  let positioned = false
  let positionFrame = 0

  /**
   * Is anything in this document holding an edit that has not reached source.
   *
   * The committer rather than a local copy of the same three checks. This file
   * used to answer the question in prose and get it wrong: it argued that a
   * switch costs nothing because the pinned notes and the preview-only ledger
   * are filed per app, which is true, and never asked about the removal queue,
   * the Angular queue or the vendor store, which are filed nowhere at all.
   * `createApply` is where "is there unapplied work" is defined for the Apply
   * button and the Changes tab; reading it here is the only version of this
   * that cannot drift away from them a second time. It is never asked to
   * commit anything — the two counts are the whole of what this control wants.
   */
  const committer = createApply({ bridge: context.bridge, toast: context.toast })

  /**
   * The row waiting for its second click, and the way back from it.
   *
   * Arming is painted directly onto the row rather than through `render`,
   * exactly as the annotations tab's clear-all does it: arming changes nothing
   * in any store, and repainting the whole list to move one sentence would
   * throw away the rows the reader is looking at mid-decision. `restore` is the
   * row's own closure over its resting strings, so nothing here has to know
   * what a row says.
   */
  const ARMED_MS = 6000
  let armedRow: HTMLButtonElement | null = null
  let armedTimer = 0
  let restoreArmedRow: (() => void) | null = null

  const disarm = (): void => {
    if (armedTimer) {
      window.clearTimeout(armedTimer)
      armedTimer = 0
    }
    const restore = restoreArmedRow
    armedRow = null
    restoreArmedRow = null
    restore?.()
  }

  const close = (restoreFocus = false): void => {
    if (!isOpen) return
    /*
     * A handover in progress pins the menu open.
     *
     * It is holding the only sentence on screen that explains why the app is
     * about to stop responding, and every ordinary way of dismissing it —
     * Escape, a click on the page, the window losing focus while the other
     * process starts — is something a person does reflexively in the seconds
     * this takes. Letting any of them through would leave a page that freezes
     * and then reloads with nothing having said what happened.
     *
     * `pinned` rather than `leaving`, which is what this used to read. The two
     * are the same thing right up until the handover does not happen, and then
     * they are opposites: `leaving` never clears, so a switch that was accepted
     * and then failed to take left a working editor under a card that could not
     * be closed by any means the reader has. The pin is released the moment
     * this page can prove the switch did not happen — see `settleIntoNewEditor`.
     */
    if (pinned) return
    isOpen = false
    focusFirstOnLoad = false
    disarm()
    // Closed at once, faded on a copy. A card left in the document to play an
    // exit is a card that still absorbs the next Escape, and this one is
    // dismissed by Escape more than by anything else — so the real card goes
    // now and an inert clone plays the kit's 150ms dismissal. See `playExit`.
    playExit(menu)
    menu.style.display = "none"
    parked =
      shownSignature !== null && rows().length > 0
        ? { signature: shownSignature, nodes: Array.from(menu.childNodes) }
        : null
    menu.replaceChildren()
    shownSignature = null
    trigger.setAttribute("aria-expanded", "false")
    if (restoreFocus && trigger.isConnected) focusControl(trigger)
  }

  /**
   * A row that is the app you are already editing does nothing but close.
   *
   * Not disabled, because it is the one row that answers the question the menu
   * was opened to ask — "which one am I on" — and a disabled control is a
   * control you are told not to read. Switching to it would be a real switch:
   * the supervisor would kill this editor, spawn another on the same app, and
   * the session's unapplied work would be gone in exchange for nothing.
   */
  const rowFor = (app: RunningApp): HTMLButtonElement => {
    const isCurrent = isCurrentApp(app, config.app.url)
    /*
     * A row backed by a live editor is always switchable, whatever else is
     * missing from it: the destination is a URL that is already serving, so the
     * folder question below cannot arise.
     */
    const target = typeof app.target === "string" && app.target.length > 0 ? app.target : null
    const folder =
      typeof app.projectRoot === "string" && app.projectRoot.length > 0
        ? folderName(app.projectRoot)
        : null
    const label = appLabel(app, folder)
    /*
     * An app the scanner found but could not place on disk.
     *
     * `scanLocalApps` reads the project folder out of the paths a dev server
     * writes into its own page, and falls back to asking `lsof` which directory
     * the process was started in. Both can come up empty — a server that names
     * no paths, run from a machine where `lsof` is refused — and the row is
     * still worth drawing, because the app is genuinely there and its absence
     * from the list would be the stranger answer.
     *
     * What it must not do is offer to switch. The editor rewrites source files,
     * so without a folder there is nothing for it to edit, and the request is
     * refused by `server/apps.mjs` with a 400 the moment it arrives.
     */
    const placed = target !== null || folder !== null
    /*
     * The row's second fact, and in the ordinary case it is four characters.
     *
     * It used to be a whole line of prose: the full url, a middle dot, and then
     * either the project folder or a clause naming the row's kind. Three facts
     * stacked on two lines, in a control whose entire question is "which app am
     * I editing, and what else could I edit". The scheme and the host were the
     * same string on every row — loopback is the only thing this editor can be
     * pointed at — so the only part of that url which ever differed between two
     * rows was the port, and the port is also the part that tells two checkouts
     * of one project apart. The rest was drawn once per row and read never.
     *
     * The folder went with it and is not mourned. It survives where it was
     * always doing the work: as `appLabel`'s fallback NAME for a row that has
     * no package and no title. A row already called `sketch` never needed a
     * second line saying it lives in `sketch`, which is why the old code had to
     * special-case exactly that.
     *
     * The "source folder not found" clause keeps its meaning and loses its
     * sentence. That row is the one row where a press does nothing, so it has
     * to say so before it is pressed — but the port it would otherwise show is
     * the one thing it has no use for, because there is nothing to disambiguate
     * on a row that cannot be opened. So the slot says the other thing instead.
     */
    const meta = placed ? portOf(app) : "No project folder"
    const ariaLabel = isCurrent
      ? `${label}, the app you are editing`
      : target
        ? `Go to ${label}, which already has an editor running`
        : placed
          ? `Switch to ${label}`
          : `${label}. Project folder not found, so it cannot open from here`

    /*
     * The name wraps here, and carries no `title`, which is the opposite of
     * what the TRIGGER does with the same string.
     *
     * The two boxes have different room and so take different answers. The
     * trigger is a `size.sectionHeader` band one line tall with a chevron to
     * make space for, so it truncates and hands the tail to `tip()`. A row is
     * inside a card that may be 340px wide and has no fixed height at all, so
     * the whole name simply fits, on a second line when it has to. Nothing is
     * hidden, so there is nothing for a tooltip to reveal — and a `title` on a
     * row whose text is already complete is a card that opens over the list to
     * repeat what the reader is looking at.
     *
     * The second span is still spelled `--where` after its content stopped
     * being a location, and the rename was skipped on purpose: it is a class
     * name, it is read by `tools/chrome-demo.mjs` outside this lane's files,
     * and a port IS where the app is. The variable says what it holds.
     */
    const nameLine = el("span", { class: "de-app-menu-name" }, [label])
    const metaLine = el("span", { class: "de-app-menu-where" }, [meta])
    /*
     * The mark that tells a navigation from a process swap, in place of the
     * clause that used to.
     *
     * The distinction is real and load-bearing: an `editor` row moves the page
     * to a proxy that is already serving, and an `app` row asks a supervisor to
     * SIGTERM this editor and gamble on a replacement binding. Before either
     * kind said anything, they were the same row down to the verb in the
     * `aria-label`, and the fix at the time was a clause — `editor already
     * running` — which is four words spent once per row on a fact the reader
     * only needs in order to answer one question: is pressing this cheap.
     *
     * An arrow answers that question and costs no line. It says "this one just
     * goes there", which is exactly what the row does and exactly what the
     * accessible name has said all along. `ArrowRight` rather than the chevron
     * the trigger wears: a trailing chevron inside `role="menu"` is the APG's
     * mark for a SUBMENU, and promising a submenu to a keyboard user who then
     * finds a page navigation is a worse trade than the clause was.
     */
    const row = el(
      "button",
      {
        class: `de-app-menu-row${isCurrent ? " de-app-menu-row--current" : ""}${
          placed || isCurrent ? "" : " de-app-menu-row--unplaced"
        }`,
        type: "button",
        role: "menuitem",
        tabindex: "-1",
        "aria-current": isCurrent ? "true" : undefined,
        "aria-label": ariaLabel,
      },
      target ? [nameLine, metaLine, icon("ArrowRight", tokens.icon.marker)] : [nameLine, metaLine]
    )
    /*
     * `aria-disabled`, and the guard in the handler below is what actually
     * refuses the click.
     *
     * Native `disabled` was here, and it took the row out of the accessibility
     * tree along with the `aria-label` that is the only place the reason lives.
     * The whole argument for drawing this row at all is that the app is running
     * and the reader deserves to know why it cannot be opened — and `disabled`
     * delivered that explanation to precisely the people who could already read
     * it off the second line, while hiding it from the ones who could not. It
     * stays in the arrow-key walk for the same reason; see `walkable`.
     */
    if (!placed && !isCurrent) row.setAttribute("aria-disabled", "true")

    row.addEventListener("click", () => {
      if (switching) return
      if (isCurrent) {
        close(true)
        return
      }
      if (!placed) return
      /*
       * An editor of its own is already running, so this is a link.
       *
       * No POST, no waiting for a process to die and another to bind, no
       * handover note, and no armed step — the page goes there, the way
       * clicking any link goes anywhere, and the editor it lands on lists this
       * one, so the way back is one press of the same control.
       */
      if (target) {
        void goTo(target, label)
        return
      }
      /*
       * One click when there is nothing to lose, two when there is.
       *
       * The single click is right and stays right for the common case: picking
       * an app off a list is a navigation, the same gesture as clicking a layer
       * or a tab, and a navigation that answers the first click with a question
       * has to be performed twice every time — including the overwhelming
       * majority of times when the session is holding nothing at all.
       *
       * What the old version of this comment got wrong was the other case. It
       * claimed the switch had been made free, on the strength of the pinned
       * notes and the preview-only ledger moving to per-app storage. They did.
       * The removal queue, the Angular queue and the vendor store did not, and
       * a supervisor SIGTERM takes all three with the document. So the click
       * arms when `hasPendingChanges()` says so, names the number it would
       * cost, and stands itself down after six seconds — the same control, the
       * same window and the same reasoning as clearing every note in the
       * annotations tab.
       */
      if (armedRow !== row && committer.hasPendingChanges()) {
        disarm()
        /*
         * At least one, because the two questions are answered by different
         * machinery. `hasPendingChanges` is the vendor store's own boolean;
         * `pendingCount` asks it to build the operations a commit would send
         * and falls back to the removals alone when it cannot. A store that
         * says yes and then declines to count is rare and real, and "0
         * unapplied changes will be lost" would be the one sentence here that
         * argues for pressing on.
         */
        const owed = Math.max(1, committer.pendingCount())
        armedRow = row
        restoreArmedRow = () => {
          row.classList.remove("de-app-menu-row--danger")
          metaLine.textContent = meta
          row.setAttribute("aria-label", ariaLabel)
        }
        armedTimer = window.setTimeout(disarm, ARMED_MS)
        row.classList.add("de-app-menu-row--danger")
        /*
         * The row names the OUTCOME of the next click rather than asking a
         * question: "Switch anyway?" is the same instruction twice by the time
         * the toast has said what is at stake.
         *
         * It used to add "Switch anyway" and "will be lost" around that
         * outcome, which is a sentence where a figure goes — and the slot it
         * lands in is the one that otherwise holds four digits, so every word
         * in it is width taken off the name beside it. The verb and the count
         * are the whole of what the second press costs; the toast one line
         * away carries the instruction, and the accessible name below still
         * carries both in full for a reader who cannot see the fill.
         */
        metaLine.textContent = `Discards ${changeWord(owed)}`
        row.setAttribute("aria-label", `Switch to ${label} anyway. ${changeWord(owed)} will be lost.`)
        // The default rung, not `error` — `DURATION.error` is `Infinity`, and a
        // card that never dismisses outlives the `ARMED_MS` window it is
        // describing. The row disarms after six seconds and the card would go
        // on instructing a second click that now re-arms instead of switching.
        // The same correction is made, for the same reason, on the notes tab's
        // Clear all.
        context.toast({
          title: `Switching discards ${changeWord(owed)}`,
          description: `Click again to go to ${label} anyway.`,
        })
        return
      }
      disarm()
      // The row is handed over so the handover can be reported in it — see
      // `reportSwitching`. It is the one row the user pressed, and the only one
      // with anything to say.
      void switchTo(app, label, row)
    })

    return row
  }

  /**
   * Every row goes dead the moment one of them is accepted; a second choice
   * cannot be queued.
   *
   * Re-enabling skips the rows that were never switchable in the first place.
   * A refused switch puts the menu back the way it was, and "the way it was"
   * included an app with no project folder sitting there unpressable — waking
   * it on the way back would turn a failed switch into a row that now offers a
   * switch guaranteed to fail.
   *
   * `aria-disabled` plus a class, not the native attribute. A native `disabled`
   * on the row the reader just pressed makes that row unfocusable in the same
   * frame, and the browser answers by dropping focus to `<body>` — so the
   * keyboard user's reward for choosing an app is to be thrown to the top of
   * the document while the switch they asked for is still in flight. The class
   * carries `pointer-events: none`, which is the half the pointer needs and the
   * half a keyboard must not have.
   */
  const setRowsDisabled = (disabled: boolean): void => {
    for (const row of rows()) {
      const unplaced = row.classList.contains("de-app-menu-row--unplaced")
      if (!disabled && unplaced) continue
      row.classList.toggle("de-app-menu-row--busy", disabled)
      if (disabled) row.setAttribute("aria-disabled", "true")
      else row.removeAttribute("aria-disabled")
    }
  }

  /**
   * The row the user pressed reports its own handover, in the slot that
   * otherwise holds its port.
   *
   * ## Why there is no longer a height to pin
   *
   * This used to measure the row and write the measurement into `min-height`
   * before touching anything, and the pin was real work for a real problem: the
   * row was two lines, the second of them a wrapping url, so a phrase swapped
   * into it was one line for a short path and two for a long one and the card
   * resized under a pointer that was waiting for the page to be replaced.
   *
   * A one-line row has no such thing to protect. The slot is `flex: none` and
   * `white-space: nowrap` in the sheet, so whatever is written into it stays on
   * one line by construction, and the pin became a measurement taken on every
   * switch, written into an inline style, cleared on the failure path and
   * load-bearing nowhere. Dead code that measures something looks far more
   * necessary than dead code that does not, which is why it is called out here
   * rather than quietly removed.
   *
   * The constraint the pin existed for has not gone anywhere: the row must not
   * change height or line count while it is handing over. It is now the sheet's
   * job, and the phrase's — which is why the phrase is one word. The slot takes
   * its width out of the name beside it, and a phrase long enough to push a
   * long name onto a second line would move the card exactly as the old wrap
   * did.
   *
   * ## Why one phrase and not two
   *
   * There were two, "asking the supervisor" and then "waiting for it to come
   * up", named as the separately observable stages of the request. The second
   * one was never observable: `leave()` runs in the same task and replaces the
   * whole card with the handover note, so the row it was written into was
   * detached before a frame could paint it. One phrase, on the row, for as long
   * as the row exists; the sentence that covers the rest of the wait is the
   * note that replaces it.
   */
  const reportSwitching = (row: HTMLElement, phrase: string): void => {
    const slot = row.querySelector<HTMLElement>(".de-app-menu-where")
    if (!slot) return
    row.setAttribute("data-de-switching", "")
    slot.textContent = phrase
  }

  const switchTo = async (app: RunningApp, label: string, row?: HTMLElement): Promise<void> => {
    switching = true
    parked = null
    setRowsDisabled(true)
    if (row) reportSwitching(row, "Switching\u2026")

    let failure: string | null = null
    try {
      const response = await fetch(`${context.apiBase}/apps/switch`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        // `devScript: null` explicitly: the server picks the script it started
        // the app with, and an absent key would leave it guessing whether the
        // browser meant "use the default" or "the browser is an old build".
        body: JSON.stringify({ url: app.url, projectRoot: app.projectRoot, devScript: null }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null
        failure =
          typeof body?.message === "string" && body.message.length > 0
            ? body.message
            : refusedSentence(label)
      }
    } catch {
      /*
       * A dropped connection is the supervisor killing this process — usually.
       * See the header: the difference between "we are being killed" and "that
       * fetch just failed" is observable, and asking costs one loopback round
       * trip on a gesture that was about to end the page anyway.
       */
      failure = (await proxyAlive()) ? refusedSentence(label) : null
    }

    if (failure) {
      switching = false
      setRowsDisabled(false)
      // The row stops claiming a handover that is not happening. `showNote`
      // below replaces the card, so nothing on screen depends on this today —
      // it is here so that a later change which keeps the list up does not have
      // to remember a row left mid-switch.
      if (row) row.removeAttribute("data-de-switching")
      // Both, and not one or the other. The toast is what a designer looking at
      // the canvas will see; the note is what is still there a second later,
      // under the row they pressed, when they look back at the menu.
      showNote(failure)
      context.toast(failure, "error")
      return
    }

    leave(label)
  }

  /**
   * What a refused switch says, which is what to do rather than what broke.
   *
   * The status code used to be in here — `Could not switch apps (502)` — and a
   * status code in user copy is a number the reader cannot act on standing in
   * for the sentence that would have told them how. The two recoveries are
   * genuinely different, so the sentence is too: with a start screen there is
   * somewhere to go and start the app by hand, and without one the only thing
   * that works is running the command again.
   */
  const refusedSentence = (label: string): string =>
    config.chooserUrl
      ? `Could not switch to ${label}. Try again, or start it from ${config.chooserUrl}.`
      : `Could not switch to ${label}. Nothing was changed; try again.`

  /**
   * Whether an address answers at all, which for a loopback proxy is the whole
   * question.
   *
   * `no-store` because what is being asked is whether a server is on the other
   * end RIGHT NOW, and a cached 200 from the editor being replaced is the one
   * answer that would be wrong. Any response counts as alive — a proxy that is
   * up but still compiling the app answers 500, and it is still up.
   */
  const answers = async (url: string): Promise<boolean> => {
    try {
      await fetch(url, { cache: "no-store", headers: { accept: "application/json" } })
      return true
    } catch {
      return false
    }
  }

  /** The same question, asked of the proxy serving this page. */
  const proxyAlive = (): Promise<boolean> => answers(`${context.apiBase}/apps`)

  /**
   * Goes to an editor that is already running, having checked that it is.
   *
   * The registry sweeps for dead editors at READ time only, so a row is as
   * fresh as the last `GET /apps` and no fresher — and an editor killed in
   * between leaves a row that looks perfectly alive. Following it replaced a
   * working editor with the browser's own "site can't be reached" page, and
   * because the chooser goes with the document there was no route back except
   * typing the old address from memory.
   *
   * One round trip against the destination buys that back, on a gesture that
   * was about to cost a whole page load. A dead target drops the list rather
   * than the row: `shownSignature` is cleared so the refresh behind it is
   * allowed to repaint, since the answer that produced the stale row would
   * otherwise match the signature and be thrown away as "nothing changed".
   */
  const goTo = async (target: string, label: string): Promise<void> => {
    if (leaving || switching) return
    switching = true
    parked = null
    setRowsDisabled(true)
    const reachable = await answers(target)
    if (destroyed) return
    if (reachable) {
      leaving = true
      close()
      window.location.assign(target)
      return
    }
    switching = false
    setRowsDisabled(false)
    if (!isOpen) return
    const gone = `${label} is no longer running. Start it again, or choose another app.`
    showNote(gone)
    context.toast(gone, "error")
    shownSignature = null
    void load(true)
  }

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      window.setTimeout(resolve, ms)
    })

  /**
   * Waits out the handover and reloads in place, rather than sending the
   * designer back to the screen they came here to stop needing.
   *
   * The old behaviour was one line — navigate to the start screen and let it
   * forward — and it worked, because that page polls and redirects. What it
   * cost was the point of the whole control: picking an app from a menu inside
   * the editor put a full-page interstitial on screen anyway, so switching
   * still read as leaving and coming back rather than as changing what you are
   * looking at.
   *
   * TWO phases, and the first is what makes the second trustworthy. The
   * supervisor gives this editor a SIGTERM and then binds the next one to the
   * same proxy port — 3456 both times is the normal case — so a single "is it
   * up" poll would be satisfied immediately by the process that is about to
   * die, reload into it, and land on whatever it serves in its last moment.
   * Waiting for the port to go quiet FIRST is the only way this page can tell
   * the two apart from the outside.
   *
   * Every way out of the wait ends somewhere real. The port never dying means
   * the switch did not take; the port never coming back means the next editor
   * failed to start, and the start screen is the page that knows why, because
   * the supervisor reports the reason to it. Both fall through to the
   * navigation this replaced, so the worst case here is the behaviour that was
   * here before.
   *
   * And a port that never dies releases the pin. The card is held open against
   * Escape because it is explaining a page that is about to freeze; a page that
   * is demonstrably still answering after the whole death budget is a page
   * nothing is happening to, and holding a card over it is no longer protecting
   * anything. Fifteen seconds of an undismissable surface over a working editor
   * is a worse failure than the one the pin was avoiding.
   */
  const DEATH_BUDGET_MS = 15_000
  const REVIVAL_BUDGET_MS = 60_000
  const POLL_MS = 400

  const settleIntoNewEditor = async (label: string): Promise<void> => {
    const until = async (alive: boolean, budget: number): Promise<boolean> => {
      const deadline = Date.now() + budget
      while (Date.now() < deadline) {
        /*
         * A control that has been torn down stops watching, and this is the
         * check that makes the whole wait safe to start.
         *
         * The loop outlives the element by up to seventy-five seconds, and what
         * it does at the end of it is reload the page. A detached control that
         * kept counting would eventually reload a document it is no longer part
         * of — out from under whatever replaced it, for a switch nobody is
         * waiting on any more.
         */
        if (destroyed) return false
        if ((await proxyAlive()) === alive) return true
        await wait(POLL_MS)
      }
      return false
    }

    if (await until(false, DEATH_BUDGET_MS)) {
      if (await until(true, REVIVAL_BUDGET_MS)) {
        window.location.reload()
        return
      }
    } else {
      // Still answering after fifteen seconds, so nothing was killed and the
      // reader gets their Escape key back.
      pinned = false
    }
    if (destroyed) return
    // Neither phase landed. The start screen is the one page that can say what
    // became of the editor, so this is where the old behaviour is kept.
    if (config.chooserUrl) window.location.assign(config.chooserUrl)
    else {
      pinned = false
      /*
       * The worst state this control can reach: the old editor was asked to go,
       * the new one never arrived, and there is no screen to ask why. The
       * sentence that used to be here reported exactly that and stopped — "and
       * there is no start screen to ask why" — which leaves a reader staring at
       * a zombie page whose only piece of information is that nobody can help.
       * The recovery is unglamorous and it always works, so it is what the
       * sentence says.
       */
      showNote(`${label} did not start. Run designlayer in its folder instead.`)
    }
  }

  /**
   * The switch has been accepted and this editor is being taken down with it.
   *
   * The menu stays open and holds the explanation, because it is the surface
   * the click happened on and the app behind it is about to stop answering —
   * a toast alone would leave a page that visibly stops working with nothing
   * on it saying why.
   */
  const leave = (label: string): void => {
    if (leaving) return
    leaving = true
    pinned = true
    context.toast(`Switching to ${label}\u2026`)
    showNote(`Starting ${label}. This page reloads when it is ready.`)
    void settleIntoNewEditor(label)
  }

  const render = (payload: AppsResponse | null): void => {
    /*
     * Captured before anything is replaced, for the same reason `showNote`
     * captures it: the rows about to be thrown away may be holding focus, and a
     * detached element hands focus to `<body>`. The two ways into this are a
     * keyboard open whose list has just arrived, and a refresh that genuinely
     * changed — rare, because the signature diff throws identical answers away,
     * and exactly when the reader is most likely to be mid-walk through the
     * list. Landing them on the first row is not where they were, but it is in
     * the menu they are looking at.
     */
    const held = menu.contains(document.activeElement)
    if (!payload) {
      showNote("Could not reach the DesignLayer server. Reload to try again.")
      return
    }
    if (typeof payload.error === "string" && payload.error.length > 0) {
      showNote(payload.error)
      return
    }
    const apps = Array.isArray(payload.apps) ? payload.apps : []
    /*
     * One sentence for an empty list, and it is the first thing most people
     * will ever see this control say.
     *
     * There were two of these and the other one was a lie. "This session was
     * started without the app chooser, so there is nothing to switch between"
     * was drawn whenever no start screen was behind the session — the common
     * shape — and the reader was looking at it INSIDE the app chooser, which
     * works perfectly the moment a second editor exists. It taught people that
     * the control was dead in their setup, which is the most expensive thing a
     * first impression can do, and it named no way to make it untrue.
     *
     * So: one sentence, true in every session, and it names the thing that puts
     * a row in this list. The start screen is appended rather than substituted,
     * because a session that has one has two ways forward and the command is
     * still the one that always works.
     */
    if (apps.length === 0) {
      showNote(
        config.chooserUrl
          ? `No other apps running. Run designlayer in another project, or open ${config.chooserUrl}.`
          : "No other apps running. Run designlayer in another project to add one."
      )
      return
    }
    const drawn: HTMLElement[] = apps.map(rowFor)
    /*
     * One sentence under the list when anything in it is unswitchable, and
     * nothing under it at all when nothing is — which is the shape of every
     * ordinary session.
     *
     * The row says `No project folder`, which is the fact; this says what to do
     * about it, which the row has three words for and should not repeat once
     * per app. A note that stood under every list would be a paragraph the
     * reader scrolls past on every open to reach a list of four-digit numbers.
     *
     * It used to render only when there was a start screen to send the reader
     * to, on the grounds that the screen has a field for typing a project path
     * and this menu has nothing of the kind. That gated the one sentence in the
     * menu that names a recovery on the one session shape least likely to have
     * one — so an unopenable row in a session with no screen got the reason and
     * no way out whatsoever. Without a screen the way out is the same command
     * that started this editor, run from the folder in question, and that is
     * worth saying.
     */
    const unplaced = drawn.some((row) => row.classList.contains("de-app-menu-row--unplaced"))
    if (unplaced) {
      drawn.push(
        note(
          config.chooserUrl
            ? `To open an app with no project folder, enter its path at ${config.chooserUrl}.`
            : "To open an app with no project folder, run designlayer in that folder."
        )
      )
    }
    menu.replaceChildren(liveRegion, ...drawn)
    liveRegion.replaceChildren()
    settleRows(held)
  }

  /** What a freshly drawn list owes the reader: disabled mid-switch, a tab stop, focus. */
  const settleRows = (held: boolean): void => {
    if (switching) setRowsDisabled(true)
    /*
     * One row owns the tab stop from the moment the list is drawn, not from the
     * first arrow key.
     *
     * A roving tabindex with no resting position is a menu a pointer user
     * cannot hand over to the keyboard: they open it, reach for Tab, and every
     * row is `-1`, so focus leaves the card without ever having been in it.
     */
    const live = rows().filter(walkable)
    if (live.length > 0) live[0].tabIndex = 0
    if (focusFirstOnLoad || held) {
      focusFirstOnLoad = false
      focusRow(0)
    }
  }

  /**
   * The answer this menu is currently DRAWN from, so an identical one can be
   * thrown away instead of repainting the card.
   *
   * A signature rather than the object: two fetches a second apart produce two
   * different objects describing the same three apps, and replacing the rows
   * for that would blink the menu under the cursor and move focus off whatever
   * the arrow keys had reached. Only the fields a row is built from are in it,
   * so a change nobody can see is not a change.
   */
  let shownSignature: string | null = null

  const signatureOf = (payload: AppsResponse | null): string =>
    payload === null
      ? "unreachable"
      : JSON.stringify([
          payload.error ?? "",
          (payload.apps ?? []).map((app) => [
            app.url,
            app.packageName,
            app.title,
            app.projectRoot,
            app.target,
          ]),
        ])

  /** Machine state, not app state: what is running is the same question whichever app is open. */
  const CACHE_KEY = "designlayer.running-apps"

  const readCache = (): AppsResponse | null => {
    const raw = readScoped(CACHE_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as AppsResponse
      return isRecordLike(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * Never caches a failure.
   *
   * A cached error would be shown instantly on the next open and then sit there
   * until a fetch replaced it, which is the one thing worse than the delay the
   * cache exists to remove: a menu that opens already claiming something is
   * broken, about a request that has not been made yet.
   */
  const writeCache = (payload: AppsResponse | null): void => {
    if (payload === null || typeof payload.error === "string") return
    writeScoped(CACHE_KEY, JSON.stringify(payload))
  }

  /**
   * Fetches, and repaints only if the answer is different from what is up.
   *
   * This is the revalidate half of the menu's bargain. The open half draws the
   * last known list at once, which is almost always right — the set of dev
   * servers on a machine changes a few times a day, and the menu is opened far
   * more often than that. So the common case is that this returns, finds the
   * signature unchanged, and does nothing at all: no repaint, no reflow, no
   * focus lost, nothing on screen to notice.
   *
   * When it HAS changed — a prototype started in another terminal since the
   * last look — the rows are replaced and the card is repositioned, which is a
   * visible change because a real one happened.
   */
  /*
   * One scan at a time, and none just after one landed.
   *
   * The pointer warms this on its way to the trigger and the click that
   * follows opens the menu a moment later, so both used to ask: the click
   * bumped `request` and threw away the hover's answer, which was then a
   * server-side port scan bought for nothing. An open now joins the scan
   * already running, and one within `FRESH_MS` of a good answer draws that
   * answer and asks nothing. `force` is for a menu that has just learned its
   * answer is wrong, and starts a scan whose answer replaces any in flight.
   */
  const FRESH_MS = 1500
  let inFlight: Promise<void> | null = null
  let loadedAt = 0
  const load = (force = false): Promise<void> => {
    if (!force && inFlight) return inFlight
    if (!force && Date.now() - loadedAt < FRESH_MS) return Promise.resolve()
    const mine: Promise<void> = scan().finally(() => {
      if (inFlight === mine) inFlight = null
    })
    return (inFlight = mine)
  }

  const scan = async (): Promise<void> => {
    const token = ++request
    let payload: AppsResponse | null = null
    try {
      const response = await fetch(`${context.apiBase}/apps`, {
        cache: "no-store",
        headers: { accept: "application/json" },
      })
      payload = (await response.json()) as AppsResponse
    } catch {
      payload = null
    }
    if (token !== request) return
    writeCache(payload)
    cached = payload ?? cached
    if (payload !== null) loadedAt = Date.now()
    // Closed since: the answer is banked for the next open and nothing is drawn.
    if (!isOpen) return
    /*
     * A failed refresh with a list already on screen changes nothing.
     *
     * The rows are the last thing this machine actually reported, and they stay
     * more useful than an apology — the editor's own server having a moment
     * says nothing about whether those apps are still running. An unreachable
     * server is only worth reporting when there is nothing else to show.
     */
    if (payload === null && shownSignature !== null && shownSignature !== "unreachable") return
    const signature = signatureOf(payload)
    if (signature === shownSignature) return
    render(payload)
    position()
  }

  /**
   * Warms the cache without opening anything.
   *
   * Two moments, and both are ones where the answer is wanted shortly but not
   * yet. Boot is the obvious one — the first open of a session would otherwise
   * be the one open that waits — and it is deferred so it queues behind the
   * chrome actually appearing rather than competing with it. A pointer arriving
   * on the trigger is the better one: it is the most reliable signal in a
   * pointer interface that a click is coming, and it buys the round trip the
   * distance between hovering a control and pressing it.
   */
  let warmedAt = 0
  const warm = (): void => {
    // A hand resting on the control must not become a request per frame, and
    // two opens in quick succession should not each pay for a scan.
    if (isOpen || Date.now() - warmedAt < 1500) return
    warmedAt = Date.now()
    void load()
  }

  const open = (fromKeyboard: boolean): void => {
    if (isOpen) return
    isOpen = true
    focusFirstOnLoad = fromKeyboard
    trigger.setAttribute("aria-expanded", "true")
    menu.style.display = "block"
    // Measured at the origin, where nothing narrows the card — but only the
    // first time; see the frame below for every open after it.
    if (!positioned) {
      menu.style.left = "0px"
      menu.style.top = "0px"
    }
    /*
     * The last known list, drawn in the same task as the click.
     *
     * The menu used to open holding "Looking for running apps…" and swap it for
     * rows a round trip later. Two things were wrong with that, and the second
     * is the one that mattered. The delay was one; but the swap also resized
     * the card from one line to three under a cursor that had just stopped
     * moving, so a menu that was about to be read jumped instead — and because
     * the answer is nearly always the same three apps, it jumped to say nothing
     * new.
     *
     * The note is now only for a menu that genuinely has nothing to show yet,
     * which after the first open of the first session is nobody.
     */
    if (cached) {
      const signature = signatureOf(cached)
      /*
       * The rows the last close took down, when they describe the same apps.
       *
       * Building them was most of what an open cost in script, and a list that
       * says the same thing is the same nodes: arming was undone by `disarm` on
       * the way out and a switch discards the parked list, so all a parked row
       * can have kept is where the roving tab stop last rested, which is put
       * back to the first row as a fresh list would have it.
       */
      if (parked?.signature === signature) {
        menu.replaceChildren(...parked.nodes)
        for (const row of rows()) if (row.tabIndex !== -1) row.tabIndex = -1
        settleRows(false)
      } else {
        render(cached)
      }
      shownSignature = signature
    } else {
      showNote(CHOOSER.looking)
      shownSignature = null
    }
    /*
     * Placed where it was last time, and checked in the frame that paints it.
     *
     * `position` measures the trigger and the card, and measuring in the click
     * forced a style and layout pass there — the most expensive part of an
     * open. The card almost always opens where it opened before: the trigger
     * sits at the top of a panel and the list is nearly always the same apps.
     * So it keeps its last place, and the measurement runs in a frame callback,
     * which comes before that frame paints and reads the layout the frame was
     * doing anyway. A trigger that moved since, or a list that changed height,
     * is corrected there, still before anything is seen. The first open has no
     * last place and measures here.
     */
    if (positioned) {
      cancelAnimationFrame(positionFrame)
      positionFrame = requestAnimationFrame(() => {
        if (isOpen) position()
      })
    } else {
      position()
      positioned = true
    }
    /*
     * No entrance. The kit opens a menu instantly, in its final geometry: it is
     * opened dozens of times an hour, and an entrance is a tax on every read.
     * The card used to wear the chrome's shared `de-arrive` here; the only
     * motion it has now is the 150ms dismissal `playExit` plays on the way out.
     */
    void load()
  }

  trigger.addEventListener("click", (event) => {
    if (isOpen) {
      close(true)
      return
    }
    // `detail === 0` is a click the keyboard synthesised from Enter or Space.
    // A pointer click leaves focus on the trigger, where the hand already is;
    // a keyboard one has to land somewhere the arrow keys can work from.
    open((event as MouseEvent).detail === 0)
  })

  trigger.addEventListener("keydown", (event) => {
    const key = (event as KeyboardEvent).key
    if (isOpen || (key !== "ArrowDown" && key !== "ArrowUp")) return
    event.preventDefault()
    open(true)
  })

  const onPointerDown = (event: Event): void => {
    if (!isOpen) return
    const target = event.target as Node
    // The trigger is excluded as well as the menu: closing here and toggling on
    // the click that follows would reopen it, and the control would need two
    // presses to shut.
    if (menu.contains(target) || trigger.contains(target)) return
    close()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isOpen) return
    const all = rows().filter(walkable)
    const index = all.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopImmediatePropagation()
      close(true)
      return
    }
    /*
     * Tab leaves, and leaving means the menu goes with it.
     *
     * This key was simply not handled, and the result was a card left painted
     * over content the reader was now tabbing through, still reporting
     * `aria-expanded="true"`, with no `inert` behind it. Forward-Tab only
     * appeared to work by accident: the menu is the last node in `<body>`, so
     * focus landed in the browser's own chrome, the window blurred, and
     * `onBlur` closed the menu — which is to say the keyboard user's way out of
     * this control was to leave the page.
     *
     * No `preventDefault`. Closing restores focus to the trigger and then the
     * browser's own Tab moves from there to whatever follows it, which is the
     * APG menu-button contract: the menu is dismissed and the tab order picks
     * up where the control sits, not where the card was floating.
     */
    if (event.key === "Tab") {
      close(true)
      return
    }
    if (event.key === "ArrowDown") focusRow(index + 1)
    else if (event.key === "ArrowUp") focusRow(index - 1)
    else if (event.key === "Home") focusRow(0)
    else if (event.key === "End") focusRow(all.length - 1)
    else if ((event.key === "Enter" || event.key === " ") && index >= 0) all[index].click()
    else return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  /*
   * Scroll closes rather than repositions, and blur closes rather than waits.
   *
   * The menu is anchored to a control in a panel that scrolls independently of
   * the page, so following the anchor would mean measuring on every frame of
   * someone else's scroll. Closing is what the layer stack does and it is the
   * right trade for a menu nobody holds open: the gesture that scrolled is
   * evidence the reader is looking at something else.
   *
   * Unless the gesture was aimed at the CARD. This listener is on `window` in
   * capture, so it used to see the wheel event a reader spent on the menu's own
   * scrollbar — five registered editors plus the trailing note is taller than a
   * short window at 200% zoom, and the card scrolls now — and dismiss the thing
   * they were trying to read. A scroll inside the menu is the opposite of
   * evidence that the reader has moved on.
   *
   * A resize gets the same treatment, which is the same trade one step further
   * out: `position()` runs on open and on a changed payload, so a window
   * resized while the card is up leaves a `fixed` card sitting where a trigger
   * used to be. A floating surface that no longer touches its anchor
   * misreports what it belongs to, and closing is cheaper and more honest than
   * following.
   */
  const onScroll = (event: Event): void => {
    // `event.target` is the window itself for a resize, and `Node.contains`
    // wants a Node or null — so the type check is load-bearing, not decoration.
    if (event.target instanceof Node && menu.contains(event.target)) return
    close()
  }
  const onBlur = (): void => close()

  /*
   * Seeded before anything can open the menu, and warmed a moment after boot.
   *
   * The read is synchronous and off localStorage, so it costs nothing at a
   * point in the session where cost would be noticed; the fetch behind it is
   * pushed past the frame the chrome mounts in, because a port scan competing
   * with the editor appearing is a worse trade than a first open that is warm
   * a second later than it could have been.
   */
  cached = readCache()
  const warmTimer = window.setTimeout(warm, 800)

  // The most reliable signal in a pointer interface that a click is coming, and
  // `focusin` is its keyboard equivalent for someone tabbing to the control.
  trigger.addEventListener("pointerenter", warm)
  trigger.addEventListener("focusin", warm)

  window.addEventListener("pointerdown", onPointerDown, true)
  window.addEventListener("keydown", onKeyDown, true)
  window.addEventListener("scroll", onScroll, true)
  window.addEventListener("resize", onScroll)
  window.addEventListener("blur", onBlur)

  return {
    node: trigger,
    /*
     * Tears down everything that outlives the trigger, which is all of it.
     *
     * The menu is in `document.body` and the five listeners are on `window`, so
     * removing the button from the panel would leave both behind — a menu that
     * can still be opened by a keystroke aimed at whatever replaced it. The
     * handover wait goes too, and it is the one that matters: it outlives the
     * element by up to seventy-five seconds and ends by reloading the page.
     */
    destroy() {
      // First, so a handover wait already in flight stops before anything else
      // here runs. It is the one thing in this control that can outlive the
      // element, and what it does at the end is reload the page.
      destroyed = true
      window.clearTimeout(warmTimer)
      disarm()
      // Bumped so an in-flight `GET /apps` cannot render into a menu that is
      // already gone from the document.
      request += 1
      isOpen = false
      window.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("scroll", onScroll, true)
      window.removeEventListener("resize", onScroll)
      window.removeEventListener("blur", onBlur)
      menu.remove()
    },
  }
}
