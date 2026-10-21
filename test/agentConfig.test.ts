import { describe, expect, it } from "vitest";
import { connect, fixture, parseText, testConfig } from "./helpers.js";

const list = fixture("recorded/thats-automated-agents.sanitized.json") as { agents: any[] };
const maya = list.agents[0];
// Maya's real ids, so the outcome mapping is checked against her actual config.
const config = {
  ...testConfig,
  outcomeRules: { ...testConfig.outcomeRules, bookingCalendarIds: ["tJ8ERLSWKtrvOFpkaPRH"] },
};

describe("get_agent_config", () => {
  it("returns prompt, greeting and actions with trigger prompts for one agent", async () => {
    const { mcp, requests } = await connect([{ body: maya }], config);
    const out = parseText(await mcp.callTool({ name: "get_agent_config", arguments: { agentId: maya.id } }));
    expect(requests[0]!.url.pathname).toBe(`/voice-ai/agents/${maya.id}`);
    expect(requests[0]!.url.searchParams.get("locationId")).toBe("loc123");
    const [agent] = out.agents;
    expect(agent).toMatchObject({ name: "Maya", inboundNumbers: ["+13345390331"], greeting: expect.stringContaining("this is Maya") });
    expect(agent.prompt).toContain("Never tell a caller they are booked");
    expect(agent.actions).toHaveLength(13);
    expect(agent.actions.find((a: any) => a.type === "WORKFLOW_TRIGGER")).toMatchObject({
      name: "Request a callback from Daniel",
      triggerPrompt: expect.stringContaining("Use if booking fails"),
      details: { workflowId: "f6112a6d-9ffe-42be-a64a-20179f71e588" },
      voiceDeskCountsAs: "callback_requested",
    });
  });

  it("says how voice-desk counts each action, and flags a booking calendar it isn't checking", async () => {
    const { mcp } = await connect([{ body: maya }], config);
    const actions = parseText(await mcp.callTool({ name: "get_agent_config", arguments: { agentId: maya.id } })).agents[0].actions;
    expect(actions.find((a: any) => a.type === "APPOINTMENT_BOOKING").voiceDeskCountsAs).toBe("booked (verified against this calendar)");
    expect(actions.find((a: any) => a.name === "Save email")).toMatchObject({ voiceDeskCountsAs: null, description: expect.stringContaining("email") });

    const { mcp: mcp2 } = await connect([{ body: maya }], testConfig); // calendar not configured
    const unchecked = parseText(await mcp2.callTool({ name: "get_agent_config", arguments: { agentId: maya.id } })).agents[0].actions;
    expect(unchecked.find((a: any) => a.type === "APPOINTMENT_BOOKING").voiceDeskCountsAs).toMatch(/will be missed/);
  });

  it("lists every agent when agentId is omitted", async () => {
    const { mcp, requests } = await connect([{ body: list }], config);
    const out = parseText(await mcp.callTool({ name: "get_agent_config", arguments: {} }));
    expect(requests[0]!.url.pathname).toBe("/voice-ai/agents");
    expect(out.agents.map((a: any) => a.name)).toEqual(["Maya"]);
  });

  it("rejects ids that could alter the request path", async () => {
    const { mcp, requests } = await connect([], config);
    const res = await mcp.callTool({ name: "get_agent_config", arguments: { agentId: "../calendars" } });
    expect(res.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });
});
