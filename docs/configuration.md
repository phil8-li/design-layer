# Configuration

Optional. With no config file the tool runs against generic defaults for a
stock Next.js + Tailwind + shadcn/ui app. It does not look for Leva,
Agentation, or any host dev panel unless the host opts in.

Copy `designlayer/designlayer.config.example.mjs` to
`designlayer.config.mjs` in your project root and delete everything you do
not need. The file is discovered by walking up from the working directory, and
all its paths resolve against the directory holding it.

The settings most likely to matter:

- **`tailwind.version`** — on Tailwind v4, set `4` and
  `spacingScale: "v4-linear"`, or the editor writes arbitrary values for
  spacing tokens that do exist in your build.
- **`tailwind.breakpoints`** — the responsive prefixes the inspector offers;
  the default is Tailwind's `sm` through `2xl` scale.
- **`tailwind.containerBreakpoints`** — the separate container-query scale.
  It is empty by default because container variants are host-dependent.
- **`tailwind.colorWords`** — your palette stems, so `bg-brand-500` is written
  as a class rather than as an arbitrary colour.
- **`designSystem.manifest`** — the canonical token catalog displayed beside
  the selected element. Add `designSystem.cssSources` to map authored CSS and
  Tailwind aliases back to those tokens.
- **`icons`** — your icon set, so a selected `<svg>` names itself and the
  inspector can offer the other drawings as variants.
- **`source.roots`** — the directories the agent may edit.

## Design-system catalog

The optional catalog keeps the package generic while letting a host expose its
real token vocabulary in the inspector:

```js
designSystem: {
  manifest: "docs/design-tokens.json",
  cssSources: ["app/globals.css"],
},
```

The manifest may contain `Color`, `Spacing`, and `Radius` collections plus
`textStyles`, `uiTextStyles`, `effectStyles`, `iconScale`, and `motion` arrays.
Every one of them is optional. A design system with no motion tokens and no
text styles simply omits those keys; the axis resolves empty and the inspector
drops the row rather than drawing a picker with nothing in it. What the launcher
validates is the groups you did supply — a group that is present and the wrong
shape fails at startup with its field name, so a stale generated manifest is
caught, while a smaller design system is not mistaken for a broken one.

`designSystem.trackingUnit` — `"em"` or `"px"` — states the unit your text
styles express letter-spacing in. It is declared rather than inferred: `-0.5` is
a plausible em and a plausible px, and guessing by magnitude makes a text style
stop matching the moment a host writes tracking the other way. A manifest may
carry its own `trackingUnit`; the config's value wins.

## A design system that is not a manifest

Some hosts keep tokens in a TypeScript module, a Style Dictionary build, or a
CMS. `designSystem.adapter` is the escape hatch — one function, called with
`{ projectRoot }`, returning the same token groups the manifest path produces:

```js
designSystem: {
  adapter: () => ({
    name: "Lattice",
    colors: Object.entries(palette).map(([name, light]) => ({
      id: `color:${name}`, name, category: "color",
      cssVar: `--lattice-${name}`, values: { light },
    })),
  }),
  cssSources: ["app/globals.css"],
},
```

Everything downstream — alias resolution, the pickers, the inspector rows — is
identical, because the adapter produces the catalog rather than a second kind of
catalog. `manifest` and `adapter` are mutually exclusive; supplying both is
refused at startup instead of silently ranked.

## A design system behind a sign-in

Point the panel at an internal component catalog — a Storybook on your company's
network, a token file behind SSO — and the editor will hit the same wall a
stranger would. It fetches that link from its own process on your machine, which
holds none of the sessions your browser holds, so a site you can open in the
next tab is still closed to it.

You are not asked for a token, and on the walls this was built for you could not
supply one anyway: on an SSO proxy of this shape, every cookie in the exchange
is `HttpOnly` and `document.cookie` on that page returns nothing at
all. So the editor opens **that site's own sign-in** in a browser window, you
sign in the way you always do, and the session it produces is picked up for you:

1. Paste the link. The add is refused and the panel says which site is private.
2. Press **Sign in with Okta** — or whichever provider the site redirects to;
   the button is named from the redirect rather than guessed.
3. Finish in the window that opens. It closes itself and the add is replayed.

The session is verified against the link before it is stored, so the panel can
never claim you are signed in to a site whose libraries still fail. It is
remembered in a browser profile under the editor's state directory, which means
the next library behind the same sign-on needs no window at all — the editor
retries silently first and only asks when the provider does.

`Forget` on a signed-in row drops both halves: the credential the editor holds
and that origin's session inside the profile, so the next sign-in genuinely
asks.

If a site cannot be opened that way, **I have an access token** is still there,
folded away, with the OAuth client id the refusal carried.

## What a stylesheet library contributes

A library read from CSS — a file in your project, or the stylesheets a pasted
link serves — sorts each declaration by what it is for. Names are split into
words the same way whether they are kebab-case, camelCase (`--fontSizeBody`) or
use doubled hyphens (`--x--spacer--md`), and a stylesheet that `@import`s its
parts is read with them.

- **Text styles** come from size-and-leading families (`--text-lg` with
  `--text-lg--line-height`, or `--body-font-size` with `--body-line-height`) and
  from type-role classes: a single plain class that sets a fixed `font-size`, a
  `line-height`, and nothing but type (`.x-body-m { … }`). The role can sit
  before, after or between the type words (`--font-size-body`,
  `--text-body-size`). A class style also carries its font family, italic and
  variation settings, so picking it applies the whole role.
- **Icon sizes** include an icon font's scale. A family named for an icon
  (`--x-icon-scale-m-font-size`) is an icon size, not a text style.
- **Colors** include bare channels such as `--primary: 220 90% 56%`, which a
  pick writes wrapped: `hsl(var(--primary))`.
- **Spacing** leaves out lengths that are not spacing: letter-spacing, line
  heights, blur radii, border, outline and stroke widths, element widths and
  heights, and container or breakpoint widths. A scale derived with `calc()`,
  such as `calc(var(--radius) - 4px)`, is read through to its numbers. Padding
  and gap pickers leave out negative steps.
- **Shadows** are whole shadows. A shadow's offset, blur or color on its own is
  left out.
- **Motion** includes any duration (`--x-fast: 150ms`). Delays are left out.

Values come from the theme a page gets by default. What the stylesheet declares
unconditionally wins. A themed block — high contrast, print, or a theme switched
by class (`.theme-ocean`) — only adds names the default never declares, and the
first such block to declare a name wins, unless a later one names itself the
default (`default`, `medium`, `100%`). Dark blocks supply each color's dark
value.

A pick writes the variable, not its value. When the page does not declare that
variable — a library the app never loads — the write carries the value as a
fallback, `var(--radius-3, 16px)`, so the element changes straight away.

A library added from a link keeps a copy of what it read. When an update changes
how stylesheets are read, an enabled link library is read again the first time
the libraries are listed, and the panel waits a few seconds for it. Pasting the
same link again re-reads it at any time.

## Tailwind aliases, v4 and v3

On Tailwind v4 the theme lives in the stylesheet, so the editor reads
`@theme` custom properties and traces them back to tokens.
`tailwind.themeNamespaces` says which namespaces your app declares; the default
is Tailwind's own `color`, `radius`, `text`, and `shadow`. Extend it for
anything else you compile, and note that a longer name wins over a shorter
prefix — listing `"text-shadow"` keeps `--text-shadow-lift` out of the
typography axis.

On Tailwind v3 there is no theme block to read, so point the editor at the
config file, or hand it the scale directly:

```js
designSystem: {
  tailwindConfig: "tailwind.config.js",   // or
  tailwindTheme: { color: { ink: "var(--ink)" }, radius: { card: "6px" } },
},
```

`colors`, `borderRadius`, `fontSize`, and `boxShadow` map onto the catalog's
colour, radius, text, and shadow axes. A scale entry may be a `var()`, which is
traced like a v4 alias, or a literal, which is matched against the token's own
value — so `brand: "#0b7285"` still resolves to the token that holds that
colour. Without either key a v3 host resolves no Tailwind aliases at all.

## Host icon set

Separate from `designSystem.iconScale`, which is the icon *size* scale. This is
the drawing data, and it turns a selected `<svg>` into a layer with a name and a
list of alternatives:

```js
icons: {
  attribute: "data-acme-icon",
  data: "src/components/icons/acme-icon-data.json",
},
```

`attribute` is the DOM attribute your icon factory stamps each glyph with — that
is how a selection names itself. `data` is a JSON map of name to
`{ nodes: [[tag, attrs, children?]], rootFill, rootStroke? }`, the shape a React
icon factory already stores, so a host points at the file its components render
and writes no adapter. Both halves or neither: an attribute with no data names
icons the picker cannot offer, and data with no attribute cannot be matched to a
selection. Leave the block out and the inspector's icon section never renders.

The set is served on request by `GET {apiPrefix}/icons` rather than shipped in
the browser prelude, because it is path data measured in hundreds of kilobytes
and most sessions never open the panel. Only the attribute and a boolean cross
into the browser at load.

A swap redraws the glyph in place and says "preview only" every time: the source
writer speaks in classes and text, and the JSX still names the component it
always did. Width, height, and class are left alone — size and colour belong to
the call site that placed the icon, not to the drawing.

## Responsive metadata

Two facts, deliberately kept apart. `tailwind.breakpoints` says which variant
prefixes your build **compiles**; the optional `designSystem.breakpoints` says
which of those steps your design system has a **meaning** for:

```js
tailwind: {
  breakpoints: { sm: 640, md: 768, lg: 1024 },
  containerBreakpoints: { md: 448, lg: 512, xl: 576 },
},
designSystem: {
  breakpoints: {
    md: { usage: "Sheet: the nav stops docking and floats over the canvas.",
          owner: "src/hooks/use-mobile.ts" },
  },
  containerBreakpoints: {
    xl: { usage: "Cards: switch to two columns.", owner: "src/cards.tsx" },
  },
  responsiveMeasures: {
    contentFits: {
      formula: "viewport - navigation >= 720px",
      usage: "Whether the reading column keeps its minimum measure.",
      owner: "src/layout.ts",
    },
  },
},
```

Viewport and container pixels keep separate owners in `tailwind.breakpoints`
and `tailwind.containerBreakpoints`; annotations may only add prose. Naming a
step its corresponding map does not define fails at startup. A prefix you leave
unannotated still appears in the inspector because it compiles, but it is marked
as outside the design system rather than presented as a decision someone made.
Responsive measures are read-only metadata: they describe product layout rules
that cannot be represented honestly as one editable CSS declaration.

CSS sources are scanned for custom-property chains and Tailwind `@theme`
aliases. Resolution stops at a manifest-owned custom property: for example,
`--color-background` may point through `--background` to
`--sem-background-primary`. Conflicting declarations are retained as ambiguous
aliases rather than assigned to one token. Only the normalized catalog enters
the browser prelude; manifest and stylesheet paths remain server-side.

## Dev chrome

If your app renders a dev-only GUI, list its selectors in
`chrome.trustedSelectors` so the editor treats it as furniture rather than as
something you meant to restyle. `chrome.dockedPanel` goes one step further and
keeps the editor's inspector beside that panel instead of on top of it: the
editor publishes the panel's width and its own offset as two CSS variables, and
your stylesheet reads them to make room.

```css
/* only if you set chrome.dockedPanel */
.my-dev-panel {
  right: calc(var(--designlayer-dev-panel-offset, 0px) + 1rem);
}
```

Both variable names are configurable. Leave the whole `chrome` block out if you
have no dev GUI — an empty selector list is legal and correct.

## Companions

A companion is somebody else's dev-time browser tooling, loaded onto the page
beside the editor rather than instead of it — an annotation toolbar, a
feature-flag switcher, a locale picker. The editor injects one script into every
page it proxies, and a companion rides in on that injection, so nothing dev-only
has to be added to an app that ships.

It is declared as a bundle plus the selectors that bundle draws under. The
second half is what makes it usable: the canvas treats everything it did not
draw as the app, so without them a click on a companion's button selects the
button instead of pressing it. The selectors join `chrome.trustedSelectors`.

```js
// designlayer.config.mjs
companions: ["./tools/flag-switcher/companion.json"],
```

```json
{
  "name": "flag-switcher",
  "script": "./flag-switcher.js",
  "trustedSelectors": ["[data-flag-switcher]"]
}
```

The script must be a self-contained browser bundle — an IIFE, no imports, no
exports. Paths inside a manifest are read against the manifest, so a companion
and its bundle travel together. A bare `.js` path is also accepted, for a
companion with no chrome of its own to declare. A declared companion that is not
there fails at startup rather than launching an editor silently missing it.

`DESIGNLAYER_COMPANIONS` names the same manifests for the whole machine, in a
list separated by `:` or `,`. That is the lane for tooling that belongs to the
person rather than to the project — one annotation toolbar wired into every app
they open, with nothing added to any of their repositories.

Bundles are concatenated after the editor's own, each fenced, so a companion
that throws on evaluation costs itself and nothing else.

A companion whose gesture is clicking the app — an annotation toolbar is the
obvious one — has to say so, because `inspecting` mode is exactly what swallows
that click. `window.__DESIGNLAYER__.claimPointer(name)` holds the editor in
`interactive` for as long as the claim is held and returns the release:

```js
const release = window.__DESIGNLAYER__?.claimPointer?.("flag-switcher")
// …later, when your tool disarms
release?.()
```

Look the API up at claim time rather than at load: companion bundles evaluate
before the editor has finished booting.

The user still outranks a claim — pressing Inspect while one is held puts the
editor back. A companion has to disarm itself when that happens, or both tools
answer the same click and one gesture does two things: measured on a real page,
a single click both selected a `<span>` into the inspector and opened an
annotation box on it. `onModeChange` is how a companion finds out.

```js
window.__DESIGNLAYER__?.onModeChange?.((mode) => {
  if (mode !== "interactive") disarmMyTool()
})
```

Between the two, the editor's mode is the single switch on the page, and both
tools end up on the correct side of it whichever one the person reached for.

A companion that paints over the editor needs a z-index above `.de-root`
(2147483000) and above the surfaces the editor raises over itself: the note
layer at 2147483100, the pickers and menus through 2147483300, and the toast at
2147483646. Going to the very top is only safe if your full-viewport layers are
`pointer-events: none` — one that takes the pointer up there puts an invisible
sheet over the editor and the app both.

A companion that sits *beside* the chrome rather than over it usually ends up
depending on two things this repository owns: the `--de-*` custom properties
that say where the panels are, and `.de-root`'s z-index, which anything drawing
above the panels has to clear. Both are a real contract, and neither is
enforceable from here — a companion built from its own source under
`~/.local/share/designlayer/companions/` is invisible to any search of this
repository. Renaming the `de-` prefix or restacking `.de-root` therefore means
editing each companion's source and rebuilding it in the same change. Both
values carry that warning at their definitions in `src/core/css/base.ts`.

## Contextual controls and source defaults

Leva integration is optional and explicit. Configure `controls.leva.storeGlobal`
to inventory the live controls. A binding connects a path pattern to the DOM
elements it affects; first match wins, `*` matches one path segment, and `**`
matches any suffix. The editor never infers relationships from names.

```js
controls: {
  leva: {
    storeGlobal: "__STORE",
    sourceDefaults: {
      file: "src/design-defaults.ts",
      exportName: "DESIGN_DEFAULTS",
    },
    bindings: [{
      pathPattern: "Cards.Spacing.*",
      selectors: ["[data-card]"],
      relationship: "spacing within",
      defaultGroup: "Card spacing",
    }],
  },
}
```

`sourceDefaults` must name an exported object literal. Its groups must also be
object literals, and editable values must be string, finite-number, boolean, or
null literals. Dynamic expressions and files outside `source.roots` are refused.
Writes replace only the target literal; unrelated comments and formatting stay
untouched.

Activating “Show affected” dispatches
`designlayer:highlight-elements` on `window`. The event detail is
`{ path, relationship, selectors, elements }`; a canvas integration may draw
those elements without coupling the options inventory to canvas state.
