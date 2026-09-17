# Optional trusted polyglot bundle

Separate containers remain the default deployment. This optional image runs
administrator-approved, prepared MCP projects in one container: Node/TypeScript,
Python in a per-project virtualenv, plain Express implementing MCP, and the seven
prepared connector CLIs. An ordinary Express REST API is not MCP; use the gateway's
OpenAPI import for that API.

**The router and every child share one OS and security boundary.** Loopback,
separate environments and process groups prevent accidental forwarding and
cross-request reuse; they do not isolate malicious code from sibling processes,
files or secrets. Install only reviewed administrator code. Use separate
containers for different trust levels, incompatible dependency requirements or
ordinary OAuth MCP servers.

## Build and run

Build from this clean public checkout:

```sh
docker build -f Dockerfile.bundle -t mcp-bundle:local .
```

Provision four distinct secrets using your deployment secret manager:
`MCP_ACCESS_TOKEN` (MCP execution and health), `MCP_CATALOG_ACCESS_TOKEN`
(discovery only), `BYZDATA_SERVICE_TOKEN` and `POSTGRES_SERVICE_TOKEN` (the example builtin children).
Both edge variables also support the `_FILE` variant. Never reuse a discovery
token automatically for execution, an upstream personal key, or a child bearer.
No secret belongs in the manifest, image, process argv, or source repository.

```sh
docker run --rm --read-only --user 12345:12345 \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 128 \
  -p 127.0.0.1:8080:8080 \
  -e MCP_ACCESS_TOKEN -e MCP_CATALOG_ACCESS_TOKEN \
  -e BYZDATA_SERVICE_TOKEN -e POSTGRES_SERVICE_TOKEN \
  -e MCP_ALLOWED_HOSTS=localhost,127.0.0.1 \
  -e MCP_ALLOWED_ORIGINS=https://your-client.example \
  mcp-bundle:local
```

The checked-in `packages/bundle/fixtures/bundle.json` is an executable example,
not a production connector selection. Its advertised URLs use localhost:8080;
change them to the actual external URL when building your deployment manifest.
Do not publish any child port. TLS termination belongs on the external listener.
There is no Docker socket, runtime installer, UI code-execution endpoint, dynamic
module lookup or network discovery.

## Manifest and prepared projects

`MCP_BUNDLE_MANIFEST` names one administrator-authored JSON file, read once at
startup. Redeploy to change code, dependencies, routes, secrets or selection.
The object has two keys:

- `catalog`: the **unchanged** catalog schemaVersion 1 document, validated by
  `@dxheroes/mcp-catalog`. GET `/catalog/v1/servers` returns only this object.
- `services`: one launch entry per catalog ID, at most 16. Every ID maps only to
  `/mcp/<id>`; advertised URLs never become proxy targets or process arguments.

Each service defines `id`, `transport` (`http` or `stdio`), `argv` (an array with
an absolute executable first), absolute `cwd`, literal `env` allowlist, and
`maxActive` (1–32, default 8). HTTP entries additionally use a unique fixed
loopback `port` (1024–65535). The child must implement GET `/health` returning
200 and its MCP endpoint at `/mcp`. argv is passed to `spawn` with `shell:false`.
Only administrator build configuration selects executables and arguments.

`childToken` and `sharedCredential` are optional `{ "env": "VARIABLE_NAME" }`
or `{ "file": "/run/secrets/name" }` references. The former sets a distinct
HTTP child service bearer; the latter is its upstream credential. Environment
values are not inherited from the supervisor. Interpreter/loader overrides such
as NODE_OPTIONS, PYTHONPATH and LD_* are refused. Each child gets only its
explicit environment, private listener settings and its own configured secrets.
Use explicit argv paths, and explicitly configure PATH only if reviewed code
needs subprocess executables. Child stdout/stderr are discarded by the native
supervisor; stdio stdout is protocol-only and stderr discarded, avoiding
unbounded secret-bearing diagnostics. Operational health exposes only status,
restart count and active request counts.

All seven prepared connector CLIs are at `/opt/connectors/<id>/dist/cli.js`.
Launch with `/usr/local/bin/node`, then that path and `--http` or `--stdio`.
The ByzData example demonstrates an authenticated child distinct from the edge.
Credentialed builtin examples need their catalog `api_key` contract and explicit
credential-channel declaration below.

For a new project, check out and verify its pinned source before building, add
an explicit Docker build step, and include only the built artifact/dependency
closure. Never clone or npm/pip install at runtime. Nested `.git`, `.env*`,
`.npmrc`, SSH directories, private keys and `.runtime` are excluded from the
Docker context. Review any additional project-specific secret paths too.

Node native dependencies must match the target Alpine/musl/architecture.
Python uses Python 3.14.7 and the committed complete hash lock for MCP 2.2.0,
installed exclusively from wheels. Builder and runtime use the same immutable
Node/Alpine base, exact Python package and absolute `/opt/venvs/python-fixture`
path. Build each target architecture; do not copy a macOS/glibc venv or a venv
from another Python image, architecture or absolute path. For another project,
create a separate locked venv with the same constraints. No pip/npm/npx is
present in the final image. The runtime includes pinned tini as PID1 to reap
orphan descendants; do not override its entrypoint.

## Authentication and protocol behavior

The edge owns Authorization for execution access. Supported offers are:

- `auth.type: none`, shared mode only; no caller upstream credential.
- `auth.type: api_key`, `credentialDelivery: connector_base64url`;
  shared and optionally per_user. To advertise per_user, also declare
  `requestCredentials: connector_base64url` on the service, and actually
  implement the request/process credential contract in that child.

OAuth and Authorization-based upstream credentials are rejected by this bundle
configuration. The general discovery schema still supports them; deploy those
servers as separate containers with their direct compatible discovery endpoint.
A bundle does not make arbitrary native code support personal credentials.

The caller sends `Authorization: Bearer <execution token>`,
`X-MCP-Credential-Mode: shared|per_user` and, when applicable,
`X-MCP-Upstream-Credential: <canonical unpadded base64url UTF-8 secret>`.
Every MCP route method enforces the complete advertised `credentialModes` set
before selecting a credential or dispatching a request. Per-user-only offers
reject explicit shared mode and omitted mode (which means shared); their
deployment shared credential is not passed to the native child at startup.
Missing personal credentials fail even when a shared credential is configured.
No credential is interpolated into argv or a shell. HTTP children receive the
explicit per-request upstream header; stdio children receive only the fixed
`MCP_UPSTREAM_CREDENTIAL` environment field in a fresh process.

External Host/Origin are checked against the edge allowlists before any rewrite.
The router removes edge Authorization, cookies and forwarded identity headers,
then sets fixed `Host: 127.0.0.1:<port>` and `Origin: http://127.0.0.1` for the
private child. Configure its guards for these exact internal values (Python
example does this explicitly). Any child bearer is inserted separately.
Redirects return 502; they are never followed with credentials. MCP bodies,
protocol/method/name/session headers, response status and SSE are streamed
without protocol reinterpretation. GET/DELETE and notification 202 responses
are preserved. Native child capabilities determine which protocol era works:
TS/Python fixtures and builtins support both; plain Express demonstrates
stateful legacy MCP and auto clients negotiate that legacy fallback.

The stdio bridge exposes tools, resources and prompts over stateless HTTP in
both eras. It initializes a **fresh process per operation**, pins the inner
client to legacy (no extra era-probe process), then closes and reaps the entire
owned process group before releasing admission. Progress is forwarded. This
bridge does not persist stdio sessions, subscriptions, tasks, sampling,
elicitation or client backchannels; use native HTTP/separate containers for
those capabilities. Legacy stateless explicit cancellation notifications cannot
identify another isolated HTTP request: close/abort that request's transport.
Disconnect, idle deadline and hard deadline all tear down its process group.
Deadlines terminate the response stream. Some SDK clients attempt stream
reconnection and wait for their own request timeout; callers must set a finite
request timeout and abort/close their transport when abandoning a call.
No process pool is shared between credentials. Owned stdin/stdout pipe errors
close and reap only that request process; duplicate write-callback/error events
share one safe failure path, so a broken pipe cannot terminate sibling services.

## Bounds and health

The edge admits at most 64 active MCP requests, plus the service bound (including
legacy GET streams). Each admitted stdio request owns at most one child process;
trusted child code can itself spawn descendants, so apply the container PID and
memory limits. Request bodies are bounded to 2 MiB, headers to 64 KiB and stdio
messages to 2 MiB. The total request deadline is 60 minutes and idle deadline
5 minutes. Native streaming honors Node backpressure. A native request is never
retried by the router, because a disconnected tools/call may have caused a write.

Native processes must become healthy within 10 seconds. A crash/start failure
gets at most three restarts (100/200/400/800 ms bounded delays; finite lifetime budget),
then that service stays failed until redeployment. Other services continue.
GET `/health`, authenticated with the execution token, reports this separately
from catalog offers. Catalog availability is configuration metadata, not proof
of service health or valid user credentials.

SIGTERM stops admission, closes HTTP connections, drains isolated requests,
terminates/reaps child groups (TERM then KILL after up to 500 ms), and exits.
The CLI has a 10-second shutdown deadline. Tini reaps orphan grandchildren in
Linux; detached group cleanup remains necessary even with an init process.

Run focused host tests with `pnpm --filter @dxheroes/mcp-bundle test` after
`pnpm build` (POSIX host with `/usr/bin/python3` for the bounded broken-pipe
fixture). `node scripts/test-bundle.mjs` tests the built image at
`MCP_BUNDLE_IMAGE` (default `mcp-task3c/bundle:test`) using a read-only arbitrary
UID container, real official MCP clients, both eras, credential concurrency,
progress/cancellation, process inventory and shutdown. It mounts a temporary
read-only synthetic manifest and a bounded broken-pipe fixture to test sibling survival and personal-only mode enforcement in the
actual image. All credentials in that harness are synthetic; it removes only
its owned container and temporary fixture directory. These fixtures do
not exercise real billable providers or prove a production-duration soak.

The image harness additionally requires POSTGRES_TEST_PASSWORD (and optional
POSTGRES_TEST_PORT/POSTGRES_TEST_USER) for its dedicated database fixture at
host.docker.internal. It executes only SELECT 42; do not use production credentials.
