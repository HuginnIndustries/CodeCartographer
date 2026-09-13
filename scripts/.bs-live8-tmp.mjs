// Incremental (#142) baseline → change → incremental run, with wait on submit;
// then models --include_benchmarks and collect of an older run by id.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { handleBroadside } = await import(pathToFileURL(join(REPO_ROOT, "mcp-server/server.ts")).href);
const target = process.argv[2];
const git = (...args) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", ...args], { cwd: target }).toString().trim();
const lines = (r, n) => r.content[0].text.split("\n").slice(0, n).join("\n");

console.log("== baseline: submit architecture+conventions, incremental, wait 900 ==");
const base = await handleBroadside({ cwd: target, action: "submit", lenses: ["architecture", "conventions"], incremental: true, max_cost: 0.5, wait_seconds: 900, include_synthesis: false, include_triage: false });
console.log(lines(base, 4)); console.log(base.content[0].text.split("\n").filter((l) => /Incremental|Scanned as/.test(l)).join("\n"));
const baseRun = base.structuredContent.runId;

await writeFile(join(target, "src", "lib", "validate.js"), (await import("node:fs/promises")).readFile(join(target, "src", "lib", "validate.js"), "utf8").then((s) => s + "\n// touched for the incremental check\n"));
git("add", "-A"); git("commit", "-q", "-m", "touch validate");
console.log("\n== incremental run after one commit ==");
const inc = await handleBroadside({ cwd: target, action: "submit", lenses: ["architecture", "conventions"], incremental: true, max_cost: 0.5, wait_seconds: 900, include_synthesis: false, include_triage: false });
console.log(lines(inc, 4)); console.log(inc.content[0].text.split("\n").filter((l) => /Incremental|Scanned as|Results:|architecture:|conventions:/.test(l)).join("\n"));

console.log("\n== models with benchmarks ==");
const models = await handleBroadside({ cwd: target, action: "models", include_benchmarks: true });
console.log(models.content[0].text.split("\n").filter((l) => /^google\/gemini-3\.[78]|Benchmarks:/.test(l)).join("\n"));

console.log("\n== collect the baseline run again by id ==");
const again = await handleBroadside({ cwd: target, action: "collect", run_id: baseRun, wait_seconds: 0, include_synthesis: false, include_triage: false });
console.log(lines(again, 4));
