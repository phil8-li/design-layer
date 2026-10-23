# Angular hosts

An Angular app is a first-class host. Nothing has to be configured — not the
framework, not the dev script, not the port. `npx designlayer` and pick it off
the start screen, or `designlayer --dev` from the project folder.

What the tool works out for itself, and where each answer comes from:

| Question | Answered by |
|---|---|
| Which framework | `@angular/core` in the host's `package.json` |
| Which npm script `--dev` runs | the first of `dev`, `develop`, `start`, `serve` the host actually has — `ng new` writes `start` and no `dev` |
| Which port to wait on | `angular.json`'s `serve.options.port`, else 4200 |
| How to name that port | `--port` on the command line; `ng serve` ignores `PORT` |
| Which interface to ask for | `--host 127.0.0.1`; `ng serve` defaults to `localhost` |
| Which interface the app is on | probed, `127.0.0.1` then `::1`. An app the DESIGNER started is wherever their own script put it, so the proxy follows rather than assumes |
| Which folder a running app is in | the listener's own working directory, via `/proc` on Linux and `lsof` on macOS |
| Whether to offer Tailwind controls | `tailwindcss` in the host's dependencies — a separate question from the framework |
| When the app is ready | `ng-version`, the mark Angular leaves on the element it bootstrapped into |

`host.framework` and `host.tailwind` in a config file override the first and the
second-to-last of those, and nothing else needs saying. The same table is what
makes a Vite React app work unconfigured: it ignores `PORT` and binds `[::1]`
too, so those columns were fixing one bug on two frameworks.

The loopback row is the one that bites hardest, because it is silent. A designer
who runs `npm start` in a stock Angular project has an app on `http://[::1]:4200`
and nothing on `127.0.0.1`. Scanned only for v4, that app simply did not appear
on the start screen — and typing its address by hand did not help either,
because the proxy then targeted an address with nothing on it. The scan now
looks on both, the row carries the address that answered, and `--dev` attaches
to a server already running on either rather than starting a rival beside it.

Two things differ, and both follow from Angular not being React.

**Where an element comes from.** There is no fiber, so there is no owner stack
to walk. The browser reads the authoring component off Angular's own dev-mode
global — `ng.getOwningComponent(el)`, the same accessor Angular DevTools uses —
and sends its class name to the loopback server, which maps it through the
`@Component` decorator to a `templateUrl` (or an inline `template`). An element
is then located inside that template by tag, static classes, parent and sibling
index. A descriptor that fits two template nodes equally well resolves to
NOTHING: the inspector names the component's file and no element in it, rather
than guess between two candidates and send the agent to an element the user was
not looking at.

**Where an edit goes.** On Angular, as on React, a direct edit becomes a note in
the Changes tab and DesignLayer writes nothing to the template. The brief tells
the agent which component to edit and gives the exact CSS; on a project without
Tailwind it says to write the change the way the project already styles the
element, not as an inline style.

`source.extensions` gains `.html`, `.css` and `.scss` on an Angular host unless
the host sets that list itself, in which case it gets exactly what it asked for.

**The right panel is the same panel.** Every section a React host draws, an
Angular host draws, with one exception and it is not about Angular: the
Responsive section writes Tailwind breakpoint variants, so it appears only where
Tailwind is compiled — hidden on a React app without it, shown on an Angular app
with it. The Code tab drops its JSX view for an Angular element, because
`className=` describes a file that does not exist, and the class list stops
calling itself "Tailwind classes" in a project that has none. The handoff record
follows the same rule: on an Angular host it reports the element's `class`, not
its `className`, because a brief that names a JSX attribute sends an agent
looking through `.html` templates for something that was never there.
`test/host-parity-cases.mjs` renders the panel under each host, files a real
request through each, and fails if any of that drifts.

Under the hood the vendored `react-rewrite-cli` still supplies the proxy, the
script injection and the overlay's hit-testing, none of which know what
framework they are in front of. Its startup `detect()` does — it requires a
`react` dependency and a `next.config`/`vite.config` file — so those two probes
are answered for the duration of its own synchronous detection pass and no
longer. Nothing is written into the host project.
