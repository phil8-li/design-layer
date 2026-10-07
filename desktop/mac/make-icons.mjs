/**
 * Renders the PWA icons from icons/app-icon.svg in a private headless Chromium,
 * and copies the tab icon, runtime/favicon.svg, to icons/mark.svg for the desk.
 *
 * Chrome's installability check wants PNG icons at 192 and 512, and the
 * maskable one is what macOS shows in the Dock. app-icon.svg is already drawn
 * that way — a full-bleed square with the artwork clear of the corners —
 * because the OS crops it to its own squircle. The two "any" icons get the
 * corner rounding here instead, for the places that show an icon as it is.
 *
 * Usage: node desktop/mac/make-icons.mjs
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PLAYWRIGHT = "/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs"
const here = path.dirname(fileURLToPath(import.meta.url))
const iconsDir = path.join(here, "icons")
const svg = fs.readFileSync(path.join(iconsDir, "app-icon.svg"), "utf8")
const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`

// One tab icon for every page: the start screen inlines runtime/favicon.svg,
// and the desk serves this copy of it at /icons/mark.svg.
fs.copyFileSync(path.join(here, "..", "..", "runtime", "favicon.svg"), path.join(iconsDir, "mark.svg"))
console.log("wrote icons/mark.svg (runtime/favicon.svg)")

const { chromium } = await import(PLAYWRIGHT)
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  const render = async (file, size, maskable) => {
    await page.setViewportSize({ width: size, height: size })
    // Maskable: the square as drawn. Any: the same square with the macOS corner radius.
    const radius = maskable ? 0 : Math.round(size * 0.2237)
    await page.setContent(
      `<html><body style="margin:0;background:transparent;width:${size}px;height:${size}px">` +
        `<img src="${dataUrl}" width="${size}" height="${size}" style="display:block;border-radius:${radius}px"></body></html>`
    )
    await page.screenshot({ path: path.join(iconsDir, file), omitBackground: !maskable })
    console.log(`wrote icons/${file} (${size}x${size})`)
  }
  await render("icon-192.png", 192, false)
  await render("icon-512.png", 512, false)
  await render("icon-maskable-512.png", 512, true)
} finally {
  await browser.close()
}
