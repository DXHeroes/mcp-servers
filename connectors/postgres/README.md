# PostgreSQL connector

Bounded PostgreSQL query and explicit SQL execution tools. Connection details stay in the connector
credential channel and are never tool arguments.

## Credential and deployment

Accepted raw credentials are a PostgreSQL URL or keyword form:

```text
postgresql://user:password@host:5432/dbname?sslmode=require
host=db.example.com port=5432 dbname=mydb user=myuser password=secret sslmode=require
```

Required fields are host, database and user; port defaults to 5432 and `sslmode` to `prefer`.
Accepted modes are `disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full`. For a private
CA, add `sslrootcert=<unpadded-base64url PEM bundle>` and use `verify-full`. Provision the whole raw
string as `MCP_UPSTREAM_CREDENTIAL[_FILE]` and the unrelated service bearer as
`MCP_ACCESS_TOKEN[_FILE]`.

```sh
docker build -f Dockerfile.connector --build-arg CONNECTOR=postgres -t mcp-postgres .
docker run --rm -p 127.0.0.1:8080:8080 \
  -e MCP_ACCESS_TOKEN -e MCP_UPSTREAM_CREDENTIAL \
  -e MCP_ALLOWED_HOSTS=localhost,127.0.0.1 mcp-postgres
```

Private database targets are allowed unless `MCP_ALLOW_PRIVATE_NETWORK_TARGETS=false`; link-local
and unspecified addresses remain blocked. Per-user credentials let each user choose a database
host, so constrain egress. Use a dedicated least-privilege database role.

## MCP surface and permissions

- `postgres_query` runs SQL in a transaction that PostgreSQL itself marks read-only.
- `postgres_execute_sql` permits writes and DDL and is annotated destructive. An existing gateway
  builtin install starts with this tool blocked. A standalone server enforces only the supplied
  database role; a fresh remote install must explicitly configure gateway policy to block or
  approve the tool. Later migration of an existing builtin preserves its stored tool policy.

No resources or prompts are exposed. The read-only transaction is stronger than SQL text parsing,
but database privileges still control what can be read. Tool annotations and package metadata are
not standalone enforcement; see [Security](../../docs/security.md#upstream-requests).

## Limits and troubleshooting

Connection startup is bounded to 10 seconds. Statements get a 30-second server setting and a
32-second client deadline. Arbitrary SQL can change the server setting, and client timeout does not
send PostgreSQL CancelRequest, so timed-out SQL may continue at the database. Results default to
200 rows, permit at most 1,000, and share a 256,000-byte budget across every statement in one call.
Truncation is reported in the result envelope. `sslmode=prefer` verifies no certificate and can
fall back to plaintext only when the server reports no TLS support; use `verify-full` for identity.
