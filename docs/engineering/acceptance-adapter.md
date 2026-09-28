# The MCP acceptance adapter (E08)

How a person accepts a change through an MCP client, and what the adapter does and does not establish. The contract is [record-contract.md](record-contract.md) (§ The receipt path, § Acceptance channel: a conditional pilot policy, § D1 live check); this page describes the code that implements it: `core/engineering/acceptance.ts` and the `request_acceptance` action of `codecarto_change` in `mcp-server/engineering.ts`.

## What the action does

`codecarto_change` with `action: request_acceptance` and `{ cwd, change_id, attempt_id }`:

1. Loads the change, slice, attempt, bound candidate snapshot, proofs, and reviews from the store. The attempt must be `ready-for-review` or `needs-human-acceptance` with a bound candidate.
1. **Re-reads the working tree and runs the gate (receipt path step 1).** `mcp-server/working-tree.ts` re-reads `cwd` in the candidate's own scope (same exclusions; `.git/` skipped; HEAD read from `.git/HEAD`, never by running git) and `requestAcceptance` passes it to `evaluateAcceptanceGate` as `candidate_reread`. Unless the gate says `may-accept`, **no request is issued and nobody is asked**: a refused gate returns `{ outcome: "blocked", gate_state, blockers, limitations, reason }` (the blockers rendered by `describeGateOutcome`), a tree that cannot be re-read returns `needs-human-acceptance` with that reason. A tree edited after capture is refused as `proof-stale` ("the working tree no longer matches candidate …"). The `gate` action takes the same re-read, so its freshness verdict and this one agree.
1. **Refuses a duplicate.** An existing approval with `decision: accepted` bound to this candidate (same snapshot id and digest) refuses with `invalid-state` / `already-accepted`; a decision already taken is not solicited twice. While a request is being presented, an `O_EXCL` marker `requests/.in-flight` under the attempt serializes request→present→mint, so two concurrent calls mint at most one approval; the marker records the request's `expires_at` and a marker past it (a crashed server) is cleared by the next caller. The store's change lock is deliberately **not** held across the elicitation wait — it would block unrelated proof and review writes for up to the TTL.
2. Derives `HostCapabilities` from the **session**, never from the request: `human_acceptance` is `mcp-elicitation` iff the client declared `elicitation.form` at `initialize`, else `none`; `client` is the transport's `clientInfo`; `label` is `mcp-server` (the host label the registry is keyed by, together with the client name, exact client version, and channel); `assurance_policy` is always `verified` (D5). `storage_boundary`, `tool_result_path`, and the reader's `current_storage` have no host-configuration mechanism yet and default to the least-trusted values (`none`).
3. Builds the acceptance request with `buildAcceptanceRequest` and stores it durably under the attempt's `requests/` before anything is shown.
4. Calls `acceptanceChannelSupported`. **Unsupported** — no channel, or a host/client pair not in `VERIFIED_ACCEPTANCE_INTEGRATIONS` at the exact live client version — returns `{ outcome: "needs-human-acceptance", reason, request_id }` and mints nothing; the client is never asked.
5. **Supported** only: sends one `elicitation/create` form whose message is the presentation and whose only fields are a required `decision` enum (`accept`/`reject`) and an optional `note`; the request TTL (≤ 120 s, and strictly below the registered `client_request_timeout_ms`) is also the SDK request timeout. The answer is read with `elicitationDecision` — from `content.decision` only. `rejected`, `declined`, `cancelled`, `timed-out`, and `invalid` store nothing beyond the request.
6. For `accepted` only, mints an `ApprovalRecord` in-process (receipt bound to the request's nonce, presentation digest, client, channel, and session), runs `evaluateApprovalReceipt` against the **stored** request and the other approvals' nonces **before** writing, persists only when it passes, and returns `classifyAcceptance`'s reading alongside it. A stale answer (after `expires_at`) or a mismatched request is `refused` and nothing is minted.

Nothing a tool argument or the model supplies can set a capability or carry a decision: `host`, `assurance`, `verified_integration`, `storage`, `current_storage`, `protection`, `tool_result_path`, `client`, `registry`, `decision`, `approve`, `receipt`, … are refused by name. `approve` and `accept` remain refused actions.

## The registry is empty

`VERIFIED_ACCEPTANCE_INTEGRATIONS` is empty, so today **every host returns `needs-human-acceptance`** from `request_acceptance`, whatever the client advertises. The request is still stored so a later supported host can answer it while it is unexpired.

Registering a pair is a separate contract amendment attaching evidence of a real integration check on the actual client at the recorded version — the contract's five observations: (1) the presentation was shown to a person as issued; (2) an acceptance came back and minted a bound approval; (3) a rejection and a cancellation/decline each came back as `rejected`/`declined` with nothing minted; (4) a stale response and a mismatched response were each refused by `evaluateApprovalReceipt` with nothing minted; (5) the client's request timeout was observed and recorded as `client_request_timeout_ms`. D1 adds the **operator attestation** that no `Elicitation` or `ElicitationResult` hooks are configured in any merged settings source — the adapter cannot see hooks, so every receipt's `attestation` says it rests on that claim.

## What the maintainer adds after a live check

Once the five observations above have been recorded against a real client, the registry entry — and only the entry — is the amendment. Its shape, with the fields that must come from the live check itself:

```ts
{
	host: "mcp-server",                       // ACCEPTANCE_HOST_LABEL: the process that runs the adapter and mints the receipt
	client: "claude-code",                    // clientInfo.name as the transport reported it during the check
	client_version: "<exact version observed live>", // clientInfo.version verbatim; the adapter matches it exactly, so a bump re-opens the check
	channel: "mcp-elicitation",
	client_request_timeout_ms: <timeout observed during the check>, // the client's own request timeout; the adapter's TTL must sit strictly below it
	evidence: "<link to the recorded check>", // the transcript/recording of the five observations plus the hook attestation
}
```

Nothing else changes: `assurance_policy` stays `verified`, the adapter's storage defaults stay least-trusted, and the registry stays a compile-time constant (no environment variable or config path reaches it).

## Known wart: `assurance` on the approval vs. the presentation

The presentation shown to the person says `Assurance policy: verified` (the operator's policy, D5), while the minted approval must record `assurance: cooperative` because the storage boundary is `none` — the record validator refuses `verified` over an unprotected namespace. `classifyAcceptance` then reports two reasons that read as if something went wrong (the record does not call itself verified; the storage boundary is not host-enforced) when in fact the record is saying the only honest thing it can. The result is misleading wording, not a wrong class. Documented here only; the orchestrator files the follow-up.

## Classification on this host

Even on a registered pair, an acceptance obtained on claude-code classifies **`cooperative`** by D3: this host provides no protected home for the storage boundary's history, so `protection` never reaches `continuous-since-initialization`, and the adapter's own storage boundary defaults to `none`. The approval record says `assurance: cooperative` and `storage.boundary: none`, and the result carries `classification` with the reasons.

## Tests and the test-only registry seam

`tests/engineering-acceptance-adapter.test.mjs` drives the real server (`buildServer` + `serveStdio`, the same factory `bin.mjs` uses) over stdio with a scripted client that answers `elicitation/create`, against a real temp store. Because the shipped registry is empty, the supported path is exercised through `buildServer({ acceptanceRegistry })`, an `@internal` option (stripped from the published `.d.ts`) reachable only from `tests/helpers/acceptance-server.mjs`; `bin.mjs` calls `startStdioServer()`, which passes no options, and no environment variable or config file feeds it.

## Not in this revision

- The 2026-07-28 multi-round-trip (`InputRequiredResult`) path: the `Presenter` seam is where it would plug in; no client on hand speaks it.
- Host/user-level configuration for `storage_boundary`, `tool_result_path`, and `current_storage`.
- Editing the attempt record to `needs-human-acceptance` or `accepted`: records under `attempts/` are create-only in the store; the outcome is carried by the stored request, the approval, and the result. Consequently `planTraverseStep` still sees the attempt as `ready-for-review` after an acceptance has been minted (it plans a review/acceptance step rather than stopping), and after an `already-accepted` refusal it reports the same; the gate, not the traverse planner, is what refuses a second solicitation.
- No live client has been exercised against this code; the scripted client is not the integration check the registry requires.
