export function normalize(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s).trim().toLowerCase().replace(/\s+/g, " ");
}

export function exactMatch(a: unknown, b: unknown): boolean {
  return normalize(a) === normalize(b);
}

export function numericEqual(a: unknown, b: unknown, tol = 1e-6): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
  return Math.abs(na - nb) <= tol * Math.max(1, Math.abs(nb));
}

export interface FieldF1Result {
  f1: number;
  precision: number;
  recall: number;
  presentCount: number;
  correctCount: number;
  totalFields: number;
}

export function fieldF1(
  predicted: Record<string, unknown> | null,
  gold: Record<string, unknown>
): FieldF1Result {
  const goldKeys = Object.keys(gold);
  const totalFields = goldKeys.length;
  if (!predicted) {
    return {
      f1: 0,
      precision: 0,
      recall: 0,
      presentCount: 0,
      correctCount: 0,
      totalFields,
    };
  }
  let correctCount = 0;
  let presentCount = 0;
  for (const k of goldKeys) {
    const p = predicted[k];
    const g = gold[k];
    if (p !== undefined && p !== null && p !== "") presentCount++;
    if (typeof g === "number") {
      if (numericEqual(p, g)) correctCount++;
    } else if (g === null || g === undefined) {
      if (p === null || p === undefined || p === "") correctCount++;
    } else {
      if (exactMatch(p, g)) correctCount++;
    }
  }
  const predKeysWithValue = Object.entries(predicted ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== ""
  ).length;
  const precision = predKeysWithValue === 0 ? 0 : correctCount / predKeysWithValue;
  const recall = totalFields === 0 ? 0 : correctCount / totalFields;
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { f1, precision, recall, presentCount, correctCount, totalFields };
}

export function extractTaggedAnswer(text: string): string | null {
  const m = text.match(/<answer>([\s\S]*?)<\/answer>/i);
  if (!m) return null;
  return (m[1] ?? "").trim();
}

/**
 * Best-effort JSON extraction from a text response.
 *
 * Strategy:
 *   1. Try parsing the whole string directly.
 *   2. Otherwise scan for the first `{` or `[` and run a single-pass balanced-
 *      brace scanner that respects string quoting and escapes. Emit the first
 *      complete top-level object/array.
 *
 * O(n) on the input. Replaces the previous O(n²) right-trim approach.
 *
 * Caveat: if the model emits multiple JSON objects, only the FIRST complete one
 * is returned.
 */
export function tryParseJson(text: string): unknown {
  if (!text) return null;
  // Fast path: whole text is JSON
  try {
    return JSON.parse(text);
  } catch {
    // fall through to scanner
  }

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "{" && c !== "[") continue;
    const end = findBalancedEnd(text, i);
    if (end === -1) continue;
    try {
      return JSON.parse(text.slice(i, end + 1));
    } catch {
      // not a valid JSON value despite balanced braces; keep scanning
    }
  }
  return null;
}

/**
 * Single-pass scanner: given a start index pointing at `{` or `[`, return the
 * index of the matching `}` or `]` (depth zero), or -1 if unbalanced.
 * Respects string quoting and escape sequences.
 */
function findBalancedEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        return c === close ? i : -1;
      }
    }
  }
  return -1;
}
