/**
 * The one way text reaches the clipboard. Every Copy in the editor calls
 * `copyText`; `test/clipboard-cases.mjs` fails the build if anything else in
 * `src/` touches `navigator.clipboard` or the copy command.
 *
 * Each Copy used to call `navigator.clipboard.writeText` itself and, when it
 * was refused, said "Clipboard access blocked. Allow it for this site". That
 * was almost never what had happened, and there was no setting to allow.
 * Chrome refuses the async API, with no permission involved, in places this
 * editor runs every day:
 *
 *   - A frame that does not hold focus ("Document is not focused"). The Mac
 *     app shows each editor in an iframe, and the vendor's mousedown guard
 *     cancels a click's default focus move over the app, so the frame can stay
 *     unfocused while the designer works in it.
 *   - A frame whose parent did not delegate `clipboard-write` (permissions
 *     policy).
 *   - A page on an origin that is not secure, such as a LAN address, where
 *     `navigator.clipboard` does not exist.
 *
 * So the async API goes first, and anything that lacks it or refuses goes
 * through `document.execCommand("copy")`. The command needs neither focus nor
 * the policy, only the transient activation of the click or key that started
 * the copy. That is why a caller must still call this synchronously inside its
 * handler: an `await` in front of it can spend the activation both routes need.
 *
 * The command route puts the text on the copy event instead of selecting it in
 * a hidden field. A field has to take focus to be selected, and an app's focus
 * trap (any open modal) pulls focus straight back, so the field route copied
 * nothing on exactly the pages where a dialog was open. The event also carries
 * the text byte for byte, where a selection is re-serialised.
 */

/** What every Copy says when both routes refused. */
export const COPY_REFUSED = "Could not copy to the clipboard. Try again"

/** `permissionsPolicy` is the current name; Chrome still ships `featurePolicy`. */
interface PolicyDocument {
  permissionsPolicy?: { allowsFeature(feature: string): boolean }
  featurePolicy?: { allowsFeature(feature: string): boolean }
}

/**
 * False when the async API is certain to refuse, so it is not asked: Chrome
 * logs a permissions-policy violation for every refused call.
 */
function asyncApiAvailable(): boolean {
  if (typeof navigator.clipboard?.writeText !== "function") return false
  const doc = document as Document & PolicyDocument
  const policy = doc.permissionsPolicy ?? doc.featurePolicy
  return !policy || policy.allowsFeature("clipboard-write")
}

/** The copy command, carrying `text` on its event. Answers whether it landed. */
function copyWithCommand(text: string): boolean {
  if (typeof document.execCommand !== "function") return false
  let landed = false
  // Cancelling `beforecopy` is what enables the command with nothing selected.
  const enable = (event: Event): void => event.preventDefault()
  const fill = (event: Event): void => {
    const data = (event as ClipboardEvent).clipboardData
    if (!data) return
    data.setData("text/plain", text)
    event.preventDefault()
    // Window capture runs first, so the app's own copy handlers never see this
    // event and cannot put their text in place of ours.
    event.stopImmediatePropagation()
    landed = true
  }
  window.addEventListener("beforecopy", enable, true)
  window.addEventListener("copy", fill, true)
  try {
    return document.execCommand("copy") && landed
  } catch {
    return false
  } finally {
    window.removeEventListener("beforecopy", enable, true)
    window.removeEventListener("copy", fill, true)
  }
}

/**
 * Put `text` on the clipboard. Resolves true once it is there, false when
 * every route refused. Never throws.
 *
 * Call it synchronously inside the click or key handler, before any `await`.
 */
export function copyText(text: string): Promise<boolean> {
  if (!asyncApiAvailable()) return Promise.resolve(copyWithCommand(text))
  try {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => copyWithCommand(text)
    )
  } catch {
    return Promise.resolve(copyWithCommand(text))
  }
}
