/** Surgical reads and writes for an explicitly configured control-default map. */

import fs from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"

import { isEditableSourcePath } from "../config.mjs"

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
  if (property.key.type === "Identifier") return property.key.name
  if (property.key.type === "StringLiteral" || property.key.type === "NumericLiteral") {
    return String(property.key.value)
  }
  return null
}

function ownProperty(object, name) {
  const matches = object.properties.filter((property) => propertyName(property) === name)
  if (matches.length > 1) throw refusal(`Default key ${JSON.stringify(name)} is declared more than once`)
  return matches[0] ?? null
}

function literalValue(node) {
  const value = unwrap(node)
  if (!value) throw refusal("Configured default is not a literal")
  if (value.type === "StringLiteral" || value.type === "NumericLiteral" || value.type === "BooleanLiteral") {
    return value.value
  }
  if (value.type === "NullLiteral") return null
  if (
    value.type === "UnaryExpression" &&
    value.operator === "-" &&
    value.argument?.type === "NumericLiteral"
  ) {
    return -value.argument.value
  }
  throw refusal("Configured default is dynamic; only string, number, boolean, and null literals are editable")
}

function serializeLiteral(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  throw refusal("Default value must be a finite number, string, boolean, or null")
}

function parseObject(parse, source, exportName) {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
    errorRecovery: false,
  })
  const matches = []
  for (const statement of ast.program.body) {
    if (statement.type !== "ExportNamedDeclaration") continue
    const declaration = statement.declaration
    if (declaration?.type !== "VariableDeclaration") continue
    for (const item of declaration.declarations) {
      if (item.id?.type === "Identifier" && item.id.name === exportName) matches.push(item)
    }
  }
  if (matches.length !== 1) {
    throw refusal(`Expected exactly one exported const named ${exportName}`, 409)
  }
  const object = unwrap(matches[0].init)
  if (object?.type !== "ObjectExpression") {
    throw refusal(`Export ${exportName} must be an object literal`, 409)
  }
  return object
}

function objectValue(property, label) {
  const value = unwrap(property?.value)
  if (value?.type !== "ObjectExpression") throw refusal(`${label} must be an object literal`, 409)
  return value
}

function hasDynamicMembers(object) {
  return object.properties.some(
    (property) =>
      property.type === "SpreadElement" ||
      property.type === "ObjectMethod" ||
      (property.type === "ObjectProperty" && property.computed)
  )
}

function lineStart(source, offset) {
  return source.lastIndexOf("\n", offset - 1) + 1
}

function lineEnd(source, offset) {
  const end = source.indexOf("\n", offset)
  return end === -1 ? source.length : end + 1
}

function indentAt(source, offset) {
  const start = lineStart(source, offset)
  const prefix = source.slice(start, offset)
  return /^\s*$/.test(prefix) ? prefix : null
}

function patchesForInsert(source, object, key, serialized) {
  if (hasDynamicMembers(object)) {
    throw refusal("Cannot add a default beside computed, method, or spread members", 409)
  }
  const properties = object.properties.filter((property) => property.type === "ObjectProperty")
  const close = object.end - 1
  const quoted = JSON.stringify(key)

  if (properties.length === 0) {
    const closeIndent = indentAt(source, close)
    if (closeIndent !== null && lineStart(source, close) > object.start) {
      return [{ start: lineStart(source, close), end: lineStart(source, close), text: `${closeIndent}  ${quoted}: ${serialized}\n` }]
    }
    return [{ start: close, end: close, text: `${quoted}: ${serialized}` }]
  }

  const first = properties[0]
  const last = properties[properties.length - 1]
  const childIndent = indentAt(source, first.start)
  const closeLine = lineStart(source, close)
  if (childIndent !== null && closeLine > last.end) {
    const between = source.slice(last.end, closeLine)
    const patches = []
    if (!between.includes(",")) patches.push({ start: last.end, end: last.end, text: "," })
    patches.push({ start: closeLine, end: closeLine, text: `${childIndent}${quoted}: ${serialized},\n` })
    return patches
  }

  return [{ start: close, end: close, text: `, ${quoted}: ${serialized}` }]
}

function patchForDelete(source, object, property) {
  const start = lineStart(source, property.start)
  const end = lineEnd(source, property.end)
  const before = source.slice(start, property.start)
  const after = source.slice(property.end, end).replace(/\n$/, "")
  if (/^\s*$/.test(before) && /^\s*,?\s*(?:\/\/.*)?$/.test(after)) {
    return { start, end, text: "" }
  }

  const properties = object.properties.filter((entry) => entry.type === "ObjectProperty")
  const index = properties.indexOf(property)
  const next = properties[index + 1]
  if (next) {
    const between = source.slice(property.end, next.start)
    if (/^\s*,\s*$/.test(between)) return { start: property.start, end: next.start, text: "" }
  }
  const previous = properties[index - 1]
  if (previous) {
    const between = source.slice(previous.end, property.start)
    if (/^\s*,\s*$/.test(between)) return { start: previous.end, end: property.end, text: "" }
  }
  return { start: property.start, end: property.end, text: "" }
}

function applyPatches(source, patches) {
  let next = source
  for (const patch of [...patches].sort((a, b) => b.start - a.start)) {
    next = `${next.slice(0, patch.start)}${patch.text}${next.slice(patch.end)}`
  }
  return next
}

/** One serialised editor per configured source file. */
export function createControlDefaults(config) {
  const target = config.controls?.leva?.sourceDefaults ?? null
  let queue = Promise.resolve()

  if (!target) {
    return {
      configured: false,
      read: async () => { throw refusal("Source-backed control defaults are not configured", 404) },
      write: async () => { throw refusal("Source-backed control defaults are not configured", 404) },
      remove: async () => { throw refusal("Source-backed control defaults are not configured", 404) },
    }
  }

  // Against the project root, not the working directory. A host writes
  // `src/lib/…` meaning its own src, and the start screen can be answered from
  // any folder at all — resolving against cwd put the path in whatever
  // directory the command was typed in, which is outside the project by
  // definition and refused as such.
  const file = path.resolve(config.projectRoot, target.file)
  const relative = path.relative(config.projectRoot, file)
  if (relative.startsWith("..") || path.isAbsolute(relative) || !isEditableSourcePath(config, file, relative)) {
    throw refusal("Configured control-default file is outside editable source roots", 403)
  }

  const hostRequire = createRequire(path.join(config.projectRoot, "package.json"))
  let parse
  try {
    ;({ parse } = hostRequire("@babel/parser"))
  } catch {
    ;({ parse } = createRequire(import.meta.url)("@babel/parser"))
  }

  const serial = (task) => {
    const run = queue.then(task, task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  const readSource = async () => {
    const source = await fs.readFile(file, "utf8")
    return { source, root: parseObject(parse, source, target.exportName) }
  }

  const writeSource = async (source) => {
    const temporary = `${file}.${process.pid}.tmp`
    await fs.writeFile(temporary, source, "utf8")
    await fs.rename(temporary, file)
  }

  return {
    configured: true,

    read(group, key) {
      return serial(async () => {
        const { root } = await readSource()
        const groupProperty = ownProperty(root, group)
        if (!groupProperty) return { configured: true, exists: false, value: null }
        const groupObject = objectValue(groupProperty, `Default group ${JSON.stringify(group)}`)
        const property = ownProperty(groupObject, key)
        if (!property) return { configured: true, exists: false, value: null }
        return { configured: true, exists: true, value: literalValue(property.value) }
      })
    },

    write(group, key, value) {
      return serial(async () => {
        const serialized = serializeLiteral(value)
        const { source, root } = await readSource()
        const groupProperty = ownProperty(root, group)
        let patches
        if (!groupProperty) {
          patches = patchesForInsert(source, root, group, `{ ${JSON.stringify(key)}: ${serialized} }`)
        } else {
          const groupObject = objectValue(groupProperty, `Default group ${JSON.stringify(group)}`)
          const property = ownProperty(groupObject, key)
          if (property) {
            literalValue(property.value)
            patches = [{ start: property.value.start, end: property.value.end, text: serialized }]
          } else {
            patches = patchesForInsert(source, groupObject, key, serialized)
          }
        }
        await writeSource(applyPatches(source, patches))
        return { configured: true, exists: true, value }
      })
    },

    remove(group, key) {
      return serial(async () => {
        const { source, root } = await readSource()
        const groupProperty = ownProperty(root, group)
        if (!groupProperty) return { configured: true, existed: false }
        const groupObject = objectValue(groupProperty, `Default group ${JSON.stringify(group)}`)
        const property = ownProperty(groupObject, key)
        if (!property) return { configured: true, existed: false }
        literalValue(property.value)
        await writeSource(applyPatches(source, [patchForDelete(source, groupObject, property)]))
        return { configured: true, existed: true }
      })
    },
  }
}
