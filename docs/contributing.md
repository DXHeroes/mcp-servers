# Contributing

Use Node.js 22 and pnpm 10.32.0. Install with `pnpm install --frozen-lockfile` and run `pnpm check`
before submitting a change. The gate verifies independent package versions, the frozen catalog
contract, release assets, the independent CRM fixture, Biome, strict TypeScript, tests and builds.

Connector changes must preserve the public MCP surface unless the change intentionally versions the
contract. Document credential format, provider permissions, every tool/resource, destructive
behavior, response bounds and known provider limitations in the connector README. Tests should
exercise observable behavior, redaction and failures rather than mirroring implementation details.

Do not add runtime installers, arbitrary module/path execution, process spawning from caller input,
Docker/Kubernetes control, or discovery scans. Catalog data describes administrator-approved
offers. New external source builds require a pinned revision, explicit administrator approval and a
Docker context that excludes credentials and repository metadata before the first `COPY`.

Keep each connector's package, metadata, and catalog fixture versions aligned with each other.
Update catalog fixtures and the CRM example where relevant. Do not edit the frozen discovery schema without a separately
reviewed contract change and matching consumer work.

The repository has mixed licensing. New connectors, runtime, docs, templates and build plumbing are
MIT. The marketplace and skills are Apache-2.0. `packages/kit` and `packages/catalog/schema` retain
Elastic License 2.0 and their NOTICE/provenance. Do not move or relicense those files silently. See
[../LICENSES.md](../LICENSES.md).

Provider integration tests must use synthetic or dedicated accounts and never production data.
Supply test secrets through the environment, keep them out of logs/receipts, and clean up only
resources created by the test.

## Adding an OAuth connector

Start with the runnable [TypeScript OAuth template](../templates/typescript-oauth/README.md).
It is part of the workspace build/typecheck/test gate and demonstrates a delegated Microsoft
Graph read through the real connector runtime. The template is not a deployed catalog offer.

Register one static HTTP endpoint and catalog offer per service, with `auth: 'oauth'`, explicit
provider endpoints and minimum scopes. Document account eligibility, scope classification,
administrator consent and any app-review restrictions. The gateway owns OAuth, client secrets
and refresh; connectors accept only the user's current access token in `per_user` mode, separate
from the connector service bearer. Never accept a shared OAuth fallback or put tokens in tool
arguments, metadata or logs. Selected provider extras use the versioned, allowlisted
[runtime context](runtime.md#selected-oauth-provider-context).

Give tools stable service-prefixed names, strict input schemas and accurate read-only,
destructive and idempotency annotations. Bound the complete logical call to 20 seconds, including
pagination, retries and body reads. Keep provider URLs pinned and validate continuations; a page
token must never turn into an arbitrary fetch URL. Report only definite upstream credential
refusals with the canonical reconnect signal. Missing scope, throttles, timeouts and uncertain
writes must retain their own error behavior and must not cause unsafe write replay.

Use scrubbed/adapted provider recordings or synthetic fixtures at the provider boundary; verify
the complete operation surface, two accounts, expired/revoked tokens, throttling, cancellation
and safe errors through actual MCP HTTP. Record live dedicated-account read/write/readback and
gateway acceptance separately. A passing synthetic test, image build or catalog-schema check
does not prove provider admission, app approval or a published release.
