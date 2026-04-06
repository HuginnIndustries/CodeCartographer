# Pass 5: API Contract Violations

Scan for functions, endpoints, and interfaces whose implementation doesn't match their documented or declared behavior.

This pass is most powerful when `findings/contracts/behavioral-contracts.md` and `findings/protocols/protocols-and-state.md` exist. If available, read them first and use them as the spec to compare against. If not available, use the code's own documentation (docstrings, comments, type signatures, README) as the spec.

## What to look for

**Return type inconsistencies:**
- Functions whose docstring or type signature says they return X, but some branches return Y or nothing.
- APIs documented to return a specific shape, but error cases return a different shape.
- Nullable returns from functions not marked as nullable/optional.
- Collection-returning functions that sometimes return null instead of empty.

**Documented behavior vs. actual behavior:**
- Parameters documented as required that have silent defaults in implementation.
- Side effects (writes, network calls, state mutations) not mentioned in docs or type signatures.
- Functions documented as pure/idempotent that actually mutate state.
- Default values documented in one place but implemented differently.
- Error behavior documented as "throws X" but actually throws Y or returns an error code.

**Interface contract breaks:**
- Classes or modules that implement an interface but skip or stub required methods.
- Event emitters that document events but never emit some of them.
- Callback signatures that don't match what callers pass.
- Middleware or plugin hooks with undocumented ordering dependencies.

**State machine violations (spec-grounded):**
- If protocols phase output is available: transitions that the implementation allows but the state machine says shouldn't happen.
- State that can be entered but has no exit transition.
- Guards documented as required but not enforced in code.
- Side effects that should only fire on specific transitions but fire unconditionally.

**Behavioral contract drift:**
- If contracts phase output is available: features whose trigger/defaults/output/error-behavior in code differs from what the contracts document.
- Black-box acceptance scenarios from the contracts that the code would fail.
- Features documented as available on a surface (CLI, API, etc.) but missing or broken in the implementation for that surface.

**Version and compatibility:**
- APIs that changed behavior between versions without documentation.
- Deprecation warnings that reference alternatives that don't exist yet.
- Backward-compatibility promises broken by recent changes.

## How to report

For each finding, record:
- **Location**: file path and function/method name.
- **Defect**: what contract is violated and how.
- **Spec source**: where the expected behavior is documented (docstring, type signature, contracts phase, protocols phase, README).
- **Evidence**: the specific divergence between spec and implementation.
- **Severity**: critical (public API returns wrong results), high (documented behavior incorrect in edge cases), medium (internal API inconsistency), low (stale docs, minor parameter mismatch).
- **Evidence level**: observed fact / strong inference / open question.

## What to skip

- Style-level doc issues (typos, formatting) — unless they make the documented behavior ambiguous.
- Test coverage gaps — unless a specific contract has no tests AND the implementation looks suspicious.
