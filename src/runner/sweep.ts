import { MODELS } from "../config/models.js";
import { RUN_CONFIG } from "../config/runConfig.js";
import { runAgent } from "../agent/loop.js";
import { TASKS } from "../tasks/index.js";
import type { PromptVariant, ScoredRun, Task } from "../tasks/types.js";
import { appendScoredRun, existingTupleKeys, tupleKey } from "./persist.js";

/**
 * Hard ceiling for the wall time of a single agent loop. With per-call timeout
 * 60 s × max 8 turns × ≤5 retries this could otherwise occupy a semaphore slot
 * for tens of minutes, blocking the whole sweep.
 */
const PER_JOB_TIMEOUT_MS = 5 * 60_000;

function withJobTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`job timeout after ${ms} ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/**
 * Returns the implicit "baseline" variant for a task — derived from the task's
 * own systemPrompt / tools / handlers — plus any explicitly-listed `variants`.
 */
export function variantsOf(task: Task): PromptVariant[] {
  const baseline: PromptVariant = {
    id: "baseline",
    displayName: "Baseline prompt",
    systemPrompt: task.systemPrompt,
    tools: task.tools,
    toolHandlers: task.toolHandlers,
  };
  return [baseline, ...(task.variants ?? [])];
}

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    return await new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }
  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export interface SweepOptions {
  runDir: string;
  models?: readonly { id: string }[];
  tasks?: readonly Task[];
  /** Optional set of variant ids to include (default: all). */
  variantIds?: ReadonlySet<string>;
  onProgress?: (done: number, total: number, lastKey: string) => void;
}

export async function runSweep(opts: SweepOptions): Promise<void> {
  const models = opts.models ?? MODELS;
  const tasks = opts.tasks ?? TASKS;

  const completed = existingTupleKeys(opts.runDir);
  const globalSem = new Semaphore(RUN_CONFIG.globalConcurrency);
  const perModelSems = new Map<string, Semaphore>();
  for (const m of models) {
    perModelSems.set(m.id, new Semaphore(RUN_CONFIG.perModelConcurrency));
  }

  // Build the full job list
  const jobs: Array<{
    task: Task;
    variant: PromptVariant;
    caseIdx: number;
    modelId: string;
    replicateIdx: number;
  }> = [];
  for (const task of tasks) {
    const variants = variantsOf(task).filter(
      (v) => !opts.variantIds || opts.variantIds.has(v.id)
    );
    for (const variant of variants) {
      for (let ci = 0; ci < task.cases.length; ci++) {
        for (const m of models) {
          for (let r = 0; r < task.replicates; r++) {
            jobs.push({
              task,
              variant,
              caseIdx: ci,
              modelId: m.id,
              replicateIdx: r,
            });
          }
        }
      }
    }
  }

  const total = jobs.length;
  let done = 0;
  let lastKey = "";

  await Promise.all(
    jobs.map(async (job) => {
      const key = tupleKey(
        job.task.id,
        job.task.cases[job.caseIdx]!.id,
        job.modelId,
        job.variant.id,
        job.replicateIdx
      );
      if (completed.has(key)) {
        done++;
        opts.onProgress?.(done, total, key);
        return;
      }

      const releaseGlobal = await globalSem.acquire();
      const modelSem = perModelSems.get(job.modelId)!;
      const releaseModel = await modelSem.acquire();
      try {
        const c = job.task.cases[job.caseIdx]!;
        const precomputed = job.variant.precompute?.(c.input);
        const userPrompt = job.variant.buildUserPrompt
          ? job.variant.buildUserPrompt(c.input, precomputed)
          : job.task.buildUserPrompt(c.input);

        let result;
        try {
          result = await withJobTimeout(
            runAgent({
              modelId: job.modelId,
              systemPrompt: job.variant.systemPrompt,
              userPrompt,
              tools: job.variant.tools,
              toolHandlers: job.variant.toolHandlers,
            }),
            PER_JOB_TIMEOUT_MS
          );
        } catch (err) {
          result = {
            modelId: job.modelId,
            finalText: "",
            toolCalls: [],
            turns: 0,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            costUsd: 0,
            refused: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }

        const parsed = job.task.parseOutput(
          result.finalText,
          result.toolCalls,
          precomputed
        );
        const score = await job.task.score(parsed as never, c.gold as never, {
          result,
          caseInput: c.input,
          caseId: c.id,
        });

        const scored: ScoredRun = {
          taskId: job.task.id,
          caseId: c.id,
          variantId: job.variant.id,
          replicateIdx: job.replicateIdx,
          modelId: job.modelId,
          result,
          score,
          timestampMs: Date.now(),
        };
        await appendScoredRun(opts.runDir, scored);
      } finally {
        releaseModel();
        releaseGlobal();
        done++;
        lastKey = key;
        opts.onProgress?.(done, total, lastKey);
      }
    })
  );
}
