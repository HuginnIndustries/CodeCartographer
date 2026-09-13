import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { handleBroadside } = await import(pathToFileURL(join(REPO_ROOT, "mcp-server/server.ts")).href);
const target = process.argv[2];
const git = (...args) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", ...args], { cwd: target }).toString().trim();
const pick = (r, re) => r.content[0].text.split("\n").filter((l) => re.test(l)).join("\n");

const status = await handleBroadside({ cwd: target, action: "status" });
const baseRun = status.structuredContent.state.runs.at(-1).id;
console.log("previous run:", baseRun, "| HEAD", git("rev-parse", "--short", "HEAD"));

const file = join(target, "src", "lib", "validate.js");
await writeFile(file, (await readFile(file, "utf8")) + "\n// touched for the incremental check\n");
git("add", "-A"); git("commit", "-q", "-m", "touch validate");
console.log("committed:", git("rev-parse", "--short", "HEAD"));

console.log("\n== incremental run after one source commit (wait on submit) ==");
const inc = await handleBroadside({ cwd: target, action: "submit", lenses: ["architecture", "conventions"], incremental: true, max_cost: 0.5, wait_seconds: 900, include_synthesis: false, include_triage: false });
console.log(pick(inc, /submitted|Architecture|Convention|Incremental|Scanned as|Results:|architecture:|conventions:|Waiting/));

console.log("\n== models with benchmarks ==");
const models = await handleBroadside({ cwd: target, action: "models", include_benchmarks: true });
console.log(pick(models, /^google\/gemini-3\.[78]-flash:batch|^Benchmarks:/));
console.log("benchmarkMeta:", JSON.stringify(models.structuredContent.benchmarkMeta));

console.log("\n== collect the previous run again by id (already terminal) ==");
const again = await handleBroadside({ cwd: target, action: "collect", run_id: baseRun, wait_seconds: 0, include_synthesis: false, include_triage: false });
console.log(again.content[0].text.split("\n").slice(0, 4).join("\n"));
