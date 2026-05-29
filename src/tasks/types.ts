import type Anthropic from "@anthropic-ai/sdk";

export interface Score {
  correctness: number;
  subMetrics: Record<string, number>;
  rationale?: string;
  /**
   * Extra API cost incurred by the scorer itself (e.g. LLM judge calls).
   * Surfaced separately in the exec summary so the headline "total cost" is
   * not silently undersized by the judge tax.
   */
  auxCostUsd?: number;
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  output: unknown;
  /** Handler returned an error (or threw). Not the same as schema validity. */
  isError: boolean;
  /** Args validated against the tool's input_schema before invocation. */
  schemaValid?: boolean;
  /** Ajv error string when schemaValid is false. */
  schemaErrors?: string;
  latencyMs: number;
}

export interface RunResult {
  modelId: string;
  finalText: string;
  toolCalls: ToolCallRecord[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  refused: boolean;
  error?: string;
}

export interface RunTrace {
  result: RunResult;
  caseInput: unknown;
  /** Case identifier — used by scorers needing a stable per-case key (e.g.
   * the LLM judge for deterministic second-judge sampling). */
  caseId: string;
}

export interface Case<TInput, TOutput> {
  id: string;
  difficulty: "easy" | "medium" | "hard" | "edge";
  locale: "en" | "fi";
  input: TInput;
  gold: TOutput;
  notes?: string;
}

/**
 * A prompt variant lets us test alternative system prompts (and optionally
 * different tools/handlers) on the same task and case set. The baseline variant
 * with id "baseline" is implied if `variants` is not provided.
 */
export interface PromptVariant {
  id: string;
  displayName: string;
  systemPrompt: string;
  tools?: import("@anthropic-ai/sdk").default.Tool[];
  toolHandlers?: Record<string, (input: unknown) => Promise<unknown> | unknown>;
  /**
   * Optional pre-LLM hook: if defined, run before the LLM call. Can short-circuit
   * the LLM (used by the classification hybrid variant to deterministically
   * compute the intent from rules before invoking the LLM to draft the reply).
   */
  precompute?: (caseInput: unknown) => Record<string, unknown>;
  /**
   * Optional user-prompt builder override for this variant. If omitted, the
   * task's default buildUserPrompt is used.
   */
  buildUserPrompt?: (input: unknown, precomputed?: Record<string, unknown>) => string;
}

export interface Task<TInput = unknown, TOutput = unknown> {
  id: string;
  displayName: string;
  systemPrompt: string;
  tools?: Anthropic.Tool[];
  toolHandlers?: Record<string, (input: unknown) => Promise<unknown> | unknown>;
  /**
   * Optional list of additional prompt variants. The baseline (using the
   * task's own `systemPrompt`, `tools`, `toolHandlers`, `buildUserPrompt`) is
   * always run as variant id "baseline".
   */
  variants?: PromptVariant[];
  cases: Case<TInput, TOutput>[];
  buildUserPrompt: (input: TInput) => string;
  parseOutput: (
    finalText: string,
    toolCalls: ToolCallRecord[],
    precomputed?: Record<string, unknown>
  ) => TOutput | null;
  score: (
    predicted: TOutput | null,
    gold: TOutput,
    trace: RunTrace
  ) => Score | Promise<Score>;
  replicates: number;
  estimatedOutputTokens: number;
}

export interface ScoredRun {
  taskId: string;
  caseId: string;
  variantId: string;
  replicateIdx: number;
  modelId: string;
  result: RunResult;
  score: Score;
  timestampMs: number;
}
