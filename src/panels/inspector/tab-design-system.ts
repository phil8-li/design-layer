/**
 * Right panel, Design system tab.
 *
 * Two sections in one scrolling column: what this project can draw FROM, then
 * what it got wrong. Libraries leads because it is the vocabulary — the colors,
 * the spacing steps, the text styles and the components the pickers on the
 * Design tab are allowed to offer — and the audit under it is a list of places
 * the page does not use that vocabulary. You read the words before the
 * corrections; a report at the top of a tab whose reader has not yet been told
 * what the project measures itself against is a list of complaints with no
 * standard attached. It is the same kind of claim `panels/inspector/index.ts`
 * makes about its own strip, one level down: the order is the order the
 * questions get asked in.
 *
 * ## This tab is not a view of the selection, and that changes how it renders
 *
 * Design describes the element you picked and Changes describes what you did to
 * it; both are rebuilt whenever the selection moves. Nothing here is about the
 * selection at all — a library is a fact about the project and a finding is a
 * fact about the source — so `update()` deliberately does no work of its own
 * and is simply passed on. It is called on tab activation and on invalidation,
 * which is enough: both sections subscribe to their own stores
 * (`subscribeToLibraries`, `subscribeToLint`) and repaint themselves the moment
 * a library is toggled or an audit lands, whether or not this tab is showing.
 * Wiring a selection subscription in here would put a rebuild of a forty-row
 * findings list on the hot path of a marquee, and would drop focus out of the
 * URL box every time the pointer crossed an element.
 */

import { librariesSection } from "../../libraries/libraries-section"
import { loadLibraries } from "../../libraries/store"
import { dsLintSection } from "../../lint/panel"
import { loadLintTools } from "../../lint/store"
import { el } from "../../core/dom"
import type { EditorContext } from "../../core/context"
import type { InspectorTab } from "./tab-code"

export function designSystemTab(editor: EditorContext): InspectorTab {
  const libraries = librariesSection(editor)
  const lint = dsLintSection(editor)

  /*
   * A bare div, and deliberately not even a class — the same shape the Design
   * tab's own host takes in `index.ts`.
   *
   * Each `section()` already draws its own header, its own body padding and its
   * own hairline, so the column IS the two of them stacked. A class here would
   * be a name with no rule behind it in a codebase where every class is
   * authored by hand, and the first rule anyone hung off it would be a third
   * rhythm between two surfaces that are supposed to read as one list.
   */
  const node = el("div", {}, [libraries.node, lint.node])

  return {
    node,
    update: () => {
      libraries.update()
      lint.update()
    },
    /*
     * The library LIST at load: it is the one thing here another surface
     * reads — `activeDesignSystem()` only merges an enabled library's tokens
     * once the list is in, so the Design tab's pickers would lack them until
     * this tab was first opened. The store dedupes, so the section's own first
     * `update()` reuses this request.
     *
     * The lint tool list once the page is idle — the slow answer on this tab,
     * a server that checks which checkers the project has — so the audit
     * section opens on it rather than on a round trip. Data only: the store
     * keeps it, and nothing here is rendered until the tab is first shown.
     */
    boot: () => {
      void loadLibraries(editor.apiBase)
      const warm = () => void loadLintTools(editor.apiBase)
      if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 3000 })
      else setTimeout(warm, 1000)
    },
  }
}
