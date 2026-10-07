/**
 * A selected instance's variant axes, in the browser.
 *
 * The axes themselves are read from source by `server/variants.mjs`; this half
 * fetches them for the file the selection came from, decides which declaration
 * in that file the element is actually wearing, and works out which option each
 * axis is currently on by looking at the live class list.
 *
 * That last part is deliberately evidence-based rather than name-based. A file
 * can hold two variant factories, a component can be renamed, and a call site
 * can hand-modify the instance — so the only trustworthy question is "which of
 * these class strings is on this element right now", and the only honest answer
 * when none of them is, is `null`: mixed, not silently the default.
 */

export interface VariantOption {
  name: string
  /** The classes this option contributes. Empty for an option that adds none. */
  classes: string[]
  /** False when the source built the classes at runtime — offer, never apply. */
  resolved: boolean
}

export interface VariantAxis {
  name: string
  options: VariantOption[]
  /** The `defaultVariants` entry, when the component declares one. */
  defaultOption: string | null
}

export interface VariantDeclaration {
  /** The variable the factory call is assigned to, e.g. `buttonVariants`. */
  name: string
  /** Which recognizer matched — `cva`, `tailwind-variants`, or a host's own. */
  recognizer: string
  axes: VariantAxis[]
}

/** Resolved per file. `[]` is a real answer: this file declares no variants. */
const cache = new Map<string, VariantDeclaration[]>()
const inFlight = new Map<string, Promise<VariantDeclaration[]>>()

/** What is already loaded for this file, or `null` when nothing has been asked. */
export function loadedVariants(filePath: string): VariantDeclaration[] | null {
  return cache.get(filePath) ?? null
}

/** When each file's last request failed — see `RETRY_MS`. */
const failedAt = new Map<string, number>()

/**
 * How long a failure stands before the file is asked about again.
 *
 * A failure is not cached as "no variants": a dev server still compiling
 * should be asked again. But not on every render. The Instance section asks
 * whenever nothing is loaded, and it renders on every commit, refresh and
 * nudge frame, so an answer of 404 or 500 turned a held arrow key into one
 * request per frame. Ten seconds is long enough to stop that and short enough
 * that a server which has finished compiling is heard on the next selection.
 */
const RETRY_MS = 10_000

/** The declarations in one source file, fetched once. */
export function loadVariants(apiBase: string, filePath: string): Promise<VariantDeclaration[]> {
  const known = cache.get(filePath)
  if (known) return Promise.resolve(known)
  const pending = inFlight.get(filePath)
  if (pending) return pending
  const failed = failedAt.get(filePath)
  if (failed !== undefined && Date.now() - failed < RETRY_MS) return Promise.resolve([])

  const request = fetch(`${apiBase}/variants?file=${encodeURIComponent(filePath)}`, {
    headers: { accept: "application/json" },
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as { declarations?: VariantDeclaration[] }
      const declarations = Array.isArray(payload.declarations) ? payload.declarations : []
      cache.set(filePath, declarations)
      failedAt.delete(filePath)
      inFlight.delete(filePath)
      return declarations
    })
    .catch(() => {
      failedAt.set(filePath, Date.now())
      inFlight.delete(filePath)
      return []
    })

  inFlight.set(filePath, request)
  return request
}

function classList(element: Element): Set<string> {
  return new Set((element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean))
}

/**
 * Which option of this axis the element is on, or `null` for mixed.
 *
 * Every class the option contributes has to be present. A partial match is a
 * hand-modified instance — tailwind-merge drops a conflicting utility at the
 * call site — and calling that "secondary" would be a lie the picker then acts
 * on. The longest full match wins, so an option that is a superset of another
 * is not shadowed by it.
 */
export function currentOption(element: Element, axis: VariantAxis): string | null {
  const present = classList(element)
  let best: VariantOption | null = null
  for (const option of axis.options) {
    if (!option.resolved || option.classes.length === 0) continue
    if (!option.classes.every((name) => present.has(name))) continue
    if (!best || option.classes.length > best.classes.length) best = option
  }
  return best?.name ?? null
}

/** Axes whose option the element is demonstrably on — the match evidence. */
function matchedAxes(element: Element, declaration: VariantDeclaration): number {
  let matched = 0
  for (const axis of declaration.axes) {
    if (currentOption(element, axis) !== null) matched += 1
  }
  return matched
}

/**
 * Which of the file's declarations this element is an instance of.
 *
 * `null` when the element wears none of them, which is the common case: most
 * nodes in a file that exports a variant factory are not instances of it, and
 * the section that calls this must draw nothing for them.
 */
export function matchDeclaration(
  element: Element,
  declarations: readonly VariantDeclaration[]
): VariantDeclaration | null {
  let best: VariantDeclaration | null = null
  let bestScore = 0
  for (const declaration of declarations) {
    const score = matchedAxes(element, declaration)
    if (score > bestScore) {
      best = declaration
      bestScore = score
    }
  }
  return best
}

/**
 * The class swap that moves one axis to another option.
 *
 * Every other option's classes that are on the element come off, so choosing
 * twice in a row cannot accumulate two variants' worth of utilities, and the
 * classes the incoming option shares with the outgoing one are never removed
 * and re-added.
 */
export function variantClassWrite(
  element: Element,
  axis: VariantAxis,
  optionName: string
): { remove: string[]; add: string[] } | null {
  const next = axis.options.find((option) => option.name === optionName)
  if (!next || !next.resolved) return null
  const present = classList(element)
  const keep = new Set(next.classes)

  const remove = new Set<string>()
  for (const option of axis.options) {
    if (option.name === optionName || !option.resolved) continue
    for (const name of option.classes) {
      if (present.has(name) && !keep.has(name)) remove.add(name)
    }
  }
  const add = next.classes.filter((name) => !present.has(name))
  return { remove: [...remove], add }
}
