import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Case, Task } from "./types.js";
import { fieldF1, tryParseJson } from "../scoring/shared.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ExtractionInput {
  text: string;
}

interface ExtractionGold {
  vendor: string | null;
  invoiceNumber: string | null;
  date: string | null;
  totalAmount: number | null;
  currency: string | null;
  vatAmount: number | null;
}

const SYSTEM_PROMPT = `You extract structured invoice data from messy text.
Return ONLY a JSON object with EXACTLY these fields (use null if a field is missing or unclear):

{
  "vendor": string|null,           // company that issued the invoice
  "invoiceNumber": string|null,    // the invoice/receipt identifier
  "date": string|null,             // ISO format YYYY-MM-DD
  "totalAmount": number|null,      // grand total, numeric only (no currency symbol)
  "currency": string|null,         // ISO 4217 code like EUR, USD, GBP, SEK
  "vatAmount": number|null         // tax/VAT amount, numeric only
}

Do not include any other fields, prose, or commentary. Output ONLY the JSON object.`;

const TUNED_SYSTEM_PROMPT = `You extract structured invoice data from messy text and return STRICT JSON only.

OUTPUT SCHEMA (exact key set, no extras):
{
  "vendor": string|null,           // the issuing company name, as written
  "invoiceNumber": string|null,    // the invoice/order/receipt identifier (e.g. INV-..., R-..., ORD-...)
  "date": string|null,             // ALWAYS in ISO format YYYY-MM-DD; convert from any format including DD.MM.YYYY, DD/MM/YY, "7 April 2026", "03/04/26"
  "totalAmount": number|null,      // grand total as a number; strip currency symbols and thousands separators; convert European decimals (1.250,00) to standard (1250.00)
  "currency": string|null,         // ISO 4217 code. Infer from symbols: € → EUR, $ → USD, £ → GBP, ¥ → JPY/CNY (default JPY), kr → SEK
  "vatAmount": number|null         // VAT / tax / MwSt / ALV amount as a number, or null
}

RULES:
- If a field is genuinely missing or ambiguous, return null. Do NOT guess.
- Use exact keys above. Do NOT add fields. Do NOT include any prose, code fences, or commentary.
- Multilingual input: vendor label may be in any language but the values must follow the schema (e.g. Finnish "ALV" → vatAmount; German "MwSt" → vatAmount; "Datum"/"Päiväys" → date).

EXAMPLE INPUT:
"Rechnung Nr. R-2026-7711\\nDeutsche Werkzeuge GmbH\\nDatum: 22.05.2026\\nNettobetrag: 1.250,00 €\\nMwSt 19%: 237,50 €\\nGesamtbetrag: 1.487,50 €"

EXAMPLE OUTPUT:
{"vendor":"Deutsche Werkzeuge GmbH","invoiceNumber":"R-2026-7711","date":"2026-05-22","totalAmount":1487.5,"currency":"EUR","vatAmount":237.5}

Now extract from the user's input. Output JSON only.`;

const casesPath = resolve(__dirname, "cases/extraction.cases.json");
const cases = JSON.parse(readFileSync(casesPath, "utf-8")) as Case<
  ExtractionInput,
  ExtractionGold
>[];

export const extractionTask: Task<ExtractionInput, ExtractionGold> = {
  id: "extraction",
  displayName: "Structured extraction (invoices)",
  systemPrompt: SYSTEM_PROMPT,
  variants: [
    {
      id: "tuned",
      displayName: "Tuned (explicit schema + few-shot)",
      systemPrompt: TUNED_SYSTEM_PROMPT,
    },
  ],
  cases,
  replicates: 2,
  estimatedOutputTokens: 400,
  buildUserPrompt: (input) => input.text,
  parseOutput: (finalText) => {
    const parsed = tryParseJson(finalText) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const get = (k: string): unknown => parsed[k];
    return {
      vendor: (get("vendor") as string | null) ?? null,
      invoiceNumber: (get("invoiceNumber") as string | null) ?? null,
      date: (get("date") as string | null) ?? null,
      totalAmount:
        get("totalAmount") === null || get("totalAmount") === undefined
          ? null
          : Number(get("totalAmount")),
      currency: (get("currency") as string | null) ?? null,
      vatAmount:
        get("vatAmount") === null || get("vatAmount") === undefined
          ? null
          : Number(get("vatAmount")),
    };
  },
  score: (predicted, gold) => {
    const goldObj = gold as unknown as Record<string, unknown>;
    const predObj = predicted as unknown as Record<string, unknown> | null;
    const f1 = fieldF1(predObj, goldObj);
    const schemaValid = predicted !== null ? 1 : 0;
    let numericExact = 0;
    let numericTotal = 0;
    for (const k of ["totalAmount", "vatAmount"] as const) {
      if (goldObj[k] !== null) {
        numericTotal++;
        if (predObj && Number(predObj[k]) === Number(goldObj[k])) numericExact++;
      }
    }
    return {
      correctness: f1.f1,
      subMetrics: {
        schemaValid,
        fieldsPresent: f1.presentCount,
        fieldsCorrect: f1.correctCount,
        numericExactMatch: numericTotal === 0 ? 1 : numericExact / numericTotal,
        precision: f1.precision,
        recall: f1.recall,
      },
      rationale: `F1=${f1.f1.toFixed(2)} (${f1.correctCount}/${f1.totalFields} fields correct)`,
    };
  },
};
