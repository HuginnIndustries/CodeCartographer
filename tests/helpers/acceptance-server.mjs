// Test-only launcher for the acceptance-adapter tests.
//
// Serves the REAL server (buildServer + serveStdio, the same factory path
// bin.mjs takes) over stdio, but with the @internal `acceptanceRegistry`
// option so the SUPPORTED elicitation path can be exercised against a
// scripted client. The registry comes from a JSON argument on THIS launcher's
// command line, which no production entry point reads: bin.mjs calls
// startStdioServer() with no options, and nothing consults an environment
// variable or config file for a registry.

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "../../dist/mcp-server/server.js";

const registry = process.argv[2] ? JSON.parse(process.argv[2]) : undefined;
serveStdio(() => buildServer({ acceptanceRegistry: registry }), { onerror: (error) => console.error(`test-launcher: ${error.message}`) });
