# 3. Language model providers and what may be sent to them

Date: 2026-10-10 · Status: accepted · Issues: #68, #50, #61, #53

## Context

Kernel's AI features must not depend on one vendor. Organisations want local models in their own environment
(Ollama, vLLM, LM Studio…) or cloud providers (Anthropic, OpenAI, Google…), chosen per task by cost, quality and,
above all, by where their data may go. Records hold personal data, secrets in pasted logs, and restricted security
records (ADR 0002).

## Decision

- **Standards and an established library**: the Vercel AI SDK with its official providers. The OpenAI-compatible
  provider covers Ollama, vLLM, LM Studio, LocalAI and LiteLLM. Anthropic, OpenAI and Google use their native
  providers. Versions are pinned to releases at least two weeks old and covered by the security scans. The SDK's
  telemetry is not enabled.
- **Off by default.** Nothing is sent until an administrator adds a provider (step-up, write-only encrypted key) and
  routes a task to one of its models. Every change is audited with a reason.
- **One gate**: `prepareForModel()` in `server/src/ai.ts`. The model client accepts only its branded output, so no
  call can skip it.
  - Each provider declares where it runs (`on_prem` or `cloud`) and the data classes it may receive: `internal`,
    `personal`, `restricted`.
  - Restricted records only go to an `on_prem` provider that allows `restricted`. The database enforces this too.
  - Contact details are never included.
  - Flagged attachments follow the AI data policy.
  - Secrets and personal identity numbers are redacted in everything sent.
  - When a part may not go to the provider, the call is refused, never silently trimmed.
- **Prompt injection**: record and log text is sent in delimited blocks, and the instructions say they are data. The
  in-app model has no tools. Its output is labelled as an AI suggestion, rendered as Markdown (never HTML), and is
  saved only when a person chooses to.
- **Transport**: every provider request goes through Kernel's outbound client: SSRF checks, credentials never follow
  redirects, timeouts and response caps. A local model on a private address needs that provider's own allowlist.
- **Limits**: a monthly token budget per provider and a per-user rate limit. On failure the answer is "AI
  unavailable". There is no fallback to another provider, which might be allowed less.
- **Observability**: OpenTelemetry GenAI attributes (system, model, tokens) without prompts or outputs. Each call is
  audited with user, task, provider, model, data classes, record refs and tokens, never content.
- **Log analysis**: logs are pre-filtered in Kernel before they are sent. Errors and warnings are kept with two lines
  of context, repeated lines are collapsed, and the model is told how many lines it saw.

## Consequences

- An installation without AI loses nothing.
- Adding a provider kind is a small change in `modelFor()`. The gate and the transport stay the same.
- Embeddings (similarity, clustering) and the other assistance features in #50 build on the same gate and providers.
