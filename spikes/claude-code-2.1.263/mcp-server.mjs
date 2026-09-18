// Disposable spike MCP server. Not production code. Logs what the client
// declares and what elicitInput returns.
import { appendFileSync } from "node:fs";
import { Server } from "$CODECARTO_REPO/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js";
import { StdioServerTransport } from "$CODECARTO_REPO/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "$CODECARTO_REPO/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js";
const LOG = "$SPIKE_ROOT/mcp.log";
const log = (o) => appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");
const server = new Server({ name: "codecarto-spike", version: "0.0.0" }, { capabilities: { tools: {} } });
server.oninitialized = () => log({ event: "initialized", clientVersion: server.getClientVersion(), clientCapabilities: server.getClientCapabilities() });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ask_decision", description: "Asks the person at the client for an accept/reject decision via MCP elicitation and returns exactly what came back.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "ask_decision") throw new Error("unknown tool");
  const caps = server.getClientCapabilities();
  let result;
  try {
    result = await server.elicitInput({ message: "SPIKE: accept or reject this candidate? (nonce 0123456789abcdef)", requestedSchema: { type: "object", properties: { decision: { type: "string", enum: ["accept", "reject"], title: "Decision" }, note: { type: "string", title: "Note" } }, required: ["decision"] } });
  } catch (e) { result = { threw: String(e?.message ?? e) }; }
  log({ event: "elicit", clientCapabilities: caps, result });
  return { content: [{ type: "text", text: JSON.stringify({ clientCapabilities: caps, result }) }] };
});
await server.connect(new StdioServerTransport());
