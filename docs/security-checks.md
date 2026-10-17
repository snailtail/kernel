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
| ZAP baseline | Passive scan of a throwaway instance as an unauthenticated visitor sees it: headers, cookies, CSP, leaks | any warning not excepted in `.zap/baseline.conf` |

Supply chain:

- Third-party GitHub Actions are pinned by commit SHA, and workflows get read-only permissions unless a job needs more.
- The Node base image is pinned by digest. The runtime image contains no npm, npx or corepack, because Kernel needs only `node`.
- `npm ci --ignore-scripts` installs from the committed lockfile without running package install scripts.
- Scanner, ZAP and cosign images are pinned by tag and digest in `.github/tools/Dockerfile` (read with
  `scripts/tool-image.sh`), so Dependabot updates them like the base image.
- Dependabot opens grouped weekly updates for npm, the base image, the tool images and the actions.
- `main` is protected: the CI, Security and CodeQL checks must pass before a merge, history stays linear, and force
  pushes and deletion are refused.

## Signed images and deployment

On `main`, once the tests and the image build pass, the **Publish signed image** job (`ci.yml`) pushes the image to
`ghcr.io/snailtail/kernel:sha-<commit>` with an SBOM and build provenance attached, and signs its digest with
Sigstore keyless signing (cosign). No key is stored anywhere: the certificate names the workflow, the ref and the commit.

`scripts/deploy.sh` no longer builds on the server. On the host it pulls the image for the commit it deploys, then
`cosign verify` must confirm that the digest was signed by `.github/workflows/ci.yml` on `refs/heads/main` of this
repository **for that exact commit**. Only then is the digest tagged `kernel:latest` and started. A missing image
(CI not finished) or a failed verification stops the deploy and leaves the running version alone.
`scripts/deploy.sh --build <branch>` still builds on the server, unsigned, for trying a branch.

To check an image by hand:

```sh
cosign verify ghcr.io/snailtail/kernel:sha-<commit> \
  --certificate-identity https://github.com/snailtail/kernel/.github/workflows/ci.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-github-workflow-sha <commit>
```

If the package or the repository is private, log in on the host once with a token that can only read packages:
`docker login ghcr.io -u <user>` (a classic token with `read:packages` only). The deploy passes the login to cosign.

## When a check fails

1. **Fix it.** Upgrade the package (`npm install -w server pkg@version`), or change the code. Run the tests.
2. **The vulnerability does not apply** (e.g. a code path Kernel never calls): record a time-limited exception next
   to the check, never a blanket one.
   - For Trivy, add the id to `.trivyignore` with a comment: why it does not apply, who decided, and a review date
     at most 90 days ahead.
   - For Semgrep, put `// nosemgrep: <rule-id> -- <reason>` on the line.
   - For ZAP, add the rule to `.zap/baseline.conf` as `INFO` (reported, not failing) or as `OUTOFSCOPE` with the URL
     regex it applies to, and a comment saying why. Prefer fixing the header or response.
   - For gitleaks, if a test value is flagged, move it under `server/test/`. Never widen the allowlist for real code.
3. **A real secret was committed:** rotate it first, then remove it. Removing it from git alone is not enough.

Kernel's own Semgrep rule rejects SQL text that interpolates request or input values. Values belong in query
parameters (`$1`, `$2`, …). Only constant fragments, column lists from a schema and placeholder numbers may be
interpolated.
