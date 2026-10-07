/**
 * The React half of the toaster: the Sonner `<Toaster>` and its render.
 *
 * Split out of `core/toast.ts` so it can be loaded LATE. React, ReactDOM and
 * Sonner are about 745KB of the bundle and the toaster is their only user, yet
 * compiling and evaluating them was most of the editor's boot — every page load
 * paid for a toast that usually never comes. `build.mjs` emits it as a module of
 * its own, `dist/toaster.js`, which the launcher serves beside the overlay and
 * `toast.ts` imports when the first message arrives — so the libraries are not
 * even parsed before then.
 * Everything that must exist at boot — the host, its shadow root, the
 * stylesheet and the queue — stays in `toast.ts`.
 *
 * Nothing about the cards changes: same library, same patches, same props.
 */

import { createElement, Fragment, useEffect, type CSSProperties } from "react"
import { createRoot } from "react-dom/client"
import { Toaster, toast as sonner } from "sonner"

import { LAUNCHER_CLEARANCE } from "./css/launcher"
import { tokens as t } from "./tokens"

export { sonner }

/** Stacked beyond this and the newest is behind two cards nobody can read. */
const VISIBLE_TOASTS = 3

/**
 * Says when Sonner is listening, from inside React's own effect ordering.
 *
 * Sonner subscribes to its store from a `useEffect`, which React runs after
 * paint — so a message raised in the same tick as the mount has nobody
 * listening and is dropped without a trace. Something has to mark the moment
 * that subscription exists.
 *
 * The obvious probe is to poll the DOM for `[data-sonner-toaster]`, and it is
 * WRONG in a way worth recording, because it looks like it works: that element
 * is the `<ol>`, and Sonner returns `null` for it while there are no toasts
 * (`index.mjs`, `if (!filteredToasts.length) return null`). So the list exists
 * only once a toast is showing, a toast can only show once we believe we are
 * ready, and the probe never fires. Measured exactly that way — the queue held
 * every message forever and the corner stayed empty.
 *
 * Rendered as the Toaster's NEXT SIBLING instead. React flushes passive effects
 * in tree order, so everything inside `<Toaster>` — its store subscription
 * included — has run by the time this one does. That is a guarantee about
 * ordering rather than about timing, which is what makes it exact where a
 * frame budget was only ever a guess.
 */
function ReadyGate({ onReady }: { onReady(): void }): null {
  useEffect(onReady, [])
  return null
}

/** Renders the Toaster into `mountPoint`; returns the unmount. */
export function mountToaster(mountPoint: Element, onReady: () => void): () => void {
  const root = createRoot(mountPoint)
  root.render(
    createElement(Fragment, null, [
      createElement(Toaster, {
        key: "toaster",
        /*
         * Bottom-right, stacked ABOVE the launcher rather than on it.
         *
         * `css/launcher.ts` pins the disc in this corner, and it is the one
         * control that must stay findable, because it is the only way back
         * once the chrome is hidden. So the bottom offset clears the resting
         * disc plus one gap; the right offset is the panel inset, so the card
         * lines up with the docked chrome.
         */
        position: "bottom-right",
        offset: {
          bottom: LAUNCHER_CLEARANCE + t.space.sm,
          right: t.size.panelInset,
        },
        gap: t.space.sm,
        visibleToasts: VISIBLE_TOASTS,
        /*
         * On, and it was off for a reason that only held while every toast
         * expired.
         *
         * The old note said a toast this short is read in one glance and gone
         * before a close button could be aimed at. True of the four-second
         * info rung, and no longer true of the error rung, which waits (see
         * `DURATION` in `toast.ts`). A card that never leaves and offers no way
         * out is worse than one that leaves too early: it parks over the
         * bottom-right corner of the canvas until something else happens to
         * dismiss it.
         *
         * Sonner puts the button on every toast rather than per type, so the
         * info rung gains one it does not need. That is the cheaper of the two
         * costs — an affordance nobody uses, against an error nobody can clear.
         * `css/toast.ts` moves it from Sonner's corner badge to the card's
         * trailing edge.
         */
        closeButton: true,
        // Off: severity is carried by the glyph alone, and every card is the
        // same plain surface. A tinted card read as a second, louder signal.
        richColors: false,
        /*
         * Narrower than Sonner's 356px default: this is tool chrome standing
         * beside a 260px inspector, and a card wider than the panel it reports
         * on reads as the app talking rather than the editor.
         *
         * Set here rather than in the stylesheet because Sonner writes
         * `--width` INLINE on the section, where nothing in a stylesheet can
         * reach it — the prop spread puts `style` last, so this is the one
         * place the value wins. The cast is the standard one for a custom
         * property in `CSSProperties`.
         */
        style: { "--width": "300px" } as CSSProperties,
      }),
      // After the Toaster, and the order is the mechanism — see `ReadyGate`.
      createElement(ReadyGate, { key: "ready", onReady }),
    ])
  )
  // Unmounting synchronously from inside a React lifecycle throws; nothing here
  // runs from one, but the deferral costs nothing and removes the question.
  return () => setTimeout(() => root.unmount())
}
