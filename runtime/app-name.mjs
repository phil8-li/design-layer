/**
 * The name every surface shows for an app: its project folder.
 *
 * It used to be the package name, which copies of one template all share. Four
 * prototypes had one name in the editor's chooser, on the start screen's card,
 * in the Mac app's tabs and in the terminal, and the one you were in could not
 * be told from the one you picked. The folder is the name a person gave each
 * copy. Only the last segment travels, never the path above it.
 *
 * The package name is the fallback for a project with no folder to name, which
 * is a launch that never resolved one.
 *
 * A name the person gave the app in the Mac app's tabs comes before the folder
 * wherever a surface can read it, as `givenName` (`givenAppName` below): the
 * start screen's rows, and the editor's header, app menu and what it hands the
 * agent (DESIGN.md "Tab names"). The folder name stays what this returns, and
 * what an editor tells the desk it shows: the desk's "Use folder name" goes
 * back to it.
 */

import path from "node:path"

export function appName({ projectRoot = null, packageName = null } = {}) {
  const folder = typeof projectRoot === "string" && projectRoot.length > 0 ? path.basename(projectRoot) : ""
  if (folder) return folder
  return typeof packageName === "string" && packageName.length > 0 ? packageName : null
}

/**
 * The name the person gave an app in the Mac app's tabs, or null. `names` is
 * the desk's `{ "projectRoot|port": name }` (runtime/mac-desk.mjs
 * `readDeskNames`), keyed by the project folder and the app's port.
 */
export function givenAppName(names, projectRoot, port) {
  const name = typeof projectRoot === "string" && projectRoot && port ? names?.[`${projectRoot}|${port}`] : null
  return typeof name === "string" && name.trim() ? name.trim() : null
}
