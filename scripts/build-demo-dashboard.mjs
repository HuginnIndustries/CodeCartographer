#!/usr/bin/env node
// Build a realistic demo .codecarto workspace (hand-authored findings, no LLM run)
// and render a real dashboard.html via the same writeDashboard() the Pi extension uses.
// Output: <repo>/docs/demo-workspace/.codecarto/dashboard.html
// Intended for a README hero screenshot. Safe to delete after the screenshot is taken.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeDashboard } from "../dist/extensions/codecarto/dashboard-writer.js";
import { PACKAGE_VERSION } from "../dist/core/workspace.js";

const root = join(process.cwd(), "docs", "demo-workspace");
const ws = join(root, ".codecarto");
const findings = join(ws, "findings");
const workflow = join(ws, "workflow");
const closeouts = join(ws, "closeouts");
const scratch = join(ws, "scratch");

await mkdir(findings, { recursive: true });
await mkdir(workflow, { recursive: true });
await mkdir(closeouts, { recursive: true });
await mkdir(scratch, { recursive: true });
await mkdir(join(scratch, "handoffs"), { recursive: true });

// ── Pipeline (use the real default shipped pipeline) ────────────────────────
const pipelineSrc = join(process.cwd(), ".codecarto", "workflow", "pipeline-full-with-deep-audit.yaml");
const { readFileSync } = await import("node:fs");
const pipelineYaml = readFileSync(pipelineSrc, "utf8");
await writeFile(join(workflow, "pipeline-full-with-deep-audit.yaml"), pipelineYaml, "utf8");

// ── status.yaml: mid-run, architecture + defect-scan-mech complete, contracts running ─
const now = new Date().toISOString();
const statusYaml = `project_name: express-starter
schema_version: 1
pipeline: workflow/pipeline-full-with-deep-audit.yaml
current_phase: contracts
last_updated: ${now}
next_actions:
  - "Review the architecture map at findings/architecture/architecture.md"
  - "Confirm or reject the 3 high-severity defects in findings/defect-scan/"
  - "Run /codecarto-next to continue the contracts phase"
phases:
  architecture:
    status: complete
    outputs_present:
      - findings/architecture/architecture.md
    owner_notes:
      - "Layered MVC confirmed; router/service/model separation is clean"
    open_questions:
      - id: oq-1
        kind: needs-maintainer-decision
        description: "Is the legacy /api/v1 surface still supported, or can the reimplementation drop it?"
        deferred_reason: "Affects contracts phase scope"
    carry_forward:
      - target_phase: contracts
        kind: defer-to-phase
        description: "v1 surface decision needed before contracts can finalize endpoint coverage"
  defect-scan-mech:
    status: complete
    outputs_present:
      - findings/defect-scan/defects.md
    owner_notes:
      - "3 high-severity, 7 medium, 12 low — all with file:line evidence"
  defect-scan-sem:
    status: pending
  contracts:
    status: in-progress
    outputs_present: []
    open_questions:
      - id: oq-2
        kind: needs-runtime-test
        description: "Token-refresh behavior under concurrent requests is inferred from code, not confirmed by a test."
  protocols:
    status: pending
  porting:
    status: pending
  reimplementation-spec:
    status: pending
post_pipeline:
  - source_phase: architecture
    status: pending
    description: "Spike: benchmark alternative ORMs vs the current raw-SQL layer before the porting phase"
`;
await writeFile(join(workflow, "status.yaml"), statusYaml, "utf8");

// ── Findings: realistic hand-authored artifacts ─────────────────────────────
await mkdir(join(findings, "architecture"), { recursive: true });
await mkdir(join(findings, "defect-scan"), { recursive: true });
await mkdir(join(findings, "contracts"), { recursive: true });

const archMd = [
  `# Architecture map — express-starter`,
  ``,
  `## Layers`,
  `| Layer | Responsibility | Key files |`,
  `|---|---|---|`,
  `| HTTP routing | Request parsing, route dispatch | src/routes/*.ts |`,
  `| Service | Business logic, validation | src/services/*.ts |`,
  `| Data access | Raw SQL via pg, connection pooling | src/db/*.ts |`,
  `| Auth | JWT issue/refresh, middleware guards | src/auth/*.ts |`,
  ``,
  `## Dependency direction`,
  `routes → services → data-access (one-way, no back-edges observed).`,
  ``,
  `## Public surfaces`,
  `- REST: /api/v2/* (documented), /api/v1/* (legacy, undocumented)`,
  `- CLI: \`npm run migrate\` wraps src/db/migrate.ts`,
  ``,
  `## Evidence levels`,
  `\`observed fact\` (layer boundaries), \`strong inference\` (v1 deprecation intent), \`open question\` (concurrent refresh).`,
  ``,
].join("\n");
await writeFile(join(findings, "architecture", "architecture.md"), archMd, "utf8");

const defectsMd = [
  `# Defect report — express-starter`,
  ``,
  `## High severity`,
  `| ID | Title | Location | Evidence |`,
  `|---|---|---|---|`,
  `| D-001 | SQL injection in user-search | src/db/users.ts:42 | String concatenation into query, user input unsanitized |`,
  `| D-002 | Refresh token not rotated on use | src/auth/refresh.ts:88 | Old token remains valid after refresh |`,
  `| D-003 | Migration runner has no transaction wrapper | src/db/migrate.ts:120 | Partial migration leaves schema half-applied |`,
  ``,
  `## Medium severity`,
  `9 medium findings omitted for brevity — see full report.`,
  ``,
].join("\n");
await writeFile(join(findings, "defect-scan", "defects.md"), defectsMd, "utf8");

// contracts/artifact.md intentionally absent — phase is in-progress (shows realistic state)

// ── Closeouts for completed phases ──────────────────────────────────────────
const archCloseout = [
  `# Closeout — architecture phase`,
  ``,
  `## Summary`,
  `Architecture map produced. 4-layer MVC confirmed with clean one-way dependency direction. One open question (v1 surface support) deferred to contracts.`,
  ``,
].join("\n");
const archDate = new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString().slice(0, 10);
await writeFile(join(closeouts, `${archDate}-architecture.md`), archCloseout, "utf8");

const defectCloseout = [
  `# Closeout — defect-scan-mech phase`,
  ``,
  `## Summary`,
  `Mechanical defect scan complete. 3 high-severity findings (SQL injection, token rotation, migration transaction gap), all with file:line evidence. Semantic scan pending.`,
  ``,
].join("\n");
const defectDate = new Date(Date.now() - 1000 * 60 * 60 * 10).toISOString().slice(0, 10);
await writeFile(join(closeouts, `${defectDate}-defect-scan-mech.md`), defectCloseout, "utf8");

// ── Usage log (realistic token/tool/duration telemetry) ─────────────────────
const archTs = new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString();
const defectTs = new Date(Date.now() - 1000 * 60 * 60 * 10).toISOString();
const contractTs = new Date(Date.now() - 1000 * 60 * 5).toISOString();
const usageYaml = `- phase: architecture
  timestamp: ${archTs}
  status: complete
  turn_count: 25
  tool_uses: 76
  tokens:
    input: 980000
    output: 28000
    cache_write: 14000
  duration_ms: 268000
  session_file: .codecarto/scratch/sessions/architecture.jsonl
  compactions:
    successful: 1
    failed: 0
    aborted: 0
    reasons:
      threshold: 1
      overflow: 0
      manual: 0
- phase: defect-scan-mech
  timestamp: ${defectTs}
  status: complete
  turn_count: 39
  tool_uses: 91
  tokens:
    input: 2400000
    output: 24000
    cache_write: 9000
  duration_ms: 425000
  session_file: .codecarto/scratch/sessions/defect-scan-mech.jsonl
  compactions:
    successful: 2
    failed: 0
    aborted: 0
    reasons:
      threshold: 2
      overflow: 0
      manual: 0
- phase: contracts
  timestamp: ${contractTs}
  status: in-progress
  turn_count: 11
  tool_uses: 37
  tokens:
    input: 335100
    output: 8200
    cache_write: 1200
  duration_ms: 40100
  session_file: .codecarto/scratch/sessions/contracts.jsonl
`;
await writeFile(join(workflow, ".usage.local.yaml"), usageYaml, "utf8");

// ── Render the dashboard via the real writer ───────────────────────────────
await writeDashboard(root, PACKAGE_VERSION);
console.log(`Dashboard written to ${join(ws, "dashboard.html")}`);