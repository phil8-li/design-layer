/*
 * Promo cuts of the launch film: real editing sessions (the explainer's in
 * story/, and the Get started restyle), dressed for marketing with kinetic type,
 * motion graphics, light and depth (cuts.js: g h i, cuts-cta.js: j k l,
 * cuts-tune.js: m n o, cuts-r6-<id>.js on cuts-r6.js: p q r s t). The app is
 * still only ever real captured frames; what is added is drawn around it.
 * Like ../film.js, window.seek(t) is a pure function of time, so render.mjs can
 * step it frame by frame.
 */
import { CUTS as ROUND3 } from "./cuts.js"
import { CUTS as ROUND4 } from "./cuts-cta.js"
import { CUTS as ROUND5 } from "./cuts-tune.js"

const params = new URLSearchParams(location.search)
const CUT_ID = params.get("cut") || "g"
// round 6's cuts (cuts-r6-<id>.js, on cuts-r6.js) each load on their own, so a
// file mid-edit cannot break the others
const ROUND6 = ["p", "q", "r", "s", "t"]
const CUTS = ROUND6.includes(CUT_ID) ? (await import(`./cuts-r6-${CUT_ID}.js`)).CUTS : { ...ROUND3, ...ROUND4, ...ROUND5 }
// each cut names the captured session it plays (a folder under frames/) and its frames
const MAKE = CUTS[CUT_ID]
const FRAMES = `frames/${MAKE.session ?? "midday"}/`
export const FRAME_NAMES = MAKE.frames ?? ["app", "bare", "h1", "picker", "picker-typed", "indigo", "note-empty", "note-text", "note-saved", "changes", "sent"]
/*
 * A patch is a frame that covers only part of the page (the hover, round the
 * button): MAKE.patch(name) names the rect in rects.json where it sits. Its
 * edges are feathered so it lies on the frame under it without a seam.
 */
const patchRect = (name) => (MAKE.patch && rects[MAKE.patch(name)]) || null
const STRIP_FRAMES = MAKE.stripFrames ?? ["bare"]
const FEATHER = "linear-gradient(90deg, transparent, #000 10px, #000 calc(100% - 10px), transparent), linear-gradient(transparent, #000 10px, #000 calc(100% - 10px), transparent)"
function placePatch(img, p) {
  Object.assign(img.style, { width: `${p.w}px`, height: `${p.h}px`, webkitMaskImage: FEATHER, maskImage: FEATHER, webkitMaskComposite: "source-in", maskComposite: "intersect" })
}

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
      if (Math.abs(e) < 1e-7) break
      const d = dx(u)
      if (Math.abs(d) < 1e-7) break
      u -= e / d
    }
    let lo = 0, hi = 1
    for (let i = 0; i < 30 && Math.abs(sx(u) - x) > 1e-7; i++) {
      if (sx(u) < x) lo = u
      else hi = u
      u = (lo + hi) / 2
    }
    return sy(u)
  }
}
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
export const lerp = (a, b, p) => a + (b - a) * p
/** One easing family: expo-out for things arriving, a smooth in-out for things travelling. */
export const E = {
  out: bezier(0.16, 1, 0.3, 1),
  io: bezier(0.65, 0, 0.35, 1),
  soft: bezier(0.45, 0, 0.2, 1),
  linear: (x) => clamp(x, 0, 1),
}
export const prog = (t, a, d, e = E.out) => e(clamp((t - a) / d, 0, 1))

/* ---------- camera ---------- */
// The viewport is 1440x900 inside the window chrome, unless a cut gives the
// window a rect of its own (a chromeless close-up card): then it is that size.
let VW = 1440, VH = 900
export const FIT = 1440 / 1600
export function clampCam(c) {
  const hw = VW / 2 / c.s, hh = VH / 2 / c.s
  return { x: clamp(c.x, hw, 1600 - hw), y: clamp(c.y, hh, 1000 - hh), s: c.s }
}
/** keys: [[t, x, y, s, ease]] — each ease shapes the move that ends at its key; zoom travels in log space. */
export function track(t, keys) {
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
/** A hand's path between points [[t, x, y]]: eased, with a slight arc. */
export function path(t, pts) {
  if (t <= pts[0][0]) return { x: pts[0][1], y: pts[0][2] }
  for (let i = 1; i < pts.length; i++) {
    const [tb, xb, yb] = pts[i]
    if (t <= tb) {
      const [ta, xa, ya] = pts[i - 1]
      const p = E.soft((t - ta) / (tb - ta))
      const dx = xb - xa, dy = yb - ya
      const arc = Math.sin(Math.PI * p) * 0.08
      return { x: xa + dx * p - dy * arc, y: ya + dy * p + dx * arc }
    }
  }
  const z = pts[pts.length - 1]
  return { x: z[1], y: z[2] }
}

/* ---------- dom ---------- */
const $ = (id) => document.getElementById(id)
const el = {}
for (const id of ["film", "stage", "glow", "world", "nodesBack", "nodesFront", "nodesTop", "flood", "mono", "win", "vp", "cam", "shade", "stripL", "stripR", "typeMask", "caret", "spot", "ring", "cursor", "crops", "term", "termText",
  "code", "codeFile", "codeBody", "callouts", "type", "keys", "logo", "logoIcon", "logoMark", "logoSub", "logoUrl", "black"]) el[id] = $(id)
const css = (e, prop, v) => {
  if (e.__s?.[prop] === v) return
  ;(e.__s ??= {})[prop] = v
  e.style[prop] = v
}
const op = (e, v) => css(e, "opacity", String(Math.round(clamp(v, 0, 1) * 1000) / 1000))
const vis = (e, on) => css(e, "visibility", on ? "visible" : "hidden")
// for parts of a node: "visible" on a child would show it even while its node is hidden
const vin = (e, on) => css(e, "visibility", on ? "inherit" : "hidden")
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")

/* ---------- assets ---------- */
const frameImg = {}
let rects = {}, agent = null, diffModel = null, termLines = [], termTotal = 0
const loadImg = (img, src) => {
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
const canvases = new Map()
function pixels(img) {
  if (canvases.has(img)) return canvases.get(img)
  const c = document.createElement("canvas")
  c.width = 1600
  c.height = 1000
  const g = c.getContext("2d", { willReadFrequently: true })
  g.drawImage(img, 0, 0, 1600, 1000)
  canvases.set(img, g)
  return g
}
function samplePixel(img, x, y) {
  const d = pixels(img).getImageData(Math.round(x), Math.round(y), 1, 1).data
  return [d[0], d[1], d[2]]
}
/**
 * The lines of text inside a field, found from the pixels: each band of rows
 * with "ink" (pixels unlike the field's background) and its left and right ends.
 */
function inkLines(img, r, bg) {
  const d = pixels(img).getImageData(r.x, r.y, r.w, r.h).data
  const ink = (i) => Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 60
  const rows = []
  for (let y = 0; y < r.h; y++) {
    let x0 = -1, x1 = -1
    for (let x = 0; x < r.w; x++) if (ink((y * r.w + x) * 4)) { if (x0 < 0) x0 = x; x1 = x }
    rows.push(x0 < 0 ? null : [x0, x1])
  }
  const lines = []
  for (let y = 0; y < rows.length; y++) {
    if (!rows[y]) continue
    let y1 = y, x0 = rows[y][0], x1 = rows[y][1]
    while (y1 + 1 < rows.length && (rows[y1 + 1] || rows[y1 + 2])) {
      y1++
      if (rows[y1]) { x0 = Math.min(x0, rows[y1][0]); x1 = Math.max(x1, rows[y1][1]) }
    }
    if (y1 - y >= 4) lines.push({ x0: r.x + x0, x1: r.x + x1 + 1, y0: r.y + y - 1, y1: r.y + y1 + 2 })
    y = y1
  }
  return lines
}

/* the agent's brief, set like a terminal: the markdown headings bright, the rest quiet */
function buildTerm(raw) {
  const change = raw?.result?.changes?.[0]
  const lines = [{ cls: "c", text: "› wait_for_change" }, { cls: "p", text: `${change?.request ?? "1 change"} · ${change?.status ?? "pending"}` }, { cls: "p", text: "" }]
  for (const l of String(change?.brief ?? "").split("\n")) {
    if (/^Items marked/.test(l)) continue
    if (/^\*\*(App|Viewport|Location|React)/.test(l)) continue
    const text = l.replace(/\*\*/g, "")
    lines.push({ cls: /^#/.test(l) ? "h" : /Change:|Feedback:/.test(l) ? "k" : "s", text })
  }
  while (lines.length && !lines[lines.length - 1].text.trim()) lines.pop()
  termLines = lines.filter((l, i, a) => !(l.text === "" && a[i - 1]?.text === ""))
  termTotal = termLines.reduce((n, l) => n + l.text.length + 1, 0)
}
let lastTermKey = -1
function renderTerm(chars, t) {
  const key = chars * 2 + (Math.floor(t * 2) % 2)
  if (key === lastTermKey) return
  lastTermKey = key
  let html = "", left = chars
  for (const l of termLines) {
    if (left <= 0) break
    html += `<span class="tk-${l.cls}">${esc(l.text.slice(0, Math.min(left, l.text.length)))}</span>`
    left -= l.text.length + 1
    if (left > 0) html += "\n"
  }
  const blink = chars < termTotal || Math.floor(t * 2) % 2 === 0
  el.termText.innerHTML = html + `<span class="tcur" style="opacity:${blink ? 1 : 0}"></span>`
}

function parseDiff(txt) {
  const L = txt.replace(/\r/g, "").split("\n")
  let file = "", i = 0
  for (; i < L.length; i++) {
    if (L[i].startsWith("+++ ")) file = L[i].replace(/^\+\+\+ (b\/)?/, "")
    if (L[i].startsWith("@@")) break
  }
  if (i >= L.length) return null
  const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(L[i])
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
  const first = body.findIndex((l) => l.k !== "ctx")
  let last = first
  while (last + 1 < body.length && body[last + 1].k !== "ctx") last++
  return { file, lines: body.slice(Math.max(0, first - 2), Math.min(body.length, last + 3)) }
}
function buildDiff(model) {
  diffModel = model
  el.codeFile.textContent = model.file.replace(/^apps\/website\//, "")
  const indent = Math.min(...model.lines.filter((l) => l.tx.trim()).map((l) => l.tx.match(/^\s*/)[0].length))
  const del = model.lines.find((l) => l.k === "del"), add = model.lines.find((l) => l.k === "add")
  // show only the end of the long className line, where the change is
  const cut = (s) => {
    s = s.slice(indent)
    if (s.length <= 92) return s
    const at = Math.max(0, (del && add ? commonPrefix(del.tx.slice(indent), add.tx.slice(indent)) : 0) - 44)
    return "…" + s.slice(at, at + 90)
  }
  el.codeBody.innerHTML = model.lines.map((l) => {
    let tx = esc(cut(l.tx))
    if (l.k !== "ctx") tx = tx.replace(/(text-foreground|text-\[#[0-9A-Fa-f]{6}\])/, '<span class="hl">$1</span>')
    return `<div class="cl ${l.k}"><span class="bg"></span><span class="gut">${l.n}</span><span class="sg">${l.k === "del" ? "−" : l.k === "add" ? "+" : ""}</span><span class="tx">${tx}</span></div>`
  }).join("")
}
const commonPrefix = (a, b) => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

/* ---------- type ---------- */
/**
 * A phrase: { text, at, out, x, y, size, weight, tracking, color, align, split,
 * stagger, din, dout, lines, maxWidth }. It rises 14px into place, clearing a
 * little blur, word by word; it leaves by fading and lifting 8px.
 */
class Phrase {
  constructor(spec, i) {
    this.s = { x: 960, y: 540, size: 48, weight: 600, tracking: -0.025, color: "#f5f5f7", align: "center", split: "word", stagger: 0.045, din: 0.8, dout: 0.4, rise: 14, ...spec }
    const s = this.s
    const node = document.createElement("div")
    node.className = "phrase" + (s.maxWidth ? " wrap" : "")
    Object.assign(node.style, { fontSize: `${s.size}px`, fontWeight: String(s.weight), letterSpacing: `${s.tracking}em`, color: s.color, left: `${s.x}px`, top: `${s.y}px`, zIndex: String(10 + i) })
    if (s.maxWidth) node.style.width = `${s.maxWidth}px`
    if (s.lineHeight) node.style.lineHeight = String(s.lineHeight)
    if (s.align !== "center") node.style.textAlign = s.align
    else node.style.textAlign = "center"
    this.units = []
    const lines = s.lines ?? [s.text]
    lines.forEach((line, li) => {
      if (li) node.append(document.createElement("br"))
      const color = s.lineColors?.[li]
      for (const part of line.split(/(\s+)/).filter((p) => p !== "")) {
        if (/^\s+$/.test(part)) {
          node.append(part)
          continue
        }
        const u = document.createElement("span")
        u.className = "u"
        u.textContent = part
        if (color) u.style.color = color
        node.append(u)
        this.units.push(u)
      }
    })
    el.type.append(node)
    this.node = node
    const tx = s.align === "left" ? "0" : s.align === "right" ? "-100%" : "-50%"
    const ty = s.anchor === "top" ? "0" : s.anchor === "bottom" ? "-100%" : "-50%"
    node.style.transform = `translate(${tx}, ${ty})`
  }
  render(t) {
    const s = this.s
    const n = this.units.length
    const live = t >= s.at - 0.01 && t < s.out + s.dout + 0.05
    vis(this.node, live)
    if (!live) return
    this.units.forEach((u, i) => {
      const p = prog(t, s.at + (s.split === "none" ? 0 : i * s.stagger), s.din)
      const q = prog(t, s.out, s.dout, E.soft)
      const o = p * (1 - q)
      css(u, "opacity", String(Math.round(o * 1000) / 1000))
      css(u, "transform", `translateY(${(s.rise * (1 - p) - 8 * q).toFixed(2)}px)`)
      const blur = 6 * (1 - p)
      css(u, "filter", blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none")
    })
  }
}

/* ---------- crops (close-ups) ---------- */
const cropEls = {}
function cropEl(id) {
  if (cropEls[id]) return cropEls[id]
  const box = document.createElement("div")
  box.className = "crop"
  const imgs = {}
  for (const name of FRAME_NAMES) {
    if (!frameImg[name]) continue
    const img = document.createElement("img")
    img.src = frameImg[name].src
    img.alt = ""
    img.style.opacity = "0"
    const p = patchRect(name)
    if (p) placePatch(img, p)
    box.append(img)
    imgs[name] = img
  }
  const cursor = el.cursor.cloneNode(true)
  cursor.removeAttribute("id")
  cursor.style.position = "absolute"
  box.append(cursor)
  el.crops.append(box)
  return (cropEls[id] = { box, imgs, cursor })
}


/* ---------- motion-graphics nodes ----------
   Cuts declare nodes once (cut.nodes) and set their state every frame
   (S.nodes[id]). Kinds: text (per-word or per-letter units), sel (Design
   Layer's selection: outline, handles, size label), chip (a color swatch),
   pin (a note pin), check, bar, code (big monospace lines), plate (a crop of a
   captured frame on its own card), html. */
const nodes = {}
const info = {}
const PARENTS = () => ({ back: el.nodesBack, front: el.nodesFront, top: el.nodesTop })
function buildNode(spec) {
  const node = document.createElement("div")
  node.className = `node ${spec.kind}${spec.font === "mono" ? " mono" : ""}${spec.cls ? " " + spec.cls : ""}`
  const units = []
  if (spec.kind === "text") {
    Object.assign(node.style, { fontSize: `${spec.size ?? 120}px`, fontWeight: String(spec.weight ?? 700), letterSpacing: `${spec.tracking ?? -0.05}em`, color: spec.color ?? "#f5f5f7" })
    if (spec.lineHeight) node.style.lineHeight = String(spec.lineHeight)
    const lines = spec.lines ?? [spec.text]
    // a caption can lead with an icon: it is unit 0, and rises with the words
    if (spec.icon) {
      const u = document.createElement("span")
      u.className = "u ic"
      u.innerHTML = spec.icon
      node.append(u)
      units.push(u)
    }
    lines.forEach((line, li) => {
      if (li) node.append(document.createElement("br"))
      const parts = spec.split === "char" ? [...line] : spec.split === "none" ? [line] : line.split(/(\s+)/).filter((x) => x !== "")
      // **words** are set bold, *words* in the italic serif (word splits only)
      let mode = ""
      for (const part of parts) {
        if (/^\s+$/.test(part) && spec.split !== "char") { node.append(part); continue }
        const u = document.createElement("span")
        let text = part, end = false
        if (spec.split !== "char") {
          if (text.startsWith("**")) { mode = "b"; text = text.slice(2) }
          else if (text.startsWith("*") && text.length > 1) { mode = "i"; text = text.slice(1) }
          const close = mode === "b" ? /\*\*([.,!?]?)$/ : mode === "i" ? /\*([.,!?]?)$/ : null
          if (close && close.test(text)) { text = text.replace(close, "$1"); end = true }
        }
        u.className = "u" + (mode ? " " + mode : "")
        u.textContent = text
        if (end) mode = ""
        if (spec.mask) {
          const m = document.createElement("span")
          m.className = "m"
          m.append(u)
          node.append(m)
        } else node.append(u)
        units.push(u)
      }
    })
    if (spec.align === "left") node.style.textAlign = "left"
  } else if (spec.kind === "sel") {
    node.style.setProperty("--line", `${spec.line ?? 2}px`)
    node.style.setProperty("--hs", `${spec.hs ?? 12}px`)
    node.style.setProperty("--ls", `${spec.ls ?? 20}px`)
    // outline, eight handles, four corner-radius dots (Figma's), the size label
    node.innerHTML = `<div class="ol"></div>${"<div class=h></div>".repeat(8)}${"<div class=rd></div>".repeat(4)}<div class="lab"></div>`
  } else if (spec.kind === "chip") {
    node.innerHTML = `<i style="background:${spec.color ?? "#4a5df9"}"></i><b>${esc(spec.hex ?? "#4A5DF9")}</b>`
  } else if (spec.kind === "pin") {
    node.textContent = String(spec.num ?? 1)
  } else if (spec.kind === "check") {
    node.innerHTML = `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="${spec.fill ?? "#4a5df9"}"/><path d="M30 52 L44 66 L71 37" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/></svg>`
    Object.assign(node.style, { width: `${spec.size ?? 120}px`, height: `${spec.size ?? 120}px` })
  } else if (spec.kind === "code") {
    node.innerHTML = spec.lines.map((l) => `<div class="codeline" style="color:${l.color ?? "#d4d4d8"}">${l.html ?? esc(l.text)}</div>`).join("")
    if (spec.size) for (const c of node.children) c.style.fontSize = `${spec.size}px`
  } else if (spec.kind === "plate") {
    // one image per frame the plate can show, stacked, so switching frames never waits on a decode
    for (const name of spec.frames ?? [spec.frame]) {
      const img = document.createElement("img")
      img.src = frameImg[name]?.src ?? ""
      img.alt = ""
      img.dataset.frame = name
      const p = patchRect(name)
      if (p) placePatch(img, p)
      node.append(img)
    }
  } else if (spec.kind === "html") node.innerHTML = spec.html
  if (spec.style) Object.assign(node.style, spec.style)
  node.style.visibility = "hidden"
  ;(PARENTS()[spec.parent ?? "top"]).append(node)
  nodes[spec.id] = { spec, node, units, handles: spec.kind === "sel" ? [...node.querySelectorAll(".h")] : null, dots: spec.kind === "sel" ? [...node.querySelectorAll(".rd")] : null }
}
function measureNodes() {
  for (const [id, n] of Object.entries(nodes)) {
    if (n.spec.kind !== "text") continue
    info[id] = { w: n.node.offsetWidth, h: n.node.offsetHeight, units: n.units.map((u) => {
      // a unit's box relative to the node, unaffected by the unit's own transform
      const host = u.parentElement.classList.contains("m") ? u.parentElement : u
      return { x: host.offsetLeft, y: host.offsetTop, w: host.offsetWidth, h: host.offsetHeight }
    }) }
  }
}
/** The screen rect of a text node (or one of its units) placed at state st = { x, y, s, anchor }. */
function rectOf(id, unit, st) {
  const m = info[id]
  if (!m) return { x: 0, y: 0, w: 0, h: 0 }
  const s = st.s ?? 1
  const ax = st.anchor === "left" ? 0 : st.anchor === "right" ? 1 : 0.5
  const x0 = st.x - m.w * s * ax, y0 = st.y - m.h * s * 0.5
  if (unit == null) return { x: x0, y: y0, w: m.w * s, h: m.h * s }
  const u = m.units[unit]
  return { x: x0 + u.x * s, y: y0 + u.y * s, w: u.w * s, h: u.h * s }
}
const f2 = (v) => (Math.round(v * 100) / 100).toString()
// scales need more places: at 0.01 a 1600 px image lands up to 8 px off, a different 8 px each frame
const f5 = (v) => (Math.round(v * 1e5) / 1e5).toString()
function applyNodes(states) {
  for (const [id, n] of Object.entries(nodes)) {
    const st = states[id]
    const on = !!st && (st.op ?? 1) > 0.001
    vis(n.node, on)
    if (!on) {
      op(n.node, 0)
      continue
    }
    const k = n.spec.kind
    const ax = st.anchor === "left" ? "0" : st.anchor === "right" ? "-100%" : st.anchor === "topleft" ? "0" : "-50%"
    const ay = st.anchor === "topleft" ? "0" : "-50%"
    let tr = `translate3d(${f2(st.x ?? 0)}px, ${f2(st.y ?? 0)}px, ${f2(st.z ?? 0)}px) translate(${ax}, ${ay})`
    if (st.rx || st.ry || st.rz) tr += ` rotateX(${f2(st.rx ?? 0)}deg) rotateY(${f2(st.ry ?? 0)}deg) rotateZ(${f2(st.rz ?? 0)}deg)`
    const sx = (st.s ?? 1) * (st.sx ?? 1), sy = (st.s ?? 1) * (st.sy ?? 1)
    if (sx !== 1 || sy !== 1) tr += ` scale(${f5(sx)}, ${f5(sy)})`
    if (k === "sel") tr = `translate3d(${f2(st.x)}px, ${f2(st.y)}px, ${f2(st.z ?? 0)}px)`
    css(n.node, "transform", tr)
    // a pivot away from the node's center (ox, oy px from it): pieces of one plane turn about the plane's center
    css(n.node, "transformOrigin", st.ox || st.oy ? `calc(50% + ${f2(st.ox ?? 0)}px) calc(50% + ${f2(st.oy ?? 0)}px)` : "50% 50%")
    op(n.node, st.op ?? 1)
    css(n.node, "filter", st.blur > 0.05 ? `blur(${f2(st.blur)}px)` : "none")
    if (st.color) css(n.node, "color", st.color)
    if (k === "text") {
      n.units.forEach((u, i) => {
        const us = st.units?.[i] ?? {}
        const o = us.op ?? 1
        css(u, "opacity", String(Math.round(clamp(o, 0, 1) * 1000) / 1000))
        let ut = ""
        if (us.x || us.y) ut += `translate(${f2(us.x ?? 0)}px, ${typeof us.y === "string" ? us.y : f2(us.y ?? 0) + "px"})`
        if (us.s != null && us.s !== 1) ut += ` scale(${f2(us.s)})`
        if (us.rot) ut += ` rotate(${f2(us.rot)}deg)`
        css(u, "transform", ut || "none")
        css(u, "filter", us.blur > 0.05 ? `blur(${f2(us.blur)}px)` : "none")
        css(u, "color", us.color ?? "")
      })
      if (st.text != null && n.units.length === 1 && n.units[0].textContent !== st.text) n.units[0].textContent = st.text
    } else if (k === "sel") {
      Object.assign(n.node.style, { width: `${st.w}px`, height: `${st.h}px` })
      const ol = n.node.firstChild
      const d = clamp(st.draw ?? 1, 0, 1)
      // the outline draws from the top-left corner, both ways round, like the editor's selection
      css(ol, "clipPath", d >= 1 ? "none" : `polygon(0 0, ${d * 200}% 0, ${d * 200}% ${Math.max(0, d * 2 - 1) * 100}%, 0 ${d * 200}%)`)
      const hp = st.handles ?? 1
      const pts = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]]
      n.handles.forEach((h, i) => {
        Object.assign(h.style, { left: `${pts[i][0] * 100}%`, top: `${pts[i][1] * 100}%` })
        const q = clamp(hp * 1.6 - i * 0.075, 0, 1)
        css(h, "transform", `scale(${f2(E.out(q))})`)
      })
      // corner radius, a fill that floods in from the left, and the radius dots
      const rad = Math.min(st.radius ?? 2, st.w / 2, st.h / 2)
      css(ol, "borderRadius", `${f2(rad)}px`)
      const fp = clamp(st.fillP ?? (st.fill ? 1 : 0), 0, 1)
      css(ol, "background", st.fill && fp > 0 ? (fp >= 1 ? st.fill : `linear-gradient(90deg, ${st.fill} ${f2(fp * 100)}%, transparent ${f2(fp * 100)}%)`) : "none")
      css(ol, "borderColor", st.lineColor ?? "")
      const dp = clamp(st.dots ?? 0, 0, 1)
      // each dot sits on the corner's diagonal and walks inward as the radius grows, like the handle being dragged
      const inset = 14 + rad * 0.3
      n.dots.forEach((dot, i) => {
        const [fx, fy] = [[0, 0], [1, 0], [1, 1], [0, 1]][i]
        Object.assign(dot.style, { left: fx ? `calc(100% - ${f2(inset)}px)` : `${f2(inset)}px`, top: fy ? `calc(100% - ${f2(inset)}px)` : `${f2(inset)}px` })
        css(dot, "transform", `scale(${f2(E.out(clamp(dp * 1.4 - i * 0.1, 0, 1)))})`)
      })
      const lab = n.node.lastChild
      if (lab.textContent !== (st.label ?? "")) lab.textContent = st.label ?? ""
      op(lab, st.label ? st.labelOp ?? 1 : 0)
    } else if (k === "check") {
      n.node.querySelector("path").setAttribute("stroke-dashoffset", String(1 - clamp(st.draw ?? 1, 0, 1)))
    } else if (k === "bar") {
      Object.assign(n.node.style, { width: `${st.w ?? 100}px` })
      css(n.node, "transform", tr + ` scaleX(${f2(clamp(st.p ?? 1, 0, 1))})`)
    } else if (k === "plate") {
      const src = st.src ?? n.spec.src
      const w = st.w ?? n.spec.w, h = st.h ?? n.spec.h
      Object.assign(n.node.style, { width: `${w}px`, height: `${h}px` })
      const kk = w / src.w
      // which frames show: st.frames { name: opacity }, or one st.frame, or the first
      const imgs = [...n.node.querySelectorAll("img")]
      imgs.forEach((img, i) => {
        const f = img.dataset.frame
        const v = st.frames ? st.frames[f] ?? 0 : st.frame ? (f === st.frame ? 1 : 0) : i === 0 ? 1 : 0
        op(img, v)
        vin(img, v > 0.001)
        const p = patchRect(f)
        css(img, "transform", `translate(${f5(((p?.x ?? 0) - src.x) * kk)}px, ${f5(((p?.y ?? 0) - src.y) * kk)}px) scale(${f5(kk)})`)
      })
      // typing on a plate, as on the page: patches of the field's background pull back line by line
      const ty = st.typing, lines = ty?.field?.lines ?? []
      n.masks ??= []
      while (n.masks.length < lines.length) {
        const m = document.createElement("div")
        m.style.position = "absolute"
        n.node.append(m)
        n.masks.push(m)
      }
      if (!n.caret) {
        n.caret = document.createElement("div")
        Object.assign(n.caret.style, { position: "absolute", background: "#f5f5f7", visibility: "hidden" })
        n.node.append(n.caret)
      }
      let left = (ty?.p ?? 0) * lines.reduce((s, l) => s + (l.x1 - l.x0), 0), caretAt = null
      n.masks.forEach((m, i) => {
        const l = lines[i]
        if (!ty || !l) return vin(m, false)
        const shown = clamp(left, 0, l.x1 - l.x0)
        left -= l.x1 - l.x0
        if (caretAt === null && (shown < l.x1 - l.x0 || i === lines.length - 1)) caretAt = { x: l.x0 + shown, y0: l.y0, y1: l.y1 }
        vin(m, shown < l.x1 - l.x0)
        const mx = shown > 0 ? l.x0 + shown : l.x0 - 3
        Object.assign(m.style, { left: `${f2((mx - src.x) * kk)}px`, top: `${f2((l.y0 - src.y) * kk)}px`, width: `${f2((l.x1 + 3 - mx) * kk)}px`, height: `${f2((l.y1 - l.y0) * kk)}px`, background: ty.field.bg })
      })
      const caretOn = !!ty?.caret && caretAt && (ty.p > 0 && ty.p < 1 ? true : Math.floor(ty.t * 2.4) % 2 === 0)
      vin(n.caret, !!caretOn)
      if (caretOn) Object.assign(n.caret.style, { left: `${f2((caretAt.x + 0.5 - src.x) * kk)}px`, top: `${f2((caretAt.y0 + 1 - src.y) * kk)}px`, width: `${f2(1.5 * kk)}px`, height: `${f2((caretAt.y1 - caretAt.y0 - 2) * kk)}px` })
    }
    // any node: its own styles, its markup, and styles or text for parts of it
    if (st.css) for (const [p, v] of Object.entries(st.css)) css(n.node, p, v)
    if (st.html != null && n.html !== st.html) { n.node.innerHTML = st.html; n.html = st.html; n.subs = {} }
    if (st.sub) {
      n.subs ??= {}
      for (const [sel, sv] of Object.entries(st.sub)) {
        const e = (n.subs[sel] ??= n.node.querySelector(sel))
        if (!e) continue
        if (sv.css) for (const [p, v] of Object.entries(sv.css)) css(e, p, v)
        if (sv.text != null && e.textContent !== sv.text) e.textContent = sv.text
        if (sv.html != null && e.__html !== sv.html) { e.innerHTML = sv.html; e.__html = sv.html }
      }
    }
  }
}

/* ---------- the frame ---------- */
let cut, phrases = []
const masks = []

async function init() {
  rects = (await fetchJson(`${FRAMES}rects.json`)) || {}
  agent = await fetchJson(`${FRAMES}agent.json`)
  const jobs = []
  for (const name of FRAME_NAMES) {
    const img = document.createElement("img")
    img.className = "frame"
    img.alt = ""
    const p = patchRect(name)
    if (p) {
      placePatch(img, p)
      Object.assign(img.style, { left: `${p.x}px`, top: `${p.y}px` })
    }
    el.cam.insertBefore(img, el.stripL)
    frameImg[name] = img
    jobs.push(loadImg(img, `${FRAMES}${name}.jpg`))
  }
  // the editor's panels for S.strips: one image per frame they can show (cut.stripFrames; the bare editor by default)
  for (const strip of [el.stripL, el.stripR]) {
    const first = strip.querySelector("img")
    first.dataset.frame = STRIP_FRAMES[0]
    jobs.push(loadImg(first, `${FRAMES}${STRIP_FRAMES[0]}.jpg`))
    for (const name of STRIP_FRAMES.slice(1)) {
      const img = first.cloneNode()
      img.dataset.frame = name
      img.style.visibility = "hidden"
      strip.append(img)
      jobs.push(loadImg(img, `${FRAMES}${name}.jpg`))
    }
  }
  jobs.push(loadImg(el.logoIcon, el.logoIcon.src))
  await Promise.all(jobs)
  el.stripL.style.clipPath = `inset(0 ${(1 - 0.175) * 100}% 0 0)`
  el.stripR.style.clipPath = `inset(0 0 0 ${0.825 * 100}%)`
  buildTerm(agent)
  let diffText = ""
  try {
    diffText = await (await fetch(`${FRAMES}diff.txt`, { cache: "no-store" })).text()
    const model = parseDiff(diffText)
    if (model) buildDiff(model)
  } catch {}
  // the fields the film types into: their background (the field's most common
  // color) and the captured lines of text in them
  const field = (r0, frame) => {
    if (!r0) return null
    const r = { x: r0.x + 2, y: r0.y + 2, w: r0.w - 4, h: r0.h - 4 }
    const d = pixels(frameImg[frame]).getImageData(r.x, r.y, r.w, r.h).data
    const count = new Map()
    for (let i = 0; i < d.length; i += 4) {
      const k = (d[i] >> 2) << 12 | (d[i + 1] >> 2) << 6 | (d[i + 2] >> 2)
      count.set(k, (count.get(k) ?? 0) + 1)
    }
    const k = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const bg = [((k >> 12) & 63) << 2, ((k >> 6) & 63) << 2, (k & 63) << 2]
    return { ...r, bg: `rgb(${bg.join(", ")})`, lines: inkLines(frameImg[frame], r, bg) }
  }
  // each session names its typed fields: [the field's rect, the frame with the words in it]
  const FIELDS = MAKE.fields ?? { typeColor: ["pickerTyped", "picker-typed"], typeNote: ["composerField", "note-text"] }
  for (const [key, [rect, frame]] of Object.entries(FIELDS)) rects[key] = field(rects[rect], frame)
  window.__typing = Object.fromEntries(Object.keys(FIELDS).map((k) => [k, rects[k]]))
  // cuts also get what the agent received and the source diff, to set them as type
  cut = MAKE({ R: rects, E, FIT, prog, track, path, clampCam, lerp, clamp, rectOf, frameSrc: (n) => frameImg[n]?.src, agent, diffText })
  // a cut can publish its events on one clock (cut.cues), for the sound to be laid against
  window.CUES = cut.cues ?? null
  for (const spec of cut.nodes || []) buildNode(spec)
  for (const [i, p] of (cut.type || []).entries()) phrases.push(new Phrase(p, i))
  await document.fonts.load('600 100px "InterFilm"')
  await document.fonts.load('700 100px "InterFilm"')
  await document.fonts.ready
  measureNodes()
  window.DURATION = cut.duration
  seek(0)
}

function fresh() {
  return { win: { op: 0, x: 0, y: 0, s: 0.86 }, frames: {}, cam: { x: 800, y: 500, s: FIT }, strips: null, typing: null, spot: null, cursor: null, ring: null, crops: [], term: null, code: null, callouts: [], keys: null, logo: null, black: 0, nodes: {}, glow: null, flood: null, mono: null }
}

/** Window-space → screen: where a point of the shot is on the 1920×1080 frame, for callouts. */
function toScreen(S, x, y) {
  const c = clampCam(S.cam)
  const vx = x * c.s + (VW / 2 - c.x * c.s), vy = y * c.s + (VH / 2 - c.y * c.s)
  const w = S.win
  if (w.rect) return { x: w.rect.x + vx, y: w.rect.y + vy }
  return { x: 960 + w.x + w.s * (vx - 720), y: 540 + w.y + w.s * (vy + 36 - 468) }
}
/**
 * A point of the shot on the (possibly tilted) window, as a node state: its
 * 3D position, lifted `lift` px off the page along the window's normal, with
 * the window's rotation, so a node there lies flat on the page or floats above it.
 * k is the scale of shot px on the page, for sizing plates.
 */
function onWindow(S, x, y, lift = 0) {
  const c = clampCam(S.cam)
  const w = S.win
  const vx = x * c.s + (VW / 2 - c.x * c.s), vy = y * c.s + (VH / 2 - c.y * c.s)
  let px = (vx - 720) * w.s, py = (vy + 36 - 468) * w.s, pz = lift
  const rad = Math.PI / 180
  const z = (w.rz ?? 0) * rad, yy = (w.ry ?? 0) * rad, xx = (w.rx ?? 0) * rad
  // the window's transform list is rotateX rotateY rotateZ: applied to a point right to left
  ;[px, py] = [px * Math.cos(z) - py * Math.sin(z), px * Math.sin(z) + py * Math.cos(z)]
  ;[px, pz] = [px * Math.cos(yy) + pz * Math.sin(yy), -px * Math.sin(yy) + pz * Math.cos(yy)]
  ;[py, pz] = [py * Math.cos(xx) - pz * Math.sin(xx), py * Math.sin(xx) + pz * Math.cos(xx)]
  return { x: 960 + w.x + px, y: 540 + w.y + py, z: (w.z ?? 0) + pz, rx: w.rx ?? 0, ry: w.ry ?? 0, rz: w.rz ?? 0, k: c.s * w.s }
}

function apply(S, t) {
  // window: the browser frame, or (with a rect) a chromeless card
  const w = S.win
  vis(el.win, w.op > 0.001)
  op(el.win, w.op)
  if (w.rect) {
    VW = w.rect.w
    VH = w.rect.h
    Object.assign(el.win.style, { left: `${w.rect.x}px`, top: `${w.rect.y}px`, width: `${w.rect.w}px`, height: `${w.rect.h}px`, borderRadius: `${w.r ?? 16}px` })
    Object.assign(el.vp.style, { top: "0px", width: `${w.rect.w}px`, height: `${w.rect.h}px` })
    css(el.win.firstElementChild, "display", "none")
    css(el.win, "transform", w.rx || w.ry || w.rz || w.z ? `translateZ(${w.z ?? 0}px) rotateX(${w.rx ?? 0}deg) rotateY(${w.ry ?? 0}deg) rotateZ(${w.rz ?? 0}deg)` : "none")
  } else {
    VW = 1440
    VH = 900
    Object.assign(el.win.style, { left: "240px", top: "72px", width: "1440px", height: "936px", borderRadius: "14px" })
    Object.assign(el.vp.style, { top: "36px", width: "1440px", height: "900px" })
    css(el.win.firstElementChild, "display", "flex")
    css(el.win, "transform", `translate3d(${w.x.toFixed(2)}px, ${w.y.toFixed(2)}px, ${(w.z ?? 0).toFixed(1)}px) rotateX(${(w.rx ?? 0).toFixed(3)}deg) rotateY(${(w.ry ?? 0).toFixed(3)}deg) rotateZ(${(w.rz ?? 0).toFixed(3)}deg) scale(${w.s.toFixed(4)})`)
  }
  const fb = S.frameBlur > 0.05 ? `blur(${S.frameBlur.toFixed(2)}px)` : "none"
  for (const [name, img] of Object.entries(frameImg)) {
    const v = S.frames[name] || 0
    op(img, v)
    vis(img, v > 0.001)
    if (v > 0.001) css(img, "filter", fb)
  }
  const cc = clampCam(S.cam)
  css(el.cam, "transform", `translate(${(VW / 2 - cc.x * cc.s).toFixed(2)}px, ${(VH / 2 - cc.y * cc.s).toFixed(2)}px) scale(${cc.s.toFixed(4)})`)
  S.cam = cc

  op(el.shade, S.shade?.a ?? 0)

  // the editor arriving: its panels slide in from the sides
  const st = S.strips
  vis(el.stripL, !!st)
  vis(el.stripR, !!st)
  if (st) {
    css(el.stripL, "transform", `translateX(${(-0.175 * 1600 * (1 - st.pl)).toFixed(1)}px)`)
    css(el.stripR, "transform", `translateX(${(0.175 * 1600 * (1 - st.pr)).toFixed(1)}px)`)
    const f = st.frame ?? STRIP_FRAMES[0]
    for (const strip of [el.stripL, el.stripR]) for (const img of strip.children) vin(img, img.dataset.frame === f)
  }

  // typing: patches of the field's own background hide the captured text and
  // pull back line by line as it is "typed"; a caret rides the edge
  const ty = S.typing
  const lines = ty?.field?.lines ?? []
  while (masks.length < lines.length) {
    const m = document.createElement("div")
    m.style.position = "absolute"
    el.cam.insertBefore(m, el.caret)
    masks.push(m)
  }
  const total = lines.reduce((n, l) => n + (l.x1 - l.x0), 0)
  let left = (ty?.p ?? 0) * total, caretAt = null
  masks.forEach((m, i) => {
    const l = lines[i]
    if (!ty || !l) return vis(m, false)
    const shown = clamp(left, 0, l.x1 - l.x0)
    left -= l.x1 - l.x0
    const x = l.x0 + shown
    if (caretAt === null && (shown < l.x1 - l.x0 || i === lines.length - 1)) caretAt = { x, y0: l.y0, y1: l.y1 }
    vis(m, shown < l.x1 - l.x0)
    const mx = shown > 0 ? x : l.x0 - 3 // an untouched line is covered with a margin, so no edge of its first letter shows
    Object.assign(m.style, { left: `${mx}px`, top: `${l.y0}px`, width: `${l.x1 + 3 - mx}px`, height: `${l.y1 - l.y0}px`, background: ty.field.bg })
  })
  if (ty && caretAt === null && ty.field) caretAt = { x: ty.field.x + 8, y0: ty.field.y + 2, y1: ty.field.y + 18 }
  const caretOn = !!ty && ty.caret && caretAt && (ty.p > 0 && ty.p < 1 ? true : Math.floor(t * 2.4) % 2 === 0)
  vis(el.caret, !!caretOn)
  if (caretOn) Object.assign(el.caret.style, { left: `${caretAt.x + 0.5}px`, top: `${caretAt.y0 + 1}px`, height: `${caretAt.y1 - caretAt.y0 - 2}px` })

  // spotlight
  const sp = S.spot
  vis(el.spot, !!sp && sp.op > 0.001)
  if (sp) {
    Object.assign(el.spot.style, { left: `${sp.x}px`, top: `${sp.y}px`, width: `${sp.w}px`, height: `${sp.h}px`, borderRadius: `${sp.r ?? 10}px` })
    const a = 0.66 * sp.op
    css(el.spot, "boxShadow", `0 0 0 4000px rgba(6, 6, 8, ${a.toFixed(3)}), 0 0 0 1px rgba(255, 255, 255, ${(0.22 * sp.op).toFixed(3)})`)
  }

  // pointer, counter-scaled so it stays the same size on screen
  const cu = S.cursor
  if (cu) {
    const k = (1 / cc.s) * (cu.size ?? 1)
    op(el.cursor, cu.op ?? 1)
    css(el.cursor, "transform", `translate(${(cu.x - 2).toFixed(1)}px, ${(cu.y - 2).toFixed(1)}px) scale(${(k * (1 - 0.12 * (cu.press ?? 0))).toFixed(4)})`)
    // a name tag, as multiplayer cursors wear in Figma
    const tag = el.cursor.lastElementChild
    if (tag.textContent !== (cu.label ?? "")) tag.textContent = cu.label ?? ""
    vin(tag, !!cu.label)
  } else op(el.cursor, 0)
  const rg = S.ring
  if (rg) {
    const k = 1 / cc.s
    op(el.ring, 0.7 * (1 - rg.q))
    css(el.ring, "transform", `translate(${rg.x}px, ${rg.y}px) scale(${(k * (0.5 + 0.9 * E.out(rg.q))).toFixed(4)})`)
  } else op(el.ring, 0)

  // close-up cards
  const live = new Set()
  for (const c of S.crops) {
    const ce = cropEl(c.id)
    live.add(c.id)
    vis(ce.box, c.op > 0.001)
    op(ce.box, c.op)
    const k = c.dst.w / c.src.w
    Object.assign(ce.box.style, { left: `${c.dst.x}px`, top: `${c.dst.y}px`, width: `${c.dst.w}px`, height: `${c.dst.h}px`, borderRadius: `${c.r ?? 16}px` })
    for (const [name, img] of Object.entries(ce.imgs)) {
      const v = c.frames[name] || 0
      op(img, v)
      vis(img, v > 0.001)
      const p = patchRect(name)
      css(img, "transform", `translate(${f5(((p?.x ?? 0) - c.src.x) * k)}px, ${f5(((p?.y ?? 0) - c.src.y) * k)}px) scale(${f5(k)})`)
    }
    if (c.cursor) {
      op(ce.cursor, c.cursor.op ?? 1)
      css(ce.cursor, "transform", `translate(${((c.cursor.x - c.src.x) * k - 2).toFixed(1)}px, ${((c.cursor.y - c.src.y) * k - 2).toFixed(1)}px) scale(${(1.15 * (1 - 0.12 * (c.cursor.press ?? 0))).toFixed(3)})`)
    } else op(ce.cursor, 0)
  }
  for (const [id, ce] of Object.entries(cropEls)) if (!live.has(id)) vis(ce.box, false)

  // the handoff
  const T = S.term
  vis(el.term, !!T)
  if (T) {
    op(el.term, T.op)
    css(el.term, "transform", `translate(${T.x}px, ${T.y}px) scale(${T.s ?? 1})`)
    renderTerm(Math.min(termTotal, Math.max(0, Math.floor(T.chars))), t)
  }
  const C = S.code
  vis(el.code, !!C)
  if (C && diffModel) {
    op(el.code, C.op)
    css(el.code, "transform", `translate(${C.x}px, ${C.y}px) scale(${C.s ?? 1})`)
    let di = 0, ai = 0
    el.codeBody.querySelectorAll(".cl").forEach((row) => {
      const kind = row.classList.contains("del") ? "del" : row.classList.contains("add") ? "add" : "ctx"
      if (kind === "ctx") return
      const p = kind === "del" ? C.del : C.add
      css(row.querySelector(".bg"), "transform", `scaleX(${clamp(p, 0, 1).toFixed(3)})`)
      const hl = row.querySelector(".hl")
      if (hl) hl.style.backgroundColor = `rgba(${kind === "del" ? "255,69,58" : "48,209,88"},${(0.32 * clamp(p * 1.4 - 0.4, 0, 1)).toFixed(3)})`
      di += kind === "del"
      ai += kind === "add"
    })
  }

  // callouts: a number, a label, and a hairline to the thing it names
  const liveC = new Set()
  for (const c of S.callouts) {
    liveC.add(c.id)
    let node = el.callouts.querySelector(`[data-id="${c.id}"]`)
    if (!node) {
      node = document.createElement("div")
      node.dataset.id = c.id
      node.innerHTML = `<div class="leader"></div><div class="callout">${c.num ? `<span class="num">${c.num}</span>` : ""}<span class="lab">${c.label}</span></div>`
      el.callouts.append(node)
    }
    const leader = node.firstChild, label = node.lastChild
    const a = toScreen(S, c.ax, c.ay)
    const dir = c.side === "left" ? -1 : 1
    const len = c.len ?? 90
    vis(node, c.op > 0.001)
    op(leader, c.op)
    Object.assign(leader.style, { left: `${dir > 0 ? a.x : a.x - len}px`, top: `${a.y}px`, width: `${len}px` })
    css(leader, "transform", `scaleX(${clamp(c.p ?? 1, 0, 1).toFixed(3)})`)
    leader.style.transformOrigin = dir > 0 ? "0 50%" : "100% 50%"
    const lp = clamp(((c.p ?? 1) - 0.5) / 0.5, 0, 1)
    op(label, c.op * lp)
    Object.assign(label.style, { left: `${dir > 0 ? a.x + len + 14 : a.x - len - 14}px`, top: `${a.y}px` })
    css(label, "transform", `translate(${dir > 0 ? "0" : "-100%"}, -50%) translateX(${(dir * 10 * (1 - lp)).toFixed(1)}px)`)
  }
  for (const node of el.callouts.children) if (!liveC.has(node.dataset.id)) vis(node, false)

  // keycaps
  const K = S.keys
  vis(el.keys, !!K)
  if (K) {
    if (el.keys.dataset.k !== K.keys.join("")) {
      el.keys.dataset.k = K.keys.join("")
      el.keys.innerHTML = K.keys.map((k) => `<div class="key">${esc(k)}</div>`).join("")
    }
    css(el.keys, "top", `${K.y ?? 900}px`)
    op(el.keys, K.op)
    for (const node of el.keys.children) css(node, "transform", `translateY(${(3 * (K.press ?? 0) + 10 * (1 - K.op)).toFixed(2)}px)`)
  }

  // end card
  const L = S.logo
  vis(el.logo, !!L)
  if (L) {
    for (const [node, p, rise] of [[el.logoIcon, L.icon, 20], [el.logoMark, L.mark, 16], [el.logoSub, L.sub, 12], [el.logoUrl, L.url, 10]]) {
      op(node, p * (1 - (L.out ?? 0)))
      css(node, "transform", `translateY(${(rise * (1 - p)).toFixed(2)}px)`)
      css(node, "filter", p < 1 ? `blur(${(6 * (1 - p)).toFixed(2)}px)` : "none")
    }
  }
  // light behind the work, the color flood, and the grey that color washes away
  const G = S.glow
  op(el.glow, G?.op ?? 0)
  if (G) css(el.glow, "transform", `translate(${G.x ?? 0}px, ${G.y ?? 0}px) scale(${G.s ?? 1})`)
  const F = S.flood
  vis(el.flood, !!F && F.r > 0.5)
  if (F) {
    css(el.flood, "clipPath", `circle(${F.r.toFixed(1)}px at ${F.x.toFixed(1)}px ${F.y.toFixed(1)}px)`)
    css(el.flood, "background", F.color ?? "#4a5df9")
  }
  const M = S.mono
  vis(el.mono, !!M)
  if (M) {
    // mask: grey outside the circle (shot px → viewport px through the camera)
    const r = (M.r ?? 0) * cc.s, x = M.x * cc.s + (VW / 2 - cc.x * cc.s), y = M.y * cc.s + (VH / 2 - cc.y * cc.s)
    const m = r > 0.5 ? `radial-gradient(circle at ${x.toFixed(1)}px ${y.toFixed(1)}px, transparent ${r.toFixed(1)}px, #000 ${(r + 40).toFixed(1)}px)` : "none"
    css(el.mono, "webkitMaskImage", m)
    css(el.mono, "maskImage", m)
  }
  applyNodes(S.nodes)
  op(el.black, S.black)
}

function seek(t) {
  t = clamp(t, 0, window.DURATION)
  const S = fresh()
  cut.render(t, S, { toScreen, onWindow })
  apply(S, t)
  for (const p of phrases) p.render(t)
}

window.DURATION = 40
window.CUT = CUT_ID
window.seek = seek
window.filmReady = init().then(() => true)
window.filmReady.catch((e) => { window.filmError = String(e && e.stack || e) })
