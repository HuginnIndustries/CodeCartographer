import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { createChildModelRuntime } = await import(
	pathToFileURL(`${REPO_ROOT}/extensions/codecarto/child-model-runtime.ts`).href
);

// A provider shaped like one a global Pi extension registers via
// pi.registerProvider() — a custom api string, its own streamSimple, and an
// API key read from the environment.
const PROVIDER_ID = "probe-cloud";
const API_KEY_ENV = "CODECARTO_PROBE_API_KEY";

function providerConfig() {
	return {
		name: "Probe Cloud",
		baseUrl: "https://probe.invalid/api",
		apiKey: `$${API_KEY_ENV}`,
		api: "probe-native",
		models: [
			{
				id: "probe-1",
				name: "probe-1 (Probe Cloud)",
				api: "probe-native",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 32768,
			},
		],
		streamSimple: () => {
			throw new Error("the test never streams");
		},
	};
}

function fakeContext(config) {
	return {
		modelRegistry: {
			getRegisteredProviderIds: () => (config ? [PROVIDER_ID] : []),
			getRegisteredProviderConfig: (id) => (id === PROVIDER_ID ? config : undefined),
		},
	};
}

async function withAgentDir(run) {
	const agentDir = await mkdtemp(resolve(tmpdir(), "codecarto-child-runtime-"));
	const previous = process.env[API_KEY_ENV];
	process.env[API_KEY_ENV] = "sk-probe";
	try {
		return await run(agentDir);
	} finally {
		if (previous === undefined) delete process.env[API_KEY_ENV];
		else process.env[API_KEY_ENV] = previous;
		await rm(agentDir, { recursive: true, force: true });
	}
}

test("a child runtime inherits providers registered by the parent's extensions", async () => {
	await withAgentDir(async (agentDir) => {
		const runtime = await createChildModelRuntime(fakeContext(providerConfig()), agentDir);

		assert.equal(runtime.getProvider(PROVIDER_ID)?.name, "Probe Cloud");
		assert.equal(runtime.getModel(PROVIDER_ID, "probe-1")?.id, "probe-1");
		// hasConfiguredAuth is the exact check AgentSession.prompt() runs before
		// its first turn; a false here is the "No API key found for <provider>"
		// failure that killed phase sub-agents on extension-provided providers.
		assert.equal(runtime.hasConfiguredAuth(PROVIDER_ID), true);
	});
});

test("a runtime built without the carry-over does not know the provider", async () => {
	await withAgentDir(async (agentDir) => {
		// The pre-fix construction: a bare ModelRuntime over the same agentDir.
		// It is the control that shows carrying the configs over is what fixes
		// the child, not something the agent directory supplies on its own.
		const bare = await ModelRuntime.create({
			authPath: resolve(agentDir, "auth.json"),
			modelsPath: resolve(agentDir, "models.json"),
		});

		assert.equal(bare.getProvider(PROVIDER_ID), undefined);
		assert.equal(bare.hasConfiguredAuth(PROVIDER_ID), false);
	});
});

test("a parent with no registered providers still yields a usable child runtime", async () => {
	await withAgentDir(async (agentDir) => {
		const runtime = await createChildModelRuntime(fakeContext(undefined), agentDir);
		assert.equal(typeof runtime.hasConfiguredAuth, "function");
		assert.equal(runtime.getProvider(PROVIDER_ID), undefined);
	});
});

test("a provider config the child rejects does not fail the whole runtime", async () => {
	await withAgentDir(async (agentDir) => {
		const broken = { ...providerConfig(), models: "not-a-list" };
		const runtime = await createChildModelRuntime(fakeContext(broken), agentDir);
		assert.equal(runtime.hasConfiguredAuth(PROVIDER_ID), false);
	});
});

// Structural guard: every child AgentSession codecarto creates loads with
// noExtensions, so each one must carry the parent's registered providers or
// it cannot resolve an extension-provided model.
test("every child session codecarto creates carries the parent's provider registrations", async () => {
	const sources = ["agent-runner.ts", "agent-rewriter.ts", "dashboard-narrator.ts"];
	for (const name of sources) {
		const source = await readFile(resolve(REPO_ROOT, "extensions/codecarto", name), "utf8");
		const sessions = source.split("createAgentSession({").slice(1);
		assert.ok(sessions.length > 0, `${name} should create at least one child session`);
		for (const session of sessions) {
			const options = session.slice(0, session.indexOf("});"));
			assert.match(
				options,
				/modelRuntime: await createChildModelRuntime\(/,
				`${name} creates a child session without carrying registered providers`,
			);
		}
	}
});
