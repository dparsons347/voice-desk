import type { z } from "zod";
import type { AuditLog } from "../audit.js";
import type { Config } from "../config.js";
import { ConfigError, GhlApiError, hintForStatus } from "../errors.js";
import { READ_RETRY, parseRetryAfter, withRetry, type RetryOptions } from "../retry.js";

export type Query = Record<string, string | number | boolean | undefined>;

export interface ReadRequest<S extends z.ZodType> {
  tool: string;
  operation: string;
  path: string;
  query?: Query;
  schema: S;
}

export interface WriteRequest {
  tool: string;
  operation: string;
  method: "POST" | "PUT" | "PATCH";
  path: string;
  query?: Query;
  body: unknown;
}

export type WriteResult = { dryRun: true; request: { method: string; path: string; body: unknown } } | { dryRun: false; response: unknown };

const WRITE_CHECK =
  "Writes are never retried automatically, and this confirmation is used up. Check HighLevel to see whether the change landed, then propose it again if it didn't.";

export interface ClientDeps {
  audit: AuditLog;
  fetch?: typeof fetch;
  retry?: RetryOptions;
  timeoutMs?: number;
}

export class HighLevelClient {
  private readonly fetchImpl: typeof fetch;
  private readonly retry: RetryOptions;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: Config,
    private readonly deps: ClientDeps,
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.retry = deps.retry ?? READ_RETRY;
    this.timeoutMs = deps.timeoutMs ?? 15_000;
  }

  get locationId(): string {
    if (!this.config.locationId) {
      throw new ConfigError("GHL_LOCATION_ID is not set.", "Add the sub-account id to .env (Settings > Business Profile, or the id in the sub-account URL).");
    }
    return this.config.locationId;
  }

  get timezone(): string | undefined {
    return this.config.timezone;
  }

  /** GET with retry on 429/5xx/network errors. Every attempt writes one audit line. */
  async read<S extends z.ZodType>(req: ReadRequest<S>): Promise<z.output<S>> {
    const pit = this.config.pit;
    if (!pit) {
      throw new ConfigError("GHL_PIT is not set.", "Create a Private Integration Token in the sub-account and put it in .env as GHL_PIT.");
    }
    const url = new URL(this.config.baseUrl + req.path);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const json = await withRetry(
      (attempt) => this.attempt(req, url, pit, attempt),
      (err) => ({
        retryable: err instanceof GhlApiError && err.safeToRetry,
        retryAfterMs: err instanceof GhlApiError ? err.retryAfterMs : undefined,
      }),
      this.retry,
    );

    const parsed = req.schema.safeParse(json);
    if (!parsed.success) {
      throw new GhlApiError(
        req.operation,
        200,
        false,
        "HighLevel returned a response in an unexpected shape. The API may have changed; compare against fixtures/.",
        parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      );
    }
    return parsed.data;
  }

  /**
   * One attempt, never retried: a write that timed out may still have landed,
   * and retrying could send an SMS twice. With DRY_RUN the request is audited
   * and returned instead of sent.
   */
  async write(req: WriteRequest): Promise<WriteResult> {
    const pit = this.config.pit;
    if (!pit) {
      throw new ConfigError("GHL_PIT is not set.", "Create a Private Integration Token in the sub-account and put it in .env as GHL_PIT.");
    }
    const url = new URL(this.config.baseUrl + req.path);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const base = { tool: req.tool, operation: req.operation, method: req.method, path: req.path, attempt: 1 };

    if (this.config.dryRun) {
      this.deps.audit.record({ ...base, status: 0, latencyMs: 0, outcome: "dry_run" });
      return { dryRun: true, request: { method: req.method, path: url.pathname + url.search, body: req.body } };
    }

    const started = performance.now();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${pit}`,
          Version: this.config.apiVersion,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const message = (err as Error).message;
      this.deps.audit.record({ ...base, status: "network_error", latencyMs: elapsed(started), outcome: "failed", error: message });
      throw new GhlApiError(req.operation, 0, false, `No response from HighLevel, so the write may or may not have gone through. ${WRITE_CHECK}`, message);
    }

    const latencyMs = elapsed(started);
    if (!res.ok) {
      const detail = await errorDetail(res);
      const { check } = hintForStatus(res.status, detail, req.operation);
      this.deps.audit.record({ ...base, status: res.status, latencyMs, outcome: "failed", error: detail });
      throw new GhlApiError(req.operation, res.status, false, `${check} ${WRITE_CHECK}`, detail);
    }

    this.deps.audit.record({ ...base, status: res.status, latencyMs, outcome: "ok" });
    const text = await res.text();
    try {
      return { dryRun: false, response: text ? JSON.parse(text) : null };
    } catch {
      return { dryRun: false, response: text };
    }
  }

  private async attempt(req: ReadRequest<z.ZodType>, url: URL, pit: string, attempt: number): Promise<unknown> {
    const started = performance.now();
    const base = { tool: req.tool, operation: req.operation, method: "GET", path: req.path, attempt };
    const willRetry = attempt < this.retry.attempts;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${pit}`, Version: this.config.apiVersion, Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const { safeToRetry, check } = hintForStatus(0);
      const message = (err as Error).message;
      this.deps.audit.record({ ...base, status: "network_error", latencyMs: elapsed(started), outcome: willRetry ? "retrying" : "failed", error: message });
      throw new GhlApiError(req.operation, 0, safeToRetry, check, message);
    }

    const latencyMs = elapsed(started);
    if (!res.ok) {
      const detail = await errorDetail(res);
      const { safeToRetry, check } = hintForStatus(res.status, detail, req.operation);
      this.deps.audit.record({ ...base, status: res.status, latencyMs, outcome: safeToRetry && willRetry ? "retrying" : "failed", error: detail });
      throw new GhlApiError(req.operation, res.status, safeToRetry, check, detail, parseRetryAfter(res.headers.get("retry-after")));
    }

    this.deps.audit.record({ ...base, status: res.status, latencyMs, outcome: "ok" });
    try {
      return await res.json();
    } catch {
      throw new GhlApiError(req.operation, res.status, false, "HighLevel returned a non-JSON body.");
    }
  }
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

async function errorDetail(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { message?: unknown };
      const msg = Array.isArray(body.message) ? body.message.join("; ") : body.message;
      return typeof msg === "string" ? msg.slice(0, 300) : text.slice(0, 300);
    } catch {
      return text.slice(0, 300) || undefined;
    }
  } catch {
    return undefined;
  }
}
