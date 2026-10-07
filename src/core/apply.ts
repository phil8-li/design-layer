/**
 * The commit: every path from an on-screen preview to a file on disk.
 *
 * This used to live inside `installToolbar`, as three closures over the bar's
 * own `bridge` and `context`. That was fine while the bar was the only thing
 * that could commit, and it stopped being fine the moment the Changes tab
 * needed the same verb — an editor with two commit buttons that each reach
 * disk their own way is an editor with two subtly different definitions of
 * "applied", and the second one is always the one nobody tested.
 *
 * So the orchestration moved here and the bar calls it. There is exactly one
 * ordering of the three queues, one set of toasts, and one answer to "is
 * anything owed". A surface that wants to commit asks for a committer; it does
 * not reimplement the sequence.
 *
 * What did NOT move is the decision about what a queue contains. The writer
 * still decides whether a change can be spelled in source, the removal queue
 * still holds deletions, the Angular lane still describes elements at commit
 * time. This module only runs them, in the one order that does not corrupt a
 * file, and reports what happened.
 */

import {
  applyAngularOperations,
  buildAngularOperations,
  clearAngularQueue,
  angularQueueSize,
  isAngularHost,
  type AngularOperation,
} from "./angular"
import { markEditRefused, markEditsWritten } from "../annotations/journal"
import { recordPreviewOnly } from "./change-prompt"
import { settleAfterApply } from "./moves"
import {
  applyRemovals,
  buildRemovalOperations,
  clearRemovalQueue,
  removalQueueSize,
  type RemovalResult,
} from "./removal"
import { untranslatedProperties } from "./writer"
import type { RewriteBridge } from "./bridge"
import type { ToastMessage } from "./toast"
import { formatCount, plural } from "./format"

/**
 * One refused Angular write, filed as a change that still wants making.
 *
 * `from` is left empty, and that is not laziness. The Angular queue merges
 * edits onto a live element and describes it at commit time, so by the point
 * a refusal comes back the pre-edit value is genuinely gone — the preview
 * overwrote it hundreds of milliseconds ago. The ledger already spells an
 * empty `from` as "unset" in the row and omits the "(currently …)" clause
 * from the brief, so an honest gap reads correctly in both. Inventing a
 * "from" by reading the element now would print the value the designer just
 * typed as the value they are changing away from.
 *
 * `filePath` is null for the same kind of reason: the reply names the file in
 * its prose but not as a field, and a path parsed out of an error message is
 * a path that breaks the first time the message is reworded. `null` routes
 * the entry to the ledger's "Search for `Component`" form, which is the
 * shape it already uses for every change whose file is unknown.
 */
export function recordRefusedWrite(operation: AngularOperation): void {
  const shared = {
    filePath: null,
    componentName: operation.componentName.replace(/^_/, ""),
    tagName: operation.target.tagName,
    className: operation.target.classes.join(" "),
  }
  /*
   * Correct the outbox as well as the ledger, and it has to be both.
   *
   * The ledger is what the commit reads to know work is still owed. The outbox
   * is what the AGENT is sent. The writer already told the outbox this edit was
   * written — on an Angular host it says so for any style the template writer
   * can express — and the server has just disagreed. A row left reading "In
   * source" tells the agent to skip the one change that actually still needs
   * making.
   */
  const unclaim = (property: string) =>
    markEditRefused({ tagName: shared.tagName, className: shared.className, property })

  if (operation.op === "setStyles") {
    for (const [property, value] of Object.entries(operation.declarations)) {
      recordPreviewOnly({ ...shared, property, from: "", to: value })
      unclaim(property)
    }
    return
  }
  if (operation.op === "setClasses") {
    // `target.classes` is the live list, read after the preview applied — so
    // it is already the class attribute the source should end up with, which
    // is exactly what the `class` sentinel means in a brief.
    recordPreviewOnly({
      ...shared,
      property: "class",
      from: "",
      to: operation.target.classes.join(" "),
    })
    unclaim("class")
    return
  }
  recordPreviewOnly({ ...shared, property: "text", from: "", to: operation.text })
  unclaim("text")
}

/** What a surface has to hand over to be able to commit. */
export interface ApplyOptions {
  bridge: RewriteBridge
  /** The editor's toast, so a commit reports in the same voice as everything else. */
  toast: (message: ToastMessage, kind?: "info" | "error") => void
  /**
   * Called after each queue empties.
   *
   * Two surfaces watch the same three queues and both have to repaint: the
   * bar's Apply button greys out, and the Changes tab's rows change badge. The
   * queues themselves already broadcast, so this is only for the repaint a
   * caller owns that the queue cannot know about.
   */
  onChange?: () => void
}

export interface Committer {
  /** Write everything writable, in the one order that does not corrupt a file. */
  applyAll: () => Promise<void>
  /** True when anything is holding an edit that has not reached source. */
  hasPendingChanges: () => boolean
  /** How many operations a commit would send, for a count on a button or a tab. */
  pendingCount: () => number
}

const NO_SOURCE = {
  title: "Source files not found",
  description: "Send these changes to your agent instead.",
}

/** A server's lowercase reason, as the opening of a toast body (no end stop). */
function sentence(reason: string): string {
  const text = reason.trim().replace(/\.$/, "")
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

export function createApply({ bridge, toast, onChange }: ApplyOptions): Committer {
  const changed = () => onChange?.()

  /**
   * Does the vendor store hold anything, without trusting that there is one.
   *
   * The store is the ONE dependency in this module that comes from outside the
   * package — it is the vendored engine's, reached through the bridge — and it
   * is the one that can be absent. An Angular host never builds it, a vendor
   * upgrade can move it, and a harness that mounts a panel to look at its rows
   * has no reason to construct one.
   *
   * Absent is answered as "nothing queued" rather than thrown, because both
   * callers run inside a repaint. `hasPendingChanges` is read by two buttons'
   * disabled state on every render; a throw there does not produce a broken
   * button, it produces no panel at all. The commit itself still refuses to
   * invent a write — `applyReactBatch` asks the store directly and reports when
   * it cannot answer.
   */
  const storeHasChanges = (): boolean => {
    try {
      return bridge.store?.hasChanges() === true
    } catch {
      return false
    }
  }

  /**
   * True when anything is holding an edit that has not reached source.
   *
   * Three queues, not two. Deletions sit in their own — the vendor engine
   * cannot express one and the Angular queue describes live elements, so a
   * deleted element belongs to neither — and a delete with nothing else after
   * it must still light the commit. It did not, for exactly one build, and the
   * only symptom was a card that came back on the next hot reload.
   */
  const hasPendingChanges = () =>
    removalQueueSize() > 0 || (isAngularHost() ? angularQueueSize() > 0 : storeHasChanges())

  /**
   * The same three queues, counted rather than asked about.
   *
   * The React lane has no count — `hasChanges()` is the whole of the vendor
   * store's answer — so its contribution is the number of operations a commit
   * would actually build. That is a slightly expensive question to ask on every
   * repaint, and it is the only honest one: the store merges by key, so "how
   * many edits did I make" and "how many operations will be sent" are different
   * numbers and the button is about the second.
   */
  const pendingCount = () => {
    const removals = removalQueueSize()
    if (isAngularHost()) return removals + angularQueueSize()
    if (!storeHasChanges()) return removals
    try {
      return removals + bridge.store.buildBatchOperations().length
    } catch {
      // A store that cannot build is a store with nothing sendable in it. The
      // count is cosmetic; refusing to paint a number is better than throwing
      // out of a repaint.
      return removals
    }
  }

  /**
   * The Angular commit.
   *
   * A request rather than the vendor's `commitBatch` WebSocket message, because
   * this one has an answer worth waiting for. The vendor's protocol is
   * fire-and-forget: it reports success by the page hot-reloading, and reports
   * a write it could not place by doing nothing at all. Here an operation can
   * fail for a reason the user can act on — an element that matches two
   * template nodes equally well, text that turns out to be an interpolation —
   * and the only place that reason can surface is the reply.
   */
  const applyAngular = async (): Promise<void> => {
    const operations = buildAngularOperations()
    if (!operations.length) {
      toast(NO_SOURCE, "error")
      return
    }
    toast(`Applying ${plural(operations.length, "change")}…`)
    try {
      const result = await applyAngularOperations(operations)
      // Cleared on any reply, including a partial one: what failed is reported
      // below and stays on screen as a preview, and leaving it queued would
      // mean the next commit retried a write that has already been refused once.
      clearAngularQueue()
      // Before the refusals are filed below, which demote exactly the rows the
      // server would not take. Promoting first and correcting after is what
      // keeps a partial apply from leaving every row looking refused.
      markEditsWritten()
      changed()
      if (!result.failed.length) {
        const files = new Set(result.applied.map((entry) => entry.filePath))
        toast({
          title: `Wrote ${plural(result.applied.length, "change")}`,
          description: [...files].join(", "),
        })
        return
      }
      // A refusal is a change that still wants making, so it goes where every
      // other unwritable change goes.
      //
      // Without this the two hosts disagreed about what happens to a write that
      // cannot reach source. On React it falls back to the Changes tab and can
      // be copied, or sent to an agent. Here it was a toast and nothing else:
      // the queue was cleared, the preview stayed on screen, and the only
      // record of the change was one sentence the designer had a few seconds to
      // read. Seen on a real page — two `<div class="auth-row__icon">` in one
      // template tie the matcher, the server correctly refused with "no unique
      // <div>", and the edit then existed nowhere but the pixels.
      for (const failure of result.failed) recordRefusedWrite(failure.operation)

      // The first reason, in full, rather than a count of failures. One
      // sentence a designer can act on beats a tally they have to go looking
      // for, and the reasons repeat far more often than they differ.
      const [first] = result.failed
      const others = result.failed.length - 1
      toast(
        {
          title: `Wrote ${formatCount(result.applied.length)}, skipped ${formatCount(result.failed.length)}`,
          description: `${sentence(first.reason)}${others > 0 ? ` (+${others} more)` : ""}. Queued in Changes.`,
        },
        "error"
      )
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not write the changes. Check the designlayer terminal, then try again", "error")
    }
  }

  /**
   * The deletions, on whichever host.
   *
   * One request for both, because a removal is the one write this package
   * performs itself on React as well as on Angular — the server picks the
   * language, the browser does not. It reports for itself rather than folding
   * into the other lane's toast: "wrote 3 changes" and "deleted 2 elements" are
   * different sentences, and a designer who deleted something wants to read the
   * second one.
   */
  const applyPendingRemovals = async (): Promise<void> => {
    const operations = buildRemovalOperations()
    if (!operations.length) return
    let result: RemovalResult
    try {
      result = await applyRemovals(operations)
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not delete in code. Check the designlayer terminal, then try again", "error")
      return
    }
    // Cleared on any reply, including a partial one, for the same reason the
    // Angular queue is: a refusal that stays queued is retried by the next
    // commit, which turns one honest error into a permanent one.
    clearRemovalQueue()
    changed()
    const count = result.applied.length
    if (!result.failed.length) {
      const files = new Set(result.applied.map((entry) => entry.filePath))
      toast({ title: `Deleted ${plural(count, "element")}`, description: [...files].join(", ") })
      return
    }
    const [first] = result.failed
    const others = result.failed.length - 1
    toast(
      {
        title: `Deleted ${formatCount(count)}, skipped ${formatCount(result.failed.length)}`,
        description: `${sentence(first.reason)}${others > 0 ? ` (+${others} more)` : ""}.`,
      },
      "error"
    )
  }

  /** The React commit: fire-and-forget down the vendor's socket. */
  const applyReactBatch = (): void => {
    const operations = bridge.store.buildBatchOperations()
    if (!operations.length) {
      toast(NO_SOURCE, "error")
      return
    }
    bridge.send({ type: "commitBatch", operations })
    // The store hands over what it held and is emptied, so the button goes
    // quiet and a second Apply does not write the same changes again; each
    // moved element drops its preview once the new classes arrive.
    settleAfterApply(bridge)
    /*
     * Claimed on SEND, because this lane has no reply to wait for.
     *
     * The vendor socket reports success by the page hot-reloading and reports a
     * write it could not place by doing nothing at all, so there is no later
     * moment at which this could be done more honestly. It matches what the
     * toast already says — "Applying N changes…" — and the Angular lane, which
     * DOES get a reply, demotes the rows the server refused through
     * `recordRefusedWrite`. Optimistic here, corrected there.
     */
    markEditsWritten()

    // The count only covers what became a utility class. Anything the
    // translator could not express is still on screen and is about to be lost
    // on the next hot reload, so the commit message has to name it rather than
    // report an unqualified success.
    const lost = untranslatedProperties()
    const applying = `Applying ${plural(operations.length, "change")}…`
    if (lost.length === 0) {
      toast(applying)
    } else {
      toast({ title: applying, description: `Cannot be written to code: ${lost.join(", ")}.` }, "error")
    }
  }

  /**
   * Deletions first, and awaited.
   *
   * Both passes can land in the same file, and both read it before they write
   * it. Run together, whichever finishes second writes a file it read before
   * the first one changed it, and one of the two edits is silently gone. The
   * removal goes first because it is the one whose ranges the other pass would
   * invalidate: a class rewritten into an element that is about to be deleted
   * is wasted work, while an element deleted out from under a class rewrite
   * makes the rewrite fail to find its target, which is reported.
   */
  const applyAll = async (): Promise<void> => {
    await applyPendingRemovals()
    if (isAngularHost()) {
      if (angularQueueSize() > 0) await applyAngular()
      return
    }
    if (storeHasChanges()) applyReactBatch()
  }

  return { applyAll, hasPendingChanges, pendingCount }
}
