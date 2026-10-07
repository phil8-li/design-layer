#!/usr/bin/env node
/**
 * Turns full-size captures into the two widths the page serves.
 *
 *   node landing/tools/optimize-shots.mjs [--keep-originals] [--originals <dir>] [--only a,b]
 *
 * For every landing/assets/shots/<demo>/<name>.(jpg|png) it writes
 * <name>-1280.webp and <name>-2400.webp, then moves the original out of the
 * site (default ~/.cache/designlayer-site/originals/<demo>/) so the published
 * folder holds only what the page loads. A capture is re-encoded only when it
 * is newer than its outputs, so re-running after a recapture is cheap. --only
 * limits encoding to some demos, e.g. while another demo is still being shot.
 *
 * WebP because a UI screenshot is a third of the bytes it is as a JPEG at the
 * same sharpness: the 2400px hero is ~170 KB against ~500 KB.
 *
 * Also writes landing/assets/shots/demos.json from each demo's manifest.json, and
 * landing/assets/og.jpg (1200x630, JPEG because share cards want one) from the
 * first demo's hero.
 *
 * Encoding is Pillow's (`python3 -m pip install pillow`). Point SITE_PYTHON at
 * another interpreter if the default python3 lacks it.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const site = path.resolve(here, "..")
const shotsDir = path.join(site, "assets", "shots")
const args = process.argv.slice(2)
const keep = args.includes("--keep-originals")
const originalsRoot = args.includes("--originals")
  ? path.resolve(args[args.indexOf("--originals") + 1])
  : path.join(os.homedir(), ".cache", "designlayer-site", "originals")
const python = process.env.SITE_PYTHON || "python3"
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null

const WIDTHS = [1280, 2400]
// The demo the page loads by default comes first; the rest follow in review order.
const ORDER = ["midday"]
// hero-bare: hero with the toolbar hidden, under the hero's landing toolbar.
const SHOT_NAMES = ["hero", "hero-bare", "measure", "tokens", "canvas", "notes", "changes", "align", "responsive", "shortcuts", "light", "system", "audit", "options", "app-only", "direct-edit", "hidden", "options-alt"]

const ENCODER = `
import json, sys
from PIL import Image
jobs = json.loads(sys.argv[1])
for job in jobs:
    image = Image.open(job["source"]).convert("RGB")
    width = min(job["width"], image.width)
    height = round(image.height * width / image.width)
    if (width, height) != image.size:
        image = image.resize((width, height), Image.LANCZOS)
    if job.get("crop"):
        cw, ch = job["crop"]
        image = image.crop((0, 0, cw, ch))
    if job["format"] == "webp":
        image.save(job["out"], "WEBP", quality=job.get("quality", 78), method=6)
    else:
        image.save(job["out"], "JPEG", quality=job.get("quality", 82), optimize=True, progressive=True)
`

function encode(jobs) {
  if (!jobs.length) return
  try {
    execFileSync(python, ["-c", ENCODER, JSON.stringify(jobs)], { stdio: ["ignore", "inherit", "pipe"] })
  } catch (error) {
    const stderr = String(error.stderr ?? "")
    if (/No module named 'PIL'/.test(stderr)) {
      console.error(`✗ ${python} has no Pillow. Run \`${python} -m pip install pillow\`, or set SITE_PYTHON to an interpreter that has it.`)
    } else {
      console.error(`✗ encoding failed: ${stderr.trim() || error.message}`)
    }
    process.exit(1)
  }
}

// Where the editor's two panels meet the app in a hero shot, as fractions of
// its width: the full-height hairlines each panel draws at its inner edge. The
// page slides the panels in along these seams, so they must be the real ones;
// panel widths are remembered per editor, so they differ between captures.
const SEAMS = `
import json, sys
from PIL import Image
out = {}
for slug, path in json.loads(sys.argv[1]).items():
    im = Image.open(path).convert("L")
    W, H = im.size
    px = im.load()
    rows = range(4, H - 4, 8)
    def score(x):
        return sum(1 for y in rows if abs(px[x, y] - px[x - 3, y]) > 3 and abs(px[x, y] - px[x + 3, y]) > 3)
    def strong(lo, hi):
        scored = [(score(x), x) for x in range(int(W * lo), int(W * hi))]
        top = max(s for s, _ in scored)
        return [x for s, x in scored if s >= top * 0.97 and top >= len(rows) * 0.9]
    left, right = strong(0.10, 0.25), strong(0.75, 0.90)
    if not left or not right:
        continue
    r = max(right)
    while r - 1 in right:
        r -= 1
    out[slug] = {"left": round((max(left) + 1) / W, 4), "right": round(r / W, 4)}
print(json.dumps(out))
`

function detectSeams(heroes) {
  if (!Object.keys(heroes).length) return {}
  try {
    return JSON.parse(execFileSync(python, ["-c", SEAMS, JSON.stringify(heroes)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))
  } catch {
    return {}
  }
}

// Two marks the page lays its own drawings over, found by the editor's accent
// fill (#4a5df9), in CSS px of the 1600x1000 capture:
//   toolbar  the bottom toolbar, from its pressed Inspect square in hero.jpg
//            (32px square, 4px in from the bar's edge: border 1 + padding 3)
//   send     the Send to agent button in changes.jpg, the largest accent
//            button in the right panel
const MARKS = `
import json, sys
from PIL import Image
def blobs(im, box, tol=26, step=2):
    px = im.load()
    x0, y0, x1, y1 = [int(v) for v in box]
    hit = lambda c: abs(c[0] - 74) < tol and abs(c[1] - 93) < tol and abs(c[2] - 249) < tol
    seen, found = set(), []
    for y in range(y0, y1, step):
        for x in range(x0, x1, step):
            if (x, y) in seen or not hit(px[x, y]):
                continue
            stack, xs, ys = [(x, y)], [], []
            seen.add((x, y))
            while stack:
                cx, cy = stack.pop()
                xs.append(cx); ys.append(cy)
                for nx, ny in ((cx + step, cy), (cx - step, cy), (cx, cy + step), (cx, cy - step)):
                    if x0 <= nx < x1 and y0 <= ny < y1 and (nx, ny) not in seen and hit(px[nx, ny]):
                        seen.add((nx, ny)); stack.append((nx, ny))
            found.append((min(xs), min(ys), max(xs), max(ys)))
    return found
out = {}
for slug, files in json.loads(sys.argv[1]).items():
    marks = {}
    if files.get("hero"):
        im = Image.open(files["hero"]).convert("RGB"); W, H = im.size; s = W / 1600
        chips = [b for b in blobs(im, (W * 0.3, H * 0.9, W * 0.7, H)) if 24 <= (b[2] - b[0]) / s <= 36 and 24 <= (b[3] - b[1]) / s <= 36]
        if chips:
            b = min(chips)
            cx, cy = (b[0] + b[2]) / 2 / s, (b[1] + b[3]) / 2 / s
            marks["toolbar"] = {"x": round(cx - 20), "y": round(cy - 20), "w": 328, "h": 40}
    if files.get("changes"):
        im = Image.open(files["changes"]).convert("RGB"); W, H = im.size; s = W / 1600
        left = files.get("seamRight", 0.8) * W + 4
        buttons = [b for b in blobs(im, (left, 0, W, H * 0.9)) if (b[2] - b[0]) / s > 40 and (b[3] - b[1]) / s > 16]
        if buttons:
            b = max(buttons, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
            marks["send"] = {"x": round(b[0] / s), "y": round(b[1] / s), "w": round((b[2] - b[0]) / s) + 1, "h": round((b[3] - b[1]) / s) + 1}
    out[slug] = marks
print(json.dumps(out))
`

function detectMarks(files) {
  if (!Object.keys(files).length) return {}
  try {
    return JSON.parse(execFileSync(python, ["-c", MARKS, JSON.stringify(files)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))
  } catch {
    return {}
  }
}

const kb = (file) => `${Math.round(fs.statSync(file).size / 1024)} KB`
const mtime = (file) => (fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0)

if (!fs.existsSync(shotsDir)) {
  console.error(`✗ ${path.relative(process.cwd(), shotsDir)} does not exist`)
  process.exit(1)
}

const demoDirs = fs.readdirSync(shotsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
const jobs = []
const originals = []
for (const demo of demoDirs) {
  if (only && !only.has(demo)) continue
  const dir = path.join(shotsDir, demo)
  for (const file of fs.readdirSync(dir)) {
    const match = /^([a-z0-9-]+?)\.(jpe?g|png)$/i.exec(file)
    if (!match || /-\d{3,4}$/.test(match[1])) continue
    const source = path.join(dir, file)
    for (const width of WIDTHS) {
      const out = path.join(dir, `${match[1]}-${width}.webp`)
      if (mtime(out) > mtime(source)) continue
      jobs.push({ source, out, width, format: "webp", quality: width > 2000 ? 74 : 80 })
    }
    originals.push({ demo, source, file })
  }
}
encode(jobs)
for (const job of jobs) console.log(`✓ ${path.relative(shotsDir, job.out)}  ${kb(job.out)}`)

if (!keep) {
  for (const { demo, source, file } of originals) {
    const archive = path.join(originalsRoot, demo)
    fs.mkdirSync(archive, { recursive: true })
    fs.renameSync(source, path.join(archive, file))
  }
  if (originals.length) console.log(`moved ${originals.length} originals to ${originalsRoot}`)
}

// demos.json: what the review picker offers, and which shots each demo lacks.
const sourceOf = (slug, name) =>
  [path.join(shotsDir, slug, `${name}.jpg`), path.join(originalsRoot, slug, `${name}.jpg`), path.join(shotsDir, slug, `${name}-2400.webp`)].find((file) => fs.existsSync(file))
const heroSources = {}
for (const slug of demoDirs) {
  const found = sourceOf(slug, "hero")
  if (found) heroSources[slug] = found
}
const seams = detectSeams(heroSources)
const marks = detectMarks(
  Object.fromEntries(demoDirs.map((slug) => [slug, { hero: sourceOf(slug, "hero"), changes: sourceOf(slug, "changes"), seamRight: seams[slug]?.right }]))
)
const demos = demoDirs
  .map((slug) => {
    const dir = path.join(shotsDir, slug)
    let manifest = []
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"))
    } catch {}
    const entries = Array.isArray(manifest) ? manifest : manifest.shots ?? [manifest]
    const first = entries[0] ?? {}
    const present = new Set(fs.readdirSync(dir).filter((f) => f.endsWith("-1280.webp")).map((f) => f.replace(/-1280\.webp$/, "")))
    // Geometry the page animates over, in CSS px of the 1600x1000 capture.
    const entry = (file) => entries.find((e) => e.file === file) ?? {}
    const box = (value) => (value && ["x", "y", "w", "h"].every((k) => Number.isFinite(value[k])) ? { x: value.x, y: value.y, w: value.w, h: value.h } : undefined)
    const geometry = {
      selection: box(entry("hero.jpg").selection),
      focus: box(entry("canvas.jpg").focus),
      pins: Array.isArray(entry("notes.jpg").pins) ? entry("notes.jpg").pins : undefined,
      seams: seams[slug],
      toolbar: marks[slug]?.toolbar,
      send: marks[slug]?.send,
      // Measured at capture: what the cues on these shots point at.
      textEdit: box(entry("direct-edit.jpg").textEdit),
      launcher: box(entry("hidden.jpg").launcher),
      options: Array.isArray(entry("options-alt.jpg").options) ? entry("options-alt.jpg").options : undefined,
    }
    return {
      slug,
      name: first.app ?? slug,
      repo: first.appRepoUrl ?? null,
      license: first.license ?? null,
      description: first.appDescription ?? null,
      designNotes: first.designNotes ?? null,
      missing: SHOT_NAMES.filter((name) => !present.has(name)),
      geometry: JSON.parse(JSON.stringify(geometry)),
    }
  })
  .filter((demo) => demo.missing.length < SHOT_NAMES.length)
  .sort((a, b) => (ORDER.indexOf(a.slug) + 1 || 99) - (ORDER.indexOf(b.slug) + 1 || 99))
fs.writeFileSync(path.join(shotsDir, "demos.json"), `${JSON.stringify(demos, null, 2)}\n`)
console.log(`✓ demos.json — ${demos.map((d) => `${d.slug}${d.missing.length ? ` (missing ${d.missing.join(", ")})` : ""}`).join(", ")}`)

// og.jpg: the default demo's hero, 1200 wide, cropped to 630 tall.
const heroSource = demos[0] && path.join(shotsDir, demos[0].slug, "hero-2400.webp")
if (heroSource && fs.existsSync(heroSource)) {
  const og = path.join(site, "assets", "og.jpg")
  encode([{ source: heroSource, out: og, width: 1200, format: "jpeg", quality: 82, crop: [1200, 630] }])
  console.log(`✓ assets/og.jpg  ${kb(og)}`)
}
console.log(jobs.length ? `${jobs.length} images written` : "nothing to re-encode")
