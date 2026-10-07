/**
 * Relay — a Tailwind v3 host that is not this app.
 *
 * Its manifest omits five of the eight token groups entirely: no spacing, no
 * text styles, no UI text styles, no effects, no icon scale, no motion. It has
 * no `@theme` block at all, so every Tailwind alias it resolves comes from the
 * v3 arm reading its own tailwind.config.js.
 */

export default {
  designSystem: {
    manifest: "./tokens.json",
    cssSources: ["./styles.css"],
    tailwindConfig: "./tailwind.config.js",
  },
  tailwind: {
    version: 3,
    breakpoints: { sm: 640, lg: 1024 },
  },
}
