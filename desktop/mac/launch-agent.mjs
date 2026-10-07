/**
 * The LaunchAgent that keeps the desk server running, as a pure function of its
 * inputs so the exact bytes launchd reads are testable without launchd.
 *
 * Label is `dev.designlayer.desk`: a user agent in the gui domain under this
 * project's own reverse-DNS prefix.
 */

import os from "node:os"
import path from "node:path"

import { DESK_LABEL, deskPlistPath } from "../../runtime/mac-desk.mjs"

// Defined beside the launcher's check for this plist, which ships in the
// package when this directory does not (runtime/mac-desk.mjs).
export const LABEL = DESK_LABEL

export function plistPath(home = os.homedir()) {
  return deskPlistPath(home)
}

export function logDir(home = os.homedir()) {
  return path.join(home, "Library", "Logs", "DesignLayer")
}

const escapeXml = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function plistValue(value, indent) {
  const pad = "  ".repeat(indent)
  if (value === true) return `${pad}<true/>`
  if (value === false) return `${pad}<false/>`
  if (typeof value === "number") return `${pad}<integer>${value}</integer>`
  if (Array.isArray(value)) {
    return [`${pad}<array>`, ...value.map((item) => plistValue(item, indent + 1)), `${pad}</array>`].join("\n")
  }
  if (value && typeof value === "object") {
    const lines = [`${pad}<dict>`]
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      lines.push(`${pad}  <key>${escapeXml(key)}</key>`, plistValue(item, indent + 1))
    }
    lines.push(`${pad}</dict>`)
    return lines.join("\n")
  }
  return `${pad}<string>${escapeXml(value)}</string>`
}

/**
 * Every path absolute: launchd resolves nothing against a shell, so a bare
 * `node` or a relative script path would fail at load with no terminal to say so.
 */
export function buildPlist({ nodePath, serverPath, repoRoot, env, logFile, port }) {
  for (const [name, value] of Object.entries({ nodePath, serverPath, repoRoot, logFile })) {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  }
  const environment = {
    PATH: env?.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: env?.HOME,
    LANG: env?.LANG ?? "en_US.UTF-8",
    ...(port ? { DESIGNLAYER_DESK_PORT: String(port) } : {}),
  }
  const dict = {
    Label: LABEL,
    ProgramArguments: [nodePath, serverPath],
    WorkingDirectory: repoRoot,
    EnvironmentVariables: environment,
    StandardOutPath: logFile,
    StandardErrorPath: logFile,
    RunAtLoad: true,
    // Restart after a crash, not after a clean exit (bootout, or `--stop`).
    KeepAlive: { SuccessfulExit: false },
    ProcessType: "Interactive",
    ThrottleInterval: 10,
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(dict, 0),
    "</plist>",
    "",
  ].join("\n")
}
