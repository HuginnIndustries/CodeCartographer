import { mkdtemp, mkdir, symlink, writeFile, utimes, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// Run from the repo root: node --experimental-strip-types self-audit/<run>/probes/semantic.mjs
// (probes P1-P6 from findings/defect-scan-semantic/semantic-defects.md §Runtime probes)
const R = new URL("../../..", import.meta.url).pathname;
const core = await import(`${R}/core/index.ts`);
const server = await import(`${R}/mcp-server/server.ts`);
const out = (l, v) => console.log(l, typeof v === "string" ? v : JSON.stringify(v));

/* P1: symlinked dir inside .codecarto, non-existent target file
{
  const ws = await mkdtemp(join(tmpdir(), "p1-"));
  const outside = join(ws, "outside"); await mkdir(outside);
  await mkdir(join(ws, ".codecarto")); await symlink(outside, join(ws, ".codecarto", "link"));
  const root = await core.canonicalPath(join(ws, ".codecarto"));
  const missing = await core.canonicalPath(resolve(ws, ".codecarto/link/new.md"));
  await writeFile(join(outside, "exists.md"), "x");
  const existing = await core.canonicalPath(resolve(ws, ".codecarto/link/exists.md"));
  out("P1 nonexistent file under symlinked dir allowed?", await core.isWithinPathResolved(missing, root));
  out("P1 existing file under symlinked dir allowed?", await core.isWithinPathResolved(existing, root));
}
// P2: lock release after another process broke it as stale
{
  const dir = await mkdtemp(join(tmpdir(), "p2-")); const lock = join(dir, "status.yaml.lock");
  const A = await core.acquireLock(lock);
  const old = new Date(Date.now() - 120_000); await utimes(lock, old, old);
  const B = await core.acquireLock(lock); // breaks stale
  await A.release();
  out("P2 lock file exists after A.release while B holds?", await core.pathExists(lock));
  const t0 = Date.now(); const C = await core.acquireLock(lock); out("P2 third acquire succeeded in ms", Date.now() - t0);
  await B.release(); await C.release();
}
*/
// P3: concurrent usage appends
{
  const ws = await mkdtemp(join(tmpdir(), "p3-")); await mkdir(join(ws, "workflow"), { recursive: true });
  const run = (i) => ({ timestamp: `2026-09-11T00:00:0${i}.000Z`, phase: `p${i}`, status: "completed", turn_count: 0, tool_uses: 0, duration_ms: 0, tokens: { input: 0, output: 0, cache_write: 0 } });
  const rs = await Promise.allSettled([1,2,3,4,5].map((i) => core.appendUsageRun(ws, run(i))));
  out("P3 append outcomes", rs.map((r) => r.status === "fulfilled" ? "ok" : r.reason.code));
  out("P3 runs recorded after 5 concurrent appends", (await core.loadUsage(ws)).runs.length);
}
// P4: concurrent publish of two different specs to one slug
{
  const lib = await mkdtemp(join(tmpdir(), "p4-"));
  await core.writeMarker(lib, { schema_version: 1, name: "l", namespaced: false });
  const input = { slug: "tool", source_repo: "https://x/tool", analyzed_at: "2026-09-11T00:00:00Z", pipeline: "p", codecarto_version: "0", headline: "h", tags: [], capabilities: [], generation: { surface: "mcp-server", agent: "a", agent_version: "1", model: "m", model_vendor: "v", reasoning: "unknown", notes: "" } };
  const results = await Promise.allSettled([core.publishEntry(lib, "spec A", input), core.publishEntry(lib, "spec B", input)]);
  out("P4 results", results.map((r) => r.status === "fulfilled" ? `v${r.value.version} new=${r.value.isNewVersion}` : `rejected: ${r.reason.code ?? r.reason.message}`));
  out("P4 entry dir", (await readdir(join(lib, "entries", "tool"))).sort());
}
// P5: skill name traversal on a completed pipeline
{
  const cwd = await mkdtemp(join(tmpdir(), "p5-"));
  await server.handleInit({ cwd, pipeline: "architecture-only" });
  const cc = join(cwd, ".codecarto");
  await writeFile(join(cc, "findings/architecture/architecture-map.md"), "# M\n\n## Validation\n\n| # | C | R | E |\n|---|---|---|---|\n| 1 | c | PASS | e |\n\n**Overall:** PASS\n");
  await mkdir(join(cc, "scratch/handoffs"), { recursive: true });
  await writeFile(join(cc, "scratch/handoffs/architecture.yaml"), "phase_id: architecture\ncloseout_summary: done\n");
  await server.handleComplete({ cwd });
  try { const r = await server.handleSkill({ cwd, name: "../findings/architecture" }); out("P5 traversal skill name accepted; prompt head:", r.content[0].text.split("\n")[0]); }
  catch (e) { out("P5 traversal skill name refused:", e.message); }
}
// P6: DAG with an unsatisfiable dependency
{
  const cwd = await mkdtemp(join(tmpdir(), "p6-"));
  await server.handleInit({ cwd, pipeline: "architecture-only" });
  const cc = join(cwd, ".codecarto");
  await writeFile(join(cc, "workflow/pipeline-stuck.yaml"), "phase_order:\n  - a\n  - b\nphases:\n  - id: a\n    primary_output: findings/a/a.md\n  - id: b\n    depends_on:\n      - nope\n    primary_output: findings/b/b.md\n");
  const pipeline = await core.loadYamlFile(join(cc, "workflow/pipeline-stuck.yaml"));
  const status = core.createEmptyStatus("p6", "workflow/pipeline-stuck.yaml", pipeline);
  await writeFile(join(cc, "workflow/status.yaml"), core.stringifySimpleYaml(status) + "\n");
  await mkdir(join(cc, "findings/a"), { recursive: true });
  await writeFile(join(cc, "findings/a/a.md"), "# A\n\n## Validation\n\n| # | C | R | E |\n|---|---|---|---|\n| 1 | c | PASS | e |\n\n**Overall:** PASS\n");
  await mkdir(join(cc, "scratch/handoffs"), { recursive: true });
  await writeFile(join(cc, "scratch/handoffs/a.yaml"), "phase_id: a\ncloseout_summary: done\n");
  await server.handleComplete({ cwd });
  const st = await server.handleStatus({ cwd }); const nx = await server.handleNext({ cwd });
  out("P6 status text (b still pending):", st.content[0].text.split("\n").slice(0, 4).join(" | "));
  out("P6 next text:", nx.content[0].text.slice(0, 60));
  out("P6 stored current_phase:", (await core.getWorkspaceState(cwd)).status.current_phase);
}
