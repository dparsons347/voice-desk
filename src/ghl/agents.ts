import { z } from "zod";
import type { HighLevelClient } from "./client.js";

// Confirmed against a live response on 2026-10-21
// (fixtures/recorded/thats-automated-agents.sanitized.json). Both endpoints
// need locationId: without it the list returns 400 and a single agent 403.
export const AgentActionSchema = z.looseObject({
  id: z.string(),
  actionType: z.string(),
  name: z.string().nullish(),
  actionParameters: z.record(z.string(), z.unknown()).nullish(),
});

export const AgentSchema = z.looseObject({
  id: z.string(),
  agentName: z.string().nullish(),
  businessName: z.string().nullish(),
  welcomeMessage: z.string().nullish(),
  agentPrompt: z.string().nullish(),
  inboundNumbers: z.array(z.string()).nullish(),
  timezone: z.string().nullish(),
  maxCallDuration: z.number().nullish(),
  actions: z.array(AgentActionSchema).nullish(),
});

export const AgentListSchema = z.looseObject({ agents: z.array(AgentSchema), total: z.number().nullish() });

export type Agent = z.infer<typeof AgentSchema>;
export type AgentAction = z.infer<typeof AgentActionSchema>;

export const AgentIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "agentId must be an alphanumeric id");

export function getAgent(client: HighLevelClient, tool: string, agentId: string): Promise<Agent> {
  return client.read({
    tool,
    operation: "voice-ai.agents.get",
    path: `/voice-ai/agents/${encodeURIComponent(AgentIdSchema.parse(agentId))}`,
    query: { locationId: client.locationId },
    schema: AgentSchema,
  });
}

export async function listAgents(client: HighLevelClient, tool: string): Promise<Agent[]> {
  const res = await client.read({
    tool,
    operation: "voice-ai.agents.list",
    path: "/voice-ai/agents",
    query: { locationId: client.locationId, page: 1, pageSize: 50 },
    schema: AgentListSchema,
  });
  return res.agents;
}
