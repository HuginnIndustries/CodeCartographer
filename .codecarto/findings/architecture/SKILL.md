---
name: map-project-architecture
description: Map a repository into layers, package boundaries, entrypoints, dependency direction, and shared abstractions. Use when you need to understand an unfamiliar codebase before porting, auditing, decomposing, or reimplementing it in another language, especially for monorepos, CLIs, SDKs, and multi-surface products.
---

# Map Project Architecture

Build the map before analyzing implementation details.

Read the structural sources first:
- Root README and contribution docs.
- Root package/workspace manifest and top-level scripts.
- Package or module READMEs.
- Package manifests, `bin` entries, `exports`, and top-level entrypoints.

For a monorepo, create a package inventory with these columns:
- package or module name
- purpose
- public entrypoints
- key dependencies
- runtime surface
- likely ownership category

Classify each package or major module into one primary role:
- `core semantics`
- `protocol or normalization layer`
- `persistence or state`
- `UI or rendering`
- `integration adapter`
- `product shell`

Trace dependency direction instead of reading everything in file order:
- Identify what depends on what.
- Find the lowest stable layer that nothing inside the repo depends on.
- Call out cycles explicitly.
- Mark packages that are wrappers around shared internals rather than unique systems.

Identify public surfaces early:
- binaries and CLI commands
- exported libraries and public types
- network or RPC interfaces
- file formats and persistent artifacts
- user-facing screens or workflows

Record the project's durable state:
- config files
- environment variables
- auth material
- session files
- logs
- caches
- databases
- generated artifacts

Treat third-party SDKs as shaping forces, not architecture:
- Note where vendor APIs, terminal behavior, Slack, browser APIs, or cloud services impose constraints.
- Do not let those constraints define the port's module boundaries unless the behavior truly depends on them.

Document the build and packaging pipeline:
- Build tool(s) and scripts (make, npm, cargo, gradle, etc.).
- Multi-target or multi-stage builds.
- Output artifacts: binaries, containers, packages, bundles.
- CI/CD pipeline if visible from repo files (.github/workflows, Jenkinsfile, etc.).
- Platform-specific packaging or distribution.
- If the build pipeline is complex, use the secondary output at `findings/build-and-deploy/build-and-deploy.md`.

Document the concurrency model:
- Threading model: single-threaded, thread pool, async/await, actor model, goroutines, etc.
- Event loop or reactor pattern, if present.
- Shared state and synchronization primitives.
- Connection pooling and resource management.
- Rate limiting or backpressure mechanisms.
- Mark concurrency-related portability hazards explicitly — these rarely translate 1:1 across languages.

Write the output in eight sections:
1. `System intent`
2. `Layer map`
3. `Public surfaces`
4. `Runtime lifecycle`
5. `Concurrency model`
6. `Build and packaging`
7. `Porting priorities`
8. `Agent addressability`

Then assess **agent addressability** — one row per public surface or runtime concern, in the `Agent Addressability` table. Answer three questions, and tag each row with an evidence level exactly as you tag every other conclusion:
- Does the core behavior run headlessly (no display, device, or human)?
- Can an agent inspect or set the state that matters (files, database, env, API) instead of inferring it from a screen?
- Is there a programmatic seam — a test entry point, CLI, RPC, or library call — that reaches the behavior directly?

A missing seam is a portability hazard to record, not evidence of correctness: a system that cannot be observed headlessly is not thereby known to work. This assessment is a description of what exists. It is not a request to add seams, and it does not require or propose an architectural rewrite to satisfy the checklist — record the gap and what it blocks, and let the planning phase decide what to do about it.

Mark every conclusion with one of these evidence levels:
- `observed fact`: direct statement from docs, tests, schemas, types, or code.
- `strong inference`: architectural conclusion drawn from multiple facts.
- `external-behavior claim`: a claim about what a system outside this source tree does (a server, engine, driver, third-party API, OS); unverifiable by reading this code, so it stays unsettled until a runtime probe or that system's own source confirms it.
- `portability hazard`: assumption tied to the source language, runtime, terminal, OS, or third-party SDKs.
- `open question`: missing or conflicting behavior that still needs evidence.

Test for common structural patterns:
- shared provider or protocol layer
- shared stateful agent or execution loop
- multiple delivery surfaces on top
- product-specific wrappers around a shared core
- plugin or extension architecture
- microservice or monorepo with service boundaries

Stop once the map is stable enough to explain where behavior lives. Only then move to contracts, protocols, or deep source reading.

Use the output template at `templates/architecture-map.md`.

The source code to analyze is in the parent directory (`../` relative to `.codecarto/`). This is the repository root.
