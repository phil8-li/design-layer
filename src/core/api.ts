/**
 * One JSON request to a designlayer route, and what a refusal becomes.
 *
 * The lint board and the library store each kept this transport word for word:
 * `accept: application/json` always, `content-type` only when there is a body,
 * the parsed body on success, and the store's own reading of a refusal on
 * failure. The transport is the same for both; what a refusal SAYS is not (the
 * library store turns an `auth` body into a sign-in prompt and a stale server
 * into its own sentence), so each store passes its own `failure` reader.
 */
export async function sendJson<T>(
  url: string,
  init: RequestInit,
  failure: (response: Response) => Promise<Error>
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
  })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as T
}
