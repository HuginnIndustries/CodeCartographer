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
- Status.yaml updates correctly after each phase.
- All file paths referenced in pipeline YAML, GUIDE.md, and SKILL.md files exist.

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
