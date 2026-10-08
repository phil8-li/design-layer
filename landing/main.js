// Design Layer landing page: the story, told by scroll.
//
// Progressive: without this file every section still reads, every shot still
// shows, and every link works. With it, three kinds of motion run:
//   1. Scenes, scrubbed by scroll in one rAF loop: the pinned hero (three
//      planes held apart, then landed one by one), the pinned tab sets
//      (scroll walks the tabs), the board (out to every page and back in),
//      the agent story, and headings brightening word by word.
//   2. Arrivals, fired once by an IntersectionObserver: the diff playing, the
//      agent's brief streaming.
//   3. Interactions: tabs that scroll to their stretch, copy buttons, the
//      film, and the hero leaning toward the pointer.
// Reduced motion skips 1 entirely (CSS lays every scene out in its final
// frame) and keeps 2 and 3 as instant state changes.

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)")
const SHOTS = "assets/shots"
const REPO = "phil8-li/design-layer"
const VIEW = { w: 1600, h: 1000 } // the CSS size every shot was captured at
const SEAM = { left: 0.1559, right: 0.8188 } // the editor's panel edges, unless a demo measured its own

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value))
const range = (value, start, end) => clamp((value - start) / (end - start))
const lerp = (a, b, t) => a + (b - a) * t
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const easeOut = (t) => 1 - (1 - t) ** 3
const $ = (selector, scope = document) => scope.querySelector(selector)
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)]

/* ---------- Demo app: which real app the screenshots show ---------- */

const params = new URLSearchParams(location.search)
let demo = params.get("demo") || (params.has("review") && localStorage.getItem("dl-demo")) || "midday"
let demos = []
let geometry = {} // selection, focus and pins of the demo on show, in shot pixels

const shotPath = (src, slug) => src.replace(/(assets\/shots\/)[^/]+\//, `$1${slug}/`)
const shotFile = (src, name) => src.replace(/[a-z-]+-(\d+)\.webp/, `${name}-$1.webp`)

function applyDemo(slug) {
  demo = slug
  const info = demos.find((entry) => entry.slug === slug)
  const missing = new Set(info?.missing ?? [])
  geometry = info?.geometry ?? {}
  // Panel widths differ between captures; the strips follow this demo's seams.
  const seams = geometry.seams ?? SEAM
  for (const layer of $$(".frame-zoom, [data-plane-chrome]")) {
    layer.style.setProperty("--seam-l", seams.left)
    layer.style.setProperty("--seam-r", seams.right)
  }
  placeToolbars()
  for (const img of $$("img[data-shot]")) {
    // A demo without a bare hero shows its own hero there, toolbar and all.
    const name = img.dataset.shot === "hero-bare" && missing.has("hero-bare") ? "hero" : img.dataset.shot
    // A shot this demo could not capture falls back to the default demo's.
    const target = missing.has(name) ? demos[0]?.slug ?? slug : slug
    const move = (src) => shotPath(shotFile(src, name), target)
    img.src = move(img.getAttribute("src"))
    const set = img.getAttribute("srcset")
    if (set) img.srcset = set.split(",").map((part) => move(part.trim())).join(", ")
  }
  measureAll()
  loadAgent(slug).then(() => comment?.measure())
}

// Lazy shots list only their 1280 file in the markup (budget); add the 2400.
for (const img of $$("img[data-shot][loading=lazy]")) {
  img.sizes = "(min-width: 1200px) 1120px, 94vw"
  img.srcset = `${img.getAttribute("src")} 1280w, ${img.getAttribute("src").replace("-1280.", "-2400.")} 2400w`
}

async function loadDemos() {
  try {
    const response = await fetch(`${SHOTS}/demos.json`)
    if (response.ok) demos = await response.json()
  } catch {}
  if (demos.length && !demos.some((entry) => entry.slug === demo)) demo = demos[0].slug
  if (demos.length > 1 && params.has("review")) mountReviewPicker()
  applyDemo(demo)
}

function mountReviewPicker() {
  const bar = document.createElement("div")
  bar.className = "review"
  bar.setAttribute("role", "radiogroup")
  bar.setAttribute("aria-label", "Demo app shown in the screenshots")
  const label = document.createElement("span")
  label.className = "review-label"
  label.textContent = "Demo app"
  bar.append(label)
  const buttons = demos.map((entry) => {
    const button = document.createElement("button")
    button.type = "button"
    button.setAttribute("role", "radio")
    button.setAttribute("aria-checked", String(entry.slug === demo))
    button.tabIndex = entry.slug === demo ? 0 : -1
    button.textContent = entry.name.split(" (")[0]
    button.title = entry.name
    button.addEventListener("click", () => {
      for (const other of buttons) {
        other.setAttribute("aria-checked", String(other === button))
        other.tabIndex = other === button ? 0 : -1
      }
      localStorage.setItem("dl-demo", entry.slug)
      const next = new URL(location.href)
      next.searchParams.set("demo", entry.slug)
      history.replaceState(null, "", next)
      applyDemo(entry.slug)
    })
    return button
  })
  bar.append(...buttons)
  bar.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return
    const index = buttons.indexOf(document.activeElement)
    if (index < 0) return
    event.preventDefault()
    const next = buttons[(index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length]
    next.focus()
    next.click()
  })
  document.body.append(bar)
}

/* ---------- The scene loop ---------- */

const scenes = new Map() // element -> { update, active }
let ticking = false

const sceneObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const scene = scenes.get(entry.target)
    if (!scene) continue
    scene.active = entry.isIntersecting
    // A scene leaving the screen gets one last frame, so it rests at its
    // start or its end rather than wherever the last scroll event left it.
    if (!scene.active && !reducedMotion.matches) scene.update(entry.target.getBoundingClientRect(), window.innerHeight)
  }
  requestTick()
}, { rootMargin: "25% 0px 25% 0px" })

function addScene(element, update) {
  if (!element) return
  scenes.set(element, { update, active: false })
  sceneObserver.observe(element)
}

function requestTick() {
  if (ticking) return
  ticking = true
  requestAnimationFrame(tick)
}

function tick() {
  ticking = false
  const vh = window.innerHeight
  showNav()
  if (reducedMotion.matches) return
  for (const [element, scene] of scenes) if (scene.active) scene.update(element.getBoundingClientRect(), vh)
}

/** Progress through a pinned track: 0 when it reaches the top, 1 when it lets go. */
const trackProgress = (rect, vh) => clamp(-rect.top / Math.max(1, rect.height - vh))

/* ---------- The editor's toolbar, redrawn over the screenshots ---------- */

// Each [data-toolbar-slot] becomes a copy of the real toolbar, sized in the
// shot's own pixels, so it stays sharp when the camera moves in and can show
// a state the screenshot under it does not (Notes pressed, a tooltip).
const toolbars = []
const TOOLBAR = { x: 636, y: 948, w: 328, h: 40 } // where the editor draws it at 1600x1000

function setupToolbars() {
  const template = $("#toolbar")
  if (!template) return
  for (const slot of $$("[data-toolbar-slot]")) {
    const tb = template.content.firstElementChild.cloneNode(true)
    slot.replaceWith(tb)
    toolbars.push({
      tb,
      chip: $("[data-tb-chip]", tb),
      tools: Object.fromEntries($$("[data-tool]", tb).map((tool) => [tool.dataset.tool, tool])),
      undo: $$(".tb-tool", tb)[3],
      tour: slot.hasAttribute("data-tour"),
    })
  }
  // The hero's app plane shows the same capture with the toolbar hidden
  // (hero-bare), so the only toolbar on screen is the one that lands.
  for (const img of $$("[data-hero] .plane-app img[data-shot='hero']")) {
    img.dataset.shot = "hero-bare"
    img.src = shotFile(img.getAttribute("src"), "hero-bare")
    img.srcset = img.getAttribute("srcset").split(",").map((part) => shotFile(part.trim(), "hero-bare")).join(", ")
  }
  placeToolbars()
  // The editor measures each tip and rounds its box up to a whole pixel.
  document.fonts.ready.then(() => {
    for (const tool of $$(".tb-tool[data-tip]")) {
      const width = Number.parseFloat(getComputedStyle(tool, "::after").width)
      if (!width) continue
      tool.style.setProperty("--tip-w", `${Math.ceil(width)}px`)
      tool.classList.add("is-sized")
    }
  })
}

function placeToolbars() {
  const at = geometry.toolbar ?? TOOLBAR
  for (const { tb } of toolbars) {
    tb.style.left = `${at.x}px`
    tb.style.top = `${at.y}px`
  }
}

/** 0 = Inspect, 1 = Notes; fractions slide the accent square between them. */
function setToolbarMode(toolbar, value) {
  toolbar.chip.style.setProperty("--chip", value.toFixed(3))
  toolbar.tools.inspect.classList.toggle("is-on", value < 0.5)
  toolbar.tools.notes.classList.toggle("is-on", value >= 0.5)
}

function showTip(toolbar, name) {
  for (const [key, tool] of Object.entries(toolbar.tools)) tool.classList.toggle("show-tip", key === name)
}

/** On first load, the hero's toolbar shows what its two modes are, once. */
function tourToolbar() {
  const toolbar = toolbars.find((entry) => entry.tour)
  if (!toolbar || reducedMotion.matches || window.scrollY > 40) return
  const end = () => {
    timers.forEach(clearTimeout)
    toolbar.tb.classList.remove("is-touring")
    setToolbarMode(toolbar, 0)
    showTip(toolbar, null)
    window.removeEventListener("scroll", onScroll)
  }
  const onScroll = () => window.scrollY > 40 && end()
  const timers = [
    setTimeout(() => {
      toolbar.tb.classList.add("is-touring")
      setToolbarMode(toolbar, 1)
      showTip(toolbar, "notes")
    }, 2000), // once the planes have drifted apart
    setTimeout(() => {
      setToolbarMode(toolbar, 0)
      showTip(toolbar, "inspect")
    }, 3600),
    setTimeout(() => showTip(toolbar, null), 4900),
    setTimeout(end, 5300), // after the tip has faded, so nothing snaps
  ]
  window.addEventListener("scroll", onScroll, { passive: true })
}

/** Keeps each 1600x1000 drawing layer scaled to the frame it sits in. */
function setupShotSpaces() {
  const spaces = $$("[data-shot-space]")
  if (!spaces.length) return
  const fit = () => {
    for (const space of spaces) space.style.setProperty("--k", String(space.parentElement.clientWidth / VIEW.w))
  }
  fit()
  const observer = new ResizeObserver(fit)
  for (const space of spaces) observer.observe(space.parentElement)
}

/* ---------- Scene: the hero ---------- */

// Three planes, held apart in a gentle 3/4 view: the app at the bottom, the
// editor's panels on a sheet of glass above it, the toolbar on top. At rest
// the stack leans a few degrees toward the pointer. Scroll turns it flat and
// lands the planes in order — panels, then the toolbar, which presses in and
// settles while a soft light marks the click — and every transform ends at
// none, so the layers meet pixel for pixel in the real screenshot. They land
// straight into the frame of Design like Figma, pinned underneath and opening
// on the same screenshot, so the hand-off is one move with no size change.
const hero = (() => {
  const track = $("[data-hero]")
  if (!track) return null
  const copy = $("[data-hero-copy]", track)
  const film = $("[data-hero-film]", track)
  const stack = $("[data-stack]", track)
  const chrome = $("[data-plane-chrome]", track)
  const tools = $("[data-plane-tools]", track)
  const view = $(".plane-app .frame-view", track)
  // The landing's clock, q: its last beat ends at q 0.47, one screen in. The
  // next section's lead-in (data-lead, in vh) is that screen's last stretch.
  const LANDED = 0.47
  const next = $("#edit [data-tabs][data-lead]")
  const nextView = next && $("#edit-view", next)
  const nextFrame = nextView?.closest(".frame")
  const nextFade = next ? $$(".section-head, .switcher-tabs", next) : []
  let base = null // the mock's frame view, untransformed, relative to the stage
  let goal = { x: 0, y: 0, s: 1 } // the film transform that lands it in that frame
  // The resting pose (degrees), and how far apart the planes float, as a share
  // of the stack's width. A phone gets a little less turn.
  const POSES = {
    wide: { rx: 24, ry: 13, rz: -4 },
    narrow: { rx: 20, ry: 10, rz: -3 },
  }
  const DEPTH = { chrome: 0.09, tools: 0.2 }
  const LEAN = { x: 3, y: 2 } // pointer parallax, degrees
  const TURN = [0.01, 0.34] // rise and flatten share one window, so the stack grows in place
  let pose = POSES.wide
  let scale = 0.8
  let startY = 0
  let startX = 0
  let zChrome = 0
  let zTools = 0
  let toolbar = null
  let intro = 1 // planes drift apart once, on first load
  const lean = { x: 0, y: 0, tx: 0, ty: 0, frame: 0, last: 0 }

  const stackTransform = (rx, ry, rz, s) =>
    Math.abs(rx) + Math.abs(ry) + Math.abs(rz) < 0.01 && Math.abs(s - 1) < 0.0005
      ? "none"
      : `rotateX(${rx.toFixed(3)}deg) rotateY(${ry.toFixed(3)}deg) rotateZ(${rz.toFixed(3)}deg) scale(${s.toFixed(4)})`

  function measure() {
    toolbar = toolbars.find((entry) => tools.contains(entry.tb)) ?? null
    const width = stack.offsetWidth
    pose = width < 700 ? POSES.narrow : POSES.wide
    zChrome = width * DEPTH.chrome
    zTools = width * DEPTH.tools
    // Fit the separated stack, as drawn, between the copy and the fold.
    const saved = [film, stack, chrome, tools, toolbar?.tb].map((node) => node?.style.transform)
    film.style.transform = "none"
    chrome.style.transform = `translate3d(0, 0, ${zChrome}px)`
    tools.style.transform = `translate3d(0, 0, ${zTools}px)`
    if (toolbar) toolbar.tb.style.transform = "scale(1.25)"
    // The tools plane itself is invisible: only its toolbar takes up room.
    const bounds = (s) => {
      stack.style.transform = stackTransform(pose.rx, pose.ry, pose.rz, s)
      const base = film.getBoundingClientRect()
      const rects = [stack, chrome, toolbar?.tb ?? tools].map((node) => node.getBoundingClientRect())
      const top = Math.min(...rects.map((r) => r.top)) - base.top
      const bottom = Math.max(...rects.map((r) => r.bottom)) - base.top
      const left = Math.min(...rects.map((r) => r.left))
      const right = Math.max(...rects.map((r) => r.right))
      return { top, bottom, h: bottom - top, w: right - left, mid: (left + right) / 2 - (base.left + base.width / 2) }
    }
    const copyBottom = copy.offsetTop + copy.offsetHeight
    const fold = Math.min(film.parentElement.clientHeight, window.innerHeight - (track.getBoundingClientRect().top + window.scrollY)) - 16
    const roomTop = copyBottom + 48
    const room = fold - roomTop
    let box = bounds(1)
    const roomW = window.innerWidth - (window.innerWidth < 700 ? 24 : 64)
    scale = clamp(Math.min(room / box.h, roomW / box.w), 0.4, 1)
    // Perspective makes the fit slightly non-linear; settle it in two passes.
    for (let i = 0; i < 2; i++) {
      box = bounds(scale)
      scale = clamp(scale * Math.min(room / box.h, roomW / box.w), 0.4, 1)
    }
    box = bounds(scale)
    ;[film, stack, chrome, tools, toolbar?.tb].forEach((node, i) => node && (node.style.transform = saved[i] ?? ""))
    // Centre what is drawn, not the box it is drawn in: the turn pushes it off
    // axis. Spare height goes mostly below, so the lockup sits a touch high.
    startY = roomTop + Math.max(0, (room - box.h) * 0.35) - (film.offsetTop + box.top)
    startX = -box.mid
    for (const node of [film, stack, chrome, tools]) node.style.transform = "none"
    const stageBox = film.parentElement.getBoundingClientRect()
    const filmBox = film.getBoundingClientRect()
    const viewBox = view.getBoundingClientRect()
    base = { fx: filmBox.left - stageBox.left, fy: filmBox.top - stageBox.top, ox: viewBox.left - filmBox.left, oy: viewBox.top - filmBox.top, w: viewBox.width }
    ;[film, stack, chrome, tools].forEach((node, i) => (node.style.transform = saved[i] ?? ""))
    film.style.transformOrigin = "0 0"
    // Where that frame sits once its stage pins.
    if (nextView) {
      const pinned = $(".tabs-stage", next).getBoundingClientRect()
      const target = nextView.getBoundingClientRect()
      const s = target.width / base.w
      goal = { x: target.left - stageBox.left - base.fx - s * base.ox, y: target.top - pinned.top - base.fy - s * base.oy, s }
    }
  }

  /** The hand-off over the next section's lead-in: its title and tabs fade in
   *  over the landed mock, and its frame takes over the same picture. */
  function handOff(vh) {
    if (!next) return
    const box = next.getBoundingClientRect()
    const lead = (Number(next.dataset.lead) / 100) * vh
    const f = clamp(-box.top / lead)
    next.classList.toggle("is-waiting", box.top > 0.5)
    const rise = easeOut(range(f, 0.1, 0.7))
    for (const node of nextFade) {
      node.style.opacity = rise.toFixed(3)
      node.style.transform = rise < 1 ? `translate3d(0, ${(16 * (1 - rise)).toFixed(1)}px, 0)` : ""
    }
    nextFrame.style.opacity = range(f, 0.92, 1).toFixed(3)
    film.style.visibility = f >= 1 ? "hidden" : ""
  }

  function update(rect, vh) {
    const q = clamp((-rect.top / vh) * LANDED) // the landing's own progress

    // The copy steps back, and the film rises into the space it leaves.
    const leave = range(q, 0, 0.18)
    copy.style.transform = leave > 0 ? `translate3d(0, ${(-48 * easeOut(leave)).toFixed(1)}px, 0)` : ""
    copy.style.opacity = String(1 - easeOut(leave))
    copy.inert = leave > 0.6
    copy.style.visibility = leave >= 1 ? "hidden" : ""
    const turn = easeInOut(range(q, ...TURN))
    const y = lerp(startY, goal.y, turn)
    const x = lerp(startX, goal.x, turn)
    const fit = lerp(1, goal.s, turn)
    film.style.transform = Math.abs(x) + Math.abs(y) < 0.25 && Math.abs(fit - 1) < 0.0005 ? "none" : `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${fit.toFixed(4)})`

    // The stack turns flat as it rises; the lean toward the pointer fades as scroll starts.
    const still = 1 - easeOut(range(q, 0, 0.04))
    const rx = pose.rx * (1 - turn) - lean.y * LEAN.y * still
    const ry = pose.ry * (1 - turn) + lean.x * LEAN.x * still
    stack.style.transform = stackTransform(rx, ry, pose.rz * (1 - turn), lerp(scale, 1, turn))

    // The panels land first, then the toolbar, which presses in once and settles.
    const panels = (1 - easeInOut(range(q, 0.06, 0.34))) * intro
    const bar = (1 - easeInOut(range(q, 0.14, 0.4))) * intro
    const settle = range(q, 0.4, 0.47)
    const press = 1 - 0.035 * Math.sin(Math.PI * settle)
    chrome.style.transform = panels * zChrome > 0.3 ? `translate3d(0, 0, ${(panels * zChrome).toFixed(1)}px)` : "none"
    tools.style.transform = bar * zTools > 0.3 ? `translate3d(0, 0, ${(bar * zTools).toFixed(1)}px)` : "none"
    chrome.style.setProperty("--lift", panels.toFixed(3))
    tools.style.setProperty("--lift", bar.toFixed(3))
    if (toolbar) {
      const s = lerp(1, 1.25, bar) * press
      toolbar.tb.style.transform = Math.abs(s - 1) > 0.0005 ? `scale(${s.toFixed(4)})` : ""
    }
    view.style.setProperty("--dim", (0.3 * panels).toFixed(3))
    handOff(vh)
  }

  /** On first load the planes drift apart, so the stack reads as layers. */
  function playIntro() {
    if (reducedMotion.matches || window.scrollY > 40) return
    intro = 0
    const started = performance.now() + 420
    const step = (now) => {
      const t = range(now - started, 0, 1400)
      intro = 1 - (1 - t) ** 4 // a long ease-out: they float apart and come to rest
      requestTick()
      if (t < 1) requestAnimationFrame(step)
      else intro = 1
    }
    requestAnimationFrame(step)
  }

  /** At rest, the stack leans a few degrees toward a fine pointer. */
  function follow(now) {
    // Frame-rate independent smoothing: about 90% of the way in 400ms.
    const dt = lean.last ? Math.min(64, now - lean.last) : 16
    lean.last = now
    const k = 1 - Math.exp(-dt / 170)
    lean.x += (lean.tx - lean.x) * k
    lean.y += (lean.ty - lean.y) * k
    requestTick()
    const moving = Math.abs(lean.tx - lean.x) + Math.abs(lean.ty - lean.y) > 0.002
    lean.frame = moving ? requestAnimationFrame(follow) : 0
    if (!moving) lean.last = 0
  }

  const aim = (tx, ty) => {
    lean.tx = tx
    lean.ty = ty
    if (!lean.frame) lean.frame = requestAnimationFrame(follow)
  }

  window.addEventListener("pointermove", (event) => {
    if (!finePointer.matches || reducedMotion.matches || event.pointerType !== "mouse") return
    if (window.scrollY > window.innerHeight * 0.1) return
    aim(clamp((event.clientX / window.innerWidth) * 2 - 1, -1, 1), clamp((event.clientY / window.innerHeight) * 2 - 1, -1, 1))
  }, { passive: true })
  // When the pointer leaves the window, the stack eases back to its pose.
  document.documentElement.addEventListener("mouseleave", () => aim(0, 0))

  function reset() {
    for (const node of [film, copy, stack, next, nextFrame, ...nextFade]) node?.removeAttribute("style")
    for (const node of [chrome, tools]) {
      node.style.removeProperty("transform")
      node.style.removeProperty("--lift")
    }
    view.style.removeProperty("--dim")
    toolbar?.tb.style.removeProperty("transform")
    copy.inert = false
  }

  addScene(track, update)
  return { measure, reset, playIntro }
})()

/* ---------- Tabs: the pill and the keys every tab set shares ---------- */

function movePill(pill, tab, animate) {
  if (!pill || !tab) return
  pill.classList.toggle("no-motion", !animate || reducedMotion.matches)
  pill.style.transform = `translate(${tab.offsetLeft}px, ${tab.offsetTop}px) scaleX(${tab.offsetWidth / 100})`
  pill.style.height = `${tab.offsetHeight}px`
}

/** On a narrow screen the tab row scrolls; keep the chosen tab in view. */
function centerTab(tab) {
  const list = tab.parentElement
  if (list.scrollWidth > list.clientWidth) list.scrollTo({ left: tab.offsetLeft - (list.clientWidth - tab.offsetWidth) / 2, behavior: reducedMotion.matches ? "instant" : "smooth" })
}

/** Scrolls to a share of a pinned track, after its lead-in. Pinned, the stage
 *  holds still and only the tab changes, so jump; from outside, travel there. */
function scrollTrack(track, share, lead = 0) {
  const rect = track.getBoundingClientRect()
  const pinned = rect.top <= 1 && rect.bottom >= window.innerHeight - 1
  window.scrollTo({ top: rect.top + window.scrollY + lead + (track.offsetHeight - window.innerHeight - lead) * share, behavior: pinned ? "instant" : "smooth" })
}

/** Click to choose; arrows, Home and End move along the tablist. */
function tabKeys(tabs, current, choose) {
  tabs.forEach((node, i) => {
    node.addEventListener("click", () => choose(i))
    node.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
      const to = step ? current() + step : { Home: 0, End: tabs.length - 1 }[event.key]
      if (to === undefined) return
      event.preventDefault()
      choose((to + tabs.length) % tabs.length, { focus: true })
    })
  })
}

/* ---------- Scene: iterate with your agent ---------- */

// Four beats, one camera, a tab each: Point (notes are pinned), Send (the
// agent's brief streams in), Compare (the agent's options are switches; one is
// flipped) and Pick (a note keeps one; the agent closes the rest out).
const comment = (() => {
  const track = $("[data-comment]")
  if (!track) return null
  const zoom = $("[data-comment-zoom]", track)
  const shots = $$("img[data-beat]", zoom)
  const pinsBox = $("[data-pins]", track)
  const ring = $("[data-send-ring]", track)
  const optionRing = $("[data-option-ring]", track)
  const pickNote = $("[data-pick-note]", track)
  const terminal = $("[data-comment-terminal]", track)
  const body = terminal && $(".terminal-body", terminal)
  const codes = terminal ? [$("[data-agent]", terminal), $("[data-agent-close]", terminal)] : []
  const switcher = $("[data-comment-switcher]", track)
  const tabs = switcher ? $$('[role="tab"]', switcher) : []
  const pill = switcher && $(".switcher-pill", switcher)
  const space = $("[data-shot-space]", zoom)
  const panel = $("#agent-view")
  const WINDOWS = [[0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1]] // each beat's stretch of scroll
  const BEAT_SHOT = [1, 2, 4, 4] // the shot each tab shows when there is no scroll to play it
  const BEAT_REST = [0.24, 0.49, 0.74, 1] // and the moment its drawn cues rest at
  const OPTION_ROW = { x: 14, y: 249, w: 256, h: 24 }
  let tab = -1
  let toolbar = null
  let pins = []
  let keys = []
  let lines = [0, 0]
  let lineHeight = 22
  let active = -1
  let shown = -1

  const placePill = (animate) => movePill(pill, tabs[tab], animate)

  const selectTab = (index, { focus = false } = {}) => {
    if (index !== tab && tabs[index]) {
      tab = index
      tabs.forEach((node, i) => {
        node.setAttribute("aria-selected", String(i === index))
        node.tabIndex = i === index ? 0 : -1
        if (i !== index) node.style.removeProperty("--fill")
      })
      panel?.setAttribute("aria-labelledby", tabs[index].id)
      placePill(true)
      centerTab(tabs[index])
    }
    if (focus) tabs[index]?.focus({ preventScroll: true })
  }

  const showCode = (index) => {
    if (index === shown) return
    shown = index
    codes.forEach((code, i) => code && (code.hidden = i !== index))
  }

  /** A beat at rest, for reduced motion. */
  const still = (index) => {
    setBeat(BEAT_SHOT[index])
    space?.style.setProperty("--t", String(BEAT_REST[index]))
    pickNote?.style.setProperty("--o", index === 3 ? "1" : "0")
    showCode(index === 3 ? 1 : 0)
  }

  const choose = (index, options) => {
    selectTab(index, options)
    if (reducedMotion.matches) {
      still(index)
      return
    }
    scrollTrack(track, WINDOWS[index][0] + 0.03)
  }

  tabKeys(tabs, () => tab, choose)

  const setBeat = (index) => {
    if (index === active) return
    active = index
    shots.forEach((shot, i) => {
      if (i === index && shot.loading === "lazy") shot.loading = "eager"
      shot.classList.toggle("is-active", i === index)
    })
    // Warm the next shot so the crossfade never waits on the network.
    const next = shots[index + 1]
    if (next?.loading === "lazy") next.loading = "eager"
  }

  function measure() {
    toolbar = toolbars.find((entry) => zoom.contains(entry.tb)) ?? null
    const marks = geometry.pins ?? []
    pinsBox.replaceChildren(
      ...marks.map((mark) => {
        const pin = document.createElement("span")
        pin.className = "pin"
        pin.style.left = `${mark.x}px`
        pin.style.top = `${mark.y}px`
        return pin
      })
    )
    pins = $$(".pin", pinsBox)
    const send = geometry.send
    if (ring) {
      ring.hidden = !send
      if (send) Object.assign(ring.style, { left: `${send.x - 4}px`, top: `${send.y - 4}px`, width: `${send.w + 8}px`, height: `${send.h + 8}px` })
    }
    const row = (geometry.options ?? []).find((entry) => /tilt/i.test(entry.label ?? "")) ?? OPTION_ROW
    if (optionRing) Object.assign(optionRing.style, { left: `${row.x - 4}px`, top: `${row.y - 3}px`, width: `${row.w + 8}px`, height: `${row.h + 6}px` })
    const bar = geometry.toolbar ?? TOOLBAR
    const seams = geometry.seams ?? SEAM
    const xs = marks.map((mark) => mark.x)
    const ys = marks.map((mark) => mark.y)
    const pinsAt = marks.length ? { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 } : { x: 800, y: 420 }
    const sendAt = send ? { x: send.x + send.w / 2, y: send.y + send.h / 2 } : { x: ((1 + seams.right) / 2) * VIEW.w, y: 320 }
    // Where the camera looks (shot px) and how close, at each point of the scroll.
    // At 1.87 the toolbar's frame tops out in the gap between the subtitle and
    // Get started (y 466), so no line of text is cut.
    keys = [
      { at: 0, x: 800, y: 500, s: 1 },
      { at: 0.05, x: bar.x + bar.w / 2, y: bar.y, s: 1.87 },
      { at: 0.11, x: bar.x + bar.w / 2, y: bar.y, s: 1.87 },
      { at: 0.16, x: pinsAt.x, y: pinsAt.y, s: 1.2 },
      { at: 0.24, x: pinsAt.x, y: pinsAt.y, s: 1.2 },
      { at: 0.3, x: sendAt.x, y: sendAt.y, s: 1.65 },
      { at: 0.37, x: sendAt.x, y: sendAt.y, s: 1.65 },
      { at: 0.43, x: 800, y: 500, s: 1 },
      { at: 0.53, x: 800, y: 500, s: 1 },
      { at: 0.58, x: 760, y: 520, s: 1.12 },
      { at: 0.72, x: 760, y: 520, s: 1.12 },
      { at: 0.78, x: 800, y: 500, s: 1 },
      { at: 1, x: 800, y: 500, s: 1 },
    ]
    lines = codes.map((code) => (code ? $$(".tl", code).length : 0))
    if (codes[0]) lineHeight = parseFloat(getComputedStyle(codes[0]).lineHeight) || 22
    switcher?.classList.toggle("is-scrolling", !reducedMotion.matches)
    if (tab < 0) selectTab(0)
    placePill(false)
  }

  function camera(p) {
    let i = 0
    while (i < keys.length - 2 && p > keys[i + 1].at) i++
    const a = keys[i]
    const b = keys[i + 1]
    const t = easeInOut(range(p, a.at, b.at))
    const s = lerp(a.s, b.s, t)
    // Keep the shot covering the frame: no empty edges when close in.
    const halfW = VIEW.w / (2 * s)
    const halfH = VIEW.h / (2 * s)
    const x = clamp(lerp(a.x, b.x, t), halfW, VIEW.w - halfW)
    const y = clamp(lerp(a.y, b.y, t), halfH, VIEW.h - halfH)
    zoom.style.transformOrigin = "0 0"
    zoom.style.transform = `translate3d(${(((VIEW.w / 2 - s * x) / VIEW.w) * 100).toFixed(3)}%, ${(((VIEW.h / 2 - s * y) / VIEW.h) * 100).toFixed(3)}%, 0) scale(${s.toFixed(4)})`
  }

  function stream(index, reveal) {
    const code = codes[index]
    if (!code) return
    code.style.setProperty("--reveal", reveal.toFixed(2))
    const visible = body.clientHeight - 28
    code.style.transform = `translate3d(0, ${-Math.max(0, reveal * lineHeight - visible).toFixed(1)}px, 0)`
  }

  function update(rect, vh) {
    const p = trackProgress(rect, vh)
    camera(p)
    space?.style.setProperty("--t", p.toFixed(3))

    // Point.
    if (toolbar) {
      setToolbarMode(toolbar, easeInOut(range(p, 0.06, 0.1)) * (1 - easeInOut(range(p, 0.5, 0.54))))
      showTip(toolbar, p > 0.07 && p < 0.15 ? "notes" : null)
      toolbar.undo.classList.toggle("is-dim", p < 0.27)
    }
    setBeat(p < 0.13 ? 0 : p < 0.27 ? 1 : p < 0.55 ? 2 : p < 0.65 ? 3 : 4)
    pinsBox.hidden = p >= 0.55
    pins.forEach((pin, i) => {
      const at = 0.16 + i * 0.025
      pin.style.setProperty("--ring", p < at ? "0" : (1 - range(p, at, at + 0.06)).toFixed(3))
      pin.style.setProperty("--ring2", p < at + 0.015 ? "0" : (1 - range(p, at + 0.015, at + 0.08)).toFixed(3))
    })

    // Send.
    if (ring && !ring.hidden) {
      ring.style.setProperty("--o", (range(p, 0.3, 0.33) * (1 - range(p, 0.4, 0.43))).toFixed(3))
      ring.style.setProperty("--s", (1 - 0.06 * Math.sin(Math.PI * range(p, 0.34, 0.37))).toFixed(4))
    }

    // Compare, then Pick.
    optionRing?.style.setProperty("--o", (range(p, 0.6, 0.63) * (1 - range(p, 0.71, 0.75))).toFixed(3))

    pickNote?.style.setProperty("--o", easeOut(range(p, 0.8, 0.84)).toFixed(3))

    // The terminal streams the brief after Send, steps aside, then the close-out.
    if (terminal) {
      const second = p >= 0.7
      showCode(second ? 1 : 0)
      const enter = second ? easeOut(range(p, 0.85, 0.9)) : easeOut(range(p, 0.38, 0.44)) * (1 - easeInOut(range(p, 0.53, 0.57)))
      terminal.style.opacity = enter.toFixed(3)
      terminal.style.transform = `translate3d(${lerp(56, 0, enter).toFixed(1)}px, ${lerp(28, 0, enter).toFixed(1)}px, 0) scale(${lerp(0.96, 1, enter).toFixed(4)})`
      terminal.style.pointerEvents = enter > 0.5 ? "" : "none"
      if (second) stream(1, lerp(0, lines[1] + 1, range(p, 0.88, 0.99)))
      else stream(0, lerp(0, lines[0] + 1, range(p, 0.41, 0.52)))
    }

    // The tab of the beat on screen, filling as its stretch of scroll runs out.
    const index = Math.max(0, WINDOWS.findIndex(([, end]) => p < end))
    const now = p >= 1 ? WINDOWS.length - 1 : index
    selectTab(now)
    tabs[now]?.style.setProperty("--fill", range(p, ...WINDOWS[now]).toFixed(3))
  }

  function reset() {
    zoom.removeAttribute("style")
    active = -1
    pinsBox.hidden = false
    for (const pin of pins) {
      pin.style.setProperty("--ring", "0")
      pin.style.setProperty("--ring2", "0")
    }
    if (toolbar) {
      setToolbarMode(toolbar, 1)
      showTip(toolbar, null)
      toolbar.undo.classList.remove("is-dim")
    }
    ring?.style.setProperty("--o", "0")
    optionRing?.style.setProperty("--o", "0")
    terminal?.removeAttribute("style")
    for (const code of codes) {
      code?.style.removeProperty("--reveal")
      code?.style.removeProperty("transform")
    }
    selectTab(0)
    still(0)
    for (const node of tabs) node.style.removeProperty("--fill")
  }

  addScene(track, update)
  return { measure, reset }
})()

/* ---------- Scene: out to the board, and back in live ---------- */

// The panels stay put; the live page shrinks into its frame on the board (⇧1),
// the pointer clicks Live, and the page grows back until the editor is as it was.
const canvas = (() => {
  const track = $("[data-canvas]")
  if (!track) return null
  const live = $("[data-canvas-live]", track)
  const page = $(".canvas-page", track)
  const badge = $("[data-canvas-badge]", track)
  const hover = $("[data-canvas-hover]", track)
  const hand = $("[data-canvas-hand]", track)
  const ripple = $("[data-canvas-ripple]", track)
  const clock = $(".frame-view", track)
  const OUT = [0.06, 0.4] // the page shrinks into the board
  const IN = [0.62, 0.94] // Live: it grows back
  let focus = null
  let column = null

  function measure() {
    focus = geometry.focus ?? null
    badge.hidden = hover.hidden = live.hidden = !focus
    if (!focus) return
    const seams = geometry.seams ?? SEAM
    column = { x: seams.left * VIEW.w, w: (seams.right - seams.left) * VIEW.w }
    Object.assign(live.style, { clipPath: "none", overflow: "hidden", inset: "auto", left: `${seams.left * 100}%`, top: "0", width: `${(column.w / VIEW.w) * 100}%`, height: "100%", transformOrigin: "0 0" })
    Object.assign($("img", live).style, { inset: "auto", top: "0", left: `${(-seams.left / (seams.right - seams.left)) * 100}%`, width: `${(VIEW.w / column.w) * 100}%`, maxWidth: "none", height: "100%" })
    Object.assign(badge.style, { left: `${focus.x + focus.w - 8}px`, top: `${focus.y + 8}px` })
    Object.assign(hover.style, { left: `${focus.x}px`, top: `${focus.y}px`, width: `${focus.w}px`, height: `${focus.h}px` })
    for (const node of [hand, ripple]) {
      node.style.setProperty("--x", `${focus.x + focus.w - 36}px`)
      node.style.setProperty("--y", `${focus.y + 20}px`)
    }
  }

  function update(rect, vh) {
    const p = trackProgress(rect, vh)
    // 1 is the board; 0 is the live editor.
    const t = easeInOut(range(p, ...OUT)) * (1 - easeInOut(range(p, ...IN)))
    clock.style.setProperty("--t", p.toFixed(3))
    const lit = (range(p, 0.44, 0.48) * (1 - range(p, 0.6, 0.64))).toFixed(3)
    badge.style.setProperty("--o", lit)
    hover.style.setProperty("--o", lit)
    page.style.opacity = (1 - range(t, 0, 0.18)).toFixed(3)
    if (!focus) return
    const s = lerp(1, focus.w / column.w, t)
    live.style.transform = `translate(${((lerp(0, focus.x - column.x, t) / column.w) * 100).toFixed(3)}%, ${((lerp(0, focus.y, t) / VIEW.h) * 100).toFixed(3)}%) scale(${s.toFixed(4)})`
    live.style.opacity = (1 - range(t, 0.85, 1)).toFixed(3)
  }

  function reset() {
    page.style.removeProperty("opacity")
    badge.style.setProperty("--o", "1")
    hover.style.setProperty("--o", "1")
    clock.style.setProperty("--t", clock.dataset.rest ?? "1")
  }

  addScene(track, update)
  return { measure, reset }
})()

/* ---------- The nav arrives with the second section ---------- */

// The hero is the headline and the mockup alone. The nav slides in once
// Design like Figma's stage pins, which is also when the hero's copy is gone.
const nav = $("[data-nav]")
const navAfter = $("#edit")
let navShown

function showNav() {
  if (!nav || !navAfter) return
  const shown = navAfter.getBoundingClientRect().top <= 1
  if (shown === navShown) return
  navShown = shown
  nav.classList.toggle("is-shown", shown)
  nav.inert = !shown
}

/* ---------- Arrivals ---------- */

const arrivals = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue
    arrivals.unobserve(entry.target)
    entry.target.classList.add("is-in")
    entry.target.dispatchEvent(new CustomEvent("arrive"))
  }
}, { threshold: 0.2, rootMargin: "0px 0px -8% 0px" })

const onArrive = (element, run) => {
  if (!element) return
  element.addEventListener("arrive", run, { once: true })
  arrivals.observe(element)
}

/** Wraps each word of a heading so it can brighten on its own beat. */
function splitWords(heading) {
  let index = 0
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const fragment = document.createDocumentFragment()
        for (const part of child.textContent.split(/(\s+)/)) {
          if (!part) continue
          if (/^\s+$/.test(part)) {
            fragment.append(part)
            continue
          }
          const word = document.createElement("span")
          word.className = "w"
          word.style.setProperty("--i", index++)
          word.textContent = part
          fragment.append(word)
        }
        child.replaceWith(fragment)
      } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName !== "KBD") {
        walk(child)
      }
    }
  }
  walk(heading)
  heading.classList.add("words")
}

/* ---------- Scene: headings brighten word by word as they rise ---------- */

// Each word lights as it travels from the bottom of the screen to 80% of the
// way up, a little later the further right it sits, so a heading reads in
// order line by line. By 80% every word is fully lit.
const headings = []

function setupHeadings() {
  for (const heading of $$("h2:not(.visually-hidden)")) {
    splitWords(heading)
    const words = $$(".w", heading)
    const entry = { heading, marks: [] }
    entry.measure = () => {
      const box = heading.getBoundingClientRect()
      entry.marks = words.map((word) => {
        const r = word.getBoundingClientRect()
        return { word, y: r.top + r.height / 2 - box.top, x: (r.left - box.left) / Math.max(1, box.width), lit: -1 }
      })
    }
    entry.measure()
    headings.push(entry)
    addScene(heading, (rect, vh) => {
      for (const mark of entry.marks) {
        const start = vh * (1 - 0.06 * mark.x)
        const end = vh * (0.86 - 0.06 * mark.x)
        const lit = Math.round(range(rect.top + mark.y, start, end) * 100) / 100
        if (lit === mark.lit) continue
        mark.lit = lit
        mark.word.style.setProperty("--lit", lit)
      }
    })
  }
}

// The hero's app token cycles the kinds of app Design Layer works on, on its
// own while the hero is on screen and on each click. The old word lifts out as
// the new one rises in, and the pill glides to the new width; the first line
// ends at a hard break, so only the second line ever moves.
function setupToken() {
  const token = $("[data-token]")
  if (!token) return
  const words = $(".token-words", token)
  const art = $(".token-art", token)
  const KINDS = [["vibe-coded", "Sparkles"], ["React", "Code"], ["Angular", "Component"]]
  const ease = "cubic-bezier(0.23, 1, 0.32, 1)"
  let at = 0
  let timer = 0
  let held = false
  let seen = false

  function advance() {
    at = (at + 1) % KINDS.length
    const old = $(".token-word:last-child", words)
    const from = words.offsetWidth
    const word = document.createElement("span")
    word.className = "token-word"
    word.textContent = KINDS[at][0]
    words.append(word)
    $("use", art).setAttribute("href", `assets/icons.svg#i-${KINDS[at][1]}`)
    if (reducedMotion.matches) return old.remove()
    old.setAttribute("aria-hidden", "true")
    old.animate({ opacity: [1, 0], transform: ["none", "translateY(-0.32em)"], filter: ["none", "blur(4px)"] }, { duration: 240, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" }).finished.then(() => old.remove(), () => old.remove())
    word.animate({ opacity: [0, 1], transform: ["translateY(0.32em)", "none"], filter: ["blur(4px)", "none"] }, { duration: 460, delay: 90, easing: ease, fill: "backwards" })
    words.animate({ width: [`${from}px`, `${word.offsetWidth}px`] }, { duration: 560, easing: "cubic-bezier(0.65, 0, 0.35, 1)" })
    art.animate({ transform: ["scale(0.6)", "none"] }, { duration: 560, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" })
  }

  function schedule() {
    clearTimeout(timer)
    if (!held && seen && !document.hidden && !reducedMotion.matches) timer = setTimeout(() => {
      if (!token.closest("[inert]")) advance()
      schedule()
    }, 2600)
  }

  const hold = (on) => () => ((held = on), schedule())
  token.addEventListener("click", () => (advance(), schedule()))
  token.addEventListener("pointerenter", hold(true))
  token.addEventListener("pointerleave", hold(false))
  token.addEventListener("focus", hold(true))
  token.addEventListener("blur", hold(false))
  document.addEventListener("visibilitychange", schedule)
  reducedMotion.addEventListener("change", schedule)
  new IntersectionObserver(([entry]) => ((seen = entry.isIntersecting), schedule()), { threshold: [0, 1] }).observe(token)
}

// A drawn slider over a native range input. A press sets the value whose thumb
// center is under the pointer, then drags; the input keeps the keyboard (its
// own pointer mapping is a few px off the drawn thumb). `change` gets numbers.
function slider(track, change) {
  const input = $("input", track)
  const show = () => track.style.setProperty("--p", (input.value - input.min) / (input.max - input.min))
  const seek = (event) => {
    const style = getComputedStyle(track)
    const edge = parseFloat(style.getPropertyValue("--inset")) + parseFloat(style.getPropertyValue("--knob-w")) / 2
    const box = track.getBoundingClientRect()
    const p = clamp((event.clientX - box.left - edge) / (box.width - 2 * edge))
    const [min, max, step] = [input.min, input.max, input.step].map(Number)
    const value = String(min + Math.round((p * (max - min)) / step) * step)
    if (value === input.value) return
    input.value = value
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }
  track.addEventListener("pointerdown", (event) => {
    input.focus({ preventScroll: true })
    track.setPointerCapture(event.pointerId)
    track.dataset.dragging = track.dataset.pointer = ""
    seek(event)
  })
  track.addEventListener("pointermove", (event) => track.hasPointerCapture(event.pointerId) && seek(event))
  // The press keeps focus on the input instead of moving it to the page.
  track.addEventListener("mousedown", (event) => event.preventDefault())
  for (const type of ["pointerup", "pointercancel"]) track.addEventListener(type, () => delete track.dataset.dragging)
  input.addEventListener("input", () => (show(), change(Number(input.value))))
  // Chrome marks a script-focused range :focus-visible; the ring waits for a key.
  for (const type of ["keydown", "blur"]) input.addEventListener(type, () => delete track.dataset.pointer)
  show()
  return (value) => ((input.value = value), show(), change(Number(input.value)))
}

// The footer's inspector. The color wheel is a strip of swatches dragged under
// a fixed frame, as in graphicalui.com's theme panel: it wraps around, and the
// page's accent (and the WebGL blinds', via an "accent" event) follows the
// swatch in the frame while it moves. The sliders set the wordmark's weight
// and spacing. Nothing is kept: a reload is back to indigo.
function setupTweak() {
  const form = $("[data-tweak]")
  if (!form) return
  const root = document.documentElement.style
  const word = $(".endcard-word")
  const wheel = $("[data-wheel]", form)
  const picker = $("input", wheel)
  const SWATCHES = [["Indigo", "#798cff", "#4a5df9"], ["Violet", "#a78bfa", "#7c4dff"], ["Purple", "#c084fc", "#9333ea"], ["Fuchsia", "#e879f9", "#c026d3"], ["Pink", "#f472b6", "#db2777"], ["Rose", "#fb7185", "#e11d48"], ["Red", "#f87171", "#dc2626"], ["Coral", "#ff8a65", "#e8501c"], ["Orange", "#fb923c", "#ea580c"], ["Amber", "#fbbf24", "#d18b00"], ["Lime", "#a3e635", "#5f9b0c"], ["Green", "#4ade80", "#16a34a"], ["Mint", "#34d399", "#059669"], ["Teal", "#2dd4bf", "#0d9488"], ["Sky", "#38bdf8", "#0284c7"], ["Blue", "#60a5fa", "#2563eb"]]
  const n = SWATCHES.length
  const W = 24 // one swatch, in px
  const chips = SWATCHES.map(([, accent]) => {
    const chip = document.createElement("span")
    chip.style.background = accent
    $(".wheel-window", wheel).append(chip)
    return chip
  })
  picker.max = n - 1
  let pos = 0 // the swatch under the frame, fractional while it moves
  let shown = 0
  let tween = 0

  const wrap = (i) => ((i % n) + n) % n
  function paint() {
    for (const [i, chip] of chips.entries()) {
      const d = wrap(i - pos + n / 2) - n / 2
      chip.style.transform = `translateX(${(d * W - W / 2).toFixed(2)}px)`
    }
    const i = wrap(Math.round(pos))
    if (i === shown) return
    shown = i
    const [name, accent, deep] = SWATCHES[i]
    root.setProperty("--accent", accent)
    root.setProperty("--accent-fill", deep)
    root.setProperty("--accent-text", `color-mix(in oklab, ${accent} 82%, #fff)`)
    root.setProperty("--accent-glow", `color-mix(in srgb, ${accent} 18%, transparent)`)
    wheel.style.setProperty("--wheel", accent)
    picker.value = i
    picker.setAttribute("aria-valuetext", name)
    dispatchEvent(new CustomEvent("accent", { detail: [accent, deep] }))
  }

  // Settles on whole swatch `to` along the shorter way round.
  function settle(to) {
    cancelAnimationFrame(tween)
    const from = pos
    const goal = from + (wrap(to - from + n / 2) - n / 2)
    if (reducedMotion.matches) return (pos = wrap(goal)), paint()
    const start = performance.now()
    const step = (now) => {
      const t = Math.min(1, (now - start) / 380)
      pos = from + (goal - from) * (1 - (1 - t) ** 3)
      paint()
      if (t < 1) tween = requestAnimationFrame(step)
      else (pos = wrap(goal)), paint()
    }
    tween = requestAnimationFrame(step)
  }

  let drag = null
  wheel.addEventListener("pointerdown", (event) => {
    cancelAnimationFrame(tween)
    wheel.setPointerCapture(event.pointerId)
    drag = { x: event.clientX, pos, moved: false }
    wheel.dataset.dragging = ""
  })
  wheel.addEventListener("pointermove", (event) => {
    if (!drag) return
    const dx = event.clientX - drag.x
    if (Math.abs(dx) > 3) drag.moved = true
    pos = drag.pos - dx / W
    paint()
  })
  const release = (event) => {
    if (!drag) return
    delete wheel.dataset.dragging
    // A tap picks the swatch under it; a drag lands on the nearest one.
    const box = wheel.getBoundingClientRect()
    settle(drag.moved ? Math.round(pos) : Math.round(pos + (event.clientX - box.left - box.width / 2) / W))
    drag = null
  }
  wheel.addEventListener("pointerup", release)
  wheel.addEventListener("pointercancel", release)

  form.addEventListener("input", (event) => event.target === picker && settle(Number(picker.value)))
  form.addEventListener("submit", (event) => event.preventDefault())
  for (const track of $$(".tweak-track", form)) {
    const input = $("input", track)
    const output = $("output", track.closest("label"))
    slider(track, (value) => {
      if (input.name === "weight") word.style.setProperty("--wm-weight", value)
      else word.style.setProperty("--wm-spacing", `${value / 100}em`)
      output.value = input.name === "weight" ? value : `${value}%`
    })
  }
  shown = -1
  paint()
}

// Direct edit: the double-click selects "vibe-coded"; each letter of "real"
// replaces it at its own moment of the tab's scroll.
function setupTypeEdit() {
  const layer = $("[data-type-edit]")
  const shot = layer?.closest(".shot")
  if (!shot) return
  const word = $("[data-te-word]", layer)
  const key = $("[data-te-key]", shot)
  const KEYS = [0.46, 0.52, 0.58, 0.64]
  let shown = -1
  shot.typeEdit = (t) => {
    const typed = KEYS.filter((at) => t >= at).length
    if (typed === shown) return
    shown = typed
    word.textContent = typed ? "real".slice(0, typed) : "vibe-coded"
    word.classList.toggle("is-sel", !typed)
    if (key) key.textContent = "REAL"[Math.max(0, typed - 1)]
  }
}

function setupArrivals() {
  for (const element of $$("[data-rise]")) onArrive(element, () => {})
  for (const list of $$("[data-reveal]")) onArrive(list, () => {})

  // The end card rises and its light sweeps across the name every time it
  // comes into view; once it has left the screen it resets for the next visit.
  const endcard = $("[data-endcard]")
  if (endcard) {
    new IntersectionObserver(([entry]) => {
      if (entry.intersectionRatio >= 0.2) endcard.classList.add("is-in")
      else if (!entry.isIntersecting) endcard.classList.remove("is-in")
    }, { threshold: [0, 0.2] }).observe(endcard)
  }

  for (const counter of $$("[data-count-from]")) {
    onArrive(counter, () => {
      if (reducedMotion.matches) return
      const from = Number(counter.dataset.countFrom)
      const unit = counter.dataset.countUnit ?? ""
      const format = new Intl.NumberFormat("en")
      const started = performance.now()
      const step = (now) => {
        const t = range(now - started, 0, 1600)
        counter.textContent = `${format.format(Math.round(from * (1 - easeOut(t))))}${unit}`
        if (t < 1) requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })
  }

  for (const typed of $$("[data-type]")) {
    const text = typed.textContent
    onArrive(typed, () => {
      if (reducedMotion.matches) return
      typed.style.minWidth = `${typed.offsetWidth}px`
      typed.textContent = ""
      let shown = 0
      const timer = setInterval(() => {
        typed.textContent = text.slice(0, ++shown)
        if (shown >= text.length) clearInterval(timer)
      }, 55)
    })
  }
}

/* ---------- Text helpers ---------- */

const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])

/* ---------- What the agent receives over MCP ---------- */

function highlightJson(value, depth = 0) {
  const pad = "  ".repeat(depth)
  const inner = "  ".repeat(depth + 1)
  if (Array.isArray(value)) {
    if (!value.length) return "[]"
    const items = value.slice(0, 3).map((item) => inner + highlightJson(item, depth + 1))
    if (value.length > 3) items.push(`${inner}<span class="t-dim">… ${value.length - 3} more</span>`)
    return `[\n${items.join(",\n")}\n${pad}]`
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
    if (!entries.length) return "{}"
    const shown = entries.slice(0, 8).map(([key, item]) => `${inner}<span class="t-key">"${escapeHtml(key)}"</span>: ${highlightJson(item, depth + 1)}`)
    if (entries.length > 8) shown.push(`${inner}<span class="t-dim">…</span>`)
    return `{\n${shown.join(",\n")}\n${pad}}`
  }
  if (typeof value === "string") {
    const first = value.split("\n")[0]
    const short = first.length > 56 ? `${first.slice(0, 55)}…` : first + (value.includes("\n") ? " …" : "")
    return `<span class="t-str">"${escapeHtml(short)}"</span>`
  }
  return `<span class="t-ok">${escapeHtml(String(value))}</span>`
}

/** The tool result, unwrapped from JSON-RPC and MCP content blocks when present. */
function unwrapAgentPayload(data) {
  let value = data?.result ?? data
  const text = value?.content?.find?.((block) => block.type === "text")?.text
  if (typeof text === "string") {
    try {
      value = JSON.parse(text)
    } catch {
      value = text
    }
  } else if (value?.structuredContent) {
    value = value.structuredContent
  }
  return value
}

/** Splits highlighted markup into lines, closing and reopening spans across breaks. */
function streamLines(html) {
  const lines = []
  const open = []
  for (const raw of html.split("\n")) {
    const line = open.join("") + raw
    for (const tag of raw.match(/<\/?span[^>]*>/g) ?? []) {
      if (tag.startsWith("</")) open.pop()
      else open.push(tag)
    }
    lines.push(line + "</span>".repeat(open.length))
  }
  return lines.map((line, i) => `<span class="tl" style="--i:${i}">${line || " "}</span>`).join("\n")
}

async function agentBrief(slug, file) {
  try {
    const response = await fetch(`${SHOTS}/${slug}/${file}`)
    if (!response.ok) throw new Error(String(response.status))
    const payload = unwrapAgentPayload(await response.json())
    return typeof payload === "string" ? escapeHtml(payload.slice(0, 1800)) : highlightJson(payload)
  } catch {
    return null
  }
}

async function loadAgent(slug) {
  const code = $("[data-agent]")
  if (!code) return
  const close = $("[data-agent-close]")
  const setup = `<span class="t-dim"># Any MCP client works. Claude Code:</span>\n$ claude mcp add --transport http designlayer \\\n    http://127.0.0.1:5747/mcp\n`
  const call = `<span class="t-dim">› designlayer.wait_for_change()</span>`
  const done = `<span class="t-dim">› designlayer.resolve_change(</span><span class="t-str">"applied"</span><span class="t-dim">)</span>\n<span class="t-ok">✓</span> Resolved. Waiting for the next change…`
  const [first, last] = await Promise.all([agentBrief(slug, "agent.json"), close ? agentBrief(slug, "agent-close.json") : null])
  code.innerHTML = streamLines(`${setup}\n${call}\n${first ?? "This demo has no recorded handoff."}\n\n${done}`)
  if (close) close.innerHTML = last ? streamLines(`${call}\n${last}\n\n${done}`) : ""
  if (code.classList.contains("is-playing")) {
    code.classList.remove("is-playing")
    void code.offsetWidth
    code.classList.add("is-playing")
    return
  }
  onArrive(code.closest("figure") ?? code, () => {
    code.classList.add("is-playing")
    close?.classList.add("is-playing")
    for (const block of [code, close]) {
      const tail = block && $$(".tl", block).at(-1)
      if (!tail || reducedMotion.matches) continue
      const cursor = document.createElement("span")
      cursor.className = "cursor"
      cursor.setAttribute("aria-hidden", "true")
      tail.append(cursor)
    }
  })
}

/* ---------- Tab sets: scroll walks the tabs, and the tabs move the scroll ---------- */

// Each tab set sits in a pinned track where every tab owns an equal stretch of
// scroll: scrolling advances the tab, its shot and the pill, and the chosen
// tab fills as its stretch runs out. Choosing a tab scrolls to its stretch, so
// the scroll position and the selection never disagree. With reduced motion
// (or no track) they are plain tabs.
const switchers = []

function setupSwitchers() {
  for (const switcher of $$("[data-switcher]")) {
    const track = switcher.closest("[data-tabs]")
    const list = $('[role="tablist"]', switcher)
    const pill = $(".switcher-pill", switcher)
    const tabs = $$('[role="tab"]', switcher)
    const view = document.getElementById(tabs[0]?.getAttribute("aria-controls"))
    const shots = view ? $$(".frame-zoom > .shot", view) : []
    const collapse = view && $("[data-collapse]", view)
    // Design system: one camera across the tabs, from the whole editor to each
    // tab's panel, gliding over every boundary instead of backing out.
    const cams = shots.map((shot) => shot.dataset.cam?.split(" ").map(Number))
    const zoom = cams[0] && $(".frame-zoom", view)
    const aim = (p) => {
      const keys = [[0, [1, 800, 500]]]
      cams.forEach((cam, i) => keys.push([i + (i ? 0.15 : 0.2), cam], [i + 0.85, cam]))
      let k = 0
      while (k < keys.length - 2 && p > keys[k + 1][0]) k++
      const e = easeInOut(range(p, keys[k][0], keys[k + 1][0]))
      const [z, x, y] = keys[k][1].map((v, j) => lerp(v, keys[k + 1][1][j], e))
      const cx = clamp(x, 800 / z, 1600 - 800 / z)
      const cy = clamp(y, 500 / z, 1000 - 500 / z)
      zoom.style.setProperty("--s", z.toFixed(4))
      zoom.style.transform = `translate(${((z * (800 - cx)) / 16).toFixed(3)}%, ${((z * (500 - cy)) / 10).toFixed(3)}%) scale(${z.toFixed(4)})`
    }
    let index = 0
    track?.style.setProperty("--tabs", tabs.length)
    const scrolled = () => Boolean(track) && !reducedMotion.matches
    // A lead-in (data-lead, in vh) before the first tab: the hero's hand-off.
    const leadIn = () => ((Number(track?.dataset.lead) || 0) / 100) * window.innerHeight

    const placePill = (animate) => movePill(pill, tabs[index], animate)

    const select = (next, { focus = false } = {}) => {
      index = clamp(next, 0, tabs.length - 1)
      tabs.forEach((tab, i) => {
        tab.setAttribute("aria-selected", String(i === index))
        tab.tabIndex = i === index ? 0 : -1
        if (i !== index) tab.style.removeProperty("--fill")
      })
      view?.setAttribute("aria-labelledby", tabs[index].id)
      const warm = (shot) => {
        for (const img of shot ? (shot.tagName === "IMG" ? [shot] : $$("img", shot)) : []) if (img.loading === "lazy") img.loading = "eager"
      }
      shots.forEach((shot, i) => {
        if (i === index) warm(shot)
        if (!scrolled()) shot.style.setProperty("--t", shot.dataset.rest ?? "1")
        shot.classList.toggle("is-active", i === index)
        if (i === index) shot.removeAttribute("aria-hidden")
        else shot.setAttribute("aria-hidden", "true")
      })
      // Warm the next shot so a crossfade never waits on the network.
      warm(shots[index + 1])
      if (focus) tabs[index].focus({ preventScroll: true })
      placePill(true)
      // When the page scroll drives the tabs, slide() keeps the tab in view.
      if (!scrolled()) {
        centerTab(tabs[index])
        if (zoom) aim(index + 0.5)
      }
    }

    /** Selects a tab; on a scroll-driven set, by scrolling to its stretch. */
    const choose = (next, options) => {
      const target = clamp(next, 0, tabs.length - 1)
      select(target, options)
      if (!scrolled()) return
      scrollTrack(track, (target + 0.04) / tabs.length, leadIn())
    }

    tabKeys(tabs, () => index, choose)

    // A row too wide for the screen scrolls sideways. It follows the page
    // scroll: as a tab's stretch runs out, the row slides the next one in.
    const center = (tab) => tab.offsetLeft + tab.offsetWidth / 2
    const slide = (fill) => {
      if (!list || list.scrollWidth <= list.clientWidth + 1) return
      const from = center(tabs[index])
      const to = center(tabs[Math.min(index + 1, tabs.length - 1)])
      list.scrollLeft = from + (to - from) * easeInOut(range(fill, 0.55, 1)) - list.clientWidth / 2
    }
    // Fade only the edges that have more tabs past them.
    const fade = () => {
      if (!list) return
      const max = list.scrollWidth - list.clientWidth
      list.style.setProperty("--fade-l", list.scrollLeft > 1 ? "24px" : "0px")
      list.style.setProperty("--fade-r", list.scrollLeft < max - 1 ? "24px" : "0px")
    }
    list?.addEventListener("scroll", fade, { passive: true })
    window.addEventListener("resize", fade)
    fade()

    if (track) {
      addScene(track, (rect, vh) => {
        const lead = leadIn()
        const p = clamp((-rect.top - lead) / Math.max(1, rect.height - vh - lead)) * tabs.length
        const next = Math.min(tabs.length - 1, Math.floor(p))
        if (next !== index) select(next)
        const fill = clamp(p - index)
        if (zoom) aim(p)
        tabs[index].style.setProperty("--fill", fill.toFixed(3))
        shots[index]?.style.setProperty("--t", fill.toFixed(3))
        shots[index]?.typeEdit?.(fill)
        if (scrolled()) slide(fill)
        // Hide: the panels slide away and stay away, leaving the round button.
        if (collapse && shots[index] === collapse) {
          const out = easeInOut(range(fill, 0.1, 0.4))
          collapse.style.setProperty("--out", out.toFixed(3))
        }
      })
    }
    const mode = () => {
      switcher.classList.toggle("is-scrolling", scrolled())
      if (scrolled()) return
      for (const shot of shots) shot.style.setProperty("--t", shot.dataset.rest ?? "1")
      if (zoom) aim(index + 0.5)
    }
    mode()
    switchers.push({ placePill, mode })
    placePill(false)
  }
  window.addEventListener("resize", () => switchers.forEach((entry) => entry.placePill(false)))
  document.fonts?.ready.then(() => switchers.forEach((entry) => entry.placePill(false)))
}

/* ---------- Pointer light on frames ---------- */

function setupGlow() {
  if (!finePointer.matches || reducedMotion.matches) return
  for (const frame of $$("[data-glow]")) {
    let pending = false
    let last = null
    frame.addEventListener("pointermove", (event) => {
      last = event
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        const rect = frame.getBoundingClientRect()
        frame.style.setProperty("--x", `${last.clientX - rect.left}px`)
        frame.style.setProperty("--y", `${last.clientY - rect.top}px`)
      })
    })
    frame.addEventListener("pointerenter", () => frame.classList.add("is-lit"))
    frame.addEventListener("pointerleave", () => frame.classList.remove("is-lit"))
  }
}

/* ---------- The film ---------- */

async function setupFilm() {
  const dialog = $("[data-film]")
  const opener = $("[data-film-open]")
  if (!dialog || !opener) return
  const video = $("[data-film-video]", dialog)
  const source = $("source", video)
  try {
    const response = await fetch(source.getAttribute("src"), { method: "HEAD" })
    if (!response.ok) throw new Error(String(response.status))
  } catch {
    opener.hidden = true // no film published yet: offer nothing rather than a broken player
    return
  }
  opener.addEventListener("click", () => {
    dialog.showModal()
    video.currentTime = 0
    video.play().catch(() => {})
  })
  const close = () => dialog.close()
  $("[data-film-close]", dialog).addEventListener("click", close)
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close()
  })
  dialog.addEventListener("close", () => video.pause())
}

/* ---------- Copy buttons ---------- */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement("textarea")
    area.value = text
    area.setAttribute("readonly", "")
    area.style.cssText = "position:fixed;opacity:0;pointer-events:none"
    document.body.append(area)
    area.select()
    const ok = document.execCommand("copy")
    area.remove()
    return ok
  }
}

function setupCopy() {
  for (const button of $$("[data-copy]")) {
    const label = button.getAttribute("aria-label")
    let reset = 0
    button.addEventListener("click", async () => {
      const code = button.closest("[data-copy-root]")?.querySelector("code")
      if (!code && !button.dataset.copyText) return
      // Comment lines are for reading, not for pasting into a shell.
      const text = button.dataset.copyText ?? code.textContent.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n").trim()
      if (!(await copyText(text))) return
      button.classList.add("is-copied")
      button.setAttribute("aria-label", "Copied")
      clearTimeout(reset)
      reset = setTimeout(() => {
        button.classList.remove("is-copied")
        button.setAttribute("aria-label", label)
      }, 1600)
    })
  }
}

/* ---------- The star count beside GitHub in the nav, when GitHub answers ---------- */

async function loadRepo() {
  let repo
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}`, { headers: { Accept: "application/vnd.github+json" } })
    if (!response.ok) return
    repo = await response.json()
  } catch {
    return
  }
  // A new project's zero is true but says nothing; show the count once it does.
  const stars = $("[data-stars]")
  if (!stars || !Number.isFinite(repo.stargazers_count) || repo.stargazers_count <= 0) return
  stars.textContent = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(repo.stargazers_count)
  stars.hidden = false
}

/* ---------- Start ---------- */

function measureAll() {
  hero?.measure()
  comment?.measure()
  canvas?.measure()
  for (const entry of headings) entry.measure()
  requestTick()
}

function onMotionPreference() {
  for (const entry of switchers) entry.mode()
  if (reducedMotion.matches) {
    hero?.reset()
    comment?.reset()
    canvas?.reset()
    $("[data-collapse]")?.style.removeProperty("--out")
    for (const entry of headings) for (const mark of entry.marks) {
      mark.word.style.removeProperty("--lit")
      mark.lit = -1
    }
  }
  measureAll()
}

window.addEventListener("scroll", requestTick, { passive: true })
window.addEventListener("resize", measureAll)
reducedMotion.addEventListener("change", onMotionPreference)
document.fonts?.ready.then(measureAll)

setupToolbars()
setupShotSpaces()
setupHeadings()
setupTypeEdit()
setupToken()
setupTweak()
setupArrivals()
setupSwitchers()
setupGlow()
setupCopy()
setupFilm()
measureAll()
if (reducedMotion.matches) comment?.reset()
loadDemos()
loadRepo()
hero?.playIntro()
// Blinds behind the hero's mockup and in the footer: WebGL, so loaded on their
// own. If they fail, .no-webgl puts back the CSS glow they replace.
import("./backgrounds.js")
  .then((mod) => mod.mountBackgrounds(reducedMotion))
  .catch((error) => {
    document.documentElement.classList.add("no-webgl")
    console.warn("Backgrounds off:", error)
  })
tourToolbar()
