import { DESIGN_SYSTEM_TOKEN_GROUPS } from "./design-system-manifest.mjs"

/** Trace authored CSS variables and Tailwind theme aliases to canonical tokens. */

/**
 * The `@theme` namespaces a Tailwind v4 host spells its scales with.
 *
 * These four are Tailwind's own, so they are the default rather than this app's
 * choice — but they ARE a spelling, and a host that renames or extends them
 * (`--brand-*`, `--elevation-*`) sets `tailwind.themeNamespaces` and keeps its
 * aliases. Only namespaces the editor has a role for produce a utility; see
 * `aliasUtility` in src/core/design-system.ts.
 */
export const DEFAULT_THEME_NAMESPACES = Object.freeze(["color", "radius", "text", "shadow"])

function cssDeclarations(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "")
  const declarations = []
  const scopes = []
  let start = 0
  let quote = null
  let escaped = false
  let parens = 0
  const push = (end) => {
    const match = /^(--[a-zA-Z0-9_-]+)\s*:\s*([\s\S]+)$/.exec(css.slice(start, end).trim())
    if (match) declarations.push({ name: match[1], value: match[2].trim(), scopes: [...scopes] })
  }

  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "(") parens += 1
    else if (char === ")") parens = Math.max(0, parens - 1)
    else if (parens === 0 && char === "{") {
      scopes.push(css.slice(start, index).trim())
      start = index + 1
    } else if (parens === 0 && char === ";") {
      push(index)
      start = index + 1
    } else if (parens === 0 && char === "}") {
      push(index)
      scopes.pop()
      start = index + 1
    }
  }
  return declarations
}

function aliasReference(value) {
  const match = /^var\(\s*(--[a-zA-Z0-9_-]+)(\s*,[\s\S]*)?\)$/.exec(value.trim())
  return match ? { name: match[1], fallback: Boolean(match[2]) } : null
}

function canonicalVariables(catalog) {
  const variables = new Map()
  const add = (name, id) => {
    if (!name) return
    const ids = variables.get(name) ?? new Set()
    ids.add(id)
    variables.set(name, ids)
  }
  for (const group of DESIGN_SYSTEM_TOKEN_GROUPS) {
    for (const token of catalog[group]) {
      add(token.cssVar, token.id)
      for (const cssVar of Object.values(token.cssVars ?? {})) add(cssVar, token.id)
    }
  }
  return variables
}

/**
 * Every literal a token can be recognised by, mapped back to its id.
 *
 * A Tailwind v3 host has no `@theme` block and therefore no custom property to
 * trace — its scale lives in `tailwind.config.js`, where an entry is as often a
 * bare `#f0f2f5` or `8px` as a `var()`. Without this, a v3 host resolves ZERO
 * aliases and the inspector can never say "this is `bg-canvas`".
 */
function canonicalLiterals(catalog) {
  const literals = new Map()
  const add = (value, id) => {
    if (value === null || value === undefined || value === "") return
    const key = String(value).trim().toLowerCase()
    const ids = literals.get(key) ?? new Set()
    ids.add(id)
    literals.set(key, ids)
  }
  for (const group of DESIGN_SYSTEM_TOKEN_GROUPS) {
    for (const token of catalog[group]) {
      for (const value of Object.values(token.values ?? {})) {
        if (typeof value === "string") add(value, token.id)
        if (typeof value === "number") {
          add(`${value}px`, token.id)
          add(value, token.id)
        }
      }
    }
  }
  return literals
}

export function aliasesFromCss(
  catalog,
  sources,
  { namespaces = DEFAULT_THEME_NAMESPACES, themeEntries = [] } = {}
) {
  const declarations = sources.flatMap(cssDeclarations)
  const canonical = canonicalVariables(catalog)
  // Longest first, so a namespace that contains another as a prefix wins:
  // `--text-shadow-lift` belongs to `text-shadow`, and reading it as the `text`
  // scale would file a shadow under the typography axis. Ties are broken by
  // code unit, not `localeCompare`: two names of one length cannot prefix each
  // other, so their order is only for a stable pattern, and the first
  // `localeCompare` in a process starts ICU — ~5ms of every launch, here.
  const namespacePattern = new RegExp(
    `^--(${[...namespaces]
      .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
      .map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|")})-(.+)$`
  )
  const definitions = new Map()
  for (const declaration of declarations) {
    const definition = definitions.get(declaration.name) ?? { refs: new Set(), derived: false }
    const reference = aliasReference(declaration.value)
    if (reference) {
      definition.refs.add(reference.name)
      if (reference.fallback) definition.derived = true
    } else {
      definition.derived = true
    }
    definitions.set(declaration.name, definition)
  }

  const resolve = (name, trail = new Set()) => {
    if (canonical.has(name)) return { tokenIds: new Set(canonical.get(name)), ambiguous: false }
    if (trail.has(name) || !definitions.has(name)) return { tokenIds: new Set(), ambiguous: true }
    const definition = definitions.get(name)
    const tokenIds = new Set()
    let ambiguous = definition.derived || definition.refs.size !== 1
    const nextTrail = new Set([...trail, name])
    for (const reference of definition.refs) {
      const result = resolve(reference, nextTrail)
      for (const id of result.tokenIds) tokenIds.add(id)
      ambiguous ||= result.ambiguous
    }
    return { tokenIds, ambiguous: ambiguous || tokenIds.size !== 1 }
  }

  const cssVariables = []
  for (const name of definitions.keys()) {
    if (canonical.has(name)) continue
    const result = resolve(name)
    if (result.tokenIds.size === 0) continue
    cssVariables.push({ name, tokenIds: [...result.tokenIds].sort(), ambiguous: result.ambiguous })
  }

  const tailwind = []
  const seen = new Set()
  if (namespaces.length) {
    for (const declaration of declarations) {
      if (!declaration.scopes.some((scope) => /^@theme\b/.test(scope))) continue
      const match = namespacePattern.exec(declaration.name)
      if (!match || match[2].includes("--") || seen.has(declaration.name)) continue
      const result = canonical.has(declaration.name)
        ? { tokenIds: new Set(canonical.get(declaration.name)), ambiguous: false }
        : resolve(declaration.name)
      if (result.tokenIds.size === 0) continue
      seen.add(declaration.name)
      tailwind.push({
        namespace: match[1],
        name: match[2],
        cssVar: declaration.name,
        tokenIds: [...result.tokenIds].sort(),
        ambiguous: result.ambiguous || result.tokenIds.size !== 1,
      })
    }
  }

  // The v3 arm. Same resolver, different door: a theme entry names its
  // namespace and utility name directly, and its value is either a `var()` this
  // resolver already follows or a literal the catalog can be recognised by.
  const literals = themeEntries.length ? canonicalLiterals(catalog) : new Map()
  for (const entry of themeEntries) {
    const key = `${entry.namespace}:${entry.name}`
    if (seen.has(key)) continue
    const reference = aliasReference(entry.value)
    const result = reference
      ? resolve(reference.name)
      : { tokenIds: literals.get(String(entry.value).trim().toLowerCase()) ?? new Set(), ambiguous: false }
    if (result.tokenIds.size === 0) continue
    seen.add(key)
    tailwind.push({
      namespace: entry.namespace,
      name: entry.name,
      // v3 has no theme custom property. The variable the entry points at is
      // the honest answer when there is one, and "" when the entry is a literal.
      cssVar: reference ? reference.name : "",
      tokenIds: [...result.tokenIds].sort(),
      ambiguous: result.ambiguous || result.tokenIds.size !== 1,
    })
  }

  return {
    cssVariables: cssVariables.sort((a, b) => a.name.localeCompare(b.name)),
    // v3 literal entries share an empty cssVar, so namespace and name break the
    // tie and the order stays deterministic for a diff and for a test.
    tailwind: tailwind.sort(
      (a, b) =>
        a.cssVar.localeCompare(b.cssVar) ||
        a.namespace.localeCompare(b.namespace) ||
        a.name.localeCompare(b.name)
    ),
  }
}
