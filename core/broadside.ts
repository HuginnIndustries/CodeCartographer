// Broad-Side: cheap batch reconnaissance over the OpenRouter Batch API.
//
// Broad-Side fires every analysis lens at a repository at once. Each lens is a
// single-turn prompt with a structured-output JSON schema, submitted as an
// asynchronous batch job (Google Gemini's batch endpoint, ~50% of sync pricing)
// and polled to completion. Results land in `.codecarto/broadside/<run>/` as
// JSON plus rendered markdown, and an optional synthesis pass cross-references
// every lens into one executive report.
//
// This is deliberately NOT the interactive CodeCartographer pipeline. The batch
// API is text-in/text-out: no filesystem access, no multi-turn exploration, no
// runtime verification. Broad-Side findings are unverified scouting signals —
// file:line leads that a real analysis (or a human) must confirm. That division
// of labor is the point: a ~$0.50 unattended sweep that tells the expensive
// interactive run where to look.
//
// Field shapes for the model catalog and benchmarks endpoints follow the
// official OpenRouter skills (OpenRouterTeam/skills: openrouter-models,
// openrouter-benchmarks).
//
// RESUBMISSION INVARIANT: batch requests are pure functions of their input —
// no tools, no filesystem, no side effects — so resubmitting a failed or
// truncated slice is always safe. This is the retry rule OpenRouter's own
// headless-agent scaffold states the hard way (retry only before tool calls,
// because replaying a mutating tool would double-execute it); here the rule is
// satisfied by construction. If Broad-Side ever gains server tools
// (openrouter:web_search etc.), this invariant becomes load-bearing and the
// resubmit path must gate on whether any tool executed.
//
// Broad-Side requires runtime code, so the feature itself lives on the
// executable surfaces (Pi and MCP), not the pure template. What the template does
// carry is the reading guide for its output — `.codecarto/broadside/SKILL.md`,
// served by codecarto_skill under the name `broadside` (see readBroadsideSkill).
//
// The implementation lives in core/broadside/ (#339), one module per concern,
// with an acyclic import graph at runtime: constants → types → schemas →
// lenses → repo → requests → state / models / client → submit → results →
// verify → collect → render. This file is the barrel; `core/index.ts`
// re-exports it, so both surfaces and the tests import one module.

export * from "./broadside/constants.ts";
export * from "./broadside/types.ts";
export * from "./broadside/schemas.ts";
export * from "./broadside/lenses.ts";
export * from "./broadside/repo.ts";
export * from "./broadside/requests.ts";
export * from "./broadside/state.ts";
export * from "./broadside/models.ts";
export * from "./broadside/client.ts";
export * from "./broadside/submit.ts";
export * from "./broadside/results.ts";
export * from "./broadside/verify.ts";
export * from "./broadside/collect.ts";
export * from "./broadside/render.ts";
