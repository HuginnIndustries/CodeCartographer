# Kernel-first rewrite shape

A pattern for the `reimplementation-spec` phase when the goal is the least error-prone path to a replacement rather than a clone. It has held up on agent-like CLI tools; the reasoning generalizes to any system with a small semantic core and a wide adapter surface.

## Classify the strategic assumptions first

Before writing the spec, state which of these the user has actually committed to. Guessing produces a spec that is wrong in a way nobody notices until implementation.

- **Platform** — is a specific OS or runtime assumed? If so, record which primitives the MVP may rely on (atomic rename, fsync, process groups, a POSIX shell).
- **Architecture inspiration** — if the user pointed at another project, is it shape-only inspiration or a behavior contract? Default to shape-only unless they said otherwise.
- **Stack lock** — if the language and runtime are not chosen, keep the spec language-agnostic *even when the platform is fixed*. Use the opinionated template only when stack, project identity, module names, and toolchain are all committed.
- **Build order** — kernel-first with fake-driven acceptance tests, or something the user prefers instead.

Record the chosen variant in the spec front matter and the validation block, so a later opinionated re-run is traceable.

## Rings

Frame the replacement as rings, innermost first. This keeps high-risk surface out of the MVP while preserving the seams it will later attach to.

1. **Kernel** — the semantic core. For an agent tool: the loop, stream reduction, loop-detection, tool planning and execution, the permission decision, context-pressure policy.
2. **Ports** — the interfaces the kernel talks through: provider stream, tool registry, persistence, permission prompt, event sink, clock and randomness, process execution.
3. **Adapters** — concrete implementations of those ports: a specific provider API, filesystem persistence, a terminal renderer, a subprocess runner.
4. **Extensions** — everything optional: MCP, LSP, hooks, background execution, subagents, memory, plan modes.
5. **Delivery modes** — interactive, one-shot print, RPC, embedded SDK.

The kernel must be buildable and testable without any ring above it. If it isn't, the boundary is in the wrong place.

## Acceptance harness before adapters

The first implementation artifact is a deterministic harness, not a working product:

- a fake provider yielding scripted stream events, including malformed and mixed-field ones;
- fake tools with deterministic success, error, crash, and cancel outcomes;
- a fake permission prompt;
- temp-directory persistence fixtures;
- black-box tests for turn lifecycle, tool pipeline ordering, loop-break semantics, atomic persistence, config validation, cancellation, and stream reduction.

Real providers, UI, and extensions come only after that harness is green. Every "do not clone" hazard from `deep-audit-synthesis.md` should appear here as a named test.

## Milestone ordering

Small, independently reviewable slices, each one commit with its tests. An order that has worked:

1. tool pipeline result contract and failure semantics
2. crash-safe durable persistence
3. capability-based permission kernel
4. minimal deterministic input-schema validation
5. provider abstraction, proven against the fake streaming provider
6. loop orchestration over fake provider and fake tools
7. real adapters, only once the seams above are proven

Stop after a coherent slice rather than stacking changes past the point of reviewability. For schema validation specifically, start with a deliberately small subset — root object, properties, required, primitive types, `additionalProperties: false`, and failing cleanly on a malformed schema — and extend only when a contract demands it.

## What kernel-first is not

It is not a reduced scope or a prototype. It is the safest route to a *full* replacement: the parts most likely to be subtly wrong get built first, in isolation, under deterministic tests, before anything depends on them.
