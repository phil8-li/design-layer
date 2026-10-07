/*
 * Round 6, shared: the session every round-6 cut plays, and the pieces they are
 * built from. Each cut file (cuts-r6-<id>.js) composes these with its own
 * opening, titles and camera.
 *
 * The session is designlayer-demos/story/capture-r6.mjs: round 5's, with a new
 * agent change. On hover Get started lifts, a sheen crosses it once and a white
 * light runs round the inside of its border, captured as patches round the
 * button, 30 a second.
 *
 * What every cut keeps from the feedback on round 5:
 *   - M's first act: each piece lifts off the page while it is tuned (the
 *     subtitle while it is rewritten, the hero group while its gap opens).
 *     layerAct() is that act, timed from the click on the subtitle.
 *   - No lifted layers after it: the rest is step titles with close-ups
 *     (after O), with the camera doing something different each time.
 *   - The landing page's words and look: near-black, white with a dim grey,
 *     the editor's indigo; two-tone headings whose words light up in turn.
 */
import { kit, around, CURSOR_SVG, LILAC, INDIGO } from "./cuts.js"
import { ICON, caption, showCaption, AGENT_NODE, canvasSpace, canvasStates as boardStates, CANVAS_NODES, FIT_SRC } from "./cuts-tune.js"
export { kit, around, CURSOR_SVG, LILAC, INDIGO, ICON, caption, showCaption, AGENT_NODE, canvasSpace, CANVAS_NODES, FIT_SRC }

/**
 * The board as round 5 zoomed it, without the editor's side panels: magnified with
 * the board they read as clutter, and the story here is every page. Both captures
 * share the editor's layout, so the panels sit at the same share of each.
 */
const BOARD_ONLY = "linear-gradient(90deg, transparent 17%, #000 19.5%, #000 80.5%, transparent 83%)"
// the close capture also has the editor's toolbar and zoom level along its bottom
const NEAR_BOTTOM = "linear-gradient(#000 87%, transparent 92%)"
export function canvasStates(R, z, focus, at, extra = {}) {
  const st = boardStates(R, z, focus, at, extra)
  for (const id of ["cvFit", "cvNear"]) {
    const own = st[id].css?.maskImage ?? (id === "cvNear" ? NEAR_BOTTOM : null)
    const m = own ? `${BOARD_ONLY}, ${own}` : BOARD_ONLY
    st[id].css = { ...(st[id].css ?? {}), maskImage: m, webkitMaskImage: m, ...(own ? { maskComposite: "intersect", webkitMaskComposite: "source-in" } : {}) }
  }
  return st
}

/* ---------- the look ---------- */
/** The landing page's colors: near-black, white and its dim grey, the editor's indigo. The agent wears teal. */
export const C = { bg: "#0a0a0b", text: "#fafafa", dim: "#8a8a93", accent: "#798cff", accentText: "#90a3ff", fill: "#4a5df9", agent: "#19c2a0" }

/* ---------- the session ---------- */
export const SESSION = "midday-r6"
export const GAPS = [24, 26, 28, 30, 32, 34, 36]
const two = (i) => String(i).padStart(2, "0")
export const HOVER_IN = Array.from({ length: 27 }, (_, i) => `hover-in-${two(i)}`)
export const HOVER_LOOP = Array.from({ length: 60 }, (_, i) => `hover-${two(i)}`)
export const FRAMES = ["app", "bare", "bare-notb", "copy-sel", "copy-edit", "copy-all", "copy-typed", "copy-done", "measure-sel", "measure", "group-sel", ...GAPS.map((g) => `gap-${g}`), "gap-set",
  "cta-sel", "token-picker", "token-set", "note-empty", "note-text", "note-saved", "changes", "sent", "after", "after-hover", ...HOVER_IN, ...HOVER_LOOP, "canvas-near", "canvas-fit"]
const ORDER = Object.fromEntries(FRAMES.map((f, i) => [f, i]))
export const COPY_LEN = "Fine-tune the app you vibe coded, like a Figma file.".length
export const NOTE_LEN = "Add a shimmer to the border on hover.".length
/** Wraps a cut's maker with its session: frames, the typed fields, and which frames are patches. */
export const cut = (fn) => Object.assign(fn, {
  session: SESSION,
  frames: FRAMES,
  fields: { typeCopy: ["copyTyped", "copy-typed"], typeNote: ["composerField", "note-text"] },
  patch: (name) => (name.startsWith("hover-") ? "hoverPatch" : null),
  // the editor's panels for S.strips: arriving on the bare editor, leaving from the Changes tab
  stripFrames: ["bare", "sent"],
})
export const pad = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + p * 2, h: r.h + p * 2 })

/**
 * The session's action times. The first act runs as round 5's M did, from the
 * click on the subtitle at T; `rest` gives the others: ctaClick, tokenField,
 * token, notesTool, noteAt, note [start, end], save, changes, send, collapse
 * (the editor steps aside), hover (the agent's pointer reaches the button).
 */
export function times(T, rest) {
  const A = { subClick: T, dbl: T + 0.65, selAll: T + 1.75, type: [T + 1.95, T + 3.15], enter: T + 3.35, h1Click: T + 4.5, alt: T + 5.1, altUp: T + 6.05, parent: T + 6.25, scrub: [T + 7.45, T + 8.65], pointerHold: 0.6, ...rest }
  A.clicks = [A.subClick, A.dbl - 0.12, A.dbl, A.h1Click, A.ctaClick, A.tokenField, A.token, A.notesTool, A.noteAt, A.save, A.changes, A.send].filter((c) => c != null)
  return A
}

/** Where the pointer goes on the page, in shot px (the page is 1600 × 1000). */
export function targets(R) {
  const c = (r, fx = 0.5, fy = 0.5) => ({ x: r.x + r.w * fx, y: r.y + r.h * fy })
  return {
    sub: c(R.sub), subDbl: c(R.sub, 0.72, 0.7), h1: c(R.h1, 0.3, 0.3), gap: c(R.gapLabel), cta: c(R.ctaNow),
    token: c(R.radiusToken, 0.4), tokenRow: c(R.tokenRow, 0.3), notes: c(R.toolNotes), ctaNote: c(R.ctaNote, 0.7),
    save: { x: R.composer.x + R.composer.w - 38, y: R.composer.y + R.composer.h - 15 }, changes: c(R.changesTab), send: c(R.send), appCta: c(R.appCtaAfter),
  }
}
/** The pointer's path through the session; `start` is [t, x, y] where it comes in. */
export function pointerPath(A, X, start) {
  return [
    start, [A.subClick, X.sub.x, X.sub.y], [A.dbl, X.subDbl.x, X.subDbl.y], [A.type[1], X.subDbl.x + 40, X.subDbl.y + 60],
    [A.h1Click, X.h1.x, X.h1.y], [A.alt - 0.15, X.sub.x - 10, X.sub.y + 4], [A.altUp, X.sub.x - 10, X.sub.y + 4],
    [A.scrub[0] - 0.12, X.gap.x, X.gap.y], [A.scrub[1] + 0.12, X.gap.x + 12, X.gap.y],
    [A.ctaClick, X.cta.x, X.cta.y], [A.tokenField, X.token.x, X.token.y], [A.token, X.tokenRow.x, X.tokenRow.y], [A.token + 0.5, X.tokenRow.x - 30, X.tokenRow.y + 40],
    [A.notesTool - 0.6, 900, 860], [A.notesTool, X.notes.x, X.notes.y], [A.noteAt, X.ctaNote.x, X.ctaNote.y], [A.note[1] + 0.1, X.ctaNote.x + 60, X.ctaNote.y + 70],
    [A.save, X.save.x, X.save.y], [A.changes, X.changes.x, X.changes.y], [A.send, X.send.x, X.send.y],
  ]
}

/**
 * Camera framings, [x, y, scale] in shot px: the point of the page at the
 * middle of the window, and the zoom (0.9 shows the whole page).
 */
export const CAM = {
  FULL: [800, 500, 0.9], COPY: [800, 410, 1.9], GROUP: [1010, 330, 1.3], TOKEN: [1090, 405, 1.42], PICKER: [1400, 380, 2.6], CTA: [800, 504, 2.4],
  NOTE: [860, 560, 2.0], SEND: [1120, 300, 1.5], SENDBTN: [1440, 268, 3.2], APPCTA: [800, 528, 3.0], MACRO: [800, 528, 5.2],
}
/** A camera key at time t on a named framing; e shapes the move that ends there. */
export const key = (t, name, e) => [t, ...CAM[name], e]
const gapAt = (t, A, H) => 24 + 12 * H.prog(t, A.scrub[0], A.scrub[1] - A.scrub[0], H.E.io)
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
/** The hover's patch at h seconds after the pointer reached the button: the way in, then the light going round. */
export function hoverPatch(h) {
  const i = Math.max(0, Math.floor(h * 30 + 1e-6))
  return i < HOVER_IN.length ? HOVER_IN[i] : HOVER_LOOP[(i - HOVER_IN.length) % HOVER_LOOP.length]
}
/** The captured frames on screen at t, from the action times in A. */
export function sessionFrames(t, A, H) {
  const { prog, E } = H
  const frames = {}
  const seq = [
    ["copy-sel", A.subClick, 0.16], ["copy-edit", A.dbl, 0.12], ["copy-all", A.selAll, 0.08], ["copy-typed", A.type[0], 0.05], ["copy-done", A.enter, 0.25],
    ["measure-sel", A.h1Click, 0.16], ["measure", A.alt, 0.12], ["measure-sel", A.altUp, 0.12], ["group-sel", A.parent, 0.16],
    ["SCRUB", A.scrub[0], A.scrub[1] - A.scrub[0]], ["gap-set", A.scrub[1] + 0.1, 0.14],
    ["cta-sel", A.ctaClick, 0.16], ["token-picker", A.tokenField, 0.16], ["token-set", A.token, 0.25],
    ["note-empty", A.noteAt, 0.2], ["note-text", A.note[0], 0.06], ["note-saved", A.save, 0.24], ["changes", A.changes, 0.3], ["sent", A.send, 0.26],
    // the page swaps at once, under the editor's panels and a blur (see session())
    ["after", A.collapse - 0.06, 0.12], ["HOVER", A.hover, 999],
  ]
  let from = "bare", done = false
  for (const [name, at, dur] of seq) {
    if (at == null || t < at) break
    if (name === "SCRUB") {
      if (t < at + dur) { gapFrames(frames, gapAt(t, A, H)); done = true; break }
      from = "gap-36"
      continue
    }
    if (name === "HOVER") {
      frames.after = 1
      frames[hoverPatch(t - at)] = 1
      done = true
      break
    }
    if (t < at + dur) { xfade(frames, from, name, prog(t, at, dur, E.linear)); done = true; break }
    from = name
  }
  if (!done) frames[from] = 1
  return frames
}
/**
 * The session at t: its frames, the typing, the editor stepping aside for the
 * agent, and the pointer (with `label` on it, Figma style, when given). P is
 * the pointer's path; pass null to leave the pointer out.
 */
export function session(t, S, A, P, H, label) {
  const { prog, E, path, R } = H
  S.frames = sessionFrames(t, A, H)
  // The editor steps aside. The page under it reflows from the editor's width to the
  // app's, so: the page goes soft while the panels still cover their own place; at the
  // softest it swaps to the app at once; then the panels slide out over it and it
  // sharpens. Neither two layouts nor two copies of a panel ever show at once.
  if (A.collapse != null && t >= A.collapse - 0.18 && t < A.collapse + 0.6) {
    const q = prog(t, A.collapse, 0.55, E.io)
    S.strips = { pl: 1 - q, pr: 1 - q, frame: "sent" }
    const soft = t < A.collapse ? E.io((t - A.collapse + 0.18) / 0.18) : 1 - prog(t, A.collapse, 0.5, E.io)
    if (soft > 0.01) S.frameBlur = Math.max(S.frameBlur ?? 0, 6 * soft)
  }
  const typed = (a, b, n) => Math.floor(prog(t, a, b - a, E.linear) * n + 1e-6) / n
  if (t >= A.type[0] && t < A.enter + 0.05) S.typing = { field: R.typeCopy, p: typed(A.type[0], A.type[1], COPY_LEN), caret: true }
  if (A.note && t >= A.note[0] && t < A.save + 0.05) S.typing = { field: R.typeNote, p: typed(A.note[0], A.note[1], NOTE_LEN), caret: true }
  if (P && t >= P[0][0] - 0.3 && t <= P[P.length - 1][0] + A.pointerHold) {
    let at = path(t, P), press = 0, ring = null
    // the scrub: the pointer holds the gap's label and moves with the value
    if (t >= A.scrub[0] - 0.08 && t <= A.scrub[1] + 0.08) {
      const X = targets(R)
      at = { x: X.gap.x + (gapAt(t, A, H) - 24), y: X.gap.y }
      press = 1
    }
    for (const c of A.clicks) {
      press = Math.max(press, Math.max(0, 1 - Math.abs(t - c) / 0.1))
      if (t >= c && t < c + 0.45) ring = { x: at.x, y: at.y, q: (t - c) / 0.45 }
    }
    const fadeIn = prog(t, P[0][0] - 0.3, 0.3), fadeOut = 1 - prog(t, P[P.length - 1][0] + A.pointerHold - 0.3, 0.3)
    S.cursor = { x: at.x, y: at.y, press, op: Math.min(fadeIn, fadeOut), label }
    S.ring = ring
  }
}

/* ---------- the window ---------- */
/**
 * The window as round 5 framed it: 1300 px wide on the 1920 × 1080 frame. Its
 * page then sits at the frame's centre, 1300 × 812.5, so a 1300 px wide plate
 * of a captured frame at (960, 540) lies exactly on it: the hand-off from
 * planes to the window is invisible.
 */
export const WIN = { s: 1300 / 1440, y: -16 }
export const PAGE = { x: 960, y: 540, w: 1300, h: 812.5 }

/* ---------- the editor as three planes, as the landing page's hero shows it ---------- */
/** A point (px, py, pz) turned as a node with rotateX(rx) rotateY(ry) rotateZ(rz) turns it (degrees). */
export function turn(px, py, pz, rx, ry, rz) {
  const d = Math.PI / 180, z = rz * d, yy = ry * d, xx = rx * d
  ;[px, py] = [px * Math.cos(z) - py * Math.sin(z), px * Math.sin(z) + py * Math.cos(z)]
  ;[px, pz] = [px * Math.cos(yy) + pz * Math.sin(yy), -px * Math.sin(yy) + pz * Math.cos(yy)]
  ;[py, pz] = [py * Math.cos(xx) - pz * Math.sin(xx), py * Math.sin(xx) + pz * Math.cos(xx)]
  return [px, py, pz]
}
const PLANES = (R) => [
  ["plPage", { x: 280, y: 0, w: 1040, h: 1000 }, "bare-notb", "page"],
  ["plLeft", { x: 0, y: 0, w: 280, h: 1000 }, "bare-notb", "panel"],
  ["plRight", { x: 1320, y: 0, w: 280, h: 1000 }, "bare-notb", "panel"],
  ["plBar", R.toolbar, "bare", "bar"],
]
/**
 * The page and the editor's two panels (from bare-notb, the editor with its
 * toolbar hidden) and the toolbar (from bare). Landed, they are the bare frame
 * pixel for pixel, on the PAGE rect, so the window can take over from them
 * without a seam.
 */
export const planeNodes = (R) => PLANES(R).map(([id, src, frame]) => ({ id, kind: "plate", parent: "back", frame, src, w: src.w, h: src.h, cls: "planeplate" }))
/**
 * The three planes at one moment: the stack's centre (cx, cy) and scale s, its
 * turn (degrees), how far above the page the panels (hp) and the toolbar (ht)
 * float along the stack's normal (screen px), the toolbar's own extra scale
 * (tb), and opacities for the stack and for each layer.
 */
export function planes(N, R, { cx = 960, cy = 540, s = 1, rx = 0, ry = 0, rz = 0, hp = 0, ht = 0, tb = 1, op = 1, opPage = 1, opPanels = 1, opBar = 1, blur = 0 } = {}) {
  const k = (PAGE.w / 1600) * s
  const r = (14 * WIN.s * s).toFixed(1)
  for (const [id, src, , layer] of PLANES(R)) {
    const h = layer === "panel" ? hp : layer === "bar" ? ht : 0
    const sc = layer === "bar" ? tb : 1
    const [px, py, pz] = turn((src.x + src.w / 2 - 800) * k, (src.y + src.h / 2 - 500) * k, h, rx, ry, rz)
    const o = op * (layer === "page" ? opPage : layer === "panel" ? opPanels : opBar)
    // a floating layer casts a shadow on the one below; landed, it has none
    const f = Math.min(1, h / 90)
    const css = {
      boxShadow: layer === "page" ? "0 40px 100px rgba(0,0,0,0.55)" : `0 ${(26 * f).toFixed(1)}px ${(70 * f).toFixed(1)}px rgba(0,0,0,${(0.5 * f).toFixed(3)})`,
      borderRadius: id === "plLeft" ? `0 0 0 ${r}px` : id === "plRight" ? `0 0 ${r}px 0` : layer === "bar" ? `${(10 * k * sc).toFixed(1)}px` : "0",
    }
    N[id] = { x: cx + px, y: cy + py, z: pz, rx, ry, rz, w: src.w * k * sc, h: src.h * k * sc, op: o, blur, css }
  }
}

/* ---------- act one: each piece lifts off the page while it is tuned ---------- */
const COPY_SRC = { x: 488, y: 372, w: 624, h: 92 }
const COPY_FRAMES = ["copy-sel", "copy-edit", "copy-all", "copy-typed", "copy-done"]
const GROUP_FRAMES = ["group-sel", ...GAPS.map((g) => `gap-${g}`), "gap-set"]
const MEASURE_HTML = '<div class="ln"></div><div class="tk" style="top:0"></div><div class="tk tk2"></div><div class="lb"></div>'
/**
 * A piece of the page lifted `height` px off it along its normal, u of the way
 * (0..1). It starts exactly where it sits on the page, so nothing jumps, and
 * grows a little as it comes up, its corners and shadow coming with it.
 */
export function lift(N, S, Hs, id, src, u, height, frames, typing = null, view = null) {
  if (u <= 0.0005) return
  const o = Hs.onWindow(S, src.x + src.w / 2, src.y + src.h / 2, height * u)
  const mag = 1 + 0.18 * u
  const fr = {}
  for (const f of frames) if (S.frames[f]) fr[f] = S.frames[f]
  if (!Object.keys(fr).length) fr[frames[0]] = 1
  const w = src.w * o.k * mag, h = src.h * o.k * mag
  // a piece wider than the window's view leaves and lands through the view's edge:
  // the part outside is cut away near the page, so nothing pops when it lifts or lands
  let clipPath = "none"
  if (view) {
    const f = 1 - Math.min(1, u / 0.35)
    const cut = (v) => Math.max(0, v) * f
    const l = cut(view.x0 - (o.x - w / 2)), r = cut(o.x + w / 2 - view.x1), tp = cut(view.y0 - (o.y - h / 2)), b = cut(o.y + h / 2 - view.y1)
    if (l + r + tp + b > 0.05) clipPath = `inset(${tp.toFixed(1)}px ${r.toFixed(1)}px ${b.toFixed(1)}px ${l.toFixed(1)}px)`
  }
  N[id] = { ...o, w, h, frames: fr, typing,
    css: { clipPath, borderRadius: `${(14 * u).toFixed(1)}px`, boxShadow: `0 0 0 1px rgba(255,255,255,${(0.14 * u).toFixed(3)}), 0 ${(36 * u).toFixed(1)}px ${(90 * u).toFixed(1)}px rgba(0,0,0,${(0.55 * u).toFixed(3)})` } }
}
/** The window's view of the page on screen (x0, y0, x1, y1), for a flat window: what lift() cuts to near the page. */
export function viewRect(S, Hs, H) {
  const c = H.clampCam(S.cam)
  const hw = 720 / c.s, hh = 450 / c.s
  const a = Hs.toScreen(S, c.x - hw, c.y - hh), b = Hs.toScreen(S, c.x + hw, c.y + hh)
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y }
}
/**
 * Round 5's M, first act, from the click on the subtitle (A.subClick): the
 * subtitle lifts while it is rewritten; the headline is measured to it; the
 * hero group lifts while its gap opens from 24 to 36, a redline counting.
 * Put `act.nodes` in the cut's nodes and `act.keys` in its camera track, and
 * call act.render(t, S, N, Hs) after setting S.win and S.cam (it tilts the
 * window while a piece is up). act.end is when its last framing settles.
 */
export function layerAct(H, A) {
  const { R, prog, E } = H
  const T = A.subClick
  const groupSrc = pad(R.groupAfter, 16)
  const up = (t, a, d, b, e = 0.7) => prog(t, a, d, E.io) * (1 - prog(t, b, e, E.io))
  const uCopy = (t) => up(t, T + 0.75, 0.9, T + 3.45)
  const uGroup = (t) => up(t, T + 6.55, 0.85, T + 8.8)
  return {
    nodes: [
      { id: "lCopy", kind: "plate", parent: "front", frame: "copy-sel", frames: COPY_FRAMES, src: COPY_SRC, w: COPY_SRC.w, h: COPY_SRC.h, cls: "liftplate" },
      { id: "lGroup", kind: "plate", parent: "front", frame: "group-sel", frames: GROUP_FRAMES, src: groupSrc, w: groupSrc.w, h: groupSrc.h, cls: "liftplate" },
      { id: "mLine", kind: "html", cls: "measure", parent: "front", html: MEASURE_HTML },
    ],
    keys: [key(T + 0.15, "FULL"), key(T + 0.65, "COPY"), key(T + 4.15, "COPY"), key(T + 4.55, "FULL"), key(T + 6.15, "FULL"), key(T + 6.5, "GROUP"), key(T + 9.5, "GROUP")],
    end: T + 9.5,
    tilt: (t) => Math.max(uCopy(t), uGroup(t)),
    render(t, S, N, Hs) {
      const uc = uCopy(t), ug = uGroup(t), tl = Math.max(uc, ug)
      S.win.rx = (S.win.rx ?? 0) - 5 * tl
      S.win.ry = (S.win.ry ?? 0) - 8 * tl
      const typing = S.typing && S.typing.field === R.typeCopy ? { ...S.typing, t } : null
      const view = viewRect(S, Hs, H)
      lift(N, S, Hs, "lCopy", COPY_SRC, uc, 240, COPY_FRAMES, typing, view)
      lift(N, S, Hs, "lGroup", groupSrc, ug, 220, GROUP_FRAMES, null, view)
      // the gap, measured as it opens: a redline from the headline to the subtitle, on the lifted group
      if (ug > 0.05 && t >= T + 6.8 && t < T + 9.1) {
        const g = t < A.scrub[0] ? 24 : gapAt(t, A, H)
        const top = 366 + (g - 24), bot = 390 + 2 * (g - 24)
        const a = Hs.onWindow(S, 800, top, 220 * ug + 1), b = Hs.onWindow(S, 800, bot, 220 * ug + 1)
        const len = Math.max(2, b.y - a.y)
        const op = prog(t, T + 6.9, 0.3) * (1 - prog(t, T + 8.75, 0.25))
        N.mLine = { x: a.x, y: a.y, z: a.z, rx: a.rx, ry: a.ry, anchor: "topleft", op, sub: { ".ln": { css: { height: `${len.toFixed(1)}px` } }, ".tk2": { css: { top: `${(len - 2).toFixed(1)}px` } }, ".lb": { text: String(Math.round(g)), css: { top: `${(len / 2 - 15).toFixed(1)}px` } } } }
      }
    },
  }
}
/** M's captions for act one, in the manner of Cua's: an icon, a bold lead, words that arrive softly. */
export const ACT_CAPTIONS = [
  ["c1", "**Edit the copy,** right on the page.", "text"],
  ["c2", "**Measure** the spacing. **Tune it** with auto layout.", "measure"],
]
export const actCaptions = () => ACT_CAPTIONS.map(([id, text, icon]) => caption(id, text, ICON[icon](C.accentText)))
/** Shows act one's captions on M's beats, from the click on the subtitle. */
export function showActCaptions(N, K, H, A) {
  const T = A.subClick
  showCaption(N, K, H, "c1", T + 0.8, T + 3.8)
  showCaption(N, K, H, "c2", T + 4.7, T + 9.0)
}

/* ---------- words ---------- */
/**
 * A heading as the landing page sets them: the first part bright, the rest in
 * the dim grey. bright/dim are strings; with lines: true they stack.
 */
const HEADS = {}
export function headline(id, bright, dim, { size = 72, weight = 560, tracking = -0.035, lines = false, lineHeight = 1.08 } = {}) {
  const nb = bright.trim().split(/\s+/).length, nd = dim ? dim.trim().split(/\s+/).length : 0
  HEADS[id] = { nb, nd }
  const text = dim ? `${bright} ${dim}` : bright
  return { id, kind: "text", ...(lines && dim ? { lines: [bright, dim] } : { text }), size, weight, tracking, lineHeight, color: C.text }
}
/**
 * Shows a heading the way the landing page does: it rises in as a ghost and
 * its words light up one after another (the dim ones settle dim); then it
 * lifts away. x, y are its centre (or left edge with anchor: "left"); `dim` is
 * the second part's color (C.text for a heading lit all through, as the hero's).
 */
export function showHeadline(N, H, id, at, out, { x = 960, y = 540, anchor, st = 0.07, s, op = 1, dim = C.dim } = {}) {
  const t = H.t
  const h = HEADS[id]
  if (!h || t < at - 0.05 || t >= out + 0.9) return
  const units = []
  const rise = H.prog(t, at, 0.9)
  for (let i = 0; i < h.nb + h.nd; i++) {
    const lit = H.prog(t, at + 0.2 + i * st, 0.6, H.E.io)
    const q = H.prog(t, out + i * 0.025, 0.55, H.E.io)
    units.push({ op: (0.16 + 0.84 * lit) * Math.min(1, rise * 1.6) * (1 - q), y: 30 * (1 - rise) - 22 * q, blur: 8 * (1 - rise) + 8 * q, color: i >= h.nb ? dim : C.text })
  }
  N[id] = { x, y, anchor, units, s, op }
}
/** O's step titles: one big word, out of a mask. */
export const BIG = { size: 150, weight: 700, tracking: -0.05, mask: true }
export function showWord(N, K, H, id, at, out, st) {
  const t = H.t
  if (t >= at - 0.05 && t < out + 0.5) N[id] = { ...st, units: K.exit(K.mask(t, at, 1), t, out, { mode: "mask" }) }
}

/* ---------- close-ups ---------- */
/**
 * A sharp copy of a region of the page laid exactly over it, so the rest can go
 * soft round it (depth of field): set S.frameBlur for the page, then
 * showFocus(). Its frames follow the session's.
 */
export const focusNode = (id, src) => ({ id, kind: "plate", parent: "front", frames: FRAMES, frame: "bare", src, w: src.w, h: src.h, cls: "focusplate" })
export function showFocus(N, S, Hs, id, src, op = 1, feather = 0.3) {
  if (op <= 0.001) return
  const o = Hs.onWindow(S, src.x + src.w / 2, src.y + src.h / 2, 0.5)
  const m = `radial-gradient(closest-side, #000 ${((1 - feather) * 100).toFixed(0)}%, transparent)`
  N[id] = { ...o, src, w: src.w * o.k, h: src.h * o.k, frames: S.frames, op, css: { maskImage: m, webkitMaskImage: m } }
}
/** A plate of the button and round it, playing the hover: the page after, the patch on it. */
export const hoverNode = (id, src, parent = "front") => ({ id, kind: "plate", parent, frames: ["after", ...HOVER_IN, ...HOVER_LOOP], frame: "after", src, w: src.w, h: src.h })
export const hoverFrames = (h) => (h < 0 ? { after: 1 } : { after: 1, [hoverPatch(h)]: 1 })

/* ---------- the end ---------- */
const GH = '<svg viewBox="0 0 16 16" width="26" height="26" fill="currentColor" style="flex:none"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>'
/**
 * The landing page's end: the icon, the name with a light crossing it, the
 * hero line (bright, then dim), Star on GitHub, the address.
 */
export function endNodes() {
  return [
    { id: "eIcon", kind: "html", html: '<img src="../../assets/brand/icon-512.png" alt="" style="display:block;width:116px;height:116px">' },
    { id: "eName", kind: "html", cls: "endname", html: "Design Layer" },
    headline("eLine", "Bring the design layer", "to your vibe-coded apps.", { size: 50, weight: 560, tracking: -0.03 }),
    { id: "eBtn", kind: "html", cls: "endstar", html: `${GH}<span>Star on GitHub</span>` },
    { id: "eUrl", kind: "text", text: "github.com/phil8-li/design-layer", size: 24, weight: 500, tracking: 0, font: "mono", color: "#8e8e93" },
  ]
}
export function endCard(N, K, H, at, { y = 540 } = {}) {
  const { prog, E, t } = H
  if (t < at - 0.05) return
  const a = prog(t, at, 0.9)
  N.eIcon = { x: 960, y: y - 250 + 24 * (1 - a), op: a, blur: 6 * (1 - a), s: 0.92 + 0.08 * a }
  const b = prog(t, at + 0.25, 1.0)
  // a light crosses the name once, as the landing page's end word does
  const sweep = prog(t, at + 0.55, 2.2, E.io)
  N.eName = { x: 960, y: y - 95 + 30 * (1 - b), op: b, blur: 8 * (1 - b), css: { backgroundPosition: `${(100 - 100 * sweep).toFixed(2)}% 0` } }
  showHeadline(N, H, "eLine", at + 0.7, 999, { x: 960, y: y + 30 })
  const c = prog(t, at + 1.5, 0.8)
  N.eBtn = { x: 960, y: y + 150 + 16 * (1 - c), op: c }
  const d = prog(t, at + 1.75, 0.8)
  N.eUrl = { x: 960, y: y + 228 + 10 * (1 - d), op: d }
}
