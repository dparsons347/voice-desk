import type { HighLevelClient } from "./client.js";

export interface SmsRequest {
  contactId: string;
  toNumber: string;
  fromNumber?: string;
  message: string;
}

export function sendSms(client: HighLevelClient, tool: string, sms: SmsRequest) {
  return client.write({
    tool,
    operation: "conversations.messages.send",
    method: "POST",
    path: "/conversations/messages",
    body: { type: "SMS", contactId: sms.contactId, toNumber: sms.toNumber, fromNumber: sms.fromNumber, message: sms.message },
  });
}

export function patchAgentPrompt(client: HighLevelClient, tool: string, agentId: string, agentPrompt: string) {
  return client.write({
    tool,
    operation: "voice-ai.agents.patch",
    method: "PATCH",
    path: `/voice-ai/agents/${encodeURIComponent(agentId)}`,
    query: { locationId: client.locationId },
    body: { agentPrompt },
  });
}

export interface ActionUpdate {
  actionId: string;
  agentId: string;
  actionType: string;
  name: string;
  actionParameters: Record<string, unknown>;
}

/** PUT replaces the whole action, so the body carries every existing parameter, not just the changed one. */
export function updateAction(client: HighLevelClient, tool: string, u: ActionUpdate) {
  return client.write({
    tool,
    operation: "voice-ai.actions.update",
    method: "PUT",
    path: `/voice-ai/actions/${encodeURIComponent(u.actionId)}`,
    query: { locationId: client.locationId },
    body: { agentId: u.agentId, actionType: u.actionType, name: u.name, actionParameters: u.actionParameters },
  });
}
