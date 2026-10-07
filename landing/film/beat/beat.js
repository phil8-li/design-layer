/*
 * The launch film, cut to the beat. ?cut=a|b|c picks an edit from cuts.js
 * and its soundtrack's cue map (cues/<cut>.json, written by music.mjs), so
 * every cut, word and hit lands on a beat of the music. Like ../film.js,
 * every pixel is a pure function of time: window.seek(t) sets each layer, so
 * render.mjs can step frames deterministically.
 */
import { CUTS } from "./cuts.js"

const params = new URLSearchParams(location.search)
const CUT_ID = params.get("cut") || "a"
const DEMO = params.get("demo") || "midday"
const SHOTS = "../../assets/shots/"

/* ---------- easing ---------- */
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
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
export const lerp = (a, b, p) => a + (b - a) * p
export const E = {
  out: bezier(0.23, 1, 0.32, 1),
  io: bezier(0.77, 0, 0.175, 1),
  soft: bezier(0.45, 0, 0.25, 1),
  in: bezier(0.55, 0, 1, 0.45),
  inCubic: (x) => clamp(x, 0, 1) ** 3,
  outCubic: (x) => 1 - (1 - clamp(x, 0, 1)) ** 3,
  outExpo: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp(x, 0, 1))),
  inExpo: (x) => (x <= 0 ? 0 : Math.pow(2, 10 * clamp(x, 0, 1) - 10)),
  outBack: (x, s = 1.9) => {
    x = clamp(x, 0, 1) - 1
    return x * x * ((s + 1) * x + s) + 1
  },
  linear: (x) => clamp(x, 0, 1),
  sine: (x) => -(Math.cos(Math.PI * clamp(x, 0, 1)) - 1) / 2,
  /** A spring from 0 to 1: overshoots, then settles. */
  spring: (x, f = 13, d = 5.5) => (x <= 0 ? 0 : x >= 1.6 ? 1 : 1 - Math.exp(-d * x) * Math.cos(f * x)),
}
export const prog = (t, a, d, e = E.out) => e(clamp((t - a) / d, 0, 1))

/* ---------- camera ---------- */
const VW = 1440, VH = 900
export const FIT = VW / 1600
function clampCam(c) {
  const hw = VW / 2 / c.s, hh = VH / 2 / c.s
  return { x: clamp(c.x, hw, 1600 - hw), y: clamp(c.y, hh, 1000 - hh), s: c.s }
}
/** keys: [[t, x, y, s, ease]] — ease shapes the segment ending at that key. Zoom moves in log space. */
function track(t, keys) {
  const k0 = keys[0]
  if (t <= k0[0]) return { x: k0[1], y: k0[2], s: k0[3] }
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i]
    if (t <= k[0]) {
      const a = keys[i - 1]
      const p = (k[4] || E.io)((t - a[0]) / (k[0] - a[0]))
      return { x: lerp(a[1], k[1], p), y: lerp(a[2], k[2], p), s: Math.exp(lerp(Math.log(a[3]), Math.log(k[3]), p)) }
    }
  }
  const z = keys[keys.length - 1]
  return { x: z[1], y: z[2], s: z[3] }
}
const camCss = (c) => `translate(${VW / 2 - c.x * c.s}px, ${VH / 2 - c.y * c.s}px) scale(${c.s})`

/* ---------- dom ---------- */
const $ = (id) => document.getElementById(id)
const el = {}
for (const id of ["film", "bg", "stage", "world", "win", "camMain", "stripL", "stripC", "stripR", "selRect", "tokBar", "pins", "selLabel", "ripple", "cursor",
  "camCanvas", "imgCanvas", "flyClip", "appFly", "planes", "planeL", "planeC", "planeR", "agent", "changesCard", "imgChanges", "sendBtn", "imgSend", "sendRing",
  "term", "termText", "code", "codeFile", "codeStat", "codeBody", "logo", "logoGlow", "logoIcon", "logoMark", "logoSub", "logoUrl", "type", "keys",
  "sweep", "flash", "grain", "barTop", "barBot", "black"]) el[id] = $(id)
const css = (e, prop, v) => {
  if (e.__s?.[prop] === v) return
  ;(e.__s ??= {})[prop] = v
  e.style[prop] = v
}
const op = (e, v) => css(e, "opacity", String(Math.round(clamp(v, 0, 1) * 1000) / 1000))
const vis = (e, on) => css(e, "visibility", on ? "visible" : "hidden")
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")

/* ---------- geometry (shot CSS px, 1600x1000) ---------- */
const GEO = {
  split: [0.175, 0.825],
  sel: [416, 246, 768, 120],
  inspector: [{ x: 1000, y: 470, s: 1.2 }, { x: 1000, y: 555, s: 1.2 }],
  measure: [{ x: 800, y: 479, s: 1.8 }, { x: 800, y: 481, s: 1.84 }],
  tokens: { cam: [{ x: 1055, y: 451, s: 1.32 }, { x: 1055, y: 456, s: 1.32 }], bar: { x: 1334, w: 252, h: 26, rows: [434, 406, 378, 350] } },
  canvas: { frame: [312, 158, 298, 286] },
  notes: { cam: { x: 1046, y: 310, s: 1.3 } },
  changes: { crop: [1322, 40, 278, 314] },
}
export let G = { ...GEO }

/* ---------- data: shots, detection, the handoff ---------- */
const SHOT_NAMES = ["app-only", "hero", "measure", "tokens", "canvas", "notes", "changes", "align", "light", "responsive", "shortcuts", "system", "audit", "options"]
const shotImg = {}
let sel = GEO.sel, termLines = [], termTotal = 0, diffModel = null

async function exists(url) {
  try {
    return (await fetch(url, { method: "HEAD", cache: "no-store" })).ok
  } catch {
    return false
  }
}
async function shotUrl(file) {
  const url = `${SHOTS}${DEMO}/${file}`
  if (await exists(url)) return url
  const webp = url.replace(/\.jpg$/, "-2400.webp")
  return (await exists(webp)) ? webp : null
}
function load(img, src) {
  img.src = src
  return img.decode().catch(() => new Promise((r) => { img.onload = r; img.onerror = r }))
}
const fetchJson = async (url) => {
  try {
    return await (await fetch(url, { cache: "no-store" })).json()
  } catch {
    return null
  }
}

function pixels(img, x0, y0, w, h) {
  const c = document.createElement("canvas")
  c.width = 1600
  c.height = 1000
  const g = c.getContext("2d", { willReadFrequently: true })
  g.drawImage(img, 0, 0, 1600, 1000)
  return g.getImageData(x0, y0, w, h).data
}
function detectSelection(img) {
  const x0 = Math.ceil(G.split[0] * 1600) + 4, x1 = Math.floor(G.split[1] * 1600) - 4, W = x1 - x0
  const d = pixels(img, x0, 40, W, 860)
  const rows = new Array(860).fill(0), cols = new Array(W).fill(0)
  let n = 0
  for (let y = 0; y < 860; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, r = d[i], gg = d[i + 1], b = d[i + 2]
    if (b > 215 && r > 85 && r < 165 && gg > 105 && gg < 180 && b - r > 70) { n++; rows[y]++; cols[x]++ }
  }
  if (n < 150) return null
  const edges = (arr) => {
    const max = Math.max(...arr), hit = arr.map((v, i) => (v > max * 0.8 ? i : -1)).filter((i) => i >= 0)
    return [hit[0], hit[hit.length - 1]]
  }
  const [ry0, ry1] = edges(rows), [cx0, cx1] = edges(cols)
  if (cx1 - cx0 < 30 || ry1 - ry0 < 10) return null
  return [cx0 + x0, ry0 + 40, cx1 - cx0 + 1, ry1 - ry0 + 1]
}
function detectButton(img) {
  const X0 = 1290, W = 310, d = pixels(img, X0, 40, W, 900)
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
function detectPins(img) {
  const X0 = Math.ceil(G.split[0] * 1600), W = Math.floor(G.split[1] * 1600) - X0, H = 900
  const d = pixels(img, X0, 0, W, H)
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
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      for (const k of [j - 1, j + 1, j - W, j + W]) if (k >= 0 && k < W * H && on[k] === 1 && Math.abs((k % W) - x) <= 1) { on[k] = 2; stack.push(k) }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1
    if (w >= 12 && w <= 26 && h >= 12 && h <= 26 && Math.abs(w - h) <= 5 && n / (w * h) > 0.55) pins.push([X0 + minX + w / 2, minY + h / 2])
  }
  return pins.sort((a, b) => a[1] - b[1])
}

const MAXC = 74
function tokenize(line) {
  const out = []
  const re = /("(?:[^"\\]|\\.)*"?)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)|([{}\[\],:])|(\s+)|(.)/g
  let m
  while ((m = re.exec(line))) {
    if (m[1] !== undefined) {
      out.push([m[2] ? "k" : "s", m[1]])
      if (m[2]) out.push(["p", m[2]])
    } else if (m[3] || m[4]) out.push(["n", m[3] || m[4]])
    else if (m[5]) out.push(["p", m[5]])
    else out.push(["", m[0]])
  }
  return out
}
function buildTerm(raw) {
  let res = raw && raw.result !== undefined ? raw.result : raw
  const text = res?.content?.[0]?.text
  if (typeof text === "string") {
    try { res = JSON.parse(text) } catch { res = text }
  }
  const lines = [{ cls: "c", text: "› wait_for_change" }]
  for (let l of JSON.stringify(res, null, 2).split("\n")) {
    if (l.length > MAXC) l = l.slice(0, MAXC - 1) + "…"
    lines.push({ json: true, text: l })
  }
  termLines = lines
  termTotal = lines.reduce((n, l) => n + l.text.length + 1, 0)
}
let lastTerm = -1
function renderTerm(chars, t) {
  const key = chars * 2 + (Math.floor(t * 2.2) % 2)
  if (key === lastTerm) return
  lastTerm = key
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
  html += `<span class="tcur" style="opacity:${blink ? 1 : 0}"></span>`
  el.termText.innerHTML = html
  el.termText.style.transform = `translateY(${-Math.max(0, shown - 20) * 25}px)`
}
function parseDiff(txt) {
  const L = txt.replace(/\r/g, "").split("\n")
  let file = "", i = 0
  for (; i < L.length; i++) {
    if (L[i].startsWith("+++ ")) file = L[i].replace(/^\+\+\+ (b\/)?/, "")
    if (L[i].startsWith("@@")) break
  }
  if (i >= L.length) return null
  const head = L[i], m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(head)
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
  const span = del && add ? wordSpan(del.tx, add.tx) : null
  const WIDTH = 104, longest = Math.max(...lines.map((l) => l.tx.length))
  const off = longest > WIDTH && span ? Math.max(0, Math.min(span[0] - 36, longest - WIDTH)) : 0
  const cut = (s) => {
    let r = s
    if (off) r = r.length > off ? "…" + r.slice(off + 1) : ""
    return r.length > WIDTH ? r.slice(0, WIDTH - 1) + "…" : r
  }
  const rows = []
  if (model.head) rows.push(`<div class="cl hunk"><span class="gut"></span><span class="sg"></span><span class="tx">${esc(model.head)}</span></div>`)
  for (const l of lines) {
    let inner = esc(cut(l.tx))
    if (span && (l === del || l === add)) {
      const s = l.tx, a = span[0], b = s.length - span[1]
      inner = esc(cut(s.slice(0, a) + "\u0000" + s.slice(a, b) + "\u0001" + s.slice(b))).replace("\u0000", '<span class="hl">').replace("\u0001", "</span>")
      if (!inner.includes("</span>") && inner.includes('<span class="hl">')) inner += "</span>"
    }
    const sg = l.k === "del" ? "−" : l.k === "add" ? "+" : ""
    rows.push(`<div class="cl ${l.k}"><span class="bg"></span><span class="gut">${l.n}</span><span class="sg">${sg}</span><span class="tx">${inner}</span></div>`)
  }
  el.codeBody.innerHTML = rows.join("")
}

/* ---------- kinetic type ---------- */
/**
 * A phrase: { text, at, out, style, x, y, size, weight, tracking, color,
 * gradient, align, split, stagger, din, dout, outStyle, pulse, z, rot }.
 * style: slam | mask | track | bounce | pop | rise | type
 */
class Phrase {
  constructor(spec, i) {
    this.s = { x: 960, y: 540, size: 200, weight: 700, tracking: -0.045, color: "#fafafa", align: "center", split: "word", stagger: 0.05, outStyle: "fade", ...spec }
    const s = this.s
    const node = document.createElement("div")
    node.className = "phrase"
    Object.assign(node.style, {
      fontSize: `${s.size}px`, fontWeight: String(s.weight), letterSpacing: `${s.tracking}em`, color: s.color,
      left: `${s.x}px`, top: `${s.y}px`, zIndex: String(s.z ?? i),
    })
    if (s.font) node.style.fontFamily = s.font
    if (s.shadow) node.style.textShadow = s.shadow
    const parts = s.split === "char" ? [...s.text] : s.split === "none" ? [s.text] : s.text.split(/(\s+)/).filter((p) => p !== "")
    this.units = []
    for (const p of parts) {
      if (/^\s+$/.test(p)) {
        node.append(p)
        continue
      }
      const u = document.createElement("span")
      u.className = "u"
      u.textContent = p
      if (s.mask || s.style === "mask") {
        const m = document.createElement("span")
        m.className = "m"
        m.append(u)
        node.append(m)
      } else node.append(u)
      this.units.push({ u, rnd: Math.sin((this.units.length + 1) * 12.9898 + i * 78.233) })
    }
    if (s.style === "type") this.caret = node.appendChild(Object.assign(document.createElement("span"), { className: "u", textContent: "▍" }))
    el.type.append(node)
    this.node = node
  }
  layout() {
    const s = this.s
    const w = this.node.offsetWidth
    this.w = w
    // one gradient across the whole phrase (each unit shows its slice), or on accent units only
    const paint = (u, g, width, x) => {
      u.style.backgroundImage = g
      u.style.backgroundSize = `${width}px 100%`
      u.style.backgroundPosition = `${-x}px 0`
      u.style.webkitBackgroundClip = "text"
      u.style.backgroundClip = "text"
      u.style.color = "transparent"
    }
    this.units.forEach(({ u }, i) => {
      if (s.accent?.includes(i)) paint(u, s.accentGradient, u.offsetWidth, 0)
      else if (s.gradient) paint(u, s.gradient, w, u.offsetLeft)
    })
    const tx = s.align === "left" ? "0" : s.align === "right" ? "-100%" : "-50%"
    this.base = `translate(${tx}, -50%)`
  }
  render(t, kick) {
    const s = this.s
    const din = s.din ?? { slam: 0.16, mask: 0.6, track: 1.3, bounce: 0.6, pop: 0.32, rise: 0.5, type: 0 }[s.style] ?? 0.4
    const dout = s.dout ?? { cut: 0, fade: 0.14, up: 0.4, blur: 0.3, pop: 0.2, down: 0.4 }[s.outStyle] ?? 0.2
    const n = this.units.length
    const last = s.at + (n - 1) * s.stagger
    const live = t >= s.at - 0.02 && t < s.out + dout + (s.outStyle === "cut" ? 0 : (n - 1) * (s.staggerOut ?? 0.03)) + 0.02
    vis(this.node, live)
    if (!live) return
    const pulse = s.pulse ? 1 + s.pulse * kick : 1
    let groupT = this.base
    if (s.drift) groupT += ` translateX(${s.drift * (t - s.at)}px)`
    if (s.zoom) groupT += ` scale(${1 + s.zoom * (t - s.at)})`
    groupT += ` scale(${pulse})`
    if (s.rot) groupT += ` rotate(${s.rot}deg)`
    css(this.node, "transform", groupT)
    if (s.style === "track") {
      const p = prog(t, s.at, din, E.outCubic)
      css(this.node, "letterSpacing", `${s.tracking + 0.55 * (1 - p)}em`)
    }
    if (s.style === "type") {
      const shown = Math.max(0, Math.floor((t - s.at) * (s.cps ?? 28)))
      this.units.forEach(({ u }, i) => css(u, "opacity", i < shown ? "1" : "0"))
      css(this.caret, "opacity", t < s.out && Math.floor(t * 2.4) % 2 === 0 ? "1" : shown < n ? "1" : "0")
      css(this.node, "opacity", t >= s.out ? String(1 - prog(t, s.out, dout || 0.2)) : "1")
      return
    }
    this.units.forEach(({ u, rnd }, i) => {
      const a = s.at + i * s.stagger
      const p = clamp((t - a) / din, 0, 1)
      const oStart = s.out + i * (s.staggerOut ?? 0.03)
      const q = s.outStyle === "cut" ? (t >= s.out ? 1 : 0) : dout ? clamp((t - oStart) / dout, 0, 1) : t >= oStart ? 1 : 0
      let tr = "", o = 1, blur = 0
      switch (s.style) {
        case "slam": {
          const e = E.outBack(p, 1.6)
          tr = `scale(${1.55 - 0.55 * e})`
          blur = 16 * (1 - E.outCubic(p))
          o = clamp(p * 4, 0, 1)
          break
        }
        case "mask":
          tr = `translateY(${(1 - E.outExpo(p)) * 115}%)`
          break
        case "track":
          o = E.outCubic(p)
          blur = 12 * (1 - E.outCubic(p))
          break
        case "bounce": {
          const sp = E.spring(p * 1.6)
          const squash = (1 - p) * 0.22 * Math.sin(p * 12)
          tr = `translateY(${-70 * (1 - E.outCubic(p))}px) scale(${sp * (1 + squash)}, ${sp * (1 - squash)}) rotate(${rnd * 14 * (1 - p)}deg)`
          o = clamp(p * 5, 0, 1)
          break
        }
        case "pop": {
          const sp = E.spring(p * 1.6, 16, 7)
          tr = `scale(${sp})`
          o = clamp(p * 6, 0, 1)
          break
        }
        default: // rise
          tr = `translateY(${36 * (1 - E.outCubic(p))}px)`
          o = E.outCubic(p)
          blur = 8 * (1 - E.outCubic(p))
      }
      if (t < a) o = 0
      if (q > 0) {
        switch (s.outStyle) {
          case "cut":
            o = 0
            break
          case "up":
            if (s.style === "mask") tr = `translateY(${-115 * E.inCubic(q)}%)`
            else {
              tr += ` translateY(${-40 * E.inCubic(q)}px)`
              o *= 1 - q
            }
            break
          case "down":
            tr = s.style === "mask" ? `translateY(${115 * E.inCubic(q)}%)` : tr + ` translateY(${40 * E.inCubic(q)}px)`
            if (s.style !== "mask") o *= 1 - q
            break
          case "blur":
            o *= 1 - q
            blur = Math.max(blur, 14 * q)
            break
          case "pop":
            tr += ` scale(${1 - E.inCubic(q)})`
            o *= q < 1 ? 1 : 0
            break
          default:
            o *= 1 - q
            tr += ` scale(${1 - 0.06 * q})`
        }
      }
      css(u, "transform", tr || "none")
      css(u, "opacity", String(Math.round(o * 1000) / 1000))
      css(u, "filter", blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none")
    })
  }
}

/* ---------- the cut ---------- */
let cut, cues, phrases = [], kicks = [], hits = [], grainTiles = []
let pinsLaid = [], button = null
const patches = []

const lastBefore = (arr, t) => {
  let lo = 0, hi = arr.length - 1, ans = -1
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    if (arr[m] <= t) { ans = m; lo = m + 1 } else hi = m - 1
  }
  return ans
}
const env = (arr, t, decay) => {
  const i = lastBefore(arr, t)
  return i < 0 ? 0 : Math.exp(-(t - arr[i]) / decay)
}

async function init() {
  cues = await fetchJson(`cues/${CUT_ID}.json`)
  if (!cues) throw new Error(`no cues for cut ${CUT_ID}; run music.mjs`)
  kicks = cues.kicks.slice().sort((a, b) => a - b)
  hits = cues.hits.slice().sort((a, b) => a - b)

  const demos = (await fetchJson(`${SHOTS}demos.json`)) || []
  const geom = demos.find((d) => d.slug === DEMO)?.geometry ?? {}
  if (geom.seams) G.split = [geom.seams.left, geom.seams.right]
  if (geom.focus) G.canvas = { frame: [geom.focus.x, geom.focus.y, geom.focus.w, geom.focus.h] }

  // one image per shot, under the camera, below the strips and overlays
  const jobs = []
  for (const name of SHOT_NAMES) {
    const url = await shotUrl(`${name}.jpg`)
    if (!url) continue
    const img = document.createElement("img")
    img.alt = ""
    el.camMain.insertBefore(img, el.stripL)
    shotImg[name] = img
    jobs.push(load(img, url))
    if (name === "hero") for (const id of ["stripL", "stripC", "stripR"]) jobs.push(load(el[id].querySelector("img"), url))
    if (name === "hero") for (const id of ["planeL", "planeC", "planeR"]) jobs.push(load(el[id].querySelector("img"), url))
    if (name === "app-only") jobs.push(load(el.appFly, url))
    if (name === "canvas") jobs.push(load(el.imgCanvas, url))
    if (name === "changes") {
      jobs.push(load(el.imgChanges, url))
      jobs.push(load(el.imgSend, url))
    }
  }
  jobs.push(load(el.logoIcon, el.logoIcon.src))
  await Promise.all(jobs)

  // strips and planes: complementary clips of the hero shot
  const [a, b] = G.split
  el.stripL.style.clipPath = el.planeL.style.clipPath = `inset(0 ${(1 - a) * 100}% 0 0 round 10px)`
  el.stripC.style.clipPath = el.planeC.style.clipPath = `inset(0 ${(1 - b) * 100}% 0 ${a * 100}%)`
  el.stripR.style.clipPath = el.planeR.style.clipPath = `inset(0 0 0 ${b * 100}% round 10px)`

  // the board's Current frame holds the app-only shot at the frame's page scale
  {
    const [fx, fy, fw, fh] = G.canvas.frame, k = fh / 1000
    Object.assign(el.flyClip.style, { left: `${fx}px`, top: `${fy}px`, width: `${fw}px`, height: `${fh}px` })
    Object.assign(el.appFly.style, { width: `${1600 * k}px`, height: `${1000 * k}px` })
  }

  sel = (shotImg.hero && detectSelection(shotImg.hero)) || GEO.sel
  el.selRect.setAttribute("x", sel[0] - 3)
  el.selRect.setAttribute("y", sel[1] - 3)
  el.selRect.setAttribute("width", sel[2] + 6)
  el.selRect.setAttribute("height", sel[3] + 6)
  el.selLabel.textContent = `${Math.round(sel[2])} × ${Math.round(sel[3])}`
  el.selLabel.style.left = `${sel[0] + sel[2] / 2}px`
  el.selLabel.style.top = `${sel[1] + sel[3] + 10}px`

  // mask strips over the baked selection, cut from the notes shot
  if (shotImg.notes) {
    const [x, y, w, h] = sel
    for (const [px, py, pw, ph] of [[x - 10, y - 8, w + 20, 18], [x - 10, y + h - 10, w + 20, 18], [x - 10, y - 8, 20, h + 16], [x + w - 10, y - 8, 20, h + 16]]) {
      const d = document.createElement("div")
      Object.assign(d.style, {
        position: "absolute", left: `${px}px`, top: `${py}px`, width: `${pw}px`, height: `${ph}px`, opacity: "0",
        backgroundImage: `url("${shotImg.notes.src}")`, backgroundSize: "1600px 1000px", backgroundPosition: `${-px}px ${-py}px`,
      })
      d.className = "patch"
      el.camMain.insertBefore(d, el.camMain.querySelector("svg"))
      patches.push(d)
    }
  }

  // the handoff cards
  if (shotImg.changes) {
    button = detectButton(shotImg.changes)
    if (button) G.changes = { crop: [G.changes.crop[0], G.changes.crop[1], G.changes.crop[2], button[1] + button[3] + 14 - G.changes.crop[1]] }
    const [cx, cy, cw, ch] = G.changes.crop
    const k = Math.min(596 / cw, 624 / ch)
    const cardW = Math.round(cw * k), cardH = Math.round(ch * k)
    const left0 = Math.round((1920 - (cardW + 40 + 900)) / 2)
    Object.assign(el.changesCard.style, { width: `${cardW}px`, height: `${Math.min(624, cardH)}px`, left: `${left0}px`, top: `${186 + (624 - Math.min(624, cardH)) / 2}px` })
    el.term.style.left = `${left0 + cardW + 40}px`
    Object.assign(el.imgChanges.style, { width: `${1600 * k}px`, height: `${1000 * k}px`, left: `${-cx * k}px`, top: `${-cy * k}px` })
    if (button) {
      const [bx, by, bw, bh] = button
      const l = (bx - cx) * k, tp = (by - cy) * k
      Object.assign(el.sendBtn.style, { left: `${l}px`, top: `${tp}px`, width: `${bw * k}px`, height: `${bh * k}px` })
      Object.assign(el.imgSend.style, { width: `${1600 * k}px`, height: `${1000 * k}px`, left: `${-bx * k}px`, top: `${-by * k}px` })
      Object.assign(el.sendRing.style, { left: `${l - 6}px`, top: `${tp - 6}px`, width: `${bw * k + 12}px`, height: `${bh * k + 12}px` })
    } else vis(el.sendBtn, false)
  }
  if (shotImg.notes) pinsLaid = detectPins(shotImg.notes)
  el.pins.innerHTML = pinsLaid.map(([x, y]) => `<g><circle class="r1" cx="${x}" cy="${y}" r="11" fill="none" stroke="#798cff" stroke-width="2.5" vector-effect="non-scaling-stroke" opacity="0"/><circle class="r2" cx="${x}" cy="${y}" r="11" fill="none" stroke="#798cff" stroke-width="2.5" vector-effect="non-scaling-stroke" opacity="0"/></g>`).join("")

  const agent = await fetchJson(`${SHOTS}${DEMO}/agent.json`)
  buildTerm(agent || { result: { note: "agent.json missing" } })
  try {
    const model = parseDiff(await (await fetch(`${SHOTS}${DEMO}/diff.txt`, { cache: "no-store" })).text())
    if (model) buildDiff(model)
  } catch {}

  // film grain: a few tiles of noise, swapped 24 times a second
  for (let k = 0; k < 6; k++) {
    const c = document.createElement("canvas")
    c.width = c.height = 256
    const g = c.getContext("2d")
    const img = g.createImageData(256, 256)
    let seed = 1234 + k * 977
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 16807) % 2147483647
      const v = (seed % 256)
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
    g.putImageData(img, 0, 0)
    grainTiles.push(`url(${c.toDataURL()})`)
  }

  cues.snares = (cues.snares || []).slice().sort((a, b) => a - b)
  cut = CUTS[CUT_ID]({ m: cues.marks, cues, sel, G, FIT, E, pins: pinsLaid, button, hit: (arr, t, d) => env(arr, t, d) })
  for (const [i, p] of (cut.type || []).entries()) phrases.push(new Phrase(p, i))
  await document.fonts.load('700 100px "InterFilm"')
  await document.fonts.ready
  for (const p of phrases) p.layout()

  // background blobs
  for (const [i, b] of (cut.look.blobs || []).entries()) {
    const d = document.createElement("div")
    d.className = "blob"
    Object.assign(d.style, { width: `${b.r * 2}px`, height: `${b.r * 2}px`, background: b.color })
    d.dataset.i = i
    el.bg.append(d)
  }
  el.film.style.background = cut.look.bg || "#050506"
  if (cut.look.logoGlow) el.logoGlow.style.background = cut.look.logoGlow
  window.DURATION = cut.duration ?? cues.duration
  seek(0)
}

/* ---------- per-frame state ---------- */
function fresh() {
  return {
    win: { op: 0, s: 1, x: 0, y: 0, rx: 0, ry: 0, rz: 0, blur: 0, bright: 1 },
    shots: {}, cam: { x: 800, y: 500, s: FIT }, strips: null, camFilter: 0,
    sel: { draw: 0, label: 0 }, tok: { op: 0, y: 0 }, pins: null, cursor: null, ripple: null,
    canvas: null, planes: null, agent: null, code: null, logo: null,
  }
}

const SCENES = {
  black() {},

  /** A screenshot in the window under a moving camera. */
  shot(sc, t, c) {
    c.win.op = 1
    c.shots[sc.name] = 1
    if (sc.cam) c.cam = clampCam(track(t, sc.cam))
  },

  /** The editor arrives around the app: the panels slide in from the sides. */
  open(sc, t, c) {
    c.win.op = 1
    const at = sc.at, d = sc.dur ?? 0.5
    if (t < at) c.shots["app-only"] = 1
    else if (t < at + d + 0.05) {
      c.shots["app-only"] = 1
      c.strips = { pl: prog(t, at, d, sc.ease || E.out), pr: prog(t, at + 0.04, d, sc.ease || E.out), pc: prog(t, at + d * 0.25, d * 0.5, E.sine) }
    } else c.shots.hero = 1
    if (sc.cam) c.cam = clampCam(track(t, sc.cam))
  },

  /** Pull back from the app into its frame on the board. */
  canvas(sc, t, c) {
    c.win.op = 1
    const [fx, fy, fw, fh] = G.canvas.frame
    const start = { x: fx + fw / 2, y: fy + VH / 2 / (VW / fw), s: VW / fw }
    const end = { x: 800, y: 500, s: FIT }
    const cam = clampCam(track(t, [[sc.from, start.x, start.y, start.s], [sc.from + (sc.zoom ?? 1.2), end.x, end.y, end.s, sc.ease || E.io], [sc.to, end.x, end.y, end.s * (sc.drift ?? 1.03), E.linear]]))
    const pe = prog(t, sc.from, sc.zoom ?? 1.2, E.io)
    c.canvas = { cam, fly: 1 - clamp((pe - 0.4) / 0.3, 0, 1), blur: Math.sin(Math.PI * clamp((pe - 0.4) / 0.3, 0, 1)) }
  },

  /** Changes card, the Send press, and the agent's brief streaming in. */
  agent(sc, t, c) {
    c.agent = {
      pL: prog(t, sc.from, sc.inDur ?? 0.35, sc.inEase || E.out), pT: prog(t, sc.from + (sc.lag ?? 0.06), sc.inDur ?? 0.35, sc.inEase || E.out),
      press: sc.press, chars: Math.max(0, Math.floor((t - (sc.stream ?? sc.press + 0.15)) * (sc.cps ?? 900))), out: sc.out ? prog(t, sc.out, 0.25, E.io) : 0, t, bounce: sc.bounce,
    }
  },

  code(sc, t, c) {
    c.code = { p: prog(t, sc.from, sc.inDur ?? 0.35, sc.inEase || E.out), steps: sc.steps, t, out: sc.out ? prog(t, sc.out, 0.25, E.io) : 0, bounce: sc.bounce }
  },

  /** The editor as three floating planes that turn and lock into one. */
  planes(sc, t, c) {
    const lockP = prog(t, sc.lock, sc.lockDur ?? 0.5, sc.lockEase || E.io)
    const appear = prog(t, sc.appearAt ?? sc.from, sc.appear ?? 1.2, E.out)
    const turn = (t - sc.from) / (sc.to - sc.from)
    c.planes = {
      x: lerp(sc.x ?? 0, 0, lockP),
      op: appear * (t < sc.lock + (sc.lockDur ?? 0.5) ? 1 : 0),
      rx: lerp(sc.rx ?? 22, 0, lockP) + (1 - lockP) * (sc.rxDrift ?? -4) * turn,
      ry: lerp(sc.ry ?? -28, 0, lockP) + (1 - lockP) * (sc.ryDrift ?? 14) * turn,
      rz: lerp(sc.rz ?? 4, 0, lockP),
      z: (1 - lockP) * (sc.spread ?? 1) * (1 - 0.25 * turn),
      s: lerp(sc.scale ?? 0.8, 1, lockP),
    }
    if (t >= sc.lock + (sc.lockDur ?? 0.5)) {
      c.win.op = 1
      c.shots.hero = 1
    } else if (t >= sc.lock + (sc.lockDur ?? 0.5) * 0.85) {
      c.win.op = prog(t, sc.lock + (sc.lockDur ?? 0.5) * 0.85, (sc.lockDur ?? 0.5) * 0.15, E.linear)
      c.shots.hero = 1
    }
    if (sc.cam) c.cam = clampCam(track(t, sc.cam))
  },

  /** Rapid cuts between shots, each held until the next. */
  montage(sc, t, c) {
    c.win.op = 1
    let cur = sc.items[0]
    for (const it of sc.items) if (t >= it.at) cur = it
    c.shots[cur.name] = 1
    const cam = cur.cam || { x: 800, y: 500, s: FIT }
    const k = sc.push ?? 0.06
    const p = clamp((t - cur.at) / 0.6, 0, 1)
    c.cam = clampCam({ x: cam.x, y: cam.y, s: cam.s * (1 + k * E.outCubic(p)) })
  },

  logo(sc, t, c) {
    c.logo = { ...sc, t }
  },
}

/** What any scene can carry over its shot: a selection, the token bar, pin ripples, the pointer, the mask. */
function extras(sc, t, c) {
  if (sc.select) {
    const s = sc.select
    c.sel.draw = prog(t, s.at, s.dur ?? 0.25, E.io)
    c.sel.label = prog(t, s.at + (s.dur ?? 0.25) * 0.6, 0.3)
    c.sel.labelStyle = s.label
  }
  if (sc.tok) {
    const bar = G.tokens.bar
    let y = bar.rows[0]
    sc.tok.steps.forEach((st, i) => { if (i < bar.rows.length - 1) y = lerp(y, bar.rows[i + 1], prog(t, st, sc.tok.stepDur ?? 0.22, E.io)) })
    c.tok = { op: Math.min(prog(t, sc.tok.in, 0.2), 1 - prog(t, sc.tok.out, 0.25)), y }
  }
  if (sc.pins) c.pins = sc.pins
  if (sc.cursor) c.cursor = sc.cursor
  // the hero shot has the headline selected already; strips cut from the notes
  // shot (same page, nothing selected) hide that outline until the click
  if (sc.mask && (sc.mask === true || (t >= sc.mask[0] && t < sc.mask[1]))) c.mask = true
}

/* ---------- applying a frame ---------- */
function applyFrame(c, t) {
  const L = cut.look

  // window and planes share one transform (so the planes lock onto the window)
  const w = c.win
  const ws = (L.winScale ?? 0.9) * w.s
  const wy = (L.winY ?? 0) + w.y
  const wt = `translate(${w.x}px, ${wy}px) scale(${ws}) rotateX(${w.rx}deg) rotateY(${w.ry}deg) rotateZ(${w.rz}deg)`
  vis(el.win, w.op > 0.001)
  op(el.win, w.op)
  css(el.win, "transform", wt)
  css(el.win, "filter", w.blur > 0.05 || w.bright !== 1 ? `blur(${w.blur.toFixed(2)}px) brightness(${w.bright.toFixed(3)})` : "none")

  // shots
  for (const [name, img] of Object.entries(shotImg)) {
    const v = c.shots[name] || 0
    op(img, v)
    vis(img, v > 0.001)
  }
  css(el.camMain, "transform", camCss(c.cam))
  css(el.camMain, "filter", c.camFilter > 0.05 ? `blur(${c.camFilter.toFixed(2)}px)` : "none")

  // strips (the editor arriving)
  const st = c.strips
  for (const id of ["stripL", "stripC", "stripR"]) vis(el[id], !!st)
  if (st) {
    const [a, b] = G.split
    css(el.stripL, "transform", `translateX(${-a * 1600 * (1 - st.pl)}px)`)
    css(el.stripR, "transform", `translateX(${(1 - b) * 1600 * (1 - st.pr)}px)`)
    op(el.stripC, st.pc)
    const mb = Math.sin(Math.PI * st.pc)
    css(el.stripC, "filter", mb > 0.01 ? `blur(${3 * mb}px)` : "none")
  }

  // the mask over the baked selection follows the hero shot in (it fades with the centre strip)
  const maskOp = c.mask ? (c.strips ? c.strips.pc : c.shots.hero ?? 0) : 0
  for (const p of patches) op(p, maskOp)

  // selection
  const per = 2 * (sel[2] + sel[3] + 12)
  el.selRect.setAttribute("stroke-dasharray", `${per}`)
  el.selRect.setAttribute("stroke-dashoffset", `${per * (1 - c.sel.draw)}`)
  el.selRect.setAttribute("opacity", c.sel.draw > 0 ? "1" : "0")
  el.selRect.style.filter = "drop-shadow(0 0 6px rgba(121,140,255,0.7))"
  op(el.selLabel, c.sel.label)
  const lb = c.sel.labelStyle === "pop" ? E.spring(c.sel.label * 1.6, 16, 7) : 0.9 + 0.1 * c.sel.label
  css(el.selLabel, "transform", `translate(-50%, ${6 * (1 - c.sel.label)}px) scale(${(1 / c.cam.s) * 1.3 * lb})`)

  // token bar
  const bar = G.tokens.bar
  el.tokBar.setAttribute("opacity", String(clamp(c.tok.op, 0, 1)))
  el.tokBar.setAttribute("x", bar.x)
  el.tokBar.setAttribute("width", bar.w)
  el.tokBar.setAttribute("y", c.tok.y - bar.h / 2)
  el.tokBar.setAttribute("height", bar.h)

  // pin ripples
  el.pins.querySelectorAll("g").forEach((g, i) => {
    const pn = c.pins
    const at = pn?.times?.[i]
    for (const [cls, off] of [["r1", 0], ["r2", 0.16]]) {
      const circle = g.querySelector("." + cls)
      if (at == null || t < at + off) {
        circle.setAttribute("opacity", "0")
        continue
      }
      const q = clamp((t - at - off) / (pn.dur ?? 0.7), 0, 1)
      circle.setAttribute("r", String(11 + (pn.size ?? 30) * E.outCubic(q)))
      circle.setAttribute("opacity", String(0.9 * (1 - q)))
    }
  })

  // cursor and click ripple (shot space, counter-scaled to a constant size)
  const cu = c.cursor
  if (cu && t >= cu.path[0][0] - 0.2 && t <= cu.path[cu.path.length - 1][0] + (cu.hold ?? 0.6)) {
    const pos = track(t, cu.path.map(([tt, x, y]) => [tt, x, y, 1, E.io]))
    const fadeIn = prog(t, cu.path[0][0] - 0.2, 0.2), fadeOut = 1 - prog(t, cu.path[cu.path.length - 1][0] + (cu.hold ?? 0.6) - 0.2, 0.2)
    let press = 0, rip = null
    for (const ck of cu.clicks || []) {
      press = Math.max(press, Math.max(0, 1 - Math.abs(t - ck) / 0.09))
      if (t >= ck && t < ck + 0.5) rip = { q: (t - ck) / 0.5 }
    }
    const k = (1 / c.cam.s) * 1.1
    op(el.cursor, fadeIn * fadeOut)
    css(el.cursor, "transform", `translate(${pos.x - 3}px, ${pos.y - 3}px) scale(${k * (1 - 0.14 * press)})`)
    if (rip) {
      op(el.ripple, 0.9 * (1 - rip.q))
      css(el.ripple, "transform", `translate(${pos.x}px, ${pos.y}px) scale(${k * (0.4 + 1.4 * E.outCubic(rip.q))})`)
    } else op(el.ripple, 0)
  } else {
    op(el.cursor, 0)
    op(el.ripple, 0)
  }

  // canvas
  vis(el.camCanvas, !!c.canvas)
  if (c.canvas) {
    css(el.camCanvas, "transform", camCss(c.canvas.cam))
    op(el.flyClip, c.canvas.fly)
    css(el.flyClip, "filter", c.canvas.blur > 0.01 ? `blur(${1.5 * c.canvas.blur}px)` : "none")
  }

  // planes
  const P = c.planes
  vis(el.planes, !!P && P.op > 0.001)
  if (P) {
    css(el.planes, "transform", `translate(${w.x + P.x}px, ${wy}px) scale(${(L.winScale ?? 0.9) * P.s}) rotateX(${P.rx}deg) rotateY(${P.ry}deg) rotateZ(${P.rz}deg)`)
    const z = P.z
    op(el.planeC, P.op)
    op(el.planeL, P.op)
    op(el.planeR, P.op)
    css(el.planeC, "transform", `translateZ(${-140 * z}px)`)
    css(el.planeL, "transform", `translateZ(${120 * z}px) translateX(${-60 * z}px)`)
    css(el.planeR, "transform", `translateZ(${160 * z}px) translateX(${60 * z}px)`)
  }

  // the handoff
  const A = c.agent
  vis(el.agent, !!A)
  op(el.agent, A ? 1 : 0)
  if (A) {
    const lift = (p) => (A.bounce ? `translateY(${80 * (1 - E.spring(p * 1.6, 14, 6))}px) scale(${0.9 + 0.1 * E.spring(p * 1.6, 14, 6)})` : `translateY(${50 * (1 - p)}px)`)
    op(el.changesCard, A.pL * (1 - A.out))
    css(el.changesCard, "transform", lift(A.pL) + ` translateY(${-24 * A.out}px)`)
    op(el.term, A.pT * (1 - A.out))
    css(el.term, "transform", lift(A.pT) + ` translateY(${-24 * A.out}px)`)
    const down = prog(t, A.press - 0.05, 0.06, E.linear), up = prog(t, A.press + 0.03, 0.22)
    css(el.sendBtn, "transform", `scale(${1 - 0.06 * down + 0.06 * up})`)
    css(el.sendBtn, "filter", `brightness(${1 + 0.3 * down * (1 - up)})`)
    const ring = prog(t, A.press, 0.6)
    op(el.sendRing, t >= A.press ? 0.9 * (1 - ring) : 0)
    css(el.sendRing, "transform", `scale(${1 + 0.25 * ring})`)
    renderTerm(Math.min(termTotal, A.chars), t)
  }
  const C = c.code
  vis(el.code, !!C)
  op(el.code, C ? 1 : 0)
  if (C && diffModel) {
    const card = el.code.firstElementChild
    const pp = C.bounce ? E.spring(C.p * 1.6, 14, 6) : C.p
    op(card, Math.min(1, C.p * 2) * (1 - C.out))
    css(card, "transform", `translateY(${60 * (1 - pp) - 24 * C.out}px) scale(${0.94 + 0.06 * pp})`)
    let di = 0, ai = 0
    el.codeBody.querySelectorAll(".cl").forEach((row) => {
      const kind = row.classList.contains("del") ? "del" : row.classList.contains("add") ? "add" : "ctx"
      if (kind === "ctx") return
      const at = kind === "del" ? C.steps[0] + 0.06 * di++ : C.steps[1] + 0.06 * ai++
      const p = prog(t, at, 0.3, E.io)
      css(row.querySelector(".bg"), "transform", `scaleX(${p})`)
      op(row.querySelector(".tx"), 0.35 + 0.65 * p)
      const hl = row.querySelector(".hl")
      if (hl) {
        const h = prog(t, at + 0.2, 0.25)
        hl.style.backgroundColor = `rgba(${kind === "del" ? "248,81,73" : "46,160,67"},${0.45 * h})`
        hl.style.color = h > 0.5 ? "#fff" : ""
      }
    })
  }

  // logo
  const Lg = c.logo
  vis(el.logo, !!Lg)
  op(el.logo, Lg ? 1 : 0)
  if (Lg) {
    const tt = Lg.t
    const st = Lg.style || "slam"
    const ic = prog(tt, Lg.icon, st === "reveal" ? 1.1 : 0.4, st === "slam" ? (x) => E.outBack(x, 1.5) : E.out)
    op(el.logoIcon, Math.min(1, ic * 3))
    if (st === "bounce") css(el.logoIcon, "transform", `translateY(${-60 * (1 - E.outCubic(ic))}px) scale(${E.spring(ic * 1.6, 12, 5)})`)
    else if (st === "reveal") css(el.logoIcon, "transform", `translateY(${30 * (1 - ic)}px) scale(${0.9 + 0.1 * ic})`)
    else css(el.logoIcon, "transform", `scale(${1.6 - 0.6 * ic})`)
    css(el.logoIcon, "filter", `drop-shadow(0 18px 50px rgba(74, 93, 249, 0.45)) blur(${st === "slam" ? 14 * (1 - E.outCubic(ic)) : 0}px)`)
    op(el.logoGlow, 0.9 * ic)
    const mk = prog(tt, Lg.mark, st === "reveal" ? 1.2 : 0.35, st === "slam" ? (x) => E.outBack(x, 1.4) : E.outCubic)
    op(el.logoMark, Math.min(1, mk * 3))
    if (st === "reveal") {
      css(el.logoMark, "letterSpacing", `${-0.045 + 0.4 * (1 - mk)}em`)
      css(el.logoMark, "filter", `blur(${10 * (1 - mk)}px)`)
      css(el.logoMark, "transform", "none")
    } else if (st === "bounce") css(el.logoMark, "transform", `scale(${E.spring(mk * 1.6, 13, 5.5)})`)
    else {
      css(el.logoMark, "transform", `scale(${1.4 - 0.4 * mk})`)
      css(el.logoMark, "filter", `blur(${12 * (1 - E.outCubic(mk))}px)`)
    }
    for (const [node, at] of [[el.logoSub, Lg.sub], [el.logoUrl, Lg.url]]) {
      const p = prog(tt, at, 0.6)
      op(node, p)
      css(node, "transform", `translateY(${24 * (1 - p)}px)`)
      css(node, "filter", p < 1 ? `blur(${6 * (1 - p)}px)` : "none")
    }
  }
}

function applyFx(t) {
  const L = cut.look, F = cut.fx || {}
  const kick = env(kicks, t, L.punchDecay ?? 0.1)

  // background: blobs drift slowly and breathe with the kick
  el.bg.querySelectorAll(".blob").forEach((d) => {
    const b = L.blobs[d.dataset.i]
    const x = b.x + Math.sin(t * (b.speed ?? 0.3) + b.phase) * (b.wander ?? 120)
    const y = b.y + Math.cos(t * (b.speed ?? 0.3) * 0.8 + b.phase) * (b.wander ?? 120) * 0.6
    css(d, "transform", `translate(${x - b.r}px, ${y - b.r}px) scale(${1 + (b.kick ?? 0.06) * kick})`)
    const show = b.when ? b.when(t) : 1
    op(d, (b.op ?? 0.5) * show * (1 + (b.kickOp ?? 0.3) * kick))
  })

  // stage: a punch on every kick, a shake on the hits
  const at = (h) => (typeof h === "number" ? h : h.t)
  let shake = [0, 0]
  for (const hh of F.shakes ?? hits) {
    const h = at(hh)
    if (t < h || t > h + 0.5) continue
    const a = (typeof hh === "number" ? L.shake ?? 8 : hh.a) * Math.exp(-(t - h) / 0.12)
    shake = [shake[0] + a * Math.sin(t * 91 + h), shake[1] + a * Math.cos(t * 77 + h * 3)]
  }
  const punch = 1 + (L.punch ?? 0.012) * kick
  css(el.stage, "transform", `translate(${shake[0].toFixed(2)}px, ${shake[1].toFixed(2)}px) scale(${punch.toFixed(4)})`)

  // whips: content slides out one way with motion blur, and in from the other
  let wx = 0, wb = 0, ws = 1
  for (const wp of F.whips ?? []) {
    const half = wp.half ?? 0.12
    const s = (t - wp.t) / half
    if (s < -1 || s > 1) continue
    const dir = wp.dir ?? 1
    if (wp.kind === "zoom") {
      ws *= s < 0 ? 1 + 0.35 * E.inCubic(1 + s) : 1 + 0.25 * (1 - E.outCubic(s))
    } else wx += s < 0 ? -dir * 260 * E.inCubic(1 + s) : dir * 260 * (1 - E.outCubic(s))
    wb = Math.max(wb, 26 * (1 - Math.abs(s)) ** 2)
  }
  css(el.world, "transform", wx || ws !== 1 ? `translateX(${wx.toFixed(1)}px) scale(${ws.toFixed(4)})` : "none")
  css(el.world, "filter", wb > 0.1 ? `blur(${wb.toFixed(2)}px)` : "none")

  // flashes on the hits
  let fl = 0
  for (const hh of F.flashes ?? hits) {
    const h = at(hh)
    if (t >= h) fl = Math.max(fl, (typeof hh === "number" ? L.flash ?? 0.55 : hh.a) * Math.exp(-(t - h) / 0.09))
  }
  op(el.flash, fl)
  if (L.flashColor) css(el.flash, "background", L.flashColor)

  // light sweep across the frame
  let sw = 0, swx = 0
  for (const s of F.sweeps ?? []) {
    const p = (t - s.t) / (s.dur ?? 0.9)
    if (p < 0 || p > 1) continue
    sw = Math.sin(Math.PI * p)
    swx = lerp(-60, 160, E.soft(p))
  }
  op(el.sweep, sw * (L.sweep ?? 0.5))
  css(el.sweep, "background", `linear-gradient(105deg, transparent ${swx - 18}%, rgba(255,255,255,0.0) ${swx - 12}%, rgba(200,210,255,0.55) ${swx}%, rgba(255,255,255,0) ${swx + 12}%, transparent ${swx + 18}%)`)

  // grain, letterbox, fade
  const gr = L.grain ?? 0
  op(el.grain, gr)
  if (gr) {
    const f = Math.floor(t * 24)
    css(el.grain, "backgroundImage", grainTiles[f % grainTiles.length])
    css(el.grain, "backgroundPosition", `${(f * 37) % 64}px ${(f * 53) % 64}px`)
  }
  const lb = typeof L.letterbox === "function" ? L.letterbox(t) : L.letterbox ?? 0
  css(el.barTop, "height", lb > 0.5 ? `${lb + 40}px` : "0px")
  css(el.barBot, "height", lb > 0.5 ? `${lb + 40}px` : "0px")
  const end = cut.fadeOut ?? [window.DURATION - 1.2, 1.2]
  op(el.black, Math.max(prog(t, end[0], end[1], E.sine), F.blackouts ? F.blackouts.reduce((m, [a, b]) => (t >= a && t < b ? 1 : m), 0) : 0))
  return kick
}

/* ---------- keycaps ---------- */
let keyIdx = -2
function renderKeys(t) {
  const keys = cut.keys || []
  const ki = keys.findIndex((k) => t >= k.at && t < k.out + 0.3)
  if (ki !== keyIdx) {
    keyIdx = ki
    el.keys.innerHTML = ki < 0 ? "" : keys[ki].keys.map((k) => `<div class="key">${esc(k)}</div>`).join("")
    if (ki >= 0) css(el.keys, "top", `${keys[ki].y ?? 760}px`)
  }
  if (ki < 0) return
  const k = keys[ki]
  ;[...el.keys.children].forEach((node, i) => {
    const d = i * 0.04
    const pin = k.bounce ? E.spring(prog(t, k.at + d, 0.5, E.linear) * 1.6, 13, 6) : prog(t, k.at + d, 0.3)
    const pout = prog(t, k.out, 0.2, E.sine)
    const dn = prog(t, k.press + d * 0.5, 0.06, E.linear)
    const r = clamp((t - k.release - d * 0.5) / 0.2, 0, 1)
    const sc = (0.92 + 0.08 * pin) * (1 - 0.05 * dn + 0.05 * E.outCubic(r))
    op(node, Math.min(1, pin * 2) * (1 - pout))
    css(node, "transform", `translateY(${30 * (1 - Math.min(1, pin)) + 4 * dn * (1 - E.outCubic(r)) - 10 * pout}px) scale(${sc})`)
    css(node, "borderBottomWidth", dn > 0.5 && r < 0.5 ? "1px" : "3px")
  })
}

/* ---------- seek ---------- */
function seek(t) {
  t = clamp(t, 0, window.DURATION)
  const c = fresh()
  for (const sc of cut.scenes) {
    if (t < sc.from || t >= sc.to) continue
    SCENES[sc.type](sc, t, c)
    extras(sc, t, c)
    if (sc.win) {
      const w = typeof sc.win === "function" ? sc.win(t) : sc.win
      Object.assign(c.win, w)
    }
  }
  applyFrame(c, t)
  const kick = applyFx(t)
  for (const p of phrases) p.render(t, kick)
  renderKeys(t)
}

window.DURATION = 40
window.CUT = CUT_ID
window.seek = seek
window.filmReady = init().then(() => true)
window.filmReady.catch((e) => { window.filmError = String(e && e.stack || e) })
