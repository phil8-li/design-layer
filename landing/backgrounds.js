// WebGL backgrounds: gradient blinds under the hero's mockup and again in the
// footer. A port of React Bits' GradientBlinds (https://reactbits.dev, © 2026
// David Haz), lit in the hero by the average light of its LightRays. This
// file stays under their license, MIT + Commons Clause, in
// backgrounds.LICENSE.txt, not the repo's MIT. Same shaders on bare WebGL
// instead of React and OGL, keeping only the options the page uses.
//
// Each canvas draws only while it is on screen; reduced motion gets one still
// frame. Without WebGL, <html> gets .no-webgl and CSS keeps the old glows.

/** The grain of the hero's CSS glow (--grain), the fallback without WebGL. */
export const NOISE = 0.3

const MAX_DPR = 2

// reactbits.dev/backgrounds/gradient-blinds?noise=0.42 in the site's indigo,
// --accent to --accent-fill. Away from the light the original goes black;
// these keep a glow along the bottom, `floor` of full at the edge and gone
// `glow` of the way up, so the blinds run to the bottom of the page.
const BLINDS = { colors: ["#798cff", "#4a5df9"], angle: 20, noise: 0.42, count: 16, minWidth: 60, radius: 0.5, softness: 1, floor: 0.5, glow: 0.6, dampening: 0.15 }

// The same blinds as the hero's background, lit from above the top center as
// LightRays' two rays light on average (reactbits.dev/backgrounds/light-rays,
// spread 0.5, length 3, fade 1.3): `strength` of full where that light is as
// bright as `peak`, never under `floor` of that.
const HERO_BLINDS = { strength: 0.2, peak: 0.5, floor: 0.5 }

const VERTEX = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`

// GradientBlinds' stripes, for both blinds shaders: uCount of them at uAngle,
// across a gradient from uColor0 to uColor1, with `noise` of grain. Uses the
// shader's uTime and uResolution.
const BLINDS_GLSL = `
uniform float uAngle, uCount;
uniform vec3 uColor0, uColor1;

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 blindsColor(vec2 uv0, float noise) {
  float aspect = uResolution.x / uResolution.y;
  vec2 p = uv0 * 2.0 - 1.0;
  p.x *= aspect;
  p = mat2(cos(uAngle), -sin(uAngle), sin(uAngle), cos(uAngle)) * p;
  float t = p.x / aspect * 0.5 + 0.5;
  vec3 base = mix(uColor0, uColor1, clamp(t, 0.0, 1.0));
  float stripe = fract(t * uCount);
  float edge = clamp(uCount * 1.25 / min(uResolution.x, uResolution.y), 0.001, 0.12);
  stripe = mix(stripe, 0.5, 1.0 - smoothstep(0.0, edge, min(stripe, 1.0 - stripe)));
  return base - stripe + (rand(gl_FragCoord.xy + uTime) - 0.5) * noise;
}`

const HERO_BLINDS_FRAGMENT = `
uniform float uTime, uNoise, uStrength, uPeak, uFloor, uScale;
uniform vec2 uResolution, uOrigin;
${BLINDS_GLSL}

// LightRays' falloff with each ray's flicker at its mean: brightest straight
// below uOrigin, narrowing with the angle and fading with distance.
float light(vec2 coord) {
  vec2 toCoord = coord - uOrigin;
  float dist = length(toCoord);
  float spread = pow(max(normalize(toCoord).y, 0.0), 2.0);
  return 0.675 * clamp(1.0 - dist / (3.0 * uScale), 0.0, 1.0) * clamp(1.0 - dist / (1.3 * uScale), 0.5, 1.0) * spread;
}

void main() {
  float lit = mix(uFloor, 1.0, min(light(vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y)) / uPeak, 1.0));
  vec3 color = max(blindsColor(gl_FragCoord.xy / uResolution, uNoise), 0.0) * uStrength * lit;
  gl_FragColor = vec4(color, max(color.r, max(color.g, color.b)));
}`

const BLINDS_FRAGMENT = `
uniform float uTime, uNoise, uRadius, uSoftness, uFloor, uGlow;
uniform vec2 uResolution, uMouse;
${BLINDS_GLSL}

void main() {
  vec2 uv0 = gl_FragCoord.xy / uResolution;
  float spot = 1.0 - 2.0 * pow(length(uv0 - uMouse) / max(uRadius, 1e-4), uSoftness);
  vec3 blinds = blindsColor(uv0, uNoise);
  // The light adds as in the original. Its dark side dims the blinds instead of
  // subtracting, which would turn them pure blue, then black, and never below
  // a glow along the bottom: uFloor of full at the edge, gone by uGlow up.
  float glow = uFloor * (1.0 - smoothstep(0.0, uGlow, uv0.y));
  vec3 color = clamp(spot > 0.0 ? blinds + spot : blinds * max(1.0 + spot, glow), 0.0, 1.0);
  // The original draws opaque and relies on mix-blend-mode: lighten. Over the
  // page's near-black, alpha from brightness lands on the same colours without
  // depending on which stacking context the canvas ends up in.
  gl_FragColor = vec4(color, max(color.r, max(color.g, color.b)));
}`

/**
 * Draws `fragment` on a canvas filling `host`, every frame while the host is on
 * screen. `init` sets the fixed uniforms, `resize` those that follow the canvas
 * size (or the size of anything in `watch`), `frame` the rest before each draw.
 * Returns null without WebGL.
 */
function mountShader(host, reducedMotion, { fragment, premultiplied, init, resize, frame, watch = [] }) {
  const canvas = document.createElement("canvas")
  const gl = canvas.getContext("webgl", { premultipliedAlpha: premultiplied, antialias: false, depth: false, stencil: false })
  if (!gl) return null
  let program = null
  let uniforms = {}
  const set = (name, ...values) => {
    uniforms[name] ??= gl.getUniformLocation(program, name)
    gl[`uniform${values.length}f`](uniforms[name], ...values)
  }

  function build() {
    program = gl.createProgram()
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, `precision highp float;\n${fragment}`]]) {
      const shader = gl.createShader(type)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      gl.attachShader(program, shader)
    }
    gl.bindAttribLocation(program, 0, "position")
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "shader did not link")
    gl.useProgram(program)
    // One triangle that covers the whole canvas.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    uniforms = {}
    init(set)
  }

  let visible = false
  let raf = 0
  let last = 0

  function draw(now = performance.now()) {
    frame(set, now / 1000, last ? Math.min((now - last) / 1000, 0.1) : 0)
    last = now
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    host.classList.add("is-on")
  }

  function loop(now) {
    raf = 0
    draw(now)
    if (visible && !reducedMotion.matches) raf = requestAnimationFrame(loop)
  }

  function start() {
    if (!raf) raf = requestAnimationFrame(loop)
  }

  function fit() {
    const rect = host.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
    canvas.width = Math.max(1, Math.round(rect.width * dpr))
    canvas.height = Math.max(1, Math.round(rect.height * dpr))
    gl.viewport(0, 0, canvas.width, canvas.height)
    set("uResolution", canvas.width, canvas.height)
    resize?.(set, canvas.width, canvas.height, rect)
    draw()
  }

  build()
  host.append(canvas)
  canvas.addEventListener("webglcontextlost", (event) => event.preventDefault())
  canvas.addEventListener("webglcontextrestored", () => {
    build()
    fit()
  })
  const sizes = new ResizeObserver(fit)
  for (const element of [host, ...watch]) sizes.observe(element)
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    last = 0
    if (visible) start()
  }).observe(host)
  reducedMotion.addEventListener("change", start)
  return {
    draw,
    get visible() {
      return visible
    },
  }
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)

// The blinds' two colours. The footer's inspector retints them, and the rest
// of the page's accent, with an "accent" event carrying two hex colours.
let tint = BLINDS.colors.map(rgb)
const views = []
addEventListener("accent", (event) => {
  tint = event.detail.map(rgb)
  for (const view of views) view.draw()
})

/** Sets BLINDS_GLSL's colours and angle. */
function initBlinds(set) {
  paintBlinds(set)
  set("uAngle", (BLINDS.angle * Math.PI) / 180)
}

function paintBlinds(set) {
  set("uColor0", ...tint[0])
  set("uColor1", ...tint[1])
}

/** Blinds across `width` CSS px: fewer on narrow screens, none under 60px wide. */
const blindCount = (width) => Math.max(1, Math.min(BLINDS.count, Math.floor(width / BLINDS.minWidth)))

/** The hero's background: blinds under the mockup, lit from above. */
function heroBlinds(host, reducedMotion) {
  return mountShader(host, reducedMotion, {
    fragment: HERO_BLINDS_FRAGMENT,
    premultiplied: true,
    init(set) {
      initBlinds(set)
      set("uNoise", BLINDS.noise)
      set("uStrength", HERO_BLINDS.strength)
      set("uPeak", HERO_BLINDS.peak)
      set("uFloor", HERO_BLINDS.floor)
    },
    resize(set, width, height, rect) {
      // The light sits 20% of the height above the canvas. LightRays measures
      // its reach in canvas widths, which leaves a stub on a phone; the longer
      // of the width and 1.5 heights reaches as far down a portrait screen.
      set("uOrigin", width / 2, -0.2 * height)
      set("uScale", Math.max(width, 1.5 * height))
      set("uCount", blindCount(rect.width))
    },
    frame(set, time) {
      paintBlinds(set)
      set("uTime", time)
    },
  })
}

/**
 * Gradient blinds lit by a spotlight that follows the pointer across `host`'s
 * parent. The spotlight stays high enough above `[data-blinds-text]`, the small
 * print at the bottom, to fade to the floor before it, so the print keeps its
 * contrast wherever the pointer goes.
 */
function gradientBlinds(host, reducedMotion) {
  const text = host.parentElement.querySelector("[data-blinds-text]")
  // How far the light reaches before it is down to the floor, in canvas heights.
  const reach = BLINDS.radius * ((2 - BLINDS.floor) / 2) ** (1 / BLINDS.softness)
  let lowest = 0 // canvas fraction, y up
  const target = { x: 0.5, y: 0.5 } // canvas fractions, y up
  const spot = { ...target }
  const view = mountShader(host, reducedMotion, {
    fragment: BLINDS_FRAGMENT,
    premultiplied: true,
    watch: text ? [text] : [],
    init(set) {
      initBlinds(set)
      set("uNoise", BLINDS.noise)
      set("uRadius", BLINDS.radius)
      set("uSoftness", BLINDS.softness)
      set("uFloor", BLINDS.floor)
      set("uGlow", BLINDS.glow)
    },
    resize(set, width, height, rect) {
      set("uCount", blindCount(rect.width))
      lowest = text ? Math.min(1, (rect.bottom - text.getBoundingClientRect().top) / rect.height + reach) : 0
      target.y = Math.max(target.y, lowest)
      spot.y = Math.max(spot.y, lowest)
    },
    frame(set, time, dt) {
      if (!reducedMotion.matches) {
        const k = 1 - Math.exp(-dt / BLINDS.dampening)
        spot.x += (target.x - spot.x) * k
        spot.y += (target.y - spot.y) * k
      }
      paintBlinds(set)
      set("uTime", time)
      set("uMouse", spot.x, spot.y)
    },
  })
  // The parent, not the canvas: in the footer the pointer is over the name and
  // the links, which sit on top of the blinds.
  host.parentElement.addEventListener("pointermove", (event) => {
    if (!view?.visible) return
    const rect = host.getBoundingClientRect()
    target.x = (event.clientX - rect.left) / rect.width
    target.y = Math.max(1 - (event.clientY - rect.top) / rect.height, lowest)
    if (!reducedMotion.matches) return
    Object.assign(spot, target)
    view.draw()
  })
  return view
}

/**
 * Grain as a tile for the hero's CSS glow to mask with: alpha
 * 1 - NOISE + NOISE * random, one texel per device pixel. Published as
 * --grain on <html>.
 */
function grain(tile = 256) {
  const size = Math.round(tile * Math.min(window.devicePixelRatio || 1, MAX_DPR))
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = size
  const context = canvas.getContext("2d")
  const image = context.createImageData(size, size)
  for (let i = 0; i < image.data.length; i += 4) {
    image.data.fill(255, i, i + 3)
    image.data[i + 3] = 255 * (1 - NOISE + NOISE * Math.random())
  }
  context.putImageData(image, 0, 0)
  canvas.toBlob((blob) => blob && document.documentElement.style.setProperty("--grain", `url(${URL.createObjectURL(blob)})`))
}

/** Mounts the backgrounds the page has, and the grain for its CSS glow. */
export function mountBackgrounds(reducedMotion) {
  grain()
  for (const [selector, mount] of [["[data-hero-blinds]", heroBlinds], ["[data-blinds]", gradientBlinds]]) {
    const host = document.querySelector(selector)
    const view = host && mount(host, reducedMotion)
    if (view) views.push(view)
    else if (host) document.documentElement.classList.add("no-webgl")
  }
}
