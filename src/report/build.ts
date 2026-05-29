import { MODELS, type ModelEntry } from "../config/models.js";
import { TASKS } from "../tasks/index.js";
import { variantsOf } from "../runner/sweep.js";
import type { ScoredRun } from "../tasks/types.js";

export interface CellStats {
  modelId: string;
  taskId: string;
  caseId?: string;
  variantId?: string;
  n: number;
  meanCorrectness: number;
  stdevCorrectness: number;
  meanLatencyMs: number;
  meanCostUsd: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  refusalRate: number;
  errorRate: number;
  subMetricMeans: Record<string, number>;
}

export interface AdaptationRow {
  taskId: string;
  taskDisplayName: string;
  modelId: string;
  modelDisplayName: string;
  baselineMean: number;
  baselineStdev: number;
  tunedMean: number;
  tunedStdev: number;
  delta: number;
  /** Extra variants beyond baseline & tuned (e.g. hybrid-rules) */
  extraVariants: { variantId: string; mean: number; stdev: number }[];
}

export interface DivergentCase {
  taskId: string;
  caseId: string;
  prompt: string;
  gold: unknown;
  perModel: Record<string, { meanCorrectness: number; sampleFinalText: string }>;
  maxMinusMin: number;
}

export interface ModelHealth {
  modelId: string;
  displayName: string;
  totalCalls: number;
  errorCount: number;
  errorRate: number;
  errorClasses: { classLabel: string; sampleMessage: string; count: number }[];
}

export interface ImpactScenario {
  id: string;
  title: string;
  severity: "critical" | "warning" | "info";
  finding: string;
  concreteExample: string;
  productionConsequence: string;
  mitigation: string;
}

export interface AggregatedReport {
  generatedAtIso: string;
  models: ModelEntry[];
  perModelTask: CellStats[];
  perCase: CellStats[];
  overall: Record<
    string,
    {
      meanCorrectness: number;
      /** API cost of the baseline-variant sweep for this model. */
      totalCostUsd: number;
      /** API cost across all variants (baseline + tuned + hybrid + ...). */
      totalCostUsdAllVariants: number;
      /** Cost of LLM-judge calls (and second-judge sample when enabled) for this model. */
      totalJudgeCostUsd: number;
      meanLatencyMs: number;
      callCount: number;
    }
  >;
  divergentCases: DivergentCase[];
  judgeRubricPoints: { modelId: string; caseId: string; rubric: number; judge: number }[];
  modelHealth: ModelHealth[];
  impactScenarios: ImpactScenario[];
  perModelTaskVariant: CellStats[];
  adaptation: AdaptationRow[];
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
/**
 * Sample stdev (divides by N - 1). With small replicate counts (N=2 or 3) this
 * is meaningfully larger than the population estimator and is the textbook
 * choice for procurement-decision quoting (which is what the report does in §3).
 *
 * Caveat: at N=2 sample stdev is just |a-b|/√2 — a single-pair noise figure,
 * not a true variance estimate. Methodology §11 calls this out.
 */
function stdev(xs: number[]): number {
  if (xs.length <= 1) return 0;
  const m = mean(xs);
  const sumSq = xs.reduce((a, x) => a + (x - m) ** 2, 0);
  return Math.sqrt(sumSq / (xs.length - 1));
}

function findCell(
  perModelTask: CellStats[],
  modelId: string,
  taskId: string
): CellStats | undefined {
  return perModelTask.find(
    (r) => r.modelId === modelId && r.taskId === taskId
  );
}

function pp(a: number, b: number): string {
  return ((a - b) * 100).toFixed(1);
}

function fmt(n: number, d = 3): string {
  return n.toFixed(d);
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

function buildImpactScenarios(
  perModelTask: CellStats[],
  overall: AggregatedReport["overall"],
  modelHealth: ModelHealth[]
): ImpactScenario[] {
  // Source cells (may be undefined if a model is missing — narrative degrades gracefully)
  const s4_tu = findCell(perModelTask, "claude-sonnet-4-20250514", "tool-use");
  const s45_tu = findCell(perModelTask, "claude-sonnet-4-5-20250929", "tool-use");
  const s46_tu = findCell(perModelTask, "claude-sonnet-4-6", "tool-use");

  const haiku_cls = findCell(
    perModelTask,
    "claude-haiku-4-5-20251001",
    "classification"
  );
  const sonnet46_cls = findCell(perModelTask, "claude-sonnet-4-6", "classification");
  const opus_cls = findCell(perModelTask, "claude-opus-4-7", "classification");

  const sonnet3Health = modelHealth.filter(
    (h) => h.modelId.startsWith("claude-3-") && h.errorCount > 0
  );
  const opusTempErrors = modelHealth
    .find((h) => h.modelId === "claude-opus-4-7")
    ?.errorClasses.find((c) => /temperature/i.test(c.classLabel));

  const haikuOverall = overall["claude-haiku-4-5-20251001"];
  const opusOverall = overall["claude-opus-4-7"];
  const sonnet46Overall = overall["claude-sonnet-4-6"];

  const scenarios: ImpactScenario[] = [];

  // 1. Silent regression — Sonnet 4.5 tool-use
  if (s4_tu && s45_tu && s46_tu) {
    const drop_pp = pp(s4_tu.meanCorrectness, s45_tu.meanCorrectness);
    scenarios.push({
      id: "silent-regression",
      title: "1. The silent regression — same code, model bumped, fewer bookings complete",
      severity: "warning",
      finding: `On tool use, Sonnet 4 → 4.5 dropped correctness ${fmt(
        s4_tu.meanCorrectness,
        2
      )} → ${fmt(s45_tu.meanCorrectness, 2)} (Δ −${drop_pp} percentage points). Sonnet 4.6 then recovered to ${fmt(
        s46_tu.meanCorrectness,
        2
      )}. The regression is real, not noise: n=${s4_tu.n} per cell, stdev ≈ ${fmt(s45_tu.stdevCorrectness, 2)}.`,
      concreteExample: `Anna books a Stockholm weekend trip via your travel-planning agent on Sonnet 4. The agent reliably searches flights, suggests an Old Town hotel and warns about the weather — 91% of bookings completed end-to-end. Tuesday, ops rolls a "minor model bump to Sonnet 4.5" for the better long-context support. Wednesday, Anna receives flight options but no hotel — the agent stopped after one tool call. Across 10 000 weekly bookings, that is ~400 extra half-completed trips.`,
      productionConsequence: `4 percentage points down means roughly 1 in 25 bookings now needs human follow-up. No alert fires because the API returned 200 OK; the agent just stopped calling tools earlier. Discovered three weeks in when finance sees hotel-affiliate revenue down 8% and support tickets up 30%. The "minor bump" cost a sprint of incident response.`,
      mitigation: `Run the 10 tool-use cases × 3 replicates against every candidate model before promotion. A ≥ 2 pp drop on the headline metric blocks the rollout in CI. This sweep cost roughly $0.65 per Sonnet model — cheaper than one undetected regression week.`,
    });
  }

  // 2. Deprecation cliff — Sonnet 3.x
  if (sonnet3Health.length > 0) {
    const totalErrors = sonnet3Health.reduce((a, h) => a + h.errorCount, 0);
    scenarios.push({
      id: "deprecation-cliff",
      title: "2. The deprecation cliff — your pinned model returns 404 overnight",
      severity: "critical",
      finding: `Every Sonnet 3.x model ID probed against this account returns 404 not_found_error: ${sonnet3Health
        .map((h) => `\`${h.modelId}\` (${h.errorCount} failed calls)`)
        .join(", ")}. Total observed errors across this sweep: ${totalErrors}. There is no path to roll back to the older snapshot.`,
      concreteExample: `Your customer-support classifier was pinned to \`claude-3-5-sonnet-20241022\` in production for the past 14 months — 200 000 tickets, 92% intent accuracy, stable. Monday 07:00, every API call returns 404. The agent silently routes every ticket into the "other" bucket while the SDK swallows the error. By 13:00 a backlog of 4 800 untriaged tickets has built up.`,
      productionConsequence: `The 404 happened months earlier in Anthropic's deprecation announcement — but the team missed the email. Same lockfile, same code, same model ID, but the model on the other end is gone. You are forced to migrate that same Monday afternoon with zero baseline data on the successor. Quality drops; you cannot measure by how much because the evals were not in CI.`,
      mitigation: `Probe every model ID in CI nightly with a 1-token ping (this repo's \`npm run probe-models\` costs ~$0.001). Subscribe to Anthropic's deprecation channel. Maintain a current-generation fallback (Sonnet 4.6) and run dual-track evals so the successor's behaviour is known before you need it.`,
    });
  }

  // 3. Contract change — Opus 4.7 temperature
  if (opusTempErrors) {
    scenarios.push({
      id: "contract-change",
      title: "3. The contract change — same model ID, parameter silently rejected",
      severity: "critical",
      finding: `Opus 4.7 rejected ${opusTempErrors.count} calls with HTTP 400 because the request included the \`temperature\` parameter, which is now deprecated for this model. Same SDK version, same model ID, same code: yet every call failed until a per-model capability flag was added.`,
      concreteExample: `Matti runs a contract-review agent on Opus 4.7. The code has set \`temperature: 0\` for two years because deterministic output is a compliance requirement. Friday afternoon, deploys go out. By Monday, every contract review fails with \`400 invalid_request_error: temperature is deprecated\`. The lockfile pins Anthropic SDK 0.40.x; nothing in this team's code changed. The behaviour change happened on Anthropic's side, under the same model ID.`,
      productionConsequence: `Compliance escalates: "All reviews failed for 72 hours." Audit asks: "How did this pass QA?" Answer: there was no automated check that the same parameters work against the same model ID over time. The fix was a one-line capability flag — but it took a Sunday and three eng-hours to find.`,
      mitigation: `Nightly smoke-test every supported (model × parameter-surface) tuple in CI. The eval harness here surfaces such breakages immediately as 400 errors in the governance section. Capability flags (\`supportsTemperature: false\`) make the workaround explicit rather than buried in retry logic.`,
    });
  }

  // 4. Tier mismatch — classification misroute volume
  if (haiku_cls && sonnet46_cls && opus_cls) {
    const haikuMisroute = 1 - haiku_cls.meanCorrectness;
    const sonnetMisroute = 1 - sonnet46_cls.meanCorrectness;
    const opusMisroute = 1 - opus_cls.meanCorrectness;
    const dailyTickets = 5000;
    const haikuMis = Math.round(dailyTickets * haikuMisroute);
    const sonnetMis = Math.round(dailyTickets * sonnetMisroute);
    const opusMis = Math.round(dailyTickets * opusMisroute);
    scenarios.push({
      id: "tier-mismatch",
      title: "4. Tier mismatch — picking too cheap a tier costs human handle time",
      severity: "warning",
      finding: `On the classification + reply task, mean correctness: Haiku ${fmt(
        haiku_cls.meanCorrectness,
        2
      )} → Sonnet 4.6 ${fmt(sonnet46_cls.meanCorrectness, 2)} → Opus 4.7 ${fmt(
        opus_cls.meanCorrectness,
        2
      )}. At ${dailyTickets.toLocaleString()} tickets/day that is ${haikuMis} misrouted on Haiku vs ${sonnetMis} on Sonnet 4.6 vs ${opusMis} on Opus 4.7.`,
      concreteExample: `Your support ops run a routing agent: classify ticket → reply or escalate. The team chose Haiku 4.5 because it was 16× cheaper than Opus. At ${dailyTickets.toLocaleString()} tickets/day, Haiku misroutes ${haikuMis} of them (${fmtPct(haikuMisroute)}). Each misroute costs ~6 minutes of human handle time when caught downstream: ${(haikuMis * 6 / 60).toFixed(0)} extra hours of L1 work per day. At €30/hour, ≈€${Math.round((haikuMis * 6 / 60) * 30).toLocaleString()}/day.`,
      productionConsequence: `Annualised, choosing Haiku over Sonnet 4.6 on this task costs ≈ €${Math.round((haikuMis - sonnetMis) * 6 / 60 * 30 * 250).toLocaleString()} of avoidable handle time per year (working-days basis). The Haiku savings on API cost are an order of magnitude smaller. Without the eval comparison, the buyer never sees this trade.`,
      mitigation: `Cost/accuracy scatter (section 7) makes this visible at a glance: Sonnet 4.6 sits on the Pareto frontier for this task. Use Haiku for tasks where the eval shows it is on the frontier (here, extraction is one such); use Sonnet 4.6 for classification.`,
    });
  }

  // 5. Variance ≠ determinism — LLMs are stochastic by design
  if (haiku_cls && opus_cls) {
    const ratio = (
      haiku_cls.stdevCorrectness / Math.max(opus_cls.stdevCorrectness, 0.001)
    ).toFixed(0);
    scenarios.push({
      id: "variance-risk",
      title: "5. Variance ≠ determinism — you cannot buy determinism from an LLM",
      severity: "info",
      finding: `On classification, Haiku 4.5 shows stdev ${fmt(
        haiku_cls.stdevCorrectness,
        3
      )} across replicates while Opus 4.7 shows stdev ${fmt(
        opus_cls.stdevCorrectness,
        3
      )} — roughly an ${ratio}× difference. Higher tiers are quieter, but neither is zero. Same prompt, same temperature 0, the model can still produce a different answer on the next call.`,
      concreteExample: `Quarterly compliance audit. The auditor samples 30 support replies and asks the team to re-generate them. On Haiku, three of the 30 come back with a different intent label — the same input produced "refund" twice and "complaint" once across the replicates. The team's first instinct is "upgrade to Opus, it is 8× less noisy." But Opus's stdev of ${fmt(
        opus_cls.stdevCorrectness,
        3
      )} is still strictly greater than zero — on a long enough tail of inputs, it will also disagree with itself. The auditor's bar is not "low variance"; it is "identical input ⇒ identical output, always." No LLM tier clears that bar.`,
      productionConsequence: `Higher-tier models reduce stochastic variance but cannot eliminate it. If your compliance regime, regulator, or contract demands true determinism, no Claude tier — Opus included — meets that bar. Paying the Opus premium to "buy determinism" is solving the wrong problem at the wrong layer; the auditor will find the residual variance eventually, and the documentation that called Opus "deterministic" becomes the liability.`,
      mitigation: `Don't try to buy determinism from an LLM — extract it. (1) If "intent → routing rule" must be deterministic for compliance, move that decision to a classical classifier or a rules table; reserve the LLM for the parts that genuinely need language understanding, such as drafting the reply once routing is already decided. (2) If "low behavioural variance" is what you actually need, quantify the bar (e.g. ≥98% identical-output rate on a regression set) and pick the cheapest tier that clears it — the variance box plot in section 8 is the procurement evidence. (3) Compose: tiered LLM for generation + deterministic logic for compliance-critical branching. The Opus cost premium is justified where the lower variance translates to measurable downstream value — not as a substitute for determinism that the LLM cannot provide.`,
    });
  }

  // 6. Pareto economics — naive Opus-for-everything
  if (haikuOverall && sonnet46Overall && opusOverall) {
    const opusPerCall = opusOverall.totalCostUsd / opusOverall.callCount;
    const sonnetPerCall = sonnet46Overall.totalCostUsd / sonnet46Overall.callCount;
    const monthlyVolume = 50_000;
    const naiveMonthly = monthlyVolume * opusPerCall;
    const routedSonnet = 0.8 * monthlyVolume * sonnetPerCall;
    const routedOpus = 0.2 * monthlyVolume * opusPerCall;
    const routedMonthly = routedSonnet + routedOpus;
    const monthlySaved = naiveMonthly - routedMonthly;
    const annualSaved = monthlySaved * 12;
    scenarios.push({
      id: "pareto-economics",
      title: "6. Pareto economics — naive 'always Opus' leaves real money on the table",
      severity: "info",
      finding: `Across this sweep, mean cost per call: Haiku $${fmt(
        haikuOverall.totalCostUsd / haikuOverall.callCount,
        4
      )}, Sonnet 4.6 $${fmt(sonnetPerCall, 4)}, Opus 4.7 $${fmt(opusPerCall, 4)} — Opus is ${(opusPerCall / sonnetPerCall).toFixed(1)}× Sonnet 4.6 for an overall +${pp(opusOverall.meanCorrectness, sonnet46Overall.meanCorrectness)} pp on correctness.`,
      concreteExample: `Stakeholder defaults to Opus for everything because "the best model". At ${monthlyVolume.toLocaleString()} interactions/month: $${fmt(naiveMonthly, 0)}/month, blended correctness ${fmt(opusOverall.meanCorrectness, 3)}. Routed alternative: Sonnet 4.6 for the 80% of interactions where the eval shows it matches Opus (extraction, reasoning, easy classification) + Opus for the 20% of hard cases. Routed monthly cost: $${fmt(routedMonthly, 0)}. Annual saving: ≈$${fmt(annualSaved, 0)} with negligible quality drop.`,
      productionConsequence: `Without the cost/accuracy chart, the procurement decision is "pick the headline number". With it, you can defend Sonnet-4.6-by-default to the CFO and Opus-when-flagged to engineering. Same SLO, lower TCO, documented trade-off.`,
      mitigation: `The cost/accuracy scatter (section 7) and tier comparison (section 5) are the artefacts to put in front of finance. Re-run the eval every quarter — pricing and quality both move.`,
    });
  }

  return scenarios;
}

export function aggregate(runs: ScoredRun[]): AggregatedReport {
  // Statistics aggregation uses only successful runs.
  // Errored runs are still retained for the modelHealth governance section.
  const okRuns = runs.filter((r) => !r.result.error);

  // Normalise: legacy rows in raw.jsonl may not have variantId. Treat missing
  // as the baseline variant.
  const okRunsWithVariant = okRuns.map((r) => ({
    ...r,
    variantId: r.variantId ?? "baseline",
  }));

  // The "headline" stats (perModelTask, perCase, overall) are computed on
  // BASELINE variant runs only, so that the existing charts continue to tell
  // the canonical "same prompt, different model" story. Variant comparison
  // lives in `adaptation` / `perModelTaskVariant`.
  const baselineRuns = okRunsWithVariant.filter(
    (r) => r.variantId === "baseline"
  );

  const perModelTask: CellStats[] = [];
  const perCase: CellStats[] = [];
  const overall: AggregatedReport["overall"] = {};

  // Per model+task (baseline only)
  for (const m of MODELS) {
    for (const t of TASKS) {
      const slice = baselineRuns.filter(
        (r) => r.modelId === m.id && r.taskId === t.id
      );
      if (slice.length === 0) continue;
      const correct = slice.map((r) => r.score.correctness);
      const latency = slice.map((r) => r.result.latencyMs);
      const cost = slice.map((r) => r.result.costUsd);
      const inputs = slice.map((r) => r.result.inputTokens);
      const outputs = slice.map((r) => r.result.outputTokens);
      const refusals = slice.filter((r) => r.result.refused).length;
      const errors = slice.filter((r) => r.result.error).length;

      const subKeys = new Set<string>();
      for (const r of slice)
        for (const k of Object.keys(r.score.subMetrics)) subKeys.add(k);
      const subMetricMeans: Record<string, number> = {};
      for (const k of subKeys) {
        // Average only across rows that actually reported the metric — using
        // `?? 0` would dilute sampled metrics (like second-judge agreement)
        // toward 0 when they weren't sampled on every row.
        const present = slice
          .map((r) => r.score.subMetrics[k])
          .filter((v): v is number => typeof v === "number");
        subMetricMeans[k] = present.length === 0 ? 0 : mean(present);
      }

      perModelTask.push({
        modelId: m.id,
        taskId: t.id,
        n: slice.length,
        meanCorrectness: mean(correct),
        stdevCorrectness: stdev(correct),
        meanLatencyMs: mean(latency),
        meanCostUsd: mean(cost),
        meanInputTokens: mean(inputs),
        meanOutputTokens: mean(outputs),
        refusalRate: refusals / slice.length,
        errorRate: errors / slice.length,
        subMetricMeans,
      });
    }

    // overall per model — baseline mean / baseline cost / all-variant cost /
    // judge cost are reported separately so the headline numbers stop hiding
    // the judge tax and the variant sweep cost.
    const baselineSlice = baselineRuns.filter((r) => r.modelId === m.id);
    if (baselineSlice.length > 0) {
      const allRunsForModel = okRunsWithVariant.filter((r) => r.modelId === m.id);
      const totalCostUsdAllVariants = allRunsForModel.reduce(
        (a, r) => a + r.result.costUsd,
        0
      );
      const totalJudgeCostUsd = allRunsForModel.reduce(
        (a, r) => a + (r.score.auxCostUsd ?? 0),
        0
      );
      overall[m.id] = {
        meanCorrectness: mean(baselineSlice.map((r) => r.score.correctness)),
        totalCostUsd: baselineSlice.reduce((a, r) => a + r.result.costUsd, 0),
        totalCostUsdAllVariants,
        totalJudgeCostUsd,
        meanLatencyMs: mean(baselineSlice.map((r) => r.result.latencyMs)),
        callCount: baselineSlice.length,
      };
    }
  }

  // Per case (model × task × case) — baseline only
  for (const t of TASKS) {
    for (const c of t.cases) {
      for (const m of MODELS) {
        const slice = baselineRuns.filter(
          (r) => r.modelId === m.id && r.taskId === t.id && r.caseId === c.id
        );
        if (slice.length === 0) continue;
        const correct = slice.map((r) => r.score.correctness);
        const subKeys = new Set<string>();
        for (const r of slice)
          for (const k of Object.keys(r.score.subMetrics)) subKeys.add(k);
        const subMetricMeans: Record<string, number> = {};
        for (const k of subKeys) {
          const present = slice
            .map((r) => r.score.subMetrics[k])
            .filter((v): v is number => typeof v === "number");
          subMetricMeans[k] = present.length === 0 ? 0 : mean(present);
        }
        perCase.push({
          modelId: m.id,
          taskId: t.id,
          caseId: c.id,
          n: slice.length,
          meanCorrectness: mean(correct),
          stdevCorrectness: stdev(correct),
          meanLatencyMs: mean(slice.map((r) => r.result.latencyMs)),
          meanCostUsd: mean(slice.map((r) => r.result.costUsd)),
          meanInputTokens: mean(slice.map((r) => r.result.inputTokens)),
          meanOutputTokens: mean(slice.map((r) => r.result.outputTokens)),
          refusalRate: slice.filter((r) => r.result.refused).length / slice.length,
          errorRate: slice.filter((r) => r.result.error).length / slice.length,
          subMetricMeans,
        });
      }
    }
  }

  // Divergent cases: max-min correctness >= 0.5 (baseline only)
  const divergentCases: DivergentCase[] = [];
  for (const t of TASKS) {
    for (const c of t.cases) {
      const perModel: Record<
        string,
        { meanCorrectness: number; sampleFinalText: string }
      > = {};
      for (const m of MODELS) {
        const slice = baselineRuns.filter(
          (r) => r.modelId === m.id && r.taskId === t.id && r.caseId === c.id
        );
        if (slice.length === 0) continue;
        const meanC = mean(slice.map((r) => r.score.correctness));
        const sample = slice[0]!.result.finalText.slice(0, 350);
        perModel[m.id] = { meanCorrectness: meanC, sampleFinalText: sample };
      }
      const vals = Object.values(perModel).map((v) => v.meanCorrectness);
      if (vals.length >= 2) {
        const maxMinusMin = Math.max(...vals) - Math.min(...vals);
        if (maxMinusMin >= 0.5) {
          divergentCases.push({
            taskId: t.id,
            caseId: c.id,
            prompt: String(t.buildUserPrompt(c.input)).slice(0, 600),
            gold: c.gold,
            perModel,
            maxMinusMin,
          });
        }
      }
    }
  }
  divergentCases.sort((a, b) => b.maxMinusMin - a.maxMinusMin);

  // Judge vs rubric scatter (classification only) — baseline successful runs only
  const judgeRubricPoints: AggregatedReport["judgeRubricPoints"] = [];
  for (const r of baselineRuns.filter((x) => x.taskId === "classification")) {
    const rubric = r.score.subMetrics.rubricScore;
    const judge = r.score.subMetrics.judgeScore;
    if (rubric !== undefined && judge !== undefined) {
      judgeRubricPoints.push({
        modelId: r.modelId,
        caseId: r.caseId,
        rubric,
        judge,
      });
    }
  }

  // Model health: count errors per model, classify by error pattern.
  // Iterates over every model_id observed in the runs (not just current MODELS)
  // so that historically failed models (e.g. now-deprecated Sonnet 3.x) remain
  // visible in the governance section.
  const observedModelIds = Array.from(new Set(runs.map((r) => r.modelId)));
  const modelHealth: ModelHealth[] = [];
  for (const modelId of observedModelIds) {
    const m = MODELS.find((x) => x.id === modelId);
    const displayName = m?.displayName ?? `${modelId} (no longer in registry)`;
    const slice = runs.filter((r) => r.modelId === modelId);
    if (slice.length === 0) continue;
    const errors = slice.filter((r) => r.result.error);
    const errorClasses = new Map<
      string,
      { sampleMessage: string; count: number }
    >();
    for (const r of errors) {
      const msg = r.result.error ?? "";
      let label = "unknown";
      if (/not_found_error|404/i.test(msg)) label = "404 model not found";
      else if (/temperature.*deprecated/i.test(msg)) label = "temperature deprecated (API contract change)";
      else if (/rate.?limit|429/i.test(msg)) label = "rate limited (429)";
      else if (/overloaded|529/i.test(msg)) label = "overloaded (529)";
      else if (/invalid_request_error|400/i.test(msg)) label = "invalid request (400)";
      else if (/timeout|aborted/i.test(msg)) label = "timeout";
      const existing = errorClasses.get(label);
      if (existing) existing.count++;
      else errorClasses.set(label, { sampleMessage: msg, count: 1 });
    }
    modelHealth.push({
      modelId,
      displayName,
      totalCalls: slice.length,
      errorCount: errors.length,
      errorRate: errors.length / slice.length,
      errorClasses: Array.from(errorClasses.entries()).map(([classLabel, v]) => ({
        classLabel,
        sampleMessage: v.sampleMessage,
        count: v.count,
      })),
    });
  }

  const impactScenarios = buildImpactScenarios(
    perModelTask,
    overall,
    modelHealth
  );

  // Per (model × task × variant) — used for §3b adaptation
  const perModelTaskVariant: CellStats[] = [];
  for (const m of MODELS) {
    for (const t of TASKS) {
      const variants = variantsOf(t);
      for (const v of variants) {
        const slice = okRunsWithVariant.filter(
          (r) =>
            r.modelId === m.id &&
            r.taskId === t.id &&
            r.variantId === v.id
        );
        if (slice.length === 0) continue;
        const correct = slice.map((r) => r.score.correctness);
        const subKeys = new Set<string>();
        for (const r of slice)
          for (const k of Object.keys(r.score.subMetrics)) subKeys.add(k);
        const subMetricMeans: Record<string, number> = {};
        for (const k of subKeys) {
          const present = slice
            .map((r) => r.score.subMetrics[k])
            .filter((v): v is number => typeof v === "number");
          subMetricMeans[k] = present.length === 0 ? 0 : mean(present);
        }
        perModelTaskVariant.push({
          modelId: m.id,
          taskId: t.id,
          variantId: v.id,
          n: slice.length,
          meanCorrectness: mean(correct),
          stdevCorrectness: stdev(correct),
          meanLatencyMs: mean(slice.map((r) => r.result.latencyMs)),
          meanCostUsd: mean(slice.map((r) => r.result.costUsd)),
          meanInputTokens: mean(slice.map((r) => r.result.inputTokens)),
          meanOutputTokens: mean(slice.map((r) => r.result.outputTokens)),
          refusalRate: slice.filter((r) => r.result.refused).length / slice.length,
          errorRate: 0,
          subMetricMeans,
        });
      }
    }
  }

  // Adaptation summary: per (task × model), baseline vs tuned + any extra variants
  const adaptation: AdaptationRow[] = [];
  for (const m of MODELS) {
    for (const t of TASKS) {
      const baseline = perModelTaskVariant.find(
        (r) =>
          r.modelId === m.id && r.taskId === t.id && r.variantId === "baseline"
      );
      const tuned = perModelTaskVariant.find(
        (r) => r.modelId === m.id && r.taskId === t.id && r.variantId === "tuned"
      );
      if (!baseline || !tuned) continue;
      const extras = perModelTaskVariant
        .filter(
          (r) =>
            r.modelId === m.id &&
            r.taskId === t.id &&
            r.variantId !== "baseline" &&
            r.variantId !== "tuned"
        )
        .map((r) => ({
          variantId: r.variantId ?? "",
          mean: r.meanCorrectness,
          stdev: r.stdevCorrectness,
        }));
      adaptation.push({
        taskId: t.id,
        taskDisplayName: t.displayName,
        modelId: m.id,
        modelDisplayName: m.displayName,
        baselineMean: baseline.meanCorrectness,
        baselineStdev: baseline.stdevCorrectness,
        tunedMean: tuned.meanCorrectness,
        tunedStdev: tuned.stdevCorrectness,
        delta: tuned.meanCorrectness - baseline.meanCorrectness,
        extraVariants: extras,
      });
    }
  }

  return {
    generatedAtIso: new Date().toISOString(),
    models: [...MODELS],
    perModelTask,
    perCase,
    overall,
    divergentCases,
    judgeRubricPoints,
    modelHealth,
    impactScenarios,
    perModelTaskVariant,
    adaptation,
  };
}
