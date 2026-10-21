import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toToolError } from "../errors.js";

export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Wraps a handler so every failure becomes an isError result with a `check` hint. */
export function safely<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return jsonResult(await fn(args));
    } catch (err) {
      return toToolError(err);
    }
  };
}
