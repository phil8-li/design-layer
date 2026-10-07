/**
 * The instance section: which design-system component this element is, and the
 * properties that component declares.
 *
 * Figma's instance-properties block, and it is ONE block because in Figma it is
 * one block. Select an instance there and the right panel answers three
 * questions in a single breath before Layout or Appearance get a word in —
 * which main component is this, what does that component declare, and what is
 * this instance set to. This editor used to answer those from two sections that
 * did not know about each other: `section-variants` read the axes out of the
 * project's own SOURCE and could write them, `section-library-component` read
 * what an installed LIBRARY documents and could write nothing at all. A
 * designer looking at one `<x-button>` therefore got a `Variants` block and a
 * `Library component` block that were visibly about the same thing and
 * disagreed about how much of it was editable. Two sources of truth is the
 * right number to HAVE and the wrong number to SHOW.
 *
 * So: one header, one `Properties` group, rows merged by name. Where the two
 * sources name the same property the source-declared axis wins, because it is
 * the one that can actually be written — the merge rule is stated again at the
 * call site, since that is where it would be broken.
 *
 * `null` when the selection is neither a matched library component nor an
 * instance of a source-declared variant declaration, which is most selections —
 * the contract every section in this directory keeps, and the reason the panel
 * stays as short as the element is simple.
 *
 * ## The two joins, both weak, both the only ones available
 *
 * A source declaration is matched on EVIDENCE: `matchDeclaration` asks which of
 * the file's factories this element is demonstrably wearing the classes of. A
 * library component is matched on NAME and on TAG, because that is all there
 * is — see `libraries/store.ts`, which owns both halves so the rule is stated
 * once rather than re-derived per panel. A false positive on the library half
 * is a panel showing documentation for a same-named component from somewhere
 * else, which is a cost a reader can see and correct.
 *
 * ## What a documented prop can write, and why this section chose what it did
 *
 * A source-declared AXIS is writable and always was: choosing an option swaps
 * the classes that option contributes, `updateClass` lands those on disk, and
 * the note under the rows says it writes the classes and not the prop. None of
 * that changes here.
 *
 * A LIBRARY-documented prop is the open question, and it was investigated on
 * both lanes rather than assumed:
 *
 *  - **React cannot.** The pinned rewrite engine (`react-rewrite-cli@0.1.1`)
 *    has four source operations — `updateClass`, `updateText`, `reorder`,
 *    `moveSpacing` — and not one of them edits a JSX attribute.
 *  - **Angular cannot either, today, and is one wire operation away.**
 *    `AngularOperation` in `core/angular.ts` is `setStyles | setClasses |
 *    setText`; `editsFor` in `server/angular-source.mjs` answers exactly those
 *    three plus `removeElement` and `insertElement`. That server already has a
 *    general `setAttribute` splicer sitting in it, unreachable, because no
 *    operation asks for it. So `variant="primary"` in an Angular template is
 *    genuinely writable in principle and is not writable now, and minting that
 *    operation is a server change this section has no standing to make.
 *
 * What Angular DOES supply is the other half. A component's selector is the DOM
 * tag, and an input written statically in a template — `variant="primary"` —
 * is a real attribute on the real element. That is evidence, and it is the gate
 * this section uses. A documented prop that is PRESENT as an attribute on the
 * selected element gets a control: setting it sets the attribute, which is a
 * live preview any component styling itself off `[variant="primary"]` actually
 * repaints for, and the change is filed through `recordPreviewOnly` so the
 * Changes tab hands it to an agent. A documented prop that is NOT on the
 * element gets no control, because there is nothing to set, and setting it
 * would be inventing markup no file has.
 *
 * That is option (b) wherever the element supplies the evidence and option (a)
 * everywhere else — which on a React host is everywhere, since a React prop
 * leaves no attribute behind. The rows say which they are: a previewed one
 * toasts "— preview only" on every write and appears in Changes, a stated one
 * is printed as text with no control on it at all.
 *
 * Two things this deliberately does not claim. Setting an attribute does not
 * run Angular's change detection, so a component that reads its input once at
 * construction will not repaint — the attribute moved and the render may not,
 * and "preview only" is the truthful word for both. And nothing reaches `class`
 * or `style` by this path: those have real write lanes, and routing round them
 * would strand an edit that could have reached the file.
 */

import {
  currentOption,
  loadVariants,
  loadedVariants,
  matchDeclaration,
  variantClassWrite,
  type VariantAxis,
  type VariantDeclaration,
} from "../../core/variants"
import { el } from "../../core/dom"
import { icon } from "../../core/icons"
import { tokens } from "../../core/tokens"
import { componentPreview } from "../../libraries/preview"
import { copyLibrarySnippet } from "../../libraries/snippet"
import {
  componentSelectors,
  libraryComponentsFor,
  type LibraryComponentEntry,
} from "../../libraries/store"
import type { LibraryComponent } from "../../libraries/types"
import { group, miniButton, section, selectField } from "./field"
import { tokenField, type TokenChoice } from "./token-picker"
import type { InspectorSection, SectionContext } from "./index"

/**
 * Above this many options a property gets the searchable picker, below it a
 * plain select. A three-option axis in a popover with a search box is worse
 * than a list you can see all of, and a fifteen-option one is worse without it.
 */
const PICKER_THRESHOLD = 6
const MIXED = ""

/** The header thumbnail, on the row rung: a picture the size of a panel row. */
const THUMBNAIL = tokens.size.rowHeight

type DocumentedProp = NonNullable<LibraryComponent["props"]>[number]

/* -------------------------------------------------------------------------
 * Controls
 * ---------------------------------------------------------------------- */

/** One choosable value, in the vocabulary both sources reduce to. */
interface Choice {
  value: string
  /** `default`, or why the option is offered but inert. Empty for the rest. */
  detail: string
  /** Offered and not applicable — the row says so before the click. */
  disabled: boolean
}

/**
 * One-of-several, drawn as a select or as the searchable picker.
 *
 * Shared by the two kinds of row on purpose: a variant axis and a documented
 * string union are the same question asked of two different sources, and a
 * panel where one of them is a select and the other is something else would be
 * telling the designer about this module's plumbing.
 *
 * `selected === null` is MIXED, and Mixed is offered as a row only while the
 * instance is actually mixed: it is a reading of the element, never a state you
 * can choose to put it into.
 */
function oneOfField(options: {
  id: string
  label: string
  selected: string | null
  choices: Choice[]
  onCommit(value: string): void
}): HTMLElement {
  const commit = (value: string) => {
    if (!value || value === options.selected) return
    options.onCommit(value)
  }

  if (options.choices.length >= PICKER_THRESHOLD) {
    return tokenField({
      id: options.id,
      title: options.label,
      selectedId: options.selected ?? MIXED,
      choices: options.choices.map(
        (choice): TokenChoice => ({
          id: choice.value,
          group: options.label,
          leaf: choice.value,
          name: choice.value,
          preview: { kind: "none" },
          detail: choice.detail,
          disabled: choice.disabled,
        })
      ),
      fallback: { preview: { kind: "none" }, text: "Mixed" },
      onCommit: commit,
    })
  }

  return selectField({
    id: options.id,
    label: options.label,
    value: options.selected ?? MIXED,
    options: [
      ...(options.selected === null ? [{ value: MIXED, label: "Mixed" }] : []),
      ...options.choices.map((choice) => ({
        value: choice.value,
        label: choice.detail ? `${choice.value} (${choice.detail})` : choice.value,
      })),
    ],
    onCommit: commit,
  })
}

/**
 * A boolean, drawn as a switch — Figma's `Show icon`.
 *
 * The third drawing of this control in the chrome, and that is a debt rather
 * than a decision: `.de-ann-toggle` is the same `role="switch"` at the same
 * geometry, and `.de-lib-switch` is the same drawing reporting `aria-pressed`.
 * They live in the sheets that draw the notes tab and the Design system tab,
 * neither of which this block may reach into for a control, so the inspector's
 * instance sheet carries its own. A fourth would mean the three belong in
 * `css/panels.ts` as one rule.
 */
function switchField(options: {
  id: string
  label: string
  on: boolean
  onCommit(next: boolean): void
}): HTMLElement {
  const node = el("button", {
    class: "de-instance-switch",
    type: "button",
    role: "switch",
    "aria-checked": String(options.on),
    "aria-label": options.label,
    title: options.label,
    "data-de-field": options.id,
    /*
     * THE NEW STATE IS PAINTED ON THIS NODE BEFORE THE PANEL IS INVALIDATED.
     *
     * `css/variants.ts` specifies this control properly — 12px of knob travel
     * over `duration.reveal`, a track crossfade, a press squeeze — and none of it
     * ever played. `onCommit` ends in `context.invalidate()`, the Design tab
     * rebuilds all thirteen sections (`inspector/index.ts`), and the button the
     * user pressed is replaced by a new one already at `translateX(12px)`. A
     * node that has just been created has no previous value, so the browser
     * paints it at its final state: the knob teleported, and the CSS describing
     * how it should move was unreachable.
     *
     * Writing the attribute here gives the LIVE node a value to animate from.
     * The rebuild still happens a frame later and still replaces this button —
     * but by then the transition is already running, and the replacement mounts
     * at the same state the animation is heading for, so nothing snaps back.
     *
     * This is the local fix. The general one is for `invalidate()` to diff
     * rather than clear and re-append, which would revive the same dead
     * transitions on every other pressed control in `css/panels.ts`; until it
     * does, a control with motion worth keeping has to say so itself.
     */
    onclick: () => {
      const next = !options.on
      node.setAttribute("aria-checked", String(next))
      options.onCommit(next)
    },
  })
  return node
}

/** A fact the library states and this panel will not pretend to control. */
function statedValue(text: string, reason: string): HTMLElement {
  return el("span", { class: "de-instance-stated", title: reason }, [text])
}

/** The label-left/control-right row both sources render into. */
function propertyRow(name: string, control: Node): HTMLElement {
  return el("div", { class: "de-variant-axis", "data-de-prop": name }, [
    el("span", { class: "de-variant-axis-name", title: name }, [name]),
    control,
  ])
}

/* -------------------------------------------------------------------------
 * A source-declared axis — writable, through the classes it contributes
 * ---------------------------------------------------------------------- */

function axisRow(context: SectionContext, axis: VariantAxis): HTMLElement {
  const selected = currentOption(context.selection.element, axis)
  const control = oneOfField({
    // The field id is still `variants.*`: it is what focus is restored by
    // across a rebuild, and it is still the truth about what the row is.
    id: `variants.${axis.name}`,
    label: axis.name,
    selected,
    choices: axis.options.map((option) => ({
      value: option.name,
      // The runtime fact outranks the default one when an option is both: a
      // designer needs to know why a click will do nothing before the click.
      detail: !option.resolved
        ? "built at runtime"
        : option.name === axis.defaultOption
          ? "default"
          : "",
      // An option whose classes the source builds at runtime can be named but
      // never applied — `variantClassWrite` refuses it, and the picker says so
      // rather than letting the refusal arrive as nothing happening.
      disabled: !option.resolved,
    })),
    onCommit: (name) => {
      const write = variantClassWrite(context.selection.element, axis, name)
      if (!write) return
      context.writer.applyClasses(context.selection, write, `Set ${axis.name} to ${name}`)
      context.invalidate()
    },
  })
  return propertyRow(axis.name, control)
}

/* -------------------------------------------------------------------------
 * A library-documented prop — previewable only where the element wears it
 * ---------------------------------------------------------------------- */

/** `showIcon` -> `show-icon`, the other spelling a template may have used. */
function dashCase(name: string): string {
  return name.replace(/([a-z\d])([A-Z])/g, "$1-$2").toLowerCase()
}

/**
 * The attribute this prop is actually wearing on the element, or null.
 *
 * Matched case-insensitively and against the dashed spelling, because the two
 * sides are written by different people: a library documents `showIcon`, the
 * HTML parser lowercases whatever the template wrote, and an Angular author may
 * have written `show-icon`. A miss here is not a failure — it is the normal
 * answer, and it is what decides the row is a statement rather than a control.
 */
function attributeOn(element: Element, prop: string): string | null {
  const wanted = new Set([prop.toLowerCase(), dashCase(prop)])
  for (const name of element.getAttributeNames()) {
    if (wanted.has(name.toLowerCase())) return name
  }
  return null
}

/**
 * Whether a NATIVE boolean attribute is on, read off the element rather than
 * off the markup.
 *
 * `typeof element[name] === "boolean"` is the reflection test: `disabled` on a
 * `<button>` answers true, `variant` on an `<x-button>` answers undefined. It
 * matters because the two kinds are written back differently — a native boolean
 * is on by PRESENCE, so turning it off means removing the attribute, while
 * `disabled="false"` would leave the button disabled and the switch lying about
 * it.
 */
function nativeBoolean(element: Element, name: string): boolean {
  return typeof (element as unknown as Record<string, unknown>)[name] === "boolean"
}

const NO_ATTRIBUTE =
  "Not set on this element, and cannot be added from here."

/**
 * The element a component's inputs are actually ON, which is usually not the
 * one that was clicked.
 *
 * This is the whole of what made the evidence gate fire on nothing. An Angular
 * component renders a TEMPLATE, and a click lands wherever the pointer was —
 * on an `<app-button>`'s inner `<button class="btn btn--filled">`, say. The
 * bridge still reports `ButtonComponent` for that inner node, so the library
 * match succeeds and the section draws; but `variant="filled"` is on the host
 * tag one level up, so every row read the wrong element, found nothing, and
 * came out as a sentence. The panel said "this element does not carry them as
 * attributes" while the attributes were visible in the inspector two lines
 * above it.
 *
 * So the host is resolved by CLIMBING to the nearest ancestor whose tag is one
 * the library says this component answers to — `componentSelectors` owns that
 * list, and owns it for the matcher too, so the two cannot disagree about what
 * the component is called in the DOM. `closest` includes the element itself,
 * which is the common case on a host that was clicked directly.
 *
 * It never climbs past a match and never guesses: a component with no selector
 * — every React one — yields no tags, and the selection is returned unchanged.
 * That is the honest answer there, because a React prop leaves no attribute on
 * any ancestor either.
 */
function propertyHost(element: Element, match: LibraryComponentEntry | null): Element {
  if (!match) return element
  for (const tag of componentSelectors(match)) {
    // Guarded: the tags are already normalised to `[a-z][\w-]*` by
    // `componentSelectors`, but `closest` throws on a malformed selector rather
    // than returning null, and a throw here would take the whole section down
    // over a library's typo.
    try {
      const host = element.closest(tag)
      if (host) return host
    } catch {
      // Not a selector this browser will parse. Try the next tag.
    }
  }
  return element
}

/**
 * A documented boolean, as a switch — but only where its state is a reading
 * rather than a guess.
 *
 * A switch drawn disabled would still be a switch drawn in a POSITION, and
 * "off" is exactly the thing this section does not know about a prop that
 * leaves no trace on the element: a component's input can default to true, and
 * a greyed-out switch sitting at off would be asserting otherwise. So the
 * unreadable case is stated like every other fact with no control behind it.
 */
function booleanRow(context: SectionContext, prop: DocumentedProp, host: Element): HTMLElement {
  const element = host
  const native = nativeBoolean(element, prop.name)
  const attribute = attributeOn(element, prop.name)
  if (!native && !attribute) return statedRow(prop)

  const value = attribute ? element.getAttribute(attribute) : null
  // Native first: a reflected boolean is readable and writable whether or not
  // the attribute is spelled out, which is also the only branch with no dead
  // end in it — removing a bare attribute would otherwise take the control away
  // with it.
  const on = native
    ? Boolean((element as unknown as Record<string, unknown>)[prop.name])
    : value !== null && value.trim().toLowerCase() !== "false" && value.trim() !== "0"
  const name = attribute ?? dashCase(prop.name)

  return propertyRow(
    prop.name,
    switchField({
      id: `instance.${prop.name}`,
      label: prop.name,
      on,
      onCommit: (next) => {
        // A native boolean is on by PRESENCE — `disabled="false"` leaves a
        // `<button>` disabled — so off means removing it. Anything else keeps
        // the attribute in the markup and flips its value, so the row is still
        // writable the render after it was turned off.
        const write = native ? (next ? "" : null) : String(next)
        context.writer.applyAttribute(context.selection, name, write, element)
        context.invalidate()
      },
    })
  )
}

function enumRow(
  context: SectionContext,
  prop: DocumentedProp,
  values: string[],
  host: Element
): HTMLElement {
  const element = host
  const attribute = attributeOn(element, prop.name)
  if (!attribute) {
    // Documented, not present, and therefore not writable. Stated as the list
    // of values the library names — the same middle-dot run the assets details
    // popover used, because a dozen chips in a 260px column is four rows of
    // plates for a list nobody presses.
    return propertyRow(prop.name, statedValue(values.join(" · "), NO_ATTRIBUTE))
  }

  const current = element.getAttribute(attribute) ?? ""
  return propertyRow(
    prop.name,
    oneOfField({
      id: `instance.${prop.name}`,
      label: prop.name,
      // Mixed rather than a guess, exactly as an axis reads: an attribute
      // holding something the library never declared is a real state, and
      // calling it the default would be a lie the next click acts on.
      selected: values.includes(current) ? current : null,
      choices: values.map((value) => ({
        value,
        detail: value === prop.default ? "default" : "",
        disabled: false,
      })),
      onCommit: (value) => {
        context.writer.applyAttribute(context.selection, attribute, value, element)
        context.invalidate()
      },
    })
  )
}

/**
 * Everything else a library documents — a callback, a node, an object.
 *
 * Stated and never offered. A control here would have to write something into
 * an attribute, and a function or a template reference has no attribute
 * spelling at all: the row would look like the two above it and produce a
 * broken `onClick="[object Object]"` in somebody's markup.
 */
function statedRow(prop: DocumentedProp): HTMLElement {
  const text = prop.values?.length ? prop.values.join(" · ") : prop.type || "documented"
  return propertyRow(
    prop.name,
    statedValue(text, `Documented only. Nothing to set on this element.`)
  )
}

function isBoolean(prop: DocumentedProp): boolean {
  return /^bool(ean)?$/i.test((prop.type ?? "").trim())
}

/**
 * One documented prop, and whether it came out as a control or as a sentence.
 *
 * The flag is carried out rather than re-derived from the DOM, because the note
 * under the rows says which of the two happened and an axis's own control sits
 * in the same list — asking "does any row have a field in it" would let a
 * writable axis vouch for a library's unwritable props.
 */
function documentedRow(
  context: SectionContext,
  prop: DocumentedProp,
  host: Element
): { node: HTMLElement; writable: boolean } {
  const element = host
  if (isBoolean(prop)) {
    const writable = nativeBoolean(element, prop.name) || attributeOn(element, prop.name) !== null
    return { node: booleanRow(context, prop, host), writable }
  }
  // Two values is the floor for a choice. A one-value "union" is a fact about
  // the component, not a control, and a dropdown you cannot change is furniture.
  const values = (prop.values ?? []).filter((value) => value.trim())
  if (values.length >= 2) {
    return {
      node: enumRow(context, prop, values, host),
      writable: attributeOn(element, prop.name) !== null,
    }
  }
  return { node: statedRow(prop), writable: false }
}

/* -------------------------------------------------------------------------
 * The header
 * ---------------------------------------------------------------------- */

/**
 * The instance header — Figma's four-diamond mark, the component's name, and
 * where it came from.
 *
 * The glyph is lucide's `Component`, which is literally that mark. What is NOT
 * here is Figma's row of instance actions: swap instance, reset overrides,
 * detach, go to main. Each of them is a real operation on a Figma document and
 * none of them is an operation this editor can perform on somebody's source —
 * a button that cannot act is worse than no button, which is the same rule the
 * token picker applies to its own missing `+`.
 */
function headerRow(
  context: SectionContext,
  name: string,
  match: LibraryComponentEntry | null
): HTMLElement {
  return el("div", { class: "de-instance-head", "data-de-instance": "header" }, [
    el("span", { class: "de-instance-glyph", "aria-hidden": "true" }, [
      icon("Component", tokens.icon.action),
    ]),
    // A picture only where one is cheap and real: `componentPreview` clones an
    // instance the page already holds, and the page is holding one — the
    // element in front of us. It falls back to a monogram plate on its own, and
    // a miss there is a normal answer rather than a failure.
    match
      ? el("span", { class: "de-instance-thumb", "aria-hidden": "true" }, [
          componentPreview(context.editor, match, THUMBNAIL),
        ])
      : null,
    el("span", { class: "de-instance-id" }, [
      el("span", { class: "de-instance-name", title: name }, [name]),
      match
        ? // `.de-instance-owner` ellipsises, and its own stylesheet comment says
          // what it is for: telling you WHICH library, when two are loaded. A
          // cut of `From @acme/design-syste…` cannot do that job, and the
          // sibling line above it already carries its `title`.
          el(
            "span",
            { class: "de-instance-owner", title: `From ${match.libraryName}` },
            [`From ${match.libraryName}`]
          )
        : null,
    ]),
  ])
}

/* -------------------------------------------------------------------------
 * The section
 * ---------------------------------------------------------------------- */

/**
 * The declarations for the selection's file, fetching them once if this is the
 * first time anything asked.
 *
 * A re-render is scheduled only when the fetch found something: a file with no
 * variants must not schedule a rebuild it has nothing to add to.
 */
function declarationFor(context: SectionContext): VariantDeclaration | null {
  const filePath = context.selection.source?.filePath ?? ""
  if (!filePath) return null

  const declarations = loadedVariants(filePath)
  if (declarations === null) {
    void loadVariants(context.editor.apiBase, filePath).then((loaded) => {
      if (loaded.length) context.invalidate()
    })
    return null
  }
  return matchDeclaration(context.selection.element, declarations)
}

export const instanceSection: InspectorSection = (context) => {
  const { componentName, tagName } = context.selection
  const declaration = declarationFor(context)
  // Case-insensitive on both halves, because the two sides are written by
  // different people: a manifest says "button", the JSX exports `Button`, and a
  // section that missed on the capital would be a feature that works for
  // whoever authored both halves and for nobody else.
  const match =
    componentName.trim() || tagName.trim()
      ? libraryComponentsFor(componentName, tagName)[0] ?? null
      : null
  if (!declaration && !match) return null

  const rows: HTMLElement[] = []
  const axisNames = new Set<string>()
  for (const axis of declaration?.axes ?? []) {
    axisNames.add(axis.name.trim().toLowerCase())
    rows.push(axisRow(context, axis))
  }

  // Resolved ONCE and handed to every documented row, rather than each row
  // climbing for itself: the answer is a property of the selection and the
  // match, not of the prop, and `closest` per row would walk the ancestor chain
  // five times to reach the same node.
  const host = propertyHost(context.selection.element, match)

  let documented = 0
  let previewable = 0
  let stated = 0
  for (const prop of match?.props ?? []) {
    documented += 1
    // THE MERGE RULE. An axis and a documented prop of the same name are one
    // property described twice, and the axis wins because it is the half that
    // can be written: the library's entry would render a second row for the
    // same thing, offering a control that reaches a live attribute instead of
    // the classes the component actually styles itself with.
    if (axisNames.has(prop.name.trim().toLowerCase())) continue
    const row = documentedRow(context, prop, host)
    if (row.writable) previewable += 1
    else stated += 1
    rows.push(row.node)
  }

  // A declaration whose axes are all shadowed, or a library entry documenting
  // nothing, is still an instance: the header is the answer to "what is this".
  //
  // The bridge's name beats the declaration's, which is the factory VARIABLE —
  // `buttonVariants` is what the source calls the recipe, and `Button` is what
  // the designer selected.
  const name = match?.name || componentName || declaration?.name || tagName

  const body: Array<HTMLElement | null> = [headerRow(context, name, match)]
  // The declaring file, and only when the LIBRARY names one. The panel header
  // above this section already prints the selection's own source line, so
  // repeating it here would be the same fact twice in 260px.
  //
  // `title` because the row is clipped at the END — the comment on
  // `.de-instance-file` in `css/variants.ts` records why it is not reversed —
  // and a path cut at the end is a path with its filename missing, which is the
  // only part of it anybody was reading.
  if (match?.file) {
    body.push(el("div", { class: "de-instance-file", title: match.file }, [match.file]))
  }
  if (match?.description) body.push(el("div", { class: "de-instance-desc" }, [match.description]))
  if (rows.length) body.push(group("Properties", ...rows))

  /*
   * What a write here actually does, said once per selection rather than once
   * per session — and said separately for the two halves, because they land in
   * two different places and a designer has to know which.
   */
  if (declaration) {
    body.push(
      el("div", { class: "de-variant-note" }, [
        `Picking an option writes its classes, not the ${declaration.name || "component"} prop.`,
      ])
    )
  }
  if (match && documented) {
    // One note per SOURCE and not one per outcome. A block whose properties
    // came out three different ways would otherwise carry three paragraphs
    // under four rows, and a note nobody finishes reading is a note that has
    // stopped saying anything.
    /*
     * Which ELEMENT the writable rows are aimed at, and only when it is not the
     * one the header names.
     *
     * A designer who selected the inner `<button>` of an `<app-button>` is
     * about to change a control and watch a different node in the layer tree
     * take the attribute. Naming the host is the difference between that
     * reading as the panel working and as the panel writing somewhere random,
     * and it costs a tag name. Silent in the ordinary case, where the host IS
     * the selection and saying so would be furniture.
     */
    const hostTag = host !== context.selection.element ? `<${host.tagName.toLowerCase()}>` : ""
    body.push(
      el("div", { class: "de-variant-note" }, [
        previewable
          ? `Props preview${hostTag ? ` on ${hostTag}` : ""} and go to Changes. They are not written to the file.${
              stated ? " The rest are documented only." : ""
            }`
          : `Documented by ${match.libraryName}. Read-only: ${
              hostTag ? `${hostTag} has` : "this element has"
            } no matching attributes.`,
      ])
    )
  }

  /*
   * The one instance action this editor can honestly offer, in the header's
   * actions slot.
   *
   * Figma puts swap / reset / detach / go-to-main up here and none of those is
   * an operation on somebody's source — see `headerRow`, which refuses to draw
   * them. Copying the snippet the library publishes for this component is the
   * nearest thing that is real: it is the canonical way to write another one,
   * which is what "go to main component" is FOR at the moment a developer
   * reaches for it. It also keeps the affordance the assets details popover had
   * before that surface was removed, rather than quietly dropping it.
   *
   * `copyLibrarySnippet` is imported rather than reimplemented because its one
   * subtlety — issue the clipboard write synchronously, inside the click task,
   * before anything awaits — is invisible in a copy and fails only on a real
   * click. See `libraries/snippet.ts`.
   */
  const snippet = match?.snippet ?? ""
  const actions = snippet
    ? miniButton({
        label: `Copy the ${name} snippet`,
        glyph: icon("Copy", tokens.icon.action),
        onClick: () => copyLibrarySnippet(context.editor, snippet, name),
      })
    : undefined

  return section("Component", el("div", { class: "de-stack" }, body), actions)
}
