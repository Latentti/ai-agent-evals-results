import { MODELS } from "../config/models.js";
import { TASKS } from "../tasks/index.js";
import type { AggregatedReport } from "./build.js";

const FAMILY_COLORS = {
  haiku: "#7BC36A",
  sonnet: "#5C8DEF",
  opus: "#B266FF",
};

export function overallBarSpec(report: AggregatedReport): object {
  const data = Object.entries(report.overall).map(([modelId, v]) => {
    const m = MODELS.find((x) => x.id === modelId)!;
    return {
      model: m.displayName,
      shortName: m.shortName,
      family: m.family,
      correctness: v.meanCorrectness,
    };
  });
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    width: 600,
    height: 280,
    data: { values: data },
    mark: { type: "bar" },
    encoding: {
      y: { field: "model", type: "nominal", sort: "-x", title: null },
      x: {
        field: "correctness",
        type: "quantitative",
        scale: { domain: [0, 1] },
        title: "Mean correctness",
      },
      color: {
        field: "family",
        type: "nominal",
        scale: {
          domain: Object.keys(FAMILY_COLORS),
          range: Object.values(FAMILY_COLORS),
        },
      },
      tooltip: [
        { field: "model" },
        { field: "correctness", format: ".3f" },
      ],
    },
  };
}

export function temporalSmallMultiplesSpec(report: AggregatedReport): object {
  const temporalModels = MODELS.filter((m) => m.axes.includes("temporal")).sort(
    (a, b) => a.generation - b.generation
  );
  const data: object[] = [];
  for (const t of TASKS) {
    for (const m of temporalModels) {
      const row = report.perModelTask.find(
        (r) => r.modelId === m.id && r.taskId === t.id
      );
      if (!row) continue;
      data.push({
        task: t.displayName,
        model: m.displayName,
        generation: m.generation,
        correctness: row.meanCorrectness,
        stdev: row.stdevCorrectness,
        low: Math.max(0, row.meanCorrectness - row.stdevCorrectness),
        high: Math.min(1, row.meanCorrectness + row.stdevCorrectness),
      });
    }
  }
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { values: data },
    columns: 2,
    facet: { field: "task", type: "nominal", title: null },
    spec: {
      width: 280,
      height: 180,
      layer: [
        {
          mark: { type: "line", point: true },
          encoding: {
            x: {
              field: "generation",
              type: "quantitative",
              title: "Sonnet generation",
              axis: { tickMinStep: 0.5 },
            },
            y: {
              field: "correctness",
              type: "quantitative",
              scale: { domain: [0, 1] },
              title: "Mean correctness",
            },
            tooltip: [
              { field: "model" },
              { field: "correctness", format: ".3f" },
              { field: "stdev", format: ".3f" },
            ],
          },
        },
        {
          mark: { type: "errorbar" },
          encoding: {
            x: { field: "generation", type: "quantitative" },
            y: { field: "low", type: "quantitative" },
            y2: { field: "high" },
          },
        },
      ],
    },
  };
}

export function tierComparisonSpec(report: AggregatedReport): object {
  const tierModels = MODELS.filter((m) => m.axes.includes("tier"));
  const data: object[] = [];
  for (const t of TASKS) {
    for (const m of tierModels) {
      const row = report.perModelTask.find(
        (r) => r.modelId === m.id && r.taskId === t.id
      );
      if (!row) continue;
      data.push({
        task: t.displayName,
        model: m.displayName,
        family: m.family,
        correctness: row.meanCorrectness,
        meanCostUsd: row.meanCostUsd,
      });
    }
  }
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { values: data },
    hconcat: [
      {
        width: 320,
        height: 260,
        mark: "bar",
        encoding: {
          x: { field: "task", type: "nominal", title: null, axis: { labelAngle: -25 } },
          y: {
            field: "correctness",
            type: "quantitative",
            scale: { domain: [0, 1] },
            title: "Mean correctness",
          },
          xOffset: { field: "model", type: "nominal" },
          color: {
            field: "family",
            type: "nominal",
            scale: {
              domain: Object.keys(FAMILY_COLORS),
              range: Object.values(FAMILY_COLORS),
            },
          },
          tooltip: [
            { field: "task" },
            { field: "model" },
            { field: "correctness", format: ".3f" },
          ],
        },
      },
      {
        width: 320,
        height: 260,
        mark: "bar",
        encoding: {
          x: { field: "task", type: "nominal", title: null, axis: { labelAngle: -25 } },
          y: {
            field: "meanCostUsd",
            type: "quantitative",
            title: "Mean cost per case (USD)",
          },
          xOffset: { field: "model", type: "nominal" },
          color: {
            field: "family",
            type: "nominal",
            scale: {
              domain: Object.keys(FAMILY_COLORS),
              range: Object.values(FAMILY_COLORS),
            },
            legend: null,
          },
          tooltip: [
            { field: "task" },
            { field: "model" },
            { field: "meanCostUsd", format: "$.4f" },
          ],
        },
      },
    ],
  };
}

export function costAccuracyScatterSpec(report: AggregatedReport): object {
  const data: object[] = [];
  for (const row of report.perModelTask) {
    const m = MODELS.find((x) => x.id === row.modelId)!;
    const t = TASKS.find((x) => x.id === row.taskId)!;
    data.push({
      model: m.displayName,
      family: m.family,
      task: t.displayName,
      meanCostUsd: Math.max(row.meanCostUsd, 1e-5),
      correctness: row.meanCorrectness,
    });
  }
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    width: 640,
    height: 360,
    data: { values: data },
    mark: { type: "point", filled: true, size: 110, opacity: 0.85 },
    encoding: {
      x: {
        field: "meanCostUsd",
        type: "quantitative",
        scale: { type: "log" },
        title: "Mean cost per case (USD, log scale)",
      },
      y: {
        field: "correctness",
        type: "quantitative",
        scale: { domain: [0, 1] },
        title: "Mean correctness",
      },
      shape: { field: "task", type: "nominal" },
      color: {
        field: "family",
        type: "nominal",
        scale: {
          domain: Object.keys(FAMILY_COLORS),
          range: Object.values(FAMILY_COLORS),
        },
      },
      tooltip: [
        { field: "model" },
        { field: "task" },
        { field: "correctness", format: ".3f" },
        { field: "meanCostUsd", format: "$.5f" },
      ],
    },
  };
}

export function varianceBoxSpec(report: AggregatedReport): object {
  const data: object[] = [];
  for (const row of report.perCase) {
    const m = MODELS.find((x) => x.id === row.modelId)!;
    data.push({
      model: m.displayName,
      family: m.family,
      task: row.taskId,
      correctness: row.meanCorrectness,
    });
  }
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    width: 640,
    height: 320,
    data: { values: data },
    mark: { type: "boxplot", size: 24 },
    encoding: {
      x: { field: "model", type: "nominal", axis: { labelAngle: -20 } },
      y: {
        field: "correctness",
        type: "quantitative",
        scale: { domain: [0, 1] },
      },
      color: {
        field: "family",
        type: "nominal",
        scale: {
          domain: Object.keys(FAMILY_COLORS),
          range: Object.values(FAMILY_COLORS),
        },
      },
      column: { field: "task", type: "nominal", title: null },
    },
  };
}

export function adaptationSpec(report: AggregatedReport): object {
  const data: object[] = [];
  for (const row of report.adaptation) {
    data.push({
      task: row.taskDisplayName,
      model: row.modelDisplayName,
      variant: "baseline",
      correctness: row.baselineMean,
    });
    data.push({
      task: row.taskDisplayName,
      model: row.modelDisplayName,
      variant: "tuned",
      correctness: row.tunedMean,
    });
    for (const e of row.extraVariants) {
      data.push({
        task: row.taskDisplayName,
        model: row.modelDisplayName,
        variant: e.variantId,
        correctness: e.mean,
      });
    }
  }
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { values: data },
    columns: 2,
    facet: { field: "task", type: "nominal", title: null },
    spec: {
      width: 320,
      height: 200,
      mark: "bar",
      encoding: {
        x: { field: "model", type: "nominal", axis: { labelAngle: -25 }, title: null },
        y: {
          field: "correctness",
          type: "quantitative",
          scale: { domain: [0, 1] },
          title: "Mean correctness",
        },
        xOffset: { field: "variant", type: "nominal" },
        color: {
          field: "variant",
          type: "nominal",
          scale: {
            domain: ["baseline", "tuned", "hybrid-rules"],
            range: ["#888", "#5C8DEF", "#2a9d2a"],
          },
        },
        tooltip: [
          { field: "task" },
          { field: "model" },
          { field: "variant" },
          { field: "correctness", format: ".3f" },
        ],
      },
    },
  };
}

export function judgeRubricScatterSpec(report: AggregatedReport): object {
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    width: 480,
    height: 480,
    data: { values: report.judgeRubricPoints },
    layer: [
      {
        mark: { type: "point", filled: true, size: 80, opacity: 0.7 },
        encoding: {
          x: {
            field: "rubric",
            type: "quantitative",
            scale: { domain: [0, 1] },
            title: "Rule rubric score",
          },
          y: {
            field: "judge",
            type: "quantitative",
            scale: { domain: [0, 1] },
            title: "LLM-judge score",
          },
          color: { field: "modelId", type: "nominal" },
          tooltip: [
            { field: "modelId" },
            { field: "caseId" },
            { field: "rubric", format: ".2f" },
            { field: "judge", format: ".2f" },
          ],
        },
      },
      {
        data: { values: [{ a: 0 }, { a: 1 }] },
        mark: { type: "line", strokeDash: [4, 4], color: "#888" },
        encoding: {
          x: { field: "a", type: "quantitative" },
          y: { field: "a", type: "quantitative" },
        },
      },
    ],
  };
}
