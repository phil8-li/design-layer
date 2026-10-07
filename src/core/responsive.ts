/** The design system's breakpoint steps, plus pure class parsing and replacement. */

import { config, type DesignSystemToken } from "./config"

export interface BreakpointStep {
  name: string
  /** Minimum viewport or container width in CSS pixels. */
  px: number
  /** The variant prefix that compiles, trailing colon included. */
  prefix: string
  /** True when the host's design system declares a meaning at this width. */
  documented: boolean
  /** Documented steps only: what changes here, and the file that owns the number. */
  usage?: string
  owner?: string
}

/**
 * The steps the panel offers, narrowest first.
 *
 * Read from the design-system catalog rather than `tailwind.breakpoints`: both
 * name the same prefixes, but only the catalog says which of them the host
 * declared a meaning for, and it arrives sorted by width — so the panel is
 * ordered like a ruler without a second place deciding what the order is.
 */
export function breakpointSteps(
  tokens: readonly DesignSystemToken[] = config.designSystem.breakpoints
): BreakpointStep[] {
  return stepsFromTokens(tokens, "")
}

/** The host's container-query scale, narrowest first. */
export function containerBreakpointSteps(
  tokens: readonly DesignSystemToken[] = config.designSystem.containerBreakpoints
): BreakpointStep[] {
  return stepsFromTokens(tokens, "@")
}

function stepsFromTokens(tokens: readonly DesignSystemToken[], prefix: string): BreakpointStep[] {
  return tokens.map((token) => ({
    name: token.name,
    px: Number(token.values.default),
    prefix: token.prefix ?? `${prefix}${token.name}:`,
    documented: token.documented === true,
    usage: token.usage,
    owner: token.owner,
  }))
}

/** The widest step a measured width has crossed; null while below every step. */
export function activeBreakpoint(
  viewportWidth: number,
  steps: readonly BreakpointStep[] = breakpointSteps()
): BreakpointStep | null {
  let active: BreakpointStep | null = null
  for (const step of steps) if (viewportWidth >= step.px) active = step
  return active
}

export interface ResponsiveClassBinding {
  /** Exact authored class; retained as `className` for call-site readability. */
  original: string
  className: string
  breakpoint: string
  /** Minimum viewport or container width in CSS pixels. */
  px: number
  context: "viewport" | "container"
  /** Every variant before the utility, byte-for-byte, plus the trailing colon. */
  prefix: string
  variants: string[]
  utility: string
  /** A breakpoint with no state or nesting variants around it. */
  direct: boolean
  sourceIndex: number
}

/** Split Tailwind variants without breaking arbitrary selectors such as `[&:hover]`. */
export function splitVariantChain(className: string): string[] {
  const parts: string[] = []
  let start = 0
  let square = 0
  let round = 0
  let escaped = false
  for (let index = 0; index < className.length; index += 1) {
    const char = className[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === "[") square += 1
    else if (char === "]") square = Math.max(0, square - 1)
    else if (char === "(") round += 1
    else if (char === ")") round = Math.max(0, round - 1)
    else if (char === ":" && square === 0 && round === 0) {
      parts.push(className.slice(start, index))
      start = index + 1
    }
  }
  parts.push(className.slice(start))
  return parts.filter(Boolean)
}

export function parseResponsiveClassName(
  className: string,
  breakpoints: Record<string, number> = config.tailwind.breakpoints,
  containerBreakpoints: Record<string, number> = config.tailwind.containerBreakpoints
): ResponsiveClassBinding | null {
  const parts = splitVariantChain(className)
  if (parts.length < 2) return null
  const variants = parts.slice(0, -1)
  let breakpoint = ""
  let context: ResponsiveClassBinding["context"] = "viewport"
  for (const variant of variants) {
    const container = /^@([^/]+)(?:\/[^/]+)?$/.exec(variant)
    if (container) {
      if (!(container[1] in containerBreakpoints)) continue
      breakpoint = container[1]
      context = "container"
      break
    }
    if (!(variant in breakpoints)) continue
    breakpoint = variant
    context = "viewport"
    break
  }
  if (!breakpoint) return null
  return {
    original: className,
    className,
    breakpoint,
    px: context === "viewport" ? breakpoints[breakpoint] : containerBreakpoints[breakpoint],
    context,
    prefix: `${variants.join(":")}:`,
    variants,
    utility: parts.at(-1) ?? "",
    direct: variants.length === 1,
    sourceIndex: 0,
  }
}

export function responsiveClassBindings(
  classNames: readonly string[],
  breakpoints: Record<string, number> = config.tailwind.breakpoints,
  containerBreakpoints: Record<string, number> = config.tailwind.containerBreakpoints
): ResponsiveClassBinding[] {
  return classNames
    .map((className, sourceIndex) => {
      const parsed = parseResponsiveClassName(className, breakpoints, containerBreakpoints)
      return parsed ? { ...parsed, sourceIndex } : null
    })
    .filter((entry): entry is ResponsiveClassBinding => entry !== null)
    .sort((a, b) => {
      return a.px - b.px || a.sourceIndex - b.sourceIndex
    })
}

export function replaceResponsiveClass(
  binding: ResponsiveClassBinding,
  nextUtility: string
): { remove: string[]; add: string[] } {
  const utility = nextUtility.trim()
  return { remove: [binding.original], add: utility ? [`${binding.prefix}${utility}`] : [] }
}
