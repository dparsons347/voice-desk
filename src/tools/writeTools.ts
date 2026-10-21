import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentIdSchema } from "../ghl/agents.js";
import { CallIdSchema } from "../ghl/callLogs.js";
import type { ServerDeps } from "../server.js";
import { executeConfirmed, proposeAgentChange, proposeSms, SMS_MAX_CHARS, type AgentChangeArgs, type Store } from "../writes.js";
import { safely } from "./result.js";

const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be an alphanumeric id");

export function registerWriteTools(server: McpServer, { client, config }: ServerDeps, store: Store): void {
  server.registerTool(
    "propose_followup_sms",
    {
      title: "Propose follow-up SMS",
      description:
        "Prepare a text to a caller about a specific call. Sends nothing: returns a preview (recipient, sender, message, the call it follows up) and a confirmToken. Refuses if the caller didn't say yes to texts on that call or has Do Not Disturb on.",
      inputSchema: {
        contactId: IdSchema.describe("The caller's contact id, from the call"),
        callId: CallIdSchema.describe("The call this text follows up"),
        body: z.string().max(SMS_MAX_CHARS).describe("The exact text to send"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safely((args: { contactId: string; callId: string; body: string }) => proposeSms(client, config, store, "propose_followup_sms", args)),
  );

  server.registerTool(
    "propose_agent_change",
    {
      title: "Propose agent change",
      description:
        "Prepare an edit to a Voice AI agent's prompt and/or an action's trigger prompt. Changes nothing: returns a before/after diff and a confirmToken. Prompt edits are find/replace pairs; each `find` must match the live prompt exactly once.",
      inputSchema: {
        agentId: AgentIdSchema,
        promptEdits: z
          .array(z.object({ find: z.string().min(1), replace: z.string() }))
          .optional()
          .describe("Exact passages of the current prompt and their replacements"),
        actionTriggerPrompts: z
          .array(z.object({ actionId: IdSchema, triggerPrompt: z.string().min(1) }))
          .optional()
          .describe("New trigger prompts for actions, by actionId from get_agent_config"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safely((args: AgentChangeArgs) => proposeAgentChange(client, config, store, "propose_agent_change", args)),
  );

  server.registerTool(
    "execute_confirmed",
    {
      title: "Execute confirmed change",
      description:
        "Carry out exactly one previously proposed change. Call this only after the user has seen the preview and explicitly approved it. Tokens are single-use and expire 10 minutes after the proposal. Writes are never retried.",
      inputSchema: { confirmToken: z.string().min(1).describe("Token from propose_followup_sms or propose_agent_change") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    safely(({ confirmToken }: { confirmToken: string }) => executeConfirmed(client, store, "execute_confirmed", confirmToken)),
  );
}
