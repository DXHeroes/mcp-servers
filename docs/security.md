# Security model

## Secret separation

- `MCP_ACCESS_TOKEN[_FILE]` protects a connector's MCP endpoint.
- A catalog has its own discovery-only bearer. In the bundle this is
  `MCP_CATALOG_ACCESS_TOKEN[_FILE]`; execution still uses `MCP_ACCESS_TOKEN[_FILE]`.
- `MCP_UPSTREAM_CREDENTIAL[_FILE]` is the optional shared provider/database credential.
- A personal upstream credential arrives only through canonical `connector_base64url` delivery and
  explicit per-user mode. It never falls back to a shared deployment secret.
- Bundle child bearers are separately provisioned and cannot reuse edge or catalog tokens.

Environment and file forms for one secret are mutually exclusive. Prefer read-only secret files
whose permissions permit the arbitrary runtime UID. Never put values in manifests, image layers,
build arguments, URLs, catalog metadata, logs or process argv. Never reuse discovery credentials as
execution credentials or put a service bearer into generic connector headers.

## HTTP edge

Set `MCP_ALLOWED_HOSTS` to the ingress hostnames. Matching ignores the port; IPv6 hosts use brackets.
Set exact `MCP_ALLOWED_ORIGINS` values for browser callers. A missing Origin is accepted for
non-browser clients, while an unlisted present Origin is refused. Duplicate reserved headers,
malformed credentials, invalid modes and wrong service bearers are rejected without reflecting
their values. Terminate TLS before any untrusted network and never expose a bearer over plaintext.

Run images as a non-root arbitrary UID with a read-only root filesystem, all capabilities dropped,
`no-new-privileges`, bounded memory/PIDs, and only required writable tmpfs mounts. Do not mount the
Docker socket or cluster-admin credentials. Separate containers and networks remain meaningful
boundaries; the trusted bundle shares one OS and secrets boundary.

## Upstream requests

Outbound redirects are bounded and revalidated. Link-local and unspecified destinations remain
blocked even when an operator permits private targets. Abra Flexi and PostgreSQL can intentionally
reach on-premises/private targets unless `MCP_ALLOW_PRIVATE_NETWORK_TARGETS=false`; scope that
choice to connector networks and egress rules. PostgreSQL per-user connection strings let users
choose a database host, so gateway authorization and connector egress policy both matter.

Tool annotations are hints for gateway approval policy, not an authorization boundary. Destructive
tools identify writes and irreversible actions, but provider permissions and database roles must
still follow least privilege. PostgreSQL's read tool asks PostgreSQL to enforce a read-only
transaction. Existing builtin installs start with its execute tool blocked; standalone and fresh
remote deployments must enforce least privilege in the database and explicitly configure gateway
policy for that destructive tool.

## Supply chain

Release images use immutable base indexes and fully pinned GitHub Actions, QEMU, BuildKit, SBOM
generator, Trivy and cosign versions. Each linux/amd64 and linux/arm64 variant gets SBOM and SLSA
provenance attestations and a vulnerability report. The release gate fails on any reported
vulnerability; reports are retained without ignore lists. A keyless signature covers the immutable
multi-platform index digest, which binds both platform manifests and their attestations.

These checks are time-specific. Consumers should verify the digest, signature identity, provenance,
SBOM and a current vulnerability scan under their own policy. Source labels do not make a GHCR
package public.

## Reporting

Use the repository host's private vulnerability-reporting feature. Include affected image digest or
commit, reproducible impact and a minimal safe reproducer. Do not include live credentials or
customer data.
