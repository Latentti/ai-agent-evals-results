import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Case, Task } from "./types.js";
import { tryParseJson } from "../scoring/shared.js";
import { scoreReplyRubric } from "../scoring/ruleRubric.js";
import { judgeReplyDual } from "../scoring/llmJudge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const INTENT_LABELS = [
  "billing_error",
  "refund",
  "complaint",
  "outage",
  "feature_request",
  "how_to",
  "account_access",
  "other",
] as const;

interface ClassificationInput {
  message: string;
}

interface ClassificationGold {
  intent: (typeof INTENT_LABELS)[number];
  intentKeywords: string[];
}

interface ClassificationOutput {
  intent: string;
  reply: string;
  raw: string;
}

const SYSTEM_PROMPT = `You are a customer-support assistant.
For each incoming customer message you must:

1. Classify the intent as exactly ONE of: billing_error, refund, complaint, outage, feature_request, how_to, account_access, other
2. Draft a concise, polite reply (60–200 words) that addresses the customer's need.

Output STRICT JSON only, with this exact schema:

{"intent": "<one of the labels above>", "reply": "<your reply to the customer>"}

Do not add any prose outside the JSON. Do not invent facts (account numbers, refunds amounts, ETAs). If you do not have information, say so politely in the reply.`;

const TUNED_SYSTEM_PROMPT = `You are a customer-support assistant. For each incoming message:

1) Classify the intent — EXACTLY ONE label from: billing_error, refund, complaint, outage, feature_request, how_to, account_access, other.
2) Draft a concise, polite reply (60–200 words) that directly addresses the customer's need.

INTENT GUIDELINES:
- billing_error — wrong amount charged, double charges, billing discrepancy. Includes Finnish "lasku virheellinen", "veloitettu".
- refund — customer wants money back, subscription cancellation refund.
- complaint — frustration, the product caused problems (crashes, lost work), strong negative emotion.
- outage — service is currently down or unreachable.
- feature_request — asking for a new feature or capability.
- how_to — asking how to do something (procedural question).
- account_access — login problems, password reset issues, locked accounts.
- other — anything else (compliments, general feedback, unclear).

REPLY GUIDELINES:
- Open with a brief greeting / acknowledgement.
- For complaints / refunds / outages / billing_error: include an apology.
- Mention the customer's specific concern (use their words).
- Do NOT invent facts (no fake account numbers, no fake refund amounts, no specific ETAs you do not have).
- Close politely with a sign-off.

OUTPUT FORMAT — STRICT JSON, no prose, no markdown fences:
{"intent": "<label>", "reply": "<reply text>"}

EXAMPLE INPUT:
"I was charged €49 this month but my plan is €29."

EXAMPLE OUTPUT:
{"intent":"billing_error","reply":"Hi, thanks for flagging this. I'm sorry about the incorrect charge — your plan should indeed be €29, not €49. I'll get a teammate to review your invoice and reach out within one business day with a correction. If you have an order or invoice ID handy, share it in a reply and we'll match it faster. Sorry again for the trouble. Best, Support."}

Now respond to the user's message.`;

const HYBRID_SYSTEM_PROMPT = `You are a customer-support assistant. The intent has already been determined by a separate rules engine — you do NOT need to classify it. Your only job is to draft a polite, concise reply (60–200 words) appropriate for the given intent.

REPLY GUIDELINES:
- Open with a brief greeting / acknowledgement.
- For complaints / refunds / outages / billing_error: include an apology.
- Acknowledge the customer's specific concern (use their words where possible).
- Do NOT invent facts (no fake account numbers, no fake refund amounts, no specific ETAs you do not have).
- Close politely with a sign-off.

OUTPUT FORMAT — STRICT JSON, no prose, no markdown fences:
{"reply": "<reply text>"}

The user message below includes the intent label provided by the rules engine.`;

const casesPath = resolve(__dirname, "cases/classification.cases.json");
const cases = JSON.parse(readFileSync(casesPath, "utf-8")) as Case<
  ClassificationInput,
  ClassificationGold
>[];

/**
 * Generic keyword-based intent classifier. Independent of any case's specific
 * intentKeywords — patterns are written as a real production rules engine
 * would. Used by the "hybrid-rules" variant to extract the deterministic
 * decision (intent) out of the LLM.
 *
 * ORDERING IS PRIORITY (first match wins). This is deliberate, not accidental.
 * Rationale for the chosen order:
 *
 *   1. outage         — overrides everything; a customer who cannot reach the
 *                       service is not asking how-to or making a feature request
 *   2. account_access — "can't log in to cancel" should route to access support,
 *                       not refund queue; access blocks downstream actions
 *   3. billing_error  — concrete error patterns (charged twice, wrong amount)
 *                       win over generic "refund" mentions
 *   4. refund         — refund language; loses to billing_error and access
 *   5. feature_request — explicit "please add / would love" phrasing
 *   6. complaint      — emotional/negative language without a specific class above
 *   7. how_to         — procedural; lowest specificity, near-fallback
 *   8. (default)      — "other"
 *
 * A production system would replace first-match-wins with score-and-pick-max
 * across rules. For this teaching artefact the priority semantics are explicit.
 */
const INTENT_RULES: Array<{
  intent: (typeof INTENT_LABELS)[number];
  patterns: RegExp[];
}> = [
  {
    intent: "outage",
    patterns: [
      /\bservice (is )?down\b/i,
      /\bnot (working|reachable|available|loading)\b/i,
      /\bcan'?t (access|reach|connect)\b/i,
      /\b(palvelu (ei toimi|alhaalla)|katkos)\b/i,
    ],
  },
  {
    intent: "account_access",
    patterns: [
      /\bcan'?t log ?in\b/i,
      /\bpassword reset\b/i,
      /\blocked out\b/i,
      /\b(salasana|kirjautu)/i,
    ],
  },
  {
    intent: "billing_error",
    patterns: [
      /\bcharged twice\b/i,
      /\b(wrong|incorrect) (amount|charge|bill)/i,
      /\bdouble[- ]?charged?\b/i,
      /\b(lasku.*virhe|virheellinen.*lasku|veloitettu)\b/i,
    ],
  },
  {
    intent: "refund",
    patterns: [
      /\brefund\b/i,
      /\bmoney back\b/i,
      /\bpalautus\b/i,
      /\bbought.*by mistake\b/i,
      /\bcancel.*(subscription|order)\b/i,
    ],
  },
  {
    intent: "feature_request",
    patterns: [
      /\bwould love to see\b/i,
      /\bplease add\b/i,
      /\bfeature request\b/i,
      /\bany plans for\b/i,
      /\bcould you (add|implement)\b/i,
    ],
  },
  {
    intent: "complaint",
    patterns: [
      /\b(crashing|crashed|crash)\b/i,
      /\bunacceptable\b/i,
      /\b(angry|frustrat|losing patience|losing work)\b/i,
    ],
  },
  {
    intent: "how_to",
    patterns: [
      /\bhow do I\b/i,
      /\bhow can I\b/i,
      /\bhow to\b/i,
      /\bwhere (is|do I)\b/i,
      /\bmiten\b/i,
    ],
  },
];

function classifyByRules(message: string): (typeof INTENT_LABELS)[number] {
  for (const rule of INTENT_RULES) {
    if (rule.patterns.some((p) => p.test(message))) return rule.intent;
  }
  return "other";
}

export const classificationTask: Task<ClassificationInput, ClassificationGold> = {
  id: "classification",
  displayName: "Classification + reply (support)",
  systemPrompt: SYSTEM_PROMPT,
  variants: [
    {
      id: "tuned",
      displayName: "Tuned (stricter prompt + few-shot)",
      systemPrompt: TUNED_SYSTEM_PROMPT,
    },
    {
      id: "hybrid-rules",
      displayName: "Hybrid (rules-based intent + LLM reply)",
      systemPrompt: HYBRID_SYSTEM_PROMPT,
      precompute: (caseInput) => {
        const input = caseInput as ClassificationInput;
        return { intent: classifyByRules(input.message) };
      },
      buildUserPrompt: (input, precomputed) => {
        const i = input as ClassificationInput;
        const intent = (precomputed?.intent as string | undefined) ?? "other";
        return `Customer message:
"""
${i.message}
"""

Intent (already determined by rules engine): ${intent}

Draft a reply addressing this customer's need. Output only the JSON {"reply":"..."}.`;
      },
    },
  ],
  cases,
  replicates: 3,
  estimatedOutputTokens: 300,
  buildUserPrompt: (input) => input.message,
  parseOutput: (finalText, _toolCalls, precomputed) => {
    const parsed = tryParseJson(finalText) as
      | { intent?: string; reply?: string }
      | null;
    // If the variant pre-computed the intent (hybrid path), use that and
    // expect only `reply` from the LLM.
    if (precomputed?.intent) {
      return {
        intent: String(precomputed.intent),
        reply: String(parsed?.reply ?? "").trim(),
        raw: finalText,
      } as unknown as ClassificationGold;
    }
    if (!parsed) {
      return {
        intent: "",
        reply: "",
        raw: finalText,
      } as unknown as ClassificationGold;
    }
    return {
      intent: String(parsed.intent ?? "").trim(),
      reply: String(parsed.reply ?? "").trim(),
      raw: finalText,
    } as unknown as ClassificationGold;
  },
  score: async (predicted, gold, trace) => {
    const p = predicted as unknown as ClassificationOutput | null;
    const subMetrics: Record<string, number> = {
      intentCorrect: 0,
      judgeScore: 0,
      rubricScore: 0,
      judgeRubricAgreement: 0,
      replyLengthChars: 0,
      schemaValid: 0,
    };
    if (!p || !p.intent) {
      return { correctness: 0, subMetrics, rationale: "no valid JSON parsed" };
    }
    subMetrics.schemaValid = 1;
    subMetrics.replyLengthChars = (p.reply ?? "").length;

    const intentCorrect = p.intent === gold.intent ? 1 : 0;
    subMetrics.intentCorrect = intentCorrect;

    // Rule rubric
    const rubric = scoreReplyRubric({
      reply: p.reply ?? "",
      intent: gold.intent,
      intentKeywords: gold.intentKeywords,
    });
    subMetrics.rubricScore = rubric.score;

    // LLM judge — primary (Sonnet 4.6) + sampled second judge (Opus 4.7)
    let judgeScore = 0;
    let auxCostUsd = 0;
    let secondJudgeScore: number | undefined;
    let judgeAgreement: number | undefined;
    const customerMessage =
      (trace.caseInput as ClassificationInput | undefined)?.message ?? "";
    try {
      const dual = await judgeReplyDual({
        caseId: trace.caseId,
        customerMessage,
        intent: gold.intent,
        reply: p.reply ?? "",
      });
      judgeScore = dual.primary.score;
      auxCostUsd = dual.totalCostUsd;
      secondJudgeScore = dual.secondary?.score;
      judgeAgreement = dual.agreement;
    } catch {
      judgeScore = 0;
    }
    subMetrics.judgeScore = judgeScore;
    subMetrics.judgeRubricAgreement = 1 - Math.abs(judgeScore - rubric.score);
    if (secondJudgeScore !== undefined) {
      subMetrics.secondJudgeScore = secondJudgeScore;
    }
    if (judgeAgreement !== undefined) {
      subMetrics.judgeJudgeAgreement = judgeAgreement;
    }

    const correctness =
      0.5 * intentCorrect + 0.25 * judgeScore + 0.25 * rubric.score;

    return {
      correctness,
      subMetrics,
      rationale: `intent=${intentCorrect}, judge=${judgeScore.toFixed(2)}, rubric=${rubric.score.toFixed(2)}`,
      auxCostUsd,
    };
  },
};
