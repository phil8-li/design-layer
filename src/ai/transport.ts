/**
 * The one call to the agent route.
 *
 * It never throws: the panel renders whatever comes back, and a dead route or a
 * non-JSON reply has to read the same way as a refusal from the agent itself.
 */

import type { AgentOutcome, AgentRequest, AgentResponse } from "../core/types"

/**
 * How long a send may take before it reads as a failure. The route writes a
 * file and asks the MCP hub, which bounds its own call, so only a stalled
 * editor server gets here — and without a bound the button said "Sending…"
 * until a reload.
 */
const AGENT_TIMEOUT_MS = 30_000

const OUTCOMES: readonly AgentOutcome[] = ["delivered", "queued", "undelivered"]

export async function requestAgent(apiBase: string, request: AgentRequest): Promise<AgentResponse> {
  try {
    const response = await fetch(`${apiBase}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(request),
      signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(AGENT_TIMEOUT_MS) : undefined,
    })

    const payload = (await response.json().catch(() => null)) as Partial<AgentResponse> | null
    if (!payload || typeof payload.message !== "string") {
      return { ok: false, message: `The agent route returned an error (${response.status}). Check the designlayer terminal, then send again.` }
    }

    const ok = response.ok && payload.ok !== false
    return {
      ok,
      message: payload.message,
      handoffPath: payload.handoffPath,
      changeId: payload.changeId ?? null,
      // A server from before the field said `ok` for a queued send, so a
      // missing word is "queued"; a refusal has no outcome at all.
      outcome: ok ? (OUTCOMES.includes(payload.outcome as AgentOutcome) ? payload.outcome : "queued") : undefined,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error"
    return { ok: false, message: `Could not reach the agent. Check that designlayer is running, then send again (${detail}).` }
  }
}
