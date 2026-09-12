# Self-review prompt

A prompt for running CodeCartographer's full deep-audit pipeline on CodeCartographer itself, driven by a host LLM over MCP. It produces two things: an engineering review of the codebase, and a first-hand account of what it is like to drive the product — which is where the framework's own bugs tend to come from (#211, #212, #216 all began as a model doing exactly this).

## When to run it

Every so often — after a run of releases, before a large refactor, or whenever the phase prompts or handoff contract have changed. It is a spend, not a check: the seven phases each read most of `core/`, `extensions/`, `mcp-server/`, `tests/` and `scripts/`, so expect several million tokens and a few hours wall-clock. Budget accordingly and pick the model deliberately.

## How to run it

1. Open a **fresh** Claude Code session at the repo root. Fresh matters: an existing session's MCP server was spawned at that session's start and may be running an older `codecarto-mcp` than the one installed. Confirm the installed server is current first (`npm install -g codecartographer-pi@latest`).
2. Choose the model in the app's selector.
3. Paste the prompt below.

The pipeline is resumable. `status.yaml` in the scratch clone is the checkpoint, so a session that fills its context mid-run ends cleanly and the next one continues with `codecarto_open` then `codecarto_status`. The prompt says so; do not fight it by trimming phases.

## What it deliberately does not cover

The pipeline analyzes source *outside* `.codecarto/`. This repo's `.codecarto/` is the packaged template — prompts, pipelines, skills — and it doubles as the run's own workspace, so its content is not under review. This is a code review, not a prompt review.

## The prompt

```
Run CodeCartographer on itself — the full deep-audit pipeline — and report what it finds.

Setup — a scratch clone, never the working checkout:
  git clone --depth 1 https://github.com/HuginnIndustries/CodeCartographer ~/scratch/codecarto-self
Everything below happens in that directory. Never push from it. The repo's own .codecarto/
is the packaged template, so on a clone it is already a valid workspace — do NOT run
codecarto_init and do NOT pass force.

Drive it as the MCP host, exactly per the guide:
1. Call codecarto_guide and read it before anything else.
2. codecarto_open with cwd=<the clone>.
3. Do NOT switch pipelines — the clone's status.yaml already selects full-with-deep-audit.
   Confirm with codecarto_status: seven phases, architecture first.
4. Loop until codecarto_status reports the pipeline complete:
   codecarto_next → read the prompt and every required_read it names → do the phase
   yourself (read the code, write the primary output with its ## Validation table and a
   **Overall:** line, write the handoff to .codecarto/scratch/handoffs/<phase>.yaml) →
   codecarto_validate → codecarto_complete.
   Block scalars (|-, >-) are fine in the handoff, including inside lists. Never edit
   workflow/status.yaml, closeouts/, or THREAD_LOG.md directly. PASS WITH GAPS is
   acceptable — route the gaps through the handoff and continue.
5. Do not run codecarto_broadside. The repo is small enough to read and Broad-Side
   spends real money.
6. Run all seven phases. Context will fill before you finish; that is expected. When it
   does, stop cleanly after a codecarto_complete, and say so — the next session resumes
   with codecarto_open then codecarto_status and picks up where you left off. Do not
   rush a phase to fit it in, and do not skip a phase's required reads to save room.

Scope you should state up front in your report: the pipeline analyzes source *outside*
.codecarto/, so core/, extensions/, mcp-server/, tests/, scripts/ are under review and
the .codecarto/ template content (prompts, pipelines, skills) is not.

Deliver two things back in chat once the pipeline is complete (or at the end of each
session, for whatever completed):

A. The review. Read it from findings/porting/reverse-engineering-bundle.md §Defect
   Synthesis — the reconciled list from both defect passes — not from the raw scan
   outputs. Findings ranked by severity, each with file:line, its disposition (fix /
   port differently / leave behind / verify at runtime), and the fix you'd make.
   Separate confirmed-by-reading from plausible. Close with the three you'd fix first.
   If you finish before phase 6, report from the two scan outputs and say the list is
   unreconciled.

B. The dogfooding notes. You just drove the product as a host LLM, which is where this
   week's bugs came from. Where did a phase prompt leave you guessing? Where did
   validation or the handoff contract fight you? Which required_reads were dead weight
   and which were missing? What did the framework get wrong about its own repo — and
   did the reimplementation spec it produced describe a system you'd recognise? Be
   specific — this is the part only a self-run can produce.
```

## Why these choices

- **`full-with-deep-audit`, all seven phases.** `defect-scan` (two phases) skips the entire semantic tier: `defect-scan-semantic` depends on `contracts` and `protocols`, and that is where contract violations between the three surfaces and hazards in the persistence formats show up. `porting` is not a rebuild phase — its Defect Synthesis reconciles both scans into one prioritized list with a disposition per defect, which is the deliverable. `reimplementation-spec` is the only phase that is not review, and it is kept because half of a self-run is testing whether the product's headline output is coherent when produced from its own code.
- **No Broad-Side.** It is for repositories too large to read directly, and it costs money.
- **`PASS WITH GAPS` is allowed.** Without saying so, a host LLM tends either to stall on a gap or to quietly downgrade its own validation to make it pass. Routing gaps through the handoff is the designed path.
- **Report from the synthesis, not the raw scans.** Two unreconciled defect lists is what the pipeline exists to avoid producing.

## Keeping it current

Update this file when the pipeline's phases, the tool names, or the handoff contract change — a stale prompt here fails the same way #212's stale guide did. The phase table it relies on is `.codecarto/workflow/pipeline-full-with-deep-audit.yaml`.
