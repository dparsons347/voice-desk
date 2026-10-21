import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  ts: string;
  tool: string;
  operation: string;
  method: string;
  path: string;
  attempt: number;
  status: number | "network_error";
  latencyMs: number;
  outcome: "ok" | "retrying" | "failed" | "dry_run";
  error?: string;
}

// Seven or more digits, optionally led by + and broken up by spaces, dots,
// dashes or brackets. Catches E.164 and the usual US formats.
const PHONE_RE = /\+?\(?\d[\d\s().-]{5,}\d/g;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const BODY_KEYS = new Set(["body", "message", "text", "transcript", "summary"]);

export function redactText(text: string): string {
  return text.replace(PHONE_RE, (match) => (match.replace(/\D/g, "").length >= 7 && !ISO_DATE_RE.test(match) ? "[phone]" : match));
}

export function redact<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, BODY_KEYS.has(k) ? "[redacted]" : redact(v)]),
    ) as T;
  }
  return value;
}

export interface AuditLog {
  record(entry: Omit<AuditEntry, "ts">): void;
}

export class JsonlAuditLog implements AuditLog {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  record(entry: Omit<AuditEntry, "ts">): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...redact(entry) });
    try {
      appendFileSync(this.filePath, line + "\n");
    } catch (err) {
      // stdout belongs to the MCP transport; diagnostics go to stderr.
      console.error(`[voice-desk] audit write failed: ${(err as Error).message}`);
    }
  }
}

export class MemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];
  record(entry: Omit<AuditEntry, "ts">): void {
    this.entries.push({ ts: new Date().toISOString(), ...redact(entry) });
  }
}
