/**
 * Host configuration for DesignLayer.
 *
 * One resolved object is the single source of truth for every value that used
 * to be a literal in three places at once: the chrome selectors (vendor patch
 * AND client), the project roots (options store AND agent), the API prefix
 * (server AND client AND test harness), and the ports (launcher AND harness).
 *
 * Defaults target a stock Next.js + Tailwind app and know nothing about the
 * repository they happen to be copied from. Optional host tools (Leva,
 * Agentation, a docked dev panel) are integrations declared by the host config,
 * never package assumptions.
 */

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { companionSelectors, resolveCompanions } from "./server/companions.mjs"
import { DEFAULT_THEME_NAMESPACES } from "./server/design-system-aliases.mjs"
import {
  DEFAULT_TAILWIND_BREAKPOINTS,
  resolveDesignSystemConfig,
} from "./server/design-system-config.mjs"
import { resolveIconSetConfig } from "./server/icon-set.mjs"
import { appName } from "./runtime/app-name.mjs"
import { findConfigFile } from "./runtime/config-file.mjs"
import {
  DEV_SCRIPT_PREFERENCE,
  NEXT_CONFIG_FILES,
  TAILWIND_CONFIG_FILES,
  VITE_CONFIG_FILES,
  hasRootFile,
  manifestDependencies,
  packageNameOf,
  readManifest,
} from "./runtime/project-facts.mjs"

/*
 * The source-path guard every route that touches a file goes through. It lives
 * in runtime/source-guard.mjs, apart from config resolution; these two names
 * stay on this module because the server's writers import them from here.
 */
export { isEditableSourcePath, resolveEditableSource } from "./runtime/source-guard.mjs"

// Tailwind's own palette stems. Always present; a host adds to this, never
// replaces it.
const PALETTE_WORDS = [
  "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber",
  "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue",
  "indigo", "violet", "purple", "fuchsia", "pink", "rose", "black", "white",
  "transparent", "current", "inherit",
]

// shadcn/ui's semantic token vocabulary, which `components.json` hosts share.
const SHADCN_WORDS = [
  "foreground", "background", "muted", "primary", "secondary", "accent",
  "destructive", "border", "input", "ring", "card", "popover", "sidebar",
]

// Tailwind v3's discrete spacing table. v4 accepts every integer, so a host on
// v4 should set `spacingScale: "v4-linear"` to stop emitting arbitrary values
// for tokens that now exist.
const V3_SPACING_SCALE = {
  0: "0", 1: "px", 2: "0.5", 4: "1", 6: "1.5", 8: "2", 10: "2.5", 12: "3",
  14: "3.5", 16: "4", 20: "5", 24: "6", 28: "7", 32: "8", 36: "9", 40: "10",
  44: "11", 48: "12", 56: "14", 64: "16", 80: "20", 96: "24", 112: "28",
  128: "32",
}

export const DEFAULT_CONFIG = {
  // `devScript` is the host's own npm script, run only under `--dev`. Named
  // rather than assumed to be `next dev`, because the script is where a host
  // keeps the env, the flags and the wrapper its app actually needs.
  app: { port: null, host: "127.0.0.1", open: false, devScript: "dev" },
  // `proxy` and `ws` are `auto` because the vendor abandons its own defaults the
  // moment either is busy, and nothing outside this process has to predict them.
  // `mcp` is the opposite case: its URL is typed into a coding agent's config
  // file by hand, so it has to be the same number tomorrow. `null` turns it off.
  ports: { proxy: "auto", ws: "auto", mcp: 5747 },
  projectRoot: null,
  stateDir: ".local/designlayer",
  apiPrefix: "/__designlayer",
  chrome: {
    // Elements the editor must never treat as canvas: its own shell, and the
    // host's dev GUI. An empty list is legal — `closest("")` throws, so the
    // patch guards on the empty string rather than calling it.
    trustedSelectors: [],
    dockedPanel: {
      selector: "",
      fallbackSelector: "",
      chromeSelectors: [],
      offsetVar: "--designlayer-docked-panel-offset",
      widthVar: "--designlayer-docked-panel-width",
      minWidth: 260,
      maxWidth: 380,
      gap: 12,
      edgeGap: 8,
    },
  },
  // Other people's dev-time browser tooling, loaded beside the editor rather
  // than instead of it — a bundle, plus the selectors it draws under so the
  // canvas never mistakes it for the app. Empty by default: the editor pulls
  // nothing onto a page the host did not ask for. See server/companions.mjs.
  companions: [],
  // The host's icon set: the DOM attribute an icon names itself with, and the
  // JSON of drawings the picker offers as its variants. Absent by default —
  // a stock app has no such attribute, and the icon section stays hidden.
  icons: { attribute: "", data: null },
  designSystem: {
    manifest: null,
    // A host whose tokens are not a Figma-style manifest: a function (or an
    // object) returning the same normalized token groups. One escape hatch, not
    // a plugin system — see server/design-system-config.mjs.
    adapter: null,
    cssSources: [],
    breakpoints: null,
    containerBreakpoints: null,
    responsiveMeasures: null,
    // Tailwind v3 keeps its scale in `tailwind.config.js` rather than in a
    // stylesheet, so a v3 host has no `@theme` custom property to trace and
    // would otherwise resolve no aliases at all. Either key gives the v3 arm
    // its input; `tailwindTheme` is the declared form, `tailwindConfig` reads
    // the host's own file so the scale keeps one owner.
    tailwindTheme: null,
    tailwindConfig: null,
    // "em" or "px" — the unit the manifest states letter-spacing in. Declared,
    // because a magnitude does not say which one it is.
    trackingUnit: null,
  },
  controls: { leva: null },
  tailwind: {
    colorWords: [],
    fontSizes: ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl"],
    fontFamilies: ["sans", "serif", "mono"],
    spacingBase: 4,
    spacingScale: "v3-default",
    breakpoints: DEFAULT_TAILWIND_BREAKPOINTS,
    containerBreakpoints: {},
    spacedStems: null,
    // The `@theme` namespaces a v4 host spells its scales with. Tailwind's own
    // four are the default; a host that renames or extends them says so here
    // rather than being told what its variables are called.
    themeNamespaces: [...DEFAULT_THEME_NAMESPACES],
  },
  source: { roots: [], extensions: [".tsx", ".jsx", ".ts", ".js", ".mts", ".mjs"] },
  // Which UI framework the host app is written in, and whether it compiles
  // Tailwind. "auto"/null mean "work it out from the project", which is what
  // every host should leave them as: both are properties of the project, not
  // things a config file should have to restate.
  //
  // They are first-class settings rather than runtime sniffs because several
  // decisions hang off them before the browser exists — whether the vendored
  // React CLI's detection gates have to be answered, which file extensions the
  // writer may touch, and which resolver the editor bundle uses.
  host: { framework: "auto", tailwind: null },
  /*
   * Design-system libraries added by URL.
   *
   * `fetchCommand` is the escape hatch for a catalog this process cannot
   * authenticate to on its own — an internal Storybook behind an SSO proxy, say.
   * The editor already asks for a bearer token or a cookie and stores it per
   * origin (see `server/library-auth.mjs`); this is for the organisations whose
   * proxy has a command-line client instead, where a stored token would expire
   * daily and the tool can mint one per request.
   *
   * An argv array with `{url}` substituted per argument. The command must PRINT
   * a full HTTP response — status line, headers, blank line, body — which is
   * what `curl -i` and most such clients already emit. A bare body is refused,
   * because an error page and a catalog are then indistinguishable.
   *
   *   libraries: { fetchCommand: ["curl", "-sSi", "--cert", "…", "{url}"] }
   *
   * Empty by default: out of the box the editor runs no external command.
   */
  libraries: { fetchCommand: [] },
  vendor: { package: "react-rewrite-cli" },
  // No `agent` block, and the absence is the point. The editor used to be able
  // to call a model itself, which needed a transport to choose, a model name, a
  // token budget and an overridable system prompt. The only surface that
  // reached that path has been removed; `/agent` writes a handoff brief and
  // wakes an agent the designer already runs, and not one of those settings has
  // anything left to select.
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function merge(base, override) {
  if (!isPlainObject(override)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    out[key] = isPlainObject(base[key]) ? merge(base[key], value) : value
  }
  return out
}

function resolveSpacingScale(tailwind) {
  const { spacingScale, spacingBase } = tailwind
  if (isPlainObject(spacingScale)) return spacingScale
  if (spacingScale === "v4-linear") {
    // v4 resolves `p-<n>` to `calc(var(--spacing) * n)`, so every multiple of
    // the base is a real token and needs no arbitrary value.
    const table = {}
    for (let px = 0; px <= 384; px += spacingBase) table[px] = String(px / spacingBase)
    table[1] = "px"
    return table
  }
  return V3_SPACING_SCALE
}

function resolveLevaConfig(value, projectRoot) {
  if (!isPlainObject(value) || typeof value.storeGlobal !== "string" || !value.storeGlobal) {
    return null
  }

  const source = isPlainObject(value.sourceDefaults) ? value.sourceDefaults : null
  const sourceDefaults =
    source && typeof source.file === "string" && typeof source.exportName === "string"
      ? Object.freeze({
          file: path.resolve(projectRoot, source.file),
          exportName: source.exportName,
        })
      : null

  const bindings = Array.isArray(value.bindings)
    ? value.bindings
        .filter((binding) => isPlainObject(binding) && typeof binding.pathPattern === "string")
        .map((binding) =>
          Object.freeze({
            pathPattern: binding.pathPattern,
            selectors: Array.isArray(binding.selectors)
              ? binding.selectors.filter((selector) => typeof selector === "string" && selector)
              : [],
            relationship:
              typeof binding.relationship === "string" && binding.relationship
                ? binding.relationship
                : "affects",
            defaultGroup:
              typeof binding.defaultGroup === "string" && binding.defaultGroup
                ? binding.defaultGroup
                : null,
            defaultKey:
              typeof binding.defaultKey === "string" && binding.defaultKey
                ? binding.defaultKey
                : null,
          })
        )
    : []

  return Object.freeze({
    storeGlobal: value.storeGlobal,
    sourceDefaults,
    bindings: Object.freeze(bindings),
  })
}

const HOST_FRAMEWORKS = new Set(["react", "angular"])

/**
 * What the host's dev server is, and what it takes to start one on a chosen
 * port.
 *
 * One probe, four consumers: which editing lane the browser uses, which port
 * `--dev` picks when nothing names one, and whether the port and the interface
 * have to be spelled on the command line.
 *
 * The two flag columns are the ones that cost bugs, and both were measured on a
 * real machine rather than read off a docs page.
 *
 * PORT: `next dev` reads the environment variable, which is the only mechanism
 * this package ever had. `vite` does not — `PORT=3999 vite` binds 5173 and says
 * so — and neither does `ng serve`. A `--dev` run against either started the
 * app on the framework's own default while the launcher waited on the port it
 * had asked for.
 *
 * HOST: worse, because it is silent. `vite` and `ng serve` both default to
 * `localhost`, and on a machine that resolves that to IPv6 they bind `[::1]`
 * and NOTHING on `127.0.0.1` — measured for both. The launcher probes
 * `127.0.0.1`, the vendored proxy targets `127.0.0.1`, so the app was up,
 * reachable in a browser, and invisible to the editor.
 *
 * Create React App takes neither flag and reads `PORT` and `HOST` instead,
 * which is why this is a table rather than "pass everything and hope".
 */
const DEV_SERVERS = {
  angular: { framework: "angular", port: 4200, portFlag: "--port", hostFlag: "--host" },
  next: { framework: "react", port: 3000, portFlag: "--port", hostFlag: "--hostname" },
  vite: { framework: "react", port: 5173, portFlag: "--port", hostFlag: "--host" },
  cra: { framework: "react", port: 3000, portFlag: null, hostFlag: null },
  unknown: { framework: "react", port: 3000, portFlag: null, hostFlag: null },
}

/**
 * Which of the five the host is, by the dependency that decides it.
 *
 * Angular is tested first because its scaffolds may carry a `vite.config.ts` of
 * their own, and `next` before `vite` because a Next project can depend on Vite
 * for its tests. The fallthrough is `unknown`, which behaves exactly as this
 * package behaved before any of this existed.
 */
export function detectDevServer(projectRoot) {
  const deps = manifestDependencies(readManifest(projectRoot))

  if (deps["@angular/core"]) return "angular"
  if (deps.next || hasRootFile(projectRoot, NEXT_CONFIG_FILES)) return "next"
  if (deps["react-scripts"]) return "cra"
  if (deps.vite || hasRootFile(projectRoot, VITE_CONFIG_FILES)) return "vite"
  return "unknown"
}

/**
 * Whether the host compiles Tailwind.
 *
 * A separate question from the framework, and the one that actually decides
 * whether a utility class means anything. The React lane's whole writer speaks
 * in utilities, the Code tab offers a "Tailwind classes" view, and the
 * Responsive section writes `md:grid-cols-2` — all three are noise in a project
 * that has no Tailwind, whether that project is Angular or React.
 *
 * The dependency is the reliable signal: Tailwind has to be installed to
 * compile, however the host wires it up. The config file is checked too, for a
 * host that resolves the package through a workspace root this cannot see.
 */
export function detectTailwind(projectRoot) {
  if (manifestDependencies(readManifest(projectRoot)).tailwindcss) return true
  return hasRootFile(projectRoot, TAILWIND_CONFIG_FILES)
}

/**
 * Which framework the app under the overlay is written in.
 *
 * Detected from the dependency that decides it, not from a config file that
 * happens to sit beside one. `react` is the fallback rather than a third
 * "unknown" state, because every path this value gates already behaved as if
 * the host were React — an unrecognised project keeps that behaviour instead of
 * acquiring a new failure mode.
 */
export function resolveHostFramework(projectRoot, configured = "auto") {
  if (HOST_FRAMEWORKS.has(configured)) return configured
  if (configured !== "auto" && configured !== undefined && configured !== null) {
    throw new Error(`host.framework must be "auto", "react" or "angular" (got ${configured})`)
  }
  return DEV_SERVERS[detectDevServer(projectRoot)].framework
}

/**
 * The file kinds the writer may touch, widened for a framework whose markup is
 * not in its script files.
 *
 * Only when the host has NOT set `source.extensions` itself. The allowlist is
 * the last thing standing between the browser and a file it should not reach,
 * so a host that narrowed it deliberately keeps exactly what it asked for.
 */
function hostSourceExtensions(extensions, framework, overridden) {
  if (framework !== "angular" || overridden) return extensions
  return [...new Set([...extensions, ".html", ".css", ".scss"])]
}

/**
 * The npm script `--dev` runs, resolved against the scripts the host actually
 * has.
 *
 * `"dev"` is the right default for Next and Vite and the wrong one for Angular,
 * whose `ng new` writes `start` and no `dev` at all — so `designlayer --dev`
 * on a stock Angular project used to die on `Missing script: dev`, and the fix
 * was a flag the designer had to know to pass. Naming a script the project does
 * not have is not a default, it is a guess, and this is the one place that can
 * check.
 *
 * An explicitly configured name always wins, even a wrong one: a host that says
 * `devScript: "dev"` and has no `dev` script should hear that from npm rather
 * than have this quietly run something else.
 */
export function resolveDevScript(projectRoot, configured, explicit) {
  if (explicit) return configured
  const scripts = readManifest(projectRoot)?.scripts
  if (!scripts || typeof scripts !== "object") return configured
  const has = (name) => typeof scripts[name] === "string"
  if (has(configured)) return configured
  return DEV_SCRIPT_PREFERENCE.find(has) ?? configured
}

/**
 * The port `--dev` starts the app on when nothing names one.
 *
 * A dev server has to be told a port before it can be asked which one it took,
 * so this is a guess by construction — but the framework narrows it to one
 * guess that is nearly always right, and an Angular project that moved its port
 * says so in `angular.json`, which is better than any default.
 */
export function resolveDevPort(projectRoot, devServer) {
  if (devServer === "angular") {
    try {
      const angularJson = JSON.parse(
        fs.readFileSync(path.join(projectRoot, "angular.json"), "utf8")
      )
      for (const project of Object.values(angularJson.projects ?? {})) {
        const port =
          project?.architect?.serve?.options?.port ?? project?.targets?.serve?.options?.port
        if (Number.isInteger(port)) return port
      }
    } catch {
      // No angular.json, or one this cannot read. The CLI's own default stands.
    }
  }
  return DEV_SERVERS[devServer].port
}

/**
 * Merges host overrides onto the defaults and makes every path absolute.
 * `projectRoot` defaults to the directory the config file was found in, so it
 * tracks the HOST even when this package is installed under node_modules.
 */
export function resolveConfig(raw = {}, { configPath = null, cwd = process.cwd() } = {}) {
  if (raw.designSystem !== undefined && !isPlainObject(raw.designSystem)) {
    throw new Error("designSystem must be an object with manifest and cssSources")
  }
  const merged = merge(DEFAULT_CONFIG, raw)
  const rootBase = configPath ? path.dirname(configPath) : cwd
  const projectRoot = path.resolve(rootBase, merged.projectRoot ?? ".")
  const stateDir = path.resolve(projectRoot, merged.stateDir)
  const leva = resolveLevaConfig(merged.controls?.leva, projectRoot)
  if (!isPlainObject(merged.tailwind.breakpoints)) {
    throw new Error("tailwind.breakpoints must be an object of CSS pixel values")
  }
  if (!isPlainObject(merged.tailwind.containerBreakpoints)) {
    throw new Error("tailwind.containerBreakpoints must be an object of CSS pixel values")
  }
  const tailwind = Object.freeze({
    ...merged.tailwind,
    colorWords: [...PALETTE_WORDS, ...SHADCN_WORDS, ...merged.tailwind.colorWords],
    spacingScale: resolveSpacingScale(merged.tailwind),
    breakpoints: Object.freeze({ ...merged.tailwind.breakpoints }),
    containerBreakpoints: Object.freeze({ ...merged.tailwind.containerBreakpoints }),
  })
  const designSystem = resolveDesignSystemConfig(
    merged.designSystem,
    projectRoot,
    tailwind.breakpoints,
    tailwind.containerBreakpoints,
    tailwind
  )

  const icons = resolveIconSetConfig(merged.icons, projectRoot)
  const companions = resolveCompanions(merged.companions, projectRoot)
  const devServer = detectDevServer(projectRoot)
  const framework = resolveHostFramework(projectRoot, merged.host?.framework)
  const tailwindPresent =
    typeof merged.host?.tailwind === "boolean"
      ? merged.host.tailwind
      : detectTailwind(projectRoot)

  const apiPrefix = merged.apiPrefix.startsWith("/")
    ? merged.apiPrefix.replace(/\/+$/, "")
    : `/${merged.apiPrefix.replace(/\/+$/, "")}`

  // De-duplicated, because the same selector arriving from the host config and
  // from a companion manifest would otherwise be matched twice on every hit
  // test, and shown twice everywhere the list is reported.
  const trustedSelectors = Object.freeze([
    ...new Set([...merged.chrome.trustedSelectors, ...companionSelectors(companions)]),
  ])

  return Object.freeze({
    ...merged,
    app: Object.freeze({
      ...merged.app,
      devScript: resolveDevScript(
        projectRoot,
        merged.app.devScript,
        typeof raw.app?.devScript === "string"
      ),
      // The port and flags `--dev` uses when neither the command line nor this
      // config names one. Reported rather than applied: `app.port` stays null
      // so "the host did not say" and "the host said 3000" stay distinguishable.
      devPort: resolveDevPort(projectRoot, devServer),
      devPortFlag: DEV_SERVERS[devServer].portFlag,
      devHostFlag: DEV_SERVERS[devServer].hostFlag,
    }),
    configPath,
    projectRoot,
    stateDir,
    endpointFile: path.join(stateDir, "endpoint.json"),
    apiPrefix,
    companions,
    chrome: Object.freeze({
      ...merged.chrome,
      // A companion's own selectors join the host's. It is the same statement —
      // "this is chrome, not canvas" — and making the host restate it would
      // mean a machine-wide companion could never be trusted at all, since the
      // project whose page it lands on has never heard of it.
      trustedSelectors,
      trustedSelector: trustedSelectors.join(","),
      dockedPanel: Object.freeze({
        ...merged.chrome.dockedPanel,
        chromeSelector: merged.chrome.dockedPanel.chromeSelectors.join(","),
      }),
    }),
    tailwind,
    designSystem,
    icons,
    controls: Object.freeze({ leva }),
    // Frozen with its array copied, so a caller cannot push an argument onto
    // the command this process will later execute.
    libraries: Object.freeze({
      fetchCommand: Object.freeze(
        (Array.isArray(merged.libraries?.fetchCommand) ? merged.libraries.fetchCommand : [])
          .filter((part) => typeof part === "string" && part.length > 0)
      ),
    }),
    host: Object.freeze({ framework, devServer, tailwind: tailwindPresent }),
    source: Object.freeze({
      ...merged.source,
      roots: merged.source.roots.map((entry) => path.resolve(projectRoot, entry)),
      extensions: hostSourceExtensions(
        merged.source.extensions.map((ext) => ext.toLowerCase()),
        framework,
        Array.isArray(raw.source?.extensions)
      ),
    }),
  })
}

// A specifier in the config's own source that has to be re-based when the
// module is evaluated from somewhere other than its own folder.
const RELATIVE_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'])(\.\.?\/[^"']*)\2/g

/**
 * The config file, evaluated from its source rather than from its path.
 *
 * Node's ESM resolver `stat`s a specifier before reading it, and on a managed
 * Mac `stat` is the one call TCC refuses for a protected folder — `readFileSync`
 * on the very same file succeeds. So a project living under, say, a protected
 * Documents subtree gets `ERR_MODULE_NOT_FOUND` for a file that is plainly
 * there, and the CLI dies a second after the start screen hands off.
 *
 * Reading the bytes and evaluating them as a module sidesteps the resolver
 * entirely. Relative specifiers inside the config are re-based to absolute
 * `file://` URLs first, since a `data:` module has no folder to be relative to.
 */
async function importConfigModule(found) {
  try {
    return await import(pathToFileURL(found).href)
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error
    const base = pathToFileURL(found)
    const source = fs
      .readFileSync(found, "utf8")
      .replace(RELATIVE_SPECIFIER, (whole, lead, quote, specifier) => {
        try {
          return `${lead}${quote}${new URL(specifier, base).href}${quote}`
        } catch {
          return whole
        }
      })
    return await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
  }
}

/** Loads `designlayer.config.mjs` if the host has one, else pure defaults. */
export async function loadConfig({ configPath, cwd = process.cwd(), overrides = {} } = {}) {
  const found = configPath ? path.resolve(cwd, configPath) : findConfigFile(cwd)
  if (found && !fs.existsSync(found)) {
    throw new Error(`DesignLayer config not found: ${found}`)
  }

  let raw = {}
  if (found) {
    const loaded = await importConfigModule(found)
    const exported = loaded.default ?? loaded.config ?? {}
    raw = typeof exported === "function" ? await exported() : exported
  }

  return resolveConfig(merge(raw, overrides), { configPath: found, cwd })
}

/**
 * What the chrome calls the host project before it has asked the server
 * anything: its folder, by the one rule every surface uses
 * (runtime/app-name.mjs). Copies of one template share a package name, so the
 * package name named the wrong app as often as the right one. The prelude
 * still carries no path: only the last segment travels.
 */
function hostAppName(projectRoot) {
  return appName({ projectRoot, packageName: packageNameOf(projectRoot) })
}

/**
 * The browser half of the contract. Prepended to the overlay bundle rather than
 * fetched, so the injected vendor functions and the first-party chrome read one
 * object and invariant 4 (no `import` in the served bundle) still holds.
 */
export function browserPrelude(config, runtime = {}) {
  // Only what the chrome reads (src/core/config.ts, src/options/inventory.ts):
  // this text is in every overlay body, and a key with no reader is bytes on
  // every page load and a promise nobody keeps.
  const payload = {
    apiBase: config.apiPrefix,
    chrome: {
      trustedSelector: config.chrome.trustedSelector,
      dockedPanel: {
        offsetVar: config.chrome.dockedPanel.offsetVar,
        widthVar: config.chrome.dockedPanel.widthVar,
      },
    },
    tailwind: config.tailwind,
    // Which resolver and which write lane the editor bundle uses. The browser
    // could sniff for `window.ng`, and it does check — but a page that has not
    // bootstrapped yet has no `ng`, so the authoritative answer has to arrive
    // from the side that read the host's package.json.
    host: config.host,
    // Absolute manifest and stylesheet paths stay in the server-side config.
    designSystem: config.designSystem.catalog,
    // The attribute, not the drawings: 114KB of path data would be paid for on
    // every page load. `GET {apiBase}/icons` serves the set when asked.
    icons: { attribute: config.icons.attribute, available: Boolean(config.icons.data) },
    controls: {
      leva: config.controls.leva
        ? {
            storeGlobal: config.controls.leva.storeGlobal,
            bindings: config.controls.leva.bindings,
            sourceDefaults: Boolean(config.controls.leva.sourceDefaults),
          }
        : null,
    },
    // This launcher keeps the served bundle out of canvas view's frames (see
    // runtime/board-frame.mjs). Stated rather than assumed because the chrome
    // bundle is read from dist/ per request: an editor started before the guard
    // serves the new chrome inside the old wrapper, and the chrome has to be
    // able to tell, or its frames would each boot a second editor.
    boardFrames: true,
    // The screen this editor was chosen from, so the chrome can offer a way
    // back to it. Null for every session that had no such screen, and the
    // launcher has already refused anything that is not a loopback http URL —
    // this one is injected into the page and then navigated to, which is a
    // stronger claim than the rest of this payload makes.
    //
    // A URL is all that crosses. Nothing about the host's own files does: the
    // prelude has never named a source path, and the chooser knowing which
    // folder it started is not a reason for the browser to.
    chooserUrl: typeof runtime.chooserUrl === "string" ? runtime.chooserUrl : null,
    // DesignLayer.app's desk on this Mac (runtime/mac-desk.mjs), so a browser
    // tab can offer to move the editor into the app. Null wherever the app is
    // not installed, and the toolbar then draws no such control. Like the
    // chooser, an origin and nothing else.
    deskUrl: typeof runtime.deskUrl === "string" ? runtime.deskUrl : null,
    // The app under the overlay, so the chooser control can say which one is
    // being edited on first paint instead of after a round trip.
    //
    // `url` is written the way the chooser's own rows are addressed —
    // `http://127.0.0.1:<port>`, the form runtime/local-apps.mjs builds — and
    // not from `app.host`, because its only job is to be comparable to those
    // rows: that string match is how the menu knows which of them is the
    // current one. Null when this launch never resolved a port, which is the
    // `--dev` case before the app has started.
    //
    // `name` travels and the project PATH does not, for the reason the chooser
    // URL is the only navigable string in this payload: a name is a label, and
    // a path is a fact about the machine the page is not owed.
    app: {
      url: Number.isFinite(runtime.appPort) ? `http://127.0.0.1:${runtime.appPort}` : null,
      // The launcher reads it once into `runtime`; a caller without one
      // (tests, tools) gets it read from disk.
      name: runtime.appName !== undefined ? runtime.appName : hostAppName(config.projectRoot),
    },
  }

  return (
    `window.__DESIGNLAYER_CONFIG__=${JSON.stringify(payload)};` +
    `${wsPortPin(runtime.wsPort)}${onboardingDismissal()}`
  )
}

/**
 * The one piece of vendor chrome that cannot be suppressed with a selector.
 *
 * Its onboarding bar — "Click any element to edit its properties" — is a bare
 * `<div>` with inline styles and no class, fixed across the top of the viewport
 * at z-index 2147483647. `base.ts` names the other eight surfaces by class; this
 * one has nothing to name. Matching it structurally (`:host > div:not([class])`)
 * was tried and rejected: the vendor's error toast is also a class-less
 * top-level div, and a rule broad enough to catch the bar swallows the notice
 * that something went wrong with a write.
 *
 * So it is turned off at the source. `showOnboarding` reads
 * `react-rewrite-onboarding-dismissed` and returns before creating anything, and
 * the prelude runs ahead of the vendor bundle — the same ordering `wsPortPin`
 * relies on. Writing the key the bar's own × writes is exactly the state the
 * vendor already supports, not a patch of its behaviour.
 *
 * It matters more than one bar of text: the panels are docked to the viewport
 * edges, so they start at y=0, and 32px of fixed banner lands squarely on the
 * inspector's tab strip and the layers filter.
 *
 * `try`: localStorage throws outright when a browser blocks third-party or
 * file-origin storage, and losing the whole prelude — the API base, the ports,
 * the host — over a cosmetic banner would take the editor down with it.
 */
function onboardingDismissal() {
  return `try{localStorage.setItem("react-rewrite-onboarding-dismissed","1")}catch(e){}`
}

/**
 * The vendor's `getAvailablePort` returns the port it ASKED for, not the one it
 * bound, so a host that pins `ports.ws` gets the pre-remap number injected into
 * the page and the overlay opens a socket nobody is listening on.
 *
 * The vendor's global is pinned to the port actually bound. Its own
 * `<script>window.__REACT_REWRITE_WS_PORT__ = …</script>` runs after this and
 * would otherwise win, so the pin has to be a no-op setter rather than a value.
 */
function wsPortPin(wsPort) {
  if (!wsPort) return ""
  return (
    `Object.defineProperty(window,"__REACT_REWRITE_WS_PORT__",` +
    `{get:function(){return ${wsPort}},set:function(){},configurable:true});`
  )
}
