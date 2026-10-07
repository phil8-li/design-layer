/** Responsive utilities authored directly on the selected element. */

import { config } from "../../core/config"
import { el } from "../../core/dom"
import { icon } from "../../core/icons"
import { tokens } from "../../core/tokens"
import {
  activeBreakpoint,
  breakpointSteps,
  containerBreakpointSteps,
  responsiveClassBindings,
  type ResponsiveClassBinding,
} from "../../core/responsive"
import { canvasWidth } from "../../shell/shell"
import { isExpanded, miniButton, section, setExpanded, textField } from "./field"
import type { InspectorSection } from "./index"
import type { LayerElement } from "../../core/types"

const CONTAINER_EXPANDER = "responsive.container-breakpoints"

function utilities(raw: string): string[] {
  return [...new Set(raw.trim().split(/\s+/).filter(Boolean))]
}

/** Any box that already holds a layout can carry a breakpoint utility. */
function isLayoutBox(element: LayerElement, computed: CSSStyleDeclaration): boolean {
  return (
    element.childElementCount > 0 &&
    ["block", "flex", "grid", "inline-flex", "inline-grid"].includes(computed.display.trim())
  )
}

interface ContainerScope {
  /** `@container/sidebar` names its scope; a bare `@container` does not. */
  name: string | null
  /** True when the selected element is the container, not merely inside one. */
  self: boolean
  /** Border-box width when layout has produced one. */
  width: number | null
}

/**
 * The nearest container-query scope the selection sits in.
 *
 * Tailwind writes the scope as a class, so the class is the reliable signal;
 * `container-type` is the second read for a host that declared the scope in its
 * own CSS instead. Walking up matters because a `@md:` utility on the SELECTED
 * element resolves against an ancestor's width, not its own.
 */
function containerScope(element: LayerElement): ContainerScope | null {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const named = Array.from(node.classList).find(
      (name) => name === "@container" || name.startsWith("@container/")
    )
    const style = getComputedStyle(node)
    if (!named) {
      const declared = style.getPropertyValue("container-type").trim()
      if (["", "normal"].includes(declared)) continue
    }
    const cssName = style.getPropertyValue("container-name").trim()
    const measured = node.getBoundingClientRect().width || node.clientWidth
    return {
      name: named?.split("/")[1] ?? (!["", "none"].includes(cssName) ? cssName.split(/\s+/)[0] : null),
      self: node === element,
      width: measured > 0 ? measured : null,
    }
  }
  return null
}

/** Container variants on descendants, so the subtree's own scale is visible from here. */
function descendantContainerUtilities(element: LayerElement): string[] {
  const found = new Set<string>()
  let visited = 0
  // Only nodes whose class attribute carries an `@` at all — the engine filters
  // natively, where `*` copied every descendant of a page-level wrapper (tens
  // of thousands of nodes) into an array before the cap below could apply.
  for (const node of Array.from(element.querySelectorAll('[class*="@"]'))) {
    if (visited++ >= 2000 || found.size >= 12) break
    for (const name of Array.from(node.classList)) {
      if (name.startsWith("@") && name.includes(":")) found.add(name)
      if (found.size >= 12) break
    }
  }
  return [...found]
}

interface RowSpec {
  id: string
  /** Drawn in the field's leading strip. The bare prefix — `sm`, `@lg`. */
  label: string
  /**
   * The field's ACCESSIBLE name, which is not the drawn label and not the
   * heading.
   *
   * Three strings, three jobs, and they were two: `label` used to be the long
   * phrase and served as both the drawing and the name, which made the strip
   * wide enough to squeeze the input. Shortening it to `sm` fixed the column
   * and silently renamed the control to "sm" for anyone not looking at it.
   * Splitting the name out is what lets the drawing be two characters without
   * the announcement following it down.
   */
  name: string
  /** The heading above the row. */
  title: string
  usage?: string
  owner?: string
  note?: string
  /** What every utility typed into this row is prefixed with. */
  prefix: string
  bindings: ResponsiveClassBinding[]
  summary: string
}

export const responsiveSection: InspectorSection = ({ selection, computed, writer, invalidate }) => {
  /*
   * Every row in this section writes a Tailwind breakpoint variant —
   * `md:grid-cols-2` and the like. In a project that does not compile Tailwind
   * those classes land in the markup and do nothing, so the section is an offer
   * the host cannot honour. Measured on a real Angular app: five breakpoint
   * rows, each inviting the designer to type utilities into a build with no
   * utility layer.
   *
   * Gated on Tailwind rather than on the framework, because the two do not
   * track each other — an Angular app may compile Tailwind and a React app may
   * not, and it is this fact that decides whether the rows mean anything.
   */
  if (!config.host.tailwind) return null

  const bindings = responsiveClassBindings(Array.from(selection.element.classList))
  const scope = containerScope(selection.element)
  if (!scope && !isLayoutBox(selection.element, computed) && bindings.length === 0) return null

  const viewportSteps = breakpointSteps()
  const containerSteps = containerBreakpointSteps()
  /*
   * The CANVAS, not the window, and the difference is the panels.
   *
   * Which step is "active now" is a claim about the app, and the app's own
   * breakpoints are asked of the strip between the panels — `shell/
   * app-viewport.ts` shifts every width query by the inset so that a 940px
   * canvas inside a 1440px window wears the layout it would wear in a 940px
   * window. Reading `innerWidth` here would have this row announce `xl` over
   * an app that is currently rendering `md`, which is worse than not marking a
   * step at all: it is the panel disagreeing with the thing it is describing.
   */
  const viewport = canvasWidth()
  const active = activeBreakpoint(viewport, viewportSteps)
  const activeContainer = scope?.width ? activeBreakpoint(scope.width, containerSteps) : null
  const nested = bindings.filter((binding) => !binding.direct)
  const containerBindings = bindings.filter((binding) => binding.context === "container")
  const authored = (context: ResponsiveClassBinding["context"], name: string) =>
    bindings.filter(
      (binding) => binding.context === context && binding.direct && binding.breakpoint === name
    )

  const row = (spec: RowSpec) =>
    el("div", { class: "de-stack" }, [
      el("div", { class: "de-layout-group-title" }, [spec.title]),
      spec.usage ? el("div", { class: "de-hint" }, [spec.usage]) : null,
      spec.owner ? el("div", { class: "de-source" }, [spec.owner]) : null,
      spec.note ? el("div", { class: "de-hint" }, [spec.note]) : null,
      textField({
        id: spec.id,
        label: spec.label,
        title: spec.name,
        value: spec.bindings.map((binding) => binding.utility).join(" "),
        placeholder: "e.g. grid-cols-2 gap-6",
        onCommit: (raw) => {
          const next = utilities(raw).map((utility) => `${spec.prefix}${utility}`)
          const remove = spec.bindings.map((binding) => binding.original)
          if (
            remove.length === next.length &&
            remove.every((name, index) => name === next[index])
          ) {
            return
          }
          writer.applyClasses(selection, { remove, add: next }, spec.summary)
          invalidate()
        },
      }),
    ])

  const viewportRows = viewportSteps.map((step) =>
    row({
      id: `responsive.${step.name}`,
      /*
       * The prefix alone, not a sentence.
       *
       * This read `sm breakpoint utilities` — twenty-three characters in a
       * field's leading strip, which is sized for `W`. It never truncated
       * visibly, and that is the worse failure: the strip simply grew, so the
       * input beside it shrank, and each of the five breakpoint rows ended up
       * with a different amount of room for its value. The column they are
       * meant to form never lined up.
       *
       * Nothing is lost by shortening it, because the DRAWN label and the
       * ACCESSIBLE name are two different jobs and only the first one had a
       * width problem. `title` below carries the full phrase — it is what
       * `textField` hands to `aria-label` as well as to the tooltip — so a
       * screen reader still hears "sm breakpoint utilities" where a sighted
       * reader sees `sm` next to a heading that already says "640px and up".
       *
       * Getting that split wrong is not hypothetical: shortening the label
       * alone silently shortened the accessible name with it, because the
       * fallback is the label, and `host-parity-cases.mjs` caught it as five
       * controls Angular appeared to be missing.
       */
      label: step.name,
      name: `${step.name} breakpoint utilities`,
      title: `${step.name} · ${step.px}px and up${active?.name === step.name ? " · active now" : ""}`,
      usage: step.usage,
      owner: step.owner,
      // An undocumented prefix is still offered — it compiles, and hiding it
      // would make the panel lie about what the source can say — but it is not
      // dressed up as a decision the design system made.
      note: step.documented ? undefined : "Works, but not a breakpoint in your design system.",
      prefix: step.prefix,
      bindings: authored("viewport", step.name),
      summary: `Set ${step.name} responsive utilities`,
    })
  )

  const containerContext = Boolean(scope || containerBindings.length)
  const showAllContainers = isExpanded(CONTAINER_EXPANDER)
  const defaultContainerSteps = containerSteps.filter(
    (step) => step.documented || authored("container", step.name).length > 0
  )
  const visibleContainerSteps = showAllContainers ? containerSteps : defaultContainerSteps
  const containerRows = containerContext
    ? visibleContainerSteps.map((step) => {
        const rowBindings = authored("container", step.name)
        const basePrefix = step.prefix.endsWith(":") ? step.prefix.slice(0, -1) : step.prefix
        return row({
          id: `responsive.@${step.name}`,
          // Same split as the viewport rows above: the bare prefix is drawn,
          // the phrase is the accessible name and the tooltip.
          label: `@${step.name}`,
          name: `@${step.name} container utilities`,
          title: `@${step.name} · ${step.px}px and up${activeContainer?.name === step.name ? " · active now" : ""}`,
          usage: step.usage,
          owner: step.owner,
          note: step.documented ? undefined : "Works, but not a container size in your design system.",
          // The first existing variant's own prefix wins, so a row authored
          // against a NAMED container keeps its name instead of being silently
          // retargeted at the nearest one.
          prefix: rowBindings[0]?.prefix ?? `${basePrefix}${scope?.name ? `/${scope.name}` : ""}:`,
          bindings: rowBindings,
          summary: `Set @${step.name} container utilities`,
        })
      })
    : []

  const descendants = descendantContainerUtilities(selection.element)
  const notes: HTMLElement[] = [
    el("div", { class: "de-hint" }, [
      `Viewport ${viewport}px · ${active ? `${active.name} is active` : "below all breakpoints"}. Other breakpoints stay unchanged.`,
    ]),
  ]
  if (nested.length) {
    notes.push(
      el("div", { class: "de-hint" }, [
        `Nested/state variants stay unchanged: ${nested.map((binding) => binding.original).join(" · ")}`,
      ])
    )
  }

  const containerToggle = containerContext && containerSteps.length > defaultContainerSteps.length
    ? miniButton({
        label: showAllContainers ? "Show fewer container sizes" : "Show all container sizes",
        // The same show-more pair as the per-side token rows: this lengthens a
        // LIST of container steps rather than splitting one value into four.
        glyph: icon(showAllContainers ? "ChevronsDownUp" : "ChevronsUpDown", tokens.icon.marker),
        pressed: showAllContainers,
        onClick: () => {
          setExpanded(CONTAINER_EXPANDER, !showAllContainers)
          invalidate()
        },
      })
    : null
  const containerNotes: HTMLElement[] = containerContext
    ? [
        el("div", { class: "de-row" }, [
          el("div", { class: "de-layout-group-title", style: "flex:1" }, ["Container queries"]),
          containerToggle,
        ]),
      ]
    : []
  if (scope) {
    containerNotes.push(
      el("div", { class: "de-hint" }, [
        `${scope.self ? "This element is" : "Inside"} @container${scope.name ? `/${scope.name}` : ""}. Sizes follow the container, not the window.`,
      ]),
      el("div", { class: "de-hint" }, [
        scope.width === null
          ? "Nearest container width is not measurable in this preview."
          : `Container width ${Math.round(scope.width)}px · ${activeContainer ? `${activeContainer.name} is active` : "below all sizes"}.`,
      ])
    )
  } else if (containerBindings.length) {
    containerNotes.push(
      el("div", { class: "de-hint" }, [
        "Uses container-query classes, but no @container parent is on this page.",
      ])
    )
  }
  if (descendants.length) {
    containerNotes.push(
      el("div", { class: "de-hint" }, [
        `Container variants in this subtree: ${descendants.join(" · ")}`,
      ])
    )
  } else if (scope?.self) {
    containerNotes.push(
      el("div", { class: "de-hint" }, [
        "No children use container-query classes yet.",
      ])
    )
  }

  const measureRows = config.designSystem.responsiveMeasures.map((measure) =>
    el("div", { class: "de-stack", "data-de-responsive-measure": measure.id }, [
      el("div", { class: "de-layout-group-title" }, [measure.name]),
      el("div", { class: "de-source" }, [measure.formula]),
      el("div", { class: "de-hint" }, [measure.usage]),
      el("div", { class: "de-source" }, [measure.owner]),
    ])
  )

  return section(
    "Responsive",
    el("div", { class: "de-stack" }, [
      ...notes,
      ...viewportRows,
      ...containerNotes,
      ...containerRows,
      ...(measureRows.length
        ? [
            el("div", { class: "de-layout-group" }, [
              el("div", { class: "de-layout-group-title" }, ["Responsive measures"]),
              ...measureRows,
            ]),
          ]
        : []),
    ])
  )
}
