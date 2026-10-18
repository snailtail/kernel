# Dev platforms

When a problem or change is fixed by writing code, the work happens in GitHub, GitLab or Azure DevOps. Kernel links
that work to its problems, changes and incidents, keeps the work's status current, and follows deployments. Set up a
source under **Administration → Dev platforms**.

## Links

- **From Kernel**: paste a link into a record's **Code** card, or let an agent call `link_dev_item`. Kernel recognises:
  - pull requests (merge requests), issues and work items;
  - commits;
  - workflow runs, pipelines and builds;
  - releases.
- **From the platform**: mention a Kernel ref (`CHG000017`, `chg-000017`, `PRB000042`, `INC000012`) in a PR title or
  description, a branch name or a commit message. The webhook then links it. A ref needs exactly six digits, so
  another tool's numbers (ServiceNow's `INC0010001`) never match. Restricted records are never linked from outside,
  and the platform is told nothing about them.

Pushes keep only commits that mention a record, at most 50 per delivery. PR bodies and email addresses are not stored.

## Sources and how deliveries are verified

| Platform | Accepts | Verification | Replays refused on |
| --- | --- | --- | --- |
| GitHub | `owner/repo` | `X-Hub-Signature-256`: HMAC-SHA256 of the body with the secret | `X-GitHub-Delivery` |
| GitLab (gitlab.com or self-hosted) | `group/project`, nested groups allowed | `X-Gitlab-Token`: the secret itself, compared in constant time | `X-Gitlab-Event-UUID` |
| Azure DevOps | `organisation/project` | Basic authentication: the secret is the password | `notificationId` + `id` |

The secret is shown once when the source is created, or when you choose **New secret**. A delivery from a repository
or project that is not on the source's list is refused, and so is one with the wrong secret. Both are counted as
refused on the source.

**Azure DevOps is weaker.** Service hooks cannot sign their deliveries, so whoever sees one delivery can send others.
Kernel therefore accepts them **only over HTTPS**, and refuses plain HTTP before it compares the secret.

Behind a proxy or tunnel that terminates TLS (a Cloudflare Tunnel, nginx, a load balancer), Kernel sees the request
as http unless it trusts the proxy's `X-Forwarded-Proto`. Set `KERNEL_TRUST_PROXY` (`true`, a hop count, or the proxy's
addresses). Without it, every Azure DevOps delivery is refused with "Kernel sees this request as http". For local
development only, `KERNEL_DEV_HOOKS_ALLOW_HTTP=true` accepts plain HTTP.

**Read-only token (optional).** Kernel uses it for titles and status of private repositories. It is stored encrypted
and is never shown again.

| Platform | Read-only token |
| --- | --- |
| GitHub | Fine-grained, with Contents, Metadata and Pull requests: read |
| GitLab | `read_api` |
| Azure DevOps | A PAT with Code, Work Items and Build: read |

A self-hosted GitLab on the internal network also takes its private ranges and its CA certificate. Loopback and
metadata addresses can never be opened this way.

## Deployments

Each source's **Deployments and status…** maps deployment targets: a repository (or project) and an environment name,
for example `acme/shop` + `production`, mapped to the CIs and services a deploy there changes.

| Platform | Deployment events |
| --- | --- |
| GitHub | `deployment_status` (environments in GitHub Actions) |
| GitLab | Deployment events |
| Azure DevOps | Release deployment completed (classic releases) |

A deployment links to the records its pull requests and commits are linked to. A deploy contains:
- items at its commit;
- pull requests merged since the last successful deploy to the same environment.

**Standard changes from production deploys.** This is off unless an admin turns it on for a production target and
chooses a standard change template. A successful deploy then registers a closed, successful standard change with:
- the target's CIs;
- the deploy's start and end, which feed change-incident correlation;
- the pull requests, commits and deployment it contained, as links.

The template's scope still applies: CI types, its risk ceiling, and change freezes. A deploy outside it registers
nothing, keeps the reason on the deployment, and is audited (`deploy_change_refused`), so someone can raise a normal
change. The same deploy delivered twice is one change.

**Outcomes are suggested, never decided.** On a change, linked deployments suggest:

| What happened | Suggestion |
| --- | --- |
| A rollback was deployed | The outcome *rolled back* |
| A deployment failed | The outcome *failed* |
| All linked pull requests are merged and deployed to production | Record the outcome and move to *review* |

The suggestion shows in the change's next steps, and is preselected in **Record outcome**. Nothing transitions by
itself.

## Status back on pull requests (opt-in)

With a **status token** and **Post the change status** on, Kernel posts `kernel/change` on pull requests linked to a
change:
- `success`: the change is authorised and inside its window ("CHG000017 authorised, window 2026-10-18 22:00–23:00
  UTC"), or implemented;
- `pending`: not yet authorised, or outside the window;
- `failure`: rejected or cancelled.

Make it a required check, and a merge waits for the change. It is posted when the PR is linked or updated, when the
change moves, and when its window opens or closes.

The status token is separate from the read-only token, so reading never needs write access:

| Platform | Status token |
| --- | --- |
| GitHub | Fine-grained, Commit statuses: write, and nothing else |
| GitLab | A project access token with `api`, on the listed projects only (GitLab has no narrower scope for statuses) |
| Azure DevOps | A PAT with Code (Status) only |

## API and MCP

REST:
- links: `/api/records/:ref/dev-links`;
- sources: `/api/dev-sources`;
- targets: `/api/dev-sources/:id/targets` and `/api/dev-targets/:id`;
- deliveries: `/api/dev-hooks/:id`.

MCP: `link_dev_item` and `list_dev_links`. Titles and authors come from the platform, written by people: agents get
them as `untrusted_content`.
