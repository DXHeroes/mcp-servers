# DX Heroes MCP servers

Public source for seven deployable MCP connectors, an authenticated standalone runtime, a catalog
service, and an optional trusted polyglot bundle. The normal deployment is one container per MCP
server. The bundle is for administrator-reviewed projects that deliberately share one container
security boundary.

## Claude marketplace

Install the public marketplace and its `create`, `add`, and `deploy` skills:

```sh
claude plugin marketplace add DXHeroes/mcp-servers
claude plugin install mcp-servers@mcp-servers
```

The skills run read-only preflight checks and produce an exact plan before any publication,
deployment, catalog registration, restart, or secret change. Those operations require explicit
administrator approval of the concrete plan.

MCP is a wire protocol, not a TypeScript-only framework. These images include servers built with
the official TypeScript SDK, the official Python SDK, and a plain Express implementation of MCP.
An ordinary REST API is not MCP; import its OpenAPI description in Local MCP Gateway instead.

## What is here

| Component | Image | Purpose |
| --- | --- | --- |
| Abra Flexi | `ghcr.io/dxheroes/mcp-abra-flexi` | Czech ERP and accounting |
| ByzData | `ghcr.io/dxheroes/mcp-byzdata` | Czech public company data |
| Fakturoid | `ghcr.io/dxheroes/mcp-fakturoid` | Invoicing and expenses |
| Gemini Deep Research | `ghcr.io/dxheroes/mcp-gemini-deep-research` | Long-running cited research |
| Merk | `ghcr.io/dxheroes/mcp-merk` | Czech and Slovak company intelligence |
| PostgreSQL | `ghcr.io/dxheroes/mcp-postgres` | Bounded read and explicit write SQL tools |
| Toggl Track | `ghcr.io/dxheroes/mcp-toggl` | Time tracking and reports |
| Catalog | `ghcr.io/dxheroes/mcp-catalog` | Validated discovery offers |
| Trusted bundle | `ghcr.io/dxheroes/mcp-bundle` | Optional prepared multi-language services |

Connector-specific credentials, permissions, tool names and limitations are documented in each
`connectors/<id>/README.md`. Runtime details are in [docs/runtime.md](docs/runtime.md), and the two
deployment shapes are explained in [docs/architecture.md](docs/architecture.md).

## Local quickstart

Use Node.js 22 and pnpm 10:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Build and run ByzData, which needs no upstream credential. Transport authentication is still
mandatory:

```sh
export MCP_ACCESS_TOKEN="$(openssl rand -hex 24)"
docker build -f Dockerfile.connector --build-arg CONNECTOR=byzdata -t mcp-byzdata:local .
docker run --rm --read-only --user 12345:12345 --cap-drop ALL \
  --security-opt no-new-privileges -p 127.0.0.1:8080:8080 \
  -e MCP_ACCESS_TOKEN \
  -e MCP_ALLOWED_HOSTS=localhost,127.0.0.1 \
  mcp-byzdata:local
curl -fsS -H "Authorization: Bearer $MCP_ACCESS_TOKEN" http://127.0.0.1:8080/health
```

For a credentialed connector, provision `MCP_UPSTREAM_CREDENTIAL` separately from
`MCP_ACCESS_TOKEN`. Prefer `_FILE` variables and a read-only secret mount in deployments. Never put
either value in a catalog manifest, image, Git repository, command argument, or URL.

## Discovery quickstart

Discovery is an administrator-authored list of offers. It never scans containers, checks live MCP
health, builds source, installs dependencies, or runs advertised code. One catalog can list
endpoints from separate containers and from a bundle.

```sh
export MCP_CATALOG_TOKEN="$(openssl rand -hex 24)"
pnpm build
node scripts/catalog-manifest.mjs fixtures/deployment-endpoints.example.json > catalog.json
docker build -f Dockerfile.catalog -t mcp-catalog:local .
docker run --rm --read-only --user 12345:12345 --cap-drop ALL \
  --security-opt no-new-privileges -p 127.0.0.1:8090:8080 \
  -v "$PWD/catalog.json:/run/catalog.json:ro" \
  -e MCP_CATALOG_MANIFEST=/run/catalog.json \
  -e MCP_ACCESS_TOKEN="$MCP_CATALOG_TOKEN" \
  -e MCP_ALLOWED_HOSTS=localhost,127.0.0.1 \
  mcp-catalog:local
curl -fsS -H "Authorization: Bearer $MCP_CATALOG_TOKEN" \
  http://127.0.0.1:8090/catalog/v1/servers
```

The catalog source token, a connector service access token, and a user's upstream credential are
three different secrets. A compatible gateway stores the connector service token in its encrypted
service-auth field and sends it as `Authorization`; it encodes the raw upstream secret separately
for `X-MCP-Upstream-Credential`. Do not reuse the catalog token or place service tokens in generic
headers.

An `api_key` shared catalog offer requires the administrator to provision an upstream credential at
install time. If a connector is intentionally deployed with its own fixed shared credential, list a
separate stable shared-only `auth.type: none` offer; its transport service bearer remains required.
A per-user offer can point to the same endpoint under a different stable ID and must declare
`connector_base64url`; missing personal credentials fail and never inherit the deployment secret.

## Add an independently authored server

Copy [templates/typescript-crm](templates/typescript-crm) into a new, unrelated repository. It has
its own npm lockfile, Dockerfile, tests, release workflow, digest-pinned deployment example and
catalog entry. It uses only published official MCP packages. The example proves a client-owned
repository can build without this monorepo or a private package.

Administrators may check out other client repositories during an image build only at an immutable
reviewed revision. Checkout credentials must stay outside the Docker context, layers, logs and
image. Runtime Git/npm/pip installs are prohibited. Native modules, wheels and virtualenvs must be
built for the final OS, libc, architecture, interpreter and absolute path.

The portable [mcp-server-create](skills/mcp-server-create/SKILL.md),
[mcp-server-add](skills/mcp-server-add/SKILL.md), and
[mcp-server-deploy](skills/mcp-server-deploy/SKILL.md) skills require an explicit immutable
public-kit checkout and never assume this workspace is next to the skill installation.

## Releases and security

Pull-request CI runs version/schema/fixture checks, the independent template, lint, typecheck,
tests, builds, and every container target. Component tags such as `postgres-v0.1.2` build only that
independently versioned linux/amd64 and linux/arm64 image on native runners with pinned actions,
BuildKit, SBOM generator, Trivy and cosign. Both platform variants must
pass the vulnerability gate; the signed multi-platform index includes both variants and their
SBOM/provenance attestations. See [docs/releasing.md](docs/releasing.md).

Read [docs/security.md](docs/security.md) before exposing an endpoint. Report vulnerabilities using
the repository's private security-reporting channel rather than a public issue.

## License

This is a mixed-license repository. Connectors, runtime, bundle, templates, documentation, and
newly authored build plumbing are MIT. The marketplace and skills are Apache-2.0. The extracted and
modified connector kit and frozen catalog schema retain Elastic License 2.0. See
[LICENSES.md](LICENSES.md); do not treat the repository as a single-license work.
