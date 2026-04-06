# Pass 1: Logic and Correctness

Scan for structural logic defects that produce wrong results, unreachable behavior, or silent failures.

## What to look for

**Dead and unreachable code:**
- Functions or branches that no call path reaches.
- Feature flags or config gates that are always true/false.
- Catch blocks or error handlers for exceptions that are never thrown.
- Enum values or switch cases that are defined but never matched.

**Off-by-one and boundary errors:**
- Loop bounds that skip the first or last element.
- Slice/substring ranges that are off by one.
- Comparison operators that should be `<=` instead of `<` (or vice versa).
- Array/index access without bounds checking.

**Null, undefined, and type coercion hazards:**
- Variables used before assignment or after conditional nulling.
- Optional values unwrapped without a nil/null check.
- Implicit type coercion that changes behavior (e.g., string-to-number, falsy values).
- Functions that sometimes return a value and sometimes return nothing.

**Boolean and conditional logic:**
- Conditions that are always true or always false.
- Negation errors (e.g., `!a || !b` vs `!(a && b)` misuse).
- Short-circuit evaluation that skips necessary side effects.
- Nested conditionals where branches overlap or have gaps.

**Return and control flow:**
- Missing return statements in branches.
- Early returns that skip cleanup or finalization.
- Fall-through in switch/match without explicit intent.
- Functions with inconsistent return types across branches.

## How to report

For each finding, record:
- **Location**: file path and function/method name.
- **Defect**: what is wrong, in one sentence.
- **Evidence**: what you observed that proves or strongly suggests the defect.
- **Severity**: critical (incorrect results in normal use), high (incorrect results in edge cases), medium (dead code or latent risk), low (style issue with correctness implications).
- **Evidence level**: observed fact / strong inference / open question.

## What to skip

- Style preferences (naming, formatting, comment density).
- Performance concerns (covered in other passes).
- Anything that requires runtime testing to confirm — mark those as open questions instead.
