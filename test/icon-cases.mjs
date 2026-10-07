/**
 * The vendored glyph set renders as legal SVG.
 *
 * The source data is authored for React, so it spells presentation attributes
 * `strokeWidth` and carries a custom property — `var(--acme-icon-stroke-width, 2)`
 * in the host set this was first found on — as an
 * attribute value. Both are silent failures: `setAttribute` accepts any name,
 * and custom properties do not resolve in an attribute, so the eight
 * stroke-drawn glyphs drew at the UA's 1px default instead of the 2-unit weight
 * the design system draws them at — ChevronRight among them, which the layers
 * tree and every field row use. Nothing else catches this — it type-checks, it builds,
 * and a test that only asks whether an <svg> exists passes.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { JSDOM } from "jsdom"

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

const dom = new JSDOM("<!doctype html><html><body></body></html>")
globalThis.window = dom.window
globalThis.document = dom.window.document

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `
      export { icon, drawHostIcon, ICON_NAMES, LEGACY_ICON_NAMES, NATIVE_ICON_NAMES, NATIVE_ICON_SIZES } from "./src/core/icons"
      export { tokens } from "./src/core/tokens"
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
const { icon, drawHostIcon, ICON_NAMES, LEGACY_ICON_NAMES, NATIVE_ICON_NAMES, NATIVE_ICON_SIZES, tokens, shellCss } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

console.log("\nThe size ramp")

/*
 * Six sizes — the kit's icon roles — and every glyph in the chrome is drawn at
 * one of them.
 *
 * `IconSize` already makes an off-ramp number a compile error, so what is left
 * to check is the part TypeScript cannot see: that the ramp is still the six
 * values it is supposed to be, that the roles land on it, and — the one that
 * actually rots — that no call site has gone back to passing a literal.
 *
 * The set drifted to seven sizes before this existed: 10, 12, 13, 14, 16, 18,
 * 20. Each was locally reasonable at the call site that introduced it, which is
 * exactly why nothing caught the family coming apart.
 */
// The kit's six roles (ADOPTION-GUIDE § 6): marker 12, inline 14, action 16,
// chrome 18, header 20, feature 24. 12 is the floor — a status marker, a
// twisty — and no 13, 15 or 17px one-offs.
const RAMP = [12, 14, 16, 18, 20, 24]

check("the ramp is 12, 14, 16, 18, 20, 24 and every role lands on it", () => {
  const roles = Object.entries(tokens.icon)
  assert.ok(roles.length > 0, "tokens.icon is empty")
  for (const [role, size] of roles) {
    assert.ok(RAMP.includes(size), `tokens.icon.${role} is ${size}, which is off the ramp`)
  }
  // Every rung is reachable by name, or it is a number nobody can spend.
  const spent = new Set(roles.map(([, size]) => size))
  assert.deepEqual([...spent].sort((a, b) => a - b), RAMP)
})

check("a glyph draws at exactly the size it was asked for", () => {
  for (const size of RAMP) {
    const svg = icon("PanelLeft", size)
    assert.equal(svg.getAttribute("width"), String(size))
    assert.equal(svg.getAttribute("height"), String(size))
  }
})

/*
 * No call site passes a bare number.
 *
 * Read off the source rather than the DOM, because this is a rule about how the
 * code is written: `icon("X", 12)` type-checks perfectly well and is exactly
 * how the old spread accumulated. Naming the role is what makes a size legible
 * at the point of use, and what makes changing a rung one edit instead of
 * thirty.
 */
check("no call site spells its icon size as a number", () => {
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith(".ts")) continue
      // The generated set declares the ramp and the default; it is the source
      // of the numbers, not a consumer of them.
      if (full.endsWith(path.join("core", "icons.ts"))) continue
      const source = fs.readFileSync(full, "utf8")
      for (const match of source.matchAll(/\b(?:icon|drawIcon|drawHostIcon)\([^)\n]*?,\s*(\d+)/g)) {
        offenders.push(`${path.relative(PACKAGE_DIR, full)}: ${match[0].trim()}`)
      }
    }
  }
  walk(path.join(PACKAGE_DIR, "src"))
  assert.deepEqual(offenders, [])
})

/*
 * A NATIVE glyph may only be drawn at a rung it lands on whole pixels at.
 *
 * The native lattice family survives only in the glyphs kept from the previous
 * set (the toolbar marks and the object-align strip); the rule still holds
 * for those.
 *
 * That family is authored on a 16 lattice and emitted into the shared 24
 * viewBox, so one authored unit renders at `size / 8` device pixels on a 2x
 * display — a whole number only when the size is a multiple of 8. 16 and 24
 * are crisp; 12, 14, 18 and 20 are not.
 *
 * Measured rather than reasoned: in the rendered panel the align mark at 16px
 * resolves to two ink levels, and the same construction at 12px to four or six.
 * That soft, half-covered edge is the entire defect the family was built to
 * remove, so reintroducing it at a smaller rung undoes the work silently.
 *
 * Checked against the SOURCE, because it is a rule about what a call site may
 * ask for and because the mistake is locally reasonable every time it is made:
 * `tokens.icon.marker` is the obvious rung to reach for beside 12px text, and the
 * glyph looks fine until it is set next to one drawn at 16. Four call sites did
 * exactly this when the family first landed.
 *
 * The rung-name-to-number map is spelled out here rather than read from
 * `tokens`, so renaming a rung fails this case loudly instead of quietly
 * emptying it.
 */
check("a native glyph is never drawn at a rung it cannot land on", () => {
  const RUNG = { marker: 12, inline: 14, action: 16, chrome: 18, header: 20, feature: 24 }
  const native = new Set(NATIVE_ICON_NAMES)
  const allowed = new Set(NATIVE_ICON_SIZES)
  assert.ok(native.size > 0, "no native glyphs — this case would assert nothing")
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith(".ts")) continue
      if (full.endsWith(path.join("core", "icons.ts"))) continue
      const source = fs.readFileSync(full, "utf8")
      for (const match of source.matchAll(/\bicon\(\s*"([A-Za-z0-9]+)"\s*,\s*tokens\.icon\.([a-z]+)/g)) {
        const [, name, rung] = match
        if (!native.has(name)) continue
        const size = RUNG[rung]
        if (size === undefined) {
          offenders.push(`${path.relative(PACKAGE_DIR, full)}: unknown rung tokens.icon.${rung}`)
        } else if (!allowed.has(size)) {
          offenders.push(
            `${path.relative(PACKAGE_DIR, full)}: ${name} at tokens.icon.${rung} (${size}px) — ` +
              `native glyphs land on whole pixels only at ${[...allowed].join(", ")}`
          )
        }
      }
    }
  }
  walk(path.join(PACKAGE_DIR, "src"))
  assert.deepEqual(offenders, [])
})

console.log("\nVendored glyph set")

// Guard the sweep before the sweep: every assertion below is a loop, and a loop
// over an empty list passes while asserting nothing.
check("the set is non-empty and every name resolves", () => {
  assert.ok(ICON_NAMES.length >= 12, `expected at least 12 glyphs, saw ${ICON_NAMES.length}`)
  for (const name of ICON_NAMES) assert.ok(icon(name), `${name} produced nothing`)
})

check("no attribute name survives in React's camelCase spelling", () => {
  const offenders = []
  for (const name of ICON_NAMES) {
    for (const node of icon(name).querySelectorAll("*")) {
      for (const attr of node.attributes) {
        if (/[A-Z]/.test(attr.name)) offenders.push(`${name}: ${attr.name}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})

check("no attribute value is left as an unresolved custom property", () => {
  const offenders = []
  for (const name of ICON_NAMES) {
    for (const node of icon(name).querySelectorAll("*")) {
      for (const attr of node.attributes) {
        if (attr.value.includes("var(--")) offenders.push(`${name}: ${attr.name}=${attr.value}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})

/*
 * Every glyph is a FILLED Phosphor outline, stroked on top at its rung's width.
 *
 * Phosphor draws its line weight into the path, so each shape has to state
 * \`fill="currentColor"\` itself — the root fill is \`none\` on the outline
 * weight, and a shape that forgot its fill would render as nothing at all,
 * present in the DOM and absent on the screen. The root stroke is the EXTRA
 * weight laid over that outline (none at the large rungs), and the pressed-state
 * rule builds on it, so no shape may override it.
 */
const KEPT = new Set(LEGACY_ICON_NAMES)

/*
 * The kept drawings are a closed list (DESIGN.md, Icons). New glyphs come from
 * Phosphor, so this list may only shrink — and only with the user's say-so.
 */
check("only the agreed glyphs keep their pre-Phosphor drawing", () => {
  assert.deepEqual([...KEPT].sort(), [
    "AlignCenterHorizontal", "AlignCenterVertical", "AlignEndHorizontal", "AlignEndVertical",
    "AlignStartHorizontal", "AlignStartVertical", "ExternalLink", "Grid2x2", "MessageSquare",
    "Moon", "PanelLeft", "PanelRight", "Sun", "ToolClose", "ToolRedo", "ToolUndo", "Trash",
  ])
  assert.ok(!KEPT.has("Cursor"), "the pointer was asked to change to Phosphor's")
})

check("every glyph fills its outline and strokes in currentColor, at its rung's width", () => {
  assert.ok(KEPT.size > 0 && KEPT.size < ICON_NAMES.length, "the kept/Phosphor split is empty on one side")
  const offenders = []
  for (const size of RAMP) {
    for (const name of ICON_NAMES) {
      const svg = icon(name, size)
      // A kept drawing is the earlier stroke family: the kit's flat 2 units at
      // every rung, its fills stating \`stroke: none\` themselves.
      if (KEPT.has(name)) {
        if (svg.getAttribute("stroke-width") !== "2") offenders.push(`${name}@${size}: kept glyph at stroke ${svg.getAttribute("stroke-width")}`)
        for (const node of svg.querySelectorAll("*")) {
          if (node.getAttribute("stroke-width")) offenders.push(`${name}@${size}: ${node.tagName} overrides stroke-width`)
        }
        continue
      }
      if (svg.getAttribute("stroke") !== "currentColor") {
        offenders.push(`${name}@${size}: stroke=${svg.getAttribute("stroke")}`)
      }
      const width = Number(svg.getAttribute("stroke-width"))
      if (!(width >= 0)) offenders.push(`${name}@${size}: stroke-width=${width}`)
      for (const node of svg.querySelectorAll("*")) {
        if (node.getAttribute("fill") !== "currentColor") {
          offenders.push(`${name}@${size}: a ${node.tagName} does not fill in currentColor`)
        }
        if (node.getAttribute("stroke-width") || node.getAttribute("stroke")) {
          offenders.push(`${name}@${size}: ${node.tagName} overrides the root stroke`)
        }
      }
    }
  }
  assert.deepEqual(offenders, [])
})

/*
 * Rendered line weight, across the ramp.
 *
 * Phosphor's regular line is 1.5 of 24 and the root stroke adds to it, so what
 * reaches the screen is \`(1.5 + width) * size / 24\`. Under about 1px a line
 * antialiases into a grey suggestion of itself, and that is the floor this
 * holds: no rung may render thinner than one CSS pixel. Weight must still rise
 * with size and stay inside a 2.5x band, or the ramp is two families.
 */
const PHOSPHOR_LINE = 1.5

check("rendered line weight rises with size, and stays in one band", () => {
  const rendered = RAMP.map((size) => {
    const width = Number(icon("Square", size).getAttribute("stroke-width"))
    return { size, px: ((PHOSPHOR_LINE + width) * size) / 24 }
  })
  for (let i = 1; i < rendered.length; i += 1) {
    assert.ok(
      rendered[i].px > rendered[i - 1].px,
      `${rendered[i].size}px is not drawn heavier than ${rendered[i - 1].size}px ` +
        `(${rendered[i].px.toFixed(2)} vs ${rendered[i - 1].px.toFixed(2)})`
    )
  }
  const thinnest = rendered[0].px
  const thickest = rendered[rendered.length - 1].px
  assert.ok(thinnest >= 1, `the smallest rung renders at ${thinnest.toFixed(2)}px, under the 1px floor`)
  assert.ok(
    thickest / thinnest <= 2.5,
    `the ramp spans ${(thickest / thinnest).toFixed(2)}x in apparent weight, which is two families`
  )
})

/*
 * Every rung's stroke fits inside the grid it is drawn in.
 *
 * Half a stroke lies outside the path it is centred on, so compensating the
 * small rungs upward spends clearance the glyph may not have. Lucide draws to a
 * 1-unit padding guideline and in practice leaves just under 2 across this set
 * — but a glyph swapped into the mapping later may be drawn tighter, and the
 * symptom is a clipped corner nobody reviews for.
 *
 * `tools/build-icons.mjs` refuses one at generation time. This is the same rule
 * measured against what actually reaches the DOM, because the generator can be
 * bypassed by a hand-edit and the generated file says not to.
 */
check("no glyph's stroke is clipped by the viewBox at any rung", () => {
  const offenders = []
  for (const name of ICON_NAMES) {
    for (const size of RAMP) {
      // Per shape: a fill (`stroke: none`) inks exactly its geometry, and the
      // kit draws fills out to 1 unit from the edge — fine for a fill, a clip
      // for a stroke. The +0.5 is the selected-state bump in `css/icons.ts`.
      const svg = icon(name, size)
      const half = (Number(svg.getAttribute("stroke-width")) + 0.5) / 2
      for (const box of shapeBoxes(name)) {
        const clearance = Math.min(box.minX, box.minY, 24 - box.maxX, 24 - box.maxY)
        const needs = box.stroked ? half : 0
        if (clearance < needs) {
          offenders.push(`${name}@${size}: a <${box.tag}> has ${clearance.toFixed(2)} clearance, needs ${needs}`)
        }
      }
    }
  }
  assert.deepEqual(offenders, [])
})

/*
 * ONE drawing per glyph, except the marks a toggle fills.
 *
 * A flood paints nothing new on a Phosphor outline — it is already filled — so
 * the pointer's ON state is Phosphor's own fill weight, shipped as a second
 * drawing. The kept panel and grid toggles carry their authored counterparts;
 * the kept bubble is one stroked silhouette, which the root flood fills. Everything
 * else must stay one drawing, because two drawings are two things to keep in
 * agreement, and a glyph that grew a fill weight nobody asks for is dead data.
 */
const COUNTERPARTS = ["Cursor", "PanelLeft", "PanelRight", "Grid2x2"]

check("a glyph is one drawing, unless a toggle fills it", () => {
  for (const name of ICON_NAMES) {
    const auto = icon(name, 16)
    assert.equal(auto.querySelector("g"), null, `${name} is still wrapped in weight groups`)
    assert.equal(auto.getAttribute("fill"), "none", `${name} fills without being asked`)
    assert.equal(
      icon(name, 16, "outline").getAttribute("fill"),
      "none",
      `${name} fills on the outline weight`
    )
    assert.equal(
      icon(name, 16, "filled").getAttribute("fill"),
      "currentColor",
      `${name} ignored the filled weight`
    )
    const shapes = (weight) =>
      Array.from(icon(name, 16, weight).querySelectorAll("*"))
        .map((node) => node.getAttribute("d") ?? node.tagName)
        .join("|")
    const redrawn = shapes("outline") !== shapes("filled")
    assert.equal(
      redrawn,
      COUNTERPARTS.includes(name),
      redrawn
        ? `${name} draws a second mark when filled, and is not in COUNTERPARTS`
        : `${name} is listed in COUNTERPARTS but draws the same mark in both weights`
    )
  }
})

/*
 * An authored counterpart INHERITS NOTHING from the root flood.
 *
 * `drawIcon` puts `fill="currentColor"` on the <svg> for the filled weight,
 * because that flood is the counterpart for every glyph not on the list above.
 * A shape inside an authored counterpart that states no fill of its own picks
 * that up — and for these two it is fatal in the quietest possible way: the
 * frame is an 18x18 rounded rect, so it floods to the solid square the second
 * drawing exists to avoid, and the column authored on top is painted the same
 * colour against it and cannot be seen. Both toggles then report "open" as an
 * identical blot, which is the exact failure `COUNTERPARTS` was introduced to
 * fix, reintroduced one attribute lower down.
 *
 * Nothing else here notices. The root fill is correct, the second drawing is
 * present, the ink extents match, the flooded area is large. Every assertion
 * that could have caught it was measuring geometry, and the geometry is right —
 * it is the PAINT that is wrong. So this reads the paint: inside a counterpart,
 * every shape says what it fills, and the frame says `none`.
 */
check("an authored counterpart states every fill, and never floods its frame", () => {
  for (const name of COUNTERPARTS) {
    for (const node of icon(name, 16, "filled").querySelectorAll("*")) {
      const fill = node.getAttribute("fill")
      assert.ok(
        fill,
        `${name}: a <${node.tagName.toLowerCase()}> in the filled drawing states no fill, ` +
          `so it inherits the root flood`
      )
      // The frame is the one shape that must not be solid. Flooding it hides
      // every mark the counterpart draws inside it.
      if (node.tagName.toLowerCase() === "rect") {
        assert.equal(fill, "none", `${name}: the frame floods, swallowing the panel drawn inside it`)
      }
    }
  }
})

/*
 * A TOGGLE's glyph has to actually change when it fills.
 *
 * This replaces a rule that read the source and asserted only `Cursor` ever
 * asked for `"filled"`. That rule was right while the fill was a special case
 * for the pointer and the state lived in stroke weight — and it is what the
 * change to filled toggles had to argue with rather than delete quietly.
 *
 * Why the toggles fill now: half a unit of extra stroke is a RELATIVE signal.
 * Set the pressed glyph beside the same glyph at rest and it is obvious; look
 * at one button on its own — which is exactly how "are notes armed?" gets asked
 * — and there is nothing to compare it against. Solid against hollow needs no
 * reference.
 *
 * What that buys has to be checked, because it is not free. Flooding a mark
 * made only of open runs paints NOTHING: the glyph is identical in both states,
 * the toggle silently stops reporting itself, and no assertion above notices —
 * the attributes are all correct and the drawing is unchanged by design. So
 * this measures the area the fill actually covers, and the list is the marks
 * the bar's four toggles draw. A fifth toggle reaching for a mark of bare lines
 * fails here rather than in a screenshot.
 */
const TOGGLE_GLYPHS = ["Cursor", "MessageSquare", "PanelLeft", "PanelRight"]

check("every toggle's mark paints real area when it fills", () => {
  for (const name of TOGGLE_GLYPHS) {
    const area = floodedArea(name)
    assert.ok(
      area > 20,
      `${name} floods ${area.toFixed(1)} square units of the 576 in the grid — ` +
        `a toggle drawing it would look the same on as off`
    )
  }
})

/*
 * The stylesheet is what makes "on" visible, now that no glyph fills.
 *
 * Asserted as CSS text: jsdom parses a stylesheet and lays out nothing, so
 * there is no rendered stroke width to measure here. The rule going missing
 * would not throw and would not look broken in any DOM assertion — every toggle
 * in the chrome would simply stop reporting its state on its glyph, while still
 * reporting it correctly to assistive tech, which is precisely the kind of
 * drift the rule was centralised to prevent.
 */
check("a pressed or selected control draws its glyph heavier", () => {
  assert.match(
    shellCss,
    /\[aria-pressed="true"\][^{}]*svg\[data-de-glyph\][^{}]*\{[^}]*stroke-width:\s*calc\(var\(--de-icon-stroke/s,
    "no rule thickens a pressed control's glyph"
  )
  assert.match(
    shellCss,
    /\[aria-selected="true"\][^{}]*svg\[data-de-glyph\]/s,
    "a selected tab's glyph is not covered, only a pressed one's"
  )
})

/*
 * The marker that keeps that rule off other people's artwork.
 *
 * The state rule leans on `--de-icon-stroke`, which has a fallback, so without
 * a marker it would also reach the HOST's own icons — rendered by
 * `drawHostIcon` in the inspector's variant list, exactly as their author drew
 * them — and any `<svg>` the app being edited happens to place inside a
 * selected row. Both would be re-weighted on selection: the editor quietly
 * redrawing artwork it does not own.
 */
check("chrome glyphs are marked, and host icons are not", () => {
  for (const name of ICON_NAMES) {
    assert.ok(
      icon(name, 16).hasAttribute("data-de-glyph"),
      `${name} is unmarked, so the pressed-state rule will not reach it`
    )
    /*
     * The marker also NAMES the glyph, which is what lets a stylesheet say
     * something about one mark rather than about all of them. Asserted per
     * glyph rather than once, because the failure is silent in both
     * directions: every rule that reads the attribute matches on presence, so
     * a name that stopped being written would break only the optical
     * correction below and nothing would report it.
     */
    assert.equal(
      icon(name, 16).getAttribute("data-de-glyph"),
      name,
      `${name}'s marker does not carry its own name`
    )
  }
  const host = drawHostIcon({ nodes: [["path", { d: "M4 4h16v16H4z" }]], rootFill: "currentColor" }, 16)
  assert.equal(
    host.hasAttribute("data-de-glyph"),
    false,
    "a host icon is marked as ours, so the chrome will re-weight it on selection"
  )
})

/*
 * No glyph carries a per-glyph optical nudge.
 *
 * The previous set's arrow was translated 6.3% of its box because its ink sat
 * up and left of centre. Phosphor's cursor is drawn optically centred — its
 * alpha-weighted centroid is within 1.7% of the middle, rasterised at 120px —
 * so that nudge would now push it off. jsdom cannot rasterise; what can be
 * checked is that the rule did not come back with the old number attached.
 */
check("no glyph is optically nudged, because Phosphor centres its own", () => {
  const corrections = [...shellCss.matchAll(/svg\[data-de-glyph="([A-Za-z]+)"\]\s*\{([^}]*)\}/g)]
  assert.deepEqual(
    corrections.map((match) => match[1]),
    [],
    "a per-glyph rule appeared; measure that glyph's centroid before nudging it"
  )
})

/*
 * The ink tier — how big a glyph actually DRAWS inside its 24 grid.
 *
 * `viewBox` is not the answer to that question and neither is the `size`
 * argument: two glyphs drawn at the same size read a step apart if one of them
 * fills more of the box. Undo and redo did exactly that — an arc of r=10.003
 * plus a 2-unit stroke put their ink at 0.997..23.003, 22x22, against 20x20 for
 * everything else in the same strip. Both panel toggles carry the same 22 from
 * the other direction — Layers because it is vendored as the host authored it,
 * SlidersHorizontal because it is drawn to match that one.
 *
 * Nothing else catches it. It type-checks, it renders, it passes every
 * assertion above, and the only symptom is that two buttons in a row of six
 * look wrong together. So this measures the geometry the way the renderer will:
 * the union of every shape's own bounds, expanded by half the stroke on each
 * side, because a stroke is centred on its path.
 */
function arcPoints(x1, y1, rx, ry, largeArc, sweep, x2, y2, push) {
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  if (!rx || !ry) {
    push(x2, y2)
    return
  }
  // Endpoint -> centre parameterisation, per SVG 1.1 F.6.5. Every arc in this
  // set has x-axis-rotation 0, so the rotation terms drop out.
  const dx2 = (x1 - x2) / 2
  const dy2 = (y1 - y2) / 2
  const lambda = (dx2 * dx2) / (rx * rx) + (dy2 * dy2) / (ry * ry)
  if (lambda > 1) {
    const scale = Math.sqrt(lambda)
    rx *= scale
    ry *= scale
  }
  const numerator = rx * rx * ry * ry - rx * rx * dy2 * dy2 - ry * ry * dx2 * dx2
  const denominator = rx * rx * dy2 * dy2 + ry * ry * dx2 * dx2
  const coefficient = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator))
  const cxp = (coefficient * rx * dy2) / ry
  const cyp = (-coefficient * ry * dx2) / rx
  const cx = cxp + (x1 + x2) / 2
  const cy = cyp + (y1 + y2) / 2
  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy
    const length = Math.hypot(ux, uy) * Math.hypot(vx, vy)
    const sign = ux * vy - uy * vx < 0 ? -1 : 1
    return sign * Math.acos(Math.min(1, Math.max(-1, dot / length)))
  }
  const ux = (dx2 - cxp) / rx
  const uy = (dy2 - cyp) / ry
  const vx = (-dx2 - cxp) / rx
  const vy = (-dy2 - cyp) / ry
  const start = angle(1, 0, ux, uy)
  let sweptAngle = angle(ux, uy, vx, vy)
  if (!sweep && sweptAngle > 0) sweptAngle -= 2 * Math.PI
  if (sweep && sweptAngle < 0) sweptAngle += 2 * Math.PI
  // Sampled rather than solved for the four axis extrema: an arc's bounding box
  // depends on which quadrant boundaries it crosses, and 0.1 degrees is well
  // inside the 0.001 tolerance the assertions below use.
  const steps = Math.max(64, Math.ceil(Math.abs(sweptAngle) / (Math.PI / 1800)))
  for (let step = 0; step <= steps; step += 1) {
    const t = start + (sweptAngle * step) / steps
    push(cx + rx * Math.cos(t), cy + ry * Math.sin(t))
  }
}

/**
 * Where a Bézier turns around, solved rather than sampled.
 *
 * A curve's bounding box is set by its endpoints and by the points where the
 * derivative crosses zero, and sampling walks past those by however fine the
 * step is. The derivative of a cubic is a quadratic, so the roots are exact and
 * the box is exact — which matters here, because the assertions below compare
 * two ink boxes to a thousandth.
 */
function derivativeRoots(p0, p1, p2, p3) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3
  const b = 2 * (p0 - 2 * p1 + p2)
  const c = p1 - p0
  const roots = []
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b)
  } else {
    const discriminant = b * b - 4 * a * c
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant)
      roots.push((-b + root) / (2 * a), (-b - root) / (2 * a))
    }
  }
  return roots.filter((t) => t > 0 && t < 1)
}

function cubicPoints(x0, y0, x1, y1, x2, y2, x3, y3, push) {
  const at = (p0, p1, p2, p3, t) => {
    const u = 1 - t
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
  }
  for (const t of [
    ...derivativeRoots(x0, x1, x2, x3),
    ...derivativeRoots(y0, y1, y2, y3),
  ]) {
    push(at(x0, x1, x2, x3, t), at(y0, y1, y2, y3, t))
  }
  push(x3, y3)
}

function walkPath(d, push) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? []
  let index = 0
  let command = ""
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  // The control point a smooth curve mirrors. Reset by every command that is not
  // itself a curve, per the grammar — otherwise an `s` after a line would
  // reflect a control point from three commands ago.
  let controlX = 0
  let controlY = 0
  const next = () => Number(tokens[index++])
  while (index < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[index])) command = tokens[index++]
    // An implicit repeat after a moveto is a lineto, per the grammar.
    else if (command === "M") command = "L"
    else if (command === "m") command = "l"
    if (!"CcSsQqTt".includes(command)) {
      controlX = x
      controlY = y
    }
    switch (command) {
      case "M": x = next(); y = next(); startX = x; startY = y; push(x, y); break
      case "m": x += next(); y += next(); startX = x; startY = y; push(x, y); break
      case "L": x = next(); y = next(); push(x, y); break
      case "l": x += next(); y += next(); push(x, y); break
      case "H": x = next(); push(x, y); break
      case "h": x += next(); push(x, y); break
      case "V": y = next(); push(x, y); break
      case "v": y += next(); push(x, y); break
      case "A":
      case "a": {
        const rx = next()
        const ry = next()
        next() // x-axis-rotation
        const largeArc = next()
        const sweep = next()
        const endX = command === "A" ? next() : x + next()
        const endY = command === "A" ? next() : y + next()
        arcPoints(x, y, rx, ry, largeArc, sweep, endX, endY, push)
        x = endX
        y = endY
        break
      }
      case "C":
      case "c":
      case "S":
      case "s": {
        const relative = command === "c" || command === "s"
        const smooth = command === "S" || command === "s"
        const originX = relative ? x : 0
        const originY = relative ? y : 0
        const c1x = smooth ? 2 * x - controlX : originX + next()
        const c1y = smooth ? 2 * y - controlY : originY + next()
        const c2x = originX + next()
        const c2y = originY + next()
        const endX = originX + next()
        const endY = originY + next()
        cubicPoints(x, y, c1x, c1y, c2x, c2y, endX, endY, push)
        controlX = c2x
        controlY = c2y
        x = endX
        y = endY
        break
      }
      case "Q":
      case "q":
      case "T":
      case "t": {
        const relative = command === "q" || command === "t"
        const smooth = command === "T" || command === "t"
        const originX = relative ? x : 0
        const originY = relative ? y : 0
        const qx = smooth ? 2 * x - controlX : originX + next()
        const qy = smooth ? 2 * y - controlY : originY + next()
        const endX = originX + next()
        const endY = originY + next()
        // Degree-elevated to a cubic so one solver answers for both.
        cubicPoints(
          x, y,
          x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y),
          endX + (2 / 3) * (qx - endX), endY + (2 / 3) * (qy - endY),
          endX, endY,
          push
        )
        controlX = qx
        controlY = qy
        x = endX
        y = endY
        break
      }
      case "Z":
      case "z": x = startX; y = startY; push(x, y); break
      // Loudly, not silently: an unmeasured curve would report a box that is too
      // small and the assertion would pass for the wrong reason.
      default: throw new Error(`unsupported path command "${command}" in "${d}"`)
    }
  }
}

/**
 * The box the glyph's ink occupies on the 24 grid, stroke included.
 *
 * Half of a stroke lies outside the geometry it is centred on, and the weight
 * is declared in two places in this data — on the root for a glyph whose whole
 * set of shapes is stroked, on the individual node otherwise — so each shape is
 * expanded by its OWN half-stroke before the union is taken. Reading only the
 * root reports RotateCcw as 18x18 and quietly passes it as if it were smaller
 * than the toggles beside it, which is the opposite of the bug.
 */
function inkBox(name, weight = "outline") {
  // One weight at a time. Asked for neither, a glyph carries both, and measuring
  // the union of the two would report the larger of the pair for every icon.
  const svg = icon(name, 24, weight)
  let maxRadius = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let rawMinX = Infinity
  let rawMinY = Infinity
  let rawMaxX = -Infinity
  let rawMaxY = -Infinity
  for (const node of svg.querySelectorAll("*")) {
    let shapeMinX = Infinity
    let shapeMinY = Infinity
    let shapeMaxX = -Infinity
    let shapeMaxY = -Infinity
    const push = (px, py) => {
      shapeMinX = Math.min(shapeMinX, px)
      shapeMaxX = Math.max(shapeMaxX, px)
      shapeMinY = Math.min(shapeMinY, py)
      shapeMaxY = Math.max(shapeMaxY, py)
      // How far the ink gets from the grid centre, which is the other half of
      // what "the same size" means. See the optical-tier case below.
      maxRadius = Math.max(maxRadius, Math.hypot(px - 12, py - 12))
    }
    const tag = node.tagName.toLowerCase()
    const attr = (nodeName) => Number(node.getAttribute(nodeName))
    if (tag === "path") walkPath(node.getAttribute("d"), push)
    else if (tag === "rect") {
      push(attr("x"), attr("y"))
      push(attr("x") + attr("width"), attr("y") + attr("height"))
    } else if (tag === "circle") {
      push(attr("cx") - attr("r"), attr("cy") - attr("r"))
      push(attr("cx") + attr("r"), attr("cy") + attr("r"))
    } else throw new Error(`unsupported shape <${tag}> in ${name}`)

    const stroked = node.getAttribute("stroke") ?? svg.getAttribute("stroke")
    const weight = node.getAttribute("stroke-width") ?? svg.getAttribute("stroke-width")
    const half = stroked && stroked !== "none" ? Number(weight ?? 1) / 2 : 0
    minX = Math.min(minX, shapeMinX - half)
    maxX = Math.max(maxX, shapeMaxX + half)
    minY = Math.min(minY, shapeMinY - half)
    maxY = Math.max(maxY, shapeMaxY + half)
    // The AUTHORED geometry as well, with no stroke added. The clipping case
    // adds its own half-stroke per rung, and would double-count it otherwise.
    rawMinX = Math.min(rawMinX, shapeMinX)
    rawMaxX = Math.max(rawMaxX, shapeMaxX)
    rawMinY = Math.min(rawMinY, shapeMinY)
    rawMaxY = Math.max(rawMaxY, shapeMaxY)
  }
  return {
    width: maxX - minX,
    height: maxY - minY,
    maxRadius,
    minX: rawMinX,
    minY: rawMinY,
    maxX: rawMaxX,
    maxY: rawMaxY,
  }
}

/** Each shape's authored box, and whether it strokes — for the clipping case. */
function shapeBoxes(name) {
  const svg = icon(name, 24)
  return Array.from(svg.querySelectorAll("*")).map((node) => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const push = (px, py) => {
      minX = Math.min(minX, px)
      maxX = Math.max(maxX, px)
      minY = Math.min(minY, py)
      maxY = Math.max(maxY, py)
    }
    const tag = node.tagName.toLowerCase()
    const attr = (key) => Number(node.getAttribute(key))
    if (tag === "path") walkPath(node.getAttribute("d"), push)
    else if (tag === "rect") {
      push(attr("x"), attr("y"))
      push(attr("x") + attr("width"), attr("y") + attr("height"))
    } else if (tag === "circle") {
      push(attr("cx") - attr("r"), attr("cy") - attr("r"))
      push(attr("cx") + attr("r"), attr("cy") + attr("r"))
    } else throw new Error(`unsupported shape <${tag}> in ${name}`)
    const stroke = node.getAttribute("stroke") ?? svg.getAttribute("stroke")
    return { tag, minX, minY, maxX, maxY, stroked: Boolean(stroke) && stroke !== "none" }
  })
}

/**
 * How much of the grid a flood actually covers, in square units.
 *
 * The question a bounding box cannot answer. `SlidersHorizontal` inks 18x18 of
 * the grid in both weights and covers NOTHING when filled, because nine
 * straight runs enclose no area — the mark a toggle draws was identical on and
 * off while every box measurement agreed it was fine.
 *
 * Measured as the shoelace area of each subpath the renderer would close, which
 * is what SVG does to an unclosed path when it fills it. A rect and a circle
 * are taken analytically; a rounded rect is measured as its box, which
 * overstates it by the corners and is nowhere near the threshold this is used
 * at. The points a curve contributes include its extrema out of traversal
 * order, so the number is approximate — fine for a test that separates "covers
 * a fifth of the grid" from "covers exactly zero".
 */
function floodedArea(name) {
  const svg = icon(name, 24, "filled")
  let total = 0
  for (const node of svg.querySelectorAll("*")) {
    const tag = node.tagName.toLowerCase()
    const attr = (key) => Number(node.getAttribute(key))
    if (tag === "rect") {
      total += attr("width") * attr("height")
      continue
    }
    if (tag === "circle") {
      total += Math.PI * attr("r") ** 2
      continue
    }
    const points = []
    walkPath(node.getAttribute("d"), (x, y) => points.push([x, y]))
    let shoelace = 0
    for (let index = 0; index < points.length; index += 1) {
      const [x1, y1] = points[index]
      const [x2, y2] = points[(index + 1) % points.length]
      shoelace += x1 * y2 - x2 * y1
    }
    total += Math.abs(shoelace) / 2
  }
  return total
}

/**
 * The window the glyph is drawn through, in grid units.
 *
 * `inkBox` measures the AUTHORED geometry, which is not what reaches the eye:
 * `drawIcon` widens the viewBox around (12,12) so a glyph that inks more of the
 * grid lands smaller in the same box of pixels. Rendered ink is therefore the
 * authored box scaled by 24/side, and that — not the path data — is the number
 * the family has to agree on.
 */
function window24(name) {
  const [minX, minY, side] = icon(name, 24).getAttribute("viewBox").split(/\s+/).map(Number)
  return { minX, minY, side }
}

function drawnInk(name, weight = "outline") {
  const box = inkBox(name, weight)
  const { side } = window24(name)
  return {
    width: (box.width * 24) / side,
    height: (box.height * 24) / side,
    maxRadius: (box.maxRadius * 24) / side,
  }
}

/*
 * The optical tier is GONE, and its absence is the contract now.
 *
 * This used to assert that every glyph was normalised to one extent — first the
 * longest side at exactly 20 of the 24 grid, later a blend of that box with the
 * radial reach. Both existed because the previous family was assembled from a
 * source whose own extents ran 15.5 to 22.8, and each glyph had to be fitted by
 * widening its personal viewBox until it matched the rest.
 *
 * None of that survives a stroke family, and it must not:
 *
 *   - Re-windowing scales the STROKE along with the drawing. A glyph pulled in
 *     to match its neighbours arrives correctly sized and proportionally
 *     lighter, which trades a size error for a weight error — and in a stroke
 *     family the weight is the thing that has to match.
 *
 *   - The extents SHOULD vary. Lucide draws `ChevronRight` at 6x12 of the grid
 *     and `Layers` at 20x20, on purpose: a chevron is a light directional mark
 *     and a layer stack is an object, and forcing the chevron out to 20 would
 *     make it shout. That variation is the family's optical sizing, not drift
 *     in it.
 *
 * So what replaces the tier is the pair of rules a stroke family actually needs
 * — uniform stroke weight per rung, and no clipping — both asserted above. What
 * is asserted here is the thing that would silently undo them: that nobody has
 * reintroduced a per-glyph window.
 */
check("no glyph is re-windowed, because a stroke cannot survive it", () => {
  const offenders = []
  for (const name of ICON_NAMES) {
    const viewBox = icon(name, 24).getAttribute("viewBox")
    if (viewBox !== "0 0 24 24") offenders.push(`${name}: ${viewBox}`)
  }
  assert.deepEqual(offenders, [])
})

/*
 * The source's own optical sizing reaches the DOM intact.
 *
 * Phosphor draws a frame to 19.5 of 24 (a 16-unit margin on its 256 grid) and
 * its cross smaller, because a diagonal's corners reach further into the eye at
 * the same box size. If a future change reintroduced per-glyph box
 * normalisation, the cross would come out at the frame's size and this would
 * fail. That is the point: the naive fix for "the icons are inconsistent sizes"
 * is exactly the change that breaks them.
 */
check("a diagonal glyph is drawn smaller than an axis-aligned one", () => {
  const box = (name) => {
    const ink = drawnInk(name)
    return Math.max(ink.width, ink.height)
  }
  const frame = box("Image")
  assert.ok(Math.abs(frame - 19.5) < 0.5, `the frame inks ${frame.toFixed(2)}, not Phosphor's 19.5`)
  const x = box("X")
  assert.ok(x < frame - 2, `X (${x.toFixed(2)}) is not pulled in from the frame (${frame.toFixed(2)})`)
  // And not so far in that it stops reading as the same size mark.
  assert.ok(x > frame * 0.75, `X (${x.toFixed(2)}) has been shrunk past recognition`)
})

/*
 * Asking for a fill must not resize the mark.
 *
 * Structurally guaranteed now rather than arranged: the two weights are one set
 * of shapes painted two ways, so there is no second drawing to drift. It was
 * arranged before — the old family drew each weight separately and did not
 * author them to the same extent, so `Cursor` inked 17.5 as an outline and 16.0
 * as a fill, and normalising them apart made the glyph jump a few per cent
 * larger at the exact moment the eye was on it.
 *
 * Kept because the guarantee is only structural while the shapes stay shared.
 * The obvious future edit — hand-tuning a heavier silhouette for the filled
 * pointer, since it is the one glyph that fills — reintroduces exactly the old
 * failure, and this is what would catch it.
 */
check("a glyph is the same size in both weights", () => {
  for (const name of ICON_NAMES) {
    const outline = drawnInk(name, "outline")
    const filled = drawnInk(name, "filled")
    const spread = Math.max(
      Math.abs(outline.width - filled.width),
      Math.abs(outline.height - filled.height)
    )
    assert.ok(
      spread < 2,
      `${name} resizes on press: ${outline.width.toFixed(2)}x${outline.height.toFixed(2)} outline vs ${filled.width.toFixed(2)}x${filled.height.toFixed(2)} filled`
    )
  }
})

/*
 * The two toggles sit next to each other and open opposite sides of the screen,
 * and each now draws ONE mark rather than swapping between an open and a
 * collapsed one. So the thing that has to be legible is not a state — the panel
 * itself reports that by being on screen — but which button is which.
 */
check("the two panel toggles are told apart from each other", () => {
  const shape = (name) =>
    Array.from(icon(name, 24).querySelectorAll("*"))
      .map((node) => Array.from(node.attributes).map((a) => `${a.name}=${a.value}`).join(" "))
      .join(" | ")
  assert.notEqual(shape("PanelLeft"), shape("PanelRight"), "both toggles draw the same thing")
})

/*
 * The case that stood here — "only a filled glyph is fitted by its window" —
 * is retired. It policed a trade this family no longer makes: it allowed a
 * per-glyph window as long as the glyph did not stroke. Every glyph strokes
 * now, so the honest form of the rule is that NOTHING is fitted, which
 * "no glyph is re-windowed" asserts directly rather than conditionally.
 */

check("the retired panel glyphs are gone, not left drawing nothing", () => {
  const retired = [
    "Move",
    "Hand",
    // The four-glyph open/collapsed pair the two toggles replaced, and then the
    // two contents marks — a layer stack and a slider rack — that replaced
    // THOSE and have in turn been replaced by `PanelLeft` / `PanelRight`. The
    // frames are back because a mirrored pair is read rather than learned, and
    // because a panel's contents move while the edge it hangs off does not.
    "SidebarLeft",
    "SidebarLeftCollapsed",
    "SidebarRight",
    "SidebarRightCollapsed",
    "Layers",
    "SlidersHorizontal",
  ]
  for (const name of retired) {
    assert.ok(!ICON_NAMES.includes(name), `${name} is still in the set with nothing drawing it`)
  }
})

check("every glyph is decorative and drawn on a grid centred on the 24 box", () => {
  for (const name of ICON_NAMES) {
    const svg = icon(name, 12)
    const [minX, minY, width, height] = svg.getAttribute("viewBox").split(/\s+/).map(Number)
    assert.equal(width, height, `${name} is not on a square grid`)
    // Off-centre and the glyph is not just resized, it is nudged — which is a
    // different edit from the one `inkViewBox` is allowed to make.
    assert.ok(
      Math.abs(minX + width / 2 - 12) < 1e-9 && Math.abs(minY + height / 2 - 12) < 1e-9,
      `${name}'s window is not centred on the 24 grid: ${svg.getAttribute("viewBox")}`
    )
    assert.equal(svg.getAttribute("aria-hidden"), "true", `${name} is exposed to a screen reader`)
    assert.equal(svg.getAttribute("width"), "12", `${name} ignored its size argument`)
    assert.equal(svg.getAttribute("height"), "12", `${name} ignored its size argument`)
  }
})

console.log("\nRoom to draw in")

/*
 * A glyph asked for at 16 has to come out at 16, and the stylesheet is where
 * that is won or lost.
 *
 * The note-row actions shipped drawn 4x16 — a quarter of their width, a smear
 * rather than an icon — and every other check in this file passed the whole
 * time. They had to: `icon()` emitted a correct 16x16 `<svg>`, the size was on
 * the ramp, the glyph was centred on its grid. The damage happened afterwards,
 * in layout, from Chrome's UA `padding: 1px 6px` eating twelve of the eighteen
 * pixels the button had. Nothing that reads the DOM in jsdom can see it, because
 * jsdom has no layout at all.
 *
 * So these two check the invariants that make the squash impossible, rather
 * than the rendering that would reveal it. Both live in `css/base.ts`, both are
 * one line, and either one going missing brings the whole class of bug back.
 */
check("the chrome resets the UA's button padding, and at zero specificity", () => {
  const reset = shellCss.match(/:where\(\[data-designlayer\] button\)\s*\{([^}]*)\}/)
  assert.ok(
    reset,
    "no `:where([data-designlayer] button)` reset — an icon button's content " +
      "box is 12px narrower than the square it pins, and its glyph gets squashed"
  )
  assert.match(reset[1], /padding:\s*0\s*;/, "the button reset no longer zeroes padding")
  // Unwrapped, the selector is (0,1,1) and outweighs every `.de-` class here —
  // which would not remove the UA's padding, it would strip the deliberate
  // padding off every text button in the chrome.
  assert.ok(
    !/(^|\n)\[data-designlayer\] button\s*\{/.test(shellCss),
    "the button padding reset is unwrapped, so it overrules the rules it should lose to"
  )
})

check("a glyph that cannot fit its button overflows instead of shrinking", () => {
  const rule = shellCss.match(/\[data-designlayer\] svg\s*\{([^}]*)\}/)
  assert.ok(rule, "no base rule for the chrome's `<svg>` elements")
  // Every icon button here is a flex container, so the glyph is a flex item and
  // will be shrunk to fit a content box that is too small — silently, still
  // looking like an icon. `flex: none` turns that into a visible overflow.
  assert.match(
    rule[1],
    /flex:\s*none\s*;/,
    "the chrome's glyphs can be flex-shrunk again, which fails by looking fine"
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
