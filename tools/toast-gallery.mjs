#!/usr/bin/env node
/**
 * Every toast the editor raises, on one page, fired through the real toaster.
 *
 * The page bundles `src/core/toast.ts` itself — Sonner, the shadow root, the
 * editor's stylesheet, the durations and the close button — so a card shown
 * here is the card the editor shows. Nothing is mocked but the trigger.
 *
 * Three sections:
 *   - Variants: the kinds of card (info, error, info with Undo, long, stacked).
 *   - Events that toast: every call site, grouped by what the user did.
 *   - Events that stay silent: direct manipulation, by the rule in the header
 *     of `core/toast.ts`.
 *
 * Every event names the file that raises it and a fragment of its wording, and
 * the build fails when a fragment is no longer in that file — so the page
 * cannot quietly drift from the code it documents.
 *
 *   node tools/toast-gallery.mjs          # build .demos/toasts/index.html
 *   node tools/toast-gallery.mjs --open   # and open it
 */

import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { patchSonner } from "./sonner-plugin.mjs"

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const OUT = path.join(ROOT, ".demos", "toasts")

/*
 * `find` is a fragment of the call site's source text, checked below. `message`
 * is a representative rendering of it, with the template holes filled in.
 */
const EVENTS = [
  {
    group: "Handoff to the agent",
    items: [
      { event: "Copy notes and edits (Changes tab Copy, or the shortcut)", message: "Copied 2 notes and 1 edit", kind: "info", source: "src/annotations/handover.ts", find: "toast(`Copied ${outboxSummary(items)}`)" },
      { event: "Copy with nothing in the outbox", message: "Nothing to copy. Pin a note or make an edit first.", kind: "info", source: "src/annotations/handover.ts", find: "Nothing to copy. Pin a note or make an edit first." },
      { event: "Send to agent, agent was waiting", message: "Delivered to your coding agent — it was waiting and is starting a new session for this.", kind: "info", source: "server/agent.mjs", find: "Delivered to your coding agent" },
      { event: "Send to agent, agent attached but busy", message: "Queued for your coding agent. It starts a new session for this the next time the agent calls wait_for_change.", kind: "info", source: "server/agent.mjs", find: "Queued for your coding agent." },
      { event: "Send to agent, no agent attached", message: "Queued to the handoff file — no agent is attached over MCP, so nothing was edited. Copy the brief, or point an agent at the MCP endpoint.", kind: "info", source: "server/agent.mjs", find: "Queued to the handoff file" },
      { event: "Send with nothing left for the agent", message: "Nothing to send", kind: "info", source: "src/annotations/handover.ts", find: 'toast("Nothing to send")' },
      { event: "Send, server unreachable", message: "Could not reach the agent. Check that designlayer is running, then send again (Failed to fetch).", kind: "error", source: "src/ai/transport.ts", find: "Could not reach the agent. Check" },
      { event: "Send, agent route answers with an error", message: "The agent route returned an error (500). Check the designlayer terminal, then send again.", kind: "error", source: "src/ai/transport.ts", find: "The agent route returned an error (" },
      { event: "Copy the MCP address", message: { title: "Copied the MCP address", description: "Paste it into your agent’s MCP settings." }, kind: "info", source: "src/panels/inspector/tab-annotations.ts", find: 'title: "Copied the MCP address"' },
      { event: "Copy the MCP address, server not running", message: "The MCP server is not running", kind: "error", source: "src/panels/inspector/tab-annotations.ts", find: "The MCP server is not running" },
    ],
  },
  {
    group: "Clipboard",
    items: [
      { event: "Copy from the Code tab", message: "Copied JSX", kind: "info", source: "src/panels/inspector/tab-code.ts", find: "`Copied ${label}`" },
      { event: "Copy a source path", message: "Source path copied", kind: "info", source: "src/panels/inspector/section-classes.ts", find: '"Source path copied"' },
      { event: "Copy a library snippet", message: "Copied the Button snippet", kind: "info", source: "src/libraries/snippet.ts", find: "`Copied the ${name} snippet`" },
      { event: "Any copy refused by both the Clipboard API and the copy command", message: "Could not copy to the clipboard. Try again", kind: "error", source: "src/core/clipboard.ts", find: "Could not copy to the clipboard. Try again" },
    ],
  },
  {
    group: "Writes to source",
    items: [
      { event: "Apply to code (React)", message: "Applying 3 changes…", kind: "info", source: "src/core/apply.ts", find: "`Applying ${plural(operations.length" },
      { event: "Apply to code, some properties have no utility", message: { title: "Applying 3 changes…", description: "Cannot be written to code: transform." }, kind: "error", source: "src/core/apply.ts", find: "Cannot be written to code: ${lost" },
      { event: "Apply to code (Angular), all written", message: { title: "Wrote 3 changes", description: "src/app/card.component.html" }, kind: "info", source: "src/core/apply.ts", find: "title: `Wrote ${plural(result.applied.length" },
      { event: "Apply to code (Angular), some refused", message: { title: "Wrote 2, skipped 1", description: "No unique <div>. Queued in Changes." }, kind: "error", source: "src/core/apply.ts", find: ". Queued in Changes.`" },
      { event: "Apply to code, no source files found", message: { title: "Source files not found", description: "Send these changes to your agent instead." }, kind: "error", source: "src/core/apply.ts", find: 'title: "Source files not found"' },
      { event: "Apply to code, server error", message: "Could not write the changes. Check the designlayer terminal, then try again", kind: "error", source: "src/core/apply.ts", find: "Could not write the changes. Check the designlayer terminal, then try again" },
      { event: "Apply a canvas delete to code", message: { title: "Deleted 2 elements", description: "src/components/Card.tsx" }, kind: "info", source: "src/core/apply.ts", find: "title: `Deleted ${plural(count" },
      { event: "Apply a canvas delete, server error", message: "Could not delete in code. Check the designlayer terminal, then try again", kind: "error", source: "src/core/apply.ts", find: "Could not delete in code." },
      { event: "Insert a library component", message: "Inserting Button…", kind: "info", source: "src/libraries/insert.ts", find: "`Inserting ${component.name}…`" },
      { event: "Insert finished", message: "Inserted Button. It appears when the page reloads", kind: "info", source: "src/libraries/insert.ts", find: "It appears when the page reloads`" },
      { event: "Insert with no container selected", message: "Nowhere to place Button. Select a container first", kind: "error", source: "src/libraries/insert.ts", find: "Select a container first`" },
      { event: "Insert refused by the server", message: { title: "Could not insert Button", description: "The server wrote nothing." }, kind: "error", source: "src/libraries/insert.ts", find: "title: `Could not insert ${component.name}`" },
      { event: "Lint: fix findings", message: "Fixed 3 of 3", kind: "info", source: "src/lint/panel.ts", find: "`Fixed ${result.fixed.length} of ${ids.length}`" },
      { event: "Lint: some fixes failed", message: { title: "Fixed 2, 1 failed", description: "The line moved. Run Audit again to refresh." }, kind: "error", source: "src/lint/panel.ts", find: "Run Audit again to refresh." },
      { event: "Lint: audit failed", message: "Audit failed. Check the designlayer terminal, then try again.", kind: "error", source: "src/lint/panel.ts", find: "Audit failed. Check the designlayer terminal, then try again." },
      { event: "Lint: finding is on another page", message: "Card.tsx:12 is not on this page. Open a page that shows it, then try again.", kind: "error", source: "src/lint/panel.ts", find: "is not on this page. Open a page that shows it, then try again." },
      { event: "Control: save as source default", message: "Updated source default for Radius", kind: "info", source: "src/panels/controls.ts", find: "`Updated source default for ${control.label}`" },
      { event: "Control: delete the saved default", message: "Deleted the saved default for Radius", kind: "info", source: "src/panels/controls.ts", find: "`Deleted the saved default for ${control.label}`" },
      { event: "Control: default not saved", message: { title: "Default not saved", description: "Radius is set here, but its default was not saved to code. Try again." }, kind: "error", source: "src/panels/controls.ts", find: 'title: "Default not saved"' },
      { event: "Control: value rejected by the app", message: "Radius rejected “Huge”. Try another choice.", kind: "error", source: "src/panels/controls.ts", find: "Try another choice." },
      { event: "Style option: save failed", message: "Could not save this style. Try again.", kind: "error", source: "src/options/store.ts", find: "Could not save this style. Try again." },
    ],
  },
  {
    group: "A direct edit that did not fully land",
    items: [
      { event: "Drag or nudge, nothing reaches source", message: "Move: preview only (transform)", kind: "error", source: "src/core/writer.ts", find: "preview only (${dropped.join" },
      { event: "Style edit, part of it cannot reach source", message: "Set spacing: gap is preview only", kind: "error", source: "src/core/writer.ts", find: "${dropped.join(\", \")} is preview only`" },
      { event: "Opacity on a non-plain color", message: "Opacity needs a plain color. var(--brand) is kept as written.", kind: "error", source: "src/panels/inspector/section-fill.ts", find: "Opacity needs a plain color." },
      { event: "Remove a queued edit, queue not cleared", message: { title: "Still queued", description: "Removed from the list, but Apply to code will still write it." }, kind: "error", source: "src/panels/inspector/tab-annotations.ts", find: 'title: "Still queued"' },
    ],
  },
  {
    group: "Destructive, with Undo",
    items: [
      { event: "Delete one note", message: "Deleted the note on Card", kind: "info", action: "Undo", source: "src/panels/inspector/tab-annotations.ts", find: "`Deleted the note on ${noteSubject(removed.note)}`" },
      { event: "Delete all notes (second click)", message: "Deleted 3 notes", kind: "info", action: "Undo", source: "src/panels/inspector/tab-annotations.ts", find: "`Deleted ${noteWord(cleared.count)}`" },
      { event: "Delete all notes (first click arms it)", message: "Click again to delete all 3 notes", kind: "info", source: "src/panels/inspector/tab-annotations.ts", find: "`Click again to delete all ${noteWord(count)}`" },
    ],
  },
  {
    group: "System changes",
    items: [
      { event: "Switch apps with unapplied changes (first click)", message: { title: "Switching discards 2 unapplied changes", description: "Click again to go to Docs site anyway." }, kind: "info", source: "src/panels/app-chooser.ts", find: "Click again to go to ${label} anyway.`" },
      { event: "Switch apps", message: "Switching to Docs site…", kind: "info", source: "src/panels/app-chooser.ts", find: "`Switching to ${label}\\u2026`" },
      { event: "Switch to an app that stopped", message: "Docs site is no longer running. Start it again, or choose another app.", kind: "error", source: "src/panels/app-chooser.ts", find: "is no longer running. Start it again, or choose another app.`" },
      { event: "Add a design library", message: "Added Acme UI", kind: "info", source: "src/libraries/libraries-section.ts", find: "`Added ${library.name}`" },
      { event: "Remove a design library", message: "Removed Acme UI", kind: "info", source: "src/libraries/libraries-section.ts", find: "`Removed ${library.name}`" },
      { event: "Sign in to a library site", message: "Signed in to figma.com", kind: "info", source: "src/libraries/libraries-section.ts", find: "`Signed in to ${record.origin}`" },
      { event: "Forget a sign-in", message: "Forgot the sign-in for figma.com", kind: "info", source: "src/libraries/libraries-section.ts", find: "`Forgot the sign-in for ${entry.origin}`" },
      { event: "Library scan failed", message: { title: "Could not scan this project", description: "Add a design-system file by path below." }, kind: "error", source: "src/libraries/libraries-section.ts", find: 'title: "Could not scan this project"' },
      { event: "Add a library with an empty link", message: "Paste a link first", kind: "error", source: "src/libraries/libraries-section.ts", find: '"Paste a link first"' },
      { event: "Turn a library on or off, failed", message: "Could not turn Acme UI off. Try again.", kind: "error", source: "src/libraries/libraries-section.ts", find: "`Could not turn ${library.name} ${next ? \"on\" : \"off\"}. Try again.`" },
    ],
  },
  {
    group: "Connection (raised by the vendor overlay, mirrored)",
    vendor: true,
    items: [
      { event: "Dev server goes away", message: "Dev server disconnected", source: "node_modules/react-rewrite-cli/dist/overlay.js", find: 'V("Dev server disconnected")' },
      { event: "Dev server comes back", message: "Dev server reconnected", source: "node_modules/react-rewrite-cli/dist/overlay.js", find: 'V("Dev server reconnected")' },
      { event: "Editor opened in another tab", message: "Disconnected: another tab took over", source: "node_modules/react-rewrite-cli/dist/overlay.js", find: 'V("Disconnected: another tab took over")' },
      { event: "Reorder an element that cannot move", message: "Can't reorder this element", source: "node_modules/react-rewrite-cli/dist/overlay.js", find: `V("Can't reorder this element")` },
    ],
  },
]

/** Direct manipulation. `find` is where the (now absent) toast used to be. */
const SILENT = [
  { event: "Edit a style in the inspector (fill, spacing, radius, size…)", source: "src/core/writer.ts", find: "applyStyles(selection, writes, summary" },
  { event: "Change classes, a variant or a token", source: "src/core/writer.ts", find: "applyClasses(selection, write, summary)" },
  { event: "Edit text in place", source: "src/core/writer.ts", find: "applyText(selection, text)" },
  { event: "Swap an icon", source: "src/core/writer.ts", find: "applyIcon(" },
  { event: "Edit an attribute", source: "src/core/writer.ts", find: "applyAttribute(selection, name, value, target)" },
  { event: "Drag, nudge or resize on the canvas", source: "src/core/writer.ts", find: "applyStyles(selection, writes, summary" },
  { event: "Align or distribute several elements", source: "src/core/writer.ts", find: "applyStylesBatch(edits, summary)" },
  { event: "Delete a layer on the canvas", source: "src/core/writer.ts", find: "applyDelete(selections)" },
  { event: "Hide or show a layer (⇧⌘H)", source: "src/shell/shortcuts.ts", find: 'registerCommand("select.hide"' },
  { event: "Lock or unlock a layer", source: "src/shell/shortcuts.ts", find: 'registerCommand("select.lock"' },
  { event: "Show or hide note pins", source: "src/shell/shortcuts.ts", find: 'registerCommand("notes.markers.toggle"' },
  { event: "Undo or redo (⌘Z, ⇧⌘Z, toolbar)", source: "src/shell/toolbar.ts", find: "const travel = (direction" },
  { event: "Vendor’s own “Undo: …” and “Everything reset”", source: "src/core/toast.ts", find: 'text === "Everything reset"' },
]

/* ---------- 1. the catalog must match the code ---------- */

function verify() {
  const problems = []
  const cache = new Map()
  const read = (file) => {
    if (!cache.has(file)) {
      const full = path.join(ROOT, file)
      cache.set(file, fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null)
    }
    return cache.get(file)
  }
  const all = [...EVENTS.flatMap((group) => group.items), ...SILENT]
  for (const entry of all) {
    const text = read(entry.source)
    if (text === null) problems.push(`${entry.source} does not exist (${entry.event})`)
    else if (!text.includes(entry.find)) problems.push(`${entry.source} no longer contains ${JSON.stringify(entry.find)} (${entry.event})`)
    const line = text ? text.slice(0, text.indexOf(entry.find)).split("\n").length : 0
    entry.where = `${entry.source}:${line}`
  }
  if (problems.length) throw new Error(`The catalog drifted from the code:\n  ${problems.join("\n  ")}`)
  const count = all.length - SILENT.length
  console.log(`Verified  ${count} toasting events and ${SILENT.length} silent ones against source`)
}

/* ---------- 2. the page's script: the real toaster ---------- */

async function bundle() {
  const entry = `
    import { notify, installToaster, classifyVendorToast, splitToast } from "./src/core/toast"
    import { paletteCss } from "./src/core/css/base"
    import { toast } from "sonner"
    window.__toasts = { notify, installToaster, classifyVendorToast, splitToast, paletteCss, dismiss: () => toast.dismiss() }
  `
  const result = await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: "ts" },
    bundle: true,
    format: "iife",
    write: false,
    minify: true,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    // The editor's own Sonner patches, so the page shows the stack it ships.
    plugins: [patchSonner],
  })
  return result.outputFiles[0].text
}

/* ---------- 3. the page ---------- */

const PAGE_CSS = `
* { box-sizing: border-box; }
body { margin: 0; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
  background: var(--de-color-bg); color: var(--de-color-text); }
header { position: sticky; top: 0; z-index: 1; display: flex; gap: 12px; align-items: center;
  padding: 14px 32px; background: var(--de-color-bg); border-bottom: 1px solid var(--de-color-border); }
header h1 { font-size: 15px; margin: 0; flex: 1; }
main { max-width: 1080px; padding: 8px 32px 120px; }
h2 { font-size: 15px; margin: 40px 0 4px; }
h3 { font-size: 13px; margin: 24px 0 4px; }
.lede { color: var(--de-color-text-muted); margin: 0 0 12px; max-width: 72ch; }
button { font: inherit; color: var(--de-color-text); background: var(--de-color-bg-raised);
  border: 1px solid var(--de-color-border); border-radius: 6px; padding: 4px 10px; cursor: pointer; white-space: nowrap; }
button:hover { background: var(--de-color-bg-hover); }
.variants { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
.card { border: 1px solid var(--de-color-border); border-radius: 8px; padding: 12px; background: var(--de-color-bg-raised);
  display: flex; flex-direction: column; gap: 6px; }
.card strong { font-size: 13px; }
.card p { margin: 0; color: var(--de-color-text-muted); flex: 1; }
.card button { align-self: flex-start; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
col.btn { width: 64px; } col.event { width: 28%; } col.msg { width: 36%; } col.kind { width: 110px; }
th { text-align: left; font-weight: 500; color: var(--de-color-text-dim); font-size: 11px; padding: 6px 8px;
  border-bottom: 1px solid var(--de-color-border); }
td { padding: 7px 8px; border-bottom: 1px solid var(--de-color-hairline, var(--de-color-border)); vertical-align: top; }
td.msg strong { display: block; font-weight: 600; }
td.msg .body { display: block; color: var(--de-color-text-muted); }
td.src { color: var(--de-color-text-dim); font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
td.btn { padding-left: 0; }
td.src { overflow-wrap: anywhere; }
.kind { display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 4px; border: 1px solid var(--de-color-border); }
.kind.error { color: var(--de-color-danger); border-color: var(--de-color-danger); }
.kind.silent { color: var(--de-color-text-dim); }
.count { color: var(--de-color-text-dim); font-weight: 400; }
`

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

function page(script) {
  const total = EVENTS.reduce((n, group) => n + group.items.length, 0)
  const groups = EVENTS.map((group) => {
    const rows = group.items
      .map((item) => {
        const kind = group.vendor ? `<span class="kind" data-vendor-kind="${esc(item.message)}"></span>` : `<span class="kind ${item.kind}">${item.kind}</span>`
        const action = item.action ? ` <span class="kind">+ ${esc(item.action)}</span>` : ""
        const data = JSON.stringify({ message: item.message, kind: item.kind ?? null, action: item.action ?? null, vendor: !!group.vendor })
        return `<tr><td class="btn"><button data-fire='${esc(data)}'>Show</button></td><td>${esc(item.event)}</td><td class="msg" data-message='${esc(JSON.stringify(item.message))}'></td><td>${kind}${action}</td><td class="src">${esc(item.where)}</td></tr>`
      })
      .join("")
    return `<h3>${esc(group.group)} <span class="count">${group.items.length}</span></h3>
<table><colgroup><col class="btn"><col class="event"><col class="msg"><col class="kind"><col></colgroup><thead><tr><th></th><th>Event</th><th>Toast</th><th>Kind</th><th>Raised at</th></tr></thead><tbody>${rows}</tbody></table>`
  }).join("\n")

  const silent = SILENT.map(
    (item) => `<tr><td>${esc(item.event)}</td><td class="msg"><span class="kind silent">no toast</span></td><td class="src">${esc(item.where)}</td></tr>`
  ).join("")

  return `<!doctype html>
<html lang="en" data-de-theme="dark">
<head>
<meta charset="utf-8">
<title>DesignLayer toasts</title>
<style id="palette"></style>
<style>${PAGE_CSS}</style>
</head>
<body>
<header>
  <h1>DesignLayer toasts <span class="count">${total} events toast, ${SILENT.length} stay silent</span></h1>
  <button id="theme">Light theme</button>
  <button id="dismiss">Dismiss all</button>
</header>
<main>
<p class="lede">Every card is fired through the editor’s real toaster (<code>src/core/toast.ts</code>): same Sonner build, stylesheet, durations and close button. Toasts are for errors, handoffs to the agent, clipboard copies, writes to source, undoable deletes and system changes. Direct manipulation on the canvas raises none.</p>

<h2>Variants</h2>
<p class="lede">The shapes a card can take. Info has no icon and leaves after 4 seconds. An error stays until dismissed. An Undo action stretches an info card to 8 seconds.</p>
<div class="variants">
  <div class="card"><strong>Info</strong><p>News the canvas cannot show. No icon, no colour. Leaves after 4 s.</p><button data-variant="info">Show</button></div>
  <div class="card"><strong>Info, title and body</strong><p>A concise title over a muted sentence.</p><button data-variant="infoBody">Show</button></div>
  <div class="card"><strong>Error</strong><p>The only card with an icon and colour. Stays until dismissed with ×.</p><button data-variant="error">Show</button></div>
  <div class="card"><strong>Error, title wraps</strong><p>The icon centres on both lines of the title.</p><button data-variant="errorWrap">Show</button></div>
  <div class="card"><strong>Info with Undo</strong><p>A destructive step offered back. Leaves after 8 s.</p><button data-variant="action">Show</button></div>
  <div class="card"><strong>Long message</strong><p>Split at the first sentence break into a title and a body that wraps.</p><button data-variant="long">Show</button></div>
  <div class="card"><strong>Stacked</strong><p>Four at once. Three are visible, their top edges an even 7 px apart; hover to expand with 8 px gaps.</p><button data-variant="stack">Show</button></div>
  <div class="card"><strong>Mirrored from the vendor</strong><p>Kind recovered from the wording, since the vendor drops it.</p><button data-variant="vendor">Show</button></div>
</div>

<h2>Events that raise a toast <span class="count">${total}</span></h2>
${groups}

<h2>Events that stay silent <span class="count">${SILENT.length}</span></h2>
<p class="lede">Direct manipulation. The canvas already shows the result, so no card is raised. The one exception is a direct edit that loses part of itself on the way to source, listed above under “A direct edit that did not fully land”.</p>
<table><colgroup><col class="event"><col class="kind"><col></colgroup><thead><tr><th>Event</th><th>Toast</th><th>Handled at</th></tr></thead><tbody>${silent}</tbody></table>
</main>
<script>${script}</script>
<script>
const { notify, installToaster, classifyVendorToast, splitToast, paletteCss, dismiss } = window.__toasts
document.getElementById("palette").textContent = paletteCss
installToaster()

for (const cell of document.querySelectorAll("[data-message]")) {
  const { title, description } = splitToast(JSON.parse(cell.dataset.message))
  const strong = document.createElement("strong")
  strong.textContent = title
  cell.append(strong)
  if (description) {
    const body = document.createElement("span")
    body.className = "body"
    body.textContent = description
    cell.append(body)
  }
}

for (const node of document.querySelectorAll("[data-vendor-kind]")) {
  const kind = classifyVendorToast(node.dataset.vendorKind) ?? "silent"
  node.textContent = kind
  node.classList.add(kind)
}

const undo = (label) => ({ label, onClick: () => notify("Restored") })
function fire({ message, kind, action, vendor }) {
  if (vendor) {
    const resolved = classifyVendorToast(message)
    if (resolved) notify(message, resolved)
    return
  }
  notify(message, kind, action ? undo(action) : undefined)
}

const VARIANTS = {
  info: () => notify("Copied 2 notes and 1 edit"),
  infoBody: () => notify("Nothing to copy. Pin a note or make an edit first."),
  error: () => notify("Could not write the changes. Check the designlayer terminal, then try again", "error"),
  errorWrap: () => notify("The agent route returned an error (500). Check the designlayer terminal, then send again.", "error"),
  action: () => notify("Deleted the note on Card", "info", undo("Undo")),
  long: () => notify("Queued to the handoff file — no agent is attached over MCP, so nothing was edited. Copy the brief, or point an agent at the MCP endpoint."),
  stack: () => {
    notify("Applying 3 changes…")
    notify("Copied JSX")
    notify("Set spacing: gap is preview only", "error")
    notify("Deleted 3 notes", "info", undo("Undo"))
  },
  vendor: () => notify("Dev server disconnected", classifyVendorToast("Dev server disconnected")),
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button")
  if (!button) return
  if (button.dataset.fire) fire(JSON.parse(button.dataset.fire))
  else if (button.dataset.variant) VARIANTS[button.dataset.variant]()
  else if (button.id === "dismiss") dismiss()
  else if (button.id === "theme") {
    const root = document.documentElement
    const light = root.dataset.deTheme !== "light"
    root.dataset.deTheme = light ? "light" : "dark"
    button.textContent = light ? "Dark theme" : "Light theme"
  }
})
</script>
</body>
</html>
`
}

verify()
const script = await bundle()
fs.mkdirSync(OUT, { recursive: true })
const file = path.join(OUT, "index.html")
fs.writeFileSync(file, page(script))
console.log(`Page      ${pathToFileURL(file).href}`)
if (process.argv.includes("--open")) execFileSync("open", [file])
