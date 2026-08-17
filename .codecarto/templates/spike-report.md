# Spike — <spike-id>: <one-line question>

<!--
  Output template for one spike: a bounded investigation that answers a question
  the pipeline could not settle from source reading alone (a runtime probe, a
  measurement, a reproduction attempt).

  Place the report at: scratch/spikes/<spike-id>/<scenario>.md
  (one file per scenario; several scenarios may serve one spike-id).

  Spikes are usually registered first as post_pipeline entries (kind: spike) in a
  phase handoff. When a spike's findings change the reimplementation spec, write
  the deltas as Recommended Deltas below and apply them with the
  spec-delta-application skill; when a spike resolves an open question after the
  pipeline completed, close it with an amendment (templates/amendment.yaml +
  codecarto_amend), citing this report.

  Keep it honest: a spike that failed to answer its question is a valid result —
  record what was tried and what blocked it.
-->

## Goal

<!-- The exact question this spike answers, and which open_questions / post_pipeline
     id(s) it serves. One paragraph. -->

## Method

<!-- What was run, built, probed, or measured — precisely enough to re-run it.
     Include commands, fixtures, and environment facts that affect the result. -->

## Measurements

<!-- Raw observations before interpretation: outputs, timings, counts, captured
     frames, exit codes. Paste the actual returns — a summary is not evidence. -->

## Findings

<!-- What the measurements mean for the question in Goal. Mark each finding:
     confirmed / refuted / inconclusive. An inconclusive spike states what would
     settle it. -->

## Recommended Deltas

<!-- Changes the findings imply, one per bullet, each addressed to a specific
     artifact section (usually the reimplementation spec). These feed the
     spec-delta-application skill's triage — APPLY / CLARIFY / DEFER / REJECT is
     that session's call, not this report's. If a finding closes an open
     question, name the amendment slug that will apply it. -->

- Δ1 —
