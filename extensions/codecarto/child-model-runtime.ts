// Model runtime for codecarto's child sessions (phase sub-agents, the
// next-phase rewriter, the dashboard narrator).
//
// All three child sessions load with `noExtensions: true` so a globally
// installed codecarto doesn't register its commands and tool guards twice
// inside its own sub-agent. That isolation has a side effect: providers
// registered by *other* global extensions via `pi.registerProvider()` — an
// Ollama Cloud bridge, a company gateway, any custom `streamSimple` provider —
// are registered onto the parent's ModelRuntime by the resource loader that
// loaded them. A child that builds a fresh ModelRuntime never sees them, so
// the parent's selected model resolves to a provider the child does not know,
// and the session throws `No API key found for <provider>` before its first
// turn.
//
// Carrying the parent's registered provider configs across keeps the child on
// the same model the user picked without reloading (and re-registering) the
// extensions themselves.

import { join } from "node:path";

import { type ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";

export async function createChildModelRuntime(
	ctx: ExtensionContext,
	agentDir: string,
): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});

	for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
		const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
		if (!config) continue;
		try {
			runtime.registerProvider(providerId, config);
		} catch {
			// A provider the child can't accept is not worth failing the phase
			// over: the child either doesn't need it (the user's model comes
			// from a different provider) or fails later with the provider-
			// specific error, which is more useful than one thrown here.
		}
	}

	// Recompose the provider table so the newly registered providers land in
	// the availability snapshot that `hasConfiguredAuth` reads. Offline: the
	// parent already paid for any network catalog refresh.
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}
