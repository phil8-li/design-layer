#!/usr/bin/env node
/**
 * Real-browser check that the selection outline follows a moving element
 * within a frame, now that its frame loop rests on a still page.
 *
 *   node tools/tracking-e2e.mjs            # stands up the perf host, headless
 *   node tools/tracking-e2e.mjs <editorUrl> # against an editor already running
 *
 * The painter stops reading geometry once every box has held still for a few
 * frames (`canvas/selection`), and `canvas/motion-watch` wakes it. So every
 * case here starts the motion from a timer, AFTER the loop has rested, with no
 * input to wake it — the case a resting loop could get wrong:
 *
 *   transition   an inline transform with a CSS transition (a mutation)
 *   waapi        `element.animate`, which mutates nothing
 *   raf          a style written from the page's own frame callback, as Motion does
 *   delayed      a WAAPI animation already running in its delay when the loop
 *                would rest, so nothing at all announces its first frame
 *
 * Each frame the element's box and the outline's box are sampled after that
 * frame's callbacks have run. The outline may trail by one frame — it does on
 * a frame where the page's callback writes after the painter has read, and it
 * always did — and never by more. A last check asserts the loop really rests:
 * at most a few frame requests a second once the page is still.
 *
 * Host: `tools/perf.mjs --hold` (its Vite + React host and editor on free
 * ports), so no running editor's socket is touched.
 */

import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs"

// Never outlive a stuck browser or host: the whole check takes about 40s.
setTimeout(() => {
  console.error("tracking-e2e: timed out")
  hold?.kill("SIGKILL")
  process.exit(2)
}, 180000).unref()

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
let editorUrl = process.argv[2]
let hold = null

if (!editorUrl) {
  hold = spawn(process.execPath, ["tools/perf.mjs", "--hold", "--only", "none"], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] })
  editorUrl = await new Promise((resolve, reject) => {
    let out = ""
    hold.stdout.on("data", (chunk) => {
      out += chunk
      const match = out.match(/holding: app \S+\s+editor (\S+)/)
      if (match) resolve(match[1])
    })
    hold.on("exit", () => reject(new Error(`perf host exited:\n${out}`)))
    setTimeout(() => reject(new Error(`perf host not ready in 120s:\n${out}`)), 120000).unref()
  })
}

const browser = await chromium.launch()
let failed = 0
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  page.setDefaultTimeout(30000)
  await page.goto(editorUrl, { waitUntil: "load", timeout: 60000 })
  await page.waitForFunction(() => document.querySelector(".de-toolbar"), null, { timeout: 30000 })
  await page.waitForTimeout(1200)
  const box = await page.locator('[data-testid="card-4"]').boundingBox()
  await page.mouse.click(box.x + 6, box.y + 6)
  // Park the pointer over the chrome so no hover outline joins in, and blur so
  // no field holds a key.
  await page.mouse.move(1300, 880)
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.waitForTimeout(400)

  const run = (name) =>
    page.evaluate(async (name) => {
      const target = document.querySelector('[data-testid="card-4"]')
      const outline = [...document.querySelectorAll(".de-outline")].find(
        (node) => !node.classList.contains("de-outline--hover") && !node.classList.contains("de-outline--related") && node.style.display !== "none"
      )
      if (!outline) return { error: "no selection outline" }
      const read = () => {
        const rect = target.getBoundingClientRect()
        const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(outline.style.transform) ?? []
        return { el: [rect.left, rect.top, rect.width, rect.height], ol: [Number(match[1]), Number(match[2]), parseFloat(outline.style.width), parseFloat(outline.style.height)] }
      }
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      // Long enough for the loop to rest (30 still frames) with margin.
      await sleep(900)
      const samples = []
      let sampling = true
      // A task queued from a frame callback runs after every callback of that
      // frame, and before the next frame's: the state that frame painted.
      const tick = () => {
        if (!sampling) return
        setTimeout(() => samples.push(read()), 0)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      await sleep(50)
      const DURATION = 400
      // Half a poll off the rest's backstop (it polls every 250ms from the
      // moment the loop rests, which the reset below fixes relative to this
      // start), so a pass here is the watch's doing and not the poll's.
      setTimeout(() => {
        if (name === "transition") {
          target.style.transition = `transform ${DURATION}ms linear`
          target.style.transform = "translateX(90px)"
        } else if (name === "waapi") {
          target.animate([{ transform: "none" }, { transform: "translateY(70px)" }], { duration: DURATION, fill: "forwards" })
        } else if (name === "raf") {
          const start = performance.now()
          const step = (now) => {
            const t = Math.min(1, (now - start) / DURATION)
            target.style.transform = `translate(${60 * t}px, ${40 * t}px)`
            if (t < 1) requestAnimationFrame(step)
          }
          requestAnimationFrame(step)
        }
      }, 125)
      if (name === "delayed") {
        // Started before the wait: the loop must stay awake through the delay.
        target.animate([{ transform: "none" }, { transform: "translateX(-50px)" }], { duration: DURATION, delay: 900, fill: "forwards" })
        await sleep(900 + DURATION + 300)
      } else {
        await sleep(DURATION + 300)
      }
      sampling = false
      await sleep(50)
      // Put the card back for the next case, and let it settle.
      for (const animation of target.getAnimations()) animation.cancel()
      target.style.transition = ""
      target.style.transform = ""
      await sleep(300)

      const near = (a, b) => a.every((value, index) => Math.abs(value - b[index]) < 0.6)
      let worst = 0
      let moved = 0
      for (let index = 1; index < samples.length; index += 1) {
        if (!near(samples[index].el, samples[index - 1].el)) moved += 1
        let lag = 0
        while (lag <= index && !near(samples[index].ol, samples[index - lag].el)) lag += 1
        worst = Math.max(worst, lag)
      }
      const last = samples.at(-1)
      return { frames: samples.length, moved, worst, settled: near(last.ol, last.el) }
    }, name)

  for (const name of ["transition", "waapi", "raf", "delayed"]) {
    const result = await run(name)
    const ok = !result.error && result.moved >= 5 && result.worst <= 1 && result.settled
    if (!ok) failed += 1
    console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(10)} ${JSON.stringify(result)}`)
  }

  const requests = await page.evaluate(async () => {
    // The reset above is a mutation, and wakes the loop for its half second.
    await new Promise((resolve) => setTimeout(resolve, 1000))
    let count = 0
    const original = window.requestAnimationFrame
    window.requestAnimationFrame = (callback) => {
      count += 1
      return original.call(window, callback)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
    window.requestAnimationFrame = original
    return count
  })
  const resting = requests <= 6
  if (!resting) failed += 1
  console.log(`${resting ? "ok  " : "FAIL"} rests      ${requests} frame requests in a still second`)
} catch (error) {
  failed += 1
  console.log(`FAIL ${error.message}`)
} finally {
  await browser.close().catch(() => {})
  hold?.kill("SIGTERM")
}
console.log(failed ? `\n${failed} failed` : "\nall passed")
process.exit(failed ? 1 : 0)
