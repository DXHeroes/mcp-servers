# Build connector artifacts for your gateway

Build each source repository in its own CI job. A gateway consumes HTTP URLs and
credentials; it does not build or execute these sources. Use separate containers by
default. The trusted polyglot bundle is an optional deployment boundary for operators
who own every bundled process.

From this repository:

```sh
docker build -f Dockerfile.connector --build-arg CONNECTOR=toggl -t YOUR_REGISTRY/toggl:RELEASE .
docker build -f Dockerfile.catalog -t YOUR_REGISTRY/catalog:RELEASE .
docker build -t YOUR_REGISTRY/company-crm:RELEASE templates/typescript-crm
# Optional TypeScript SDK, Python SDK, Express MCP and stdio bundle:
docker build -f Dockerfile.bundle -t YOUR_REGISTRY/bundle:RELEASE .
```

Copy `fixtures/deployment-endpoints.example.json`, replace addresses with URLs
reachable from the gateway, and use `scripts/catalog-manifest.mjs` to generate the
public connector catalog. Add the independently authored CRM's
`templates/typescript-crm/catalog-entry.json` with its actual endpoint. The CRM is
an in-memory sample; add your own durable storage before using it for customer data.
Discovery advertises offers, not account authorization or provider health.

Use immutable digest references when deploying audited images, including images in
private registries. Configure registry authentication outside the containers. Run
connectors as a nonroot UID with a read-only root, dropped capabilities,
no-new-privileges and a bounded `/tmp` mount. Do not give them a Docker socket or
access to the gateway database network. Limit CPU, memory and processes. These
images support an arbitrary UID when mounted credentials are readable by that UID.

Supply different random credentials for:

- Catalog metadata: `MCP_ACCESS_TOKEN_FILE` on the catalog service.
- Connector service: `MCP_ACCESS_TOKEN_FILE` on each connector.
- Provider identity: per-request `connector_base64url` credentials, or an explicitly
  configured shared `MCP_UPSTREAM_CREDENTIAL_FILE`.
- Bundle metadata: `MCP_CATALOG_ACCESS_TOKEN_FILE`, different from the bundle's
  `MCP_ACCESS_TOKEN_FILE`; child HTTP tokens are distinct again when configured.

Set explicit `MCP_ALLOWED_HOSTS`; do not use wildcards. Protect traffic with TLS
across trust boundaries. Base64url credential delivery is encoding, not encryption.
Keep secret files outside build contexts, mode0600, owned by the runtime UID.
Catalog/source credentials must never be substituted for endpoint service tokens.

For the bundle, copy `packages/bundle/fixtures/bundle.json`, replace advertised
URLs, keep only trusted services you need, and configure each referenced child
secret. `MCP_BUNDLE_MANIFEST` points at that read-only manifest. Stdio children are
created with the requesting user's credential and bounded lifetime; HTTP children
are supervised independently. The gateway never owns these processes.

Keep connector service and catalog tokens stable during a staged image rollout, or
rotate both sides together. A catalog removal must not be interpreted as deleting
existing gateway connections. A gateway may retain last-good offers as stale after
a refresh failure. Explicitly validate and migrate existing builtin connections;
discovery is not a migration mechanism.

Long-running tools require proxy response buffering off and read/send timeouts
beyond the connector's fixed 60-minute budget. Deliver explicit cancellation before
closing a legacy SDK client, or terminate its session with DELETE: a legacy
disconnect alone does not cancel work, and immediate Client.close can race the
cancellation notification. Modern stateless requests propagate per-request
disconnect. Keep a client deadline after abrupt upstream loss; no event-store replay
is promised. Do not automatically retry tool POSTs. Local short-job tests do not
certify an actual 60-minute provider operation or billing cancellation.
