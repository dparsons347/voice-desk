import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AgentIdSchema, getAgent, listAgents, type Agent, type AgentAction } from "../ghl/agents.js";
import type { OutcomeRules } from "../outcomes.js";
import type { ServerDeps } from "../server.js";
import { safely } from "./result.js";

/** How voice-desk reads this action when deriving outcomes, so a mismatch with .env is visible. */
function countsAs(action: AgentAction, rules: OutcomeRules): string | null {
  if (action.actionType === "APPOINTMENT_BOOKING") {
    const calendarId = action.actionParameters?.calendarId;
    return typeof calendarId === "string" && rules.bookingCalendarIds.includes(calendarId)
      ? "booked (verified against this calendar)"
      : "booked, but its calendar is not in BOOKING_CALENDAR_IDS, so these bookings will be missed";
  }
  if (rules.callbackActionIds.has(action.id)) return "callback_requested";
  if (action.actionType === "WORKFLOW_TRIGGER") return "not mapped to an outcome (add to OUTCOME_CALLBACK_ACTION_IDS if it means a callback)";
  return null;
}

function describeAgent(agent: Agent, rules: OutcomeRules) {
  return {
    agentId: agent.id,
    name: agent.agentName ?? null,
    businessName: agent.businessName ?? null,
    inboundNumbers: agent.inboundNumbers ?? [],
    timezone: agent.timezone ?? null,
    maxCallDurationSeconds: agent.maxCallDuration ?? null,
    greeting: agent.welcomeMessage ?? null,
    prompt: agent.agentPrompt ?? null,
    actions: (agent.actions ?? []).map((a) => {
      const { triggerPrompt, description, ...details } = a.actionParameters ?? {};
      return {
        actionId: a.id,
        type: a.actionType,
        name: a.name ?? null,
        // When the agent fires it (most actions) or what it captures (data extraction).
        triggerPrompt: triggerPrompt ?? null,
        description: description ?? null,
        details,
        voiceDeskCountsAs: countsAs(a, rules),
      };
    }),
  };
}

export function registerGetAgentConfig(server: McpServer, { client, config }: ServerDeps): void {
  server.registerTool(
    "get_agent_config",
    {
      title: "Get agent config",
      description:
        "A Voice AI agent's prompt, greeting, and actions with their trigger prompts, plus how voice-desk counts each action toward outcomes. Omit agentId to get every agent in the location (the agentId on each call from list_calls also works).",
      inputSchema: { agentId: AgentIdSchema.optional().describe("Agent id; omit for all agents") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safely(async ({ agentId }: { agentId?: string }) => {
      const agents = agentId ? [await getAgent(client, "get_agent_config", agentId)] : await listAgents(client, "get_agent_config");
      return { agents: agents.map((a) => describeAgent(a, config.outcomeRules)) };
    }),
  );
}
