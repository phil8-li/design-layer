/**
 * Utility classes and where the element comes from.
 *
 * Classes are chips because Tailwind class strings are long: reading them as
 * one run of text hides which token you are about to remove.
 */

import { COPY_REFUSED, copyText } from "../../core/clipboard"
import { el } from "../../core/dom"
import { prefersReducedMotion } from "../../core/motion"
import { tokens } from "../../core/tokens"

/** The chip's own exit, off the ramp and clamped for reduced motion. */
const CHIP_LEAVE_MS = (): number =>
  prefersReducedMotion() ? 0 : Number.parseFloat(tokens.duration.reveal)
import { icon } from "../../core/icons"
import { tokens as t } from "../../core/tokens"
import { section, textField } from "./field"
import type { InspectorSection } from "./index"

const CHIP_STYLE = [
  "display:inline-flex",
  "align-items:center",
  "gap:2px",
  "max-width:100%",
  "height:18px",
  "padding:0 2px 0 6px",
  `border-radius:${t.radius.xs}`,
  `background:${t.color.bgRaised}`,
  `color:${t.color.textMuted}`,
  "font-size:10px",
].join(";")

const PATH_STYLE = [
  "width:100%",
  "padding:4px 6px",
  "text-align:left",
  "border:none",
  `border-radius:${t.radius.sm}`,
  `background:${t.color.bgSunken}`,
  `color:${t.color.textDim}`,
  `font-family:${t.font.mono}`,
  "font-size:10px",
  "line-height:1.4",
  "word-break:break-all",
  "cursor:copy",
  `transition:color ${t.duration.hover} ${t.ease}`,
].join(";")

export const classesSection: InspectorSection = ({ editor, selection, writer, invalidate }) => {
  const names = Array.from(selection.element.classList)
  const source = selection.source
  if (names.length === 0 && !source) return null

  const remove = (name: string) => {
    writer.applyClasses(selection, { remove: [name], add: [] }, `Remove .${name}`)
    invalidate()
  }

  const add = (raw: string) => {
    const next = raw.split(/\s+/).filter(Boolean)
    if (next.length === 0) return
    writer.applyClasses(selection, { remove: [], add: next }, `Add ${next.map((n) => `.${n}`).join(" ")}`)
    invalidate()
  }

  const chips = names.map((name) =>
    el("span", { class: "de-class-chip", style: CHIP_STYLE, title: name }, [
      el("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, [name]),
      el(
        "button",
        {
          class: "de-option-delete",
          type: "button",
          style: "opacity:1",
          title: `Remove ${name}`,
          "aria-label": `Remove class ${name}`,
          /*
           * A chip leaves SIDEWAYS, which is why it does not use `leaveRow`.
           *
           * That helper collapses a row's height, which is right for a stacked
           * list and wrong here: chips wrap inside one row, so the thing that
           * closes over a removed chip is the gap beside it, not the space
           * under it. `.de-chip--leaving` in `css/panels.ts` takes the width
           * instead, and the pinned width is measured for the same reason
           * `leaveRow` measures a height — there is no value for CSS to animate
           * from otherwise.
           */
          onclick: (event: Event) => {
            const chip = (event.currentTarget as HTMLElement).closest(".de-class-chip")
            if (!(chip instanceof HTMLElement) || chip.offsetWidth === 0) return remove(name)
            chip.style.maxWidth = `${chip.offsetWidth}px`
            requestAnimationFrame(() => {
              chip.classList.add("de-chip--leaving")
              setTimeout(() => remove(name), CHIP_LEAVE_MS())
            })
          },
        },
        [icon("X", t.icon.marker)]
      ),
    ])
  )

  // Called straight from the click, so `copyText` still has its activation.
  const copyPath = (path: string) => {
    void copyText(path).then((copied) =>
      copied ? editor.toast("Source path copied") : editor.toast(COPY_REFUSED, "error")
    )
  }

  const body = el("div", { class: "de-stack" }, [
    chips.length > 0 ? el("div", { style: "display:flex;flex-wrap:wrap;gap:4px" }, chips) : null,
    textField({ id: "classes.add", label: "Add", value: "", placeholder: "class names", onCommit: add }),
    source
      ? el(
          "button",
          {
            type: "button",
            style: PATH_STYLE,
            title: "Copy source path",
            onclick: () => copyPath(`${source.filePath}:${source.lineNumber}:${source.columnNumber}`),
          },
          [`${source.filePath}:${source.lineNumber}`]
        )
      : null,
  ])

  return section("Classes", body)
}
