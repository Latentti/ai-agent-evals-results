import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ScoredRun } from "../tasks/types.js";

export function makeRunDir(rootDir: string): string {
  // ISO ms timestamp + 4 hex chars of randomness to avoid same-second collisions
  // across parallel sweeps.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = randomBytes(2).toString("hex");
  const dir = resolve(rootDir, "results", "runs", `${stamp}-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Single-writer queue per runDir. Node's appendFileSync uses O_APPEND, which is
 * only atomic up to PIPE_BUF on POSIX (~4 KB on Linux, less on macOS).
 * A scored run with a long `finalText` and tool-call payload can easily exceed
 * that and interleave bytes with another concurrent worker, corrupting JSONL.
 *
 * Serialise all appends per runDir through a single async chain; this gives us
 * one-write-at-a-time semantics without needing OS-level file locks.
 */
const writeQueues = new Map<string, Promise<void>>();

export function appendScoredRun(runDir: string, run: ScoredRun): Promise<void> {
  const file = resolve(runDir, "raw.jsonl");
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  const line = JSON.stringify(run) + "\n";
  const prev = writeQueues.get(runDir) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined) // do not propagate previous-write errors
    .then(() => appendFile(file, line));
  writeQueues.set(runDir, next);
  return next;
}

export function readScoredRuns(runDir: string): ScoredRun[] {
  const file = resolve(runDir, "raw.jsonl");
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l) as ScoredRun);
}

/**
 * Latest-wins dedup: if the same (taskId, caseId, variantId, modelId,
 * replicateIdx) appears multiple times (e.g. an errored attempt followed by a
 * successful retry on --resume), keep the most recent. Order in raw.jsonl is
 * append-only chronologically, so the last occurrence wins.
 */
export function readScoredRunsDeduped(runDir: string): ScoredRun[] {
  const all = readScoredRuns(runDir);
  const byKey = new Map<string, ScoredRun>();
  for (const r of all) {
    const variantId = r.variantId ?? "baseline";
    const k = tupleKey(r.taskId, r.caseId, r.modelId, variantId, r.replicateIdx);
    byKey.set(k, r);
  }
  return Array.from(byKey.values());
}

export function writeAggregate(runDir: string, aggregate: unknown): void {
  writeFileSync(
    resolve(runDir, "aggregate.json"),
    JSON.stringify(aggregate, null, 2)
  );
}

export function writeReport(runDir: string, html: string): string {
  const path = resolve(runDir, "report.html");
  writeFileSync(path, html);
  return path;
}

export function tupleKey(
  taskId: string,
  caseId: string,
  modelId: string,
  variantId: string,
  replicateIdx: number
): string {
  return `${taskId}::${caseId}::${variantId}::${modelId}::${replicateIdx}`;
}

/**
 * Tuples already on disk that succeeded. Errored runs are NOT counted as
 * complete so that --resume retries them automatically. Legacy rows without
 * a `variantId` field are treated as the "baseline" variant for back-compat.
 */
export function existingTupleKeys(runDir: string): Set<string> {
  const rows = readScoredRunsDeduped(runDir);
  const set = new Set<string>();
  for (const r of rows) {
    if (r.result.error) continue;
    const variantId = r.variantId ?? "baseline";
    set.add(tupleKey(r.taskId, r.caseId, r.modelId, variantId, r.replicateIdx));
  }
  return set;
}
