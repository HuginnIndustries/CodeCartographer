# Choosing a pipeline

Pass an alias to `codecarto_init` as `pipeline`. The default is `full-with-deep-audit`.

| Alias | Phases | Use when |
|---|---|---|
| `architecture-only` | architecture | quick structural read; "what is this repo" |
| `lite` | architecture → contracts → protocols | understanding a system you will keep, not rewrite |
| `defect-scan` | architecture → defect-scan | maintenance audit of a system you already understand |
| `full` | architecture → contracts → protocols → porting → reimplementation-spec | porting or rewriting, no defect audit |
| `full-with-audit` | adds a single defect-scan after architecture | porting, with defects surfaced once |
| `full-with-deep-audit` *(default)* | splits the scan: mechanical after architecture, semantic after protocols | porting or rewriting where correctness matters |
| `scout-first` | `full-with-deep-audit` behind a `broadside-scout` brief | a repository large enough that a Broad-Side sweep already ran and should steer the phases |
| `synthesis` | vision-capture → goal-synthesis-propose → spec-merge → goal-synthesis-finalize | forward synthesis of a *new* product, not reverse-engineering |

## Deep audit versus plain audit

`full-with-deep-audit` runs the defect scan in two passes for a reason worth understanding before choosing:

- **mechanical** (logic, error handling, configuration) runs early, right after architecture, so contracts and porting can cite its findings;
- **semantic** (concurrency, security, API contract violations) runs after protocols, because judging those needs the state machines and wire formats in hand.

The mechanical pass routes anything it cannot settle locally to the semantic pass. If the user expects "seven phases," they mean this variant.

Choose `full-with-audit` when one combined pass is enough and you want fewer phases. Choose `full-with-deep-audit` when the output will drive a rewrite, since a semantic pass without protocols context will miss the findings that most change a port.

## Scout-first needs a scout run

`scout-first` is `full-with-deep-audit` with one phase in front: `broadside-scout`
distills a completed Broad-Side batch reconnaissance run into a routing brief,
and the six phases after it read that brief and must account for the leads
addressed to them — confirmed, dismissed with a reason, or carried forward.
See `references/broadside.md` for the sweep itself.

The scout phase never submits a batch and never spends; it reads only what a
prior run wrote. Choosing this variant without having run Broad-Side gets you an
explicitly empty brief and, from there on, exactly `full-with-deep-audit`. So
fire the sweep first, or choose the plain deep-audit variant.

## Synthesis is a different workspace

The `synthesis` pipeline plans a new product from a vision brief and a library of reusable specs. It does **not** treat the surrounding repository as source evidence. It has preflight gates: a completed `inputs/vision.md`, a valid non-empty library, and — for merge and finalization — at least one human-confirmed selection. `codecarto_vision` runs the guided interview that produces the brief.

Do not reach for it when the user wants a repository analyzed.

## Switching later

Use `codecarto_switch_pipeline`, never a hand-edit. It preserves findings, handoffs, usage data, closeouts, and per-phase progress; phases present in both variants keep their completion status, phases unique to the new variant start pending, and phases only in the old one are dropped from state while their findings stay on disk.

Switching from `full` to `full-with-deep-audit` mid-run is the common case — the user wanted the defect scans and started without them. That works and keeps the completed architecture, contracts, and protocols phases.

Re-initializing with `force: true` is the destructive alternative: it moves the entire existing workspace to a backup directory. Only do that when the user explicitly asks, and say what will move.
