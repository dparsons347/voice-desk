// One-off: call the call-logs list endpoint once and print the raw response
// plus a type outline, before any outcome logic is written (plan, "Verify early" #2).
// Usage: npm run probe:call-logs [-- --page-size 5]
// The raw response is saved to fixtures/raw/ (gitignored: it holds real phone numbers).
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { JsonlAuditLog } from "../src/audit.js";
import { PROJECT_ROOT, loadConfig } from "../src/config.js";
import { HighLevelClient } from "../src/ghl/client.js";
import { LIST_PATH } from "../src/ghl/callLogs.js";

const sizeArg = process.argv.indexOf("--page-size");
const pageSize = sizeArg > 0 ? Number(process.argv[sizeArg + 1]) : 5;

function outline(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[] (empty)";
    return [outline(value[0], depth + 1), `…${value.length} item(s)`];
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, outline(v, depth + 1)]));
  }
  return value === null ? "null" : typeof value;
}

const config = loadConfig();
const client = new HighLevelClient(config, { audit: new JsonlAuditLog(config.auditLogPath) });

// Raw passthrough: z.unknown() so nothing is stripped or rejected.
const raw = await client.read({
  tool: "probe",
  operation: "voice-ai.call-logs.list",
  path: LIST_PATH,
  query: { locationId: client.locationId, page: 1, pageSize },
  schema: z.unknown(),
});

const dir = resolve(PROJECT_ROOT, "fixtures/raw");
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `call-logs-list-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");

console.log("=== Type outline ===");
console.log(JSON.stringify(outline(raw), null, 2));
console.log("\n=== Raw response ===");
console.log(JSON.stringify(raw, null, 2));
console.log(`\nSaved to ${file}`);
