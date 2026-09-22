import { liftSlices, buildChangePlan, buildChangeBrief } from "../../../core/engineering/index.ts";
import { readFileSync } from "node:fs";
const out = liftSlices(readFileSync("./converted-excerpt.md","utf8"));
console.log("scenarios:", out.scenarios.length, "slices:", out.slices.length, "errors:", JSON.stringify(out.errors));
for (const s of out.slices) console.log(` ${s.id} proves ${s.scenario_ids.join(",").padEnd(16)} deps ${s.depends_on.join(",") || "-"}`);
// Hand the lifted excerpt to E04 the way a planner would.
const request = { title: "port the codec and pipeline engine", mode: "feature", requested_outcome: "a byte-compatible codec and pipeline engine",
  baseline: { vcs: "git", head: "b".repeat(40), description: "empty target repo" }, scope: { in_scope: ["src/**"], non_goals: ["dashboard"] }, preserved_contracts: [],
  acceptance_scenarios: out.scenarios.map(s => ({ id: s.id, kind: "behavior", description: s.description })) };
const slices = out.slices.map(s => ({ title: s.deliverable, deliverable: s.deliverable, scenario_ids: s.scenario_ids, depends_on: [],
  proof_obligations: s.scenario_ids.map((sid,i) => ({ id: `${s.id}-o${i+1}`, scenario_id: sid, check_kind: "test", description: `observe ${sid}`, minimum_collector: "host-observed" })),
  permitted_scope: { paths: ["src/**"] } }));
console.log("brief ok:", buildChangeBrief(request).ok, "| plan ok:", buildChangePlan(request, slices).ok);
