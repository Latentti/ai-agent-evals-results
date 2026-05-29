import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Case, Task } from "./types.js";
import { exactMatch, extractTaggedAnswer, numericEqual } from "../scoring/shared.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ReasoningInput {
  question: string;
}

interface ReasoningGold {
  answer: string;
  isNumeric: boolean;
}

const SYSTEM_PROMPT = `You solve word problems and logic puzzles.
Think step by step, then put your final answer inside <answer>...</answer> tags.
Inside the tags, write only the final value (a number, a word, or a short phrase) — no units, no explanation.`;

const TUNED_SYSTEM_PROMPT = `You solve word problems and logic puzzles with care.

PROCESS:

1. Restate the problem in your own words to make sure you understand what is being asked.
2. Identify the type of problem (arithmetic, percentages, rate, logic, sequence, geometry, calendar).
3. Show your step-by-step work explicitly. Write each calculation on its own line so you can audit it.
4. Verify your arithmetic by re-checking each step before stating the final answer.
5. Put ONLY the final value inside <answer>...</answer> tags — no units, no explanation, just the value.

EXAMPLE:

Problem: "A shop sells apples at €1.20 each, with a 25% discount on 5 or more. Anna buys 7. How much does she pay (in euros)?"

Working:
- 7 apples qualifies for the 25% discount.
- Unit price after discount: 1.20 × (1 - 0.25) = 1.20 × 0.75 = 0.90 €/apple.
- Total: 7 × 0.90 = 6.30 €.
- Verify: 7 × 1.20 = 8.40 base; 8.40 × 0.75 = 6.30 ✓.

<answer>6.30</answer>

Now solve the user's problem.`;

const casesPath = resolve(__dirname, "cases/reasoning.cases.json");
const cases = JSON.parse(readFileSync(casesPath, "utf-8")) as Case<
  ReasoningInput,
  ReasoningGold
>[];

export const reasoningTask: Task<ReasoningInput, ReasoningGold> = {
  id: "reasoning",
  displayName: "Reasoning (word problems & logic)",
  systemPrompt: SYSTEM_PROMPT,
  variants: [
    {
      id: "tuned",
      displayName: "Tuned (CoT + verify + few-shot)",
      systemPrompt: TUNED_SYSTEM_PROMPT,
    },
  ],
  cases,
  replicates: 2,
  estimatedOutputTokens: 800,
  buildUserPrompt: (input) => input.question,
  parseOutput: (finalText) => {
    const a = extractTaggedAnswer(finalText);
    if (a === null) return null;
    return { answer: a, isNumeric: false };
  },
  score: (predicted, gold) => {
    const subMetrics: Record<string, number> = {
      answerExtracted: predicted ? 1 : 0,
      arithmeticErrorsDetected: 0,
    };
    if (!predicted) {
      return {
        correctness: 0,
        subMetrics,
        rationale: "no <answer> tag",
      };
    }
    const ok = gold.isNumeric
      ? numericEqual(predicted.answer, gold.answer)
      : exactMatch(predicted.answer, gold.answer);
    return {
      correctness: ok ? 1 : 0,
      subMetrics,
      rationale: ok ? "match" : `expected "${gold.answer}", got "${predicted.answer}"`,
    };
  },
};
