/**
 * What a start-screen choice is made of, checked: the app's address, the
 * project folder, and the dev script, from the page's POST /api/start or from
 * a resume after a restart.
 *
 * Pure input validation, apart from the HTTP server (runtime/start-screen.mjs)
 * so each check can be read, and tested, on its own. The page is untrusted
 * input like any other client, so these refusals are the safety story of the
 * start screen, not a formality: the editor it starts proxies whatever origin
 * it is handed and writes into whatever folder it is given. Each refusal is a
 * `badRequest` whose message is a sentence, because whoever reads one is
 * looking at a screen.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { isLoopbackHost } from "./chooser-url.mjs"

import { isDirectory } from "./local-apps.mjs"

// The one loopback rule, re-exported for the start screen, which guarded its
// routes with a private copy of it.
export { isLoopbackHost }

/** An error the server answers with `statusCode` and the message as the sentence. */
export function badRequest(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}


/**
 * The one thing a pasted path may be that `path.isAbsolute` refuses.
 *
 * A path arrives here from a text field, and that field is the only way to name
 * a project the scan did not find for itself. Every other source of a path on
 * this machine — the shell, `pwd`, Finder's Copy as Pathname — writes `~` for
 * the home directory, so a field that rejected it would be rejecting the most
 * likely thing to be typed into it, with nothing else left to try.
 */
function expandHome(value) {
  if (typeof value !== "string") return value
  if (value !== "~" && !value.startsWith("~/")) return value
  return path.join(os.homedir(), value.slice(1))
}

/**
 * The other thing a pasted path may be: shell-escaped.
 *
 * Dragging a folder onto a terminal — the most direct way there is to get a
 * path out of the Finder and into a field — writes `IG\ Projects\ Local`, and
 * `\ ` is the shell's escaping, not a folder called `IG\`. Copying the command
 * line of a running dev server produces the same thing. A path that exists
 * exactly as typed always wins, so the rare real backslash in a filename is
 * still reachable; only a path that is otherwise not there is unescaped.
 *
 * Windows paths are exempt, where a backslash IS the separator.
 */
function unescapePastedPath(value) {
  if (!value.startsWith("/") || !value.includes("\\") || fs.existsSync(value)) return value
  return value.replace(/\\(.)/g, "$1")
}

/** Everything done to a path between the text field and the filesystem. */
export const pastedPath = (value) =>
  typeof value === "string" ? unescapePastedPath(expandHome(value.trim())) : value

/** The port a parsed URL reaches, with the scheme's default when it names none. */
const portOf = (parsed) => Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80)

/** A typed app address, checked: `{ appUrl, appPort, appPath }`, or a 400 that says what is wrong. */
export function parseAppUrl(value) {
  if (typeof value !== "string" || value.trim() === "") throw badRequest("Choose an app, or type the address of the one to edit.")

  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    throw badRequest(`"${value.trim()}" is not a valid address. Try http://localhost:3000.`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw badRequest(`Use an http:// or https:// address.`)
  if (!isLoopbackHost(parsed.origin)) {
    throw badRequest(
      `Only apps on this machine can be edited: localhost, 127.0.0.1 or ::1.`
    )
  }
  return {
    appUrl: parsed.origin,
    appPort: portOf(parsed),
    appPath: appPathOf(parsed),
  }
}

/**
 * The editor's address as a browser should use it: on `localhost`.
 *
 * Apps branch on `location.hostname`: a dev-only sign-in bypass, an auth
 * provider's allowlist, a feature flag, and the usual test is
 * `=== "localhost"`. Served from `127.0.0.1`, such an app showed its signed-out
 * screen inside the editor while the same app in a plain tab showed itself. It
 * did so whether the app was typed, picked from a row, or switched to from the
 * editor's own chooser, so the name is not taken from what was typed: every
 * address this server sends a browser to is on `localhost`. The proxy listens
 * on 127.0.0.1, which `localhost` reaches in every browser.
 */
export function inBrowser(url) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== "127.0.0.1") return url
    parsed.hostname = "localhost"
    // `href` adds a "/" to a bare origin, and every URL this server reports is
    // a bare origin with the page put back on after.
    return parsed.origin
  } catch {
    return url
  }
}

/**
 * The page half of the address, kept apart from the origin the editor is aimed
 * at.
 *
 * The chooser is where you say which app AND which page, and the two answers
 * have different destinations: the origin picks the child process, the page
 * picks where the browser lands on the proxy that child puts up. Nothing about
 * the child differs by one page — the proxy serves the whole app — so the path
 * never travels with the choice, only alongside it.
 *
 * A bare origin has to stay bare. `pathname` is "/" even for a URL that was
 * typed without one, and turning `http://127.0.0.1:3456` into
 * `http://127.0.0.1:3456/` would change every URL this server has ever
 * reported.
 *
 * The fragment is kept. It never reaches a server, but this path is not for a
 * server: it is where the browser lands, and an app with a hash router keeps
 * its whole page there. Dropping it opened `/#/settings?tab=a` on the app's
 * home page instead.
 */
function appPathOf(parsed) {
  const page = `${parsed.pathname}${parsed.search}${parsed.hash}`
  return page === "/" ? "" : page
}

/**
 * The vendored CLI also refuses a project without React, but it refuses AFTER
 * boot from inside its own banner. Checking here is the difference between an
 * inline message on the screen and a terminal that simply stops.
 */
export function resolveProject(raw) {
  if (typeof raw !== "string" || raw.trim() === "") throw badRequest("Confirm the project folder before starting.")
  const value = pastedPath(raw)
  if (!path.isAbsolute(value)) throw badRequest(`Enter a full path, like /Users/you/Projects/app.`)

  let projectRoot
  try {
    projectRoot = fs.realpathSync(value)
  } catch (error) {
    // A protected folder refuses `realpath` along with `stat` while still
    // opening and reading; the path as pasted is then the best name it has.
    if (error.code !== "EPERM" || !isDirectory(value)) throw badRequest(`There is no folder at ${value}. Check the path.`)
    projectRoot = value
  }

  if (!isDirectory(projectRoot)) throw badRequest(`${value} is a file, not a project folder. Pick the folder that contains it.`)

  let text
  try {
    text = fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")
  } catch {
    throw badRequest(`No package.json in ${projectRoot}. Pick the folder that contains it.`)
  }
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    throw badRequest(`The package.json in ${projectRoot} is not valid JSON. Fix the file, then try again.`)
  }

  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
  const name = manifest.name ?? path.basename(projectRoot)
  /*
   * A project this editor has a lane for. React was the only answer when this
   * guard was written, and it stayed the only answer after the Angular lane
   * landed — so the start screen refused, by name, the exact projects the
   * editor had just learned to edit. Every other entry point had been taught
   * about Angular; this one had not, and it is the one a designer uses.
   *
   * The two dependencies are the same signals `resolveHostFramework` reads, and
   * they are checked here rather than delegated because this must fail as a
   * sentence on the page. Refusing later, inside the child process, reaches the
   * terminal that nobody running the start screen is looking at.
   */
  if (typeof dependencies.react !== "string" && typeof dependencies["@angular/core"] !== "string") {
    throw badRequest(
      `${name} does not use React or Angular, the two frameworks the editor supports.`
    )
  }

  return { projectRoot, manifest, packageName: name }
}

/**
 * `describeProject` offers the page a shortlist of likely dev scripts, but that
 * list is a heuristic and this is a guard, so the name is checked against the
 * manifest itself: nothing but a real `npm run` target can be handed on.
 */
export function resolveDevScript(value, projectRoot, manifest) {
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || typeof manifest.scripts?.[value] !== "string") {
    throw badRequest(
      `No "${value}" script in ${path.basename(projectRoot)}/package.json.`
    )
  }
  return value
}

/** The real folder, for comparing two names of one project. */
export function realFolder(dir) {
  if (typeof dir !== "string" || dir.length === 0) return null
  try {
    return fs.realpathSync(dir)
  } catch {
    return dir
  }
}

/** The port of any URL, or null for one that does not parse. */
export function portOfOrigin(url) {
  try {
    return portOf(new URL(url))
  } catch {
    return null
  }
}
