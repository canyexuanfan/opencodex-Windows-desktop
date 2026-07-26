/**
 * Helpers that check Response status before consuming the body.
 * Satisfies react-doctor `no-fetch-response-used-without-status-check`
 * (`fetch` resolves on HTTP 4xx/5xx).
 */

/** Parse an OK response body; 204 / empty bodies yield `undefined`. */
async function readJsonBody<T>(res: Response): Promise<T | undefined> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text.trim()) return undefined;
  return JSON.parse(text) as T;
}

export async function readJsonOrThrow<T>(
  res: Response,
  fallbackMessage = `HTTP ${res.status}`,
): Promise<T | undefined> {
  if (!res.ok) {
    let message = fallbackMessage;
    try {
      const errBody = await res.json() as { error?: unknown };
      if (typeof errBody?.error === "string" && errBody.error) message = errBody.error;
    } catch {
      // non-JSON error bodies keep the fallback message
    }
    throw new Error(message);
  }
  return readJsonBody<T>(res);
}

export async function readJsonIfOk<T>(res: Response): Promise<T | null | undefined> {
  if (!res.ok) return null;
  return readJsonBody<T>(res);
}
