/**
 * Concentric corners: the guard that keeps the chrome's nested radii honest.
 *
 * Two rounded rectangles, one inside the other, share a centre only if the
 * inner radius is the outer one minus the gap between them. `nest()` in
 * `src/core/tokens.ts` is the only implementation of that rule, and it runs
 * while the stylesheet is being built — so an inset that lands off the radius
 * ramp already fails `npm run build`. This file covers the three things that
 * cannot be caught from inside the function:
 *
 *  1. that the arithmetic is right, including the clamp and the throws;
 *  2. that the CSS actually EMITTED matches what each nest declared — a nest
 *     computed correctly and then not used is the obvious way for this to rot;
 *  3. that no container has quietly appeared which could put a rounded child in
 *     one of its corners without anyone deciding whether it does.
 *
 * (3) is the part that makes this hold over time rather than today. It is not a
 * snapshot of the whole stylesheet — that would fail on every unrelated padding
 * change and get deleted within a month. It fails only for a container whose
 * geometry lets a corner be SHARED: two of its paddings agreeing, so a child can
 * sit the same distance from both edges. Anything else is beside a corner rather
 * than in it, and has no curve to be parallel to.
 *
 * There is a second half to this check that no test can run: whether the
 * elements the stylesheet describes are laid out the way each nest assumed.
 * `tools/concentric-audit.mjs` measures that in a real browser, and is a tool
 * rather than a case because the package does not depend on one.
 */

import assert from "node:assert/strict"

import { PACKAGE_DIR } from "./host.mjs"

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

async function loadChrome() {
  const { build } = await import("esbuild")
  const bundled = await build({
    stdin: {
      contents: `
        export { tokens, nest, declaredNests } from "./src/core/tokens"
        export { shellCss } from "./src/core/css"
      `,
      resolveDir: PACKAGE_DIR,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  )
}

const chrome = await loadChrome()
const { tokens, nest, declaredNests, shellCss } = chrome
const RAMP = Object.values(tokens.radius)

/**
 * The chrome's nests, taken before this file builds any of its own.
 *
 * `nest()` records every nest it builds so the guard below can find them
 * without the modules having to export a list each. That register is a live
 * array and the arithmetic cases further down call `nest()` dozens of times, so
 * it has to be copied HERE — at import time, when the only thing that has run
 * is the stylesheet.
 */
const NESTS = [...declaredNests()]

/** Rules as `{ selector, declarations }`, comments stripped so they cannot match. */
function rules(css) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const out = []
  for (const [, selector, body] of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: selector.trim().replace(/\s+/g, " "), body })
  }
  return out
}

const declaration = (body, property) => {
  const found = body.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`))
  return found ? found[1].trim() : null
}

const ALL = rules(shellCss)

/**
 * The one rule for a selector that DRAWS its corner.
 *
 * A selector gets several rules in this sheet — `.de-toolbar` has four, three
 * of which only set a transform, a transition, or a motion opt-out. Taking the
 * first match read the corner off whichever of those happened to be emitted
 * earliest, which is a false negative that moves when an unrelated rule is
 * reordered. The rule that declares `border-radius` is the one a nest is about,
 * and there must be exactly one of it or "the container's padding" is not a
 * question with an answer.
 */
function cornerRule(selector) {
  const drawn = ALL.filter((r) => r.selector === selector && declaration(r.body, "border-radius"))
  assert.equal(
    drawn.length,
    1,
    `${selector} has ${drawn.length} rules declaring a border-radius; a nest needs exactly one`
  )
  return drawn[0]
}

// ── The rule itself ────────────────────────────────────────────────────────

console.log("\nThe offset rule")

check("an inner radius is the outer one less the gap between the curves", () => {
  assert.equal(nest({ of: "t", outer: "16px", inset: 4 }).radius, "12px")
  assert.equal(nest({ of: "t", outer: "12px", inset: 4 }).radius, "8px")
  assert.equal(nest({ of: "t", outer: "8px", inset: 4 }).radius, "4px")
  assert.equal(nest({ of: "t", outer: "12px", inset: 8 }).radius, "4px")
  assert.equal(nest({ of: "t", outer: "26px", inset: 4 }).radius, "22px")
})

check("a corner eroded to nothing squares off, and never rounds back", () => {
  /*
   * The edge case from the derivation, and the one a naive implementation gets
   * wrong in a way that looks deliberate: subtract past zero, take the absolute
   * value, and a child starts getting ROUNDER the more you pad it. Clamped, so
   * once the inset reaches the radius the corner is simply square and stays so.
   */
  assert.equal(nest({ of: "t", outer: "8px", inset: 8 }).radius, "0px")
  assert.equal(nest({ of: "t", outer: "8px", inset: 12 }).radius, "0px")
  assert.equal(nest({ of: "t", outer: "4px", inset: 36 }).radius, "0px")
})

check("the container's own hairline counts toward the gap", () => {
  /*
   * The bug this whole file exists for. `border-radius` is measured on the
   * OUTER edge, so a 1px border sits between the two curves exactly as padding
   * does — the toolbar declared `padding: 4px` around 12px children under a
   * 16px pill and was out by one on screen the entire time.
   *
   * The inner radius does not change when a hairline is added; the PADDING
   * shrinks to make room for it, so the gap between the curves stays put.
   */
  const bare = nest({ of: "t", outer: "16px", inset: 4 })
  const ruled = nest({ of: "t", outer: "16px", inset: 4, hairline: 1 })
  assert.equal(bare.radius, ruled.radius)
  assert.equal(bare.padding, "4px")
  assert.equal(ruled.padding, "3px")
})

check("an inset that lands between two steps of the ramp is refused", () => {
  /*
   * Refused rather than rounded, because there is no right direction to round
   * in: one way breaks the nest, the other breaks the scale. The two ways to
   * arrive here are a forgotten border and a padding off the spacing scale's
   * odd rungs, and the message names both.
   */
  assert.throws(() => nest({ of: ".x", outer: "16px", inset: 5 }), /not on the radius ramp/)
  assert.throws(() => nest({ of: ".x", outer: "8px", inset: 2 }), /not on the radius ramp/)
  assert.throws(() => nest({ of: ".x", outer: "12px", inset: 9 }), /not on the radius ramp/)
  assert.throws(() => nest({ of: ".x", outer: "50%", inset: 4 }), /not a length in px/)
  assert.throws(() => nest({ of: ".x", outer: "16px", inset: 0, hairline: 1 }), /smaller than/)
})

check("every nest lands on a step of the ramp, or squares off", () => {
  for (const n of NESTS) {
    assert.ok(
      n.radius === "0px" || RAMP.includes(n.radius),
      `${n.of} nests at ${n.radius}, which is not on the ramp (${RAMP.join(", ")})`
    )
    assert.ok(RAMP.includes(n.outer), `${n.of} is drawn at ${n.outer}, which is not on the ramp`)
  }
})

// ── What the stylesheet actually says ──────────────────────────────────────

console.log("\nThe chrome's nests")

/**
 * Every nest the chrome declares, pinned.
 *
 * A snapshot, so that removing a nest — or quietly slackening one — is a change
 * to this file rather than to nothing. The numbers are the whole story: the
 * container's radius, the gap to its children, and the radius that falls out.
 */
/*
 * `.de-segmented` USED TO BE IN THIS LIST, and its absence is a decision rather
 * than a deletion.
 *
 * The track carried a 4px rail and nested its segments at `radius.xs` inside a
 * `radius.sm` corner. Measured against Figma's own right panel at 2x, that rail
 * does not exist: the chosen chip's border begins on the same device column the
 * track's outer edge does, so the two curves COINCIDE instead of nesting. Both
 * are `radius.xs` now with nothing between them, and an inset of zero is not a
 * nest — it is one corner drawn twice.
 *
 * The pair is still checked, by the case below rather than by this list: a
 * segment must draw the same radius its track does, and both must be on the
 * ramp. What is no longer asserted is a gap that no longer exists.
 */
/*
 * Re-derived for the design foundations kit's radius ladder
 * (4/8/10/12/14/16/18/22/26). Its menu recipe — a 16px card, 6px padding,
 * 10px items — is concentric by construction, and both menus take it. Modals
 * take the kit's 18px dialog rung. Text buttons draw the fields' 8px corner
 * (the kit's 14px action radius is a pill at the editor's 24px), so a
 * container whose corner child is a `.de-button` leaves 8 at the corner.
 */
const EXPECTED = [
  [".de-toolbar", "16px", 4, 1, "3px", "12px"],
  /* The kit's menu: 16 − 6 = 10, the kit's menu-item rung. No hairline: the
     overlay shadow carries it as a layer. */
  [".de-app-menu", "16px", 6, 0, "6px", "10px"],
  [".de-layer-menu", "16px", 6, 1, "5px", "10px"],
  /* The composer's corner children are its 8px buttons: 16 − 8 = 8. */
  [".de-ann-composer", "16px", 8, 0, "8px", "8px"],
  /* A note row is a kit card (16) whose top-right `.de-mini` draws 8. */
  [".de-ann-item", "16px", 8, 1, "7px", "8px"],
  /* The ignored row's corner child is an 8px `.de-button`: 12 − 4 = 8. */
  [".de-lint-ignored-row", "12px", 4, 0, "4px", "8px"],
  /* The local-file drawer: its candidate rows and path field draw 8. */
  [".de-lib-panel", "12px", 4, 0, "4px", "8px"],
  /* A signed-in origin: a kit card (16) with the Forget `.de-mini` at 8. */
  [".de-lib-signed-row", "16px", 8, 1, "7px", "8px"],
  /* The shortcuts sheet: the kit's 18px dialog, with the close button in its
     top-right corner at 18 − 8 = 10. */
  [".de-shortcuts", "18px", 8, 1, "7px", "10px"],
]

check("the set of nests is the one this file was written against", () => {
  const actual = NESTS
    .map((n) => [n.of, n.outer, n.inset, n.hairline, n.padding, n.radius])
    .sort((a, b) => a[0].localeCompare(b[0]))
  assert.deepEqual(
    actual,
    [...EXPECTED].sort((a, b) => a[0].localeCompare(b[0])),
    "a nest was added, removed or retuned — check it against the container's own layout, then update EXPECTED"
  )
})

check("each container emits the padding, border and radius its nest computed", () => {
  /*
   * The gap between declaring a nest and USING it. Every value below is read
   * back out of the shipped stylesheet, because a nest that is computed
   * correctly and then not interpolated into the rule is invisible from the
   * token module's side and looks completely fine in review.
   */
  for (const n of NESTS) {
    const rule = cornerRule(n.of)

    /*
     * The padding is read from `padOn`, which is usually the container and
     * sometimes a bare wrapper inside it. Looking only at the container is what
     * made this case report `null !== "3px"` for `.de-ann-box`, a box that is
     * correctly nested and simply does not hold its own padding.
     */
    const pads =
      n.padOn === n.of ? rule : ALL.find((r) => r.selector === n.padOn)
    assert.ok(pads, `${n.of} nests via ${n.padOn}, which has no rule in the sheet`)

    /*
     * A CORNER has to be at the nest's inset, not every side.
     *
     * `.de-ann-item` pads `3px 3px 3px 7px`: a wider leading edge for the
     * species rule down its left, and the three other sides at the nest. Its
     * top-right corner is the one a child occupies and the one that has to be
     * concentric; its top-left pairs a 3 with a 7 and shares no curve, so
     * demanding a uniform shorthand there would be demanding a design change to
     * satisfy a checker. What must hold is that SOME corner is formed at the
     * declared inset — otherwise the nest describes a distance the box never
     * actually puts between itself and anything.
     */
    const declaredPad = declaration(pads.body, "padding")
    assert.ok(declaredPad, `${n.of} nests via ${n.padOn}, which declares no padding`)
    const want = Number.parseFloat(n.padding)
    assert.ok(
      cornerInsets(declaredPad).some((side) => side === want),
      `${n.of} nests at an inset of ${n.inset}, so ${n.padOn} must form a corner at ` +
        `${n.padding} (its border takes the other ${n.hairline}). It pads "${declaredPad}".`
    )
    assert.equal(
      declaration(rule.body, "border-radius"),
      n.outer,
      `${n.of} nests inside ${n.outer} but draws a different radius`
    )

    const border = declaration(rule.body, "border")
    const width = border ? Number.parseFloat(border) : 0
    assert.equal(
      Number.isFinite(width) ? width : 0,
      n.hairline,
      `${n.of} declares a ${n.hairline}px hairline in its nest and draws "${border}" — ` +
        `the border is part of the gap between the two curves, so these cannot disagree`
    )
  }
})

check("the radius a nest computed is the radius its children are given", () => {
  /*
   * Named children rather than a structural walk, because the CSS has no
   * structure to walk — this is the one place the pairing has to be written
   * down. Each entry is a rule that draws a corner INSIDE the container beside
   * it, and its radius must be the nest's, not a step that happens to match.
   */
  const CHILDREN = {
    ".de-toolbar": [".de-toolbar .de-tool"],
    ".de-app-menu": [".de-app-menu-row"],
    ".de-ann-composer": [".de-ann-composer-text", ".de-button"],
    /* Shared furniture again: the row's action column puts a `.de-mini` in the
       top-right corner, and `radius.xs` is what the nest asks of it. The row's
       padding was corrected to make that true rather than the button's radius,
       for the reason the `.de-lint-ignored-row` note gives below. */
    ".de-ann-item": [".de-mini"],
    ".de-layer-menu": [".de-layer-menu-row"],
    /* The drawer holds a rounded thing in all four of its corners, and two of
       the three rules that draw them are shared furniture. `.de-lib-candidate`
       is the sheet's own and sits in the top pair; `.de-lib-field` is the path
       box across the foot. `.de-button` beside it is covered by the
       `.de-lint-ignored-row` entry below, which asserts the same shared rule. */
    ".de-lib-panel": [".de-lib-candidate", ".de-lib-field"],
    /* A signed-in origin's card: the Forget `.de-mini` sits in its right
       corner, at the radius the nest asks of it. */
    ".de-lib-signed-row": [".de-mini"],
    /* The button in its corner is shared furniture — `.de-button` draws the
       fields' 8px corner, and the row is sized so that IS the nest's
       radius. Asserted against the shared rule on purpose: if `.de-button` ever
       moves, this row stops being concentric and should say so. */
    ".de-lint-ignored-row": [".de-button"],
    /* The close button is the only thing in a corner of the sheet: the header
       occupies the top edge and the body scrolls, so nothing else can reach
       one. */
    ".de-shortcuts": [".de-shortcut-close"],
  }
  for (const n of NESTS) {
    const kids = CHILDREN[n.of]
    assert.ok(kids, `${n.of} declares a nest and no child is named for it here`)
    for (const selector of kids) {
      const rule = cornerRule(selector)
      assert.equal(
        declaration(rule.body, "border-radius"),
        n.radius,
        `${selector} sits ${n.inset}px inside ${n.of}'s ${n.outer}, so it must draw ${n.radius}`
      )
    }
  }
})

/**
 * The rails that carry a chip FLUSH, which `nest()` cannot describe.
 *
 * A nest is about the gap between two curves. These have none: the track and
 * the thing riding in it share one corner, because that is what Figma draws and
 * what the panel now copies. `nest()` would happily compute `8px - 0 = 8px` and
 * assert nothing, so the invariant is stated directly instead — if a rail's
 * radius is ever changed without its cell following, the cell's corner stops
 * being parallel to the rail's and there is no other check that would notice.
 *
 * Paired here rather than in `EXPECTED` above so that the two kinds of
 * containment stay visibly different things: one has a measurable inset and one
 * is defined by having none.
 */
check("a rail and the cell riding flush inside it draw one corner", () => {
  const FLUSH = {
    ".de-segmented": ".de-segment",
    ".de-iseg": ".de-iseg > .de-tool",
    ".de-pad": ".de-pad-cell",
  }
  for (const [rail, cell] of Object.entries(FLUSH)) {
    const railRadius = declaration(cornerRule(rail).body, "border-radius")
    const cellRadius = declaration(cornerRule(cell).body, "border-radius")
    assert.ok(railRadius, `${rail} draws no border-radius`)
    assert.equal(
      cellRadius,
      railRadius,
      `${cell} rides flush inside ${rail}, so it must draw the rail's own ${railRadius}`
    )
    assert.ok(
      RAMP.includes(railRadius),
      `${rail} draws ${railRadius}, which is not on the ramp (${RAMP.join(", ")})`
    )
  }
})

// ── Nothing new may drift in ───────────────────────────────────────────────

console.log("\nContainers that could share a corner")

/**
 * A container can share a corner with a child only where two of its paddings
 * agree — a child sitting the same distance from both edges of that corner. A
 * container padded `0 8px` puts nothing in a corner however rounded it is, and
 * flagging it would teach everyone to ignore this list.
 *
 * ONE KIND OF NEST IS INVISIBLE HERE, and it is worth knowing before trusting a
 * green run as completeness. The gap can be contributed by a bare WRAPPER
 * between the container and the child rather than by the container's own
 * padding — `.de-ann-box` has no padding at all, and the 4px that separates it
 * from its rows belongs to `.de-ann-list` sitting between them. Nothing in
 * either rule, read on its own, describes a nest; only the two together in the
 * order the DOM stacks them do, and this file has no DOM.
 *
 * So the sweep below proves that no container drifts on its own, not that every
 * nest in the chrome is declared. `tools/concentric-audit.mjs` is what closes
 * that gap — it measures laid-out geometry in a browser, and it is how both of
 * the annotation nests above were found after this file had gone green.
 */
function cornerInsets(padding) {
  const parts = padding.trim().split(/\s+/).map((v) => Number.parseFloat(v))
  if (parts.some((v) => !Number.isFinite(v))) return []
  const [top, right = top, bottom = top, left = right] = parts
  return [[top, left], [top, right], [bottom, right], [bottom, left]]
    .filter(([a, b]) => a === b && a > 0)
    .map(([a]) => a)
}

/**
 * Containers that COULD nest and deliberately do not.
 *
 * Each one was opened and looked at; the reason is what the next person needs,
 * because "it is in the list" is not a reason. A container drops off this list
 * the moment its padding stops sharing a corner, and lands on it the moment it
 * starts — which is the whole point: the decision gets made when the geometry
 * changes, by whoever changed it.
 */
const LEAVES = {
  ".de-paint-card":
    "its first child is a ROW, and the 20px swatch at the left of it is centred in a 24px " +
    "band — 4px in across, 6px down. Nothing reaches a corner.",
  ".de-ann-composer-text": "a <textarea>. It has no element children to nest.",
  /*
   * `.de-lib-prop` was here, a column whose first child was `.de-lib-line`. It
   * dropped off on its own the same way `.de-lint-row` below did, except by
   * deletion rather than by re-housing: the whole library-component section it
   * belonged to had no renderer left, so the seven rules that dressed it went
   * and the reason went with them.
   */
  ".de-lib-card":
    "same shape one level up: `.de-lib-line` first, and the name leads it. The kind badge and " +
    "the switch are further along the row, past the corner.",
  /*
   * `.de-lint-row` was here, described as a grid whose top-left corner holds a
   * radius-less `.de-lint-check`. It dropped off this list on its own, which is
   * the list working: re-housing the audit as a section on the Design system
   * tab took its padding from an even inset to `8px 4px`, and a container whose
   * paddings disagree on every corner cannot put a child in one. The reason
   * stopped being needed at the moment the geometry stopped applying, and the
   * staleness case below is what said so.
   */
  ".de-insert-ghost": "one child, `.de-insert-ghost-name`, which draws no corner.",
  ".de-lib-signin":
    "the kit's dialog: an 18px corner over its 24px modal inset. The inset erodes the corner " +
    "to nothing, so the 8px buttons in its foot share no centre with it.",
}

check("every container that could share a corner has been ruled on", () => {
  const nested = new Set(NESTS.map((n) => n.of))
  const unruled = []
  for (const rule of ALL) {
    if (rule.selector.includes("::") || rule.selector.includes(",")) continue
    const radius = declaration(rule.body, "border-radius")
    const padding = declaration(rule.body, "padding")
    if (!radius || !padding) continue
    if (!(Number.parseFloat(radius) > 0)) continue
    if (!cornerInsets(padding).length) continue
    if (nested.has(rule.selector) || rule.selector in LEAVES) continue
    unruled.push(`${rule.selector} (radius ${radius}, padding ${padding})`)
  }
  assert.deepEqual(
    unruled,
    [],
    "these containers are rounded and padded so that a child can sit in a corner, and nobody " +
      "has said whether one does. Give each a nest() in its own module, or an entry in LEAVES " +
      "saying what is actually in the corner:\n       " + unruled.join("\n       ")
  )
})

check("nothing on the LEAVES list has quietly become a nest", () => {
  /*
   * The list only means anything while its entries still exist and still have
   * the geometry the reason describes. A leaf that has been deleted, or that
   * has stopped sharing a corner, is a reason nobody will re-read.
   */
  const stale = Object.keys(LEAVES).filter((selector) => {
    const rule = ALL.find((r) => r.selector === selector)
    if (!rule) return true
    const padding = declaration(rule.body, "padding")
    return !padding || !cornerInsets(padding).length
  })
  assert.deepEqual(stale, [], "these LEAVES entries no longer describe a real rounded container")
})

check("every corner the chrome draws is on the ramp, a circle, or square", () => {
  /*
   * The backstop under all of the above. A hand-picked 6px or 11px is what a
   * broken nest looks like once someone has "fixed" it at the call site, and it
   * would otherwise sail past every check in this file — nothing else here
   * looks at a radius that is not part of a declared nest.
   */
  // `999px` is the kit's pill rung. The circle sweep below holds every rule
  // that draws one to the `corner-shape: round` opt-out.
  const allowed = new Set([...RAMP, "0", "0px", "50%", "999px", "inherit"])
  const strays = new Set()
  for (const rule of ALL) {
    const radius = declaration(rule.body, "border-radius")
    if (!radius) continue
    for (const value of radius.split(/\s+/)) {
      if (!allowed.has(value)) strays.add(`${value} on ${rule.selector}`)
    }
  }
  assert.deepEqual([...strays], [], "a corner was drawn at a size the radius ramp does not have")
})

/*
 * EVERY ROUND THING OPTED OUT OF THE SQUIRCLE, CHECKED RATHER THAN REMEMBERED.
 *
 * `css/base.ts` sets `corner-shape: superellipse(2)` on the whole chrome and
 * then lists the shapes that must stay circular, because at `border-radius:
 * 50%` — or any radius past half the box — the corner box IS the whole side,
 * so a superellipse does not smooth a circle, it reshapes it into a rounded
 * square.
 *
 * That list is maintained by hand and has now been wrong three times: once for
 * the switch TRACKS while their knobs were in it, once for the pills, and once
 * for the severity dot and the lint disc, which were rendering as rounded
 * squares in every Chromium. Each time the rule was understood and the list
 * simply had a hole in it, which is the signature of a rule a machine should
 * be checking.
 *
 * So this is that check. Any rule declaring `border-radius: 50%` is round by
 * definition and must appear in the opt-out; a radius past half the declared
 * height is the same case arrived at arithmetically. The list stays — it is
 * still where the decision is recorded — but it can no longer be silently
 * incomplete.
 */
check("every circle in the chrome has opted out of the squircle", () => {
  const optOut = ALL.find((rule) => /corner-shape:\s*round/.test(rule.body))
  assert.ok(optOut, "nothing opts out, so the chrome's round things are no longer round")
  const exempted = optOut.selector.split(",").map((part) => part.trim())

  const missing = []
  for (const rule of ALL) {
    if (rule.selector.includes("@") || /corner-shape/.test(rule.body)) continue
    const radius = declaration(rule.body, "border-radius")
    if (!radius) continue

    let round = /(^|\s)50%/.test(radius)
    if (!round) {
      // A radius at or past half the height is the same clamp case, reached by
      // arithmetic rather than by the keyword. Only checkable where the rule
      // states its own height, which is most of the small round controls.
      const height = declaration(rule.body, "height")
      const px = (value) => (value && /^(\d+(?:\.\d+)?)px$/.test(value.trim()) ? Number.parseFloat(value) : null)
      const r = px(radius)
      const h = px(height)
      if (r !== null && h !== null && h > 0 && r >= h / 2) round = true
    }
    if (!round) continue
    if (exempted.some((part) => part === rule.selector)) continue
    missing.push(`${rule.selector} { border-radius: ${radius} }`)
  }

  assert.deepEqual(
    missing,
    [],
    `round shape(s) rendering as rounded squares — add them to the \`corner-shape: round\` list in css/base.ts:\n      ${missing.join("\n      ")}`
  )
})

/*
 * ONE PRESS, ONE VALUE.
 *
 * Eight controls in this chrome squeeze under the pointer and they did it at
 * five different sizes — 0.90, 0.92, 0.94, 0.95 and nothing at 0.96. Two were
 * genuinely out of band (a 0.90 on the settings checkbox reads as a flinch),
 * and the rest were a consistency problem: pressing two buttons a centimetre
 * apart moved them by visibly different amounts.
 *
 * It is a value and not a range, so there is nothing to tune per control and
 * no reason for a call site to hold its own number. The design foundations
 * kit sets it at 0.98 (MICRO-INTERACTIONS § 1): a 2% dip says "received"
 * without moving layout. Menu triggers skip it; the menu opening is their
 * feedback.
 *
 * Scoped to `:active` on purpose. A drag ghost at 0.98 and the popover
 * entrance's 0.97 are not presses, they are a different gesture and a
 * different animation, and sweeping every `scale()` in the sheet would have
 * dragged both in.
 */
check("every press in the chrome squeezes by the same amount", () => {
  const strays = []
  for (const rule of ALL) {
    if (!/:active(\s|$|[^-\w])/.test(rule.selector)) continue
    const transform = declaration(rule.body, "transform")
    if (!transform) continue
    for (const [, value] of transform.matchAll(/scale\(([^)]+)\)/g)) {
      if (value.trim() !== "0.98") strays.push(`${rule.selector} { transform: scale(${value}) }`)
    }
  }
  assert.deepEqual(strays, [], `a press at a size the house does not use:\n      ${strays.join("\n      ")}`)
})

/*
 * One cursor vocabulary, enforced rather than remembered.
 *
 * The split had reached 40 rules to 15 with no principle between them, and the
 * disagreements were between neighbours: a button that opens a popover said
 * `default` while the select beside it in the same row said `pointer`. The rule
 * is now stated in `css/panels.ts` — every enabled control is `pointer`, and
 * `default` belongs to disabled states and to things that are not controls.
 *
 * Checked by looking for the contradiction rather than by listing controls:
 * a rule that declares `cursor: default` and is NOT a disabled selector is the
 * failure, and that needs no inventory to stay true.
 */
check("no enabled control in the chrome withholds the pointer", () => {
  const strays = []
  for (const rule of ALL) {
    if (declaration(rule.body, "cursor") !== "default") continue
    // Disabled states legitimately take `default`; so do the two drag grounds,
    // which say `grab`/`grabbing` elsewhere and fall back here while inert.
    if (/\[disabled\]|\[aria-disabled="true"\]|:disabled/.test(rule.selector)) continue
    strays.push(rule.selector)
  }
  assert.deepEqual(
    strays,
    [],
    `enabled control(s) drawing no pointer:\n      ${strays.join("\n      ")}`
  )
})

/*
 * No question-mark cursor anywhere in the chrome. Every help dot is a
 * `<button>`, so it takes `pointer` like any other control — see the note on
 * `.de-ann-help` in `css/annotations.ts`. Fixed there once and missed on
 * `.de-lint-info`, which is why this is a sweep rather than a memory.
 */
check("no rule in the chrome draws the help cursor", () => {
  const strays = ALL.filter((rule) => declaration(rule.body, "cursor") === "help").map((rule) => rule.selector)
  assert.deepEqual(strays, [], `question-mark cursor on:\n      ${strays.join("\n      ")}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
