/**
 * Whether one of the left panel's panes is on screen: the panel open, the
 * chrome shown, and that tab chosen.
 *
 * The one rule for it. The layers tree reads it to know when to follow the
 * selection, and the left panel hands it to the controls pane, so neither
 * writes its own copy. A leaf of its own rather than a function on `left.ts`:
 * the panel mounts the tree, and the tree asking the panel for this rule made
 * the two import each other.
 */

import type { EditorState } from "../core/store"

export function leftPaneOnScreen(state: Readonly<EditorState>, id: string): boolean {
  return leftPanelShown(state) && state.leftTab === id
}

/** The panel itself is on screen, whichever tab it shows. */
export function leftPanelShown(state: Readonly<EditorState>): boolean {
  return state.layersOpen && !state.chromeHidden
}
