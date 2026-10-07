/*
 * Round 4: the Get started restyle (designlayer-demos/story/capture-cta.mjs).
 * Select the hero's one button, scrub its corner radius into a pill, give it the
 * brand indigo, leave the agent a note, send. Three edits of that one session:
 *
 *   J · Color       grey to color, played for fun: the color bursts out of the button
 *   K · One shape   one Figma selection carries the film: it selects, rounds, fills, then lands as the button
 *   L · Layers      the design layer as a real layer: planes land, and each tool lifts off the page while it's used
 *
 * The agent's brief and the source change are set from the capture itself
 * (agent.json, diff.txt), so the film says what the agent really got.
 */
import { INDIGO, LILAC, kit, mixHex, around, sizeLabel, CURSOR_SVG, xf } from "./cuts.js"

const SESSION = "midday-cta"
const RADII = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]
const pad2 = (n) => String(n).padStart(2, "0")
const FRAMES = ["app", "bare", ...RADII.map((r) => `radius-${pad2(r)}`), "radius-set", "app-pill", "picker", "picker-typed", "filled", "after", "note-empty", "note-text", "note-saved", "changes", "sent"]
const NOTE_LEN = "Make every primary button match.".length
const cut = (fn) => Object.assign(fn, { session: SESSION, frames: FRAMES })
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/* ---------- the session ---------- */
function targetsCTA(R) {
  const c = (r, fx = 0.5, fy = 0.5) => ({ x: r.x + r.w * fx, y: r.y + r.h * fy })
  return {
    cta: c(R.cta, 0.55),
    radius: c(R.radiusLabel),
    fill: c(R.fillField, 0.3),
    custom: c(R.pickerCustom, 0.4),
    notes: c(R.toolNotes),
    ctaNote: c(R.cta, 0.7),
    save: { x: R.composer.x + R.composer.w - 38, y: R.composer.y + R.composer.h - 15 },
    changes: { x: 1436, y: 19 },
    send: c(R.send),
  }
}
/** Camera framings in shot px: [x, y, scale]. */
const CAM = { FULL: [800, 500, 0.9], INSP: [1100, 389, 1.44], PICK: [1086, 560, 1.4], NOTE: [860, 560, 2.0], SEND: [1120, 300, 1.5], CLOSE: [800, 508, 2.4] }
const key = (t, name, e) => [t, ...CAM[name], e]
const scrubValue = (t, A, H) => 22 * H.prog(t, A.scrub[0], A.scrub[1] - A.scrub[0], H.E.io)
/** A scrub as a flipbook: the two captured steps either side of the value, crossfaded. */
function scrubFrames(frames, v) {
  const i = Math.min(10, Math.floor(v / 2)), f = v / 2 - i
  frames[`radius-${pad2(2 * i)}`] = 1
  if (f > 0.001) frames[`radius-${pad2(2 * i + 2)}`] = f
}
/** The real session on the window: frames on the action times in A, typing, and the pointer. */
function sessionCTA(t, S, A, P, H, label) {
  const { prog, E, path, R } = H
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
    const seq = [
      ["radius-00", A.select, 0.16], ["SCRUB", A.scrub[0], A.scrub[1] - A.scrub[0]], ["radius-set", A.scrub[1] + 0.1, 0.14],
      ["picker", A.fill, 0.16], ["picker-typed", A.custom, 0.1], ["filled", A.enter, 0.3],
      ["note-empty", A.noteAt, 0.2], ["note-text", A.note[0], 0.06], ["note-saved", A.save, 0.24],
      ["changes", A.changes, 0.3], ["sent", A.send, 0.26],
    ]
    let from = base, done = false
    for (const [name, at, dur] of seq) {
      if (t < at) break
      if (name === "SCRUB") {
        if (t < at + dur) {
          scrubFrames(S.frames, scrubValue(t, A, H))
          done = true
          break
        }
        from = "radius-22"
        continue
      }
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
  if (t >= A.note[0] && t < A.save + 0.05) S.typing = { field: R.typeNote, p: typed(A.note[0], A.note[1], NOTE_LEN), caret: true }
  if (P && t >= P[0][0] - 0.3 && t <= P[P.length - 1][0] + (A.pointerHold ?? 1)) {
    let at = path(t, P), press = 0, ring = null
    // the scrub: the pointer holds the radius label and moves with the value (a pixel of drag is a pixel of radius)
    if (t >= A.scrub[0] - 0.08 && t <= A.scrub[1] + 0.08) {
      const X = targetsCTA(R)
      at = { x: X.radius.x + scrubValue(t, A, H), y: X.radius.y }
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
/** The pointer's route through the session: to the button, the radius label, the picker, the note, Send. */
function pointerCTA(A, X, start) {
  return [
    start, [A.select, X.cta.x, X.cta.y], [A.select + 0.55, X.cta.x + 240, X.cta.y - 200], [A.scrub[0] - 0.12, X.radius.x, X.radius.y], [A.scrub[1] + 0.12, X.radius.x + 22, X.radius.y],
    [A.fill, X.fill.x, X.fill.y], [A.custom, X.custom.x, X.custom.y], [A.enter + 0.4, X.custom.x - 50, X.custom.y + 40],
    [A.noteTool - 0.6, 900, 860], [A.noteTool, X.notes.x, X.notes.y], [A.noteAt, X.ctaNote.x, X.ctaNote.y], [A.note[1] + 0.1, X.ctaNote.x + 60, X.ctaNote.y + 70],
    [A.save, X.save.x, X.save.y], [A.changes, X.changes.x, X.changes.y], [A.send, X.send.x, X.send.y],
  ]
}

/* ---------- the brief and the code, set as type from the capture ---------- */
function briefModel(agent) {
  const ch = agent?.result?.changes?.[0]
  const rows = []
  let n = 0
  for (const l of String(ch?.brief ?? "").split("\n")) {
    if (/^### /.test(l)) n++
    let m = /^\*\*Change:\*\* set `([^`]+)` to `([^`]+)` \(was `([^`]+)`\)/.exec(l)
    if (m) rows.push({ n, kind: "change", prop: m[1], to: m[2], was: m[3] })
    m = /^\*\*Feedback:\*\* (.*)$/.exec(l)
    if (m) rows.push({ n, kind: "note", text: m[1] })
  }
  return { request: ch?.request ?? "", rows }
}
function briefHTML(m) {
  const color = (v) => /^(rgb|#)/.test(v)
  const rows = m.rows.map((r, i) => r.kind === "note"
    ? `<div class="row note r${i}"><span class="n">${r.n}</span><span class="q">“${esc(r.text)}”</span></div>`
    : `<div class="row r${i}"><span class="n">${r.n}</span><span class="p">${esc(r.prop)}</span>${color(r.was) ? `<span class="was"><i class="sw" style="background:${r.was}"></i></span>` : `<span class="was">${esc(r.was)}</span>`}<span class="arr">→</span><span>${color(r.to) ? `<i class="sw" style="background:${r.to}"></i>` : ""}${esc(r.to)}</span></div>`).join("")
  return `<div class="hd"><span class="dots"><i></i><i></i><i></i></span><b>Your coding agent</b><span>· designlayer MCP</span></div><div class="body"><div class="req">› ${esc(m.request)}</div>${rows}</div>`
}
/** The brief's lines arrive one by one from `at`. */
function briefSub(t, at, n, H) {
  const sub = {}
  const show = (sel, a) => {
    const p = H.prog(t, a, 0.5)
    sub[sel] = { css: { opacity: String(Math.round(p * 1000) / 1000), transform: `translateY(${((1 - p) * 14).toFixed(1)}px)` } }
  }
  show(".req", at)
  for (let i = 0; i < n; i++) show(`.r${i}`, at + 0.35 + i * 0.45)
  return sub
}
/** The source change: the line the editor wrote into startpage.tsx, typed in, with the lines around it. */
/**
 * The source change: the line the editor wrote, and, for each class in it, the
 * inspector property it came from, with the value from the brief, so the code
 * reads as the edit the viewer just watched.
 */
function codeModel(diffText, brief) {
  const added = (String(diffText).split("\n").find((l) => l.startsWith("+") && !l.startsWith("+++")) ?? "+className=\"\">").slice(1).trim()
  const hex = (v) => {
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(v)
    return m ? "#" + m.slice(1).map((n) => Number(n).toString(16).padStart(2, "0")).join("").toUpperCase() : v
  }
  const row = (prop) => brief?.rows?.find((r) => r.kind === "change" && r.prop === prop)
  const radius = row("border-radius"), fill = row("background-color")
  return {
    added: `  ${added}`,
    labels: {
      radius: radius ? `Corner radius · ${radius.to}` : "Corner radius",
      fill: fill ? `<i class="sw" style="background:${fill.to}"></i>Fill · ${hex(fill.to)}` : "Fill",
    },
  }
}
const CODE_HTML = `<div class="hd">src/components/startpage.tsx<span class="tag">Written by Design Layer</span></div><div class="src">`
  + `<div class="ln"><span class="g"></span><span class="t"><span class="k">&lt;a</span></span></div>`
  + `<div class="ln"><span class="g"></span><span class="t">  <span class="a">href</span>=<span class="s">"https://github.com/phil8-li/design-layer#use"</span></span></div>`
  + `<div class="ln"><span class="g"></span><span class="t">  <span class="a">onClick</span>={…}</span></div>`
  + `<div class="ln add"><span class="bg"></span><span class="g">+</span><span class="t typed"></span></div>`
  + `<div class="ln"><span class="g"></span><span class="t">  <span class="k">&lt;span</span>&gt;Get started<span class="k">&lt;/span&gt;</span></span></div>`
  + `<div class="ln"><span class="g"></span><span class="t"><span class="k">&lt;/a&gt;</span></span></div></div>`
/**
 * The typed line at time t: syntax-colored, a caret while typing, and each class
 * flashing as it completes. Returns the HTML and when each class was done.
 */
function codeTyped(model, t, at, cps = 30) {
  const s = model.added
  const n = Math.max(0, Math.min(s.length, Math.floor((t - at) * cps)))
  const iName = s.indexOf("className"), iStr = s.indexOf('"'), iEnd = s.lastIndexOf('"')
  const r0 = s.indexOf("rounded-"), r1 = s.indexOf(" ", r0) > 0 ? s.indexOf(" ", r0) : iEnd
  const b0 = s.indexOf("bg-"), b1 = iEnd
  const doneAt = (i) => at + i / cps
  const tokens = [[r0, r1, doneAt(r1)], [b0, b1, doneAt(b1)]]
  const labels = [model.labels?.radius, model.labels?.fill]
  let html = ""
  for (let i = 0; i < n; i++) {
    const ti = tokens.findIndex(([a, b]) => i >= a && i < b)
    const tok = tokens[ti]
    if (tok && i === tok[0]) html += `<span class="tk">`
    const ch = esc(s[i])
    const cls = i >= iName && i < iName + 9 ? "a" : i >= iStr && i <= iEnd ? "s" : ""
    const flash = tok ? Math.max(0, 1 - Math.abs(t - tok[2] - 0.15) / 0.45) : 0
    html += `<span class="${cls} tok"${flash > 0.01 ? ` style="background:rgba(48,209,88,${(0.32 * flash).toFixed(2)})"` : ""}>${ch}</span>`
    // a class, once typed, gets a label under it: the property it came from
    if (tok && (i === tok[1] - 1 || i === n - 1)) {
      const a = Math.min(1, Math.max(0, (t - tok[2] - 0.1) / 0.35))
      const e = 1 - Math.pow(1 - a, 3)
      if (labels[ti] && a > 0) html += `<em class="ann" style="opacity:${e.toFixed(3)};transform:translateY(${(10 * (1 - e)).toFixed(1)}px)">${labels[ti]}</em>`
      html += `</span>`
    }
  }
  const typing = n < s.length && t >= at
  html += `<span class="cur" style="opacity:${typing || (t >= at - 0.4 && Math.floor(t * 2.4) % 2 === 0 && n < s.length) ? 1 : 0}"></span>`
  return { html, radiusDone: tokens[0][2], fillDone: tokens[1][2], end: doneAt(s.length) }
}
/** The real button, cropped out of the app frames (before, pill, indigo), on its own card. */
function previewSpecs(R) {
  const src = { x: R.appCta.x - 90, y: R.appCta.y - 44, w: R.appCta.w + 180, h: R.appCta.h + 88 }
  const w = 520, h = (w * src.h) / src.w
  return ["app", "app-pill", "after"].map((frame, i) => ({ id: `pv${i}`, kind: "plate", cls: "preview", frame, src, w, h }))
}
/** The code beat: the card types the line; the button beside it changes as each class lands. */
function codeBeat(t, N, H, model, { at, out, codeX = 150, codeY = 400, pvX = 1450, pvY = 545 }) {
  const { prog, E } = H
  if (t < at - 0.1 || t > out + 0.7) return
  const inP = prog(t, at, 0.7), outP = prog(t, out, 0.55, E.io)
  const ty = codeTyped(model, t, at + 0.75)
  // the added line opens up underneath to make room for the labels as the first class lands
  const room = 44 * prog(t, ty.radiusDone, 0.35, E.io)
  N.code = { x: codeX + 24 * (1 - inP), y: codeY, anchor: "topleft", op: inP * (1 - outP), sub: { ".typed": { html: ty.html }, ".add .bg": { css: { transform: `scaleX(${prog(t, at + 0.55, 0.4, E.io).toFixed(3)})` } }, ".ln.add": { css: { paddingBottom: `${room.toFixed(1)}px` } } } }
  const pIn = prog(t, at + 0.25, 0.7)
  const rise = 30 * (1 - pIn)
  N.pv0 = { x: pvX, y: pvY + rise, op: pIn * (1 - outP) }
  N.pv1 = { x: pvX, y: pvY + rise, op: prog(t, ty.radiusDone + 0.05, 0.3, E.linear) * (1 - outP) }
  N.pv2 = { x: pvX, y: pvY + rise, op: prog(t, ty.fillDone + 0.05, 0.3, E.linear) * (1 - outP), s: 1 + 0.035 * Math.sin(Math.PI * prog(t, ty.fillDone + 0.05, 0.4, E.linear)) }
}
const BIG = { size: 150, weight: 720, tracking: -0.05, mask: true }
const CAP = { size: 52, weight: 640, tracking: -0.03 }
const logo = (t, S, at, H) => { if (t >= at - 0.2) S.logo = { icon: H.prog(t, at, 1.0), mark: H.prog(t, at + 0.3, 1.0), sub: H.prog(t, at + 1.0, 0.9), url: H.prog(t, at + 1.4, 0.9) } }

export const CUTS = {
  /* =================================================================
     J · Color: grey to color, played for fun
     ================================================================= */
  j: cut(function (H) {
    const { R, E, FIT, prog, track, lerp } = H
    const K = kit(H)
    const X = targetsCTA(R)
    const A = { open: 6.4, openDur: 0.8, select: 7.8, scrub: [9.0, 10.2], fill: 11.0, custom: 11.7, type: [11.9, 12.7], enter: 13.1, noteTool: 16.6, noteAt: 17.1, note: [17.5, 19.1], save: 19.5, changes: 20.1, send: 20.7 }
    A.clicks = [A.select, A.fill, A.custom, A.noteTool, A.noteAt, A.save, A.changes, A.send]
    A.pointerHold = 0.6
    const P = pointerCTA(A, X, [7.2, 1100, 820])
    const END = 36.5
    const THIN = { weight: 330, tracking: -0.04 }
    const brief = briefModel(H.agent), code = codeModel(H.diffText, brief)
    const GRID = Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, kind: "html", cls: "gbtn", html: "<i></i>" }))
    return {
      duration: END,
      nodes: [
        { id: "works", kind: "text", text: "It works.", size: 132, ...THIN, split: "char" },
        { id: "looks", kind: "text", text: "It looks…", size: 84, ...THIN },
        { id: "fine", kind: "text", text: "fine.", size: 84, ...THIN, color: "#8e8e93" },
        { id: "needs", kind: "text", text: "It just needs a", size: 80, ...THIN },
        { id: "layer", kind: "text", text: "design layer.", size: 112, weight: 720, tracking: -0.05, split: "char", color: "#8e8e93" },
        { id: "rbox", kind: "sel", line: 3, hs: 16, ls: 22 },
        { id: "rounder", kind: "text", text: "Rounder.", ...BIG },
        { id: "bolder", kind: "text", text: "Brighter.", ...BIG },
        { id: "hex", kind: "text", text: INDIGO, size: 96, weight: 500, tracking: -0.02, font: "mono", split: "char" },
        { id: "npill", kind: "sel", line: 0, hs: 0, ls: 20 },
        { id: "nice", kind: "text", lines: ["Now that's", "a button."], size: 112, weight: 720, tracking: -0.05, lineHeight: 1.04, align: "left" },
        { id: "tell", kind: "text", text: "Then tell your agent:", size: 48, weight: 600, tracking: -0.03, color: "#8e8e93" },
        { id: "quote", kind: "text", lines: ["“Make every primary", "button match.”"], size: 64, weight: 680, tracking: -0.035, lineHeight: 1.1, align: "left", split: "char" },
        { id: "send", kind: "text", text: "Send.", ...BIG },
        { id: "gotit", kind: "text", text: "Your agent gets the whole brief.", ...CAP },
        { id: "brief", kind: "html", cls: "brief", html: briefHTML(brief), parent: "top" },
        ...GRID,
        { id: "every", kind: "text", text: "And every primary button follows.", ...CAP },
        { id: "codeCap", kind: "text", text: "It's already in your code.", ...CAP },
        { id: "code", kind: "html", cls: "codecard", html: CODE_HTML },
        ...previewSpecs(R),
      ],
      render(t, S, Hs) {
        const N = S.nodes
        // ---- the window: grey, floating; it settles on the right to make room for the words ----
        const settle = prog(t, 5.9, 1.3, E.io)
        const drift = Math.min(t, 6) / 6
        let w = { op: prog(t, 0.2, 1.2), x: lerp(360, 320, settle), y: lerp(20, 0, settle), s: lerp(0.6, 0.66, settle), rx: lerp(13 - 3 * drift, 0, settle), ry: lerp(-20 + 5 * drift, 0, settle), rz: lerp(2, 0, settle) }
        const lift = prog(t, A.enter + 0.1, 1.0, E.io) * (1 - prog(t, 16.0, 0.8, E.io))
        w.y -= 26 * lift
        w.s += 0.02 * lift
        const turn = prog(t, 20.85, 1.0, E.io)
        if (t >= 20.85) w = { op: 1 - prog(t, 24.1, 0.6, E.io), x: lerp(320, -300, turn), y: 0, s: lerp(0.66, 0.6, turn), rx: 6 * turn, ry: 18 * turn, rz: 0 }
        S.win = w
        S.cam = track(t, [
          [0, ...CAM.FULL], key(7.95, "FULL"), key(8.8, "INSP"), key(10.4, "INSP"), key(11.0, "PICK"), key(13.3, "PICK"), key(14.3, "FULL"),
          key(16.3, "FULL"), key(16.95, "NOTE"), key(19.7, "NOTE"), key(20.15, "SEND"), key(20.9, "SEND"), key(21.7, "FULL"),
        ])
        sessionCTA(t, S, A, P, H)
        // grey until the button gets its color; then the color washes out from the button
        const wave = prog(t, A.enter + 0.05, 1.5, E.io)
        if (wave < 1) S.mono = { x: X.cta.x, y: X.cta.y, r: 2600 * wave }
        S.glow = { op: 0.14 * prog(t, 4.6, 1.2) + 0.55 * prog(t, A.enter, 1.4, E.io) * (1 - prog(t, 23.9, 0.8)) + 0.45 * prog(t, 31.1, 1.2), s: 1 + 0.25 * prog(t, A.enter, 2), x: 160 * prog(t, A.enter, 1) * (1 - prog(t, 21, 1.2, E.io)) }

        // ---- "It works. It looks… fine." — a beat before "fine." lands, and it lands flat ----
        if (t < 3.8) {
          N.works = { x: 130, y: 430, anchor: "left", units: K.exit(K.rise(t, 0.5, 9, { st: 0.035, din: 0.9, dist: 18 }), t, 3.3, { st: 0.01 }) }
          N.looks = { x: 134, y: 570, anchor: "left", units: K.exit(K.rise(t, 1.6, 2, { st: 0.12, dist: 18 }), t, 3.3) }
          const lp = prog(t, 2.55, 0.5, E.linear)
          // falls in and settles with one small bounce: deadpan
          const bounce = lp <= 0 ? -60 : -60 * (1 - lp) * (1 - lp) + 9 * Math.sin(Math.PI * Math.min(1, lp * 1.6)) * (1 - lp)
          const rl = H.rectOf("looks", null, { x: 134, y: 570, anchor: "left" })
          if (t >= 2.5) N.fine = { x: rl.x + rl.w + 22, y: 570, anchor: "left", units: K.exit([{ op: Math.min(1, lp * 3), y: bounce }], t, 3.3) }
        }
        // ---- "It just needs a design layer." — the first color in the film ----
        if (t >= 3.7 && t < 6.2) {
          N.needs = { x: 134, y: 430, anchor: "left", units: K.exit(K.rise(t, 3.8, 4, { st: 0.07, dist: 18 }), t, 5.7) }
          let us = Array.from({ length: 13 }, (_, i) => {
            const p = prog(t, 4.15 + i * 0.03, 0.55, E.linear)
            // each letter springs up and overshoots once
            const y = p <= 0 ? 40 : 40 * (1 - E.out(p)) - 10 * Math.sin(Math.PI * Math.min(1, p * 1.4)) * (1 - p)
            return { op: Math.min(1, p * 2.5), y }
          })
          us = us.map((u, i) => (t >= 4.7 + i * 0.045 ? { ...u, color: mixHex("#8e8e93", LILAC, prog(t, 4.7 + i * 0.045, 0.4)) } : u))
          N.layer = { x: 128, y: 550, anchor: "left", units: K.exit(us, t, 5.7, { st: 0.01 }) }
        }

        // ---- "Rounder." — its box rounds as the button does ----
        const stR = { x: 120, y: 470, anchor: "left" }
        if (t >= 8.4 && t < 10.9) {
          N.rounder = { ...stR, units: K.exit(K.mask(t, 8.5, 1), t, 10.45, { mode: "mask" }) }
          const r = around(H.rectOf("rounder", null, stR), 18)
          const v = scrubValue(t, A, H)
          N.rbox = { ...r, radius: 2 + (r.h / 2 - 2) * (v / 22), draw: prog(t, 8.55, 0.3, E.io), handles: prog(t, 8.65, 0.35, E.linear), dots: prog(t, 8.8, 0.3) * (1 - prog(t, 10.3, 0.2)), label: `Radius ${Math.round(v)}`, labelOp: prog(t, 8.9, 0.3), op: 1 - prog(t, 10.4, 0.25, E.io) }
        }
        // ---- "Bolder." — the value types in big, and both turn indigo on Enter ----
        const stB = { x: 120, y: 420, anchor: "left" }, stHex = { x: 126, y: 580, anchor: "left" }
        if (t >= 10.9 && t < 14.0) {
          N.bolder = { ...stB, units: K.exit(K.tint(K.mask(t, 11.0, 1), t, A.enter, LILAC), t, 13.55, { mode: "mask" }) }
          const n = Math.floor(prog(t, A.type[0], A.type[1] - A.type[0], E.linear) * 7 + 1e-6)
          const hx = Array.from({ length: 7 }, (_, i) => ({ op: i < n ? 1 : 0, color: t >= A.enter ? mixHex("#f5f5f7", LILAC, prog(t, A.enter, 0.3)) : undefined }))
          if (t >= A.custom) N.hex = { ...stHex, units: K.exit(hx, t, 13.55, { st: 0.02 }) }
        }
        // ---- "Now that's a button." ----
        if (t >= 13.9 && t < 16.4) {
          const stN = { x: 120, y: 480, anchor: "left" }
          const us = K.exit(K.mask(t, 14.0, 4, { st: 0.09 }), t, 15.85, { mode: "mask" })
          N.nice = { ...stN, units: us }
          // "button." gets to be one: an indigo pill springs up behind it
          const b = H.rectOf("nice", 3, stN), pp = prog(t, 14.45, 0.55, E.linear)
          const g = K.pop(pp) * (1 - prog(t, 15.8, 0.3, E.io))
          if (g > 0.001) {
            const pw = (b.w + 44) * g, ph = (b.h + 6) * g
            N.npill = { x: b.x + b.w / 2 - pw / 2 - 2, y: b.y + b.h / 2 - ph / 2 + 4, w: pw, h: ph, radius: ph / 2, draw: 1, handles: 0, fill: INDIGO, fillP: 1, lineColor: "rgba(0,0,0,0)" }
          }
        }
        // ---- the note, set big as it's typed ----
        if (t >= 16.9 && t < 20.2) {
          N.tell = { x: 124, y: 360, anchor: "left", units: K.exit(K.rise(t, 17.0, 4, { st: 0.06, dist: 16 }), t, 19.75) }
          const nq = Math.floor(prog(t, A.note[0], A.note[1] - A.note[0], E.linear) * NOTE_LEN + 1e-6)
          // units: “ + "Make every primary" (note chars 0–17) | line break for the space (18) | "button match." (19–31) + ”
          // the quote marks come first and last; the letters arrive with the typing
          const us = Array.from({ length: NOTE_LEN + 1 }, (_, i) => ({ op: i === 0 ? prog(t, 17.3, 0.2) : i === NOTE_LEN ? (nq >= NOTE_LEN ? 1 : 0) : (i <= 18 ? i - 1 : i) < nq ? 1 : 0 }))
          N.quote = { x: 120, y: 500, anchor: "left", units: K.exit(us, t, 19.75, { st: 0.004 }) }
        }
        // ---- "Send." ----
        const stS = { x: 120, y: 470, anchor: "left" }
        if (t >= 20.0 && t < 21.6) N.send = { ...stS, units: K.exit(K.mask(t, 20.1, 1), t, 21.05, { mode: "mask" }) }
        // ---- the brief: what the agent really got ----
        // it arrives once the window has turned out of its way, so the two never overlap
        const bIn = prog(t, 21.7, 0.8), bOut = prog(t, 24.4, 0.5, E.io)
        if (t >= 21.65 && t < 25.0) N.brief = { x: 930 + 160 * (1 - bIn), y: 250, anchor: "topleft", op: bIn * (1 - bOut), sub: briefSub(t, 22.0, brief.rows.length, H) }
        if (t >= 21.6 && t < 24.9) N.gotit = { x: 960, y: 1000, units: K.exit(K.rise(t, 21.7, 6, { st: 0.05, dist: 22 }), t, 24.3) }
        // ---- "every primary button": the note's request, as a diagram ----
        if (t >= 24.5 && t < 27.1) {
          for (let i = 0; i < 12; i++) {
            const c = i % 4, r = Math.floor(i / 4)
            const a = 24.65 + (c + r) * 0.06
            const flip = prog(t, 25.4 + (c + r) * 0.09, 0.35, E.io)
            const pop = prog(t, 25.4 + (c + r) * 0.09, 0.5, E.linear)
            N[`g${i}`] = {
              x: 960 + (c - 1.5) * 200, y: 470 + (r - 1) * 96, s: Math.min(1, prog(t, a, 0.5)) * (1 + 0.08 * Math.sin(Math.PI * pop)), op: prog(t, a, 0.35) * (1 - prog(t, 26.5, 0.45, E.io)),
              css: { borderRadius: `${(6 + 20 * flip).toFixed(1)}px`, background: mixHex("#2c2c30", INDIGO, flip) },
            }
          }
          N.every = { x: 960, y: 760, units: K.exit(K.rise(t, 25.0, 5, { st: 0.05, dist: 22 }), t, 26.45) }
        }
        // ---- the code: the line the editor wrote, and the button changing beside it ----
        if (t >= 26.8 && t < 31.1) N.codeCap = { x: 960, y: 270, units: K.exit(K.rise(t, 26.9, 5, { st: 0.05, dist: 22 }), t, 30.5) }
        codeBeat(t, N, H, code, { at: 27.0, out: 30.5, codeX: 140, codeY: 380, pvX: 1480, pvY: 560 })
        logo(t, S, 31.4, H)
        S.black = Math.max(1 - prog(t, 0, 0.8, E.linear), prog(t, END - 1.0, 1.0, E.io))
      },
    }
  }),

  /* =================================================================
     K · One shape: one Figma selection carries the film
     ================================================================= */
  k: cut(function (H) {
    const { R, E, FIT, prog, track, lerp, clamp, rectOf } = H
    const K = kit(H)
    const X = targetsCTA(R)
    const A = { open: 4.3, openDur: 0.8, select: 6.2, scrub: [7.6, 8.8], fill: 9.6, custom: 10.3, type: [10.5, 11.3], enter: 11.7, noteTool: 13.6, noteAt: 14.1, note: [14.5, 16.0], save: 16.4, changes: 17.0, send: 17.6 }
    A.clicks = [A.select, A.fill, A.custom, A.noteTool, A.noteAt, A.save, A.changes, A.send]
    A.pointerHold = 0.6
    const P = pointerCTA(A, X, [5.7, 1100, 820])
    const END = 32.1
    const WORD = { size: 168, weight: 720, tracking: -0.05 }
    const FIN = { size: 200, weight: 740, tracking: -0.055, mask: true, split: "none" }
    const brief = briefModel(H.agent), code = codeModel(H.diffText, brief)
    const winRight = { x: 320, y: 0, s: 0.66 }
    const MGC = `${CURSOR_SVG}<div class="ctag">You</div>`
    return {
      duration: END,
      nodes: [
        { id: "built", kind: "text", text: "You built it.", ...WORD },
        { id: "selO", kind: "sel", line: 3, hs: 16, ls: 24 },
        { id: "mgc", kind: "html", cls: "mgc", html: MGC },
        { id: "shape", kind: "sel", line: 3, hs: 16, ls: 24 },
        { id: "select", kind: "text", text: "Select", ...BIG },
        { id: "round", kind: "text", text: "Round", ...BIG },
        { id: "color", kind: "text", text: "Color", ...BIG },
        { id: "hex", kind: "text", text: INDIGO, size: 72, weight: 500, tracking: -0.02, font: "mono", split: "char" },
        { id: "comment", kind: "text", text: "Comment", ...BIG, size: 136 },
        { id: "pin", kind: "pin", num: 3, style: { width: "84px", height: "84px", margin: "-42px 0 0 -42px", fontSize: "38px" } },
        { id: "sendW", kind: "text", text: "Send", ...BIG },
        { id: "gotit", kind: "text", text: "Your agent gets the brief.", ...CAP },
        { id: "brief", kind: "html", cls: "brief", html: briefHTML(brief) },
        { id: "codeCap", kind: "text", text: "It's already in your code.", ...CAP },
        { id: "code", kind: "html", cls: "codecard", html: CODE_HTML },
        ...previewSpecs(R),
        { id: "fshape", kind: "sel", line: 4, hs: 18, ls: 26 },
        { id: "f1", kind: "text", text: "Select.", ...FIN },
        { id: "f2", kind: "text", text: "Round.", ...FIN },
        { id: "f3", kind: "text", text: "Color.", ...FIN },
        { id: "f4", kind: "text", text: "Ship.", ...FIN },
        { id: "check", kind: "check", size: 140 },
      ],
      render(t, S, Hs) {
        const N = S.nodes

        // ---- 1. "You built it." — "it." gets selected, and the camera goes through the selection into the app ----
        const stB = { x: 960, y: 500 }
        const rIt = around(rectOf("built", 2, stB), 14)
        const P0 = { x: rIt.x + rIt.w / 2, y: rIt.y + rIt.h / 2 }
        // the box takes the window's shape (1440 × 936), then the world zooms through it
        const shape = prog(t, 2.45, 0.5, E.io)
        const bh = rIt.h, bw = lerp(rIt.w, (rIt.h * 1440) / 936, shape)
        const box = { x: P0.x - bw / 2, y: P0.y - bh / 2, w: bw, h: bh }
        const Zmax = (1440 * 0.84) / ((rIt.h * 1440) / 936)
        const zp = prog(t, 2.7, 1.35, E.io)
        const Z = Math.exp(Math.log(Zmax) * zp)
        const C = { x: lerp(P0.x, 960, zp), y: lerp(P0.y, 540, zp) }
        const toS = (p) => ({ x: C.x + (p.x - P0.x) * Z, y: C.y + (p.y - P0.y) * Z })
        if (t < 3.6) {
          const us = K.mask(t, 0.35, 3, { st: 0.14, din: 0.7 }).map((u, i) => ({ ...u, op: u.op * (1 - prog(t, i === 2 ? 2.55 : 2.75, i === 2 ? 0.25 : 0.35, E.io)) }))
          const c = toS(stB)
          N.built = { x: c.x, y: c.y, s: Z, units: us }
        }
        if (t >= 1.9 && t < 4.4) {
          const tl = toS({ x: box.x, y: box.y }), br = toS({ x: box.x + box.w, y: box.y + box.h })
          const r = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }
          N.selO = { ...r, draw: prog(t, 1.95, 0.3, E.io), handles: prog(t, 2.05, 0.35, E.linear), label: sizeLabel(r), labelOp: prog(t, 2.15, 0.3) * (1 - prog(t, 4.0, 0.3)), op: 1 - prog(t, 3.95, 0.4, E.io) }
        }
        // a cursor with a name tag, as in a Figma file
        if (t >= 1.0 && t < 3.0) {
          const at = H.path(t, [[1.0, 1500, 900], [1.9, rIt.x + rIt.w * 0.55, rIt.y + rIt.h * 0.55], [2.6, rIt.x + rIt.w * 0.62, rIt.y + rIt.h * 0.6]])
          const press = Math.max(0, 1 - Math.abs(t - 1.95) / 0.1)
          N.mgc = { x: at.x, y: at.y, anchor: "topleft", s: 1 - 0.1 * press, op: prog(t, 1.0, 0.3) * (1 - prog(t, 2.6, 0.3)) }
        }
        // the window: inside the selection, then the world zooms until it fills the frame; then it makes room for the words
        let w = { op: 0, x: 0, y: 0, s: 0.84 }
        if (t >= 2.45) {
          const c = toS(P0)
          w = { op: prog(t, 2.5, 0.3), x: c.x - 960, y: c.y - 540, s: (bw * Z) / 1440 }
        }
        const slide = prog(t, 4.9, 0.8, E.io)
        if (t >= 4.05) w = { op: 1, x: lerp(0, winRight.x, slide), y: 0, s: lerp(0.84, winRight.s, slide) }
        const recede = prog(t, 17.85, 0.5, E.io)
        if (t >= 17.85) w = { op: 1 - recede, x: winRight.x + 40 * recede, y: -10 * recede, s: winRight.s * (1 - 0.1 * recede) }
        S.win = w
        S.cam = track(t, [
          [0, ...CAM.FULL], key(6.45, "FULL"), key(7.2, "INSP"), key(8.95, "INSP"), key(9.55, "PICK"), key(11.85, "PICK"), key(12.7, "FULL"),
          key(13.3, "FULL"), key(13.95, "NOTE"), key(16.55, "NOTE"), key(16.95, "SEND"), key(17.8, "SEND"),
        ])
        sessionCTA(t, S, A, P, H, "You")
        if (t >= 3.9 && t < 4.9) S.keys = { keys: ["⌘", "."], y: 960, op: prog(t, 3.95, 0.25) * (1 - prog(t, 4.6, 0.25)), press: Math.max(0, 1 - Math.abs(t - A.open) / 0.12) }

        // ---- 2. one shape: it selects "Select", rounds with "Round", fills with "Color" ----
        const st = { x: 120, y: 470, anchor: "left" }
        const rectFor = (id) => around(rectOf(id, null, st), 18)
        const rS = rectFor("select"), rR = rectFor("round"), rC = rectFor("color")
        if (t >= 5.9 && t < 7.7) N.select = { ...st, units: K.exit(K.mask(t, 6.0, 1), t, 7.3, { mode: "mask" }) }
        if (t >= 7.2 && t < 9.4) N.round = { ...st, units: K.exit(K.mask(t, 7.35, 1), t, 9.0, { mode: "mask" }) }
        if (t >= 8.9 && t < 12.4) N.color = { ...st, units: K.exit(K.mask(t, 9.1, 1), t, 11.85, { mode: "mask" }) }
        const v = scrubValue(t, A, H)
        if (t >= A.select && t < 12.9) {
          const toR = prog(t, 7.3, 0.35, E.io), toC = prog(t, 8.95, 0.35, E.io)
          const lerpR = (a, b, p) => ({ x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), w: lerp(a.w, b.w, p), h: lerp(a.h, b.h, p) })
          let r = lerpR(lerpR(rS, rR, toR), rC, toC)
          let radius = 2 + (r.h / 2 - 2) * (v / 22)
          // the fill floods in with the typing, and is whole on Enter
          const typedP = Math.floor(prog(t, A.type[0], A.type[1] - A.type[0], E.linear) * 7 + 1e-6) / 7
          let fillP = t < A.type[0] ? 0 : t < A.enter ? 0.82 * typedP : lerp(0.82, 1, prog(t, A.enter, 0.2, E.io))
          let op = 1, handles = prog(t, A.select + 0.1, 0.35, E.linear) * (1 - prog(t, A.enter, 0.25))
          // then the shape becomes the button: it flies into Get started in the app
          const fly = prog(t, 11.95, 0.85, E.io)
          if (t >= 11.95) {
            const tl = Hs.toScreen(S, R.cta.x, R.cta.y), br = Hs.toScreen(S, R.cta.x + R.cta.w, R.cta.y + R.cta.h)
            r = lerpR(r, { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }, fly)
            radius = r.h / 2
            op = 1 - prog(t, 12.65, 0.2, E.linear)
          }
          const label = t < 7.3 ? "anything" : t < 9.0 ? `Radius ${Math.round(v)}` : ""
          const labelOp = t < 7.3 ? prog(t, A.select + 0.25, 0.3) * (1 - prog(t, 7.1, 0.2)) : t < 9.0 ? prog(t, 7.5, 0.25) * (1 - prog(t, 8.85, 0.15)) : 0
          N.shape = { ...r, radius, draw: prog(t, A.select + 0.05, 0.32, E.io), handles, dots: prog(t, 7.45, 0.3) * (1 - prog(t, 8.95, 0.2)), fill: INDIGO, fillP, lineColor: mixHex(LILAC, INDIGO, prog(t, A.enter, 0.2)), label, labelOp, op }
          // the word inside fades as the shape flies off
          if (N.color && t >= 11.95) N.color.op = 1 - prog(t, 11.95, 0.25)
        }
        if (t >= A.custom && t < 12.4) {
          const n = Math.floor(prog(t, A.type[0], A.type[1] - A.type[0], E.linear) * 7 + 1e-6)
          N.hex = { x: 124, y: 640, anchor: "left", units: K.exit(Array.from({ length: 7 }, (_, i) => ({ op: i < n ? 1 : 0, color: t >= A.enter ? mixHex("#f5f5f7", LILAC, prog(t, A.enter, 0.3)) : undefined })), t, 11.9, { st: 0.02 }) }
        }

        // ---- 3. "Comment" — and the note lands as a pin ----
        if (t >= 13.3 && t < 17.0) {
          N.comment = { ...st, units: K.exit(K.mask(t, 13.4, 1), t, 16.65, { mode: "mask" }) }
          if (t >= A.save + 0.05) {
            const r = rectOf("comment", null, st)
            const p = prog(t, A.save + 0.05, 0.5, E.linear)
            N.pin = { x: r.x + r.w + 46, y: r.y + r.h * 0.38 - 30 * (1 - E.out(p)), s: K.pop(p), op: Math.min(1, p * 3) * (1 - prog(t, 16.65, 0.25)) }
          }
        }
        if (t >= 16.9 && t < 18.4) N.sendW = { ...st, units: K.exit(K.mask(t, 17.0, 1), t, 17.95, { mode: "mask" }) }
        // ---- 4. the brief, then the code ----
        const bIn = prog(t, 18.35, 0.8), bOut = prog(t, 21.2, 0.5, E.io)
        if (t >= 18.3 && t < 21.8) N.brief = { x: 960, y: 520 + 24 * (1 - bIn), op: bIn * (1 - bOut), sub: briefSub(t, 18.65, brief.rows.length, H) }
        if (t >= 18.3 && t < 21.7) N.gotit = { x: 960, y: 230, units: K.exit(K.rise(t, 18.4, 5, { st: 0.05, dist: 22 }), t, 21.1) }
        if (t >= 21.4 && t < 24.6) N.codeCap = { x: 960, y: 270, units: K.exit(K.rise(t, 21.5, 5, { st: 0.05, dist: 22 }), t, 24.0) }
        codeBeat(t, N, H, code, { at: 21.6, out: 24.0, codeX: 140, codeY: 380, pvX: 1480, pvY: 560 })

        // ---- 5. the finale: the same shape, through the four steps ----
        const words = [["f1", 24.7], ["f2", 25.3], ["f3", 25.9], ["f4", 26.5]]
        const fst = { x: 960, y: 520 }
        let fr = null
        words.forEach(([id, at], i) => {
          const next = words[i + 1]?.[1] ?? 27.2
          if (t < at - 0.05 || t >= next + 0.45) return
          N[id] = { ...fst, units: K.exit(K.mask(t, at, 1, { din: 0.4 }), t, next - 0.04, { mode: "mask", dout: 0.28 }) }
          if (t >= at - 0.05 && t < next) fr = { id, at, r: around(rectOf(id, null, fst), 22) }
        })
        if (fr && fr.id !== "f4") {
          const rr = fr.r
          const round = fr.id === "f1" ? 0 : prog(t, fr.id === "f2" ? fr.at + 0.1 : -1, 0.35, E.io)
          N.fshape = { ...rr, radius: 2 + (rr.h / 2 - 2) * round, draw: prog(t, 24.72, 0.25, E.io), handles: fr.id === "f3" ? 1 - prog(t, fr.at, 0.2) : prog(t, 24.8, 0.3, E.linear), dots: fr.id === "f2" ? prog(t, fr.at, 0.2) * (1 - prog(t, fr.at + 0.45, 0.15)) : 0, fill: INDIGO, fillP: fr.id === "f3" ? prog(t, fr.at + 0.08, 0.3, E.io) : 0, op: fr.id === "f3" ? 1 - prog(t, fr.at + 0.5, 0.1) : 1 }
        }
        if (t >= 26.45 && t < 27.6) {
          const r = rectOf("f4", null, fst)
          N.check = { x: r.x + r.w + 110, y: 520, s: K.pop(prog(t, 26.58, 0.4, E.linear)), draw: prog(t, 26.75, 0.35, E.io), op: 1 - prog(t, 27.2, 0.3) }
        }
        logo(t, S, 27.5, H)
        S.glow = { op: 0.35 * prog(t, 27.6, 1.2), s: 1.2 }
        S.black = Math.max(1 - prog(t, 0, 0.5, E.linear), prog(t, END - 1.0, 1.0, E.io))
      },
    }
  }),

  /* =================================================================
     L · Layers: planes land, and each tool lifts off the page while it's used
     ================================================================= */
  l: cut(function (H) {
    const { R, E, FIT, prog, track, lerp } = H
    const K = kit(H)
    const X = targetsCTA(R)
    // open/openDur 0: the editor is already open when the real window takes over from the planes
    const A = { open: 0, openDur: 0.01, select: 4.8, scrub: [6.8, 8.0], fill: 8.9, custom: 9.8, type: [10.0, 10.8], enter: 11.2, noteTool: 12.9, noteAt: 13.4, note: [13.8, 15.3], save: 15.7, changes: 16.3, send: 16.9 }
    A.clicks = [A.select, A.fill, A.custom, A.noteTool, A.noteAt, A.save, A.changes, A.send]
    A.pointerHold = 0.6
    const P = pointerCTA(A, X, [4.3, 1100, 820])
    const END = 30.5
    const PL = (id, frame, src, w, parent = "back") => ({ id, kind: "plate", parent, frame, src, w, h: (w * src.h) / src.w })
    const pad = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + p * 2, h: r.h + p * 2 })
    const full = { x: 0, y: 0, w: 1600, h: 1000 }
    const left = { x: 0, y: 0, w: 280, h: 1000 }, right = { x: 1320, y: 0, w: 280, h: 1000 }, bar = pad(R.toolbar, 8)
    const ctaSrc = pad(R.cta, 26), pickSrc = pad(R.picker, 6)
    const PW = 1300
    const k = PW / 1600
    const brief = briefModel(H.agent), code = codeModel(H.diffText, brief)
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
        { ...PL("pCta", "radius-00", ctaSrc, ctaSrc.w, "front"), frames: [...RADII.map((r) => `radius-${pad2(r)}`), "radius-set"] },
        { ...PL("pPick", "picker", pickSrc, pickSrc.w, "front"), frames: ["picker", "picker-typed"] },
        { id: "swatch", kind: "html", parent: "front", html: "", style: { width: "56px", height: "56px", borderRadius: "28px", background: INDIGO, boxShadow: "0 0 0 2px rgba(255,255,255,.3), 0 18px 44px rgba(74,93,249,.65)" } },
        { id: "c1", kind: "text", text: "Select anything.", ...CAP },
        { id: "c2", kind: "text", text: "Shape it like a Figma layer.", ...CAP },
        { id: "c3", kind: "text", text: "Color it.", ...CAP },
        { id: "c4", kind: "text", text: "Or leave your agent a note.", ...CAP },
        { id: "c5", kind: "text", text: "Send it.", ...CAP },
        { id: "gotit", kind: "text", text: "Your agent gets the whole brief.", ...CAP },
        { id: "brief", kind: "html", cls: "brief", html: briefHTML(brief) },
        { id: "codeCap", kind: "text", text: "It's already in your code.", ...CAP },
        { id: "code", kind: "html", cls: "codecard", html: CODE_HTML },
        ...previewSpecs(R),
      ],
      render(t, S, Hs) {
        const N = S.nodes
        const cap = (id, n, at, out, y = 1012) => { if (t >= at - 0.05 && t < out + 0.6) N[id] = { x: 960, y, units: K.exit(K.rise(t, at, n, { st: 0.06, dist: 24 }), t, out) } }

        // ---- 1. the app as a plane in space; the design layer lands on it; the stack turns to face us ----
        const face = prog(t, 2.4, 1.4, E.io)
        const rx = lerp(56, 0, face), rz = lerp(-22 + 6 * Math.min(t, 2.4) / 2.4, 0, face)
        const cz = lerp(-220 + 60 * prog(t, 0, 2.4, E.soft), 0, face)
        const px = lerp(1070, 960, face), py = lerp(600, 540, face)
        // the real window fades in over the planes, so they stay opaque (and a hair behind it) until it has
        const fade = t >= 4.25 ? 1 : 0
        if (t < 4.35) {
          N.pApp = { x: px, y: py, z: cz - 2 * face, rx, rz, op: prog(t, 0.05, 0.5) * (1 - fade) }
          const land = prog(t, 0.85, 1.05, E.io)
          const lz = lerp(560, 2, land)
          const lop = prog(t, 0.75, 0.35)
          for (const [id, src] of [["pLeft", left], ["pRight", right], ["pBar", bar]]) {
            const dx = (src.x + src.w / 2 - 800) * k, dy = (src.y + src.h / 2 - 500) * k
            N[id] = { x: px + dx, y: py + dy, z: cz + lz, rx, rz, ox: -dx, oy: -dy, op: lop * (1 - prog(t, 2.45, 0.15, E.linear)) }
          }
          // once they land the app makes room for them, as it does in the editor
          N.pBare = { x: px, y: py, z: cz + 1 - 2 * face, rx, rz, op: prog(t, 1.85, 0.4, E.linear) * (1 - fade) }
          N.tApp = { x: 130, y: 170, anchor: "left", units: K.exit(K.rise(t, 0.25, 2, { st: 0.1 }), t, 2.75) }
          if (t >= 0.95) N.tLayer = { x: 130, y: 290, anchor: "left", units: K.exit(K.rise(t, 1.05, 4, { st: 0.07, dist: -44 }), t, 2.85) }
        }

        // ---- the real editor takes over, and tilts when a piece of it lifts off ----
        const tilt = (a, b) => prog(t, a, 0.8, E.io) * (1 - prog(t, b, 0.8, E.io))
        const tl = tilt(5.0, 8.1) + tilt(9.0, 11.1)
        const w = { op: prog(t, 3.75, 0.5, E.linear), x: 0, y: -16, s: PW / 1440, rx: -6 * tl, ry: -12 * tl, rz: 0 }
        const lift = prog(t, A.enter + 0.4, 1.0, E.io) * (1 - prog(t, 16.6, 0.6, E.io))
        w.y -= 20 * lift
        // Send: the editor turns away as the agent's brief arrives
        const turn = prog(t, 17.15, 1.0, E.io)
        if (t >= 17.15) {
          w.x = -330 * turn
          w.ry = 24 * turn
          w.s = PW / 1440 - 0.2 * turn
          w.op = 1 - prog(t, 20.7, 0.6, E.io)
        }
        S.win = w
        S.cam = track(t, [
          [0, ...CAM.FULL], key(5.9, "FULL"), key(6.6, "INSP"), key(8.15, "INSP"), key(8.75, "PICK"), key(11.2, "PICK"), key(12.0, "FULL"),
          key(12.75, "FULL"), key(13.3, "NOTE"), key(15.85, "NOTE"), key(16.25, "SEND"), key(17.1, "SEND"), key(17.9, "FULL"),
        ])
        if (t >= 3.7) sessionCTA(t, S, A, P, H)
        S.glow = { op: 0.25 * prog(t, 0.9, 1.0) * (1 - prog(t, 3.8, 0.8)) + 0.45 * lift + 0.45 * prog(t, 25.8, 1.2), s: 1.2 }

        // ---- 2. the button lifts off the page as its own layer, and rounds up there ----
        if (t >= 4.9 && t < 8.7) {
          const up = prog(t, 5.0, 0.8, E.io) * (1 - prog(t, 8.1, 0.55, E.io))
          const o = Hs.onWindow(S, ctaSrc.x + ctaSrc.w / 2, ctaSrc.y + ctaSrc.h / 2, 300 * up)
          const mag = 1 + 0.55 * up
          const frames = {}
          if (t < A.scrub[0]) frames["radius-00"] = 1
          else if (t < A.scrub[1] + 0.1) scrubFrames(frames, scrubValue(t, A, H))
          else frames["radius-set"] = 1
          N.pCta = { ...o, w: ctaSrc.w * o.k * mag, h: ctaSrc.h * o.k * mag, frames, op: Math.min(1, up * 3) }
        }
        cap("c1", 2, 5.1, 6.55)
        cap("c2", 6, 6.8, 8.35)

        // ---- 3. the picker lifts; the color leaves it and lands on the button ----
        if (t >= 8.9 && t < 12.0) {
          const up = prog(t, 9.0, 0.7, E.io) * (1 - prog(t, A.enter - 0.1, 0.5, E.io))
          const lift2 = 220 * up
          const o = Hs.onWindow(S, pickSrc.x + pickSrc.w / 2, pickSrc.y + pickSrc.h / 2, lift2)
          const typing = t >= A.custom ? { field: R.typeColor, p: Math.floor(prog(t, A.type[0], A.type[1] - A.type[0], E.linear) * 7 + 1e-6) / 7, caret: true, t } : null
          N.pPick = { ...o, w: pickSrc.w * o.k, h: pickSrc.h * o.k, op: Math.min(1, up * 2.5), frame: t >= A.custom ? "picker-typed" : "picker", typing }
          if (t >= A.enter - 0.7 && t < A.enter + 0.4) {
            const p = prog(t, A.enter - 0.65, 0.65, E.io)
            const line = R.typeColor?.lines?.[0] ?? { x0: 1526, x1: 1578, y0: 768, y1: 784 }
            const a = Hs.onWindow(S, (line.x0 + line.x1) / 2, (line.y0 + line.y1) / 2, lift2 + 30)
            const b = Hs.onWindow(S, X.cta.x, X.cta.y, 0)
            N.swatch = { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) - 200 * Math.sin(Math.PI * p), z: lerp(a.z, b.z, p) + 160 * Math.sin(Math.PI * p), s: 1.1 - 0.5 * p, op: prog(t, A.enter - 0.7, 0.12) * (1 - prog(t, A.enter + 0.02, 0.22)) }
          }
        }
        cap("c3", 2, 9.2, 11.75)

        // ---- 4. the note: on the page, no layers ----
        cap("c4", 5, 13.4, 15.75)
        cap("c5", 2, 16.4, 17.6)
        // ---- 5. the brief, then the code ----
        // it arrives once the editor has turned out of its way, so the two never overlap
        const bIn = prog(t, 18.0, 0.8), bOut = prog(t, 20.8, 0.5, E.io)
        if (t >= 17.95 && t < 21.4) N.brief = { x: 940 + 160 * (1 - bIn), y: 250, anchor: "topleft", op: bIn * (1 - bOut), sub: briefSub(t, 18.3, brief.rows.length, H) }
        cap("gotit", 6, 17.9, 20.7)
        cap("codeCap", 5, 21.2, 24.7, 270)
        codeBeat(t, N, H, code, { at: 21.3, out: 24.7, codeX: 140, codeY: 380, pvX: 1480, pvY: 560 })
        logo(t, S, 25.3, H)
        S.black = Math.max(1 - prog(t, 0, 0.4, E.linear), prog(t, END - 1.0, 1.0, E.io))
      },
    }
  }),
}
