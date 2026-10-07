/**
 * Lattice — a host whose tokens were never a Figma-style manifest.
 *
 * The design system is a JavaScript module. The adapter is the one branch that
 * lets it in: it returns the same normalized token groups the manifest path
 * produces, and everything downstream — aliases, breakpoints, inspector rows —
 * is the same code.
 */

import { corner, palette } from "./tokens.mjs"

export default {
  designSystem: {
    adapter: () => ({
      name: "Lattice",
      colors: Object.entries(palette).map(([name, light]) => ({
        id: `color:${name}`,
        name,
        category: "color",
        cssVar: `--lattice-${name}`,
        values: { light },
      })),
      radii: Object.entries(corner).map(([name, value]) => ({
        id: `radius:${name}`,
        name,
        category: "radius",
        cssVar: `--lattice-radius-${name}`,
        values: { default: value },
      })),
    }),
    cssSources: ["./styles.css"],
  },
  tailwind: {
    version: 4,
    spacingScale: "v4-linear",
  },
}
