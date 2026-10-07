/**
 * The `/agent` route: hand the session's outbox to the designer's coding agent.
 *
 * There is exactly one transport, and that is the whole design. The editor
 * never talks to a model itself — it writes a brief and wakes an agent the
 * designer is already running, which is why "what leaves your machine" has the
 * short answer it does.
 *
 * The handoff has two halves and needs both. The file under `<stateDir>/requests/`
 * is the durable record — it survives a restart and is there to be read later.
 * The queue push is the trigger: a file nothing watches is a note in a drawer,
 * and an agent only learns of it because it is already parked inside
 * `wait_for_change` when the push lands. Neither half substitutes for the other.
 *
 * ## There was a second transport, and it could never run
 *
 * With `ANTHROPIC_API_KEY` set, this route used to send the selected element
 * and its whole source file to the Anthropic API and apply the SEARCH/REPLACE
 * blocks that came back. It was reachable from one surface — an "Ask AI" box in
 * the inspector's Design tab — and that box is gone, because the Changes tab
 * already carried every note and edit to the same agent with more context and a
 * resolve lifecycle behind it.
 *
 * It would not have run in any case: the path needed the Anthropic SDK, which
 * was never a declared dependency of this package, so its dynamic import could
 * only fail and fall through to the handoff. Deleting it took ~180 lines no
 * request could reach, and the framework-specific editing instructions with
 * them — the agent on the other end of the handoff knows its own codebase
 * better than a prompt written here could tell it.
 */

import fs from "node:fs/promises"
import path from "node:path"

import { handoffQueue } from "./handoff.mjs"

/**
 * The selected element, in the host's own vocabulary.
 *
 * The Changes tab sends `selection: null` — its subject is a ledger, not one
 * node — so in practice this writes the "No element was selected." line and the
 * brief carries everything. It stays because the queue entry still has a
 * `selection` field an agent reads, and because the route is a plain POST: a
 * caller that does name an element must get a description of it rather than
 * silence.
 */
function describeSelection(request, framework) {
  const selection = request?.selection
  if (!selection) return "No element was selected."

  // Named as the host's own source names it. Telling an agent the `className`
  // of an element whose template says `class` is a small lie that sends it
  // looking for a JSX attribute in a `.html` file.
  const classAttribute = framework === "angular" ? "class" : "className"
  const lines = [
    `- Tag: <${selection.tagName}>`,
    `- Component: ${selection.componentName || "unknown"}`,
    `- ${classAttribute}: ${selection.className || "(none)"}`,
    `- Text: ${selection.text ? JSON.stringify(selection.text) : "(none)"}`,
  ]
  if (selection.rect) {
    const { width, height, x, y } = selection.rect
    lines.push(`- Rendered box: ${width}x${height} at (${x}, ${y})`)
  }
  if (selection.source) {
    lines.push(`- Source: ${selection.source.filePath}:${selection.source.lineNumber}`)
  }
  if (Array.isArray(request.ancestry) && request.ancestry.length > 0) {
    const chain = request.ancestry
      .map((node) => `<${node.tagName}${node.className ? ` class="${node.className}"` : ""}>`)
      .join(" < ")
    lines.push(`- Ancestors (closest first): ${chain}`)
  }
  if (request.url) lines.push(`- Page: ${request.url}`)
  return lines.join("\n")
}

function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return slug || "request"
}

async function writeHandoff(config, prompt, request) {
  const queue = handoffQueue()
  const requestsDir = path.join(config.stateDir, "requests")
  await fs.mkdir(requestsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const file = path.join(requestsDir, `${stamp}-${slugify(prompt)}.md`)

  // The brief IS the request, so the durable record has to hold it.
  //
  // It used to hold only the subject line and a description of the selected
  // element, which was survivable while an "Ask AI" box was the surface that
  // filed these: its prompt WAS the whole intent. The outbox is not like that
  // — its prompt is "3 notes and 2 edits from DesignLayer" and every word
  // of substance is in `brief`. Leaving it out left a file on disk recording a
  // count and "No element was selected.", which is not a record of anything.
  const brief = typeof request?.brief === "string" ? request.brief.trim() : ""
  const body = [
    `# DesignLayer request`,
    "",
    `Captured ${new Date().toISOString()}`,
    "",
    "## Requested change",
    "",
    prompt,
    "",
    ...(brief ? ["## Brief", "", brief, ""] : []),
    "## Selected element",
    "",
    describeSelection(request, config.host?.framework ?? "react"),
    "",
  ].join("\n")

  await fs.writeFile(file, body, "utf8")
  const handoffPath = path.relative(config.projectRoot, file)

  // Read BEFORE the push: pushing wakes every waiter, so asking afterwards
  // always reports zero and the message could never say an agent was there.
  const waiting = queue.waiting
  const listening = queue.endpointListening

  // The queue is in-memory and the push is the optional half of the handoff: a
  // failure here must not cost the designer the brief already written to disk.
  let delivered = null
  try {
    delivered = queue.push({
      // "prompts" is the only surface that files these, and saying so is not a
      // formality: it tells the agent the intent is already written in `brief`
      // rather than something it has to ask about. Anything else reaching this
      // route is a bare POST with no outbox behind it, and `handoffQueue` calls
      // that "unknown" — which is the true answer, and better than inheriting
      // the name of a panel that no longer exists.
      origin: request?.origin === "prompts" ? "prompts" : undefined,
      prompt,
      brief: typeof request?.brief === "string" ? request.brief : "",
      url: request?.url ?? null,
      framework: config.host?.framework ?? "react",
      selection: request?.selection ?? null,
      ancestry: Array.isArray(request?.ancestry) ? request.ancestry : [],
      files: filesIn(request),
      handoffPath,
    })
  } catch {
    delivered = null
  }

  return {
    ok: true,
    message: handoffMessage({ delivered, waiting, listening }),
    handoffPath,
    changeId: delivered?.id ?? null,
  }
}

/**
 * What the toast says, and it must not claim more than happened.
 *
 * Three states that look alike from the browser and are not:
 *
 *  - an agent is parked in `wait_for_change` right now, so the click has
 *    already woken it;
 *  - the endpoint is up but nothing is asking yet — real, and it will arrive;
 *  - the endpoint never bound. `ports.mcp` is `null`, or a second editor
 *    session already holds the port. Nothing will EVER call the tool, and the
 *    only warning about it went to a terminal the designer is not reading. A
 *    "sent!" here is the worst outcome in the feature: they wait for an agent
 *    that cannot hear them.
 *
 * The first message has to say that nothing was edited, because MCP is the only
 * way out of this editor: no agent attached means the brief is sitting in a
 * file and nothing on this machine has read it.
 */
function handoffMessage({ delivered, waiting, listening }) {
  if (delivered === null || !listening) {
    return "Queued to the handoff file — no agent is attached over MCP, so nothing was edited. Copy the brief, or point an agent at the MCP endpoint."
  }
  if (waiting > 0) {
    return "Delivered to your coding agent — it was waiting and has just picked this up."
  }
  return "Queued for your coding agent. It arrives the next time the agent calls wait_for_change."
}

/** Every distinct source file this request touches, for the agent's first read. */
function filesIn(request) {
  const files = new Set()
  const selected = request?.selection?.source?.filePath
  if (typeof selected === "string" && selected) files.add(selected)
  if (Array.isArray(request?.files)) {
    for (const file of request.files) if (typeof file === "string" && file) files.add(file)
  }
  return [...files]
}

export function createAgent(config) {
  return {
    async runAgent(request) {
      const prompt = typeof request?.prompt === "string" ? request.prompt.trim() : ""
      if (!prompt) return { ok: false, message: "Nothing to hand over." }

      return writeHandoff(config, prompt, request)
    },
  }
}
