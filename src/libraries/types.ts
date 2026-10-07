/**
 * The shapes a library arrives in, stated once for the browser half.
 *
 * These are wire types rather than model types: the server discovers a file,
 * parses it into a catalog and sends it down, and nothing on this side ever
 * constructs one from scratch. That is why they are interfaces over plain JSON
 * with no methods and no classes — anything richer would be a second model of a
 * thing whose only author is the parser at the other end of the loopback.
 *
 * Two of them are deliberately NOT redeclared here. A library's token is a host
 * token, in the same shape, going into the same pickers, matched by the same
 * code — so `LibraryToken` is an alias of `DesignSystemToken` rather than a
 * twin of it, and a field added to one cannot silently fail to arrive in the
 * other. The same reasoning covers icon nodes: a library's drawing is drawn by
 * `drawHostIcon`, so it is typed as the node array that function already takes.
 * The one thing a library's tokens carry that a host's do not — which library
 * they came from — lives on `DesignSystemToken` as two optional fields, because
 * a merged catalog is a single list and the merge has to survive the trip.
 */

import type { DesignSystemToken } from "../core/config"
import type { IconNode } from "../core/icons"

/**
 * The six kinds of source the editor can read a design system out of.
 *
 * Four of them name a text file the server parses. `components` names a
 * DIRECTORY of React or Angular source that is scanned rather than parsed, and
 * `url` names a page on the internet — a Storybook, a documentation site, a
 * token file served over HTTP — that the server fetches. All six are source
 * kinds all the same, because from here the difference is invisible: something
 * was added, and a catalog came back.
 */
export type LibrarySourceKind = "manifest" | "css" | "tokens" | "icons" | "components" | "url"

export interface LibrarySource {
  kind: LibrarySourceKind
  /**
   * POSIX, project-relative, e.g. "src/styles/tokens.css". Never absolute.
   *
   * A `url` library puts the WHOLE URL in this field rather than in one of its
   * own. That is deliberate: every consumer of a source — the row that reads it
   * back to the designer, the dedupe that decides two libraries are the same
   * one, the removal that matches on it — already works on this string, and a
   * parallel field would have meant teaching all of them a second place to look
   * for the same fact.
   */
  path: string
}

/**
 * What a library brings, as numbers, so a card can say it without holding the
 * catalog it is counting. The two icon fields are different facts and both are
 * needed: `icons` is the SIZE scale a design system publishes, `iconDrawings`
 * is how many glyphs it ships — a library can have either, both or neither.
 */
export interface LibraryCounts {
  colors: number
  spacing: number
  radii: number
  textStyles: number
  effects: number
  icons: number
  motion: number
  components: number
  iconDrawings: number
}

/**
 * A library's token, which is a design-system token and nothing else.
 *
 * The alias is load-bearing rather than cosmetic. Every panel in the inspector
 * reads `DesignSystemToken`, and the merge in `store.ts` puts library tokens
 * into the very arrays those panels walk; declaring a parallel interface here
 * would compile for exactly as long as the two definitions agreed, and would
 * then start failing at the one call site nobody thought to check.
 */
export type LibraryToken = DesignSystemToken

/**
 * A component a library documents: what it is called, what it takes, and what
 * to paste. A documented prop reaches the page only as a live attribute PREVIEW
 * and never as a source edit — see the header comment on
 * `panels/inspector/section-instance.ts` for the evidence gate that decides
 * which of these get a control at all, and why the rest are stated.
 */
export interface LibraryComponent {
  /** "component:<slug>". */
  id: string
  name: string
  description?: string
  /**
   * The custom-element tag this component answers to, when the framework it was
   * written in has one. Angular declares it, React has none — and on an Angular
   * host the DOM tag IS the selector, which is the only join between a live
   * element and a component the library documents that does not go through a
   * name two different people spelled two different ways.
   */
  selector?: string
  /** What to paste, e.g. `<Button variant="primary">Label</Button>`. */
  snippet?: string
  /**
   * `default` is the value the source itself declares, and it is what the
   * details popover preselects. Without it the popover opens on whichever value
   * happened to be listed first, and "Insert instance" places a variant the
   * component's own author did not choose — right often enough to look correct,
   * wrong often enough to be a bug nobody reports.
   */
  props?: Array<{ name: string; type?: string; values?: string[]; default?: string }>
  /**
   * The four fields below are produced by SCANNING a component library on disk,
   * so a component that arrived from a hand-written manifest carries none of
   * them. All four are optional for that reason, and a consumer that needs one
   * has to cope with its absence rather than assume a scanner produced it.
   */
  /** The folder it lives in, title-cased; "" at the library root. The Assets
   *  panel's first navigation level lists these. */
  group?: string
  /** The declaring file, relative to the project root. */
  file?: string
  /** The identifier to import. "" for a default export, and ALSO "" for a
   *  component that is declared but never exported — `defaultExport` separates
   *  the two. */
  exportName?: string
  /**
   * True only for a real default export. The pair `{ exportName: "",
   * defaultExport: false }` is the third state: declared, never exported, and
   * therefore not importable — an insertion must write NO import for it rather
   * than guess a name, which would ship a build error the user cannot see.
   */
  defaultExport?: boolean
}

/**
 * One glyph from an icon library.
 *
 * `nodes` is the host icon node array because these are drawn by the same
 * function the host's own icons are — an icon that came from a library must be
 * indistinguishable in the picker, or the picker has two rendering paths and
 * one of them is only exercised when somebody adds a library.
 */
export interface LibraryIconDrawing {
  name: string
  nodes: IconNode[]
  rootFill: string
  rootStroke?: string
  /**
   * True for a library that names the glyphs of an icon FONT rather than
   * carrying their path data, which is how a good half of them ship. There is
   * nothing to draw for one of these — `nodes` is empty — and the name is the
   * whole of what the library knows, so a surface listing them renders the name
   * in the font instead of inlining an SVG that would come out blank.
   */
  glyph?: boolean
}

export interface LibraryCatalog {
  name: string
  trackingUnit: "em" | "px"
  colors: LibraryToken[]
  spacing: LibraryToken[]
  radii: LibraryToken[]
  textStyles: LibraryToken[]
  uiTextStyles: LibraryToken[]
  effects: LibraryToken[]
  icons: LibraryToken[]
  motion: LibraryToken[]
  components: LibraryComponent[]
  /**
   * ALWAYS empty in a catalog that came from the list endpoint. Path data is
   * the biggest thing a library has and most sessions never open the icon
   * picker, so the drawings are served by their own request and folded in by
   * `loadLibraryIcons`. `counts.iconDrawings` still reports the real number.
   */
  iconDrawings: LibraryIconDrawing[]
  /** The attribute this library's glyphs name themselves with, "" when none. */
  iconAttribute: string
}

export interface Library {
  /** Slug of `source.path`; also the prefix every merged token id carries. */
  id: string
  name: string
  enabled: boolean
  source: LibrarySource
  /** Epoch ms. */
  addedAt: number
  counts: LibraryCounts
  catalog: LibraryCatalog
  /**
   * One line summarising what was found, e.g. "38 components · 210 variants".
   *
   * Only a `url` library carries it, because only a `url` library has something
   * to say that the counts do not: a local file's numbers are the whole story,
   * while a remote catalog is a guess about a site's shape and the sentence is
   * how a designer checks the guess before trusting it.
   */
  detail?: string
  /**
   * Present and non-empty ONLY when the source could not be read or parsed on
   * this pass. The row survives the failure on purpose: losing it would take
   * with it the only control that can remove the thing that is failing. A URL
   * behind a sign-in wall is the commonest instance — the library is added, the
   * catalog is empty, and this says what to do about it.
   */
  error?: string
}

/** A design-system file the project has that the editor recognises. */
export interface LibraryCandidate {
  /** Project-relative POSIX. */
  path: string
  kind: LibrarySourceKind
  name: string
  /** One line, e.g. "48 custom properties". */
  detail: string
  installed: boolean
}

/* ---------- signing in to a walled origin ---------- */

/**
 * The two shapes a credential can take on the wire, and the whole of the set.
 *
 * `server/library-auth.mjs` turns a `bearer` into an `Authorization` header and
 * a `cookie` into a `Cookie` one, and refuses anything else by name — a third
 * value would be a header of the caller's choosing sent to an arbitrary host.
 * So this is a closed union rather than a `string`: the panel offers exactly
 * two buttons because the server accepts exactly two words.
 */
export type LibraryCredentialScheme = "bearer" | "cookie"

/**
 * A sign-in wall, as the SERVER read it off the refusal.
 *
 * This is the one wire type that is not a description of a library — it is a
 * description of why there isn't one. A walled URL is never installed (the add
 * throws before anything is written), so the panel has no row to hang the
 * problem on and this object is the entire brief for what to do next: which
 * kind of wall, whose origin, the sentence to show, and the two strings the
 * refusal named that a person has nowhere else to read.
 *
 * `kind` names a MECHANISM and never a vendor, because that is all the server
 * can honestly know: it classifies by HTTP and OAuth alone — the scheme in a
 * 401's `WWW-Authenticate`, a cross-origin redirect carrying an authorization
 * request, a 403 — and has no way to tell whose identity provider it has walked
 * into. A kind that named one would be right for a single company's stack and
 * quietly wrong everywhere else. The panel branches on it for exactly two
 * things, the label on the block and which credential to offer first;
 * everything a designer READS comes from `hint`, which the server writes per
 * case.
 *
 * `audience` and `realm` are the two facts on this object that a designer
 * cannot look up for themselves, which is why both are worth carrying and worth
 * a copy button at the other end. Each is empty unless the refusal named it, so
 * a challenge can carry neither — the `hint` still says what to paste, and a
 * block that draws nothing for an absent field is the correct degradation.
 *
 * `url` is the URL the add was refused for, not the origin, because signing in
 * is verified by re-fetching that exact address. `origin` is what a credential
 * is FILED under — two deep links into one Storybook are two libraries and one
 * sign-in — and the two must not be confused at the call site.
 */
export interface LibraryChallenge {
  kind: "oauth" | "basic" | "bearer" | "redirect" | "forbidden"
  /** Scheme and host, e.g. "https://storybook.example.com". Never a path. */
  origin: string
  /**
   * The OAuth `client_id` the redirect carried, and "" when there was none.
   *
   * RFC 6749 §4.1.1 makes it mandatory on an authorization request, so it is
   * generic across providers rather than a fact about one. It matters because
   * it is the AUDIENCE an identity token has to be minted for, and nothing else
   * in the exchange names it.
   */
  audience: string
  /** The `WWW-Authenticate` realm a 401 named, and "" for every other wall. */
  realm: string
  /**
   * The redirect the site answered with, and "" when it answered with none.
   *
   * Reported rather than interpreted by the server — `classifyWall` refuses to
   * look at hostnames, on purpose — so that this side can name the identity
   * provider on a button. Being wrong about the name costs a generic label;
   * being wrong in the classifier would cost the classification, which is why
   * the two live apart.
   */
  location: string
  /** The server's own sentence about this wall. Always present. */
  hint: string
  /** The URL the refused add was for, which signing in re-fetches to verify. */
  url: string
}

/**
 * An origin this editor holds a credential for, WITHOUT the credential.
 *
 * The secret never comes back out of the server — `listOrigins` reports these
 * three fields and nothing else — so this type is the whole of what the browser
 * can ever know about a stored sign-in. That is a property worth stating in the
 * type rather than only in the server's comment: a field added here later would
 * be a field somebody expected to arrive over the wire, and the value is the
 * one field that never will.
 */
export interface LibrarySignIn {
  origin: string
  scheme: LibraryCredentialScheme
  /** Epoch ms, or 0 for a record written before the field existed. */
  addedAt: number
}
