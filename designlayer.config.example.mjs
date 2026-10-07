/**
 * Copy to `designlayer.config.mjs` in your project root.
 *
 * Every key is optional. The tool runs with no config file at all; a key is
 * worth setting only where your app differs from the defaults below, which
 * target a stock Next.js + Tailwind + shadcn/ui app.
 *
 * Paths are resolved against the directory holding this file, so the project
 * root travels with the config rather than with the installed package.
 */

const config = {
  app: {
    // Dev server port. Omit to pass one on the command line instead.
    port: 3000,
    host: "127.0.0.1",
    // Open the editing URL on start. The dev server's own URL is left alone —
    // it has no editor on it.
    open: false,
    // The npm script `--dev` runs when nothing is listening on `port` yet.
    devScript: "dev",
  },

  // "auto" lets the tool take the first free port near the vendor's defaults.
  // Pin these when something else needs to know where the editor lives; a
  // pinned port that is busy stops the launch instead of moving silently.
  ports: { proxy: "auto", ws: "auto" },

  // Where the editor keeps saved option sets, agent handoffs, and the
  // endpoint file. Add it to .gitignore.
  stateDir: ".local/designlayer",

  // Route prefix for the editor's own endpoints, served on the proxy origin.
  // Change it only if it collides with one of your app's routes.
  apiPrefix: "/__designlayer",

  // Optional canonical token manifest. Keep `manifest` null for a generic
  // install. CSS sources let the editor connect authored custom properties and
  // Tailwind theme aliases back to the manifest without exposing these paths
  // to the browser.
  designSystem: {
    manifest: null, // e.g. "docs/design-tokens.json"
    cssSources: [], // e.g. ["app/globals.css"]

    // A token group your system does not have is simply omitted from the
    // manifest — no motion tokens, no text styles, no radius scale. The axis
    // resolves empty and the inspector drops its row. Only a group that is
    // PRESENT and the wrong shape is an error.

    // For a system that is not a manifest at all: tokens in a TypeScript
    // module, a Style Dictionary build, a CMS. Return the same token groups
    // the manifest path produces — `colors`, `spacing`, `radii`, `textStyles`,
    // `uiTextStyles`, `effects`, `icons`, `motion` — and everything downstream
    // is identical. Takes `{ projectRoot }`. Mutually exclusive with `manifest`.
    adapter: null,
    // adapter: () => ({
    //   name: "Lattice",
    //   colors: Object.entries(palette).map(([name, light]) => ({
    //     id: `color:${name}`, name, category: "color",
    //     cssVar: `--lattice-${name}`, values: { light },
    //   })),
    // }),

    // Tailwind v3 keeps its scale in a config file rather than in a
    // stylesheet, so a v3 host has no `@theme` custom property to trace and
    // would otherwise resolve no Tailwind aliases at all. Either key feeds the
    // v3 path; a scale entry may be a `var()` or a literal, and a literal is
    // matched against the token's own value.
    tailwindConfig: null, // e.g. "tailwind.config.js"
    tailwindTheme: null, // or declare it: { color: { ink: "var(--ink)" } }

    // "em" or "px" — the unit your text styles state letter-spacing in.
    // Declared, because the number cannot say: -0.5 is a plausible em and a
    // plausible px. A manifest may carry its own `trackingUnit`; this wins.
    trackingUnit: null,

    // Optional prose for the breakpoints your design system actually
    // documents. The pixel value stays in `tailwind.breakpoints`, its one
    // owner, and this only says what crossing the step MEANS. A prefix you
    // omit still appears in the inspector, labelled as outside the system.
    breakpoints: {
      // md: { usage: "Tablet: the nav collapses.", owner: "src/hooks/use-mobile.ts" },
    },

    // Optional annotations for the separate container-query scale below.
    containerBreakpoints: {
      // xl: { usage: "Cards: switch to two columns.", owner: "src/cards.tsx" },
    },

    // Read-only runtime layout rules. These explain responsive behavior but
    // are not presented as editable CSS tokens.
    responsiveMeasures: {
      // contentFits: {
      //   formula: "viewport - navigation >= 720px",
      //   usage: "Whether the reading column keeps its minimum measure.",
      //   owner: "src/layout.ts",
      // },
    },
  },

  // Your icon set: the drawings, not the size scale. With both halves set, a
  // selected <svg> names itself and the inspector can swap it for another
  // glyph. `attribute` is what your icon factory stamps on each element;
  // `data` is a JSON map of name to { nodes, rootFill, rootStroke }. The set
  // is fetched from `GET {apiPrefix}/icons` on demand rather than shipped in
  // the prelude, so a large library costs nothing until the panel opens. An
  // icon swap is preview-only — the source writer speaks in classes and text.
  icons: {
    attribute: "", // e.g. "data-app-icon"
    data: null, // e.g. "src/components/icons/icon-data.json"
  },

  chrome: {
    // Elements the editor must treat as its own furniture rather than as
    // canvas: your dev GUI, debug bars, anything that is not the product.
    // Leave the array empty if you have none.
    trustedSelectors: ["[data-my-dev-toolbar]"],

    // A dev panel the editor should sit beside instead of overlapping. The
    // two CSS variables are the contract: your stylesheet reads them to make
    // room. Drop this block entirely if you have no such panel.
    dockedPanel: {
      selector: "[data-my-dev-panel]",
      fallbackSelector: "",
      chromeSelectors: ["[data-my-dev-panel]"],
      offsetVar: "--designlayer-dev-panel-offset",
      widthVar: "--designlayer-dev-panel-width",
      minWidth: 260,
      maxWidth: 380,
      gap: 12,
      edgeGap: 8,
    },
  },

  // Optional. Other people's dev-time browser tooling, loaded beside the editor
  // — an annotation toolbar, a flag switcher. Each entry is a manifest naming a
  // self-contained browser bundle and the selectors it draws under, which join
  // `chrome.trustedSelectors` so the canvas stops mistaking its buttons for
  // yours. Paths inside a manifest are read against the manifest.
  //
  //   { "name": "flags", "script": "./flags.js",
  //     "trustedSelectors": ["[data-flag-switcher]"] }
  //
  // `DESIGNLAYER_COMPANIONS` declares the same thing for the whole machine, for
  // tooling that belongs to the person rather than to this repository.
  //
  // Commented out rather than illustrated live, unlike every other key here: a
  // companion that is not on disk stops the editor starting, on purpose, so a
  // copied example naming a bundle nobody has would refuse to launch.
  // companions: ["./tools/flag-switcher/companion.json"],

  // Optional. The Design options tab lists options from three places, and only
  // the first needs this block:
  //   1. the Leva store named here;
  //   2. stores the app publishes on window.__DESIGNLAYER_CONTROLS__ — one, or
  //      an array — with Leva's store methods (getData, getVisiblePaths,
  //      setValueAtPath, useStore.subscribe); a store with scope: "app" lists
  //      after the page's own options;
  //   3. on/off items found in the running React tree with nothing published:
  //      { label, checked, onCheckedChange } objects handed to the app's menus.
  // The list follows the page you are on.
  controls: {
    leva: {
      // Window property containing Leva's dev store.
      storeGlobal: "__STORE",

      // Optional source-backed defaults. The export must be an object literal
      // whose groups are object literals and whose editable values are literals.
      sourceDefaults: {
        file: "src/design-defaults.ts",
        exportName: "DESIGN_DEFAULTS",
      },

      // First match wins. Selectors and relationships are explicit: the editor
      // never guesses affected elements from a control's path.
      bindings: [
        {
          pathPattern: "Cards.Spacing.*",
          selectors: ["[data-card]"],
          relationship: "spacing within",
          defaultGroup: "Card spacing",
          // Omit to use the control's leaf key; "$key" is also supported.
          defaultKey: "$key",
        },
      ],
    },
  },

  tailwind: {
    // 3 uses Tailwind's discrete spacing table. 4 resolves every multiple of
    // `spacingBase`, so set `spacingScale: "v4-linear"` there to stop the
    // editor writing arbitrary values for tokens that now exist.
    version: 3,
    spacingScale: "v3-default",
    spacingBase: 4,
    breakpoints: { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 },
    // Container-query names use a separate scale. Leave empty when the host
    // does not compile container variants.
    containerBreakpoints: {}, // e.g. { md: 448, lg: 512, xl: 576 }

    // The `@theme` namespaces a v4 host actually declares, which is how the
    // editor knows `--color-panel` is a colour and `--radius-panel` a radius.
    // The default covers Tailwind's own four. Extend it for a namespace your
    // app compiles — "drop-shadow", "font", "ease" — and note that a longer
    // name wins over a shorter prefix, so listing "text-shadow" keeps
    // `--text-shadow-lift` out of the typography axis. Ignored on v3, which
    // has no theme block; see `designSystem.tailwindConfig`.
    themeNamespaces: ["color", "radius", "text", "shadow"],

    // Your own colour stems, ADDED to Tailwind's palette and the shadcn
    // semantic tokens. A stem listed here is written as `bg-brand-500`; a
    // stem omitted is written as an arbitrary value, which is safe but ugly.
    colorWords: [],

    fontSizes: ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl"],
    fontFamilies: ["sans", "serif", "mono"],
  },

  source: {
    // Directories the agent may edit. An empty array means the whole project
    // root, minus the extension allowlist and a denylist you cannot widen
    // (.env*, *.config.*, node_modules, .git). Narrow this if the tool is
    // pointed at a repo holding anything you would not paste into a prompt.
    roots: ["src", "app", "components"],
    extensions: [".tsx", ".jsx", ".ts", ".js"],
  },

  // There is no `agent` block to configure. The editor never calls a model
  // itself: handing work over means writing a brief under `stateDir/requests/`
  // and waking a coding agent attached over MCP, which needs no key, no model
  // name and no transport to choose between.

}

export default config
