export interface RubricResult {
  score: number;
  breakdown: Record<string, number>;
}

const GREETING_RX = /\b(hi|hello|hey|moi|hei|tervehdys|terve)\b/i;
const SIGN_OFF_RX =
  /\b(thanks|thank you|regards|best|cheers|kiitos|yst[äa]v[äa]llisin terveisin)\b/i;
const APOLOGY_RX =
  /\b(sorry|apologi[sz]e|apolog[yi]|pahoittelut|pahoittelen|valitettav)\b/i;

export interface RubricInput {
  reply: string;
  intent: string;
  intentKeywords: string[];
}

export function scoreReplyRubric(input: RubricInput): RubricResult {
  const reply = input.reply ?? "";
  const breakdown: Record<string, number> = {};

  // 1) Has greeting
  breakdown.hasGreeting = GREETING_RX.test(reply) ? 1 : 0;

  // 2) Has sign-off / polite close
  breakdown.hasSignOff = SIGN_OFF_RX.test(reply) ? 1 : 0;

  // 3) Mentions intent keywords (any of)
  const lcReply = reply.toLowerCase();
  const hasIntentKeyword = input.intentKeywords.some((kw) =>
    lcReply.includes(kw.toLowerCase())
  );
  breakdown.mentionsIntentKeyword = hasIntentKeyword ? 1 : 0;

  // 4) Length sensible (40..1200 chars)
  const len = reply.length;
  breakdown.lengthOk = len >= 40 && len <= 1200 ? 1 : 0;

  // 5) Apology when intent suggests it
  const needsApology = ["complaint", "refund", "billing_error", "outage"].includes(
    input.intent
  );
  if (needsApology) {
    breakdown.apologyWhenNeeded = APOLOGY_RX.test(reply) ? 1 : 0;
  } else {
    breakdown.apologyWhenNeeded = 1;
  }

  const totalChecks = Object.keys(breakdown).length;
  const sum = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const score = totalChecks === 0 ? 0 : sum / totalChecks;
  return { score, breakdown };
}
