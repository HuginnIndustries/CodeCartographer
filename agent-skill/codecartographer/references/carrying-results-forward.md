# After the pipeline completes

Two things usually follow a finished run: someone starts implementing, and the findings need a home outside the analysed repository.

## Starting implementation

When a completed `reimplementation-spec` is the input to real work rather than more analysis:

1. **Read the spec first and treat it as the contract.** Not the source repository, and not the architecture map — the spec is what later disagreements resolve against.
2. **Inspect the target repository's actual stack before choosing a layout.** Its project and build files, whether the existing test suite currently compiles, and its root build configuration. A layout chosen before this is a layout that gets redone.
3. **Prefer a non-destructive adjacent module** when the existing product is large or defect-prone: leave the legacy code untouched, add a small kernel module beside it with its own focused test project, and wire it into the workspace only once the layout is settled.
4. **Write acceptance tests against fakes before touching real providers, UI, or adapters** — see `kernel-first-rewrite.md`.
5. **Isolate new tests when the legacy suite is unrelatedly broken.** A filtered run often still compiles the whole legacy assembly and surfaces failures that have nothing to do with the new work. Do not expand into repairing the legacy suite unless the user asked for that scope.
6. **Carry the "do not clone" hazards through as test names**, so the reason a rule exists survives into the code.

## Autonomy boundaries

If implementation will proceed while the user is away, settle the boundary before they go: whether work may edit code, run tests, commit, and push. Prefer scoping permission to the specific worker over disabling approvals globally, and exclude force-pushes, history rewrites, unrelated destructive changes, and anything touching secrets.

Verify independently after any autonomous run reports success — check the repository state yourself, run the tests yourself, confirm generated and workflow-state files are untracked, and inspect the commit scope. Report exact commit hashes and test counts rather than a claim of success.

## Publishing findings into a product repository

When the results should inform a *new* repository, publish a curated snapshot rather than the raw workspace, which is noisy and carries executable workflow state:

```text
docs/codecarto/
  README.md
  architecture-map.md
  behavioral-contracts.md
  protocols-and-state.md
  mechanical-defects.md
  semantic-defects.md
  reverse-engineering-bundle.md
  reimplementation-spec.md
```

The README should say that these are curated audit outputs from the source repository, that `reimplementation-spec.md` is the canonical implementation contract, and — when true — that the new product is a ground-up rework rather than a source-level port.

Keep the workspace itself untracked in the new repository:

```gitignore
.codecarto/
.codecarto-backup-*/
```

Before publishing, confirm the tests pass and that neither the workspace nor build output is tracked:

```bash
git ls-files | grep -E '^\.codecarto' || echo "clean"
```

Default to this curated shape. Copy the raw `.codecarto/` workspace across only when the user explicitly wants executable workflow state in the new repository — for example, to continue the pipeline there.
