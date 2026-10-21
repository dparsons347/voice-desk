import { describe, expect, it } from "vitest";
import { CONFIRM_TTL_MS, ConfirmStore } from "../src/confirm.js";
import type { CallLog } from "../src/ghl/schemas.js";
import { lineDiff, smsSegments, type Proposal } from "../src/writes.js";
import { connect, fixture, parseText, testConfig } from "./helpers.js";

// Real calls: the booked caller said yes to texts; the Oct 9 callback caller said no.
const yesCall = fixture("recorded/thats-automated-booked-call.sanitized.json") as CallLog;
const [noCall] = (fixture("recorded/thats-automated-call-logs.sanitized.json") as { callLogs: CallLog[] }).callLogs;
const contact = { contact: { id: yesCall.contactId, phone: "+15555550101", firstName: "Sam", lastName: "Rivera" } };
const maya = (fixture("recorded/thats-automated-agents.sanitized.json") as { agents: any[] }).agents[0];
const callbackAction = maya.actions.find((a: any) => a.actionType === "WORKFLOW_TRIGGER");

const smsArgs = { contactId: yesCall.contactId, callId: yesCall.id, body: "Hi Sam, Daniel here. Looking forward to our call." };
const writes = (requests: { method: string }[]) => requests.filter((r) => r.method !== "GET");

function clock(start = Date.parse("2026-10-21T20:00:00Z")) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("ConfirmStore", () => {
  const sms: Proposal = { kind: "sms", contactId: "c", callId: "k", toNumber: "+1", message: "hi" };

  it("issues single-use tokens", () => {
    const store = new ConfirmStore<Proposal>();
    const { confirmToken } = store.issue(sms);
    expect(store.consume(confirmToken)).toEqual(sms);
    expect(() => store.consume(confirmToken)).toThrow(/already been used/);
  });

  it("expires tokens after 10 minutes", () => {
    const c = clock();
    const store = new ConfirmStore<Proposal>(c.now);
    const fresh = store.issue(sms).confirmToken;
    const stale = store.issue(sms).confirmToken;
    c.advance(CONFIRM_TTL_MS);
    expect(store.consume(fresh)).toEqual(sms); // exactly 10 minutes: still valid
    c.advance(1);
    expect(() => store.consume(stale)).toThrow(/expired/);
  });

  it("rejects a token whose payload hash part was altered", () => {
    const store = new ConfirmStore<Proposal>();
    const { confirmToken } = store.issue(sms);
    const other = store.issue({ ...sms, message: "different" }).confirmToken;
    const [nonce] = confirmToken.split(".");
    const [, otherHash] = other.split(".");
    expect(() => store.consume(`${nonce}.${otherHash}`)).toThrow(/does not match/);
  });

  it("rejects unknown tokens", () => {
    expect(() => new ConfirmStore<Proposal>().consume("nope.nope")).toThrow(/Unknown/);
  });
});

describe("helpers", () => {
  it("counts SMS segments", () => {
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("Hi 👋")).toBe(1);
    expect(smsSegments("👋".repeat(40))).toBe(2); // 80 UTF-16 units, non-GSM
  });

  it("diffs changed lines only", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual(["- b", "+ B", "+ d"]);
  });
});

describe("propose_followup_sms", () => {
  it("previews the text and sends nothing", async () => {
    const { mcp, requests } = await connect([{ body: yesCall }, { body: contact }]);
    const out = parseText(await mcp.callTool({ name: "propose_followup_sms", arguments: smsArgs }));
    expect(out.preview).toMatchObject({
      to: { name: "Sam Rivera", phone: "+15555550101", contactId: yesCall.contactId },
      from: "the location's default number",
      message: smsArgs.body,
      segments: 1,
      aboutCall: { callId: yesCall.id },
      consent: "SMS Consent On Call: Yes",
    });
    expect(out.confirmToken).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{16}$/);
    expect(writes(requests)).toHaveLength(0);
  });

  it("refuses when the caller said no to texts on that call", async () => {
    const { mcp } = await connect([{ body: noCall }]);
    const res = await mcp.callTool({ name: "propose_followup_sms", arguments: { ...smsArgs, contactId: noCall!.contactId, callId: noCall!.id } });
    expect(res.isError).toBe(true);
    expect(parseText(res).error).toMatch(/did not agree to texts.*"No"/);
  });

  it("refuses when the call belongs to someone else", async () => {
    const { mcp } = await connect([{ body: yesCall }]);
    const res = await mcp.callTool({ name: "propose_followup_sms", arguments: { ...smsArgs, contactId: "someoneElse" } });
    expect(parseText(res).error).toMatch(/different contact/);
  });

  it("refuses when the contact has Do Not Disturb on for texts", async () => {
    const dnd = { contact: { ...contact.contact, dndSettings: { SMS: { status: "active" } } } };
    const { mcp } = await connect([{ body: yesCall }, { body: dnd }]);
    expect(parseText(await mcp.callTool({ name: "propose_followup_sms", arguments: smsArgs })).error).toMatch(/Do Not Disturb/);
  });
});

describe("execute_confirmed: SMS", () => {
  async function proposed(after: object[], config = testConfig, extra = {}) {
    const ctx = await connect([{ body: yesCall }, { body: contact }, ...after], config, undefined, extra);
    const { confirmToken } = parseText(await ctx.mcp.callTool({ name: "propose_followup_sms", arguments: smsArgs }));
    const execute = async () => ctx.mcp.callTool({ name: "execute_confirmed", arguments: { confirmToken } });
    return { ...ctx, confirmToken, execute };
  }

  it("sends exactly the previewed text to the previewed number", async () => {
    const { execute, requests } = await proposed([{ body: contact }, { body: { conversationId: "conv1", messageId: "msg1" } }]);
    const out = parseText(await execute());
    expect(out).toMatchObject({ kind: "sms", to: "+15555550101", dryRun: false, response: { messageId: "msg1" } });
    expect(writes(requests)).toHaveLength(1);
    expect(writes(requests)[0]).toMatchObject({
      method: "POST",
      body: { type: "SMS", contactId: yesCall.contactId, toNumber: "+15555550101", message: smsArgs.body },
    });
    expect(writes(requests)[0]!.url.pathname).toBe("/conversations/messages");
  });

  it("can't be replayed", async () => {
    const { execute, requests } = await proposed([{ body: contact }, { body: { messageId: "msg1" } }]);
    await execute();
    const again = await execute();
    expect(parseText(again).error).toMatch(/already been used/);
    expect(writes(requests)).toHaveLength(1);
  });

  it("does not retry a failed write, and the token stays used", async () => {
    const { execute, requests, audit } = await proposed([{ body: contact }, { status: 503, body: { message: "unavailable" } }]);
    const res = await execute();
    expect(parseText(res)).toMatchObject({ status: 503, safeToRetry: false, check: expect.stringContaining("never retried") });
    expect(writes(requests)).toHaveLength(1);
    expect(audit.entries.filter((e) => e.method === "POST").map((e) => e.outcome)).toEqual(["failed"]);
    expect(parseText(await execute()).error).toMatch(/already been used/);
  });

  it("does not retry after a network error either", async () => {
    const { execute, requests } = await proposed([{ body: contact }, new TypeError("fetch failed")]);
    expect(parseText(await execute()).check).toMatch(/may or may not have gone through/);
    expect(writes(requests)).toHaveLength(1);
  });

  it("refuses if the contact's number changed after the preview", async () => {
    const moved = { contact: { ...contact.contact, phone: "+15555550999" } };
    const { execute, requests } = await proposed([{ body: moved }]);
    expect(parseText(await execute()).error).toMatch(/phone number changed/);
    expect(writes(requests)).toHaveLength(0);
  });

  it("refuses once the token has expired", async () => {
    const c = clock();
    const { execute, requests } = await proposed([], testConfig, { confirmStore: new ConfirmStore<Proposal>(c.now) });
    c.advance(CONFIRM_TTL_MS + 1);
    expect(parseText(await execute()).error).toMatch(/expired/);
    expect(writes(requests)).toHaveLength(0);
  });

  it("with DRY_RUN, returns the request instead of sending it", async () => {
    const { execute, requests, audit } = await proposed([{ body: contact }], { ...testConfig, dryRun: true });
    const out = parseText(await execute());
    expect(out).toMatchObject({ dryRun: true, wouldSend: { method: "POST", path: "/conversations/messages", body: { message: smsArgs.body } } });
    expect(writes(requests)).toHaveLength(0);
    expect(audit.entries.at(-1)).toMatchObject({ method: "POST", outcome: "dry_run" });
  });
});

describe("propose_agent_change and execute_confirmed", () => {
  const missingEdit = [{ find: "This passage is not in the prompt", replace: "X" }];
  const realEdit = [{ find: "Never push twice.", replace: "Never push twice, and never sound disappointed." }];

  it("previews a prompt diff and changes nothing", async () => {
    const { mcp, requests } = await connect([{ body: maya }]);
    const out = parseText(await mcp.callTool({ name: "propose_agent_change", arguments: { agentId: maya.id, promptEdits: realEdit } }));
    expect(out.preview.diff).toEqual([
      {
        field: "prompt",
        lines: [
          `- - "I'm not interested." Thank them and let them go. Never push twice.`,
          `+ - "I'm not interested." Thank them and let them go. Never push twice, and never sound disappointed.`,
        ],
      },
    ]);
    expect(writes(requests)).toHaveLength(0);
  });

  it("refuses a find that isn't in the live prompt exactly once", async () => {
    const { mcp } = await connect([{ body: maya }]);
    const missing = await mcp.callTool({ name: "propose_agent_change", arguments: { agentId: maya.id, promptEdits: missingEdit } });
    expect(parseText(missing).error).toMatch(/appears 0 times/);
    const { mcp: mcp2 } = await connect([{ body: maya }]);
    const twice = await mcp2.callTool({ name: "propose_agent_change", arguments: { agentId: maya.id, promptEdits: [{ find: "Daniel", replace: "D" }] } });
    expect(parseText(twice).error).toMatch(/appears \d+ times/);
  });

  it("applies exactly the previewed prompt", async () => {
    const { mcp, requests } = await connect([{ body: maya }, { body: maya }, { body: { id: maya.id } }]);
    const { confirmToken } = parseText(await mcp.callTool({ name: "propose_agent_change", arguments: { agentId: maya.id, promptEdits: realEdit } }));
    const out = parseText(await mcp.callTool({ name: "execute_confirmed", arguments: { confirmToken } }));
    expect(out).toMatchObject({ kind: "agent_change", applied: ["prompt"], dryRun: false });
    const [patch] = writes(requests);
    expect(patch).toMatchObject({ method: "PATCH", body: { agentPrompt: maya.agentPrompt.replace(realEdit[0]!.find, realEdit[0]!.replace) } });
    expect(Object.keys(patch!.body)).toEqual(["agentPrompt"]);
    expect(patch!.url.searchParams.get("locationId")).toBe("loc123");
  });

  it("refuses if the prompt changed after the preview", async () => {
    const edited = { ...maya, agentPrompt: maya.agentPrompt + "\nSomeone edited this." };
    const { mcp, requests } = await connect([{ body: maya }, { body: edited }]);
    const { confirmToken } = parseText(await mcp.callTool({ name: "propose_agent_change", arguments: { agentId: maya.id, promptEdits: realEdit } }));
    expect(parseText(await mcp.callTool({ name: "execute_confirmed", arguments: { confirmToken } })).error).toMatch(/changed after the preview/);
    expect(writes(requests)).toHaveLength(0);
  });

  it("updates a trigger prompt, keeping the action's other parameters", async () => {
    const triggerPrompt = "Use if booking fails twice, or the caller asks Daniel to call them.";
    const { mcp, requests } = await connect([{ body: maya }, { body: maya }, { body: { id: callbackAction.id } }]);
    const proposal = parseText(
      await mcp.callTool({ name: "propose_agent_change", arguments: { agentId: maya.id, actionTriggerPrompts: [{ actionId: callbackAction.id, triggerPrompt }] } }),
    );
    expect(proposal.preview.diff[0]).toMatchObject({ field: 'action "Request a callback from Daniel" triggerPrompt', after: triggerPrompt });
    await mcp.callTool({ name: "execute_confirmed", arguments: { confirmToken: proposal.confirmToken } });
    const [put] = writes(requests);
    expect(put!.url.pathname).toBe(`/voice-ai/actions/${callbackAction.id}`);
    expect(put).toMatchObject({
      method: "PUT",
      body: {
        agentId: maya.id,
        actionType: "WORKFLOW_TRIGGER",
        name: "Request a callback from Daniel",
        actionParameters: { ...callbackAction.actionParameters, triggerPrompt },
      },
    });
  });

  it("refuses actions that have no trigger prompt", async () => {
    const extraction = maya.actions.find((a: any) => a.name === "Save email");
    const { mcp } = await connect([{ body: maya }]);
    const res = await mcp.callTool({ name: "propose_agent_change", arguments: { agentId: maya.id, actionTriggerPrompts: [{ actionId: extraction.id, triggerPrompt: "x" }] } });
    expect(parseText(res).error).toMatch(/has no trigger prompt/);
  });

  it("reports what was applied when a later write fails", async () => {
    const { mcp, requests } = await connect([{ body: maya }, { body: maya }, { body: {} }, { status: 500, body: { message: "boom" } }]);
    const { confirmToken } = parseText(
      await mcp.callTool({
        name: "propose_agent_change",
        arguments: { agentId: maya.id, promptEdits: realEdit, actionTriggerPrompts: [{ actionId: callbackAction.id, triggerPrompt: "New trigger." }] },
      }),
    );
    const res = await mcp.callTool({ name: "execute_confirmed", arguments: { confirmToken } });
    expect(parseText(res)).toMatchObject({ status: 500, safeToRetry: false, check: expect.stringContaining("Applied before the failure: prompt.") });
    expect(writes(requests).map((r) => r.method)).toEqual(["PATCH", "PUT"]);
  });
});
