/*
 * R · Steps: from a prompt to the app, then the steps one word at a time. It
 * opens on a coding agent's prompt field: a request types in, Enter, and the
 * field grows into the window with the app in it ("You vibe coded it. Now
 * fine-tune it."); the editor's panels slide in round the app. Act one is
 * round 5's M (the subtitle lifts while it is rewritten, the hero group while
 * its gap opens). Then O's big step words on the left, the window on the
 * right, each step with a close-up and its own camera move: a slow dolly into
 * the token picker, a crane down to the note, a whip up to Send, a slow push
 * into the button while the agent's hover plays full frame, a pull back to the
 * board. It ends on the landing page's end card.
 */
import {
  C, cut, times, targets, pointerPath, CAM, key, session, layerAct, actCaptions, showActCaptions, headline, showHeadline,
  WIN, BIG, showWord, AGENT_NODE, caption, showCaption, ICON, kit, around, canvasSpace, canvasStates, CANVAS_NODES, endNodes, endCard,
} from "./cuts-r6.js"

const PROMPT = "Build a landing page for my app"
const ARROW = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>'
const PILL_HTML = `<div style="position:absolute;inset:0;display:flex;align-items:center;padding:0 15px 0 38px;font:450 33px/1 InterFilm,sans-serif;letter-spacing:-0.012em;color:#fafafa;white-space:nowrap">
<span class="ph" style="position:absolute;left:38px;color:#5f6069">Ask your agent to build anything</span><span class="tx"></span><span class="cr" style="display:inline-block;width:2.5px;height:38px;margin-left:3px;border-radius:2px;background:#90a3ff"></span>
<span style="flex:1"></span><span class="go" style="width:60px;height:60px;border-radius:50%;display:grid;place-items:center;background:#2a2b31;color:#77787f">${ARROW}</span></div>`
const CHIP_HTML = '<div style="display:flex;align-items:center;gap:12px;padding:12px 20px;border-radius:14px;background:#1d1f2a;box-shadow:0 0 0 1px rgba(165,178,255,.5),0 18px 40px rgba(0,0,0,.5);font:600 26px/1 InterFilm,sans-serif;color:#e5e8ff;white-space:nowrap"><span style="width:20px;height:20px;border:3px solid #a5b2ff;border-radius:7px 2px 2px 2px;border-right:0;border-bottom:0"></span>radius · 8px</div>'

export const CUTS = {
  r: cut(function (H) {
    const { R, E, prog, track, lerp, rectOf } = H
    const K = kit(H)
    const X = targets(R)
    const T = 5.6
    const A = times(T, { ctaClick: 15.9, tokenField: 16.6, token: 17.7, notesTool: 19.2, noteAt: 19.7, note: [20.05, 21.35], save: 21.6, changes: 22.35, send: 22.95, collapse: 24.15, hover: 25.6 })
    const P = pointerPath(A, X, [T - 0.5, 1100, 820])
    const act = layerAct(H, A)
    const END = 36.4
    // the prompt field, and the window it grows into: smaller and lower than WIN, to leave room for the line above
    const PILL = { w: 900, h: 92 }
    const W0 = { s: 0.74, y: 64 }
    // beside a step word the window sits right and smaller (O's framing); for the hover it fills the frame
    const SIDE = { x: 320, y: 0, s: 0.66 }
    const BLEED = { s: 1.36, y: -18 * 1.36 }
    // a window's page, on screen: centre and size (the page sits 18·s below the window's centre)
    const pageOf = (w) => ({ x: 960 + w.x, y: 540 + w.y + 18 * w.s, w: 1440 * w.s, h: 900 * w.s })
    const logLerp = (a, b, p) => Math.exp(lerp(Math.log(a), Math.log(b), p))
    const st = { x: 120, y: 500, anchor: "left" }
    return {
      duration: END,
      nodes: [
        { id: "pill", kind: "plate", frames: ["app"], frame: "app", src: { x: 0, y: 0, w: 1600, h: 1000 }, w: 1600, h: 1000 },
        { id: "pillUi", kind: "html", html: PILL_HTML, style: { width: `${PILL.w}px`, height: `${PILL.h}px` } },
        { id: "press", kind: "html", html: '<div style="width:140px;height:140px;border-radius:50%;background:radial-gradient(closest-side, rgba(255,255,255,0.5), rgba(121,140,255,0.2) 55%, transparent)"></div>' },
        headline("hOpen", "You vibe coded it.", "Now fine-tune it.", { size: 66 }),
        ...act.nodes,
        ...actCaptions(),
        { id: "box", kind: "sel", line: 3, hs: 16, ls: 22 },
        { id: "wTokens", kind: "text", text: "Tokens.", ...BIG },
        { id: "chip", kind: "html", html: CHIP_HTML },
        { id: "wAsk", kind: "text", text: "Ask.", ...BIG },
        { id: "pin", kind: "pin", num: 3, style: { width: "84px", height: "84px", margin: "-42px 0 0 -42px", fontSize: "38px" } },
        { id: "wSend", kind: "text", text: "Send.", ...BIG },
        AGENT_NODE,
        caption("cAgent", "**Your agent** builds it.", ICON.agent(C.agent)),
        ...CANVAS_NODES,
        { id: "wEvery", kind: "text", text: "Every page.", ...BIG, size: 128 },
        ...endNodes(),
      ],
      render(t, S, Hs) {
        const N = S.nodes
        H.t = t
        S.glow = { op: 0.3 * prog(t, 0.2, 1.2) * (1 - prog(t, 4.3, 1.0)) + 0.42 * prog(t, 32.3, 1.4), y: t < 10 ? lerp(0, -330, prog(t, 2.3, 1.2, E.io)) : 0, s: lerp(0.9, 1.5, prog(t, 2.3, 1.2, E.io)) }

        // ---- 1. the prompt: typed, sent, and grown into the window with the app in it ----
        const p0 = pageOf({ x: 0, y: W0.y, s: W0.s })
        const grow = prog(t, 2.45, 0.9, E.io)
        if (t < 3.8) {
          const rise = prog(t, 0.3, 0.9)
          const tap = Math.sin(Math.PI * prog(t, 2.2, 0.24, E.linear))
          const w = lerp(PILL.w, p0.w, grow), h = lerp(PILL.h, p0.h, grow)
          const cx = 960, cy = lerp(540 + 24 * (1 - rise), p0.y, grow)
          // the app keeps one scale while the field opens round it, so it is revealed rather than zoomed
          const k = (p0.w / 1600) * (1.06 - 0.06 * grow)
          const rt = lerp(PILL.h / 2, 0, grow), rb = lerp(PILL.h / 2, 10, grow)
          N.pill = {
            x: cx, y: cy, w, h, s: 1 - 0.012 * tap,
            src: { x: 800 - w / k / 2, y: 500 - h / k / 2, w: w / k, h: h / k },
            frames: { app: prog(t, 2.5, 0.4, E.io) },
            op: Math.min(1, rise * 1.4) * (1 - prog(t, 3.55, 0.15, E.linear)), blur: 8 * (1 - rise),
            css: { borderRadius: `${rt.toFixed(1)}px ${rt.toFixed(1)}px ${rb.toFixed(1)}px ${rb.toFixed(1)}px`, background: "#141519", boxShadow: `0 0 0 1px rgba(255,255,255,${(0.12 * (1 - grow)).toFixed(3)}), 0 30px 90px rgba(0,0,0,0.6), 0 0 80px rgba(121,140,255,${(0.16 * (1 - grow)).toFixed(3)})` },
          }
          const n = Math.floor(prog(t, 0.95, 1.1, E.linear) * PROMPT.length + 1e-6)
          const typing = n > 0 && n < PROMPT.length
          const ready = prog(t, 1.95, 0.2)
          N.pillUi = {
            x: cx, y: cy, s: 1 - 0.012 * tap, op: Math.min(1, rise * 1.4) * (1 - prog(t, 2.45, 0.25, E.linear)), blur: 8 * (1 - rise) + 6 * prog(t, 2.45, 0.25),
            sub: {
              ".tx": { text: PROMPT.slice(0, n) },
              ".ph": { css: { opacity: n > 0 ? "0" : "1" } },
              ".cr": { css: { opacity: typing || Math.floor(t * 2.4) % 2 === 0 ? "1" : "0" } },
              ".go": { css: { background: ready > 0.5 ? "#fafafa" : "#2a2b31", color: ready > 0.5 ? "#0a0a0b" : "#77787f", transform: `scale(${(1 - 0.14 * tap).toFixed(3)})` } },
            },
          }
          const fl = Math.sin(Math.PI * prog(t, 2.22, 0.45, E.linear))
          if (fl > 0.01) N.press = { x: cx + PILL.w / 2 - 45, y: cy, op: 0.85 * fl, s: 0.5 + 0.9 * prog(t, 2.22, 0.45) }
        }
        showHeadline(N, H, "hOpen", 3.15, 4.4, { y: 150 })

        // ---- the window: it takes over from the field, then grows as the editor arrives ----
        const toWin = prog(t, 4.45, 0.9, E.io)
        const side = prog(t, 15.05, 0.95, E.io) * (1 - prog(t, 23.45, 0.6, E.io))
        const bleed = prog(t, 25.75, 1.1, E.io)
        let ws = lerp(W0.s, WIN.s, toWin), wy = lerp(W0.y, WIN.y, toWin)
        ws = lerp(ws, SIDE.s, side)
        wy = lerp(wy, SIDE.y, side)
        if (bleed > 0) { ws = logLerp(WIN.s, BLEED.s, bleed); wy = lerp(WIN.y, BLEED.y, bleed) }
        const w = { op: prog(t, 3.25, 0.3, E.linear), x: lerp(0, SIDE.x, side), y: wy, s: ws, rx: 0, ry: 0, rz: 0 }
        // the note: a crane, the page tipping a little as the camera comes down to the button
        const crane = prog(t, 19.0, 0.6, E.io) * (1 - prog(t, 21.3, 0.8, E.io))
        w.rx = 5 * crane * (1 - prog(t, 19.4, 1.8, E.soft))
        S.win = w
        S.cam = track(t, [
          [0, ...CAM.FULL], ...act.keys,
          // the token: a slow dolly into the picker, then across to the button as the token lands
          key(15.95, "TOKEN"), key(16.3, "TOKEN"), [17.75, 1440, 398, 2.6, E.soft], key(18.25, "CTA"), key(18.6, "CTA"),
          // the note: up above the button, then a crane down to it while the note is typed
          [19.15, 880, 330, 2.5], [21.15, 880, 585, 2.5, E.soft], [22.0, 880, 585, 2.5],
          // the whip up to Send
          key(22.38, "SENDBTN", E.io), key(23.45, "SENDBTN"),
          // back to the whole window while the editor steps aside, then in to the button as the agent arrives
          key(24.05, "FULL"), key(24.75, "FULL"), key(25.6, "APPCTA"),
          // the hover: a slow push in on the button
          [28.6, 800, 528, 3.7, E.soft], [29.5, ...CAM.FULL],
        ])
        const whip = Math.sin(Math.PI * prog(t, 22.03, 0.36, E.linear))
        if (whip > 0.02) S.frameBlur = 4 * whip
        if (t >= 3.0) session(t, S, A, P, H)
        // the editor arrives round the app: its panels slide in as the app gives way to the editor's page
        if (t < 5.4) {
          // the panels cover the app's edges first; the page under them settles into the editor's through a brief blur
          const ed = prog(t, 4.35, 0.62, E.io), x = prog(t, 4.97, 0.3, E.io)
          S.frames = x <= 0 ? { app: 1 } : x >= 1 ? { bare: 1 } : { app: 1, bare: x }
          if (ed > 0 && x < 1) S.strips = { pl: ed, pr: ed }
          const bl = Math.sin(Math.PI * prog(t, 4.9, 0.44, E.linear))
          if (bl > 0.02) S.frameBlur = 5 * bl
        }
        if (t >= 3.0) act.render(t, S, N, Hs)
        // the lifted group overhangs the window's left edge at this framing: fade it as it lands, so it never blinks off
        if (N.lGroup) N.lGroup.op = Math.min(1, prog(t, T + 6.55, 0.85, E.io) * (1 - prog(t, T + 8.8, 0.7, E.io)) / 0.08)
        showActCaptions(N, K, H, A)

        // ---- the steps: a big word on the left, its close-up in the window ----
        showWord(N, K, H, "wTokens", 15.5, 18.45, st)
        showWord(N, K, H, "wAsk", 18.8, 22.2, st)
        showWord(N, K, H, "wSend", 22.3, 23.45, st)
        // Tokens: the word is selected with the button; the token flies from the picker and rounds its corners
        const rT = around(rectOf("wTokens", null, st), 18)
        if (t >= A.ctaClick && t < 18.5) {
          const tok = prog(t, A.token + 0.42, 0.45, E.io)
          N.box = { ...rT, radius: 2 + 30 * tok, draw: prog(t, A.ctaClick + 0.05, 0.35, E.io), handles: prog(t, A.ctaClick + 0.12, 0.35, E.linear), dots: prog(t, A.tokenField, 0.3) * (1 - prog(t, A.token + 0.9, 0.25)),
            label: tok > 0.5 ? "radius · 8px" : "Corner radius", labelOp: prog(t, A.ctaClick + 0.25, 0.3), op: 1 - prog(t, 18.2, 0.25) }
        }
        if (t >= A.token - 0.05 && t < A.token + 0.75) {
          const p = prog(t, A.token, 0.55, E.io)
          const a = Hs.toScreen(S, X.tokenRow.x + 60, X.tokenRow.y), b = { x: rT.x + rT.w - 40, y: rT.y }
          N.chip = { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) - 130 * Math.sin(Math.PI * p), s: K.pop(prog(t, A.token - 0.05, 0.3)) * (1 - 0.35 * p), op: prog(t, A.token - 0.05, 0.12) * (1 - prog(t, A.token + 0.5, 0.2)) }
        }
        // Ask: the note lands as a pin beside the word
        if (t >= A.save && t < 22.5) {
          const r = rectOf("wAsk", null, st)
          const p = prog(t, A.save + 0.05, 0.5, E.linear)
          N.pin = { x: r.x + r.w + 60, y: r.y + r.h * 0.38 - 30 * (1 - E.out(p)), s: K.pop(p), op: Math.min(1, p * 3) * (1 - prog(t, 22.2, 0.25)) }
        }

        // ---- the agent's pointer comes in and rests on the button ----
        if (t >= A.hover - 0.9 && t < 28.8) {
          const target = Hs.toScreen(S, X.appCta.x + 18, X.appCta.y + 6)
          const p = prog(t, A.hover - 0.85, 0.85, E.io)
          const zoom = S.cam.s * w.s / WIN.s
          N.agent = { x: lerp(target.x + 520, target.x, p), y: lerp(target.y + 260, target.y, p) - 60 * Math.sin(Math.PI * p), anchor: "topleft", s: 1 + 0.16 * Math.max(0, zoom - 3), op: prog(t, A.hover - 0.9, 0.25) * (1 - prog(t, 28.45, 0.3)) }
        }
        showCaption(N, K, H, "cAgent", 24.25, 25.4)

        // ---- the canvas: the page shrinks into its frame on the board, and the camera pulls back ----
        if (t >= 28.6) {
          const cs = canvasSpace(R)
          const homeC = { x: cs.fit.x + cs.fit.w / 2, y: cs.fit.y + cs.fit.h / 2 }
          const shrink = prog(t, 28.6, 1.0, E.io)
          w.s = logLerp(BLEED.s, 560 / 1440, shrink)
          w.y = -18 * w.s
          const zA = 560 / cs.fit.w
          const zp = prog(t, 29.65, 1.4, E.io)
          const z = logLerp(zA, 1.02, zp)
          const focus = { x: lerp(homeC.x, 800, zp), y: lerp(homeC.y, 262, zp) }
          const swapBlur = 5 * Math.sin(Math.PI * prog(t, 29.45, 0.45, E.linear))
          if (t >= 29.45) Object.assign(N, canvasStates(R, z, focus, { x: 960, y: lerp(540, 628, zp) }, { op: prog(t, 29.5, 0.3, E.linear) * (1 - prog(t, 31.85, 0.65, E.io)), blur: swapBlur }))
          if (swapBlur > 0.05) S.frameBlur = swapBlur
          w.op *= 1 - prog(t, 29.6, 0.25, E.linear)
        }
        if (t >= 30.45 && t < 32.5) N.wEvery = { x: 960, y: 180, units: K.exit(K.mask(t, 30.5, 2, { st: 0.08 }), t, 31.9, { mode: "mask" }) }

        endCard(N, K, H, 32.55)
        S.black = Math.max(1 - prog(t, 0, 0.5, E.linear), prog(t, END - 0.9, 0.9, E.io))
      },
    }
  }),
}
