# CodeCartographer

Copy the `.codecarto/` folder into any repository you want to analyze.

## Setup

```bash
# From inside your target repo:
cp -r /path/to/CodeCartographer/.codecarto .
```

That's it. No symlinks, no copying your code anywhere.

## Usage

Point any LLM with file access at the guide:

```
Read .codecarto/GUIDE.md and begin the analysis.
```

The LLM reads your source code directly from the repo root (`../` relative to `.codecarto/`) and writes findings into `.codecarto/findings/`.

## Git

The `.codecarto/.gitignore` already excludes generated findings and scratch files. If you want to commit the CodeCartographer template files (so other team members can run the analysis too), just commit the `.codecarto/` folder as-is.

## Choosing a Pipeline

The default is the 7-phase **full-with-deep-audit** pipeline, which splits the defect scan into an early mechanical pass (after architecture) and a deep semantic pass (after protocols) so the reimplementation can design around defects with full contracts and protocols context. To use a different one, edit `.codecarto/workflow/status.yaml`:

```yaml
pipeline: workflow/pipeline-full-with-deep-audit.yaml  # 7-phase with split defect scan (default; depth-first)
pipeline: workflow/pipeline-full-with-audit.yaml       # 6-phase with single early defect scan — adjust phases to use one defect-scan
pipeline: workflow/pipeline.yaml                       # 5-phase without defect scan — remove defect-scan phases
pipeline: workflow/pipeline-defect-scan.yaml           # 2-phase defect audit — remove contracts through reimplementation-spec
pipeline: workflow/pipeline-lite.yaml                  # 3-phase understanding — remove defect-scan phases, porting, and reimplementation-spec
pipeline: workflow/pipeline-architecture-only.yaml     # 1-phase quick overview — keep only architecture
```
