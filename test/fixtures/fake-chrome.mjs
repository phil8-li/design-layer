#!/usr/bin/env node
/**
 * A browser that speaks just enough of the DevTools protocol to be launched,
 * and then misbehaves on purpose.
 *
 * `library-signin.mjs` drives a real Chrome, which a test cannot: the one step
 * that matters needs a person to sign in. What a test CAN pin is how the driver
 * behaves when the browser stops cooperating, and those are exactly the cases
 * that cost the most — a sign-in that hangs forever leaves a dialog reading
 * "Opening the sign-in window…" until the tab is closed, and leaves a browser
 * process running for hours after its own ceiling should have killed it.
 *
 * So this stands in for the browser. It accepts Chrome's command line, opens
 * the debugging port the driver asked for, answers `/json/version` and
 * `/json/list`, and then behaves according to `FAKE_CHROME_MODE`:
 *
 *   mute          accept every command and answer none of them, forever. The
 *                 browser that is alive and not talking — the state that used to
 *                 hang the whole flow, because a pending request settled only on
 *                 an answer or on the socket closing, and this is neither.
 *   idle          answer every command, and stay on `about:blank` forever. A
 *                 browser that works and simply never arrives, which is what the
 *                 poll loop and the window raise need underneath them.
 *   dialog        answer normally, but announce a `beforeunload` dialog as soon
 *                 as the Page domain is enabled. Enabling that domain makes the
 *                 CLIENT responsible for answering dialogs; a driver that does
 *                 not blocks the renderer. Records the answer in
 *                 `FAKE_CHROME_REPORT`.
 *   dialog-confirm  the same, with a `confirm` — the dialog type whose answer
 *                 must NOT be "yes", so the two modes together pin the branch
 *                 rather than a blanket policy.
 *   login-page    serve a 200 HTML login form on the target origin itself, and
 *                 set a cookie the way a login page does. A same-origin sign-in
 *                 screen satisfies every clause of the landing test while being
 *                 the opposite of an arrival.
 *   landing       serve a 200 HTML page on the target origin that is NOT a login
 *                 form, with a session cookie. The control for `login-page`: the
 *                 same shape, the one difference that decides it.
 *   no-handshake  answer the HTTP endpoints, then accept the WebSocket upgrade
 *                 request and never complete it. `ws` arms no handshake timer of
 *                 its own, so the attach has to bound itself or wait forever.
 *   hang-http     accept the connection to `/json/version` and never answer it.
 *                 `fetch` has no timeout by default, so the launch deadline is
 *                 decorative unless every probe carries an abort signal.
 *   bad-list      answer `/json/version`, then answer `/json/list` with
 *                 something that is not JSON. Reading the target list has to
 *                 treat that as "no page", not as an exception to throw out of
 *                 the run while a browser is still running.
 *
 * Deliberately not a Chrome emulator. It knows a handful of commands and two
 * events, and anything else gets an empty result — enough to get the driver to
 * the part under test and no more.
 */

import fs from "node:fs"
import http from "node:http"
import { WebSocketServer } from "ws"

const MODE = process.env.FAKE_CHROME_MODE ?? "mute"
const REPORT = process.env.FAKE_CHROME_REPORT ?? ""
/*
 * A browser that outlives its driver is the bug under test, so this one refuses
 * to outlive the suite. Every mode here is reachable from a driver that leaks
 * the process — that is the point of them — and a failing run must not leave a
 * fake Chrome holding a port until somebody notices it in Activity Monitor.
 */
const TTL = Number(process.env.FAKE_CHROME_TTL ?? 60000)

const portArg = process.argv.find((arg) => arg.startsWith("--remote-debugging-port="))
const port = Number(portArg?.split("=")[1] ?? 0)
if (!port) {
  console.error("fake-chrome: no --remote-debugging-port")
  process.exit(1)
}

/*
 * The URL Chrome was launched on, which is the last thing on its command line.
 * The modes that serve a page have to answer ON that origin — a landing is a
 * claim about the target origin, so a fixture that made one up would be testing
 * nothing.
 */
const TARGET = process.argv[process.argv.length - 1]

/** What the driver learned, for the test to read after the run. */
const seen = { handledDialog: false, commands: [], dialogs: [], stopped: false }
/** The type of the dialog most recently raised, so its answer can be paired with it. */
let pendingDialog = ""
const writeReport = () => {
  if (!REPORT) return
  try {
    fs.writeFileSync(REPORT, JSON.stringify(seen))
  } catch {
    /* the test will fall back to its own timeout */
  }
}

/*
 * A login page, and a page that is not one.
 *
 * The password input is the whole difference, and it is the difference the
 * wall classifier reads — which is the point being tested: a driver that lands
 * on the first of these has not landed on anything.
 */
const LOGIN_HTML =
  `<!doctype html><html><head><title>Sign in</title></head><body>` +
  `<form method="post" action="/session">` +
  `<input name="user" type="text"><input name="pass" type="password">` +
  `<button type="submit">Sign in</button></form></body></html>`
const CONTENT_HTML =
  `<!doctype html><html><head><title>Design tokens</title></head><body>` +
  `<main><h1>Tokens</h1><p>color.brand.primary</p></main></body></html>`

const PAGE_ID = "FAKEPAGE1"
const FRAME_ID = "FAKEFRAME1"
const server = http.createServer((req, res) => {
  const wsUrl = `ws://127.0.0.1:${port}/devtools/page/${PAGE_ID}`
  if (req.url?.startsWith("/json/version")) {
    // Accepted and never answered: the socket stays open with no response on
    // it, which is what a port taken by something that is not a browser looks
    // like from the outside.
    if (MODE === "hang-http") return
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ Browser: "FakeChrome/1.0", "Protocol-Version": "1.3" }))
    return
  }
  if (req.url?.startsWith("/json/list")) {
    if (MODE === "bad-list") {
      res.setHeader("content-type", "application/json")
      res.end("<html>this is not the target list you were looking for</html>")
      return
    }
    res.setHeader("content-type", "application/json")
    res.end(
      JSON.stringify([
        { id: PAGE_ID, type: "page", url: TARGET, webSocketDebuggerUrl: wsUrl },
      ])
    )
    return
  }
  res.statusCode = 404
  res.setHeader("content-type", "application/json")
  res.end("{}")
})

if (MODE === "no-handshake") {
  /*
   * Take the upgrade request and say nothing back.
   *
   * An `http.Server` with no `upgrade` listener destroys the socket, which the
   * driver would see as a connection error and handle — so doing nothing here
   * requires a listener that does nothing, rather than no listener at all. The
   * socket stays open, the client waits for a `101` that is never written, and
   * without a handshake timeout it waits for good.
   */
  server.on("upgrade", (_req, socket) => {
    socket.on("error", () => {})
    socket.pause()
  })
} else {
  const sockets = new WebSocketServer({ server })
  sockets.on("connection", (socket) => {
    const emit = (method, params = {}) => socket.send(JSON.stringify({ method, params }))
    const answer = (id, result = {}) => socket.send(JSON.stringify({ id, result }))

    /** A main-frame document response, which is what the driver calls a landing. */
    const serve = (mimeType = "text/html", status = 200) => {
      emit("Page.frameNavigated", { frame: { id: FRAME_ID, url: TARGET } })
      emit("Network.responseReceived", {
        frameId: FRAME_ID,
        type: "Document",
        response: { url: TARGET, status, mimeType },
      })
    }

    socket.on("message", (raw) => {
      let message
      try {
        message = JSON.parse(String(raw))
      } catch {
        return
      }
      seen.commands.push(message.method)
      if (message.method === "Page.handleJavaScriptDialog") {
        seen.handledDialog = true
        seen.dialogs.push({ type: pendingDialog, accept: message.params?.accept === true })
        writeReport()
      }
      // The whole point of this mode: stay connected, answer nothing.
      if (MODE === "mute") return

      if (message.method === "Runtime.evaluate") {
        const expression = String(message.params?.expression ?? "")
        // Two questions are asked of the page, and they need different answers:
        // where it is, and what it is showing.
        const value = expression.includes("outerHTML")
          ? MODE === "login-page"
            ? LOGIN_HTML
            : CONTENT_HTML
          : MODE === "login-page" || MODE === "landing"
            ? TARGET
            : "about:blank"
        answer(message.id, { result: { type: "string", value } })
        return
      }

      if (message.method === "Network.getCookies") {
        /*
         * A login page sets cookies too — a CSRF token, a session placeholder —
         * which is why "there are cookies" was never evidence of a sign-in and
         * why the old landing test could report success from the login screen.
         */
        const cookies =
          MODE === "login-page"
            ? [{ name: "csrftoken", value: "placeholder" }]
            : MODE === "landing"
              ? [{ name: "SESSION", value: "granted" }]
              : []
        answer(message.id, { cookies })
        return
      }

      answer(message.id)

      if (message.method === "Page.enable" && (MODE === "dialog" || MODE === "dialog-confirm")) {
        pendingDialog = MODE === "dialog" ? "beforeunload" : "confirm"
        emit("Page.javascriptDialogOpening", {
          url: "https://example.com/",
          message: pendingDialog === "beforeunload" ? "Leave site?" : "Are you sure?",
          type: pendingDialog,
          hasBrowserHandler: false,
        })
      }

      if (message.method === "Page.navigate" && (MODE === "login-page" || MODE === "landing")) {
        serve()
      }
    })
  })
}

server.listen(port, "127.0.0.1", () => {
  writeReport()
  setTimeout(() => {
    process.exit(0)
  }, TTL)
})

// A browser exits when it is told to. The driver kills this, which is the
// signal the run is over — and a test can read `stopped` to prove the driver
// did the telling rather than walking away from a process it started.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    seen.stopped = true
    writeReport()
    process.exit(0)
  })
}
