/*
 * Marketing cuts. The spine is the explainer's real session (select the
 * headline, set it to #4A5DF9, leave a note, send it, see the diff); around it,
 * kinetic type and motion graphics that use Design Layer's own vocabulary:
 * selection boxes and handles, the color, the note pin, the code.
 *
 *   G · Designed live   the type gets edited with the product's tools, then the same tools work on the real app
 *   H · Color           a grey app; the color edit washes the whole film in indigo
 *   I · Layers          the design layer as a real layer: planes in 3D that land, lift and stack
 */

export const INDIGO = "#4A5DF9"
export const LILAC = "#798cff"

/* ---------- the session, as in the explainer (story/cuts.js) ---------- */
export const xf = (S, from, to, p) => {
  if (p >= 1) S.frames[to] = 1
  else {
    S.frames[from] = 1
    if (p > 0) S.frames[to] = p
  }
}
function session(t, S, A, P, H) {
  const { prog, E, path, R } = H
  const seq = [
    ["h1", A.h1, 0.2], ["picker", A.color, 0.16], ["picker-typed", A.custom, 0.1], ["indigo", A.enter, 0.34],
    ["note-empty", A.cta, 0.22], ["note-text", A.note[0], 0.06], ["note-saved", A.save, 0.24], ["changes", A.agentUp, 0.3], ["sent", A.send, 0.26],
  ]
  const opened = A.open + A.openDur
  let base = "app"
  if (t >= A.open && t < opened + 0.05) {
    S.frames.app = 1
    S.strips = { pl: prog(t, A.open, A.openDur), pr: prog(t, A.open + 0.04, A.openDur) }
    const b = prog(t, A.open + A.openDur * 0.78, A.openDur * 0.22, E.linear)
    if (b > 0) S.frames.bare = b
    S.frameBlur = 1.6 * Math.sin(Math.PI * b)
    base = null
  } else if (t >= opened) base = "bare"
  if (base) {
    let from = base, done = false
    for (const [name, at, dur] of seq) {
      if (t < at) break
      if (t < at + dur) {
        xf(S, from, name, prog(t, at, dur, E.linear))
        done = true
        break
      }
      from = name
    }
    if (!done) S.frames[from] = 1
  }
  const typed = (a, b, n) => Math.floor(prog(t, a, b - a, E.linear) * n + 1e-6) / n
  if (t >= A.custom && t < A.enter + 0.05) S.typing = { field: R.typeColor, p: typed(A.type[0], A.type[1], 7), caret: true }
  if (t >= A.note[0] && t < A.save + 0.05) S.typing = { field: R.typeNote, p: typed(A.note[0], A.note[1], 38), caret: true }
  if (P && t >= P[0][0] - 0.3 && t <= P[P.length - 1][0] + (A.pointerHold ?? 1)) {
    const at = path(t, P)
    let press = 0, ring = null
    for (const c of A.clicks) {
      press = Math.max(press, Math.max(0, 1 - Math.abs(t - c) / 0.1))
      if (t >= c && t < c + 0.45) ring = { x: at.x, y: at.y, q: (t - c) / 0.45 }
    }
    const fadeIn = prog(t, P[0][0] - 0.3, 0.3), fadeOut = 1 - prog(t, P[P.length - 1][0] + (A.pointerHold ?? 1) - 0.3, 0.3)
    S.cursor = { x: at.x, y: at.y, press, op: Math.min(fadeIn, fadeOut) }
    S.ring = ring
  }
}
function targets(R) {
  const c = (r, fx = 0.5, fy = 0.5) => ({ x: r.x + r.w * fx, y: r.y + r.h * fy })
  return {
    h1: { x: R.h1.x + R.h1.w * 0.36, y: R.h1.y + R.h1.h * 0.42 },
    h1c: c(R.h1),
    color: c(R.colorField, 0.3),
    custom: c(R.pickerCustom, 0.4),
    cta: c(R.cta, 0.62),
    send: c(R.send),
  }
}

/* ---------- kinetic type helpers: per-unit states for a text node ---------- */
export function kit(H) {
  const { prog, E, clamp } = H
  const N = (n, f) => Array.from({ length: n }, (_, i) => f(i))
  return {
    /** rises into place word by word, clearing a blur */
    rise: (t, at, n, { st = 0.08, din = 0.8, dist = 44, blur = 10 } = {}) => N(n, (i) => {
      const p = prog(t, at + i * st, din)
      return { op: clamp(p * 1.5, 0, 1), y: dist * (1 - p), blur: blur * (1 - p) }
    }),
    /** slides up out of a mask (needs mask: true on the node) */
    mask: (t, at, n, { st = 0.06, din = 0.75 } = {}) => N(n, (i) => {
      const p = prog(t, at + i * st, din)
      return { y: `${((1 - p) * 112).toFixed(2)}%`, op: t >= at + i * st ? 1 : 0 }
    }),
    /** appears a character at a time */
    type: (t, at, n, cps = 14) => N(n, (i) => ({ op: t >= at + i / cps ? 1 : 0 })),
    /** leaves: through the mask, or lifting and fading */
    exit: (us, t, out, { st = 0.03, dout = 0.45, mode = "fade" } = {}) => us.map((u, i) => {
      const q = prog(t, out + i * st, dout, E.io)
      if (q <= 0) return u
      // far enough that a descender (the g of "Change.") clears the mask too
      if (mode === "mask") return { ...u, y: `${(-140 * q).toFixed(2)}%` }
      return { ...u, op: (u.op ?? 1) * (1 - q), y: (typeof u.y === "number" ? u.y : 0) - 26 * q, blur: (u.blur ?? 0) + 8 * q }
    }),
    /** colors units one after another */
    tint: (us, t, at, color, { st = 0.04, d = 0.35 } = {}) => us.map((u, i) => (t >= at + i * st ? { ...u, color: mixHex("#f5f5f7", color, prog(t, at + i * st, d)) } : u)),
    /** a small, single overshoot: for things that land (pins, chips) */
    pop: (p) => (p <= 0 ? 0 : E.out(p) * (1 + 0.1 * Math.sin(Math.PI * clamp(p, 0, 1)) * (1 - clamp(p, 0, 1)))),
  }
}
export function mixHex(a, b, p) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16)), pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * p)).join(", ")})`
}
export const CURSOR_SVG = `<svg viewBox="0 0 20 26" style="width:100%;height:100%;overflow:visible;filter:drop-shadow(0 4px 8px rgba(0,0,0,.45))"><path d="M2.5 2v18.2l4.6-4.3 2.9 6.8 3.3-1.4-2.9-6.7H16.6Z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>`
/** a selection box around a rect, with padding */
export const around = (r, pad = 16) => ({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 })
export const sizeLabel = (r) => `W ${Math.round(r.w)}   H ${Math.round(r.h)}`

export const CUTS = {
  /* =================================================================
     G · Designed live
     ================================================================= */
  g(H) {
    const { R, E, FIT, prog, track, path, lerp, clamp, rectOf } = H
    const K = kit(H)
    const X = targets(R)
    const A = { open: 4.9, openDur: 0.8, h1: 7.2, color: 10.0, custom: 11.0, type: [11.2, 12.0], enter: 12.4, cta: 17.2, note: [18.0, 19.7], save: 20.1, agentUp: 20.9, send: 22.0 }
    A.clicks = [A.h1, A.color, A.custom, A.cta, A.send]
    A.pointerHold = 0.8
    const P = [
      [6.4, 1150, 760], [A.h1, X.h1.x, X.h1.y], [9.4, X.h1.x + 260, X.h1.y + 220], [A.color, X.color.x, X.color.y], [A.custom, X.custom.x, X.custom.y],
      [12.9, X.custom.x - 40, X.custom.y + 40], [16.6, 1000, 760], [A.cta, X.cta.x, X.cta.y], [21.2, X.cta.x + 300, X.cta.y - 160], [A.send, X.send.x, X.send.y],
    ]
    const END = 37.5
    const WORD = { size: 168, weight: 720, tracking: -0.05 }
    const BIG = { size: 150, weight: 720, tracking: -0.05, mask: true }
    const FIN = { size: 210, weight: 740, tracking: -0.055, mask: true, split: "none" }
    // where the window sits once it has made room for the type on the left
    const winRight = { x: 230, y: 0, s: 0.7 }
    const winRect = (w) => ({ x: 960 + w.x - 720 * w.s, y: 540 + w.y - 468 * w.s, w: 1440 * w.s, h: 936 * w.s })
    return {
      duration: END,
      nodes: [
        { id: "built", kind: "text", text: "You built it.", ...WORD },
        { id: "sel1", kind: "sel", line: 3, hs: 16, ls: 24 },
        { id: "hand", kind: "html", html: CURSOR_SVG, style: { width: "40px", height: "52px" } },
        { id: "cap1", kind: "text", text: "Now give it a design layer.", size: 58, weight: 620, tracking: -0.03 },
        { id: "select", kind: "text", text: "Select", ...BIG },
        { id: "selS", kind: "sel", line: 3, hs: 16, ls: 26 },
        { id: "change", kind: "text", text: "Change", ...BIG },
        { id: "hex", kind: "text", text: INDIGO, size: 96, weight: 500, tracking: -0.02, font: "mono", split: "char" },
        { id: "figma", kind: "text", text: "Just like a Figma file.", size: 140, weight: 740, tracking: -0.05 },
        { id: "say", kind: "text", lines: ["Or just", "say it."], size: 132, weight: 720, tracking: -0.05, lineHeight: 1.02, align: "left" },
        { id: "pinSay", kind: "pin", num: 2 },
        { id: "send", kind: "text", text: "Send.", ...BIG },
        { id: "agent", kind: "text", lines: ["Your agent", "does the rest."], size: 104, weight: 720, tracking: -0.05, lineHeight: 1.04, align: "left" },
        { id: "chipFly", kind: "chip", hex: INDIGO },
        { id: "pinFly", kind: "pin", num: 2 },
        { id: "land", kind: "text", text: "Every edit lands in your code.", size: 58, weight: 620, tracking: -0.03 },
        { id: "codeA", kind: "text", text: "-  text-foreground", size: 68, weight: 500, tracking: -0.02, font: "mono", split: "none", color: "#ff9b93" },
        { id: "strike", kind: "bar", style: { color: "#ff9b93", height: "6px" } },
        { id: "codeB", kind: "text", text: "+  text-[#4A5DF9]", size: 68, weight: 500, tracking: -0.02, font: "mono", split: "char", color: "#8de5a1" },
        { id: "fin1", kind: "text", text: "Select.", ...FIN },
        { id: "selF", kind: "sel", line: 4, hs: 18, ls: 26 },
        { id: "fin2", kind: "text", text: "Change.", ...FIN },
        { id: "fin3", kind: "text", text: "Comment.", ...FIN },
        { id: "pinF", kind: "pin", num: 1, style: { width: "84px", height: "84px", margin: "-42px 0 0 -42px", fontSize: "38px" } },
        { id: "fin4", kind: "text", text: "Ship.", ...FIN },
        { id: "check", kind: "check", size: 132 },
      ],
      render(t, S, Hs) {
        const N = S.nodes

        // ---- 1. "You built it." — then the product's own selection lands on "it." ----
        const stBuilt = { x: 960, y: 500 }
        // the selection box: from "it." to the window's size, taking the window's shape early so the window fills it
        const rIt = around(rectOf("built", 2, stBuilt), 14), target = winRect({ x: 0, y: 0, s: 0.74 })
        const drag = prog(t, 2.6, 1.0, E.io), shape = prog(t, 2.6, 0.5, E.io)
        const bw = lerp(rIt.w, target.w, drag)
        const box = { x: lerp(rIt.x, target.x, drag), y: lerp(rIt.y, target.y, drag), w: bw, h: lerp(rIt.h, (bw * 936) / 1440, shape) }
        if (t < 3.8) {
          let us = K.rise(t, 0.3, 3, { st: 0.13 })
          us = us.map((u, i) => ({ ...u, op: u.op * (1 - prog(t, 2.6, i < 2 ? 0.5 : 0.22, E.io)) }))
          N.built = { ...stBuilt, units: us }
          if (t >= 2.25) N.sel1 = { ...box, draw: prog(t, 2.25, 0.32, E.io), handles: prog(t, 2.4, 0.4, E.linear), label: sizeLabel(box), labelOp: prog(t, 2.5, 0.3) * (1 - prog(t, 3.5, 0.3)), op: 1 - prog(t, 3.55, 0.35, E.io) }
          // a hand selects "it." and drags its corner out to the size of a window
          const hand = t < 2.6 ? path(t, [[1.5, 1560, 960], [2.2, rIt.x + rIt.w * 0.55, rIt.y + rIt.h * 0.5], [2.55, rIt.x + rIt.w, rIt.y + rIt.h]]) : { x: box.x + box.w, y: box.y + box.h }
          const press = Math.max(0, 1 - Math.abs(t - 2.25) / 0.1) + (t > 2.6 && t < 3.6 ? 0.6 : 0)
          if (t > 1.3) N.hand = { x: hand.x, y: hand.y, anchor: "topleft", s: 1 - 0.1 * Math.min(1, press), op: prog(t, 1.3, 0.3) * (1 - prog(t, 3.7, 0.25)) }
        }

        // ---- the window: grows out of the selection, then makes room for the type ----
        let w = { op: 0, x: 0, y: 0, s: 0.74 }
        if (t >= 2.6) w = { op: prog(t, 2.72, 0.35), x: box.x + box.w / 2 - 960, y: box.y + box.h / 2 - 540, s: box.w / 1440 }
        const slide = prog(t, 6.0, 0.9, E.io)
        if (t >= 3.6) w = { op: 1, x: lerp(0, winRight.x, slide), y: 0, s: lerp(0.74, winRight.s, slide) }
        // sent: the window steps back and goes, and the agent's window takes its place
        const away = prog(t, 22.5, 0.6, E.io)
        if (t >= 22.5) w = { op: 1 - away, x: winRight.x + 60 * away, y: -16 * away, s: winRight.s * (1 - 0.12 * away) }
        S.win = w
        S.cam = track(t, [
          [0, 800, 500, FIT], [6.9, 800, 500, FIT], [7.9, 800, 330, 1.35], [8.9, 800, 330, 1.35], [9.8, 1180, 760, 1.6], [10.2, 1180, 650, 1.55],
          [12.4, 1180, 650, 1.55], [13.4, 900, 470, 1.0], [16.8, 900, 470, 1.0], [17.6, 860, 500, 1.5], [20.2, 860, 500, 1.5], [21.2, 1000, 375, 1.2], [22.4, 1000, 375, 1.2],
        ])
        session(t, S, A, P, H)
        const shade = prog(t, 9.6, 0.8, E.io) * (1 - prog(t, 12.6, 0.8, E.io))
        if (shade > 0) S.shade = { a: 0.75 * shade }

        // ---- 2. caption, and the editor opens ----
        if (t >= 3.9 && t < 6.3) N.cap1 = { x: 960, y: 1000, units: K.exit(K.rise(t, 3.95, 6, { st: 0.05, dist: 26 }), t, 5.75) }

        // ---- 3. "Select" gets selected as the headline does ----
        const stSel = { x: 120, y: 470, anchor: "left" }
        if (t >= 6.5 && t < 9.4) {
          N.select = { ...stSel, units: K.exit(K.mask(t, 6.6, 1), t, 8.75, { mode: "mask" }) }
          if (t >= A.h1 + 0.05 && t < 8.75) {
            const r = around(rectOf("select", 0, stSel), 16)
            N.selS = { ...r, draw: prog(t, A.h1 + 0.05, 0.32, E.io), handles: prog(t, A.h1 + 0.15, 0.4, E.linear), label: "anything", labelOp: prog(t, A.h1 + 0.3, 0.3), op: 1 - prog(t, 8.55, 0.2) }
          }
        }

        // ---- 4. "Change" — the value types in big, and both turn indigo on Enter ----
        const stChg = { x: 120, y: 410, anchor: "left" }, stHex = { x: 124, y: 570, anchor: "left" }
        if (t >= 9.3 && t < 13.9) {
          let us = K.mask(t, 9.4, 1)
          us = K.tint(us, t, A.enter, INDIGO)
          N.change = { ...stChg, units: K.exit(us, t, 13.3, { mode: "mask" }) }
          const typedN = Math.floor(prog(t, A.type[0], A.type[1] - A.type[0], E.linear) * 7 + 1e-6)
          let hx = Array.from({ length: 7 }, (_, i) => ({ op: i < typedN ? 1 : 0, color: t >= A.enter ? mixHex("#f5f5f7", LILAC, prog(t, A.enter, 0.3)) : undefined }))
          if (t >= A.custom) N.hex = { ...stHex, units: K.exit(hx, t, 13.3, { st: 0.02 }) }
        }

        // ---- 5. the color floods out of the headline: "Just like a Figma file." ----
        const hc = Hs.toScreen(S, X.h1c.x, X.h1c.y)
        const cta = Hs.toScreen(S, X.cta.x, R.cta.y + R.cta.h / 2)
        const fillIn = prog(t, 13.8, 0.9, E.io), fillOut = prog(t, 16.0, 0.8, E.io)
        if (t >= 13.8 && t < 16.85) {
          const r = 2300 * fillIn * (1 - fillOut)
          S.flood = { x: lerp(hc.x, cta.x, fillOut), y: lerp(hc.y, cta.y, fillOut), r: Math.max(0, fillOut > 0 ? 2300 * (1 - E.io(clamp((t - 16.0) / 0.8, 0, 1))) : r) }
          if (t >= 14.4) N.figma = { x: 960, y: 530, units: K.exit(K.rise(t, 14.45, 5, { st: 0.07 }), t, 15.75, { st: 0.02 }) }
        }

        // ---- 6. "Or just say it." — and the note lands as a pin ----
        const stSay = { x: 120, y: 470, anchor: "left" }
        if (t >= 16.8 && t < 21.5) {
          N.say = { ...stSay, units: K.exit(K.rise(t, 16.9, 4, { st: 0.1 }), t, 20.95) }
          if (t >= A.save + 0.05) {
            const r = rectOf("say", 3, stSay)
            const p = prog(t, A.save + 0.05, 0.55, E.linear)
            N.pinSay = { x: r.x + r.w + 60, y: r.y + r.h * 0.42 - 30 * (1 - E.out(p)), s: K.pop(p), op: Math.min(1, p * 3) * (1 - prog(t, 20.95, 0.3)) }
          }
        }

        // ---- 7. "Send." — the edit and the note fly to the agent ----
        const stSend = { x: 120, y: 470, anchor: "left" }
        if (t >= 21.4 && t < 23.2) N.send = { ...stSend, units: K.exit(K.mask(t, 21.5, 1), t, 22.7, { mode: "mask" }) }
        const tIn = prog(t, 22.75, 0.8), tOut = prog(t, 26.4, 0.6, E.io)
        if (t >= 22.7 && t < 27.1) S.term = { op: tIn * (1 - tOut), x: 900 + 40 * (1 - tIn), y: 270, s: 0.92, chars: (t - 23.6) * 240 }
        if (t >= 22.9 && t < 27.0) N.agent = { x: 120, y: 470, anchor: "left", units: K.exit(K.rise(t, 23.1, 5, { st: 0.07 }), t, 26.3) }
        // the color and the note pop out of the app and arc into the agent's window
        const swoop = (a, from, to, peak) => {
          const p = prog(t, a, 1.0, E.io), q = 1 - p
          const cx = (from.x + to.x) / 2, cy = Math.min(from.y, to.y) - peak
          return { x: q * q * from.x + 2 * q * p * cx + p * p * to.x, y: q * q * from.y + 2 * q * p * cy + p * p * to.y, s: lerp(0.7, 0.8, p) + 0.5 * Math.sin(Math.PI * p), op: prog(t, a - 0.05, 0.15) * (1 - prog(t, a + 0.95, 0.25)) }
        }
        if (t >= 22.2 && t < 23.8) {
          N.chipFly = swoop(22.3, Hs.toScreen(S, X.h1c.x, X.h1c.y), { x: 1120, y: 430 }, 260)
          N.pinFly = swoop(22.45, Hs.toScreen(S, R.pin?.[1]?.x ?? X.cta.x, R.pin?.[1]?.y ?? X.cta.y), { x: 1190, y: 470 }, 300)
        }

        // ---- 8. the diff, set as type ----
        const stA = { x: 960, y: 500 }, stB = { x: 960, y: 610 }
        if (t >= 26.6 && t < 29.6) {
          N.land = { x: 960, y: 330, units: K.exit(K.rise(t, 26.7, 6, { st: 0.05, dist: 24 }), t, 29.1) }
          N.codeA = { ...stA, units: K.exit(K.rise(t, 26.9, 1, { dist: 20 }), t, 29.1), op: 1 }
          const ra = rectOf("codeA", null, stA)
          N.strike = { x: ra.x + 70, y: ra.y + ra.h / 2 + 4, anchor: "topleft", w: ra.w - 70, p: prog(t, 27.5, 0.45, E.io), op: 1 - prog(t, 29.1, 0.4) }
          N.codeB = { ...stB, units: K.exit(K.type(t, 27.8, 17, 20), t, 29.1, { st: 0.01 }) }
        }

        // ---- 9. the finale: four words, each with its tool ----
        const words = [["fin1", 29.6], ["fin2", 30.3], ["fin3", 31.0], ["fin4", 31.7]]
        words.forEach(([id, at], i) => {
          const next = words[i + 1]?.[1] ?? 32.55
          if (t < at - 0.05 || t >= next + 0.5) return
          let us = K.exit(K.mask(t, at, 1, { din: 0.42 }), t, next - 0.02, { mode: "mask", dout: 0.3 })
          if (id === "fin2") us = K.tint(us, t, at + 0.2, INDIGO, { d: 0.25 })
          N[id] = { x: 960, y: 520, units: us }
          const r = rectOf(id, null, { x: 960, y: 520 })
          if (id === "fin1" && t < next) N.selF = { ...around(r, 18), draw: prog(t, at + 0.12, 0.28, E.io), handles: prog(t, at + 0.2, 0.3, E.linear), op: 1 - prog(t, next - 0.12, 0.12) }
          if (id === "fin3" && t < next) {
            const p = prog(t, at + 0.18, 0.45, E.linear)
            N.pinF = { x: r.x + r.w + 40, y: r.y + 40 - 36 * (1 - E.out(p)), s: K.pop(p), op: Math.min(1, p * 3) * (1 - prog(t, next - 0.1, 0.1)) }
          }
          if (id === "fin4" && t < next + 0.4) N.check = { x: r.x + r.w + 110, y: 520, s: K.pop(prog(t, at + 0.12, 0.4, E.linear)), draw: prog(t, at + 0.3, 0.35, E.io), op: 1 - prog(t, next, 0.3) }
        })

        // ---- 10. logo ----
        if (t >= 32.6) S.logo = { icon: prog(t, 32.8, 1.0), mark: prog(t, 33.1, 1.0), sub: prog(t, 33.8, 0.9), url: prog(t, 34.2, 0.9) }
        S.black = Math.max(1 - prog(t, 0, 0.5, E.linear), prog(t, END - 1.0, 1.0, E.io))
      },
    }
  },

  /* =================================================================
     H · Color
     ================================================================= */
  h(H) {
    const { R, E, FIT, prog, track, lerp, clamp, rectOf } = H
    const K = kit(H)
    const X = targets(R)
    const A = { open: 7.4, openDur: 0.8, h1: 9.0, color: 11.0, custom: 12.0, type: [12.2, 13.0], enter: 13.5, cta: 17.4, note: [18.2, 19.9], save: 20.3, agentUp: 21.2, send: 22.3 }
    A.clicks = [A.h1, A.color, A.custom, A.cta, A.send]
    A.pointerHold = 0.8
    const P = [
      [8.3, 1150, 760], [A.h1, X.h1.x, X.h1.y], [10.4, X.h1.x + 260, X.h1.y + 220], [A.color, X.color.x, X.color.y], [A.custom, X.custom.x, X.custom.y],
      [14.5, X.custom.x - 40, X.custom.y + 40], [16.8, 1000, 760], [A.cta, X.cta.x, X.cta.y], [21.5, X.cta.x + 300, X.cta.y - 160], [A.send, X.send.x, X.send.y],
    ]
    const END = 37
    const THIN = { weight: 330, tracking: -0.04 }
    return {
      duration: END,
      nodes: [
        { id: "works", kind: "text", text: "It works.", size: 132, ...THIN, split: "char" },
        { id: "fine", kind: "text", text: "It looks… fine.", size: 84, ...THIN },
        { id: "needs", kind: "text", text: "It just needs a", size: 80, ...THIN },
        { id: "layer", kind: "text", text: "design layer.", size: 112, weight: 720, tracking: -0.05, split: "char", color: "#8e8e93" },
        { id: "hex", kind: "text", text: INDIGO, size: 120, weight: 500, tracking: -0.02, font: "mono", split: "char", mask: true },
        { id: "yours", kind: "text", text: "Now it looks like yours.", size: 72, weight: 640, tracking: -0.035 },
        { id: "tell", kind: "text", text: "Tell your agent the rest.", size: 72, weight: 640, tracking: -0.035 },
        { id: "brief", kind: "text", text: "It gets the whole brief.", size: 64, weight: 620, tracking: -0.03 },
        { id: "land", kind: "text", text: "Every change lands in your code.", size: 64, weight: 620, tracking: -0.03 },
      ],
      render(t, S, Hs) {
        const N = S.nodes
        // the window: floating at an angle in the dark, turning to face us when the work starts
        const settle = prog(t, 5.9, 1.4, E.io)
        const drift = Math.min(t, 6) / 6
        let w = { op: prog(t, 0.2, 1.2), x: lerp(360, 0, settle), y: lerp(20, 0, settle), s: lerp(0.6, 0.84, settle), rx: lerp(13 - 3 * drift, 0, settle), ry: lerp(-20 + 5 * drift, 0, settle), rz: lerp(2, 0, settle) }
        const lift = prog(t, 15.0, 1.2, E.io) * (1 - prog(t, 23.0, 0.8, E.io))
        w.y -= 46 * lift
        w.s -= 0.06 * lift
        const turn = prog(t, 23.0, 1.3, E.io)
        if (t >= 23.0) w = { op: 1 - 0.82 * prog(t, 27.2, 0.8, E.io), x: -300 * turn, y: -46 * (1 - turn), s: 0.78 - 0.14 * turn, rx: 6 * turn, ry: 18 * turn, rz: 0 }
        if (t >= 30.6) w.op *= 1 - prog(t, 30.6, 0.8, E.io)
        S.win = w
        S.cam = track(t, [
          [0, 800, 500, FIT], [8.6, 800, 500, FIT], [9.6, 800, 330, 1.35], [10.2, 800, 330, 1.35], [10.9, 1180, 760, 1.6], [11.3, 1180, 650, 1.55],
          [13.5, 1180, 650, 1.55], [14.9, 800, 500, FIT], [17.0, 800, 500, FIT], [17.8, 860, 500, 1.5], [20.4, 860, 500, 1.5], [21.4, 1000, 375, 1.2], [22.6, 1000, 375, 1.2], [23.6, 800, 500, FIT],
        ])
        session(t, S, A, P, H)
        const shade = prog(t, 10.7, 0.8, E.io) * (1 - prog(t, 13.8, 0.9, E.io))
        if (shade > 0) S.shade = { a: 0.8 * shade }

        // grey until the color is changed; then the color washes out from the headline
        const wave = prog(t, A.enter + 0.05, 1.6, E.io)
        if (wave < 1) S.mono = { x: X.h1c.x, y: X.h1c.y, r: 2600 * wave }
        S.glow = { op: 0.16 * prog(t, 4.6, 1.2) + 0.5 * prog(t, A.enter, 1.6, E.io) * (1 - 0.5 * prog(t, 27, 2)) + 0.4 * prog(t, 31.2, 1.2), s: 1 + 0.25 * prog(t, A.enter, 2) }

        // ---- the opening lines, thin and quiet ----
        if (t < 3.7) {
          const tr = K.rise(t, 0.5, 9, { st: 0.035, din: 0.9, dist: 18 })
          N.works = { x: 130, y: 440, anchor: "left", units: K.exit(tr, t, 3.25, { st: 0.01 }) }
          N.fine = { x: 134, y: 580, anchor: "left", units: K.exit(K.rise(t, 1.9, 3, { st: 0.32, dist: 20 }).map((u, i) => (i === 2 ? { ...u, color: "#6e6e73" } : u)), t, 3.25) }
        }
        if (t >= 3.6 && t < 6.2) {
          N.needs = { x: 134, y: 440, anchor: "left", units: K.exit(K.rise(t, 3.75, 4, { st: 0.07, dist: 18 }), t, 5.7) }
          // the first color in the film: "design layer." turns indigo, letter by letter
          let us = K.rise(t, 4.1, 13, { st: 0.03, dist: 22 })
          us = us.map((u, i) => (t >= 4.7 + i * 0.045 ? { ...u, color: mixHex("#8e8e93", "#798cff", prog(t, 4.7 + i * 0.045, 0.4)) } : u))
          N.layer = { x: 128, y: 560, anchor: "left", units: K.exit(us, t, 5.7, { st: 0.01 }) }
        }

        // ---- the value, big, rolling in as it's typed ----
        if (t >= A.custom && t < 15.0) {
          const typedN = Math.floor(prog(t, A.type[0], A.type[1] - A.type[0], E.linear) * 7 + 1e-6)
          let us = Array.from({ length: 7 }, (_, i) => {
            const at = A.type[0] + (i / 7) * (A.type[1] - A.type[0])
            const p = prog(t, at, 0.35)
            return { y: i < typedN ? `${((1 - p) * -100).toFixed(1)}%` : "-110%", op: i < typedN ? 1 : 0, color: t >= A.enter ? mixHex("#f5f5f7", "#798cff", prog(t, A.enter, 0.3)) : undefined }
          })
          N.hex = { x: 150, y: 540, anchor: "left", units: K.exit(us, t, 14.4, { mode: "mask", st: 0.02 }) }
        }

        // ---- captions in color ----
        const cap = (id, n, at, out) => { if (t >= at - 0.05 && t < out + 0.6) N[id] = { x: 960, y: 1000, units: K.exit(K.rise(t, at, n, { st: 0.06, dist: 24 }), t, out) } }
        cap("yours", 5, 15.3, 17.2)
        if (t >= 15.3 && t < 17.8) {
          const st = N.yours
          if (st) st.units = st.units.map((u, i) => (i === 4 ? { ...u, color: mixHex("#f5f5f7", "#798cff", prog(t, 15.9, 0.5)) } : u))
        }
        cap("tell", 5, 17.6, 21.0)
        cap("brief", 5, 24.0, 27.0)
        cap("land", 6, 27.6, 30.4)

        // ---- the agent, at the same angle as the window: two planes in one space ----
        // it arrives once the window has turned out of its way, so the two never overlap
        const tIn = prog(t, 23.8, 1.0)
        if (t >= 23.75 && t < 28.1) S.term = { op: tIn * (1 - prog(t, 27.2, 0.8, E.io)), x: 1050 + 160 * (1 - tIn), y: 250, s: 0.86, chars: (t - 24.4) * 230 }
        const cIn = prog(t, 27.4, 0.9)
        if (t >= 27.3 && t < 31.2) S.code = { op: cIn * (1 - prog(t, 30.4, 0.6, E.io)), x: 410, y: 420 + 30 * (1 - cIn), s: 1, del: prog(t, 28.3, 0.5, E.io), add: prog(t, 28.9, 0.5, E.io) }
        if (t >= 31.0) S.logo = { icon: prog(t, 31.4, 1.1), mark: prog(t, 31.7, 1.1), sub: prog(t, 32.5, 0.9), url: prog(t, 33.0, 0.9) }
        S.black = Math.max(1 - prog(t, 0, 0.8, E.linear), prog(t, END - 1.0, 1.0, E.io))
      },
    }
  },

  /* =================================================================
     I · Layers
     ================================================================= */
  i(H) {
    const { R, E, FIT, prog, track, lerp } = H
    const K = kit(H)
    const X = targets(R)
    // open/openDur 0: the editor is already open when the real window takes over from the planes
    const A = { open: 0, openDur: 0.01, h1: 9.9, color: 13.6, custom: 14.6, type: [14.8, 15.6], enter: 16.4, cta: 19.8, note: [20.6, 22.3], save: 22.7, agentUp: 23.4, send: 24.4 }
    A.clicks = [A.h1, A.color, A.custom, A.cta, A.send]
    A.pointerHold = 0.8
    const P = [
      [9.2, 1150, 760], [A.h1, X.h1.x, X.h1.y], [12.9, X.h1.x + 260, X.h1.y + 220], [A.color, X.color.x, X.color.y], [A.custom, X.custom.x, X.custom.y],
      [17.0, X.custom.x - 40, X.custom.y + 40], [19.2, 1000, 760], [A.cta, X.cta.x, X.cta.y], [23.6, X.cta.x + 300, X.cta.y - 160], [A.send, X.send.x, X.send.y],
    ]
    const END = 38
    // plates are crops of real frames, laid out as planes in one 3D space
    const PL = (id, frame, src, w, parent = "back") => ({ id, kind: "plate", parent, frame, src, w, h: (w * src.h) / src.w })
    const pad = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + p * 2, h: r.h + p * 2 })
    const full = { x: 0, y: 0, w: 1600, h: 1000 }
    const left = { x: 0, y: 0, w: 280, h: 1000 }, right = { x: 1320, y: 0, w: 280, h: 1000 }, bar = pad(R.toolbar, 8)
    const selSrc = pad(R.selection, 30), pickSrc = pad(R.picker, 6), compSrc = pad(R.composer, 10)
    const PW = 1300 // the full frame's width on screen, as a plane and as the window
    const k = PW / 1600
    const CAP = { size: 52, weight: 660, tracking: -0.03 }
    return {
      duration: END,
      nodes: [
        PL("pApp", "app", full, PW),
        PL("pBare", "bare", full, PW),
        PL("pLeft", "bare", left, 280 * k),
        PL("pRight", "bare", right, 280 * k),
        PL("pBar", "bare", bar, bar.w * k),
        { id: "tApp", kind: "text", text: "Your app.", size: 108, weight: 720, tracking: -0.05 },
        { id: "tLayer", kind: "text", text: "+ a design layer.", size: 108, weight: 720, tracking: -0.05, color: LILAC },
        PL("pSel", "h1", selSrc, selSrc.w, "front"),
        { ...PL("pPick", "picker", pickSrc, pickSrc.w, "front"), frames: ["picker", "picker-typed"] },
        { id: "swatch", kind: "html", parent: "front", html: "", style: { width: "56px", height: "56px", borderRadius: "14px", background: INDIGO, boxShadow: "0 0 0 2px rgba(255,255,255,.3), 0 18px 44px rgba(74,93,249,.65)" } },
        { ...PL("pComp", "note-empty", compSrc, compSrc.w, "front"), frames: ["note-empty", "note-text"] },
        { id: "tSel", kind: "text", text: "Select anything.", ...CAP },
        { id: "tChg", kind: "text", text: "Change it like a Figma layer.", ...CAP },
        { id: "tNote", kind: "text", text: "Or leave a note.", ...CAP },
        { id: "tSend", kind: "text", text: "Send it to your agent.", ...CAP },
        { id: "tCode", kind: "text", text: "It lands in your code.", ...CAP },
      ],
      render(t, S, Hs) {
        const N = S.nodes
        const typed = (a, b, n) => Math.floor(prog(t, a, b - a, E.linear) * n + 1e-6) / n
        const cap = (id, n, at, out, y = 1012) => { if (t >= at - 0.05 && t < out + 0.6) N[id] = { x: 960, y, units: K.exit(K.rise(t, at, n, { st: 0.06, dist: 24 }), t, out) } }

        // ---- 1–3. the app as a plane in space; the design layer lands on it; the stack turns to face us ----
        const face = prog(t, 7.0, 1.7, E.io)
        const rx = lerp(56, 0, face), rz = lerp(-24 + 8 * Math.min(t, 7) / 7, 0, face)
        const cz = lerp(-260 + 120 * prog(t, 0, 7.0, E.soft), 0, face)
        // off-center to leave the top left for the words, centered once it faces us
        const px = lerp(1070, 960, face), py = lerp(600, 540, face)
        // the real window fades in over the planes, so they stay opaque (and a hair behind it) until it has
        const fade = t >= 9.3 ? 1 : 0
        if (t < 9.4) {
          N.pApp = { x: px, y: py, z: cz - 2 * face, rx, rz, op: prog(t, 0.3, 1.4) * (1 - fade) }
          const land = prog(t, 4.0, 1.4, E.io)
          const lz = lerp(520, 2, land)
          const lop = prog(t, 3.9, 0.6)
          // the panels sit where they sit in the editor (left, right, the toolbar), turning about the plane's center
          for (const [id, src] of [["pLeft", left], ["pRight", right], ["pBar", bar]]) {
            const dx = (src.x + src.w / 2 - 800) * k, dy = (src.y + src.h / 2 - 500) * k
            N[id] = { x: px + dx, y: py + dy, z: cz + lz, rx, rz, ox: -dx, oy: -dy, op: lop * (1 - prog(t, 6.2, 0.2, E.linear)) }
          }
          // once they land the app makes room for them, as it does in the editor
          N.pBare = { x: px, y: py, z: cz + 1 - 2 * face, rx, rz, op: prog(t, 5.3, 0.5, E.linear) * (1 - fade) }
          // "Your app. + a design layer.": the second line drops in with the panels
          if (t < 7.4) {
            N.tApp = { x: 130, y: 170, anchor: "left", units: K.exit(K.rise(t, 1.0, 2, { st: 0.12 }), t, 6.6) }
            if (t >= 4.2) N.tLayer = { x: 130, y: 290, anchor: "left", units: K.exit(K.rise(t, 4.3, 4, { st: 0.08, dist: -44 }), t, 6.7) }
          }
        }

        // ---- the real editor takes over from the planes, and tilts when a piece of it lifts off ----
        const tilt = (a, b) => prog(t, a, 0.9, E.io) * (1 - prog(t, b, 0.9, E.io))
        const tl = tilt(10.3, 12.3) + tilt(13.8, 15.7) + tilt(20.2, 22.6)
        const w = { op: prog(t, 8.7, 0.6, E.linear), x: 0, y: -16, s: PW / 1440, rx: -6 * tl, ry: -12 * tl, rz: 0 }
        // ---- Send: the editor turns away as the agent's window arrives ----
        const agentTurn = prog(t, 25.0, 1.2, E.io)
        if (t >= 25.0) {
          w.x = -330 * agentTurn
          w.ry = 24 * agentTurn
          w.s = PW / 1440 - 0.2 * agentTurn
          w.op = 1 - 0.82 * prog(t, 28.8, 0.8, E.io)
        }
        if (t >= 31.2) w.op *= 1 - prog(t, 31.2, 0.6, E.io)
        S.win = w
        S.cam = track(t, [
          [0, 800, 500, FIT], [12.9, 800, 500, FIT], [13.4, 1180, 650, 1.55], [15.6, 1180, 650, 1.55], [16.5, 820, 450, 1.0], [19.3, 820, 450, 1.0],
          [20.1, 860, 500, 1.5], [22.9, 860, 500, 1.5], [23.6, 1000, 375, 1.2], [24.6, 1000, 375, 1.2], [25.6, 800, 500, FIT],
        ])
        if (t >= 8.6) session(t, S, A, P, H)

        // ---- 4. the selection lifts off the page as its own layer ----
        if (t >= 10.3 && t < 13.0) {
          const up = prog(t, 10.4, 0.9, E.io) * (1 - prog(t, 12.0, 0.7, E.io))
          const o = Hs.onWindow(S, selSrc.x + selSrc.w / 2, selSrc.y + selSrc.h / 2, 260 * up)
          N.pSel = { ...o, w: selSrc.w * o.k, h: selSrc.h * o.k, op: Math.min(1, up * 3) }
        }
        cap("tSel", 2, 10.5, 12.3)

        // ---- 5. the picker lifts; the color leaves it and lands on the headline ----
        if (t >= 13.7 && t < 17.0) {
          const up = prog(t, 13.85, 0.7, E.io) * (1 - prog(t, A.enter - 0.2, 0.5, E.io))
          const lift = 220 * up
          const o = Hs.onWindow(S, pickSrc.x + pickSrc.w / 2, pickSrc.y + pickSrc.h / 2, lift)
          const typing = t >= A.custom ? { field: R.typeColor, p: typed(A.type[0], A.type[1], 7), caret: true, t } : null
          N.pPick = { ...o, w: pickSrc.w * o.k, h: pickSrc.h * o.k, op: Math.min(1, up * 2.5), frame: t >= A.custom ? "picker-typed" : "picker", typing }
          if (t >= A.enter - 0.7 && t < A.enter + 0.4) {
            const p = prog(t, A.enter - 0.65, 0.65, E.io)
            const line = R.typeColor?.lines?.[0] ?? { x0: 1526, x1: 1578, y0: 850, y1: 866 }
            const a = Hs.onWindow(S, (line.x0 + line.x1) / 2, (line.y0 + line.y1) / 2, lift + 30)
            const b = Hs.onWindow(S, X.h1c.x, X.h1c.y, 0)
            N.swatch = { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) - 220 * Math.sin(Math.PI * p), z: lerp(a.z, b.z, p) + 160 * Math.sin(Math.PI * p), s: 1.1 - 0.6 * p, rz: 90 * p, op: prog(t, A.enter - 0.7, 0.12) * (1 - prog(t, A.enter + 0.05, 0.25)) }
          }
        }
        cap("tChg", 6, 14.0, 17.4)

        // ---- 6. the note lifts while it's written ----
        if (t >= 20.0 && t < 23.6) {
          const up = prog(t, 20.2, 0.7, E.io) * (1 - prog(t, A.save - 0.05, 0.45, E.io))
          const o = Hs.onWindow(S, compSrc.x + compSrc.w / 2, compSrc.y + compSrc.h / 2, 220 * up)
          const typing = t >= A.note[0] ? { field: R.typeNote, p: typed(A.note[0], A.note[1], 38), caret: true, t } : null
          N.pComp = { ...o, w: compSrc.w * o.k, h: compSrc.h * o.k, op: Math.min(1, up * 2.5), frame: t >= A.note[0] ? "note-text" : "note-empty", typing }
        }
        cap("tNote", 4, 20.3, 23.2)

        // ---- 7. the agent's window: another plane, facing the editor ----
        cap("tSend", 5, 24.9, 28.1)
        // it arrives once the editor has turned out of its way, so the two never overlap
        const tIn = prog(t, 25.75, 1.0)
        if (t >= 25.7 && t < 31.8) S.term = { op: tIn * (1 - prog(t, 28.8, 0.8, E.io)), x: 1060 + 160 * (1 - tIn), y: 250, s: 0.86, chars: (t - 26.4) * 230 }
        const cIn = prog(t, 29.0, 0.9)
        if (t >= 28.9 && t < 31.8) S.code = { op: cIn * (1 - prog(t, 31.2, 0.6, E.io)), x: 410, y: 480 + 30 * (1 - cIn), s: 1, del: prog(t, 29.8, 0.5, E.io), add: prog(t, 30.4, 0.5, E.io) }
        cap("tCode", 5, 29.1, 31.1, 395)

        S.glow = { op: 0.25 * prog(t, 4.0, 1.4) * (1 - prog(t, 8.6, 1)) + 0.5 * prog(t, 32.2, 1.2), s: 1.2 }
        if (t >= 32.0) S.logo = { icon: prog(t, 32.4, 1.0), mark: prog(t, 32.7, 1.0), sub: prog(t, 33.5, 0.9), url: prog(t, 34.0, 0.9) }
        S.black = Math.max(1 - prog(t, 0, 0.8, E.linear), prog(t, END - 1.0, 1.0, E.io))
      },
    }
  },
}
