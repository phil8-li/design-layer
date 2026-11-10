/**
 * Finding the one written element a live DOM node came from.
 *
 * `server/angular-source.mjs` scans a template into nodes and asks this which
 * node a browser-side descriptor names. The scoring lives on its own because it
 * is a contract, not a scanner: a node is
 *
 *   { tagName, classes[], attributes: Map<name, {value}>, nthOfType,
 *     parentTagName, parentClasses[] }
 *
 * and a descriptor is what `src/core/element-target.ts` reads off the element.
 */

/** Attributes a framework stamps on at runtime, which no source file contains. */
const RUNTIME_ATTRIBUTE = /^(?:_ng|ng-reflect-|data-de-)/

const REQUIRED_TAG_SCORE = 1

/**
 * How well a source node answers a descriptor of a live element.
 *
 * Returns `-1` for a node that is disqualified rather than merely unlikely.
 * The distinction matters: the caller needs a UNIQUE best score, and a scale
 * where impossible candidates score zero makes two impossible nodes tie.
 *
 * Every static class the source declares must be on the live element. The
 * converse is not required and must not be: `[class.active]`, `[ngClass]`,
 * `clsx(...)` and a component's own host classes all add classes at runtime
 * that were never written in the file.
 */
function scoreNode(node, descriptor) {
  if (node.tagName !== descriptor.tagName) return -1

  const live = new Set(descriptor.classes ?? [])
  for (const name of node.classes) {
    if (!live.has(name)) return -1
  }

  let score = REQUIRED_TAG_SCORE + node.classes.length * 4

  const id = node.attributes.get("id")
  if (id && descriptor.id && id.value === descriptor.id) score += 6

  if (descriptor.parentTagName && node.parentTagName === descriptor.parentTagName) score += 2
  const liveParent = new Set(descriptor.parentClasses ?? [])
  for (const name of node.parentClasses) {
    if (liveParent.has(name)) score += 1
  }

  // Static attributes the source declares and the live element still has.
  for (const [name, attribute] of node.attributes) {
    if (name === "class" || name === "style" || RUNTIME_ATTRIBUTE.test(name)) continue
    if (name.startsWith("[") || name.startsWith("(") || name.startsWith("*") || name.startsWith("#")) continue
    if (descriptor.attributes?.[name] === attribute.value) score += 2
  }

  if (typeof descriptor.nthOfType === "number" && node.nthOfType === descriptor.nthOfType) {
    score += 1
  }

  return score
}

/**
 * The one source node a descriptor names, or null when that is not a fact.
 *
 * `null` on a tie is the whole point. The alternative — taking the first of two
 * equal candidates — points the inspector and the agent at an element the user
 * was not looking at.
 */
export function matchNode(nodes, descriptor) {
  let best = null
  let bestScore = 0
  let tied = false
  for (const node of nodes) {
    const score = scoreNode(node, descriptor)
    if (score < 0) continue
    if (score > bestScore) {
      best = node
      bestScore = score
      tied = false
    } else if (score === bestScore) {
      tied = true
    }
  }
  return tied ? null : best
}
