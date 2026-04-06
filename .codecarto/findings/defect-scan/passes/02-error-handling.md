# Pass 2: Error Handling and Resilience

Scan for gaps in how the system detects, propagates, and recovers from errors.

## What to look for

**Swallowed errors:**
- Empty catch/except blocks.
- Catch blocks that log but don't re-raise or propagate.
- Error callbacks that are registered but do nothing.
- Promise/future chains with missing `.catch` or error handlers.

**Inconsistent error propagation:**
- Functions that throw in some error paths but return error codes in others.
- Mixed error strategies within the same module (exceptions vs. result types vs. error codes).
- Error types that lose context when re-wrapped (original cause discarded).
- Errors that silently convert to default values instead of surfacing.

**Missing cleanup in error paths:**
- Resources (files, connections, locks) opened before a try block but not closed in the finally/error path.
- Temporary state mutations that aren't rolled back on failure.
- Partial writes that leave data in an inconsistent state.
- Transaction-like operations without rollback on failure.

**Uncaught exception paths:**
- Async operations without error handlers.
- Background tasks or worker threads with no top-level catch.
- Event handlers that can throw but aren't wrapped.
- Constructors or init methods that throw without cleanup.

**Retry and recovery gaps:**
- Network or I/O operations with no retry logic where transient failures are expected.
- Retry loops with no backoff, no jitter, or no max-attempts cap.
- Recovery paths that retry the exact same operation without fixing the underlying condition.
- Circuit breaker patterns that are partially implemented (open state but no half-open recovery).

**Error reporting and observability:**
- Errors that are caught but not logged anywhere.
- Log messages that omit the error type, message, or stack trace.
- Errors that surface to users as generic "something went wrong" without actionable detail.
- Health checks or monitoring that don't cover known failure modes.

## How to report

For each finding, record:
- **Location**: file path and function/method name.
- **Defect**: what error scenario is mishandled.
- **Evidence**: the specific code pattern or path that demonstrates the gap.
- **Severity**: critical (data loss or corruption on failure), high (silent failure in normal operations), medium (poor error messages or missing cleanup), low (observability gap).
- **Evidence level**: observed fact / strong inference / open question.

## What to skip

- Error handling style preferences (exceptions vs. result types) — unless the inconsistency within a module creates actual bugs.
- Logging format choices — unless errors are genuinely unobservable.
