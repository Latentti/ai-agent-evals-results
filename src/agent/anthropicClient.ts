import Anthropic from "@anthropic-ai/sdk";

let cached: Anthropic | null = null;

export function getClient(): Anthropic {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set in environment");
  cached = new Anthropic({ apiKey });
  return cached;
}

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

export async function createMessageWithRetry(
  params: Anthropic.MessageCreateParamsNonStreaming,
  opts: { timeoutMs: number; maxRetries?: number } = { timeoutMs: 60_000 }
): Promise<Anthropic.Message> {
  const maxRetries = opts.maxRetries ?? 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const client = getClient();
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opts.timeoutMs);
      try {
        const resp = await client.messages.create(params, {
          signal: ctrl.signal,
        });
        return resp;
      } finally {
        clearTimeout(t);
      }
    } catch (err: unknown) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      if (!status || !RETRY_STATUSES.has(status) || attempt === maxRetries) {
        throw err;
      }
      const retryAfterRaw = (err as { headers?: Record<string, string> })
        ?.headers?.["retry-after"];
      const retryAfterMs = retryAfterRaw
        ? Number(retryAfterRaw) * 1000
        : Math.min(30_000, 1000 * Math.pow(2, attempt) + Math.random() * 250);
      await new Promise((r) => setTimeout(r, retryAfterMs));
    }
  }
  throw lastErr;
}
