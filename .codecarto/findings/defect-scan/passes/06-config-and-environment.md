# Pass 6: Configuration and Environment Hazards

Scan for hardcoded values, missing validation, dangerous defaults, and environment assumptions that cause failures in deployment or operation.

If `findings/contracts/behavioral-contracts.md` exists, read the Configuration Model section first.

## What to look for

**Hardcoded values that should be configurable:**
- URLs, hostnames, ports, or IP addresses embedded in source code.
- Timeouts, retry counts, or buffer sizes that are magic numbers.
- Feature behavior gated on string comparisons against environment names (e.g., `if env == "production"`).
- File paths that assume a specific OS or directory structure.
- Locale, timezone, or encoding assumptions baked into code.

**Missing configuration validation:**
- Config loaded at startup with no schema validation (malformed config silently produces wrong behavior).
- Numeric config values with no range checks (negative timeouts, zero-size pools).
- String config values used in security-sensitive contexts without sanitization (e.g., config-driven SQL, file paths).
- Required config keys that are silently absent, falling back to dangerous defaults.

**Dangerous defaults:**
- Debug mode, verbose logging, or development-only features enabled by default.
- Security features (auth, TLS, rate limiting) disabled unless explicitly turned on.
- Default credentials or tokens that ship with the code.
- Default config that works in development but fails or is unsafe in production.

**Environment coupling:**
- Code that assumes a specific OS (path separators, shell commands, temp directories).
- Network assumptions (localhost availability, DNS resolution, specific ports being free).
- Filesystem assumptions (case sensitivity, symlink support, file locking behavior).
- Runtime version assumptions not enforced by manifests or checks.

**Configuration propagation issues:**
- Config changes that require a restart but aren't documented as such.
- Config values read once at startup and cached, ignoring later changes.
- Environment variables that override config files in undocumented ways.
- Config inheritance chains where a middle layer silently drops values.

**Deployment and operational hazards:**
- Migrations or schema changes that run automatically without confirmation.
- Startup sequences that fail silently if a dependency is unavailable.
- Health checks that report healthy when critical subsystems are down.
- Log output that contains sensitive config values (secrets, connection strings).

## How to report

For each finding, record:
- **Location**: file path and function/method name.
- **Defect**: what configuration or environment hazard exists.
- **Evidence**: the specific hardcoded value, missing validation, or dangerous default.
- **Severity**: critical (security exposure in default config, data loss on misconfiguration), high (production failure from missing validation), medium (hardcoded value that will break in a different environment), low (undocumented config behavior).
- **Evidence level**: observed fact / strong inference / open question.

## What to skip

- Config file format preferences (YAML vs TOML vs JSON) — unless the format causes actual parsing ambiguity.
- Deployment orchestration choices (Docker vs bare metal) — unless the code assumes one and breaks on the other.
