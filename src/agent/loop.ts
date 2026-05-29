import type Anthropic from "@anthropic-ai/sdk";
import Ajv, { type ValidateFunction } from "ajv";
import { modelById } from "../config/models.js";
import { computeCostUsd } from "../config/pricing.js";
import { RUN_CONFIG } from "../config/runConfig.js";
import type { RunResult, ToolCallRecord } from "../tasks/types.js";
import { createMessageWithRetry } from "./anthropicClient.js";

// ajv exports an ESM/CJS interop where the runtime default is the constructor
// but the type points to a namespace. Coerce to the constructor.
const AjvCtor = (Ajv as unknown as { default?: typeof Ajv }).default ?? Ajv;
const ajv = new (AjvCtor as unknown as new (opts?: object) => {
  compile<T = unknown>(schema: object): ValidateFunction<T>;
  errorsText(errs: unknown, opts?: object): string;
})({ allErrors: true, strict: false });

const schemaValidatorCache = new WeakMap<object, ValidateFunction>();

function validateToolArgs(
  tool: Anthropic.Tool,
  args: unknown
): { ok: boolean; errors: string } {
  const schema = (tool as { input_schema?: object }).input_schema;
  if (!schema) return { ok: true, errors: "" };
  let validator = schemaValidatorCache.get(schema);
  if (!validator) {
    try {
      validator = ajv.compile(schema);
    } catch {
      return { ok: true, errors: "" };
    }
    schemaValidatorCache.set(schema, validator);
  }
  const ok = validator(args);
  if (ok) return { ok: true, errors: "" };
  return {
    ok: false,
    errors: ajv.errorsText(validator.errors, { separator: "; " }),
  };
}

/**
 * Refusal patterns. Anchored to refusal idioms; specifically *avoids* matching
 * "I'm sorry, I can't find X" / "I can't see Y in our system" which are just
 * tool-result narration, not refusals.
 *
 * Refusal heuristic, EN + FI only. Document this limitation in any cross-locale
 * sweep — see methodology §11.
 */
const REFUSAL_REGEXES = [
  /\bI can'?t (help|assist with that|do that|comply|provide that)\b/i,
  /\bI'?m (not able|unable) to (help|assist|provide|comply|do that)\b/i,
  /\bI (cannot|can'?t) (help|assist|comply|engage) with (this|that)\b/i,
  /\bI must (decline|refuse)\b/i,
  /\b(en voi auttaa|en pysty auttamaan|valitettavasti en voi|kielt[äa]ydyn)\b/i,
];

function isRefusalText(text: string): boolean {
  if (!text.trim()) return false;
  return REFUSAL_REGEXES.some((rx) => rx.test(text));
}

export interface RunAgentArgs {
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  tools?: Anthropic.Tool[];
  toolHandlers?: Record<string, (input: unknown) => Promise<unknown> | unknown>;
  maxTurns?: number;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Extra fields on each ToolCallRecord that surface argument-schema validity.
 * Kept on the structured record so scoring can distinguish:
 *   - mock returned an error (handler threw)             → toolErrorRate
 *   - the model sent args that don't match input_schema  → schemaValidArgs
 */

export async function runAgent(args: RunAgentArgs): Promise<RunResult> {
  const maxTurns = args.maxTurns ?? RUN_CONFIG.maxTurns;
  const temperature = args.temperature ?? RUN_CONFIG.temperature;
  const maxTokens = args.maxTokens ?? RUN_CONFIG.maxTokens;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: args.userPrompt },
  ];

  const toolCalls: ToolCallRecord[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  let finalText = "";
  /**
   * Refusal observed on ANY turn (not only the final one). Overwriting only the
   * latest turn's text would miss the case where the model refuses on turn 1
   * then later produces unrelated text.
   */
  let refusedAnyTurn = false;
  const startedAt = Date.now();

  const modelEntry = modelById(args.modelId);
  const supportsTemperature = modelEntry?.supportsTemperature ?? true;

  try {
    while (turns < maxTurns) {
      turns++;
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: args.modelId,
        system: args.systemPrompt,
        messages,
        max_tokens: maxTokens,
        ...(supportsTemperature ? { temperature } : {}),
        ...(args.tools ? { tools: args.tools } : {}),
      };

      const resp = await createMessageWithRetry(params, {
        timeoutMs: RUN_CONFIG.perCallTimeoutMs,
      });

      inputTokens += resp.usage.input_tokens;
      outputTokens += resp.usage.output_tokens;

      const assistantBlocks = resp.content;
      messages.push({ role: "assistant", content: assistantBlocks });

      // Extract text from this turn
      const textBlocks = assistantBlocks.filter(
        (b): b is Anthropic.TextBlock => b.type === "text"
      );
      if (textBlocks.length > 0) {
        const turnText = textBlocks.map((b) => b.text).join("\n");
        finalText = turnText;
        if (isRefusalText(turnText)) refusedAnyTurn = true;
      }

      if (resp.stop_reason === "tool_use" && args.toolHandlers) {
        const toolUseBlocks = assistantBlocks.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
        );

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of toolUseBlocks) {
          const handler = args.toolHandlers[block.name];
          const toolDef = args.tools?.find((t) => t.name === block.name);
          const schemaCheck = toolDef
            ? validateToolArgs(toolDef, block.input)
            : { ok: true, errors: "" };
          const tStart = Date.now();
          let output: unknown;
          let isError = false;
          if (!handler) {
            output = `Unknown tool: ${block.name}`;
            isError = true;
          } else {
            try {
              output = await handler(block.input);
            } catch (err) {
              output = (err as Error).message;
              isError = true;
            }
          }
          const latencyMs = Date.now() - tStart;
          toolCalls.push({
            name: block.name,
            input: block.input,
            output,
            isError,
            latencyMs,
            schemaValid: schemaCheck.ok,
            schemaErrors: schemaCheck.errors || undefined,
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content:
              typeof output === "string" ? output : JSON.stringify(output),
            is_error: isError,
          });
        }
        messages.push({ role: "user", content: toolResults });
        continue;
      }

      // stop_reason: end_turn | max_tokens | stop_sequence | tool_use-but-no-handler
      break;
    }

    const latencyMs = Date.now() - startedAt;
    const costUsd = computeCostUsd(args.modelId, inputTokens, outputTokens);

    return {
      modelId: args.modelId,
      finalText,
      toolCalls,
      turns,
      inputTokens,
      outputTokens,
      latencyMs,
      costUsd,
      refused: refusedAnyTurn,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    return {
      modelId: args.modelId,
      finalText,
      toolCalls,
      turns,
      inputTokens,
      outputTokens,
      latencyMs,
      costUsd: computeCostUsd(args.modelId, inputTokens, outputTokens),
      refused: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
