/** Validate the host manifest and normalize its token groups for the browser. */

export const DESIGN_SYSTEM_TOKEN_GROUPS = [
  "colors", "spacing", "radii", "textStyles", "uiTextStyles", "effects", "icons", "motion",
]

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function manifestError(label, requirement) {
  throw new Error(`Invalid design-system manifest: ${label} ${requirement}`)
}

function expectObject(value, label) {
  if (!isPlainObject(value)) manifestError(label, "must be an object")
  return value
}

function expectArray(value, label) {
  if (!Array.isArray(value)) manifestError(label, "must be an array")
  return value
}

/**
 * An axis a host simply does not have.
 *
 * Absence and malformation are different answers and only one of them is an
 * error. Figma opens a file with no text styles; it refuses a file whose text
 * styles are a number. An omitted group degrades to an empty axis — the
 * inspector already drops a row whose category is empty — while a group that is
 * PRESENT and the wrong shape still throws, because that is a host mistake the
 * silence would hide.
 */
function optionalArray(value, label) {
  if (value === undefined || value === null) return []
  return expectArray(value, label)
}

function expectString(value, label) {
  if (typeof value !== "string" || !value.trim()) manifestError(label, "must be a non-empty string")
  return value
}

function expectNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) manifestError(label, "must be a finite number")
  return value
}

function expectCustomProperty(value, label) {
  const name = expectString(value, label)
  if (!/^--[a-zA-Z0-9_-]+$/.test(name)) manifestError(label, "must be a CSS custom property")
  return name
}

function tokenId(category, name) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  return `${category}:${slug}`
}

function tokenScope(value, label) {
  if (value === undefined) return []
  return expectArray(value, label).map((entry, index) => expectString(entry, `${label}[${index}]`))
}

function textStyleCssVars(style) {
  // A host whose text styles are plain numbers — no custom-property family
  // behind them — is a design system, not a broken manifest. With no prefix the
  // style carries no variables and `tokenStyleWrites` falls back to writing the
  // literal size, leading, weight and tracking it does have.
  const prefix =
    style.cssPrefix === undefined || style.cssPrefix === null
      ? null
      : expectCustomProperty(style.cssPrefix, `${style.name}.cssPrefix`)
  const vars = prefix
    ? {
        fontSize: `${prefix}-size`,
        lineHeight: `${prefix}-leading`,
        fontWeight: `${prefix}-weight`,
        letterSpacing: `${prefix}-tracking`,
      }
    : {}
  if (typeof style.cssUtility === "string" && style.cssUtility.startsWith("text-")) {
    const utility = `--text-${style.cssUtility.slice(5)}`
    Object.assign(vars, {
      utilityFontSize: utility,
      utilityLineHeight: `${utility}--line-height`,
      utilityLetterSpacing: `${utility}--letter-spacing`,
      utilityFontWeight: `${utility}--font-weight`,
    })
  }
  return vars
}

function uiTextStyleCssVars(style) {
  // Same tolerance as the authored family above: a UI text style is normally
  // named by a Tailwind `text-*` utility, but a host that ships bare numbers
  // gets an empty variable set rather than a refused manifest.
  if (style.cssUtility === undefined || style.cssUtility === null) return {}
  const utility = expectString(style.cssUtility, `${style.name}.cssUtility`)
  if (!utility.startsWith("text-")) return {}
  const base = `--text-${utility.slice(5)}`
  return { fontSize: base, lineHeight: `${base}--line-height`, letterSpacing: `${base}--letter-spacing` }
}

/**
 * The unit a manifest states its letter-spacing in.
 *
 * Declared, never guessed. `em` and `px` are both ordinary spellings of
 * tracking, and the numbers overlap — `-0.5px` and `-0.5em` are both plausible
 * — so any rule that reads the unit off the magnitude is a rule that is right
 * for one host by accident.
 */
export const TRACKING_UNITS = ["em", "px"]
export const DEFAULT_TRACKING_UNIT = "em"

export function normalizeTrackingUnit(value, label = "designSystem.trackingUnit") {
  if (value === undefined || value === null) return DEFAULT_TRACKING_UNIT
  if (!TRACKING_UNITS.includes(value)) manifestError(label, `must be one of ${TRACKING_UNITS.join(", ")}`)
  return value
}

export function normalizeDesignSystemManifest(manifest, { trackingUnit } = {}) {
  expectObject(manifest, "root")
  const collections = new Map()
  for (const [index, raw] of optionalArray(manifest.collections, "collections").entries()) {
    const collection = expectObject(raw, `collections[${index}]`)
    const name = expectString(collection.name, `collections[${index}].name`)
    if (collections.has(name)) manifestError("collections", `contains duplicate ${name}`)
    collections.set(name, expectArray(collection.tokens, `${name}.tokens`))
  }
  // A collection the host does not ship is an empty axis, not a refusal. The
  // inspector drops a row whose category has no tokens, so a system with no
  // radius scale simply has no radius row.
  const collection = (name) => collections.get(name) ?? []
  const named = (raw, label) => {
    const value = expectObject(raw, label)
    return { value, name: expectString(value.name, `${label}.name`) }
  }

  const colors = collection("Color").map((raw, index) => {
    const { value, name } = named(raw, `Color.tokens[${index}]`)
    return {
      id: tokenId("color", name),
      name,
      category: "color",
      cssVar: expectCustomProperty(value.cssVar, `Color.tokens[${index}].cssVar`),
      scope: tokenScope(value.scope, `Color.tokens[${index}].scope`),
      // A single-theme system is a system. `dark` appears only when the host
      // authored one, so a light-only palette does not have to invent a second
      // value the designer never chose.
      values: {
        light: expectString(value.light, `Color.tokens[${index}].light`),
        ...(value.dark === undefined || value.dark === null
          ? {}
          : { dark: expectString(value.dark, `Color.tokens[${index}].dark`) }),
      },
      codeSyntax: isPlainObject(value.$codeSyntax) ? value.$codeSyntax : null,
    }
  })

  const scalarTokens = (collectionName, category) => collection(collectionName).map((raw, index) => {
    const label = `${collectionName}.tokens[${index}]`
    const { value, name } = named(raw, label)
    return {
      id: tokenId(category, name),
      name,
      category,
      ...(value.cssVar === undefined ? {} : { cssVar: expectCustomProperty(value.cssVar, `${label}.cssVar`) }),
      scope: tokenScope(value.scope, `${label}.scope`),
      values: { default: expectNumber(value.value, `${label}.value`) },
    }
  })

  const normalizeTextStyle = (raw, index, ui = false) => {
    const group = ui ? "uiTextStyles" : "textStyles"
    const { value, name } = named(raw, `${group}[${index}]`)
    const styleValues = {
      fontSize: expectNumber(value.size, `${group}[${index}].size`),
      lineHeight: expectNumber(value.lineHeight, `${group}[${index}].lineHeight`),
      letterSpacing: expectNumber(value.tracking, `${group}[${index}].tracking`),
    }
    if (value.weight !== undefined) styleValues.fontWeight = expectNumber(value.weight, `${group}[${index}].weight`)
    return {
      id: tokenId("typography", name),
      name,
      category: "typography",
      cssVars: ui ? uiTextStyleCssVars(value) : textStyleCssVars(value),
      ...(typeof value.cssUtility === "string" ? { cssUtility: value.cssUtility } : {}),
      values: { default: styleValues },
    }
  }

  const effects = optionalArray(manifest.effectStyles, "effectStyles").map((raw, index) => {
    const label = `effectStyles[${index}]`
    const { value, name } = named(raw, label)
    const layers = expectArray(value.layers, `${label}.layers`).map((rawLayer, layerIndex) => {
      const layerLabel = `${label}.layers[${layerIndex}]`
      const layer = expectObject(rawLayer, layerLabel)
      return {
        color: expectString(layer.color, `${layerLabel}.color`),
        x: expectNumber(layer.x, `${layerLabel}.x`),
        y: expectNumber(layer.y, `${layerLabel}.y`),
        blur: expectNumber(layer.blur, `${layerLabel}.blur`),
        spread: expectNumber(layer.spread, `${layerLabel}.spread`),
      }
    })
    return {
      id: tokenId("shadow", name),
      name,
      category: "shadow",
      cssVar: expectCustomProperty(value.cssVar, `${label}.cssVar`),
      values: { default: layers },
    }
  })

  const icons = optionalArray(manifest.iconScale, "iconScale").map((raw, index) => {
    const label = `iconScale[${index}]`
    const { value, name } = named(raw, label)
    return {
      id: tokenId("icon-size", name),
      name,
      category: "icon-size",
      values: { default: expectNumber(value.value, `${label}.value`) },
      usage: typeof value.usage === "string" ? value.usage : "",
    }
  })

  const motion = optionalArray(manifest.motion, "motion").map((raw, index) => {
    const label = `motion[${index}]`
    const { value, name } = named(raw, label)
    return {
      id: tokenId("motion", name),
      name,
      category: "motion",
      values: { default: {
        visualDuration: expectNumber(value.visualDuration, `${label}.visualDuration`),
        bounce: expectNumber(value.bounce, `${label}.bounce`),
      } },
    }
  })

  const catalog = {
    name: typeof manifest.name === "string" ? manifest.name : "Design system",
    // Config wins over the manifest so a host can correct a file it does not
    // own; both are declarations, and neither is inferred from the numbers.
    trackingUnit: normalizeTrackingUnit(trackingUnit ?? manifest.trackingUnit, "trackingUnit"),
    colors,
    spacing: scalarTokens("Spacing", "spacing"),
    radii: scalarTokens("Radius", "radius"),
    textStyles: optionalArray(manifest.textStyles, "textStyles").map((raw, index) => normalizeTextStyle(raw, index)),
    uiTextStyles: optionalArray(manifest.uiTextStyles, "uiTextStyles").map((raw, index) => normalizeTextStyle(raw, index, true)),
    effects,
    icons,
    motion,
  }
  const ids = new Set()
  for (const group of DESIGN_SYSTEM_TOKEN_GROUPS) {
    for (const token of catalog[group]) {
      if (ids.has(token.id)) manifestError("tokens", `contains duplicate normalized id ${token.id}`)
      ids.add(token.id)
    }
  }
  return catalog
}

/** Compiling breakpoint pixels stay separate from optional design-system prose. */
function normalizeBreakpointAnnotations(value, field) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) manifestError(field, "must be an object keyed by breakpoint name")
  const annotations = {}
  for (const [name, raw] of Object.entries(value)) {
    const label = `${field}.${name}`
    const entry = expectObject(raw, label)
    annotations[name] = {
      usage: expectString(entry.usage, `${label}.usage`),
      ...(entry.owner === undefined ? {} : { owner: expectString(entry.owner, `${label}.owner`) }),
    }
  }
  return annotations
}

export function normalizeDesignSystemBreakpoints(value) {
  return normalizeBreakpointAnnotations(value, "designSystem.breakpoints")
}

export function normalizeDesignSystemContainerBreakpoints(value) {
  return normalizeBreakpointAnnotations(value, "designSystem.containerBreakpoints")
}

function normalizedBreakpointTokens(breakpoints, annotations, field, category, prefix) {
  if (!isPlainObject(breakpoints)) throw new Error(`${field} must be an object of CSS pixel values`)
  for (const name of Object.keys(annotations)) {
    if (!(name in breakpoints)) {
      manifestError(`designSystem.${field.split(".").at(-1)}.${name}`, `names a breakpoint ${field} does not define`)
    }
  }
  return Object.entries(breakpoints).map(([name, value]) => {
    if (!name.trim()) throw new Error(`${field} names must not be empty`)
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`${field}.${name} must be a non-negative finite number`)
    }
    const annotation = annotations[name]
    return {
      id: tokenId(category, name),
      name,
      category,
      prefix: `${prefix}${name}:`,
      values: { default: value },
      // Present and true only for a step the design system documents. A bare
      // Tailwind prefix still appears — it compiles, so hiding it would make the
      // inspector lie — but it is labelled as outside the system.
      documented: Boolean(annotation),
      ...(annotation?.usage ? { usage: annotation.usage } : {}),
      ...(annotation?.owner ? { owner: annotation.owner } : {}),
    }
  }).sort((a, b) => a.values.default - b.values.default)
}

export function normalizeBreakpoints(breakpoints, annotations = {}) {
  return normalizedBreakpointTokens(breakpoints, annotations, "tailwind.breakpoints", "breakpoint", "")
}

export function normalizeContainerBreakpoints(breakpoints, annotations = {}) {
  return normalizedBreakpointTokens(
    breakpoints,
    annotations,
    "tailwind.containerBreakpoints",
    "container-breakpoint",
    "@"
  )
}

export function emptyDesignSystemCatalog(
  breakpoints, annotations = {}, containerBreakpoints = {}, containerAnnotations = {},
  responsiveMeasures = [], trackingUnit = DEFAULT_TRACKING_UNIT
) {
  return {
    name: null,
    trackingUnit,
    colors: [],
    spacing: [],
    radii: [],
    textStyles: [],
    uiTextStyles: [],
    effects: [],
    icons: [],
    motion: [],
    breakpoints: normalizeBreakpoints(breakpoints, annotations),
    containerBreakpoints: normalizeContainerBreakpoints(containerBreakpoints, containerAnnotations),
    responsiveMeasures,
    aliases: { cssVariables: [], tailwind: [] },
  }
}
