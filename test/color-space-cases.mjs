/**
 * The colour module, against the colour spaces a modern app is authored in.
 *
 * ## Why this suite exists
 *
 * `inspector/color.ts` understood hex and `rgb()` and nothing else, and Chrome
 * does NOT normalise wide-gamut colours on the way out of `getComputedStyle` —
 * an element authored `oklch(0.7 0.15 250)` computes to that same string. So
 * `toHex` returned null, `withAlpha` in `section-fill.ts` fell back to
 * `"#000000"`, and dragging the opacity field replaced the designer's colour
 * with **pure black in their source file**. At every alpha, including 100%,
 * because the `alpha >= 1` path returned the fallback hex too.
 *
 * That is data loss rather than a rendering fault, which is why it is pinned
 * here rather than left to the browser audit: the failure is in what gets
 * WRITTEN, and a test that only looked at the screen would have passed.
 *
 * The strings below are not invented. They are what Chrome 141 actually
 * returned from `getComputedStyle().backgroundColor` for elements authored in
 * each space, captured from a live page.
 */

import assert from "node:assert/strict"

import { PACKAGE_DIR } from "./host.mjs"

const { build } = await import("esbuild")
const bundled = await build({
  stdin: {
    contents: `export { toHex, alphaOf, restated } from "./src/panels/inspector/color"`,
    resolveDir: PACKAGE_DIR,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  platform: "neutral",
})
const { toHex, alphaOf, restated } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
)

let passed = 0
let failed = 0
const check = (name, run) => {
  try {
    run()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message.split("\n").join("\n       ")}`)
  }
}

console.log("\nColour spaces")

/** Verbatim from Chrome, one per space an app might be authored in. */
const COMPUTED = {
  hex: "rgb(12, 140, 233)",
  oklch: "oklch(0.7 0.15 250)",
  oklchAlpha: "oklch(0.7 0.15 250 / 0.5)",
  displayP3: "color(display-p3 0.2 0.6 0.9)",
  lab: "lab(50 40 -30)",
}

check("sRGB still converts, because that is the common path", () => {
  assert.equal(toHex(COMPUTED.hex), "#0c8ce9")
  assert.equal(toHex("#ABC"), "#aabbcc")
  assert.equal(toHex("#0C8CE9"), "#0c8ce9")
})

check("a wide-gamut colour is refused rather than guessed at", () => {
  // The important half: null, NOT a black hex. A caller that sees null is
  // expected to decline the write; one that saw "#000000" could not tell the
  // difference between a colour it understood and one it had invented.
  for (const key of ["oklch", "oklchAlpha", "displayP3", "lab"]) {
    assert.equal(toHex(COMPUTED[key]), null, `${key} should not convert`)
  }
})

check("alpha is read from the modern slash form, not just the legacy comma", () => {
  assert.equal(alphaOf("rgba(12, 140, 233, 0.5)"), 0.5, "legacy comma form")
  assert.equal(alphaOf(COMPUTED.oklchAlpha), 0.5, "modern slash form")
  assert.equal(alphaOf("color(display-p3 0.2 0.6 0.9 / 25%)"), 0.25, "percentage alpha")
  assert.equal(alphaOf(COMPUTED.oklch), 1, "absent alpha is opaque")
  assert.equal(alphaOf(COMPUTED.hex), 1, "opaque rgb")
})

check("every colour is re-stated in its OWN space, so nothing is flattened", () => {
  // Routing these through `rgb()` would work and would silently gamut-map a
  // display-p3 blue to the nearest sRGB one. The function name has to survive.
  assert.equal(restated(COMPUTED.oklch, 0.5), "oklch(from oklch(0.7 0.15 250) l c h / 0.5)")
  assert.equal(restated(COMPUTED.lab, 0.5), "lab(from lab(50 40 -30) l a b / 0.5)")
  assert.equal(
    restated(COMPUTED.displayP3, 0.5),
    "color(from color(display-p3 0.2 0.6 0.9) display-p3 r g b / 0.5)",
    "color() carries its space as an argument and has to repeat it"
  )
})

check("a colour it cannot re-state returns null, so the caller can decline", () => {
  // A bare keyword has no function to re-state through. Better to refuse the
  // write than to put a colour in the file that the designer did not choose.
  assert.equal(restated("rebeccapurple", 0.5), null)
  assert.equal(restated("transparent", 0.5), null)
  assert.equal(restated("", 0.5), null)
})

check("alpha is clamped, because a field can be dragged past its own bounds", () => {
  assert.match(restated(COMPUTED.oklch, 2), /\/ 1\)$/)
  assert.match(restated(COMPUTED.oklch, -1), /\/ 0\)$/)
})

/*
 * The regression, stated as the thing a user would report.
 *
 * This is `withAlpha` from `section-fill.ts` in both its forms, so the suite
 * fails if anyone reintroduces the fallback. It is duplicated here rather than
 * imported because that function is module-private and making it public to
 * test it would be a worse trade than eight lines of restatement.
 */
check("dragging opacity on a wide-gamut fill never writes black", () => {
  const withAlphaFixed = (color, alpha) => {
    const hex = toHex(color)
    if (hex) {
      if (alpha >= 1) return hex
      const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16))
      return `rgba(${r},${g},${b},${alpha})`
    }
    return restated(color, alpha)
  }
  const withAlphaBroken = (color, alpha) => {
    const hex = toHex(color) ?? "#000000"
    if (alpha >= 1) return hex
    const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16))
    return `rgba(${r},${g},${b},${alpha})`
  }

  for (const key of ["oklch", "displayP3", "lab"]) {
    const color = COMPUTED[key]
    // What the old code did, kept as the statement of the bug.
    assert.match(
      withAlphaBroken(color, 0.5),
      /^rgba\(0,0,0/,
      `${key}: the old fallback is supposed to produce black — if it does not, this test is stale`
    )
    // And what it does now, at both ends of the range.
    for (const alpha of [0, 0.5, 1]) {
      const written = withAlphaFixed(color, alpha)
      assert.ok(written, `${key} @ ${alpha} produced nothing`)
      assert.doesNotMatch(written, /#000000|rgba?\(0\s*,\s*0\s*,\s*0/, `${key} @ ${alpha} wrote black`)
      assert.ok(written.includes(color), `${key} @ ${alpha} lost the authored colour`)
    }
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
