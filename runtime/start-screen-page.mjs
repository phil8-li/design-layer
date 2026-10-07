/**
 * The start screen document: the product's front door.
 *
 * Until now the only way in was `designlayer --dev 3000` — you had to know
 * the port, the project root and the flag before anything appeared. This page
 * is the replacement, and it is served by the start-screen server before the
 * editing proxy exists, so it has to be one self-contained document: inline
 * style, inline module script, no fetches for anything but its own loopback
 * JSON routes.
 *
 * Everything the script renders from the server — a page title, a folder name,
 * an error sentence — arrives as untrusted string data and is written with
 * `textContent`. That is the whole injection surface of this feature, and it is
 * closed by never building markup from a string.
 */

import fs from "node:fs"

import { startScreenStyle } from "./start-screen-style.mjs"

/**
 * The tab icon, inline for the same reason as the style: the page fetches
 * nothing. The Mac desk serves the same file as desktop/mac/icons/mark.svg.
 */
const FAVICON = `data:image/svg+xml;base64,${fs.readFileSync(new URL("./favicon.svg", import.meta.url)).toString("base64")}`

/** How long the waiting state stays silent before it says what to check. */
const SLOW_MS = 90_000

/** Long enough that a path is typed rather than spelled, short enough to feel live. */
const TYPING_MS = 300

const CLIENT = `
const $ = (id) => document.getElementById(id)
const el = {
  form: $("form"), url: $("url"),
  apps: $("apps"), appsNote: $("apps-note"), appsError: $("apps-error"),
  path: $("folder-path"), folderHelp: $("folder-help"), folderError: $("folder-error"),
  scriptRow: $("script-row"), script: $("script"),
  submit: $("submit"), hint: $("hint"), submitError: $("submit-error"),
  waiting: $("waiting"), progress: $("progress"), progressText: $("progress-text"),
  waitingNote: $("waiting-note"), waitingBack: $("waiting-back"),
  current: $("current"), currentName: $("current-name"), currentWhere: $("current-where"),
  currentOpen: $("current-open"), currentChange: $("current-change"),
  chooseTitle: $("choose-title"), stopped: $("stopped"),
}

/*
 * The one piece of help left on the screen, taken from the document rather than
 * written twice — it has to be in the markup so the field is described before a
 * single line of this script has run, and it has to be recoverable here so
 * \`render()\` can put it back after taking it away.
 */
const FOLDER_HELP = el.folderHelp.textContent

let apps = []
let root = null   // { path, info } — the folder the editor will write source into
let devScript = null
let busy = false
let typing = 0
// The editor this tab knows is up, if any. Only ever read to decide whether a
// press is a start or a switch — the server is the authority on what is running.
let runningUrl = null

/*
 * The browser is never told the server's home directory and the API contract is
 * frozen, so the two conventional layouts are recognised by shape. Anything
 * else renders in full, which is correct — only longer.
 */
const HOME = /^(\\/Users\\/[^/]+|\\/home\\/[^/]+|[A-Za-z]:\\\\Users\\\\[^\\\\]+)(?=[/\\\\]|$)/
const tilde = (value) => value.replace(HOME, "~")

function show(node, message) {
  node.textContent = message
  node.hidden = message === ""
}

function clearErrors() {
  for (const node of [el.appsError, el.folderError, el.submitError]) show(node, "")
  markInvalid(null)
}

/**
 * What each input is described by when nothing is wrong with it.
 *
 * \`#folder-path\` has a permanent help line and its own error slot; \`#url\` has
 * neither, which is why it needs the empty string here rather than being left
 * out — "restore what this field normally says" has to have an answer for both
 * or the loop below can only ever add.
 */
const BASE_DESCRIBED_BY = { url: "", "folder-path": "folder-help folder-error" }

/*
 * The field the last refusal was about, tinted, flagged, and POINTED AT THE
 * SENTENCE — and only ever one field.
 *
 * \`aria-invalid\` says a field is wrong. It does not say what is wrong with it;
 * \`aria-describedby\` is the half that does, and the note this function used to
 * carry claimed the association "is already permanent on both inputs". It was
 * permanent on one. \`#url\` — the field that has \`autofocus\`, so the first field
 * anybody lands on — carried none at all, and the three refusals that mark it
 * invalid all write their sentence into \`#submit-error\`, a node it had no
 * relationship with. A reader was told "this field is invalid" and nothing else.
 *
 * So the association is made here, where the field is chosen, rather than
 * written into the markup: the two per-field refusals put their sentence under
 * the folder input, and the three submit-time ones put it in the shared alert
 * at the foot of the form. Which node is describing the field is a fact about
 * WHICH refusal happened, and this is the one function that knows.
 *
 * Clearing the other field on every call is what keeps two red boxes off the
 * screen when the user fixes one and presses again — and now restores its
 * resting description with them, so a field that has been invalid once does not
 * keep pointing at a stale complaint.
 */
function markInvalid(field) {
  for (const node of [el.url, el.path]) {
    const base = BASE_DESCRIBED_BY[node.id]
    if (node === field) {
      node.setAttribute("aria-invalid", "true")
      node.setAttribute("aria-describedby", base ? base + " submit-error" : "submit-error")
    } else {
      node.removeAttribute("aria-invalid")
      if (base) node.setAttribute("aria-describedby", base)
      else node.removeAttribute("aria-describedby")
    }
  }
}

/** A refusal, said under its field and tied to it. Never announced twice. */
function fail(node, field, message) {
  show(node, message)
  markInvalid(field)
  render()
}

/** A typed URL only counts as one of the detected apps if it is loopback. */
function portOf(value) {
  try {
    const url = new URL(/^[a-z]+:\\/\\//i.test(value) ? value : "http://" + value)
    const host = url.hostname.replace(/^\\[|\\]$/g, "")
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return null
    return Number(url.port || (url.protocol === "https:" ? 443 : 80))
  } catch {
    return null
  }
}

const matchedApp = () => {
  const port = portOf(el.url.value.trim())
  return port === null ? null : apps.find((app) => app.port === port) ?? null
}

/*
 * A row's label, with the server's fallback caught before it stutters.
 *
 * \`scanLocalApps\` labels an untitled dev server with its own address — an
 * honest choice there, since the address really is the only thing known about
 * it. But the row then appends the port as a second element, so the fallback
 * rendered as "127.0.0.1:3001:3001". Detected rather than fixed at the source
 * because the same field feeds the in-editor chooser, which has its own
 * fallback chain (packageName, then title, then url) and would lose a rung.
 */
function appName(app) {
  const address = app.url.replace(/^https?:\\/\\//, "")
  return !app.title || app.title === address ? "Untitled app" : app.title
}

/*
 * The same app, named in PROSE rather than in the row.
 *
 * "Untitled app" works in a list where the port sits in its own column two
 * inches to the right. In a sentence it identifies nothing, and with two
 * untitled servers up the reader has no way to tell which one was meant.
 *
 * It named the bare address for a while, and that was the other half of the
 * same bug rather than a fix: the sentence then said "127.0.0.1:3000" while the
 * row it referred to said "Untitled app", so the one name on screen and the one
 * name in the prose were different strings. Rendering the card against two
 * untitled servers is what surfaced it.
 *
 * So the sentence says what the row says AND the thing the row uses to tell two
 * of them apart, which is the port. A titled app needs none of this and gets
 * its title, unchanged.
 */
function appLabel(app) {
  return app.title && app.title !== app.url.replace(/^https?:\\/\\//, "")
    ? app.title
    : "the untitled app on port " + app.port
}

/*
 * Said in two places — under the button while the folder sits there unusable,
 * and again if the press happens anyway — so it is one string rather than two
 * that drift. The recovery is the whole point of it: the editor cannot start
 * this app, and the user can.
 */
const NO_DEV_SCRIPT = "No dev script in that folder. Start the app yourself, then reload this page."

/*
 * WHAT THE SCREEN KNOWS THAT THE USER CANNOT SEE — and nothing else.
 *
 * This ran to eight sentences, three of which described the screen back to the
 * person looking at it: an empty field said "now the address", two empty fields
 * said "fill in both fields", a filled pair said what the two filled boxes
 * plainly said. Prose that restates the layout is prose the layout already
 * carried, and six of them at once is the wall this pass exists to pull down.
 *
 * What is left is the set of facts that came back from \`/api/project\` and are
 * not on screen anywhere: a folder with no manifest, a framework the editor
 * cannot edit, a project with no script to run, and — the only one that is not
 * a refusal — the COMMAND this button is about to run on the user's machine.
 * That last one stays because spawning a process is the one consequence two
 * text fields and a verb cannot possibly convey.
 *
 * Silence is the answer everywhere else, including the ready-and-already-
 * running case: the row carries a check, the fields carry the address and the
 * folder, and the button says Start editing. A sentence there would only read
 * the screen aloud.
 *
 * Ordered, first match wins, because more than one is true at a time and the
 * rule is that the earliest UNANSWERED question wins: you cannot act on "this
 * folder has no dev script" while you have not said which folder.
 */
function hintFor(app) {
  if (el.url.value.trim() === "" || !root) return ""

  const { name, hasPackageJson, hasReact, framework } = root.info
  // Both facts below arrive with the folder, a full round-trip before the press
  // that used to be the first place either of them was mentioned. The best
  // error message is the one the screen answers before it is earned.
  if (!hasPackageJson) return "No package.json in that folder. Pick the one with node_modules beside it."
  if (!hasReact && framework !== "angular") {
    return name + " does not use React or Angular, the two frameworks the editor supports."
  }
  // An app already up needs no script, so a missing one is not a problem yet.
  if (app) return ""
  if (!devScript) return NO_DEV_SCRIPT
  return "Runs npm run " + devScript + ", then opens the editor."
}

function render() {
  const app = matchedApp()
  for (const row of el.apps.children) {
    const checked = app !== null && Number(row.dataset.port) === app.port
    row.setAttribute("aria-checked", String(checked))
    // Roving tabindex: the group is ONE tab stop, not one per detected app, and
    // the stop is on the chosen row so Tab lands where the eye already is.
    row.tabIndex = checked ? 0 : -1
  }
  // Nothing checked yet — the first row still has to be reachable, or the group
  // is a set of controls Tab cannot get into at all.
  if (el.apps.children.length && !el.apps.querySelector('[aria-checked="true"]')) {
    el.apps.children[0].tabIndex = 0
  }
  // The field is never written from here — it is the one control the user types
  // into, and render() runs on every keystroke.
  const scripts = root ? root.info.devScripts : []
  el.scriptRow.hidden = app !== null || scripts.length < 2
  // One label, always. It used to flip between "Start designing" and
  // "Start app & designing" as the user typed — a button that changes identity
  // under the hand reaching for it, and an unparallel construction besides.
  // The one case where the two differ in a way the screen can see — a process
  // about to be spawned — is the hint's, and only that case.
  el.submit.textContent = "Start editing"
  /*
   * Help for a question that has been answered is not help.
   *
   * How to get an absolute path out of Finder is the one thing on this screen a
   * reader cannot work out from the labels, and it is worth two muted lines
   * while the box is empty. The moment the box has a path in it — typed, or
   * written there by a row click, which is the common case whenever anything is
   * running — those two lines are a caption on a solved problem, sitting
   * directly above the button.
   */
  show(el.folderHelp, el.path.value.trim() === "" ? FOLDER_HELP : "")
  // A folder error is a sentence about the field it sits under; the hint would
  // be a second instruction on screen at the same time, pointing elsewhere.
  show(el.hint, el.folderError.hidden ? hintFor(app) : "")
  // Only ever busy. See the note on the button in the document below.
  el.submit.disabled = busy
}

/*
 * WHAT A FAILED REQUEST SAYS, AND WHO IT NAMES.
 *
 * Both sentences here used to be dead ends. "Could not reach the start screen:
 * Failed to fetch" hands the user a browser's internal phrasing and no next
 * step; "The start screen answered 500." hands them an HTTP status. Neither
 * names a recovery, and both name a thing — "the start screen" — that appears
 * nowhere else on the page, so the user cannot tell whether the part that broke
 * is theirs or ours.
 *
 * The replacements name the process they can actually see (the terminal running
 * designlayer), and the one action that resolves each case. The status code
 * stays, in parentheses, because the person who hits a 500 on a developer tool
 * is often the person who can read the stack trace it came from — but it is no
 * longer the whole message.
 *
 * A server-supplied \`error\` still wins when there is one: \`start-screen.mjs\`
 * writes the best copy in this surface and it knows things this function
 * cannot.
 */
const LOST_CONTACT =
  "Lost contact with the editor. Check the terminal it is running in, then reload this page."

async function askServer(path, errorNode, init) {
  let response
  try {
    response = await fetch(path, init)
  } catch {
    show(errorNode, LOST_CONTACT)
    return null
  }
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    show(
      errorNode,
      (data && data.error) ||
        "Something went wrong (HTTP " + response.status + "). Reload this page and try again."
    )
    return null
  }
  return data
}

function adoptProject(project) {
  root = { path: project.path, info: project }
  // Only when it differs, so confirming what was pasted does not move the caret.
  if (el.path.value !== project.path) el.path.value = project.path
  devScript = project.devScripts[0] ?? null
  el.script.replaceChildren()
  for (const name of project.devScripts) {
    const option = document.createElement("option")
    option.value = name
    option.textContent = name
    el.script.append(option)
  }
  if (devScript) el.script.value = devScript
}

/*
 * A RADIO, NOT A TOGGLE, and the distinction is what the row actually does.
 *
 * These were \`<button aria-pressed>\`, which a screen reader announces as
 * "toggle button, pressed" — a promise of independent on/off per row. Picking
 * one un-picks every other, which is a single choice, which is \`role="radio"\`
 * in a \`radiogroup\`. The wrong role is not a cosmetic mismatch: it tells a
 * non-visual user that three switches are available when there is one question.
 *
 * It stays a \`<button>\` element under the role so the press, the focus ring and
 * the disabled handling all remain the platform's.
 */
function appRow(app) {
  const row = document.createElement("button")
  row.type = "button"
  row.className = "app"
  row.dataset.port = String(app.port)
  row.setAttribute("role", "radio")
  row.setAttribute("aria-checked", "false")
  row.tabIndex = -1
  // The non-color half of "this one is chosen". The accent edge is the other
  // half, and a glyph is the one that survives forced-colors and a reader who
  // cannot tell the two fills apart. It is aria-hidden because aria-checked
  // already says this to a screen reader, and saying it twice is worse.
  const check = document.createElement("span")
  check.className = "app-check"
  check.setAttribute("aria-hidden", "true")
  check.textContent = "✓"
  const name = document.createElement("span")
  name.className = "app-name"
  /*
   * \`app.title\` falls back to "127.0.0.1:3001" for a dev server that serves no
   * title, and \`.app-port\` then appends ":3001" to it — "127.0.0.1:3001:3001"
   * on screen. The row that most needs a readable label is the one that gets a
   * stutter, and it is the same row (no project folder) that already asks the
   * most of the user.
   */
  name.textContent = appName(app)
  /*
   * And the same string as a \`title\`, because \`.app-name\` ellipsises.
   *
   * Picking the right app is the only question this screen asks, and two dev
   * servers out of one monorepo routinely share a prefix: "Acme Design System"
   * and "Acme Design System Docs" are the same eighteen visible characters in a
   * 448px card, so the cut falls exactly where the difference is. The editor's
   * own app chooser met this and answered it with a tooltip; this screen ships
   * the same row with nothing behind the ellipsis.
   *
   * A native \`title\` rather than a tooltip component, because this document is
   * deliberately self-contained — it is served before any editor exists and has
   * no component library to reach for — and the browser's own is free.
   */
  name.title = appName(app)
  const port = document.createElement("span")
  port.className = "app-port"
  port.textContent = ":" + app.port
  row.append(check, name, port)
  row.addEventListener("click", () => chooseApp(app))
  return row
}

/*
 * Arrow keys move the choice, which is what a radiogroup owes a keyboard.
 *
 * In a radiogroup the arrows do not merely move focus — they move the SELECTION
 * with it, so arrowing down the list is the same gesture as clicking down it.
 * Home and End go to the ends. Everything else, including Tab, is left to the
 * browser: one stop in, one stop out, which is the whole point of the roving
 * tabindex \`render()\` maintains.
 */
el.apps.addEventListener("keydown", (event) => {
  const rows = [...el.apps.children]
  const from = rows.indexOf(event.target)
  if (from === -1) return
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key]
  let to = -1
  if (step !== undefined) to = (from + step + rows.length) % rows.length
  else if (event.key === "Home") to = 0
  else if (event.key === "End") to = rows.length - 1
  else return
  event.preventDefault()
  rows[to].focus()
  rows[to].click()
})

/*
 * The row says nothing about where its source is, so whatever folder is in the
 * field belongs to the app that was picked before it. Left standing, Start is
 * enabled and the editor boots pointed at THIS server with THAT app's source
 * tree — every edit written into the wrong project. Clearing it costs the path
 * being typed again; leaving it costs the other project.
 *
 * The sentence is only said when something was actually taken away. A field
 * that was already empty is the ordinary first-load state, and the hint under
 * the button already asks for the folder. When it is said it points at the
 * field, because typing a path there is now the only way to close the gap it
 * reports.
 */
function forgetProject(app) {
  const had = root !== null || el.path.value.trim() !== ""
  root = null
  devScript = null
  el.path.value = ""
  if (!had) return
  // "below" was wrong, and then "Type the path to its folder" was redundant:
  // the sentence sits under the field it is about, and that field is now empty
  // and flagged. What it has to carry is the half that is not visible — WHY the
  // box it is under went blank.
  show(el.folderError, "Cannot tell where " + appLabel(app) + " keeps its code.")
  markInvalid(el.path)
}

async function chooseApp(app) {
  clearErrors()
  /*
   * "Picked Host App for you" outlives the pick it describes, otherwise.
   *
   * It is written once, by \`boot()\`, and stayed on screen while the user
   * clicked down the list — so the note under the rows named the first app
   * while the check mark two rows above it sat on something else. A sentence
   * disagreeing with the control it points at is worse than no sentence, and a
   * choice the user made themselves needs no announcement at all: they watched
   * it happen. \`boot()\` writes its own note after this returns.
   */
  show(el.appsNote, "")
  // A path in the field is the page the user asked for, and it is theirs to
  // keep as long as it is a page of the app being clicked. Row to row it is a
  // page of the app they just left, so it goes with the origin.
  if (matchedApp() !== app) el.url.value = app.url
  if (app.projectRoot) {
    const data = await askServer("/api/project?path=" + encodeURIComponent(app.projectRoot), el.folderError)
    if (data) adoptProject(data.project)
  } else forgetProject(app)
  render()
}

/*
 * The typed path, resolved once the typing stops.
 *
 * This is how a project folder is named. A native folder panel used to sit
 * beside this field; it was dropped, because it put a second, slower way to say
 * the same thing on screen — one that also had to be built three times, once
 * per desktop, and could open behind the browser window with nothing on the
 * page to explain where it had gone.
 *
 * What is left has to carry the cases the panel used to: a project the machine
 * will not name for itself — a dev server whose cwd macOS refuses to report —
 * is reachable only by saying where it is. Finder's Copy as Pathname, the
 * shell's pwd, and a folder dragged onto a terminal all produce exactly what
 * this field takes, which is what makes that a fair trade rather than a loss.
 */
async function resolveTyped() {
  const value = el.path.value.trim()
  if (value === "") return
  if (!/^([/~]|[A-Za-z]:[\\\\/])/.test(value)) {
    // Said as a shape rather than as a verb: the old wording was "Paste the
    // folder's full path", which tells a user who is typing that they are doing
    // the wrong thing, and it named only the POSIX form though the test below
    // accepts ~ and a Windows drive letter too.
    fail(el.folderError, el.path, "That is not a full path. It should start with / or ~.")
    return
  }
  const data = await askServer("/api/project?path=" + encodeURIComponent(value), el.folderError)
  // Typed on while that was in flight; the later keystroke owns the field.
  if (!data || el.path.value.trim() !== value) return
  if (!data.project.isDirectory) {
    fail(el.folderError, el.path, "No folder at that path. Check the spelling.")
    return
  }
  adoptProject(data.project)
  render()
}

el.path.addEventListener("input", () => {
  clearErrors()
  // Anything already adopted is stale the moment the path changes, so the
  // screen goes back to asking for a folder rather than starting the wrong one.
  root = null
  devScript = null
  render()
  clearTimeout(typing)
  typing = setTimeout(resolveTyped, ${TYPING_MS})
})

el.url.addEventListener("input", () => {
  clearErrors()
  render()
})
el.script.addEventListener("change", () => {
  devScript = el.script.value
  render()
})

/** What the server says is running right now, or null if it would not say. */
async function readStatus() {
  const response = await fetch("/api/status").catch(() => null)
  return response && response.ok ? await response.json().catch(() => null) : null
}

/*
 * The two faces of this card. Only one is ever up: what is running, or the form
 * for choosing what should be. The form stays built underneath either way, so
 * "Switch app" is one click rather than a second boot.
 */
function showCurrent(status) {
  runningUrl = status.url
  const editing = status.editing
  // The question the two buttons answer. Without a package name it asks
  // without one rather than putting the address in a heading: the address is
  // on the line underneath either way.
  el.currentName.textContent =
    editing && editing.packageName ? "Continue editing " + editing.packageName + "?" : "Continue editing?"
  /*
   * \`projectRoot\` is guarded as well as \`editing\` now, and the old line guarded
   * only the outer one. \`tilde(undefined)\` throws — inside \`boot()\`, before
   * \`/api/apps\` is ever requested — so a status payload carrying an \`appUrl\`
   * and no root left the page stuck on "Looking for dev servers…" forever with
   * no error anywhere. The shipping supervisor always sends the whole object,
   * but the route accepts any shape and the suite already builds the short one.
   */
  const address = editing?.appUrl ? editing.appUrl.replace(/^https?:\\/\\//, "") : ""
  const where = editing?.projectRoot
    ? address + " · " + tilde(editing.projectRoot)
    : address
  show(el.currentWhere, where)
  el.currentOpen.href = status.url
  el.chooseTitle.hidden = true
  el.form.hidden = true
  el.waiting.hidden = true
  el.current.hidden = false
}

function showChooser() {
  el.current.hidden = true
  el.waiting.hidden = true
  el.chooseTitle.hidden = false
  el.form.hidden = false
  el.url.focus()
}

el.currentChange.addEventListener("click", () => {
  show(el.stopped, "")
  showChooser()
})

/*
 * PRESSING START IS HOW YOU FIND OUT WHAT IS MISSING.
 *
 * The button used to carry \`disabled\` for every unanswered field, which is the
 * arrangement this whole flow was hardest to use under: a disabled control
 * leaves the tab order, takes no hover, and explains nothing — so a first-time
 * user on a cold boot faced two empty boxes and a grey rectangle, with no way
 * to ask it what it wanted. It is enabled now, and this guard is the trade:
 * press it with a gap and the gap gets the focus and the sentence.
 *
 * Focus moves as well as the text changing, because an announcement alone still
 * leaves a sighted keyboard user to hunt for which of two fields is meant, and
 * \`#hint\` is a \`role="status"\` at the bottom of the form rather than beside
 * either one.
 */
el.form.addEventListener("submit", async (event) => {
  event.preventDefault()
  if (busy) return
  clearErrors()

  /*
   * The field takes the focus and the tint, so the sentence no longer has to
   * say where to go or what to press next — both used to end "…then press
   * Start editing", which names the button the user just pressed.
   */
  if (el.url.value.trim() === "") {
    el.url.focus()
    fail(el.submitError, el.url, "Add the address the app runs on.")
    return
  }
  if (!root) {
    el.path.focus()
    fail(el.submitError, el.path, "Add the folder the app’s code is in.")
    return
  }
  const app = matchedApp()
  if (!app && !devScript) {
    el.path.focus()
    fail(el.submitError, el.path, NO_DEV_SCRIPT)
    return
  }

  const script = app ? null : devScript
  busy = true
  render()

  let response
  try {
    response = await fetch("/api/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: el.url.value.trim(), projectRoot: root.path, devScript: script }),
    })
  } catch {
    busy = false
    render()
    show(el.submitError, LOST_CONTACT)
    return
  }

  const data = await response.json().catch(() => null)
  if (!response.ok) {
    busy = false
    render()
    show(
      el.submitError,
      (data && data.error) ||
        "Could not start that app (HTTP " + response.status + "). Check the terminal the editor is running in."
    )
    return
  }
  waitForEditor(script, runningUrl !== null)
})

/*
 * A first Next.js compile routinely runs past thirty seconds, so this state has
 * no deadline. It keeps polling forever and, once it is clearly slow, says
 * where to look instead of failing into a dead end.
 *
 * This is also the one path that still moves the tab by itself, and it should:
 * whoever pressed Start asked to go there. A tab that merely loaded this URL
 * gets the card above instead.
 */
function waitForEditor(script, switching) {
  el.chooseTitle.hidden = true
  el.form.hidden = true
  el.current.hidden = true
  show(el.stopped, "")
  el.waiting.hidden = false
  el.progressText.textContent = switching
    ? "Switching…"
    : script
      ? "Starting your app…"
      : "Starting the editor…"
  /*
   * Focus follows the content, because the node that HAD it is now hidden.
   *
   * Hiding the form while the submit button holds focus drops the caret on
   * \`<body>\`, and with the form gone the page then had zero tab stops: a
   * keyboard user who pressed Start was stranded with nothing to tab to and no
   * way out but a browser reload, which nothing on screen suggested. The
   * heading takes it instead, which also makes the \`role="status"\` text the
   * first thing a screen reader reads on arrival.
   */
  el.progress.focus()
  const startedAt = Date.now()
  // Three misses in a row is a server that has gone away rather than a slow
  // one. Said once, and not repeated over itself on every subsequent poll.
  let misses = 0
  const poll = async () => {
    const data = await readStatus()
    // The editor that was up is cleared the moment a choice is accepted, so
    // a ready answer here can only be the one this press asked for, which matters
    // because a switch usually lands back on the very same port.
    if (data && data.ready) {
      location.replace(data.url)
      return
    }
    // It died on the way up. The chooser is still here, so this is a sentence
    // to read and another go, not a page that polls for a process nobody runs.
    if (data && data.stopped) {
      busy = false
      runningUrl = null
      render()
      showChooser()
      show(el.stopped, data.stopped)
      return
    }
    misses = data === null ? misses + 1 : 0
    /*
     * Contact lost, said where a failure is said and not as a footnote.
     *
     * This wrote \`LOST_CONTACT\` into \`#waiting-note\` alone, which is muted
     * grey — so the screen sat there with a heading reading "Starting your
     * app…" and a pulsing dot, and a sentence underneath in the colour of a
     * tip saying the thing had stopped answering. Rendering that state is what
     * showed it: the two halves of the screen were telling the reader opposite
     * things, and the confident one was louder.
     *
     * The heading changes with it, the dot stops, and the sentence moves to
     * \`#stopped\`, which is \`role="alert"\` and drawn as an error. The note
     * keeps the instruction, because the alert says what happened and the note
     * is where this screen says what to do about it.
     */
    if (misses >= 3) {
      el.progressText.textContent = "Lost contact with the editor"
      el.progress.classList.add("progress--stalled")
      show(el.stopped, LOST_CONTACT)
      // Emptied rather than written: \`LOST_CONTACT\` above already names the
      // terminal and the reload, and this note used to say both again three
      // lines below it. One failure, said once.
      show(el.waitingNote, "")
    }
    else if (Date.now() - startedAt > ${SLOW_MS}) {
      show(el.waitingNote, "Still working. A first compile can take several minutes.")
    }
    setTimeout(poll, 500)
  }
  poll()
}

/*
 * The way out of the wait, which did not exist.
 *
 * It does not cancel the START — the server is already spawning a process and
 * this page has no route to call it back. What it cancels is the WAITING: the
 * chooser comes back, and if the app does come up the poll is no longer there
 * to move the tab, which is correct, because the person pressing this said they
 * wanted to do something else. The sentence says exactly that, so nobody reads
 * it as a kill switch it is not.
 */
el.waitingBack.addEventListener("click", () => {
  busy = false
  render()
  showChooser()
  show(
    el.stopped,
    "Stopped waiting. Your app may still be starting. Check your terminal."
  )
})

async function boot() {
  // Asked before the scan, which costs a second and a half: a tab that comes
  // back to this URL to reach a running editor should not wait on discovery.
  const status = await readStatus()
  // Wrapped, because showCurrent reads into a payload this route does not
  // constrain. A throw here used to take the app scan down with it and leave
  // the page on "Looking for dev servers…" with no error anywhere on screen.
  try {
    if (status && status.ready) showCurrent(status)
    else if (status && status.stopped) show(el.stopped, status.stopped)
  } catch {
    show(el.stopped, "Could not read what is running. Pick an app below to start one.")
  }

  const data = await askServer("/api/apps", el.appsError)
  /*
   * "I found nothing" and "I could not look" are different sentences, and the
   * page used to say the first one whenever the second was true.
   *
   * A failed scan falls back to an empty list, which then rendered "Nothing is
   * running yet" directly beside an error saying the scan had not run. Two
   * contradictory statements stacked, and the wrong one is the dangerous one:
   * it sends the user to start an app that may already be up, on a port that is
   * already taken.
   */
  const scanned = data !== null
  apps = (data && data.apps) || []
  el.apps.replaceChildren(...apps.map(appRow))
  /*
   * THE SECOND WAY IN IS ONLY AN ALTERNATIVE WHEN THERE IS A FIRST.
   *
   * This class is what makes the screen's structure say the thing its prose
   * used to: with dev servers up there are two ways to answer — pick a row, or
   * describe an app yourself — and the heading over the list and the "or" rule
   * above the fields are both on. With nothing running there is one way, so
   * both of those disappear and the fields are simply what the card is.
   *
   * It starts off, which is the state the first paint is in: the list is empty
   * and the note says the scan is still running. Turning it on when rows
   * actually arrive is the same moment the rows appear, so nothing moves twice.
   */
  el.form.classList.toggle("has-apps", apps.length > 0)
  show(
    el.appsNote,
    apps.length
      ? ""
      : scanned
        ? "No dev server is running."
        : "Could not check what is running."
  )
  /*
   * A choice made FOR the user is said out loud.
   *
   * Auto-selecting the first app writes two fields and arms the button, and the
   * only thing that used to mark it was a row tint measuring 1.44:1. Someone
   * with three dev servers up could not see which one the big blue button was
   * about to proxy. The row now carries a check glyph and an accent edge, and
   * this sentence names the app the screen settled on — the address and the
   * folder it also wrote are in the two boxes below it, so naming those here
   * as well was the screen reading itself out.
   */
  if (apps.length && el.url.value.trim() === "") {
    await chooseApp(apps[0])
    // "Choose another row if that is not the one" used to follow this, and the
    // rows it refers to are directly above it, each one a control that says so
    // by being one. What is NOT visible is that the screen chose, so that is
    // all this says.
    if (apps.length > 1) show(el.appsNote, "Picked " + appLabel(apps[0]) + " for you.")
  } else render()
}

boot()
`

export function startScreenPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Open an app · designlayer</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<style>${startScreenStyle()}</style>
</head>
<body>
  <main class="card">
  <!--
    EACH FACE LEADS WITH ITS OWN QUESTION, NOT WITH THE PRODUCT'S NAME.

    This was a \`designlayer\` wordmark over every face. It told a reader which
    tool they had opened, which they already knew, and nothing about what to do
    next. The chooser's title is here; an editor that is already up has
    \`#current-name\`, and the wait has \`#progress\`. Only one face is up at a
    time, so only one of them is ever shown.
  -->
  <h1 class="title" id="choose-title">Choose an app to edit</h1>

  <!--
    What is running, for a tab that arrived here rather than one that pressed
    Start. This used to be a redirect, which is why there was no way back to the
    chooser at all: the URL bounced to the editor and the session was over.

    One question and its two answers. It was a "Now editing" label, the name,
    and "Open the editor" — three slots saying the same thing — under a
    wordmark saying a fourth.
  -->
  <div class="section" id="current" hidden>
    <div class="current-app">
      <h1 class="title" id="current-name"></h1>
      <p class="note" id="current-where"></p>
    </div>
    <div class="actions">
      <a class="primary" id="current-open">Continue</a>
      <button type="button" class="ghost" id="current-change">Switch app</button>
    </div>
  </div>

  <!--
    An editor that died is an error, not a tip. It used to be \`class="note"\` —
    muted grey, the same weight as a hint — so a crash read like advice.
  -->
  <p class="error" id="stopped" role="alert" hidden></p>

  <!--
    THE WHOLE SCREEN IS ONE QUESTION — which app do you want to edit — AND IT
    HAS EXACTLY TWO ANSWERS: pick one that is running, or describe one that is
    not. Everything below is that shape, and it used to be six sentences.

    The two answers are two groups with a rule between them carrying the word
    "or". A rule is the LAST tool the layout guidance reaches for, and it is the
    right one here for the reason that guidance gives: space can say "these are
    different things", but only a word can say "these are alternatives, do one".
    Read without it, the list over the fields is a sequence — pick an app, THEN
    fill these in — which is the wrong model and the one the deleted prose spent
    twenty words correcting.

    Both the rule and the list's heading come and go with the list itself (see
    \`.has-apps\`). With no dev server up there is no alternative to be the
    second of, so the card is a wordmark, one grey line saying nothing is
    running, two labelled boxes, and the button.
  -->
  <form id="form" autocomplete="off">
    <!--
      THE LIST GOES FIRST, and it did not use to.
      A row click writes both fields below it. A control belongs above what it
      fills; below them it is a shortcut nobody finds until they have already
      done the work by hand.
    -->
    <div class="section">
      <h2 class="label" id="apps-label">Running apps</h2>
      <div class="apps" id="apps" role="radiogroup" aria-labelledby="apps-label"></div>
      <p class="note" id="apps-note" role="status">Looking for dev servers…</p>
      <p class="error" id="apps-error" role="alert" hidden></p>
    </div>

    <!--
      The other answer: the two things the editor needs about any app, as two
      rows of one grid rather than two stacked stanzas of label, box and
      paragraph. One label column, one field column, one shared edge each — the
      pair reads as a single short form at a glance, which is what it is.

      The help under each field is gone with the stanzas. "The address you would
      open in the browser" restated the label beside a placeholder already
      showing \`http://localhost:3000\`. What survives is the one thing a reader
      cannot derive from either: how macOS coughs up an absolute path at all.
    -->
    <div class="fields">
      <p class="or">or</p>

      <div class="field">
        <label class="label" for="url">App address</label>
        <input id="url" name="url" type="text" spellcheck="false" autofocus
               placeholder="http://localhost:3000">
      </div>

      <div class="field">
        <label class="label" for="folder-path">Code folder</label>
        <input id="folder-path" class="path" type="text" spellcheck="false"
               aria-describedby="folder-help folder-error"
               placeholder="/Users/you/Projects/your-app">
        <p class="note" id="folder-help">In Finder: right-click, hold Option, “Copy as Pathname”.</p>
        <p class="error" id="folder-error" hidden></p>
      </div>

      <div class="field" id="script-row" hidden>
        <label class="label" for="script">Start command</label>
        <select id="script"></select>
      </div>
    </div>

    <div class="section">
      <!--
        NEVER DISABLED for a missing answer. A disabled primary button is a grey
        rectangle that answers no question: it cannot be focused, cannot be
        hovered, and carries no explanation of what would enable it. Pressing
        this one is now how you learn what is missing — it focuses the gap and
        says so. \`disabled\` is left for \`busy\` alone, which is a real
        "not yet" and lasts a second rather than the whole visit.
      -->
      <button type="submit" class="primary" id="submit">Start editing</button>
      <p class="note" id="hint" role="status"></p>
      <p class="error" id="submit-error" role="alert" hidden></p>
    </div>
  </form>

  <div class="waiting" id="waiting" hidden>
    <!--
      A heading, and focusable, because the form that held focus is hidden the
      moment this appears — which used to drop the caret on \`<body>\` and leave
      the page with zero tab stops and no way out but a browser reload.

      NO \`role="status"\` on this element, though it carried one briefly. An
      explicit role replaces the implicit one, so it made the waiting view a
      live region and left it with no heading at all — the very thing the line
      above claims it is. It bought nothing either: this lives inside
      \`#waiting\`, which is \`hidden\` until the state arrives, and a live region
      revealed with its text already in it does not reliably announce. What
      actually reads the sentence is the \`focus()\` in \`waitForEditor\`, which is
      also what rescues the keyboard.
    -->
    <h2 class="progress" id="progress" tabindex="-1">
      <span class="pulse" aria-hidden="true"></span><span id="progress-text"></span>
    </h2>
    <p class="note" id="waiting-note">A first compile can take a minute. Progress shows in your terminal.</p>
    <button type="button" class="ghost" id="waiting-back">Cancel</button>
  </div>
</main>
<script type="module">${CLIENT}</script>
</body>
</html>
`
}
