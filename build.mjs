#!/usr/bin/env node
/**
 * Bundles the designlayer overlay, and the tokens the start screen needs.
 *
 * The overlay output is concatenated onto the vendored React Rewrite bundle by
 * the package runtime, so it must be a self-contained IIFE with no imports and
 * no globals beyond the bridge it reads from `window`.
 *
 * The tokens output exists because `src/core/tokens.ts` is the only source of
 * colour in this package and the start screen is served by plain ESM, before
 * any bundling happens and with no TypeScript loader in the process. Emitting
 * the same module twice — once into the browser IIFE, once as ESM Node can
 * import — is what lets the front door wear the chrome without a second copy
 * of the values.
 */

import { build } from "esbuild"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { writeBuildStamp } from "./runtime/bundle-stamp.mjs"
import { patchSonner } from "./tools/sonner-plugin.mjs"
import { stripCss } from "./tools/strip-css-comments.mjs"

const root = path.dirname(fileURLToPath(import.meta.url))
const tsconfig = path.join(root, "tsconfig.json")
const watch = process.argv.includes("--watch")
const check = process.argv.includes("--check")


/**
 * React's own dead-code probe, removed — because this bundle is not minified.
 *
 * `react-dom/index.js` ships a `checkDCE()` that hands ITSELF to React
 * DevTools, which reads the function back with `Function.prototype.toString`
 * and looks for the literal `'^_^'`. The string sits in a branch that only runs
 * in development, so a production build is supposed to have dropped it — and
 * with `minify: false` esbuild folds the condition to `if (false)` and leaves
 * the body sitting there in plain sight. The hook then reports, on every single
 * page load and twice:
 *
 *   React is running in production mode, but dead code elimination has not
 *   been applied.
 *
 * It is a false positive — the branch is genuinely unreachable — but the probe
 * cannot tell, and two console errors from a tool whose job is to sit quietly
 * beside somebody else's app is not a cost worth paying. The alternatives are
 * worse: `minifySyntax` clears it by comma-joining and re-declaring the
 * editor's OWN code, and turning `minify` on gives up a readable `dist/` for
 * one vendored string.
 *
 * Exact-once, in the spirit of `runtime/vendor-patch.mjs`: a React release that
 * renames or duplicates the probe should stop the build rather than quietly
 * stop being handled here.
 */
const PROBE = "throw new Error('^_^');"
const dropReactDceProbe = {
  name: "drop-react-dce-probe",
  setup(build) {
    build.onLoad({ filter: /[\\/]node_modules[\\/]react-dom[\\/](index|client)\.js$/ }, (args) => {
      const source = fs.readFileSync(args.path, "utf8")
      const first = source.indexOf(PROBE)
      if (first === -1 || source.indexOf(PROBE, first + PROBE.length) !== -1) {
        throw new Error(`react-dom no longer carries exactly one DCE probe: ${args.path}`)
      }
      return { contents: source.replace(PROBE, ""), loader: "js" }
    })
  },
}

/*
 * The toaster's React half, kept out of the editor bundle.
 *
 * React, ReactDOM and Sonner are ~740KB of what would otherwise be one blocking
 * script, and their only user is the toaster, which loads with the first
 * message. Even unevaluated they were parsed with the rest on every load that
 * had no code cache yet — the cold load and the first reload — and a blocking
 * script's parse is time the host's own modules wait behind. So they are the
 * second target below, an ES module the launcher serves beside the overlay
 * (`runtime/launcher.mjs`), and `core/toast.ts` imports it by the versioned
 * URL the overlay names. The import left in this bundle, for a page that names
 * none, is pointed at the same route unversioned rather than compiled in.
 */
const lazyToaster = {
  name: "lazy-toaster",
  setup(build) {
    build.onResolve({ filter: /^\.\/toaster-view$/ }, () => ({ path: "/__designlayer/toaster.js", external: true }))
  },
}

// Sonner's two bundle-time patches (the stylesheet it injects into the host
// document, and the height it measures through a transform) live in
// `tools/sonner-plugin.mjs`, shared with the demo tools that bundle the toaster.

const shared = {
  absWorkingDir: root,
  bundle: true,
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
  tsconfig,
  /*
   * React reads `process.env.NODE_ENV`, and there is no `process` in a browser.
   *
   * It arrives with Sonner, which draws the editor's toast (`core/toast.ts`) —
   * the one React root in a package that is otherwise plain DOM. Without this
   * the bundle throws `process is not defined` while it is still evaluating,
   * before a line of the editor runs, so this is load-bearing rather than an
   * optimisation. `production` also drops React's dev-only warnings, which are
   * about a tree the person using this editor does not own and cannot act on.
   *
   * Nothing else in `src/` reads `process`. If something ever does, this will
   * quietly rewrite it too, which is the trade a `define` always makes.
   */
  define: { "process.env.NODE_ENV": '"production"' },
}

const TARGETS = [
  {
    label: "designlayer bundle",
    outfile: path.join(root, "dist", "designlayer.js"),
    options: {
      ...shared,
      entryPoints: [path.join(root, "src", "index.ts")],
      format: "iife",
      platform: "browser",
      target: ["chrome110", "safari16"],
      // The stylesheets ship without their prose comments — see the plugin.
      plugins: [lazyToaster, stripCss],
    },
  },
  {
    label: "toaster module",
    outfile: path.join(root, "dist", "toaster.js"),
    options: {
      ...shared,
      entryPoints: [path.join(root, "src", "core", "toaster-view.ts")],
      format: "esm",
      platform: "browser",
      target: ["chrome110", "safari16"],
      // Only this target pulls React and Sonner in; the token module is data.
      plugins: [dropReactDceProbe, patchSonner, stripCss],
    },
  },
  {
    label: "token module",
    outfile: path.join(root, "dist", "tokens.mjs"),
    options: {
      ...shared,
      entryPoints: [path.join(root, "src", "core", "tokens.ts")],
      format: "esm",
      platform: "neutral",
    },
  },
]

/*
 * What a passing build compiled from, for `runtime/bundle-stamp.mjs`: the
 * files esbuild read, plus this script and the plugins it loads, which esbuild
 * never sees as inputs but which decide the output all the same.
 */
const BUILD_FILES = [
  fileURLToPath(import.meta.url),
  tsconfig,
  path.join(root, "tools", "sonner-plugin.mjs"),
  path.join(root, "tools", "strip-css-comments.mjs"),
]

async function run() {
  const inputs = [...BUILD_FILES]
  for (const target of TARGETS) {
    const result = await build({
      ...target.options,
      outfile: target.outfile,
      write: !check,
      metafile: true,
    })
    inputs.push(...Object.keys(result.metafile.inputs).map((file) => path.resolve(root, file)))

    if (!check) {
      console.log(`Built ${path.relative(process.cwd(), target.outfile)}`)
      continue
    }

    const fresh = Buffer.from(result.outputFiles?.[0]?.contents ?? new Uint8Array())
    if (!fs.existsSync(target.outfile)) {
      console.error(`FAIL ${target.label} is missing — run \`npm run design:build\``)
      process.exit(1)
    }
    // Compiling proves the source is valid; it does not prove `dist/` matches it.
    // The launcher serves whatever is on disk, so a stale bundle means the running
    // editor is older than the reviewed source — and every other check passes.
    const onDisk = fs.readFileSync(target.outfile)
    if (!fresh.equals(onDisk)) {
      console.error(
        `FAIL ${target.label} is stale — dist/ is ${onDisk.length} bytes, ` +
          `src/ compiles to ${fresh.length}. Run \`npm run design:build\`.`
      )
      process.exit(1)
    }
    console.log(`PASS ${target.label} compiles and matches dist/ (${fresh.length} bytes)`)
  }
  // Only reached when every target built or matched: the stamp vouches for a
  // `dist/` that is known to be what these inputs compile to, and nothing else.
  writeBuildStamp(root, inputs, TARGETS.map((target) => target.outfile))
}

if (watch) {
  const { context } = await import("esbuild")
  for (const target of TARGETS) {
    const ctx = await context({ ...target.options, outfile: target.outfile })
    await ctx.watch()
  }
  console.log("Watching designlayer sources…")
} else {
  await run()
}
