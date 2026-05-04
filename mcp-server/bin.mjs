#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning
import { startStdioServer } from "./server.ts";

startStdioServer().catch((error) => {
	console.error("[codecarto-mcp] failed to start:", error);
	process.exit(1);
});
