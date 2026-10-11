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
 */

import path from "node:path"

export function appName({ projectRoot = null, packageName = null } = {}) {
  const folder = typeof projectRoot === "string" && projectRoot.length > 0 ? path.basename(projectRoot) : ""
  if (folder) return folder
  return typeof packageName === "string" && packageName.length > 0 ? packageName : null
}
