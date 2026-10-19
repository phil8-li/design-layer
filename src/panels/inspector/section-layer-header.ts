/**
 * The layer header: Figma's first row of the Design panel.
 *
 * Left, what the selection is, in Figma's words (Frame, Text, Rectangle,
 * Image, Vector, a component's name, "2 selected"). Right, the actions Figma
 * keeps there: Copy as code, Create component, and More actions.
 *
 * Not a section: it has no body and does not fold, so it builds its own row
 * rather than calling `section()`.
 *
 * Create component cannot be done here. Extracting a component rewrites files
 * the writer does not own, so the button files a note for the coding agent in
 * the Changes tab, the same outbox every other request goes through.
 */

import { pinNote } from "../../annotations/actions"
import { describeElement } from "../../annotations/output"
import { COPY_REFUSED, copyText } from "../../core/clipboard"
import { runCommand } from "../../core/commands"
import { el } from "../../core/dom"
import { CODE_VIEWS, codeText, elementCode } from "../../core/element-code"
import { focusControl } from "../../core/focus"
import { icon, type IconName } from "../../core/icons"
import { SHORTCUTS, chordLabel } from "../../core/keymap"
import { getResolver } from "../../core/resolve"
import { tokens } from "../../core/tokens"
import type { Selection } from "../../core/types"
import type { InspectorSection, SectionContext } from "./index"
import { miniButton } from "./field"
import { directText } from "./token-row"

// Figma's More actions mark.
const MORE_GLYPH: IconName = "DotsThree"

const MEDIA = new Set(["img", "picture", "video", "canvas"])

export interface LayerKind {
  label: string
  /** A component instance: drawn in the component color, like its layer row. */
  component: boolean
}

/**
 * The selection's type, by the rules the layers panel draws its marks with:
 * a component wins over what it renders as, then media, vectors, text, and a
 * box that is a Frame when it holds elements and a Rectangle when it does not.
 */
export function layerKind(context: Pick<SectionContext, "editor" | "selection" | "selections">): LayerKind {
  const count = context.selections?.length ?? 1
  if (count > 1) return { label: `${count} selected`, component: false }
  const element = context.selection.element
  const meta = getResolver(context.editor.bridge).meta(element)
  if (meta.isRoot && meta.info?.componentName) return { label: meta.info.componentName, component: true }
  const tag = element.tagName.toLowerCase()
  if (MEDIA.has(tag)) return { label: "Image", component: false }
  if (element instanceof SVGElement) return { label: "Vector", component: false }
  if (!element.firstElementChild && directText(element)) return { label: "Text", component: false }
  return { label: element.firstElementChild ? "Frame" : "Rectangle", component: false }
}

function shortcutText(command: string): string {
  const shortcut = SHORTCUTS.find((entry) => entry.command === command)
  return shortcut ? chordLabel(shortcut.chord) : ""
}

function sourcePath(selection: Selection): string | null {
  const source = selection.source
  return source ? `${source.filePath}:${source.lineNumber}` : null
}

interface MenuItem {
  label: string
  shortcut?: string
  disabled?: boolean
  run(): void
}

/**
 * The More actions menu: a `role="menu"` under its trigger, aligned to the
 * trigger's end edge. Arrows move, Enter or Space runs, Escape closes, and
 * focus goes back to the trigger. Built on open and removed on close, so a
 * re-render of the panel cannot leave one behind.
 */
function moreMenu(header: HTMLElement, items: () => MenuItem[]): HTMLElement {
  let menu: HTMLElement | null = null

  const trigger = miniButton({
    label: "More actions",
    glyph: icon(MORE_GLYPH, tokens.icon.action),
    // `detail` is 0 for a click made with Enter or Space.
    onClick: (event) => (menu ? close(false) : open((event as MouseEvent).detail === 0)),
  })
  trigger.classList.add("de-layerhead-more")
  trigger.setAttribute("aria-haspopup", "menu")
  trigger.setAttribute("aria-expanded", "false")

  const rows = (): HTMLElement[] =>
    menu ? [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')] : []

  const move = (step: number | "first" | "last"): void => {
    const list = rows()
    if (!list.length) return
    const at = list.indexOf(document.activeElement as HTMLElement)
    const last = list.length - 1
    const next =
      step === "first" || (at < 0 && step === 1)
        ? 0
        : step === "last" || (at < 0 && step === -1)
          ? last
          : (at + (step as number) + list.length) % list.length
    focusControl(list[next])
  }

  const onOutside = (event: PointerEvent): void => {
    const target = event.target as Node | null
    if (target && (menu?.contains(target) || trigger.contains(target))) return
    close(false)
  }

  function close(restore: boolean): void {
    if (!menu) return
    menu.remove()
    menu = null
    trigger.setAttribute("aria-expanded", "false")
    document.removeEventListener("pointerdown", onOutside, true)
    if (restore && trigger.isConnected) focusControl(trigger)
  }

  /*
   * A keyboard open focuses the first row, as the APG menu pattern asks. A
   * pointer open focuses the menu itself, so no row looks chosen before the
   * pointer reaches one (Figma's menus do the same) and the arrows still work.
   */
  function open(viaKeyboard: boolean): void {
    const node = el("div", {
      class: "de-layer-menu de-layerhead-menu",
      role: "menu",
      "aria-label": "More actions",
      tabindex: "-1",
    })
    for (const item of items()) {
      const row = el(
        "button",
        {
          class: "de-layer-menu-row de-layerhead-menu-row",
          type: "button",
          role: "menuitem",
          tabindex: "-1",
          "aria-disabled": item.disabled ? "true" : undefined,
        },
        [
          el("span", { class: "de-layerhead-menu-label" }, [item.label]),
          item.shortcut ? el("span", { class: "de-layerhead-menu-key" }, [item.shortcut]) : null,
        ]
      )
      row.addEventListener("click", () => {
        if (item.disabled) return
        close(true)
        item.run()
      })
      node.append(row)
    }
    // Keys inside the menu stop here, so Escape closes the menu and does not
    // also clear the selection on its way to the canvas.
    node.addEventListener("keydown", (event) => {
      const keys: Record<string, () => void> = {
        ArrowDown: () => move(1),
        ArrowUp: () => move(-1),
        Home: () => move("first"),
        End: () => move("last"),
        Escape: () => close(true),
      }
      if (event.key === "Tab") return close(false)
      const action = keys[event.key]
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      action()
    })
    header.append(node)
    menu = node
    trigger.setAttribute("aria-expanded", "true")
    document.addEventListener("pointerdown", onOutside, true)
    if (viaKeyboard) move("first")
    else focusControl(node)
  }

  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    event.preventDefault()
    if (!menu) open(true)
    move(event.key === "ArrowDown" ? "first" : "last")
  })

  return trigger
}

export const layerHeaderSection: InspectorSection = (context) => {
  const { editor, selection } = context
  const multi = (context.selections?.length ?? 1) > 1
  const kind = layerKind(context)

  const title = el("div", { class: "de-layerhead-title" }, [
    kind.component ? icon("Component", tokens.icon.inline) : null,
    el("span", { class: "de-layerhead-name", title: kind.label }, [kind.label]),
  ])

  // Called straight from the click, so `copyText` still has its activation.
  const copyCode = (): void => {
    const view = CODE_VIEWS[0]
    void copyText(codeText(elementCode(selection, view.id))).then((copied) =>
      copied ? editor.toast(`Copied ${view.label}`) : editor.toast(COPY_REFUSED, "error")
    )
  }

  const requestComponent = (): void => {
    const element = selection.element
    const box = element.getBoundingClientRect()
    pinNote({
      kind: "element",
      comment:
        `Create a reusable component from this <${selection.tagName}>. Keep how it looks and behaves, ` +
        "use the new component here in place of this markup, and reuse it where the same pattern repeats.",
      url: window.location.href,
      rect: { x: box.left + window.scrollX, y: box.top + window.scrollY, width: box.width, height: box.height },
      target: describeElement(element),
      selectedText: null,
      element,
    })
    editor.toast("Component request added to Changes")
  }

  // The Code view that "Go to main component" would open is not mounted, so
  // the nearest honest action is the main component's source location.
  const copyMainPath = (): void => {
    const path = sourcePath(selection)
    if (!path) return editor.toast(`No source file found for ${kind.label}`, "error")
    void copyText(path).then((copied) =>
      copied ? editor.toast(`Copied path to ${kind.label}`) : editor.toast(COPY_REFUSED, "error")
    )
  }

  const copyClasses = (): void => {
    void copyText(selection.element.getAttribute("class") ?? "").then((copied) =>
      copied ? editor.toast("Copied classes") : editor.toast(COPY_REFUSED, "error")
    )
  }

  const header = el("div", { class: `de-layerhead${kind.component ? " de-layerhead--component" : ""}` })

  // Read when the menu opens, not at render, so Hide and Lock name the state
  // the element is in at that moment.
  const items = (): MenuItem[] => {
    const state = editor.getState()
    const picked = state.selection.length ? state.selection : [selection]
    const hidden = picked.every((entry) => getComputedStyle(entry.element).display === "none")
    const locked = picked.every((entry) => state.locked?.has(entry.element))
    const list: MenuItem[] = [
      { label: "Select parent", shortcut: shortcutText("select.parent"), run: () => runCommand("select.parent") },
      { label: "Show in layers", run: () => editor.setState({ layersOpen: true, leftTab: "layers" }) },
      { label: "Scroll into view", shortcut: shortcutText("select.reveal"), run: () => runCommand("select.reveal") },
      { label: hidden ? "Show" : "Hide", shortcut: shortcutText("select.hide"), run: () => runCommand("select.hide") },
      { label: locked ? "Unlock" : "Lock", shortcut: shortcutText("select.lock"), run: () => runCommand("select.lock") },
    ]
    if (!multi) {
      list.push({ label: "Copy classes", disabled: !selection.element.getAttribute("class"), run: copyClasses })
    }
    return list
  }

  // A multi-selection has no single element to spell as code or to turn into
  // one component, so it keeps only the menu, whose commands act on the set.
  const actions = el("div", { class: "de-layerhead-actions" }, [
    multi ? null : miniButton({ label: "Copy as code", glyph: icon("Code", tokens.icon.action), onClick: copyCode }),
    multi
      ? null
      : kind.component
        ? miniButton({
            label: "Copy path to main component",
            glyph: icon("Component", tokens.icon.action),
            onClick: copyMainPath,
          })
        : miniButton({
            label: "Create component",
            glyph: icon("Component", tokens.icon.action),
            onClick: requestComponent,
          }),
    moreMenu(header, items),
  ])

  header.append(title, actions)
  return header
}
