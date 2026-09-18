// Canonical digests for engineering records (E01, #399).
//
// One encoding, one algorithm: the value is serialized as canonical JSON —
// object keys sorted by UTF-16 code unit, no whitespace, strings escaped as
// `JSON.stringify` escapes them, integers only — and hashed with SHA-256. The
// result is spelled `sha256:<64 lowercase hex>`. Any two implementations
// that follow those rules produce the same digest for the same value, which
// is what lets a host, the core, and a reviewer agree on what was hashed.
//
// Floats are refused rather than canonicalized: no v1 digest input carries
// one, and their shortest-round-trip spelling is where implementations drift.

import { createHash } from "node:crypto";
import type { AcceptancePresentation, AttemptInputs, Digest, SnapshotRecord } from "./types.ts";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isDigest(value: unknown): value is Digest {
	return typeof value === "string" && DIGEST_PATTERN.test(value);
}

/**
 * Canonical JSON text of `value`. Throws on anything JSON cannot carry
 * losslessly: `undefined` (except as an omitted object property), functions,
 * symbols, bigints, non-finite or non-integer numbers, and objects whose
 * prototype is not Object or null.
 */
export function canonicalJson(value: unknown): string {
	const out: string[] = [];
	write(value, out, "/");
	return out.join("");
}

function write(value: unknown, out: string[], path: string): void {
	if (value === null) {
		out.push("null");
		return;
	}
	switch (typeof value) {
		case "string":
			out.push(JSON.stringify(value));
			return;
		case "boolean":
			out.push(value ? "true" : "false");
			return;
		case "number":
			if (!Number.isInteger(value)) throw new Error(`canonicalJson: non-integer number at ${path}`);
			out.push(Object.is(value, -0) ? "0" : String(value));
			return;
		case "object":
			break;
		default:
			throw new Error(`canonicalJson: unsupported ${typeof value} at ${path}`);
	}
	if (Array.isArray(value)) {
		out.push("[");
		value.forEach((item, i) => {
			if (i > 0) out.push(",");
			if (item === undefined) throw new Error(`canonicalJson: undefined array element at ${path}${i}`);
			write(item, out, `${path}${i}/`);
		});
		out.push("]");
		return;
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) throw new Error(`canonicalJson: non-plain object at ${path}`);
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort(compareCodeUnits);
	out.push("{");
	keys.forEach((key, i) => {
		if (i > 0) out.push(",");
		out.push(JSON.stringify(key), ":");
		write(record[key], out, `${path}${key}/`);
	});
	out.push("}");
}

/** Plain `<`/`>` on JS strings compares UTF-16 code units, which is the sort the contract names for object keys. */
function compareCodeUnits(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Byte order of the UTF-8 encoding — the sort for manifest paths, which must agree across languages. */
export function compareUtf8(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function digestOfBytes(bytes: Uint8Array | string): Digest {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** The digest of `value`'s canonical JSON. */
export function digestOf(value: unknown): Digest {
	return digestOfBytes(canonicalJson(value));
}

type SnapshotIdentity = Pick<SnapshotRecord, "coverage" | "manifest" | "repository">;

/** Exactly the snapshot fields that constitute identity: `coverage`, `manifest`, `repository`. */
export function snapshotIdentity(snapshot: SnapshotIdentity): SnapshotIdentity {
	return { coverage: snapshot.coverage, manifest: snapshot.manifest, repository: snapshot.repository };
}

export function computeSnapshotDigest(snapshot: SnapshotIdentity): Digest {
	return digestOf(snapshotIdentity(snapshot));
}

/** `{ brief_digest, plan_digest, references }` — `references` exactly as stored (the validator requires them sorted). */
export function computeInputDigest(inputs: Pick<AttemptInputs, "brief_digest" | "plan_digest" | "references">): Digest {
	return digestOf({ brief_digest: inputs.brief_digest, plan_digest: inputs.plan_digest, references: inputs.references });
}

export function computePresentationDigest(presentation: AcceptancePresentation): Digest {
	return digestOf(presentation);
}
