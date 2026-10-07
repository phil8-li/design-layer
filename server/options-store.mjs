/**
 * Durable storage for saved option sets.
 *
 * One JSON file under the host's state directory, written atomically and read
 * back through the same normaliser the routes use. Everything the editor
 * persists lives there so nothing it writes can be mistaken for product source.
 *
 * The directory comes from the resolved config, never from `import.meta.url`:
 * once this package is installed, `../../` is `node_modules/`, and every saved
 * option would land inside a dependency instead of the host project.
 */

import fs from "node:fs/promises"
import path from "node:path"

const MAX_OPTIONS_PER_SET = 40
const MAX_NAME = 120
const MAX_VALUE = 2000
/** Mirrors `STYLE_SCOPES` in src/options/scopes.ts. */
const STYLE_SCOPES = new Set(["typography", "fill", "stroke", "effects", "appearance", "layout"])

function normalizeOption(value) {
  if (!value || typeof value !== "object") return null
  if (typeof value.id !== "string" || value.id.length === 0) return null

  const style = {}
  if (value.style && typeof value.style === "object" && !Array.isArray(value.style)) {
    for (const [property, raw] of Object.entries(value.style)) {
      if (typeof raw === "string") style[property] = raw.slice(0, MAX_VALUE)
    }
  }

  const name = typeof value.name === "string" ? value.name.trim() : ""
  const option = {
    id: value.id.slice(0, 64),
    name: name ? name.slice(0, MAX_NAME) : "Option",
    className: typeof value.className === "string" ? value.className.slice(0, MAX_VALUE) : "",
    style,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
  }
  if (typeof value.text === "string") option.text = value.text.slice(0, MAX_VALUE)
  // A scope the client does not know would file the style under no section,
  // where nothing could show or delete it, so only the known ones survive.
  if (STYLE_SCOPES.has(value.scope)) option.scope = value.scope
  return option
}

/** Returns a stored-shaped set, or null when the payload is unusable. */
export function normalizeOptionSet(value, key) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null

  const options = Array.isArray(value.options)
    ? value.options.map(normalizeOption).filter(Boolean).slice(0, MAX_OPTIONS_PER_SET)
    : []
  const active =
    typeof value.activeOptionId === "string" &&
    options.some((option) => option.id === value.activeOptionId)
      ? value.activeOptionId
      : null

  return {
    key,
    label: typeof value.label === "string" && value.label ? value.label.slice(0, MAX_NAME) : key,
    activeOptionId: active,
    options,
  }
}

/**
 * One store per state directory. Reads and writes are serialised inside it:
 * two panels saving at once must not both read the same file and clobber each
 * other's set.
 */
export function createOptionsStore({ stateDir }) {
  const storeDir = path.resolve(stateDir)
  const optionsFile = path.join(storeDir, "options.json")
  let queue = Promise.resolve()

  function serial(task) {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  // Null-prototype on EVERY path, including the empty ones: element keys come
  // from the page, and `sets["__proto__"] = value` on a plain object reassigns
  // the prototype instead of storing a set — so a cold start with no file yet
  // silently dropped the first save of any element keyed `__proto__`.
  async function readFileSets() {
    let parsed
    try {
      parsed = JSON.parse(await fs.readFile(optionsFile, "utf8"))
    } catch {
      // Missing or corrupt: the editor keeps working and the next write heals it.
      return Object.create(null)
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Object.create(null)
    }

    const sets = Object.create(null)
    for (const [key, value] of Object.entries(parsed)) {
      const set = normalizeOptionSet(value, key)
      if (set) sets[key] = set
    }
    return sets
  }

  async function writeFileSets(sets) {
    await fs.mkdir(storeDir, { recursive: true })
    const temp = `${optionsFile}.${process.pid}.tmp`
    await fs.writeFile(temp, `${JSON.stringify(sets, null, 2)}\n`, "utf8")
    await fs.rename(temp, optionsFile)
  }

  return {
    storeDir,

    readOptionSets() {
      return serial(readFileSets)
    },

    writeOptionSet(set) {
      return serial(async () => {
        const sets = await readFileSets()
        sets[set.key] = set
        await writeFileSets(sets)
        return set
      })
    },

    deleteOptionSet(key) {
      return serial(async () => {
        const sets = await readFileSets()
        if (!Object.hasOwn(sets, key)) return false
        delete sets[key]
        await writeFileSets(sets)
        return true
      })
    },
  }
}
