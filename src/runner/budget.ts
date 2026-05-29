import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { MODELS, type ModelEntry } from "../config/models.js";
import { computeCostUsd } from "../config/pricing.js";
import { readBudgetConfig } from "../config/runConfig.js";
import { TASKS } from "../tasks/index.js";
import type { Task } from "../tasks/types.js";
import { variantsOf } from "./sweep.js";

function roughTokenize(text: string): number {
  // ~4 chars per token heuristic; tokenizer parity is a known gotcha (documented in methodology)
  return Math.ceil(text.length / 4);
}

interface EstimateRow {
  modelId: string;
  taskId: string;
  variantId: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  costUsd: number;
}

export interface EstimateSummary {
  rows: EstimateRow[];
  totalCalls: number;
  totalCostUsd: number;
}

export function estimateSweepCost(
  models: readonly ModelEntry[] = MODELS,
  tasks: readonly Task[] = TASKS
): EstimateSummary {
  const rows: EstimateRow[] = [];
  let totalCost = 0;
  let totalCalls = 0;
  for (const m of models) {
    for (const t of tasks) {
      for (const variant of variantsOf(t)) {
        const systemTokens = roughTokenize(variant.systemPrompt);
        const toolSchemaTokens = variant.tools
          ? roughTokenize(JSON.stringify(variant.tools))
          : 0;
        let inputTokens = 0;
        let outputTokens = 0;
        for (const c of t.cases) {
          const userPrompt = variant.buildUserPrompt
            ? variant.buildUserPrompt(c.input, variant.precompute?.(c.input))
            : t.buildUserPrompt(c.input);
          const promptTokens =
            systemTokens + toolSchemaTokens + roughTokenize(userPrompt);
          const callsForCase = t.replicates;
          const out = t.estimatedOutputTokens;
          const turnMultiplier = variant.tools ? 2.5 : 1;
          inputTokens += promptTokens * callsForCase * turnMultiplier;
          outputTokens += out * callsForCase;
        }
        const calls = t.cases.length * t.replicates;
        const cost = computeCostUsd(
          m.id,
          Math.ceil(inputTokens),
          Math.ceil(outputTokens)
        );
        rows.push({
          modelId: m.id,
          taskId: t.id,
          variantId: variant.id,
          inputTokens: Math.ceil(inputTokens),
          outputTokens: Math.ceil(outputTokens),
          calls,
          costUsd: cost,
        });
        totalCost += cost;
        totalCalls += calls;
      }
    }
  }
  return { rows, totalCalls, totalCostUsd: totalCost };
}

export function printEstimate(summary: EstimateSummary): void {
  console.log("\nCost estimate (rough, ~4 chars/token heuristic):");
  console.log("─".repeat(86));
  console.log(
    "  model".padEnd(34) +
      "task".padEnd(18) +
      "variant".padEnd(14) +
      "calls".padStart(7) +
      "cost".padStart(13)
  );
  console.log("─".repeat(86));
  for (const r of summary.rows) {
    console.log(
      `  ${r.modelId.padEnd(32)}${r.taskId.padEnd(18)}${r.variantId.padEnd(14)}${String(r.calls).padStart(7)}${("$" + r.costUsd.toFixed(3)).padStart(13)}`
    );
  }
  console.log("─".repeat(86));
  console.log(
    `  TOTAL`.padEnd(66) +
      String(summary.totalCalls).padStart(7) +
      ("$" + summary.totalCostUsd.toFixed(2)).padStart(13)
  );
  console.log();
}

export async function confirmBudget(
  summary: EstimateSummary,
  opts: { yes?: boolean } = {}
): Promise<void> {
  const { warnUsd, maxUsd } = readBudgetConfig();
  if (summary.totalCostUsd > maxUsd) {
    throw new Error(
      `Estimated cost $${summary.totalCostUsd.toFixed(2)} exceeds MAX_USD_BUDGET=$${maxUsd}. Aborting. Reduce models/cases/replicates or raise MAX_USD_BUDGET.`
    );
  }
  if (summary.totalCostUsd > warnUsd) {
    console.warn(
      `\x1b[33mWARN: estimated cost $${summary.totalCostUsd.toFixed(2)} exceeds WARN_USD=$${warnUsd}.\x1b[0m`
    );
  }
  if (opts.yes) return;
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(
    `Proceed with sweep at estimated $${summary.totalCostUsd.toFixed(2)}? [y/N]: `
  );
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new Error("Aborted by user");
  }
}
