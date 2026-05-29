import { describe, expect, it } from "vitest";
import { estimateSweepCost } from "../src/runner/budget.js";
import { MODELS } from "../src/config/models.js";
import { TASKS } from "../src/tasks/index.js";
import { variantsOf } from "../src/runner/sweep.js";

describe("budget estimate", () => {
  it("produces a row per (model × task × variant) and a sane total", () => {
    const summary = estimateSweepCost();
    const expectedRows =
      MODELS.length *
      TASKS.reduce((acc, t) => acc + variantsOf(t).length, 0);
    expect(summary.rows).toHaveLength(expectedRows);
    expect(summary.totalCostUsd).toBeGreaterThan(0);
    expect(summary.totalCalls).toBeGreaterThan(100);
  });

  it("Opus is more expensive than Haiku for the same task", () => {
    const summary = estimateSweepCost();
    const opus = summary.rows.find(
      (r) => r.modelId === "claude-opus-4-7" && r.taskId === "reasoning"
    )!;
    const haiku = summary.rows.find(
      (r) => r.modelId === "claude-haiku-4-5-20251001" && r.taskId === "reasoning"
    )!;
    expect(opus.costUsd).toBeGreaterThan(haiku.costUsd);
  });
});
