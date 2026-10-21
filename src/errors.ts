import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { redactText } from "./audit.js";

export class GhlApiError extends Error {
  constructor(
    readonly operation: string,
    /** HTTP status, or 0 for network errors and timeouts. */
    readonly status: number,
    readonly safeToRetry: boolean,
    readonly check: string,
    readonly detail?: string,
    readonly retryAfterMs?: number,
  ) {
    super(`${operation} failed${status ? ` with HTTP ${status}` : " (network)"}${detail ? `: ${detail}` : ""}`);
    this.name = "GhlApiError";
  }
}

/** A tool declined to act; `check` says what would have to change. */
export class Refusal extends Error {
  constructor(message: string, readonly check: string) {
    super(message);
    this.name = "Refusal";
  }
}

export class ConfigError extends Error {
  constructor(message: string, readonly check: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The Private Integration scope each operation needs, so a missing-scope error can name it. */
export const OPERATION_SCOPES: Record<string, string> = {
  "voice-ai.call-logs.list": "voice-ai-dashboard.readonly",
  "voice-ai.call-logs.get": "voice-ai-dashboard.readonly",
  "calendars.events.list": "calendars/events.readonly",
  "contacts.get": "contacts.readonly",
  "voice-ai.agents.get": "voice-ai-agents.readonly",
  "voice-ai.agents.list": "voice-ai-agents.readonly",
  "voice-ai.agents.patch": "voice-ai-agents.write",
  "voice-ai.actions.update": "voice-ai-agent-goals.write",
  "conversations.messages.send": "conversations/message.write",
};

export function hintForStatus(status: number, detail?: string, operation?: string): { safeToRetry: boolean; check: string } {
  // HighLevel answers a missing scope with 401, not 403 (seen 2026-10-21).
  if ((status === 401 || status === 403) && /scope/i.test(detail ?? "")) {
    const scope = operation ? OPERATION_SCOPES[operation] : undefined;
    return {
      safeToRetry: false,
      check: `The token is missing ${scope ? `the ${scope} scope` : "a scope this request needs"}. Add it to the voice-desk integration in Settings > Private Integrations; the token itself does not change.`,
    };
  }
  if (status === 0) return { safeToRetry: true, check: "Network error or timeout reaching HighLevel. Check connectivity and try again." };
  if (status === 401)
    return { safeToRetry: false, check: "The Private Integration Token was rejected. Regenerate it in Settings > Private Integrations and update GHL_PIT in .env." };
  if (status === 403)
    return {
      safeToRetry: false,
      check: "The token lacks a required scope or access to this location. Check the PIT has voice-ai-dashboard.readonly and that GHL_LOCATION_ID is the sub-account the PIT was created in.",
    };
  if (status === 404) return { safeToRetry: false, check: "Not found. Check the id is correct and belongs to GHL_LOCATION_ID." };
  if (status === 400 || status === 422) return { safeToRetry: false, check: "HighLevel rejected the request parameters. Check dates, ids and filter values." };
  if (status === 429) return { safeToRetry: true, check: "Rate limited by HighLevel even after backing off. Wait a minute before trying again." };
  if (status >= 500) return { safeToRetry: true, check: "HighLevel returned a server error after 3 attempts. Try again shortly." };
  return { safeToRetry: false, check: "Unexpected response from HighLevel." };
}

/** Turns any failure into a tool result Claude can explain, never a thrown protocol error. */
export function toToolError(err: unknown): CallToolResult {
  let payload: Record<string, unknown>;
  if (err instanceof GhlApiError) {
    payload = {
      error: err.message,
      operation: err.operation,
      status: err.status || "network_error",
      safeToRetry: err.safeToRetry,
      check: err.check,
    };
  } else if (err instanceof Error && "check" in err && typeof err.check === "string") {
    // ConfigError, Refusal, ConfirmError
    payload = { error: err.message, safeToRetry: false, check: err.check };
  } else {
    payload = { error: (err as Error)?.message ?? String(err), safeToRetry: false, check: "Unexpected server error; see stderr." };
  }
  payload.error = redactText(String(payload.error));
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}
