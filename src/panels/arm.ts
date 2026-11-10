/**
 * Arm before a costly press: the first press arms its target and says what
 * the next press costs, a second press on the same target inside the window
 * goes, and the window closing puts the target back as it was.
 *
 *   rest  --press-->                       armed(target)   (the caller paints the warning)
 *   armed --press on the target-->         rest            (the caller goes)
 *   armed --repeat click of a double-click on the target--> armed  (swallowed)
 *   armed --press elsewhere / close / window ends-->       rest    (`restore` runs)
 *
 * A double-click is one gesture. Its second click carries `detail === 2`, and
 * treating that as the confirmation let a double-click pass a confirm meant to
 * cost two deliberate presses. The browser's own count is used rather than a
 * timer here, so the interval is the one the person set for their system.
 *
 * Six seconds is the window the notes tab's Clear all uses too; this module
 * is meant to be that tab's helper as well (`panels/inspector/tab-annotations.ts`).
 */

export const ARMED_MS = 6000

export interface Arm {
  /** The target waiting for its second press, or null. */
  target(): Element | null
  /** Whether `event` is the repeat click of a double-click on the armed target. */
  repeats(target: Element, event?: Event): boolean
  /** Arms `target`; `restore` puts it back when the arm ends without going. */
  arm(target: Element, restore: () => void): void
  disarm(): void
}

export function createArm(windowMs = ARMED_MS): Arm {
  let armed: Element | null = null
  let timer = 0
  let restore: (() => void) | null = null

  const disarm = (): void => {
    if (timer) {
      window.clearTimeout(timer)
      timer = 0
    }
    const undo = restore
    armed = null
    restore = null
    undo?.()
  }

  return {
    target: () => armed,
    repeats: (target, event) =>
      target === armed && typeof (event as MouseEvent | undefined)?.detail === "number" && (event as MouseEvent).detail > 1,
    arm(target, undo) {
      disarm()
      armed = target
      restore = undo
      timer = window.setTimeout(disarm, windowMs)
    },
    disarm,
  }
}
