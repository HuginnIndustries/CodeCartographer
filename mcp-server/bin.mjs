#!/usr/bin/env node
// This file is shipped from dist/. It imports the compiled server.js next to
// it. Running it directly from the source tree will fail (server.js does not
// exist in source); run `npm run build` first, or use the published package.

import { startStdioServer } from "./server.js";

startStdioServer().catch((error) => {
	console.error("[codecarto-mcp] failed to start:", error);
	process.exit(1);
});
