/*
 * Three ways to tell one session: select the headline, give it a new color,
 * leave a note for the agent, send both, and see the change land in the code.
 *
 *   D · One take    one unbroken camera through the editor; the camera only moves to read the next thing
 *   E · Spotlight   the camera holds still; light and numbered labels lead the eye
 *   F · Close-ups   one sentence and one magnified detail per step, each detail morphing into the next
 *
 * Shared rules: nothing moves unless it explains a change. One easing family
 * (expo-out to arrive, smooth in-out to travel), no flashes, shakes or whips,
 * and every payoff is held long enough to read.
 */

/** Crossfade between two captured frames (the later frame stacks on top). */
const xf = (S, from, to, p) => {
  if (p >= 1) S.frames[to] = 1
  else {
    S.frames[from] = 1
    if (p > 0) S.frames[to] = p
  }
}

/**
 * The session itself: which captured frame is on screen, the editor's panels
 * arriving, typing into the two fields, and the pointer with its clicks.
 * A: action times (seconds). P: pointer path [[t, x, y]] in shot px.
 */
function session(t, S, A, P, H) {
  const { prog, E, path, R } = H
  const seq = [
    ["h1", A.h1, 0.2], ["picker", A.color, 0.16], ["picker-typed", A.custom, 0.1], ["indigo", A.enter, 0.34],
    ["note-empty", A.cta, 0.22], ["note-text", A.note[0], 0.06], ["note-saved", A.save, 0.24], ["changes", A.agentUp, 0.3], ["sent", A.send, 0.26],
  ]
  // ⌘.: the panels slide in over the running app, then the frame settles on the editor
  const opened = A.open + A.openDur
  let base = "app"
  if (t >= A.open && t < opened + 0.05) {
    S.frames.app = 1
    S.strips = { pl: prog(t, A.open, A.openDur), pr: prog(t, A.open + 0.04, A.openDur) }
    // the page reflows to fit between the panels: a quick dissolve, softened so the two layouts never read as a double image
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
  // typing reveals the captured text a character at a time
  const typed = (a, b, n) => Math.floor(prog(t, a, b - a, E.linear) * n + 1e-6) / n
  if (t >= A.custom && t < A.enter + 0.05) S.typing = { field: R.typeColor, p: typed(A.type[0], A.type[1], 7), caret: true }
  if (t >= A.note[0] && t < A.save + 0.05) S.typing = { field: R.typeNote, p: typed(A.note[0], A.note[1], 38), caret: true }
  // the pointer
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

/** Points the session clicks, in shot px (from the capture's own DOM boxes). */
function targets(R) {
  const c = (r, fx = 0.5, fy = 0.5) => ({ x: r.x + r.w * fx, y: r.y + r.h * fy })
  return {
    h1: { x: R.h1.x + R.h1.w * 0.36, y: R.h1.y + R.h1.h * 0.42 },
    color: c(R.colorField, 0.3),
    custom: c(R.pickerCustom, 0.4),
    notes: c(R.toolNotes),
    cta: c(R.cta, 0.62),
    send: c(R.send),
  }
}

const caption = (text, at, out, extra = {}) => ({ text, at, out, y: 1014, size: 38, weight: 560, tracking: -0.02, ...extra })

export const CUTS = {
  /* ---------------------------------------------------------------
     D · One take
     --------------------------------------------------------------- */
  d(H) {
    const { R, E, FIT, prog, track } = H
    const X = targets(R)
    const A = {
      open: 3.0, openDur: 0.8, h1: 5.9, color: 9.1, custom: 10.3, type: [10.55, 11.3], enter: 11.75,
      notes: 15.4, cta: 16.4, note: [17.3, 19.0], save: 19.45, agentUp: 20.5, send: 22.25,
    }
    A.clicks = [A.h1, A.color, A.custom, A.notes, A.cta, A.send]
    const P = [
      [4.7, 1150, 760], [A.h1, X.h1.x, X.h1.y], [8.3, X.h1.x + 260, X.h1.y + 220], [A.color, X.color.x, X.color.y],
      [A.custom, X.custom.x, X.custom.y], [12.6, X.custom.x - 40, X.custom.y + 40], [14.6, 1020, 820], [A.notes, X.notes.x, X.notes.y],
      [A.cta, X.cta.x, X.cta.y], [20.9, X.cta.x + 300, X.cta.y - 160], [A.send, X.send.x, X.send.y],
    ]
    A.pointerHold = 1.0
    const END = 41.5
    return {
      duration: END,
      type: [
        caption("Your app, running.", 0.7, 2.5),
        caption("Open the design layer on top of it.", 3.85, 5.6),
        caption("Select anything.", 6.0, 8.0),
        caption("See its real styles.", 8.15, 9.95),
        caption("Use your tokens, or any value.", 10.1, 11.55),
        caption("Change it, and the app updates live.", 11.95, 14.4),
        caption("Or leave a note for your coding agent.", 14.65, 19.2),
        caption("Everything you changed, in one list.", 20.1, 22.0),
        caption("Send it to your agent.", 22.4, 24.6),
        caption("It gets the whole brief.", 25.1, 28.5),
        caption("And every change lands in your code.", 29.0, 33.0),
      ],
      render(t, S) {
        // the window: in from black, then it makes room for the agent, then leaves for the end card
        const win = prog(t, 0, 1.0)
        const side = prog(t, 24.0, 1.3, E.io)
        const dim = prog(t, 28.8, 0.8, E.io)
        const gone = prog(t, 33.2, 0.8, E.io)
        S.win = { op: win * (1 - 0.6 * dim) * (1 - gone), x: -330 * side, y: 14 * (1 - win), s: 0.86 - 0.24 * side }
        S.cam = track(t, [
          [0, 800, 500, FIT], [5.6, 800, 500, FIT], [6.9, 800, 330, 1.35], [7.4, 800, 330, 1.35],
          [8.7, 1180, 760, 1.6], [9.2, 1180, 760, 1.6], [9.8, 1180, 650, 1.55], [11.75, 1180, 650, 1.55],
          [13.1, 900, 470, 1.0], [14.6, 900, 470, 1.0], [15.3, 900, 560, 1.0], [16.5, 900, 560, 1.0], [17.4, 860, 500, 1.5],
          [19.6, 860, 500, 1.5], [20.8, 1000, 375, 1.2], [22.4, 1000, 375, 1.2], [23.6, 800, 500, FIT],
        ])
        session(t, S, A, P, H)
        // while the camera reads the inspector, the page beside it falls back into shadow
        const shade = prog(t, 8.5, 0.9, E.io) * (1 - prog(t, 11.9, 0.9, E.io))
        if (shade > 0) S.shade = { a: 0.78 * shade }
        if (t >= 2.5 && t < 3.9) S.keys = { keys: ["⌘", "."], op: prog(t, 2.55, 0.35) * (1 - prog(t, 3.5, 0.3)), press: t > 2.95 && t < 3.08 ? 1 : 0, y: 982 }
        // the agent's side of the handoff
        const tIn = prog(t, 24.5, 0.9)
        if (t >= 24.4) S.term = { op: tIn * (1 - 0.6 * dim) * (1 - gone), x: 1120 + 40 * (1 - tIn), y: 290, s: 0.82, chars: (t - 25.1) * 230 }
        const cIn = prog(t, 29.0, 0.9)
        if (t >= 28.9) S.code = { op: cIn * (1 - gone), x: 410, y: 600 + 30 * (1 - cIn), s: 1, del: prog(t, 29.9, 0.5, E.io), add: prog(t, 30.5, 0.5, E.io) }
        if (t >= 33.6) S.logo = { icon: prog(t, 34.0, 1.0), mark: prog(t, 34.3, 1.0), sub: prog(t, 35.1, 0.9), url: prog(t, 35.6, 0.9) }
        S.black = Math.max(1 - prog(t, 0, 0.6, E.linear), prog(t, END - 1.0, 1.0, E.io))
      },
    }
  },

  /* ---------------------------------------------------------------
     E · Spotlight
     --------------------------------------------------------------- */
  e(H) {
    const { R, E, FIT, prog, lerp } = H
    const X = targets(R)
    const A = {
      open: 4.6, openDur: 0.8, h1: 6.7, color: 10.6, custom: 12.3, type: [12.55, 13.3], enter: 13.8,
      notes: 16.1, cta: 16.9, note: [17.6, 19.3], save: 19.8, agentUp: 21.0, send: 22.3,
    }
    A.clicks = [A.h1, A.color, A.custom, A.cta, A.send]
    const P = [
      [5.8, 1150, 760], [A.h1, X.h1.x, X.h1.y], [9.6, X.h1.x + 300, X.h1.y + 360], [A.color, X.color.x, X.color.y],
      [A.custom, X.custom.x, X.custom.y], [15.0, 980, 700], [A.cta, X.cta.x, X.cta.y], [21.3, X.send.x - 120, X.send.y + 200], [A.send, X.send.x, X.send.y],
    ]
    A.pointerHold = 0.9
    const pad = (r, p = 12) => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p })
    const SPOTS = [
      { at: 6.95, rect: pad(R.selection, 14) },
      { at: 8.7, rect: { x: R.typography.x + 4, y: R.typography.y - 4, w: R.typography.w - 8, h: 1000 - R.typography.y - 36 } },
      { at: 10.75, rect: pad(R.picker, 8) },
      { at: 14.05, rect: pad(R.selection, 14) },
      { at: 17.05, rect: { x: R.composer.x - 70, y: R.cta.y - 14, w: R.composer.w + 84, h: R.composer.y + R.composer.h - R.cta.y + 28 } },
      { at: 21.1, rect: { x: R.changesList.x + 6, y: 36, w: R.changesList.w - 12, h: R.send.y + R.send.h + 16 - 36 } },
    ]
    // the light travels between steps, and the room brightens a little while it does
    const spotAt = (t) => {
      let i = SPOTS.findLastIndex((s) => t >= s.at)
      if (i < 0) return null
      const s = SPOTS[i], prev = SPOTS[i - 1]
      const p = prog(t, s.at, 0.75, E.io)
      const a = prev && i > 0 ? prev.rect : s.rect
      const moving = i > 0 ? Math.sin(Math.PI * p) : 0
      return { x: lerp(a.x, s.rect.x, p), y: lerp(a.y, s.rect.y, p), w: lerp(a.w, s.rect.w, p), h: lerp(a.h, s.rect.h, p), r: 10, lift: 0.55 * moving }
    }
    const CALL = [
      { id: "c1", num: 1, label: "Select anything", at: 7.2, out: 8.5, ax: R.selection.x + R.selection.w + 14, ay: R.selection.y + R.selection.h / 2, side: "right", len: 70 },
      { id: "c2", num: 2, label: "Its real styles, from your code", at: 8.95, out: 10.45, ax: R.typography.x, ay: R.typography.y + 120, side: "left", len: 70 },
      { id: "c3", num: 3, label: "Your app's own tokens, or any value", at: 11.0, out: 13.85, ax: R.picker.x - 8, ay: R.picker.y + 120, side: "left", len: 70 },
      { id: "c4", num: 4, label: "The app updates as you edit", at: 14.3, out: 15.9, ax: R.selection.x + R.selection.w + 14, ay: R.selection.y + R.selection.h / 2, side: "right", len: 70 },
      { id: "c5", num: 5, label: "Or leave a note for your agent", at: 17.3, out: 20.7, ax: R.composer.x + R.composer.w + 14, ay: R.composer.y + 40, side: "right", len: 60 },
      { id: "c6", num: 6, label: "Send it in one click", at: 21.35, out: 23.0, ax: R.changesList.x, ay: R.send.y + R.send.h / 2, side: "left", len: 70 },
    ]
    const END = 34.5
    return {
      duration: END,
      type: [
        { text: "Design Layer", at: 0.35, out: 2.6, y: 470, size: 26, weight: 600, tracking: -0.01, color: "#8e8e93" },
        { text: "Edit your running app like a design file.", at: 0.6, out: 2.6, y: 535, size: 64, weight: 620, tracking: -0.035 },
        { text: "It lands in your code.", at: 23.7, out: 27.4, y: 330, size: 56, weight: 620, tracking: -0.03 },
      ],
      render(t, S) {
        const win = prog(t, 3.0, 1.0)
        const dim = prog(t, 23.2, 0.8, E.io)
        const gone = prog(t, 27.6, 0.8, E.io)
        S.win = { op: win * (1 - 0.72 * dim) * (1 - gone), x: 0, y: 18 * (1 - win), s: 0.84 }
        S.cam = { x: 800, y: 500, s: FIT }
        session(t, S, A, P, H)
        if (t >= 4.0 && t < 5.5) S.keys = { keys: ["⌘", "."], op: prog(t, 4.1, 0.35) * (1 - prog(t, 5.1, 0.3)), press: t > 4.55 && t < 4.68 ? 1 : 0, y: 985 }
        const sp = spotAt(t)
        if (sp) {
          const on = prog(t, SPOTS[0].at, 0.6) * (1 - prog(t, 22.9, 0.6, E.io))
          S.spot = { ...sp, op: on * (1 - sp.lift) }
        }
        for (const c of CALL) {
          if (t < c.at || t > c.out + 0.4) continue
          S.callouts.push({ ...c, p: prog(t, c.at, 0.7, E.io), op: 1 - prog(t, c.out, 0.35, E.io) })
        }
        const cIn = prog(t, 23.8, 0.9)
        if (t >= 23.7) S.code = { op: cIn * (1 - gone), x: 410, y: 420 + 30 * (1 - cIn), s: 1, del: prog(t, 24.6, 0.5, E.io), add: prog(t, 25.2, 0.5, E.io) }
        if (t >= 28.0) S.logo = { icon: prog(t, 28.4, 1.0), mark: prog(t, 28.7, 1.0), sub: prog(t, 29.5, 0.9), url: prog(t, 30.0, 0.9) }
        S.black = Math.max(1 - prog(t, 0, 0.6, E.linear), prog(t, END - 1.0, 1.0, E.io))
      },
    }
  },

  /* ---------------------------------------------------------------
     F · Close-ups
     --------------------------------------------------------------- */
  f(H) {
    const { R, E, prog, lerp } = H
    const X = targets(R)
    const A = {
      open: 3.2, openDur: 0.8, h1: 7.0, color: 10.7, custom: 11.9, type: [12.15, 12.9], enter: 13.4,
      notes: 99, cta: 18.0, note: [18.7, 20.4], save: 20.9, agentUp: 23.3, send: 24.3,
    }
    A.clicks = [A.h1, A.color, A.custom, A.cta, A.send]
    const P = [
      [5.9, 1000, 520], [A.h1, X.h1.x, X.h1.y], [9.9, X.color.x - 60, X.color.y - 150], [A.color, X.color.x, X.color.y], [A.custom, X.custom.x, X.custom.y],
      [16.8, X.cta.x - 70, X.cta.y + 90], [A.cta, X.cta.x, X.cta.y], [23.2, X.send.x - 60, X.send.y + 70], [A.send, X.send.x, X.send.y],
    ]
    A.pointerHold = 0.9
    // close-up regions of the shot (x, y, w, h) and where the card sits on screen
    const CARD_X = 860, CARD_W = 920
    const fit = (src, maxH = 760) => {
      let w = CARD_W, h = (CARD_W * src.h) / src.w
      if (h > maxH) { h = maxH; w = (maxH * src.w) / src.h }
      return { x: CARD_X + (CARD_W - w) / 2, y: 540 - h / 2, w, h }
    }
    const SH = {
      full: { x: 0, y: 0, w: 1600, h: 1000 },
      page: { x: 330, y: 150, w: 940, h: 560 },
      picker: { x: 1300, y: 430, w: 300, h: 470 },
      composer: { x: 640, y: 440, w: 520, h: 270 },
      send: { x: 1322, y: 30, w: 278, h: 230 },
    }
    const KEYS = [
      [0.6, SH.full], [6.0, SH.full], [6.9, SH.page], [9.6, SH.page], [10.5, SH.picker], [13.6, SH.picker], [14.5, SH.page],
      [16.4, SH.page], [17.4, SH.composer], [22.2, SH.composer], [23.1, SH.send],
    ]
    const cardAt = (t) => {
      let i = KEYS.findLastIndex((k) => t >= k[0])
      if (i < 0) i = 0
      const [ta, a] = KEYS[i], next = KEYS[i + 1]
      if (!next) return { src: a, dst: fit(a) }
      const p = prog(t, ta, next[0] - ta, E.io)
      const src = { x: lerp(a.x, next[1].x, p), y: lerp(a.y, next[1].y, p), w: lerp(a.w, next[1].w, p), h: lerp(a.h, next[1].h, p) }
      const da = fit(a), db = fit(next[1])
      return { src, dst: { x: lerp(da.x, db.x, p), y: lerp(da.y, db.y, p), w: lerp(da.w, db.w, p), h: lerp(da.h, db.h, p) } }
    }
    const chapter = (num, lines, at, out) => [
      { text: num, at, out, x: 150, y: 400, size: 22, weight: 600, tracking: 0.02, color: "#8e8e93", align: "left", split: "none" },
      { lines, at: at + 0.12, out, x: 150, y: 430, anchor: "top", size: 70, weight: 640, tracking: -0.035, align: "left", lineHeight: 1.08, lineColors: [null, "#8e8e93"] },
    ]
    const END = 38.5
    return {
      duration: END,
      type: [
        ...chapter("01", ["Your app,", "with a design layer."], 0.7, 5.7),
        ...chapter("02", ["Select", "anything."], 6.4, 9.4),
        ...chapter("03", ["Change it like", "a Figma layer."], 10.0, 16.0),
        ...chapter("04", ["Or leave a note", "for your agent."], 16.6, 22.0),
        ...chapter("05", ["Send it.", "It lands in your code."], 22.7, 31.2),
      ],
      render(t, S) {
        // the session plays in one chromeless card: the card is the window, and
        // its camera shows exactly the region the card is magnifying
        const { src, dst } = cardAt(t)
        const into = prog(t, 0.5, 1.0)
        const leave = prog(t, 25.9, 0.9, E.io)
        S.win = { op: into * (1 - leave), rect: { ...dst, y: dst.y + 20 * (1 - into) }, r: 16 }
        S.cam = { x: src.x + src.w / 2, y: src.y + src.h / 2, s: dst.w / src.w }
        session(t, S, A, P, H)
        // the agent and the code, in the card's place
        const tIn = prog(t, 25.9, 0.9)
        const tOut = prog(t, 28.6, 0.8, E.io)
        if (t >= 25.8) S.term = { op: tIn * (1 - tOut), x: 900, y: 260 + 24 * (1 - tIn), s: 1, chars: (t - 26.5) * 260 }
        const cIn = prog(t, 28.7, 0.9)
        const gone = prog(t, 31.4, 0.8, E.io)
        if (t >= 28.6) S.code = { op: cIn * (1 - gone), x: 760, y: 430 + 24 * (1 - cIn), s: 0.95, del: prog(t, 29.5, 0.5, E.io), add: prog(t, 30.1, 0.5, E.io) }
        if (t >= 32.0) S.logo = { icon: prog(t, 32.4, 1.0), mark: prog(t, 32.7, 1.0), sub: prog(t, 33.5, 0.9), url: prog(t, 34.0, 0.9) }
        S.black = Math.max(1 - prog(t, 0, 0.6, E.linear), prog(t, END - 1.0, 1.0, E.io))
      },
    }
  },
}
