/**
 * The other apps running on this machine, relayed on the page's behalf.
 *
 * The chooser screen already knows what is up — it scans the ports, reads the
 * projects behind them and starts the next editor — and the editor page cannot
 * ask it directly. The two are different origins (the screen binds 3455, the
 * page is served by the proxy on 3456), the screen sends no CORS headers, and
 * it must not start: headers permissive enough to let this page reach a server
 * that spawns processes would let every other page in the browser reach it too.
 *
 * So the conversation happens here instead, server to server over loopback, and
 * the browser talks only to the origin it was served from — where the loopback
 * guard in routes.mjs already covers it, in the one place it is written down.
 *
 * Nothing is cached. What is running changes while the menu is open, and a
 * remembered list is a list of apps that have since stopped.
 */

import { chooserUrlFromEnv } from "../runtime/chooser-url.mjs"
import { listEditors } from "../runtime/editor-registry.mjs"

// The chooser's own scan is the floor: it probes every candidate port
// concurrently with a 1.5s ceiling and then reads package.json off disk for the
// ones that answered. Four seconds covers that with room for a cold machine,
// and stops well short of the point where a menu waiting on it reads as hung.
const CHOOSER_TIMEOUT_MS = 4000

// Same helper as routes.mjs, and a copy on purpose: importing it from there
// would close a cycle, since that module builds this one.
function refusal(message, statusCode) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * One row, cut down to the five keys the browser is promised.
 *
 * The scanner sends exactly these today, so this changes nothing today. It is
 * here for the version that sends more: that row is assembled from a page probe
 * and an `lsof` against the machine's own processes, and a field added there
 * for the start screen's benefit would reach the browser purely because a fetch
 * was passed straight through. What the page is shown is decided on this side.
 */
function appRow(raw) {
  return {
    kind: "app",
    port: typeof raw.port === "number" ? raw.port : null,
    url: typeof raw.url === "string" ? raw.url : "",
    title: typeof raw.title === "string" ? raw.title : "",
    projectRoot: typeof raw.projectRoot === "string" ? raw.projectRoot : null,
    packageName: typeof raw.packageName === "string" ? raw.packageName : null,
    // An app with no editor of its own can only be reached by asking the start
    // screen to start one, so there is nowhere for the browser to navigate to.
    target: null,
  }
}

/**
 * One running editor, as a row the browser can switch to by NAVIGATING.
 *
 * This is the row that makes the chooser work in the sessions most people
 * actually have. An app row is a request — kill this editor, start another —
 * and it needs a supervisor to carry it out. An editor row is just a URL: that
 * app already has an editor, it is already up, and switching to it is following
 * a link. Nothing is killed, nothing is started, and nothing queued in this tab
 * is at risk, because this tab is not the one being replaced.
 */
function editorRow(entry) {
  return {
    kind: "editor",
    port: typeof entry.appPort === "number" ? entry.appPort : null,
    url: typeof entry.appUrl === "string" ? entry.appUrl : "",
    // Empty, and it stays empty: the registry records what an editor is pointed
    // at, not what the served page calls itself, and inventing a title from the
    // URL here would be the same string twice under two keys. The browser falls
    // back through the project folder before it reaches the URL — see
    // `appLabel` in `src/panels/app-chooser.ts` — which is where a row with no
    // package name gets something a person actually chose.
    title: "",
    projectRoot: typeof entry.projectRoot === "string" ? entry.projectRoot : null,
    packageName: typeof entry.packageName === "string" ? entry.packageName : null,
    /** Where the browser goes. The other editor's own proxy. */
    target: typeof entry.url === "string" ? entry.url : null,
  }
}

/** The sentence an unreachable chooser produces, wherever it is reached from. */
function unreachable(chooserUrl, error) {
  return `The start screen at ${chooserUrl} did not answer (${error.message}).`
}

/**
 * `chooserUrl` is defaulted rather than read inside, so a test can hand this a
 * screen of its own. An explicit null is the no-chooser session, which is most
 * of them.
 */
export function createAppSwitcher({
  chooserUrl = chooserUrlFromEnv(process.env),
  /**
   * This editor's own identity, so its own row is not offered as somewhere to
   * go. The pid rather than the port, because this module is constructed before
   * the proxy has necessarily bound one and `process.pid` is true from the
   * first line of the process.
   */
  self = process.pid,
  /** Injectable so a suite can describe a machine rather than have to be on one. */
  editors = listEditors,
} = {}) {
  /**
   * Every OTHER editor running right now, as rows.
   *
   * Its own row is dropped rather than marked: the browser already knows which
   * app it is on and marks that row itself from `config.app`, and a row whose
   * target is the page you are looking at is a link to here.
   */
  const siblings = () => {
    let running
    try {
      running = editors()
    } catch {
      // A registry that cannot be read costs rows, never the request.
      return []
    }
    return running
      .filter((entry) => entry && entry.pid !== self)
      .map(editorRow)
      .filter((row) => row.target)
  }

  return {
    chooserUrl,

    /**
     * Never throws, which is the whole point of it.
     *
     * Two of the three answers here are ordinary facts about a session rather
     * than faults: this editor was not started from a chooser, or the chooser
     * it was started from is not answering any more. Both are a line the menu
     * can put on screen, and a 500 would turn either into a page that says
     * something went wrong without saying what.
     */
    async list() {
      /*
       * The editors on this machine come first, and they come from the registry
       * rather than from anybody's scan.
       *
       * This is the half that was missing. The chooser used to answer
       * `{chooser: false}` whenever there was no start screen behind the
       * session — which is most sessions, and was the state of a machine with
       * five editors running on it at the time. They were all discoverable; it
       * simply was not looking.
       */
      const running = siblings()

      if (!chooserUrl) {
        /*
         * No screen to ask about apps that have no editor yet, which is not the
         * same as nothing to switch to: switching between editors needs nothing
         * but their URLs.
         *
         * `chooser` was `running.length > 0` here, and the browser read the
         * `false` as "this session has no app chooser" and said so, inside the
         * app chooser, to everybody running a single editor with no start
         * screen — which is most people, most of the time. The field never
         * meant that. It answers whether a supervisor can START something, and
         * an empty list is a fact about the machine right now rather than a
         * missing feature. So this reports the truth and lets the menu write
         * its own empty state, which is where a sentence about what the reader
         * can do next belongs.
         */
        return { chooser: true, apps: running }
      }

      let response
      try {
        response = await fetch(new URL("api/apps", chooserUrl), {
          signal: AbortSignal.timeout(CHOOSER_TIMEOUT_MS),
        })
      } catch (error) {
        // The screen being down does not make the editors on this machine go
        // away, so the list is what we know rather than an apology.
        return running.length
          ? { chooser: true, apps: running }
          : { chooser: true, apps: [], error: unreachable(chooserUrl, error) }
      }

      if (!response.ok) {
        // Same bargain as an unreachable screen: the editors on this machine are
        // still there and still worth listing, so a bad answer from the screen
        // costs the app rows and nothing else. The key is omitted rather than
        // set to `undefined`, so that `"error" in answer` means the same thing
        // on every path through this function.
        if (running.length) return { chooser: true, apps: running }
        return {
          chooser: true,
          apps: [],
          error: `The start screen answered ${response.status} when asked what is running.`,
        }
      }

      try {
        const body = await response.json()
        const scanned = Array.isArray(body?.apps) ? body.apps.filter(isPlainObject).map(appRow) : []
        /*
         * An app that already has an editor is listed once, as the editor.
         *
         * Both halves can see the same app — the screen scans the port, the
         * registry knows an editor is pointed at it — and the editor row is the
         * better of the two by a long way: it is somewhere to navigate rather
         * than a process swap. Matched on port, because the two describe the
         * same server with different spellings of loopback.
         */
        const taken = new Set(running.map((row) => row.port))
        return { chooser: true, apps: [...running, ...scanned.filter((row) => !taken.has(row.port))] }
      } catch (error) {
        return running.length
          ? { chooser: true, apps: running }
          : { chooser: true, apps: [], error: unreachable(chooserUrl, error) }
      }
    },

    /**
     * Hands one choice to the screen, which kills this editor and starts the
     * next. Everything after that happens in another process, so the only
     * success this can report is that the choice was accepted.
     *
     * The body is checked before the chooser is: the start screen validates it
     * too, and far better — it stats the folder and reads its scripts — but a
     * request with no URL in it at all never needed the round trip to find that
     * out, and the sentence is the same either way.
     */
    async switchTo(body) {
      const url = typeof body?.url === "string" ? body.url.trim() : ""
      const projectRoot = typeof body?.projectRoot === "string" ? body.projectRoot.trim() : ""
      if (!url || !projectRoot) {
        throw refusal("Switching apps needs an app URL and the project folder behind it.", 400)
      }
      if (!chooserUrl) {
        throw refusal(
          "This editor was not started from the start screen, so there is nothing to switch with. Run `designlayer` with no port to get one.",
          409
        )
      }

      // `devScript` is optional all the way down: the screen resolves the
      // project's own best script when it is absent, and a null sent in its
      // place would be a value it has to reject rather than a question it can
      // answer for itself.
      const choice = { url, projectRoot }
      if (typeof body.devScript === "string") choice.devScript = body.devScript

      let response
      try {
        response = await fetch(new URL("api/start", chooserUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(choice),
          signal: AbortSignal.timeout(CHOOSER_TIMEOUT_MS),
        })
      } catch (error) {
        // 502, because this side is fine and the machine behind it is not.
        throw refusal(unreachable(chooserUrl, error), 502)
      }

      if (!response.ok) {
        // The screen's refusals are written for whoever is looking at a screen
        // — "there is no dev script in that folder", not "400" — so its
        // sentence is carried through verbatim, under its own status. Only a
        // response that says nothing gets a sentence invented for it.
        const said = await response.json().catch(() => null)
        throw refusal(
          typeof said?.error === "string"
            ? said.error
            : `The start screen refused the switch (${response.status}).`,
          response.status
        )
      }

      return { ok: true }
    },
  }
}
