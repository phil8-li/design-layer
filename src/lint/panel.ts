/**
 * DS Lint: run the audit, read what it found, fix or dismiss it.
 *
 * The verb is **Audit**. One word, it is what designers already call this, and
 * it promises a report rather than a boolean — which matters here because the
 * honest answer is almost never "compliant" or "not", it is a list with some
 * things on it that can be fixed automatically and some that cannot.
 *
 * It was a standalone panel in the left rail with a header bar of its own, and
 * it is now a `section()` on the right panel's Design system tab, sitting under
 * Libraries. A panel wearing its own header inside a tab of sections is a
 * surface that looks like it was pasted in, and it made a reader learn two
 * headers for one idea; the section is what Fill, Typography and Handover all
 * are, so this is one thing to learn instead.
 *
 * ## The section is ONE control that grows, and one icon that explains itself
 *
 * Two things a designer never asked to decide used to be on screen before they
 * had pressed anything: WHICH checker runs, as a row of chips, and what to do
 * with a report that did not exist yet, as a footer of two buttons.
 *
 * Neither is a decision. The server already routes: `POST /lint/run` with no
 * `tools` key runs exactly the checkers that apply to this project, so the
 * chips were a list of an answer nobody had to give. They are now an INFO ICON
 * in the section header — hover it and it names, in one sentence, what is
 * running and what is not. See `checkerLine`.
 *
 * And Audit, Fix all and Hide markers are one BUTTON GROUP with two shapes.
 * Before a run it is a single Audit button, because "fix all of nothing" and
 * "hide markers that are not painted" are two controls about a list that does
 * not exist. The moment a run lands findings, the same group grows the other
 * two. That is also why Audit is no longer in the section header's actions
 * slot: a group whose first member lives in the header and whose other two live
 * in the body is not a group, it is three controls that happen to be related.
 *
 * FOUR THINGS THIS PANEL IS CAREFUL ABOUT, each of which is a way the same
 * screen can look fine while lying:
 *
 *  1. **A checker that will not run is still named, never silently dropped.** A
 *     tool that is installed but inapplicable — or configured but not
 *     resolvable — contributes nothing, and a surface that simply omits it
 *     reads as "everything was checked". The info icon's sentence names it on
 *     the "Not running" side, and when NOTHING can run the empty state spends
 *     the space the findings would have taken on each checker's own reason. A
 *     green audit that skipped a checker silently is the single most expensive
 *     thing this panel could do; moving that fact from three chips into one
 *     hover makes it quieter, and it must not make it absent.
 *
 *  2. **The summary counts this page as well as the project.** Most findings
 *     are in files the current route never renders, so the total and the number
 *     of badges on the canvas are routinely different numbers. A panel claiming
 *     twenty while the canvas paints twelve looks broken, and a designer only
 *     has to check it against the screen once to stop believing the rest of it.
 *     Both numbers come from `lintSummary`, whose on-page figure is the count of
 *     findings that resolved to a live element — the same resolution the marker
 *     layer paints from, not a second walk of the document.
 *
 *  3. **A subset can be chosen.** Per-row Fix is not the same feature as "let
 *     the user choose which ones to fix": the second one is about deciding
 *     across a list, and a list of forty rows cannot be triaged one button at a
 *     time. So every row carries a checkbox and the group's Fix button changes
 *     from "Fix all (12)" to "Fix 3" the moment anything is checked.
 *
 *  4. **An unfixable finding says why.** `fix: null` means the checker named no
 *     confident replacement — usually because it offered three near-matches, and
 *     picking one for the user is how a linter silently changes a colour nobody
 *     chose. The row states that in words instead of showing a button that does
 *     nothing, and points at the inspector, where the user picks the token
 *     themselves.
 *
 * ## What lives where
 *
 * Nothing about the canvas is decided here. The panel writes `markersShown` in
 * the store and the marker layer reads it; the two layers' mutual exclusion is
 * the marker layer's business, driven by that one boolean. Row and badge light
 * each other up through `designlayer:lint-hover` and its mirror, the same
 * window-event seam the annotation layer uses, for the same reason: neither
 * surface should have to import the other to exist.
 */

import { clear, el } from "../core/dom"
import { smoothScroll } from "../core/motion"
import { holdScroll } from "../core/scroll"
import { icon } from "../core/icons"
import { tokens } from "../core/tokens"
import { section, setSectionHint } from "../panels/inspector/field"
import type { EditorContext } from "../core/context"
import type { LayerElement } from "../core/types"
import {
  elementsForFinding,
  fixFindings,
  ignoreFindings,
  ignoredFindings,
  lintError,
  lintFindings,
  lintResolutionEpoch,
  lintRanAt,
  lintRunState,
  lintSummary,
  lintTools,
  lintToolsLoaded,
  lintVersion,
  loadLintTools,
  isOnThisPage,
  markersShown,
  runAudit,
  setMarkersShown,
  subscribeToLint,
  unignoreFindings,
  type LintFinding,
} from "./store"
import { displayLiteral, hintFor, ruleTitle, swatchFor } from "./plain"
import { formatCount, plural } from "../core/format"

/**
 * The two halves of the row/badge hover pair, named exactly as the marker
 * contract names them.
 *
 * `designlayer:lint-hover`        panel  -> canvas  `{ id: string | null }`
 * `designlayer:lint-marker-hover` canvas -> panel   `{ id: string | null }`
 *
 * `null` is a value in the pair rather than a second event, because the two
 * halves have to be handled by one code path — a listener that only ever hears
 * "now this one" is how a highlight gets stuck on a row nobody is pointing at.
 */
const HOVER_EVENT = "designlayer:lint-hover"
const MARKER_HOVER_EVENT = "designlayer:lint-marker-hover"

/** The row the canvas is pointing at. The look belongs to `css/lint.ts`. */
const ROW_ACTIVE = "de-lint-row--active"

/**
 * Why a finding has no Fix button — the row's tooltip, not its body.
 *
 * The server only produces a `fix` when the checker named one replacement
 * outright. Everything else — a message listing three nearest candidates, a
 * hardcoded colour with no token anywhere near it — arrives as `null`, and the
 * reason is always the same one: there is no answer this editor is entitled to
 * pick on the user's behalf.
 *
 * It used to be a two-line paragraph printed on every unfixable row, which made
 * it the largest thing on this surface: the same forty words, forty times, in a
 * list whose whole job is to be skimmed. The row now says it the two ways a
 * skimming reader actually reads — no Fix button, and a four-word `hintFor`
 * naming the choice that is left — and the sentence is what hovering explains.
 * Identical prose repeated down a list is not emphasis; it is the thing the
 * reader learns to skip, and it takes the rows either side of it with it.
 *
 * It opens with the row's own four words rather than a second spelling of them.
 * This said "No safe automatic fix" while the row said "No automatic fix", and
 * a hover whose job is to expand the row instead restated it differently — two
 * names for one state, which reads as two states. `safe` was also doing no work
 * in a four-word hint: every fix this panel offers is one the checker named
 * outright, so there is no unsafe fix being withheld for the word to contrast
 * with. The full reason it might be is the sentence that follows.
 */
const NO_FIX =
  "No automatic fix. Select the element and pick a token in the inspector."

/** `3 issues`, `1 issue`. The summary has to count aloud. */
function issueWord(count: number): string {
  return plural(count, "issue")
}

/** The tail of the path: what identifies a file to someone working in the repo. */
function basename(finding: LintFinding): string {
  return finding.file.split("/").pop() || finding.file
}

/** Basename and line, as one string — for accessible names and toasts. */
function where(finding: LintFinding): string {
  return `${basename(finding)}:${finding.line}`
}

/** Only these two can be selected on the canvas; anything else is listed only. */
function selectable(element: Element): LayerElement | null {
  if (element instanceof HTMLElement) return element
  if (element instanceof SVGSVGElement) return element
  return null
}

function announceHover(id: string | null): void {
  window.dispatchEvent(new CustomEvent(HOVER_EVENT, { detail: { id } }))
}

/** Findings under their rule, in first-appearance order. */
function byRule(findings: readonly LintFinding[]): Array<{ rule: string; rows: LintFinding[] }> {
  const groups = new Map<string, LintFinding[]>()
  for (const finding of findings) {
    const known = groups.get(finding.rule)
    if (known) known.push(finding)
    else groups.set(finding.rule, [finding])
  }
  return [...groups.entries()].map(([rule, rows]) => ({ rule, rows }))
}

export function dsLintSection(editor: EditorContext): { node: HTMLElement; update(): void } {
  /*
   * View state, and all of it belongs in the closure rather than in the store.
   *
   * Which findings are ticked and whether the ignored list is open are facts
   * about this section in this session, not about the project — the same call
   * `libraries-section.ts` makes about its own fold. `checked` is pruned against
   * the live findings on every render, because a fixed or ignored row leaves a
   * tick behind that would otherwise make "Fix 3" a promise about two rows.
   */
  const checked = new Set<string>()
  let showIgnored = false
  let requested = false
  /** The last state actually painted, so a beat that changed nothing is free. */
  let painted = ""
  /** Rows by finding id, so the canvas can light one without a re-render. */
  let rows = new Map<string, HTMLElement>()
  /** Held rather than queried: ticking a box relabels it on every change. */
  let fixAll: HTMLButtonElement | null = null

  const auditButton = el(
    "button",
    {
      class: "de-button de-button--primary de-lint-run",
      type: "button",
      "data-de-lint": "audit",
      onclick: () => audit(),
    },
    [icon("ListChecks", tokens.icon.marker), "Audit"]
  ) as HTMLButtonElement

  /**
   * The one group, and the only place these three controls exist.
   *
   * A `role="group"` rather than a bare div because that is what it now is to a
   * screen reader as well as to the eye: the two buttons that appear after a run
   * arrive INSIDE the thing the reader just pressed, rather than somewhere else
   * on the tab. Named for the verb, so the arrival is announced as "Audit group,
   * Fix all (12)" and not as two unattributed buttons.
   */
  const controls = el("div", {
    class: "de-lint-controls",
    role: "group",
    "aria-label": "Audit",
  })

  const summaryLine = el("div", {
    class: "de-lint-summary",
    "data-de-lint": "summary",
    // Polite rather than assertive: the count changes when a run lands, which
    // is news, but not news worth interrupting a screen reader mid-sentence.
    "aria-live": "polite",
  })
  /**
   * A run that failed, announced rather than silently swapped in.
   *
   * It used to be a `<p>` built inside `body` on the render that noticed the
   * failure. That is an asynchronous error written into a plain container: the
   * press that started the audit moved no focus, the button has already gone
   * back to saying "Audit", and nothing tells a screen-reader user that the
   * thing they asked for did not happen. `role="alert"` is what
   * `libraries-section.ts` uses on its sign-in refusal for exactly this shape of
   * failure, and this is the same shape.
   *
   * It lives OUTSIDE `body` and is hidden rather than removed, because `body` is
   * cleared on every render — a live region rebuilt each paint either announces
   * a sentence that has not changed or, worse, is inserted already-populated and
   * announces nothing at all.
   */
  const errorLine = el("p", {
    class: "de-lint-error",
    role: "alert",
    "data-de-lint": "failure",
    hidden: true,
  })
  const body = el("div", { class: "de-lint-body" })
  const footer = el("div", { class: "de-lint-footer" })

  /*
   * The header carries the explanation, on hover of the title: which checkers
   * this project gets. It used to be a help dot beside the title; the title
   * now opens the same sentence itself. See `paintCheckers`.
   */
  const node = section(
    // Sentence case, like the fifteen other section headings in the inspector.
    // "Lint" is not a proper noun and this file already spells the tool
    // `ds-lint` in lower case where it names the binary.
    "DS lint",
    el("div", { class: "de-lint" }, [controls, summaryLine, errorLine, body, footer]),
    undefined,
    false,
    checkerLine()
  )
  // The hook the tests and the report address the checkers sentence by.
  node.querySelector(".de-section-title")?.setAttribute("data-de-lint", "checkers")

  /* ---------- the calls ---------- */

  function audit(): void {
    if (lintRunState() === "running") return
    // No repaint here: `runAudit` announces the running state synchronously,
    // and the subscription below turns that into the disabled button.
    void runAudit(editor.apiBase).catch((error: unknown) => {
      editor.toast(
        error instanceof Error
          ? error.message
          : "Audit failed. Check the designlayer terminal, then try again.",
        "error"
      )
    })
  }

  function fix(ids: string[]): void {
    if (!ids.length) return
    void fixFindings(editor.apiBase, ids)
      .then((result) => {
        for (const id of result.fixed) checked.delete(id)
        paintSelection()
        if (result.failed.length) {
          // Named rather than counted: a failure here means the file moved
          // under us, and the one thing the user can do about it is re-audit —
          // which the sentence now says outright. The comment used to argue for
          // a recovery the copy never mentioned, leaving the reader a reason
          // and no instruction.
          editor.toast(
            {
              title: `Fixed ${result.fixed.length}, ${result.failed.length} failed`,
              description: `${result.failed[0].reason} Run Audit again to refresh.`,
            },
            "error"
          )
          return
        }
        editor.toast(`Fixed ${result.fixed.length} of ${ids.length}`)
      })
      .catch((error: unknown) => {
        editor.toast(
          error instanceof Error
            ? error.message
            : "Fix failed. The file may have changed. Run Audit again.",
          "error"
        )
      })
  }

  function ignore(ids: string[]): void {
    void ignoreFindings(editor.apiBase, ids)
      .then(() => {
        for (const id of ids) checked.delete(id)
        paintSelection()
      })
      .catch((error: unknown) => {
        editor.toast(
          error instanceof Error
            ? error.message
            : "Could not ignore that finding. Try again.",
          "error"
        )
      })
  }

  function unignore(ids: string[]): void {
    void unignoreFindings(editor.apiBase, ids).catch((error: unknown) => {
      editor.toast(
        error instanceof Error
          ? error.message
          : "Could not restore that finding. Try again.",
        "error"
      )
    })
  }

  /**
   * Selects the element a finding is about and brings it into view.
   *
   * The element comes from the store's index — the same resolution the badge
   * was drawn from — so the row and the badge can never disagree about which
   * node they mean. A finding that is not on this page says so rather than
   * silently doing nothing, because "I clicked it and nothing happened" is
   * indistinguishable from a broken row.
   */
  function reveal(finding: LintFinding): void {
    const element =
      elementsForFinding(finding.id)
        .filter((node) => node.isConnected)
        .map(selectable)
        .find(Boolean) ?? null
    if (!element) {
      editor.toast(
        `${where(finding)} is not on this page. Open a page that shows it, then try again.`,
        "error"
      )
      return
    }
    editor.select(element)
    // Guarded: JSDOM does not implement it, and the suites drive this directly.
    element.scrollIntoView?.({ block: "center", inline: "nearest", behavior: smoothScroll() })
    announceHover(finding.id)
  }

  /* ---------- pieces ---------- */

  /**
   * The whole checker story in one sentence, for the header icon's hover.
   *
   * Names only, and at most two clauses. The chips this replaces carried each
   * checker's full reason — "This project does not use Tailwind. shadcn/lint
   * reads utility classes, so on a design system built from custom
   * properties…" — which is the right sentence to have written and the wrong
   * one to put in front of somebody who only wanted to know what just ran.
   * Those reasons are still on the wire and still reachable at
   * `GET /lint/tools`; what a hover owes the reader is the list.
   *
   * The one place a reason DOES still surface is the empty state, and only in
   * the case where it is the answer to the question on screen: nothing can run,
   * so "why not" is the only thing left to say.
   */
  function checkerLine(): string {
    if (!lintToolsLoaded()) return "Finding checkers for this project…"
    const all = lintTools()
    // The one branch of this sentence that is a dead end rather than a report:
    // there is nothing to name, so it names what would make the feature work.
    if (!all.length) {
      return "No checker installed. Add Stylelint, ds-lint or shadcn/lint to run an audit."
    }
    const names = (subset: typeof all): string => subset.map((tool) => tool.name).join(", ")
    const on = all.filter((tool) => tool.available)
    const off = all.filter((tool) => !tool.available)
    // Named even when none of them run: "no checker" with no names is a claim
    // the reader cannot check against their own package.json.
    if (!on.length) return `No checker fits this project. Tried: ${names(off)}.`
    return off.length ? `Running ${names(on)}. Not running: ${names(off)}.` : `Running ${names(on)}.`
  }

  /**
   * The offending text, and the colour it is — as one chip.
   *
   * A swatch is the fastest thing on this row to read and the only part of it
   * that is not language: a designer has recognised the blue before they have
   * finished the first word of the token's name. It is omitted, rather than
   * faked with a neutral square, whenever the text is not a colour — an inline
   * `display: flex` finding has no swatch to draw and a grey one would claim it
   * did.
   */
  function literalChip(text: string, kind: "found" | "fix"): HTMLElement | null {
    if (!text.trim()) return null
    const paint = swatchFor(text)
    return el("span", { class: `de-lint-literal de-lint-literal--${kind}`, title: text }, [
      paint ? el("span", { class: "de-lint-swatch", style: `background:${paint}` }) : null,
      // `displayLiteral`, not the raw text: a token reads as `--color-accent`
      // here and the `var()` it will actually be written as is on the Fix
      // button's tooltip. `title` above still carries the exact string.
      el("span", { class: "de-lint-literal-text" }, [displayLiteral(text)]),
    ])
  }

  function findingRow(finding: LintFinding): HTMLElement {
    const onPage = isOnThisPage(finding.id)
    const severity = finding.severity === "error" ? "error" : "warning"
    const hint = hintFor(finding)

    const box = el("input", {
      class: "de-lint-check-input",
      type: "checkbox",
      "aria-label": `Select ${finding.rule} at ${where(finding)}`,
    }) as HTMLInputElement
    box.checked = checked.has(finding.id)
    box.addEventListener("click", (event) => event.stopPropagation())
    box.addEventListener("change", () => {
      if (box.checked) checked.add(finding.id)
      else checked.delete(finding.id)
      // Repainted in place rather than re-rendered: a rebuild here would drop
      // the focus off the checkbox the user is still holding the pointer on.
      paintSelection()
    })

    /*
     * The row leads with the VALUE, and the checker's paragraph moves to hover.
     *
     * It led with the message, which is the checker writing to whoever will
     * edit the file: the literal, the rule, the near misses, the file the
     * tokens are declared in and two or three things you might do instead. One
     * of those is a good paragraph. Forty of them stacked down a 260px rail is
     * a wall, and the reader's question was never "what did the linter say", it
     * is which colour and what do I press.
     *
     * So the visible row is `#3b6ef5 → var(--ds-sys-color-primary)` with both
     * colours painted, and the sentence is in `title` and in the accessible
     * name — where a sentence belongs once the glanceable version exists.
     * Nothing is lost and nothing is summarised by this editor in the checker's
     * voice: the arrow is drawn from `finding.fix`, which is structured data
     * the server already committed to, not from parsing prose.
     */
    const select = el(
      "button",
      {
        class: "de-lint-select",
        type: "button",
        // The severity is in the accessible name because the dot beside the
        // message is the only other place it is stated, and a colour is not a
        // name.
        "aria-label": `${severity}: ${finding.message}, at ${finding.file}:${finding.line}`,
        // The whole of what the checker said, one hover away. Also carries
        // `NO_FIX` on a row that has no Fix button, which is the question that
        // row raises and the only row that raises it.
        title: finding.fix ? finding.message : `${finding.message}\n\n${NO_FIX}`,
        "data-de-lint": "select",
        onclick: () => reveal(finding),
      },
      [
        // Unmodified: the tone AND the corner both come down from the row's
        // severity class, so there is one place a severity turns into a mark.
        // Hidden from the reader because the severity word is already in the
        // button's accessible name above; the shape is the sighted half of the
        // same statement, for someone who cannot sort red from amber.
        el("span", { class: "de-lint-dot", "aria-hidden": "true" }),
        el("span", { class: "de-lint-headline" }, [
          literalChip(finding.snippet, "found"),
          finding.fix ? el("span", { class: "de-lint-arrow", "aria-hidden": "true" }, ["→"]) : null,
          finding.fix ? literalChip(finding.fix.replacement, "fix") : null,
        ]),
        // Three or four words, and only on the rows that have a decision left
        // in them. See `hintFor`.
        hint ? el("span", { class: "de-lint-hint" }, [hint]) : null,
        // Three spans, because only one of them may be cut: the name shrinks,
        // the line number and the badge do not. See `.de-lint-where-file`.
        el("span", { class: "de-lint-where", title: `${finding.file}:${finding.line}` }, [
          el("span", { class: "de-lint-where-file" }, [basename(finding)]),
          el("span", { class: "de-lint-where-line" }, [`:${finding.line}`]),
          onPage ? null : el("span", { class: "de-lint-offpage" }, ["off page"]),
        ]),
      ]
    )

    const actions = el("div", { class: "de-lint-actions" }, [
      finding.fix
        ? el(
            "button",
            {
              class: "de-button de-lint-action",
              type: "button",
              "aria-label": `Fix ${finding.rule} at ${where(finding)}`,
              title: `Replace ${finding.snippet} with ${finding.fix.replacement}`,
              "data-de-lint": "fix",
              onclick: (event: Event) => {
                event.stopPropagation()
                fix([finding.id])
              },
            },
            ["Fix"]
          )
        : null,
      el(
        "button",
        {
          class: "de-button de-lint-action",
          type: "button",
          "aria-label": `Ignore ${finding.rule} at ${where(finding)}`,
          title: "Ignore",
          "data-de-lint": "ignore",
          onclick: (event: Event) => {
            event.stopPropagation()
            ignore([finding.id])
          },
        },
        ["Ignore"]
      ),
    ])

    const row = el(
      "div",
      {
        class: `de-lint-row de-lint-row--${severity}`,
        "data-de-lint": "finding",
        "data-de-lint-id": finding.id,
        // The whole row is the target, not only the button inside it: the
        // contract asks for "clicking the row itself", and the actions above
        // stop their own clicks from reaching here.
        onclick: () => reveal(finding),
      },
      [
        el("label", { class: "de-lint-check" }, [box]),
        select,
        actions,
      ]
    )

    row.addEventListener("pointerenter", () => announceHover(finding.id))
    row.addEventListener("pointerleave", () => announceHover(null))
    return row
  }

  function ignoredRow(finding: LintFinding): HTMLElement {
    return el(
      "div",
      {
        class: "de-lint-ignored-row",
        "data-de-lint": "ignored",
        "data-de-lint-id": finding.id,
      },
      [
        el("span", { class: "de-lint-ignored-text", title: finding.message }, [
          `${finding.message} · ${where(finding)}`,
        ]),
        el(
          "button",
          {
            class: "de-button de-lint-action",
            type: "button",
            "aria-label": `Stop ignoring ${finding.rule} at ${where(finding)}`,
            "data-de-lint": "unignore",
            onclick: () => unignore([finding.id]),
          },
          ["Unignore"]
        ),
      ]
    )
  }

  /* ---------- painting ---------- */

  /** The ticked findings that can actually be written, and what to call them. */
  function fixTarget(findings: readonly LintFinding[]): { ids: string[]; label: string } {
    const fixable = findings.filter((finding) => finding.fix !== null)
    if (!checked.size) {
      return { ids: fixable.map((finding) => finding.id), label: `Fix all (${fixable.length})` }
    }
    return {
      ids: fixable.filter((finding) => checked.has(finding.id)).map((finding) => finding.id),
      // The count is what is TICKED, not what is fixable within it: the user
      // ticked three things and the button has to be about those three. Whether
      // all three can be written is the disabled state's job, not the label's.
      label: `Fix ${checked.size}`,
    }
  }

  function paintRunState(): void {
    const running = lintRunState() === "running"
    auditButton.disabled = running || (lintToolsLoaded() && !lintTools().some((tool) => tool.available))
    clear(auditButton)
    auditButton.append(icon("ListChecks", tokens.icon.marker), running ? "Auditing…" : "Audit")
    /*
     * A disabled button has to say where the answer is, and say it twice.
     *
     * `No checker is available for this project` stated the fact and stopped
     * there, on the one control the reader just pressed and watched do nothing.
     * The reasons exist — the info dot beside the heading has every checker and
     * why it was skipped — and the sentence's job is to send them there rather
     * than restate the greyed-out state they can already see.
     *
     * Paired with `aria-description` for the same reason the info dot is: a
     * `title` is mouse-only, and a screen-reader user meeting a disabled Audit
     * button would otherwise get the disabled state with no account of it.
     */
    const why =
      auditButton.disabled && !running
        ? "No checker fits this project. The info icon lists what was tried."
        : ""
    auditButton.title = why
    if (why) auditButton.setAttribute("aria-description", why)
    else auditButton.removeAttribute("aria-description")
    /*
     * The one long-running, network-bound thing in the editor said so with a
     * STATIC STRING beside a glyph that did not move.
     *
     * An audit is a round trip to a checker over the whole page: seconds, not
     * frames. Everything about the button during that time — disabled, greyed,
     * relabelled — describes a state rather than an activity, and a disabled
     * button wearing a word is exactly what a button looks like when something
     * has gone wrong. The sweep is the only part that says the wait is
     * progressing rather than stuck.
     *
     * An attribute, not a class, so `css/lint.ts` can hang the sweep and the
     * skeleton rows off one flag; and paired with the rows below, which are the
     * same statement made where the answer will appear.
     */
    auditButton.toggleAttribute("data-de-busy", running)
  }

  /** The header's hover sentence. Cheap, and it changes only when discovery does. */
  function paintCheckers(): void {
    setSectionHint(node, checkerLine())
  }

  /** Ticks, row tint and the group button's label — no DOM is rebuilt. */
  function paintSelection(): void {
    for (const [id, row] of rows) {
      const on = checked.has(id)
      row.classList.toggle("de-lint-row--checked", on)
      // A tick dropped by a fix or an ignore, not by the reader, is cleared here
      // too: the ticks no longer force a rebuild that would redraw the box.
      const box = row.querySelector<HTMLInputElement>(".de-lint-check-input")
      if (box && box.checked !== on) box.checked = on
    }
    if (!fixAll) return
    const target = fixTarget(lintFindings())
    fixAll.textContent = target.label
    fixAll.disabled = target.ids.length === 0
  }

  /**
   * The button group, in whichever of its two shapes the report is in.
   *
   * Audit is always there. Fix all and Hide markers exist only while there are
   * findings for them to act on — not merely once a run has happened, because a
   * clean run leaves "Fix all (0)" disabled beside a marker toggle with nothing
   * to toggle, which is the same two controls-about-nothing this group exists to
   * stop showing. A run that finds nothing is a group that goes back to one
   * button, and the summary line underneath says the run happened.
   *
   * `fixAll` is nulled rather than left dangling, because `paintSelection` runs
   * on every tick and would otherwise be relabelling a button that is no longer
   * in the document.
   */
  function renderControls(findings: readonly LintFinding[]): void {
    clear(controls)
    controls.append(auditButton)

    /*
     * One primary in the group, and WHICH one moves.
     *
     * Audit is the primary while it is alone, because it is the only thing to
     * do. Once a report exists the primary act is writing the fixes, and Audit
     * has become "run it again" — so it steps down to a plain button rather
     * than sitting in a filled plate beside a second filled plate, which is two
     * buttons both claiming to be the one you meant.
     */
    auditButton.classList.toggle("de-button--primary", !findings.length)

    if (!findings.length) {
      fixAll = null
      return
    }

    const target = fixTarget(findings)
    fixAll = el(
      "button",
      {
        class: "de-button de-button--primary de-lint-fix-all",
        type: "button",
        "data-de-lint": "fix-all",
        // Read at the moment it is pressed, not when it was built: the ticks it
        // is about are changed by controls that deliberately do not re-render
        // this group.
        onclick: () => fix(fixTarget(lintFindings()).ids),
      },
      [target.label]
    ) as HTMLButtonElement
    fixAll.disabled = target.ids.length === 0

    const hide = el(
      "button",
      {
        class: "de-button de-lint-toggle",
        type: "button",
        // Pressed means the markers are hidden, which is what the control is
        // named for. The label follows the state so the button always says what
        // the next press will do.
        "aria-pressed": String(!markersShown()),
        "data-de-lint": "hide-markers",
        onclick: () => setMarkersShown(!markersShown()),
      },
      [
        icon(markersShown() ? "EyeOff" : "Eye", tokens.icon.marker),
        markersShown() ? "Hide markers" : "Show markers",
      ]
    )

    controls.append(fixAll, hide)
  }

  /**
   * The footer is now only the dismissed list, and it is usually not there.
   *
   * It kept the two primary controls until they joined the group at the top, and
   * what is left is one quiet disclosure that exists only when something has
   * been ignored — hence `:empty` in the stylesheet, so an empty footer does not
   * leave a hairline under the last finding.
   */
  function renderFooter(dismissed: readonly LintFinding[]): void {
    clear(footer)
    if (!dismissed.length) return

    const list = el("div", { class: "de-lint-ignored-body", hidden: !showIgnored }, dismissed.map(ignoredRow))
    const disclosure = el(
      "button",
      {
        class: "de-lint-ignored-summary",
        type: "button",
        "aria-expanded": String(showIgnored),
        "data-de-lint": "show-ignored",
        onclick: () => {
          showIgnored = !showIgnored
          list.hidden = !showIgnored
          disclosure.setAttribute("aria-expanded", String(showIgnored))
        },
      },
      [
        el("span", { class: "de-lint-twisty", "aria-hidden": "true" }, [
          icon("ChevronRight", tokens.icon.marker),
        ]),
        `Show ignored (${dismissed.length})`,
      ]
    )
    footer.append(el("div", { class: "de-lint-ignored" }, [disclosure, list]))
  }

  function empty(text: string): HTMLElement {
    return el("div", { class: "de-empty" }, [text])
  }

  /**
   * The SHAPE of the answer, while the answer is still being fetched.
   *
   * Three boxes at the height the findings will use, breathing on a stagger so
   * the group reads as one thing waiting rather than three things blinking.
   *
   * `aria-hidden`, with the announcement left to the button's own label: a
   * screen reader wants "Auditing", not a description of three grey rectangles.
   */
  function skeletonRows(): HTMLElement {
    return el(
      "div",
      { class: "de-lint-skeleton", "aria-hidden": "true" },
      [0, 1, 2].map(() => el("div", { class: "de-lint-skeleton-row" }))
    )
  }

  /**
   * What the list says when it has no rows, and it is four different answers.
   *
   * Never audited, audited and clean, everything dismissed, and no checker
   * available are four different states of the world, and one "nothing here"
   * for all of them is how a user concludes the feature is broken when it is
   * telling them they have nothing to fix.
   */
  function emptyState(dismissed: number): HTMLElement {
    if (lintToolsLoaded() && !lintTools().some((tool) => tool.available)) {
      /*
       * The one state that still spends words on a checker's own reason.
       *
       * Everywhere else the reasons are behind the header icon, because nobody
       * asked. Here they ARE the answer to the only question on the screen —
       * the section can do nothing and the reader is owed why — so the
       * unavailable ones say so in full, in the space the findings would have
       * taken. Joined rather than listed, since there are three of them at most.
       */
      return empty(
        `No checker fits this project. ` +
          lintTools()
            .map((tool) => `${tool.name}: ${tool.reason}`)
            .join(" ")
      )
    }
    /*
     * Three grey rows where the findings will be, rather than a sentence where
     * they will not.
     *
     * `empty()` prints a line of prose into the middle of the panel — which for
     * every other empty state here is right, because those are answers. This
     * one is not an answer, it is a gap, and the useful thing to say about a gap
     * is its SHAPE: rows, at row height, in the place the findings are about to
     * land. The count is three because it is enough to read as a list and few
     * enough not to promise a number the audit has not returned yet.
     */
    if (lintRunState() === "running") return skeletonRows()
    // The first state a designer meets, so it says what an audit looks for as
    // well as what to press. One sentence, like its three siblings: the Audit
    // button is directly above, and Fix explains itself on the rows it lands on.
    if (!lintRanAt()) {
      return empty("Audit finds hard-coded values that should use design tokens.")
    }
    // The control that acts on this number is one line below, in the footer,
    // and the sentence used to give the count without naming it — a reader told
    // that three things are hidden and not told what hides them reads it as a
    // statistic rather than as a door.
    if (dismissed) {
      return empty(
        `No open issues. ${issueWord(dismissed)} ignored. See “Show ignored” below.`
      )
    }
    return empty("No design-system issues found.")
  }

  /**
   * Everything the rebuilt view depends on, as three numbers.
   *
   * Two of them come from the store and one is this panel's own. Nothing here
   * walks the findings, which is the point: `render` is called from every
   * editor invalidation, and a digest of five thousand rows computed per frame
   * would be a worse cost than the rebuild it is avoiding.
   *
   * The ticks are NOT in it. A tick repaints in place (`paintSelection`) so the
   * checkbox keeps focus, and counting ticks here made the next unrelated
   * render — a canvas click, a tool list landing — rebuild the list and drop
   * that focus to the body anyway.
   */
  function signature(): string {
    return [lintVersion(), lintResolutionEpoch(), showIgnored ? 1 : 0].join("|")
  }

  function render(): void {
    if (signature() === painted) return

    /*
     * The findings list repaints under a reader who is working through it —
     * every tick, every ignore, every re-run — and `clear(body)` below would
     * otherwise hand them back the top of the list each time. `core/scroll.ts`
     * carries why an emptied scroller loses its offset at all.
     */
    const hold = holdScroll(node)

    const findings = lintFindings()
    const dismissed = ignoredFindings()

    // A tick on a row that has been fixed, ignored or re-run away is a tick on
    // nothing, and it would keep counting towards "Fix 3".
    const live = new Set(findings.map((finding) => finding.id))
    for (const id of [...checked]) if (!live.has(id)) checked.delete(id)

    painted = signature()
    const summary = lintSummary()

    paintRunState()
    paintCheckers()

    clear(summaryLine)
    if (lintRanAt() || summary.total) {
      summaryLine.append(
        [
          issueWord(summary.total),
          plural(summary.errors, "error"),
          plural(summary.warnings, "warning"),
          `${formatCount(summary.onPage)} on this page`,
        ].join(" · ")
      )
    }

    clear(body)
    rows = new Map()
    const failure = lintRunState() === "error" ? lintError() : null
    // Written only when it changes: `errorLine` is a live region, and re-setting
    // the same sentence on the next beat would announce the failure twice.
    if ((errorLine.textContent || null) !== failure) errorLine.textContent = failure ?? ""
    errorLine.hidden = !failure
    if (findings.length) {
      for (const group of byRule(findings)) {
        const built = group.rows.map((finding) => {
          const row = findingRow(finding)
          rows.set(finding.id, row)
          return row
        })
        body.append(
          el("div", { class: "de-lint-group" }, [
            /*
             * The heading says the problem; the rule id stays in `title`.
             *
             * This is the other half of shortening the row. A row can only drop
             * "is a hardcoded colour with no matching token" if something above
             * it has already said "Hardcoded colours" — otherwise the list is
             * concise and unreadable, which is worse than long. The id is one
             * hover away for anyone who has to go and configure the rule, and a
             * rule this editor has no wording for keeps its id verbatim rather
             * than being renamed by guesswork. See `plain.ts`.
             */
            el("div", { class: "de-lint-group-head" }, [
              el("span", { class: "de-lint-group-rule", title: group.rule }, [
                ruleTitle(group.rule),
              ]),
              el("span", { class: "de-lint-group-count" }, [String(group.rows.length)]),
            ]),
            ...built,
          ])
        )
      }
    } else if (!failure) {
      body.append(emptyState(dismissed.length))
    }

    renderControls(findings)
    renderFooter(dismissed)
    paintSelection()
    // Last: the controls and the footer are part of this section's height, and
    // releasing before they are back would clamp against a column that is one
    // row short of the one the reader will see.
    hold.release()
  }

  /*
   * The mirror of the row's own hover: the pointer is on a BADGE.
   *
   * This is why `.de-lint-row--active` exists rather than the list leaning on
   * CSS `:hover` — a badge hovered on the page has to light a row in a panel
   * the pointer is nowhere near, and no selector can express that.
   */
  window.addEventListener(MARKER_HOVER_EVENT, (event) => {
    const detail = (event as CustomEvent<{ id: string | null; ids?: string[] }>).detail
    const id = detail?.id ?? null
    /*
     * Every finding the badge covers, not only the one it speaks for.
     *
     * A badge collapses the findings on one element — a card with a hardcoded
     * colour and an undeclared token is two rows and one badge — so lighting
     * only the worst of them would answer "which row is this?" with one of the
     * several the pointer is actually over. `id` alone is still honoured,
     * because that is the shape the annotation seam this copies has.
     */
    const lit = new Set(detail?.ids?.length ? detail.ids : id ? [id] : [])
    for (const [key, row] of rows) row.classList.toggle(ROW_ACTIVE, lit.has(key))
    if (!id) return
    rows.get(id)?.scrollIntoView?.({ block: "nearest", behavior: smoothScroll() })
  })

  subscribeToLint(() => render())

  function update(): void {
    // The tool list is asked for on first paint rather than at boot, for the
    // reason the libraries panel gives about its own: a request on every page
    // load, for a feature most sessions never open, is a cost everyone pays for
    // a few.
    if (!requested) {
      requested = true
      void loadLintTools(editor.apiBase).then(() => render())
    }
    render()
  }

  return { node, update }
}
