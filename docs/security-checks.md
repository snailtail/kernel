# Security checks in CI

Every push to `main` and every pull request runs these checks (`.github/workflows/security.yml`, `codeql.yml`).
They also run weekly, so new advisories against unchanged code are found.

| Check | What it catches | Fails on |
|---|---|---|
| `npm audit --omit=dev` | Known vulnerabilities in production dependencies | high or critical |
| OSV scanner | The same, from the OSV database, including dev dependencies | any known vulnerability |
| gitleaks | Secrets committed anywhere in the history | any finding outside `server/test/` |
| Semgrep | OWASP Top 10, Node and TypeScript rules, plus `.semgrep/kernel.yml` (SQL built from input) | any finding |
| CodeQL | Data-flow analysis (injection, SSRF, path traversal…) with the security-extended queries | reported in code scanning |
| Trivy | Fixable high or critical vulnerabilities and secrets in the image that would be deployed | high or critical with a fix |
| SBOM | A CycloneDX list of everything in the image, kept as the `sbom` artifact of each run | – |

Supply chain:

- Third-party GitHub Actions are pinned by commit SHA, and workflows get read-only permissions unless a job needs more.
- The Node base image is pinned by digest. The runtime image contains no npm, npx or corepack, because Kernel needs only `node`.
- `npm ci --ignore-scripts` installs from the committed lockfile without running package install scripts.
- Dependabot opens grouped weekly updates for npm, the base image and the actions.

## When a check fails

1. **Fix it.** Upgrade the package (`npm install -w server pkg@version`), or change the code. Run the tests.
2. **The vulnerability does not apply** (e.g. a code path Kernel never calls): record a time-limited exception next
   to the check, never a blanket one.
   - For Trivy, add the id to `.trivyignore` with a comment: why it does not apply, who decided, and a review date
     at most 90 days ahead.
   - For Semgrep, put `// nosemgrep: <rule-id> -- <reason>` on the line.
   - For gitleaks, if a test value is flagged, move it under `server/test/`. Never widen the allowlist for real code.
3. **A real secret was committed:** rotate it first, then remove it. Removing it from git alone is not enough.

Kernel's own Semgrep rule rejects SQL text that interpolates request or input values. Values belong in query
parameters (`$1`, `$2`, …). Only constant fragments, column lists from a schema and placeholder numbers may be
interpolated.
