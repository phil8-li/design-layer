/**
 * The desk shell: one window, a tab strip in the title bar, an iframe per tab.
 *
 * Self-contained on purpose (inline CSS and JS, no build step): the page is
 * served by a LaunchAgent from a checkout other people are editing, and it must
 * keep working when src/ is mid-change or dist/ is stale.
 *
 * Framing was checked, not assumed: neither runtime/start-screen.mjs, the
 * editor proxy (runtime/launcher.mjs, react-rewrite-cli) nor server/routes.mjs
 * sends X-Frame-Options or a CSP frame-ancestors, so the start screen and every
 * editor proxy load directly in an iframe. Every frame is on localhost, the
 * host name apps treat as their dev host (an app on 127.0.0.1 can show its
 * signed-out screen instead of itself), and so is this page
 * (runtime/mac-desk.mjs). A frame on another site than its parent gets no
 * SameSite=Lax cookie and partitioned storage, so an app with cookie sign-in
 * showed as signed out here while the page was on 127.0.0.1.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Every glyph in the strip is a 20px title-bar icon in symbols/ (see the
 * README there).
 *
 * The ⋮ menu at the right end of the title bar is Chrome's, and stays: the page
 * only gets the rectangle beside it and cannot restyle it (APP_FEATURES in
 * chrome-pipe.mjs clears Chrome's other buttons). Chrome draws it from this set
 * at 20px, in white. The strip draws its own glyphs the same way, so the row
 * reads as one set: 20px in a button and 16px inside a tab, the size of a
 * favicon.
 */
const SYMBOLS = path.join(path.dirname(fileURLToPath(import.meta.url)), "symbols")
export const GLYPHS = Object.fromEntries(
  ["add", "close", "folder", "home", "refresh", "web_asset"].map((name) => [
    name,
    fs.readFileSync(path.join(SYMBOLS, `${name}.svg`), "utf8").match(/<path d="([^"]+)"/)[1],
  ])
)

export function glyph(name, size) {
  return `<svg width="${size}" height="${size}" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="${GLYPHS[name]}"/></svg>`
}

/**
 * Whether a window title is the desk's: "DesignLayer" on Home, or
 * "<editor> — DesignLayer" while an editor tab is active (see the title line
 * in the page script below).
 */
export function isDeskTitle(title) {
  return title === "DesignLayer" || title.endsWith(" — DesignLayer")
}

/** Where the page saves its tabs in its own storage; install.mjs reads it too. */
export const TABS_KEY = "designlayer.desk.tabs.v1"

export function shellPage({ repoRoot, version = null }) {
  const startCommand = `node ${repoRoot}/desktop/mac/install.mjs --start`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#1a1a1a">
<title>DesignLayer</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/mark.svg" type="image/svg+xml">
<style>
  :root {
    --ground: #1a1a1a; --raised: #232323; --tab: #2a2a2a; --ink: #fff;
    --ink-2: rgba(255,255,255,.62); --ink-3: rgba(255,255,255,.4);
    --hair: rgba(255,255,255,.08); --hair-2: rgba(255,255,255,.14);
    --accent: #7cc4f8; --fill: #0c8ce9; --danger: #f28b82;
    --strip-h: env(titlebar-area-height, 38px);
    /* Tab geometry (see .tabs). */
    --ext: 8px; --overlap: 10px; --tab-top: 5px;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--ground); color: var(--ink);
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased; overflow: hidden; }
  button { font: inherit; color: inherit; }
  kbd { font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink-2);
    border: 1px solid var(--hair-2); border-radius: 4px; padding: 2px 4px; }
  code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }

  /* Title bar. With Window Controls Overlay the strip sits beside the traffic
     lights; without it (a normal tab, or overlay toggled off) it is a top bar. */
  .strip { position: fixed; top: env(titlebar-area-y, 0); left: env(titlebar-area-x, 0);
    width: env(titlebar-area-width, 100%); height: var(--strip-h);
    display: flex; align-items: center; gap: 2px; padding: 0 6px 0 0;
    -webkit-app-region: drag; app-region: drag; user-select: none; }
  .strip::after { content: ""; position: fixed; left: 0; right: 0; top: var(--strip-h);
    border-top: 1px solid var(--hair); pointer-events: none; }
  body:not(.wco) .strip { padding-left: 2px; }
  /* Tabs, drawn as Chrome draws them (horizontal_tab_style_views.cc). Each
     tab is as wide as its whole name needs (layoutTabs below); short of room
     the widest give way first, down to 72px. Without that script's widths
     they share the strip equally, up to 216px. A tab's
     box reaches --ext past its body on each side, and neighbours overlap by
     --overlap, so the bodies sit 6px apart with a separator between them. The
     active tab's body runs down to the bottom edge, over the hairline, and
     flares into it with two concave feet of radius --ext. A hovered tab gets
     a detached pill. Separators hide beside any tab with a fill. */
  /* The row is as wide as its --n tabs at full width, and shrinks from there
     when the strip is short of room; the tabs share what it gets. */
  .tabs { position: relative; z-index: 1; display: flex; align-items: stretch; align-self: flex-start;
    width: calc(var(--n, 1) * 216px - (var(--n, 1) - 1) * var(--overlap));
    height: calc(var(--strip-h) + 1px); min-width: 0; flex: 0 1 auto; overflow-x: clip;
    -webkit-app-region: no-drag; app-region: no-drag; }
  .tab, .icon-btn { -webkit-app-region: no-drag; app-region: no-drag; }
  /* Level with the tabs' contents, which sit in the body below --tab-top. */
  #newTab { align-self: flex-start; margin-top: calc(var(--tab-top) + (var(--strip-h) + 1px - var(--tab-top) - 28px) / 2); }
  .tab { position: relative; display: flex; align-items: center; gap: 6px; flex: 0 1 216px; min-width: 72px;
    padding: var(--tab-top) calc(var(--ext) + 6px) 0 calc(var(--ext) + 9px); border: 0; background: transparent;
    color: var(--ink-2); cursor: default; font-size: 12px; transition: color .12s; }
  .tab + .tab { margin-left: calc(-1 * var(--overlap)); }
  .tab::before { content: ""; position: absolute; z-index: -1; left: var(--ext); right: var(--ext);
    top: var(--tab-top); bottom: 5px; border-radius: 8px; transition: background-color .12s; }
  .tab:hover { color: var(--ink); }
  .tab:hover::before { background: rgba(255,255,255,.06); }
  .tab[aria-selected="true"] { color: var(--ink);
    background: radial-gradient(circle at 0 0, transparent calc(var(--ext) - .5px), var(--tab) var(--ext)) left bottom / var(--ext) var(--ext) no-repeat,
      radial-gradient(circle at 100% 0, transparent calc(var(--ext) - .5px), var(--tab) var(--ext)) right bottom / var(--ext) var(--ext) no-repeat; }
  .tab[aria-selected="true"]::before { background: var(--tab); bottom: 0; border-radius: 8px 8px 0 0; }
  .tab::after { content: ""; position: absolute; left: calc(var(--overlap) / 2 - 1px); top: 14px; width: 2px; height: 16px;
    border-radius: 1px; background: var(--hair-2); transition: opacity .12s; }
  .tab:first-child::after, .tab[aria-selected="true"]::after, .tab:hover::after, .tab.lifted::after, .tab.incoming::after,
  .tab[aria-selected="true"] + .tab::after, .tab:hover + .tab::after, .tab.lifted + .tab::after, .tab.incoming + .tab::after { opacity: 0; }
  .tab:focus-visible { outline: none; }
  .tab:focus-visible::before { outline: 2px solid var(--accent); outline-offset: -2px; }
  .icon-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  /* A tab's glyphs take the tab's text color: one color, like Chrome's. */
  .tab .glyph { width: 16px; height: 16px; flex: none; display: grid; place-items: center; }
  .tab .label { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Renaming a tab: the name becomes a field in its place, ringed in the
     accent. */
  .tab .rename { flex: 1 1 auto; min-width: 0; width: 100%; height: 20px; margin: 0 -4px; padding: 0 4px;
    border: 0; border-radius: 4px; outline: 2px solid var(--accent); outline-offset: -2px;
    background: var(--ground); color: var(--ink); font: inherit; }
  /* The close button keeps to the tab's end, so it is always the same
     distance from its tab's right edge. */
  .tab .close { margin-left: auto; }
  /* Measures a tab's name at the tab's own type size (layoutTabs). */
  #measure { position: absolute; left: -10000px; top: 0; visibility: hidden; white-space: nowrap; pointer-events: none; }
  #measure.measure-label { font-size: 12px; }
  .tab .close { width: 16px; height: 16px; border-radius: 4px; display: grid; place-items: center;
    opacity: 0; flex: none; }
  .tab:hover .close, .tab[aria-selected="true"] .close { opacity: 1; }
  .tab .close:hover { background: rgba(255,255,255,.1); }
  .tab.dead .glyph { color: var(--ink-3); }
  .tab.dead .label { color: var(--ink-3); text-decoration: line-through; text-decoration-color: var(--ink-3); }
  /* Dragging a tab. The tab follows the pointer with no easing; the tabs it
     passes slide aside to show where it will land. Pulled below or out of the
     strip it leaves the row, which closes up, and a copy follows the pointer. */
  .tabs.reordering .tab:not(.lifted) { transition: transform .15s cubic-bezier(.23,1,.32,1), color .12s; }
  .tab.lifted { z-index: 2; color: var(--ink); }
  .tab.lifted.away { opacity: 0; }
  .tab.settling { transition: transform .15s cubic-bezier(.23,1,.32,1); }
  /* Where a tab dragged from another window will land. */
  .tab.incoming { color: var(--ink); }
  .tab.incoming::before { background: rgba(12,140,233,.16); box-shadow: inset 0 0 0 1px rgba(124,196,248,.5); }
  .tab-ghost { position: fixed; left: 0; top: 0; z-index: 11; pointer-events: none; display: grid; gap: 6px; justify-items: start; }
  .tab-ghost .tab { height: 30px; padding-top: 0; margin: 0; background: none; color: var(--ink); }
  .tab-ghost .tab::before { top: 0; bottom: 0; border-radius: 8px; background: var(--tab);
    box-shadow: 0 0 0 1px var(--hair-2), 0 10px 30px rgba(0,0,0,.36); }
  .tab-ghost .tab::after { display: none; }
  .tab-ghost .hint { margin-left: var(--ext); }
  .tab-ghost .hint { padding: 3px 8px; border-radius: 6px; border: 1px solid var(--hair-2); background: var(--raised);
    color: var(--ink-2); font-size: 11px; white-space: nowrap; }
  body.dragging-tab .frames iframe { pointer-events: none; }
  @media (prefers-reduced-motion: reduce) { .tabs.reordering .tab:not(.lifted), .tab.settling { transition: none; } }
  /* A tab's menu: the way to move a tab without dragging it. */
  .menu { position: fixed; left: 0; top: 0; z-index: 12; min-width: 200px; max-width: 320px; padding: 4px;
    border: 1px solid var(--hair-2); border-radius: 10px; background: var(--raised); box-shadow: 0 10px 30px rgba(0,0,0,.36); }
  .menu[hidden] { display: none; }
  .menu button { display: block; width: 100%; height: 28px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent;
    color: var(--ink); text-align: left; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .menu button:hover:not(:disabled), .menu button:focus-visible { background: rgba(255,255,255,.07); outline: none; }
  .menu button:disabled { color: var(--ink-3); }
  .menu hr { border: 0; border-top: 1px solid var(--hair); margin: 4px 6px; }
  /* A tab's tooltip: the localhost address of what it shows, under its full
     name when the tab cuts that name short. The page
     draws it because render() rebuilds the strip on every poll, and a native
     title tip closes when the element under the pointer is replaced. Drawn as
     the editor's tip (src/core/css/tooltip.ts): panel ground, body ink, the
     popover hairline and cast, 6x12 padding on a 12px corner, 6px off the tab.
     It opens instantly and fades out in 150ms. */
  .tip { position: fixed; left: 0; top: 0; z-index: 10; width: max-content;
    max-width: min(320px, calc(100vw - 16px)); padding: 5px 11px; border: 1px solid var(--hair-2);
    border-radius: 12px; background: var(--raised); color: var(--ink); box-shadow: 0 10px 30px rgba(0,0,0,.36);
    font-size: 12px; line-height: 16px; white-space: pre-line; overflow-wrap: anywhere; pointer-events: none;
    opacity: 0; visibility: hidden; transition: opacity .15s cubic-bezier(.22,1,.36,1), visibility 0s linear .15s; }
  .tip.open { opacity: 1; visibility: visible; transition: none; }
  .tip-name:not([hidden]) + .tip-detail { color: var(--ink-2); }
  .tip-name[hidden], .tip-detail[hidden] { display: none; }
  @media (prefers-reduced-motion: reduce) { .tip { transition: none; } }
  /* Full white at rest, like Chrome's own buttons. Reload and the folder sit 40px
     apart, the spacing of Chrome's own buttons, so the corner reads as one row. */
  .icon-btn { width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent;
    color: var(--ink); display: grid; place-items: center; flex: none; }
  .icon-btn:hover { background: rgba(255,255,255,.07); }
  .tools { display: flex; gap: 12px; }
  /* Dimmed while the window is in the background, as Chrome dims its ⋮ button
     beside them (measured: about 31% white on this ground). */
  body.inactive .icon-btn:not(:hover) { color: rgba(255,255,255,.31); }
  .spacer { flex: 1; min-width: 24px; height: 100%; }
  /* Shown while the start screen has an update to offer, or is running one.
     It opens Home, where the update is described and started. */
  .update { -webkit-app-region: no-drag; app-region: no-drag; display: flex; align-items: center; gap: 6px;
    height: 22px; padding: 0 8px; border: 0; border-radius: 6px; flex: none; white-space: nowrap;
    background: rgba(12,140,233,.16); color: var(--accent); font-size: 11px; }
  .update:hover { background: rgba(12,140,233,.26); }
  .update:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .update[hidden] { display: none; }

  .frames { position: fixed; left: 0; right: 0; bottom: 0; top: calc(var(--strip-h) + 1px); background: var(--ground); }
  .frames iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: var(--ground); }
  .frames iframe[hidden] { display: block; visibility: hidden; pointer-events: none; }

  .sheet { position: absolute; inset: 0; display: grid; place-items: center; background: var(--ground); z-index: 2; }
  .sheet[hidden] { display: none; }
  .card { width: min(420px, calc(100% - 48px)); text-align: center; }
  .card img { width: 56px; height: 56px; margin-bottom: 16px; }
  .card h1 { font-size: 15px; font-weight: 600; margin: 0 0 6px; letter-spacing: -.01em; }
  .card p { margin: 0 0 14px; color: var(--ink-2); font-size: 12px; }
  .card .cmd { display: block; text-align: left; background: var(--raised); border: 1px solid var(--hair);
    border-radius: 8px; padding: 10px 12px; color: var(--ink); user-select: all; margin-bottom: 14px; overflow-wrap: anywhere; }
  .card [hidden] { display: none; }
  .card .row { display: flex; gap: 8px; justify-content: center; }
  .btn { height: 28px; padding: 0 12px; border-radius: 6px; border: 1px solid var(--hair-2); background: var(--raised); color: var(--ink); }
  .btn:hover { border-color: rgba(255,255,255,.24); }
  .btn.primary { background: var(--fill); border-color: var(--fill); }
  .btn.primary:hover { background: #1a96ef; }
  .spinner { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--hair-2);
    border-top-color: var(--accent); animation: spin .9s linear infinite; margin: 0 auto 14px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }
  .toast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); background: var(--raised);
    border: 1px solid var(--hair-2); border-radius: 8px; padding: 8px 12px; color: var(--ink); font-size: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,.4); z-index: 5; max-width: calc(100% - 32px); }
  .toast[hidden] { display: none; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
</head>
<body>
<header class="strip" id="strip">
  <nav class="tabs" id="tabs" role="tablist" aria-label="Open tabs"></nav>
  <button class="icon-btn" id="newTab" title="New Home tab (⌘T)" aria-label="New Home tab">${glyph("add", 20)}</button>
  <div class="spacer"></div>
  <button class="update" id="update" title="Open Home to see what changed and update" hidden>Update available</button>
  <div class="tools">
    <button class="icon-btn" id="reload" title="Reload this tab" aria-label="Reload this tab">${glyph("refresh", 20)}</button>
    <button class="icon-btn" id="pickFolder" title="Choose a project folder and copy its path" aria-label="Choose a project folder">${glyph("folder", 20)}</button>
  </div>
</header>
<main class="frames" id="frames">
  <section class="sheet" id="boot" aria-live="polite">
    <div class="card">
      <img src="/icons/mark.svg" alt="">
      <div class="spinner" id="bootSpin"></div>
      <h1 id="bootTitle">Starting…</h1>
      <p id="bootText" hidden>Run this in Terminal:</p>
      <code class="cmd" id="bootCmd" hidden>${escapeHtml(startCommand)}</code>
    </div>
  </section>
</main>
<div class="toast" id="toast" role="status" hidden></div>
<div class="tip" id="tip" aria-hidden="true"><div class="tip-name"></div><div class="tip-detail"></div></div>
<div class="menu" id="menu" role="menu" aria-label="Tab" hidden></div>
<span id="measure" aria-hidden="true"></span>
<script>
(() => {
  const KEY = ${JSON.stringify(TABS_KEY)}
  // The commit the desk ran when it served this page (runtime/updater.mjs).
  const VERSION = ${JSON.stringify(version)}
  const $ = (id) => document.getElementById(id)
  const tabsEl = $("tabs"), framesEl = $("frames")
  let health = null, editors = [], homeUrl = null, deskDown = false
  let tabs, active

  function uid() { return Math.random().toString(36).slice(2, 9) }

  // Names a person gave apps' tabs, by app: its project folder and app port,
  // the pair that also keeps each app's editor ports (runtime/editor-ports.mjs).
  // One folder can run two apps (a front end and its agent server), and each
  // tab gets a name of its own. A tab whose app is not known yet is named by
  // its editor's address. The desk keeps them
  // (GET/PUT /api/names); this origin's storage holds a copy for the first
  // paint, and the windows tell each other of a rename at once.
  const NAMES_KEY = KEY + ".names"
  let names = (() => { try { return JSON.parse(localStorage.getItem(NAMES_KEY)) || {} } catch { return {} } })()
  let namesLoaded = false
  const appOf = (e) => {
    if (!e || !e.projectRoot || !e.appUrl) return null
    try { const u = new URL(e.appUrl); return e.projectRoot + "|" + (u.port || (u.protocol === "https:" ? "443" : "80")) } catch { return null }
  }
  const nameKey = (t) => appOf(editors.find((e) => e.url === t.url)) || t.app || t.url
  const customName = (t) => (t.kind === "editor" ? names[nameKey(t)] || names[t.url] || null : null)
  // What a tab is called everywhere in the window: the strip, the tip, the
  // window title, menus, and a dragged copy.
  const labelOf = (t) => (t.kind === "home" ? "Home" : customName(t) || t.name || t.url)
  function takeNames(next) {
    if (!next || typeof next !== "object") return false
    const same = JSON.stringify(next) === JSON.stringify(names)
    names = next
    try { localStorage.setItem(NAMES_KEY, JSON.stringify(names)) } catch {}
    return !same
  }
  const editorKey = (e) => e.url + "#" + e.pid
  // An editor tab is addressed by its editor's origin (url); src is the page in
  // it to load, when one was asked for — "Open in Mac app" hands over a path.
  const tabUrl = (t) => (t.kind === "home" ? homeUrl : t.src || t.url)
  const originOf = (u) => { try { return new URL(u).origin } catch { return null } }
  // Every editor is framed on localhost, the host name apps treat as their dev
  // host (runtime/launcher.mjs, BROWSER_HOST). Older registry entries, saved
  // tabs and handed pages may say 127.0.0.1; they are the same editor.
  const onLocalhost = (u) => {
    if (typeof u !== "string") return u
    try {
      const origin = new URL(u).origin
      const x = new URL(u)
      if (x.hostname !== "127.0.0.1" || !u.startsWith(origin)) return u
      x.hostname = "localhost"
      return x.origin + u.slice(origin.length)
    } catch { return u }
  }

  // Windows. Each window of the app names itself in its address (?window=):
  // "main" is the one the app opens with, and a tab pulled out of a window
  // opens a window of its own. Each keeps its tabs under its own key. The
  // windows tell each other what they show over a BroadcastChannel: which
  // editors have a tab, where each window's tab strip is on screen (to drop a
  // tab dragged from another window), and which window was used last.
  const params = new URLSearchParams(location.search)
  const launched = !params.get("window")
  let wid = params.get("window") || "main"
  const keyOf = (w) => (w === "main" ? KEY : KEY + ":" + w)
  const readLocal = (k) => { try { return JSON.parse(localStorage.getItem(k)) } catch { return null } }
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("designlayer-desk") : null
  // Other windows, by id: { tabs, title, focusedAt, geo, seen }.
  const peers = new Map()
  // Until this window knows its id, it speaks under a name nobody else has.
  const probeId = "?" + Math.random().toString(36).slice(2, 9)
  let identified = !channel
  // Two windows that open at once both ask before either answers. The one
  // with the higher probe name lets the other have the id they both want.
  let yielded = false
  let focusedAt = document.hasFocus() ? Date.now() : 0
  // Set once this window gave its last tab away and is closing.
  let gone = false
  // Whether this window opened on saved tabs, and when that record says it closed.
  let hadRecord = false, closedAt = 0

  function adopt(s) {
    tabs = Array.isArray(s?.tabs) && s.tabs.length ? s.tabs : [{ id: uid(), kind: "home" }]
    active = tabs.some((t) => t.id === s?.active) ? s.active : tabs[0].id
    hadRecord = Boolean(Array.isArray(s?.tabs) && s.tabs.length)
    closedAt = hadRecord ? s.closedAt || 0 : 0
    for (const t of tabs) { t.url = onLocalhost(t.url); t.src = onLocalhost(t.src) }
  }
  let saved = readLocal(keyOf(wid))
  adopt(saved)
  // The desk keeps a copy of the tabs (PUT /api/tabs, below), stamped with
  // when it was saved. The page's own storage can be older than that copy: the
  // window moved from 127.0.0.1 to localhost and opened with nothing, or
  // Chrome quit before it wrote the page's last change (measured: tabs closed
  // a moment before quitting came back). So a page takes the desk's copy when
  // it is newer than its own, and writes nothing until the desk has answered:
  // its stale or lone-Home tabs would replace the newer copy.
  let restoring = true
  async function restore() {
    const ask = new AbortController(), timer = setTimeout(() => ask.abort(), 1500)
    try {
      const s = await fetch("/api/tabs?window=" + wid, { cache: "no-store", signal: ask.signal }).then((r) => r.json())
      const mine = Array.isArray(saved?.tabs) && saved.tabs.length ? saved.savedAt || 0 : -1
      if (Array.isArray(s?.tabs) && s.tabs.length && (s.savedAt || 0) > mine) adopt(s)
      restoring = false
    } catch {
      // No desk to ask: the page's own copy is the best there is.
      if (Array.isArray(saved?.tabs) && saved.tabs.length) restoring = false
    }
    clearTimeout(timer)
    if (!restoring && launched && channel) await reopenWindows()
  }

  // Which window this is. The app's first window opens on "/", and so does a
  // window from File › New Window: the first is "main" and reopens the
  // windows saved with it; a new one, opened while other windows are up, gets
  // an id and a Home tab of its own. Its address then names it, so a reload
  // keeps it.
  const identifying = (async () => {
    if (!channel) return
    post({ t: "hello", want: wid })
    await new Promise((r) => setTimeout(r, 150))
    if ((launched && peers.size) || peers.has(wid) || yielded) {
      wid = "w" + uid()
      saved = null
      adopt(null)
      restoring = false
    }
    identified = true
    try { history.replaceState(history.state, "", location.pathname + "?window=" + wid + location.hash) } catch {}
    announce()
  })()

  // Every window saved here besides this one: the desk's copy, or the page's
  // own when that is newer.
  async function savedWindows() {
    let all = {}, goneAt = {}
    try {
      const r = await fetch("/api/tabs?all=1", { cache: "no-store" }).then((x) => x.json())
      all = r.windows || {}
      goneAt = r.gone || {}
    } catch {}
    const keys = []
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i))
    for (const k of keys) {
      if (!k || !k.startsWith(KEY + ":")) continue
      const s = readLocal(k), w = k.slice(KEY.length + 1)
      // A copy of a window that closed after it was saved: Chrome dropped
      // that window's last write to this storage when the app quit.
      if (s && goneAt[w] >= (s.savedAt || 0)) { localStorage.removeItem(k); continue }
      if (s && (!all[w] || (s.savedAt || 0) > (all[w].savedAt || 0))) all[w] = s
    }
    delete all[wid]
    // A window that is up already is not opened again.
    for (const w of peers.keys()) delete all[w]
    return Object.entries(all).filter(([, s]) => Array.isArray(s?.tabs) && s.tabs.length)
  }
  function forget(w) {
    localStorage.removeItem(keyOf(w))
    return fetch("/api/tabs", { method: "PUT", body: JSON.stringify({ window: w, gone: true, savedAt: Date.now() }) }).catch(() => {})
  }
  // The app started again. Chrome reopens only its first window, so that
  // window asks the desk to reopen the others saved with it. Windows that
  // closed within a few seconds of the last one were the app quitting, and
  // come back; one closed on its own before that does not. A window the desk
  // cannot open gives its tabs to this one, so no tab is lost.
  async function reopenWindows() {
    const others = await savedWindows()
    if (!others.length) return
    const latest = Math.max(closedAt, ...others.map(([, s]) => s.closedAt || 0))
    const recent = (at) => !at || at >= latest - 5000
    const keep = others.filter(([, s]) => recent(s.closedAt))
    for (const [w] of others) if (!keep.some(([k]) => k === w)) forget(w)
    // This window closed on its own before the others did: it opens as the
    // window that was still up.
    if ((!hadRecord || !recent(closedAt)) && keep.length) {
      const [w, s] = keep.shift()
      adopt({ ...s, closedAt: 0 })
      forget(w)
    }
    for (const [w, s] of keep) {
      const ok = await fetch("/api/windows/open", { method: "POST", body: JSON.stringify({ window: w }) })
        .then((r) => r.json()).then((r) => r.ok === true).catch(() => false)
      if (ok) continue
      for (const t of s.tabs) if (!(t.kind === "editor" && tabs.some((x) => x.kind === "editor" && x.url === onLocalhost(t.url)))) {
        tabs.push({ ...t, url: onLocalhost(t.url), src: onLocalhost(t.src) })
      }
      forget(w)
    }
    render()
  }

  const tabState = () => ({
    tabs: tabs.map(({ id, kind, url, src, name, key, app }) => ({ id, kind, url, src, name, key, app })),
    active,
  })
  let mirrored = null
  function persist() {
    if (restoring || gone || !identified) return
    const state = tabState()
    // Stamped only when something changed: render runs on every poll.
    const body = JSON.stringify(state)
    if (body === mirrored) return
    mirrored = body
    const stamped = { ...state, savedAt: Date.now() }
    localStorage.setItem(keyOf(wid), JSON.stringify(stamped))
    fetch("/api/tabs", { method: "PUT", body: JSON.stringify({ ...stamped, window: wid }), keepalive: true }).catch(() => { mirrored = null })
  }
  // A window that closes says when, in this origin's storage, so the app
  // reopens it only with the windows that closed with it (reopenWindows). A
  // reload writes it too, and the page that loads next saves over it. Chrome
  // drops a request a closing window sends, so the desk's copy hears of it
  // from the windows still up (see "bye" below).
  let leaving = false
  addEventListener("pageshow", () => { leaving = false })
  addEventListener("pagehide", () => {
    leaving = true
    post({ t: "bye" })
    if (restoring || gone || !identified) return
    const stamped = { ...tabState(), savedAt: Date.now(), closedAt: Date.now() }
    localStorage.setItem(keyOf(wid), JSON.stringify(stamped))
    fetch("/api/tabs", { method: "PUT", body: JSON.stringify({ ...stamped, window: wid }), keepalive: true }).catch(() => {})
  })

  function post(message) {
    if (channel) try { channel.postMessage({ ...message, from: identified ? wid : probeId }) } catch {}
  }
  // What the other windows need to know about this one.
  function announce() {
    if (!identified || gone) return
    const cur = tabs.find((t) => t.id === active)
    const name = cur ? labelOf(cur) : "Home"
    post({ t: "state", tabs: tabs.map(({ id, kind, url }) => ({ id, kind, url })),
      title: tabs.length > 1 ? name + " and " + (tabs.length - 1) + (tabs.length === 2 ? " other tab" : " other tabs") : name, focusedAt, geo: geometry() })
  }
  // Where this page's viewport and tab strip are on screen. Measured from a
  // pointer event when there has been one; until then, the window's frame is
  // taken to be all above the page, as it is with no title bar.
  let calibrated = null
  function geometry() {
    const r = $("strip").getBoundingClientRect()
    const cal = calibrated || { x: 0, y: outerHeight - innerHeight }
    return { x: screenX + cal.x, y: screenY + cal.y, w: innerWidth, h: innerHeight,
      strip: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }
  }
  addEventListener("pointermove", (ev) => {
    calibrated = { x: ev.screenX - ev.clientX - screenX, y: ev.screenY - ev.clientY - screenY }
  }, { passive: true })
  const editorPeer = (url) => [...peers].find(([, p]) => (p.tabs || []).some((t) => t.kind === "editor" && t.url === url))?.[0]
  function prunePeers() {
    for (const [id, p] of peers) if (Date.now() - p.seen > 3500) peers.delete(id)
  }

  // An editor tab gets no frame until the first editor list names its app's
  // last page: given its saved page first, every editor tab loaded twice as the
  // window opened. A desk that does not answer holds them back 1.5 s at most.
  let listed = false
  setTimeout(() => { if (!listed) { listed = true; render() } }, 1500)

  function toast(text, ms = 3200) {
    const el = $("toast"); el.textContent = text; el.hidden = false
    clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), ms)
  }

  const HOME_GLYPH = ${JSON.stringify(glyph("home", 16))}
  const EDIT_GLYPH = ${JSON.stringify(glyph("web_asset", 16))}
  const X = ${JSON.stringify(glyph("close", 16))}

  function render() {
    // A tab being pressed or dragged keeps its element: the strip is rebuilt
    // when the drag ends.
    // A tab being renamed keeps its field, and what is typed in it, until the
    // name is saved or let go.
    if (press || drag || renaming) { syncFrames(); persist(); announce(); return }
    tabsEl.textContent = ""
    tabs.forEach((t, i) => {
      if (incoming && incoming.index === i) tabsEl.append(incomingTab())
      const b = document.createElement("div")
      b.className = "tab"; b.setAttribute("role", "tab"); b.tabIndex = t.id === active ? 0 : -1
      b.dataset.id = t.id
      b.setAttribute("aria-selected", String(t.id === active))
      // A tab with no key yet was just sent to an editor the next list will
      // name; until then it is new, not stopped.
      const dead = t.kind === "editor" && t.key !== null && !editors.some((e) => e.url === t.url)
      if (dead && health) b.classList.add("dead")
      const name = labelOf(t)
      tipData(b, "tab:" + t.id, name, t.kind === "home" ? hostOf(homeUrl) : appAddress(editors.find((e) => e.url === t.url)))
      b.innerHTML = '<span class="glyph">' + (t.kind === "home" ? HOME_GLYPH : EDIT_GLYPH) + '</span><span class="label"></span>' +
        (tabs.length > 1 ? '<span class="close" role="button" aria-label="Close tab">' + X + "</span>" : "")
      b.querySelector(".label").textContent = name
      b.onmousedown = (ev) => { if (ev.button === 1) { ev.preventDefault(); closeByMouse(t.id) } }
      b.onclick = (ev) => { if (ev.target.closest(".close")) closeByMouse(t.id); else select(t.id) }
      b.oncontextmenu = (ev) => { ev.preventDefault(); openMenu(t.id, ev.clientX, ev.clientY) }
      // A double-click on the name renames the tab, as in Figma's and VS
      // Code's tabs; Home is always Home.
      b.ondblclick = (ev) => { if (!ev.target.closest(".close")) startRename(t.id) }
      b.onkeydown = (ev) => {
        if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
          ev.preventDefault()
          // ⌘⇧← and ⌘⇧→ move the tab; the arrows alone move between tabs.
          if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey) return moveTab(t.id, ev.key === "ArrowRight" ? 1 : -1)
          const n = (i + (ev.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
          select(tabs[n].id); focusTab(tabs[n].id)
        } else if (ev.key === "F2") {
          ev.preventDefault()
          startRename(t.id)
        } else if (ev.key === "ContextMenu" || (ev.key === "F10" && ev.shiftKey)) {
          ev.preventDefault()
          const r = b.getBoundingClientRect()
          openMenu(t.id, r.left, r.bottom + 4, true)
        }
      }
      tabsEl.append(b)
    })
    if (incoming && incoming.index >= tabs.length) tabsEl.append(incomingTab())
    tabsEl.style.setProperty("--n", String(tabs.length + (incoming ? 1 : 0)))
    layoutTabs()
    // The tab under the pointer is a new element now: keep its tip on it.
    if (tipFor) {
      const el = [...tabsEl.children].find((c) => c.dataset.tipId === tipFor)
      if (el) showTip(el); else hideTip()
    }
    syncFrames()
    persist()
    announce()
  }
  const focusTab = (id) => tabsEl.querySelector('.tab[data-id="' + id + '"]')?.focus()

  // ---- Renaming a tab ----
  //
  // The name turns into a field on the tab. Enter or a click elsewhere saves
  // it, Escape lets it go, and an empty name gives the tab back its folder's
  // name. The name belongs to the app, not to this one tab: it follows the app
  // into any tab and any window that shows it, and survives the app quitting.
  let renaming = null
  function startRename(id) {
    const t = tabs.find((x) => x.id === id)
    if (!t || t.kind !== "editor" || drag) return
    closeMenu()
    hideTip()
    endClosing()
    if (renaming) finishRename(true)
    if (active !== id) select(id)
    else render()
    const el = tabsEl.querySelector('.tab[data-id="' + id + '"]')
    const label = el?.querySelector(".label")
    if (!label) return
    renaming = id
    el.classList.add("renaming")
    const input = document.createElement("input")
    input.className = "rename"
    input.value = labelOf(t)
    input.maxLength = 80
    input.spellcheck = false
    input.setAttribute("aria-label", "Tab name")
    input.placeholder = t.name || ""
    // Keys typed here are the field's: not the tab's arrows, ⌘W, or the editor's.
    input.onkeydown = (ev) => {
      ev.stopPropagation()
      if (ev.key === "Enter") { ev.preventDefault(); finishRename(true) }
      else if (ev.key === "Escape") { ev.preventDefault(); finishRename(false) }
    }
    input.onblur = () => finishRename(true)
    input.onclick = (ev) => ev.stopPropagation()
    input.ondblclick = (ev) => ev.stopPropagation()
    label.replaceWith(input)
    input.focus()
    input.select()
  }
  function finishRename(save) {
    const id = renaming
    if (!id) return
    renaming = null
    const input = tabsEl.querySelector("input.rename")
    const t = tabs.find((x) => x.id === id)
    if (save && t && input) setName(t, input.value)
    const had = input && document.activeElement === input
    render()
    if (had) focusTab(id)
  }
  function setName(t, value) {
    const name = String(value).trim().slice(0, 80)
    const key = nameKey(t)
    if (!key) return
    const next = { ...names }
    // A name saved before the app was known gives way to one under the app.
    const stale = t.url !== key && t.url in next
    if (stale) delete next[t.url]
    // The folder's own name is no name of the person's: the tab follows the folder again.
    if (!name || name === t.name) delete next[key]
    else next[key] = name
    if (!takeNames(next)) return
    post({ t: "names", names })
    const put = (app, name) => fetch("/api/names", { method: "PUT", body: JSON.stringify({ app, name }), keepalive: true }).then((r) => r.json())
    if (stale) put(t.url, "").catch(() => {})
    put(key, next[key] || "").then((r) => { if (r && r.names && takeNames(r.names)) render() }).catch(() => {})
  }

  const tipEl = $("tip")
  let tipFor = null, tipQuiet = null
  // The app the editor shows, as the browser opens it: two editors on one
  // project share a name and differ only here. Apps run on localhost
  // (runtime/launcher.mjs, BROWSER_HOST), whatever host the registry says.
  const hostOf = (url) => { try { const u = new URL(url); return "localhost" + (u.port ? ":" + u.port : "") } catch { return null } }
  const appAddress = (e) => (e && e.appUrl ? hostOf(e.appUrl) : null)
  function tipData(el, id, name, address) {
    el.dataset.tipId = id
    el.dataset.tipName = name
    el.dataset.tipDetail = address || ""
  }
  // The tip names the tab only when its name is cut short; a name shown in
  // full is not said twice. The address of what the tab shows is always there.
  function showTip(el) {
    const label = el.querySelector(".label")
    const cut = Boolean(label) && label.scrollWidth > label.clientWidth
    if (closing || (!cut && !el.dataset.tipDetail)) { hideTip(); return }
    tipFor = el.dataset.tipId
    tipEl.firstChild.textContent = el.dataset.tipName
    tipEl.firstChild.hidden = !cut
    tipEl.lastChild.textContent = el.dataset.tipDetail
    tipEl.lastChild.hidden = !el.dataset.tipDetail
    // Under the tab's body, which starts --ext into its box.
    const r = el.getBoundingClientRect(), inset = el.matches(".tab") ? 8 : 0
    const x = Math.max(8, Math.min(r.left + inset, innerWidth - tipEl.offsetWidth - 8))
    tipEl.style.transform = "translate(" + Math.round(x) + "px, " + Math.round(r.bottom + 6) + "px)"
    tipEl.classList.add("open")
  }
  function hideTip() { tipFor = null; tipEl.classList.remove("open") }
  tabsEl.addEventListener("pointerover", (ev) => {
    const el = ev.target.closest(".tab")
    if (el && el.dataset.tipId !== tipFor && el.dataset.tipId !== tipQuiet) showTip(el)
  })
  tabsEl.addEventListener("pointerout", (ev) => {
    const to = ev.relatedTarget && ev.relatedTarget.closest ? ev.relatedTarget.closest(".tab") : null
    if (to && to.dataset.tipId === ev.target.closest(".tab")?.dataset.tipId) return
    tipQuiet = null
    if (!to) hideTip()
  })
  // A press closes the tip, as a native one closes, until the pointer leaves the tab.
  tabsEl.addEventListener("pointerdown", (ev) => {
    tipQuiet = ev.target.closest(".tab")?.dataset.tipId ?? null
    hideTip()
  })
  // A name cut short must be readable from the keyboard too.
  tabsEl.addEventListener("focusin", (ev) => {
    const el = ev.target.closest(".tab")
    let keyboard = false
    try { keyboard = el.matches(":focus-visible") } catch {}
    if (el && keyboard) showTip(el)
  })
  tabsEl.addEventListener("focusout", (ev) => {
    if (!tabsEl.contains(ev.relatedTarget) && !tabsEl.querySelector(".tab:hover")) hideTip()
  })
  // Closed when the app goes to the background, not when an editor frame takes
  // focus: that blurs this page too, and editors focus themselves as they load.
  addEventListener("blur", () => { if (document.activeElement?.tagName !== "IFRAME") hideTip() })

  function syncFrames() {
    const live = new Set(tabs.map((t) => t.id))
    for (const f of framesEl.querySelectorAll("iframe")) if (!live.has(f.dataset.id)) f.remove()
    for (const t of tabs) {
      let f = framesEl.querySelector('iframe[data-id="' + t.id + '"]')
      // A stale tab is made empty, for the same reason applyEditors empties one.
      // Nothing loads before the window knows which window it is: a second
      // window opening on "/" would otherwise load the main window's editors
      // and take their sockets.
      const url = !identified || (t.kind === "editor" && !listed) ? null : t.stale ? "about:blank" : tabUrl(t)
      if (!f && url) {
        f = document.createElement("iframe")
        f.dataset.id = t.id
        // The editor inside reads its window.name to know it is in the app, and
        // leaves "Open in Mac app" out of its toolbar (src/shell/desk.ts).
        f.name = "designlayer-desk:" + t.id
        f.allow = "clipboard-read; clipboard-write; fullscreen"
        f.title = t.kind === "home" ? "DesignLayer start screen" : labelOf(t) || "Editor"
        f.src = url
        framesEl.append(f)
      }
      if (f) f.hidden = t.id !== active
    }
    const cur = tabs.find((t) => t.id === active)
    const waiting = !cur || !identified || (cur.kind === "home" && !homeUrl) || (cur.kind === "editor" && !listed) || deskDown
    $("boot").hidden = !waiting
    document.title = cur && cur.kind === "editor" ? (labelOf(cur) || "Editor") + " — DesignLayer" : "DesignLayer"
  }

  function select(id) {
    active = id
    const t = tabs.find((x) => x.id === id)
    if (t?.stale) {
      t.stale = false
      const f = framesEl.querySelector('iframe[data-id="' + t.id + '"]')
      if (f) f.src = tabUrl(t)
    }
    render()
  }
  function newHome() { const t = { id: uid(), kind: "home" }; tabs.push(t); select(t.id) }

  // ---- Tab widths ----
  //
  // Each tab is as wide as its whole name needs, so a name shows in full
  // while the strip has room for it. Short of room, the shortcuts go first,
  // then the widest tabs give way, down to equal widths and on to the 72px
  // minimum, as Chrome's tabs shrink (tab_strip_layout.cc). A page with no
  // layout to measure (a test) keeps the stylesheet's equal widths.
  const measureEl = $("measure")
  const px = (value, fallback) => (Number.isFinite(parseFloat(value)) ? parseFloat(value) : fallback)
  const overlapPx = () => px(getComputedStyle(tabsEl).getPropertyValue("--overlap"), 10)
  function textWidth(text, cls) {
    measureEl.className = cls
    measureEl.textContent = text
    return measureEl.getBoundingClientRect().width
  }
  // The strip's width less everything else in it, the spacer at its least.
  function roomForTabs() {
    const strip = $("strip"), cs = getComputedStyle(strip)
    let room = strip.getBoundingClientRect().width - px(cs.paddingLeft, 0) - px(cs.paddingRight, 6), shown = 0
    for (const c of strip.children) {
      if (c !== tabsEl && (c.hidden || getComputedStyle(c).display === "none")) continue
      shown += 1
      if (c === tabsEl) continue
      const ccs = getComputedStyle(c)
      room -= c.classList.contains("spacer") ? px(ccs.minWidth, 24) : c.getBoundingClientRect().width + px(ccs.marginLeft, 0) + px(ccs.marginRight, 0)
    }
    return room - px(cs.columnGap, 2) * (shown - 1)
  }
  // Widths no wider than each tab needs, capped so the row fits the room: the
  // cap falls until it does, so only the widest tabs are cut.
  function fitWidths(wants, room, least, overlap) {
    const budget = room + overlap * (wants.length - 1)
    const sum = (cap) => wants.reduce((total, want) => total + Math.max(least, Math.min(want, cap)), 0)
    if (sum(Infinity) <= budget) return wants.map((want) => Math.max(least, want))
    let lo = least, hi = Math.max(...wants)
    for (let k = 0; k < 30; k += 1) { const mid = (lo + hi) / 2; if (sum(mid) <= budget) lo = mid; else hi = mid }
    return wants.map((want) => Math.max(least, Math.min(want, Math.floor(lo * 100) / 100)))
  }
  function setWidths(els, widths, overlap) {
    els.forEach((el, i) => { el.style.flex = "none"; el.style.width = widths[i] + "px" })
    tabsEl.style.width = widths.reduce((total, w) => total + w, 0) - overlap * (widths.length - 1) + "px"
  }
  function layoutTabs() {
    const els = [...tabsEl.children]
    if (closing && (tabs.length > closing.count || tabs.length < 2)) closing = null
    if (closing) {
      return setWidths(els, els.map((el) => closing.widths.get(el.dataset.id) ?? el.getBoundingClientRect().width), overlapPx())
    }
    for (const el of els) { el.style.flex = ""; el.style.width = "" }
    tabsEl.style.width = ""
    if (!els.length) return
    const names = els.map((el) => textWidth(el.querySelector(".label")?.textContent || "", "measure-label"))
    if (!names.some((w) => w > 0)) return
    const cs = getComputedStyle(els[0])
    const gap = px(cs.columnGap, 6), sides = px(cs.paddingLeft, 17) + px(cs.paddingRight, 14), least = px(cs.minWidth, 72)
    const overlap = overlapPx()
    // The glyph, the name (a pixel spare, so rounding never cuts it), and the close button.
    const wants = els.map((el, i) => sides + 16 + gap + Math.ceil(names[i]) + 1 + (el.querySelector(".close") ? gap + 16 : 0))
    const room = roomForTabs()
    let widths = wants.map((w) => Math.max(least, w))
    if (widths.reduce((t, w) => t + w, 0) - overlap * (widths.length - 1) > room) widths = fitWidths(wants, room, least, overlap)
    setWidths(els, widths, overlap)
  }
  addEventListener("resize", () => { if (!closing && !press && !drag) render() })

  // Closing tabs with the mouse, as Chrome does (TabContainerImpl,
  // EnterTabClosingMode and UpdateClosingModeOnRemovedTab). While the pointer
  // stays on the strip after a click on a close button, the tabs keep the
  // widths they had. A tab closed before the last hands its width to the tab
  // after it, which slides into its place, so that tab's close button is
  // where the one just clicked was. The last tab shares its width out among
  // the rest, so the new last tab's close button lands under the pointer.
  // Either way the next click closes the next tab. The tabs take their own
  // widths again once the pointer leaves the strip or a tab opens.
  let closing = null
  function closeByMouse(id) {
    const i = tabs.findIndex((t) => t.id === id)
    if (i < 0) return
    if (tabs.length > 1) {
      const els = [...tabsEl.querySelectorAll(".tab[data-id]")]
      const widths = closing ? closing.widths : new Map(els.map((el) => [el.dataset.id, el.getBoundingClientRect().width]))
      const width = widths.get(id) ?? 0
      widths.delete(id)
      if (i < tabs.length - 1) widths.set(tabs[i + 1].id, width)
      else {
        const share = (width - overlapPx()) / (tabs.length - 1)
        for (const [key, w] of widths) widths.set(key, w + share)
      }
      closing = { widths, count: tabs.length - 1 }
    }
    close(id)
  }
  function endClosing() {
    clearTimeout(endClosing.t)
    if (!closing) return
    closing = null
    render()
  }
  // The strip region is the tabs and the new-tab button beside them. A
  // pointer that slips off it for a moment, below into a frame or across the
  // 2px between them, comes back before the tabs move.
  for (const el of [tabsEl, $("newTab")]) {
    el.addEventListener("pointerleave", () => { if (closing) { clearTimeout(endClosing.t); endClosing.t = setTimeout(endClosing, 300) } })
    el.addEventListener("pointerenter", () => clearTimeout(endClosing.t))
  }
  addEventListener("blur", () => endClosing())
  addEventListener("resize", () => endClosing())
  function close(id) {
    const i = tabs.findIndex((t) => t.id === id); if (i < 0) return
    tabs.splice(i, 1)
    if (!tabs.length) tabs.push({ id: uid(), kind: "home" })
    if (active === id) active = (tabs[i] || tabs[i - 1] || tabs[0]).id
    render()
  }

  // "Open in Mac app", pressed in an editor in a browser tab. The desk forwards
  // the page here, and it opens in the tab already showing that editor, or in
  // a new one.
  function openUrl(href) {
    href = onLocalhost(href)
    const origin = originOf(href)
    if (!origin) return
    const e = editors.find((x) => originOf(x.url) === origin)
    let t = tabs.find((x) => x.kind === "editor" && originOf(x.url) === origin)
    const frame = t && framesEl.querySelector('iframe[data-id="' + t.id + '"]')
    if (!t) {
      t = { id: uid(), kind: "editor", url: e ? e.url : origin, name: e ? e.name : new URL(href).host,
        key: e ? editorKey(e) : null, projectRoot: e ? e.projectRoot : null }
      tabs.push(t)
    }
    // Loaded now, so not again when the tab is next selected.
    t.src = href; t.stale = false
    active = t.id
    render()
    // Loaded again even when this frame already shows the editor: the browser
    // tab took the editor's one socket from it, and only a fresh load takes it back.
    if (frame) frame.src = href
    toast("Opened " + labelOf(t) + " from the browser")
    window.focus()
  }

  // The desk sends a page to every window; one opens it. The window that
  // shows its editor, or else the window used last.
  function opensHere(href) {
    if (!channel) return true
    prunePeers()
    const origin = localOrigin(href)
    if (tabs.some((t) => t.kind === "editor" && t.url === origin)) return true
    if (origin && editorPeer(origin)) return false
    return ![...peers].some(([id, p]) => p.focusedAt > focusedAt || (p.focusedAt === focusedAt && id < wid))
  }

  async function poll() {
    await identifying
    try {
      const [h, list] = await Promise.all([
        fetch("/api/health", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/editors", { cache: "no-store" }).then((r) => r.json()),
      ])
      // An update restarted the desk on new files: this page is the old one.
      if (VERSION && h.version && h.version !== VERSION) { location.reload(); return }
      deskDown = false; health = h; editors = (list.editors || []).map((e) => ({ ...e, url: onLocalhost(e.url) }))
      // The desk's names win over this origin's copy; asked until it answers.
      if (!namesLoaded) {
        const r = await fetch("/api/names", { cache: "no-store" }).then((x) => x.json()).catch(() => null)
        if (r && r.names && typeof r.names === "object") { takeNames(r.names); namesLoaded = true }
      }
      if (restoring) await restore()
    } catch {
      deskDown = true
      // No desk to compare with: a page that has its own tabs keeps saving them.
      if (restoring && Array.isArray(saved?.tabs) && saved.tabs.length) restoring = false
    }
    applyHealth()
    applyEditors()
    // A desk that refused the connection is one that does not answer: the
    // tabs load their saved pages now, and the first list to arrive moves them.
    listed = true
    render()
  }

  function applyUpdate() {
    const u = deskDown ? null : health?.startScreen?.update
    const label = { available: "Update available", updating: "Updating…", updated: "Restarting…" }[u?.state]
    $("update").hidden = !label
    if (label) $("update").textContent = label
  }
  // Home is where the update is described and started.
  $("update").onclick = () => {
    const home = tabs.find((t) => t.kind === "home")
    if (home) select(home.id); else newHome()
  }

  function applyHealth() {
    applyUpdate()
    // What the desk and the start screen are doing shows on the boot sheet,
    // over the tab that waits for them; the title bar carries no status.
    const ss = health?.startScreen
    if (deskDown) {
      $("bootSpin").hidden = true; $("bootTitle").textContent = "Can’t connect"
      $("bootText").hidden = false; $("bootCmd").hidden = false
      return
    }
    $("bootText").hidden = true; $("bootCmd").hidden = true; $("bootSpin").hidden = false
    if (ss?.ready && ss.url) {
      // On localhost like this page, whatever address the desk reaches it on.
      const url = onLocalhost(ss.url)
      if (homeUrl !== url) {
        // The start screen came up on a different port (or for the first time): repoint Home tabs.
        const was = homeUrl; homeUrl = url
        if (was) for (const f of framesEl.querySelectorAll("iframe")) {
          const t = tabs.find((x) => x.id === f.dataset.id); if (t?.kind === "home") f.src = homeUrl
        }
      }
    } else {
      // The restart reason and log path stay in the desk log; the window only says what is happening.
      $("bootTitle").textContent = ss?.state === "backoff" ? "Restarting…" : "Starting…"
    }
  }

  // The tab whose frame posted a message, or nothing for a message from any
  // other window.
  const tabOfSource = (source) => {
    const f = [...framesEl.querySelectorAll("iframe")].find((x) => x.contentWindow === source)
    return f ? tabs.find((x) => x.id === f.dataset.id) : undefined
  }
  // A URL's origin, spelled on localhost, when it is a page on this Mac.
  const localOrigin = (u) => {
    try {
      const x = new URL(u)
      if (x.protocol !== "http:" && x.protocol !== "https:") return null
      if (x.hostname !== "localhost" && x.hostname !== "127.0.0.1") return null
      return onLocalhost(x.origin)
    } catch { return null }
  }

  // Each editor frame says which app it shows and on which page
  // (src/shell/desk.ts, DESK_SHOWING_MESSAGE): on load and on every page
  // change. That is what names the tab, whatever kind it was: a Home tab that
  // pressed Start, or a tab sent to another editor by "designlayer-desk:go".
  // It replaces a guess from the start screen's status that skipped any tab
  // without focus and any editor that already had a tab.
  addEventListener("message", (ev) => {
    const data = ev.data
    if (!data || data.type !== "designlayer-desk:showing") return
    const t = tabOfSource(ev.source)
    const origin = t && localOrigin(ev.origin)
    if (!origin) return
    const page = typeof data.page === "string" && data.page.startsWith("/") && !data.page.startsWith("//") ? data.page : "/"
    const e = editors.find((x) => x.url === origin)
    const name = (typeof data.name === "string" && data.name.trim()) || e?.name || t.name || "Editor"
    // A tab now on another editor keeps nothing of the one it left: with that
    // editor's key, the next list would take it for a restart and empty it.
    const same = t.kind === "editor" && t.url === origin
    Object.assign(t, { kind: "editor", url: origin, src: origin + page, name: name.slice(0, 80), stale: false,
      key: e ? editorKey(e) : same ? t.key : null, projectRoot: e?.projectRoot ?? (same ? t.projectRoot : null) })
    // One editor, one tab. Its socket takes one client, so a second tab on the
    // same editor could only ever show it disconnected.
    for (const other of tabs.filter((x) => x !== t && x.kind === "editor" && x.url === origin)) {
      tabs.splice(tabs.indexOf(other), 1)
      if (active === other.id) active = t.id
    }
    // Other windows drop their tab on it too.
    post({ t: "claimed", url: origin })
    render()
  })

  // "Show this editor", from a frame that chose an app: the start screen in a
  // Home tab, or the app chooser inside an editor. Every app has its own
  // editor on its own port, so the answer is a tab: the one already showing
  // that editor, untouched, when there is one. The frame never navigates
  // itself here; doing so left the editor it showed without a tab.
  addEventListener("message", (ev) => {
    const data = ev.data
    if (!data || data.type !== "designlayer-desk:go" || typeof data.url !== "string") return
    const t = tabOfSource(ev.source)
    const sender = t && localOrigin(ev.origin)
    const origin = sender && localOrigin(data.url)
    if (!origin) return
    const startScreen = homeUrl && localOrigin(homeUrl)
    // Never the desk itself or the start screen: neither is an editor.
    if (origin === onLocalhost(location.origin) || origin === startScreen) return
    // The start screen speaks only from a Home tab: anywhere else it is a
    // frame that left the start screen's page, not a Home tab choosing an app.
    const fromHome = t.kind === "home" && sender === startScreen
    if (sender === startScreen && !fromHome) return
    const url = onLocalhost(data.url)
    const e = editors.find((x) => x.url === origin)
    const shown = tabs.find((x) => x.kind === "editor" && x.url === origin)
    // Another window shows that editor: that window selects its tab, as the
    // tab here would have been. This tab stays as it is.
    const elsewhere = !shown && editorPeer(origin)
    if (elsewhere) {
      post({ t: "reveal", to: elsewhere, url })
      toast((e ? labelOf({ kind: "editor", ...e }) : new URL(url).host) + " is open in another window")
      return
    }
    if (shown) {
      // The Home tab did its job; a second one left behind is clutter.
      if (fromHome) tabs.splice(tabs.indexOf(t), 1)
      // A tab whose editor stopped still shows the refused connection, and a go
      // can arrive before the next editor list says the port is back. A tab not
      // on the running editor's key loads the page it was sent, once, here.
      const live = e && shown.key === editorKey(e)
      if (!live) {
        Object.assign(shown, { src: url, stale: false, key: e ? editorKey(e) : null })
        const f = framesEl.querySelector('iframe[data-id="' + shown.id + '"]')
        if (f) f.src = url
      }
      select(shown.id)
      return
    }
    // The key is the next list's to fill in: the list may still hold an editor
    // that was just replaced on this port.
    const target = { kind: "editor", url: origin, src: url, stale: false, key: null,
      name: e ? e.name : new URL(url).host, projectRoot: e ? e.projectRoot : null }
    if (fromHome) {
      Object.assign(t, target)
      const f = framesEl.querySelector('iframe[data-id="' + t.id + '"]')
      if (f) f.src = url
      active = t.id
    } else {
      // From an editor, never in its own tab: its unapplied edits would go, and
      // its editor would be left with no tab. A new tab beside it.
      const n = { id: uid(), ...target }
      tabs.splice(tabs.indexOf(t) + 1, 0, n)
      active = n.id
    }
    render()
  })

  let firstList = true
  // The editors the last list named, to see a stopped editor come back.
  let listedBefore = null
  function applyEditors() {
    const was = listedBefore
    // An editor with no tab here is never opened unasked: the vendor socket
    // keeps one client, so a tab here would disconnect whichever browser tab
    // (or agent) is using that editor now. Home lists every running editor.
    for (const t of tabs) {
      const e = t.kind === "editor" && editors.find((x) => x.url === t.url)
      if (!e) continue
      const key = editorKey(e)
      // A new editor on this tab's port is the app restarted, or another app
      // given the port after this one's editor stopped. A tab in the background
      // still shows the page it loaded before: a refused connection, or the
      // app that left. It is emptied now and loads the new editor's page when
      // it is opened. Loading it while hidden would take the editor's one
      // socket from whoever uses it now. The active tab is left for the person
      // in it to reload, for the same reason.
      if (t.key && t.key !== key && t.id !== active) {
        t.src = e.page ? onLocalhost(originOf(e.url) + e.page) : undefined
        t.stale = true
        const f = framesEl.querySelector('iframe[data-id="' + t.id + '"]')
        if (f) f.src = "about:blank"
      } else if (t.key && t.key !== key && was && !was.has(t.url)) {
        // The active tab's editor had stopped, so the tab shows a refused
        // connection and nobody is using it there; its editor is back, so the
        // tab loads it now rather than waiting for a reload by hand.
        if (e.page) t.src = onLocalhost(originOf(e.url) + e.page)
        const f = framesEl.querySelector('iframe[data-id="' + t.id + '"]')
        if (f) f.src = tabUrl(t)
      }
      // When the window opens, an editor tab goes to the page its app was last
      // used on, from the server, over the page saved with the tab. The saved
      // page can be the bare root, which opens the home page every copy of a
      // template shares; or a page of the app the editor ran before, saved by
      // a window that quit before its storage was written.
      const wanted = e.page ? onLocalhost(originOf(t.url) + e.page) : null
      if (firstList && wanted && wanted !== t.src && !t.stale) {
        t.src = wanted
        const f = framesEl.querySelector('iframe[data-id="' + t.id + '"]')
        if (f) f.src = tabUrl(t)
      }
      t.name = e.name; t.projectRoot = e.projectRoot; t.key = key
      // Kept with the tab, so a tab whose editor stopped keeps its name.
      t.app = appOf(e) ?? t.app
    }
    // Only a list that arrived counts as the first: a desk still coming up
    // answers nothing, and the saved tabs would then keep their saved pages.
    if (!deskDown) {
      firstList = false
      listedBefore = new Set(editors.map((x) => x.url))
    }
  }

  // ⌘1–9, ⌘T, ⌘W reach this page when focus is on the strip or the page itself.
  // A cross-origin frame keeps its own keystrokes, and Chrome may reserve ⌘T/⌘W.
  addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented || !(ev.metaKey || ev.ctrlKey) || ev.altKey) return
    if (/^[1-9]$/.test(ev.key)) {
      const t = ev.key === "9" ? tabs[tabs.length - 1] : tabs[Number(ev.key) - 1]
      if (t) { ev.preventDefault(); select(t.id) }
    } else if (ev.key === "t" || ev.key === "T") { ev.preventDefault(); newHome() }
    else if (ev.key === "w" || ev.key === "W") { ev.preventDefault(); close(active) }
    else relayToEditor(ev)
  })
  // Any other accelerator belongs to the editor in the active tab, ⌘. above
  // all: it is how a hidden editor comes back. Typed here, on the strip after a
  // click on a tab or after the frame reloaded and left focus in this page, it
  // reached no frame, and ⌘. did nothing until the page was clicked. So it is
  // posted to the frame; the editor answers the keys it takes from anywhere
  // (src/shell/way-back.ts) and ignores the rest.
  function relayToEditor(ev) {
    const t = tabs.find((x) => x.id === active)
    const f = t && t.kind === "editor" && framesEl.querySelector('iframe[data-id="' + t.id + '"]')
    const origin = f && originOf(f.src)
    if (!origin) return
    f.contentWindow.postMessage({ type: "designlayer-desk:key", key: ev.key, code: ev.code,
      metaKey: ev.metaKey, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, altKey: ev.altKey }, origin)
  }
  $("newTab").onclick = newHome
  // The frame is replaced, not given its src again. Apps route by hash
  // (http://localhost:3462/#/page), and a src that differs from the frame's
  // page only after the # is a same-document navigation: the button did
  // nothing. A new iframe always loads the page in full. The page is the one
  // the editor last reported (DESK_SHOWING_MESSAGE), so the reload stays on it.
  $("reload").onclick = () => {
    const t = tabs.find((x) => x.id === active)
    const f = framesEl.querySelector('iframe[data-id="' + active + '"]')
    if (!t || !f) return
    t.stale = false
    f.remove()
    syncFrames()
  }
  $("pickFolder").onclick = async () => {
    try {
      const r = await fetch("/api/pick-folder", { method: "POST" }).then((x) => x.json())
      if (r.cancelled) return
      if (!r.path) throw new Error(r.error || "No folder")
      try { await navigator.clipboard.writeText(r.path); toast("Copied " + r.path + " — paste it into the folder field") }
      catch { toast(r.path, 8000) }
    } catch (e) { toast("Could not open the folder picker: " + e.message) }
  }
  // The tabs are in the title bar whenever Chrome draws the overlay. The app's
  // Chrome runs with it on and no toggle to turn it off (APP_FEATURES in
  // chrome-pipe.mjs); a normal browser tab never has it.
  if ("windowControlsOverlay" in navigator) {
    const wco = () => document.body.classList.toggle("wco", navigator.windowControlsOverlay.visible)
    navigator.windowControlsOverlay.addEventListener("geometrychange", wco); wco()
  }
  // Dims the buttons with Chrome's while the window is in the background. Focus
  // inside an editor frame never blurs this window again, so this also polls.
  // The window used last is the one a page from "Open in Mac app" opens in.
  const syncActive = () => {
    const has = document.hasFocus()
    document.body.classList.toggle("inactive", !has)
    if (has && !syncActive.had) { focusedAt = Date.now(); announce() }
    syncActive.had = has
  }
  addEventListener("focus", syncActive)
  addEventListener("blur", () => setTimeout(syncActive))
  setInterval(syncActive, 250)
  syncActive()
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {})

  // ---- Windows talking to each other ----

  if (channel) {
    channel.onmessage = (ev) => {
      const m = ev.data
      if (!m || typeof m !== "object" || m.from === (identified ? wid : probeId)) return
      if (m.to && m.to !== wid) return
      if (m.t === "hello") {
        if (identified) announce()
        else if (m.want === wid && String(m.from) < probeId) yielded = true
        return
      }
      if (m.t === "state") {
        peers.set(m.from, { tabs: Array.isArray(m.tabs) ? m.tabs : [], title: String(m.title || ""), focusedAt: m.focusedAt || 0, geo: m.geo, seen: Date.now() })
        return
      }
      if (!identified || gone) return
      if (m.t === "bye") {
        // A window closed while this one stays up: closed on its own, so it
        // does not come back with the app. A reload says hello again within
        // the wait, and when the app quits every window goes at once, so
        // nobody is left to forget anybody.
        const w = m.from
        peers.delete(w)
        setTimeout(() => { if (!gone && !leaving && !peers.has(w)) forget(w) }, 2000)
      } else if (m.t === "claimed" && typeof m.url === "string") dropTabsOn(m.url)
      else if (m.t === "names") { if (takeNames(m.names)) render() }
      else if (m.t === "reveal" && typeof m.url === "string") reveal(m.url)
      else if (m.t === "hover") hovered(m)
      else if (m.t === "adopt") adoptTab(m)
      else if (m.t === "adopted") movesWaiting.get(m.req)?.()
    }
    setInterval(() => { prunePeers(); announce() }, 1000)
  }

  // Another window's frame took this editor's socket: the tab here would only
  // show it disconnected.
  function dropTabsOn(url) {
    const doomed = tabs.filter((x) => x.kind === "editor" && x.url === url)
    if (!doomed.length) return
    for (const x of doomed) tabs.splice(tabs.indexOf(x), 1)
    if (!tabs.length) tabs.push({ id: uid(), kind: "home" })
    if (!tabs.some((x) => x.id === active)) active = tabs[0].id
    render()
  }

  // Another window was asked for an editor this window shows.
  function reveal(href) {
    const origin = localOrigin(href)
    const t = origin && tabs.find((x) => x.kind === "editor" && x.url === origin)
    if (!t) return
    const e = editors.find((x) => x.url === origin)
    if (!(e && t.key === editorKey(e))) {
      Object.assign(t, { src: onLocalhost(href), stale: false, key: e ? editorKey(e) : null })
      const f = framesEl.querySelector('iframe[data-id="' + t.id + '"]')
      if (f) f.src = t.src
    }
    select(t.id)
    window.focus()
  }

  // The fields a tab carries to another window. Its frame cannot go with it:
  // a frame moved to another document loads again, so the other window loads
  // the page the editor last reported.
  const carry = (t) => ({ id: t.id, kind: t.kind, url: t.url, src: t.src, name: t.name, key: t.key, projectRoot: t.projectRoot, app: t.app })
  function cleanTab(x) {
    if (!x || typeof x !== "object" || typeof x.id !== "string" || (x.kind !== "home" && x.kind !== "editor")) return null
    const str = (v) => (typeof v === "string" ? v : undefined)
    const t = { id: x.id, kind: x.kind }
    if (x.kind === "editor") {
      const origin = localOrigin(x.url)
      if (!origin) return null
      const src = str(x.src) && localOrigin(x.src) === origin ? onLocalhost(x.src) : undefined
      Object.assign(t, { url: origin, src, name: str(x.name)?.slice(0, 80), key: str(x.key) ?? null, projectRoot: str(x.projectRoot) ?? null, app: str(x.app) ?? null })
    }
    return t
  }

  // The tab position under a point on this window's strip.
  // Measured as if the slot for an incoming tab were not there, so the slot
  // does not push the tabs after it past the pointer and back.
  function indexAt(x) {
    const slot = tabsEl.querySelector(".tab.incoming")
    const shift = slot ? slot.getBoundingClientRect().width + 2 : 0
    let after = false, n = 0
    for (const el of tabsEl.children) {
      if (el === slot) { after = true; continue }
      if (!el.dataset.id) continue
      const r = el.getBoundingClientRect()
      if (r.left - (after ? shift : 0) + r.width / 2 < x) n += 1
    }
    return n
  }

  // A tab from another window, dragged over this window's strip: a slot shows
  // where it will land. The drag says where it is every move; a slot nobody
  // updates for a second and a half belonged to a drag that went away.
  let incoming = null
  function incomingTab() {
    const b = document.createElement("div")
    b.className = "tab incoming"
    b.innerHTML = '<span class="glyph">' + (incoming.kind === "home" ? HOME_GLYPH : EDIT_GLYPH) + '</span><span class="label"></span>'
    b.querySelector(".label").textContent = incoming.name
    return b
  }
  function hovered(m) {
    clearTimeout(hovered.t)
    const next = typeof m.x === "number" ? { index: indexAt(m.x), name: String(m.name || "Tab").slice(0, 80), kind: m.kind } : null
    if (next) hovered.t = setTimeout(() => hovered({}), 1500)
    if (JSON.stringify(next) === JSON.stringify(incoming)) return
    incoming = next
    render()
  }

  // A tab dropped on this window's strip from another window.
  function adoptTab(m) {
    const t = cleanTab(m.tab)
    if (!t) return
    clearTimeout(hovered.t)
    const index = typeof m.x === "number" ? indexAt(m.x) : tabs.length
    incoming = null
    // One editor, one tab.
    if (t.kind === "editor") for (const x of tabs.filter((x) => x.kind === "editor" && x.url === t.url)) tabs.splice(tabs.indexOf(x), 1)
    if (tabs.some((x) => x.id === t.id)) t.id = uid()
    tabs.splice(Math.min(index, tabs.length), 0, t)
    active = t.id
    post({ t: "adopted", to: m.from, req: m.req })
    render()
    window.focus()
  }

  // ---- Moving tabs ----

  const movesWaiting = new Map()
  // Gives a tab to another window, which answers once the tab is in it. A
  // window that does not answer (it closed meanwhile) leaves the tab here.
  function moveToWindow(id, to, x) {
    const t = tabs.find((x) => x.id === id)
    if (!t) return Promise.resolve(false)
    return new Promise((resolve) => {
      const req = uid()
      const timer = setTimeout(() => { movesWaiting.delete(req); toast("That window did not answer"); render(); resolve(false) }, 1500)
      movesWaiting.set(req, () => { clearTimeout(timer); movesWaiting.delete(req); takeOut(id); resolve(true) })
      post({ t: "adopt", to, req, x, tab: carry(t) })
    })
  }

  // A tab that left for another window. A window left with no tabs closes.
  function takeOut(id) {
    const i = tabs.findIndex((x) => x.id === id)
    if (i < 0) return
    tabs.splice(i, 1)
    framesEl.querySelector('iframe[data-id="' + id + '"]')?.remove()
    if (!tabs.length) return closeWindow()
    if (active === id) active = (tabs[i] || tabs[i - 1]).id
    render()
  }
  function closeWindow() {
    gone = true
    post({ t: "bye" })
    for (const f of framesEl.querySelectorAll("iframe")) f.remove()
    // The desk hears first: a request sent as the window closes is dropped.
    Promise.race([forget(wid), new Promise((r) => setTimeout(r, 1000))]).then(() => {
      window.close()
      // A page Chrome will not let a script close (one opened by hand in a
      // browser tab) carries on with a Home tab. Chrome can take more than
      // half a second to close an app window, and a page that took that for a
      // refusal saved itself again and came back on the next launch, so this
      // waits, and never runs once the page is going away.
      setTimeout(() => {
        if (window.closed || leaving) return
        gone = false; mirrored = null
        tabs = [{ id: uid(), kind: "home" }]; active = tabs[0].id
        render()
      }, 2000)
    })
  }

  // Pulls a tab out into a window of its own, at a point on screen or beside
  // this window. The new window reads its tabs from this origin's storage,
  // written here first. Chrome lets a page open a window only for a few
  // seconds after a press; past that (a long drag) the desk opens it.
  async function tearOut(id, at) {
    const t = tabs.find((x) => x.id === id)
    if (!t || tabs.length < 2) return
    const w = "w" + uid()
    const state = { tabs: [carry(t)], active: t.id, savedAt: Date.now() }
    localStorage.setItem(keyOf(w), JSON.stringify(state))
    fetch("/api/tabs", { method: "PUT", body: JSON.stringify({ ...state, window: w }), keepalive: true }).catch(() => {})
    const left = Math.round(at ? at.left : screenX + 40), top = Math.round(at ? at.top : screenY + 40)
    // The size of this window, as in Chrome; but a window that fills the
    // screen would open a copy of itself right on top of it (macOS keeps it on
    // screen), hiding the strip its tab could go back to. That one opens at
    // four fifths of the screen.
    const fills = screen.availWidth > 0 && outerWidth >= screen.availWidth - 16 && outerHeight >= screen.availHeight - 16
    const width = fills ? Math.round(screen.availWidth * 0.8) : outerWidth
    const height = fills ? Math.round(screen.availHeight * 0.8) : outerHeight
    let opened = null
    try { opened = window.open("/?window=" + w, "_blank", "popup,left=" + left + ",top=" + top + ",width=" + width + ",height=" + height) } catch {}
    if (!opened) {
      const r = await fetch("/api/windows/open", { method: "POST", body: JSON.stringify({ window: w }) }).then((x) => x.json()).catch(() => null)
      if (!r || r.ok !== true) { forget(w); toast("Could not open a new window"); return }
    }
    takeOut(id)
  }

  function moveTab(id, by) {
    const i = tabs.findIndex((x) => x.id === id), j = i + by
    if (i < 0 || j < 0 || j >= tabs.length) return
    const [t] = tabs.splice(i, 1)
    tabs.splice(j, 0, t)
    render()
    focusTab(id)
  }

  // ---- Dragging a tab ----
  //
  // Along the strip the tab reorders. Pulled out of the strip, it leaves the
  // row: let go over another window's strip and it moves there; let go
  // anywhere else and it opens in a new window there. The pointer is
  // captured, so the page keeps getting its moves outside the window, in
  // screen coordinates, and finds another window's strip from where each
  // window says its strip is.
  let press = null, drag = null
  const PULL = 28
  tabsEl.addEventListener("pointerdown", (ev) => {
    const el = ev.target.closest(".tab[data-id]")
    if (!el || ev.button !== 0 || ev.ctrlKey || ev.target.closest(".close, .rename") || drag) return
    closeMenu()
    press = { el, id: el.dataset.id, x: ev.clientX, y: ev.clientY, sx: ev.screenX, sy: ev.screenY, pointerId: ev.pointerId }
    try { el.setPointerCapture(ev.pointerId) } catch {}
  })
  tabsEl.addEventListener("pointermove", (ev) => {
    if (!press || ev.pointerId !== press.pointerId) return
    if (!drag && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < 5) return
    if (!drag) beginDrag()
    if (drag) moveDrag(ev)
  })
  tabsEl.addEventListener("pointerup", (ev) => { if (press && ev.pointerId === press.pointerId) endDrag(ev, false) })
  tabsEl.addEventListener("pointercancel", (ev) => { if (press && ev.pointerId === press.pointerId) endDrag(ev, true) })
  tabsEl.addEventListener("lostpointercapture", (ev) => { if (drag && ev.pointerId === press?.pointerId) endDrag(ev, true) })
  // A tab that was dragged is not also clicked.
  tabsEl.addEventListener("click", (ev) => { if (endDrag.just) { ev.stopPropagation(); endDrag.just = false } }, true)

  function beginDrag() {
    const t = tabs.find((x) => x.id === press.id)
    if (!t) { press = null; return }
    const els = [...tabsEl.querySelectorAll(".tab[data-id]")]
    const from = els.indexOf(press.el)
    const rects = els.map((el) => el.getBoundingClientRect())
    const step = els.length > 1 ? (from < els.length - 1 ? rects[from + 1].left - rects[from].left : rects[from].left - rects[from - 1].left) : rects[from].width
    drag = { t, els, rects, from, index: from, step, grabX: press.x - rects[from].left, lastX: press.x, out: false, target: null, ghost: null }
    hideTip()
    if (active !== t.id) {
      select(t.id)
      for (const el of els) { el.setAttribute("aria-selected", String(el === press.el)); el.tabIndex = el === press.el ? 0 : -1 }
    }
    tabsEl.classList.add("reordering")
    document.body.classList.add("dragging-tab")
    press.el.classList.add("lifted")
  }

  // The window whose strip is under a point on screen, and the point on it.
  // This window is in front while its tab is dragged, so a point inside it is
  // its own. Of the others, the one used last is taken to be in front.
  // A window dragged by its only tab moves under the pointer, so for that drag
  // this window does not count (self is false).
  function windowAt(sx, sy, cx, cy, self = true) {
    if (self && cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight) return null
    let best = null
    for (const [id, p] of peers) {
      const g = p.geo
      if (!g || !g.strip) continue
      const x = sx - g.x, y = sy - g.y
      if (x < g.strip.left || x > g.strip.right || y < g.strip.top - 8 || y > g.strip.bottom + 8) continue
      if (!best || p.focusedAt > best.focusedAt) best = { id, x, title: p.title, focusedAt: p.focusedAt, below: g.y + g.strip.bottom }
    }
    return best
  }

  // A window's only tab drags the whole window, as in Chrome, so the window
  // can be taken to another window's strip and its tab dropped in. Over that
  // strip the window hangs just below it, so the strip and the slot where the
  // tab will land stay in view. A window Chrome will not let a script move
  // (one the desk reopened) falls back to the copy that follows the pointer.
  function dragWindow(ev) {
    const d = drag
    if (!d.win) d.win = { dx: press.sx - screenX, dy: press.sy - screenY, x: screenX, y: screenY, tries: 0 }
    const target = windowAt(ev.screenX, ev.screenY, ev.clientX, ev.clientY, false)
    const name = labelOf(d.t)
    if (d.target && d.target.id !== target?.id) post({ t: "hover", to: d.target.id })
    if (target) post({ t: "hover", to: target.id, x: target.x, name, kind: d.t.kind })
    d.target = target
    d.win.next = [Math.round(ev.screenX - d.win.dx), Math.round(target ? target.below + 6 : ev.screenY - d.win.dy)]
    if (d.win.frame) return
    d.win.frame = requestAnimationFrame(() => {
      if (drag !== d) return
      d.win.frame = 0
      const [left, top] = d.win.next
      if (Math.abs(left - d.win.x) + Math.abs(top - d.win.y) > 4) d.win.tries += 1
      try { moveTo(left, top) } catch {}
      // Asked to move a few times and still where it started: not movable.
      if (d.win.tries >= 3 && screenX === d.win.x && screenY === d.win.y) d.canMove = false
    })
  }

  function moveDrag(ev) {
    const d = drag
    if (tabs.length < 2 && d.canMove !== false && peers.size) return dragWindow(ev)
    const strip = $("strip").getBoundingClientRect()
    let out = ev.clientY < strip.top - PULL || ev.clientY > strip.bottom + PULL || ev.clientX < -PULL || ev.clientX > innerWidth + PULL
    // A window's only tab has nowhere to go but another window's strip, which
    // can lie under this window (one the desk reopened on top of the first).
    const solo = tabs.length < 2
    const target = out || solo ? windowAt(ev.screenX, ev.screenY, ev.clientX, ev.clientY, !solo) : null
    if (solo) out = Boolean(target)
    const name = labelOf(d.t)
    if (d.target && d.target.id !== target?.id) post({ t: "hover", to: d.target.id })
    if (target) post({ t: "hover", to: target.id, x: target.x, name, kind: d.t.kind })
    d.target = target
    d.out = out
    press.el.classList.toggle("away", out)
    if (out) {
      if (!d.ghost) {
        d.ghost = document.createElement("div")
        d.ghost.className = "tab-ghost"
        const copy = press.el.cloneNode(true)
        copy.classList.remove("lifted", "away")
        copy.style.transform = ""
        copy.style.width = d.rects[d.from].width + "px"
        copy.removeAttribute("data-id")
        d.ghost.append(copy, Object.assign(document.createElement("div"), { className: "hint" }))
        document.body.append(d.ghost)
      }
      d.ghost.lastChild.textContent = target ? "Move to window with " + target.title : "Open in a new window"
      d.ghost.style.transform = "translate(" + Math.round(ev.clientX - d.grabX) + "px, " + Math.round(ev.clientY - 13) + "px)"
      // The row closes up behind the tab that left it.
      d.els.forEach((el, i) => { if (i !== d.from) el.style.transform = i > d.from ? "translateX(" + -d.step + "px)" : "" })
      return
    }
    if (d.ghost) { d.ghost.remove(); d.ghost = null }
    const first = d.rects[0], last = d.rects[d.rects.length - 1], own = d.rects[d.from]
    const dx = Math.max(first.left - own.left, Math.min(last.right - own.right, ev.clientX - press.x))
    press.el.style.transform = "translateX(" + dx + "px)"
    // Chrome's rule (TabStrip CalculateInsertionIndex): the tab goes to the
    // slot whose resting place is nearest its left edge, so a neighbour steps
    // aside as soon as the tab covers half of it. Waiting for the tab's middle
    // to pass the neighbour's middle took half the tab's own width more: with
    // a wide tab, three times the push. A new slot is taken only once the
    // pointer has moved a few pixels since the last one, 16px for a full-width
    // tab (DraggingTabsSession kHorizontalMoveThreshold), so the row does not
    // jitter at a boundary.
    const overlap = d.rects.length > 1 ? first.right - d.rects[1].left : 0
    const others = d.rects.filter((_, i) => i !== d.from)
    let slot = 0, nearest = Infinity
    for (let k = 0, x = first.left; k <= others.length; k += 1) {
      const distance = Math.abs(own.left + dx - x)
      if (distance < nearest) { nearest = distance; slot = k }
      if (k < others.length) x += others[k].width - overlap
    }
    const threshold = Math.max(4, Math.round((16 * (others[Math.min(slot, others.length - 1)] || own).width) / 216))
    if (slot !== d.index && Math.abs(ev.clientX - d.lastX) > threshold) { d.index = slot; d.lastX = ev.clientX }
    const index = d.index
    d.els.forEach((el, i) => {
      if (i === d.from) return
      const shift = d.from < index && i > d.from && i <= index ? -d.step : d.from > index && i >= index && i < d.from ? d.step : 0
      el.style.transform = shift ? "translateX(" + shift + "px)" : ""
    })
  }

  function endDrag(ev, cancel) {
    const d = drag, p = press
    press = null
    drag = null
    try { p.el.releasePointerCapture(p.pointerId) } catch {}
    if (!d) return
    endDrag.just = true
    setTimeout(() => { endDrag.just = false })
    d.ghost?.remove()
    tabsEl.classList.remove("reordering")
    document.body.classList.remove("dragging-tab")
    if (d.target) post({ t: "hover", to: d.target.id })
    if (d.win) {
      cancelAnimationFrame(d.win.frame)
      render()
      // Escape puts the window back where it was.
      if (cancel) { try { moveTo(d.win.x, d.win.y) } catch {} return }
      if (d.target) moveToWindow(d.t.id, d.target.id, d.target.x)
      return
    }
    const was = p.el.getBoundingClientRect().left
    if (cancel || !d.out) {
      // By id: a window still restoring its tabs can replace the list while
      // a tab is dragged, and splicing at the old object's index (-1) took
      // the last tab out instead.
      const at = tabs.findIndex((x) => x.id === d.t.id)
      if (!cancel && d.index !== d.from && at >= 0) {
        const [moved] = tabs.splice(at, 1)
        tabs.splice(Math.min(d.index, tabs.length), 0, moved)
      }
      render()
      // The dropped tab settles into its slot from where it was let go.
      const el = tabsEl.querySelector('.tab[data-id="' + d.t.id + '"]')
      if (el && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const by = was - el.getBoundingClientRect().left
        if (Math.abs(by) > 1) {
          el.style.transform = "translateX(" + by + "px)"
          el.getBoundingClientRect()
          el.classList.add("settling")
          el.style.transform = ""
          setTimeout(() => el.classList.remove("settling"), 200)
        }
      }
      return
    }
    render()
    if (d.target) { moveToWindow(d.t.id, d.target.id, d.target.x); return }
    // The new window opens with the tab under the pointer, where it was held.
    const strip = $("strip").getBoundingClientRect(), list = tabsEl.getBoundingClientRect()
    const cal = calibrated || { x: 0, y: outerHeight - innerHeight }
    tearOut(d.t.id, { left: ev.screenX - list.left - d.grabX - cal.x, top: ev.screenY - strip.top - strip.height / 2 - cal.y })
  }

  // ---- A tab's menu ----

  const menuEl = $("menu")
  function openMenu(id, x, y, fromKeyboard) {
    const t = tabs.find((x) => x.id === id)
    if (!t) return
    hideTip()
    prunePeers()
    menuEl.textContent = ""
    const item = (label, run, disabled) => {
      const b = document.createElement("button")
      b.setAttribute("role", "menuitem")
      b.textContent = label
      b.disabled = Boolean(disabled)
      b.onclick = () => { closeMenu(); run() }
      menuEl.append(b)
    }
    if (t.kind === "editor") {
      item("Rename tab…", () => startRename(id))
      if (customName(t)) item("Use folder name", () => { setName(t, ""); render() })
      menuEl.append(document.createElement("hr"))
    }
    item("Move to new window", () => tearOut(id), tabs.length < 2)
    for (const [peer, p] of peers) item("Move to window with " + p.title, () => moveToWindow(id, peer))
    menuEl.append(document.createElement("hr"))
    item("Close tab", () => close(id), tabs.length < 2)
    menuEl.hidden = false
    const w = menuEl.offsetWidth, h = menuEl.offsetHeight
    menuEl.style.transform = "translate(" + Math.round(Math.max(8, Math.min(x, innerWidth - w - 8))) + "px, " + Math.round(Math.max(8, Math.min(y, innerHeight - h - 8))) + "px)"
    menuEl.dataset.tab = id
    if (fromKeyboard) menuEl.querySelector("button:not(:disabled)")?.focus()
  }
  function closeMenu() {
    if (menuEl.hidden) return
    const id = menuEl.dataset.tab
    const had = menuEl.contains(document.activeElement)
    menuEl.hidden = true
    if (had) focusTab(id)
  }
  menuEl.addEventListener("keydown", (ev) => {
    const items = [...menuEl.querySelectorAll("button:not(:disabled)")]
    const i = items.indexOf(document.activeElement)
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault()
      items[(i + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus()
    } else if (ev.key === "Escape" || ev.key === "Tab") { ev.preventDefault(); closeMenu() }
  })
  addEventListener("pointerdown", (ev) => { if (!menuEl.contains(ev.target)) closeMenu() }, true)
  addEventListener("blur", () => { if (document.activeElement?.tagName !== "IFRAME") closeMenu() })
  addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return
    if (drag) { ev.preventDefault(); endDrag(ev, true) }
    else if (!menuEl.hidden) { ev.preventDefault(); closeMenu() }
  })

  render()
  setInterval(poll, 2000)
  // Pages handed over by "Open in Mac app". The window says whether it is the
  // app or this page in an ordinary browser tab, because the desk sends a page
  // to the app's windows first. It listens after the first poll: a page held
  // for the launch arrives at once, and the tabs restored or moved by that
  // poll would otherwise replace it.
  poll().then(() => {
    if (!("EventSource" in window)) return
    const kind = matchMedia("(display-mode: browser)").matches ? "tab" : "app"
    new EventSource("/api/events?window=" + kind).addEventListener("open-url", (ev) => {
      try { const url = JSON.parse(ev.data).url; if (opensHere(url)) openUrl(url) } catch {}
    })
  })
})()
</script>
</body>
</html>`
}

export function offlinePage({ repoRoot }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>DesignLayer</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#1a1a1a">
<style>html,body{margin:0;height:100%;background:#1a1a1a;color:#fff;font:13px/1.5 -apple-system,system-ui,sans-serif}
body{display:grid;place-items:center}.c{width:min(420px,calc(100% - 48px));text-align:center}h1{font-size:15px;margin:0 0 6px}
p{color:rgba(255,255,255,.62);margin:0 0 12px}code{display:block;text-align:left;background:#232323;border:1px solid rgba(255,255,255,.08);
border-radius:8px;padding:10px 12px;font:12px/1.5 ui-monospace,Menlo,monospace;user-select:all;overflow-wrap:anywhere}
button{margin-top:14px;height:28px;padding:0 12px;border-radius:6px;border:1px solid #0c8ce9;background:#0c8ce9;color:#fff;font:inherit}</style>
</head><body><div class="c"><h1>Can’t connect</h1>
<p>Run this in Terminal:</p>
<code>node ${escapeHtml(repoRoot)}/desktop/mac/install.mjs --start</code>
<button onclick="location.reload()">Try again</button></div>
<script>setInterval(()=>fetch("/api/health",{cache:"no-store"}).then(r=>r.ok&&location.reload()).catch(()=>{}),3000)</script>
</body></html>`
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
