import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Case, Task, ToolCallRecord } from "./types.js";
import { TRAVEL_TOOLS, TRAVEL_TOOL_HANDLERS } from "./tools/mockTools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ToolUseInput {
  prompt: string;
}

interface ToolUseGold {
  requiredTools: string[];
  forbiddenTools?: string[];
  expectedAnswerSubstrings?: string[];
  shouldAskForClarification?: boolean;
  shouldRefuse?: boolean;
}

interface ToolUseParsed {
  finalText: string;
  toolsUsed: string[];
  toolCalls: ToolCallRecord[];
}

const SYSTEM_PROMPT = `You are a helpful travel-planning assistant.
You have access to tools that let you search for flights, search for hotels, get weather, and book flights.

Rules:
- Use the tools whenever you need real information; do not invent flight numbers, prices, or weather.
- Only call bookFlight after the user has explicitly confirmed the choice. If the user has not confirmed, suggest options first.
- If a request is missing critical details (origin, destination, dates), ask one clarifying question before calling any tool.
- When you give the final answer to the user, summarise concisely.`;

const TUNED_SYSTEM_PROMPT = `You are a helpful travel-planning assistant with access to flight search, hotel search, weather, and flight booking tools.

PROCESS (follow strictly in every interaction):

1. Parse the user's request and list every sub-task it contains. A request like "find a flight and suggest a hotel and check the weather" contains THREE sub-tasks; you must complete ALL of them before giving the final answer.
2. For each sub-task, call the appropriate tool. Do not stop after the first tool call when the request contains multiple sub-tasks.
3. If critical information is missing (no origin / destination / date), do NOT call any tool. Ask exactly one clarifying question and wait.
4. Only call bookFlight after the user has EXPLICITLY confirmed a specific flight. If they have not confirmed, suggest options instead.
5. Once every requested sub-task is resolved, write a concise summary that addresses each sub-task in turn.

EXAMPLE (multi-part request):

User: "Plan me a weekend in Stockholm: flight HEL to ARN on 2026-06-12, a hotel in the Old Town, and what should I pack?"
Correct sequence:
  1. searchFlights({origin:"HEL", destination:"ARN", date:"2026-06-12"})
  2. searchHotels({city:"Stockholm", checkIn:"2026-06-12", checkOut:"2026-06-14"})
  3. getWeather({city:"Stockholm"})
  4. Then write a single summary covering all three.

WRONG: calling only searchFlights and then summarising — that drops two sub-tasks.

EXAMPLE (missing detail):

User: "Book me a flight."
Correct: ask "Where would you like to fly from and to, and on what date?" — do NOT call any tool yet.

Begin.`;

function parseOutput(
  finalText: string,
  toolCalls: ToolCallRecord[]
): ToolUseParsed {
  return {
    finalText,
    toolsUsed: toolCalls.map((c) => c.name),
    toolCalls,
  };
}

const casesPath = resolve(__dirname, "cases/toolUse.cases.json");
const cases = JSON.parse(readFileSync(casesPath, "utf-8")) as Case<
  ToolUseInput,
  ToolUseGold
>[];

export const toolUseTask: Task<ToolUseInput, ToolUseGold> = {
  id: "tool-use",
  displayName: "Tool use (travel agent)",
  systemPrompt: SYSTEM_PROMPT,
  tools: TRAVEL_TOOLS,
  toolHandlers: TRAVEL_TOOL_HANDLERS,
  variants: [
    {
      id: "tuned",
      displayName: "Tuned (multi-step + few-shot)",
      systemPrompt: TUNED_SYSTEM_PROMPT,
      tools: TRAVEL_TOOLS,
      toolHandlers: TRAVEL_TOOL_HANDLERS,
    },
  ],
  cases,
  replicates: 3,
  estimatedOutputTokens: 1200,
  buildUserPrompt: (input) => input.prompt,
  parseOutput: (finalText, toolCalls) => parseOutput(finalText, toolCalls) as unknown as ToolUseGold,
  score: (predicted, gold, _trace) => {
    const p = predicted as unknown as ToolUseParsed | null;
    const subMetrics: Record<string, number> = {
      toolCallCount: p ? p.toolCalls.length : 0,
      unnecessaryCalls: 0,
      // toolErrorRate = fraction of tool invocations whose handler returned an
      // error (or threw). Replaces the previously misnamed `argValidityRate`,
      // which conflated handler errors with schema validity.
      toolErrorRate: 0,
      // schemaValidArgs = fraction of tool invocations whose args validated
      // against the tool's input_schema. Set by the Ajv pre-check in agent loop.
      schemaValidArgs: 1,
      taskCompleted: 0,
    };

    if (!p) {
      return {
        correctness: 0,
        subMetrics,
        rationale: "no output parsed",
      };
    }

    if (gold.shouldRefuse) {
      const refused = !p.finalText || /can'?t|unable|won'?t|en voi/i.test(p.finalText);
      const noBooking = !p.toolsUsed.includes("bookFlight");
      const correctness = refused && noBooking ? 1 : 0;
      subMetrics.taskCompleted = correctness;
      return {
        correctness,
        subMetrics,
        rationale: correctness ? "correctly refused" : "should have refused/declined",
      };
    }

    if (gold.shouldAskForClarification) {
      const askedQ = /\?/.test(p.finalText);
      const noToolCalls = p.toolsUsed.length === 0;
      const correctness = askedQ && noToolCalls ? 1 : askedQ ? 0.5 : 0;
      subMetrics.taskCompleted = correctness;
      return {
        correctness,
        subMetrics,
        rationale:
          correctness === 1
            ? "asked clarifying question and did not call tools"
            : correctness === 0.5
            ? "asked question but also called tools"
            : "failed to ask for clarification",
      };
    }

    // Standard tool-use scoring
    const usedSet = new Set(p.toolsUsed);
    const allRequiredCalled = gold.requiredTools.every((t) => usedSet.has(t));
    const requiredSubset = gold.requiredTools.filter((t) => usedSet.has(t));
    const requiredCoverage =
      gold.requiredTools.length === 0
        ? 1
        : requiredSubset.length / gold.requiredTools.length;

    const forbidden = gold.forbiddenTools ?? [];
    const forbiddenCalled = forbidden.filter((t) => usedSet.has(t));
    const noForbidden = forbiddenCalled.length === 0;
    subMetrics.unnecessaryCalls = forbiddenCalled.length;

    // Two separate metrics:
    //   toolErrorRate    — handler returned an error
    //   schemaValidArgs  — args passed Ajv check against tool.input_schema
    const toolErrors = p.toolCalls.filter((c) => c.isError).length;
    const toolErrorRate =
      p.toolCalls.length === 0 ? 0 : toolErrors / p.toolCalls.length;
    subMetrics.toolErrorRate = toolErrorRate;

    const schemaInvalid = p.toolCalls.filter(
      (c) => c.schemaValid === false
    ).length;
    const schemaValidArgs =
      p.toolCalls.length === 0
        ? 1
        : 1 - schemaInvalid / p.toolCalls.length;
    subMetrics.schemaValidArgs = schemaValidArgs;

    // Final answer substring matching
    const expectedSubs = gold.expectedAnswerSubstrings ?? [];
    const matched = expectedSubs.filter((s) =>
      p.finalText.toLowerCase().includes(s.toLowerCase())
    );
    const answerScore =
      expectedSubs.length === 0
        ? allRequiredCalled
          ? 1
          : 0
        : matched.length / expectedSubs.length;

    const orderScore = noForbidden ? requiredCoverage : requiredCoverage * 0.5;

    // Weight schema validity (not just handler errors) into correctness — the
    // "did the model send well-formed args" signal is the more meaningful
    // measurement of tool-use competence.
    const correctness =
      0.6 * answerScore + 0.3 * orderScore + 0.1 * schemaValidArgs;
    subMetrics.taskCompleted = answerScore >= 0.5 ? 1 : 0;

    return {
      correctness: Math.max(0, Math.min(1, correctness)),
      subMetrics,
      rationale: `required=${requiredSubset.length}/${gold.requiredTools.length}, forbidden=${forbiddenCalled.length}, answerSubs=${matched.length}/${expectedSubs.length}, schemaValid=${schemaValidArgs.toFixed(2)}`,
    };
  },
};
