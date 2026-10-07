import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

import { DEFAULT_THEME_NAMESPACES, aliasesFromCss } from "./design-system-aliases.mjs"
import { detectHostDesignSystem } from "./design-system-detect.mjs"
import {
  DESIGN_SYSTEM_TOKEN_GROUPS,
  emptyDesignSystemCatalog,
  normalizeBreakpoints,
  normalizeContainerBreakpoints,
  normalizeDesignSystemBreakpoints,
  normalizeDesignSystemContainerBreakpoints,
  normalizeDesignSystemManifest,
  normalizeTrackingUnit,
} from "./design-system-manifest.mjs"
import { parseLibrary } from "./library-sources.mjs"

export const DEFAULT_TAILWIND_BREAKPOINTS = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid design-system manifest: ${label} must be a non-empty string`)
  }
  return value
}

export function normalizeResponsiveMeasures(value) {
  if (value === undefined || value === null) return []
  if (!isPlainObject(value)) {
    throw new Error("Invalid design-system manifest: designSystem.responsiveMeasures must be an object")
  }
  return Object.entries(value).map(([name, raw]) => {
    const label = `designSystem.responsiveMeasures.${name}`
    if (!isPlainObject(raw)) throw new Error(`Invalid design-system manifest: ${label} must be an object`)
    return {
      id: `responsive-measure:${name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`,
      name,
      category: "responsive-measure",
      formula: requiredString(raw.formula, `${label}.formula`),
      usage: requiredString(raw.usage, `${label}.usage`),
      owner: requiredString(raw.owner, `${label}.owner`),
    }
  })
}

/**
 * Tailwind v3's theme keys, mapped to the namespaces the editor reasons in.
 *
 * v4 spells a scale as an `@theme` custom property, so the namespace is IN the
 * variable name and `aliasesFromCss` reads it off the stylesheet. v3 has no such
 * variable: the scale is a JavaScript object, and this table is the only place
 * that says `borderRadius` is what v4 calls `radius`.
 */
const V3_THEME_KEYS = {
  colors: "color",
  borderRadius: "radius",
  fontSize: "text",
  boxShadow: "shadow",
}

/** `{ brand: { 500: "#f00" } }` -> `[["brand-500", "#f00"]]`. */
function flattenThemeScale(scale, prefix = []) {
  const entries = []
  for (const [key, raw] of Object.entries(scale)) {
    const name = key === "DEFAULT" && prefix.length ? prefix.join("-") : [...prefix, key].join("-")
    if (isPlainObject(raw)) entries.push(...flattenThemeScale(raw, [...prefix, key]))
    // A v3 fontSize entry is often `["14px", { lineHeight: "20px" }]`; the size
    // is the part an alias can be traced by.
    else if (Array.isArray(raw) && typeof raw[0] === "string") entries.push([name, raw[0]])
    else if (typeof raw === "string" || typeof raw === "number") entries.push([name, String(raw)])
  }
  return entries
}

function themeEntriesFromScales(scales, label) {
  if (!isPlainObject(scales)) throw new Error(`Invalid design-system config: ${label} must be an object`)
  const entries = []
  for (const [namespace, scale] of Object.entries(scales)) {
    if (!isPlainObject(scale)) throw new Error(`Invalid design-system config: ${label}.${namespace} must be an object`)
    for (const [name, value] of flattenThemeScale(scale)) entries.push({ namespace, name, value })
  }
  return entries
}

/**
 * The v3 escape from "no `@theme`, therefore no aliases".
 *
 * `tailwindTheme` is the declared form and always works. `tailwindConfig` is the
 * convenience: it loads the host's own `tailwind.config.*` so the scale has one
 * owner rather than two. The load is `require`, which covers the CommonJS shape
 * v3 configs are almost always written in; anything it cannot evaluate says so
 * and names the declared form rather than falling back to silence.
 *
 * `detected` flips that last sentence, and only that one. A host that NAMED a
 * config file and got a path this process cannot evaluate has made a mistake it
 * needs to hear about, so the declared case still throws. A config file this
 * package went looking for and found is a guess, and a guess that kills startup
 * is worse than no guess at all: a `tailwind.config.ts` cannot be `require`d,
 * TypeScript configs are ordinary, and the failure would take the whole editor
 * down on a project that had merely been detected too eagerly. So a detected
 * config that will not load degrades to "no v3 theme", which is exactly the
 * state the project was in before detection existed.
 */
function resolveTailwindThemeEntries(value, projectRoot, detected = false) {
  if (value.tailwindTheme !== undefined && value.tailwindTheme !== null) {
    return themeEntriesFromScales(value.tailwindTheme, "designSystem.tailwindTheme")
  }
  if (value.tailwindConfig === undefined || value.tailwindConfig === null) return []
  if (typeof value.tailwindConfig !== "string" || !value.tailwindConfig.trim()) {
    throw new Error("designSystem.tailwindConfig must be a non-empty path string")
  }
  const configPath = path.resolve(projectRoot, value.tailwindConfig)
  let loaded
  try {
    loaded = createRequire(import.meta.url)(configPath)
  } catch (error) {
    if (detected) return []
    throw new Error(
      `Could not read Tailwind config ${configPath}: ${error.message}. ` +
        "Declare designSystem.tailwindTheme instead if the file cannot be required."
    )
  }
  const config = isPlainObject(loaded?.default) ? loaded.default : loaded
  const theme = isPlainObject(config?.theme) ? config.theme : {}
  const extend = isPlainObject(theme.extend) ? theme.extend : {}
  const scales = {}
  for (const [themeKey, namespace] of Object.entries(V3_THEME_KEYS)) {
    const merged = { ...(isPlainObject(theme[themeKey]) ? theme[themeKey] : {}), ...(isPlainObject(extend[themeKey]) ? extend[themeKey] : {}) }
    if (Object.keys(merged).length) scales[namespace] = merged
  }
  return themeEntriesFromScales(scales, `designSystem.tailwindConfig (${value.tailwindConfig})`)
}

/**
 * The one branch for a host whose tokens are not a Figma-style manifest.
 *
 * A design system that lives in a TypeScript module, a Style Dictionary build,
 * or a CMS is still a design system, and refusing it would make the tool care
 * where the tokens sleep. The adapter returns the same normalized catalog shape
 * the manifest path produces; everything downstream — aliases, breakpoints,
 * inspector rows — is identical, which is why this is a branch and not a plugin
 * framework.
 */
function catalogFromAdapter(adapter, projectRoot, trackingUnit) {
  const produced = typeof adapter === "function" ? adapter({ projectRoot }) : adapter
  if (!isPlainObject(produced)) {
    throw new Error("designSystem.adapter must return an object with the catalog's token groups")
  }
  const catalog = {
    name: typeof produced.name === "string" ? produced.name : "Design system",
    trackingUnit: normalizeTrackingUnit(trackingUnit ?? produced.trackingUnit),
  }
  for (const group of DESIGN_SYSTEM_TOKEN_GROUPS) {
    const tokens = produced[group]
    if (tokens !== undefined && !Array.isArray(tokens)) {
      throw new Error(`designSystem.adapter returned a non-array ${group}`)
    }
    catalog[group] = tokens ?? []
  }
  return catalog
}

/**
 * Whether the host said nothing at all about where its tokens are.
 *
 * All five inputs, not just the manifest. A project that declared `cssSources`
 * and nothing else has still declared its design system, and running detection
 * beside it would either duplicate what it said or contradict it — and the
 * contradiction is the dangerous half, because the detector's answer would
 * arrive with no config file to point at when the designer asks where a token
 * they never wrote came from.
 */
function undeclared(value) {
  return (
    !value.manifest &&
    !value.adapter &&
    value.cssSources.length === 0 &&
    (value.tailwindConfig === undefined || value.tailwindConfig === null) &&
    (value.tailwindTheme === undefined || value.tailwindTheme === null)
  )
}

/**
 * A Tailwind v3 scale, read as the token file it is.
 *
 * v3's scale is a JavaScript object with no custom property behind it, which is
 * exactly the shape `parseTokenLibrary` was written for: a build input rather
 * than a live variable, so the tokens it produces carry no `cssVar` and the
 * inspector writes the literal — which is the truth about a v3 project, where
 * `var(--color-brand)` would name a variable that does not exist anywhere in the
 * page.
 *
 * Routing through the DTCG parser rather than hand-building tokens is what keeps
 * `#f0f2f5`, `0.5rem`, `0 1px 2px rgb(0 0 0 / .05)` and `14px` classified,
 * coerced and named by the same code that reads every other token source. A
 * second value classifier here would be a second set of answers to "is this
 * paintable", and the two would disagree within a release.
 *
 * One parse per namespace, because a token file is keyed by name and `color.ink`
 * and `radius.ink` are two tokens with one key. Nesting them under their
 * namespace would work and would name them `color/ink`, which is the namespace
 * said twice in a picker that already groups by axis.
 */
const V3_TOKEN_TYPES = {
  color: { group: "colors", type: "color" },
  radius: { group: "radii", type: "borderRadius" },
  text: { group: "textStyles", type: "typography" },
  shadow: { group: "effects", type: "shadow" },
}

function tokensFromThemeEntries(themeEntries) {
  const groups = {}
  for (const [namespace, { group, type }] of Object.entries(V3_TOKEN_TYPES)) {
    const named = themeEntries.filter((entry) => entry.namespace === namespace)
    if (named.length === 0) continue
    const file = {}
    for (const entry of named) file[entry.name] = { $value: entry.value, $type: type }
    try {
      const parsed = parseLibrary("tokens", JSON.stringify(file), { name: "" })
      if (Array.isArray(parsed[group]) && parsed[group].length) groups[group] = parsed[group]
    } catch {
      // A scale whose every entry is a `var()` this catalog cannot resolve
      // contributes nothing, which is the same answer as not having the scale.
    }
  }
  return groups
}

/**
 * The catalog for a host with no manifest and no adapter — which, since
 * detection landed, is most hosts.
 *
 * This branch used to return an empty catalog unconditionally, and that single
 * `return` was the whole of the gap this module was opened to close: the
 * stylesheet parser existed, the alias reader existed, the v3 theme reader
 * existed, and all three sat behind a short-circuit that fired whenever nobody
 * had written a `designlayer.config.mjs`. Nothing new parses anything here. It
 * calls the readers that were already in the tree.
 *
 * The sources are concatenated rather than parsed one at a time because they are
 * one cascade: `--button-bg: var(--brand-600)` in an entry stylesheet can only
 * be resolved against the ramp its imported partial declares, and the light,
 * themed and dark tiers `parseCssLibrary` reasons in are properties of the whole
 * sheet rather than of any one file in it.
 *
 * CSS wins over the v3 theme on a collision, because a custom property is
 * something the page actually carries and a config entry is something a build
 * step consumed. A token the inspector can trace to a live variable is worth
 * more than the same token as a literal.
 */
function fillCatalogFromCss(catalog, css, themeEntries, trackingFromSource) {
  let parsed = null
  if (css.length) {
    try {
      parsed = parseLibrary("css", css.join("\n"), { name: "" })
    } catch {
      // A stylesheet that declares no custom properties carries no tokens. It is
      // still the project's stylesheet and it may still carry a v3 theme beside
      // it, so this is an empty contribution rather than a failure.
      parsed = null
    }
  }
  if (parsed) {
    for (const group of DESIGN_SYSTEM_TOKEN_GROUPS) {
      if (Array.isArray(parsed[group])) catalog[group] = parsed[group]
    }
    if (trackingFromSource && (parsed.trackingUnit === "em" || parsed.trackingUnit === "px")) {
      catalog.trackingUnit = parsed.trackingUnit
    }
  }

  const fromTheme = tokensFromThemeEntries(themeEntries)
  const ids = new Set(DESIGN_SYSTEM_TOKEN_GROUPS.flatMap((group) => catalog[group].map((token) => token.id)))
  for (const [group, tokens] of Object.entries(fromTheme)) {
    for (const token of tokens) {
      if (ids.has(token.id)) continue
      ids.add(token.id)
      catalog[group].push(token)
    }
  }
  return catalog
}

export function resolveDesignSystemConfig(value, projectRoot, breakpoints, containerBreakpoints = {}, tailwind = {}) {
  if (!isPlainObject(value)) throw new Error("designSystem must be an object with manifest and cssSources")
  if (value.manifest !== null && (typeof value.manifest !== "string" || !value.manifest.trim())) {
    throw new Error("designSystem.manifest must be a non-empty path string or null")
  }
  if (!Array.isArray(value.cssSources) || value.cssSources.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error("designSystem.cssSources must be an array of non-empty path strings")
  }

  const annotations = normalizeDesignSystemBreakpoints(value.breakpoints)
  const containerAnnotations = normalizeDesignSystemContainerBreakpoints(value.containerBreakpoints)
  const responsiveMeasures = normalizeResponsiveMeasures(value.responsiveMeasures)
  const trackingUnit = normalizeTrackingUnit(value.trackingUnit)
  const namespaces = Array.isArray(tailwind.themeNamespaces)
    ? tailwind.themeNamespaces.filter((entry) => typeof entry === "string" && entry.trim())
    : DEFAULT_THEME_NAMESPACES
  const detected = undeclared(value) ? detectHostDesignSystem(projectRoot) : null
  const themeEntries = resolveTailwindThemeEntries(
    detected ? { ...value, tailwindConfig: detected.tailwindConfig } : value,
    projectRoot,
    Boolean(detected)
  )
  const manifest = value.manifest ? path.resolve(projectRoot, value.manifest) : null
  const adapter = value.adapter ?? null
  const cssSources = detected
    ? detected.cssSources
    : value.cssSources.map((entry) => path.resolve(projectRoot, entry))

  const css = []
  for (const sourcePath of cssSources) {
    try {
      css.push(fs.readFileSync(sourcePath, "utf8"))
    } catch (error) {
      // A file the HOST named and this process cannot read is a mistake the host
      // has to hear about. A file this package went looking for and found a
      // moment ago can still vanish between the `stat` and the read, and taking
      // the editor down over a stylesheet nobody asked for would be the
      // detection pass introducing a failure mode the declarative path never had.
      if (detected) continue
      throw new Error(`Could not read design-system CSS source ${sourcePath}: ${error.message}`)
    }
  }

  let catalog
  if (adapter) {
    if (manifest) {
      throw new Error("designSystem takes a manifest or an adapter, not both")
    }
    catalog = catalogFromAdapter(adapter, projectRoot, value.trackingUnit)
  } else if (manifest) {
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(manifest, "utf8"))
    } catch (error) {
      throw new Error(`Could not read design-system manifest ${manifest}: ${error.message}`)
    }
    catalog = normalizeDesignSystemManifest(parsed, { trackingUnit: value.trackingUnit })
  } else {
    catalog = fillCatalogFromCss(
      emptyDesignSystemCatalog(
        breakpoints,
        annotations,
        containerBreakpoints,
        containerAnnotations,
        responsiveMeasures,
        trackingUnit
      ),
      css,
      themeEntries,
      value.trackingUnit === undefined || value.trackingUnit === null
    )
  }

  catalog.breakpoints = normalizeBreakpoints(breakpoints, annotations)
  catalog.containerBreakpoints = normalizeContainerBreakpoints(containerBreakpoints, containerAnnotations)
  catalog.responsiveMeasures = responsiveMeasures
  catalog.aliases = aliasesFromCss(catalog, css, { namespaces, themeEntries })
  return Object.freeze({
    manifest,
    cssSources: Object.freeze(cssSources),
    catalog: Object.freeze(catalog),
    // Where the tokens came from, when nobody declared it. Empty for a host that
    // did — a declared design system needs no provenance line, because the
    // person reading it wrote the config file. Project-relative strings only:
    // the prelude has never carried an absolute path.
    detectedFrom: Object.freeze(detected ? [...detected.detectedFrom] : []),
  })
}
