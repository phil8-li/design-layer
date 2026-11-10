/**
 * The editor's own preferences in `localStorage`: the theme, the panel widths,
 * the launcher's corner.
 *
 * One guard for all of them, because every one of them needs the same one.
 * `localStorage` does not return null when an origin's storage is blocked —
 * Safari with cross-site tracking prevention, Chrome with third-party cookies
 * off and this overlay served from the proxy, or any browser in a hardened
 * profile — it THROWS on property access, and these reads run during boot. An
 * unguarded read there does not cost a preference, it costs the whole editor.
 * So a read that fails answers null (the caller's default wins) and a write
 * that fails is dropped (the gesture still worked; it just will not outlive
 * the tab).
 *
 * Per editor origin, and that is a known limit rather than a choice: each app
 * runs its editor on its own proxy port, so two apps keep two themes.
 */

/** The stored string, or null when there is none or storage is blocked. */
export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Blocked or full storage: see the note above.
  }
}

/**
 * The stored JSON, passed through `parse`, or null when there is none, it does
 * not parse, or `parse` rejects it. `parse` is where the caller validates the
 * shape: a hand-edited or stale entry must not mount the editor broken.
 */
export function readJsonPref<T>(key: string, parse: (value: unknown) => T | null): T | null {
  const raw = readPref(key)
  if (!raw) return null
  try {
    return parse(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeJsonPref(key: string, value: unknown): void {
  writePref(key, JSON.stringify(value))
}
