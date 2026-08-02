# CodeCartographer Visibility Roadmap

Status: drafted 2026-08-02. Items in **Done** are complete on the `docs/visibility-readme-overhaul` branch (see the open PR). Items below are for you to review, edit, or dispatch.

## Why this exists

The product has real adoption (≈1,800 npm installs/month) but almost no social signal (1 GitHub star, 0 forks). People install and leave without starring, talking, or citing. This roadmap closes that gap. It is a discoverability + conversion problem, not a quality problem.

## What I did tonight (on the branch, PR open for review)

- [x] Rewrote the README opening — problem-first 5-second hook, dropped "cartography" from line 1, added a "Why CodeCartographer" section, added a "star if you use it" nudge.
- [x] Built a realistic demo `.codecarto/` workspace (hand-authored findings, no LLM run) and rendered a real `dashboard.html`, then screenshotted it for the README hero image.
- [x] Wrote `docs/mcp-quickstart.md` — "Add CodeCartographer to Claude Code in 30 seconds" with copy-paste config for Claude Code, Cursor, Codex, Claude Desktop.
- [x] Fixed GitHub repo topics — added `codebase`, `ai-agent`, `context-engineering`, `code-understanding`, `spec-driven`.
- [x] Verified build + tests pass on the branch.

## What still needs you

These I could not do without you (credentials, cost sign-off, or external posting):

### 1. Real LLM-backed analysis run + live case study
The README's token-cost table already has real numbers from a self-run. The next step is a fresh `/codecarto-next --auto` run on a well-known open-source repo (small enough to be cheap — a popular Express app or CLI tool), then a writeup: what it found, what it cost, the spec it produced. Needs your sign-off on model/token cost. I can draft the writeup from the run output once you've run it.

### 2. Post the case study
HN (Show HN), r/LocalLLaMA, r/cursor, r/ClaudeAI, the Cursor Discord, the MCP community. One honest case study beats ten feature dumps. Pick the one community that responds best and double down. I can draft the posts — I won't post on your behalf.

### 3. Make codecarto.dev real
It's live (200 OK) but I don't know what's on it or where it's hosted. If it's a redirect/placeholder, put the case study + an embedded dashboard screenshot there. A homepage showing the dashboard rendering is worth more than any feature list. Tell me where it's hosted and I can draft content.

### 4. Record a 60-second widget demo
The live Pi widget (spinner + token counter) is visually distinctive and no README text conveys it. Needs an interactive Pi session with screen capture. Suggested script: `/codecarto-init` on a small repo → `/codecarto-next --auto` → record the widget while it works → trim to 60s → host on codecarto.dev + embed in README.

### 5. Starter library of published specs
The synthesis workflow has a cold-start problem — you have to run analysis first to get a spec to synthesize with. Publishing 3-5 specs from well-known open-source repos (an Express app, a CLI tool, a small SaaS) creates an immediate reason to try synthesis. Needs the real analysis runs (item 1) first.

### 6. MCP Registry listing polish
The registry API returned sparse data when I checked. Verify the published listing has a real description, keywords, and a link back to the README/demo. The registry is an active discovery surface for Claude Code / Cursor users right now.

## Suggested ordering when you're back

1. Review the PR, merge if happy. (5 min)
2. Decide whether to run a real analysis (item 1) — cheapest signal you can buy. (your call on cost)
3. Post the case study to one community. (10 min, after the run)
4. Point me at codecarto.dev so I can draft homepage content. (1 min)