---
name: mcp-server-deploy
description: Prepare a secure deployment and Gateway catalog entry for an administrator-approved MCP server without publishing or changing infrastructure before approval.
---

# Deploy an MCP server

Treat each independently authored server as its own release and security boundary. Prefer one
container per server. A trusted bundle is appropriate only after the administrator accepts that its
children share an operating-system, resource, and secret boundary.

## Pin and inspect the inputs

Require an immutable 40-character source commit and an immutable image digest. Inspect the MCP
transport, `/health` behavior, authentication, session state, required secrets, target platforms,
license, and catalog entry. Do not execute code from an unreviewed repository. Never place Git,
registry, upstream, service, or catalog credentials in source, image layers, build arguments, URLs,
logs, or catalog metadata.

Use the public validation kit at an administrator-approved immutable commit:

```sh
test "${MCP_SERVERS_COMMIT:?set an approved 40-character public release commit}" != ""
case "$MCP_SERVERS_COMMIT" in (*[!0-9a-f]*|'') exit 2;; esac
test "${#MCP_SERVERS_COMMIT}" -eq 40
git clone --filter=blob:none --no-checkout https://github.com/dxheroes/mcp-servers.git mcp-servers-kit
git -C mcp-servers-kit checkout --detach "$MCP_SERVERS_COMMIT"
test "$(git -C mcp-servers-kit rev-parse HEAD)" = "$MCP_SERVERS_COMMIT"
corepack pnpm --dir mcp-servers-kit install --frozen-lockfile
corepack pnpm --dir mcp-servers-kit build
node mcp-servers-kit/scripts/validate-external-server.mjs "$SERVER_REPOSITORY" "$CATALOG_ENTRY"
```

## Produce a reviewable plan

Run non-mutating preflight checks first. Verify the image has linux/amd64 and linux/arm64 variants,
the expected source revision labels, an SBOM and provenance attestation, a valid signature, no
disallowed high or critical findings, a non-root user, a read-only compatible filesystem, dropped
capabilities, bounded resources, and no embedded credentials. Exercise the exact digest with an
official MCP client and negative Host, Origin, bearer, and upstream-credential cases.

Then present the exact planned target, digest, endpoint, secret-manager references, resource limits,
network policy, rollback digest, and catalog diff. Do not push an image, change package visibility,
write deployment state, provision secrets, restart workloads, or register a catalog offer until the
administrator explicitly approves that concrete plan.

After approval, apply only the reviewed operations. Confirm readiness with `/health`, MCP
`initialize` or discovery, `tools/list`, an allowed tool call, an expected denial, and Gateway
catalog visibility. Record immutable digests and rollback instructions. A reachable endpoint alone
does not prove the connector is safe or functionally healthy.
