// Engineering records: the barrel for core/engineering/ (E01, #399).
//
// The v1 contract for supervised, host-executed, evidence-backed changes:
// record types and enum spellings (types), ID grammar and the namespace
// layout (ids), canonical digests (digest), and the pure validators
// (validation). Import order is one way — types → ids, digest → validation —
// and tests/engineering-contract.test.mjs pins it. `core/index.ts` re-exports
// this module, so both surfaces and downstream engineering modules (E02–E07)
// see one contract.
//
// Nothing here stores, executes, or approves. The store, the snapshot
// collector, the gate, and the MCP adapter are later issues and consume
// these shapes as merged rather than restating them.

export * from "./types.ts";
export * from "./ids.ts";
export * from "./digest.ts";
export * from "./validation.ts";
export * from "./snapshots.ts";
export * from "./store.ts";
