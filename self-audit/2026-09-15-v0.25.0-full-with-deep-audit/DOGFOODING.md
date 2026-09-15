# Dogfooding notes — what the run showed about the framework

Observations about CodeCartographer itself, made while driving this run; none of them is a
finding *of* the run (those are in `REVIEW.md`).

## Model choice is the coverage knob

The seed on `glm-5.3-flash` returned in three minutes with a `PASS WITH GAPS` map whose
coverage section honestly listed the module bodies it had not read (`core/broadside/`
"enumerated by export", `completion`, `prompts`, `library`, `synthesis`, `dashboard`,
`amendment`, `findings` "skipped"). `deepseek-v4.1-flash` on the same phase took eight
minutes and 5.8M input tokens and read the full `core/` set, seven of fourteen
`core/broadside/` modules in full, both wrappers end to end, and every pipeline YAML —
coverage `COMPLETE`. The validation table cannot tell the two apart (both `PASS`); the
**coverage disposition** can, and it is the line to read before trusting a map. A flash
model is a fine way to size a run and a poor way to audit one.

## The 1M-token context changed the shape of the run

Zero compactions across seven phases and 50M input tokens. The previous self-audit
(2026-09-11, Claude Fable 5.1 through MCP, 272K context) leaned on the phase-compaction
hook; this one never triggered it, though the hook still wrote periodic checkpoints for
three phases. The defect phases re-read large modules many times (`collect.ts` alone is
750 lines) — 11.5M input tokens for the mechanical scan is mostly re-reading, which a
bigger window makes cheap and a smaller one makes lossy.

## Driving the run headlessly on the repository itself

- `/codecarto-init` asks a confirm when `.codecarto/` already exists, and the repository
  *is* a `.codecarto/` (the template). Under `pi -p` the confirm stub answers no, silently.
  `/codecarto-open` followed by `/codecarto-switch-pipeline <alias>` is the path, and it is
  what the previous audit did through MCP (`codecarto_open`).
- The template's `status.yaml` ships with `project_name: ""`; on open the framework filled
  it from the directory name, so the worktree's `selfreview` became the project name and the
  dashboard title. Renaming it in `status.yaml` and re-rendering fixed the hero image; a
  workspace opened in a scratch checkout should probably take the name from `package.json`
  or the git remote before the directory.
- `pi -ne` (no extension discovery, used so the packed or in-tree extension is the only
  CodeCartographer loaded) also drops user provider extensions; `ollama-cloud` had to be
  passed with a second `-e`. Without it every `--model` pattern fails with "No models match".
- The LLM rewriter reports "skipped (no previous phase to steer from)" on the first phase.
  Expected, but the warning level makes a clean run look as if something went wrong.
- The end-of-run line now carries the stop reason (#347); it was not exercised — nothing
  stopped.

## The template shaped the output well

- Every report carries a `## Coverage and limits` section with the four fixed labels and a
  disposition, and the two defect scans put file:line evidence on every row; the previous
  audit's DOGFOODING note that "prompts left the host guessing" did not recur.
- The routed items worked as designed: the architecture phase routed four carry-forwards
  (`cf-arch-1..4`), the mechanical scan closed `cf-arch-4` and routed three of its own to the
  semantic scan (`cfs-mech-1..3`), and the semantic scan closed all three with the finding
  that resolved each. Nothing dangled.
- The per-pass defect files (`findings/defect-scan/passes/0N-*.md`) land under the legacy
  `defect-scan/` folder even in the split mechanical/semantic pipeline; that is what the two
  skills instruct, and it works, but a reader of the folder tree will look for them under
  the phase that wrote them.
- Seven open questions and twelve post-pipeline items came out, every one of them a
  runtime or fixture question the code cannot settle (Windows filesystem semantics, the live
  OpenRouter Batch contract, Pi runtime behaviour, tarball–template parity). That is the
  right shape for an audit that could not run a probe.

## What the run could not do

The tool-call hook blocks `bash` in phase sessions, so the 2026-09-11 audit's runtime probes
have no counterpart here; the semantic report's `## Runtime probes` section proposes them
instead. The five `verify at runtime` rows (four Windows claims and a symlink-swap window)
are therefore filed as one CI request (#372) rather than as defects.
