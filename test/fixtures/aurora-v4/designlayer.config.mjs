/**
 * Aurora — a Tailwind v4 host that is not this app.
 *
 * Its palette is dark-only, it ships no spacing scale, no icon scale and no
 * motion tokens, it states tracking in pixels, and its `@theme` block uses two
 * namespaces the editor's built-in four do not contain.
 */

export default {
  designSystem: {
    manifest: "./tokens.json",
    cssSources: ["./theme.css"],
    breakpoints: {
      roomy: { usage: "Two-column reading width", owner: "aurora/theme.css" },
    },
  },
  tailwind: {
    version: 4,
    spacingScale: "v4-linear",
    // Tailwind's own `shadow` scale is not the only shadow scale it has, and
    // Aurora uses the other two. Without this list `--drop-shadow-halo` is
    // invisible and `--text-shadow-lift` is misread as the `text` scale.
    themeNamespaces: ["color", "radius", "text", "text-shadow", "drop-shadow"],
    breakpoints: { compact: 600, roomy: 1080 },
  },
}
