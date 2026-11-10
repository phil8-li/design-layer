/**
 * A token file read as a design system: a DTCG or Style Dictionary tree of
 * `$value` leaves, a Figma variables export, or plain nested JSON whose leaves
 * are colours, lengths and durations.
 *
 * The leaves are sorted into axes by the classifier the stylesheet reader
 * uses (`library-classify.mjs`) and validated by the same rules
 * (`library-values.mjs`), so a token served as JSON and the same token served
 * as CSS land in the same picker with the same value.
 */

import { isPlainObject, tokenId } from "./library-common.mjs"
import { emptyCatalog, isEmptyCatalog } from "./library-catalog.mjs"
import { DARK_SELECTOR, classifyName, classifyValue, colorOverRefusal } from "./library-classify.mjs"
import {
  MAX_ALIAS_DEPTH,
  leadingPx,
  paintableColor,
  readTracking,
  singleLength,
  tokenValues,
  trackingIn,
  weightNumber,
} from "./library-values.mjs"

/**
 * A guard on a file nobody in this process wrote, not a product limit. Checked
 * before every leaf is taken, not only on entering a group: a flat group of
 * twenty thousand leaves used to be read in full, and a URL catalog is written
 * into the pointer file verbatim.
 */
const MAX_TOKEN_LEAVES = 5000

/**
 * `$type` as the exporting tool spelled it, mapped onto this editor's axes.
 *
 * The keys are already normalized — lower-cased, letters only — so one entry
 * covers `borderRadius`, `border-radius` and `BORDERRADIUS`, which is three
 * house styles for one idea.
 *
 * The entries mapping to a null group are the load-bearing half. A type this
 * editor has no axis for is not the same as a type it has never heard of: a
 * line height is `1.5`, a letter spacing is `-0.01em` and an opacity is `0.6`,
 * and left unlisted every one of them falls through to the value sniffer and
 * lands in the SPACING picker as a plausible-looking step. Naming them here
 * spends one line each to say "recognised, and deliberately not offered" —
 * the same bargain the easing rule strikes in the CSS classifier.
 */
const TOKEN_TYPE_GROUPS = {
  color: { group: "colors", category: "color" },
  dimension: { group: "spacing", category: "spacing" },
  spacing: { group: "spacing", category: "spacing" },
  size: { group: "spacing", category: "spacing" },
  // A tool that keeps a separate sizing scale (Tokens Studio does) means the
  // same axis by it: a length a designer picks a width or a gap from.
  sizing: { group: "spacing", category: "spacing" },
  borderwidth: { group: "spacing", category: "spacing" },
  borderradius: { group: "radii", category: "radius" },
  radius: { group: "radii", category: "radius" },
  shadow: { group: "effects", category: "shadow" },
  boxshadow: { group: "effects", category: "shadow" },
  duration: { group: "motion", category: "motion" },
  typography: { group: "textStyles", category: "typography" },
  fontsize: { group: "textStyles", category: "typography" },
  fontsizes: { group: "textStyles", category: "typography" },
  lineheight: { group: null, category: null },
  lineheights: { group: null, category: null },
  letterspacing: { group: null, category: null },
  paragraphspacing: { group: null, category: null },
  fontweight: { group: null, category: null },
  fontweights: { group: null, category: null },
  fontfamily: { group: null, category: null },
  fontfamilies: { group: null, category: null },
  opacity: { group: null, category: null },
  cubicbezier: { group: null, category: null },
  textcase: { group: null, category: null },
  textdecoration: { group: null, category: null },
}

/**
 * The type a leaf inherits when it declares none of its own.
 *
 * The Design Tokens Format Module is explicit about this (§5.2.2): a token's
 * type comes from the closest ancestor group that declares one, and a tool
 * "MUST NOT attempt to guess the type of a token by inspecting the contents of
 * its value". Reading the leaf alone did exactly that guess, and the guess is
 * wrong in the same direction every time — a `borderRadius` group's `"4px"`
 * sniffed as spacing, a `duration` group's `"120ms"` and a `shadow` group's
 * composite sniffed as nothing at all and dropped. Group-level `$type` is how
 * every hand-written DTCG file avoids repeating itself, so this is not an
 * exotic spelling; it is the ordinary one.
 *
 * Only `$type` is inherited, never the bare `type` key. `type` at a GROUP level
 * is as likely to be somebody's token named `type` as it is a declaration, and
 * the older exporters that spell it without the dollar never inherited it
 * anyway.
 */
function tokenLeaves(node, path, leaves, inherited = "") {
  if (leaves.length >= MAX_TOKEN_LEAVES || !isPlainObject(node)) return
  const groupType = typeof node.$type === "string" ? node.$type : inherited
  for (const [key, value] of Object.entries(node)) {
    if (!isPlainObject(value)) continue
    if (leaves.length >= MAX_TOKEN_LEAVES) return
    const next = [...path, key]
    if (value.$value !== undefined || value.value !== undefined) {
      const raw = value.$value !== undefined ? value.$value : value.value
      leaves.push({
        path: next,
        // `{ "value": 4, "unit": "px" }` is the spec's object dimension, not a
        // Style Dictionary leaf whose value happens to be 4. The sibling `unit`
        // is the only thing that tells them apart, and reading `value` alone
        // turned a 4px step into a bare 4 with no complaint.
        value: typeof value.unit === "string" ? { value: raw, unit: value.unit } : raw,
        type:
          typeof value.$type === "string"
            ? value.$type
            : typeof value.type === "string"
              ? value.type
              : groupType,
      })
      continue
    }
    tokenLeaves(value, next, leaves, groupType)
  }
}

/**
 * Every string or number leaf in the tree, named by the path that reaches it.
 *
 * The lane above requires a `$value` or a `value` key, which is the DTCG and
 * Style Dictionary contract and is not how most JSON a designer has to hand is
 * written. A theme object exported from a component library, a theme
 * generator's JSON export, a Tailwind theme dumped to JSON, a palette
 * package's `colors.json` — all of them are plain nested objects whose leaves
 * are bare strings, and all of them read as zero tokens because every one of
 * those leaves was skipped outright.
 *
 * Reading them costs nothing in accuracy, because the classifier downstream is
 * the same one the CSS lane relies on and it refuses anything it cannot write.
 * A leaf that is not a colour, a length or a duration simply produces no token,
 * which is the same outcome as never having looked at it.
 *
 * `$`-prefixed keys are skipped because they are the file talking about itself —
 * `$schema`, and the `$themes`/`$metadata` blocks a token manager writes beside
 * its sets.
 */
function plainLeaves(node, path, leaves) {
  if (leaves.length >= MAX_TOKEN_LEAVES || !isPlainObject(node)) return
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) continue
    if (leaves.length >= MAX_TOKEN_LEAVES) return
    const next = [...path, key]
    if (typeof value === "string" || typeof value === "number") {
      leaves.push({ path: next, value, type: "" })
      continue
    }
    plainLeaves(value, next, leaves)
  }
}

/** 0–1 float RGBA, the only colour shape the Figma REST API emits, as hex. */
function figmaColorHex(value) {
  if (!isPlainObject(value)) return null
  const channel = (raw) => {
    const number = Number(raw)
    if (!Number.isFinite(number)) return null
    return Math.max(0, Math.min(255, Math.round(number * 255)))
  }
  const parts = [channel(value.r), channel(value.g), channel(value.b)]
  if (parts.some((part) => part === null)) return null
  const alpha = value.a === undefined ? 1 : Number(value.a)
  if (Number.isFinite(alpha) && alpha < 1) parts.push(channel(alpha))
  return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`
}

/**
 * `GET /v1/files/:key/variables/local`, read as tokens.
 *
 * This is the canonical machine-readable export of a design system held in
 * Figma — the file a designer gets when they ask for their variables rather
 * than for somebody's build output — and nothing else in this module could see
 * it, because a variable carries neither a `$value` nor a nested value: its
 * values live in `valuesByMode`, keyed by opaque mode ids, and its colours are
 * 0–1 floats rather than anything CSS would accept.
 *
 * The modes are what make this worth a branch of its own rather than a plain
 * walk. A collection's modes ARE the light and dark themes, named by whoever
 * built the file, so the pair a colour picker wants is already in the export
 * and only needs the default mode and the dark-named one picked out of it. With
 * no collection metadata to read, the first mode is taken and no dark value is
 * claimed — a guess about which of two unnamed modes is the dark one is exactly
 * the guess that puts a black swatch under a light label.
 */
export function figmaVariableLeaves(parsed) {
  const meta = isPlainObject(parsed) ? parsed.meta : null
  const variables = isPlainObject(meta) && isPlainObject(meta.variables) ? meta.variables : null
  if (!variables) return null

  const tiers = new Map()
  const collections = isPlainObject(meta.variableCollections) ? meta.variableCollections : {}
  for (const [id, collection] of Object.entries(collections)) {
    if (!isPlainObject(collection)) continue
    const modes = Array.isArray(collection.modes) ? collection.modes.filter(isPlainObject) : []
    const dark = modes.find((mode) => DARK_SELECTOR.test(String(mode.name ?? "").toLowerCase()))
    tiers.set(id, {
      light:
        typeof collection.defaultModeId === "string" ? collection.defaultModeId : modes[0]?.modeId,
      dark: dark ? dark.modeId : null,
    })
  }

  // An alias points at another variable and is read in the SAME mode, which is
  // what makes a semantic layer resolve to its own dark value rather than to
  // the primitive's default.
  const read = (variable, modeId, depth = 0) => {
    if (!isPlainObject(variable) || depth >= MAX_ALIAS_DEPTH) return undefined
    const byMode = isPlainObject(variable.valuesByMode) ? variable.valuesByMode : {}
    const chosen = modeId != null && modeId in byMode ? modeId : Object.keys(byMode)[0]
    if (chosen === undefined) return undefined
    const value = byMode[chosen]
    if (isPlainObject(value) && value.type === "VARIABLE_ALIAS") {
      return read(variables[value.id], modeId, depth + 1)
    }
    return value
  }

  const leaves = []
  for (const variable of Object.values(variables)) {
    if (leaves.length >= MAX_TOKEN_LEAVES) break
    if (!isPlainObject(variable) || typeof variable.name !== "string") continue
    const path = variable.name.split("/").map((part) => part.trim()).filter(Boolean)
    if (path.length === 0) continue
    const tier = tiers.get(variable.variableCollectionId) ?? {}
    const raw = read(variable, tier.light)
    const isColor = variable.resolvedType === "COLOR"
    const value = isColor ? figmaColorHex(raw) : raw
    if (value === null || value === undefined || typeof value === "boolean") continue
    if (isPlainObject(value)) continue
    const leaf = { path, value, type: isColor ? "color" : "" }
    if (isColor && tier.dark) {
      const dark = figmaColorHex(read(variable, tier.dark))
      if (dark && dark !== value) leaf.dark = dark
    }
    leaves.push(leaf)
  }
  return leaves.length ? leaves : null
}

/**
 * The object forms the current spec made normative, flattened back to the CSS
 * string every validator in this module reads.
 *
 * Every one of these is the 2024-onwards Design Tokens Format Module spelling
 * of something this editor already understood as a string, and collapsing a
 * non-string value to `""` dropped all of them: an object dimension, an object
 * colour, and the shadow composite — which is the whole of a system's elevation
 * scale, since nobody writes a box-shadow as one string once their tool offers
 * the parts.
 */
function tokenText(value) {
  if (typeof value === "number") return String(value)
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    // A layered shadow is a list of shadows and joins the way CSS joins them.
    // A list whose parts are not all readable is not a value at all, and says
    // so rather than contributing half of itself.
    const parts = value.map(tokenText)
    return parts.every(Boolean) ? parts.join(", ") : ""
  }
  if (!isPlainObject(value)) return ""
  if (value.value !== undefined && typeof value.unit === "string") {
    return `${tokenText(value.value)}${value.unit}`
  }
  if (typeof value.hex === "string") return value.hex
  if (typeof value.colorSpace === "string" && Array.isArray(value.components)) {
    const alpha = typeof value.alpha === "number" && value.alpha < 1 ? ` / ${value.alpha}` : ""
    return `color(${value.colorSpace} ${value.components.join(" ")}${alpha})`
  }
  if (value.offsetX !== undefined || value.offsetY !== undefined || value.blur !== undefined) {
    return [
      value.inset ? "inset" : "",
      tokenText(value.offsetX ?? "0"),
      tokenText(value.offsetY ?? "0"),
      tokenText(value.blur ?? "0"),
      tokenText(value.spread ?? ""),
      tokenText(value.color ?? ""),
    ]
      .filter(Boolean)
      .join(" ")
  }
  return ""
}

/**
 * A token path as the word segments `classifyName` compares against.
 *
 * A camel hump is a word boundary here, which a hyphen is in the CSS lane. JSON
 * keys are written `borderRadius` and `fontSize` where a custom property is
 * written `--border-radius` and `--font-size`, and a classifier that only knows
 * the second spelling reads `borderRadius` as one unrecognised word and files
 * the system's whole corner scale under spacing.
 */
function leafSegments(path) {
  return path
    .flatMap((part) =>
      String(part)
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
    )
    .filter(Boolean)
}

/**
 * Which axis a leaf belongs to: its declared type, then its name, then its
 * value.
 *
 * The middle step is the one that was missing. The CSS lane has always read the
 * name before the value, and skipping that step here meant every radius, icon
 * size and font size in an untyped file landed in the SPACING picker, because
 * by then all three are just a number with `px` on the end. The token's path is
 * the name — it is right there in `leaf.path` and it is exactly the segment
 * list the classifier wants — so the two lanes now sort a file the same way.
 */
function leafVerdict(leaf, text) {
  const type = String(leaf.type).toLowerCase().replace(/[^a-z]/g, "")
  const typed = TOKEN_TYPE_GROUPS[type]
  if (typed && GENERIC_LENGTH_TYPES.has(type)) {
    const named = classifyName(leafSegments(leaf.path))
    if (named && LENGTH_VERDICTS.has(named.group)) return named
  }
  if (typed) return typed
  const segments = leafSegments(leaf.path)
  return colorOverRefusal(classifyName(segments), segments.map((_, index) => index), text, null) ?? classifyValue(text)
}

/**
 * The declared types that say "a length" and nothing about which one.
 *
 * The format has no radius, icon-size or font-size type: a corner scale, an
 * icon scale and a type ramp are all `dimension`, and so are a line height and
 * a letter spacing. Taking that type as the whole answer filed every one of
 * them under spacing. The path still says which length it is, so for these
 * types the name decides between the length axes — and only between those: a
 * `dimension` under a `stroke` group is a stroke WIDTH, not a colour, so a
 * name verdict for any other axis is ignored and the type stands.
 */
const GENERIC_LENGTH_TYPES = new Set(["dimension", "size", "sizing"])
const LENGTH_VERDICTS = new Set(["spacing", "radii", "icons", "textStyles", null])

/**
 * `{color.brand.500}` — the reference syntax every exporter in this family
 * shares, resolved here for the same reason CSS aliases are: a token file that
 * has been through a theming layer is mostly references, and reading only the
 * literals reads only the primitive ramp the designer never picks from.
 *
 * Two dialects, and the difference is one suffix. Style Dictionary v3 documents
 * a reference as `{color.core.blue.500.value}` — the path all the way down to
 * the leaf KEY — and v4 stops at the token. Looking the v3 spelling up verbatim
 * never hits, so the raw `{…}` string fell through to the value sniffer, which
 * refused it, and every alias in the file vanished. That is not a tail case: in
 * a real system the semantic layer is nearly all aliases, so what was dropped
 * was precisely the layer a designer picks from, leaving behind the primitive
 * ramp nobody names a colour by.
 *
 * The literal path is tried first so that a system whose token really is called
 * `value` still resolves; the suffix is only stripped when nothing answers.
 */
function resolveTokenReference(value, byPath, depth = 0, trail = new Set()) {
  if (typeof value !== "string") return value
  const match = /^\{([^{}]+)\}$/.exec(value.trim())
  if (!match) return value
  const raw = match[1].trim()
  const key = byPath.has(raw) ? raw : raw.replace(/\.\$?value$/, "")
  if (depth >= MAX_ALIAS_DEPTH || trail.has(key) || !byPath.has(key)) return value
  return resolveTokenReference(byPath.get(key), byPath, depth + 1, new Set([...trail, key]))
}

/**
 * Every path a reference in this file might be written against.
 *
 * One file, two coordinate systems, which is what a token manager's multi-set
 * export looks like from here. The sets are top-level groups — `global`,
 * `light`, `dark` — so a leaf's real path is `global.colors.primary`, but a
 * reference inside the file is written against the RESOLVED set stack and says
 * `{colors.primary}`. Indexed by full path alone, every cross-set alias missed
 * and the themed half of the file came back empty.
 *
 * So each set contributes its paths a second time with the set name stripped,
 * walked in the order `$metadata.tokenSetOrder` declares, which is the order the
 * exporting tool resolves them in: a later set in the stack overrides an
 * earlier one, exactly as it would in the tool. A stripped path never displaces
 * a real full path, so a file whose sets happen to be named after its groups
 * still resolves the way it reads.
 */
function tokenPathIndex(parsed, leaves) {
  const byPath = new Map(leaves.map((leaf) => [leaf.path.join("."), leaf.value]))
  const metadata = isPlainObject(parsed) ? parsed.$metadata : null
  const order =
    isPlainObject(metadata) && Array.isArray(metadata.tokenSetOrder)
      ? metadata.tokenSetOrder.filter((entry) => typeof entry === "string")
      : []
  if (order.length === 0) return byPath
  const full = new Set(byPath.keys())
  for (const set of order) {
    for (const leaf of leaves) {
      if (leaf.path.length < 2 || leaf.path[0] !== set) continue
      const key = leaf.path.slice(1).join(".")
      if (!full.has(key)) byPath.set(key, leaf.value)
    }
  }
  return byPath
}

/**
 * The leaves of a token file, whichever of the three shapes it arrived in.
 *
 * Ordered rather than merged, because the shapes overlap and the first one that
 * answers is the one the file was written in. A DTCG or Style Dictionary tree
 * is unambiguous and goes first. A Figma variables response is next, keyed on a
 * structure nothing else has. The plain walk is last and would claim any of
 * them, which is exactly why it only runs when the other two found nothing.
 *
 * `plain` comes back with the leaves because it changes what an empty result
 * MEANS. A DTCG file that yielded no usable token is still a token file and
 * installs as one; a plain object that yielded none was never a token file at
 * all, and saying so beats installing a card that brings nothing.
 */
function tokenFileLeaves(parsed) {
  const leaves = []
  tokenLeaves(parsed, [], leaves)
  if (leaves.length) return { leaves, plain: false }
  const figma = figmaVariableLeaves(parsed)
  if (figma) return { leaves: figma, plain: false }
  plainLeaves(parsed, [], leaves)
  return { leaves, plain: true }
}

const NO_TOKENS =
  "No tokens found. A token file is a tree of `$value` leaves (DTCG or Style Dictionary), " +
  "a Figma variables export, or plain nested JSON whose leaves are colours, lengths or durations"

export function parseTokenLibrary(parsed, name) {
  if (!isPlainObject(parsed)) throw new Error("A token file must be an object of named tokens")
  const { leaves, plain } = tokenFileLeaves(parsed)
  if (leaves.length === 0) throw new Error(NO_TOKENS)

  const byPath = tokenPathIndex(parsed, leaves)
  const catalog = emptyCatalog(name)
  const seen = new Set()
  /** Each style's tracking as authored, converted once the file's unit is known. */
  const trackings = []

  for (const leaf of leaves) {
    const label = leaf.path.join("/")
    const value = resolveTokenReference(leaf.value, byPath)
    const text = tokenText(value)
    const verdict = leafVerdict(leaf, text)
    if (!verdict || !verdict.group) continue

    if (verdict.group === "textStyles") {
      // A scalar font size is a text style with nothing but a size, the same
      // reading the CSS lane gives a lone `--text-sm`. A tool that ships a
      // `fontSizes` scale and no composite is shipping a type ramp, and
      // refusing it because it lacks a leading would drop the whole ramp.
      const composite = isPlainObject(value) ? value : { fontSize: text }
      // Each field of a composite is a token value in its own right: it can be
      // a reference into the file (`"{font.size.lg}"`) or an object dimension
      // (`{ "value": 16, "unit": "px" }`), and read raw both came out as
      // nothing.
      const field = (key) => tokenText(resolveTokenReference(composite[key], byPath))
      const fontSize = singleLength(field("fontSize"))
      if (fontSize === null || fontSize <= 0) continue
      const lineHeight = leadingPx(field("lineHeight"), fontSize)
      const tracking = readTracking(field("letterSpacing"))
      const fontWeight = weightNumber(field("fontWeight"))
      const id = tokenId("typography", label)
      if (seen.has(id)) continue
      seen.add(id)
      const style = {
        id,
        name: label,
        category: "typography",
        values: {
          default: {
            fontSize,
            lineHeight: lineHeight === null ? fontSize : lineHeight,
            letterSpacing: 0,
            ...(fontWeight !== null ? { fontWeight } : {}),
          },
        },
      }
      if (tracking) trackings.push({ style, tracking })
      catalog.textStyles.push(style)
      continue
    }

    const values = tokenValues(verdict.group, text)
    if (!values) continue
    // A source that carries its own themes — a variables export whose collection
    // has a dark mode — pairs them here, exactly as a `.dark` block does in the
    // CSS lane, so a colour is one row with two swatches rather than two rows.
    if (verdict.group === "colors" && leaf.dark !== undefined) {
      const dark = paintableColor(tokenText(resolveTokenReference(leaf.dark, byPath)))
      if (dark) values.dark = dark
    }
    const id = tokenId(verdict.category, label)
    if (seen.has(id)) continue
    seen.add(id)
    // No `cssVar`: these tokens are a build input, not a live custom property,
    // so there is no variable for the inspector to trace an authored value to.
    catalog[verdict.group].push({ id, name: label, category: verdict.category, values })
  }

  // A tree of `$value` leaves said what it was before anything was read out of
  // it, so an empty catalog from one is a token file this editor could not use.
  // A plain object said nothing — it is only a token file if tokens came out —
  // so an empty one was the wrong file, and it is told so rather than installed
  // as a card that brings nothing and explains nothing.
  if (plain && isEmptyCatalog(catalog)) {
    throw new Error(NO_TOKENS)
  }

  // One unit for the whole catalog, because the catalog can only state one. A
  // file that mixes `-0.01em` and `0.5px` used to be declared an em file and
  // read its pixel tracking as that many ems — thirty-two times too wide on a
  // 16px body. Each style's own size converts it instead. A bare number keeps
  // the file's unit, whichever that turns out to be; it states none of its own.
  catalog.trackingUnit = trackings.some(({ tracking }) => tracking.unit === "em") ? "em" : "px"
  for (const { style, tracking } of trackings) {
    const authored = tracking.unit ? tracking : { value: tracking.value, unit: catalog.trackingUnit }
    style.values.default.letterSpacing = trackingIn(catalog.trackingUnit, authored, style.values.default.fontSize)
  }
  return catalog
}

/** Does any leaf of this object look like a design token rather than data? */
export function hasTokenLeaf(node, depth = 0) {
  if (!isPlainObject(node) || depth > 8) return false
  for (const value of Object.values(node)) {
    if (!isPlainObject(value)) continue
    if (value.$value !== undefined || value.value !== undefined) return true
    if (hasTokenLeaf(value, depth + 1)) return true
  }
  return false
}

/**
 * How much of a plain nested file this module would actually read.
 *
 * Counted by running the real classifier rather than by pattern-matching the
 * shape, which is what keeps the answer honest in both directions. A theme
 * object is full of hex strings and rem lengths and passes easily; a
 * `package.json` has a name, a version and a scripts block, none of which is a
 * colour or a length, and scores zero without needing a rule that knows what a
 * `package.json` is.
 */
export function readableTokenCount(parsed) {
  const leaves = []
  plainLeaves(parsed, [], leaves)
  let count = 0
  for (const leaf of leaves) {
    const text = tokenText(leaf.value)
    const verdict = leafVerdict(leaf, text)
    if (!verdict || !verdict.group) continue
    if (verdict.group === "textStyles" ? singleLength(text) !== null : tokenValues(verdict.group, text)) {
      count += 1
    }
  }
  return count
}
