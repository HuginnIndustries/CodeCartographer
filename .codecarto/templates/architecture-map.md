# Architecture Map

<!--
  Output template for the architecture phase.
  Fill in each section. Remove placeholder text. Keep the section headers.
  Mark every conclusion as: fact / strong inference / open question.
-->

## System Intent

<!-- One paragraph: what does this system do, who is it for, and what problem does it solve? -->

## Layer Map

<!--
  List each layer, package, or module. For each:
  - Name
  - Role (core semantics / protocol or normalization / persistence or state / UI or rendering / integration adapter / product shell)
  - Key responsibilities
  - What it depends on
  - What depends on it

  Call out dependency cycles explicitly.
  Mark packages that are wrappers around shared internals.
-->

### Package Inventory

| Package / Module | Role | Public Entrypoints | Key Dependencies | Runtime Surface |
|---|---|---|---|---|
| | | | | |

### Dependency Direction

<!-- Describe the dependency graph. Which layer is the stable base? Where do cycles exist? -->

## Public Surfaces

<!--
  List every boundary the outside world touches:
  - Binaries and CLI commands
  - Exported libraries and public types
  - Network or RPC interfaces
  - File formats and persistent artifacts
  - User-facing screens or workflows
-->

## Runtime Lifecycle

<!--
  How does the system start, run, and stop?
  - Boot sequence
  - Main event loop or request handling
  - Shutdown and cleanup
  - Background tasks or scheduled work
-->

## Concurrency Model

<!--
  How does the system handle concurrent work?
  - Threading model (single-threaded, thread pool, async/await, actor model, goroutines)
  - Event loop or reactor pattern
  - Shared state and synchronization (locks, channels, atomic operations)
  - Connection pooling and resource management
  - Rate limiting or backpressure mechanisms
  - Performance-critical paths and known bottlenecks

  Mark portability hazards: concurrency models rarely translate 1:1 across languages.
-->

## Build and Packaging

<!--
  How is the system built and distributed?
  - Build tool(s) and build scripts
  - Multi-stage or multi-target builds
  - Output artifacts (binaries, containers, packages, bundles)
  - CI/CD pipeline (if visible from repo)
  - Platform-specific packaging (npm, pip, cargo, Docker, etc.)

  If the build pipeline is complex, write detailed notes to the secondary output
  at findings/build-and-deploy/build-and-deploy.md instead.
-->

## Porting Priorities

<!--
  Which parts matter most for a reimplementation?
  - core: required for the system to function
  - important: required for parity on major workflows
  - optional: valuable but not needed for first viable port
  - incidental: source-specific ergonomics
-->

| Component | Priority | Rationale |
|---|---|---|
| | | |

## Durable State

<!--
  Config files, environment variables, auth material, session files,
  logs, caches, databases, generated artifacts.
-->

## Open Questions

<!-- Items that are still genuinely unknown — need a runtime test, maintainer decision, or spec ruling.
     NOT items deferred to a later phase in this pipeline (those go in Carry-Forward).
     Each entry: { id, kind, description, deferred_reason }. See workflow/status.yaml schema. -->

| ID | Kind | Description | Deferred Reason |
|---|---|---|---|
| | | | |

## Carry-Forward

<!-- Items deferred to a specific later phase whose rubric is the right place to close them.
     Each entry: { id, kind: defer-to-phase, target_phase, description, deferred_reason }.
     Mirror these into workflow/status.yaml under this phase's carry_forward list. -->

| ID | Target Phase | Description | Deferred Reason |
|---|---|---|---|
| | | | |

---

## Validation

<!-- Fill in this table per workflow/VALIDATE.md. The rows below match the full pipeline.
     Adjust rows to match your active pipeline's completion_criteria if using a variant. -->

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | The system intent is documented. | PASS / PARTIAL / FAIL | |
| 2 | The layer map and dependency direction are documented. | PASS / PARTIAL / FAIL | |
| 3 | Public surfaces are identified. | PASS / PARTIAL / FAIL | |
| 4 | Runtime lifecycle, concurrency model, and porting priorities are summarized. | PASS / PARTIAL / FAIL | |
| 5 | Findings are marked with evidence levels. | PASS / PARTIAL / FAIL | |

**Validated by:** [session identifier or date]
**Overall:** PASS / PASS WITH GAPS / FAIL
