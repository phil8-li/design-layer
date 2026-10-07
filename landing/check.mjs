#!/usr/bin/env node
/**
 * Pre-ship checks for the static landing page in this directory.
 *
 *   node landing/check.mjs                    static + browser checks
 *   node landing/check.mjs --only static      no browser
 *   node landing/check.mjs --only browser
 *   node landing/check.mjs --shots-only       just the screenshots
 *   node landing/check.mjs --keep             leave the server up afterwards
 *   node landing/check.mjs --root <dir>       check another directory
 *
 * Static checks read the files: index.html parses, head metadata, one <h1>,
 * heading order, <img> alt/width/height, every local reference (HTML, CSS
 * url()/@import, relative JS imports, the manifest) resolves, external
 * target=_blank links carry rel=noopener, no inline on* handlers, the WebGL
 * backgrounds' colours are --accent tokens, and the weight budget.
 *
 * Browser checks load the page through serve.mjs in headless Chromium at four
 * viewports, in light and dark when the page declares both (color-scheme,
 * a prefers-color-scheme query, or light-dark()), otherwise in its own scheme:
 * console and page errors, failed same-origin requests, horizontal overflow,
 * images decoded after scrolling the whole page, text contrast, accessible
 * names and 24x24 targets, a visible focus indicator on the first 15 Tab stops,
 * and no running animations under prefers-reduced-motion except inside
 * [data-allow-motion]. Full-page screenshots go to .check/<w>x<h>-<scheme>.png.
 *
 * Exemptions, all from WCAG: contrast skips disabled controls, text under
 * [aria-hidden=true] (decorative) and text under [inert] (set aside by the
 * page, such as a scroll scene's outgoing copy), and counts text over an image, video,
 * canvas or background-image as unverified instead of guessing. Target size
 * exempts links inline in a sentence; the spacing exception is not applied.
 *
 * Playwright is found the way tools/icon-optics.mjs finds it, after
 * SITE_PLAYWRIGHT_DIR (a project or node_modules directory) when that is set.
 * Without it the browser checks are reported SKIPPED and only the static
 * checks decide the exit code.
 */

import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { startServer } from "./serve.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VIEWPORTS = [[375, 812], [768, 1024], [1440, 900], [1920, 1080]]
const KB = 1024
// core was 150 KB until the WebGL backgrounds (backgrounds.js, 11 KB) joined the first view,
// then 165 KB until the hero's app token and the footer's inspector (about 12 KB) joined it.
const BUDGET = { core: 180 * KB, image: 700 * KB, video: 4 * KB * KB, firstView: 2.5 * KB * KB }
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".svg", ".ico"])
const VIDEO_EXT = new Set([".webm", ".mp4", ".mov", ".ogv"])
const FONT_EXT = new Set([".woff2", ".woff", ".ttf", ".otf"])
const MAX_LINES = 10

const args = process.argv.slice(2)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const only = option("--only")
const keep = args.includes("--keep")
const shotsOnly = args.includes("--shots-only")
const ROOT = path.resolve(option("--root") ?? HERE)
const SHOTS = path.join(ROOT, ".check")

if (only && only !== "static" && only !== "browser") {
  console.error("usage: node landing/check.mjs [--only static|browser] [--shots-only] [--keep] [--root <dir>]")
  process.exit(2)
}

/* ---------- reporting ---------- */

const results = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const size = (bytes) => (bytes >= KB * KB ? `${(bytes / KB / KB).toFixed(2)} MB` : `${(bytes / KB).toFixed(1)} KB`)
const rel = (file) => path.relative(ROOT, file) || "."

function report(name, pass, detail = "", lines = []) {
  results.push({ name, pass })
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`)
  for (const line of lines.slice(0, MAX_LINES)) console.log(`    ${line}`)
  if (lines.length > MAX_LINES) console.log(`    … ${lines.length - MAX_LINES} more`)
}

/* ---------- HTML ---------- */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"])
const RAW_TEXT = new Set(["script", "style", "textarea", "title"])
const OPTIONAL_END = new Set(["html", "head", "body", "p", "li", "dt", "dd", "option", "optgroup", "tr", "td", "th", "thead", "tbody", "tfoot", "colgroup", "caption", "rt", "rp"])

/** A forgiving tokenizer: start tags with attributes, raw text of script/style/title, and structural errors. */
function parseHtml(src) {
  const lineStarts = [0]
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1)
  const lineAt = (pos) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const tags = []
  const errors = []
  const stack = []
  let doctype = false
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf("<", i)
    if (lt < 0) break
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4)
      if (end < 0) {
        errors.push(`unclosed comment at line ${lineAt(lt)}`)
        break
      }
      i = end + 3
      continue
    }
    if (src[lt + 1] === "!" || src[lt + 1] === "?") {
      const end = src.indexOf(">", lt)
      if (/^<!doctype\s+html/i.test(src.slice(lt, lt + 20))) doctype = true
      i = end < 0 ? src.length : end + 1
      continue
    }
    const close = src[lt + 1] === "/"
    const nameMatch = /^[a-zA-Z][\w:-]*/.exec(src.slice(lt + (close ? 2 : 1), lt + 64))
    if (!nameMatch) {
      i = lt + 1
      continue
    }
    const name = nameMatch[0].toLowerCase()
    let j = lt + (close ? 2 : 1) + nameMatch[0].length
    const attrs = {}
    let selfClose = false
    for (;;) {
      while (j < src.length && /\s/.test(src[j])) j++
      if (j >= src.length) break
      if (src[j] === ">") { j++; break }
      if (src.startsWith("/>", j)) { selfClose = true; j += 2; break }
      if (src[j] === "/") { j++; continue }
      const start = j
      while (j < src.length && !/[\s=>]/.test(src[j]) && !src.startsWith("/>", j)) j++
      const attr = src.slice(start, j).toLowerCase()
      while (j < src.length && /\s/.test(src[j])) j++
      let value = ""
      if (src[j] === "=") {
        j++
        while (j < src.length && /\s/.test(src[j])) j++
        const quote = src[j]
        if (quote === '"' || quote === "'") {
          const end = src.indexOf(quote, j + 1)
          value = src.slice(j + 1, end < 0 ? src.length : end)
          j = end < 0 ? src.length : end + 1
        } else {
          const vs = j
          while (j < src.length && !/[\s>]/.test(src[j])) j++
          value = src.slice(vs, j)
        }
      }
      if (attr && !(attr in attrs)) attrs[attr] = decodeEntities(value)
    }
    const line = lineAt(lt)
    if (close) {
      const at = stack.findLastIndex((open) => open.name === name)
      if (at < 0) {
        if (!OPTIONAL_END.has(name)) errors.push(`stray </${name}> at line ${line}`)
      } else {
        for (const open of stack.splice(at).slice(1)) {
          if (!OPTIONAL_END.has(open.name)) errors.push(`<${open.name}> at line ${open.line} is not closed before </${name}> at line ${line}`)
        }
      }
      i = j
      continue
    }
    const tag = { name, attrs, line, text: "" }
    tags.push(tag)
    i = j
    if (RAW_TEXT.has(name) && !selfClose) {
      const end = src.toLowerCase().indexOf(`</${name}`, i)
      if (end < 0) {
        errors.push(`<${name}> at line ${line} is never closed`)
        break
      }
      tag.text = src.slice(i, end)
      i = src.indexOf(">", end) + 1 || src.length
      continue
    }
    if (!VOID.has(name) && !selfClose) stack.push(tag)
  }
  for (const open of stack) if (!OPTIONAL_END.has(open.name)) errors.push(`<${open.name}> at line ${open.line} is never closed`)
  if (!doctype) errors.unshift("missing <!doctype html>")
  return { tags, errors }
}

function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const lower = e.toLowerCase()
    if (lower[0] === "#") return String.fromCodePoint(lower[1] === "x" ? parseInt(lower.slice(2), 16) : Number(lower.slice(1)))
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" }[lower]
  })
}

const relList = (tag) => (tag.attrs.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean)
const isExternal = (ref) => /^[a-z][a-z\d+.-]*:/i.test(ref) || ref.startsWith("//")
const srcsetUrls = (value) => value.split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean)

/** Resolve a reference against the file it appears in. null for external, { file, fragment } otherwise. */
function resolveRef(ref, from) {
  ref = ref.trim()
  if (!ref || isExternal(ref)) return null
  const hash = ref.indexOf("#")
  const fragment = hash >= 0 ? ref.slice(hash + 1) : ""
  let pathPart = (hash >= 0 ? ref.slice(0, hash) : ref).split("?")[0]
  if (!pathPart) return { file: from, fragment, same: true }
  try {
    pathPart = decodeURIComponent(pathPart)
  } catch {}
  let file = pathPart.startsWith("/") ? path.join(ROOT, pathPart) : path.resolve(path.dirname(from), pathPart)
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return { file, fragment, escapes: true }
  if (fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()) file = path.join(file, "index.html")
  return { file, fragment }
}

const exists = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false
const fileSize = (file) => fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0

function cssRefs(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const refs = []
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) refs.push({ ref: m[1] ?? m[2] ?? m[3], kind: "url" })
  for (const m of css.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) refs.push({ ref: m[1] ?? m[2], kind: "import" })
  return refs.filter((r) => r.ref && !r.ref.startsWith("data:") && !r.ref.startsWith("#"))
}

function jsImports(js) {
  const refs = []
  for (const m of js.matchAll(/(?:^|[;\s])(?:import|export)\s[^"'`;]*?from\s*["'](\.{1,2}\/[^"']+|\/[^"']+)["']/g)) refs.push(m[1])
  for (const m of js.matchAll(/(?:^|[;\s])import\s*["'](\.{1,2}\/[^"']+|\/[^"']+)["']/g)) refs.push(m[1])
  for (const m of js.matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+|\/[^"']+)["']\s*\)/g)) refs.push(m[1])
  return refs
}

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue
    const full = path.join(dir, entry.name)
    // Every rendered film cut, kept for reference in LFS. The page never loads
    // them and the deploy leaves film/ out, so they are not in the budget.
    if (full === path.join(ROOT, "film", "iterations")) continue
    if (entry.isDirectory()) walkFiles(full, out)
    else out.push(full)
  }
  return out
}

/* ---------- static checks ---------- */

function staticChecks() {
  console.log("\nstatic")
  const index = path.join(ROOT, "index.html")
  if (!exists(index)) {
    report("index.html exists and parses", false, `no file at ${index}`)
    return false
  }
  const html = fs.readFileSync(index, "utf8")
  const { tags, errors } = parseHtml(html)
  report("index.html exists and parses", errors.length === 0, errors.length ? `${errors.length} problem(s)` : `${tags.length} elements`, errors)
  const all = (name) => tags.filter((t) => t.name === name)
  const lineOf = (pos) => html.slice(0, pos).split("\n").length
  const ids = new Set(tags.map((t) => t.attrs.id).filter(Boolean))

  // Metadata.
  const meta = (key, value) => all("meta").find((t) => (t.attrs[key] ?? "").toLowerCase() === value)
  const links = all("link")
  const missing = []
  if (!all("html")[0]?.attrs.lang?.trim()) missing.push("<html lang>")
  if (!all("title")[0]?.text.trim()) missing.push("<title>")
  if (!meta("name", "description")?.attrs.content?.trim()) missing.push('<meta name="description">')
  if (!meta("name", "viewport")?.attrs.content?.includes("width=device-width")) missing.push('<meta name="viewport" content="width=device-width, …">')
  for (const og of ["og:title", "og:description", "og:image"]) if (!meta("property", og)?.attrs.content?.trim()) missing.push(`<meta property="${og}">`)
  if (!links.some((t) => relList(t).includes("canonical") && t.attrs.href) && !meta("property", "og:url")?.attrs.content) missing.push('<link rel="canonical"> or og:url')
  if (!links.some((t) => relList(t).includes("icon") && t.attrs.href)) missing.push('<link rel="icon">')
  const title = all("title")[0]?.text.trim()
  report("head metadata", missing.length === 0, missing.length ? `missing ${missing.length}` : `title "${title}"`, missing)

  // Headings.
  const h1s = all("h1")
  report("exactly one <h1>", h1s.length === 1, `found ${h1s.length}${h1s.length > 1 ? ` (lines ${h1s.map((t) => t.line).join(", ")})` : ""}`)
  const skips = []
  let previous = 1
  for (const tag of tags) {
    const level = /^h([1-6])$/.exec(tag.name)?.[1]
    if (!level) continue
    if (Number(level) > previous + 1) skips.push(`h${previous} → ${tag.name} at line ${tag.line}`)
    previous = Number(level)
  }
  report("heading levels do not skip", skips.length === 0, skips.length ? `${skips.length} skip(s)` : "", skips)

  // Images.
  const badImages = []
  for (const img of all("img")) {
    const lacks = ["alt", "width", "height"].filter((a) => !(a in img.attrs))
    if (lacks.length) badImages.push(`line ${img.line} ${img.attrs.src ?? "(no src)"}: no ${lacks.join(", ")}`)
  }
  report("<img> has alt, width and height", badImages.length === 0, `${all("img").length} image(s)`, badImages)

  // Local references, collected with the first-view set as we go.
  const refs = [] // { ref, from, where }
  const cssFiles = []
  const jsFiles = []
  const firstView = new Map() // file -> category
  const addFirst = (file, category) => { if (exists(file) && !firstView.has(file)) firstView.set(file, category) }
  const REF_ATTRS = { href: ["a", "link", "area"], src: ["img", "script", "source", "iframe", "video", "audio", "track", "embed", "input"], poster: ["video"], data: ["object"] }
  for (const tag of tags) {
    for (const [attr, names] of Object.entries(REF_ATTRS)) {
      if (names.includes(tag.name) && tag.attrs[attr]) refs.push({ ref: tag.attrs[attr], from: index, where: `<${tag.name} ${attr}> line ${tag.line}` })
    }
    if (tag.attrs.srcset) for (const ref of srcsetUrls(tag.attrs.srcset)) refs.push({ ref, from: index, where: `<${tag.name} srcset> line ${tag.line}` })
    if (tag.name === "meta" && /^(og:image(:url|:secure_url)?|twitter:image)$/.test(tag.attrs.property ?? tag.attrs.name ?? "") && tag.attrs.content) {
      // An absolute URL under the page's own canonical address is a file in
      // this site, and a share card pointing at a file that was never
      // published is exactly the mistake worth catching.
      const canonical = links.find((t) => relList(t).includes("canonical"))?.attrs.href ?? ""
      const content = tag.attrs.content
      const local = canonical && content.startsWith(canonical) ? content.slice(canonical.length) : content
      if (!isExternal(local)) refs.push({ ref: local, from: index, where: `<meta ${tag.attrs.property ?? tag.attrs.name}> line ${tag.line}` })
    }
    if (tag.attrs.style) for (const { ref } of cssRefs(tag.attrs.style)) refs.push({ ref, from: index, where: `style attribute line ${tag.line}` })
    if (tag.name === "style") for (const { ref } of cssRefs(tag.text)) refs.push({ ref, from: index, where: `<style> line ${tag.line}` })
  }
  addFirst(index, "html")
  const queueCss = (file) => { if (exists(file) && !cssFiles.includes(file)) cssFiles.push(file) }
  const queueJs = (file) => { if (exists(file) && !jsFiles.includes(file)) jsFiles.push(file) }
  for (const tag of links) {
    const target = tag.attrs.href && resolveRef(tag.attrs.href, index)
    if (!target || target.escapes) continue
    const rels = relList(tag)
    if (rels.includes("stylesheet")) queueCss(target.file)
    if (rels.includes("modulepreload")) queueJs(target.file)
    if (rels.some((r) => r === "icon" || r === "apple-touch-icon")) addFirst(target.file, "images")
    if (rels.includes("manifest") && exists(target.file)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(target.file, "utf8"))
        const where = `manifest ${rel(target.file)}`
        for (const item of [...(manifest.icons ?? []), ...(manifest.screenshots ?? [])]) if (item.src) refs.push({ ref: item.src, from: target.file, where })
        for (const shortcut of manifest.shortcuts ?? []) {
          if (shortcut.url) refs.push({ ref: shortcut.url, from: target.file, where })
          for (const icon of shortcut.icons ?? []) if (icon.src) refs.push({ ref: icon.src, from: target.file, where })
        }
        if (manifest.start_url) refs.push({ ref: manifest.start_url, from: target.file, where })
      } catch (error) {
        refs.push({ ref: "", from: target.file, where: `manifest ${rel(target.file)} is not valid JSON: ${error.message}`, broken: true })
      }
    }
  }
  for (const tag of all("script")) {
    const target = tag.attrs.src && resolveRef(tag.attrs.src, index)
    if (target && !target.escapes) queueJs(target.file)
    if (!tag.attrs.src && tag.attrs.type === "module") for (const ref of jsImports(tag.text)) refs.push({ ref, from: index, where: `inline module line ${tag.line}` })
  }
  for (let k = 0; k < cssFiles.length; k++) {
    const file = cssFiles[k]
    addFirst(file, "css")
    for (const { ref, kind } of cssRefs(fs.readFileSync(file, "utf8"))) {
      refs.push({ ref, from: file, where: rel(file) })
      const target = resolveRef(ref, file)
      if (!target || target.escapes) continue
      if (kind === "import") queueCss(target.file)
      else addFirst(target.file, FONT_EXT.has(path.extname(target.file).toLowerCase()) ? "fonts" : "images")
    }
  }
  for (let k = 0; k < jsFiles.length; k++) {
    const file = jsFiles[k]
    addFirst(file, "js")
    for (const ref of jsImports(fs.readFileSync(file, "utf8"))) {
      refs.push({ ref, from: file, where: rel(file) })
      const target = resolveRef(ref, file)
      if (target && !target.escapes) queueJs(target.file)
    }
  }
  const broken = []
  let checked = 0
  for (const { ref, from, where, broken: known } of refs) {
    if (known) { broken.push(where); continue }
    const target = resolveRef(ref, from)
    if (!target) continue
    checked++
    if (target.escapes) broken.push(`${where}: ${ref} points outside the site root`)
    else if (!exists(target.file)) broken.push(`${where}: ${ref} → ${rel(target.file)} does not exist`)
    else if (target.fragment && target.file === index && !ids.has(decodeURIComponent(target.fragment))) broken.push(`${where}: ${ref} → no element with id "${target.fragment}"`)
  }
  report("local references resolve", broken.length === 0, `${checked} checked`, broken)

  // External links opened in a new tab.
  const openers = all("a").concat(all("area")).filter((t) => t.attrs.target === "_blank" && isExternal(t.attrs.href ?? "") && !/^(mailto|tel):/i.test(t.attrs.href))
  const unsafe = openers.filter((t) => !relList(t).some((r) => r === "noopener" || r === "noreferrer")).map((t) => `line ${t.line} ${t.attrs.href}`)
  report('target=_blank links have rel="noopener"', unsafe.length === 0, `${openers.length} link(s)`, unsafe)

  // Inline handlers.
  const handlers = tags.flatMap((t) => Object.keys(t.attrs).filter((a) => /^on[a-z]+$/.test(a)).map((a) => `line ${t.line} <${t.name} ${a}>`))
  report("no inline event handlers", handlers.length === 0, handlers.length ? `${handlers.length} found` : "", handlers)

  // Explanations live in the visual (DESIGN.md): in a pinned feature section,
  // no text follows the frame except the terminal, which is part of the visual.
  const captions = []
  for (const m of html.matchAll(/<section\b[^>]*class="[^"]*\bsection-pinned\b[^"]*"[^>]*>([\s\S]*?)<\/section>/g)) {
    const body = m[1]
    const start = body.search(/<div class="frame\b/)
    if (start < 0) continue
    let depth = 0
    let end = start
    for (const tag of body.slice(start).matchAll(/<\/?div\b[^>]*>/g)) {
      depth += tag[0][1] === "/" ? -1 : 1
      if (depth === 0) {
        end = start + tag.index + tag[0].length
        break
      }
    }
    const after = body.slice(end).replace(/<figure class="terminal[\s\S]*?<\/figure>/g, "").replace(/<[^>]+>/g, "").trim()
    if (after) captions.push(`line ${lineOf(m.index + m[0].indexOf(">") + 1 + end)}: "${after.replace(/\s+/g, " ").slice(0, 60)}"`)
  }
  report("no caption text under a feature visual", captions.length === 0, captions.length ? `${captions.length} found` : "", captions)

  // The WebGL backgrounds' colours: indigo accent tokens only (DESIGN.md), not
  // the palette an effect ships with.
  const shaders = path.join(ROOT, "backgrounds.js")
  const sheet = path.join(ROOT, "styles.css")
  if (exists(shaders) && exists(sheet)) {
    const accents = new Set([...fs.readFileSync(sheet, "utf8").matchAll(/--accent[\w-]*:\s*(#[0-9a-f]{6})\b/gi)].map((m) => m[1].toLowerCase()))
    const strays = [...fs.readFileSync(shaders, "utf8").matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toLowerCase()).filter((hex) => !accents.has(hex))
    report("backgrounds use the accent colours", strays.length === 0, `${accents.size} accent token(s)`, strays.map((hex) => `backgrounds.js: ${hex} is not an --accent token in styles.css`))
  }

  // Lazy and eager media for the first view. A <picture> counts its largest candidate, an upper bound.
  for (const tag of tags) {
    if (tag.name === "img" && tag.attrs.loading !== "lazy") {
      const candidates = [tag.attrs.src, ...srcsetUrls(tag.attrs.srcset ?? "")]
      const at = tags.indexOf(tag)
      for (let k = at - 1; k >= 0 && tags[k].name === "source"; k--) candidates.push(...srcsetUrls(tags[k].attrs.srcset ?? ""))
      const files = candidates.filter(Boolean).map((ref) => resolveRef(ref, index)).filter((t) => t && !t.escapes && exists(t.file)).map((t) => t.file)
      const largest = files.sort((a, b) => fileSize(b) - fileSize(a))[0]
      if (largest) addFirst(largest, "images")
    }
    if (tag.name === "video") {
      const poster = tag.attrs.poster && resolveRef(tag.attrs.poster, index)
      if (poster && !poster.escapes) addFirst(poster.file, "images")
      if ("autoplay" in tag.attrs) {
        const sources = [tag.attrs.src]
        for (let k = tags.indexOf(tag) + 1; k < tags.length && tags[k].name === "source"; k++) sources.push(tags[k].attrs.src)
        const files = sources.filter(Boolean).map((ref) => resolveRef(ref, index)).filter((t) => t && !t.escapes && exists(t.file)).map((t) => t.file)
        const largest = files.sort((a, b) => fileSize(b) - fileSize(a))[0]
        if (largest) addFirst(largest, "video")
      }
    }
  }

  // Budget.
  const core = [...firstView].filter(([, c]) => c === "html" || c === "css" || c === "js").map(([f]) => f)
  const coreBytes = core.reduce((sum, f) => sum + fileSize(f), 0)
  report(`budget: html+css+js < ${size(BUDGET.core)}`, coreBytes < BUDGET.core, `${size(coreBytes)} (${core.map((f) => `${rel(f)} ${size(fileSize(f))}`).join(", ")})`)
  const media = walkFiles(ROOT).map((f) => ({ file: f, ext: path.extname(f).toLowerCase(), bytes: fileSize(f) }))
  for (const [label, exts, limit] of [["image", IMAGE_EXT, BUDGET.image], ["video", VIDEO_EXT, BUDGET.video]]) {
    const files = media.filter((m) => exts.has(m.ext)).sort((a, b) => b.bytes - a.bytes)
    const over = files.filter((m) => m.bytes >= limit).map((m) => `${rel(m.file)} ${size(m.bytes)}`)
    const detail = files.length ? `largest ${rel(files[0].file)} ${size(files[0].bytes)} of ${files.length}` : `no ${label} files`
    report(`budget: each ${label} < ${size(limit)}`, over.length === 0, detail, over)
  }
  const byCategory = {}
  for (const [file, category] of firstView) byCategory[category] = (byCategory[category] ?? 0) + fileSize(file)
  const total = Object.values(byCategory).reduce((a, b) => a + b, 0)
  const order = ["html", "css", "js", "images", "fonts", "video"]
  const breakdown = order.filter((c) => byCategory[c]).map((c) => `${c} ${size(byCategory[c])}`).join(", ")
  const heaviest = [...firstView.keys()].sort((a, b) => fileSize(b) - fileSize(a)).slice(0, 5).map((f) => `${rel(f)} ${size(fileSize(f))}`)
  report(`budget: first view < ${size(BUDGET.firstView)}`, total < BUDGET.firstView, `${size(total)} in ${firstView.size} files (${breakdown})`, total < BUDGET.firstView ? [] : heaviest)
  return true
}

/* ---------- Playwright ---------- */

function loadPlaywright() {
  const require = createRequire(import.meta.url)
  const dir = process.env.SITE_PLAYWRIGHT_DIR
  if (dir) {
    try {
      return path.basename(dir) === "node_modules"
        ? createRequire(path.join(dir, "playwright", "package.json"))("playwright")
        : createRequire(path.join(path.resolve(dir), "package.json"))("playwright")
    } catch {}
  }
  try {
    return require("playwright")
  } catch {}
  for (const root of [path.join(process.env.HOME ?? "", ".npm", "_npx"), "/opt/homebrew/lib/node_modules"]) {
    if (!fs.existsSync(root)) continue
    const stack = [root]
    while (stack.length) {
      const dir = stack.pop()
      for (const anchor of ["playwright/index.js", "@playwright/mcp/cli.js"]) {
        const file = path.join(dir, "node_modules", anchor)
        if (fs.existsSync(file)) {
          try {
            return createRequire(file)("playwright")
          } catch {}
        }
      }
      if (dir.split(path.sep).length - root.split(path.sep).length < 2) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) stack.push(path.join(dir, entry.name))
      }
    }
  }
  throw new Error("Playwright not found")
}

/* ---------- in-page probes (serialized into the page) ---------- */

const DESCRIBE = String.raw`
window.__siteCheckDescribe = (el) => {
  if (!el || !el.tagName) return String(el)
  let s = el.tagName.toLowerCase()
  if (el.id) s += "#" + el.id
  else if (typeof el.className === "string" && el.className.trim()) s += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
  const text = (el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ")
  return text ? s + ' "' + (text.length > 40 ? text.slice(0, 40) + "…" : text) + '"' : s
}
`

const PAGE_HELPERS = DESCRIBE + String.raw`
window.__siteCheck = (() => {
  const describe = window.__siteCheckDescribe
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  const cache = new Map()
  const rgba = (color) => {
    if (cache.has(color)) return cache.get(color)
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = "rgba(0,0,0,0)"
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    const value = [r, g, b, a / 255]
    cache.set(color, value)
    return value
  }
  const blend = (top, bottom) => {
    const a = top[3] + bottom[3] * (1 - top[3])
    if (!a) return [0, 0, 0, 0]
    return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat(a)
  }
  const luminance = ([r, g, b]) => {
    const f = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const hex = (c) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const settle = (ms = 1500) => Promise.race([
    Promise.all(document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime)).map((a) => a.finished.catch(() => {}))),
    new Promise((r) => setTimeout(r, ms)),
  ])
  const MEDIA = new Set(["IMG", "VIDEO", "CANVAS", "PICTURE", "IFRAME", "OBJECT", "EMBED", "svg"])

  function canvasColor() {
    const html = rgba(getComputedStyle(document.documentElement).backgroundColor)
    if (html[3] > 0 || !document.body) return html[3] >= 1 ? html : blend(html, systemCanvas())
    const body = rgba(getComputedStyle(document.body).backgroundColor)
    return body[3] >= 1 ? body : blend(body, systemCanvas())
  }
  function systemCanvas() {
    const probe = document.createElement("div")
    probe.style.cssText = "position:absolute;width:0;height:0;background-color:Canvas"
    document.documentElement.append(probe)
    const color = rgba(getComputedStyle(probe).backgroundColor)
    probe.remove()
    return color[3] ? color : [255, 255, 255, 1]
  }

  /** Background under the text at (x, y): layers painted below el, top-down, until opaque. */
  function background(el, x, y, base) {
    const stack = document.elementsFromPoint(x, y)
    const at = stack.indexOf(el)
    const layers = []
    let below
    if (at >= 0) below = stack.slice(at)
    else {
      below = []
      for (let node = el; node; node = node.parentElement) below.push(node)
    }
    const bodyPropagated = rgba(getComputedStyle(document.documentElement).backgroundColor)[3] === 0
    for (const node of below) {
      if (node === document.documentElement) break
      if (node === document.body && bodyPropagated) break
      if (node !== el && MEDIA.has(node.tagName) && !node.contains(el)) return { unverified: "over " + node.tagName.toLowerCase() }
      const cs = getComputedStyle(node)
      if (cs.backgroundImage !== "none") return { unverified: "over background-image on " + describe(node) }
      const color = rgba(cs.backgroundColor)
      if (color[3] > 0) layers.push(color)
      if (color[3] >= 1) break
    }
    let result = layers.length && layers[layers.length - 1][3] >= 1 ? [0, 0, 0, 0] : base
    for (const layer of layers.reverse()) result = blend(layer, result)
    return { color: result }
  }

  async function contrast() {
    // The hero's app word cycles on a timer; a pointer over it holds it still,
    // so a sample never lands on a word mid-fade.
    document.querySelector("[data-token]")?.dispatchEvent(new PointerEvent("pointerenter"))
    await settle()
    const base = canvasColor()
    const seen = new Set()
    const items = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement
      if (!el || seen.has(el) || !node.textContent.trim()) continue
      // [inert] is content the page has set aside: a scene's outgoing text,
      // mid-fade and unreachable. It is not being offered to be read.
      if (el.closest("script,style,noscript,template,svg,option,[aria-hidden=true],[inert]") || el.closest(":disabled,[aria-disabled=true]")) continue
      seen.add(el)
      items.push({ el, node })
    }
    const offenders = []
    let checked = 0
    let unverified = 0
    for (const { el, node } of items) {
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      let rect = [...range.getClientRects()].find((r) => r.width > 1 && r.height > 1)
      const box = el.getBoundingClientRect()
      if (!rect || box.width <= 1 || box.height <= 1) continue
      const pageTop = rect.top + scrollY
      if (rect.right < 0 || pageTop + rect.height < 0 || rect.left > document.documentElement.scrollWidth) continue
      const midY = rect.top + rect.height / 2
      if (midY < innerHeight * 0.2 || midY > innerHeight * 0.8) {
        scrollTo({ top: pageTop + rect.height / 2 - innerHeight / 2, behavior: "instant" })
        await frame()
        await settle(800)
        rect = [...range.getClientRects()].find((r) => r.width > 1 && r.height > 1) ?? rect
        // Scrolling can move a scroll-driven scene on: text it has since set
        // aside is no longer offered to be read.
        if (el.closest("[inert]")) continue
      }
      const x = Math.min(Math.max(rect.left + Math.min(rect.width / 2, 8), 0), innerWidth - 1)
      const y = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1)
      const bg = background(el, x, y, base)
      if (bg.unverified) { unverified++; continue }
      const cs = getComputedStyle(el)
      const fg = rgba(cs.color)
      let opacity = 1
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        opacity *= Number(getComputedStyle(n).opacity)
        if (rgba(getComputedStyle(n).backgroundColor)[3] > 0) break
      }
      if (fg[3] * opacity === 0) { unverified++; continue }
      const ink = blend([fg[0], fg[1], fg[2], fg[3] * opacity], bg.color)
      const [l1, l2] = [luminance(ink), luminance(bg.color)].sort((a, b) => b - a)
      const ratio = (l1 + 0.05) / (l2 + 0.05)
      const px = parseFloat(cs.fontSize)
      const large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700)
      const need = large ? 3 : 4.5
      checked++
      if (ratio + 0.001 < need) {
        offenders.push(describe(el) + " " + ratio.toFixed(2) + ":1 < " + need + " (" + hex(ink) + " on " + hex(bg.color) + ", " + px + "px" + (large ? " large" : "") + ")")
      }
    }
    scrollTo({ top: 0, behavior: "instant" })
    return { checked, unverified, offenders }
  }

  function textName(node) {
    if (node.nodeType === 3) return node.textContent
    if (node.nodeType !== 1 || node.getAttribute("aria-hidden") === "true") return ""
    const cs = getComputedStyle(node)
    if (cs.display === "none" || cs.visibility === "hidden") return ""
    const label = node.getAttribute("aria-label")
    if (label && label.trim()) return label
    if (node.tagName === "IMG") return node.getAttribute("alt") || ""
    if (node.tagName.toLowerCase() === "svg") return node.querySelector("title")?.textContent || ""
    return [...node.childNodes].map(textName).join(" ")
  }
  function accessibleName(el) {
    const by = el.getAttribute("aria-labelledby")
    if (by) {
      const text = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim()
      if (text) return text
    }
    const label = el.getAttribute("aria-label")
    if (label && label.trim()) return label.trim()
    if (el.tagName === "INPUT") {
      const type = el.type
      if (type === "submit" || type === "reset") return el.value || type
      if (type === "button") return el.value || el.title
      if (type === "image") return el.alt || el.title || el.value
      const labels = [...(el.labels ?? [])].map((l) => l.innerText).join(" ").trim()
      return labels || el.title || el.placeholder || ""
    }
    return textName(el).replace(/\s+/g, " ").trim() || el.title || ""
  }
  function targets() {
    const out = { checked: 0, unnamed: [], small: [] }
    for (const el of document.querySelectorAll('a[href], button, [role="button"], input:not([type="hidden"])')) {
      if (!el.checkVisibility({ visibilityProperty: true }) || el.closest("[inert]")) continue
      const rect = el.getBoundingClientRect()
      if (!rect.width && !rect.height) continue
      out.checked++
      if (!accessibleName(el)) out.unnamed.push(describe(el) + " " + el.outerHTML.slice(0, 80).replace(/\s+/g, " "))
      const inline = getComputedStyle(el).display === "inline" && [...(el.parentElement?.childNodes ?? [])].some((n) => n !== el && n.nodeType === 3 && n.textContent.trim())
      if (!inline && (rect.width < 24 || rect.height < 24)) out.small.push(describe(el) + " " + Math.round(rect.width * 10) / 10 + "x" + Math.round(rect.height * 10) / 10)
    }
    return out
  }
  function overflow() {
    const vw = innerWidth
    const sw = document.scrollingElement.scrollWidth
    const offenders = []
    if (sw > vw + 1) {
      const over = (el) => el.getBoundingClientRect().right > vw + 1
      for (const el of document.body.querySelectorAll("*")) {
        const rect = el.getBoundingClientRect()
        if (!rect.width || rect.right <= vw + 1) continue
        let clipped = false
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          if (getComputedStyle(p).overflowX !== "visible") { clipped = true; break }
        }
        if (clipped || (el.parentElement && el.parentElement !== document.body && over(el.parentElement))) continue
        offenders.push(describe(el) + " right edge " + Math.round(rect.right) + "px")
      }
    }
    return { vw, sw, offenders }
  }
  async function scrollThrough(onStep) {
    const step = Math.max(200, Math.floor(innerHeight * 0.8))
    for (let y = 0; y < document.scrollingElement.scrollHeight; y += step) {
      scrollTo({ top: y, behavior: "instant" })
      await new Promise((r) => setTimeout(r, 120))
      if (onStep) onStep()
    }
    scrollTo({ top: document.scrollingElement.scrollHeight, behavior: "instant" })
    await new Promise((r) => setTimeout(r, 150))
    if (onStep) onStep()
  }
  async function images() {
    const imgs = [...document.images].filter((img) => img.getClientRects().length)
    await Promise.all(imgs.map((img) => img.complete ? null : Promise.race([
      new Promise((r) => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }) }),
      new Promise((r) => setTimeout(r, 5000)),
    ])))
    return { total: imgs.length, broken: imgs.filter((img) => !img.naturalWidth).map((img) => (img.currentSrc || img.src).replace(location.origin, "") + " " + describe(img)) }
  }
  function focusInfo() {
    const el = document.activeElement
    if (!el || el === document.body || el === document.documentElement) return null
    if (el.tagName === "IFRAME") return { key: describe(el), desc: describe(el), ok: true }
    const cs = getComputedStyle(el)
    const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0 && rgba(cs.outlineColor)[3] > 0
    const shadow = cs.boxShadow !== "none"
    if (!el.__siteCheckKey) el.__siteCheckKey = Math.random().toString(36).slice(2)
    return { key: el.__siteCheckKey, desc: describe(el), ok: outline || shadow, focusVisible: el.matches(":focus-visible") }
  }
  function runningMotion() {
    const out = []
    for (const a of document.getAnimations()) {
      if (a.playState !== "running" || (window.CSSTransition && a instanceof CSSTransition)) continue
      const target = a.effect?.target
      const duration = a.effect?.getComputedTiming().duration
      if (!(target instanceof Element) || !(duration > 10) || target.closest("[data-allow-motion]")) continue
      out.push(describe(target) + (a.effect.pseudoElement ?? "") + " " + (a.animationName || "script animation") + " " + Math.round(duration) + "ms")
    }
    return out
  }
  function schemes() {
    const declared = (document.querySelector('meta[name="color-scheme"]')?.content ?? "") + " " + getComputedStyle(document.documentElement).colorScheme
    let query = false
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule.conditionText?.includes("prefers-color-scheme") || rule.cssText?.includes("light-dark(")) query = true
        if (rule.cssRules) visit(rule.cssRules)
      }
    }
    for (const sheet of document.styleSheets) { try { visit(sheet.cssRules) } catch {} }
    const light = /\blight\b/.test(declared)
    const dark = /\bdark\b/.test(declared)
    if ((light && dark) || query) return ["light", "dark"]
    return [dark && !light ? "dark" : "light"]
  }
  return { contrast, targets, overflow, scrollThrough, images, focusInfo, runningMotion, schemes, settle }
})()
`

// Records CSS animations as they start, so a short one that ends before we sample still counts.
const MOTION_RECORDER = DESCRIBE + String.raw`
window.__siteCheckStarted = []
document.addEventListener("animationstart", (event) => {
  const el = event.target
  const anim = el.getAnimations?.().find((a) => a.animationName === event.animationName && (a.effect?.pseudoElement ?? "") === (event.pseudoElement ?? ""))
  const duration = anim?.effect?.getComputedTiming().duration
  if (!(duration > 10) || el.closest("[data-allow-motion]")) return
  window.__siteCheckStarted.push(window.__siteCheckDescribe(el) + (event.pseudoElement || "") + " " + event.animationName + " " + Math.round(duration) + "ms")
}, true)
`

/* ---------- browser checks ---------- */

async function browserChecks(url) {
  console.log("\nbrowser")
  let playwright
  try {
    playwright = loadPlaywright()
  } catch {
    console.log("- browser checks SKIPPED — Playwright not found (set SITE_PLAYWRIGHT_DIR to a directory with it in node_modules)")
    return { skipped: true }
  }
  let browser
  try {
    browser = await playwright.chromium.launch()
  } catch (error) {
    console.log(`- browser checks SKIPPED — Chromium did not launch: ${error.message.split("\n")[0]}`)
    return { skipped: true }
  }
  fs.mkdirSync(SHOTS, { recursive: true })
  fs.writeFileSync(path.join(SHOTS, ".gitignore"), "*\n")
  const origin = new URL(url).origin
  try {
    const probe = await browser.newPage()
    await probe.goto(`${url}/`, { waitUntil: "load" })
    await probe.evaluate(PAGE_HELPERS)
    const schemes = await probe.evaluate(() => window.__siteCheck.schemes())
    await probe.close()
    console.log(`  color schemes: ${schemes.join(", ")}${schemes.length === 1 ? " (the page declares only this one)" : ""}`)

    // check name -> { runs, failures: Map<line, labels[]>, notes[] }
    const tally = new Map()
    const record = (name, label, lines, note) => {
      if (!tally.has(name)) tally.set(name, { runs: 0, failedRuns: new Set(), lines: new Map(), notes: [] })
      const entry = tally.get(name)
      entry.runs++
      if (note) entry.notes.push(note)
      for (const line of lines) {
        entry.failedRuns.add(label)
        if (!entry.lines.has(line)) entry.lines.set(line, [])
        entry.lines.get(line).push(label)
      }
    }

    for (const [width, height] of VIEWPORTS) {
      for (const scheme of schemes) {
        const label = `${width}x${height} ${scheme}`
        const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: "no-preference" })
        await context.addInitScript(MOTION_RECORDER)
        const page = await context.newPage()
        const errors = []
        const failed = []
        page.on("pageerror", (error) => errors.push(`pageerror: ${error.message.split("\n")[0]}`))
        page.on("console", (msg) => {
          if (msg.type() !== "error") return
          const where = msg.location()?.url ?? ""
          if (msg.text().startsWith("Failed to load resource") && where.startsWith(origin)) return
          errors.push(`console: ${msg.text().split("\n")[0]}`)
        })
        page.on("response", (res) => {
          if (res.url().startsWith(origin) && res.status() >= 400) failed.push(`${res.status()} ${res.url().replace(origin, "")}`)
        })
        page.on("requestfailed", (req) => {
          const reason = req.failure()?.errorText ?? ""
          if (req.url().startsWith(origin) && !reason.includes("ERR_ABORTED")) failed.push(`${reason} ${req.url().replace(origin, "")}`)
        })

        await page.goto(`${url}/`, { waitUntil: "load" })
        await page.evaluate(PAGE_HELPERS)
        await page.evaluate(() => document.fonts.ready)
        await page.evaluate(() => window.__siteCheck.scrollThrough())
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
        const imageResult = await page.evaluate(() => window.__siteCheck.images())
        // Two frames first: a page that maps scroll to style in rAF needs one to
        // catch up with the jump, and settle() alone would measure before it.
        await page.evaluate(async () => {
          scrollTo({ top: 0, behavior: "instant" })
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
          await window.__siteCheck.settle(2000)
        })

        if (!shotsOnly) {
          const over = await page.evaluate(() => window.__siteCheck.overflow())
          record("no horizontal overflow", label, over.sw > over.vw + 1 ? [`scrollWidth ${over.sw} > ${over.vw}`, ...over.offenders] : [])
          record("images decoded after scrolling", label, imageResult.broken, `${imageResult.total} images`)
          const contrast = await page.evaluate(() => window.__siteCheck.contrast())
          record("text contrast (4.5:1, large 3:1)", label, contrast.offenders, `${contrast.checked} checked, ${contrast.unverified} unverified`)
          const t = await page.evaluate(() => window.__siteCheck.targets())
          record("interactive elements have an accessible name", label, t.unnamed, `${t.checked}`)
          record("targets at least 24x24 CSS px", label, t.small, `${t.checked}`)
        }

        await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }))
        await page.screenshot({ path: path.join(SHOTS, `${width}x${height}-${scheme}.png`), fullPage: true })

        if (!shotsOnly) {
          await page.evaluate(() => { document.activeElement?.blur?.(); scrollTo({ top: 0, behavior: "instant" }) })
          const noFocus = []
          const seenKeys = new Set()
          let stops = 0
          for (let k = 0; k < 15; k++) {
            await page.keyboard.press("Tab")
            const info = await page.evaluate(() => window.__siteCheck.focusInfo())
            if (!info || seenKeys.has(info.key)) break
            seenKeys.add(info.key)
            stops++
            if (!info.ok) noFocus.push(`${info.desc}${info.focusVisible ? "" : " (:focus-visible did not match)"}`)
          }
          record("visible focus on the first 15 Tab stops", label, noFocus, `${stops} stops`)

          await page.emulateMedia({ reducedMotion: "reduce" })
          await page.reload({ waitUntil: "load" })
          await page.evaluate(PAGE_HELPERS)
          await page.evaluate(() => {
            window.__siteCheckRunning = new Set(window.__siteCheck.runningMotion())
          })
          await page.evaluate(() => window.__siteCheck.scrollThrough(() => {
            for (const line of window.__siteCheck.runningMotion()) window.__siteCheckRunning.add(line)
          }))
          const motion = await page.evaluate(() => [...new Set([...window.__siteCheckStarted, ...window.__siteCheckRunning])])
          record("no motion under prefers-reduced-motion", label, motion)

          record("no console or page errors", label, [...new Set(errors)])
          record("no failed same-origin requests", label, [...new Set(failed)])
        }
        await context.close()
        process.stdout.write(`  ${label} done\n`)
      }
    }

    if (shotsOnly) {
      report("screenshots", true, `${VIEWPORTS.length * schemes.length} written to ${rel(SHOTS)}/`)
      return { skipped: false }
    }
    const allRuns = VIEWPORTS.length * schemes.length
    const order = [
      "no console or page errors", "no failed same-origin requests", "no horizontal overflow", "images decoded after scrolling",
      "text contrast (4.5:1, large 3:1)", "interactive elements have an accessible name", "targets at least 24x24 CSS px",
      "visible focus on the first 15 Tab stops", "no motion under prefers-reduced-motion",
    ]
    for (const name of order) {
      const entry = tally.get(name)
      const pass = entry.failedRuns.size === 0
      const lines = [...entry.lines].map(([line, labels]) => (labels.length === allRuns ? line : `${line}  [${labels.join(", ")}]`))
      const most = (pattern) => Math.max(0, ...entry.notes.map((n) => Number(pattern.exec(n)?.[1] ?? 0)))
      const note = name.startsWith("text contrast")
        ? `; up to ${most(/^(\d+) checked/)} text elements, ${most(/(\d+) unverified/)} unverified (over images/gradients)`
        : ""
      const detail = pass ? `${entry.runs} runs${note}` : `failed in ${entry.failedRuns.size}/${entry.runs} runs${note}`
      report(name, pass, detail, lines)
    }
    report("screenshots", true, `${allRuns} written to ${rel(SHOTS)}/`)
    return { skipped: false }
  } finally {
    await browser.close().catch(() => {})
  }
}

/* ---------- main ---------- */

let server = null
let code = 1
try {
  console.log(`checking ${ROOT}`)
  let staticOk = true
  if (only !== "browser" && !shotsOnly) staticOk = staticChecks()
  let skipped = false
  if (only !== "static") {
    if (!exists(path.join(ROOT, "index.html"))) {
      report("browser checks", false, "no index.html to load")
    } else {
      server = await startServer({ root: ROOT, port: 0 })
      skipped = (await browserChecks(server.url)).skipped
    }
  }
  if (keep && !server && staticOk) server = await startServer({ root: ROOT, port: 0 })
  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} passed${skipped ? "; browser checks SKIPPED" : ""}`)
  if (failed.length) console.log(`failed: ${failed.map((r) => r.name).join(", ")}`)
  code = failed.length ? 1 : 0
  if (keep && server) {
    console.log(`\nserving ${ROOT} at ${server.url}/ — Ctrl-C to stop`)
    await new Promise((resolve) => process.once("SIGINT", resolve))
  }
} catch (error) {
  console.error(`✗ harness — ${error.stack}`)
} finally {
  await server?.close()
}
process.exit(code)
