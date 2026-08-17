# The phase handoff

Every phase proposes its state changes in one file, which completion validates and applies atomically:

```
.codecarto/scratch/handoffs/<phase-id>.yaml
```

The framework owns `workflow/status.yaml`, `closeouts/`, and `THREAD_LOG.md`, and owns all canonical timestamps. A session never writes them.

## Schema (version 1)

```yaml
schema_version: 1
phase_id: architecture          # must match the phase exactly
owner_notes: []                 # 2-3 durable observations; appended to the phase's notes
open_questions: []              # genuinely unknown, no later phase will close them
carry_forward: []               # deferred to a specific later phase in this pipeline
carry_forward_closures: []      # ids of carry_forward entries this phase resolved
open_question_closures: []      # ids of open questions this phase resolved, removed everywhere
post_pipeline: []               # work after the pipeline; every entry needs a stable id
decisions: []                   # choices made beyond what the prompt specified; completion appends them to DECISIONS.md
proposed_conventions: []        # patterns proposed for promotion; completion stages them in CONVENTIONS.md
closeout_summary: ""            # one clause, ~20 words; becomes the THREAD_LOG entry
closeout_content: |-            # optional full closeout markdown
  # Closeout — architecture
```

Omitted arrays default to empty. A malformed collection fails completion without mutating anything.

`.codecarto/templates/phase-handoff.yaml` in the workspace is a copyable skeleton.

## Entry shapes

`open_questions` entries:

```yaml
- id: q-loadconfig-ambiguity      # stable; auto-assigned if omitted
  kind: needs-runtime-test
  description: loadConfig returns {} on both ENOENT and parse error.
  deferred_reason: Distinguishing them needs a runtime probe this phase cannot run.
```

`carry_forward` entries add `target_phase`:

```yaml
- id: arch-CF2
  kind: defer-to-phase
  target_phase: protocols
  description: MCP endpoints listed by name only; schemas not extracted.
  deferred_reason: Wire-format extraction is the protocols phase's rubric.
```

Allowed `kind` values: `needs-runtime-test`, `needs-maintainer-decision`, `needs-spec-ruling`, `defer-to-phase`, `needs-fixture-capture`.

`proposed_conventions` entries (optional; omitted defaults to empty):

```yaml
- name: evidence-marker-citations
  rule: Cite every load-bearing claim with an evidence marker naming its source file.
  evidence: Third phase in a row independently adopted the [fact/inference] vocabulary.
```

`name` and `rule` are required and non-empty — a malformed entry fails completion. Completion stages each entry in `CONVENTIONS.md` under `## Pending proposals` (mechanical, deduplicated on re-run); promoting a staged proposal into a numbered convention stays an orchestrator judgment at the phase boundary. `decisions` are simpler: plain strings that completion both renders into the closeout's "Decisions Beyond Prompt" section and appends to `DECISIONS.md` as numbered `D<NNN>` rows under `## Completion log`.

## Open question or carry-forward?

- **`open_questions`** — nobody in this pipeline will resolve it. It needs a runtime test, a maintainer decision, or a spec ruling. It survives to the end as a known unknown.
- **`carry_forward`** — a specific later phase's rubric is the right place to close it. It is a routing, and it must name a real downstream phase.

`carry_forward` targets are validated: the target must exist in the active pipeline and come *after* the current phase. A target that is earlier, equal, or absent fails completion. Work that belongs after the pipeline goes in `post_pipeline` instead.

## Closing routed items

A later phase receives routed items in its phase prompt. To close one:

1. address it in that phase's output;
2. list its id under `carry_forward_closures` in that phase's handoff.

Completion then removes the entry atomically. Resolving an open question works the same way through `open_question_closures`, which removes the id from every phase that raised it.

Re-deferring instead of closing means writing a fresh `carry_forward` entry naming a later `target_phase`.

## The failure this prevents

Before completion required a handoff, a phase could finish with empty state and no signal. A real seven-phase run documented five cross-phase routings in its report prose, wrote no handoffs, and completed all seven phases with `carry_forward: []` throughout. Every downstream phase's routed-item intake was empty. The findings survived only because each phase happened to re-read the previous phase's full markdown.

Two habits follow from that:

- Writing the routing in a report table documents it. The handoff entry *is* it.
- A validation Evidence cell that says "routed to the semantic phase" is a claim about state. If the handoff entry does not exist, the claim is false and nothing will contradict it.
