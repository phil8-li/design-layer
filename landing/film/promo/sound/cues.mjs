#!/usr/bin/env node
/**
 * Writes a cut's events (cut.cues, published by the page as window.CUES) to JSON,
 * so the sound is laid against the same clock as the picture.
 *
 *   node landing/film/promo/sound/cues.mjs t            → ~/.cache/designlayer-site/sound/t/cues.json
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { startServer } from "../../../serve.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SITE = path.resolve(HERE, "../../..")
const FRAMES_ROOT = process.env.FRAMES_ROOT || path.join(os.homedir(), ".cache", "designlayer-site", "story")
const require = createRequire(process.env.PLAYWRIGHT || import.meta.url)
const { chromium } = require("playwright")

const id = process.argv[2]
if (!id) throw new Error("usage: cues.mjs <cut>")
const out = path.join(os.homedir(), ".cache", "designlayer-site", "sound", id, "cues.json")
const server = await startServer({ root: SITE, port: 0 })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await page.route(/\/film\/promo\/frames\/([^/?]+)\/([^/?]+)/, (route) => {
  const [, session, name] = /\/frames\/([^/?]+)\/([^/?]+)/.exec(route.request().url())
  const file = path.join(FRAMES_ROOT, path.basename(session), path.basename(name))
  if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" })
  return route.fulfill({ status: 200, body: fs.readFileSync(file), contentType: name.endsWith(".json") ? "application/json" : "image/jpeg" })
})
await page.goto(`${server.url.replace(/\/$/, "")}/film/promo/?cut=${encodeURIComponent(id)}`, { waitUntil: "load" })
await page.waitForFunction(() => window.filmReady !== undefined)
await page.evaluate(() => window.filmReady)
const cues = await page.evaluate(() => window.CUES)
await browser.close()
await server.close()
if (!cues) throw new Error(`cut ${id} publishes no cues`)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(cues, null, 1) + "\n")
console.log(out)
