// Secret redaction before a Broad-Side upload (self-audit #252, D-M23).
//
// Slices were built from source files and uploaded as-is; a `.env` stayed out
// of a batch only because no language glob happened to match it. Now files
// named like credential stores are left out of every lens, well-known secret
// shapes in every other file are replaced with `[REDACTED:<kind>]` before
// the slice is built, and the submit report says what the pass did.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(pathToFileURL(`${REPO_ROOT}/core/index.ts`).href);
const { broadsideDirFor, collectRepoInfo, describeRedactions, estimateSubmitText, gatherSlices, getLens, isSecretFile, loadBroadsideConfig, loadBroadsideState, redactSecrets, runBroadsideSubmit } = core;

// Assembled at runtime so the file holds no literal that a secret scanner
// (GitHub's push protection included) would flag as a real key.
const OPENROUTER_KEY = ["sk", "or", "v1", "0123456789abcdef".repeat(4)].join("-");
const GITHUB_TOKEN = ["ghp", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij123456"].join("_");
const GITHUB_PAT = ["github", "pat", "11ABCDEFG0123456789abcdefghijklmnop"].join("_");
const STRIPE_KEY = ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_");
const SLACK_TOKEN = ["xoxb", "1234567890", "abcdefghij"].join("-");
const GOOGLE_KEY = ["AIza", "SyA1234567890abcdefghijklmnopqrstuv"].join("");
const AWS_KEY_ID = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].join(".");
const PRIVATE_KEY = ["-----BEGIN RSA PRIVATE", "KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE", "KEY-----"].join(" ");

// ---------- the redactor ----------

test("redactSecrets replaces each well-known secret shape with a kind-named marker", () => {
	const cases = [
		[`const key = "${OPENROUTER_KEY}";`, 'const key = "[REDACTED:sk-api-key]";', "sk-api-key"],
		[`AWS_ACCESS_KEY_ID=${AWS_KEY_ID}`, "AWS_ACCESS_KEY_ID=[REDACTED:aws-access-key-id]", "aws-access-key-id"],
		[`token: ${GITHUB_TOKEN}`, "token: [REDACTED:github-token]", "github-token"],
		[GITHUB_PAT, "[REDACTED:github-token]", "github-token"],
		[STRIPE_KEY, "[REDACTED:stripe-key]", "stripe-key"],
		[SLACK_TOKEN, "[REDACTED:slack-token]", "slack-token"],
		[GOOGLE_KEY, "[REDACTED:google-api-key]", "google-api-key"],
		[JWT, "[REDACTED:jwt]", "jwt"],
		[`${PRIVATE_KEY}\nafter`, "[REDACTED:private-key]\nafter", "private-key"],
		['password: "hunter2hunter2"', 'password: "[REDACTED:credential-assignment]"', "credential-assignment"],
		["DB_PASSWORD = 'supersecretvalue'", "DB_PASSWORD = '[REDACTED:credential-assignment]'", "credential-assignment"],
		["stripe-secret-key: `whsec_0123456789`", "stripe-secret-key: `[REDACTED:credential-assignment]`", "credential-assignment"],
		["postgres://user:s3cretpw@db.example.com:5432/app", "postgres://user:[REDACTED:url-credential]@db.example.com:5432/app", "url-credential"],
	];
	for (const [input, expected, kind] of cases) {
		const result = redactSecrets(input);
		assert.equal(result.text, expected, input);
		assert.equal(result.count, 1, input);
		assert.deepEqual(result.kinds, { [kind]: 1 }, input);
	}
});

test("redactSecrets leaves short values, env references, ids, and hashes alone", () => {
	const untouched = [
		'password: "x"',
		"const apiKey = process.env.API_KEY;",
		"fetcher('sk-fake')",
		"const id = 'user-1234567890abcdef';",
		"sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
		"https://example.com/path?token=abc",
		"tokenizer.encode(text)",
		"// TODO: the secret sauce",
	];
	for (const input of untouched) {
		const result = redactSecrets(input);
		assert.equal(result.text, input);
		assert.equal(result.count, 0, input);
	}
});

test("redactSecrets is idempotent and counts every hit", () => {
	const text = `${OPENROUTER_KEY}\npassword: "hunter2hunter2"\npostgres://u:pw123@h/db\n${PRIVATE_KEY}`;
	const once = redactSecrets(text);
	assert.equal(once.count, 4);
	assert.deepEqual(once.kinds, { "private-key": 1, "sk-api-key": 1, "credential-assignment": 1, "url-credential": 1 });
	const twice = redactSecrets(once.text);
	assert.equal(twice.count, 0);
	assert.equal(twice.text, once.text);
});

test("isSecretFile names credential stores, not source files that handle secrets", () => {
	for (const path of [".env", ".env.local", "src/.env.production", ".env.example", "certs/server.pem", "tls/server.key", "id_rsa", "~/.ssh/id_ed25519.pub", ".npmrc", ".netrc", ".git-credentials", "config/credentials.json", "credentials", "secrets.yaml", "secret.env", "k8s/db.secret", "terraform/prod.tfvars", "gcp/service-account-key.json", "keys.p12"]) {
		assert.equal(isSecretFile(path), true, path);
	}
	for (const path of ["main.go", "env.go", "environment.ts", "token.go", "tokenizer.py", "secrets.go", "credentials.py", "secretary.rb", "keyring.rs", "src/auth/secret_store.ts", "README.md", "package.json", "docker-compose.yaml"]) {
		assert.equal(isSecretFile(path), false, path);
	}
});

test("describeRedactions is one line, or nothing when the pass did nothing", () => {
	assert.equal(describeRedactions(0, 0, []), null);
	assert.equal(describeRedactions(3, 2, []), "Before upload: redacted 3 secret-like value(s) in 2 file(s).");
	assert.equal(describeRedactions(0, 0, [".env"]), "Before upload: skipped 1 secret-bearing file(s) by name (.env).");
	assert.equal(
		describeRedactions(1, 1, [".env", "a.pem", "b.key", "c.p12"]),
		"Before upload: redacted 1 secret-like value(s) in 1 file(s); skipped 4 secret-bearing file(s) by name (.env, a.pem, b.key, …).",
	);
});

// ---------- through the lenses ----------

async function withRepo(fn) {
	const dir = await mkdtemp(join(tmpdir(), "cc-bs-redact-"));
	try {
		await mkdir(join(dir, "server"), { recursive: true });
		await writeFile(join(dir, "go.mod"), "module x\n");
		await writeFile(join(dir, "main.go"), `package main\n\nconst apiKey = "${OPENROUTER_KEY}"\n`);
		await writeFile(join(dir, "server", "auth.go"), `package server\n\nvar token = "${GITHUB_TOKEN}"\nvar dsn = "postgres://app:s3cretpw@db/app"\n`);
		await writeFile(join(dir, "server", "routes.go"), "package server\n\nfunc routes() {}\n");
		await writeFile(join(dir, "server", "server.pem"), PRIVATE_KEY);
		await writeFile(join(dir, ".env"), `OPENROUTER_API_KEY=${OPENROUTER_KEY}\n`);
		await writeFile(join(dir, "README.md"), `# x\n\nRun with AWS_ACCESS_KEY_ID=${AWS_KEY_ID}.\n`);
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}

test("secret-bearing files are out of every lens by name, whatever the globs say", async () => {
	await withRepo(async (dir) => {
		const info = await collectRepoInfo(dir);
		// The non-git walk never lists dotfiles, so `.env` is out before the
		// name filter sees it; a git listing includes it and the filter catches it.
		assert.deepEqual(info.secretFilesSkipped, ["server/server.pem"]);
		assert.equal(isSecretFile(".env"), true);
		// security's globs cover server/** — the .pem under it must still not be read.
		const security = await gatherSlices(dir, getLens("security"), info);
		const sent = security.map((s) => s.content).join("\n");
		assert.doesNotMatch(sent, /server\.pem|BEGIN RSA/);
		assert.match(sent, /=== server\/auth\.go ===/);
	});
});

test("values are redacted in slices and in the repo-info texts, and each slice reports its count", async () => {
	await withRepo(async (dir) => {
		const info = await collectRepoInfo(dir);
		assert.equal(info.redactedValues, 2, "the entry point's key and the README's AWS id");
		assert.match(info.mainFile, /const apiKey = "\[REDACTED:sk-api-key\]"/);
		assert.match(info.readmeFirst, /AWS_ACCESS_KEY_ID=\[REDACTED:aws-access-key-id\]/);

		const defect = await gatherSlices(dir, getLens("defect"), info);
		const sent = defect.map((s) => s.content).join("\n");
		assert.doesNotMatch(sent, new RegExp(OPENROUTER_KEY.slice(0, 24)));
		assert.doesNotMatch(sent, /ghp_|s3cretpw/);
		assert.match(sent, /var token = "\[REDACTED:github-token\]"/);
		assert.match(sent, /postgres:\/\/app:\[REDACTED:url-credential\]@db\/app/);
		assert.match(sent, /func routes\(\) \{\}/, "clean files are untouched");
		const totals = defect.reduce((sum, s) => sum + (s.redactedValues ?? 0), 0);
		assert.equal(totals, 3, "main.go's key, auth.go's token and DSN password");
		assert.deepEqual(defect.flatMap((s) => s.redactedFiles ?? []).sort(), ["main.go", "server/auth.go"]);
	});
});

test("submit records the pass on the run and the report says what it did", async () => {
	await withRepo(async (dir) => {
		const posted = [];
		const fetcher = async (_url, init) => {
			if (init?.method === "POST") {
				posted.push(JSON.parse(init.body));
				return { ok: true, status: 202, json: async () => ({ id: `batch-${posted.length}`, status: "validating" }), text: async () => "" };
			}
			return { ok: true, status: 200, json: async () => ({ id: "x", status: "completed" }), text: async () => "" };
		};
		const result = await runBroadsideSubmit(dir, "sk-fake", { lenses: ["architecture", "defect"], fetcher });
		assert.deepEqual(result.redaction, { enabled: true, values: 5, files: 2, skippedFiles: ["server/server.pem"] });
		const wire = JSON.stringify(posted);
		assert.doesNotMatch(wire, new RegExp(OPENROUTER_KEY.slice(0, 24)), "the key never reaches the wire");
		assert.doesNotMatch(wire, new RegExp(`ghp_|s3cretpw|${AWS_KEY_ID}|BEGIN RSA`));
		assert.match(wire, /REDACTED:sk-api-key/);

		const text = estimateSubmitText(result, [getLens("architecture"), getLens("defect")]);
		assert.match(text, /^Before upload: redacted 5 secret-like value\(s\) in 2 file\(s\); skipped 1 secret-bearing file\(s\) by name \(server\/server\.pem\)\.$/m);

		const run = (await loadBroadsideState(broadsideDirFor(dir))).runs[0];
		assert.deepEqual(run.redaction, { enabled: true, values: 5, files: 2, skippedFiles: 1 });
	});
});

test("redact_secrets: false sends files as they are and the report says so", async () => {
	await withRepo(async (dir) => {
		await mkdir(broadsideDirFor(dir), { recursive: true });
		await writeFile(join(broadsideDirFor(dir), "config.yaml"), "redact_secrets: false\n");
		assert.equal((await loadBroadsideConfig(broadsideDirFor(dir))).redactSecrets, false);
		const posted = [];
		const fetcher = async (_url, init) => {
			if (init?.method === "POST") {
				posted.push(JSON.parse(init.body));
				return { ok: true, status: 202, json: async () => ({ id: "b", status: "validating" }), text: async () => "" };
			}
			return { ok: true, status: 200, json: async () => ({ id: "x", status: "completed" }), text: async () => "" };
		};
		const result = await runBroadsideSubmit(dir, "sk-fake", { lenses: ["defect"], fetcher });
		assert.equal(result.redaction.enabled, false);
		assert.equal(result.redaction.values, 0);
		assert.match(JSON.stringify(posted), /ghp_/);
		assert.match(estimateSubmitText(result, [getLens("defect")]), /^Before upload: secret redaction is OFF \(redact_secrets: false in config\.yaml\); files were sent as they are\.$/m);
		// Named credential stores stay out even then: that is a glob-level rule.
		assert.doesNotMatch(JSON.stringify(posted), /BEGIN RSA/);
	});
});
