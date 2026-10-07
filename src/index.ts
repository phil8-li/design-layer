/**
 * Entry point for the Figma-style DesignLayer overlay.
 *
 * Loaded by the dev proxy on :3456 after the vendored React Rewrite bundle,
 * which we drive headlessly for fiber -> source resolution and source writes.
 * Nothing here runs on :3000.
 */

import { whenBridgeReady } from "./core/bridge"
import { installCompanionApi } from "./core/companion-api"
import { createContext } from "./core/context"
import { whenHostHydrated } from "./core/host-readiness"
import { mirrorVendorToasts, notify, prepareToasterOnFirstInput, retract } from "./core/toast"
import { mountShell } from "./shell/shell"
import { installAppViewport } from "./shell/app-viewport"
import { installVendorChromeSuppression } from "./shell/vendor-chrome"
import { installToolbar } from "./shell/toolbar"
import { installShortcuts } from "./shell/shortcuts"
import { installWayBack } from "./shell/way-back"
import { installTooltips } from "./core/tooltip"
import { installCanvas } from "./canvas"
import { installAnnotations } from "./annotations/canvas"
import { installLintMarkers } from "./lint/markers"
import { installBoard } from "./board"
import { isBoardFrame } from "./board/frames"
import { installLeftPanel } from "./panels/left"
import { installInspector } from "./panels/inspector"

/*
 * Before anything is awaited, and deliberately outside `boot`.
 *
 * Suppression owned by the shell was always one flash late: the vendor painted
 * its own toolbar before the shell mounted (see `shell/vendor-chrome.ts`). At
 * module scope it runs while the concatenated bundle is still evaluating,
 * which is before the vendor's root exists — `boot` is what starts the vendor
 * now — and that is the only time that is never late.
 *
 * It is not released with the shell either. The reason to hide that chrome is
 * that the editor is LOADED, not that its panels are currently mounted: hiding
 * the editor with ⌘. must not hand the page back wearing the vendor's UI.
 */
installVendorChromeSuppression({ onRoot: mirrorVendorToasts })

/*
 * Inside one of canvas view's frames the editor does not exist.
 *
 * A frame is a copy of the page for the board to show, and the launcher keeps
 * this whole bundle out of it (runtime/board-frame.mjs). This is the second
 * line, for an editor process started before that guard: it serves this bundle
 * fresh from dist/ inside its old wrapper, and a frame that booted it would
 * draw a second set of panels into the picture of the page. The suppression
 * above still runs, so the vendor's own toolbar stays hidden there too.
 */
const IN_BOARD_FRAME = isBoardFrame()

/*
 * ⌘. is heard from here on: before `boot` awaits anything, and before the
 * app's own modules have run, so it is first in line on the window and no
 * listener of the app's can swallow it. Until `boot` registers the command the
 * press finds nothing to run and is left to the page. See `shell/way-back.ts`.
 */
if (!IN_BOARD_FRAME) installWayBack()

/*
 * No toaster is mounted here, though one used to be, at module scope, so the
 * earliest messages — the bridge timing out, a host that never hydrates — had
 * somebody listening. `notify` builds the toaster on its first message now,
 * queues across the gap, and loads React with it (`core/toast.ts`), so mounting
 * one up front bought nothing but its stylesheet, parsed on the host's critical
 * path before the app's own modules could run.
 */


/**
 * How long the wait may go unremarked before the editor says it is waiting.
 *
 * Under this, saying anything is noise — the editor arrives and the notice
 * would be a flash of text nobody finished reading. Past it, the page has been
 * sitting there long enough that silence is the wrong answer: `whenHostHydrated`
 * allows ten seconds, and `core/host-readiness.ts` records that Angular spends
 * all ten on every single load and calls that "slow enough to feel broken".
 *
 * A second and a bit is roughly where a wait stops reading as the page being
 * slow and starts reading as the page being finished and empty.
 */
const SLOW_BOOT = 1200
const BOOT_WAIT = "boot-wait"

async function boot(): Promise<void> {
  let bridge
  /*
   * THE WAIT SAYS SO, AND SO DOES GIVING UP.
   *
   * This gate can take ten seconds and used to show nothing at all — no editor,
   * no message — and then, on failure, write a `console.warn` that nobody has
   * the console open to read. Both halves are the same omission: `notify`
   * builds the toaster on its first message, so it can speak during a boot
   * that has not happened yet.
   *
   * The notice is on a timer rather than immediate, so a fast host never sees
   * it. It is taken back on both paths, including the throw, because a
   * "waiting" toast outliving the thing it described would be worse than never
   * having said anything. Clearing the timer alone only covered a notice not
   * yet shown; one already up stayed for its full four seconds beside a booted
   * editor, or beside the failure card it contradicts — hence the id.
   */
  const slow = setTimeout(
    () => notify({ title: "Waiting for the app…", id: BOOT_WAIT }),
    SLOW_BOOT
  ) as unknown as number
  try {
    // In this order: the bridge boots the vendor, and the vendor's boot is
    // work the app's first paint should not wait for. On a client-rendered
    // app both resolve inside the task that committed it, so the editor is
    // mounted before that first paint (see `core/host-readiness.ts`).
    await whenHostHydrated()
    bridge = await whenBridgeReady()
  } catch (error) {
    clearTimeout(slow)
    retract(BOOT_WAIT)
    console.warn("[designlayer]", error)
    // The one message that has to reach the page rather than the console: the
    // editor is not coming up, and nothing else on screen will say so.
    notify("Could not attach to this page. Reload to try again.", "error")
    return
  }
  clearTimeout(slow)
  retract(BOOT_WAIT)

  const shell = mountShell()
  /*
   * Straight after the shell, because it is the other half of the inset.
   *
   * `mountShell` narrows the app's containing block; this teaches the app's own
   * stylesheet that the narrowed strip is what `vw` and its width breakpoints
   * are about. Before it, an app sized in viewport units ignored the inspector
   * entirely and ran on underneath it — see `shell/app-viewport.ts` for why the
   * left panel looked fine while it did.
   */
  installAppViewport()
  const context = createContext(bridge, shell.slots)

  installToolbar(context)
  // The left panel is a tab host now, not the layer tree directly: it mounts
  // the tree into one pane and the assets browser into the other. Everything
  // that used to reach `installLayersPanel` from here goes through it.
  installLeftPanel(context)
  installInspector(context)
  installCanvas(context)
  /*
   * Straight after the canvas, because the canvas is what it arbitrates: a
   * companion claims the pointer precisely to stop the lane installed on the
   * line above from swallowing the clicks its own tool is waiting for.
   *
   * Companion bundles are concatenated AFTER this one and this boot is awaited,
   * so the API cannot be published before they evaluate. That is why it is a
   * window global a caller looks up at claim time rather than something handed
   * to a companion at load: by the time a person arms one, the editor is up.
   */
  installCompanionApi(context)

  /*
   * SAY WHAT IS SELECTED. The chrome had no live region and announced nothing.
   *
   * Selecting is the commonest act in this editor and it was silent: the
   * outline moves, the inspector repaints with that element's whole property
   * stack, and a screen-reader user was told none of it. Walking siblings with
   * Tab was the same, only several times a second.
   *
   * Built here rather than inside the canvas because a selection can be made
   * from three places — the canvas, the layers tree and the code view — and all
   * three land in the same store. One subscriber at the top covers them all;
   * three announcers would race and say it three times.
   *
   * The sentence names the component first because that is what the user
   * recognises, falls back to the tag, and counts a multi-selection rather than
   * listing it: "4 elements selected" is the useful fact, and reading four
   * names is the thing polite queuing would then have to get through.
   */
  context.subscribe((state, previous) => {
    if (state.selection === previous.selection) return
    const { selection } = state
    if (selection.length === 0) {
      // Deliberately silent. Deselecting is usually Escape — the user knows
      // they did it, and announcing every clear turns the region into noise.
      shell.announcer.textContent = ""
      return
    }
    shell.announcer.textContent =
      selection.length > 1
        ? `${selection.length} elements selected`
        : `${selection[0].componentName || selection[0].tagName} selected`
  })
  // Order here is cosmetic, and deliberately so. Both lanes listen at window
  // capture, where registration order decides who runs first — but the
  // selection lane asks `selectionOwnsInput()`, which is false the moment
  // annotation mode is on, so it declines whether it ran first or not.
  // Leaning on the order instead would have been a trap: `stopPropagation`
  // does not stop other listeners on the SAME target, so a swallow here can
  // never be what protects the lane next door. The gate is.
  installAnnotations(context)
  // Straight after the note pins, because the two are one decision rather than
  // two features: both pin a badge to an element's top-left corner, so the
  // state they share lets exactly one of them paint at a time. Mounted eagerly
  // and cheaply — the layer draws nothing until an audit has actually run.
  installLintMarkers(context)
  /*
   * The board of every page, after the lanes it stands down and before the
   * keyboard.
   *
   * After, because opening it flips `canvasView`, and every painter above reads
   * that through `editorOwnsInput()` — they have to exist to hear it. Before
   * the shortcuts, because the board answers Escape, `=`, `-`, ⇧0 and the
   * arrows itself while it is open, and its window-capture listener has to be
   * registered ahead of the one that dispatches the keymap.
   */
  installBoard(context)
  /*
   * LAST, and that is the whole of its ordering requirement.
   *
   * It is the editor's keyboard listener for the keymap, ⌘. aside (that one is
   * `installWayBack`, above), and it dispatches through the command registry,
   * so what it can actually do is whatever the lanes above have registered by
   * now. Mounting it earlier would still work — a name is resolved at the
   * moment a key is pressed, not at install — but a lane that reads every other
   * lane's output belongs after them in the list, or the next reader has to
   * prove the indirection to themselves before believing it.
   */
  installShortcuts(context)

  /*
   * One tooltip for the whole chrome, installed last because it listens to the
   * document rather than to any one surface.
   *
   * Delegated: nothing above has to register a tip, and nothing has to be
   * rebuilt when a panel repaints. Every control that already writes
   * `data-de-tip` — the toolbar's tools, the note-row actions, the settings
   * help dots — is picked up as-is, and so is every `title` the chrome sets,
   * which is what finally takes the operating system's own one-second tip out
   * of a surface that has its own visual language.
   *
   * The three hand-rolled CSS tips it replaces could not do the one thing that
   * matters here: a `::after` cannot measure the viewport, so a tip on a
   * control near the right edge ran off it. This one flips and shifts.
   */
  installTooltips()
  // The toaster's React half, loaded at idle once someone starts working, so
  // the first card does not wait for it (see `core/toast.ts`).
  prepareToasterOnFirstInput()

  context.refresh()
  console.info("[designlayer] Figma-style overlay ready")
}

if (!IN_BOARD_FRAME) void boot()
