import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlAuditLog, redact, redactText } from "../src/audit.js";

describe("redaction", () => {
  it("replaces phone numbers in common formats", () => {
    expect(redactText("call +15555550123 or (555) 555-0123 or 555.555.0123")).toBe("call [phone] or [phone] or [phone]");
  });
  it("leaves short numbers, ids and timestamps' small digit runs alone", () => {
    expect(redactText("HTTP 429 after 3 attempts, page 2")).toBe("HTTP 429 after 3 attempts, page 2");
  });
  it("does not mistake ISO dates for phone numbers", () => {
    expect(redactText("startDate 2026-10-01T09:00:00Z, call 555-555-0123")).toBe("startDate 2026-10-01T09:00:00Z, call [phone]");
  });
  it("redacts message bodies by key, recursively", () => {
    expect(redact({ a: { body: "hi there", n: "+15555550123" }, list: [{ message: "x" }] })).toEqual({
      a: { body: "[redacted]", n: "[phone]" },
      list: [{ message: "[redacted]" }],
    });
  });
});

describe("JsonlAuditLog", () => {
  it("appends one redacted JSON line per record", () => {
    const file = join(mkdtempSync(join(tmpdir(), "vd-audit-")), "nested", "audit.jsonl");
    const log = new JsonlAuditLog(file);
    const base = { tool: "get_call", operation: "op", method: "GET", path: "/x", attempt: 1, latencyMs: 12 } as const;
    log.record({ ...base, status: 200, outcome: "ok" });
    log.record({ ...base, status: 400, outcome: "failed", error: "bad number +15555550123" });
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ tool: "get_call", status: 200, latencyMs: 12, outcome: "ok" });
    expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lines[1].error).toBe("bad number [phone]");
  });
});
