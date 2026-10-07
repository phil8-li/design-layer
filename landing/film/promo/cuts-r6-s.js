/*
 * S · Macro: the language of a product macro, turned on an interface. It opens
 * a few centimetres from the app's own headline, the page soft round a thin
 * plane of focus, a pool of light drifting across it; the focus racks to the
 * second line and the camera pulls back to the whole page in the editor. Act
 * one is round 5's M. Then every beat is a macro with shallow depth of field:
 * the radius token, racked over to the button taking it; the note typed; Send
 * to agent pressed; the agent's hover in extreme close-up; and one long pull
 * back from the button to the page to every page on the board. Small
 * two-tone supers in the landing page's words; the landing page's end card.
 *
 * Depth of field: the window's frames are blurred (S.frameBlur) and two copies
 * of the region in focus lie over them, one a little soft and wide, one sharp
 * and narrow, each fading out at its edges, so the fall-off is gradual.
 */
import {
  C, cut, times, targets, pointerPath, CAM, session, layerAct, actCaptions, showActCaptions, headline, showHeadline,
  WIN, AGENT_NODE, kit, canvasSpace, canvasStates, CANVAS_NODES, endNodes, endCard, focusNode, showFocus, CURSOR_SVG,
} from "./cuts-r6.js"

/** The window grown past the frame for the macros: its page fills the frame edge to edge. */
const MACRO = { s: 1.42, y: -18 * 1.42 }
const KF = WIN.s
/** Keyframes of plain values: [t, ...values, ease]; each ease shapes the move that ends at its key. */
function tween(t, keys, E) {
  const n = keys[0].length - 1
  const val = (k) => k.slice(1, 1 + n)
  if (t <= keys[0][0]) return val(keys[0])
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i]
    if (t <= b[0]) {
      const a = keys[i - 1]
      const p = (typeof b[n + 1] === "function" ? b[n + 1] : E.io)((t - a[0]) / (b[0] - a[0]))
      return val(a).map((v, j) => v + (b[j + 1] - v) * p)
    }
  }
  return val(keys[keys.length - 1])
}

export const CUTS = {
  s: cut(function (H) {
    const { R, E, prog, track, lerp } = H
    const K = kit(H)
    const X = targets(R)
    const T = 5.6
    const A = times(T, { ctaClick: 15.5, tokenField: 16.25, token: 17.4, notesTool: 19.2, noteAt: 19.6, note: [20.0, 21.6], save: 21.95, changes: 22.55, send: 23.4, collapse: 24.55, hover: 25.95 })
    // the macro never sees the toolbar: the pointer stays by the button on its way to the note
    A.clicks = A.clicks.filter((c) => c !== A.notesTool)
    const P = pointerPath(A, X, [T - 0.5, 1100, 820]).map((p) => (p[0] === A.notesTool - 0.6 ? [p[0], X.cta.x + 70, X.cta.y + 70] : p[0] === A.notesTool ? [p[0], X.cta.x + 40, X.cta.y + 30] : p))
    const act = layerAct(H, A)
    const END = 36.9
    const S0 = 30.15 // the page starts to shrink onto the board
    const BTN = { x: 800, y: 528 } // Get started, on the app after the editor steps aside

    /* the camera outside act one: [t, x, y, k] with k screen px per shot px */
    const CAMK = [
      [0, 610, 279, 4.3],
      [2.3, 740, 282, 3.8, E.soft],
      [3.3, 790, 322, 3.45, E.io],
      [5.0, 800, 500, 0.9 * KF, E.io],
      [15.1, 1010, 450 / 1.3, 1.3 * KF],
      [16.0, 1150, 418, 2.0, E.io],
      [17.7, 1170, 412, 2.18, E.soft],
      [18.45, 800, 506, 3.0, E.io],
      [18.95, 802, 507, 3.05, E.soft],
      [19.8, 860, 572, 3.3, E.io],
      [21.8, 884, 578, 3.5, E.soft],
      [22.55, 1270, 300, 1.7, E.io],
      [23.25, 1428, 272, 4.0, E.io],
      // Send pressed: a hold on it, a pull back to the whole window, the editor steps aside, then in to the button
      [23.9, 1432, 272, 4.1, E.soft],
      [24.5, 800, 500, 0.9 * KF, E.io],
      [25.1, 800, 500, 0.9 * KF],
      [26.05, BTN.x - 8, BTN.y, 4.2, E.io],
      [29.1, BTN.x + 10, BTN.y + 2, 5.0, E.soft],
      [30.35, 800, 500, 0.9 * KF, E.io],
    ]
    /* depth of field: [t, x, y, rx, ry (the sharp region, shot px), blur (screen px on the page)] */
    const DOF = [
      [0, 610, 279, 250, 44, 10],
      [2.2, 740, 279, 250, 44, 10, E.soft],
      [2.9, 790, 341, 260, 46, 10, E.io],
      [3.4, 790, 341, 260, 46, 10],
      [4.6, 800, 340, 420, 120, 0, E.io],
      [15.1, 1460, 300, 190, 110, 0],
      [16.0, 1460, 300, 190, 110, 10, E.io],
      [16.4, 1460, 380, 185, 120, 10, E.io],
      [17.5, 1460, 400, 185, 110, 10],
      [18.05, 800, 504, 130, 70, 10, E.io],
      [19.05, 800, 506, 130, 70, 10],
      [19.65, 865, 580, 150, 95, 10, E.io],
      [22.0, 865, 580, 150, 95, 10],
      [22.55, 1270, 300, 300, 200, 3, E.io],
      [23.2, 1481, 270, 110, 45, 10, E.io],
      [23.9, 1481, 270, 110, 45, 10],
      [24.4, 800, 470, 400, 200, 0, E.io],
      [25.4, 800, 470, 400, 200, 0],
      [26.0, BTN.x, BTN.y, 110, 55, 10, E.io],
      [29.1, BTN.x, BTN.y, 110, 55, 10],
      [29.65, BTN.x, BTN.y, 300, 160, 0, E.io],
    ]
    /* the light: [t, x, y (screen px), radius, darkness at the edges] */
    const LUX = [
      [0, 820, 380, 1050, 0.8],
      [3.3, 1060, 470, 1100, 0.78, E.soft],
      [4.7, 960, 540, 1500, 0, E.io],
      [15.1, 960, 540, 1500, 0],
      [16.0, 1180, 470, 980, 0.62, E.io],
      [17.6, 1240, 460, 980, 0.62],
      [18.6, 960, 520, 940, 0.62, E.io],
      [22.0, 1000, 540, 960, 0.62],
      [23.2, 960, 540, 900, 0.66, E.io],
      [23.9, 960, 540, 900, 0.66],
      [24.5, 960, 540, 1500, 0, E.io],
      [25.3, 960, 540, 1500, 0],
      [26.1, 940, 520, 900, 0.72, E.io],
      [29.1, 1000, 540, 960, 0.72, E.soft],
      [29.9, 960, 540, 1500, 0, E.io],
      [31.0, 960, 540, 1500, 0],
      [32.0, 980, 460, 1250, 0.7, E.io],
    ]
    // how far the window has grown to the macro, and how freely it slides so an edge of the page can be centred
    const macroAt = (t) => Math.max(1 - prog(t, 3.3, 1.7, E.io), prog(t, 15.1, 0.9, E.io) * (1 - prog(t, 23.9, 0.6, E.io)), prog(t, 25.1, 0.95, E.io) * (1 - prog(t, 29.1, 1.25, E.io)))
    const SUPER = { size: 40, weight: 560, tracking: -0.022, lines: true, lineHeight: 1.14 }

    return {
      duration: END,
      nodes: [
        focusNode("fMid", { x: 0, y: 0, w: 1600, h: 1000 }),
        focusNode("fSharp", { x: 0, y: 0, w: 1600, h: 1000 }),
        ...act.nodes,
        ...CANVAS_NODES,
        { id: "lux", kind: "html", html: '<div style="width:1920px;height:1080px"></div>' },
        { id: "scrim", kind: "html", html: '<div style="width:1500px;height:700px;background:radial-gradient(closest-side, rgba(8,8,10,0.78), rgba(8,8,10,0.5) 45%, rgba(8,8,10,0))"></div>' },
        { id: "ptr", kind: "html", html: `<div style="width:22px;height:29px">${CURSOR_SVG}</div>` },
        { id: "rng", kind: "html", html: '<div style="width:34px;height:34px;border-radius:50%;border:1.5px solid rgba(255,255,255,0.85);box-sizing:border-box"></div>' },
        AGENT_NODE,
        headline("s0", "Bring the design layer", "to your vibe-coded apps.", SUPER),
        ...actCaptions(),
        headline("s1", "Your design system.", "Not ours.", SUPER),
        headline("s2", "Point at it.", "Your agent fixes it.", SUPER),
        headline("s3", "Every page.", "One board.", SUPER),
        ...endNodes(),
      ],
      render(t, S, Hs) {
        const N = S.nodes
        H.t = t
        const inAct = t >= 5.0 && t < 15.1

        // ---- the window and the camera ----
        const m = macroAt(t)
        // the page shrinks to its frame on the board
        const shrink = prog(t, S0, 0.8, E.io)
        const wsBase = Math.exp(lerp(Math.log(KF), Math.log(MACRO.s), m))
        const ws = wsBase * lerp(1, 560 / 1300, shrink)
        const wy = lerp(WIN.y, MACRO.y, m) * lerp(1, 560 / 1300, shrink)
        if (inAct) {
          S.win = { op: 1, x: 0, y: WIN.y, s: KF, rx: 0, ry: 0, rz: 0 }
          S.cam = track(t, [[0, ...CAM.FULL], ...act.keys])
        } else {
          const c = track(t, CAMK.map(([tt, x, y, k, e]) => [tt, x, y, k, e]))
          const cam = { x: c.x, y: c.y, s: c.s / wsBase }
          const cc = H.clampCam(cam)
          // slide the window so the point asked for sits at the centre, even past the page's edge
          const free = t < 5.0 ? 1 - prog(t, 3.3, 1.7, E.io) : prog(t, 15.1, 0.9, E.io)
          const dx = (c.x - cc.x) * c.s * free, dy = (c.y - cc.y) * c.s * free
          S.win = { op: 1, x: -dx, y: wy - dy, s: ws, rx: 0, ry: 0, rz: 0 }
          S.cam = cam
        }
        session(t, S, A, P, H)
        if (inAct) act.render(t, S, N, Hs)
        const k = H.clampCam(S.cam).s * S.win.s

        // ---- depth of field ----
        if (!inAct && t < 29.8) {
          const [fx, fy, rx, ry, blur] = tween(t, DOF, E)
          if (blur > 0.05) {
            S.frameBlur = blur / k
            const typing = S.typing ? { ...S.typing, t } : null
            // in focus, the button takes the radius once the camera is on it (the page under it is too soft to tell)
            let fr = S.frames
            if (t >= A.token + 0.26 && t < 19.0) {
              const w = prog(t, 17.7, 0.35, E.linear) * (1 - prog(t, 18.45, 0.4, E.linear))
              fr = { ...fr, "cta-sel": 1, "token-set": 1 - w }
            }
            showFocus(N, S, Hs, "fMid", { x: fx - rx * 2.1, y: fy - ry * 2.3, w: rx * 4.2, h: ry * 4.6 }, 1, 0.75)
            N.fMid.blur = 0.42 * blur
            N.fMid.typing = typing
            N.fMid.frames = fr
            showFocus(N, S, Hs, "fSharp", { x: fx - rx, y: fy - ry, w: rx * 2, h: ry * 2 }, 1, 0.5)
            N.fSharp.typing = typing
            N.fSharp.frames = fr
          }
        }

        // ---- the light: a pool on the subject, the rest of the frame falling off to black ----
        const [lx, ly, lr, la] = tween(t, LUX, E)
        if (la > 0.005) {
          const g = `radial-gradient(${lr.toFixed(0)}px ${(lr * 0.72).toFixed(0)}px at ${lx.toFixed(1)}px ${ly.toFixed(1)}px, rgba(8,8,10,0) 0%, rgba(8,8,10,0) 52%, rgba(8,8,10,${(la * 0.7 * 0.3).toFixed(3)}) 76%, rgba(8,8,10,${(la * 0.7).toFixed(3)}) 100%)`
          N.lux = { x: 960, y: 540, op: 1, css: { background: g } }
        }

        // ---- the pointer, drawn over the focus copies (which would hide the window's own) ----
        if (!inAct && t >= 5.0) {
          const cu = S.cursor
          if (cu) {
            const p = Hs.toScreen(S, cu.x, cu.y)
            N.ptr = { x: p.x - 2, y: p.y - 2, anchor: "topleft", ox: -9, oy: -12.5, s: S.win.s * (1 - 0.12 * (cu.press ?? 0)), op: cu.op }
            S.cursor = null
          }
          const rg = S.ring
          if (rg) {
            const p = Hs.toScreen(S, rg.x, rg.y)
            N.rng = { x: p.x, y: p.y, s: S.win.s * (0.5 + 0.9 * E.out(rg.q)), op: 0.7 * (1 - rg.q) }
            S.ring = null
          }
        }

        // ---- the agent's pointer comes in and rests on the button ----
        if (t >= 25.0 && t < 29.4) {
          const target = Hs.toScreen(S, BTN.x + 47, BTN.y + 7)
          const p = prog(t, 25.1, 0.85, E.io)
          N.agent = { x: lerp(target.x + 520, target.x, p), y: lerp(target.y + 300, target.y, p) - 60 * Math.sin(Math.PI * p), anchor: "topleft", s: 1 + 0.15 * prog(t, 25.4, 0.8, E.io), op: prog(t, 25.0, 0.25) * (1 - prog(t, 29.05, 0.3)),
            // its name tag steps back once it is there, so nothing covers the button's border
            sub: { ".ctag": { css: { opacity: (1 - prog(t, 26.3, 0.5, E.io)).toFixed(3) } } } }
        }

        // ---- the canvas: the page shrinks to its frame on the board, and the camera keeps pulling back ----
        if (t >= S0) {
          const cs = canvasSpace(R)
          const homeC = { x: cs.fit.x + cs.fit.w / 2, y: cs.fit.y + cs.fit.h / 2 }
          const zA = 560 / cs.fit.w
          const zp = prog(t, S0 + 0.8, 1.75, E.io)
          const z = Math.exp(lerp(Math.log(zA), Math.log(1.78), zp))
          const focus = { x: lerp(homeC.x, 812, zp), y: lerp(homeC.y, 300, zp) }
          const swapBlur = 5 * Math.sin(Math.PI * prog(t, S0 + 0.55, 0.45, E.linear))
          // at the end the board goes out of focus, into the end card
          const out = prog(t, 32.8, 0.85, E.io)
          if (t >= S0 + 0.55) Object.assign(N, canvasStates(R, z, focus, { x: 960, y: lerp(540, 600, zp) }, { op: prog(t, S0 + 0.6, 0.3, E.linear) * (1 - out), blur: swapBlur + 16 * out }))
          if (swapBlur > 0.05) S.frameBlur = swapBlur
          S.win.op *= 1 - prog(t, S0 + 0.7, 0.25, E.linear)
        }

        // ---- supers, each on a soft shadow in the lower left ----
        const sup = (a, b) => prog(t, a - 0.2, 0.6, E.io) * (1 - prog(t, b + 0.1, 0.6, E.io))
        const sc = Math.max(sup(0.9, 3.15), sup(15.75, 18.75), sup(19.5, 23.9), sup(31.3, 32.6))
        if (sc > 0.001) N.scrim = { x: 260, y: 930, op: sc }
        showHeadline(N, H, "s0", 0.9, 3.15, { x: 128, y: 920, anchor: "left", st: 0.06, dim: C.dim })
        showActCaptions(N, K, H, A)
        showHeadline(N, H, "s1", 15.75, 18.75, { x: 128, y: 920, anchor: "left" })
        showHeadline(N, H, "s2", 19.5, 23.9, { x: 128, y: 920, anchor: "left" })
        showHeadline(N, H, "s3", 31.3, 32.6, { x: 128, y: 920, anchor: "left" })

        S.glow = { op: 0.4 * prog(t, 33.05, 1.4), s: 1.5 }
        endCard(N, K, H, 33.35)
        S.black = Math.max(1 - prog(t, 0, 0.6, E.linear), prog(t, END - 0.9, 0.9, E.io))
      },
    }
  }),
}
