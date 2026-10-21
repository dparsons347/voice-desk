// Spawns the built server over stdio, as Claude Desktop does, and calls ping.
// Usage: npm run build && npm run smoke
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PROJECT_ROOT } from "../src/config.js";

const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(PROJECT_ROOT, "dist/index.js")], stderr: "inherit" });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);
console.log("instructions:", client.getInstructions());
console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
console.log("ping:", JSON.stringify(await client.callTool({ name: "ping", arguments: {} }), null, 2));
console.log("list_calls:", JSON.stringify(await client.callTool({ name: "list_calls", arguments: { since: "2026-10-14" } }), null, 2));
await client.close();
