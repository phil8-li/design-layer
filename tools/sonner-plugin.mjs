/**
 * Sonner, patched at bundle time.
 *
 * An esbuild plugin, shared by `build.mjs` and by anything else that bundles
 * the toaster to show it (`tools/toast-gallery.mjs`), so a demo renders the
 * same library the editor ships. Every patch is exact-count: a Sonner
 * release that changes a needle stops the build rather than quietly
 * dropping the fix.
 *
 * ---------------------------------------------------------------------------
 * 1. SONNER'S SELF-INJECTED STYLESHEET, KEPT OUT OF THE HOST DOCUMENT.
 *
 * `sonner/dist/index.mjs` opens with an `__insertCSS(…)` call at module scope
 * that appends its whole stylesheet to `document.head` the moment the module is
 * evaluated. That is the right default for an app importing Sonner for itself,
 * and exactly wrong here: this editor is loaded into apps it did not write, and
 * Sonner's selectors are global and unprefixed. The injected sheet includes
 *
 *   html[dir=ltr] { --toast-icon-margin-start: -3px; … }
 *   [data-sonner-toast][data-styled=true] { padding: 16px; … }
 *
 * — so a host app that uses Sonner itself would have its own toasts silently
 * restyled by ours, and every page gets custom properties written onto its
 * `<html>` by a tool that is supposed to be looking, not touching. Confirmed on
 * the running editor before this was added: one leaked `<style>` in the host's
 * head, carrying the full sheet.
 *
 * Nothing is lost by dropping it. `core/css/toast.ts` puts the same stylesheet
 * — from the same package version, checked by `tools/build-sonner-css.mjs` —
 * inside the toaster's shadow root, which is the only place it can reach our
 * toasts and the only place it cannot reach anyone else's.
 *
 * The guard is neutered rather than the call deleted: the needle is one short
 * line instead of a 17KB string argument, and the function keeps its shape for
 * anything that might call it.
 *
 * ---------------------------------------------------------------------------
 * 2. A CARD'S HEIGHT IS MEASURED WITHOUT ITS TRANSFORM.
 *
 * Sonner records each card's height with `getBoundingClientRect().height`,
 * which includes transforms, and it measures at mount — exactly when
 * `css/toast.ts` has the card at its entrance `scale(0.96)`. So a 40px card was
 * recorded as 38.4px, and everything built on that number was 4% short: the
 * collapsed stack sized the cards behind the front one from it, so the first
 * peek above the front card was 5.4px and the rest 7.0px; the expanded stack
 * squeezed every card to it and spaced them from it.
 *
 * `offsetHeight` is the layout height, which a transform does not change. It
 * rounds to a whole pixel, which is below anything visible in a stack spaced
 * 8px apart.
 *
 * ---------------------------------------------------------------------------
 * 3. A NEW TOAST RENDERS AT THE END OF THE TASK THAT RAISED IT.
 *
 * `<Toaster>` hears each new toast and renders it from a `setTimeout`, so it
 * is out of the caller's batch ("Prevent batching, temp solution"). After a
 * click Chrome runs the next frame before any timer queued by that click, so
 * every toast reached the screen a frame late: measured ~15ms from an Apply
 * click to the card existing, ~11ms of it waiting behind that frame. A
 * microtask is out of the caller's batch just the same — it runs once the
 * caller's own code has returned — and nobody who raises a toast here is a
 * React render, the one place `flushSync` is not allowed.
 */

import fs from "node:fs"

const INSERT_CSS_GUARD = "if (!code || typeof document == 'undefined') return"
const MEASURE = "toastNode.getBoundingClientRect().height"
const RENDER_LATER = "setTimeout(()=>{\n                ReactDOM.flushSync(()=>{\n                    setToasts(("

function replaceExactly(source, needle, replacement, count, file) {
  const found = source.split(needle).length - 1
  if (found !== count) {
    throw new Error(`sonner-plugin: expected ${count} of ${JSON.stringify(needle)} in ${file}, found ${found}`)
  }
  return source.split(needle).join(replacement)
}

export const patchSonner = {
  name: "patch-sonner",
  setup(build) {
    build.onLoad({ filter: /[\\/]node_modules[\\/]sonner[\\/]dist[\\/]index\.mjs$/ }, (args) => {
      let source = fs.readFileSync(args.path, "utf8")
      source = replaceExactly(source, INSERT_CSS_GUARD, "if (true) return", 1, args.path)
      source = replaceExactly(source, MEASURE, "toastNode.offsetHeight", 2, args.path)
      source = replaceExactly(source, RENDER_LATER, RENDER_LATER.replace("setTimeout(", "queueMicrotask("), 1, args.path)
      return { contents: source, loader: "js" }
    })
  },
}
