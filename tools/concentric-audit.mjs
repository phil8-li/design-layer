/**
 * The browser half of the concentric-radius check.
 *
 * `test/concentric-cases.mjs` is the guard that runs in `npm test`: it reads the
 * stylesheet and proves every nest declared through `nest()` is arithmetically
 * concentric, with no browser involved. That is the check that cannot be
 * skipped, and it is deliberately blind to one thing — whether the elements the
 * stylesheet describes are actually laid out the way the nest assumed.
 *
 * This file is the other half, and it is a TOOL rather than a test: paste
 * `AUDIT` into a page running the editor and it walks the real, laid-out DOM,
 * measuring the gap between each rounded child and the rounded ancestor it sits
 * in. It reports a corner only when the child genuinely occupies it — see
 * `ADJACENT` below — because a child parked in the middle of an edge shares no
 * curve with anything and a checker that flags it teaches you to ignore it.
 *
 * Kept out of `npm test` because it needs a browser the package does not
 * depend on. Run it by hand after moving a surface's padding.
 */

/**
 * How close the two axes must agree before a corner counts as shared.
 *
 * A child inset 5px from the top and 5px from the left is tucked into the
 * corner: its curve runs parallel to the container's and the offset rule
 * applies. A child inset 5px from the top and 60px from the left is beside the
 * corner, not in it, and the only honest thing to say about its radius is
 * nothing. One pixel of slack, for subpixel layout.
 */
const ADJACENT = 1.01

export const AUDIT = `(() => {
  /*
   * Refuse to report on a page that cannot be judged, instead of reporting
   * nothing and looking clean.
   *
   * Every row below is a row about a nest that EXISTS. On a page with no editor
   * on it the loop finds nothing, returns an empty list, and an empty list is
   * the same shape as a pass. That has now happened three ways in one session:
   * a browser navigated to another session's page, a window narrowed until the
   * toolbar was smaller than its own buttons, and a 502 from the app the editor
   * proxies — each time the audit said nothing was wrong because it had not
   * looked at anything.
   *
   * So the absence of chrome is itself a finding. The overflow check further
   * down is the same idea applied to one element instead of the whole page.
   */
  if (!document.querySelector(".de-root") || !document.querySelector(".de-toolbar")) {
    return [{
      blocked: "no editor chrome on this page — nothing was measured",
      url: location.href,
      title: document.title,
      viewport: innerWidth + "x" + innerHeight,
    }]
  }
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }
  const pct = (v) => typeof v === "string" && v.includes("%")
  const radii = (el) => {
    const s = getComputedStyle(el)
    return {
      tl: s.borderTopLeftRadius, tr: s.borderTopRightRadius,
      br: s.borderBottomRightRadius, bl: s.borderBottomLeftRadius,
    }
  }
  const named = (el) => {
    const own = (el.className || "").toString().trim().split(/\\s+/).filter((c) => c.startsWith("de-"))
    return own.length ? "." + own.join(".") : el.tagName.toLowerCase()
  }
  const rounded = (el) => Object.values(radii(el)).some((v) => px(v) > 0 || pct(v))

  const found = new Map()
  const spilled = new Map()
  for (const el of document.querySelectorAll("*")) {
    if (!el.closest("[data-designlayer], .de-app-menu, .de-options-root, .de-root, .de-token-pop")) continue
    if (!rounded(el)) continue

    let host = el.parentElement
    for (let hop = 0; host && hop < 12; hop++, host = host.parentElement) if (rounded(host)) break
    if (!host || !rounded(host)) continue

    const c = el.getBoundingClientRect()
    const h = host.getBoundingClientRect()
    if (!c.width || !c.height || !h.width || !h.height) continue
    /*
     * Only a child the container actually encloses. A popover anchored to a
     * rounded trigger is a sibling in every sense that matters here.
     *
     * An OVERFLOWING child is reported rather than dropped, because a silent
     * skip here is indistinguishable from a clean pass and that cost four
     * audits. A browser window narrowed to 420px took the toolbar's
     * \`max-width: calc(100vw - panels - 24px)\` down to 16px; its ten buttons
     * spilled out of the pill, every one of them failed this test, and the bar
     * simply stopped appearing in the results. Nothing was wrong with the
     * radii — but "no rows for the toolbar" read exactly like "the toolbar is
     * fine". If this fires, widen the window before believing anything below.
     */
    if (c.right > h.right + 0.5 || c.bottom > h.bottom + 0.5 ||
        c.left < h.left - 0.5 || c.top < h.top - 0.5) {
      const key = named(host) + " > " + named(el)
      if (!spilled.has(key)) {
        spilled.set(key, {
          nest: key,
          note: "child overflows its container — layout is degenerate, radii not judged",
          host: Math.round(h.width) + "x" + Math.round(h.height),
          child: Math.round(c.width) + "x" + Math.round(c.height),
          viewport: innerWidth + "x" + innerHeight,
        })
      }
      continue
    }

    const R = radii(host)
    const C = radii(el)
    const gaps = {
      tl: [c.left - h.left, c.top - h.top],
      tr: [h.right - c.right, c.top - h.top],
      br: [h.right - c.right, h.bottom - c.bottom],
      bl: [c.left - h.left, h.bottom - c.bottom],
    }
    for (const corner of ["tl", "tr", "br", "bl"]) {
      // A circle has no corner to be concentric with, and neither has a square.
      if (pct(R[corner]) || pct(C[corner])) continue
      const outer = px(R[corner])
      if (!outer) continue
      const [dx, dy] = gaps[corner]
      if (Math.abs(dx - dy) > ${ADJACENT}) continue
      if (dx > outer + 2) continue
      const inset = (dx + dy) / 2
      const want = Math.max(outer - inset, 0)
      const got = px(C[corner])
      if (Math.abs(want - got) <= 0.51) continue
      const key = named(host) + " > " + named(el)
      if (found.has(key)) continue
      found.set(key, {
        nest: key, corner, outer, inset: +inset.toFixed(2),
        got, want: +want.toFixed(2),
      })
    }
  }
  return [...found.values(), ...spilled.values()]
})()`

export default AUDIT

/*
 * Run directly and it prints the snippet, ready to paste into the console of a
 * page with the editor on it. It does not drive a browser itself: the package
 * has no Playwright and adding one so a corner check can run unattended is a
 * poor trade — `test/concentric-cases.mjs` is the unattended half, and this is
 * the half you reach for when the arithmetic is right and the screen still
 * looks wrong.
 *
 * It reports one line per broken nest, and prints nothing when there is none.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(
    [
      "// Paste into the DevTools console of a page running the editor.",
      "// One row per nest whose child is not concentric with its container —",
      "// plus any container its child OVERFLOWS. A narrow window can make a pill",
      "// smaller than its own buttons, and that must not read as a clean pass.",
      "console.table(" + AUDIT + ")",
    ].join("\n")
  )
}
