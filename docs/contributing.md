# Contributing

Use Node.js 22 and pnpm 10.32.0. Install with `pnpm install --frozen-lockfile` and run `pnpm check`
before submitting a change. The gate verifies one repository version, the frozen catalog contract,
release assets, the independent CRM fixture, Biome, strict TypeScript, tests and builds.

Connector changes must preserve the public MCP surface unless the change intentionally versions the
contract. Document credential format, provider permissions, every tool/resource, destructive
behavior, response bounds and known provider limitations in the connector README. Tests should
exercise observable behavior, redaction and failures rather than mirroring implementation details.

Do not add runtime installers, arbitrary module/path execution, process spawning from caller input,
Docker/Kubernetes control, or discovery scans. Catalog data describes administrator-approved
offers. New external source builds require a pinned revision, explicit administrator approval and a
Docker context that excludes credentials and repository metadata before the first `COPY`.

Keep package and connector metadata versions aligned with the root version. Update catalog fixtures
and the CRM example where relevant. Do not edit the frozen discovery schema without a separately
reviewed contract change and matching consumer work.

The repository has mixed licensing. New connectors, runtime/docs/templates/skills and build
plumbing are MIT. `packages/kit` and `packages/catalog/schema` retain Elastic License 2.0 and their
NOTICE/provenance. Do not move or relicense those files silently. See [../LICENSES.md](../LICENSES.md).

Provider integration tests must use synthetic or dedicated accounts and never production data.
Supply test secrets through the environment, keep them out of logs/receipts, and clean up only
resources created by the test.
