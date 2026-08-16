# Turning a deep audit into rewrite guidance

Use this when the run exists to decide *how to rebuild or refactor* something, not merely to describe it. It assumes a pipeline with defect scans — `full-with-audit` or `full-with-deep-audit`.

If the user expected defect findings and none appeared, check the active variant first: `full` has no defect phases at all.

## Defect scans are contract inputs, not an appendix

The common failure is treating defect reports as a separate document that the porting and spec phases summarize politely and move past. They are inputs to those phases' actual decisions. Every defect should reach the porting bundle carrying an explicit disposition:

| Disposition | Means | Consequence for the port |
|---|---|---|
| `fix before porting` | the defect would be reproduced by a faithful port | design it out; the spec states the correct behavior |
| `port differently` | the behavior is needed but the mechanism is wrong | spec the intent, not the implementation |
| `leave behind` | dead, vestigial, or actively harmful | name it explicitly so a later reader doesn't "restore" it |

Add the acceptance-test implication alongside each row. A hazard with no test in the spec will be reintroduced by whoever implements it.

Close a carry-forward item only once its guidance is represented in an artifact a later phase actually consumes — not merely mentioned in the phase that raised it.

## Convert hazards into normative rules

In the final spec, a defect becomes a rule plus a black-box scenario. "The old code had a race in session writes" is an observation; "session writes MUST be atomic: temp file, fsync, same-filesystem rename, sidecars after the primary file — verified by a crash-injection test" is a contract.

Hazards worth checking for in agent-like or CLI tools, drawn from real deep-audit runs. Treat as prompts, not a checklist to assert blindly:

- non-atomic session, checkpoint, or index writes
- record parsing that keys on substring detection rather than a schema discriminator
- JSON-RPC responses not correlated by `id`, so an out-of-order reply satisfies the wrong request
- subprocess `stdout`/`stderr` piped but not drained concurrently, deadlocking on a full pipe
- timeouts that log but never kill the process tree
- shell interpolation of externally supplied variables in hook or plugin execution
- background process features with no ownership, cleanup, readiness, or recovery semantics
- config validation that cannot distinguish an absent value from an explicit zero, or that skips range checks
- config fields parsed and then never read — each needs an implement / remove / deprecate decision
- permission checks bypassed by a second read path that loses provenance
- stream reducers that early-`continue` after one field kind and silently drop others in the same event

## Preserve behavior, not bugs

Preserve observable behavior as tests and contracts. Do not clone an accidental bug unless something external depends on it — and when it does, say so explicitly and mark it as compatibility-significant rather than letting it look like good design.

## Reporting

Separate these when reporting, and lead with the recommendation rather than the narrative:

- what the pipeline completed and validated
- the high-signal defects that actually shape the rewrite
- the recommended build sequence
- what must be preserved exactly
- what to fix rather than copy
- what remains open

See `kernel-first-rewrite.md` for the build sequence this feeds.
