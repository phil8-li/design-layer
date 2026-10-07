/**
 * Finding the one written element a live DOM node came from, and splicing it.
 *
 * Both halves used to live in `angular-source.mjs`, because Angular was the
 * only host whose source this package edited itself — React's edits go through
 * the vendored jscodeshift engine. Deleting an element is the first thing the
 * vendor cannot express, so the React lane now needs the same two answers, and
 * the scoring is not a thing worth having two of: a descriptor means the same
 * in a template and in JSX, and a second copy would drift on the day someone
 * fixed a tie-break in one of them.
 *
 * What is NOT here is the scanning. A template scanner and a JSX walker have
 * nothing in common but their output shape, and that shape is the contract:
 *
 *   { tagName, classes[], attributes: Map<name, {value}>, nthOfType,
 *     parentTagName, parentClasses[], start, end, selfClosing, closeEnd }
 */

/** Attributes a framework stamps on at runtime, which no source file contains. */
export const RUNTIME_ATTRIBUTE = /^(?:_ng|ng-reflect-|data-de-)/

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
export function scoreNode(node, descriptor) {
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
 * equal candidates — writes a style onto an element the user was not looking at,
 * and the user's only clue is that the wrong thing moved. For a deletion it is
 * worse than that: the wrong thing disappears.
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

/**
 * A byte range grown to the whole line, when the range had that line to itself.
 *
 * Cutting exactly `<div …>…</div>` out of a file is correct and looks like a
 * bug: the line stays behind holding nothing but its own indentation, and the
 * next person to open the file sees a ragged hole rather than markup with one
 * thing taken out of it. An element sharing its line with a sibling or with
 * text keeps every byte of that line that is not its own.
 */
export function lineExtendedRange(start, end, text) {
  let before = start
  while (before > 0 && (text[before - 1] === " " || text[before - 1] === "\t")) before -= 1
  const ownsLineStart = before === 0 || text[before - 1] === "\n"

  let after = end
  while (after < text.length && (text[after] === " " || text[after] === "\t")) after += 1
  const ownsLineEnd = after >= text.length || text[after] === "\n"

  if (!ownsLineStart || !ownsLineEnd) return { start, end }
  return {
    start: before,
    // The newline goes with the line, not the next one: keeping it would leave
    // an empty line behind, and taking the one BEFORE the indentation would
    // pull the previous line's break and join two unrelated lines together.
    end: after < text.length ? after + 1 : after,
  }
}

/** Splices applied back to front, the only order in which earlier offsets stay valid. */
export function applyEdits(source, edits) {
  const ordered = [...edits].sort((a, b) => b.start - a.start)
  let output = source
  let previousStart = Number.POSITIVE_INFINITY
  for (const edit of ordered) {
    // Two operations on one element can produce overlapping splices — merging
    // them is the caller's job, so an overlap here is a bug worth surfacing.
    if (edit.end > previousStart) throw new Error("overlapping edits to one file")
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
    previousStart = edit.start
  }
  return output
}
