/**
 * A design system that lives at a URL instead of in the project.
 *
 * Every other library kind names a file this process can open. This one names a
 * page somebody published — a Storybook, a documentation site, a token file
 * served over HTTP — and the whole of the designer's input is a URL they
 * pasted out of their address bar. That single difference drives everything
 * below, because the address bar is not a file picker: the URL is almost never
 * the catalog, it is a page NEAR the catalog, and this module's job is to work
 * out what the catalog is from a deep link into a component's docs.
 *
 * THE URL IS CARRIED IN `source.path`, NOT IN A NEW FIELD. A library's source
 * is `{ kind, path }` everywhere — the client reads `library.source.path` into
 * the row, `libraries.mjs` dedupes on it, `libraryId` slugs it, and the removal
 * path matches on it. Giving a URL library a `source.url` would mean touching
 * every one of those for a value that is already a string identifying where the
 * library came from. So a URL library spells itself `{ kind: "url", path: "<the
 * url>" }` and no existing consumer had to learn anything. The next reader will
 * want to "fix" this; the fix is four files of churn and one new way for a row
 * to go missing.
 *
 * SIGN-IN IS THE NORMAL CASE, NOT AN EDGE CASE. Most component catalogs worth
 * pointing this at are internal to some organisation, and a refused request
 * mostly does not fail the way a refused request is supposed to. A plain
 * `fetch` that follows redirects gets HTTP 200 and a body — and the body is a
 * login page. Parsed, that is a "library" containing somebody's sign-in form,
 * installed with a green checkmark, and the designer has no way to see what
 * went wrong. `looksLikeSsoWall` exists for exactly that failure, and it reads
 * the BODY as well as the redirect because following the redirect is what hides
 * the 302 in the first place. `library-auth.mjs` owns the rules, all of which
 * are HTTP or OAuth standards rather than facts about one vendor.
 *
 * EVERY NETWORK CALL IS INJECTABLE. `fetchImpl` and `runHelper` are options with
 * real defaults rather than imports, so the test suite runs offline against
 * fakes. A module that reached for `globalThis.fetch` directly could only be
 * tested by a suite that was allowed to talk to the internet, which is a suite
 * that fails on a plane and passes when the site it points at changes.
 *
 * THREE JOBS, in this order down the file:
 *
 *   1. Scraping: pure functions from a URL or a document to where a catalog
 *      might be — the probes, the preview documents, the stylesheet links,
 *      the inline styles, the imports, a composed Storybook's refs, and the
 *      one component a documentation page names.
 *   2. Fetching: one URL, its redirects and its sign-in wall. That lives in
 *      `library-fetch.mjs`, which the sign-in routes use on their own.
 *   3. Reading: `parseUrlLibrary`, which spends the fetches in order of
 *      evidence and merges what comes back into one catalog.
 *
 * Jobs 1 and 3 decide what a cached URL catalog contains, so a change to
 * either is a change to the reading rules: bump `CATALOG_READER_VERSION`
 * (see `library-sources.mjs`), or every installed URL library keeps the old
 * reading and nothing says so.
 *
 * Nothing here touches the filesystem or the store. Reading a catalog out of
 * text is `library-sources.mjs`'s job and it is reused rather than
 * reimplemented — a second DTCG parser is how a token file served over HTTP
 * comes to be understood differently from the same file on disk.
 */

import { originOf } from "./library-auth.mjs"
import { componentId, isPlainObject } from "./library-common.mjs"
import { DEFAULT_TIMEOUT_MS, SSO_SENTENCE, fetchLibraryUrl, isLibraryUrl } from "./library-fetch.mjs"
import {
  describeCatalog,
  emptyCatalog,
  isEmptyCatalog,
  parseLibrary,
  readLibraryText,
} from "./library-sources.mjs"

/*
 * Re-exported so the store, the sign-in routes and the tests keep one import
 * site for the URL lane. New code that only fetches imports
 * `library-fetch.mjs` directly.
 */
export { fetchLibraryUrl, isLibraryUrl, looksLikeSsoWall } from "./library-fetch.mjs"

export const URL_SOURCE_KIND = "url"

/**
 * Probes get a tighter bound than the page does. There are up to a dozen of
 * them and most are expected to 404, so the full timeout applied to each would
 * turn one unreachable host into three minutes of a blocked route.
 */
const PROBE_TIMEOUT_MS = 5000
/**
 * A stylesheet is not a probe, and sizing it like one was wrong.
 *
 * The probe bound is short because a probe is a GUESS — most of them 404 and
 * there are a dozen, so the cost of waiting is paid over and over for paths
 * nothing was ever served from. A stylesheet is the opposite: it is a URL the
 * document itself named, there are a handful of them, and it is the biggest
 * file in the reading — a compiled design system runs to megabytes and comes
 * off a CDN that may be cold. Five seconds there is not a guard, it is a
 * coin flip on whether the tokens arrive, and losing it reads to the designer
 * as "this URL has no design system".
 */
const STYLESHEET_TIMEOUT_MS = 10000
/** How many path prefixes are probed before the bare origin. */
const MAX_PROBE_DEPTH = 4
const MAX_PROBES = 15
/** Preview documents get their own budget: three filenames at every prefix. */
const MAX_PREVIEWS = 15
/**
 * How many stylesheets are FETCHED, over all the documents that named one.
 *
 * A build splits its CSS by entry and by chunk, so a handful is normal and a
 * hundred means something has gone wrong with the reading rather than with the
 * site. Ten covers every real case measured — a Docusaurus page linking its
 * framework theme, its product theme and two chunk sheets, a Style Dictionary
 * build with one file per category — and still bounds the work to one round of
 * parallel fetches.
 */
const MAX_STYLESHEETS = 10
/**
 * How many links are COLLECTED from one document, which is deliberately much
 * larger than the number fetched.
 *
 * These two were the same number once, and sharing it threw away the answer on
 * any page with a lot of links: collection stopped at six, so on a twelve-link
 * page the candidate list was full of chunk sheets and a `print` stylesheet
 * before `tokens.css` — the twelfth link — was ever looked at. Collecting
 * widely and then RANKING is what lets the fetch budget be spent on the six
 * best candidates rather than on the first six in source order.
 */
const MAX_LINKS_PER_DOCUMENT = 24
/** `<style>` blocks read out of one document. A page with more is a page of CSS. */
const MAX_INLINE_STYLES = 4
/**
 * How many `@import`s are followed, one level down, across all sheets.
 *
 * One level, because that is where the aggregate entry file lives: Primer's and
 * Spectrum's published CSS, and every Style Dictionary build that emits one
 * file per category, ship an `index.css` whose entire body is imports. Two
 * levels buys almost nothing and turns a bounded round into a crawl.
 */
const MAX_IMPORTS = 6
/** Composed Storybooks this follows into. Enough for a real composition root. */
const MAX_REFS = 4
/** Guards on a document nobody in this process wrote, not product limits. */
const MAX_COMPONENTS = 2000
const MAX_VARIANTS = 200

/** What it shows when the URL answered and had no design system on it. */
const NOTHING_SENTENCE =
  "Nothing at this URL read as a design system. " +
  "Paste a Storybook URL, a token file, or a page documenting one component."
/** Appended to an HTTP failure, which states a fact and suggests nothing. */
const CHECK_SENTENCE = "Check the address, or paste a page that documents a component."

/* ------------------------------------------------------------------------- */
/* Naming                                                                     */
/* ------------------------------------------------------------------------- */

function words(value) {
  return String(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Sentence case, so "cloud-design-system" reads as a name and not as a title. */
function humanize(parts) {
  if (parts.length === 0) return ""
  const [first, ...rest] = parts
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ")
}

/**
 * A word a deployment tool minted rather than a word a person chose.
 *
 * Every managed host generates names like `storybook-k4f9x2n-uc.example.app`,
 * and naming a library after one would put a deployment hash in the panel.
 * Letters mixed with digits over a few characters is the whole test: it catches
 * the hash without catching `m3`, `v2` or `web3`, which are names people do
 * choose.
 */
function looksGenerated(word) {
  return word.length >= 5 && /[0-9]/.test(word) && /[a-z]/.test(word)
}

/** Host labels that describe the hosting rather than the design system. */
const GENERIC_HOST_LABELS = new Set([
  "www",
  "docs",
  "doc",
  "storybook",
  "design",
  "ui",
  "app",
  "apps",
  "web",
  "dev",
  "staging",
  "demo",
  "preview",
  "site",
  "go",
])

/**
 * A human name for the thing at this URL.
 *
 * The host wins when it says something. A system published at
 * `<its-own-name>.example.com/<product>/components/<thing>` is named by the
 * hostname, and the first path segment there is one product inside it. The host
 * loses when it is a deployment artefact or a generic word — a container host
 * hands out names like `storybook-<hash>-uc.<platform>.app`, which will never
 * say what they are serving — and then the first path segment is the only name
 * available.
 *
 * Either way this is a STARTING name. `update(id, { name })` exists, and a
 * designer who dislikes the guess renames the row in one click — which is why
 * guessing is better here than asking for a name the designer does not yet know
 * they will want to change.
 */
export function libraryNameFromUrl(url) {
  let parsed
  try {
    parsed = new URL(String(url).trim())
  } catch {
    return ""
  }

  const labels = parsed.hostname.split(".").filter(Boolean)
  while (labels.length > 1 && labels[0] === "www") labels.shift()
  const hostWords = words(labels[0] ?? "")
  const hostSpeaks =
    hostWords.length > 0 &&
    !hostWords.some(looksGenerated) &&
    !(hostWords.length === 1 && GENERIC_HOST_LABELS.has(hostWords[0]))
  if (hostSpeaks) return humanize(hostWords)

  for (const segment of parsed.pathname.split("/").filter(Boolean)) {
    let decoded = segment
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      // A segment that is not valid percent-encoding is still a string a
      // designer can read; the raw form is a better name than no name.
    }
    const segmentWords = words(decoded)
    if (segmentWords.length && !segmentWords.some(looksGenerated)) return humanize(segmentWords)
  }

  return humanize(hostWords) || parsed.hostname
}

/* ------------------------------------------------------------------------- */
/* Storybook                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * A story index read as a component catalog, or null.
 *
 * Three dialects, because Storybook renamed the file and its keys at v7 and
 * both are still deployed — v4+ keys a `title` off `entries`, v3 keys a `kind`
 * off `stories` — and because Ladle, the other explorer that publishes a story
 * index, writes the same fact a third way: `ladle build` emits a `meta.json`
 * whose `stories` map carries `levels: ["forms", "text field"]` instead of a
 * slash-joined title. They are one fact under three spellings, so they collapse
 * here rather than in three branches of the caller. Reading `levels` costs a
 * `??` and turns every deployed Ladle from "nothing read as a design system"
 * into the same catalog a Storybook of the same components would give.
 *
 * The grouping is what turns an index into a catalog. A story index is a flat
 * list of STORIES — `Primitives/Avatar` appears once per variant — and a
 * designer thinks in components. So stories collapse onto their title, and the
 * story names become a variant axis on the component rather than a dozen
 * near-duplicate rows. Docs entries are dropped when the same title also has
 * stories, because "Docs" is not a variant of anything; a title with only docs
 * still yields a component, with no variant axis, since a documented component
 * is a component.
 */
export function parseStorybookIndex(json) {
  if (!isPlainObject(json)) return null
  const rows = isPlainObject(json.entries)
    ? json.entries
    : isPlainObject(json.stories)
      ? json.stories
      : null
  if (!rows) return null

  const byTitle = new Map()
  for (const raw of Object.values(rows)) {
    if (!isPlainObject(raw)) continue
    // `title` is v4's word, `kind` is v3's word, and `levels` is Ladle's — a
    // path already split into segments, which is what a title is once this
    // function has finished with it.
    const levels = Array.isArray(raw.levels)
      ? raw.levels.filter((level) => typeof level === "string" && level.trim()).join("/")
      : ""
    const title = String(raw.title ?? raw.kind ?? levels).trim()
    if (!title) continue
    if (!byTitle.has(title) && byTitle.size >= MAX_COMPONENTS) continue

    let entry = byTitle.get(title)
    if (!entry) {
      entry = { title, stories: [], file: "" }
      byTitle.set(title, entry)
    }
    // `importPath` is Storybook's; `entry` is Ladle's name for the same file.
    const file = raw.importPath ?? raw.entry
    if (!entry.file && typeof file === "string" && file.trim()) entry.file = file.trim()

    const docs = raw.type === "docs" || raw.parameters?.docsOnly === true
    const story = String(raw.name ?? "").trim()
    if (docs || !story) continue
    if (!entry.stories.includes(story) && entry.stories.length < MAX_VARIANTS) {
      entry.stories.push(story)
    }
  }
  if (byTitle.size === 0) return null

  const components = []
  for (const entry of byTitle.values()) {
    // "Primitives/Forms/Avatar": everything before the last segment is where a
    // designer would look for it, the last segment is what they would call it.
    const segments = entry.title
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean)
    const name = segments.length ? segments[segments.length - 1] : entry.title
    const group = segments.slice(0, -1).join("/")
    components.push({
      id: componentId(entry.title),
      name,
      ...(group ? { group } : {}),
      ...(entry.file ? { file: entry.file } : {}),
      ...(entry.stories.length
        ? {
            props: [
              {
                name: "Story",
                type: "variant",
                values: entry.stories,
                default: entry.stories[0],
              },
            ],
          }
        : {}),
    })
  }
  return { components }
}

/* ------------------------------------------------------------------------- */
/* The page itself                                                            */
/* ------------------------------------------------------------------------- */

const HTML_HINT = /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i
const DESCRIPTION_NAME = /\bname\s*=\s*["']description["']/i
const META_CONTENT = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i
/** A segment that names the page's plumbing rather than its subject. */
const PAGE_NOISE = /^(index|default|home)(\.[a-z0-9]+)?$/i
const PAGE_EXTENSION = /\.(html?|php|aspx?|jsp)$/i
const MAX_DESCRIPTION = 400

/** The longest tag this module reads. A real `<link>` or `<meta>` is a few hundred characters. */
const MAX_TAG_LENGTH = 4096

/**
 * Every `<name …>` tag in a document, in order, up to its first `>`.
 *
 * A pattern like `<link\b[^>]*>` scanned to the end of the document for every
 * opener with no `>` after it, so a page of a hundred thousand bare `<link`s
 * was quadratic. Here the position of the next `>` is found once and reused
 * for every opener before it, and a tag longer than `MAX_TAG_LENGTH` is
 * skipped rather than read.
 */
function* tagsNamed(html, name) {
  const text = String(html ?? "")
  const opener = new RegExp(`<${name}\\b`, "gi")
  let close = -1
  for (const match of text.matchAll(opener)) {
    // An opener inside the tag just read is part of that tag, as it was for
    // the pattern this replaces.
    if (match.index <= close) continue
    close = text.indexOf(">", match.index)
    if (close === -1) return
    if (close - match.index > MAX_TAG_LENGTH) continue
    yield text.slice(match.index, close + 1)
  }
}

function metaDescription(html) {
  let tag = null
  for (const candidate of tagsNamed(html, "meta")) {
    if (DESCRIPTION_NAME.test(candidate)) {
      tag = candidate
      break
    }
  }
  if (!tag) return ""
  const content = META_CONTENT.exec(tag)
  const value = (content?.[1] ?? content?.[2] ?? "").trim()
  return value.slice(0, MAX_DESCRIPTION)
}

/**
 * One component, read off the URL of the page documenting it.
 *
 * A single-component library looks thin, and it is the honest answer: a deep
 * link into `…/components/split-button` is a page ABOUT one component, and
 * reporting one component is what that page contains. It is also the thing that
 * makes pasting a deep link useful at all — a designer who copies the URL they
 * are reading gets the component they were reading about, instead of an error
 * telling them to go and find a story index they have never heard of.
 *
 * The URL is the evidence, not the markup. Every documentation site renders its
 * own chrome, its own nav and its own search box, and no scrape of the DOM
 * survives a redesign; the path segments are the site's own information
 * architecture and they are stable. The description is the one thing taken from
 * the markup, because `<meta name="description">` is written for exactly this.
 */
export function componentFromPage(url, html) {
  const text = typeof html === "string" ? html : ""
  if (!HTML_HINT.test(text)) return null

  let parsed
  try {
    parsed = new URL(String(url).trim())
  } catch {
    return null
  }

  const segments = parsed.pathname
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .filter((segment) => segment && !PAGE_NOISE.test(segment))
  if (segments.length === 0) return null

  const last = segments[segments.length - 1].replace(PAGE_EXTENSION, "")
  const name = humanize(words(last))
  if (!name) return null
  const group = humanize(words(segments[segments.length - 2] ?? ""))
  const description = metaDescription(text)

  return {
    id: componentId(last),
    name,
    ...(group ? { group } : {}),
    ...(description ? { description } : {}),
    // The URL itself: there is no project file behind this component, and a
    // consumer that wants to go and look at it wants the page.
    file: parsed.toString(),
  }
}

/* ------------------------------------------------------------------------- */
/* Where to look                                                              */
/* ------------------------------------------------------------------------- */

/**
 * The path prefixes worth asking about, outwards from the pasted one.
 *
 * Deepest first, because a designer pastes the page they are looking at and the
 * tool is mounted at or above it — and the bare origin last, so a Storybook at
 * the root is still found.
 *
 * THE TWO ENDS, not the four deepest, and that correction matters more the
 * deeper the URL. This used to keep the first four prefixes of the walk, which
 * are the four DEEPEST — so for `…/v2/web/components/forms/text-field/overview`
 * the probes covered `overview`, `text-field`, `forms` and `components` and
 * then jumped to the origin, never asking about `/v2/web` or `/v2`. Those are
 * precisely where a tool gets mounted: nobody deploys a Storybook at
 * `…/forms/text-field/overview`, and plenty of organisations deploy one at
 * `/v2/web`. Taking two from each end keeps the deep guesses that find a tool
 * mounted beside the page and adds back the shallow ones that find a tool
 * mounted above it, for the same request budget.
 */
function pathPrefixes(pathname) {
  const segments = pathname.split("/").filter(Boolean)
  const walk = []
  for (let depth = segments.length; depth > 0; depth -= 1) {
    walk.push(`/${segments.slice(0, depth).join("/")}`)
  }
  const half = Math.max(1, Math.floor(MAX_PROBE_DEPTH / 2))
  const kept = []
  for (const prefix of [...walk.slice(0, half), ...walk.slice(-half)]) {
    if (!kept.includes(prefix)) kept.push(prefix)
  }
  kept.push("")
  return kept
}

/**
 * The files a story index is published as, one per tool: Storybook v7+,
 * Storybook v6, and Ladle. Shared by the probes and by the walk into a
 * composed Storybook's refs, which asked for only the first two and so read a
 * composed Ladle as nothing.
 */
const STORY_INDEX_FILES = ["index.json", "stories.json", "meta.json"]

/**
 * Where a catalog might be, given a URL somebody pasted, best guess first.
 *
 * A designer pastes the page they are looking at, which is several levels below
 * the story index that describes the whole system. So the path is walked from
 * the deepest prefix outwards and the bare origin is tried last — a Storybook
 * mounted under a sub-path is found at `<that path>/index.json` long before the
 * origin is reached, and a Storybook at the root is still found.
 *
 * Three filenames at every level, and each is one tool's convention rather than
 * a variation on a theme: `index.json` is Storybook v7+, `stories.json` is what
 * Storybook v6 called the same file, and `meta.json` is what `ladle build`
 * writes. Probing for a filename a tool does not publish costs one 404 in a
 * round of requests that is already parallel; NOT probing for it costs the
 * whole catalog, because nothing downstream can find a file that was never
 * asked for.
 */
export function catalogProbes(url) {
  let parsed
  try {
    parsed = new URL(String(url).trim())
  } catch {
    return []
  }

  const probes = []
  const push = (value) => {
    if (probes.length < MAX_PROBES && !probes.includes(value)) probes.push(value)
  }

  // A URL that already names a JSON file is not a hint about where the catalog
  // is; it IS the catalog, and probing around it first would be perverse. The
  // other spellings of "the pasted URL is the file" — `.css`, `.tokens`, a
  // tokens endpoint with no extension at all — are not probed, because the page
  // fetch in `parseUrlLibrary` already has that body in hand and reads it
  // there; a probe would be the same request twice.
  if (/\.json$/i.test(parsed.pathname)) push(parsed.toString())

  for (const prefix of pathPrefixes(parsed.pathname)) {
    for (const file of STORY_INDEX_FILES) push(new URL(`${prefix}/${file}`, parsed.origin).toString())
  }
  return probes
}

/**
 * The documents a component explorer renders its EXAMPLES in, as opposed to the
 * one it renders its own interface in.
 *
 * This distinction is the whole reason this function exists, and getting it
 * wrong produces an answer that looks right and is not. A Storybook-shaped tool
 * is two applications on one origin: a manager — the sidebar, the tabs, the
 * chrome — and a preview, an isolated document the components are mounted in.
 * They have separate stylesheets, and the tokens a designer came for are in the
 * preview. The manager's CSS describes the TOOL.
 *
 * Measured on a real one: the manager's stylesheet yields a perfectly plausible
 * fifty colours named `amber-50`, `green-50`, `emerald-400` — the explorer's own
 * Tailwind theme — while the preview's yields eighty-two named `accent`,
 * `surface`, `on-surface`. Both parse. Only one is the design system, and a
 * reader handed the first would find a palette that has nothing to do with the
 * product and no way to tell why.
 *
 * Three filenames because the ecosystem uses three: `iframe.html` is
 * Storybook's own, `preview.html` is what several of the newer explorers emit,
 * and `__sandbox.html` is Histoire's — its preview is a separate document with
 * a name nobody would guess, and a Histoire whose sandbox is never asked for
 * reads as the tool's own Vue chrome. Walked from the pasted path outwards for
 * the reason `catalogProbes` gives — an explorer mounted under a sub-path keeps
 * its preview under that sub-path.
 */
function previewEntries(url) {
  let parsed
  try {
    parsed = new URL(String(url).trim())
  } catch {
    return []
  }
  const entries = []
  const push = (value) => {
    if (entries.length < MAX_PREVIEWS && !entries.includes(value)) entries.push(value)
  }
  for (const prefix of pathPrefixes(parsed.pathname)) {
    push(new URL(`${prefix}/iframe.html`, parsed.origin).toString())
    push(new URL(`${prefix}/preview.html`, parsed.origin).toString())
    push(new URL(`${prefix}/__sandbox.html`, parsed.origin).toString())
  }
  return entries
}

/**
 * The Storybooks a COMPOSED Storybook is standing in front of, same-origin only.
 *
 * Composition is how an organisation publishes one address for several
 * Storybooks, and it defeats every probe above: the composition root's own
 * `index.json` lists only its LOCAL entries, which for a pure composition root
 * is none at all. So the probes succeed, parse, and describe an empty system —
 * the worst shape of failure, because it looks like an answer.
 *
 * Where the real catalogs are is not in any JSON the root serves; it is in the
 * built manager HTML, which carries `window['REFS'] = {…}` with a `url` per
 * composed Storybook. Scraping that is how the enterprise case — an intranet
 * address that is nothing but a composition of eight team Storybooks — turns
 * from an empty row into the whole estate.
 *
 * SAME-ORIGIN, for the reason `stylesheetLinks` gives. A ref can name any host,
 * the editor may be holding a session cookie for the one that was pasted, and a
 * ref is somebody else's string in somebody else's build output. The credential
 * would not in fact be sent — `fetchLibraryUrl` only attaches it to its own
 * origin — but the REQUEST would still go out, and "the editor quietly fetched
 * a third-party URL because a page told it to" is not a thing to be talked into
 * by a `<script>` tag.
 */
function storybookRefs(html, baseUrl) {
  let base
  try {
    base = new URL(String(baseUrl))
  } catch {
    return []
  }
  const refs = refsObject(String(html ?? ""))
  if (!isPlainObject(refs)) return []

  const urls = []
  for (const ref of Object.values(refs)) {
    if (urls.length >= MAX_REFS) break
    if (!isPlainObject(ref) || typeof ref.url !== "string" || !ref.url.trim()) continue
    let resolved
    try {
      resolved = new URL(ref.url.trim(), base)
    } catch {
      continue
    }
    if (resolved.origin !== base.origin) continue
    const href = resolved.toString().replace(/\/+$/, "")
    if (!urls.includes(href)) urls.push(href)
  }
  return urls
}

/** Where the assignment a composed Storybook's manager makes starts. */
const REFS_ASSIGNMENT = /window\[\s*['"]REFS['"]\s*\]\s*=\s*\{/g
/** The most of a document read as one refs object. A real one is a few kilobytes. */
const MAX_REFS_TEXT = 256 * 1024
const MAX_REFS_ATTEMPTS = 8

/**
 * The object `window['REFS'] = {…}` assigns, parsed, or null.
 *
 * Found by its opening brace and read to the brace that balances it, rather
 * than by a lazy pattern for "everything up to `};`": that pattern rescanned
 * the rest of the document from every assignment it could not finish, and
 * twenty thousand of them in 360 KB cost two and a half seconds. The manager
 * template writes the object with `JSON.stringify`, so anything that does not
 * parse is not the thing this is looking for.
 */
function refsObject(html) {
  let attempts = 0
  for (const match of html.matchAll(REFS_ASSIGNMENT)) {
    if ((attempts += 1) > MAX_REFS_ATTEMPTS) return null
    const open = match.index + match[0].length - 1
    const close = balancedBrace(html, open, Math.min(html.length, open + MAX_REFS_TEXT))
    if (close === -1) continue
    try {
      return JSON.parse(html.slice(open, close + 1))
    } catch {
      continue
    }
  }
  return null
}

/** The index of the `}` balancing the `{` at `open`, skipping JSON strings, or -1 before `limit`. */
function balancedBrace(text, open, limit) {
  let depth = 0
  let quoted = false
  for (let index = open; index < limit; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === "\\") index += 1
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === "{") depth += 1
    else if (char === "}" && --depth === 0) return index
  }
  return -1
}

/** One attribute off one tag, quoted either way or not at all. */
function attribute(tag, name) {
  const found = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)
  return String(found?.[1] ?? found?.[2] ?? found?.[3] ?? "").trim()
}

/** HTML attributes arrive entity-encoded; `&amp;` in a query string is the one
 * that turns a real URL into a 404 if it is left alone. */
function attributeUrl(value, base) {
  try {
    return new URL(String(value).replace(/&amp;/g, "&"), base)
  } catch {
    return null
  }
}

/** A `media` that means "not on a screen", and one that means "only in dark". */
const PRINT_MEDIA = /^\s*print\s*$/i
const DARK_MEDIA = /prefers-color-scheme\s*:\s*dark/i

/**
 * The stylesheets a document links, absolute, ranked, and SAME-ORIGIN ONLY.
 *
 * The origin restriction is not tidiness. Following a link off-origin would
 * send this site's session cookie to whoever the link names — a font service, a
 * CDN, anyone — and a credential the designer gave the editor for one host has
 * no business reaching a second. It is the one rule here that may not be traded
 * for coverage: a CDN-hosted token package genuinely is missed because of it,
 * and that is the cheaper loss.
 *
 * WHAT COUNTS AS A STYLESHEET LINK has three spellings and only one of them was
 * being read. `rel="stylesheet"` is the obvious one. `rel="preload"
 * as="style"` is what a build emits when it wants the sheet fetched early —
 * Gatsby and Next both do it, sometimes INSTEAD of a plain link, with the real
 * `<link rel=stylesheet>` inserted later by script this module never runs. And
 * `<base href>` moves what a relative href means, so a document that sets one
 * and is read without it resolves every link against the wrong directory.
 *
 * THE ORDER IS PART OF THE ANSWER, because the fetch budget is smaller than
 * this list is allowed to be. A `media="print"` sheet is not the design system
 * by definition, so it is dropped outright; a sheet the page only applies in
 * dark is real but cannot be read as the default palette, so it sorts last,
 * where the merge's first-wins rule leaves it able to ADD names and unable to
 * overwrite one. Measured on a twelve-link page, that reordering is the
 * difference between `tokens.css` being the twelfth candidate and never fetched
 * and `tokens.css` being fetched: `print.css` used to outrank it.
 */
function stylesheetLinks(html, baseUrl) {
  const source = String(html ?? "")
  let base
  try {
    base = new URL(String(baseUrl))
  } catch {
    return []
  }
  /*
   * The origin is the DOCUMENT's, always, and never the `<base>` tag's.
   *
   * `<base href>` moves what a relative href resolves to, which is a fact about
   * addresses and is honoured below. It must not be allowed to move what
   * "same-origin" MEANS: a document declaring `<base href="https://elsewhere/">`
   * would otherwise turn every relative link on the page into a same-origin
   * link by its own say-so, which is the credential rule being rewritten by the
   * document it exists to be careful of.
   */
  const origin = base.origin
  const declared = tagsNamed(source, "base").next().value
  if (declared) base = attributeUrl(attribute(declared, "href"), base) ?? base

  const found = []
  // `rel` and `href` in either order, quoted either way — this is reading real
  // build output rather than a format anybody agreed on.
  for (const tag of tagsNamed(source, "link")) {
    const rel = attribute(tag, "rel").toLowerCase()
    const linked =
      /\bstylesheet\b/.test(rel) || (/\bpreload\b/.test(rel) && /^style$/i.test(attribute(tag, "as")))
    if (!linked) continue
    const media = attribute(tag, "media")
    if (PRINT_MEDIA.test(media)) continue
    const resolved = attributeUrl(attribute(tag, "href"), base)
    if (!resolved || resolved.origin !== origin) continue
    const href = resolved.toString()
    if (found.some((entry) => entry.href === href)) continue
    if (found.length >= MAX_LINKS_PER_DOCUMENT) break
    found.push({ href, rank: DARK_MEDIA.test(media) ? 1 : 0 })
  }
  return found
    .map((entry, order) => ({ ...entry, order }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((entry) => entry.href)
}

/**
 * The CSS a document carries in its own body rather than behind a link.
 *
 * Invisible to `stylesheetLinks` and increasingly where the tokens are. Tailwind
 * v4 declares a system in `@theme`, and an SSR framework that inlines critical
 * CSS puts that block straight into the document; Storybook's
 * `preview-head.html` is a `<style>` block by design; Astro's global styles and
 * every "critical CSS" plugin do the same. Each of those reads today as a page
 * with no stylesheets at all, which is the one outcome that looks like the
 * site's fault.
 *
 * Free, too — the text is already in hand, so a `<style>` candidate costs no
 * request and does not touch the fetch budget the linked sheets compete for.
 */
function inlineStyles(html) {
  const source = String(html ?? "")
  const blocks = []
  const opener = /<style\b/gi
  const closer = /<\/style>/gi
  // Walked by hand: a lazy `<style>…</style>` pattern rescanned the rest of
  // the document from every `<style>` that never closed. The first one that
  // does not close ends the walk, since nothing after it can be a block.
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    const tagEnd = source.indexOf(">", match.index)
    if (tagEnd === -1) break
    closer.lastIndex = tagEnd + 1
    const close = closer.exec(source)
    if (!close) break
    const text = source.slice(tagEnd + 1, close.index).trim()
    opener.lastIndex = close.index + close[0].length
    if (!text) continue
    if (blocks.length >= MAX_INLINE_STYLES) break
    blocks.push(text)
  }
  return blocks
}

/**
 * The target of every `@import` in a stylesheet, as written: `@import url("x")`,
 * `@import url(x)`, `@import "x"`, and the layer/supports/media variants, which
 * all put the target in the same first position. A malformed one is skipped.
 *
 * Read by hand, with the next `)` and the next quote of each kind found once
 * and reused until the walk passes them. The pattern this replaces scanned
 * from every `@import url(` to the end of the sheet when nothing closed it.
 */
function importTargets(css) {
  const targets = []
  const next = new Map()
  const following = (char, from) => {
    const known = next.get(char)
    if (known !== undefined && (known === -1 || known >= from)) return known
    const found = css.indexOf(char, from)
    next.set(char, found)
    return found
  }
  for (const match of css.matchAll(/@import\s+/gi)) {
    const at = match.index + match[0].length
    let start = at
    const wrapped = /^url\(/i.test(css.slice(at, at + 4))
    if (wrapped) {
      start = at + 4
      while (/\s/.test(css[start] ?? "")) start += 1
    }
    const quote = css[start]
    if (quote === '"' || quote === "'") {
      const close = following(quote, start + 1)
      if (close === -1) continue
      let after = close + 1
      if (wrapped) {
        while (/\s/.test(css[after] ?? "")) after += 1
        if (css[after] !== ")") continue
      }
      targets.push(css.slice(start + 1, close))
    } else if (wrapped) {
      const close = following(")", start)
      if (close === -1) continue
      const inner = css.slice(start, close)
      if (!/["']/.test(inner)) targets.push(inner)
    }
  }
  return targets
}

/**
 * What a stylesheet imports, one level, absolute and SAME-ORIGIN ONLY.
 *
 * An aggregate entry file is a real publishing convention rather than an edge
 * case: `@primer/primitives` and `@spectrum-css` both ship one, and every Style
 * Dictionary build configured to emit a file per category has an `index.css`
 * whose entire body is `@import "./color.css"` and its siblings. Read without
 * following those, the sheet has no custom properties in it at all, and the
 * whole design system reads as nothing — which is a worse answer than the site
 * deserves for using the documented layout of its own build tool.
 *
 * Same-origin for the reason `stylesheetLinks` gives, and it matters more here:
 * an `@import` is a URL inside a FILE, one level further from anything the
 * designer looked at, and a credential must not travel on the strength of it.
 */
function importedStylesheetUrls(css, baseUrl) {
  let base
  try {
    base = new URL(String(baseUrl))
  } catch {
    return []
  }
  const found = []
  for (const target of importTargets(String(css ?? ""))) {
    const value = target.trim()
    if (!value) continue
    let resolved
    try {
      resolved = new URL(value, base)
    } catch {
      continue
    }
    if (resolved.origin !== base.origin) continue
    const href = resolved.toString()
    if (found.length >= MAX_IMPORTS) break
    if (!found.includes(href)) found.push(href)
  }
  return found
}

/**
 * Namespaces belonging to the tool a site is PUBLISHED with rather than to the
 * design system it publishes.
 *
 * Every one of these ships a complete, plausible set of custom properties in
 * `:root`, and on a documentation site theirs is usually the first stylesheet
 * the page links. Read as the answer, a Docusaurus site hands back Infima's
 * `--ifm-color-primary` and the product's own tokens are never reached — the
 * failure is total and completely invisible, because what comes back is a
 * well-formed palette.
 *
 * Deliberately short, and deliberately not "anything with a prefix". A prefix
 * is how most design systems namespace themselves, so a rule about prefixes in
 * general would demote the answer.
 *
 * EVERY ENTRY IS A PUBLISHING TOOL'S OWN THEME, AND NOTHING ELSE MAY BE ADDED.
 * That line is the whole discipline of this list, and it is written down
 * because two component kits were added to it and had to come back out. A
 * documentation framework's theme can never be what somebody pasted a link
 * for — nobody wants the docs site's own chrome in their picker — so demoting
 * it is always right. A COMPONENT KIT is the opposite case: a team whose design
 * system IS that kit, themed and extended, would find the tokens they came for
 * sorted behind the page furniture, and the feature would be narrower for
 * precisely the systems it claims to read.
 *
 * So the test for a new entry is not "is this a framework" but "could this ever
 * be the answer somebody wanted". For a docs theme it cannot be. For anything
 * shaped like a design system it can, and it stays out.
 *
 * `test/library-generality-cases.mjs` enforces the same rule from the outside
 * by failing on any design system's name under `server/` or `src/`, which is
 * why this list holds tool names and never vendor names.
 */
const FRAMEWORK_NAMESPACES = [
  "--ifm-", // Infima, which is Docusaurus's own theme
  "--docusaurus-",
  "--nextra-",
  "--vp-", // VitePress
  "--sb-", // the story explorer's own manager chrome
]
/** Below this many properties there is not enough evidence to demote a sheet. */
const MIN_NAMESPACE_EVIDENCE = 8
const FRAMEWORK_SHARE = 0.8

function frameworkStylesheet(text) {
  // Only at the start of a name run, so a long run of hyphens is tried once.
  const names = new Set(String(text ?? "").match(/(?<![a-zA-Z0-9_-])--[a-zA-Z0-9_-]+(?=\s*:)/g) ?? [])
  if (names.size < MIN_NAMESPACE_EVIDENCE) return false
  let framework = 0
  for (const name of names) {
    if (FRAMEWORK_NAMESPACES.some((prefix) => name.toLowerCase().startsWith(prefix))) framework += 1
  }
  return framework / names.size >= FRAMEWORK_SHARE
}

/* ------------------------------------------------------------------------- */
/* The whole job                                                              */
/* ------------------------------------------------------------------------- */

/** "38 components · 210 variants" — what the row says before anyone expands it. */
function describeComponents(components) {
  const variants = components.reduce(
    (total, component) => total + (component.props?.[0]?.values?.length ?? 0),
    0
  )
  const parts = [`${components.length} ${components.length === 1 ? "component" : "components"}`]
  if (variants > 0) parts.push(`${variants} ${variants === 1 ? "variant" : "variants"}`)
  return parts.join(" · ")
}

/**
 * A document that is not a story index, read by the parsers the file path
 * already uses.
 *
 * Reused rather than reimplemented, and the reuse is the point: a DTCG file
 * served over HTTP and the same file on disk have to produce the same catalog,
 * or a designer who switches from one to the other silently loses tokens.
 *
 * `css` IS reachable here, and refusing it was the largest gap in this module.
 * The refusal made sense when the only caller was the probe loop, which has
 * already run `JSON.parse` and so can only be holding JSON. It stopped making
 * sense the moment the pasted document's own body was read — and the pasted
 * document is very often a stylesheet, because "copy the CDN address of the
 * design system's CSS" is the most obvious thing a designer can do with a
 * system published as CSS. `detectLibraryKind` sniffs the text either way, so
 * the extension on the URL decides nothing; a `.tokens`, a `.css` and a tokens
 * endpoint with no extension at all are read as what they contain.
 */
function catalogFromTokenText(url, text, name, parsed) {
  const read = readLibraryText(url, text, { name, parsed })
  if (!read || isEmptyCatalog(read.catalog)) return null
  return { catalog: read.catalog, detail: describeCatalog(read.catalog) }
}

/** The axes a stylesheet can contribute. `components` never comes from CSS. */
const TOKEN_GROUPS = [
  "colors",
  "spacing",
  "radii",
  "textStyles",
  "uiTextStyles",
  "effects",
  "icons",
  "motion",
  "iconDrawings",
]

/**
 * Several stylesheets read as ONE design system, earlier sheets winning ties.
 *
 * This module used to take the first stylesheet that parsed and stop, and the
 * three ways that goes wrong are all ordinary rather than exotic. A Docusaurus
 * site links Infima before its own theme, so the answer was the docs
 * framework's palette. A Style Dictionary build that emits one file per
 * category links `color.css`, `space.css` and `type.css`, so the answer was the
 * colours and nothing else — the spacing and type scales were sitting in files
 * that were fetched and thrown away. And a page with a dozen links spent the
 * whole budget before reaching the one named `tokens.css`.
 *
 * Merging fixes all three at once, and it has to be ADDITIVE — first sheet to
 * claim a name keeps it — because order here is not arbitrary: the preview
 * document's sheets come before the shell's, the product's before the
 * framework's, the default palette's before the one a page only applies in
 * dark. Last-wins would hand every one of those decisions to whichever sheet
 * happened to be listed last, which is the bug this replaces wearing different
 * clothes.
 *
 * A variable is claimed by its cssVar as well as by its token id, so two sheets
 * that shorten `--acme-color-brand` and `--color-brand` onto the same label do
 * not both appear, and one that declares the same variable under two labels
 * does not double-count.
 */
function mergeCatalogs(catalogs, name) {
  const merged = emptyCatalog(name)
  const claimed = new Set()
  let trackingFrom = null
  for (const catalog of catalogs) {
    if (!catalog) continue
    for (const group of TOKEN_GROUPS) {
      for (const token of Array.isArray(catalog[group]) ? catalog[group] : []) {
        const keys = [`${group}:${token.id}`]
        if (token.cssVar) keys.push(`var:${token.cssVar}`)
        if (keys.some((key) => claimed.has(key))) continue
        for (const key of keys) claimed.add(key)
        merged[group].push(token)
      }
    }
    // Tracking is a fact about type, so the first sheet that HAS type decides
    // it. Taking the first sheet's answer unconditionally would let a colour
    // ramp with no text styles in it overrule the typography sheet.
    if (trackingFrom === null && catalog.textStyles?.length) {
      trackingFrom = catalog.trackingUnit
    }
  }
  merged.trackingUnit = trackingFrom ?? merged.trackingUnit
  return merged
}

/**
 * Whether a candidate preview document is really just the site's app shell.
 *
 * A single-page application serves one HTML shell for every path it does not
 * recognise, with a 200. So `…/avatar/preview.html` comes back looking exactly
 * as successful as a real preview document does, and it carries the MANAGER's
 * stylesheet — the tool's own chrome. Walked deepest-first, those decoys are
 * reached before the real `/preview.html` at the origin, so the first
 * stylesheet collected was Tailwind's stock palette and the genuine design
 * system never got a look in. Observed exactly that way: fifty colours named
 * `amber-50` where the answer was eighty-two named `surface`.
 *
 * Two tests, because the cheap one is defeated by one varying byte. Identical
 * text is what "serves the same page for every path" means in the simple case,
 * and it costs nothing to check. But a shell carrying a CSP nonce, a CSRF
 * token, an inlined build id or a server timestamp is a DIFFERENT document on
 * every request while still being the same shell — and the whole defence used
 * to fall over on that. So a candidate linking exactly the same stylesheets, in
 * the same order, as the page is also treated as the shell. That test cannot
 * cost anything either: if it is wrong and the candidate was a real preview, it
 * links the same sheets the page does and the page contributes them anyway.
 */
function servesTheShell(candidate, from, pageText, url) {
  const shell = String(pageText ?? "").trim()
  if (!shell) return false
  if (String(candidate ?? "").trim() === shell) return true
  const ours = stylesheetLinks(pageText, url)
  if (ours.length === 0) return false
  const theirs = stylesheetLinks(candidate, from)
  return theirs.length === ours.length && theirs.every((href, index) => href === ours[index])
}

/**
 * Every stylesheet these documents can reach, read as one design system.
 *
 * The documents arrive ranked — preview before shell — and everything below
 * preserves that ranking while widening what counts as a stylesheet, because
 * the two failures this replaces are opposites. Too NARROW a surface loses the
 * tokens completely: CSS in a `<style>` block, behind a `rel=preload`, or one
 * `@import` away was invisible, and a site using any of those read as a site
 * with no design system. Too narrow a READING loses most of them: the first
 * sheet that parsed used to win outright, so a split token build contributed
 * its colours and dropped its spacing and type.
 *
 * The fetch budget is spent in ranked order, and the ranking is finished after
 * the bytes arrive, when a sheet can be recognised as a docs framework's own
 * theme (`frameworkStylesheet`) and sorted behind the product's. Ordering is
 * what decides collisions, and only collisions — every sheet that parses
 * contributes.
 */
async function tokensFromDocuments(documents, name, options) {
  const sources = []
  const seen = new Set()
  let order = 0
  for (const { text, from, tier } of documents) {
    if (HTML_HINT.test(text)) {
      for (const href of stylesheetLinks(text, from)) {
        if (seen.has(href)) continue
        seen.add(href)
        sources.push({ tier, order: (order += 1), href })
      }
      for (const block of inlineStyles(text)) {
        sources.push({ tier, order: (order += 1), text: block, from })
      }
      continue
    }
    /*
     * A document that is not HTML is a stylesheet in its own right. This is
     * reached for a pasted `index.css` whose whole body is `@import` lines —
     * the aggregate entry file Primer, Spectrum and split Style Dictionary
     * builds all publish — which has no custom properties of its own and so
     * was rejected upstream as "not a design system" while pointing straight
     * at one.
     */
    sources.push({ tier, order: (order += 1), text, from })
  }

  const wanted = sources.filter((source) => source.href).slice(0, MAX_STYLESHEETS)
  const fetched = await Promise.all(wanted.map((source) => fetchLibraryUrl(source.href, options)))
  const sheets = sources.filter((source) => !source.href)
  wanted.forEach((source, index) => {
    const response = fetched[index]
    if (!response.ok || !response.text.trim()) return
    sheets.push({ ...source, text: response.text, from: source.href })
  })

  // Every sheet in hand is asked what it imports, not only the ones that
  // arrived through a `<link>`: the pasted document can BE the aggregate entry
  // file, and an inline `<style>` can import as readily as a file can.
  const imports = []
  for (const sheet of sheets) {
    for (const href of importedStylesheetUrls(sheet.text, sheet.from)) {
      if (seen.has(href) || imports.length >= MAX_IMPORTS) continue
      seen.add(href)
      // Half a step behind whatever imported it: an `@import` precedes the
      // importing sheet's own rules, so the importing sheet is the one that
      // wins a collision, exactly as the cascade would have it.
      imports.push({ tier: sheet.tier, order: sheet.order + 0.5, href })
    }
  }

  const followed = await Promise.all(imports.map((source) => fetchLibraryUrl(source.href, options)))
  imports.forEach((source, index) => {
    const response = followed[index]
    if (!response.ok || !response.text.trim()) return
    sheets.push({ ...source, text: response.text, from: source.href })
  })

  const ranked = sheets
    .map((sheet) => ({ ...sheet, framework: frameworkStylesheet(sheet.text) ? 1 : 0 }))
    .sort((a, b) => a.tier - b.tier || a.framework - b.framework || a.order - b.order)

  /*
   * MERGING STOPS AT THE TIER BOUNDARY, and that limit is as important as the
   * merging is.
   *
   * Within a tier, more sheets is strictly more design system: a split token
   * build is three files that add up to one scale, and taking one of them is
   * how the spacing and the type used to go missing. Across the boundary it
   * inverts. The shell's stylesheet is the TOOL's — the explorer's own
   * interface theme — and merging it in would add fifty plausible colours named
   * `amber-50` and `green-50` to a picker that should be showing the product's
   * palette. They would not even collide with the product's names, so nothing
   * would mark them as foreign; the designer would simply find a palette with
   * somebody else's Tailwind theme mixed into it.
   *
   * So the first group that yields anything is the answer, and the groups below
   * it are never consulted. A page whose preview reads as nothing still falls
   * through to the shell, which is the reading that makes an ordinary
   * documentation site work.
   *
   * A docs framework's own theme is the same argument one rung down, which is
   * why it groups separately rather than merely sorting late. On a Docusaurus
   * site Infima's `--ifm-*` variables and the product's tokens do not collide —
   * different namespaces — so ranking alone would let both through and quietly
   * hand the designer a palette with the documentation theme mixed into it. And
   * the fallback still holds: a site that publishes NOTHING but its framework's
   * theme has no better answer, and gets that one.
   */
  const groups = [...new Set(ranked.map((sheet) => `${sheet.tier}:${sheet.framework}`))]
  for (const group of groups) {
    const catalogs = []
    for (const sheet of ranked.filter((entry) => `${entry.tier}:${entry.framework}` === group)) {
      let catalog
      try {
        catalog = parseLibrary("css", sheet.text, { name })
      } catch {
        // A stylesheet with no custom properties in it. Most of them.
        continue
      }
      if (isEmptyCatalog(catalog)) continue
      catalogs.push(catalog)
    }
    if (catalogs.length === 0) continue
    const merged = mergeCatalogs(catalogs, name)
    return { catalog: merged, detail: describeCatalog(merged) }
  }
  return null
}

/**
 * Everything at a URL, as a catalog — or as a sentence explaining why not.
 *
 * Five readings in decreasing order of how much they know, and the first that
 * yields anything wins: a story index near the URL describes a whole system;
 * the pasted document ITSELF, when it is a token file or a stylesheet rather
 * than a page, describes a whole system first-hand; a composition's refs
 * describe several; the stylesheets around the page describe a whole scale; and
 * the page describes one component. The ordering is an ordering of EVIDENCE — a
 * system that publishes a story index has already answered the question better
 * than its HTML ever will — with one exception worth naming: the last two are
 * not exclusive, because a component's documentation page is both the component
 * and a link to the system it is built from, and returning one of those used to
 * throw the other away.
 *
 * A FAILURE IS RETURNED, NEVER THROWN. `add` installs the row anyway, with the
 * sentence on it — the same rule `libraries.mjs` applies to a file that has
 * gone missing, and for the same reason: the row carries the only control that
 * can remove the library, so refusing to create it leaves a designer with a
 * failure and nothing to click.
 *
 * The result is `{ name, catalog, detail, error }` plus, on success, `via` —
 * which reading produced it: `index` (a story index at a probe), `probe` (a
 * token file at a probe), `document` (the pasted URL's own body), `refs` (a
 * composed Storybook), `stylesheets` (the page's CSS, with the page's component
 * when it names one) or `component` (the page's component alone). A failure
 * carries `auth` when the site refused the editor, and a lone component
 * carries `signIn` when guessed paths on its host did.
 */
export async function parseUrlLibrary(url, options = {}) {
  const name = libraryNameFromUrl(url)
  if (!isLibraryUrl(url)) {
    return {
      name,
      catalog: emptyCatalog(name),
      detail: "",
      error: "A library URL has to start with http:// or https://",
    }
  }

  /*
   * One helper verdict per origin for the whole reading: see `helperGate` in
   * `library-fetch.mjs`. Every probe below is the same host, and a host that
   * walls one path walls them all.
   */
  const shared = { ...options, helperGate: options.helperGate ?? new Map() }
  const probeOptions = {
    ...shared,
    timeoutMs: Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, PROBE_TIMEOUT_MS),
  }
  // A stylesheet is a named file rather than a guess, and it is the big one.
  // See `STYLESHEET_TIMEOUT_MS`: sharing the probe bound made a cold CDN look
  // like a site with no design system on it.
  const styleOptions = {
    ...shared,
    timeoutMs: Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, STYLESHEET_TIMEOUT_MS),
  }

  /*
   * Every probe, and the page, go out AT ONCE — and the answers are then read
   * strictly in probe order.
   *
   * The two halves of that matter for different reasons. Concurrency is a
   * latency fix with a measurement behind it: run sequentially against a real
   * documentation site behind a company sign-in, where every request is refused and
   * re-issued through a helper command, the chain took sixteen seconds — and sixteen
   * seconds is not a button press. In parallel it is one round trip.
   *
   * Reading them in order is what keeps "best first" meaning anything. Whoever
   * answers first is a fact about the network; whoever is EARLIEST IN THE LIST
   * is the guess this module actually made, and a story index under the pasted
   * URL's own sub-path must win over one at the origin however the timings fell.
   */
  const probes = catalogProbes(url)
  const [responses, page] = await Promise.all([
    Promise.all(probes.map((probe) => fetchLibraryUrl(probe, probeOptions))),
    fetchLibraryUrl(url, shared),
  ])

  /*
   * A walled probe is REMEMBERED, not obeyed. The probes are paths this module
   * guessed at, and a host that guards `/index.json` while serving its
   * documentation in public is ordinary; letting one guessed path decide that
   * the whole site was walled skipped the page, its stylesheets and its refs,
   * and returned the page's one component with no error and no offer to sign
   * in. So the wall is decided by the page itself, and the probes' refusal
   * only counts when nothing else could be read — or beside a lone component,
   * where signing in may well read the index the refusal was hiding.
   *
   * The first classified refusal wins. Every probe is the same host, so they
   * all hit the same wall; keeping the first means the audience reported is
   * the one belonging to the deepest guess.
   */
  let probeChallenge = null
  let probesWalled = false
  for (let index = 0; index < probes.length; index += 1) {
    const response = responses[index]
    if (response.sso) {
      probesWalled = true
      probeChallenge ??= response.wall ?? null
      continue
    }
    const read = readProbe(probes[index], response, name)
    if (read) return { name, ...read, error: "" }
  }

  const pageWalled = page.sso
  const readable = !pageWalled && page.ok

  /*
   * THE PASTED DOCUMENT ITSELF, which was the one thing this module never read.
   *
   * Everything above hunts for a catalog NEAR the URL, on the assumption the
   * URL is a page beside the catalog rather than the catalog. That assumption
   * holds for a deep link into a Storybook and fails completely for the most
   * direct thing a designer can do: paste the address of the token file. Before
   * this branch existed, `theme.tokens` — the extension the DTCG spec itself
   * recommends — `tokens.css` off a CDN, and a tokens endpoint with no
   * extension at all each answered 200 with a perfectly good design system in
   * the body, and each came back as "nothing at this URL read as a design
   * system", because only a path ending `.json` ever got its own body parsed.
   *
   * It is gated on the body NOT being HTML, and that gate is the whole
   * subtlety. `detectLibraryKind` calls anything with four custom properties in
   * it CSS, and a documentation page with an inlined theme block satisfies that
   * — so without the gate a whole HTML document would be handed to the CSS
   * parser, which would read the markup around the tokens as declarations. An
   * HTML page's inline CSS is picked up properly further down, by
   * `inlineStyles`, where it is extracted first and parsed as what it is.
   */
  if (readable && page.text.trim() && !HTML_HINT.test(page.text)) {
    const own = catalogFromTokenText(url, page.text, name)
    if (own) return { name, catalog: own.catalog, detail: own.detail, via: "document", error: "" }
  }

  /*
   * A COMPOSED Storybook, whose catalog is in other Storybooks entirely.
   *
   * Reached only when the probes found no index worth reporting, which is
   * exactly what a composition root looks like: its own `index.json` is empty
   * or absent because it has no local stories, and everything it shows the
   * designer belongs to the Storybooks it refers to. `storybookRefs` reads
   * those out of the manager HTML; each is asked for the same index files the
   * probes ask for, and what comes back is one catalog.
   */
  if (readable && page.text) {
    const refs = storybookRefs(page.text, url)
    if (refs.length) {
      const indexes = await Promise.all(
        refs.flatMap((ref) => STORY_INDEX_FILES.map((file) => fetchLibraryUrl(`${ref}/${file}`, probeOptions)))
      )
      const composed = []
      const seen = new Set()
      for (const response of indexes) {
        for (const entry of storyIndexComponents(parsedJson(response)) ?? []) {
          if (seen.has(entry.id) || composed.length >= MAX_COMPONENTS) continue
          seen.add(entry.id)
          composed.push(entry)
        }
      }
      if (composed.length) {
        return {
          name,
          catalog: { ...emptyCatalog(name), components: composed },
          detail: describeComponents(composed),
          via: "refs",
          error: "",
        }
      }
    }
  }

  /*
   * THE STYLESHEETS, which is where a design system published as a WEBSITE
   * actually keeps its tokens.
   *
   * Everything above this point looks for a machine-readable file: a story
   * index, a DTCG document, a manifest. Those are the happy cases and they are
   * the minority. A modern explorer is a client-rendered application that
   * serves one HTML shell for every path and ships its design system as
   * compiled CSS — so every probe above comes back as the same shell, no JSON
   * parses, and the whole library reduces to a single component guessed from
   * the URL. That is precisely what a designer reports as "I added it and no
   * styles showed up": the row installs, the counts read zero, and nothing
   * reaches the pickers.
   *
   * The custom properties in that CSS are the design system, and this editor
   * already knows how to read them — `parseLibrary('css', …)` is the same
   * function the local-file lane uses on a `tokens.css`. It was simply never
   * reachable from a URL, because the branch above only ever sees JSON.
   *
   * Preview documents first, then the pasted page: see `previewEntries` for why
   * that order decides whether the answer is the design system or the tool's
   * own chrome. Everything is fetched in one parallel round and read in order,
   * the same shape the probes above use, so latency does not decide the reading.
   */
  const component = page.ok ? componentFromPage(url, page.text) : null
  let tokenCatalog = null
  let tokenDetail = ""

  if (!pageWalled) {
    const entries = previewEntries(url)
    const previews = await Promise.all(entries.map((entry) => fetchLibraryUrl(entry, probeOptions)))

    const documents = []
    entries.forEach((entry, index) => {
      const response = previews[index]
      if (!response?.ok || !response.text.trim()) return
      if (page.ok && servesTheShell(response.text, entry, page.text, url)) return
      // Tier 0: a preview document. Its sheets are the system's, not the tool's.
      documents.push({ text: response.text, from: entry, tier: 0 })
    })
    if (page.ok && page.text.trim()) documents.push({ text: page.text, from: url, tier: 1 })

    const tokens = await tokensFromDocuments(documents, name, styleOptions)
    if (tokens) {
      tokenCatalog = tokens.catalog
      tokenDetail = tokens.detail
    }
  }

  /*
   * A page can be BOTH, and returning only one of them was throwing away half
   * the answer. The URL a designer pastes is usually a component's own page, so
   * the page names a component and the stylesheet beside it carries the system
   * that component is built from. Merged, one paste gives the row its component
   * and the pickers their tokens.
   */
  if (tokenCatalog) {
    const catalog = component
      ? { ...tokenCatalog, components: [component] }
      : tokenCatalog
    const detail = component
      ? [tokenDetail, describeComponents([component])].filter(Boolean).join(" · ")
      : tokenDetail
    return { name, catalog, detail, via: "stylesheets", error: "" }
  }

  /*
   * A lone component beside walled probes carries the challenge as `signIn`:
   * the row installs — the page was public and named a component — and the
   * panel can still offer the sign-in that may read the whole index. It is
   * NOT `auth`, which means "refused: not a library until somebody signs in",
   * and which the store answers by declining to install the row at all.
   */
  if (component) {
    return {
      name,
      catalog: { ...emptyCatalog(name), components: [component] },
      detail: describeComponents([component]),
      via: "component",
      ...(probesWalled ? { signIn: probeChallenge ?? weakestChallenge(url) } : {}),
      error: "",
    }
  }

  const walled = pageWalled || probesWalled
  // Three different failures, and a designer can act on each of them only if
  // they are told apart: signed out, unreachable, or reachable and empty.
  /*
   * `auth` is what separates "signed out" from the other two failures for a
   * CALLER, where `error` only separates them for a reader.
   *
   * It matters because the two are acted on differently: an unreachable or
   * empty URL is a row the designer can retry or remove, and a walled one is
   * not a library at all until somebody signs in. `libraries.mjs` refuses to
   * install the second kind, and it can only do that if the distinction
   * survives the trip out of here as data rather than as a sentence.
   *
   * The page's own reading of the wall is preferred over a probe's: the
   * probes are paths this module guessed at, and a 404 behind the wall can
   * classify differently from the document the designer named.
   */
  return {
    name,
    catalog: emptyCatalog(name),
    detail: "",
    auth: walled ? (pageWalled ? page.wall : null) ?? probeChallenge ?? weakestChallenge(url) : null,
    error: walled
      ? SSO_SENTENCE
      : page.ok || !page.error
        ? NOTHING_SENTENCE
        : `${page.error}. ${CHECK_SENTENCE}`,
  }
}

/**
 * A classified challenge's stand-in, when a wall was reported and the reading
 * of it was lost: it claims the least — a sign-in redirect, this origin, and
 * nothing it cannot back up. It deliberately does NOT invent an audience or a
 * realm, because the panel offers a copy button for each and a button that
 * copies an empty string is worse than an absent row.
 */
function weakestChallenge(url) {
  return { kind: "redirect", origin: originOf(url), audience: "", realm: "", location: "", hint: "" }
}

/** A response's body as JSON, or undefined when it is not a readable answer. */
function parsedJson(response) {
  if (!response?.ok || !response.text.trim()) return undefined
  try {
    return JSON.parse(response.text)
  } catch {
    return undefined
  }
}

/** A parsed story index's components, or null when it is not one or lists none. */
function storyIndexComponents(json) {
  const parsed = json === undefined ? null : parseStorybookIndex(json)
  return parsed?.components.length ? parsed.components : null
}

/**
 * One probe's answer as a reading: a story index, else a token file. Parsed
 * once and handed to both questions.
 *
 * A probe that answered with HTML is a site serving its app shell for every
 * path. It is not a catalog, and it is not an error either — and it is never
 * handed to the stylesheet sniffer, which would read an inline theme block in
 * the shell as the site's design system.
 */
function readProbe(probe, response, name) {
  const json = parsedJson(response)
  if (json === undefined) return null
  const components = storyIndexComponents(json)
  if (components) {
    return {
      catalog: { ...emptyCatalog(name), components },
      detail: describeComponents(components),
      via: "index",
    }
  }
  const tokens = catalogFromTokenText(probe, response.text, name, json)
  return tokens ? { catalog: tokens.catalog, detail: tokens.detail, via: "probe" } : null
}
