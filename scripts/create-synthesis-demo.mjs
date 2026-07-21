#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { publishEntry, writeMarker } from "../dist/core/index.js";
import { handleInit } from "../dist/mcp-server/server.js";

const requestedTarget = process.argv[2];
if (requestedTarget && !isAbsolute(requestedTarget)) {
	console.error("Optional target path must be absolute.");
	process.exit(2);
}

const root = requestedTarget
	? resolve(requestedTarget)
	: join(tmpdir(), `codecarto-synthesis-demo-${Date.now()}`);
const library = join(root, "library");
const workspace = join(root, "workspace");

await mkdir(root, { recursive: false }).catch((error) => {
	if (error?.code === "EEXIST") {
		throw new Error(`Refusing to overwrite existing demo target: ${root}`);
	}
	throw error;
});

await writeMarker(library, {
	schema_version: 1,
	name: "Build Week synthesis demo",
	visibility: "public",
	created_at: new Date().toISOString(),
	namespaced: false,
});

const generation = {
	surface: "mcp-server",
	agent: "demo-fixture",
	agent_version: "1",
	model: "fixture",
	model_vendor: "unknown",
	reasoning: "unknown",
	notes: "Small public sample created by npm run demo:synthesis.",
};

await publishEntry(library, eventRouterSpec(), {
	slug: "event-router",
	source_repo: "https://example.invalid/event-router",
	analyzed_at: new Date().toISOString(),
	pipeline: "workflow/pipeline-full-with-deep-audit.yaml",
	codecarto_version: "0.12.0-dev",
	headline: "Tenant-isolated event routing with replay-safe delivery.",
	tags: ["events", "multi-tenant", "reliability"],
	capabilities: ["tenant isolation", "idempotent delivery", "dead-letter recovery"],
	confidentiality: "public",
	generation,
});

await publishEntry(library, auditConsoleSpec(), {
	slug: "audit-console",
	source_repo: "https://example.invalid/audit-console",
	analyzed_at: new Date().toISOString(),
	pipeline: "workflow/pipeline-full-with-deep-audit.yaml",
	codecarto_version: "0.12.0-dev",
	headline: "Operator console with immutable audit trails and role-scoped actions.",
	tags: ["operations", "audit", "rbac"],
	capabilities: ["immutable audit trail", "role-scoped actions", "incident review"],
	confidentiality: "public",
	generation,
});

await mkdir(workspace, { recursive: true });
await handleInit({ cwd: workspace, pipeline: "synthesis" });
await writeFile(
	join(workspace, ".codecarto", "workflow", "config.yaml"),
	[
		"orchestrator:",
		"  llm_steer_next_phase: false",
		"library:",
		`  path: ${JSON.stringify(library)}`,
		"  namespace: null",
		"  publish_confirm: true",
		"",
	].join("\n"),
	"utf8",
);
await writeFile(
	join(workspace, ".codecarto", "inputs", "vision.md"),
	[
		"# Incident Relay vision",
		"",
		"Build an internal tool for platform teams that receives production incidents, routes each event to the correct tenant response team, and gives operators a trustworthy review console.",
		"",
		"The first release must prevent cross-tenant disclosure, tolerate duplicate delivery, record every operator action, and let an incident commander recover failed events. A public consumer UI and automated remediation are non-goals.",
		"",
	].join("\n"),
	"utf8",
);

console.log("CodeCartographer synthesis demo created.");
console.log(`DEMO_ROOT=${root}`);
console.log(`DEMO_LIBRARY=${library}`);
console.log(`DEMO_WORKSPACE=${workspace}`);
console.log("");
console.log("Run Pi from DEMO_WORKSPACE with this repository's extension, then:");
console.log("  /codecarto-open");
console.log("  /codecarto-next --auto");
console.log("Review .codecarto/findings/goal-synthesis/proposal.md and change chosen [ ] boxes to [x], then:");
console.log("  /codecarto-next --auto");

function eventRouterSpec() {
	return `# Event Router Reimplementation Spec

## System Summary
Routes tenant-scoped events to subscribed workers while preserving isolation and replay safety.

## Required Behaviors
- A tenant identifier is mandatory and validated before routing.
- Delivery uses an idempotency key; replaying the same event does not duplicate side effects.
- Exhausted retries move the event to a tenant-scoped dead-letter queue.

## Invariants
- An event is never observable by a worker belonging to another tenant.
- Acknowledgement is recorded only after the worker's durable side effect succeeds.

## Acceptance Scenarios
1. Re-send one event with the same idempotency key; exactly one side effect is observed.
2. Route events for two tenants; each worker sees only its tenant's events.
`;
}

function auditConsoleSpec() {
	return `# Audit Console Reimplementation Spec

## System Summary
Provides operators a role-scoped console backed by an immutable action journal.

## Required Behaviors
- Every state-changing operator action records actor, role, target, timestamp, reason, and outcome.
- Viewers may inspect incidents; responders may retry; commanders may close incidents.
- Historical journal records are append-only and exportable for review.

## Invariants
- Authorization is checked server-side for every action.
- Journal entries cannot be edited or deleted through the application surface.

## Acceptance Scenarios
1. A viewer attempts a retry and receives a denial with no incident mutation.
2. A commander retries an event and both the request and outcome appear in the journal.
`;
}
