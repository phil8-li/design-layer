/*
 * Design Layer launch film. Every pixel is a pure function of time:
 * window.seek(t) writes each layer's transform/opacity/clip/text from easing
 * curves, with no CSS transitions, animations or timers, so render.mjs can
 * step frames deterministically. ?demo=<slug> picks the screenshot set under
 * ../assets/shots/<slug>/; a shot the demo lacks comes from FALLBACK.
 */
;(() => {
  const DURATION = 50
  const params = new URLSearchParams(location.search)
  const DEMO = params.get("demo") || "midday"
  const FALLBACK = "midday"
  const SHOTS = "../assets/shots/"

  // Geometry in the shots' CSS pixels (1600x1000; the JPEGs are 2x). Keyed by
  // the demo that supplied the file, so a fallback shot uses its own numbers.
  const GEO = {
    midday: {
      split: [0.175, 0.825], // left panel | app | inspector, as fractions of width
      sel: [416, 246, 768, 120], // the headline's box, when the indigo outline is not detected
      // Headline text spans x 546–1057 and the subtitle 514–1086, inside a 416–1184 box.
      // Every framing keeps its edges in whitespace or in the screenshot image below y 606.
      // headline box with its size label, from below the nav (y 45) to above the hero image
      select: { x: 800, y: 324, s: 1.67 },
      // the whole selection beside the inspector, panning down from Layout to Typography
      // (Hedvig Letters Serif); a closer push would clip the UI inside the hero image
      inspector: [{ x: 1000, y: 470, s: 1.2 }, { x: 1000, y: 555, s: 1.2 }],
      // headline and Get started with the red distance between them, the button mid-frame
      // so the ⌥ keycap lands on the hero image instead
      measure: [{ x: 800, y: 479, s: 1.8 }, { x: 800, y: 481, s: 1.84 }],
      // Get started beside the Fill color picker; the bar walks up to `background`, the token in use
      tokens: { cam: [{ x: 1055, y: 451, s: 1.32 }, { x: 1055, y: 456, s: 1.32 }], bar: { x: 1334, w: 252, h: 26, rows: [434, 406, 378, 350] } },
      canvas: { frame: [312, 158, 298, 286] }, // the "Current" frame: the app-only page on the board
      // all three pins, the composer on Get started, the toolbar hint and the notes list
      notes: { cam: [{ x: 1046, y: 310, s: 1.3 }, { x: 1046, y: 310, s: 1.3 }], pins: [[737, 203], [593, 307], [688, 489]] },
      changes: { crop: [1322, 40, 278, 314], button: [1430, 317, 104, 23] },
    },
  }
  const GENERIC = {
    split: [0.156, 0.819],
    sel: [503, 89, 798, 40],
    inspector: [{ x: 1150, y: 330, s: 1.6 }, { x: 1150, y: 420, s: 1.6 }],
    measure: [{ x: 800, y: 300, s: 1.6 }, { x: 800, y: 300, s: 1.7 }],
    tokens: { cam: [{ x: 1221, y: 600, s: 1.9 }, { x: 1240, y: 600, s: 2.0 }], bar: null },
    canvas: { frame: [560, 300, 480, 300] },
    notes: { cam: [{ x: 800, y: 500, s: 0.9 }, { x: 800, y: 500, s: 0.96 }], pins: [] },
    changes: { crop: [1300, 40, 300, 312], button: null },
  }
  const geo = (demo, key) => (GEO[demo] && GEO[demo][key]) || GENERIC[key]

  // ---- easing ---------------------------------------------------------------
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
    const sx = (u) => ((ax * u + bx) * u + cx) * u
    const sy = (u) => ((ay * u + by) * u + cy) * u
    const dx = (u) => (3 * ax * u + 2 * bx) * u + cx
    return (x) => {
      if (x <= 0) return 0
      if (x >= 1) return 1
      let u = x
      for (let i = 0; i < 8; i++) {
        const e = sx(u) - x
        if (Math.abs(e) < 1e-6) break
        const d = dx(u)
        if (Math.abs(d) < 1e-6) break
        u -= e / d
      }
      let lo = 0, hi = 1
      for (let i = 0; i < 30 && Math.abs(sx(u) - x) > 1e-6; i++) {
        if (sx(u) < x) lo = u
        else hi = u
        u = (lo + hi) / 2
      }
      return sy(u)
    }
  }
  const easeOut = bezier(0.23, 1, 0.32, 1)
  const easeIO = bezier(0.77, 0, 0.175, 1)
  const sine = (x) => -(Math.cos(Math.PI * Math.min(1, Math.max(0, x))) - 1) / 2
  const linear = (x) => Math.min(1, Math.max(0, x))
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
  const lerp = (a, b, p) => a + (b - a) * p
  /** Eased progress of t through [a, a + d]. */
  const prog = (t, a, d, ease = easeOut) => ease(clamp((t - a) / d, 0, 1))
  /** 0→1 over [a, a+din], held, then 1→0 over [b-dout, b]. */
  const window01 = (t, a, din, b, dout, ein = easeOut, eout = linear) =>
    Math.min(prog(t, a, din, ein), 1 - prog(t, b - dout, dout, eout))

  // ---- camera ---------------------------------------------------------------
  const VW = 1440, VH = 900
  function clampCam(c) {
    const hw = VW / 2 / c.s, hh = VH / 2 / c.s
    return { x: clamp(c.x, hw, 1600 - hw), y: clamp(c.y, hh, 1000 - hh), s: c.s }
  }
  /** keys: [{t, x, y, s, e}] — e eases the segment that ends at that key. Zoom interpolates in log space. */
  function track(t, keys) {
    if (t <= keys[0].t) return keys[0]
    for (let i = 1; i < keys.length; i++) {
      const k = keys[i]
      if (t <= k.t) {
        const a = keys[i - 1]
        const p = (k.e || easeIO)((t - a.t) / (k.t - a.t))
        return { x: lerp(a.x, k.x, p), y: lerp(a.y, k.y, p), s: Math.exp(lerp(Math.log(a.s), Math.log(k.s), p)) }
      }
    }
    return keys[keys.length - 1]
  }
  function setCam(el, c) {
    el.style.transform = `translate(${VW / 2 - c.x * c.s}px, ${VH / 2 - c.y * c.s}px) scale(${c.s})`
  }

  // ---- dom ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id)
  const el = {}
  for (const id of ["glow", "title", "title1", "title2", "title3", "win", "camMain", "imgApp", "stripL", "stripC", "stripR", "imgHero",
    "imgMeasure", "imgTokens", "selRect", "tokBar", "selLabel", "camCanvas", "imgCanvas", "appFly", "camNotes", "imgNotes",
    "pins", "agent", "changesCard", "imgChanges", "sendBtn", "imgSend", "sendRing", "term", "termText", "code", "codeFile",
    "codeStat", "codeBody", "flyClip", "codeSweep", "end", "endGlow", "endIcon", "endMark", "endSub", "endUrl", "keys", "caption", "black"]) el[id] = $(id)
  const op = (e, v) => { e.style.opacity = String(Math.round(clamp(v, 0, 1) * 1000) / 1000) }
  const vis = (e, on) => { e.style.visibility = on ? "visible" : "hidden" }

  // title words
  const titleWords = []
  for (const [line, text, start] of [[el.title1, "Bring the design layer", 0.3], [el.title2, "to your vibe-coded apps.", 0.62], [el.title3, "Edit it like Figma.", 1.2]]) {
    text.split(" ").forEach((w, i, all) => {
      const s = document.createElement("span")
      s.className = "w"
      s.textContent = i < all.length - 1 ? w + " " : w
      line.appendChild(s)
      titleWords.push({ s, start: start + i * 0.07 })
    })
  }

  const CAPTIONS = [
    [3.5, 6.8, "Your app."],
    [7.9, 10.35, "Open the design layer."],
    [10.8, 13.85, "Click anything."],
    [14.3, 17.85, "Real styles."],
    [18.4, 21.85, "Hold ⌥ to measure."],
    [22.4, 26.3, "Your tokens."],
    [27.2, 31.35, "Every page."],
    [31.9, 35.85, "Leave notes."],
    [36.7, 40.35, "Send it to your agent."],
    [40.9, 43.85, "It writes the code."],
  ]
  const KEYS = [
    { keys: ["⌘", "."], at: 7.0, press: 7.45, release: 7.58, out: 8.35 },
    { keys: ["⌥"], at: 18.3, press: 18.75, release: 20.25, out: 20.55 },
    { keys: ["⇧", "1"], at: 26.35, press: 26.8, release: 26.93, out: 27.7 },
  ]

  // ---- data -----------------------------------------------------------------
  const S = {} // resolved shots: name -> { url, demo }
  let sel = null, termLines = [], termTotal = 0, diffModel = null

  async function exists(url) {
    try {
      const r = await fetch(url, { method: "HEAD", cache: "no-store" })
      return r.ok
    } catch {
      return false
    }
  }
  /**
   * The site publishes shots as <name>-2400.webp; render.mjs serves the 2x
   * <name>.jpg originals at the .jpg URL. Prefer the original, fall back to the webp.
   */
  async function shotUrl(demo, file) {
    const url = `${SHOTS}${demo}/${file}`
    if (await exists(url)) return url
    if (file.endsWith(".jpg")) {
      const webp = url.replace(/\.jpg$/, "-2400.webp")
      if (await exists(webp)) return webp
    }
    return null
  }
  async function pick(file) {
    for (const demo of [DEMO, FALLBACK]) {
      const url = await shotUrl(demo, file)
      if (url) return { url, demo }
    }
    return null
  }
  async function fetchJson(url) {
    try {
      return await (await fetch(url, { cache: "no-store" })).json()
    } catch {
      return null
    }
  }
  /** True when an agent.json carries a delivered change rather than a wait_for_change timeout. */
  function realChange(j) {
    let r = j && j.result
    const tx = r && r.content && r.content[0] && r.content[0].text
    if (typeof tx === "string") {
      try { r = JSON.parse(tx) } catch {}
    }
    return !!r && typeof r === "object" && r.timeout !== true
  }
  function load(img, src) {
    img.src = src
    return img.decode().catch(() => new Promise((r) => { img.onload = r; img.onerror = r }))
  }

  /** Bounding box of the indigo selection outline inside the app strip, or null. */
  function detectSelection(img, split) {
    const c = document.createElement("canvas")
    c.width = 1600
    c.height = 1000
    const g = c.getContext("2d", { willReadFrequently: true })
    g.drawImage(img, 0, 0, 1600, 1000)
    const x0 = Math.ceil(split[0] * 1600) + 4, x1 = Math.floor(split[1] * 1600) - 4
    const d = g.getImageData(x0, 40, x1 - x0, 860).data
    const W = x1 - x0, rows = new Array(860).fill(0), cols = new Array(W).fill(0)
    let n = 0
    for (let y = 0; y < 860; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, r = d[i], gg = d[i + 1], b = d[i + 2]
      if (b > 215 && r > 85 && r < 165 && gg > 105 && gg < 180 && b - r > 70) { n++; rows[y]++; cols[x]++ }
    }
    if (n < 150) return null
    // The outline's edges are the rows/columns that are mostly indigo; the
    // resize handles poke a few pixels past them and are ignored.
    const edges = (arr) => {
      const max = Math.max(...arr), hit = arr.map((v, i) => (v > max * 0.8 ? i : -1)).filter((i) => i >= 0)
      return [hit[0], hit[hit.length - 1]]
    }
    const [ry0, ry1] = edges(rows), [cx0, cx1] = edges(cols)
    if (cx1 - cx0 < 30 || ry1 - ry0 < 10) return null
    return [cx0 + x0, ry0 + 40, cx1 - cx0 + 1, ry1 - ry0 + 1]
  }

  /** The filled indigo "Send to agent" button in the right panel, or null. Badges and outlines are too narrow to count. */
  function detectButton(img) {
    const c = document.createElement("canvas")
    c.width = 1600
    c.height = 1000
    const g = c.getContext("2d", { willReadFrequently: true })
    g.drawImage(img, 0, 0, 1600, 1000)
    const X0 = 1290, W = 310, d = g.getImageData(X0, 40, W, 900).data
    const rows = []
    for (let y = 0; y < 900; y++) {
      let run = 0, best = 0, end = 0
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4, r = d[i], gg = d[i + 1], b = d[i + 2]
        if (b > 200 && r > 50 && r < 110 && gg > 70 && gg < 125) {
          if (++run > best) { best = run; end = x }
        } else run = 0
      }
      if (best > 70) rows.push({ y: y + 40, x0: X0 + end - best + 1, x1: X0 + end + 1 })
    }
    if (rows.length < 12) return null
    const first = rows[0], group = rows.filter((r) => r.y - first.y < 40)
    const x0 = Math.min(...group.map((r) => r.x0)), x1 = Math.max(...group.map((r) => r.x1))
    return [x0, first.y, x1 - x0, group[group.length - 1].y - first.y + 1]
  }

  /** Centers of note pins: filled indigo discs 12–26 px across, inside the app strip. */
  function detectPins(img, split) {
    const c = document.createElement("canvas")
    c.width = 1600
    c.height = 1000
    const g = c.getContext("2d", { willReadFrequently: true })
    g.drawImage(img, 0, 0, 1600, 1000)
    const X0 = Math.ceil(split[0] * 1600), W = Math.floor(split[1] * 1600) - X0, H = 900
    const d = g.getImageData(X0, 0, W, H).data
    const on = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) {
      const r = d[i * 4], gg = d[i * 4 + 1], b = d[i * 4 + 2]
      on[i] = b > 200 && r > 40 && r < 115 && gg > 60 && gg < 130 ? 1 : 0
    }
    const pins = [], stack = []
    for (let i = 0; i < W * H; i++) {
      if (on[i] !== 1) continue
      let minX = W, minY = H, maxX = 0, maxY = 0, n = 0
      on[i] = 2
      stack.push(i)
      while (stack.length) {
        const j = stack.pop(), x = j % W, y = (j - x) / W
        n++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        for (const k of [j - 1, j + 1, j - W, j + W]) {
          if (k >= 0 && k < W * H && on[k] === 1 && Math.abs((k % W) - x) <= 1) { on[k] = 2; stack.push(k) }
        }
      }
      const w = maxX - minX + 1, h = maxY - minY + 1
      if (w >= 12 && w <= 26 && h >= 12 && h <= 26 && Math.abs(w - h) <= 5 && n / (w * h) > 0.55) {
        pins.push([X0 + minX + w / 2, minY + h / 2])
      }
    }
    return pins
  }

  // terminal: JSON the agent receives, syntax-highlighted
  const MAXC = 74
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  function tokenize(line) {
    const out = []
    const re = /("(?:[^"\\]|\\.)*"?)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)|([{}\[\],:])|(\s+)|(.)/g
    let m
    while ((m = re.exec(line))) {
      if (m[1] !== undefined) {
        out.push([m[2] ? "k" : "s", m[1]])
        if (m[2]) out.push(["p", m[2]])
      } else if (m[3]) out.push(["n", m[3]])
      else if (m[4]) out.push(["n", m[4]])
      else if (m[5]) out.push(["p", m[5]])
      else out.push(["", m[0]])
    }
    return out
  }
  function buildTerm(raw) {
    let res = raw && raw.result !== undefined ? raw.result : raw
    const text = res && res.content && res.content[0] && res.content[0].text
    if (typeof text === "string") {
      try { res = JSON.parse(text) } catch { res = text }
    }
    const lines = [{ cls: "c", text: "› wait_for_change" }]
    for (let l of JSON.stringify(res, null, 2).split("\n")) {
      if (l.length > MAXC) l = l.slice(0, MAXC - 1) + "…"
      lines.push({ json: true, text: l })
    }
    for (const r of (raw && raw.resolve_change) || []) {
      lines.push({ cls: "c", text: `› resolve_change "${r.id}"` })
      let v = r.result
      try { v = JSON.parse(v) } catch {}
      const compact = typeof v === "object" ? JSON.stringify(v).replace(/,"/g, ', "').replace(/":/g, '": ') : String(v)
      lines.push({ json: true, text: compact.length > MAXC ? compact.slice(0, MAXC - 1) + "…" : compact })
    }
    termLines = lines
    termTotal = lines.reduce((n, l) => n + l.text.length + 1, 0)
  }
  function renderTerm(chars, t) {
    let html = "", left = chars, shown = 0
    for (const l of termLines) {
      if (left <= 0) break
      const take = Math.min(left, l.text.length)
      if (l.json) {
        let n = take
        for (const [k, s] of tokenize(l.text)) {
          if (n <= 0) break
          const part = s.slice(0, n)
          n -= part.length
          html += k ? `<span class="tk-${k}">${esc(part)}</span>` : esc(part)
        }
      } else html += `<span class="tk-${l.cls}">${esc(l.text.slice(0, take))}</span>`
      left -= l.text.length + 1
      shown++
      if (left > 0) html += "\n"
    }
    const blink = Math.floor(t * 2.2) % 2 === 0 || chars < termTotal
    html += `<span class="cursor" style="opacity:${blink ? 1 : 0}"></span>`
    el.termText.innerHTML = html
    // scroll like a terminal once the text outgrows the card
    const max = 20
    el.termText.style.transform = `translateY(${-Math.max(0, shown - max) * 25}px)`
  }

  // diff: first hunk, word-level highlight on the first -/+ pair
  function parseDiff(txt) {
    const L = txt.replace(/\r/g, "").split("\n")
    let file = ""
    let i = 0
    for (; i < L.length; i++) {
      if (L[i].startsWith("+++ ")) file = L[i].replace(/^\+\+\+ (b\/)?/, "")
      if (L[i].startsWith("@@")) break
    }
    if (i >= L.length) return null
    const head = L[i]
    const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(head)
    let a = m ? +m[1] : 1, b = m ? +m[2] : 1
    const body = []
    for (let j = i + 1; j < L.length && !L[j].startsWith("@@") && !L[j].startsWith("diff --git"); j++) {
      const c = L[j][0], tx = L[j].slice(1)
      if (L[j].startsWith("\\")) continue
      if (c === "-") body.push({ k: "del", n: a++, tx })
      else if (c === "+") body.push({ k: "add", n: b++, tx })
      else if (c === " " || L[j] === "") {
        body.push({ k: "ctx", n: b++, tx: L[j] === "" ? "" : tx })
        a++
      }
    }
    while (body.length && body[body.length - 1].k === "ctx" && body[body.length - 1].tx === "") body.pop()
    const first = body.findIndex((l) => l.k !== "ctx")
    let last = first
    while (last + 1 < body.length && body[last + 1].k !== "ctx") last++
    const lines = body.slice(Math.max(0, first - 3), Math.min(body.length, last + 3))
    const adds = body.filter((l) => l.k === "add").length, dels = body.filter((l) => l.k === "del").length
    return { file, head: head.replace(/^(@@[^@]*@@).*/, "$1"), lines, stat: `+${adds} −${dels}` }
  }
  function diffFromBrief(raw) {
    const brief = JSON.stringify(raw)
    const ch = /Change:\*\* set `([^`]+)` to `([^`]+)` \(was `([^`]+)`\)/.exec(JSON.parse(brief.match(/"brief":("(?:[^"\\]|\\.)*")/)?.[1] || '""'))
    if (!ch) return null
    return {
      file: "Design Layer change", head: "", stat: "",
      lines: [{ k: "del", n: "", tx: `${ch[1]}: ${ch[3]};` }, { k: "add", n: "", tx: `${ch[1]}: ${ch[2]};` }],
    }
  }
  function wordSpan(a, b) {
    let p = 0
    while (p < a.length && p < b.length && a[p] === b[p]) p++
    let s = 0
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
    const stop = /[\s"'`{}()<>=,;]/
    while (p > 0 && !stop.test(a[p - 1])) p--
    while (s > 0 && !stop.test(a[a.length - s])) s--
    return [p, s]
  }
  function buildDiff(model) {
    diffModel = model
    el.codeFile.textContent = model.file
    el.codeStat.textContent = model.stat
    const lines = model.lines
    const indent = Math.min(...lines.filter((l) => l.tx.trim()).map((l) => l.tx.match(/^\s*/)[0].length))
    for (const l of lines) l.tx = l.tx.slice(indent)
    const del = lines.find((l) => l.k === "del"), add = lines.find((l) => l.k === "add")
    let span = null
    if (del && add) span = wordSpan(del.tx, add.tx)
    const WIDTH = 104
    const longest = Math.max(...lines.map((l) => l.tx.length))
    let off = 0
    if (longest > WIDTH && span) off = Math.max(0, Math.min(span[0] - 36, longest - WIDTH))
    const cut = (s) => {
      let r = s
      if (off) r = r.length > off ? "…" + r.slice(off + 1) : ""
      if (r.length > WIDTH) r = r.slice(0, WIDTH - 1) + "…"
      return r
    }
    const rows = []
    if (model.head) rows.push(`<div class="cl hunk"><span class="gut"></span><span class="sg"></span><span class="tx">${esc(model.head)}</span></div>`)
    for (const l of lines) {
      let inner = esc(cut(l.tx))
      if (span && (l === del || l === add)) {
        const s = l.tx, a = span[0], b = s.length - span[1]
        const pre = cut(s.slice(0, a) + "\u0000" + s.slice(a, b) + "\u0001" + s.slice(b))
        inner = esc(pre).replace("\u0000", '<span class="hl">').replace("\u0001", "</span>")
        if (!inner.includes("</span>") && inner.includes('<span class="hl">')) inner += "</span>"
      }
      const sg = l.k === "del" ? "−" : l.k === "add" ? "+" : ""
      rows.push(`<div class="cl ${l.k}"><span class="bg"></span><span class="gut">${l.n}</span><span class="sg">${sg}</span><span class="tx">${inner}</span></div>`)
    }
    el.codeBody.innerHTML = rows.join("")
  }

  // ---- init -----------------------------------------------------------------
  let G = {}
  async function init() {
    // Handoff (beats 10–11): the Changes tab, the agent's JSON and the diff
    // come from one demo so they tell one story; skip a demo whose capture
    // has no diff or whose wait_for_change timed out.
    let handoff = null
    for (const demo of [DEMO, FALLBACK]) {
      const base = `${SHOTS}${demo}/`
      const changesUrl = await shotUrl(demo, "changes.jpg")
      if (!changesUrl || !(await exists(base + "diff.txt"))) continue
      const j = await fetchJson(base + "agent.json")
      if (realChange(j)) {
        handoff = { demo, agent: j, agentUrl: base + "agent.json", diffUrl: base + "diff.txt" }
        S.changes = { url: changesUrl, demo }
        break
      }
    }
    const names = ["app-only", "hero", "measure", "tokens", "canvas", "notes", ...(handoff ? [] : ["changes"])]
    for (const n of names) S[n] = await pick(`${n}.jpg`)
    const g = (n, key) => geo(S[n]?.demo, key)
    G = {
      split: g("hero", "split"), inspector: g("hero", "inspector"), measure: g("measure", "measure"),
      tokens: g("tokens", "tokens"), canvas: g("canvas", "canvas"), notes: g("notes", "notes"), changes: g("changes", "changes"),
    }
    // Measured geometry beats the hand-tuned numbers when a capture recorded
    // it: the panel seams (landing/tools/optimize-shots.mjs) and the board's
    // Current frame (the capture's manifest), so a recapture needs no re-measure.
    {
      const demos = (await fetchJson(`${SHOTS}demos.json`)) || []
      const measured = (slug) => demos.find((d) => d.slug === slug)?.geometry ?? {}
      const seams = measured(S.hero?.demo).seams
      const focus = measured(S.canvas?.demo).focus
      if (seams) G.split = [seams.left, seams.right]
      if (focus) G.canvas = { ...G.canvas, frame: [focus.x, focus.y, focus.w, focus.h] }
    }
    const jobs = [
      load(el.imgApp, S["app-only"].url), load(el.appFly, S["app-only"].url),
      ...["stripL", "stripC", "stripR"].map((id) => load(el[id].querySelector("img"), S.hero.url)),
      load(el.imgHero, S.hero.url), load(el.imgMeasure, S.measure.url), load(el.imgTokens, S.tokens.url),
      load(el.imgCanvas, S.canvas.url), load(el.imgNotes, S.notes.url),
      load(el.imgChanges, S.changes.url), load(el.imgSend, S.changes.url), load(el.endIcon, el.endIcon.src),
    ]
    await Promise.all(jobs)

    {
      const [fx, fy, fw, fh] = G.canvas.frame, k = fh / 1000
      Object.assign(el.flyClip.style, { left: `${fx}px`, top: `${fy}px`, width: `${fw}px`, height: `${fh}px` })
      Object.assign(el.appFly.style, { width: `${1600 * k}px`, height: `${1000 * k}px` })
    }

    // beat 3 strips: complementary clips of one image, so seams meet exactly
    const [a, b] = G.split
    el.stripL.style.clipPath = `inset(0 ${(1 - a) * 100}% 0 0)`
    el.stripC.style.clipPath = `inset(0 ${(1 - b) * 100}% 0 ${a * 100}%)`
    el.stripR.style.clipPath = `inset(0 0 0 ${b * 100}%)`

    sel = detectSelection(el.imgHero, G.split) || geo(S.hero.demo, "sel")
    window.__selection = sel
    el.selRect.setAttribute("x", sel[0] - 3)
    el.selRect.setAttribute("y", sel[1] - 3)
    el.selRect.setAttribute("width", sel[2] + 6)
    el.selRect.setAttribute("height", sel[3] + 6)
    el.selLabel.textContent = `${Math.round(sel[2])} × ${Math.round(sel[3])}`
    el.selLabel.style.left = `${sel[0] + sel[2] / 2}px`
    el.selLabel.style.top = `${sel[1] + sel[3] + 10}px`

    // agent card: crop the Changes panel at 1:1 with the 2x original
    // The button moves as the list grows, so find it and crop down to just below it.
    const btn = detectButton(el.imgChanges)
    if (btn) {
      const [x0, y0, w0] = G.changes.crop
      G.changes = { crop: [x0, y0, w0, btn[1] + btn[3] + 14 - y0], button: btn }
    }
    window.__button = btn
    const [cx, cy, cw, ch] = G.changes.crop
    const k = Math.min(596 / cw, 624 / ch)
    // shrink the card to the crop so no empty band shows, and center the pair
    const cardW = Math.round(cw * k)
    el.changesCard.style.width = `${cardW}px`
    const left0 = Math.round((1920 - (cardW + 40 + 900)) / 2)
    el.changesCard.style.left = `${left0}px`
    el.term.style.left = `${left0 + cardW + 40}px`
    el.imgChanges.style.width = `${1600 * k}px`
    el.imgChanges.style.height = `${1000 * k}px`
    el.imgChanges.style.left = `${-cx * k}px`
    el.imgChanges.style.top = `${-cy * k}px`
    if (G.changes.button) {
      const [bx, by, bw, bh] = G.changes.button
      const left = (bx - cx) * k, top = (by - cy) * k
      Object.assign(el.sendBtn.style, { left: `${left}px`, top: `${top}px`, width: `${bw * k}px`, height: `${bh * k}px` })
      Object.assign(el.imgSend.style, { width: `${1600 * k}px`, height: `${1000 * k}px`, left: `${-bx * k}px`, top: `${-by * k}px` })
      Object.assign(el.sendRing.style, { left: `${left - 6}px`, top: `${top - 6}px`, width: `${bw * k + 12}px`, height: `${bh * k + 12}px` })
    } else vis(el.sendBtn, false)

    // pins, and a notes camera that frames them
    const found = detectPins(el.imgNotes, geo(S.notes.demo, "split"))
    if (found.length && GEO[S.notes.demo]?.notes) {
      // a hand-measured framing wins (it can include the composer); the pins stay detected
      G.notes = { ...G.notes, pins: found }
    } else if (found.length) {
      const xs = found.map((p) => p[0]), ys = found.map((p) => p[1])
      const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys)
      // left edge just before the first pin, right edge at the panel listing the notes
      const left = Math.max(0, bx0 - 80)
      const sN = clamp(Math.min(VW / (1600 - left), VH / (by1 - by0 + 320)), 1, 1.8)
      const top = Math.max(0, by0 - 120)
      const c = { x: left + VW / 2 / sN, y: top + VH / 2 / sN }
      G.notes = { pins: found, cam: [{ ...c, s: sN * 0.94 }, { ...c, s: sN }] }
    }
    window.__pins = G.notes.pins
    el.pins.innerHTML = G.notes.pins.map(([x, y]) =>
      `<g data-x="${x}" data-y="${y}"><circle class="r1" cx="${x}" cy="${y}" fill="none" stroke="#798cff" stroke-width="2.5" vector-effect="non-scaling-stroke"/><circle class="r2" cx="${x}" cy="${y}" fill="none" stroke="#798cff" stroke-width="2.5" vector-effect="non-scaling-stroke"/></g>`).join("")

    const agentSrc = handoff ? { url: handoff.agentUrl, demo: handoff.demo } : await pick("agent.json")
    const agent = handoff ? handoff.agent : (agentSrc && (await fetchJson(agentSrc.url))) || { result: { note: "agent.json missing" } }
    buildTerm(agent)
    const diffSrc = handoff ? { url: handoff.diffUrl, demo: handoff.demo } : await pick("diff.txt")
    const model = (diffSrc && parseDiff(await (await fetch(diffSrc.url, { cache: "no-store" })).text())) || diffFromBrief(agent)
    if (model) buildDiff(model)
    window.__sources = { shots: S, agent: agentSrc, diff: diffSrc || "fallback: agent brief" }

    await document.fonts.load('600 100px "InterFilm"')
    await document.fonts.load('500 40px "InterFilm"')
    await document.fonts.ready
    seek(0)
  }

  // ---- seek -----------------------------------------------------------------
  let capIdx = -2, keyIdx = -2
  function seek(t) {
    t = clamp(t, 0, DURATION)

    // 1 · title
    const tOut = prog(t, 2.55, 0.4, easeIO)
    vis(el.title, t < 3.1)
    for (const w of titleWords) {
      const p = prog(t, w.start, 0.9)
      op(w.s, p)
      w.s.style.transform = `translateY(${24 * (1 - p)}px)`
      w.s.style.filter = `blur(${8 * (1 - p)}px)`
    }
    op(el.title, 1 - tOut)
    el.title.style.transform = `translateY(${-14 * tOut}px)`
    el.title.style.filter = tOut > 0 ? `blur(${6 * tOut}px)` : "none"

    // window in/out
    const wIn = prog(t, 3.0, 0.9), wOut = prog(t, 35.9, 0.4, easeIO)
    const wOp = wIn * (1 - wOut)
    op(el.win, wOp)
    vis(el.win, wOp > 0)
    el.win.style.transform = `translateY(${22 * (1 - wIn)}px) scale(${(0.97 + 0.03 * wIn) * (1 - 0.02 * wOut)})`
    op(el.glow, wOp)

    // main camera (beats 2–7)
    const s0 = VW / 1600
    const selCam = GEO[S.hero.demo]?.select || { x: sel[0] + sel[2] / 2, y: sel[1] + 176, s: 1.7 }
    const ins = G.inspector, mea = G.measure, tok = G.tokens.cam
    const main = clampCam(track(t, [
      { t: 3.0, x: 800, y: 500, s: s0 * 1.06 },
      { t: 7.0, x: 800, y: 500, s: s0, e: easeOut },
      { t: 10.5, x: 800, y: 500, s: s0 },
      { t: 11.7, ...clampCam(selCam) },
      { t: 13.95, ...clampCam({ ...selCam, s: selCam.s * 1.04 }), e: sine },
      { t: 15.2, ...ins[0] },
      { t: 17.9, ...ins[1], e: sine },
      { t: 19.5, ...mea[0] },
      { t: 21.9, ...mea[1], e: sine },
      { t: 23.3, ...tok[0] },
      { t: 26.6, ...tok[1], e: sine },
    ]))
    setCam(el.camMain, main)
    vis(el.camMain, t >= 2.9 && t < 26.9)

    // 3 · editor arrives in three strips
    const pl = prog(t, 7.6, 0.9), pr = prog(t, 7.68, 0.9), pc = prog(t, 7.78, 0.42, sine)
    const [a, b] = G.split
    const stripsOn = t >= 7.55 && t < 8.6
    vis(el.stripL, stripsOn); vis(el.stripR, stripsOn); vis(el.stripC, stripsOn)
    el.stripL.style.transform = `translateX(${-a * 1600 * (1 - pl)}px)`
    el.stripR.style.transform = `translateX(${(1 - b) * 1600 * (1 - pr)}px)`
    op(el.stripC, pc)
    const mb = Math.sin(Math.PI * pc)
    el.stripC.style.filter = el.imgApp.style.filter = mb > 0.01 ? `blur(${3 * mb}px)` : "none"
    vis(el.imgApp, t < 8.6)
    vis(el.imgHero, t >= 8.6 && t < 18.4)

    // 4 · selection
    const per = 2 * (sel[2] + sel[3] + 12)
    const draw = prog(t, 11.45, 0.75, easeIO)
    const selOut = prog(t, 13.75, 0.3)
    el.selRect.setAttribute("stroke-dasharray", `${per}`)
    el.selRect.setAttribute("stroke-dashoffset", `${per * (1 - draw)}`)
    op(el.selRect, draw > 0 ? 1 - selOut : 0)
    el.selRect.style.filter = "drop-shadow(0 0 6px rgba(121,140,255,0.7))"
    const lab = prog(t, 11.95, 0.45)
    op(el.selLabel, lab * (1 - selOut))
    el.selLabel.style.transform = `translate(-50%, ${6 * (1 - lab)}px) scale(${1 / main.s * 1.3})`

    // 6 · measure, 7 · tokens: crossfades on the shared camera
    const mIn = prog(t, 18.0, 0.35, sine)
    op(el.imgMeasure, mIn)
    vis(el.imgMeasure, t >= 18.0 && t < 22.4)
    const tIn = prog(t, 22.0, 0.35, sine)
    op(el.imgTokens, tIn)
    vis(el.imgTokens, t >= 22.0)
    // a short blur peak hides the double image while two shots dissolve
    const dz = Math.max(Math.sin(Math.PI * mIn), Math.sin(Math.PI * tIn))
    el.camMain.style.filter = dz > 0.01 ? `blur(${1.6 * dz}px)` : "none"
    const bar = G.tokens.bar
    if (bar) {
      const rows = bar.rows
      let y = rows[0]
      const steps = [23.55, 24.05, 24.55]
      for (let i = 0; i < rows.length - 1; i++) y = lerp(y, rows[i + 1], prog(t, steps[i] ?? 99, 0.38, easeIO))
      const bOp = Math.min(prog(t, 23.15, 0.3), 1 - prog(t, 25.05, 0.35, sine))
      op(el.tokBar, bOp)
      el.tokBar.setAttribute("x", bar.x)
      el.tokBar.setAttribute("width", bar.w)
      el.tokBar.setAttribute("y", y - bar.h / 2)
      el.tokBar.setAttribute("height", bar.h)
    } else op(el.tokBar, 0)

    // 8 · every page: pull back from the app into its own frame on the board.
    // The app-only shot sits in the frame at the frame's page scale, so its
    // sidebar and rows line up with the live thumbnail as it dissolves away.
    const [fx, fy, fw, fh] = G.canvas.frame
    const cStart = { x: fx + fw / 2, y: fy + VH / 2 / (VW / fw), s: VW / fw }
    const cEnd = { x: 800, y: 500, s: s0 }
    const cam2 = clampCam(track(t, [
      { t: 26.95, ...cStart },
      { t: 29.9, ...cEnd },
      { t: 32.0, ...cEnd, s: s0 * 1.04, e: sine },
    ]))
    setCam(el.camCanvas, cam2)
    const canvasOn = t >= 26.5 && t < 32.0
    vis(el.camCanvas, canvasOn)
    op(el.camCanvas, prog(t, 26.5, 0.35, sine))
    const pe = prog(t, 26.95, 2.95, easeIO)
    op(el.flyClip, 1 - clamp((pe - 0.42) / 0.3, 0, 1))
    const blurFly = Math.sin(Math.PI * clamp((pe - 0.42) / 0.3, 0, 1))
    el.flyClip.style.filter = blurFly > 0.01 ? `blur(${1.5 * blurFly}px)` : "none"

    // 9 · notes
    const nIn = prog(t, 31.5, 0.34, sine)
    vis(el.camNotes, t >= 31.5)
    op(el.camNotes, nIn)
    const nz = Math.sin(Math.PI * nIn)
    el.camNotes.style.filter = el.camCanvas.style.filter = nz > 0.01 ? `blur(${1.8 * nz}px)` : "none"
    setCam(el.camNotes, clampCam(track(t, [{ t: 31.5, ...G.notes.cam[0] }, { t: 36.0, ...G.notes.cam[1], e: easeOut }])))
    el.pins.querySelectorAll("g").forEach((gEl, i) => {
      const start = 32.1 + i * 0.3
      for (const [cls, off] of [["r1", 0], ["r2", 0.7]]) {
        const c = gEl.querySelector("." + cls)
        const tt = t - start - off
        const q = tt < 0 ? 0 : (tt % 1.4) / 1.4
        const live = tt >= 0 && t < 35.8
        c.setAttribute("r", String(11 + 26 * easeOut(q)))
        c.setAttribute("opacity", live ? String(0.85 * (1 - q)) : "0")
      }
    })

    // 10 · agent
    const agOn = t >= 36.0 && t < 40.8
    vis(el.agent, agOn)
    op(el.agent, agOn ? 1 : 0)
    const agOut = prog(t, 40.4, 0.35, easeIO)
    const pL = prog(t, 36.15, 0.75), pT = prog(t, 36.25, 0.75)
    op(el.changesCard, pL * (1 - agOut))
    el.changesCard.style.transform = `translateY(${40 * (1 - pL) - 24 * agOut}px)`
    op(el.term, pT * (1 - agOut))
    el.term.style.transform = `translateY(${40 * (1 - pT) - 24 * agOut}px)`
    const down = prog(t, 36.9, 0.08, linear), up = prog(t, 36.98, 0.24)
    el.sendBtn.style.transform = `scale(${1 - 0.04 * down + 0.04 * up})`
    el.sendBtn.style.filter = `brightness(${1 + 0.25 * down * (1 - up)})`
    const ring = prog(t, 36.95, 0.7)
    op(el.sendRing, t >= 36.95 ? 0.85 * (1 - ring) : 0)
    el.sendRing.style.transform = `scale(${1 + 0.22 * ring})`
    if (agOn) renderTerm(Math.max(0, Math.floor((t - 37.15) * 900)), t)

    // 11 · code
    const codeOn = t >= 40.5 && t < 44.3
    vis(el.code, codeOn)
    op(el.code, codeOn ? 1 : 0)
    const cIn = prog(t, 40.6, 0.75), cOut = prog(t, 43.95, 0.3, easeIO)
    const card = el.code.firstElementChild
    op(card, cIn * (1 - cOut))
    card.style.transform = `translateY(${40 * (1 - cIn) - 24 * cOut}px)`
    if (codeOn && diffModel) {
      let di = 0, ai = 0
      el.codeBody.querySelectorAll(".cl").forEach((row) => {
        const kind = row.classList.contains("del") ? "del" : row.classList.contains("add") ? "add" : "ctx"
        if (kind === "ctx") return
        const at = kind === "del" ? 41.3 + 0.12 * di++ : 41.9 + 0.12 * ai++
        const p = prog(t, at, 0.5, easeIO)
        row.querySelector(".bg").style.transform = `scaleX(${p})`
        op(row.querySelector(".tx"), 0.35 + 0.65 * p)
        op(row.querySelector(".sg"), 0.35 + 0.65 * p)
        const hl = row.querySelector(".hl")
        if (hl) {
          const h = prog(t, kind === "del" ? 41.75 : 42.4, 0.4)
          const base = kind === "del" ? "248,81,73" : "46,160,67"
          hl.style.backgroundColor = `rgba(${base},${0.42 * h})`
          hl.style.color = h > 0.5 ? "#fff" : ""
        }
      })
      const sw = prog(t, 42.7, 0.9, easeIO)
      op(el.codeSweep, t > 42.7 && sw < 1 ? 1 : 0)
      el.codeSweep.style.transform = `translateX(${lerp(-260, 1560, sw)}px)`
    }

    // 12 · end card
    vis(el.end, t >= 44.2)
    const ic = prog(t, 44.35, 0.9)
    op(el.endIcon, ic)
    el.endIcon.style.transform = `translateY(${24 * (1 - ic)}px) scale(${0.92 + 0.08 * ic})`
    op(el.endGlow, 0.85 * ic)
    for (const [e, at] of [[el.endMark, 44.95], [el.endSub, 45.45], [el.endUrl, 45.8]]) {
      const p = prog(t, at, 0.8)
      op(e, p)
      e.style.transform = `translateY(${22 * (1 - p)}px)`
      e.style.filter = p < 1 ? `blur(${6 * (1 - p)}px)` : "none"
    }
    op(el.black, prog(t, 49.0, 1.0, sine))

    // keycaps
    const ki = KEYS.findIndex((k) => t >= k.at && t < k.out + 0.3)
    if (ki !== keyIdx) {
      keyIdx = ki
      el.keys.innerHTML = ki < 0 ? "" : KEYS[ki].keys.map((k) => `<div class="key">${k}</div>`).join("")
    }
    if (ki >= 0) {
      const k = KEYS[ki]
      ;[...el.keys.children].forEach((node, i) => {
        const d = i * 0.04
        const pin = prog(t, k.at + d, 0.4)
        const pout = prog(t, k.out, 0.28, sine)
        const dn = prog(t, k.press + d * 0.5, 0.08, linear)
        const r = clamp((t - k.release - d * 0.5) / 0.24, 0, 1)
        const over = r > 0 ? Math.sin(Math.PI * r) * 0.012 * (1 - r) : 0
        const sc = (0.94 + 0.06 * pin) * (1 - 0.04 * dn + 0.04 * easeOut(r) + over)
        op(node, pin * (1 - pout))
        node.style.transform = `translateY(${16 * (1 - pin) + 3 * dn * (1 - easeOut(r)) - 8 * pout}px) scale(${sc})`
        node.style.borderBottomWidth = dn > 0.5 && r < 0.5 ? "1px" : "2px"
      })
    }

    // captions
    const ci = CAPTIONS.findIndex((c) => t >= c[0] && t < c[1])
    if (ci !== capIdx) {
      capIdx = ci
      const c = CAPTIONS[ci]
      el.caption.innerHTML = c ? (c[3] ? `${esc(c[2])}&nbsp;<span class="m">${esc(c[3])}</span>` : esc(c[2])) : ""
    }
    if (ci >= 0) {
      const [a0, b0] = CAPTIONS[ci]
      const p = prog(t, a0, 0.6), q = prog(t, b0 - 0.3, 0.3, sine)
      op(el.caption, p * (1 - q))
      el.caption.style.transform = `translateY(${16 * (1 - p) - 6 * q}px)`
      el.caption.style.filter = p < 1 ? `blur(${6 * (1 - p)}px)` : "none"
    } else op(el.caption, 0)
  }

  window.DURATION = DURATION
  window.DEMO = DEMO
  window.seek = seek
  window.filmReady = init().then(() => true)
  window.filmReady.catch((e) => { window.filmError = String(e && e.stack || e) })
})()
