/**
 * The browser half of the interfaces.dev cheat-sheet review page.
 *
 * Bundled — never run — by `tools/cheatsheet-demo.mjs`, once against the
 * working tree and once against a snapshot of the tree as it was before this
 * pass. The two bundles are each other's before and after.
 *
 * ## The one constraint that shapes this file
 *
 * It must compile against BOTH trees. So it may import only things both have:
 * `shellCss`, `toasterCss`, `icon`, `el`, `tokens`. Nothing added by this pass —
 * `arriveFrom`, `type.measure` — may be named here, or the before build fails
 * and the page loses the column that is the whole point of it.
 *
 * ## Why the markup is written here rather than driven out of the panels
 *
 * `tools/chrome-demo.mjs` stands up real installers, and that is the right tool
 * when the thing being compared is a panel's behaviour. Nearly everything on
 * this page is a STYLESHEET delta on a class — a hover plate, a focus ring, a
 * corner, a padding, a keyframe's origin. Standing up an editor, a bridge, a
 * host app and a dev server to arrive at a `.de-button` would put four hundred
 * lines of scaffolding between the reader and the two pixels that changed, and
 * every one of those lines is a place the two columns could differ for a reason
 * that is not the finding.
 *
 * The honesty this trades away is bounded and stated: ONE scene file builds
 * BOTH columns, so the markup is identical by construction and only the
 * stylesheet differs. What it cannot prove is that the product emits this
 * markup — for that, the class names below are the contract, and each scene
 * names the source file it was read from.
 */

import { shellCss } from "../src/core/css"
import { toasterCss } from "../src/core/css/toast"
import { el } from "../src/core/dom"
import { icon } from "../src/core/icons"
import { tokens } from "../src/core/tokens"

/* ---------- the ground every scene is mounted on ---------- */

/**
 * The chrome's stylesheet, the theme attribute, and a page under it.
 *
 * `page` is the app being edited — a colour the editor does not choose and
 * cannot tune. Several findings here are only visible against one: an opaque
 * overlay, a shadow with no ring, a marquee over live content.
 */
function ground(theme, page) {
  const style = document.createElement("style")
  style.textContent = shellCss
  document.head.append(style)
  document.documentElement.setAttribute("data-de-theme", theme)
  document.documentElement.setAttribute("data-designlayer", "")
  document.body.style.background = page ?? (theme === "light" ? "#f4f4f5" : "#18181b")
}

/** A panel-shaped box to hang panel-shaped chrome inside. */
function panel(width = 260) {
  const host = el("div", { class: "de-panel de-panel--right" })
  host.style.cssText = `width:${width}px;padding:12px;display:flex;flex-direction:column;gap:12px`
  document.body.append(host)
  return host
}

/* ---------- the scenes ---------- */

/**
 * The shared text button, at rest and with a glyph.
 *
 * Source: `.de-button` in `css/toolbar.ts`; call sites in `lint/panel.ts` and
 * `inspector/tab-annotations.ts`. Two findings ride on this one shot — the
 * press scale, which the driver holds the mouse down for, and the icon-side
 * padding, which is visible at rest.
 */
export function buttons(theme) {
  ground(theme)
  const host = panel(300)
  host.append(
    el("div", { class: "de-row", style: "display:flex;gap:8px;align-items:center" }, [
      el("button", { class: "de-button", type: "button", id: "glyph-button" }, [
        icon("Search", tokens.icon.marker),
        "Audit",
      ]),
      el("button", { class: "de-button", type: "button", id: "plain-button" }, ["Ignore"]),
    ]),
    el("div", { class: "de-row", style: "display:flex;gap:8px;align-items:center" }, [
      el("button", { class: "de-button", type: "button" }, [
        icon("MessageSquare", tokens.icon.marker),
        "Send to agent",
      ]),
    ]),
    el("div", { style: "display:flex;gap:2px;align-items:center" }, [
      el("button", { class: "de-mini", type: "button", "aria-label": "Add" }, [
        icon("Plus", tokens.icon.marker),
      ]),
      el("button", { class: "de-mini", type: "button", "aria-label": "Remove" }, [
        icon("Trash", tokens.icon.marker),
      ]),
    ])
  )
  return { hold: "#glyph-button" }
}

/**
 * A native `<select>` and a text field, reached by keyboard.
 *
 * Source: `.de-select` in `css/panels.ts`. The driver tabs onto the select so
 * `:focus-visible` really matches — forcing the class would prove nothing about
 * a rule keyed on a pseudo the browser owns.
 */
export function selectFocus(theme) {
  ground(theme)
  const host = panel(260)
  const field = el("div", { class: "de-field-row", style: "display:flex;flex-direction:column;gap:6px" }, [
    el("label", { class: "de-field-label", for: "weight" }, ["Font weight"]),
    el(
      "select",
      { class: "de-select", id: "weight" },
      ["Regular", "Medium", "Semibold"].map((w) => el("option", {}, [w]))
    ),
  ])
  host.append(field)
  return { tabTo: "#weight" }
}

/**
 * Two lint findings, one of each severity.
 *
 * Source: `.de-lint-row--error` / `--warning` and `.de-lint-dot` in
 * `css/lint.ts`; the row is built by `lint/panel.ts`. The driver also shoots
 * this through a deuteranopia filter, which is where the finding lives: the two
 * severities used to be one shape in two hues.
 */
export function lintRows(theme) {
  ground(theme)
  const host = panel(300)
  const row = (severity, snippet, where) =>
    el("div", { class: `de-lint-row de-lint-row--${severity}` }, [
      el("span", { class: "de-lint-dot", "aria-hidden": "true" }),
      el("button", { class: "de-lint-select", type: "button" }, [
        el("span", { class: "de-lint-headline" }, [
          el("span", { class: "de-lint-literal de-lint-literal--found" }, [
            el("span", { class: "de-lint-literal-text" }, [snippet]),
          ]),
        ]),
        el("span", { class: "de-lint-where" }, [
          el("span", { class: "de-lint-where-file" }, [where]),
          el("span", { class: "de-lint-where-line" }, [":42"]),
        ]),
      ]),
    ])
  const list = el("div", { class: "de-lint" }, [
    row("error", "#1f2937", "Card.tsx"),
    row("warning", "14px", "Card.tsx"),
    row("error", "rgba(0,0,0,.4)", "Sheet.tsx"),
  ])
  host.append(list)
  return {}
}

/**
 * The drag marquee over live product content.
 *
 * Source: `.de-marquee` in `css/canvas.ts`. The content underneath is the
 * point: the fill used to be opaque, so the box covered exactly what the drag
 * was selecting.
 */
export function marquee(theme) {
  ground(theme, theme === "light" ? "#ffffff" : "#0f0f10")
  const page = el("div", {
    style:
      "position:relative;width:420px;height:230px;padding:20px;" +
      `color:${theme === "light" ? "#18181b" : "#f4f4f5"};` +
      "font:400 15px/1.55 ui-sans-serif,-apple-system,sans-serif",
  })
  page.append(
    el("h3", { style: "margin:0 0 6px;font-size:19px" }, ["Weekly digest"]),
    el("p", { style: "margin:0 0 14px;opacity:0.72" }, ["Five links every Friday, no filler."]),
    el(
      "div",
      { style: "display:flex;gap:8px" },
      ["Subscribe", "Read archive"].map((label) =>
        el(
          "span",
          {
            style:
              "padding:7px 13px;border-radius:8px;font-size:13px;" +
              (label === "Subscribe"
                ? "background:#2563eb;color:#fff"
                : `border:1px solid ${theme === "light" ? "#d4d4d8" : "#3f3f46"}`),
          },
          [label]
        )
      )
    )
  )
  const box = el("div", { class: "de-marquee" })
  box.style.cssText = "position:absolute;left:12px;top:12px;width:300px;height:150px"
  page.append(box)
  document.body.append(page)
  return {}
}

/**
 * The collapsed launcher, which is the whole editor when nothing is open.
 *
 * Source: `.de-launcher` in `css/launcher.ts` and `shadow.float` in `tokens.ts`.
 * Shot against a page whose colour is near the chrome's own, which is the case
 * a single-layer cast cannot draw an edge in.
 */
export function launcher(theme, page) {
  ground(theme, page)
  /*
   * The disc is parked at the end of its own exit — `visibility: hidden`, zero
   * opacity — until the shell hides the chrome, which is the state it exists
   * for. `html.designlayer-chrome-hidden` is the real selector that reveals
   * it (`css/launcher.ts`), so the scene sets the real class rather than
   * overriding the three properties by hand: an override would also have to
   * guess the resting transform, and a disc shot at the wrong scale is not the
   * disc.
   */
  document.documentElement.classList.add("designlayer-chrome-hidden")
  const disc = el("button", { class: "de-launcher", type: "button", "aria-label": "Open the editor" }, [
    icon("Cursor", tokens.icon.chrome),
  ])
  // Placed inline rather than fixed so the shot can crop tight around it.
  disc.style.cssText += ";position:relative;right:auto;bottom:auto;margin:30px"
  document.body.append(disc)
  return {}
}

/**
 * A toast, with its close button and its action.
 *
 * Source: the vendored sheet in `css/sonner-css.ts` and the override sheet in
 * `css/toast.ts`. Mounted in a shadow root because that is where the real one
 * lives — custom properties inherit through the boundary and ordinary rules do
 * not, which is the whole reason the override file exists.
 *
 * The DOM shape is Sonner's own attribute contract rather than a guess:
 * `[data-sonner-toaster][data-sonner-theme]`, `[data-sonner-toast][data-styled]`,
 * `[data-close-button]`, `[data-button]`.
 */
export function toast(theme) {
  ground(theme)
  const host = el("div", {})
  host.style.cssText = "padding:24px"
  document.body.append(host)
  const shadow = host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = toasterCss
  shadow.append(style)

  const toaster = document.createElement("section")
  toaster.setAttribute("data-sonner-toaster", "")
  toaster.setAttribute("data-sonner-theme", theme)
  toaster.setAttribute("data-theme", theme)
  toaster.setAttribute("data-rich-colors", "true")
  toaster.style.cssText = "position:relative;inset:auto;width:360px"

  const card = document.createElement("li")
  card.setAttribute("data-sonner-toast", "")
  card.setAttribute("data-styled", "true")
  card.setAttribute("data-type", "error")
  card.setAttribute("data-mounted", "true")
  card.setAttribute("data-expanded", "true")
  card.style.cssText = "position:relative;transform:none;opacity:1"

  const close = document.createElement("button")
  close.setAttribute("data-close-button", "true")
  close.setAttribute("aria-label", "Close")
  close.id = "close"
  close.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.5"><line x1="18" y1="6" x2="6" y2="18"/>' +
    '<line x1="6" y1="6" x2="18" y2="18"/></svg>'

  const title = document.createElement("div")
  title.setAttribute("data-title", "")
  title.textContent = "Could not write Card.tsx — the snippet has moved."

  const action = document.createElement("button")
  action.setAttribute("data-button", "")
  action.id = "action"
  action.textContent = "Retry"

  card.append(close, title, action)
  toaster.append(card)
  shadow.append(toaster)
  return { shadowHover: "#close", shadowFocus: "#action" }
}

/**
 * A popover caught mid-entrance, above its trigger.
 *
 * Source: `@keyframes de-arrive` in `css/base.ts`. The frame is real: the
 * animation is the shipped one, paused with a negative delay, so what is on
 * screen is the browser's own interpolation at that instant and not a pose
 * drawn to look like one.
 *
 * The trigger is drawn BELOW the card on purpose. Three of the four surfaces
 * using this entrance flip above their trigger when dropping down would overrun
 * the viewport, and that is the case the origin was wrong for.
 */
export function arriveAbove(theme) {
  ground(theme)
  const wrap = el("div", { style: "position:relative;width:320px;height:230px;padding:16px" })
  const card = el("div", { class: "de-app-menu de-arrive" })
  card.style.cssText =
    "position:absolute;left:16px;top:16px;width:250px;padding:6px;" +
    "animation-delay:-58ms;animation-play-state:paused"
  /*
   * The property the placer writes at run time, written here by hand, because a
   * scene cannot call `arriveFrom` — that export does not exist in the before
   * tree. The before stylesheet has no `var()` reading it, so this line is
   * inert there and the column shows the old behaviour, which is correct.
   */
  card.style.setProperty("--de-arrive-origin", "center bottom")
  card.style.setProperty("--de-arrive-rise", "3px")
  for (const [name, where] of [
    ["shop-web", "~/Projects/shop-web"],
    ["docs", "~/Projects/docs"],
  ]) {
    card.append(
      el("div", { class: "de-app-menu-row" }, [
        el("span", { class: "de-app-menu-name" }, [name]),
        el("span", { class: "de-app-menu-where" }, [where]),
      ])
    )
  }
  const trigger = el("button", { class: "de-button", type: "button" }, ["shop-web"])
  trigger.style.cssText += ";position:absolute;left:16px;top:180px"
  wrap.append(card, trigger)
  document.body.append(wrap)
  return {}
}

/**
 * A glyph caught halfway through turning into a tick.
 *
 * Source: `.de-swap` in `css/annotations.ts`, built by `core/swap-mark.ts`. The
 * frame is taken during a real CSS transition rather than posed, which is the
 * only way to see the thing the finding is about — two drawings on screen at
 * once.
 */
export function swap(theme) {
  ground(theme)
  /*
   * No panel and no button — just the box, magnified.
   *
   * The finding is sixteen pixels across and it is about what two stacked
   * drawings look like at the midpoint of a crossfade, so everything around it
   * is noise the shot cannot afford. `zoom` rather than `transform: scale`
   * because zoom scales the RASTER, blur included, which is the one property
   * being compared.
   */
  const box = el("span", { class: "de-swap" }, [])
  const rest = icon("Copy", tokens.icon.marker)
  const done = icon("Check", tokens.icon.marker)
  rest.classList.add("de-swap-rest")
  done.classList.add("de-swap-done")
  box.append(rest, done)
  box.style.zoom = "6"
  document.body.append(box)
  return { swap: ".de-swap" }
}

/**
 * The inspector's empty state and a note, in a panel dragged wide.
 *
 * Source: `.de-empty` in `css/panels.ts` and `.de-opt-note` in `css/options.ts`.
 * 760px is inside what `size.panelMax` allows on a 2560px display, which is the
 * width at which an uncapped line runs past 150 characters.
 */
export function measure(theme) {
  ground(theme)
  const host = panel(760)
  host.append(
    el("div", { class: "de-empty" }, [
      "Nothing is selected. Click an element on the page to see the styles it resolves to, " +
        "the tokens behind them, and every place in the source they are written.",
    ]),
    el("p", { class: "de-opt-note" }, [
      "These controls come from the app's own leva panel. Changing one here writes the same " +
        "value the panel would, and the default can be persisted back into the source file it " +
        "was read from.",
    ])
  )
  return {}
}

/**
 * The native furniture `color-scheme` governs: a scrollbar, a checkbox, a
 * search field's clear button.
 *
 * Source: the `color-scheme` rule in `css/base.ts` and
 * `.de-opt-filter::-webkit-search-cancel-button` in `css/options.ts`. Shot in
 * the LIGHT theme, where the old unconditional `filter: invert(1)` turned the
 * agent's dark ✕ white on a white field.
 *
 * The checkbox is a BARE one, and it used to wear `.de-ann-setting--check` —
 * the settings block's hand-drawn box, which is `appearance: none` and
 * therefore the one checkbox in the shell `color-scheme` had no say over. That
 * class is gone (the settings rows are all switches now) and the scene is
 * better for it: what this shot is for is the furniture the UA draws.
 */
export function nativeFurniture(theme) {
  ground(theme)
  const host = panel(300)
  const search = el("input", { class: "de-opt-filter", type: "search", id: "filter" })
  search.value = "hover"
  const scroller = el("div", { class: "de-opt-body" })
  scroller.style.cssText = "height:120px;overflow-y:scroll"
  for (let i = 0; i < 14; i += 1) {
    scroller.append(el("div", { class: "de-opt-row" }, [`Overview.Hover.control-${i + 1}`]))
  }
  host.append(
    search,
    el("label", { class: "de-ann-setting", style: "display:flex;gap:8px" }, [
      el("input", { type: "checkbox", checked: "" }),
      "Clear on copy or send",
    ]),
    scroller
  )
  return {}
}

/**
 * The eight resize handles on an element too thin to separate them.
 *
 * Source: `HANDLES` and the suppression in `canvas/selection.ts`, drawn by
 * `.de-handle` / `.de-handle-hit` in `css/canvas.ts`. The hit boxes are
 * `pointer-events` targets with no paint of their own, so the scene outlines
 * them — the overlap is the finding and it is invisible in the shipped drawing.
 *
 * Built here rather than driven through `installSelectionFrame`, because the
 * frame needs a live selection over a host element and a rAF loop, and what is
 * being compared is one boolean per handle. The suppression rule is re-stated
 * from the module under test, which is the honest cost of that: it is asserted
 * against the real one in `test/selection-shell-cases.mjs`.
 */
export function handles(theme, page) {
  ground(theme, page ?? "#ffffff")
  const HIT = 13
  const HANDLES = [
    ["nw", 0, 0], ["n", 0.5, 0], ["ne", 1, 0], ["e", 1, 0.5],
    ["se", 1, 1], ["s", 0.5, 1], ["sw", 0, 1], ["w", 0, 0.5],
  ]
  const W = 10
  const H = 64
  // Sized to the shot rather than to a page: the element and its eight target
  // boxes are the whole subject, and 20px of margin around them is enough to
  // see that nothing is clipped.
  const wrap = el("div", { style: "position:relative;width:120px;height:110px" })
  const left = 55
  const top = 23

  // The element being selected: a sliver, which is the case that breaks.
  const target = el("div", {
    style:
      `position:absolute;left:${left}px;top:${top}px;width:${W}px;height:${H}px;` +
      "background:#c7d2fe",
  })
  const outline = el("div", { class: "de-outline" })
  outline.style.cssText =
    `position:absolute;display:block;left:0;top:0;width:${W}px;height:${H}px;` +
    `transform:translate(${left}px, ${top}px)`
  wrap.append(target, outline)

  const narrow = W < HIT
  const short = H < HIT
  for (const [id, fx, fy] of HANDLES) {
    const horizontalMiddle = fx === 0.5 && W < 24
    const verticalMiddle = fy === 0.5 && H < 24
    // The clause under test. Absent in the before tree, so every corner draws.
    const crowded = hasCrowdRule() && ((narrow && fx === 1) || (short && fy === 1))
    if (horizontalMiddle || verticalMiddle || crowded) continue
    const x = left + W * fx
    const y = top + H * fy
    const hit = el("div", { class: "de-handle-hit" })
    hit.style.cssText =
      `position:absolute;left:${x - HIT / 2}px;top:${y - HIT / 2}px;` +
      `width:${HIT}px;height:${HIT}px;` +
      // The hit box, made visible. It is the thing that overlaps.
      "outline:1px dashed rgba(220,38,38,0.9);outline-offset:-1px;background:rgba(220,38,38,0.10)"
    const mark = el("div", { class: "de-handle" })
    mark.style.cssText =
      "position:absolute;left:50%;top:50%;width:7px;height:7px;margin:-3.5px 0 0 -3.5px"
    hit.append(mark)
    wrap.append(hit)
  }
  document.body.append(wrap)
  return {}
}

/*
 * Whether this build suppresses the crowded corners.
 *
 * The scene draws the handles itself, so it cannot ask `selection.ts` — and it
 * must compile against both trees, where one of them has no such rule to ask
 * about. Reading the module would fail the before build outright.
 *
 * So the driver tells it, through a global set before the scene runs. Read as a
 * FUNCTION rather than captured in a `const`: a module-level constant is
 * evaluated when the bundle is injected, which is before the driver has had a
 * chance to set anything — measured exactly that way, with both columns drawing
 * six handles and reporting the same overlap.
 */
const hasCrowdRule = () => typeof window !== "undefined" && window.__deCrowdRule === true

/**
 * The keyboard's first stop in the chrome, focused.
 *
 * Source: `.de-escape` in `css/base.ts`, built in `shell/shell.ts`. Before the
 * change there is no such control at all, so the before column is an empty
 * frame — which is the finding rather than a rendering failure, and the probe
 * says so in words.
 */
export function escapeStop(theme, page) {
  ground(theme, page ?? "#f4f4f5")
  const root = el("div", { class: "de-root" })
  root.style.cssText = "position:relative;width:520px;height:120px"
  document.body.append(root)

  /*
   * THE CONTROL IS ONLY BUILT WHERE THE STYLESHEET KNOWS ABOUT IT.
   *
   * Building it unconditionally is what the first version of this scene did,
   * and it produced a before column showing an unstyled button — which is a
   * lie in the most expensive direction: it says the control existed and merely
   * looked wrong, when in fact there was no way out of the chrome at all.
   *
   * `shellCss` is the shipped stylesheet of whichever tree built this bundle,
   * so asking it whether `.de-escape` has a rule is asking the build itself.
   * That is also the right question rather than a proxy for it: a control with
   * no rule is a full-size button sitting over the app, which is precisely why
   * it could not have been added without one.
   */
  if (!shellCss.includes(".de-escape")) {
    return { absent: true }
  }

  const button = el("button", { class: "de-escape", type: "button" }, [
    "Hide the editor and return to the page",
  ])
  root.append(button)
  // Focused for real rather than by adding a class: `.de-escape:focus` is the
  // rule under test, and a class would prove only that the scene can add one.
  button.focus()
  return { focused: ".de-escape" }
}

/**
 * The inspector's Position section: two fields in one group, two groups in a
 * stack.
 *
 * Source: `.de-row--split` in `css/panels.ts` against `.de-section-body`'s own
 * gap. The whole finding is which of the two distances is larger, so the scene
 * draws both and the probe measures them.
 */
export function rowGap(theme) {
  ground(theme)
  const host = panel(260)
  const field = (label, value) =>
    el("label", { class: "de-field" }, [
      el("span", { class: "de-field-label" }, [label]),
      el("input", { class: "de-input", value, readonly: "" }),
    ])
  const group = (title, a, b) =>
    el("div", { class: "de-section" }, [
      el("div", { class: "de-section-head" }, [el("span", { class: "de-section-title" }, [title])]),
      el("div", { class: "de-section-body" }, [
        el("div", { class: "de-row de-row--split", id: title.toLowerCase() }, [a, b]),
      ]),
    ])
  host.append(
    group("Position", field("X", "240"), field("Y", "112")),
    group("Size", field("W", "320"), field("H", "180"))
  )
  return {}
}

/* ---------- what the page reports that a screenshot cannot ---------- */

const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const luminance = (rgb) => 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2])

/**
 * A computed colour as three sRGB channels in 0..1.
 *
 * TWO FORMATS, because Chromium returns both and they are not the same numbers.
 * `getComputedStyle` gives `rgb(255, 255, 255)` for an authored hex and
 * `color(srgb 0.94 0.94 0.94)` for anything that went through a `color-mix` —
 * which is most of this palette. Reading the second as 0..255 makes every mixed
 * colour come out as near-black, so a white-on-white pair reported 1.2:1 and a
 * real failure would have been reported as a pass. The scale is decided by the
 * FUNCTION NAME, not by the magnitude of the numbers, because 1 is a legal
 * value in both.
 */
const parse = (value) => {
  const parts = (value.match(/[\d.]+/g) ?? []).map(Number)
  const channels = /^color\(/.test(value.trim()) ? parts.slice(0, 3) : parts.slice(0, 3).map((n) => n / 255)
  return channels.length === 3 ? channels : [0, 0, 0]
}

const alphaOf = (value) => {
  const parts = (value.match(/[\d.]+/g) ?? []).map(Number)
  return parts.length >= 4 ? parts[3] : 1
}

/**
 * A translucent colour resolved against what is behind it.
 *
 * A focus ring at `rgba(0, 0, 0, 0.4)` is not black — it is 40% of black over
 * whatever it is drawn on, and measuring the authored value instead of the
 * composite is how a ring gets reported as failing far worse than it does.
 */
const over = (fg, bg) => {
  const a = alphaOf(fg)
  if (a >= 1) return parse(fg)
  const [f, b] = [parse(fg), parse(bg)]
  return [0, 1, 2].map((i) => f[i] * a + b[i] * (1 - a))
}

/**
 * WCAG contrast between two computed colour strings, to two decimals.
 *
 * The first is composited over the second, so a translucent foreground is
 * measured as it is painted rather than as it is written.
 */
export function ratio(a, b) {
  const [x, y] = [luminance(over(a, b)), luminance(parse(b))]
  return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100
}

window.__cheatsheet = {
  buttons,
  handles,
  escapeStop,
  rowGap,
  selectFocus,
  lintRows,
  marquee,
  launcher,
  toast,
  arriveAbove,
  swap,
  measure,
  nativeFurniture,
  ratio,
}
