import { resolve } from "node:path";
import { aggregate } from "../report/build.js";
import { renderHtml } from "../report/template.js";
import {
  readScoredRunsDeduped,
  writeAggregate,
  writeReport,
} from "../runner/persist.js";

const runDir = process.argv[2];
if (!runDir) {
  console.error("Usage: npm run report -- <run-directory>");
  process.exit(1);
}
const abs = resolve(process.cwd(), runDir);
const runs = readScoredRunsDeduped(abs);
if (runs.length === 0) {
  console.error(`No runs found in ${abs}`);
  process.exit(1);
}
const report = aggregate(runs);
writeAggregate(abs, report);
const html = renderHtml(report);
const path = writeReport(abs, html);
console.log(`Wrote report: ${path}`);
console.log(`Open: file://${path}`);
