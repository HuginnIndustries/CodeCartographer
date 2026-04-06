# CodeCartographer User Manual

This manual walks you through setting up and using CodeCartographer from start to finish. It's written for humans — the LLM has its own entry point (`.codecarto/GUIDE.md`).


## Prerequisites

CodeCartographer is a pure template. It has no runtime, no CLI, and no dependencies to install. You need two things:

1. **The `.codecarto/` folder.** Copy it from this repository into your target repo.
2. **An LLM with file access.** The LLM must be able to read files in the repository and write files back. See the Environment Setup section for which tools work.


## Environment Setup

CodeCartographer works with any LLM environment that supports reading and writing local files:

| Environment | File Access | Notes |
|---|---|---|
| **Claude Code** (terminal) | Native | Point it at `.codecarto/GUIDE.md`. Works out of the box. |
| **OpenCode** | Native | Same as Claude Code — file read/write is built in. |
| **Cursor / Windsurf / IDE copilots** | Native | Open the repository. Point the LLM at `.codecarto/GUIDE.md` in chat. |
| **Aider** | Native | Run from the repository root. |
| **Claude.ai / ChatGPT (web chat)** | Limited | You can paste file contents into the conversation and copy outputs back, but it's manual and error-prone. Not recommended for multi-phase runs. |
| **API-based agents** | Native | Load files programmatically, pass to the model, write outputs back. See the "For Automated Agents" section in README.md. |

The key requirement is that the LLM can **read** files like `.codecarto/GUIDE.md`, `.codecarto/workflow/status.yaml`, and your source code, and **write** files like `.codecarto/findings/architecture/architecture-map.md` and `.codecarto/workflow/status.yaml`.


## Step 1: Add CodeCartographer to Your Repository

Copy the `.codecarto/` folder into the root of the repository you want to analyze:

```bash
cp -r /path/to/CodeCartographer/.codecarto /path/to/your-repo/
```

Your repository should now look like:

```
your-repo/
  src/               <-- your existing code
  package.json       <-- your existing files
  ...
  .codecarto/        <-- CodeCartographer lives here
    GUIDE.md
    findings/
    workflow/
    templates/
    ...
```

The LLM reads your source code directly from the repository root. No symlinking or copying required.


## Step 2: Choose a Pipeline

Open `.codecarto/workflow/status.yaml` and set the `pipeline` field to match your goal:

```yaml
pipeline: workflow/pipeline.yaml  # Change this line
```

Here's how to decide:

**"I want to port or rewrite this codebase in another language."**
Use `workflow/pipeline.yaml` (full, 5 phases). This produces architecture, behavioral contracts, protocol notes, a porting synthesis, and a reimplementation spec.

**"I want to port it, but I also want to find bugs first so I don't carry them over."**
Use `workflow/pipeline-full-with-audit.yaml` (full with audit, 6 phases). Same as above but adds a multi-pass defect scan. The defect findings feed into the porting phase so you can decide what to fix, port differently, or leave behind.

**"I just want to find problems in code I'm maintaining."**
Use `workflow/pipeline-defect-scan.yaml` (defect scan, 2 phases). Produces an architecture map and a defect report. No porting or reimplementation artifacts.

**"I need to understand behavior but I'm not porting."**
Use `workflow/pipeline-lite.yaml` (lite, 3 phases). Produces architecture, contracts, and protocols. Stops before the porting and reimplementation phases.

**"I just need a quick structural overview."**
Use `workflow/pipeline-architecture-only.yaml` (architecture only, 1 phase). Produces an architecture map and stops.

The `status.yaml` file comes pre-configured with `workflow/pipeline.yaml` (full). If that's what you want, you don't need to change anything.


## Step 3: Point the LLM at the Guide

Open a new LLM session in your environment and direct it to read `.codecarto/GUIDE.md`. How you do this depends on your tool:

**Claude Code / OpenCode / Aider (terminal):**
```
Read .codecarto/GUIDE.md and begin the analysis.
```

**IDE copilot (Cursor, Windsurf, etc.):**
Open the repository. In the chat panel:
```
Read .codecarto/GUIDE.md in this workspace and follow its instructions.
```

**`.codecarto/NEW_THREAD_BLURB.md`** contains a condensed version you can paste at the start of any new session if your tool doesn't have persistent file context.

The LLM will read GUIDE.md, then read `.codecarto/workflow/status.yaml` to figure out which phase to work on, then read the phase's SKILL.md for detailed instructions, and start analyzing the source code.


## Step 4: Let It Work

Each phase follows the same pattern:

1. The LLM reads the source code through the lens of the current phase.
2. It produces a structured output file in `.codecarto/findings/<phase>/`.
3. It runs validation against the pipeline's completion criteria.
4. It updates `.codecarto/workflow/status.yaml` to mark the phase complete and advance to the next one.
5. It appends a summary entry to `.codecarto/THREAD_LOG.md`.

You generally don't need to intervene during a phase. The LLM knows what to read, what to produce, and where to put it.


## Step 5: Between Phases

When a phase finishes, the LLM will have updated `status.yaml` with the next phase. You have two options:

**Same session (if context allows):** Tell the LLM to continue:
```
Go back to .codecarto/GUIDE.md and start the next phase.
```

**New session:** Start a fresh LLM session and point it at `.codecarto/GUIDE.md` again. It will read `status.yaml`, see which phases are done, and pick up where the previous session left off. This is the recommended approach for large codebases — each phase gets a full context window.

You can check progress at any time by reading `.codecarto/workflow/status.yaml`. It shows the status of every phase, open questions, and what the next action should be.


## Step 6: Review the Output

When all phases are complete, `status.yaml` will show `current_phase: complete`. Your deliverables are in `.codecarto/findings/`:

| File | What it tells you |
|---|---|
| `findings/architecture/architecture-map.md` | How the system is structured — layers, dependencies, public surfaces, runtime lifecycle, concurrency model. Start here to orient yourself. |
| `findings/defect-scan/defect-report.md` | Bugs and problems found, organized by category. Only present if you used a pipeline that includes the defect-scan phase. |
| `findings/contracts/behavioral-contracts.md` | What the system does from the outside — feature-by-feature behavior, error handling, defaults, and a black-box acceptance list you can use as a test suite. |
| `findings/protocols/protocols-and-state.md` | How internal pieces talk to each other — message formats, state machines, persistence rules, and compatibility hazards that break ports. |
| `findings/porting/reverse-engineering-bundle.md` | Everything synthesized into a porting-oriented view — what matters, what's risky, and what to build first. |
| `findings/reimplementation-spec/reimplementation-spec.md` | The build plan — concept-level modules, required behaviors, implementation sequence, acceptance scenarios, and known unknowns. |

Each output ends with a **validation block** showing which completion criteria passed, partially passed, or failed. If anything is PARTIAL, the gaps are documented in the validation block and in `status.yaml` under `open_questions`.

**Secondary outputs** (in `findings/public-surfaces/`, `findings/runtime-lifecycle/`, etc.) contain overflow notes that accumulated across multiple phases. Check these if the primary outputs reference them.

**`.codecarto/THREAD_LOG.md`** has a summary of every session — what was analyzed, what was produced, and what questions were left behind.


## Evidence Levels

Every finding in every output is tagged with one of four evidence levels:

- **Observed fact** — directly stated in docs, tests, schemas, types, or code. Highest confidence.
- **Strong inference** — conclusion drawn from multiple observed facts. High confidence but not directly stated.
- **Portability hazard** — behavior tied to the source language, runtime, OS, or third-party SDK. Will likely need different handling in a port.
- **Open question** — missing or conflicting information. Needs investigation.

When reading the outputs, pay special attention to **portability hazards** (if porting) and **open questions** (always). These are where surprises hide.


## The Defect Scan

The defect-scan phase runs six sequential analysis passes, each focused on one category of problem:

| Pass | Focus | What it catches |
|---|---|---|
| 1 | Logic and correctness | Dead code, off-by-one errors, null handling, boolean logic mistakes |
| 2 | Error handling | Swallowed errors, missing cleanup, uncaught exceptions, retry gaps |
| 3 | Concurrency and resources | Race conditions, lock issues, async pitfalls, resource leaks |
| 4 | Security and trust | Input validation gaps, auth bypasses, secrets in code, trust boundary violations |
| 5 | API contract violations | Code that doesn't match its documented behavior, state machine violations |
| 6 | Config and environment | Hardcoded values, dangerous defaults, missing validation, OS assumptions |

Each finding is tagged with a **severity** (critical / high / medium / low) and a recommended **action**:

- Pre-porting pipelines: *fix before porting* / *port differently* / *leave behind*
- Maintenance pipelines: *fix now* / *track* / *accept* / *investigate*


## Multi-Session Workflows

Large codebases typically need one LLM session per phase. Here's how to manage that:

**Starting a new session for the next phase:**
Point the LLM at `.codecarto/GUIDE.md`. It reads `status.yaml`, sees what's done, and picks up the next phase automatically. You don't need to explain what happened in previous sessions — the findings files and status.yaml carry all the context.

**Resuming a partially completed phase:**
If a session ran out of context mid-phase, start a new session. The LLM will read the existing partial output and continue from where it left off.

**Parallel phases:**
In the full pipeline, `contracts` and `protocols` can run in parallel after `architecture` completes — they don't depend on each other. If you have two LLM sessions available, you can run both simultaneously.

**Important:** When running parallel phases, each session will update `status.yaml` on completion. The second session to finish will overwrite the first session's changes. To avoid losing progress, use one of these strategies:

- **Sequential status updates (simplest):** Let both phases run in parallel, but have only one session update `status.yaml`. After both finish, manually update `status.yaml` to mark both phases complete.
- **Merge after:** Let both sessions update `status.yaml`. After both finish, check the file and manually restore any overwritten phase status.
- **One at a time:** Run phases sequentially if you want zero risk of lost status updates.

**Checking progress:**
Read `.codecarto/workflow/status.yaml` at any time. The `phases` section shows which are complete, which are pending, and what open questions remain.


## Troubleshooting

**The LLM didn't advance `current_phase` in status.yaml.**
Tell the LLM:
```
Update .codecarto/workflow/status.yaml: set the status of [phase] to complete,
advance current_phase to the next pending phase, and update next_actions.
```

**The LLM wrote freeform text instead of the validation table.**
Tell it:
```
The validation block must be a table matching the format in .codecarto/workflow/VALIDATE.md.
Replace the freeform text with the table.
```

**The LLM tried to do all phases at once.**
Start with a more directive prompt:
```
Read .codecarto/GUIDE.md. You are working on ONE phase at a time. Read status.yaml
to find the current phase, then follow the SKILL.md for that phase only.
```

**The LLM says it can't read files.**
Your environment doesn't support file access. See the Environment Setup section.

**I want to re-run a phase.**
Reset the phase's status in `status.yaml` back to `pending`, set `current_phase` to that phase, delete the existing output file in `findings/<phase>/`, and start a new LLM session.


## Tips

- **Start with architecture-only** if you're evaluating whether CodeCartographer is useful for your codebase. It's one phase, takes a few minutes, and costs the least tokens.
- **The porting bundle is the single most useful output** if you're actually going to rewrite. It synthesizes everything into one document.
- **The defect report is the most useful output for maintenance.** Run the 2-phase defect-scan pipeline quarterly or before major refactors.
- **Don't skip the architecture phase.** Every other phase depends on it.
- **Use one session per phase** for large codebases — each phase gets a fresh context window and you don't pay to carry stale context.
- **Check THREAD_LOG.md** between sessions. It's the quickest way to see what happened without reading full outputs.


## Git

The `.codecarto/.gitignore` excludes generated findings and scratch files. You can commit the template files (workflow definitions, skills, templates, guide) so other team members can run the analysis from the same setup. If you want to also track findings in version control, remove the relevant lines from `.codecarto/.gitignore`.
