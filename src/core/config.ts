/**
 * The browser half of the host contract.
 *
 * `config.mjs` resolves one object on the server and injects it ahead of this
 * bundle as `window.__DESIGNLAYER_CONFIG__`. Everything host-specific — which
 * elements are dev chrome, which CSS custom properties a docked panel reads,
 * which colour words and spacing steps the host's Tailwind build actually
 * ships — arrives through here, so porting the editor to another Next app is a
 * config file rather than a diff across four source files.
 *
 * The defaults below are not a second source of truth: they are what this file
 * falls back to when the bundle is loaded without its prologue (a unit test, or
 * a stale `dist/` served directly). They mirror the generic server defaults;
 * host integrations belong in designlayer.config.mjs.
 */

export interface DockedPanelConfig {
  offsetVar: string
  widthVar: string
}

export interface TailwindConfig {
  colorWords: string[]
  fontSizes: string[]
  fontFamilies: string[]
  /** px -> Tailwind step, e.g. `16` -> `"4"`. Misses become arbitrary values. */
  spacingScale: Record<string, string>
  /** Responsive prefix -> minimum viewport width in CSS pixels. */
  breakpoints: Record<string, number>
  /** Container-query prefix -> minimum container width in CSS pixels. */
  containerBreakpoints: Record<string, number>
  /** Overrides which stems consult `spacingScale`; null keeps the built-in set. */
  spacedStems: string | null
}

export interface DesignSystemToken {
  id: string
  name: string
  category: string
  values: Record<string, unknown>
  cssVar?: string
  cssVars?: Record<string, string>
  cssUtility?: string
  scope?: string[]
  codeSyntax?: Record<string, unknown> | null
  usage?: string
  prefix?: string
  /**
   * Breakpoints only. True when the host's design system documents this step;
   * false for a Tailwind prefix that compiles but that the system never
   * declared. The inspector still offers the undocumented prefix — it works —
   * but must not present it as a design-system decision.
   */
  documented?: boolean
  /** Breakpoints only. The source file that owns the number, for the hint line. */
  owner?: string
  /**
   * Set when this token came from an added library rather than from the host's
   * own design system, and left unset on every host token.
   *
   * They live here, on the host's own token type, because the merged catalog is
   * ONE list: a library's colours are concatenated into `designSystem.colors`
   * and every picker walks that array without knowing where a row came from,
   * which is what keeps the rest of the editor unaware of the feature. A
   * parallel type for library tokens would have needed a parallel path through
   * matching, grouping and writing to go with it.
   *
   * `library` is the library's id, which is also the prefix on the token's own
   * id; `libraryName` is what a person calls it, and is here rather than looked
   * up because a surface holding a token should not have to hold the library
   * list as well to be able to say where it came from.
   */
  library?: string
  libraryName?: string
}

export interface DesignSystemAlias {
  name: string
  tokenIds: string[]
  ambiguous: boolean
}

export interface TailwindTokenAlias extends DesignSystemAlias {
  namespace: string
  cssVar: string
}

export interface ResponsiveMeasure {
  id: string
  name: string
  category: "responsive-measure"
  formula: string
  usage: string
  owner: string
}

/**
 * The unit a host states letter-spacing in. Declared by the host, because the
 * number alone cannot say: `-0.5` is a plausible em and a plausible px.
 */
export type TrackingUnit = "em" | "px"

export interface DesignSystemCatalog {
  name: string | null
  trackingUnit: TrackingUnit
  colors: DesignSystemToken[]
  spacing: DesignSystemToken[]
  radii: DesignSystemToken[]
  textStyles: DesignSystemToken[]
  uiTextStyles: DesignSystemToken[]
  effects: DesignSystemToken[]
  icons: DesignSystemToken[]
  motion: DesignSystemToken[]
  breakpoints: DesignSystemToken[]
  containerBreakpoints: DesignSystemToken[]
  responsiveMeasures: ResponsiveMeasure[]
  aliases: {
    cssVariables: DesignSystemAlias[]
    tailwind: TailwindTokenAlias[]
  }
}

export interface DesignLayerConfig {
  apiBase: string
  /**
   * The chooser screen this editor was started from, or null when it was not
   * started from one — which is most sessions. Nothing in the chrome may
   * invent a value for it: a link to a screen that is not running is worse
   * than no link, because it takes the designer off the page to find out.
   */
  chooserUrl: string | null
  app: AppConfig
  chrome: {
    /** Comma-joined selector list. Empty means the host has no extra dev chrome. */
    trustedSelector: string
    dockedPanel: DockedPanelConfig
  }
  tailwind: TailwindConfig
  designSystem: DesignSystemCatalog
  icons: IconSetConfig
  host: HostConfig
  /**
   * Whether the launcher serving this page keeps the bundle out of the board's
   * frames (runtime/board-frame.mjs). A prelude that does not say so came from
   * an editor started before that guard, and canvas view refuses to open there
   * rather than load pages that would each start a second editor. No prelude at
   * all — a test, a bundle loaded by hand — has no launcher to be stale.
   */
  boardFrames: boolean
  /**
   * DesignLayer.app's desk on this Mac, as an origin, or null where the app is
   * not installed — every machine that is not a Mac with it, and every page
   * with no prelude. The launcher decides (runtime/mac-desk.mjs); the chrome
   * never probes for it, because a probe that fails prints into the console of
   * the app under the overlay.
   */
  deskUrl: string | null
}


/**
 * The app under the overlay: where it is, and what its project calls itself.
 *
 * Both exist for the app chooser, which has to name the current app the moment
 * the chrome draws rather than after a round trip. `url` is the identity the
 * chooser's rows are addressed by, so the menu can mark which row is the one
 * already open; `name` is what goes on the control.
 *
 * Either can be null, and they go null independently: a launch that has not
 * resolved a port yet knows the name and not the URL, and a project with no
 * package.json is the other way round. Neither is a path — see the prelude in
 * config.mjs for why the host's folder does not travel.
 */
export interface AppConfig {
  url: string | null
  name: string | null
}

/**
 * Which framework the app under the overlay is written in, and whether it
 * compiles Tailwind.
 *
 * The framework decides which resolver answers "where is this element written"
 * and which lane "Apply to code" commits through, so it arrives from the server
 * rather than being sniffed here: at the moment this bundle loads, an Angular
 * app has not bootstrapped and `window.ng` does not exist yet.
 *
 * `tailwind` is separate because it is a separate fact: a React app without
 * Tailwind and an Angular app with it both exist, and it is this — not the
 * framework — that decides whether a utility class is worth offering.
 */
export interface HostConfig {
  framework: "react" | "angular"
  tailwind: boolean
}

/**
 * The host's icon set, as the browser half sees it: the attribute an icon names
 * itself with, and whether the loopback route has drawings to serve. The
 * drawings themselves are fetched, not injected — see `icon-set.ts`.
 */
export interface IconSetConfig {
  attribute: string
  available: boolean
}

const STANDARD_BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 }

function breakpointTokens(
  breakpoints: Record<string, number>,
  context: "viewport" | "container" = "viewport"
): DesignSystemToken[] {
  const container = context === "container"
  return Object.entries(breakpoints).map(([name, value]) => ({
    id: `${container ? "container-breakpoint" : "breakpoint"}:${name}`,
    name,
    category: container ? "container-breakpoint" : "breakpoint",
    prefix: `${container ? "@" : ""}${name}:`,
    values: { default: value },
    // No host manifest reached this bundle, so nothing here is a documented
    // design-system step — only a prefix Tailwind compiles.
    documented: false,
  })).sort((a, b) => (a.values.default as number) - (b.values.default as number))
}

function emptyDesignSystem(
  breakpoints: Record<string, number>,
  containerBreakpoints: Record<string, number> = {}
): DesignSystemCatalog {
  return {
    name: null,
    trackingUnit: "em",
    colors: [],
    spacing: [],
    radii: [],
    textStyles: [],
    uiTextStyles: [],
    effects: [],
    icons: [],
    motion: [],
    breakpoints: breakpointTokens(breakpoints),
    containerBreakpoints: breakpointTokens(containerBreakpoints, "container"),
    responsiveMeasures: [],
    aliases: { cssVariables: [], tailwind: [] },
  }
}

const FALLBACK: DesignLayerConfig = {
  apiBase: "/__designlayer",
  chooserUrl: null,
  app: { url: null, name: null },
  chrome: {
    trustedSelector: "",
    dockedPanel: {
      offsetVar: "--designlayer-docked-panel-offset",
      widthVar: "--designlayer-docked-panel-width",
    },
  },
  tailwind: {
    colorWords: [
      "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber",
      "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue",
      "indigo", "violet", "purple", "fuchsia", "pink", "rose", "black", "white",
      "transparent", "current", "inherit", "foreground", "background", "muted",
      "primary", "secondary", "accent", "destructive", "border", "input",
      "ring", "card", "popover", "sidebar",
    ],
    fontSizes: ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl"],
    fontFamilies: ["sans", "serif", "mono"],
    spacingScale: {
      0: "0", 1: "px", 2: "0.5", 4: "1", 6: "1.5", 8: "2", 10: "2.5", 12: "3",
      14: "3.5", 16: "4", 20: "5", 24: "6", 28: "7", 32: "8", 36: "9", 40: "10",
      44: "11", 48: "12", 56: "14", 64: "16", 80: "20", 96: "24", 112: "28",
      128: "32",
    },
    breakpoints: STANDARD_BREAKPOINTS,
    containerBreakpoints: {},
    spacedStems: null,
  },
  designSystem: emptyDesignSystem(STANDARD_BREAKPOINTS),
  icons: { attribute: "", available: false },
  host: { framework: "react", tailwind: true },
  boardFrames: true,
  deskUrl: null,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function numberMap(value: unknown, fallback: Record<string, number>): Record<string, number> {
  if (!isRecord(value)) return fallback
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
  )
  return { ...fallback, ...Object.fromEntries(entries) }
}

function configuredList<T>(value: unknown, fallback: T[]): T[] {
  return Array.isArray(value) ? value as T[] : fallback
}

function readDesignSystem(
  value: unknown,
  breakpoints: Record<string, number>,
  containerBreakpoints: Record<string, number>
): DesignSystemCatalog {
  const fallback = emptyDesignSystem(breakpoints, containerBreakpoints)
  if (!isRecord(value)) return fallback
  const aliases = isRecord(value.aliases) ? value.aliases : {}
  return {
    name: typeof value.name === "string" ? value.name : null,
    trackingUnit: value.trackingUnit === "px" ? "px" : "em",
    colors: configuredList(value.colors, fallback.colors),
    spacing: configuredList(value.spacing, fallback.spacing),
    radii: configuredList(value.radii, fallback.radii),
    textStyles: configuredList(value.textStyles, fallback.textStyles),
    uiTextStyles: configuredList(value.uiTextStyles, fallback.uiTextStyles),
    effects: configuredList(value.effects, fallback.effects),
    icons: configuredList(value.icons, fallback.icons),
    motion: configuredList(value.motion, fallback.motion),
    breakpoints: configuredList(value.breakpoints, fallback.breakpoints),
    containerBreakpoints: configuredList(value.containerBreakpoints, fallback.containerBreakpoints),
    responsiveMeasures: configuredList<ResponsiveMeasure>(value.responsiveMeasures, []),
    aliases: {
      cssVariables: configuredList<DesignSystemAlias>(aliases.cssVariables, []),
      tailwind: configuredList<TailwindTokenAlias>(aliases.tailwind, []),
    },
  }
}

/**
 * An origin from the payload, checked again on this side of the wire.
 *
 * Written for the chooser's URL, which is the ONE string in the payload that
 * becomes a navigation. Everything else lands in a selector, a class name or a
 * number; that one lands in an `href`, where `javascript:` is code and an
 * off-machine host is a page that is not the editor's. A bundle served from a
 * stale `dist/`, or loaded with a prologue written by something other than this
 * package's launcher, must not be the reason a designer leaves the machine.
 *
 * `app.url` goes through the same check. Nothing navigates to it today — it is
 * compared against the chooser's rows and shown — but it is an origin, and an
 * origin nobody checked is one link away from being the bug above. One
 * implementation, so the two cannot come to disagree about what loopback means.
 */
function readLoopbackUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    if (url.protocol !== "http:") return null
    const host = url.hostname.replace(/^\[|\]$/g, "")
    return host === "localhost" || host === "127.0.0.1" || host === "::1" ? url.href : null
  } catch {
    return null
  }
}

/**
 * The same check, down to the origin. `URL.href` writes an empty path back as a
 * trailing slash, and an origin compared against `http://127.0.0.1:3000` or
 * joined to a path must not carry one.
 *
 * Exported for `shell/way-back.ts`, which takes keys only from a loopback page.
 */
export function readLoopbackOrigin(value: unknown): string | null {
  const checked = readLoopbackUrl(value)
  return checked === null ? null : new URL(checked).origin
}

/**
 * Read per leaf, like `readHost`: a session that knows the app's name but not
 * its port yet is the normal state during a `--dev` launch, not a broken
 * payload, and losing the name over the missing URL would blank the control
 * that exists to show it.
 */
function readApp(value: unknown): AppConfig {
  if (!isRecord(value)) return FALLBACK.app
  return {
    // The origin, not the checked href: the chooser's rows carry
    // `http://127.0.0.1:3000` with no trailing slash, so the two spellings of
    // the same app would never compare equal and the menu would mark no row as
    // the one already open.
    url: readLoopbackOrigin(value.url),
    name: typeof value.name === "string" && value.name.length > 0 ? value.name : null,
  }
}

function readIconSet(value: unknown): IconSetConfig {
  if (!isRecord(value)) return FALLBACK.icons
  const attribute = typeof value.attribute === "string" ? value.attribute : ""
  // Both halves or nothing: an attribute with no set names icons the picker
  // cannot offer, and a set with no attribute cannot be matched to a selection.
  if (!attribute || value.available !== true) return FALLBACK.icons
  return { attribute, available: true }
}

/**
 * Merged per leaf, not per branch. A host that overrides one colour word must
 * not lose the spacing table with it, and a partially-written config is the
 * normal case rather than the exception.
 */
function readHost(value: unknown): HostConfig {
  if (!isRecord(value)) return FALLBACK.host
  return {
    framework: value.framework === "angular" ? "angular" : "react",
    // Only an explicit `false` turns it off. An older launcher that predates
    // this key sends nothing, and every host it could be serving was assumed to
    // have Tailwind before now.
    tailwind: value.tailwind !== false,
  }
}

function read(): DesignLayerConfig {
  const raw: unknown = (globalThis as { __DESIGNLAYER_CONFIG__?: unknown })
    .__DESIGNLAYER_CONFIG__
  if (!isRecord(raw)) return FALLBACK

  const chrome = isRecord(raw.chrome) ? raw.chrome : {}
  const panel = isRecord(chrome.dockedPanel) ? chrome.dockedPanel : {}
  const tailwind = isRecord(raw.tailwind) ? raw.tailwind : {}

  const str = (value: unknown, fallback: string): string =>
    typeof value === "string" && value.length > 0 ? value : fallback
  const list = (value: unknown, fallback: string[]): string[] =>
    Array.isArray(value) && value.length > 0 ? value.filter((v) => typeof v === "string") : fallback
  const breakpoints = numberMap(tailwind.breakpoints, FALLBACK.tailwind.breakpoints)
  const containerBreakpoints = numberMap(
    tailwind.containerBreakpoints,
    FALLBACK.tailwind.containerBreakpoints
  )

  return {
    apiBase: str(raw.apiBase, FALLBACK.apiBase),
    chooserUrl: readLoopbackUrl(raw.chooserUrl),
    app: readApp(raw.app),
    chrome: {
      // Not `str()`: an empty list is a documented, meaningful answer ("this
      // host has no dev chrome"), so only an absent key falls back. Treating
      // "" as absent would hand a stock Next app this app's Leva selectors.
      trustedSelector:
        typeof chrome.trustedSelector === "string"
          ? chrome.trustedSelector
          : FALLBACK.chrome.trustedSelector,
      dockedPanel: {
        offsetVar: str(panel.offsetVar, FALLBACK.chrome.dockedPanel.offsetVar),
        widthVar: str(panel.widthVar, FALLBACK.chrome.dockedPanel.widthVar),
      },
    },
    tailwind: {
      colorWords: list(tailwind.colorWords, FALLBACK.tailwind.colorWords),
      fontSizes: list(tailwind.fontSizes, FALLBACK.tailwind.fontSizes),
      fontFamilies: list(tailwind.fontFamilies, FALLBACK.tailwind.fontFamilies),
      spacingScale: isRecord(tailwind.spacingScale)
        ? (tailwind.spacingScale as Record<string, string>)
        : FALLBACK.tailwind.spacingScale,
      breakpoints,
      containerBreakpoints,
      spacedStems:
        typeof tailwind.spacedStems === "string" ? tailwind.spacedStems : null,
    },
    designSystem: readDesignSystem(raw.designSystem, breakpoints, containerBreakpoints),
    icons: readIconSet(raw.icons),
    host: readHost(raw.host),
    boardFrames: raw.boardFrames === true,
    deskUrl: readLoopbackOrigin(raw.deskUrl),
  }
}


/**
 * Read once at module load. The prologue runs before this bundle and the server
 * cannot change its mind mid-session, so re-reading would only add a chance of
 * two call sites disagreeing.
 */
export const config: DesignLayerConfig = read()
