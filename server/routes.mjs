/**
 * Design-editor HTTP routes, mounted in front of the Next app by the dev proxy.
 *
 * Everything sits under one configured prefix so the proxy can hand off with a
 * single check, and every route is loopback-only: this process writes project
 * files, so a page on another origin must never be able to reach it.
 *
 * The prefix is the same value the browser reads as `apiBase` from the injected
 * config, so the two halves of the contract cannot drift apart.
 */

import { resolveConfig } from "../config.mjs"
import { createAgent } from "./agent.mjs"
import { createAngularSource } from "./angular-source.mjs"
import { createAppSwitcher } from "./apps.mjs"
import { createComponentUsage } from "./component-usage.mjs"
import { handoffQueue } from "./handoff.mjs"
import { createControlDefaults } from "./control-defaults.mjs"
import { createDesignLint } from "./design-lint.mjs"
import { createIconSet } from "./icon-set.mjs"
import { createAuthStore } from "./library-auth.mjs"
import { createBrowserSignIn } from "./library-signin.mjs"
import { createLibraryStore } from "./libraries.mjs"
import { fetchLibraryUrl } from "./library-url.mjs"
import { createOptionsStore, normalizeOptionSet } from "./options-store.mjs"
import { createPageCatalog } from "./pages.mjs"
import { createReactSource } from "./react-source.mjs"
import { readInsertOperations } from "./source-insert.mjs"
import { createVariantCatalog } from "./variants.mjs"

const MAX_BODY_BYTES = 1024 * 1024
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])
// Option keys are `Component:line:step/step/…` — `elementKey()` joins up to six
// DOM steps with `/`, so the separator has to be legal or every real element is
// refused. The key is only ever an object key in one JSON file, never a path,
// so `/` cannot traverse; `..` is rejected anyway to keep the guard meaningful.
const KEY_PATTERN = /^[A-Za-z0-9_.:?@/-]{1,200}$/
const TRAVERSAL_PATTERN = /(^|\/)\.\.(\/|$)/
// A library id is a slug this server minted itself (`libraryId` in
// `library-sources.mjs`), so anything outside `[a-z0-9-]` is a client composing
// paths rather than echoing back an id it was handed.
const LIBRARY_ID_PATTERN = /^[a-z0-9-]{1,200}$/

function badRequest(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function hostnameOf(value) {
  if (typeof value !== "string" || value.length === 0) return ""
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`)
    return url.hostname.replace(/^\[|\]$/g, "")
  } catch {
    return ""
  }
}

function isLoopbackHost(value) {
  const host = hostnameOf(value)
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
}

/**
 * `"null"` is NOT an exemption. It is the Origin a sandboxed iframe, a
 * `data:`/`blob:` document, or a redirected cross-origin form sends, and those
 * are precisely the contexts an attacker controls. Treating it as "no origin"
 * let any page reach these routes with a CORS-preflight-free request.
 *
 * A genuinely absent header still passes: curl and the test harness send none,
 * and a non-browser client carries no ambient credentials to abuse.
 *
 * Exported because the MCP endpoint on its own port needs exactly this check —
 * the transport spec requires Origin validation against DNS rebinding, and a
 * second implementation of it is how the two come to disagree about `"null"`.
 */
export function isLocalRequest(req) {
  if (!LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress ?? "")) return false
  if (!isLoopbackHost(req.headers.host)) return false
  const origin = req.headers.origin
  if (origin !== undefined && !isLoopbackHost(origin)) return false
  return true
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
  })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw badRequest("Request body is too large", 413)
    chunks.push(chunk)
  }
  if (size === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw badRequest("Request body is not valid JSON")
  }
}

function optionKey(segment) {
  let decoded
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    return null
  }
  if (!KEY_PATTERN.test(decoded)) return null
  return TRAVERSAL_PATTERN.test(decoded) ? null : decoded
}

function libraryRouteId(segment) {
  let decoded
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    throw badRequest("Invalid library id")
  }
  if (!LIBRARY_ID_PATTERN.test(decoded)) throw badRequest("Invalid library id")
  return decoded
}

/**
 * The Libraries tab's six verbs, grouped for the same reason the Angular pair
 * is: the id-bearing forms need two patterns plus an ordering rule between them,
 * and inlining that into `route` buries the rule where the next edit will step
 * on it.
 *
 * The rule: `/libraries/available` is a literal segment that also satisfies the
 * id pattern, so it has to be tested BEFORE the `<id>` forms or a scan answers
 * as a lookup for a library nobody added.
 *
 * Drawings have their own endpoint rather than riding along in `GET /libraries`
 * because they are path data — the reason `server/icon-set.mjs` serves the
 * host's own set on request instead of shipping it in the prelude. The panel
 * lists libraries on every refresh and opens the icon picker almost never.
 *
 * Path safety lives in the store, not here. The loopback guard `handle` applies
 * says the request came from this machine; it says nothing about whether the
 * `path` in the body is one this process may read, and only the store knows
 * where the project root is. The same applies to the `url` a POST may carry
 * instead of a `path`: whether it is a fetchable web address is the store's
 * question, and a second opinion here is one more thing to keep in step.
 *
 * The bodies are passed through whole for that reason. A POST is `{ path }` or
 * `{ url }`, and a PATCH is any of `{ enabled }`, `{ name }` or
 * `{ refresh: true }` — this layer checks only that it was handed an object,
 * because every rule about what is IN that object lives one module down.
 */
function libraryRoutes(libraries, auth, signin, rest, req, res, url, readBody) {
  if (rest !== "/libraries" && !rest.startsWith("/libraries/")) return null

  if (rest === "/libraries" && req.method === "GET") {
    return libraries.list().then((payload) => sendJson(res, 200, payload))
  }

  if (rest === "/libraries" && req.method === "POST") {
    return readBody().then(async (body) => {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw badRequest("Adding a library needs a path inside the project, or a url")
      }
      sendJson(res, 200, await libraries.add(body))
    })
  }

  // Before the `<id>` patterns, on purpose. See the header comment.
  if (rest === "/libraries/available" && req.method === "GET") {
    return libraries.discover().then((payload) => sendJson(res, 200, payload))
  }

  /*
   * Signing in by opening the SITE'S OWN sign-in, which is the path a designer
   * should ever see.
   *
   * `POST /libraries/auth` below takes a credential the designer went and found
   * — a bearer token, a cookie out of dev tools. That route still exists, for
   * the sites this one cannot open, but it is not the offer any more: nobody
   * building a component list should have to learn what an audience is or how
   * their company mints an identity token. Here the editor opens the wall in a
   * browser window, the provider runs the sign-in it always runs, and the
   * session that produces is captured on the designer's behalf.
   *
   * It ends in exactly the same place as the paste — verified against the live
   * URL, then stored — because the invariant that makes the panel trustworthy
   * is that a stored credential has been seen to work, and how it was obtained
   * does not change that.
   */
  if (rest === "/libraries/auth/signin" && req.method === "POST") {
    return readBody().then(async (body) => {
      const target = String(body?.url ?? "").trim()
      if (!target) throw badRequest("Signing in needs the url that was refused")

      const outcome = await signin.signIn(target)
      if (!outcome.ok) {
        // Not a 500: a person closing the window, or a provider that grants no
        // reusable session, is an ordinary outcome with a sentence attached.
        return sendJson(res, 200, {
          ok: false,
          reason: outcome.reason,
          provider: outcome.provider ?? "",
        })
      }

      const credential = { scheme: "cookie", value: outcome.cookie }
      const probe = await fetchLibraryUrl(target, { credential })
      if (probe.sso || !probe.ok) {
        return sendJson(res, 200, {
          ok: false,
          provider: outcome.provider ?? "",
          reason: probe.sso
            ? "The sign-in worked in the window, but the site still refuses the editor. This one " +
              "may need a token."
            : `The site answered HTTP ${probe.status} after signing in`,
        })
      }

      const saved = await auth.saveCredential({ url: target, ...credential })
      return sendJson(res, 200, { ok: true, provider: outcome.provider ?? "", ...saved })
    })
  }

  /** Whether this machine can open a sign-in window at all, for the panel's offer. */
  if (rest === "/libraries/auth/signin" && req.method === "GET") {
    return signin.available().then((available) => sendJson(res, 200, { available }))
  }

  /*
   * The credential a designer went and found, for the sites the window above
   * cannot open, and the reason it is three verbs on one path.
   *
   * A credential belongs to an ORIGIN, not to a library: two deep links into
   * one Storybook are two libraries and one sign-in, and signing in for the
   * second after adding the first must not mean holding the same token twice.
   * So the resource here is the origin, and libraries merely benefit.
   *
   * Also before the `<id>` patterns — `auth` is a legal library id shape, and
   * `/libraries/auth` would otherwise be read as a library called "auth".
   */
  if (rest === "/libraries/auth") {
    if (req.method === "GET") {
      return auth.listOrigins().then((origins) => sendJson(res, 200, { origins }))
    }

    if (req.method === "POST") {
      return readBody().then(async (body) => {
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw badRequest("Signing in needs a url, a scheme and a value")
        }
        /*
         * VERIFIED BEFORE IT IS STORED, and this is the line that makes the
         * whole flow trustworthy.
         *
         * A credential that does not work, stored anyway, produces a panel
         * that says the designer is signed in to an origin whose libraries
         * still refuse to load — and they will then look for the fault
         * anywhere except the token they just pasted. So the wall has to
         * actually open, here, before anything touches the disk.
         */
        const probe = await fetchLibraryUrl(String(body.url ?? ""), {
          credential: { scheme: body.scheme, value: body.value },
        })
        if (probe.sso) {
          throw badRequest(
            "The site refused that credential and still asked for sign-in. Check that it has not " +
              "expired, and that it belongs to this site."
          )
        }
        if (!probe.ok) {
          throw badRequest(
            `That credential did not get through: ${probe.error || `the site answered HTTP ${probe.status}`}`
          )
        }
        sendJson(res, 200, await auth.saveCredential(body))
      })
    }

    if (req.method === "DELETE") {
      // The origin rides in the body rather than the path, the way
      // `/lint/ignore` carries its ids: an origin contains slashes and a colon,
      // and a path segment holding an encoded URL is a thing two layers then
      // have to agree about how to unescape.
      return readBody().then(async (body) => {
        const origin = String(body?.origin ?? "").trim()
        if (!origin) throw badRequest("Forgetting a sign-in needs the origin it belongs to")
        const forgotten = await auth.forgetCredential(origin)
        /*
         * And the session in the browser profile, which is the half that makes
         * the promise true.
         *
         * Not awaited into the answer's success: the credential is already
         * gone, which is what the panel reports and what stops the libraries
         * loading. If the browser cannot be opened to finish the job, the right
         * outcome is a forget that happened rather than an error about a
         * cleanup step the designer never asked about by name.
         */
        void signin.forgetOrigin(origin).catch(() => {})
        sendJson(res, 200, forgotten)
      })
    }
  }

  const drawings = /^\/libraries\/([^/]+)\/icons$/.exec(rest)
  if (drawings && req.method === "GET") {
    return libraries
      .icons(libraryRouteId(drawings[1]))
      .then((payload) => sendJson(res, 200, payload))
  }

  const keyed = /^\/libraries\/([^/]+)$/.exec(rest)
  if (keyed) {
    const id = libraryRouteId(keyed[1])

    if (req.method === "PATCH") {
      return readBody().then(async (body) => {
        if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
          throw badRequest("A library update needs an object")
        }
        sendJson(res, 200, await libraries.update(id, body ?? {}))
      })
    }
    if (req.method === "DELETE") {
      return libraries.remove(id).then((payload) => sendJson(res, 200, payload))
    }
  }

  throw badRequest(`No designlayer route for ${req.method} ${url.pathname}`, 404)
}

/**
 * The Audit's five verbs, grouped for the reason the library ones are: the
 * ignore pair shares a path and differs only by method, and a reader looking
 * for "what can the audit do" should find all of it in one place.
 *
 * `/lint/ignore` carries its ids in the body on DELETE as well as on POST. A
 * dismissal is a set of ids, a query string holding fifty of them is past what
 * a URL should be asked to carry, and the two halves of one toggle reading
 * their input from two different places is how they come to disagree about
 * what an empty request means.
 *
 * Nothing here validates a finding id: the store owns that, because only the
 * store knows what shape of id it minted, and a second opinion about it here
 * would be one more thing to keep in step.
 */
function lintRoutes(lint, rest, req, res, url, readBody) {
  if (rest !== "/lint" && !rest.startsWith("/lint/")) return null

  if (rest === "/lint/tools" && req.method === "GET") {
    return lint.tools().then((payload) => sendJson(res, 200, payload))
  }

  if (rest === "/lint/run" && req.method === "POST") {
    return readBody().then(async (body) => {
      if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
        throw badRequest("An audit run needs an object")
      }
      sendJson(res, 200, await lint.run(body ?? {}))
    })
  }

  if (rest === "/lint/fix" && req.method === "POST") {
    return readBody().then(async (body) => sendJson(res, 200, await lint.fix(body ?? {})))
  }

  if (rest === "/lint/ignore") {
    if (req.method === "GET") {
      return lint.ignored().then((payload) => sendJson(res, 200, payload))
    }
    if (req.method === "POST") {
      return readBody().then(async (body) => sendJson(res, 200, await lint.ignore(body ?? {})))
    }
    if (req.method === "DELETE") {
      return readBody().then(async (body) => sendJson(res, 200, await lint.unignore(body ?? {})))
    }
  }

  throw badRequest(`No designlayer route for ${req.method} ${url.pathname}`, 404)
}

function controlTarget(searchParams) {
  const group = searchParams.get("group")?.trim() ?? ""
  const key = searchParams.get("key")?.trim() ?? ""
  if (!group || !key || group.length > 200 || key.length > 200) {
    throw badRequest("Control default needs a group and key")
  }
  return { group, key }
}

/**
 * The two Angular verbs, which exist because the vendored engine has no
 * equivalent for either.
 *
 * `/angular/source` answers "where is this element written". On React that
 * answer comes from a fiber walk in the browser; here the browser can only read
 * a component CLASS NAME off Angular's `ng` global, and turning that into a
 * file means reading the project, which only this side can do.
 *
 * `/angular/apply` is what "Apply to code" calls instead of the vendor's
 * `commitBatch` WebSocket message. It is a plain HTTP route rather than a
 * second socket because it is request/response — the browser needs to be told
 * which operations landed and which did not, and the vendor's protocol has no
 * verb that answers.
 */
function angularRoutes(angular, framework, rest, req, res, url, readBody) {
  if (!rest.startsWith("/angular/")) return null
  if (framework !== "angular") {
    throw badRequest("This project is not an Angular host", 409)
  }

  if (rest === "/angular/source" && req.method === "GET") {
    const componentName = url.searchParams.get("component")?.trim() ?? ""
    if (!componentName) throw badRequest("Angular source lookup needs a component")
    let descriptor = null
    const raw = url.searchParams.get("target")
    if (raw) {
      try {
        descriptor = JSON.parse(raw)
      } catch {
        throw badRequest("Angular target descriptor is not valid JSON")
      }
    }
    return sendJson(res, 200, { source: angular.resolve(componentName, descriptor) })
  }

  if (rest === "/angular/apply" && req.method === "POST") {
    return readBody().then((body) => {
      const operations = Array.isArray(body?.operations) ? body.operations : null
      if (!operations) throw badRequest("Angular apply needs an operations array")
      if (operations.length > 500) throw badRequest("Too many operations in one apply")
      sendJson(res, 200, angular.apply(operations))
    })
  }

  throw badRequest(`No designlayer route for ${req.method} ${url.pathname}`, 404)
}

/**
 * Deleting an element, the one write both hosts route through this server.
 *
 * Every other source write is host-specific by construction — React's go down
 * the vendored engine's WebSocket, Angular's through `/angular/apply` — and a
 * removal is the first one neither of those can express. So the browser sends
 * one shape and the framework decides what a removal means: a template splice
 * on Angular, a JSX splice on React. Keeping the fork here rather than in the
 * browser is what lets the canvas, the layers panel and the toolbar hold one
 * delete command instead of two that have to be kept in step.
 */
async function removeElements(angular, react, framework, body) {
  const operations = Array.isArray(body?.operations) ? body.operations : null
  if (!operations) throw badRequest("Delete needs an operations array")
  if (operations.length > 200) throw badRequest("Too many elements in one delete")
  for (const operation of operations) {
    if (!operation?.target?.tagName) throw badRequest("Each delete needs a target element")
  }

  if (framework !== "angular") return react.remove(operations)
  return angular.apply(
    operations.map((operation) => ({
      op: "removeElement",
      componentName: operation.componentName,
      target: operation.target,
    }))
  )
}

/**
 * Inserting an element, the sibling of the removal above and the same bargain.
 *
 * The browser sends one shape and the framework decides what placing a
 * component means in the language the project is written in: a template splice
 * plus a standalone `imports` entry on Angular, a JSX splice plus an ES import
 * on React. The fork stays here for the reason the deletion's does — the assets
 * panel, the canvas drop target and the details popover all issue one insert
 * command rather than two that have to be kept in step.
 *
 * It differs from the deletion in one way worth stating. A removal's inputs are
 * a description of something the user is already looking at; an insertion's
 * include `markup`, which this process writes into the user's source verbatim.
 * That makes the request shape a safety boundary rather than a convenience, so
 * it is validated in full — every field, and the markup against an allowlist —
 * before either host is handed anything. `readInsertOperations` throws on a
 * violation, which lands as a 400 here and never reaches a file.
 */
async function insertElements(angular, react, framework, body) {
  const operations = readInsertOperations(body)
  if (framework !== "angular") return react.insert(operations)
  return angular.apply(operations)
}

async function route(store, defaults, agent, icons, libraries, auth, signin, lint, variants, pages, usage, apps, angular, react, framework, prefix, mcpPort, req, res, url) {
  const { pathname, searchParams } = url
  const rest = pathname.slice(prefix.length)

  const handled = angularRoutes(angular, framework, rest, req, res, url, () => readJsonBody(req))
  if (handled !== null) return handled

  const library = libraryRoutes(libraries, auth, signin, rest, req, res, url, () => readJsonBody(req))
  if (library !== null) return library

  const audit = lintRoutes(lint, rest, req, res, url, () => readJsonBody(req))
  if (audit !== null) return audit

  if (rest === "/source/remove" && req.method === "POST") {
    sendJson(res, 200, await removeElements(angular, react, framework, await readJsonBody(req)))
    return
  }

  if (rest === "/source/insert" && req.method === "POST") {
    sendJson(res, 200, await insertElements(angular, react, framework, await readJsonBody(req)))
    return
  }

  if (rest === "/options" && req.method === "GET") {
    sendJson(res, 200, await store.readOptionSets())
    return
  }

  if (rest === "/control-default") {
    const { group, key } = controlTarget(searchParams)
    if (req.method === "GET") {
      sendJson(res, 200, await defaults.read(group, key))
      return
    }
    if (req.method === "PUT") {
      const body = await readJsonBody(req)
      if (!body || typeof body !== "object" || !("value" in body)) {
        throw badRequest("Control default PUT needs a value")
      }
      sendJson(res, 200, await defaults.write(group, key, body.value))
      return
    }
    if (req.method === "DELETE") {
      sendJson(res, 200, await defaults.remove(group, key))
      return
    }
  }

  const keyed = /^\/options\/([^/]+)$/.exec(rest)
  if (keyed) {
    const key = optionKey(keyed[1])
    if (!key) throw badRequest("Invalid option key")

    if (req.method === "PUT") {
      const set = normalizeOptionSet(await readJsonBody(req), key)
      if (!set) throw badRequest("Invalid option set")
      sendJson(res, 200, await store.writeOptionSet(set))
      return
    }
    if (req.method === "DELETE") {
      sendJson(res, 200, { ok: await store.deleteOptionSet(key) })
      return
    }
  }

  if (rest === "/icons" && req.method === "GET") {
    sendJson(res, 200, icons.read())
    return
  }

  // The variant axes a component declares. Read-only, and behind the same
  // loopback guard as everything else: it reads a project file, which is
  // exactly the capability the guard exists to keep on this machine.
  if (rest === "/variants" && req.method === "GET") {
    sendJson(res, 200, variants.read(searchParams.get("file") ?? ""))
    return
  }

  // The host app's routes, which canvas mode lays out as one frame each. The
  // tree is walked on every request and only unchanged files are answered from
  // cache, because the designer adding a page while the board is open is the
  // case it must show.
  if (rest === "/pages" && req.method === "GET") {
    sendJson(res, 200, await pages.read())
    return
  }

  // How many places render this component, which the inspector asks before it
  // lets a designer edit a shared one. Read-only, and loopback-only like every
  // other route: it walks the whole project, which is precisely the capability
  // the guard exists to keep on this machine.
  if (rest === "/component/usage" && req.method === "GET") {
    const found = await usage.read(searchParams.get("name") ?? "", searchParams.get("definedIn") ?? "")
    sendJson(res, 200, found)
    return
  }

  /*
   * Where to point a coding agent, and whether one has turned up.
   *
   * The whole of MCP setup, as far as a designer is concerned, is one URL that
   * has to get into their agent's config file — and then the question nobody
   * could previously answer from inside the editor: did that work? The launcher
   * prints the URL once at startup, in a terminal most designers never see, and
   * the browser is deliberately unable to probe the MCP port itself (`mcp.mjs`
   * refuses a non-JSON content type precisely so a page cannot reach it). So
   * this route relays what the server already knows.
   *
   * `connected` is latched and `waiting` is not, and the pair is what makes an
   * honest status line. An agent parked in `wait_for_change` shows as waiting;
   * an agent that is attached but mid-turn shows as connected-but-not-waiting,
   * which is a working setup and must not read as a broken one. Reporting only
   * `waiting` would have the panel flicker to "disconnected" every time the
   * agent went off to do the work it was just asked for.
   *
   * `url` is null when the port never bound — taken, or disabled by config —
   * and the panel says that instead of printing an address nothing answers.
   * The configured port alone is not evidence: a second editor started on the
   * default port logs that it is taken, and printing it anyway pointed the
   * designer's agent at the FIRST editor's project.
   */
  if (rest === "/mcp/status" && req.method === "GET") {
    const queue = handoffQueue()
    // Passed in rather than read off a `config` in scope: this function takes
    // its dependencies as arguments, and the free reference this replaces threw
    // a ReferenceError on every call — the route answered 500 for its whole
    // life, so the panel could only ever report the endpoint as unreachable.
    const port = queue.endpointListening ? (mcpPort ?? null) : null
    sendJson(res, 200, {
      url: port ? `http://127.0.0.1:${port}/mcp` : null,
      port,
      // THREE facts, not one, because they fail independently and a designer
      // needs to know which one is missing.
      //
      // `listening` is our own port: false means nothing can ever connect, and
      // the address is not worth copying. `agents` is how many have actually
      // completed an MCP handshake — the fact the panel used to get wrong, by
      // reading `listening` and calling it "connected", which was true from
      // startup and told every user they were set up when they were not.
      // `waiting` is how many are parked in `wait_for_change` right now.
      listening: queue.endpointListening,
      agents: queue.attachedAgents ?? 0,
      waiting: queue.waiting,
      pending: queue.list("pending").length,
    })
    return
  }

  // The other apps running on this machine, and the request to move to one of
  // them. Both are the start screen's answers, relayed by this process rather
  // than fetched by the page: the screen is a different origin, it sends no
  // CORS headers, and the headers that would let this page reach a server that
  // spawns processes would let every other page reach it too. Relayed, the
  // browser never leaves its own origin and the loopback guard above keeps
  // covering the whole conversation.
  //
  // The list answers 200 even when there is no chooser behind this session or
  // the chooser has stopped. "There is nothing to choose" is an answer the menu
  // can put on screen; a 500 is a page that says something went wrong without
  // saying what. The switch does throw, because a switch that did not happen
  // has to be a failure the caller can see.
  if (rest === "/apps" && req.method === "GET") {
    sendJson(res, 200, await apps.list())
    return
  }

  if (rest === "/apps/switch" && req.method === "POST") {
    sendJson(res, 200, await apps.switchTo((await readJsonBody(req)) ?? {}))
    return
  }

  if (rest === "/agent" && req.method === "POST") {
    sendJson(res, 200, await agent.runAgent((await readJsonBody(req)) ?? {}))
    return
  }

  throw badRequest(`No designlayer route for ${req.method} ${pathname}`, 404)
}

/** `config` is the resolved object from `config.mjs`; defaults apply without it. */
export function createDesignLayerRoutes(config = resolveConfig()) {
  const prefix = config.apiPrefix
  const store = createOptionsStore({ stateDir: config.stateDir })
  const defaults = createControlDefaults(config)
  const agent = createAgent(config)
  const icons = createIconSet(config)
  const auth = createAuthStore(config)
  // The browser that opens a site's own sign-in. Built here beside the store it
  // fills, because the two halves of "signed in to an origin" are the session
  // the provider grants and the credential this editor then reuses.
  const signin = createBrowserSignIn(config)
  // The library store looks a credential up per fetch, so a sign-in that
  // happens while the editor is open reaches the very next refresh.
  const libraries = createLibraryStore(
    config,
    { fetchCommand: config.libraries?.fetchCommand ?? [] },
    auth
  )
  const lint = createDesignLint(config)
  // The checkers asked about once, off the request path, so the Audit panel's
  // first question finds the package lookups and the module's own code warm:
  // that first answer cost twice every later one (~3ms against ~1.5ms), all of
  // it resolver caches and first compiles. Nothing is kept — each request
  // still asks the disk afresh — and a project that is gone by then answers
  // "not installed" into the void.
  setTimeout(() => lint.tools().catch(() => {}), 0).unref?.()
  const variants = createVariantCatalog(config)
  const pages = createPageCatalog(config)
  const usage = createComponentUsage(config)
  // No config of its own: which chooser this session belongs to is a fact about
  // how the process was started, and the launcher reads it from the same
  // environment variable this does.
  const apps = createAppSwitcher()
  const angular = createAngularSource(config)
  const react = createReactSource(config)
  const framework = config.host?.framework ?? "react"

  return {
    prefix,

    /** Returns true when this handler owns the request. */
    handle(req, res) {
      let url
      try {
        url = new URL(req.url ?? "/", "http://localhost")
      } catch {
        sendJson(res, 400, { ok: false, message: "Invalid request URL" })
        return true
      }
      const { pathname } = url
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false

      if (!isLocalRequest(req)) {
        sendJson(res, 403, { ok: false, message: "DesignLayer routes are loopback-only" })
        return true
      }

      route(
        store, defaults, agent, icons, libraries, auth, signin, lint, variants, pages, usage, apps, angular, react,
        framework, prefix, config.ports?.mcp ?? null, req, res, url
      ).catch((error) => {
        if (res.headersSent) {
          res.end()
          return
        }
        sendJson(res, Number(error?.statusCode) || 500, {
          ok: false,
          message: error?.message ?? "DesignLayer route failed",
          // A refused add carries the sign-in challenge that would unblock it:
          // which wall, which origin, and the audience an identity token needs.
          // Dropping it here would leave the panel with a sentence and no way
          // to act on it, which is the whole thing the challenge exists for.
          ...(error?.auth ? { auth: error.auth } : {}),
        })
      })

      return true
    },
  }
}
