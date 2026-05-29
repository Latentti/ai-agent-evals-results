export const RUN_CONFIG = {
  temperature: 0,
  maxTokens: 2048,
  maxTurns: 8,
  perCallTimeoutMs: 60_000,
  globalConcurrency: 10,
  perModelConcurrency: 2,
  judgeModelId: "claude-sonnet-4-6",
  secondJudgeModelId: "claude-opus-4-7",
  secondJudgeSampleRate: 0.2,
} as const;

export function readBudgetConfig(): { warnUsd: number; maxUsd: number } {
  const warnRaw = process.env.WARN_USD ?? "10";
  const maxRaw = process.env.MAX_USD_BUDGET ?? "25";
  const warnUsd = Number(warnRaw);
  const maxUsd = Number(maxRaw);
  if (!Number.isFinite(warnUsd) || !Number.isFinite(maxUsd)) {
    throw new Error("WARN_USD and MAX_USD_BUDGET must be numbers");
  }
  return { warnUsd, maxUsd };
}
