export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Anthropic public pricing in USD per million tokens.
 * Last verified: 2026-05-28 against https://www.anthropic.com/pricing
 * Update whenever a model is added or pricing changes — stale numbers silently
 * break the cost narrative throughout the report.
 */
export const PRICING: Record<string, Pricing> = {
  "claude-sonnet-4-20250514": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "claude-sonnet-4-5-20250929": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "claude-sonnet-4-6": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  "claude-opus-4-7": { inputPerMTok: 15.0, outputPerMTok: 75.0 },
};

const warnedUnknownModels = new Set<string>();

export function computeCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const p = PRICING[modelId];
  if (!p) {
    if (!warnedUnknownModels.has(modelId)) {
      warnedUnknownModels.add(modelId);
      console.warn(
        `\x1b[33m[pricing] no entry for model "${modelId}" — cost will be reported as $0. Add it to src/config/pricing.ts.\x1b[0m`
      );
    }
    return 0;
  }
  return (
    (inputTokens / 1_000_000) * p.inputPerMTok +
    (outputTokens / 1_000_000) * p.outputPerMTok
  );
}
