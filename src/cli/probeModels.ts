import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getClient } from "../agent/anthropicClient.js";

function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const ln of readFileSync(path, "utf-8").split("\n")) {
    const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!k) continue;
    if (process.env[k] !== undefined) continue;
    process.env[k] = (v ?? "").replace(/^"(.*)"$/, "$1");
  }
}
loadDotEnv();

const CANDIDATES: { id: string; label: string }[] = [
  // Sonnet 3.5 family
  { id: "claude-3-5-sonnet-latest", label: "Sonnet 3.5 (latest alias)" },
  { id: "claude-3-5-sonnet-20241022", label: "Sonnet 3.5 v2 (Oct 2024)" },
  { id: "claude-3-5-sonnet-20240620", label: "Sonnet 3.5 v1 (Jun 2024)" },
  // Sonnet 3 (older)
  { id: "claude-3-sonnet-20240229", label: "Sonnet 3 (Feb 2024)" },
  // Sonnet 3.7
  { id: "claude-3-7-sonnet-20250219", label: "Sonnet 3.7 (Feb 2025)" },
  { id: "claude-3-7-sonnet-latest", label: "Sonnet 3.7 (latest alias)" },
  // Sonnet 4 family
  { id: "claude-sonnet-4-20250514", label: "Sonnet 4 (May 2025)" },
  { id: "claude-sonnet-4-0", label: "Sonnet 4.0 alias" },
  // Sonnet 4.5
  { id: "claude-sonnet-4-5", label: "Sonnet 4.5 alias" },
  { id: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5 (Sep 2025)" },
  // Sonnet 4.6
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 alias" },
  // Haiku
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  // Opus
  { id: "claude-opus-4-7", label: "Opus 4.7 alias" },
];

interface ProbeResult {
  id: string;
  label: string;
  ok: boolean;
  status?: string;
  message?: string;
}

async function probe(id: string): Promise<{
  ok: boolean;
  status?: string;
  message?: string;
}> {
  const client = getClient();
  try {
    const resp = await client.messages.create({
      model: id,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
    return { ok: true, status: String(resp.stop_reason ?? "ok") };
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string; error?: unknown };
    const status = e.status ? String(e.status) : "err";
    let msg = e.message ?? String(err);
    // Try to extract clean message
    const m = msg.match(/"message":"([^"]+)"/);
    if (m) msg = m[1] ?? msg;
    return { ok: false, status, message: msg.slice(0, 160) };
  }
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }
  console.log(`Probing ${CANDIDATES.length} candidate model IDs with 1-token pings...\n`);
  const results: ProbeResult[] = [];
  for (const c of CANDIDATES) {
    process.stdout.write(`  ${c.id.padEnd(40)} ... `);
    const r = await probe(c.id);
    results.push({ id: c.id, label: c.label, ...r });
    if (r.ok) {
      console.log(`\x1b[32mOK\x1b[0m`);
    } else {
      console.log(`\x1b[31m${r.status}\x1b[0m  ${r.message ?? ""}`);
    }
  }
  console.log("\n─────────────────────────────────");
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  console.log(`Available: ${ok.length} / ${results.length}`);
  console.log("─────────────────────────────────");
  console.log("\nAvailable model IDs (copy these into src/config/models.ts):\n");
  for (const r of ok) console.log(`  ✓ ${r.id}  — ${r.label}`);
  console.log("\nUnavailable:\n");
  for (const r of failed)
    console.log(`  ✗ ${r.id}  (${r.status})  ${r.message ?? ""}`);
}

main().catch((e) => {
  console.error("Probe failed:", e);
  process.exit(1);
});
