# Pass 3: Concurrency and Resource Management

Scan for race conditions, synchronization gaps, and resource leaks.

Read the concurrency model section from `findings/architecture/architecture-map.md` first to understand the system's threading model, async patterns, and synchronization approach.

## What to look for

**Race conditions and data races:**
- Shared mutable state accessed from multiple threads/goroutines/tasks without synchronization.
- Read-modify-write sequences that aren't atomic.
- Check-then-act patterns where the condition can change between the check and the action.
- Event handlers that mutate shared state without coordination.
- Counters or accumulators updated from concurrent contexts without atomic operations.

**Lock and synchronization issues:**
- Lock acquisition order that differs across call sites (deadlock risk).
- Locks held across I/O operations or await points (starvation risk).
- Missing locks on data structures documented as shared.
- Locks that protect the wrong scope (too narrow or too broad).

**Async and event-loop pitfalls:**
- Blocking calls inside async functions (blocking the event loop).
- `await` on operations that can hang indefinitely without timeout.
- Fire-and-forget async operations with no error handling.
- Callback-based APIs mixed with promise/async-await without proper bridging.
- Unbounded task/goroutine spawning without backpressure.

**Resource leaks:**
- File handles, sockets, or database connections opened without corresponding close.
- Resources acquired in constructors but not released in destructors/finalizers.
- Connection pools that grow without bounds or don't return connections on error.
- Temporary files created but not cleaned up on exit or failure.
- Event listeners or subscriptions registered but never unregistered.

**Timeout and cancellation:**
- Network or I/O operations with no timeout.
- Long-running operations with no cancellation mechanism.
- Cancellation tokens or contexts that are passed through but never checked.
- Graceful shutdown paths that don't drain in-flight work.

## How to report

For each finding, record:
- **Location**: file path and function/method name.
- **Defect**: what concurrent or resource scenario is mishandled.
- **Evidence**: the specific shared state, missing synchronization, or unclosed resource.
- **Severity**: critical (data corruption or deadlock in normal operation), high (race condition in common paths), medium (resource leak under error conditions), low (theoretical race in rarely-exercised path).
- **Evidence level**: observed fact / strong inference / open question.

## What to skip

- Single-threaded code with no async — this pass is irrelevant if the architecture has no concurrency.
- Performance-only concerns (slow locks, suboptimal pool sizes) — unless they cause correctness issues.
