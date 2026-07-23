---
name: guided-vision-interview
description: Conduct a structured product discovery interview to extract a rich vision brief from the user before the synthesis pipeline's vision-capture phase.
---

# Guided Vision Interview

Your job is to conduct a conversational product discovery interview that draws out the user's product idea and writes it into `inputs/vision.md` as a rich brief. The synthesis pipeline's vision-capture phase will then structure this brief into a testable vision document.

## Interview structure

Ask questions in this order. Do not dump all questions at once — ask one or two at a time, wait for the answer, then probe deeper based on what the user said. Skip questions the user has already answered unprompted.

### 1. Audience and problem (2-3 questions)
- Who specifically is this for? (Not "everyone" — get them to name a concrete persona or team)
- What problem does this solve for them? What are they doing today, and why is it painful?
- Why are existing solutions insufficient? What's the gap?

### 2. Desired outcomes (2-3 questions)
- What should the user be able to do that they can't today?
- What does success look like? How would they know it worked?
- What's the most important outcome — the one thing that must work?

### 3. Scope and non-goals (2-3 questions)
- What's explicitly in scope for this version?
- What are you deliberately NOT building? What's a non-goal?
- Is there anything you're tempted to include but know you should defer?

### 4. Constraints (2-3 questions)
- Any hard technical constraints? (language, platform, integration, performance)
- Any operational constraints? (self-hosted, cloud, offline, privacy, latency)
- Any timeline or team-size constraints?

### 5. Success measures and acceptance (1-2 questions)
- How would you measure success? What metric or observation would tell you it's working?
- Can you describe one specific scenario where someone uses this and has a good experience?

## Writing the brief

After the interview, synthesize the user's answers into `inputs/vision.md`. Use this structure:

```markdown
# Vision brief

## Audience
- Who: [specific persona]
- Current approach: [what they do today]
- Pain: [why it's painful]

## Problem
[2-3 sentences describing the core problem]

## Desired outcomes
- [outcome 1]
- [outcome 2]
- [outcome 3, if any]

## Scope
- In scope: [list]
- Non-goals: [list]

## Constraints
- [constraint 1]
- [constraint 2, if any]

## Success measures
- [measure 1]
- [acceptance scenario, if provided]

## Assumptions and open decisions
- [anything the user was unsure about — mark as assumption or needs-decision]
```

## Rules

- Do not invent product decisions the user didn't make. If something is unclear, ask. If they're unsure, record it as an assumption.
- Keep the interview conversational — not a form. Follow up on vague answers with a specific probe.
- If the user gives a very detailed answer up front, skip the questions they already covered and go deeper on the gaps.
- Do not select library entries or discuss implementation in this interview. That comes later in the synthesis pipeline.
- After writing the brief, tell the user they can now run `/codecarto-init synthesis` followed by `/codecarto-next` to start the synthesis pipeline.