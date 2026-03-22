/**
 * OpenAI chat/completions fetch with retries on 429/503 (rate limits / overload).
 * Helps local testing when bursting requests; tune in production if needed.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const MAX_ATTEMPTS = 12;

/**
 * POST to OpenAI; retries on 429/503 with exponential backoff and optional Retry-After.
 */
export async function fetchOpenAIChat(url: string, init: RequestInit): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, init);
    last = res;
    if (res.status === 429 || res.status === 503) {
      if (attempt < MAX_ATTEMPTS - 1) {
        const ra = res.headers.get("retry-after");
        let waitMs: number;
        if (ra) {
          const sec = /^\d+$/.test(ra.trim()) ? parseInt(ra, 10) : parseFloat(ra);
          waitMs = Math.min(Number.isFinite(sec) ? sec * 1000 : 5000, 120_000);
        } else {
          waitMs = Math.min(2000 * Math.pow(2, attempt), 90_000);
        }
        try {
          await res.text();
        } catch {
          /* ignore */
        }
        await sleep(waitMs);
        continue;
      }
    }
    return res;
  }
  return last!;
}
