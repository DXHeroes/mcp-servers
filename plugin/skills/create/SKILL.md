---
name: create
description: Create an independently owned MCP server repository from the public DX Heroes template when a user wants a new deployable connector, not a gateway builtin.
---

# Create an independent MCP server

Preserve the requested language and product boundary. Standard MCP over Streamable HTTP is the
interface; the implementation does not have to use the TypeScript SDK. Use the CRM template only
when a TypeScript starter is appropriate. Plain REST services should use the gateway OpenAPI path.

## Obtain pinned resources

This skill may be installed without the `mcp-servers` repository. Never assume sibling paths. Ask
the administrator for an approved immutable 40-character release commit, then obtain and verify it:

```sh
test "${MCP_SERVERS_COMMIT:?set an approved 40-character public release commit}" != ""
case "$MCP_SERVERS_COMMIT" in (*[!0-9a-f]*|'') exit 2;; esac
test "${#MCP_SERVERS_COMMIT}" -eq 40
git clone --filter=blob:none --no-checkout https://github.com/dxheroes/mcp-servers.git mcp-servers-kit
git -C mcp-servers-kit checkout --detach "$MCP_SERVERS_COMMIT"
test "$(git -C mcp-servers-kit rev-parse HEAD)" = "$MCP_SERVERS_COMMIT"
corepack pnpm --dir mcp-servers-kit install --frozen-lockfile
corepack pnpm --dir mcp-servers-kit build
```

Copy `mcp-servers-kit/templates/typescript-crm/` into a new unrelated repository. Remove its `.git`
metadata if the copy mechanism preserved any. Keep the template's lockfile and independent
dependencies; do not replace them with `workspace:*`, unpublished `@dxheroes/*` packages, or
absolute imports.

## Adapt and verify

Replace the in-memory CRM adapter, tool schemas and catalog metadata with the requested service.
Keep service authentication distinct from any upstream credential. A per-user API-key offer uses
`connector_base64url`, requires an explicit personal secret at runtime, and cannot inherit a shared
deployment credential. A shared `api_key` offer requires its key at install. A deployment with its
own fixed shared secret may instead publish a separate stable shared-only `auth.type: none` offer.

Build all dependencies into the image. Pin source revisions, lockfiles and base digests; exclude
`.git`, `.env*`, `.npmrc`, SSH/cloud credentials, private keys and runtime secret paths before any
`COPY`. Never clone or install at runtime. Native artifacts must match final OS/libc/architecture.

Run inside the new repository:

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run validate
node ../mcp-servers-kit/scripts/validate-external-server.mjs "$PWD" "$PWD/catalog-entry.json"
docker build -t mcp-new-server:test .
```

The external validator imports the built frozen catalog parser from the verified kit checkout. Do
not copy the validator alone or replace its contract checks with a local partial schema.

Exercise a real official MCP client against the built image in both the modern automatic and legacy
eras where supported. Verify wrong bearer/Host/Origin, bounded inputs, shutdown and secret
redaction. The repository workflow should build amd64+arm64 from only this checkout, publish by
immutable digest, attach pinned SBOM/provenance, scan both variants and sign after the gate.

Creating source does not authorize publishing, deploying, registering an offer, requesting private
secrets in chat, or running arbitrary customer code. Stop after producing reviewable artifacts
unless the user separately authorizes those external changes.
