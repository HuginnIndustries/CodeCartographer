// Run from the repo root: node --experimental-strip-types self-audit/<run>/probes/yaml.mjs
// (probe A2/B2/C/D from findings/defect-scan-mechanical/mechanical-defects.md §Runtime probes)
const R = new URL("../../../", import.meta.url).pathname;
const { parseSimpleYaml, stringifySimpleYaml } = await import(`${R}core/yaml.ts`);
const { normalizeStatus, createEmptyStatus } = await import(`${R}core/status.ts`);
const show = (label, fn) => { try { console.log(label, JSON.stringify(fn())); } catch (e) { console.log(label, "THROWS:", e.message); } };
show("A digit project_name parse", () => parseSimpleYaml("project_name: 2048\npipeline: x\n"));
show("A2 normalizeStatus with numeric project_name", () => normalizeStatus(parseSimpleYaml("project_name: 2048\npipeline: workflow/p.yaml\nschema_version: 1\n"), {phase_order:["a"],phases:[{id:"a"}]}, "workflow/p.yaml", "/tmp/x"));
show("B stringify of digit string", () => stringifySimpleYaml({ project_name: "2048", note: "true", n: "null" }));
show("B2 round trip", () => parseSimpleYaml(stringifySimpleYaml({ project_name: "2048", owner_notes: ["true", "42", "real note"] })));
show("C list item with 3-space nested mapping", () => parseSimpleYaml("items:\n  - id: x\n     kind: y\n"));
show("C2 list item with 4-space nested mapping", () => parseSimpleYaml("items:\n  - id: x\n      kind: y\n"));
show("D plain multi-line scalar", () => parseSimpleYaml("k: first line\n  second line\n"));
show("E validation Overall with suffix", () => "n/a");
show("F createEmptyStatus current_phase", () => createEmptyStatus("p","workflow/p.yaml",{phase_order:["a","b"],phases:[{id:"a",primary_output:"f/a.md"},{id:"b"}]}).current_phase);
