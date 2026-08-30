# Broad-Side Scout

Distills a completed Broad-Side batch reconnaissance run into a routing brief.
Runs first, before architecture, in the `pipeline-scout-first` workflow.

**Primary output:** `scout-brief.md`

**Depends on:** nothing in the pipeline. It reads what a prior
`/codecarto-broadside` (Pi) or `codecarto_broadside` (MCP) run wrote under
`broadside/<run>/`. It never submits a batch and never spends; with no run on
disk it produces an explicitly empty brief and the pipeline proceeds.

**Consumed by:** architecture, defect-scan-mechanical, contracts, protocols,
defect-scan-semantic, and porting, each of which must account for the leads
routed to it at validation. `reimplementation-spec` deliberately does not read
it — the porting bundle is that phase's compression boundary.

Everything in the brief is an unverified scouting lead. No phase may cite it,
or any file under `broadside/`, as a source. See `SKILL.md`, and
`broadside/SKILL.md` for how to read the underlying run.
