import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lib = await import("./core/library.ts");

const dir = await mkdtemp(join(tmpdir(), "diag-"));
await lib.writeMarker(dir, { schema_version: 1, name: "diag", namespaced: true });

function inp(o) {
  return {
    slug: "hexbridge",
    namespace: "james",
    source_repo: "https://github.com/myorg/hexbridge",
    analyzed_at: "2026-05-14T14:00:00Z",
    pipeline: "p",
    codecarto_version: "0.9.0",
    headline: "h",
    tags: [],
    capabilities: [],
    generation: { surface: "pi-extension", agent: "pi", agent_version: "x", model: "x", model_vendor: "anthropic", reasoning: "high", notes: "" },
    ...o,
  };
}

await lib.publishEntry(dir, "# a\n", inp({ slug: "alpha", tags: ["kafka"] }));
await lib.publishEntry(dir, "# b\n", inp({ slug: "beta", tags: ["redis"] }));
await lib.publishEntry(dir, "# c\n", inp({ slug: "gamma", namespace: "alice", source_repo: "https://github.com/alice/gamma" }));

console.log("--- index.yaml ---");
console.log(await readFile(join(dir, "index.yaml"), "utf8"));

const byNs = await lib.listEntries(dir, { namespace: "alice" });
console.log("--- byNs (filter namespace=alice) ---");
console.log(JSON.stringify(byNs, null, 2));

await rm(dir, { recursive: true, force: true });
