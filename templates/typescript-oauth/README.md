# Delegated OAuth connector template

Runnable TypeScript example for issue #3. It exposes `profile_get_me` at `/profile/mcp`
and reads `id,displayName` from Microsoft Graph's `GET /v1.0/me`. It requests only
delegated `User.Read` and `offline_access`, with the `common` authority for work/school
and personal Microsoft accounts. It has no mutation tools. See the [provider reference](https://learn.microsoft.com/en-us/graph/api/user-get).

## Run in this repository

Use Node.js 22 and the repository's pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @dxheroes/mcp-oauth-template test
MCP_ACCESS_TOKEN_FILE=/run/secrets/connector-service \
MCP_ALLOWED_HOSTS=connector.example.com \
node templates/typescript-oauth/dist/cli.js --http
```

The service token file contains the connector's bearer, not a provider token.
The gateway supplies each user's current token with each request:

```http
Authorization: Bearer <connector-service-bearer>
X-MCP-Credential-Mode: per_user
X-MCP-Upstream-Credential: <canonical-base64url-user-access-token>
```

OAuth routes reject shared mode, a missing user token and an invalid service bearer.
A configured shared fallback is never used. In the kit's legacy `ApiKeyConfig` type,
the `apiKey` property carries the access token. Never put that token in tool arguments,
return it, log it or store it. The gateway owns code exchange, client secrets and refresh.

Register an operator-owned Web app that allows organizational and personal accounts,
with the exact gateway callback `https://<gateway-host>/api/oauth/callback`. Configure its
client ID and secret on a per-user managed preset. Complete applicable publisher/tenant
consent requirements before rollout. This template performs no app registration or consent.

## Adapt into a connector

1. Copy the source, tests, package/config files and license into `connectors/<id>`.
   Omit generated `dist`, `node_modules` and `*.tsbuildinfo` files.
2. Set the package name to `@dxheroes/mcp-<id>`, set `mcpPackage: true`, and align the
   metadata ID and independent package/metadata versions. Add the same package exports,
   `files` and CLI `bin` fields as an existing connector. Add its root TypeScript reference
   and run `pnpm install` to update the workspace lockfile.
3. Keep the static endpoint registry and `auth: 'oauth'`. Give each service a stable path,
   metadata ID, tool prefix and minimum scope set. Use the provider's documented OAuth
   endpoints; never put a client secret or an access token in package metadata.
4. Replace the example tools with schema-validated operations. Mark reads `readOnlyHint`
   and destructive operations `destructiveHint`. Set idempotency only when the operation
   really is safe to repeat. The gateway's approval and integrator-write policy still applies.
5. For Microsoft Graph, retain the shared `@dxheroes/mcp-graph` client. It pins the origin,
   validates continuation URLs, bounds body size to 2 MiB, refuses redirects and retries
   safe reads on bounded transient failures. Other providers need an equivalent bounded,
   SSRF-safe transport; do not simply change the origin in this example.
6. Continue calling provider operations inside `withToolCallDeadline(20_000, ..., context)`.
   Every retry, pagination round and body read must share that budget. Forward opaque page
   tokens without interpreting them; validate provider continuation URLs before using them.
7. Preserve `UpstreamCredentialInvalidError` only after a definite pre-execution token
   refusal. A 403 scope failure, throttle, timeout or uncertain write is not a reconnect.
   Never retry a write after an uncertain outcome. Discard provider error bodies.
8. Add adapted, scrubbed provider fixtures and HTTP tests for account isolation, read/write
   round trips, throttles, revocation and cancellation. Then run the full `pnpm check` and
   add the connector to the CI image matrix. `Dockerfile.connector` resolves valid connector
   IDs from package metadata; no Dockerfile allowlist edit is required.

After adaptation, build the independent image with
`docker build -f Dockerfile.connector --build-arg CONNECTOR=<id> .` and generate catalog
offers from an explicit deployment map with `scripts/catalog-manifest.mjs`. The generated
OAuth offer uses `connector_base64url` and `per_user` only. Test schema validation and
gateway compatibility before activating the catalog source. This unadapted template is
outside `connectors/`, so it is not advertised or released as a catalog offer.

## Validation and licensing

The tests import the compiled template and use real MCP HTTP listeners and SDK clients in
both protocol eras. Only DNS and the provider's fetch boundary are simulated. They verify
the delegated bearer, missing credentials, service-auth rejection, upstream 401 signaling,
403/throttle separation and diagnostic redaction. They perform no live provider calls and
do not replace operator registration, consent or real-account gateway acceptance.

The authored example is MIT. It uses the existing Elastic-licensed kit; keep its license
and provenance when distributing a derived connector. See [licensing](../../LICENSES.md)
and the full [runtime contract](../../docs/runtime.md).
