# Handing changes to your coding agent

DesignLayer is an MCP server. Your coding agent connects to it, waits for the
designer to press **Send to agent**, applies the notes and edits it receives,
and reports back.

## Setup in two minutes

1. Start DesignLayer (`npx designlayer`). It prints the endpoint:
   `[designlayer] MCP http://127.0.0.1:5747/mcp`
2. Add that URL to your agent as a **remote (HTTP)** MCP server — see the
   snippets below.
3. Paste the prompt below into the agent.
4. Leave notes in the editor and press **Send to agent**.

### Client config

```sh
# Claude Code
claude mcp add --transport http designlayer http://127.0.0.1:5747/mcp
```

```jsonc
// OpenCode: ~/.config/opencode/opencode.jsonc
"mcp": {
  "designlayer": { "type": "remote", "url": "http://127.0.0.1:5747/mcp", "enabled": true }
}
```

```jsonc
// Cursor: .cursor/mcp.json
{ "mcpServers": { "designlayer": { "url": "http://127.0.0.1:5747/mcp" } } }
```

```jsonc
// VS Code (Copilot agent mode): .vscode/mcp.json
{ "servers": { "designlayer": { "type": "http", "url": "http://127.0.0.1:5747/mcp" } } }
```

Do not register DesignLayer as a local (stdio) command. That would start a
second copy with no editor attached.

### Prompt for the agent

```text
Connect to the designlayer MCP server and work its loop until I say stop:
1. Call wait_for_change. If it returns {timeout: true}, call it again.
2. Work in the change's projectRoot folder; its files are relative to it.
   For each change with startNewSession: true, open a new chat session there and
   send its sessionPrompt verbatim as the first message. Otherwise read its brief
   and the files it names, then edit the source.
3. Call resolve_change with the id, resolution "applied" or "rejected", and a
   one-sentence summary.
4. Go back to step 1.
```

### Each send starts a new session

**Send to agent** asks the waiting agent to open a new chat session for the
send, rather than doing the work inside the conversation that is watching the
queue. The change carries `startNewSession: true` and a `sessionPrompt`: the
brief behind the prefix `/goal get those done: `, so the new session keeps
working until every item is done. MCP gives a server no way to open a session
itself, so the agent opens it with whatever its harness provides; an agent that
cannot open one does the work in place. The same prompt goes on the clipboard,
so it can be pasted into a new chat by hand.

### Tool reference

| Tool | Input | Returns |
| --- | --- | --- |
| `wait_for_change` | `timeoutSeconds` (default and max 55), `batchWindowSeconds` (default 1.5, max 15) | Pending changes with brief, `startNewSession`, `sessionPrompt`, files, and selected element; or `{timeout: true}` |
| `list_changes` | `status`: `pending` (default), `resolved`, `rejected`, `all` | The changes, without blocking |
| `get_change` | `id` | One full change record |
| `resolve_change` | `id`, `resolution` (`applied` default, or `rejected`), `summary` | `{ok, id, status, resolution}` |

Rules an agent must follow:

- **Work in the change's `projectRoot`.** Every change carries `projectRoot`
  (the absolute project folder) and `app` (that folder's name). One endpoint can
  serve several apps at once, so two changes in one batch can be for two
  different repos. `files` and `handoffFile` are relative to `projectRoot`.
- **Always resolve.** An unresolved change comes back on the next wait, and the
  agent will redo finished work.
- **One waiter at a time.** Changes are not claimed, so two agents waiting at
  once both receive the same change.
- **A timeout is not an error.** It means nobody has clicked yet.

### No MCP client?

**Copy** in the Changes tab puts the same brief on the clipboard; paste it into
any agent or chat. Every send is also saved as a markdown file under
`.local/designlayer/requests/` in the project.

## The Changes tab
The **Changes** tab holds everything a session produced — the notes you left and
the edits you made — as one list in the order they happened. A direct edit in
the Design panel (new text, a resize, a color, a moved or deleted element)
becomes a note that the editor writes for you in plain words, such as "Change
the width to 200px (was 120px)" or "Stack its items vertically". DesignLayer
shows the edit on the page and writes nothing to your source files. Your agent
makes every note in code.

- **One numbering.** Item 4 is 4 on its row, on its pin on the canvas, and in
  the brief. Edit notes get the same numbered pins as typed notes.
- **One undo timeline.** Pinning, rewriting and deleting a note are Cmd+Z steps
  beside every style edit, so Undo always takes back the newest thing you did.
  Undo an edit and its note goes too. The cross on an edit note discards the
  edit and puts the page back.
- **One send button.** **Send to agent** hands every note, typed or written by
  the editor, to a coding agent that is already running. It shows once an agent
  has connected over MCP.
- **One copy.** **Copy** in the tab and the copy shortcut write the same brief.
  It is not a fallback: the editor cannot see whether an agent is attached, so
  the paste path has to stay a peer.

The copied or sent brief says more than the row. An edit note carries the
row's sentence as `**Change:**` (in place of `**Feedback:**`), then an
`**Instructions:**` list for the agent: the exact CSS declaration and its
current value, the Tailwind class to write in place of the current one (on a
Tailwind host), and which component's source to edit. A text edit says to
change the copy where it is defined, a drag says to move the element through
the layout instead of a transform, and a delete says to remove what the element
leaves unused. One line under the header tells the agent that none of the edits
is in the source yet.

```md
### 9. div #box
**Location:** #root > .page > #box
**React:** <App>
**Change:** Change the corner radius to 20px (was 12px)
**Instructions:**
- Set `border-radius: 20px` on this element. It is `12px` now.
- Tailwind: replace `rounded-xl` with `rounded-[20px]`.
- If the theme has a token with this value, use the token in place of the arbitrary value.
- Edit the JSX or template of <App> that renders this element.
```

## How it works

An MCP server cannot push work to an agent. The protocol's set of
server-to-client messages is a closed list — pings, elicitation, roots, task
bookkeeping, and notifications that a list has gone stale. There is no "here is
a task, go do it". An agent's turn runs when a human types, or while a tool call
it made has not yet returned, so a server's only way into that loop is to be
*inside a tool call that has not returned yet*.

The handoff is therefore not a push. It is a pull that was already parked: the
agent calls a tool that blocks, you click, the tool returns.

So the editor is the MCP **server** and your agent is the client, which reads
backwards until you notice that MCP's roles are about who offers context, not
who has a window.

## The port

The editor serves MCP on its own fixed port — `ports.mcp`, default `5747` —
rather than on the proxy, because `ports.proxy` is `auto` and this URL goes into
an agent's config by hand. It prints the URL at startup:

```
[designlayer] MCP http://127.0.0.1:5747/mcp — point your agent at it
```

Set `ports.mcp` to `null` to turn the endpoint off. A port already in use is a
warning and nothing more — the editor starts, and Copy still works.

An editor you start on its own serves the endpoint itself, so restarting it
closes the port for a few seconds. Some agents drop the server's tools after one
failed call and need a restart to get them back.

The start screen can run several editors at once, one per app, and only one
process can hold the port. So while it runs any editor, the start screen serves
the endpoint for all of them: every editor's **Send to agent** reaches the same
address, and each change names the `projectRoot` it is for. The endpoint stays
up after the last editor stops, until the start screen itself closes, so a
change sent just before is not lost. In the Changes tab, **Stay on between
apps** then shows on and cannot be turned off. Its other use is to make the
start screen serve the endpoint from launch, before any app starts; it is off by
default and saved for the next session.

## The loop

Four tools, which together are a workflow rather than a verb:

| Tool | What it does |
|---|---|
| `wait_for_change` | Drains anything already queued, otherwise blocks. Returns the changes with their brief, files and selected element. |
| `list_changes` | The same, without blocking. |
| `get_change` | One change by id. |
| `resolve_change` | Marks it `applied` or `rejected` with a summary. |

Tell the agent to work the loop — wait, apply, resolve, wait again — and
pressing the button becomes the whole interaction.

`resolve_change` is not bookkeeping. A change that stays pending is a change the
next `wait_for_change` hands back, and an agent that never resolves will re-apply
its own finished work until you stop it.

## The 55-second ceiling

`wait_for_change` blocks for at most 55 seconds and then returns
`{"timeout": true}`. That is not an error; it means nobody has clicked yet, and
the reply says so, so a model calls again instead of giving up.

The number is not arbitrary. MCP clients abort a request at 60 seconds by
default, and the escape hatch — progress notifications with
`resetTimeoutOnProgress` — needs an SSE response stream, which this endpoint
deliberately does not open. A timed-out request is worse than it sounds: the
client stops listening and the server is never told, so the block is left
holding the next click. A loop of short waits is indistinguishable from one long
wait and cannot strand a watcher, so that is what this does.
