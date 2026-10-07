/*
 * Q · Keynote: Apple's keynote-film manner. A black stage, one idea per shot,
 * the key object centred with room round it, and every scene carried into
 * the next by an object. It opens on a two-tone line; Design Layer's own
 * selection draws round it and grows into the editor's window. Act one is
 * round 5's M. Then the hero group's selection flies off the page onto the
 * word "Tokens." and shrinks onto the button; the token itself flies from the
 * picker onto the button; the note's pin flies to Send to agent; the button
 * the agent changed is lifted out alone onto black while its light runs
 * round; it goes back into the page, the page into its frame on the board.
 * It ends on the landing page's end card.
 */
import {
  C, cut, times, targets, pointerPath, CAM, key, session, layerAct, headline, showHeadline, BIG,
  WIN, AGENT_NODE, kit, canvasSpace, canvasStates, CANVAS_NODES, endNodes, endCard, hoverNode, hoverFrames, focusNode, showFocus, around,
} from "./cuts-r6.js"

const STAGE = "#08080a"
const lerpRect = (a, b, p, lerp) => ({ x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), w: lerp(a.w, b.w, p), h: lerp(a.h, b.h, p) })
// the window's page on screen (the window as WIN frames it, flat)
const PAGE_RECT = { x: 960 - 720 * WIN.s, y: 540 + WIN.y + WIN.s * (36 - 468), w: 1440 * WIN.s, h: 900 * WIN.s }
// the hover's patch, and the button inside it at rest and lifted (measured from the captured frames)
const HOVER_SRC = { x: 700, y: 480, w: 200, h: 116 }
const BTN_REST = { x: 740, y: 506, w: 120, h: 44 }, BTN_UP = { x: 738.5, y: 503.5, w: 123, h: 45 }
const CHIP = '<div style="display:flex;align-items:center;gap:12px;padding:12px 18px;border-radius:14px;background:#1d1f2a;box-shadow:0 0 0 1px rgba(165,178,255,.5),0 18px 40px rgba(0,0,0,.5);font:600 26px/1 InterFilm,sans-serif;color:#e5e8ff;white-space:nowrap"><span style="width:20px;height:20px;border:3px solid #a5b2ff;border-radius:7px 2px 2px 2px;border-right:0;border-bottom:0"></span>radius · 8px</div>'

export const CUTS = {
  q: cut(function (H) {
    const { R, E, prog, track, lerp, rectOf } = H
    const K = kit(H)
    const X = targets(R)
    const T = 5.3
    const A = times(T, { ctaClick: 17.35, tokenField: 17.9, token: 18.45, notesTool: 19.65, noteAt: 20.05, note: [20.35, 21.45], save: 21.75, changes: 22.5, send: 23.15, collapse: 24.3, hover: 25.7 })
    const P = pointerPath(A, X, [T - 0.5, 1100, 820])
    const act = layerAct(H, A)
    const END = 37.9
    const OPEN = { x: 960, y: 540 }
    const TOK = { x: 960, y: 480 }
    const TT = 14.85 // the token beat starts: the hero group's selection leaves the page
    const LAND = A.token + 0.6 // the token chip lands on the button
    const NOTE_SRC = { x: 726, y: 466, w: 270, h: 196 }
    return {
      duration: END,
      nodes: [
        // the opening
        headline("open", "You vibe coded it.", "Now design it.", { size: 112, weight: 560, tracking: -0.042, lines: true, lineHeight: 1.1 }),
        { id: "oPlate", kind: "plate", frame: "bare", frames: ["bare"], src: { x: 0, y: 0, w: 1600, h: 1000 }, w: 1300, h: 812.5 },
        { id: "oBox", kind: "sel", line: 3, hs: 16, ls: 22 },
        ...act.nodes,
        headline("a1", "Edit the copy.", "Right on the page.", { size: 40, weight: 560, tracking: -0.022 }),
        headline("a2", "Measure it.", "Tune it with auto layout.", { size: 40, weight: 560, tracking: -0.022 }),
        // tokens
        { id: "wTok", kind: "text", text: "Tokens.", ...BIG },
        { id: "tokSub", kind: "text", text: "From your design system.", size: 46, weight: 560, tracking: -0.028, color: C.dim },
        { id: "tBox", kind: "sel", line: 3, hs: 16, ls: 22 },
        { id: "chip", kind: "html", html: CHIP },
        // the note and the send
        focusNode("focus", NOTE_SRC),
        headline("a3", "Leave a note.", "Send it to your agent.", { size: 40, weight: 560, tracking: -0.022 }),
        { id: "pin", kind: "pin", num: 3 },
        // the agent's hover, alone on black
        { id: "veil", kind: "html", html: `<div style="width:1920px;height:1080px;background:${STAGE}"></div>` },
        { id: "floor", kind: "html", html: '<div style="width:1100px;height:420px;background:radial-gradient(closest-side, rgba(255,255,255,0.10), rgba(255,255,255,0.03) 55%, transparent)"></div>' },
        hoverNode("hero", HOVER_SRC, "top"),
        AGENT_NODE,
        headline("a4", "Point at it.", "Your agent fixes it.", { size: 62, weight: 560, tracking: -0.035 }),
        // the board
        ...CANVAS_NODES,
        headline("a5", "Every page.", "One board.", { size: 64 }),
        ...endNodes(),
      ],
      render(t, S, Hs) {
        const N = S.nodes
        H.t = t
        S.glow = { op: 0.3 * prog(t, 0.2, 1.6) * (1 - prog(t, 3.4, 1.0)) + 0.14 * prog(t, A.hover + 0.3, 0.8) * (1 - prog(t, 29.65, 0.8)) + 0.4 * prog(t, 33.95, 1.4), y: t < 20 ? -340 : t < 31 ? 40 : 0, s: 1.5 }

        // ---- 1. the line, word by word; the selection draws round it and grows into the window ----
        const rO = rectOf("open", null, OPEN)
        const box0 = { x: rO.x - 52, y: rO.y - 30, w: rO.w + 104, h: rO.h + 60 }
        const grow = prog(t, 3.15, 1.2, E.io)
        const box = lerpRect(box0, PAGE_RECT, grow, lerp)
        if (t < 3.6) {
          const units = []
          for (let i = 0; i < 7; i++) {
            const at = i < 4 ? 0.4 + i * 0.11 : 1.4 + (i - 4) * 0.11
            const p = prog(t, at, 0.85)
            const q = prog(t, 2.9 + i * 0.02, 0.45, E.io)
            units.push({ op: Math.min(1, p * 1.4) * (1 - q), y: 26 * (1 - p), blur: 8 * (1 - p) + 4 * q, color: i < 4 ? C.text : C.dim })
          }
          N.open = { ...OPEN, units }
        }
        if (t >= 2.0 && t < 4.9) {
          N.oBox = { ...box, draw: prog(t, 2.05, 0.5, E.io), handles: prog(t, 2.2, 0.4, E.linear) * (1 - prog(t, 4.0, 0.5, E.linear)), label: "Text", labelOp: prog(t, 2.35, 0.3) * (1 - prog(t, 2.95, 0.25)),
            op: 1 - prog(t, 4.3, 0.45, E.io) }
        }
        // inside the box, the page: zoomed on its own hero, then out to the whole editor as the box becomes the window
        if (t >= 2.8 && t < 4.75) {
          const k0 = box0.w / 900
          const kc = Math.exp(lerp(Math.log(k0), Math.log(PAGE_RECT.w / 1600), grow))
          const cx = 800, cy = lerp(318, 500, grow)
          const sw = box.w / kc, sh = box.h / kc
          const src = { x: Math.min(1600 - sw, Math.max(0, cx - sw / 2)), y: Math.min(1000 - sh, Math.max(0, cy - sh / 2)), w: sw, h: sh }
          const r = (14 * WIN.s * grow).toFixed(1)
          N.oPlate = { x: box.x + box.w / 2, y: box.y + box.h / 2, w: box.w, h: box.h, src, op: prog(t, 2.85, 0.45, E.io), css: { borderRadius: `2px 2px ${r}px ${r}px`, boxShadow: "none" } }
        }

        // ---- the window takes over exactly where the box landed ----
        const w = { op: prog(t, 4.35, 0.3, E.linear), x: 0, y: WIN.y, s: WIN.s, rx: 0, ry: 0, rz: 0 }
        // tokens: the window falls back into the dark, then comes forward again round the button
        const away = prog(t, TT + 0.05, 0.75, E.io) * (1 - prog(t, TT + 1.7, 0.75, E.io))
        w.s *= 1 - 0.07 * away
        w.op *= 1 - away
        S.win = w
        S.cam = track(t, [
          [0, ...CAM.FULL], ...act.keys,
          key(15.6, "GROUP"), key(16.3, "CTA"), key(17.35, "CTA"), key(17.95, "PICKER"), key(18.5, "PICKER"),
          // the camera follows the token from the picker to the button
          key(19.1, "CTA"), key(19.35, "CTA"), key(19.85, "NOTE"), key(22.1, "NOTE"),
          key(22.5, "SEND"), key(22.65, "SEND"), key(23.05, "SENDBTN"), key(23.65, "SENDBTN"),
          // pull back to the window; the editor steps aside; the camera pushes in as the agent's pointer arrives
          key(24.25, "FULL"), key(24.85, "FULL"), key(A.hover, "APPCTA"), key(30.45, "APPCTA"), key(31.1, "FULL"),
        ])
        let blur = 5 * away
        if (t >= 4.3) session(t, S, A, P, H)
        if (t >= 4.3) act.render(t, S, N, Hs)
        // the button keeps its old corners until the token reaches it
        if (t >= A.token && t < LAND + 0.25) {
          const p = prog(t, LAND - 0.05, 0.25, E.linear)
          S.frames = p > 0 ? { "token-picker": 1, "token-set": p } : { "token-picker": 1 }
        }
        showHeadline(N, H, "a1", T + 0.8, T + 3.8, { y: 1010 })
        showHeadline(N, H, "a2", T + 4.7, T + 9.0, { y: 1010 })

        // ---- 2. tokens: the group's selection leaves the page for the word, then shrinks onto the button ----
        const screenRect = (r) => {
          const a = Hs.toScreen(S, r.x, r.y), b = Hs.toScreen(S, r.x + r.w, r.y + r.h)
          return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }
        }
        const rT = rectOf("wTok", null, TOK)
        const wordBox = { x: rT.x - 34, y: rT.y - 14, w: rT.w + 68, h: rT.h + 28 }
        if (t >= TT && t < A.ctaClick + 0.4) {
          const off = prog(t, TT + 0.05, 0.85, E.io)
          const on = prog(t, TT + 1.75, A.ctaClick - TT - 1.75, E.io)
          let r = lerpRect(screenRect(R.groupAfter), wordBox, off, lerp)
          if (on > 0) r = lerpRect(wordBox, screenRect(R.ctaNow), on, lerp)
          N.tBox = { ...r, draw: 1, handles: 1, radius: 2, dots: prog(t, TT + 0.95, 0.4) * (1 - prog(t, TT + 1.65, 0.3)), op: prog(t, TT, 0.18, E.linear) * (1 - prog(t, A.ctaClick, 0.25, E.io)) }
        }
        if (t >= TT + 0.5 && t < TT + 2.4) N.wTok = { ...TOK, units: K.exit(K.mask(t, TT + 0.55, 1), t, TT + 1.5, { mode: "mask" }) }
        if (t >= TT + 0.6 && t < TT + 2.3) N.tokSub = { x: 960, y: wordBox.y + wordBox.h + 64, units: K.exit(K.rise(t, TT + 0.65, 4, { st: 0.06, dist: 16, blur: 8 }), t, TT + 1.4, { st: 0.02, dout: 0.4 }) }
        if (away > 0.001) blur = Math.max(blur, 5 * away)
        // the token leaves the picker and lands on the button, its corners rounding as it arrives
        if (t >= A.token && t < LAND + 0.3) {
          const p = prog(t, A.token + 0.05, LAND - A.token - 0.05, E.io)
          const a = Hs.toScreen(S, X.tokenRow.x + 30, X.tokenRow.y), b = Hs.toScreen(S, X.cta.x, X.cta.y)
          N.chip = { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) - 120 * Math.sin(Math.PI * p), s: K.pop(prog(t, A.token, 0.3, E.linear)) * (1 - 0.35 * p), op: prog(t, A.token, 0.1, E.linear) * (1 - prog(t, LAND - 0.08, 0.2, E.io)) }
        }

        // ---- 3. the note: the page goes soft round the button and the composer ----
        const focus = prog(t, 20.15, 0.45, E.io) * (1 - prog(t, A.save + 0.05, 0.4, E.io))
        if (focus > 0.001) {
          blur = Math.max(blur, 4 * focus)
          showFocus(N, S, Hs, "focus", NOTE_SRC, Math.min(1, focus * 3), 0.28)
          if (N.focus && S.typing && S.typing.field === R.typeNote) N.focus.typing = { ...S.typing, t }
        }
        showHeadline(N, H, "a3", 19.95, 23.2, { y: 1010 })
        // the pin lands on the button, then flies to Send to agent and goes into it
        if (t >= A.save && t < A.send + 0.1) {
          const p = prog(t, A.save + 0.05, 0.5, E.linear)
          const at = Hs.toScreen(S, R.ctaNow.x + R.ctaNow.w, R.ctaNow.y)
          const home = { x: at.x + 30, y: at.y - 30 - 34 * (1 - E.out(p)) }
          const f = prog(t, 22.25, A.send - 0.1 - 22.25, E.io)
          const dest = Hs.toScreen(S, X.send.x, X.send.y)
          N.pin = { x: lerp(home.x, dest.x, f), y: lerp(home.y, dest.y, f) - 160 * Math.sin(Math.PI * f), anchor: "topleft", s: K.pop(p) * (1 - 0.55 * prog(t, A.send - 0.35, 0.3, E.io)), op: Math.min(1, p * 3) * (1 - prog(t, A.send - 0.15, 0.15, E.linear)) }
        }
        // a quick, blurred move up to the Changes tab
        const whip = Math.max(Math.sin(Math.PI * prog(t, 22.1, 0.4, E.linear)), Math.sin(Math.PI * prog(t, 18.6, 0.45, E.linear)), Math.sin(Math.PI * prog(t, 17.35, 0.6, E.linear)), Math.sin(Math.PI * prog(t, 23.7, 0.5, E.linear)))
        if (whip > 0.02) blur = Math.max(blur, 3 * whip)

        // ---- 4. the agent's hover: the button, alone on black, big and centred ----
        const hov = t - A.hover
        const lifted = prog(hov, 0, 0.9, E.io)
        const btn = lerpRect(BTN_REST, BTN_UP, lifted, lerp)
        const out = prog(t, 29.7, 0.75, E.io)
        const isoIn = prog(t, A.hover + 0.2, 0.8, E.io)
        const iso = isoIn * (1 - out)
        const veil = prog(t, A.hover + 0.05, 0.6, E.io) * (1 - prog(t, 29.9, 0.75, E.io))
        const home = { c: Hs.toScreen(S, HOVER_SRC.x + HOVER_SRC.w / 2, HOVER_SRC.y + HOVER_SRC.h / 2), k: S.cam.s * S.win.s }
        const kH = lerp(4.35, 4.7, prog(t, A.hover + 1.0, 3.2, E.soft))
        const hc = { x: lerp(home.c.x, 960, iso), y: lerp(home.c.y, 452, iso) }
        const hk = Math.exp(lerp(Math.log(home.k), Math.log(kH), iso))
        if (t >= A.hover && t < 30.55) {
          // the plate shows only the button: its lifted outline, from the capture
          const ins = 0.35
          const top = (btn.y - HOVER_SRC.y + ins) * hk, left = (btn.x - HOVER_SRC.x + ins) * hk
          const bottom = (HOVER_SRC.y + HOVER_SRC.h - btn.y - btn.h + ins) * hk, right = (HOVER_SRC.x + HOVER_SRC.w - btn.x - btn.w + ins) * hk
          const clip = `inset(${top.toFixed(2)}px ${right.toFixed(2)}px ${bottom.toFixed(2)}px ${left.toFixed(2)}px round ${(8 * hk * (btn.w / 120)).toFixed(2)}px)`
          N.hero = { ...hc, w: HOVER_SRC.w * hk, h: HOVER_SRC.h * hk, frames: hoverFrames(hov), css: { clipPath: clip, borderRadius: "0", boxShadow: "none", background: "transparent" } }
        }
        if (veil > 0.001) N.veil = { x: 960, y: 540, op: veil }
        if (iso > 0.001) N.floor = { x: hc.x, y: hc.y + 70 * (hk / kH), op: iso * (0.4 + 0.6 * lifted), s: hk / kH }
        // the agent's pointer comes in and rests on the button; it goes with the button onto the stage
        if (t >= 24.8 && t < 29.95) {
          const pt = { x: X.appCta.x + 22, y: X.appCta.y + 10 }
          const p = prog(t, 24.85, A.hover - 24.85, E.io)
          let tgt = Hs.toScreen(S, pt.x, pt.y)
          if (t >= A.hover) tgt = { x: hc.x + (pt.x - HOVER_SRC.x - HOVER_SRC.w / 2) * hk, y: hc.y + (pt.y - HOVER_SRC.y - HOVER_SRC.h / 2) * hk }
          N.agent = { x: lerp(tgt.x + 520, tgt.x, p), y: lerp(tgt.y + 260, tgt.y, p) - 60 * Math.sin(Math.PI * p), anchor: "topleft", s: 1 + 0.3 * iso, op: prog(t, 24.8, 0.25) * (1 - prog(t, 29.55, 0.35)) }
        }
        showHeadline(N, H, "a4", A.hover + 0.7, 29.45, { y: 742 })

        // ---- 5. the canvas: the button goes back into the page, the page into its frame on the board ----
        if (t >= 31.1) {
          const cs = canvasSpace(R)
          const homeC = { x: cs.fit.x + cs.fit.w / 2, y: cs.fit.y + cs.fit.h / 2 }
          const shrink = prog(t, 31.1, 0.8, E.io)
          w.s = lerp(WIN.s, (560 / 1300) * WIN.s, shrink)
          w.y = lerp(WIN.y, WIN.y * (560 / 1300), shrink)
          const zp = prog(t, 31.75, 1.85, E.io)
          const z = Math.exp(lerp(Math.log(560 / cs.fit.w), Math.log(1.5), zp))
          const fc = { x: lerp(homeC.x, 812, zp), y: lerp(homeC.y, 300, zp) }
          const swapBlur = 5 * Math.sin(Math.PI * prog(t, 31.65, 0.45, E.linear))
          if (t >= 31.65) Object.assign(N, canvasStates(R, z, fc, { x: 960, y: lerp(540, 650, zp) }, { op: prog(t, 31.7, 0.3, E.linear) * (1 - prog(t, 33.85, 0.6, E.io)), blur: swapBlur }))
          if (swapBlur > 0.05) blur = Math.max(blur, swapBlur)
          w.op *= 1 - prog(t, 31.8, 0.25, E.linear)
        }
        showHeadline(N, H, "a5", 32.1, 33.7, { y: 120 })
        // the shared session blurs the page through the editor stepping aside: keep the stronger of the two
        if (blur > 0.05) S.frameBlur = Math.max(S.frameBlur ?? 0, blur)

        endCard(N, K, H, 34.3)
        S.black = Math.max(1 - prog(t, 0, 0.5, E.linear), prog(t, END - 0.9, 0.9, E.io))
      },
    }
  }),
}
