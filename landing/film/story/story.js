/*
 * Story cuts of the launch film: one real editing session in Design Layer,
 * told three ways (cuts.js). Every frame of the app is a real capture of the
 * session (frames/, from designlayer-demos/story/capture-story.mjs); the film
 * only moves the camera, the pointer and the light, types into real fields by
 * revealing the captured text, and crossfades between captured states at the
 * moment an action causes them. Like ../film.js, window.seek(t) is a pure
 * function of time, so render.mjs can step it frame by frame.
 */
import { CUTS } from "./cuts.js"

const params = new URLSearchParams(location.search)
const CUT_ID = params.get("cut") || "d"
const FRAMES = "frames/"
export const FRAME_NAMES = ["app", "bare", "h1", "picker", "picker-typed", "indigo", "note-empty", "note-text", "note-saved", "changes", "sent"]

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
for (const id of ["film", "stage", "world", "win", "vp", "cam", "shade", "stripL", "stripR", "typeMask", "caret", "spot", "ring", "cursor", "crops", "term", "termText",
  "code", "codeFile", "codeBody", "callouts", "type", "keys", "logo", "logoIcon", "logoMark", "logoSub", "logoUrl", "black"]) el[id] = $(id)
const css = (e, prop, v) => {
  if (e.__s?.[prop] === v) return
  ;(e.__s ??= {})[prop] = v
  e.style[prop] = v
}
const op = (e, v) => css(e, "opacity", String(Math.round(clamp(v, 0, 1) * 1000) / 1000))
const vis = (e, on) => css(e, "visibility", on ? "visible" : "hidden")
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
    el.cam.insertBefore(img, el.stripL)
    frameImg[name] = img
    jobs.push(loadImg(img, `${FRAMES}${name}.jpg`))
  }
  jobs.push(loadImg(el.stripL.querySelector("img"), `${FRAMES}bare.jpg`), loadImg(el.stripR.querySelector("img"), `${FRAMES}bare.jpg`), loadImg(el.logoIcon, el.logoIcon.src))
  await Promise.all(jobs)
  el.stripL.style.clipPath = `inset(0 ${(1 - 0.175) * 100}% 0 0)`
  el.stripR.style.clipPath = `inset(0 0 0 ${0.825 * 100}%)`
  buildTerm(agent)
  try {
    const model = parseDiff(await (await fetch(`${FRAMES}diff.txt`, { cache: "no-store" })).text())
    if (model) buildDiff(model)
  } catch {}
  // the fields the film types into: their background (the field's most common
  // colour) and the captured lines of text in them
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
  rects.typeColor = field(rects.pickerTyped, "picker-typed")
  rects.typeNote = field(rects.composerField, "note-text")
  window.__typing = { color: rects.typeColor, note: rects.typeNote }
  cut = CUTS[CUT_ID]({ R: rects, E, FIT, prog, track, path, clampCam, lerp, clamp })
  for (const [i, p] of (cut.type || []).entries()) phrases.push(new Phrase(p, i))
  await document.fonts.load('600 100px "InterFilm"')
  await document.fonts.ready
  window.DURATION = cut.duration
  seek(0)
}

function fresh() {
  return { win: { op: 0, x: 0, y: 0, s: 0.86 }, frames: {}, cam: { x: 800, y: 500, s: FIT }, strips: null, typing: null, spot: null, cursor: null, ring: null, crops: [], term: null, code: null, callouts: [], keys: null, logo: null, black: 0 }
}

/** Window-space → screen: where a point of the shot is on the 1920×1080 frame, for callouts. */
function toScreen(S, x, y) {
  const c = clampCam(S.cam)
  const vx = x * c.s + (VW / 2 - c.x * c.s), vy = y * c.s + (VH / 2 - c.y * c.s)
  const w = S.win
  if (w.rect) return { x: w.rect.x + vx, y: w.rect.y + vy }
  return { x: 960 + w.x + w.s * (vx - 720), y: 540 + w.y + w.s * (vy + 36 - 468) }
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
    css(el.win, "transform", "none")
  } else {
    VW = 1440
    VH = 900
    Object.assign(el.win.style, { left: "240px", top: "72px", width: "1440px", height: "936px", borderRadius: "14px" })
    Object.assign(el.vp.style, { top: "36px", width: "1440px", height: "900px" })
    css(el.win.firstElementChild, "display", "flex")
    css(el.win, "transform", `translate(${w.x.toFixed(2)}px, ${w.y.toFixed(2)}px) scale(${w.s.toFixed(4)})`)
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
      css(img, "transform", `translate(${(-c.src.x * k).toFixed(2)}px, ${(-c.src.y * k).toFixed(2)}px) scale(${k.toFixed(4)})`)
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
  op(el.black, S.black)
}

function seek(t) {
  t = clamp(t, 0, window.DURATION)
  const S = fresh()
  cut.render(t, S, { toScreen })
  apply(S, t)
  for (const p of phrases) p.render(t)
}

window.DURATION = 40
window.CUT = CUT_ID
window.seek = seek
window.filmReady = init().then(() => true)
window.filmReady.catch((e) => { window.filmError = String(e && e.stack || e) })
