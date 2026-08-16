# Phase executors

CodeCartographer does not run models. Any executor that satisfies the contract below can run a phase, so pick per phase rather than committing to one tool for a whole pipeline.

## The executor contract

Given the prompt text from `codecarto_next` and the absolute repository path, an executor must:

1. read the repository — or, for late synthesis phases, the prior `.codecarto/findings/` artifacts rather than the source tree;
2. write the exact primary output path the prompt names;
3. append a validation block whose final line is `**Overall:** PASS` or `**Overall:** PASS WITH GAPS`;
4. write `.codecarto/scratch/handoffs/<phase-id>.yaml`;
5. modify nothing outside `.codecarto/`.

Anything meeting all five works. Nothing else about the executor matters to the framework.

## Choosing one

Two properties decide it: how much repository the phase must read, and how much reasoning quality changes the artifact's worth.

| Phase | Reads | Reasoning weight | Typical choice |
|---|---|---|---|
| `architecture` | wide — whole tree | moderate | largest usable context |
| `contracts`, `protocols` | wide, but guided by architecture | high | strong model, large context |
| `defect-scan-*` | wide, pattern-driven | high for semantic, moderate for mechanical | strong model; mechanical tolerates a cheaper one |
| `porting`, `reimplementation-spec` | narrow — prior findings only | highest | the strongest model available, always |
| `vision-capture`, `goal-synthesis-*` | narrow — vision brief and library | high | strong model |

Two rules that matter more than any specific product:

- **Synthesis phases deserve your best model.** `porting` and `reimplementation-spec` read almost nothing new; their entire value is the quality of the reasoning over prior findings. Saving tokens there is a false economy — that artifact is what someone builds from.
- **Wide-read phases deserve your largest usable context**, because the binding constraint is how much of the tree fits before the executor starts guessing.

Prefer whatever is strongest and largest among what the user actually has configured. Ask if it is unclear which models are available rather than assuming a particular vendor.

## Adapter: run it in your own context

Simplest and usually correct for small and mid-size repositories. Take the prompt from `codecarto_next` and follow it with your own file, search, and edit tools.

Choose this when the repository fits comfortably in your context, when the phase is a synthesis phase reading only prior findings, or when you want to interleave judgment with the user.

## Adapter: delegate to a CLI coding agent

Right when the phase would consume more context than you want to spend, or when you want the phase isolated from the orchestration conversation.

Pass the prompt through a file rather than inline — phase prompts contain backticks, quotes, and newlines that mangle badly in shell quoting:

```bash
# Write the prompt from codecarto_next to a file first, then:
<agent-cli> --prompt-file /tmp/codecarto-phase.md --workdir /abs/path/to/repo
```

Whatever CLI you use:

- set the working directory to the target repository;
- grant read, write, edit, and search tools; grant shell access only if the phase needs it;
- request structured output if available, so success is machine-checkable rather than inferred;
- for long phases, run in the background with a completion signal instead of blocking indefinitely;
- afterwards, confirm the primary output exists and inspect the executor's own success report — a zero exit code is not evidence the artifact was written.

## Adapter: local or small models for scoped pre-passes

Useful for saving context, but only in a specific shape: narrow, verifiable summaries of one subsystem at a time.

- Generate per-subsystem notes, never whole-repository analysis.
- Write them under `.codecarto/scratch/` as supporting evidence. Primary outputs still live in `findings/` and still have to pass validation.
- Feed the notes to the phase executor as *auxiliary evidence*, and tell it explicitly not to re-run the pre-pass.
- Treat the output as hints to verify, never as findings. A local model's claim about the code is a lead; the phase artifact needs the evidence level to match what was actually confirmed.
- If a large local model fails on memory, drop to a smaller one and narrow the scope. The lesson is "scope the notes smaller," not "local models don't work."

## Mixing executors across one pipeline

Normal and often optimal: a cheap wide pass for `architecture`, a strong model for `contracts` and the semantic defect scan, your best for `reimplementation-spec`. The framework neither knows nor cares — each phase is validated on its artifact alone.

Keep one thing consistent regardless of executor: every phase writes its handoff. A mixed pipeline where one executor forgets is exactly how cross-phase routing goes missing.
