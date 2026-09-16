// The module graph stays acyclic at runtime and points one way (#353, #371).
//
// Two edges the 2026-09-15 self-audit found: core/dashboard-writer.ts imported
// its bindings back from the barrel that re-exports it, and
// core/broadside/state.ts imported a constant from the client module above it
// in the documented layer order. Both resolved only because the bindings
// were read at call time; both are gone, and this keeps them gone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `{ module: [{ target, typeOnly }] }` for every relative import in a directory. */
async function importGraph(dir) {
	const graph = new Map();
	for (const name of (await readdir(dir)).filter((n) => n.endsWith(".ts")).sort()) {
		const source = await readFile(join(dir, name), "utf8");
		const edges = [];
		for (const match of source.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"\.\/([\w-]+)\.ts";/gm)) {
			const names = match[2].split(",").map((n) => n.trim()).filter(Boolean);
			const typeOnly = Boolean(match[1]) || names.every((n) => n.startsWith("type "));
			edges.push({ target: match[3], typeOnly });
		}
		graph.set(name.slice(0, -3), edges);
	}
	return graph;
}

function findCycle(graph) {
	const state = new Map();
	const stack = [];
	const visit = (node) => {
		state.set(node, "active");
		stack.push(node);
		for (const { target, typeOnly } of graph.get(node) ?? []) {
			if (typeOnly || !graph.has(target)) continue;
			if (state.get(target) === "active") return [...stack.slice(stack.indexOf(target)), target];
			if (!state.has(target)) {
				const found = visit(target);
				if (found) return found;
			}
		}
		stack.pop();
		state.set(node, "done");
		return null;
	};
	for (const node of graph.keys()) {
		if (!state.has(node)) {
			const found = visit(node);
			if (found) return found;
		}
	}
	return null;
}

test("no core module imports the barrel that re-exports it", async () => {
	const graph = await importGraph(join(REPO_ROOT, "core"));
	const offenders = [...graph].filter(([name, edges]) => name !== "index" && edges.some((e) => e.target === "index")).map(([name]) => name);
	assert.deepEqual(offenders, [], "modules importing ./index.ts");
	assert.equal(findCycle(graph), null, "runtime import cycle in core/");
});

test("core/broadside/ has no runtime cycle and imports only downward through its layers", async () => {
	const graph = await importGraph(join(REPO_ROOT, "core", "broadside"));
	assert.equal(findCycle(graph), null, "runtime import cycle in core/broadside/");
	// The order the barrel documents: a module may import (at runtime) only
	// from modules in an earlier layer; modules in one layer do not import
	// each other.
	const layers = [
		["constants", "types", "schemas", "repo"],
		["lenses", "requests", "results", "state", "client"],
		["models", "verify"],
		["submit", "render"],
		["collect"],
	];
	const rank = new Map(layers.flatMap((layer, i) => layer.map((m) => [m, i])));
	for (const name of graph.keys()) assert.ok(rank.has(name), `${name} is not in the documented layer order`);
	const upward = [];
	for (const [name, edges] of graph) {
		for (const { target, typeOnly } of edges) {
			if (typeOnly) continue;
			if (rank.get(target) >= rank.get(name)) upward.push(`${name} → ${target}`);
		}
	}
	assert.deepEqual(upward, [], "runtime imports that go up or sideways in the layer order");
});
