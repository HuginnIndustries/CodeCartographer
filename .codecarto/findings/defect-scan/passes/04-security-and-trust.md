# Pass 4: Security and Trust Boundaries

Scan for vulnerabilities in input validation, authentication, authorization, secret handling, and trust boundary enforcement.

If `findings/contracts/behavioral-contracts.md` exists, read the Security and Authorization section first — it documents the intended auth model. Compare what you find in code against what the contracts say should happen.

## What to look for

**Input validation gaps:**
- User input passed to database queries, shell commands, file paths, or template engines without sanitization.
- Missing length limits on string inputs (buffer-adjacent risks, DoS vectors).
- File upload paths without extension/type/size validation.
- URL or redirect parameters that accept arbitrary destinations (open redirect).
- Deserialization of untrusted input without schema validation.

**Authentication weaknesses:**
- Endpoints or functions that should require authentication but don't check.
- Token validation that checks expiry but not signature (or vice versa).
- Password comparison using non-constant-time equality.
- Session tokens with insufficient entropy or predictable generation.
- Auth bypass via parameter manipulation (e.g., changing user ID in request).

**Authorization gaps:**
- Actions that check "is user logged in" but not "is user allowed to do this."
- Horizontal privilege escalation: user A can access user B's resources by changing an ID.
- Vertical privilege escalation: non-admin can reach admin-only functionality.
- Missing authorization checks on state-changing operations (writes, deletes) even when reads are protected.
- Role or permission checks that happen in the UI but not in the backend.

**Secret management issues:**
- API keys, tokens, passwords, or connection strings hardcoded in source.
- Secrets logged in plaintext (in log statements, error messages, or debug output).
- Secrets passed via URL query parameters (visible in logs, referrer headers, browser history).
- `.env` files, credential files, or key files not in `.gitignore`.
- Secrets with no rotation mechanism or expiry.

**Trust boundary violations:**
- Internal APIs that accept data from external sources without re-validation.
- Client-side validation without server-side enforcement.
- Inter-service communication without mutual authentication.
- Data from one tenant accessible to another (multi-tenancy isolation failures).

**Web security (if applicable):**
- Missing CORS restrictions or overly permissive CORS headers.
- Missing Content-Security-Policy headers.
- Cross-site scripting (XSS) via unescaped user content in HTML output.
- Cross-site request forgery (CSRF) on state-changing endpoints without token verification.
- Missing rate limiting on authentication endpoints.

## How to report

For each finding, record:
- **Location**: file path and function/method name.
- **Defect**: what security property is violated.
- **Evidence**: the specific code path, missing check, or exposed secret.
- **Severity**: critical (actively exploitable, data exposure, auth bypass), high (exploitable with some effort or preconditions), medium (defense-in-depth gap, hardcoded non-production secret), low (missing header, informational disclosure).
- **Evidence level**: observed fact / strong inference / open question.

## What to skip

- Dependency vulnerability scanning (CVEs in third-party packages) — that's a tooling concern, not a code analysis task.
- Cryptographic algorithm choices — unless they're demonstrably broken (e.g., MD5 for password hashing).
