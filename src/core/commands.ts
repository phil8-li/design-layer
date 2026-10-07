/**
 * Named commands, so the keyboard has one thing to call and lanes keep owning
 * their own behaviour.
 *
 * The editor grew keyboard handling the way most editors do: a listener in
 * whichever lane happened to need the key. The toolbar answered ⌘Z and ⌘., the
 * canvas answered the arrows, and each one re-derived its own guards. That is
 * survivable at three shortcuts and not at thirty — with a Figma-sized keymap
 * the question "does this key already do something?" has to have ONE place to
 * ask it, or the second binding for `C` is discovered by a designer rather than
 * by a reader.
 *
 * So: lanes register what they can DO, under a name, and `shell/shortcuts.ts`
 * is the only module in the editor that listens for a key. A lane that is not
 * mounted registers nothing, and a shortcut pointed at a command nobody
 * registered is a no-op rather than a crash — which is the behaviour the
 * shortcuts panel wants anyway, since it lists what is live rather than what
 * was once planned.
 *
 * Deliberately NOT a command palette. There is no search, no recent list and no
 * argument passing: a command is a name and a nullary function, because that is
 * everything a key press can supply. If a palette is ever wanted it can be
 * built on this, and the labels it would need already live in `keymap.ts`
 * beside the chords.
 */

/**
 * The stable name a shortcut points at.
 *
 * Spelled `group.verb` — `mode.inspect`, `panel.left.layers` — because the
 * prefix is how a reader scanning `SHORTCUTS` in `keymap.ts` can tell at a
 * glance which surface a key reaches without opening the lane that owns it.
 */
export type CommandId = string

type Run = () => void

const registry = new Map<CommandId, Run>()

/**
 * Registers `run` under `id`, and hands back the way to take it out again.
 *
 * Last registration wins, which is the only sane rule for a map keyed by a
 * string: a lane remounted in a test would otherwise have to remember to
 * unregister first, and the failure if it forgot would be a command that still
 * drives the previous, detached DOM.
 */
export function registerCommand(id: CommandId, run: Run): () => void {
  registry.set(id, run)
  return () => {
    // Only if it is still ours. A later registration for the same name owns the
    // slot now, and a stale disposer must not delete somebody else's command.
    if (registry.get(id) === run) registry.delete(id)
  }
}

/** Whether anything is listening under this name right now. */
export function hasCommand(id: CommandId): boolean {
  return registry.has(id)
}

/**
 * Runs the command, and reports whether there was one to run.
 *
 * The boolean is what the key handler uses to decide whether to swallow the
 * event: a chord whose command is not registered — the assets browser on a
 * project with no design system, say — has to fall through to the app rather
 * than being eaten by an editor that cannot act on it.
 *
 * A throwing command is contained and reported. One bad command must not take
 * down the listener that every other shortcut in the editor shares.
 */
export function runCommand(id: CommandId): boolean {
  const run = registry.get(id)
  if (!run) return false
  try {
    run()
  } catch (error) {
    console.warn(`[designlayer] command ${id} failed`, error)
  }
  return true
}
