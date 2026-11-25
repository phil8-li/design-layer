/**
 * What the editor calls the app it is on: the name the person gave it in the
 * Mac app's tabs when there is one, else its folder (`config.app.name`).
 *
 * The prelude carries the tab name as the page loads, and the desk sends it
 * again when the tab is renamed (`followDeskName` in `shell/desk.ts`), so the
 * header follows a rename without a reload. The chooser's header, the brief's
 * App line and the app the agent is told all read it here, so they cannot
 * disagree. `config.app.name` stays the folder: it is what the editor tells
 * the desk it shows, and the desk's "Use folder name" goes back to it.
 */

import { config } from "./config"

let given: string | null = config.app.givenName
const listeners = new Set<() => void>()

export function appDisplayName(): string | null {
  return given || config.app.name
}

/** A new tab name from the desk, or null when the tab went back to the folder name. */
export function setGivenAppName(name: string | null): void {
  const next = name && name.trim() ? name.trim() : null
  if (next === given) return
  given = next
  for (const listener of listeners) listener()
}

export function onAppNameChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
