import type { Config } from "./config.js";
import { hashPayload, type ConfirmStore } from "./confirm.js";
import { GhlApiError, Refusal } from "./errors.js";
import { getAgent } from "./ghl/agents.js";
import { getCallLog } from "./ghl/callLogs.js";
import type { HighLevelClient, WriteResult } from "./ghl/client.js";
import { getContact, smsBlocked } from "./ghl/contacts.js";
import { patchAgentPrompt, sendSms, updateAction, type ActionUpdate } from "./ghl/writes.js";
import { normalisePhone } from "./scan.js";

export const SMS_MAX_CHARS = 640;

export interface SmsProposal {
  kind: "sms";
  contactId: string;
  callId: string;
  toNumber: string;
  fromNumber?: string;
  message: string;
}

export interface AgentProposal {
  kind: "agent_change";
  agentId: string;
  /** Present only when the prompt changes; guards against edits made after the preview. */
  prompt?: { beforeHash: string; after: string };
  actions: (ActionUpdate & { beforeHash: string })[];
}

export type Proposal = SmsProposal | AgentProposal;
export type Store = ConfirmStore<Proposal>;

/** GSM-7 messages split at 153 chars per segment once over 160; anything else at 67 after 70. */
export function smsSegments(text: string): number {
  const gsm = /^[\x20-\x7E\n\r£¥èéùìòÇØøÅåÄÖÑÜ§äöñüà€]*$/.test(text);
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return text.length <= single ? 1 : Math.ceil(text.length / multi);
}

// ---------- SMS ----------

export async function proposeSms(
  client: HighLevelClient,
  config: Config,
  store: Store,
  tool: string,
  args: { contactId: string; callId: string; body: string },
) {
  const message = args.body.trim();
  if (!message) throw new Refusal("The message is empty.", "Write the text you want to send.");
  if (message.length > SMS_MAX_CHARS) {
    throw new Refusal(`The message is ${message.length} characters.`, `Keep follow-up texts under ${SMS_MAX_CHARS} characters.`);
  }

  const call = await getCallLog(client, tool, args.callId);
  if (call.contactId !== args.contactId) {
    throw new Refusal("That call belongs to a different contact.", "Use the contactId shown on the call in list_calls or calls_needing_followup.");
  }

  // Consent comes from the caller's own answer on this call, not from any default.
  const answer = call.extractedData?.[config.sms.consentField];
  if (typeof answer !== "string" || !/^\s*yes\b/i.test(answer)) {
    throw new Refusal(
      `The caller did not agree to texts on this call (${config.sms.consentField}: ${typeof answer === "string" ? `"${answer}"` : "not captured"}).`,
      "Only text callers who said yes to the texting question. Follow up by email or phone instead.",
    );
  }

  const contact = await getContact(client, tool, args.contactId);
  if (!contact.phone) throw new Refusal("The contact has no phone number.", "Add a number to the contact in HighLevel first.");
  if (smsBlocked(contact)) {
    throw new Refusal("The contact has Do Not Disturb on for texts.", "Respect the opt-out; follow up another way.");
  }

  const proposal: SmsProposal = {
    kind: "sms",
    contactId: contact.id,
    callId: call.id,
    toNumber: contact.phone,
    fromNumber: config.sms.fromNumber,
    message,
  };
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || null;
  return {
    preview: {
      action: "Send one SMS",
      to: { name, phone: contact.phone, contactId: contact.id },
      from: config.sms.fromNumber ?? "the location's default number",
      message,
      characters: message.length,
      segments: smsSegments(message),
      aboutCall: { callId: call.id, createdAt: call.createdAt ?? null, summary: call.summary ?? null },
      consent: `${config.sms.consentField}: ${answer}`,
      dryRun: config.dryRun,
    },
    ...store.issue(proposal),
    next: "Show this preview to the user and wait for them to approve it. Only then call execute_confirmed with the confirmToken.",
  };
}

async function executeSms(client: HighLevelClient, tool: string, p: SmsProposal) {
  // The number or opt-out status could have changed since the preview.
  const contact = await getContact(client, tool, p.contactId);
  if (!contact.phone || normalisePhone(contact.phone) !== normalisePhone(p.toNumber)) {
    throw new Refusal("The contact's phone number changed after the preview.", "Propose the text again so the preview shows the new number.");
  }
  if (smsBlocked(contact)) throw new Refusal("The contact turned on Do Not Disturb for texts after the preview.", "Do not send.");
  const result = await sendSms(client, tool, p);
  return { kind: "sms", to: p.toNumber, ...describeResult(result) };
}

// ---------- Agent changes ----------

export interface AgentChangeArgs {
  agentId: string;
  promptEdits?: { find: string; replace: string }[];
  actionTriggerPrompts?: { actionId: string; triggerPrompt: string }[];
}

/** Line diff via longest common subsequence; prompts are a few hundred lines at most. */
export function lineDiff(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) {
      // Strict >: on a tie the removal is emitted first, so a changed line reads "- old" then "+ new".
      out.push(`+ ${b[j++]}`);
    } else {
      out.push(`- ${a[i++]}`);
    }
  }
  return out;
}

export async function proposeAgentChange(client: HighLevelClient, config: Config, store: Store, tool: string, args: AgentChangeArgs) {
  const edits = args.promptEdits ?? [];
  const triggers = args.actionTriggerPrompts ?? [];
  if (edits.length === 0 && triggers.length === 0) {
    throw new Refusal("No changes given.", "Pass promptEdits and/or actionTriggerPrompts.");
  }

  const agent = await getAgent(client, tool, args.agentId);
  const proposal: AgentProposal = { kind: "agent_change", agentId: agent.id, actions: [] };
  const diff: { field: string; lines?: string[]; before?: string; after?: string }[] = [];

  if (edits.length) {
    const before = agent.agentPrompt ?? "";
    let after = before;
    for (const [n, { find, replace }] of edits.entries()) {
      const count = find ? after.split(find).length - 1 : 0;
      if (count !== 1) {
        throw new Refusal(
          `Prompt edit ${n + 1}: the text to find appears ${count} times in the current prompt.`,
          "Each edit's `find` must match the live prompt exactly once. Read it with get_agent_config and copy a longer, unique passage.",
        );
      }
      after = after.replace(find, () => replace);
    }
    if (after === before) throw new Refusal("The prompt edits change nothing.", "Check the replacement text.");
    proposal.prompt = { beforeHash: hashPayload(before), after };
    diff.push({ field: "prompt", lines: lineDiff(before, after) });
  }

  for (const { actionId, triggerPrompt } of triggers) {
    const action = agent.actions?.find((a) => a.id === actionId);
    if (!action) throw new Refusal(`Action ${actionId} is not on this agent.`, "Use an actionId from get_agent_config.");
    const params = action.actionParameters ?? {};
    if (typeof params.triggerPrompt !== "string") {
      throw new Refusal(`Action "${action.name}" (${action.actionType}) has no trigger prompt.`, "Only actions with a triggerPrompt can be changed this way.");
    }
    if (params.triggerPrompt === triggerPrompt) throw new Refusal(`The trigger prompt for "${action.name}" is unchanged.`, "Check the new text.");
    proposal.actions.push({
      actionId: action.id,
      agentId: agent.id,
      actionType: action.actionType,
      name: action.name ?? "",
      actionParameters: { ...params, triggerPrompt },
      beforeHash: hashPayload(action),
    });
    diff.push({ field: `action "${action.name}" triggerPrompt`, before: params.triggerPrompt, after: triggerPrompt });
  }

  return {
    preview: { action: `Change agent "${agent.agentName}"`, agentId: agent.id, diff, dryRun: config.dryRun },
    ...store.issue(proposal),
    next: "Show this diff to the user and wait for them to approve it. Only then call execute_confirmed with the confirmToken.",
  };
}

async function executeAgentChange(client: HighLevelClient, tool: string, p: AgentProposal) {
  // Refuse if anyone changed the agent since the preview: the diff would no longer be what gets applied.
  const agent = await getAgent(client, tool, p.agentId);
  if (p.prompt && hashPayload(agent.agentPrompt ?? "") !== p.prompt.beforeHash) {
    throw new Refusal("The agent's prompt changed after the preview.", "Propose the change again against the current prompt.");
  }
  for (const u of p.actions) {
    const current = agent.actions?.find((a) => a.id === u.actionId);
    if (!current || hashPayload(current) !== u.beforeHash) {
      throw new Refusal(`Action "${u.name}" changed after the preview.`, "Propose the change again against the current config.");
    }
  }

  const applied: string[] = [];
  const results: WriteResult[] = [];
  try {
    if (p.prompt) {
      results.push(await patchAgentPrompt(client, tool, p.agentId, p.prompt.after));
      applied.push("prompt");
    }
    for (const u of p.actions) {
      const { beforeHash: _beforeHash, ...update } = u;
      results.push(await updateAction(client, tool, update));
      applied.push(`action "${u.name}"`);
    }
  } catch (err) {
    if (err instanceof GhlApiError && applied.length) {
      throw new GhlApiError(err.operation, err.status, false, `${err.check} Applied before the failure: ${applied.join(", ")}.`, err.detail);
    }
    throw err;
  }
  return { kind: "agent_change", agentId: p.agentId, applied, dryRun: results.every((r) => r.dryRun), results: results.map(describeResult) };
}

// ---------- Execute ----------

function describeResult(r: WriteResult) {
  return r.dryRun ? { dryRun: true, wouldSend: r.request } : { dryRun: false, response: r.response };
}

export async function executeConfirmed(client: HighLevelClient, store: Store, tool: string, confirmToken: string) {
  // Consumed before anything runs: if the write fails, this token can't be used to try again.
  const proposal = store.consume(confirmToken);
  return proposal.kind === "sms" ? executeSms(client, tool, proposal) : executeAgentChange(client, tool, proposal);
}
