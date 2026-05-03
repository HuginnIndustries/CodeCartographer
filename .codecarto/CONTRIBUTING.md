# Contributing to CodeCartographer

Thanks for your interest in improving CodeCartographer.

## How to Contribute

### Reporting Issues

Open a GitHub issue for bugs, unclear instructions, or missing coverage. Include which phase or file is affected and what you expected to happen.

### Proposing Changes

1. Fork the repository.
2. Create a feature branch from `main`.
3. Make your changes.
4. Test by running the template against a real codebase (see below).
5. Open a pull request with a clear description of what changed and why.

### Testing Your Changes

CodeCartographer is a pure template — there is no test suite to run. Instead, validate changes by pointing an LLM at `GUIDE.md` with a source repo as the parent directory and confirming that the workflow still produces correct, well-structured output.

Key things to verify:

- Pipeline YAML files parse correctly and phase dependencies resolve.
- SKILL.md instructions produce output that matches the corresponding template.
- Validation protocol (VALIDATE.md) catches missing or incomplete sections.
- `status.yaml` updates correctly after each phase, with the schema-split `open_questions` / `carry_forward` lists used for what each is for (see GUIDE.md "Open Questions vs Carry-Forward").
- All file paths referenced in pipeline YAML, GUIDE.md, and SKILL.md files exist.

#### THREAD_LOG.md de-dup check

`THREAD_LOG.md` is an append-only index of one-line pointers to closeout files. The framework has no programmatic dedup gate, but earlier sessions have produced duplicate entries when an append happened twice. Run this before opening a PR that touches `THREAD_LOG.md`:

```bash
grep -E '^- [0-9]{4}-[0-9]{2}-[0-9]{2}' .codecarto/THREAD_LOG.md | sort | uniq -d
```

The command should print nothing. If it prints a duplicate line, find and remove the second occurrence.

### What Makes a Good Contribution

- **SKILL.md improvements**: better analysis instructions, additional patterns to check for, clearer evidence-level guidance.
- **Template refinements**: sections that are consistently empty or redundant, missing sections that LLMs frequently need.
- **Pipeline variants**: new scope configurations for specific use cases.
- **Documentation**: clearer setup instructions, better examples, FAQ entries.

### What to Avoid

- Adding runtime dependencies, CLIs, or build steps. CodeCartographer is a pure template.
- Changing the folder structure without updating all references (pipeline YAML, GUIDE.md, SKILL.md files, templates).
- Adding LLM-specific instructions that only work with one model or provider.

## Code of Conduct

Be respectful and constructive. We're all here to make reverse-engineering codebases easier.
