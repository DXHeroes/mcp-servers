# Architecture and deployment profiles

## Separate containers: default

Each connector image exposes `POST /mcp` and `GET /health` on port 8080. The catalog is a separate
service exposing `GET /catalog/v1/servers`. A reverse proxy supplies TLS and network policy. Keep
connectors on distinct container networks where practical: process separation is an independent
boundary even when application-level Host, Origin and credential checks are correct.

```text
Gateway -- service bearer + optional user secret --> connector /mcp --> upstream API
Gateway -- catalog bearer -----------------------> catalog /catalog/v1/servers
```

Catalog discovery returns deployment metadata. It does not establish liveness, authenticate a user
to an upstream provider, inspect Docker/Kubernetes, install a connector, or execute source. Existing
gateway connections remain separate records and are not mutated by a manifest refresh.

The connector's service bearer owns `Authorization`. When catalog auth declares
`credentialDelivery: connector_base64url`, the gateway sends the canonical unpadded base64url of
the original UTF-8 upstream secret in `X-MCP-Upstream-Credential`, plus an explicit
`X-MCP-Credential-Mode`. Per-user mode requires that request secret even if the deployment has a
shared credential. These channels must remain distinct.

MCP servers may be implemented in any language. The contract is standard MCP over Streamable HTTP;
the gateway does not require the TypeScript SDK, Python SDK, Express, or this repository's kit. A
plain REST service belongs behind the gateway's OpenAPI adapter.

## Trusted polyglot bundle: optional

`ghcr.io/dxheroes/mcp-bundle` prepares reviewed TypeScript, Python, plain Express MCP and builtin
connector projects at image-build time. It supervises fixed commands and maps fixed
`/mcp/<stable-id>` routes. A single catalog document can mix bundle routes and independent service
URLs.

The bundle is one trust boundary. Loopback listeners, environment allowlists and process groups
reduce accidental cross-talk but do not sandbox malicious sibling code. Use separate containers for
different owners, trust levels, ordinary OAuth MCP endpoints, incompatible dependency closures, or
servers needing richer stdio sessions.

The bundle edge's bearer owns `Authorization`. A cooperating token-based child can receive the
separate raw upstream envelope. The bundle rejects OAuth and upstream-Authorization catalog shapes;
deploy those endpoints separately. Language independence does not make every third-party auth,
session, callback or backchannel design compatible with this adapter. Stdio bridging covers tools,
resources and prompts with a fresh process per operation; native HTTP is required for persistent
sessions, tasks, subscriptions, sampling, elicitation and client backchannels. See
[bundle.md](bundle.md).

## Network and build boundaries

`safeFetch` blocks private targets by default when used without options. The connector host's
historic policy permits private targets unless `MCP_ALLOW_PRIVATE_NETWORK_TARGETS` is exactly
`false`; configurable-host Abra Flexi and PostgreSQL read that setting for each request. Fixed-host
connectors retain their extracted behavior. Even when private targets are allowed, link-local and
unspecified address ranges remain blocked, and redirects are revalidated. Set the variable to
`false` for Internet-only deployments; do not describe extraction as a newly stricter default.

Images install complete pinned dependencies at build time, then remove package managers. No
runtime source checkout, npm/pip install, Docker socket or Kubernetes administration belongs in a
connector or gateway. Client source may enter a reviewed build from an external repository at a
pinned revision with explicit administrator approval. Credential files, nested `.git`, `.env*`,
`.npmrc`, SSH/cloud metadata, private keys and runtime secret directories must be excluded before
any `COPY`.

Python wheels, virtualenvs and native Node modules must match the final image's OS, libc,
architecture, interpreter and absolute paths. The bundle pins Alpine packages, but distribution
repositories may eventually stop retaining an exact APK version; a missing pin must fail the build,
not silently float to a new package.
