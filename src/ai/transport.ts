/**
 * The one call to the agent route.
 *
 * It never throws: the panel renders whatever comes back, and a dead route or a
 * non-JSON reply has to read the same way as a refusal from the agent itself.
 */

import type { AgentRequest, AgentResponse } from "../core/types"

export async function requestAgent(apiBase: string, request: AgentRequest): Promise<AgentResponse> {
  try {
    const response = await fetch(`${apiBase}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(request),
    })

    const payload = (await response.json().catch(() => null)) as Partial<AgentResponse> | null
    if (!payload || typeof payload.message !== "string") {
      return { ok: false, message: `The agent route returned an error (${response.status}). Check the designlayer terminal, then send again.` }
    }

    return {
      ok: response.ok && payload.ok !== false,
      message: payload.message,
      handoffPath: payload.handoffPath,
      filesChanged: payload.filesChanged,
      changeId: payload.changeId ?? null,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error"
    return { ok: false, message: `Could not reach the agent. Check that designlayer is running, then send again (${detail}).` }
  }
}
