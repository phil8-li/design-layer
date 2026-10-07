/**
 * A component's declared variant axes, read out of its source file.
 *
 * This is Figma's instance-properties block: select an instance and the panel
 * offers the axes the component declares — `variant`, `size` — as pickers. In a
 * React codebase those axes are not metadata, they are a call to a
 * variant-factory helper, so the only honest place to read them is the AST.
 *
 * Nothing here knows this host. A recognizer is `{ id, callee, optionsArgument }`
 * and the shipped list is `cva` (class-variance-authority) and `tv`
 * (tailwind-variants); a host on another helper adds one entry rather than a
 * fork. A file with no recognized call yields an empty list, never an error —
 * degrading to "this element has no variants" is the correct answer for the
 * overwhelming majority of files, so it must not cost a 500.
 */

import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

import { resolveEditableSource } from "../config.mjs"

/**
 * The shipped recognizers, and the export a host config should thread through.
 *
 * `optionsArgument` is where the `{ variants, defaultVariants }` object sits:
 * `cva(base, options)` puts it second, `tv({ base, variants })` first.
 */
export const DEFAULT_VARIANT_RECOGNIZERS = Object.freeze([
  Object.freeze({ id: "cva", callee: "cva", optionsArgument: 1 }),
  Object.freeze({ id: "tailwind-variants", callee: "tv", optionsArgument: 0 }),
])

/** Guards on a hand-written file, not product limits. */
const MAX_DECLARATIONS = 40
const MAX_AXES = 24
const MAX_OPTIONS = 64

function refusal(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function unwrap(node) {
  let current = node
  while (
    current &&
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TypeCastExpression" ||
      current.type === "ParenthesizedExpression")
  ) {
    current = current.expression
  }
  return current
}

function propertyName(property) {
  if (!property || property.type !== "ObjectProperty" || property.computed) return null
  const key = property.key
  if (key.type === "Identifier") return key.name
  if (key.type === "StringLiteral" || key.type === "NumericLiteral") return String(key.value)
  // `{ true: "…" }` — cva's boolean axes, which parse as a keyword key.
  if (key.type === "BooleanLiteral") return String(key.value)
  return null
}

function objectProperty(object, name) {
  if (!object || object.type !== "ObjectExpression") return null
  for (const property of object.properties) {
    if (propertyName(property) === name) return property
  }
  return null
}

/**
 * The class string an option contributes, or `null` when it is not statically
 * readable.
 *
 * `null` is not the same as `[]`: `default: ""` is a real, empty, statically
 * known option, while `default: someExpression` is an option whose classes this
 * process cannot know — and an option whose classes are unknown must not be
 * offered as something to apply.
 */
function classesOf(node) {
  const value = unwrap(node)
  if (!value) return null
  if (value.type === "StringLiteral") return value.value.split(/\s+/).filter(Boolean)
  if (value.type === "TemplateLiteral") {
    if (value.expressions.length > 0) return null
    return value.quasis.map((quasi) => quasi.value.cooked ?? "").join(" ").split(/\s+/).filter(Boolean)
  }
  if (value.type === "ArrayExpression") {
    const classes = []
    for (const element of value.elements) {
      const part = classesOf(element)
      if (part === null) return null
      classes.push(...part)
    }
    return classes
  }
  return null
}

function literalName(node) {
  const value = unwrap(node)
  if (!value) return null
  if (value.type === "StringLiteral") return value.value
  if (value.type === "NumericLiteral" || value.type === "BooleanLiteral") return String(value.value)
  return null
}

function axesOf(optionsObject) {
  const variants = unwrap(objectProperty(optionsObject, "variants")?.value)
  if (variants?.type !== "ObjectExpression") return []

  const defaults = unwrap(objectProperty(optionsObject, "defaultVariants")?.value)
  const axes = []

  for (const property of variants.properties) {
    if (axes.length >= MAX_AXES) break
    const name = propertyName(property)
    if (!name) continue
    const optionsObjectNode = unwrap(property.value)
    if (optionsObjectNode?.type !== "ObjectExpression") continue

    const options = []
    for (const option of optionsObjectNode.properties) {
      if (options.length >= MAX_OPTIONS) break
      const optionName = propertyName(option)
      if (!optionName) continue
      const classes = classesOf(option.value)
      options.push({
        name: optionName,
        classes: classes ?? [],
        // False for an option built at runtime: the picker offers the name but
        // must not pretend it knows which classes to swap in.
        resolved: classes !== null,
      })
    }
    if (!options.length) continue

    const declaredDefault =
      defaults?.type === "ObjectExpression"
        ? literalName(objectProperty(defaults, name)?.value)
        : null
    axes.push({
      name,
      options,
      defaultOption: options.some((option) => option.name === declaredDefault)
        ? declaredDefault
        : null,
    })
  }

  return axes
}

/** Every node in the tree, without needing `@babel/traverse` as a dependency. */
function* walk(node) {
  if (!node || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const item of node) yield* walk(item)
    return
  }
  if (typeof node.type !== "string") return
  yield node
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue
    if (value && typeof value === "object") yield* walk(value)
  }
}

function recognizerFor(callee, recognizers) {
  const node = unwrap(callee)
  const name =
    node?.type === "Identifier"
      ? node.name
      : node?.type === "MemberExpression" && !node.computed && node.property.type === "Identifier"
        ? node.property.name
        : null
  if (!name) return null
  return recognizers.find((entry) => entry.callee === name) ?? null
}

/**
 * Every variant declaration in one file, in source order.
 *
 * Keyed by the variable it is assigned to (`buttonVariants`) rather than by a
 * component name: the assignment is the only name that exists at this level, and
 * the client picks between declarations by matching class strings against the
 * live element, which is evidence rather than a naming convention.
 */
export function parseVariantDeclarations(source, options = {}) {
  const recognizers = options.recognizers ?? DEFAULT_VARIANT_RECOGNIZERS
  if (!recognizers.length) return []
  // A declaration is a call whose callee NAME is written in the file, so a file
  // that never spells one cannot hold a declaration — and that is most files,
  // which then skip a parse that costs milliseconds on its own the first time
  // the parser runs. A `\u` escape is the one way to write an identifier
  // without spelling it, so a file holding one is parsed as before.
  if (!source.includes("\\u") && !recognizers.some((entry) => source.includes(entry.callee))) return []
  const parse = options.parse ?? defaultParse()

  let ast
  try {
    ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: true })
  } catch {
    // An unparseable file is a file with no variants we can prove. The panel
    // section it feeds is optional, so this is a shrug, not a failure.
    return []
  }

  const declarations = []
  for (const node of walk(ast.program)) {
    if (declarations.length >= MAX_DECLARATIONS) break
    if (node.type !== "VariableDeclarator") continue
    const init = unwrap(node.init)
    if (init?.type !== "CallExpression") continue
    const recognizer = recognizerFor(init.callee, recognizers)
    if (!recognizer) continue
    const optionsObject = unwrap(init.arguments[recognizer.optionsArgument])
    if (optionsObject?.type !== "ObjectExpression") continue
    const axes = axesOf(optionsObject)
    if (!axes.length) continue
    declarations.push({
      name: node.id?.type === "Identifier" ? node.id.name : "",
      recognizer: recognizer.id,
      axes,
    })
  }
  return declarations
}

let cachedParse = null
function defaultParse() {
  if (!cachedParse) ({ parse: cachedParse } = createRequire(import.meta.url)("@babel/parser"))
  return cachedParse
}

/**
 * The file reader behind the route.
 *
 * `config.variants?.recognizers`, when a host config grows that key, replaces
 * the shipped list; until then the shipped list is the whole contract.
 */
export function createVariantCatalog(config, options = {}) {
  const recognizers = options.recognizers ?? config.variants?.recognizers ?? DEFAULT_VARIANT_RECOGNIZERS

  const hostRequire = createRequire(path.join(config.projectRoot, "package.json"))
  let parse
  try {
    ;({ parse } = hostRequire("@babel/parser"))
  } catch {
    parse = defaultParse()
  }

  /**
   * Keyed by absolute path; invalidated by mtime and size, because this is a dev
   * server and an editor's save can land inside one mtime tick.
   */
  const cache = new Map()

  return {
    recognizers: recognizers.map((entry) => entry.id),

    read(requested) {
      const raw = typeof requested === "string" ? requested.trim() : ""
      if (!raw) throw refusal("A variants lookup needs a file")
      // The browser knows a Vite module as `/src/Card.jsx`; the shared resolver
      // is what retries that against the project root instead of refusing it.
      const absolute = resolveEditableSource(config, raw)
      if (!absolute) throw refusal("That file is outside the editable source roots", 403)
      const relative = path.relative(config.projectRoot, absolute)

      let stats
      try {
        stats = fs.statSync(absolute)
      } catch {
        throw refusal("That file could not be read", 404)
      }

      const cached = cache.get(absolute)
      if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.payload

      const declarations = parseVariantDeclarations(fs.readFileSync(absolute, "utf8"), {
        recognizers,
        parse,
      })
      const payload = { file: relative, recognizers: recognizers.map((entry) => entry.id), declarations }
      cache.set(absolute, { mtimeMs: stats.mtimeMs, size: stats.size, payload })
      return payload
    },
  }
}
