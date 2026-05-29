# AI Agent Model-Difference Evals

A demonstration of how the choice of Claude model affects AI-agent outcomes — and why **evals matter** when frontier models are forcibly refreshed every 12–18 months.

The pipeline runs the **same agent** (same system prompt, same user prompts, same tools, same scoring) against five Claude models across four task types, then produces a single self-contained HTML report with tables, Vega-Lite charts, and a side-by-side gallery of the cases where models most disagreed.

## 📊 Latest report

**👉 [View the latest report in your browser](https://latentti.github.io/ai-agent-evals-results/)**

GitHub renders `.html` files as source code from raw paths, so the report needs to be served. The recommended path is GitHub Pages — one-time setup in the repo settings, then the URL above stays live for every future push:

> **Enable GitHub Pages**: repo → **Settings** → **Pages** → **Source: Deploy from a branch** → **Branch: `main`** → **Folder: `/docs`** → **Save**. After ~30 s the report is live at `https://latentti.github.io/ai-agent-evals-results/`.

Alternative view options if Pages is not enabled:

- **Clone and open locally:**
  ```bash
  git clone https://github.com/Latentti/ai-agent-evals-results.git
  open ai-agent-evals-results/docs/index.html
  ```
- **Quick render via a third-party proxy** (slower, no caching):
  [`htmlpreview.github.io`](https://htmlpreview.github.io/?https://github.com/Latentti/ai-agent-evals-results/blob/main/docs/index.html)
  · [`raw.githack.com`](https://raw.githack.com/Latentti/ai-agent-evals-results/main/docs/index.html)

The raw aggregate data is at [`docs/aggregate.json`](./docs/aggregate.json) if you want to slice it differently.

## TL;DR — headline findings from the latest run

| Model | Mean correctness | All-variant cost | Judge tax |
|---|---:|---:|---:|
| Opus 4.7 | **0.938** | $8.55 | $0.92 |
| Sonnet 4.6 | **0.915** | $1.57 | $0.90 |
| Sonnet 4.5 | 0.888 | $1.43 | $0.89 |
| Sonnet 4 | 0.876 | $1.36 | $0.89 |
| Haiku 4.5 | 0.847 | $0.46 | $0.86 |

Non-trivial empirical findings the report walks you through:

- **Sonnet 4 → 4.5 silently regressed on tool-use** (0.91 → 0.87). Recovered at 4.6. A naive "minor model bump" rollout would have shipped a 4 pp drop blind.
- **Sonnet 3.x and the original Opus 4.7 calls failed under the same agent code.** Two distinct API-contract drifts: 404 (model deprecated for our account) and `temperature is deprecated for this model` (parameter silently rejected under unchanged SDK + model ID).
- **Hybrid-rules classification (extract intent → LLM only for the reply) matches Opus-tier quality at Sonnet pricing.** Direct evidence for the "don't try to buy determinism from an LLM" architectural argument.
- **Two-judge agreement was 0.97** between Sonnet 4.6 (primary) and Opus 4.7 (sampled second judge). The judge bias risk is real but bounded in this evaluation.
- **The same temperature-deprecation contract change we warn about in the governance section bit our own judge code.** Self-inflicted, fixed; documented in the report.

## Two comparison axes

| Axis | Models | What it shows |
|------|--------|---------------|
| **Temporal** (Sonnet line) | Sonnet 4 → 4.5 → 4.6 | How a tier evolved across one upgrade cycle. |
| **Tier** (current generation) | Haiku 4.5 vs Sonnet 4.6 vs Opus 4.7 | How the three current tiers compare at the same generation. |

Sonnet 4.6 sits on both axes — five models total.

## Four task types

| Task | What it tests | Scoring |
|------|---------------|---------|
| **Tool use** (travel agent) | Multi-step tool calls, refusal behaviour, schema validity | Required tools called + forbidden tools avoided + answer correctness + Ajv-validated args |
| **Structured extraction** (invoices) | Strict-JSON output, schema compliance, multilingual robustness | Field-level F1 across required fields |
| **Reasoning** (word problems / logic) | Multi-step math, deductive reasoning, format compliance | Exact match on `<answer>`-tagged final answer |
| **Classification + reply** (customer support) | Intent classification + reply quality | Intent match + LLM judge (Sonnet 4.6) + 20% Opus 4.7 second-judge sample + deterministic rule rubric |

Each task also exposes a **tuned** prompt variant (multi-step instructions + few-shot example) so you can see whether prompt engineering recovers regressions or just shifts the failure mode. Classification additionally exposes a **hybrid-rules** variant that extracts intent classification out of the LLM entirely.

## Reproduce

```bash
# 1. install
npm install

# 2. set API key
cp .env.example .env
# edit .env, paste your ANTHROPIC_API_KEY

# 3. preview cost (no API calls)
npm run estimate

# 4. probe model availability against your account
#    (catches the "404 not found" governance scenario before you spend any budget)
npm run probe-models

# 5. run the full sweep (~$20, interactive [y/N] gate before any API spend)
npm run sweep

# 6. open the report
open results/runs/<timestamp>/report.html
```

### Useful flags

```bash
# non-interactive (skip [y/N] gate)
npm run sweep -- --yes

# only run a subset of models
npm run sweep -- --models claude-haiku-4-5-20251001,claude-sonnet-4-6

# only run a subset of tasks
npm run sweep -- --tasks reasoning,classification

# only run a subset of prompt variants
npm run sweep -- --variants baseline,tuned

# resume an interrupted sweep (skips successful tuples; retries errored ones)
npm run sweep -- --resume results/runs/<timestamp>

# regenerate the HTML report from an existing run dir
npm run report -- results/runs/<timestamp>
```

## Budget guard

The pre-flight cost estimate prints a per-(model × task × variant) breakdown. Two thresholds apply:

- `WARN_USD` (default **$10**) — prints a yellow warning before the gate.
- `MAX_USD_BUDGET` (default **$25**) — hard abort, the sweep does not start.

Both are read from `.env`.

## Methodological choices

These are intentional, documented in the report's §11, and stated up front:

1. **Pure-prompt policy for the baseline variant.** The system + user prompts are identical across all models for `baseline`. Tuned variants are a separate experiment, also identical across models. No per-model prompt tuning.
2. **Temperature = 0** for every model that still accepts it. Capability flag `supportsTemperature` on the model registry handles the models (like Opus 4.7) that have deprecated the parameter.
3. **Prompt caching disabled.** Keeps cost / latency comparisons clean across models with different cache behaviour. Document this is a ~30-60% cost premium vs. realistic production caching.
4. **Classification has three scorers, run in parallel.** A deterministic rule rubric, an LLM judge (Sonnet 4.6 blind), and a 20% Opus-4.7 second-judge sample for judge-bias visibility. The report shows their agreement as its own chart.
5. **Tool-call schema validity is Ajv-validated** before invoking the mock handler, so `schemaValidArgs` measures what its name claims.
6. **Sample stdev** (N − 1) is used throughout. At N = 2 (extraction, reasoning) it collapses to a single-pair noise figure; the report flags this.
7. **Refusal detection is EN + FI only.** Cross-locale sweeps will under-report refusals on other languages; the report flags this.

## Project layout

```
src/
  config/         models registry, pricing, run config
  tasks/          4 task modules + prompt variants + JSON cases + mock tools
  agent/          agent loop + Anthropic SDK wrapper + Ajv schema validator
  scoring/        shared scorers, rule rubric, primary + sampled second LLM judge
  runner/         sweep, budget guard, JSONL persist (single-writer queue)
  report/         aggregate → standalone HTML + Vega-Lite charts
  cli/            estimate / sweep / report / probe-models entry points
tests/            Vitest unit tests
docs/             published copy of the latest report
results/runs/     each local run gets a timestamped subdir (gitignored)
```

## License

This is a teaching artefact. Fork, extend, and adapt the cases to your own domain. The cases under `src/tasks/cases/` are synthetic and contain no production data.

## See also

- The report itself is the primary artefact — start with [`docs/index.html`](./docs/index.html).
- The plan / change log lives in `.claude/plans/` locally; the published copy of the report's methodology section (§11) is the canonical caveat list.
