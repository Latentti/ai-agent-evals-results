import { describe, expect, it } from "vitest";
import {
  exactMatch,
  extractTaggedAnswer,
  fieldF1,
  numericEqual,
  tryParseJson,
} from "../src/scoring/shared.js";
import { scoreReplyRubric } from "../src/scoring/ruleRubric.js";

describe("shared scorers", () => {
  it("normalizes strings for exact match", () => {
    expect(exactMatch("  Hello  ", "hello")).toBe(true);
    expect(exactMatch("a", "b")).toBe(false);
  });

  it("compares numbers with tolerance", () => {
    expect(numericEqual(1.0, 1.0)).toBe(true);
    expect(numericEqual("1.10", 1.1)).toBe(true);
    expect(numericEqual("foo", 1)).toBe(false);
  });

  it("extracts <answer> tags", () => {
    expect(extractTaggedAnswer("blah <answer>42</answer> blah")).toBe("42");
    expect(extractTaggedAnswer("no tag here")).toBeNull();
  });

  it("parses embedded JSON object", () => {
    const out = tryParseJson('Here is the data: {"a": 1, "b": "x"}');
    expect(out).toEqual({ a: 1, b: "x" });
  });

  it("parses JSON containing braces inside strings", () => {
    const out = tryParseJson(
      'Output: {"reply": "Hi {customer}, see the {package}.", "intent": "x"}'
    );
    expect(out).toEqual({
      reply: "Hi {customer}, see the {package}.",
      intent: "x",
    });
  });

  it("handles escape sequences in strings", () => {
    const out = tryParseJson('{"x": "a \\"quoted\\" b"}');
    expect(out).toEqual({ x: 'a "quoted" b' });
  });

  it("returns first complete object when multiple are emitted", () => {
    const out = tryParseJson('First: {"a": 1} and {"b": 2}');
    expect(out).toEqual({ a: 1 });
  });

  it("returns null when input has no JSON", () => {
    expect(tryParseJson("just prose, nothing structured")).toBeNull();
  });

  it("parses JSON arrays", () => {
    const out = tryParseJson('Result: [1, 2, {"nested": true}]');
    expect(out).toEqual([1, 2, { nested: true }]);
  });

  it("computes field F1 with null handling", () => {
    const pred = { vendor: "Acme", date: "2026-01-01", total: 100 };
    const gold = { vendor: "Acme", date: "2026-01-01", total: 100, vat: null };
    const r = fieldF1(pred, gold);
    expect(r.correctCount).toBe(4);
    expect(r.f1).toBeGreaterThan(0.9);
  });

  it("returns 0 F1 when predicted is null", () => {
    const r = fieldF1(null, { a: 1 });
    expect(r.f1).toBe(0);
  });
});

describe("rule rubric", () => {
  it("scores a good reply highly", () => {
    const out = scoreReplyRubric({
      reply:
        "Hi! Sorry to hear you were charged twice. I'll look into this billing issue and get back to you. Thanks for your patience.",
      intent: "billing_error",
      intentKeywords: ["billing", "charged"],
    });
    expect(out.score).toBeGreaterThan(0.7);
  });

  it("penalises a curt reply that misses intent keywords", () => {
    const out = scoreReplyRubric({
      reply: "OK.",
      intent: "billing_error",
      intentKeywords: ["billing", "charged"],
    });
    expect(out.score).toBeLessThan(0.5);
  });
});
