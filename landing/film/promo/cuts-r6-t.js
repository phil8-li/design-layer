/*
 * T · One move: the whole film is one unbroken camera move through 3D space.
 * It opens far out in the dark on the editor as an exploded view (the page,
 * the panels and the toolbar held far apart and turned steeply), behind the
 * landing page's hero line. The camera flies through the line; the stack turns
 * to face it, its layers land in turn, and the window takes over where they
 * land. Act one is round 5's M. After it the window never stops moving: it
 * orbits towards the inspector for the token, cranes down to the note, rises
 * with the send, swings back down to the button for the agent's hover, then
 * climbs away until the page is one frame on a board lying back like a
 * landscape. The words stand in the space on the window's own plane, so the
 * camera passes them as it moves. It ends on the landing page's end card, in
 * the sky above the board.
 */
import {
  C, cut, times, targets, pointerPath, CAM, key, session, layerAct, actCaptions, showActCaptions, headline, showHeadline,
  planeNodes, planes, turn, WIN, AGENT_NODE, caption, showCaption, ICON, kit, canvasSpace, canvasStates, CANVAS_NODES, endNodes, endCard, COPY_LEN, NOTE_LEN,
} from "./cuts-r6.js"

/** The stage's perspective (promo.css #world): how far the eye is from the screen plane. */
const EYE = 2400

/**
 * A smooth path through poses [[t, {x, y, s, rx, ry, rz}]]: monotone cubic per
 * field (scale in log space), so the move flows through each pose without
 * stopping or overshooting, and rests only where two poses agree.
 */
function flight(t, keys) {
  const n = keys.length
  if (t <= keys[0][0]) return { ...keys[0][1] }
  if (t >= keys[n - 1][0]) return { ...keys[n - 1][1] }
  let i = 0
  while (t > keys[i + 1][0]) i++
  const out = {}
  for (const f of Object.keys(keys[0][1])) {
    const ts = keys.map((k) => k[0]), vs = keys.map((k) => (f === "s" ? Math.log(k[1][f]) : k[1][f]))
    const d = []
    for (let j = 0; j < n - 1; j++) d.push((vs[j + 1] - vs[j]) / (ts[j + 1] - ts[j]))
    const m = vs.map((_, j) => (j === 0 || j === n - 1 || d[j - 1] * d[j] <= 0 ? 0 : (d[j - 1] + d[j]) / 2))
    for (let j = 0; j < n - 1; j++) {
      if (d[j] === 0) { m[j] = 0; m[j + 1] = 0; continue }
      const a = m[j] / d[j], b = m[j + 1] / d[j], s = a * a + b * b
      if (s > 9) { const k = 3 / Math.sqrt(s); m[j] = k * a * d[j]; m[j + 1] = k * b * d[j] }
    }
    const h = ts[i + 1] - ts[i], u = (t - ts[i]) / h
    const v = (2 * u ** 3 - 3 * u ** 2 + 1) * vs[i] + (u ** 3 - 2 * u ** 2 + u) * h * m[i] + (-2 * u ** 3 + 3 * u ** 2) * vs[i + 1] + (u ** 3 - u ** 2) * h * m[i + 1]
    out[f] = f === "s" ? Math.exp(v) : v
  }
  return out
}
/**
 * A point on the window's plane, extended past its edges: (lx, ly) in window
 * px from its centre, lifted `lift` px towards us. Words placed there turn and
 * travel with the window, so they stand in the same space; k scales them with it.
 */
function onPlane(w, lx, ly, lift = 0) {
  const [px, py, pz] = turn(lx * w.s, ly * w.s, lift, w.rx ?? 0, w.ry ?? 0, w.rz ?? 0)
  return { x: 960 + w.x + px, y: 540 + w.y + py, z: (w.z ?? 0) + pz, rx: w.rx ?? 0, ry: w.ry ?? 0, rz: w.rz ?? 0, k: w.s / WIN.s }
}
/** Stands node `id` (already given its units this frame) at a point of the window's plane. */
function stand(N, w, id, lx, ly, lift = 0, s = 1) {
  const n = N[id]
  if (!n) return
  const p = onPlane(w, lx, ly, lift)
  N[id] = { ...n, anchor: undefined, x: p.x, y: p.y, z: p.z, rx: p.rx, ry: p.ry, rz: p.rz, s: s * p.k }
}

export const CUTS = {
  t: cut(function (H) {
    const { R, E, prog, track, lerp } = H
    const K = kit(H)
    const X = targets(R)
    const T = 5.4
    const A = times(T, { ctaClick: 15.6, tokenField: 16.3, token: 17.4, notesTool: 19.2, noteAt: 19.7, note: [20.1, 21.5], save: 21.9, changes: 22.5, send: 23.1, collapse: 24.3, hover: 25.65 })
    const P = pointerPath(A, X, [T - 0.5, 1100, 820])
    const act = layerAct(H, A)
    const END = 36.0
    const LAND = 4.6
    const HOME = { x: 0, y: WIN.y, s: WIN.s, rx: 0, ry: 0, rz: 0 }
    // the window's flight after the hand-over: where it is, and how it is turned
    const FLIGHT = [
      [LAND, HOME], [14.55, HOME],
      // an orbit towards the inspector, still turning while the token is set
      [15.75, { x: 285, y: 10, s: 0.7, rx: -4, ry: -17, rz: 0 }],
      [18.6, { x: 330, y: -4, s: 0.72, rx: -1, ry: -11, rz: 0 }],
      // a crane down from above to the button
      [19.8, { x: -250, y: 70, s: 0.72, rx: -15, ry: 13, rz: 0 }],
      [21.8, { x: -270, y: -14, s: 0.73, rx: -3, ry: 8, rz: 0 }],
      // a rise with the send, up to Changes and Send to agent
      [23.2, { x: -260, y: 56, s: 0.73, rx: -12, ry: 5, rz: 0 }],
      // a beat on Send, then back to the whole window, almost still while the editor steps aside
      [23.6, { x: -257, y: 58, s: 0.73, rx: -12.5, ry: 4.6, rz: 0 }],
      [24.25, { x: 0, y: -16, s: 0.905, rx: 0.5, ry: 1, rz: 0 }],
      [24.8, { x: 0, y: -19, s: 0.912, rx: 1.2, ry: 2, rz: 0 }],
      // down to the button with the agent's pointer, then circling it slowly while the hover plays
      [25.7, { x: 0, y: -30, s: 0.95, rx: 6, ry: 9, rz: 0 }],
      [28.3, { x: 0, y: -40, s: 1.0, rx: 0, ry: -3, rz: 0 }],
      [29.05, HOME],
    ]
    // the hover, framed close (its patches are 4× captures, so the button stays sharp)
    const HOVER = [800, 528, 5.0]
    // the flight in, as the picture computes it: how far the camera has come at t, and where the hero line is
    const flyF = (t) => 0.05 * prog(t, 0, 2.4, E.soft) + 0.95 * prog(t, 1.9, LAND - 1.9, E.io)
    const lineZ = (t) => EYE * (1 - 1 / Math.exp(lerp(Math.log(0.62), 0, flyF(t)))) + 1370
    let linePass = 0
    for (let t = 0; t < LAND; t += 0.005) if (lineZ(t) < 550) linePass = t
    const r2 = (v) => Math.round(v * 1000) / 1000
    /*
     * The film's events on one clock, for the sound to be laid against
     * (sound/cues.mjs reads them as window.CUES). Times in seconds.
     */
    const cues = {
      duration: END,
      open: { fadeIn: [0, 0.6], heroWords: Array.from({ length: 10 }, (_, i) => r2(0.45 + 0.2 + i * 0.07)), flyStart: 1.9, linePass: r2(linePass), panelsLand: 4.15, barLand: 4.5, land: LAND },
      act1: {
        subClick: A.subClick, dbl: [r2(A.dbl - 0.12), A.dbl], selAll: A.selAll, type: A.type, typeChars: COPY_LEN, enter: A.enter,
        copyUp: [r2(T + 0.75), r2(T + 1.65)], copyDown: [r2(T + 3.45), r2(T + 4.15)],
        h1Click: A.h1Click, alt: A.alt, altUp: A.altUp, parent: A.parent,
        groupUp: [r2(T + 6.55), r2(T + 7.4)], scrub: A.scrub, gapFrom: 24, gapTo: 36, gapSet: r2(A.scrub[1] + 0.1), groupDown: [r2(T + 8.8), r2(T + 9.5)],
        pushIn: [r2(T + 0.15), r2(T + 0.65)], pullOut: [r2(T + 4.15), r2(T + 4.55)], toGroup: [r2(T + 6.15), r2(T + 6.5)],
      },
      moves: { orbit: [14.55, 15.75], crane: [18.6, 19.8], rise: [21.8, 23.2], back: [23.6, 24.25], down: [24.8, 25.7], circle: [25.7, 28.3], home: [28.3, 29.05] },
      token: { ctaClick: A.ctaClick, tokenField: A.tokenField, token: A.token, chip: [r2(A.token + 0.05), r2(A.token + 0.85)] },
      note: { notesTool: A.notesTool, noteAt: A.noteAt, note: A.note, noteChars: NOTE_LEN, save: A.save, changes: A.changes, send: A.send },
      agent: { collapse: A.collapse, soften: r2(A.collapse - 0.18), panelsOut: [A.collapse, r2(A.collapse + 0.55)], pointer: [r2(A.collapse + 0.5), r2(A.collapse + 1.35)], hover: A.hover, sheen: [r2(A.hover + 0.05), r2(A.hover + 0.9)], lightStart: r2(A.hover + 0.9), lightTurn: 2.0 },
      canvas: { shrink: [29.05, 29.9], swap: 29.6, zoom: [29.85, 32.15], tilt: [30.2, 33.4], title: [30.15, 31.9] },
      end: { card: 32.6, name: 32.85, sweep: [33.15, 35.35], line: 33.3, button: 34.1, url: 34.35, fadeOut: [r2(END - 0.9), END] },
      words: { c1: [r2(A.subClick + 0.8), r2(A.subClick + 3.8)], c2: [r2(A.subClick + 4.7), r2(A.subClick + 9.0)], h2: [15.35, 18.45], h3: [19.45, 23.45], c6: [26.0, 28.4] },
    }
    return {
      duration: END,
      cues,
      nodes: [
        ...planeNodes(R),
        { ...headline("hero", "Bring the design layer", "to your vibe-coded apps.", { size: 96, weight: 560, tracking: -0.042, lines: true, lineHeight: 1.04 }), parent: "front" },
        ...act.nodes,
        ...actCaptions().map((c) => ({ ...c, parent: "front" })),
        { ...headline("h2", "Your design system.", "Not ours.", { size: 92, lines: true }), parent: "front" },
        { id: "chip", kind: "html", parent: "front", html: '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-radius:12px;background:#1d1f2a;box-shadow:0 0 0 1px rgba(165,178,255,.5),0 18px 40px rgba(0,0,0,.5);font:600 22px/1 InterFilm,sans-serif;color:#e5e8ff;white-space:nowrap"><span style="width:18px;height:18px;border:2.5px solid #a5b2ff;border-radius:6px 2px 2px 2px;border-right:0;border-bottom:0"></span>radius · 8px</div>' },
        { ...headline("h3", "Point at it.", "Your agent fixes it.", { size: 92, lines: true }), parent: "front" },
        { ...AGENT_NODE, parent: "front" },
        { ...caption("c6", "**Your agent** built it.", ICON.agent(C.agent)), parent: "front" },
        ...CANVAS_NODES.map((n) => ({ ...n, parent: "front" })),
        { ...headline("h4", "Every page.", "One board.", { size: 72 }), parent: "front" },
        ...endNodes(),
      ],
      render(t, S, Hs) {
        const N = S.nodes
        H.t = t
        // the landing page's light from the top: on the dark at the start, back for the sky at the end
        S.glow = { op: 0.36 * prog(t, 0.2, 1.6) * (1 - prog(t, 3.6, 1.2)) + 0.42 * prog(t, 31.5, 1.8), y: -330, s: 1.5 }

        // ---- 1. the flight in: through the hero line to the exploded editor, which assembles ----
        // f: how far the camera has come (0 far out, 1 at the window); a slow drift, then the flight.
        // It moves the stack's apparent size evenly in log space, so the approach never lurches. The
        // stack starts oversized (s) and settles to its true size as the camera comes in, so it fills
        // the frame from the start while the camera still travels far enough to pass the hero line.
        const f = 0.05 * prog(t, 0, 2.4, E.soft) + 0.95 * prog(t, 1.9, LAND - 1.9, E.io)
        const zs = EYE * (1 - 1 / Math.exp(lerp(Math.log(0.62), 0, f)))
        if (t < LAND + 0.5) {
          const turned = 1 - prog(t, 1.5, LAND - 1.5 - 0.1, E.io)
          const panels = 1 - prog(t, 2.9, 1.25, E.io), bar = 1 - prog(t, 3.25, 1.25, E.io)
          planes(N, R, {
            cx: 960, cy: lerp(745, 540, f), s: lerp(1.42, 1, f),
            rx: 52 * turned - 4 * (1 - prog(t, 0, 2.5, E.soft)) * turned, ry: -28 * turned, rz: 5 * turned + 3 * prog(t, 0, 3, E.soft) * turned,
            hp: 300 * panels, ht: 500 * bar, tb: 1 + 0.2 * bar,
            op: prog(t, 0.15, 1.0, E.linear) * (1 - prog(t, LAND + 0.32, 0.12, E.linear)),
          })
          // far out, a rim light: bright edges, a lit top edge and a faint indigo halo keep the
          // layers apart from the dark round them, and the dark panels are lifted a little
          const rim = turned
          for (const id of ["plPage", "plLeft", "plRight", "plBar"]) if (N[id]) {
            N[id].z += zs
            N[id].css.boxShadow += `, 0 0 0 1px rgba(205,212,255,${(0.34 * rim).toFixed(3)}), inset 0 1px 0 rgba(255,255,255,${(0.5 * rim).toFixed(3)}), 0 0 60px rgba(121,140,255,${(0.22 * rim).toFixed(3)})`
            if (id !== "plPage") N[id].css.filter = `brightness(${(1 + 0.6 * rim).toFixed(3)})`
            else N[id].css.filter = "none"
          }
        }
        // the hero line stands between us and the stack; the camera reads it, then flies through it
        if (t < 3.9) {
          showHeadline(N, H, "hero", 0.45, 99, { st: 0.07 })
          if (N.hero) {
            const z = zs + 1370
            const pass = prog(z, 200, 700, E.linear)
            N.hero = { ...N.hero, x: 960, y: 150, z, op: 1 - pass }
            N.hero.units = N.hero.units.map((u) => ({ ...u, blur: (u.blur ?? 0) + 10 * pass }))
          }
        }

        // ---- the window takes over where the planes land, and from then on it flies ----
        const w = { ...flight(t, FLIGHT), z: 0, op: prog(t, LAND, 0.35, E.linear) }
        S.win = w
        S.cam = track(t, [
          [0, ...CAM.FULL], ...act.keys,
          // the token: into the inspector, the picker, then to the button it lands on
          key(15.65, "TOKEN"), key(16.15, "TOKEN"), key(16.65, "PICKER"), key(17.5, "PICKER"), key(18.25, "CTA"), key(18.75, "CTA"),
          // the note: out to the toolbar's notes tool, then down to the button
          key(19.3, "FULL"), key(19.85, "NOTE"), key(21.95, "NOTE"),
          // the send: up to the Changes tab and its button
          key(22.45, "SEND"), key(22.85, "SENDBTN"), key(23.6, "SENDBTN"),
          // the agent: down to the button, then slowly closer while the light runs round it
          key(24.2, "FULL"), key(24.8, "FULL", E.soft), key(25.7, "APPCTA"), [28.75, ...HOVER, E.soft], key(29.5, "FULL"),
        ])
        if (t >= LAND) session(t, S, A, P, H)
        if (t >= LAND) act.render(t, S, N, Hs)

        // ---- words in the space ----
        showActCaptions(N, K, H, A)
        // below the window, on its plane: they tilt with it while a layer is up
        for (const id of ["c1", "c2"]) stand(N, S.win, id, 0, 468 + 58)
        // beside the work, on the window's plane past its edge; the far side, so they recede a little
        showHeadline(N, H, "h2", 15.35, 18.45)
        stand(N, S.win, "h2", -1250, -20, 140)
        showHeadline(N, H, "h3", 19.45, 23.45)
        stand(N, S.win, "h3", 1200, -20, 140)

        // the token leaves the picker and the camera follows it to the button, which keeps its
        // old corners until the token lands on it
        const LANDC = A.token + 0.85
        if (t >= A.token && t < LANDC + 0.25) {
          const q = prog(t, LANDC - 0.05, 0.25, E.linear)
          S.frames = q > 0 ? { "token-picker": 1, "token-set": q } : { "token-picker": 1 }
        }
        if (t >= A.token - 0.05 && t < LANDC + 0.3) {
          const p = prog(t, A.token + 0.05, LANDC - A.token - 0.05, E.io)
          const a = Hs.onWindow(S, X.tokenRow.x + 40, X.tokenRow.y, 30), b = Hs.onWindow(S, X.cta.x, X.cta.y, 20)
          N.chip = { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) - 150 * Math.sin(Math.PI * p), z: lerp(a.z, b.z, p) + 120 * Math.sin(Math.PI * p), rx: a.rx, ry: a.ry, s: 1 - 0.45 * p, op: prog(t, A.token - 0.05, 0.12) * (1 - prog(t, LANDC - 0.05, 0.2)) }
        }

        // ---- the agent's pointer comes in and rests on the button, on the window's plane ----
        if (t >= A.collapse + 0.45 && t < 29.2) {
          const target = Hs.onWindow(S, X.appCta.x + 18, X.appCta.y + 6, 3)
          const p = prog(t, A.collapse + 0.5, 0.85, E.io)
          N.agent = { ...target, x: lerp(target.x + 520, target.x, p), y: lerp(target.y + 260, target.y, p) - 60 * Math.sin(Math.PI * p), anchor: "topleft", s: 1 + 0.2 * Math.max(0, S.cam.s - 3), op: prog(t, A.collapse + 0.45, 0.25) * (1 - prog(t, 28.6, 0.3)) }
        }
        showCaption(N, K, H, "c6", 26.0, 28.4)
        stand(N, S.win, "c6", 0, 468 + 58)

        // ---- the climb: the page shrinks to its frame on the board, and the board lies back below us ----
        if (t >= 29.05) {
          const cs = canvasSpace(R)
          // the board shows the home page at a narrower width, so the two are matched on its
          // headline: (472, 132.5) on the board is (801.5, 320) on the page, at 0.175 board px per page px
          const shrink = prog(t, 29.05, 0.85, E.io)
          w.s = lerp(WIN.s, (560 / 1300) * WIN.s, shrink)
          w.y = lerp(WIN.y, WIN.y * (560 / 1300), shrink)
          const k0 = (1300 * w.s) / WIN.s / 1600
          const zp = prog(t, 29.85, 2.3, E.io)
          // the board follows the page while it is still shrinking, so the headline lies exactly on it
          const z = (k0 / 0.175) * Math.exp(lerp(0, Math.log(1.78 / (560 / 1600 / 0.175)), zp))
          const focus = { x: lerp(472, 812, zp), y: lerp(132.5, 300, zp) }
          const at0 = { x: 960 + 1.5 * k0, y: 540 + (320 - 500) * k0 }
          // the climb goes on past the board: it lies further back and sinks as the camera rises
          const tilt = prog(t, 30.2, 3.2, E.io)
          const swapBlur = 5 * Math.sin(Math.PI * prog(t, 29.6, 0.45, E.linear))
          if (t >= 29.6) Object.assign(N, canvasStates(R, z, focus, { x: lerp(at0.x, 960, zp), y: lerp(at0.y, 620, zp) + 420 * tilt }, { op: prog(t, 29.65, 0.3, E.linear) * (1 - 0.75 * prog(t, 32.0, 1.6, E.io)) * (1 - prog(t, 33.4, 1.1, E.io)), rx: 58 * tilt, rz: -10 * tilt, z: -420 * tilt, blur: swapBlur + 2 * prog(t, 32.0, 1.6, E.io) }))
          if (swapBlur > 0.05) S.frameBlur = swapBlur
          w.op *= 1 - prog(t, 29.62, 0.25, E.linear)
        }
        // the board's title stands above it, upright, and sinks with it as the camera climbs
        if (t >= 30.0) {
          showHeadline(N, H, "h4", 30.15, 31.9)
          if (N.h4) N.h4 = { ...N.h4, y: 118 + 60 * prog(t, 30.15, 2.6, E.io), z: 80 - 160 * prog(t, 30.15, 2.6, E.io) }
        }

        endCard(N, K, H, 32.6)
        S.black = Math.max(1 - prog(t, 0, 0.6, E.linear), prog(t, END - 0.9, 0.9, E.io))
      },
    }
  }),
}
