#!/usr/bin/env node
/**
 * Regenerates `src/core/icons.ts` from Phosphor (https://phosphoricons.com,
 * MIT), read out of `@phosphor-icons/core`'s SVG assets.
 *
 * The glyphs are VENDORED as path data rather than imported at runtime: the
 * bundle is an IIFE with no imports, and the editor must not add a dependency
 * to the app it is editing. This script is how that data is kept honest — the
 * mapping below is the only place an editor name is tied to a Phosphor
 * drawing, so a glyph swap is a one-line edit and a re-run.
 *
 *   node tools/build-icons.mjs          # rewrite src/core/icons.ts
 *   node tools/build-icons.mjs --check  # fail if the file is out of date
 *
 * WHAT CHANGES WITH A FILL FAMILY
 *
 * The previous set was Lucide plus the design foundations kit plus a native
 * lattice family: mostly STROKES, centred on their paths and weighted by the
 * root `stroke-width`. Phosphor ships every weight as a FILLED outline — the
 * regular weight is a 16-unit line on a 256 grid, already expanded into the
 * path — so three things follow:
 *
 *   1. One grid for the chrome, still 24. Every path is scaled 24/256 into the
 *      shared `0 0 24 24` viewBox by rewriting its geometry, never by widening
 *      the viewBox, so the `size` a call site asks for is still the box it gets
 *      and every rung on the ramp draws the same square of pixels it did.
 *
 *   2. The drawn weight lives in the path (1.5 of 24). The root stroke is now
 *      EXTRA weight laid on top of that outline — see `STROKE_FOR_SIZE` — which
 *      is what keeps two rules from the stroke family working unchanged: the
 *      thinnest rung still renders a 1px line, and a pressed or selected
 *      control still draws its glyph heavier (`css/icons.ts` adds half a unit).
 *
 *   3. A toggle's ON state is Phosphor's own FILL weight, not a flood. A flood
 *      paints nothing new on a drawing that is already filled, so the marks a
 *      toggle draws carry `filled: true` and ship both weights.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const OUT = path.join(root, "src", "core", "icons.ts")
const PHOSPHOR = path.join(root, "node_modules", "@phosphor-icons", "core")

/** Phosphor's grid, and the chrome's. */
const SOURCE_GRID = 256
const GRID = 24

/*
 * KEPT DRAWINGS. Seventeen glyphs keep the artwork they had before the swap,
 * by the user's call: the bottom toolbar (all but the pointer), ExternalLink,
 * the six object-align marks, the two panel toggles and Trash. Their shapes are
 * frozen in `tools/icons/legacy-glyphs.json`, copied from the last generated
 * set — the design foundations kit, Lucide (ISC, `tools/icons/LICENSE-lucide.txt`)
 * and the native 16-unit lattice family. They are a STROKE family drawn at the
 * kit's flat 2 units, so each carries `stroke: 2` and `drawIcon` draws it at
 * that weight instead of the Phosphor rung table. New glyphs come from
 * Phosphor; see DESIGN.md.
 */
const LEGACY = JSON.parse(fs.readFileSync(path.join(root, "tools", "icons", "legacy-glyphs.json"), "utf8"))
const LEGACY_STROKE = 2
/** Native-lattice glyphs land on whole pixels only at a multiple of 8. */
const NATIVE_SIZES = [16, 24]
const legacy = { legacy: true }

/**
 * Editor name -> Phosphor drawing.
 *
 * A string is a Phosphor icon name, used as drawn. An object is a recipe on
 * one: `mirror` / `flip` reflect it, `rotate` turns it by 90 degrees
 * (clockwise when positive), `scale` shrinks it about the centre, `flipEach`
 * reflects every subpath about its own centre, `add` lays extra path data (in
 * Phosphor's 256 grid and construction) on top, and `filled` ships Phosphor's
 * fill weight as the counterpart a toggle draws when it is on. `legacy` keeps
 * the pre-Phosphor drawing (see KEPT DRAWINGS above).
 *
 * The editor's own names are kept: they say what the mark MEANS here, and
 * keeping them means no call site churns when a glyph is swapped.
 *
 * SCALES keep each mark the size it was. Phosphor draws most glyphs to about
 * 19.5 of 24, which is what the previous set inked too, but a few run to the
 * grid's edge (the out-arrows, the sun, `</>`) or sit well inside it (`T`).
 * Each `scale` below pulls one back to within 8% of the ink extent the glyph
 * had before the swap, measured by `tools/icon-sticker-sheet.mjs`. A scale
 * thins the line with the drawing, so none goes below 0.8.
 */
const MAP = {
  // Toolbar: kept drawings, except the pointer, which ships its fill weight.
  Cursor: { from: "cursor", filled: true },
  MessageSquare: legacy,
  PanelLeft: legacy,
  PanelRight: legacy,
  Grid2x2: legacy,
  ToolUndo: legacy,
  ToolRedo: legacy,
  ToolClose: legacy,
  Sun: legacy,
  Moon: legacy,
  Minimize: { from: "corners-in", scale: 1.2 },

  // Panels and rows.
  Search: "magnifying-glass",
  ListChecks: "list-checks",
  Check: "check",
  X: "x",
  // The dense close on Design system cards: Phosphor's cross pulled in so the
  // 12px rung still draws a small mark inside an 18px `.de-mini`.
  XSmall: { from: "x", scale: 0.85 },
  ChevronDown: { from: "caret-down", scale: 0.85 },
  ChevronRight: { from: "caret-right", scale: 0.85 },
  ChevronsUpDown: "caret-up-down",
  // Phosphor has no collapse partner for `caret-up-down`, so each caret is
  // turned about its own centre: the same two carets, pointing at each other.
  ChevronsDownUp: { from: "caret-up-down", flipEach: true },
  Plus: { from: "plus", scale: 0.89 },
  Minus: { from: "minus", scale: 0.89 },
  Copy: "copy",
  Send: "paper-plane-tilt",
  Trash: legacy,
  Code: { from: "code", scale: 0.9 },
  Sparkles: "sparkle",
  Play: "play",
  ExternalLink: legacy,
  Pencil: "pencil-simple",

  // Layer-tree row state. A pair comes from one drawing family.
  Eye: "eye",
  EyeOpen: "eye",
  EyeOff: "eye-slash",
  Lock: "lock-simple",
  LockOpen: "lock-simple-open",

  // What a layer IS.
  Square: "square",
  Type: { from: "text-t", scale: 1.15 },
  Image: "image",
  Component: "diamonds-four",

  // Align a box within its parent: a rule and two bars of different lengths.
  AlignStartVertical: legacy,
  AlignCenterVertical: legacy,
  AlignEndVertical: legacy,
  AlignStartHorizontal: legacy,
  AlignCenterHorizontal: legacy,
  AlignEndHorizontal: legacy,
  SpaceBetweenHorizontal: { from: "arrows-out-line-horizontal", scale: 0.8 },
  SpaceBetweenVertical: { from: "arrows-out-line-vertical", scale: 0.8 },

  // Arrange, and the shared arrows.
  ArrangeFront: "arrow-line-up",
  ArrangeForward: "arrow-up",
  ArrangeBackward: "arrow-down",
  ArrangeBack: "arrow-line-down",
  ArrowUp: "arrow-up",
  ArrowDown: "arrow-down",
  ArrowRight: "arrow-right",
  ArrowUpToLine: "arrow-line-up",
  ArrowDownToLine: "arrow-line-down",

  // Text alignment: the rag, then the block against its box.
  TextAlignLeft: "text-align-left",
  TextAlignCenter: "text-align-center",
  TextAlignRight: "text-align-right",
  TextAlignJustify: "text-align-justify",
  TextAlignTop: "arrow-line-up",
  TextAlignMiddle: { from: "arrows-in-line-vertical", scale: 0.8 },
  TextAlignBottom: "arrow-line-down",

  // Auto layout's flow strip: off, then the same boxes in three arrangements.
  FlowNone: "prohibit",
  FlowHorizontal: "columns",
  FlowVertical: "rows",
  FlowWrap: "squares-four",
  GapColumn: { from: "split-horizontal", scale: 0.86 },
  GapRow: { from: "split-vertical", scale: 0.86 },
  Opacity: { from: "drop-half", scale: 0.86 },

  /*
   * Padding: Phosphor's square with the measured edge doubled — one more
   * 16-unit line inside the frame — and turned to each side. Phosphor has no
   * padding mark; this is its frame plus its own line weight, so the four
   * read as one control with four positions.
   */
  PadLeft: { from: "square", add: ["M48,48H64V208H48Z"] },
  PadRight: { from: "square", add: ["M48,48H64V208H48Z"], mirror: true },
  PadTop: { from: "square", add: ["M48,48H64V208H48Z"], rotate: 90 },
  PadBottom: { from: "square", add: ["M48,48H64V208H48Z"], rotate: -90 },

  /*
   * One corner of a box with its curve called out. Phosphor has no radius
   * glyph, so this one is drawn here in Phosphor's construction: a 16-unit
   * line with round caps, on its 256 grid. Set 16 units down and right of
   * centre, because all of a corner's mass sits at one end of its box.
   */
  CornerRadius: { add: ["M56,224V128A72,72,0,0,1,128,56H224A8,8,0,0,1,224,72H128A56,56,0,0,0,72,128V224A8,8,0,0,1,56,224Z"] },

  // Not drawn by the chrome today; kept so a name never disappears under a caller.
  Ban: "prohibit",
  WrapText: "arrow-u-down-left",
  Constrain: "link-simple",
  // The 3x3 alignment pad's cells.
  Circle: "circle",
}

/**
 * Extra stroke laid over each rung's outline, in grid units.
 *
 * Phosphor's regular line is 1.5 of 24, which renders 0.75px at the 12px
 * rung — under the 1px floor this chrome holds every glyph to. A stroke of
 * `w` on a filled outline thickens every line by `w`, so the small rungs get
 * the difference back and the large ones draw Phosphor's weight untouched.
 * Rendered line weight then rises 1.0 → 1.5px across the ramp.
 */
const STROKE_FOR_SIZE = {
  12: 0.5,
  14: 0.3,
  16: 0.15,
  18: 0,
  20: 0,
  24: 0,
}

/**
 * How much heavier `css/icons.ts` draws a glyph in a selected row or pressed
 * control (`calc(var(--de-icon-stroke) + 0.5)`). Mirrored here only so the
 * clearance check measures the heaviest stroke that actually renders.
 */
const SELECTED_STROKE_BUMP = 0.5

/** One Phosphor icon's path data, in its own 256 grid. */
function readPhosphor(name, weight = "regular") {
  const file = path.join(PHOSPHOR, "assets", weight, `${name}${weight === "regular" ? "" : `-${weight}`}.svg`)
  if (!fs.existsSync(file)) throw new Error(`phosphor has no ${weight} icon named ${name}`)
  const text = fs.readFileSync(file, "utf8")
  if (!text.includes(`viewBox="0 0 ${SOURCE_GRID} ${SOURCE_GRID}"`)) throw new Error(`${name}: not on the 256 grid`)
  const tags = [...text.matchAll(/<([a-z]+)\b/g)].map((m) => m[1]).filter((tag) => tag !== "svg")
  if (tags.some((tag) => tag !== "path")) throw new Error(`${name}: draws <${tags.find((t) => t !== "path")}>, only paths are vendored`)
  return [...text.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1])
}


/** Every point in a path, moved by `move`, with arc flags kept honest. */
function transformPath(d, move, { flips = false, scale = 1, turn = 0 } = {}) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []
  const out = []
  let [x, y] = [0, 0]
  let [startX, startY] = [0, 0]
  let index = 0
  let command = ""
  const number = () => Number(tokens[index++])
  const emit = (letter, ...points) => {
    out.push(letter + points.map(([px, py]) => `${round(px)} ${round(py)}`).join(" "))
  }
  const round = (n) => Number(n.toFixed(3))
  const at = (px, py) => move(px, py)
  while (index < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[index])) command = tokens[index++]
    // A repeated coordinate run continues the previous command, and an implicit
    // `M` run continues as `L` — the one rule in the grammar that is not the
    // letter it was written with.
    else if (command === "M") command = "L"
    else if (command === "m") command = "l"
    const relative = command === command.toLowerCase()
    const kind = command.toUpperCase()
    const absolute = (dx, dy) => (relative ? [x + dx, y + dy] : [dx, dy])
    if (kind === "Z") {
      out.push("z")
      ;[x, y] = [startX, startY]
      continue
    }
    if (kind === "M" || kind === "L" || kind === "T") {
      ;[x, y] = absolute(number(), number())
      if (kind === "M") [startX, startY] = [x, y]
      emit(kind, at(x, y))
    } else if (kind === "H") {
      x = relative ? x + number() : number()
      emit("L", at(x, y))
    } else if (kind === "V") {
      y = relative ? y + number() : number()
      emit("L", at(x, y))
    } else if (kind === "C") {
      const c1 = absolute(number(), number())
      const c2 = absolute(number(), number())
      ;[x, y] = absolute(number(), number())
      emit("C", at(...c1), at(...c2), at(x, y))
    } else if (kind === "S" || kind === "Q") {
      const c = absolute(number(), number())
      ;[x, y] = absolute(number(), number())
      emit(kind, at(...c), at(x, y))
    } else if (kind === "A") {
      const [rx, ry] = [number() * scale, number() * scale]
      const rotation = number() * (flips ? -1 : 1) + turn
      const largeArc = number()
      // A mirror reverses which side of the chord the centre falls on, so the
      // sweep flag has to flip with it or the arc bulges the wrong way — the
      // failure looks like a bubble whose tail curls back into itself.
      const sweep = flips ? 1 - number() : number()
      ;[x, y] = absolute(number(), number())
      const [ax, ay] = at(x, y)
      out.push(`A${round(rx)} ${round(ry)} ${round(rotation)} ${largeArc} ${sweep} ${round(ax)} ${round(ay)}`)
    } else {
      throw new Error(`transformPath: unknown command "${command}"`)
    }
  }
  return out.join("")
}

/** Where a cubic turns around — the roots of its derivative, solved not sampled. */
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
      const r = Math.sqrt(discriminant)
      roots.push((-b + r) / (2 * a), (-b - r) / (2 * a))
    }
  }
  return roots.filter((t) => t > 0 && t < 1)
}

/** An elliptical arc's points, via the SVG 1.1 F.6.5 endpoint parameterisation. */
function arcPoints(x1, y1, rx, ry, largeArc, sweep, x2, y2, push) {
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  if (!rx || !ry) {
    push(x2, y2)
    return
  }
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
  let swept = angle(ux, uy, vx, vy)
  if (!sweep && swept > 0) swept -= 2 * Math.PI
  if (sweep && swept < 0) swept += 2 * Math.PI
  // Sampled rather than solved for the four axis extrema: an arc's box depends
  // on which quadrant boundaries it crosses, and a tenth of a degree is far
  // inside the tolerance `assertFits` works to.
  const steps = Math.max(64, Math.ceil(Math.abs(swept) / (Math.PI / 1800)))
  for (let step = 0; step <= steps; step += 1) {
    const t = start + (swept * step) / steps
    push(cx + rx * Math.cos(t), cy + ry * Math.sin(t))
  }
}

/** Every point a `d` attribute reaches, curve extrema included. */
function walkPath(d, push, label) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? []
  let i = 0
  let command = ""
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let controlX = 0
  let controlY = 0
  const num = () => Number.parseFloat(tokens[i++])
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    const at = (p0, p1, p2, p3, t) => {
      const u = 1 - t
      return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
    }
    for (const t of [...derivativeRoots(x, x1, x2, x3), ...derivativeRoots(y, y1, y2, y3)]) {
      push(at(x, x1, x2, x3, t), at(y, y1, y2, y3, t))
    }
    push(x3, y3)
    controlX = x2
    controlY = y2
    x = x3
    y = y3
  }

  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) command = tokens[i++]
    const relative = command === command.toLowerCase()
    const kind = command.toUpperCase()
    const rx = (v) => (relative ? x + v : v)
    const ry = (v) => (relative ? y + v : v)
    // Reset the smooth-curve reflection on anything that is not itself a curve,
    // per the grammar — otherwise an `s` after a line mirrors a control point
    // from three commands ago.
    if (!"CSQT".includes(kind)) {
      controlX = x
      controlY = y
    }
    if (kind === "M") {
      x = rx(num())
      y = ry(num())
      startX = x
      startY = y
      push(x, y)
      // An implicit run after a moveto is a lineto, per the grammar.
      command = relative ? "l" : "L"
    } else if (kind === "L") {
      x = rx(num())
      y = ry(num())
      push(x, y)
    } else if (kind === "H") {
      x = rx(num())
      push(x, y)
    } else if (kind === "V") {
      y = ry(num())
      push(x, y)
    } else if (kind === "C") {
      cubic(rx(num()), ry(num()), rx(num()), ry(num()), rx(num()), ry(num()))
    } else if (kind === "S") {
      cubic(2 * x - controlX, 2 * y - controlY, rx(num()), ry(num()), rx(num()), ry(num()))
    } else if (kind === "Q" || kind === "T") {
      const qx = kind === "T" ? 2 * x - controlX : rx(num())
      const qy = kind === "T" ? 2 * y - controlY : ry(num())
      const endX = rx(num())
      const endY = ry(num())
      // Degree-elevated to a cubic, so one solver answers for both.
      cubic(
        x + (2 / 3) * (qx - x),
        y + (2 / 3) * (qy - y),
        endX + (2 / 3) * (qx - endX),
        endY + (2 / 3) * (qy - endY),
        endX,
        endY
      )
      controlX = qx
      controlY = qy
    } else if (kind === "A") {
      const arcRx = num()
      const arcRy = num()
      num() // x-axis-rotation; zero throughout Lucide and the kit
      const largeArc = num()
      const sweep = num()
      // Minified SVG may pack flags against the next number ("0 011.5"), which
      // this tokenizer would read as one. A flag that is not 0 or 1 is that.
      if ((largeArc !== 0 && largeArc !== 1) || (sweep !== 0 && sweep !== 1)) {
        throw new Error(`${label}: packed arc flags this tokenizer cannot read`)
      }
      const endX = rx(num())
      const endY = ry(num())
      arcPoints(x, y, arcRx, arcRy, largeArc, sweep, endX, endY, push)
      x = endX
      y = endY
    } else if (kind === "Z") {
      x = startX
      y = startY
      push(x, y)
    } else {
      // Loudly, not silently: an unmeasured command reports a box that is too
      // small, and `assertFits` would then wave through a glyph that clips.
      throw new Error(`${label}: unknown path command "${command}"`)
    }
  }
}


/** A path's subpaths, after it has been rewritten into absolute commands. */
const subpaths = (absolute) => absolute.split(/(?=M)/).filter(Boolean)

/** The box a single path's geometry spans. */
function pathBox(d, label) {
  return inkBox([["path", { d }]], label)
}

/**
 * One recipe applied to Phosphor path data: reflected, turned, scaled about the
 * centre, then moved from the 256 grid onto the 24 one — all by rewriting the
 * geometry, so `inkBox` and `assertFits` measure the drawing that renders.
 */
function applyRecipe(paths, recipe, label) {
  const { mirror = false, flip = false, rotate = 0, scale = 1, flipEach = false } = recipe
  let absolute = paths.map((d) => transformPath(d, (x, y) => [x, y]))
  if (flipEach) {
    absolute = absolute.map((d) =>
      subpaths(d)
        .map((part) => {
          const box = pathBox(part, label)
          const cy = (box.minY + box.maxY) / 2
          return transformPath(part, (x, y) => [x, 2 * cy - y], { flips: true })
        })
        .join("")
    )
  }
  const mid = SOURCE_GRID / 2
  const k = GRID / SOURCE_GRID
  const turns = ((rotate / 90) % 4 + 4) % 4
  const move = (x, y) => {
    let [dx, dy] = [x - mid, y - mid]
    for (let i = 0; i < turns; i += 1) [dx, dy] = [-dy, dx]
    if (mirror) dx = -dx
    if (flip) dy = -dy
    return [(mid + dx * scale) * k, (mid + dy * scale) * k]
  }
  return absolute.map((d) => transformPath(d, move, { flips: mirror !== flip, scale: scale * k, turn: rotate }))
}

const recipeOf = (source) => (typeof source === "string" ? { from: source } : source)

function originOf(recipe) {
  const steps = [
    recipe.mirror && "mirrored",
    recipe.flip && "flipped",
    recipe.rotate && `turned ${recipe.rotate}°`,
    recipe.flipEach && "each caret turned",
    recipe.scale && recipe.scale !== 1 && `×${recipe.scale}`,
    recipe.add && (recipe.from ? "plus a drawn line" : "drawn in phosphor's construction"),
  ].filter(Boolean)
  const base = recipe.from ? `phosphor/${recipe.from}` : "native"
  return steps.length ? `${base} (${steps.join(", ")})` : base
}

const shapesOf = (paths) => paths.map((d) => ["path", { d, fill: "currentColor" }])
/** The box a glyph's geometry occupies on the grid, before any stroke. */
function inkBox(shapes, label) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const push = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${label}: non-finite point`)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  for (const [tag, attrs] of shapes) {
    const value = (key) => Number(attrs[key])
    if (tag === "path") walkPath(attrs.d, push, label)
    else if (tag === "rect") {
      push(value("x"), value("y"))
      push(value("x") + value("width"), value("y") + value("height"))
    } else if (tag === "circle") {
      push(value("cx") - value("r"), value("cy") - value("r"))
      push(value("cx") + value("r"), value("cy") + value("r"))
    }
  }
  if (!Number.isFinite(minX)) throw new Error(`${label}: inks nothing`)
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

/**
 * The box a glyph actually INKS — geometry plus the half-stroke outside it.
 *
 * `inkBox` deliberately stops at the geometry, because `assertFits` adds the
 * half-stroke of the rung it is checking. Comparing an OUTLINE against a FILLED
 * counterpart needs the other number: the outline's whole signal is a stroke
 * centred on its path, so measuring the path alone reports a tick as 4 units
 * tall when it reads as 6, and a counterpart authored to match what the eye
 * sees would be rejected for matching it.
 *
 * A shape that declares `stroke: none` is fill-only and contributes its
 * geometry unexpanded, which is how an authored handle sitting on a stroked
 * rail is measured correctly rather than as if it were outlined too.

/**
 * No stroke may push a glyph's ink outside the grid it is drawn in.
 *
 * Every shape is filled AND inherits the root stroke, so half the heaviest
 * stroke that renders — the widest rung's extra plus the selected-state bump —
 * lies outside its outline. Phosphor draws to a 16-unit padding (1.5 of 24),
 * but a glyph swapped into the map later may be drawn tighter, and this makes
 * that a build failure rather than a clipped corner in a screenshot. Returns
 * the smallest spare margin, for the report the script prints.
 */
function assertFits(shapes, label) {
  const needs = (Math.max(...Object.values(STROKE_FOR_SIZE)) + SELECTED_STROKE_BUMP) / 2
  let spare = Infinity
  for (const shape of shapes) {
    const box = inkBox([shape], label)
    const clearance = Math.min(box.minX, box.minY, GRID - box.maxX, GRID - box.maxY)
    if (clearance < needs) {
      throw new Error(
        `${label}: a <${shape[0]}> has only ${clearance.toFixed(3)} units of clearance inside the ` +
          `${GRID} grid, but its heaviest stroke needs ${needs} — it would clip`
      )
    }
    spare = Math.min(spare, clearance - needs)
  }
  return spare
}

const names = Object.keys(MAP).sort()

/** A kept drawing, read back exactly as it was generated. */
function legacyEntry(name) {
  const data = LEGACY[name]
  if (!data) throw new Error(`${name}: marked legacy but not in tools/icons/legacy-glyphs.json`)
  const origin = `kept: ${data.origin}`
  const box = inkBox(data.shapes, name)
  const needs = (LEGACY_STROKE + SELECTED_STROKE_BUMP) / 2
  let clearance = Infinity
  for (const shape of data.shapes) {
    const b = inkBox([shape], name)
    const room = Math.min(b.minX, b.minY, GRID - b.maxX, GRID - b.maxY) - (shape[1].stroke === "none" ? 0 : needs)
    if (room < 0) throw new Error(`${name}: a kept shape would clip at stroke ${LEGACY_STROKE}`)
    clearance = Math.min(clearance, room)
  }
  const entry = { name, origin, shapes: data.shapes, box, clearance, stroke: LEGACY_STROKE, native: data.origin === "native" }
  if (data.filled) Object.assign(entry, { filled: data.filled, filledBox: inkBox(data.filled, name) })
  return entry
}

const entries = names.map((name) => {
  if (MAP[name].legacy) return legacyEntry(name)
  const recipe = recipeOf(MAP[name])
  const origin = originOf(recipe)
  const label = `${name} (${origin})`
  const source = [...(recipe.from ? readPhosphor(recipe.from) : []), ...(recipe.add ?? [])]
  if (!source.length) throw new Error(`${name}: the recipe draws nothing`)
  const shapes = shapesOf(applyRecipe(source, recipe, label))
  const box = inkBox(shapes, label)
  const clearance = assertFits(shapes, label)
  if (!recipe.filled) return { name, origin, shapes, box, clearance }
  if (!recipe.from) throw new Error(`${name}: only a Phosphor drawing has a fill weight`)
  /*
   * The fill weight is drawn in the same square a frame apart, so it has to be
   * the same SIZE: a counterpart even a unit larger makes the mark jump at the
   * exact moment the eye is on it.
   */
  const filled = shapesOf(applyRecipe(readPhosphor(recipe.from, "fill"), recipe, `${name} (filled)`))
  const filledBox = inkBox(filled, `${name} (filled)`)
  assertFits(filled, `${name} (filled)`)
  const spread = Math.max(Math.abs(box.width - filledBox.width), Math.abs(box.height - filledBox.height))
  if (spread > 1) {
    throw new Error(
      `${name}: the fill weight inks ${filledBox.width.toFixed(1)}x${filledBox.height.toFixed(1)} against ` +
        `the outline's ${box.width.toFixed(1)}x${box.height.toFixed(1)} — the mark would resize on press`
    )
  }
  return { name, origin, shapes, box, clearance, filled, filledBox }
})

const version = JSON.parse(fs.readFileSync(path.join(PHOSPHOR, "package.json"), "utf8")).version

const serialiseShapes = (shapes) =>
  shapes
    .map(([tag, attrs]) => {
      const pairs = Object.entries(attrs)
        .map(([key, value]) => `        ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
        .join("\n")
      return `    [\n      ${JSON.stringify(tag)},\n      {\n${pairs}\n      },\n    ],`
    })
    .join("\n")

const body = entries
  .map(
    ({ name, origin, shapes, box, filled, filledBox, stroke }) => `  ${JSON.stringify(name)}: {
    // ${origin} — inks ${box.width.toFixed(1)}x${box.height.toFixed(1)} of ${GRID}${
      stroke === undefined ? "" : `\n    stroke: ${stroke},`
    }
    shapes: [
${serialiseShapes(shapes)}
    ],${
      filled
        ? `
    // filled — inks ${filledBox.width.toFixed(1)}x${filledBox.height.toFixed(1)} of ${GRID}
    filled: [
${serialiseShapes(filled)}
    ],`
        : ""
    }
  },`
  )
  .join("\n")

const strokeTable = Object.entries(STROKE_FOR_SIZE)
  .map(([size, width]) => `  ${size}: ${width},`)
  .join("\n")

const file = `/**
 * The editor chrome's glyph set.
 *
 * GENERATED by \`tools/build-icons.mjs\` — do not hand-edit. To swap a glyph,
 * change the mapping in that script and re-run it. Drawings are Phosphor
 * ${version} (https://phosphoricons.com, MIT), regular weight, with its fill
 * weight shipped for the marks a toggle draws — except ${entries.filter((e) => e.stroke !== undefined).length} glyphs that keep
 * their earlier artwork (\`stroke\` set; see KEPT DRAWINGS in the script).
 *
 * Phosphor draws on a 256 grid; the generator rewrites each path onto the
 * shared ${GRID}x${GRID} grid, so every glyph keeps the one \`0 0 ${GRID} ${GRID}\` viewBox and
 * the \`size\` a call site asks for is exactly the box it gets.
 *
 *   - Every shape is a FILLED outline: Phosphor's line weight (1.5 of ${GRID}) is
 *     part of the path. The root stroke adds weight on top of it — a little at
 *     the small rungs, see \`STROKE_FOR_SIZE\`, and half a unit more on a pressed
 *     or selected control (see \`css/icons.ts\`).
 *
 *   - A \`filled\` array is Phosphor's fill weight, on the glyphs a toggle draws.
 *     A flood cannot serve a drawing that is already filled, so those carry the
 *     second weight, held by the generator to the outline's ink extent.
 */

export type IconNode = [
  tag: string,
  attrs: Record<string, string | number>,
  children?: IconNode[],
]

/**
 * One glyph: its shapes, on the shared 24 grid. \`filled\` is the toggle's ON
 * drawing; absent, the filled weight paints the same shapes.
 */
export interface IconData {
  shapes: IconNode[]
  filled?: IconNode[]
  /** A kept stroke-family drawing's own weight, in place of the rung table. */
  stroke?: number
}

/**
 * Which weight a glyph is asked for.
 *
 * \`auto\` is the outline, and lets the stylesheet add the extra stroke when the
 * control reports itself selected in a list of its peers — which is how "on
 * means heavier" stays one rule rather than ${entries.length} call sites.
 *
 * \`filled\` is what a TOGGLE asks for while it is on. A heavier line is a
 * relative signal: legible beside the same glyph in its off state, and
 * unreadable on a button sitting on its own, which is exactly the case a mode
 * indicator has to answer. Solid or hollow needs nothing to compare against.
 */
export type IconWeight = "outline" | "filled" | "auto"

/**
 * The only sizes a glyph may be drawn at: the kit's six icon roles in
 * \`tokens.icon\` — marker 12, inline 14, action 16, chrome 18, header 20,
 * feature 24.
 *
 * A union rather than \`number\`, so a size off the ramp fails to compile instead
 * of shipping. Call sites should pass \`tokens.icon.action\` and friends rather
 * than the number, which is what makes the ramp readable at the point of use;
 * this type is the backstop for the ones that do not.
 */
export type IconSize = ${Object.keys(STROKE_FOR_SIZE).join(" | ")}

/**
 * The stroke laid over each rung's outline, in grid units.
 *
 * Phosphor's regular line is 1.5 of 24, which renders 0.75px at 12px — under
 * the 1px floor the chrome holds. A stroke of \`w\` on a filled outline thickens
 * every line by \`w\`, so the small rungs get the difference back and the large
 * ones draw Phosphor's weight untouched: 1.0px at 12, rising to 1.5px at 24.
 *
 * \`tools/build-icons.mjs\` measures every shape's clearance inside the grid and
 * fails the build if the heaviest stroke that renders would clip one.
 */
const STROKE_FOR_SIZE: Record<IconSize, number> = {
${strokeTable}
}

/**
 * The stroke width, published as a custom property the stylesheet can build on.
 *
 * Written ALONGSIDE the \`stroke-width\` attribute rather than instead of it. The
 * attribute is the value that is always right, including with no stylesheet at
 * all; the property is what lets one CSS rule say "pressed is half a unit
 * heavier" without knowing which rung the glyph was drawn at.
 */
export const ICON_STROKE_VARIABLE = "--de-icon-stroke"

/**
 * What marks an \`<svg>\` as one of OURS.
 *
 * The state rule in \`css/icons.ts\` leans on the custom property above, and
 * without this it would also reach two kinds of \`<svg>\` it has no business
 * restyling: the host's own icons, which \`drawHostIcon\` renders inside the
 * inspector exactly as their author drew them, and any \`<svg>\` the app being
 * edited happens to place inside a selected row.
 */
export const ICON_MARKER_ATTRIBUTE = "data-de-glyph"

const ICONS = {
${body}
} as const satisfies Record<string, IconData>

export type IconName = keyof typeof ICONS

export const ICON_NAMES = Object.keys(ICONS) as IconName[]

/** The glyphs that keep their pre-Phosphor drawing. */
export const LEGACY_ICON_NAMES = ${JSON.stringify(entries.filter((e) => e.stroke !== undefined).map((e) => e.name))} as const satisfies readonly IconName[]

/**
 * The kept glyphs authored on the native 16 lattice. They land on whole device
 * pixels only at a multiple of 8, so they may be drawn at \`icon.action\` (16)
 * or \`icon.feature\` (24) and nowhere else; \`test/icon-cases.mjs\` greps the
 * source for a call that breaks this.
 */
export const NATIVE_ICON_NAMES = ${JSON.stringify(entries.filter((e) => e.native).map((e) => e.name))} as const satisfies readonly IconName[]

export const NATIVE_ICON_SIZES = ${JSON.stringify(NATIVE_SIZES)} as const satisfies readonly IconSize[]

const SVG_NS = "http://www.w3.org/2000/svg"

function build(node: IconNode): SVGElement {
  const [tag, attrs, children] = node
  const element = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value))
  for (const child of children ?? []) element.append(build(child))
  return element
}

/**
 * Draw one glyph from its data.
 *
 * Exported so the host's own icon set — served by the loopback \`/icons\` route
 * and offered as variants in the inspector — is drawn by the same rules as
 * these. Two renderers would be two answers to "how big is a glyph", and only
 * one of them would be right.
 */
export function drawIcon(data: IconData, size: IconSize = 16, weight: IconWeight = "auto"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg")
  svg.setAttribute("width", String(size))
  svg.setAttribute("height", String(size))
  svg.setAttribute("viewBox", "0 0 ${GRID} ${GRID}")
  // The root fill is opt-in and the outline is what \`auto\` means. Every shape
  // states its own fill, so this reaches only a drawing that does not.
  svg.setAttribute("fill", weight === "filled" ? "currentColor" : "none")
  svg.setAttribute("stroke", "currentColor")
  const stroke = data.stroke ?? STROKE_FOR_SIZE[size]
  svg.setAttribute("stroke-width", String(stroke))
  svg.style.setProperty(ICON_STROKE_VARIABLE, String(stroke))
  svg.setAttribute("stroke-linecap", "round")
  svg.setAttribute("stroke-linejoin", "round")
  svg.setAttribute(ICON_MARKER_ATTRIBUTE, "")
  svg.setAttribute("aria-hidden", "true")
  // The fill weight when the glyph has one, its own shapes otherwise.
  const shapes = weight === "filled" && data.filled ? data.filled : data.shapes
  for (const node of shapes) svg.append(build(node))
  return svg
}

/**
 * One glyph, sized and decorative.
 *
 * Colour comes from \`currentColor\`, never a token: the same mark is drawn on a
 * rest row, a hovered row and a filled selected row, and only the caller knows
 * which.
 */
export function icon(name: IconName, size: IconSize = 16, weight: IconWeight = "auto"): SVGSVGElement {
  const svg = drawIcon(ICONS[name], size, weight)
  /*
   * The marker carries the NAME, so a stylesheet can say something about one
   * mark — the optical correction for \`Cursor\` in \`css/icons.ts\`. Set here
   * and not in \`drawIcon\`, because \`drawIcon\` also renders the HOST app's own
   * icons, whose names belong to a set this package did not author.
   */
  svg.setAttribute(ICON_MARKER_ATTRIBUTE, name)
  return svg
}

/**
 * A glyph from the HOST's own icon set, which is a different set of rules.
 *
 * The app being edited ships its own icons, served by the loopback \`/icons\`
 * route so the inspector can offer one in place of another. Those are drawn the
 * way their author drew them: one weight, whatever grid and stroke they use,
 * nothing normalised. This editor does not get to re-window a glyph it is about
 * to write into someone else's source.
 */
export interface HostIconData {
  nodes: IconNode[]
  rootFill: string
  rootStroke?: string
}

export function drawHostIcon(data: HostIconData, size: IconSize = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg")
  svg.setAttribute("width", String(size))
  svg.setAttribute("height", String(size))
  svg.setAttribute("viewBox", "0 0 ${GRID} ${GRID}")
  svg.setAttribute("fill", data.rootFill === "none" ? "none" : "currentColor")
  if (data.rootStroke) {
    svg.setAttribute("stroke", "currentColor")
    svg.setAttribute("stroke-width", "2")
    svg.setAttribute("stroke-linecap", "round")
    svg.setAttribute("stroke-linejoin", "round")
  }
  svg.setAttribute("aria-hidden", "true")
  for (const node of data.nodes) svg.append(build(node))
  return svg
}
`

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : ""
  if (current !== file) {
    console.error("STALE src/core/icons.ts — run `node tools/build-icons.mjs`")
    process.exit(1)
  }
  console.log(`PASS src/core/icons.ts matches phosphor ${version} + kept drawings (${names.length} glyphs)`)
  process.exit(0)
}

fs.writeFileSync(OUT, file)
const tightest = entries.reduce((a, b) => (a.clearance < b.clearance ? a : b))
console.log(
  `Wrote ${path.relative(root, OUT)} — ${names.length} glyphs from phosphor ${version} ` +
    `(${entries.filter((entry) => entry.stroke !== undefined).length} kept from the previous set, ` +
    `${entries.filter((entry) => entry.filled).length} with a filled counterpart)\n` +
    `  least spare clearance: ${tightest.name} at ${tightest.clearance.toFixed(3)} units`
)
