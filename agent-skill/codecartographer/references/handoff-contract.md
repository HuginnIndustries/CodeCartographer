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
open_question_closures: []      # open questions this phase resolved, removed everywhere; bare id or {id, evidence}
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

`carry_forward` entries add `target_phase`, and optionally `derives_from`:

```yaml
- id: arch-CF2
  kind: defer-to-phase
  target_phase: protocols
  description: MCP endpoints listed by name only; schemas not extracted.
  deferred_reason: Wire-format extraction is the protocols phase's rubric.

- id: mech-CF3
  kind: defer-to-phase
  target_phase: defect-scan-semantic
  derives_from: q-logit-bias-root-cause   # optional: the open question this is one candidate answer to
  description: The client sends logit_bias as a map; the documented shape is an array.
```

Allowed `kind` values: `needs-runtime-test`, `needs-maintainer-decision`, `needs-spec-ruling`, `defer-to-phase`, `needs-fixture-capture`.

`derives_from` names an `open_questions` id. Fill it in the handoff that registers the question — a phase that routes a candidate answer onward usually writes both entries at once, which is the one moment both are in front of you. It is optional and additive: a handoff that omits it behaves exactly as before.

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

### Closing a routed item does not settle the question it came from

Addressing what was routed to you is not the same as answering the question that produced it. Two rules make that enforceable:

- **A closure whose `derives_from` question is still open is refused.** If the item you are closing declares `derives_from: <question-id>`, that question is still in `status.yaml`, and this same handoff does not close it, completion refuses and names both ids. Either close the question here with the evidence that settles it, or leave the item routed and give the finding an unsettled action (`verify at runtime`) so it inherits the question's uncertainty. This rule is entirely opt-in — an entry without `derives_from` closes as it always has.
- **A `needs-runtime-test` question closes on runtime evidence.** Write the closure as an object and say where that evidence lives:

```yaml
open_question_closures:
  - q-loadconfig-ambiguity                   # bare id: still valid for any other kind
  - id: q-logit-bias-root-cause
    evidence: scratch/spikes/logit-bias.md — probe against llama-server b4321
```

Non-empty `evidence` is required when the question's `kind` is `needs-runtime-test`, whether the closure is written as a bare id or as an object. It is checked for presence, not judged — a spike report or an observation against the running system is what belongs there, and another read of the same source is not. Questions of every other kind close on a bare id exactly as before.

The requirement is scoped to the scaffold that documents it. A workspace whose `workflow/scaffold-version.yaml` is 0.19.0 or newer has completion refuse such a closure; an older or unversioned scaffold — whose own templates never stated the rule — gets a non-gating `NOTE:` instead, so an in-flight run written against the older contract cannot be stopped by a rule it was never told. Refreshing the scaffold (`codecarto_refresh_scaffold` on MCP, `/codecarto-refresh-scaffold` on Pi) opts a workspace in.

Upstream coverage gaps travel the same way, without gating: the `Skipped scope` and `Known blind spots` bullets of every completed phase's `## Coverage and limits` section appear in your phase prompt's orchestrator duties. A finding of yours inside one of those gaps must either close it with cited new evidence or inherit its uncertainty.

## The failure this prevents

Before completion required a handoff, a phase could finish with empty state and no signal. A real seven-phase run documented five cross-phase routings in its report prose, wrote no handoffs, and completed all seven phases with `carry_forward: []` throughout. Every downstream phase's routed-item intake was empty. The findings survived only because each phase happened to re-read the previous phase's full markdown.

Two habits follow from that:

- Writing the routing in a report table documents it. The handoff entry *is* it.
- A validation Evidence cell that says "routed to the semantic phase" is a claim about state. If the handoff entry does not exist, the claim is false and nothing will contradict it.
