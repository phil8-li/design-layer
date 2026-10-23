/**
 * The vendor batch writer's coalescing fix (`runtime/vendor-server-patch.mjs`).
 *
 * Under React 19 every operation reaches the server at 0:0, and the vendor
 * grouped class updates by `line:col`, so one commit with edits to two
 * elements wrote both edits onto the first element. These cases run the real
 * vendor `executeBatch`, loaded through the patch hook, on a real file.
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { PACKAGE_DIR } from "./host.mjs"

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

const { BATCH_ANCHOR, installVendorServerPatch, patchBatchSource } = await import(
  pathToFileURL(path.join(PACKAGE_DIR, "runtime/vendor-server-patch.mjs")).href
)
const vendorFile = path.join(PACKAGE_DIR, "node_modules/react-rewrite-cli/dist/batch-transform.js")

console.log("\nVendor batch writer")

await check("the pinned vendor build carries the coalesce key exactly once", () => {
  const source = fs.readFileSync(vendorFile, "utf8")
  assert.equal(source.split(BATCH_ANCHOR).length - 1, 1)
  assert.match(patchBatchSource(source), /const key = rop\.node;/)
})

await check("a build without the anchor fails loudly instead of writing to the wrong node", () => {
  assert.throws(() => patchBatchSource("function coalesceOps() {}"), /expected the coalesce key once, found 0/)
})

/*
 * The load hook is Node 22.15 / 23.5 and later. CI also runs this file on
 * 20.19, where `installVendorServerPatch` is a no-op and the vendor keeps its
 * own grouping. The source checks above still run there. This one drives
 * `executeBatch` through the hook, so it skips on a Node that cannot load it
 * instead of failing that leg.
 */
if (!installVendorServerPatch()) {
  console.log(
    "  skip two elements edited in one commit at 0:0 each keep their own update — module.registerHooks is not on this Node"
  )
} else {
  await check("two elements edited in one commit at 0:0 each keep their own update", async () => {
    const { executeBatch } = await import(pathToFileURL(vendorFile).href)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "designlayer-batch-"))
    try {
      fs.mkdirSync(path.join(root, "src"))
      const file = path.join(root, "src", "App.jsx")
      fs.writeFileSync(
        file,
        `export default function App() {
  return (
    <main>
      <div className="box w-32 bg-blue">Box</div>
      <p className="copy text-base">Copy</p>
    </main>
  )
}
`
      )
      const update = { tailwindPrefix: "rounded", tailwindToken: null, value: "6px" }
      const { results } = executeBatch(
        [
          { op: "updateClass", file: "src/App.jsx", line: 0, col: 0, tagName: "div", className: "box w-32 bg-blue", updates: [update] },
          { op: "updateClass", file: "src/App.jsx", line: 0, col: 0, tagName: "p", className: "copy text-base", updates: [{ ...update }] },
        ],
        root
      )
      assert.ok(results.every((result) => result.success), JSON.stringify(results))
      const text = fs.readFileSync(file, "utf8")
      assert.match(text, /<div className="[^"]*rounded-\[6px\][^"]*">Box/)
      assert.match(text, /<p className="[^"]*rounded-\[6px\][^"]*">Copy/)
      assert.equal(text.split("rounded-[6px]").length - 1, 2, "one element got both updates")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
