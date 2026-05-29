import { MODELS } from "../config/models.js";
import { TASKS } from "../tasks/index.js";
import type { AggregatedReport } from "./build.js";
import {
  adaptationSpec,
  costAccuracyScatterSpec,
  judgeRubricScatterSpec,
  overallBarSpec,
  temporalSmallMultiplesSpec,
  tierComparisonSpec,
  varianceBoxSpec,
} from "./charts.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function heatColor(v: number): string {
  // 0 = red, 0.5 = amber, 1 = green
  const clamp = Math.max(0, Math.min(1, v));
  const r = Math.round(255 * (1 - clamp));
  const g = Math.round(180 * clamp + 40);
  return `rgb(${r},${g},80)`;
}

function summaryTable(report: AggregatedReport): string {
  const rows = MODELS.filter((m) => report.overall[m.id])
    .map((m) => {
      const o = report.overall[m.id]!;
      const judgeTax =
        o.totalJudgeCostUsd > 0
          ? `<small style="color:#666"> +$${o.totalJudgeCostUsd.toFixed(3)} judge</small>`
          : "";
      return `<tr>
      <td>${escapeHtml(m.displayName)}</td>
      <td>${m.family}</td>
      <td style="background:${heatColor(o.meanCorrectness)};color:#fff;text-align:right">${o.meanCorrectness.toFixed(3)}</td>
      <td style="text-align:right">$${o.totalCostUsd.toFixed(3)}</td>
      <td style="text-align:right">$${o.totalCostUsdAllVariants.toFixed(3)}${judgeTax}</td>
      <td style="text-align:right">${Math.round(o.meanLatencyMs)} ms</td>
      <td style="text-align:right">${o.callCount}</td>
    </tr>`;
    })
    .join("\n");
  return `<table>
    <thead><tr>
      <th>Model</th>
      <th>Family</th>
      <th>Mean correctness (baseline)</th>
      <th>Baseline cost</th>
      <th>All-variant cost <small>(judge tax shown inline)</small></th>
      <th>Mean latency</th>
      <th>Calls (baseline)</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function deepDiveTable(report: AggregatedReport): string {
  // Rows = cases (sorted by max-divergence across models), columns = models
  type Row = {
    taskId: string;
    caseId: string;
    perModel: Record<string, number>;
    divergence: number;
  };
  const rows: Row[] = [];
  for (const t of TASKS) {
    for (const c of t.cases) {
      const perModel: Record<string, number> = {};
      for (const m of MODELS) {
        const cell = report.perCase.find(
          (r) =>
            r.modelId === m.id && r.taskId === t.id && r.caseId === c.id
        );
        if (cell) perModel[m.id] = cell.meanCorrectness;
      }
      const vals = Object.values(perModel);
      if (vals.length === 0) continue;
      const divergence = Math.max(...vals) - Math.min(...vals);
      rows.push({ taskId: t.id, caseId: c.id, perModel, divergence });
    }
  }
  rows.sort((a, b) => b.divergence - a.divergence);

  const header = `<tr><th>Task</th><th>Case</th>${MODELS.map(
    (m) => `<th>${escapeHtml(m.shortName)}</th>`
  ).join("")}<th>Δ</th></tr>`;

  const body = rows
    .map((r) => {
      const cells = MODELS.map((m) => {
        const v = r.perModel[m.id];
        if (v === undefined) return `<td style="color:#aaa">—</td>`;
        return `<td style="background:${heatColor(v)};color:#fff;text-align:right">${v.toFixed(2)}</td>`;
      }).join("");
      return `<tr><td>${escapeHtml(r.taskId)}</td><td><code>${escapeHtml(r.caseId)}</code></td>${cells}<td style="text-align:right">${r.divergence.toFixed(2)}</td></tr>`;
    })
    .join("\n");

  return `<table class="deep-dive"><thead>${header}</thead><tbody>${body}</tbody></table>`;
}

function divergentSection(report: AggregatedReport): string {
  if (report.divergentCases.length === 0) {
    return `<p><em>No cases with divergence ≥ 0.5 found. Models agreed broadly.</em></p>`;
  }
  return report.divergentCases
    .slice(0, 12)
    .map((d) => {
      const perModelRows = MODELS.filter((m) => d.perModel[m.id])
        .map((m) => {
          const v = d.perModel[m.id]!;
          return `<tr>
          <td><strong>${escapeHtml(m.shortName)}</strong></td>
          <td style="background:${heatColor(v.meanCorrectness)};color:#fff;text-align:right;width:80px">${v.meanCorrectness.toFixed(2)}</td>
          <td><pre style="white-space:pre-wrap;margin:0">${escapeHtml(v.sampleFinalText)}</pre></td>
        </tr>`;
        })
        .join("\n");
      return `<details open><summary><strong>${escapeHtml(d.taskId)} / ${escapeHtml(d.caseId)}</strong> — divergence: ${d.maxMinusMin.toFixed(2)}</summary>
      <div class="divergent-case">
        <p><strong>Prompt:</strong></p>
        <pre style="white-space:pre-wrap">${escapeHtml(d.prompt)}</pre>
        <p><strong>Gold answer:</strong></p>
        <pre style="white-space:pre-wrap">${escapeHtml(JSON.stringify(d.gold, null, 2))}</pre>
        <p><strong>Per-model outputs:</strong></p>
        <table>${perModelRows}</table>
      </div>
    </details>`;
    })
    .join("\n");
}

function adaptationSection(report: AggregatedReport): string {
  if (report.adaptation.length === 0) {
    return `<p><em>No tuned-variant data found. Run <code>npm run sweep</code> with variant support to populate this section.</em></p>`;
  }

  const byTask = new Map<string, typeof report.adaptation>();
  for (const r of report.adaptation) {
    const list = byTask.get(r.taskDisplayName) ?? [];
    list.push(r);
    byTask.set(r.taskDisplayName, list);
  }

  const tableRows: string[] = [];
  for (const [task, rows] of byTask) {
    for (const r of rows) {
      const deltaCell =
        r.delta > 0.005
          ? `<td style="background:#dff5d8;color:#1a6c1a;text-align:right">+${(r.delta * 100).toFixed(1)} pp</td>`
          : r.delta < -0.005
          ? `<td style="background:#fbe2e2;color:#a02020;text-align:right">${(r.delta * 100).toFixed(1)} pp</td>`
          : `<td style="text-align:right">~0</td>`;
      const extras = r.extraVariants
        .map(
          (e) =>
            `<small style="color:#666">${escapeHtml(e.variantId)} ${e.mean.toFixed(2)}</small>`
        )
        .join(" ");
      tableRows.push(`<tr>
        <td>${escapeHtml(task)}</td>
        <td>${escapeHtml(r.modelDisplayName)}</td>
        <td style="text-align:right">${r.baselineMean.toFixed(3)}</td>
        <td style="text-align:right">${r.tunedMean.toFixed(3)}</td>
        ${deltaCell}
        <td>${extras}</td>
      </tr>`);
    }
  }

  // Hybrid-rules deep dive (classification only)
  const hybridRows = report.perModelTaskVariant.filter(
    (r) => r.taskId === "classification" && r.variantId === "hybrid-rules"
  );
  let hybridBlock = "";
  if (hybridRows.length > 0) {
    const hybridTable = hybridRows
      .map((h) => {
        const baseline = report.perModelTaskVariant.find(
          (r) =>
            r.modelId === h.modelId &&
            r.taskId === "classification" &&
            r.variantId === "baseline"
        );
        const m = MODELS.find((x) => x.id === h.modelId);
        const intentDelta =
          (h.subMetricMeans.intentCorrect ?? 0) -
          (baseline?.subMetricMeans.intentCorrect ?? 0);
        return `<tr>
        <td>${escapeHtml(m?.displayName ?? h.modelId)}</td>
        <td style="text-align:right">${(baseline?.subMetricMeans.intentCorrect ?? 0).toFixed(3)}</td>
        <td style="text-align:right">${(h.subMetricMeans.intentCorrect ?? 0).toFixed(3)}</td>
        <td style="text-align:right">${(intentDelta * 100).toFixed(1)} pp</td>
        <td style="text-align:right">${(h.subMetricMeans.judgeScore ?? 0).toFixed(3)}</td>
        <td style="text-align:right">${(h.subMetricMeans.rubricScore ?? 0).toFixed(3)}</td>
      </tr>`;
      })
      .join("\n");
    hybridBlock = `
      <h3>Hybrid case study (classification only) — extract determinism out of the LLM</h3>
      <p>The <strong>hybrid-rules</strong> variant moves intent classification from the LLM to a small keyword-regex engine. The LLM is then called only to draft the reply, given the already-determined intent. Compare the intent-accuracy column to the baseline: rules can hit a literal ceiling on the cases they cover, with zero stochastic variance.</p>
      <table>
        <thead><tr>
          <th>Model</th>
          <th>Baseline intent acc.</th>
          <th>Hybrid intent acc.</th>
          <th>Δ</th>
          <th>Reply judge score</th>
          <th>Reply rubric score</th>
        </tr></thead>
        <tbody>${hybridTable}</tbody>
      </table>
      <p><em>Note: the rules engine in <code>src/tasks/classification.ts</code> uses a small generic pattern set; a production hybrid would expand the patterns or use a classical classifier. The point is architectural: the deterministic decision is no longer LLM-stochastic.</em></p>
    `;
  }

  return `
    <p>So evals catch regressions and contract changes — what can you actually do about them? This section runs the same eval against a <strong>tuned</strong> system-prompt variant for every task (multi-step instructions + few-shot example), and reports the delta vs. baseline. For classification only, it also runs a <strong>hybrid-rules</strong> variant that extracts intent classification out of the LLM entirely. The point is not "prompt engineering always rescues you" — it is that the eval is how you <em>know</em> whether your fix actually worked, or merely shifted the failure mode.</p>
    <h3>Baseline vs. tuned prompt (Δ in percentage points)</h3>
    <table>
      <thead><tr>
        <th>Task</th>
        <th>Model</th>
        <th>Baseline</th>
        <th>Tuned</th>
        <th>Δ</th>
        <th>Other variants</th>
      </tr></thead>
      <tbody>${tableRows.join("\n")}</tbody>
    </table>
    <div class="chart" id="chart-adaptation"></div>
    ${hybridBlock}
  `;
}

function impactSection(report: AggregatedReport): string {
  if (report.impactScenarios.length === 0) {
    return `<p><em>No impact scenarios were generated — model data may be incomplete.</em></p>`;
  }
  const cards = report.impactScenarios
    .map((s) => {
      const color =
        s.severity === "critical"
          ? "#cc1f1f"
          : s.severity === "warning"
          ? "#cc7a1f"
          : "#5C8DEF";
      const bg =
        s.severity === "critical"
          ? "#fdf3f3"
          : s.severity === "warning"
          ? "#fff8e6"
          : "#f4f8ff";
      return `<details open class="scenario-card" style="border-left:5px solid ${color};background:${bg}">
        <summary style="font-size:1.02rem;font-weight:600;color:${color}">${escapeHtml(s.title)}</summary>
        <div style="padding:0.4rem 0 0 0">
          <p><strong>Finding.</strong> ${escapeHtml(s.finding)}</p>
          <p><strong>Concrete example.</strong> ${escapeHtml(s.concreteExample)}</p>
          <p><strong>Production consequence.</strong> ${escapeHtml(s.productionConsequence)}</p>
          <p><strong>What the eval enables.</strong> ${escapeHtml(s.mitigation)}</p>
        </div>
      </details>`;
    })
    .join("\n");
  return `
    <p>Each scenario below pairs an empirical finding from this sweep with a concrete production vignette — "what would have happened if you had shipped this model change blind." Numbers are templated from <code>aggregate.json</code>, so they refresh on every re-run.</p>
    ${cards}
  `;
}

function governanceSection(report: AggregatedReport): string {
  const totalHealthRows = report.modelHealth.length;
  if (totalHealthRows === 0) {
    return `<p><em>No runs to report on.</em></p>`;
  }
  const anyErrors = report.modelHealth.some((h) => h.errorCount > 0);
  const rows = report.modelHealth
    .map((h) => {
      const status =
        h.errorCount === 0
          ? `<span style="color:#2a9d2a">healthy</span>`
          : h.errorCount === h.totalCalls
          ? `<span style="color:#cc1f1f"><strong>BROKEN</strong></span>`
          : `<span style="color:#cc7a1f">degraded</span>`;
      return `<tr>
      <td>${escapeHtml(h.displayName)}</td>
      <td style="text-align:right">${h.totalCalls}</td>
      <td style="text-align:right">${h.errorCount}</td>
      <td style="text-align:right">${(h.errorRate * 100).toFixed(1)}%</td>
      <td>${status}</td>
    </tr>`;
    })
    .join("\n");

  const classRows: string[] = [];
  for (const h of report.modelHealth) {
    for (const c of h.errorClasses) {
      classRows.push(`<tr>
        <td>${escapeHtml(h.displayName)}</td>
        <td><strong>${escapeHtml(c.classLabel)}</strong></td>
        <td style="text-align:right">${c.count}</td>
        <td><code>${escapeHtml(c.sampleMessage.slice(0, 200))}</code></td>
      </tr>`);
    }
  }

  const governanceLede = anyErrors
    ? `<p class="callout"><strong>This run uncovered real API-contract drift.</strong> Frontier models are refreshed every 12–18 months, and the existing model IDs your production agent depends on do not stay frozen: snapshots get deprecated, parameters get removed, behaviour shifts. Below: which models in this sweep were affected, by what failure mode, and what that means for a production agent running unattended.</p>`
    : `<p>All models in this sweep ran without API-level errors. (Watch this section if you re-run after a model refresh — the same code can stop working when the API contract under a model ID changes.)</p>`;

  return `
    ${governanceLede}
    <h3>Per-model health</h3>
    <table><thead><tr><th>Model</th><th>Calls</th><th>Errors</th><th>Error rate</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
    ${
      classRows.length > 0
        ? `<h3>Error classes observed</h3>
    <table><thead><tr><th>Model</th><th>Class</th><th>Count</th><th>Sample message</th></tr></thead><tbody>${classRows.join("\n")}</tbody></table>
    <h3>Governance implications</h3>
    <ul>
      <li><strong>"404 model not found"</strong> — your API key / organization no longer has access to a dated model snapshot. A production agent pinned to this ID will start failing every request. Mitigation: monitor for 404s on every model deployment; have a fallback or rolling-alias strategy; subscribe to Anthropic's deprecation notices.</li>
      <li><strong>"temperature deprecated"</strong> — the API contract under a model ID has been narrowed. Your agent code that worked with one model fails outright on the newer one even though the model ID and SDK version are unchanged. Mitigation: capability flags per model (this report's <code>supportsTemperature</code> is one such flag); integration tests in CI against every supported model; do not assume the cross-product of (SDK, model) is forward-compatible.</li>
      <li><strong>Rate / overload (429/529)</strong> — transient but observable. Mitigation: exponential backoff with jitter (this codebase does that), per-model concurrency limits, circuit breakers.</li>
    </ul>
    <p class="callout"><strong>Why this matters for your agent:</strong> the same prompt + the same code + a model refresh ≠ the same behaviour. This sweep is a snapshot of <em>today</em>; the only reliable defence is to re-run it on every model change — i.e. evals as a standing CI gate, not a one-time exercise.</p>`
        : ""
    }
  `;
}

function methodologySection(report: AggregatedReport): string {
  const replicateTable = TASKS.map(
    (t) =>
      `<tr><td>${escapeHtml(t.displayName)}</td><td>${t.replicates}</td><td>${t.cases.length}</td></tr>`
  ).join("\n");
  return `
    <h3>Replicate counts</h3>
    <table><thead><tr><th>Task</th><th>Replicates per case</th><th>Cases</th></tr></thead><tbody>${replicateTable}</tbody></table>
    <h3>Models</h3>
    <table><thead><tr><th>Model</th><th>ID</th><th>Family</th><th>Axes</th></tr></thead><tbody>
      ${MODELS.map((m) => `<tr><td>${escapeHtml(m.displayName)}</td><td><code>${escapeHtml(m.id)}</code></td><td>${m.family}</td><td>${m.axes.join(", ")}</td></tr>`).join("\n")}
    </tbody></table>
    <h3>Policy decisions</h3>
    <ul>
      <li><strong>Pure-prompt policy:</strong> identical system + user prompts across all models. No per-model prompt tuning. Older-model failures are part of the demonstration.</li>
      <li><strong>Temperature = 0</strong> for all calls; non-determinism still visible, see variance box plot.</li>
      <li><strong>Prompt caching disabled</strong> to keep cost/latency comparisons clean across models.</li>
      <li><strong>LLM-judge bias caveat:</strong> Sonnet 4.6 is the judge for classification reply quality; it may favour its own outputs. The judge-vs-rubric agreement chart surfaces disagreement.</li>
      <li><strong>Tokenizer drift:</strong> the cost estimate uses a 4 chars/token heuristic; actual costs printed in this report use the real <code>usage</code> token counts from the API and are exact within the API's reported tokens.</li>
      <li><strong>Stdev is sample stdev (N − 1).</strong> At N = 2 replicates (extraction and reasoning tasks), stdev collapses to <code>|a − b| / √2</code> — a single-pair noise figure, not a real variance estimate. Treat stdev numbers on those tasks as directional, not statistical. Classification and tool-use run N = 3 per cell.</li>
      <li><strong>Refusal detection is EN + FI only.</strong> The regex patterns in <code>src/agent/loop.ts</code> match English and Finnish refusal idioms. Cross-locale sweeps will under-report refusals on other languages — surface this gap before quoting refusal rates outside those locales.</li>
      <li><strong>Total cost columns.</strong> "Baseline cost" is the spend for the baseline-variant runs only; "All-variant cost" adds tuned and hybrid-rules sweep cost; the inline "judge tax" is the API spend on Sonnet-judge (and sampled Opus second-judge) calls used to score classification replies.</li>
    </ul>
    <p><em>Report generated at ${escapeHtml(report.generatedAtIso)}.</em></p>
  `;
}

export function renderHtml(report: AggregatedReport): string {
  const specs = {
    overall: overallBarSpec(report),
    temporal: temporalSmallMultiplesSpec(report),
    tier: tierComparisonSpec(report),
    costAccuracy: costAccuracyScatterSpec(report),
    variance: varianceBoxSpec(report),
    judgeRubric: judgeRubricScatterSpec(report),
    adaptation: adaptationSpec(report),
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>AI Agent Model-Difference Evals</title>
  <script src="https://cdn.jsdelivr.net/npm/vega@5"></script>
  <script src="https://cdn.jsdelivr.net/npm/vega-lite@5"></script>
  <script src="https://cdn.jsdelivr.net/npm/vega-embed@6"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1.5rem; color: #1c1c1c; line-height: 1.5; }
    h1 { border-bottom: 2px solid #333; padding-bottom: 0.4rem; }
    h2 { margin-top: 2.5rem; border-left: 4px solid #5C8DEF; padding-left: 0.6rem; }
    h3 { margin-top: 1.4rem; color: #333; }
    table { border-collapse: collapse; margin: 0.6rem 0; }
    th, td { padding: 0.4rem 0.7rem; border: 1px solid #d8d8d8; font-size: 0.92rem; }
    th { background: #f1f3f8; }
    code { background: #f1f3f8; padding: 0 0.25rem; border-radius: 3px; font-size: 0.88em; }
    pre { background: #f8f9fb; padding: 0.6rem; border-radius: 4px; border: 1px solid #ececec; overflow-x: auto; font-size: 0.85rem; }
    details { margin: 0.6rem 0; }
    summary { cursor: pointer; padding: 0.3rem 0; }
    .chart { margin: 0.8rem 0 1.5rem; }
    .deep-dive td:first-child, .deep-dive td:nth-child(2) { font-size: 0.85rem; }
    .divergent-case { padding: 0.5rem 1rem; border-left: 3px solid #B266FF; background: #fbf7ff; }
    .lede { font-size: 1.05rem; color: #444; }
    .callout { padding: 0.7rem 1rem; background: #fff8e6; border-left: 4px solid #cc7a1f; border-radius: 2px; }
    .scenario-card { padding: 0.7rem 1rem; margin: 0.7rem 0; border-radius: 4px; }
    .scenario-card summary { cursor: pointer; }
    .scenario-card p { margin: 0.35rem 0; }
  </style>
</head>
<body>
  <h1>AI Agent Model-Difference Evals</h1>
  <p class="lede">A demonstration of how the choice of Claude model affects agent outcomes across four task types and two comparison axes — built to make the case for why <strong>evals matter</strong> when models change in production. Frontier models are forcibly refreshed every 12–18 months; this report illustrates the governance burden that creates.</p>

  <h2>1. Executive summary</h2>
  ${summaryTable(report)}
  <div class="chart" id="chart-overall"></div>

  <h2>2. Model availability &amp; API contract changes</h2>
  ${governanceSection(report)}

  <h2>3. Impact scenarios — what evals catch before production</h2>
  ${impactSection(report)}

  <h2>3b. Adaptation — closing regressions with prompts</h2>
  ${adaptationSection(report)}

  <h2>4. Temporal evolution — Sonnet 4 → 4.5 → 4.6</h2>
  <p>Same prompt, same case, same scoring. Each panel is one task type. Error bars are ±1σ across replicates.</p>
  <div class="chart" id="chart-temporal"></div>

  <h2>5. Tier comparison — Haiku 4.5 / Sonnet 4.6 / Opus 4.7</h2>
  <p>Same generation, three tiers. Correctness on the left; mean cost per case on the right.</p>
  <div class="chart" id="chart-tier"></div>

  <h2>6. Per-case deep dive</h2>
  <p>Rows are individual cases, sorted by max-min divergence across models (most divergent on top). Cell colour = mean correctness.</p>
  ${deepDiveTable(report)}

  <h2>7. Cost vs accuracy</h2>
  <p>Each point is a (model, task) pair. X-axis is mean cost per case in USD (log scale); y-axis is mean correctness. The Pareto frontier (top-left envelope) is the cost-optimal set.</p>
  <div class="chart" id="chart-cost-accuracy"></div>

  <h2>8. Variance — where the noise lives</h2>
  <p>Box plot of per-case mean correctness, per (model × task). Wide boxes mean: same model gives meaningfully different answers across cases or replicates.</p>
  <div class="chart" id="chart-variance"></div>

  <h2>9. Judge vs rubric (classification)</h2>
  <p>Each point is one (model, case) classification reply. X-axis is the deterministic rule-rubric score; y-axis is the Sonnet-4.6 LLM-judge score. Points off the diagonal = the two scoring methods disagree. This itself is an eval-quality story: <em>what you measure</em> changes <em>which model looks best</em>.</p>
  <div class="chart" id="chart-judge-rubric"></div>

  <h2>10. Notable divergences</h2>
  <p>Cases where the gap between best- and worst-performing model is ≥ 0.5. These are the educational payoff: same prompt, different models, different answers.</p>
  ${divergentSection(report)}

  <h2>11. Methodology &amp; caveats</h2>
  ${methodologySection(report)}

  <script>
    // Defensively escape "</script" anywhere inside the embedded specs so a
    // future change that lets case prompts / user-controlled text into a chart
    // tooltip cannot prematurely close this script tag.
    const specs = ${JSON.stringify(specs).replace(/<\/script/gi, "<\\/script")};
    vegaEmbed('#chart-overall', specs.overall, { actions: false });
    vegaEmbed('#chart-temporal', specs.temporal, { actions: false });
    vegaEmbed('#chart-tier', specs.tier, { actions: false });
    vegaEmbed('#chart-cost-accuracy', specs.costAccuracy, { actions: false });
    vegaEmbed('#chart-variance', specs.variance, { actions: false });
    vegaEmbed('#chart-judge-rubric', specs.judgeRubric, { actions: false });
    if (document.getElementById('chart-adaptation')) {
      vegaEmbed('#chart-adaptation', specs.adaptation, { actions: false });
    }
  </script>
</body>
</html>`;
}
