/**
 * Focus the editor moves itself, without lighting a keyboard ring for a mouse.
 *
 * The editor forces focus constantly. `shell.ts` refocuses the control under
 * every pointerdown on our chrome, because the vendor's document guard eats the
 * native default action; menus focus their first row when they open; closing a
 * popover puts focus back on the trigger that opened it. All of that is
 * *script* focus, and script focus is where `:focus-visible` stops being free.
 *
 * An engine cannot see what a script focus was for, so Chrome keeps the ring:
 * measured in Chrome 153, `button.focus()` during a plain mouse click makes the
 * button match `:focus-visible`, and every toolbar button the user clicked wore
 * the 2px accent ring that is supposed to mean "you are navigating by
 * keyboard". The stylesheets were never at fault — every ring in `core/css` is
 * already keyed on `:focus-visible` rather than `:focus`.
 *
 * So the modality is tracked here, in one place, and spent twice. `focusVisible`
 * on the focus call is the precise half — the one channel for telling an engine
 * what a script focus was for, and it is honoured exactly: measured in the same
 * build, `false` suppresses the ring and `true` keeps it. One stylesheet rule
 * keyed on the same modality is the blunt half, and it is not redundant: it
 * covers the control that is ALREADY focused, where there is no focus change
 * for an option to ride on, and the engines that do not implement the option.
 *
 * The rule is live, which makes this a statement about the gesture rather than
 * about the instant focus moved: reach for the mouse and the ring goes, press a
 * key and it returns on whatever still holds focus.
 */

import { CHROME_ATTR } from "./dom"

/** `lib.dom` has no `focusVisible` yet; the engines that matter do. */
interface ModalityFocusOptions extends FocusOptions {
  focusVisible?: boolean
}

/**
 * On `<html>`, not on our root: the rule below keys on an ancestor every piece
 * of chrome has, and the launcher is reparented out of `.de-root` when the
 * shell tears down.
 */
const MODALITY_ATTR = "data-de-modality"
const MODALITY_STYLE_ID = "designlayer-focus-modality"
/**
 * On whichever piece of chrome holds focus, and nothing else. The rule keys on
 * it rather than on the chrome attribute every control carries: a rule whose
 * subject is `[data-designlayer]` under `:root[…]` made each flip of the
 * modality restyle every control in the editor — about 1.5ms, landing on the
 * first key after a click, which is where Escape closing the board lives. Keyed
 * on an attribute one element carries, the flip restyles that one element.
 */
const FOCUS_ATTR = "data-de-focus"

let keyboard = false

/** True when the last thing the user did was a key, not a pointer. */
export function usingKeyboard(): boolean {
  return keyboard
}

/**
 * Focuses one of our own controls, with the ring the gesture earned.
 *
 * Takes a nullable element because most callers are reaching into a map or a
 * query that may legitimately come back empty — `focusControl(rowFor(el))`
 * reads better than the `?.focus()` chain it replaces, and keeps the modality
 * decision in one place rather than at twenty call sites.
 *
 * CONTROLS, and the six remaining bare `focus()` calls are the exception rather
 * than an oversight: a rename input, the two filters, the search, the manual
 * path field and the note composer all focus a TEXT ENTRY to be typed into.
 * Their focus reads as a caret and a border, never as an outline ring, so there
 * is nothing here for the modality to decide — and two of them commit their
 * value on `blur`, which makes their focus the last thing worth routing through
 * a shared helper.
 */
export function focusControl(
  element: HTMLElement | null | undefined,
  options: FocusOptions = {}
): void {
  if (!element) return
  const withModality: ModalityFocusOptions = { ...options, focusVisible: keyboard }
  element.focus(withModality)
}

/**
 * The second half: no keyboard ring anywhere in our chrome while the pointer is
 * what the user is driving with.
 *
 * The focus option above cannot cover two cases on its own, and both are ones a
 * user meets.
 *
 * The first is a control that is ALREADY focused. Click the button you just
 * tabbed to and `focus()` is a no-op — no focus change, so nothing reads the
 * option, so the ring the keyboard earned stays on through a gesture that is no
 * longer the keyboard's. A page without our guard never shows this, because
 * there the click's own default action does the update this rule now does.
 *
 * The second is an engine that does not implement `focusVisible` at all (Safari,
 * as of writing), where the option is ignored in silence.
 *
 * `!important` because it has to beat sixty per-component rules it knows
 * nothing about, and `outline` only: the two-tone marker rings pair their
 * outline with a `box-shadow` halo, and blanking `box-shadow` here would take
 * the marker's own drop shadow with it, which is not focus state at all. In
 * Chrome and Firefox the option has already stopped those halos one step
 * earlier, by keeping the element from matching `:focus-visible`.
 */
function installModalityRule(): void {
  if (document.getElementById(MODALITY_STYLE_ID)) return
  const style = document.createElement("style")
  style.id = MODALITY_STYLE_ID
  style.textContent =
    `:root[${MODALITY_ATTR}="pointer"] [${FOCUS_ATTR}]:focus-visible { outline: none !important; }`
  document.head.append(style)
}

function setModality(next: boolean): void {
  if (next === keyboard) return
  keyboard = next
  document.documentElement.setAttribute(MODALITY_ATTR, next ? "keyboard" : "pointer")
}

/**
 * Starts watching what the user is driving with.
 *
 * Window capture, so the answer is already correct by the time anything else on
 * the same gesture asks: `shell.ts` forces focus from its own window-capture
 * pointerdown listener, and a modality read one listener too late would be the
 * previous gesture's.
 */
export function installFocusModality(): () => void {
  const onKey = () => setModality(true)
  const onPointer = () => setModality(false)
  // Only chrome is marked, which is all the rule above ever applied to. A
  // focus inside a shadow root reaches here retargeted to its host, which is
  // the element `:focus-visible` can match from this document.
  const mark = (target: EventTarget | null) => {
    if (target instanceof Element && target.hasAttribute(CHROME_ATTR)) target.setAttribute(FOCUS_ATTR, "")
  }
  const onFocusIn = (event: FocusEvent) => mark(event.target)
  const onFocusOut = (event: FocusEvent) => {
    if (event.target instanceof Element) event.target.removeAttribute(FOCUS_ATTR)
  }

  window.addEventListener("keydown", onKey, true)
  window.addEventListener("pointerdown", onPointer, true)
  document.addEventListener("focusin", onFocusIn, true)
  document.addEventListener("focusout", onFocusOut, true)
  mark(document.activeElement)

  // Pointer first: nobody has touched anything yet, and a ring on whatever the
  // editor focuses at boot is the exact thing this module exists to prevent.
  document.documentElement.setAttribute(MODALITY_ATTR, "pointer")
  installModalityRule()

  return () => {
    window.removeEventListener("keydown", onKey, true)
    window.removeEventListener("pointerdown", onPointer, true)
    document.removeEventListener("focusin", onFocusIn, true)
    document.removeEventListener("focusout", onFocusOut, true)
    document.querySelector(`[${FOCUS_ATTR}]`)?.removeAttribute(FOCUS_ATTR)
    document.documentElement.removeAttribute(MODALITY_ATTR)
    document.getElementById(MODALITY_STYLE_ID)?.remove()
  }
}
