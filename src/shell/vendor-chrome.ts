/**
 * Keeps the vendored React Rewrite UI off the screen, from the first frame on.
 *
 * The vendor stays loaded — we drive it headlessly for fiber -> source
 * resolution and source writes — but its own chrome is replaced by ours, and
 * `css/base.ts` lists the nine surfaces that have to go. The list was never the
 * hard part. WHERE and WHEN the rule lands is.
 *
 * WHERE: the chrome is mounted into `#react-rewrite-root`'s open shadow root,
 * and a shadow boundary blocks selectors, not stacking. A rule in the document
 * cannot reach it at any specificity, so the stylesheet has to be appended
 * INSIDE the root. The `#react-rewrite-root .toolbar` copy of the same list
 * that `css/base.ts` puts in the document matches nothing in this vendor build;
 * it is left there because it costs nothing, but it is not what does the work,
 * and a fix that only edits that list will not change what is on screen.
 *
 * WHEN: the root is attached by the vendor, whose bundle is concatenated ahead
 * of ours and whose mount lands a frame or two after boot. Injecting from
 * `mountShell` — which waits on the bridge AND on host hydration first — put the
 * rule in at t=84ms against a vendor that painted its toolbar at t=35ms: a 49ms
 * flash of the wrong tool's UI on every single page load, longer on a cold
 * dev server, and the thing this module exists to make impossible.
 *
 * So the injection is hung off `attachShadow` itself. The vendor does
 * `createElement` -> set `id` -> append -> `attachShadow`, so by the time the
 * hook runs the host already identifies itself and the style goes in during the
 * same synchronous call that created the root — there is no frame in between
 * for anything to paint in.
 *
 * Two smaller things this also fixes, both of which produced a vendor UI that
 * stayed up for the rest of the session rather than for 49ms:
 *
 *   - The old injector started its retry timer ONLY if the first attempt
 *     failed, so the common path installed no watcher at all. Anything that
 *     removed the style afterwards — a vendor re-mount, an HMR round trip —
 *     was permanent until reload. A `MutationObserver` on the root now puts it
 *     back.
 *   - That retry gave up after 60 attempts and left the chrome visible by
 *     design. There is no deadline here: a root that attaches at minute three
 *     is hooked exactly like one that attaches at t=35ms.
 *
 * Ordering against the vendor's own stylesheets is not a concern: every rule
 * here is `!important`, and the vendor bundle contains no `!important` at all.
 */

import { vendorChromeCss } from "../core/css"

/** The vendor's mount point. It sets this id before calling `attachShadow`. */
const HOST_ID = "react-rewrite-root"
const STYLE_ID = "designlayer-vendor-suppression"

type ShadowFactory = (init: ShadowRootInit) => ShadowRoot

export interface VendorChromeOptions {
  /**
   * Called with the vendor's shadow root, as soon as there is one.
   *
   * A callback rather than an import, because this module is the only thing in
   * the package that knows WHEN that root exists and it has to stay cheap to
   * load — `test/vendor-chrome-cases.mjs` bundles it on its own and runs it in
   * jsdom, so a static edge from here to the toaster would pull React into a
   * suite about a stylesheet. The one caller is `index.ts`, which wires the
   * toast mirror in `core/toast.ts`.
   *
   * Re-invoked with the new root on a re-mount, and the disposer it returns is
   * called for the old one — the same lifecycle as the stylesheet beside it.
   */
  onRoot?: (root: ShadowRoot) => () => void
}

/** Idempotent: a second call returns the first one's disposer, uninstalled. */
let active: (() => void) | null = null

function isVendorHost(node: unknown): boolean {
  return node instanceof Element && node.id === HOST_ID
}

/** Appends the suppression stylesheet, unless it is already in this root. */
function inject(root: ShadowRoot): void {
  if (root.getElementById(STYLE_ID)) return
  const style = document.createElement("style")
  style.id = STYLE_ID
  style.textContent = vendorChromeCss
  root.append(style)
}

export function installVendorChromeSuppression(options: VendorChromeOptions = {}): () => void {
  if (active) return active

  let watched: ShadowRoot | null = null
  let releaseRoot: (() => void) | null = null
  /*
   * One observer, re-pointed rather than accumulated. The vendor gets exactly
   * one root at a time, and a re-mount replaces it; keeping a list would mean
   * holding a disconnected root alive to repair a stylesheet nobody can see.
   */
  const repair = new MutationObserver(() => {
    if (watched) inject(watched)
  })

  const adopt = (root: ShadowRoot): void => {
    inject(root)
    if (watched === root) return
    watched = root
    repair.disconnect()
    // `childList` only: the style's own text never changes, and subtree records
    // would fire on every keystroke the vendor's panels render.
    repair.observe(root, { childList: true })
    // After the stylesheet, not before: the subscriber watches a node this
    // suppression has just hidden, and hiding it first is what keeps a vendor
    // message from being shown by the vendor AND mirrored by us in one frame.
    releaseRoot?.()
    releaseRoot = options.onRoot?.(root) ?? null
  }

  /*
   * A root that already exists, for the case where the vendor mounted before
   * this module was parsed. Its host is appended to `<body>` BEFORE
   * `attachShadow` is called, so a root that exists is always reachable by id —
   * there is no detached-host window to miss.
   */
  const existing = document.getElementById(HOST_ID)?.shadowRoot
  if (existing) adopt(existing)

  /*
   * The hook. Patched on the prototype rather than on the host element, because
   * the element does not exist yet — that is the whole point — and a design
   * tool cannot wait for the thing it is suppressing to show up first.
   *
   * Every other element's `attachShadow` is passed straight through untouched.
   * A host app's own web components are none of our business, and a
   * `display: none` for `.toolbar` inside one of them would be a bug we caused.
   */
  const proto = Element.prototype
  const original = proto.attachShadow
  const patched: ShadowFactory = function attachShadow(
    this: Element,
    init: ShadowRootInit
  ): ShadowRoot {
    const root = original.call(this, init)
    if (isVendorHost(this)) adopt(root)
    return root
  }
  proto.attachShadow = patched

  active = () => {
    active = null
    repair.disconnect()
    releaseRoot?.()
    releaseRoot = null
    watched = null
    // Only if nothing else patched over us in the meantime: restoring a stale
    // reference would silently uninstall whoever came second.
    if (proto.attachShadow === patched) proto.attachShadow = original
    document.getElementById(HOST_ID)?.shadowRoot?.getElementById(STYLE_ID)?.remove()
  }
  return active
}
