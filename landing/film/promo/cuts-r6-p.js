/*
 * P · Landing: the landing page, in motion. It opens as the page does: the
 * hero line, and under it the app, the editor's panels and its toolbar held
 * apart in a gentle 3/4 view, which land in turn into the real editor. Act one
 * is round 5's M (the subtitle lifts while it is rewritten, the hero group
 * while its gap opens). Then the page's own section headings frame the rest,
 * the window beside them, the camera moving differently each time: an orbit
 * for the token, a crane down to the note and a whip up to Send, a slow push
 * into the button while the agent's hover plays, a pull back to the board.
 * It ends on the page's end card.
 */
import {
  C, cut, times, targets, pointerPath, CAM, key, session, layerAct, headline, showHeadline,
  planeNodes, planes, WIN, AGENT_NODE, kit, canvasSpace, canvasStates, CANVAS_NODES, endNodes, endCard,
} from "./cuts-r6.js"

export const CUTS = {
  p: cut(function (H) {
    const { R, E, prog, track, lerp } = H
    const K = kit(H)
    const X = targets(R)
    const T = 5.2
    const A = times(T, { ctaClick: 15.1, tokenField: 15.8, token: 16.9, notesTool: 18.5, noteAt: 19.0, note: [19.4, 20.8], save: 21.2, changes: 21.7, send: 22.3, collapse: 23.7, hover: 25.0 })
    const P = pointerPath(A, X, [T - 0.5, 1100, 820])
    const act = layerAct(H, A)
    const END = 35.9
    // beside a heading, the window sits right and a little smaller
    const SIDE = { x: 330, y: 8, s: 0.68 }
    return {
      duration: END,
      nodes: [
        ...planeNodes(R),
        { id: "click", kind: "html", html: '<div style="width:220px;height:220px;border-radius:50%;background:radial-gradient(closest-side, rgba(255,255,255,0.55), rgba(121,140,255,0.18) 55%, transparent)"></div>' },
        headline("hero", "Bring the design layer", "to your vibe-coded apps.", { size: 96, weight: 560, tracking: -0.042, lines: true, lineHeight: 1.04 }),
        headline("h1", "Design like Figma.", "On the real thing.", { size: 46, weight: 560, tracking: -0.025 }),
        ...act.nodes,
        // act one's captions, in the page's two tones
        headline("c1", "Edit the copy.", "Right on the page.", { size: 46, weight: 560, tracking: -0.025 }),
        headline("c2", "Measure the spacing.", "Tune it with auto layout.", { size: 46, weight: 560, tracking: -0.025 }),
        headline("h2", "Your design system.", "Not ours.", { size: 70, lines: true }),
        { id: "chip", kind: "html", parent: "front", html: '<div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-radius:12px;background:#1d1f2a;box-shadow:0 0 0 1px rgba(165,178,255,.5),0 18px 40px rgba(0,0,0,.5);font:600 22px/1 InterFilm,sans-serif;color:#e5e8ff;white-space:nowrap"><span style="width:18px;height:18px;border:2.5px solid #a5b2ff;border-radius:6px 2px 2px 2px;border-right:0;border-bottom:0"></span>radius · 8px</div>' },
        headline("h3", "Point at it.", "Your agent fixes it.", { size: 70, lines: true }),
        AGENT_NODE,
        headline("c6", "Your agent", "builds it.", { size: 46, weight: 560, tracking: -0.025 }),
        ...CANVAS_NODES,
        headline("h4", "Every page.", "One board.", { size: 64 }),
        ...endNodes(),
      ],
      render(t, S, Hs) {
        const N = S.nodes
        H.t = t
        // the landing page's light, from the top of the frame
        S.glow = { op: 0.34 * prog(t, 0.2, 1.4) * (1 - prog(t, 4.0, 1.0)) + 0.22 * prog(t, 25.1, 0.8) * (1 - prog(t, 27.7, 0.8)) + 0.4 * prog(t, 31.7, 1.4), y: t < 20 ? -330 : 0, s: 1.5 }

        // ---- 1. the hero: the line, then the three planes landing into the editor ----
        if (t < 4.75) {
          showHeadline(N, H, "hero", 0.35, 2.5, { y: 196, st: 0.06, dim: C.text })
          // at rest: the landing page's 3/4 view, drifting; the planes come apart once
          const land = prog(t, 2.35, 1.85, E.io)
          // before it lands the stack drifts closer and turns a little toward us, and the planes come apart
          const drift = prog(t, 0, 2.4, E.soft)
          const apart = prog(t, 0.2, 1.7, E.io)
          const panels = 1 - prog(t, 2.95, 1.0, E.io), bar = 1 - prog(t, 3.3, 0.9, E.io)
          const s = lerp(0.56 + 0.08 * drift, 1, land)
          // the toolbar presses in as it lands, and a light marks the click
          const press = Math.sin(Math.PI * prog(t, 4.05, 0.28, E.linear))
          planes(N, R, {
            cx: 960, cy: lerp(672, 540, land), s,
            rx: lerp(26 - 3 * drift, 0, land), ry: lerp(15 - 5 * drift, 0, land), rz: lerp(-4 + drift, 0, land),
            hp: 0.1 * 1300 * s * apart * panels, ht: 0.24 * 1300 * s * apart * bar, tb: 1 + 0.25 * bar - 0.035 * press,
            op: prog(t, 0.1, 0.8, E.linear) * (1 - prog(t, 4.5, 0.12, E.linear)),
          })
          const tbc = { x: 960 + (R.toolbar.x + R.toolbar.w / 2 - 800) * (1300 / 1600), y: 540 + (R.toolbar.y + R.toolbar.h / 2 - 500) * (1300 / 1600) }
          const flash = Math.sin(Math.PI * prog(t, 4.08, 0.5, E.linear))
          if (flash > 0.01) N.click = { ...tbc, op: 0.8 * flash, s: 0.6 + 0.8 * prog(t, 4.08, 0.5) }
        }

        // ---- the window takes over where the planes landed ----
        const side = prog(t, 14.6, 0.9, E.io) * (1 - prog(t, 22.8, 0.8, E.io))
        const w = { op: prog(t, 4.15, 0.35, E.linear), x: lerp(0, SIDE.x, side), y: lerp(WIN.y, SIDE.y, side), s: lerp(WIN.s, SIDE.s, side), rx: 0, ry: 0, rz: 0 }
        // the token: the window turns slowly while the camera inside closes in
        const orbit = prog(t, 14.6, 0.9, E.io) * (1 - prog(t, 17.9, 0.7, E.io))
        w.ry = -11 * orbit + 7 * prog(t, 15.3, 2.4, E.soft) * orbit
        w.rx = 3 * orbit
        // the note: a crane, the window rising as the camera goes down to the button
        const crane = prog(t, 18.2, 0.9, E.io) * (1 - prog(t, 21.3, 0.6, E.io))
        w.y += -26 * crane
        S.win = w
        S.cam = track(t, [
          [0, ...CAM.FULL], ...act.keys,
          key(15.3, "TOKEN"), key(16.0, "TOKEN"), key(16.45, "PICKER"), key(17.1, "PICKER"), key(17.6, "CTA"), key(18.0, "CTA"),
          key(18.45, "FULL"), key(18.95, "NOTE"), key(21.25, "NOTE"),
          // the whip up to Send: quick, with a blur in the middle of it
          key(21.6, "SENDBTN", E.io), key(22.8, "SENDBTN"),
          // Send lands, then three clear steps: back to the whole page, the editor steps aside, the agent comes in
          key(23.6, "FULL"), key(24.15, "FULL"), key(25.05, "APPCTA"),
          // the hover: a slow push in, all the way to the button
          key(27.7, "MACRO", E.soft), key(28.35, "FULL"),
        ])
        const whip = Math.sin(Math.PI * prog(t, 21.25, 0.35, E.linear))
        if (whip > 0.02) S.frameBlur = 3.5 * whip
        if (t >= 4.15) session(t, S, A, P, H)
        if (t >= 4.15) act.render(t, S, N, Hs)

        // ---- words ----
        showHeadline(N, H, "h1", 4.45, 5.75, { y: 1005 })
        showHeadline(N, H, "c1", T + 0.8, T + 3.8, { y: 1005 })
        showHeadline(N, H, "c2", T + 4.7, T + 9.0, { y: 1005 })
        showHeadline(N, H, "h2", 14.85, 17.75, { x: 118, y: 520, anchor: "left" })
        showHeadline(N, H, "h3", 18.15, 22.5, { x: 118, y: 520, anchor: "left" })

        // the token leaves the picker and lands on the button
        if (t >= A.token - 0.6 && t < A.token + 0.3) {
          const p = prog(t, A.token - 0.55, 0.55, E.io)
          const a = Hs.onWindow(S, X.tokenRow.x + 40, X.tokenRow.y, 30), b = Hs.onWindow(S, X.cta.x, X.cta.y, 20)
          N.chip = { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) - 150 * Math.sin(Math.PI * p), z: lerp(a.z, b.z, p) + 120 * Math.sin(Math.PI * p), s: 1 - 0.45 * p, op: prog(t, A.token - 0.6, 0.12) * (1 - prog(t, A.token + 0.02, 0.2)) }
        }

        // ---- the agent's pointer comes in and rests on the button ----
        if (t >= 24.1 && t < 28.1) {
          const target = Hs.toScreen(S, X.appCta.x + 18, X.appCta.y + 6)
          const p = prog(t, A.hover - 0.85, 0.85, E.io)
          const zoom = S.cam.s
          N.agent = { x: lerp(target.x + 520, target.x, p), y: lerp(target.y + 260, target.y, p) - 60 * Math.sin(Math.PI * p), anchor: "topleft", s: 1 + 0.18 * Math.max(0, zoom - 3), op: prog(t, 24.1, 0.25) * (1 - prog(t, 27.65, 0.3)) }
        }
        showHeadline(N, H, "c6", 25.2, 27.4, { y: 1005 })

        // ---- the canvas: the page shrinks to its frame on the board, and the camera pulls back ----
        if (t >= 28.15) {
          const cs = canvasSpace(R)
          const homeC = { x: cs.fit.x + cs.fit.w / 2, y: cs.fit.y + cs.fit.h / 2 }
          const shrink = prog(t, 28.15, 0.8, E.io)
          const zA = 560 / cs.fit.w
          w.s = lerp(WIN.s, (560 / 1300) * WIN.s, shrink)
          w.y = lerp(WIN.y, WIN.y * (560 / 1300), shrink)
          const zp = prog(t, 29.0, 2.0, E.io)
          const z = Math.exp(lerp(Math.log(zA), Math.log(1.78), zp))
          const focus = { x: lerp(homeC.x, 812, zp), y: lerp(homeC.y, 300, zp) }
          const tilt = prog(t, 31.2, 1.3, E.io)
          const swapBlur = 5 * Math.sin(Math.PI * prog(t, 28.7, 0.45, E.linear))
          if (t >= 28.7) Object.assign(N, canvasStates(R, z, focus, { x: 960, y: lerp(540, 600, zp) + 60 * tilt }, { op: prog(t, 28.75, 0.3, E.linear) * (1 - prog(t, 31.35, 0.65, E.io)), rx: 46 * tilt, rz: -12 * tilt, z: -240 * tilt, blur: swapBlur }))
          if (swapBlur > 0.05) S.frameBlur = swapBlur
          w.op *= 1 - prog(t, 28.85, 0.25, E.linear)
        }
        showHeadline(N, H, "h4", 29.3, 31.3, { y: 118 })

        endCard(N, K, H, 32.0)
        S.black = Math.max(1 - prog(t, 0, 0.5, E.linear), prog(t, END - 0.9, 0.9, E.io))
      },
    }
  }),
}
