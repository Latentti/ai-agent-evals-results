import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { MODELS, modelById } from "../config/models.js";
import { TASKS, taskById } from "../tasks/index.js";
import {
  confirmBudget,
  estimateSweepCost,
  printEstimate,
} from "../runner/budget.js";
import { runSweep } from "../runner/sweep.js";
import { aggregate } from "../report/build.js";
import { renderHtml } from "../report/template.js";
import {
  makeRunDir,
  readScoredRunsDeduped,
  writeAggregate,
  writeReport,
} from "../runner/persist.js";

// Tiny .env loader (no extra dep)
function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf-8").split("\n");
  for (const ln of lines) {
    const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!k) continue;
    if (process.env[k] !== undefined) continue;
    const val = (v ?? "").replace(/^"(.*)"$/, "$1");
    process.env[k] = val;
  }
}
loadDotEnv();

function parseArgs(argv: string[]): {
  yes: boolean;
  models: typeof MODELS;
  tasks: typeof TASKS;
  variantIds?: Set<string>;
  resume?: string;
} {
  const out: {
    yes: boolean;
    models: typeof MODELS;
    tasks: typeof TASKS;
    variantIds?: Set<string>;
    resume?: string;
  } = {
    yes: false,
    models: MODELS,
    tasks: TASKS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") out.yes = true;
    if (a === "--models") {
      const ids = (argv[++i] ?? "").split(",");
      const ms = ids.map((id) => modelById(id)).filter(Boolean) as typeof MODELS;
      if (ms.length) out.models = ms as unknown as typeof MODELS;
    }
    if (a === "--tasks") {
      const ids = (argv[++i] ?? "").split(",");
      const ts = ids.map((id) => taskById(id)).filter(Boolean) as typeof TASKS;
      if (ts.length) out.tasks = ts as unknown as typeof TASKS;
    }
    if (a === "--variants") {
      const ids = (argv[++i] ?? "").split(",").filter(Boolean);
      if (ids.length) out.variantIds = new Set(ids);
    }
    if (a === "--resume") out.resume = argv[++i];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Add it to .env or your shell.");
    process.exit(1);
  }

  const summary = estimateSweepCost(args.models, args.tasks);
  printEstimate(summary);
  await confirmBudget(summary, { yes: args.yes });

  const runDir = args.resume ?? makeRunDir(process.cwd());
  console.log(`Run directory: ${runDir}\n`);

  let lastReport = 0;
  await runSweep({
    runDir,
    models: args.models,
    tasks: args.tasks,
    variantIds: args.variantIds,
    onProgress: (done, total, lastKey) => {
      const now = Date.now();
      if (now - lastReport < 500 && done !== total) return;
      lastReport = now;
      const pct = ((done / total) * 100).toFixed(1);
      process.stdout.write(`\r  progress: ${done}/${total} (${pct}%)  last: ${lastKey}                `);
      if (done === total) process.stdout.write("\n");
    },
  });

  console.log("\nAggregating results...");
  const runs = readScoredRunsDeduped(runDir);
  const report = aggregate(runs);
  writeAggregate(runDir, report);
  const html = renderHtml(report);
  const reportPath = writeReport(runDir, html);
  console.log(`Wrote report: ${reportPath}`);
  console.log(`Open it in your browser:  file://${reportPath}`);
}

main().catch((err) => {
  console.error("\nSweep failed:", err);
  process.exit(1);
});
