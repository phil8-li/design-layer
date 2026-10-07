/**
 * How many places render this component — asked once, remembered, and shown
 * before a designer commits an edit that reaches all of them.
 *
 * This is the answer to the worst silent behaviour the editor had. Recolouring
 * a `Button` edits `button.tsx`, and if forty screens render that component,
 * forty screens change. The write was correct, instant, and completely quiet:
 * nothing counted the call sites, nothing warned, and the designer found out
 * when somebody else noticed. There was nowhere to put the warning either —
 * the write happened on a slider drag, and a modal over a slider is not a
 * warning, it is an obstruction.
 *
 * The Changes tab is what made it solvable. A row sits in a list the designer
 * reads BEFORE pressing the button that writes it, which is the one moment
 * where "this reaches 14 places" is information rather than interruption.
 *
 * WHY A CACHE, and why it is never invalidated. The question costs a walk of
 * the whole project, and the answer is asked once per row per repaint — a
 * number scrub would fire it dozens of times a second. It is also stable in the
 * way that matters: call sites change when somebody edits the project's source,
 * which is not something this editor does between two repaints of a panel. A
 * stale count here is off by the one call site a designer added in their own
 * editor a minute ago, and being one out is immaterial to a warning whose whole
 * job is to say "this is shared, look before you write".
 */

import { config } from "./config"
import { plural } from "./format"

/** What the server answers, narrowed to the part a warning needs. */
interface UsageAnswer {
  name: string
  count: number
  truncated: boolean
  refused: string
}

/**
 * Three states, and the third is the one that matters.
 *
 * `null` means "not asked yet, or asked and the answer never came". A caller
 * must draw nothing for it — an absent warning reads as "this is not shared",
 * and saying that about a component nobody counted would be the same silence
 * this module exists to end, wearing a confident face.
 */
const answers = new Map<string, UsageAnswer | null>()
const inFlight = new Set<string>()
const listeners = new Set<() => void>()

function announce(): void {
  for (const listener of listeners) listener()
}

/** Fires when an answer lands, so a panel that drew nothing can draw it now. */
export function onComponentUsageChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The count for a component, if it is already known.
 *
 * Synchronous by design: it is read inside a render, and a render cannot wait.
 * The first call for a name returns `null` and starts the lookup; the listener
 * above is how the panel finds out the answer arrived.
 */
export function componentUsage(name: string): UsageAnswer | null {
  if (!name) return null
  if (answers.has(name)) return answers.get(name) ?? null
  if (!inFlight.has(name)) void request(name)
  return null
}

async function request(name: string): Promise<void> {
  inFlight.add(name)
  try {
    const response = await fetch(
      `${config.apiBase}/component/usage?name=${encodeURIComponent(name)}`
    )
    if (!response.ok) {
      // Remembered as "asked, no answer" rather than retried. A route that
      // refused once will refuse the same way on the next repaint, and a panel
      // that re-asks on every paint turns one failure into a request storm.
      answers.set(name, null)
      return
    }
    const body = (await response.json()) as UsageAnswer
    answers.set(name, body)
  } catch {
    answers.set(name, null)
  } finally {
    inFlight.delete(name)
    announce()
  }
}

/**
 * The sentence a row shows, or nothing at all.
 *
 * Nothing is the right answer for most rows and the common case must stay
 * silent: a warning on every row is wallpaper, and wallpaper is not read. Only
 * a component the server actually found in more than one place earns a line.
 *
 * The count is phrased as "other places" rather than as the raw total, because
 * the raw total includes the instance the designer is looking at and reads as
 * one too many to anybody who counts the screen in front of them.
 */
export function sharedComponentWarning(name: string): string {
  const answer = componentUsage(name)
  if (!answer || answer.refused) return ""
  if (answer.count <= 1) return ""
  const others = answer.count - 1
  const places = plural(others, "other place")
  // "at least" only when the walk stopped early, so the ordinary sentence is
  // not hedged for a limit nobody hit.
  const qualifier = answer.truncated ? "at least " : ""
  return `${name} is used in ${qualifier}${places}. This changes all of them.`
}

/** Test seam: the cache outlives a panel, so a suite has to be able to clear it. */
export function resetComponentUsageForTest(): void {
  answers.clear()
  inFlight.clear()
}
