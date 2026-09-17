---
name: add
description: Package and register an existing administrator-approved MCP server in the DX Heroes catalog for separate-container or trusted-bundle deployment.
---

# Add an existing MCP server

Start from the actual MCP transport, auth/session design and build. Discovery is metadata: it does
not install source, execute builds, prove health or authorize deployment. Prefer one independent
container per server. Use the bundle only when the administrator explicitly accepts its shared OS
and secret boundary and the child fits the implemented native HTTP or limited stdio adapter.

## Obtain the contract and validator

The skill is portable and assumes no monorepo sibling. Obtain an approved immutable public release
checkout and verify it before using any resource:

```sh
test "${MCP_SERVERS_COMMIT:?set an approved 40-character public release commit}" != ""
case "$MCP_SERVERS_COMMIT" in (*[!0-9a-f]*|'') exit 2;; esac
test "${#MCP_SERVERS_COMMIT}" -eq 40
git clone --filter=blob:none --no-checkout https://github.com/dxheroes/mcp-servers.git mcp-servers-kit
git -C mcp-servers-kit checkout --detach "$MCP_SERVERS_COMMIT"
test "$(git -C mcp-servers-kit rev-parse HEAD)" = "$MCP_SERVERS_COMMIT"
export MCP_SERVERS_KIT="$PWD/mcp-servers-kit"
corepack pnpm --dir "$MCP_SERVERS_KIT" install --frozen-lockfile
corepack pnpm --dir "$MCP_SERVERS_KIT" build
```

Then use:

- `packages/catalog/schema/catalog-discovery.schema.json` for the discovery contract;
- `fixtures/catalog.v1.json` for offer shapes;
- `scripts/validate-external-server.mjs` for portable build/catalog checks;
- `docs/architecture.md` and `docs/bundle.md` for deployment compatibility.

Never substitute a branch or floating tag when a reviewed commit was requested.
The validator consumes the built authoritative catalog parser from this checkout, so do not copy
the script by itself or substitute a partial local schema.

## Package and register

Verify the existing server speaks standard MCP over Streamable HTTP. For ordinary REST, use the
gateway OpenAPI adapter. Build from a clean checkout at a pinned source revision; keep CI checkout
credentials outside Docker context, layers and logs. Do not add runtime Git/npm/pip installs.

Choose one catalog auth contract:

- `none` with shared mode when no gateway/user upstream credential is needed;
- `api_key` with a required shared key at install;
- `api_key` plus `connector_base64url` for explicit shared/per-user raw credentials;
- OAuth only for a separately deployed endpoint compatible with the gateway OAuth flow.

The connector service bearer always remains separate from catalog access and upstream secrets.
Never put it in `config.headers` or reuse a discovery token. Missing per-user credentials must fail.

For bundle admission, confirm the child binds private loopback, exposes `/mcp` and `/health`, accepts
the fixed internal Host/Origin, and uses a separately provisioned child bearer. OAuth or upstream
Authorization endpoints deploy separately. Stdio supports only tools/resources/prompts with a fresh
process per operation; persistent sessions/tasks/backchannels require native HTTP.

Validate from the existing server repository:

```sh
node "$MCP_SERVERS_KIT/scripts/validate-external-server.mjs" \
  "$PWD" "$PWD/catalog-entry.json"
docker build -t mcp-candidate:test .
```

Then exercise an official client, health/auth failures, arbitrary UID/read-only runtime, clean
shutdown and the exact catalog endpoint. Registration, image publication, deployment, package
visibility changes and secret provisioning require the user's separate authorization. Admins choose
the trusted source, immutable image digest and secret-manager bindings; do not solicit secret values
in the transcript.
