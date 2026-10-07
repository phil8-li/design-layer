/*
 * Round 5: fine-tuning a vibe-coded app the way a designer works in Figma
 * (designlayer-demos/story/capture-tune.mjs). Rewrite the subtitle in place,
 * Alt-measure the headline to it and open up the auto-layout gap, give the
 * button the design system's radius, ask the agent for a border shimmer on
 * hover and watch it arrive, then see every page on the canvas.
 *
 *   M · Layers        L's layers, smoothed: each piece lifts off the page while it's tuned
 *   N · Multiplayer   You and your agent on one page; tool keys frame the work (after Cua's launch film)
 *   O · Canvas        it starts and ends on the canvas: zoom into one page, tune it, zoom back out
 */
import { INDIGO, LILAC, kit, mixHex, around, sizeLabel, CURSOR_SVG } from "./cuts.js"

const SESSION = "midday-tune"
const GAPS = [24, 26, 28, 30, 32, 34, 36]
const HOVERS = Array.from({ length: 16 }, (_, i) => `hover-${String(i).padStart(2, "0")}`)
const FRAMES = ["app", "bare", "copy-sel", "copy-edit", "copy-all", "copy-typed", "copy-done", "measure-sel", "measure", "group-sel", ...GAPS.map((g) => `gap-${g}`), "gap-set",
  "cta-sel", "token-picker", "token-set", "note-empty", "note-text", "note-saved", "changes", "sent", "after", "hover-in-1", "hover-in-2", "hover-in-3", ...HOVERS, "canvas-near", "canvas-fit"]
const ORDER = Object.fromEntries(FRAMES.map((f, i) => [f, i]))
const COPY_LEN = "Fine-tune the app you vibe coded, like a Figma file.".length
const NOTE_LEN = "Add a shimmer to the border on hover.".length
const cut = (fn) => Object.assign(fn, { session: SESSION, frames: FRAMES, fields: { typeCopy: ["copyTyped", "copy-typed"], typeNote: ["composerField", "note-text"] } })
const pad = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + p * 2, h: r.h + p * 2 })

/* ---------- icons for captions and tool keys ---------- */
const sv = (body, stroke = "currentColor") => `<svg viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
export const ICON = {
  select: (c) => sv('<path d="M5 3l14 7.5-6.2 1.6L10 18.5z" fill="CURRENT"/>'.replace("CURRENT", c ?? "currentColor"), c),
  text: (c) => sv('<path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6"/>', c),
  measure: (c) => sv('<path d="M12 4v16M8 4h8M8 20h8"/><path d="M15 9.5l2.5 2.5-2.5 2.5" opacity=".0"/>', c),
  layout: (c) => sv('<rect x="5" y="4" width="14" height="5" rx="1.5"/><rect x="5" y="15" width="14" height="5" rx="1.5"/><path d="M12 10.5v3"/>', c),
  radius: (c) => sv('<path d="M5 19v-6a8 8 0 0 1 8-8h6"/>', c),
  token: (c) => sv('<path d="M12 3l8 9-8 9-8-9z"/>', c),
  note: (c) => sv('<path d="M5 5h14v10H10l-5 4z"/>', c),
  agent: (c) => sv('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>', c),
  canvas: (c) => sv('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>', c),
  send: (c) => sv('<path d="M4 12l16-8-6 16-3-7z"/>', c),
}

/* ---------- the session ---------- */
function targetsTune(R) {
  const c = (r, fx = 0.5, fy = 0.5) => ({ x: r.x + r.w * fx, y: r.y + r.h * fy })
  return {
    sub: c(R.sub, 0.5, 0.5),
    subDbl: c(R.sub, 0.72, 0.7),
    h1: c(R.h1, 0.3, 0.3),
    gap: c(R.gapLabel),
    cta: c(R.ctaNow, 0.5),
    token: c(R.radiusToken, 0.4),
    tokenRow: c(R.tokenRow, 0.3),
    notes: c(R.toolNotes),
    ctaNote: c(R.ctaNote, 0.7),
    save: { x: R.composer.x + R.composer.w - 38, y: R.composer.y + R.composer.h - 15 },
    changes: c(R.changesTab),
    send: c(R.send),
    appCta: c(R.appCtaAfter),
  }
}
/** Framings in shot px: [x, y, scale]. */
const CAM = { FULL: [800, 500, 0.9], COPY: [800, 410, 1.9], GROUP: [1010, 330, 1.3], TOKEN: [1090, 405, 1.42], NOTE: [860, 560, 2.0], SEND: [1120, 300, 1.5], APPCTA: [800, 528, 3.0] }
const key = (t, name, e) => [t, ...CAM[name], e]
const gapValue = (t, A, H) => 24 + 12 * H.prog(t, A.scrub[0], A.scrub[1] - A.scrub[0], H.E.io)
function gapFrames(frames, g) {
  const i = Math.min(5, Math.floor((g - 24) / 2)), f = (g - 24) / 2 - i
  frames[`gap-${24 + 2 * i}`] = 1
  if (f > 0.001) frames[`gap-${26 + 2 * i}`] = f
}
/** A crossfade between two captured states, whichever is on top in the stack. */
function xfade(frames, from, to, p) {
  if (p >= 1) { frames[to] = 1; return }
  if (ORDER[to] > ORDER[from]) { frames[from] = 1; if (p > 0) frames[to] = p }
  else { frames[to] = 1; frames[from] = 1 - p }
}
/** The frames on screen at t: the session's states on the action times in A. */
function sessionFrames(t, A, H) {
  const { prog, E } = H
  const frames = {}
  const seq = [
    ["copy-sel", A.subClick, 0.16], ["copy-edit", A.dbl, 0.12], ["copy-all", A.selAll, 0.08], ["copy-typed", A.type[0], 0.05], ["copy-done", A.enter, 0.25],
    ["measure-sel", A.h1Click, 0.16], ["measure", A.alt, 0.12], ["measure-sel", A.altUp, 0.12], ["group-sel", A.parent, 0.16],
    ["SCRUB", A.scrub[0], A.scrub[1] - A.scrub[0]], ["gap-set", A.scrub[1] + 0.1, 0.14],
    ["cta-sel", A.ctaClick, 0.16], ["token-picker", A.tokenField, 0.16], ["token-set", A.token, 0.25],
    ["note-empty", A.noteAt, 0.2], ["note-text", A.note[0], 0.06], ["note-saved", A.save, 0.24], ["changes", A.changes, 0.3], ["sent", A.send, 0.26],
    ["after", A.collapse, 0.45], ["HOVER", A.hover, 99],
  ]
  let from = "bare", done = false
  for (const [name, at, dur] of seq) {
    if (at == null || t < at) break
    if (name === "SCRUB") {
      if (t < at + dur) { gapFrames(frames, gapValue(t, A, H)); done = true; break }
      from = "gap-36"
      continue
    }
    if (name === "HOVER") {
      // the light fades in, then runs round and round, ten frames a second
      const h = t - at
      if (h < 0.3) xfade(frames, "after", `hover-in-${Math.min(3, 1 + Math.floor(h / 0.1))}`, 1)
      else frames[HOVERS[Math.floor((h - 0.3) * 10) % 16]] = 1
      done = true
      break
    }
    if (t < at + dur) { xfade(frames, from, name, prog(t, at, dur, E.linear)); done = true; break }
    from = name
  }
  if (!done) frames[from] = 1
  return frames
}
function sessionTune(t, S, A, P, H, label) {
  const { prog, E, path, R } = H
  S.frames = sessionFrames(t, A, H)
  // the editor steps aside for the agent: its panels slide out over the app
  if (A.collapse != null && t >= A.collapse && t < A.collapse + 0.6) {
    const q = prog(t, A.collapse, 0.55, E.io)
    S.strips = { pl: 1 - q, pr: 1 - q }
  }
  const typed = (a, b, n) => Math.floor(prog(t, a, b - a, E.linear) * n + 1e-6) / n
  if (t >= A.type[0] && t < A.enter + 0.05) S.typing = { field: R.typeCopy, p: typed(A.type[0], A.type[1], COPY_LEN), caret: true }
  if (t >= A.note[0] && t < A.save + 0.05) S.typing = { field: R.typeNote, p: typed(A.note[0], A.note[1], NOTE_LEN), caret: true }
  if (P && t >= P[0][0] - 0.3 && t <= P[P.length - 1][0] + (A.pointerHold ?? 1)) {
    let at = path(t, P), press = 0, ring = null
    // the scrub: the pointer holds the gap's label and moves with the value
    if (t >= A.scrub[0] - 0.08 && t <= A.scrub[1] + 0.08) {
      const X = targetsTune(R)
      at = { x: X.gap.x + (gapValue(t, A, H) - 24), y: X.gap.y }
      press = 1
    }
    for (const c of A.clicks) {
      press = Math.max(press, Math.max(0, 1 - Math.abs(t - c) / 0.1))
      if (t >= c && t < c + 0.45) ring = { x: at.x, y: at.y, q: (t - c) / 0.45 }
    }
    const fadeIn = prog(t, P[0][0] - 0.3, 0.3), fadeOut = 1 - prog(t, P[P.length - 1][0] + (A.pointerHold ?? 1) - 0.3, 0.3)
    S.cursor = { x: at.x, y: at.y, press, op: Math.min(fadeIn, fadeOut), label }
    S.ring = ring
  }
}
function pointerTune(A, X, start) {
  return [
    start, [A.subClick, X.sub.x, X.sub.y], [A.dbl, X.subDbl.x, X.subDbl.y], [A.type[1], X.subDbl.x + 40, X.subDbl.y + 60],
    [A.h1Click, X.h1.x, X.h1.y], [A.alt - 0.15, X.sub.x - 10, X.sub.y + 4], [A.altUp, X.sub.x - 10, X.sub.y + 4],
    [A.scrub[0] - 0.12, X.gap.x, X.gap.y], [A.scrub[1] + 0.12, X.gap.x + 12, X.gap.y],
    [A.ctaClick, X.cta.x, X.cta.y], [A.tokenField, X.token.x, X.token.y], [A.token, X.tokenRow.x, X.tokenRow.y], [A.token + 0.5, X.tokenRow.x - 30, X.tokenRow.y + 40],
    [A.notesTool - 0.6, 900, 860], [A.notesTool, X.notes.x, X.notes.y], [A.noteAt, X.ctaNote.x, X.ctaNote.y], [A.note[1] + 0.1, X.ctaNote.x + 60, X.ctaNote.y + 70],
    [A.save, X.save.x, X.save.y], [A.changes, X.changes.x, X.changes.y], [A.send, X.send.x, X.send.y],
  ]
}
const clicksOf = (A) => [A.subClick, A.dbl - 0.12, A.dbl, A.h1Click, A.ctaClick, A.tokenField, A.token, A.notesTool, A.noteAt, A.save, A.changes, A.send]

/* ---------- shared pieces ---------- */
const CAPTION = { size: 46, weight: 400, tracking: -0.02 }
/** A caption in the manner of Cua's: an icon, a bold lead, words that arrive softly. */
const UNITS = {}
export const caption = (id, text, icon) => {
  UNITS[id] = (icon ? 1 : 0) + text.trim().split(/\s+/).length
  return { id, kind: "text", text, icon, ...CAPTION }
}
export function showCaption(N, K, H, id, at, out, { x = 960, y = 1005 } = {}) {
  const n = UNITS[id]
  if (H.t < at - 0.05 || H.t >= out + 0.6) return
  N[id] = { x, y, units: K.exit(K.rise(H.t, at, n, { st: 0.055, din: 0.7, dist: 16, blur: 8 }), H.t, out, { st: 0.02, dout: 0.4 }) }
}
/** The agent's pointer, with its name on it. */
export const AGENT_NODE = { id: "agent", kind: "html", cls: "agentc", html: `${CURSOR_SVG}<div class="ctag">Agent</div>` }
/** The end card: two lines, the second in the italic serif; the name, a button, the address. */
function endNodes() {
  return [
    { id: "e1", kind: "text", text: "Fine-tune the app", size: 104, weight: 680, tracking: -0.045, mask: true },
    { id: "e2", kind: "text", text: "*you just vibe coded.*", size: 112, weight: 400, tracking: -0.02, mask: true },
    { id: "eLogo", kind: "html", html: `<div style="display:flex;align-items:center;gap:16px;font:600 38px/1 InterFilm, sans-serif;letter-spacing:-0.03em;color:#f5f5f7;white-space:nowrap"><img src="../../assets/brand/icon-512.png" style="width:56px;height:56px" alt="">Design Layer</div>` },
    { id: "eBtn", kind: "html", cls: "endbtn", html: "Get it on GitHub" },
    { id: "eUrl", kind: "text", text: "github.com/phil8-li/design-layer", size: 24, weight: 500, tracking: 0, font: "mono", color: "#8e8e93" },
  ]
}
function endCard(N, K, H, at, { y0 = 330 } = {}) {
  const { prog, t } = H
  if (t < at - 0.05) return
  N.e1 = { x: 960, y: y0, units: K.mask(t, at, 3, { st: 0.07, din: 0.8 }) }
  N.e2 = { x: 960, y: y0 + 118, units: K.mask(t, at + 0.18, 4, { st: 0.07, din: 0.8 }) }
  const a = prog(t, at + 0.9, 0.7)
  N.eLogo = { x: 960, y: y0 + 270 + 14 * (1 - a), op: a }
  const b = prog(t, at + 1.15, 0.7)
  N.eBtn = { x: 960, y: y0 + 372 + 14 * (1 - b), op: b }
  const c = prog(t, at + 1.4, 0.7)
  N.eUrl = { x: 960, y: y0 + 450 + 10 * (1 - c), op: c }
}

/* ---------- the canvas: two captures of the board, zoomed as one ---------- */
/*
 * Board space is the fit capture (1600 × 1000). The near capture is the same
 * board magnified round the home page's frame; matching that frame in both
 * places it inside board space, so one zoom drives both and the near one
 * fades out where the fit one is sharp enough.
 */
export function canvasSpace(R) {
  const fit = R.canvasFitHome, near = R.canvasNearHome
  const m = fit.w / near.w
  return { fit, near, m, nearRect: { x: fit.x - near.x * m, y: fit.y - near.y * m, w: 1600 * m, h: 1000 * m } }
}
export const FIT_SRC = { x: 0, y: 0, w: 1600, h: 520 }
export const CANVAS_NODES = [
  { id: "cvFit", kind: "plate", cls: "boardplate", frame: "canvas-fit", src: FIT_SRC, w: 1600, h: 520 },
  { id: "cvNear", kind: "plate", cls: "boardplate", frame: "canvas-near", src: { x: 0, y: 0, w: 1600, h: 1000 }, w: 1600, h: 1000 },
]
/**
 * The board on screen at zoom z (screen px per board px), with board point
 * `focus` at screen point `at`. Returns node states for both captures.
 */
export function canvasStates(R, z, focus, at, extra = {}) {
  const cs = canvasSpace(R)
  const place = (rect) => ({ x: at.x + (rect.x + rect.w / 2 - focus.x) * z, y: at.y + (rect.y + rect.h / 2 - focus.y) * z, w: rect.w * z, h: rect.h * z })
  const fitR = place(FIT_SRC), nearR = place(cs.nearRect)
  // the near capture carries the detail while the board is magnified past ~2×
  const nearOp = Math.max(0, Math.min(1, (z - 1.7) / 0.9))
  return {
    // the board keeps eight pages live at a time: its two top rows, so the rest fades out below them
    cvFit: { ...fitR, ...extra, op: extra.op ?? 1, css: { webkitMaskImage: "linear-gradient(#000 78%, transparent)", maskImage: "linear-gradient(#000 78%, transparent)" } },
    cvNear: { ...nearR, ...extra, z: (extra.z ?? 0) + 0.5, op: (extra.op ?? 1) * nearOp },
  }
}

/* ---------- tool keys: the motif of N, after Cua's keycaps ---------- */
const rnd = (i, k) => { const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return v - Math.floor(v) }
const TILE_N = 40
const TILE_LOOK = ["", "ink", "dark", "", "lilac", "", "dark", "", "ink", ""]
const TILE_ICON = [ICON.select, ICON.text, ICON.measure, ICON.layout, ICON.radius, ICON.note, ICON.agent, ICON.canvas, ICON.token, ICON.send]
const iconInk = (look) => (look === "ink" ? "#ffffff" : look === "dark" ? "#a5b2ff" : look === "lilac" ? "#2b37a8" : "#2a2d3a")
const TILE_NODES = Array.from({ length: TILE_N }, (_, i) => {
  const look = TILE_LOOK[i % TILE_LOOK.length]
  const icon = i % 3 === 2 ? null : TILE_ICON[(i * 7) % TILE_ICON.length]
  return { id: `tl${i}`, kind: "html", parent: "back", cls: `tile ${look}`.trim(), html: icon ? icon(iconInk(look)) : "" }
})
/** Drifting in depth, the middle kept clear for words. */
function tileScatter(i, t) {
  const r = (k) => rnd(i, k)
  let x = (r(1) * 2 - 1) * 1150, y = (r(2) * 2 - 1) * 660
  const ex = x / 640, ey = y / 290, d = Math.hypot(ex, ey)
  if (d < 1.15) { x *= 1.15 / Math.max(d, 0.2); y *= 1.15 / Math.max(d, 0.2) }
  return { x: 960 + x + 28 * Math.sin(t * 0.33 + i * 1.7), y: 540 + y + 18 * Math.cos(t * 0.29 + i * 2.1), z: -950 + r(3) * 1250,
    rx: (r(4) * 2 - 1) * 38 + 9 * Math.sin(t * 0.4 + i), ry: (r(5) * 2 - 1) * 46 + 11 * Math.cos(t * 0.31 + i), rz: (r(6) * 2 - 1) * 32, s: 0.55 + r(7) * 0.6 }
}
/** An arc over the window, keys tilted towards us; the rest further back. */
function tileArc(i, t) {
  const ringN = 26
  if (i >= ringN) { const p = tileScatter(i, t); return { ...p, z: p.z - 500, s: p.s * 0.9 } }
  const a = Math.PI * (0.93 + (i / (ringN - 1)) * 1.14)
  const wob = 6 * Math.sin(t * 0.8 + i * 0.9)
  return { x: 960 + Math.cos(a) * 830, y: 590 + Math.sin(a) * 560 + wob, z: -80 + 40 * rnd(i, 9), rx: 24 + 6 * Math.sin(t * 0.5 + i), ry: -Math.cos(a) * 28, rz: (rnd(i, 6) * 2 - 1) * 10, s: 0.52 + 0.08 * rnd(i, 8) }
}
/** Two pointers drawn in keys, either side of the window: you, and your agent. */
const ARROW = [[0, 0], [0, 10], [2.6, 7.6], [4.4, 11.4], [6, 10.7], [4.3, 7], [7.5, 7], [0, 0]]
const arrowPoints = (() => {
  const seg = []
  let total = 0
  for (let j = 0; j < ARROW.length - 1; j++) { const [ax, ay] = ARROW[j], [bx, by] = ARROW[j + 1]; const l = Math.hypot(bx - ax, by - ay); seg.push([ax, ay, bx, by, l]); total += l }
  return (n) => Array.from({ length: n }, (_, k) => {
    let d = (k / n) * total
    for (const [ax, ay, bx, by, l] of seg) { if (d <= l) return [ax + ((bx - ax) * d) / l, ay + ((by - ay) * d) / l]; d -= l }
    return [0, 0]
  })
})()
function tileCursors(i, t) {
  const pts = arrowPoints(20)
  const right = i >= 20, [ux, uy] = pts[i % 20]
  const u = 40
  // the left pointer aims up and in at the window; the right one is its mirror
  const x = right ? 1690 - ux * u : 230 + ux * u, y = 300 + uy * u
  return { x: x + 6 * Math.sin(t * 1.1 + i), y: y + 5 * Math.cos(t * 0.9 + i), z: -40, rx: 18, ry: right ? -14 : 14, rz: 0, s: 0.32 }
}
/** Out past the edges of the frame, for the canvas. */
function tileAway(i, t) {
  const p = tileScatter(i, t)
  const dx = p.x - 960, dy = p.y - 540, d = Math.max(1, Math.hypot(dx, dy))
  return { ...p, x: 960 + (dx / d) * 1500, y: 540 + (dy / d) * 1000 }
}
const mixPose = (a, b, p) => ({ x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, z: a.z + (b.z - a.z) * p, rx: a.rx + (b.rx - a.rx) * p, ry: a.ry + (b.ry - a.ry) * p, rz: a.rz + (b.rz - a.rz) * p, s: a.s + (b.s - a.s) * p })
/** Each key's pose at t from a list of [time, formation]; keys travel one after another, rising as they go. */
function tilePoses(N, H, t, plan, opacity = 1) {
  for (let i = 0; i < TILE_N; i++) {
    let pose = plan[0][1](i, t)
    for (let j = 1; j < plan.length; j++) {
      const [at, form] = plan[j]
      const p = H.prog(t, at + i * 0.011, 1.1, H.E.io)
      if (p <= 0) break
      pose = mixPose(pose, form(i, t), p)
      // they dip back as they travel, so they pass behind the window, never across it
      pose.z -= 160 * Math.sin(Math.PI * p)
    }
    // depth of field: keys away from the focal plane go soft
    const blur = Math.min(7, Math.max(0, Math.abs(pose.z + 60) / 210 - 0.35))
    N[`tl${i}`] = { ...pose, blur, op: opacity }
  }
}

export const CUTS = {
  /* =================================================================
     M · Layers: L, with every lift smooth
     ================================================================= */
  m: cut(function (H) {
    const { R, E, FIT, prog, track, lerp } = H
    const K = kit(H)
    const X = targetsTune(R)
    const A = { open: 0, openDur: 0.01, subClick: 4.8, dbl: 5.45, selAll: 6.55, type: [6.75, 7.95], enter: 8.15, h1Click: 9.3, alt: 9.9, altUp: 10.85, parent: 11.05, scrub: [12.25, 13.45],
      ctaClick: 14.85, tokenField: 15.6, token: 16.75, notesTool: 18.3, noteAt: 18.8, note: [19.2, 20.6], save: 21.0, changes: 21.5, send: 22.1, collapse: 22.85, hover: 24.45 }
    A.clicks = clicksOf(A)
    A.pointerHold = 0.6
    const P = pointerTune(A, X, [4.3, 1100, 820])
    const END = 35.8
    const PL = (id, frame, src, w, parent = "back") => ({ id, kind: "plate", parent, frame, src, w, h: (w * src.h) / src.w })
    const full = { x: 0, y: 0, w: 1600, h: 1000 }
    const left = { x: 0, y: 0, w: 280, h: 1000 }, right = { x: 1320, y: 0, w: 280, h: 1000 }, bar = pad(R.toolbar, 8)
    const PW = 1300
    const k = PW / 1600
    // what lifts: the subtitle while it is rewritten, the hero group while its gap opens, the token picker
    const copySrc = { x: 488, y: 372, w: 624, h: 92 }
    const groupSrc = pad(R.groupAfter, 16)
    const pickSrc = { x: 1322, y: 297, w: 276, h: 171 }
    const ctaSrc = pad(R.ctaNow, 24)
    const copyFrames = ["copy-sel", "copy-edit", "copy-all", "copy-typed", "copy-done"]
    const groupFrames = ["group-sel", ...GAPS.map((g) => `gap-${g}`), "gap-set"]
    return {
      duration: END,
      nodes: [
        PL("pApp", "app", full, PW),
        PL("pBare", "bare", full, PW),
        PL("pLeft", "bare", left, 280 * k),
        PL("pRight", "bare", right, 280 * k),
        PL("pBar", "bare", bar, bar.w * k),
        { id: "t1", kind: "text", text: "You just vibe coded an app.", size: 96, weight: 700, tracking: -0.045 },
        { id: "t2", kind: "text", text: "Now give it a design layer.", size: 96, weight: 700, tracking: -0.045, color: LILAC },
        { ...PL("lCopy", "copy-sel", copySrc, copySrc.w, "front"), frames: copyFrames, cls: "liftplate" },
        { ...PL("lGroup", "group-sel", groupSrc, groupSrc.w, "front"), frames: groupFrames, cls: "liftplate" },
        { id: "mLine", kind: "html", cls: "measure", parent: "front", html: '<div class="ln"></div><div class="tk" style="top:0"></div><div class="tk tk2"></div><div class="lb"></div>' },
        { ...PL("lPick", "token-picker", pickSrc, pickSrc.w, "front"), cls: "liftplate" },
        { ...PL("lCta", "cta-sel", ctaSrc, ctaSrc.w, "front"), frames: ["cta-sel", "token-picker", "token-set"], cls: "liftplate" },
        { id: "chip", kind: "html", parent: "front", html: '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-radius:12px;background:#2a2d3a;box-shadow:0 0 0 1px rgba(165,178,255,.5),0 18px 40px rgba(0,0,0,.5);font:600 22px/1 InterFilm,sans-serif;color:#e5e8ff;white-space:nowrap"><span style="width:18px;height:18px;border:2.5px solid #a5b2ff;border-radius:6px 2px 2px 2px;border-right:0;border-bottom:0"></span>radius · 8px</div>' },
        AGENT_NODE,
        ...CANVAS_NODES,
        caption("c0", "Fine-tune it **like a Figma file.**", ICON.select("#a5b2ff")),
        caption("c1", "**Edit the copy,** right on the page.", ICON.text("#a5b2ff")),
        caption("c2", "**Measure** the spacing. **Tune it** with auto layout.", ICON.measure("#a5b2ff")),
        caption("c3", "**Use your design system's** tokens.", ICON.radius("#a5b2ff")),
        caption("c4", "**Ask for** what you can't drag.", ICON.note("#a5b2ff")),
        caption("c5", "**Send it** to your agent.", ICON.send("#a5b2ff")),
        caption("c6", "**Your agent** builds it.", ICON.agent("#5eead4")),
        caption("c7", "**See every page** on one canvas.", ICON.canvas("#a5b2ff")),
        ...endNodes(),
      ],
      render(t, S, Hs) {
        const N = S.nodes
        H.t = t
        // ---- 1. the app as a plane; the design layer lands on it; the stack turns to face us ----
        const face = prog(t, 2.3, 1.4, E.io)
        const rx = lerp(56, 0, face), rz = lerp(-22 + 6 * Math.min(t, 2.3) / 2.3, 0, face)
        const cz = lerp(-220 + 60 * prog(t, 0, 2.3, E.soft), 0, face)
        const px = lerp(1070, 960, face), py = lerp(600, 540, face)
        const fade = t >= 4.15 ? 1 : 0
        if (t < 4.25) {
          N.pApp = { x: px, y: py, z: cz - 2 * face, rx, rz, op: prog(t, 0.05, 0.5) * (1 - fade) }
          const land = prog(t, 0.85, 1.05, E.io)
          const lz = lerp(560, 2, land)
          const lop = prog(t, 0.75, 0.35)
          for (const [id, src] of [["pLeft", left], ["pRight", right], ["pBar", bar]]) {
            const dx = (src.x + src.w / 2 - 800) * k, dy = (src.y + src.h / 2 - 500) * k
            N[id] = { x: px + dx, y: py + dy, z: cz + lz, rx, rz, ox: -dx, oy: -dy, op: lop * (1 - prog(t, 2.35, 0.15, E.linear)) }
          }
          N.pBare = { x: px, y: py, z: cz + 1 - 2 * face, rx, rz, op: prog(t, 1.85, 0.4, E.linear) * (1 - fade) }
          N.t1 = { x: 130, y: 170, anchor: "left", units: K.exit(K.rise(t, 0.25, 6, { st: 0.07 }), t, 2.7) }
          if (t >= 0.95) N.t2 = { x: 130, y: 285, anchor: "left", units: K.exit(K.rise(t, 1.05, 6, { st: 0.06, dist: -44 }), t, 2.8) }
        }

        // ---- the editor; it tilts a little while a piece of it is lifted ----
        const up = (a, d, b, e = 0.7) => prog(t, a, d, E.io) * (1 - prog(t, b, e, E.io))
        const uCopy = up(5.55, 0.9, 8.25), uGroup = up(11.35, 0.85, 13.6), uCta = up(14.95, 0.8, 16.95), uPick = up(15.7, 0.7, 16.95, 0.65)
        const tl = Math.max(uCopy, uGroup, uCta)
        const w = { op: prog(t, 3.65, 0.5, E.linear), x: 0, y: -16, s: PW / 1440, rx: -5 * tl, ry: -8 * tl, rz: 0 }
        S.win = w
        S.cam = track(t, [
          [0, ...CAM.FULL], key(4.95, "FULL"), key(5.45, "COPY"), key(8.95, "COPY"), key(9.35, "FULL"), key(10.95, "FULL"), key(11.3, "GROUP"), key(14.3, "GROUP"),
          key(14.75, "TOKEN"), key(17.65, "TOKEN"), key(18.1, "FULL"), key(18.35, "FULL"), key(18.75, "NOTE"), key(21.15, "NOTE"), key(21.4, "SEND"), key(22.4, "SEND"),
          key(22.95, "FULL"), key(23.3, "FULL"), key(23.9, "APPCTA"), key(26.3, "APPCTA"), key(26.8, "FULL"),
        ])
        if (t >= 3.6) sessionTune(t, S, A, P, H)
        S.glow = { op: 0.22 * prog(t, 0.9, 1.0) * (1 - prog(t, 3.8, 0.8)) + 0.32 * prog(t, 24.5, 0.8) * (1 - prog(t, 26.6, 0.8)) + 0.5 * prog(t, 30.6, 1.2), s: 1.2 }

        // a lifted piece: it starts exactly where it sits on the page, so nothing jumps, and
        // rises on the same curve that tilts the page, its corners and shadow coming with it
        const lift = (id, src, u, height, frames, typing) => {
          if (u <= 0.0005) return
          const o = Hs.onWindow(S, src.x + src.w / 2, src.y + src.h / 2, height * u)
          const mag = 1 + 0.18 * u
          const fr = {}
          for (const f of frames) if (S.frames[f]) fr[f] = S.frames[f]
          if (!Object.keys(fr).length) fr[frames[0]] = 1
          N[id] = { ...o, w: src.w * o.k * mag, h: src.h * o.k * mag, frames: fr, typing,
            css: { borderRadius: `${(14 * u).toFixed(1)}px`, boxShadow: `0 0 0 1px rgba(255,255,255,${(0.14 * u).toFixed(3)}), 0 ${(36 * u).toFixed(1)}px ${(90 * u).toFixed(1)}px rgba(0,0,0,${(0.55 * u).toFixed(3)})` } }
        }
        lift("lCopy", copySrc, uCopy, 240, copyFrames, S.typing && S.typing.field === R.typeCopy ? { ...S.typing, t } : null)
        lift("lGroup", groupSrc, uGroup, 220, groupFrames, null)
        lift("lCta", ctaSrc, uCta, 260, ["cta-sel", "token-picker", "token-set"], null)
        if (uPick > 0.0005) {
          const o = Hs.onWindow(S, pickSrc.x + pickSrc.w / 2, pickSrc.y + pickSrc.h / 2, 220 * uPick)
          const mag = 1 + 0.18 * uPick
          N.lPick = { ...o, w: pickSrc.w * o.k * mag, h: pickSrc.h * o.k * mag, css: { borderRadius: `${(14 * uPick).toFixed(1)}px`, boxShadow: `0 0 0 1px rgba(255,255,255,${(0.14 * uPick).toFixed(3)}), 0 ${(36 * uPick).toFixed(1)}px ${(90 * uPick).toFixed(1)}px rgba(0,0,0,${(0.55 * uPick).toFixed(3)})` } }
        }
        // the gap, measured as it opens: a redline between the headline and the subtitle, on the lifted group
        if (uGroup > 0.05 && t >= 11.6 && t < 13.9) {
          const g = t < A.scrub[0] ? 24 : gapValue(t, A, H)
          const top = 366 + (g - 24), bot = 390 + 2 * (g - 24)
          const a = Hs.onWindow(S, 800, top, 220 * uGroup + 1), b = Hs.onWindow(S, 800, bot, 220 * uGroup + 1)
          const len = Math.max(2, b.y - a.y)
          const op = prog(t, 11.7, 0.3) * (1 - prog(t, 13.55, 0.25))
          N.mLine = { x: a.x, y: a.y, z: a.z, rx: a.rx, ry: a.ry, anchor: "topleft", op, sub: { ".ln": { css: { height: `${len.toFixed(1)}px` } }, ".tk2": { css: { top: `${(len - 2).toFixed(1)}px` } }, ".lb": { text: String(Math.round(g)), css: { top: `${(len / 2 - 15).toFixed(1)}px` } } } }
        }
        // the token leaves the picker and lands on the lifted button
        if (t >= A.token - 0.6 && t < A.token + 0.3) {
          const p = prog(t, A.token - 0.55, 0.55, E.io)
          const a = Hs.onWindow(S, X.tokenRow.x + 40, X.tokenRow.y, 220 * uPick + 30), b = Hs.onWindow(S, X.cta.x, X.cta.y, 260 * uCta + 20)
          N.chip = { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) - 170 * Math.sin(Math.PI * p), z: lerp(a.z, b.z, p) + 140 * Math.sin(Math.PI * p), s: 1 - 0.45 * p, op: prog(t, A.token - 0.6, 0.12) * (1 - prog(t, A.token + 0.02, 0.2)) }
        }

        // ---- the agent's pointer arrives and hovers the button ----
        if (t >= 23.5 && t < 26.9) {
          const target = Hs.toScreen(S, X.appCta.x + 18, X.appCta.y + 6)
          const p = prog(t, 23.6, 0.85, E.io)
          N.agent = { x: lerp(target.x + 520, target.x, p), y: lerp(target.y + 260, target.y, p) - 60 * Math.sin(Math.PI * p), anchor: "topleft", op: prog(t, 23.55, 0.25) * (1 - prog(t, 26.4, 0.3)) }
        }

        // ---- the canvas: from the page, out to every page; then the board lies back like the app did ----
        // the page shrinks to the size of its frame on the board, the board comes in round it,
        // and the camera pulls back to every page; then the board lies back like the app did
        if (t >= 26.6) {
          const cs = canvasSpace(R)
          const homeC = { x: cs.fit.x + cs.fit.w / 2, y: cs.fit.y + cs.fit.h / 2 }
          const shrink = prog(t, 26.6, 0.8, E.io)
          const zA = 560 / cs.fit.w // the home frame at 560 px: where the page hands over to the board
          w.s = lerp(PW / 1440, (560 / 1300) * (PW / 1440), shrink)
          w.y = lerp(-16, -16 * (560 / 1300), shrink)
          const zp = prog(t, 27.45, 2.0, E.io)
          const z = Math.exp(lerp(Math.log(zA), Math.log(1.78), zp))
          // end on the two rows of pages the board keeps live, with the panels either side
          const focus = { x: lerp(homeC.x, 812, zp), y: lerp(homeC.y, 300, zp) }
          const tilt = prog(t, 29.7, 1.4, E.io)
          const bandIn = prog(t, 27.2, 0.3, E.linear)
          // a short blur over the swap hides that the board renders the page at its own size
          const swapBlur = 5 * Math.sin(Math.PI * prog(t, 27.15, 0.45, E.linear))
          if (t >= 27.15) {
            const extra = { op: bandIn * (1 - prog(t, 30.3, 0.8, E.io)), rx: 48 * tilt, rz: -14 * tilt, z: -240 * tilt, blur: swapBlur }
            Object.assign(N, canvasStates(R, z, focus, { x: 960, y: lerp(540, 528, zp) + 60 * tilt }, extra))
          }
          if (swapBlur > 0.05) S.frameBlur = swapBlur
          w.op *= 1 - prog(t, 27.3, 0.25, E.linear)
        }

        // ---- captions ----
        showCaption(N, K, H, "c0", 4.25, 5.35)
        showCaption(N, K, H, "c1", 5.6, 8.6)
        showCaption(N, K, H, "c2", 9.5, 13.8)
        showCaption(N, K, H, "c3", 15.05, 17.5)
        showCaption(N, K, H, "c4", 18.7, 21.1)
        showCaption(N, K, H, "c5", 21.45, 22.75)
        showCaption(N, K, H, "c6", 23.9, 26.3)
        showCaption(N, K, H, "c7", 27.4, 29.8)
        endCard(N, K, H, 30.8)
        S.black = Math.max(1 - prog(t, 0, 0.4, E.linear), prog(t, END - 1.0, 1.0, E.io))
      },
    }
  }),
  /* =================================================================
     N · Multiplayer: you and your agent on one page, the tool keys framing the work
     ================================================================= */
  n: cut(function (H) {
    const { R, E, FIT, prog, track, lerp } = H
    const K = kit(H)
    const X = targetsTune(R)
    const A = { open: 0, openDur: 0.01, subClick: 6.0, dbl: 6.6, selAll: 7.6, type: [7.8, 9.0], enter: 9.2, h1Click: 10.25, alt: 10.85, altUp: 11.75, parent: 11.95, scrub: [12.65, 13.85],
      ctaClick: 14.65, tokenField: 15.35, token: 16.45, notesTool: 17.65, noteAt: 18.15, note: [18.55, 19.95], save: 20.35, changes: 20.85, send: 21.45, collapse: 22.25, hover: 23.95 }
    A.clicks = clicksOf(A)
    A.pointerHold = 0.6
    const P = pointerTune(A, X, [5.5, 1100, 820])
    const END = 35
    const WS = 0.78 // flat and centred, framed by the keys
    return {
      duration: END,
      nodes: [
        ...TILE_NODES,
        { id: "i1", kind: "text", text: "You just vibe coded an app.", size: 50, weight: 500, tracking: -0.02 },
        { id: "i2", kind: "text", text: "Now fine-tune it, *like a Figma file.*", size: 50, weight: 500, tracking: -0.02 },
        { id: "mLine", kind: "html", cls: "measure", parent: "front", html: '<div class="ln"></div><div class="tk" style="top:0"></div><div class="tk tk2"></div><div class="lb"></div>' },
        { id: "chip", kind: "html", parent: "front", html: '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-radius:12px;background:#2a2d3a;box-shadow:0 0 0 1px rgba(165,178,255,.5),0 18px 40px rgba(0,0,0,.5);font:600 22px/1 InterFilm,sans-serif;color:#e5e8ff;white-space:nowrap"><span style="width:18px;height:18px;border:2.5px solid #a5b2ff;border-radius:6px 2px 2px 2px;border-right:0;border-bottom:0"></span>radius · 8px</div>' },
        AGENT_NODE,
        ...CANVAS_NODES,
        caption("n1", "**Edit copy** right on the page", ICON.text("#a5b2ff")),
        caption("n2", "**Measure**, then **tune the spacing**", ICON.measure("#a5b2ff")),
        caption("n3", "Pick a **token** from your design system", ICON.radius("#a5b2ff")),
        caption("n4", "**Ask your agent** for the rest", ICON.note("#a5b2ff")),
        caption("n5", "**You and your agent,** on the same page", ICON.agent("#5eead4")),
        caption("n6", "**Every page,** one canvas", ICON.canvas("#a5b2ff")),
        ...endNodes(),
      ],
      render(t, S, Hs) {
        const N = S.nodes
        H.t = t
        // ---- the keys: drifting, then an arc over the work, two pointers for you and the agent, out for the canvas ----
        tilePoses(N, H, t, [[0, tileScatter], [4.3, tileArc], [21.9, tileCursors], [26.3, tileAway], [30.0, tileScatter]], prog(t, 0, 1.4, E.linear))
        // ---- the opening lines, small and centred ----
        if (t < 4.6) {
          N.i1 = { x: 960, y: 500, units: K.exit(K.rise(t, 0.6, 6, { st: 0.07, dist: 14, blur: 8 }), t, 4.0, { st: 0.02 }) }
          N.i2 = { x: 960, y: 572, units: K.exit(K.rise(t, 1.7, 7, { st: 0.07, dist: 14, blur: 8 }), t, 4.05, { st: 0.02 }) }
        }
        // ---- the window rises into the arc; at the canvas it shrinks into its own frame on the board ----
        const rise = prog(t, 4.5, 1.2, E.out)
        const w = { op: prog(t, 4.5, 0.6, E.linear), x: 0, y: 520 * (1 - rise), s: WS, rx: 0, ry: 0, rz: 0 }
        S.win = w
        S.cam = track(t, [
          [0, ...CAM.FULL], key(6.15, "FULL"), key(6.55, "COPY"), key(9.6, "COPY"), key(10.0, "FULL"), key(11.85, "FULL"), key(12.25, "GROUP"), key(14.2, "GROUP"),
          key(14.55, "TOKEN"), key(17.05, "TOKEN"), key(17.4, "FULL"), key(17.75, "FULL"), key(18.1, "NOTE"), key(20.5, "NOTE"), key(20.75, "SEND"), key(21.75, "SEND"),
          key(22.35, "FULL"), key(22.7, "FULL"), key(23.3, "APPCTA"), key(26.1, "APPCTA"), key(26.45, "FULL"),
        ])
        if (t >= 4.5) sessionTune(t, S, A, P, H, "You")
        S.glow = { op: 0.18 * prog(t, 4.6, 1.0) + 0.25 * prog(t, 24.0, 0.8) * (1 - prog(t, 26.3, 0.8)) + 0.3 * prog(t, 30.6, 1.2), s: 1.25 }
        // the gap, measured as it opens
        if (t >= 12.3 && t < 14.1) {
          const g = t < A.scrub[0] ? 24 : gapValue(t, A, H)
          const a = Hs.onWindow(S, 800, 366 + (g - 24), 1), b = Hs.onWindow(S, 800, 390 + 2 * (g - 24), 1)
          const len = Math.max(2, b.y - a.y)
          N.mLine = { x: a.x, y: a.y, anchor: "topleft", op: prog(t, 12.35, 0.25) * (1 - prog(t, 13.95, 0.2)), sub: { ".ln": { css: { height: `${len.toFixed(1)}px` } }, ".tk2": { css: { top: `${(len - 2).toFixed(1)}px` } }, ".lb": { text: String(Math.round(g)), css: { top: `${(len / 2 - 15).toFixed(1)}px` } } } }
        }
        // the token leaves the picker and lands on the button
        if (t >= A.token - 0.6 && t < A.token + 0.3) {
          const p = prog(t, A.token - 0.55, 0.55, E.io)
          const a = Hs.toScreen(S, X.tokenRow.x + 40, X.tokenRow.y), b = Hs.toScreen(S, X.cta.x, X.cta.y)
          N.chip = { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) - 150 * Math.sin(Math.PI * p), s: 1 - 0.4 * p, op: prog(t, A.token - 0.6, 0.12) * (1 - prog(t, A.token + 0.02, 0.2)) }
        }
        // the agent's pointer comes in from the right-hand key pointer
        if (t >= 22.9 && t < 26.4) {
          const target = Hs.toScreen(S, X.appCta.x + 18, X.appCta.y + 6)
          const p = prog(t, 23.0, 0.95, E.io)
          N.agent = { x: lerp(1560, target.x, p), y: lerp(330, target.y, p) - 40 * Math.sin(Math.PI * p), anchor: "topleft", s: 1.35, op: prog(t, 22.95, 0.25) * (1 - prog(t, 25.95, 0.3)) }
        }
        // ---- the canvas: the window shrinks to its frame on the board, and the camera pulls back ----
        if (t >= 26.4) {
          const cs = canvasSpace(R)
          const homeC = { x: cs.fit.x + cs.fit.w / 2, y: cs.fit.y + cs.fit.h / 2 }
          const shrink = prog(t, 26.4, 0.8, E.io)
          const vw = 1440 * WS
          w.s = lerp(WS, WS * (560 / vw), shrink)
          const zp = prog(t, 27.25, 2.0, E.io)
          const z = Math.exp(lerp(Math.log(560 / cs.fit.w), Math.log(1.78), zp))
          const focus = { x: lerp(homeC.x, 812, zp), y: lerp(homeC.y, 300, zp) }
          const swapBlur = 5 * Math.sin(Math.PI * prog(t, 26.95, 0.45, E.linear))
          if (t >= 26.95) Object.assign(N, canvasStates(R, z, focus, { x: 960, y: lerp(540 + w.s * 18, 528, zp) }, { op: prog(t, 27.0, 0.3, E.linear) * (1 - prog(t, 30.0, 0.7, E.io)), blur: swapBlur }))
          if (swapBlur > 0.05) S.frameBlur = swapBlur
          w.op *= 1 - prog(t, 27.1, 0.25, E.linear)
        }
        showCaption(N, K, H, "n1", 6.2, 9.6)
        showCaption(N, K, H, "n2", 10.45, 14.15)
        showCaption(N, K, H, "n3", 14.8, 17.2)
        showCaption(N, K, H, "n4", 17.9, 21.75)
        showCaption(N, K, H, "n5", 22.45, 26.2)
        showCaption(N, K, H, "n6", 27.3, 29.8)
        endCard(N, K, H, 30.4)
        S.black = Math.max(1 - prog(t, 0, 0.6, E.linear), prog(t, END - 1.0, 1.0, E.io))
      },
    }
  }),

  /* =================================================================
     O · Canvas: it starts and ends on the board; in between, one page, tuned
     ================================================================= */
  o: cut(function (H) {
    const { R, E, FIT, prog, track, lerp, rectOf } = H
    const K = kit(H)
    const X = targetsTune(R)
    const A = { open: 0, openDur: 0.01, subClick: 6.1, dbl: 6.7, selAll: 7.7, type: [7.9, 9.1], enter: 9.3, h1Click: 10.15, alt: 10.75, altUp: 11.7, parent: 11.9, scrub: [12.55, 13.75],
      ctaClick: 14.45, tokenField: 15.15, token: 16.3, notesTool: 17.55, noteAt: 18.05, note: [18.45, 19.85], save: 20.25, changes: 20.75, send: 21.35, collapse: 22.35, hover: 24.0 }
    A.clicks = clicksOf(A)
    A.pointerHold = 0.6
    const P = pointerTune(A, X, [5.6, 1100, 820])
    const END = 34.8
    const BIGW = { size: 150, weight: 720, tracking: -0.05, mask: true }
    const winRight = { x: 320, s: 0.66 }
    return {
      duration: END,
      nodes: [
        ...CANVAS_NODES,
        { id: "o0", kind: "text", text: "Every page of the app you *vibe coded.*", size: 58, weight: 600, tracking: -0.03 },
        { id: "o1", kind: "text", text: "Open one. Fine-tune it *like a Figma file.*", size: 58, weight: 600, tracking: -0.03 },
        { id: "box", kind: "sel", line: 3, hs: 16, ls: 22 },
        { id: "wEdit", kind: "text", text: "Edit.", ...BIGW },
        { id: "caret", kind: "html", html: "", style: { width: "8px", height: "128px", background: "#a5b2ff", borderRadius: "3px" } },
        { id: "wMeasure", kind: "text", text: "Measure.", ...BIGW },
        { id: "wSpace", kind: "text", text: "Space.", ...BIGW },
        { id: "bigLine", kind: "html", cls: "measure", html: '<div class="ln" style="width:4px"></div><div class="tk" style="top:0;width:28px;height:4px;left:-12px"></div><div class="tk tk2" style="width:28px;height:4px;left:-12px"></div><div class="lb" style="font-size:34px;padding:7px 14px 8px;left:26px"></div>' },
        { id: "wTokens", kind: "text", text: "Tokens.", ...BIGW },
        { id: "chip", kind: "html", html: '<div style="display:flex;align-items:center;gap:14px;padding:14px 22px;border-radius:16px;background:#2a2d3a;box-shadow:0 0 0 1px rgba(165,178,255,.5),0 18px 40px rgba(0,0,0,.5);font:600 30px/1 InterFilm,sans-serif;color:#e5e8ff;white-space:nowrap"><span style="width:24px;height:24px;border:3px solid #a5b2ff;border-radius:8px 2px 2px 2px;border-right:0;border-bottom:0"></span>radius · 8px</div>' },
        { id: "wAsk", kind: "text", text: "Ask.", ...BIGW },
        { id: "pin", kind: "pin", num: 3, style: { width: "84px", height: "84px", margin: "-42px 0 0 -42px", fontSize: "38px" } },
        { id: "wSend", kind: "text", text: "Send.", ...BIGW },
        AGENT_NODE,
        caption("oc1", "**Your agent** builds it.", ICON.agent("#5eead4")),
        caption("oc2", "**Back to every page,** on one canvas.", ICON.canvas("#a5b2ff")),
        ...endNodes(),
      ],
      render(t, S, Hs) {
        const N = S.nodes
        H.t = t
        const cs = canvasSpace(R)
        const homeC = { x: cs.fit.x + cs.fit.w / 2, y: cs.fit.y + cs.fit.h / 2 }
        const zA = 560 / cs.fit.w
        // ---- 1. the board, lying back, then flat; the camera goes into the home page's frame ----
        if (t < 4.7) {
          const flat = prog(t, 0.2, 2.2, E.io)
          const zp = prog(t, 2.3, 1.6, E.io)
          const z = Math.exp(lerp(Math.log(1.78), Math.log(zA), zp))
          const focus = { x: lerp(812, homeC.x, zp), y: lerp(300, homeC.y, zp) }
          Object.assign(N, canvasStates(R, z, focus, { x: 960, y: lerp(528, 540, zp) + 60 * (1 - flat) }, { op: prog(t, 0, 0.8, E.linear) * (1 - prog(t, 4.05, 0.55, E.linear)), rx: 44 * (1 - flat), rz: -12 * (1 - flat), z: -220 * (1 - flat), blur: 5 * Math.sin(Math.PI * prog(t, 3.7, 0.45, E.linear)) }))
          N.o0 = { x: 960, y: 120, units: K.exit(K.rise(t, 0.5, 8, { st: 0.06, dist: 16 }), t, 2.6) }
        }
        // ---- the page comes out of its frame and fills the window; then the window makes room for words ----
        const grow = prog(t, 3.95, 0.8, E.io), side = prog(t, 5.0, 0.8, E.io)
        const PWs = 1300 / 1440
        const w = { op: prog(t, 3.85, 0.25, E.linear), x: lerp(0, winRight.x, side), y: 0, s: lerp(lerp(PWs * (560 / 1300), PWs, grow), winRight.s, side), rx: 0, ry: 0, rz: 0 }
        if (t < 4.4) S.frameBlur = 5 * Math.sin(Math.PI * prog(t, 3.7, 0.45, E.linear))
        // the agent's turn: the window comes back to the middle, close on the button
        const centre = prog(t, 22.45, 0.8, E.io)
        if (t >= 22.45) { w.x = lerp(winRight.x, 0, centre); w.s = lerp(winRight.s, PWs, centre) }
        S.win = w
        S.cam = track(t, [
          [0, ...CAM.FULL], key(6.25, "FULL"), key(6.65, "COPY"), key(9.6, "COPY"), key(9.95, "FULL"), key(11.8, "FULL"), key(12.15, "GROUP"), key(14.1, "GROUP"),
          key(14.4, "TOKEN"), key(16.95, "TOKEN"), key(17.3, "FULL"), key(17.65, "FULL"), key(18.0, "NOTE"), key(20.4, "NOTE"), key(20.65, "SEND"), key(21.65, "SEND"),
          key(22.45, "FULL"), key(22.8, "FULL"), key(23.4, "APPCTA"), key(26.2, "APPCTA"), key(26.6, "FULL"),
        ])
        if (t >= 3.85) sessionTune(t, S, A, P, H, "You")
        if (t >= 3.95 && t < 6.1) N.o1 = { x: 960, y: 1005, units: K.exit(K.rise(t, 4.1, 8, { st: 0.06, dist: 16, blur: 8 }), t, 5.6) }
        S.glow = { op: 0.2 * prog(t, 0.6, 1.0) * (1 - prog(t, 4.0, 0.8)) + 0.25 * prog(t, 24.1, 0.8) * (1 - prog(t, 26.4, 0.8)) + 0.45 * prog(t, 30.4, 1.2), s: 1.2 }

        // ---- the words, each with the tool that did it ----
        const st = { x: 120, y: 470, anchor: "left" }
        const word = (id, at, out) => { if (t >= at - 0.05 && t < out + 0.5) N[id] = { ...st, units: K.exit(K.mask(t, at, 1), t, out, { mode: "mask" }) } }
        word("wEdit", 5.85, 9.65)
        word("wMeasure", 9.95, 11.85)
        word("wSpace", 11.95, 14.05)
        word("wTokens", 14.3, 17.25)
        word("wAsk", 17.5, 20.9)
        word("wSend", 21.0, 22.2)
        const rE = around(rectOf("wEdit", null, st), 18), rT = around(rectOf("wTokens", null, st), 18)
        // Edit: the word is selected as the subtitle is, and a caret blinks after it while the copy is typed
        if (t >= A.subClick && t < 9.7) N.box = { ...rE, draw: prog(t, A.subClick + 0.05, 0.3, E.io), handles: prog(t, A.subClick + 0.12, 0.35, E.linear), label: "Text", labelOp: prog(t, A.subClick + 0.25, 0.3), op: 1 - prog(t, 9.45, 0.2) }
        if (t >= A.dbl && t < 9.5) {
          const r = rectOf("wEdit", null, st)
          const typing = t >= A.type[0] && t < A.type[1]
          N.caret = { x: r.x + r.w + 18, y: r.y + r.h * 0.52, op: (typing || Math.floor(t * 2.4) % 2 === 0 ? 1 : 0) * prog(t, A.dbl, 0.15) }
        }
        // Measure, then Space: a redline beside the words, its number counting as the gap opens
        if (t >= A.alt - 0.05 && t < 14.1) {
          const g = t < A.scrub[0] ? 24 : gapValue(t, A, H)
          const rw = rectOf(t < 11.9 ? "wMeasure" : "wSpace", null, st)
          const len = 6 * g
          const a = prog(t, A.alt, 0.3) * (1 - prog(t, 13.9, 0.2))
          N.bigLine = { x: rw.x + rw.w + 70, y: 470 - len / 2, anchor: "topleft", op: a, sub: { ".ln": { css: { height: `${len.toFixed(1)}px` } }, ".tk2": { css: { top: `${(len - 4).toFixed(1)}px` } }, ".lb": { text: String(Math.round(g)), css: { top: `${(len / 2 - 26).toFixed(1)}px` } } } }
        }
        // Tokens: the word is selected, and its corners take the token's radius when it lands
        if (t >= A.ctaClick && t < 17.3) {
          const tok = prog(t, A.token, 0.35, E.io)
          N.box = { ...rT, radius: 2 + 26 * tok, draw: prog(t, A.ctaClick + 0.05, 0.3, E.io), handles: prog(t, A.ctaClick + 0.12, 0.35, E.linear), dots: prog(t, A.tokenField, 0.3) * (1 - prog(t, A.token + 0.4, 0.2)), label: tok > 0.5 ? "radius · 8px" : "Corner radius", labelOp: prog(t, A.ctaClick + 0.25, 0.3), op: 1 - prog(t, 17.05, 0.2) }
          const c = prog(t, A.token - 0.05, 0.5, E.linear)
          if (c > 0) N.chip = { x: rT.x + rT.w + 190, y: 470 - 120 + 30 * (1 - E.out(c)), s: K.pop(c), op: Math.min(1, c * 3) * (1 - prog(t, 17.0, 0.25)) }
        }
        // Ask: the note lands as a pin
        if (t >= A.save && t < 21.0) {
          const r = rectOf("wAsk", null, st)
          const p = prog(t, A.save + 0.05, 0.5, E.linear)
          N.pin = { x: r.x + r.w + 56, y: r.y + r.h * 0.38 - 30 * (1 - E.out(p)), s: K.pop(p), op: Math.min(1, p * 3) * (1 - prog(t, 20.75, 0.25)) }
        }
        // ---- the agent's pointer ----
        if (t >= 23.1 && t < 26.5) {
          const target = Hs.toScreen(S, X.appCta.x + 18, X.appCta.y + 6)
          const p = prog(t, 23.2, 0.85, E.io)
          N.agent = { x: lerp(target.x + 520, target.x, p), y: lerp(target.y + 260, target.y, p) - 60 * Math.sin(Math.PI * p), anchor: "topleft", s: 1.35, op: prog(t, 23.15, 0.25) * (1 - prog(t, 26.0, 0.3)) }
        }
        showCaption(N, K, H, "oc1", 23.5, 26.1)
        // ---- back out to the board: the page shrinks to its frame, the camera pulls back ----
        if (t >= 26.5) {
          const shrink = prog(t, 26.5, 0.8, E.io)
          w.s = lerp(PWs, PWs * (560 / 1300), shrink)
          const zp = prog(t, 27.35, 2.0, E.io)
          const z = Math.exp(lerp(Math.log(zA), Math.log(1.78), zp))
          const focus = { x: lerp(homeC.x, 812, zp), y: lerp(homeC.y, 300, zp) }
          const swapBlur = 5 * Math.sin(Math.PI * prog(t, 27.05, 0.45, E.linear))
          if (t >= 27.05) Object.assign(N, canvasStates(R, z, focus, { x: 960, y: lerp(540, 528, zp) }, { op: prog(t, 27.1, 0.3, E.linear) * (1 - prog(t, 30.0, 0.7, E.io)), blur: swapBlur }))
          if (swapBlur > 0.05) S.frameBlur = swapBlur
          w.op *= 1 - prog(t, 27.2, 0.25, E.linear)
        }
        showCaption(N, K, H, "oc2", 27.6, 29.8)
        endCard(N, K, H, 30.3)
        S.black = Math.max(1 - prog(t, 0, 0.5, E.linear), prog(t, END - 1.0, 1.0, E.io))
      },
    }
  }),
}
