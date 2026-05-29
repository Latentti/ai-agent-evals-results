import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { createMessageWithRetry } from "../agent/anthropicClient.js";
import { modelById } from "../config/models.js";
import { computeCostUsd } from "../config/pricing.js";
import { RUN_CONFIG } from "../config/runConfig.js";
import { tryParseJson } from "./shared.js";

export interface DualJudgeResult {
  primary: JudgeResult;
  /** Set when the second judge was sampled for this case. */
  secondary?: JudgeResult;
  /** 1 - |primary - secondary| when both are present; otherwise undefined. */
  agreement?: number;
  /** Combined cost (primary + secondary). */
  totalCostUsd: number;
}

export interface JudgeResult {
  score: number;
  rationale: string;
  subScores: { addressesIntent: number; tone: number; factuality: number; length: number };
  costUsd: number;
}

const JUDGE_SYSTEM = `You are an impartial evaluator of customer-service reply quality.
You will receive a customer message, the intent label, and a candidate reply.
Score the reply on FOUR axes, each 0..1 (1 = excellent):

1. addressesIntent: does the reply actually address the customer's stated need?
2. tone: is the tone polite, professional, empathetic where appropriate?
3. factuality: does the reply avoid making up information, false promises, fabricated policies, or hallucinated facts?
4. length: is the reply appropriately concise (not too short, not bloated)?

Output STRICT JSON only, no prose, with this exact schema:
{"addressesIntent": number, "tone": number, "factuality": number, "length": number, "rationale": "one short sentence"}

Do not include the model name or any indication of which model produced the reply.`;

export async function judgeReply(args: {
  customerMessage: string;
  intent: string;
  reply: string;
  judgeModelId?: string;
}): Promise<JudgeResult> {
  const judgeModelId = args.judgeModelId ?? RUN_CONFIG.judgeModelId;
  const userPrompt = `Customer message:
"""
${args.customerMessage}
"""

Intent label (provided as context): ${args.intent}

Candidate reply to evaluate:
"""
${args.reply}
"""

Score the reply and output the JSON.`;

  // Respect the same supportsTemperature capability flag as the main agent
  // loop. Without this, calling Opus 4.7 (or any other model that has
  // deprecated `temperature`) as a judge produces the very 400 error our
  // governance section warns about.
  const supportsTemperature = modelById(judgeModelId)?.supportsTemperature ?? true;
  const resp = await createMessageWithRetry(
    {
      model: judgeModelId,
      system: JUDGE_SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
      max_tokens: 400,
      ...(supportsTemperature ? { temperature: 0 } : {}),
    },
    { timeoutMs: 30_000 }
  );

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const parsed = tryParseJson(text) as
    | {
        addressesIntent?: number;
        tone?: number;
        factuality?: number;
        length?: number;
        rationale?: string;
      }
    | null;

  const clamp = (n: unknown): number => {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
  };

  const subScores = {
    addressesIntent: clamp(parsed?.addressesIntent),
    tone: clamp(parsed?.tone),
    factuality: clamp(parsed?.factuality),
    length: clamp(parsed?.length),
  };
  const score =
    (subScores.addressesIntent +
      subScores.tone +
      subScores.factuality +
      subScores.length) /
    4;

  const costUsd = computeCostUsd(
    judgeModelId,
    resp.usage.input_tokens,
    resp.usage.output_tokens
  );

  return {
    score,
    subScores,
    rationale: parsed?.rationale ?? "",
    costUsd,
  };
}

/**
 * Run the primary judge always; with probability `secondJudgeSampleRate`, also
 * run a second judge using a different model and return the agreement.
 *
 * Uses a deterministic seed derived from caseId so the same case is either
 * always or never re-judged across replicates of the same case — keeps the
 * sampling reproducible and avoids spending extra budget on noise.
 */
export async function judgeReplyDual(args: {
  caseId: string;
  customerMessage: string;
  intent: string;
  reply: string;
}): Promise<DualJudgeResult> {
  const primary = await judgeReply({
    customerMessage: args.customerMessage,
    intent: args.intent,
    reply: args.reply,
    judgeModelId: RUN_CONFIG.judgeModelId,
  });

  // Deterministic hash of caseId → [0, 1) for the sampling decision
  const sample = sampleHash(args.caseId);
  if (sample < RUN_CONFIG.secondJudgeSampleRate) {
    try {
      const secondary = await judgeReply({
        customerMessage: args.customerMessage,
        intent: args.intent,
        reply: args.reply,
        judgeModelId: RUN_CONFIG.secondJudgeModelId,
      });
      const agreement = 1 - Math.abs(primary.score - secondary.score);
      return {
        primary,
        secondary,
        agreement,
        totalCostUsd: primary.costUsd + secondary.costUsd,
      };
    } catch (err) {
      // Second judge unavailable (e.g., Opus 4.7 rejects temperature, model
      // not accessible to this account, rate-limited). Don't fail the whole
      // scoring path — log so the gap is visible, then fall back to primary.
      console.warn(
        `[judge] second judge failed for case "${args.caseId}" (${RUN_CONFIG.secondJudgeModelId}): ${err instanceof Error ? err.message : String(err)}`
      );
      return { primary, totalCostUsd: primary.costUsd };
    }
  }
  return { primary, totalCostUsd: primary.costUsd };
}

/**
 * Uniformly-distributed deterministic [0, 1) value from an input string.
 * Earlier djb2 implementation clumped all 10 classification case IDs into the
 * [0.25, 0.85] band, missing the 20% threshold entirely. SHA-256's first 4
 * bytes give the uniform distribution we want.
 */
function sampleHash(s: string): number {
  const u = createHash("sha256").update(s).digest().readUInt32BE(0);
  return u / 0x1_0000_0000;
}
