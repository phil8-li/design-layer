/*
 * Three edits of the launch film, each timed from its soundtrack's cue map
 * (m = cues.marks, in seconds; see scores.mjs). Scenes drive the window and
 * the cards; `type` is the kinetic typography; `fx` holds the whips, flashes
 * and light sweeps on the cuts.
 */

const INDIGO = "linear-gradient(90deg, #a5b4ff, #798cff 45%, #c084fc)"
const WARM = "linear-gradient(90deg, #ff7ab8, #ffb547)"
const SILVER = "linear-gradient(180deg, #ffffff 30%, #9aa3c7)"

export const CUTS = {
  /* ---------------------------------------------------------------
     A · Bounce — 124 BPM. Word slams on every beat, a cut every bar.
     --------------------------------------------------------------- */
  a({ m, FIT, E, cues }) {
    const b = cues.spb
    const W = m.words
    const word = (text, at, out, extra = {}) => ({ text, at, out, style: "slam", size: 300, weight: 780, tracking: -0.055, outStyle: "cut", split: "none", ...extra })
    const cap = (text, at, out, extra = {}) => ({ text, at, out, style: "slam", size: 80, weight: 680, tracking: -0.04, y: 994, din: 0.14, outStyle: "fade", split: "none", ...extra })
    const bar = (n) => n * 4 * b
    return {
      duration: cues.duration,
      fadeOut: [cues.duration - 1.3, 1.2],
      look: {
        bg: "#060608", winScale: 0.86, winY: -42, punch: 0.016, punchDecay: 0.1, shake: 7, flash: 0.5, grain: 0.03, sweep: 0.6,
        blobs: [
          { x: 520, y: 380, r: 560, color: "radial-gradient(closest-side, rgba(74,93,249,0.9), rgba(74,93,249,0))", op: 0.55, speed: 0.5, phase: 0, kick: 0.08 },
          { x: 1420, y: 720, r: 520, color: "radial-gradient(closest-side, rgba(192,132,252,0.85), rgba(192,132,252,0))", op: 0.45, speed: 0.42, phase: 2.1, kick: 0.08 },
          { x: 980, y: 1020, r: 460, color: "radial-gradient(closest-side, rgba(56,189,248,0.7), rgba(56,189,248,0))", op: 0.3, speed: 0.6, phase: 4.2 },
        ],
      },
      fx: {
        whips: [
          { t: bar(5), kind: "zoom" }, { t: bar(6), dir: 1 }, { t: bar(7), dir: -1 }, { t: bar(8), dir: 1 }, { t: bar(9), kind: "zoom" },
          { t: bar(10), dir: -1 }, { t: bar(11), kind: "zoom" }, { t: bar(12), dir: 1 }, { t: bar(13), kind: "zoom" },
        ],
        flashes: [m.window, m.drop, ...m.build.map((t) => ({ t, a: 0.22 })), m.logo, m.tagline],
        shakes: [m.window, m.drop, m.logo],
        sweeps: [{ t: m.logo + 0.1, dur: 1.1 }],
      },
      scenes: [
        { type: "black", from: 0, to: m.window },
        {
          type: "shot", name: "app-only", from: m.window, to: m.drop,
          cam: [[m.window, 800, 500, FIT], [m.drop, 800, 520, FIT * 1.07, E.linear]],
          win: (t) => {
            const p = Math.min(1, Math.max(0, (t - m.window) / 0.32))
            return { s: 1.22 - 0.22 * E.outBack(p, 1.3), blur: 16 * (1 - E.outCubic(p)) }
          },
        },
        { type: "open", from: m.drop, to: bar(5), at: m.drop, dur: 0.3, mask: true, cam: [[m.drop, 800, 500, FIT], [bar(5), 800, 500, FIT * 1.05, E.linear]] },
        {
          type: "shot", name: "hero", from: bar(5), to: m.style, mask: [bar(5), m.click],
          cam: [[bar(5), 800, 500, FIT], [bar(5) + 0.34, 800, 332, 1.5, E.out], [m.style, 800, 326, 1.6, E.linear]],
          cursor: { path: [[bar(5) + 0.05, 1110, 610], [m.click, 694, 300]], clicks: [m.click], hold: 0.9 },
          select: { at: m.click, dur: 0.18, label: "pop" },
        },
        { type: "shot", name: "hero", from: m.style, to: bar(7), select: { at: 0, dur: 0.01 }, cam: [[m.style, 1000, 470, 1.22], [bar(7), 1000, 562, 1.24, E.linear]] },
        { type: "shot", name: "measure", from: bar(7), to: m.tokens, cam: [[bar(7), 800, 478, 1.78], [m.tokens, 800, 482, 1.88, E.linear]] },
        { type: "shot", name: "tokens", from: m.tokens, to: m.canvas, tok: { in: m.tokens + 0.08, steps: m.tokSteps, out: m.canvas - 0.12, stepDur: 0.18 }, cam: [[m.tokens, 1055, 451, 1.32], [m.canvas, 1055, 458, 1.36, E.linear]] },
        { type: "canvas", from: m.canvas, to: m.notes, zoom: 1.0, drift: 1.05 },
        { type: "shot", name: "notes", from: m.notes, to: m.send, pins: { times: m.pins, size: 34, dur: 0.6 }, cam: [[m.notes, 1046, 310, 1.3], [m.send, 1046, 312, 1.36, E.linear]] },
        { type: "agent", from: m.send, to: m.agent, press: m.press, stream: m.press + 0.1, cps: 1200, inDur: 0.3, inEase: (x) => E.outBack(x, 1.2) },
        { type: "code", from: m.agent, to: m.code, steps: [m.agent + b, m.agent + 2 * b], inDur: 0.32, inEase: (x) => E.outBack(x, 1.2) },
        {
          type: "montage", from: m.code, to: m.logo, push: 0.1, win: { bright: 0.42 },
          items: [
            { at: m.build[0], name: "align" }, { at: m.build[1], name: "responsive", cam: { x: 1200, y: 420, s: 1.2 } },
            { at: m.build[2], name: "system", cam: { x: 1180, y: 430, s: 1.15 } }, { at: m.build[3], name: "light" },
          ],
        },
        { type: "logo", from: m.logo, to: cues.duration, style: "slam", icon: m.logo, mark: m.logo + b / 2, sub: m.tagline, url: m.tagline + b },
      ],
      type: [
        word("You", W[0], W[1]),
        word("vibe‑coded", W[1], W[2], { size: 250 }),
        word("it.", W[2], W[4] - 0.001, { pulse: 0.05 }),
        word("Now", W[4], W[5]),
        word("design", W[5], W[6], { gradient: INDIGO }),
        word("it", W[6], W[7]),
        word("like Figma.", W[7], m.window, { size: 230, gradient: INDIGO }),
        cap("Your app.", m.window, m.drop - 0.25),
        cap("Edit it like Figma.", m.drop, bar(5) - 0.12),
        cap("Click anything.", bar(5), m.style - 0.12),
        cap("Real styles.", m.style, bar(7) - 0.12),
        cap("Hold ⌥ to measure.", bar(7), m.tokens - 0.12),
        cap("Your tokens.", m.tokens, m.canvas - 0.12),
        cap("Every page.", m.canvas, m.notes - 0.12),
        cap("Leave notes.", m.notes, m.send - 0.12),
        cap("Send it to your agent.", m.send, m.agent - 0.12),
        cap("It writes the code.", m.agent, m.code - 0.12),
        word("Align.", m.build[0], m.build[1], { size: 190 }),
        word("Responsive.", m.build[1], m.build[2], { size: 190 }),
        word("Design system.", m.build[2], m.build[3], { size: 190, gradient: INDIGO }),
        word("Light mode.", m.build[3], m.logo, { size: 190 }),
      ],
      keys: [
        { keys: ["⌘", "."], at: m.cmd - 0.4, press: m.cmd, release: m.cmd + 0.12, out: m.drop - 0.1, y: 700 },
        { keys: ["⌥"], at: bar(7) + 0.05, press: m.alt, release: m.tokens - 0.3, out: m.tokens - 0.15, y: 700 },
      ],
    }
  },

  /* ---------------------------------------------------------------
     B · Cinematic — 90 BPM. Letterbox, slow pushes, braams, a breath.
     --------------------------------------------------------------- */
  b({ m, FIT, E, cues }) {
    const b = cues.spb
    const BAR = 138
    const band = (text, at, out, extra = {}) => ({ text, at, out, style: "mask", size: 46, weight: 600, tracking: -0.02, y: 1080 - BAR / 2, outStyle: "up", stagger: 0.05, ...extra })
    const big = (text, at, out, extra = {}) => ({ text, at, out, style: "slam", size: 150, weight: 720, tracking: -0.045, outStyle: "cut", split: "none", ...extra })
    return {
      duration: cues.duration,
      fadeOut: [cues.duration - 1.8, 1.7],
      look: {
        bg: "#030304", winScale: 0.83, winY: 0, punch: 0.006, punchDecay: 0.3, shake: 11, flash: 0.7, grain: 0.065, sweep: 0.7,
        letterbox: (t) => BAR * (1 - Math.min(1, Math.max(0, (t - m.logo) / 0.7))),
        blobs: [
          { x: 960, y: 500, r: 700, color: "radial-gradient(closest-side, rgba(74,93,249,0.55), rgba(74,93,249,0))", op: 0.5, speed: 0.15, phase: 0, wander: 60, kick: 0.04, kickOp: 0.5, when: (t) => (t > m.reveal ? 1 : 0.4) },
          { x: 700, y: 760, r: 520, color: "radial-gradient(closest-side, rgba(147,51,234,0.4), rgba(147,51,234,0))", op: 0.35, speed: 0.12, phase: 2, wander: 80 },
        ],
      },
      fx: {
        whips: [{ t: m.measure, dir: 1, half: 0.16 }, { t: m.tokens, dir: -1, half: 0.16 }, { t: m.notes, dir: 1, half: 0.16 }, { t: m.send, kind: "zoom", half: 0.18 }, { t: m.build, kind: "zoom", half: 0.18 }],
        flashes: [m.reveal, m.lock, m.canvas, ...m.flashes.map((t) => ({ t, a: 0.18 })), m.logo],
        shakes: [m.reveal, m.lock, m.canvas, m.logo],
        sweeps: [{ t: m.reveal + 0.3, dur: 1.6 }, { t: m.logo + 0.2, dur: 1.5 }],
        blackouts: [[m.breath, m.logo]],
      },
      scenes: [
        { type: "black", from: 0, to: m.reveal },
        {
          type: "planes", from: m.reveal, to: m.select, lock: m.lock - 0.55, lockDur: 0.55, lockEase: (x) => E.inCubic(x) * 0.6 + E.io(x) * 0.4,
          appearAt: m.reveal + 1.75, appear: 1.3, rx: 22, ry: -30, rz: 4, rxDrift: -6, ryDrift: 18, scale: 0.8, spread: 1.2, x: -170,
          mask: [0, m.select + b], cam: [[m.lock, 800, 500, FIT], [m.select, 800, 470, FIT * 1.08, E.linear]],
        },
        {
          type: "shot", name: "hero", from: m.select, to: m.measure, mask: [m.select, m.select + b],
          cam: [[m.select, 800, 380, 1.3], [m.measure, 800, 326, 1.62, E.soft]],
          cursor: { path: [[m.select + 0.1, 1130, 620], [m.select + b, 694, 300]], clicks: [m.select + b], hold: 1.2 },
          select: { at: m.select + b, dur: 0.55 },
        },
        { type: "shot", name: "measure", from: m.measure, to: m.tokens, cam: [[m.measure, 800, 470, 1.5], [m.tokens, 800, 481, 1.84, E.soft]] },
        { type: "shot", name: "tokens", from: m.tokens, to: m.canvas, tok: { in: m.tokens + 0.3, steps: [m.tokens + b, m.tokens + 2 * b, m.tokens + 3 * b], out: m.canvas - 0.2, stepDur: 0.35 }, cam: [[m.tokens, 1055, 470, 1.18], [m.canvas, 1055, 456, 1.34, E.soft]] },
        { type: "canvas", from: m.canvas, to: m.notes, zoom: 2.0, ease: E.io, drift: 1.04 },
        { type: "shot", name: "notes", from: m.notes, to: m.send, pins: { times: [m.notes + b, m.notes + 2 * b, m.notes + 3 * b], size: 40, dur: 1.0 }, cam: [[m.notes, 1046, 330, 1.18], [m.send, 1046, 310, 1.32, E.soft]] },
        { type: "agent", from: m.send, to: m.build, press: m.press, stream: m.press + 0.15, cps: 800, inDur: 0.6 },
        {
          type: "montage", from: m.build, to: m.breath, push: 0.05, win: (t) => ({ bright: t < m.flashes[4] ? 0.4 : 0.85 }),
          items: [
            { at: m.flashes[0], name: "align" }, { at: m.flashes[1], name: "responsive", cam: { x: 1200, y: 420, s: 1.2 } },
            { at: m.flashes[2], name: "system", cam: { x: 1180, y: 430, s: 1.15 } }, { at: m.flashes[3], name: "audit", cam: { x: 1180, y: 460, s: 1.15 } },
            { at: m.flashes[4], name: "options", cam: { x: 1000, y: 420, s: 1.1 } }, { at: m.flashes[5], name: "shortcuts" },
            { at: m.flashes[6], name: "light" }, { at: m.flashes[7], name: "hero", cam: { x: 800, y: 326, s: 1.6 } },
            { at: m.flashes[8], name: "measure", cam: { x: 800, y: 481, s: 1.8 } }, { at: m.flashes[9], name: "tokens", cam: { x: 1055, y: 456, s: 1.34 } },
            { at: m.flashes[10], name: "canvas" }, { at: m.flashes[11], name: "notes", cam: { x: 1046, y: 310, s: 1.3 } },
          ],
        },
        { type: "black", from: m.breath, to: m.logo },
        { type: "logo", from: m.logo, to: cues.duration, style: "reveal", icon: m.logo, mark: m.logo + 0.25, sub: m.tagline, url: m.tagline + b },
      ],
      type: [
        { text: "You shipped it fast.", at: 0.3, out: m.line2 - 0.35, style: "mask", size: 128, weight: 640, tracking: -0.04, outStyle: "up", stagger: 0.09, zoom: 0.012 },
        { text: "Now make it beautiful.", at: m.line2 + 0.2, out: m.reveal - 0.4, style: "mask", size: 128, weight: 640, tracking: -0.04, outStyle: "up", stagger: 0.09, zoom: 0.012, accent: [3], accentGradient: SILVER },
        { text: "Design Layer", at: m.reveal + 0.05, out: m.reveal + 1.3, style: "track", size: 170, weight: 700, tracking: -0.045, outStyle: "blur", split: "none", dout: 0.55, gradient: SILVER },
        band("Select anything.", m.select + 0.1, m.measure - 0.3),
        band("Measure every gap.", m.measure + 0.1, m.tokens - 0.3),
        band("Use your own tokens.", m.tokens + 0.1, m.canvas - 0.3),
        band("See every page at once.", m.canvas + 0.1, m.notes - 0.3),
        band("Leave notes where they belong.", m.notes + 0.1, m.send - 0.3),
        band("Hand it to your agent.", m.send + 0.1, m.build - 0.3),
        big("Your tokens.", m.flashes[0], m.flashes[1]),
        big("Your components.", m.flashes[1], m.flashes[2]),
        big("Your code.", m.flashes[2], m.flashes[3]),
        big("Your machine.", m.flashes[3], m.flashes[4], { gradient: INDIGO }),
      ],
      keys: [{ keys: ["⌥"], at: m.measure + 0.15, press: m.measure + 0.45, release: m.tokens - 0.4, out: m.tokens - 0.25, y: 690 }],
    }
  },

  /* ---------------------------------------------------------------
     C · Groove — 100 BPM swung. Bouncy type, springy UI, a stop.
     --------------------------------------------------------------- */
  c({ m, FIT, E, cues, hit }) {
    const b = cues.spb
    const pop = (text, at, out, extra = {}) => ({ text, at, out, style: "pop", size: 80, weight: 720, tracking: -0.04, y: 998, outStyle: "pop", split: "none", ...extra })
    const wiggle = (t) => ({ rz: 1.1 * Math.sin(t * 9) * hit(cues.snares, t, 0.18) })
    return {
      duration: cues.duration,
      fadeOut: [cues.duration - 1.4, 1.3],
      look: {
        bg: "#0a0610", winScale: 0.84, winY: -36, punch: 0.02, punchDecay: 0.12, shake: 6, flash: 0.32, flashColor: "#ffe3f3", grain: 0.025,
        blobs: [
          { x: 480, y: 360, r: 540, color: "radial-gradient(closest-side, rgba(255,95,162,0.75), rgba(255,95,162,0))", op: 0.5, speed: 0.7, phase: 0, kick: 0.12, kickOp: 0.4 },
          { x: 1460, y: 680, r: 560, color: "radial-gradient(closest-side, rgba(124,92,255,0.8), rgba(124,92,255,0))", op: 0.5, speed: 0.55, phase: 1.7, kick: 0.12, kickOp: 0.4 },
          { x: 1000, y: 980, r: 440, color: "radial-gradient(closest-side, rgba(255,181,71,0.6), rgba(255,181,71,0))", op: 0.35, speed: 0.8, phase: 3.3, kick: 0.1 },
        ],
      },
      fx: {
        whips: [m.align, m.measure, m.tokens, m.canvas, m.notes, m.send, m.code].map((t, i) => ({ t, kind: i % 2 ? "zoom" : "whip", dir: i % 4 < 2 ? 1 : -1, half: 0.1 })),
        flashes: [m.window, m.open, m.stop, m.logo].map((t) => ({ t, a: 0.3 })),
        shakes: [m.window, m.stop, m.logo],
      },
      scenes: [
        { type: "black", from: 0, to: m.window },
        {
          type: "shot", name: "app-only", from: m.window, to: m.open, cam: [[m.window, 800, 500, FIT], [m.open, 800, 512, FIT * 1.05, E.linear]],
          win: (t) => {
            const p = Math.min(1.6, Math.max(0, (t - m.window) / 0.5))
            return { s: 0.55 + 0.45 * E.spring(p, 12, 5), y: 60 * (1 - Math.min(1, p)), ...wiggle(t) }
          },
        },
        {
          type: "open", from: m.open, to: m.align, at: m.open, dur: 0.42, ease: (x) => E.outBack(x, 1.6), mask: [m.open, m.click],
          cam: [[m.open, 800, 500, FIT], [m.click, 800, 500, FIT], [m.click + 0.3, 800, 345, 1.36, E.out], [m.align, 800, 332, 1.44, E.linear]],
          cursor: { path: [[m.open + 0.15, 1100, 640], [m.click, 694, 300]], clicks: [m.click], hold: 0.8 },
          select: { at: m.click, dur: 0.2, label: "pop" }, win: wiggle,
        },
        { type: "shot", name: "align", from: m.align, to: m.measure, cam: [[m.align, 800, 520, 1.15], [m.measure, 800, 520, 1.22, E.linear]], win: wiggle },
        { type: "shot", name: "measure", from: m.measure, to: m.tokens, cam: [[m.measure, 800, 470, 1.5], [m.tokens, 800, 481, 1.8, E.soft]], win: wiggle },
        { type: "shot", name: "tokens", from: m.tokens, to: m.canvas, tok: { in: m.tokens + 0.1, steps: m.tokSteps, out: m.canvas - 0.15, stepDur: 0.2 }, cam: [[m.tokens, 1055, 451, 1.32], [m.canvas, 1055, 456, 1.36, E.linear]], win: wiggle },
        { type: "canvas", from: m.canvas, to: m.notes, zoom: 0.9, ease: (x) => E.outBack(x, 1.1), drift: 1.04 },
        { type: "shot", name: "notes", from: m.notes, to: m.send, pins: { times: m.pins, size: 46, dur: 0.55 }, cam: [[m.notes, 1046, 310, 1.3], [m.send, 1046, 312, 1.34, E.linear]], win: wiggle },
        { type: "agent", from: m.send, to: m.code, press: m.press, stream: m.press + 0.1, cps: 1100, inDur: 0.6, bounce: true },
        { type: "code", from: m.code, to: m.stop, steps: [m.code + b, m.code + 2 * b], inDur: 0.6, bounce: true },
        { type: "black", from: m.stop, to: m.logo },
        { type: "logo", from: m.logo, to: cues.duration, style: "bounce", icon: m.logo, mark: m.logo + b / 2, sub: m.tagline, url: m.tagline + b },
      ],
      type: [
        { text: "Your app works.", at: m.words1[0], out: m.words2[0] - 0.12, style: "bounce", size: 190, weight: 760, tracking: -0.05, stagger: b, outStyle: "pop", accent: [2], accentGradient: WARM },
        { text: "Now make it pop.", at: m.words2[0], out: m.window - 0.1, style: "bounce", size: 190, weight: 760, tracking: -0.05, stagger: b, outStyle: "pop", accent: [3], accentGradient: WARM },
        pop("Your app.", m.window, m.open - 0.15),
        pop("Click.", m.open, m.align - 0.15),
        pop("Nudge.", m.align, m.measure - 0.15),
        pop("Measure.", m.measure, m.tokens - 0.15),
        pop("Tokens.", m.tokens, m.canvas - 0.15, { gradient: WARM }),
        { ...pop("Every. Single. Page.", m.canvas, m.notes - 0.15, { split: "word", stagger: b }) },
        pop("Leave a note.", m.notes, m.send - 0.15),
        pop("Send.", m.send, m.code - 0.15),
        pop("Done.", m.code, m.stop - 0.12, { gradient: WARM }),
        { text: "That's it.", at: m.stop + 0.02, out: m.logo - 0.12, style: "bounce", size: 230, weight: 780, tracking: -0.05, outStyle: "pop", split: "word", stagger: b * 0.5 },
      ],
      keys: [
        { keys: ["⌘", "."], at: m.cmd - 0.35, press: m.cmd, release: m.cmd + 0.12, out: m.open - 0.05, y: 700, bounce: true },
        { keys: ["⌥"], at: m.measure + 0.05, press: m.measure + 0.3, release: m.tokens - 0.3, out: m.tokens - 0.15, y: 700, bounce: true },
      ],
    }
  },
}
