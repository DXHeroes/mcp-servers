# Runtime interfaces

Build with `pnpm install --frozen-lockfile && pnpm build`. Every connector package exports its
existing authoring interface and a `mcp-<id>` executable. From this workspace, run
`node connectors/toggl/dist/cli.js --http` or `--stdio` (replace `toggl` with a connector ID).
The official MCP SDK 2.0.0 supports modern `2026-07-28` and legacy `2025-11-25` clients.

HTTP serves `/mcp` using stateless requests, with one connector instance per request. Health is
`GET /health`. Diagnostics use stderr; stdout in stdio mode contains only JSON-RPC.

| Input | Meaning |
| --- | --- |
| `MCP_ACCESS_TOKEN` or `MCP_ACCESS_TOKEN_FILE` | Mandatory transport bearer token for HTTP. |
| `MCP_UPSTREAM_CREDENTIAL` or `MCP_UPSTREAM_CREDENTIAL_FILE` | Optional shared upstream secret; required to perform credentialed operations without a request secret. |
| `MCP_HOST`, `MCP_PORT` | Bind address and port; defaults `0.0.0.0`, `8080`. |
| `MCP_ALLOWED_HOSTS` | Required comma-separated hostnames; ports are ignored, wildcards unsupported. IPv6 uses brackets. |
| `MCP_ALLOWED_ORIGINS` | Allowed exact origins, including scheme and port; absent Origin is accepted. Default allows no browser origin. |
| `MCP_LOCAL_TEST_MODE=true` | Allows tokenless testing only when explicitly bound to `127.0.0.1` or `::1`. |

A file and environment value for the same secret are mutually exclusive. Files may have one
trailing newline. Read-only secret mounts work with arbitrary UIDs when the file permissions
permit that UID to read them. Supply upstream secrets using the connector's existing credential
format, without adding transport authentication to them.

HTTP authentication is `Authorization: Bearer <transport token>`. Upstream credentials use
`X-MCP-Upstream-Credential: <canonical unpadded base64url UTF-8 secret>`. The mode header is
`X-MCP-Credential-Mode: shared|per_user`; absence means shared. Personal mode requires an explicit
request secret even when deployment credentials exist. Shared mode uses a request secret when
provided, otherwise the deployment secret. Duplicate reserved headers, invalid modes, malformed
base64url and invalid UTF-8 are refused. Transport identity is never passed to the connector.
ByzData needs no upstream credential but its HTTP listener still requires transport authentication.
In stdio mode credentials are process-bound environment/file inputs; there is no HTTP bearer.
The standalone `GET /health` response is deliberately credential-free readiness metadata and
contains no connector or upstream detail; protect it with network policy if even readiness must be
private. Bundle health has its own authenticated edge behavior described in `bundle.md`.

Bodies are limited to 2 MiB; headers to 64 KiB; at most 128 requests are admitted concurrently.
Requests have an absolute 60-minute ceiling and five-minute idle operation budget. Gemini polls
report progress only when the caller supplies a progress token; healthy polling resets idle time,
never total time. Cancellation aborts provider HTTP requests and polling sleep. Once a Gemini
interaction ID exists, cancellation attempts a separately bounded five-second provider cancel;
provider-side work may continue if that attempt fails. PostgreSQL retains its existing per-operation
32-second client deadline plus bounded connection cleanup; aborting an MCP call does not certify
that SQL stopped on the database. Shutdown gives cleanup ten seconds before process termination.

Clients with shorter deadlines must explicitly request progress and own a transport they can
close when cancelling a legacy stateless call. A catalog entry cannot grant execution budgets.

## Catalog

`node packages/catalog/dist/cli.js` serves `GET /catalog/v1/servers` from the explicitly mounted
JSON/YAML file named by `MCP_CATALOG_MANIFEST`. Use its own `MCP_ACCESS_TOKEN[_FILE]`, or explicitly
set `MCP_CATALOG_PUBLIC=true` for public metadata. Connector transport tokens remain separate.
Host/origin and listener settings are the same as above. `GET /health` reports source readiness.
Every request reloads the file; invalid updates retain the previous snapshot internally but return
503 for discovery and readiness until a complete valid file is available. Empty valid manifests
publish an empty offer list. No filesystem contents, secret values, Docker APIs or network scans
are exposed.

The frozen schema is `packages/catalog/schema/catalog-discovery.schema.json` (Elastic-2.0).
The shared contract fixture is `fixtures/catalog.v1.json`. Duplicate IDs, unsafe URLs, malformed
UTF-8, YAML aliases/duplicates and the 2 MiB byte limit are also checked at runtime. Explicit private
network deployment URLs are allowed; consuming gateways enforce their own outbound policy.
Discovery is not a live health check and never installs, builds or runs the advertised code.

Generate a manifest from an explicit deployment map:
`node scripts/catalog-manifest.mjs fixtures/deployment-endpoints.example.json`.
Replace every example URL with an actual deployment endpoint. The generator never guesses
localhost endpoints. Credentialed connectors advertise `connector_base64url` delivery and both
shared/personal modes; ByzData advertises none/shared. Documentation URL fragments are removed to
match the discovery URL contract.

## Containers and validation

Build `docker build -f Dockerfile.connector --build-arg CONNECTOR=toggl -t mcp-toggl .` or
`docker build -f Dockerfile.catalog -t mcp-catalog .`. Only the seven explicit connector IDs are
accepted. Containers install dependencies at build time, run as UID 65532, support arbitrary UIDs,
and run with `--read-only --cap-drop ALL --security-opt no-new-privileges`. Override the connector
command with `--stdio` for local clients. TLS termination belongs to the deployment ingress.
Never expose a connector bearer token over an untrusted plaintext network.

`pnpm check` includes actual SDK HTTP/stdio tests. `python3 scripts/test-containers.py` builds and
runs all eight images, tests both protocol eras, performs real Toggl HTTPS fixture and PostgreSQL
calls, tests arbitrary UID/read-only operation, and removes only its own containers/network.
Set `POSTGRES_TEST_PASSWORD` and optionally `POSTGRES_TEST_PORT`/`POSTGRES_TEST_USER` for an isolated
test PostgreSQL listener reachable from Docker through `host.docker.internal`. Optional
`MCP_CONTAINER_RECEIPT` saves a secret-free image/test receipt. Test TLS certificates are generated
temporarily and never installed in the images. No release or registry publication occurs here.

The optional [trusted polyglot bundle](bundle.md) supervises prepared Node/Python
MCP projects and builtin CLIs behind the same discovery contract. Separate
containers remain the default; bundled projects share one security boundary.
